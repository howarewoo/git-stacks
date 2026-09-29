import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import type { ReviewComparison } from '../shared/review'
import type {
  ReviewFirstObservation,
  ReviewSnapshot,
  ReviewSnapshotLog,
} from '../shared/review-snapshots'
import {
  observeReviewHead,
  withReviewedSnapshot,
} from '../shared/review-snapshots'
import { isRecord, runGit, stripTrailingNewline } from './git-core'

interface SnapshotJournal {
  version: 1
  records: ReviewSnapshotLog[]
}

const JOURNAL_MAX_LOGS = 100

/**
 * The update snapshots live beside the repository's own Git directory, in the
 * common directory every linked worktree shares: they describe heads a person
 * observed across this repository, whatever worktree they were in.
 */
async function snapshotPath(repoPath: string, signal?: AbortSignal): Promise<string> {
  const common = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-common-dir'], undefined, signal),
  )
  return path.resolve(repoPath, common, 'git-stacks-review-snapshots.json')
}

function parseSnapshot(value: unknown): ReviewSnapshot | null {
  if (!isRecord(value) || typeof value.headOid !== 'string' || value.headOid === '') {
    return null
  }
  return {
    headOid: value.headOid,
    baseOid: typeof value.baseOid === 'string' ? value.baseOid : null,
    baseRef: typeof value.baseRef === 'string' ? value.baseRef : null,
    firstSeenAt: typeof value.firstSeenAt === 'string' ? value.firstSeenAt : '',
    lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : '',
    observations:
      typeof value.observations === 'number' && Number.isFinite(value.observations)
        ? Math.max(1, Math.floor(value.observations))
        : 1,
    reviewed: value.reviewed === true,
    reviewedAt: typeof value.reviewedAt === 'string' ? value.reviewedAt : null,
    reviewId: typeof value.reviewId === 'string' ? value.reviewId : null,
  }
}

function parseFirst(value: unknown): ReviewFirstObservation | null {
  if (!isRecord(value) || typeof value.headOid !== 'string') return null
  return {
    headOid: value.headOid,
    at: typeof value.at === 'string' ? value.at : '',
    commits:
      typeof value.commits === 'number' && Number.isFinite(value.commits)
        ? Math.floor(value.commits)
        : null,
  }
}

function parseLog(value: unknown): ReviewSnapshotLog | null {
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    typeof value.repo !== 'string' ||
    typeof value.viewer !== 'string' ||
    !Array.isArray(value.snapshots)
  ) {
    return null
  }
  const first = parseFirst(value.first)
  if (!first) return null
  const snapshots = value.snapshots
    .map(parseSnapshot)
    .filter((entry): entry is ReviewSnapshot => entry !== null)
  return {
    number: value.number,
    repo: value.repo,
    viewer: value.viewer,
    snapshots,
    first,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

async function readJournal(repoPath: string, signal?: AbortSignal): Promise<ReviewSnapshotLog[]> {
  try {
    const raw = await fs.readFile(await snapshotPath(repoPath, signal), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) return []
    return parsed.records.map(parseLog).filter((log): log is ReviewSnapshotLog => log !== null)
  } catch {
    return []
  }
}

async function writeJournal(
  repoPath: string,
  records: ReviewSnapshotLog[],
  signal?: AbortSignal,
): Promise<void> {
  const file = await snapshotPath(repoPath, signal)
  const journal: SnapshotJournal = {
    version: 1,
    records: records.slice(0, JOURNAL_MAX_LOGS),
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

function matches(log: ReviewSnapshotLog, repo: string, viewer: string, number: number): boolean {
  return log.repo === repo && log.viewer === viewer && log.number === number
}

/** The snapshot log for one pull request, or null when it has never been observed. */
export async function readReviewSnapshotLog(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewSnapshotLog | null> {
  const records = await readJournal(repoPath, signal)
  return records.find((log) => matches(log, repo, viewer, number)) ?? null
}

/**
 * Records an observed head for this pull request under the active account.
 *
 * If the head was observed before, its lastSeenAt timestamp and observation
 * count are updated without appending a duplicate entry. If it is new, it is
 * added to the end of the log and the log is pruned to its ceiling while
 * retaining every reviewed anchor.
 */
export async function recordObservedHead(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  comparison: ReviewComparison,
  commits: number | null,
  now: string = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<ReviewSnapshotLog> {
  const records = await readJournal(repoPath, signal)
  const existingIndex = records.findIndex((log) => matches(log, repo, viewer, number))
  const current = existingIndex >= 0 ? records[existingIndex] : null
  const updated = observeReviewHead(current, { number, repo, viewer, comparison, commits, now })
  const kept = records.filter((_, index) => index !== existingIndex)
  kept.unshift(updated)
  await writeJournal(repoPath, kept, signal)
  return updated
}

/**
 * Marks one head as reviewed by the active account.
 *
 * This only succeeds when the head was previously observed: a review cannot be
 * about a head nobody looked at, and a record of a head that was never journalled
 * is an unconfirmed write, not an anchor.
 */
export async function markReviewSnapshotReviewed(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  headOid: string,
  reviewId: string | null,
  now: string = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<void> {
  const records = await readJournal(repoPath, signal)
  const target = records.find((log) => matches(log, repo, viewer, number))
  if (!target) return
  const updated = withReviewedSnapshot(target, headOid, reviewId, now)
  const kept = records.filter((log) => !matches(log, repo, viewer, number))
  kept.unshift(updated)
  await writeJournal(repoPath, kept, signal)
}

/**
 * Clears the snapshot log for one pull request under this account.
 *
 * This is local-only: no GitHub mutation occurs, and other accounts' logs in the
 * same repository are untouched.
 */
export async function clearReviewSnapshots(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  signal?: AbortSignal,
): Promise<void> {
  const records = await readJournal(repoPath, signal)
  const kept = records.filter((log) => !matches(log, repo, viewer, number))
  await writeJournal(repoPath, kept, signal)
}
