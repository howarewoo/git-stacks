import { createHash } from 'node:crypto'

import type { ReviewComparison, ReviewFileSet, ReviewSide } from '../shared/review'
import type {
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
  ReviewThreadSet,
} from '../shared/review-threads'
import { reviewDraftSpan, reviewDraftStart, REVIEW_EVENTS } from '../shared/review-threads'
import { isRecord, type ParsedRemote } from './git-core'
import {
  clearUncertainWrite,
  readUncertainWrites,
  recordUncertainWrite,
} from './review-drafts'
import { GitHubTransportError, githubTransport } from './github-transport'
import {
  originRemote,
  readReviewIdentity,
  readReviewFilesFrom,
  resolveReviewAnchor,
  ReviewRevisionMovedError,
} from './review'
import { sameReviewComparison } from '../shared/review'

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

/** Reviews read back when settling a write whose response was lost. */
const REVIEW_RECONCILE_LIMIT = 50

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
 * The reviews GitHub already holds for a pull request.
 *
 * This is what settles a write whose response was lost: the local record only
 * says the app never heard back, which is also true of a request GitHub dropped
 * without applying. `commit.oid` ties a recorded review to the revision it was
 * pinned to and `author` to the account that sent it, so a review that landed
 * can be told from one that never did. Bounded, because it is a reconciliation
 * of the most recent attempts rather than a history.
 */
const REVIEWS_QUERY = `query ReviewSubmitted($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: ${REVIEW_RECONCILE_LIMIT}) {
        nodes { id state body author { login } commit { oid } }
      }
    }
  }
}`

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
  const comments = connection && Array.isArray(connection.nodes)
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
    const data: Record<string, unknown> = await githubTransport().graphql<Record<string, unknown>>(
      THREADS_QUERY,
      { owner: remote.owner, name: remote.name, number, after },
      { signal },
    )
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
  const data = await githubTransport().graphql<Record<string, unknown>>(
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
 * One inline comment in the field names GitHub's create-review endpoint
 * documents: `side` is the side of the *last* line of a range, `start_side` the
 * side of its first, and `start_line` is present only for a real range.
 */
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
  // The attempt is identified by the comments it would post and the revision it
  // would post them on — not by the summary. A reviewer who edits only the
  // summary has not written a different review, and keying on the summary would
  // let them post the same comments twice by changing one sentence.
  const attempt = reviewAttemptId(comments, submission.event, files.comparison.headOid)

  // Re-sending because the network looked idle is how a review gets posted
  // twice. The record survives a reload, so this still holds after the
  // workspace is reopened, and it covers the crash case because the record was
  // written before the request rather than after its failure.
  const guard = await reconcileReviewWrite(
    repoPath,
    remote,
    repo,
    number,
    permissions.viewer,
    attempt,
    submission,
    files.comparison.headOid,
    signal,
  )
  if (guard.unsettled) throw new ReviewWriteUncertainError(guard.unsettled)
  if (guard.settled) return guard.settled

  // The attempt is journalled BEFORE the request leaves, not after it fails. A
  // crash, a kill, or a power cut between the POST and its response is the exact
  // case this guard exists for, and a record written only on the failure path
  // would be missing for precisely that one. So the journal is the first thing
  // that happens, and only a definite answer from GitHub removes it.
  await recordUncertainWrite(
    repoPath,
    {
      id: attempt,
      number,
      kind: 'review',
      summary: reviewAttemptSummary(submission.body),
      threadId: null,
      headOid: files.comparison.headOid,
      event: submission.event,
      at: new Date().toISOString(),
      repo: `${remote.owner}/${remote.name}`,
      viewer: permissions.viewer,
    },
    signal,
  )

  try {
    const response = await githubTransport().rest<unknown>({
      method: 'POST',
      path: `repos/${remote.owner}/${remote.name}/pulls/${number}/reviews`,
      body: {
        commit_id: files.comparison.headOid,
        body: submission.body,
        event: EVENT_NAMES[submission.event],
        comments,
      },
      signal,
    })
    const record = isRecord(response.data) ? response.data : {}
    // GitHub answered, so whatever the status word is, this attempt is settled
    // and the next one is allowed to proceed.
    await clearUncertainWrite(
      repoPath,
      repo,
      number,
      permissions.viewer,
      attempt,
      signal,
    )
    return {
      id: typeof record.id === 'string' ? record.id : '',
      state: typeof record.state === 'string' ? record.state : '',
      url: typeof record.html_url === 'string' ? record.html_url : null,
    }
  } catch (error) {
    if (outcomeUnknown(error)) {
      // The record went on before the request, so the guard is in force for this
      // failure, for a reload, and for a crash.
      throw new ReviewOutcomeUnknownError(transportDetail(error))
    }
    // A refusal is GitHub's own decision and needs no record: nothing was
    // applied, so the next attempt is a first attempt.
    await clearUncertainWrite(
      repoPath,
      repo,
      number,
      permissions.viewer,
      attempt,
      signal,
    )
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
 * This is deliberately the posted comments and the head, not the summary. The
 * summary is free text the reviewer can edit at will, and keying on it would
 * mean that changing one sentence is enough to slip past the guard and post the
 * same comments a second time — which is the duplicate this exists to prevent.
 * What makes a write the same write is what it says and where it says it, so
 * that is the identity: same comments against the same revision is the same
 * review, whatever the summary now reads.
 */
function reviewAttemptId(
  comments: readonly Record<string, unknown>[],
  event: ReviewEvent,
  headOid: string | null,
): string {
  const positions = comments
    .map((comment) =>
      [comment.path, comment.side, comment.line, comment.start_line, comment.start_side]
        .map((part) => String(part ?? ''))
        .join(':'),
    )
    .join('|')
  return shortHash(`${headOid ?? ''} ${event} ${positions}`)
}

/** A stable short identifier for a write, so the guard can name it across reloads. */
function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

/**
 * The unresolved review attempt this submission would repeat, or null.
 *
 * A blocked write is not a dead end, because a guard that can only refuse
 * permanently would make a transient failure unrecoverable. Before refusing,
 * the record is reconciled against what GitHub actually holds: if this
 * account's review of this revision is there, the attempt did land, the record
 * is retired, and the submission proceeds as a first attempt. If GitHub does not
 * have it, the guard stands — the record says only that the app never heard
 * back, which is also true of a request that never reached GitHub, so absence
 * is not proof and is never treated as permission to post again automatically.
 * The next attempt asks GitHub once more and is decided by what it says.
 */
async function reconcileReviewWrite(
  repoPath: string,
  remote: ParsedRemote,
  repo: string,
  number: number,
  viewer: string,
  attempt: string,
  submission: ReviewSubmission,
  headOid: string | null,
  signal?: AbortSignal,
): Promise<{ settled: ReviewMutationResult | null; unsettled: ReviewUncertainWrite | null }> {
  const writes = await readUncertainWrites(repoPath, repo, number, viewer, signal)
  const pending = writes.find((entry) => entry.kind === 'review' && entry.id === attempt)
  if (!pending) return { settled: null, unsettled: null }
  const settled = await reviewSettledOnGitHub(
    remote,
    number,
    viewer,
    reviewAttemptSummary(submission.body),
    headOid,
    signal,
  )
  // GitHub holds this review, so the earlier attempt did land. The record is
  // retired and that outcome is reported: sending again would post the same
  // comments onto the same line a second time, which is the duplicate this
  // guard exists to prevent.
  if (settled) {
    await clearUncertainWrite(repoPath, repo, number, viewer, attempt, signal)
    return {
      settled: { id: settled.id, state: 'COMMENTED', url: null },
      unsettled: null,
    }
  }
  return { settled: null, unsettled: pending }
}

/** The account's submitted review of this revision, as GitHub now reports it. */
interface SettledReview {
  id: string
}

/**
 * The account's own review of this revision on GitHub, or null.
 *
 * The submitted reviews are the authority for whether a write landed. The
 * author, the commit, and the summary are matched together, so a review
 * somebody else left, on another revision, or with different words does not
 * settle this one.
 */
async function reviewSettledOnGitHub(
  remote: ParsedRemote,
  number: number,
  viewer: string,
  summary: string,
  headOid: string | null,
  signal?: AbortSignal,
): Promise<SettledReview | null> {
  const data = await githubTransport().graphql<Record<string, unknown>>(
    REVIEWS_QUERY,
    { owner: remote.owner, name: remote.name, number },
    { signal },
  )
  const repository = isRecord(data.repository) ? data.repository : null
  const pullRequest =
    repository && isRecord(repository.pullRequest) ? repository.pullRequest : null
  const reviews = pullRequest && isRecord(pullRequest.reviews) ? pullRequest.reviews : null
  const nodes = reviews && Array.isArray(reviews.nodes) ? reviews.nodes : []
  for (const node of nodes) {
    if (!isRecord(node)) continue
    const author = isRecord(node.author) ? node.author.login : null
    const commit = isRecord(node.commit) ? node.commit.oid : null
    const body = typeof node.body === 'string' ? node.body.trim() : ''
    if (author === viewer && commit === headOid && body === summary) {
      return { id: typeof node.id === 'string' ? node.id : '' }
    }
  }
  return null
}

async function readReviewPermissionsFrom(
  remote: ParsedRemote,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewPermissions> {
  const data = await githubTransport().graphql<Record<string, unknown>>(
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
    const landed = (await readThreadComments(remote, threadId, signal)).find(
      (entry) => entry.body.trim() === body.trim(),
    )
    // GitHub holds these words in this thread, so the earlier attempt did land.
    // Its outcome is reported and the record retired: sending again would be a
    // second copy of the same reply, which is the duplicate this guard prevents.
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
      event: null,
      at: new Date().toISOString(),
      repo,
      viewer: permissions.viewer,
    },
    signal,
  )

  try {
    const data = await githubTransport().graphql<Record<string, unknown>>(
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
    const landed = after.find(
      (entry) => !before.includes(entry.id) && entry.body.trim() === body.trim(),
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
    const data = await githubTransport().graphql<Record<string, unknown>>(
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
  const data = await githubTransport().graphql<Record<string, unknown>>(
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
    const { comments, cursor: next } = await readThreadCommentPage(
      remote,
      threadId,
      cursor,
      signal,
    )
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
