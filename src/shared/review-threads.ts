import {
  sameReviewComparison,
  type ReviewAnchorMatch,
  type ReviewComparison,
  type ReviewLineRef,
  type ReviewSide,
} from './review'

/**
 * A comparison that is known to be unknown. A draft record always carries the
 * comparison it was written at, so this is only the placeholder for a record
 * built before one existed; it never matches a real comparison, which is the
 * safe direction — an unidentified draft is re-read, never posted blind.
 */
export const UNKNOWN_REVIEW_COMPARISON: ReviewComparison = {
  headOid: null,
  baseOid: null,
  baseRef: null,
}

/**
 * The three decisions GitHub accepts on a submitted review. A review that leaves
 * the event blank stays PENDING on GitHub's side, which is a fourth thing the
 * transport can do but not a decision a person makes in the review workspace:
 * drafts here are composed locally and posted as one of these three.
 */
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

export const REVIEW_EVENTS: readonly ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']

/** The wording each decision gets on the three submit buttons. */
export const REVIEW_EVENT_LABELS: Record<ReviewEvent, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request changes',
}

/**
 * A comment being written locally. It has never been sent, so it is not on
 * GitHub and is bound to the head its line numbers were read at: a force-push
 * changes what those numbers name, which is a revalidation question and not a
 * reason to lose the words.
 */
export interface ReviewDraft {
  id: string
  /** The line the range ends on. A single-line comment and a range share this. */
  ref: ReviewLineRef
  /**
   * The first line of a multi-line range, or null for a single line. GitHub
   * addresses a range with its start line, its start side, its line, and its
   * side, and a range may not cross sides, so both ends carry their own
   * `ReviewLineRef` rather than one range object.
   */
  startRef: ReviewLineRef | null
  body: string
  createdAt: string
}

/**
 * The pending drafts of one pull request, recorded beside the repository.
 *
 * A draft's line numbers are only an address at the comparison they were read
 * at. GitHub diffs a head against the merge base of head and base, so the base
 * moving under a fixed head changes every line number in the same way a
 * force-push does. A record therefore carries the whole comparison, and a
 * record written at one is never re-sent against another.
 */
export interface ReviewDraftRecord {
  number: number
  /** The comparison the drafts' line numbers were read at. */
  comparison: ReviewComparison
  drafts: ReviewDraft[]
  updatedAt: string
}

/**
 * Ceiling on retained drafts. A draft is authored work, so it is never dropped
 * to make room silently; the oldest is dropped only once this many exist, and
 * the record stays inside the repository's own Git directory.
 */
export const REVIEW_DRAFTS_MAX = 200

/** What one draft resolves to against a particular head, for display and for submit. */
export interface ReviewDraftResolution {
  id: string
  match: ReviewAnchorMatch
  side: ReviewSide | null
  /** The end line of the range at the resolved head; null when unresolved. */
  line: number | null
  /** The first line of a resolved multi-line range. */
  startLine: number | null
  /** Why the draft could not be resolved, in words a reviewer can act on. */
  reason: string
}

export interface ReviewThreadComment {
  id: string
  author: string
  body: string
  createdAt: string
  url: string
  /** True when the signed-in GitHub account wrote it, so the view can mark it. */
  viewerDidAuthor: boolean
}

/**
 * One conversation anchored to a diff line, as GitHub groups it. A thread is
 * addressed by node id for the mutations and by path/line for placement, and it
 * carries its own resolved/outdated state because GitHub — not the file set on
 * screen — decides what "outdated" means.
 */
export interface ReviewThread {
  id: string
  path: string
  side: ReviewSide | null
  line: number | null
  startLine: number | null
  startSide: ReviewSide | null
  /** A file-level comment has no line and no side at all. */
  fileLevel: boolean
  resolved: boolean
  collapsed: boolean
  outdated: boolean
  viewerCanReply: boolean
  viewerCanResolve: boolean
  viewerCanUnresolve: boolean
  comments: ReviewThreadComment[]
}

/** Every thread of one pull request, read against the comparison the file set was read at. */
export interface ReviewThreadSet {
  number: number
  comparison: ReviewComparison
  threads: ReviewThread[]
  /** GitHub's own count, which can exceed the threads that were paged in. */
  totalCount: number
  truncated: boolean
}

/** What the signed-in account may do to this pull request, and why not otherwise. */
export interface ReviewPermissions {
  viewer: string
  /** The viewer opened this pull request, which GitHub refuses to let them approve. */
  isAuthor: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  /** GitHub's own permission level for the repository: ADMIN … NONE. */
  permission: string
  /** Empty when the decision is available; otherwise why it is not. */
  blocked: Partial<Record<ReviewEvent, string>>
}

/** The outcome of writing a review, reply, or resolution, as the view needs it. */
export interface ReviewMutationResult {
  /** GitHub's own id for what was written. */
  id: string
  state: string
  url: string | null
}

const SIDE_NAMES: Record<ReviewSide, string> = { base: 'base', head: 'head' }

/** The first line of the range a draft covers, which is the draft's own ref for one line. */
export function reviewDraftStart(draft: ReviewDraft): ReviewLineRef {
  return draft.startRef ?? draft.ref
}

/**
 * The line span a draft covers, or null when its two ends are not addressable as
 * one range: a range crossing files, crossing sides, or running backwards is not
 * something GitHub can be asked to create, and saying so beats sending a request
 * that would name a different line range than the reviewer selected.
 */
export function reviewDraftSpan(draft: ReviewDraft): { start: number; end: number } | null {
  const start = reviewDraftStart(draft)
  const end = draft.ref
  if (start.path !== end.path || start.side !== end.side) return null
  if (start.line > end.line) return null
  return { start: start.line, end: end.line }
}

/** Where a draft sits, in the words a reviewer uses to find it again. */
export function reviewDraftLabel(draft: ReviewDraft): string {
  const end = draft.ref
  const span = reviewDraftSpan(draft)
  if (!span) return `${end.path}:${end.line} (${SIDE_NAMES[end.side]})`
  if (span.start === span.end) return `${end.path}:${span.end} (${SIDE_NAMES[end.side]})`
  return `${end.path}:${span.start}–${span.end} (${SIDE_NAMES[end.side]})`
}

/** The threads of one pull request together with what the viewer may do to it. */
export interface ReviewThreadRead {
  threads: ReviewThreadSet
  permissions: ReviewPermissions
}

/** What one submission carries: the decision, the summary, and the drafts. */
export interface ReviewSubmission {
  event: ReviewEvent
  body: string
  drafts: ReviewDraft[]
}
/** A stable local identifier for a draft, so a list keeps its key across edits. */
export function reviewDraftKey(ref: ReviewLineRef, startRef: ReviewLineRef | null): string {
  const start = startRef ?? ref
  return `${start.path}:${start.side}:${start.line}-${ref.side}:${ref.line}`
}

/**
 * Drafts in reading order: by path, then by the first line of the range. Two
 * comments on the same line keep the order they were written in, so the list a
 * reviewer submitted is the list they see.
 */
export function sortReviewDrafts(drafts: readonly ReviewDraft[]): ReviewDraft[] {
  return [...drafts].sort((a, b) => {
    const startA = reviewDraftStart(a)
    const startB = reviewDraftStart(b)
    if (startA.path !== startB.path) return startA.path < startB.path ? -1 : 1
    if (startA.line !== startB.line) return startA.line - startB.line
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  })
}

export function withReviewDraft(
  record: ReviewDraftRecord | null,
  number: number,
  comparison: ReviewComparison,
  draft: ReviewDraft,
  now: string,
): ReviewDraftRecord {
  // Re-adding the same range replaces the existing draft rather than stacking a
  // second one on the same lines: two pending comments on one line would submit
  // as two threads the reviewer never meant to write.
  const kept = (record?.drafts ?? []).filter((entry) => {
    if (entry.id === draft.id) return false
    return reviewDraftKey(entry.ref, entry.startRef) !== reviewDraftKey(draft.ref, draft.startRef)
  })
  const drafts = sortReviewDrafts([...kept, draft])
  return {
    number,
    comparison,
    drafts: drafts.length > REVIEW_DRAFTS_MAX ? drafts.slice(0, REVIEW_DRAFTS_MAX) : drafts,
    updatedAt: now,
  }
}

export function withReviewDraftBody(
  record: ReviewDraftRecord | null,
  id: string,
  body: string,
  now: string,
): ReviewDraftRecord {
  const drafts = (record?.drafts ?? []).map((entry) =>
    entry.id === id ? { ...entry, body } : entry,
  )
  return { number: record?.number ?? 0, comparison: record?.comparison ?? UNKNOWN_REVIEW_COMPARISON, drafts, updatedAt: now }
}

export function withoutReviewDraft(
  record: ReviewDraftRecord | null,
  id: string,
  now: string,
): ReviewDraftRecord {
  const drafts = (record?.drafts ?? []).filter((entry) => entry.id !== id)
  return { number: record?.number ?? 0, comparison: record?.comparison ?? UNKNOWN_REVIEW_COMPARISON, drafts, updatedAt: now }
}

/**
 * The drafts of a record, read against the comparison on screen now.
 *
 * A record written at a different comparison yields nothing rather than
 * something adjusted: the reviewer's words are still theirs, but their line
 * numbers describe a diff that is no longer the one being read, and quietly
 * renumbering them would post them somewhere they were not written.
 */
export function reviewDraftsAt(
  record: ReviewDraftRecord | null,
  number: number,
  comparison: ReviewComparison,
): ReviewDraft[] {
  if (!record || record.number !== number) return []
  if (!sameReviewComparison(record.comparison, comparison)) return []
  return record.drafts
}

/** Drafts that cannot be sent where they were written, named for the reason. */
export function unresolvedReviewDrafts(
  resolutions: readonly ReviewDraftResolution[],
): ReviewDraftResolution[] {
  return resolutions.filter((entry) => entry.match === 'unresolved')
}

/** The drafts that are ready to post, in the order they will be sent. */
export function readyReviewDrafts(
  drafts: readonly ReviewDraft[],
  resolutions: readonly ReviewDraftResolution[],
): ReviewDraft[] {
  const ready = new Set(
    resolutions.filter((entry) => entry.match !== 'unresolved').map((entry) => entry.id),
  )
  return drafts.filter((draft) => ready.has(draft.id) && draft.body.trim() !== '')
}

export function reviewThreadLabel(thread: ReviewThread): string {
  if (thread.fileLevel || thread.line === null) return thread.path
  const side = thread.side ? ` (${SIDE_NAMES[thread.side]})` : ''
  if (thread.startLine !== null && thread.startLine !== thread.line) {
    return `${thread.path}:${thread.startLine}–${thread.line}${side}`
  }
  return `${thread.path}:${thread.line}${side}`
}

/**
 * The one state word a thread header carries. Resolved and outdated are separate
 * facts on GitHub and stay separate here: an outdated thread is still open, and
 * collapsing the two would hide a conversation nobody has answered.
 */
export function reviewThreadState(thread: ReviewThread): 'resolved' | 'outdated' | 'open' {
  if (thread.resolved) return 'resolved'
  if (thread.outdated) return 'outdated'
  return 'open'
}

export const REVIEW_THREAD_STATE_LABELS = {
  resolved: 'resolved',
  outdated: 'outdated',
  open: 'open',
} as const

/** Threads placed on a specific line of a file, for the markers the diff draws. */
export function reviewThreadsAtLine(
  threads: readonly ReviewThread[],
  path: string,
  line: number,
): ReviewThread[] {
  return threads.filter(
    (thread) => thread.path === path && thread.line === line && !thread.fileLevel,
  )
}

/** A decision is available when GitHub said it is; the reason is shown instead of a dead control. */
export function reviewEventBlocked(
  permissions: ReviewPermissions | null,
  event: ReviewEvent,
): string | null {
  if (!permissions) return 'The viewer permissions for this pull request have not been read yet.'
  return permissions.blocked[event] ?? null
}
