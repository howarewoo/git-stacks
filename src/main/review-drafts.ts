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
import { REVIEW_DRAFTS_MAX } from '../shared/review-threads'
import { CommandCancelled, isRecord, runGit, stripTrailingNewline } from './git-core'

/**
 * Both journals are read, changed, and written back by every process that has
 * this repository open: two windows of one app, two worktrees, or two copies of
 * Git Stacks. A read/modify/write over a shared file is therefore a claim on
 * something no process owns on its own, and the window between the read and the
 * rename is wide enough for a second process to read the same bytes and publish
 * its own change over them. The result is not a merge: the last rename wins and
 * the other's record — unsent words, or a guard against a duplicate review —
 * is silently gone.
 *
 * The claim is a lock file beside the journal, created with `link(2)`, which is
 * atomic: exactly one process can create the name, and the winner owns it until
 * it removes it. Creating it with content already written means a process that
 * finds the lock never reads a half-written owner, so "is the holder still
 * alive?" is answerable. A lock is released only by removing the exact inode it
 * created, so a lock another process has since taken over is never taken away
 * from it.
 *
 * No lock is ever taken from its holder, not even one whose owner has been
 * killed: reclaiming a lock is a rename, and a rename that frees the name lets a
 * contender in while a holder that turns out to be alive still believes it owns
 * the journal. A lock whose holder is gone therefore blocks, and the refusal
 * names the one file a person may remove once they know no window is open. A
 * lock this process cannot read, or a wait that runs out, refuses the same
 * way: the honest outcome for a journal that cannot be updated in order is
 * that nothing was written, which the caller already reports.
 */
const JOURNAL_LOCK_POLL_MS = 20
const JOURNAL_LOCK_WAIT_MS = 15_000

interface JournalLockIdentity {
  dev: number
  ino: number
}

function cancelIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CommandCancelled()
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A process owned by another user reports EPERM rather than ESRCH: it is
    // running, this process just may not signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function waitFor(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Whether the process that wrote a lock is still running, and null when the
 * lock cannot be read as one this build wrote. A lock with no readable owner
 * has no owner to ask, so it is treated as a holder that might be alive.
 */
function lockHolderIsRunning(raw: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const pid = parsed.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    return processIsRunning(pid)
  } catch {
    return null
  }
}

/**
 * The refusal a writer gets when it cannot take the lock. It names the file and
 * the condition under which removing it is safe, because the one thing no
 * process on disk can know is whether a person still has a window open.
 */
function journalLockRefusal(lockPath: string, running: boolean | null): Error {
  const holder =
    running === null
      ? 'a lock this build did not write, whose owner cannot be identified'
      : running
        ? 'a window of this app that is still running'
        : 'a window of this app that is no longer running'
  return new Error(
    `This repository's review journal is locked at ${lockPath} by ${holder}. Nothing was written. ` +
      'A lock is only ever released by the process that took it, so it is never taken from its holder: ' +
      'freeing the name would let another process enter the journal while its holder still believes it ' +
      'owns it, which is the lost record this lock exists to prevent. Close every Git Stacks window for ' +
      'this repository, confirm none is open, and then remove that one file — the next write takes the ' +
      'lock itself.',
  )
}

/**
 * The refusal a writer gets when the lock exists and cannot be read: a file
 * this process may not open, or not one it can read bytes from.
 *
 * Nothing about it can be answered by waiting. The holder's identity is the
 * one thing the lock carries, and there is none of it here, so this is the
 * same unknown as a lock written by something else — except that the person
 * reading it can do something about it: a lock that cannot be opened is almost
 * always a permission, and saying so is what makes the refusal actionable
 * rather than a wall.
 */
function journalLockUnreadable(lockPath: string, cause: unknown): Error {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  const reason =
    code === 'EACCES' || code === 'EPERM'
      ? 'this app is not allowed to read it'
      : code === 'EISDIR'
        ? 'it is a directory rather than a lock file'
        : `it could not be read (${code ?? 'no reason reported'})`
  return new Error(
    `This repository's review journal is locked at ${lockPath} and ${reason}, so its owner cannot be identified. Nothing was written. ` +
      'A lock is never taken from its holder, so the write stops here rather than writing beside a window that may still hold the journal. ' +
      'Close every Git Stacks window for this repository, confirm none is open, and then remove that one file — or make it readable ' +
      'to this account — and the next write takes the lock itself.',
  )
}

/**
 * Takes the journal lock, or refuses.
 *
 * The lock is created with `link(2)`, which is atomic: exactly one process can
 * create the name, and the winner owns it until it removes it. That is the whole
 * protocol, and it is deliberately the whole protocol. A lock is never taken
 * from its holder, because no pathname protocol can take one safely: removing
 * or renaming the name frees it, a contender can take it and be inside the
 * journal in the meantime, and nothing that happens afterwards can un-enter it.
 * An open descriptor pins the inode a lock was made from, which is what tells
 * two locks apart — it does not hold the name, and it is not ownership.
 *
 * So a lock whose holder is gone is not reclaimed. It blocks, and says exactly
 * which file to remove and when it is safe to remove it, because a person
 * closing the last window for a repository knows something no process on disk
 * can know. A lock that cannot be read as one is refused the same way: it was
 * not written by this protocol, and guessing at its owner is how a live lock
 * gets deleted. So is a lock that cannot be read at all, which says nothing
 * even about who wrote it — that one is refused immediately rather than waited
 * on, because no amount of waiting opens a file this process may not read.
 */
async function acquireJournalLock(
  file: string,
  signal?: AbortSignal,
): Promise<JournalLockIdentity> {
  const lockPath = `${file}.lock`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const deadline = Date.now() + JOURNAL_LOCK_WAIT_MS
  for (;;) {
    cancelIfAborted(signal)
    const temporary = `${lockPath}.${randomUUID()}.tmp`
    const handle = await fs.open(temporary, 'wx', 0o600)
    let identity: JournalLockIdentity
    try {
      const stat = await handle.stat()
      identity = { dev: stat.dev, ino: stat.ino }
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
        'utf8',
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fs.link(temporary, lockPath)
      return identity
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }

    // Someone held it a moment ago. The lock is only read, to say who, and is
    // left exactly as it was found: it is never taken from its holder. A holder
    // that released between the failed link and this read has simply finished,
    // so the name is free now and the next attempt takes it — a lock that is
    // gone is the only read failure worth trying again. Any other failure
    // leaves a lock standing that this process cannot see into, and retrying
    // that spins on a file no waiting helps: the owner may well be alive, so the
    // write refuses instead of guessing.
    let held: string
    try {
      held = await fs.readFile(lockPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw journalLockUnreadable(lockPath, error)
    }
    const running = lockHolderIsRunning(held)
    // Only a holder known to be alive gets the wait: it is a window mid-write,
    // and it will let go. A holder that is gone, or one this build cannot read,
    // is refused at once — waiting cannot help either way, and only a person can
    // clear it.
    if (running === true && Date.now() < deadline) {
      cancelIfAborted(signal)
      await waitFor(JOURNAL_LOCK_POLL_MS)
      continue
    }
    throw journalLockRefusal(lockPath, running)
  }
}

/**
 * Releases a lock, and only the lock this process took.
 *
 * The name is compared against the inode recorded when it was taken, so a lock
 * that is somehow no longer the one acquired is left alone rather than removed
 * on its behalf. Nothing else can take the name while this process holds it:
 * every other writer only ever creates the name, and creates fail while it is
 * there.
 */
async function releaseJournalLock(file: string, identity: JournalLockIdentity): Promise<void> {
  const lockPath = `${file}.lock`
  try {
    const stat = await fs.lstat(lockPath)
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) return
    await fs.rm(lockPath, { force: true })
  } catch {
    // A lock already gone needs no release.
  }
}

/** Runs an update of one journal with no other process able to interleave. */
async function withJournalLock<T>(
  file: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const identity = await acquireJournalLock(file, signal)
  try {
    return await run()
  } finally {
    await releaseJournalLock(file, identity)
  }
}

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
      // The composition this comment was written from. A record that predates the
      // association carries none, and a comment with none is evidence about no
      // particular composition: it is not read as delivering anything.
      draftId: typeof entry.draftId === 'string' && entry.draftId !== '' ? entry.draftId : null,
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

async function readJournal(file: string): Promise<ReviewDraftRecord[]> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) return []
    return parsed.records
      .map(parseRecord)
      .filter((record): record is ReviewDraftRecord => record !== null)
  } catch {
    return []
  }
}

/**
 * Publishes the whole journal at once, so a reader sees either every record or
 * none of them and never a half-written one.
 *
 * Records are never evicted to make room. A record is one pull request's unsent
 * words, so dropping one to keep the file small would discard work the
 * reviewer has not sent and still believes is kept; a record leaves the journal
 * only when its own owner sends or clears it. Each record is separately bounded
 * by `REVIEW_DRAFTS_MAX`, so a single pull request cannot grow the file without
 * limit either.
 */
async function writeJournalFile(file: string, records: ReviewDraftRecord[]): Promise<void> {
  const journal: DraftJournal = { version: 1, records }
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
    (await readJournal(await draftsPath(repoPath, signal))).find(
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
 *
 * The read and the write happen under the journal's cross-process lock, so a
 * second window or worktree saving its own pull request cannot read the state
 * before this save and publish over it.
 */
export async function writeReviewDrafts(
  repoPath: string,
  record: ReviewDraftRecord,
  signal?: AbortSignal,
): Promise<ReviewDraftRecord> {
  const file = await draftsPath(repoPath, signal)
  return withJournalLock(
    file,
    async () => {
      const records = await readJournal(file)
      const kept = records.filter(
        (entry) => entry.number !== record.number || !sameOwner(entry, record.repo, record.viewer),
      )
      // A record is kept while it has drafts, and dropped once they are gone.
      // It used to outlive them for the sake of a counter: a draft's identity
      // had to be counted from this record, so removing it would hand the next
      // draft a name this account has already used — the second comment on a
      // line, which no amount of reading the words or the anchor can tell from
      // the first. An identity is minted where a draft is composed now, so
      // there is nothing here left to keep, and an empty record would be one
      // pull request occupying a slot in a file that is never pruned. An
      // account that never wrote a draft still leaves nothing behind.
      if (record.drafts.length > 0) {
        kept.unshift({ ...record, drafts: record.drafts.slice(0, REVIEW_DRAFTS_MAX) })
      }
      await writeJournalFile(file, kept)
      return record
    },
    signal,
  )
}

/**
 * Drops the drafts of one pull request, used after GitHub has accepted them.
 *
 * Clearing is an update like any other and runs under the same lock, so it
 * cannot read the journal before another window's save and publish a version
 * that still holds drafts the reviewer has just sent.
 */
export async function clearReviewDrafts(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  signal?: AbortSignal,
): Promise<void> {
  const file = await draftsPath(repoPath, signal)
  await withJournalLock(
    file,
    async () => {
      const records = await readJournal(file)
      await writeJournalFile(
        file,
        records.filter((entry) => entry.number !== number || !sameOwner(entry, repo, viewer)),
      )
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
 * The read and the write run under the journal's cross-process lock: two
 * processes attempting writes at once must both end up recorded, because losing
 * one is indistinguishable from never having guarded it.
 */
export async function recordUncertainWrite(
  repoPath: string,
  write: ReviewUncertainWrite,
  signal?: AbortSignal,
): Promise<void> {
  const file = await uncertainPath(repoPath, signal)
  await withJournalLock(
    file,
    async () => {
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
      await writeUncertain(file, [write, ...kept], signal)
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
  const entries = await readUncertain(await uncertainPath(repoPath, signal))
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
  signal?: AbortSignal,
): Promise<void> {
  const file = await uncertainPath(repoPath, signal)
  await withJournalLock(
    file,
    async () => {
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
  signal?: AbortSignal,
): Promise<void> {
  const file = await uncertainPath(repoPath, signal)
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
      await writeUncertain(file, kept, signal)
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
