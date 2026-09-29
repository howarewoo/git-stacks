import assert from 'node:assert/strict'
/** github.com's own context, written out so importing the host module cannot pull
 * `git-core` (and the real `execFile`) in before this file's harness patches it. */
const DOTCOM = {
  host: 'github.com',
  dotcom: true,
  webOrigin: 'https://github.com',
  apiBase: 'https://api.github.com',
  graphqlUrl: 'https://api.github.com/graphql',
} as const

/** Discovery in this file browses github.com. */
const HOST = DOTCOM

import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { DirectGitHubTransport } from '../src/main/github-transport'
import {
  classifyTransportFailure,
  discoverRepositories,
  summarizeRepository,
} from '../src/main/github-repositories'

/** The credential the fixture server expects; it must appear in no URL. */
const TOKEN = 'fixture-token-not-for-urls'

interface Recorded {
  url: string
  authorization: string | undefined
}

interface Fixture {
  origin: string
  requests: Recorded[]
  /** Resolves when a request for `path` arrives, so a cancel lands mid-flight. */
  arrived: (path: string) => Promise<void>
  close(): Promise<void>
}

function apiRepository(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: index,
    name: `repo-${index}`,
    full_name: `acme/repo-${index}`,
    owner: { login: 'acme' },
    private: index % 3 === 0,
    fork: false,
    archived: false,
    size: 100 + index,
    language: 'TypeScript',
    description: `Repository ${index}`,
    default_branch: 'main',
    pushed_at: `2026-01-01T00:00:00Z`,
    html_url: `https://github.com/acme/repo-${index}`,
    clone_url: `https://github.com/acme/repo-${index}.git`,
    ssh_url: `git@github.com:acme/repo-${index}.git`,
    permissions: { admin: false, maintain: false, push: index % 2 === 0, triage: true, pull: true },
    ...overrides,
  }
}

/** GitHub's search results carry no `permissions`; only `/user/repos` does. */
function withoutPermissions(repository: Record<string, unknown>): Record<string, unknown> {
  const { permissions: _reported, ...rest } = repository
  return rest
}

/**
 * A local HTTP server speaking GitHub's REST shapes: repository collections with
 * `Link` paging, the search envelope, and the refusals a signed-in account meets.
 * Discovery runs against it over real HTTP with a real bearer credential, and
 * every request is recorded so a leak would fail the test.
 */
async function githubFixture(): Promise<Fixture> {
  const requests: Recorded[] = []
  const waiters = new Map<string, PromiseWithResolvers<void>>()
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization })
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const arrived = waiters.get(url.pathname)
    if (arrived) {
      arrived.resolve()
      // A held response stays open until the aborted request closes it.
      request.on('close', () => response.destroy())
      return
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'Bad credentials' }))
      return
    }
    const rateLimit = {
      'content-type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4998',
      'x-ratelimit-reset': '1800000000',
    }
    const page = Number(url.searchParams.get('page') ?? '1')
    const perPage = Number(url.searchParams.get('per_page') ?? '30')
    if (url.pathname === '/user/repos') {
      if (page === 1) {
        const rest = Array.from({ length: perPage - 1 }, (_, index) => apiRepository(index + 3))
        response.writeHead(200, {
          ...rateLimit,
          link: `<http://127.0.0.1:${port}/user/repos?page=2&per_page=${perPage}>; rel="next"`,
        })
        // A search-shaped hit that GitHub returned without `permissions` is a
        // clone target like any other; only a malformed entry is dropped.
        response.end(
          JSON.stringify([
            apiRepository(1),
            { ...apiRepository(900), name: 'not a repository', full_name: 'not a repository' },
            withoutPermissions(apiRepository(902)),
            apiRepository(2),
            ...rest,
          ]),
        )
        return
      }
      response.writeHead(200, rateLimit)
      response.end(JSON.stringify([apiRepository(200), apiRepository(201)]))
      return
    }
    if (url.pathname === '/search/repositories') {
      const q = url.searchParams.get('q') ?? ''
      if (q === 'overflow') {
        response.writeHead(200, rateLimit)
        response.end(
          JSON.stringify({
            total_count: 1500,
            incomplete_results: true,
            items: [apiRepository(300)],
          }),
        )
        return
      }
      const items =
        page === 1
          ? Array.from({ length: perPage }, (_, index) =>
              index === perPage - 1
                ? withoutPermissions(apiRepository(502))
                : apiRepository(index + 300),
            )
          : [apiRepository(400), { ...apiRepository(600), full_name: 'acme/' }]
      response.writeHead(200, rateLimit)
      response.end(JSON.stringify({ total_count: 421, incomplete_results: false, items }))
      return
    }
    if (url.pathname === '/rate-limited') {
      response.writeHead(403, {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1800000000',
      })
      response.end(JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }))
      return
    }
    if (url.pathname === '/sso-protected') {
      response.writeHead(403, {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4990',
        'x-ratelimit-reset': '1800000000',
      })
      response.end(
        JSON.stringify({
          message:
            'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.',
        }),
      )
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ message: 'Not Found' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    arrived: (path) => {
      const existing = waiters.get(path)
      if (existing) return existing.promise
      const deferred = Promise.withResolvers<void>()
      waiters.set(path, deferred)
      return deferred.promise
    },
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

function authenticated(fixture: Fixture): DirectGitHubTransport {
  return new DirectGitHubTransport({
    apiUrl: fixture.origin,
    token: TOKEN,
    env: {},
    fetch: globalThis.fetch,
  })
}

test('every page of the accessible list is walked, keeping hits without permissions', async () => {
  const fixture = await githubFixture()
  try {
    const discovery = await discoverRepositories({ host: HOST, transport: authenticated(fixture) })

    assert.equal(discovery.query, '')
    // Page one holds one malformed entry and one hit without permissions; page two adds two.
    assert.equal(discovery.repositories.length, 104)
    assert.equal(discovery.repositories[0].fullName, 'acme/repo-1')
    assert.equal(discovery.repositories[1].fullName, 'acme/repo-902')
    assert.equal(discovery.repositories[2].fullName, 'acme/repo-2')
    assert.equal(discovery.repositories.at(-1)?.fullName, 'acme/repo-201')
    assert.equal(
      discovery.repositories.some((repository) => repository.fullName === 'acme/repo-900'),
      false,
    )
    // `repo-902` would be pushable if the response said so; without
    // `permissions` the access is unproven rather than absent.
    assert.equal(discovery.repositories[1].canPush, false)
    assert.equal(discovery.repositories[0].httpsUrl, 'https://github.com/acme/repo-1.git')
    assert.equal(discovery.repositories[0].sshUrl, 'git@github.com:acme/repo-1.git')

    // Every request is authenticated, and the credential never reaches a URL.
    assert.ok(fixture.requests.length >= 2)
    for (const request of fixture.requests) {
      assert.equal(request.authorization, `Bearer ${TOKEN}`)
      assert.equal(request.url.includes(TOKEN), false)
    }
    assert.match(fixture.requests[0].url, /affiliation=owner%2Ccollaborator%2Corganization_member/u)
  } finally {
    await fixture.close()
  }
})

test('a search walks its pages and keeps hits that name no permissions', async () => {
  const fixture = await githubFixture()
  try {
    const discovery = await discoverRepositories({
  host: HOST,
      transport: authenticated(fixture),
      query: 'repo',
    })

    assert.equal(discovery.query, 'repo')
    // A full page whose last hit has no permissions, plus a short second page
    // carrying one malformed entry.
    assert.equal(discovery.repositories.length, 101)
    assert.equal(discovery.repositories[0].fullName, 'acme/repo-300')
    assert.equal(discovery.repositories.at(-1)?.fullName, 'acme/repo-400')
    assert.equal(
      discovery.repositories.some((repository) => repository.fullName === 'acme/repo-600'),
      false,
    )
    // A search hit GitHub returned without `permissions` is still a clone
    // target; only its push access is unproven.
    const unproven = discovery.repositories.find(
      (repository) => repository.fullName === 'acme/repo-502',
    )
    assert.equal(unproven?.canPush, false)
    assert.equal(
      fixture.requests[0].url,
      '/search/repositories?q=repo&sort=updated&order=desc&per_page=100&page=1',
    )
    assert.equal(fixture.requests[1].url.includes('page=2'), true)
  } finally {
    await fixture.close()
  }
})

test('an empty repository is labelled so its first branch starts from nothing', async () => {
  const fixture = await githubFixture()
  try {
    const discovery = await discoverRepositories({ host: HOST, transport: authenticated(fixture) })
    assert.equal(discovery.repositories.find((entry) => entry.name === 'repo-3')?.empty, false)
    // A small repository whose size rounds to 0 KB is NOT marked empty when it has commits pushed to it.
    assert.equal(
      summarizeRepository(
        apiRepository(1, { size: 0, default_branch: 'main', pushed_at: '2026-09-29T00:00:00Z' }),
      )?.empty,
      false,
    )
    // A repository with no default branch or zero size without a push is empty.
    assert.equal(
      summarizeRepository(apiRepository(2, { size: 0, default_branch: null, pushed_at: null }))?.empty,
      true,
    )
  } finally {
    await fixture.close()
  }
})

test('a search with total_count > 1000 reports truncation and incomplete results', async () => {
  const fixture = await githubFixture()
  try {
    const discovery = await discoverRepositories({
  host: HOST,
      transport: authenticated(fixture),
      query: 'overflow',
    })
    assert.equal(discovery.query, 'overflow')
    assert.equal(discovery.totalCount, 1500)
    assert.equal(discovery.truncated, true)
    assert.equal(discovery.incompleteResults, true)
    assert.equal(discovery.repositories.length, 1)
  } finally {
    await fixture.close()
  }
})

test('organization single sign-on denial and rate limits are named outcomes', async () => {
  const fixture = await githubFixture()
  try {
    const denial = classifyTransportFailure(
      await authenticated(fixture)
        .rest({ path: 'sso-protected' })
        .catch((error: unknown) => error),
    )
    assert.equal(denial.reason, 'sso-denied')
    assert.match(denial.message, /single sign-on/iu)

    const rateLimited = classifyTransportFailure(
      await authenticated(fixture)
        .rest({ path: 'rate-limited' })
        .catch((error: unknown) => error),
    )
    assert.equal(rateLimited.reason, 'rate-limited')
  } finally {
    await fixture.close()
  }
})

test('an unauthenticated search says sign in rather than returning no repositories', async () => {
  const fixture = await githubFixture()
  try {
    const transport = new DirectGitHubTransport({
      apiUrl: fixture.origin,
      token: null,
      env: { GIT_STACKS_GITHUB_TOKEN: '', GITHUB_TOKEN: '', GH_TOKEN: '' },
      fetch: globalThis.fetch,
    })

    await assert.rejects(
      discoverRepositories({ host: HOST, transport }),
      (error: unknown) => classifyTransportFailure(error).reason === 'signed-out',
    )
  } finally {
    await fixture.close()
  }
})

test('a cancelled search stops the request instead of answering for it', async () => {
  const fixture = await githubFixture()
  try {
    const controller = new AbortController()
    const searching = discoverRepositories({
  host: HOST,
      transport: authenticated(fixture),
      signal: controller.signal,
    })
    // The cancel lands only once the request has actually reached GitHub.
    await fixture.arrived('/user/repos')
    controller.abort()

    await assert.rejects(
      searching,
      (error: unknown) => classifyTransportFailure(error).reason === 'cancelled',
    )
  } finally {
    await fixture.close()
  }
})
