import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectPrGraph, prGraphId } from '../src/shared/pr-graph'
import { pullRequestInboxGroups } from '../src/shared/pr-inbox'
import type { Branch, PullRequest } from '../src/shared/types'

const pr = (
  number: number,
  head: string,
  base: string,
  author: string,
  headRepository = 'acme/widgets',
): PullRequest => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  head,
  base,
  state: 'OPEN',
  draft: false,
  checks: 'none',
  author,
  headRepository,
  reviewRequested: [],
  reviewRequestsComplete: false,
  metadata: 'degraded',
})
const branch = (name: string, parent: string | null = null): Branch => ({
  ref: `refs/heads/${name}`,
  name,
  current: false,
  remote: false,
  upstream: null,
  upstreamRef: null,
  ahead: 0,
  behind: 0,
  subject: '',
  updatedAt: '',
  parent,
  parentBehind: null,
  pr: null,
})
const id = (kind: 'pr' | 'ref', name: string) => prGraphId('github.com', 'acme/widgets', kind, name)

test('all open PRs include other authors with no personal Inbox membership; fork refs stay qualified', () => {
  const rows = [
    pr(1, 'base', 'main', 'alice'),
    pr(2, 'child', 'base', 'bob'),
    pr(3, 'fork', 'base', 'carol', 'other/widgets'),
  ]
  const graph = projectPrGraph({
    host: 'github.com',
    repository: 'acme/widgets',
    pullRequests: rows,
    branches: [branch('base'), branch('local-only')],
    complete: true,
  })
  assert.equal(graph.nodes.filter((node) => node.kind === 'pr').length, 3)
  assert.equal(
    graph.nodes.some((node) => node.name === 'refs/heads/local-only'),
    true,
  )
  assert.equal(graph.edges.find((edge) => edge.from === id('pr', '2'))?.to, id('pr', '1'))
  assert.equal(graph.edges.find((edge) => edge.from === id('pr', '3'))?.to, id('pr', '1'))
  assert.deepEqual(
    pullRequestInboxGroups(
      {
        state: 'OPEN',
        draft: false,
        author: 'bob',
        reviewRequested: [],
        reviewDecision: null,
        lastTurnLogin: null,
        updatedAt: null,
        mergedAt: null,
        metadata: 'degraded',
      },
      { viewer: null, now: 0 },
    ),
    [],
  )
  assert.notEqual(
    prGraphId('github.com', 'acme/widgets', 'ref', 'refs/heads/base'),
    prGraphId('github.com', 'other/widgets', 'ref', 'refs/heads/base'),
  )
})

test('partial pages, ambiguous heads, and cycles never manufacture a stack partition', () => {
  const graph = projectPrGraph({
    host: 'github.com',
    repository: 'acme/widgets',
    complete: false,
    pullRequests: [
      pr(1, 'same', 'missing', 'one'),
      pr(2, 'same', 'missing', 'two'),
      pr(3, 'child', 'same', 'three'),
    ],
    branches: [branch('a', 'b'), branch('b', 'a')],
  })
  assert.equal(graph.edges.find((edge) => edge.from === id('pr', '3'))?.resolution, 'ambiguous')
  assert.equal(graph.edges.find((edge) => edge.from === id('pr', '1'))?.resolution, 'incomplete')
  assert.equal(graph.edges.filter((edge) => edge.resolution === 'cycle').length, 2)
  assert.equal(graph.edges.find((edge) => edge.from === id('pr', '3'))?.to, null)
})

test('native membership does not substitute for GitHub target or local parent intent', () => {
  const parent = pr(1, 'parent', 'main', 'a')
  const child = {
    ...pr(2, 'child', 'main', 'b'),
    stack: {
      stackNumber: 8,
      position: 2,
      size: 2,
      base: 'main',
      open: true,
      url: 'https://github.com/acme/widgets/stacks/8',
    },
  }
  const graph = projectPrGraph({
    host: 'github.com',
    repository: 'acme/widgets',
    complete: true,
    pullRequests: [parent, child],
    branches: [branch('child', 'parent'), branch('parent')],
    nativeStacks: [
      {
        id: 8,
        number: 8,
        url: child.stack.url,
        base: 'main',
        open: true,
        createdAt: '',
        size: 2,
        status: 'valid',
        pullRequests: [
          {
            number: 1,
            position: 1,
            total: 2,
            head: 'parent',
            base: 'main',
            state: 'OPEN',
            draft: false,
          },
          {
            number: 2,
            position: 2,
            total: 2,
            head: 'child',
            base: 'main',
            state: 'OPEN',
            draft: false,
          },
        ],
      },
    ],
  })
  assert.equal(
    graph.edges.find((edge) => edge.from === id('pr', '2') && edge.source === 'github-base')?.to,
    null,
  )
  assert.equal(
    graph.edges.find(
      (edge) => edge.from === id('ref', 'refs/heads/child') && edge.source === 'local-parent',
    )?.to,
    id('ref', 'refs/heads/parent'),
  )
  assert.equal(
    graph.edges.find((edge) => edge.from === id('pr', '2') && edge.source === 'native-membership')
      ?.to,
    id('pr', '1'),
  )
  assert.deepEqual(graph.conflicts, [
    { pr: id('pr', '2'), githubTarget: 'main', otherTarget: 'parent', source: 'native-membership' },
  ])
})

test('qualified parent intents never fall back to a same-named local ref', () => {
  const local = branch('parent')
  const remote = {
    ...branch('parent'),
    ref: 'refs/remotes/upstream/parent',
    name: 'upstream/parent',
    remote: true,
  }
  const child = {
    ...branch('child', 'refs/remotes/upstream/parent'),
    parentSource: 'recorded' as const,
  }
  const graph = projectPrGraph({
    host: 'github.com',
    repository: 'acme/widgets',
    pullRequests: [],
    branches: [local, remote, child],
    complete: true,
  })
  assert.equal(graph.edges[0]?.to, id('ref', 'refs/remotes/upstream/parent'))
})

test('recorded local intent remains independently visible when it agrees with native membership', () => {
  const child = {
    ...branch('child', 'parent'),
    recordedParent: 'parent',
    parentSource: 'stack' as const,
  }
  const graph = projectPrGraph({
    host: 'github.com',
    repository: 'acme/widgets',
    pullRequests: [],
    branches: [branch('parent'), child],
    complete: true,
  })
  assert.deepEqual(
    graph.edges.map((edge) => edge.source),
    ['local-parent', 'native-membership'],
  )
  assert.equal(
    graph.edges.every((edge) => edge.to === id('ref', 'refs/heads/parent')),
    true,
  )
})

test('qualified equivalent targets agree while other remotes and same-name local refs stay distinct', () => {
  const childPr = pr(1, 'child', 'main', 'author')
  const origin = {
    ...branch('main'),
    ref: 'refs/remotes/origin/main',
    name: 'origin/main',
    remote: true,
  }
  const upstream = { ...origin, ref: 'refs/remotes/upstream/main', name: 'upstream/main' }
  const other = { ...origin, ref: 'refs/remotes/origin/other', name: 'origin/other' }
  for (const recorded of [
    'refs/remotes/origin/main',
    'origin/main',
    'refs/remotes/upstream/main',
    'refs/remotes/origin/other',
    'main',
  ]) {
    const graph = projectPrGraph({
      host: 'github.com',
      repository: 'acme/widgets',
      pullRequests: [childPr],
      branches: [
        origin,
        upstream,
        other,
        branch('main'),
        {
          ...branch('child', recorded),
          recordedParent: recorded,
          parentSource: 'recorded',
          pr: childPr,
        },
      ],
      complete: true,
    })
    const equivalent = recorded === 'refs/remotes/origin/main' || recorded === 'origin/main'
    assert.equal(graph.conflicts.length, equivalent ? 0 : 1, recorded)
    assert.equal(
      graph.edges.find((edge) => edge.source === 'github-base')?.to,
      id('ref', 'refs/remotes/origin/main'),
    )
    if (equivalent)
      assert.equal(
        graph.edges.find((edge) => edge.source === 'local-parent')?.to,
        id('ref', 'refs/remotes/origin/main'),
      )
  }
})

test('confirmed PR head associations reconcile local intents without collapsing provenance', () => {
  const parent = pr(1, 'parent', 'main', 'author')
  const child = pr(2, 'child', 'parent', 'author')
  const remote = {
    ...branch('parent'),
    ref: 'refs/remotes/origin/parent',
    name: 'origin/parent',
    remote: true,
  }
  const otherRemote = { ...remote, ref: 'refs/remotes/upstream/parent', name: 'upstream/parent' }
  for (const recorded of [
    'parent',
    'refs/heads/parent',
    'refs/remotes/origin/parent',
    'refs/remotes/upstream/parent',
    'refs/heads/other',
  ]) {
    const graph = projectPrGraph({
      host: 'github.com',
      repository: 'acme/widgets',
      pullRequests: [parent, child],
      branches: [
        { ...branch('parent'), pr: parent },
        remote,
        otherRemote,
        branch('other'),
        {
          ...branch('child', recorded),
          recordedParent: recorded,
          parentSource: 'recorded',
          pr: child,
        },
      ],
      complete: true,
    })
    const differs = recorded === 'refs/remotes/upstream/parent' || recorded === 'refs/heads/other'
    assert.equal(graph.conflicts.length, differs ? 1 : 0, recorded)
    assert.equal(
      graph.edges.find((edge) => edge.from === id('pr', '2') && edge.source === 'github-base')?.to,
      id('pr', '1'),
    )
    assert.equal(graph.edges.filter((edge) => edge.source === 'local-parent').length, 1)
    assert.equal(
      graph.edges.filter((edge) => edge.from === id('pr', '1') && edge.source === 'github-head')
        .length,
      2,
    )
  }
})

test('fork head and missing source associations cannot reconcile a local ref by short name', () => {
  for (const headRepository of ['other/widgets', undefined]) {
    const parent = { ...pr(1, 'parent', 'main', 'author'), headRepository }
    const child = pr(2, 'child', 'parent', 'author')
    const graph = projectPrGraph({
      host: 'github.com',
      repository: 'acme/widgets',
      pullRequests: [parent, child],
      branches: [
        { ...branch('parent'), pr: parent },
        { ...branch('parent'), ref: 'refs/remotes/origin/parent', remote: true },
        {
          ...branch('child', 'refs/heads/parent'),
          recordedParent: 'refs/heads/parent',
          parentSource: 'recorded',
          pr: child,
        },
      ],
      complete: true,
    })
    assert.equal(graph.conflicts.length, 1)
    assert.equal(
      graph.edges.some((edge) => edge.from === id('pr', '1') && edge.source === 'github-head'),
      false,
    )
  }
})
