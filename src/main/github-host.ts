import { canonicalHostName } from '../shared/host'
import { isCancelled, isRecord, type ParsedRemote } from './git-core'
import {
  GITHUB_API_VERSION,
  GITHUB_STACKS_API_VERSION,
  GitHubTransportError,
  githubApiUrl,
  githubApiVersion,
  githubTransportForHost,
  type GitHubTransport,
} from './github-transport'
import { githubAppClientId, githubAppClientIdEnvName } from './github-app'
import {
  CAPABILITY_IDS,
  CAPABILITY_LABELS,
  type GitHubCapability,
  type GitHubHostStatus,
} from '../shared/host'
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
  /**
   * The same host without its web port, for Git's SSH transport. A web port is
   * not an SSH port: a host served from 8443 is not answered on 8443 over SSH,
   * so no SSH remote this build writes carries one.
   */
  sshHost: string
  dotcom: boolean
  webOrigin: string
  apiBase: string
  graphqlUrl: string
}

/** The host a person configured, or the refusal naming why it was refused. */
export type GitHubHostInput = { ok: true; host: string } | { ok: false; message: string }

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
  if (
    labels.some((label) => !label || label.length > MAX_LABEL_LENGTH || !HOST_LABEL.test(label))
  ) {
    return REFUSE('must be a host name such as github.com or ghe.example.com')
  }
  if (host === GITHUB_DOTCOM_HOST && port && port !== '443') {
    return REFUSE('github.com does not take a port; leave it empty')
  }
  // Every origin this app builds is HTTPS, and 443 is what it uses when no port
  // is named. Keeping `:443` would make the same host two hosts: a different
  // credential scope, a different cache key, and a different origin check.
  return { ok: true, host: port && port !== '443' ? `${host}:${port}` : host }
}

/** The transport that speaks for one host, and for no other. */
export function hostTransport(
  context: GitHubHostContext,
  env: NodeJS.ProcessEnv = process.env,
): GitHubTransport {
  // A host whose GraphQL endpoint is its REST base plus `/graphql` — github.com
  // is the only one — is left to the transports' own default, so nothing about
  // that host's requests changes. Only a host that serves GraphQL from a path
  // of its own is named, and it is named by that path.
  //
  // The public host's base is also the one an operator can point elsewhere.
  // Resolving it per host from the name alone discarded that setting and sent
  // every request to the public API instead, so the base is read from the
  // environment and GraphQL follows it, one path below the same base.
  const apiBase = context.dotcom ? githubApiUrl(env) : context.apiBase
  const graphqlUrl =
    context.dotcom && apiBase !== context.apiBase
      ? `${apiBase}/graphql`
      : context.graphqlUrl === `${context.apiBase}/graphql`
        ? undefined
        : context.graphqlUrl
  return githubTransportForHost(context.host, apiBase, env, graphqlUrl)
}

/** Where a GitHub host's web pages, REST API, and GraphQL endpoint live. */
export function githubHostContext(host: string): GitHubHostContext {
  const name = canonicalHostName(host)
  const dotcom = name === GITHUB_DOTCOM_HOST
  const webOrigin = dotcom ? GITHUB_DOTCOM_WEB_ORIGIN : `https://${name}`
  const apiBase = dotcom ? GITHUB_DOTCOM_API_BASE : `${webOrigin}/api/v3`
  // An enterprise host serves REST from `/api/v3` and GraphQL from `/api/graphql`;
  // github.com serves both from its API subdomain. Neither is derived from the other.
  const graphqlUrl = dotcom ? `${apiBase}/graphql` : `${webOrigin}/api/graphql`
  const colon = name.lastIndexOf(':')
  return {
    host: name,
    sshHost: colon === -1 ? name : name.slice(0, colon),
    dotcom,
    webOrigin,
    apiBase,
    graphqlUrl,
  }
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

/** Said once, wherever a link is refused, so the gate has a single voice. */
export const EXTERNAL_LINK_REFUSAL = 'Only HTTPS links on a configured GitHub host can be opened.'

/** A link this installation is willing to hand to the operating system. */
export type ExternalGitHubLink = { ok: true; href: string } | { ok: false; message: string }

const REFUSE_LINK: ExternalGitHubLink = {
  ok: false,
  message: EXTERNAL_LINK_REFUSAL,
}

/**
 * Decides whether a link may be opened outside the app.
 *
 * Trust is never read off the link. A value is opened only when it is HTTPS,
 * carries no credentials, names a usable GitHub host, and that host is one this
 * installation already speaks to — the public host, the host the person
 * configured, or the host that owns the open repository's own origin. The host
 * is compared whole, port included and nothing else relaxed, so a foreign host,
 * a look-alike that merely ends in a trusted name, and a configured enterprise
 * host reached on a different port are all refused, while that host's own
 * links — on the port it was configured with — keep working.
 */
export function externalGitHubLink(
  value: unknown,
  trusted: readonly GitHubHostContext[],
): ExternalGitHubLink {
  if (typeof value !== 'string' || !value) return REFUSE_LINK
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return REFUSE_LINK
  }
  if (url.protocol !== 'https:' || url.username || url.password) return REFUSE_LINK
  // The host has to be one this build can name at all before any comparison
  // against a trusted host means anything: `url.host` is the parsed name, port
  // included, so it is the same string a host context carries.
  if (!validateGitHubHostInput(url.host).ok) return REFUSE_LINK
  if (url.host !== GITHUB_DOTCOM_HOST && !trusted.some((context) => context.host === url.host)) {
    return REFUSE_LINK
  }
  return { ok: true, href: url.href }
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
  | 'not-configured'

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
 * The GraphQL fields this build sends. A refusal that names one of these is a
 * fact about the host's schema; a refusal that names anything else is a
 * sentence this build did not write, and is not repeated anywhere it is stored.
 */
const QUERIED_FIELD_NAMES = new Set([
  'assignees',
  'author',
  'baseRefName',
  'body',
  'changedFilesIfAvailable',
  'closed',
  'commits',
  'createdAt',
  'databaseId',
  'headRefName',
  'headRefOid',
  'isCrossRepository',
  'isDraft',
  'labels',
  'mergeable',
  'mergeStateStatus',
  'merged',
  'mergedAt',
  'number',
  'oid',
  'repository',
  'reviewDecision',
  'state',
  'statusCheckRollup',
  'title',
  'updatedAt',
  'url',
])

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
        return { state: 'unauthenticated', detail: 'this host refused the credential' }
      case 'network':
      case 'timeout':
        return { state: 'unreachable', detail: 'this host did not answer' }
      case 'not-configured':
        // A missing local tool or an absent transport is this machine's setup.
        // No host was contacted, so nothing can be concluded about the host.
        return {
          state: 'not-configured',
          detail: 'this machine has no configured way to ask a host',
        }
      case 'not-found':
      case 'unsupported':
        return { state: 'unsupported', detail: 'this host does not offer this resource' }
      case 'unprocessable':
        return { state: 'unsupported', detail: 'this host rejected the request' }
      case 'rate-limited':
      case 'secondary-rate-limit':
        return { state: 'unknown', detail: 'this host is rate limiting this credential' }
      case 'cancelled':
        return { state: 'unknown', detail: 'the request was cancelled' }
      case 'invalid-response': {
        // A schema that does not carry a field this build queries is a fact
        // about the host worth naming — but the identifier is only ever
        // reported when it is one this build actually sends. A server that
        // answers with any wording at all can put anything in that position, so
        // an unrecognised name is dropped rather than copied into a
        // diagnostic, a capability, or a support bundle.
        const named = QUERIED_FIELD_NAMES.has(
          /cannot query field ["']([A-Za-z_][A-Za-z0-9_]{0,63})["']/iu.exec(error.detail)?.[1] ??
            '',
        )
          ? /cannot query field ["']([A-Za-z_][A-Za-z0-9_]{0,63})["']/iu.exec(error.detail)?.[1]
          : QUERIED_FIELD_NAMES.has(
                /field ["']?([A-Za-z_][A-Za-z0-9_]{0,63})["']? (?:is )?(?:not|doesn'?t) exist/iu.exec(
                  error.detail,
                )?.[1] ?? '',
              )
            ? /field ["']?([A-Za-z_][A-Za-z0-9_]{0,63})["']? (?:is )?(?:not|doesn'?t) exist/iu.exec(
                error.detail,
              )?.[1]
            : null
        return {
          state: 'unknown',
          detail: named
            ? `this host's schema does not have a field this build queries (${named})`
            : 'this host returned something this build could not read',
        }
      }
      default:
        // A response body can carry anything a server chose to return, so the
        // transport's message is never copied into a capability, a diagnostic,
        // or a support bundle. The kind of refusal is the fact; its wording is
        // the server's.
        return { state: 'unknown', detail: `the request was refused (${error.kind})` }
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
    // A cancellation is this build stopping, not a fact about the host.
    if (options.signal?.aborted || isCancelled(error)) throw error
    if (
      error instanceof GitHubTransportError &&
      (error.status === 404 || error.kind === 'not-found')
    ) {
      return {
        available: false,
        reason: 'repository-missing',
        message: `${owner}/${name} was not found on this host`,
      }
    }
    const outcome = outcomeFromError(error)
    return {
      available: false,
      // No transport and no credential are both "this build could not ask", and
      // neither is a statement about what the host offers.
      reason:
        outcome.state === 'unreachable'
          ? 'unreachable'
          : outcome.state === 'not-configured'
            ? 'not-configured'
            : 'unauthenticated',
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
    // A cancellation is this build stopping, not a fact about the host, and is
    // raised here exactly as it is on the repository read above.
    if (options.signal?.aborted || isCancelled(error)) throw error
    if (
      error instanceof GitHubTransportError &&
      (error.status === 404 || error.kind === 'not-found')
    ) {
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

/**
 * Records what a real request to this host established about one capability.
 * This is the only way a capability becomes supported without a probe: a probe
 * that could not ask leaves whatever the request actually saw.
 */
export function observeHostRequest(
  host: string,
  id: GitHubCapabilityId,
  outcome: { state: GitHubCapabilityState; detail: string },
): void {
  record(host.toLowerCase()).capabilities.set(id, {
    id,
    label: CAPABILITY_LABELS[id],
    state: outcome.state,
    detail: outcome.detail,
  })
}

/** What a real request to this host already established, if anything. */
function observedCapability(host: string, id: GitHubCapabilityId): GitHubCapability | null {
  return record(host.toLowerCase()).capabilities.get(id) ?? null
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
  // Whether this build can sign a person in to *this* host, from that host's own
  // registration. A host with no registered app is not configured, which is not
  // the same as a host whose server refuses the flow: only a refusal is
  // unsupported, and this build does not claim one before it is asked.
  const clientId = githubAppClientId(env, context.host)
  if (clientId === null) {
    return {
      id: 'device-sign-in',
      label: CAPABILITY_LABELS['device-sign-in'],
      state: 'not-configured',
      detail: context.dotcom
        ? 'No GitHub App client id is configured for this build.'
        : `No GitHub App client id is registered for ${context.host}. Set ${githubAppClientIdEnvName(context.host)} to sign in to it, or use a credential this build already holds for it.`,
    }
  }
  return {
    id: 'device-sign-in',
    label: CAPABILITY_LABELS['device-sign-in'],
    state: 'supported',
    detail: `${context.host} has a GitHub App registration this build can sign in with.`,
  }
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
  // The probe asks the host it is about, through the same transport a repository
  // on that host would use, so it never probes an endpoint this build would not
  // actually call.
  const transport = options.transport ?? hostTransport(context, env)
  const signal = options.signal ? { signal: options.signal } : {}
  const capabilities: GitHubCapability[] = []
  const set = (id: GitHubCapabilityId, outcome: ProbeOutcome) =>
    capabilities.push({
      id,
      label: CAPABILITY_LABELS[id],
      state: outcome.state,
      detail: outcome.detail,
    })

  let state: GitHubCapabilityState = 'unknown'
  let message = 'This host has not answered a capability request yet.'
  let serverVersion: string | null = null

  try {
    await transport.rest({ path: GITHUB_ROOT_PATH, ...signal })
    set('rest', { state: 'supported', detail: `${context.apiBase} answered a REST request` })
    // An API root answers for the API, not for the repository collection a
    // discovery run reads. That line stays unknown until a discovery request
    // establishes it, and keeps whatever a real run already observed.
    set(
      'repository-discovery',
      observedCapability(context.host, 'repository-discovery') ?? {
        state: 'unknown',
        detail: 'No repository discovery request has run against this host yet.',
      },
    )
    state = 'supported'
    message = `${context.host} answered at ${context.apiBase}.`
  } catch (error) {
    // An abort is this build's own doing, not a fact about the host: it is
    // raised so a retired host's probe never reports a status of unknown for a
    // request it was not allowed to finish.
    if (options.signal?.aborted) throw error
    const outcome = outcomeFromError(error)
    set('rest', outcome)
    set('repository-discovery', observedCapability(context.host, 'repository-discovery') ?? outcome)
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
    if (options.signal?.aborted) throw error
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
    // A report built without a repository cannot speak for one, so it keeps
    // whatever a repository on this host already established rather than
    // replacing it with a question this report did not ask.
    set(
      'native-stacks',
      observedCapability(context.host, 'native-stacks') ?? {
        state: 'unknown',
        detail: 'Open a repository on this host to establish native stack support.',
      },
    )
  }

  const status: GitHubHostStatus = {
    ...hostStatus(context, env),
    state,
    message,
    serverVersion,
    probedAt: (options.now ?? (() => new Date()))().toISOString(),
    // The matrix is every capability id, always. Sign-in is a fact about this
    // build's registration for this host, and a probe that could not reach the
    // network does not make that line vanish.
    capabilities: CAPABILITY_IDS.map(
      (id) =>
        capabilities.find((capability) => capability.id === id) ??
        (id === 'device-sign-in' ? deviceSignInCapability(context, env) : unprobedCapability(id)),
    ),
  }
  // The last moment before this answer is written down. A host retired while
  // the probe was running has no record to publish, and recording one would put
  // what it said about a host back into the record for the host selected now.
  if (options.signal?.aborted) {
    throw new GitHubTransportError({ kind: 'cancelled', detail: 'the probe was cancelled' })
  }
  recordHostProbe(status)
  return status
}

function stacksStateForReason(reason: NativeStackCapabilityReason): GitHubCapabilityState {
  if (reason === 'unreachable') return 'unreachable'
  if (reason === 'not-configured') return 'not-configured'
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
    // A version is a number and dots. Whatever else a server put in that field
    // is not a version and never reaches a diagnostic or a support bundle.
    if (isRecord(data) && typeof data.installed_version === 'string') {
      const version = data.installed_version.trim()
      if (/^\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][A-Za-z0-9.]{1,16})?$/u.test(version)) return version
    }
  } catch {
    // A host that does not answer /meta has not told this build its version.
  }
  return null
}
