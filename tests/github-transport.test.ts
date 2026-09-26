import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import {
  DirectGitHubTransport,
  GhGitHubTransport,
  GITHUB_API_VERSION,
  GitHubTransportError,
  githubApiVersion,
  githubTransport,
  type GitHubErrorKind,
} from '../src/main/github-transport'
import type { DesktopAPI } from '../src/shared/types'

// The renderer bridge is the whole renderer capability surface; it must never gain one.
type AssertNever<T extends never> = T
type _NoTokenOrHttpCapability = AssertNever<
  Extract<keyof DesktopAPI, `${string}token${string}` | `${string}auth${string}`>
>

interface Captured {
  url: string
  init: RequestInit | undefined
}

function recordingFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
): { fetch: typeof globalThis.fetch; captured: Captured[] } {
  const captured: Captured[] = []
  let index = 0
  const fetchDouble = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4321',
        'x-ratelimit-reset': '1800000000',
        'x-ratelimit-resource': 'core',
        ...next.headers,
      },
    })
  }) as typeof globalThis.fetch
  return { fetch: fetchDouble, captured }
}

async function withoutGhOnPath(
  run: () => Promise<void>,
): Promise<{ ghRan: () => Promise<boolean> }> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-no-gh-'))
  const bin = join(root, 'bin')
  const marker = join(root, 'gh-ran')
  await mkdir(bin)
  await writeFile(join(bin, 'gh'), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, 'utf8')
  await chmod(join(bin, 'gh'), 0o755)
  const original = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${original ?? ''}`
  try {
    await run()
    let ran = false
    try {
      await stat(marker)
      ran = true
    } catch {
      ran = false
    }
    return { ghRan: async () => ran }
  } finally {
    process.env.PATH = original
    await rm(root, { recursive: true, force: true })
  }
}

test('direct transport performs authenticated REST and GraphQL calls without gh', async () => {
  const { fetch: fetchDouble, captured } = recordingFetch([
    { body: { number: 7, state: 'open' } },
    { body: { data: { repository: { pullRequest: { number: 7 } } } } },
  ])
  const transport = new DirectGitHubTransport({ token: 'secret-token', fetch: fetchDouble })
  await withoutGhOnPath(async () => {
    const rest = await transport.rest<{ number: number }>({ path: 'repos/acme/widgets/pulls/7' })
    assert.equal(rest.data.number, 7)
    assert.equal(rest.status, 200)
    assert.equal(rest.rateLimit.remaining, 4321)
    assert.equal(rest.rateLimit.reset?.toISOString(), '2027-01-15T08:00:00.000Z')
    const graphql = await transport.graphql<{ repository: { pullRequest: { number: number } } }>(
      'query($number: Int!) { repository { pullRequest(number: $number) { number } } }',
      { number: 7 },
    )
    assert.equal(graphql.repository.pullRequest.number, 7)
  })
  assert.equal(captured.length, 2)
  const restInit = captured[0].init as RequestInit
  assert.equal(captured[0].url, 'https://api.github.com/repos/acme/widgets/pulls/7')
  const restHeaders = new Headers(restInit.headers)
  assert.equal(restInit.method, 'GET')
  assert.equal(restHeaders.get('authorization'), 'Bearer secret-token')
  assert.equal(restHeaders.get('x-github-api-version'), GITHUB_API_VERSION)
  assert.equal(restHeaders.get('accept'), 'application/vnd.github+json')
  const graphqlInit = captured[1].init as RequestInit
  assert.equal(captured[1].url, 'https://api.github.com/graphql')
  assert.equal(graphqlInit.method, 'POST')
  assert.deepEqual(JSON.parse(String(graphqlInit.body)), {
    query: 'query($number: Int!) { repository { pullRequest(number: $number) { number } } }',
    variables: { number: 7 },
  })
  assert.equal(new Headers(graphqlInit.headers).get('content-type'), 'application/json')
})

test('a missing token fails before any request leaves the process', async () => {
  let called = false
  const transport = new DirectGitHubTransport({
    env: {},
    fetch: (async () => {
      called = true
      return new Response('{}')
    }) as typeof globalThis.fetch,
  })
  await assert.rejects(
    transport.rest({ path: 'user' }),
    (error: unknown) =>
      error instanceof GitHubTransportError &&
      error.kind === 'unauthorized' &&
      error.status === null,
  )
  assert.equal(called, false)
})

test('HTTP failures are typed with their rate-limit metadata', async () => {
  const cases: Array<{
    status: number
    kind: GitHubErrorKind
    headers?: Record<string, string>
  }> = [
    { status: 401, kind: 'unauthorized' },
    { status: 404, kind: 'not-found' },
    { status: 409, kind: 'conflict' },
    { status: 422, kind: 'unprocessable' },
    { status: 403, kind: 'rate-limited', headers: { 'x-ratelimit-remaining': '0' } },
    { status: 403, kind: 'secondary-rate-limit', headers: { 'retry-after': '60' } },
  ]
  for (const expected of cases) {
    const { fetch: fetchDouble } = recordingFetch([
      { status: expected.status, body: { message: 'nope' }, headers: expected.headers },
    ])
    const transport = new DirectGitHubTransport({ token: 'token', fetch: fetchDouble })
    await assert.rejects(
      transport.rest({ path: 'repos/acme/widgets/pulls/1' }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubTransportError)
        assert.equal(error.kind, expected.kind)
        assert.equal(error.status, expected.status)
        assert.equal(error.detail, 'nope')
        return true
      },
    )
  }
  const { fetch: limited } = recordingFetch([
    {
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0' },
    },
  ])
  await assert.rejects(
    new DirectGitHubTransport({ token: 'token', fetch: limited }).rest({ path: 'user' }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubTransportError)
      assert.equal(error.rateLimit.limit, 5000)
      assert.equal(error.rateLimit.remaining, 0)
      assert.equal(error.rateLimit.resource, 'core')
      return true
    },
  )
})

test('network failures, timeouts, and cancellation stay distinct', async () => {
  const network = new DirectGitHubTransport({
    token: 'token',
    fetch: (async () => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch,
  })
  await assert.rejects(
    network.rest({ path: 'user' }),
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'network',
  )

  const silent = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as typeof globalThis.fetch
  await assert.rejects(
    new DirectGitHubTransport({ token: 'token', fetch: silent }).rest({
      path: 'user',
      timeoutMs: 25,
    }),
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'timeout',
  )

  const controller = new AbortController()
  const cancelled = new DirectGitHubTransport({ token: 'token', fetch: silent }).rest({
    path: 'user',
    signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'cancelled',
  )
})

test('REST pagination follows GitHub next links and refuses foreign hosts', async () => {
  const { fetch: fetchDouble, captured } = recordingFetch([
    {
      body: [{ id: 1 }],
      headers: {
        link: `<https://api.github.com/repositories/1/issues/2/comments?page=2>; rel="next", <https://api.github.com/repositories/1/issues/2/comments?page=9>; rel="last"`,
      },
    },
    { body: [{ id: 2 }] },
  ])
  const items = await new DirectGitHubTransport({ token: 'token', fetch: fetchDouble }).paginate<{
    id: number
  }>({ path: 'repos/acme/widgets/issues/2/comments' })
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }])
  assert.equal(captured.length, 2)
  assert.equal(captured[1].url, 'https://api.github.com/repositories/1/issues/2/comments?page=2')

  const foreign = recordingFetch([
    { body: [{ id: 1 }], headers: { link: '<https://evil.example/steal>; rel="next"' } },
  ])
  const only = await new DirectGitHubTransport({
    token: 'token',
    fetch: foreign.fetch,
  }).paginate({ path: 'repos/acme/widgets/issues/2/comments' })
  assert.deepEqual(only, [{ id: 1 }])
  assert.equal(foreign.captured.length, 1)
})

test('GraphQL error payloads become invalid-response failures', async () => {
  const { fetch: fetchDouble } = recordingFetch([
    { body: { data: null, errors: [{ message: 'Field does not exist' }] } },
  ])
  await assert.rejects(
    new DirectGitHubTransport({ token: 'token', fetch: fetchDouble }).graphql('query {}'),
    (error: unknown) =>
      error instanceof GitHubTransportError &&
      error.kind === 'invalid-response' &&
      error.detail === 'Field does not exist',
  )
})

test('the API version is centralized and configurable', async () => {
  assert.equal(githubApiVersion({}), GITHUB_API_VERSION)
  assert.equal(githubApiVersion({ GIT_STACKS_GITHUB_API_VERSION: '2026-01-01' }), '2026-01-01')
  const version = new DirectGitHubTransport({
    token: 'token',
    env: { GIT_STACKS_GITHUB_API_VERSION: '2026-01-01' },
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('x-github-api-version'), '2026-01-01')
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch,
  })
  await version.rest({ path: 'user' })
})

test('gh stays optional and the selected transport follows the environment', () => {
  assert.equal(githubTransport({}).kind, 'gh')
  assert.equal(githubTransport({ GH_TOKEN: 'token' }).kind, 'direct')
  assert.equal(
    githubTransport({ GITHUB_TOKEN: 'token', GIT_STACKS_GITHUB_TRANSPORT: 'gh' }).kind,
    'gh',
  )
  assert.equal(githubTransport({ GIT_STACKS_GITHUB_TRANSPORT: 'direct' }).kind, 'direct')
  assert.equal(
    githubTransport({ GIT_STACKS_GITHUB_TRANSPORT: 'nonsense', GH_TOKEN: 't' }).kind,
    'direct',
  )
})
test('the gh adapter maps CLI failures onto the same typed kinds', async () => {
  const notFound = new GhGitHubTransport({
    run: async () => {
      const error: Error & { stderr?: string; code?: string } = new Error('gh failed')
      error.stderr = 'gh: Not Found (HTTP 404)'
      error.code = '1'
      throw error
    },
  })
  await assert.rejects(
    notFound.rest({ path: 'repos/acme/widgets/pulls/9' }),
    (error: unknown) =>
      error instanceof GitHubTransportError && error.kind === 'not-found' && error.status === 404,
  )

  const missing = new GhGitHubTransport({
    run: async () => {
      const error: Error & { code?: string } = new Error('spawn gh ENOENT')
      error.code = 'ENOENT'
      throw error
    },
  })
  await assert.rejects(
    missing.rest({ path: 'user' }),
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'unsupported',
  )

  const commands: string[][] = []
  const adapter = new GhGitHubTransport({
    run: async (args) => {
      commands.push(args)
      if (args.includes('--method') && args.includes('PATCH'))
        return JSON.stringify({ number: 3, draft: false })
      if (args.includes('--paginate')) return JSON.stringify([[{ id: 1 }], [{ id: 2 }]])
      return JSON.stringify({ data: { repository: { pullRequest: { number: 3 } } } })
    },
  })
  const patched = await adapter.rest<{ draft: boolean }>({
    method: 'PATCH',
    path: 'repos/acme/widgets/pulls/3',
    body: { title: 'Next', draft: false },
  })
  assert.equal(patched.data.draft, false)
  assert.deepEqual(commands[0], [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'PATCH',
    'repos/acme/widgets/pulls/3',
    '-f',
    'title=Next',
    '-F',
    'draft=false',
  ])
  assert.deepEqual(await adapter.paginate({ path: 'repos/acme/widgets/issues/3/comments' }), [
    { id: 1 },
    { id: 2 },
  ])
  const data = await adapter.graphql<{ repository: { pullRequest: { number: number } } }>(
    'query {}',
    {
      owner: 'acme',
    },
  )
  assert.equal(data.repository.pullRequest.number, 3)
  assert.ok(commands[2].includes('owner=acme'))
})
