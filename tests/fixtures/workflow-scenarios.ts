import type {
  Branch,
  ChangedFile,
  Commit,
  PullRequest,
  PushPreview,
  RepositorySnapshot,
  StackPreview,
  StackProgress,
  SurgeryPreview,
} from '../../src/shared/types'
import { EMPTY_SNAPSHOT_LIMITS } from '../../src/shared/performance'
import type { RepositoryCapabilities } from '../../src/shared/capabilities'

/**
 * Deterministic Git Stacks fixtures for the workflow dialog state and recovery
 * surfaces. Every value here is a fixed literal so a regression test can assert
 * on real snapshot data instead of a stub shape.
 */

export const defaultBranch: Branch = {
  ref: 'refs/heads/main',
  name: 'main',
  current: false,
  remote: false,
  upstream: 'origin/main',
  upstreamRef: 'refs/remotes/origin/main',
  ahead: 0,
  behind: 0,
  subject: 'Bump the release notes',
  updatedAt: '2026-02-02T09:00:00.000Z',
  parent: null,
  parentBehind: 0,
  pr: null,
  oid: '1111111111111111111111111111111111111111',
}

export const featureBranch: Branch = {
  ref: 'refs/heads/feature/checkout',
  name: 'feature/checkout',
  current: true,
  remote: false,
  upstream: 'origin/feature/checkout',
  upstreamRef: 'refs/remotes/origin/feature/checkout',
  ahead: 2,
  behind: 0,
  subject: 'Add checkout validation',
  updatedAt: '2026-02-03T09:00:00.000Z',
  parent: 'main',
  parentBehind: 0,
  pr: null,
  oid: '2222222222222222222222222222222222222222',
  parentTip: '1111111111111111111111111111111111111111',
  parentSource: 'recorded',
}

export const followUpBranch: Branch = {
  ref: 'refs/heads/feature/checkout-tests',
  name: 'feature/checkout-tests',
  current: false,
  remote: false,
  upstream: null,
  upstreamRef: null,
  ahead: 0,
  behind: 0,
  subject: 'Cover checkout validation',
  updatedAt: '2026-02-04T09:00:00.000Z',
  parent: 'feature/checkout',
  parentBehind: 0,
  pr: {
    number: 41,
    title: 'Add checkout validation',
    url: 'https://github.com/howarewoo/git-stacks/pull/41',
    head: 'feature/checkout-tests',
    base: 'feature/checkout',
    state: 'OPEN',
    draft: true,
    checks: 'pending',
    headOid: '3333333333333333333333333333333333333333',
  },
  oid: '3333333333333333333333333333333333333333',
  parentTip: '2222222222222222222222222222222222222222',
  parentSource: 'recorded',
  needsRestack: true,
}

export const conflictedFiles: ChangedFile[] = [
  { path: 'src/checkout.ts', index: 'U', worktree: 'U', conflicted: true },
  { path: 'tests/checkout.test.ts', index: 'M', worktree: 'M', conflicted: false },
]

/** An ordinary, fully supported checkout: a worktree with files reference storage. */
export const standardCapabilities: RepositoryCapabilities = {
  bare: false,
  detachedHead: false,
  linkedWorktree: false,
  worktreeCount: 1,
  refStorage: 'files',
  refStorageDetail: null,
  sparseCheckout: false,
  sparseCheckoutCone: false,
  submodules: false,
  gitLfs: false,
  worktreeConfig: false,
  objectFormat: 'sha1',
  gitVersion: 'git version 2.52.0',
}

export const baseSnapshot: RepositorySnapshot = {
  path: '/private/tmp/git-stacks-fixture/repository-with-a-long-name',
  name: 'git-stacks-fixture',
  currentBranch: 'feature/checkout',
  defaultBranch: 'main',
  remoteUrl: 'git@github.com:howarewoo/git-stacks-fixture.git',
  branches: [defaultBranch, featureBranch, followUpBranch],
  pullRequests: [],
  files: [],
  stashes: [],
  rebaseInProgress: false,
  operation: null,
  stackOperation: null,
  headOid: featureBranch.oid ?? null,
  github: { available: true, message: '' },
  limits: EMPTY_SNAPSHOT_LIMITS,
  capabilities: standardCapabilities,
}

function withSnapshot(overrides: Partial<RepositorySnapshot>): RepositorySnapshot {
  return { ...baseSnapshot, ...overrides }
}

/** An interactive rebase stopped on a conflicting commit. */
export const activeRebaseSnapshot = withSnapshot({
  operation: 'rebase',
  rebaseInProgress: true,
  files: conflictedFiles,
})

/** A cherry-pick stopped on a conflicting commit. */
export const activeCherryPickSnapshot = withSnapshot({
  operation: 'cherryPick',
  files: conflictedFiles,
})

/** A restack that paused after finishing some branches. */
export const pausedRestackProgress: StackProgress = {
  kind: 'restack',
  originalBranch: 'feature/checkout',
  currentBranch: 'feature/checkout-tests',
  completed: ['feature/checkout'],
  remaining: ['feature/checkout-tests'],
  message: 'Rebasing feature/checkout-tests onto the updated main.',
}

export const pausedRestackSnapshot = withSnapshot({
  stackOperation: pausedRestackProgress,
  operation: 'rebase',
  rebaseInProgress: true,
  files: conflictedFiles,
})

/** A restack whose steps have all been applied. */
export const completedRestackProgress: StackProgress = {
  kind: 'restack',
  originalBranch: 'feature/checkout',
  currentBranch: 'feature/checkout-tests',
  completed: ['feature/checkout', 'feature/checkout-tests'],
  remaining: [],
  message: 'Every branch has been rebased onto main.',
}

export const completedRestackSnapshot = withSnapshot({
  stackOperation: completedRestackProgress,
})

/** A restack that has not applied a single step yet. */
export const unstartedRestackProgress: StackProgress = {
  kind: 'restack',
  originalBranch: 'feature/checkout',
  currentBranch: 'feature/checkout',
  completed: [],
  remaining: ['feature/checkout', 'feature/checkout-tests'],
  message: 'Waiting for the first branch to be rebased.',
}

export const unstartedRestackSnapshot = withSnapshot({
  stackOperation: unstartedRestackProgress,
})

/** Conflicting files with no resumable operation recorded. */
export const unresolvedConflictSnapshot = withSnapshot({
  files: conflictedFiles,
})

/** A Git operation this app cannot drive itself. */
export const externalOperationSnapshot = withSnapshot({
  operation: 'other',
  files: conflictedFiles,
})

/** GitHub information is unavailable, not empty. */
export const unavailableGitHubSnapshot = withSnapshot({
  github: {
    available: false,
    message: 'GitHub CLI is not authenticated for this repository.',
  },
})

export const restackPreview: StackPreview = {
  token: 'preview-restack-1',
  kind: 'restack',
  merge: null,
  branch: 'feature/checkout',
  steps: [
    {
      branch: 'feature/checkout',
      parent: 'main',
      oid: '2222222222222222222222222222222222222222',
      commits: 2,
      title: 'Add checkout validation',
      pr: null,
      note: 'Rebasing onto the recorded boundary of main.',
    },
    {
      branch: 'feature/checkout-tests',
      parent: 'feature/checkout',
      oid: '3333333333333333333333333333333333333333',
      commits: 1,
      title: 'Cover checkout validation',
      pr: followUpBranch.pr,
      note: '',
    },
  ],
  warnings: ['feature/checkout-tests has an open draft pull request; its base moves with it.'],
  blockers: [],
  mergeMethods: ['merge', 'squash', 'rebase'],
  publish: null,
  sync: null,
}

export const blockedRestackPreview: StackPreview = {
  ...restackPreview,
  token: 'preview-restack-blocked',
  blockers: [
    'feature/checkout is checked out with unstaged changes.',
    'origin/feature/checkout is ahead of the local branch; restack locally first.',
  ],
}

export const publishPreview: StackPreview = {
  ...restackPreview,
  token: 'preview-publish-1',
  kind: 'publish',
  steps: [restackPreview.steps[0], { ...restackPreview.steps[1], pr: null }],
  // A real offer, so a caller that reaches the publish builder is refused for the reason it
  // was actually asked about rather than for a missing offer.
  publish: {
    branch: 'feature/checkout',
    stackNumber: null,
    stackAction: 'create',
    baseChanges: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        kind: 'push',
        branch: 'feature/checkout',
        label: 'Push feature/checkout',
        status: 'pending',
        pullRequest: null,
        detail: '',
        failure: null,
      },
      {
        kind: 'create-pr',
        branch: 'feature/checkout',
        label: 'Open pull request #1 for feature/checkout',
        status: 'pending',
        pullRequest: null,
        detail: '',
        failure: null,
      },
    ],
    layers: [
      {
        branch: 'feature/checkout',
        base: 'main',
        title: 'Add checkout validation',
        body: '',
        draft: true,
        updateBase: false,
        create: true,
        force: false,
        pullRequest: null,
        createIntent: false,
      },
    ],
  },
}

export const mergePreview: StackPreview = {
  ...restackPreview,
  token: 'preview-merge-1',
  kind: 'merge',
  branch: 'feature/checkout-tests',
  steps: [restackPreview.steps[1]],
  blockers: [],
  warnings: ['This merges one pull request. The remaining branches still need a restack.'],
  merge: {
    branch: 'feature/checkout-tests',
    native: true,
    actions: ['default', 'merge_queue', 'direct_merge'],
    layers: [
      {
        branch: 'feature/checkout',
        pullRequest: 40,
        base: 'main',
        headOid: '2222222222222222222222222222222222222222',
        includedInRequest: true,
      },
      {
        branch: 'feature/checkout-tests',
        pullRequest: 41,
        base: 'feature/checkout',
        headOid: '3333333333333333333333333333333333333333',
        includedInRequest: true,
      },
    ],
  },
}

export const syncPreview: StackPreview = {
  ...restackPreview,
  token: 'preview-sync-1',
  kind: 'sync',
  branch: 'feature/checkout-tests',
  steps: [restackPreview.steps[0], restackPreview.steps[1]],
  warnings: [
    'Local main is 1 commit ahead of origin/main; syncing replays the layers onto the fetched remote tip and leaves the local main alone.',
  ],
  sync: {
    branch: 'feature/checkout-tests',
    trunk: {
      branch: 'main',
      remote: 'origin',
      localOid: '5555555555555555555555555555555555555555',
      remoteOid: '4444444444444444444444444444444444444444',
      ahead: 1,
      behind: 0,
      diverged: false,
      blockers: [],
    },
    layers: [
      {
        branch: 'feature/checkout',
        base: 'main',
        baseOid: '4444444444444444444444444444444444444444',
        state: 'needs-force',
        oid: '2222222222222222222222222222222222222222',
        remoteOid: '2222222222222222222222222222222222222222',
        commits: 2,
        pullRequest: null,
        pullRequestBase: null,
        retargetedFrom: null,
        rebase: true,
        push: 'force',
        note: 'Replay onto main @ 444444444444; push replaces origin/feature/checkout 222222222222 under an exact lease',
        blockers: [],
      },
      {
        branch: 'feature/checkout-tests',
        base: 'feature/checkout',
        baseOid: '2222222222222222222222222222222222222222',
        state: 'up-to-date',
        oid: '3333333333333333333333333333333333333333',
        remoteOid: '3333333333333333333333333333333333333333',
        commits: 1,
        pullRequest: 41,
        pullRequestBase: 'feature/checkout',
        retargetedFrom: null,
        rebase: false,
        push: 'none',
        note: 'Replay onto feature/checkout @ 222222222222; remote branch already matches',
        blockers: [],
      },
    ],
    forcePushes: ['feature/checkout'],
    blockers: [],
    warnings: [],
  },
}

export const leasePreview: PushPreview = {
  branch: 'feature/checkout',
  remote: 'origin',
  remoteUrl: 'git@github.com:howarewoo/git-stacks-fixture.git',
  destination: 'refs/heads/feature/checkout',
  localOid: '2222222222222222222222222222222222222222',
  remoteOid: 'aaaa000000000000000000000000000000000000',
}

export const openPullRequest: PullRequest & { body: string } = {
  number: 41,
  title: 'Cover checkout validation',
  body: 'Adds coverage for the new checkout validation path.',
  url: 'https://github.com/howarewoo/git-stacks/pull/41',
  head: 'feature/checkout-tests',
  base: 'feature/checkout',
  state: 'OPEN',
  draft: true,
  checks: 'pending',
  headOid: '3333333333333333333333333333333333333333',
  reviewDecision: 'REVIEW_REQUIRED',
  mergeState: 'BLOCKED',
}

export const mergeCommit: Commit = {
  oid: '4444444444444444444444444444444444444444',
  parents: ['5555555555555555555555555555555555555555', '6666666666666666666666666666666666666666'],
  subject: 'Merge branch feature/checkout',
  author: 'Ada <ada@example.com>',
  date: '2026-02-05T09:00:00.000Z',
}

/** A reviewed insert between two layers, as the surgery preview reports it. */
export const insertSurgeryPreview: SurgeryPreview = {
  token: 'preview-surgery-1',
  expiresAt: Date.parse('2026-02-05T10:00:00.000Z'),
  kind: 'insert',
  branch: 'feature/checkout',
  trunk: 'main',
  order: ['feature/list', 'feature/checkout-helpers', 'feature/checkout', 'feature/audit'],
  layers: [
    {
      branch: 'feature/checkout-helpers',
      action: 'insert',
      fromParent: null,
      toParent: 'feature/list',
      oid: '3333333333333333333333333333333333333333',
      remoteOid: null,
      commits: 0,
      push: 'none',
      pullRequest: null,
      pullRequestBase: null,
      pullRequestAction: 'none',
      note: 'New branch at feature/list; no commits to replay',
      blockers: [],
    },
    {
      branch: 'feature/checkout',
      action: 'retarget',
      fromParent: 'feature/list',
      toParent: 'feature/checkout-helpers',
      oid: '2222222222222222222222222222222222222222',
      remoteOid: '2222222222222222222222222222222222222222',
      commits: 2,
      push: 'force',
      pullRequest: 42,
      pullRequestBase: 'feature/list',
      pullRequestAction: 'retarget',
      note: 'Replay 2 commits from 111111111111 onto 333333333333; pull request #42 retargeted to feature/checkout-helpers',
      blockers: [],
    },
  ],
  forcePushes: ['feature/checkout'],
  creates: ['feature/checkout-helpers'],
  retargets: [
    {
      number: 42,
      branch: 'feature/checkout',
      from: 'feature/list',
      to: 'feature/checkout-helpers',
    },
  ],
  closes: [],
  nativeStack: { number: 7, action: 'unstack-and-create', members: [41, 42] },
  blockers: [],
  warnings: [
    'Pushing feature/checkout replaces published history under the exact remote tips named above.',
  ],
}
