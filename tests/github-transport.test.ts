import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import {
  DirectGitHubTransport,
  GhGitHubTransport,
  GITHUB_API_VERSION,
  environmentTokenName,
  GitHubTransportError,
  githubApiVersion,
  githubTransport,
  lastGitHubRateLimitFor,
  resetGitHubRateLimit,
  setGitHubHostTransport,
  setGitHubObservationClock,
  type GitHubCredential,
  type GitHubErrorKind,
} from '../src/main/github-transport'
import { readPullRequestInbox, resetInboxHostAllowances } from '../src/main/pr-inbox'
import type { CachedGitHubResponse, GitHubResponseCache } from '../src/main/github-response-cache'
import type { DesktopAPI } from '../src/shared/types'

// The renderer bridge is the whole renderer capability surface; it must never gain one.
type AssertNever<T extends never> = T
type _NoTokenOrHttpCapability = AssertNever<
  Extract<keyof DesktopAPI, `${string}token${string}` | `${string}auth${string}`>
>

/**
 * Credentials this machine may carry that a controlled CLI must not inherit.
 *
 * The child runs with the inherited environment under these options, so a real
 * token on this machine is a token the child would carry — and an authority read
 * from that child answers from the environment without ever asking the CLI,
 * which would make a profile fixture compare equal to itself. The names are
 * matched against what this environment actually carries rather than against a
 * list of the hosts this file happens to mention: the family is every name the
 * CLI reads and every host-scoped name this build derives from a host, and a
 * host nobody wrote down here still reads one. No value is read, printed or
 * inspected — only names are enumerated, and values are saved and handed back
 * untouched. The fixture's own `PATH` is passed through options rather than by
 * editing this environment.
 */
const INHERITED_GITHUB_CREDENTIALS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GIT_STACKS_GITHUB_TOKEN',
])

/** Every host-scoped name this build writes, however many hosts there are. */
const HOST_SCOPED_GITHUB_CREDENTIAL = /^GIT_STACKS_GITHUB_TOKEN_/u

/**
 * Takes the inherited credentials away for the life of a fixture, and puts
 * back whatever this machine had — as names only.
 *
 * Giving them back is safe to do more than once and safe to do from a failure
 * path, so a setup that throws cannot leave the rest of this process running
 * without the credentials it started with.
 */
function withoutInheritedCredentials(): () => void {
  const saved = new Map<string, string | undefined>()
  for (const name of Object.keys(process.env)) {
    if (!INHERITED_GITHUB_CREDENTIALS.has(name) && !HOST_SCOPED_GITHUB_CREDENTIAL.test(name)) {
      continue
    }
    saved.set(name, process.env[name])
    delete process.env[name]
  }
  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

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
    // 204, 205, and 304 are answers with no body, and `Response` refuses to be
    // constructed with one, so the double answers them the way the host did.
    const bodyless = next.status === 204 || next.status === 205 || next.status === 304
    return new Response(bodyless ? null : JSON.stringify(next.body ?? {}), {
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
test('gh parses HTTP status, rate headers, and paginated response bodies', async () => {
  const adapter = new GhGitHubTransport({
    env: { GIT_STACKS_GITHUB_API_VERSION: '2026-01-01' },
    run: async (args) => {
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

    // The native CLI is not this run's to depend on, so this path is driven
    // through the adapter the transport takes instead: the request goes over a
    // real loopback socket to the same server the direct transport just used,
    // and the answer comes back in the shape `gh api --include` prints. The
    // prefixed base, the link header, and the second page are therefore the
    // transport's own work rather than a harness agreeing with it.
    const run = async (args: string[]): Promise<string> => {
      const target = new URL(args[args.length - 1] ?? '')
      const method = args.includes('--method')
        ? (args[args.indexOf('--method') + 1] ?? 'GET')
        : 'GET'
      const answer = await new Promise<{
        status: number
        headers: [string, string][]
        body: string
      }>((resolve, reject) => {
        const call = httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method,
          },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: Object.entries(response.headers).map(
                  ([name, value]) =>
                    [name, Array.isArray(value) ? value.join(', ') : String(value ?? '')] as [
                      string,
                      string,
                    ],
                ),
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            )
          },
        )
        call.on('error', reject)
        call.end()
      })
      const head = [`HTTP/1.1 ${answer.status} ${answer.status === 200 ? 'OK' : 'Error'}`]
      for (const [name, value] of answer.headers) head.push(`${name}: ${value}`)
      return `${head.join('\r\n')}\r\n\r\n${answer.body}`
    }
    serverRequests.length = 0
    const gh = new GhGitHubTransport({ apiUrl, env: { GH_TOKEN: 'local-test-token' }, run })
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

test('native gh sends JSON content type for REST and GraphQL bodies', async () => {
  let hasGh = false
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' })
    hasGh = true
  } catch {
    hasGh = false
  }
  if (!hasGh) return

  const requests: Array<{ path: string; contentType: string | undefined; body: unknown }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      path: request.url ?? '',
      contentType: request.headers['content-type'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    response.setHeader('content-type', 'application/json')
    response.end(request.url === '/graphql' ? '{"data":{"ok":true}}' : '{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const host = `127.0.0.1:${address.port}`
    const gh = new GhGitHubTransport({
      apiUrl: `http://${host}`,
      host,
      env: { [environmentTokenName(host)]: 'local-test-token' },
    })
    const body = { title: 'Next', nested: { labels: ['one', 'two'] } }
    await gh.rest({ method: 'PATCH', path: 'pulls/3', body })
    const query = 'query { viewer { login } }'
    assert.deepEqual(await gh.graphql(query, { count: 2 }), { ok: true })
    assert.deepEqual(requests, [
      { path: '/pulls/3', contentType: 'application/json', body },
      {
        path: '/graphql',
        contentType: 'application/json',
        body: { query, variables: { count: 2 } },
      },
    ])
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
    const host = `127.0.0.1:${address.port}`
    const gh = new GhGitHubTransport({
      apiUrl: `http://${host}`,
      host,
      env: { [environmentTokenName(host)]: 'local-test-token' },
    })

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

/**
 * A `gh` on a PATH of this test's own, so what the transport asks the CLI is
 * answered by a controlled profile rather than by whatever this machine has
 * signed in to. The script is the CLI's real command shape — `auth token
 * --hostname` reads a local store and contacts no host — so the default child
 * path exercises the same code it would on a person's machine.
 *
 * The inherited credentials go with it: a token this machine really carries
 * would be a credential the child presents, so the authority would resolve from
 * the environment and this CLI would never be asked which profile it holds. The
 * fixture keeps its own `PATH` and gives back what it borrowed.
 */
async function installControlledCli(): Promise<{
  path: string
  hold: (host: string, token: string | null) => void
  remove: () => Promise<void>
}> {
  const restoreCredentials = withoutInheritedCredentials()
  // From here on the fixture owns what the child can authenticate with, so a
  // setup that fails part way through still gives the credentials back.
  try {
    const directory = await mkdtemp(join(tmpdir(), 'git-stacks-cli-'))
    const store = join(directory, 'profiles.json')
    await writeFile(store, '{}')
    const binary = join(directory, 'gh')
    await writeFile(
      binary,
      `#!${process.execPath}
import { readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
if (argv[0] !== 'auth' || argv[1] !== 'token') {
  process.stderr.write('unexpected gh invocation: ' + argv.join(' ') + '\\n')
  process.exit(2)
}
const host = argv[argv.indexOf('--hostname') + 1] ?? ''
const profiles = JSON.parse(readFileSync(${JSON.stringify(store)}, 'utf8'))
const token = profiles[host] ?? null
if (typeof token !== 'string' || token === '') {
  process.stderr.write('not logged in to any host\\n')
  process.exit(1)
}
process.stdout.write(token + '\\n')
`,
    )
    await chmod(binary, 0o755)
    return {
      path: directory,
      hold(host, token) {
        const current = JSON.parse(readFileSync(store, 'utf8')) as Record<string, string>
        if (token === null) delete current[host]
        else current[host] = token
        writeFileSync(store, JSON.stringify(current))
      },
      async remove() {
        restoreCredentials()
        await rm(directory, { force: true, recursive: true })
      },
    }
  } catch (error) {
    // Nothing was installed, but this environment is already changed and the
    // rest of this process runs on it.
    restoreCredentials()
    throw error
  }
}

test('an authority fences the credential its own requests would carry, whatever supplied it', async () => {
  // A token handed straight to the transport, an ambient one, and the account's
  // own each reach `accessCredential`, so each has to move the identity. Asking
  // the environment instead would leave the first and the third unfenced: this
  // machine has no token in its environment at all here, so both would answer
  // identically for every credential this transport ever used.
  const env: NodeJS.ProcessEnv = {}
  const supplied = new DirectGitHubTransport({ env, token: 'supplied-a' })
  const first = await supplied.credentialAuthority()
  const rotated = new DirectGitHubTransport({ env, token: 'supplied-b' })
  assert.notEqual(
    await rotated.credentialAuthority(),
    first,
    'a different supplied token is a different credential and must not keep the old rows',
  )
  assert.equal(await rotated.credentialAuthority(), await rotated.credentialAuthority())

  // The account credential, asked of the account each time. One transport object
  // survives an account that hands it a different credential, and nothing calls
  // `setGitHubCredentialSource` in between: the only way to see that is to read
  // the credential the transport would actually use.
  let held: GitHubCredential | null = {
    token: 'account-a',
    origin: 'account',
    session: 'session-1',
  }
  const account = new DirectGitHubTransport({
    env,
    credential: {
      host: 'github.com',
      available: () => held !== null,
      current: async () => held,
    },
  })
  const admitted = await account.credentialAuthority()
  assert.notEqual(admitted, first, 'an account credential is not the supplied token')
  held = { token: 'account-b', origin: 'account', session: 'session-1' }
  assert.notEqual(
    await account.credentialAuthority(),
    admitted,
    'the account replaced its credential under the same session; the rows read as the old one must be retired',
  )
  held = null
  assert.notEqual(
    await account.credentialAuthority(),
    admitted,
    'a signed-out account holds no credential, which is not the one it held',
  )
})

test('the gh authority is the credential the CLI holds, from the CLI itself', async () => {
  const cli = await installControlledCli()
  try {
    // No token is handed to gh here, so every request is authenticated by the
    // profile the CLI holds. The lookup goes through the default child process,
    // against a PATH that holds only this controlled CLI.
    const env = (): NodeJS.ProcessEnv => ({ PATH: cli.path })
    const transport = new GhGitHubTransport({ env: env() })

    cli.hold('github.com', 'cli-token-a')
    const admitted = await transport.credentialAuthority()
    assert.equal(
      await transport.credentialAuthority(),
      admitted,
      'the same profile is the same authority',
    )

    // The credential is renewed under the same login, from the same source, to
    // the same host. A report about the profile reads the same before and after;
    // the credential that would authenticate does not, and the rows read under
    // the old one are not this credential's rows.
    cli.hold('github.com', 'cli-token-b')
    const renewed = await transport.credentialAuthority()
    assert.notEqual(
      renewed,
      admitted,
      'a renewed credential under one profile is a different credential',
    )
    assert.equal(await transport.credentialAuthority(), renewed)

    // A host with nothing held for it is a host this CLI cannot authenticate,
    // not the host it authenticates differently.
    const enterprise = new GhGitHubTransport({ env: env(), host: 'ghe.example.com' })
    cli.hold('github.com', 'cli-token-a')
    assert.notEqual(
      await enterprise.credentialAuthority(),
      admitted,
      'one host is not another host',
    )

    // `gh` defaults to GH_HOST when no host is named, so the authority has to be
    // the credential for that host rather than for github.com.
    const defaulted = new GhGitHubTransport({
      env: { ...env(), GH_HOST: 'ghe.example.com' },
    })
    cli.hold('ghe.example.com', 'enterprise-token')
    assert.equal(
      await defaulted.credentialAuthority(),
      await new GhGitHubTransport({
        env: { ...env(), GH_HOST: 'ghe.example.com' },
      }).credentialAuthority(),
      'the same host resolves the same authority twice',
    )
    assert.notEqual(await defaulted.credentialAuthority(), admitted)

    // A CLI that cannot name a credential fails closed. It is not installed on
    // this PATH, so the identity it reports is not a profile anything holds.
    const withoutCli = new GhGitHubTransport({ env: { PATH: join(cli.path, 'empty') } })
    assert.notEqual(
      await withoutCli.credentialAuthority(),
      admitted,
      'no CLI is not a profile to keep rows under',
    )
  } finally {
    await cli.remove()
  }
})

/** What `gh` prints with `--include`: a response line, its headers, then the body. */
function answeredResponse(body = '{"data":{"viewer":{"login":"ada"}}}'): string {
  return [
    'HTTP/2 200',
    'content-type: application/json; charset=utf-8',
    'x-ratelimit-limit: 5000',
    'x-ratelimit-remaining: 4998',
    'x-ratelimit-reset: 1780000000',
    '',
    body,
  ].join('\r\n')
}

test('a base this build was pointed at decides the host the answer is counted to', async () => {
  resetGitHubRateLimit()
  try {
    const transport = new GhGitHubTransport({
      // The host the caller named is where it wants the queue filed; the base is
      // where this build was pointed to answer for it. Those are two different
      // hosts, and an answer from the one reached belongs to the one reached.
      host: 'github.com',
      apiUrl: 'https://ghe.example.com:8443/api/v3',
      graphqlUrl: 'https://ghe.example.com:8443/api/graphql',
      run: async () => answeredResponse(),
    })
    await transport.graphql<{ viewer: { login: string } }>('{ viewer { login } }')
    // The answer is evidence about the host that answered for it, so the quota
    // it carried is counted there and not against the host it was filed under.
    assert.equal(lastGitHubRateLimitFor('ghe.example.com:8443').rateLimit.remaining, 4998)
    assert.equal(lastGitHubRateLimitFor('github.com').at, 0)
  } finally {
    resetGitHubRateLimit()
  }
})

test('enterprise primary quota is isolated by the serving port', async () => {
  resetGitHubRateLimit()
  try {
    const transport = new GhGitHubTransport({
      host: 'ghe.example.com:8443',
      apiUrl: 'https://ghe.example.com:8443/api/v3',
      run: async () => answeredResponse(),
    })
    await transport.graphql<{ viewer: { login: string } }>('{ viewer { login } }')
    assert.equal(lastGitHubRateLimitFor('ghe.example.com:8443').rateLimit.remaining, 4998)
    assert.equal(lastGitHubRateLimitFor('ghe.example.com').at, 0)
  } finally {
    resetGitHubRateLimit()
  }
})

test('the credential a child would carry is the one the authority names', async () => {
  const scoped = environmentTokenName('github.com')
  const previous = process.env[scoped]
  try {
    process.env[scoped] = 'inherited-credential-one'
    const transport = new GhGitHubTransport({
      env: { GH_TOKEN: 'credential-for-some-other-host' },
      run: async () => answeredResponse(),
    })
    const fenced = await transport.credentialAuthority()
    // A credential handed over for whichever host the CLI last signed in to
    // never reaches the child as itself, so swapping it swaps nothing the
    // requests are fenced on and rows read under one stay under it.
    const swapped = await new GhGitHubTransport({
      env: { GH_TOKEN: 'a-second-unscoped-credential' },
      run: async () => answeredResponse(),
    }).credentialAuthority()
    assert.equal(fenced, swapped, 'the unscoped credential is not the one requests carry')

    // Replacing the credential this host is entitled to, underneath the same
    // transport, is a different credential, and the rows read with the old one
    // must not outlive it.
    process.env[scoped] = 'inherited-credential-two'
    assert.notEqual(await transport.credentialAuthority(), fenced)
  } finally {
    if (previous === undefined) delete process.env[scoped]
    else process.env[scoped] = previous
  }
})

test('native CLI pins the credential resolved before a profile replacement and credits its own primary window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-stacks-cli-profile-race-'))
  const store = join(directory, 'profile')
  await writeFile(store, 'profile-a')
  const restoreCredentials = withoutInheritedCredentials()
  const now = Date.parse('2026-03-01T12:00:00.000Z')
  const server = createServer((request, response) => {
    const account = request.headers.authorization === 'Bearer profile-a' ? 'A' : 'B'
    response.setHeader('content-type', 'application/json')
    response.setHeader('x-ratelimit-limit', '5000')
    response.setHeader('x-ratelimit-remaining', account === 'A' ? '3' : '4998')
    response.setHeader('x-ratelimit-reset', String(Math.floor(now / 1000) + 3600))
    if (request.url?.endsWith('/graphql')) {
      const pageInfo = { hasNextPage: false, endCursor: null }
      response.end(
        JSON.stringify({
          data: {
            viewer: { login: 'ada' },
            repository: {
              open: {
                nodes: [
                  {
                    number: 44,
                    title: `Account ${account} work`,
                    url: 'https://github.com/acme/app/pull/44',
                    headRefName: 'feat/inbox',
                    headRefOid: 'a'.repeat(40),
                    baseRefName: 'main',
                    isDraft: false,
                    state: 'OPEN',
                    updatedAt: '2026-03-01T12:00:00.000Z',
                    mergedAt: null,
                    author: { login: 'grace' },
                    headRepository: { nameWithOwner: 'acme/app' },
                    reviewDecision: 'REVIEW_REQUIRED',
                    reviewRequests: { nodes: [{ requestedReviewer: { login: 'ada' } }] },
                    latestReviews: { nodes: [] },
                    comments: { nodes: [] },
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
                  },
                ],
                pageInfo,
              },
              merged: { nodes: [], pageInfo },
            },
          },
        }),
      )
    } else
      response.end(
        JSON.stringify(request.url?.includes('/stacks') ? [] : { account, full_name: 'acme/app' }),
      )
  })
  let host: string | undefined
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    host = `127.0.0.1:${address.port}`
    const binary = join(directory, 'gh')
    await writeFile(
      binary,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const store = ${JSON.stringify(store)}
if (argv[0] === 'auth' && argv[1] === 'token') {
  const captured = readFileSync(store, 'utf8')
  writeFileSync(store, 'profile-b')
  process.stdout.write(captured + '\\n')
} else if (argv[0] === 'api') {
  const endpoint = argv.find((arg) => arg.startsWith('http://'))
  const token = process.env.GH_ENTERPRISE_TOKEN || process.env.GH_TOKEN || readFileSync(store, 'utf8')
  const response = await fetch(endpoint, {
    method: endpoint.endsWith('/graphql') ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + token },
  })
  process.stdout.write('HTTP/1.1 ' + response.status + ' OK\\r\\n')
  for (const [name, value] of response.headers) process.stdout.write(name + ': ' + value + '\\r\\n')
  process.stdout.write('\\r\\n' + await response.text() + '\\n')
} else process.exit(2)
`,
    )
    await chmod(binary, 0o755)
    const transport = new GhGitHubTransport({
      host,
      apiUrl: `http://${host}/api/v3`,
      env: { PATH: directory },
    })
    setGitHubHostTransport(host, transport)
    resetGitHubRateLimit()
    resetInboxHostAllowances()
    setGitHubObservationClock(() => now)
    const captured = await transport.rest<{ account: string }>({ path: 'repos/acme/app' })
    assert.equal(
      captured.data.account,
      'A',
      'the API uses the credential captured before profile replacement',
    )
    const inbox = await readPullRequestInbox(
      [{ path: '/repos/app', originUrl: `https://${host}/acme/app.git` }],
      { now, clock: () => now },
    )
    assert.equal(
      inbox.refresh.state,
      'fresh',
      'account A’s spent primary window does not refuse account B',
    )
    assert.deepEqual(
      inbox.items.map((item) => [item.number, item.title]),
      [[44, 'Account B work']],
    )
  } finally {
    if (host) setGitHubHostTransport(host, null)
    resetGitHubRateLimit()
    resetInboxHostAllowances()
    setGitHubObservationClock(null)
    restoreCredentials()
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    await rm(directory, { recursive: true, force: true })
  }
})

test('a 304 is replayed for a conditional read and refused for a mutation that did not opt in', async () => {
  const validator = 'Tue, 22 Sep 2026 09:41:07 GMT'
  const { fetch: answered304, captured } = recordingFetch([
    { status: 304, headers: { etag: '"test-etag"' } },
  ])
  const transport = new DirectGitHubTransport({
    fetch: answered304,
    host: 'github.com',
    env: {},
    token: 'ghp_test',
  })

  // A conditional read with nothing stored behind its validator cannot replay
  // anything, so GitHub's answer is a response this build cannot use.
  await assert.rejects(
    transport.rest({
      method: 'GET',
      path: 'notifications',
      headers: { 'If-Modified-Since': validator },
    }),
    (error: unknown) =>
      error instanceof GitHubTransportError &&
      error.kind === 'invalid-response' &&
      error.detail === 'GitHub answered 304 without a stored response',
  )

  await assert.rejects(
    transport.rest({ method: 'PATCH', path: 'notifications/threads/1', body: { read: true } }),
    (error: unknown) =>
      error instanceof GitHubTransportError &&
      error.kind === 'invalid-response' &&
      error.detail === 'GitHub answered 304 without a stored response',
  )

  // The notification module documents 304 on its own writes as "nothing
  // changed", so it opts in and gets that answer rather than a failure.
  const opted = await transport.rest({
    method: 'PATCH',
    path: 'notifications/threads/1',
    body: { read: true },
    acceptNoChange: true,
  })
  assert.equal(opted.status, 304)
  assert.equal(opted.notModified, true)
  assert.equal(opted.data, null)

  // A read that already has a body keeps replaying it: the 304 is about the
  // stored response, and a mutation that opted in to "no change" stored none.
  const { fetch: answeredOnce, captured: readCaptured } = recordingFetch([
    { status: 200, body: [{ id: '1' }], headers: { 'last-modified': validator } },
    { status: 304, headers: { 'last-modified': validator } },
  ])
  const entries = new Map<string, CachedGitHubResponse>()
  const stored: GitHubResponseCache = {
    get: (key) => entries.get(key) ?? null,
    set: (key, entry) => void entries.set(key, entry),
    delete: (key) => void entries.delete(key),
    clear: () => entries.clear(),
    size: () => entries.size,
  }
  const replaying = new DirectGitHubTransport({
    fetch: answeredOnce,
    host: 'github.com',
    env: {},
    token: 'ghp_test',
    cache: stored,
  })
  const first = await replaying.rest({ method: 'GET', path: 'notifications', cache: true })
  const replayed = await replaying.rest({
    method: 'GET',
    path: 'notifications',
    cache: true,
    headers: { 'If-Modified-Since': validator },
  })
  assert.deepEqual(replayed.data, first.data)
  assert.equal(replayed.notModified, true)
  assert.equal(
    new Headers(readCaptured[1]?.init?.headers).get('if-modified-since'),
    validator,
    'the stored validator is what the conditional read sent back',
  )
  assert.equal(
    readCaptured.length,
    2,
    'the conditional read was answered from the stored body without a second download',
  )
  assert.equal(captured.length, 3, 'each of the three refused or accepted answers was one request')
})
