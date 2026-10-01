import { isRecord } from '../shared/guards'
import { summariseCheckRollupState } from '../shared/pull-request-checks'
import {
  DEFAULT_PULL_REQUEST_INBOX_BUDGET,
  PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS,
  derivePullRequestInboxState,
  pullRequestInboxBudgetAllows,
  pullRequestInboxGroups,
  sortPullRequestInbox,
  type PullRequestInboxBudget,
  type PullRequestInboxItem,
  type PullRequestInboxRefreshState,
  type PullRequestInboxReport,
  type PullRequestInboxRepositoryReport,
  type PullRequestInboxRepositoryStatus,
} from '../shared/pr-inbox'
import type { PullRequest } from '../shared/types'
import { CommandCancelled, isCancelled, parseRemote } from './git-core'
import { hostTransport, remoteHostContext, type GitHubHostContext } from './github-host'
import {
  GitHubTransportError,
  lastGitHubRateLimit,
  type GitHubErrorKind,
  type GitHubTransport,
} from './github-transport'
import { loadRepositoryNativeStacks } from './native-stacks'

/** One registered repository the queue reads. */
export interface PullRequestInboxTarget {
  /** Absolute local path, as registered by the person or by a clone. */
  path: string
  /** The repository's `origin` remote URL, read by the caller. */
  originUrl: string | null
}

/**
 * Every field the Inbox needs from one pull request. The review decision, the
 * newest review, the newest comment, and the head's check rollup are the recent
 * additions; an enterprise host whose schema refuses them falls back to the
 * basic set below rather than losing the pull request.
 */
const FULL_FIELDS = `
    number title url headRefName headRefOid baseRefName isDraft state
    updatedAt mergedAt
    author { login }
    headRepository { nameWithOwner }
    reviewDecision
    reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } } } }
    latestReviews(first: 1) { nodes { author { login } submittedAt } }
    comments(last: 1) { nodes { author { login } createdAt } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`

/**
 * The same read without the recent fields. A host that refuses them still
 * answers authored, requested, and draft facts, so the queue keeps working and
 * says through the repository report that review state is unknown rather than
 * reading an absent review decision as "nobody reviewed it".
 */
const BASIC_FIELDS = `
    number title url headRefName headRefOid baseRefName isDraft state
    updatedAt mergedAt
    author { login }
    headRepository { nameWithOwner }
    reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } } } }`

const OPEN_PAGE_SIZE = 100
const MERGED_PAGE_SIZE = 50
const MERGED_PAGES = 2
/**
 * GitHub round trips one native-stack read costs: a conditional capability
 * probe plus the stack listing. It is charged so the per-refresh cap covers
 * every request the queue spends, not only the GraphQL ones.
 */
const NATIVE_STACK_READ_COST = 2

/**
 * One GraphQL request per page, asking for the open and merged listings of one
 * repository together. `viewer` rides along on every page so each answer is
 * self-contained: a refresh that reads twenty repositories never has to guess
 * whose account it is reading as.
 */
function inboxQuery(fields: string): string {
  return `query($owner: String!, $name: String!, $openCursor: String, $mergedCursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    open: pullRequests(first: ${OPEN_PAGE_SIZE}, after: $openCursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {${fields}
      }
      pageInfo { hasNextPage endCursor }
    }
    merged: pullRequests(first: ${MERGED_PAGE_SIZE}, after: $mergedCursor, states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {${fields}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`
}

/** Transport failure kind to what one repository's read can honestly say. */
const STATUS_BY_KIND: Partial<Record<GitHubErrorKind, PullRequestInboxRepositoryStatus>> = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  'not-found': 'not-found',
  network: 'offline',
  timeout: 'offline',
  'rate-limited': 'rate-limited',
  'secondary-rate-limit': 'rate-limited',
  unsupported: 'unsupported',
  'not-configured': 'skipped',
}

/** Transport failure kind to what the whole refresh can honestly say. */
const REFRESH_STATE_BY_KIND: Partial<Record<GitHubErrorKind, PullRequestInboxRefreshState>> = {
  unauthorized: 'auth-required',
  network: 'offline',
  timeout: 'offline',
  'rate-limited': 'rate-limited',
  'secondary-rate-limit': 'rate-limited',
}

/**
 * GitHub answers a repository the credential cannot see by resolving it to null
 * rather than by refusing the request, and an older schema phrases the same
 * refusal as an unresolvable node. Both are the credential's access, not this
 * build's query shape, so neither triggers the narrower retry.
 */
const INVISIBLE_REPOSITORY =
  /could not resolve to a repository|repository not found|not found\.|could not resolve to a node/iu

function isInvisibleRepository(detail: string): boolean {
  return INVISIBLE_REPOSITORY.test(detail)
}

/** A field a host's schema does not carry, as opposed to a refusal of its result. */
function isSchemaRefusal(detail: string): boolean {
  return /cannot query field|doesn't exist on type|unknown argument|unknown field|is not defined by type/iu.test(
    detail,
  )
}

function nodeLogin(value: unknown): string | null {
  return isRecord(value) && typeof value.login === 'string' ? value.login : null
}

function nodeDate(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Direct review-request logins. A team request carries no user login and is dropped. */
function requestedLogins(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return []
  const logins: string[] = []
  for (const node of value.nodes) {
    if (!isRecord(node)) continue
    const login = nodeLogin(node.requestedReviewer)
    if (login) logins.push(login)
  }
  return logins
}

/** The author of the most recent review or issue comment, whichever is later. */
function lastTurnAuthor(
  latestReviews: unknown,
  comments: unknown,
): { login: string | null; at: string | null } {
  const review = isRecord(latestReviews) && Array.isArray(latestReviews.nodes)
    ? latestReviews.nodes.find((node) => isRecord(node))
    : null
  const comment = isRecord(comments) && Array.isArray(comments.nodes)
    ? comments.nodes.find((node) => isRecord(node))
    : null
  const reviewAt = isRecord(review) ? nodeDate(review.submittedAt) : null
  const commentAt = isRecord(comment) ? nodeDate(comment.createdAt) : null
  const reviewTime = reviewAt ? Date.parse(reviewAt) : Number.NaN
  const commentTime = commentAt ? Date.parse(commentAt) : Number.NaN
  if (Number.isFinite(commentTime) && (!Number.isFinite(reviewTime) || commentTime >= reviewTime)) {
    return { login: isRecord(comment) ? nodeLogin(comment.author) : null, at: commentAt }
  }
  return {
    login: isRecord(review) ? nodeLogin(review.author) : null,
    at: Number.isFinite(reviewTime) ? reviewAt : null,
  }
}

/**
 * The compact check badge, read from GitHub's own rollup through the same state
 * vocabulary the detailed drill-down uses, so a row can never claim a cleaner
 * result than the checks behind it. Unreported stays pending.
 */
function inboxChecks(value: unknown): PullRequest['checks'] {
  const commits = isRecord(value) && Array.isArray(value.nodes) ? value.nodes : []
  const rollups = commits.flatMap((node) => {
    if (!isRecord(node) || !isRecord(node.commit)) return []
    return node.commit.statusCheckRollup ? [node.commit.statusCheckRollup] : []
  })
  if (rollups.length === 0) return 'none'
  const summaries = rollups.map((entry) => summariseCheckRollupState(entry))
  if (summaries.includes('failing')) return 'failing'
  if (summaries.includes('pending')) return 'pending'
  return 'passing'
}

function inboxState(value: unknown, mergedAt: string | null): PullRequest['state'] {
  if (mergedAt) return 'MERGED'
  if (value === 'CLOSED' || value === 'MERGED') return value
  return 'OPEN'
}

/**
 * One pull request node into an Inbox item, or null when the node is not a
 * pull request this build can describe. A node missing its number, title, URL,
 * or refs is dropped rather than rendered half-formed: an unreadable row would
 * be a row whose repository and identity the person cannot verify.
 */
function inboxItem(
  node: unknown,
  context: {
    repository: string
    path: string
    host: string
    basic: boolean
  },
): PullRequestInboxItem | null {
  if (!isRecord(node)) return null
  const { number, title, url, headRefName, baseRefName } = node
  if (
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    typeof title !== 'string' ||
    typeof url !== 'string' ||
    typeof headRefName !== 'string' ||
    typeof baseRefName !== 'string'
  ) {
    return null
  }
  const mergedAt = nodeDate(node.mergedAt)
  const turn = context.basic
    ? { login: null, at: null }
    : lastTurnAuthor(node.latestReviews, node.comments)
  const headRepository = isRecord(node.headRepository)
    ? nodeDate(node.headRepository.nameWithOwner)
    : null
  return {
    number,
    title,
    url,
    head: headRefName,
    base: baseRefName,
    state: inboxState(node.state, mergedAt),
    draft: node.isDraft === true,
    checks: context.basic ? 'none' : inboxChecks(node.commits),
    ...(typeof node.headRefOid === 'string' ? { headOid: node.headRefOid } : {}),
    ...(headRepository ? { headRepository } : {}),
    repository: context.repository,
    repositoryPath: context.path,
    host: context.host,
    author: nodeLogin(node.author),
    reviewRequested: requestedLogins(node.reviewRequests),
    reviewDecision: context.basic
      ? null
      : typeof node.reviewDecision === 'string'
        ? node.reviewDecision
        : null,
    lastTurnLogin: turn.login,
    updatedAt: nodeDate(node.updatedAt),
    mergedAt,
    // Group membership is decided once the viewer for this repository is known.
    groups: [],
  }
}

/** The next cursor of a connection, or null when the listing is finished. */
function nextCursor(connection: unknown, current: string | null): string | null | undefined {
  if (!isRecord(connection)) return undefined
  const pageInfo = connection.pageInfo
  if (!isRecord(pageInfo) || pageInfo.hasNextPage !== true) return null
  const next = pageInfo.endCursor
  if (typeof next !== 'string' || !next || next === current) return null
  return next
}

interface RepositoryReadResult {
  items: PullRequestInboxItem[]
  viewer: string | null
  status: PullRequestInboxRepositoryStatus
  detail: string
  requests: number
  truncated: boolean
}

interface RepositoryReadContext {
  target: PullRequestInboxTarget
  host: GitHubHostContext
  fullName: string
  budget: PullRequestInboxBudget
  spent: number
  mergedWithinDays: number
  now: number
  signal?: AbortSignal
}

class BudgetExhausted extends Error {}

/**
 * Reads one repository's Inbox rows, spending at most the requests the refresh
 * has left. Paging is charged per page, so a repository with a very long
 * history cannot consume the whole budget and starve the ones after it: the
 * page that would exceed the cap stops the repository instead.
 */
async function readRepositoryInbox(
  context: RepositoryReadContext,
  transport: GitHubTransport,
): Promise<RepositoryReadResult> {
  const { owner, name } = parseRemote(context.target.originUrl) ?? { owner: '', name: '' }
  const items: PullRequestInboxItem[] = []
  const seen = new Set<number>()
  let viewer: string | null = null
  let basic = false
  let requests = 0
  let truncated = false
  let openCursor: string | null = null
  let mergedCursor: string | null = null
  let openDone = false
  let mergedPages = 0

  while (!openDone || mergedPages === 0) {
    if (context.signal?.aborted) throw new CommandCancelled()
    if (context.spent + requests + 1 > context.budget.maxRequests) throw new BudgetExhausted()
    requests += 1
    const variables = { owner, name, openCursor, mergedCursor }
    let page: Record<string, unknown>
    try {
      page = await transport.graphql(inboxQuery(basic ? BASIC_FIELDS : FULL_FIELDS), variables, {
        signal: context.signal,
      })
    } catch (error) {
      const detail = error instanceof GitHubTransportError ? error.detail : String(error)
      if (!basic && isSchemaRefusal(detail)) {
        // The host refused a field its schema does not carry. The narrower read
        // is the same read without the recent fields, so the rows survive with
        // review state honestly unknown rather than being lost.
        basic = true
        requests -= 1
        continue
      }
      throw error
    }
    if (context.signal?.aborted) throw new CommandCancelled()
    viewer ??= isRecord(page.viewer) ? nodeLogin(page.viewer) : null
    const repository = isRecord(page.repository) ? page.repository : null
    if (!repository) {
      throw new GitHubTransportError({
        kind: 'forbidden',
        detail: `${context.fullName} is not visible to the signed-in account on ${context.host.host}`,
      })
    }
    for (const [connection, isMerged] of [
      [repository.open, false],
      [repository.merged, true],
    ] as const) {
      if (!isRecord(connection)) continue
      const nodes = Array.isArray(connection.nodes) ? connection.nodes : []
      for (const node of nodes) {
        const item = inboxItem(node, {
          repository: context.fullName,
          path: context.target.path,
          host: context.host.host,
          basic,
        })
        if (!item || seen.has(item.number)) continue
        seen.add(item.number)
        items.push(item)
      }
      const cursor = nextCursor(connection, isMerged ? mergedCursor : openCursor)
      if (cursor === undefined) continue
      if (!isMerged) {
        openDone = cursor === null
        openCursor = cursor
      } else {
        if (cursor !== null) {
          mergedPages += 1
          if (mergedPages >= MERGED_PAGES) {
            truncated = true
            mergedCursor = null
          } else {
            mergedCursor = cursor
          }
        }
      }
    }
  }

  // Native stack membership rides the same host and the same pull request list,
  // so a row can show its layer without a second question to the person.
  if (context.spent + requests + NATIVE_STACK_READ_COST > context.budget.maxRequests) {
    throw new BudgetExhausted()
  }
  requests += NATIVE_STACK_READ_COST
  const stackPullRequests: PullRequest[] = items.map((item) => ({
    number: item.number,
    title: item.title,
    url: item.url,
    head: item.head,
    base: item.base,
    state: item.state,
    draft: item.draft,
    checks: item.checks,
  }))
  await loadRepositoryNativeStacks(context.target.originUrl, stackPullRequests, context.signal)
  const byNumber = new Map(items.map((item) => [item.number, item]))
  for (const pullRequest of stackPullRequests) {
    const item = byNumber.get(pullRequest.number)
    if (item && pullRequest.stack) item.stack = pullRequest.stack
  }

  for (const item of items) {
    item.groups = pullRequestInboxGroups(item, {
      viewer,
      now: context.now,
      mergedWithinDays: context.mergedWithinDays,
    })
  }
  return {
    items,
    viewer,
    status: 'ok',
    detail: basic
      ? `${context.host.host} does not report review decisions, the newest review, or check state for this repository.`
      : `${items.length} pull request${items.length === 1 ? '' : 's'}`,
    requests,
    truncated,
  }
}

export interface PullRequestInboxReadOptions {
  budget?: Partial<PullRequestInboxBudget>
  mergedWithinDays?: number
  /** The instant "recently" and the report timestamps are measured from. */
  now?: number
  signal?: AbortSignal
}

/**
 * Reads the PR Inbox across every registered repository.
 *
 * The read is budgeted twice: it refuses to start while GitHub's remaining
 * budget is below the reserve the repository sync already keeps, and it stops
 * mid-refresh once the per-refresh cap is spent, naming the repositories it did
 * not attempt. It is cancellable throughout, and a cancellation is raised
 * rather than answered so a superseded read never publishes.
 */
export async function readPullRequestInbox(
  targets: readonly PullRequestInboxTarget[],
  options: PullRequestInboxReadOptions = {},
): Promise<PullRequestInboxReport> {
  const budget: PullRequestInboxBudget = {
    ...DEFAULT_PULL_REQUEST_INBOX_BUDGET,
    ...options.budget,
  }
  const now = options.now ?? Date.now()
  const mergedWithinDays = options.mergedWithinDays ?? PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS
  const signal = options.signal
  const startedAt = new Date(now).toISOString()

  const repositories: PullRequestInboxRepositoryReport[] = []
  const items: PullRequestInboxItem[] = []
  const truncated: string[] = []
  const transports = new Map<string, GitHubTransport>()
  let viewer: string | null = null
  let requests = 0

  const allow = pullRequestInboxBudgetAllows(lastGitHubRateLimit().rateLimit.remaining, budget)
  let refused: { state: PullRequestInboxRefreshState; detail: string } | null = allow.allowed
    ? null
    : { state: 'rate-limited', detail: allow.reason }

  for (const target of targets) {
    if (signal?.aborted) throw new CommandCancelled()
    const remote = parseRemote(target.originUrl)
    const host = remoteHostContext(remote)
    const fullName = remote?.fullName ?? ''
    if (!remote || !host) {
      repositories.push({
        repository: fullName || target.path,
        path: target.path,
        host: null,
        status: 'not-github',
        detail: `The origin remote is ${
          target.originUrl
            ? 'not on a GitHub host'
            : 'not configured'
        }, so this repository has no pull requests here.`,
      })
      continue
    }
    if (refused) {
      repositories.push({
        repository: fullName,
        path: target.path,
        host: host.host,
        status: 'skipped',
        detail: refused.detail,
      })
      continue
    }
    let transport = transports.get(host.host)
    if (!transport) {
      transport = hostTransport(host)
      transports.set(host.host, transport)
    }
    try {
      const result = await readRepositoryInbox(
        {
          target,
          host,
          fullName,
          budget,
          spent: requests,
          mergedWithinDays,
          now,
          ...(signal ? { signal } : {}),
        },
        transport,
      )
      viewer ??= result.viewer
      requests += result.requests
      items.push(...result.items)
      if (result.truncated) truncated.push(fullName)
      repositories.push({
        repository: fullName,
        path: target.path,
        host: host.host,
        status: result.status,
        detail: result.detail,
      })
    } catch (error) {
      if (signal?.aborted || isCancelled(error)) throw new CommandCancelled()
      if (error instanceof BudgetExhausted) {
        refused = {
          state: 'rate-limited',
          detail: `This refresh reached its ${budget.maxRequests}-request budget, so the remaining repositories were not read.`,
        }
        repositories.push({
          repository: fullName,
          path: target.path,
          host: host.host,
          status: 'skipped',
          detail: refused.detail,
        })
        continue
      }
      const kind = error instanceof GitHubTransportError ? error.kind : 'unknown'
      const detail = error instanceof GitHubTransportError ? error.detail : String(error)
      const invisible = kind === 'invalid-response' && isInvisibleRepository(detail)
      const status: PullRequestInboxRepositoryStatus = invisible
        ? 'forbidden'
        : (STATUS_BY_KIND[kind] ?? 'skipped')
      const message = invisible
        ? `${fullName} is not visible to the signed-in account on ${host.host}`
        : detail
      if (status === 'unauthorized' || status === 'rate-limited') {
        refused ??= { state: REFRESH_STATE_BY_KIND[kind] ?? 'stale', detail: message }
      }
      repositories.push({
        repository: fullName,
        path: target.path,
        host: host.host,
        status,
        detail: message,
      })
    }
  }

  const state = derivePullRequestInboxState(repositories, refused)
  const confirmed = state === 'fresh' || state === 'partial'
  const detail =
    refused?.detail ??
    (state === 'fresh'
      ? `${repositories.length} registered repositor${repositories.length === 1 ? 'y' : 'ies'} read.`
      : 'No registered repository could be read.')
  return {
    refresh: {
      state,
      confirmedAt: confirmed ? new Date(now).toISOString() : null,
      checkedAt: startedAt,
      viewer,
      requests,
      budget,
      repositories,
      truncated,
      detail,
    },
    items: sortPullRequestInbox(items),
    mergedWithinDays,
  }
}

/**
 * Keeps the last confirmed Inbox so a failed refresh never empties the queue.
 *
 * This is the same rule the issue inbox already follows: a read that could not
 * answer keeps the rows GitHub last confirmed and says why they are
 * unconfirmed, rather than publishing an apparently empty queue. Cancellation
 * is not an outcome — it throws, so a superseded refresh publishes nothing.
 */
export class PullRequestInboxService {
  private confirmed: PullRequestInboxReport | null = null

  /** The last report GitHub confirmed, for a caller rendering before its read lands. */
  get lastConfirmed(): PullRequestInboxReport | null {
    return this.confirmed
  }

  async refresh(
    targets: readonly PullRequestInboxTarget[],
    options: PullRequestInboxReadOptions = {},
  ): Promise<PullRequestInboxReport> {
    const report = await readPullRequestInbox(targets, options)
    if (report.refresh.state === 'fresh' || report.refresh.state === 'partial') {
      this.confirmed = report
      return report
    }
    const kept = this.confirmed
    return {
      ...report,
      items: kept?.items ?? [],
      refresh: { ...report.refresh, confirmedAt: kept?.refresh.confirmedAt ?? null },
    }
  }
}
