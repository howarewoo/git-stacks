import { isRecord } from './git-core'
import { GitHubTransportError, type GitHubTransport } from './github-transport'
import {
  GITHUB_DOTCOM_HOST,
  githubHostContext,
  hostTransport,
  observeHostRequest,
  type GitHubHostContext,
} from './github-host'
import type { GitHubCapabilityState } from '../shared/host'
import type {
  GitHubRepositorySummary,
  OnboardingFailure,
  RepositoryDiscovery,
} from '../shared/types'

/** GitHub's largest page for a repository collection. */
export const REPOSITORY_PAGE_SIZE = 100
/**
 * A bounded sweep over accessible repositories. This stops rather than walking
 * an unbounded collection, and reports only what it actually read.
 */
export const MAX_REPOSITORY_PAGES = 30

const PAGE_CAP = MAX_REPOSITORY_PAGES
/** GitHub's search API imposes a hard limit of 1,000 results per query. */
const GITHUB_SEARCH_RESULT_CAP = 1000
const SEARCH_PAGE_CAP = Math.floor(GITHUB_SEARCH_RESULT_CAP / REPOSITORY_PAGE_SIZE)

/** `owner/name`: the only identifier a clone URL or a `gh` command is built from. */
const FULL_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/u
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/u

/** The host discovery falls back to when a caller only wants a summary: github.com. */
const GITHUB_DOTCOM_CONTEXT = githubHostContext(GITHUB_DOTCOM_HOST)

/** GitHub reports an unapproved organization authorization on the failure message. */
const ORGANIZATION_AUTHORIZATION = /saml|sso|protected by organization/iu

/**
 * A trimmed non-empty string, or null. GitHub's payload is `unknown` all the way
 * to this boundary, so every field is read through this one rule.
 */
function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * GitHub's own clone endpoints, accepted only when they address github.com over
 * HTTPS or in the SSH form. A response naming another host is not followed:
 * discovery must never be able to redirect a clone somewhere else.
 */
function cloneUrl(
  value: unknown,
  kind: 'https' | 'ssh',
  host: GitHubHostContext,
): string | null {
  const candidate = stringField(value)
  if (!candidate) return null
  if (kind === 'ssh') {
    return new RegExp(
      `^(?:ssh://)?git@${host.sshHost.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(?:\\.git)?$`,
      'u',
    ).test(candidate)
      ? candidate
      : null
  }
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== host.host) return null
  return url.username || url.password || url.port ? null : candidate
}

/**
 * One accessible repository as onboarding needs it. Anything that is not a
 * well-formed repository is dropped rather than shown as a broken row. Neither
 * `GET /user/repos` nor search reports a repository this credential cannot
 * read, so a well-formed hit is a clone target by construction.
 */
export function summarizeRepository(
  value: unknown,
  host: GitHubHostContext = GITHUB_DOTCOM_CONTEXT,
): GitHubRepositorySummary | null {
  if (!isRecord(value)) return null
  const owner = isRecord(value.owner) ? stringField(value.owner.login) : null
  const name = stringField(value.name)
  const fullName = stringField(value.full_name) ?? (owner && name ? `${owner}/${name}` : null)
  if (!owner || !name || !fullName || !FULL_NAME.test(fullName)) return null
  // `permissions` is optional in GitHub's schema and search results usually omit
  // it entirely. Its absence is not evidence of inaccessibility, so it is read
  // as "push not proven" rather than as a reason to drop the hit.
  const permissions = isRecord(value.permissions) ? value.permissions : null
  return {
    fullName,
    name,
    owner,
    description: stringField(value.description),
    private: value.private === true,
    fork: value.fork === true,
    archived: value.archived === true,
    // A repository is empty when it has no default branch, or when it has no
    // recorded size and was never pushed. A small repository whose size rounds
    // down to 0 KB is still non-empty when it has commits pushed to it.
    empty:
      value.default_branch === null ||
      (value.size === 0 && (value.pushed_at === null || value.pushed_at === undefined)),
    language: stringField(value.language),
    defaultBranch: stringField(value.default_branch) ?? 'main',
    pushedAt: stringField(value.pushed_at),
    url: cloneUrl(value.html_url, 'https', host) ?? `${host.webOrigin}/${fullName}`,
    httpsUrl: cloneUrl(value.clone_url, 'https', host) ?? `${host.webOrigin}/${fullName}.git`,
    sshUrl: cloneUrl(value.ssh_url, 'ssh', host) ?? `git@${host.sshHost}:${fullName}.git`,
    canPush:
      permissions !== null &&
      (permissions.push === true || permissions.admin === true || permissions.maintain === true),
    host: host.host,
  }
}

/**
 * Keeps every well-formed repository a response returned, in order, and drops a
 * repeat of one already listed. Both endpoints are already scoped to the
 * credential, so this filters malformed entries and duplicates, nothing else.
 */
function accessible(
  values: readonly unknown[],
  host: GitHubHostContext,
): GitHubRepositorySummary[] {
  const repositories: GitHubRepositorySummary[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const repository = summarizeRepository(value, host)
    if (!repository) continue
    const key = repository.fullName.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    repositories.push(repository)
  }
  return repositories
}

/**
 * Turns any transport refusal into one named onboarding outcome. The account
 * module has already refreshed a rejected credential on the way here, so this
 * only has to say what a person can do about it.
 */
export function classifyTransportFailure(error: unknown): OnboardingFailure {
  if (!(error instanceof GitHubTransportError)) {
    return {
      reason: 'unavailable',
      message: error instanceof Error && error.message ? error.message : 'GitHub is unreachable.',
    }
  }
  if (error.kind === 'cancelled') {
    return { reason: 'cancelled', message: 'The repository search was cancelled.' }
  }
  if (error.kind === 'unauthorized') {
    return {
      reason: 'signed-out',
      message: 'Sign in to GitHub to search the repositories you can reach.',
    }
  }
  if (error.kind === 'rate-limited' || error.kind === 'secondary-rate-limit') {
    return { reason: 'rate-limited', message: error.detail }
  }
  if (error.kind === 'forbidden') {
    return ORGANIZATION_AUTHORIZATION.test(error.detail)
      ? {
          reason: 'sso-denied',
          message:
            'This organization requires single sign-on. Authorize Git Stacks for the organization, then search again.',
        }
      : { reason: 'unavailable', message: error.detail }
  }
  if (error.kind === 'timeout' || error.kind === 'network') {
    return { reason: 'network', message: `GitHub is unreachable: ${error.detail}` }
  }
  return { reason: 'unavailable', message: error.detail }
}

/** Refuses an identifier that is not `owner/name` before it reaches a command. */
export function assertFullName(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!FULL_NAME.test(candidate)) throw new Error('Repository names look like owner/name.')
  return candidate
}

/** A single folder name Git accepts as one path segment, never a path of its own. */
export function assertDirectoryName(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!SEGMENT.test(candidate) || candidate.length > 200) {
    throw new Error(
      'Choose one folder name made of letters, numbers, dots, dashes, or underscores.',
    )
  }
  return candidate
}

/** One destination path as it is written in a copied terminal command. */
export function cloneDestinationText(parentDirectory: string, directoryName: string): string {
  return `${parentDirectory.replace(/[/\\]+$/u, '')}/${directoryName}`
}

/** Quoting a command argument only when it is not already a plain word. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9._\-/:]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`
}

export function cloneCommandText(
  url: string,
  parentDirectory: string,
  directoryName: string,
  shallow: boolean,
): string {
  const depth = shallow ? ' --depth 1' : ''
  const destination = shellWord(cloneDestinationText(parentDirectory, directoryName))
  return `git clone${depth} ${shellWord(url)} ${destination}`
}

/**
 * The `gh repo clone` equivalent of the same clone, to the same destination.
 * Git Stacks never runs `gh` for this; the command is only shown, so the clone
 * can be reproduced in a terminal.
 */
export function ghCloneCommandText(
  fullName: string,
  parentDirectory: string,
  directoryName: string,
  shallow: boolean,
  url?: string,
): string {
  const destination = shellWord(cloneDestinationText(parentDirectory, directoryName))
  const gitFlags = shallow ? ' -- --depth 1' : ''
  // `gh repo clone` has no host flag: a bare `owner/name` is resolved on
  // github.com, which on another host is a different repository. Its documented
  // way to name a host is a qualified repository argument, so a clone off the
  // default host is shown with that host's own URL. On github.com the bare name
  // is kept, exactly as it has always been shown.
  const target = url ? shellWord(url) : fullName
  return `gh repo clone ${target} ${destination}${gitFlags}`
}

export interface DiscoveryOptions {
  /** The host being browsed. It owns every request and every clone URL built. */
  host: GitHubHostContext
  query?: string
  signal?: AbortSignal
  transport?: GitHubTransport
  /** Page bound, so a fixture or a deliberately bounded sweep can stop earlier. */
  maxPages?: number
}

/**
 * Every repository the signed-in credential can reach, most recently pushed
 * first. A query switches to GitHub's own search, which is likewise scoped to
 * the repositories this credential can read.
 */
export async function discoverRepositories(
  options: DiscoveryOptions,
): Promise<RepositoryDiscovery> {
  const transport = options.transport ?? hostTransport(options.host)
  const query = (options.query ?? '').trim()
  try {
    const value = query
      ? await searchRepositories(transport, query, options, options.host)
      : { repositories: await listAccessible(transport, options, options.host), query: '' }
    // A discovery run is the only evidence that discovery works on this host, so
    // it is what records that, against the host it actually ran on.
    observeHostRequest(options.host.host, 'repository-discovery', {
      state: 'supported',
      detail: `${options.host.apiBase} answered a repository collection for this credential.`,
    })
    return value
  } catch (error) {
    if (options.signal?.aborted) throw error
    observeHostRequest(options.host.host, 'repository-discovery', discoveryFailure(error))
    throw error
  }
}

/** What a failed discovery run established, said as a capability state. */
function discoveryFailure(error: unknown): { state: GitHubCapabilityState; detail: string } {
  const kind = error instanceof GitHubTransportError ? error.kind : null
  if (kind === 'unauthorized' || kind === 'forbidden') {
    return {
      state: 'unauthenticated',
      detail: 'this host refused the credential for a repository collection',
    }
  }
  if (kind === 'network' || kind === 'timeout') {
    return { state: 'unreachable', detail: 'this host did not answer a repository collection' }
  }
  if (kind === 'not-configured') {
    return { state: 'not-configured', detail: 'this machine has no way to ask for one' }
  }
  return { state: 'unknown', detail: 'a repository collection could not be read from this host' }
}

/**
 * `GET /user/repos`, already limited to repositories the caller owns,
 * collaborates on, or reaches through organization membership. The transport
 * follows every `Link` page and owns the credential and cancellation.
 */
async function listAccessible(
  transport: GitHubTransport,
  options: DiscoveryOptions,
  host: GitHubHostContext,
): Promise<GitHubRepositorySummary[]> {
  const search = new URLSearchParams({
    affiliation: 'owner,collaborator,organization_member',
    visibility: 'all',
    sort: 'pushed',
    direction: 'desc',
    per_page: String(REPOSITORY_PAGE_SIZE),
  }).toString()
  const items = await transport.paginate<unknown>({
    path: `user/repos?${search}`,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return accessible(items, host)
}

/**
 * GitHub search answers a `total_count` beside its items in one object rather
 * than a bare array, so its pages are walked explicitly. Each page still goes
 * through the transport, which owns the credential, timeout, and cancellation.
 */
async function searchRepositories(
  transport: GitHubTransport,
  query: string,
  options: DiscoveryOptions,
  host: GitHubHostContext,
): Promise<RepositoryDiscovery> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? SEARCH_PAGE_CAP, SEARCH_PAGE_CAP))
  const collected: unknown[] = []
  let totalCount: number | undefined
  let incompleteResults = false

  for (let page = 1; page <= maxPages; page += 1) {
    const search = new URLSearchParams({
      q: query,
      sort: 'updated',
      order: 'desc',
      per_page: String(REPOSITORY_PAGE_SIZE),
      page: String(page),
    }).toString()
    const response = await transport.rest<unknown>({
      path: `search/repositories?${search}`,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!isRecord(response.data) || !Array.isArray(response.data.items)) {
      throw new GitHubTransportError({
        kind: 'invalid-response',
        status: response.status,
        detail: 'GitHub returned a search response without repository items',
        rateLimit: response.rateLimit,
      })
    }
    if (typeof response.data.total_count === 'number') {
      totalCount = response.data.total_count
    }
    if (response.data.incomplete_results === true) {
      incompleteResults = true
    }
    collected.push(...response.data.items)
    if (response.data.items.length < REPOSITORY_PAGE_SIZE) break
  }
  const repositories = accessible(collected, host)
  const truncated =
    (totalCount !== undefined && totalCount > repositories.length) ||
    collected.length >= GITHUB_SEARCH_RESULT_CAP
  return {
    repositories,
    query,
    ...(totalCount !== undefined ? { totalCount } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(incompleteResults ? { incompleteResults: true } : {}),
  }
}
