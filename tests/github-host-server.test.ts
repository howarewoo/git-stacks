import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer as createTlsServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { delimiter as pathDelimiter, join } from 'node:path'
import { test } from 'node:test'
import {
  forgetHost,
  githubHostContext,
  hostStatus,
  probeGitHubHost,
  probeNativeStacksCapability,
} from '../src/main/github-host'
import {
  readReviewPermissions,
  readReviewThreads,
  replyToThread,
  setThreadResolved,
} from '../src/main/review-threads'
import {
  DirectGitHubTransport,
  environmentTokenName,
  GhGitHubTransport,
  setGitHubHostTransport,
  setGitHubTransport,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type GitHubTransport,
} from '../src/main/github-transport'
import type { GitHubCredentialSource } from '../src/main/github-transport'
import { GITHUB_DEFAULT_HOST } from '../src/shared/host'

/**
 * A real GitHub host on a real socket, not a stubbed fetch. The certificate is
 * generated for this run and the transport is told to trust it, so a request
 * that reaches the wrong host, or a credential that crosses hosts, is visible on
 * the wire rather than only in a mock's bookkeeping.
 */
interface RealHost {
  host: string
  context: ReturnType<typeof githubHostContext>
  requested: { url: string; authorization: string | null }[]
  close: () => Promise<void>
}

const cert = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-stacks-host-'))
  const key = join(dir, 'key.pem')
  const certFile = join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    certFile,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
  ])
  return { key: readFileSync(key), cert: readFileSync(certFile) }
})()

/** Starts one HTTPS server that answers as a GitHub host on its own origin. */
async function startHost(
  name: string,
  handler: (
    pathname: string,
  ) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>,
): Promise<RealHost> {
  const requested: RealHost['requested'] = []
  const server: Server = createTlsServer(
    { key: cert.key, cert: cert.cert },
    (request, response) => {
      const url = new URL(request.url ?? '/', 'https://placeholder')
      requested.push({
        url: `${url.pathname}${url.search}`,
        authorization: (request.headers.authorization as string | undefined) ?? null,
      })
      void (async () => {
        const answer = await handler(url.pathname)
        response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(answer.body ?? {}))
      })()
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error(`${name} has no port`)
  const host = `127.0.0.1:${address.port}`
  return {
    host,
    context: githubHostContext(host),
    requested,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const transportFor = (host: RealHost, credential?: GitHubCredentialSource): GitHubTransport =>
  new DirectGitHubTransport({
    host: host.host,
    apiUrl: host.context.apiBase,
    graphqlUrl: host.context.graphqlUrl,
    token: credential ? null : 'host-token',
    ...(credential ? { credential } : {}),
    env: {},
  })

/** The environment a host's own token is set in, and nowhere else. */
const tokenEnvFor = (host: RealHost): NodeJS.ProcessEnv => ({
  [environmentTokenName(host.host)]: 'host-token',
})

test('a real enterprise host answers on its own origin, and a credential bound elsewhere is refused there', async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const enterprise = await startHost('enterprise', (pathname) => {
    if (pathname === '/api/v3' || pathname === '/api/v3/')
      return { body: { current_user_url: '/api/v3/user' } }
    if (pathname === '/api/v3/meta') return { body: { installed_version: '3.13.1' } }
    // A GitHub Enterprise Server host serves GraphQL from `/api/graphql`, not
    // under its REST base, so that is the path this double answers.
    if (pathname === '/api/graphql') return { body: { data: { viewer: { login: 'octo' } } } }
    if (pathname === '/api/v3/repos/acme/widgets') return { body: { full_name: 'acme/widgets' } }
    if (pathname.startsWith('/api/v3/repos/acme/widgets/stacks'))
      return { body: [{ number: 1, status: 'valid', base: 'main', pull_requests: [] }] }
    return { status: 404, body: { message: 'Not Found' } }
  })
  const other = await startHost('other', () => ({ body: { ok: true } }))
  try {
    // No transport is supplied: the host picks the one a repository on that host
    // would use, from the token set for that host alone.
    const status = await probeGitHubHost(enterprise.context, {
      repository: { owner: 'acme', name: 'widgets' },
      env: tokenEnvFor(enterprise),
    })
    assert.equal(status.host, enterprise.host)
    assert.equal(status.serverVersion, '3.13.1')
    assert.equal(status.apiBase, `https://${enterprise.host}/api/v3`)
    // The capability matrix names what this host actually answered on this socket.
    assert.equal(status.capabilities.find((entry) => entry.id === 'rest')?.state, 'supported')
    assert.equal(status.capabilities.find((entry) => entry.id === 'graphql')?.state, 'supported')
    assert.equal(
      status.capabilities.find((entry) => entry.id === 'native-stacks')?.state,
      'supported',
    )
    // Every request landed on this host: its REST base, or the GraphQL path this
    // host serves that API on. Nothing was addressed elsewhere.
    assert.ok(
      enterprise.requested.every(
        (entry) => entry.url.startsWith('/api/v3/') || entry.url === '/api/graphql',
      ),
      `a request left this host: ${JSON.stringify(enterprise.requested)}`,
    )
    assert.ok(
      enterprise.requested.every((entry) => entry.authorization === 'Bearer host-token'),
      'the host was asked without the credential it owns',
    )
    assert.equal(other.requested.length, 0)

    // A credential minted for the other host is not this host's to use.
    const foreign: GitHubCredentialSource = {
      host: other.host,
      available: () => true,
      current: async () => ({
        token: 'other-secret',
        session: 'other',
        origin: 'account' as const,
      }),
    }
    await assert.rejects(
      transportFor(enterprise, foreign).rest({ path: 'user' }),
      (error: unknown) => (error as { kind?: string }).kind === 'unauthorized',
    )
    assert.equal(
      enterprise.requested.filter((entry) => entry.url === '/api/v3/user').length,
      0,
      'a refused cross-host credential still reached the wire',
    )
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await enterprise.close()
    await other.close()
  }
})

test('a real host without the stacks resource degrades on that socket, and another host is never asked', async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const enterprise = await startHost('no-stacks', (pathname) => {
    if (pathname === '/api/v3/repos/acme/widgets') return { body: { full_name: 'acme/widgets' } }
    if (pathname.startsWith('/api/v3/repos/acme/widgets/stacks'))
      return { status: 404, body: { message: 'Not Found' } }
    return { status: 404, body: { message: 'Not Found' } }
  })
  const other = await startHost('untouched', () => ({ body: {} }))
  try {
    const capability = await probeNativeStacksCapability('acme', 'widgets', {
      transport: transportFor(enterprise),
    })
    assert.equal(capability.available, false)
    // A resource the host refused is a refusal, not a credential or a network
    // problem: the two are never reported the same way.
    assert.equal(capability.reason, 'endpoint-missing')
    assert.notEqual(capability.reason, 'unauthenticated')
    assert.equal(other.requested.length, 0)
    assert.deepEqual(
      enterprise.requested.map((entry) => entry.url),
      ['/api/v3/repos/acme/widgets', '/api/v3/repos/acme/widgets/stacks?per_page=1'],
    )
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await enterprise.close()
    await other.close()
  }
})

test('a real host that rejects this credential is unauthenticated, not a host without the resource', async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const host = await startHost('rejects', (pathname) => {
    if (pathname === '/api/v3/repos/acme/widgets') return { body: { full_name: 'acme/widgets' } }
    return { status: 401, body: { message: 'Bad credentials' } }
  })
  try {
    const capability = await probeNativeStacksCapability('acme', 'widgets', {
      transport: transportFor(host),
    })
    assert.equal(capability.reason, 'unauthenticated')
    assert.notEqual(capability.reason, 'endpoint-missing')
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await host.close()
  }
})

test('an ambient github.com token is never sent to an enterprise host on this socket', async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const enterprise = await startHost('ambient', () => ({ body: { full_name: 'acme/widgets' } }))
  const other = await startHost('dotcom-double', () => ({ body: { ok: true } }))
  try {
    // A repository whose origin names this host, opened with github.com's token
    // in the environment — the shape an attacker's remote produces.
    const transport = new DirectGitHubTransport({
      host: enterprise.host,
      apiUrl: enterprise.context.apiBase,
      graphqlUrl: enterprise.context.graphqlUrl,
      env: { GIT_STACKS_GITHUB_TOKEN: 'dotcom-secret', GITHUB_TOKEN: 'dotcom-secret' },
    })
    await assert.rejects(
      transport.rest({ path: 'repos/acme/widgets' }),
      (error: unknown) => (error as { kind?: string }).kind === 'unauthorized',
    )
    assert.equal(enterprise.requested.length, 0, 'the ambient token reached the enterprise host')
    assert.equal(other.requested.length, 0)

    // The same host, with a token set in that host's own variable, is served.
    const served = new DirectGitHubTransport({
      host: enterprise.host,
      apiUrl: enterprise.context.apiBase,
      graphqlUrl: enterprise.context.graphqlUrl,
      env: { [environmentTokenName(enterprise.host)]: 'enterprise-secret' },
    })
    const response = await served.rest<{ full_name: string }>({ path: 'repos/acme/widgets' })
    assert.equal(response.data.full_name, 'acme/widgets')
    assert.equal(enterprise.requested[0]?.authorization, 'Bearer enterprise-secret')
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await enterprise.close()
    await other.close()
  }
})

test('a probe that answers after its host was retired records nothing', async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const gate = Promise.withResolvers<void>()
  const slow = await startHost('slow', async (pathname) => {
    if (pathname === '/api/v3/' || pathname === '/api/v3') {
      // The first request is answered only when the test releases it, so the
      // switch provably lands while the probe is in flight.
      await gate.promise
      return { body: {} }
    }
    if (pathname === '/api/v3/meta') return { body: { installed_version: '3.12.0' } }
    if (pathname === '/api/graphql') return { body: { data: { __typename: 'Query' } } }
    return { status: 404, body: { message: 'Not Found' } }
  })
  try {
    forgetHost()
    const context = githubHostContext(slow.host)
    const controller = new AbortController()
    const probe = probeGitHubHost(context, {
      repository: { owner: 'acme', name: 'widgets' },
      env: tokenEnvFor(slow),
      signal: controller.signal,
    })
    // The person selects another host while this probe is still in flight.
    controller.abort()
    forgetHost(slow.host)
    gate.resolve()
    await assert.rejects(probe)
    // Nothing this host said survives the switch, including a later retry that
    // a stale caller might still make.
    const afterSwitch = hostStatus(githubHostContext('ghe.example.com'), {})
    assert.equal(afterSwitch.probedAt, null)
    assert.equal(afterSwitch.capabilities.find((entry) => entry.id === 'rest')?.state, 'unknown')
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await slow.close()
  }
})

test('a real gh child is given this host’s token and no other credential', async () => {
  // A real executable on PATH, spawned by the real transport. The script reports
  // the environment it was actually started with, so what the child can see is
  // observed rather than assumed.
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-gh-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const report = join(root, 'env.json')
  await writeFile(
    join(bin, 'gh'),
    `#!/bin/sh\nenv > "${report}"\nprintf 'HTTP/2 200 OK\\r\\nx-ratelimit-limit: 5000\\r\\nx-ratelimit-remaining: 4998\\r\\nx-ratelimit-reset: 1800000000\\r\\nx-ratelimit-resource: core\\r\\n\\r\\n{}\n'\n`,
    'utf8',
  )
  await chmod(join(bin, 'gh'), 0o755)
  const original = process.env.PATH
  process.env.PATH = `${bin}${pathDelimiter}${original ?? ''}`
  try {
    const transport = new GhGitHubTransport({
      host: 'ghe.example.com',
      apiUrl: 'https://ghe.example.com/api/v3',
      env: {
        GH_TOKEN: 'ambient-secret',
        GITHUB_TOKEN: 'ambient-secret-two',
        GH_ENTERPRISE_TOKEN: 'enterprise-secret',
        GITHUB_ENTERPRISE_TOKEN: 'enterprise-secret-two',
        GIT_STACKS_GITHUB_TOKEN: 'this-build-secret',
        [environmentTokenName('ghe.example.com')]: 'ghe-secret',
      },
    })
    await transport.rest({ path: 'meta' })
    const seen: Record<string, string> = {}
    for (const line of (await readFile(report, 'utf8')).split('\n')) {
      const equals = line.indexOf('=')
      if (equals > 0) seen[line.slice(0, equals)] = line.slice(equals + 1)
    }
    assert.equal(
      seen.GH_ENTERPRISE_TOKEN,
      'ghe-secret',
      'a custom host’s token is handed over under the name the CLI reads for it',
    )
    assert.equal(seen.GH_TOKEN, undefined)
    for (const name of [
      'GITHUB_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'GIT_STACKS_GITHUB_TOKEN',
      environmentTokenName('ghe.other.example.com'),
    ]) {
      assert.equal(seen[name], undefined, `${name} reached the child`)
    }
  } finally {
    process.env.PATH = original
    await rm(root, { recursive: true, force: true })
  }
})

test('a token for one host never reaches another host that differs only in its name', async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  // Two real hosts on two real sockets. Their names are the same host name on
  // the same address and differ only in the port digits, which is the smallest
  // difference a name can carry and the one a variable name would swallow.
  const issued = await startHost('internal', () => ({ body: { full_name: 'acme/widgets' } }))
  const lookalike = await startHost('internal-dash', () => ({ body: { full_name: 'acme/other' } }))
  try {
    const transportFor = (host: string, context: ReturnType<typeof githubHostContext>) =>
      new DirectGitHubTransport({
        host,
        apiUrl: context.apiBase,
        graphqlUrl: context.graphqlUrl,
        env: { [environmentTokenName(issued.host)]: 'the-one-secret' },
      })
    // The host the token was issued by is served with it.
    const served = await transportFor(issued.host, issued.context).rest<{ full_name: string }>({
      path: 'repos/acme/widgets',
    })
    assert.equal(served.data.full_name, 'acme/widgets')
    assert.equal(issued.requested[0]?.authorization, 'Bearer the-one-secret')
    assert.notEqual(
      environmentTokenName(issued.host),
      environmentTokenName(lookalike.host),
      'two hosts whose names differ only in digits share a token name',
    )
    // The other host answers on its own socket, and answers only a request that
    // carries a credential of its own: a request made in the belief that it
    // shares the first host's name is refused rather than served.
    await assert.rejects(
      transportFor(lookalike.host, lookalike.context).rest({ path: 'repos/acme/other' }),
      (error: unknown) => (error as { kind?: string }).kind === 'unauthorized',
    )
    assert.equal(lookalike.requested.length, 0, 'the first host’s token reached the lookalike host')
    assert.equal(issued.requested.length, 1, 'the token went to its own host exactly once')
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await issued.close()
    await lookalike.close()
  }
})
test('an enterprise-issued credential is refused by a transport that names no host', async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const enterprise = await startHost('issuer', () => ({ body: { full_name: 'acme/widgets' } }))
  try {
    let asked = 0
    const credential: GitHubCredentialSource = {
      host: enterprise.host,
      available: () => true,
      current: async () => {
        asked += 1
        return { token: 'enterprise-app-secret', origin: 'account' as const, session: null }
      },
    }
    // A transport built for no host in particular serves the default one, so an
    // application credential minted for an enterprise host is not its own and
    // must not be read, let alone sent to the public API.
    const hostless = new DirectGitHubTransport({
      apiUrl: 'https://api.github.com',
      env: {},
      credential,
    })
    await assert.rejects(
      hostless.rest({ path: 'repos/acme/widgets' }),
      (error: unknown) => (error as { kind?: string }).kind === 'unauthorized',
    )
    assert.equal(asked, 0, 'an enterprise credential was read for a hostless transport')
    assert.equal(enterprise.requested.length, 0, 'an enterprise credential reached its own host')
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await enterprise.close()
  }
})

/**
 * A workspace whose origin names an enterprise host. A review is one host's
 * business end to end, so the origin decides which transport every consumer
 * reaches for.
 */
async function enterpriseReviewWorkspace(): Promise<{
  repo: string
  dispose: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-enterprise-review-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Git Stacks test')
  git('config', 'user.email', 'test@example.invalid')
  git('remote', 'add', 'origin', 'https://git.acme.example/acme/widgets.git')
  return { repo, dispose: () => rm(root, { recursive: true, force: true }) }
}

test('every review read and write reaches the host the origin names, not the public one', async () => {
  const workspace = await enterpriseReviewWorkspace()
  const hostCalls: string[] = []
  const hostlessCalls: string[] = []
  const limit = {
    limit: 5000,
    remaining: 4999,
    reset: new Date(0),
    resource: 'core' as const,
    retryAfterSeconds: null,
  }
  const pullRequest = {
    state: 'OPEN',
    viewerDidAuthor: false,
    reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  }
  const record = (
    calls: string[],
    label: string,
    // The host this double actually answers for. It is named rather than left
    // implicit because admission and allowance are keyed by it, and a double
    // that answered for one host while claiming another would make a consumer's
    // own bookkeeping untestable.
    destinationHost: string,
  ): GitHubTransport => ({
    kind: 'direct',
    destinationHost,
    async credentialAuthority(): Promise<string> {
      return `-credential`
    },
    async rest<T>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
      calls.push(`${label}:${request.path ?? ''}`)
      return {
        status: 200,
        rateLimit: limit,
        data: { head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), ref: 'main' } } as T,
      }
    },
    async paginate<T>(): Promise<T[]> {
      return [] as T[]
    },
    async graphql<T>(query: string): Promise<T> {
      calls.push(`${label}:${query.split(/[\s{(]/, 2)[1] ?? 'graphql'}`)
      // Every write is answered with the thing it wrote, so the flow that
      // confirms an outcome after a mutation can complete on this host.
      return {
        viewer: { login: 'ada' },
        repository: { viewerPermission: 'WRITE', pullRequest },
        addPullRequestReviewThreadReply: { comment: { id: 'reply-1', url: null } },
        resolveReviewThread: { thread: { id: 'thread-1', isResolved: true } },
        unresolveReviewThread: { thread: { id: 'thread-1', isResolved: false } },
      } as T
    },
  })
  const context = githubHostContext('git.acme.example')
  setGitHubHostTransport(context.host, record(hostCalls, 'host', context.host))
  // The hostless default serves the public host, which is what the production
  // default transport reports when it was named nothing.
  setGitHubTransport(record(hostlessCalls, 'hostless', GITHUB_DEFAULT_HOST))
  try {
    const permissions = await readReviewPermissions(workspace.repo, 7)
    assert.equal(permissions.viewer, 'ada')
    const threads = await readReviewThreads(workspace.repo, 7)
    assert.equal(threads.threads.threads.length, 0)
    await replyToThread(workspace.repo, 7, 'thread-1', 'looks good')
    await setThreadResolved(workspace.repo, 'thread-1', true)
  } finally {
    setGitHubHostTransport(context.host, null)
    setGitHubTransport(null)
    await workspace.dispose()
  }
  assert.ok(hostCalls.length > 0, 'no review request reached the host the origin names')
  assert.deepEqual(
    hostlessCalls,
    [],
    'a review request was served by a transport that names no host',
  )
})
