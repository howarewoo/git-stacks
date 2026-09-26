import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { commandCode, commandDetail, isRecord, MAX_BUFFER } from './git-core'

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
  headers?: Record<string, string>
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
    return new GitHubTransportError({ kind: 'unsupported', detail: 'the gh CLI is not installed' })
  if (code === 'ETIMEDOUT')
    return new GitHubTransportError({ kind: 'timeout', detail: 'the gh request timed out' })
  if (code === 'ABORT_ERR' || (error instanceof Error && error.name === 'AbortError'))
    return new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
  return new GitHubTransportError({ kind: 'network', detail: commandDetail(error) })
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

  private headers(hasBody: boolean, customHeaders?: Record<string, string>): Headers {
    const token = this.options.token ?? resolveGitHubToken(this.env)
    if (!token) {
      throw new GitHubTransportError({
        kind: 'unauthorized',
        detail: `set ${GITHUB_TRANSPORT_ENV} with a token or provide GH_TOKEN`,
      })
    }
    const headers = new Headers({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': this.options.apiVersion ?? githubApiVersion(this.env),
      'user-agent': this.options.userAgent ?? 'git-stacks',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    })
    if (customHeaders) {
      for (const [key, value] of Object.entries(customHeaders)) {
        headers.set(key, value)
      }
    }
    return headers
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
    try {
      const response = await request$(url, {
        method,
        headers: this.headers(payload !== undefined, request.headers),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      })
      const rateLimit = parseRateLimit(response.headers)
      const body = parseJsonBody(await response.text())
      if (!response.ok) {
        throw new GitHubTransportError({
          kind: statusKind(response.status, rateLimit, apiMessage(body)),
          status: response.status,
          detail: apiMessage(body) ?? response.statusText ?? 'request failed',
          rateLimit,
        })
      }
      return { status: response.status, body, headers: response.headers, rateLimit }
    } catch (error) {
      if (error instanceof GitHubTransportError) throw error
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

  private async result<T>(
    url: string,
    method: GitHubRestMethod,
    payload: unknown,
    request: Pick<GitHubRestRequest, 'signal' | 'timeoutMs' | 'headers'>,
  ): Promise<GitHubRestResponse<T>> {
    const { status, body, rateLimit } = await this.send(url, method, payload, request)
    return { status, data: body as T, rateLimit }
  }

  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    const method = request.method ?? 'GET'
    const path = request.path.replace(/^\/+/u, '')
    return this.result<T>(`${this.apiUrl}/${path}`, method, request.body, request)
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
      `${this.apiUrl}/graphql`,
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
  run?: (args: string[], options: GitHubGraphqlOptions & { input?: string }) => Promise<string>
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
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubTransportError({
        kind: statusKind(response.status, rateLimit, apiMessage(response.body)),
        status: response.status,
        detail: apiMessage(response.body) ?? 'request failed',
        rateLimit,
      })
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
    if (!customApi && !isAbsolute) {
      args.splice(1, 0, '--hostname', GITHUB_HOST)
    }
    if (method !== 'GET') args.push('--method', method)
    const endpoint = isAbsolute
      ? request.path
      : customApi
        ? `${this.apiUrl}/${request.path.replace(/^\/+/u, '')}`
        : request.path
    args.push(endpoint)
    const input = request.body === undefined ? undefined : JSON.stringify(request.body)
    if (input !== undefined) args.push('--input', '-')
    const { status, headers, body } = await this.api(args, request, input)
    return { status, data: body as T, headers, rateLimit: parseRateLimit(headers) }
  }

  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    const { status, data, rateLimit } = await this.request<T>(request)
    return { status, data, rateLimit }
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
      path: 'graphql',
      body: { query, variables },
      ...options,
    })
    return graphqlData<T>(response.data, response.status, response.rateLimit)
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
