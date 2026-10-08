import type {
  Branch,
  PullRequest,
  FileView,
  RecentRepository,
  RepositorySnapshot,
  FileHunks,
  HunkSide,
  Stash,
} from '../../../src/shared/types'
import {
  blockedRestackPreview,
  failedMergeStatus,
  openPullRequest,
  pausedRestackProgress,
  restackPreview,
  standardCapabilities,
} from '../../fixtures/workflow-scenarios'
import {
  changedFile,
  conflictedChanges,
  fileViewFixtures,
  largeDiffText,
  longDiffText,
  pullRequestFixtures,
  stashFixtures,
  stagedOnlyChanges,
  unstagedOnlyChanges,
} from '../../../src/renderer/src/design-system/data-fixtures'
import { EMPTY_SNAPSHOT_LIMITS } from '../../../src/shared/performance'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { NotificationInbox } from '../../../src/shared/notifications'
import {
  deriveCheckRollup,
  summariseChecks,
  type PullRequestCheckDetail,
  type PullRequestCheckState,
  type PullRequestChecksReport,
} from '../../../src/shared/pull-request-checks'
import {
  pullRequestInboxGroups,
  type PullRequestInboxItem,
  type PullRequestInboxRefresh,
  type PullRequestInboxReport,
  type PullRequestInboxRepositoryReport,
  type PullRequestInboxSignals,
} from '../../../src/shared/pr-inbox'
import type { GitHubCapabilityState } from '../../../src/shared/host'
import { githubComHostStatus, toolsAvailable, toolsMissingEditor } from './settings'
import type { FixtureScenario } from './types'
import type { ScenarioName } from './manifest'
import { reviewRail, stackMember } from './review'

/**
 * Deterministic snapshot data for every gallery scenario. Repository shapes are reused from
 * `tests/fixtures/workflow-scenarios.ts` and
 * `src/renderer/src/design-system/data-fixtures.ts`; only the ancestry and long-content
 * fixtures are built here, because no existing fixture covers those shapes.
 */

/** Stable 40-character object id from a seed, so screenshots never shift between runs. */
function oid(seed: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').repeat(5)
}

const EARLIEST = '2026-02-02T09:00:00.000Z'
const EARLIER = '2026-02-03T09:00:00.000Z'
const UPDATED = '2026-02-04T09:00:00.000Z'

type BranchSeed = Partial<Branch> & Pick<Branch, 'name'>

/** Local branch row with the same defaults `branchFromRef` produces in the main process. */
function local(seed: BranchSeed): Branch {
  return {
    ref: `refs/heads/${seed.name}`,
    current: false,
    remote: false,
    upstream: `origin/${seed.name}`,
    upstreamRef: `refs/remotes/origin/${seed.name}`,
    ahead: 0,
    behind: 0,
    subject: `Update ${seed.name}`,
    updatedAt: UPDATED,
    parent: null,
    parentBehind: 0,
    pr: null,
    oid: oid(`local:${seed.name}`),
    parentTip: null,
    parentSource: null,
    needsRestack: false,
    ...seed,
  }
}

/** Remote rows use the production `origin/<name>` naming that `branchFromRef` produces. */
function remote(shortName: string, seed: Partial<Branch> = {}): Branch {
  return {
    ref: `refs/remotes/origin/${shortName}`,
    name: `origin/${shortName}`,
    current: false,
    remote: true,
    upstream: null,
    upstreamRef: null,
    ahead: 0,
    behind: 0,
    subject: `Update ${shortName}`,
    updatedAt: UPDATED,
    parent: null,
    parentBehind: 0,
    pr: null,
    oid: oid(`remote:${shortName}`),
    parentTip: null,
    parentSource: null,
    needsRestack: false,
    ...seed,
  }
}

const mainBranch = local({
  name: 'main',
  updatedAt: EARLIEST,
  parent: null,
  parentBehind: null,
  subject: 'Bump the release notes',
})

const { body: _checkoutPrBody, ...checkoutPr } = openPullRequest

const checkoutBranch = local({
  name: 'feature/checkout',
  current: true,
  parent: 'main',
  parentTip: oid('local:main'),
  parentSource: 'recorded',
  ahead: 2,
  subject: 'Add checkout validation',
  updatedAt: EARLIER,
})

const checkoutTestsBranch = local({
  name: 'feature/checkout-tests',
  parent: 'feature/checkout',
  parentTip: oid('local:feature/checkout'),
  parentSource: 'recorded',
  subject: 'Cover checkout validation',
  pr: checkoutPr,
})

const INBOX_PATH = '/Users/ada/Code/git-stacks'
const SPECIMENS_PATH = '/Users/ada/Code/design-system-specimens'

const recentRepositories: RecentRepository[] = [
  { path: '/Users/ada/Code/git-stacks', name: 'git-stacks' },
  { path: SPECIMENS_PATH, name: 'design-system-specimens' },
  {
    path: '/Users/ada/Code/work/git-stacks-workbench-fixture-with-a-long-directory-name',
    name: 'git-stacks-workbench-fixture-with-a-long-directory-name',
  },
]

/** A three-layer native stack whose pull requests the review rail can order. */
const reviewStackPullRequests: PullRequest[] = [
  {
    number: 41,
    title: 'Read pull request files over the transport',
    url: 'https://github.com/howarewoo/git-stacks/pull/41',
    head: 'feature/review-41',
    base: 'main',
    state: 'OPEN',
    draft: false,
    checks: 'passing',
    headOid: '4141414141414141414141414141414141414141',
    reviewDecision: 'APPROVED',
    stack: {
      stackNumber: 42,
      position: 1,
      size: 3,
      base: 'main',
      open: true,
      url: 'https://github.com/howarewoo/git-stacks/stacks/42',
    },
  },
  {
    number: 42,
    title: 'Give the review workspace its own cancellation ids',
    url: 'https://github.com/howarewoo/git-stacks/pull/42',
    head: 'feature/review-42',
    base: 'feature/review-41',
    state: 'OPEN',
    draft: false,
    checks: 'pending',
    headOid: '4242424242424242424242424242424242424242',
    reviewDecision: 'REVIEW_REQUIRED',
    stack: {
      stackNumber: 42,
      position: 2,
      size: 3,
      base: 'feature/review-41',
      open: true,
      url: 'https://github.com/howarewoo/git-stacks/stacks/42',
    },
  },
  {
    number: 43,
    title: 'Keep the review line anchors stable across a force-push',
    url: 'https://github.com/howarewoo/git-stacks/pull/43',
    head: 'feature/review-43',
    base: 'feature/review-42',
    state: 'OPEN',
    draft: true,
    checks: 'failing',
    headOid: '4343434343434343434343434343434343434343',
    stack: {
      stackNumber: 42,
      position: 3,
      size: 3,
      base: 'feature/review-42',
      open: true,
      url: 'https://github.com/howarewoo/git-stacks/stacks/42',
    },
  },
]

const reviewStackBranches: Branch[] = reviewStackPullRequests.map((pr) =>
  local({ name: pr.head, parent: pr.base, parentTip: oid(`local:${pr.base}`), pr }),
)

const longReviewStackPullRequests: PullRequest[] = Array.from({ length: 40 }, (_, index) => ({
  ...reviewStackPullRequests[index % 3],
  number: 101 + index,
  title:
    index === 35
      ? 'Keep the selected late layer reachable while reviewing a deliberately long title with repository transport, cancellation, and independently unknown readiness metadata'
      : `Layer ${index + 1}: bounded native review context`,
  url: `https://github.com/howarewoo/git-stacks/pull/${101 + index}`,
  head: `feature/long-review-${index + 1}`,
  base: index === 0 ? 'main' : `feature/long-review-${index}`,
  headOid: oid(`long-review-${index + 1}`),
  state: index === 0 ? 'MERGED' : index === 1 ? 'CLOSED' : 'OPEN',
  stack: {
    stackNumber: 42,
    position: index + 1,
    size: 40,
    base: 'main',
    open: true,
    url: 'https://github.com/howarewoo/git-stacks/stacks/42',
  },
}))

const longReviewStackBranches = longReviewStackPullRequests.map((pr) =>
  local({ name: pr.head, parent: pr.base, parentTip: oid(`local:${pr.base}`), pr }),
)

function nativeReviewFixture(pullRequests: PullRequest[]) {
  const rail = reviewRail(
    pullRequests[0],
    pullRequests.map((pr) => ({
      ...stackMember(pr.stack?.position ?? 1, pr.number, pr.stack?.size ?? pullRequests.length),
      head: pr.head,
      headSha: pr.headOid,
      base: pr.base,
      state: pr.state,
      draft: pr.draft,
    })),
  )
  return rail.stack ? [rail.stack] : []
}

/** Repository with the connected branch set; scenarios override only what they exercise. */
function repository(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    path: '/Users/ada/Code/git-stacks',
    name: 'git-stacks',
    currentBranch: 'feature/checkout',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:howarewoo/git-stacks.git',
    branches: [mainBranch, checkoutBranch, checkoutTestsBranch],
    pullRequests: [checkoutPr],
    files: [],
    stashes: [],
    rebaseInProgress: false,
    operation: null,
    stackOperation: null,
    headOid: checkoutBranch.oid ?? null,
    github: { available: true, message: 'GitHub metadata available; 1 pull request' },
    capabilities: standardCapabilities,
    limits: EMPTY_SNAPSHOT_LIMITS,
    ...overrides,
  }
}

/** Connected baseline: one stacked branch with a draft pull request and a clean tree. */
const connected = repository()

/** Both stacked branches are behind their recorded parent, so restack and publish stay open. */
const restackBase = repository({
  branches: [
    mainBranch,
    local({
      name: 'feature/checkout',
      current: true,
      parent: 'main',
      parentTip: oid('local:main-before-merge'),
      parentSource: 'recorded',
      parentBehind: 3,
      needsRestack: true,
      ahead: 2,
      behind: 1,
      subject: 'Add checkout validation',
      updatedAt: EARLIER,
    }),
    local({
      name: 'feature/checkout-tests',
      parent: 'feature/checkout',
      parentTip: oid('local:feature/checkout-before-restack'),
      parentSource: 'recorded',
      parentBehind: 3,
      needsRestack: true,
      pr: checkoutPr,
      subject: 'Cover checkout validation',
    }),
  ],
  headOid: oid('local:feature/checkout-before-restack'),
})

const linearBranches: Branch[] = [
  mainBranch,
  local({ name: 'feature/linear-one', parent: 'main', parentTip: oid('local:main') }),
  local({
    name: 'feature/linear-two',
    parent: 'feature/linear-one',
    parentTip: oid('local:feature/linear-one'),
  }),
  local({
    name: 'feature/linear-three',
    current: true,
    parent: 'feature/linear-two',
    parentTip: oid('local:feature/linear-two'),
    ahead: 1,
  }),
]

const branchingBranches: Branch[] = [
  mainBranch,
  local({ name: 'feature/fork-base', parent: 'main', parentTip: oid('local:main') }),
  local({
    name: 'feature/fork-left',
    current: true,
    parent: 'feature/fork-base',
    parentTip: oid('local:feature/fork-base'),
    ahead: 1,
  }),
  local({
    name: 'feature/fork-left-hotfix',
    parent: 'feature/fork-left',
    parentTip: oid('local:feature/fork-left'),
  }),
  local({
    name: 'feature/fork-right',
    parent: 'feature/fork-base',
    parentTip: oid('local:feature/fork-base'),
  }),
  local({
    name: 'feature/fork-right-docs',
    parent: 'feature/fork-right',
    parentTip: oid('local:feature/fork-right'),
  }),
]

const deepBranches: Branch[] = [
  mainBranch,
  ...Array.from({ length: 6 }, (_, index) => {
    const depth = index + 1
    const parent = depth === 1 ? 'main' : `feature/deep-${depth - 1}`
    return local({
      name: `feature/deep-${depth}`,
      current: depth === 6,
      parent,
      parentTip: oid(`local:${parent}`),
      ahead: depth === 6 ? 1 : 0,
      updatedAt: new Date(Date.UTC(2026, 1, 10 - depth)).toISOString(),
    })
  }),
]

/** Remote twins of tracked local branches are consolidated away; one remote-only row remains. */
const consolidatedBranches: Branch[] = [
  mainBranch,
  local({
    name: 'feature/consolidated-a',
    parent: 'main',
    parentTip: oid('local:main'),
    behind: 2,
  }),
  remote('feature/consolidated-a', { parent: 'feature/consolidated-a', updatedAt: EARLIER }),
  local({
    name: 'feature/consolidated-b',
    current: true,
    parent: 'feature/consolidated-a',
    parentTip: oid('local:feature/consolidated-a'),
    ahead: 1,
  }),
  remote('feature/consolidated-b', { parent: 'feature/consolidated-b', updatedAt: UPDATED }),
  remote('feature/remote-only', {
    parent: 'feature/consolidated-a',
    behind: 4,
    subject: 'Remote-only branch without a local counterpart',
  }),
]

const missingParentBranches: Branch[] = [
  mainBranch,
  local({
    name: 'feature/orphan',
    current: true,
    parent: 'feature/deleted-parent',
    parentTip: oid('local:deleted-parent'),
    parentSource: 'recorded',
    needsRestack: true,
    ahead: 1,
    subject: 'Branch whose recorded parent is no longer present',
  }),
]

const cycleBranches: Branch[] = [
  mainBranch,
  local({
    name: 'feature/cycle-a',
    current: true,
    parent: 'feature/cycle-b',
    parentTip: oid('local:feature/cycle-b'),
  }),
  local({
    name: 'feature/cycle-b',
    parent: 'feature/cycle-a',
    parentTip: oid('local:feature/cycle-a'),
  }),
]

const longBranchName = 'feature/a-very-long-branch-name-used-for-inspector-layout-checks'

const longContent = repository({
  path: '/Users/ada/Code/work/another-long-directory-name/git-stacks-workbench-fixture',
  name: 'git-stacks-workbench-fixture-with-a-deliberately-long-repository-name',
  currentBranch: longBranchName,
  branches: [
    mainBranch,
    local({
      name: longBranchName,
      current: true,
      parent: 'main',
      parentTip: oid('local:main'),
      ahead: 1,
      subject:
        'A deliberately long commit subject that must stay readable at the minimum window width and at 200% zoom without hiding the row actions',
    }),
  ],
  headOid: oid(`local:${longBranchName}`),
})

const untrackedPath = 'src/renderer/src/lib/pull-request-state.ts'
const renamedPath = 'src/renderer/src/components/legacy-views.tsx'
const truncatedPath = 'src/renderer/src/components/big-file.tsx'
const longLinePath = 'src/renderer/src/components/data-views-with-long-lines.tsx'
const bulkPath = 'src/renderer/src/components/bulk-generated-surface.tsx'

const nothingStaged: HunkSide = { hunks: [], unavailable: 'Nothing is staged in this file yet.' }
const untrackedHunks: FileHunks = {
  staged: {
    hunks: [],
    unavailable:
      'An untracked file is staged as a whole file; there is no index hunk to apply yet.',
  },
  unstaged: {
    hunks: [],
    unavailable:
      'An untracked file is staged as a whole file; there is no index hunk to apply yet.',
  },
}
const unreadableDiff: HunkSide = {
  hunks: [],
  unavailable: 'This diff could not be read safely; stage or unstage the whole file instead.',
}
/** The hunks `longDiffText` parses into, so the inspector renders the real shape. */
const longDiffHunks: HunkSide = {
  hunks: [
    {
      id: 'long-line-hunk-1',
      header: '@@ -120,6 +120,7 @@ .changes-columns {',
      oldStart: 120,
      oldLines: 6,
      newStart: 120,
      newLines: 7,
      lines: [
        { kind: 'context', text: '   display: grid;', oldLine: 120, newLine: 120 },
        { kind: 'remove', text: '-  gap: 15px;', oldLine: 121, newLine: null },
        { kind: 'add', text: '+  gap: 16px;', oldLine: null, newLine: 121 },
        {
          kind: 'add',
          text: '+  border: 1px solid var(--gs-semantic-border-essential);',
          oldLine: null,
          newLine: 122,
        },
        { kind: 'context', text: '   overflow: auto;', oldLine: 122, newLine: 123 },
        { kind: 'add', text: `+${'x'.repeat(400)}`, oldLine: null, newLine: 124 },
      ],
    },
    {
      id: 'long-line-hunk-2',
      header: '@@ -240,3 +241,3 @@ .code-diff {',
      oldStart: 240,
      oldLines: 3,
      newStart: 241,
      newLines: 3,
      lines: [
        { kind: 'remove', text: '-  background: #fafbfc;', oldLine: 240, newLine: null },
        {
          kind: 'add',
          text: '+  background: var(--gs-semantic-surface-inset);',
          oldLine: null,
          newLine: 241,
        },
      ],
    },
  ],
  unavailable: null,
}

const longContentViews: Record<string, FileView> = {
  [longLinePath]: {
    path: longLinePath,
    stagedDiff: '',
    unstagedDiff: longDiffText,
    content: null,
    binary: false,
    fingerprint: 'fingerprint-long-line',
    conflicted: false,
    truncated: false,
    hunks: { staged: nothingStaged, unstaged: longDiffHunks },
  },
  [bulkPath]: {
    path: bulkPath,
    stagedDiff: '',
    unstagedDiff: largeDiffText,
    content: null,
    binary: false,
    fingerprint: 'fingerprint-bulk',
    conflicted: false,
    truncated: false,
    hunks: { staged: nothingStaged, unstaged: unreadableDiff },
  },
}

/** Same stash OIDs as `stash-stable-oid` at shifted indices, plus one newer stash. */
const shiftedStashes: Stash[] = [
  { ref: 'stash@{0}', oid: stashFixtures[1].oid, message: stashFixtures[1].message },
  { ref: 'stash@{1}', oid: stashFixtures[0].oid, message: stashFixtures[0].message },
  {
    ref: 'stash@{2}',
    oid: oid('stash:inspector-tabs-follow-up'),
    message: 'WIP on feature/checkout: inspector tab follow-up',
  },
]

/** The one open, mergeable pull request, reused by the merge read-back scenario. */
const lifecycleOpenBranch = local({
  name: 'feature/lifecycle-open',
  current: true,
  parent: 'main',
  parentTip: oid('local:main'),
  ahead: 1,
  pr: pullRequestFixtures[0],
  subject: 'Open pull request branch',
})

const lifecycleBranches: Branch[] = [
  mainBranch,
  local({
    name: 'feature/lifecycle-draft',
    parent: 'main',
    parentTip: oid('local:main'),
    pr: pullRequestFixtures[1],
    subject: 'Draft pull request branch',
  }),
  lifecycleOpenBranch,
  local({
    name: 'feature/lifecycle-closed',
    parent: 'main',
    parentTip: oid('local:main'),
    pr: pullRequestFixtures[2],
    subject: 'Closed pull request branch',
  }),
  local({
    name: 'feature/lifecycle-merged',
    parent: 'main',
    parentTip: oid('local:main'),
    pr: pullRequestFixtures[3],
    subject: 'Merged pull request branch',
  }),
]

const unavailableGithub = {
  available: false,
  message: 'GitHub CLI is not authenticated for this repository.',
}

const checksBranch = local({
  name: 'feature/lifecycle-open',
  current: true,
  parent: 'main',
  parentTip: oid('local:main'),
  ahead: 3,
  pr: pullRequestFixtures[0],
  subject: 'Split the file inspector',
})

/** Builds a report the way the main process does, so the fixture cannot drift from it. */
function checksReport(
  checks: PullRequestCheckDetail[],
  overrides: Partial<PullRequestChecksReport> = {},
): PullRequestChecksReport {
  return {
    number: 42,
    headSha: oid('local:feature/lifecycle-open'),
    base: 'main',
    available: true,
    message: '',
    checks,
    rollup: deriveCheckRollup(checks),
    summary: summariseChecks(checks),
    fetchedAt: UPDATED,
    checkedAt: UPDATED,
    freshness: 'live',
    staleReason: null,
    rateLimit: { remaining: 4871, reset: UPDATED },
    nextAttemptAt: null,
    permissions: { actionsEnabled: true, canRerun: true, reason: '', isAdmin: true },
    truncated: false,
    ...overrides,
  }
}

/**
 * The report a pull request that names no checks of its own answers with, taken
 * from the snapshot that is on screen.
 *
 * Every branch row and pull request list the app renders already declares the
 * state it is showing, so the read that follows has to answer with that same
 * state. Returning nothing instead makes a background refresh of every ordinary
 * scenario fail, which is a statement about the fixture and not about the code
 * under test.
 *
 * The snapshot is named by the caller rather than assumed: a pull request
 * reached by opening another repository belongs to that repository, and reading
 * its checks out of the repository the fixture started with would answer with
 * another pull request's facts — or with none at all. A scenario's own
 * `pullRequestChecks` still wins, so a scenario that states an override for a
 * number keeps stating it.
 */
export function checksReportFor(
  scenario: FixtureScenario,
  number: number,
  snapshot: RepositorySnapshot | null,
): PullRequestChecksReport | null {
  const stated = scenario.pullRequestChecks?.[number]
  if (stated) return stated
  const pullRequest = [
    ...(snapshot?.pullRequests ?? []),
    ...(snapshot?.branches ?? []).flatMap((branch) => (branch.pr ? [branch.pr] : [])),
  ].find((entry) => entry.number === number)
  if (!pullRequest) return null
  const state: PullRequestCheckState =
    pullRequest.checks === 'failing'
      ? 'failure'
      : pullRequest.checks === 'pending'
        ? 'in-progress'
        : 'success'
  return checksReport(
    pullRequest.checks === 'none' ? [] : [check({ key: 'check-run:default', name: 'ci', state })],
    {
      number,
      headSha: pullRequest.headOid ?? '',
      base: pullRequest.base ?? 'main',
    },
  )
}

function check(
  overrides: Partial<PullRequestCheckDetail> & Pick<PullRequestCheckDetail, 'key' | 'name'>,
): PullRequestCheckDetail {
  return {
    source: 'check-run',
    app: null,
    appId: null,
    state: 'success',
    requirement: 'informational',
    summary: null,
    detailsUrl: null,
    startedAt: EARLIER,
    completedAt: UPDATED,
    workflowRunId: null,
    expected: false,
    ...overrides,
  }
}

/** One required failure, one optional failure, a running workflow, and a silent required check. */
const mixedChecksReport = checksReport([
  check({
    key: 'check-run:8101',
    name: 'build',
    app: 'github-actions',
    appId: 15368,
    state: 'failure',
    requirement: 'required',
    summary: '2 annotations on the build job',
    detailsUrl: 'https://github.com/howarewoo/git-stacks/runs/8101',
    workflowRunId: 8101,
  }),
  check({
    key: 'check-run:8102',
    name: 'super-linter',
    app: 'super-linter',
    appId: 1,
    state: 'action-required',
    summary: 'Fix the reported issues before merging',
  }),
  check({
    key: 'commit-status:vercel/preview',
    name: 'vercel/preview',
    source: 'commit-status',
    state: 'in-progress',
    summary: 'Building preview',
  }),
  check({
    key: 'expected:audit',
    name: 'audit',
    source: 'expected',
    state: 'waiting',
    requirement: 'required',
    summary: 'Expected: waiting for this check to report',
    startedAt: null,
    completedAt: null,
    expected: true,
  }),
])

const staleChecksReport = checksReport(
  [
    check({
      key: 'check-run:8201',
      name: 'build',
      app: 'github-actions',
      state: 'failure',
      requirement: 'required',
      summary: '1 annotation on the build job',
      workflowRunId: 8201,
    }),
    check({ key: 'check-run:8202', name: 'test', app: 'github-actions', state: 'success' }),
  ],
  {
    freshness: 'stale',
    staleReason: "Checks could not be refreshed: GitHub's rate limit was reached",
    checkedAt: EARLIER,
    nextAttemptAt: UPDATED,
    permissions: {
      actionsEnabled: true,
      canRerun: false,
      reason: 'Your role on this repository cannot run workflows, so rerun is unavailable.',
      isAdmin: false,
    },
  },
)

/** Comfortably past the point where revealing a second page starts sliding. */
const DEEP_CHAIN_LENGTH = 620

// A chain long enough that the branch list slides its mounted window: the first
// two reveals mount one then two pages, and every later reveal slides. The
// keyboard contract has to hold on the third page, not just the first.
const deepChainBranches: Branch[] = [
  mainBranch,
  ...Array.from({ length: DEEP_CHAIN_LENGTH - 1 }, (_, index) =>
    local({
      name: `feature/deep-${String(index + 1).padStart(4, '0')}`,
      parent: index === 0 ? 'main' : `feature/deep-${String(index).padStart(4, '0')}`,
      subject: `Deep change ${index + 1}`,
      updatedAt: new Date(Date.parse(UPDATED) - (DEEP_CHAIN_LENGTH - index) * 60_000).toISOString(),
    }),
  ),
]

const deepChainSnapshot = repository({
  branches: deepChainBranches,
  headOid: oid('local:feature/deep-0001'),
})

/**
 * The PR Inbox queue fixtures. Group membership is decided by the production rules
 * over fixed GitHub facts, so a scenario's group counts are the same numbers the
 * main process would report for the same rows rather than a second opinion.
 */
const INBOX_NOW = Date.parse(UPDATED)
const INBOX_VIEWER = 'ada'

/**
 * What this host answers about the review and check fields the queue reads.
 *
 * The queue reads them over GraphQL, so a host that does not serve GraphQL
 * cannot return them at all. One declaration therefore produces both fixtures
 * below — the complete rows and the narrowed ones — and the repository report
 * that goes with each, so a scenario cannot show a complete read of one
 * repository beside a degraded read of the same host.
 */
const INBOX_HOST_REVIEW_FIELDS: GitHubCapabilityState = 'supported'
const INBOX_HOST_WITHOUT_REVIEW_FIELDS: GitHubCapabilityState = 'unsupported'
const inboxMetadata = (graphql: GitHubCapabilityState): PullRequestInboxItem['metadata'] =>
  graphql === 'supported' ? 'full' : 'degraded'

function inboxRow(
  overrides: Partial<PullRequestInboxSignals> & {
    number: number
    repository?: string
    repositoryPath?: string
    title: string
    head?: string
    checks?: PullRequest['checks']
    /** The account this read was made as; null when the host named none. */
    viewer?: string | null
  },
): PullRequestInboxItem {
  const {
    number,
    repository = 'howarewoo/git-stacks',
    repositoryPath = '/Users/ada/Code/git-stacks',
    title,
    head = `feature/inbox-${number}`,
    viewer = INBOX_VIEWER,
    checks = 'passing',
    ...signals
  } = overrides
  const facts: PullRequestInboxSignals = {
    state: 'OPEN',
    draft: false,
    author: 'grace',
    reviewRequested: [],
    reviewDecision: null,
    lastTurnLogin: null,
    updatedAt: number === 81 ? '2026-02-04T10:00:00.000Z' : UPDATED,
    mergedAt: null,
    metadata: inboxMetadata(INBOX_HOST_REVIEW_FIELDS),
    ...signals,
  }
  return {
    number,
    title,
    repository,
    repositoryPath,
    host: 'github.com',
    url: `https://github.com/${repository}/pull/${number}`,
    head,
    base: 'main',
    state: facts.state,
    draft: facts.draft,
    checks,
    author: facts.author,
    reviewRequested: facts.reviewRequested,
    reviewRequestsComplete: true,
    reviewDecision: facts.reviewDecision,
    lastTurnLogin: facts.lastTurnLogin,
    metadata: facts.metadata,
    changeSize:
      facts.metadata === 'degraded'
        ? { state: 'unsupported' }
        : { state: 'known', value: number === 81 ? 120 : number === 77 ? 240 : 0 },
    unresolvedThreads:
      facts.metadata === 'degraded'
        ? { state: 'unsupported' }
        : number === 77
          ? { state: 'truncated', value: 3 }
          : { state: 'known', value: 0 },
    updatedAt: facts.updatedAt,
    mergedAt: facts.mergedAt,
    groups: pullRequestInboxGroups(facts, { viewer, now: INBOX_NOW }),
  }
}

const inboxRows: PullRequestInboxItem[] = [
  inboxRow({
    number: 81,
    title: 'Add a GitHub-derived PR Inbox across registered repositories',
    head: 'feature/pr-inbox',
    reviewRequested: [INBOX_VIEWER],
    reviewDecision: 'REVIEW_REQUIRED',
  }),
  inboxRow({
    number: 77,
    title: 'Charge every native-stack page to the refresh budget',
    head: 'feature/inbox-budget',
    // The second registered repository, which really is one: opening this row
    // opens that repository rather than the one already showing.
    repository: 'howarewoo/design-system-specimens',
    repositoryPath: SPECIMENS_PATH,
    reviewRequested: [INBOX_VIEWER],
    checks: 'failing',
    // The same decision its Review snapshot states. One pull request has one
    // review decision: a row that reported none while its Review reported one
    // would change a fact about the pull request merely by opening it. The
    // degraded scenario below is where an unavailable decision belongs, and it
    // says so through its metadata instead.
    reviewDecision: 'REVIEW_REQUIRED',
  }),
  inboxRow({
    number: 64,
    title: 'Keep the Inbox rows an earlier account read off the screen',
    head: 'feature/inbox-identity',
    author: INBOX_VIEWER,
    reviewDecision: 'REVIEW_REQUIRED',
    lastTurnLogin: 'grace',
  }),
  inboxRow({
    number: 58,
    title: 'Name the repositories a refresh did not attempt',
    head: 'feature/inbox-partial',
    author: INBOX_VIEWER,
  }),
  inboxRow({
    number: 51,
    title: 'Sketch the Inbox group rail',
    head: 'feature/inbox-draft',
    draft: true,
    author: 'grace',
  }),
  inboxRow({
    number: 44,
    title: 'Land the first queue read',
    head: 'feature/inbox-merged',
    // A host that reports no author says that rather than naming one, so the
    // row has to carry a real absence here: naming a login for this one would
    // leave the fallback nothing to be exercised against.
    author: null,
    state: 'MERGED',
    mergedAt: UPDATED,
  }),
]

function inboxReport(
  repositories: PullRequestInboxRepositoryReport[],
  items: PullRequestInboxItem[],
  overrides: Partial<PullRequestInboxRefresh> = {},
): PullRequestInboxReport {
  return {
    refresh: {
      state: 'fresh',
      confirmedAt: UPDATED,
      checkedAt: UPDATED,
      viewer: INBOX_VIEWER,
      requests: 4,
      budget: { maxRequests: 24, reserve: 250 },
      repositories,
      truncated: [],
      detail: '2 registered repositories read.',
      ...overrides,
    },
    items,
    mergedWithinDays: 30,
  }
}

/**
 * The Inbox's own primary workspace.
 *
 * The generic `connected` snapshot is left alone for everything that is not the
 * queue: it is the fixture that selects pull request #41, and rewriting it to
 * carry the Inbox's rows would move every other destination's review. A queue
 * row is only real when opening it reaches a workspace that holds that pull
 * request, so the Inbox gets its own primary snapshot with the same facts its
 * rows are built from — same numbers, titles, refs, and check states.
 *
 * Its branches are the repository's own. Inheriting the generic set would leave
 * the checkout branch's #41 associated with this repository: selecting that
 * branch would then report a pull request the workspace does not hold, and the
 * review, the external link and the Checks read would all act on it. The branch
 * on screen is #81's own, with its head, because nothing here checked anything
 * out.
 */
const inboxPr81: PullRequest = {
  number: 81,
  title: 'Add a GitHub-derived PR Inbox across registered repositories',
  url: 'https://github.com/howarewoo/git-stacks/pull/81',
  head: 'feature/pr-inbox',
  base: 'main',
  state: 'OPEN',
  draft: false,
  checks: 'passing',
  headOid: '8181818181818181818181818181818181818181',
  reviewDecision: 'REVIEW_REQUIRED',
}

const inboxPrimarySnapshot: RepositorySnapshot = {
  ...repository({
    path: INBOX_PATH,
    name: 'git-stacks',
    currentBranch: 'feature/pr-inbox',
    branches: [
      mainBranch,
      local({
        name: 'feature/pr-inbox',
        current: true,
        parent: 'main',
        parentTip: oid('local:main'),
        parentSource: 'recorded',
        ahead: 2,
        subject: 'Add a GitHub-derived PR Inbox across registered repositories',
        updatedAt: UPDATED,
        pr: inboxPr81,
        oid: inboxPr81.headOid,
      }),
    ],
    headOid: inboxPr81.headOid,
  }),
  pullRequests: [
    inboxPr81,
    {
      number: 64,
      title: 'Keep the Inbox rows an earlier account read off the screen',
      url: 'https://github.com/howarewoo/git-stacks/pull/64',
      head: 'feature/inbox-identity',
      base: 'main',
      state: 'OPEN',
      draft: false,
      checks: 'passing',
      headOid: '6464646464646464646464646464646464646464',
      reviewDecision: 'REVIEW_REQUIRED',
    },
    {
      number: 58,
      title: 'Name the repositories a refresh did not attempt',
      url: 'https://github.com/howarewoo/git-stacks/pull/58',
      head: 'feature/inbox-partial',
      base: 'main',
      state: 'OPEN',
      draft: false,
      checks: 'passing',
      headOid: '5858585858585858585858585858585858585858',
      reviewDecision: '',
    },
    {
      number: 51,
      title: 'Sketch the Inbox group rail',
      url: 'https://github.com/howarewoo/git-stacks/pull/51',
      head: 'feature/inbox-draft',
      base: 'main',
      state: 'OPEN',
      draft: true,
      checks: 'passing',
      headOid: '5151515151515151515151515151515151515151',
      reviewDecision: '',
    },
    {
      number: 44,
      title: 'Land the first queue read',
      url: 'https://github.com/howarewoo/git-stacks/pull/44',
      head: 'feature/inbox-merged',
      base: 'main',
      state: 'MERGED',
      draft: false,
      checks: 'passing',
      headOid: '4444444444444444444444444444444444444444',
      reviewDecision: '',
    },
  ],
}

/**
 * The second registered repository's own workspace, with the pull request the
 * Inbox row #77 names. Opening that row opens this repository and this pull
 * request, so the destination is not a list of rows over one workspace. The
 * origin is the canonical one for the repository its row, its repository report,
 * and its Review facts all name.
 *
 * It carries no pull request but #77, on any branch: #41 belongs to the
 * repository whose branches the generic fixture builds, and a workspace that
 * listed it here would report another repository's review as this one's.
 */
const specimensPr77: PullRequest = {
  number: 77,
  title: 'Charge every native-stack page to the refresh budget',
  url: 'https://github.com/howarewoo/design-system-specimens/pull/77',
  head: 'feature/inbox-budget',
  base: 'main',
  state: 'OPEN',
  draft: false,
  checks: 'failing',
  headOid: '7777777777777777777777777777777777777777',
  reviewDecision: 'REVIEW_REQUIRED',
}

const specimensSnapshot: RepositorySnapshot = {
  ...repository({
    path: SPECIMENS_PATH,
    name: 'design-system-specimens',
    remoteUrl: 'git@github.com:howarewoo/design-system-specimens.git',
    currentBranch: 'feature/inbox-budget',
    branches: [
      mainBranch,
      local({
        name: 'feature/inbox-budget',
        current: true,
        parent: 'main',
        parentTip: oid('local:main'),
        parentSource: 'recorded',
        ahead: 1,
        subject: 'Charge every native-stack page to the refresh budget',
        updatedAt: UPDATED,
        pr: specimensPr77,
        oid: specimensPr77.headOid,
      }),
    ],
    headOid: specimensPr77.headOid,
  }),
  pullRequests: [specimensPr77],
}

const inboxSnapshots: Record<string, RepositorySnapshot> = {
  [INBOX_PATH]: inboxPrimarySnapshot,
  [SPECIMENS_PATH]: specimensSnapshot,
}

/**
 * The same rows as the full read, with the second repository's row carrying what
 * a narrowed read actually produces: no review decision, no check result, and
 * metadata marked unavailable. Its groups come from the same membership function
 * as every other row, so this scenario exercises the real supported-set rule
 * rather than a hand-written group list that could agree with the wrong one.
 */
const inboxDegradedRows: PullRequestInboxItem[] = inboxRows.map((row) =>
  row.repositoryPath === SPECIMENS_PATH
    ? inboxRow({
        number: row.number,
        title: row.title,
        repository: row.repository,
        repositoryPath: row.repositoryPath,
        head: row.head,
        reviewRequested: row.reviewRequested,
        metadata: inboxMetadata(INBOX_HOST_WITHOUT_REVIEW_FIELDS),
        checks: 'none',
        reviewDecision: null,
        lastTurnLogin: null,
      })
    : row,
)

const inboxRead: PullRequestInboxRepositoryReport[] = [
  {
    repository: 'howarewoo/git-stacks',
    path: '/Users/ada/Code/git-stacks',
    host: 'github.com',
    status: 'ok',
    viewer: INBOX_VIEWER,
    detail: '4 pull requests',
  },
  {
    repository: 'howarewoo/design-system-specimens',
    path: SPECIMENS_PATH,
    host: 'github.com',
    status: 'ok',
    viewer: INBOX_VIEWER,
    detail: '2 pull requests',
  },
]

const inboxNarrowedRead: PullRequestInboxRepositoryReport =
  inboxMetadata(INBOX_HOST_WITHOUT_REVIEW_FIELDS) === 'degraded'
    ? {
        repository: 'howarewoo/design-system-specimens',
        path: SPECIMENS_PATH,
        host: 'github.com',
        status: 'degraded',
        viewer: INBOX_VIEWER,
        detail: 'github.com does not report review decisions, the newest review, or check state.',
      }
    : (inboxRead[1] as PullRequestInboxRepositoryReport)

const inboxQueue = inboxReport(inboxRead, inboxRows)
const inboxLongTitle =
  'Keep repository identity stable while restoring a saved triage view across multiple registered repositories with long descriptive pull request titles and bounded optional metadata'
const inboxStructuredRows = inboxRows.map((row) =>
  row.number === 77
    ? {
        ...row,
        number: 81,
        title: inboxLongTitle,
        url: 'https://github.com/howarewoo/design-system-specimens/pull/81',
      }
    : row,
)
const inboxStructuredSpecimen = {
  ...specimensSnapshot,
  pullRequests: specimensSnapshot.pullRequests.map((pr) => ({
    ...pr,
    number: 81,
    title: inboxLongTitle,
    url: 'https://github.com/howarewoo/design-system-specimens/pull/81',
  })),
  branches: specimensSnapshot.branches.map((branch) =>
    branch.pr
      ? {
          ...branch,
          pr: {
            ...branch.pr,
            number: 81,
            title: inboxLongTitle,
            url: 'https://github.com/howarewoo/design-system-specimens/pull/81',
          },
        }
      : branch,
  ),
}
const inboxEmpty = inboxReport(
  [inboxRead[0]].filter((entry): entry is PullRequestInboxRepositoryReport => entry !== undefined),
  [],
  { requests: 2, detail: '1 registered repository read.' },
)
const inboxPartial = inboxReport(
  [inboxRead[0] as PullRequestInboxRepositoryReport, inboxNarrowedRead],
  inboxDegradedRows,
  { state: 'partial', confirmedAt: UPDATED, detail: 'Some repositories could not be read.' },
)

/**
 * The same read, the same rows, and no account behind them: the host named no
 * viewer this time. Authorship and a request to the viewer are then undecided
 * rather than false, so the membership function leaves every viewer-relative
 * group empty and the rows that do not depend on one keep their places. The
 * repository reports say why, which is the only thing that tells a person whose
 * work stopped being listed.
 */
const inboxMembershipUnknownRows: PullRequestInboxItem[] = inboxRows.map((row) =>
  inboxRow({
    number: row.number,
    title: row.title,
    repository: row.repository,
    repositoryPath: row.repositoryPath,
    head: row.head,
    state: row.state,
    draft: row.draft,
    checks: row.checks,
    author: row.author,
    reviewRequested: row.reviewRequested,
    reviewDecision: row.reviewDecision,
    lastTurnLogin: row.lastTurnLogin,
    updatedAt: row.updatedAt,
    mergedAt: row.mergedAt,
    metadata: row.metadata,
    viewer: null,
  }),
)

const inboxMembershipUnknownRead: PullRequestInboxRepositoryReport[] = inboxRead.map((entry) => ({
  ...entry,
  status: 'membership-unknown',
  viewer: null,
  detail:
    'github.com named no signed-in account for these rows, so the queue cannot say whose work they are.',
}))

const inboxMembershipUnknown = inboxReport(inboxMembershipUnknownRead, inboxMembershipUnknownRows, {
  state: 'partial',
  confirmedAt: UPDATED,
  viewer: null,
  detail: 'Some repositories could not be read.',
})

/**
 * The module's own state, kept apart from the pull request inbox: a host, an
 * account, a sealed reference, and the threads GitHub sent with their own
 * reasons. The reference is opaque, because the real one is.
 */
const notificationStatus = {
  host: 'github.com',
  state: 'ready' as const,
  enabled: true,
  policyDisabled: false,
  reference: 'keychain://git-stacks/notifications/octo',
  login: 'octo',
  store: { available: true, name: 'Keychain', reason: null },
  message: null,
  // A bulk change GitHub has accepted but not confirmed is the only thing that
  // sets this, so every scenario that is not that state says so explicitly.
  markAllReadPending: false,
}

const notificationThreads: NotificationInbox['threads'] = [
  {
    id: '101',
    unread: true,
    reason: 'review_requested',
    title: 'Tidy the stack ordering rules',
    url: 'https://github.com/acme/widgets/pull/101',
    kind: 'pull_request',
    repository: { owner: 'acme', name: 'widgets' },
    updatedAt: UPDATED,
  },
  {
    id: '102',
    unread: true,
    reason: 'mention',
    title: 'Mentioned in “Release checklist”',
    url: 'https://github.com/acme/widgets/issues/102',
    kind: 'issue',
    repository: { owner: 'acme', name: 'widgets' },
    updatedAt: EARLIER,
  },
  {
    id: '103',
    unread: false,
    reason: 'ci_activity',
    title: 'Checks failed on “Add checkout validation”',
    url: 'https://github.com/acme/widgets/pull/98',
    kind: 'pull_request',
    repository: { owner: 'acme', name: 'widgets' },
    updatedAt: EARLIER,
  },
]

/**
 * A module that is on and has no credential: nothing sealed, nothing polled,
 * and the authorization this window would offer. Scenarios that differ only in
 * what else is outstanding share it rather than repeating the same inbox.
 */
const awaitingCredential = (host = 'github.com'): NotificationInbox => ({
  ...notificationStatus,
  host,
  state: 'credential-missing',
  enabled: true,
  // No credential means no sealed reference to discard and no account it
  // was sealed for; a module in this state holds nothing.
  reference: null,
  login: null,
  threads: [],
  unreadCount: 0,
  poll: {
    fetchedAt: null,
    checkedAt: null,
    nextPollAt: null,
    pollIntervalSeconds: 60,
    lastModified: null,
    unchanged: false,
  },
  stale: false,
  staleReason: null,
})

/**
 * What GitHub serves this module once a credential exists: the live inbox the
 * ready scenario renders. Authorizing a module that had none moves it onto this,
 * because a stored credential is what turns the module into a live inbox at all.
 */
export function notificationInbox(overrides: Partial<NotificationInbox> = {}): NotificationInbox {
  return {
    ...notificationStatus,
    threads: notificationThreads,
    unreadCount: notificationThreads.filter((thread) => thread.unread).length,
    poll: {
      fetchedAt: UPDATED,
      checkedAt: UPDATED,
      nextPollAt: UPDATED,
      pollIntervalSeconds: 60,
      lastModified: 'Tue, 22 Sep 2026 09:41:07 GMT',
      unchanged: false,
    },
    stale: false,
    staleReason: null,
    markAllReadPending: false,
    ...overrides,
  }
}
export const scenarios: Record<ScenarioName, FixtureScenario> = {
  'shell-no-repository': {
    name: 'shell-no-repository',
    summary: 'Onboarding with recent repositories and no repository open.',
    snapshot: null,
    recentRepositories,
  },
  'github-cli-missing': {
    name: 'github-cli-missing',
    summary:
      'No GitHub CLI on this computer: GitHub work is unavailable and onboarding still offers local repositories.',
    snapshot: null,
    recentRepositories,
    githubCliStatus: {
      state: 'missing-cli',
      host: 'github.com',
      login: null,
      version: null,
      identity: null,
      message: 'No gh executable was found on PATH.',
    },
  },
  'github-cli-signed-out': {
    name: 'github-cli-signed-out',
    summary:
      'The GitHub CLI is installed but holds no account for this host, so discovery has nothing to read as.',
    snapshot: null,
    recentRepositories,
    githubCliStatus: {
      state: 'signed-out',
      host: 'github.com',
      login: null,
      version: '2.62.0',
      identity: null,
      message: 'No GitHub account is signed in for github.com.',
    },
  },
  'github-cli-authenticated': {
    name: 'github-cli-authenticated',
    summary:
      'An authenticated GitHub CLI account for github.com, with the version reported apart from the authentication.',
    snapshot: connected,
    recentRepositories,
    githubCliStatus: {
      state: 'authenticated',
      host: 'github.com',
      login: 'octo',
      version: '2.62.0',
      identity: 'cli:github.com:octo:1',
      message: null,
    },
  },
  'github-cli-discovery': {
    name: 'github-cli-discovery',
    summary:
      'No repository open and an authenticated GitHub CLI account, which is what discovery needs before it can read GitHub.',
    snapshot: null,
    recentRepositories,
    githubCliStatus: {
      state: 'authenticated',
      host: 'github.com',
      login: 'octo',
      version: '2.62.0',
      identity: 'cli:github.com:octo:1',
      message: null,
    },
  },
  'shell-loading': {
    name: 'shell-loading',
    summary: 'Boot reads never settle, so the shell keeps its loading state.',
    snapshot: connected,
    recentRepositories,
    pending: ['recentRepositories', 'openRepository'],
  },
  'shell-connected': {
    name: 'shell-connected',
    summary: 'Connected repository: stacked branches, one draft PR, clean tree.',
    snapshot: connected,
    recentRepositories,
    // No queue here. This scenario's repository is the one every other
    // destination is built around, and it holds pull request #41 — not the rows
    // the Inbox shows. A queue read here would advertise rows that open a
    // workspace which does not contain them, and every other destination's
    // capture would inherit that fiction. The Inbox is captured from
    // `pr-inbox-queue`, which owns the snapshots its rows open.
  },
  'shell-long-content': {
    name: 'shell-long-content',
    summary: 'Long repository path, branch name, and commit subject at minimum width.',
    snapshot: longContent,
    recentRepositories,
  },
  'shell-offline': {
    name: 'shell-offline',
    summary: 'Integration unavailable: pull request creation and publishing are disabled.',
    snapshot: repository({
      branches: [mainBranch, checkoutBranch, { ...checkoutTestsBranch, pr: null }],
      pullRequests: [],
      github: unavailableGithub,
    }),
    recentRepositories,
  },

  'ancestry-linear': {
    name: 'ancestry-linear',
    summary: 'Single-parent chain: main plus three stacked branches.',
    snapshot: repository({ branches: linearBranches, currentBranch: 'feature/linear-three' }),
    recentRepositories,
  },
  'ancestry-branching': {
    name: 'ancestry-branching',
    summary: 'Fork below feature/fork-base with one child on each lane.',
    snapshot: repository({ branches: branchingBranches, currentBranch: 'feature/fork-left' }),
    recentRepositories,
  },
  'ancestry-deep': {
    name: 'ancestry-deep',
    summary: 'Six-level stack for deep lane geometry and indentation.',
    snapshot: repository({ branches: deepBranches, currentBranch: 'feature/deep-6' }),
    recentRepositories,
  },
  'ancestry-remote-consolidated': {
    name: 'ancestry-remote-consolidated',
    summary: 'Remote twins consolidated into local rows plus one remote-only branch.',
    snapshot: repository({
      branches: consolidatedBranches,
      currentBranch: 'feature/consolidated-b',
    }),
    recentRepositories,
  },
  'ancestry-missing-parent': {
    name: 'ancestry-missing-parent',
    summary: 'Recorded parent is gone: parent-missing and requires-restack badges.',
    snapshot: repository({
      branches: missingParentBranches,
      currentBranch: 'feature/orphan',
    }),
    recentRepositories,
  },
  'ancestry-cycle': {
    name: 'ancestry-cycle',
    summary: 'Two branches record each other as parent: cycle badge, no stack lanes.',
    snapshot: repository({ branches: cycleBranches, currentBranch: 'feature/cycle-a' }),
    recentRepositories,
  },
  'branches-deep-chain': {
    name: 'branches-deep-chain',
    summary: 'A branch chain far longer than one list page, for sliding-window keyboard behaviour.',
    snapshot: deepChainSnapshot,
    recentRepositories,
  },
  'ancestry-requires-restack': {
    name: 'ancestry-requires-restack',
    summary: 'Both stacked branches are behind their recorded parent boundary.',
    snapshot: restackBase,
    recentRepositories,
  },
  'files-clean': {
    name: 'files-clean',
    summary: 'Clean working tree with nothing staged or unstaged.',
    snapshot: connected,
    recentRepositories,
  },
  'files-staged': {
    name: 'files-staged',
    summary: 'Staged additions and modifications with an empty working tree.',
    snapshot: repository({ files: stagedOnlyChanges }),
    recentRepositories,
  },
  'files-unstaged': {
    name: 'files-unstaged',
    summary: 'Working-tree modifications only, nothing staged.',
    snapshot: repository({ files: unstagedOnlyChanges }),
    recentRepositories,
  },
  'files-renamed': {
    name: 'files-renamed',
    summary: 'Staged rename that keeps its recorded original path.',
    snapshot: repository({
      files: [
        changedFile(renamedPath, 'R', ' ', {
          originalPath: 'src/renderer/src/components/old-views.tsx',
        }),
      ],
    }),
    recentRepositories,
  },
  'files-untracked': {
    name: 'files-untracked',
    summary: 'Untracked file shown as content instead of a diff.',
    snapshot: repository({ files: [changedFile(untrackedPath, '?', ' ')] }),
    recentRepositories,
    fileViews: {
      [untrackedPath]: {
        path: untrackedPath,
        stagedDiff: '',
        unstagedDiff: '',
        content: 'export const checkLabel = (checks: string) => checks\n',
        binary: false,
        fingerprint: 'fingerprint-untracked',
        conflicted: false,
        truncated: false,
        hunks: untrackedHunks,
      },
    },
  },
  'files-conflicts': {
    name: 'files-conflicts',
    summary: 'Conflicted file next to an unrelated unstaged change.',
    snapshot: repository({ files: conflictedChanges }),
    recentRepositories,
  },
  'files-truncated': {
    name: 'files-truncated',
    summary: 'Large file whose diff the backend reports as truncated.',
    snapshot: repository({ files: [changedFile(truncatedPath, ' ', 'M')] }),
    recentRepositories,
    fileViews: { [truncatedPath]: fileViewFixtures.truncated },
  },
  'files-long-content': {
    name: 'files-long-content',
    summary: 'Long path, a 400-character diff line, and a 2400-line scrolling diff.',
    snapshot: repository({
      files: [changedFile(longLinePath, ' ', 'M'), changedFile(bulkPath, ' ', 'M')],
    }),
    recentRepositories,
    fileViews: longContentViews,
  },

  'history-loading': {
    name: 'history-loading',
    summary: 'History read stays pending until it is released.',
    snapshot: connected,
    recentRepositories,
    pending: ['history'],
  },
  'history-error': {
    name: 'history-error',
    summary: 'Every history read rejects, on the first load and on load more.',
    snapshot: connected,
    recentRepositories,
    failures: { history: 'The commit history could not be read from this repository.' },
  },

  'review-stacked': {
    name: 'review-stacked',
    summary:
      'Three pull requests in one native stack, so the rail shows a position and both layers.',
    snapshot: repository({
      branches: [mainBranch, ...reviewStackBranches],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests,
      nativeStacks: nativeReviewFixture(reviewStackPullRequests),
    }),
    recentRepositories,
  },
  'review-long-stack': {
    name: 'review-long-stack',
    summary:
      'Forty authoritative native layers including merged, closed, draft and long-title members.',
    snapshot: repository({
      branches: [mainBranch, ...longReviewStackBranches],
      currentBranch: 'feature/long-review-36',
      pullRequests: longReviewStackPullRequests,
      nativeStacks: nativeReviewFixture(longReviewStackPullRequests),
    }),
    recentRepositories,
  },
  'review-stack-partial': {
    name: 'review-stack-partial',
    summary: 'Three loaded members of a submitted stack that reports forty layers.',
    snapshot: repository({
      branches: [mainBranch, ...reviewStackBranches],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests.map((pr) => ({
        ...pr,
        stack: pr.stack ? { ...pr.stack, size: 40 } : null,
      })),
    }),
    recentRepositories,
  },
  'review-stack-error': {
    name: 'review-stack-error',
    summary: 'Review remains readable when the native membership resource is unavailable.',
    snapshot: repository({
      branches: [mainBranch, ...reviewStackBranches],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests,
    }),
    recentRepositories,
    reviewStackUnavailable: true,
  },
  'review-stack-stale': {
    name: 'review-stack-stale',
    summary: 'Authoritative membership retained while summary metadata belongs to an older head.',
    snapshot: repository({
      branches: [mainBranch, ...reviewStackBranches],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests,
      nativeStacks: nativeReviewFixture(reviewStackPullRequests),
    }),
    recentRepositories,
    reviewStackFactsState: 'stale',
  },
  'review-stack-metadata-unavailable': {
    name: 'review-stack-metadata-unavailable',
    summary: 'Native membership is available but optional checks and review summaries are refused.',
    snapshot: repository({
      branches: [mainBranch, ...reviewStackBranches],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests,
    }),
    recentRepositories,
    reviewStackFactsState: 'unavailable',
  },
  'review-stack-disagreement': {
    name: 'review-stack-disagreement',
    summary:
      'Local recorded parents disagree with submitted native order; blockers name the read-model source.',
    snapshot: repository({
      branches: [
        mainBranch,
        ...reviewStackBranches.map((branch, index) => ({
          ...branch,
          parentSource: index === 1 ? ('inferred' as const) : ('recorded' as const),
          needsRestack: index === 0,
          parentBehind: index === 0 ? 2 : index === 1 ? null : 0,
        })),
      ],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests,
      nativeStacks: nativeReviewFixture(reviewStackPullRequests),
      reconciliation: {
        available: true,
        message: 'Submitted membership differs from local recorded parents.',
        blockers: [],
        evidence: null,
        stacks: [
          {
            key: 'native:42',
            base: 'main',
            stackNumber: 42,
            stackUrl: 'https://github.com/howarewoo/git-stacks/stacks/42',
            state: 'reordered',
            summary: 'Local parent order disagrees with the submitted order.',
            submittedOrder: ['feature/review-41', 'feature/review-42', 'feature/review-43'],
            members: [],
            repairs: [],
            blockers: ['Recorded parent order must be reconciled before publishing.'],
          },
        ],
      },
    }),
    recentRepositories,
  },
  'review-force-pushed': {
    name: 'review-force-pushed',
    summary:
      'The pull request was force-pushed between the headline read and the file read, so the two revisions disagree.',
    snapshot: repository({
      branches: [mainBranch, ...reviewStackBranches],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests,
    }),
    recentRepositories,
    reviewHeadOid: 'ffffeee',
  },
  'review-unstacked': {
    name: 'review-unstacked',
    summary: 'One pull request GitHub reports no stack membership for.',
    snapshot: repository({
      branches: [mainBranch, checkoutBranch, { ...checkoutTestsBranch, pr: checkoutPr }],
      currentBranch: 'feature/checkout',
      pullRequests: [checkoutPr],
    }),
    recentRepositories,
  },
  'review-read-only': {
    name: 'review-read-only',
    summary:
      'A viewer with no write access, so every submit decision is refused before any request is made.',
    snapshot: repository({
      branches: [mainBranch, ...reviewStackBranches],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests,
    }),
    recentRepositories,
    reviewHeadOid: 'ffffeee',
    reviewPermissions: { blocked: 'COMMENT' },
  },
  'review-own-pull-request': {
    name: 'review-own-pull-request',
    summary:
      'The viewer opened this pull request, so approval is refused while comment and request changes stay available.',
    snapshot: repository({
      branches: [mainBranch, ...reviewStackBranches],
      currentBranch: 'feature/review-42',
      pullRequests: reviewStackPullRequests,
    }),
    recentRepositories,
    reviewHeadOid: 'ffffeee',
    reviewPermissions: { isAuthor: true },
  },
  'pull-requests-lifecycle': {
    name: 'pull-requests-lifecycle',
    summary: 'Draft, open, closed, and merged pull requests on their own branches.',
    snapshot: repository({
      branches: lifecycleBranches,
      currentBranch: 'feature/lifecycle-open',
      pullRequests: [
        pullRequestFixtures[0],
        pullRequestFixtures[1],
        pullRequestFixtures[2],
        pullRequestFixtures[3],
      ],
    }),
    recentRepositories,
  },
  'pull-requests-checks': {
    name: 'pull-requests-checks',
    summary: 'Pending, failing, passing, and no-check pull requests, one very long title.',
    snapshot: repository({ pullRequests: pullRequestFixtures }),
    recentRepositories,
  },

  'pull-requests-checks-detail': {
    name: 'pull-requests-checks-detail',
    summary:
      'Inspector checks drill-down: required failure, optional failure, running Actions run, and a required check not yet reported.',
    snapshot: repository({
      branches: [mainBranch, checksBranch],
      currentBranch: 'feature/lifecycle-open',
      pullRequests: [pullRequestFixtures[0]],
    }),
    recentRepositories,
    pullRequestChecks: { 42: mixedChecksReport },
  },

  'pull-requests-checks-stale': {
    name: 'pull-requests-checks-stale',
    summary: 'Checks last read before a failed refresh, visibly stale, with rerun unavailable.',
    snapshot: repository({
      branches: [mainBranch, checksBranch],
      currentBranch: 'feature/lifecycle-open',
      pullRequests: [pullRequestFixtures[0]],
    }),
    recentRepositories,
    pullRequestChecks: { 42: staleChecksReport },
  },
  'pull-requests-empty': {
    name: 'pull-requests-empty',
    summary: 'Connected repository whose pull request list is genuinely empty.',
    snapshot: repository({ branches: [mainBranch, checkoutBranch], pullRequests: [] }),
    recentRepositories,
  },
  'pull-requests-unavailable': {
    name: 'pull-requests-unavailable',
    summary: 'GitHub metadata unavailable instead of empty; counts stay hidden.',
    snapshot: repository({
      branches: [mainBranch, checkoutBranch, { ...checkoutTestsBranch, pr: null }],
      pullRequests: [],
      github: {
        available: false,
        message: 'GitHub metadata unavailable: the gh CLI is not installed',
      },
    }),
    recentRepositories,
  },

  'pull-requests-issue-links': {
    name: 'pull-requests-issue-links',
    summary: 'One closing keyword reference and one local contextual link on the same PR.',
    snapshot: repository({
      issues: [
        {
          number: 42,
          title: 'Checkout fails when the parent branch was renamed',
          url: 'https://github.com/howarewoo/git-stacks/issues/42',
          state: 'OPEN',
        },
        {
          number: 51,
          title: 'Add a keyboard shortcut for the command palette',
          url: 'https://github.com/howarewoo/git-stacks/issues/51',
          state: 'OPEN',
        },
        {
          number: 58,
          title: 'Stack rail loses the position of a collapsed layer',
          url: 'https://github.com/howarewoo/git-stacks/issues/58',
          state: 'CLOSED',
        },
      ],
    }),
    recentRepositories,
    issueLinks: {
      [checkoutPr.number]: [
        {
          number: 42,
          title: 'Checkout fails when the parent branch was renamed',
          url: 'https://github.com/howarewoo/git-stacks/issues/42',
          state: 'OPEN',
          relation: 'closing',
        },
        {
          number: 58,
          title: 'Stack rail loses the position of a collapsed layer',
          url: 'https://github.com/howarewoo/git-stacks/issues/58',
          state: 'CLOSED',
          relation: 'contextual',
        },
      ],
    },
  },

  'pull-requests-merge-refused': {
    name: 'pull-requests-merge-refused',
    summary: 'A reopened merge dialog whose earlier request GitHub refused.',
    snapshot: repository({
      branches: [mainBranch, lifecycleOpenBranch],
      currentBranch: 'feature/lifecycle-open',
      pullRequests: [pullRequestFixtures[0]],
    }),
    recentRepositories,
    mergeStatus: failedMergeStatus,
  },

  'stash-stable-oid': {
    name: 'stash-stable-oid',
    summary: 'Two stashes with stable OIDs for drop and apply dispatch checks.',
    snapshot: repository({ stashes: stashFixtures }),
    recentRepositories,
  },
  'stash-empty': {
    name: 'stash-empty',
    summary: 'Connected repository with no stashes at all.',
    snapshot: repository({ stashes: [] }),
    recentRepositories,
  },
  'stash-index-shift': {
    name: 'stash-index-shift',
    summary: 'The same stash OIDs at shifted indices, plus one newer stash.',
    snapshot: repository({ stashes: shiftedStashes }),
    recentRepositories,
  },

  'workflow-preview-ready': {
    name: 'workflow-preview-ready',
    summary: 'Restack preview resolves with two steps and an enabled submit.',
    snapshot: restackBase,
    recentRepositories,
    stackPreviews: { restack: restackPreview },
  },
  'workflow-preview-loading': {
    name: 'workflow-preview-loading',
    summary: 'Restack preview stays pending until it is released.',
    snapshot: restackBase,
    recentRepositories,
    pending: ['stackPreview'],
    stackPreviews: { restack: restackPreview },
  },
  'workflow-preview-blocked': {
    name: 'workflow-preview-blocked',
    summary: 'Restack preview resolves with blockers, so the submit stays gated.',
    snapshot: restackBase,
    recentRepositories,
    stackPreviews: { restack: blockedRestackPreview },
  },
  'workflow-preview-stale': {
    name: 'workflow-preview-stale',
    summary: 'A rejected restack submit leaves the preview out of date until it is reloaded.',
    snapshot: restackBase,
    recentRepositories,
    stackPreviews: { restack: restackPreview },
    actionFailures: {
      executeStack:
        'The recorded stack boundaries changed while the preview was open. Reload the preview and try again.',
    },
  },
  'workflow-action-error': {
    name: 'workflow-action-error',
    summary: 'A non-preview action fails: error banner without any stale preview state.',
    snapshot: repository({ files: unstagedOnlyChanges }),
    recentRepositories,
    actionFailures: {
      stash: 'The working tree changed on disk, so no stash was created.',
    },
  },
  'workflow-partial-restack': {
    name: 'workflow-partial-restack',
    summary: 'Restack paused between branches: partial progress with Continue enabled.',
    snapshot: {
      ...restackBase,
      currentBranch: 'feature/checkout-tests',
      stackOperation: pausedRestackProgress,
      files: [],
    },
    recentRepositories,
    stackPreviews: { restack: restackPreview },
  },
  'workflow-conflict-recovery': {
    name: 'workflow-conflict-recovery',
    summary: 'Conflicted file with no resumable operation: resolve it, then stage it.',
    snapshot: repository({ files: conflictedChanges }),
    recentRepositories,
  },
  'workflow-operation-recovery': {
    name: 'workflow-operation-recovery',
    summary: 'Interrupted rebase: Continue is blocked while Skip and Abort stay available.',
    snapshot: {
      ...repository({ files: conflictedChanges }),
      operation: 'rebase',
      rebaseInProgress: true,
    },
    recentRepositories,
  },
  'workflow-external-operation': {
    name: 'workflow-external-operation',
    summary: 'Git operation Git Stacks cannot drive: no continue, skip, or abort.',
    snapshot: {
      ...repository({ files: conflictedChanges }),
      operation: 'other',
    },
    recentRepositories,
  },
  // PR Inbox
  'pr-inbox-queue': {
    name: 'pr-inbox-queue',
    summary: 'Two registered repositories, six groups, one row per group.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: inboxSnapshots,
    inbox: inboxQueue,
  },
  'pr-inbox-structured': {
    name: 'pr-inbox-structured',
    summary:
      'Structured triage, long titles, same-number cross-repository identities and truthful counts.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: { ...inboxSnapshots, [SPECIMENS_PATH]: inboxStructuredSpecimen },
    inbox: inboxReport(inboxRead, inboxStructuredRows),
  },
  'pr-inbox-same-number': {
    name: 'pr-inbox-same-number',
    summary: 'Two repositories both have PR #81, with distinct heads and review facts.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: {
      ...inboxSnapshots,
      [SPECIMENS_PATH]: {
        ...specimensSnapshot,
        pullRequests: [{ ...specimensPr77, number: 81 }],
        branches: specimensSnapshot.branches.map((branch) =>
          branch.pr ? { ...branch, pr: { ...branch.pr, number: 81 } } : branch,
        ),
      },
    },
    inbox: {
      ...inboxQueue,
      items: inboxQueue.items.map((item) =>
        item.repositoryPath === SPECIMENS_PATH ? { ...item, number: 81 } : item,
      ),
    },
  },
  'pr-inbox-no-repository': {
    name: 'pr-inbox-no-repository',
    summary: 'The queue with no repository open: it spans every registered repository.',
    snapshot: null,
    recentRepositories,
    snapshotsByPath: inboxSnapshots,
    inbox: inboxQueue,
  },
  'pr-inbox-empty': {
    name: 'pr-inbox-empty',
    summary: 'GitHub confirmed a read that holds nothing: the queue is empty, not unconfirmed.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: inboxSnapshots,
    inbox: inboxEmpty,
  },
  'pr-inbox-partial': {
    name: 'pr-inbox-partial',
    summary: 'One repository answered without review and check metadata; the other read fully.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: inboxSnapshots,
    inbox: inboxPartial,
  },
  'pr-inbox-unavailable': {
    name: 'pr-inbox-unavailable',
    summary: 'GitHub is unreachable: the last confirmed rows stay behind the reason.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: inboxSnapshots,
    inbox: inboxReport(
      inboxRead,
      inboxRows.map((row) => ({
        ...row,
        changeSize: { state: 'stale' as const },
        unresolvedThreads: { state: 'stale' as const },
      })),
      {
        state: 'offline',
        confirmedAt: EARLIER,
        checkedAt: UPDATED,
        detail: 'GitHub could not be reached: howarewoo/git-stacks (GitHub unreachable).',
      },
    ),
  },
  'pr-inbox-retired': {
    name: 'pr-inbox-retired',
    summary:
      'The read ended before it confirmed anything: the queue is empty and says so, without blaming the account or the network.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: inboxSnapshots,
    // The same shape the main process returns for a read it ended: nothing at
    // all, because the rows an earlier read confirmed were read by an identity
    // that is no longer the one asking.
    inbox: inboxReport([], [], {
      state: 'retired',
      confirmedAt: null,
      checkedAt: UPDATED,
      viewer: null,
      requests: 0,
      detail:
        'This read ended before it confirmed anything, so it is not describing the current queue. Refresh to read the queue as it is now.',
    }),
  },
  'pr-inbox-first-read': {
    name: 'pr-inbox-first-read',
    summary: 'Nothing has ever been read from GitHub: the queue is waiting on its first read.',
    snapshot: connected,
    recentRepositories,
  },
  'pr-inbox-membership-unknown': {
    name: 'pr-inbox-membership-unknown',
    summary:
      'The host read the rows and named no account: no viewer-relative group can be decided, and the queue says why.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: inboxSnapshots,
    inbox: inboxMembershipUnknown,
  },
  'pr-inbox-host-switch': {
    name: 'pr-inbox-host-switch',
    summary:
      'A queue confirmed for one host, whose GitHub CLI status has not answered yet, when the person names a different host.',
    snapshot: inboxPrimarySnapshot,
    recentRepositories,
    snapshotsByPath: inboxSnapshots,
    inbox: inboxQueue,
    // The CLI status read is still outstanding, so the window opens holding a
    // confirmed queue for github.com and nothing at all that says which account
    // behind it is. It answers with github.com's account, and it answers late.
    pending: ['githubCliStatus'],
    identity: {
      settings: { ...DEFAULT_SETTINGS },
      cli: {
        state: 'authenticated',
        host: 'github.com',
        login: 'ada',
        version: '2.62.0',
        identity: 'cli:github.com:ada:1',
        message: null,
      },
    },
  },
  'notifications-awaiting-credential': {
    name: 'notifications-awaiting-credential',
    summary: 'The module is on and has no token: authorization is offered, polling has not begun.',
    snapshot: connected,
    recentRepositories,
    notifications: awaitingCredential(),
  },
  'notifications-read-pending': {
    name: 'notifications-read-pending',
    summary:
      "The inbox's own read is admitted and still outstanding, so this window is showing neither host's rows and has nothing left to release.",
    snapshot: connected,
    recentRepositories,
    // The read the App makes on mount starts outstanding: the answer it will
    // get was taken for the host this window was pointed at, which is exactly
    // the answer a later host change has to refuse rather than adopt.
    pending: ['notifications'],
    notifications: awaitingCredential(),
  },
  'notifications-cli-status-pending': {
    name: 'notifications-cli-status-pending',
    summary:
      "This installation's own GitHub CLI status read is still outstanding, so the window has no account for any host while the Notification Center is otherwise ready to be pointed at another one.",
    snapshot: connected,
    recentRepositories,
    // The CLI status read the App makes on mount is admitted and then held: the
    // window is holding no account at all, which is a different thing from a
    // notification credential being missing. It is also the only reason this
    // scenario answers the optional CLI status bridge at all: a window whose
    // build has no such bridge holds no status either, and every other scenario
    // already renders that way.
    githubCliStatus: {
      state: 'authenticated',
      host: 'github.com',
      login: 'octo',
      version: '2.62.0',
      identity: 'cli:github.com:octo:1',
      message: null,
    },
    pending: ['githubCliStatus'],
    notifications: awaitingCredential(),
  },
  'notifications-other-host-awaiting-credential': {
    name: 'notifications-other-host-awaiting-credential',
    summary:
      'The other GitHub host, after a settings change, with no token of its own: its own authorization is offered rather than the previous host’s.',
    snapshot: connected,
    recentRepositories,
    // The inbox this host serves is genuinely its own: it names this host,
    // so a window pointed here is answering for this host and not carrying
    // the previous one's inbox under this key.
    notifications: awaitingCredential('ghe.acme.internal'),
  },
  'notifications-ready': {
    name: 'notifications-ready',
    summary: 'A live GitHub inbox: threads with GitHub’s own reasons, one already read.',
    snapshot: connected,
    recentRepositories,
    notifications: notificationInbox({ stale: false }),
  },
  'notifications-stale': {
    name: 'notifications-stale',
    summary:
      'GitHub could not be reached; the last confirmed list stands, marked stale with the reason.',
    snapshot: connected,
    recentRepositories,
    notifications: notificationInbox({ stale: true, staleReason: 'offline' }),
  },
  'notifications-rejected': {
    name: 'notifications-rejected',
    summary:
      'GitHub refused the stored token. It is still sealed here, so it has to stay discardable.',
    snapshot: connected,
    recentRepositories,
    notifications: notificationInbox({
      state: 'rejected',
      threads: [],
      unreadCount: 0,
      message: 'GitHub refused the stored notification credential. Replace it to read this inbox.',
    }),
  },
  'notifications-policy-disabled': {
    name: 'notifications-policy-disabled',
    summary:
      'A policy holds the module off while a credential is still sealed here, so it stays discardable.',
    snapshot: connected,
    recentRepositories,
    notifications: notificationInbox({
      state: 'policy-disabled',
      policyDisabled: true,
      threads: [],
      unreadCount: 0,
      message: 'Notifications are held off by policy on this computer.',
    }),
  },
  'notifications-other-host': {
    name: 'notifications-other-host',
    summary:
      'A different GitHub host after a settings change: its own account and its own threads.',
    snapshot: connected,
    recentRepositories,
    notifications: {
      ...notificationInbox({ stale: false }),
      host: 'ghe.acme.internal',
      login: 'riley',
      reference: 'keychain://git-stacks/notifications/riley',
      // These rows exist only on the host that was just selected. Nothing about
      // them may survive into the view the previous host's inbox leaves behind.
      threads: [
        {
          id: '201',
          unread: true,
          reason: 'review_requested',
          title: 'Review the internal deploy queue',
          url: 'https://ghe.acme.internal/ops/deploys/pull/201',
          kind: 'pull_request',
          repository: { owner: 'ops', name: 'deploys' },
          updatedAt: UPDATED,
        },
        {
          id: '202',
          unread: true,
          reason: 'mention',
          title: 'Mentioned in “Nightly build rota”',
          url: 'https://ghe.acme.internal/ops/builds/issues/202',
          kind: 'issue',
          repository: { owner: 'ops', name: 'builds' },
          updatedAt: EARLIER,
        },
      ],
      unreadCount: 2,
    },
  },
  'notifications-no-repository': {
    name: 'notifications-no-repository',
    summary:
      'The Notification Center with no repository open: the inbox belongs to a host, not to a checkout.',
    snapshot: null,
    recentRepositories,
    notifications: notificationInbox({ stale: false }),
  },
  'notifications-mark-all-accepted': {
    name: 'notifications-mark-all-accepted',
    summary:
      'GitHub accepted the whole-inbox change and has not confirmed it yet, so the rows are still the last ones it confirmed.',
    snapshot: connected,
    recentRepositories,
    notifications: notificationInbox({ stale: false, markAllReadPending: true }),
  },
  'notifications-no-subject-link': {
    name: 'notifications-no-subject-link',
    summary:
      'A subject kind and reason this build has no name for, and a commit, with the controls each of them still has.',
    snapshot: connected,
    recentRepositories,
    notifications: {
      ...notificationInbox({ stale: false }),
      threads: [
        {
          id: '301',
          unread: true,
          // A host can name a reason or a subject this build has no label for.
          // The row is still a thread with an id, so its own operations are
          // still operations on it.
          reason: 'unknown',
          title: 'Something this build has no name for',
          // No page this build will open for it. That is a fact about the
          // subject, not about what may be done to the thread.
          url: null,
          kind: 'unknown',
          repository: null,
          updatedAt: UPDATED,
        },
        {
          id: '302',
          unread: true,
          reason: 'subscribed',
          title: 'Pushed “Record the stack ordering rules”',
          // The one-commit page, which is the commit itself and its comments,
          // rather than the history of the branch it landed on.
          url: 'https://github.com/acme/widgets/commit/9f1c2b7d4e5a',
          kind: 'commit',
          repository: { owner: 'acme', name: 'widgets' },
          updatedAt: UPDATED,
        },
      ],
      unreadCount: 2,
    },
  },
  'notifications-turned-off': {
    name: 'notifications-turned-off',
    summary:
      'Consent was withdrawn while a credential is still sealed: the module is off, and the token is still there to discard.',
    snapshot: connected,
    recentRepositories,
    notifications: notificationInbox({
      state: 'disabled',
      enabled: false,
      threads: [],
      unreadCount: 0,
      message: 'GitHub Notifications is off.',
    }),
  },
  'settings-ready': {
    name: 'settings-ready',
    summary:
      'An unmanaged computer: an authenticated CLI, a probed github.com host, both configured tools present, and nothing locked.',
    snapshot: connected,
    recentRepositories,
    githubCliStatus: {
      state: 'authenticated',
      host: 'github.com',
      login: 'octo',
      version: '2.62.0',
      identity: 'cli:github.com:octo:1',
      message: null,
    },
    hostStatus: githubComHostStatus,
    settingsPolicy: { tools: toolsAvailable },
  },
  'settings-managed': {
    name: 'settings-managed',
    summary:
      'A policy fixes three settings, one stored value was refused, and the configured editor is not installed here.',
    snapshot: connected,
    recentRepositories,
    githubCliStatus: {
      state: 'authenticated',
      host: 'github.com',
      login: 'octo',
      version: '2.62.0',
      identity: 'cli:github.com:octo:1',
      message: null,
    },
    hostStatus: githubComHostStatus,
    settingsPolicy: {
      locks: [
        {
          key: 'updates.channel',
          reason: 'Fixed to the stable channel by your organization.',
        },
        {
          key: 'privacy.includeLocalPaths',
          reason: 'Local paths may not leave this computer under your organization policy.',
        },
        { key: 'git.mergeTool', reason: 'The merge tool is provisioned by your organization.' },
      ],
      issues: [
        {
          key: 'git.fetchIntervalSeconds',
          message: 'must be at least 30 seconds; 120 is in use',
        },
      ],
      tools: toolsMissingEditor,
    },
  },
}
