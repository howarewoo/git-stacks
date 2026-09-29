import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
    identify?: (accessToken: string, env: NodeJS.ProcessEnv) => Promise<string | null>
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
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        return new Response(JSON.stringify(DEVICE_CODE), { status: 200 })
      }
      if (body.get('grant_type') === 'refresh_token') {
        if (init?.signal?.aborted) throw new TypeError('fetch failed')
        return await renewal.promise
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
  assert.equal(
    await account.current(),
    'ghu_second',
    'an expired credential is renewed, not handed out',
  )
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
