import test from 'node:test'
import assert from 'node:assert/strict'
import {
  graphDiscovery,
  graphMatches,
  graphOutline,
  focusedGraph,
  dependentPaths,
  type GraphCriteria,
} from '../src/shared/graph-workbench'
import { projectPrGraph, prGraphId } from '../src/shared/pr-graph'
import { graphIndex, graphBranches } from './renderer/fixtures/graph'
import { GRAPH_DETAIL_NODE_LIMIT } from '../src/shared/performance'
const criteria: GraphCriteria = {
  preset: 'all-open',
  text: '',
  author: '',
  status: 'all',
  collapse: true,
}
function fixture() {
  const index = graphIndex(1000)
  return {
    index,
    discovery: graphDiscovery(
      projectPrGraph({
        host: index.host,
        repository: index.fullName,
        pullRequests: index.pullRequests,
        branches: graphBranches(index.pullRequests),
        complete: true,
      }),
    ),
  }
}
function id(number: number) {
  const index = graphIndex(250)
  return prGraphId(index.host, index.fullName, 'pr', String(number))
}
test('presets match individual facts without assigning ownership and unknown identity is explicit', () => {
  const { index, discovery } = fixture()
  const node = discovery.byId.get(id(1))!
  assert.equal(graphMatches(node, { ...criteria, preset: 'my-prs' }, node.pr!.author!), true)
  assert.equal(graphMatches(node, { ...criteria, preset: 'my-prs' }, null), false)
  assert.equal(graphMatches({ ...node, pr: { ...node.pr!, draft: true } }, criteria, null), true)
  assert.equal(
    graphMatches({ ...node, pr: { ...node.pr!, state: 'CLOSED' } }, criteria, null),
    false,
  )
  assert.equal(
    graphMatches(
      { ...node, pr: { ...node.pr!, reviewRequested: ['someone'], reviewRequestsComplete: true } },
      { ...criteria, preset: 'review-requested' },
      'someone',
    ),
    true,
  )
  assert.equal(
    graphMatches(
      { ...node, pr: { ...node.pr!, metadata: 'degraded', checks: 'failing' } },
      { ...criteria, status: 'checks-failed' },
      index.viewer,
    ),
    false,
  )
  assert.equal(
    graphOutline(discovery, { ...criteria, preset: 'my-prs' }, null, null, new Set())
      .unknownIdentity,
    true,
  )
  const current = [...discovery.byId.values()].find((item) => item.branch?.current)!
  assert.equal(graphMatches(current, { ...criteria, preset: 'current-branch' }, null), true)
})
test('a filtered leaf retains prerequisites once but never all siblings sharing an ancestor', () => {
  const { discovery } = fixture()
  const filtered = graphOutline(
    discovery,
    { ...criteria, text: '#101', collapse: false },
    null,
    null,
    new Set(),
  )
  const ids = filtered.rows.flatMap((row) => row.path)
  assert.ok(ids.includes(id(101)))
  assert.ok(ids.includes(id(40)))
  assert.equal(ids.includes(id(102)), false)
  assert.equal(ids.length, new Set(ids).size)
})
test('selection outside filters is retained as context and exact forks cannot collapse', () => {
  const { discovery } = fixture()
  const outline = graphOutline(
    discovery,
    { ...criteria, author: 'not-a-known-author' },
    null,
    id(101),
    new Set(),
  )
  assert.equal(outline.matches, 0)
  assert.ok(outline.rows.some((row) => row.id === id(101) && row.role === 'selected-context'))
  assert.ok(outline.rows.some((row) => row.path.includes(id(40)) && row.path.length === 1))
  assert.equal(discovery.parents.get(id(181))?.[0], id(120))
  assert.equal(discovery.parents.get(id(120))?.[0], id(40))
})
test('collapsed runs carry every real intermediate identity and expand without fabricating direct edges', () => {
  const { discovery } = fixture()
  const result = graphOutline(discovery, criteria, null, null, new Set())
  const run = result.rows.find((row) => row.path.length > 2)!
  assert.ok(run)
  for (let i = 1; i < run.path.length; i++)
    assert.ok(discovery.parents.get(run.path[i - 1])?.includes(run.path[i]))
  const expanded = graphOutline(discovery, criteria, null, null, new Set(run.path))
  for (const endpoint of run.path)
    assert.ok(expanded.rows.some((row) => row.id === endpoint && row.path.length === 1))
})
test('deep focus is bounded before layout and wide endpoints remain searchable without mounting lanes', () => {
  const { discovery } = fixture()
  const focus = focusedGraph(discovery, id(100), null)
  assert.equal(focus.nodes.length, GRAPH_DETAIL_NODE_LIMIT)
  assert.ok(focus.omitted > 0)
  const endpoints = dependentPaths(discovery, id(40))
  assert.ok(endpoints.some((node) => node.id === id(181)))
  assert.ok(endpoints.length > 80)
  const nested = focusedGraph(discovery, id(40), id(181))
  assert.ok(nested.edges.some((edge) => edge.from === id(181) && edge.to === id(120)))
  assert.equal(
    nested.nodes.some((node) => node.id === id(121)),
    false,
  )
})

test('partial indexing retains known PR-backed refs as incomplete context without invented PR matches', () => {
  const index = graphIndex(250)
  const graph = projectPrGraph({
    host: index.host,
    repository: index.fullName,
    pullRequests: index.pullRequests.slice(0, 1),
    branches: graphBranches(index.pullRequests),
    complete: false,
  })
  const outline = graphOutline(
    graphDiscovery(graph),
    { ...criteria, text: 'graph/change-2', collapse: false },
    null,
    null,
    new Set(),
  )
  const ref = prGraphId(index.host, index.fullName, 'ref', 'refs/heads/graph/change-2')
  assert.equal(outline.matches, 0)
  assert.ok(outline.rows.some((row) => row.id === ref && row.role === 'context'))
  assert.equal(
    graph.nodes.some((node) => node.pr?.number === 2),
    false,
  )
  assert.equal(graph.complete, false)
})

test('Current branch author, text and known status filters use its real associated PR only', () => {
  const { discovery } = fixture()
  const current = [...discovery.byId.values()].find((node) => node.branch?.current)!
  const currentCriteria = { ...criteria, preset: 'current-branch' as const }
  assert.equal(graphMatches(current, { ...currentCriteria, author: 'AUTHOR-01' }, null), true)
  assert.equal(graphMatches(current, { ...currentCriteria, text: 'Change 1' }, null), true)
  assert.equal(graphMatches(current, { ...currentCriteria, status: 'ready' }, null), true)
  assert.equal(graphMatches(current, { ...currentCriteria, author: 'author-02' }, null), false)
  assert.equal(graphMatches(current, { ...criteria, preset: 'my-prs' }, 'author-01'), false)
  assert.equal(
    graphMatches(
      { ...current, branch: { ...current.branch!, pr: null } },
      { ...currentCriteria, status: 'ready' },
      null,
    ),
    false,
  )
})

test('a GitHub/local-intent disagreement is a dedicated collapse breakpoint', () => {
  const index = graphIndex(250)
  const rows = index.pullRequests.slice(0, 5)
  const branches = graphBranches(rows).map((branch) =>
    branch.pr?.number === 3
      ? { ...branch, parent: 'main', recordedParent: 'main', parentSource: 'recorded' as const }
      : branch,
  )
  const graph = projectPrGraph({
    host: index.host,
    repository: index.fullName,
    pullRequests: rows,
    branches,
    complete: true,
  })
  assert.ok(graph.conflicts.some((conflict) => conflict.pr === id(3)))
  const discovery = graphDiscovery(graph)
  const outline = graphOutline(discovery, criteria, null, null, new Set())
  assert.ok(outline.rows.some((row) => row.id === id(3) && row.path.length === 1))
  assert.equal(
    outline.rows.some((row) => row.path.length > 1 && row.path.includes(id(3))),
    false,
  )
  for (const row of outline.rows)
    for (let i = 1; i < row.path.length; i++)
      assert.ok(discovery.parents.get(row.path[i - 1])?.includes(row.path[i]))
})
