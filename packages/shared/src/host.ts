/**
 * The GitHub host this app is pointed at, and what that host was observed to
 * support. Everything here is a fact a probe established or an explicit
 * "not established": no field is filled in from what a host usually offers.
 */

export type GitHubHostKind = 'github.com' | 'enterprise'

/** The host every installation starts on. Nothing changes until one is chosen. */
export const GITHUB_DEFAULT_HOST = 'github.com'

/**
 * The host name as one name.
 *
 * Every origin this app builds is HTTPS, so the port it uses when none is named
 * is 443: a name that spells it out is the same host, and treating it as another
 * would give one host two credential scopes, two cache entries, and two
 * different answers to whether it is the same host.
 */
export function canonicalHostName(host: string): string {
  const name = host.trim().toLowerCase().replace(/\.$/u, '')
  return name.endsWith(':443') ? name.slice(0, -':443'.length) : name
}

/**
 * What is known about one capability.
 *
 * `unsupported` means the host answered and does not offer it. `unauthenticated`
 * and `unreachable` mean no answer came at all, and are never reported as
 * `unsupported`: a credential this build cannot supply says nothing about what
 * the host supports. `unknown` means nothing has established it yet.
 */
export type GitHubCapabilityState =
  | 'supported'
  | 'unsupported'
  | 'unauthenticated'
  | 'unreachable'
  | 'not-configured'
  | 'unknown'

export type GitHubCapabilityId =
  | 'rest'
  | 'graphql'
  | 'native-stacks'
  | 'repository-discovery'
  | 'cli-authentication'
export interface GitHubCapability {
  id: GitHubCapabilityId
  label: string
  state: GitHubCapabilityState
  detail: string
}

/** One capability matrix line, as the Settings surface and diagnostics show it. */
/** Every capability the matrix carries, in the order the surface shows them. */
export const CAPABILITY_IDS: readonly GitHubCapabilityId[] = [
  'rest',
  'graphql',
  'native-stacks',
  'repository-discovery',
  'cli-authentication',
]

export const CAPABILITY_LABELS: Record<GitHubCapabilityId, string> = {
  rest: 'REST API',
  graphql: 'GraphQL API',
  'native-stacks': 'Native stacked pull requests',
  'repository-discovery': 'Repository discovery',
  'cli-authentication': 'GitHub CLI authentication',
}

/**
 * How a capability state reads to a person. `unsupported` is only ever reached
 * when the host answered; every other state says that it did not.
 */
export const CAPABILITY_STATE_LABELS: Record<GitHubCapabilityState, string> = {
  supported: 'supported',
  unsupported: 'not offered by this host',
  unauthenticated: 'no credential answered for this host',
  unreachable: 'the host did not answer',
  'not-configured': 'not configured in this build',
  unknown: 'not established yet',
}

export interface GitHubHostStatus {
  /** Host this app talks to for onboarding, and the host a repository must match. */
  host: string
  kind: GitHubHostKind
  /** The host's own web origin; every pull request link is opened here. */
  webOrigin: string
  /** REST base every request for this host is sent to. */
  apiBase: string
  graphqlUrl: string
  /** API version header this build sends to the host. */
  apiVersion: string
  /** Preview API version requested for the native stacks resource. */
  stacksApiVersion: string
  /** The version the host reported about itself, or null when it reported none. */
  serverVersion: string | null
  state: GitHubCapabilityState
  message: string
  /** When the host was last probed; null when nothing has probed it. */
  probedAt: string | null
  capabilities: GitHubCapability[]
}
