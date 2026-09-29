import { isRecord } from './git-core'
import { GitHubTransportError, githubTransport, type GitHubTransport } from './github-transport'
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

/** `owner/name`: the only identifier a clone URL or a `gh` command is built from. */
const FULL_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/u
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/u

/** GitHub reports an unapproved organization authorization on the failure message. */
const ORGANIZATION_AUTHORIZATION = /saml|sso|protected by organization/iu

const GITHUB_HTTPS = 'https://github.com'

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
function cloneUrl(value: unknown, kind: 'https' | 'ssh'): string | null {
  const candidate = stringField(value)
  if (!candidate) return null
  if (kind === 'ssh') {
    return /^(?:ssh:\/\/)?git@github\.com:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?$/u.test(
      candidate,
    )
      ? candidate
      : null
  }
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  return url.username || url.password || url.port ? null : candidate
}

/**
 * One accessible repository as onboarding needs it. Anything that is not a
 * well-formed repository the credential may act on is dropped rather than shown
 * as a broken row: a search hit the token cannot read is not a clone target.
 */
export function summarizeRepository(value: unknown): GitHubRepositorySummary | null {
  if (!isRecord(value)) return null
  const owner = isRecord(value.owner) ? stringField(value.owner.login) : null
  const name = stringField(value.name)
  const fullName = stringField(value.full_name) ?? (owner && name ? `${owner}/${name}` : null)
  // `permissions` is present exactly for repositories the caller may act on.
  const permissions = isRecord(value.permissions) ? value.permissions : null
  if (!owner || !name || !fullName || !permissions || !FULL_NAME.test(fullName)) return null
  return {
    fullName,
    name,
    owner,
    description: stringField(value.description),
    private: value.private === true,
    fork: value.fork === true,
    archived: value.archived === true,
    // GitHub reports an empty repository as no commits yet: zero objects and no
    // default branch to check out.
    empty: value.size === 0 || value.default_branch === null,
    language: stringField(value.language),
    defaultBranch: stringField(value.default_branch) ?? 'main',
    pushedAt: stringField(value.pushed_at),
    url: cloneUrl(value.html_url, 'https') ?? `${GITHUB_HTTPS}/${fullName}`,
    httpsUrl: cloneUrl(value.clone_url, 'https') ?? `${GITHUB_HTTPS}/${fullName}.git`,
    sshUrl: cloneUrl(value.ssh_url, 'ssh') ?? `git@github.com:${fullName}.git`,
    canPush:
      permissions.push === true || permissions.admin === true || permissions.maintain === true,
  }
}

/** Discards every response entry the caller has no access to, keeping input order. */
function accessible(values: readonly unknown[]): GitHubRepositorySummary[] {
  const repositories: GitHubRepositorySummary[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const repository = summarizeRepository(value)
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
): string {
  const destination = shellWord(cloneDestinationText(parentDirectory, directoryName))
  const gitFlags = shallow ? ' -- --depth 1' : ''
  return `gh repo clone ${fullName} ${destination}${gitFlags}`
}

export interface DiscoveryOptions {
  query?: string
  signal?: AbortSignal
  transport?: GitHubTransport
  /** Page bound, so a fixture or a deliberately bounded sweep can stop earlier. */
  maxPages?: number
}

/**
 * Every repository the signed-in credential can reach, most recently pushed
 * first. A query switches to GitHub's own search, whose results are filtered
 * down to the ones the credential may actually act on.
 */
export async function discoverRepositories(
  options: DiscoveryOptions = {},
): Promise<RepositoryDiscovery> {
  const transport = options.transport ?? githubTransport()
  const query = (options.query ?? '').trim()
  const repositories = query
    ? await searchRepositories(transport, query, options)
    : await listAccessible(transport, options)
  return { repositories, query }
}

/**
 * `GET /user/repos`, already limited to repositories the caller owns,
 * collaborates on, or reaches through organization membership. The transport
 * follows every `Link` page and owns the credential and cancellation.
 */
async function listAccessible(
  transport: GitHubTransport,
  options: DiscoveryOptions,
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
  return accessible(items)
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
): Promise<GitHubRepositorySummary[]> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? PAGE_CAP, PAGE_CAP))
  const collected: unknown[] = []
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
    const items = isRecord(response.data) ? response.data.items : null
    if (!Array.isArray(items)) {
      throw new GitHubTransportError({
        kind: 'invalid-response',
        status: response.status,
        detail: 'GitHub returned a search response without repository items',
        rateLimit: response.rateLimit,
      })
    }
    collected.push(...items)
    if (items.length < REPOSITORY_PAGE_SIZE) break
  }
  return accessible(collected)
}
