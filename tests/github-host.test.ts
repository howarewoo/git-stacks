import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRemote } from '../src/main/git-core'
import {
  forgetHost,
  GITHUB_DOTCOM_API_BASE,
  GITHUB_DOTCOM_WEB_ORIGIN,
  githubHostContext,
  probeGitHubHost,
  probeNativeStacksCapability,
  remoteHostContext,
} from '../src/main/github-host'
import {
  GITHUB_DEVICE_VERIFICATION_URI,
  githubAppClientId,
  pollDeviceAuthorization,
  requestDeviceCode,
} from '../src/main/github-app'
import {
  DirectGitHubTransport,
  GITHUB_STACKS_API_VERSION,
  environmentTokenName,
  GitHubTransportError,
  githubTransportForHost,
  type GitHubCredentialSource,
} from '../src/main/github-transport'
import {
  detectNativeStacksCapability,
  listPullRequestStacks,
  NativeStackError,
} from '../src/main/native-stacks'
import type { GitHubCapability, GitHubCapabilityId, GitHubHostStatus } from '../src/shared/host'

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string | null
}

type Answer =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | { throws: Error }


/**
 * A `fetch` that answers by URL and keeps every request it received, so each case
 * asserts on the request the code actually made rather than on what it meant to.
 */
function hostFetch(
  routes: Array<[pattern: string | RegExp, answer: Answer]>,
): { fetch: typeof globalThis.fetch; recorded: Recorded[] } {
  const recorded: Recorded[] = []
  const double = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    recorded.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    const matched = routes.find(([pattern]) =>
      typeof pattern === 'string' ? url === pattern : pattern.test(url),
    )
    if (!matched) throw new Error(`no route answered ${url}`)
    const answer: Answer = matched[1]
    if ('throws' in answer) throw answer.throws
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4321',
        'x-ratelimit-reset': '1800000000',
        'x-ratelimit-resource': 'core',
        ...answer.headers,
      },
    })
  }) as typeof globalThis.fetch
  return { fetch: double, recorded }
}

/** Runs `body` with `fetch` replaced globally, restoring the real one afterwards. */
async function withFetch<T>(fetch: typeof globalThis.fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fetch
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

async function withEnv<T>(
  values: Record<string, string | undefined>,
  body: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await body()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function capability(status: GitHubHostStatus, id: GitHubCapabilityId): GitHubCapability {
  const found = status.capabilities.find((entry) => entry.id === id)
  assert.ok(found, `the matrix reported no ${id} capability`)
  return found as GitHubCapability
}

const ENTERPRISE = 'ghe.example.com'
const ENTERPRISE_API = 'https://ghe.example.com/api/v3'
/** A GitHub Enterprise Server host serves GraphQL from `/api/graphql`. */
const ENTERPRISE_GRAPHQL = 'https://ghe.example.com/api/graphql'

test('an enterprise origin remote routes every request to that host, never to github.com', async () => {
  forgetHost()
  const https = remoteHostContext(parseRemote('https://ghe.example.com/acme/widgets'))
  const ssh = remoteHostContext(parseRemote('git@ghe.example.com:acme/widgets.git'))
  assert.ok(https && ssh)
  assert.equal(https.host, ENTERPRISE)
  assert.equal(https.dotcom, false)
  assert.equal(https.apiBase, ENTERPRISE_API)
  assert.equal(https.graphqlUrl, ENTERPRISE_GRAPHQL)
  assert.equal(ssh.host, ENTERPRISE)
  assert.equal(ssh.apiBase, ENTERPRISE_API)

  const { fetch, recorded } = hostFetch([
    [`${ENTERPRISE_API}/repos/acme/widgets/stacks`, { body: [] }],
    [`${ENTERPRISE_API}/`, { body: { current_user_url: `${ENTERPRISE_API}/user` } }],
    [`${ENTERPRISE_API}/meta`, { body: { installed_version: '3.11.4' } }],
    [ENTERPRISE_GRAPHQL, { body: { data: { __typename: 'Query' } } }],
    [`${ENTERPRISE_API}/repos/acme/widgets`, { body: { full_name: 'acme/widgets' } }],
    [`${ENTERPRISE_API}/repos/acme/widgets/stacks?per_page=1`, { body: [] }],
  ])

  const probed = await withFetch(fetch, () =>
    withEnv(
      {
        GIT_STACKS_GITHUB_TRANSPORT: 'direct',
        // The token is set in the enterprise host's own variable. An ambient
        // github.com token is never used for a host that did not issue it.
        [environmentTokenName(ENTERPRISE)]: 'ghe-token',
        GIT_STACKS_GITHUB_TOKEN: 'github-token',
        GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
      },
      async () => {
        const stacks = await listPullRequestStacks('acme', 'widgets', { host: https })
        assert.deepEqual(stacks, [])
        // The one request the list made went to the enterprise host's own API,
        // authenticated with the credential that host was given.
        assert.equal(recorded.length, 1)
        assert.equal(recorded[0].url, `${ENTERPRISE_API}/repos/acme/widgets/stacks`)
        assert.equal(recorded[0].headers.get('authorization'), 'Bearer ghe-token')
        assert.equal(recorded[0].headers.get('x-github-api-version'), GITHUB_STACKS_API_VERSION)

        return probeGitHubHost(https, {
          repository: { owner: 'acme', name: 'widgets' },
          now: () => new Date('2026-02-03T04:05:06.000Z'),
        })
      },
    ),
  )

  assert.deepEqual(
    recorded.map((entry) => entry.url),
    [
      `${ENTERPRISE_API}/repos/acme/widgets/stacks`,
      `${ENTERPRISE_API}/`,
      `${ENTERPRISE_API}/meta`,
      ENTERPRISE_GRAPHQL,
      `${ENTERPRISE_API}/repos/acme/widgets`,
      `${ENTERPRISE_API}/repos/acme/widgets/stacks?per_page=1`,
    ],
  )
  for (const entry of recorded) {
    assert.ok(entry.url.includes(ENTERPRISE), `${entry.url} left the configured host`)
    assert.equal(entry.url.includes('api.github.com'), false)
    assert.equal(entry.url.includes('github.com/login'), false)
  }

  const status = probed
  assert.equal(status.host, ENTERPRISE)
  assert.equal(status.kind, 'enterprise')
  assert.equal(status.serverVersion, '3.11.4')
  assert.equal(status.probedAt, '2026-02-03T04:05:06.000Z')
  assert.equal(capability(status, 'rest').state, 'supported')
  assert.equal(capability(status, 'graphql').state, 'supported')
  assert.equal(capability(status, 'native-stacks').state, 'supported')
})

test('a host without the stacks endpoint reports a missing endpoint, and names the host', async () => {
  forgetHost()
  const context = githubHostContext(ENTERPRISE)
  const { fetch, recorded } = hostFetch([
    [`${ENTERPRISE_API}/repos/acme/widgets`, { body: { full_name: 'acme/widgets' } }],
    [`${ENTERPRISE_API}/repos/acme/widgets/stacks?per_page=1`, { status: 404, body: { message: 'Not Found' } }],
  ])
  const transport = new DirectGitHubTransport({
    host: ENTERPRISE,
    apiUrl: ENTERPRISE_API,
    token: 'ghe-token',
    env: {},
    fetch,
  })

  const capability = await probeNativeStacksCapability('acme', 'widgets', { transport })
  assert.equal(capability.available, false)
  assert.equal(capability.reason, 'endpoint-missing')
  assert.notEqual(capability.reason, 'unauthenticated')

  // Detection degrades to a state the publish path branches on rather than
  // raising, because a resource the host refused is a fact about the host.
  const detected = await detectNativeStacksCapability('acme', 'widgets', { host: context, transport })
  assert.equal(detected.available, false)
  assert.equal(detected.state, 'preview-unavailable')

  // The repository answered first, so the 404 belongs to the stacks resource.
  // Both probes above are the same request pair, in the same order.
  const asked = recorded.map((entry) => entry.url)
  assert.deepEqual(asked.slice(0, 2), [
    `${ENTERPRISE_API}/repos/acme/widgets`,
    `${ENTERPRISE_API}/repos/acme/widgets/stacks?per_page=1`,
  ])
  assert.equal(asked.length, 4)
  for (const entry of recorded) {
    assert.equal(entry.headers.get('authorization'), 'Bearer ghe-token')
    assert.ok(entry.url.startsWith(ENTERPRISE_API), `request left the host: ${entry.url}`)
  }
})

test('a host that rejects this build’s GraphQL fields is reported as unknown with the refused field named', async () => {
  forgetHost()
  const context = githubHostContext('ghe-old.example.com')
  const api = 'https://ghe-old.example.com/api/v3'
  const refusal = "Field 'bodyHTML' doesn't exist on type 'PullRequest'."
  const { fetch, recorded } = hostFetch([
    [`${api}/`, { body: { current_user_url: `${api}/user` } }],
    [`${api}/meta`, { body: { installed_version: '3.9.0' } }],
    [
      context.graphqlUrl,
      { body: { errors: [{ message: refusal }] } },
    ],
    [`${api}/repos/acme/widgets`, { body: { full_name: 'acme/widgets' } }],
    [`${api}/repos/acme/widgets/stacks?per_page=1`, { body: [] }],
  ])
  const transport = new DirectGitHubTransport({
    host: 'ghe-old.example.com',
    apiUrl: api,
    graphqlUrl: context.graphqlUrl,
    token: 'ghe-token',
    env: {},
    fetch,
  })

  const status = await probeGitHubHost(context, {
    repository: { owner: 'acme', name: 'widgets' },
    transport,
    now: () => new Date('2026-02-03T04:05:06.000Z'),
  })
  const graphql = capability(status, 'graphql')
  assert.equal(graphql.state, 'unknown')
  assert.notEqual(graphql.state, 'supported')
  assert.notEqual(graphql.state, 'unsupported')
  assert.ok(
    graphql.detail.includes('bodyHTML'),
    `the refusal lost the field it named: ${graphql.detail}`,
  )
  // REST still answered, so only the GraphQL schema is in question.
  assert.equal(capability(status, 'rest').state, 'supported')
  assert.equal(capability(status, 'native-stacks').state, 'supported')
  const graphqlRequest = recorded.find((entry) => entry.url === context.graphqlUrl)
  assert.ok(graphqlRequest)
  assert.equal(graphqlRequest.method, 'POST')
})

test('a GraphQL response with no data is reported as unknown rather than as an unsupported host', async () => {
  forgetHost()
  const context = githubHostContext('ghe-dataless.example.com')
  const api = 'https://ghe-dataless.example.com/api/v3'
  const { fetch } = hostFetch([
    [`${api}/`, { body: { current_user_url: `${api}/user` } }],
    [`${api}/meta`, { body: { installed_version: '3.9.0' } }],
    [context.graphqlUrl, { body: { data: null } }],
  ])
  const transport = new DirectGitHubTransport({
    host: 'ghe-dataless.example.com',
    apiUrl: api,
    graphqlUrl: context.graphqlUrl,
    token: 'ghe-token',
    env: {},
    fetch,
  })

  const status = await probeGitHubHost(context, { transport })
  const graphql = capability(status, 'graphql')
  assert.equal(graphql.state, 'unknown')
  assert.notEqual(graphql.state, 'unsupported')
  // The response body is not copied into the capability: a server can put
  // anything there, and this detail reaches diagnostics and support bundles.
  assert.doesNotMatch(graphql.detail, /data/iu)
})

test('a 401 on the stacks resource is unauthenticated, never a host without the endpoint', async () => {
  forgetHost()
  const context = githubHostContext(ENTERPRISE)
  const { fetch, recorded } = hostFetch([
    [`${ENTERPRISE_API}/`, { body: { current_user_url: `${ENTERPRISE_API}/user` } }],
    [`${ENTERPRISE_API}/meta`, { body: { installed_version: '3.11.4' } }],
    [ENTERPRISE_GRAPHQL, { body: { data: { __typename: 'Query' } } }],
    [`${ENTERPRISE_API}/repos/acme/widgets`, { body: { full_name: 'acme/widgets' } }],
    [
      `${ENTERPRISE_API}/repos/acme/widgets/stacks?per_page=1`,
      { status: 401, body: { message: 'Bad credentials' } },
    ],
  ])
  const transport = new DirectGitHubTransport({
    host: ENTERPRISE,
    apiUrl: ENTERPRISE_API,
    token: 'expired-token',
    env: {},
    fetch,
  })

  const probed = await probeNativeStacksCapability('acme', 'widgets', { transport })
  assert.equal(probed.available, false)
  assert.equal(probed.reason, 'unauthenticated')
  assert.notEqual(probed.reason, 'endpoint-missing')

  const status = await probeGitHubHost(context, {
    transport,
    repository: { owner: 'acme', name: 'widgets' },
    now: () => new Date('2026-02-03T04:05:06.000Z'),
  })
  const stacks = capability(status, 'native-stacks')
  assert.equal(stacks.state, 'unauthenticated')
  assert.notEqual(stacks.state, 'unsupported')
  // The repository itself was readable, so the refusal was about the credential.
  assert.equal(capability(status, 'rest').state, 'supported')
  const refused = recorded.find((entry) => entry.url.endsWith('/stacks?per_page=1'))
  assert.ok(refused)
  assert.equal(refused.headers.get('authorization'), 'Bearer expired-token')
  // An unconfirmed probe is not a degradation: a mutation path must not treat a
  // refused credential as a host that simply lacks the endpoint.
  await assert.rejects(
    () => detectNativeStacksCapability('acme', 'widgets', { host: context, transport }),
    (error: unknown) => {
      assert.ok(error instanceof NativeStackError)
      assert.equal(error.status, 'preview-unavailable')
      assert.match(error.message, /refused|credential|Bad credentials/iu)
      return true
    },
  )
})

test('a host that never answered is unreachable, never unsupported', async () => {
  forgetHost()
  const context = githubHostContext('ghe-offline.example.com')
  const api = 'https://ghe-offline.example.com/api/v3'
  const { fetch, recorded } = hostFetch([
    [/.+/u, { throws: new TypeError('fetch failed') }],
  ])
  const transport = new DirectGitHubTransport({
    host: 'ghe-offline.example.com',
    apiUrl: api,
    graphqlUrl: context.graphqlUrl,
    token: 'ghe-token',
    env: {},
    fetch,
  })

  const probed = await probeNativeStacksCapability('acme', 'widgets', { transport })
  assert.equal(probed.available, false)
  assert.equal(probed.reason, 'unreachable')

  const status = await probeGitHubHost(context, {
    transport,
    repository: { owner: 'acme', name: 'widgets' },
    now: () => new Date('2026-02-03T04:05:06.000Z'),
  })
  assert.equal(status.state, 'unreachable')
  for (const id of ['rest', 'graphql', 'native-stacks'] as GitHubCapabilityId[]) {
    assert.equal(capability(status, id).state, 'unreachable')
  }
  assert.equal(status.serverVersion, null)
  assert.ok(recorded.length > 0)
  for (const entry of recorded) assert.ok(entry.url.includes('ghe-offline.example.com'))
})

test('a credential for one host never reaches another host, and the transport cache never crosses hosts', async () => {
  forgetHost()
  const asked: string[] = []
  const credential: GitHubCredentialSource = {
    host: ENTERPRISE,
    available: () => true,
    current: async () => {
      asked.push('current')
      return { origin: 'account', session: 'session-1', token: 'ghe-secret' }
    },
  }
  const { fetch, recorded } = hostFetch([
    [`${ENTERPRISE_API}/repos/acme/widgets`, { body: { full_name: 'acme/widgets' } }],
    ['https://other.example.com/api/v3/repos/acme/widgets', { body: { full_name: 'acme/widgets' } }],
  ])

  const own = new DirectGitHubTransport({
    host: ENTERPRISE,
    apiUrl: ENTERPRISE_API,
    credential,
    env: {},
    fetch,
  })
  await own.rest({ path: 'repos/acme/widgets' })
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].headers.get('authorization'), 'Bearer ghe-secret')
  assert.deepEqual(asked, ['current'])

  const foreign = new DirectGitHubTransport({
    host: 'other.example.com',
    apiUrl: 'https://other.example.com/api/v3',
    credential,
    env: {},
    fetch,
  })
  await assert.rejects(
    () => foreign.rest({ path: 'repos/acme/widgets' }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubTransportError)
      assert.equal(error.kind, 'unauthorized')
      return true
    },
  )
  // Nothing left the process for the second host, and the secret was not even
  // asked for: there is no header for it to have travelled in.
  assert.equal(recorded.length, 1)
  assert.deepEqual(asked, ['current'])

  // Each host is resolved through the cache with its own environment token, so a
  // transport handed over from the other host would show up in the header.
  const ownEnv = {
    GIT_STACKS_GITHUB_TRANSPORT: 'direct',
    [environmentTokenName(ENTERPRISE)]: 'ghe-cache-token',
  }
  const foreignEnv = {
    GIT_STACKS_GITHUB_TRANSPORT: 'direct',
    [environmentTokenName('other.example.com')]: 'other-cache-token',
  }
  const cachedOwn = githubTransportForHost(ENTERPRISE, ENTERPRISE_API, ownEnv)
  const cachedForeign = githubTransportForHost(
    'other.example.com',
    'https://other.example.com/api/v3',
    foreignEnv,
  )
  const cachedOwnAgain = githubTransportForHost(ENTERPRISE, ENTERPRISE_API, ownEnv)
  await withFetch(fetch, async () => {
    await cachedOwn.rest({ path: 'repos/acme/widgets' })
    await cachedForeign.rest({ path: 'repos/acme/widgets' })
    await cachedOwnAgain.rest({ path: 'repos/acme/widgets' })
  })
  assert.deepEqual(
    recorded.map((entry) => [entry.url, entry.headers.get('authorization')]),
    [
      [`${ENTERPRISE_API}/repos/acme/widgets`, 'Bearer ghe-secret'],
      [`${ENTERPRISE_API}/repos/acme/widgets`, 'Bearer ghe-cache-token'],
      ['https://other.example.com/api/v3/repos/acme/widgets', 'Bearer other-cache-token'],
      [`${ENTERPRISE_API}/repos/acme/widgets`, 'Bearer ghe-cache-token'],
    ],
  )
})

test('github.com keeps its own API origin and its own device-flow paths', async () => {
  forgetHost()
  const context = githubHostContext('github.com')
  assert.equal(context.host, 'github.com')
  assert.equal(context.dotcom, true)
  assert.equal(context.apiBase, GITHUB_DOTCOM_API_BASE)
  assert.equal(context.apiBase, 'https://api.github.com')
  assert.equal(context.webOrigin, GITHUB_DOTCOM_WEB_ORIGIN)
  assert.equal(context.webOrigin, 'https://github.com')
  assert.equal(context.graphqlUrl, 'https://api.github.com/graphql')

  const { fetch, recorded } = hostFetch([
    [
      'https://github.com/login/device/code',
      {
        body: {
          device_code: 'device-1',
          user_code: 'ABCD-1234',
          verification_uri: GITHUB_DEVICE_VERIFICATION_URI,
          expires_in: 900,
          interval: 5,
        },
      },
    ],
    ['https://github.com/login/oauth/access_token', { body: { error: 'authorization_pending' } }],
  ])
  const env = { GIT_STACKS_GITHUB_APP_CLIENT_ID: 'Iv1.dotcom' }
  assert.equal(githubAppClientId(env, 'github.com'), 'Iv1.dotcom')

  const challenge = await requestDeviceCode({
    clientId: githubAppClientId(env, 'github.com') as string,
    host: 'github.com',
    fetch,
  })
  const polled = await pollDeviceAuthorization({
    clientId: githubAppClientId(env, 'github.com') as string,
    deviceCode: challenge.deviceCode,
    host: 'github.com',
    fetch,
  })

  assert.equal(challenge.verificationUri, 'https://github.com/login/device')
  assert.equal(polled.status, 'pending')
  assert.deepEqual(
    recorded.map((entry) => entry.url),
    ['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token'],
  )
  for (const entry of recorded) {
    assert.equal(entry.method, 'POST')
    assert.ok(entry.body?.includes('client_id=Iv1.dotcom'))
  }
})
