import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SHORTCUTS,
  assignShortcut,
  chordFromEvent,
  canonicalChord,
  detectShortcutConflicts,
  formatChord,
  matchesChord,
  loadShortcuts,
  resetShortcuts,
  saveShortcuts,
  type ShortcutId,
} from '../src/renderer/src/lib/keyboard-shortcuts'
import {
  buildPaletteItems,
  groupPaletteItems,
  rankPaletteItems,
  type PaletteItem,
} from '../src/renderer/src/lib/command-palette'
import { resolveStackNavigation } from '../src/renderer/src/lib/stack-navigation'
import type { Branch, RepositorySnapshot } from '../src/shared/types'

function makeMockBranch(name: string, overrides: Partial<Branch> = {}): Branch {
  return {
    ref: `refs/heads/${name}`,
    name,
    current: false,
    remote: false,
    upstream: null,
    upstreamRef: null,
    ahead: 0,
    behind: 0,
    subject: `Commit on ${name}`,
    updatedAt: new Date(Date.now() - 60000).toISOString(),
    parent: null,
    parentBehind: 0,
    pr: null,
    oid: 'abcdef1234567890',
    ...overrides,
  }
}

function makeMockSnapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  const main = makeMockBranch('main', { current: true })
  const feature1 = makeMockBranch('feature-1', { parent: 'main' })
  const feature2 = makeMockBranch('feature-2', { parent: 'feature-1' })

  return {
    path: '/mock/repo',
    name: 'mock-repo',
    currentBranch: 'main',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/example/mock-repo.git',
    branches: [main, feature1, feature2],
    pullRequests: [
      {
        number: 42,
        title: 'Add great feature',
        url: 'https://github.com/example/mock-repo/pull/42',
        head: 'feature-1',
        base: 'main',
        state: 'OPEN',
        draft: false,
        checks: 'passing',
      },
    ],
    files: [],
    stashes: [],
    rebaseInProgress: false,
    operation: null,
    stackOperation: null,
    headOid: 'abcdef1234567890',
    github: { available: true, message: '' },
    ...overrides,
  }
}

// =============================================================================
// 1. Shortcut collisions and conflict detection
// =============================================================================

test('detectShortcutConflicts detects duplicate canonical shortcuts across bindings', () => {
  const bindings: Partial<Record<ShortcutId, string>> = {
    'palette.open': 'Mod+K',
    'search.focus': 'Mod+K', // Collides with palette.open
  }

  const conflicts = detectShortcutConflicts(bindings)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].idA, 'palette.open')
  assert.equal(conflicts[0].idB, 'search.focus')
  assert.equal(conflicts[0].chord, 'Mod+k')
})

test('detectShortcutConflicts treats platform and case aliases as the same canonical chord', () => {
  const bindings: Partial<Record<ShortcutId, string>> = {
    'view.branches': 'Ctrl+Shift+B',
    'view.stacks': 'Mod+Shift+b', // Equivalent chord
  }

  const conflicts = detectShortcutConflicts(bindings)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].chord, 'Mod+Shift+b')
})

test('assignShortcut rejects reassigning to an in-use shortcut and reports conflict identity', () => {
  const current: Record<ShortcutId, string> = {
    'palette.open': 'Mod+k',
    'search.focus': '/',
    'stack.selectParent': 'Alt+ArrowUp',
    'stack.selectChild': 'Alt+ArrowDown',
    'stack.selectTop': 'Alt+Shift+ArrowUp',
    'stack.selectBottom': 'Alt+Shift+ArrowDown',
    'stack.checkout': 'Mod+Enter',
    'stack.restack': 'Mod+Shift+R',
    'stack.sync': 'Mod+Shift+S',
    'stack.openPr': 'Mod+Shift+P',
    'view.branches': 'Mod+1',
    'view.stacks': 'Mod+2',
    'view.history': 'Mod+3',
    'view.changes': 'Mod+4',
    'view.pullRequests': 'Mod+5',
    'view.stashes': 'Mod+6',
  }

  // Attempt to assign 'Mod+1' (already view.branches) to view.stacks
  const result = assignShortcut(current, 'view.stacks', 'Mod+1')
  assert.ok(result.conflict)
  assert.equal(result.conflict?.conflictingId, 'view.branches')
  assert.equal(result.conflict?.chord, 'Mod+1')
  // Original bindings are unchanged on collision
  assert.equal(result.bindings['view.stacks'], 'Mod+2')
})

test('assignShortcut succeeds and updates bindings when chord is available', () => {
  const current: Record<ShortcutId, string> = {
    'palette.open': 'Mod+k',
    'search.focus': '/',
    'stack.selectParent': 'Alt+ArrowUp',
    'stack.selectChild': 'Alt+ArrowDown',
    'stack.selectTop': 'Alt+Shift+ArrowUp',
    'stack.selectBottom': 'Alt+Shift+ArrowDown',
    'stack.checkout': 'Mod+Enter',
    'stack.restack': 'Mod+Shift+R',
    'stack.sync': 'Mod+Shift+S',
    'stack.openPr': 'Mod+Shift+P',
    'view.branches': 'Mod+1',
    'view.stacks': 'Mod+2',
    'view.history': 'Mod+3',
    'view.changes': 'Mod+4',
    'view.pullRequests': 'Mod+5',
    'view.stashes': 'Mod+6',
  }

  const result = assignShortcut(current, 'palette.open', 'Mod+Shift+P')
  // Mod+Shift+P is stack.openPr!
  assert.ok(result.conflict)

  const cleanResult = assignShortcut(current, 'palette.open', 'Mod+Shift+O')
  assert.equal(cleanResult.conflict, null)
  assert.equal(cleanResult.bindings['palette.open'], 'Mod+Shift+o')
})

test('parseChord and formatChord format shortcuts consistently across platforms', () => {
  const macChord = formatChord('Mod+Shift+K', true)
  assert.equal(macChord, '⇧⌘K')

  const winChord = formatChord('Mod+Shift+K', false)
  assert.equal(winChord, 'Ctrl+Shift+K')

  assert.equal(formatChord('/', true), '/')
  assert.equal(formatChord('Alt+ArrowUp', true), '⌥↑')
  assert.equal(formatChord('Alt+ArrowUp', false), 'Alt+Up')
})

test('shifted letter shortcuts record and dispatch distinctly from unshifted bindings', () => {
  for (const isMac of [true, false]) {
    const event = {
      key: 'R',
      metaKey: isMac,
      ctrlKey: !isMac,
      shiftKey: true,
    }
    const recorded = chordFromEvent(event, isMac)
    assert.equal(recorded, 'Mod+Shift+r')
    assert.equal(matchesChord(event, recorded!, isMac), true)
    assert.equal(matchesChord(event, 'Mod+r', isMac), false)
    assert.equal(matchesChord({ ...event, key: 'r', shiftKey: false }, 'Mod+Shift+r', isMac), false)

    const assigned = assignShortcut(DEFAULT_SHORTCUTS, 'palette.open', 'Mod+r')
    assert.equal(assigned.conflict, null)
    assert.equal(detectShortcutConflicts(assigned.bindings).length, 0)
    assert.equal(matchesChord(event, assigned.bindings['palette.open'], isMac), false)
    assert.equal(matchesChord(event, assigned.bindings['stack.restack'], isMac), true)
    assert.equal(
      assignShortcut(assigned.bindings, 'palette.open', recorded!).conflict?.conflictingId,
      'stack.restack',
    )
  }
})
test('symbol keys requiring Shift match and collide as printable characters, unlike letters', () => {
  for (const isMac of [true, false]) {
    const slash = { key: '/', shiftKey: true, metaKey: false, ctrlKey: false }
    assert.equal(chordFromEvent(slash, isMac), '/')
    assert.equal(matchesChord(slash, DEFAULT_SHORTCUTS['search.focus'], isMac), true)
    assert.equal(canonicalChord('Shift+/'), '/')
    assert.equal(
      assignShortcut(DEFAULT_SHORTCUTS, 'palette.open', 'Shift+/').conflict?.conflictingId,
      'search.focus',
    )
    const shiftedLetter = { key: 'R', shiftKey: true, metaKey: isMac, ctrlKey: !isMac }
    assert.equal(matchesChord(shiftedLetter, 'Mod+r', isMac), false)
    assert.equal(matchesChord(shiftedLetter, 'Mod+Shift+r', isMac), true)
  }
})

test('recording preserves key identity through conflicts, storage and reset on either platform', () => {
  for (const isMac of [true, false]) {
    const nonPrimary = { key: 'k', ctrlKey: isMac, metaKey: !isMac }
    assert.equal(chordFromEvent(nonPrimary, isMac), null)
    assert.equal(matchesChord(nonPrimary, 'k', isMac), false)
    assert.equal(
      matchesChord({ ...nonPrimary, ctrlKey: true, metaKey: true }, 'Mod+k', isMac),
      false,
    )

    const plus = { key: '+', shiftKey: true, ctrlKey: !isMac, metaKey: isMac }
    const recorded = chordFromEvent(plus, isMac)
    assert.equal(recorded, 'Mod+Plus')
    assert.equal(canonicalChord('Mod++'), recorded)
    assert.equal(matchesChord(plus, recorded!, isMac), true)
    assert.equal(matchesChord({ ...plus, key: '=' }, recorded!, isMac), false)
    const assigned = assignShortcut(DEFAULT_SHORTCUTS, 'palette.open', recorded!)
    assert.equal(assigned.conflict, null)
    assert.equal(
      assignShortcut(assigned.bindings, 'view.branches', 'Mod++').conflict?.conflictingId,
      'palette.open',
    )

    let stored: string | null = null
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value
      },
      removeItem: () => {
        stored = null
      },
    }
    saveShortcuts(assigned.bindings, storage)
    assert.equal(loadShortcuts(storage)['palette.open'], recorded)
    assert.equal(matchesChord(plus, loadShortcuts(storage)['palette.open'], isMac), true)
    const reset = resetShortcuts(storage)
    assert.equal(matchesChord(plus, reset['palette.open'], isMac), false)
    assert.equal(
      matchesChord({ key: 'k', metaKey: isMac, ctrlKey: !isMac }, reset['palette.open'], isMac),
      true,
    )
    assert.equal(stored, null)
    assert.equal(matchesChord(plus, loadShortcuts(storage)['palette.open'], isMac), false)
  }
})

test('palette rebase accepts a fetched remote-only parent without rewriting its recorded identity', () => {
  const remote = makeMockBranch('origin/fetched-parent', {
    ref: 'refs/remotes/origin/fetched-parent',
    remote: true,
  })
  const child = makeMockBranch('topic', { current: true, parent: 'fetched-parent' })
  const snapshot = makeMockSnapshot({ branches: [child, remote], currentBranch: 'topic' })
  const item = buildPaletteItems({
    snapshot,
    selectedBranch: child,
    recentRepositories: [],
    isBusy: false,
    operationActive: false,
    shortcutMap: DEFAULT_SHORTCUTS,
  }).find((entry) => entry.id === 'stack.rebaseCurrent')
  assert.equal(item?.disabled, false)
  assert.equal(item?.intent.kind, 'workflow')
  if (item?.intent.kind === 'workflow') {
    assert.equal(item.intent.request.kind, 'confirm')
    if (item.intent.request.kind === 'confirm') {
      assert.deepEqual(item.intent.request.action, { type: 'rebase', parent: 'fetched-parent' })
    }
  }
  snapshot.branches = [child]
  assert.match(
    buildPaletteItems({
      snapshot,
      selectedBranch: child,
      recentRepositories: [],
      isBusy: false,
      operationActive: false,
      shortcutMap: DEFAULT_SHORTCUTS,
    }).find((entry) => entry.id === 'stack.rebaseCurrent')?.disabledReason ?? '',
    /No recorded parent/,
  )
})

test('palette exposes PR workflows, rebase guards, sync target and issue entities', () => {
  const snapshot = makeMockSnapshot({
    issues: [
      {
        number: 17,
        title: 'Correct keyboard navigation',
        url: 'https://github.com/example/mock-repo/issues/17',
      },
    ],
  })
  const branch = snapshot.branches[1]
  branch.pr = snapshot.pullRequests[0]
  const items = buildPaletteItems({
    snapshot,
    selectedBranch: branch,
    recentRepositories: [],
    isBusy: false,
    operationActive: false,
    shortcutMap: DEFAULT_SHORTCUTS,
  })
  assert.deepEqual(items.find((item) => item.id === 'stack.managePr')?.intent, {
    kind: 'workflow',
    request: { kind: 'pr', number: 42 },
  })
  assert.deepEqual(items.find((item) => item.id === 'stack.mergePr')?.intent, {
    kind: 'workflow',
    request: { kind: 'stack', operation: 'merge', branch: 'feature-1' },
  })
  assert.equal(items.find((item) => item.id === 'stack.rebaseCurrent')?.disabled, true)
  assert.equal(items.find((item) => item.id === 'command.fetch')?.shortcutId, 'stack.sync')
  assert.equal(items.find((item) => item.id === 'stack.publish')?.shortcutId, undefined)
  assert.deepEqual(items.find((item) => item.id === 'issue.17')?.intent, {
    kind: 'openPrUrl',
    url: 'https://github.com/example/mock-repo/issues/17',
  })

  branch.current = true
  const rebasing = buildPaletteItems({
    snapshot,
    selectedBranch: branch,
    recentRepositories: [],
    isBusy: false,
    operationActive: false,
    shortcutMap: DEFAULT_SHORTCUTS,
  }).find((item) => item.id === 'stack.rebaseCurrent')
  assert.equal(rebasing?.disabled, false)
  assert.deepEqual(rebasing?.intent, {
    kind: 'workflow',
    request: {
      kind: 'confirm',
      action: { type: 'rebase', parent: 'main' },
      title: 'Rebase current branch?',
      label: 'Rebase onto parent',
      description:
        'This rewrites only the current branch. Use Restack stack to update dependent branches together.',
    },
  })
})

test('keyboard indices follow visible order while searches keep best-ranked actions first', () => {
  const items: PaletteItem[] = [
    {
      id: 'view',
      label: 'Go to branches',
      group: 'Views',
      intent: { kind: 'view', view: 'branches' },
    },
    {
      id: 'stack',
      label: 'Select parent',
      group: 'Stack navigation',
      intent: { kind: 'navigateStack', relation: 'parent' },
    },
    {
      id: 'pr',
      label: 'Add keyboard shortcuts to PR',
      group: 'Pull requests',
      intent: { kind: 'view', view: 'pullRequests' },
    },
    {
      id: 'settings',
      label: 'Keyboard shortcuts',
      group: 'Settings',
      intent: { kind: 'openShortcutsSettings' },
    },
  ]
  const initial = groupPaletteItems(rankPaletteItems(items, ''), false)
  assert.deepEqual(
    initial.flatMap(({ entries }) => entries.map(({ item, flatIndex }) => [flatIndex, item.id])),
    [
      [0, 'stack'],
      [1, 'view'],
      [2, 'pr'],
      [3, 'settings'],
    ],
  )
  const searching = groupPaletteItems(rankPaletteItems(items, 'keyboard shortcuts'), true)
  assert.deepEqual(
    searching.flatMap(({ entries }) => entries.map(({ item, flatIndex }) => [flatIndex, item.id])),
    [
      [0, 'settings'],
      [1, 'pr'],
    ],
  )
})

// =============================================================================
// 2. Disabled commands
// =============================================================================

test('buildPaletteItems disables commands when no repository is open', () => {
  const items = buildPaletteItems({
    snapshot: null,
    selectedBranch: null,
    recentRepositories: [],
    isBusy: false,
    operationActive: false,
    shortcutMap: {
      'palette.open': 'Mod+K',
      'search.focus': '/',
      'stack.selectParent': 'Alt+ArrowUp',
      'stack.selectChild': 'Alt+ArrowDown',
      'stack.selectTop': 'Alt+Shift+ArrowUp',
      'stack.selectBottom': 'Alt+Shift+ArrowDown',
      'stack.checkout': 'Mod+Enter',
      'stack.restack': 'Mod+Shift+R',
      'stack.sync': 'Mod+Shift+S',
      'stack.openPr': 'Mod+Shift+P',
      'view.branches': 'Mod+1',
      'view.stacks': 'Mod+2',
      'view.history': 'Mod+3',
      'view.changes': 'Mod+4',
      'view.pullRequests': 'Mod+5',
      'view.stashes': 'Mod+6',
    },
  })

  const fetchCmd = items.find((i) => i.id === 'command.fetch')
  assert.ok(fetchCmd)
  assert.equal(fetchCmd.disabled, true)
  assert.equal(fetchCmd.disabledReason, 'Open a repository first')

  const checkoutCmd = items.find((i) => i.id === 'stack.checkout')
  assert.ok(checkoutCmd)
  assert.equal(checkoutCmd.disabled, true)
  assert.equal(checkoutCmd.disabledReason, 'Open a repository first')
})

test('buildPaletteItems disables GitHub operations when GitHub CLI is unavailable', () => {
  const snapshot = makeMockSnapshot({
    github: { available: false, message: 'gh auth login required' },
  })
  const feature = snapshot.branches.find((b) => b.name === 'feature-1')!

  const items = buildPaletteItems({
    snapshot,
    selectedBranch: feature,
    recentRepositories: [],
    isBusy: false,
    operationActive: false,
    shortcutMap: {
      'palette.open': 'Mod+K',
      'search.focus': '/',
      'stack.selectParent': 'Alt+ArrowUp',
      'stack.selectChild': 'Alt+ArrowDown',
      'stack.selectTop': 'Alt+Shift+ArrowUp',
      'stack.selectBottom': 'Alt+Shift+ArrowDown',
      'stack.checkout': 'Mod+Enter',
      'stack.restack': 'Mod+Shift+R',
      'stack.sync': 'Mod+Shift+S',
      'stack.openPr': 'Mod+Shift+P',
      'view.branches': 'Mod+1',
      'view.stacks': 'Mod+2',
      'view.history': 'Mod+3',
      'view.changes': 'Mod+4',
      'view.pullRequests': 'Mod+5',
      'view.stashes': 'Mod+6',
    },
  })

  const publishCmd = items.find((i) => i.id === 'stack.publish')
  assert.ok(publishCmd)
  assert.equal(publishCmd.disabled, true)
  assert.match(publishCmd.disabledReason || '', /gh auth login required/)
})

test('buildPaletteItems disables checkout when branch is already checked out', () => {
  const snapshot = makeMockSnapshot()
  const main = snapshot.branches.find((b) => b.name === 'main')! // current is true

  const items = buildPaletteItems({
    snapshot,
    selectedBranch: main,
    recentRepositories: [],
    isBusy: false,
    operationActive: false,
    shortcutMap: {
      'palette.open': 'Mod+K',
      'search.focus': '/',
      'stack.selectParent': 'Alt+ArrowUp',
      'stack.selectChild': 'Alt+ArrowDown',
      'stack.selectTop': 'Alt+Shift+ArrowUp',
      'stack.selectBottom': 'Alt+Shift+ArrowDown',
      'stack.checkout': 'Mod+Enter',
      'stack.restack': 'Mod+Shift+R',
      'stack.sync': 'Mod+Shift+S',
      'stack.openPr': 'Mod+Shift+P',
      'view.branches': 'Mod+1',
      'view.stacks': 'Mod+2',
      'view.history': 'Mod+3',
      'view.changes': 'Mod+4',
      'view.pullRequests': 'Mod+5',
      'view.stashes': 'Mod+6',
    },
  })

  const checkoutCmd = items.find((i) => i.id === 'stack.checkout')
  assert.ok(checkoutCmd)
  assert.equal(checkoutCmd.disabled, true)
  assert.equal(checkoutCmd.disabledReason, 'Already the checked-out branch')
})

// =============================================================================
// 3. Stack navigation
// =============================================================================

test('resolveStackNavigation navigates correctly up and down stack hierarchy', () => {
  const main = makeMockBranch('main')
  const feature1 = makeMockBranch('feature-1', { parent: 'main' })
  const feature2 = makeMockBranch('feature-2', { parent: 'feature-1' })
  const branches = [main, feature1, feature2]

  // From feature-1: parent is main
  assert.equal(resolveStackNavigation(feature1, branches, 'parent')?.name, 'main')
  // From feature-1: child is feature-2
  assert.equal(resolveStackNavigation(feature1, branches, 'child')?.name, 'feature-2')
  // From feature-1: top is feature-2
  assert.equal(resolveStackNavigation(feature1, branches, 'top')?.name, 'feature-2')
  // From feature-1: bottom is main
  assert.equal(resolveStackNavigation(feature1, branches, 'bottom')?.name, 'main')

  // From main: parent is null
  assert.equal(resolveStackNavigation(main, branches, 'parent'), null)
  // From feature-2: child is null
  assert.equal(resolveStackNavigation(feature2, branches, 'child'), null)
})

test('remote-only parent aliases preserve child and top navigation without checkout', () => {
  const remoteParent = makeMockBranch('origin/fetched-parent', {
    ref: 'refs/remotes/origin/fetched-parent',
    remote: true,
  })
  const topic = makeMockBranch('topic', { parent: 'fetched-parent' })
  const child = makeMockBranch('child', { parent: 'topic' })
  const branches = [remoteParent, topic, child]

  assert.equal(resolveStackNavigation(topic, branches, 'parent')?.ref, remoteParent.ref)
  assert.equal(resolveStackNavigation(remoteParent, branches, 'child')?.ref, topic.ref)
  assert.equal(resolveStackNavigation(remoteParent, branches, 'top')?.ref, child.ref)
})
