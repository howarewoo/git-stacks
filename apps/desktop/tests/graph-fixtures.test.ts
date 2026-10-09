import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectPrGraph } from '@git-stacks/shared/pr-graph'
import {
  GRAPH_AUTHORS,
  GRAPH_SIZES,
  changeGraphIndex,
  graphBranches,
  graphDetail,
  graphIndex,
} from './renderer/fixtures/graph'
import { scenarios } from './renderer/fixtures/scenarios'

for (const size of GRAPH_SIZES) {
  test(`graph ${size} fixture preserves deterministic source identities and topology`, () => {
    const index = graphIndex(size)
    assert.deepEqual(index, graphIndex(size))
    assert.equal(index.pullRequests.length, size)
    assert.equal(new Set(index.pullRequests.map((row) => row.number)).size, size)
    assert.deepEqual(
      [...new Set(index.pullRequests.map((row) => row.author))].sort(),
      [...GRAPH_AUTHORS].sort(),
    )
    assert.ok(index.pullRequests.every((row) => !row.stack))
    const row = (n: number) => index.pullRequests[n - 1]!
    assert.equal(row(100).base, row(99).head)
    assert.notEqual(row(100).author, row(99).author)
    assert.equal(row(101).base, row(40).head)
    assert.equal(row(180).base, row(40).head)
    assert.equal(row(181).base, row(120).head)
    assert.equal(row(201).base, row(20).head)
    const branches = graphBranches(index.pullRequests)
    assert.ok(branches.some((branch) => branch.ref === 'refs/heads/graph/local-only' && !branch.pr))
    assert.ok(
      branches.some(
        (branch) => branch.ref === 'refs/remotes/origin/graph/remote-only' && !branch.pr,
      ),
    )
    assert.ok(!branches.some((branch) => branch.pr?.number === size))
    const graph = projectPrGraph({
      host: index.host,
      repository: index.fullName,
      pullRequests: index.pullRequests,
      branches,
      complete: index.complete,
    })
    assert.equal(graph.nodes.filter((node) => node.kind === 'pr').length, size)
    assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length)
    assert.equal(scenarios[`graph-${size}`].prIndex?.pullRequests.length, size)
    assert.equal(index.repository, scenarios[`graph-${size}`].snapshot?.path)
  })
}

test('incomplete, failed and unsupported source facts are not confirmed absent', () => {
  for (const state of ['partial', 'error'] as const) {
    const index = graphIndex(1000, state)
    assert.equal(index.complete, false)
    assert.equal(index.pages, 1)
    assert.equal(index.pullRequests.length, 100)
    assert.ok(index.message)
  }
  const degraded = graphIndex(250, 'complete', true)
  assert.ok(
    degraded.pullRequests.every(
      (row) =>
        row.metadata === 'degraded' &&
        row.checks === 'none' &&
        !row.reviewRequestsComplete &&
        row.reviewRequested === undefined,
    ),
  )
  assert.equal(graphIndex(250, 'stale').complete, false)
  assert.equal(scenarios['graph-index-unavailable'].prIndex, undefined)
})

test('external updates preserve identity, expose same-head retargets and feed selected details', () => {
  const initial = graphIndex(250)
  const original = initial.pullRequests[49]!
  for (const change of ['head', 'base', 'status'] as const) {
    const updated = changeGraphIndex(initial, 50, change)
    const selected = graphDetail(updated, 50)
    assert.equal(selected.number, original.number)
    assert.equal(selected.url, original.url)
    assert.equal(updated.pullRequests[48], initial.pullRequests[48])
    assert.ok(selected.body.length > 3000)
    if (change === 'head') assert.notEqual(selected.headOid, original.headOid)
    if (change === 'base') {
      assert.equal(selected.headOid, original.headOid)
      assert.notEqual(selected.base, original.base)
    }
    if (change === 'status') assert.equal(selected.checks, 'failing')
  }
  assert.deepEqual(initial, graphIndex(250))
  assert.throws(() => graphDetail(initial, 99999), /not in this repository/)
  assert.throws(() => changeGraphIndex(initial, 99999, 'base'), /Unknown graph PR/)
})
