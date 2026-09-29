import type { ReviewFileSet, ReviewSide } from '../shared/review'
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
  ReviewThreadSet,
} from '../shared/review-threads'
import { reviewDraftSpan, reviewDraftStart, REVIEW_EVENTS } from '../shared/review-threads'
import { isRecord, type ParsedRemote } from './git-core'
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
        comments(first: 50) {
          totalCount
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

const PERMISSIONS_QUERY = `query ReviewPermissions($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    viewer { login }
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

const THREAD_COMMENTS_QUERY = `query ReviewThreadComments($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 50) { nodes { id body url } }
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

function parseThread(value: unknown): ReviewThread | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.path !== 'string') {
    return null
  }
  const connection = isRecord(value.comments) ? value.comments : null
  const comments = connection && Array.isArray(connection.nodes)
    ? connection.nodes
        .map(parseThreadComment)
        .filter((entry): entry is ReviewThreadComment => entry !== null)
    : []
  return {
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
      const thread = parseThread(node)
      if (thread) threads.push(thread)
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
  const viewer = isRecord(repository?.viewer) ? repository?.viewer.login : null
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
  const permissions = await readReviewPermissionsFrom(remote, number, signal)
  const blocked = permissions.blocked[submission.event]
  if (blocked) throw new Error(blocked)

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
  const resolutions = resolveReviewDrafts(files, sendable)
  if (resolutions.some((entry) => entry.match === 'unresolved')) {
    throw new ReviewAnchorStaleError(number, resolutions)
  }

  const byId = new Map(resolutions.map((entry) => [entry.id, entry]))
  const comments = sendable.map((draft) =>
    wireComment(byId.get(draft.id)!, draft, reviewDraftStart(draft).path),
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
    return {
      id: typeof record.id === 'string' ? record.id : '',
      state: typeof record.state === 'string' ? record.state : '',
      url: typeof record.html_url === 'string' ? record.html_url : null,
    }
  } catch (error) {
    if (outcomeUnknown(error)) throw new ReviewOutcomeUnknownError(transportDetail(error))
    throw error
  }
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
  const login = isRecord(repository?.viewer) ? repository?.viewer.login : null
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
  threadId: string,
  body: string,
  signal?: AbortSignal,
): Promise<ReviewMutationResult> {
  if (body.trim() === '') throw new Error('Write a reply before sending it.')
  const remote = await originRemote(repoPath, signal)
  const before = await readThreadCommentIds(remote, threadId, signal)
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
    return {
      id: comment && typeof comment.id === 'string' ? comment.id : '',
      state: 'created',
      url: comment && typeof comment.url === 'string' ? comment.url : null,
    }
  } catch (error) {
    if (!outcomeUnknown(error)) throw error
    // The reply may already exist. Reading the thread is how that is found out
    // without sending a second copy of the same words.
    const after = await readThreadComments(remote, threadId, signal)
    const landed = after.find(
      (entry) => !before.includes(entry.id) && entry.body.trim() === body.trim(),
    )
    if (landed) return { id: landed.id, state: 'created', url: landed.url }
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

async function readThreadComments(
  remote: ParsedRemote,
  threadId: string,
  signal?: AbortSignal,
): Promise<Array<{ id: string; body: string; url: string }>> {
  const data = await githubTransport().graphql<Record<string, unknown>>(
    THREAD_COMMENTS_QUERY,
    { threadId },
    { signal },
  )
  const node = isRecord(data.node) ? data.node : null
  const connection = node && isRecord(node.comments) ? node.comments : null
  const comments: Array<{ id: string; body: string; url: string }> = []
  for (const entry of connection && Array.isArray(connection.nodes) ? connection.nodes : []) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    comments.push({
      id: entry.id,
      body: typeof entry.body === 'string' ? entry.body : '',
      url: typeof entry.url === 'string' ? entry.url : '',
    })
  }
  return comments
}

async function readThreadCommentIds(
  remote: ParsedRemote,
  threadId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await readThreadComments(remote, threadId, signal)).map((entry) => entry.id)
}
