import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import type { ReviewComparison, ReviewLineRef, ReviewSide } from '../shared/review'
import { sameReviewComparison } from '../shared/review'
import type {
  ReviewBoundary,
  ReviewDraft,
  ReviewDraftRecord,
  ReviewUncertainWrite,
  UncertainComment,
} from '../shared/review-threads'
import {
  nextReviewDraftNumber,
  REVIEW_DRAFTS_MAX,
  REVIEW_UNCERTAIN_MAX,
} from '../shared/review-threads'
import { isRecord, runGit, stripTrailingNewline } from './git-core'

interface DraftJournal {
  version: 1
  records: ReviewDraftRecord[]
}

interface UncertainJournal {
  version: 1
  writes: ReviewUncertainWrite[]
}

/**
 * The pending drafts live beside the repository's own Git directory, like the
 * viewed-file record. A draft is work the reviewer has not sent, it has to
 * follow the repository across workspaces and linked worktrees, and it must
 * never be mistakable for repository content or for something GitHub holds.
 */
async function draftsPath(repoPath: string, signal?: AbortSignal): Promise<string> {
  const common = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-common-dir'], undefined, signal),
  )
  return path.resolve(repoPath, common, 'git-stacks-review-drafts.json')
}

/**
 * The unresolved writes live beside the drafts, and are a separate file because
 * they are not review content: a record of an attempt whose result is unknown,
 * kept until GitHub's own state settles it.
 */
async function uncertainPath(repoPath: string, signal?: AbortSignal): Promise<string> {
  const common = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-common-dir'], undefined, signal),
  )
  return path.resolve(repoPath, common, 'git-stacks-review-uncertain.json')
}

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
    parsed.push({
      path: entry.path,
      side: entry.side === 'base' ? 'base' : 'head',
      line: entry.line,
      startLine: typeof entry.startLine === 'number' ? entry.startLine : null,
      startSide: entry.startSide === 'base' || entry.startSide === 'head' ? entry.startSide : null,
      body: entry.body,
    })
  }
  return parsed
}

async function readUncertain(file: string): Promise<ReviewUncertainWrite[]> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.writes)) return []
    return parsed.writes
      .map(parseUncertain)
      .filter((entry): entry is ReviewUncertainWrite => entry !== null)
  } catch {
    return []
  }
}

async function writeUncertain(
  file: string,
  writes: ReviewUncertainWrite[],
  signal?: AbortSignal,
): Promise<void> {
  void signal
  const journal: UncertainJournal = { version: 1, writes }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, file)
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
  const startRef = value.startRef === null || value.startRef === undefined ? null : parseRef(value.startRef)
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
    // The counter is never read below what this record's own drafts have already
    // consumed, so reopening a workspace cannot reissue an identity a settled
    // record still names. A record written before the counter existed starts at
    // one: its ids were the range alone, which a generated id never collides with.
    nextDraftId: Math.max(
      typeof value.nextDraftId === 'number' && Number.isInteger(value.nextDraftId)
        ? value.nextDraftId
        : 1,
      ...drafts.map((draft) => nextReviewDraftNumber(draft.id) + 1),
      1,
    ),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

/** Whether a journal record belongs to the repository and account asking for it. */
function sameOwner(record: ReviewDraftRecord, repo: string, viewer: string): boolean {
  return record.repo === repo && record.viewer === viewer
}

async function readJournal(repoPath: string, signal?: AbortSignal): Promise<ReviewDraftRecord[]> {
  try {
    const raw = await fs.readFile(await draftsPath(repoPath, signal), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) return []
    return parsed.records
      .map(parseRecord)
      .filter((record): record is ReviewDraftRecord => record !== null)
  } catch {
    return []
  }
}

async function writeJournal(
  repoPath: string,
  records: ReviewDraftRecord[],
  signal?: AbortSignal,
): Promise<void> {
  const file = await draftsPath(repoPath, signal)
  const journal: DraftJournal = { version: 1, records: records.slice(0, 50) }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, file)
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
    (await readJournal(repoPath, signal)).find(
      (record) => record.number === number && sameOwner(record, repo, viewer),
    ) ?? null
  )
}

/**
 * Replaces the drafts of one pull request.
 *
 * Drafts survive leaving the workspace and reopening the repository, which is
 * the whole reason they are journalled rather than held in the view. A
 * successful submission is recorded as an empty draft list, so the words a
 * reviewer just sent are not offered again afterwards. Replacement is scoped
 * the same way lookup is, so saving here never overwrites another repository's
 * or another account's record for the same number.
 */
export async function writeReviewDrafts(
  repoPath: string,
  record: ReviewDraftRecord,
  signal?: AbortSignal,
): Promise<ReviewDraftRecord> {
  const records = await readJournal(repoPath, signal)
  const kept = records.filter(
    (entry) =>
      entry.number !== record.number ||
      !sameOwner(entry, record.repo, record.viewer),
  )
  // A record is kept while it has drafts, and afterwards for as long as its
  // counter is still to come. The counter is what keeps a draft's identity
  // unique: it names the second comment written on a line after the first was
  // sent, which no amount of reading the words or the anchor can tell from the
  // first. Dropping the record the moment the drafts are gone would restart the
  // count and hand the next draft an identity this account has already used, so
  // the count outlives the drafts. An account that never wrote a draft still
  // leaves nothing behind.
  if (record.drafts.length > 0 || record.nextDraftId > 1) {
    kept.unshift({ ...record, drafts: record.drafts.slice(0, REVIEW_DRAFTS_MAX) })
  }
  await writeJournal(repoPath, kept, signal)
  return record
}

/** Drops the drafts of one pull request, used after GitHub has accepted them. */
export async function clearReviewDrafts(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  signal?: AbortSignal,
): Promise<void> {
  const records = await readJournal(repoPath, signal)
  await writeJournal(
    repoPath,
    records.filter(
      (entry) => entry.number !== number || !sameOwner(entry, repo, viewer),
    ),
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
 */
export async function recordUncertainWrite(
  repoPath: string,
  write: ReviewUncertainWrite,
  signal?: AbortSignal,
): Promise<void> {
  const file = await uncertainPath(repoPath, signal)
  const existing = await readUncertain(file)
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
  await writeUncertain(file, [write, ...kept].slice(0, REVIEW_UNCERTAIN_MAX), signal)
}

/** The unresolved writes of one pull request, oldest first. */
export async function readUncertainWrites(
  repoPath: string,
  repo: string,
  number: number,
  viewer: string,
  signal?: AbortSignal,
): Promise<ReviewUncertainWrite[]> {
  const entries = await readUncertain(await uncertainPath(repoPath, signal))
  return entries
    .filter(
      (entry) => entry.number === number && entry.viewer === viewer && entry.repo === repo,
    )
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** Forgets one write once GitHub's own record has settled what happened to it. */
export async function clearUncertainWrite(
  repoPath: string,
  repo: string,
  number: number,
  viewer: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const file = await uncertainPath(repoPath, signal)
  const existing = await readUncertain(file)
  await writeUncertain(
    file,
    existing.filter(
      (entry) =>
        !(
          entry.number === number &&
          entry.id === id &&
          entry.viewer === viewer &&
          entry.repo === repo
        ),
    ),
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
  signal?: AbortSignal,
): Promise<void> {
  const file = await uncertainPath(repoPath, signal)
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
  await writeUncertain(file, kept, signal)
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
