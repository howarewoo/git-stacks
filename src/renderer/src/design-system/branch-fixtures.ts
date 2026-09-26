import type { Branch, PullRequest, RepositorySnapshot } from '../../../shared/types'

/**
 * Deterministic branch/stack fixtures for the branch tree, the stack workspace, and
 * the branch inspector. Every accepted graph shape and remote arrangement is present
 * so the surfaces can be exercised without a real repository.
 *
 * Coverage: linear stack, multiple children, deep nesting, missing parent, cycle, long
 * branch and pull-request names, a branch requiring restack, local/tracked-remote
 * consolidation with and without upstream configuration, remote-only branches, and a
 * same-name local/remote ambiguity.
 */

const UPDATED_AT = '2026-09-20T09:00:00.000Z'
const EARLIER = '2026-09-18T09:00:00.000Z'
const LATEST = '2026-09-22T09:00:00.000Z'

const LONG_BRANCH = 'feature/deliberately-long-branch-name-for-truncation-and-ancestry-readability'
const LONG_PR_TITLE =
  'Restyle the branch tree, stack workspace, and branch inspector with the quiet workbench tokens'

function makeBranch(overrides: Partial<Branch> & Pick<Branch, 'ref' | 'name'>): Branch {
  return {
    current: false,
    remote: false,
    upstream: null,
    upstreamRef: null,
    ahead: 0,
    behind: 0,
    subject: 'Update the branch surface',
    updatedAt: UPDATED_AT,
    parent: null,
    parentBehind: null,
    pr: null,
    parentSource: null,
    needsRestack: false,
    ...overrides,
  }
}

function makePr(
  overrides: Partial<PullRequest> & Pick<PullRequest, 'number' | 'title'>,
): PullRequest {
  return {
    url: `https://github.com/howarewoo/git-stacks/pull/${overrides.number}`,
    head: overrides.number === 42 ? 'feature/linear-child' : `branch-${overrides.number}`,
    base: 'main',
    state: 'OPEN',
    draft: false,
    checks: 'none',
    ...overrides,
  }
}

const linearBasePr = makePr({
  number: 41,
  title: 'Add the branch tree foundations',
  head: 'feature/linear-base',
  checks: 'failing',
  reviewDecision: 'CHANGES_REQUESTED',
  mergeState: 'BLOCKED',
})

const branches: Branch[] = [
  // Linear stack: base -> child, with the child checked out.
  makeBranch({
    ref: 'refs/heads/main',
    name: 'main',
    subject: 'Base branch for the fixture stack',
    updatedAt: EARLIER,
  }),
  makeBranch({
    ref: 'refs/heads/feature/linear-base',
    name: 'feature/linear-base',
    parent: 'main',
    parentSource: 'recorded',
    subject: 'Introduce the linear stack base',
    updatedAt: EARLIER,
    pr: linearBasePr,
  }),
  makeBranch({
    ref: 'refs/heads/feature/linear-child',
    name: 'feature/linear-child',
    current: true,
    parent: 'feature/linear-base',
    parentSource: 'recorded',
    subject: 'Build on the linear stack base',
    updatedAt: LATEST,
    oid: '1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d',
    pr: makePr({
      number: 42,
      title: 'Build on the linear stack base',
      head: 'feature/linear-child',
      checks: 'passing',
      reviewDecision: 'APPROVED',
      mergeState: 'CLEAN',
    }),
  }),

  // Multiple children off one parent.
  makeBranch({
    ref: 'refs/heads/feature/fan-base',
    name: 'feature/fan-base',
    parent: 'main',
    parentSource: 'recorded',
    subject: 'Parent for two sibling branches',
  }),
  makeBranch({
    ref: 'refs/heads/feature/fan-a',
    name: 'feature/fan-a',
    parent: 'feature/fan-base',
    parentSource: 'pullRequest',
    subject: 'First sibling branch',
    pr: makePr({
      number: 43,
      title: 'First sibling branch',
      head: 'feature/fan-a',
      draft: true,
      checks: 'none',
    }),
  }),
  makeBranch({
    ref: 'refs/heads/feature/fan-b',
    name: 'feature/fan-b',
    parent: 'feature/fan-base',
    parentSource: 'recorded',
    subject: 'Second sibling branch',
    pr: makePr({
      number: 46,
      title: 'Second sibling branch',
      head: 'feature/fan-b',
      state: 'MERGED',
      checks: 'passing',
      reviewDecision: 'APPROVED',
      mergeState: 'CLEAN',
    }),
  }),

  // Deep nesting: every level carries a sibling so the tree indents through four lanes.
  makeBranch({
    ref: 'refs/heads/feature/deep-1',
    name: 'feature/deep-1',
    parent: 'main',
    parentSource: 'recorded',
  }),
  makeBranch({
    ref: 'refs/heads/feature/deep-1-sibling',
    name: 'feature/deep-1-sibling',
    parent: 'main',
    parentSource: 'recorded',
  }),
  makeBranch({
    ref: 'refs/heads/feature/deep-2',
    name: 'feature/deep-2',
    parent: 'feature/deep-1',
    parentSource: 'recorded',
  }),
  makeBranch({
    ref: 'refs/heads/feature/deep-2-sibling',
    name: 'feature/deep-2-sibling',
    parent: 'feature/deep-1',
    parentSource: 'recorded',
  }),
  makeBranch({
    ref: 'refs/heads/feature/deep-3',
    name: 'feature/deep-3',
    parent: 'feature/deep-2',
    parentSource: 'recorded',
  }),
  makeBranch({
    ref: 'refs/heads/feature/deep-3-sibling',
    name: 'feature/deep-3-sibling',
    parent: 'feature/deep-2',
    parentSource: 'recorded',
  }),
  makeBranch({
    ref: 'refs/heads/feature/deep-4',
    name: 'feature/deep-4',
    parent: 'feature/deep-3',
    parentSource: 'recorded',
    subject: 'Fourth level of the deep stack',
  }),

  // Recorded parent that no longer exists in this repository.
  makeBranch({
    ref: 'refs/heads/feature/orphan',
    name: 'feature/orphan',
    parent: 'feature/deleted-base',
    parentSource: 'recorded',
    subject: 'Parent branch was deleted',
  }),

  // Parent metadata that closes a cycle.
  makeBranch({
    ref: 'refs/heads/feature/cycle-a',
    name: 'feature/cycle-a',
    parent: 'feature/cycle-b',
    parentSource: 'recorded',
    subject: 'First half of a parent cycle',
  }),
  makeBranch({
    ref: 'refs/heads/feature/cycle-b',
    name: 'feature/cycle-b',
    parent: 'feature/cycle-a',
    parentSource: 'recorded',
    subject: 'Second half of a parent cycle',
  }),

  // Long branch and pull-request names.
  makeBranch({
    ref: `refs/heads/${LONG_BRANCH}`,
    name: LONG_BRANCH,
    parent: 'main',
    parentSource: 'recorded',
    subject: LONG_PR_TITLE,
    updatedAt: LATEST,
    pr: makePr({ number: 45, title: LONG_PR_TITLE, head: LONG_BRANCH, checks: 'none' }),
  }),

  // Branch whose parent moved on.
  makeBranch({
    ref: 'refs/heads/feature/restack',
    name: 'feature/restack',
    parent: 'feature/linear-base',
    parentSource: 'recorded',
    subject: 'Parent advanced after this branch was written',
    parentBehind: 3,
    parentTip: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
    needsRestack: true,
    pr: makePr({
      number: 44,
      title: 'Parent advanced after this branch was written',
      head: 'feature/restack',
      checks: 'pending',
    }),
  }),

  // Local branch with configured upstream; the tracked remote row is represented.
  makeBranch({
    ref: 'refs/heads/feature/tracked',
    name: 'feature/tracked',
    parent: 'main',
    parentSource: 'recorded',
    upstream: 'origin/feature/tracked',
    upstreamRef: 'refs/remotes/origin/feature/tracked',
    ahead: 2,
    behind: 1,
    subject: 'Tracked branch with a configured upstream',
  }),
  makeBranch({
    ref: 'refs/remotes/origin/feature/tracked',
    name: 'origin/feature/tracked',
    remote: true,
    subject: 'Tracked branch with a configured upstream',
  }),

  // Local branch with no upstream configuration that still represents its remote.
  makeBranch({
    ref: 'refs/heads/feature/untracked',
    name: 'feature/untracked',
    parent: 'main',
    parentSource: 'recorded',
    upstream: null,
    upstreamRef: null,
    subject: 'Local branch with no upstream configuration',
  }),
  makeBranch({
    ref: 'refs/remotes/origin/feature/untracked',
    name: 'origin/feature/untracked',
    remote: true,
    subject: 'Local branch with no upstream configuration',
  }),

  // Same short name on two remotes: not a consolidation, and ambiguous by name.
  makeBranch({
    ref: 'refs/heads/feature/ambiguous',
    name: 'feature/ambiguous',
    parent: 'main',
    parentSource: 'recorded',
    upstream: 'origin/feature/ambiguous',
    upstreamRef: 'refs/remotes/origin/feature/ambiguous',
    subject: 'Local branch sharing a name with an upstream remote branch',
    pr: makePr({
      number: 48,
      title: 'Closed without merging',
      head: 'feature/ambiguous',
      state: 'CLOSED',
      checks: 'pending',
    }),
  }),
  makeBranch({
    ref: 'refs/remotes/upstream/feature/ambiguous',
    name: 'upstream/feature/ambiguous',
    remote: true,
    subject: 'Remote branch sharing a name with a local branch',
    oid: '99aa88bb77cc66dd55ee44ff33221100aabbccdd',
    pr: makePr({
      number: 47,
      title: 'Remote branch sharing a name with a local branch',
      head: 'upstream/feature/ambiguous',
      checks: 'none',
    }),
  }),

  // Remote-only branches, including the default branch on the remote.
  makeBranch({
    ref: 'refs/remotes/origin/main',
    name: 'origin/main',
    remote: true,
    subject: 'Base branch for the fixture stack',
    oid: '00112233445566778899aabbccddeeff00112233',
  }),
  makeBranch({
    ref: 'refs/remotes/origin/feature/remote-only',
    name: 'origin/feature/remote-only',
    remote: true,
    subject: 'Branch that exists only on the remote',
    oid: 'ffeeddccbbaa99887766554433221100ffeeddcc',
  }),
  makeBranch({
    ref: 'refs/remotes/origin/feature/restack',
    name: 'origin/feature/restack',
    remote: true,
    subject: 'Parent advanced after this branch was written',
  }),
]

export const branchFixtureBranches: Branch[] = branches

export const branchFixtureSnapshot: RepositorySnapshot = {
  path: '/private/tmp/git-stacks-branch-fixture',
  name: 'git-stacks-branch-fixture',
  currentBranch: 'feature/linear-child',
  defaultBranch: 'main',
  remoteUrl: 'git@github.com:howarewoo/git-stacks.git',
  branches,
  pullRequests: branches.flatMap((branch) => (branch.pr ? [branch.pr] : [])),
  files: [],
  stashes: [],
  rebaseInProgress: false,
  operation: null,
  stackOperation: null,
  headOid: '1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d',
  github: { available: true, message: 'GitHub CLI authenticated.' },
}

export const branchFixtureRefs = {
  linearBase: 'refs/heads/feature/linear-base',
  linearChild: 'refs/heads/feature/linear-child',
  deepFourth: 'refs/heads/feature/deep-4',
  deepSecond: 'refs/heads/feature/deep-2',
  deepThird: 'refs/heads/feature/deep-3',
  orphan: 'refs/heads/feature/orphan',
  cycleA: 'refs/heads/feature/cycle-a',
  longName: `refs/heads/${LONG_BRANCH}`,
  restack: 'refs/heads/feature/restack',
  trackedLocal: 'refs/heads/feature/tracked',
  trackedRemote: 'refs/remotes/origin/feature/tracked',
  untrackedLocal: 'refs/heads/feature/untracked',
  untrackedRemote: 'refs/remotes/origin/feature/untracked',
  ambiguousLocal: 'refs/heads/feature/ambiguous',
  ambiguousRemote: 'refs/remotes/upstream/feature/ambiguous',
  remoteOnly: 'refs/remotes/origin/feature/remote-only',
} as const
