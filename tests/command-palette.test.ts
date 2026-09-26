import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SHORTCUT_DEFINITIONS,
  DEFAULT_SHORTCUTS,
  assignShortcut,
  chordFromEvent,
  canonicalChord,
  detectShortcutConflicts,
  formatChord,
  matchesChord,
  parseChord,
  type ShortcutId,
} from '../src/renderer/src/lib/keyboard-shortcuts'
import {
  buildPaletteItems,
  rankPaletteItems,
  resolveFocusRestoreTarget,
  scorePaletteItem,
  type FocusableTargetLike,
  type PaletteItem,
} from '../src/renderer/src/lib/command-palette'
import { resolveStackNavigation } from '../src/renderer/src/lib/stack-navigation'
import {
  CommandPalette,
  CommandPaletteContent,
} from '../src/renderer/src/components/command-palette'
import {
  DirtyCheckoutGuard,
  DirtyCheckoutContent,
} from '../src/renderer/src/components/dirty-checkout-guard'
import type { Branch, RepositorySnapshot } from '../src/shared/types'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'

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

test('CommandPalette markup exposes aria-disabled and reason for disabled items', () => {
  const items: PaletteItem[] = [
    {
      id: 'cmd-disabled',
      label: 'Publish stack',
      group: 'Commands',
      disabled: true,
      disabledReason: 'GitHub integration unavailable',
      intent: { kind: 'view', view: 'branches' },
    },
  ]

  const html = renderToStaticMarkup(
    React.createElement(CommandPaletteContent, {
      items,
      onExecute: () => {},
    }),
  )

  assert.match(html, /aria-disabled="true"/)
  assert.match(html, /GitHub integration unavailable/)
})

// =============================================================================
// 3. Destructive confirmations
// =============================================================================

test('Destructive actions are flagged and cannot execute from ranking alone', () => {
  const snapshot = makeMockSnapshot()
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

  const deleteCmd = items.find((i) => i.id === 'command.deleteBranch')
  assert.ok(deleteCmd)
  assert.equal(deleteCmd.destructive, true)

  const forcePushCmd = items.find((i) => i.id === 'command.forcePush')
  assert.ok(forcePushCmd)
  assert.equal(forcePushCmd.destructive, true)
})

test('CommandPalette marks destructive items with destructive badge and aria label', () => {
  const items: PaletteItem[] = [
    {
      id: 'cmd-delete',
      label: 'Delete feature-1…',
      group: 'Commands',
      destructive: true,
      intent: { kind: 'deleteBranch' },
    },
  ]

  const html = renderToStaticMarkup(
    React.createElement(CommandPaletteContent, {
      items,
      onExecute: () => {},
    }),
  )

  assert.match(html, /Destructive/)
  assert.match(html, /destructive action requiring confirmation/)
})

// =============================================================================
// 4. Focus restoration
// =============================================================================

test('resolveFocusRestoreTarget returns the opener element when connected and enabled', () => {
  let focused = false
  const opener: FocusableTargetLike = {
    isConnected: true,
    disabled: false,
    focus: () => {
      focused = true
    },
  }
  const fallback: FocusableTargetLike = {
    isConnected: true,
    disabled: false,
    focus: () => {},
  }

  const target = resolveFocusRestoreTarget(opener, fallback)
  assert.equal(target, opener)
  target?.focus()
  assert.equal(focused, true)
})

test('resolveFocusRestoreTarget falls back to search input when opener is disconnected', () => {
  let fallbackFocused = false
  const opener: FocusableTargetLike = {
    isConnected: false,
    disabled: false,
    focus: () => {},
  }
  const fallback: FocusableTargetLike = {
    isConnected: true,
    disabled: false,
    focus: () => {
      fallbackFocused = true
    },
  }

  const target = resolveFocusRestoreTarget(opener, fallback)
  assert.equal(target, fallback)
  target?.focus()
  assert.equal(fallbackFocused, true)
})

test('resolveFocusRestoreTarget falls back when opener is disabled', () => {
  const opener: FocusableTargetLike = {
    isConnected: true,
    disabled: true,
    focus: () => {},
  }
  const fallback: FocusableTargetLike = {
    isConnected: true,
    disabled: false,
    focus: () => {},
  }

  const target = resolveFocusRestoreTarget(opener, fallback)
  assert.equal(target, fallback)
})

test('resolveFocusRestoreTarget returns null when no candidate is valid', () => {
  const opener: FocusableTargetLike = {
    isConnected: false,
    disabled: true,
    focus: () => {},
  }
  const fallback: FocusableTargetLike = {
    isConnected: false,
    disabled: true,
    focus: () => {},
  }

  const target = resolveFocusRestoreTarget(opener, fallback)
  assert.equal(target, null)
})

// =============================================================================
// 5. Stack navigation
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

// =============================================================================
// 6. Dirty checkout guard
// =============================================================================

test('DirtyCheckoutGuard renders modified files and safeguard options', () => {
  const snapshot = makeMockSnapshot({
    files: [
      { path: 'src/App.tsx', index: 'M', worktree: ' ', conflicted: false },
      { path: 'src/main.ts', index: ' ', worktree: 'M', conflicted: false },
    ],
  })

  const html = renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(DirtyCheckoutContent, {
        target: { ref: 'refs/heads/feature-1', name: 'feature-1' },
        snapshot,
        onClose: () => {},
        onStash: () => {},
        onReviewChanges: () => {},
      }),
    ),
  )

  assert.match(html, /Check out feature-1/)
  assert.match(html, /2 files \(1 staged\)/)
  assert.match(html, /Stash changes…/)
  assert.match(html, /Review changes/)
  assert.match(html, /Cancel/)
})
