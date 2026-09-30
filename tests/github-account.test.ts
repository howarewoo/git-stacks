import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { CredentialVault, type SecretProtector, type SecretStore } from '../src/main/credentials'
import { GitHubAccount } from '../src/main/github-account'
import { GitHubAppError } from '../src/main/github-app'
import {
  DirectGitHubTransport,
  emptyRateLimit,
  githubTransport,
  onGitHubFailure,
  setGitHubCredentialSource,
  type GitHubTransport,
} from '../src/main/github-transport'
import type { GitHubAccountStatus } from '../src/shared/types'

const CLIENT_ID = 'Iv1.publicclientid'
const SEAL_KEY = 0x5a
const roots: string[] = []

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * A stand-in for the platform key store that genuinely transforms what it seals,
 * so a test can prove no file on disk holds a readable credential.
 */
function sealingProtector() {
  const sealed = new Set<string>()
  const protector: SecretProtector = {
    store: () => ({ kind: 'system', name: 'test keychain' }),
    seal: (plain) => {
      const buffer = Buffer.from([...plain].map((character) => character.charCodeAt(0) ^ SEAL_KEY))
      sealed.add(buffer.toString('base64'))
      return buffer
    },
    open: (value) => {
      if (!sealed.has(value.toString('base64')))
        throw new Error('the operating-system key is locked')
      return String.fromCharCode(...[...value].map((byte) => byte ^ SEAL_KEY))
    },
  }
  return { protector, sealed }
}

function unavailableProtector(reason: string): SecretProtector {
  return {
    store: (): SecretStore => ({ kind: 'unavailable', reason }),
    seal: () => {
      throw new Error('this platform must never seal a credential')
    },
    open: () => {
      throw new Error('this platform must never open a credential')
    },
  }
}

interface Recorded {
  url: string
  parameters: Record<string, string>
}

function fetchReturning(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = []
  let index = 0
  const fetchDouble = (async (input: string | URL | Request, init?: RequestInit) => {
    const parameters = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))
    calls.push({ url: String(input), parameters })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { fetch: fetchDouble, calls }
}

const DEVICE_CODE = {
  device_code: 'device-code-value',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

function session(accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 28_800,
    refresh_token_expires_in: 15_897_600,
    scope: '',
    token_type: 'bearer',
  }
}

async function accountUnder(
  responses: Array<{ status?: number; body: unknown }>,
  options: {
    store?: SecretStore
    login?: string
    identify?: (
      accessToken: string,
      session: string,
      fetch?: typeof globalThis.fetch,
    ) => Promise<string | null>
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-account-'))
  roots.push(root)
  const { protector } = sealingProtector()
  const vaultFile = join(root, 'credentials.vault.json')
  const stateFile = join(root, 'github-account.json')
  const clock = { now: 1_700_000_000_000 }
  const { fetch: fetchDouble, calls } = fetchReturning(responses)
  const changes: GitHubAccountStatus[] = []
  // The account pushes its settled state, so a test awaits that signal rather than a delay.
  const settled = Promise.withResolvers<GitHubAccountStatus>()
  const account = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    fetch: fetchDouble,
    identify: options.identify ?? (async () => options.login ?? 'ada'),
    now: () => clock.now,
    sleep: async (milliseconds) => {
      clock.now += milliseconds
    },
    onChange: (status) => {
      changes.push(status)
      if (status.state !== 'signing-in') settled.resolve(status)
    },
  })
  return { account, calls, changes, clock, protector, root, settled, stateFile, vaultFile }
}

async function signedIn(
  responses: Array<{ status?: number; body: unknown }>,
  options?: { store?: SecretStore; transport?: () => GitHubTransport },
) {
  const harness = await accountUnder(
    [{ body: DEVICE_CODE }, { body: session('ghu_first', 'ghr_first') }, ...responses],
    options,
  )
  await harness.account.signIn()
  await harness.settled.promise
  return harness
}

/**
 * An account whose refresh only completes when the test releases it, so a
 * sign-out can be made to land while GitHub still owes an answer.
 */
async function deferredRenewalHarness() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-account-'))
  roots.push(root)
  const { protector } = sealingProtector()
  const vaultFile = join(root, 'credentials.vault.json')
  const stateFile = join(root, 'github-account.json')
  const clock = { now: 1_700_000_000_000 }
  const statuses: GitHubAccountStatus[] = []
  const settled = Promise.withResolvers<GitHubAccountStatus>()
  const renewal = Promise.withResolvers<Response>()
  const releaseRenewal = () =>
    renewal.resolve(new Response(JSON.stringify(session('ghu_late', 'ghr_late')), { status: 200 }))
  const account = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''))
      if (!body.get('grant_type')) {
        return new Response(JSON.stringify(DEVICE_CODE), { status: 200 })
      }
      if (body.get('grant_type') === 'refresh_token') {
        if (init?.signal?.aborted) throw new TypeError('fetch failed')
        return await renewal.promise
      }
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        return new Response(JSON.stringify(session('ghu_first', 'ghr_first')), { status: 200 })
      }
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch,
    identify: async () => 'ada',
    now: () => clock.now,
    sleep: async (milliseconds) => {
      clock.now += milliseconds
    },
    onChange: (status) => {
      statuses.push(status)
      if (status.state === 'signed-in') settled.resolve(status)
    },
  })
  return { account, clock, releaseRenewal, stateFile, statuses, settled, vaultFile }
}

/**
 * An account whose poll is suspended between attempts, so a cancel provably
 * lands while GitHub is still being asked.
 */
async function suspendedPollHarness() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-account-'))
  roots.push(root)
  const { protector } = sealingProtector()
  const vaultFile = join(root, 'credentials.vault.json')
  const stateFile = join(root, 'github-account.json')
  const gate = Promise.withResolvers<void>()
  const release = () => gate.resolve()
  const account = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    fetch: (async (_input: string | URL | Request) =>
      new Response(JSON.stringify(DEVICE_CODE), { status: 200 })) as typeof globalThis.fetch,
    identify: async () => 'ada',
    sleep: async () => {
      await gate.promise
    },
  })
  return { account, release, stateFile, vaultFile }
}

/** Waits for a pushed status the account has not reported yet. */
async function waitForState(
  changes: GitHubAccountStatus[],
  predicate: (status: GitHubAccountStatus) => boolean,
): Promise<GitHubAccountStatus> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = changes.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the account never reached the expected state')
}

async function exists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

test('a completed device sign-in seals the credential and keeps only a reference in state', async () => {
  const { account, stateFile, vaultFile, calls, clock, settled } = await accountUnder([
    { body: DEVICE_CODE },
    { body: session('ghu_first', 'ghr_first') },
  ])
  await account.signIn()
  await settled.promise

  const status = account.status()
  assert.equal(status.state, 'signed-in')
  assert.equal(status.login, 'ada')
  assert.equal(status.host, 'github.com')
  assert.ok(status.reference)
  assert.equal(status.expiresAt, clock.now + 28_800_000)
  assert.equal(status.refreshExpiresAt, clock.now + 15_897_600_000)
  assert.equal(status.store.available, true)
  assert.equal(status.store.name, 'test keychain')

  const state = await readFile(stateFile, 'utf8')
  assert.equal(JSON.parse(state).reference, status.reference)
  assert.ok(!state.includes('ghu_first'))
  assert.ok(!state.includes('ghr_first'))
  assert.ok(!(await readFile(vaultFile, 'utf8')).includes('ghu_first'))
  // Only the client id is sent: a shipped desktop binary carries no client secret.
  assert.equal(calls[0].parameters.client_id, CLIENT_ID)
  assert.equal(calls[1].parameters.grant_type, 'urn:ietf:params:oauth:grant-type:device_code')
  assert.ok(!('client_secret' in calls[1].parameters))

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a sign-in cancelled in the browser returns to signed out without storing anything', async () => {
  const { account, stateFile, vaultFile, changes, settled } = await accountUnder([
    { body: DEVICE_CODE },
    { body: { error: 'access_denied' } },
  ])
  await account.signIn()
  await settled.promise

  assert.equal(account.status().state, 'signed-out')
  assert.equal(account.status().challenge, null)
  assert.equal(await exists(vaultFile), false)
  assert.equal(await exists(stateFile), false)
  assert.equal(changes.at(-1)?.state, 'signed-out')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('an expired credential is renewed before the next request and stays signed in', async () => {
  const { account, calls, clock, stateFile } = await signedIn([
    { body: session('ghu_second', 'ghr_second') },
  ])
  assert.equal(account.status().state, 'signed-in')

  clock.now += 28_801_000
  const renewed = await account.current()
  assert.equal(renewed?.token, 'ghu_second', 'an expired credential is renewed, not handed out')
  assert.equal(renewed?.origin, 'account')
  assert.equal(account.status().state, 'signed-in')
  assert.equal(await exists(stateFile), true, 'the opaque reference survives a renewal')
  const renewal = calls.find((call) => call.parameters.grant_type === 'refresh_token')
  assert.equal(renewal?.parameters.refresh_token, 'ghr_first')
  assert.ok(!('client_secret' in (renewal?.parameters ?? {})))

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a credential GitHub cannot renew offline is reported, not discarded', async () => {
  const harness = await signedIn([])
  const repositoryMarker = join(harness.root, 'HEAD')
  await writeFile(repositoryMarker, 'ref: refs/heads/main\n', 'utf8')
  harness.clock.now += 28_801_000
  const offline = new GitHubAccount({
    vault: new CredentialVault(harness.vaultFile, harness.protector),
    stateFile: harness.stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    fetch: (async () => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch,
    identify: async () => 'ada',
    now: () => harness.clock.now,
  })
  const status = await offline.restore()
  assert.equal(status.state, 'expired')
  assert.equal(await offline.current(), null)
  assert.equal(offline.status().state, 'offline')
  assert.match(offline.status().message ?? '', /could not be reached/u)
  assert.equal(
    await exists(harness.vaultFile),
    true,
    'an offline start keeps the sealed credential',
  )
  assert.equal(await readFile(repositoryMarker, 'utf8'), 'ref: refs/heads/main\n')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a refresh token GitHub rejects clears the credential and asks for a new sign-in', async () => {
  const { account, clock, vaultFile, stateFile } = await signedIn([
    { body: { error: 'bad_refresh_token' } },
  ])
  clock.now += 28_801_000
  assert.equal(await account.current(), null)
  assert.equal(account.status().state, 'expired')
  assert.equal(await exists(vaultFile), false)
  assert.equal(await exists(stateFile), false)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a credential GitHub rejects while it is still valid is reported as revoked', async () => {
  const { account, stateFile, vaultFile } = await signedIn([])
  const transport = new DirectGitHubTransport({
    credential: account,
    fetch: (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
      })) as typeof globalThis.fetch,
  })

  await assert.rejects(transport.rest({ path: 'user' }))
  assert.equal(account.status().state, 'revoked')
  assert.equal(account.status().message, 'GitHub rejected the saved sign-in. Sign in again.')
  assert.equal(await account.current(), null)
  assert.equal(await exists(vaultFile), false)
  assert.equal(await exists(stateFile), false)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('the transport renews an expired account credential before the request leaves', async () => {
  const { account, clock } = await signedIn([{ body: session('ghu_second', 'ghr_second') }])
  clock.now += 28_801_000
  const seen: string[] = []
  const transport = new DirectGitHubTransport({
    credential: account,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(JSON.stringify({ login: 'ada' }), { status: 200 })
    }) as typeof globalThis.fetch,
  })

  await transport.rest({ path: 'user' })
  assert.deepEqual(seen, ['Bearer ghu_second'])
  assert.equal(account.status().state, 'signed-in')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('an organization that requires single sign-on reports permission denied', async () => {
  const { account, stateFile } = await signedIn([])
  const transport = new DirectGitHubTransport({
    credential: account,
    fetch: (async () =>
      new Response(
        JSON.stringify({
          message:
            'Resource protected by organization SAML enforcement. You must grant your token access to this organization.',
        }),
        { status: 403 },
      )) as typeof globalThis.fetch,
  })
  await assert.rejects(transport.rest({ path: 'repos/acme/widgets/pulls/1' }))

  const status = account.status()
  assert.equal(status.state, 'permission-denied')
  assert.match(status.message ?? '', /single sign-on/u)
  assert.equal(await exists(stateFile), true, 'a policy block does not discard the credential')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a build with no client id cannot sign in and never asks GitHub for a code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-account-'))
  roots.push(root)
  const { protector } = sealingProtector()
  const { fetch: fetchDouble, calls } = fetchReturning([])
  const account = new GitHubAccount({
    vault: new CredentialVault(join(root, 'credentials.vault.json'), protector),
    stateFile: join(root, 'github-account.json'),
    env: {},
    fetch: fetchDouble,
    identify: async () => 'ada',
  })
  assert.equal(account.status().state, 'not-configured')
  assert.equal((await account.signIn()).state, 'not-configured')
  assert.equal(calls.length, 0)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a session with no operating-system keyring is never stored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-account-'))
  roots.push(root)
  const vaultFile = join(root, 'credentials.vault.json')
  const stateFile = join(root, 'github-account.json')
  const { fetch: fetchDouble, calls } = fetchReturning([
    { body: DEVICE_CODE },
    { body: session('ghu_first', 'ghr_first') },
  ])
  const account = new GitHubAccount({
    vault: new CredentialVault(
      vaultFile,
      unavailableProtector('This Linux session has no keyring (libsecret or KWallet).'),
    ),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    fetch: fetchDouble,
    identify: async () => 'ada',
  })

  const status = await account.signIn()
  assert.equal(status.state, 'storage-unavailable')
  assert.equal(status.store.available, false)
  assert.match(status.store.reason ?? '', /no keyring/u)
  assert.equal(calls.length, 0, 'no device code is requested when nothing can be stored')
  assert.equal(await exists(vaultFile), false)
  assert.equal(await exists(stateFile), false)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('sign-out removes the credential this application owns and nothing else', async () => {
  const { account, stateFile, vaultFile, root } = await signedIn([])
  const repositoryMarker = join(root, 'HEAD')
  await writeFile(repositoryMarker, 'ref: refs/heads/main\n', 'utf8')

  const status = await account.signOut()
  assert.equal(status.state, 'signed-out')
  assert.equal(status.reference, null)
  assert.equal(status.login, null)
  assert.equal(await exists(vaultFile), false)
  assert.equal(await exists(stateFile), false)
  assert.equal(await account.current(), null)
  assert.equal(await readFile(repositoryMarker, 'utf8'), 'ref: refs/heads/main\n')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a signed-in account restores from the sealed store without a network call', async () => {
  const first = await signedIn([])
  const restored = new GitHubAccount({
    vault: new CredentialVault(first.vaultFile, first.protector),
    stateFile: first.stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    fetch: (async () => {
      throw new Error('no request is expected while restoring')
    }) as typeof globalThis.fetch,
    identify: async () => 'ada',
    now: () => first.clock.now,
  })
  const status = await restored.restore()
  assert.equal(status.state, 'signed-in')
  assert.equal(status.reference, first.account.status().reference)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a device code is polled at the interval GitHub required, honouring slow_down', async () => {
  const { account, calls, settled } = await accountUnder([
    { body: DEVICE_CODE },
    { body: { error: 'authorization_pending' } },
    { body: { error: 'slow_down' } },
    { body: session('ghu_first', 'ghr_first') },
  ])
  await account.signIn()
  await settled.promise

  assert.equal(account.status().state, 'signed-in')
  const polls = calls.filter((call) => call.url.endsWith('/login/oauth/access_token'))
  assert.equal(polls.length, 3)
  assert.equal(polls[0].parameters.device_code, 'device-code-value')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('no failure string carries a credential', async () => {
  const { account, clock, changes } = await signedIn([
    { body: { error: 'bad_refresh_token', error_description: 'ghu_leaked_here' } },
  ])
  clock.now += 28_801_000
  await account.current()
  const failures = new GitHubAppError('bad_refresh_token')
  assert.equal(failures.message.includes('ghu_'), false)
  for (const status of [...changes, account.status()]) {
    assert.equal(JSON.stringify(status).includes('ghu_'), false)
    assert.equal(JSON.stringify(status).includes('ghr_'), false)
  }

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a refresh in flight cannot restore a credential after sign-out', async () => {
  const { account, vaultFile, stateFile, clock, statuses, settled, releaseRenewal } =
    await deferredRenewalHarness()
  await account.signIn()
  clock.now += 28_801_000
  const refreshing = account.current()
  await account.signOut()
  releaseRenewal()
  assert.equal(await refreshing, null, 'the abandoned renewal yields no credential')
  assert.equal(account.status().state, 'signed-out')
  assert.equal(account.status().login, null)
  assert.equal(await account.current(), null)
  assert.equal(await exists(vaultFile), false, 'sign-out leaves no sealed credential behind')
  assert.equal(await exists(stateFile), false)
  assert.ok(
    statuses.every((status) => status.state !== 'signed-in'),
    'no status reports a signed-in account after the sign-out',
  )

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a device sign-in cancelled while GitHub is answering stores nothing', async () => {
  const { account, vaultFile, stateFile, release } = await suspendedPollHarness()
  await account.signIn()
  await account.cancelSignIn()
  release()
  // Give the abandoned poll a turn to finish before asserting what it left.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(account.status().state, 'signed-out')
  assert.equal(account.status().challenge, null)
  assert.equal(await account.current(), null)
  assert.equal(await exists(vaultFile), false)
  assert.equal(await exists(stateFile), false)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a constructed account does not disable the gh transport until it holds a credential', async () => {
  const { account } = await accountUnder([])
  assert.equal(account.available(), false)
  assert.equal(githubTransport({}).kind, 'gh', 'a signed-out account leaves gh in charge')
  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a signed-in account selects the direct transport with no gh on PATH', async () => {
  const { account } = await signedIn([])
  assert.equal(account.available(), true)
  assert.equal(githubTransport({}).kind, 'direct')

  await account.signOut()
  assert.equal(account.available(), false)
  assert.equal(githubTransport({}).kind, 'gh', 'signing out hands the work back to gh')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('an external credential rejection never deletes the stored account', async () => {
  const { account, stateFile, vaultFile } = await signedIn([])
  const withOverride = new DirectGitHubTransport({
    credential: account,
    env: { GIT_STACKS_GITHUB_TOKEN: 'override' },
    fetch: (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
      })) as typeof globalThis.fetch,
  })
  await assert.rejects(withOverride.rest({ path: 'user' }))
  assert.equal(account.status().state, 'signed-in', 'the stored session is untouched')
  assert.equal(account.status().login, 'ada')
  assert.equal(await exists(vaultFile), true)
  assert.equal(await exists(stateFile), true)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('the stored github.com credential is never sent to another API origin', async () => {
  const { account } = await signedIn([])
  const seen: string[] = []
  const record = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization') ?? '')
    return new Response(JSON.stringify({ login: 'ada' }), { status: 200 })
  }) as typeof globalThis.fetch

  await assert.rejects(
    new DirectGitHubTransport({
      credential: account,
      env: { GIT_STACKS_GITHUB_API_URL: 'https://ghe.example.com/api/v3' },
      fetch: record,
    }).rest({ path: 'user' }),
  )
  assert.deepEqual(seen, [], 'no request leaves, so no credential can be attached')

  await assert.rejects(
    new DirectGitHubTransport({
      credential: account,
      env: { GIT_STACKS_GITHUB_API_URL: 'http://127.0.0.1:9/api' },
      fetch: record,
    }).rest({ path: 'user' }),
  )
  assert.deepEqual(seen, [], 'an insecure origin receives nothing either')

  // The same refusal on the path production takes, where the host is named and the
  // API base is configured for that host. Serving the configured base is a statement
  // about where a caller's own credential may go; it never redirects the credential
  // the host's name derives.
  const hostBound = (apiUrl: string): DirectGitHubTransport =>
    new DirectGitHubTransport({
      credential: account,
      host: 'github.com',
      env: { GIT_STACKS_GITHUB_TRANSPORT: 'direct', GIT_STACKS_GITHUB_API_URL: apiUrl },
      fetch: record,
    })
  await assert.rejects(hostBound('https://other.example/api').rest({ path: 'user' }))
  assert.deepEqual(seen, [], 'a configured base receives nothing the host did not issue it')

  // A credential the caller supplied for that base is its own assertion, and does go.
  const supplied: string[] = []
  const suppliedRecord = (async (_input: string | URL | Request, init?: RequestInit) => {
    supplied.push(new Headers(init?.headers).get('authorization') ?? '')
    return new Response(JSON.stringify({ login: 'ada' }), { status: 200 })
  }) as typeof globalThis.fetch
  await new DirectGitHubTransport({
    host: 'github.com',
    env: {
      GIT_STACKS_GITHUB_TRANSPORT: 'direct',
      GIT_STACKS_GITHUB_API_URL: 'https://other.example/api',
      GIT_STACKS_GITHUB_TOKEN: 'supplied-token',
    },
    fetch: suppliedRecord,
  }).rest({ path: 'user' })
  assert.deepEqual(supplied, ['Bearer supplied-token'], "the caller's own credential is used")

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('the stored identity is the one the stored credential authenticates as', async () => {
  const identified: string[] = []
  const harness = await accountUnder(
    [{ body: DEVICE_CODE }, { body: session('ghu_app', 'ghr_app') }],
    {
      identify: async (accessToken) => {
        identified.push(accessToken)
        return accessToken === 'ghu_app' ? 'app-user' : 'other-user'
      },
    },
  )
  await harness.account.signIn()
  await harness.settled.promise

  assert.deepEqual(identified, ['ghu_app'], 'only the newly adopted credential is asked')
  const state = JSON.parse(await readFile(harness.stateFile, 'utf8')) as { login: string }
  assert.equal(state.login, 'app-user')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a restored session makes the direct transport available again on restart', async () => {
  // A completed sign-in leaves a sealed session and a state file on disk.
  const harness = await signedIn([])
  const restarted = new GitHubAccount({
    vault: new CredentialVault(harness.vaultFile, harness.protector),
    stateFile: harness.stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    now: () => harness.clock.now,
    identify: async () => 'ada',
  })
  const status = await restarted.restore()
  assert.equal(status.state, 'signed-in')
  assert.equal(restarted.available(), true, 'a restored session is usable at once')
  assert.equal(githubTransport({}).kind, 'direct', 'the restart uses the direct transport')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a rejection for a superseded session leaves its replacement alone', async () => {
  const harness = await accountUnder([
    { body: DEVICE_CODE },
    { body: session('ghu_first', 'ghr_first') },
    { body: session('ghu_second', 'ghr_second') },
  ])
  const { account, clock } = harness
  await account.signIn()
  await harness.settled.promise
  const first = await account.current()
  assert.equal(first?.token, 'ghu_first')

  clock.now += 28_801_000
  const second = await account.current()
  assert.equal(second?.token, 'ghu_second', 'the expired session was renewed')
  assert.notEqual(second?.session, first?.session, 'a renewal is a new session')

  // The old credential's request comes back rejected, after its replacement is in use.
  const stale = new DirectGitHubTransport({
    credential: {
      host: 'github.com',
      available: () => true,
      current: async () => ({
        token: 'ghu_first',
        session: first!.session,
        origin: 'account' as const,
      }),
    },
    fetch: (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
      })) as typeof globalThis.fetch,
  })
  await assert.rejects(stale.rest({ path: 'user' }))
  assert.equal(account.status().state, 'signed-in', 'the replacement survives an older rejection')
  assert.equal((await account.current())?.token, 'ghu_second')

  // A rejection of the session that is actually in use is still a revocation.
  const current = new DirectGitHubTransport({
    credential: account,
    fetch: (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
      })) as typeof globalThis.fetch,
  })
  await assert.rejects(current.rest({ path: 'user' }))
  assert.equal(account.status().state, 'revoked')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('the production identity lookup pins the token to api.github.com', async () => {
  const seen: { url: string; authorization: string | null }[] = []
  // No identify override: the account uses the real lookup that every build uses.
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-account-'))
  roots.push(root)
  const { protector } = sealingProtector()
  const vaultFile = join(root, 'credentials.vault.json')
  const stateFile = join(root, 'github-account.json')
  const account = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: {
      GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID,
      // A launcher-supplied endpoint, and a token from the environment that must
      // not be mistaken for the account's identity either.
      GIT_STACKS_GITHUB_API_URL: 'https://ghe.example.com/api/v3',
      GH_TOKEN: 'someone-else',
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = new URLSearchParams(String(init?.body ?? ''))
      if (url.endsWith('/login/device/code')) {
        return new Response(JSON.stringify(DEVICE_CODE), { status: 200 })
      }
      if (url.endsWith('/login/oauth/access_token')) {
        if (body.get('grant_type') === 'refresh_token') throw new TypeError('fetch failed')
        return new Response(JSON.stringify(session('ghu_app', 'ghr_app')), { status: 200 })
      }
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      return new Response(JSON.stringify({ login: 'app-user' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch,
    sleep: async () => {},
  })

  await account.signIn()
  for (let attempt = 0; attempt < 400 && seen.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.equal(seen.length, 1, 'identity is read exactly once')
  assert.equal(seen[0].url, 'https://api.github.com/user', 'the endpoint override is ignored')
  assert.equal(seen[0].authorization, 'Bearer ghu_app', 'the app token, not the environment token')
  // The commit publishes in memory before the file rename completes, so the
  // assertion waits for what actually reached disk.
  let raw = ''
  for (let attempt = 0; attempt < 400; attempt += 1) {
    raw = await readFile(stateFile, 'utf8')
    if (raw.includes('app-user')) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const state = JSON.parse(raw) as { login: string }
  assert.equal(
    state.login,
    'app-user',
    `the login is the one the app token authenticates as; saw ${raw}`,
  )

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a sign-out during the state-file write leaves nothing persisted', async () => {
  const harness = await accountUnder([{ body: DEVICE_CODE }, { body: session('ghu_a', 'ghr_a') }])
  const { account, vaultFile, stateFile } = harness
  const writes: string[] = []
  const releasing = Promise.withResolvers<void>()
  // Hold the state-file rename open so the sign-out provably lands mid-commit.
  const { fetch: fetchDouble } = fetchReturning([
    { body: DEVICE_CODE },
    { body: session('ghu_a', 'ghr_a') },
  ])
  const intercepted = new GitHubAccount({
    vault: new CredentialVault(vaultFile, harness.protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    beforeStateWrite: async () => {
      writes.push('begin')
      await releasing.promise
      writes.push('end')
    },
    fetch: fetchDouble,
    sleep: async () => {},
  })
  await intercepted.signIn()
  for (let attempt = 0; attempt < 400 && !writes.includes('begin'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const signingOut = intercepted.signOut()
  releasing.resolve()
  await signingOut
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(writes, ['begin', 'end'], 'the commit was in flight when the sign-out ran')
  assert.equal(await exists(vaultFile), false)
  assert.equal(await exists(stateFile), false)
  assert.equal(intercepted.available(), false)
  assert.equal(await account.current(), null)
  assert.equal(intercepted.status().state, 'signed-out')
})

/** A vault barrier that holds the next state-file rename open, then releases it. */
function commitBarrier() {
  const writes: string[] = []
  let held = false
  const gate = Promise.withResolvers<void>()
  const before = async () => {
    writes.push('begin')
    held = true
    await gate.promise
    writes.push('end')
  }
  return { writes, before, isHeld: () => held, release: () => gate.resolve() }
}

async function waitFor<T>(produce: () => T | false | Promise<T | false>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await produce()
    if (value !== false) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the expected state never arrived')
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the expected state never arrived')
}

test('cancelling a replacement sign-in keeps the account that was already stored', async () => {
  const harness = await signedIn([])
  const { account, vaultFile, stateFile, protector } = harness
  const before = JSON.parse(await readFile(stateFile, 'utf8')) as {
    reference: string
    login: string
  }
  // A replacement starts and stalls with its commit already in flight.
  const barrier = commitBarrier()
  const { fetch: fetchDouble } = fetchReturning([
    { body: DEVICE_CODE },
    { body: session('ghu_replacement', 'ghr_replacement') },
  ])
  const vault = new CredentialVault(vaultFile, protector)
  const sealedBefore = await vault.open(before.reference)
  assert.match(sealedBefore, /ghu_first/u)
  // The rollback is observable exactly: the staged reference is removed and the
  // previous one is not.
  const removed: string[] = []
  const removing = vault.remove.bind(vault)
  vault.remove = async (reference: string) => {
    removed.push(reference)
    await removing(reference)
  }
  const replacing = new GitHubAccount({
    vault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    beforeStateWrite: barrier.before,
    fetch: fetchDouble,
    now: () => harness.clock.now,
    sleep: async () => {},
  })
  await replacing.restore()
  assert.equal(replacing.status().state, 'signed-in')
  await replacing.signIn()
  await waitUntil(barrier.isHeld)

  await replacing.cancelSignIn()
  barrier.release()
  await waitUntil(() => removed.length > 0)
  await waitUntil(async () => (await readFile(stateFile, 'utf8')).includes(before.reference))

  // The account that was signed in is still signed in, and still on disk.
  assert.equal(replacing.status().state, 'signed-in', 'the previous account is preserved')
  assert.equal(replacing.status().login, 'ada')
  const after = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }
  assert.equal(after.reference, before.reference, 'the state file still names the old credential')
  assert.equal(removed.length, 1, 'exactly one credential is removed, the staged one')
  assert.notEqual(removed[0], before.reference, 'the stored credential is not the one removed')
  assert.ok(
    (await vault.open(after.reference)).includes('ghu_first'),
    'the old credential is still sealed and readable',
  )

  // And a restart still finds it.
  const restarted = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    now: () => harness.clock.now,
    identify: async () => 'ada',
  })
  assert.equal((await restarted.restore()).state, 'signed-in')
  assert.equal((await restarted.current())?.token, 'ghu_first')
  assert.equal(account.status().state, 'signed-in')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('cancelling a first sign-in leaves no account metadata behind', async () => {
  const harness = await accountUnder([])
  const { vaultFile, stateFile, protector } = harness
  const barrier = commitBarrier()
  const { fetch: fetchDouble } = fetchReturning([
    { body: DEVICE_CODE },
    { body: session('ghu_new', 'ghr_new') },
  ])
  const signingIn = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    beforeStateWrite: barrier.before,
    fetch: fetchDouble,
    sleep: async () => {},
  })
  await signingIn.signIn()
  await waitUntil(barrier.isHeld)
  await signingIn.cancelSignIn()
  barrier.release()
  await waitUntil(async () => (await exists(stateFile)) === false)
  await waitUntil(async () => (await exists(vaultFile)) === false)

  assert.equal(signingIn.status().state, 'signed-out')
  assert.equal(signingIn.available(), false)
  assert.equal(await exists(stateFile), false, 'no dangling account metadata survives')
  assert.equal(await exists(vaultFile), false, 'the staged credential is gone')

  const restarted = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
  })
  assert.equal((await restarted.restore()).state, 'signed-out')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('cancelling a sign-in does not abandon the refresh the current account owns', async () => {
  const harness = await signedIn([])
  const { clock, protector, vaultFile, stateFile } = harness
  const vault = new CredentialVault(vaultFile, protector)
  const removed: string[] = []
  const removing = vault.remove.bind(vault)
  vault.remove = async (reference: string) => {
    removed.push(reference)
    await removing(reference)
  }
  // The rotation is held open so the replacement sign-in provably overlaps it.
  const rotation = Promise.withResolvers<Response>()
  const barrier = commitBarrier()
  let armBarrier = true
  const account = new GitHubAccount({
    vault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    now: () => clock.now,
    sleep: async () => {},
    beforeStateWrite: async () => {
      if (armBarrier) await barrier.before()
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = new URLSearchParams(String(init?.body ?? ''))
      if (url.endsWith('/login/device/code')) {
        return new Response(JSON.stringify(DEVICE_CODE), { status: 200 })
      }
      if (body.get('grant_type') === 'refresh_token') return await rotation.promise
      return new Response(JSON.stringify(session('ghu_replacement', 'ghr_replacement')), {
        status: 200,
      })
    }) as typeof globalThis.fetch,
  })
  await account.restore()
  // The stored account is at expiry, so the next request starts a rotation.
  clock.now += 28_801_000
  const rotating = account.current()

  await account.signIn()
  await waitUntil(barrier.isHeld)
  await account.cancelSignIn()
  armBarrier = false
  barrier.release()
  await waitUntil(() => removed.length > 0)

  // GitHub answers the rotation afterwards, having already rotated the token.
  rotation.resolve(
    new Response(JSON.stringify(session('ghu_rotated', 'ghr_rotated')), { status: 200 }),
  )
  const rotated = await rotating

  assert.equal(rotated?.token, 'ghu_rotated', 'the rotation is kept, not dropped')
  assert.equal(account.status().state, 'signed-in', 'the account is signed in on the new session')
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }
  const stored = await vault.open(state.reference)
  assert.ok(stored.includes('ghr_rotated'), 'the rotated refresh token is the one now stored')
  assert.ok(!stored.includes('ghu_replacement'), 'the abandoned replacement left nothing behind')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('an error status is reported by what GitHub said, not as a network failure', async () => {
  const harness = await accountUnder([])
  const { vaultFile, stateFile, protector } = harness
  const github = (status: number, body: string) => ({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    fetch: (async () => new Response(body, { status })) as typeof globalThis.fetch,
  })
  // A rejected client id arrives with an error status and a readable reason.
  const rejected = new GitHubAccount(
    github(404, JSON.stringify({ error: 'incorrect_client_credentials' })),
  )
  await rejected.restore()
  const rejection1 = await rejected.signIn()
  assert.equal(rejection1.state, 'not-configured')
  assert.match(rejection1.message ?? '', /rejected the client id/u)

  // A service failure with nothing usable behind it is the network.
  const broken = new GitHubAccount(github(502, '<html>bad gateway</html>'))
  await broken.restore()
  const outage = await broken.signIn()
  assert.equal(outage.state, 'offline')
  assert.match(outage.message ?? '', /could not be reached/u)

  // A reachable but unhelpful answer is not the network either.
  const odd = new GitHubAccount(github(404, JSON.stringify({ message: 'Not Found' })))
  await odd.restore()
  const unhelpful = await odd.signIn()
  assert.equal(unhelpful.state, 'signed-out')
  assert.match(unhelpful.message ?? '', /usable sign-in response/u)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

/** Holds the removal of one sealed reference open, the way a slow key store would. */
function retireBarrier(target: string) {
  const gate = Promise.withResolvers<void>()
  let held = false
  return {
    isHeld: () => held,
    release: () => gate.resolve(),
    vault(vault: CredentialVault): CredentialVault {
      const removing = vault.remove.bind(vault)
      vault.remove = async (reference: string) => {
        if (reference !== target) return await removing(reference)
        held = true
        await gate.promise
        await removing(reference)
      }
      return vault
    },
  }
}

test('signing out while the replaced credential is being retired leaves nothing behind', async () => {
  const harness = await signedIn([])
  const { protector, stateFile, vaultFile } = harness
  const before = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }
  const barrier = retireBarrier(before.reference)
  const vault = barrier.vault(new CredentialVault(vaultFile, protector))
  const { fetch: fetchDouble } = fetchReturning([
    { body: DEVICE_CODE },
    { body: session('ghu_replacement', 'ghr_replacement') },
  ])
  const account = new GitHubAccount({
    vault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    fetch: fetchDouble,
    now: () => harness.clock.now,
    sleep: async () => {},
  })
  await account.restore()
  await account.signIn()
  // The replacement is published and the account it replaced is on its way out.
  await waitUntil(barrier.isHeld)
  assert.equal(account.status().state, 'signed-in')
  assert.equal((await account.current())?.token, 'ghu_replacement')

  // The user signs out exactly here, while the retirement is still in flight.
  const signingOut = account.signOut()
  assert.equal(account.available(), false, 'the credential stops being usable at once')
  assert.equal(await account.current(), null)
  barrier.release()
  const signedOut = await signingOut

  assert.equal(signedOut.state, 'signed-out', 'the sign-out wins, not the retirement')
  assert.equal(signedOut.reference, null)
  assert.equal(signedOut.login, null)
  assert.equal(signedOut.signingIn, false)
  assert.equal(account.available(), false)
  assert.equal(await account.current(), null, 'no token survives the sign-out')
  assert.equal(await exists(vaultFile), false, 'the store is empty')
  assert.equal(await exists(stateFile), false, 'no account metadata survives')
  assert.equal(account.status().state, 'signed-out')

  const restarted = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
  })
  assert.equal((await restarted.restore()).state, 'signed-out')
  assert.equal(await restarted.current(), null)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('cancelling while the replaced credential is being retired cannot lose either account', async () => {
  const harness = await signedIn([])
  const { protector, stateFile, vaultFile } = harness
  const before = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }
  const barrier = retireBarrier(before.reference)
  const vault = barrier.vault(new CredentialVault(vaultFile, protector))
  const { fetch: fetchDouble } = fetchReturning([
    { body: DEVICE_CODE },
    { body: session('ghu_replacement', 'ghr_replacement') },
  ])
  const account = new GitHubAccount({
    vault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    fetch: fetchDouble,
    now: () => harness.clock.now,
    sleep: async () => {},
  })
  await account.restore()
  await account.signIn()
  await waitUntil(barrier.isHeld)
  await account.cancelSignIn()
  barrier.release()

  // The commit was already published when the cancel arrived, so the replacement
  // is the account — and every surface agrees on that, with nothing dangling.
  const settled = await waitFor(() => {
    const status = account.status()
    if (status.state === 'signing-in' || status.reference === null) return false
    return status
  })
  assert.equal(settled.state, 'signed-in')
  assert.equal(settled.signingIn, false, 'the device flow is over')
  assert.equal(settled.challenge, null)
  assert.notEqual(settled.reference, before.reference, 'the published replacement is the account')

  const stored = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }
  assert.equal(stored.reference, settled.reference, 'the state file names the same credential')
  assert.equal(account.available(), true)
  assert.equal((await account.current())?.token, 'ghu_replacement')
  const entries = await waitFor(async () => {
    const store = JSON.parse(await readFile(vaultFile, 'utf8')) as {
      entries: { reference: string }[]
    }
    return store.entries.length === 1 ? store : false
  })
  assert.deepEqual(
    entries.entries.map((entry) => entry.reference),
    [settled.reference],
    'the retired credential left the store',
  )

  const restarted = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    now: () => harness.clock.now,
    identify: async () => 'ada',
  })
  assert.equal((await restarted.restore()).state, 'signed-in')
  assert.equal((await restarted.current())?.token, 'ghu_replacement')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a renewal that lands while a replacement is being authorized does not hide it', async () => {
  const harness = await signedIn([{ body: session('ghu_rotated', 'ghr_rotated') }])
  const { clock, protector, stateFile, vaultFile } = harness
  const rotation = Promise.withResolvers<Response>()
  const account = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    now: () => clock.now,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''))
      if (body.get('grant_type') === 'refresh_token') return await rotation.promise
      return new Response(JSON.stringify(DEVICE_CODE), { status: 200 })
    }) as typeof globalThis.fetch,
    // The device poll parks here: the user has not entered the code yet, and
    // this test is about what the panel shows while that is true.
    sleep: () => new Promise(() => {}),
  })
  await account.restore()
  clock.now += 28_801_000
  const renewing = account.current()
  await account.signIn()
  assert.equal(account.status().signingIn, true, 'the replacement flow is in progress')
  const code = account.status().challenge
  assert.ok(code, 'a one-time code is on screen')
  assert.equal(account.status().state, 'signed-in', 'the account is still the one described')

  // The renewal is answered while the user is still entering the code.
  rotation.resolve(
    new Response(JSON.stringify(session('ghu_rotated', 'ghr_rotated')), { status: 200 }),
  )
  assert.equal((await renewing)?.token, 'ghu_rotated', 'the renewal is handed back')
  const during = account.status()
  assert.equal(during.state, 'signed-in', 'the renewed account is signed in')
  assert.equal(during.signingIn, true, 'the device flow is still reported as in progress')
  assert.deepEqual(during.challenge, code, 'the same code and its cancel control stay on screen')

  // Cancelling afterwards ends the flow and leaves the renewed account alone.
  const cancelled = await account.cancelSignIn()
  assert.equal(cancelled.signingIn, false)
  assert.equal(cancelled.challenge, null)
  assert.equal(cancelled.state, 'signed-in')
  assert.equal((await account.current())?.token, 'ghu_rotated')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a finished replacement publishes every step of the flow, not only state changes', async () => {
  const harness = await signedIn([])
  const { account, protector, stateFile, vaultFile } = harness
  // Only the replacement's own pushes are of interest here.
  const changes: GitHubAccountStatus[] = []
  const first = account.status()
  // The code is held back so the "a flow is in progress" push is observable on
  // its own, before there is a code to show.
  const code = Promise.withResolvers<Response>()
  const { fetch: fetchDouble } = fetchReturning([{ body: session('ghu_second', 'ghr_second') }])
  const delayed: typeof globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(input).endsWith('/login/device/code')) return await code.promise
    return await fetchDouble(input, init)
  }) as typeof globalThis.fetch
  const replacing = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'grace',
    fetch: delayed,
    now: () => harness.clock.now,
    sleep: async () => {},
    onChange: (status) => changes.push(status),
  })
  await replacing.restore()
  assert.equal(replacing.status().state, 'signed-in')

  // The sign-in is not awaited: it is still asking GitHub for a code, and the
  // renderer has to hear that a flow is in progress while that is true.
  const signingIn = replacing.signIn()
  // What the renderer is told, in order: the flow started, the code arrived, the
  // flow ended with the new account named. A panel that only watched the state
  // would have heard nothing at all, because it stayed "signed-in" throughout.
  const started = changes.find((status) => status.signingIn)
  assert.ok(started, 'the renderer was told a sign-in is in progress')
  assert.equal(started.challenge, null, 'the flow is reported before its code exists')
  code.resolve(
    new Response(JSON.stringify(DEVICE_CODE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  await signingIn
  const withCode = changes.find((status) => status.challenge)
  assert.ok(withCode, 'the one-time code was published')
  assert.equal(withCode.challenge?.userCode, 'WDJB-MJHT')
  assert.equal(withCode.state, 'signed-in', 'the account being replaced is still described')
  assert.equal(withCode.login, 'ada', 'the account being replaced is still the one named')
  // The last step carries the identity the new token established, which is only
  // known once the lookup has come back.
  const done = await waitFor(() => {
    const status = changes.at(-1)
    return status?.signingIn === false &&
      status.reference !== first.reference &&
      status.login === 'grace'
      ? status
      : false
  })
  assert.equal(
    changes.filter((status) => status.signingIn).length >= 2,
    true,
    'both the start and the code were published as flow changes',
  )
  assert.equal(done.login, 'grace', 'the account now names who the new token belongs to')
  assert.equal(done.challenge, null)
  assert.equal(
    (await replacing.current())?.token,
    'ghu_second',
    'the account serves the token that replaced the retired one',
  )

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('cancelling after a replacement commits still identifies the new account', async () => {
  const harness = await signedIn([])
  const { protector, stateFile, vaultFile } = harness
  const before = JSON.parse(await readFile(stateFile, 'utf8')) as {
    reference: string
    login: string
  }
  assert.equal(before.login, 'ada', 'the account being replaced is ada')
  const barrier = retireBarrier(before.reference)
  const vault = barrier.vault(new CredentialVault(vaultFile, protector))
  const { fetch: fetchDouble } = fetchReturning([
    { body: DEVICE_CODE },
    { body: session('ghu_bob', 'ghr_bob') },
  ])
  let identifyCalls = 0
  const account = new GitHubAccount({
    vault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => {
      identifyCalls += 1
      return 'bob'
    },
    fetch: fetchDouble,
    now: () => harness.clock.now,
    sleep: async () => {},
  })
  await account.restore()
  await account.signIn()
  await waitUntil(barrier.isHeld)

  // The user cancels after the replacement is already the committed account.
  await account.cancelSignIn()
  barrier.release()
  const settled = await waitFor(() => {
    const status = account.status()
    return status.login === 'bob' ? status : false
  })

  assert.equal(identifyCalls, 1, 'the committed credential is identified, not dropped')
  assert.notEqual(settled.reference, before.reference)
  assert.equal((await account.current())?.token, 'ghu_bob', 'the token is bob’s')
  // The login reaches the account before the file that records it, so the
  // assertion waits for the file rather than racing it.
  const stored = await waitFor(async () => {
    const value = JSON.parse(await readFile(stateFile, 'utf8')) as {
      login: string
      reference: string
    }
    return value.login === 'bob' ? value : false
  })
  assert.notEqual(stored.login, 'ada', 'ada is not persisted as the identity of bob’s token')
  assert.equal(stored.reference, settled.reference)

  // And a restart agrees.
  const restarted = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    now: () => harness.clock.now,
    identify: async () => 'bob',
  })
  assert.equal((await restarted.restore()).state, 'signed-in')
  assert.equal(restarted.status().login, 'bob')
  assert.equal((await restarted.current())?.token, 'ghu_bob')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a superseded poll cannot clear the sign-in that replaced it', async () => {
  const harness = await signedIn([])
  const { protector, stateFile, vaultFile } = harness
  const before = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }
  const barrier = retireBarrier(before.reference)
  const vault = barrier.vault(new CredentialVault(vaultFile, protector))
  const codes: string[] = []
  const account = new GitHubAccount({
    vault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    now: () => harness.clock.now,
    // The first flow is answered at once; the second parks until it is cancelled,
    // so the two overlap for as long as the test needs.
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''))
      if (String(input).endsWith('/login/device/code')) {
        const userCode = `CODE-${codes.length + 1}`
        codes.push(userCode)
        return new Response(
          JSON.stringify({ ...DEVICE_CODE, user_code: userCode, device_code: userCode }),
          { status: 200 },
        )
      }
      if (body.get('device_code') === 'CODE-1') {
        return new Response(JSON.stringify(session('ghu_b', 'ghr_b')), { status: 200 })
      }
      await new Promise(() => {})
      return new Response(JSON.stringify({ error: 'access_denied' }), { status: 200 })
    }) as typeof globalThis.fetch,
    sleep: async () => {},
  })
  await account.restore()
  await account.signIn()
  await waitUntil(barrier.isHeld)

  // Cancel the committed flow and start another while the first is still retiring.
  await account.cancelSignIn()
  await account.signIn()
  assert.equal(account.status().signingIn, true)
  assert.equal(account.status().challenge?.userCode, 'CODE-2')

  // The stale continuation of the first flow now finishes.
  barrier.release()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const still = account.status()
  assert.equal(still.signingIn, true, 'the newer sign-in is still in progress')
  assert.equal(
    still.challenge?.userCode,
    'CODE-2',
    'the newer one-time code was not cleared by the older flow',
  )
  assert.equal(still.state, 'signed-in', 'the committed replacement is the account')

  // And cancelling it is still possible, which is what clearing its controller
  // would have prevented.
  const cancelled = await account.cancelSignIn()
  assert.equal(cancelled.signingIn, false)
  assert.equal(cancelled.challenge, null)
  assert.equal(cancelled.state, 'signed-in')
  assert.equal((await account.current())?.token, 'ghu_b')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

/**
 * Resolves after the microtask queue has drained, so a continuation that must
 * not have started anything has had every chance to. One turn of the event
 * loop is the whole wait: nothing here is measured against the clock.
 */
async function drained(): Promise<void> {
  const turn = Promise.withResolvers<void>()
  setImmediate(() => turn.resolve())
  await turn.promise
}

test('a device code answered after a newer sign-in began is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-account-'))
  roots.push(root)
  const { protector } = sealingProtector()
  const late = Promise.withResolvers<Response>()
  // Never opened: a code that is polled parks here, so the test decides when
  // the flows overlap instead of waiting on a timer.
  const parked = Promise.withResolvers<Response>()
  const polled: string[] = []
  let requested = 0
  const account = new GitHubAccount({
    vault: new CredentialVault(join(root, 'credentials.vault.json'), protector),
    stateFile: join(root, 'github-account.json'),
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    sleep: async () => {},
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''))
      if (String(input).endsWith('/login/device/code')) {
        requested += 1
        // The first request settles only after a second sign-in replaced it, and
        // it answers with the code it was asked for even though the signal it
        // was given had already been aborted.
        if (requested === 1) return await late.promise
        return new Response(
          JSON.stringify({ ...DEVICE_CODE, user_code: 'CODE-NEW', device_code: 'CODE-NEW' }),
          { status: 200 },
        )
      }
      polled.push(body.get('device_code') ?? '')
      return await parked.promise
    }) as typeof globalThis.fetch,
  })

  const abandoned = account.signIn()
  await waitUntil(() => requested === 1)
  await account.signIn()
  assert.equal(account.status().challenge?.userCode, 'CODE-NEW')

  late.resolve(
    new Response(JSON.stringify({ ...DEVICE_CODE, user_code: 'STALE', device_code: 'STALE' }), {
      status: 200,
    }),
  )
  assert.equal((await abandoned).challenge?.userCode, 'CODE-NEW', 'the answer is refused')
  await drained()

  const still = account.status()
  assert.equal(still.challenge?.userCode, 'CODE-NEW', 'the live code is not overwritten')
  assert.equal(still.signingIn, true, 'the newer sign-in is still in progress')
  assert.equal(still.state, 'signing-in')
  assert.deepEqual(polled, ['CODE-NEW'], 'only the live code is polled')

  // Its Cancel control still belongs to the sign-in that is running.
  const cancelled = await account.cancelSignIn()
  assert.equal(cancelled.signingIn, false)
  assert.equal(cancelled.challenge, null)
  assert.equal(cancelled.state, 'signed-out')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a rejected account metadata write leaves no credential no account owns', async () => {
  const harness = await signedIn([])
  const { clock, protector, stateFile, vaultFile } = harness
  const before = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }
  const { fetch: fetchDouble } = fetchReturning([
    { body: DEVICE_CODE },
    { body: session('ghu_replacement', 'ghr_replacement') },
  ])
  const vault = new CredentialVault(vaultFile, protector)
  const staged: string[] = []
  const removed: string[] = []
  const staging = vault.stage.bind(vault)
  vault.stage = async (host, secret, at) => {
    const reference = await staging(host, secret, at)
    staged.push(reference)
    return reference
  }
  const removing = vault.remove.bind(vault)
  vault.remove = async (reference: string) => {
    removed.push(reference)
    await removing(reference)
  }
  const changes: GitHubAccountStatus[] = []
  const account = new GitHubAccount({
    vault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    now: () => clock.now,
    sleep: async () => {},
    fetch: fetchDouble,
    onChange: (status) => changes.push(status),
  })
  await account.restore()
  assert.equal(account.status().state, 'signed-in')
  // The disk refuses the write the account needs before it can publish the
  // metadata, as a full or read-only user-data directory would.
  await mkdir(`${stateFile}.tmp`)

  await account.signIn()
  const reported = await waitForState(
    changes,
    (status) => status.message === 'Sign-in could not be completed.',
  )

  assert.equal(reported.signingIn, false, 'the failed sign-in does not stay in progress')
  assert.equal(reported.challenge, null)
  assert.deepEqual(staged, removed, 'exactly the staged credential is removed')
  assert.equal(removed.length, 1)
  assert.notEqual(removed[0], before.reference, 'the account that was signed in is not removed')
  assert.deepEqual(
    (await vault.references()).map((entry) => entry.reference),
    [before.reference],
    'no sealed credential is left that no account names',
  )

  // The account that was already signed in is untouched, in memory and on disk.
  assert.equal(account.status().state, 'signed-in')
  assert.equal(account.status().reference, before.reference)
  assert.equal((await account.current())?.token, 'ghu_first')
  assert.match(await vault.open(before.reference), /ghu_first/u)
  const stored = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }
  assert.equal(stored.reference, before.reference, 'the metadata still names the old credential')

  const restarted = new GitHubAccount({
    vault: new CredentialVault(vaultFile, protector),
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    now: () => clock.now,
    identify: async () => 'ada',
  })
  assert.equal((await restarted.restore()).state, 'signed-in')
  assert.equal((await restarted.current())?.token, 'ghu_first')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('an account saved for one host is never restored or opened under another', async () => {
  const harness = await accountUnder(
    [{ body: DEVICE_CODE }, { body: session('ghu_first', 'ghr_first') }],
    { login: 'ada' },
  )
  await harness.account.signIn()
  await harness.settled.promise
  assert.equal(harness.account.status().state, 'signed-in')
  const saved = JSON.parse(await readFile(harness.stateFile, 'utf8')) as {
    host: string
    reference: string
  }
  assert.equal(saved.host, 'github.com')

  const vault = new CredentialVault(harness.vaultFile, harness.protector)
  // The secret opens for the host that issued it.
  assert.ok((await vault.open(saved.reference, 'github.com')).length > 0)
  // And is refused for any other host, before the protector is ever asked.
  await assert.rejects(
    vault.open(saved.reference, 'ghe.example.com'),
    (error: unknown) => (error as { failure?: string }).failure === 'wrong-host',
  )

  // An account pointed at that other host finds nothing to adopt, and issues no
  // request while deciding so.
  let asked = 0
  const other = new GitHubAccount({
    vault: new CredentialVault(harness.vaultFile, harness.protector),
    stateFile: harness.stateFile,
    host: 'ghe.example.com',
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID_6768652E6578616D706C652E636F6D: CLIENT_ID },
    fetch: (async (input: string | URL | Request) => {
      asked += 1
      throw new Error(`unexpected request to ${String(input)}`)
    }) as typeof globalThis.fetch,
    identify: async () => 'ada',
  })
  const status = await other.restore()
  assert.notEqual(status.state, 'signed-in')
  assert.equal(status.reference ?? null, null)
  assert.equal(asked, 0)
})

/**
 * One installation's files, and the account a host change retires.
 *
 * The first account is signed in to github.com over a real vault and state
 * file; `createSuccessor` builds the account the next host gets, at the moment
 * the test asks for it, because the order the two are created in is the whole
 * point. Each records the statuses it publishes, so a report that arrives after
 * the account behind it was replaced is visible rather than assumed.
 */
async function hostSwitchHarness() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-account-'))
  roots.push(root)
  const { protector } = sealingProtector()
  const vaultFile = join(root, 'credentials.vault.json')
  const stateFile = join(root, 'github-account.json')
  const clock = { now: 1_700_000_000_000 }
  const firstChanges: GitHubAccountStatus[] = []
  const secondChanges: GitHubAccountStatus[] = []
  const firstVault = new CredentialVault(vaultFile, protector)
  const first = new GitHubAccount({
    vault: firstVault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    fetch: fetchReturning([{ body: DEVICE_CODE }, { body: session('ghu_dotcom', 'ghr_dotcom') }])
      .fetch,
    identify: async () => 'ada',
    now: () => clock.now,
    sleep: async () => {},
    onChange: (status) => {
      firstChanges.push(status)
    },
  })
  await first.signIn()
  await waitForState(
    firstChanges,
    (status) => status.state === 'signed-in' && status.login === 'ada',
  )
  const createSuccessor = (): GitHubAccount =>
    new GitHubAccount({
      vault: new CredentialVault(vaultFile, protector),
      stateFile,
      host: 'ghe.example.com',
      env: { GIT_STACKS_GITHUB_APP_CLIENT_ID_6768652E6578616D706C652E636F6D: CLIENT_ID },
      fetch: fetchReturning([{ body: DEVICE_CODE }, { body: session('ghu_ghe', 'ghr_ghe') }]).fetch,
      identify: async () => 'grace',
      now: () => clock.now,
      sleep: async () => {},
      onChange: (status) => {
        secondChanges.push(status)
      },
    })
  return {
    createSuccessor,
    first,
    firstChanges,
    firstVault,
    protector,
    secondChanges,
    stateFile,
    vaultFile,
  }
}

test('a host switch cannot retire the account that replaced the retiring one', async () => {
  const {
    createSuccessor,
    first,
    firstChanges,
    firstVault,
    protector,
    secondChanges,
    stateFile,
    vaultFile,
  } = await hostSwitchHarness()
  const before = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }

  // The retirement is held inside the vault, so the successor signs in while the
  // account being retired is still clearing the files they share.
  const gate = Promise.withResolvers<void>()
  let held = true
  let entered = false
  const removing = firstVault.remove.bind(firstVault)
  const clearing = firstVault.clear.bind(firstVault)
  firstVault.remove = async (reference: string) => {
    if (held) {
      entered = true
      await gate.promise
    }
    await removing(reference)
  }
  firstVault.clear = async () => {
    if (held) {
      entered = true
      await gate.promise
    }
    await clearing()
  }

  const signingOut = first.signOut()
  await waitUntil(() => entered)
  // Choosing the next host creates its account while that sign-out is still
  // queued, and the panel is showing the successor from that moment on: every
  // status the retired account reports from here on would repaint it wrongly.
  const successor = createSuccessor()
  firstChanges.length = 0
  const signingIn = successor.signIn()
  gate.resolve()
  await signingOut
  await signingIn
  await waitForState(secondChanges, (status) => status.login === 'grace')

  // The successor's credential and its metadata both survive a retirement that
  // was already in flight when it signed in.
  const after = JSON.parse(await readFile(stateFile, 'utf8')) as {
    reference: string
    host: string
    login: string | null
  }
  assert.equal(after.host, 'ghe.example.com')
  assert.equal(after.login, 'grace')
  assert.notEqual(after.reference, before.reference)
  const vault = new CredentialVault(vaultFile, protector)
  assert.ok((await vault.open(after.reference, 'ghe.example.com')).includes('ghu_ghe'))
  assert.equal((await successor.current())?.token, 'ghu_ghe')
  assert.equal(successor.status().state, 'signed-in')

  // The retired account keeps nothing and reports nothing.
  assert.deepEqual(firstChanges, [], 'the retired account published a status of its own')
  assert.equal(await first.current(), null, 'the retired account hands out no credential')
  assert.equal(first.available(), false)

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a successor claiming before retirement starts still removes the retired credential', async () => {
  const { createSuccessor, first, firstVault, protector, secondChanges, stateFile, vaultFile } =
    await hostSwitchHarness()
  const before = JSON.parse(await readFile(stateFile, 'utf8')) as { reference: string }

  const signingOut = first.signOut()
  const successor = createSuccessor()
  await signingOut

  await assert.rejects(readFile(stateFile, 'utf8'), { code: 'ENOENT' })
  assert.deepEqual(await firstVault.references(), [], 'the old sealed credential was retired')

  await successor.signIn()
  await waitForState(secondChanges, (status) => status.login === 'grace')
  const after = JSON.parse(await readFile(stateFile, 'utf8')) as { host: string; reference: string }
  assert.equal(after.host, 'ghe.example.com')
  assert.notEqual(after.reference, before.reference)
  const vault = new CredentialVault(vaultFile, protector)
  assert.deepEqual(
    (await vault.references()).map(({ reference }) => reference),
    [after.reference],
    'signing in on the new host leaves no orphan from the retired host',
  )

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})

test('a restore that finishes after the account was replaced adopts nothing and reports nothing', async () => {
  const { createSuccessor, protector, secondChanges, stateFile, vaultFile } =
    await hostSwitchHarness()

  // A second start reads the same files, and its read is held open while the
  // host changes underneath it.
  const gate = Promise.withResolvers<void>()
  const vault = new CredentialVault(vaultFile, protector)
  const opening = vault.open.bind(vault)
  vault.open = async (reference: string, expectedHost?: string | null) => {
    await gate.promise
    return opening(reference, expectedHost)
  }
  const changes: GitHubAccountStatus[] = []
  const restoring = new GitHubAccount({
    vault,
    stateFile,
    env: { GIT_STACKS_GITHUB_APP_CLIENT_ID: CLIENT_ID },
    identify: async () => 'ada',
    onChange: (status) => {
      changes.push(status)
    },
  })
  const reading = restoring.restore()
  const successor = createSuccessor()
  const signingIn = successor.signIn()
  gate.resolve()
  await reading
  await signingIn
  await waitForState(secondChanges, (status) => status.login === 'grace')

  assert.equal(await restoring.current(), null, 'nothing is adopted once the account was replaced')
  assert.equal(restoring.available(), false)
  assert.deepEqual(changes, [], 'a replaced account publishes no status of its own')
  const after = JSON.parse(await readFile(stateFile, 'utf8')) as { host: string }
  assert.equal(after.host, 'ghe.example.com')

  setGitHubCredentialSource(null)
  onGitHubFailure(null)
})
