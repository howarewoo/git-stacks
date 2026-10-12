import path from 'node:path'

import type { ReviewComparison, ReviewLineRef, ReviewSide } from '@git-stacks/shared/review'
import { sameReviewComparison } from '@git-stacks/shared/review'
import type {
  ReviewBoundary,
  ReviewDraft,
  ReviewDraftRecord,
  ReviewUncertainWrite,
  UncertainComment,
  ReviewDraftRecovery,
} from '@git-stacks/shared/review-threads'
import { REVIEW_DRAFTS_MAX, sameReviewDraft } from '@git-stacks/shared/review-threads'
import { isRecord } from '@git-stacks/shared/guards'
import { readJournal, repositoryJournalPath, writeJournal, withJournalLock } from './review-journal'

const LEGACY_DRAFTS_JOURNAL = 'git-stacks-review-drafts.json'
const DRAFTS_JOURNAL = 'git-stacks-review-drafts-qualified.json'
const LEGACY_UNCERTAIN_JOURNAL = 'git-stacks-review-uncertain.json'
const UNCERTAIN_JOURNAL = 'git-stacks-review-uncertain-qualified.json'

/**
 * The pending drafts live beside the repository's own Git directory, like the
 * viewed-file record. A draft is work the reviewer has not sent, it has to
 * follow the repository across workspaces and linked worktrees, and it must
 * never be mistakable for repository content or for something GitHub holds.
 *
 * The unresolved writes live beside the drafts, and are a separate file because
 * they are not review content: a record of an attempt whose result is unknown,
 * kept until GitHub's own state settles it.
 */

function parseUncertain(value: unknown): ReviewUncertainWrite | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.number !== 'number') {
    return null
  }
  if (value.kind !== 'review' && value.kind !== 'reply' && value.kind !== 'resolve') return null
  return {
    id: value.id,
    number: value.number,
    kind: value.kind,
    summary: typeof value.summary === 'string' ? value.summary : '',
    ...(value.kind === 'reply' &&
    typeof value.authoredReplyBody === 'string' &&
    value.authoredReplyBody === value.summary
      ? { authoredReplyBody: value.authoredReplyBody }
      : {}),
    threadId: typeof value.threadId === 'string' ? value.threadId : null,
    headOid: typeof value.headOid === 'string' ? value.headOid : null,
    // A record written before the comparison was stored cannot be shown to
    // belong to any one of them, and a record that matches no comparison is one
    // this submission is not: it is neither this write's recovery nor a hold on
    // it, so it is retired rather than trusted.
    comparison: parseComparison(value.comparison),
    // Likewise a record with no draft identities predates generations, and one
    // that names no draft of this payload cannot be evidence about it.
    draftIds: Array.isArray(value.draftIds)
      ? value.draftIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    event:
      value.event === 'COMMENT' || value.event === 'APPROVE' || value.event === 'REQUEST_CHANGES'
        ? value.event
        : null,
    at: typeof value.at === 'string' ? value.at : '',
    repo: typeof value.repo === 'string' ? value.repo : '',
    viewer: typeof value.viewer === 'string' ? value.viewer : '',
    comments: parseUncertainComments(value.comments),
    threadCommentIds: Array.isArray(value.threadCommentIds)
      ? value.threadCommentIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    // A record written before this field existed reads as unsettled, which is
    // the safe direction: an unrecognised write is reconciled against GitHub
    // again rather than trusted.
    settled: parseSettled(value.settled),
    boundary: parseBoundary(value.boundary, value.beforeReviewId),
  }
}

/**
 * The boundary an attempt recorded, read back.
 *
 * A record written before the boundary was a union stored a bare id, where null
 * meant "this pull request held no review" and an absent field meant the same
 * thing. Those are now different facts, and reading an absent one as "none"
 * would search the whole history for a match — so an id is taken at face value
 * and anything else is unknown, which holds.
 */
function parseBoundary(value: unknown, legacy: unknown): ReviewBoundary {
  if (typeof legacy === 'string') return { kind: 'complete', latestReviewId: legacy }
  if (isRecord(value) && value.kind === 'complete') {
    return {
      kind: 'complete',
      latestReviewId: typeof value.latestReviewId === 'string' ? value.latestReviewId : null,
    }
  }
  return { kind: 'unknown' }
}

/** The review a reconciliation recognised, or null when the record carries none. */
function parseSettled(value: unknown): ReviewUncertainWrite['settled'] {
  if (!isRecord(value)) return null
  if (typeof value.reviewId !== 'string') return null
  if (typeof value.state !== 'string') return null
  return {
    reviewId: value.reviewId,
    state: value.state,
    url: typeof value.url === 'string' ? value.url : null,
    at: typeof value.at === 'string' ? value.at : '',
  }
}

/**
 * The comment payload an attempt recorded. A record written before this field
 * existed reads as no comments, which cannot settle a review — an unidentifiable
 * attempt is one that is held, not one that is adopted.
 */
function parseUncertainComments(value: unknown): UncertainComment[] {
  if (!Array.isArray(value)) return []
  const parsed: UncertainComment[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (typeof entry.path !== 'string' || typeof entry.body !== 'string') continue
    if (typeof entry.line !== 'number') continue
    const authoredDraft =
      isRecord(entry.authoredDraft) &&
      entry.authoredDraft.id === entry.draftId &&
      entry.authoredDraft.body === entry.body &&
      isRecord(entry.authoredDraft.ref) &&
      typeof entry.authoredDraft.ref.hunkId === 'string' &&
      (entry.authoredDraft.startRef === null ||
        (isRecord(entry.authoredDraft.startRef) &&
          typeof entry.authoredDraft.startRef.hunkId === 'string')) &&
      typeof entry.authoredDraft.body === 'string' &&
      typeof entry.authoredDraft.createdAt === 'string'
        ? parseDraft(entry.authoredDraft)
        : null
    parsed.push({
      path: entry.path,
      side: entry.side === 'base' ? 'base' : 'head',
      line: entry.line,
      startLine: typeof entry.startLine === 'number' ? entry.startLine : null,
      startSide: entry.startSide === 'base' || entry.startSide === 'head' ? entry.startSide : null,
      body: entry.body,
      ...(authoredDraft ? { authoredDraft } : {}),
      // The composition this comment was written from. A record that predates the
      // association carries none, and a comment with none is evidence about no
      // particular composition: it is not read as delivering anything.
      draftId: typeof entry.draftId === 'string' && entry.draftId !== '' ? entry.draftId : null,
    })
  }
  return parsed
}

function readUncertain(file: string): Promise<ReviewUncertainWrite[]> {
  return readJournal(file, 'writes', parseUncertain)
}

function writeUncertain(file: string, writes: ReviewUncertainWrite[]): Promise<void> {
  return writeJournal(file, 'writes', writes)
}

function parseSide(value: unknown): ReviewSide | null {
  if (value === 'base' || value === 'head') return value
  return null
}

function parseRef(value: unknown): ReviewLineRef | null {
  if (!isRecord(value)) return null
  const side = parseSide(value.side)
  if (
    side === null ||
    typeof value.path !== 'string' ||
    value.path === '' ||
    typeof value.line !== 'number' ||
    !Number.isInteger(value.line) ||
    value.line <= 0 ||
    typeof value.anchor !== 'string' ||
    value.anchor === '' ||
    typeof value.context !== 'string'
  ) {
    return null
  }
  return {
    path: value.path,
    side,
    line: value.line,
    hunkId: typeof value.hunkId === 'string' ? value.hunkId : '',
    anchor: value.anchor,
    context: value.context,
  }
}

function parseDraft(value: unknown): ReviewDraft | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  const ref = parseRef(value.ref)
  if (!ref) return null
  const startRef =
    value.startRef === null || value.startRef === undefined ? null : parseRef(value.startRef)
  if (value.startRef !== null && value.startRef !== undefined && startRef === null) return null
  return {
    id: value.id,
    ref,
    startRef,
    body: typeof value.body === 'string' ? value.body : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  }
}

function parseComparison(value: unknown): ReviewComparison {
  if (!isRecord(value)) return { headOid: null, baseOid: null, baseRef: null }
  return {
    headOid: typeof value.headOid === 'string' ? value.headOid : null,
    baseOid: typeof value.baseOid === 'string' ? value.baseOid : null,
    baseRef: typeof value.baseRef === 'string' ? value.baseRef : null,
  }
}

function parseRecord(value: unknown): ReviewDraftRecord | null {
  if (!isRecord(value) || typeof value.number !== 'number' || !Array.isArray(value.drafts)) {
    return null
  }
  // A record without its repository and account cannot be placed against
  // either, so it is not adopted: an unowned record is exactly the one that
  // would otherwise be offered to whichever account happens to be signed in.
  if (typeof value.repo !== 'string' || value.repo === '') return null
  if (typeof value.viewer !== 'string' || value.viewer === '') return null
  const drafts = value.drafts
    .map(parseDraft)
    .filter((draft): draft is ReviewDraft => draft !== null)
    .slice(0, REVIEW_DRAFTS_MAX)
  return {
    number: value.number,
    repo: value.repo,
    viewer: value.viewer,
    // A record written before drafts carried their comparison describes a diff
    // that can no longer be identified, so it is refused rather than guessed at
    // and the reviewer's words are left in the file for them to find.
    comparison: parseComparison(value.comparison),
    drafts,
    // Nothing here counts drafts. An identity is minted where a draft is
    // composed, so there is no counter to rewind, refuse, or keep — and a
    // record written before ids were generated, or one carrying a counter this
    // build no longer uses, reads exactly as it was written.
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

/** Whether a journal record belongs to the repository and account asking for it. */
function sameOwner(record: ReviewDraftRecord, repo: string, viewer: string): boolean {
  return record.repo === repo && record.viewer === viewer
}

function readDrafts(file: string): Promise<ReviewDraftRecord[]> {
  return readJournal(file, 'records', parseRecord)
}

/**
 * Records are never evicted to make room. A record is one pull request's unsent
 * words, so dropping one to keep the file small would discard work the
 * reviewer has not sent and still believes is kept; a record leaves the journal
 * only when its own owner sends or clears it. Each record is separately bounded
 * by `REVIEW_DRAFTS_MAX`, so a single pull request cannot grow the file without
 * limit either.
 */
function writeDrafts(file: string, records: ReviewDraftRecord[]): Promise<void> {
  return writeJournal(file, 'records', records)
}

/**
 * The pending drafts of one pull request for one repository and account, or null
 * when it has none.
 *
 * The journal is shared by every worktree of a repository on purpose — unsent
 * work follows the repository — so the file itself cannot be the boundary. The
 * boundary is the record: drafts written for another repository, or by another
 * account, are present on disk and deliberately not returned, because a pull
 * request number alone collides across repositories and an account switch would
 * otherwise post one reviewer's words under another's name.
 */
export async function readReviewDrafts(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewDraftRecord | null> {
  return (
    (await readDrafts(await repositoryJournalPath(repoPath, DRAFTS_JOURNAL, signal))).find(
      (record) => record.number === number && sameOwner(record, repo, viewer),
    ) ?? null
  )
}

/** Legacy text is local recovery material, never a current host's review or anchor. */
export async function readReviewDraftRecovery(
  repoPath: string,
  selected: Pick<ReviewDraftRecovery, 'repo' | 'viewer' | 'number'> | null,
  signal?: AbortSignal,
): Promise<ReviewDraftRecovery[]> {
  const groups = new Map<
    string,
    {
      repo: string
      viewer: string
      number: number
      bodies: string[]
    }
  >()
  const groupFor = (record: Record<string, unknown>) => {
    if (
      typeof record.repo !== 'string' ||
      record.repo.split('/').length !== 2 ||
      typeof record.viewer !== 'string' ||
      typeof record.number !== 'number' ||
      !Number.isInteger(record.number) ||
      (selected &&
        (record.repo !== selected.repo ||
          record.viewer !== selected.viewer ||
          record.number !== selected.number))
    )
      return null
    const key = JSON.stringify([record.repo, record.viewer, record.number])
    let group = groups.get(key)
    if (!group) {
      group = { repo: record.repo, viewer: record.viewer, number: record.number, bodies: [] }
      groups.set(key, group)
    }
    return group
  }
  const records = await readJournal(
    await repositoryJournalPath(repoPath, LEGACY_DRAFTS_JOURNAL, signal),
    'records',
    (value) => (isRecord(value) ? value : null),
  )
  for (const record of records) {
    if (!Array.isArray(record.drafts)) continue
    const group = groupFor(record)
    if (!group) continue
    for (const draft of record.drafts) {
      if (isRecord(draft) && typeof draft.body === 'string') group.bodies.push(draft.body)
    }
  }
  const attempts = await readJournal(
    await repositoryJournalPath(repoPath, LEGACY_UNCERTAIN_JOURNAL, signal),
    'writes',
    (value) => (isRecord(value) ? value : null),
  )
  for (const attempt of attempts) {
    const group = groupFor(attempt)
    if (!group) continue
    if (typeof attempt.summary === 'string' && attempt.summary !== '')
      group.bodies.push(attempt.summary)
    if (!Array.isArray(attempt.comments)) continue
    for (const comment of attempt.comments) {
      if (isRecord(comment) && typeof comment.body === 'string') group.bodies.push(comment.body)
    }
  }
  return [...groups.values()].map((group) => ({
    repo: group.repo,
    viewer: group.viewer,
    number: group.number,
    count: group.bodies.length,
    bodies: selected ? group.bodies : null,
  }))
}

export async function assertReviewDraftOwner(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  ids: readonly string[],
  comparison: ReviewComparison,
  signal?: AbortSignal,
): Promise<void> {
  if (ids.length === 0) return
  const file = await repositoryJournalPath(repoPath, DRAFTS_JOURNAL, signal)
  const records = await readDrafts(file)
  const directory = path.dirname(file)
  const [legacy, legacyAttempts] = await Promise.all([
    readJournal(path.join(directory, LEGACY_DRAFTS_JOURNAL), 'records', (value) =>
      isRecord(value) ? value : null,
    ),
    readJournal(path.join(directory, LEGACY_UNCERTAIN_JOURNAL), 'writes', (value) =>
      isRecord(value) ? value : null,
    ),
  ])
  if (
    ids.some(
      (id) =>
        legacy.some(
          (record) =>
            Array.isArray(record.drafts) &&
            record.drafts.some((draft) => isRecord(draft) && draft.id === id),
        ) ||
        legacyAttempts.some(
          (attempt) =>
            (Array.isArray(attempt.draftIds) && attempt.draftIds.includes(id)) ||
            (Array.isArray(attempt.comments) &&
              attempt.comments.some((comment) => isRecord(comment) && comment.draftId === id)),
        ),
    )
  ) {
    throw new Error(
      'Legacy comments are recovery-only text; their original anchors cannot be adopted or submitted here.',
    )
  }
  for (const id of ids) {
    const owned = records.find(
      (record) =>
        record.number === number &&
        sameOwner(record, repo, viewer) &&
        record.drafts.some((draft) => draft.id === id),
    )
    if (owned && !sameReviewComparison(owned.comparison, comparison)) {
      throw new Error(
        'These saved comments retain their original comparison. Their anchors cannot be moved to the current revision.',
      )
    }
    if (!owned && records.some((record) => record.drafts.some((draft) => draft.id === id))) {
      throw new Error(
        'These saved comments belong to another host/repository/account or pull request. Recover the text locally; their original anchors cannot be adopted or submitted here.',
      )
    }
  }
}

function nextDraftVersion(previous: ReviewDraftRecord | undefined): string {
  const previousTime = previous ? Date.parse(previous.updatedAt) : Number.NaN
  return new Date(
    Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0),
  ).toISOString()
}

/**
 * Replaces the drafts of one pull request.
 *
 * Drafts survive leaving the workspace and reopening the repository, which is
 * the whole reason they are journalled rather than held in the view. Replacement
 * is scoped the same way lookup is, so saving here never overwrites another
 * repository's or another account's record for the same number.
 *
 * The read, observed-version comparison, authorization, and write happen under
 * the journal's cross-process lock. Empty accepted records retain a version so
 * older full-array requests cannot resurrect cleared or confirmed comments.
 */
export async function writeReviewDrafts(
  repoPath: string,
  record: ReviewDraftRecord,
  expectedUpdatedAt: string | null,
  authorize: () => Promise<void>,
  signal?: AbortSignal,
): Promise<ReviewDraftRecord> {
  const file = await repositoryJournalPath(repoPath, DRAFTS_JOURNAL, signal)
  return withJournalLock(
    file,
    async () => {
      const records = await readDrafts(file)
      const previous = records.find(
        (entry) => entry.number === record.number && sameOwner(entry, record.repo, record.viewer),
      )
      if ((previous?.updatedAt ?? null) !== expectedUpdatedAt) {
        throw new Error(
          'Saved drafts changed after this full set was read. Your unsent text remains in this window; discard those local edits explicitly before using the newer saved drafts.',
        )
      }
      if (
        previous &&
        record.drafts.some((draft) => previous.drafts.some((saved) => saved.id === draft.id)) &&
        !sameReviewComparison(previous.comparison, record.comparison)
      ) {
        throw new Error(
          'Saved comments retain their original comparison; saving cannot move their anchors.',
        )
      }
      const kept = records.filter(
        (entry) => entry.number !== record.number || !sameOwner(entry, record.repo, record.viewer),
      )
      // Empty records are deletion barriers, not pending comments. Their existing
      // version prevents an older full-array save from resurrecting cleared work.
      const accepted = { ...record, updatedAt: nextDraftVersion(previous) }
      kept.unshift(accepted)
      await authorize()
      await writeDrafts(file, kept)
      return accepted
    },
    signal,
  )
}

/**
 * Retires only the exact authored versions confirmed by the submitting operation.
 * Another window's additions or same-identity edits remain unsent. Empty records
 * retain an accepted version as a barrier against older full-array saves.
 */
export async function removeDeliveredReviewDrafts(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  delivered: ReadonlySet<string>,
  submitted: readonly ReviewDraft[],
  comparison: ReviewComparison,
  authorize: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const file = await repositoryJournalPath(repoPath, DRAFTS_JOURNAL, signal)
  const submittedById = new Map(submitted.map((draft) => [draft.id, draft]))
  await withJournalLock(
    file,
    async () => {
      const records = await readDrafts(file)
      const kept: ReviewDraftRecord[] = []
      let changed = false
      for (const entry of records) {
        if (
          entry.number !== number ||
          !sameOwner(entry, repo, viewer) ||
          !sameReviewComparison(entry.comparison, comparison)
        ) {
          kept.push(entry)
          continue
        }
        const confirmed = (draft: ReviewDraft) => {
          const sent = submittedById.get(draft.id)
          return delivered.has(draft.id) && sent !== undefined && sameReviewDraft(draft, sent)
        }
        if (!entry.drafts.some(confirmed)) {
          kept.push(entry)
          continue
        }
        changed = true
        kept.push({
          ...entry,
          drafts: entry.drafts.filter((draft) => !confirmed(draft)),
          updatedAt: nextDraftVersion(entry),
        })
      }
      if (changed) {
        await authorize()
        await writeDrafts(file, kept)
      }
    },
    signal,
  )
}

/**
 * Remembers a write whose outcome GitHub never confirmed.
 *
 * This is the durable half of the guard. A message saying "we could not tell"
 * stops being true the moment the workspace reopens, and the button it
 * disabled comes back with the same words still in it. The attempt survives
 * reload, so the next identical write can be refused until somebody has looked
 * at what GitHub holds.
 *
 * A guard is never evicted to make room. Dropping the oldest record would drop
 * the only durable proof that a request went out, so reopening that draft and
 * retrying it would post a second review instead of reconciling the first —
 * the exact duplicate this journal exists to prevent. A record leaves only when
 * GitHub's own state settles it, and a submission that cannot journal its
 * attempt refuses rather than sending unguarded.
 *
 * Initial reservation and receipt publication share the cross-process lock.
 * Reservation refuses overlapping work; receipt publication updates the captured
 * attempt without discarding another owner's evidence.
 */
export async function recordUncertainWrite(
  repoPath: string,
  write: ReviewUncertainWrite,
  authorize: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  await publishUncertainWrite(repoPath, write, authorize, false, signal)
}

/** Returns the existing guard when this captured attempt cannot reserve dispatch. */
export async function reserveUncertainWrite(
  repoPath: string,
  write: ReviewUncertainWrite,
  authorize: () => Promise<void>,
  signal?: AbortSignal,
): Promise<ReviewUncertainWrite | null> {
  return publishUncertainWrite(repoPath, write, authorize, true, signal)
}

async function publishUncertainWrite(
  repoPath: string,
  write: ReviewUncertainWrite,
  authorize: () => Promise<void>,
  reserve: boolean,
  signal?: AbortSignal,
): Promise<ReviewUncertainWrite | null> {
  const file = await repositoryJournalPath(repoPath, UNCERTAIN_JOURNAL, signal)
  return withJournalLock(
    file,
    async () => {
      const existing = await readUncertain(file)
      await authorize()
      if (reserve) {
        const conflict = existing.find(
          (entry) =>
            entry.number === write.number &&
            entry.kind === write.kind &&
            entry.repo === write.repo &&
            entry.viewer === write.viewer &&
            (entry.settled === null
              ? entry.id === write.id ||
                (write.kind === 'review' &&
                  sameReviewComparison(entry.comparison, write.comparison) &&
                  entry.draftIds.some((id) => write.draftIds.includes(id)))
              : write.kind === 'review' &&
                sameReviewComparison(entry.comparison, write.comparison) &&
                entry.comments.some((comment) =>
                  write.comments.some(
                    (mine) =>
                      comment.draftId !== null &&
                      comment.draftId === mine.draftId &&
                      (comment.authoredDraft === undefined ||
                        mine.authoredDraft === undefined ||
                        sameReviewDraft(comment.authoredDraft, mine.authoredDraft)),
                  ),
                )),
        )
        // Settled evidence blocks stale preflights of the same authored version,
        // not genuinely edited drafts that retain their original identity.
        if (conflict) return conflict
      }
      // Replacement is scoped by the same complete owner identity as lookup and
      // clearing. An attempt id is not unique across accounts, so matching on it
      // alone would let one account's record delete another's guard.
      const kept = existing.filter(
        (entry) =>
          entry.number !== write.number ||
          entry.kind !== write.kind ||
          entry.id !== write.id ||
          entry.repo !== write.repo ||
          entry.viewer !== write.viewer,
      )
      await writeUncertain(file, [write, ...kept])
      return null
    },
    signal,
  )
}

/** The unresolved writes of one pull request, oldest first. */
export async function readUncertainWrites(
  repoPath: string,
  repo: string,
  number: number,
  viewer: string,
  signal?: AbortSignal,
): Promise<ReviewUncertainWrite[]> {
  const entries = await readUncertain(
    await repositoryJournalPath(repoPath, UNCERTAIN_JOURNAL, signal),
  )
  return entries
    .filter((entry) => entry.number === number && entry.viewer === viewer && entry.repo === repo)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/**
 * Forgets one write once GitHub's own record has settled what happened to it.
 *
 * Like every other update, this reads and writes under the lock, so a settling
 * clear cannot read the journal before a concurrent attempt records itself and
 * then publish a version that no longer holds that guard.
 */
export async function clearUncertainWrite(
  repoPath: string,
  repo: string,
  number: number,
  viewer: string,
  id: string,
  authorize: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const file = await repositoryJournalPath(repoPath, UNCERTAIN_JOURNAL, signal)
  await withJournalLock(
    file,
    async () => {
      const existing = await readUncertain(file)
      const kept = existing.filter(
        (entry) =>
          !(
            entry.number === number &&
            entry.id === id &&
            entry.viewer === viewer &&
            entry.repo === repo
          ),
      )
      if (kept.length === existing.length) return
      await authorize()
      await writeUncertain(file, kept)
    },
    signal,
  )
}

/**
 * Retires the settled records this payload no longer vouches for, keeping the rest.
 *
 * A settled record is evidence that GitHub holds comments, and it is only safe to
 * drop that evidence once a later submission has demonstrably moved on. The
 * acknowledgement is *which drafts* the payload carries, not what they say or
 * where they sit: the view keeps a draft in its payload precisely while it has
 * not been told that draft was delivered, and a draft's identity is minted once
 * when the comment is composed. So a record whose drafts are absent from the
 * payload are drafts the view has finished with, and that is what retires the
 * record — read off the payload rather than waited for from a callback the view
 * may never send, which is what makes resuming after a crash idempotent instead
 * of a race.
 *
 * Identity rather than wording is the whole point. A record is kept while the
 * same draft comes back after a crash, and retired as soon as the reviewer
 * composes something new — even on the same line, with the same words, in the
 * same place. Anchoring on the words instead would keep the record alive for the
 * second composition and let it answer for work the reviewer had not sent.
 *
 * A record is also retired when it names a different comparison. It was already
 * answered — GitHub took that write, about that diff — and a payload about a
 * different base speaks nothing for it. A record that matches no comparison
 * cannot be placed in this one at all, and is dropped.
 *
 * Records that are still uncertain, and settled records about this comparison
 * that this payload does still carry drafts from, are left exactly as they are.
 */
export async function retireSettledWrites(
  repoPath: string,
  repo: string,
  number: number,
  viewer: string,
  comparison: ReviewComparison,
  draftIds: readonly string[],
  authorize: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const file = await repositoryJournalPath(repoPath, UNCERTAIN_JOURNAL, signal)
  await withJournalLock(
    file,
    async () => {
      const existing = await readUncertain(file)
      const kept = existing.filter((entry) => {
        if (
          entry.number !== number ||
          entry.viewer !== viewer ||
          entry.repo !== repo ||
          entry.settled === null
        ) {
          return true
        }
        if (!sameReviewComparison(entry.comparison, comparison)) return false
        return entry.draftIds.some((theirs) => draftIds.includes(theirs))
      })
      if (kept.length === existing.length) return
      await authorize()
      await writeUncertain(file, kept)
    },
    signal,
  )
}

/** Whether two comments name the same line of the same file, whatever they say. */
function sameCommentAnchor(one: UncertainComment, other: UncertainComment): boolean {
  return (
    one.path === other.path &&
    one.side === other.side &&
    one.line === other.line &&
    one.startLine === other.startLine &&
    one.startSide === other.startSide
  )
}
