import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createGitHubHarness } from './fixtures/github-harness'
import type { GitHubFixtureState, GitHubHarness } from './fixtures/github-harness'

// Git Stacks captures Node's spawn API when its own modules load, and the GitHub
// harness answers `git` and `gh` on that API, so Git Stacks is loaded here. Nothing
// may reach `node:child_process` through an ESM import before the harness module
// body runs: the builtin facade keeps the export it first sees, so a static import
// above would hand Git Stacks the unpatched `execFile`.
const { getSnapshot, runAction } = await import('../src/main/git')
const { getMergeStatus, previewStack } = await import('../src/main/stacks')
const { setGitHubTransport } = await import('../src/main/github-transport')
const { createGitHubApiDouble } = await import('./fixtures/github-api-double')
const { GITHUB_API_URL_ENV } = await import('../src/main/github-transport')

/**
 * The asynchronous merge flow, end to end through the production read path: a real
 * disposable repository, the real `DirectGitHubTransport` the main process builds,
 * real HTTP over a socket, and the real API double answering as a server.
 *
 * The point is the layer a stubbed `fetch` cannot reach. A throw injected into a
 * fixture answers a different question than a 500 or a dropped connection does: the
 * production transport turns the first into a `GitHubTransportError` it may retry, and
 * the second into an error the caller must survive without inventing state.
 */
interface LiveGitHub {
  url: string
  server: Server
}

async function serveGitHub(): Promise<LiveGitHub> {
  const api = createGitHubApiDouble()
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      void (async () => {
        const host = request.headers.host ?? '127.0.0.1'
        const url = `http://${host}${request.url ?? '/'}`
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers.set(name, value)
        }
        try {
          const answered = await api(url, {
            method: request.method,
            headers,
            body: chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined,
          })
          response.writeHead(answered.status, Object.fromEntries(answered.headers.entries()))
          response.end(await answered.text())
        } catch (error) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ message: String(error) }))
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no local port')
  return { url: `http://127.0.0.1:${address.port}`, server }
}

/**
 * Runs `body` with Git Stacks' own transport built from the environment, pointed at
 * the local server, so nothing about the request path is injected.
 */
async function withLiveGitHub(
  run: (harness: GitHubHarness, live: LiveGitHub) => Promise<void>,
): Promise<void> {
  const harness = await createGitHubHarness()
  const original = { ...process.env }
  const live = await serveGitHub()
  setGitHubTransport(null)
  try {
    for (const [key, value] of Object.entries(harness.env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    process.env[GITHUB_API_URL_ENV] = live.url
    process.env.GH_TOKEN = 'fixture-token'
    await run(harness, live)
  } finally {
    setGitHubTransport(null)
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise<void>((resolve) => live.server.close(() => resolve()))
    await harness.close()
  }
}

function git(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['-C', harness.repo, ...args])
}

async function commitFile(
  harness: GitHubHarness,
  filePath: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(harness.repo, filePath), contents, 'utf8')
  git(harness, ['add', '--', filePath])
  git(harness, ['commit', '-m', message])
  return git(harness, ['rev-parse', 'HEAD'])
}

function prFor(state: GitHubFixtureState, branch: string) {
  const pr = state.prs.find((entry) => entry.head === branch)
  assert.ok(pr, `fixture has no PR for ${branch}`)
  return pr
}

/** A two-layer stack, published, with GitHub willing to land it. */
async function publishedStack(harness: GitHubHarness): Promise<GitHubFixtureState> {
  await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'main' })
  await commitFile(harness, 'parent.txt', 'parent\n', 'Parent work')
  await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
  await commitFile(harness, 'child.txt', 'child\n', 'Child work')
  const snapshot = await getSnapshot(harness.repo)
  const preview = await previewStack(harness.repo, snapshot, 'publish', 'child')
  assert.deepEqual(preview.blockers, [])
  await runAction(harness.repo, {
    type: 'submitStack',
    token: preview.token,
    allowForce: false,
    layers: {
      parent: { title: 'Parent title', body: '', draft: false, updateBase: true },
      child: { title: 'Child title', body: '', draft: false, updateBase: true },
    },
  })
  const state = await harness.readState()
  for (const pr of state.prs) {
    if (pr.state !== 'OPEN') continue
    pr.draft = false
    pr.checks = 'passing'
  }
  await harness.writeState(state)
  return state
}

async function mergePreviewFor(harness: GitHubHarness, branch: string) {
  const preview = await previewStack(harness.repo, await getSnapshot(harness.repo), 'merge', branch)
  assert.deepEqual(preview.blockers, [])
  assert.ok(preview.merge, 'the preview describes a merge')
  return preview
}

async function dispatchMerge(harness: GitHubHarness, token: string) {
  return runAction(harness.repo, {
    type: 'executeStack',
    token,
    allowForce: false,
    mergeMethod: 'squash',
    mergeAction: 'direct_merge',
  })
}

test(
  'a request that enqueues after the run is reported as enqueued on the first refresh',
  { concurrency: false },
  async () => {
    await withLiveGitHub(async (harness) => {
      await publishedStack(harness)
      const running = await harness.readState()
      running.asyncMergeStaysPending = true
      await harness.writeState(running)
      const preview = await mergePreviewFor(harness, 'child')
      const result = await dispatchMerge(harness, preview.token)
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['pending', 'pending'],
        'a run GitHub is still running is not a finished merge',
      )

      // The queue accepts the group between the run and the first refresh.
      const accepted = await harness.readState()
      accepted.asyncMergeStaysPending = false
      accepted.asyncMergeResult = { status: 'enqueued' }
      await harness.writeState(accepted)
      const first = await getMergeStatus(harness.repo)
      assert.deepEqual(
        first?.layers.map((layer) => [
          layer.pullRequest,
          layer.status,
          layer.queue?.outcome ?? null,
        ]),
        [
          [prFor(accepted, 'parent').number, 'enqueued', 'queued'],
          [prFor(accepted, 'child').number, 'enqueued', 'queued'],
        ],
        'the queue that accepted the group reports holding it, by GitHub membership',
      )

      // The enqueue is journalled, so it outlives the result endpoint.
      const expired = await harness.readState()
      delete expired.asyncMerge
      await harness.writeState(expired)
      const later = await getMergeStatus(harness.repo)
      assert.deepEqual(
        later?.layers.map((layer) => [layer.pullRequest, layer.status]),
        [
          [prFor(accepted, 'parent').number, 'enqueued'],
          [prFor(accepted, 'child').number, 'enqueued'],
        ],
        'the accepted enqueue survives the request expiring',
      )
    })
  },
)

test(
  'a pull request closed before the first refresh is a queue drop, not an enqueue',
  { concurrency: false },
  async () => {
    await withLiveGitHub(async (harness) => {
      const ready = await publishedStack(harness)
      const parentNumber = prFor(ready, 'parent').number
      const running = await harness.readState()
      running.asyncMergeStaysPending = true
      await harness.writeState(running)
      const preview = await mergePreviewFor(harness, 'child')
      await dispatchMerge(harness, preview.token)

      // Somebody closes the group underneath the queue before anything is read back.
      const closed = await harness.readState()
      closed.asyncMergeStaysPending = false
      closed.asyncMergeResult = { status: 'enqueued' }
      const parent = prFor(closed, 'parent')
      parent.state = 'CLOSED'
      parent.mergedAt = null
      await harness.writeState(closed)
      const status = await getMergeStatus(harness.repo)
      assert.equal(
        status?.layers.find((layer) => layer.pullRequest === parentNumber)?.status,
        'not-merged',
      )
      assert.equal(
        status?.layers.find((layer) => layer.pullRequest === parentNumber)?.queue?.outcome,
        'dropped',
        'a closed pull request is read as dropped on the very refresh that learns the enqueue',
      )
    })
  },
)

test(
  'a later refresh that cannot read the pull request keeps what a read confirmed',
  { concurrency: false },
  async () => {
    await withLiveGitHub(async (harness) => {
      const ready = await publishedStack(harness)
      const parentNumber = prFor(ready, 'parent').number
      const preview = await mergePreviewFor(harness, 'parent')
      const result = await dispatchMerge(harness, preview.token)
      assert.equal(result.merge?.layers[0]?.status, 'merged', 'GitHub landed the request')

      const confirmed = await getMergeStatus(harness.repo)
      assert.equal(confirmed?.layers[0]?.status, 'merged')

      // GitHub stops answering for the pull request. A read that cannot reach it has no
      // evidence that the merge was undone, and must not report the request as queued.
      const unreachable = await harness.readState()
      // A pull request is read over GraphQL, so the rule takes that endpoint down and
      // repeats, because what is being tested is a GitHub that cannot answer for this pull
      // request, not one dropped response.
      unreachable.lostResponses = Array.from({ length: 8 }, () => ({
        method: 'POST',
        pathIncludes: 'graphql',
        status: 502,
        message: 'Bad gateway',
      }))
      await harness.writeState(unreachable)
      const failed = await getMergeStatus(harness.repo)
      assert.equal(
        failed?.layers[0]?.status,
        'merged',
        'a failed read is not evidence that a confirmed merge was undone',
      )

      // The confirmation itself was journalled, so a restart keeps it too.
      const again = await harness.readState()
      delete again.lostResponses
      await harness.writeState(again)
      const recovered = await getMergeStatus(harness.repo)
      assert.equal(recovered?.layers[0]?.status, 'merged')
    })
  },
)
