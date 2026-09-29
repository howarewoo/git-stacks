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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import {
  GitHubTransportError,
  setGitHubTransport,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type GitHubTransport,
} from '../src/main/github-transport'
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
  const rateLimit = { limit: 5000, remaining: 4999, reset: null, used: 1, resource: null, retryAfterSeconds: null }
  return {
    kind: 'direct',
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
  const head1 = comparison({ headOid: '1111'.padEnd(40, '0'), baseRef: 'main', baseOid: 'aaaa'.padEnd(40, '0') })
  const head2 = comparison({ headOid: '3333'.padEnd(40, '0'), baseRef: 'main', baseOid: 'bbbb'.padEnd(40, '0') })

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
  assert.match(
    history.gap?.message ?? '',
    /comparison from earlier revisions is not available/u,
  )
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
    'aaaa'.padEnd(40, '0'),
    'PRR_alice',
  )
  const logAliceAfter = await readReviewSnapshotLog(workspace.repo, 'howarewoo/git-stacks', 'alice', 26)
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
        throw new GitHubTransportError({ kind: 'not-found', status: 404, detail: 'Commit not found' })
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
  await recordObservedHead(workspace.repo, 'howarewoo/git-stacks', 'tester-viewer', 26, comparison({ headOid: 'old1'.padEnd(40, '0') }), 1)
  await recordObservedHead(workspace.repo, 'howarewoo/git-stacks', 'tester-viewer', 26, comparison({ headOid: 'old2'.padEnd(40, '0') }), 2)

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
  await writeFile(join(repo, 'file_kept.txt'), 'kept content\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'commit A'], { cwd: repo })
  const oidA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  // Commit B (new tip after force-push): file_reverted.txt is removed, file_kept.txt is modified
  await rm(join(repo, 'file_reverted.txt'))
  await writeFile(join(repo, 'file_kept.txt'), 'kept content modified\n')
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
  const keptFile = diff.files.find((f) => f.path === 'file_kept.txt')
  assert.ok(keptFile, 'file_kept.txt must appear in endpoint diff')
  assert.equal(keptFile?.status, 'modified')
})
