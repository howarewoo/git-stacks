import type { ReviewComparison, ReviewFileSet } from './review'

/**
 * Update snapshots: the heads this app has actually seen on a pull request.
 *
 * GitHub's own pull request "versions" are a server-side idea this app cannot
 * read as a list, so what is kept here is narrower and is named for what it is:
 * the head commits this installation observed, when it observed them, and what
 * this account did about one of them. It is not a version history, and the
 * workspace never presents it as one — the first thing a journal can be honest
 * about is that the heads before its first entry were never observed here at
 * all, so that gap is recorded with the observation rather than left for a
 * reader to infer.
 *
 * Nothing here is source text. A snapshot is three object names, two
 * timestamps, and a review identity, so the journal can be shown, cleared, or
 * rebuilt without touching GitHub and without holding a copy of anyone's code.
 */
export interface ReviewSnapshot {
  /** The head commit as a full object id. */
  headOid: string
  /** The base object the head was observed against, when GitHub reported one. */
  baseOid: string | null
  /** The base branch name at the same moment; a retarget changes the diff too. */
  baseRef: string | null
  /** When this head was first seen as the pull request's head. */
  firstSeenAt: string
  /** When this head was last seen as the pull request's head. */
  lastSeenAt: string
  /** How many reads observed this exact head. */
  observations: number
  /**
   * Whether this account's review of this head is known to have reached GitHub.
   *
   * Only a confirmed server review or a settled write adopted from GitHub sets
   * it. A submission whose response was lost stays unreviewed: the app does not
   * know that it landed, and claiming it did would move the "changes since
   * reviewed" anchor onto a head nobody is sure was reviewed.
   */
  reviewed: boolean
  /** When the review was confirmed, or null while there is none. */
  reviewedAt: string | null
  /** The review GitHub recorded, or null while there is none. */
  reviewId: string | null
}

/** What the very first read of a pull request found, which bounds what came before. */
export interface ReviewFirstObservation {
  /** The head the app saw the first time it opened this pull request. */
  headOid: string
  at: string
  /** How many commits GitHub counted on the pull request at that moment. */
  commits: number | null
}

/**
 * One pull request's observed heads, for one repository and one account.
 *
 * The repository and the account are part of the record rather than of the file,
 * exactly as they are for pending comments: the journal lives in a Git common
 * directory every worktree and origin of one clone shares, a pull request number
 * is only unique inside one repository, and "the head I reviewed" is a fact about
 * a person. Scoping by all three is what stops one account's last review from
 * becoming another's.
 */
export interface ReviewSnapshotLog {
  number: number
  repo: string
  viewer: string
  /** The observed heads in the order they were first seen, oldest first. */
  snapshots: ReviewSnapshot[]
  first: ReviewFirstObservation
  updatedAt: string
}

/**
 * Ceiling on remembered heads per pull request. A snapshot is a local reading
 * aid, so the list is bounded rather than grown without limit — and the pruning
 * never takes a reviewed head, because that is the anchor the "changes since
 * reviewed" comparison is built from and dropping it would silently replace a
 * reviewer's own last review with an older one.
 */
export const REVIEW_SNAPSHOTS_MAX = 40

/** What the app never saw, stated so a reader is not left inferring it. */
export interface ReviewHistoryGap {
  /** The head the app first saw for this pull request. */
  headOid: string
  /** When it first saw it. */
  at: string
  /** How many commits GitHub counted then, when it said. */
  commits: number | null
  /** The sentence the workspace shows. */
  message: string
}

/**
 * Everything the workspace knows about how this pull request's head has moved
 * while this app was watching it.
 */
export interface ReviewHistory {
  number: number
  /** The comparison the pull request is at now, as GitHub reported it. */
  current: ReviewComparison
  /** The observed heads, oldest first. */
  snapshots: ReviewSnapshot[]
  /** The newest head this account is known to have reviewed. */
  reviewed: ReviewSnapshot | null
  /** The newest head this account observed, reviewed or not. */
  latest: ReviewSnapshot | null
  /** The updates this app never saw, or null when the observation began at the first commit. */
  gap: ReviewHistoryGap | null
}

/**
 * Why two observed heads cannot be diffed.
 *
 * `files` is a comparison GitHub actually produced between the two endpoints.
 * `unavailable` is a gap: a force-push that rewrote the history, a rebase onto
 * commits with no common ancestor, a branch that was deleted, or a head the
 * journal no longer holds. It is never answered with the current diff, because a
 * diff against something else is not a comparison the reviewer asked for.
 */
export type ReviewHistoryDiffState = 'files' | 'unavailable'

/** The comparison between one observed head and the pull request's current head. */
export interface ReviewHistoryDiff {
  number: number
  /** The head the reviewer chose, as it was observed. */
  from: ReviewSnapshot
  /** The comparison the diff was read against at the other end. */
  to: ReviewComparison
  state: ReviewHistoryDiffState
  /** Why the two heads cannot be diffed; empty when they can. */
  reason: string
  /** The merge base GitHub diffed from, or null when it named none. */
  mergeBaseOid: string | null
  /** The files that differ between the two heads. */
  files: ReviewFileSet['files']
  additions: number
  deletions: number
  /** GitHub stops listing files past a fixed count; say so rather than implying completeness. */
  truncated: boolean
}

/**
 * Records the head a read observed.
 *
 * A head the journal already holds is not a new snapshot: the same commit read
 * twice is one observation seen twice, and a force-push is the only thing that
 * makes a second entry. What a repeated read does change is when the head was
 * last seen, which is what "the app has been on this head since" means, and the
 * comparison it was seen against, because a base that moved under a fixed head
 * changes what the reviewer was looking at.
 *
 * The very first observation also records what GitHub counted at that moment.
 * That count is the only evidence there is about updates the app never saw, and
 * it is kept rather than recomputed, because the journal is the thing that has to
 * stay honest after the pull request moves on.
 */
export function observeReviewHead(
  log: ReviewSnapshotLog | null,
  input: {
    number: number
    repo: string
    viewer: string
    comparison: ReviewComparison
    commits: number | null
    now: string
  },
): ReviewSnapshotLog {
  const headOid = input.comparison.headOid
  if (headOid === null || headOid === '') {
    return log ?? emptyLog(input)
  }
  const existing = log?.snapshots.find((entry) => entry.headOid === headOid)
  const snapshots = existing
    ? log!.snapshots.map((entry) =>
        entry.headOid === headOid
          ? {
              ...entry,
              baseOid: input.comparison.baseOid,
              baseRef: input.comparison.baseRef,
              lastSeenAt: input.now,
              observations: entry.observations + 1,
            }
          : entry,
      )
    : [
        ...(log?.snapshots ?? []),
        {
          headOid,
          baseOid: input.comparison.baseOid,
          baseRef: input.comparison.baseRef,
          firstSeenAt: input.now,
          lastSeenAt: input.now,
          observations: 1,
          reviewed: false,
          reviewedAt: null,
          reviewId: null,
        },
      ]
  return {
    number: input.number,
    repo: input.repo,
    viewer: input.viewer,
    snapshots: pruneReviewSnapshots(snapshots),
    first:
      log?.first ??
      ({ headOid, at: input.now, commits: input.commits } satisfies ReviewFirstObservation),
    updatedAt: input.now,
  }
}

function emptyLog(input: {
  number: number
  repo: string
  viewer: string
  comparison: ReviewComparison
  now: string
}): ReviewSnapshotLog {
  return {
    number: input.number,
    repo: input.repo,
    viewer: input.viewer,
    snapshots: [],
    first: { headOid: '', at: input.now, commits: null },
    updatedAt: input.now,
  }
}

/**
 * Bounds the history without taking a reviewed head.
 *
 * The newest unreviewed entries are the ones a reviewer can still choose as the
 * starting point of a comparison, so they are kept first; a reviewed head is
 * kept whatever its age, because it is the anchor the "changes since reviewed"
 * shortcut is built from and losing it would move that anchor silently. When
 * there are more reviewed heads than the bound allows, the oldest of those go
 * too: a head nobody can reach from the workspace is not a user-visible anchor,
 * and the file still has to be bounded.
 */
export function pruneReviewSnapshots(snapshots: readonly ReviewSnapshot[]): ReviewSnapshot[] {
  if (snapshots.length <= REVIEW_SNAPSHOTS_MAX) return [...snapshots]
  const newestHead = snapshots[snapshots.length - 1]
  const latestReviewed = reviewedSnapshot({ snapshots } as ReviewSnapshotLog)

  const protectedOids = new Set<string>()
  if (newestHead) protectedOids.add(newestHead.headOid)
  if (latestReviewed) protectedOids.add(latestReviewed.headOid)

  const remainingBudget = Math.max(0, REVIEW_SNAPSHOTS_MAX - protectedOids.size)
  const candidates = [...snapshots]
    .reverse()
    .filter((entry) => !protectedOids.has(entry.headOid))
    .slice(0, remainingBudget)

  const keptOids = new Set([...protectedOids, ...candidates.map((c) => c.headOid)])
  return snapshots.filter((entry) => keptOids.has(entry.headOid))
}

/** Records that GitHub confirmed this account's review of this head. */
export function withReviewedSnapshot(
  log: ReviewSnapshotLog,
  headOid: string,
  reviewId: string | null,
  now: string,
): ReviewSnapshotLog {
  if (!log.snapshots.some((entry) => entry.headOid === headOid)) return log
  return {
    ...log,
    snapshots: log.snapshots.map((entry) =>
      entry.headOid === headOid
        ? { ...entry, reviewed: true, reviewedAt: now, reviewId }
        : entry,
    ),
    updatedAt: now,
  }
}

/** The observed head with this object id, or null when the journal does not hold it. */
export function snapshotByOid(
  log: ReviewSnapshotLog | null,
  headOid: string,
): ReviewSnapshot | null {
  return log?.snapshots.find((entry) => entry.headOid === headOid) ?? null
}

/** The head this account most recently confirmed a review for, or null when it never has. */
export function reviewedSnapshot(log: ReviewSnapshotLog | null): ReviewSnapshot | null {
  if (!log || log.snapshots.length === 0) return null
  let latestReviewed: ReviewSnapshot | null = null
  let latestTime = -Infinity
  for (const entry of log.snapshots) {
    if (!entry.reviewed) continue
    const entryTime = entry.reviewedAt ? Date.parse(entry.reviewedAt) : 0
    if (latestReviewed === null || entryTime >= latestTime) {
      latestReviewed = entry
      latestTime = entryTime
    }
  }
  return latestReviewed
}
/** The newest head this account observed, or null when it has observed none. */
export function latestSnapshot(log: ReviewSnapshotLog | null): ReviewSnapshot | null {
  return log?.snapshots[log.snapshots.length - 1] ?? null
}

/**
 * What the app did not see when it first opened this pull request.
 *
 * A head is only an observation of *that* commit, and GitHub counts the commits
 * a pull request holds. If the first read already found more than one, then
 * commits before the first observed head existed without this app watching them,
 * and no amount of later reading recovers them. Saying so is the difference
 * between an update history and an implied promise of a complete one. A pull
 * request that held one commit when it was first opened makes no such claim,
 * because nothing is known to have come before it.
 */
export function reviewHistoryGap(log: ReviewSnapshotLog | null): ReviewHistoryGap | null {
  if (!log || log.first.headOid === '') return null
  const head = log.first.headOid.slice(0, 7)
  const commitClause =
    log.first.commits !== null && log.first.commits > 0
      ? ` when GitHub counted ${log.first.commits} commit${log.first.commits === 1 ? '' : 's'}`
      : ''
  return {
    headOid: log.first.headOid,
    at: log.first.at,
    commits: log.first.commits,
    message:
      `This app first opened #${log.number} at ${head} on ${log.first.at.slice(0, 10)}${commitClause}. ` +
      'Heads updated before this session were not observed by Git Stacks, ' +
      'so a comparison from earlier revisions is not available.',
  }
}

/** The gap and the two anchors the workspace offers, from one journal read. */
export function reviewHistoryOf(
  number: number,
  current: ReviewComparison,
  log: ReviewSnapshotLog | null,
): ReviewHistory {
  return {
    number,
    current,
    snapshots: log?.snapshots ?? [],
    reviewed: reviewedSnapshot(log),
    latest: latestSnapshot(log),
    gap: reviewHistoryGap(log),
  }
}

/**
 * The pull request's own files that did not change between the two heads.
 *
 * The current file list is everything the pull request changes against its base;
 * the comparison between the chosen head and the current head is everything that
 * moved between the two of them. A file in the first list and absent from the
 * second is unchanged between the two endpoints, and this reports its path.
 *
 * When GitHub declined to inline every differing file (truncated is set), the
 * answer is empty: a partial list cannot prove that any file was untouched, and
 * pretending it does would hide files a reviewer needs to see.
 */
export function reviewHistoryUnchangedPaths(
  current: ReviewFileSet | null,
  diff: ReviewHistoryDiff | null,
): string[] {
  if (!current || !diff || diff.state !== 'files' || diff.truncated) return []
  const changedBetween = new Set<string>()
  for (const file of diff.files) {
    changedBetween.add(file.path)
    if (file.previousPath) changedBetween.add(file.previousPath)
  }
  const unchanged: string[] = []
  for (const file of current.files) {
    if (!changedBetween.has(file.path) && (!file.previousPath || !changedBetween.has(file.previousPath))) {
      unchanged.push(file.path)
    }
  }
  return unchanged
}

/** A snapshot named the way a reviewer would speak it. */
export function reviewSnapshotLabel(snapshot: ReviewSnapshot): string {
  const short = snapshot.headOid.slice(0, 7)
  const when = snapshot.firstSeenAt.slice(0, 10)
  const role = snapshot.reviewed ? 'reviewed' : 'seen'
  const seen = snapshot.observations > 1 ? ` · seen ${snapshot.observations}×` : ''
  return `${short} (${role} ${when}${seen})`
}
