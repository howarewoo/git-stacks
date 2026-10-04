import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { canonicalHostName } from '../shared/host'
import { commandCode, commandDetail, MAX_BUFFER } from './git-core'
import { isRecord } from '../shared/guards'
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
  authority?: string | null
  /**
   * Whether this failure's rate-limit metadata becomes the process-wide report
   * every other caller budgets against. Off for a transport that keeps its own
   * accounting to itself: an optional module's exhausted token would otherwise
   * park an unrelated, healthy credential against a wall it never hit.
   */
  publish?: boolean
}

/** Every transport failure carries a typed kind plus the rate-limit metadata GitHub returned. */
export class GitHubTransportError extends Error {
  readonly kind: GitHubErrorKind
  readonly status: number | null
  readonly detail: string
  readonly rateLimit: GitHubRateLimit
  readonly body: unknown
  readonly authority: string | null

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
    this.authority = failure.authority ?? null
    if (failure.publish !== false)
      publishRateLimit(this.rateLimit, failure.kind, null, this.authority)
  }
}

/**
 * A call this build refused to make because the caller's own request budget was
 * spent. It is raised rather than answered, and every consumer of a transport
 * re-raises it instead of recording a host-unreachable answer: the host was
 * never asked, so no host answered or failed to.
 */
export class GitHubBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubBudgetExhaustedError'
  }
}

let latestRateLimit: GitHubRateLimitReport = { rateLimit: emptyRateLimit(), kind: null, at: 0 }
/**
 * What each host last reported, because two hosts do not share a window. A
 * caller that budgets per host cannot read another host's remaining count as
 * its own: it would turn away a queue GitHub is still answering.
 */
const rateLimitByHost = new Map<string, GitHubRateLimitReport>()
const rateLimitByHostAuthority = new Map<string, GitHubRateLimitReport>()
const rateLimitListeners = new Set<(report: GitHubRateLimitReport) => void>()

function rateLimitAuthorityKey(
  host: string,
  authority?: string | null,
  resource?: string | null,
): string {
  return `${host.trim().toLowerCase()}\u0000${authority ?? ''}\u0000${resource ?? ''}`
}

/**
 * The clock every rate-limit observation is stamped with.
 *
 * It is this process's own clock, and a caller that runs a read on a clock of
 * its own hands that clock over here as well: a wait is measured from the
 * moment the refusal was seen, and the caller deciding whether that wait has
 * passed reads the same clock, so one read's answer can never be dated in one
 * time and admitted in another.
 */
let observationClock: () => number = Date.now

export function setGitHubObservationClock(clock: (() => number) | null): void {
  observationClock = clock ?? Date.now
}

function publishRateLimit(
  rateLimit: GitHubRateLimit,
  kind: GitHubErrorKind | null = null,
  host: string | null = null,
  authority?: string | null,
  initiatedAt?: number,
): void {
  latestRateLimit = {
    rateLimit,
    kind,
    at: observationClock(),
    ...(authority !== undefined && authority !== null ? { authority } : {}),
  }
  if (host) {
    const current = rateLimitByHost.get(host)
    const isStale =
      current !== undefined &&
      initiatedAt !== undefined &&
      current.at > initiatedAt &&
      current.authority !== (authority ?? null)
    if (!isStale) {
      rateLimitByHost.set(host, latestRateLimit)
    }
    rateLimitByHost.set(rateLimitAuthorityKey(host, null, rateLimit.resource), latestRateLimit)
    if (authority !== undefined && authority !== null) {
      rateLimitByHostAuthority.set(rateLimitAuthorityKey(host, authority), latestRateLimit)
      rateLimitByHostAuthority.set(
        rateLimitAuthorityKey(host, authority, rateLimit.resource),
        latestRateLimit,
      )
    }
    noteGitHubRetryDeadline(host, rateLimit, latestRateLimit.at, kind)
  }
  for (const listener of rateLimitListeners) listener(latestRateLimit)
}

/**
 * When each host asked to be left alone until.
 *
 * A wait belongs to the host that named it and to the answer that carried the
 * name, so it is recorded where the refusal was observed — at the moment the
 * response arrived, not the moment the request left — and read by whoever
 * admits the next request. It outlives the allowance that came with it: what is
 * left of a host's budget says when the window ends, not when the host is
 * willing to answer again, so a later success publishes an allowance without
 * ending a wait that is still in force.
 */
const retryDeadlineByHost = new Map<string, number>()

export function noteGitHubRetryDeadline(
  host: string,
  rateLimit: GitHubRateLimit,
  at: number,
  kind: GitHubErrorKind | null,
): void {
  // Only a refusal that was actually about this host's rate limit. A repository
  // the credential cannot see still carries that host's ordinary quota headers,
  // and a reset an hour away is a statement about the window, not an
  // instruction to stop asking the host for the hour.
  if (kind !== 'rate-limited' && kind !== 'secondary-rate-limit') return
  const retryAfter =
    typeof rateLimit.retryAfterSeconds === 'number' ? rateLimit.retryAfterSeconds * 1000 : 0
  // Primary reset windows belong to the authenticated principal, not the host.
  if (kind !== 'secondary-rate-limit' && retryAfter <= 0) return
  const reset = rateLimit.reset instanceof Date ? rateLimit.reset.getTime() : null
  const wait = Math.max(
    retryAfter,
    kind === 'secondary-rate-limit' && retryAfter <= 0 ? 60_000 : 0,
    kind === 'secondary-rate-limit' &&
      rateLimit.remaining === 0 &&
      reset !== null &&
      Number.isFinite(reset) &&
      reset > at
      ? reset - at
      : 0,
  )
  if (wait > 0)
    retryDeadlineByHost.set(host, Math.max(retryDeadlineByHost.get(host) ?? 0, at + wait))
}

/**
 * When `host` last asked to be left alone, as an absolute time, or null when it
 * has not. This is the one wait a caller may refuse a host on: it was taken
 * from that host's own refusal, at the moment that refusal was received.
 */
export function githubRetryDeadlineFor(host: string): number | null {
  return retryDeadlineByHost.get(host) ?? null
}

/** Ends one host's wait, for the caller deciding that the wait is over. */
export function clearGitHubRetryDeadline(host: string): void {
  retryDeadlineByHost.delete(host)
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

/**
 * What `host` itself last reported, or an empty report for a host that has
 * answered nothing. This is the only count a caller may budget a host with.
 */
export function lastGitHubRateLimitFor(
  host: string,
  authority?: string | null,
  resource?: string,
): GitHubRateLimitReport {
  if (authority !== undefined && authority !== null) {
    const latest = rateLimitByHostAuthority.get(rateLimitAuthorityKey(host, authority))
    return (
      rateLimitByHostAuthority.get(rateLimitAuthorityKey(host, authority, resource)) ??
      (latest?.rateLimit.resource === null ? latest : undefined) ?? {
        rateLimit: emptyRateLimit(),
        kind: null,
        at: 0,
        authority,
      }
    )
  }
  return (
    rateLimitByHost.get(
      resource === undefined ? host : rateLimitAuthorityKey(host, null, resource),
    ) ?? {
      rateLimit: emptyRateLimit(),
      kind: null,
      at: 0,
    }
  )
}

export function resetGitHubRateLimit(): void {
  latestRateLimit = { rateLimit: emptyRateLimit(), kind: null, at: 0 }
  rateLimitByHost.clear()
  rateLimitByHostAuthority.clear()
  retryDeadlineByHost.clear()
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
  /**
   * Opt in to accepting a 304 without a cached response body for a mutation
   * that documents 304 as "nothing changed". Off by default: an unexpected
   * 304 on any other mutation is refused as an invalid response.
   */
  acceptNoChange?: boolean
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
  /** The credential authority this response was observed under, when authenticated. */
  authority?: string
}

/** The most recent GitHub rate-limit metadata either transport observed. */
export interface GitHubRateLimitReport {
  rateLimit: GitHubRateLimit
  /** The failure kind when this report came from an error, otherwise null. */
  kind: GitHubErrorKind | null
  at: number
  /**
   * The credential authority this rate limit was observed under, or null when
   * observed without a credential.
   */
  authority?: string | null
}

export interface GitHubGraphqlOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/** The only GitHub capability domain services may use; it never exposes a token or raw fetch. */
export interface GitHubTransport {
  readonly kind: 'direct' | 'gh'
  /**
   * The host this transport's answers are evidence about, and the host whose
   * allowance and wait it publishes: the one that will actually serve the
   * requests. A configured API base can name that host rather than the host
   * this transport was built for, so this is not the origin a repository's rows
   * are filed under — it is the server those rows are metered on. Anything that
   * budgets per host has to read admission here, or it consults an empty bucket
   * for a server whose quota this process is already inside.
   */
  readonly destinationHost: string
  rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>>
  /** Follows every page of a REST collection and returns the concatenated items. */
  paginate<T = unknown>(request: GitHubRestRequest): Promise<T[]>
  graphql<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GitHubGraphqlOptions,
  ): Promise<T>
  /**
   * An opaque identity for the credential this transport would authenticate
   * with right now, asked of the transport itself because only the transport
   * knows how it actually resolves one. It carries no secret and cannot
   * authenticate anything: two answers that match are the same credential, and
   * two that differ are a credential that was replaced.
   */
  credentialAuthority(): Promise<string>
}

export function emptyRateLimit(): GitHubRateLimit {
  return { limit: null, remaining: null, reset: null, resource: null, retryAfterSeconds: null }
}

export function githubApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[GITHUB_API_VERSION_ENV]
  return typeof value === 'string' && value.trim() ? value.trim() : GITHUB_API_VERSION
}

/**
 * The API base this environment names, when it names one. A base that was not
 * named is not a base that was pointed at the public host: `gh` reads the same
 * environment and picks a host of its own from `GH_HOST`, so a host decided
 * from a base that was never configured would answer for the wrong credential.
 */
function configuredGitHubApiUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[GITHUB_API_URL_ENV]
  return typeof value === 'string' && value.trim() ? value.replace(/\/+$/u, '') : null
}

export function githubApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return configuredGitHubApiUrl(env) ?? GITHUB_API_URL
}

/** The host name the public host's own API base answers on. */
const GITHUB_API_HOSTNAME = new URL(GITHUB_API_URL).hostname

/**
 * The GitHub host an endpoint belongs to, by authority alone.
 *
 * The authority is the hostname and the port together, because an enterprise
 * host may serve its API from a port of its own and a credential scoped to
 * `ghe.example.com:8443` is not the credential for `ghe.example.com`: dropping
 * the port would fence a request as one host while the CLI sends it to another.
 * A port that is a scheme's own default is not part of a host's identity, so
 * `https://ghe.example.com:443` and `https://ghe.example.com` are one host.
 *
 * The public host's API base is that host rather than a host of its own, so it
 * answers as `github.com`; every other base names the authority that has to
 * answer for it. An endpoint that is not a URL at all names no host, which is
 * not the same as naming the public one.
 */
export function gitHubHostOfEndpoint(endpoint: string): string | null {
  let authority: string
  try {
    authority = new URL(endpoint).host
  } catch {
    return null
  }
  const host = canonicalHostName(authority)
  if (host === '') return null
  return host === GITHUB_API_HOSTNAME ? GITHUB_HOST : host
}

/**
 * The host an API base names, when the base says something the host's own
 * routing would not.
 *
 * The public base is where a github.com request goes whether or not it was
 * named, so it cannot outvote a host that was named for the transport: it
 * resolves nothing a host name does not. Any other base was pointed at
 * deliberately and is the host these requests are really for.
 */
function gitHubHostOfConfiguredBase(base: string | null): string | null {
  if (base === null) return null
  const canonical = base.replace(/\/+$/u, '')
  return canonical === GITHUB_API_URL ? null : gitHubHostOfEndpoint(canonical)
}

/**
 * The credential variables the CLI reads for one host, most preferred first —
 * the order the CLI itself resolves them in.
 *
 * The CLI reads `GH_TOKEN`/`GITHUB_TOKEN` for github.com and for `*.ghe.com`,
 * and `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` for every other GitHub
 * host, which is what a GitHub Enterprise Server installation is. Handing a
 * host the other pair is handing it a credential it will not read, so a host
 * that is neither github.com nor under `ghe.com` is a server host.
 */
export function credentialEnvNames(host: string | null = null): readonly string[] {
  const canonical = canonicalHostName(host ?? GITHUB_HOST)
  const server = canonical !== GITHUB_HOST && !canonical.endsWith('.ghe.com')
  return server
    ? ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
    : ['GH_TOKEN', 'GITHUB_TOKEN']
}

/**
 * The headless credential this process already holds for one host, or null.
 *
 * These are the CLI's own variables and remain CLI-owned: this build supplies
 * them to the `gh` children it starts and never stores, seals, or reports one.
 * A host with no variable of its own class is a host this process holds nothing
 * for, whatever the other class holds.
 */
export function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  host: string | null = null,
): string | null {
  for (const name of credentialEnvNames(host)) {
    const value = env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** A one-way digest of a credential, used only to notice that it changed. */
function credentialDigest(token: string | null): string {
  return createHash('sha256')
    .update(token ?? '')
    .digest('hex')
    .slice(0, 32)
}

/** Stable opaque identity for the actual credential material on one host. */
function hostCredentialAuthority(host: string, material: string | null): string {
  return `${host.trim().toLowerCase()}\u0000${credentialDigest(material)}`
}

/**
 * The identity for the credential `host` would authenticate with from this
 * process's own variables alone. A caller that has a transport for that host
 * asks the transport instead, because only the transport knows which credential
 * its requests would actually carry.
 *
 * This covers only what this module resolves. A host whose requests are made by
 * the `gh` CLI is authenticated by whatever profile that CLI holds, and
 * `GhGitHubTransport.credentialAuthority` is what sees that.
 */
export function githubHostCredentialIdentity(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return hostCredentialAuthority(host, resolveGitHubToken(env, host.trim().toLowerCase()))
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

/**
 * The data of a GraphQL answer, or the refusal it reports.
 *
 * A GraphQL refusal arrives inside a successful HTTP response, so the envelope
 * that carried it has already been published as an allowance by the time the
 * body is read. `onRefusal` is how the classified refusal reaches the same
 * record: a host that asked to be left alone must still be holding that answer
 * when the next read is admitted, whether it said so in a status line or in the
 * body it returned with 200.
 */
function graphqlData<T>(
  body: unknown,
  status: number,
  rateLimit: GitHubRateLimit,
  authority: string,
  onRefusal?: (rateLimit: GitHubRateLimit, kind: GitHubErrorKind) => void,
  publish: boolean = true,
): T {
  const errors = graphqlMessages(body)
  if (errors) {
    const kind = statusKind(403, rateLimit, errors)
    if (kind === 'rate-limited' || kind === 'secondary-rate-limit') onRefusal?.(rateLimit, kind)
    throw new GitHubTransportError({
      kind: kind === 'rate-limited' || kind === 'secondary-rate-limit' ? kind : 'invalid-response',
      status,
      detail: errors,
      rateLimit,
      authority,
      publish,
    })
  }
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new GitHubTransportError({
      kind: 'invalid-response',
      status,
      detail: 'GitHub returned a GraphQL response without data',
      rateLimit,
      authority,
      publish,
    })
  }
  return body.data as T
}

function parseJsonBody(text: string, publish: boolean = true): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new GitHubTransportError({
      kind: 'invalid-response',
      detail: 'GitHub returned a response that is not valid JSON',
      publish,
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
  /**
   * The one credential this transport authenticates with, supplied by the
   * caller that owns it. There is no ambient fallback and no account to ask: a
   * caller with no credential of its own has none to use here.
   */
  token?: string | null
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
  /**
   * Whether this transport's rate-limit metadata becomes the process-wide
   * report the rest of the app budgets against. On by default. An optional
   * module that authenticates as its own separately authorized credential turns
   * it off: one token's exhausted budget must not park pull requests, stacks,
   * and reviews behind a wall this module hit alone. Its own deadlines are
   * unaffected — every response still carries the metadata to whoever asked.
   */
  reportRateLimit?: boolean
}

/** Authenticated REST/GraphQL access to GitHub over HTTP; it never spawns `gh`. */
/** The origin an API base resolves to, or null when the base is not a URL. */
function originOf(apiUrl: string): string | null {
  try {
    return new URL(apiUrl).origin
  } catch {
    return null
  }
}

export class DirectGitHubTransport implements GitHubTransport {
  readonly kind = 'direct' as const
  private readonly options: DirectGitHubTransportOptions

  constructor(options: DirectGitHubTransportOptions = {}) {
    this.options = options
  }

  /** Whether this transport's rate-limit metadata is reported process-wide. */
  private get reportsRateLimit(): boolean {
    return this.options.reportRateLimit !== false
  }

  /**
   * A failure of this transport's own, reported to the process-wide listener
   * only when this transport is allowed to report what it saw.
   */
  private failure(failure: Omit<GitHubTransportFailure, 'publish'>): GitHubTransportError {
    return new GitHubTransportError({
      ...failure,
      publish: this.options.reportRateLimit !== false,
    })
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
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
   * The GitHub host whose allowance this transport's answers count for, and the
   * host anything that admits work against this transport has to ask.
   *
   * A transport built without a host still serves one, and the base it was
   * configured with names it. Publishing without that host would leave an
   * ordinary answer with no provenance at all, so a consumer that budgets per
   * host could never learn from a request made through the default transport.
   *
   * The base outranks the named host because the base is where the requests
   * are sent: an answer published there has to be admitted on there. What a
   * repository's rows are filed under is a separate fact and this is not it.
   */
  get destinationHost(): string {
    return gitHubHostOfConfiguredBase(this.apiUrl) ?? this.host ?? GITHUB_HOST
  }

  /**
   * Whether requests go to the API origin the host this transport serves owns,
   * derived from that host's name alone. A transport built without a host keeps
   * the older rule: only `https://api.github.com` is an origin an owned
   * credential may reach.
   *
   * This is the origin the host's own saved credential may be sent to, so an API
   * base configured for the host never widens it.
   */
  private get servesGitHubOrigin(): boolean {
    const host = this.host
    try {
      return host
        ? new URL(this.apiUrl).origin === githubApiOriginForHost(host)
        : new URL(this.apiUrl).origin === GITHUB_CREDENTIAL_ORIGIN
    } catch {
      return false
    }
  }

  /**
   * Whether requests go to an origin a credential this caller supplied may be
   * sent to: the origin the host's name derives, or — for the public host — the
   * base the environment configures it to serve. A caller that configures the
   * base and supplies the credential for it has stated both; the host's saved
   * credential is a different matter and is not widened by this.
   */
  private get servesSuppliedCredentialOrigin(): boolean {
    if (this.servesGitHubOrigin) return true
    if (this.host !== GITHUB_HOST) return false
    const configured = originOf(githubApiUrl(this.env))
    return configured !== null && configured === originOf(this.apiUrl)
  }

  /**
   * The credential this transport authenticates with, or null when its caller
   * supplied none or the destination is not an origin that credential may be
   * sent to. Nothing leaves this machine before the destination is known to be
   * a host this transport is allowed to serve, and the credential is bound to
   * one host, so another host's API — or any other origin — never receives it.
   */
  private accessCredential(): { token: string } | null {
    const supplied = this.options.token
    if (!supplied) return null
    if (this.host && !this.servesSuppliedCredentialOrigin) return null
    return { token: supplied }
  }

  /**
   * The identity every request and every cached body from this transport is
   * fenced on: the credential its requests actually carry, digested. It is
   * derived from the same resolution the request uses and changes with it, so a
   * validator recorded for one credential can never be replayed against
   * another.
   */
  private get requestAuthority(): string {
    return hostCredentialAuthority(this.host ?? GITHUB_HOST, this.accessCredential()?.token ?? null)
  }

  private async headers(
    hasBody: boolean,
    customHeaders?: Record<string, string>,
  ): Promise<{ headers: Headers; token: string }> {
    const access = this.accessCredential()
    if (!access) {
      throw this.failure({
        kind: 'unauthorized',
        detail: 'no GitHub credential was supplied to this transport',
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
    return { headers, token: access.token }
  }

  private async send(
    url: string,
    method: GitHubRestMethod,
    payload: unknown,
    request: Pick<GitHubRestRequest, 'signal' | 'timeoutMs' | 'headers'>,
  ): Promise<{
    status: number
    body: unknown
    headers: Headers
    rateLimit: GitHubRateLimit
    authority: string
  }> {
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
    const initiatedAt = observationClock()
    // Which credential this request authenticates as, so a refusal is only ever
    // attributed to the credential that actually caused it.
    let requestAuthority: string | null = null
    try {
      const access = await this.headers(payload !== undefined, request.headers)
      requestAuthority = hostCredentialAuthority(this.host ?? GITHUB_HOST, access.token)
      if (controller.signal.aborted) {
        throw this.failure(
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
      // A 304 is the answer to a conditional request, not a failure: the stored
      // body stands, and `response.ok` would otherwise report it as unknown.
      if (response.status === 304) {
        if (this.reportsRateLimit)
          publishRateLimit(rateLimit, null, this.destinationHost, requestAuthority, initiatedAt)
        return {
          status: 304,
          body: null,
          headers: response.headers,
          rateLimit,
          authority: requestAuthority,
        }
      }
      const body = parseJsonBody(await response.text(), this.reportsRateLimit)
      if (!response.ok) {
        const failure = this.failure({
          kind: statusKind(response.status, rateLimit, apiMessage(body)),
          status: response.status,
          detail: apiMessage(body) ?? response.statusText ?? 'request failed',
          rateLimit,
          body,
          authority: requestAuthority,
        })
        // Recorded against this host as the refusal it is, so a consumer that
        // budgets per host sees the wait this answer named.
        if (this.reportsRateLimit)
          publishRateLimit(
            rateLimit,
            failure.kind,
            this.destinationHost,
            requestAuthority,
            initiatedAt,
          )
        throw failure
      }
      if (this.reportsRateLimit)
        publishRateLimit(rateLimit, null, this.destinationHost, requestAuthority, initiatedAt)
      return {
        status: response.status,
        body,
        headers: response.headers,
        rateLimit,
        authority: requestAuthority,
      }
    } catch (error) {
      if (error instanceof GitHubTransportError) throw error
      if (timedOut) {
        throw this.failure({
          kind: 'timeout',
          detail: `request did not complete within ${timeoutMs}ms`,
        })
      }
      if (request.signal?.aborted) {
        throw this.failure({ kind: 'cancelled', detail: 'the request was cancelled' })
      }
      throw this.failure({
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
    const { status, body, headers, rateLimit, authority } = await this.send(
      url,
      method,
      payload,
      request,
    )
    return { status, data: body as T, rateLimit, headers, authority }
  }

  /**
   * One REST call, replaying a cached body when GitHub answers a conditional
   * request with 304. Without a cache this is a plain full read.
   */
  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    const method = request.method ?? 'GET'
    const path = request.path.replace(/^\/+/u, '')
    // The credential this request will carry is part of the cache identity: a
    // body read as one account is not this account's answer to ask again, and a
    // validator recorded for one credential must never be replayed against the
    // next one.
    const credential = this.requestAuthority
    // Only a caller that asked for display-grade freshness gets the cache.
    const cache = request.cache === true ? this.options.cache : undefined
    const key = cache ? conditionalCacheKey(request, credential) : null
    const cached: CachedGitHubResponse | null = cache && key ? cache.get(key) : null
    const request$ =
      key === null
        ? request
        : { ...request, headers: { ...request.headers, ...conditionalHeaders(cached) } }
    const { status, body, headers, rateLimit, authority } = await this.send(
      `${this.apiUrl}/${path}`,
      method,
      request.body,
      request$,
    )
    if (status === 304) {
      // A mutation opting in to 304 is documented to answer as "no change":
      // there is no display body to replay for it, and callers that did not
      // opt in treat an unexpected 304 as an error. A conditional GET keeps
      // the requirement it always had, because its 304 does mean a stored body.
      if (!cached && method !== 'GET' && request.acceptNoChange === true) {
        return { status, data: null as T, headers, rateLimit, notModified: true }
      }
      if (!cached)
        throw this.failure({
          status,
          kind: 'invalid-response',
          detail: 'GitHub answered 304 without a stored response',
          rateLimit,
        })
      return { status, data: cached.body as T, headers, rateLimit, notModified: true, authority }
    }
    const etag = headers.get('etag')
    const lastModified = headers.get('last-modified')
    // A response the caller has already abandoned is not this caller's to
    // record: pairing an old body with the validator in force after it would
    // make the next legitimate 304 replay an incomplete list. The centre that
    // owns this cache cancels the read that is no longer wanted, and a
    // cancelled read writes nothing.
    if (cache && key && method === 'GET' && (etag || lastModified) && !request.signal?.aborted) {
      cache.set(key, { etag, lastModified, body, storedAt: new Date() })
    }
    return { status, data: body as T, headers, rateLimit, authority }
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
        throw this.failure({
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
      throw this.failure({
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
    const { status, body, rateLimit, authority } = await this.send(
      this.graphqlUrl,
      'POST',
      { query, variables },
      options,
    )
    return graphqlData<T>(
      body,
      status,
      rateLimit,
      authority,
      this.reportsRateLimit
        ? (limit, kind) => publishRateLimit(limit, kind, this.destinationHost, authority)
        : undefined,
      this.reportsRateLimit,
    )
  }

  /**
   * Every request this transport makes carries the credential
   * `accessCredential` resolved for it, so that is what the identity fences on.
   * Asking the environment instead would miss a credential this caller owns,
   * which would leave work read under one credential sitting beside work read
   * under the next one. The material is digested and never returned.
   */
  async credentialAuthority(): Promise<string> {
    return this.requestAuthority
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

/**
 * The environment a host-scoped child process runs with.
 *
 * Only the credential variables the CLI reads for this host are forwarded, in
 * the CLI's own order of preference, so `gh` resolves exactly the credential it
 * would have resolved and a host is never handed another host's. Every other
 * credential variable is removed rather than left to be inherited.
 *
 * A null host addresses no GitHub host at all — a version query reaches nothing —
 * so no credential of any class is forwarded to it.
 */
export function hostScopedEnvironment(
  env: NodeJS.ProcessEnv,
  host: string | null,
): Record<string, string> {
  const allowed = host === null ? [] : credentialEnvNames(host)
  const scoped: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    if (CREDENTIAL_ENV[name] === true && !allowed.includes(name)) continue
    scoped[name] = value
  }
  return scoped
}

/** Every credential variable a `gh` child may be given, in no host's favour. */
const CREDENTIAL_ENV: Record<string, true> = {
  GH_TOKEN: true,
  GITHUB_TOKEN: true,
  GH_ENTERPRISE_TOKEN: true,
  GITHUB_ENTERPRISE_TOKEN: true,
}

export class GhGitHubTransport implements GitHubTransport {
  readonly kind = 'gh' as const
  private readonly options: GhGitHubTransportOptions

  constructor(options: GhGitHubTransportOptions = {}) {
    this.options = options
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  /**
   * The one GitHub host this transport authenticates as, sends every request
   * to, and credits every answer it observes to.
   *
   * Endpoint construction, the credential the CLI is asked for, the environment
   * its child process runs with and the allowance it publishes all resolve
   * through this single host, so a request can never be made — or counted —
   * against a host other than the one whose authority fences it. It is also
   * what a consumer budgets and refuses against, which is why it is published:
   * admitting work on the host a repository's origin named would consult a
   * bucket this transport never writes to whenever the two differ.
   *
   * A configured API base decides the host, because `gh` is pointed at that URL
   * and authenticates with the credential it holds for the host serving it. It
   * decides it even when a host was named as well: an operator who points this
   * build's base at another host is served by that host, and a host named for
   * the requests' origin would describe a credential the requests never use,
   * so a replacement of the credential that base does resolve to would go
   * unnoticed. A host named with no base configured is the next authority, and
   * `GH_HOST` the one after it, because that is the host `gh` itself resolves
   * when nothing else was configured. A base nobody configured is the public
   * one by fallback, not by anyone's decision, so it cannot outvote a host
   * that was named.
   */
  get destinationHost(): string {
    return (
      gitHubHostOfConfiguredBase(this.configuredBase) ||
      this.options.host?.trim().toLowerCase() ||
      canonicalHostName(this.env.GH_HOST ?? '') ||
      GITHUB_HOST
    )
  }
  /**
   * The API base this transport was pointed at, when it says something the
   * host's own routing does not. The public base is where the CLI sends a
   * github.com request anyway, so naming it resolves nothing a host name does
   * not, and a transport pointed at it is left to name the host as before.
   */
  private get configuredBase(): string | null {
    const base = this.options.apiUrl?.replace(/\/+$/u, '') ?? configuredGitHubApiUrl(this.env)
    return base === null || base === GITHUB_API_URL ? null : base
  }
  private get apiUrl(): string {
    return this.configuredBase ?? GITHUB_API_URL
  }

  /**
   * The environment every `gh` child of this transport runs with.
   *
   * The authority, the request and the credential lookup all read this one
   * environment rather than the partial one the options carry: the children
   * inherit the process environment and are then scoped to the host these
   * requests authenticate as, so a credential the caller did not supply can be
   * the one the CLI actually uses. An authority derived from the partial
   * environment would fence rows on a token the child never sees, and a
   * credential replaced in the inherited one would not retire them.
   */
  private get childEnvironment(): Record<string, string> {
    return {
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...hostScopedEnvironment({ ...process.env, ...this.options.env }, this.destinationHost),
    }
  }

  private async api(
    args: string[],
    request: GitHubGraphqlOptions,
    input?: string,
    /** A snapshot the caller already resolved, so one request resolves it once. */
    pinned?: GitHubCliSnapshot,
  ): Promise<{ status: number; headers: Headers; body: unknown; authority: string }> {
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

    try {
      const initiatedAt = observationClock()
      const { authority, environment } =
        pinned ?? (await this.credentialSnapshot({ signal: controller.signal, timeoutMs }))
      if (request.signal?.aborted)
        throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
      if (timedOut)
        throw new GitHubTransportError({
          kind: 'timeout',
          detail: `request did not complete within ${timeoutMs}ms`,
        })
      if (controller.signal.aborted)
        throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
      const run =
        this.options.run ??
        (async (argv: string[], options: GitHubGraphqlOptions & { input?: string }) => {
          const child = execFile('gh', argv, {
            cwd: process.cwd(),
            // The same environment the credential lookup and the authority read,
            // so what the CLI sends is what this transport fenced its rows on.
            env: environment,
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
        output = await run(args, { signal: controller.signal, timeoutMs, input })
      } catch (error) {
        if (timedOut)
          throw new GitHubTransportError({
            kind: 'timeout',
            detail: `request did not complete within ${timeoutMs}ms`,
          })
        if (request.signal?.aborted || controller.signal.aborted)
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
      if (request.signal?.aborted || controller.signal.aborted)
        throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
      const response = includedResponse(output)
      const rateLimit = parseRateLimit(response.headers)
      if (response.status === 304) {
        publishRateLimit(rateLimit, null, this.destinationHost, authority, initiatedAt)
        return { status: 304, headers: response.headers, body: null, authority }
      }
      if (response.status < 200 || response.status >= 300) {
        const failure = new GitHubTransportError({
          kind: statusKind(response.status, rateLimit, apiMessage(response.body)),
          status: response.status,
          detail: apiMessage(response.body) ?? 'request failed',
          rateLimit,
          body: response.body,
          authority,
        })
        publishRateLimit(rateLimit, failure.kind, this.destinationHost, authority, initiatedAt)
        throw failure
      }
      publishRateLimit(rateLimit, null, this.destinationHost, authority, initiatedAt)
      return { ...response, authority }
    } catch (error) {
      if (request.signal?.aborted)
        throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
      if (timedOut)
        throw new GitHubTransportError({
          kind: 'timeout',
          detail: `request did not complete within ${timeoutMs}ms`,
        })
      if (error instanceof GitHubTransportError) {
        throw error
      }
      if (controller.signal.aborted)
        throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
      throw new GitHubTransportError({
        kind: 'network',
        detail: commandDetail(error),
      })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', forward)
    }
  }

  private async request<T>(
    request: GitHubRestRequest,
    pinned?: GitHubCliSnapshot,
  ): Promise<{
    status: number
    data: T
    headers: Headers
    rateLimit: GitHubRateLimit
    authority: string
  }> {
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
    const configuredBase = this.configuredBase
    const isAbsolute = /^https?:\/\//u.test(request.path)
    // The endpoint this request will actually reach, which is not always the
    // path the caller wrote: a configured base is prepended to a relative one,
    // and that base is what decides the host. Resolving the destination first
    // and fencing that keeps the CLI, the credential scope and the allowance
    // bucket on the host the request is really for, whichever form it took.
    const endpoint = isAbsolute
      ? request.path
      : configuredBase === null
        ? request.path
        : `${configuredBase}/${request.path.replace(/^\/+/u, '')}`
    // `gh` is told which host it is talking to, so a session authenticated for
    // github.com is never asked for a host this app is not serving. It is told
    // only when the endpoint is relative and the CLI has to resolve the host
    // itself; an absolute endpoint addresses its host in place of that flag.
    if (!isAbsolute && configuredBase === null) {
      args.splice(1, 0, '--hostname', this.destinationHost)
    }
    // An absolute endpoint — and every endpoint under a configured base, which
    // this one now is — sends this host's credential to the host that serves
    // it. One outside the host this transport authenticates as would send that
    // credential somewhere this read is not fenced to, so it is refused before
    // anything is requested or attempted.
    if (isAbsolute || configuredBase !== null) {
      const destination = gitHubHostOfEndpoint(endpoint)
      if (destination !== null && destination !== this.destinationHost) {
        throw new GitHubTransportError({
          kind: 'unsupported',
          detail: `${destination} is not a host this transport authenticates as, so the request was not attempted`,
        })
      }
    }
    if (method !== 'GET') args.push('--method', method)
    args.push(endpoint)
    const input = request.body === undefined ? undefined : JSON.stringify(request.body)
    if (input !== undefined) args.push('--header', 'Content-Type: application/json', '--input', '-')
    const { status, headers, body, authority } = await this.api(args, request, input, pinned)
    return { status, data: body as T, headers, rateLimit: parseRateLimit(headers), authority }
  }

  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    // The credential this request will carry is part of the cache identity. A
    // body read as one account is not this account's answer to ask again, and a
    // validator recorded for one credential must never be replayed against the
    // credential that replaced it — including a replacement made outside this
    // app, in the CLI itself, between two refreshes. Resolved before the cache is
    // consulted, and handed to the request that follows, so one read of the
    // credential serves both.
    const cache = request.cache === true ? this.options.cache : undefined
    const snapshot: GitHubCliSnapshot | null =
      cache === undefined
        ? null
        : await this.credentialSnapshot({
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          })
    const key = snapshot ? conditionalCacheKey(request, snapshot.authority) : null
    const cached: CachedGitHubResponse | null = key === null ? null : cache?.get(key) ?? null
    const conditional =
      key === null
        ? request
        : { ...request, headers: { ...request.headers, ...conditionalHeaders(cached) } }
    const { status, data, headers, rateLimit, authority } = await this.request<T>(
      conditional,
      snapshot ?? undefined,
    )
    if (status === 304) {
      // A mutation opting in to 304 is documented to answer as "no change", and
      // callers that did not opt in treat an unexpected 304 as an error. A
      // conditional GET keeps the requirement it always had.
      const method = request.method ?? 'GET'
      if (!cached && method !== 'GET' && request.acceptNoChange === true) {
        return { status, data: null as T, headers, rateLimit, notModified: true }
      }
      if (!cached)
        throw new GitHubTransportError({
          status,
          kind: 'invalid-response',
          detail: 'GitHub answered 304 without a stored response',
          rateLimit,
        })
      return { status, data: cached.body as T, headers, rateLimit, notModified: true, authority }
    }
    const etag = headers.get('etag')
    const lastModified = headers.get('last-modified')
    // A response the caller has already abandoned is not this caller's to
    // record: pairing an old body with the validator in force after it would
    // make the next legitimate 304 replay an incomplete list.
    if (
      cache &&
      key &&
      (request.method ?? 'GET') === 'GET' &&
      (etag || lastModified) &&
      !request.signal?.aborted
    ) {
      cache.set(key, { etag, lastModified, body: data, storedAt: new Date() })
    }
    return { status, data, headers, rateLimit, authority }
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
    return graphqlData<T>(
      response.data,
      response.status,
      response.rateLimit,
      response.authority,
      (limit, kind) => publishRateLimit(limit, kind, this.destinationHost, response.authority),
    )
  }

  /**
   * The authority `gh` itself would authenticate with for this host.
   *
   * When this build hands `gh` a token, the credential is the one this process
   * already resolved, and the environment identity is the whole of it. When it
   * does not, every request is made by whatever credential the CLI holds for the
   * host those requests name — and a credential replaced outside this app, which
   * no account status and no environment variable can see, is exactly the
   * replacement that must retire rows.
   */
  async credentialAuthority(options: GitHubGraphqlOptions = {}): Promise<string> {
    return (await this.credentialSnapshot(options)).authority
  }

  /** Resolve once: the API child must use the material its observation names. */
  private async credentialSnapshot(
    options: GitHubGraphqlOptions,
  ): Promise<GitHubCliSnapshot> {
    const host = this.destinationHost
    const environment = this.childEnvironment
    const own = githubHostCredentialIdentity(host, environment)
    const ambient = resolveGitHubToken(environment, host)
    if (ambient !== null) return { authority: own, environment }
    const material = await this.cliCredentialMaterial(host, options)
    if (material !== null) environment[credentialEnvNames(host)[0]] = material
    const digest =
      material === null
        ? credentialDigest(`gh-unavailable\u0000${host}`)
        : credentialDigest(`gh\u0000${host}\u0000${material}`)
    return { authority: `${own}\u0000${digest}`, environment }
  }

  /** The CLI's material remains private and is pinned only to its API child. */
  private async cliCredentialMaterial(
    host: string,
    options: GitHubGraphqlOptions = {},
  ): Promise<string | null> {
    if (options.signal?.aborted) {
      throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
    }
    const args = ['auth', 'token', '--hostname', host]
    const run = this.options.run
    let output: string | undefined
    try {
      output = run === undefined ? await this.execGh(args, options) : await run(args, options)
    } catch (error) {
      if (options.signal?.aborted) {
        throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
      }
      return null
    }
    if (options.signal?.aborted) {
      throw new GitHubTransportError({ kind: 'cancelled', detail: 'the request was cancelled' })
    }
    const material = typeof output === 'string' ? output.trim() : ''
    return material === '' ? null : material
  }

  /** The same child-process shape `api` uses, without the response plumbing. */
  private execGh(args: string[], options: GitHubGraphqlOptions = {}): Promise<string> {
    const child = execFile('gh', args, {
      cwd: process.cwd(),
      env: this.childEnvironment,
      timeout: options.timeoutMs ?? GITHUB_TIMEOUT_MS,
      signal: options.signal,
      shell: false,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    })
    return child.then((result) => result.stdout)
  }
}

/**
 * The public API origin, which a transport built without a named host serves.
 */
export const GITHUB_CREDENTIAL_ORIGIN = githubApiOriginForHost(GITHUB_HOST)

/**
 * One resolved look at the credential a `gh` child will authenticate with: the
 * opaque identity that credential is fenced on, and the child environment that
 * hands it to exactly one API process. The material itself never appears here.
 */
export interface GitHubCliSnapshot {
  authority: string
  environment: Record<string, string>
}

let installed: GitHubTransport | null = null
const installedByHost = new Map<string, GitHubTransport>()
let cached: { key: string; transport: GitHubTransport } | null = null

/**
 * Install a transport for the current process. Tests and integration diagnostics use
 * this; the renderer has no path to it, so no token or HTTP capability crosses the bridge.
 *
 * Whatever was installed before is returned rather than discarded. A caller that
 * installed a transport of its own has to be able to put the previous one back, and
 * `githubTransport()` cannot tell it: that function answers with a transport resolved
 * from the environment when nothing is installed, so reading it after a teardown would
 * hand back a different object and leave the process holding somebody else's.
 */
export function setGitHubTransport(transport: GitHubTransport | null): GitHubTransport | null {
  const previous = installed
  installed = transport
  return previous
}

/**
 * The transport installed in this process, or null when nothing is.
 *
 * `githubTransport()` cannot answer this: it resolves a transport from the environment
 * when nothing is installed, so it never returns null and it returns a different object
 * from the one that was installed. A caller that installed a transport of its own
 * therefore has no way to ask "is mine still the one in place?" — and without that
 * question its teardown is a blind overwrite: if something else installed a transport
 * after it, putting its own previous value back silently removes that other owner's
 * transport and reports a clean process.
 *
 * This returns the slot itself, so the answer can be compared by identity. It exists
 * for that comparison and for nothing else; a caller that wants a usable transport asks
 * `githubTransport()`.
 */
export function installedGitHubTransport(): GitHubTransport | null {
  return installed
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

/**
 * The transport for the default host, always the GitHub CLI.
 *
 * There is no preference to read and no fallback to fall back to: GitHub
 * collaboration requires an installed, authenticated `gh`, and a process with
 * no authenticated CLI has no GitHub work to do rather than another way to do
 * it.
 */
export function githubTransport(env: NodeJS.ProcessEnv = process.env): GitHubTransport {
  if (installed) return installed
  // The endpoints this process was configured for are part of the identity of
  // the transport that serves them, so a changed base or API version builds a
  // new one instead of reusing the transport another configuration made.
  const key = `${githubApiUrl(env)}:${githubApiVersion(env)}`
  if (cached?.key === key) return cached.transport
  if (cached) responseCache.clear()
  const transport: GitHubTransport = new GhGitHubTransport({ env, cache: responseCache })
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
  const cacheKey = `${key}:${apiBase}:${graphqlUrl ?? ''}:${githubApiVersion(env)}`
  if (cached?.key === cacheKey) return cached.transport
  const transport: GitHubTransport = new GhGitHubTransport({
    env,
    host: key,
    apiUrl: apiBase,
    cache: responseCache,
    ...(graphqlUrl ? { graphqlUrl } : {}),
  })
  cached = { key: cacheKey, transport }
  return transport
}

