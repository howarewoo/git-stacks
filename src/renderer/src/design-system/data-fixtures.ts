import type { RepositoryCapabilities } from '../../../shared/capabilities'
import type {
  ChangedFile,
  Commit,
  DiffHunk,
  DiffHunkLine,
  FileHunks,
  FileView,
  HunkSide,
  PullRequest,
  RepositorySnapshot,
  Stash,
} from '../../../shared/types'
import { EMPTY_SNAPSHOT_LIMITS } from '../../../shared/performance'

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
    limits: EMPTY_SNAPSHOT_LIMITS,
    capabilities: standardCapabilities,
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

function hunkLine(kind: DiffHunkLine['kind'], text: string, line: number): DiffHunkLine {
  return {
    kind,
    text,
    oldLine: kind === 'add' ? line - 1 : kind === 'marker' ? null : line,
    newLine: kind === 'remove' ? line - 1 : kind === 'marker' ? null : line,
  }
}

function hunk(id: string, oldStart: number, entries: DiffHunkLine[]): DiffHunk {
  return {
    id,
    header: `@@ -${oldStart},2 +${oldStart},2 @@`,
    oldStart,
    oldLines: 2,
    newStart: oldStart,
    newLines: 2,
    lines: entries,
  }
}

function hunks(
  staged: { hunks: DiffHunk[]; unavailable: string | null },
  unstaged: { hunks: DiffHunk[]; unavailable: string | null },
): FileHunks {
  return { staged, unstaged }
}

const noStagedHunks: HunkSide = { hunks: [], unavailable: 'Nothing is staged in this file yet.' }
const noWorktreeHunks: HunkSide = {
  hunks: [],
  unavailable: 'The working tree matches the index for this file.',
}
const renameHunks: HunkSide = {
  hunks: [],
  unavailable: 'A rename is staged or unstaged as a whole file so both paths stay consistent.',
}
const conflictHunks: HunkSide = {
  hunks: [],
  unavailable: 'Resolve this conflict before applying individual hunks.',
}
const binaryHunks: HunkSide = {
  hunks: [],
  unavailable: 'This file is binary, so it cannot be patched hunk by hunk.',
}
const oversizedHunks: HunkSide = {
  hunks: [],
  unavailable: 'This diff is too large to apply safely. Stage or unstage the whole file instead.',
}

const stagedHunk = hunk('a1b2c3d4e5f60718', 1, [
  hunkLine('remove', '-old staged line', 1),
  hunkLine('add', '+new staged line', 1),
])
const worktreeHunk = hunk('0f1e2d3c4b5a697', 8, [
  hunkLine('remove', '-old worktree line', 8),
  hunkLine('add', '+new worktree line', 8),
  hunkLine('context', ' trailing context', 9),
])

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
    hunks: hunks(renameHunks, noWorktreeHunks),
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
    hunks: hunks(conflictHunks, conflictHunks),
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
    hunks: hunks(noStagedHunks, binaryHunks),
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
    hunks: hunks(noStagedHunks, oversizedHunks),
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
    hunks: hunks(
      { hunks: [stagedHunk], unavailable: null },
      { hunks: [worktreeHunk], unavailable: null },
    ),
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
