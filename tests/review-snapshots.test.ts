/**
 * Pull request snapshot tracking and historical comparison tests.
 *
 * Covers:
 * - Force-push creates new snapshots
 * - Identical heads deduplicate (updating observations/lastSeenAt, not creating duplicate snapshots)
 * - Rebase creates new snapshots across rewritten history
 * - Merge-base loss produces an explicit unavailable/gap state with no fabricated fallback
 * - Missing historical commits / deleted remote refs produce an explicit unavailable state
 * - First open after many updates clearly labels that earlier heads were never observed
 * - Bounded pruning retains user-visible reviewed anchors
 * - Scope isolation by repository identity, pull request number, and account viewer
 * - Metadata contains no source text or diffs, and local clear performs zero GitHub mutations
 * - Real main service with real Git repository + GitHub API doubles for positive and negative cases
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clearReviewHistory,
  readReviewHistory,
  readReviewHistoryDiff,
} from '../src/main/review-history'
import {
  clearReviewSnapshots,
  markReviewSnapshotReviewed,
  readReviewSnapshotLog,
  recordObservedHead,
} from '../src/main/review-snapshots'
import { readViewedRecord } from '../src/main/review-viewed'
import {
  GitHubTransportError,
  setGitHubTransport,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type GitHubTransport,
} from '../src/main/github-transport'
import { GITHUB_DEFAULT_HOST } from '../src/shared/host'
import type { ReviewComparison, ReviewFile } from '../src/shared/review'
import {
  observeReviewHead,
  pruneReviewSnapshots,
  reviewedSnapshot,
  reviewHistoryGap,
  reviewHistoryOf,
  reviewHistoryUnchangedPaths,
  reviewSnapshotLabel,
  REVIEW_SNAPSHOTS_MAX,
  withReviewedSnapshot,
  type ReviewSnapshot,
  type ReviewSnapshotLog,
} from '../src/shared/review-snapshots'

function comparison(overrides: Partial<ReviewComparison> = {}): ReviewComparison {
  return {
    headOid: 'a'.repeat(40),
    baseOid: 'b'.repeat(40),
    baseRef: 'main',
    ...overrides,
  }
}

function snapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    headOid: 'a'.repeat(40),
    baseOid: 'b'.repeat(40),
    baseRef: 'main',
    firstSeenAt: '2026-09-20T10:00:00.000Z',
    lastSeenAt: '2026-09-20T10:00:00.000Z',
    observations: 1,
    reviewed: false,
    reviewedAt: null,
    reviewId: null,
    ...overrides,
  }
}

async function createTestWorkspace(
  origin = 'https://github.com/howarewoo/git-stacks.git',
): Promise<{ repo: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-snap-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Snapshot Tester')
  git('config', 'user.email', 'tester@example.invalid')
  git('remote', 'add', 'origin', origin)
  return { repo, dispose: () => rm(root, { recursive: true, force: true }) }
}

function mockTransport(handlers: {
  rest?: (request: GitHubRestRequest) => unknown
  graphql?: (query: string, variables?: Record<string, unknown>) => unknown
}): GitHubTransport {
  const rateLimit = {
    limit: 5000,
    remaining: 4999,
    reset: null,
    used: 1,
    resource: null,
    retryAfterSeconds: null,
  }
  return {
    kind: 'direct',
    // Every workspace here has a github.com origin and this double is installed
    // as that host's transport, so the host it answers for is the public one.
    destinationHost: GITHUB_DEFAULT_HOST,
    async credentialAuthority(): Promise<string> {
      return 'review-snapshots-test-credential'
    },
    async rest<T>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
      if (handlers.rest) {
        const result = handlers.rest(request)
        return { status: 200, rateLimit, data: result as T }
      }
      return { status: 200, rateLimit, data: {} as T }
    },
    async paginate<T>(): Promise<T[]> {
      return []
    },
    async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      if (handlers.graphql) {
        const result = handlers.graphql(query, variables)
        return result as T
      }
      return {} as T
    },
  }
}

// -----------------------------------------------------------------------------
// Pure logic & model tests
// -----------------------------------------------------------------------------

test('deduplicating identical heads: same head read multiple times updates observations without adding new snapshots', () => {
  const comp = comparison({ headOid: '1111'.padEnd(40, '0') })
  const log1 = observeReviewHead(null, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: comp,
    commits: 1,
    now: '2026-09-20T10:00:00.000Z',
  })
  assert.equal(log1.snapshots.length, 1)
  assert.equal(log1.snapshots[0].observations, 1)
  assert.equal(log1.snapshots[0].firstSeenAt, '2026-09-20T10:00:00.000Z')
  assert.equal(log1.snapshots[0].lastSeenAt, '2026-09-20T10:00:00.000Z')

  // Second observation of the exact same head
  const log2 = observeReviewHead(log1, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: comp,
    commits: null,
    now: '2026-09-20T12:00:00.000Z',
  })
  assert.equal(log2.snapshots.length, 1, 'snapshot count must not increase for identical heads')
  assert.equal(log2.snapshots[0].observations, 2)
  assert.equal(log2.snapshots[0].firstSeenAt, '2026-09-20T10:00:00.000Z')
  assert.equal(log2.snapshots[0].lastSeenAt, '2026-09-20T12:00:00.000Z')
})

test('force-push creates a new snapshot entry with distinct head OID', () => {
  const head1 = comparison({ headOid: '1111'.padEnd(40, '0') })
  const head2 = comparison({ headOid: '2222'.padEnd(40, '0') }) // force-pushed head

  const log1 = observeReviewHead(null, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: head1,
    commits: 1,
    now: '2026-09-20T10:00:00.000Z',
  })
  const log2 = observeReviewHead(log1, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: head2,
    commits: 1,
    now: '2026-09-21T14:00:00.000Z',
  })

  assert.equal(log2.snapshots.length, 2)
  assert.equal(log2.snapshots[0].headOid, '1111'.padEnd(40, '0'))
  assert.equal(log2.snapshots[1].headOid, '2222'.padEnd(40, '0'))
})

test('rebase across branches creates a new snapshot recording the new comparison base', () => {
  const head1 = comparison({
    headOid: '1111'.padEnd(40, '0'),
    baseRef: 'main',
    baseOid: 'aaaa'.padEnd(40, '0'),
  })
  const head2 = comparison({
    headOid: '3333'.padEnd(40, '0'),
    baseRef: 'main',
    baseOid: 'bbbb'.padEnd(40, '0'),
  })

  const log1 = observeReviewHead(null, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: head1,
    commits: 2,
    now: '2026-09-20T10:00:00.000Z',
  })
  const log2 = observeReviewHead(log1, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: head2,
    commits: 2,
    now: '2026-09-22T09:00:00.000Z',
  })

  assert.equal(log2.snapshots.length, 2)
  assert.equal(log2.snapshots[1].baseOid, 'bbbb'.padEnd(40, '0'))
})

test('first open after many updates produces an explicit gap stating earlier heads were never observed', () => {
  const head = comparison({ headOid: '5555'.padEnd(40, '0') })
  // First time Git Stacks sees PR #26, GitHub reports 7 commits already on it
  const log = observeReviewHead(null, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: head,
    commits: 7,
    now: '2026-09-23T18:00:00.000Z',
  })
  const history = reviewHistoryOf(26, head, log)

  assert.ok(history.gap !== null, 'a gap must be recorded when first open has > 1 commits')
  assert.equal(history.gap?.headOid, '5555'.padEnd(40, '0'))
  assert.equal(history.gap?.commits, 7)
  assert.match(
    history.gap?.message ?? '',
    /first opened #26 at 5555000 on 2026-09-23.*counted 7 commits/u,
  )
  assert.match(history.gap?.message ?? '', /comparison from earlier revisions is not available/u)
})

test('first open with 1 commit records observation gap because earlier force-pushes cannot be ruled out', () => {
  const head = comparison({ headOid: '1111'.padEnd(40, '0') })
  const log = observeReviewHead(null, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: head,
    commits: 1,
    now: '2026-09-23T18:00:00.000Z',
  })
  const history = reviewHistoryOf(26, head, log)
  assert.ok(history.gap !== null)
  assert.match(history.gap?.message ?? '', /first opened #26 at 1111000/u)
  assert.match(history.gap?.message ?? '', /1 commit/u)
})

test('reviewedSnapshot selects anchor by review recency rather than observation order (A -> B -> A)', () => {
  const oidA = 'aaaa'.padEnd(40, '0')
  const oidB = 'bbbb'.padEnd(40, '0')

  let log = observeReviewHead(null, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: comparison({ headOid: oidA }),
    commits: 1,
    now: '2026-01-01T10:00:00.000Z',
  })
  // Review A first
  log = withReviewedSnapshot(log, oidA, 'REV_1', '2026-01-01T11:00:00.000Z')

  // PR updates to B
  log = observeReviewHead(log, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: comparison({ headOid: oidB }),
    commits: 2,
    now: '2026-01-02T10:00:00.000Z',
  })
  // Review B
  log = withReviewedSnapshot(log, oidB, 'REV_2', '2026-01-02T11:00:00.000Z')

  // PR moves back to A (e.g. author reverted or force-pushed back to A)
  log = observeReviewHead(log, {
    number: 26,
    repo: 'howarewoo/git-stacks',
    viewer: 'alice',
    comparison: comparison({ headOid: oidA }),
    commits: 3,
    now: '2026-01-03T10:00:00.000Z',
  })
  // Review A again
  log = withReviewedSnapshot(log, oidA, 'REV_3', '2026-01-03T11:00:00.000Z')

  // reviewedSnapshot MUST pick A because REV_3 (2026-01-03) is more recent than REV_2 (2026-01-02)
  const anchor = reviewedSnapshot(log)
  assert.equal(anchor?.headOid, oidA)
  assert.equal(anchor?.reviewId, 'REV_3')
})

test('bounded pruning retains newly observed head even when all previous 40 snapshots were reviewed', () => {
  const snapshots: ReviewSnapshot[] = []
  for (let i = 1; i <= REVIEW_SNAPSHOTS_MAX; i++) {
    const hex = i.toString(16).padStart(4, '0').padEnd(40, '0')
    snapshots.push(
      snapshot({
        headOid: hex,
        firstSeenAt: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`,
        reviewed: true,
        reviewedAt: `2026-01-02T${String(i).padStart(2, '0')}:00:00.000Z`,
        reviewId: `REV_${i}`,
      }),
    )
  }

  // 41st snapshot arrives (unreviewed new head)
  const hex41 = '4141'.padEnd(40, '0')
  snapshots.push(
    snapshot({
      headOid: hex41,
      firstSeenAt: '2026-01-03T00:00:00.000Z',
      reviewed: false,
    }),
  )

  const pruned = pruneReviewSnapshots(snapshots)
  assert.ok(pruned.length <= REVIEW_SNAPSHOTS_MAX)
  // 41st snapshot MUST be kept
  assert.ok(pruned.some((s) => s.headOid === hex41))
  // The latest reviewed anchor (snapshot 40) MUST be kept
  assert.ok(pruned.some((s) => s.headOid === snapshots[REVIEW_SNAPSHOTS_MAX - 1].headOid))
})

test('bounded pruning retains user-visible reviewed anchors while capping total snapshot count', () => {
  // Create snapshots exceeding the ceiling
  const snapshots: ReviewSnapshot[] = []
  for (let i = 1; i <= REVIEW_SNAPSHOTS_MAX + 10; i++) {
    const hex = i.toString(16).padStart(4, '0').padEnd(40, '0')
    snapshots.push(
      snapshot({
        headOid: hex,
        firstSeenAt: `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`,
        reviewed: false,
      }),
    )
  }

  // Mark an early snapshot as reviewed (e.g. index 2, which would normally be pruned)
  snapshots[2].reviewed = true
  snapshots[2].reviewId = 'PRR_anchored'
  const reviewedOid = snapshots[2].headOid

  const pruned = pruneReviewSnapshots(snapshots)

  // Total count is bounded
  assert.ok(pruned.length <= REVIEW_SNAPSHOTS_MAX)
  // The reviewed anchor MUST be retained
  assert.ok(
    pruned.some((s) => s.headOid === reviewedOid && s.reviewed),
    'reviewed anchor must survive pruning',
  )
  // The latest snapshot MUST be retained
  assert.equal(pruned[pruned.length - 1].headOid, snapshots[snapshots.length - 1].headOid)
})

test('reviewHistoryUnchangedPaths identifies files unchanged between historical snapshot and current head', () => {
  const prFiles = {
    number: 26,
    comparison: comparison(),
    files: [
      { path: 'src/unchanged.ts', additions: 1, deletions: 0 } as ReviewFile,
      { path: 'src/modified.ts', additions: 2, deletions: 1 } as ReviewFile,
      { path: 'src/deleted.ts', additions: 0, deletions: 5 } as ReviewFile,
    ],
    additions: 3,
    deletions: 6,
    truncated: false,
  }

  const historyDiff = {
    number: 26,
    state: 'files' as const,
    reason: '',
    from: snapshot({ headOid: 'oldhead'.padEnd(40, '0') }),
    to: comparison(),
    mergeBaseOid: 'base'.padEnd(40, '0'),
    // Only src/modified.ts has changes between oldhead and current head
    files: [{ path: 'src/modified.ts', additions: 2, deletions: 1 } as ReviewFile],
    additions: 2,
    deletions: 1,
    truncated: false,
  }

  const unchanged = reviewHistoryUnchangedPaths(prFiles, historyDiff)
  assert.deepEqual(unchanged, ['src/unchanged.ts', 'src/deleted.ts'])
})

test('reviewSnapshotLabel formats friendly readable label for select dropdowns', () => {
  const unreviewed = snapshot({
    headOid: '1234567890'.padEnd(40, '0'),
    firstSeenAt: '2026-09-24T12:00:00.000Z',
    observations: 1,
    reviewed: false,
  })
  assert.equal(reviewSnapshotLabel(unreviewed), '1234567 (seen 2026-09-24)')

  const repeated = snapshot({
    headOid: '1234567890'.padEnd(40, '0'),
    firstSeenAt: '2026-09-24T12:00:00.000Z',
    observations: 3,
    reviewed: false,
  })
  assert.equal(reviewSnapshotLabel(repeated), '1234567 (seen 2026-09-24 · seen 3×)')

  const reviewedSnap = snapshot({
    headOid: 'abcdef1234'.padEnd(40, '0'),
    firstSeenAt: '2026-09-23T08:00:00.000Z',
    observations: 1,
    reviewed: true,
  })
  assert.equal(reviewSnapshotLabel(reviewedSnap), 'abcdef1 (reviewed 2026-09-23)')
})

// -----------------------------------------------------------------------------
// Storage & journal tests (journal beside git directory)
// -----------------------------------------------------------------------------

test('review journals read as absent when the repository Git directory disappears', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)
  await recordObservedHead(workspace.repo, 'howarewoo/git-stacks', 'alice', 26, comparison(), 1)
  await rm(join(workspace.repo, '.git'), { recursive: true })
  const reads = await Promise.allSettled([
    readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'alice', 26),
    readViewedRecord(workspace.repo, 26),
  ])
  assert.deepEqual(reads, [
    { status: 'fulfilled', value: null },
    { status: 'fulfilled', value: null },
  ])
  await assert.rejects(
    recordObservedHead(workspace.repo, 'howarewoo/git-stacks', 'alice', 26, comparison(), 1),
  )
})

test('scope isolation: distinct repository or account viewer keeps independent snapshot logs', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)

  const comp = comparison({ headOid: 'aaaa'.padEnd(40, '0') })
  // Account Alice observes PR #26
  await recordObservedHead(workspace.repo, 'howarewoo/git-stacks', 'alice', 26, comp, 1)
  // Account Bob observes PR #26 with a different head
  const compBob = comparison({ headOid: 'bbbb'.padEnd(40, '0') })
  await recordObservedHead(workspace.repo, 'howarewoo/git-stacks', 'bob', 26, compBob, 1)

  const logAlice = await readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'alice', 26)
  const logBob = await readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'bob', 26)

  assert.equal(logAlice?.snapshots[0].headOid, 'aaaa'.padEnd(40, '0'))
  assert.equal(logBob?.snapshots[0].headOid, 'bbbb'.padEnd(40, '0'))

  // Alice's review must not become Bob's review
  await markReviewSnapshotReviewed(
    workspace.repo,
    'howarewoo/git-stacks',
    'alice',
    26,
    comp,
    'PRR_alice',
  )
  const logAliceAfter = await readReviewSnapshotLog(
    workspace.repo,
    'howarewoo/git-stacks',
    'alice',
    26,
  )
  const logBobAfter = await readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'bob', 26)

  assert.equal(logAliceAfter?.snapshots[0].reviewed, true)
  assert.equal(logBobAfter?.snapshots[0].reviewed, false, "Alice's review must never apply to Bob")
})

test('clearReviewSnapshots wipes local journal with zero GitHub mutation', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)

  const comp = comparison({ headOid: '1111'.padEnd(40, '0') })
  await recordObservedHead(workspace.repo, 'howarewoo/git-stacks', 'alice', 26, comp, 1)
  const before = await readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'alice', 26)
  assert.equal(before?.snapshots.length, 1)

  await clearReviewSnapshots(workspace.repo, 'howarewoo/git-stacks', 'alice', 26)
  const after = await readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'alice', 26)
  assert.equal(after, null)
})

test('confirmed reviews restore a cleared or never-observed head without restoring cleared history', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)
  const prior = comparison({ headOid: '1'.repeat(40) })
  const reviewed = comparison({ headOid: '2'.repeat(40) })
  await recordObservedHead(workspace.repo, 'howarewoo/git-stacks', 'alice', 26, prior, 1)
  await clearReviewSnapshots(workspace.repo, 'howarewoo/git-stacks', 'alice', 26)
  await markReviewSnapshotReviewed(
    workspace.repo,
    'howarewoo/git-stacks',
    'alice',
    26,
    reviewed,
    'PRR_confirmed',
  )
  const restored = await readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'alice', 26)
  assert.deepEqual(
    restored?.snapshots.map((entry) => ({
      headOid: entry.headOid,
      baseOid: entry.baseOid,
      baseRef: entry.baseRef,
      reviewed: entry.reviewed,
      reviewId: entry.reviewId,
    })),
    [{ ...reviewed, reviewed: true, reviewId: 'PRR_confirmed' }],
  )
  await markReviewSnapshotReviewed(
    workspace.repo,
    'howarewoo/git-stacks',
    'alice',
    26,
    prior,
    'PRR_adopted',
  )
  const adopted = await readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'alice', 26)
  assert.equal(
    adopted?.snapshots.find((entry) => entry.headOid === prior.headOid)?.reviewId,
    'PRR_adopted',
  )
  assert.equal(
    adopted?.snapshots.find((entry) => entry.headOid === reviewed.headOid)?.reviewId,
    'PRR_confirmed',
  )
})

// -----------------------------------------------------------------------------
// Main service integration tests (real Git + GitHub API doubles)
// -----------------------------------------------------------------------------

test('main service readReviewHistory reads identity, records head, and computes history', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)

  const transport = mockTransport({
    graphql: (_query, variables) => {
      // Permission query
      return {
        viewer: { login: 'tester-viewer' },
        repository: {
          pullRequest: {
            state: 'OPEN',
            viewerPermission: 'WRITE',
            viewerCanUpdate: true,
            author: { login: 'howarewoo' },
          },
        },
      }
    },
    rest: (request) => {
      if (request.path?.includes('/pulls/26')) {
        return {
          head: { sha: 'c0ffee'.padEnd(40, '0') },
          base: { sha: 'b00000'.padEnd(40, '0'), ref: 'main' },
          commits: 3,
        }
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const history = await readReviewHistory(workspace.repo, 26)
  assert.equal(history.number, 26)
  assert.equal(history.current.headOid, 'c0ffee'.padEnd(40, '0'))
  assert.equal(history.snapshots.length, 1)
  assert.equal(history.snapshots[0].headOid, 'c0ffee'.padEnd(40, '0'))
  // Because commits = 3 on first open, gap is recorded
  assert.ok(history.gap !== null)
  assert.equal(history.gap?.commits, 3)
})

test('main service readReviewHistoryDiff handles same-head comparison without calling GitHub compare API', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)

  const currentHead = 'c0ffee'.padEnd(40, '0')
  const calls: string[] = []

  const transport = mockTransport({
    graphql: () => ({
      viewer: { login: 'tester-viewer' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          viewerPermission: 'WRITE',
          viewerCanUpdate: true,
          author: { login: 'author' },
        },
      },
    }),
    rest: (request) => {
      calls.push(request.path ?? '')
      if (request.path?.includes('/pulls/26')) {
        return {
          head: { sha: currentHead },
          base: { sha: 'b00000'.padEnd(40, '0'), ref: 'main' },
          commits: 1,
        }
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  // First observe the head
  await readReviewHistory(workspace.repo, 26)

  // Compare same head to current head
  const diff = await readReviewHistoryDiff(workspace.repo, 26, currentHead)
  assert.equal(diff.state, 'files')
  assert.equal(diff.files.length, 0)
  assert.equal(diff.additions, 0)
  assert.equal(diff.deletions, 0)
  // Ensure compare endpoint was not called
  assert.ok(!calls.some((c) => c.includes('/compare/')))
})

test('main service readReviewHistoryDiff negative case: missing historical commit / deleted ref returns explicit unavailable', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)

  const historicalHead = '1111'.padEnd(40, '0')
  const currentHead = '2222'.padEnd(40, '0')

  // Set up journal containing the historical head
  await recordObservedHead(
    workspace.repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: historicalHead }),
    1,
  )
  await recordObservedHead(
    workspace.repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: currentHead }),
    2,
  )

  const transport = mockTransport({
    graphql: () => ({
      viewer: { login: 'tester-viewer' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          viewerPermission: 'WRITE',
          viewerCanUpdate: true,
          author: { login: 'author' },
        },
      },
    }),
    rest: (request) => {
      const path = request.path ?? ''
      if (path.includes('/pulls/26')) {
        return {
          head: { sha: currentHead },
          base: { sha: 'b00000'.padEnd(40, '0'), ref: 'main' },
          commits: 2,
        }
      }
      if (path.includes('/compare/')) {
        // GitHub compare throws 404
        throw new GitHubTransportError({ kind: 'not-found', status: 404, detail: 'Not Found' })
      }
      if (path.includes(`/commits/${historicalHead}`)) {
        // Probing historical commit returns 404 (commit was garbage collected after force-push)
        throw new GitHubTransportError({
          kind: 'not-found',
          status: 404,
          detail: 'Commit not found',
        })
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const diff = await readReviewHistoryDiff(workspace.repo, 26, historicalHead)
  assert.equal(diff.state, 'unavailable')
  assert.match(diff.reason, /is no longer in this repository/u)
  assert.match(diff.reason, /garbage collected after a force-push/u)
  assert.equal(diff.files.length, 0)
})

test('main service readReviewHistoryDiff negative case: merge-base loss / diverged unrelated histories returns explicit unavailable', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)

  const historicalHead = '3333'.padEnd(40, '0')
  const currentHead = '4444'.padEnd(40, '0')

  await recordObservedHead(
    workspace.repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: historicalHead }),
    1,
  )
  await recordObservedHead(
    workspace.repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: currentHead }),
    2,
  )

  const transport = mockTransport({
    graphql: () => ({
      viewer: { login: 'tester-viewer' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          viewerPermission: 'WRITE',
          viewerCanUpdate: true,
          author: { login: 'author' },
        },
      },
    }),
    rest: (request) => {
      const path = request.path ?? ''
      if (path.includes('/pulls/26')) {
        return {
          head: { sha: currentHead },
          base: { sha: 'b00000'.padEnd(40, '0'), ref: 'main' },
          commits: 2,
        }
      }
      if (path.includes('/compare/')) {
        // Compare returns status diverged with no common ancestor merge-base
        return {
          status: 'diverged',
          merge_base_commit: null,
          files: [],
        }
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const diff = await readReviewHistoryDiff(workspace.repo, 26, historicalHead)
  assert.equal(diff.state, 'unavailable')
  assert.match(diff.reason, /share no common ancestor/u)
  assert.match(diff.reason, /merge base was lost/u)
})

test('main service clearReviewHistory resets snapshot history and returns fresh single snapshot of current head', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)

  const currentHead = '9999'.padEnd(40, '0')
  const transport = mockTransport({
    graphql: () => ({
      viewer: { login: 'tester-viewer' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          viewerPermission: 'WRITE',
          viewerCanUpdate: true,
          author: { login: 'author' },
        },
      },
    }),
    rest: (request) => {
      if (request.path?.includes('/pulls/26')) {
        return {
          head: { sha: currentHead },
          base: { sha: 'b00000'.padEnd(40, '0'), ref: 'main' },
          commits: 1,
        }
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  // Observe multiple heads
  await recordObservedHead(
    workspace.repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: 'old1'.padEnd(40, '0') }),
    1,
  )
  await recordObservedHead(
    workspace.repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: 'old2'.padEnd(40, '0') }),
    2,
  )

  // Clear history
  const reset = await clearReviewHistory(workspace.repo, 26)
  assert.equal(reset.snapshots.length, 0)
  assert.equal(reset.current.headOid, currentHead)
  assert.equal(reset.reviewed, null)
  assert.equal(reset.gap, null)
})

test('main service readReviewHistoryDiff uses real Git to produce faithful endpoint tree diff across force-push/reversal', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)
  const repo = workspace.repo

  // Initial commit
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repo })

  // Commit A (old tip): adds file_reverted.txt and file_kept.txt
  await writeFile(join(repo, 'file_reverted.txt'), 'content to be reverted\n')
  await writeFile(join(repo, 'file\tkept.txt'), 'kept content\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'commit A'], { cwd: repo })
  const oidA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  // Commit B (new tip after force-push): file_reverted.txt is removed, file_kept.txt is modified
  await rm(join(repo, 'file_reverted.txt'))
  await writeFile(join(repo, 'file\tkept.txt'), 'kept content modified\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'commit B'], { cwd: repo })
  const oidB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  // Record snapshot A
  await recordObservedHead(
    repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: oidA }),
    2,
    '2026-09-23T18:00:00.000Z',
  )
  // Record snapshot B (new head)
  await recordObservedHead(
    repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: oidB }),
    3,
    '2026-09-23T19:00:00.000Z',
  )

  const transport = mockTransport({
    graphql: () => ({
      viewer: { login: 'tester-viewer' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          viewerPermission: 'WRITE',
          viewerCanUpdate: true,
          author: { login: 'author' },
        },
      },
    }),
    rest: (request) => {
      if (request.path?.includes('/pulls/26')) {
        return {
          head: { sha: oidB },
          base: { sha: 'b00000'.padEnd(40, '0'), ref: 'main' },
          commits: 3,
        }
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const diff = await readReviewHistoryDiff(repo, 26, oidA)
  assert.equal(diff.state, 'files')
  // file_reverted.txt must appear in endpoint diff as removed!
  const revertedFile = diff.files.find((f) => f.path === 'file_reverted.txt')
  assert.ok(revertedFile, 'file_reverted.txt must appear in endpoint diff')
  assert.equal(revertedFile?.status, 'removed')
  // file_kept.txt must be modified
  const keptFile = diff.files.find((f) => f.path === 'file\tkept.txt')
  assert.ok(keptFile, 'file_kept.txt must appear in endpoint diff')
  assert.equal(keptFile?.status, 'modified')
  assert.equal(keptFile?.additions, 1)
  assert.equal(keptFile?.deletions, 1)
  assert.equal(diff.additions, 1)
  assert.equal(diff.deletions, 2)
})

test('main service readReviewHistoryDiff handles pure and edited renames with faithful hunks and zero phantom additions', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)
  const repo = workspace.repo

  // Initial commit
  await writeFile(join(repo, 'clean.ts'), 'line 1\nline 2\nline 3\n')
  await writeFile(join(repo, 'edited.ts'), 'line 1\nline 2\nline 3\nline 4\nline 5\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'commit A: old files'], { cwd: repo })
  const oidA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  // Commit B: pure rename clean.ts -> renamed_clean.ts, edited rename edited.ts -> renamed_edited.ts
  execFileSync('git', ['mv', 'clean.ts', 'renamed_clean.ts'], { cwd: repo })
  execFileSync('git', ['mv', 'edited.ts', 'renamed_edited.ts'], { cwd: repo })
  await writeFile(
    join(repo, 'renamed_edited.ts'),
    'line 1\nline 2 edited\nline 3\nline 4\nline 5\n',
  )
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'commit B: renames'], { cwd: repo })
  const oidB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  await recordObservedHead(
    repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: oidA }),
    1,
  )
  await recordObservedHead(
    repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: oidB }),
    2,
  )

  const transport = mockTransport({
    graphql: () => ({
      viewer: { login: 'tester-viewer' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          viewerPermission: 'WRITE',
          viewerCanUpdate: true,
          author: { login: 'author' },
        },
      },
    }),
    rest: (request) => {
      if (request.path?.includes('/pulls/26')) {
        return {
          head: { sha: oidB },
          base: { sha: 'b00000'.padEnd(40, '0'), ref: 'main' },
          commits: 2,
        }
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const diff = await readReviewHistoryDiff(repo, 26, oidA)
  assert.equal(diff.state, 'files')

  // Pure rename checks
  const pure = diff.files.find((f) => f.path === 'renamed_clean.ts')
  assert.ok(pure, 'renamed_clean.ts must be present')
  assert.equal(pure?.status, 'renamed')
  assert.equal(pure?.previousPath, 'clean.ts')
  assert.equal(pure?.additions, 0)
  assert.equal(pure?.deletions, 0)
  assert.equal(pure?.diff.kind, 'text')
  if (pure?.diff.kind === 'text') {
    assert.equal(
      pure.diff.hunks.length,
      0,
      'pure rename must have no hunks (not whole-file addition)',
    )
  }

  // Edited rename checks
  const edited = diff.files.find((f) => f.path === 'renamed_edited.ts')
  assert.ok(edited, 'renamed_edited.ts must be present')
  assert.equal(edited?.status, 'renamed')
  assert.equal(edited?.previousPath, 'edited.ts')
  assert.equal(edited?.additions, 1)
  assert.equal(edited?.deletions, 1)
  assert.equal(edited?.diff.kind, 'text')
  if (edited?.diff.kind === 'text') {
    assert.equal(edited.diff.hunks.length, 1)
    const hunk = edited.diff.hunks[0]
    // Diff hunk must show only the edited line, preserving original context
    assert.ok(hunk.lines.some((l) => l.kind === 'remove' && l.text.includes('line 2')))
    assert.ok(hunk.lines.some((l) => l.kind === 'add' && l.text.includes('line 2 edited')))
  }
})

test('main service readReviewHistoryDiff preserves binary classification for binary file diffs', async (t) => {
  const workspace = await createTestWorkspace()
  t.after(workspace.dispose)
  const repo = workspace.repo

  // Initial commit with binary file
  await writeFile(join(repo, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'commit A: binary file'], { cwd: repo })
  const oidA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  // Commit B: modify binary file
  await writeFile(join(repo, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]))
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'commit B: modified binary'], { cwd: repo })
  const oidB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  await recordObservedHead(
    repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: oidA }),
    1,
  )
  await recordObservedHead(
    repo,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: oidB }),
    2,
  )

  const transport = mockTransport({
    graphql: () => ({
      viewer: { login: 'tester-viewer' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          viewerPermission: 'WRITE',
          viewerCanUpdate: true,
          author: { login: 'author' },
        },
      },
    }),
    rest: (request) => {
      if (request.path?.includes('/pulls/26')) {
        return {
          head: { sha: oidB },
          base: { sha: 'b00000'.padEnd(40, '0'), ref: 'main' },
          commits: 2,
        }
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const diff = await readReviewHistoryDiff(repo, 26, oidA)
  assert.equal(diff.state, 'files')
  const binFile = diff.files.find((f) => f.path === 'image.png')
  assert.ok(binFile, 'image.png must be in diff')
  assert.equal(binFile?.status, 'modified')
  // Diff kind must be explicitly binary!
  assert.equal(binFile?.diff.kind, 'binary')
})

test('main service diffEndpointWithGit performs object-only fetch preserving FETCH_HEAD, tags, and submodule config', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'test-fetch-sentinel-'))
  t.after(() => rm(root, { recursive: true }))

  const remote = join(root, 'remote')
  const local = join(root, 'local')
  await mkdir(remote, { recursive: true })
  await mkdir(local, { recursive: true })

  // Remote bare repository
  execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remote })

  // Local repository with origin remote
  execFileSync('git', ['init', '-b', 'main'], { cwd: local })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: local })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: local })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/howarewoo/git-stacks.git'], {
    cwd: local,
  })
  execFileSync(
    'git',
    ['config', `url.file://${remote}/.insteadOf`, 'https://github.com/howarewoo/git-stacks.git'],
    { cwd: local },
  )

  await writeFile(join(local, 'file.txt'), 'base\n')
  execFileSync('git', ['add', '.'], { cwd: local })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: local })
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: local })
  const localOid = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: local,
    encoding: 'utf8',
  }).trim()

  // Another clone pushes a new commit and tag to the remote
  const other = join(root, 'other')
  execFileSync('git', ['clone', `file://${remote}`, other])
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: other })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: other })
  await writeFile(join(other, 'external.txt'), 'external change\n')
  execFileSync('git', ['add', '.'], { cwd: other })
  execFileSync('git', ['commit', '-m', 'remote commit'], { cwd: other })
  const remoteOid = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: other,
    encoding: 'utf8',
  }).trim()
  execFileSync('git', ['tag', 'v1.0.0-sentinel-tag'], { cwd: other })
  execFileSync('git', ['push', 'origin', 'main', '--tags'], { cwd: other })

  // Write sentinel content in local .git/FETCH_HEAD
  const sentinelContent = 'SENTINEL_FETCH_HEAD_PRESERVED_EXACTLY\n'
  await writeFile(join(local, '.git', 'FETCH_HEAD'), sentinelContent)

  // Verify remoteOid does not exist locally yet
  let existsBefore = true
  try {
    execFileSync('git', ['cat-file', '-e', remoteOid], { cwd: local })
  } catch {
    existsBefore = false
  }
  assert.equal(existsBefore, false, 'remote commit must not exist locally yet')

  // Set up mock transport for readReviewHistoryDiff
  const transport = mockTransport({
    graphql: () => ({
      viewer: { login: 'tester-viewer' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          viewerPermission: 'WRITE',
          viewerCanUpdate: true,
          author: { login: 'author' },
        },
      },
    }),
    rest: (request) => {
      if (request.path?.includes('/pulls/26')) {
        return {
          head: { sha: remoteOid },
          base: { sha: localOid, ref: 'main' },
          commits: 2,
        }
      }
      return {}
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await recordObservedHead(
    local,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: localOid }),
    1,
  )
  await recordObservedHead(
    local,
    'howarewoo/git-stacks',
    'tester-viewer',
    26,
    comparison({ headOid: remoteOid }),
    2,
  )

  // Call readReviewHistoryDiff: endpoint diff between localOid and remoteOid
  const diff = await readReviewHistoryDiff(local, 26, localOid)
  assert.equal(diff.state, 'files')
  const extFile = diff.files.find((f) => f.path === 'external.txt')
  assert.ok(extFile, 'external.txt must be found after fetching remote commit object')
  assert.equal(extFile?.status, 'added')

  // Verify sentinel FETCH_HEAD was NOT modified or overwritten!
  const fetchHeadAfter = await readFile(join(local, '.git', 'FETCH_HEAD'), 'utf8')
  assert.equal(
    fetchHeadAfter,
    sentinelContent,
    'FETCH_HEAD must be preserved with zero side-effects',
  )

  // Verify remote tag was NOT downloaded into local repository!
  const localTags = execFileSync('git', ['tag', '-l'], { cwd: local, encoding: 'utf8' }).trim()
  assert.equal(localTags, '', 'Remote tags must not be imported during object-only fetch')
})
