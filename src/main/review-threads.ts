import { createHash } from 'node:crypto'

import type { ReviewComparison, ReviewFileSet, ReviewSide } from '../shared/review'
import { sameReviewComparison } from '../shared/review'
import type {
  ReviewBoundary,
  ReviewDraft,
  ReviewDraftResolution,
  ReviewEvent,
  ReviewMutationResult,
  ReviewPermissions,
  ReviewSubmission,
  ReviewThread,
  ReviewThreadComment,
  ReviewThreadRead,
  ReviewUncertainWrite,
  UncertainComment,
  ReviewThreadSet,
} from '../shared/review-threads'
import {
  reviewDraftSpan,
  reviewDraftStart,
  REVIEW_EVENTS,
  UNKNOWN_REVIEW_BOUNDARY,
  UNKNOWN_REVIEW_COMPARISON,
} from '../shared/review-threads'
import { isRecord, type ParsedRemote } from './git-core'
import {
  clearUncertainWrite,
  readUncertainWrites,
  recordUncertainWrite,
  retireSettledWrites,
} from './review-drafts'
import { markReviewSnapshotReviewed } from './review-snapshots'
import { GitHubTransportError } from './github-transport'
import {
  originRemote,
  readReviewIdentity,
  readReviewFilesFrom,
  resolveReviewAnchor,
  reviewTransport,
  ReviewRevisionMovedError,
} from './review'

/** Threads per GraphQL page. `reviewThreads` is a connection and pages. */
const REVIEW_THREAD_PAGE_SIZE = 50

/**
 * Ceiling on paged thread pages. A pull request with more threads than this is
 * reported as truncated beside GitHub's own count, rather than presented as a
 * complete conversation.
 */
const REVIEW_THREAD_PAGE_LIMIT = 20

/**
 * Ceiling on the extra pages fetched for one thread whose conversation runs past
 * the first page. GitHub groups a thread's comments in their own connection, so
 * paging only the outer connection leaves the tail of a long thread unseen — and
 * unseen replies are exactly what a lost-write reconciliation has to find.
 */
const REVIEW_COMMENT_PAGE_SIZE = 50
const REVIEW_COMMENT_PAGE_LIMIT = 20

/** How many threads may be followed for their later comment pages in one read. */
const REVIEW_COMMENT_FOLLOW_LIMIT = 20

/**
 * Entries per page, and the ceiling on pages, for the two REST reads a
 * reconciliation needs.
 *
 * GitHub's review-comment endpoint is PR-wide rather than per-review, and it is
 * the only documented source of the `side` and `start_side` a comment was written
 * on — those fields do not exist on `PullRequestReviewComment` in GraphQL, which
 * is why the reconciliation reads them here instead of inventing a shape to fit
 * a fixture. A review may carry up to 200 comments, so a single page of 100 is
 * not a complete review and treating it as one would make a review this app had
 * itself posted permanently unreconcilable.
 */
const REVIEW_REST_PAGE_SIZE = 100
const REVIEW_REST_PAGE_LIMIT = 20

/**
 * Ceiling on pages of a pull request's reviews. Reviews are far fewer than
 * comments; the bound exists so a retry cannot be made unbounded, and reaching
 * it is a hold rather than a "not found": not having read far enough back is
 * never evidence that a review is absent.
 */
const REVIEW_REST_REVIEW_PAGES = 20

const EVENT_NAMES: Record<ReviewEvent, string> = {
  COMMENT: 'COMMENT',
  APPROVE: 'APPROVE',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
}

const THREAD_FIELDS = `id
        isResolved
        isCollapsed
        isOutdated
        path
        line
        startLine
        diffSide
        startDiffSide
        subjectType
        viewerCanReply
        viewerCanResolve
        viewerCanUnresolve
        comments(first: ${REVIEW_COMMENT_PAGE_SIZE}) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { id body createdAt url viewerDidAuthor author { login } }
        }`

const THREADS_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) {
      state
      viewerDidAuthor
      reviewThreads(first: ${REVIEW_THREAD_PAGE_SIZE}, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_FIELDS} }
      }
    }
  }
}`

/**
 * The signed-in account, and what it may do here.
 *
 * `viewer` is a field of the query root, not of `Repository`: GitHub's schema
 * has no `Repository.viewer`, and asking for one fails the whole query with
 * `undefinedField` before any review is written. Every reader of permissions
 * goes through this one, so the shape is asserted against the live schema
 * rather than only against fixtures that would have accepted the mistake.
 */
const PERMISSIONS_QUERY = `query ReviewPermissions($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) { state viewerDidAuthor }
  }
}`

const REPLY_MUTATION = `mutation ReplyToReviewThread($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: { pullRequestReviewThreadId: $threadId, body: $body }
  ) {
    comment { id url }
  }
}`

const RESOLVE_MUTATION = `mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`

const UNRESOLVE_MUTATION = `mutation UnresolveReviewThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`

/**
 * The later pages of one thread's comments. A thread owns a connection of its
 * own with its own cursor, so the tail of a long conversation is reached by
 * asking for that thread's node again rather than by re-reading the outer list.
 * Reading only the first page is what hides a reply the reviewer just sent, and
 * what makes a lost write impossible to reconcile.
 */
const THREAD_COMMENTS_QUERY = `query ReviewThreadComments($threadId: ID!, $after: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: ${REVIEW_COMMENT_PAGE_SIZE}, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id body createdAt url viewerDidAuthor author { login } }
      }
    }
  }
}`

/**
 * One review as GitHub's REST API reports it.
 *
 * The id is a number here, where GraphQL would give an opaque node id. That is
 * the whole reason this read is REST: a reconciliation compares an attempt's
 * boundary against the reviews that came after it, and a numeric id orders those
 * without depending on the order a connection happens to be returned in.
 */
interface RestReview {
  id: number
  state: string
  body: string
  commitId: string | null
  author: string | null
  url: string | null
}

/** One inline review comment as GitHub's REST API reports it. */
interface RestReviewComment {
  reviewId: number | null
  path: string
  line: number
  startLine: number | null
  side: ReviewSide | null
  startSide: ReviewSide | null
  body: string
}

/**
 * Reads both REST collections a settlement needs, in full.
 *
 * `truncated` is reported rather than hidden: it means the read stopped at the
 * page ceiling, so whatever it did not see is unknown rather than absent. Every
 * caller treats that as a hold, because the alternative is concluding a review
 * is not there when the read simply never got that far — which is the one
 * conclusion that loses a write GitHub had already accepted.
 */
interface RestReviewSnapshot {
  reviews: RestReview[]
  /** Each review's own comments, keyed by review id. Replies are not in these. */
  commentsByReview: Map<number, UncertainComment[]>
  truncated: boolean
}

async function readRestReviews(
  remote: ParsedRemote,
  number: number,
  signal?: AbortSignal,
): Promise<RestReviewSnapshot> {
  const reviews: RestReview[] = []
  let truncated = false
  for (let page = 1; page <= REVIEW_REST_REVIEW_PAGES; page += 1) {
    const rows = await restList(
      remote,
      `repos/${remote.owner}/${remote.name}/pulls/${number}/reviews`,
      page,
      signal,
    )
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'number') continue
      const user = isRecord(row.user) ? row.user.login : null
      reviews.push({
        id: row.id,
        state: typeof row.state === 'string' ? row.state : '',
        body: typeof row.body === 'string' ? row.body : '',
        commitId: typeof row.commit_id === 'string' ? row.commit_id : null,
        author: typeof user === 'string' ? user : null,
        url: typeof row.html_url === 'string' ? row.html_url : null,
      })
    }
    if (rows.length < REVIEW_REST_PAGE_SIZE) break
    if (page === REVIEW_REST_REVIEW_PAGES) truncated = true
  }

  const commentsByReview = new Map<number, UncertainComment[]>()
  for (let page = 1; page <= REVIEW_REST_PAGE_LIMIT; page += 1) {
    const rows = await restList(
      remote,
      `repos/${remote.owner}/${remote.name}/pulls/${number}/comments`,
      page,
      signal,
    )
    for (const row of rows) {
      const comment = restReviewComment(row)
      if (!comment || comment.reviewId === null) continue
      const held = commentsByReview.get(comment.reviewId) ?? []
      held.push({
        path: comment.path,
        side: comment.side ?? 'head',
        line: comment.line,
        startLine: comment.startLine,
        startSide: comment.startSide,
        body: comment.body.trim(),
        // A comment GitHub holds names no composition: the draft it was written
        // from is the app's, and it is compared against the attempt's own.
        draftId: null,
      })
      commentsByReview.set(comment.reviewId, held)
    }
    if (rows.length < REVIEW_REST_PAGE_SIZE) break
    if (page === REVIEW_REST_PAGE_LIMIT) truncated = true
  }
  return { reviews, commentsByReview, truncated }
}

/** One page of a REST list endpoint, or an empty page when GitHub refuses. */
async function restList(
  remote: ParsedRemote,
  path: string,
  page: number,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const separator = path.includes('?') ? '&' : '?'
  const response = await reviewTransport(remote).rest<unknown>({
    method: 'GET',
    path: `${path}${separator}per_page=${REVIEW_REST_PAGE_SIZE}&page=${page}`,
    signal,
  })
  return Array.isArray(response.data) ? response.data : []
}

function restReviewComment(row: unknown): RestReviewComment | null {
  if (!isRecord(row)) return null
  if (typeof row.path !== 'string') return null
  if (typeof row.line !== 'number') return null
  return {
    reviewId: typeof row.pull_request_review_id === 'number' ? row.pull_request_review_id : null,
    path: row.path,
    line: row.line,
    // GitHub sends both as null for a comment on a single line, and a range
    // carries them for both ends. Reading either as a default would turn a
    // one-line comment into a range, and the anchor would stop matching the one
    // that was actually posted.
    startLine: typeof row.start_line === 'number' ? row.start_line : null,
    side: sideOf(row.side),
    startSide: sideOf(row.start_side),
    body: typeof row.body === 'string' ? row.body : '',
  }
}

/**
 * Raised when a draft can no longer be written where the reviewer wrote it.
 *
 * The whole submission is refused rather than trimmed. Sending the comments that
 * still resolve would post half a review, and the drafts that do not resolve are
 * precisely the ones a force-push invalidated. Every reason travels with the
 * error so the view can name the file, the side, and where the line went.
 */
export class ReviewAnchorStaleError extends Error {
  readonly resolutions: ReviewDraftResolution[]

  constructor(number: number, resolutions: ReviewDraftResolution[]) {
    const details = resolutions
      .filter((entry) => entry.match === 'unresolved' && entry.reason !== '')
      .map((entry) => entry.reason)
      .join(' ')
    super(
      details === ''
        ? `Nothing was sent for #${number}: a pending comment no longer names a line in the diff.`
        : `Nothing was sent for #${number}: ${details}`,
    )
    this.name = 'ReviewAnchorStaleError'
    this.resolutions = resolutions
  }
}

/**
 * Raised when the pull request moved out from under the review being submitted.
 *
 * Anchors that survive a force-push are not evidence the reviewer agreed to the
 * new revision: text often matches at a new line, and the review would then be
 * pinned to a commit that was never on screen. Approving that revision is the
 * worst case, so the refusal is about the comparison itself rather than about
 * any one comment, and it names the revision to look at before trying again.
 */
export class ReviewComparisonMovedError extends Error {
  readonly reviewed: ReviewComparison
  readonly current: ReviewComparison

  constructor(number: number, reviewed: ReviewComparison, current: ReviewComparison) {
    super(
      `Nothing was sent for #${number}: this pull request changed since you read the diff` +
        `${shortOid(reviewed.headOid)} to ${shortOid(current.headOid)}. Reload to read the new revision, then review what is there.`,
    )
    this.name = 'ReviewComparisonMovedError'
    this.reviewed = reviewed
    this.current = current
  }
}

/** A commit named the way a reviewer would say it aloud, or "an unknown commit". */
function shortOid(oid: string | null): string {
  return oid === null || oid === '' ? 'an unknown commit' : oid.slice(0, 7)
}

/**
 * Raised when the same write is attempted again while its last outcome is
 * unknown.
 *
 * The message is the second half of the guard; the first half is the
 * journalled attempt, which is what stops the button after a reload. Nothing is
 * sent in this state, so the reviewer's words are still theirs to re-send after
 * they have seen what GitHub holds.
 */
export class ReviewWriteUncertainError extends Error {
  readonly write: ReviewUncertainWrite

  constructor(write: ReviewUncertainWrite) {
    const what =
      write.kind === 'review'
        ? 'This review'
        : write.kind === 'reply'
          ? 'This reply'
          : 'This resolution'
    super(
      `${what} was sent but Git Stacks never heard back, and GitHub does not have it, so it is held rather than sent again. Pressing Submit checks GitHub again first, so nothing will be posted twice.`,
    )
    this.name = 'ReviewWriteUncertainError'
    this.write = write
  }
}

/**
 * Raised when a write may or may not have reached GitHub.
 *
 * The transport failed in a way that does not say whether the server acted: a
 * dropped connection, a timeout, a server error. Replaying such a write is how a
 * reviewer ends up with the same review posted twice, so the failure is reported
 * as an unknown outcome and the caller reloads from GitHub instead. This module
 * never resends after an unknown outcome.
 */
export class ReviewOutcomeUnknownError extends Error {
  constructor(detail: string) {
    super(
      `Git Stacks could not confirm whether this reached GitHub: ${detail} Reload the pull request before sending again, so nothing is posted twice.`,
    )
    this.name = 'ReviewOutcomeUnknownError'
  }
}

function transportDetail(error: unknown): string {
  if (error instanceof GitHubTransportError) return error.detail
  if (error instanceof Error && error.message) return error.message
  return 'the request failed'
}

/**
 * Whether a failure left the write in an unknown state.
 *
 * A definitive refusal — unauthorized, forbidden, not found, a validation
 * failure, a conflict, a cancelled read — is GitHub's own decision and is
 * reported as itself. Anything else may have happened after GitHub already
 * applied the change, so it must not be retried blindly.
 */
function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof GitHubTransportError)) return true
  switch (error.kind) {
    case 'unauthorized':
    case 'forbidden':
    case 'not-found':
    case 'conflict':
    case 'unprocessable':
    case 'cancelled':
      return false
    default:
      return true
  }
}

/** GitHub's own LEFT/RIGHT, mapped onto the two sides the diff already names. */
function sideOf(value: unknown): ReviewSide | null {
  if (value === 'LEFT') return 'base'
  if (value === 'RIGHT') return 'head'
  return null
}

const WIRE_SIDES: Record<ReviewSide, string> = { base: 'LEFT', head: 'RIGHT' }

function parseThreadComment(value: unknown): ReviewThreadComment | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const author = isRecord(value.author) ? value.author.login : null
  return {
    id: value.id,
    author: typeof author === 'string' && author !== '' ? author : 'Unknown',
    body: typeof value.body === 'string' ? value.body : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    url: typeof value.url === 'string' ? value.url : '',
    viewerDidAuthor: value.viewerDidAuthor === true,
  }
}

/**
 * One thread, plus the cursor its own comment connection ended on.
 *
 * A thread's comments are a connection inside the thread, so paging the outer
 * list says nothing about whether a long conversation was read whole. The
 * cursor is taken from the connection GitHub actually sent rather than derived
 * from a node id, because GitHub's cursors are opaque.
 */
interface ParsedThread {
  thread: ReviewThread
  commentCursor: string | null
  commentTotal: number
}

function parseThread(value: unknown): ParsedThread | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.path !== 'string') {
    return null
  }
  const connection = isRecord(value.comments) ? value.comments : null
  const comments =
    connection && Array.isArray(connection.nodes)
      ? connection.nodes
          .map(parseThreadComment)
          .filter((entry): entry is ReviewThreadComment => entry !== null)
      : []
  const total =
    connection && typeof connection.totalCount === 'number'
      ? connection.totalCount
      : comments.length
  const pageInfo = connection && isRecord(connection.pageInfo) ? connection.pageInfo : null
  const cursor =
    pageInfo && pageInfo.hasNextPage === true && typeof pageInfo.endCursor === 'string'
      ? pageInfo.endCursor
      : null
  return {
    thread: {
      id: value.id,
      path: value.path,
      side: sideOf(value.diffSide),
      line: typeof value.line === 'number' ? value.line : null,
      startLine: typeof value.startLine === 'number' ? value.startLine : null,
      startSide: sideOf(value.startDiffSide),
      fileLevel: value.subjectType === 'FILE',
      resolved: value.isResolved === true,
      collapsed: value.isCollapsed === true,
      outdated: value.isOutdated === true,
      viewerCanReply: value.viewerCanReply === true,
      viewerCanResolve: value.viewerCanResolve === true,
      viewerCanUnresolve: value.viewerCanUnresolve === true,
      comments,
      commentCount: total,
      commentsTruncated: cursor !== null,
    },
    commentCursor: cursor,
    commentTotal: total,
  }
}

/**
 * What the signed-in account may do, with the reason in words.
 *
 * GitHub stays authoritative. This only stops a control GitHub would refuse
 * anyway, and says why before the request instead of after it. The two
 * restrictions are the ones GitHub documents: an author may not approve their
 * own pull request, and a pull request that is no longer open takes no review.
 */
export function reviewPermissions(
  permission: string,
  isAuthor: boolean,
  state: 'OPEN' | 'CLOSED' | 'MERGED',
): ReviewPermissions {
  const blocked: ReviewPermissions['blocked'] = {}
  if (state !== 'OPEN') {
    const reason = `This pull request is ${state === 'MERGED' ? 'merged' : 'closed'}, and GitHub takes no review on it.`
    for (const event of REVIEW_EVENTS) blocked[event] = reason
    return { viewer: '', isAuthor, state, permission, blocked }
  }
  if (permission === 'NONE') {
    const reason = 'The signed-in GitHub account has no permission on this repository.'
    for (const event of REVIEW_EVENTS) blocked[event] = reason
    return { viewer: '', isAuthor, state, permission, blocked }
  }
  if (isAuthor) {
    blocked.APPROVE =
      'You opened this pull request. GitHub does not let you approve your own pull request; comment on it or request changes instead.'
  }
  return { viewer: '', isAuthor, state, permission, blocked }
}

/**
 * The threads of one pull request together with what the signed-in account may
 * do to it.
 *
 * The read is pinned to one comparison the way the file and commit reads are:
 * the head and base object ids are captured before the pages and again after
 * them. A thread's `line` and `isOutdated` are statements about a diff, and a
 * diff that moved mid-read is a mixture of two truths, so a moved comparison
 * fails the read instead of labelling it.
 */
export async function readReviewThreads(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewThreadRead> {
  const remote = await originRemote(repoPath, signal)
  const { comparison: before } = await readReviewIdentity(remote, number, signal)
  const threads: ReviewThread[] = []
  // Threads whose own comment connection still had another page, followed once
  // the outer pages are done.
  const continued: Array<{ thread: ReviewThread; cursor: string; total: number }> = []
  let totalCount = 0
  let permission = 'UNKNOWN'
  let isAuthor = false
  let state: 'OPEN' | 'CLOSED' | 'MERGED' = 'OPEN'
  let after: string | null = null
  let page = 0
  let stoppedAtPageLimit = false

  do {
    const data: Record<string, unknown> = await reviewTransport(remote).graphql<
      Record<string, unknown>
    >(THREADS_QUERY, { owner: remote.owner, name: remote.name, number, after }, { signal })
    const repository: Record<string, unknown> | null = isRecord(data.repository)
      ? data.repository
      : null
    const pullRequest: Record<string, unknown> | null =
      repository && isRecord(repository.pullRequest) ? repository.pullRequest : null
    if (!pullRequest) {
      throw new Error(`Pull request #${number} is no longer available on GitHub.`)
    }
    if (typeof repository?.viewerPermission === 'string') {
      permission = repository.viewerPermission
    }
    isAuthor = pullRequest.viewerDidAuthor === true
    if (
      pullRequest.state === 'OPEN' ||
      pullRequest.state === 'CLOSED' ||
      pullRequest.state === 'MERGED'
    ) {
      state = pullRequest.state
    }
    const connection: Record<string, unknown> | null = isRecord(pullRequest.reviewThreads)
      ? pullRequest.reviewThreads
      : null
    if (!connection) break
    if (typeof connection.totalCount === 'number') totalCount = connection.totalCount
    for (const node of Array.isArray(connection.nodes) ? connection.nodes : []) {
      const parsed = parseThread(node)
      if (!parsed) continue
      threads.push(parsed.thread)
      if (parsed.commentCursor !== null) {
        continued.push({
          thread: parsed.thread,
          cursor: parsed.commentCursor,
          total: parsed.commentTotal,
        })
      }
    }
    const pageInfo: Record<string, unknown> | null = isRecord(connection.pageInfo)
      ? connection.pageInfo
      : null
    const cursor = pageInfo && typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null
    const hasNext: boolean = pageInfo?.hasNextPage === true && cursor !== null
    page += 1
    if (hasNext && page >= REVIEW_THREAD_PAGE_LIMIT) {
      stoppedAtPageLimit = true
      after = null
    } else {
      after = hasNext ? cursor : null
    }
  } while (after !== null)

  // A thread's comments are a connection of their own, with their own cursor, so
  // the outer pages being exhausted says nothing about whether a long
  // conversation was read whole. These are followed here, bounded like the
  // outer read: past the ceiling the thread keeps its truncation mark, which is
  // what stops a partial reply history from being drawn as the whole one.
  for (const pending of continued.slice(0, REVIEW_COMMENT_FOLLOW_LIMIT)) {
    let cursor: string | null = pending.cursor
    let commentPage = 0
    while (cursor !== null && commentPage < REVIEW_COMMENT_PAGE_LIMIT) {
      const more: { comments: ReviewThreadComment[]; cursor: string | null } =
        await readThreadCommentPage(remote, pending.thread.id, cursor, signal)
      pending.thread.comments.push(...more.comments)
      cursor = more.cursor
      commentPage += 1
    }
    pending.thread.commentCount = pending.total
    pending.thread.commentsTruncated = pending.thread.comments.length < pending.total
  }

  const { comparison: confirmed } = await readReviewIdentity(remote, number, signal)
  if (
    before.headOid === null ||
    confirmed.headOid === null ||
    !sameReviewComparison(before, confirmed)
  ) {
    throw new ReviewRevisionMovedError(number)
  }

  return {
    threads: {
      number,
      // A thread's line numbers are addresses in a comparison, so the set
      // carries the whole one. It comes from the same confirmed identity read
      // that the file read publishes, so the two agree for one pull request at
      // one instant instead of churning against each other.
      comparison: confirmed,
      threads,
      totalCount,
      truncated: stoppedAtPageLimit || threads.length < totalCount,
    },
    permissions: reviewPermissions(permission, isAuthor, state),
  }
}

/** The permissions alone, for the preflight that runs before a write. */
export async function readReviewPermissions(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewPermissions> {
  const remote = await originRemote(repoPath, signal)
  const data = await reviewTransport(remote).graphql<Record<string, unknown>>(
    PERMISSIONS_QUERY,
    { owner: remote.owner, name: remote.name, number },
    { signal },
  )
  const repository = isRecord(data.repository) ? data.repository : null
  const pullRequest = repository && isRecord(repository.pullRequest) ? repository.pullRequest : null
  if (!pullRequest) throw new Error(`Pull request #${number} is no longer available on GitHub.`)
  const raw = pullRequest.state
  const state: 'OPEN' | 'CLOSED' | 'MERGED' =
    raw === 'CLOSED' || raw === 'MERGED' || raw === 'OPEN' ? raw : 'OPEN'
  const viewer = isRecord(data.viewer) ? data.viewer.login : null
  const permissions = reviewPermissions(
    typeof repository?.viewerPermission === 'string' ? repository.viewerPermission : 'UNKNOWN',
    pullRequest.viewerDidAuthor === true,
    state,
  )
  return {
    ...permissions,
    viewer: typeof viewer === 'string' && viewer !== '' ? viewer : '',
  }
}

/**
 * Where each draft's lines sit at a freshly read head, and why a draft that
 * moved cannot be written.
 *
 * Resolution is the existing `resolveReviewAnchor`, so a draft is judged by the
 * same rule as any stored line reference: a moved line is still that line, an
 * ambiguous one is never guessed, and resolution never crosses a side.
 */
export function resolveReviewDrafts(
  files: ReviewFileSet,
  drafts: readonly ReviewDraft[],
): ReviewDraftResolution[] {
  const resolutions: ReviewDraftResolution[] = []
  for (const draft of drafts) {
    const end = resolveReviewAnchor(files, draft.ref)
    if (end.match === 'unresolved' || end.ref === null) {
      resolutions.push({
        id: draft.id,
        match: 'unresolved',
        side: null,
        line: null,
        startLine: null,
        reason: end.reason,
      })
      continue
    }
    if (draft.startRef === null) {
      resolutions.push({
        id: draft.id,
        match: end.match,
        side: end.ref.side,
        line: end.ref.line,
        startLine: null,
        reason: end.reason,
      })
      continue
    }
    const start = resolveReviewAnchor(files, draft.startRef)
    if (start.match === 'unresolved' || start.ref === null) {
      resolutions.push({
        id: draft.id,
        match: 'unresolved',
        side: null,
        line: null,
        startLine: null,
        reason: `The first line of this comment no longer names a line. ${start.reason}`,
      })
      continue
    }
    const span = reviewDraftSpan({ ...draft, ref: end.ref, startRef: start.ref })
    if (span === null) {
      resolutions.push({
        id: draft.id,
        match: 'unresolved',
        side: end.ref.side,
        line: end.ref.line,
        startLine: null,
        reason: `A comment range may not cross a file or a side, and this one now runs from ${start.ref.path} ${SIDE_NAMES[start.ref.side]} line ${start.ref.line} to ${end.ref.path} ${SIDE_NAMES[end.ref.side]} line ${end.ref.line}.`,
      })
      continue
    }
    resolutions.push({
      id: draft.id,
      match: end.match === 'moved' || start.match === 'moved' ? 'moved' : 'exact',
      side: end.ref.side,
      line: span.end,
      startLine: span.start === span.end ? null : span.start,
      reason: end.reason,
    })
  }
  return resolutions
}

const SIDE_NAMES: Record<ReviewSide, string> = { base: 'base', head: 'head' }

/**
 * Where each draft's lines sit at the head right now, for the view that has to
 * mark a stale draft before anybody presses submit.
 *
 * It reads the file set through the same pinned path the workspace uses, so the
 * answer describes the same comparison the diff on screen was read at. A draft
 * written before a force-push comes back unresolved, or moved onto the line it
 * now occupies, and the reviewer's words stay in the draft either way.
 */
export async function resolveReviewDraftsAt(
  repoPath: string,
  number: number,
  drafts: ReviewDraft[],
  signal?: AbortSignal,
): Promise<ReviewDraftResolution[]> {
  if (drafts.length === 0) return []
  const remote = await originRemote(repoPath, signal)
  return resolveReviewDrafts(await readReviewFilesFrom(remote, number, signal), drafts)
}

/**
 * One comment of an attempt, in the shape the record stores it.
 *
 * The input is the wire comment, so its sides are GitHub's own `LEFT`/`RIGHT`
 * and have to be converted here. Reading them as though they were the app's
 * `base`/`head` would record every comment on a deleted line as a comment on the
 * head, and drop the start side of every range, so the record would no longer
 * describe what was sent and `sameCommentSet` could never match it again. That
 * is the difference between recovering a lost deletion comment and holding it
 * forever, so the conversion is done in one place for both ends of a range.
 */
function recordableComment(
  comment: Record<string, unknown>,
  draftId: string | null = null,
): UncertainComment {
  const side = sideOf(comment.side) ?? 'head'
  return {
    path: String(comment.path ?? ''),
    side,
    line: Number(comment.line ?? 0),
    startLine: typeof comment.start_line === 'number' ? comment.start_line : null,
    // GitHub defaults `start_side` to RIGHT but sends null when there is no
    // range, and a one-line comment is stored here as the null it arrived as.
    startSide: typeof comment.start_line === 'number' ? (sideOf(comment.start_side) ?? side) : null,
    body: String(comment.body ?? '').trim(),
    // Which composition this comment is, so a later submission can deliver it by
    // identity rather than by where it sits.
    draftId,
  }
}

/** One inline comment in the field names GitHub's create-review endpoint */
function wireComment(
  resolution: ReviewDraftResolution,
  draft: ReviewDraft,
  path: string,
): Record<string, unknown> {
  const side = WIRE_SIDES[resolution.side ?? 'head']
  const comment: Record<string, unknown> = {
    path,
    body: draft.body,
    line: resolution.line,
    side,
  }
  if (resolution.startLine !== null) {
    comment.start_line = resolution.startLine
    comment.start_side = side
  }
  return comment
}

/**
 * Writes every pending draft as one review.
 *
 * The anchors are revalidated here, not where the reviewer read the diff: the
 * file set is read again through the same pinned path the workspace uses, and
 * every draft is resolved against that read. One unresolved draft refuses the
 * whole submission, so a comment is never posted onto a line the reviewer did
 * not choose, and a review is never posted half-written.
 */
export async function submitReview(
  repoPath: string,
  number: number,
  submission: ReviewSubmission,
  signal?: AbortSignal,
): Promise<ReviewMutationResult> {
  const remote = await originRemote(repoPath, signal)
  const repo = `${remote.owner}/${remote.name}`
  const permissions = await readReviewPermissionsFrom(remote, number, signal)
  const blocked = permissions.blocked[submission.event]
  if (blocked) throw new Error(blocked)

  // A previous attempt whose result never arrived blocks this one. The check
  // needs the identity of the write, so it runs once the comments are resolved —
  // and before the request is journalled or sent, not after.

  const sendable = submission.drafts.filter((draft) => draft.body.trim() !== '')
  if (sendable.length === 0) throw new Error('Write at least one comment before submitting.')
  if (submission.event === 'REQUEST_CHANGES' && submission.body.trim() === '') {
    throw new Error('Requesting changes needs a summary saying what must change.')
  }

  const files = await readReviewFilesFrom(remote, number, signal)
  if (files.comparison.headOid === null) {
    throw new Error(
      `The head of #${number} could not be read, so a review cannot be pinned to a commit. Reload the pull request.`,
    )
  }
  // The comparison the reviewer was shown, not one inferred from what still
  // matches. This is checked before the anchors are resolved on purpose: a
  // comment can survive a force-push by landing on the same text at a new line,
  // and adopting that silently would approve a revision nobody opened.
  if (
    submission.comparison.headOid !== files.comparison.headOid ||
    submission.comparison.baseOid !== files.comparison.baseOid ||
    submission.comparison.baseRef !== files.comparison.baseRef
  ) {
    throw new ReviewComparisonMovedError(number, submission.comparison, files.comparison)
  }
  const resolutions = resolveReviewDrafts(files, sendable)
  if (resolutions.some((entry) => entry.match === 'unresolved')) {
    throw new ReviewAnchorStaleError(number, resolutions)
  }

  const byId = new Map(resolutions.map((entry) => [entry.id, entry]))
  const comments = sendable.map((draft) =>
    wireComment(byId.get(draft.id)!, draft, reviewDraftStart(draft).path),
  )
  // The attempt is identified by the comments it would post, the comparison it
  // would post them on, and the drafts they came from — not by the summary. A
  // reviewer who edits only the summary has not written a different review, and
  // keying on the summary would let them post the same comments twice by
  // changing one sentence. The drafts are in the identity because the comments
  // alone cannot say which composition they are: the same line carrying the same
  // words twice is two pieces of work, and a recovery has to be able to tell
  // them apart.
  const attempt = reviewAttemptId(
    comments,
    files.comparison,
    sendable.map((d) => d.id),
  )
  // Each comment is recorded with the draft it came from. `comments` is built
  // from `sendable` in order, so the two are index for index.
  const recorded = comments.map((comment, index) =>
    recordableComment(comment, sendable[index]?.id ?? null),
  )
  const draftIds = sendable.map((draft) => draft.id)

  // A settled record the view has finished with is retired here, before this
  // submission reconciles anything. The payload is the acknowledgement: a draft
  // the view has dropped is not in it, so the evidence that GitHub holds it is
  // no longer what is stopping a duplicate. What is carried in the payload is
  // still being held on for, and is left alone — and so is any record about a
  // comparison other than this one, which this payload cannot speak for.
  await retireSettledWrites(
    repoPath,
    repo,
    number,
    permissions.viewer,
    files.comparison,
    draftIds,
    signal,
  )

  // Re-sending because the network looked idle is how a review gets posted
  // twice. The record survives a reload, so this still holds after the
  // workspace is reopened, and it covers the crash case because the record was
  // written before the request rather than after its failure. Every attempt
  // whose drafts this payload would write again is reconciled first, whatever
  // decision or batch size is being sent now.
  const guard = await reconcileOverlappingAttempts(
    repoPath,
    remote,
    repo,
    number,
    permissions.viewer,
    recorded,
    files.comparison,
    draftIds,
    signal,
  )
  if (guard.unsettled) throw new ReviewWriteUncertainError(guard.unsettled)
  // Comments GitHub already holds are left out of what is sent now, so a
  // recovery posts only what never arrived. They are recognised by the draft
  // each was composed under, which is what the caller has: `comments` is built
  // from `sendable` in order, so the two are index for index. A draft the
  // payload composes afresh is not among them however much it resembles one
  // that landed, and is sent.
  const delivered = new Set<string>()
  const undelivered: Array<{ comment: Record<string, unknown>; draftId: string | null }> = []
  comments.forEach((comment, index) => {
    const draftId = sendable[index]?.id ?? null
    if (draftId !== null && guard.delivered.has(draftId)) {
      delivered.add(draftId)
      return
    }
    undelivered.push({ comment, draftId })
  })
  const postedIds = undelivered
    .map((entry) => entry.draftId)
    .filter((id): id is string => id !== null)
  // The comments as GitHub is asked for them, and the same comments as the
  // journal records them, each carrying the identity it was composed under.
  const toSend = undelivered.map((entry) => entry.comment)
  const toRecord = undelivered.map((entry) => recordableComment(entry.comment, entry.draftId))
  // Everything in this payload is already on GitHub, so the outcome GitHub
  // recorded for the review that carried them is what is reported. The
  // settled records stay where they are: the view has not necessarily dropped
  // these drafts yet, and a crash before it does must not cost the evidence.
  if (undelivered.length === 0) {
    const settledReview = guard.settled[0]
    if (files.comparison.headOid) {
      await markReviewSnapshotReviewed(
        repoPath,
        repo,
        permissions.viewer,
        number,
        files.comparison,
        settledReview?.id ?? null,
      ).catch(() => {})
    }
    return {
      id: settledReview?.id ?? attempt,
      state: settledReview?.state ?? '',
      url: settledReview?.url ?? null,
      delivered: [...delivered],
    }
  }

  // What is journalled is what is sent: the undelivered subset, no more. If the
  // whole payload were recorded while only part of it went out, a lost response
  // would be reconciled against comments GitHub was never asked to take, and
  // this attempt could never be recognised at all.
  const sentAt = new Date().toISOString()
  const boundary = await readReviewBoundary(remote, number, signal)
  const journalled = {
    id: reviewAttemptId(toSend, files.comparison, postedIds),
    number,
    kind: 'review' as const,
    summary: reviewAttemptSummary(submission.body),
    threadId: null,
    headOid: files.comparison.headOid,
    // The whole comparison, because the head alone does not identify a diff: a
    // retargeted base renames every line under a head that never moved.
    comparison: files.comparison,
    // The drafts this record covers — the undelivered ones, which are exactly
    // what is about to be sent. A later payload carrying any of them is this
    // write's recovery even after a crash; a payload carrying none is the
    // reviewer having moved on, and one carrying a different set is new work.
    draftIds: postedIds,
    event: submission.event,
    at: sentAt,
    repo: `${remote.owner}/${remote.name}`,
    viewer: permissions.viewer,
    comments: toRecord,
    // What GitHub already held when the attempt began, and whether that could
    // be established. A reconciliation stops when it reaches a complete
    // boundary's review, and does not search a history it could not bound.
    boundary,
    threadCommentIds: [],
    settled: null,
  }
  // The attempt is journalled BEFORE the request leaves, not after it fails. A
  // crash, a kill, or a power cut between the POST and its response is the exact
  // case this guard exists for, and a record written only on the failure path
  // would be missing for precisely that one. So the journal is the first thing
  // that happens.
  await recordUncertainWrite(repoPath, journalled, signal)
  try {
    const response = await reviewTransport(remote).rest<unknown>({
      method: 'POST',
      path: `repos/${remote.owner}/${remote.name}/pulls/${number}/reviews`,
      body: {
        commit_id: files.comparison.headOid,
        body: submission.body,
        event: EVENT_NAMES[submission.event],
        // The undelivered subset, which is exactly what was journalled. Sending
        // the whole payload here would re-post the comments this recovery just
        // adopted from an earlier review — the duplicate the whole guard exists
        // to prevent — and would leave the record describing something other
        // than what GitHub was asked to write.
        comments: toSend,
      },
      signal,
    })
    const record = isRecord(response.data) ? response.data : {}
    const settledId = typeof record.id === 'number' ? String(record.id) : String(record.id ?? '')
    const settledState = typeof record.state === 'string' ? record.state : ''
    // GitHub answered, so this attempt is settled — but the record is kept as
    // settled evidence rather than deleted. The view is told what was delivered,
    // and the app can die between GitHub's answer and the view dropping the
    // draft; with the record gone the next submission would post it again.
    // Retiring it is the next payload's job, and only a payload that no longer
    // mentions these comments can do that.
    await recordUncertainWrite(
      repoPath,
      {
        ...journalled,
        settled: {
          reviewId: settledId,
          state: settledState,
          url: typeof record.html_url === 'string' ? record.html_url : null,
          at: new Date().toISOString(),
        },
      },
      signal,
    )
    // Everything confirmed by this operation: the comments adopted from an
    // earlier review and the ones just posted. Reporting only the adopted ones
    // would leave the newly posted comments in the view, and submitting again
    // would post them a second time.
    for (const id of postedIds) delivered.add(id)
    if (files.comparison.headOid) {
      await markReviewSnapshotReviewed(
        repoPath,
        repo,
        permissions.viewer,
        number,
        files.comparison,
        settledId,
      ).catch(() => {})
    }
    return {
      id: settledId,
      state: settledState,
      url: typeof record.html_url === 'string' ? record.html_url : null,
      delivered: [...delivered],
    }
  } catch (error) {
    if (outcomeUnknown(error)) {
      // The record went on before the request, so the guard is in force for this
      // failure, for a reload, and for a crash. The records that were already
      // settled stay settled, so the comments this recovery adopted keep their
      // evidence even though this submission did not complete.
      throw new ReviewOutcomeUnknownError(transportDetail(error))
    }
    // A refusal is GitHub's own decision and needs no record of its own: nothing
    // was applied, so the next attempt of these comments is a first attempt.
    // Records already settled for other comments are left alone, because those
    // comments are on GitHub whatever this refusal said.
    await clearUncertainWrite(repoPath, repo, number, permissions.viewer, journalled.id, signal)
    throw error
  }
}

/**
 * The summary a review carries, as GitHub stores it. A reconciliation matches
 * the review GitHub holds against this text, so it is the body on its own
 * rather than the body packed together with the comment texts.
 */
function reviewAttemptSummary(body: string): string {
  return body.trim()
}

/**
 * The comments of one review, as the identity of that review.
 *
 * This is deliberately the posted comments, the comparison and the drafts, not
 * the summary. The summary is free text the reviewer can edit at will, and
 * keying on it would mean that changing one sentence is enough to slip past the
 * guard and post the same comments a second time — which is the duplicate this
 * exists to prevent. What makes a write the same write is what it says, which
 * diff it says it about, and which composition it came from; so that is the
 * identity. The drafts are in it because the comments alone cannot say: the same
 * line carrying the same words, written a second time after the first was sent,
 * is a different review, and hashing it to the same id would let the first
 * answer for the second.
 */
function reviewAttemptId(
  comments: readonly Record<string, unknown>[],
  comparison: ReviewComparison,
  draftIds: readonly string[],
): string {
  const positions = comments
    .map((comment) =>
      [comment.path, comment.side, comment.line, comment.start_line, comment.start_side]
        .map((part) => String(part ?? ''))
        .join(':'),
    )
    .join('|')
  const where = [comparison.headOid, comparison.baseOid, comparison.baseRef]
    .map((part) => String(part ?? ''))
    .join(':')
  return shortHash(`${where} ${draftIds.join(',')} ${positions}`)
}

/**
 * The comment in a thread that a lost reply turned out to be, or null.
 *
 * Body equality alone is not enough, in either direction. The comment must not
 * have been there when the attempt began, or an older identical reply — this
 * account's own or somebody else's — would be adopted as this one. And it must
 * be this account's, because a collaborator who happened to write the same
 * words did not write this reviewer's reply.
 */
function findLandedReply(
  comments: readonly ReviewThreadComment[],
  attempt: { threadCommentIds: readonly string[]; viewer?: string },
  body: string,
): { id: string; url: string | null } | null {
  for (const entry of comments) {
    if (attempt.threadCommentIds.includes(entry.id)) continue
    if (attempt.viewer !== undefined && entry.author !== attempt.viewer) continue
    if (entry.body.trim() !== body.trim()) continue
    return { id: entry.id, url: entry.url }
  }
  return null
}

/** A stable short identifier for a write, so the guard can name it across reloads. */
function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Every outstanding attempt whose unresolved comments this submission would
 * write again, and what GitHub turns out to hold for them.
 *
 * The overlap is on the comment anchors, not on the whole attempt. A decision
 * change or one more pending draft produces a different attempt for the same
 * unresolved comments, and matching on the full payload would let those comments
 * be posted a second time — which is the duplicate this exists to prevent. So
 * every attempt touching any line this payload writes is reconciled first.
 *
 * A record that a previous reconciliation already settled is answered from
 * itself, without asking GitHub again, and is *kept*: it is the durable evidence
 * that those comments are on GitHub, and the only thing that retires it is a
 * later payload carrying none of its drafts. A record settled here is written
 * back for the same reason. Retiring either one as soon as it settles would drop
 * the evidence while the submission that found it is still free to fail.
 *
 * A record is about one comparison and one set of drafts, and it is asked about
 * only in those terms. A different comparison is a different diff: the same
 * head commit against a retargeted base names different lines, and a settled
 * record proves nothing about it. A different draft is different work: the
 * first review was acknowledged and its draft cleared, so the same words on the
 * same line are a comment the reviewer has just written, and it is not the
 * settled record's recovery. Answering either is not a small slip — it clears
 * unsent work and returns a decision, an approval say, that GitHub was never
 * sent. Both are therefore neither delivered nor a hold.
 */
async function reconcileOverlappingAttempts(
  repoPath: string,
  remote: ParsedRemote,
  repo: string,
  number: number,
  viewer: string,
  comments: readonly UncertainComment[],
  comparison: ReviewComparison,
  draftIds: readonly string[],
  signal?: AbortSignal,
): Promise<{
  delivered: Set<string>
  unsettled: ReviewUncertainWrite | null
  settled: SettledReview[]
}> {
  const delivered = new Set<string>()
  const settled: SettledReview[] = []
  const writes = await readUncertainWrites(repoPath, repo, number, viewer, signal)
  const outstanding = writes.filter(
    (entry) =>
      entry.kind === 'review' &&
      // The comparison, not the head: a retargeted or advanced base renames every
      // line in the diff while the head commit stands still, so an old review
      // carries the same `commit_id` as a new one and would satisfy a head-only
      // check.
      sameReviewComparison(entry.comparison, comparison) &&
      // The drafts, by their own identity. A draft's identity is minted rather
      // than derived from its line, so the same line carrying the same words a
      // second time is a different draft. Sharing one identity is what makes a
      // record about this submission rather than a stranger's: the record
      // composed at least one of the comments being sent now, so it can prove
      // that one landed. Where it cannot, the comment is sent.
      entry.draftIds.some((theirs) => draftIds.includes(theirs)) &&
      entry.comments.length > 0,
  )
  for (const attempt of outstanding) {
    const landed =
      attempt.settled !== null
        ? { id: attempt.settled.reviewId, state: attempt.settled.state, url: attempt.settled.url }
        : await findSettledReview(remote, number, attempt, signal)
    // GitHub holds exactly this review, so the comments it posted are already
    // there. The record is kept and those comments are reported by the identity
    // they were composed under, so the payload that follows leaves out those and
    // nothing else.
    if (landed) {
      settled.push(landed)
      if (attempt.settled === null) {
        await recordUncertainWrite(
          repoPath,
          {
            ...attempt,
            settled: {
              reviewId: landed.id,
              state: landed.state,
              url: landed.url,
              at: new Date().toISOString(),
            },
          },
          signal,
        )
      }
      // One comment of that review, delivered, is one comment of this payload.
      // It is matched by the identity it was composed under and then by what it
      // says and where, because a draft can be edited after it is composed: a
      // rewrite under the same identity is the reviewer's new words and is sent
      // rather than dropped.
      //
      // The identity is what stops the record answering for a comment it never
      // posted. A review of `A` and `B` that landed and was never acknowledged,
      // followed by a payload carrying the same `A` and a fresh `B` written on
      // the same line with the same words, is two comments sharing everything
      // except their identity — and matching on the line would take the new `B`
      // for the old one, report the whole payload delivered, and send no
      // approval at all. Only the `A` is on GitHub, and only the `A` is
      // reported.
      for (const comment of attempt.comments) {
        if (comment.draftId === null || !draftIds.includes(comment.draftId)) continue
        const match = comments.find(
          (mine) =>
            mine.draftId === comment.draftId &&
            sameAnchor(comment, mine) &&
            mine.body.trim() === comment.body.trim(),
        )
        if (match) delivered.add(match.draftId as string)
      }
      continue
    }
    // The record says only that the app never heard back, which is also true of
    // a request that never reached GitHub, so absence is not proof and the whole
    // submission waits rather than posting the same comments a second time.
    return { delivered, unsettled: attempt, settled }
  }
  return { delivered, unsettled: null, settled }
}

/** Whether two comments name the same line in the same file. */
function sameAnchor(one: UncertainComment, other: UncertainComment): boolean {
  return anchorKey(one) === anchorKey(other)
}

/** A comment's identity as a place in the diff, which is what an overlap is. */
function anchorKey(comment: UncertainComment): string {
  return [
    comment.path,
    comment.side,
    comment.line,
    comment.startLine ?? '',
    comment.startSide ?? '',
  ]
    .map(String)
    .join(':')
}

/**
 * The newest review the pull request already holds, and whether that could be
 * established at all.
 *
 * Read immediately before the request so the record carries the boundary as it
 * was at the moment of the attempt, not as it is whenever a reconciliation runs
 * later. A failure to read it does not block the write: the reviewer's own
 * decision to submit is not withheld because a boundary could not be noted, and
 * an unknown boundary makes the reconciliation hold rather than adopt wrongly.
 *
 * The two answers are kept apart because they say opposite things about the
 * history. "This pull request held no review" means every review GitHub has is
 * newer than the attempt, so any of them may be the lost one. "The walk never
 * reached the end" means the newest review is not known and the history still
 * contains reviews that predate the attempt — and searching that for a match
 * finds somebody else's review. So a walk that cannot finish is unknown, and
 * unknown holds.
 */
async function readReviewBoundary(
  remote: ParsedRemote,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewBoundary> {
  let newest: number | null = null
  for (let page = 1; page <= REVIEW_REST_REVIEW_PAGES; page += 1) {
    const rows = await restList(
      remote,
      `repos/${remote.owner}/${remote.name}/pulls/${number}/reviews`,
      page,
      signal,
    )
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'number') continue
      if (newest === null || row.id > newest) newest = row.id
    }
    // The list is chronological, so page one is the *oldest* hundred reviews and
    // the boundary has to be read off the last one. A short page is the end of
    // the list, and only a short page is.
    if (rows.length < REVIEW_REST_PAGE_SIZE) {
      return { kind: 'complete', latestReviewId: newest === null ? null : String(newest) }
    }
  }
  return { kind: 'unknown' }
}

/** A review on GitHub that a lost attempt turned out to be. */
interface SettledReview {
  id: string
  state: string
  url: string | null
}

/**
 * The review a lost attempt turned out to be, or null when GitHub does not hold
 * one this could recognise.
 *
 * Every part of the attempt is checked, because any one of them alone is shared
 * with a review that has nothing to do with this one:
 *
 * - **newer than the attempt's boundary**, so an older review cannot be adopted
 *   however much its wording matches;
 * - **this account's**, because a collaborator's review is not this write;
 * - **this revision**, because a review of an earlier commit approved something
 *   nobody is approving now;
 * - **the same decision**, matched on the state GitHub recorded rather than the
 *   event that was asked for, so a COMMENT never adopts an APPROVE;
 * - **the same comments**, matched as a set on body and anchor, because the
 *   comments are the review and a matching summary proves nothing.
 *
 * The reviews are walked newest first, and the walk stops at the boundary rather
 * than at the end of a window, so an attempt that landed long ago is still
 * found. A boundary that was never established stops the search before it
 * starts: the history it cannot rule out is exactly the history that must not be
 * searched, so the record stays outstanding and a later attempt looks again.
 */
async function findSettledReview(
  remote: ParsedRemote,
  number: number,
  attempt: ReviewUncertainWrite,
  signal?: AbortSignal,
): Promise<SettledReview | null> {
  // An unknown boundary is not a boundary of zero. It says the walk never
  // reached the end of the review history, so the history still holds reviews
  // that predate this attempt — and one of them can match in every field the
  // comparison below makes. Searching anyway would answer a lost write with
  // somebody else's review and report unsent comments as delivered, so the
  // history is not searched at all.
  if (attempt.boundary.kind === 'unknown') return null
  const boundary =
    attempt.boundary.latestReviewId === null ? null : Number(attempt.boundary.latestReviewId)
  const snapshot = await readRestReviews(remote, number, signal)
  const reviews = [...snapshot.reviews].sort((one, other) => other.id - one.id)
  for (const review of reviews) {
    // Everything at or below the boundary already existed when the attempt began.
    if (boundary !== null && !Number.isNaN(boundary) && review.id <= boundary) return null
    const settled = matchAttemptReview(review, snapshot.commentsByReview, attempt)
    if (settled) return settled
  }
  return null
}

/** Whether one review on GitHub is exactly the review a lost attempt tried to post. */
function matchAttemptReview(
  review: RestReview,
  commentsByReview: Map<number, UncertainComment[]>,
  attempt: ReviewUncertainWrite,
): SettledReview | null {
  if (attempt.comments.length === 0) return null
  if (review.author !== attempt.viewer) return null
  if (review.commitId !== attempt.headOid) return null
  if (review.state !== stateForEvent(attempt.event)) return null
  if (review.body.trim() !== attempt.summary.trim()) return null
  // A review whose comments were not read whole cannot be compared whole, and a
  // partial comparison would claim a match that was never made. What is compared
  // here is every page of the pull request's review comments, grouped by the
  // review that carries them, so a review of any supported size — up to the 200
  // comments GitHub accepts in one review — is compared whole rather than held
  // forever because its tail fell outside one page.
  if (!sameCommentSet(commentsByReview.get(review.id) ?? [], attempt.comments)) return null
  return { id: String(review.id), state: review.state, url: review.url }
}

/**
 * Whether two sets of inline comments are the same comments.
 *
 * A multiset, not a sequence: GitHub returns a review's comments in the order
 * they were posted, which is the order they were sent, but comparing sorted
 * keys makes the match independent of that ordering rather than depending on it
 * holding.
 */
function sameCommentSet(
  actual: readonly UncertainComment[],
  expected: readonly UncertainComment[],
): boolean {
  if (actual.length !== expected.length) return false
  const key = (comment: UncertainComment) =>
    [comment.path, comment.side, comment.line, comment.startLine ?? '', comment.startSide ?? '']
      .map(String)
      .join(':') +
    '\u0000' +
    comment.body.trim()
  const count = new Map<string, number>()
  for (const comment of expected) count.set(key(comment), (count.get(key(comment)) ?? 0) + 1)
  for (const comment of actual) {
    const seen = count.get(key(comment))
    if (seen === undefined || seen === 0) return false
    count.set(key(comment), seen - 1)
  }
  return true
}

/** The state GitHub records for a decision, which is what a reconciliation matches. */
function stateForEvent(event: ReviewEvent | null): string | null {
  if (event === 'APPROVE') return 'APPROVED'
  if (event === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED'
  if (event === 'COMMENT') return 'COMMENTED'
  return null
}

async function readReviewPermissionsFrom(
  remote: ParsedRemote,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewPermissions> {
  const data = await reviewTransport(remote).graphql<Record<string, unknown>>(
    PERMISSIONS_QUERY,
    { owner: remote.owner, name: remote.name, number },
    { signal },
  )
  const repository = isRecord(data.repository) ? data.repository : null
  const pullRequest = repository && isRecord(repository.pullRequest) ? repository.pullRequest : null
  if (!pullRequest) throw new Error(`Pull request #${number} is no longer available on GitHub.`)
  const raw = pullRequest.state
  const state: 'OPEN' | 'CLOSED' | 'MERGED' =
    raw === 'CLOSED' || raw === 'MERGED' || raw === 'OPEN' ? raw : 'OPEN'
  const login = isRecord(data.viewer) ? data.viewer.login : null
  const permissions = reviewPermissions(
    typeof repository?.viewerPermission === 'string' ? repository.viewerPermission : 'UNKNOWN',
    pullRequest.viewerDidAuthor === true,
    state,
  )
  return {
    ...permissions,
    viewer: typeof login === 'string' && login !== '' ? login : '',
  }
}

/**
 * Replies to a thread.
 *
 * A reply is its own comment, so a duplicate would be a second comment rather
 * than a harmless repeat. The thread is read first to learn the comments that
 * exist; if the reply then fails in a way that does not say whether GitHub acted,
 * the thread is read again and the outcome is reported from what GitHub now
 * holds. Nothing is resent either way.
 */
export async function replyToThread(
  repoPath: string,
  number: number,
  threadId: string,
  body: string,
  signal?: AbortSignal,
): Promise<ReviewMutationResult> {
  if (body.trim() === '') throw new Error('Write a reply before sending it.')
  const remote = await originRemote(repoPath, signal)
  // The journal is per repository, so the account is read to scope the guard to
  // whoever is actually replying: another account's unresolved reply must not
  // block this one.
  const repo = `${remote.owner}/${remote.name}`
  const permissions = await readReviewPermissionsFrom(remote, number, signal)
  const attempt = shortHash(`reply ${threadId} ${body.trim()}`)
  const before = await readThreadCommentIds(remote, threadId, signal)

  // A reply that was sent and never confirmed blocks the same reply, by the
  // same thread and the same words, and the record is on disk so it still holds
  // after the workspace is reopened. As with a review, the block is reconciled
  // against GitHub first: a reply GitHub already holds means it landed, the
  // record is retired, and the thread is re-read rather than written twice.
  const writes = await readUncertainWrites(repoPath, repo, number, permissions.viewer, signal)
  const earlier = writes.find((entry) => entry.kind === 'reply' && entry.id === attempt)
  if (earlier) {
    const landed = findLandedReply(
      await readThreadComments(remote, threadId, signal),
      { threadCommentIds: earlier.threadCommentIds, viewer: earlier.viewer },
      body,
    )
    // GitHub holds these words in this thread, written by this account after the
    // attempt began, so the earlier attempt did land. Its outcome is reported
    // and the record retired: sending again would be a second copy of the same
    // reply, which is the duplicate this guard prevents.
    if (landed) {
      await clearUncertainWrite(repoPath, repo, number, permissions.viewer, attempt, signal)
      return { id: landed.id, state: 'created', url: landed.url }
    }
    throw new ReviewWriteUncertainError(earlier)
  }

  // Journalled before the mutation leaves, for the same reason as a review: a
  // crash between the request and its response is the case with no failure to
  // hang the record on. Only GitHub's own answer removes it.
  await recordUncertainWrite(
    repoPath,
    {
      id: attempt,
      number,
      kind: 'reply',
      summary: body.trim(),
      threadId,
      headOid: null,
      // A reply is reconciled against the thread's own comment list rather than
      // a review boundary, so it carries no comparison and no drafts, and the
      // review guard skips it on kind alone.
      comparison: UNKNOWN_REVIEW_COMPARISON,
      draftIds: [],
      event: null,
      at: new Date().toISOString(),
      repo,
      viewer: permissions.viewer,
      comments: [],
      boundary: UNKNOWN_REVIEW_BOUNDARY,
      // The comments the thread already held, so a reconciliation can tell this
      // account's new words from another participant's identical ones and from
      // an older identical reply of its own.
      threadCommentIds: before,
      // A reply carries no review, so nothing settles it the way a review
      // settles: it is the thread's own comment list that answers it, and the
      // record is cleared once that list holds the reply.
      settled: null,
    },
    signal,
  )

  try {
    const data = await reviewTransport(remote).graphql<Record<string, unknown>>(
      REPLY_MUTATION,
      { threadId, body },
      { signal },
    )
    const payload = isRecord(data.addPullRequestReviewThreadReply)
      ? data.addPullRequestReviewThreadReply
      : null
    const comment = payload && isRecord(payload.comment) ? payload.comment : null
    await clearUncertainWrite(repoPath, repo, number, permissions.viewer, attempt, signal)
    return {
      id: comment && typeof comment.id === 'string' ? comment.id : '',
      state: 'created',
      url: comment && typeof comment.url === 'string' ? comment.url : null,
    }
  } catch (error) {
    if (!outcomeUnknown(error)) {
      // A refusal is GitHub's own decision; nothing was applied, so the record
      // goes and the next attempt is a first attempt.
      await clearUncertainWrite(repoPath, repo, number, permissions.viewer, attempt, signal)
      throw error
    }
    // The reply may already exist. Reading the thread is how that is found out
    // without sending a second copy of the same words. If that read itself
    // fails, the error propagates with the record — written before the request —
    // still in force, so an unreadable reconciliation can never be mistaken for
    // a settled outcome.
    const after = await readThreadComments(remote, threadId, signal)
    // The same two checks as a resumed attempt: not one of the comments the
    // thread already held, and written by this account. A collaborator's
    // identical words are not this reviewer's reply.
    const landed = findLandedReply(
      after,
      { threadCommentIds: before, viewer: permissions.viewer },
      body,
    )
    if (landed) {
      await clearUncertainWrite(repoPath, repo, number, permissions.viewer, attempt, signal)
      return { id: landed.id, state: 'created', url: landed.url }
    }
    // Otherwise the record written before the request stands, and the next
    // identical reply is refused until GitHub's own state has been read.
    throw new ReviewOutcomeUnknownError(transportDetail(error))
  }
}

/**
 * Resolves or reopens a thread.
 *
 * Both directions are idempotent on GitHub, so the state reported is the one the
 * mutation's own return value carries, and an unknown outcome is reported as
 * unknown rather than re-sent.
 */
export async function setThreadResolved(
  repoPath: string,
  threadId: string,
  resolved: boolean,
  signal?: AbortSignal,
): Promise<ReviewMutationResult> {
  const remote = await originRemote(repoPath, signal)
  const query = resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
  try {
    const data = await reviewTransport(remote).graphql<Record<string, unknown>>(
      query,
      { threadId },
      { signal },
    )
    const payload = isRecord(data[field]) ? data[field] : null
    const thread = payload && isRecord(payload.thread) ? payload.thread : null
    if (!thread || typeof thread.id !== 'string') {
      throw new ReviewOutcomeUnknownError('GitHub returned no thread for that resolution.')
    }
    return {
      id: thread.id,
      state: thread.isResolved === true ? 'resolved' : 'unresolved',
      url: null,
    }
  } catch (error) {
    if (outcomeUnknown(error)) throw new ReviewOutcomeUnknownError(transportDetail(error))
    throw error
  }
}

/** One page of a thread's comments, and the cursor the next page starts at. */
async function readThreadCommentPage(
  remote: ParsedRemote,
  threadId: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<{ comments: ReviewThreadComment[]; cursor: string | null }> {
  const data = await reviewTransport(remote).graphql<Record<string, unknown>>(
    THREAD_COMMENTS_QUERY,
    { threadId, after },
    { signal },
  )
  const node = isRecord(data.node) ? data.node : null
  const connection = node && isRecord(node.comments) ? node.comments : null
  const comments = (connection && Array.isArray(connection.nodes) ? connection.nodes : [])
    .map(parseThreadComment)
    .filter((entry): entry is ReviewThreadComment => entry !== null)
  const pageInfo = connection && isRecord(connection.pageInfo) ? connection.pageInfo : null
  const cursor =
    pageInfo && pageInfo.hasNextPage === true && typeof pageInfo.endCursor === 'string'
      ? pageInfo.endCursor
      : null
  return { comments, cursor }
}

/**
 * Every comment of one thread, across its pages.
 *
 * Both callers depend on this being the whole conversation: the display must not
 * end mid-thread, and a lost-write reconciliation has to be able to find a
 * reply that landed on a later page. Reading one page and calling it the thread
 * is what made a posted reply invisible to both.
 */
async function readThreadComments(
  remote: ParsedRemote,
  threadId: string,
  signal?: AbortSignal,
): Promise<ReviewThreadComment[]> {
  const all: ReviewThreadComment[] = []
  let cursor: string | null = null
  let page = 0
  do {
    const { comments, cursor: next } = await readThreadCommentPage(remote, threadId, cursor, signal)
    all.push(...comments)
    cursor = next
    page += 1
  } while (cursor !== null && page < REVIEW_COMMENT_PAGE_LIMIT)
  return all
}

async function readThreadCommentIds(
  remote: ParsedRemote,
  threadId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await readThreadComments(remote, threadId, signal)).map((entry) => entry.id)
}
