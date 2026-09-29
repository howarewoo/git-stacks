import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import type { ReviewComparison, ReviewLineRef, ReviewSide } from '../shared/review'
import type { ReviewDraft, ReviewDraftRecord } from '../shared/review-threads'
import { REVIEW_DRAFTS_MAX } from '../shared/review-threads'
import { isRecord, runGit, stripTrailingNewline } from './git-core'

interface DraftJournal {
  version: 1
  records: ReviewDraftRecord[]
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
  return {
    number: value.number,
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

/** The pending drafts of one pull request, or null when it has none. */
export async function readReviewDrafts(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewDraftRecord | null> {
  return (await readJournal(repoPath, signal)).find((record) => record.number === number) ?? null
}

/**
 * Replaces the drafts of one pull request.
 *
 * Drafts survive leaving the workspace and reopening the repository, which is
 * the whole reason they are journalled rather than held in the view. A
 * successful submission is recorded as an empty draft list, so the words a
 * reviewer just sent are not offered again afterwards.
 */
export async function writeReviewDrafts(
  repoPath: string,
  record: ReviewDraftRecord,
  signal?: AbortSignal,
): Promise<ReviewDraftRecord> {
  const records = await readJournal(repoPath, signal)
  const kept = records.filter((entry) => entry.number !== record.number)
  if (record.drafts.length > 0) {
    kept.unshift({ ...record, drafts: record.drafts.slice(0, REVIEW_DRAFTS_MAX) })
  }
  await writeJournal(repoPath, kept, signal)
  return record
}

/** Drops the drafts of one pull request, used after GitHub has accepted them. */
export async function clearReviewDrafts(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<void> {
  const records = await readJournal(repoPath, signal)
  await writeJournal(
    repoPath,
    records.filter((entry) => entry.number !== number),
    signal,
  )
}
