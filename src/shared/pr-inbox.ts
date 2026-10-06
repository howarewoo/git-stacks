/**
 * The PR Inbox: a GitHub-derived triage queue for pull requests across every
 * registered repository.
 *
 * It is deliberately not GitHub's notification inbox. Nothing here reads a
 * notification, a subscription, a release, or a discussion, and no classic
 * notification scope is required to see any of it: every fact below comes from
 * the pull request, review, and check data the app already reads through a
 * host-aware transport. The queue answers "what pull request work is waiting on
 * me?"; the notification inbox answers "what did GitHub decide to tell me?",
 * and the two disagree often enough that borrowing its name would be a lie.
 *
 * Every rule in this file is pure and total. The same GitHub facts always
 * produce the same groups, the same filters, and the same state, so the
 * membership a person reads is the membership the tests assert.
 */

import type { PullRequest } from './types'

/** The six default groups, in triage order rather than alphabetical order. */
export type PullRequestInboxGroupId =
  | 'review-requested'
  | 'needs-response'
  | 'my-prs-waiting'
  | 'my-prs-approved'
  | 'drafts'
  | 'recently-merged'

export interface PullRequestInboxGroup {
  id: PullRequestInboxGroupId
  label: string
  /**
   * The rule, in the words a person would use. This sentence is the contract:
   * the group rail reads it as row help, README documents it, and the membership
   * tests assert the same facts it names.
   */
  rule: string
}

/**
 * Membership rules, in full. Read them as a decision list, top to bottom:
 *
 * 1. A pull request's *state* and *draft flag* come from GitHub and are never
 *    inferred. `open` is `state === 'OPEN'`; merged is `state === 'MERGED'`.
 * 2. The *viewer* is the authenticated login the host reported for this read.
 *    Logins are compared case-insensitively, because GitHub treats them that
 *    way. A read with no viewer cannot place a pull request in a viewer-relative
 *    group and says so rather than guessing an author.
 * 3. *Authored* means the pull request's author login equals the viewer.
 * 4. *Requested* means the viewer's login appears in the pull request's direct
 *    review requests. A team review request is not a direct request, so a team
 *    review never puts a pull request in a viewer's group on its own.
 * 5. *Last turn* is the author of the most recent review or issue comment, and
 * 6. *Metadata* is which of those facts this read actually obtained. A host that
 *    refuses the review, comment, and check fields answers a degraded read, and
 *    a degraded read cannot decide the three groups those fields would decide.
 *
 * With those facts:
 *
 * - **Review requested** — open, not a draft, directly review-requested from
 *   the viewer, and not authored by the viewer. A pull request you opened
 *   yourself is your work, not a review you owe, so asking yourself for review
 *   never lands here.
 * - **Needs my response** — open, not a draft, authored by the viewer, and
 *   either the review decision is `CHANGES_REQUESTED`, or the last turn on it
 *   belongs to somebody else. A pull request nobody has spoken on is not waiting
 *   on you, and a draft is not unfinished *silence*: **Drafts** is where a draft
 *   belongs, alone, so a draft is never in two groups at once.
 * - **My PRs — waiting** — open, authored by the viewer, not a draft, not
 *   already needing a response, and not approved. "Waiting" means the queue is
 *   with reviewers, so a pull request that is waiting on you is excluded rather
 *   than counted twice.
 * - **My PRs — approved** — open, authored by the viewer, not a draft, and the
 *   review decision is `APPROVED`.
 * - **Drafts** — open and a draft, whoever authored it. A draft is unfinished
 *   work rather than finished work waiting for review, so it never appears in a
 *   review group.
 * - **Recently merged** — merged, and merged within the recent window measured
 *   from the read's own clock. The window is a parameter, never `Date.now()`
 *   inside a rule, so a test states the instant it is reasoning about.
 *
 * Exactly one overlap is intentional: a pull request can be in **My PRs —
 * approved** and **Needs my response** at the same time. The two answer
 * different questions — what the reviewers decided, and who owes the next turn
 * — and a pull request that was approved and then commented on is genuinely
 * both. Every other pair is disjoint, and `inboxGroupOverlapsAllowed` names the
 * one allowed pair so a test can hold the rest closed.
 */
export const PULL_REQUEST_INBOX_GROUPS: readonly PullRequestInboxGroup[] = [
  {
    id: 'review-requested',
    label: 'Review requested',
    rule: 'Open, not a draft, directly review-requested from you, and not authored by you.',
  },
  {
    id: 'needs-response',
    label: 'Needs my response',
    rule: 'Open, not a draft, authored by you, and either changes were requested or the last review or comment is somebody else’s.',
  },
  {
    id: 'my-prs-waiting',
    label: 'My PRs — waiting',
    rule: 'Open, authored by you, not a draft, not waiting on your reply, and not approved.',
  },
  {
    id: 'my-prs-approved',
    label: 'My PRs — approved',
    rule: 'Open, authored by you, not a draft, and GitHub’s review decision is approved.',
  },
  {
    id: 'drafts',
    label: 'Drafts',
    rule: 'Open and a draft, whoever opened it. Drafts are never in a review group.',
  },
  {
    id: 'recently-merged',
    label: 'Recently merged',
    rule: 'Merged within the recent window, which is 30 days unless the read says otherwise.',
  },
]

/** Default recent-merge window, in days. */
export const PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS = 30

/**
 * How often the queue reads GitHub while its destination is on screen. The
 * queue spans every registered repository, so it reads far less often than the
 * repository remote read it sits beside, and it never reads at all while the
 * window is hidden.
 */
export const PULL_REQUEST_INBOX_REFRESH_MS = 60_000

const GROUP_IDS: readonly PullRequestInboxGroupId[] = PULL_REQUEST_INBOX_GROUPS.map(
  (group) => group.id,
)

/** Static group id to label, so a row never spells a group a second way. */
const GROUP_LABEL: Record<PullRequestInboxGroupId, string> = {
  'review-requested': 'Review requested',
  'needs-response': 'Needs my response',
  'my-prs-waiting': 'My PRs — waiting',
  'my-prs-approved': 'My PRs — approved',
  drafts: 'Drafts',
  'recently-merged': 'Recently merged',
}

/**
 * The one pair of groups a pull request may belong to at the same time, stated
 * from both sides so membership either way is a lookup rather than a special
 * case. Every other pair is disjoint by rule.
 */
const ALLOWED_OVERLAP: Record<string, readonly PullRequestInboxGroupId[]> = {
  'my-prs-approved': ['needs-response'],
  'needs-response': ['my-prs-approved'],
}

export function isPullRequestInboxGroupId(value: unknown): value is PullRequestInboxGroupId {
  return typeof value === 'string' && (GROUP_IDS as readonly string[]).includes(value)
}

export function pullRequestInboxGroupLabel(id: PullRequestInboxGroupId): string {
  return GROUP_LABEL[id]
}

export function inboxGroupOverlapsAllowed(
  first: PullRequestInboxGroupId,
  second: PullRequestInboxGroupId,
): boolean {
  return first !== second && (ALLOWED_OVERLAP[first]?.includes(second) ?? false)
}

/** GitHub logins compare case-insensitively, so every comparison normalises. */
function login(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return trimmed ? trimmed : null
}

/**
 * Which of the recent facts a read actually obtained.
 *
 * `degraded` means the host answered without the review, comment, and check
 * fields its schema does not carry. Every other field is real, and the ones it
 * could not read are unknown rather than absent: a missing review decision is
 * not "nobody reviewed it", and a row that says so may not be grouped as if it
 * were.
 */
export type PullRequestInboxMetadata = 'full' | 'degraded'

/**
 * The facts one pull request contributes to group membership. This is the whole
 * input to the rules: a field this interface does not carry cannot influence a
 * group, so membership cannot drift with a field the rules never read.
 */
export interface PullRequestInboxSignals {
  state: PullRequest['state']
  draft: boolean
  author: string | null
  /** Logins the pull request directly asked for review. */
  reviewRequested: readonly string[]
  /** GitHub's own `reviewDecision`: `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null. */
  reviewDecision: string | null
  /** Author of the most recent review or issue comment; null when there is neither. */
  lastTurnLogin: string | null
  updatedAt: string | null
  mergedAt: string | null
  /** Which recent facts this read obtained; a degraded read decides fewer groups. */
  metadata: PullRequestInboxMetadata
}

/**
 * One pull request in the Inbox: the shared {@link PullRequest} shape plus the
 * repository it belongs to and the facts its groups were decided from.
 */
export type PullRequestInboxCount =
  | { state: 'known' | 'truncated'; value: number }
  | { state: 'unknown' | 'unsupported' | 'stale' }

export interface PullRequestInboxItem extends Omit<PullRequest, 'reviewDecision'> {
  /** `owner/name` of the registered repository whose origin serves it. */
  repository: string
  /** Absolute local path of that registered repository. */
  repositoryPath: string
  /** The GitHub host that answered for it. */
  host: string
  author: string | null
  reviewRequested: readonly string[]
  reviewRequestsComplete?: boolean
  reviewDecision: string | null
  lastTurnLogin: string | null
  updatedAt: string | null
  mergedAt: string | null
  /** Which recent facts this read obtained; a degraded read shows unknown, not absence. */
  metadata: PullRequestInboxMetadata
  checksKnown?: boolean
  reviewKnown?: boolean
  changeSize?: PullRequestInboxCount
  unresolvedThreads?: PullRequestInboxCount
  groups: PullRequestInboxGroupId[]
}

export interface PullRequestInboxMembershipOptions {
  /** The authenticated login this read was made as; null when GitHub reported none. */
  viewer: string | null
  /** The instant "recently" is measured from. Supplied, never read from the clock. */
  now: number
  mergedWithinDays?: number
}

/**
 * The groups one pull request belongs to, in the order the groups are declared.
 * The order is fixed so two runs over the same data produce the same row order.
 */
export function pullRequestInboxGroups(
  signals: PullRequestInboxSignals,
  options: PullRequestInboxMembershipOptions,
): PullRequestInboxGroupId[] {
  const viewer = login(options.viewer)
  const authored = viewer !== null && viewer === login(signals.author)
  const requested =
    viewer !== null && signals.reviewRequested.some((entry) => login(entry) === viewer)
  const open = signals.state === 'OPEN'
  // Somebody else spoke last, so the next turn is the viewer's.
  const lastTurn = login(signals.lastTurnLogin)
  const answerOwed = lastTurn !== null && lastTurn !== viewer
  const approved = signals.reviewDecision === 'APPROVED'
  const needsResponse =
    open &&
    !signals.draft &&
    authored &&
    (signals.reviewDecision === 'CHANGES_REQUESTED' || answerOwed)
  const groups = new Set<PullRequestInboxGroupId>()

  // Only the groups the read's own facts support. A degraded read never
  // established a review decision or who spoke last, so it cannot say that
  // nobody spoke and cannot say that nobody approved. Neither can a read that
  // never established who the viewer is: with no account, authorship and a
  // request to the viewer are both undecided rather than false, so every
  // viewer-relative group is left empty instead of being decided against a
  // person this read could not name.
  if (open && !signals.draft && requested && !authored) groups.add('review-requested')
  if (signals.metadata === 'full') {
    if (needsResponse) groups.add('needs-response')
    if (open && authored && !signals.draft && !needsResponse && !approved) {
      groups.add('my-prs-waiting')
    }
    if (open && authored && !signals.draft && approved) groups.add('my-prs-approved')
  }
  if (open && signals.draft) groups.add('drafts')

  const window = options.mergedWithinDays ?? PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS
  if (signals.state === 'MERGED' && mergedWithinWindow(signals.mergedAt, options.now, window)) {
    groups.add('recently-merged')
  }
  return GROUP_IDS.filter((id) => groups.has(id))
}

/**
 * Whether a merge instant falls inside the recent window. A merged pull request
 * GitHub gave no instant for is not claimed as recent: the absence of a time is
 * not evidence of a new merge.
 */
function mergedWithinWindow(mergedAt: string | null, now: number, days: number): boolean {
  if (typeof mergedAt !== 'string' || !mergedAt) return false
  const merged = Date.parse(mergedAt)
  if (!Number.isFinite(merged)) return false
  const window = Math.max(0, days) * 24 * 60 * 60 * 1000
  return merged <= now && now - merged <= window
}

/** The filters one Inbox view applies. `search` is free text; the rest are exact. */
export type PullRequestInboxSort = 'updated-desc' | 'size-desc' | 'size-asc'

export interface PullRequestInboxCriteria {
  repositories?: string[]
  authors?: string[]
  reviewers?: string[]
  lifecycle?: ('open' | 'draft' | 'closed' | 'merged')[]
  reviews?: ('APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'none')[]
  checks?: PullRequest['checks'][]
  minSize?: number
  maxSize?: number
}

export interface PullRequestInboxFilter {
  group: PullRequestInboxGroupId
  search: string
  criteria: PullRequestInboxCriteria
  sort: PullRequestInboxSort
}

export const PULL_REQUEST_INBOX_DEFAULT_FILTER: PullRequestInboxFilter = {
  group: 'review-requested',
  search: '',
  criteria: {},
  sort: 'updated-desc',
}

/**
 * Free-text match over the facts a row already shows. An empty query matches
 * everything rather than nothing, so clearing the box restores the group.
 * `#42`, `owner/name`, a branch name, a login, and a title word all match.
 */
export function matchesPullRequestInboxSearch(item: PullRequestInboxItem, search: string): boolean {
  const query = search.trim().toLowerCase()
  if (!query) return true
  const haystack = [
    `#${item.number}`,
    String(item.number),
    item.title,
    item.repository,
    item.head,
    item.base,
    item.author ?? '',
    item.host,
  ]
    .join(' ')
    .toLowerCase()
  return query.split(/\s+/u).every((term) => haystack.includes(term))
}

/** The rows one filter selects, in the order the filter is applied. */
export function filterPullRequestInbox(
  items: readonly PullRequestInboxItem[],
  filter: PullRequestInboxFilter,
): PullRequestInboxItem[] {
  return sortPullRequestInbox(
    items.filter((item) => evaluatePullRequestInbox(item, filter) === 'match'),
    filter.sort,
  )
}

/** An explicit condition cannot match an unavailable fact, including zero. */
export function evaluatePullRequestInbox(
  item: PullRequestInboxItem,
  filter: PullRequestInboxFilter,
): 'match' | 'excluded' | 'unknown' {
  if (!item.groups.includes(filter.group) || !matchesPullRequestInboxSearch(item, filter.search))
    return 'excluded'
  const c = filter.criteria
  const matches = (values: readonly string[] | undefined, value: string) =>
    !values?.length || values.some((candidate) => candidate.toLowerCase() === value.toLowerCase())
  if (!matches(c.repositories, item.repository)) return 'excluded'
  const lifecycle =
    item.state === 'MERGED'
      ? 'merged'
      : item.state === 'CLOSED'
        ? 'closed'
        : item.draft
          ? 'draft'
          : 'open'
  if (!matches(c.lifecycle, lifecycle)) return 'excluded'
  let unknown = false
  if (c.authors?.length) {
    if (item.author === null) unknown = true
    else if (!matches(c.authors, item.author)) return 'excluded'
  }
  if (
    c.reviewers?.length &&
    !item.reviewRequested.some((reviewer) => matches(c.reviewers, reviewer))
  ) {
    if (item.reviewRequestsComplete === true) return 'excluded'
    unknown = true
  }
  if (c.reviews?.length) {
    if (item.metadata !== 'full' || item.reviewKnown === false) unknown = true
    else if (!matches(c.reviews, item.reviewDecision || 'none')) return 'excluded'
  }
  if (c.checks?.length) {
    if (item.metadata !== 'full' || item.checksKnown === false) unknown = true
    else if (!matches(c.checks, item.checks)) return 'excluded'
  }
  if (c.minSize !== undefined || c.maxSize !== undefined) {
    if (item.changeSize?.state !== 'known') unknown = true
    else if (
      (c.minSize !== undefined && item.changeSize.value < c.minSize) ||
      (c.maxSize !== undefined && item.changeSize.value > c.maxSize)
    )
      return 'excluded'
  }
  return unknown ? 'unknown' : 'match'
}

/** Updated instant, or null when the host did not report a valid one. */
function inboxItemTime(item: PullRequestInboxItem): number | null {
  const parsed = Date.parse(item.updatedAt ?? '')
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Rows ordered the way a triage queue is worked: the group is chosen, then
 * recency. Repository then number break ties, so the order is total and stable
 * for the same data and a refresh never reshuffles rows under the cursor.
 */
export function sortPullRequestInbox(
  items: readonly PullRequestInboxItem[],
  sort: PullRequestInboxSort = 'updated-desc',
): PullRequestInboxItem[] {
  return [...items].sort((first, second) => {
    const a =
      sort === 'updated-desc'
        ? inboxItemTime(first)
        : first.changeSize?.state === 'known'
          ? first.changeSize.value
          : null
    const b =
      sort === 'updated-desc'
        ? inboxItemTime(second)
        : second.changeSize?.state === 'known'
          ? second.changeSize.value
          : null
    if (a === null && b !== null) return 1
    if (b === null && a !== null) return -1
    const byTime = a === null || b === null ? 0 : sort === 'size-asc' ? a - b : b - a
    if (byTime !== 0) return byTime
    if (first.host !== second.host) return first.host.localeCompare(second.host)
    if (first.repository !== second.repository) {
      return first.repository.localeCompare(second.repository)
    }
    return first.number - second.number
  })
}

/**
 * How many rows the queue actually holds.
 *
 * A repository can hand back a pull request that belongs to no group at all:
 * somebody else's open pull request nobody asked this viewer to review is not
 * this person's work. Counting those rows would put a number on the navigation
 * badge and in the empty-state copy that no group, search, or repository filter
 * can ever produce, so the queue counts the rows a person could go and work.
 */
export function pullRequestInboxQueueCount(items: readonly PullRequestInboxItem[]): number {
  let count = 0
  for (const item of items) if (item.groups.length > 0) count += 1
  return count
}

/** How one registered repository fared in a refresh. */
export type PullRequestInboxRepositoryStatus =
  | 'ok'
  /** The credential was rejected; nothing about this repository is known. */
  | 'unauthorized'
  /** Authenticated, but the credential may not read this repository. */
  | 'forbidden'
  /** The credential cannot see this repository at all. */
  | 'not-found'
  | 'offline'
  | 'rate-limited'
  /**
   * Read, but not with the fields the queue asks for: the host's schema refused
   * the review, comment, and check metadata, so what is missing is unknown rather
   * than absent. A degraded repository is never counted as a complete read.
   */
  | 'degraded'
  /**
   * Read, and the host named no account for the rows: whose queue this is could
   * not be established, so no group that depends on authorship or on a request
   * to the viewer can be decided. The rows a group does not depend on stay.
   */
  | 'membership-unknown'
  /** The host's schema refused the review fields this read asks for. */
  | 'unsupported'
  /** The origin remote is not on a GitHub host, so it has no pull requests here. */
  | 'not-github'
  /**
   * Not attempted, and no repository fact established: outside this refresh's
   * request budget, or no transport this machine has configured. `detail` says
   * which. A skipped repository is never counted as an empty one.
   */
  | 'skipped'
  /**
   * Attempted, and the answer could not be classified: the host answered with
   * something this build cannot read as a verdict. `detail` carries what it
   * said. A read that was made and failed is never reported as one that was
   * never attempted.
   */
  | 'failed'

/** Static status to the phrase a person reads, so a reason is never improvised. */
const REPOSITORY_STATUS_LABEL: Record<PullRequestInboxRepositoryStatus, string> = {
  ok: 'read',
  unauthorized: 'sign-in rejected',
  forbidden: 'not visible to this credential',
  'not-found': 'not found for this credential',
  degraded: 'read without review or check metadata',
  'membership-unknown': 'read without knowing whose queue this is',
  offline: 'GitHub unreachable',
  'rate-limited': 'rate limited',
  unsupported: 'this host does not report the review fields',
  'not-github': 'origin is not on a GitHub host',
  skipped: 'not attempted',
  failed: 'could not be read',
}

export function pullRequestInboxRepositoryStatusLabel(
  status: PullRequestInboxRepositoryStatus,
): string {
  return REPOSITORY_STATUS_LABEL[status]
}

export interface PullRequestInboxRepositoryReport {
  /** `owner/name` for a GitHub repository, or the host-stated label otherwise. */
  repository: string
  path: string
  host: string | null
  status: PullRequestInboxRepositoryStatus
  /**
   * The login its rows were read and grouped as, or null when this repository
   * reported none. Two hosts can serve two accounts, so this is the only place
   * a row's viewer-relative groups can be traced back to.
   */
  viewer: string | null
  detail: string
}

/**
 * How one repository that did not fully read is named in a notice.
 *
 * A read that reached a host and was refused is quoted in the host's own
 * words, because those are the two statuses whose detail says something a
 * static label cannot: an answer this build cannot classify, and a
 * rate-limit refusal that names the moment the host asked to be left alone.
 * "rate limited" in place of that is not a shorter reason, it is the loss of
 * the only part of it that says when to try again. Every other status is
 * decided here rather than by the host, so its label already says all of it.
 */
function unreadRepository(report: PullRequestInboxRepositoryReport): string {
  const spoken = report.status === 'failed' || report.status === 'rate-limited'
  const reason = spoken ? report.detail : pullRequestInboxRepositoryStatusLabel(report.status)
  return `${report.repository} (${reason})`
}

/**
 * What a refresh established about the whole queue.
 *
 * `fresh` is the only state that proves a count. Every other state means the
 * read did not finish, so a queue reported as `stale` keeps the last confirmed
 * rows and never presents an unanswered read as an empty one.
 */
export type PullRequestInboxRefreshState =
  | 'fresh'
  /** Some repositories answered and some could not; the answered ones are real. */
  | 'partial'
  /** A read that could not answer, showing the last confirmed rows. */
  | 'stale'
  /**
   * The read ended before it confirmed anything, because the identity it was
   * reading for was replaced while it was in flight. Nothing below belongs to
   * whoever is signed in now, so the queue is empty rather than showing rows
   * another credential read. It says nothing about signing in and nothing about
   * the network: the read was ended, not refused and not unreachable.
   */
  | 'retired'
  | 'offline'
  | 'auth-required'
  | 'rate-limited'

export interface PullRequestInboxBudget {
  /**
   * GitHub round trips one refresh may spend. Repositories past the cap are
   * reported `skipped`, so the queue says what it did not read.
   */
  maxRequests: number
  /**
   * Remaining requests below which a refresh refuses to start, matching the
   * nonessential-tier floor the repository sync already uses. A null remaining
   * means no host has reported one yet and does not block anything.
   */
  reserve: number
}

export const DEFAULT_PULL_REQUEST_INBOX_BUDGET: PullRequestInboxBudget = {
  maxRequests: 24,
  reserve: 250,
}

export interface PullRequestInboxRefresh {
  state: PullRequestInboxRefreshState
  /** When GitHub last confirmed the rows below; null when it never has. */
  confirmedAt: string | null
  /** When this refresh was attempted, successful or not. */
  checkedAt: string
  /**
   * The login this read was made as when every host that reported one reported
   * the same login, and null otherwise. A queue assembled from two accounts has
   * no single viewer, and naming one would label the other host's rows with it;
   * each repository report carries its own.
   */
  viewer: string | null
  /** GitHub round trips this refresh spent, and the cap it had. */
  requests: number
  budget: PullRequestInboxBudget
  repositories: PullRequestInboxRepositoryReport[]
  /**
   * Repositories whose merged pull requests exceeded the pages this read asks
   * for. Their "recently merged" group is the newest pages only, which is a
   * bound rather than an answer, and is named here instead of staying silent.
   */
  truncated: string[]
  detail: string
}

export interface PullRequestInboxReport {
  refresh: PullRequestInboxRefresh
  items: PullRequestInboxItem[]
  mergedWithinDays: number
}

export interface PullRequestInboxRequest {
  /** Ends this refresh; a later refresh with the same id supersedes it. */
  requestId?: string
  /** Overrides the stored recent-merge window, in days. */
  mergedWithinDays?: number
}

/**
 * The window one host answer described, in the terms admission decides against.
 */
export interface PullRequestInboxWindow {
  /** The window the answer's counter runs to, when it named one. */
  reset?: Date | null
  now?: number
  /** How long this answer told this account to come back, when it said. */
  retryAfterSeconds?: number | null
  /** When that answer arrived, which is when a wait it names runs from. */
  reportedAt?: number
}

/**
 * The moment the window one answer described ends, or null when it named none.
 *
 * A host names a window in two ways and it lasts as long as the later of them: a
 * counter that resets in ten minutes does not shorten an account that was told
 * to come back in an hour, and a retry named past the reset does not shorten the
 * window the counter opens. An answer that names neither — or names one this
 * build cannot read — describes no window there is anything to wait out.
 */
export function pullRequestInboxWindowEnd(window: PullRequestInboxWindow): number | null {
  const reset = window.reset?.getTime()
  const retryAfter = window.retryAfterSeconds
  const retryEnd =
    retryAfter === null || retryAfter === undefined || !Number.isFinite(retryAfter)
      ? null
      : (window.reportedAt ?? 0) + retryAfter * 1000
  if (retryEnd === null) return reset !== undefined && Number.isFinite(reset) ? reset : null
  if (reset === undefined || !Number.isFinite(reset)) return retryEnd
  return Math.max(retryEnd, reset)
}

/**
 * Whether a refresh may start against the budget GitHub last reported.
 *
 * A window is over when every moment that answer named has passed, and a window
 * that has already passed is no longer a limit: GitHub counts each window
 * separately, so a count read before the reset says nothing about the requests
 * available now. Refusing on an expired count would park a window that admits no
 * request capable of updating the count, which is how a queue stays rate-limited
 * until something unrelated calls the API.
 */
export function pullRequestInboxBudgetAllows(
  remaining: number | null,
  budget: PullRequestInboxBudget = DEFAULT_PULL_REQUEST_INBOX_BUDGET,
  window: PullRequestInboxWindow = {},
): { allowed: boolean; reason: string } {
  const now = window.now ?? Date.now()
  const ends = pullRequestInboxWindowEnd(window)
  if (ends !== null && now >= ends) {
    return { allowed: true, reason: '' }
  }
  if (remaining === null || !Number.isFinite(remaining)) {
    return { allowed: true, reason: 'No rate limit has been reported yet.' }
  }
  // An empty window is an empty window: no request is left to spend, whatever
  // headroom this queue keeps. A reserve of zero says there is no headroom to
  // protect, not that the remaining zero can be spent.
  if (remaining <= 0) {
    return { allowed: false, reason: 'GitHub has no requests left in this window.' }
  }
  if (remaining >= budget.reserve) return { allowed: true, reason: '' }
  return {
    allowed: false,
    reason: `GitHub has ${remaining} requests left, below the ${budget.reserve} this queue keeps in reserve.`,
  }
}

/**
 * Reduces the per-repository reports to one state.
 *
 * A read that answered for some repositories and not others is `partial`, and
 * partial is never promoted to `fresh`: the queue is complete only when every
 * registered repository it attempted was read.
 */
export function derivePullRequestInboxState(
  reports: readonly PullRequestInboxRepositoryReport[],
  failed: { state: PullRequestInboxRefreshState; detail: string } | null,
): PullRequestInboxRefreshState {
  if (reports.length === 0) return failed?.state ?? 'stale'
  const complete = reports.filter((report) => report.status === 'ok').length
  // A repository that answered with less than the queue asked for — without its
  // review and check metadata, or without an account to read them as — is never
  // promoted to a complete read, and is never counted as a failure either:
  // GitHub did return pull requests for it.
  const degraded = reports.filter(
    (report) => report.status === 'degraded' || report.status === 'membership-unknown',
  ).length
  if (complete + degraded === 0) return failed?.state ?? 'stale'
  if (complete < reports.length) return 'partial'
  return 'fresh'
}

/** Why a whole refresh could not answer, in the words the notice shows. */
export interface PullRequestInboxFailure {
  state: PullRequestInboxRefreshState
  detail: string
}

/**
 * The reason a refresh read nothing, taken from what the repositories reported.
 *
 * A refresh that read nothing has one honest answer, and which answer depends on
 * why every repository failed: an unreachable host, a rejected sign-in, a
 * credential that cannot see any registered repository, and an exhausted budget
 * are four different problems with four different fixes. Reducing them all to
 * "no repository could be read" would tell a person nothing they can act on, so
 * the repository statuses decide and name themselves. A failure the refresh
 * already established — the shared request cap, say — is reported as it stands.
 */
export function pullRequestInboxRefreshFailure(
  reports: readonly PullRequestInboxRepositoryReport[],
  failed: PullRequestInboxFailure | null,
): PullRequestInboxFailure | null {
  if (failed) return failed
  if (
    reports.some(
      (report) =>
        report.status === 'ok' ||
        report.status === 'degraded' ||
        report.status === 'membership-unknown',
    )
  )
    return null
  // An attempted read that failed for a reason this build cannot classify keeps
  // the reason the host gave: naming the repositories without it would leave a
  // person nothing they can act on, and calling it "not attempted" would
  // misreport a request that was made.
  const attempted = reports.filter((report) => report.status === 'failed')
  if (attempted.length > 0) {
    return {
      state: 'stale',
      detail: `No registered repository could be read: ${attempted
        .map(unreadRepository)
        .join(', ')}.`,
    }
  }
  const names = (statuses: readonly PullRequestInboxRepositoryStatus[]): string =>
    reports
      .filter((report) => statuses.includes(report.status))
      .map(unreadRepository)
      .join(', ')
  if (reports.some((report) => report.status === 'rate-limited')) {
    return {
      state: 'rate-limited',
      detail: `GitHub refused every repository read: ${names(['rate-limited'])}.`,
    }
  }
  if (reports.some((report) => report.status === 'unauthorized')) {
    return {
      state: 'auth-required',
      detail: `GitHub rejected the signed-in account: ${names(['unauthorized'])}.`,
    }
  }
  const unreachable = names(['offline'])
  if (unreachable) {
    return { state: 'offline', detail: `GitHub could not be reached: ${unreachable}.` }
  }
  const unreadable = names(['forbidden', 'not-found'])
  if (unreadable) {
    return {
      state: 'auth-required',
      detail: `No registered repository is visible to this credential: ${unreadable}.`,
    }
  }
  const unusable = names(['not-github', 'unsupported'])
  if (unusable) {
    return { state: 'stale', detail: `No registered repository could be read: ${unusable}.` }
  }
  return null
}

export type PullRequestInboxListState =
  | 'rows'
  | 'empty'
  | 'filtered-empty'
  | 'unconfirmed'
  | 'loading'

export interface PullRequestInboxNotice {
  tone: 'info' | 'warning' | 'error'
  title: string
  detail: string
}

export interface PullRequestInboxPresentation {
  /** What the list itself says. Never 'empty' for a read that did not answer. */
  list: PullRequestInboxListState
  /** Why the rows are not current, or null when they are. */
  notice: PullRequestInboxNotice | null
}

/**
 * Splits a report into what the list says and what the banner says.
 *
 * Emptiness and staleness are separate questions. A read that could not answer
 * never produces `empty` or `filtered-empty`, because "we could not ask" is not
 * "there is nothing": it produces `unconfirmed` with the reason, which is the
 * only honest rendering of a queue whose last confirmed rows are gone.
 *
 * `loading` is the one answer that is not a claim about GitHub at all. It is
 * rendered only while nothing has ever been confirmed and a read is in flight,
 * so the first open of the destination reads as being read rather than as an
 * empty or unrefused queue.
 */
export function pullRequestInboxPresentation(input: {
  refresh: PullRequestInboxRefresh
  total: number
  shown: number
  filtering: boolean
  loading: boolean
}): PullRequestInboxPresentation {
  const { refresh, total, shown, filtering, loading } = input
  const notice = pullRequestInboxNotice(refresh)
  if (shown > 0) return { list: 'rows', notice }
  if (refresh.confirmedAt === null && loading) return { list: 'loading', notice: null }
  if (refresh.state !== 'fresh') return { list: 'unconfirmed', notice }
  if (filtering || total > shown) return { list: 'filtered-empty', notice }
  return { list: 'empty', notice: null }
}

function pullRequestInboxNotice(refresh: PullRequestInboxRefresh): PullRequestInboxNotice | null {
  switch (refresh.state) {
    case 'fresh':
      return null
    case 'partial': {
      const unread = refresh.repositories
        .filter((entry) => entry.status !== 'ok')
        .map(unreadRepository)
      return {
        tone: 'warning',
        title: 'Some repositories could not be read',
        detail: `${unread.length} of ${refresh.repositories.length} registered repositories were not fully read: ${unread.join(', ')}. The rows below are the ones GitHub confirmed.`,
      }
    }
    case 'stale':
      return {
        tone: 'warning',
        // Only claim a confirmed read when there is one to show. The first read
        // of a launch fails for plenty of reasons, and "showing the last
        // confirmed read" over an empty list describes rows nobody can see.
        title:
          refresh.confirmedAt === null
            ? 'The queue has never been read'
            : 'Showing the last confirmed read',
        detail: refresh.detail,
      }
    case 'retired':
      return {
        tone: 'warning',
        // Says what happened to the read and nothing about the person: nobody
        // signed out, nothing became unreachable, and the queue was not empty
        // when it was last read. Only that this read cannot describe the queue,
        // and that reading it again can.
        title: 'Queue read retired',
        detail: refresh.detail,
      }
    case 'offline':
      return {
        tone: 'warning',
        title: 'GitHub is unreachable',
        detail: refresh.detail,
      }
    case 'auth-required':
      return {
        tone: 'error',
        title: 'Sign in to see your pull request queue',
        detail: refresh.detail,
      }
    case 'rate-limited':
      return {
        tone: 'warning',
        title: 'GitHub rate limit reached',
        detail: refresh.detail,
      }
  }
}

/** A named filter a person saved, so the same question is one click away. */
export interface PullRequestInboxSavedFilter extends PullRequestInboxFilter {
  id: string
  name: string
}

/**
 * What the window sends to save or replace a filter. `id` is optional: a new
 * filter has no identity yet, and the main process assigns one and returns the
 * stored list, so the window never invents an identifier it cannot verify.
 */
export interface PullRequestInboxFilterDraft extends PullRequestInboxFilter {
  id?: string
  name: string
}

/**
 * Narrows one untrusted draft. A draft this build cannot run is refused rather
 * than repaired, because a repaired draft would show rows the person did not
 * name.
 */
export function parsePullRequestInboxFilterDraft(
  value: unknown,
): PullRequestInboxFilterDraft | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) return null
  if (!isPullRequestInboxGroupId(record.group)) return null
  const search = record.search ?? ''
  if (typeof search !== 'string' || search.length > MAX_SEARCH_LENGTH) return null
  const criteria = parseInboxCriteria(record.criteria)
  if (!criteria) return null
  const sort = record.sort
  if (sort !== 'updated-desc' && sort !== 'size-desc' && sort !== 'size-asc') return null
  const id = record.id
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > MAX_NAME_LENGTH)) {
    return null
  }
  return {
    ...(typeof id === 'string' ? { id } : {}),
    name: name.trim(),
    group: record.group,
    search,
    criteria,
    sort,
  }
}

/** Ceilings applied to anything read back from disk or off the bridge. */
const MAX_SAVED_FILTERS = 20
const MAX_NAME_LENGTH = 60
const MAX_SEARCH_LENGTH = 200

/**
 * Narrows an untrusted list of saved filters. A malformed entry is dropped, not
 * repaired: a saved filter naming a group this build does not know is not a
 * filter the person can run, and guessing one would show rows they did not ask
 * for. A file that cannot be understood yields an empty list rather than a
 * refusal, so a damaged file never blocks the queue that does not read it.
 */
export function parsePullRequestInboxSavedFilters(value: unknown): PullRequestInboxSavedFilter[] {
  if (!Array.isArray(value)) return []
  const filters: PullRequestInboxSavedFilter[] = []
  for (const entry of value.slice(0, MAX_SAVED_FILTERS)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.search !== 'string') continue
    const migrated =
      'criteria' in record
        ? record
        : {
            ...record,
            criteria:
              typeof record.repository === 'string' ? { repositories: [record.repository] } : {},
            sort: 'updated-desc',
          }
    if (
      !('criteria' in record) &&
      record.repository !== null &&
      typeof record.repository !== 'string'
    )
      continue
    const parsed = parsePullRequestInboxFilterDraft(migrated)
    if (!parsed?.id) continue
    filters.push({ ...parsed, id: parsed.id })
  }
  return filters
}

function parseInboxCriteria(value: unknown): PullRequestInboxCriteria | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const result: PullRequestInboxCriteria = {}
  const choices: Record<string, readonly string[] | null> = {
    repositories: null,
    authors: null,
    reviewers: null,
    lifecycle: ['open', 'draft', 'closed', 'merged'],
    reviews: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'none'],
    checks: ['none', 'passing', 'failing', 'pending'],
  }
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(choices, key) && key !== 'minSize' && key !== 'maxSize') return null
  }
  for (const key of Object.keys(choices)) {
    const values = record[key]
    if (values === undefined) continue
    const allowed = choices[key]
    if (
      !Array.isArray(values) ||
      values.length > 100 ||
      values.some(
        (entry) =>
          typeof entry !== 'string' ||
          !entry.trim() ||
          entry.length > 200 ||
          (allowed && !allowed.includes(entry)),
      )
    )
      return null
    Object.assign(result, { [key]: [...new Set(values)] })
  }
  for (const key of ['minSize', 'maxSize'] as const) {
    const count = record[key]
    if (count === undefined) continue
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null
    result[key] = count
  }
  if (
    result.minSize !== undefined &&
    result.maxSize !== undefined &&
    result.minSize > result.maxSize
  )
    return null
  return result
}
