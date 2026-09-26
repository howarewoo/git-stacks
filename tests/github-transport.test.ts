import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
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
    { status: 429, kind: 'rate-limited', headers: { 'x-ratelimit-remaining': '0' } },
    { status: 429, kind: 'secondary-rate-limit', headers: { 'retry-after': '60' } },
    { status: 429, kind: 'secondary-rate-limit' },
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
test('gh consumes HTTP response metadata and version without parsing stderr', async () => {
  const commands: string[][] = []
  const adapter = new GhGitHubTransport({
    env: { GIT_STACKS_GITHUB_API_VERSION: '2026-01-01' },
    run: async (args) => {
      commands.push(args)
      if (args.includes('repos/acme/widgets/pulls/9')) {
        const error = new Error('gh failed') as Error & { stdout: string }
        error.stdout =
          'HTTP/2.0 403 Forbidden\r\nx-ratelimit-remaining: 0\r\nretry-after: 60\r\n\r\n{"message":"API rate limit exceeded"}\n'
        throw error
      }
      const page = args.find((arg) => arg.includes('comments?page=2'))
      return `HTTP/2.0 ${args.includes('PATCH') ? 200 : 201} OK\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-remaining: 4321\r\n${!page && args.some((arg) => arg.includes('/comments')) ? 'link: <https://api.github.com/repos/acme/widgets/issues/3/comments?page=2>; rel="next"\r\n' : ''}\r\n${args.some((arg) => arg.includes('/comments')) ? JSON.stringify([{ id: page ? 2 : 1 }]) : JSON.stringify({ data: { repository: { pullRequest: { number: 3 } } } })}\n`
    },
  })
  const patched = await adapter.rest({
    method: 'PATCH',
    path: 'repos/acme/widgets/pulls/3',
    body: { title: 'Next' },
  })
  assert.equal(patched.status, 200)
  assert.equal(patched.rateLimit.remaining, 4321)
  assert.ok(commands[0].includes('X-GitHub-Api-Version: 2026-01-01'))
  assert.ok(commands[0].includes('--include'))
  assert.deepEqual(await adapter.paginate({ path: 'repos/acme/widgets/issues/3/comments' }), [
    { id: 1 },
    { id: 2 },
  ])
  const data = await adapter.graphql<{ repository: { pullRequest: { number: number } } }>(
    'query {}',
    { owner: 'acme' },
  )
  assert.equal(data.repository.pullRequest.number, 3)
  await assert.rejects(adapter.rest({ path: 'repos/acme/widgets/pulls/9' }), (error: unknown) => {
    assert.ok(error instanceof GitHubTransportError)
    assert.equal(error.kind, 'rate-limited')
    assert.equal(error.status, 403)
    assert.equal(error.rateLimit.remaining, 0)
    assert.equal(error.rateLimit.retryAfterSeconds, 60)
    return true
  })
})

test('gh rejects pre-cancelled requests and forwards deadlines to the subprocess', async () => {
  let calls = 0
  const adapter = new GhGitHubTransport({
    run: async (_args, options) => {
      calls += 1
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      })
      return ''
    },
  })
  const preCancelled = new AbortController()
  preCancelled.abort()
  await assert.rejects(
    adapter.rest({ path: 'user', signal: preCancelled.signal }),
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'cancelled',
  )
  assert.equal(calls, 0)
  await assert.rejects(
    adapter.graphql('query {}', {}, { timeoutMs: 20 }),
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'timeout',
  )
  const controller = new AbortController()
  const pending = adapter.rest({ path: 'user', signal: controller.signal })
  controller.abort()
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'cancelled',
  )
})

// Real socket timing is essential: fake timers cannot drive fetch's body stream.
test('direct deadlines and cancellation apply while streaming a response body', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.flushHeaders()
    response.write('{"ok":')
    if (request.url === '/broken') setImmediate(() => response.destroy())
    else setTimeout(() => response.end('true}'), 250)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const transport = new DirectGitHubTransport({
      token: 'local-test',
      apiUrl: `http://127.0.0.1:${address.port}`,
    })
    await assert.rejects(
      transport.rest({ path: 'user', timeoutMs: 35 }),
      (error: unknown) => error instanceof GitHubTransportError && error.kind === 'timeout',
    )
    const controller = new AbortController()
    const pending = transport.graphql('query {}', {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 35)
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof GitHubTransportError && error.kind === 'cancelled',
    )
    await assert.rejects(
      transport.rest({ path: 'broken' }),
      (error: unknown) => error instanceof GitHubTransportError && error.kind === 'network',
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('GraphQL HTTP 200 rate limit errors retain their response metadata', async () => {
  const cases: Array<{ message: string; headers: Record<string, string>; kind: GitHubErrorKind }> =
    [
      {
        message: 'API rate limit exceeded',
        headers: { 'x-ratelimit-remaining': '0' },
        kind: 'rate-limited',
      },
      {
        message: 'You have exceeded a secondary rate limit',
        headers: { 'retry-after': '45' },
        kind: 'secondary-rate-limit',
      },
    ]
  for (const expected of cases) {
    const { fetch: response } = recordingFetch([
      { body: { errors: [{ message: expected.message }] }, headers: expected.headers },
    ])
    await assert.rejects(
      new DirectGitHubTransport({ token: 'token', fetch: response }).graphql('query {}'),
      (error: unknown) => {
        assert.ok(error instanceof GitHubTransportError)
        assert.equal(error.kind, expected.kind)
        assert.equal(error.status, 200)
        assert.equal(error.rateLimit.remaining, expected.kind === 'rate-limited' ? 0 : 4321)
        return true
      },
    )
  }
})

test('both transports distinguish primary and secondary rate limits on 429 and 403', async () => {
  const directCases: Array<{
    status: number
    remaining?: string
    retryAfter?: string
    message?: string
    kind: GitHubErrorKind
  }> = [
    { status: 429, remaining: '0', message: 'API rate limit exceeded', kind: 'rate-limited' },
    { status: 429, remaining: '0', kind: 'rate-limited' },
    { status: 429, retryAfter: '60', kind: 'secondary-rate-limit' },
    {
      status: 429,
      message: 'You have exceeded a secondary rate limit',
      kind: 'secondary-rate-limit',
    },
    { status: 429, kind: 'secondary-rate-limit' },
    { status: 403, remaining: '0', message: 'API rate limit exceeded', kind: 'rate-limited' },
    { status: 403, retryAfter: '60', kind: 'secondary-rate-limit' },
    {
      status: 403,
      message: 'You have exceeded a secondary rate limit',
      kind: 'secondary-rate-limit',
    },
    { status: 403, message: 'Forbidden', kind: 'forbidden' },
  ]
  for (const c of directCases) {
    const headers: Record<string, string> = {}
    if (c.remaining !== undefined) headers['x-ratelimit-remaining'] = c.remaining
    if (c.retryAfter !== undefined) headers['retry-after'] = c.retryAfter
    const { fetch: f } = recordingFetch([
      { status: c.status, body: { message: c.message ?? 'error' }, headers },
    ])
    const direct = new DirectGitHubTransport({ token: 't', fetch: f })
    await assert.rejects(direct.rest({ path: 'user' }), (err: unknown) => {
      assert.ok(err instanceof GitHubTransportError)
      assert.equal(err.kind, c.kind)
      assert.equal(err.status, c.status)
      return true
    })
    const gh = new GhGitHubTransport({
      run: async () => {
        const headerLines = Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n')
        const error = new Error('gh failed') as Error & { stdout: string }
        error.stdout = `HTTP/2.0 ${c.status} Error\r\n${headerLines ? headerLines + '\r\n' : ''}\r\n${JSON.stringify({ message: c.message ?? 'error' })}\n`
        throw error
      },
    })
    await assert.rejects(gh.rest({ path: 'user' }), (err: unknown) => {
      assert.ok(err instanceof GitHubTransportError)
      assert.equal(err.kind, c.kind)
      assert.equal(err.status, c.status)
      return true
    })
  }
})

test('pagination rejects malformed collection pages and preserves empty pages', async () => {
  const malformedDirect = new DirectGitHubTransport({
    token: 'token',
    fetch: recordingFetch([{ body: { message: 'not an array' } }]).fetch,
  })
  await assert.rejects(
    malformedDirect.paginate({ path: 'repos/acme/widgets/pulls' }),
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'invalid-response',
  )
  const malformedGh = new GhGitHubTransport({
    run: async () => 'HTTP/2.0 200 OK\r\n\r\n{}\n',
  })
  await assert.rejects(
    malformedGh.paginate({ path: 'repos/acme/widgets/pulls' }),
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'invalid-response',
  )

  const emptyDirect = new DirectGitHubTransport({
    token: 'token',
    fetch: recordingFetch([{ body: [] }]).fetch,
  })
  assert.deepEqual(await emptyDirect.paginate({ path: 'repos/acme/widgets/pulls' }), [])

  const emptyGh = new GhGitHubTransport({
    run: async () => 'HTTP/2.0 200 OK\r\n\r\n[]\n',
  })
  assert.deepEqual(await emptyGh.paginate({ path: 'repos/acme/widgets/pulls' }), [])
})

test('pagination handles prefixed API base without next link and with next link', async () => {
  const serverRequests: string[] = []
  let port = 0
  const server = createServer((request, response) => {
    serverRequests.push(request.url ?? '')
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/v3/single') {
      response.end('[{"id":1}]')
    } else if (request.url === '/api/v3/multi') {
      response.setHeader('link', `<http://127.0.0.1:${port}/api/v3/multi?page=2>; rel="next"`)
      response.end('[{"id":1}]')
    } else if (request.url === '/api/v3/multi?page=2') {
      response.end('[{"id":2}]')
    } else {
      response.statusCode = 404
      response.end('{"message":"not found"}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    port = address.port
    const apiUrl = `http://127.0.0.1:${port}/api/v3`

    serverRequests.length = 0
    const direct = new DirectGitHubTransport({ token: 't', apiUrl })
    const singleItems = await direct.paginate<{ id: number }>({ path: 'single' })
    assert.deepEqual(singleItems, [{ id: 1 }])
    assert.deepEqual(serverRequests, ['/api/v3/single'])

    serverRequests.length = 0
    const multiItems = await direct.paginate<{ id: number }>({ path: 'multi' })
    assert.deepEqual(multiItems, [{ id: 1 }, { id: 2 }])
    assert.deepEqual(serverRequests, ['/api/v3/multi', '/api/v3/multi?page=2'])

    serverRequests.length = 0
    const gh = new GhGitHubTransport({ apiUrl })
    const ghSingle = await gh.paginate<{ id: number }>({ path: 'single' })
    assert.deepEqual(ghSingle, [{ id: 1 }])
    assert.deepEqual(serverRequests, ['/api/v3/single'])

    serverRequests.length = 0
    const ghMulti = await gh.paginate<{ id: number }>({ path: 'multi' })
    assert.deepEqual(ghMulti, [{ id: 1 }, { id: 2 }])
    assert.deepEqual(serverRequests, ['/api/v3/multi', '/api/v3/multi?page=2'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('native gh cancellation and deadline cleanup apply to subprocesses on a local endpoint', async () => {
  let hasGh = false
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' })
    hasGh = true
  } catch {
    hasGh = false
  }
  if (!hasGh) return

  let onHangRequest: (() => void) | null = null
  const server = createServer((_req, _res) => {
    onHangRequest?.()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const gh = new GhGitHubTransport({ apiUrl: `http://127.0.0.1:${address.port}` })

    const pre = new AbortController()
    pre.abort()
    await assert.rejects(
      gh.rest({ path: 'hang', signal: pre.signal }),
      (err: unknown) => err instanceof GitHubTransportError && err.kind === 'cancelled',
    )

    await assert.rejects(
      gh.rest({ path: 'hang', timeoutMs: 50 }),
      (err: unknown) => err instanceof GitHubTransportError && err.kind === 'timeout',
    )

    const ctrl = new AbortController()
    onHangRequest = () => ctrl.abort()
    await assert.rejects(
      gh.rest({ path: 'hang', signal: ctrl.signal }),
      (err: unknown) => err instanceof GitHubTransportError && err.kind === 'cancelled',
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
