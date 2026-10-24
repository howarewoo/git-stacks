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
import type { RepositorySnapshot } from '@git-stacks/shared/types'

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

test('local branch and tracking upstream share one row with exact ref identities, diverged tips and truthful provenance', () => {
  const inventory = inventoryFixture()
  const repo = inventory.repositories[0]
  const snapshot = projectWorkbenchInventory(inventory, {})
  const topicRow = snapshot.branches.find((row) => row.id === repo.refs[0].id)!
  assert.ok(topicRow, 'topic row should exist with primary local ref id')
  assert.equal(topicRow.ref, 'topic')
  assert.equal(topicRow.refKind, 'local')
  assert.equal(topicRow.localRef?.id, repo.refs[0].id)
  assert.equal(topicRow.localRef?.oid, repo.refs[0].oid)
  assert.equal(topicRow.remoteRef?.id, repo.refs[2].id)
  assert.equal(topicRow.remoteRef?.oid, repo.refs[2].oid)
  assert.equal(topicRow.unpushed, 2)
  assert.equal(topicRow.behind, 1)
  assert.match(topicRow.local.label, /diverged/i)

  // Tracking remote ref must NOT have a duplicate standalone row
  const standaloneRemote = snapshot.branches.find((row) => row.id === repo.refs[2].id)
  assert.equal(
    standaloneRemote,
    undefined,
    'tracking remote ref must not produce a duplicate standalone row',
  )

  // Local-only ref without upstream has localRef and no remoteRef
  const localOnlyRow = snapshot.branches.find((row) => row.id === repo.refs[1].id)!
  assert.ok(localOnlyRow)
  assert.equal(localOnlyRow.ref, 'local-only')
  assert.equal(localOnlyRow.localRef?.id, repo.refs[1].id)
  assert.equal(localOnlyRow.remoteRef, null)
  assert.equal(localOnlyRow.local.label, 'Local / no tracking upstream')

  // Branch count reflects grouped branch rows (2 rows: topic and local-only), not raw 3 refs
  assert.equal(snapshot.repositories[0].branchCount, 2)
})

test('distinct locals sharing an upstream each keep independent paired rows without a duplicate standalone remote', () => {
  const inventory = inventoryFixture()
  const repo = inventory.repositories[0]
  // Add a second local branch tracking the same remote ref
  const secondLocal = {
    id: JSON.stringify(['local', 'ref', 'refs/heads/topic-copy']),
    repositoryId: repo.identity.id,
    name: 'refs/heads/topic-copy',
    kind: 'local' as const,
    oid: 'd'.repeat(40),
    upstream: repo.refs[2].id, // same remote tracking ref
    ahead: 0,
    behind: 0,
    worktreeIds: [],
    pullRequestIds: [],
  }
  repo.refs.push(secondLocal)
  const snapshot = projectWorkbenchInventory(inventory, {})
  const row1 = snapshot.branches.find((row) => row.id === repo.refs[0].id)!
  const row2 = snapshot.branches.find((row) => row.id === secondLocal.id)!
  assert.ok(row1 && row2, 'both distinct locals should have independent rows')
  assert.equal(row1.remoteRef?.id, repo.refs[2].id)
  assert.equal(row2.remoteRef?.id, repo.refs[2].id)
  assert.equal(
    snapshot.branches.find((row) => row.id === repo.refs[2].id),
    undefined,
    'shared tracking remote must not produce a standalone row',
  )
})

test('feature branch tracking origin/main does not become trunk', () => {
  const inventory = inventoryFixture()
  const repo = inventory.repositories[0]
  const originMain = {
    id: JSON.stringify(['remote', 'ref', 'refs/remotes/origin/main']),
    repositoryId: repo.identity.id,
    name: 'refs/remotes/origin/main',
    kind: 'remote' as const,
    oid: 'm'.repeat(40),
    remoteId: repo.remote?.id ?? null,
    remoteName: 'origin',
    upstream: null,
    ahead: null,
    behind: null,
    worktreeIds: [],
    pullRequestIds: [],
  }
  const featureTrackingMain = {
    id: JSON.stringify(['local', 'ref', 'refs/heads/feature']),
    repositoryId: repo.identity.id,
    name: 'refs/heads/feature',
    kind: 'local' as const,
    oid: 'f'.repeat(40),
    upstream: originMain.id,
    ahead: 3,
    behind: 0,
    worktreeIds: [],
    pullRequestIds: [],
  }
  repo.refs.push(originMain, featureTrackingMain)
  const snapshot = projectWorkbenchInventory(inventory, {
    [repo.identity.id]: {
      defaultBranch: 'main',
      branches: [
        {
          ref: 'refs/heads/feature',
          name: 'feature',
          head: 'f'.repeat(40),
          parent: 'refs/remotes/origin/main',
          parentRef: 'refs/remotes/origin/main',
        },
      ],
      limits: { branchesSkipped: false },
    } as unknown as RepositorySnapshot,
  })
  const featureRow = snapshot.branches.find((row) => row.id === featureTrackingMain.id)!
  assert.ok(featureRow)
  assert.equal(featureRow.trunk, false, 'feature branch tracking origin/main must NOT be trunk')
  assert.equal(featureRow.unpushed, 3)
  assert.equal(featureRow.remoteRef?.name, 'refs/remotes/origin/main')
})

test('intra-row parent mapping treats internal relationship without cycle error', () => {
  const inventory = inventoryFixture()
  const repo = inventory.repositories[0]
  // Local topic tracking origin/topic, with parent resolved to origin/topic
  const snapshot = projectWorkbenchInventory(inventory, {
    [repo.identity.id]: {
      defaultBranch: 'main',
      branches: [
        {
          ref: 'refs/heads/topic',
          name: 'topic',
          head: repo.refs[0].oid,
          parent: repo.refs[2].name,
          parentRef: repo.refs[2].name,
        },
      ],
      limits: { branchesSkipped: false },
    } as unknown as RepositorySnapshot,
  })
  const topicRow = snapshot.branches.find((row) => row.id === repo.refs[0].id)!
  assert.ok(topicRow)
  assert.equal(
    topicRow.parentId,
    null,
    'intra-row self-parent must be cleared so lanes detect no self-cycle',
  )
  assert.notEqual(
    topicRow.parentIssue,
    'Parent cycle',
    'intra-row parent must not report Parent cycle',
  )
  assert.equal(topicRow.dependencyParentRefId, repo.refs[2].id, 'dependency parent ref ID retained')
})

test('configured upstream distinction is preserved when tracking upstream is not observed', () => {
  const inventory = inventoryFixture()
  const repo = inventory.repositories[0]
  const localWithUnobservedUpstream = {
    id: JSON.stringify(['local', 'ref', 'refs/heads/missing-upstream']),
    repositoryId: repo.identity.id,
    name: 'refs/heads/missing-upstream',
    kind: 'local' as const,
    oid: 'a'.repeat(40),
    upstream: 'refs/remotes/origin/deleted-upstream',
    ahead: null,
    behind: null,
    worktreeIds: [],
    pullRequestIds: [],
  }
  repo.refs.push(localWithUnobservedUpstream)
  const snapshot = projectWorkbenchInventory(inventory, {})
  const row = snapshot.branches.find((b) => b.id === localWithUnobservedUpstream.id)!
  assert.ok(row)
  assert.equal(row.configuredUpstream, 'refs/remotes/origin/deleted-upstream')
  assert.equal(row.remoteRef, null)
  assert.equal(row.unpushed, null)
})

test('current dependency observation replaces retained no-parent detail without new ref tips', () => {
  const inventory = inventoryFixture()
  const repo = inventory.repositories[0]
  const child = repo.refs[0]
  const parent = repo.refs.find((ref) => ref.id !== child.id)!
  const main = {
    ...child,
    id: JSON.stringify([repo.identity.id, 'ref', 'refs/heads/main']),
    name: 'refs/heads/main',
    upstream: null,
    worktreeIds: [],
    pullRequestIds: [],
  }
  repo.refs.push(main)
  const oldDetail = {
    defaultBranch: 'main',
    branches: [{ ref: child.name, name: 'topic', head: child.oid, parent: null, parentRef: null }],
    limits: { branchesSkipped: false },
  } as unknown as RepositorySnapshot
  repo.dependenciesRead = { state: 'complete', observedAt: 'new', error: null }
  repo.dependencies = [{ ref: child.name, parent: parent.name, parentRef: parent.name }]
  const projected = projectWorkbenchInventory(inventory, { [repo.identity.id]: oldDetail })
  const row = projected.branches.find((entry) => entry.id === child.id)!
  assert.equal(row.dependencyParentRefId, parent.id)
  assert.equal(row.dependencyParentOid, parent.oid)
  assert.equal(row.dependencyParentIssue, undefined)

  repo.dependencies = undefined
  repo.dependenciesRead = {
    state: 'failed',
    observedAt: 'failed-new',
    error: 'Dependency read failed',
  }
  const failed = projectWorkbenchInventory(inventory, { [repo.identity.id]: oldDetail })
  assert.ok(failed.branches.find((entry) => entry.id === child.id)!.dependencyParentIssue)
  const failedMain = failed.branches.find((entry) => entry.id === main.id)!
  assert.equal(
    failedMain.trunk,
    false,
    'failed default evidence cannot resurrect retained trunk identity',
  )
  assert.ok(failedMain.dependencyParentIssue)
})
