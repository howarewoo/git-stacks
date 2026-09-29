import type { NativeStack, PullRequest, RepositoryIssue } from '../shared/types'
import { summariseCheckRollupState } from '../shared/pull-request-checks'
import {
  CommandCancelled,
  commandCode,
  commandDetail,
  getConfigValue,
  isCancelled,
  isRecord,
  parseRemote,
  runGit,
} from './git-core'
import {
  type GitHubHostContext,
  hostTransport,
  observeHostCapability,
  remoteHostContext,
  type NativeStackCapabilityReason,
} from './github-host'
import { GitHubTransportError, type GitHubErrorKind } from './github-transport'
import {
  listPullRequestStacks,
  loadRepositoryNativeStacks,
  toPullRequestStackMembership,
} from './native-stacks'

export interface GitHubResult {
  pullRequests: PullRequest[]
  available: boolean
  message: string
  /**
   * Why the read could not answer, in typed terms. A caller that needs
   * authoritative data fails closed on this instead of guessing.
   */
  failure?: GitHubFailure
  /** True when a pull request's head repository is this repository's origin. */
  sameRepository: (value: unknown) => boolean
  nativeStacks?: NativeStack[]
  nativeStackPreviewAvailable?: boolean
  nativeStackMessage?: string
  /**
   * What the native stacks probe established. Only `endpoint-missing` says the
   * host does not serve the resource; anything else means this build could not
   * find out, and no caller may turn that into an absence.
   */
  nativeStackPreviewReason?: NativeStackCapabilityReason | 'not-applicable'
}

type PullRequestWithRepository = {
  pullRequest: PullRequest
  headRepository: string | null
}

/**
 * The compact badge the list rows carry. GitHub's own `statusCheckRollup` aggregate
 * is read through the same state vocabulary the detailed drill-down uses, so a row can
 * never claim a cleaner result than the checks behind it. Unreported stays pending.
 */
function pullRequestChecks(value: unknown): PullRequest['checks'] {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value]
  if (entries.length === 0) return 'none'
  const summaries = entries.map((entry) =>
    isRecord(entry)
      ? summariseCheckRollupState(entry.state ?? entry.conclusion ?? entry.status)
      : ('pending' as const),
  )
  if (summaries.includes('failing')) return 'failing'
  if (summaries.includes('pending')) return 'pending'
  return 'passing'
}

function pullRequestHeadRepository(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return null
  if (typeof value.nameWithOwner === 'string') return value.nameWithOwner
  if (typeof value.full_name === 'string') return value.full_name
  const name = value.name
  const owner = value.owner
  if (typeof name === 'string' && isRecord(owner) && typeof owner.login === 'string') {
    return `${owner.login}/${name}`
  }
  return null
}

function normalizeState(value: unknown, mergedAt?: unknown): PullRequest['state'] {
  if (typeof mergedAt === 'string' && mergedAt) return 'MERGED'
  const state = typeof value === 'string' ? value.toUpperCase() : 'OPEN'
  return state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN'
}

function parseGraphQlPullRequest(value: unknown): PullRequestWithRepository | null {
  if (!isRecord(value)) return null
  const number = value.number
  const title = value.title
  const url = value.url
  const head = value.headRefName
  const base = value.baseRefName
  if (
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    typeof title !== 'string' ||
    typeof url !== 'string' ||
    typeof head !== 'string' ||
    typeof base !== 'string'
  ) {
    return null
  }
  const commits =
    isRecord(value.commits) && Array.isArray(value.commits.nodes) ? value.commits.nodes : []
  const checkEntries = commits.flatMap((node) => {
    if (!isRecord(node) || !isRecord(node.commit)) return []
    return node.commit.statusCheckRollup ? [node.commit.statusCheckRollup] : []
  })
  const headRepository = pullRequestHeadRepository(value.headRepository)
  const mergeOid =
    isRecord(value.mergeCommit) && typeof value.mergeCommit.oid === 'string'
      ? value.mergeCommit.oid
      : undefined
  const pullRequest: PullRequest = {
    number,
    title,
    url,
    head,
    base,
    state: normalizeState(value.state),
    draft: value.isDraft === true,
    checks: pullRequestChecks(checkEntries),
    ...(typeof value.headRefOid === 'string' ? { headOid: value.headRefOid } : {}),
    ...(headRepository ? { headRepository } : {}),
    ...(typeof value.reviewDecision === 'string' ? { reviewDecision: value.reviewDecision } : {}),
    ...(typeof value.mergeStateStatus === 'string' ? { mergeState: value.mergeStateStatus } : {}),
    ...(mergeOid ? { mergeOid } : {}),
  }
  return { pullRequest, headRepository }
}

export function githubErrorMessage(error: unknown): string {
  if (error instanceof GitHubTransportError) {
    switch (error.kind) {
      case 'unsupported':
        return 'GitHub metadata unavailable: the gh CLI is not installed'
      case 'unauthorized':
        return `GitHub metadata unavailable: authentication is required (${error.detail})`
      case 'rate-limited':
      case 'secondary-rate-limit':
        return `GitHub metadata unavailable: GitHub API rate limit reached (${error.detail})`
      case 'cancelled':
        return 'GitHub metadata unavailable: the request was cancelled'
      case 'timeout':
        return `GitHub metadata unavailable: the request timed out (${error.detail})`
      default:
        return `GitHub metadata unavailable: ${error.detail}`
    }
  }
  const detail = commandDetail(error)
  if (commandCode(error) === 'ENOENT')
    return 'GitHub metadata unavailable: the gh CLI is not installed'
  if (/auth|login|token|credential/iu.test(detail)) {
    return `GitHub metadata unavailable: authentication is required (${detail})`
  }
  if (/network|connect|timeout|resolve|fetch|socket|dns|api\.github/iu.test(detail)) {
    return `GitHub metadata unavailable: network request failed (${detail})`
  }
  return `GitHub metadata unavailable: ${detail}`
}

/** The typed shape of a read that could not answer. */
export interface GitHubFailure {
  kind: GitHubErrorKind
  detail: string
}

function typedFailure(error: unknown): GitHubFailure | undefined {
  if (error instanceof GitHubTransportError) return { kind: error.kind, detail: error.detail }
  if (isCancelled(error)) return undefined
  return { kind: 'unknown', detail: githubErrorMessage(error) }
}

export function unavailableGitHubResult(message: string, failure?: GitHubFailure): GitHubResult {
  return {
    pullRequests: [],
    failure,
    available: false,
    message,
    sameRepository: () => false,
    nativeStacks: [],
    nativeStackPreviewAvailable: false,
    nativeStackPreviewReason: 'unreachable',
    nativeStackMessage: message,
  }
}
const unavailable = unavailableGitHubResult

/** Read open issues separately from PR workflows; paging one connection never truncates the other. */
export async function getGitHubIssues(
  repoPath: string,
  originUrl: string | null,
  signal?: AbortSignal,
): Promise<{ issues: RepositoryIssue[]; message: string }> {
  const remote = parseRemote(originUrl)
  const host = remoteHostContext(remote)
  if (!remote || !host) {
    return {
      issues: [],
      message: `Issues unavailable: the origin remote is on ${remote ? remote.host : 'no GitHub host'}`,
    }
  }
  const transport = hostTransport(host)
  const query = `query($owner: String!, $name: String!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $endCursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { number title url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`
  try {
    const issues: RepositoryIssue[] = []
    let endCursor: string | null = null
    for (;;) {
      if (signal?.aborted) throw new CommandCancelled()
      const page: Record<string, unknown> = await transport.graphql(
        query,
        {
          owner: remote.owner,
          name: remote.name,
          endCursor,
        },
        { signal },
      )
      const repository = isRecord(page) ? page.repository : null
      const connection = isRecord(repository) ? repository.issues : null
      if (!isRecord(connection) || !Array.isArray(connection.nodes)) {
        throw new Error('GitHub could not load issues')
      }
      for (const node of connection.nodes) {
        if (
          !isRecord(node) ||
          typeof node.number !== 'number' ||
          !Number.isInteger(node.number) ||
          typeof node.title !== 'string' ||
          typeof node.url !== 'string'
        )
          throw new Error('GitHub returned an invalid issue')
        issues.push({ number: node.number, title: node.title, url: node.url })
      }
      const pageInfo = isRecord(connection) ? connection.pageInfo : null
      const next = isRecord(pageInfo) ? pageInfo.endCursor : null
      if (
        !isRecord(pageInfo) ||
        pageInfo.hasNextPage !== true ||
        typeof next !== 'string' ||
        !next ||
        next === endCursor
      )
        break
      endCursor = next
    }
    if (signal?.aborted) throw new CommandCancelled()
    return { issues, message: '' }
  } catch (error) {
    if (signal?.aborted || isCancelled(error)) throw error
    return { issues: [], message: githubErrorMessage(error) }
  }
}

async function trackedPullRequestNumbers(
  repoPath: string,
  signal?: AbortSignal,
): Promise<number[]> {
  try {
    const output = await runGit(
      repoPath,
      ['config', '--null', '--get-regexp', '^branch\\..*\\.gitstackspr$'],
      undefined,
      signal,
    )
    const numbers = new Set<number>()
    for (const token of output.split('\0')) {
      const match = /^branch\..+\.gitstackspr\s+([0-9]+)$/u.exec(token)
      if (!match) continue
      const number = Number(match[1])
      if (Number.isInteger(number) && number > 0) numbers.add(number)
    }
    return [...numbers]
  } catch (error) {
    if (commandCode(error) === 1 || commandCode(error) === 2 || commandCode(error) === 128)
      return []
    throw error
  }
}

/**
 * Load the open pull requests for the origin repository and the exact PRs that
 * Git Stacks has recorded on local branches. The latter keeps merged/closed
 * parents discoverable without querying unbounded repository history.
 */
export async function getGitHubData(
  repoPath: string,
  originUrl: string | null,
  signal?: AbortSignal,
): Promise<GitHubResult> {
  const remote = parseRemote(originUrl)
  const host = remoteHostContext(remote)
  if (!originUrl) return unavailable('GitHub metadata unavailable: no origin remote is configured')
  if (!remote || !host) {
    return unavailable(
      `PR integration requires a GitHub origin remote; this repository's origin is on ${remote ? remote.host : 'no host'}. Local Git actions remain available.`,
    )
  }
  const transport = hostTransport(host)
  try {
    const query = (conservative: boolean) => `query($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: 100, after: $endCursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            ${pullRequestFields(conservative)}
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`

    const pullRequests: PullRequest[] = []
    const headRepositories: (string | null)[] = []
    let endCursor: string | null = null
    // The first page is asked for in full and, if the host's schema refused one
    // of the recent fields, every page after it is asked for the same narrower
    // way: a host does not gain those fields halfway through a listing.
    let conservative = false
    for (;;) {
      if (signal?.aborted) throw new CommandCancelled()
      const variables = {
        owner: remote.owner,
        name: remote.name,
        endCursor,
      }
      let page: Record<string, unknown>
      try {
        page = await transport.graphql(query(conservative), variables, { signal })
      } catch (error) {
        if (conservative || !isSchemaRefusal(error)) throw error
        observeGraphqlFailure(host, error)
        conservative = true
        page = await transport.graphql(query(true), variables, { signal })
      }
      const repository = isRecord(page) ? page.repository : null
      const connection = isRecord(repository) ? repository.pullRequests : null
      const nodes =
        isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : null
      if (!nodes) throw new Error('GitHub could not load pull requests')
      for (const node of nodes) {
        const parsed = parseGraphQlPullRequest(node)
        if (!parsed) continue
        pullRequests.push(parsed.pullRequest)
        headRepositories.push(parsed.headRepository)
      }
      const pageInfo = isRecord(connection) ? connection.pageInfo : null
      const next = isRecord(pageInfo) ? pageInfo.endCursor : null
      if (
        !isRecord(pageInfo) ||
        pageInfo.hasNextPage !== true ||
        typeof next !== 'string' ||
        !next ||
        next === endCursor
      )
        break
      endCursor = next
    }
    const known = new Set(pullRequests.map((entry) => entry.number))
    for (const number of await trackedPullRequestNumbers(repoPath, signal)) {
      if (signal?.aborted) throw new CommandCancelled()
      if (known.has(number)) continue
      const exact = await getPullRequest(repoPath, number, signal)
      pullRequests.push(exact)
      headRepositories.push(exact.headRepository ?? null)
      known.add(number)
    }
    const originFullName = remote.fullName.toLowerCase()
    const sameRepository = (value: unknown): boolean => {
      if (typeof value !== 'number' || !Number.isInteger(value)) return false
      return headRepositories[value]?.toLowerCase() === originFullName
    }
    const nativeStacksResult = await loadRepositoryNativeStacks(originUrl, pullRequests, signal)
    const where = host.dotcom ? 'GitHub' : host.host
    return {
      pullRequests,
      available: true,
      message:
        pullRequests.length === 0
          ? `${where} metadata available; no open or tracked pull requests`
          : `${where} metadata available; ${pullRequests.length} pull request${pullRequests.length === 1 ? '' : 's'}`,
      sameRepository,
      nativeStacks: nativeStacksResult.nativeStacks,
      nativeStackPreviewAvailable: nativeStacksResult.available,
      nativeStackPreviewReason: nativeStacksResult.reason,
      nativeStackMessage: nativeStacksResult.message,
    }
  } catch (error) {
    if (signal?.aborted || isCancelled(error)) throw new CommandCancelled()
    observeGraphqlFailure(host, error)
    return unavailable(githubErrorMessage(error), typedFailure(error))
  }
}

/**
 * Records what a GraphQL refusal actually was, against the host that produced
 * it. A schema that does not carry the fields this build queries is a host
 * without that capability; a rejected credential and an unanswered host are
 * recorded as themselves, so neither is ever reported as an unsupported one.
 */
function observeGraphqlFailure(host: GitHubHostContext, error: unknown): void {
  const detail = error instanceof GitHubTransportError ? error.detail : String(error)
  const state =
    error instanceof GitHubTransportError && error.kind === 'network'
      ? 'unreachable'
      : error instanceof GitHubTransportError &&
          (error.kind === 'unauthorized' || error.kind === 'forbidden')
        ? 'unauthenticated'
        : /cannot query field|doesn't exist on type|could not resolve to|unknown argument|unknown field/iu.test(
            detail,
          )
          ? 'unsupported'
          : 'unknown'
  observeHostCapability(host.host, {
    id: 'graphql',
    label: 'GraphQL API',
    state,
    detail:
      state === 'unsupported'
        ? `${host.host} rejected the fields this build queries: ${detail}`
        : detail,
  })
}

/**
 * True when the host refused the shape of the query rather than its result: a
 * field or argument its schema does not carry. This is a schema-version fact,
 * not a credential, rate limit, or network failure, and it is the only refusal
 * that makes a narrower query worth sending.
 */
function isSchemaRefusal(error: unknown): boolean {
  const detail = error instanceof GitHubTransportError ? error.detail : String(error)
  return /cannot query field|doesn't exist on type|could not resolve to|unknown argument|unknown field|is not defined by type/iu.test(
    detail,
  )
}

/**
 * The pull request fields every GitHub host carries, plus the fields only a
 * recent schema has. `reviewDecision`, `mergeStateStatus`, and a commit's
 * `statusCheckRollup` are asked for first and dropped when the host refuses
 * them, so an older Enterprise schema still answers the rest of the pull
 * request with its merge and check state honestly unknown.
 */
function pullRequestFields(conservative: boolean, withBody = false): string {
  const base = `number title url headRefName headRefOid baseRefName isDraft state headRepository { nameWithOwner } mergeCommit { oid }${withBody ? ' body' : ''}`
  return conservative
    ? base
    : `${base}
        reviewDecision mergeStateStatus
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`
}

/**
 * Load one canonical pull request, including its current body, from the host
 * that owns the origin. Only the fields every GitHub host answers are required;
 * a field a host's schema does not carry is reported as absent rather than
 * turning the whole pull request into an error.
 */
export async function getPullRequest(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<PullRequest & { body: string }> {
  if (!Number.isInteger(number) || number <= 0)
    throw new Error('Pull request number must be a positive integer')
  const remote = parseRemote(await getConfigValue(repoPath, 'remote.origin.url', signal))
  if (signal?.aborted) throw new CommandCancelled()
  const host = remoteHostContext(remote)
  if (!remote || !host) {
    throw new Error(
      `Pull request integration requires a GitHub origin remote; this repository's origin is on ${remote ? remote.host : 'no host'}.`,
    )
  }
  const transport = hostTransport(host)
  const query = (conservative: boolean) => `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${pullRequestFields(conservative, true)}
      }
    }
  }`
  try {
    const variables = {
      owner: remote.owner,
      name: remote.name,
      number,
    }
    const ask = (conservative: boolean) =>
      transport.graphql(query(conservative), variables, { signal })
    let value: unknown
    try {
      value = await ask(false)
    } catch (error) {
      // The host refused a field its schema does not carry. The narrower query
      // is the same read without the recent fields, so the pull request is
      // returned with its merge and check state unknown rather than lost.
      if (!isSchemaRefusal(error)) throw error
      observeGraphqlFailure(host, error)
      value = await ask(true)
    }
    if (signal?.aborted) throw new CommandCancelled()
    const repository = isRecord(value) ? value.repository : null
    const node = isRecord(repository) ? repository.pullRequest : null
    const parsed = parseGraphQlPullRequest(node)
    // `mergeStateStatus` and a commit's `statusCheckRollup` are recent additions
    // to the schema; a host that does not have them still answers everything
    // below, so only the fields every host has are required here.
    if (
      !parsed ||
      parsed.pullRequest.number !== number ||
      !isRecord(node) ||
      typeof node.body !== 'string' ||
      typeof node.isDraft !== 'boolean' ||
      typeof node.headRefOid !== 'string' ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(String(node.state))
    ) {
      throw new Error(`${host.host} returned incomplete pull request metadata`)
    }
    try {
      const stacks = await listPullRequestStacks(remote.owner, remote.name, {
        pullRequest: number,
        signal,
        host,
      })
      if (stacks.length > 0) {
        const membership = toPullRequestStackMembership(stacks[0], number)
        if (membership) {
          parsed.pullRequest.stack = membership
        }
      }
    } catch (stackError) {
      if (signal?.aborted || isCancelled(stackError)) {
        throw new CommandCancelled()
      }
      // A host without the stacks resource keeps stack null; membership is never
      // invented from a host that did not report it.
    }
    return { ...parsed.pullRequest, body: node.body }
  } catch (error) {
    if (signal?.aborted || isCancelled(error)) throw new CommandCancelled()
    observeGraphqlFailure(host, error)
    throw new Error(`Could not load pull request #${number}: ${githubErrorMessage(error)}`)
  }
}

// Keep this tiny helper available to stack code without exporting parser internals.
export function canonicalRemoteName(originUrl: string | null): string | null {
  return parseRemote(originUrl)?.fullName.toLowerCase() ?? null
}

export function pullRequestRepository(value: PullRequest): string | null {
  return typeof value.headRepository === 'string' ? value.headRepository.toLowerCase() : null
}

export * from './native-stacks'
