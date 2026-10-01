import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer as createTlsServer, request as httpsRequest, type Server } from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { CredentialVault, type SecretProtector } from '../src/main/credentials'
import {
  externalGitHubLink,
  githubHostContext,
  type GitHubHostContext,
} from '../src/main/github-host'
import {
  DirectGitHubTransport,
  lastGitHubRateLimit,
  onGitHubRateLimit,
  type GitHubRateLimitReport,
} from '../src/main/github-transport'
import {
  NotificationCenter,
  notificationCredentialStore,
  notificationSubjectUrl,
} from '../src/main/notifications'
import type { NotificationInbox } from '../src/shared/notifications'

/**
 * A real GitHub host on a real TLS socket, not a stubbed fetch. Every fact this
 * module keeps — the `If-Modified-Since` validator it sends back, the
 * `X-Poll-Interval` it waits out, the credential it authenticates with — is
 * therefore observed on the wire, and a request that reached the wrong host or
 * carried the wrong token is visible rather than inferred.
 */
const LAST_MODIFIED = 'Tue, 22 Sep 2026 09:41:07 GMT'

interface Wire {
  method: string
  path: string
  ifModifiedSince: string | null
  authorization: string | null
  body: string
}

interface Host {
  host: string
  context: GitHubHostContext
  wire: Wire[]
  close: () => Promise<void>
}

/**
 * A certificate generated for this run.
 *
 * A subject alternative name is what a client actually checks; the common name
 * alone is ignored, so without one every request here would fail for a reason
 * that has nothing to do with the module under test. A second certificate for
 * the same name is what proves this file trusts one key rather than the address
 * it happens to be talking to.
 */
function generateCertificate(subjectAltName = 'IP:127.0.0.1,DNS:localhost'): {
  key: Buffer
  cert: Buffer
  directory: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'git-stacks-notifications-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-days',
      '1',
      '-addext',
      `subjectAltName=${subjectAltName}`,
      '-subj',
      '/CN=127.0.0.1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return {
    key: readFileSync(join(directory, 'key.pem')),
    cert: readFileSync(join(directory, 'cert.pem')),
    directory,
  }
}

const cert = generateCertificate()

/**
 * The transport every test here uses, pinned to the certificate above and to
 * nothing else.
 *
 * Verification stays on. A suite that reached its host by turning TLS checking
 * off could not observe the one failure that matters most here — a request or a
 * credential leaving for a host this certificate does not cover — and the
 * process-wide switch that turns it off would leak into every other test running
 * beside it.
 */
const verifiedFetch: typeof globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {}
  new Headers(init?.headers ?? {}).forEach((value, name) => {
    headers[name] = value
  })
  const body = typeof init?.body === 'string' ? init.body : undefined

  const answer = await new Promise<{
    status: number
    headers: Record<string, string>
    text: string
  }>((resolve, reject) => {
    const client = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
        ca: cert.cert,
        // RFC 6066 forbids an address in the server name extension and Node warns
        // when one is sent. The certificate is verified against the address
        // itself, so omitting it costs nothing.
        ...(net.isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
      },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () => {
          const received: Record<string, string> = {}
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (typeof value === 'string') received[name] = value
            else if (Array.isArray(value)) received[name] = value.join(', ')
          }
          resolve({
            status: incoming.statusCode ?? 0,
            headers: received,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    const onAbort = () =>
      client.destroy(new DOMException('The operation was aborted.', 'AbortError'))
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    client.on('error', reject)
    client.on('close', () => init?.signal?.removeEventListener('abort', onAbort))
    if (body) client.write(body)
    client.end()
  })

  // 204, 205, and 304 are answers with no body, and a `Response` refuses to be
  // built with one. GitHub's write endpoints answer 205, so this is a status the
  // module is routinely given rather than an edge case.
  const bodyless = answer.status === 204 || answer.status === 205 || answer.status === 304
  return new Response(bodyless ? null : answer.text, {
    status: answer.status,
    headers: answer.headers,
  })
}) as typeof globalThis.fetch

interface Answer {
  status?: number
  body?: unknown
  headers?: Record<string, string | undefined>
}

type Answered = (wire: Wire) => Answer | Promise<Answer>

/**
 * Starts one HTTPS server that answers as a GitHub host on its own origin.
 *
 * The certificate it serves defaults to the one this run trusts, so a suite
 * that reached its own host could not have done it by disabling verification.
 */
async function startHost(
  handler: Answered,
  served: { key: Buffer; cert: Buffer } = cert,
): Promise<Host> {
  const wire: Wire[] = []
  const server: Server = createTlsServer(
    { key: served.key, cert: served.cert },
    (request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'https://placeholder')
        const entry: Wire = {
          method: request.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
          ifModifiedSince: (request.headers['if-modified-since'] as string | undefined) ?? null,
          authorization: (request.headers.authorization as string | undefined) ?? null,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        wire.push(entry)
        void (async () => {
          const answer = await handler(entry)
          response.writeHead(answer.status ?? 200, {
            'content-type': 'application/json',
            ...answer.headers,
          })
          response.end(JSON.stringify(answer.body ?? {}))
        })()
      })
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the host has no port')
  return {
    host: `127.0.0.1:${address.port}`,
    context: githubHostContext(`127.0.0.1:${address.port}`),
    wire,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const SEAL_KEY = 0x5a

/** A key store that genuinely transforms what it seals, so no file holds a token. */
function sealingProtector(): SecretProtector {
  const sealed = new Set<string>()
  return {
    store: () => ({ kind: 'system', name: 'test keychain' }),
    seal: (plain) => {
      const buffer = Buffer.from([...plain].map((character) => character.charCodeAt(0) ^ SEAL_KEY))
      sealed.add(buffer.toString('base64'))
      return buffer
    },
    open: (value) => {
      if (!sealed.has(value.toString('base64'))) throw new Error('the key is locked')
      return String.fromCharCode(...[...value].map((byte) => byte ^ SEAL_KEY))
    },
  }
}

const roots: string[] = []
const certificates: string[] = [cert.directory]

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  await Promise.all(
    certificates.map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/**
 * One installation's storage.
 *
 * The notification store is built through the module's own factory, exactly as
 * the app builds it, so what these tests exercise is the production wiring: one
 * sealed file of its own, held per host across centers. The application's own
 * store is a separate file again, which is what makes the two provably
 * independent rather than merely differently named.
 */
async function installation() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-notifications-state-'))
  roots.push(root)
  return {
    root,
    store: notificationCredentialStore(
      join(root, 'github-notifications-vault.json'),
      sealingProtector(),
    ),
    appVault: new CredentialVault(join(root, 'credentials.vault.json'), sealingProtector()),
    credentialFile: join(root, 'github-notifications.json'),
    cacheFile: join(root, 'github-notifications-cache.json'),
  }
}

/**
 * One thread as GitHub sends it, addressed to the host that sent it.
 *
 * `subject.url` is an API URL on GitHub's own API origin — `api.github.com` for
 * the public host, and the host's `/api/v3` for an enterprise one — which is
 * what a fixture that used a browser URL would fail to exercise.
 */
function thread(host: Host, id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    unread: true,
    reason: 'review_requested',
    subject: {
      title: `Thread ${id}`,
      url: `${host.context.apiBase}/repos/acme/widgets/issues/${id}`,
      type: 'PullRequest',
    },
    repository: { name: 'widgets', owner: { login: 'acme' } },
    updated_at: '2026-09-22T09:41:07Z',
    ...overrides,
  }
}

/** A two-page list, answered the way GitHub links its pages. */
function pagedInbox(host: Host, wire: Wire, first: unknown[], second: unknown[]): Answer {
  if (wire.ifModifiedSince === LAST_MODIFIED) return { status: 304, body: null }
  if (wire.path.includes('page=2')) {
    return { body: second, headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' } }
  }
  return {
    body: first,
    headers: {
      'last-modified': LAST_MODIFIED,
      'x-poll-interval': '60',
      link: `<https://${host.host}/api/v3/notifications?per_page=50&all=true&page=2>; rel="next"`,
    },
  }
}

test('a host this run cannot verify is never read from, so the rest of this file proves something', async () => {
  const store = await installation()
  // The right name, a key this run was never told to trust: the handshake a
  // client that checks certificates refuses, and one that does not check would
  // sail straight through.
  const impostor = generateCertificate('IP:127.0.0.1,DNS:localhost')
  certificates.push(impostor.directory)
  const host = await startHost(
    (wire) =>
      wire.path === '/api/v3/user' ? { body: { login: 'octo' } } : { body: [thread(host, '1')] },
    impostor,
  )
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => Date.parse('2026-09-22T10:00:00.000Z'),
  })
  try {
    await assert.rejects(
      () => center.saveCredential('ghp_notifications_token', true),
      /certificate/u,
      'the failure a refused handshake produces is reported, not swallowed',
    )
    const status = await center.status()
    assert.notEqual(status.state, 'ready', 'an unverified host is not a working inbox')
    assert.equal(
      status.reference,
      null,
      'a token that was never used to reach the host it names is not kept',
    )
    const inbox = await center.refresh()
    assert.deepEqual(inbox.threads, [], 'nothing that host answered is shown')
    assert.equal(
      host.wire.length,
      0,
      'the handshake never completed, so the host saw no request at all',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test("a conditional read sends GitHub's own validator back, replays the whole list on 304, and never asks for page two again", async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return pagedInbox(host, wire, [thread(host, '1'), thread(host, '2')], [thread(host, '3')])
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    const status = await center.saveCredential('ghp_notifications_token', true)
    assert.equal(status.state, 'ready')
    assert.equal(status.login, 'octo')

    const list = await center.inbox()
    assert.equal(list.threads.length, 3, 'both pages are assembled into one inbox')
    assert.equal(list.unreadCount, 3)
    assert.equal(list.poll.lastModified, LAST_MODIFIED, "GitHub's exact validator is kept")
    assert.equal(list.poll.pollIntervalSeconds, 60)
    assert.equal(list.stale, false)

    const reads = host.wire.filter((entry) => entry.path.startsWith('/api/v3/notifications'))
    assert.deepEqual(
      reads.map((entry) => entry.path),
      [
        '/api/v3/notifications?per_page=50&all=true',
        '/api/v3/notifications?per_page=50&all=true&page=2',
      ],
      "GitHub's documented page size and read state are what is asked for",
    )
    assert.equal(
      reads[0].authorization,
      'Bearer ghp_notifications_token',
      'the notification credential is the one that authenticates',
    )
    assert.equal(reads[0].ifModifiedSince, null, 'the first read has no validator to send')

    // Before the interval GitHub asked for, nothing is sent at all.
    clock += 59_000
    const early = await center.refresh()
    assert.equal(host.wire.filter((entry) => entry.path.includes('/notifications')).length, 2)

    clock += 2_000
    const unchanged = await center.refresh()
    assert.equal(unchanged.threads.length, 3, 'a 304 replays the list, not page one of it')
    assert.equal(unchanged.poll.unchanged, true, 'the 304 is reported as one')
    const conditional = host.wire.filter((entry) => entry.path.includes('/notifications'))[2]
    assert.equal(
      conditional.ifModifiedSince,
      LAST_MODIFIED,
      'the validator sent back is exactly the one GitHub issued',
    )
    assert.equal(
      host.wire.filter((entry) => entry.path.includes('/notifications')).length,
      3,
      'a 304 about the list ends the walk; no page two is requested',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('a host that asks for a longer interval is waited out in full, by the timer and by a person asking', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '7200' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_notifications_token', true)
    const list = await center.inbox()
    assert.equal(list.poll.pollIntervalSeconds, 7200, 'a two-hour interval is taken as sent')

    const sentAfterSave = host.wire.filter((entry) => entry.path.includes('/notifications')).length

    // The interval this build would use as its own ceiling, an hour in.
    clock += 3_600_000
    await center.refresh()
    assert.equal(
      host.wire.filter((entry) => entry.path.includes('/notifications')).length,
      sentAfterSave,
      "an hour is not this build's decision to make; GitHub asked for two",
    )

    clock += 3_600_000
    await center.refresh()
    assert.equal(
      host.wire.filter((entry) => entry.path.includes('/notifications')).length,
      sentAfterSave + 1,
      'the read runs once the interval GitHub named has passed',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('the interval a stored list was read under survives a restart', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '600' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_notifications_token', true)
    const before = host.wire.filter((entry) => entry.path.includes('/notifications')).length

    clock += 120_000
    const restarted = new NotificationCenter({
      host: host.context,
      fetch: verifiedFetch,
      store: store.store,
      credentialFile: store.credentialFile,
      cacheFile: store.cacheFile,
      consent: () => ({ enabled: true, policyDisabled: false }),
      now: () => clock,
    })
    const restored = await restarted.inbox()
    assert.equal(restored.threads.length, 1, 'the stored list is what the next run shows')
    assert.equal(restored.poll.lastModified, LAST_MODIFIED, 'the stored validator is reused')
    await restarted.refresh()
    assert.equal(
      host.wire.filter((entry) => entry.path.includes('/notifications')).length,
      before,
      'a restart two minutes in does not outrun the ten minutes GitHub asked for',
    )

    clock += 480_000
    await restarted.refresh()
    const conditional = host.wire.filter((entry) => entry.path.includes('/notifications')).at(-1)
    assert.equal(
      conditional?.ifModifiedSince,
      LAST_MODIFIED,
      'the first read of the new run is conditional on the stored validator',
    )
    restarted.forget()
  } finally {
    center.forget()
    await host.close()
  }
})

test('a credential stored for one host is never opened, or sent, by another host', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const first = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return { body: [thread(first, '1')], headers: { 'last-modified': LAST_MODIFIED } }
  })
  // The other host is answered for nothing here: this test is about what its
  // neighbour's credential may not reach, not about its own inbox.
  const second = await startHost(() => ({ body: [] }))
  const other = new NotificationCenter({
    host: second.context,
    fetch: verifiedFetch,
    store: store.store,
    // The same file the first host's credential is stored in: a credential
    // belongs to a host, and the file it was written to does not make it shared.
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  const original = new NotificationCenter({
    host: first.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await original.saveCredential('ghp_notifications_token', true)
    assert.equal((await original.inbox()).threads.length, 1)

    const status = await other.status()
    assert.equal(status.host, second.host)
    assert.equal(status.state, 'credential-missing')
    assert.match(String(status.message), /different GitHub host/u)
    const inbox = await other.refresh()
    assert.deepEqual(inbox.threads, [], "another host's list is never shown here")
    assert.equal(
      second.wire.length,
      0,
      'the other host is not asked anything: there is no credential it may use',
    )
  } finally {
    original.forget()
    other.forget()
    await first.close()
    await second.close()
  }
})

test("an account switch drops the previous account's list instead of showing it under the new one", async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const logins: Record<string, string> = {
    ghp_octo: 'octo',
    ghp_hubot: 'hubot',
  }
  const host = await startHost((wire) => {
    const token = (wire.authorization ?? '').replace('Bearer ', '')
    if (wire.path === '/api/v3/user') return { body: { login: logins[token] ?? 'nobody' } }
    return {
      body: [thread(host, token === 'ghp_octo' ? '1' : '7')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_octo', true)
    assert.deepEqual(
      (await center.inbox()).threads.map((entry) => entry.id),
      ['1'],
    )

    const switched = await center.saveCredential('ghp_hubot', true)
    assert.equal(switched.login, 'hubot')
    const inbox = await center.inbox()
    assert.deepEqual(
      inbox.threads.map((entry) => entry.id),
      ['7'],
      'the inbox on screen belongs to the account that is signed in to it',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test("this module's credential and the application's own are sealed separately, and neither cleanup touches the other", async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return { body: [thread(host, '1')], headers: { 'last-modified': LAST_MODIFIED } }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    // The credential the rest of the app signs in with, sealed in the store the
    // account side owns and clears wholesale when it has no identity left.
    const appReference = await store.appVault.stage('127.0.0.1', 'gho_application_session', clock)
    const notification = await center.saveCredential('ghp_notifications_token', true)
    assert.equal(notification.state, 'ready')
    assert.equal(
      await store.appVault.open(appReference, '127.0.0.1'),
      'gho_application_session',
      'the application credential is sealed in its own store, untouched by this module',
    )
    // What the account side does when no App identity is left: it empties the
    // whole store it owns. Nothing it does can reach a notification token, and
    // nothing this module does can have reached the sign-in in the first place.
    await store.appVault.clear()
    assert.deepEqual(await store.appVault.references(), [], 'the application store is emptied')
    clock += 61_000
    const stillReading = await center.refresh()
    assert.equal(stillReading.state, 'ready', 'the notification token is not the app store to lose')
    assert.deepEqual(
      stillReading.threads.map((entry) => entry.id),
      ['1'],
      'the inbox still reads with the credential this module sealed for itself',
    )

    // And the other direction, against a sign-in that is sealed right now: the
    // sign-out that follows has nothing of this module's to take, because
    // discarding this module's credential is a change to this module's files
    // alone.
    const secondReference = await store.appVault.stage(
      '127.0.0.1',
      'gho_application_session_again',
      clock,
    )
    const afterRemoval = await center.removeCredential()
    assert.equal(afterRemoval.state, 'credential-missing')
    assert.equal(afterRemoval.reference, null)
    assert.deepEqual(
      await store.store.vault.references(),
      [],
      'only this module credential was removed, and nothing of the app was in this store',
    )
    assert.equal(
      await store.appVault.open(secondReference, '127.0.0.1'),
      'gho_application_session_again',
      "the application's credential survives this module removing its own",
    )
    assert.deepEqual((await center.inbox()).threads, [], 'the list read with it is gone')
  } finally {
    center.forget()
    await host.close()
  }
})

test('policy holds this module off without asking GitHub anything, and policy or consent alone decides', async () => {
  const store = await installation()
  let locked = false
  const consent = () => ({ enabled: true, policyDisabled: locked })
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return { body: [thread(host, '1')], headers: { 'last-modified': LAST_MODIFIED } }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent,
    now: () => Date.parse('2026-09-22T10:00:00.000Z'),
  })
  try {
    await center.saveCredential('ghp_notifications_token', true)
    const asked = host.wire.length
    assert.ok(asked > 0)

    locked = true
    const held = await center.refresh()
    assert.equal(held.state, 'policy-disabled')
    assert.equal(held.threads.length, 0, 'a held module shows no list it may not keep polling')
    assert.equal(host.wire.length, asked, 'a held module asks the host for nothing')
    await assert.rejects(() => center.saveCredential('ghp_another_token', true), /policy/u)
  } finally {
    center.forget()
    await host.close()
  }
})

test('the token never reaches a file, a status object, or an error', async () => {
  const store = await installation()
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return { status: 500, body: { message: 'Server Error' } }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => Date.parse('2026-09-22T10:00:00.000Z'),
  })
  try {
    const status = await center.saveCredential('ghp_never_written_down', true)
    assert.ok(!JSON.stringify(status).includes('ghp_never_written_down'))
    const inbox = await center.inbox()
    assert.ok(!JSON.stringify(inbox).includes('ghp_never_written_down'))

    for (const name of await readdir(store.root)) {
      const body = await readFile(join(store.root, name), 'utf8')
      assert.ok(
        !body.includes('ghp_never_written_down'),
        `${name} must not hold the notification credential`,
      )
    }
  } finally {
    center.forget()
    await host.close()
  }
})

test('an unreachable host leaves the last confirmed list standing, marked stale with the reason', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  let reachable = true
  const host = await startHost((wire) => {
    if (!reachable) return { status: 500, body: { message: 'unreachable' } }
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_notifications_token', true)
    assert.equal((await center.inbox()).threads.length, 1)

    await host.close()
    reachable = false
    clock += 61_000
    const offline = await center.refresh()
    assert.equal(offline.threads.length, 1, 'the last confirmed list still stands')
    assert.equal(offline.stale, true)
    assert.equal(offline.staleReason, 'offline')
    assert.ok(
      Date.parse(String(offline.poll.nextPollAt)) >= clock + 60_000,
      'a failure backs the next attempt off rather than retrying immediately',
    )
  } finally {
    center.forget()
  }
})

test('a write whose answer never arrives is sent once and never replayed', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    if (wire.method === 'PATCH') {
      // GitHub applies the change and the answer is lost on the way back.
      return { status: 500, body: { message: 'the answer was lost' } }
    }
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_notifications_token', true)
    const before = await center.inbox()
    assert.equal(before.threads[0]?.unread, true)

    await assert.rejects(
      () => center.markRead('1'),
      /was not sent again|answer was lost/u,
      'an uncertain write says what it could not do',
    )
    const writes = host.wire.filter((entry) => entry.method === 'PATCH')
    assert.equal(writes.length, 1, 'the change is sent once, never replayed on its own')
    assert.equal(writes[0]?.path, '/api/v3/notifications/threads/1')
    const after = await center.inbox()
    assert.equal(
      after.threads[0]?.unread,
      true,
      'a write GitHub never confirmed leaves the inbox as it was',
    )

    clock += 61_000
    await center.refresh()
    assert.equal(
      host.wire.filter((entry) => entry.method === 'PATCH').length,
      1,
      'the next read is a read; it does not repeat the write',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('mark read and subscription controls address exactly the endpoints GitHub documents', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    if (wire.ifModifiedSince === LAST_MODIFIED) return { status: 304, body: null }
    if (wire.method !== 'GET') return { status: 205, body: {} }
    return {
      body: [thread(host, '1'), thread(host, '2')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_notifications_token', true)

    const one: NotificationInbox = await center.markRead('1')
    assert.equal(one.threads.find((entry) => entry.id === '1')?.unread, false)
    assert.equal(one.threads.find((entry) => entry.id === '2')?.unread, true)

    const all: NotificationInbox = await center.markRead('all')
    assert.equal(
      all.unreadCount,
      0,
      'marking the whole inbox read is answered by what that request did, not by an earlier snapshot',
    )
    assert.deepEqual(
      all.threads.map((entry) => entry.unread),
      [false, false],
      'every thread the bulk request covered is read afterwards',
    )

    const ignored = await center.setSubscription('2', 'ignore')
    assert.equal(ignored.threads.length, 2, 'an ignored thread leaves the inbox it was in')

    await center.setSubscription('2', 'unsubscribe')
    const remaining = await center.inbox()
    assert.deepEqual(
      remaining.threads.map((entry) => entry.id),
      ['1'],
      'an unsubscribed thread is no longer in this list',
    )

    assert.deepEqual(
      host.wire
        .filter((entry) => entry.method !== 'GET')
        .map((entry) => `${entry.method} ${entry.path}`),
      [
        'PATCH /api/v3/notifications/threads/1',
        // GitHub documents the inbox-wide operation as `PUT`; only one thread
        // is a `PATCH`. The bulk request is a different operation.
        'PUT /api/v3/notifications',
        'PUT /api/v3/notifications/threads/2/subscription',
        'DELETE /api/v3/notifications/threads/2/subscription',
      ],
    )

    // What this module acknowledged has to survive the conditional read that
    // follows it and the restart after that: the 304 replays the list GitHub
    // confirmed, and the acknowledgement is part of that list now.
    clock += 61_000
    const unchanged = await center.refresh()
    assert.equal(unchanged.poll.unchanged, true, 'GitHub answered 304 about the list')
    assert.deepEqual(
      unchanged.threads.map((entry) => entry.id),
      ['1'],
      'a thread unsubscribed after the last full read does not come back on 304',
    )
    const restarted = new NotificationCenter({
      host: host.context,
      fetch: verifiedFetch,
      store: store.store,
      credentialFile: store.credentialFile,
      cacheFile: store.cacheFile,
      consent: () => ({ enabled: true, policyDisabled: false }),
      now: () => clock,
    })
    const restored = await restarted.inbox()
    assert.deepEqual(
      restored.threads.map((entry) => entry.id),
      ['1'],
      'the stored list is what the next run reads, acknowledged changes included',
    )
    assert.equal(
      restored.threads[0]?.unread,
      false,
      'a thread marked read before the restart is still read after it',
    )
    restarted.forget()
  } finally {
    center.forget()
    await host.close()
  }
})

/** A promise a test opens by hand, so a slow answer arrives when it is wanted. */
function deferred(): { settled: Promise<void>; release: () => void } {
  let open = (): void => {}
  const settled = new Promise<void>((resolve) => {
    open = resolve
  })
  return { settled, release: () => open() }
}

test('a read in flight when the credential is replaced publishes nothing of the old account', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const gate = deferred()
  // The gate arms only once a credential is stored: the read a store triggers is
  // not the one this test is about, and holding it would just wait out the
  // transport's own timeout.
  let armed = false
  const logins: Record<string, string> = { ghp_octo: 'octo', ghp_hubot: 'hubot' }
  const host = await startHost(async (wire) => {
    const token = (wire.authorization ?? '').replace('Bearer ', '')
    if (wire.path === '/api/v3/user') return { body: { login: logins[token] ?? 'nobody' } }
    // The first account's list is slow to arrive, and arrives after the
    // credential it was asked for has been replaced.
    if (armed && token === 'ghp_octo' && !wire.path.includes('page=2')) {
      await gate.settled
      return {
        body: [thread(host, 'slow')],
        headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
      }
    }
    return {
      body: [thread(host, '7')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_octo', true)
    armed = true
    clock += 61_000

    const slowRead = center.refresh()
    // The replacement is committed before the slow answer is allowed to land,
    // so the answer cannot arrive inside the window it was sent for.
    const switched = await center.saveCredential('ghp_hubot', true)
    gate.release()
    const slow = await slowRead

    assert.equal(switched.login, 'hubot')
    assert.deepEqual(
      (await center.inbox()).threads.map((entry) => entry.id),
      ['7'],
      'the slow list belongs to the credential that was replaced',
    )
    assert.ok(
      !slow.threads.some((entry) => entry.id === 'slow'),
      "the replaced credential's list is never published",
    )
    const stored = JSON.parse(await readFile(store.cacheFile, 'utf8')) as {
      login: string
      threads: { id: string }[]
    }
    assert.equal(stored.login, 'hubot', 'the stored list names the account it was read for')
    assert.deepEqual(
      stored.threads.map((entry) => entry.id),
      ['7'],
      "one account's threads are never written under another account's name",
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('a credential replaced while the key store is answering never reaches the network', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const gate = deferred()
  let slowOpen = false
  const open = store.store.vault.open.bind(store.store.vault)
  store.store.vault.open = async (...args: Parameters<CredentialVault['open']>) => {
    if (slowOpen) await gate.settled
    return open(...args)
  }
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_octo', true)
    clock += 61_000
    const before = host.wire.filter((entry) => entry.path.includes('/notifications')).length

    slowOpen = true
    const reading = center.refresh()
    const removed = center.removeCredential()
    gate.release()
    await reading
    await removed

    assert.equal(
      host.wire.filter((entry) => entry.path.includes('/notifications')).length,
      before,
      'a read that lost its credential while the key store answered asks nothing',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('two reads asked at once produce one request', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const gate = deferred()
  let armed = false
  let first = true
  const host = await startHost(async (wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    // The read that overlaps the two callers answers with a different thread
    // than the one already stored, so each caller's answer says which read it
    // was given rather than only that a thread is present.
    if (armed && first) {
      first = false
      await gate.settled
      return {
        body: [thread(host, '2')],
        headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
      }
    }
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    await center.saveCredential('ghp_octo', true)
    armed = true
    clock += 61_000
    const asked = host.wire.filter((entry) => entry.path.includes('/notifications')).length

    const both = Promise.all([center.refresh(), center.refresh()])
    gate.release()
    const [one, two] = await both
    assert.equal(
      host.wire.filter((entry) => entry.path.includes('/notifications')).length - asked,
      1,
      'the second caller waits its turn instead of racing a second request out',
    )
    // The caller that found a read in flight is answered with the list as it
    // stood when it arrived; the caller that was waiting gets the one GitHub
    // just sent. Neither is handed the other's list.
    assert.deepEqual(
      one.threads.map((entry) => entry.id),
      ['2'],
      'the caller that waited is given the read GitHub answered',
    )
    assert.deepEqual(
      two.threads.map((entry) => entry.id),
      ['1'],
      'the caller that arrived during it is given what was already known',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

/** A center over one installation's files, on the host it addresses. */
function centerFor(
  store: Awaited<ReturnType<typeof installation>>,
  host: Host,
  clock: () => number,
  consent: () => { enabled: boolean; policyDisabled: boolean } = () => ({
    enabled: true,
    policyDisabled: false,
  }),
): NotificationCenter {
  return new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    store: store.store,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent,
    now: clock,
  })
}

/** Waits for something a test cannot know the exact turn of, and says if it never came. */
async function eventually(established: () => boolean, detail: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (established()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting: ${detail}`)
}

const READY = { enabled: true, policyDisabled: false }

/**
 * Starts work this test settles later.
 *
 * The outcome is claimed now, so a failure that arrives while the test is
 * arranging the conditions that cause it is reported as that test's outcome
 * rather than as an unhandled rejection of nothing.
 */
function settling<T>(work: Promise<T>): () => Promise<{ value: T | null; error: unknown }> {
  const claimed = work.then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  )
  return () => claimed
}

test('the stored list is restored as what was written, through a 304 and across a restart', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    if (wire.ifModifiedSince === LAST_MODIFIED) return { status: 304, body: null }
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = centerFor(store, host, () => clock)
  try {
    await center.saveCredential('ghp_notifications_token', true)
    const read = (await center.inbox()).threads[0]
    assert.ok(read, 'the host answered with one thread')

    // The file is this build's own schema, so what a restart reads back is
    // decidable from the file itself rather than inferred from a row count.
    const stored = JSON.parse(await readFile(store.cacheFile, 'utf8')) as {
      threads: Record<string, unknown>[]
    }
    assert.deepEqual(
      stored.threads[0],
      read,
      'the stored row is the thread this build shows, field for field',
    )

    clock += 61_000
    const restarted = centerFor(store, host, () => clock)
    assert.deepEqual(
      (await restarted.inbox()).threads[0],
      read,
      'a restart restores every field, not an untitled row with no repository',
    )
    const unchanged = await restarted.refresh()
    assert.equal(
      unchanged.poll.unchanged,
      true,
      'the restart read was conditional and answered 304',
    )
    assert.deepEqual(unchanged.threads[0], read, 'a 304 replays what was stored, field for field')
    restarted.forget()
  } finally {
    center.forget()
    await host.close()
  }
})

test('a read GitHub acknowledged is still read after a 304 and after a restart', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    if (wire.method === 'PUT' || wire.method === 'PATCH') return { status: 205 }
    if (wire.ifModifiedSince === LAST_MODIFIED) return { status: 304, body: null }
    return {
      body: [thread(host, '1'), thread(host, '2')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = centerFor(store, host, () => clock)
  try {
    await center.saveCredential('ghp_notifications_token', true)
    assert.equal((await center.inbox()).unreadCount, 2, 'the host answered with two unread threads')

    const marked = await center.markRead('all')
    assert.equal(
      marked.unreadCount,
      0,
      'the inbox the call returns is the one the change left behind',
    )
    assert.equal(
      host.wire.filter((entry) => entry.method === 'PUT').length,
      1,
      'marking the whole inbox read is one request, and it is the documented one',
    )
    assert.equal(
      host.wire.some((entry) => entry.path === '/api/v3/notifications' && entry.method === 'PUT'),
      true,
      'sent as the inbox-wide endpoint rather than a thread at a time',
    )

    clock += 61_000
    const conditional = await center.refresh()
    assert.equal(conditional.poll.unchanged, true, 'the next read was conditional and answered 304')
    assert.deepEqual(
      conditional.threads.map((entry) => entry.unread),
      [false, false],
      'a 304 replays what GitHub now holds, not what it held before the change',
    )

    const restarted = centerFor(store, host, () => clock)
    assert.deepEqual(
      (await restarted.inbox()).threads.map((entry) => entry.unread),
      [false, false],
      'and the restart this build reads from the same store still knows they are read',
    )
    restarted.forget()
  } finally {
    center.forget()
    await host.close()
  }
})

test('a notification subject becomes a page on the host that sent it, and only that', () => {
  const dotcom = githubHostContext('github.com')
  assert.equal(
    notificationSubjectUrl('https://api.github.com/repos/acme/widgets/issues/123', dotcom),
    'https://github.com/acme/widgets/issues/123',
    "the public host's API URL is the page a person reads",
  )
  const enterprise = githubHostContext('github.example')
  assert.equal(
    notificationSubjectUrl('https://github.example/api/v3/repos/acme/widgets/pulls/7', enterprise),
    'https://github.example/acme/widgets/pull/7',
    "an enterprise host's API path is moved onto its own web route, singular where GitHub's web route is",
  )
  assert.equal(
    notificationSubjectUrl(
      'https://github.example/api/v3/repos/acme/widgets/issues/102',
      enterprise,
    ),
    'https://github.example/acme/widgets/issues/102',
    'a subject whose web route matches its API path keeps it',
  )
  assert.equal(
    notificationSubjectUrl('https://api.github.com/repos/acme/widgets/pulls/101', enterprise),
    null,
    "another host's API is not this host's to interpret: its repository path is not this host's page either",
  )
  assert.equal(
    notificationSubjectUrl('https://api.elsewhere.example/repos/acme/widgets/pulls/1', enterprise),
    null,
    'and an origin that serves no GitHub API at all is refused the same way',
  )
  assert.equal(
    notificationSubjectUrl('https://github.example/acme/widgets/pulls/101', enterprise),
    null,
    'a subject that is not this host API URL is not rewritten into one',
  )
  assert.equal(
    notificationSubjectUrl('https://github.example/api/v3/users/octo', enterprise),
    null,
    'a subject that is not a repository gets no link rather than a broken one',
  )

  // The point of the rewrite is that what the inbox exposes is the page, on this
  // host, and that the gate the renderer opens links through accepts it.
  const resolved = notificationSubjectUrl(
    'https://github.example/api/v3/repos/acme/widgets/pulls/7',
    enterprise,
  )
  assert.deepEqual(
    externalGitHubLink(resolved, [enterprise]),
    { ok: true, href: 'https://github.example/acme/widgets/pull/7' },
    'the link the inbox exposes is a page on this host, and the gate opens it',
  )
  assert.equal(
    externalGitHubLink('https://api.github.com/repos/acme/widgets/pulls/101', [enterprise]).ok,
    false,
    'while the API URL GitHub sent is refused by that same gate, which is why it is resolved first',
  )
})

test('a thread read from a host is published with a page on that host, not the API URL', async () => {
  const store = await installation()
  const clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return {
      body: [
        thread(host, '101', {
          subject: {
            title: 'A pull request',
            url: `${host.context.apiBase}/repos/acme/widgets/pulls/101`,
            type: 'PullRequest',
          },
        }),
        thread(host, '102'),
      ],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = centerFor(store, host, () => clock)
  try {
    await center.saveCredential('ghp_notifications_token', true)
    const inbox = await center.inbox()
    assert.deepEqual(
      inbox.threads.map((entry) => entry.url),
      [
        `https://${host.host}/acme/widgets/pull/101`,
        `https://${host.host}/acme/widgets/issues/102`,
      ],
      'each thread is published as the page a person opens on this host',
    )
    assert.deepEqual(
      inbox.threads.map((entry) => externalGitHubLink(entry.url, [host.context]).ok),
      [true, true],
      'and every published link is one this installation is willing to open',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('an empty inbox nobody can confirm any more is stale, not a current answer', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return { body: [], headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' } }
  })
  const center = centerFor(store, host, () => clock)
  try {
    await center.saveCredential('ghp_notifications_token', true)
    const confirmed = await center.inbox()
    assert.deepEqual(confirmed.threads, [], 'the host confirmed an empty inbox')
    assert.equal(confirmed.stale, false, 'a confirmed empty answer is current')
    assert.equal(confirmed.staleReason, null)

    await host.close()
    clock += 61_000
    const offline = await center.refresh()
    assert.deepEqual(offline.threads, [], 'there is nothing to show either way')
    assert.equal(
      offline.stale,
      true,
      'an empty result that is no longer confirmed is stale, whatever it holds',
    )
    assert.equal(offline.staleReason, 'offline', 'and it says why')
  } finally {
    center.forget()
  }
})

test('a rate-limited host is asked again no sooner than it said, by the timer and by a person', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  // GitHub's own refusal, in the two forms it uses: a wait to count out, and a
  // time at which the budget returns.
  const resetAt = Math.floor(Date.parse('2026-09-22T10:20:00.000Z') / 1000)
  let refusal: Answer = { status: 503, body: { message: 'not asked yet' } }
  const refused = (wait: string | null, reset: string | null): Answer => ({
    status: 429,
    body: { message: 'API rate limit exceeded' },
    headers: {
      'x-poll-interval': '60',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0',
      ...(reset === null ? {} : { 'x-ratelimit-reset': reset }),
      ...(wait === null ? {} : { 'retry-after': wait }),
    },
  })
  // The first read establishes the interval; the refusals come after it, which
  // is the case that decides the next attempt.
  let ask = false
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return ask ? refusal : { body: [thread(host, '1')] }
  })
  const center = centerFor(store, host, () => clock)
  try {
    await center.saveCredential('ghp_notifications_token', true)
    assert.equal((await center.inbox()).poll.pollIntervalSeconds, 60)
    ask = true
    refusal = refused('600', null)
    clock += 61_000
    await center.refresh()
    const limited = await center.inbox()
    assert.equal(limited.state, 'ready', 'a rate-limited read is not a rejected credential')
    assert.equal(
      Date.parse(String(limited.poll.nextPollAt)),
      clock + 600_000,
      'the Retry-After the host sent is the floor, not the interval it named',
    )
    assert.equal(limited.staleReason, 'failed')

    const asked = host.wire.filter((entry) => entry.path.includes('/notifications')).length
    clock += 599_000
    await center.refresh()
    assert.equal(
      host.wire.filter((entry) => entry.path.includes('/notifications')).length,
      asked,
      'a person asking does not outrun what the host said to wait',
    )

    ask = false
    clock += 2_000
    const read = await center.refresh()
    assert.equal(read.threads.length, 1, 'the read runs once the host said it would answer')

    // A refusal that names a reset time instead of a wait is held to that time.
    refusal = refused(null, String(resetAt))
    ask = true
    clock += 61_000
    await center.refresh()
    const resetOnly = await center.inbox()
    assert.equal(
      Date.parse(String(resetOnly.poll.nextPollAt)),
      resetAt * 1000,
      'the reset time in the headers is a floor of its own',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('a partial walk keeps the interval page one named, and backs off from it', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  let armed = false
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    if (!armed) {
      return {
        body: [thread(host, '1')],
        headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
      }
    }
    if (wire.path.includes('page=2')) return { status: 500, body: { message: 'Server Error' } }
    return {
      body: [thread(host, '1')],
      headers: {
        'last-modified': LAST_MODIFIED,
        'x-poll-interval': '7200',
        link: `<https://${host.host}/api/v3/notifications?per_page=50&all=true&page=2>; rel="next"`,
      },
    }
  })
  const center = centerFor(store, host, () => clock)
  try {
    await center.saveCredential('ghp_notifications_token', true)
    armed = true
    clock += 61_000
    const failed = await center.refresh()
    assert.equal(
      failed.poll.pollIntervalSeconds,
      7200,
      'a page two that failed cannot un-teach this build the interval page one asked for',
    )
    assert.equal(
      Date.parse(String(failed.poll.nextPollAt)),
      clock + 7_200_000,
      'the next read is floored by the interval the host named',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('this module spends its own rate budget and never moves the application', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return {
      status: 429,
      body: { message: 'API rate limit exceeded' },
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'retry-after': '600',
      },
    }
  })
  const reports: GitHubRateLimitReport[] = []
  const listen = onGitHubRateLimit((report) => reports.push(report))
  try {
    // What the rest of the app does with its own credential, which is what a
    // healthy process-wide budget looks like.
    await new DirectGitHubTransport({
      apiUrl: host.context.apiBase,
      host: host.host,
      env: {},
      fetch: verifiedFetch,
      token: 'gho_application_session',
    }).rest({ path: 'user' })
    assert.equal(reports.length, 1, "the application's own request is what reported")
    const budget = lastGitHubRateLimit()

    const center = centerFor(store, host, () => clock)
    try {
      await center.saveCredential('ghp_notifications_token', true)
      await center.refresh()
      assert.equal(
        reports.length,
        1,
        "this module's reads, its refusals, and its rate limit are none of the app's business",
      )
      assert.equal(
        lastGitHubRateLimit().at,
        budget.at,
        'the budget every other caller reads is exactly the one it was',
      )
      assert.equal(
        Date.parse(String((await center.inbox()).poll.nextPollAt)),
        clock + 600_000,
        'its own floor is still honoured locally, without being published anywhere',
      )
    } finally {
      center.forget()
    }
  } finally {
    listen()
    await host.close()
  }
})

test('a token still being identified when this inbox changes is never stored or left sealed', async () => {
  for (const boundary of ['removed', 'replaced', 'turned off'] as const) {
    const store = await installation()
    let clock = Date.parse('2026-09-22T10:00:00.000Z')
    const gate = deferred()
    let armed = false
    const logins: Record<string, string> = {
      ghp_octo: 'octo',
      ghp_hubot: 'hubot',
      ghp_pending: 'hubot',
    }
    const host = await startHost(async (wire) => {
      const token = (wire.authorization ?? '').replace('Bearer ', '')
      if (wire.path === '/api/v3/user') {
        // Only this token is slow to identify, so a boundary the test creates
        // after it is free to commit the one that is not being held.
        if (token === 'ghp_pending' && armed) await gate.settled
        return { body: { login: logins[token] ?? 'nobody' } }
      }
      return {
        body: [thread(host, token === 'ghp_octo' ? '1' : '7')],
        headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
      }
    })
    let consent = READY
    const center = centerFor(
      store,
      host,
      () => clock,
      () => consent,
    )
    try {
      if (boundary !== 'removed') {
        await center.saveCredential('ghp_octo', true)
        assert.equal((await center.status()).login, 'octo')
      }
      // The credential this module already holds, which the boundary may retire,
      // replace, or leave where it is — and which the abandoned save must not.
      const seeded = (await center.status()).reference
      armed = true
      const pending = settling(center.saveCredential('ghp_pending', true))
      await eventually(
        () =>
          host.wire.some(
            (entry) =>
              entry.path === '/api/v3/user' && entry.authorization === 'Bearer ghp_pending',
          ),
        'the second token reached the host to be identified',
      )

      if (boundary === 'removed') await center.removeCredential()
      else if (boundary === 'replaced') await center.saveCredential('ghp_hubot', true)
      else {
        consent = { enabled: false, policyDisabled: false }
        center.stop()
      }
      gate.release()
      const outcome = await pending()
      assert.match(
        String(outcome.error),
        /was not stored/u,
        `a save that lost its boundary (${boundary})`,
      )

      // Whatever this module still holds is the one and only sealed secret: the
      // abandoned save left nothing beside it, and took nothing away with it.
      const surviving = (await center.status()).reference
      const sealed = await store.store.vault.references()
      assert.deepEqual(
        sealed.map((entry) => entry.reference),
        surviving === null ? [] : [surviving],
        `nothing the abandoned save sealed is left beside the credential this module kept (${boundary})`,
      )
      if (boundary === 'replaced') {
        assert.notEqual(
          surviving,
          seeded,
          'a replacement is the credential that survives, not the one it superseded',
        )
        assert.equal(
          (await center.status()).login,
          'hubot',
          'and it is the one this module reads with',
        )
      } else {
        assert.equal(
          surviving,
          seeded,
          boundary === 'turned off'
            ? 'turning the module off leaves the credential it already had'
            : 'a removed credential is not left sealed',
        )
      }
    } finally {
      center.forget()
      await host.close()
    }
  }
})

test('a replacement retires the secret it superseded, and a write in flight changes nothing', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const held = deferred()
  let armed = false
  const logins: Record<string, string> = { ghp_octo: 'octo', ghp_hubot: 'hubot' }
  const host = await startHost(async (wire) => {
    const token = (wire.authorization ?? '').replace('Bearer ', '')
    if (wire.path === '/api/v3/user') return { body: { login: logins[token] ?? 'nobody' } }
    if (armed && wire.method === 'PATCH') {
      // GitHub receives the change and the answer never comes back: what is
      // left to this module is an unknown, which is never retried.
      await held.settled
      return { status: 401, body: { message: 'Bad credentials' } }
    }
    return {
      body: [thread(host, token === 'ghp_octo' ? '1' : '7')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = centerFor(store, host, () => clock)
  try {
    const first = await center.saveCredential('ghp_octo', true)
    const superseded = String(first.reference)
    assert.equal((await store.store.vault.references()).length, 1)

    armed = true
    const writing = settling(center.markRead('1'))
    await eventually(
      () => host.wire.some((entry) => entry.method === 'PATCH'),
      'the change reached GitHub',
    )
    // The credential is replaced while that change is unanswered. Its outcome
    // belongs to a token this module is no longer using.
    const switched = await center.saveCredential('ghp_hubot', true)
    held.release()
    const outcome = await writing()
    assert.equal(outcome.value, null, 'the change was not applied to anything on screen')
    assert.match(String(outcome.error), /was not sent again/u)

    const status = await center.status()
    assert.equal(status.login, 'hubot', 'the credential in use is the replacement')
    assert.equal(
      status.state,
      'ready',
      'a refusal that arrives after the replacement is not this credential being refused',
    )
    assert.deepEqual(
      (await store.store.vault.references()).map((entry) => entry.reference),
      [String(switched.reference)],
      'the superseded secret is retired, not left sealed beside its replacement',
    )
    assert.notEqual(switched.reference, superseded)
    assert.deepEqual(
      (await center.inbox()).threads.map((entry) => entry.id),
      ['7'],
      'the list belongs to the credential that is in use',
    )
    assert.equal(
      host.wire.filter((entry) => entry.method === 'PATCH').length,
      1,
      'the change was sent once and never replayed',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('a write waiting on the key store is not sent after consent is withdrawn', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const gate = deferred()
  let slowOpen = false
  let opening = false
  const open = store.store.vault.open.bind(store.store.vault)
  store.store.vault.open = async (...args: Parameters<CredentialVault['open']>) => {
    if (slowOpen) {
      opening = true
      await gate.settled
    }
    return open(...args)
  }
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  let consent = READY
  const center = centerFor(
    store,
    host,
    () => clock,
    () => consent,
  )
  try {
    await center.saveCredential('ghp_notifications_token', true)
    const before = host.wire.filter((entry) => entry.method !== 'GET').length

    slowOpen = true
    const writing = settling(center.markRead('1'))
    await eventually(() => opening, 'the change is waiting on the key store')
    consent = { enabled: false, policyDisabled: false }
    center.stop()
    gate.release()
    const outcome = await writing()
    assert.equal(outcome.value, null)
    assert.match(String(outcome.error), /was not sent/u)

    assert.equal(
      host.wire.filter((entry) => entry.method !== 'GET').length,
      before,
      'nothing reached GitHub after the module was turned off',
    )
    assert.equal((await center.status()).state, 'disabled')
    consent = READY
  } finally {
    center.forget()
    await host.close()
  }
})

test('a list being written when its credential went away does not come back on disk', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const answer = deferred()
  const holding = deferred()
  let armed = false
  const host = await startHost(async (wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    if (wire.ifModifiedSince === LAST_MODIFIED) return { status: 304, body: null }
    if (armed) await answer.settled
    return {
      body: [thread(host, '1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = centerFor(store, host, () => clock)
  try {
    await center.saveCredential('ghp_notifications_token', true)
    clock += 61_000
    armed = true
    const reading = center.refresh()
    await eventually(
      () => host.wire.some((entry) => entry.ifModifiedSince === LAST_MODIFIED),
      'the conditional read reached the host',
    )
    // Every change to this module's files takes its turn on this file's queue,
    // and the queue is held here so the write below and the removal after it
    // are ordered the way a slow disk would order them.
    const blocking = store.store.serialize(() => holding.settled)
    const removing = center.removeCredential()
    await new Promise((resolve) => setImmediate(resolve))
    answer.release()
    holding.release()
    await blocking
    await removing
    await reading

    await assert.rejects(
      () => readFile(store.cacheFile, 'utf8'),
      /ENOENT/u,
      'the list a removed credential was read for is not left behind by a late write',
    )
  } finally {
    center.forget()
    await host.close()
  }
})

test('a host selected again finds the store and the queue its predecessor left', async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const gate = deferred()
  const logins: Record<string, string> = { ghp_octo: 'octo', ghp_hubot: 'hubot' }
  const host = await startHost((wire) => {
    const token = (wire.authorization ?? '').replace('Bearer ', '')
    if (wire.path === '/api/v3/user') return { body: { login: logins[token] ?? 'nobody' } }
    return {
      body: [thread(host, token === 'ghp_octo' ? '1' : '7')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const elsewhere = await startHost(() => ({ body: [] }))
  const first = centerFor(store, host, () => clock)
  try {
    await first.saveCredential('ghp_octo', true)
    const kept = (await first.status()).reference

    // A stage this center left running when it is retired: it has passed the
    // check that admits it and is sealing the token as the app moves on.
    const stage = store.store.vault.stage.bind(store.store.vault)
    let staging = false
    let holding = false
    store.store.vault.stage = async (...args: Parameters<CredentialVault['stage']>) => {
      const reference = await stage(...args)
      if (staging) holding = true
      if (staging) await gate.settled
      return reference
    }
    staging = true
    const abandoned = settling(first.saveCredential('ghp_hubot', true))
    await eventually(() => holding, 'the retired center reached its stage')

    // The app moves to another host and back. The store is keyed by its file,
    // so this is the same store, the same queue, and the same entries, and the
    // change still running on it takes its turn with the one that replaces it.
    first.forget()
    const other = centerFor(store, elsewhere, () => clock)
    assert.equal((await other.status()).state, 'credential-missing')
    other.forget()
    const returned = centerFor(store, host, () => clock)
    assert.equal(
      notificationCredentialStore(
        join(store.root, 'github-notifications-vault.json'),
        sealingProtector(),
      ),
      store.store,
      'one store and one queue per file, across every center this host has had',
    )

    staging = false
    gate.release()
    const outcome = await abandoned()
    assert.match(String(outcome.error), /was not stored/u)

    const status = await returned.status()
    assert.equal(status.state, 'ready', 'the credential the host had before is still usable')
    assert.equal(status.reference, kept)
    assert.deepEqual(
      (await store.store.vault.references()).map((entry) => entry.reference),
      [kept],
      'the abandoned save left nothing sealed, and superseded nothing',
    )
    clock += 61_000
    assert.deepEqual(
      (await returned.refresh()).threads.map((entry) => entry.id),
      ['1'],
      'the host this app came back to reads its own inbox',
    )
    returned.forget()
  } finally {
    first.forget()
    await host.close()
    await elsewhere.close()
  }
})
