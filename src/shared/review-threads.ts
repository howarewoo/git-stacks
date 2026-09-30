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
  /**
   * The GitHub repository these drafts belong to, as `owner/name`. A pull
   * request number is only unique inside one repository, so keying the journal
   * by number alone would load the previous repository's pending words the
   * moment a worktree's origin was pointed somewhere else.
   */
  repo: string
  /**
   * The account that was signed in when the words were written. A draft is
   * unsent work belonging to whoever wrote it, and submitting it under a
   * different account would post one person's review under another's name.
   */
  viewer: string
  /** The comparison the drafts' line numbers were read at. */
  comparison: ReviewComparison
  drafts: ReviewDraft[]
  updatedAt: string
  /**
   * The next number to mint a draft identity from.
   *
   * A draft's identity has to survive being cleared and written again with the
   * same words on the same line, or the second composition is indistinguishable
   * from the first and a settled record answers for work nobody has sent. So the
   * identity is minted once from a counter that is persisted with the record,
   * not derived from where the comment sits: the same line and the same words
   * are one draft the first time and a different one every time after.
   *
   * Ids minted before this existed are the range alone, which no longer collides
   * with a generated one, so a record written by an older build starts at one
   * without reusing anything.
   */
  nextDraftId: number
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
  /**
   * GitHub's own count for this thread's comments, against the ones paged in.
   * A thread's comments are a second connection inside the thread, so paging the
   * outer list alone leaves the tail of a long conversation unread; when the
   * two disagree the thread says so instead of presenting a partial reply
   * history as the whole one.
   */
  commentCount: number
  commentsTruncated: boolean
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
  /**
   * The drafts an adopted outcome already delivered, by draft id.
   *
   * When an earlier attempt turns out to have landed, some of the comments in
   * the current payload are on GitHub already and must not be sent again. The
   * drafts that are not in this list were never sent and stay pending, so the
   * reviewer's own unsent work is not thrown away by a recovery.
   */
  delivered?: string[]
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

/**
 * What one submission carries: the decision, the summary, the drafts, and the
 * comparison the reviewer actually looked at.
 *
 * The comparison is what makes a stale submit a refusal rather than a silent
 * re-anchor. The backend re-reads the pull request to resolve anchors, and a
 * draft whose text still matches a line after a force-push would otherwise be
 * posted against a commit the reviewer never opened — worst of all for an
 * APPROVE, which would sign off a revision nobody saw. So the review is pinned
 * to the comparison the diff was rendered from, and a mismatch is reported as
 * one instead of being adopted.
 */
export interface ReviewSubmission {
  event: ReviewEvent
  body: string
  drafts: ReviewDraft[]
  /** The comparison the diff on screen was read at. */
  comparison: ReviewComparison
}

/**
 * A write GitHub may or may not have accepted, remembered so it is never
 * blindly repeated.
 *
 * A dropped connection after a POST is the one failure that cannot be retried
 * safely: the review may be on GitHub already, and pressing Submit again posts
 * it twice. An error message is not a guard, because it disappears on reload
 * and leaves the same button live. So the attempt itself is journalled, and the
 * next write of the same kind is refused until the record is reconciled
 * against what GitHub actually holds.
 */
export interface ReviewUncertainWrite {
  /** Stable within a pull request: one review attempt, or one thread write. */
  id: string
  number: number
  /** What was being written, so the guard covers the same write and no other. */
  kind: 'review' | 'reply' | 'resolve'
  /** The words of the write, so a reconciliation can recognise it on GitHub. */
  summary: string
  /** A reply's thread, or a review's head commit — where to look for it. */
  threadId: string | null
  headOid: string | null
  /**
   * The whole comparison this attempt was made against: head, base, and base
   * ref. A head alone is not enough, because a retargeted or advanced base
   * changes what every line number in the diff names while the head commit
   * stands still — so a review of the old base comparison carries the same
   * `commit_id` as a new one and would satisfy a head-only check. Delivery
   * evidence is about the comparison it was written against.
   */
  comparison: ReviewComparison
  /**
   * The drafts this attempt posted, by their own identity.
   *
   * A draft id is minted once, when the comment is first composed, and is what
   * tells one composition from the next. A range cannot: the same line carrying
   * the same words is indistinguishable from the same comment sent twice, so
   * the reviewer approves, the review lands, the draft is cleared, and writing
   * those words again on that line would look like the very work already sent.
   * A generation says which composition this is, and a new one is new work even
   * when it reads identically.
   */
  draftIds: string[]
  event: ReviewEvent | null
  /** When the attempt was made, so the oldest can be reasoned about. */
  at: string
  /**
   * The GitHub repository the write went to, as `owner/name`. The journal sits
   * in a Git common directory that every origin using it shares, and a pull
   * request number is only unique inside one repository, so without this an
   * unrelated repository's review is blocked by — and can clear — this guard.
   */
  repo: string
  /**
   * The account that attempted the write. The record holds the words, so it is
   * scoped the way the drafts are: one account's unresolved attempt must not
   * hold another account's button shut.
   */
  viewer: string
  /**
   * Every comment the attempt would post, with the body and the anchor it would
   * be written at. The decision alone cannot identify a review: an older
   * approval of the same commit with an empty summary looks identical to a new
   * one, and adopting it would clear comments GitHub never received.
   */
  comments: UncertainComment[]
  /**
   * What the pull request already held when the attempt began, and whether that
   * could be established at all.
   *
   * A review older than a complete boundary cannot be this attempt whatever it
   * happens to say, and a review newer than one can only be this write or
   * something later. An *unknown* boundary is not a boundary of zero: the walk
   * never reached the end, so the history still contains reviews that predate
   * the attempt, and matching within it would find somebody else's review. So
   * unknown holds, and only a complete boundary is searched.
   */
  boundary: ReviewBoundary
  /**
   * The comment ids a thread already held when the attempt began, for the same
   * reason: an older "Thanks" is somebody else's, and this account's older
   * "Thanks" is not this attempt.
   */
  threadCommentIds: string[]
  /**
   * What GitHub turned out to hold, once a reconciliation recognised this write.
   *
   * This is not cleared when the write settles. Deleting the record as soon as
   * GitHub's own state explains it loses the evidence at the one moment it is
   * still needed: the submission that recognised it may go on to fail, or the
   * app may die between GitHub's answer and the view dropping the draft. Either
   * way the next submission carries comments GitHub already holds, and with the
   * record gone nothing stops them being posted a second time.
   *
   * So a settled record is kept, and it is the submission *payload* that retires
   * it: once a later payload no longer mentions these comments, the view has
   * demonstrably dropped them, and only then is the record removed. That makes
   * the recovery idempotent without depending on a callback the view may never
   * send.
   */
  settled: ReviewSettledWrite | null
}

/**
 * What the pull request already held when an attempt began, as far as it could
 * be established.
 *
 * The two states are not the same, and collapsing them fails open. `complete`
 * with a null id means the pull request genuinely held no review, so every
 * review GitHub has is newer than the attempt and any of them may be the lost
 * one. `unknown` means the walk never reached the end of the list, so the
 * newest review is not known and the history still contains reviews that
 * predate the attempt. Searching that history for a match would find somebody
 * else's review, so `unknown` holds and is never a licence to adopt.
 */
export type ReviewBoundary =
  { kind: 'complete'; latestReviewId: string | null } | { kind: 'unknown' }

/** A boundary that was never established, for the writes that establish none. */
export const UNKNOWN_REVIEW_BOUNDARY: ReviewBoundary = { kind: 'unknown' }

/** A review a reconciliation recognised, kept alongside the attempt it settles. */
export interface ReviewSettledWrite {
  /** GitHub's own id for the review, which is a number on the REST API. */
  reviewId: string
  /** The state GitHub recorded — APPROVED, COMMENTED, CHANGES_REQUESTED. */
  state: string
  url: string | null
  /** When it was recognised, so a record that is never retired can be aged out. */
  at: string
}

/** One inline comment as an attempt recorded it, so a reconciliation can match it. */
export interface UncertainComment {
  path: string
  side: 'base' | 'head'
  line: number
  startLine: number | null
  startSide: 'base' | 'head' | null
  body: string
  /**
   * The draft this comment was composed from, recorded so a later submission
   * can tell *which* comment of a line it is.
   *
   * A line and its words do not say that. A reviewer comments on a line, sends
   * it, and writes the same words on that same line again: two comments that
   * agree on path, side, line, and body, and which only the identity tells
   * apart. Without it, the earlier comment's delivery answers for the later
   * one, and work the reviewer composed after a review landed is reported as
   * already on GitHub without anything being sent. A comment with no draft is
   * one no composition can be named for, and it is evidence about nothing.
   */
  draftId: string | null
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
    // The owner is carried from the record being edited. A draft is added to
    // the drafts this account already owns, so a new draft never lands a
    // record under a repository or account it does not belong to.
    repo: record?.repo ?? '',
    viewer: record?.viewer ?? '',
    comparison,
    drafts: drafts.length > REVIEW_DRAFTS_MAX ? drafts.slice(0, REVIEW_DRAFTS_MAX) : drafts,
    // The counter never goes backwards, so an id is never reused after the draft
    // it named has been cleared.
    nextDraftId: Math.max(record?.nextDraftId ?? 1, nextReviewDraftNumber(draft.id)),
    updatedAt: now,
  }
}

/**
 * The number a minted draft id ends with, or zero for one minted before ids
 * were generated. A record is never rewound below what its own drafts have
 * already consumed, so a reload cannot reissue an identity that a settled
 * record still names.
 */
export function nextReviewDraftNumber(id: string): number {
  const at = id.lastIndexOf('#')
  if (at < 0) return 0
  const parsed = Number(id.slice(at + 1))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

/** The identity a new draft is minted with: the range it covers, and a number. */
export function reviewDraftId(
  ref: ReviewLineRef,
  startRef: ReviewLineRef | null,
  n: number,
): string {
  return `${reviewDraftKey(ref, startRef)}#${n}`
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
  return {
    number: record?.number ?? 0,
    repo: record?.repo ?? '',
    viewer: record?.viewer ?? '',
    comparison: record?.comparison ?? UNKNOWN_REVIEW_COMPARISON,
    drafts,
    nextDraftId: record?.nextDraftId ?? 1,
    updatedAt: now,
  }
}

export function withoutReviewDraft(
  record: ReviewDraftRecord | null,
  id: string,
  now: string,
): ReviewDraftRecord {
  const drafts = (record?.drafts ?? []).filter((entry) => entry.id !== id)
  return {
    number: record?.number ?? 0,
    repo: record?.repo ?? '',
    viewer: record?.viewer ?? '',
    comparison: record?.comparison ?? UNKNOWN_REVIEW_COMPARISON,
    drafts,
    nextDraftId: record?.nextDraftId ?? 1,
    updatedAt: now,
  }
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
