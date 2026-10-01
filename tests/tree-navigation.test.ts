import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimsRovingKey,
  clampRovingIndex,
  rovingAction,
  rovingTabIndex,
  rovingTarget,
} from '../src/renderer/src/lib/tree-navigation'
import { describeBranchRow } from '../src/renderer/src/lib/branches'
import {
  WORKSPACE_VIEW_SHORTCUTS,
  workspaceViewLabel,
  type WorkspaceView,
} from '../src/renderer/src/components/workspace-navigation'

test('roving keys map to moves and leave every other keystroke to the focused control', () => {
  assert.equal(rovingAction('ArrowDown'), 'next')
  assert.equal(rovingAction('ArrowRight'), 'next')
  assert.equal(rovingAction('ArrowUp'), 'previous')
  assert.equal(rovingAction('ArrowLeft'), 'previous')
  assert.equal(rovingAction('Home'), 'first')
  assert.equal(rovingAction('End'), 'last')

  // Enter and Space belong to the row's own activation, and printable characters
  // must reach a focused text field rather than moving the selection.
  for (const key of ['Enter', ' ', 'Tab', 'a', '/', 'Escape']) {
    assert.equal(rovingAction(key), null, `${key} must not be consumed as a roving move`)
  }
})

test('roving moves stop at both ends instead of wrapping', () => {
  assert.equal(rovingTarget('next', 0, 4), 1)
  assert.equal(rovingTarget('next', 2, 4), 3)
  assert.equal(rovingTarget('next', 3, 4), null)
  assert.equal(rovingTarget('previous', 1, 4), 0)
  assert.equal(rovingTarget('previous', 0, 4), null)
  assert.equal(rovingTarget('first', 3, 4), 0)
  assert.equal(rovingTarget('first', 0, 4), null)
  assert.equal(rovingTarget('last', 0, 4), 3)
  assert.equal(rovingTarget('last', 3, 4), null)
})

test('roving moves survive an out-of-range active index and an empty surface', () => {
  assert.equal(rovingTarget('previous', 99, 4), 2)
  assert.equal(rovingTarget('next', -5, 4), 1)
  assert.equal(rovingTarget('first', 0, 0), null)
  assert.equal(rovingTarget('last', 0, 0), null)
})

test('exactly one row of a composite surface stays in the tab order', () => {
  assert.deepEqual(
    [0, 1, 2].map((index) => rovingTabIndex(index, 1)),
    [-1, 0, -1],
  )
  assert.equal(clampRovingIndex(9, 3), 2)
  assert.equal(clampRovingIndex(-4, 3), 0)
  assert.equal(clampRovingIndex(2, 0), 0)
})

test('a branch row names every state it also renders with colour or an icon', () => {
  const plain = describeBranchRow({
    ahead: 0,
    behind: 0,
    checks: null,
    current: false,
    cycle: false,
    missingParent: false,
    name: 'feature/plain',
    pullRequestNumber: null,
    remote: false,
    requiresRestack: false,
    upstream: null,
  })
  assert.equal(plain, 'feature/plain, no upstream configured')

  const busy = describeBranchRow({
    ahead: 2,
    behind: 1,
    checks: 'failing',
    current: true,
    cycle: true,
    missingParent: true,
    name: 'feature/busy',
    pullRequestNumber: 42,
    remote: true,
    requiresRestack: true,
    upstream: 'origin/main',
  })
  assert.equal(
    busy,
    'feature/busy, current branch, remote branch, parent cycle, parent missing, requires restack, pull request #42, checks failing, 2 ahead, 1 behind origin/main',
  )

  // An unreported check state stays explicit instead of reading as passing.
  const unreported = describeBranchRow({
    ahead: 0,
    behind: 0,
    checks: null,
    current: false,
    cycle: false,
    missingParent: false,
    name: 'feature/unknown',
    pullRequestNumber: 7,
    remote: false,
    requiresRestack: false,
    upstream: 'origin/feature/unknown',
  })
  assert.equal(
    unreported,
    'feature/unknown, pull request #7, checks unknown, 0 ahead, 0 behind origin/feature/unknown',
  )
})

test('a roving surface claims only unmodified keys so global chords still dispatch', () => {
  const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
  assert.equal(claimsRovingKey(plain), true)
  assert.equal(claimsRovingKey({ ...plain, altKey: true }), false)
  assert.equal(claimsRovingKey({ ...plain, shiftKey: true }), false)
  assert.equal(claimsRovingKey({ ...plain, metaKey: true }), false)
  assert.equal(claimsRovingKey({ ...plain, ctrlKey: true }), false)
  // Alt+Shift+Arrow is a stack-navigation chord, and Mod+Enter is checkout.
  assert.equal(
    claimsRovingKey({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: true }),
    false,
  )
})

test('every workspace destination has a distinct keyboard route and a spoken label', () => {
  const views: WorkspaceView[] = [
    'branches',
    'stacks',
    'history',
    'changes',
    'pullRequests',
    'prInbox',
    'stashes',
    'diagnostics',
    'review',
  ]
  const routed = new Set(WORKSPACE_VIEW_SHORTCUTS.map(([, view]) => view))
  assert.deepEqual([...routed].sort(), [...views].sort())
  assert.equal(new Set(WORKSPACE_VIEW_SHORTCUTS.map(([shortcut]) => shortcut)).size, views.length)
  for (const view of views) {
    assert.notEqual(workspaceViewLabel(view), view, `${view} has no destination label`)
  }
})
