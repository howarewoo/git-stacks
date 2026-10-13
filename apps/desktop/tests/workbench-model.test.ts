import test from 'node:test'
import assert from 'node:assert/strict'
import {
  projectBranchLanes,
  laneDescendantCounts,
  relatedLaneIds,
  type WorkbenchBranch,
} from '../src/renderer/src/components/branch-workbench-model'
import { projectWorkbenchInventory } from '../src/renderer/src/lib/workbench-inventory'
import { inventoryFixture } from './renderer/fixtures/inventory'
import { scenarios } from './renderer/fixtures/scenarios'

function branch(id: string, parentId: string | null, repositoryId = 'repo'): WorkbenchBranch {
  return {
    id,
    repositoryId,
    ref: id,
    title: id,
    parentId,
    trunk: id === 'main',
    worktrees: [],
    local: { label: 'Local only' },
    unpushed: null,
    commits: null,
    attention: false,
    needsRestack: false,
    conflicted: null,
    readyToMerge: null,
    pullRequest: null,
  }
}
test('bottom-up forks join exact parents once and selection does not highlight sibling forks', () => {
  const input = [
    branch('main', null),
    branch('a', 'main'),
    branch('b', 'a'),
    branch('c', 'a'),
    branch('d', 'b'),
  ]
  const lanes = projectBranchLanes(input)
  const positions = new Map(lanes.map((entry, index) => [entry.branch.id, index]))
  for (const entry of lanes)
    if (entry.parentId) assert.ok(positions.get(entry.branch.id)! < positions.get(entry.parentId)!)
  assert.deepEqual(
    new Set(lanes.map((entry) => entry.branch.id)),
    new Set(input.map((entry) => entry.id)),
  )
  assert.equal(lanes.find((entry) => entry.branch.id === 'c')!.parentId, 'a')
  assert.equal(laneDescendantCounts(lanes).get('main'), 4)
  assert.deepEqual(relatedLaneIds(lanes, 'b'), new Set(['b', 'a', 'main', 'd']))
  assert.deepEqual(projectBranchLanes([...input].reverse()), lanes)
})
test('cycles, missing and foreign authorities do not gain fabricated edges', () => {
  const lanes = projectBranchLanes([
    branch('a', 'b'),
    branch('b', 'a'),
    branch('child', 'a'),
    branch('missing', 'gone'),
    branch('foreign', 'main', 'other'),
    branch('main', null),
  ])
  assert.equal(lanes.find((entry) => entry.branch.id === 'a')!.parentId, null)
  assert.equal(lanes.find((entry) => entry.branch.id === 'b')!.issue, 'Parent cycle')
  assert.equal(lanes.find((entry) => entry.branch.id === 'child')!.parentId, 'a')
  assert.equal(lanes.find((entry) => entry.branch.id === 'missing')!.parentId, null)
  assert.equal(lanes.find((entry) => entry.branch.id === 'foreign')!.parentId, null)
})
test('5000-deep and wide inventories remain iterative with bounded gutters and complete authority', () => {
  for (const wide of [false, true]) {
    const input = Array.from({ length: 5000 }, (_, index) =>
      branch(String(index), index === 0 ? null : String(wide ? 0 : index - 1)),
    )
    const lanes = projectBranchLanes(input)
    const positions = new Map(lanes.map((entry, index) => [entry.branch.id, index]))
    assert.equal(lanes.length, input.length)
    for (const entry of lanes) {
      assert.ok(entry.lane <= 6)
      if (entry.parentId)
        assert.ok(positions.get(entry.branch.id)! < positions.get(entry.parentId)!)
    }
    assert.equal(laneDescendantCounts(lanes).get('0'), 4999)
  }
})
test('inventory joins qualified identities, preserves no-worktree PRs, and cannot turn unknown facts into readiness or zero totals', () => {
  const inventory = inventoryFixture()
  const snapshot = projectWorkbenchInventory(inventory, {})
  const repo = inventory.repositories[0]
  const topic = snapshot.branches.find((branch) => branch.id === repo.refs[0].id)!
  assert.equal(topic.worktrees.length, 3)
  assert.equal(topic.parentId, null)
  assert.equal(topic.readyToMerge, null)
  assert.equal(
    topic.worktrees[1].changedFiles,
    null,
    'staged and unstaged counts cannot establish a unique file union',
  )
  assert.equal(snapshot.repositories[0].readyToMergeCount, null)
  assert.equal(snapshot.repositories[0].attentionCount, null)
  assert.ok(
    snapshot.branches.some(
      (branch) =>
        branch.pullRequest?.id === repo.pullRequests[1].id && branch.worktrees.length === 0,
    ),
  )
  const retired = projectWorkbenchInventory(inventoryFixture(2, 'retired'), {})
  assert.equal(
    retired.branches.find((branch) => branch.id === repo.refs[0].id)?.pullRequest,
    undefined,
  )
})

test('qualified main parent evidence wins over tracking names and missing endpoints remain unknown', () => {
  const inventory = inventoryFixture()
  const repo = inventory.repositories[0]
  const detail = structuredClone(scenarios['shell-connected'].snapshot!)
  detail.branches = [
    {
      ...detail.branches[0],
      ref: repo.refs[0].name,
      parent: 'unqualified-display-name',
      parentRef: repo.refs[1].name,
      parentSource: 'recorded',
      upstreamRef: repo.refs[2].name,
    },
  ]
  const projected = projectWorkbenchInventory(inventory, { [repo.identity.id]: detail })
  assert.equal(
    projected.branches.find((row) => row.id === repo.refs[0].id)!.parentId,
    repo.refs[1].id,
  )
  detail.branches[0].parentRef = null
  const unresolved = projectWorkbenchInventory(inventory, {
    [repo.identity.id]: detail,
  }).branches.find((row) => row.id === repo.refs[0].id)!
  assert.equal(unresolved.parentId, null)
  assert.equal(unresolved.parentIssue, 'Main could not resolve the parent endpoint')
})

test('partial discovery never proves absence, clean bulk eligibility or complete directory counts', () => {
  const inventory = inventoryFixture(1, 'partial')
  const snapshot = projectWorkbenchInventory(inventory, {})
  const branch = snapshot.branches.find((row) => row.id === inventory.repositories[0].refs[1].id)!
  assert.equal(branch.worktreesKnown, false)
  assert.equal(branch.bulkEligible, false)
  assert.equal(branch.conflicted, null)
  assert.equal(snapshot.repositories[0].worktreeCount, null)
})

test('independent clones preserve local identities while global ready counts deduplicate published PR authority', () => {
  const inventory = inventoryFixture()
  for (const pr of inventory.repositories[0].pullRequests)
    Object.assign(pr.facts, {
      metadata: 'full',
      state: 'OPEN',
      draft: false,
      checks: 'passing',
      reviewDecision: 'APPROVED',
      mergeState: 'CLEAN',
    })
  const clone = structuredClone(inventory.repositories[0])
  clone.identity = { id: 'independent-clone', commonDirectory: '/fixture/clone/.git' }
  clone.registeredPaths = ['/fixture/clone']
  const refs = new Map(
    clone.refs.map((ref) => [ref.id, JSON.stringify(['independent-clone', 'ref', ref.name])]),
  )
  const trees = new Map(
    clone.worktrees.map((tree) => [
      tree.id,
      JSON.stringify(['independent-clone', 'worktree', tree.gitDirectory]),
    ]),
  )
  for (const tree of clone.worktrees) {
    tree.id = trees.get(tree.id)!
    tree.repositoryId = clone.identity.id
    tree.refId = tree.refId ? refs.get(tree.refId)! : null
    tree.path = `/fixture/clone/${tree.id}`
  }
  for (const ref of clone.refs) {
    ref.id = refs.get(ref.id)!
    ref.repositoryId = clone.identity.id
    ref.worktreeIds = ref.worktreeIds.map((id) => trees.get(id)!)
    ref.upstream = ref.upstream ? refs.get(ref.upstream)! : null
  }
  for (const pr of clone.pullRequests) pr.refIds = pr.refIds.map((id) => refs.get(id)!)
  inventory.repositories.push(clone)
  const snapshot = projectWorkbenchInventory(inventory, {})
  assert.equal(snapshot.repositories.length, 2)
  assert.equal(snapshot.repositories[0].readyToMergeCount, 2)
  assert.equal(snapshot.repositories[1].readyToMergeCount, 2)
  assert.equal(snapshot.globalCounts!.readyToMerge, 2)
  assert.notEqual(
    snapshot.branches.find((row) => row.repositoryId === clone.identity.id && row.ref === 'topic')!
      .id,
    inventory.repositories[0].refs[0].id,
  )
})
