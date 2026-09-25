import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Branch, PullRequest, RepositorySnapshot } from '../src/shared/types'
import { BranchInspector } from '../src/renderer/src/components/branch-inspector'
import { BranchTree } from '../src/renderer/src/components/branch-workspace'
import { StackView } from '../src/renderer/src/components/repository-views'
import { RepositoryHoverCardProvider } from '../src/renderer/src/components/repository-hover-cards'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import {
  describeBranchAncestry,
  getBranchWorkspace,
  indexVisibleParentNames,
  parentProvenanceLabel,
  resolveSelectedBranch,
  type BranchFilter,
} from '../src/renderer/src/lib/branch-workspace'
import { checkLabel, checksVariant, reviewLabel } from '../src/renderer/src/lib/pull-request-state'
import {
  branchFixtureBranches,
  branchFixtureRefs,
  branchFixtureSnapshot,
} from '../src/renderer/src/design-system/branch-fixtures'

const snapshot = branchFixtureSnapshot

function renderBranchTree(selectedRef: string | null, filter: BranchFilter = 'all', search = '') {
  const workspace = getBranchWorkspace(branchFixtureBranches, filter, search)
  const selected = resolveSelectedBranch(branchFixtureBranches, selectedRef, filter)
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(
        RepositoryHoverCardProvider,
        null,
        React.createElement(BranchTree, {
          branches: workspace.visible,
          rows: workspace.rows,
          selectedRef: selected?.ref ?? null,
          onSelect: () => {},
          onOpenPullRequest: () => {},
        }),
      ),
    ),
  )
}

function renderInspector(
  branch: Branch,
  overrides: Partial<React.ComponentProps<typeof BranchInspector>> = {},
) {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(
        RepositoryHoverCardProvider,
        null,
        React.createElement(BranchInspector, {
          branch,
          pullRequest: branch.pr,
          parent: branch.parent
            ? (snapshot.branches.find((candidate) => candidate.name === branch.parent) ?? null)
            : null,
          defaultBranch: snapshot.defaultBranch,
          github: snapshot.github,
          busy: false,
          operationActive: false,
          onClose: () => {},
          onSwitch: () => {},
          onRebaseOntoParent: () => {},
          onRestack: () => {},
          onPublish: () => {},
          onSetParent: () => {},
          onPreviewMerge: () => {},
          onCreatePullRequest: () => {},
          onManagePullRequest: () => {},
          onOpenExternal: () => {},
          onRename: () => {},
          onSetUpstream: () => {},
          onDeleteLocal: () => {},
          onDeleteRemote: () => {},
          ...overrides,
        }),
      ),
    ),
  )
}

function renderStackView(stackSnapshot: RepositorySnapshot, search = ''): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(
        RepositoryHoverCardProvider,
        null,
        React.createElement(StackView, {
          snapshot: stackSnapshot,
          busy: false,
          onRequest: () => {},
          onSelect: () => {},
          onCreate: () => {},
          search,
        }),
      ),
    ),
  )
}

function branchByRef(ref: string): Branch {
  const branch = branchFixtureBranches.find((candidate) => candidate.ref === ref)
  if (!branch) throw new Error(`fixture branch ${ref} is missing`)
  return branch
}

/** Opening tag of the button that carries `label`, so gating is checked per control. */
function findControl(markup: string, label: string): string {
  const pattern = new RegExp(
    `<button([^>]*?)>(?:(?!</button>)[\\s\\S])*?${label}[\\s\\S]*?</button>`,
    'g',
  )
  const match = pattern.exec(markup)
  if (!match) throw new Error(`no control labelled ${JSON.stringify(label)} was rendered`)
  return match[1]
}

function isDisabled(markup: string, label: string): boolean {
  return /(^|\s)disabled(?==|\s|$)/.test(findControl(markup, label))
}

/** Markup of the single branch row identified by `ref`. */
function rowMarkup(markup: string, ref: string): string {
  const start = markup.indexOf(`data-ref="${ref}"`)
  if (start < 0) throw new Error(`row ${ref} is not in the rendered tree`)
  const end = markup.indexOf('</div><div class="branch-row', start)
  return end < 0 ? markup.slice(start) : markup.slice(start, end)
}

test('every accepted graph shape is present in the fixtures', () => {
  const workspace = getBranchWorkspace(branchFixtureBranches, 'all', '')
  const rows = new Map(
    workspace.visible.map((branch, index) => [branch.ref, workspace.rows[index]]),
  )

  // Linear stack: the child sits exactly one lane below its base.
  assert.equal(
    rows.get(branchFixtureRefs.linearChild)!.depth,
    rows.get(branchFixtureRefs.linearBase)!.depth + 1,
  )
  assert.ok(rows.get(branchFixtureRefs.deepFourth)!.depth >= 3, 'deep nesting reaches four levels')

  // Missing parent and cycle are detected rather than silently rendered.
  assert.equal(rows.get(branchFixtureRefs.orphan)!.missingParent, true)
  assert.equal(rows.get(branchFixtureRefs.cycleA)!.cycle, true)

  // A branch requiring restack is flagged from either signal.
  assert.equal(rows.get(branchFixtureRefs.restack)!.missingParent, false)
  const restack = branchByRef(branchFixtureRefs.restack)
  assert.ok(restack.needsRestack || (restack.parentBehind ?? 0) > 0)
  assert.equal(branchByRef(branchFixtureRefs.restack).parent, 'feature/linear-base')

  // Long branch and pull-request names survive into the tree.
  assert.ok(workspace.visible.some((branch) => branch.ref === branchFixtureRefs.longName))
  assert.ok(
    branchByRef(branchFixtureRefs.longName).pr!.title.length > 60,
    'long pull-request title is covered',
  )
})

test('local and tracked-remote rows consolidate without losing or duplicating branches', () => {
  const workspace = getBranchWorkspace(branchFixtureBranches, 'all', '')
  const refs = workspace.visible.map((branch) => branch.ref)

  assert.equal(new Set(refs).size, refs.length, 'no duplicate rows')
  assert.ok(
    refs.includes(branchFixtureRefs.trackedLocal),
    'configured upstream keeps the local row',
  )
  assert.ok(!refs.includes(branchFixtureRefs.trackedRemote), 'tracked remote is represented by it')
  assert.ok(refs.includes(branchFixtureRefs.untrackedLocal), 'unconfigured local row is kept')
  assert.ok(
    !refs.includes(branchFixtureRefs.untrackedRemote),
    'unconfigured local still represents origin',
  )
  assert.ok(refs.includes(branchFixtureRefs.remoteOnly), 'remote-only branches stay browsable')
  assert.ok(refs.includes(branchFixtureRefs.ambiguousRemote), 'same-name remote is not merged away')
  assert.ok(refs.includes(branchFixtureRefs.ambiguousLocal), 'same-name local row is kept')
})

test('the Remote filter browses every remote ref, including represented ones', () => {
  const workspace = getBranchWorkspace(branchFixtureBranches, 'remote', '')
  const refs = workspace.visible.map((branch) => branch.ref)

  assert.equal(
    refs.length,
    branchFixtureBranches.filter((branch) => branch.remote).length,
    'explicit remote browsing stays complete',
  )
  assert.ok(refs.includes(branchFixtureRefs.trackedRemote))
  assert.ok(refs.includes(branchFixtureRefs.untrackedRemote))
  assert.ok(
    workspace.visible.every((branch) => branch.remote),
    'no local rows leak into the remote view',
  )
})

test('selecting a represented remote row inspects its local branch unless Remote browsing', () => {
  const local = resolveSelectedBranch(branchFixtureBranches, branchFixtureRefs.trackedRemote, 'all')
  assert.equal(
    local?.ref,
    branchFixtureRefs.trackedLocal,
    'selection follows the representing local branch',
  )

  const remote = resolveSelectedBranch(
    branchFixtureBranches,
    branchFixtureRefs.trackedRemote,
    'remote',
  )
  assert.equal(
    remote?.ref,
    branchFixtureRefs.trackedRemote,
    'explicit remote browsing inspects the remote row',
  )

  const untracked = resolveSelectedBranch(
    branchFixtureBranches,
    branchFixtureRefs.untrackedRemote,
    'all',
  )
  assert.equal(
    untracked?.ref,
    branchFixtureRefs.untrackedLocal,
    'name-based consolidation resolves too',
  )

  const ambiguous = resolveSelectedBranch(
    branchFixtureBranches,
    branchFixtureRefs.ambiguousRemote,
    'all',
  )
  assert.equal(
    ambiguous?.ref,
    branchFixtureRefs.ambiguousRemote,
    'an unrepresented remote keeps its own row',
  )
})

test('connector geometry assigns a lane per nesting level and one elbow per child lane', () => {
  const workspace = getBranchWorkspace(branchFixtureBranches, 'all', '')
  const deepIndex = workspace.visible.findIndex(
    (branch) => branch.ref === branchFixtureRefs.deepFourth,
  )
  const deepRow = workspace.rows[deepIndex]
  const lanes = [...new Set(deepRow.trunks.map((trunk) => trunk.lane))].sort(
    (left, right) => left - right,
  )

  assert.deepEqual(lanes, [0, 1, 2, 3], 'each ancestor lane draws its own trunk')
  assert.equal(
    deepRow.trunks.find((trunk) => trunk.lane === deepRow.depth)?.kind,
    'start-node',
    'a same-lane parent is continued through the row without a stray elbow',
  )
  for (const trunk of deepRow.trunks) {
    assert.ok(Number.isInteger(trunk.lane) && trunk.lane >= 0, 'lanes are non-negative integers')
    assert.ok(trunk.lane <= deepRow.depth, 'no lane is drawn past the row node')
  }
  assert.equal(new Set(deepRow.trunks.map((trunk) => trunk.lane)).size, deepRow.trunks.length)

  for (const [index, branch] of workspace.visible.entries()) {
    const row = workspace.rows[index]
    const rowLanes = row.trunks.map((trunk) => trunk.lane)
    assert.equal(new Set(rowLanes).size, rowLanes.length, `${branch.name} draws each lane once`)
    for (const elbow of row.elbows) {
      assert.ok(
        rowLanes.includes(elbow.lane),
        `${branch.name} joins a lane it already draws a trunk on`,
      )
      assert.ok(elbow.lane < row.depth, `${branch.name} elbows into its own node lane`)
    }
    for (const lane of rowLanes) {
      assert.ok(lane <= row.depth, `${branch.name} never draws a lane past its node`)
    }
    if (branch.parent && !row.cycle && !row.missingParent) {
      const parent = workspace.byName.get(branch.parent)
      if (parent) {
        const parentRow =
          workspace.rows[workspace.visible.findIndex((row) => row.ref === parent.ref)]
        assert.ok(
          rowLanes.includes(parentRow.depth),
          `${branch.name} keeps its visible parent's lane connected`,
        )
      }
    }
  }

  const deeper = workspace.visible.findIndex((branch) => branch.ref === branchFixtureRefs.deepThird)
  const deeperRow = workspace.rows[deeper]
  assert.deepEqual(
    deeperRow.trunks.map((trunk) => trunk.lane).sort((left, right) => left - right),
    [0, 1, 2, 3],
    'a deeper branch keeps every ancestor lane, not only its parent lane',
  )
  assert.deepEqual(deeperRow.elbows, [{ lane: 2 }], 'it joins the parent lane exactly once')
})

test('ancestry stays readable when the current filter hides the parent row', () => {
  const workspace = getBranchWorkspace(branchFixtureBranches, 'all', 'restack')
  assert.ok(!workspace.visible.some((branch) => branch.name === 'feature/linear-base'))

  const child = workspace.visible.find((branch) => branch.ref === branchFixtureRefs.restack)!
  const ancestry = describeBranchAncestry(
    child,
    workspace.rows[workspace.visible.indexOf(child)],
    indexVisibleParentNames(workspace.visible),
  )
  assert.match(ancestry, /feature\/linear-base/)
  assert.match(ancestry, /not in the current view/)

  const markup = renderBranchTree(branchFixtureRefs.restack, 'all', 'restack')
  assert.match(markup, /branch-ancestry/)
  assert.match(markup, /Stack parent feature\/linear-base is not in the current view/)
  assert.match(markup, /aria-describedby="branch-ancestry-/)
  assert.ok(
    !markup.includes('>feature/linear-base<'),
    'the hidden parent does not appear as a visible row',
  )
})

test('cycle and missing-parent ancestry are stated instead of implied by connectors', () => {
  const cycle = branchByRef(branchFixtureRefs.cycleA)
  const orphan = branchByRef(branchFixtureRefs.orphan)
  const rows = new Map(
    getBranchWorkspace(branchFixtureBranches, 'all', '').visible.map((branch, index) => [
      branch.ref,
      getBranchWorkspace(branchFixtureBranches, 'all', '').rows[index],
    ]),
  )
  const names = indexVisibleParentNames(
    getBranchWorkspace(branchFixtureBranches, 'all', '').visible,
  )

  assert.match(describeBranchAncestry(cycle, rows.get(cycle.ref)!, names), /completes a cycle/)
  assert.match(
    describeBranchAncestry(orphan, rows.get(orphan.ref)!, names),
    /feature\/deleted-base is not in the current view/,
  )

  const markup = renderBranchTree(branchFixtureRefs.cycleA)
  assert.match(markup, /parent cycle/)
  assert.match(markup, /parent missing/)
})

test('current, selected, and hoverable states are separately distinguishable', () => {
  const selectedMarkup = renderBranchTree(branchFixtureRefs.linearChild)
  const otherMarkup = renderBranchTree(branchFixtureRefs.restack)

  assert.equal(
    (selectedMarkup.match(/aria-current="true"/g) ?? []).length,
    1,
    'exactly one row is the current selection',
  )
  assert.match(selectedMarkup, /data-state="current selected"/)
  assert.ok(
    otherMarkup.includes(`data-ref="${branchFixtureRefs.restack}"`),
    'each row keeps its own branch identity',
  )
  assert.ok(
    !rowMarkup(otherMarkup, branchFixtureRefs.restack).includes('data-state="current"'),
    'checked-out state stays with its own branch',
  )
  assert.match(
    rowMarkup(otherMarkup, branchFixtureRefs.linearChild),
    /data-state="current"/,
    'the checked-out branch keeps its own state while another branch is selected',
  )
  const currentRow = rowMarkup(selectedMarkup, branchFixtureRefs.linearChild)
  assert.match(
    currentRow,
    /class="[^"]*branch-current-badge/,
    'checked-out state is a labelled badge',
  )
  assert.match(currentRow, />Current</)
  assert.match(
    currentRow,
    /<button[^>]*class="branch-select"[^>]*data-state="closed"/,
    'the row stays a hover-card trigger for pointer users',
  )
  assert.match(currentRow, /role="listitem"/, 'rows keep their list semantics')
})

test('absent and unknown checks never read as passing', () => {
  const draft = branchByRef('refs/heads/feature/fan-a')
  assert.equal(draft.pr?.checks, 'none')
  assert.equal(checksVariant('none'), 'secondary')
  assert.equal(checkLabel('none'), 'no checks reported')

  const row = rowMarkup(renderBranchTree(draft.ref), draft.ref)
  assert.match(row, /no checks reported/)
  assert.ok(!row.includes('checks passing'), 'an unreported check never borrows the passing label')
  assert.ok(!row.includes('checkLabel'), 'the unreported state stays neutral')

  const remote = branchByRef(branchFixtureRefs.ambiguousRemote)
  const remoteRow = rowMarkup(renderBranchTree(remote.ref), remote.ref)
  assert.equal(remote.pr?.reviewDecision, undefined)
  assert.equal(reviewLabel(remote.pr as PullRequest), 'no review decision reported')
  assert.ok(
    !remoteRow.includes('no review decision reported'),
    'an unreported review decision is not dressed up as a row verdict',
  )
  assert.match(
    renderInspector(remote),
    /no review decision reported/,
    'the inspector states the missing review decision instead of implying one',
  )
})

test('lifecycle, checks, and review stay independent labels on the same row', () => {
  const failing = rowMarkup(
    renderBranchTree(branchFixtureRefs.linearBase),
    branchFixtureRefs.linearBase,
  )
  assert.match(failing, />open</)
  assert.match(failing, /checks failing/)
  assert.match(failing, /review changes requested/)
  assert.ok(!failing.includes('checks passing'), 'a failing run never reads as passing')

  const closed = rowMarkup(
    renderBranchTree(branchFixtureRefs.ambiguousLocal),
    branchFixtureRefs.ambiguousLocal,
  )
  assert.match(closed, />closed</, 'a closed lifecycle reads as closed')
  assert.match(closed, /checks pending/)
  assert.ok(!closed.includes('review changes requested'))
  assert.ok(!closed.includes('review approved'))
})

test('selecting a row never checks the branch out, and checkout is a separate control', () => {
  const markup = renderBranchTree(branchFixtureRefs.restack)
  const rowButtons = markup.match(/<button[^>]*class="branch-select"[^>]*>/g) ?? []
  assert.ok(rowButtons.length > 1, 'every row exposes its own select control')
  for (const button of rowButtons) {
    assert.ok(!/switch/i.test(button), 'a row select control is not a checkout control')
  }
  assert.ok(!/Switch to this branch/.test(markup), 'the branch tree offers no checkout shortcut')

  const inspectorMarkup = renderInspector(branchByRef(branchFixtureRefs.restack))
  assert.match(inspectorMarkup, /Switch to this branch/)
  assert.doesNotMatch(
    inspectorMarkup,
    /branch-select/,
    'the inspector is not a nested selectable row',
  )
})

test('a selectable row never nests another interactive control', () => {
  const markup = renderBranchTree(branchFixtureRefs.linearChild)
  const row = markup.slice(
    markup.indexOf('class="branch-row'),
    markup.indexOf('class="branch-row') + 2000,
  )
  const selectEnd = row.indexOf('</button>')
  assert.ok(selectEnd > 0, 'the select control closes inside the row')
  const afterSelect = row.slice(selectEnd)
  assert.ok(
    /<a [^>]*class="branch-pr-link"/.test(afterSelect),
    'the pull-request link stays independently focusable beside the select control',
  )
})

test('inspector checkout, rebase, and delete gating follow the branch', () => {
  const current = renderInspector(branchByRef(branchFixtureRefs.linearChild))
  assert.ok(
    isDisabled(current, 'Switch to this branch'),
    'the current branch cannot be checked out again',
  )
  assert.ok(
    !isDisabled(current, 'Rebase current onto parent'),
    'the checked-out branch with a known parent can rebase onto it',
  )
  assert.match(current, /This is already the checked-out branch\./)

  const other = renderInspector(branchByRef(branchFixtureRefs.restack))
  assert.ok(!isDisabled(other, 'Switch to this branch'))
  assert.ok(
    isDisabled(other, 'Rebase current onto parent'),
    'rebasing a branch requires checking it out first',
  )
  assert.match(other, /Switch to this branch before rebasing\./)

  const noParent = renderInspector(branchByRef('refs/heads/main'))
  assert.ok(
    isDisabled(noParent, 'Rebase current onto parent'),
    'a branch without a recorded parent cannot rebase onto one',
  )

  const remote = renderInspector(branchByRef(branchFixtureRefs.ambiguousRemote))
  assert.doesNotMatch(remote, /Stack workflow/, 'remotes have no local stack workflow')
  assert.match(remote, /Delete remote branch/)
  assert.doesNotMatch(remote, /Delete local branch/, 'a remote row cannot be deleted locally')

  const main = renderInspector(branchByRef('refs/heads/main'))
  assert.doesNotMatch(main, /Stack workflow/, 'the default branch has no stack workflow')
  assert.match(main, /The default branch cannot be deleted\./)
})

test('restack, publish, and preview merge keep their existing entry points and rules', () => {
  const open = renderInspector(branchByRef(branchFixtureRefs.linearChild))
  assert.match(open, /Restack stack…/)
  assert.match(open, /Publish stack…/)
  assert.match(open, /Preview PR merge/)
  assert.ok(!isDisabled(open, 'Preview PR merge'))

  const noPr = renderInspector(branchByRef('refs/heads/feature/deep-4'))
  assert.doesNotMatch(noPr, /Preview PR merge/, 'preview merge needs an open pull request')
  assert.match(noPr, /No pull request for this branch\./)

  const closed = renderInspector(branchByRef(branchFixtureRefs.ambiguousLocal))
  assert.doesNotMatch(closed, /Preview PR merge/, 'a closed pull request is not mergeable')

  const busy = renderInspector(branchByRef(branchFixtureRefs.linearChild), { busy: true })
  assert.ok(isDisabled(busy, 'Publish stack…'), 'publish stays disabled while a command runs')
  assert.ok(isDisabled(busy, 'Restack stack…'), 'restack stays disabled while a command runs')

  const stackView = renderStackView(snapshot)
  assert.match(
    stackView,
    /Preview merge/,
    'the stack workspace still previews a merge into the default branch',
  )
  assert.match(stackView, /Publish stack…/)
  assert.match(stackView, /Restack…/)
  assert.match(stackView, /1 branch requires restacking\./)

  const ambiguousStack = renderStackView({ ...snapshot, currentBranch: 'feature/ambiguous' })
  assert.match(
    ambiguousStack,
    /Merge the parent PR first, then restack and publish this branch\./,
    'a closed parent pull request keeps its existing guidance',
  )
})

test('the stack workspace never presents inferred ancestry as confirmed', () => {
  assert.match(
    parentProvenanceLabel(branchByRef(branchFixtureRefs.linearBase)),
    /^Recorded parent$/,
  )
  assert.match(
    parentProvenanceLabel(branchByRef('refs/heads/feature/fan-a')),
    /^Parent from PR base$/,
  )
  assert.match(parentProvenanceLabel(branchByRef('refs/heads/main')), /^No recorded parent$/)

  const recorded = renderStackView(snapshot)
  assert.match(recorded, /Recorded parent/)
  assert.doesNotMatch(
    recorded,
    /Inferred parent/,
    'a recorded stack is not decorated with unconfirmed ancestry',
  )

  const fromPullRequest = renderStackView({ ...snapshot, currentBranch: 'feature/fan-a' })
  assert.match(
    fromPullRequest,
    /Parent from PR base/,
    'a pull-request-derived parent keeps its own provenance label',
  )

  const inferredBranches = branchFixtureBranches.map((branch) =>
    branch.ref === branchFixtureRefs.linearChild
      ? { ...branch, parentSource: 'inferred' as const }
      : branch,
  )
  const unconfirmed = renderStackView({ ...snapshot, branches: inferredBranches })
  assert.match(unconfirmed, /Inferred parent — confirm before publishing/)
  assert.match(
    unconfirmed,
    /stack-provenance-unconfirmed/,
    'unconfirmed ancestry is styled as unconfirmed, not as a confirmed link',
  )
  assert.doesNotMatch(
    unconfirmed,
    /Recorded parent[^]*Inferred parent[^]*Recorded parent/,
    'an unconfirmed parent never sits between two recorded parents',
  )
})

test('selection and inspector content survive a refresh and a filter change', () => {
  const first = getBranchWorkspace(branchFixtureBranches, 'all', '')
  const refreshed = getBranchWorkspace([...branchFixtureBranches].reverse(), 'all', '')
  const selected = resolveSelectedBranch(
    branchFixtureBranches,
    branchFixtureRefs.linearChild,
    'all',
  )

  assert.equal(selected?.name, 'feature/linear-child')
  assert.equal(
    resolveSelectedBranch(
      [...branchFixtureBranches].reverse(),
      branchFixtureRefs.linearChild,
      'all',
    )?.ref,
    selected?.ref,
    'a refresh re-resolves the same branch identity',
  )
  assert.equal(new Set(refreshed.visible.map((branch) => branch.ref)).size, first.visible.length)

  // Switching to a filter that hides the row must not move the inspected branch.
  const remoteView = getBranchWorkspace(branchFixtureBranches, 'remote', '')
  assert.ok(!remoteView.visible.some((branch) => branch.ref === branchFixtureRefs.linearChild))
  assert.equal(
    resolveSelectedBranch(branchFixtureBranches, branchFixtureRefs.linearChild, 'local')?.ref,
    branchFixtureRefs.linearChild,
    'inspector content persists while the branch still exists',
  )
  assert.equal(
    resolveSelectedBranch(branchFixtureBranches, 'refs/heads/feature/removed', 'all'),
    null,
    'a branch that no longer exists clears the inspection',
  )
})

test('a shared parent lane is one continuous line through siblings and deep descendants', () => {
  const workspace = getBranchWorkspace(branchFixtureBranches, 'all', '')
  const laneAt = (index: number, lane: number) =>
    workspace.rows[index].trunks.find((trunk) => trunk.lane === lane)

  // feature/linear-child and feature/restack are siblings under feature/linear-base.
  // The topmost sibling opens the lane at its own elbow; every row below it must draw a
  // full-height segment or the vertical line breaks between the two rows.
  const childIndex = workspace.visible.findIndex(
    (branch) => branch.ref === branchFixtureRefs.linearChild,
  )
  const siblingIndex = workspace.visible.findIndex(
    (branch) => branch.ref === branchFixtureRefs.restack,
  )
  assert.equal(laneAt(childIndex, 1)?.kind, 'start', 'the topmost sibling opens the parent lane')
  assert.equal(
    laneAt(siblingIndex, 1)?.kind,
    'full',
    'a sibling below it must continue the parent lane instead of reopening it',
  )

  // The same holds down a four-level chain where each level carries a sibling.
  const deepLanes = [branchFixtureRefs.deepThird, branchFixtureRefs.deepSecond]
    .map((ref) => workspace.visible.findIndex((branch) => branch.ref === ref))
    .filter((index) => index >= 0)
  for (const index of deepLanes) {
    for (const trunk of workspace.rows[index].trunks) {
      if (trunk.kind !== 'start' && trunk.kind !== 'start-node') continue
      assert.equal(
        trunk.kind,
        'full',
        `${workspace.visible[index].name} reopens lane ${trunk.lane} under a row that already draws it`,
      )
    }
  }

  // A lane is only closed at the parent node, and only by the last row that draws it.
  for (const [index, row] of workspace.rows.entries()) {
    for (const trunk of row.trunks) {
      if (trunk.kind !== 'end-parent') continue
      const below = workspace.rows[index + 1]?.trunks.some((next) => next.lane === trunk.lane)
      assert.ok(
        !below,
        `${workspace.visible[index].name} closes lane ${trunk.lane} while a row below still draws it`,
      )
    }
  }

  // The root lane runs the full list and ends on the row that owns the node.
  const mainIndex = workspace.visible.findIndex((branch) => branch.name === 'main')
  assert.equal(laneAt(mainIndex, 0)?.kind, 'end-parent')
})

test('adjacent independent stacks never share a connector line', () => {
  // Two unrelated trunks sorted so each tree's child sits immediately above its own
  // root: childA, rootA, childB, rootB. Both roots use lane 0, so a lane-only
  // continuity rule would weld rootA's closing segment to childB's opening one and
  // draw a connector between unrelated branches.
  const make = (name: string, parent: string | null, updatedAt: string): Branch => ({
    ref: `refs/heads/${name}`,
    name,
    current: false,
    remote: false,
    upstream: null,
    upstreamRef: null,
    ahead: 0,
    behind: 0,
    subject: '',
    updatedAt,
    parent,
    parentBehind: 0,
    pr: null,
  })
  const branches = [
    make('rootA', null, '2024-01-02T00:00:00Z'),
    make('childA', 'rootA', '2024-01-04T00:00:00Z'),
    make('rootB', null, '2024-01-01T00:00:00Z'),
    make('childB', 'rootB', '2024-01-03T00:00:00Z'),
  ]
  const workspace = getBranchWorkspace(branches, 'all', '')
  assert.deepEqual(
    workspace.visible.map((branch) => branch.name),
    ['childA', 'rootA', 'childB', 'rootB'],
    'the fixture must keep the two trees adjacent for this regression to bite',
  )

  const kindAt = (name: string, lane: number) => {
    const index = workspace.visible.findIndex((branch) => branch.name === name)
    return workspace.rows[index].trunks.find((trunk) => trunk.lane === lane)?.kind
  }
  // rootA closes its own line at its node; childB opens a new one under rootB.
  assert.equal(kindAt('rootA', 0), 'end-parent')
  assert.equal(kindAt('childB', 0), 'start')
  // Within each tree the line still runs continuously from child to root: the child
  // opens the segment at its own elbow and the root closes it at its node.
  assert.equal(kindAt('childA', 0), 'start')
  assert.equal(kindAt('rootB', 0), 'end-parent')
})
