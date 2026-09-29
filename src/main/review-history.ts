import type { ReviewComparison, ReviewFile } from '../shared/review'
import { sameReviewComparison } from '../shared/review'
import type {
  ReviewHistory,
  ReviewHistoryDiff,
  ReviewSnapshot,
} from '../shared/review-snapshots'
import { reviewHistoryOf } from '../shared/review-snapshots'
import { isRecord, type ParsedRemote } from './git-core'
import { GitHubTransportError, githubTransport } from './github-transport'
import {
  originRemote,
  parseReviewFileEntry,
  readReviewIdentity,
  ReviewRevisionMovedError,
} from './review'
import {
  clearReviewSnapshots,
  readReviewSnapshotLog,
  recordObservedHead,
} from './review-snapshots'
import { readReviewPermissions } from './review-threads'

/**
 * Reads the update history of one pull request for the active account.
 *
 * This observes the pull request's current head as part of the read: reading
 * history is what tells the app which head is on screen now, and recording it
 * at the same moment keeps the record deduplicated and bound to the exact
 * commit the workspace is about to show.
 */
export async function readReviewHistory(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewHistory> {
  const remote = await originRemote(repoPath, signal)
  const repo = `${remote.owner}/${remote.name}`
  const permissions = await readReviewPermissions(repoPath, number, signal)
  const identity = await readReviewIdentity(remote, number, signal)
  const log = await recordObservedHead(
    repoPath,
    repo,
    permissions.viewer,
    number,
    identity.comparison,
    identity.totalCommits,
    new Date().toISOString(),
    signal,
  )
  return reviewHistoryOf(number, identity.comparison, log)
}

/**
 * Whether an error from the transport represents an HTTP 404 Not Found.
 */
function isNotFoundError(error: unknown): boolean {
  if (error instanceof GitHubTransportError) {
    return error.kind === 'not-found' || error.status === 404
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { kind?: unknown; status?: unknown }
    return candidate.kind === 'not-found' || candidate.status === 404
  }
  return false
}

/**
 * Checks whether a commit still exists on GitHub.
 */
async function probeCommitExists(
  remote: ParsedRemote,
  oid: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await githubTransport().rest<unknown>({
      method: 'GET',
      path: `repos/${remote.owner}/${remote.name}/commits/${oid}`,
      signal,
    })
    return response.status === 200
  } catch (error) {
    if (isNotFoundError(error)) return false
    return false
  }
}

/**
 * Compares an observed historical snapshot against the pull request's current head.
 *
 * Two endpoints are compared faithfully via GitHub's compare API. A missing
 * commit, a deleted ref, or unrelated histories that share no merge base
 * produce an explicit unavailable state with the exact reason, never a
 * fabricated fallback diff.
 */
export async function readReviewHistoryDiff(
  repoPath: string,
  number: number,
  fromOid: string,
  signal?: AbortSignal,
): Promise<ReviewHistoryDiff> {
  const remote = await originRemote(repoPath, signal)
  const repo = `${remote.owner}/${remote.name}`
  const permissions = await readReviewPermissions(repoPath, number, signal)
  const before = await readReviewIdentity(remote, number, signal)
  const log = await readReviewSnapshotLog(repoPath, repo, permissions.viewer, number, signal)

  const snapshot: ReviewSnapshot | undefined = log?.snapshots.find(
    (entry) => entry.headOid === fromOid,
  )

  const fallbackSnapshot: ReviewSnapshot = snapshot ?? {
    headOid: fromOid,
    baseOid: null,
    baseRef: null,
    firstSeenAt: '',
    lastSeenAt: '',
    observations: 0,
    reviewed: false,
    reviewedAt: null,
    reviewId: null,
  }

  if (!snapshot) {
    return {
      number,
      from: fallbackSnapshot,
      to: before.comparison,
      state: 'unavailable',
      reason: `Commit ${fromOid.slice(0, 7)} was not recorded in this account's observed snapshots for #${number}.`,
      mergeBaseOid: null,
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    }
  }

  const currentHead = before.comparison.headOid
  if (currentHead === null || currentHead === '') {
    return {
      number,
      from: snapshot,
      to: before.comparison,
      state: 'unavailable',
      reason: `The current head of #${number} could not be determined.`,
      mergeBaseOid: null,
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    }
  }

  // Same head: identical, no changes.
  if (fromOid === currentHead) {
    return {
      number,
      from: snapshot,
      to: before.comparison,
      state: 'files',
      reason: '',
      mergeBaseOid: currentHead,
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    }
  }

  try {
    const response = await githubTransport().rest<unknown>({
      method: 'GET',
      path: `repos/${remote.owner}/${remote.name}/compare/${fromOid}...${currentHead}`,
      signal,
    })

    const data = isRecord(response.data) ? response.data : {}
    const mergeBaseCommit = isRecord(data.merge_base_commit) ? data.merge_base_commit : null
    const mergeBaseOid =
      mergeBaseCommit && typeof mergeBaseCommit.sha === 'string' ? mergeBaseCommit.sha : null

    if (mergeBaseOid === null) {
      return {
        number,
        from: snapshot,
        to: before.comparison,
        state: 'unavailable',
        reason: `The two heads share no common ancestor (merge base was lost), so GitHub cannot show changes between ${fromOid.slice(0, 7)} and ${currentHead.slice(0, 7)}.`,
        mergeBaseOid: null,
        files: [],
        additions: 0,
        deletions: 0,
        truncated: false,
      }
    }

    const rawFiles = Array.isArray(data.files) ? data.files : []
    const parsedFiles: ReviewFile[] = []
    for (const entry of rawFiles) {
      const parsed = parseReviewFileEntry(entry)
      if (parsed) parsedFiles.push(parsed)
    }

    // Pinning check: the pull request must not have moved during the compare call.
    const after = await readReviewIdentity(remote, number, signal)
    if (!sameReviewComparison(before.comparison, after.comparison)) {
      throw new ReviewRevisionMovedError(number)
    }

    return {
      number,
      from: snapshot,
      to: after.comparison,
      state: 'files',
      reason: '',
      mergeBaseOid,
      files: parsedFiles,
      additions: parsedFiles.reduce((sum, file) => sum + file.additions, 0),
      deletions: parsedFiles.reduce((sum, file) => sum + file.deletions, 0),
      truncated: rawFiles.length >= 300,
    }
  } catch (error) {
    if (error instanceof ReviewRevisionMovedError) throw error
    if (isNotFoundError(error)) {
      const commitExists = await probeCommitExists(remote, fromOid, signal)
      const reason = !commitExists
        ? `Historical commit ${fromOid.slice(0, 7)} is no longer in this repository (it was rewritten or garbage collected after a force-push, or the remote ref was deleted).`
        : `GitHub could not compare ${fromOid.slice(0, 7)} against ${currentHead.slice(0, 7)}: the two commits share no merge base, which occurs when a branch is rebased onto an unrelated history.`
      return {
        number,
        from: snapshot,
        to: before.comparison,
        state: 'unavailable',
        reason,
        mergeBaseOid: null,
        files: [],
        additions: 0,
        deletions: 0,
        truncated: false,
      }
    }
    throw error
  }
}

/**
 * Clears the snapshot log for this pull request under the active account.
 *
 * Local-only: does not mutate GitHub. Re-reading history after this will
 * treat the next open as a first observation.
 */
export async function clearReviewHistory(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewHistory> {
  const remote = await originRemote(repoPath, signal)
  const repo = `${remote.owner}/${remote.name}`
  const permissions = await readReviewPermissions(repoPath, number, signal)
  await clearReviewSnapshots(repoPath, repo, permissions.viewer, number, signal)
  const identity = await readReviewIdentity(remote, number, signal)
  return reviewHistoryOf(number, identity.comparison, null)
}
