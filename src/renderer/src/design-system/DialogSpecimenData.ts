import type { Branch, PushPreview, StackPreview, StackProgress } from '../../../shared/types'

/**
 * Fixture data for the dialog specimen. These are the same literal values the
 * renderer sees from a real repository snapshot, so the gallery cannot drift
 * into shapes the renderer would never receive.
 */

export const restackPreview: StackPreview = {
  token: 'preview-restack-1',
  kind: 'restack',
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
      pr: {
        number: 41,
        title: 'Cover checkout validation',
        url: 'https://github.com/howarewoo/git-stacks-fixture/pull/41',
        head: 'feature/checkout-tests',
        base: 'feature/checkout',
        state: 'OPEN',
        draft: true,
        checks: 'pending',
        headOid: '3333333333333333333333333333333333333333',
      },
      note: '',
    },
  ],
  warnings: ['feature/checkout-tests has an open draft pull request; its base moves with it.'],
  blockers: [],
  mergeMethods: ['merge', 'squash', 'rebase'],
  publish: null,
}

export const publishPreview: StackPreview = {
  ...restackPreview,
  token: 'preview-publish-1',
  kind: 'publish',
  steps: [restackPreview.steps[0], { ...restackPreview.steps[1], pr: null }],
}

export const blockedRestackPreview: StackPreview = {
  ...restackPreview,
  token: 'preview-restack-blocked',
  blockers: [
    'feature/checkout is checked out with unstaged changes.',
    'origin/feature/checkout is ahead of the local branch; restack locally first.',
  ],
}

export const leasePreview: PushPreview = {
  branch: 'feature/checkout',
  remote: 'origin',
  remoteUrl: 'git@github.com:howarewoo/git-stacks-fixture.git',
  destination: 'refs/heads/feature/checkout',
  localOid: '2222222222222222222222222222222222222222',
  remoteOid: 'aaaa000000000000000000000000000000000000',
}

export const pausedRestackProgress: StackProgress = {
  kind: 'restack',
  originalBranch: 'feature/checkout',
  currentBranch: 'feature/checkout-tests',
  completed: ['feature/checkout'],
  remaining: ['feature/checkout-tests'],
  message: 'Rebasing feature/checkout-tests onto the updated main.',
}

export const unstartedRestackProgress: StackProgress = {
  kind: 'restack',
  originalBranch: 'feature/checkout',
  currentBranch: 'feature/checkout',
  completed: [],
  remaining: ['feature/checkout', 'feature/checkout-tests'],
  message: 'Waiting for the first branch to be rebased.',
}

export const completedRestackProgress: StackProgress = {
  kind: 'restack',
  originalBranch: 'feature/checkout',
  currentBranch: 'feature/checkout-tests',
  completed: ['feature/checkout', 'feature/checkout-tests'],
  remaining: [],
  message: 'Every branch has been rebased onto main.',
}

/** The branch the live guarded cards operate on, matching the stack preview. */
export const guardedBranch: Branch = {
  ref: 'refs/heads/feature/checkout',
  name: 'feature/checkout',
  current: true,
  remote: false,
  upstream: 'origin/feature/checkout',
  upstreamRef: 'refs/remotes/origin/feature/checkout',
  ahead: 2,
  behind: 0,
  pr: null,
  oid: '2222222222222222222222222222222222222222',
  parentTip: '1111111111111111111111111111111111111111',
  parentSource: 'recorded',
  subject: 'Add checkout validation',
  updatedAt: '2026-09-25T09:14:00.000Z',
  parent: 'main',
  parentBehind: 0,
}

/** The repository state every live card shares; only the reviewed input varies. */
export const liveGuardBase = {
  busy: false,
  loading: false,
  loaded: true,
  finished: false,
  capturedPath: '/Users/demo/git-stacks',
  currentPath: '/Users/demo/git-stacks',
  rejectedTokens: [] as readonly string[],
  previewBlockers: [] as readonly string[],
  expectedOidMissing: false,
  requiresMainline: false,
  mainline: '',
  requiresMergeMethod: false,
  mergeMethod: '',
  untitledBranches: [] as readonly string[],
  pullRequestMissing: false,
  pullRequestMerged: false,
  pullRequestTitle: '',
} as const
