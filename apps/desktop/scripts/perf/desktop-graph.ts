import type { ChildProcess } from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import electron from 'electron'
import {
  GRAPH_REPOSITORY,
  type GraphSize,
  graphDetail,
  graphIndex,
  graphRows,
} from '../../tests/renderer/fixtures/graph'
import {
  GRAPH_DETAIL_NODE_LIMIT,
  GRAPH_NAVIGATION_CYCLE_COUNT,
  GRAPH_OUTLINE_ROW_LIMIT,
  GRAPH_PATH_PAGE_SIZE,
  GRAPH_SELECTED_CACHE_LIMIT,
  GRAPH_WARM_SAMPLE_COUNT,
} from '@git-stacks/shared/performance'
import type { PullRequest } from '@git-stacks/shared/types'
import {
  type CdpClient,
  click,
  connect,
  evaluate,
  freePort,
  pageTarget,
  until,
} from './desktop-interaction.mjs'

export interface GraphWarmSamples {
  warmInputPaintMs: number
  warmSamples: number[]
  warmProjectionLayoutMs: number
  warmProjectionSamples: number[]
}

export interface GraphBenchmarkResult {
  projectionLayout250Ms: number
  projectionLayout1000Ms: number
  projectionLayout5000Ms: number
  heap250Bytes: number
  heap1000Bytes: number
  heap5000Bytes: number
  snapshotRecords: Record<GraphSize, number>
  heapScaleGrowthBytes: number
  warmInputPaintMs: number
  warmInputPaintSamples: number[]
  warmProjectionLayoutMs: number
  warmProjectionLayoutSamples: number[]
  warmSamplesBySize: Record<GraphSize, GraphWarmSamples>
  bounds5000: {
    outlineRows: number
    detailNodes: number
    pathItems: number
  }
  selectedCacheBound: {
    retained: number
    evictionsObserved: boolean
  }
  scopedRequests: {
    total: number
    indexPages250: number
    indexPages1000: number
    indexPages5000: number
    localExploration: number
    navigationRefresh: number
    navigationIndexPages: number
    identityProof: number
    repositoryMetadata: number
    nativeStacks: number
    snapshotPages: number
    issuePages: number
    unrelated: number
  }
  navBaselineBytes: number
  navigationCycleIndexPages: number[]
  snapshotCompletedRefreshes: number
  supersededProgressiveSequences: number
  navPostCycleBytes: number
  heapNavGrowthBytes: number
}

interface MetricEntry {
  name: string
  value: number
}

interface PerformanceMetricsResponse {
  metrics?: MetricEntry[]
}

function prToIndexGraphQlNode(pr: PullRequest) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRefName: pr.head,
    headRefOid: pr.headOid,
    baseRefName: pr.base,
    isDraft: pr.draft,
    state: pr.state ?? 'OPEN',
    headRepository: { nameWithOwner: pr.headRepository ?? GRAPH_REPOSITORY },
    author: pr.author ? { login: pr.author } : null,
    reviewRequests: {
      nodes: (pr.reviewRequested ?? []).map((login) => ({
        requestedReviewer: { __typename: 'User', login },
      })),
      pageInfo: { hasNextPage: false },
    },
  }
}

function prToFullGraphQlNode(pr: PullRequest) {
  return {
    ...prToIndexGraphQlNode(pr),
    author: pr.author ? { login: pr.author } : null,
    reviewDecision: pr.reviewDecision,
    reviewRequests: {
      nodes: (pr.reviewRequested ?? []).map((login) => ({
        requestedReviewer: { __typename: 'User', login },
      })),
      pageInfo: { hasNextPage: false },
    },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state:
                pr.checks === 'failing'
                  ? 'FAILURE'
                  : pr.checks === 'pending'
                    ? 'PENDING'
                    : 'SUCCESS',
            },
          },
        },
      ],
    },
  }
}

type BenchmarkRead = 'identity' | 'index' | 'detail' | 'snapshot' | 'issues'
const canonicalQuery = (query: string) => query.replace(/\s+/g, ' ').trim()
// Exact main-owned templates, including conservative schema variants. Aliases,
// literal repositories, extra selections and mutations are not benchmark reads.
const benchmarkReads: Record<string, BenchmarkRead> = {
  [canonicalQuery('query UserCurrent { viewer { login } }')]: 'identity',
  [canonicalQuery(`query($owner: String!, $name: String!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $endCursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { number title url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`)]: 'issues',
}
for (const conservative of [false, true]) {
  const basic =
    'number title url headRefName headRefOid baseRefName isDraft state headRepository { nameWithOwner }'
  const authors =
    'author { login } reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } pageInfo { hasNextPage } }'
  const readiness = `${authors} reviewDecision mergeStateStatus commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`
  const fields = `${basic} mergeCommit { oid }${conservative ? '' : ` ${readiness}`}`
  const detailFields = `${basic} mergeCommit { oid } body${conservative ? '' : ` ${readiness}`}`
  benchmarkReads[
    canonicalQuery(`query($owner: String!, $name: String!, $cursor: String) {
    viewer { login }
    repository(owner: $owner, name: $name) {
      pullRequests(first: 50, after: $cursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { ${basic} ${conservative ? '' : authors} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`)
  ] = 'index'
  benchmarkReads[
    canonicalQuery(`query($owner: String!, $name: String!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 100, after: $endCursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { ${fields} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`)
  ] = 'snapshot'
  benchmarkReads[
    canonicalQuery(`query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { ${detailFields} }
    }
  }`)
  ] = 'detail'
}

export interface GraphApiDouble {
  base: string
  setSize: (size: GraphSize) => void
  getSize: () => GraphSize
  getRequests: () => Array<{
    method: string
    path: string
    query?: string
    variables?: unknown
  }>
  getDetailRequests: () => number[]
  clearDetailRequests: () => void
  getIndexPageRequests: () => number
  resetIndexPageRequests: () => void
  close: () => Promise<void>
}

export async function startGraphApiDouble(): Promise<GraphApiDouble> {
  let activeSize: GraphSize = 250
  const recordedRequests: Array<{
    method: string
    path: string
    query?: string
    variables?: unknown
  }> = []
  const detailRequests: number[] = []
  let indexPageRequests = 0

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': status === 200 ? '4999' : '4998',
      'x-ratelimit-reset': '2147483647',
    })
    res.end(JSON.stringify(body))
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []

    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let parsedBody: Record<string, unknown> | null = null
      if (rawBody.trim()) {
        try {
          const parsed = JSON.parse(rawBody)
          if (parsed && typeof parsed === 'object') {
            parsedBody = parsed as Record<string, unknown>
          }
        } catch {
          // not valid json
        }
      }

      const query = typeof parsedBody?.query === 'string' ? parsedBody.query : undefined
      const variables = parsedBody?.variables

      recordedRequests.push({
        method: req.method ?? '',
        path: url.pathname,
        query,
        variables,
      })

      // REST /user
      if (req.method === 'GET' && url.pathname === '/user') {
        send(res, 200, {
          login: 'author-01',
          id: 1,
          type: 'User',
          name: 'author-01',
        })
        return
      }

      if (
        req.method === 'GET' &&
        ['/repos/fixture/graph-workbench', '/repos/fixture/graph-workbench/stacks'].includes(
          url.pathname,
        )
      ) {
        send(res, 200, url.pathname.endsWith('/stacks') ? [] : { default_branch: 'main' })
        return
      }

      // POST /graphql
      if (req.method === 'POST' && url.pathname === '/graphql') {
        const queryText = query ?? ''
        const varsObj =
          variables && typeof variables === 'object' ? (variables as Record<string, unknown>) : {}
        const queryKey = canonicalQuery(queryText)
        const operation = Object.hasOwn(benchmarkReads, queryKey)
          ? benchmarkReads[queryKey]
          : undefined
        const identityRead = operation === 'identity'
        if (
          !operation ||
          (identityRead && Object.keys(varsObj).length !== 0) ||
          (!identityRead && (varsObj.owner !== 'fixture' || varsObj.name !== 'graph-workbench'))
        ) {
          send(res, 400, { errors: [{ message: 'Unscoped or mutating benchmark query' }] })
          return
        }

        // 1. Single PR detail query
        if (operation === 'detail') {
          const prNumber = Number(varsObj.number)
          detailRequests.push(prNumber)
          try {
            const index = graphIndex(activeSize)
            const detail = graphDetail(index, prNumber)
            send(res, 200, {
              data: {
                repository: {
                  pullRequest: {
                    ...prToFullGraphQlNode(detail),
                    body: detail.body,
                    mergeCommit: {
                      oid: '0000000000000000000000000000000000000000',
                    },
                    mergeStateStatus: 'CLEAN',
                  },
                },
              },
            })
          } catch (err) {
            send(res, 404, {
              errors: [{ message: `Pull request #${prNumber} not found: ${err}` }],
            })
          }
          return
        }

        // 2. PR Index page query (getPullRequestIndexPage)
        if (operation === 'index') {
          indexPageRequests++
          const allPrs = graphRows(activeSize)
          const PAGE_SIZE = 50
          let start = 0
          const cursorVal = varsObj.cursor
          if (typeof cursorVal === 'string' && cursorVal) {
            const match = /^cursor-(\d+)$/.exec(cursorVal)
            if (match) start = parseInt(match[1], 10)
          }
          const end = Math.min(start + PAGE_SIZE, activeSize)
          const slice = allPrs.slice(start, end)
          const hasNextPage = end < activeSize
          const endCursor = hasNextPage ? `cursor-${end}` : null

          send(res, 200, {
            data: {
              viewer: { login: 'author-01' },
              repository: {
                pullRequests: {
                  nodes: slice.map((pr) => {
                    const node = prToIndexGraphQlNode(pr)
                    if (!queryText.includes('author { login }')) {
                      const { author: _author, reviewRequests: _requests, ...conservative } = node
                      return conservative
                    }
                    return node
                  }),
                  pageInfo: {
                    hasNextPage,
                    endCursor,
                  },
                },
              },
            },
          })
          return
        }

        // 3. getGitHubData query (first: 100, $endCursor)
        if (operation === 'snapshot') {
          const allPrs = graphRows(activeSize)
          const PAGE_SIZE = 100
          let start = 0
          const endCursorVal = varsObj.endCursor
          if (typeof endCursorVal === 'string' && endCursorVal) {
            const match = /^cursor-(\d+)$/.exec(endCursorVal)
            if (match) start = parseInt(match[1], 10)
          }
          const end = Math.min(start + PAGE_SIZE, activeSize)
          const slice = allPrs.slice(start, end)
          const hasNextPage = end < activeSize
          const endCursor = hasNextPage ? `cursor-${end}` : null

          send(res, 200, {
            data: {
              repository: {
                pullRequests: {
                  nodes: slice.map(prToFullGraphQlNode),
                  pageInfo: {
                    hasNextPage,
                    endCursor,
                  },
                },
              },
            },
          })
          return
        }

        // 4. Issues query (getGitHubIssues)
        if (operation === 'issues') {
          send(res, 200, {
            data: {
              repository: {
                issues: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          })
          return
        }

        if (identityRead) {
          send(res, 200, { data: { viewer: { login: 'author-01' } } })
          return
        }
        send(res, 400, { errors: [{ message: 'Unrecognized benchmark query' }] })
        return
      }

      // Default fallback
      send(res, 404, { message: 'Not Found' })
    })
  })

  const {
    promise: listenPromise,
    resolve: resolveListen,
    reject: rejectListen,
  } = Promise.withResolvers<void>()
  server.once('error', rejectListen)
  server.listen(0, '127.0.0.1', () => resolveListen())
  await listenPromise

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    base: `http://127.0.0.1:${port}`,
    setSize(size: GraphSize) {
      activeSize = size
    },
    getSize() {
      return activeSize
    },
    getRequests() {
      return recordedRequests
    },
    getDetailRequests() {
      return [...detailRequests]
    },
    clearDetailRequests() {
      detailRequests.length = 0
    },
    getIndexPageRequests() {
      return indexPageRequests
    },
    resetIndexPageRequests() {
      indexPageRequests = 0
    },
    close: () => {
      const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>()
      server.close(() => resolveClose())
      return closePromise
    },
  }
}

function writeControlledGh(workspace: string, apiBase: string) {
  const binDir = join(workspace, 'bin')
  mkdirSync(binDir, { recursive: true })
  const tokenFile = join(workspace, 'gh-token')
  const hostsFile = join(workspace, 'gh-hosts.json')
  const bodyFile = join(workspace, 'gh-body')
  writeFileSync(tokenFile, 'benchmark-token\n')

  const apiHost = new URL(apiBase).host
  const hostsConfig = {
    hosts: {
      'github.com': [
        {
          state: 'success',
          active: true,
          host: 'github.com',
          login: 'author-01',
        },
      ],
      [apiHost]: [
        {
          state: 'success',
          active: true,
          host: apiHost,
          login: 'author-01',
        },
      ],
    },
  }
  writeFileSync(hostsFile, JSON.stringify(hostsConfig))

  const ghScript = `#!/bin/sh
named_host() {
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--hostname" ]; then printf "%s" "$argument"; return 0; fi
    previous="$argument"
  done
  return 1
}

case "$1" in
  --version)
    printf 'gh version 2.62.0\\n'
    exit 0
    ;;
  auth)
    case "$2" in
      status)
        cat ${JSON.stringify(hostsFile)}
        exit 0
        ;;
      token)
        cat ${JSON.stringify(tokenFile)}
        exit 0
        ;;
      *)
        printf 'gh: unsupported auth subcommand\\n' >&2
        exit 1
        ;;
    esac
    ;;
  api)
    endpoint=""
    method="GET"
    wants_input="no"
    awaiting=""
    for arg in "$@"; do
      if [ -n "$awaiting" ]; then
        if [ "$awaiting" = "--method" ]; then method="$arg"; fi
        awaiting=""
        continue
      fi
      case "$arg" in
        --method|--hostname|--header) awaiting="$arg"; continue ;;
        --include) continue ;;
        --input) wants_input="yes"; awaiting="--input"; continue ;;
        -*) continue ;;
        *) endpoint="$arg" ;;
      esac
    done
    if [ -z "$endpoint" ]; then printf 'gh: no endpoint\\n' >&2; exit 1; fi
    case "$endpoint" in
      http://*|https://*) full_url="$endpoint" ;;
      *) full_url="${apiBase}/$endpoint" ;;
    esac
    body_file=""
    if [ "$wants_input" = "yes" ]; then
      body_file="$(mktemp)"
      cat > "$body_file"
    fi
    if [ -n "$body_file" ]; then
      curl --disable --noproxy '*' --silent --show-error --include --request "$method" \\
        --header "Authorization: Bearer benchmark-token" \\
        --header "Accept: application/vnd.github+json" \\
        --header "Content-Type: application/json" \\
        --data-binary "@$body_file" "$full_url"
    else
      curl --disable --noproxy '*' --silent --show-error --include --request "$method" \\
        --header "Authorization: Bearer benchmark-token" \\
        --header "Accept: application/vnd.github+json" \\
        --header "Content-Type: application/json" \\
        "$full_url"
    fi
    status=$?
    if [ -n "$body_file" ]; then rm -f "$body_file"; fi
    exit $status
    ;;
  *)
    printf 'gh: unsupported command\\n' >&2
    exit 1
    ;;
esac
`
  const ghPath = join(binDir, 'gh')
  writeFileSync(ghPath, ghScript, { mode: 0o755 })
  return { binDir, ghPath }
}

function setupGraphRepo(workspace: string): string {
  const repo = join(workspace, 'graph-repo')
  mkdirSync(repo, { recursive: true })
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Git Stacks benchmark'])
  git(['config', 'user.email', 'benchmark@example.invalid'])
  writeFileSync(join(repo, 'README.md'), '# Graph Benchmark\n')
  git(['add', 'README.md'])
  git(['commit', '-m', 'Initial commit'])
  git(['remote', 'add', 'origin', `https://github.com/${GRAPH_REPOSITORY}.git`])
  git(['branch', 'graph/change-1'])
  git(['checkout', 'graph/change-1'])
  for (let i = 2; i <= 24; i++) {
    git(['branch', `graph/change-${i}`])
  }
  git(['branch', 'graph/local-only'])
  git(['update-ref', 'refs/remotes/origin/graph/remote-only', 'HEAD'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return repo
}

async function collectGarbage(client: CdpClient): Promise<void> {
  await client.send('HeapProfiler.collectGarbage')
  await client.send('HeapProfiler.collectGarbage')
}

async function getPostGcHeap(client: CdpClient): Promise<number> {
  await collectGarbage(client)
  const rawMetrics = (await client.send('Performance.getMetrics')) as PerformanceMetricsResponse
  const heap = rawMetrics.metrics?.find((m) => m.name === 'JSHeapUsedSize')?.value
  if (typeof heap !== 'number' || !Number.isFinite(heap) || heap <= 0) {
    throw new Error('Post-GC JSHeapUsedSize is unavailable or invalid')
  }
  return heap
}

async function settleRepositorySize(client: CdpClient, size: GraphSize): Promise<number> {
  const refresh = 'button[aria-label="Refresh repository"]'
  await until(
    client,
    `!!document.querySelector(${JSON.stringify(refresh)}) &&
    !document.querySelector(${JSON.stringify(refresh)}).disabled`,
  )
  await evaluate(client, 'globalThis.__graphObservedSnapshot = null')
  await click(client, refresh)
  await until(
    client,
    `globalThis.__graphObservedSnapshot?.scopeValid &&
    globalThis.__graphObservedSnapshot.complete &&
    !!globalThis.__graphObservedSnapshot.fetchedAt &&
    globalThis.__graphObservedSnapshot.records === ${size} &&
    globalThis.__graphObservedIndex?.scopeValid &&
    globalThis.__graphObservedIndex.complete &&
    globalThis.__graphObservedIndex.records === ${size}`,
  )
  await until(
    client,
    "document.querySelector('.graph-workbench')?.textContent.includes('Selected PR detail loaded')",
  )
  await evaluate(
    client,
    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
    true,
  )
  return Number(await evaluate(client, 'globalThis.__graphObservedSnapshot.records'))
}

function cleanChildEnvironment(
  binDir: string,
  workspace: string,
  apiBase: string,
  repo: string,
  userData: string,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Strip ambient credentials
    if (
      key === 'GH_TOKEN' ||
      key === 'GITHUB_TOKEN' ||
      key === 'GH_ENTERPRISE_TOKEN' ||
      key === 'GITHUB_ENTERPRISE_TOKEN' ||
      key.startsWith('GIT_STACKS_GITHUB_TOKEN')
    ) {
      continue
    }
    clean[key] = value
  }

  return {
    ...clean,
    ELECTRON_RENDERER_URL: '',
    GIT_STACKS_REPO: repo,
    GIT_STACKS_USER_DATA: userData,
    GIT_STACKS_GITHUB_API_URL: apiBase,
    GIT_STACKS_OWNED_GH_DIR: binDir,
    PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    GH_CONFIG_DIR: join(workspace, '.config', 'gh'),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(workspace, '.gitconfig'),
  }
}

async function measureWarmGraph(
  client: CdpClient,
  apiServer: GraphApiDouble,
  size: GraphSize,
): Promise<GraphWarmSamples> {
  // Only scalar computation and input-to-paint samples are retained.
  await until(
    client,
    `document.querySelector('.graph-index-status')?.textContent.includes('complete · ${size} indexed PRs')`,
  )
  const searchSelector = '.graph-filters input[type="search"]'
  await click(client, searchSelector)
  const warmSamples: number[] = []
  const warmProjectionSamples: number[] = []
  const warmRequestStart = apiServer.getRequests().length

  for (let i = 0; i < GRAPH_WARM_SAMPLE_COUNT; i++) {
    const query = i % 2 === 0 ? '#41 Change 41' : '#40 Change 40'
    const matchingNumbers = [i % 2 === 0 ? 41 : 40]
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: process.platform === 'darwin' ? 4 : 2,
      windowsVirtualKeyCode: 65,
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
    })
    await evaluate(
      client,
      `(() => {
        globalThis.__graphComputations = [];
        const { promise, resolve, reject } = Promise.withResolvers();
        globalThis.__perfGraphInput = promise;
        const control = document.querySelector(${JSON.stringify(searchSelector)});
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Requested graph outline did not paint')); }, 5000);
        let started;
        const observer = new MutationObserver(() => {
          if (started === undefined || control.value !== ${JSON.stringify(query)}) return;
          if (document.querySelector('.graph-outline header h2 span')?.textContent.trim() !== ${JSON.stringify(String(matchingNumbers.length))}) return;
          const rows = [...document.querySelectorAll('[data-graph-outline-row]')]
            .filter(row => row.querySelector('small')?.textContent.startsWith('Match'));
          const expected = ${JSON.stringify(matchingNumbers)};
          if (!rows.length || !rows.every(row => {
            const numbers = [...row.querySelector('strong').textContent.matchAll(/#(\\d+)/g)].map(match => Number(match[1]));
            return numbers.length > 0 && numbers.every(number => expected.includes(number));
          })) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            // Identical zero-valued attributes need not emit a mutation. Capture
            // the rendered criterion result too; sub-clock-resolution work is
            // a measured zero, not a missing sample.
            const metric = document.querySelector('.graph-workbench').getAttribute('data-graph-projection-layout-ms');
            if (metric === null || metric === '') {
              clearTimeout(timeout); reject(new Error('Graph computation metric missing')); return;
            }
            const value = Number(metric);
            if (!Number.isFinite(value) || value < 0) {
              clearTimeout(timeout); reject(new Error('Graph computation metric invalid')); return;
            }
            globalThis.__graphComputations.push(value);
            clearTimeout(timeout); resolve(performance.now() - started);
          }));
        });
        control.addEventListener('input', () => {
          started = performance.now();
          observer.observe(document.querySelector('.graph-workbench'), { subtree: true, childList: true, characterData: true, attributes: true });
        }, { capture: true, once: true });
      })(); true`,
    )
    await client.send('Input.insertText', { text: query })
    const duration = await evaluate(client, 'globalThis.__perfGraphInput', true)
    if (typeof duration !== 'number' || !Number.isFinite(duration)) {
      throw new Error('Graph input-to-filtered-paint duration unavailable')
    }
    warmSamples.push(duration)
    const projection = Number(await evaluate(client, 'Math.max(...globalThis.__graphComputations)'))
    if (!Number.isFinite(projection) || projection < 0)
      throw new Error('Warm invalidating graph computation was not captured')
    warmProjectionSamples.push(projection)
  }
  if (apiServer.getRequests().length !== warmRequestStart)
    throw new Error('Local search unexpectedly fetched provider data')

  const sortedWarm = [...warmSamples].sort((a, b) => a - b)
  const p95Index = Math.min(sortedWarm.length - 1, Math.ceil(0.95 * sortedWarm.length) - 1)
  const warmInputPaintMs = sortedWarm[p95Index] ?? 0
  const sortedProjection = [...warmProjectionSamples].sort((a, b) => a - b)
  const warmProjectionLayoutMs = sortedProjection[p95Index] ?? 0
  return { warmInputPaintMs, warmSamples, warmProjectionLayoutMs, warmProjectionSamples }
}

export async function measureGraphDesktop(repoRoot: string): Promise<GraphBenchmarkResult> {
  let workspace: string | undefined
  let apiServer: GraphApiDouble | undefined
  let child: ChildProcess | undefined
  let client: CdpClient | null = null
  let errors = ''
  try {
    const executable: unknown = electron
    if (typeof executable !== 'string') throw new Error('Electron executable path unavailable')
    workspace = mkdtempSync(join(tmpdir(), 'git-stacks-graph-bench-'))
    const userData = join(workspace, 'user-data')
    mkdirSync(userData, { recursive: true })
    const repo = setupGraphRepo(workspace)
    apiServer = await startGraphApiDouble()
    const { binDir } = writeControlledGh(workspace, apiServer.base)
    const port = await freePort()
    child = spawn(
      executable,
      [
        '--disable-gpu',
        '--js-flags=--expose-gc',
        `--remote-debugging-port=${port}`,
        join(repoRoot, 'out/main/index.js'),
      ],
      {
        cwd: repoRoot,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
        env: cleanChildEnvironment(binDir, workspace, apiServer.base, repo, userData),
      },
    )

    const launched = child
    const {
      promise: spawnReady,
      resolve: resolveSpawn,
      reject: rejectSpawn,
    } = Promise.withResolvers<void>()
    launched.once('spawn', resolveSpawn)
    launched.on('error', rejectSpawn)
    await spawnReady
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text) => {
      errors = (errors + text).slice(-8192)
    })
    const pageUrl = await pageTarget(port, child, () => errors, 'app://git-stacks')
    client = await connect(pageUrl)
    await client.send('Page.bringToFront')
    await client.send('Performance.enable')
    await client.send('HeapProfiler.enable')

    // 1. Enter repository via onboarding recent button
    await until(client, "!!document.querySelector('button.onboarding-recent')")
    await evaluate(client, "document.querySelector('button.onboarding-recent').focus()")
    for (const type of ['keyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        text: type === 'keyDown' ? '\r' : undefined,
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
    }
    await until(client, "!!document.querySelector('.branches-view')")

    // 2. Switch to Stacks view
    await until(
      client,
      "!![...document.querySelectorAll('.nav-item')].find(b => b.textContent?.includes('Stacks'))",
    )
    await evaluate(
      client,
      `(() => {
      globalThis.__graphComputations = [];
      globalThis.__graphRefreshAdmissions = 0;
      window.desktop.onPrIndex(({ complete, fetchedAt, pages, pullRequests, state, message, repository, host, fullName, viewer }) => {
        const scopeValid = repository === ${JSON.stringify(repo)} && host === 'github.com' && fullName === ${JSON.stringify(GRAPH_REPOSITORY)} && viewer === 'author-01';
        globalThis.__graphObservedIndex = { complete, fetchedAt, pages, records: pullRequests.length, scopeValid };
        if (scopeValid && state === 'stale' && message === 'PR indexing was cancelled')
          globalThis.__graphRefreshAdmissions++;
      });
      window.desktop.onBackgroundSnapshot(({ path, remoteUrl, pullRequests, github, githubStale, githubFailure, remote }) => {
        globalThis.__graphObservedSnapshot = {
          records: pullRequests.length,
          scopeValid: path === ${JSON.stringify(repo)} && remoteUrl === ${JSON.stringify(`https://github.com/${GRAPH_REPOSITORY}.git`)},
          complete: github.available && !githubStale && !githubFailure && remote?.state === 'fresh',
          fetchedAt: remote?.fetchedAt ?? null,
        };
      });
      new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes') {
            for (const value of [record.oldValue, record.target.getAttribute('data-graph-projection-layout-ms')]) {
              if (value !== null) globalThis.__graphComputations.push(Number(value));
            }
          }
          for (const node of record.addedNodes) {
            if (node instanceof Element && node.matches('.graph-workbench'))
              globalThis.__graphComputations.push(Number(node.getAttribute('data-graph-projection-layout-ms')));
          }
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['data-graph-projection-layout-ms'], attributeOldValue: true });
    })()`,
    )
    await evaluate(
      client,
      `(() => {
      const item = [...document.querySelectorAll('.nav-item')].find(b => b.textContent?.includes('Stacks'));
      if (item) item.click();
    })()`,
    )
    await until(client, "!!document.querySelector('.graph-workbench')")

    // 3. Fixture 250
    await until(
      client,
      "document.querySelector('.graph-index-status')?.textContent?.includes('complete · 250 indexed PRs')",
    )
    // The repository snapshot may have seeded 100 PRs before Stacks mounts.
    // Measure a full controlled invalidation rather than that cached continuation.
    const initial250 = (await evaluate(client, 'globalThis.__graphObservedIndex')) as {
      fetchedAt: string
    }
    apiServer.resetIndexPageRequests()
    await evaluate(
      client,
      `(() => {
      globalThis.__graphComputations = [];
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Refresh index'));
      if (!button || button.disabled) throw new Error('Initial index refresh unavailable');
      button.click();
    })()`,
    )
    await until(
      client,
      `globalThis.__graphObservedIndex?.complete &&
      globalThis.__graphObservedIndex.scopeValid && globalThis.__graphObservedIndex.records === 250 &&
      globalThis.__graphObservedIndex.fetchedAt !== ${JSON.stringify(initial250.fetchedAt)}`,
    )
    await evaluate(
      client,
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      true,
    )
    const snapshot250Records = await settleRepositorySize(client, 250)
    const projectionLayout250Ms = Number(
      await evaluate(client, 'Math.max(...globalThis.__graphComputations)'),
    )
    await until(
      client,
      "document.querySelector('.graph-workbench')?.textContent.includes('Selected PR detail loaded')",
    )
    const warm250 = await measureWarmGraph(client, apiServer, 250)
    const heap250Bytes = await getPostGcHeap(client)
    const indexPages250 = apiServer.getIndexPageRequests()

    // 4. Fixture 1000
    apiServer.resetIndexPageRequests()
    apiServer.setSize(1000)
    await evaluate(client, 'globalThis.__graphComputations = []')
    await until(
      client,
      "!![...document.querySelectorAll('button')].find(b => b.textContent?.includes('Refresh index') && !b.disabled)",
    )
    await evaluate(
      client,
      `(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Refresh index'));
      if (btn) btn.click();
    })()`,
    )
    await until(
      client,
      "document.querySelector('.graph-index-status')?.textContent?.includes('complete · 1000 indexed PRs')",
    )
    await evaluate(
      client,
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      true,
    )
    const snapshot1000Records = await settleRepositorySize(client, 1000)
    const projectionLayout1000Ms = Number(
      await evaluate(client, 'Math.max(...globalThis.__graphComputations)'),
    )
    await until(
      client,
      "document.querySelector('.graph-workbench')?.textContent.includes('Selected PR detail loaded')",
    )
    const warm1000 = await measureWarmGraph(client, apiServer, 1000)
    const heap1000Bytes = await getPostGcHeap(client)
    const indexPages1000 = apiServer.getIndexPageRequests()

    // 5. Fixture 5000
    apiServer.resetIndexPageRequests()
    apiServer.setSize(5000)
    await evaluate(client, 'globalThis.__graphComputations = []')
    await until(
      client,
      "!![...document.querySelectorAll('button')].find(b => b.textContent?.includes('Refresh index') && !b.disabled)",
    )
    await evaluate(
      client,
      `(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Refresh index'));
      if (btn) btn.click();
    })()`,
    )
    await until(
      client,
      "document.querySelector('.graph-index-status')?.textContent?.includes('complete · 5000 indexed PRs')",
    )
    await evaluate(
      client,
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      true,
    )
    const snapshot5000Records = await settleRepositorySize(client, 5000)
    const projectionLayout5000Ms = Number(
      await evaluate(client, 'Math.max(...globalThis.__graphComputations)'),
    )
    await until(
      client,
      "document.querySelector('.graph-workbench')?.textContent.includes('Selected PR detail loaded')",
    )
    const warm5000 = await measureWarmGraph(client, apiServer, 5000)
    const { warmInputPaintMs, warmSamples, warmProjectionLayoutMs, warmProjectionSamples } =
      warm5000
    const heap5000Bytes = await getPostGcHeap(client)
    const heapScaleGrowthBytes = Math.max(0, heap5000Bytes - heap250Bytes)
    const indexPages5000 = apiServer.getIndexPageRequests()
    for (const value of [projectionLayout250Ms, projectionLayout1000Ms, projectionLayout5000Ms]) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error('Invalidating graph computation was not captured')
    }
    if (indexPages250 !== 5 || indexPages1000 !== 20 || indexPages5000 !== 100) {
      throw new Error(
        `Unexpected progressive page counts: ${indexPages250}/${indexPages1000}/${indexPages5000}`,
      )
    }
    const explorationStart = apiServer.getRequests().length

    // 6. Element bounds on 5000
    await click(client, '.graph-filters input[type="search"]')
    await until(
      client,
      "[...document.querySelectorAll('[data-graph-outline-row]')].some(r => r.textContent.includes('Change 40'))",
    )
    await evaluate(
      client,
      `(() => {
      const row = [...document.querySelectorAll('[data-graph-outline-row]')].find(r =>
        [...r.querySelectorAll('strong')].some(s => /^#40\\b/.test(s.textContent)));
      if (!row) throw new Error('Fixed fork PR40 not mounted');
      row.querySelector('button').click();
      document.querySelector('.graph-paths').open = true;
    })()`,
    )
    await until(client, "document.querySelectorAll('.graph-paths li').length === 20")
    const assertMountedBounds = () =>
      evaluate(
        client!,
        `(() => {
      const counts = [document.querySelectorAll('[data-graph-outline-row]').length,
        document.querySelectorAll('[data-graph-node]').length, document.querySelectorAll('.graph-paths li').length];
      const limits = [${GRAPH_OUTLINE_ROW_LIMIT}, ${GRAPH_DETAIL_NODE_LIMIT}, ${GRAPH_PATH_PAGE_SIZE}];
      if (counts.some((count, index) => count <= 0 || count > limits[index]))
        throw new Error('Mounted fork exploration exceeds bounded nonempty context: ' + counts);
    })()`,
      )
    await assertMountedBounds()
    const endpoints = await evaluate(
      client,
      "Number(document.querySelector('.graph-paths summary').textContent.match(/(\\d+) available endpoints/)[1])",
    )
    if (typeof endpoints !== 'number' || endpoints < 80)
      throw new Error('PR40 fork did not retain its 80-wide dependent endpoint set')
    await evaluate(
      client,
      `(() => {
      const next = [...document.querySelectorAll('.graph-path-paging button')].find(b => b.textContent.includes('Next paths'));
      if (!next || next.disabled) throw new Error('Nonempty fork path pagination unavailable');
      next.click();
    })()`,
    )
    await until(
      client,
      "document.querySelector('.graph-path-paging span')?.textContent.trim().startsWith('21')",
    )
    await assertMountedBounds()
    await click(client, '.graph-paths li button')
    await evaluate(
      client,
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      true,
    )
    await until(
      client,
      "document.querySelector('.graph-workbench')?.textContent.includes('Selected PR detail loaded')",
    )
    await assertMountedBounds()
    const rawBounds = (await evaluate(
      client,
      `(() => {
        const outlineRows = document.querySelectorAll('[data-graph-outline-row]').length;
        const detailNodes = document.querySelectorAll('[data-graph-node]').length;
        const pathsDetails = document.querySelector('.graph-paths');
        if (pathsDetails && !pathsDetails.open) {
          pathsDetails.open = true;
        }
        const pathItems = document.querySelectorAll('.graph-paths li').length;
        return { outlineRows, detailNodes, pathItems };
      })()`,
    )) as { outlineRows: number; detailNodes: number; pathItems: number } | undefined

    const bounds5000 = {
      outlineRows: rawBounds?.outlineRows ?? 0,
      detailNodes: rawBounds?.detailNodes ?? 0,
      pathItems: rawBounds?.pathItems ?? 0,
    }
    if (
      !bounds5000.outlineRows ||
      !bounds5000.detailNodes ||
      bounds5000.pathItems !== GRAPH_PATH_PAGE_SIZE
    ) {
      throw new Error(
        'Fork selection must mount a nonempty bounded outline, graph, and full path page',
      )
    }

    if (bounds5000.outlineRows > GRAPH_OUTLINE_ROW_LIMIT) {
      throw new Error(
        `Mounted outline rows ${bounds5000.outlineRows} exceeds limit ${GRAPH_OUTLINE_ROW_LIMIT}`,
      )
    }
    if (bounds5000.detailNodes > GRAPH_DETAIL_NODE_LIMIT) {
      throw new Error(
        `Mounted detail nodes ${bounds5000.detailNodes} exceeds limit ${GRAPH_DETAIL_NODE_LIMIT}`,
      )
    }
    if (bounds5000.pathItems > GRAPH_PATH_PAGE_SIZE) {
      throw new Error(
        `Path page size ${bounds5000.pathItems} exceeds limit ${GRAPH_PATH_PAGE_SIZE}`,
      )
    }

    // 8. Selected detail cache bound (GRAPH_SELECTED_CACHE_LIMIT = 4)
    apiServer.clearDetailRequests()
    for (let n = 1; n <= 5; n++) {
      await evaluate(client, `window.desktop.prIndexDetail(${n})`, true)
    }
    let retained = 0
    for (let n = 2; n <= 5; n++) {
      const before = apiServer.getDetailRequests().length
      await evaluate(client, `window.desktop.prIndexDetail(${n})`, true)
      if (apiServer.getDetailRequests().length === before) retained++
    }
    const beforeEvictedRead = apiServer.getDetailRequests().length
    await evaluate(client, 'window.desktop.prIndexDetail(1)', true)
    const evictionHit = apiServer.getDetailRequests().length === beforeEvictedRead + 1
    const selectedCacheBound = {
      retained,
      evictionsObserved: retained === GRAPH_SELECTED_CACHE_LIMIT && evictionHit,
    }
    const explorationEnd = apiServer.getRequests().length

    // 9. Repeated navigation / refresh cycles (30 cycles)
    await until(
      client,
      `globalThis.__graphObservedSnapshot?.scopeValid &&
      globalThis.__graphObservedSnapshot.complete && globalThis.__graphObservedSnapshot.records === 5000 &&
      globalThis.__graphObservedIndex?.scopeValid && globalThis.__graphObservedIndex.complete &&
      globalThis.__graphObservedIndex.records === 5000`,
    )
    const navBaselineBytes = await getPostGcHeap(client)
    const navigationCycleIndexPages: number[] = []
    let snapshotCompletedRefreshes = 0
    let supersededProgressiveSequences = 0
    for (let c = 0; c < GRAPH_NAVIGATION_CYCLE_COUNT; c++) {
      // Navigate to Branches
      await evaluate(
        client,
        `(() => {
          const btn = [...document.querySelectorAll('.nav-item')].find(b => b.textContent?.includes('Branches'));
          if (btn) btn.click();
        })()`,
      )
      await until(client, "!!document.querySelector('.branches-view')")

      // Navigate back to Stacks
      await evaluate(
        client,
        `(() => {
          const btn = [...document.querySelectorAll('.nav-item')].find(b => b.textContent?.includes('Stacks'));
          if (btn) btn.click();
        })()`,
      )
      await until(client, "!!document.querySelector('.graph-workbench')")
      await until(
        client,
        "document.querySelector('.graph-index-status')?.textContent?.includes('complete · 5000 indexed PRs')",
      )
      await until(
        client,
        "document.querySelector('.graph-workbench')?.textContent.includes('Selected PR detail loaded')",
      )
      const selectedNumber = Number(
        await evaluate(
          client,
          "document.querySelector('.graph-inspector-content h3')?.textContent.match(/^#(\\d+)/)?.[1]",
        ),
      )
      if (!Number.isInteger(selectedNumber) || selectedNumber <= 0)
        throw new Error('Selected graph PR identity unavailable')
      const detailReadsBeforeRefresh = apiServer
        .getDetailRequests()
        .filter((number) => number === selectedNumber).length
      const previous = (await evaluate(client, 'globalThis.__graphObservedIndex')) as {
        fetchedAt: string
      }
      const pagesBeforeRefresh = apiServer.getIndexPageRequests()
      const admissionsBeforeRefresh = Number(
        await evaluate(client, 'globalThis.__graphRefreshAdmissions'),
      )
      await evaluate(
        client,
        `(() => {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Refresh index'));
        if (!button || button.disabled) throw new Error('Refresh index unavailable');
        button.click();
      })()`,
      )
      await until(
        client,
        `globalThis.__graphObservedIndex?.complete &&
        globalThis.__graphObservedIndex.scopeValid &&
        globalThis.__graphRefreshAdmissions > ${admissionsBeforeRefresh} &&
        globalThis.__graphObservedIndex.records === 5000 &&
        globalThis.__graphObservedIndex.fetchedAt !== ${JSON.stringify(previous.fetchedAt)} &&
        document.querySelector('.graph-index-status')?.textContent.includes('complete · 5000 indexed PRs')`,
      )
      const detailDeadline = performance.now() + 9000
      while (
        apiServer.getDetailRequests().filter((number) => number === selectedNumber).length ===
          detailReadsBeforeRefresh &&
        performance.now() < detailDeadline
      ) {
        await delay(25)
      }
      if (
        apiServer.getDetailRequests().filter((number) => number === selectedNumber).length ===
        detailReadsBeforeRefresh
      ) {
        throw new Error('Index refresh did not read the selected detail under its new revision')
      }
      await until(
        client,
        "document.querySelector('.graph-workbench')?.textContent.includes('Selected PR detail loaded')",
      )
      await evaluate(
        client,
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
        true,
      )
      const cyclePages = apiServer.getIndexPageRequests() - pagesBeforeRefresh
      if (cyclePages < 0 || cyclePages > indexPages5000) {
        throw new Error(
          `Refresh cycle ${c + 1} performed ${cyclePages} index pages; maximum ${indexPages5000}`,
        )
      }
      navigationCycleIndexPages.push(cyclePages)
      // Main may adopt a coordinator-confirmed full snapshot and supersede an older page sequence.
      const snapshotCompleted = await evaluate(
        client,
        'globalThis.__graphObservedIndex.pages === 0',
      )
      if (snapshotCompleted) snapshotCompletedRefreshes++
      if (cyclePages < indexPages5000) {
        if (!snapshotCompleted)
          throw new Error('Partial progressive sequence lacks a complete coordinator snapshot')
        supersededProgressiveSequences++
      }
    }
    await until(
      client,
      `globalThis.__graphObservedSnapshot?.scopeValid &&
      globalThis.__graphObservedSnapshot.complete && globalThis.__graphObservedSnapshot.records === 5000 &&
      globalThis.__graphObservedIndex?.scopeValid && globalThis.__graphObservedIndex.complete &&
      globalThis.__graphObservedIndex.records === 5000`,
    )
    const navPostCycleBytes = await getPostGcHeap(client)
    const heapNavGrowthBytes = Math.max(0, navPostCycleBytes - navBaselineBytes)
    const requests = apiServer.getRequests()
    const classify = (start: number, end: number, operations: string[]) => {
      const phase = requests.slice(start, end)
      for (const request of phase) {
        const variables = request.variables as Record<string, unknown> | undefined
        const identity =
          request.method === 'POST' &&
          request.path.endsWith('/graphql') &&
          request.query?.trim() === 'query UserCurrent { viewer { login } }' &&
          (!variables || Object.keys(variables).length === 0)
        if (identity && operations.includes('identity')) continue
        const repositoryRead =
          request.method === 'GET' &&
          ['/repos/fixture/graph-workbench', '/repos/fixture/graph-workbench/stacks'].includes(
            request.path,
          )
        if (repositoryRead && operations.includes('background')) continue
        const known = request.query ? benchmarkReads[canonicalQuery(request.query)] : undefined
        const scoped =
          request.method === 'POST' &&
          request.path === '/graphql' &&
          known !== undefined &&
          variables?.owner === 'fixture' &&
          variables?.name === 'graph-workbench'
        const operation = known === 'snapshot' || known === 'issues' ? 'background' : known
        if (!scoped || !operation || !operations.includes(operation)) {
          throw new Error(
            `Unrelated provider request in measured phase: ${JSON.stringify(request)}`,
          )
        }
      }
      return phase.length
    }
    const localExploration = classify(explorationStart, explorationEnd, [
      'detail',
      'identity',
      'background',
    ])
    const navigationRefresh = classify(explorationEnd, requests.length, [
      'index',
      'detail',
      'identity',
      'background',
    ])

    return {
      projectionLayout250Ms,
      projectionLayout1000Ms,
      projectionLayout5000Ms,
      heap250Bytes,
      heap1000Bytes,
      heap5000Bytes,
      snapshotRecords: {
        250: snapshot250Records,
        1000: snapshot1000Records,
        5000: snapshot5000Records,
      },
      heapScaleGrowthBytes,
      warmInputPaintMs,
      warmInputPaintSamples: warmSamples,
      warmProjectionLayoutMs,
      warmProjectionLayoutSamples: warmProjectionSamples,
      warmSamplesBySize: { 250: warm250, 1000: warm1000, 5000: warm5000 },
      bounds5000,
      selectedCacheBound,
      scopedRequests: {
        total: apiServer.getRequests().length,
        indexPages250,
        indexPages1000,
        indexPages5000,
        localExploration,
        navigationRefresh,
        navigationIndexPages: navigationCycleIndexPages.reduce((sum, pages) => sum + pages, 0),
        identityProof: requests
          .slice(explorationStart)
          .filter((r) => r.query?.trim() === 'query UserCurrent { viewer { login } }').length,
        repositoryMetadata: requests
          .slice(explorationStart)
          .filter((r) => r.method === 'GET' && r.path === '/repos/fixture/graph-workbench').length,
        nativeStacks: requests
          .slice(explorationStart)
          .filter((r) => r.method === 'GET' && r.path === '/repos/fixture/graph-workbench/stacks')
          .length,
        snapshotPages: requests
          .slice(explorationStart)
          .filter((r) => r.query?.includes('pullRequests(first: 100')).length,
        issuePages: requests.slice(explorationStart).filter((r) => r.query?.includes('issues('))
          .length,
        unrelated: 0,
      },
      navBaselineBytes,
      navigationCycleIndexPages,
      snapshotCompletedRefreshes,
      supersededProgressiveSequences,
      navPostCycleBytes,
      heapNavGrowthBytes,
    }
  } catch (error) {
    const status = client
      ? await evaluate(client, "document.querySelector('.graph-index-status')?.textContent").catch(
          () => null,
        )
      : null
    throw new Error(
      `${String(error)}; graph status: ${status}; requests: ${JSON.stringify(apiServer?.getRequests())}; Electron: ${errors}`,
    )
  } finally {
    client?.close()
    if (child && child.exitCode === null && child.pid) {
      try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
      } catch {
        // already exited
      }
      const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<void>()
      child.once('exit', () => resolveExit())
      await Promise.race([exitPromise, delay(2000)])
      if (child.exitCode === null) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch {
          // already exited
        }
      }
    }
    await apiServer?.close().catch(() => {})
    if (workspace) rmSync(workspace, { recursive: true, force: true })
  }
}
