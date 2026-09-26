import type {
  ChangedFile,
  Commit,
  FileView,
  PullRequest,
  RepositorySnapshot,
  Stash,
} from '../../../shared/types'

const baseBranches = [
  {
    ref: 'refs/heads/feature/data-surfaces',
    name: 'feature/data-surfaces',
    current: true,
    remote: false,
    upstream: 'origin/feature/data-surfaces',
    upstreamRef: 'refs/remotes/origin/feature/data-surfaces',
    ahead: 2,
    behind: 0,
    subject: 'Migrate data surfaces to the shared workbench',
    updatedAt: '2026-09-25T09:00:00.000Z',
    parent: 'main',
    parentBehind: 0,
    pr: null,
    oid: '0f1e2d3c4b5a69788796a5b4c3d2e1f001122334',
  },
  {
    ref: 'refs/heads/main',
    name: 'main',
    current: false,
    remote: false,
    upstream: 'origin/main',
    upstreamRef: 'refs/remotes/origin/main',
    ahead: 0,
    behind: 0,
    subject: 'Bump baseline',
    updatedAt: '2026-09-24T09:00:00.000Z',
    parent: null,
    parentBehind: null,
    pr: null,
    oid: '9988776655443322110ffeeddccbbaa99887766',
  },
]

function snapshot(
  files: ChangedFile[],
  overrides: Partial<RepositorySnapshot> = {},
): RepositorySnapshot {
  return {
    path: '/private/tmp/git-stacks-issue-7-fixture/git-stacks',
    name: 'git-stacks',
    currentBranch: 'feature/data-surfaces',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:howarewoo/git-stacks.git',
    branches: baseBranches,
    pullRequests: [],
    files,
    stashes: [],
    rebaseInProgress: false,
    operation: null,
    stackOperation: null,
    headOid: '0f1e2d3c4b5a69788796a5b4c3d2e1f001122334',
    github: { available: true, message: 'GitHub metadata available; 0 pull requests' },
    ...overrides,
  }
}

/** Working-tree row builder shared by the specimens and the renderer fixture gallery. */
export const changedFile = (
  path: string,
  index: string,
  worktree: string,
  extra: Partial<ChangedFile> = {},
): ChangedFile => ({ path, index, worktree, conflicted: false, ...extra })

const file = changedFile

/** Staged, unstaged, untracked, renamed, and conflicted files in one working tree. */
export const mixedChanges: ChangedFile[] = [
  file('src/renderer/src/components/data-views.tsx', 'M', 'M'),
  file('src/renderer/src/components/repository-views.tsx', 'M', ' '),
  file('src/renderer/src/styles.css', ' ', 'M'),
  file('DESIGN.md', ' ', 'M'),
  file('src/renderer/src/lib/pull-request-state.ts', '?', ' '),
  file('src/renderer/src/components/legacy-views.tsx', 'R', ' ', {
    originalPath: 'src/renderer/src/components/old-views.tsx',
  }),
  file('src/renderer/src/components/conflicted.tsx', 'U', 'U', { conflicted: true }),
]

export const stagedOnlyChanges: ChangedFile[] = [
  file('src/renderer/src/components/data-views.tsx', 'A', ' '),
  file('src/renderer/src/components/repository-views.tsx', 'M', ' '),
]

export const unstagedOnlyChanges: ChangedFile[] = [
  file('src/renderer/src/styles.css', ' ', 'M'),
  file('DESIGN.md', ' ', 'M'),
]

export const conflictedChanges: ChangedFile[] = [
  file('src/renderer/src/components/conflicted.tsx', 'U', 'U', { conflicted: true }),
  file('src/renderer/src/styles.css', ' ', 'M'),
]

export const cleanChanges: ChangedFile[] = []

export const changesFixtures = {
  clean: cleanChanges,
  stagedOnly: stagedOnlyChanges,
  unstagedOnly: unstagedOnlyChanges,
  mixed: mixedChanges,
  conflicted: conflictedChanges,
}

export const changesSnapshots = {
  clean: snapshot(cleanChanges),
  stagedOnly: snapshot(stagedOnlyChanges),
  unstagedOnly: snapshot(unstagedOnlyChanges),
  mixed: snapshot(mixedChanges),
  conflicted: snapshot(conflictedChanges),
  filtered: snapshot(mixedChanges),
  onDefaultBranch: snapshot(stagedOnlyChanges, { currentBranch: 'main' }),
}

const pullRequest = (
  overrides: Partial<PullRequest> & Pick<PullRequest, 'number'>,
): PullRequest => ({
  title: `Pull request #${overrides.number}`,
  url: `https://github.com/howarewoo/git-stacks/pull/${overrides.number}`,
  head: 'feature/data-surfaces',
  base: 'main',
  state: 'OPEN',
  draft: false,
  checks: 'passing',
  ...overrides,
})

export const pullRequestFixtures = [
  pullRequest({ number: 42, title: 'Migrate changes, diff, history, PR, and stash surfaces' }),
  pullRequest({
    number: 43,
    title: 'Draft: split the file inspector',
    draft: true,
    checks: 'pending',
  }),
  pullRequest({
    number: 44,
    title: 'Closed work that is no longer needed',
    state: 'CLOSED',
    checks: 'none',
  }),
  pullRequest({
    number: 45,
    title: 'Merged: design foundations',
    state: 'MERGED',
    checks: 'failing',
    reviewDecision: 'CHANGES_REQUESTED',
  }),
  pullRequest({
    number: 46,
    title:
      'Approved stack preview with a very long title that must stay readable at the minimum window width and at 200% zoom without truncating the action targets',
    checks: 'passing',
    reviewDecision: 'APPROVED',
    mergeState: 'CLEAN',
  }),
  pullRequest({
    number: 47,
    title: 'Review decision not reported by GitHub',
    checks: 'pending',
    reviewDecision: 'REVIEW_REQUIRED',
  }),
]

export const pullRequestSnapshots = {
  available: snapshot(cleanChanges, { pullRequests: pullRequestFixtures }),
  empty: snapshot(cleanChanges),
  filtered: snapshot(cleanChanges, { pullRequests: pullRequestFixtures }),
  unavailable: snapshot(cleanChanges, {
    github: {
      available: false,
      message: 'GitHub metadata unavailable: the gh CLI is not installed',
    },
  }),
}

export const stashFixtures: Stash[] = [
  {
    ref: 'stash@{0}',
    oid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
    message: 'WIP on feature: inspector tabs',
  },
  {
    ref: 'stash@{1}',
    oid: 'f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d',
    message: 'Save stash with a long message that has to stay readable at the minimum window width',
  },
]

export const stashSnapshots = {
  present: snapshot(cleanChanges, { stashes: stashFixtures }),
  empty: snapshot(cleanChanges),
}

export const longDiffText = [
  'diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css',
  'index 1111111..2222222 100644',
  '--- a/src/renderer/src/styles.css',
  '+++ b/src/renderer/src/styles.css',
  '@@ -120,6 +120,7 @@ .changes-columns {',
  '   display: grid;',
  '-  gap: 15px;',
  '+  gap: 16px;',
  '+  border: 1px solid var(--gs-semantic-border-essential);',
  '   overflow: auto;',
  `+${'x'.repeat(400)}`,
  '@@ -240,3 +241,3 @@ .code-diff {',
  '-  background: #fafbfc;',
  '+  background: var(--gs-semantic-surface-inset);',
].join('\n')

export const largeDiffText = Array.from({ length: 2400 }, (_, index) => `+line ${index + 1}`).join(
  '\n',
)

export const fileViewFixtures: Record<string, FileView> = {
  rename: {
    path: 'src/renderer/src/components/legacy-views.tsx',
    stagedDiff: '',
    unstagedDiff: '',
    content: 'export const legacy = true\n',
    binary: false,
    fingerprint: 'fingerprint-legacy',
    conflicted: false,
    truncated: false,
  },
  conflicted: {
    path: 'src/renderer/src/components/conflicted.tsx',
    stagedDiff: '',
    unstagedDiff: '',
    content:
      '<<<<<<< HEAD\nexport const value = 1\n=======\nexport const value = 2\n>>>>>>> feature\n',
    binary: false,
    fingerprint: 'fingerprint-conflict',
    conflicted: true,
    truncated: false,
  },
  binary: {
    path: 'resources/icon.icns',
    stagedDiff: '',
    unstagedDiff: '',
    content: null,
    binary: true,
    fingerprint: 'fingerprint-binary',
    conflicted: false,
    truncated: false,
  },
  truncated: {
    path: 'src/renderer/src/components/big-file.tsx',
    stagedDiff: '',
    unstagedDiff: longDiffText,
    content: 'x'.repeat(2000),
    binary: false,
    fingerprint: 'fingerprint-truncated',
    conflicted: false,
    truncated: true,
  },
  bothSides: {
    path: 'src/renderer/src/components/data-views.tsx',
    stagedDiff:
      '--- a/data-views.tsx\n+++ b/data-views.tsx\n@@ -1,2 +1,2 @@\n-old staged line\n+new staged line\n',
    unstagedDiff:
      '--- a/data-views.tsx\n+++ b/data-views.tsx\n@@ -8,2 +8,2 @@\n-old worktree line\n+new worktree line\n',
    content: 'new worktree line\n',
    binary: false,
    fingerprint: 'fingerprint-both',
    conflicted: false,
    truncated: false,
  },
}

export const historyCommits: Commit[] = [
  {
    oid: '0f1e2d3c4b5a69788796a5b4c3d2e1f001122334',
    parents: ['9988776655443322110ffeeddccbbaa99887766'],
    subject: 'Migrate changes, diff, history, PR, and stash surfaces',
    author: 'Ada Lovelace',
    date: '2026-09-25T09:00:00.000Z',
  },
  {
    oid: '1122334455667788990011223344556677889900',
    parents: ['9988776655443322110ffeeddccbbaa99887766'],
    subject:
      'Add a commit subject that is intentionally long so the history row hierarchy stays readable at the minimum window size',
    author: 'Grace Hopper',
    date: '2026-09-24T17:30:00.000Z',
  },
  {
    oid: '5566778899001122334455667788990011223344',
    parents: [],
    subject: 'Establish the semantic token source of truth',
    author: 'Alan Turing',
    date: '2026-09-20T11:15:00.000Z',
  },
]
