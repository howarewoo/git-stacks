import { createHash } from 'node:crypto'
import { REVIEW_VIEWED_MAX_RECORDS, type ReviewViewedRecord } from '@git-stacks/shared/review'
import { isRecord } from '@git-stacks/shared/guards'
import { readJournal, repositoryJournalPath, writeJournal, withJournalLock } from './review-journal'

export interface ReviewViewedOwner {
  host: string
  repository: string
  viewer: string
}

function viewedJournal(owner: ReviewViewedOwner): string {
  const scope = JSON.stringify([
    owner.host.toLowerCase(),
    owner.repository.toLowerCase(),
    owner.viewer.toLowerCase(),
  ])
  return `git-stacks-reviewed-files-${createHash('sha256').update(scope).digest('hex')}.json`
}

async function readViewedJournal(
  repoPath: string,
  owner: ReviewViewedOwner,
  signal?: AbortSignal,
): Promise<ReviewViewedRecord[]> {
  try {
    return await readJournal(
      await repositoryJournalPath(repoPath, viewedJournal(owner), signal),
      'records',
      parseRecord,
    )
  } catch {
    return []
  }
}

function parseRecord(value: unknown): ReviewViewedRecord | null {
  if (!isRecord(value) || typeof value.number !== 'number' || !Array.isArray(value.paths)) {
    return null
  }
  // A record from the shape that bound to a head alone is dropped rather than
  // read as an empty record: it cannot be shown to be about the comparison now
  // on screen, and keeping it would reintroduce the marks a retarget must clear.
  if (!isRecord(value.comparison)) return null
  const comparison = value.comparison
  if (
    (comparison.headOid !== null && typeof comparison.headOid !== 'string') ||
    (comparison.baseOid !== null && typeof comparison.baseOid !== 'string') ||
    (comparison.baseRef !== null && typeof comparison.baseRef !== 'string')
  ) {
    return null
  }
  return {
    number: value.number,
    comparison: {
      headOid: typeof comparison.headOid === 'string' ? comparison.headOid : null,
      baseOid: typeof comparison.baseOid === 'string' ? comparison.baseOid : null,
      baseRef: typeof comparison.baseRef === 'string' ? comparison.baseRef : null,
    },
    paths: value.paths.filter((path): path is string => typeof path === 'string'),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}
/** The viewed-file record for one pull request, or null when it has never been read. */
export async function readViewedRecord(
  repoPath: string,
  owner: ReviewViewedOwner,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewViewedRecord | null> {
  const records = await readViewedJournal(repoPath, owner, signal)
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
  owner: ReviewViewedOwner,
  record: ReviewViewedRecord,
  authorize: () => Promise<void>,
  signal?: AbortSignal,
): Promise<ReviewViewedRecord> {
  const file = await repositoryJournalPath(repoPath, viewedJournal(owner), signal)
  return withJournalLock(
    file,
    async () => {
      const records = (await readJournal(file, 'records', parseRecord)).filter(
        (entry) => entry.number !== record.number,
      )
      records.unshift(record)
      await authorize()
      await writeJournal(file, 'records', records.slice(0, REVIEW_VIEWED_MAX_RECORDS))
      return record
    },
    signal,
  )
}
