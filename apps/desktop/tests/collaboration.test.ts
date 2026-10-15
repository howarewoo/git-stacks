import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attentionItems,
  collaborationObservations,
  activityTransitions,
} from '../src/renderer/src/lib/collaboration'
import { projectWorkbenchInventory } from '../src/renderer/src/lib/workbench-inventory'
import { inventoryFixture } from './renderer/fixtures/inventory'
import {
  evaluatePullRequestInbox,
  type PullRequestInboxItem,
  type PullRequestInboxReport,
} from '@git-stacks/shared/pr-inbox'

function report(item: PullRequestInboxItem): PullRequestInboxReport {
  return {
    items: [item],
    mergedWithinDays: 30,
    refresh: {
      state: 'fresh',
      confirmedAt: '2026-10-13T10:00:00Z',
      checkedAt: '2026-10-13T10:00:00Z',
      viewer: 'reviewer',
      requests: 1,
      budget: { maxRequests: 24, reserve: 250 },
      repositories: [],
      truncated: [],
      detail: 'Read',
    },
  }
}

test('Attention counts one provider PR with several reasons and keeps clone-local conflicts separate', () => {
  const inventory = inventoryFixture(1, 'complete', 1)
  const repo = inventory.repositories[0]
  const pr = repo.pullRequests[0]
  pr.facts.metadata = 'full'
  pr.facts.checks = 'failing'
  pr.facts.reviewDecision = 'CHANGES_REQUESTED'
  repo.worktrees[0].status = 'conflicted'
  repo.worktrees[0].operation = 'rebase'
  const clone = structuredClone(repo)
  clone.identity = { id: 'independent-clone', commonDirectory: '/fixture/clone/.git' }
  clone.registeredPaths = ['/fixture/clone']
  const refs = new Map(clone.refs.map((ref) => [ref.id, `${clone.identity.id}:${ref.name}`]))
  const trees = new Map(clone.worktrees.map((tree) => [tree.id, `${clone.identity.id}:directory`]))
  clone.refs = clone.refs.map((ref) => ({
    ...ref,
    id: refs.get(ref.id)!,
    repositoryId: clone.identity.id,
    worktreeIds: ref.worktreeIds.map((id) => trees.get(id)!),
    upstream: ref.upstream ? refs.get(ref.upstream)! : null,
  }))
  clone.worktrees = clone.worktrees.map((tree) => ({
    ...tree,
    id: trees.get(tree.id)!,
    repositoryId: clone.identity.id,
    refId: tree.refId ? refs.get(tree.refId)! : null,
    path: '/fixture/clone',
  }))
  clone.pullRequests = clone.pullRequests.map((pr) => ({
    ...pr,
    refIds: pr.refIds.map((id) => refs.get(id)!),
  }))
  inventory.repositories.push(clone)
  const item: PullRequestInboxItem = {
    ...pr.facts,
    repository: repo.remote!.fullName,
    repositoryPath: repo.registeredPaths[0],
    host: repo.remote!.host,
    author: 'author',
    reviewRequested: ['reviewer'],
    reviewDecision: 'CHANGES_REQUESTED',
    lastTurnLogin: 'author',
    updatedAt: null,
    mergedAt: null,
    metadata: 'full',
    groups: ['review-requested'],
    reviewBaseline: { headOid: 'b'.repeat(40), reviewedAt: '2026-10-12T10:00:00Z' },
  }
  const rows = attentionItems(inventory, projectWorkbenchInventory(inventory, {}), report(item))
  assert.equal(rows.filter((row) => row.target.number === pr.number).length, 1)
  const remote = rows.find((row) => row.target.number === pr.number)!
  assert.equal(remote.reasons.length, 4)
  assert.equal(remote.group, 'response')
  const local = rows.filter((row) => row.target.worktreeId)
  assert.deepEqual(
    new Set(local.map((row) => row.target.repositoryId)),
    new Set([repo.identity.id, clone.identity.id]),
  )
  assert.equal(rows.length, 3)
})

test('Degraded viewer-unknown facts do not manufacture failures, requests or a previous review', () => {
  const inventory = inventoryFixture(1, 'complete', 1)
  for (const pr of inventory.repositories[0].pullRequests) {
    pr.facts.metadata = 'degraded'
    pr.facts.checks = 'failing'
    pr.facts.reviewDecision = 'CHANGES_REQUESTED'
  }
  assert.deepEqual(
    attentionItems(inventory, projectWorkbenchInventory(inventory, {}), undefined),
    [],
  )
})

test('Fresh provider facts supersede cached failures and a confirmed review retires the new-head reason', () => {
  const inventory = inventoryFixture(1, 'complete', 1)
  const repo = inventory.repositories[0]
  const pr = repo.pullRequests[0]
  pr.facts.metadata = 'full'
  pr.facts.checks = 'failing'
  pr.facts.reviewDecision = 'CHANGES_REQUESTED'
  const headOid = '1'.repeat(40)
  const item: PullRequestInboxItem = {
    ...pr.facts,
    metadata: 'full',
    headOid,
    checks: 'passing',
    reviewDecision: 'APPROVED',
    repository: repo.remote!.fullName,
    repositoryPath: repo.registeredPaths[0],
    host: repo.remote!.host,
    author: 'author',
    reviewRequested: [],
    lastTurnLogin: 'reviewer',
    updatedAt: null,
    mergedAt: null,
    groups: [],
    reviewBaseline: { headOid, reviewedAt: '2026-10-13T10:00:00Z' },
  }
  assert.deepEqual(
    attentionItems(inventory, projectWorkbenchInventory(inventory, {}), report(item)),
    [],
  )
  item.reviewBaseline!.headOid = '2'.repeat(40)
  const changed = attentionItems(inventory, projectWorkbenchInventory(inventory, {}), report(item))
  assert.equal(changed.length, 1)
  assert.equal(changed[0].group, 'review')
  assert.equal(changed[0].source!.headOid, headOid)
  const filter = {
    group: 'all',
    search: '',
    criteria: { repositories: [`${item.host}/${item.repository}`] },
    sort: 'updated-desc',
  } as const
  assert.equal(
    evaluatePullRequestInbox(item, {
      ...filter,
      criteria: { repositories: [`${item.host}/${item.repository}`] },
    }),
    'match',
  )
  assert.equal(
    evaluatePullRequestInbox(item, {
      ...filter,
      criteria: { repositories: [`different.example/${item.repository}`] },
    }),
    'excluded',
  )
})

test('Activity records actual transitions, never the first snapshot or observations under a retired baseline', () => {
  const inventory = inventoryFixture(1, 'complete', 1)
  inventory.repositories[0].pullRequests[0].facts.baseOid = 'a'.repeat(40)
  const first = collaborationObservations(inventory)
  assert.deepEqual(activityTransitions(new Map(), first), [])
  const baseline = new Map(first.map((item) => [item.id, item]))
  assert.deepEqual(activityTransitions(baseline, collaborationObservations(inventory)), [])
  const repo = inventory.repositories[0]
  repo.refs[0].oid = 'f'.repeat(40)
  repo.refsRead.observedAt = '2026-10-13T11:00:00Z'
  repo.pullRequests[0].facts.baseOid = 'b'.repeat(40)
  repo.remoteFreshness!.fetchedAt = '2026-10-13T11:00:00Z'
  const next = collaborationObservations(inventory)
  const changes = activityTransitions(baseline, next)
  assert.deepEqual(
    changes.map((event) => event.target.branchId ?? event.target.pullRequestId),
    [repo.refs[0].id, repo.pullRequests[0].id],
  )
  assert.ok(
    changes.every(
      (event) => event.observedAt === '2026-10-13T11:00:00Z' && event.eventAt === undefined,
    ),
  )
  assert.deepEqual(activityTransitions(new Map(), next), [])
  assert.deepEqual(activityTransitions(baseline, first), [])
  assert.deepEqual(activityTransitions(baseline, next), [])
})
