import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRemote } from '../src/main/git-core'
import { discoverRepositories } from '../src/main/github-repositories'
import {
  ghCloneCommandText,
  summarizeRepository,
} from '../src/main/github-repositories'
import {
  forgetHost,
  hostStatus,
  GITHUB_DOTCOM_API_BASE,
  GITHUB_DOTCOM_WEB_ORIGIN,
  EXTERNAL_LINK_REFUSAL,
  externalGitHubLink,
  githubHostContext,
  probeGitHubHost,
  probeNativeStacksCapability,
  remoteHostContext,
  validateGitHubHostInput,
  configuredHostContext,
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
  hostScopedEnvironment,
  resolveGitHubToken,
  setGitHubCredentialSource,
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
  // A field this build actually sends, so naming it is a fact about the schema.
  const refusal = "Field 'statusCheckRollup' doesn't exist on type 'PullRequest'."
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
    graphql.detail.includes('statusCheckRollup'),
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

test('the gh clone command names a host with a qualified URL, because gh has no host flag', () => {
  // `gh repo clone` accepts a repository argument or a URL; a bare `owner/name`
  // is resolved on github.com. Verified against the installed CLI: `--hostname`
  // is rejected as an unknown flag, and the URL form is accepted.
  const enterprise = ghCloneCommandText('acme/widgets', '/tmp/clone', 'widgets', false, 'https://ghe.example.com/acme/widgets.git')
  assert.equal(enterprise, 'gh repo clone https://ghe.example.com/acme/widgets.git /tmp/clone/widgets')
  assert.doesNotMatch(enterprise, /--hostname/u)

  const dotcom = ghCloneCommandText('howarewoo/git-stacks', '/tmp/clone', 'git-stacks', true)
  assert.equal(
    dotcom,
    'gh repo clone howarewoo/git-stacks /tmp/clone/git-stacks -- --depth 1',
    'github.com keeps the bare name and the exact command it has always shown',
  )
})

test('an SSH port is never read as a web port, and a web port never reaches SSH', () => {
  // Git answers SSH on its own port; its web API is served from the web port.
  // Reading one as the other aims requests at a port where nothing answers.
  const ssh = parseRemote('ssh://git@ghe.example.com:2222/acme/widgets.git')
  assert.equal(ssh?.host, 'ghe.example.com', 'the SSH port is not the web authority')
  assert.equal(ssh?.sshHost, 'ghe.example.com')
  assert.equal(githubHostContext(ssh!.host).apiBase, 'https://ghe.example.com/api/v3')

  const scp = parseRemote('git@github.com:howarewoo/git-stacks.git')
  assert.equal(scp?.host, 'github.com')
  assert.equal(githubHostContext(scp!.host).apiBase, 'https://api.github.com')

  const https = parseRemote('https://ghe.example.com:8443/acme/widgets.git')
  assert.equal(https?.host, 'ghe.example.com:8443', 'a web port is kept for requests')
  assert.equal(https?.sshHost, 'ghe.example.com', 'and is not written into an SSH remote')
  const context = githubHostContext(https!.host)
  assert.equal(context.apiBase, 'https://ghe.example.com:8443/api/v3')
  assert.equal(context.graphqlUrl, 'https://ghe.example.com:8443/api/graphql')
  assert.equal(
    summarizeRepository(
      { full_name: 'acme/widgets', name: 'widgets', owner: { login: 'acme' }, permissions: {} },
      context,
    )?.sshUrl,
    'git@ghe.example.com:acme/widgets.git',
    'the SSH clone URL carries no web port, which would name a path that does not exist',
  )
})

test('a refusal that names a field this build does not query is not repeated anywhere', async () => {
  forgetHost()
  const context = githubHostContext('ghe-verbose.example.com')
  const api = 'https://ghe-verbose.example.com/api/v3'
  // A server chooses its own wording, and a name in that wording can be
  // anything at all. It is this build's own field names that may be reported.
  const refusal = "Field 'ghs_ABCDEFsecret' doesn't exist on type 'PullRequest'."
  const { fetch } = hostFetch([
    [`${api}/`, { body: { current_user_url: `${api}/user` } }],
    [`${api}/meta`, { body: { installed_version: '3.9.0' } }],
    [context.graphqlUrl, { body: { errors: [{ message: refusal }] } }],
  ])
  const status = await probeGitHubHost(context, {
    transport: new DirectGitHubTransport({
      host: context.host,
      apiUrl: api,
      graphqlUrl: context.graphqlUrl,
      token: 'ghe-token',
      env: {},
      fetch,
    }),
  })
  const graphql = capability(status, 'graphql')
  assert.equal(graphql.state, 'unknown')
  assert.doesNotMatch(graphql.detail, /ghs_ABCDEFsecret/u)
  assert.doesNotMatch(graphql.detail, /doesn't exist/u)
})

test('two different hosts can never share one scoped token name', () => {
  // Every pair here names two hosts a person could really configure, and each
  // pair used to collapse to a single variable.
  const pairs: Array<[string, string]> = [
    ['ghe.internal.example.com', 'ghe.internal-example.com'],
    ['ghe.internal.example.com', 'ghe-dot-internal.example.com'],
    ['ghe.internal.example.com', 'ghe_port_internal.example.com'],
    ['ghe.example.com', 'ghe-example.com'],
  ]
  for (const [one, other] of pairs) {
    assert.notEqual(
      environmentTokenName(one),
      environmentTokenName(other),
      `${one} and ${other} share one token name`,
    )
  }
  // The variable name is written in the alphabet a shell accepts, and the
  // canonical authority is what is encoded: a host on the default port and the
  // same host without it are one host.
  const scoped = environmentTokenName('github.com')
  assert.match(scoped, /^GIT_STACKS_GITHUB_TOKEN_[A-Z0-9]+$/u)
  assert.equal(scoped, environmentTokenName('github.com:443'))
  assert.equal(scoped, environmentTokenName('github.com.'))
  // A token in one host's scope is invisible to every other host, including the
  // two names above that are one character away from it.
  const env: NodeJS.ProcessEnv = {
    [environmentTokenName('ghe.internal.example.com')]: 'dotted-secret',
  }
  assert.equal(resolveGitHubToken(env, 'ghe.internal.example.com'), 'dotted-secret')
  for (const other of [
    'ghe.internal-example.com',
    'ghe-dot-internal.example.com',
    'ghe_port_internal.example.com',
    'ghe.example.com',
  ]) {
    assert.equal(resolveGitHubToken(env, other), null, `${other} can read another's token`)
  }
  // github.com keeps the unscoped names it has always had.
  assert.equal(
    resolveGitHubToken({ GIT_STACKS_GITHUB_TOKEN: 'dotcom-secret' }, 'github.com'),
    'dotcom-secret',
  )
  assert.equal(
    resolveGitHubToken({ GH_TOKEN: 'dotcom-secret' }, 'github.com'),
    'dotcom-secret',
  )
})
test('a child process is given only the host its own credential came from', () => {
  const scoped = hostScopedEnvironment(
    {
      PATH: '/usr/bin',
      GH_TOKEN: 'ambient-secret',
      GITHUB_TOKEN: 'ambient-secret-two',
      GH_ENTERPRISE_TOKEN: 'enterprise-secret',
      GITHUB_ENTERPRISE_TOKEN: 'enterprise-secret-two',
      GIT_STACKS_GITHUB_TOKEN: 'this-build-secret',
      [environmentTokenName('ghe.example.com')]: 'ghe-secret',
      [environmentTokenName('ghe.other.example.com')]: 'other-secret',
    },
    'ghe.example.com',
  )
  assert.equal(scoped.PATH, '/usr/bin')
  assert.equal(
    scoped.GH_ENTERPRISE_TOKEN,
    'ghe-secret',
    'a custom host’s token is handed over under the name the CLI reads for it',
  )
  assert.equal(scoped.GH_TOKEN, undefined)
  // github.com is read from the other name, and keeps its own.
  const dotcom = hostScopedEnvironment(
    { [environmentTokenName('github.com')]: 'dotcom-scoped', GH_TOKEN: 'ambient' },
    'github.com',
  )
  assert.equal(dotcom.GH_TOKEN, 'dotcom-scoped')
  assert.equal(dotcom.GH_ENTERPRISE_TOKEN, undefined)
  for (const name of [
    'GITHUB_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GIT_STACKS_GITHUB_TOKEN',
    environmentTokenName('ghe.other.example.com'),
  ]) {
    assert.equal(scoped[name], undefined, `${name} must not reach a child`)
  }
})

test('a host on the default HTTPS port is one host, not two', () => {
  assert.deepEqual(validateGitHubHostInput('ghe.example.com:443'), {
    ok: true,
    host: 'ghe.example.com',
  })
  assert.deepEqual(validateGitHubHostInput('github.com:443'), { ok: true, host: 'github.com' })
  assert.equal(configuredHostContext('ghe.example.com:443').host, 'ghe.example.com')
  assert.equal(configuredHostContext('ghe.example.com').host, 'ghe.example.com')
  assert.equal(configuredHostContext('github.com:443').dotcom, true)
  assert.equal(githubHostContext('ghe.example.com:443').apiBase, 'https://ghe.example.com/api/v3')
})

test('a link is opened only on a host this installation already speaks to', () => {
  const publicInstall = [configuredHostContext(null)]
  const opened = (value: unknown) => {
    const link = externalGitHubLink(value, publicInstall)
    return link.ok ? link.href : null
  }
  // A host this install does not speak to, however much it resembles one, and
  // every shape that is not an HTTPS link at all.
  for (const refused of [
    'https://gitlab.com/howarewoo/git-stacks',
    'https://github.com.evil.example/howarewoo/git-stacks',
    'https://evil.example/howarewoo/github.com',
    'https://notgithub.com/howarewoo/git-stacks',
    'https://gist.github.com/howarewoo/1',
    'https://api.github.com/repos/howarewoo/git-stacks',
    'https://github.com./howarewoo/git-stacks',
    'https://ghe.example.com/howarewoo/git-stacks',
    'http://github.com/howarewoo/git-stacks',
    'https://user:token@github.com/howarewoo/git-stacks',
    'https://[::1]/howarewoo/git-stacks',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    '',
    42,
    null,
  ]) {
    assert.equal(opened(refused), null, `${String(refused)} is refused`)
  }
  // The public host is the one this build's own links use.
  assert.equal(
    opened('https://github.com/howarewoo/git-stacks/pull/1'),
    'https://github.com/howarewoo/git-stacks/pull/1',
  )
  assert.equal(opened('https://github.com'), 'https://github.com/')
  assert.equal(opened('https://GITHUB.COM/howarewoo'), 'https://github.com/howarewoo')
  assert.equal(
    opened('https://login.github.com/login/device'),
    null,
    'the sign-in page of the public host is trusted; another host on it is not',
  )
})

test('a configured enterprise host is trusted on the port it was configured with, and on no other', () => {
  const onCustomPort = [configuredHostContext('ghe.example.com:8443')]
  const onDefaultPort = [configuredHostContext('ghe.example.com')]
  assert.deepEqual(externalGitHubLink('https://ghe.example.com:8443/o/r/pull/1', onCustomPort), {
    ok: true,
    href: 'https://ghe.example.com:8443/o/r/pull/1',
  })
  // The port is part of the host: the same name on another port is another
  // host, and a host that was configured with one is not reachable without it.
  for (const refused of [
    'https://ghe.example.com/o/r/pull/1',
    'https://ghe.example.com:9999/o/r/pull/1',
    'https://ghe.example.com:443/o/r/pull/1',
  ]) {
    assert.equal(
      externalGitHubLink(refused, onCustomPort).ok,
      false,
      `${refused} is not the configured host`,
    )
  }
  assert.equal(
    externalGitHubLink('https://ghe.example.com/o/r/pull/1', onDefaultPort).ok,
    true,
    'a host configured without a port is reached on the default one',
  )
  // Choosing an enterprise host is not choosing the public one instead.
  assert.equal(
    externalGitHubLink('https://github.com/howarewoo/git-stacks', onCustomPort).ok,
    false,
    'the public host is not a configured host here',
  )
})

test('a repository on its own host is trusted only while that host is in the set', () => {
  const configured = [configuredHostContext(null)]
  const withRepository = [...configured, configuredHostContext('ghe.example.com:8443')]
  const link = 'https://ghe.example.com:8443/howarewoo/git-stacks/pull/1'
  assert.equal(externalGitHubLink(link, configured).ok, false)
  assert.deepEqual(externalGitHubLink(link, withRepository), { ok: true, href: link })
  // The same host name reached on a port the origin never named stays refused.
  assert.equal(
    externalGitHubLink('https://ghe.example.com/howarewoo/git-stacks', withRepository).ok,
    false,
  )
  // An installation that speaks to no host opens nothing at all.
  assert.deepEqual(externalGitHubLink('https://ghe.example.com:8443/x', []), {
    ok: false,
    message: EXTERNAL_LINK_REFUSAL,
  })
})

test('a host that signs in again is not handed the transport of the sign-in it retired', () => {
  forgetHost()
  const first: GitHubCredentialSource = {
    host: 'ghe.example.com',
    available: () => true,
    current: async () => ({ origin: 'account', session: 's1', token: 'first' }),
  }
  const second: GitHubCredentialSource = {
    host: 'ghe.example.com',
    available: () => true,
    current: async () => ({ origin: 'account', session: 's2', token: 'second' }),
  }
  setGitHubCredentialSource(first)
  const a = githubTransportForHost('ghe.example.com', 'https://ghe.example.com/api/v3', {})
  setGitHubCredentialSource(null)
  setGitHubCredentialSource(second)
  const b = githubTransportForHost('ghe.example.com', 'https://ghe.example.com/api/v3', {})
  assert.notEqual(
    a,
    b,
    'the transport cached for a retired sign-in is handed out again for the next one',
  )
  assert.equal(
    githubTransportForHost('ghe.example.com', 'https://ghe.example.com/api/v3', {}),
    b,
    'a repeated call within one sign-in still reuses the transport',
  )
  setGitHubCredentialSource(null)
})

test('a probe cancelled before it finishes records nothing about the host', async () => {
  forgetHost()
  const context = githubHostContext('ghe-retired.example.com')
  const api = 'https://ghe-retired.example.com/api/v3'
  const controller = new AbortController()
  const { fetch } = hostFetch([
    [`${api}/`, { body: { current_user_url: `${api}/user` } }],
    [`${api}/meta`, { body: { installed_version: '3.9.0' } }],
    [context.graphqlUrl, { body: { data: { viewer: { login: 'octo' } } } }],
    // The stacks read is where a host change lands: the probe is cancelled
    // while the repository's own stacks are being read.
    [`${api}/repos/acme/widgets`, { body: { full_name: 'acme/widgets' } }],
    [`${api}/repos/acme/widgets/stacks?per_page=1`, { body: [] }],
  ])
  await assert.rejects(
    probeGitHubHost(context, {
      repository: { owner: 'acme', name: 'widgets' },
      transport: new DirectGitHubTransport({
        host: context.host,
        apiUrl: api,
        graphqlUrl: context.graphqlUrl,
        token: 'ghe-token',
        env: {},
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : (input as string))
          if (url.includes('/stacks')) controller.abort()
          return fetch(input, init)
        }) as typeof globalThis.fetch,
      }),
      signal: controller.signal,
    }),
    (error: unknown) => (error as { kind?: string }).kind === 'cancelled',
    'a cancelled probe is this build stopping, not a host that did not answer',
  )
  // Nothing about the retired host is remembered: its last observed probe is
  // the empty one, not the answer a cancelled probe had almost finished.
  assert.equal(hostStatus(context).probedAt, null)
  assert.equal(
    hostStatus(context).capabilities.find((entry) => entry.id === 'native-stacks')?.state,
    'unknown',
  )
})

test('a discovery run cancelled in flight records nothing about the host', async () => {
  forgetHost()
  const context = githubHostContext('ghe-retired-discovery.example.com')
  const api = 'https://ghe-retired-discovery.example.com/api/v3'
  const controller = new AbortController()
  const inner = hostFetch([
    [/\/user\/repos\?/u, { body: [{ full_name: 'acme/widgets' }] }],
  ])
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner.fetch(input, init)
    // The run is cancelled after the host answered but before its answer is
    // written down, which is the window the check itself guards.
    controller.abort()
    return response
  }) as typeof globalThis.fetch
  await assert.rejects(
    discoverRepositories({
      host: context,
      transport: new DirectGitHubTransport({
        host: context.host,
        apiUrl: api,
        graphqlUrl: context.graphqlUrl,
        token: 'ghe-token',
        env: {},
        fetch,
      }),
      signal: controller.signal,
    }),
    (error: unknown) => (error as { kind?: string }).kind === 'cancelled',
  )
  assert.equal(
    hostStatus(context).capabilities.find((entry) => entry.id === 'repository-discovery')?.state,
    'unknown',
    'a cancelled discovery run was recorded as the host answering',
  )
})

test('a stacks probe cancelled in flight is raised, not read as an absent resource', async () => {
  forgetHost()
  const context = githubHostContext('ghe-retired-stacks.example.com')
  const api = 'https://ghe-retired-stacks.example.com/api/v3'
  const controller = new AbortController()
  const inner = hostFetch([
    [`${api}/repos/acme/widgets`, { body: { full_name: 'acme/widgets' } }],
    [`${api}/repos/acme/widgets/stacks?per_page=1`, { body: [] }],
  ])
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner.fetch(input, init)
    controller.abort()
    return response
  }) as typeof globalThis.fetch
  await assert.rejects(
    probeNativeStacksCapability('acme', 'widgets', {
      transport: new DirectGitHubTransport({
        host: context.host,
        apiUrl: api,
        graphqlUrl: context.graphqlUrl,
        token: 'ghe-token',
        env: {},
        fetch,
      }),
      signal: controller.signal,
    }),
    (error: unknown) => (error as { name?: string }).name === 'GitHubTransportError',
    'the cancellation was turned into a capability state',
  )
})
