import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import type { ReviewComparison, ReviewLineRef, ReviewSide } from '../shared/review'
import type {
  ReviewDraft,
  ReviewDraftRecord,
  ReviewUncertainWrite,
} from '../shared/review-threads'
import { REVIEW_DRAFTS_MAX, REVIEW_UNCERTAIN_MAX } from '../shared/review-threads'
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
    event:
      value.event === 'COMMENT' || value.event === 'APPROVE' || value.event === 'REQUEST_CHANGES'
        ? value.event
        : null,
    at: typeof value.at === 'string' ? value.at : '',
    repo: typeof value.repo === 'string' ? value.repo : '',
    viewer: typeof value.viewer === 'string' ? value.viewer : '',
  }
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
  return {
    number: value.number,
    repo: value.repo,
    viewer: value.viewer,
    // A record written before drafts carried their comparison describes a diff
    // that can no longer be identified, so it is refused rather than guessed at
    // and the reviewer's words are left in the file for them to find.
    comparison: parseComparison(value.comparison),
    drafts: value.drafts
      .map(parseDraft)
      .filter((draft): draft is ReviewDraft => draft !== null)
      .slice(0, REVIEW_DRAFTS_MAX),
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
  if (record.drafts.length > 0) {
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
