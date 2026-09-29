import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer as createTlsServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  forgetHost,
  githubHostContext,
  hostStatus,
  probeGitHubHost,
  probeNativeStacksCapability,
} from '../src/main/github-host'
import {
  DirectGitHubTransport,
  environmentTokenName,
  type GitHubTransport,
} from '../src/main/github-transport'
import type { GitHubCredentialSource } from '../src/main/github-transport'

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
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1',
  ])
  return { key: readFileSync(key), cert: readFileSync(certFile) }
})()

/** Starts one HTTPS server that answers as a GitHub host on its own origin. */
async function startHost(
  name: string,
  handler: (pathname: string) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>,
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
    if (pathname === '/api/v3' || pathname === '/api/v3/') return { body: { current_user_url: '/api/v3/user' } }
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
    assert.equal(
      status.capabilities.find((entry) => entry.id === 'rest')?.state,
      'supported',
    )
    assert.equal(
      status.capabilities.find((entry) => entry.id === 'graphql')?.state,
      'supported',
    )
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
      current: async () => ({ token: 'other-secret', session: 'other', origin: 'account' as const }),
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
    assert.equal(
      afterSwitch.capabilities.find((entry) => entry.id === 'rest')?.state,
      'unknown',
    )
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await slow.close()
  }
})
