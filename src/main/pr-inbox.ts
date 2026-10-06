import { isRecord } from '../shared/guards'
import { summariseCheckRollupState } from '../shared/pull-request-checks'
import {
  DEFAULT_PULL_REQUEST_INBOX_BUDGET,
  PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS,
  derivePullRequestInboxState,
  pullRequestInboxBudgetAllows,
  pullRequestInboxGroups,
  pullRequestInboxRefreshFailure,
  pullRequestInboxRepositoryStatusLabel,
  pullRequestInboxWindowEnd,
  sortPullRequestInbox,
  type PullRequestInboxBudget,
  type PullRequestInboxItem,
  type PullRequestInboxCount,
  type PullRequestInboxRepositoryReport,
  type PullRequestInboxRepositoryStatus,
  type PullRequestInboxReport,
} from '../shared/pr-inbox'
import type { PullRequest } from '../shared/types'
import { CommandCancelled, isCancelled, parseRemote } from './git-core'
import { hostTransport, remoteHostContext, type GitHubHostContext } from './github-host'
import {
  type GitHubErrorKind,
  type GitHubGraphqlOptions,
  type GitHubRateLimit,
  type GitHubRestRequest,
  type GitHubRestResponse,
  GitHubBudgetExhaustedError,
  GitHubTransportError,
  GitHubTransport,
  GitHubRateLimitReport,
  clearGitHubRetryDeadline,
  githubRetryDeadlineFor,
  lastGitHubRateLimitFor,
  resetGitHubRateLimit,
} from './github-transport'
import { loadRepositoryNativeStacks } from './native-stacks'

/** One registered repository the queue reads. */
export interface PullRequestInboxTarget {
  /** Absolute local path, as registered by the person or by a clone. */
  path: string
  /** The repository's `origin` remote URL, read by the caller. */
  originUrl: string | null
}

/** Fallbacks omit unsupported fields without changing the remaining query. */
const BASIC_FIELDS = `
    number title url headRefName headRefOid baseRefName isDraft state
    updatedAt mergedAt
    author { login }
    headRepository { nameWithOwner }
    reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } } } pageInfo { hasNextPage } }`
const MEMBERSHIP_FIELDS = `${BASIC_FIELDS}
    reviewDecision
    latestReviews(first: 1) { nodes { author { login } submittedAt } }
    comments(last: 1) { nodes { author { login } createdAt } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`
const FULL_FIELDS = `${MEMBERSHIP_FIELDS}
    additions deletions
    reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } }`

const OPEN_PAGE_SIZE = 100
const MERGED_PAGE_SIZE = 50
const MERGED_PAGES = 2
/**
 * One refresh's GitHub round trips, counted where they happen.
 *
 * Every call is charged before it is made: a request that fails, a narrower
 * query after the host refused a field, and every page of a REST collection
 * each cost what they actually cost. A fixed price per read, or a total summed
 * only from the repositories that succeeded, understates the spend of exactly
 * the paths that spend the most.
 */
class RefreshCharge {
  private spent = 0

  constructor(private readonly cap: number) {}

  /** Charges one round trip, refusing the call that would pass the cap. */
  take(): void {
    if (this.spent + 1 > this.cap) {
      throw new GitHubBudgetExhaustedError(
        `This refresh reached its ${this.cap}-request budget, so the remaining repositories were not read.`,
      )
    }
    this.spent += 1
  }

  get requests(): number {
    return this.spent
  }
}

/** Page size the charged REST walk asks for; a short page ends the walk. */
const REST_PAGE_SIZE = 100

/**
 * What each host's own responses last reported about its allowance.
 *
 * GitHub meters every host separately, so a count is only ever evidence about
 * the host that reported it: github.com's remaining allowance says nothing
 * about an enterprise host's, and neither says anything after that host's own
 * reset time. The queue therefore admits each host against what its own reads
 * observed rather than against one process-wide latest report.
 */
const hostAllowances = new Map<string, GitHubRateLimitReport>()

/**
 * The one key every allowance observation is filed and read under: this host,
 * this credential, and the resource it was counted against. A count filed
 * under any other scope is not evidence about this one, so no two of them can
 * stand in for each other.
 */
function allowanceKey(host: string, authority: string, resource?: string | null): string {
  return `${host.trim().toLowerCase()}\u0000${authority}\u0000${resource ?? ''}`
}

function rememberHostAllowance(
  host: string,
  rateLimit: GitHubRateLimit,
  at: number = Date.now(),
  authority?: string | null,
  kind: GitHubErrorKind | null = null,
): void {
  if (!authority) return
  hostAllowances.set(allowanceKey(host, authority, rateLimit.resource), {
    rateLimit,
    kind,
    at,
    authority,
  })
}

/**
 * This host's own allowance, from the observation that still describes the
 * window the next request lands in.
 *
 * `at` is when admission is being decided. A report whose own reset has passed
 * says what was true at an earlier moment of a window that has since ended, so
 * it is set aside; where another report for this host still describes a live
 * window, that one is what admission reads, however much more it allows.
 */
function hostAllowanceFor(
  host: string,
  at: number,
  authority?: string | null,
  resource: string = 'graphql',
): GitHubRateLimitReport | null {
  if (!authority) return null
  const live = (report: GitHubRateLimitReport | undefined): GitHubRateLimitReport | null => {
    if (report === undefined || report.at === 0) return null
    if (report.authority !== authority) return null
    // The moment this account's window ends. A report that names no window this
    // build can wait out, or one that has already ended, says what was true
    // while it lasted rather than what is true now.
    const until = pullRequestInboxWindowEnd({
      reset: report.rateLimit.reset,
      retryAfterSeconds: report.rateLimit.retryAfterSeconds,
      reportedAt: report.at,
    })
    if (until !== null && until <= at) return null
    // Only a primary refusal spends an account's allowance: that answer says this
    // window is empty for this account, whatever count it carried alongside, so
    // admission reads it as empty until the window passes. A secondary refusal is
    // the host refusing everyone at once — it is bounded by the shared wait every
    // account on that host is already held to, and a positive count in it is
    // still true of this account, so it is kept as the host reported it. A
    // refusal about a repository the credential cannot see is not about its
    // allowance either, and parks nothing.
    const spent = report.kind === 'rate-limited' && until !== null
    return spent ? { ...report, rateLimit: { ...report.rateLimit, remaining: 0 } } : report
  }
  // Seeded from this host's own last response for this authority, never from
  // another authority or host: a count another principal reported is not evidence
  // about this one, and refusing on it would hide a queue GitHub is serving.
  const own = lastGitHubRateLimitFor(host, authority, resource)
  const theirs = own.at === 0 ? null : live(own)
  // This refresh's own observation for this resource, or the one it recorded for
  // this host and credential before it was per-resource.
  const mine = live(
    hostAllowances.get(allowanceKey(host, authority, resource)) ??
      hostAllowances.get(allowanceKey(host, authority)),
  )
  if (theirs === null) return mine
  if (mine === null) return theirs
  // Between the two of them only this host and authority reported, so the newer report is the
  // one that describes the window the next request lands in: an ordinary
  // repository read can lower this host's allowance after a queue read raised
  // it.
  if (theirs.at > mine.at) return theirs
  if (mine.at > theirs.at) return mine
  // Two live reports from the same instant say the same thing about when, not
  // about how much is left, and the one that admits less is the one this build
  // can still defend.
  if (theirs.rateLimit.remaining === null) return mine
  if (mine.rateLimit.remaining === null) return theirs
  return theirs.rateLimit.remaining < mine.rateLimit.remaining ? theirs : mine
}

/**
 * Whether this server admits one more request, and the answer it read to say so.
 *
 * Admission is decided against the allowance this server's own last answer
 * described, in the window the request lands in: a host reached after a slow
 * read on another one is admitted against what is open when it is reached, not
 * against what was open when the refresh began.
 */
function admitsHost(
  destination: string,
  at: number,
  authority: string | null,
  budget: PullRequestInboxBudget,
  resource: string = 'graphql',
): { allowed: boolean; reason: string; reported: GitHubRateLimitReport | null } {
  const reported = hostAllowanceFor(destination, at, authority, resource)
  return {
    reported,
    ...pullRequestInboxBudgetAllows(reported?.rateLimit.remaining ?? null, budget, {
      reset: reported?.rateLimit.reset ?? null,
      now: at,
      retryAfterSeconds: reported?.rateLimit.retryAfterSeconds ?? null,
      reportedAt: reported?.at ?? 0,
    }),
  }
}

/** Clears all quota observations for isolated fixture runs. */
export function resetInboxHostAllowances(): void {
  hostAllowances.clear()
  resetGitHubRateLimit()
}

/**
 * The host transport with the refresh's counter in front of it.
 *
 * GraphQL, REST, and page-following all pass through here, so the native-stack
 * probe and every page its listing costs are charged the same as a queue page.
 * REST collections are walked a page at a time here rather than through the
 * transport's own follow-the-link walk, because a single charge for a read of
 * unknown length is the guess this budget exists to avoid: a short page ends the
 * walk, and the call that would pass the cap refuses before it is made.
 *
 * Every answer and every typed failure this host produced is remembered against
 * the destination it came from, which is the one host the transport publishes
 * under and the one this refresh admits on: an observation filed under the
 * origin host instead would sit in a bucket no later admission and no later
 * answer ever reads, and the host that actually served the request would be
 * asked again inside a quota it has already spent.
 */
function chargedTransport(
  destination: string,
  transport: GitHubTransport,
  charge: RefreshCharge,
  clock: () => number,
  budget: PullRequestInboxBudget,
): GitHubTransport {
  const observed = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      const answer = await call()
      // When this answer arrived, which is not when the request left: one read
      // spans several moments, and each answer belongs to the one it arrived in.
      // A wait the host names runs from the answer that carried it, so a clock
      // read before the request would shorten every wait by however long the
      // read took to reach the refusal. The report still states when this
      // refresh began.
      const reported = (answer as { rateLimit?: GitHubRateLimit } | null)?.rateLimit
      // Only the initiating request can attest to its credential. Looking up the
      // current credential after completion could label an old response as new.
      const authority = (answer as { authority?: string | null } | null)?.authority
      if (reported && authority) rememberHostAllowance(destination, reported, clock(), authority)
      return answer
    } catch (error) {
      if (error instanceof GitHubTransportError) {
        // The same moment for the same reason, and recorded with the refusal's
        // own kind: the allowance a host reported belongs to the credential that
        // read it, so it is kept against that credential here, and the wait it
        // implies is that credential's to serve. A host-wide wait is the
        // transport's to record, against the host, at the moment it read the
        // response — repeating it from a refusal that named no host would make
        // one account's exhausted window the whole host's.
        const at = clock()
        const authority = error.authority
        if (authority)
          rememberHostAllowance(destination, error.rateLimit, at, authority, error.kind)
      }
      throw error
    }
  }
  const rest = async <T>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> => {
    const authority = await transport.credentialAuthority()
    const admit = admitsHost(destination, clock(), authority, budget, 'core')
    if (!admit.allowed)
      throw new GitHubTransportError({
        kind: 'rate-limited',
        detail: admit.reason,
        rateLimit: admit.reported?.rateLimit,
        authority,
        // This queue decided not to ask, from the allowance it already recorded
        // for this host below. GitHub refused nothing, so this is not a host's
        // latest answer to publish process-wide: the allowance stays where it was
        // recorded, against this host.
      })
    charge.take()
    return observed(() => transport.rest<T>(request))
  }
  return {
    kind: transport.kind,
    destinationHost: transport.destinationHost,
    credentialAuthority: () => transport.credentialAuthority(),
    rest,
    async paginate<T = unknown>(request: GitHubRestRequest): Promise<T[]> {
      const [path, query = ''] = request.path.split('?')
      // The page this walk controls is not the page the caller named, so any
      // page or size it asked for is dropped before this walk adds its own.
      const params = new URLSearchParams(query)
      params.delete('page')
      params.delete('per_page')
      params.set('per_page', String(REST_PAGE_SIZE))
      const items: T[] = []
      for (let page = 1; ; page += 1) {
        params.set('page', String(page))
        const response = await rest<T[]>({ ...request, path: `${path}?${params.toString()}` })
        if (!Array.isArray(response.data)) return items
        items.push(...response.data)
        if (response.data.length < REST_PAGE_SIZE) return items
      }
    },
    graphql<T = Record<string, unknown>>(
      query: string,
      variables?: Record<string, unknown>,
      options?: GitHubGraphqlOptions,
    ): Promise<T> {
      charge.take()
      return observed(() => transport.graphql<T>(query, variables, options))
    },
  }
}

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

/** Pagination alone cannot establish a reviewer list that failed to decode. */
function reviewRequestsComplete(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !isRecord(value.pageInfo) ||
    value.pageInfo.hasNextPage !== false
  )
    return false
  return value.nodes.every((node) => {
    if (!isRecord(node) || !isRecord(node.requestedReviewer)) return false
    const reviewer = node.requestedReviewer
    if (reviewer.__typename === 'Team') return true
    return (
      (reviewer.__typename === undefined || reviewer.__typename === 'User') &&
      typeof reviewer.login === 'string' &&
      reviewer.login.trim().length > 0
    )
  })
}

/** The author of the most recent review or issue comment, whichever is later. */
function lastTurnAuthor(
  latestReviews: unknown,
  comments: unknown,
): { login: string | null; at: string | null } {
  const review =
    isRecord(latestReviews) && Array.isArray(latestReviews.nodes)
      ? latestReviews.nodes.find((node) => isRecord(node))
      : null
  const comment =
    isRecord(comments) && Array.isArray(comments.nodes)
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
    // The rollup is an object wrapping GitHub's own state; the classifier reads
    // that state, and anything it cannot read stays pending rather than being
    // reported as a passing check.
    return isRecord(node.commit.statusCheckRollup) ? [node.commit.statusCheckRollup.state] : []
  })
  if (rollups.length === 0) return 'none'
  const summaries = rollups.map((state) => summariseCheckRollupState(state))
  if (summaries.includes('failing')) return 'failing'
  if (summaries.includes('pending')) return 'pending'
  return 'passing'
}

/** Explicitly empty checks are known; missing or unreadable rollups are not. */
function inboxChecksKnown(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return false
  return value.nodes.every((node) => {
    if (!isRecord(node) || !isRecord(node.commit)) return false
    const rollup = node.commit.statusCheckRollup
    if (rollup === null) return true
    if (!isRecord(rollup)) return false
    return (
      rollup.state === 'SUCCESS' ||
      rollup.state === 'FAILURE' ||
      rollup.state === 'ERROR' ||
      rollup.state === 'PENDING' ||
      rollup.state === 'EXPECTED'
    )
  })
}

function inboxState(value: unknown, mergedAt: string | null): PullRequest['state'] {
  if (mergedAt) return 'MERGED'
  if (value === 'CLOSED' || value === 'MERGED') return value
  return 'OPEN'
}

function inboxChangeSize(
  additions: unknown,
  deletions: unknown,
  unsupported: boolean,
): PullRequestInboxCount {
  if (unsupported) return { state: 'unsupported' }
  if (
    typeof additions !== 'number' ||
    !Number.isSafeInteger(additions) ||
    additions < 0 ||
    typeof deletions !== 'number' ||
    !Number.isSafeInteger(deletions) ||
    deletions < 0 ||
    !Number.isSafeInteger(additions + deletions)
  )
    return { state: 'unknown' }
  return { state: 'known', value: additions + deletions }
}

function inboxThreadCount(value: unknown, unsupported: boolean): PullRequestInboxCount {
  if (unsupported) return { state: 'unsupported' }
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !isRecord(value.pageInfo) ||
    typeof value.pageInfo.hasNextPage !== 'boolean'
  )
    return { state: 'unknown' }
  let count = 0
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.isResolved !== 'boolean') return { state: 'unknown' }
    if (!node.isResolved) count += 1
  }
  return { state: value.pageInfo.hasNextPage ? 'truncated' : 'known', value: count }
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
    countsUnsupported?: boolean
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
  const countsUnsupported = context.basic || context.countsUnsupported === true
  return {
    number,
    title,
    url,
    head: headRefName,
    base: baseRefName,
    state: inboxState(node.state, mergedAt),
    draft: node.isDraft === true,
    // A host that did not report check state has not reported a repository with
    // pending checks either. `metadata` is what says so; the badge reads it
    // rather than rendering this as a real result.
    checks: context.basic ? 'none' : inboxChecks(node.commits),
    ...(typeof node.headRefOid === 'string' ? { headOid: node.headRefOid } : {}),
    ...(headRepository ? { headRepository } : {}),
    repository: context.repository,
    repositoryPath: context.path,
    host: context.host,
    author: nodeLogin(node.author),
    reviewRequested: requestedLogins(node.reviewRequests),
    reviewRequestsComplete: reviewRequestsComplete(node.reviewRequests),
    reviewDecision: context.basic
      ? null
      : typeof node.reviewDecision === 'string'
        ? node.reviewDecision
        : null,
    metadata: context.basic ? 'degraded' : 'full',
    reviewKnown:
      !context.basic &&
      (node.reviewDecision === null ||
        node.reviewDecision === 'APPROVED' ||
        node.reviewDecision === 'CHANGES_REQUESTED' ||
        node.reviewDecision === 'REVIEW_REQUIRED'),
    checksKnown: !context.basic && inboxChecksKnown(node.commits),
    changeSize: inboxChangeSize(node.additions, node.deletions, countsUnsupported),
    unresolvedThreads: inboxThreadCount(node.reviewThreads, countsUnsupported),
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
  truncated: boolean
}

interface RepositoryReadContext {
  target: PullRequestInboxTarget
  host: GitHubHostContext
  fullName: string
  mergedWithinDays: number
  now: number
  /** Rows this refresh has already taken, so one pull request is never read twice. */
  seen: Set<string>
  signal?: AbortSignal
}

/**
 * One pull request's identity across the whole queue: the host it was read from,
 * its repository in GitHub's own case-insensitive spelling, and its number.
 * Two registered clones of the same remote name one pull request, not two, and
 * repositories of the same name on different hosts are different pull requests.
 */
function inboxItemKey(host: string, fullName: string, number: number): string {
  return `${host.toLowerCase()}/${fullName.toLowerCase()}#${number}`
}

/**
 * Reads one repository's Inbox rows, spending at most the requests the refresh
 * has left. Every call is charged before it is made, so a repository with a very
 * long history, a refused field, or a native-stack listing cannot consume the
 * whole budget and starve the repositories after it: the call that would exceed
 * the cap stops this repository instead.
 *
 * Completion of each listing is tracked on its own. A repository with fewer
 * merged pull requests than one page answers `hasNextPage: false` on its first
 * response, and a loop that waited for a cursor that will never come would ask
 * the same question again until the budget refused it.
 */
async function readRepositoryInbox(
  context: RepositoryReadContext,
  transport: GitHubTransport,
): Promise<RepositoryReadResult> {
  const { owner, name } = parseRemote(context.target.originUrl) ?? { owner: '', name: '' }
  const items: PullRequestInboxItem[] = []
  let viewer: string | null = null
  let basic = false
  let countsUnsupported = false
  let truncated = false
  let openCursor: string | null = null
  let mergedCursor: string | null = null
  let openDone = false
  let mergedDone = false
  let mergedPages = 0

  while (!openDone || !mergedDone) {
    if (context.signal?.aborted) throw new CommandCancelled()
    const variables = { owner, name, openCursor, mergedCursor }
    let page: Record<string, unknown>
    try {
      page = await transport.graphql(
        inboxQuery(basic ? BASIC_FIELDS : countsUnsupported ? MEMBERSHIP_FIELDS : FULL_FIELDS),
        variables,
        {
          signal: context.signal,
        },
      )
    } catch (error) {
      const detail = error instanceof GitHubTransportError ? error.detail : String(error)
      if (!basic && isSchemaRefusal(detail)) {
        // Optional counts must not remove the established membership facts.
        if (!countsUnsupported && /additions|deletions|reviewThreads/u.test(detail))
          countsUnsupported = true
        else basic = true
        continue
      }
      throw error
    }
    if (context.signal?.aborted) throw new CommandCancelled()
    const pageViewer = isRecord(page.viewer) ? nodeLogin(page.viewer) : null
    if (viewer !== null && pageViewer !== null && viewer !== pageViewer) {
      // The credential behind this host answered a later page as somebody else.
      // Switching a `gh` account changes the credentials every later request
      // uses without any other signal reaching the app, so this page is the only
      // evidence that the two pages describe two principals. Rows read under one
      // cannot be grouped under the other, so the whole read is raised instead
      // of published.
      throw new CommandCancelled()
    }
    viewer ??= pageViewer
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
          countsUnsupported,
        })
        if (!item) continue
        const key = inboxItemKey(context.host.host, context.fullName, item.number)
        if (context.seen.has(key)) continue
        context.seen.add(key)
        items.push(item)
      }
      const cursor = nextCursor(connection, isMerged ? mergedCursor : openCursor)
      if (cursor === undefined) continue
      if (!isMerged) {
        openDone = cursor === null
        openCursor = cursor
        continue
      }
      // A merged listing that ends here is finished however many pages it took;
      // only a listing with more to read moves to the next one, and the last
      // page this read is allowed to ask for bounds it rather than losing it.
      if (cursor === null) {
        mergedDone = true
        continue
      }
      mergedPages += 1
      if (mergedPages >= MERGED_PAGES) {
        truncated = true
        mergedDone = true
        continue
      }
      mergedCursor = cursor
    }
  }

  // Native stack membership rides the same host and the same pull request list,
  // so a row can show its layer without a second question to the person. Its
  // probe and every page of its listing are charged like any other request.
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
  await loadRepositoryNativeStacks(
    context.target.originUrl,
    stackPullRequests,
    context.signal,
    transport,
  )
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
    // A read that named no account cannot say whose queue these rows are, and
    // every group that depends on that is left undecided rather than filled in
    // as if the person were somebody else. That is stated ahead of a narrowed
    // read: the rows are real either way, and this is the reason the queue is
    // not showing them as work.
    status: viewer === null ? 'membership-unknown' : basic ? 'degraded' : 'ok',
    detail:
      viewer === null
        ? `${context.host.host} named no signed-in account for these rows, so the queue cannot say whose work they are.`
        : basic
          ? `${context.host.host} does not report review decisions, the newest review, or check state for this repository.`
          : `${items.length} pull request${items.length === 1 ? '' : 's'}`,
    truncated,
  }
}

export interface PullRequestInboxReadOptions {
  budget?: Partial<PullRequestInboxBudget>
  mergedWithinDays?: number
  /** The instant "recently" and the report timestamps are measured from. */
  now?: number
  /**
   * When each answer or typed failure arrived, for the allowance and the wait
   * this read records. A read spans more than one moment, and only this says
   * which of them a host's answer belongs to.
   */
  clock?: () => number
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
  const clock = options.clock ?? (() => Date.now())
  const mergedWithinDays = options.mergedWithinDays ?? PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS
  const signal = options.signal
  const startedAt = new Date(now).toISOString()

  const repositories: PullRequestInboxRepositoryReport[] = []
  const items: PullRequestInboxItem[] = []
  const truncated: string[] = []
  const seen = new Set<string>()
  /**
   * One charged transport per origin host this refresh reads for. The charge
   * is this refresh's own and every wrapper here spends it, so how many
   * wrappers exist does not change what any request is counted against. What it
   * does change is the transport underneath: two origins whose bases resolve to
   * one server are still two credentials and two GraphQL endpoints, and
   * reusing the first origin's wrapper would read the second origin's
   * repositories as the first one's principal, against endpoints the second
   * host never named.
   */
  const transports = new Map<string, GitHubTransport>()
  const charge = new RefreshCharge(budget.maxRequests)
  /**
   * One login per origin host, because an origin host is one credential. Two
   * are two accounts, and each one's rows are grouped against its own viewer,
   * so the queue-level login is only stated when every host that reported one
   * agrees.
   */
  const viewersByHost = new Map<string, string>()
  let viewer: string | null = null
  let hostsDisagree = false

  /**
   * The one limit every host shares: this refresh's own request cap. It is
   * spent by this build and by nothing else, so once it is gone no further
   * repository is read regardless of how much allowance any host still has.
   */
  let exhausted: string | null = null
  /**
   * What this refresh could not get past, and why. A rejected credential is a
   * fact about the credential this app resolved for one origin, so it is filed
   * under that origin: two hosts served by one base are two authentications,
   * and one of them being refused says nothing about whether the other's token
   * is any good. A host that refused on its own quota is a fact about the
   * server, so that is filed under the destination every host it serves shares.
   */
  const rejectedHosts = new Map<string, string>()
  const pausedServers = new Map<string, string>()
  const refusedPrincipals = new Map<string, string>()

  for (const entry of inboxReadTargets(targets)) {
    if (signal?.aborted) throw new CommandCancelled()
    const { target, host, fullName } = entry
    /**
     * One repository's line in the refresh report, however this read ended for
     * it. A repository whose origin named a GitHub host is filed under that
     * name and that host; one that named no GitHub host keeps the local path it
     * was registered under, because there is no shared identity to file it by.
     */
    const report = (
      status: PullRequestInboxRepositoryStatus,
      detail: string,
      readAs: string | null = null,
    ): void => {
      repositories.push({
        repository: fullName || target.path,
        path: target.path,
        host: host?.host ?? null,
        status,
        viewer: readAs,
        detail,
      })
    }
    if (!host) {
      report(
        'not-github',
        `The origin remote is ${
          target.originUrl ? 'not on a GitHub host' : 'not configured'
        }, so this repository has no pull requests here.`,
      )
      continue
    }
    // The host that will actually answer, resolved before anything is admitted.
    // The host this repository's origin names is where its rows are filed; the
    // host serving the base is where the allowance and the wait are published
    // and where the request lands. An operator who points a base at another
    // host makes those two different names for one server, and admitting on the
    // origin would consult a bucket nothing writes to — reading a server whose
    // reserve and wait this process is already inside. So one key runs the whole
    // way: admission here, the charged observations this refresh records, and
    // the transport's own publication.
    const serving = hostTransport(host)
    const destination = serving.destinationHost
    const rejected = rejectedHosts.get(host.host) ?? pausedServers.get(destination)
    if (rejected || exhausted) {
      report(
        'skipped',
        rejected ??
          `This refresh reached its ${budget.maxRequests}-request budget, so the remaining repositories were not read.`,
      )
      continue
    }
    // Admission is this server's own, and it is decided now rather than at the
    // start of the read: one refresh spans several moments, and a host reached
    // after a slow read on another one is admitted against the window that is
    // open when it is reached, not against the one that was open when the
    // refresh began. The report still states when the refresh began.
    const admittedAt = clock()
    // A host that named a moment for coming back is believed until then, on
    // every refresh and not only the one that met the refusal: a manual
    // refresh that arrives inside that window asks again too early and earns
    // the same answer. Another host's wait says nothing about this one.
    const until = githubRetryDeadlineFor(destination)
    if (until !== null && until > admittedAt) {
      const reason = `${destination} asked to be left alone until ${new Date(until).toISOString()}`
      pausedServers.set(destination, reason)
      report('rate-limited', reason)
      continue
    }
    if (until !== null) clearGitHubRetryDeadline(destination)
    // The allowance this server last reported, in the window that report belongs
    // to. A count another host reported, or one from a window that has since
    // reset, is not evidence about what this host will answer now.
    const authority = await serving.credentialAuthority().catch(() => null)
    const principalKey = authority ? allowanceKey(destination, authority, 'graphql') : null
    const principalRefused = principalKey ? refusedPrincipals.get(principalKey) : null
    if (principalRefused) {
      report('rate-limited', principalRefused)
      continue
    }
    const admit = admitsHost(destination, admittedAt, authority, budget)
    if (!admit.allowed) {
      if (principalKey) refusedPrincipals.set(principalKey, admit.reason)
      report('rate-limited', admit.reason)
      continue
    }
    // One charged wrapper per origin host rather than per destination. What the
    // wrapper spends is this refresh's single charge either way, so sharing one
    // server never splits a quota in half; but the transport inside is the one
    // resolved for the host whose repositories are being read, with its own
    // credential and its own GraphQL endpoint, and the allowance it records is
    // still filed under the destination the transport publishes under.
    let transport = transports.get(host.host)
    if (!transport) {
      transport = chargedTransport(destination, serving, charge, clock, budget)
      transports.set(host.host, transport)
    }
    try {
      const result = await readRepositoryInbox(
        {
          target,
          host,
          fullName,
          mergedWithinDays,
          now,
          seen,
          ...(signal ? { signal } : {}),
        },
        transport,
      )
      const seenViewer = viewersByHost.get(host.host)
      if (seenViewer !== undefined && result.viewer !== null && seenViewer !== result.viewer) {
        // One host, two logins: the credential this app resolved for it was
        // replaced between the two repositories, so these rows were read for
        // different principals inside one host's own queue. Raising beats a
        // queue nobody can act on. Two hosts sharing one API server are not
        // this case — they are two credentials, and each is compared only
        // against its own host's earlier read.
        throw new CommandCancelled()
      }
      if (result.viewer !== null) {
        viewersByHost.set(host.host, result.viewer)
        // Two hosts with two logins is ordinary: an enterprise host is a
        // different account from github.com, and so is a second origin that
        // happens to be served by one API base. What would mislead is naming
        // one of them as the viewer of rows the other read, so the queue-level
        // login is stated only when they agree.
        if (viewer !== null && viewer !== result.viewer) hostsDisagree = true
        viewer ??= result.viewer
      }
      items.push(...result.items)
      if (result.truncated) truncated.push(fullName)
      report(result.status, result.detail, result.viewer)
    } catch (error) {
      if (signal?.aborted || isCancelled(error)) throw new CommandCancelled()
      if (error instanceof GitHubBudgetExhaustedError) {
        exhausted = error.message
        report('skipped', exhausted)
        continue
      }
      const kind = error instanceof GitHubTransportError ? error.kind : 'unknown'
      const detail = error instanceof GitHubTransportError ? error.detail : String(error)
      const invisible = kind === 'invalid-response' && isInvisibleRepository(detail)
      // The request was made and answered with something this build cannot
      // classify, which is not the same as never having attempted it. Only
      // admission, configuration and the request cap skip a read that was never
      // made.
      const status: PullRequestInboxRepositoryStatus = invisible
        ? 'forbidden'
        : (STATUS_BY_KIND[kind] ?? 'failed')
      const message = invisible
        ? `${fullName} is not visible to the signed-in account on ${host.host}`
        : detail
      if (status === 'unauthorized') rejectedHosts.set(host.host, message)
      // This server refused on its own quota. Only its own repositories are
      // affected: another host still has whatever allowance it reported, and
      // hiding it here would replace a readable queue with an empty one.
      if (status === 'rate-limited') {
        const retryUntil = githubRetryDeadlineFor(destination)
        if (retryUntil !== null && retryUntil > admittedAt) {
          pausedServers.set(destination, message)
        } else if (error instanceof GitHubTransportError && error.authority) {
          refusedPrincipals.set(
            allowanceKey(destination, error.authority, error.rateLimit.resource ?? 'graphql'),
            message,
          )
        }
      }
      report(status, message)
    }
  }

  // Nothing was read only when no repository answered; which failure that was
  // is decided by the repositories themselves, so an unreachable host is not
  // reported as credentials that cannot see anything.
  const failure = pullRequestInboxRefreshFailure(
    repositories,
    exhausted === null ? null : { state: 'rate-limited', detail: exhausted },
  )
  const state = derivePullRequestInboxState(repositories, failure)
  const confirmed = state === 'fresh' || state === 'partial'
  const detail =
    failure?.detail ??
    (state === 'fresh'
      ? `${repositories.length} registered repositor${repositories.length === 1 ? 'y' : 'ies'} read.`
      : state === 'partial'
        ? partialReadDetail(repositories)
        : 'No registered repository could be read.')
  return {
    refresh: {
      state,
      confirmedAt: confirmed ? new Date(now).toISOString() : null,
      checkedAt: startedAt,
      viewer: hostsDisagree ? null : viewer,
      requests: charge.requests,
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
 * What a read that answered for some repositories could not establish for the
 * others. Each one is named with its own reason, because "no repository could
 * be read" is false for a read that did read some of them, and a queue that
 * read nothing usable is not the problem this is.
 */
function partialReadDetail(repositories: readonly PullRequestInboxRepositoryReport[]): string {
  return `Read with less than the queue asks for: ${repositories
    .filter((report) => report.status !== 'ok')
    .map(
      (report) => `${report.repository} (${pullRequestInboxRepositoryStatusLabel(report.status)})`,
    )
    .join(', ')}.`
}

/** One registered repository this refresh reads, with the GitHub facts it names. */
interface InboxReadTarget {
  target: PullRequestInboxTarget
  host: GitHubHostContext | null
  fullName: string
  key: string
}

/**
 * The repositories this refresh will read, deduplicated.
 *
 * Registering several local clones or worktrees of one remote is supported, and
 * `remember` keeps them as separate entries. They are one GitHub repository
 * though: reading each of them would show every pull request twice, double every
 * group count, and spend the budget twice for one answer. The lowest local path
 * is kept, so the row a person opens is the same repository on every run. A
 * repository whose origin is not on a GitHub host has no shared identity to
 * collapse on, so each one is kept as it was registered.
 */
function inboxReadTargets(targets: readonly PullRequestInboxTarget[]): InboxReadTarget[] {
  const chosen = new Map<string, InboxReadTarget>()
  for (const target of targets) {
    const remote = parseRemote(target.originUrl)
    const host = remoteHostContext(remote)
    const fullName = remote?.fullName ?? ''
    const entry: InboxReadTarget = {
      target,
      host,
      fullName,
      key:
        remote && host ? inboxItemKey(host.host, fullName, 0).slice(0, -1) : `local:${target.path}`,
    }
    const current = chosen.get(entry.key)
    if (current && current.target.path <= target.path) continue
    chosen.set(entry.key, entry)
  }
  return [...chosen.values()]
}

/**
 * Keeps the last confirmed Inbox so a failed refresh never empties the queue.
 *
 * This is the same rule the issue inbox already follows: a read that could not
 * answer keeps the rows GitHub last confirmed and says why they are
 * unconfirmed, rather than publishing an apparently empty queue. Cancellation
 * is not an outcome — it throws, so a superseded refresh publishes nothing.
 *
 * Those retained rows belong to one identity: the account and credential that
 * read them, and the registered repositories they were read from. A sign-out, a
 * different account on the same host, or a changed repository list drops them,
 * and a refresh still running when the identity changes publishes nothing at
 * all rather than answering for the identity that replaced it.
 */
export class PullRequestInboxService {
  private confirmed: PullRequestInboxReport | null = null
  private identity: string | null = null
  private targets: string | null = null

  /**
   * The signed-in identity, as the caller sees it. It changes when the account,
   * its credential, or the selected host changes; callers with no account at all
   * report one constant identity.
   */
  constructor(
    private readonly identityOf: () => string | Promise<string> = () => '',
    /**
     * The registered repositories as they stand now, or null when this owner
     * publishes no live list. It is resolved again when a read completes, so a
     * registration that changed while the read was in flight retires the
     * answer instead of publishing it against a stale list. With no live list
     * there is nothing to compare, and the list the read was handed is it.
     */
    private readonly currentTargets:
      | (() => Promise<readonly PullRequestInboxTarget[]>)
      | null = null,
  ) {}

  /** Drops the retained rows at an identity boundary rather than keeping them. */
  invalidate(): void {
    this.confirmed = null
    this.identity = null
    this.targets = null
  }

  async refresh(
    targets: readonly PullRequestInboxTarget[],
    options: PullRequestInboxReadOptions = {},
  ): Promise<PullRequestInboxReport> {
    const identity = await this.identityOf()
    const targetSet = inboxTargetSet(targets)
    const report = await readPullRequestInbox(targets, options)
    // The registered repositories are resolved again rather than hashed from
    // the array this read was handed: `inboxTargets` builds a new array every
    // time and `remember` replaces the list behind it, so re-hashing the
    // captured argument would compare a list with itself and could never notice
    // a repository that was registered or dropped while the read was in flight.
    const live = this.currentTargets ? await this.currentTargets() : null
    // Asked again after that await, not only before it: a request cancelled or
    // superseded while the live list was resolving reaches here with the same
    // identity and the same targets, and would otherwise publish the abandoned
    // answer or relabel a newer confirmed cache with an older read.
    if (options.signal?.aborted) throw new CommandCancelled()
    if (
      (await this.identityOf()) !== identity ||
      (this.currentTargets !== null && inboxTargetSet(live ?? []) !== targetSet)
    ) {
      // The account was replaced, or the registered repositories changed, while
      // this read was in flight. Its rows were read for a queue that no longer
      // exists, so the read is raised rather than published or kept.
      throw new CommandCancelled()
    }
    // Asked again after that last await rather than only before it. Reading the
    // identity is asynchronous, so a request cancelled or superseded while it
    // was resolving reaches here with the same identity, the same targets and
    // nothing to notice — and would otherwise commit the abandoned answer to the
    // cache, or answer a newer caller with a report it has already moved past.
    if (options.signal?.aborted) throw new CommandCancelled()
    if (report.refresh.state === 'fresh' || report.refresh.state === 'partial') {
      this.identity = identity
      this.targets = targetSet
      this.confirmed = report
      return report
    }
    // A read that could not answer may keep only the rows GitHub confirmed for
    // these same repositories under this same identity. Relabelling them with
    // another set's targets would answer one repository list with another's
    // pull requests.
    if (this.identity !== identity || this.targets !== targetSet) this.invalidate()
    return {
      ...report,
      items:
        this.confirmed?.items.map((item) => ({
          ...item,
          changeSize: { state: 'stale' },
          unresolvedThreads: { state: 'stale' },
        })) ?? [],
      refresh: { ...report.refresh, confirmedAt: this.confirmed?.refresh.confirmedAt ?? null },
    }
  }
}

/**
 * The queue as it stands when a read was ended before it confirmed anything.
 *
 * A read that is retired for that reason carries no rows at all: the rows it
 * would have produced were read by an identity that is no longer the one
 * asking, and the rows an earlier read confirmed are equally not this
 * identity's. Nothing from either read is carried forward — not the rows, not
 * the repositories, not the login — so this report cannot describe anything
 * the next read has not confirmed.
 *
 * It is a report rather than a thrown failure because the window is entitled to
 * keep what it already holds for a read that genuinely could not answer. This
 * read is not that case, and a failure the window treats as "keep the last
 * confirmed rows" would be exactly the wrong thing to do with it.
 */
export function retiredPullRequestInboxReport(
  mergedWithinDays: number,
  now: Date = new Date(),
): PullRequestInboxReport {
  return {
    refresh: {
      state: 'retired',
      confirmedAt: null,
      checkedAt: now.toISOString(),
      viewer: null,
      requests: 0,
      budget: DEFAULT_PULL_REQUEST_INBOX_BUDGET,
      repositories: [],
      truncated: [],
      // Says what happened to this read and nothing about the person: nobody
      // signed out, nothing became unreachable, and the queue was not empty
      // when it was last read.
      detail:
        'This read ended before it confirmed anything, so it is not describing the current queue. Refresh to read the queue as it is now.',
    },
    items: [],
    mergedWithinDays,
  }
}

/**
 * What one set of targets amounts to, so a caller holding the registered
 * repositories can be told whether the set it was asked about still stands.
 */
export function inboxTargetSet(targets: readonly PullRequestInboxTarget[]): string {
  return inboxReadTargets(targets)
    .map((entry) => `${entry.key}\u0000${entry.target.path}`)
    .sort()
    .join('\n')
}
