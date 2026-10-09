import {
  observeReviewHead,
  withReviewedSnapshot,
  type ReviewFirstObservation,
  type ReviewSnapshot,
  type ReviewSnapshotLog,
} from '@git-stacks/shared/review-snapshots'
import type { ReviewComparison } from '@git-stacks/shared/review'
import { isRecord } from '@git-stacks/shared/guards'
import { readJournal, repositoryJournalPath, writeJournal } from './review-journal'

const SNAPSHOT_JOURNAL = 'git-stacks-review-snapshots.json'

const JOURNAL_MAX_LOGS = 100

async function readSnapshotJournal(
  repoPath: string,
  signal?: AbortSignal,
): Promise<ReviewSnapshotLog[]> {
  try {
    return await readJournal(
      await repositoryJournalPath(repoPath, SNAPSHOT_JOURNAL, signal),
      'records',
      parseLog,
    )
  } catch {
    return []
  }
}

async function writeSnapshotJournal(
  repoPath: string,
  records: ReviewSnapshotLog[],
  signal?: AbortSignal,
): Promise<void> {
  await writeJournal(
    await repositoryJournalPath(repoPath, SNAPSHOT_JOURNAL, signal),
    'records',
    records.slice(0, JOURNAL_MAX_LOGS),
  )
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
  const records = await readSnapshotJournal(repoPath, signal)
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
  const records = await readSnapshotJournal(repoPath, signal)
  const existingIndex = records.findIndex((log) => matches(log, repo, viewer, number))
  const current = existingIndex >= 0 ? records[existingIndex] : null
  const updated = observeReviewHead(current, { number, repo, viewer, comparison, commits, now })
  const kept = records.filter((_, index) => index !== existingIndex)
  kept.unshift(updated)
  await writeSnapshotJournal(repoPath, kept, signal)
  return updated
}

/**
 * Marks one head as reviewed by the active account.
 *
 * A confirmed review is itself an observation, including after local history
 * was cleared. Preserve the confirmed comparison before recording its anchor.
 */
export async function markReviewSnapshotReviewed(
  repoPath: string,
  repo: string,
  viewer: string,
  number: number,
  comparison: ReviewComparison,
  reviewId: string | null,
  now: string = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<void> {
  if (!comparison.headOid) return
  const records = await readSnapshotJournal(repoPath, signal)
  const target = records.find((log) => matches(log, repo, viewer, number)) ?? null
  const observed = target?.snapshots.some((entry) => entry.headOid === comparison.headOid)
    ? target
    : observeReviewHead(target, { number, repo, viewer, comparison, commits: null, now })
  const updated = withReviewedSnapshot(observed, comparison.headOid, reviewId, now)
  const kept = records.filter((log) => !matches(log, repo, viewer, number))
  kept.unshift(updated)
  await writeSnapshotJournal(repoPath, kept, signal)
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
  const records = await readSnapshotJournal(repoPath, signal)
  const kept = records.filter((log) => !matches(log, repo, viewer, number))
  await writeSnapshotJournal(repoPath, kept, signal)
}
