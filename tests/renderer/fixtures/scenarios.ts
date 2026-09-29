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
import type { FixtureScenario } from './types'
import type { ScenarioName } from './manifest'

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

const recentRepositories: RecentRepository[] = [
  { path: '/Users/ada/Code/git-stacks', name: 'git-stacks' },
  { path: '/Users/ada/Code/design-system-specimens', name: 'design-system-specimens' },
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

export const scenarios: Record<ScenarioName, FixtureScenario> = {
  'shell-no-repository': {
    name: 'shell-no-repository',
    summary: 'Onboarding with recent repositories and no repository open.',
    snapshot: null,
    recentRepositories,
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
}
