import { commandCode, commandDetail, execute, isRecord } from './git-core'

/**
 * Single source for the GitHub API version sent with every direct request, and
 * for the environment variables that redirect the transport. The `gh` adapter
 * cannot set request headers, so it inherits GitHub's own version selection.
 */
export const GITHUB_API_VERSION = '2022-11-28'
export const GITHUB_API_VERSION_ENV = 'GIT_STACKS_GITHUB_API_VERSION'
export const GITHUB_API_URL_ENV = 'GIT_STACKS_GITHUB_API_URL'
export const GITHUB_TRANSPORT_ENV = 'GIT_STACKS_GITHUB_TRANSPORT'
export const GITHUB_API_URL = 'https://api.github.com'
export const GITHUB_TIMEOUT_MS = 20_000
const GITHUB_HOST = 'github.com'
const MAX_PAGES = 100

export type GitHubErrorKind =
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
}

/** Every transport failure carries a typed kind plus the rate-limit metadata GitHub returned. */
export class GitHubTransportError extends Error {
  readonly kind: GitHubErrorKind
  readonly status: number | null
  readonly detail: string
  readonly rateLimit: GitHubRateLimit

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
  }
}

export type GitHubRestMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface GitHubRestRequest {
  method?: GitHubRestMethod
  /** API path without a leading slash, for example `repos/owner/name/pulls/1`. */
  path: string
  body?: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface GitHubRestResponse<T> {
  status: number
  data: T
  rateLimit: GitHubRateLimit
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

export function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ['GIT_STACKS_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
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
  if (status === 429) return 'secondary-rate-limit'
  if (status === 403) {
    if (rateLimit.remaining === 0) return 'rate-limited'
    if (rateLimit.retryAfterSeconds !== null) return 'secondary-rate-limit'
    if (message && /secondary rate limit|abuse detection|temporarily blocked/iu.test(message))
      return 'secondary-rate-limit'
    return 'forbidden'
  }
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 422) return 'unprocessable'
  return 'unknown'
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

/** `gh` failures carry their status in stderr; map them onto the same typed kinds. */
function toTransportError(error: unknown): GitHubTransportError {
  if (error instanceof GitHubTransportError) return error
  const detail = commandDetail(error)
  if (commandCode(error) === 'ENOENT') {
    return new GitHubTransportError({
      kind: 'unsupported',
      detail: 'the gh CLI is not installed',
    })
  }
  const status = /\bHTTP\s+(\d{3})\b/iu.exec(detail)
  if (status) {
    const code = Number(status[1])
    const rateLimit = emptyRateLimit()
    return new GitHubTransportError({
      kind: statusKind(code, rateLimit, detail),
      status: code,
      detail,
      rateLimit,
    })
  }
  if (/auth|login|token|credential/iu.test(detail)) {
    return new GitHubTransportError({ kind: 'unauthorized', detail })
  }
  if (/network|connect|timeout|resolve|fetch|socket|dns|api\.github/iu.test(detail)) {
    return new GitHubTransportError({ kind: 'network', detail })
  }
  return new GitHubTransportError({ kind: 'unknown', detail })
}

export interface DirectGitHubTransportOptions {
  token?: string | null
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  apiUrl?: string
  apiVersion?: string
  timeoutMs?: number
  userAgent?: string
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

  private get apiUrl(): string {
    return this.options.apiUrl?.replace(/\/+$/u, '') ?? githubApiUrl(this.env)
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? GITHUB_TIMEOUT_MS
  }

  private headers(hasBody: boolean): Headers {
    const token = this.options.token ?? resolveGitHubToken(this.env)
    if (!token) {
      throw new GitHubTransportError({
        kind: 'unauthorized',
        detail: `set ${GITHUB_TRANSPORT_ENV} with a token or provide GH_TOKEN`,
      })
    }
    return new Headers({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': this.options.apiVersion ?? githubApiVersion(this.env),
      'user-agent': this.options.userAgent ?? 'git-stacks',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    })
  }

  private async send(
    url: string,
    method: GitHubRestMethod,
    payload: unknown,
    request: Pick<GitHubRestRequest, 'signal' | 'timeoutMs'>,
  ): Promise<{ response: Response; rateLimit: GitHubRateLimit }> {
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
    try {
      const response = await request$(url, {
        method,
        headers: this.headers(payload !== undefined),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      })
      const rateLimit = parseRateLimit(response.headers)
      if (!response.ok) {
        const body = parseJsonBody(await response.text())
        throw new GitHubTransportError({
          kind: statusKind(response.status, rateLimit, apiMessage(body)),
          status: response.status,
          detail: apiMessage(body) ?? response.statusText ?? 'request failed',
          rateLimit,
        })
      }
      return { response, rateLimit }
    } catch (error) {
      if (error instanceof GitHubTransportError) throw error
      if (timedOut) {
        throw new GitHubTransportError({
          kind: 'timeout',
          detail: `no response within ${timeoutMs}ms`,
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

  private async result<T>(
    url: string,
    method: GitHubRestMethod,
    payload: unknown,
    request: Pick<GitHubRestRequest, 'signal' | 'timeoutMs'>,
  ): Promise<GitHubRestResponse<T>> {
    const { response, rateLimit } = await this.send(url, method, payload, request)
    return { status: response.status, data: parseJsonBody(await response.text()) as T, rateLimit }
  }

  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    const method = request.method ?? 'GET'
    return this.result<T>(`${this.apiUrl}/${request.path}`, method, request.body, request)
  }

  async paginate<T = unknown>(request: GitHubRestRequest): Promise<T[]> {
    const items: T[] = []
    const origin = new URL(this.apiUrl).origin
    let path: string | null = request.path
    for (let page = 0; path !== null && page < MAX_PAGES; page += 1) {
      const method = request.method ?? 'GET'
      const { response } = await this.send(`${this.apiUrl}/${path}`, method, request.body, request)
      const data = parseJsonBody(await response.text())
      if (Array.isArray(data)) items.push(...(data as T[]))
      // Only follow GitHub's own next link; a foreign host never receives the token.
      const next = new URL(parseLink(response.headers.get('link')) ?? '', `${this.apiUrl}/`)
      path =
        next.origin === origin && next.pathname !== '/'
          ? `${next.pathname.slice(1)}${next.search}`
          : null
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
    const { response } = await this.send(
      `${this.apiUrl}/graphql`,
      'POST',
      { query, variables },
      options,
    )
    const body = parseJsonBody(await response.text())
    const errors = graphqlMessages(body)
    if (errors) {
      throw new GitHubTransportError({ kind: 'invalid-response', detail: errors })
    }
    if (!isRecord(body) || !isRecord(body.data)) {
      throw new GitHubTransportError({
        kind: 'invalid-response',
        detail: 'GitHub returned a GraphQL response without data',
      })
    }
    return body.data as T
  }
}

function parseLink(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="next"/u.exec(part)
    if (match) return match[1]
  }
  return null
}

export interface GhGitHubTransportOptions {
  env?: NodeJS.ProcessEnv
  run?: (args: string[]) => Promise<string>
}

/** Optional fallback/diagnostic path: the same contract implemented with `gh api` JSON output. */
export class GhGitHubTransport implements GitHubTransport {
  readonly kind = 'gh' as const
  private readonly options: GhGitHubTransportOptions

  constructor(options: GhGitHubTransportOptions = {}) {
    this.options = options
  }

  private async api(args: string[]): Promise<unknown> {
    const run = this.options.run ?? ((argv: string[]) => execute('gh', argv, process.cwd()))
    try {
      return parseJsonBody(await run(args))
    } catch (error) {
      throw toTransportError(error)
    }
  }

  private async request<T>(request: GitHubRestRequest, extra: string[] = []): Promise<T> {
    const method = request.method ?? 'GET'
    const args = ['api', '--hostname', GITHUB_HOST, ...extra]
    if (method !== 'GET') args.push('--method', method)
    args.push(request.path)
    for (const [key, value] of Object.entries(request.body ?? {})) {
      // `gh` only sends JSON-native values for -F; strings must stay -f.
      args.push(typeof value === 'string' ? '-f' : '-F', `${key}=${String(value)}`)
    }
    return (await this.api(args)) as T
  }

  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    return { status: 200, data: await this.request<T>(request), rateLimit: emptyRateLimit() }
  }

  async paginate<T = unknown>(request: GitHubRestRequest): Promise<T[]> {
    const data = await this.request<T[]>(request, ['--paginate', '--slurp'])
    if (!Array.isArray(data)) {
      throw new GitHubTransportError({
        kind: 'invalid-response',
        detail: 'GitHub returned an unexpected pagination response',
      })
    }
    return data.flat() as T[]
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const data = await this.request<unknown>({ path: 'graphql', body: { query, ...variables } })
    const errors = graphqlMessages(data)
    if (errors) throw new GitHubTransportError({ kind: 'invalid-response', detail: errors })
    if (!isRecord(data) || !isRecord(data.data)) {
      throw new GitHubTransportError({
        kind: 'invalid-response',
        detail: 'GitHub returned a GraphQL response without data',
      })
    }
    return data.data as T
  }
}

export type GitHubTransportChoice = 'auto' | 'direct' | 'gh'

let installed: GitHubTransport | null = null
let cached: { key: string; transport: GitHubTransport } | null = null

/**
 * Install a transport for the current process. Tests and integration diagnostics use
 * this; the renderer has no path to it, so no token or HTTP capability crosses the bridge.
 */
export function setGitHubTransport(transport: GitHubTransport | null): void {
  installed = transport
}

export function githubTransport(env: NodeJS.ProcessEnv = process.env): GitHubTransport {
  if (installed) return installed
  const configured = env[GITHUB_TRANSPORT_ENV]
  const choice: GitHubTransportChoice =
    configured === 'direct' || configured === 'gh' ? configured : 'auto'
  const token = resolveGitHubToken(env)
  const key = `${choice}:${githubApiUrl(env)}:${githubApiVersion(env)}:${token ?? ''}`
  if (cached?.key === key) return cached.transport
  const direct = choice === 'direct' || (choice === 'auto' && token !== null)
  const transport: GitHubTransport = direct
    ? new DirectGitHubTransport({ env })
    : new GhGitHubTransport({ env })
  cached = { key, transport }
  return transport
}
