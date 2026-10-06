/**
 * PR Inbox service regressions, run against the real read path.
 *
 * Every case here goes through `readPullRequestInbox` and the main-process
 * service with a real transport over a synthetic GitHub: the transport resolves
 * the host, sends the request, and parses the rate-limit metadata, and only the
 * far side of the wire is a fixture. A case that needs a pending read holds the
 * synthetic host at a gate, so a credential or registration can be replaced while
 * a read is genuinely in flight.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CommandCancelled } from '../src/main/git-core'
import {
  DirectGitHubTransport,
  GitHubTransportError,
  type GitHubGraphqlOptions,
  type GitHubRestRequest,
  type GitHubTransport,
  credentialEnvNames,
  GhGitHubTransport,
  githubRetryDeadlineFor,
  lastGitHubRateLimitFor,
  resetGitHubRateLimit,
  setGitHubHostTransport,
  setGitHubObservationClock,
} from '../src/main/github-transport'
import {
  PullRequestInboxService,
  readPullRequestInbox,
  resetInboxHostAllowances,
  type PullRequestInboxTarget,
} from '../src/main/pr-inbox'
import { evaluatePullRequestInbox, type PullRequestInboxFilter } from '../src/shared/pr-inbox'
import { admitOwnedProviderCliRoot } from './fixtures/owned-provider-cli'

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const VIEWER = 'ada'

interface Answer {
  status?: number
  body: unknown
  /** A null value removes a header, for a host that reports no such field. */
  headers?: Record<string, string | null>
}

interface SyntheticHost {
  /**
   * One answer per GraphQL request, in the order the queue asks. The third
   * argument is the authorization header the request actually carried, so a
   * case can tell one credential's answer from another's.
   */
  graphql?: (
    variables: Record<string, unknown>,
    call: number,
    authorization: string,
  ) => Answer | Promise<Answer>
  /** One answer per REST request, keyed by path with its query string. */
  rest?: (path: string) => Answer | Promise<Answer>
  /** What the synthetic reports for its own rate-limit window. */
  remaining?: string
  reset?: number
  /** Fails every request as an unreachable host rather than answering it. */
  unreachable?: boolean
}

interface Synthetic {
  /** Every request this synthetic answered, in order. */
  calls: string[]
  graphqlCalls: Record<string, number>
  /** The scripted behaviour, so a case can change a host's mind mid-test. */
  behaviour: Record<string, SyntheticHost>
  /** The transport an ordinary read for one host would use. */
  transport: (host: string) => GitHubTransport
  /**
   * The credential this host's requests carry being replaced, as a caller whose
   * own credential changed hands over the next transport for that host.
   */
  replaceCredential: (host: string, token: string) => GitHubTransport
  restore(): void
}

function connection(
  nodes: readonly unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): unknown {
  return { nodes, pageInfo: { hasNextPage, endCursor } }
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: 'Quiet workbench',
    url: 'https://github.com/acme/app/pull/1',
    headRefName: 'feat/inbox',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    isDraft: false,
    state: 'OPEN',
    updatedAt: new Date(NOW).toISOString(),
    mergedAt: null,
    author: { login: 'grace' },
    headRepository: { nameWithOwner: 'acme/app' },
    reviewDecision: 'REVIEW_REQUIRED',
    reviewRequests: { nodes: [{ requestedReviewer: { login: VIEWER } }] },
    latestReviews: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...overrides,
  }
}

/** The GraphQL answer every host gives when a case does not script one. */
function answered(node: unknown, viewer: string | null = VIEWER): Answer {
  return {
    body: {
      data: {
        viewer: { login: viewer },
        repository: { open: connection([node]), merged: connection([]) },
      },
    },
  }
}

/**
 * A GitHub host served by transports this test owns.
 *
 */
function installSynthetic(hosts: Record<string, SyntheticHost>): Synthetic {
  const calls: string[] = []
  const graphqlCalls: Record<string, number> = {}
  const installed: string[] = []
  const installedTransports: Record<string, GitHubTransport> = {}
  const transportFor: Record<string, (token: string) => GitHubTransport> = {}
  for (const [host, behaviour] of Object.entries(hosts)) {
    installed.push(host)
    const api = `https://${host}/api/v3`
    const headers = (answer: Answer): Headers => {
      const merged = new Headers({ 'content-type': 'application/json; charset=utf-8' })
      for (const [name, value] of Object.entries({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': behaviour.remaining ?? '4998',
        ...(behaviour.reset === undefined ? {} : { 'x-ratelimit-reset': String(behaviour.reset) }),
        ...(answer.headers ?? {}),
      })) {
        if (value === null) merged.delete(name)
        else merged.set(name, value)
      }
      return merged
    }
    const fetch$ = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (behaviour.unreachable) throw new TypeError('fetch failed')
      const url = new URL(String(input))
      const authorization = new Headers(init?.headers ?? {}).get('authorization') ?? ''
      if (url.pathname.endsWith('/graphql')) {
        const call = graphqlCalls[host] ?? 0
        graphqlCalls[host] = call + 1
        calls.push(`${host} POST /graphql`)
        const variables =
          (init?.body ? (JSON.parse(String(init.body)) as { variables?: unknown }) : {})
            .variables ?? {}
        const answer =
          (await behaviour.graphql?.(variables as Record<string, unknown>, call, authorization)) ??
          answered(pullRequest())
        return new Response(JSON.stringify(answer.body), {
          status: answer.status ?? 200,
          headers: headers(answer),
        })
      }
      const path = `${url.pathname.replace(/^\/api\/v3\//u, '')}${url.search}`
      calls.push(`${host} GET ${path}`)
      // A repository that exists and a host that serves stacks is the ordinary
      // answer: the repository probe, the stacks probe, and the listing itself.
      const answer =
        (await behaviour.rest?.(path)) ??
        (path.includes('/stacks') ? { body: [] } : { body: { full_name: 'acme/app' } })
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: headers(answer),
      })
    }) as typeof globalThis.fetch

    // One transport per host, registered and handed back as the same object, so
    // a case can read the identity the requests themselves are fenced on. The
    // credential belongs to the caller that owns it, so a credential replaced
    // outside this app arrives as the next transport authenticating as another.
    const forHost = (token: string) =>
      new DirectGitHubTransport({
        host,
        fetch: fetch$,
        // Only a second host needs its own base: github.com's is the one the
        // transport already serves, and a transport pointed at an enterprise
        // base refuses to send anything to it, which would turn a two-host
        // case into a credential case.
        ...(host === 'github.com' ? {} : { apiUrl: api }),
        graphqlUrl: `${api}/graphql`,
        // Every transport authenticates as the one credential its caller owns,
        // which is the only credential it has: there is no ambient fallback for a
        // request to find, so replacing the credential means handing the next
        // transport a different one.
        token,
      })
    transportFor[host] = forHost
    const transport = forHost('synthetic-token')
    setGitHubHostTransport(host, transport)
    installedTransports[host] = transport
  }
  resetGitHubRateLimit()
  resetInboxHostAllowances()
  return {
    calls,
    graphqlCalls,
    behaviour: hosts,
    /** The transport a caller would use for one host, as any ordinary read is. */
    transport: (host: string) => installedTransports[host],
    /**
     * The credential this host's requests carry being replaced: the next
     * transport for that host authenticates as another one, which is what a
     * credential replaced outside this app looks like to every reader.
     */
    replaceCredential: (host: string, token: string) => {
      const replacement = transportFor[host](token)
      setGitHubHostTransport(host, replacement)
      installedTransports[host] = replacement
      return replacement
    },
    restore() {
      for (const host of installed) {
        setGitHubHostTransport(host, null)
        delete process.env[credentialEnvNames(host)[0]]
      }
      resetGitHubRateLimit()
      resetInboxHostAllowances()
    },
  }
}

/**
 * Runs `body` with one clock behind both the read and the rate-limit
 * observations it makes.
 *
 * A wait runs from the moment the answer that named it was seen, and only that
 * same moment says whether the wait has passed. A read that dates its answers
 * on one clock and admits on another could be refused by a deadline that the
 * answer it read never named, or released before the host said to return.
 */
async function withOneClock<T>(clock: () => number, body: () => Promise<T>): Promise<T> {
  setGitHubObservationClock(clock)
  try {
    return await body()
  } finally {
    setGitHubObservationClock(null)
  }
}

function target(
  repository: string,
  path = `/repos/${repository.replace('/', '-')}`,
  host = 'github.com',
): PullRequestInboxTarget {
  return { path, originUrl: `https://${host}/${repository}.git` }
}

test('a repository whose merged listing has no next page is read once', async () => {
  const api = installSynthetic({
    'github.com': {
      graphql: (_variables, call) =>
        // The empty merged listing answers on the first page, which is the case
        // a cursor-driven loop cannot finish.
        call === 0
          ? answered(pullRequest())
          : { body: { data: { viewer: { login: VIEWER }, repository: { open: connection([]) } } } },
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    assert.equal(report.refresh.state, 'fresh')
    assert.equal(report.items.length, 1)
    assert.deepEqual(report.items[0].groups, ['review-requested'])
    // One queue page, the repository probe, the stacks probe, and the listing.
    assert.equal(api.graphqlCalls['github.com'], 1)
    assert.equal(report.refresh.requests, api.calls.length)
    assert.equal(report.refresh.requests, 4)
  } finally {
    api.restore()
  }
})

test('the check badge reports the state GitHub reported, not a pending stand-in', async () => {
  const api = installSynthetic({
    'github.com': {
      graphql: () =>
        answered(
          pullRequest({
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
          }),
        ),
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    assert.equal(report.items[0]?.checks, 'failing')
  } finally {
    api.restore()
  }
})

test('a host that refuses the review fields is reported as degraded, and both queries are charged', async () => {
  const api = installSynthetic({
    'github.com': {
      graphql: (_variables, call) =>
        call === 0
          ? {
              body: {
                errors: [{ message: `Cannot query field "reviewDecision" on type "PullRequest"` }],
              },
            }
          : answered(pullRequest()),
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    assert.equal(report.refresh.repositories[0]?.status, 'degraded')
    assert.equal(report.refresh.state, 'partial')
    assert.match(report.refresh.repositories[0]?.detail ?? '', /does not report review decisions/)
    // An unreported check state is not a repository with pending checks, and
    // not a repository with none either: the row says what it does not know.
    assert.equal(report.items[0]?.metadata, 'degraded')
    assert.equal(report.items[0]?.checks, 'none')
    // The one group a degraded read can still support, and nothing the host
    // refused to answer: those stay empty rather than being decided from
    // fields this read never obtained.
    assert.deepEqual(report.items[0]?.groups, ['review-requested'])
    // The refused query is a request that happened, so it is charged with the
    // narrower query and the stack reads that follow it.
    assert.equal(api.graphqlCalls['github.com'], 2)
    assert.equal(report.refresh.requests, api.calls.length)
  } finally {
    api.restore()
  }
})

test('every page of a native-stack listing is charged, not one price for the whole read', async () => {
  const stacks = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: index,
      number: index + 1000,
      state: 'open',
      pull_requests: [],
    }))
  const api = installSynthetic({
    'github.com': {
      rest: (path) => {
        if (!path.includes('/stacks')) return { body: { full_name: 'acme/app' } }
        const page = Number(new URL(`https://github.com${path}`).searchParams.get('page') ?? '1')
        // A full first page makes the walk ask again, which is the page an
        // uncharged read would never be billed for.
        return { body: page === 1 ? stacks(100) : [] }
      },
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    // The capability probe asks for one entry; the listing walk reads both pages.
    assert.equal(api.calls.filter((call) => call.includes('/stacks?per_page=100')).length, 2)
    assert.equal(report.refresh.requests, api.calls.length)
  } finally {
    api.restore()
  }
})

test('a refresh that read nothing says the host was unreachable, and names the repositories', async () => {
  const api = installSynthetic({ 'github.com': { unreachable: true } })
  try {
    const report = await readPullRequestInbox([target('acme/app'), target('acme/widgets')], {
      now: NOW,
    })
    assert.equal(report.refresh.state, 'offline')
    assert.deepEqual(
      report.refresh.repositories.map((entry) => entry.status),
      ['offline', 'offline'],
    )
    assert.match(report.refresh.detail, /acme\/app/)
    assert.match(report.refresh.detail, /acme\/widgets/)
    assert.equal(report.items.length, 0)
  } finally {
    api.restore()
  }
})

test('a credential one host refuses does not skip another host', async () => {
  const api = installSynthetic({
    'github.example.com': {
      graphql: () => ({ status: 401, body: { message: 'Bad credentials' } }),
    },
    'github.com': {},
  })
  try {
    const report = await readPullRequestInbox(
      [
        { path: '/repos/enterprise', originUrl: 'https://github.example.com/acme/enterprise.git' },
        target('acme/app'),
      ],
      { now: NOW },
    )
    const byName = new Map(report.refresh.repositories.map((entry) => [entry.repository, entry]))
    assert.equal(byName.get('acme/enterprise')?.status, 'unauthorized')
    assert.equal(byName.get('acme/app')?.status, 'ok')
    assert.equal(report.items.length, 1)
    assert.equal(report.refresh.state, 'partial')
  } finally {
    api.restore()
  }
})

/** The one API server two different origins can both be served by. */
const SHARED_SERVER = 'git.acme.example'

/**
 * A transport that answers for another server.
 *
 * An operator can point a second origin at a base the first already uses. The
 * two keep their own credentials and their own GraphQL endpoints there, and
 * GitHub meters them as one server, so this is the shape that tells a quota
 * key apart from a transport: the requests belong to the host, the allowance
 * belongs to the server.
 */
function servedBy(transport: GitHubTransport, server: string): GitHubTransport {
  return {
    kind: transport.kind,
    destinationHost: server,
    credentialAuthority: () => transport.credentialAuthority(),
    rest: <T = unknown>(request: GitHubRestRequest) => transport.rest<T>(request),
    paginate: <T = unknown>(request: GitHubRestRequest) => transport.paginate<T>(request),
    graphql: <T = Record<string, unknown>>(
      query: string,
      variables?: Record<string, unknown>,
      options?: GitHubGraphqlOptions,
    ) => transport.graphql<T>(query, variables, options),
  }
}

/** The two origins of one server, each keeping its own transports. */
function installSharedServer(hosts: Record<string, SyntheticHost>): Synthetic {
  const api = installSynthetic(hosts)
  for (const host of Object.keys(hosts)) {
    setGitHubHostTransport(host, servedBy(api.transport(host), SHARED_SERVER))
  }
  return api
}

test('two origins on one API server retain their own transports and primary quotas', async () => {
  const api = installSharedServer({
    'github.com': {
      remaining: '4000',
      graphql: () => answered(pullRequest({ number: 11, title: 'public row' }), 'ada-public'),
    },
    'ghe.example.com': {
      remaining: '1200',
      graphql: () =>
        answered(pullRequest({ number: 22, title: 'enterprise row' }), 'ada-enterprise'),
    },
  })
  const origins = [
    target('acme/app', '/repos/acme-public'),
    target('acme/tools', '/repos/acme-enterprise', 'ghe.example.com'),
  ]
  try {
    const report = await readPullRequestInbox(origins, { now: NOW })
    assert.equal(report.refresh.state, 'fresh')
    // Each host was read by the transport built for it, so each answered with
    // its own listing. One transport shared between them would have sent both
    // reads to whichever host was reached first.
    assert.deepEqual(report.items.map((item) => item.title).sort(), [
      'enterprise row',
      'public row',
    ])
    assert.equal(api.graphqlCalls['github.com'], 1)
    assert.equal(api.graphqlCalls['ghe.example.com'], 1)
    // What each repository reports about itself is its own origin host, not the
    // server both of them happen to be served by.
    const byName = new Map(report.refresh.repositories.map((entry) => [entry.repository, entry]))
    assert.equal(byName.get('acme/app')?.host, 'github.com')
    assert.equal(byName.get('acme/tools')?.host, 'ghe.example.com')
    // Two logins on one server is not one credential changing its mind: each
    // repository keeps its own, and the queue names no viewer because there is
    // no single one to name. Reading this refresh as a queue read by nobody in
    // particular is the truth; calling it cancelled would throw away both rows.
    assert.equal(report.refresh.viewer, null)
    assert.equal(byName.get('acme/app')?.viewer, 'ada-public')
    assert.equal(byName.get('acme/tools')?.viewer, 'ada-enterprise')

    // These origins authenticate as different accounts on the same serving
    // host. Primary allowance belongs to each account, not to the server.
    //
    // Sitting exactly on the reserve, each account is still admitted.
    for (const host of Object.keys(api.behaviour)) api.behaviour[host]!.remaining = '250'
    const onTheLine = await readPullRequestInbox(origins, { now: NOW })
    assert.equal(onTheLine.refresh.state, 'fresh')
    assert.equal(
      api.graphqlCalls['ghe.example.com'],
      2,
      'a remaining count of exactly the reserve is enough to read the next origin',
    )

    // A's response spends only A's allowance. B remains above the reserve on
    // the same server and must still be read when A is subsequently refused.
    api.behaviour['github.com']!.remaining = '249'
    api.behaviour['ghe.example.com']!.remaining = '1200'
    const below = await readPullRequestInbox(origins, { now: NOW })
    assert.equal(below.refresh.state, 'fresh')
    api.behaviour['ghe.example.com']!.remaining = '249'
    const independent = await readPullRequestInbox(origins, { now: NOW })
    assert.deepEqual(
      independent.refresh.repositories.map((entry) => [entry.repository, entry.status]),
      [
        ['acme/app', 'rate-limited'],
        ['acme/tools', 'ok'],
      ],
    )
    assert.equal(api.graphqlCalls['ghe.example.com'], 4)
    const beforeRefusal = api.calls.length
    const exhausted = await readPullRequestInbox(origins, { now: NOW })
    assert.equal(exhausted.refresh.state, 'rate-limited')
    assert.deepEqual(
      exhausted.refresh.repositories.map((entry) => [entry.repository, entry.status]),
      [
        ['acme/app', 'rate-limited'],
        ['acme/tools', 'rate-limited'],
      ],
    )
    assert.equal(api.calls.length, beforeRefusal, 'neither exhausted account sends a request')
  } finally {
    api.restore()
  }
})

test('a secondary refusal holds every account to its own wait, and spends none of their allowance', async () => {
  // A secondary limit is the host refusing everyone at once, and it names a wait
  // that is much shorter than the window the headers describe.
  let refusals = 0
  const api = installSynthetic({
    'github.com': {
      remaining: '4998',
      reset: Math.floor((NOW + 3_600_000) / 1000),
      // The host refuses once. Whether this account is asked again is what the
      // wait it named decides, so the answer after it has to be an answer.
      graphql: (variables) =>
        variables.name === 'hidden' && refusals++ === 0
          ? {
              status: 200,
              body: { errors: [{ message: 'You have exceeded a secondary rate limit' }] },
              headers: { 'retry-after': '60' },
            }
          : answered(pullRequest({ number: 51, title: 'Served inside an hour window' })),
    },
    'ghe.example.com': {
      remaining: '4998',
      graphql: () => answered(pullRequest({ number: 52, title: 'Another account entirely' })),
    },
  })
  try {
    let moment = NOW
    const clock = (): number => moment
    await withOneClock(clock, async () => {
      const targets = [
        target('acme/hidden'),
        target('acme/other', '/repos/acme-other', 'ghe.example.com'),
      ]
      const first = await readPullRequestInbox(targets, { now: moment, clock })
      const seen = new Map(first.refresh.repositories.map((e) => [e.repository, e.status]))
      assert.equal(seen.get('acme/hidden'), 'rate-limited')
      assert.equal(seen.get('acme/other'), 'ok')

      // Inside the minute it named, this account is not asked — and neither is
      // anyone else on that host.
      moment = NOW + 59_999
      const inside = await readPullRequestInbox(targets, { now: moment, clock })
      const blocked = new Map(inside.refresh.repositories.map((e) => [e.repository, e.status]))
      assert.equal(blocked.get('acme/hidden'), 'rate-limited')
      assert.equal(
        blocked.get('acme/other'),
        'ok',
        'a wait one host named was charged to another host as well',
      )

      // After it passes, and long before the window it arrived with resets, this
      // account is served again: it spent nothing, and an hour is the window, not
      // the wait.
      moment = NOW + 60_001
      const served = await readPullRequestInbox([target('acme/hidden')], { now: moment, clock })
      assert.equal(
        served.refresh.repositories[0]?.status,
        'ok',
        'a refusal that spent nothing was held until the window it arrived with reset',
      )
      assert.deepEqual(
        served.items.map((item) => item.title),
        ['Served inside an hour window'],
      )
    })
  } finally {
    api.restore()
  }
})

test('an exhausted window is honoured with no reserve kept at all', async () => {
  let spentRefusals = 0
  const api = installSynthetic({
    'github.com': {
      graphql: (variables) =>
        variables.name === 'spent' && spentRefusals++ === 0
          ? {
              status: 200,
              body: { errors: [{ message: 'API rate limit exceeded' }] },
              headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': null,
                'retry-after': '600',
              },
            }
          : answered(pullRequest({ number: 53, title: 'Kept aside by the refusal' })),
    },
  })
  try {
    let moment = NOW
    const clock = (): number => moment
    await withOneClock(clock, async () => {
      // No reserve at all: the queue protects no headroom, which is not a licence
      // to spend a window that is already empty.
      const options = { now: moment, clock, budget: { reserve: 0 } }
      const targets = [target('acme/spent'), target('acme/kept')]
      const first = await readPullRequestInbox(targets, options)
      const seen = new Map(first.refresh.repositories.map((e) => [e.repository, e.status]))
      assert.equal(seen.get('acme/spent'), 'rate-limited')
      const before = api.calls.length
      moment = NOW + 599_999
      const inside = await readPullRequestInbox(targets, {
        now: moment,
        clock,
        budget: { reserve: 0 },
      })
      const blocked = new Map(inside.refresh.repositories.map((e) => [e.repository, e.status]))
      assert.equal(blocked.get('acme/spent'), 'rate-limited')
      assert.notEqual(
        blocked.get('acme/kept'),
        'ok',
        'a repository sharing an empty window was reported as read',
      )
      assert.equal(
        api.calls.length,
        before,
        'an account inside its own wait was asked again with nothing left to spend',
      )
      moment = NOW + 600_001
      const after = await readPullRequestInbox(targets, {
        now: moment,
        clock,
        budget: { reserve: 0 },
      })
      const statuses = new Map(after.refresh.repositories.map((e) => [e.repository, e.status]))
      assert.equal(
        statuses.get('acme/spent'),
        'ok',
        'the account was held past the wait it was given',
      )
      assert.deepEqual(
        after.items.map((item) => item.repository).sort(),
        ['acme/kept', 'acme/spent'],
        'the account was not served again once its own window had passed',
      )
      assert.ok(api.calls.length > before, 'the account was not asked once its own wait passed')
    })
  } finally {
    api.restore()
  }
})

test('a primary window lasts as long as the later of the two moments it named', async () => {
  for (const shape of [
    // A counter that resets sooner than the retry the host named, and the other
    // way round. The window is whichever of the two is later.
    { reset: 600, retryAfter: 3_600 },
    { reset: 3_600, retryAfter: 600 },
  ]) {
    // A window with nothing left in it answers nothing at all: while this account
    // is refused, every request on this host is refused, which is what an empty
    // window means.
    let refusals = 0
    const api = installSynthetic({
      'github.com': {
        graphql: () => {
          if (refusals++ === 0)
            return {
              status: 200,
              body: { errors: [{ message: 'API rate limit exceeded' }] },
              headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Math.floor(NOW / 1000) + shape.reset),
                'retry-after': String(shape.retryAfter),
              },
            }
          return answered(pullRequest({ number: 54, title: 'Served after the window' }))
        },
      },
    })
    try {
      let moment = NOW
      const clock = (): number => moment
      await withOneClock(clock, async () => {
        const targets = [target('acme/window')]
        const first = await readPullRequestInbox(targets, { now: moment, clock })
        assert.equal(first.refresh.repositories[0]?.status, 'rate-limited')
        const asked = api.calls.length

        // A moment before the longer of the two moments it named, nothing is asked
        // of this host: the shorter of the two is not the window.
        moment = NOW + 3_600_000 - 2
        const inside = await readPullRequestInbox(targets, { now: moment, clock })
        assert.equal(
          inside.refresh.repositories[0]?.status,
          'rate-limited',
          `a window that resets in ${shape.reset}s and retries in ${shape.retryAfter}s was released early`,
        )
        assert.equal(api.calls.length, asked, 'the host was asked inside its own window')

        // And once the later moment has passed it is served, with no wait left.
        moment = NOW + 3_600_001
        const after = await readPullRequestInbox(targets, { now: moment, clock })
        assert.equal(
          after.refresh.repositories[0]?.status,
          'ok',
          'the account was still held once its own window had passed',
        )
        assert.deepEqual(
          after.items.map((item) => item.title),
          ['Served after the window'],
        )
      })
    } finally {
      api.restore()
    }
  }
})

test('a refused credential is one origin’s, and so is the window it spent', async () => {
  const credential = installSharedServer({
    'github.com': { graphql: () => ({ status: 401, body: { message: 'Bad credentials' } }) },
    'ghe.example.com': {},
  })
  const origins = [
    target('acme/app', '/repos/acme-public'),
    target('acme/tools', '/repos/acme-enterprise', 'ghe.example.com'),
  ]
  try {
    const report = await readPullRequestInbox(origins, { now: NOW })
    const byName = new Map(report.refresh.repositories.map((entry) => [entry.repository, entry]))
    assert.equal(byName.get('acme/app')?.status, 'unauthorized')
    // The same server, and still a separate authentication: one origin's token
    // being refused says nothing about the other's, so this repository is read.
    assert.equal(byName.get('acme/tools')?.status, 'ok')
    assert.equal(report.items.length, 1)
    assert.equal(credential.graphqlCalls['ghe.example.com'], 1)
  } finally {
    credential.restore()
  }

  const quota = installSharedServer({
    'github.com': {
      graphql: () => ({
        status: 429,
        body: { message: 'API rate limit exceeded' },
        headers: { 'retry-after': '600' },
      }),
    },
    'ghe.example.com': {},
  })
  try {
    const report = await readPullRequestInbox(origins, { now: NOW })
    const byName = new Map(report.refresh.repositories.map((entry) => [entry.repository, entry]))
    assert.equal(byName.get('acme/app')?.status, 'rate-limited')
    // The window was measured against the one account GitHub counted, and the
    // other origin is a different account behind a different credential: it is
    // asked, and what it says is its own answer, not an echo of the refusal
    // beside it.
    assert.equal(byName.get('acme/tools')?.status, 'ok')
    assert.deepEqual(
      report.items.map((item) => item.repository),
      ['acme/tools'],
      "the other account's rows were lost to the refusal it never met",
    )
    const askedOnce = quota.graphqlCalls['ghe.example.com'] ?? 0
    assert.ok(askedOnce > 0, 'the other account was never asked anything')

    // The refused account is the one that waits: it is asked for nothing while
    // its own window is open, and the account beside it is asked again rather
    // than left idle behind a wait it is not inside.
    const asked = { ...quota.graphqlCalls }
    const again = await readPullRequestInbox(origins, { now: NOW + 60_000 })
    const byNameAgain = new Map(
      again.refresh.repositories.map((entry) => [entry.repository, entry]),
    )
    assert.equal(byNameAgain.get('acme/app')?.status, 'rate-limited')
    assert.equal(quota.graphqlCalls['github.com'], asked['github.com'])
    assert.ok(
      (quota.graphqlCalls['ghe.example.com'] ?? 0) > (asked['ghe.example.com'] ?? 0),
      'the account with allowance left was not asked again',
    )
  } finally {
    quota.restore()
  }
})

test('two registered clones of one remote are one read, one row, and one set of charges', async () => {
  const api = installSynthetic({ 'github.com': {} })
  try {
    const report = await readPullRequestInbox(
      [
        { path: '/repos/second', originUrl: 'https://github.com/acme/app.git' },
        { path: '/repos/first', originUrl: 'https://github.com/Acme/App.git' },
      ],
      { now: NOW },
    )
    assert.equal(report.refresh.repositories.length, 1)
    assert.equal(report.items.length, 1)
    // The row opens the same clone every run, whichever one was registered first.
    assert.equal(report.items[0]?.repositoryPath, '/repos/first')
    assert.equal(report.refresh.requests, api.calls.length)
    assert.equal(api.graphqlCalls['github.com'], 1)
  } finally {
    api.restore()
  }
})

test('a merged listing with more than one page is read to its bound and named', async () => {
  const mergedPage = (call: number) =>
    connection(
      [
        pullRequest({
          number: 90 + call,
          state: 'MERGED',
          mergedAt: new Date(NOW).toISOString(),
          author: { login: VIEWER },
          reviewRequests: { nodes: [] },
        }),
      ],
      true,
      `merged-${call}`,
    )
  const api = installSynthetic({
    'github.com': {
      graphql: (_variables, call) => ({
        body: {
          data: {
            viewer: { login: VIEWER },
            repository: {
              // The open listing ends on its second page while the merged one
              // keeps going, so both listings are followed independently.
              open: connection(call === 0 ? [pullRequest()] : [], call === 0, 'open-1'),
              merged: mergedPage(call),
            },
          },
        },
      }),
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    // The merged listing reaches the bound this read asks for, which is named
    // rather than passed over in silence.
    assert.equal(api.graphqlCalls['github.com'], 2)
    assert.equal(report.refresh.truncated.includes('acme/app'), true)
    assert.equal(report.refresh.repositories[0]?.status, 'ok')
    assert.equal(report.items.filter((item) => item.groups.includes('recently-merged')).length, 2)
  } finally {
    api.restore()
  }
})

test('an expired rate-limit window admits the next refresh, an open one refuses it', async () => {
  // The window this read reports is the one every later refresh is turned away
  // by, so both halves are driven through real responses from one host rather
  // than by a seeded counter. The windows are named against the clock that
  // admits them, because admission is decided when each repository is reached.
  const expired = installSynthetic({
    'github.com': { remaining: '3', reset: Math.floor((Date.now() - 60_000) / 1000) },
  })
  try {
    const first = await readPullRequestInbox([target('acme/app')])
    assert.equal(first.refresh.state, 'fresh')
    // The count this read reported belongs to a window that has already closed,
    // so the next refresh is not turned away by a count that no longer applies.
    const second = await readPullRequestInbox([target('acme/app')])
    assert.equal(second.refresh.state, 'fresh')
    assert.equal(second.refresh.repositories[0]?.status, 'ok')
  } finally {
    expired.restore()
  }

  const openWindow = installSynthetic({
    'github.com': { remaining: '3', reset: Math.floor((Date.now() + 3_600_000) / 1000) },
  })
  try {
    await readPullRequestInbox([target('acme/app')])
    const refused = await readPullRequestInbox([target('acme/app')])
    assert.equal(refused.refresh.state, 'rate-limited')
    assert.equal(refused.refresh.repositories[0]?.status, 'rate-limited')
    // The refused refresh asked nothing: its host already spent the allowance
    // it was about to spend, and an open window turns the next read away
    // rather than letting it learn by trying.
    assert.equal(openWindow.graphqlCalls['github.com'], 1)
  } finally {
    openWindow.restore()
  }
})

test("one host's spent window never refuses another host's repositories", async () => {
  const api = installSynthetic({
    'github.com': { remaining: '3', reset: Math.floor((Date.now() + 3_600_000) / 1000) },
    // The second host is never short of allowance, so only github.com's window
    // can be the reason a repository was held back.
    'github.example.com': { remaining: '4998' },
  })
  try {
    const both = [
      target('acme/app'),
      target('acme/enterprise', '/repos/enterprise', 'github.example.com'),
    ]
    const first = await readPullRequestInbox(both)
    const firstStatus = new Map(
      first.refresh.repositories.map((entry) => [entry.repository, entry.status]),
    )
    assert.equal(firstStatus.get('acme/app'), 'ok')

    // github.com spent its allowance and its window is still open. The other
    // host has its own allowance and its own answer, and github.com's count is
    // not evidence about it: the repository must be held back or read for its
    // own reasons, never turned away by a window it is not inside.
    const second = await readPullRequestInbox(both)
    const byRepository = new Map(
      second.refresh.repositories.map((entry) => [entry.repository, entry.status]),
    )
    assert.equal(byRepository.get('acme/app'), 'rate-limited')
    const enterprise = second.refresh.repositories.find(
      (entry) => entry.repository === 'acme/enterprise',
    )
    assert.notEqual(enterprise?.status, 'rate-limited')
    assert.equal(enterprise?.status, firstStatus.get('acme/enterprise'))
    assert.equal(enterprise?.status, 'ok')
    // The refused refresh asked github.com nothing.
    assert.equal(api.graphqlCalls['github.com'], 1)
  } finally {
    api.restore()
  }
})

test('rows one account read never reach the account that replaced it', async () => {
  let down = false
  const api = installSynthetic({
    'github.com': {
      graphql: () => {
        if (down) throw new TypeError('fetch failed')
        return answered(pullRequest())
      },
    },
  })
  try {
    let identity = 'ada'
    const service = new PullRequestInboxService(() => identity)
    const targets = [target('acme/app')]
    const first = await service.refresh(targets, { now: NOW })
    assert.equal(first.items.length, 1)

    // The account is replaced and the host stops answering. The rows the old
    // account's read confirmed are not the new account's to keep, so the queue
    // is empty and says why, rather than handing over another account's work.
    identity = 'grace'
    down = true
    const replaced = await service.refresh(targets, { now: NOW })
    assert.equal(replaced.refresh.state, 'offline')
    assert.deepEqual(replaced.items, [])
    assert.equal(replaced.refresh.confirmedAt, null)
  } finally {
    api.restore()
  }
})

test('a read that cannot answer keeps the rows this identity confirmed', async () => {
  let down = false
  const api = installSynthetic({
    'github.com': {
      graphql: () => {
        if (down) throw new TypeError('fetch failed')
        return answered(pullRequest({ additions: 0, deletions: 0, reviewThreads: connection([]) }))
      },
    },
  })
  try {
    const service = new PullRequestInboxService(() => 'ada')
    const targets = [target('acme/app')]
    const confirmed = await service.refresh(targets, { now: NOW })
    assert.equal(confirmed.items.length, 1)
    assert.deepEqual(confirmed.items[0].changeSize, { state: 'known', value: 0 })

    // The host stops answering; the rows GitHub confirmed for this identity are
    // what stays on screen, with the reason they are unconfirmed.
    down = true
    const stale = await service.refresh(targets, { now: NOW })
    assert.equal(stale.refresh.state, 'offline')
    assert.equal(stale.items.length, 1)
    assert.deepEqual(stale.items[0].changeSize, { state: 'stale' })
    assert.deepEqual(stale.items[0].unresolvedThreads, { state: 'stale' })
    assert.equal(stale.refresh.confirmedAt, confirmed.refresh.confirmedAt)
  } finally {
    api.restore()
  }
})

test('a read that finishes after the account was replaced publishes nothing', async () => {
  const gate = Promise.withResolvers<void>()
  const api = installSynthetic({
    'github.com': {
      graphql: async () => {
        await gate.promise
        return answered(pullRequest())
      },
    },
  })
  try {
    let identity = 'ada'
    const service = new PullRequestInboxService(() => identity)
    const targets = [target('acme/app')]
    const pending = service.refresh(targets, { now: NOW })
    while ((api.graphqlCalls['github.com'] ?? 0) === 0) await new Promise(setImmediate)
    identity = 'grace'
    gate.resolve()
    await assert.rejects(pending, CommandCancelled)
  } finally {
    api.restore()
  }
})

test('a cancelled refresh raises rather than answering with a partial queue', async () => {
  const api = installSynthetic({ 'github.com': {} })
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      readPullRequestInbox([target('acme/app')], { now: NOW, signal: controller.signal }),
      CommandCancelled,
    )
    assert.equal(api.graphqlCalls['github.com'], undefined)
  } finally {
    api.restore()
  }
})

test("two hosts serve two accounts and one queue keeps both hosts' rows", async () => {
  // An enterprise host is a different account from github.com, and its rows are
  // grouped against its own viewer. Fencing the two together would refuse a
  // queue that is exactly right; naming one of them as the whole queue's viewer
  // would mislabel the other's rows.
  const api = installSynthetic({
    'github.com': {
      graphql: () => answered(requestedFrom('alice', 81), 'alice'),
    },
    'github.example.com': {
      graphql: () => answered(requestedFrom('bob', 77), 'bob'),
    },
  })
  try {
    const report = await readPullRequestInbox(
      [target('acme/app'), target('acme/enterprise', '/repos/enterprise', 'github.example.com')],
      { now: NOW },
    )
    const byRepository = new Map(
      report.refresh.repositories.map((entry) => [entry.repository, entry.viewer]),
    )
    assert.equal(byRepository.get('acme/app'), 'alice')
    assert.equal(byRepository.get('acme/enterprise'), 'bob')
    // Neither host's rows are described by the other host's login.
    assert.equal(report.refresh.viewer, null)
    const numbers = report.items.map((item) => item.number).sort((a, b) => a - b)
    assert.deepEqual(numbers, [77, 81])
    // Each row's groups were decided against the viewer of its own host: both
    // were requested for review by that host's viewer, so both are queued.
    assert.equal(
      report.items.every((item) => item.groups.includes('review-requested')),
      true,
    )
  } finally {
    api.restore()
  }
})

test('one host serving two logins across repositories retires the read', async () => {
  const api = installSynthetic({
    'github.com': {
      // The first repository is read as one login; by the time the second is
      // read the same host answers as another.
      graphql: (_variables, call) => answered(pullRequest(), call === 0 ? VIEWER : 'grace'),
    },
  })
  try {
    const targets = [target('acme/app'), target('acme/second', '/repos/second')]
    await assert.rejects(readPullRequestInbox(targets, { now: NOW }), CommandCancelled)
  } finally {
    api.restore()
  }
})

/** A pull request that viewer was asked to review, authored by somebody else. */
function requestedFrom(viewer: string, number: number): Record<string, unknown> {
  return pullRequest({
    number,
    author: { login: 'grace' },
    reviewRequests: { nodes: [{ requestedReviewer: { login: viewer } }] },
  })
}

test('a credential replaced before the read answers retires it, with the account unchanged', async () => {
  // The account status is identical on both sides of this: the same host, the
  // same login, the same reference. What changed is the credential the process
  // will use, so the rows the pending read produces belong to the sign-in it
  // did not ask for.
  const gate = Promise.withResolvers<void>()
  const api = installSynthetic({
    'github.com': {
      graphql: async () => {
        await gate.promise
        return answered(pullRequest())
      },
    },
  })
  try {
    // The main process's own authority: the account status this process last saw,
    // joined with the count of credentials it has been given.
    let status = 'github.com|active|ada|ref-1'
    let credentials = 1
    const service = new PullRequestInboxService(() => `${status}\u0000${credentials}`)
    const targets = [target('acme/app')]
    const pending = service.refresh(targets, { now: NOW })
    while ((api.graphqlCalls['github.com'] ?? 0) === 0) await new Promise(setImmediate)
    credentials = 2
    gate.resolve()
    await assert.rejects(pending, CommandCancelled)
    // The account never changed, so there is nothing for the status to report.
    assert.equal(status, 'github.com|active|ada|ref-1')
  } finally {
    api.restore()
  }
})

test('a read retired late cannot wipe rows a newer read has already confirmed', async () => {
  // Two reads, one identity each: the first is abandoned when the credential is
  // replaced, and it only fails afterwards. The second confirms rows under the
  // credential that replaced it. A late failure from the first must not reach
  // past its own identity and empty what the second confirmed.
  const firstGate = Promise.withResolvers<void>()
  const api = installSynthetic({
    'github.com': {
      graphql: async (_variables, call) => {
        if (call === 0) {
          await firstGate.promise
          return answered(pullRequest({ number: 9 }))
        }
        return answered(pullRequest({ number: 1 }))
      },
    },
  })
  try {
    let credentials = 1
    const service = new PullRequestInboxService(() => `github.com|active|ada\u0000${credentials}`)
    const targets = [target('acme/app')]

    const abandoned = service.refresh(targets, { now: NOW })
    while ((api.graphqlCalls['github.com'] ?? 0) < 1) await new Promise(setImmediate)
    // The credential is replaced while that read is still waiting, and the
    // replacement's own read runs and confirms first.
    credentials = 2
    const confirmed = await service.refresh(targets, { now: NOW })
    assert.equal(confirmed.refresh.state, 'fresh')
    assert.deepEqual(
      confirmed.items.map((item) => item.number),
      [1],
    )

    // Only now does the abandoned read fail. It is refused for its own identity
    // and changes nothing the newer one confirmed.
    api.behaviour['github.com'].graphql = async () => {
      throw new TypeError('fetch failed')
    }
    firstGate.resolve()
    await assert.rejects(abandoned, CommandCancelled)

    // The next read cannot answer either, and the rows it falls back on are the
    // ones the newer credential confirmed, not the ones the older one was
    // reading when it was abandoned.
    const after = await service.refresh(targets, { now: NOW })
    assert.equal(after.refresh.state, 'offline')
    assert.deepEqual(
      after.items.map((item) => item.number),
      [1],
      'the abandoned read did not empty the rows the replacement confirmed',
    )
    assert.equal(after.refresh.confirmedAt, confirmed.refresh.confirmedAt)
  } finally {
    api.restore()
  }
})

test('a failed read after a credential was replaced keeps no rows from the old one', async () => {
  // The replacement credential really cannot read the repository: the host
  // answers from the authorization the request carried, so this is the second
  // credential's own refusal rather than a scripted one.
  const api = installSynthetic({
    'github.com': {
      graphql: (_variables, _call, authorization) =>
        authorization.includes('first-sign-in')
          ? answered(pullRequest())
          : { status: 401, body: { message: 'Bad credentials' } },
    },
  })
  try {
    api.replaceCredential('github.com', 'first-sign-in')
    // The identity the queue is fenced on is the credential authority of the
    // very transport these rows are read through, so it can only move when the
    // credential those requests carry moves.
    const service = new PullRequestInboxService(async () =>
      ['github.com|active|ada|ref-1', await api.transport('github.com').credentialAuthority()].join(
        '\u0000',
      ),
    )
    const targets = [target('acme/app')]
    const confirmed = await service.refresh(targets, { now: NOW })
    assert.equal(confirmed.items.length, 1)

    // The credential is replaced outside this app, and the replacement cannot
    // read the repository. The rows the old credential confirmed are not the
    // new one's last-known-good, so the queue is empty and says why. The
    // same-credential test above is what keeps rows.
    api.replaceCredential('github.com', 'second-sign-in')
    const afterReplacement = await service.refresh(targets, { now: NOW })
    assert.equal(afterReplacement.refresh.state, 'auth-required')
    assert.deepEqual(afterReplacement.items, [])
    assert.equal(afterReplacement.refresh.confirmedAt, null)
  } finally {
    api.restore()
  }
})

/**
 * Credentials this machine may carry that the controlled CLI must not inherit.
 *
 * The child runs with the inherited environment under these options, so a real
 * token on this machine is a credential the CLI would present and an authority
 * that resolves from the environment instead of asking the CLI which profile it
 * holds. The names are matched against what this environment actually carries
 * rather than against the hosts this file happens to mention: the family is
 * every name the CLI reads plus every host-scoped name this build derives from
 * a host, and a host nobody wrote down here still reads one. No value is read,
 * printed or inspected — only names are enumerated, and values are saved and
 * handed back untouched. The fixture's own `PATH` reaches the child through
 * options rather than by editing this environment.
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
 * Takes those credentials away for the life of a fixture and gives back
 * whatever this machine had.
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

/**
 * A GitHub host served entirely by a `gh` on a PATH of this test's own.
 *
 * The CLI answers both halves of what a person running with `gh` actually uses:
 * the credential it holds for a host (`auth token --hostname`) and the requests
 * made with it (`api --include --hostname`, answered in the included-HTTP wire
 * form the transport parses). Both come from the same executable and the same
 * token store, so the rows a read produces and the identity that read is fenced
 * on cannot disagree — a case that used one transport for the data and another
 * for the identity would pass while the identity governed nothing.
 *
 * The credential is consumed rather than reported: every invocation records the
 * credential it would present, and a request made with a credential this CLI's
 * store does not hold is refused the way a real one is. A case can therefore
 * assert on the credential the rows were actually read with.
 *
 * Nothing here reaches this machine's real CLI: the child's PATH holds only this
 * directory, and the executable is launched by absolute path with its own
 * interpreter, so there is nothing to fall through to.
 */
async function installSyntheticCli(initial: {
  /** The one host this CLI holds a credential for; any other names none. */
  host: string
  material: string
  /** The GraphQL payload this host answers every request with. */
  body: unknown
}): Promise<{
  authority: () => Promise<string>
  rotate: (material: string) => Promise<void>
  /** Replaces the credential the CLI holds, under the same login and source. */
  deny: (denied: boolean) => Promise<void>
  /** Stops the host answering at all, as an unreachable one does. */
  reach: (reachable: boolean) => Promise<void>
  /** Every command this host was asked to run, in order. */
  asked: () => string[]
  /** The PATH holding this CLI and nothing else, for a transport built by hand. */
  path: string
  /** The credential each of those commands would authenticate with, in order. */
  presented: () => string[]
  remove: () => Promise<void>
}> {
  const restoreCredentials = withoutInheritedCredentials()
  // From here on the fixture owns what the child can authenticate with, so a
  // setup that fails part way through still gives the credentials back.
  try {
    const directory = await mkdtemp(join(tmpdir(), 'git-stacks-inbox-cli-'))
    const control = join(directory, 'profile.json')
    const invocations = join(directory, 'invocations')
    const presentedCredentials = join(directory, 'presented')
    const profile: Record<string, unknown> = { ...initial }
    // Merged into what the profile already says, so one change at a time cannot
    // quietly put back a field an earlier change had moved.
    const write = async (next: Record<string, unknown>): Promise<void> => {
      Object.assign(profile, next)
      await writeFile(control, JSON.stringify(profile))
    }
    const binary = join(directory, 'gh')
    await writeFile(
      binary,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(invocations)}, argv.join(' ') + '\\n')
const profile = JSON.parse(readFileSync(${JSON.stringify(control)}, 'utf8'))
const flag = (name) => {
  const at = argv.indexOf(name)
  return at === -1 ? null : argv[at + 1]
}

// The credential this invocation would authenticate with: whatever this build
// handed the CLI in its environment, and otherwise the credential the CLI's own
// store holds. Recorded for every command, so a case can read the credential the
// rows came back through rather than a report about one.
const presented = process.env.GH_TOKEN || process.env.GH_ENTERPRISE_TOKEN || profile.material || ''
appendFileSync(${JSON.stringify(presentedCredentials)}, presented + '\\n')

if (argv[0] === 'auth' && argv[1] === 'token') {
  const host = flag('--hostname')
  if (!profile.material || profile.host !== host) {
    process.stderr.write('not logged in to any host\\n')
    process.exit(1)
  }
  process.stdout.write(profile.material + '\\n')
  process.exit(0)
}

if (argv[0] !== 'api') {
  process.stderr.write('unexpected gh invocation: ' + argv.join(' ') + '\\n')
  process.exit(2)
}

// A host that cannot be reached produces no response at all, which is what a
// failed connection looks like to the transport.
if (profile.reachable === false) {
  process.stderr.write('error connecting to ' + flag('--hostname') + '\\n')
  process.exit(1)
}

const send = (status, body) => {
  process.stdout.write(
    'HTTP/2.0 ' + status + ' ' + (status === 200 ? 'OK' : 'Unauthorized') + '\\r\\n' +
      'content-type: application/json; charset=utf-8\\r\\n' +
      'x-ratelimit-limit: 5000\\r\\n' +
      'x-ratelimit-remaining: 4998\\r\\n' +
      '\\r\\n' + JSON.stringify(body) + '\\n',
  )
}

// The credential the CLI holds is the credential the request is made with, so a
// credential that has lost access to the repository fails this request too, and
// so does a request this CLI's store does not hold the credential for.
if (profile.denied === true || presented !== profile.material) {
  send(401, { message: 'Bad credentials' })
  process.exit(0)
}

send(200, profile.body)
`,
    )
    await chmod(binary, 0o755)
    // Admitted by name, so the boundary answers for the file the real transport
    // starts and refuses the machine's own CLI.
    admitOwnedProviderCliRoot(directory)
    await write({})
    // One transport, constructed the way the app constructs one — with the host
    // named — and installed once. The credential belongs to the CLI, and the
    // replacement happens outside this app: nothing here is rebuilt or
    // re-registered, so a transport that cached the authority it first read would
    // still answer with it after the credential changed underneath.
    const transport = new GhGitHubTransport({ env: { PATH: directory }, host: 'github.com' })
    setGitHubHostTransport('github.com', transport)
    return {
      authority: () => transport.credentialAuthority(),
      path: directory,
      rotate: async (material) => {
        await write({ material })
      },
      deny: async (denied) => {
        await write({ denied })
      },
      reach: async (reachable) => {
        await write({ reachable })
      },
      asked: () =>
        existsSync(invocations)
          ? readFileSync(invocations, 'utf8').split('\n').filter(Boolean)
          : [],
      presented: () =>
        existsSync(presentedCredentials)
          ? readFileSync(presentedCredentials, 'utf8').split('\n').filter(Boolean)
          : [],
      async remove() {
        setGitHubHostTransport('github.com', null)
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

test('rows are fenced to the credential the gh CLI holds, not only to this process', async () => {
  const cli = await installSyntheticCli({
    host: 'github.com',
    material: 'profile-a-material',
    body: answered(pullRequest()).body,
  })
  try {
    const service = new PullRequestInboxService(
      async () => `github.com|active|ada|ref-1\u0000${await cli.authority()}`,
    )
    const targets = [target('acme/app')]
    // The fixture takes this machine's own credentials away by name, so this
    // host can only be authenticated by the credential this CLI holds. Without
    // that, the identity below would be resolved from the environment and the
    // profile would never be asked, and every assertion after this one would
    // compare an answer with itself.
    assert.equal(process.env[credentialEnvNames('github.com')[0]], undefined)
    assert.equal(process.env.GH_TOKEN, undefined)
    assert.equal(process.env.GITHUB_TOKEN, undefined)
    assert.equal(process.env.GIT_STACKS_GITHUB_TOKEN, undefined)
    const confirmed = await service.refresh(targets, { now: NOW })
    assert.equal(confirmed.items.length, 1)
    const admitted = await cli.authority()

    // Every command named this host and was issued through this CLI: the
    // credential lookup, and the API requests the rows above came back through.
    // A read served by anything else would have left one of these out.
    const asked = cli.asked()
    assert.equal(asked.includes('auth token --hostname github.com'), true)
    const requests = asked.filter((command) => command !== 'auth token --hostname github.com')
    assert.equal(requests.length > 0, true)
    for (const command of requests) {
      assert.equal(
        command.startsWith('api --hostname github.com --include '),
        true,
        `unexpected gh invocation: ${command}`,
      )
    }
    // The queue rows came from the GraphQL endpoint and the repositories from
    // the REST probes, both on this CLI's own credential.
    assert.equal(
      requests.some((command) => /--method POST graphql /.test(command)),
      true,
      `no GraphQL read on this CLI: ${asked.join(' / ')}`,
    )
    assert.equal(
      requests.some((command) => / repos\/acme\/app$/.test(command)),
      true,
      `no repository probe on this CLI: ${asked.join(' / ')}`,
    )

    // The credential those rows came back through is the profile's own
    // material, on every command including the lookup: this is the credential
    // the requests were made with, not a string this process composed about one.
    assert.deepEqual(
      [...new Set(cli.presented())],
      ['profile-a-material'],
      `the rows were not read on this CLI's credential: ${asked.join(' / ')}`,
    )

    // The credential is renewed outside this app, under the same login, from the
    // same source, for the same host, and the replacement cannot read the
    // repository. Nothing here was told: no environment variable moved and no
    // account status changed.
    await cli.rotate('profile-b-material')
    assert.notEqual(await cli.authority(), admitted)
    await cli.deny(true)
    const afterReplacement = await service.refresh(targets, { now: NOW })
    assert.equal(afterReplacement.refresh.state, 'auth-required')
    assert.deepEqual(
      afterReplacement.items,
      [],
      'the rows the previous credential confirmed are not this credential rows',
    )
    assert.equal(afterReplacement.refresh.confirmedAt, null)

    // A machine that cannot reach the host can still be asked which profile it
    // holds, so the renewal does not become invisible just because the network
    // went away: the credential behind the rows changed, and an unreachable
    // host is not a reason to keep serving the ones the old one confirmed.
    await cli.reach(false)
    const offline = await service.refresh(targets, { now: NOW })
    assert.equal(offline.refresh.state, 'offline')
    assert.deepEqual(offline.items, [], 'an unreachable host does not hand back A rows')
    assert.notEqual(await cli.authority(), admitted)

    // And the credential that can read it again brings the rows back, so the
    // fence retired the queue rather than emptying it permanently.
    await cli.reach(true)
    await cli.deny(false)
    const recovered = await service.refresh(targets, { now: NOW })
    assert.equal(recovered.refresh.state, 'fresh')
    assert.equal(recovered.items.length, 1)

    // And the credential is consumed rather than reported: a request this build
    // made with a credential the CLI holds nothing for is refused by the CLI
    // itself, which is what makes the rows above readable as this profile's.
    const impostor = new GhGitHubTransport({
      env: { PATH: cli.path, GH_TOKEN: 'a-credential-this-cli-does-not-hold' },
      host: 'github.com',
    })
    await assert.rejects(
      impostor.graphql<{ viewer: { login: string } }>('{ viewer { login } }'),
      GitHubTransportError,
    )
    assert.equal(cli.presented().at(-1), 'a-credential-this-cli-does-not-hold')
  } finally {
    await cli.remove()
  }
})

test('the credential the child carries is the one its transport was given', async () => {
  const cli = await installSyntheticCli({
    host: 'github.com',
    material: 'scoped-b-material',
    body: answered(pullRequest()).body,
  })
  // Established after the scrub, and known on both sides: nothing either value
  // came from this machine. What this process carries for that host and what
  // the CLI's own store holds disagree, so what the child authenticated with
  // says which of the two this build signed its requests with.
  process.env[credentialEnvNames('github.com')[0]] = 'scoped-b-material'
  try {
    const ambient = new GhGitHubTransport({ env: { PATH: cli.path }, host: 'github.com' })
    assert.equal(
      (await ambient.graphql<{ viewer: { login: string } }>('{ viewer { login } }')).viewer.login,
      VIEWER,
    )
    assert.equal(
      cli.presented().at(-1),
      'scoped-b-material',
      "the child authenticated with this host's own credential, not the CLI's stored one",
    )
    // With nothing in this environment for that host, the child is handed the
    // CLI's own stored credential instead — the same transport, the same host,
    // and the request still answers.
    delete process.env[credentialEnvNames('github.com')[0]]
    assert.equal(
      (await ambient.graphql<{ viewer: { login: string } }>('{ viewer { login } }')).viewer.login,
      VIEWER,
    )
    assert.equal(
      cli.presented().at(-1),
      'scoped-b-material',
      "with no ambient credential of this host's, the CLI's own stored one is what it uses",
    )
  } finally {
    delete process.env[credentialEnvNames('github.com')[0]]
    await cli.remove()
  }
})

test('the same gh credential keeps its rows when the host stops answering', async () => {
  const cli = await installSyntheticCli({
    host: 'github.com',
    material: 'profile-a-material',
    body: answered(pullRequest()).body,
  })
  try {
    const service = new PullRequestInboxService(
      async () => `github.com|active|ada|ref-1\u0000${await cli.authority()}`,
    )
    const targets = [target('acme/app')]
    const confirmed = await service.refresh(targets, { now: NOW })
    assert.equal(confirmed.items.length, 1)
    const admitted = await cli.authority()

    // The host goes away. The credential has not changed, so the rows the last
    // read confirmed are still this credential's rows, and the queue keeps them
    // behind the reason rather than emptying itself. This is the case that a
    // read of the CLI's account status instead of its credential would get
    // wrong: a machine that cannot reach the host would report no profile, and
    // the rows would be retired on a network problem.
    await cli.reach(false)
    const offline = await service.refresh(targets, { now: NOW })
    assert.equal(offline.refresh.state, 'offline')
    assert.deepEqual(
      offline.items.map((item) => item.number),
      [1],
      'the last confirmed rows survive an unreachable host under the same credential',
    )
    assert.equal(offline.refresh.confirmedAt, confirmed.refresh.confirmedAt)

    // The credential is unchanged, which is why those rows were kept: the
    // identity a held answer belongs to has not moved.
    assert.equal(await cli.authority(), admitted)
  } finally {
    await cli.remove()
  }
})

test('two hosts on two accounts keep their own rows, and neither host fences the other', async () => {
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
    'ghe.example': { graphql: () => answered(pullRequest({ number: 12 }), 'grace') },
  })
  try {
    const report = await readPullRequestInbox(
      [target('acme/app'), target('acme/tools', '/repos/acme-tools', 'ghe.example')],
      { now: NOW },
    )
    assert.equal(report.refresh.state, 'fresh')
    // Two hosts are two accounts, so both repositories answer and the queue-level
    // login is withheld rather than naming one host's viewer for the other's rows.
    assert.equal(report.refresh.viewer, null)
    assert.deepEqual(
      report.refresh.repositories.map((entry) => entry.viewer),
      ['ada', 'grace'],
    )
    assert.deepEqual(report.items.map((item) => `${item.repository}#${item.number}`).sort(), [
      'acme/app#1',
      'acme/tools#12',
    ])
  } finally {
    api.restore()
  }
})

test('a repository registered while a read was resolving its origins retires that read', async () => {
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
  })
  try {
    let registered = [target('acme/app')]
    // The live list resolves asynchronously, exactly as it does for local Git:
    // a repository registered during that await must be visible to the
    // comparison, or the read would validate the list it started from.
    const currentTargets = async () => {
      await new Promise(setImmediate)
      return [...registered, target('acme/tools')]
    }
    const service = new PullRequestInboxService(() => 'stable', currentTargets)
    await assert.rejects(service.refresh(registered, { now: NOW }), CommandCancelled)
    // With the registration steady again the same read is publishable, so the
    // refusal above was the change and not the read path.
    const after = await service.refresh([...registered, target('acme/tools')], { now: NOW })
    assert.equal(after.refresh.state, 'fresh')
    assert.equal(api.calls.length > 0, true)
  } finally {
    api.restore()
  }
})

test('a cancelled read keeps neither a confirmed cache nor the rows it was reading', async () => {
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
  })
  try {
    const service = new PullRequestInboxService(() => 'stable')
    const targets = [target('acme/app')]
    const confirmed = await service.refresh(targets, { now: NOW })
    assert.equal(confirmed.items.length, 1)
    const controller = new AbortController()
    const gate = Promise.withResolvers<void>()
    api.behaviour['github.com'].graphql = async () => {
      await gate.promise
      return answered(pullRequest({ number: 9 }))
    }
    const pending = service.refresh(targets, { now: NOW, signal: controller.signal })
    // The read is genuinely in flight: it has asked the host and is waiting for
    // the answer that has not been given yet.
    while ((api.graphqlCalls['github.com'] ?? 0) < 2) await new Promise(setImmediate)
    controller.abort()
    gate.resolve()
    await assert.rejects(pending, CommandCancelled)
    // The abandoned answer is not what the queue now holds: a later refresh that
    // cannot answer falls back on the last read GitHub really confirmed, and
    // pull request #9 — the one this cancelled read produced — is not among them.
    Object.assign(api.behaviour['github.com'], { unreachable: true })
    const after = await service.refresh(targets, { now: NOW })
    assert.equal(after.refresh.state, 'offline')
    assert.deepEqual(
      after.items.map((item) => item.number),
      [1],
      'the cancelled read published nothing',
    )
  } finally {
    api.restore()
  }
})

test('a read cancelled while it asks for the identity one last time publishes nothing', async () => {
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
  })
  try {
    const targets = [target('acme/app')]
    let ask = 0
    const gate: { promise: Promise<void>; resolve: () => void } = {
      promise: Promise.resolve(),
      resolve: () => {},
    }
    let held = false
    // The identity is read before the read, and again after it. Only the last
    // one is held open here, so the cancel lands in the one window nothing else
    // covers: the read has its answer, the repositories still match, and the
    // signal arrives while the identity is still being asked for.
    const service = new PullRequestInboxService(async () => {
      ask += 1
      if (ask !== 2) return 'stable'
      held = true
      gate.promise = new Promise<void>((resolve) => {
        gate.resolve = resolve
      })
      await gate.promise
      return 'stable'
    })
    const controller = new AbortController()
    const pending = service.refresh(targets, { now: NOW, signal: controller.signal })
    while (!held) await new Promise(setImmediate)
    controller.abort()
    gate.resolve()
    await assert.rejects(pending, CommandCancelled)

    // Nothing was committed, so a later read that cannot answer falls back on
    // nothing rather than on the rows this abandoned read produced.
    Object.assign(api.behaviour['github.com'], { unreachable: true })
    const after = await service.refresh(targets, { now: NOW })
    assert.equal(after.refresh.state, 'offline')
    assert.deepEqual(after.items, [], 'the cancelled read published nothing')
    assert.equal(after.refresh.confirmedAt, null)
  } finally {
    api.restore()
  }
})

test('a normal repository read lowers this host’s allowance for the next queue read', async () => {
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
  })
  try {
    const first = await readPullRequestInbox([target('acme/app')], { now: NOW })
    assert.equal(first.refresh.state, 'fresh')
    // An ordinary repository read for the same host, through the same transport
    // every other read uses, reports almost nothing left. It happened after the
    // queue read raised the count, so it is the report that describes the window
    // the next request lands in.
    api.behaviour['github.com'].remaining = '3'
    await api.transport('github.com').rest({ path: 'rate_limit' })
    assert.equal(
      lastGitHubRateLimitFor('github.com').rateLimit.remaining,
      3,
      "the ordinary read published this host's own allowance",
    )
    const second = await readPullRequestInbox([target('acme/app')], { now: NOW })
    assert.equal(second.refresh.state, 'rate-limited')
    assert.equal(
      second.refresh.repositories[0]?.status,
      'rate-limited',
      'the reserve this host reported is what refuses the read',
    )
  } finally {
    api.restore()
  }
})

for (const primaryRefusal of [false, true]) {
  test(`a replacement credential admits its own Inbox without inheriting another account’s primary quota (${primaryRefusal ? 'primary refusal' : 'low successful response'})`, async () => {
    const reset = Math.floor((NOW + 3_600_000) / 1000)
    const api = installSynthetic({
      'github.com': {
        remaining: '3',
        reset,
        rest: () =>
          primaryRefusal
            ? {
                status: 403,
                body: { message: 'API rate limit exceeded' },
                headers: { 'x-ratelimit-remaining': '0' },
              }
            : { body: { full_name: 'acme/app' } },
        graphql: (_variables, _call, authorization) =>
          answered(
            pullRequest({
              number: 42,
              title: authorization.includes('second-sign-in')
                ? 'Replacement account work'
                : 'Previous account work',
            }),
          ),
      },
      'ghe.example.com': { remaining: '3', reset },
    })
    try {
      api.replaceCredential('github.com', 'first-sign-in')
      const service = new PullRequestInboxService(async () =>
        ['github.com|active|ada', await api.transport('github.com').credentialAuthority()].join(
          '\u0000',
        ),
      )
      const targets = [
        target('acme/app'),
        target('acme/enterprise', '/repos/enterprise', 'ghe.example.com'),
      ]
      await withOneClock(
        () => NOW,
        async () => {
          // Ordinary repository traffic observes the old account's primary window
          // before Inbox has made any request of its own.
          const ordinary = api.transport('github.com').rest({ path: 'repos/acme/app' })
          if (primaryRefusal)
            await assert.rejects(
              ordinary,
              (error: unknown) =>
                error instanceof GitHubTransportError && error.kind === 'rate-limited',
            )
          else await ordinary
          await api.transport('ghe.example.com').rest({ path: 'repos/acme/enterprise' })
          const before = api.calls.length
          const refused = await service.refresh(targets, { now: NOW, clock: () => NOW })
          assert.equal(refused.refresh.state, 'rate-limited')
          assert.deepEqual(refused.items, [])
          assert.equal(api.calls.length, before, 'unchanged credentials keep their primary reserve')

          api.replaceCredential('github.com', 'second-sign-in')
          api.behaviour['github.com'].remaining = '4998'
          delete api.behaviour['github.com'].rest
          const replacement = await service.refresh(targets, { now: NOW, clock: () => NOW })
          assert.deepEqual(
            replacement.items.map((item) => [item.number, item.title]),
            [[42, 'Replacement account work']],
            'the new account is admitted before the previous account’s window resets',
          )
          const statuses = new Map(
            replacement.refresh.repositories.map((entry) => [entry.repository, entry.status]),
          )
          assert.equal(statuses.get('acme/app'), 'ok')
          assert.equal(
            statuses.get('acme/enterprise'),
            'rate-limited',
            'replacing one host’s credential does not erase another host’s primary quota',
          )
          assert.equal(api.graphqlCalls['ghe.example.com'] ?? 0, 0)
        },
      )
    } finally {
      api.restore()
    }
  })
}

for (const primaryRefusal of [false, true]) {
  test(`a late primary quota response from a replaced credential cannot refuse the current Inbox (${primaryRefusal ? 'primary refusal' : 'low successful response'})`, async () => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    let holdFirstRequest = true
    const api = installSynthetic({
      'github.com': {
        rest: async (path) => {
          if (!holdFirstRequest) {
            return path.includes('/stacks') ? { body: [] } : { body: { full_name: 'acme/app' } }
          }
          holdFirstRequest = false
          started()
          await gate
          return {
            status: primaryRefusal ? 403 : 200,
            body: primaryRefusal
              ? { message: 'API rate limit exceeded' }
              : { full_name: 'acme/app' },
            headers: {
              'x-ratelimit-remaining': primaryRefusal ? '0' : '3',
              'x-ratelimit-reset': String(Math.floor((NOW + 3_600_000) / 1000)),
            },
          }
        },
        graphql: () => answered(pullRequest({ number: 43, title: 'Current account work' })),
      },
    })
    let abandoned: Promise<unknown> | undefined
    try {
      api.replaceCredential('github.com', 'first-sign-in')
      const service = new PullRequestInboxService(async () =>
        ['github.com|active|ada', await api.transport('github.com').credentialAuthority()].join(
          '\u0000',
        ),
      )
      await withOneClock(
        () => NOW,
        async () => {
          const ordinary = api.transport('github.com').rest({ path: 'repos/acme/app' })
          abandoned = primaryRefusal
            ? assert.rejects(
                ordinary,
                (error: unknown) =>
                  error instanceof GitHubTransportError && error.kind === 'rate-limited',
              )
            : ordinary
          await entered
          api.replaceCredential('github.com', 'second-sign-in')
          const targets = [target('acme/app')]
          const confirmed = await service.refresh(targets, { now: NOW, clock: () => NOW })
          assert.equal(confirmed.refresh.state, 'fresh')
          assert.deepEqual(
            confirmed.items.map((item) => item.title),
            ['Current account work'],
          )

          release()
          await abandoned
          const afterLateAnswer = await service.refresh(targets, { now: NOW, clock: () => NOW })
          assert.equal(afterLateAnswer.refresh.state, 'fresh')
          assert.deepEqual(
            afterLateAnswer.items.map((item) => [item.number, item.title]),
            [[43, 'Current account work']],
            'the old request’s spent primary window does not belong to this account',
          )
        },
      )
    } finally {
      release()
      await abandoned?.catch(() => {})
      api.restore()
    }
  })
}

test('native REST core allowance does not replace an explicit low GraphQL allowance', async () => {
  const reset = String(Math.floor((NOW + 3_600_000) / 1000))
  const api = installSynthetic({
    'github.com': {
      graphql: () => ({
        ...answered(pullRequest()),
        headers: {
          'x-ratelimit-resource': 'graphql',
          'x-ratelimit-remaining': '3',
          'x-ratelimit-reset': reset,
        },
      }),
      rest: (path) => ({
        body: path.includes('/stacks') ? [] : { full_name: 'acme/app' },
        headers: {
          'x-ratelimit-resource': 'core',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': reset,
        },
      }),
    },
  })
  try {
    await withOneClock(
      () => NOW,
      async () => {
        const targets = [target('acme/app')]
        const first = await readPullRequestInbox(targets, { now: NOW, clock: () => NOW })
        assert.equal(first.refresh.state, 'fresh')
        assert.equal(api.graphqlCalls['github.com'], 1)
        assert.ok(
          api.calls.some((call) => call.includes('/stacks?per_page=100')),
          'the native listing reports its healthy core allowance after the GraphQL answer',
        )
        const before = api.calls.length
        const second = await readPullRequestInbox(targets, { now: NOW, clock: () => NOW })
        assert.equal(second.refresh.state, 'rate-limited')
        assert.equal(second.refresh.repositories[0]?.status, 'rate-limited')
        assert.equal(api.graphqlCalls['github.com'], 1, 'the GraphQL reserve still blocks refresh')
        assert.equal(api.calls.length, before, 'the refused refresh sends no requests')
      },
    )
  } finally {
    api.restore()
  }
})

test('a low REST core allowance does not prevent the next GraphQL query', async () => {
  const reset = String(Math.floor((NOW + 3_600_000) / 1000))
  const api = installSynthetic({
    'github.com': {
      graphql: () => ({
        ...answered(pullRequest()),
        headers: {
          'x-ratelimit-resource': 'graphql',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': reset,
        },
      }),
      rest: (path) => ({
        body: path.includes('/stacks') ? [] : { full_name: 'acme/app' },
        headers: {
          'x-ratelimit-resource': 'core',
          'x-ratelimit-remaining': '3',
          'x-ratelimit-reset': reset,
        },
      }),
    },
  })
  try {
    await withOneClock(
      () => NOW,
      async () => {
        await api.transport('github.com').rest({ path: 'repos/acme/app' })
        const before = api.calls.length
        const report = await readPullRequestInbox([target('acme/app')], {
          now: NOW,
          clock: () => NOW,
        })
        assert.equal(api.graphqlCalls['github.com'], 1, 'core reserve does not refuse GraphQL')
        assert.deepEqual(
          report.items.map((item) => item.number),
          [1],
        )
        assert.equal(report.refresh.state, 'fresh')
        assert.equal(api.calls.length, before + 1, 'the core reserve still refuses native REST')
      },
    )
  } finally {
    api.restore()
  }
})

test('a secondary GraphQL refusal without wait headers blocks refresh for exactly one minute', async () => {
  const api = installSynthetic({
    'github.com': {
      graphql: (_variables, call) =>
        call === 0
          ? {
              status: 200,
              body: { errors: [{ message: 'You have exceeded a secondary rate limit' }] },
              headers: {
                'x-ratelimit-remaining': '4999',
                'x-ratelimit-reset': null,
                'retry-after': null,
              },
            }
          : answered(pullRequest()),
    },
  })
  try {
    let moment = NOW
    const clock = (): number => moment
    await withOneClock(clock, async () => {
      const targets = [target('acme/app')]
      const first = await readPullRequestInbox(targets, { now: moment, clock })
      assert.equal(first.refresh.state, 'rate-limited')
      assert.equal(api.graphqlCalls['github.com'], 1)
      const before = api.calls.length
      const immediate = await readPullRequestInbox(targets, { now: moment, clock })
      assert.equal(immediate.refresh.state, 'rate-limited')
      assert.equal(api.calls.length, before, 'an immediate refresh respects the fallback wait')

      moment = NOW + 59_999
      const early = await readPullRequestInbox(targets, { now: moment, clock })
      assert.equal(early.refresh.state, 'rate-limited')
      assert.equal(api.calls.length, before, 'the fallback wait has not yet expired')

      moment = NOW + 60_000
      const released = await readPullRequestInbox(targets, { now: moment, clock })
      assert.equal(released.refresh.state, 'fresh')
      assert.equal(api.graphqlCalls['github.com'], 2, 'GraphQL is queried at the wait boundary')
      assert.deepEqual(
        released.items.map((item) => item.number),
        [1],
      )
    })
  } finally {
    api.restore()
  }
})

test("one account refusing late, after the account that replaced it answered, is that account's answer alone", async () => {
  for (const refusal of ['primary', 'secondary'] as const) {
    const late = Promise.withResolvers<void>()
    const api = installSynthetic({
      'github.com': {
        graphql: async (_variables, call) => {
          // The first read of the refresh is the account that is about to be
          // replaced; it is refused, and refused after the replacement has
          // already been answered.
          if (call !== 0) return answered(pullRequest())
          await late.promise
          return refusal === 'primary'
            ? {
                status: 403,
                body: { message: 'API rate limit exceeded' },
                headers: {
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': null,
                  'retry-after': '600',
                },
              }
            : {
                status: 200,
                body: { errors: [{ message: 'You have exceeded a secondary rate limit' }] },
                headers: {
                  'x-ratelimit-remaining': '4998',
                  'x-ratelimit-reset': null,
                  'retry-after': null,
                },
              }
        },
      },
    })
    try {
      let moment = NOW
      const clock = (): number => moment
      await withOneClock(clock, async () => {
        const targets = [target('acme/app')]
        const held = readPullRequestInbox(targets, { now: moment, clock })
        await new Promise((resolve) => setImmediate(resolve))
        // The account behind this host is replaced while the first read is still
        // in flight, and the replacement answers first.
        api.replaceCredential('github.com', 'replacement-token')
        const answering = readPullRequestInbox(targets, { now: moment, clock })
        await answering
        moment += 1_000
        late.resolve()
        await held

        if (refusal === 'primary') {
          // A primary window belongs to the account GitHub counted, so this host
          // is asked again: the replacement never spent it.
          assert.equal(
            githubRetryDeadlineFor('github.com'),
            null,
            "one account's exhausted window was made the whole host's wait",
          )
          const before = api.graphqlCalls['github.com'] ?? 0
          const again = await readPullRequestInbox(targets, { now: moment, clock })
          assert.notEqual(
            again.refresh.repositories[0]?.status,
            'rate-limited',
            'the host was reported as refusing an account that was not refused',
          )
          assert.equal(
            api.graphqlCalls['github.com'],
            before + 1,
            'the account that replaced the refused one was not admitted',
          )
          assert.deepEqual(
            again.items.map((item) => item.repository),
            ['acme/app'],
            'the answering account lost its rows to the refusal behind it',
          )
        } else {
          // A secondary limit is this host refusing everyone at once, so it binds
          // whoever asks next, including the account that replaced the one that
          // met it.
          const until = githubRetryDeadlineFor('github.com')
          assert.ok(until !== null && until > moment, 'a secondary refusal left this host no wait')
          const before = api.graphqlCalls['github.com'] ?? 0
          const again = await readPullRequestInbox(targets, { now: moment, clock })
          assert.equal(again.refresh.repositories[0]?.status, 'rate-limited')
          assert.equal(
            api.graphqlCalls['github.com'],
            before,
            'the host was asked again inside a wait it named',
          )
        }
      })
    } finally {
      api.restore()
    }
  }
})

test("a host refusing late, after another host answered, keeps that host's rows and its own wait", async () => {
  // The slow host is the one that refuses, and it refuses with the secondary limit
  // that names no moment: a fixed wait the app decides, not one the host reported.
  const late = Promise.withResolvers<void>()
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
    'ghe.example': {
      graphql: async () => {
        // The other host has answered by now, so this refusal lands after that
        // host's rows are already in the refresh being built.
        await late.promise
        return {
          status: 200,
          body: { errors: [{ message: 'You have exceeded a secondary rate limit' }] },
          headers: {
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-reset': null,
            'retry-after': null,
          },
        }
      },
    },
  })
  try {
    let moment = NOW
    const clock = (): number => moment
    await withOneClock(clock, async () => {
      const targets = [target('acme/app'), target('acme/tools', '/repos/acme-tools', 'ghe.example')]
      const refreshing = readPullRequestInbox(targets, { now: moment, clock })
      // The refusing host is released only once the answering host has served its
      // rows, which is the ordering this case is about.
      await new Promise((resolve) => setImmediate(resolve))
      late.resolve()
      const report = await refreshing

      // The host that answered still holds the rows it answered with: a refusal on
      // one host is that host's, and does not retract the other's current report.
      assert.deepEqual(
        report.items.map((item) => item.repository),
        ['acme/app'],
        "the answering host's rows were lost with the other host's refusal",
      )
      const refused = report.refresh.repositories.find((entry) => entry.host === 'ghe.example')
      assert.equal(refused?.status, 'rate-limited', 'the refusing host is not reported as refusing')
      assert.equal(refused?.viewer, null, 'a refused host names no account')

      // And the wait belongs to the host that asked for it: the next refresh is
      // still refused for that host, while the answering host is read again.
      const before = api.graphqlCalls['github.com'] ?? 0
      const asking = api.graphqlCalls['ghe.example'] ?? 0
      const again = await readPullRequestInbox(targets, { now: moment, clock })
      // One host is paused and one answered, which is a partial refresh naming
      // which is which rather than an empty one.
      assert.equal(again.refresh.state, 'partial')
      assert.equal(
        again.refresh.repositories.find((entry) => entry.host === 'ghe.example')?.status,
        'rate-limited',
        'the waiting host was read again inside its own wait',
      )
      assert.equal(
        api.graphqlCalls['ghe.example'] ?? 0,
        asking,
        'the cached deadline for that host did not refuse the request',
      )
      assert.equal(
        api.graphqlCalls['github.com'],
        before + 1,
        'the waiting host kept the other host from being read',
      )
      assert.deepEqual(
        again.items.map((item) => item.repository),
        ['acme/app'],
        "the answering host lost its rows to the other host's wait",
      )
    })
  } finally {
    api.restore()
  }
})

test('a host that names a wait is left alone until then, on every refresh', async () => {
  const api = installSynthetic({
    'github.com': {
      // The host's own answer to the first question, with the wait it named.
      graphql: () => ({
        status: 429,
        body: { message: 'secondary rate limit' },
        headers: { 'retry-after': '600' },
      }),
    },
  })
  try {
    // One clock behind the read and the answer it dates: a wait a host names
    // runs from the moment that answer arrived, and only the same clock says
    // whether it has passed.
    let moment = Date.now()
    const clock = (): number => moment
    await withOneClock(clock, async () => {
      const first = await readPullRequestInbox([target('acme/app')], { now: moment, clock })
      assert.equal(first.refresh.state, 'rate-limited')
      const before = api.calls.length
      // The refresh that met the refusal kept no rows, so there is nothing to
      // retry against; the server's own wait still stands.
      moment += 1000
      const immediate = await readPullRequestInbox([target('acme/app')], { now: moment, clock })
      assert.equal(immediate.refresh.state, 'rate-limited')
      assert.equal(api.calls.length, before, 'no request was made inside the wait')
      assert.match(String(immediate.refresh.repositories[0]?.detail), /asked to be left alone/u)
      // Past the wait the host is asked again, and this scripted host refuses
      // again because that is what it is scripted to do. What matters is that the
      // question was put rather than assumed.
      moment += 600_001
      await readPullRequestInbox([target('acme/app')], { now: moment, clock })
      assert.ok(api.calls.length > before, 'the host was asked again once its wait passed')
    })
  } finally {
    api.restore()
  }
})

test('an allowance whose window has closed never masks the one that is still open', async () => {
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
  })
  try {
    const targets = [target('acme/app')]
    const opened = Date.now()

    // An ordinary read for this host opens the window and leaves almost the
    // whole allowance in it, so the queue is admitted and can record its own
    // observation of the same host.
    Object.assign(api.behaviour['github.com'], {
      remaining: '4998',
      reset: Math.floor((opened + 3_600_000) / 1000),
    })
    await api.transport('github.com').rest({ path: 'rate_limit' })
    const first = await readPullRequestInbox(targets, { now: opened })
    assert.equal(first.refresh.state, 'fresh')

    // The window this queue recorded has since closed: the count in it was true
    // of a window that ended, and says nothing about what is left in the one
    // that is open now. The observation is stamped later than any ordinary
    // read's, so it is the newer of the two reports, which is what used to let
    // it win.
    Object.assign(api.behaviour['github.com'], {
      remaining: '4998',
      reset: Math.floor((opened - 60_000) / 1000),
    })
    await readPullRequestInbox(targets, { now: opened, clock: () => opened + 120_000 })

    // An ordinary read now reports three requests left, in a window that has
    // not closed. That is the only live evidence about this host.
    Object.assign(api.behaviour['github.com'], {
      remaining: '3',
      reset: Math.floor((opened + 7_200_000) / 1000),
    })
    await api.transport('github.com').rest({ path: 'rate_limit' })
    assert.equal(lastGitHubRateLimitFor('github.com').rateLimit.remaining, 3)

    const second = await readPullRequestInbox(targets, {
      now: opened + 180_000,
      clock: () => opened + 180_000,
    })
    assert.equal(
      second.refresh.repositories[0]?.status,
      'rate-limited',
      'the reserve in the window that is still open is what refuses this read',
    )
    assert.equal(second.refresh.state, 'rate-limited')
  } finally {
    api.restore()
  }
})

test('a wait runs from the answer that carried it, not from the start of the read', async () => {
  const gate = Promise.withResolvers<void>()
  const api = installSynthetic({
    'github.com': {
      graphql: async () => {
        await gate.promise
        return {
          status: 429,
          body: { message: 'secondary rate limit' },
          headers: { 'retry-after': '600' },
        }
      },
    },
  })
  try {
    // This read spends twenty minutes before the host answers it, which is what
    // makes the difference between the two moments observable: the wait is ten
    // minutes long, so dating it from the request would have it expire four
    // hundred seconds before the host said to return.
    let observedAt = NOW
    const clock = (): number => observedAt
    await withOneClock(clock, async () => {
      const pending = readPullRequestInbox([target('acme/app')], { now: NOW, clock })
      while ((api.graphqlCalls['github.com'] ?? 0) === 0) await new Promise(setImmediate)
      observedAt = NOW + 1_200_000
      gate.resolve()
      assert.equal((await pending).refresh.state, 'rate-limited')
      const before = api.calls.length

      // Ten minutes after the read began, eight before the host's answer
      // carried its wait: the wait runs from that answer, so this is still
      // inside it and asking now would ask too early.
      observedAt = NOW + 1_260_000
      const early = await readPullRequestInbox([target('acme/app')], { now: observedAt, clock })
      assert.equal(early.refresh.state, 'rate-limited')
      assert.equal(api.calls.length, before, 'no request was made inside the wait')
    })
  } finally {
    api.restore()
  }
})

test('a refusal that names only a reset still says when to come back', async () => {
  const reset = Math.floor((Date.now() + 600_000) / 1000)
  const api = installSynthetic({
    'github.com': {
      // No remaining counter and no Retry-After: the moment the primary window
      // resets is the whole of what this host said.
      graphql: () => ({
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': null, 'x-ratelimit-reset': String(reset) },
      }),
    },
  })
  try {
    const first = await readPullRequestInbox([target('acme/app')], { now: Date.now() })
    assert.equal(first.refresh.state, 'rate-limited')
    const before = api.calls.length
    const second = await readPullRequestInbox([target('acme/app')], { now: Date.now() + 1000 })
    assert.equal(second.refresh.state, 'rate-limited')
    assert.equal(
      api.calls.length,
      before,
      'a reset moment named on its own still keeps the next refresh away',
    )
  } finally {
    api.restore()
  }
})

test('a refusal an ordinary read met delays the next queue read too', async () => {
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
  })
  try {
    // An ordinary repository read for this host — not the queue's — is the one
    // the host refuses. The wait belongs to the host, not to the read that met
    // it, and the queue has confirmed nothing yet.
    Object.assign(api.behaviour['github.com'], {
      rest: () => ({
        status: 429,
        body: { message: 'secondary rate limit' },
        headers: { 'retry-after': '600' },
      }),
    })
    await assert.rejects(
      api.transport('github.com').rest({ path: 'rate_limit' }),
      GitHubTransportError,
    )
    const before = api.calls.length
    const refused = await readPullRequestInbox([target('acme/app')], { now: Date.now() })
    assert.equal(refused.refresh.state, 'rate-limited')
    assert.equal(
      api.calls.length,
      before,
      'the queue did not ask a host that just asked to be left alone',
    )
  } finally {
    api.restore()
  }
})

test('a read this build could not classify is reported as attempted and failed', async () => {
  const api = installSynthetic({
    'github.com': {
      // A server error: the request was made, and the host answered with
      // something that is not a verdict about access or quota.
      graphql: () => ({ status: 500, body: { message: 'internal server error' } }),
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    const repository = report.refresh.repositories[0]
    assert.equal(repository?.status, 'failed')
    assert.notEqual(repository?.status, 'skipped', 'the read was attempted')
    assert.match(String(repository?.detail), /internal server error/u)
    // What the host said is what the notice says: a queue that read nothing
    // because every repository failed says why each one failed.
    assert.match(report.refresh.detail, /internal server error/u)
    assert.match(report.refresh.detail, /acme\/app/u)
  } finally {
    api.restore()
  }
})

test('a host that names no account leaves the viewer-relative groups undecided, and says so', async () => {
  const api = installSynthetic({
    'github.com': {
      // The pull request is this account's own, and this account is the one
      // whose review was requested, so a read that knew the account would file
      // it under the groups that depend on that. This answer names no account.
      graphql: () => answered(pullRequest({ author: VIEWER }), null),
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    // The row is real and it is returned: GitHub did answer with it.
    assert.equal(report.items.length, 1)
    assert.equal(report.items[0]?.number, 1)
    // Whose work it is could not be established, so every group that depends on
    // that is left undecided rather than decided against a person this read
    // could not name. With this row's facts, that is all of them.
    assert.deepEqual(report.items[0]?.groups, [])

    // The repository report says so, in the words the queue shows, and the
    // refresh is partial rather than empty: something was read.
    const repository = report.refresh.repositories[0]
    assert.equal(repository?.status, 'membership-unknown')
    assert.equal(repository?.viewer, null)
    assert.match(String(repository?.detail), /named no signed-in account/u)
    assert.equal(report.refresh.state, 'partial')
    assert.equal(report.refresh.confirmedAt, new Date(NOW).toISOString())
    assert.match(
      report.refresh.detail,
      /acme\/app \(read without knowing whose queue this is\)/u,
      'the notice names the repository and the reason it was read with less',
    )
  } finally {
    api.restore()
  }
})

test('a wait an ordinary read met survives the next successful read of that host', async () => {
  const api = installSynthetic({
    'github.com': { graphql: () => answered(pullRequest()) },
  })
  try {
    // An ordinary repository read, not the queue's, is the one the host refuses.
    Object.assign(api.behaviour['github.com'], {
      rest: () => ({
        status: 429,
        body: { message: 'secondary rate limit' },
        headers: { 'retry-after': '600' },
      }),
    })
    await assert.rejects(
      api.transport('github.com').rest({ path: 'rate_limit' }),
      GitHubTransportError,
    )
    // The host answers the next ordinary read, so what is left of its budget is
    // reported afresh. That answer says what the window holds, not when the
    // host is willing to be asked again, so it must not end the wait.
    Object.assign(api.behaviour['github.com'], {
      rest: () => ({ body: { full_name: 'acme/app' } }),
    })
    await api.transport('github.com').rest({ path: 'repos/acme/app' })
    assert.equal(lastGitHubRateLimitFor('github.com').rateLimit.remaining, 4998)

    const before = api.calls.length
    const refused = await readPullRequestInbox([target('acme/app')])
    assert.equal(refused.refresh.state, 'rate-limited')
    assert.equal(
      api.calls.length,
      before,
      'the queue did not ask a host that is still inside a wait it named',
    )
  } finally {
    api.restore()
  }
})

test('a repository the credential cannot see does not park the host for the hour', async () => {
  const api = installSynthetic({
    'github.com': {
      remaining: '4998',
      reset: Math.floor((Date.now() + 3_600_000) / 1000),
      graphql: (variables) =>
        variables.name === 'hidden'
          ? { status: 403, body: { message: 'Resource not accessible by personal access token' } }
          : answered(pullRequest()),
    },
  })
  try {
    const targets = [target('acme/hidden'), target('acme/visible')]
    const first = await readPullRequestInbox(targets)
    const status = new Map(
      first.refresh.repositories.map((entry) => [entry.repository, entry.status]),
    )
    // The repository the credential cannot see is reported as such, and the
    // refusal is a fact about that repository: the other one is on the same host
    // and is read.
    assert.equal(status.get('acme/hidden'), 'forbidden')
    assert.equal(status.get('acme/visible'), 'ok')
    // The quota headers that came with that refusal describe the window, not an
    // instruction to stop asking the host, so the next refresh reads the
    // repository it could always read.
    const second = await readPullRequestInbox(targets)
    const again = new Map(
      second.refresh.repositories.map((entry) => [entry.repository, entry.status]),
    )
    assert.equal(again.get('acme/visible'), 'ok')
  } finally {
    api.restore()
  }
})

test('a host reached after a slow read is admitted against the window open then', async () => {
  const gate = Promise.withResolvers<void>()
  const opened = Date.now()
  const api = installSynthetic({
    // The first host answers slowly, and the second host's window closes while
    // this read is still waiting on the first one.
    'github.com': {
      graphql: async () => {
        await gate.promise
        return answered(pullRequest())
      },
    },
    'ghe.example.com': { remaining: '3', reset: Math.floor((opened + 5_000) / 1000) },
  })
  try {
    let moment = opened
    const clock = (): number => moment
    await withOneClock(clock, async () => {
      // The second host's allowance is published by an ordinary read before
      // anything is in flight, so this case is about the window that report
      // belongs to rather than about a host that has said nothing yet: without
      // it the queue would admit that host whatever the clock said, and a stale
      // admission taken at the start of the read would pass here too.
      await api.transport('ghe.example.com').rest({ path: 'rate_limit' })
      assert.equal(lastGitHubRateLimitFor('ghe.example.com').rateLimit.remaining, 3)
      const before = api.calls.length
      const inside = await readPullRequestInbox(
        [target('acme/enterprise', '/repos/enterprise', 'ghe.example.com')],
        { now: opened, clock },
      )
      assert.equal(
        inside.refresh.repositories[0]?.status,
        'rate-limited',
        'an open window with three requests left refuses the queue',
      )
      assert.equal(api.calls.length, before, 'and it refuses it without asking')

      const pending = readPullRequestInbox(
        [target('acme/app'), target('acme/enterprise', '/repos/enterprise', 'ghe.example.com')],
        { now: opened, clock },
      )
      while ((api.graphqlCalls['github.com'] ?? 0) === 0) await new Promise(setImmediate)
      // Eight seconds later the second host's window has closed, so the count in
      // it no longer describes what that host will answer.
      moment = opened + 8_000
      gate.resolve()
      const report = await pending
      const status = new Map(
        report.refresh.repositories.map((entry) => [entry.repository, entry.status]),
      )
      assert.equal(
        status.get('acme/enterprise'),
        'ok',
        'a window that closed while this read waited is not evidence about this host now',
      )
    })
  } finally {
    api.restore()
  }
})

test('an ordinary read rate refusal on a custom base refuses the first queue read there', async () => {
  const api = installSynthetic({
    // HTTP 200 whose body is the refusal: the envelope succeeded, the answer did
    // not, and this is the queue's own host read by something that is not the
    // queue. No queue read has happened, so nothing this refresh charged can be
    // the reason the next one is kept away.
    'ghe.example.com': {
      graphql: () => ({
        status: 200,
        body: { errors: [{ message: 'You have exceeded a secondary rate limit' }] },
        headers: { 'retry-after': '600' },
      }),
    },
  })
  try {
    await assert.rejects(
      api.transport('ghe.example.com').graphql('{ viewer { login } }'),
      GitHubTransportError,
    )
    const before = api.calls.length
    const refused = await readPullRequestInbox(
      [target('acme/enterprise', '/repos/enterprise', 'ghe.example.com')],
      { now: Date.now() },
    )
    assert.equal(refused.refresh.repositories[0]?.status, 'rate-limited')
    assert.equal(refused.refresh.state, 'rate-limited')
    assert.equal(
      api.calls.length,
      before,
      'the queue did not ask a base that had already asked to be left alone',
    )
    assert.match(
      String(refused.refresh.repositories[0]?.detail),
      /ghe\.example\.com asked to be left alone/u,
    )
  } finally {
    api.restore()
  }
})

test('a base pointed at another host is admitted on the host that answers, not the one the origin names', async () => {
  resetGitHubRateLimit()
  resetInboxHostAllowances()
  // An operator pointed this build's public base at an enterprise server, so a
  // github.com repository is answered by that server and metered on it. Only
  // the far side of the CLI is a fixture: the status line, the headers and the
  // body are what a server refusing a quota sends, and the refusal is what
  // publishes the wait the queue then has to believe.
  const destination = 'ghe.example.com:8443'
  const asked: string[][] = []
  const transport = new GhGitHubTransport({
    host: 'github.com',
    apiUrl: `https://${destination}/api/v3`,
    graphqlUrl: `https://${destination}/api/graphql`,
    run: async (args) => {
      asked.push(args)
      return [
        'HTTP/2.0 429 Too Many Requests',
        'content-type: application/json; charset=utf-8',
        'x-ratelimit-limit: 5000',
        'x-ratelimit-remaining: 3',
        'x-ratelimit-reset: 1780000000',
        'retry-after: 600',
        '',
        '{"message":"secondary rate limit"}',
      ].join('\r\n')
    },
  })
  setGitHubHostTransport('github.com', transport)
  try {
    assert.equal(
      transport.destinationHost,
      destination,
      'the base names the host these requests are metered on',
    )
    await assert.rejects(
      transport.graphql<{ viewer: { login: string } }>('{ viewer { login } }'),
      GitHubTransportError,
    )
    assert.equal(lastGitHubRateLimitFor(destination).rateLimit.remaining, 3)
    assert.equal(lastGitHubRateLimitFor('github.com').at, 0)

    const before = asked.length
    const refused = await readPullRequestInbox([target('acme/app')], { now: Date.now() })
    assert.equal(refused.refresh.repositories[0]?.status, 'rate-limited')
    assert.equal(refused.refresh.state, 'rate-limited')
    assert.equal(
      asked.length,
      before,
      'the queue asked a server whose reserve and wait were already published',
    )
    assert.match(
      String(refused.refresh.repositories[0]?.detail),
      new RegExp(`${destination} asked to be left alone`, 'u'),
    )
    // The row is still filed under the host the repository's origin named: what
    // the queue shows about a repository is not relabelled by where this build
    // was pointed.
    assert.equal(refused.refresh.repositories[0]?.host, 'github.com')
  } finally {
    setGitHubHostTransport('github.com', null)
    resetGitHubRateLimit()
    resetInboxHostAllowances()
  }
})

test('a wait named inside a successful response runs from that answer', async () => {
  const gate = Promise.withResolvers<void>()
  const opened = Date.now()
  const api = installSynthetic({
    'github.com': {
      // HTTP 200 with a rate-limit refusal in the body: the envelope is a
      // success and the answer is not.
      graphql: async () => {
        await gate.promise
        return {
          status: 200,
          body: { errors: [{ message: 'You have exceeded a secondary rate limit' }] },
          headers: { 'retry-after': '600' },
        }
      },
    },
  })
  try {
    let moment = opened
    const clock = (): number => moment
    await withOneClock(clock, async () => {
      const pending = readPullRequestInbox([target('acme/app')], { now: opened, clock })
      while ((api.graphqlCalls['github.com'] ?? 0) === 0) await new Promise(setImmediate)
      // Twenty minutes later the answer arrives and names a ten minute wait, so
      // it runs until thirty minutes after the refresh began.
      moment = opened + 1_200_000
      gate.resolve()
      assert.equal((await pending).refresh.state, 'rate-limited')
      const before = api.calls.length

      // Twenty-five minutes in, the wait is still running. Dated from the request
      // instead of the answer, it would have expired four minutes ago.
      moment = opened + 1_500_000
      const inside = await readPullRequestInbox([target('acme/app')], { now: moment, clock })
      assert.equal(inside.refresh.state, 'rate-limited')
      assert.equal(api.calls.length, before, 'no request was made inside the wait')

      // And it is honoured to its end rather than to the end of the request's
      // own guess: one second after it passes, the host is asked again.
      moment = opened + 1_800_001
      await readPullRequestInbox([target('acme/app')], { now: moment, clock })
      assert.ok(api.calls.length > before, 'the host is asked again once that wait passes')
    })
  } finally {
    api.restore()
  }
})

test('a window belongs to the account that spent it: a replacement is admitted, and it is still waiting when it returns', async () => {
  const api = installSynthetic({
    'github.com': {
      rest: () => ({
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor((NOW + 3_600_000) / 1000)),
          'retry-after': '60',
        },
      }),
      graphql: () => answered(pullRequest({ number: 45, title: 'Replacement after short wait' })),
    },
  })
  try {
    api.replaceCredential('github.com', 'first-sign-in')
    let moment = NOW
    const clock = () => moment
    await withOneClock(clock, async () => {
      await assert.rejects(
        api.transport('github.com').rest({ path: 'repos/acme/app' }),
        GitHubTransportError,
      )
      // The account behind this host is replaced, and the replacement is asked
      // inside the window the previous one spent: a window is measured against
      // one account, and this one never spent anything.
      api.replaceCredential('github.com', 'second-sign-in')
      delete api.behaviour['github.com'].rest
      const admitted = await readPullRequestInbox([target('acme/app')], { now: moment, clock })
      assert.equal(admitted.refresh.state, 'fresh')
      assert.deepEqual(
        admitted.items.map((item) => [item.number, item.title]),
        [[45, 'Replacement after short wait']],
      )

      // The account that did spend it is still inside its own window if it comes
      // back, and is asked for nothing until the window GitHub named has passed:
      // a window with nothing left in it lasts until it resets, and the sixty
      // seconds are the floor of that, not its length.
      api.replaceCredential('github.com', 'first-sign-in')
      const before = api.calls.length
      moment = NOW + 3_599_999
      const inside = await readPullRequestInbox([target('acme/app')], { now: moment, clock })
      assert.equal(inside.refresh.state, 'rate-limited')
      assert.deepEqual(inside.items, [])
      assert.equal(api.calls.length, before, 'the account still inside its own window was asked')
      moment = NOW + 3_600_001
      const released = await readPullRequestInbox([target('acme/app')], { now: moment, clock })
      assert.notEqual(
        released.refresh.repositories[0]?.status,
        'rate-limited',
        'the window outlived the reset that ends it',
      )
      assert.ok(api.calls.length > before, 'the account was not asked once its own window passed')
    })
  } finally {
    api.restore()
  }
})

test('a headerless GraphQL primary refusal stops only its own principal for the current refresh', async () => {
  const api = installSynthetic({
    'github.com': {
      graphql: () => ({
        status: 200,
        body: { errors: [{ message: 'API rate limit exceeded' }] },
        headers: { 'x-ratelimit-remaining': null, 'x-ratelimit-reset': null },
      }),
    },
    'ghe.example.com': {
      graphql: () => answered(pullRequest({ number: 46, title: 'Other principal work' })),
    },
  })
  try {
    process.env[credentialEnvNames('github.com')[0]] = 'principal-a'
    process.env[credentialEnvNames('ghe.example.com')[0]] = 'principal-b'
    setGitHubHostTransport(
      'ghe.example.com',
      servedBy(api.transport('ghe.example.com'), 'github.com'),
    )
    await withOneClock(
      () => NOW,
      async () => {
        const report = await readPullRequestInbox(
          [
            target('acme/app'),
            target('acme/second'),
            target('acme/enterprise', '/repos/enterprise', 'ghe.example.com'),
          ],
          { now: NOW, clock: () => NOW },
        )
        const statuses = new Map(
          report.refresh.repositories.map((entry) => [entry.repository, entry.status]),
        )
        assert.equal(statuses.get('acme/app'), 'rate-limited')
        assert.equal(api.graphqlCalls['github.com'], 1)
        assert.equal(
          statuses.get('acme/enterprise'),
          'ok',
          'the other principal on the serving host is still admitted',
        )
        assert.deepEqual(
          report.items.map((item) => [item.number, item.title]),
          [[46, 'Other principal work']],
        )

        // No reset or Retry-After named a persistent wait: the next refresh may
        // ask the same principal again.
        api.behaviour['github.com'].graphql = () =>
          answered(pullRequest({ number: 47, title: 'Retry without a deadline' }))
        const next = await readPullRequestInbox([target('acme/app')], {
          now: NOW,
          clock: () => NOW,
        })
        assert.equal(next.refresh.state, 'fresh')
        assert.deepEqual(
          next.items.map((item) => item.title),
          ['Retry without a deadline'],
        )
      },
    )
  } finally {
    api.restore()
  }
})

test('optional counts use the same bounded read and distinguish zero, truncation and missing facts', async () => {
  const api = installSynthetic({
    'github.com': {
      graphql: () => ({
        body: {
          data: {
            viewer: { login: VIEWER },
            repository: {
              open: connection([
                pullRequest({ additions: 0, deletions: 0, reviewThreads: connection([]) }),
                pullRequest({
                  number: 2,
                  additions: 10,
                  deletions: 5,
                  reviewThreads: connection([{ isResolved: false }, { isResolved: true }], true),
                }),
                pullRequest({ number: 3, additions: null, deletions: 4, reviewThreads: null }),
                pullRequest({
                  number: 4,
                  reviewThreads: connection([{ isResolved: false }, { isResolved: null }]),
                }),
                pullRequest({ number: 5, reviewThreads: { nodes: [{ isResolved: false }] } }),
              ]),
              merged: connection([]),
            },
          },
        },
      }),
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    assert.equal(api.graphqlCalls['github.com'], 1, 'counts do not add per-row requests')
    assert.deepEqual(report.items.find((item) => item.number === 1)?.changeSize, {
      state: 'known',
      value: 0,
    })
    assert.deepEqual(report.items.find((item) => item.number === 1)?.unresolvedThreads, {
      state: 'known',
      value: 0,
    })
    assert.deepEqual(report.items.find((item) => item.number === 2)?.changeSize, {
      state: 'known',
      value: 15,
    })
    assert.deepEqual(report.items.find((item) => item.number === 2)?.unresolvedThreads, {
      state: 'truncated',
      value: 1,
    })
    assert.deepEqual(report.items.find((item) => item.number === 3)?.changeSize, {
      state: 'unknown',
    })
    assert.deepEqual(report.items.find((item) => item.number === 3)?.unresolvedThreads, {
      state: 'unknown',
    })
    for (const number of [4, 5]) {
      assert.deepEqual(report.items.find((item) => item.number === number)?.unresolvedThreads, {
        state: 'unknown',
      })
    }
    assert.equal(report.refresh.requests, api.calls.length)
  } finally {
    api.restore()
  }
})

test('refusing optional count schema retains original review membership and reports unsupported counts', async () => {
  const api = installSynthetic({
    'github.com': {
      graphql: (_variables, call) =>
        call === 0
          ? {
              body: {
                errors: [{ message: 'Cannot query field "reviewThreads" on type "PullRequest"' }],
              },
            }
          : answered(
              pullRequest({
                author: { login: VIEWER },
                reviewDecision: 'APPROVED',
                reviewRequests: { nodes: [] },
              }),
            ),
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    assert.equal(api.graphqlCalls['github.com'], 2)
    assert.equal(report.items[0]?.metadata, 'full')
    assert.deepEqual(report.items[0]?.groups, ['my-prs-approved'])
    assert.deepEqual(report.items[0]?.changeSize, { state: 'unsupported' })
    assert.deepEqual(report.items[0]?.unresolvedThreads, { state: 'unsupported' })
    assert.equal(report.refresh.requests, api.calls.length)
  } finally {
    api.restore()
  }
})

test('raw optional fact payloads distinguish confirmed absence from unreadable facts in structured predicates', async () => {
  const cases: {
    override: Record<string, unknown>
    criteria: PullRequestInboxFilter['criteria']
    expected: 'match' | 'excluded' | 'unknown'
  }[] = [
    {
      override: { commits: { nodes: [null] } },
      criteria: { checks: ['none'] },
      expected: 'unknown',
    },
    {
      override: { commits: { nodes: [{ commit: {} }] } },
      criteria: { checks: ['none'] },
      expected: 'unknown',
    },
    {
      override: { commits: { nodes: [{ commit: { statusCheckRollup: {} } }] } },
      criteria: { checks: ['none'] },
      expected: 'unknown',
    },
    { override: { commits: { nodes: [] } }, criteria: { checks: ['none'] }, expected: 'match' },
    {
      override: { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
      criteria: { checks: ['none'] },
      expected: 'match',
    },
    {
      override: { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } },
      criteria: { checks: ['pending'] },
      expected: 'match',
    },
    { override: { reviewDecision: '' }, criteria: { reviews: ['none'] }, expected: 'unknown' },
    {
      override: { reviewDecision: 'UNRECOGNIZED' },
      criteria: { reviews: ['none'] },
      expected: 'unknown',
    },
    {
      override: { reviewDecision: undefined },
      criteria: { reviews: ['none'] },
      expected: 'unknown',
    },
    { override: { reviewDecision: null }, criteria: { reviews: ['none'] }, expected: 'match' },
    {
      override: { reviewDecision: 'APPROVED' },
      criteria: { reviews: ['APPROVED'] },
      expected: 'match',
    },
    {
      override: { reviewRequests: { nodes: null, pageInfo: { hasNextPage: false } } },
      criteria: { reviewers: ['Grace'] },
      expected: 'unknown',
    },
    {
      override: { reviewRequests: { pageInfo: { hasNextPage: false } } },
      criteria: { reviewers: ['Grace'] },
      expected: 'unknown',
    },
    {
      override: { reviewRequests: connection([null]) },
      criteria: { reviewers: ['Grace'] },
      expected: 'unknown',
    },
    {
      override: { reviewRequests: connection([{ requestedReviewer: { __typename: 'User' } }]) },
      criteria: { reviewers: ['Grace'] },
      expected: 'unknown',
    },
    {
      override: { reviewRequests: connection([]) },
      criteria: { reviewers: ['Grace'] },
      expected: 'excluded',
    },
    {
      override: { reviewRequests: connection([{ requestedReviewer: { __typename: 'Team' } }]) },
      criteria: { reviewers: ['Grace'] },
      expected: 'excluded',
    },
    {
      override: {
        reviewRequests: connection([{ requestedReviewer: { __typename: 'User', login: 'Grace' } }]),
      },
      criteria: { reviewers: ['grace'] },
      expected: 'match',
    },
    {
      override: {
        reviewRequests: connection(
          [{ requestedReviewer: { __typename: 'User', login: 'Other' } }],
          true,
        ),
      },
      criteria: { reviewers: ['Grace'] },
      expected: 'unknown',
    },
    {
      override: { additions: -1, deletions: 1 },
      criteria: { minSize: 0 },
      expected: 'unknown',
    },
    {
      override: { additions: 0.5, deletions: 0.5 },
      criteria: { minSize: 0 },
      expected: 'unknown',
    },
    {
      override: { additions: Number.MAX_SAFE_INTEGER + 1, deletions: -1 },
      criteria: { minSize: 0 },
      expected: 'unknown',
    },
    {
      override: { additions: Number.MAX_SAFE_INTEGER, deletions: 1 },
      criteria: { minSize: 0 },
      expected: 'unknown',
    },
    {
      override: { additions: Number.MAX_SAFE_INTEGER, deletions: 0 },
      criteria: { minSize: Number.MAX_SAFE_INTEGER, maxSize: Number.MAX_SAFE_INTEGER },
      expected: 'match',
    },
  ]
  const api = installSynthetic({
    'github.com': {
      graphql: () => ({
        body: {
          data: {
            viewer: { login: VIEWER },
            repository: {
              open: connection(
                cases.map(({ override }, index) =>
                  pullRequest({
                    number: index + 1,
                    isDraft: true,
                    author: { login: VIEWER },
                    reviewDecision: null,
                    commits: { nodes: [] },
                    reviewRequests: connection([]),
                    ...override,
                  }),
                ),
              ),
              merged: connection([]),
            },
          },
        },
      }),
    },
  })
  try {
    const report = await readPullRequestInbox([target('acme/app')], { now: NOW })
    assert.equal(report.items.length, cases.length)
    assert.equal(api.graphqlCalls['github.com'], 1)
    for (const [index, entry] of cases.entries()) {
      const item = report.items.find((candidate) => candidate.number === index + 1)
      assert.ok(item)
      assert.deepEqual(
        item.groups,
        ['drafts'],
        'optional knowledge flags do not alter built-in groups',
      )
      assert.equal(
        evaluatePullRequestInbox(item, {
          group: 'drafts',
          search: '',
          sort: 'updated-desc',
          criteria: entry.criteria,
        }),
        entry.expected,
        `raw case ${index + 1}: ${JSON.stringify(entry.override)}`,
      )
    }
  } finally {
    api.restore()
  }
})
