import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import { REVIEW_VIEWED_MAX_RECORDS, type ReviewViewedRecord } from '../shared/review'
import { isRecord, runGit, stripTrailingNewline } from './git-core'

interface ViewedJournal {
  version: 1
  records: ReviewViewedRecord[]
}

/**
 * The viewed-file record lives beside the repository's own Git directory, not in
 * application data: it describes what a person read in this repository, it must
 * follow the repository across workspaces and linked worktrees, and it must never
 * be mistaken for repository content.
 */
async function viewedPath(repoPath: string, signal?: AbortSignal): Promise<string> {
  const common = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-common-dir'], undefined, signal),
  )
  return path.resolve(repoPath, common, 'git-stacks-reviewed-files.json')
}

function parseRecord(value: unknown): ReviewViewedRecord | null {
  if (!isRecord(value) || typeof value.number !== 'number' || !Array.isArray(value.paths)) {
    return null
  }
  return {
    number: value.number,
    headOid: typeof value.headOid === 'string' ? value.headOid : null,
    paths: value.paths.filter((path): path is string => typeof path === 'string'),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

async function readJournal(repoPath: string, signal?: AbortSignal): Promise<ReviewViewedRecord[]> {
  try {
    const raw = await fs.readFile(await viewedPath(repoPath, signal), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) return []
    return parsed.records
      .map(parseRecord)
      .filter((record): record is ReviewViewedRecord => record !== null)
  } catch {
    return []
  }
}

async function writeJournal(
  repoPath: string,
  records: ReviewViewedRecord[],
  signal?: AbortSignal,
): Promise<void> {
  const file = await viewedPath(repoPath, signal)
  const journal: ViewedJournal = {
    version: 1,
    records: records.slice(0, REVIEW_VIEWED_MAX_RECORDS),
  }
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

/** The viewed-file record for one pull request, or null when it has never been read. */
export async function readViewedRecord(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewViewedRecord | null> {
  const records = await readJournal(repoPath, signal)
  return records.find((record) => record.number === number) ?? null
}

/**
 * Replaces the record for one pull request.
 *
 * A record is written whole rather than merged line by line, so a force-pushed
 * head cannot leave a stale path behind: the caller supplies the complete set for
 * the head it just read. GitHub has no supported endpoint that reports or writes
 * which files a person has viewed, so this record is the only place that fact
 * lives, and it is never presented as synced.
 */
export async function writeViewedRecord(
  repoPath: string,
  record: ReviewViewedRecord,
  signal?: AbortSignal,
): Promise<ReviewViewedRecord> {
  const records = (await readJournal(repoPath, signal)).filter(
    (entry) => entry.number !== record.number,
  )
  records.unshift(record)
  await writeJournal(repoPath, records, signal)
  return record
}
