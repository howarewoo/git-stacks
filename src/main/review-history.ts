import type { ReviewComparison, ReviewFile, ReviewFileDiff } from '../shared/review'
import { looksGenerated, sameReviewComparison } from '../shared/review'
import type { ReviewHistory, ReviewHistoryDiff, ReviewSnapshot } from '../shared/review-snapshots'
import { reviewHistoryOf } from '../shared/review-snapshots'
import { type ParsedRemote, runGit } from './git-core'
import { isRecord } from '../shared/guards'
import { GitHubTransportError } from './github-transport'
import { parseHunkBlock } from './hunks'
import {
  originRemote,
  parseReviewFileEntry,
  readReviewIdentity,
  reviewTransport,
  ReviewRevisionMovedError,
  toReviewHunk,
} from './review'
import { clearReviewSnapshots, readReviewSnapshotLog, recordObservedHead } from './review-snapshots'
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
    const response = await reviewTransport(remote).rest<unknown>({
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
 * Uses local Git to compute a true two-endpoint tree diff between two commits.
 *
 * Unlike GitHub's compare API which computes a 3-dot merge-base diff, Git's
 * direct commit diff compares tree(fromOid) to tree(toOid) faithfully across
 * force-pushes, rebases, and unrelated histories.
 */
async function diffEndpointWithGit(
  repoPath: string,
  fromOid: string,
  toOid: string,
  signal?: AbortSignal,
): Promise<{
  files: ReviewFile[]
  additions: number
  deletions: number
  truncated: boolean
} | null> {
  try {
    let fromExists = await runGit(
      repoPath,
      ['cat-file', '-e', `${fromOid}^{commit}`],
      undefined,
      signal,
    )
      .then(() => true)
      .catch(() => false)
    if (!fromExists) {
      try {
        await runGit(
          repoPath,
          [
            'fetch',
            '--no-write-fetch-head',
            '--no-tags',
            '--recurse-submodules=no',
            'origin',
            fromOid,
          ],
          undefined,
          signal,
        )
        fromExists = await runGit(
          repoPath,
          ['cat-file', '-e', `${fromOid}^{commit}`],
          undefined,
          signal,
        )
          .then(() => true)
          .catch(() => false)
      } catch {
        return null
      }
      if (!fromExists) return null
    }

    let toExists = await runGit(
      repoPath,
      ['cat-file', '-e', `${toOid}^{commit}`],
      undefined,
      signal,
    )
      .then(() => true)
      .catch(() => false)
    if (!toExists) {
      try {
        await runGit(
          repoPath,
          [
            'fetch',
            '--no-write-fetch-head',
            '--no-tags',
            '--recurse-submodules=no',
            'origin',
            toOid,
          ],
          undefined,
          signal,
        )
        toExists = await runGit(
          repoPath,
          ['cat-file', '-e', `${toOid}^{commit}`],
          undefined,
          signal,
        )
          .then(() => true)
          .catch(() => false)
      } catch {
        return null
      }
      if (!toExists) return null
    }

    const nameStatusRaw = await runGit(
      repoPath,
      ['diff', '--name-status', '-z', '-M', fromOid, toOid],
      undefined,
      signal,
    )
    const tokens = nameStatusRaw.split('\0')
    const statusEntries: {
      path: string
      previousPath: string | null
      status: ReviewFile['status']
    }[] = []
    let i = 0
    while (i < tokens.length - 1) {
      const statusToken = tokens[i++]
      if (!statusToken) break
      const statusChar = statusToken[0]
      if (statusChar === 'R' || statusChar === 'C') {
        const previousPath = tokens[i++]
        const path = tokens[i++]
        statusEntries.push({
          path,
          previousPath,
          status: statusChar === 'R' ? 'renamed' : 'copied',
        })
      } else {
        const path = tokens[i++]
        const status: ReviewFile['status'] =
          statusChar === 'A' ? 'added' : statusChar === 'D' ? 'removed' : 'modified'
        statusEntries.push({ path, previousPath: null, status })
      }
    }

    const numstatRaw = await runGit(
      repoPath,
      ['diff', '--numstat', '-z', '-M', fromOid, toOid],
      undefined,
      signal,
    )
    const numTokens = numstatRaw.split('\0')
    const statsMap = new Map<string, { additions: number; deletions: number }>()
    let j = 0
    while (j < numTokens.length - 1) {
      const entry = numTokens[j++]
      if (!entry) break
      const firstTab = entry.indexOf('\t')
      const secondTab = entry.indexOf('\t', firstTab + 1)
      if (firstTab < 0 || secondTab < 0) continue
      const additions = parseInt(entry.slice(0, firstTab), 10) || 0
      const deletions = parseInt(entry.slice(firstTab + 1, secondTab), 10) || 0
      let filePath = entry.slice(secondTab + 1)
      if (filePath === '') {
        j++ // Rename preimage; the following NUL-delimited path is the destination.
        filePath = numTokens[j++]
      }
      statsMap.set(filePath, { additions, deletions })
    }

    const truncated = statusEntries.length > 300
    const chosenEntries = statusEntries.slice(0, 300)
    const parsedFiles: ReviewFile[] = []

    for (const entry of chosenEntries) {
      const stats = statsMap.get(entry.path) ?? { additions: 0, deletions: 0 }
      let diff: ReviewFileDiff
      try {
        const pathArgs =
          entry.previousPath && entry.previousPath !== entry.path
            ? [`:(literal)${entry.previousPath}`, `:(literal)${entry.path}`]
            : [`:(literal)${entry.path}`]
        const patch = await runGit(
          repoPath,
          ['diff', '-M', '--no-ext-diff', '--no-textconv', fromOid, toOid, '--', ...pathArgs],
          undefined,
          signal,
        )
        if (patch.trim() === '') {
          diff =
            stats.additions === 0 && stats.deletions === 0
              ? { kind: 'binary' }
              : { kind: 'text', hunks: [] }
        } else {
          const block = parseHunkBlock(patch, {
            path: entry.path,
            originalPath: entry.previousPath,
          })
          if (block.kind === 'binary') {
            diff = { kind: 'binary' }
          } else if (block.kind === 'unreadable') {
            diff = { kind: 'unreadable', reason: 'Unreadable diff patch from Git.' }
          } else {
            diff = {
              kind: 'text',
              hunks: block.hunks.map((hunk) => toReviewHunk(entry.path, hunk)),
            }
          }
        }
      } catch {
        diff = { kind: 'unreadable', reason: 'Could not read diff patch from Git.' }
      }

      parsedFiles.push({
        path: entry.path,
        previousPath: entry.previousPath,
        status: entry.status,
        additions: stats.additions,
        deletions: stats.deletions,
        changes: stats.additions + stats.deletions,
        sha: null,
        generated: looksGenerated(entry.path),
        diff,
      })
    }

    const additions = parsedFiles.reduce((sum, f) => sum + f.additions, 0)
    const deletions = parsedFiles.reduce((sum, f) => sum + f.deletions, 0)

    return { files: parsedFiles, additions, deletions, truncated }
  } catch {
    return null
  }
}

/**
 * Compares an observed historical snapshot against the pull request's current head.
 *
 * Two endpoints are compared faithfully. A missing commit, a deleted ref, or
 * unrelated histories that share no merge base produce an explicit unavailable
 * state with the exact reason, never a fabricated fallback diff.
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

  // 1. Try local Git endpoint diff first for a true tree-to-tree comparison across force-push/rebase.
  const gitResult = await diffEndpointWithGit(repoPath, fromOid, currentHead, signal)
  if (gitResult) {
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
      mergeBaseOid: null,
      files: gitResult.files,
      additions: gitResult.additions,
      deletions: gitResult.deletions,
      truncated: gitResult.truncated,
    }
  }

  // 2. Fall back to GitHub compare API, checking that the comparison is an endpoint diff.
  try {
    const response = await reviewTransport(remote).rest<unknown>({
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

    // When the merge base is NOT fromOid, GitHub compare is a 3-dot diff from their common ancestor,
    // which does not equal a true endpoint comparison between the two heads.
    if (mergeBaseOid !== fromOid) {
      return {
        number,
        from: snapshot,
        to: before.comparison,
        state: 'unavailable',
        reason: `GitHub comparison between diverged revisions is relative to their common ancestor rather than an endpoint comparison between the two heads, and local Git could not establish the endpoint diff.`,
        mergeBaseOid,
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
