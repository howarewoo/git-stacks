/**
 * The GitHub App device flow. A native desktop client cannot use the web
 * authorization-code flow because its token exchange requires a client secret,
 * and a shipped binary must not carry one; the device flow issues and refreshes
 * user access tokens from the public client id alone.
 */

export const GITHUB_APP_CLIENT_ID_ENV = 'GIT_STACKS_GITHUB_APP_CLIENT_ID'
export const GITHUB_DEVICE_VERIFICATION_URI = 'https://github.com/login/device'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
export const DEVICE_CODE_INTERVAL_SECONDS = 5
export const DEVICE_CODE_TTL_SECONDS = 900
/** `slow_down` adds five seconds to the interval GitHub last required. */
const SLOW_DOWN_SECONDS = 5

export type GitHubAppErrorCode =
  | 'not_configured'
  | 'device_flow_disabled'
  | 'incorrect_client_credentials'
  | 'access_denied'
  | 'expired_token'
  | 'bad_verification_code'
  | 'unsupported_grant_type'
  | 'bad_refresh_token'
  | 'unverified_user_email'
  | 'invalid_response'
  | 'network'
  | 'cancelled'

/**
 * Every message is a fixed sentence keyed by the error GitHub reported. The
 * response body is never used, so a credential can never reach an error string.
 */
const MESSAGES: Record<GitHubAppErrorCode, string> = {
  not_configured: 'This build has no GitHub App client id configured, so it cannot sign in.',
  device_flow_disabled: 'Device sign-in is not enabled for this GitHub App registration.',
  incorrect_client_credentials: 'GitHub rejected the client id configured for this build.',
  access_denied: 'Sign-in was cancelled in the browser.',
  expired_token: 'The one-time sign-in code expired. Start sign-in again for a new code.',
  bad_verification_code: 'GitHub rejected the one-time sign-in code. Start sign-in again.',
  unsupported_grant_type: 'GitHub rejected the sign-in request this build sent.',
  bad_refresh_token: 'The saved sign-in is no longer valid. Sign in again.',
  unverified_user_email:
    'Verify the primary email address on the GitHub account, then sign in again.',
  invalid_response: 'GitHub did not return a usable sign-in response.',
  network: 'GitHub could not be reached. Check the network connection and try again.',
  cancelled: 'Sign-in was cancelled.',
}

export class GitHubAppError extends Error {
  constructor(readonly code: GitHubAppErrorCode) {
    super(MESSAGES[code])
    this.name = 'GitHubAppError'
  }
}

export interface DeviceChallenge {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

/** A user access token and, when the registration expires tokens, its refresh token. */
export interface GitHubAppSession {
  accessToken: string
  refreshToken: string | null
  expiresIn: number | null
  refreshTokenExpiresIn: number | null
}

export interface GitHubAppRequest {
  clientId: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export interface DevicePollRequest extends GitHubAppRequest {
  deviceCode: string
  intervalSeconds: number
  expiresAt: number
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  now: () => number
}

const FAILURE_BY_CODE: Record<string, GitHubAppErrorCode> = {
  device_flow_disabled: 'device_flow_disabled',
  incorrect_client_credentials: 'incorrect_client_credentials',
  unsupported_grant_type: 'unsupported_grant_type',
  access_denied: 'access_denied',
  expired_token: 'expired_token',
  token_expired: 'expired_token',
  bad_verification_code: 'bad_verification_code',
  incorrect_device_code: 'bad_verification_code',
  bad_refresh_token: 'bad_refresh_token',
  unverified_user_email: 'unverified_user_email',
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Every authorization request carries its own deadline, so a stalled GitHub
 * endpoint cannot hold the caller — and a user waiting to cancel — indefinitely.
 */
const REQUEST_TIMEOUT_MS = 20_000

async function post(
  url: string,
  parameters: Record<string, string>,
  request: GitHubAppRequest,
): Promise<Record<string, unknown>> {
  const send = (request.fetch ?? globalThis.fetch) as typeof globalThis.fetch
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, request.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const forward = () => controller.abort()
  request.signal?.addEventListener('abort', forward, { once: true })
  let response: Response
  try {
    response = await send(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'git-stacks',
      },
      body: new URLSearchParams(parameters).toString(),
      signal: controller.signal,
    })
    if (!response.ok) throw new GitHubAppError('network')
    let body: unknown
    try {
      body = JSON.parse(await response.text())
    } catch {
      throw new GitHubAppError('invalid_response')
    }
    if (typeof body !== 'object' || body === null) throw new GitHubAppError('invalid_response')
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof GitHubAppError) throw error
    if (timedOut) throw new GitHubAppError('network')
    if (request.signal?.aborted) throw new GitHubAppError('cancelled')
    throw new GitHubAppError('network')
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', forward)
  }
}

function failure(body: Record<string, unknown>): GitHubAppError {
  const code = text(body.error)
  return new GitHubAppError(
    code ? (FAILURE_BY_CODE[code] ?? 'invalid_response') : 'invalid_response',
  )
}

function session(body: Record<string, unknown>): GitHubAppSession {
  const accessToken = text(body.access_token)
  if (!accessToken) throw new GitHubAppError('invalid_response')
  return {
    accessToken,
    refreshToken: text(body.refresh_token),
    expiresIn: seconds(body.expires_in),
    refreshTokenExpiresIn: seconds(body.refresh_token_expires_in),
  }
}

/** The public client id of the registered GitHub App. Never a client secret. */
export function githubAppClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  return text(env[GITHUB_APP_CLIENT_ID_ENV])
}

/** Asks GitHub for a device code and the one-time code the person types into a browser. */
export async function requestDeviceCode(request: GitHubAppRequest): Promise<DeviceChallenge> {
  const clientId = text(request.clientId)
  if (!clientId) throw new GitHubAppError('not_configured')
  const body = await post(DEVICE_CODE_URL, { client_id: clientId }, request)
  if (text(body.error)) throw failure(body)
  const deviceCode = text(body.device_code)
  const userCode = text(body.user_code)
  const verificationUri = text(body.verification_uri)
  if (!deviceCode || !userCode || !verificationUri) throw new GitHubAppError('invalid_response')
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: seconds(body.expires_in) ?? DEVICE_CODE_TTL_SECONDS,
    interval: seconds(body.interval) ?? DEVICE_CODE_INTERVAL_SECONDS,
  }
}

/** Posts to the token endpoint. The error field is left to the caller: polling needs to read it. */
async function redeem(
  request: GitHubAppRequest,
  parameters: Record<string, string>,
): Promise<Record<string, unknown>> {
  const clientId = text(request.clientId)
  if (!clientId) throw new GitHubAppError('not_configured')
  return post(ACCESS_TOKEN_URL, { ...parameters, client_id: clientId }, request)
}

export type DevicePollResult =
  | { readonly status: 'pending' }
  | { readonly status: 'slow-down' }
  | { readonly status: 'authorized'; readonly session: GitHubAppSession }

/** One poll of the token endpoint. `authorization_pending` is an answer, not a failure. */
export async function pollDeviceAuthorization(
  request: GitHubAppRequest & { deviceCode: string },
): Promise<DevicePollResult> {
  const body = await redeem(request, {
    device_code: request.deviceCode,
    grant_type: DEVICE_CODE_GRANT,
  })
  if (body.error === undefined) return { status: 'authorized', session: session(body) }
  if (body.error === 'authorization_pending') return { status: 'pending' }
  if (body.error === 'slow_down') return { status: 'slow-down' }
  throw failure(body)
}

/** A device-flow token refreshes with the public client id alone. */
export async function refreshUserAccessToken(
  request: GitHubAppRequest & { refreshToken: string },
): Promise<GitHubAppSession> {
  const body = await redeem(request, {
    grant_type: 'refresh_token',
    refresh_token: request.refreshToken,
  })
  if (text(body.error)) throw failure(body)
  return session(body)
}

/**
 * Polls the token endpoint at the interval GitHub required, honouring
 * `slow_down`, until the person authorizes, cancels, or the code expires.
 */
export async function waitForDeviceAuthorization(
  request: DevicePollRequest,
): Promise<GitHubAppSession> {
  let intervalSeconds = request.intervalSeconds
  for (;;) {
    if (request.signal?.aborted) throw new GitHubAppError('cancelled')
    if (request.now() >= request.expiresAt) throw new GitHubAppError('expired_token')
    await request.sleep(intervalSeconds * 1000, request.signal)
    const result = await pollDeviceAuthorization(request)
    if (result.status === 'authorized') return result.session
    // `slow_down` adds five seconds to the interval GitHub last required.
    if (result.status === 'slow-down') intervalSeconds += SLOW_DOWN_SECONDS
  }
}
