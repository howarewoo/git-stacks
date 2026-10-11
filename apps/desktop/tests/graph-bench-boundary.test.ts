import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GRAPH_SELECTED_CACHE_LIMIT } from '@git-stacks/shared/performance'
import type { PullRequest } from '@git-stacks/shared/types'
import { ProgressivePullRequestIndex } from '../src/main/pr-index'
import { startGraphApiDouble } from '../scripts/perf/desktop-graph'
import {
  getGitHubData,
  getGitHubIssues,
  getPullRequest,
  getPullRequestIndexPage,
} from '../src/main/github'
import { DirectGitHubTransport, setGitHubTransport } from '../src/main/github-transport'

function createSamplePr(number: number): PullRequest {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/fixture/graph-workbench/pull/${number}`,
    head: `graph/change-${number}`,
    base: 'main',
    state: 'OPEN',
    draft: false,
    checks: 'passing',
    headOid: number.toString(16).padStart(40, '0'),
    headRepository: 'fixture/graph-workbench',
    author: 'author-01',
    reviewRequested: [],
    reviewRequestsComplete: true,
    metadata: 'full',
  }
}

test('prIndex maintains strictly bounded selected-detail LRU cache of size GRAPH_SELECTED_CACHE_LIMIT', async () => {
  const index = new ProgressivePullRequestIndex(
    async () => ({
      pullRequests: Array.from({ length: 10 }, (_, i) => createSamplePr(i + 1)),
      next: null,
      viewer: 'author-01',
      conservative: false,
    }),
    async () => 'auth-1',
    () => {},
    () => true,
  )

  await index.load('/tmp/test-repo', 'github.com', 'https://github.com/fixture/graph-workbench')

  const readCounts = new Map<number, number>()
  const readDetail = async (num: number) => {
    readCounts.set(num, (readCounts.get(num) ?? 0) + 1)
    return { ...createSamplePr(num), body: `Body for #${num}` }
  }

  // Load details for 1, 2, 3, 4 (fills cache of 4)
  for (let i = 1; i <= GRAPH_SELECTED_CACHE_LIMIT; i++) {
    await index.selected(i, () => readDetail(i))
  }
  assert.equal(readCounts.size, GRAPH_SELECTED_CACHE_LIMIT)
  for (let i = 1; i <= GRAPH_SELECTED_CACHE_LIMIT; i++) {
    assert.equal(readCounts.get(i), 1)
  }

  // Access 2 again: should hit cache without calling readDetail
  const hit2 = await index.selected(2, () => readDetail(2))
  assert.equal(hit2.number, 2)
  assert.equal(readCounts.get(2), 1)

  // Load 5: exceeds limit (size 4), so the oldest entry (1) should be evicted, but 2 was refreshed
  await index.selected(5, () => readDetail(5))
  assert.equal(readCounts.get(5), 1)

  // Re-requesting 2 should still be a cache hit (was refreshed)
  await index.selected(2, () => readDetail(2))
  assert.equal(readCounts.get(2), 1)

  // Re-requesting 1 should be a cache miss (was evicted), calling readDetail again
  await index.selected(1, () => readDetail(1))
  assert.equal(readCounts.get(1), 2)

  // Explicit refresh clears all cached details
  await index.refresh('/tmp/test-repo', 'github.com', 'https://github.com/fixture/graph-workbench')
  await index.selected(2, () => readDetail(2))
  assert.equal(readCounts.get(2), 2)
})

test('strict benchmark producer serves actual main query variants and rejects foreign or mutating operations', async (t) => {
  const api = await startGraphApiDouble()
  t.after(() => api.close())
  const repo = await mkdtemp(join(tmpdir(), 'graph-producer-main-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-b', 'main', repo])
  const origin = 'https://github.com/fixture/graph-workbench.git'
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin])
  const previous = setGitHubTransport(
    new DirectGitHubTransport({
      host: 'github.com',
      apiUrl: api.base,
      graphqlUrl: `${api.base}/graphql`,
      env: { GIT_STACKS_GITHUB_API_URL: api.base },
      token: 'controlled-benchmark-fixture',
      reportRateLimit: false,
    }),
  )
  t.after(() => setGitHubTransport(previous))

  const first = await getPullRequestIndexPage(origin, null, false)
  const second = await getPullRequestIndexPage(origin, first.next, false)
  assert.equal(first.next, 'cursor-50')
  assert.equal(first.pullRequests.at(-1)?.number, 50)
  assert.equal(second.pullRequests[0]?.number, 51)
  assert.equal(
    new Set([...first.pullRequests, ...second.pullRequests].map((pr) => pr.number)).size,
    100,
  )
  const conservative = await getPullRequestIndexPage(origin, null, true)
  assert.equal(conservative.pullRequests[0]?.author, null)
  assert.equal(conservative.pullRequests[0]?.reviewRequestsComplete, false)

  const snapshot = await getGitHubData(repo, origin)
  assert.equal(snapshot.available, true)
  assert.equal(new Set(snapshot.pullRequests.map((pr) => pr.number)).size, 250)
  assert.equal(snapshot.pullRequests.at(-1)?.number, 250)
  const selected = await getPullRequest(repo, 40)
  assert.equal(selected.number, 40)
  assert.equal(selected.headRepository, 'fixture/graph-workbench')
  assert.equal(selected.base, 'graph/change-39')
  await getGitHubIssues(repo, origin)

  const indexRequest = api
    .getRequests()
    .find((request) => request.query?.includes('$cursor: String'))!
  const issuesRequest = api
    .getRequests()
    .find((request) => request.query?.includes('issues(first:'))!
  const admittedIssues = await fetch(`${api.base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: issuesRequest.query, variables: issuesRequest.variables }),
  })
  assert.equal(admittedIssues.status, 200)
  await admittedIssues.arrayBuffer()
  const rejected = [
    { query: indexRequest.query, variables: { owner: 'foreign', name: 'private', cursor: null } },
    {
      query: indexRequest.query!.replace('query(', 'mutation('),
      variables: indexRequest.variables,
    },
    {
      query: indexRequest.query!.replace(
        'repository(owner: $owner, name: $name)',
        'repository(owner: "foreign", name: "private")',
      ),
      variables: indexRequest.variables,
    },
    {
      query: `${issuesRequest.query} query Extra { repository(owner: "foreign", name: "private") { issues(first: 100) { nodes { number } } } }`,
      variables: issuesRequest.variables,
    },
    {
      query: 'query Unknown { issues(first: 100) { nodes { number } } }',
      variables: { owner: 'fixture', name: 'graph-workbench' },
    },
    { query: 'toString', variables: { owner: 'fixture', name: 'graph-workbench' } },
  ]
  for (const payload of rejected) {
    const response = await fetch(`${api.base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 400, JSON.stringify(payload))
    await response.arrayBuffer()
  }
  assert.equal((await fetch(`${api.base}/repos/foreign/private`)).status, 404)
  assert.equal((await fetch(`${api.base}/repos/foreign/private/user`)).status, 404)
})
