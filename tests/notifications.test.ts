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
import { githubHostContext, type GitHubHostContext } from '../src/main/github-host'
import { NotificationCenter } from '../src/main/notifications'
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

/** One installation's storage: the shared sealed vault plus this module's files. */
async function installation() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-notifications-state-'))
  roots.push(root)
  return {
    root,
    vault: new CredentialVault(join(root, 'credentials.vault.json'), sealingProtector()),
    credentialFile: join(root, 'github-notifications.json'),
    cacheFile: join(root, 'github-notifications-cache.json'),
  }
}

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    unread: true,
    reason: 'review_requested',
    subject: {
      title: `Thread ${id}`,
      url: `https://github.com/acme/widgets/pull/${id}`,
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
      wire.path === '/api/v3/user' ? { body: { login: 'octo' } } : { body: [thread('1')] },
    impostor,
  )
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
    return pagedInbox(host, wire, [thread('1'), thread('2')], [thread('3')])
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
      body: [thread('1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '7200' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
      body: [thread('1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '600' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
      vault: store.vault,
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
    return { body: [thread('1')], headers: { 'last-modified': LAST_MODIFIED } }
  })
  const second = await startHost(() => ({ body: [thread('9')] }))
  const other = new NotificationCenter({
    host: second.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
    vault: store.vault,
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
      body: [thread(token === 'ghp_octo' ? '1' : '7')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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

test("removing the notification credential leaves the application's own credential sealed and working", async () => {
  const store = await installation()
  let clock = Date.parse('2026-09-22T10:00:00.000Z')
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return { body: [thread('1')], headers: { 'last-modified': LAST_MODIFIED } }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
    credentialFile: store.credentialFile,
    cacheFile: store.cacheFile,
    consent: () => ({ enabled: true, policyDisabled: false }),
    now: () => clock,
  })
  try {
    // The credential the rest of the app signs in with, sealed in the same vault.
    const appReference = await store.vault.stage('127.0.0.1', 'gho_application_session', clock)
    const notification = await center.saveCredential('ghp_notifications_token', true)
    assert.equal(notification.state, 'ready')

    const afterRemoval = await center.removeCredential()
    assert.equal(afterRemoval.state, 'credential-missing')
    assert.equal(afterRemoval.reference, null)

    const sealed = await store.vault.references()
    const references = sealed.map((entry) => entry.reference)
    assert.ok(
      references.includes(appReference),
      'the application credential is still sealed where it was',
    )
    assert.ok(
      !references.includes(String(notification.reference)),
      "only this module's credential was removed",
    )
    assert.equal(await store.vault.open(appReference, '127.0.0.1'), 'gho_application_session')
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
    return { body: [thread('1')], headers: { 'last-modified': LAST_MODIFIED } }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
    vault: store.vault,
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
      body: [thread('1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
      body: [thread('1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
    if (wire.method !== 'GET') return { status: 205, body: {} }
    return {
      body: [thread('1'), thread('2')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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

    await center.markRead('all')
    assert.equal(one.unreadCount, 1, 'marking one thread read leaves the rest alone')

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
        'PATCH /api/v3/notifications',
        'PUT /api/v3/notifications/threads/2/subscription',
        'DELETE /api/v3/notifications/threads/2/subscription',
      ],
    )
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
        body: [thread('slow')],
        headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
      }
    }
    return {
      body: [thread('7')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
  const open = store.vault.open.bind(store.vault)
  store.vault.open = async (...args: Parameters<CredentialVault['open']>) => {
    if (slowOpen) await gate.settled
    return open(...args)
  }
  const host = await startHost((wire) => {
    if (wire.path === '/api/v3/user') return { body: { login: 'octo' } }
    return {
      body: [thread('1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
        body: [thread('2')],
        headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
      }
    }
    return {
      body: [thread('1')],
      headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
    }
  })
  const center = new NotificationCenter({
    host: host.context,
    fetch: verifiedFetch,
    vault: store.vault,
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
