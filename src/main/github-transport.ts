import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { commandCode, commandDetail, isRecord, MAX_BUFFER } from './git-core'
import {
  conditionalCacheKey,
  conditionalHeaders,
  GitHubResponseCacheStore,
  type CachedGitHubResponse,
  type GitHubResponseCache,
} from './github-response-cache'

const execFile = promisify(execFileCallback)
export const GITHUB_API_VERSION = '2022-11-28'
export const GITHUB_STACKS_API_VERSION = '2026-03-10'
export const GITHUB_API_VERSION_ENV = 'GIT_STACKS_GITHUB_API_VERSION'
export const GITHUB_API_URL_ENV = 'GIT_STACKS_GITHUB_API_URL'
export const GITHUB_TRANSPORT_ENV = 'GIT_STACKS_GITHUB_TRANSPORT'
export const GITHUB_API_URL = 'https://api.github.com'
export const GITHUB_TIMEOUT_MS = 20_000
const GITHUB_HOST = 'github.com'
const MAX_PAGES = 100

export type GitHubErrorKind =
  /** This machine has no usable transport configured; no host was contacted. */
  | 'not-configured'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'unprocessable'
  | 'rate-limited'
  | 'secondary-rate-limit'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'invalid-response'
  | 'unsupported'
  | 'unknown'

export interface GitHubRateLimit {
  limit: number | null
  remaining: number | null
  reset: Date | null
  resource: string | null
  retryAfterSeconds: number | null
}

export interface GitHubTransportFailure {
  kind: GitHubErrorKind
  status?: number | null
  detail: string
  rateLimit?: GitHubRateLimit
  /**
   * The parsed response body of a failed request. A `409` from the asynchronous merge API
   * carries the enqueued request's own UUID and options, which is the only way to tell an
   * existing merge request apart from one this client would have made.
   */
  body?: unknown
}

/** Every transport failure carries a typed kind plus the rate-limit metadata GitHub returned. */
export class GitHubTransportError extends Error {
  readonly kind: GitHubErrorKind
  readonly status: number | null
  readonly detail: string
  readonly rateLimit: GitHubRateLimit
  readonly body: unknown

  constructor(failure: GitHubTransportFailure) {
    const status = failure.status ?? null
    const detail = failure.detail
    super(
      `GitHub API request failed${status ? ` with ${status}` : ''} (${failure.kind}): ${detail}`,
    )
    this.name = 'GitHubTransportError'
    this.kind = failure.kind
    this.status = status
    this.detail = detail
    this.rateLimit = failure.rateLimit ?? emptyRateLimit()
    this.body = failure.body
    publishRateLimit(this.rateLimit, failure.kind)
  }
}

let latestRateLimit: GitHubRateLimitReport = { rateLimit: emptyRateLimit(), kind: null, at: 0 }
const rateLimitListeners = new Set<(report: GitHubRateLimitReport) => void>()

function publishRateLimit(rateLimit: GitHubRateLimit, kind: GitHubErrorKind | null = null): void {
  latestRateLimit = { rateLimit, kind, at: Date.now() }
  for (const listener of rateLimitListeners) listener(latestRateLimit)
}

/**
 * Every response and every typed failure records its rate-limit metadata, so a
 * caller that only sees a rendered snapshot can still budget its next read.
 */
export function onGitHubRateLimit(listener: (report: GitHubRateLimitReport) => void): () => void {
  rateLimitListeners.add(listener)
  return () => {
    rateLimitListeners.delete(listener)
  }
}

export function lastGitHubRateLimit(): GitHubRateLimitReport {
  return latestRateLimit
}

export function resetGitHubRateLimit(): void {
  latestRateLimit = { rateLimit: emptyRateLimit(), kind: null, at: 0 }
}

export type GitHubRestMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface GitHubRestRequest {
  method?: GitHubRestMethod
  /** API path without a leading slash, for example `repos/owner/name/pulls/1`. */
  path: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Opt in to the conditional-response cache. Off by default: a replayed body
   * is only ever right for display, so every identity read leaves it unset and
   * asks GitHub directly.
   */
  cache?: boolean
}
export interface GitHubRestResponse<T> {
  status: number
  data: T
  rateLimit: GitHubRateLimit
  /**
   * The response headers, when the transport parses them. A conditional read needs the
   * `etag` it is given back, so a transport that cannot surface headers must leave this
   * undefined and its callers stay unconditional rather than reading a wrong validator.
   */
  headers?: Headers
  /** True when a conditional request was answered 304 and `data` came from the cache. */
  notModified?: boolean
}

/** The most recent GitHub rate-limit metadata either transport observed. */
export interface GitHubRateLimitReport {
  rateLimit: GitHubRateLimit
  /** The failure kind when this report came from an error, otherwise null. */
  kind: GitHubErrorKind | null
  at: number
}

export interface GitHubGraphqlOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/** The only GitHub capability domain services may use; it never exposes a token or raw fetch. */
export interface GitHubTransport {
  readonly kind: 'direct' | 'gh'
  rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>>
  /** Follows every page of a REST collection and returns the concatenated items. */
  paginate<T = unknown>(request: GitHubRestRequest): Promise<T[]>
  graphql<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GitHubGraphqlOptions,
  ): Promise<T>
}

export function emptyRateLimit(): GitHubRateLimit {
  return { limit: null, remaining: null, reset: null, resource: null, retryAfterSeconds: null }
}

export function githubApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[GITHUB_API_VERSION_ENV]
  return typeof value === 'string' && value.trim() ? value.trim() : GITHUB_API_VERSION
}

export function githubApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[GITHUB_API_URL_ENV]
  return typeof value === 'string' && value.trim() ? value.replace(/\/+$/u, '') : GITHUB_API_URL
}

/** The environment variable that holds one host's own token. */
export function environmentTokenName(host: string): string {
  return `GIT_STACKS_GITHUB_TOKEN_${host.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').toUpperCase()}`
}

export function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  host: string | null = null,
): string | null {
  if (host) {
    const scoped = env[environmentTokenName(host)]
    if (typeof scoped === 'string' && scoped.trim()) return scoped.trim()
    // Only the default host's unscoped variables belong to it; a host-specific
    // sign-in for any other host is this build's own account, not the ambient one.
    if (host.trim().toLowerCase() !== GITHUB_HOST) return null
  }
  for (const name of ['GIT_STACKS_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}
/**
 * Which credential authenticated a request. It carries no secret, only enough
 * provenance for a rejection to be attributed to the credential that caused it.
 */
export type GitHubCredentialOrigin = 'account' | 'environment' | 'gh'

/**
 * Which credential a request authenticated as, and which session of it. The
 * session is opaque and carries no secret; it exists so a response that arrives
 * after a renewal is recognised as belonging to a credential that is gone.
 */
export interface GitHubCredentialFailure {
  origin: GitHubCredentialOrigin
  session: string | null
}

/** A credential the account handed to the transport for one request. */
export interface GitHubCredential extends GitHubCredentialFailure {
  origin: 'account'
  token: string
}

/**
 * The signed-in account's credential. `current` refreshes it when it has
 * expired and returns null when sign-in is required; the credential itself
 * never leaves this call, so no caller and no renderer can observe it.
 */
export interface GitHubCredentialSource {
  current(): Promise<GitHubCredential | null>
  /** Whether a usable credential is held right now, which drives transport choice. */
  available(): boolean
  /** The host the credential was issued for; it is never sent anywhere else. */
  readonly host: string
}

let credentialSource: GitHubCredentialSource | null = null

/** Installs the account credential for the process, or clears it on sign-out. */
export function setGitHubCredentialSource(source: GitHubCredentialSource | null): void {
  credentialSource = source
}

type GitHubFailureListener = (
  error: GitHubTransportError,
  credential: GitHubCredentialFailure,
) => void | Promise<void>
let failureListener: GitHubFailureListener | null = null

/**
 * Reports a rejected credential to the account so it can refresh once and then
 * present a recoverable state instead of failing every call silently.
 */
export function onGitHubFailure(listener: GitHubFailureListener | null): void {
  failureListener = listener
}

/**
 * Awaited so a recovered credential is in place before the next request is made.
 * Only a rejection of the application-owned credential is reported, and only for
 * the session that was actually rejected: an invalid environment override or a
 * `gh` session says nothing about the stored account, and a response for a
 * superseded session says nothing about its replacement.
 */
async function reportFailure(
  error: GitHubTransportError,
  credential: GitHubCredentialFailure,
): Promise<void> {
  if (error.kind !== 'unauthorized' && error.kind !== 'forbidden') return
  if (credential.origin !== 'account') return
  await failureListener?.(error, credential)
}

function numberHeader(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseRateLimit(headers: Headers): GitHubRateLimit {
  const reset = numberHeader(headers.get('x-ratelimit-reset'))
  return {
    limit: numberHeader(headers.get('x-ratelimit-limit')),
    remaining: numberHeader(headers.get('x-ratelimit-remaining')),
    reset: reset === null ? null : new Date(reset * 1000),
    resource: headers.get('x-ratelimit-resource'),
    retryAfterSeconds: numberHeader(headers.get('retry-after')),
  }
}

function apiMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.message === 'string' && value.message.trim()) return value.message.trim()
  return null
}

function graphqlMessages(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.errors) || value.errors.length === 0) return null
  const messages = value.errors
    .map((error) => apiMessage(error))
    .filter((message): message is string => Boolean(message))
  return messages.length > 0 ? messages.join('; ') : 'GitHub returned GraphQL errors'
}

export function statusKind(
  status: number,
  rateLimit: GitHubRateLimit,
  message: string | null,
): GitHubErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 429 || status === 403) {
    if (message && /secondary rate limit|abuse detection|temporarily blocked/iu.test(message))
      return 'secondary-rate-limit'
    if (rateLimit.remaining === 0 || (message && /rate limit exceeded/iu.test(message)))
      return 'rate-limited'
    if (rateLimit.retryAfterSeconds !== null) return 'secondary-rate-limit'
    if (status === 429) return 'secondary-rate-limit'
    return 'forbidden'
  }
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 422) return 'unprocessable'
  return 'unknown'
}

function graphqlData<T>(body: unknown, status: number, rateLimit: GitHubRateLimit): T {
  const errors = graphqlMessages(body)
  if (errors) {
    const kind = statusKind(403, rateLimit, errors)
    throw new GitHubTransportError({
      kind: kind === 'rate-limited' || kind === 'secondary-rate-limit' ? kind : 'invalid-response',
      status,
      detail: errors,
      rateLimit,
    })
  }
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new GitHubTransportError({
      kind: 'invalid-response',
      status,
      detail: 'GitHub returned a GraphQL response without data',
      rateLimit,
    })
  }
  return body.data as T
}

function parseJsonBody(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new GitHubTransportError({
      kind: 'invalid-response',
      detail: 'GitHub returned a response that is not valid JSON',
    })
  }
}

function toTransportError(error: unknown, signal?: AbortSignal): GitHubTransportError {
  if (error instanceof GitHubTransportError) return error
  if (signal?.aborted)
    return new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
  const code = commandCode(error)
  if (code === 'ENOENT')
    // A missing local tool is this machine's configuration, never evidence about
    // what the host offers: no host was contacted at all.
    return new GitHubTransportError({
      kind: 'not-configured',
      detail: 'the gh CLI is not installed',
    })
  if (code === 'ETIMEDOUT')
    return new GitHubTransportError({ kind: 'timeout', detail: 'the gh request timed out' })
  if (code === 'ABORT_ERR' || (error instanceof Error && error.name === 'AbortError'))
    return new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
  return new GitHubTransportError({ kind: 'network', detail: commandDetail(error) })
}

/**
 * The one origin a GitHub host's REST API lives at. `github.com` answers on
 * its own API subdomain; every other GitHub host — GitHub Enterprise Server
 * included — serves its API from the host itself.
 */
export function githubApiOriginForHost(host: string): string {
  return host.trim().toLowerCase() === GITHUB_HOST ? GITHUB_API_URL : `https://${host}`
}

export interface DirectGitHubTransportOptions {
  token?: string | null
  credential?: GitHubCredentialSource
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  apiUrl?: string
  /**
   * The GraphQL endpoint for this host, when it is not the REST base plus
   * `/graphql`. A GitHub Enterprise Server host serves REST from `/api/v3` and
   * GraphQL from `/api/graphql`, so the endpoint is named, never derived.
   */
  graphqlUrl?: string
  apiVersion?: string
  timeoutMs?: number
  userAgent?: string
  /**
   * The GitHub host this transport speaks for. Every request, credential, page
   * link, and retry stays on the API origin this host owns; no other host is
   * contacted while serving it.
   */
  host?: string
  /** Validators for conditional reads; omitted means every GET is a full read. */
  cache?: GitHubResponseCache
}

/** Authenticated REST/GraphQL access to GitHub over HTTP; it never spawns `gh`. */
export class DirectGitHubTransport implements GitHubTransport {
  readonly kind = 'direct' as const
  private readonly options: DirectGitHubTransportOptions

  constructor(options: DirectGitHubTransportOptions = {}) {
    this.options = options
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  /**
   * Whether the ambient environment token was issued for the host this
   * transport serves. `GIT_STACKS_GITHUB_TOKEN_<HOST>` is that host's own; the
   * unscoped `GIT_STACKS_GITHUB_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN` are github.com's,
   * which is the only host they are ever sent to.
   */
  private get environmentCredentialIsOurs(): boolean {
    if (!this.host) return true
    const scoped = this.env[environmentTokenName(this.host)]
    if (typeof scoped === 'string' && scoped.trim()) return true
    return this.host === GITHUB_HOST
  }

  private get graphqlUrl(): string {
    return this.options.graphqlUrl?.replace(/\/+$/u, '') ?? `${this.apiUrl}/graphql`
  }

  private get apiUrl(): string {
    return this.options.apiUrl?.replace(/\/+$/u, '') ?? githubApiUrl(this.env)
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? GITHUB_TIMEOUT_MS
  }

  /** The host this transport was built for, or null when only a URL was given. */
  private get host(): string | null {
    const host = this.options.host?.trim().toLowerCase()
    return host ? host : null
  }

  /**
   * Whether requests go to the API origin the host this transport serves owns.
   * A transport built without a host keeps the older rule: only
   * `https://api.github.com` is an origin an owned credential may reach.
   */
  private get servesGitHubOrigin(): boolean {
    const host = this.host
    if (!host) {
      try {
        return new URL(this.apiUrl).origin === GITHUB_CREDENTIAL_ORIGIN
      } catch {
        return false
      }
    }
    try {
      return new URL(this.apiUrl).origin === githubApiOriginForHost(host)
    } catch {
      return false
    }
  }


  /**
   * An explicit environment credential always wins; otherwise the signed-in
   * account's credential is asked for, which refreshes it when it has expired.
   * That credential is bound to one host, so another host's API — or any other
   * origin — never receives it; such a host needs its own explicitly supplied
   * credential.
   */
  private async accessCredential(): Promise<{
    token: string
    credential: GitHubCredentialFailure
  } | null> {
    // Nothing leaves this machine before the destination is known to be a host
    // this transport is allowed to serve.
    if (this.host && !this.servesGitHubOrigin) return null
    // A token handed to this transport directly is the caller's own assertion
    // that it belongs to this host; an ambient one is not, and is treated as the
    // host's issue rather than this machine's.
    const supplied = this.options.token
    if (supplied) {
      return { token: supplied, credential: { origin: 'environment', session: null } }
    }
    const ambient = resolveGitHubToken(this.env, this.host ?? null)
    if (ambient && this.environmentCredentialIsOurs) {
      return { token: ambient, credential: { origin: 'environment', session: null } }
    }
    const credential = this.options.credential
    if (!credential || !this.servesGitHubOrigin) return null
    // The credential is the one this host issued, and this transport serves that
    // host. A host switch or a repository move on another host gets nothing.
    if (this.host && credential.host.trim().toLowerCase() !== this.host) return null
    const held = await credential.current()
    return held === null
      ? null
      : { token: held.token, credential: { origin: held.origin, session: held.session } }
  }

  private async headers(
    hasBody: boolean,
    customHeaders?: Record<string, string>,
  ): Promise<{ headers: Headers; origin: GitHubCredentialFailure }> {
    const access = await this.accessCredential()
    if (!access) {
      throw new GitHubTransportError({
        kind: 'unauthorized',
        detail: this.options.credential
          ? 'sign in to GitHub from the account panel'
          : `set ${GITHUB_TRANSPORT_ENV} with a token or provide GH_TOKEN`,
      })
    }
    const headers = new Headers({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${access.token}`,
      'x-github-api-version': this.options.apiVersion ?? githubApiVersion(this.env),
      'user-agent': this.options.userAgent ?? 'git-stacks',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    })
    if (customHeaders) {
      for (const [key, value] of Object.entries(customHeaders)) {
        headers.set(key, value)
      }
    }
    return { headers, origin: access.credential }
  }

  private async send(
    url: string,
    method: GitHubRestMethod,
    payload: unknown,
    request: Pick<GitHubRestRequest, 'signal' | 'timeoutMs' | 'headers'>,
  ): Promise<{ status: number; body: unknown; headers: Headers; rateLimit: GitHubRateLimit }> {
    const timeoutMs = request.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const forward = () => controller.abort()
    if (request.signal) {
      if (request.signal.aborted) controller.abort()
      else request.signal.addEventListener('abort', forward, { once: true })
    }
    const request$ = (this.options.fetch ?? globalThis.fetch) as typeof globalThis.fetch
    // Which credential this request authenticates as, so a rejection is only ever
    // attributed to the credential that actually caused it.
    let credential: GitHubCredentialFailure = { origin: 'environment', session: null }
    try {
      // Resolving the credential can suspend; an abort in that window must not
      // be lost, because a fetch invoked with an already-aborted signal never settles.
      const access = await this.headers(payload !== undefined, request.headers)
      credential = access.origin
      if (controller.signal.aborted) {
        throw new GitHubTransportError(
          timedOut
            ? { kind: 'timeout', detail: `request did not complete within ${timeoutMs}ms` }
            : { kind: 'cancelled', detail: 'the request was cancelled' },
        )
      }
      const response = await request$(url, {
        method,
        headers: access.headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        // The credential header rides on this request, so a redirect is refused
        // rather than followed: a 307 to another origin would resend the body,
        // and every origin but this host's is refused before the request leaves.
        redirect: 'error',
        signal: controller.signal,
      })
      const rateLimit = parseRateLimit(response.headers)
      publishRateLimit(rateLimit)
      // A 304 is the answer to a conditional request, not a failure: the stored
      // body stands, and `response.ok` would otherwise report it as unknown.
      if (response.status === 304) {
        return { status: 304, body: null, headers: response.headers, rateLimit }
      }
      const body = parseJsonBody(await response.text())
      if (!response.ok) {
        throw new GitHubTransportError({
          kind: statusKind(response.status, rateLimit, apiMessage(body)),
          status: response.status,
          detail: apiMessage(body) ?? response.statusText ?? 'request failed',
          rateLimit,
          body,
        })
      }
      return { status: response.status, body, headers: response.headers, rateLimit }
    } catch (error) {
      if (error instanceof GitHubTransportError) {
        await reportFailure(error, credential)
        throw error
      }
      if (timedOut) {
        throw new GitHubTransportError({
          kind: 'timeout',
          detail: `request did not complete within ${timeoutMs}ms`,
        })
      }
      if (request.signal?.aborted) {
        throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
      }
      throw new GitHubTransportError({
        kind: 'network',
        detail: commandDetail(error),
      })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', forward)
    }
  }

  /** One REST call answered from GitHub, with its headers surfaced for validators. */
  private async result<T>(
    url: string,
    method: GitHubRestMethod,
    payload: unknown,
    request: Pick<GitHubRestRequest, 'signal' | 'timeoutMs' | 'headers'>,
  ): Promise<GitHubRestResponse<T>> {
    const { status, body, headers, rateLimit } = await this.send(url, method, payload, request)
    return { status, data: body as T, rateLimit, headers }
  }

  /**
   * One REST call, replaying a cached body when GitHub answers a conditional
   * request with 304. Without a cache this is a plain full read.
   */
  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    const method = request.method ?? 'GET'
    const path = request.path.replace(/^\/+/u, '')
    // Only a caller that asked for display-grade freshness gets the cache.
    const cache = request.cache === true ? this.options.cache : undefined
    const key = cache ? conditionalCacheKey(request) : null
    const cached: CachedGitHubResponse | null = cache && key ? cache.get(key) : null
    const request$ =
      key === null
        ? request
        : { ...request, headers: { ...request.headers, ...conditionalHeaders(cached) } }
    const { status, body, headers, rateLimit } = await this.send(
      `${this.apiUrl}/${path}`,
      method,
      request.body,
      request$,
    )
    if (status === 304) {
      if (!cached)
        throw new GitHubTransportError({
          status,
          kind: 'invalid-response',
          detail: 'GitHub answered 304 without a stored response',
          rateLimit,
        })
      return { status, data: cached.body as T, headers, rateLimit, notModified: true }
    }
    const etag = headers.get('etag')
    const lastModified = headers.get('last-modified')
    if (cache && key && method === 'GET' && (etag || lastModified)) {
      cache.set(key, { etag, lastModified, body, storedAt: new Date() })
    }
    return { status, data: body as T, headers, rateLimit }
  }

  async paginate<T = unknown>(request: GitHubRestRequest): Promise<T[]> {
    const items: T[] = []
    const origin = new URL(this.apiUrl).origin
    const initialPath = request.path.replace(/^\/+/u, '')
    let currentUrl: string | null = `${this.apiUrl}/${initialPath}`
    for (let page = 0; currentUrl !== null && page < MAX_PAGES; page += 1) {
      const method = request.method ?? 'GET'
      const { body, headers, status, rateLimit } = await this.send(
        currentUrl,
        method,
        request.body,
        request,
      )
      if (!Array.isArray(body)) {
        throw new GitHubTransportError({
          kind: 'invalid-response',
          status,
          detail: 'GitHub returned an unexpected pagination response',
          rateLimit,
        })
      }
      items.push(...(body as T[]))
      const nextLink = parseLink(headers.get('link'))
      if (!nextLink) {
        currentUrl = null
        break
      }
      const resolved = new URL(nextLink, currentUrl)
      currentUrl = resolved.origin === origin ? resolved.toString() : null
    }
    if (currentUrl !== null) {
      throw new GitHubTransportError({
        kind: 'invalid-response',
        detail: `GitHub returned more than ${MAX_PAGES} pages`,
      })
    }
    return items
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
    options: GitHubGraphqlOptions = {},
  ): Promise<T> {
    const { status, body, rateLimit } = await this.send(
      this.graphqlUrl,
      'POST',
      { query, variables },
      options,
    )
    return graphqlData<T>(body, status, rateLimit)
  }
}

function parseLink(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = /<\s*([^>]+)\s*>;.*?\brel="?next"?/iu.exec(part)
    if (match) return match[1].trim()
  }
  return null
}

function includedResponse(output: string): { status: number; headers: Headers; body: unknown } {
  const match = /(?:^|\r?\n)HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n/gu
  let block: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((block = match.exec(output))) last = block
  if (!last)
    throw new GitHubTransportError({
      kind: 'invalid-response',
      detail: 'gh did not return HTTP response headers',
    })
  const start = last.index + last[0].length
  let headerText: string
  let bodyText: string
  if (output.startsWith('\r\n', start)) {
    headerText = ''
    bodyText = output.slice(start + 2)
  } else if (output.startsWith('\n', start)) {
    headerText = ''
    bodyText = output.slice(start + 1)
  } else {
    const boundary = /\r?\n\r?\n/gu
    boundary.lastIndex = start
    const end = boundary.exec(output)
    if (!end)
      throw new GitHubTransportError({
        kind: 'invalid-response',
        detail: 'gh did not return a complete HTTP response',
      })
    headerText = output.slice(start, end.index)
    bodyText = output.slice(end.index + end[0].length)
  }
  const headers = new Headers()
  for (const line of headerText.split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim())
  }
  return {
    status: Number(last[1]),
    headers,
    body: parseJsonBody(bodyText),
  }
}

export interface GhGitHubTransportOptions {
  env?: NodeJS.ProcessEnv
  apiUrl?: string
  /** The GraphQL endpoint for this host; `gh api` is given it as an absolute URL. */
  graphqlUrl?: string
  /** The GitHub host this transport speaks for, passed to `gh api --hostname`. */
  host?: string
  run?: (args: string[], options: GitHubGraphqlOptions & { input?: string }) => Promise<string>
  /** Validators for conditional reads; omitted means every GET is a full read. */
  cache?: GitHubResponseCache
}

/** Optional fallback/diagnostic path: `gh api --include` supplies JSON and HTTP metadata. */
export class GhGitHubTransport implements GitHubTransport {
  readonly kind = 'gh' as const
  private readonly options: GhGitHubTransportOptions

  constructor(options: GhGitHubTransportOptions = {}) {
    this.options = options
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  private get apiUrl(): string {
    return this.options.apiUrl?.replace(/\/+$/u, '') ?? githubApiUrl(this.env)
  }

  private async api(
    args: string[],
    request: GitHubGraphqlOptions,
    input?: string,
  ): Promise<{ status: number; headers: Headers; body: unknown }> {
    if (request.signal?.aborted)
      throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
    const controller = new AbortController()
    let timedOut = false
    const timeoutMs = request.timeoutMs ?? GITHUB_TIMEOUT_MS
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const forward = () => controller.abort()
    request.signal?.addEventListener('abort', forward, { once: true })
    if (request.signal?.aborted) controller.abort()
    const run =
      this.options.run ??
      (async (argv: string[], options: GitHubGraphqlOptions & { input?: string }) => {
        const child = execFile('gh', argv, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...this.options.env,
            GH_PROMPT_DISABLED: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
          timeout: options.timeoutMs ?? GITHUB_TIMEOUT_MS,
          signal: options.signal,
          shell: false,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
        })
        if (options.input !== undefined) child.child.stdin?.end(options.input)
        const result = await child
        return result.stdout
      })
    let output: string
    try {
      try {
        output = await run(args, { signal: controller.signal, timeoutMs, input })
      } catch (error) {
        if (timedOut)
          throw new GitHubTransportError({
            kind: 'timeout',
            detail: `request did not complete within ${timeoutMs}ms`,
          })
        if (request.signal?.aborted)
          throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
        // gh exits nonzero for HTTP errors but preserves the API response in stdout.
        const stdout =
          error !== null && typeof error === 'object' && 'stdout' in error ? error.stdout : null
        if (typeof stdout !== 'string' || !/^HTTP\//u.test(stdout.trimStart()))
          throw toTransportError(error, request.signal)
        output = stdout
      }
      if (timedOut)
        throw new GitHubTransportError({
          kind: 'timeout',
          detail: `request did not complete within ${timeoutMs}ms`,
        })
      if (request.signal?.aborted)
        throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', forward)
    }
    const response = includedResponse(output)
    const rateLimit = parseRateLimit(response.headers)
    publishRateLimit(rateLimit)
    // gh exits nonzero for HTTP errors but keeps a 304 conditional hit in the
    // same place, and that answer is success rather than a failure.
    if (response.status === 304) {
      return { status: 304, headers: response.headers, body: null }
    }
    if (response.status < 200 || response.status >= 300) {
      const failure = new GitHubTransportError({
        kind: statusKind(response.status, rateLimit, apiMessage(response.body)),
        status: response.status,
        detail: apiMessage(response.body) ?? 'request failed',
        rateLimit,
        body: response.body,
      })
      await reportFailure(failure, { origin: 'gh', session: null })
      throw failure
    }
    return response
  }

  private async request<T>(
    request: GitHubRestRequest,
  ): Promise<{ status: number; data: T; headers: Headers; rateLimit: GitHubRateLimit }> {
    const method = request.method ?? 'GET'
    let version = githubApiVersion(this.options.env)
    const extraHeaderEntries: [string, string][] = []
    if (request.headers) {
      for (const [key, value] of Object.entries(request.headers)) {
        if (key.toLowerCase() === 'x-github-api-version') {
          version = value
        } else {
          extraHeaderEntries.push([key, value])
        }
      }
    }
    const args = ['api', '--include', '--header', `X-GitHub-Api-Version: ${version}`]
    for (const [key, value] of extraHeaderEntries) {
      args.push('--header', `${key}: ${value}`)
    }
    const customApi = this.apiUrl !== GITHUB_API_URL
    const isAbsolute = /^https?:\/\//u.test(request.path)
    // `gh` is told which host it is talking to, so a session authenticated for
    // github.com is never asked for a host this app is not serving.
    const hostname = this.options.host?.trim().toLowerCase() || GITHUB_HOST
    if (!customApi && !isAbsolute) {
      args.splice(1, 0, '--hostname', hostname)
    }
    if (method !== 'GET') args.push('--method', method)
    const endpoint = isAbsolute
      ? request.path
      : customApi
        ? `${this.apiUrl}/${request.path.replace(/^\/+/u, '')}`
        : request.path
    args.push(endpoint)
    const input = request.body === undefined ? undefined : JSON.stringify(request.body)
    if (input !== undefined) args.push('--header', 'Content-Type: application/json', '--input', '-')
    const { status, headers, body } = await this.api(args, request, input)
    return { status, data: body as T, headers, rateLimit: parseRateLimit(headers) }
  }

  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    // Only a caller that asked for display-grade freshness gets the cache.
    const cache = request.cache === true ? this.options.cache : undefined
    const key = cache ? conditionalCacheKey(request) : null
    const cached: CachedGitHubResponse | null = cache && key ? cache.get(key) : null
    const conditional =
      key === null
        ? request
        : { ...request, headers: { ...request.headers, ...conditionalHeaders(cached) } }
    const { status, data, headers, rateLimit } = await this.request<T>(conditional)
    if (status === 304) {
      if (!cached)
        throw new GitHubTransportError({
          status,
          kind: 'invalid-response',
          detail: 'GitHub answered 304 without a stored response',
          rateLimit,
        })
      return { status, data: cached.body as T, headers, rateLimit, notModified: true }
    }
    const etag = headers.get('etag')
    const lastModified = headers.get('last-modified')
    if (cache && key && (request.method ?? 'GET') === 'GET' && (etag || lastModified)) {
      cache.set(key, { etag, lastModified, body: data, storedAt: new Date() })
    }
    return { status, data, headers, rateLimit }
  }

  async paginate<T = unknown>(request: GitHubRestRequest): Promise<T[]> {
    const items: T[] = []
    let path: string | null = request.path
    const origin = new URL(this.apiUrl).origin
    for (let page = 0; path !== null && page < MAX_PAGES; page += 1) {
      const response = await this.request<unknown>({ ...request, path })
      if (!Array.isArray(response.data)) {
        throw new GitHubTransportError({
          kind: 'invalid-response',
          status: response.status,
          rateLimit: response.rateLimit,
          detail: 'GitHub returned an unexpected pagination response',
        })
      }
      items.push(...(response.data as T[]))
      const next = parseLink(response.headers.get('link'))
      if (!next) {
        path = null
        break
      }
      const url = new URL(next, /^https?:\/\//u.test(path) ? path : `${this.apiUrl}/`)
      path = url.origin === origin ? url.toString() : null
    }
    if (path !== null) {
      throw new GitHubTransportError({
        kind: 'invalid-response',
        detail: `GitHub returned more than ${MAX_PAGES} pages`,
      })
    }
    return items
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
    options: GitHubGraphqlOptions = {},
  ): Promise<T> {
    const response = await this.request<unknown>({
      method: 'POST',
      // A host that serves GraphQL from its own path is given that path; the
      // default host keeps `/graphql` under its API base.
      path: this.options.graphqlUrl ?? 'graphql',
      body: { query, variables },
      ...options,
    })
    return graphqlData<T>(response.data, response.status, response.rateLimit)
  }
}

/**
 * The only origin an application-owned GitHub App credential may be sent to.
 * A credential this application holds was issued by github.com; another host
 * needs its own explicitly supplied credential.
 */
export const GITHUB_CREDENTIAL_ORIGIN = githubApiOriginForHost(GITHUB_HOST)

export type GitHubTransportChoice = 'auto' | 'direct' | 'gh'

let installed: GitHubTransport | null = null
const installedByHost = new Map<string, GitHubTransport>()
let cached: { key: string; transport: GitHubTransport } | null = null

/**
 * Install a transport for the current process. Tests and integration diagnostics use
 * this; the renderer has no path to it, so no token or HTTP capability crosses the bridge.
 */
export function setGitHubTransport(transport: GitHubTransport | null): void {
  installed = transport
}

const responseCache = new GitHubResponseCacheStore()

/** Conditional-read store shared by every transport this process installs. */
export function githubResponseCache(): GitHubResponseCacheStore {
  return responseCache
}

/**
 * Install the transport one host answers on. A host-specific install wins over
 * the process-wide one, so a test can serve two hosts at once and prove that a
 * request for one never reaches the other.
 */
export function setGitHubHostTransport(host: string, transport: GitHubTransport | null): void {
  const key = host.trim().toLowerCase()
  if (transport) installedByHost.set(key, transport)
  else installedByHost.delete(key)
}

export function githubTransport(env: NodeJS.ProcessEnv = process.env): GitHubTransport {
  if (installed) return installed
  const configured = env[GITHUB_TRANSPORT_ENV]
  const choice: GitHubTransportChoice =
    configured === 'direct' || configured === 'gh' ? configured : 'auto'
  const token = resolveGitHubToken(env)
  // A different token, API version, or signed-in identity changes what a stored
  // body means. Availability is part of the key, so a sign-in or a sign-out
  // changes the choice on the next call without any explicit invalidation.
  const available = credentialSource?.available() === true
  const key = `${choice}:${githubApiUrl(env)}:${githubApiVersion(env)}:${token ?? ''}:${available}`
  if (cached?.key === key) return cached.transport
  if (cached) responseCache.clear()
  // Only a usable account credential selects the direct transport: an account
  // service that is merely constructed must never disable an existing `gh`.
  const direct = choice === 'direct' || (choice === 'auto' && (token !== null || available))
  const transport: GitHubTransport = direct
    ? new DirectGitHubTransport({
        env,
        cache: responseCache,
        credential: credentialSource ?? undefined,
      })
    : new GhGitHubTransport({ env, cache: responseCache })
  cached = { key, transport }
  return transport
}

/**
 * The transport for one GitHub host. Every call for a repository, a stack, or a
 * discovery page resolves the host first and asks for that host's transport, so
 * an enterprise host is never served a github.com endpoint and a github.com
 * credential is never offered to another host.
 */
export function githubTransportForHost(
  host: string,
  apiBase: string,
  env: NodeJS.ProcessEnv = process.env,
  graphqlUrl?: string,
): GitHubTransport {
  const key = host.trim().toLowerCase()
  const hostTransport = installedByHost.get(key)
  if (hostTransport) return hostTransport
  if (installed) return installed
  const configured = env[GITHUB_TRANSPORT_ENV]
  const choice: GitHubTransportChoice =
    configured === 'direct' || configured === 'gh' ? configured : 'auto'
  // A credential only counts for the host it was issued by. Signing in to one
  // host therefore neither enables nor disables another host's own transport.
  const token = resolveGitHubToken(env, key)
  const source = credentialSource ?? null
  const available = source !== null && source.available() === true && source.host === key
  const cacheKey = `${key}:${choice}:${apiBase}:${graphqlUrl ?? ''}:${githubApiVersion(env)}:${token ?? ''}:${source?.host ?? ''}:${available}`
  if (cached?.key === cacheKey) return cached.transport
  const direct = choice === 'direct' || (choice === 'auto' && (token !== null || available))
  const transport: GitHubTransport = direct
    ? new DirectGitHubTransport({
        env,
        host: key,
        apiUrl: apiBase,
        ...(graphqlUrl ? { graphqlUrl } : {}),
        // Only a credential issued by this host is attached; another host's is
        // never carried into a transport that would refuse it anyway.
        ...(available && source !== null ? { credential: source } : {}),
      })
    : new GhGitHubTransport({ env, host: key, apiUrl: apiBase, ...(graphqlUrl ? { graphqlUrl } : {}) })
  cached = { key: cacheKey, transport }
  return transport
}
