import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ChangesView,
  PullRequestListView,
  StashesView,
  changeGroups,
  changePaths,
  matchesPullRequest,
} from '../src/renderer/src/components/data-views'
import { DiffView, StackView, diffLineKind } from '../src/renderer/src/components/repository-views'
import { ReconciliationPanel } from '../src/renderer/src/components/reconciliation-view'
import { RepositoryHoverCardProvider } from '../src/renderer/src/components/repository-hover-cards'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import {
  changesSnapshots,
  largeDiffText,
  longDiffText,
  pullRequestSnapshots,
  stashSnapshots,
} from '../src/renderer/src/design-system/data-fixtures'
import type { RepositorySnapshot } from '../src/shared/types'

const noopRunAction = async () => true
const noopRequest = () => undefined

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(RepositoryHoverCardProvider, null, element),
    ),
  )
}

function changes(
  snapshot: RepositorySnapshot,
  search = '',
  overrides: Record<string, unknown> = {},
) {
  return render(
    React.createElement(ChangesView, {
      actionError: null,
      busy: false,
      busyAction: null,
      commitAmend: false,
      commitMessage: '',
      groups: changeGroups(snapshot.files, search),
      inspectedPath: null,
      onCommitAmendChange: () => undefined,
      onResolveConflict: () => undefined,
      onCommitMessageChange: () => undefined,
      onInspect: () => undefined,
      onStash: () => undefined,
      onSubmitCommit: (event: React.FormEvent<HTMLFormElement>) => event.preventDefault(),
      operationActive: false,
      runAction: noopRunAction,
      snapshot,
      ...overrides,
    }),
  )
}

test('change groups separate staged, unstaged, untracked, renamed, and conflicted files', () => {
  const groups = changeGroups(changesSnapshots.mixed.files, '')

  assert.deepEqual(
    groups.staged.map((file) => file.path),
    [
      'src/renderer/src/components/data-views.tsx',
      'src/renderer/src/components/repository-views.tsx',
      'src/renderer/src/components/legacy-views.tsx',
      'src/renderer/src/components/conflicted.tsx',
    ],
  )
  assert.deepEqual(
    groups.unstaged.map((file) => file.path),
    [
      'src/renderer/src/components/data-views.tsx',
      'src/renderer/src/styles.css',
      'DESIGN.md',
      'src/renderer/src/lib/pull-request-state.ts',
      'src/renderer/src/components/conflicted.tsx',
    ],
  )
  assert.deepEqual(
    groups.conflicted.map((file) => file.path),
    ['src/renderer/src/components/conflicted.tsx'],
  )
})

test('a filtered bulk action only covers the visible files', () => {
  const groups = changeGroups(changesSnapshots.mixed.files, 'styles')

  assert.deepEqual(
    groups.visibleStaged.map((file) => file.path),
    [],
  )
  assert.deepEqual(
    groups.visibleUnstaged.map((file) => file.path),
    ['src/renderer/src/styles.css'],
  )
  assert.deepEqual(changePaths(groups.visibleUnstaged), ['src/renderer/src/styles.css'])
  assert.ok(
    !changePaths(groups.visibleUnstaged).includes('DESIGN.md'),
    'a hidden file must not be staged by a filtered bulk action',
  )
})

test('rename paths keep both the original and the new path', () => {
  const groups = changeGroups(changesSnapshots.mixed.files, 'legacy')
  const renamed = groups.staged.find((file) => file.path.includes('legacy-views'))

  assert.ok(renamed, 'the renamed file stays in the staged group')
  assert.deepEqual(changePaths([renamed!]), [
    'src/renderer/src/components/legacy-views.tsx',
    'src/renderer/src/components/old-views.tsx',
  ])
  assert.equal(
    changePaths([{ path: 'a', originalPath: 'b', index: 'R', worktree: ' ', conflicted: false }])
      .length,
    2,
  )
})

test('the rename row shows the original path and the new path', () => {
  const markup = changes(changesSnapshots.mixed)

  assert.match(markup, /src\/renderer\/src\/components\/old-views\.tsx/)
  assert.match(markup, /src\/renderer\/src\/components\/legacy-views\.tsx/)
  assert.match(markup, /class="file-path-original"/)
})

test('clean, staged-only, unstaged-only, and filtered states each read truthfully', () => {
  assert.match(changes(changesSnapshots.clean), /Your working tree is clean\./)
  assert.match(
    changes(changesSnapshots.clean),
    /Stage files from the working tree to prepare a commit\./,
  )
  assert.match(changes(changesSnapshots.stagedOnly), /2 files ready to commit/)
  assert.match(changes(changesSnapshots.unstagedOnly), /0 files ready to commit/)

  const filtered = changes(changesSnapshots.filtered, 'styles')
  assert.match(filtered, /Stage shown/)
  assert.match(filtered, /Unstage shown/)
  assert.match(filtered, /No staged files match your search\./)
  assert.ok(!filtered.includes('DESIGN.md'))
})

test('a conflicted file blocks bulk staging and says why', () => {
  const markup = changes(changesSnapshots.conflicted)

  assert.match(markup, /Resolve conflicts before staging/)
  assert.match(markup, /class="file-status file-status-conflicted"/)
  assert.match(markup, /aria-label="Resolve src\/renderer\/src\/components\/conflicted\.tsx"/)
})

test('a file with staged and unstaged edits reports both index and worktree status', () => {
  const markup = changes(changesSnapshots.mixed)

  assert.match(markup, /title="Index M, worktree M"/)
  assert.match(markup, /title="Index M, worktree ·"/)
  assert.match(markup, /title="Index ·, worktree M"/)
  assert.match(markup, /title="Index R, worktree ·"/)
  assert.match(markup, /title="Index U, worktree ·"/, 'an untracked file is labelled, not hidden')
  assert.match(
    markup,
    /title="Conflict"/,
    'a conflicted file names the conflict instead of a status pair',
  )
})

test('the commit form keeps the message, gates on staged files, and reviews an amend', () => {
  const disabled = changes(changesSnapshots.clean, '', { commitMessage: 'kept on failure' })
  assert.match(disabled, />kept on failure</, 'the rejected message stays in the field')
  assert.match(disabled, /<textarea[^>]*disabled/)
  assert.match(disabled, /<button[^>]*disabled[^>]*>(?:<svg[\s\S]*?<\/svg>)?Commit<\/button>/)

  const amendable = changes(changesSnapshots.clean, '', {
    commitAmend: true,
    commitMessage: 'replacement message',
  })
  assert.match(amendable, /Review the rewritten commit before it is applied\./)
  assert.match(amendable, /Review amend…/)
  assert.ok(!/<button[^>]*disabled[^>]*>Review amend/.test(amendable))

  const onDefault = changes(changesSnapshots.onDefaultBranch, '', { commitAmend: true })
  assert.match(onDefault, /\(protected on default branch\)/)
  assert.match(
    onDefault,
    /<input[^>]*id="commit-amend"[^>]*disabled/,
    'amend cannot be switched on from the default branch',
  )
})

test('visual selection is never presented as staging', () => {
  const markup = changes(changesSnapshots.mixed)

  assert.ok(!markup.includes('staged-selected'))
  assert.ok(!markup.includes('file-row-selected'))
  assert.match(markup, /aria-label="Inspect src\/renderer\/src\/styles\.css"/)
})

test('diff line kinds follow the literal unified-diff markers', () => {
  assert.equal(diffLineKind('+added'), 'add')
  assert.equal(diffLineKind('-removed'), 'remove')
  assert.equal(diffLineKind('@@ -1,2 +1,2 @@'), 'hunk')
  assert.equal(diffLineKind('+++ b/file'), null)
  assert.equal(diffLineKind('--- a/file'), null)
  assert.equal(diffLineKind(' context'), null)
})

test('the diff keeps the literal text and adds colour as a supplement', () => {
  const markup = render(React.createElement(DiffView, { text: longDiffText }))

  assert.match(markup, /class="diff-add"/)
  assert.match(markup, /class="diff-remove"/)
  assert.match(markup, /class="diff-hunk"/)
  assert.ok(markup.includes('+  gap: 16px;'), 'the added line keeps its + marker')
  assert.ok(markup.includes('-  gap: 15px;'), 'the removed line keeps its - marker')
  assert.ok(
    markup.includes('@@ -120,6 +120,7 @@ .changes-columns {'),
    'the hunk header is preserved',
  )
  assert.ok(markup.includes('x'.repeat(400)), 'a very long line is not wrapped or truncated')
})

test('a newline-terminated diff does not count a trailing empty line', () => {
  const markup = render(React.createElement(DiffView, { text: '+added\n' }))

  assert.match(markup, /1 added · 0 removed · 1 of 1 lines/)
  assert.match(markup, /aria-label="Unified diff, 1 of 1 lines shown"/)
})

test('a large diff is bounded and revealed incrementally', () => {
  const markup = render(React.createElement(DiffView, { text: largeDiffText }))

  assert.match(markup, /1000 of 2400 lines/)
  assert.ok(!markup.includes('line 2400'), 'later lines wait for the reveal control')
  assert.match(markup, /Show more diff lines \(1400 remaining\)/)
})

test('a truncated diff and an empty preview are labelled rather than implied', () => {
  const truncated = render(React.createElement(DiffView, { text: longDiffText, truncated: true }))
  assert.match(truncated, /truncated preview/)
  assert.match(truncated, /This preview is truncated\./)

  const empty = render(React.createElement(DiffView, { text: '' }))
  assert.match(empty, /No textual diff in this view\./)
  assert.match(empty, /No textual diff<\/span>/)
})

test('the code region is keyboard reachable and labelled for assistive technology', () => {
  const markup = render(React.createElement(DiffView, { text: longDiffText }))

  assert.match(markup, /role="region"/)
  assert.match(markup, /tabindex="0"/)
  assert.match(markup, /aria-label="Unified diff, 14 of 14 lines shown"/)
})

test('unavailable GitHub data is never counted as zero pull requests', () => {
  const markup = render(
    React.createElement(PullRequestListView, {
      busy: false,
      canCreate: false,
      createTooltip: 'Connect an authenticated GitHub repository to create pull requests.',
      onCreate: () => undefined,
      onRequest: noopRequest,
      pullRequests: [],
      snapshot: pullRequestSnapshots.unavailable,
    }),
  )

  assert.match(markup, /GitHub data unavailable/)
  assert.match(markup, /Pull requests unavailable/)
  assert.match(markup, /count is unknown rather than zero/)
  assert.ok(!markup.includes('0 shown'))
})

test('a genuinely empty list and a filtered empty list are different states', () => {
  const empty = render(
    React.createElement(PullRequestListView, {
      busy: false,
      canCreate: true,
      createTooltip: 'Create a pull request.',
      onCreate: () => undefined,
      onRequest: noopRequest,
      pullRequests: [],
      snapshot: pullRequestSnapshots.empty,
    }),
  )
  assert.match(empty, /No pull requests/)
  assert.match(empty, /0 shown/)

  const filtered = render(
    React.createElement(PullRequestListView, {
      busy: false,
      canCreate: true,
      createTooltip: 'Create a pull request.',
      onCreate: () => undefined,
      onRequest: noopRequest,
      pullRequests: [],
      snapshot: pullRequestSnapshots.filtered,
    }),
  )
  assert.match(filtered, /No matching pull requests/)
  assert.match(filtered, /Change or clear the search/)
})

test('reconciliation shows local-only stacks separately from matching submitted stacks', () => {
  const snapshot: RepositorySnapshot = {
    ...pullRequestSnapshots.available,
    reconciliation: {
      available: true,
      message: 'Submitted stacks match the local graph.',
      blockers: [],
      evidence: null,
      stacks: [
        {
          key: 'local:feature/local',
          base: 'main',
          stackNumber: null,
          stackUrl: null,
          state: 'local-only',
          summary: 'Local metadata only; nothing was submitted.',
          submittedOrder: [],
          members: [],
          repairs: [],
          blockers: [],
        },
        {
          key: 'native:9',
          base: 'main',
          stackNumber: 9,
          stackUrl: null,
          state: 'matching',
          summary: 'Submitted order and ancestry agree.',
          submittedOrder: ['feature/submitted'],
          members: [],
          repairs: [],
          blockers: [],
        },
      ],
    },
  }
  const markup = render(
    React.createElement(ReconciliationPanel, {
      snapshot,
      busy: false,
      runAction: noopRunAction,
      actionError: null,
      onClearActionError: () => undefined,
    }),
  )
  assert.match(markup, /Local stack/)
  assert.match(markup, /Local only/)
  assert.match(markup, /GitHub stack #9/)
  assert.match(markup, /Matching/)
  assert.ok(!markup.includes('No local or submitted stack relationships were found'))
})

test('lifecycle, checks, and review stay independent and always carry a label', () => {
  const markup = render(
    React.createElement(PullRequestListView, {
      busy: false,
      canCreate: true,
      createTooltip: 'Create a pull request.',
      onCreate: () => undefined,
      onRequest: noopRequest,
      pullRequests: pullRequestSnapshots.available.pullRequests,
      snapshot: pullRequestSnapshots.available,
    }),
  )

  for (const label of [
    'draft',
    '>open<',
    '>closed<',
    '>merged<',
    'checks passing',
    'checks failing',
    'checks pending',
    'no checks',
    'review approved',
    'changes requested',
    'review required',
  ]) {
    assert.ok(markup.includes(label), `expected the ${label} label in the pull request list`)
  }
  assert.match(markup, /aria-label="Open pull request #42 [^"]+, open"/)
})

test('pull request search keeps its own filter and reports no matches', () => {
  const snapshot = pullRequestSnapshots.available
  assert.equal(matchesPullRequest(snapshot.pullRequests[0], ''), true)
  assert.equal(matchesPullRequest(snapshot.pullRequests[0], 'MIGRATE'), true)
  assert.equal(matchesPullRequest(snapshot.pullRequests[0], '#42'), true)
  assert.equal(matchesPullRequest(snapshot.pullRequests[0], 'does-not-exist'), false)
})

test('stash rows show the ref and OID with distinct action labels', () => {
  const snapshot = stashSnapshots.present
  const markup = render(
    React.createElement(StashesView, {
      busy: false,
      busyAction: null,
      onRequest: noopRequest,
      onStash: () => undefined,
      operationActive: false,
      runAction: noopRunAction,
      snapshot,
    }),
  )

  assert.match(markup, /stash@\{0\}/)
  assert.match(markup, /a1b2c3d4/)
  assert.match(markup, /aria-label="Apply stash@\{0\}"/)
  assert.match(markup, /aria-label="Pop stash@\{0\}"/)
  assert.match(markup, /aria-label="Drop stash@\{0\}"/)
})

test('truncated changes disable stash creation in both data views', () => {
  const snapshot = {
    ...changesSnapshots.mixed,
    limits: { ...changesSnapshots.mixed.limits, filesTruncated: true },
  }
  const stashMarkup = render(
    React.createElement(StashesView, {
      busy: false,
      busyAction: null,
      onRequest: noopRequest,
      onStash: () => undefined,
      operationActive: false,
      runAction: noopRunAction,
      snapshot,
    }),
  )
  assert.match(
    changes(snapshot),
    /<button[^>]*disabled[^>]*>[^<]*<svg[\s\S]*?Stash changes<\/button>/,
  )
  assert.match(stashMarkup, /Stash unavailable while the changed-file listing is incomplete/)
  assert.match(stashMarkup, /<button[^>]*disabled[^>]*>[\s\S]*?Stash current changes<\/button>/)
})

test('unmeasured parent comparison is not presented as publish-ready', () => {
  const snapshot = {
    ...changesSnapshots.clean,
    branches: [
      {
        ...changesSnapshots.clean.branches[0],
        ref: 'refs/heads/feature/unmeasured',
        name: 'feature/unmeasured',
        current: true,
        parent: changesSnapshots.clean.defaultBranch,
        parentBehind: null,
        needsRestack: false,
      },
    ],
    currentBranch: 'feature/unmeasured',
  }
  const markup = render(
    React.createElement(StackView, {
      snapshot,
      runAction: noopRunAction,
      actionError: null,
      onClearActionError: () => undefined,
      busy: false,
      onRequest: noopRequest,
      onSelect: () => undefined,
      onCreate: () => undefined,
      search: '',
    }),
  )
  assert.match(markup, /Parent comparison unavailable/)
  assert.match(markup, /Check ancestry before publishing/)
  assert.doesNotMatch(markup, /Review the stack, publish its PRs/)
})

test('an empty stash list states the recovery instead of a count of zero actions', () => {
  const markup = render(
    React.createElement(StashesView, {
      busy: false,
      busyAction: null,
      onRequest: noopRequest,
      onStash: () => undefined,
      operationActive: false,
      runAction: noopRunAction,
      snapshot: stashSnapshots.empty,
    }),
  )

  assert.match(markup, /No stashes/)
  assert.match(markup, /Stash changes before switching context/)
})
