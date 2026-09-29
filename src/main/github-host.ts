import { isRecord, type ParsedRemote } from './git-core'
import {
  GITHUB_API_VERSION,
  GITHUB_STACKS_API_VERSION,
  GitHubTransportError,
  githubApiVersion,
  githubTransportForHost,
  type GitHubTransport,
} from './github-transport'
import { CAPABILITY_LABELS, type GitHubCapability, type GitHubHostStatus } from '../shared/host'
import type { GitHubCapabilityId, GitHubCapabilityState } from '../shared/host'

/** The public host. It is the default, and it behaves exactly as it always has. */
export const GITHUB_DOTCOM_HOST = 'github.com'
export const GITHUB_DOTCOM_WEB_ORIGIN = 'https://github.com'
export const GITHUB_DOTCOM_API_BASE = 'https://api.github.com'
/** REST root every GitHub API answers, used to establish that an origin is GitHub. */
const GITHUB_ROOT_PATH = ''

/**
 * One label of a host name. A host is never an arbitrary origin: only a name
 * and an optional port are accepted here, and both the web and API origins are
 * derived from the name, so a typed value can never carry a scheme, a path,
 * credentials, or a second host.
 */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u
const MAX_HOST_LENGTH = 253
const MAX_LABEL_LENGTH = 63

/**
 * Everything one GitHub host owns: where its web pages live, where its REST and
 * GraphQL endpoints are, and which API versions this build speaks there. A host
 * is resolved before any request, so a repository on one host is never answered
 * by another host's API.
 */
export interface GitHubHostContext {
  /** Host name as it is compared, including a port when the host has one. */
  host: string
  dotcom: boolean
  webOrigin: string
  apiBase: string
  graphqlUrl: string
}

/** The host a person configured, or the refusal naming why it was refused. */
export type GitHubHostInput =
  | { ok: true; host: string }
  | { ok: false; message: string }

const REFUSE = (message: string): GitHubHostInput => ({ ok: false, message })

/**
 * Validates what a person typed into the host setting. Empty means github.com.
 * Everything the value becomes — the web origin, the API base, the GraphQL
 * endpoint — is derived from the name afterwards, so nothing typed here can point
 * the app at an arbitrary origin or escape over a scheme other than HTTPS.
 */
export function validateGitHubHostInput(value: unknown): GitHubHostInput {
  if (value === null || value === undefined) return { ok: true, host: '' }
  if (typeof value !== 'string') {
    return REFUSE('must be a host name such as github.com or ghe.example.com')
  }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, host: '' }

  let candidate = trimmed.replace(/^https:\/\//iu, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) {
    return REFUSE('must be a host name, not a URL with a scheme other than https')
  }
  if (candidate.includes('@')) {
    return REFUSE('must not contain a user name or password')
  }
  if (candidate.includes('?') || candidate.includes('#')) {
    return REFUSE('must not contain a query string or fragment')
  }
  if (/\s/u.test(candidate) || /[\\^`"']/u.test(candidate)) {
    return REFUSE('must not contain spaces or quoting characters')
  }
  candidate = candidate.replace(/\/+$/u, '')
  if (candidate.includes('/')) {
    return REFUSE('must be a host name without a path')
  }

  const colon = candidate.lastIndexOf(':')
  let port = ''
  if (colon >= 0) {
    port = candidate.slice(colon + 1)
    if (!/^\d{1,5}$/u.test(port)) {
      return REFUSE('must be a host name with an optional numeric port')
    }
    const number = Number(port)
    if (number < 1 || number > 65_535) {
      return REFUSE('port must be between 1 and 65535')
    }
    candidate = candidate.slice(0, colon)
  }

  const host = candidate.toLowerCase().replace(/\.$/u, '')
  if (!host) return REFUSE('must be a host name such as github.com or ghe.example.com')
  if (host.length > MAX_HOST_LENGTH) {
    return REFUSE(`must be at most ${MAX_HOST_LENGTH} characters`)
  }
  const labels = host.split('.')
  if (labels.some((label) => !label || label.length > MAX_LABEL_LENGTH || !HOST_LABEL.test(label))) {
    return REFUSE('must be a host name such as github.com or ghe.example.com')
  }
  if (host === GITHUB_DOTCOM_HOST && port && port !== '443') {
    return REFUSE('github.com does not take a port; leave it empty')
  }
  return { ok: true, host: port ? `${host}:${port}` : host }
}

/** The transport that speaks for one host, and for no other. */
export function hostTransport(
  context: GitHubHostContext,
  env: NodeJS.ProcessEnv = process.env,
): GitHubTransport {
  return githubTransportForHost(context.host, context.apiBase, env)
}

/** Where a GitHub host's web pages, REST API, and GraphQL endpoint live. */
export function githubHostContext(host: string): GitHubHostContext {
  const name = host.trim().toLowerCase()
  const dotcom = name === GITHUB_DOTCOM_HOST
  const webOrigin = dotcom ? GITHUB_DOTCOM_WEB_ORIGIN : `https://${name}`
  const apiBase = dotcom ? GITHUB_DOTCOM_API_BASE : `${webOrigin}/api/v3`
  return { host: name, dotcom, webOrigin, apiBase, graphqlUrl: `${apiBase}/graphql` }
}

/**
 * The context for a repository's own origin remote. A remote whose host is not
 * a usable GitHub host name yields null, so the caller reports the host it found
 * instead of talking to some other host.
 */
export function remoteHostContext(remote: ParsedRemote | null): GitHubHostContext | null {
  if (!remote) return null
  const parsed = validateGitHubHostInput(remote.host)
  return parsed.ok ? githubHostContext(parsed.host) : null
}

/** The context for the host this app is configured to work against. */
export function configuredHostContext(value: unknown): GitHubHostContext {
  const parsed = validateGitHubHostInput(value)
  return githubHostContext(parsed.ok && parsed.host ? parsed.host : GITHUB_DOTCOM_HOST)
}

/**
 * The stacks resource is only served on the preview API version, so the header
 * is built when a request is made rather than at module load: a module graph
 * that reaches this file first must not depend on load order.
 */
function stacksHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_STACKS_API_VERSION,
  }
}

/** What a native stacks probe established about one repository. */
export type NativeStackCapabilityReason =
  | 'available'
  | 'endpoint-missing'
  | 'repository-missing'
  | 'unauthenticated'
  | 'unreachable'
  | 'rejected'

export interface NativeStackCapability {
  available: boolean
  reason: NativeStackCapabilityReason
  /** True only when this host answered the stacks resource for this repository. */
  message: string
}

interface ProbeOutcome {
  state: GitHubCapabilityState
  detail: string
}

/**
 * Turns a refusal into what it actually was. A credential this build cannot
 * supply, and a host that never answered, are both reported as what they are:
 * neither is evidence that the host lacks the capability.
 */
function outcomeFromError(error: unknown): ProbeOutcome {
  if (error instanceof GitHubTransportError) {
    switch (error.kind) {
      case 'unauthorized':
      case 'forbidden':
        return {
          state: 'unauthenticated',
          detail: `this host refused the credential (${error.detail})`,
        }
      case 'network':
      case 'timeout':
        return { state: 'unreachable', detail: `this host did not answer (${error.detail})` }
      case 'not-found':
      case 'unsupported':
        return { state: 'unsupported', detail: `this host does not offer it (${error.detail})` }
      case 'unprocessable':
        return { state: 'unsupported', detail: `this host rejected the request (${error.detail})` }
      case 'rate-limited':
      case 'secondary-rate-limit':
        return { state: 'unknown', detail: `rate limited (${error.detail})` }
      case 'cancelled':
        return { state: 'unknown', detail: 'the request was cancelled' }
      default:
        return { state: 'unknown', detail: error.detail }
    }
  }
  return { state: 'unknown', detail: error instanceof Error ? error.message : String(error) }
}

/**
 * Whether this host serves the native stacked pull requests resource for one
 * repository. The repository itself is read first, so a missing repository is
 * never reported as a host without the endpoint. Display refreshes may use
 * validators; mutation preflights leave conditional unset.
 */
export async function probeNativeStacksCapability(
  owner: string,
  name: string,
  options: { transport: GitHubTransport; signal?: AbortSignal; conditional?: boolean },
): Promise<NativeStackCapability> {
  const { transport } = options
  const signal = options.signal ? { signal: options.signal } : {}
  try {
    await transport.rest({
      path: `repos/${owner}/${name}`,
      cache: options.conditional === true,
      ...signal,
    })
  } catch (error) {
    if (error instanceof GitHubTransportError && (error.status === 404 || error.kind === 'not-found')) {
      return {
        available: false,
        reason: 'repository-missing',
        message: `${owner}/${name} was not found on this host`,
      }
    }
    const outcome = outcomeFromError(error)
    return {
      available: false,
      reason: outcome.state === 'unreachable' ? 'unreachable' : 'unauthenticated',
      message: outcome.detail,
    }
  }
  try {
    const response = await transport.rest({
      method: 'GET',
      path: `repos/${owner}/${name}/stacks?per_page=1`,
      headers: stacksHeaders(),
      cache: options.conditional === true,
      ...signal,
    })
    if (response.notModified === true || (response.status >= 200 && response.status < 300)) {
      return {
        available: true,
        reason: 'available',
        message: 'This host serves native stacked pull requests for this repository.',
      }
    }
    return {
      available: false,
      reason: response.status === 404 ? 'endpoint-missing' : 'rejected',
      message: `the stacked pull requests resource answered ${response.status}`,
    }
  } catch (error) {
    if (error instanceof GitHubTransportError && (error.status === 404 || error.kind === 'not-found')) {
      return {
        available: false,
        reason: 'endpoint-missing',
        message: 'This host does not serve the native stacked pull requests resource.',
      }
    }
    const outcome = outcomeFromError(error)
    return {
      available: false,
      reason:
        outcome.state === 'unreachable'
          ? 'unreachable'
          : outcome.state === 'unauthenticated'
            ? 'unauthenticated'
            : 'rejected',
      message: outcome.detail,
    }
  }
}

/** One host's last established capability state, rebuilt from probes and use. */
interface HostRecord {
  probedAt: string | null
  serverVersion: string | null
  state: GitHubCapabilityState
  message: string
  capabilities: Map<GitHubCapabilityId, GitHubCapability>
}

const records = new Map<string, HostRecord>()

function record(host: string): HostRecord {
  const key = host.toLowerCase()
  const existing = records.get(key)
  if (existing) return existing
  const created: HostRecord = {
    probedAt: null,
    serverVersion: null,
    state: 'unknown',
    message: 'This host has not been checked yet.',
    capabilities: new Map(),
  }
  records.set(key, created)
  return created
}

/**
 * Records what a real request established about a host. Every caller that talks
 * to a host reports what it saw, so the matrix reflects observed behaviour
 * between explicit probes rather than only what a probe happened to cover.
 */
export function observeHostCapability(host: string, capability: GitHubCapability): void {
  record(host).capabilities.set(capability.id, capability)
}

/** Records what a probe established about the host as a whole. */
export function recordHostProbe(status: GitHubHostStatus): void {
  const entry = record(status.host)
  entry.probedAt = status.probedAt
  entry.serverVersion = status.serverVersion
  entry.state = status.state
  entry.message = status.message
  for (const capability of status.capabilities) {
    entry.capabilities.set(capability.id, capability)
  }
}

/** Drops everything remembered about one host, or about all of them. */
export function forgetHost(host?: string): void {
  if (host) records.delete(host.toLowerCase())
  else records.clear()
}

function unprobedCapability(id: GitHubCapabilityId): GitHubCapability {
  return {
    id,
    label: CAPABILITY_LABELS[id],
    state: 'unknown',
    detail: 'This has not been checked against this host yet.',
  }
}

/**
 * The capability matrix for one host, assembled from what is configured and
 * what has actually been observed. It never runs a request: what it reports is
 * what a probe or a real call established.
 */
export function hostStatus(
  context: GitHubHostContext,
  env: NodeJS.ProcessEnv = process.env,
): GitHubHostStatus {
  const entry = records.get(context.host)
  const capabilities: GitHubCapability[] = []
  for (const id of [
    'rest',
    'graphql',
    'native-stacks',
    'repository-discovery',
    'device-sign-in',
  ] as const) {
    const known = entry?.capabilities.get(id) ?? unprobedCapability(id)
    if (id === 'device-sign-in') capabilities.push(deviceSignInCapability(context, env))
    else capabilities.push(known)
  }
  return {
    host: context.host,
    kind: context.dotcom ? 'github.com' : 'enterprise',
    webOrigin: context.webOrigin,
    apiBase: context.apiBase,
    graphqlUrl: context.graphqlUrl,
    apiVersion: githubApiVersion(env),
    stacksApiVersion: GITHUB_STACKS_API_VERSION,
    serverVersion: entry?.serverVersion ?? null,
    state: entry?.state ?? 'unknown',
    message: entry?.message ?? 'This host has not been checked yet.',
    probedAt: entry?.probedAt ?? null,
    capabilities,
  }
}

/**
 * Whether this build can sign a person in to the host, said as it is. Device
 * sign-in is a github.com registration this build carries; no other host is
 * claimed, so an enterprise host reports what it can actually be used with.
 */
function deviceSignInCapability(
  context: GitHubHostContext,
  env: NodeJS.ProcessEnv,
): GitHubCapability {
  const detail = context.dotcom
    ? 'GitHub App device sign-in is available for github.com in this build.'
    : `This build signs in to github.com only. ${context.host} is used with a credential supplied by the environment or an authenticated gh session.`
  if (!context.dotcom) {
    return { id: 'device-sign-in', label: CAPABILITY_LABELS['device-sign-in'], state: 'unsupported', detail }
  }
  const clientId = env.GIT_STACKS_GITHUB_APP_CLIENT_ID
  if (typeof clientId !== 'string' || !clientId.trim()) {
    return {
      id: 'device-sign-in',
      label: CAPABILITY_LABELS['device-sign-in'],
      state: 'not-configured',
      detail: 'No GitHub App client id is configured for this build.',
    }
  }
  return { id: 'device-sign-in', label: CAPABILITY_LABELS['device-sign-in'], state: 'supported', detail }
}

export interface HostProbeOptions {
  /** The transport to probe with; it defaults to this host's own transport. */
  transport?: GitHubTransport
  signal?: AbortSignal
  /** A repository on this host, so native stacks can be established for it. */
  repository?: { owner: string; name: string } | null
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

/**
 * Asks a host what it supports and records the answers. Every refusal is mapped
 * to what it was: an unsupported endpoint, a credential this build cannot
 * supply, and a host that never answered stay three different states, so an
 * unreachable host is never mistaken for one without a feature.
 */
export async function probeGitHubHost(
  context: GitHubHostContext,
  options: HostProbeOptions = {},
): Promise<GitHubHostStatus> {
  const env = options.env ?? process.env
  const transport = options.transport ?? githubTransportForHost(context.host, context.apiBase, env)
  const signal = options.signal ? { signal: options.signal } : {}
  const capabilities: GitHubCapability[] = []
  const set = (id: GitHubCapabilityId, outcome: ProbeOutcome) =>
    capabilities.push({ id, label: CAPABILITY_LABELS[id], state: outcome.state, detail: outcome.detail })

  let state: GitHubCapabilityState = 'unknown'
  let message = 'This host has not answered a capability request yet.'
  let serverVersion: string | null = null

  try {
    await transport.rest({ path: GITHUB_ROOT_PATH, ...signal })
    set('rest', { state: 'supported', detail: `${context.apiBase} answered a REST request` })
    set('repository-discovery', {
      state: 'supported',
      detail: 'Repository discovery uses this host’s REST base.',
    })
    state = 'supported'
    message = `${context.host} answered at ${context.apiBase}.`
  } catch (error) {
    const outcome = outcomeFromError(error)
    set('rest', outcome)
    set('repository-discovery', outcome)
    state = outcome.state
    message = outcome.detail
  }

  if (state === 'supported') {
    serverVersion = await readServerVersion(transport, signal)
  }

  try {
    await transport.graphql('{ __typename }', {}, signal)
    set('graphql', {
      state: 'supported',
      detail: `${context.graphqlUrl} answered a GraphQL request`,
    })
  } catch (error) {
    set('graphql', outcomeFromError(error))
  }

  const repository = options.repository ?? null
  if (repository) {
    const stacks = await probeNativeStacksCapability(repository.owner, repository.name, {
      transport,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const stacksState: GitHubCapabilityState =
      stacks.reason === 'available'
        ? 'supported'
        : stacks.reason === 'endpoint-missing'
          ? 'unsupported'
          : stacks.reason === 'repository-missing'
            ? 'unknown'
            : stacksStateForReason(stacks.reason)
    set('native-stacks', { state: stacksState, detail: stacks.message })
  } else {
    set('native-stacks', {
      state: 'unknown',
      detail: 'Open a repository on this host to establish native stack support.',
    })
  }

  const status: GitHubHostStatus = {
    ...hostStatus(context, env),
    state,
    message,
    serverVersion,
    probedAt: (options.now ?? (() => new Date()))().toISOString(),
    capabilities: capabilities.map((capability) =>
      capability.id === 'device-sign-in' ? deviceSignInCapability(context, env) : capability,
    ),
  }
  recordHostProbe(status)
  return status
}

function stacksStateForReason(reason: NativeStackCapabilityReason): GitHubCapabilityState {
  if (reason === 'unreachable') return 'unreachable'
  if (reason === 'unauthenticated') return 'unauthenticated'
  return 'unknown'
}

/**
 * The version a host reports about itself. GitHub Enterprise Server answers with
 * `installed_version`; github.com does not report one, and a host that reports
 * none is reported as unknown rather than as any particular version.
 */
async function readServerVersion(
  transport: GitHubTransport,
  signal: { signal?: AbortSignal },
): Promise<string | null> {
  try {
    const { data } = await transport.rest<unknown>({ path: 'meta', ...signal })
    if (isRecord(data) && typeof data.installed_version === 'string' && data.installed_version) {
      return data.installed_version
    }
  } catch {
    // A host that does not answer /meta has not told this build its version.
  }
  return null
}
