import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer as createTlsServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import { UpdateService, type UpdateServiceOptions } from '../src/main/update/service'
import { privateInstallHandoff, type StagedUpdate } from '../src/main/update/artifact'
import type { UpdateChannel } from '../src/shared/update'

/**
 * The real update path, over a real socket, against a real HTTPS release
 * server. The certificate is generated for this run and handed to the updater
 * the way a fixture hands it over, so a manifest that was edited after it was
 * signed, a build that is not the one the manifest described, or a channel
 * change that lands late is visible on the wire rather than in a mock.
 */

const TLS = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-stacks-update-'))
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
    // The updater verifies the certificate for real, so the fixture names the
    // address it serves on rather than turning verification off.
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ])
  return { caFile: certFile, key: readFileSync(key), cert: readFileSync(certFile) }
})()

const RELEASE_KEY = generateKeyPairSync('ed25519')
const KEY_ID = 'release-fixture'
const PUBLIC_KEY = RELEASE_KEY.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const ARTIFACT = Buffer.from('a signed installer, as far as this fixture is concerned')

interface Release {
  version: string
  sequence: number
  bytes: Buffer
  channel: UpdateChannel
  /** The newer release this one is an authorised replacement for. */
  rollbackOf?: string | null
  /** Signs these exact bytes, or signs different ones to model a tamper. */
  tamper?: boolean
  /** Held open until the test releases it, so a check can be interrupted. */
  hold?: Promise<void> | null
}

/** A response the test holds open and releases when it chooses. */
let opened = false
function gate(): { wait: Promise<void>; open: () => void; entered: boolean } {
  let open = (): void => undefined
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return {
    wait,
    open: () => {
      opened = true
      open()
    },
    get entered(): boolean {
      return opened
    },
  }
}

function manifestFor(release: Release, base: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      channel: release.channel,
      version: release.version,
      sequence: release.sequence,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      notes: `Release ${release.version}`,
      rollbackOf: release.rollbackOf ?? null,
      artifacts: [
        {
          platform: 'darwin',
          arch: 'arm64',
          kind: 'dmg',
          fileName: `Git-Stacks-${release.version}-arm64.dmg`,
          url: `${base}/${release.channel}/Git-Stacks-${release.version}-arm64.dmg`,
          sha256: createHash('sha256').update(release.bytes).digest('hex'),
          size: release.bytes.length,
        },
      ],
    }),
  )
}

interface Feed {
  base: string
  requests: string[]
  set: (release: Release | null) => void
  close: () => Promise<void>
}

async function startFeed(): Promise<Feed> {
  let release: Release | null = null
  const requests: string[] = []
  // One manifest per published release, built once and served for both the
  // manifest and its signature: a signature that covers different bytes than
  // the ones served would model a bug, not a release.
  let cached: { identity: string; bytes: Buffer; signature: string } | null = null
  const published = (current: Release): { identity: string; bytes: Buffer; signature: string } => {
    const identity = JSON.stringify([
      current.version,
      current.sequence,
      current.channel,
      current.rollbackOf ?? null,
      current.bytes.length,
    ])
    if (!cached || cached.identity !== identity) {
      const bytes = manifestFor(current, base)
      cached = {
        identity,
        bytes,
        signature: sign(null, bytes, RELEASE_KEY.privateKey).toString('base64'),
      }
    }
    return cached
  }
  const server: Server = createTlsServer({ key: TLS.key, cert: TLS.cert }, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://placeholder')
    requests.push(url.pathname)
    const current = release
    const settle = (): void => {
      if (!current) {
        response.writeHead(404).end('no release')
        return
      }
      const release = published(current)
      if (url.pathname === `/update-${current.channel}.json`) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(current.tamper ? Buffer.from(`${release.bytes.toString()} `) : release.bytes)
        return
      }
      if (url.pathname === `/update-${current.channel}.json.sig`) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ schema: 1, keyId: KEY_ID, signature: release.signature }))
        return
      }
      if (url.pathname === `/${current.channel}/Git-Stacks-${current.version}-arm64.dmg`) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(current.bytes)
        return
      }
      response.writeHead(404).end('not found')
    }
    // A held response is released by the test, never by a timer: the race
    // being exercised is decided by when the test says so.
    if (current?.hold) void current.hold.then(settle)
    else settle()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the feed has no port')
  const base = `https://127.0.0.1:${address.port}`
  return {
    base,
    requests,
    set: (next) => {
      release = next
      cached = null
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

interface Harness {
  service: UpdateService
  userDataPath: string
  staged: () => string[]
  until: (phase: 'checking' | 'downloading' | 'installing') => Promise<void>
}

/** The environment a run of this build trusts a release feed through. */
function updateEnv(base: string): NodeJS.ProcessEnv {
  return {
    GIT_STACKS_UPDATE_KEY_ID: KEY_ID,
    GIT_STACKS_UPDATE_PUBLIC_KEY: PUBLIC_KEY,
    GIT_STACKS_UPDATE_FEED_BASE: base,
    GIT_STACKS_UPDATE_CA_FILE: TLS.caFile,
  }
}

function unsignedBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'git-stacks-bundle-'))
  const executable = join(root, 'Git Stacks.app', 'Contents', 'MacOS', 'Git Stacks')
  mkdirSync(join(root, 'Git Stacks.app', 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(executable, '#!/bin/sh\n')
  return executable
}

function harnessFor(
  base: string,
  options: Pick<UpdateServiceOptions, 'install' | 'prepare' | 'onStaged'> = {},
): Harness {
  const userDataPath = mkdtempSync(join(tmpdir(), 'git-stacks-update-data-'))
  const service = new UpdateService({
    packaged: false,
    currentVersion: '0.1.0',
    appPath: unsignedBundle(),
    userDataPath,
    platform: 'darwin',
    arch: 'arm64',
    env: updateEnv(base),
    relaunch: () => undefined,
    ...options,
  })
  const phases = new EventEmitter()
  service.onChange((status) => {
    if (
      status.phase === 'checking' ||
      status.phase === 'downloading' ||
      status.phase === 'installing'
    ) {
      phases.emit(status.phase)
    }
  })
  /** Resolves once the service is actually in the named phase. */
  const until = (phase: 'checking' | 'downloading' | 'installing'): Promise<void> =>
    service.status().phase === phase ? Promise.resolve() : once(phases, phase).then(() => undefined)
  return {
    service,
    userDataPath,
    until,
    staged: () => {
      try {
        return readdirSync(join(userDataPath, 'updates'))
      } catch {
        return []
      }
    },
  }
}

test('a signed release is offered, downloaded, and its bytes are proved before anything is installed', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const app = harnessFor(feed.base)
  await app.service.start('stable')

  const offered = await app.service.check()
  assert.equal(offered.phase, 'available', offered.failure?.message ?? '')
  assert.equal(offered.offer?.version, '0.2.0')
  assert.equal(offered.trust, 'development')
  assert.equal(offered.readyToInstall, false)

  const downloaded = await app.service.download()
  assert.equal(downloaded.phase, 'downloaded')
  assert.equal(downloaded.progress, 100)
  assert.equal(downloaded.readyToInstall, true)
  assert.deepEqual(app.staged(), [
    `${createHash('sha256').update(ARTIFACT).digest('hex').slice(0, 16)}-Git-Stacks-0.2.0-arm64.dmg`,
  ])

  // Nothing was run: this build is not signed, so there is no identity to
  // match the download against and it is refused rather than installed.
  const installed = await app.service.install()
  assert.equal(installed.phase, 'failed')
  assert.match(installed.failure?.message ?? '', /not signed/u)
  assert.equal(installed.readyToInstall, false)
  assert.equal(installed.restartRequired, false)
  assert.deepEqual(
    feed.requests,
    ['/update-stable.json', '/update-stable.json.sig', '/stable/Git-Stacks-0.2.0-arm64.dmg'],
    'only the manifest, its signature, and the artifact the manifest named were fetched',
  )
})

test('a manifest edited after it was signed is refused and no artifact is fetched', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable', tamper: true })
  const app = harnessFor(feed.base)
  await app.service.start('stable')

  const status = await app.service.check()
  assert.equal(status.phase, 'failed')
  assert.equal(status.failure?.reason, 'bad-signature')
  assert.equal(status.offer, null)
  assert.equal(feed.requests.includes('/stable/Git-Stacks-0.2.0-arm64.dmg'), false)
})

test('a build that is not the one the signed manifest described is refused and nothing is left behind', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  const release: Release = { version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' }
  feed.set(release)
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  await app.service.check()
  // The feed is asked for one thing and answers with another: the digest the
  // manifest recorded is the only thing that can catch it.
  release.bytes = Buffer.from('a different build with the same name')
  const status = await app.service.download()
  assert.equal(status.phase, 'failed')
  assert.equal(status.readyToInstall, false)
  assert.deepEqual(app.staged(), [], 'nothing half-verified is left on disk')
})

test('a staged installer that changes on disk after the download is never installed', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  await app.service.check()
  await app.service.download()
  const [staged] = app.staged()
  assert.ok(staged, 'the verified download is staged')
  await writeFile(join(app.userDataPath, 'updates', staged), 'a different installer entirely')

  const status = await app.service.install()
  assert.equal(status.phase, 'failed')
  assert.equal(status.failure?.reason, 'bad-signature')
  assert.match(status.failure?.message ?? '', /no longer matches the signed release/u)
})

test('the same release is offered again after a restart, and an older one is refused as a replay', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 4, bytes: ARTIFACT, channel: 'stable' })
  const first = harnessFor(feed.base)
  await first.service.start('stable')
  await first.service.check()

  // A second run over the same data directory is the same computer: the offer
  // it never took must still be there.
  const restarted = new UpdateService({
    packaged: false,
    currentVersion: '0.1.0',
    appPath: unsignedBundle(),
    userDataPath: first.userDataPath,
    platform: 'darwin',
    arch: 'arm64',
    env: {
      GIT_STACKS_UPDATE_KEY_ID: KEY_ID,
      GIT_STACKS_UPDATE_PUBLIC_KEY: PUBLIC_KEY,
      GIT_STACKS_UPDATE_FEED_BASE: feed.base,
      GIT_STACKS_UPDATE_CA_FILE: TLS.caFile,
    },
    relaunch: () => undefined,
  })
  await restarted.start('stable')
  const again = await restarted.check()
  assert.equal(again.phase, 'available', 'an offer that was never taken is still available')
  assert.equal(again.offer?.sequence, 4)

  // A manifest from before the one already seen is a replay, whatever it says.
  feed.set({ version: '0.2.0', sequence: 3, bytes: ARTIFACT, channel: 'stable' })
  const replayed = await restarted.check()
  assert.equal(replayed.phase, 'failed')
  assert.equal(replayed.failure?.reason, 'replayed')

  // A build that has already moved on to 0.3.0 refuses a silent downgrade to
  // 0.2.0, and accepts exactly that version as a rollback when the signed
  // release says which newer release it replaces.
  const movedOn = new UpdateService({
    packaged: false,
    currentVersion: '0.3.0',
    appPath: unsignedBundle(),
    userDataPath: first.userDataPath,
    platform: 'darwin',
    arch: 'arm64',
    env: {
      GIT_STACKS_UPDATE_KEY_ID: KEY_ID,
      GIT_STACKS_UPDATE_PUBLIC_KEY: PUBLIC_KEY,
      GIT_STACKS_UPDATE_FEED_BASE: feed.base,
      GIT_STACKS_UPDATE_CA_FILE: TLS.caFile,
    },
    relaunch: () => undefined,
  })
  await movedOn.start('stable')
  feed.set({ version: '0.2.0', sequence: 5, bytes: ARTIFACT, channel: 'stable' })
  const silent = await movedOn.check()
  assert.equal(silent.phase, 'failed')
  assert.equal(silent.failure?.reason, 'not-newer')

  feed.set({
    version: '0.2.0',
    sequence: 5,
    bytes: ARTIFACT,
    channel: 'stable',
    rollbackOf: '0.3.0',
  })
  const rolledBack = await movedOn.check()
  assert.equal(rolledBack.phase, 'available')
  assert.equal(rolledBack.offer?.version, '0.2.0')
  assert.equal(rolledBack.offer?.rollbackOf, '0.3.0')
  assert.equal(rolledBack.offer?.sequence, 5)
})

test('a download that is cancelled leaves nothing, and the next one still works', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  const release: Release = { version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' }
  feed.set(release)
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  await app.service.check()
  // The answer to the artifact request is held, so the download is genuinely in
  // flight when it is cancelled rather than already finished.
  const hold = gate()
  release.hold = hold.wait
  const pending = app.service.download()
  // The request is on the wire and the answer is held, so the download is
  // genuinely in flight when it is cancelled.
  await app.until('downloading')
  const cancelled = app.service.cancel()
  assert.equal(cancelled.phase, 'cancelled')
  hold.open()
  await pending
  assert.equal(app.service.status().readyToInstall, false)
  assert.deepEqual(app.staged(), [])

  release.hold = null
  // The offer is still the authenticated one, but a cancelled attempt is not
  // one to build on: the next download is a fresh decision made by a fresh
  // check, so nothing is downloaded on the strength of a run that was stopped.
  const refused = await app.service.download()
  assert.equal(refused.phase, 'failed')
  await app.service.check()
  const retried = await app.service.download()
  assert.equal(retried.phase, 'downloaded')
  assert.equal(retried.readyToInstall, true)
})

test('a check that finishes after the channel changed is not recorded against the new channel', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  const hold = gate()
  feed.set({ version: '0.2.0', sequence: 6, bytes: ARTIFACT, channel: 'stable', hold: hold.wait })
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  const checking = app.service.check()
  // The stable manifest is on the wire and unanswered: switching channels now
  // must not let it land in the beta channel's history.
  await app.until('checking')
  // The change is asked for while that check is in flight. It does not take the
  // boundary away from the run that holds it: it waits, and the answer that was
  // on the wire is answered on the channel it belongs to.
  const switching = app.service.applyChannel('beta')
  hold.open()
  assert.equal((await checking).channel, 'stable', 'the held answer is answered on stable')
  const afterSwitch = await switching
  assert.equal(afterSwitch.channel, 'beta')
  assert.notEqual(
    afterSwitch.offer?.version,
    '0.2.0',
    'the old channel’s release is not offered here',
  )
  assert.equal(afterSwitch.readyToInstall, false, 'nothing is installable across the change')

  // The sequence stable issued is not in the beta history, and a beta release
  // with a lower sequence of its own is still offered.
  const history = JSON.parse(readFileSync(join(app.userDataPath, 'updates.json'), 'utf8'))
  assert.equal(history.seenSequences.beta ?? 0, 0, 'the stable sequence stayed out of beta')
  feed.set({ version: '0.3.0', sequence: 2, bytes: ARTIFACT, channel: 'beta' })
  const beta = await app.service.check()
  assert.equal(beta.phase, 'available')
  assert.equal(beta.offer?.version, '0.3.0')
  assert.equal(beta.offer?.channel, 'beta')
})

test('a re-check of the same release keeps its verified download, and a different one discards it', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  const release: Release = { version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' }
  feed.set(release)
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  await app.service.check()
  await app.service.download()
  const staged = app.staged()

  const same = await app.service.check()
  assert.equal(same.phase, 'downloaded')
  assert.equal(same.readyToInstall, true, 'the same release is still downloaded and verified')
  assert.deepEqual(app.staged(), staged)

  release.version = '0.3.0'
  release.sequence = 2
  const different = await app.service.check()
  assert.equal(different.offer?.version, '0.3.0')
  assert.equal(different.readyToInstall, false, 'the previous release’s installer is gone')
  assert.deepEqual(app.staged(), [])
})

test('a damaged update history stops updating instead of forgetting what was seen', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  await writeFile(join(app.userDataPath, 'updates.json'), '{ not the history')

  const restarted = harnessFor(feed.base)
  const broken = new UpdateService({
    packaged: false,
    currentVersion: '0.1.0',
    appPath: unsignedBundle(),
    userDataPath: app.userDataPath,
    platform: 'darwin',
    arch: 'arm64',
    env: {
      GIT_STACKS_UPDATE_KEY_ID: KEY_ID,
      GIT_STACKS_UPDATE_PUBLIC_KEY: PUBLIC_KEY,
      GIT_STACKS_UPDATE_FEED_BASE: feed.base,
      GIT_STACKS_UPDATE_CA_FILE: TLS.caFile,
    },
    relaunch: () => undefined,
  })
  await broken.start('stable')
  assert.equal(broken.status().phase, 'failed')
  assert.match(broken.status().failure?.message ?? '', /damaged/u)
  const attempted = await broken.check()
  assert.equal(attempted.phase, 'failed')
  assert.equal(attempted.offer, null)
  assert.equal(restarted.staged().length, 0)
})

test('a packaged build ignores a fixture feed and key entirely', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const userDataPath = mkdtempSync(join(tmpdir(), 'git-stacks-update-data-'))
  const service = new UpdateService({
    packaged: true,
    currentVersion: '0.1.0',
    appPath: unsignedBundle(),
    userDataPath,
    platform: 'darwin',
    arch: 'arm64',
    env: {
      GIT_STACKS_UPDATE_KEY_ID: KEY_ID,
      GIT_STACKS_UPDATE_PUBLIC_KEY: PUBLIC_KEY,
      GIT_STACKS_UPDATE_FEED_BASE: feed.base,
      GIT_STACKS_UPDATE_CA_FILE: TLS.caFile,
    },
    relaunch: () => undefined,
  })
  await service.start('stable')
  const status = await service.check()
  assert.equal(status.failure?.reason, 'not-configured')
  assert.equal(status.trust, 'none')
  assert.deepEqual(feed.requests, [], 'an installed app opened no socket')
  await readFile(join(userDataPath, 'updates.json'), 'utf8').catch(() => undefined)
})

test('a replay counter that is present but unreadable stops the updater', async () => {
  // A channel that is present but damaged is not an absent channel: dropping it
  // would let a manifest with a lower sequence be accepted as if the channel
  // were new, and no install could ever update from it again.
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'git-stacks-damaged-history-'))
  const { UpdateService } = await import('../src/main/update/service')
  const options = {
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '1.0.0',
    appPath: unsignedBundle(),
    userDataPath: home,
    packaged: false,
    env: {
      GIT_STACKS_UPDATE_KEY_ID: KEY_ID,
      GIT_STACKS_UPDATE_PUBLIC_KEY: PUBLIC_KEY,
      GIT_STACKS_UPDATE_FEED_BASE: 'https://127.0.0.1:1/',
      GIT_STACKS_UPDATE_CA_FILE: TLS.caFile,
    },
    relaunch: () => undefined,
  }
  for (const damaged of ['"12"', '-1', 'null', '1.5', '9007199254740993']) {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'updates.json'),
      JSON.stringify({ schema: 1, seenSequences: { stable: 12 }, last: {} }, null, 2),
    )
    await writeFile(
      join(home, 'updates.json'),
      JSON.stringify(
        { schema: 1, seenSequences: { stable: JSON.parse(damaged) }, last: {} },
        null,
        2,
      ),
    )
    const service = new UpdateService(options)
    await service.start('stable')
    const status = await service.check()
    assert.equal(status.phase, 'failed', `a ${damaged} counter is refused rather than read as zero`)
    assert.match(status.failure?.message ?? '', /damaged|cannot be trusted/u)
  }
})

test('a staged build is handed to the installer through a file only this app can write', async () => {
  const { privateInstallHandoff } = await import('../src/main/update/artifact')
  const { mkdtemp, writeFile, stat, mkdir, symlink, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const parent = await mkdtemp(join(tmpdir(), 'git-stacks-handoff-'))
  const source = join(parent, 'Git-Stacks.dmg')
  const bytes = Buffer.from('a verified installer')
  await writeFile(source, bytes)
  const handoff = await privateInstallHandoff(
    { path: source, sha256: 'a'.repeat(64), size: bytes.length, fileName: 'Git-Stacks.dmg' },
    join(parent, 'private'),
  )
  assert.deepEqual(await readFile(handoff.path), bytes, 'the handed-over file is the verified one')
  // The directory is entered by its owner alone, and the file is a regular file
  // rather than a link to something that can be swapped underneath it.
  const directory = await stat(join(parent, 'private'))
  assert.equal(directory.mode & 0o077, 0, 'the handoff directory is not readable by anyone else')
  const file = await stat(handoff.path)
  assert.equal(file.isFile(), true)
  assert.equal(file.mode & 0o077, 0, 'the handed-over file is not readable by anyone else')

  // A name already taken by something else is refused rather than written
  // through, so a link planted in the handoff cannot be followed.
  const contested = join(parent, 'contested')
  await mkdir(contested, { mode: 0o700 })
  const victim = join(parent, 'victim')
  await writeFile(victim, 'not this file')
  await symlink(victim, join(contested, 'Git-Stacks.dmg'))
  await assert.rejects(
    privateInstallHandoff(
      { path: source, sha256: 'a'.repeat(64), size: bytes.length, fileName: 'Git-Stacks.dmg' },
      contested,
    ),
    /EEXIST/u,
  )
  assert.equal(
    await readFile(victim, 'utf8'),
    'not this file',
    'the link was never written through',
  )
})

/**
 * The history the replay guard is made of has to reach the disk before a
 * release counts as seen. These two make the write fail for real — the file the
 * app publishes is a directory, so the rename that commits the history cannot
 * succeed — and read what the surface is allowed to do afterwards.
 */
test('a release is not offered at all when the history that records it cannot be written', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 4, bytes: ARTIFACT, channel: 'stable' })
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  // A directory where the history file belongs: the write that would record
  // what this computer has seen cannot be renamed into place.
  mkdirSync(join(app.userDataPath, 'updates.json'), { recursive: true })
  const offered = await app.service.check()
  assert.equal(offered.phase, 'failed')
  assert.equal(offered.offer, null, 'a release nobody can record is not offered')
  assert.equal(offered.readyToInstall, false)
  assert.match(offered.failure?.message ?? '', /history could not be saved/u)
  // Every later action stops too, rather than acting on a guard that is gone.
  assert.equal((await app.service.download()).phase, 'failed')
  assert.equal((await app.service.install()).phase, 'failed')
  assert.equal(app.service.status().readyToInstall, false)
})

test('a history that cannot be recorded revokes the build already downloaded', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 4, bytes: ARTIFACT, channel: 'stable' })
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  await app.service.check()
  assert.equal((await app.service.download()).phase, 'downloaded')
  assert.equal(app.staged().length, 1)
  // The next check finds the same release and cannot record it: a directory
  // where the history file belongs makes the commit fail for real.
  rmSync(join(app.userDataPath, 'updates.json'))
  mkdirSync(join(app.userDataPath, 'updates.json'))
  const offered = await app.service.check()
  assert.equal(offered.phase, 'failed')
  assert.equal(offered.readyToInstall, false)
  assert.deepEqual(app.staged(), [], 'the downloaded build is revoked with the guard')
  assert.equal((await app.service.install()).phase, 'failed')
})

test('a channel change removes the build the old channel staged, and a failed write puts it back', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  await app.service.check()
  await app.service.download()
  const staged = app.staged()
  assert.equal(staged.length, 1)

  let committed = 0
  const moved = await app.service.applyChannel('beta', async () => {
    committed += 1
    // The stored channel is written while the change is still undecided, so a
    // reader of this file never sees a channel the app is not following.
    assert.equal(app.service.status().channel, 'beta')
  })
  assert.equal(moved.channel, 'beta')
  assert.equal(committed, 1, 'the stored channel is written inside the change')
  assert.deepEqual(app.staged(), [], 'the old channel’s staged build is gone')
  assert.equal(moved.readyToInstall, false, 'nothing is installable across the change')

  const refused = await app.service.applyChannel('stable', async () => {
    throw new Error('the settings file could not be written')
  })
  assert.equal(refused.channel, 'beta', 'a channel that was not saved is not the one followed')
  assert.equal(refused.phase, 'failed')
  assert.match(refused.failure?.message ?? '', /the settings file could not be written/u)
})

test('a stopped download removes only what it staged, and the next one is not disturbed', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  const release: Release = { version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' }
  feed.set(release)
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  await app.service.check()
  const hold = gate()
  release.hold = hold.wait
  const first = app.service.download()
  await app.until('downloading')
  assert.equal(app.service.cancel().phase, 'cancelled')
  // The next download is asked for while the stopped one is still settling, and
  // waits behind it rather than running beside it.
  const second = app.service.download()
  hold.open()
  await first
  assert.equal(app.service.status().readyToInstall, false)
  assert.equal((await second).phase, 'failed', 'a fresh check is what makes a download legal')
  assert.deepEqual(app.staged(), [], 'the stopped download left nothing behind')

  release.hold = null
  await app.service.check()
  assert.equal((await app.service.download()).phase, 'downloaded')
  const files = app.staged()
  assert.equal(files.length, 1, 'exactly one verified file is staged')
  const digest = createHash('sha256')
    .update(readFileSync(join(app.userDataPath, 'updates', files[0])))
    .digest('hex')
  assert.equal(digest, createHash('sha256').update(ARTIFACT).digest('hex'))
})

test('a cancel during the platform install is refused, and the boundary stays held', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const installing = gate()
  const app = harnessFor(feed.base, {
    install: async () => {
      await installing.wait
      return { installed: false, reason: 'the installer did not finish' }
    },
  })
  await app.service.start('stable')
  await app.service.check()
  await app.service.download()
  const install = app.service.install()
  await app.until('installing')

  const refused = app.service.cancel()
  assert.match(refused.failure?.message ?? '', /cannot be stopped now/u)
  assert.equal(refused.phase, 'installing', 'the install is still the one in progress')

  // A channel change asked for during the install does not overtake it.
  let committed = 0
  const switching = app.service.applyChannel('beta', async () => {
    committed += 1
  })
  assert.equal(committed, 0, 'nothing is stored while the installer has the files')
  installing.open()
  const installStatus = await install
  assert.equal(installStatus.phase, 'failed', 'the installer’s own refusal is reported')
  assert.match(installStatus.failure?.message ?? '', /did not finish/u)
  const after = await switching
  assert.equal(after.channel, 'beta')
  assert.equal(committed, 1, 'the change is applied once the installer has returned')
})

test('a handoff that fails leaves the destination free for the next attempt', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'git-stacks-handoff-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const staged: StagedUpdate = {
    path: join(directory, 'source.dmg'),
    sha256: 'a'.repeat(64),
    size: Buffer.byteLength('signed bytes'),
    fileName: 'Git-Stacks.dmg',
  }
  writeFileSync(staged.path, 'signed bytes')

  // A source that is not there: the copy cannot start, and the destination this
  // attempt created is removed with it. The name it would use is fixed, so
  // leaving a partial file there would make every later attempt — including one
  // after a restart — fail on a file this app wrote itself.
  await assert.rejects(
    privateInstallHandoff(
      { ...staged, path: join(directory, 'absent.dmg') },
      join(directory, 'handoff'),
    ),
    /ENOENT/u,
  )
  assert.deepEqual(readdirSync(join(directory, 'handoff')), [], 'the half-made copy is gone')

  // The retry succeeds, and the copy handed over is the verified bytes.
  const handoff = await privateInstallHandoff(staged, join(directory, 'handoff'))
  assert.equal(readFileSync(handoff.path, 'utf8'), 'signed bytes')

  // A destination something else already holds is refused, and left exactly as
  // it was: refusing is not the same as cleaning up somebody else's file.
  const occupied = join(directory, 'occupied')
  mkdirSync(occupied, { recursive: true })
  writeFileSync(join(occupied, 'Git-Stacks.dmg'), 'not ours')
  await assert.rejects(privateInstallHandoff(staged, occupied), /EEXIST/u)
  assert.equal(
    readFileSync(join(occupied, 'Git-Stacks.dmg'), 'utf8'),
    'not ours',
    'a file this attempt did not create is still there',
  )
})

test('a stop asked for while the history is written is not turned into an offer', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  const manifest = gate()
  feed.set({
    version: '0.2.0',
    sequence: 5,
    bytes: ARTIFACT,
    channel: 'stable',
    hold: manifest.wait,
  })
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  // The check is held at the point where the history is being committed, so the
  // stop lands after the manifest was authenticated and while the local step
  // that makes an offer possible is still running. The hold is the service's own
  // history write, held open by the test; everything after it is the real path.
  const held = app.service as unknown as { writeState(): Promise<void> }
  const write = held.writeState.bind(held)
  const writing = gate()
  const reached = gate()
  held.writeState = async () => {
    void reached.open()
    await writing.wait
    await write()
  }
  const checking = app.service.check()
  await app.until('checking')
  manifest.open()
  // The manifest is authenticated and the history write is what is now running.
  await reached.wait
  app.service.cancel()
  writing.open()
  const afterStop = await checking
  assert.equal(afterStop.phase, 'cancelled')
  assert.equal(afterStop.offer, null, 'a cancelled check offers nothing')
  assert.equal(afterStop.readyToInstall, false)
  const history = JSON.parse(readFileSync(join(app.userDataPath, 'updates.json'), 'utf8'))
  assert.equal(
    history.seenSequences.stable,
    5,
    'the sequence stays spent, so the counter never moves back down',
  )
  // And the same release is offered again, because the guard is a high-water
  // mark rather than a record of what was installed.
  manifest.open()
  const again = await app.service.check()
  assert.equal(again.phase, 'available')
  assert.equal(again.offer?.version, '0.2.0')
})

test('a stop asked for while the build is prepared never starts the installer', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  let started = 0
  const preparing = gate()
  const reached = gate()
  const app = harnessFor(feed.base, {
    install: async () => {
      started += 1
      return { installed: false, reason: 'the installer should not have run' }
    },
    prepare: async (staged, parent) => {
      const handoff = await handoffOnce(staged, parent)
      // The install owns the boundary from here. The stop is asked for while the
      // verified build is being prepared, which is a window the person can
      // reach: the installer has been given nothing yet, so a cancel here is
      // honoured rather than refused.
      void reached.open()
      await preparing.wait
      return handoff
    },
  })
  await app.service.start('stable')
  await app.service.check()
  await app.service.download()
  const install = app.service.install()
  await reached.wait
  app.service.cancel()
  preparing.open()
  const afterStop = await install
  assert.equal(afterStop.phase, 'cancelled', 'the stop was honoured before the cut-over')
  assert.equal(started, 0, 'the platform installer was never started')
  assert.equal(afterStop.readyToInstall, false)
  assert.deepEqual(
    readdirSync(join(app.userDataPath, 'handoff')),
    [],
    'the prepared copy went with the directory this attempt created, and the parent is untouched',
  )
})

/** The real handoff, so the held preparation is the real copy. */
async function handoffOnce(staged: StagedUpdate, parent: string): Promise<StagedUpdate> {
  return privateInstallHandoff(staged, parent)
}

test('a channel request for the channel already in force still writes its other fields', async (t) => {
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const app = harnessFor(feed.base)
  await app.service.start('stable')
  let committed = 0
  const same = await app.service.applyChannel('stable', async () => {
    committed += 1
  })
  assert.equal(committed, 1, 'the write inside the change is not skipped as a no-op')
  assert.equal(same.channel, 'stable')
})

test('nothing a failed install cleans up was not this attempt’s own', async (t) => {
  // The handoff lives in a directory each attempt creates, and every cleanup
  // path removes only that directory. Anything else living under the app's data
  // directory — another run's leftovers, a file another process put there, a
  // person's own file — is never touched, on any way out of an install,
  // including the paths that fail.
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const foreign = 'somebody-elses-installer.dmg'
  const outcomes: { name: string; app: Harness }[] = []
  let installed = 0
  const reached = gate()
  const releasing = gate()

  // Four different ways out of an install, each one reaching the cleanup.
  for (const failure of ['digest', 'prepare', 'stop', 'install'] as const) {
    const app = harnessFor(feed.base, {
      ...(failure === 'prepare'
        ? {
            prepare: async () => {
              throw new Error('the handoff could not be made')
            },
          }
        : {}),
      ...(failure === 'stop'
        ? {
            prepare: async (staged, parent) => {
              const handoff = await handoffOnce(staged, parent)
              void reached.open()
              await releasing.wait
              return handoff
            },
          }
        : {}),
      install: async () => {
        installed += 1
        return { installed: false, reason: 'the platform installer refused the update' }
      },
    })
    // Every case reaches the install with a downloaded candidate; the digest
    // case then changes what is on disk, which is what a replacement looks like.
    await app.service.start('stable')
    await app.service.check()
    await app.service.download()
    if (failure === 'digest') {
      const stagedFile = app.staged()[0]
      assert.ok(stagedFile, 'the download is staged')
      // The file the service will prove, changed on disk after the download:
      // this is what the digest check at install time is for.
      writeFileSync(join(app.userDataPath, 'updates', stagedFile), 'not the signed bytes')
    }
    // Something else already in the handoff parent, and something else in the
    // data directory beside it.
    const handoffParent = join(app.userDataPath, 'handoff')
    mkdirSync(handoffParent, { recursive: true })
    writeFileSync(join(handoffParent, foreign), 'not ours')
    writeFileSync(join(app.userDataPath, 'settings.json'), '{"updates":{"channel":"stable"}}')
    if (failure === 'stop') {
      const install = app.service.install()
      await reached.wait
      app.service.cancel()
      releasing.open()
      await install
    } else {
      await app.service.install()
    }
    outcomes.push({ name: failure, app })
  }

  for (const { name, app } of outcomes) {
    assert.equal(
      readFileSync(join(app.userDataPath, 'handoff', foreign), 'utf8'),
      'not ours',
      `${name}: a file this attempt did not create survives`,
    )
    assert.equal(
      readFileSync(join(app.userDataPath, 'settings.json'), 'utf8'),
      '{"updates":{"channel":"stable"}}',
      `${name}: the settings file survives`,
    )
    assert.deepEqual(
      readdirSync(join(app.userDataPath, 'handoff')),
      [foreign],
      `${name}: only this attempt's own directory was removed`,
    )
    if (name === 'digest') {
      // The bytes this machine held were not the signed artifact, so they are
      // removed: a retry has to download again rather than reuse them.
      assert.deepEqual(app.staged(), [], `${name}: bytes that are not the signed build are removed`)
    } else {
      // The download here is the verified artifact and nothing has claimed it
      // is wrong, so it stays: a person who asks again is not made to fetch the
      // same build twice. What the failure removed is the prepared copy, which
      // the case above already proved.
      assert.equal(
        app.staged().length,
        1,
        `${name}: the verified download is kept, and only the prepared copy went`,
      )
    }
  }
  assert.equal(installed, 1, 'only the install that was supposed to run reached the installer')
})

test('a copy a detached installer still holds outlives the call, and goes when that process does', async (t) => {
  // A Windows installer is handed a path and this app is then closed so the
  // installer can replace the files this one is running from. It has not read
  // that path yet at the moment it is spawned — the elevated copy that does the
  // work runs from it afterwards — so removing the prepared copy when the call
  // returns left the update with nothing to install from. This drives the real
  // service over real temporary files and a real process: whether that process
  // is running is decided by the process, not by the test.
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  // A real process, alive because the test holds its end open and finished
  // because the test closes it. Nothing here decides liveness by waiting.
  const installer = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  t.after(() => installer.kill('SIGKILL'))
  const started = once(installer, 'spawn')
  await started
  const app = harnessFor(feed.base, {
    install: async (_staged, options) => {
      const pid = installer.pid ?? null
      assert.notEqual(pid, null, 'the installer process is identified')
      await options.onRetain?.({ pid })
      return { installed: true, reason: 'The installer is running.', retains: { pid } }
    },
  })
  /** The next launch of this app over the same data directory. */
  const launch = async (userDataPath: string): Promise<void> => {
    const next = new UpdateService({
      packaged: false,
      currentVersion: '0.1.0',
      appPath: unsignedBundle(),
      userDataPath,
      platform: 'darwin',
      arch: 'arm64',
      env: updateEnv(feed.base),
      relaunch: () => undefined,
    })
    await next.start('stable')
  }

  await app.service.start('stable')
  await app.service.check()
  await app.service.download()
  await app.service.install()

  // The copy the installer was handed is still there to read, after the call
  // that started the installer returned and this app was told to close.
  const handoffParent = join(app.userDataPath, 'handoff')
  const [held] = readdirSync(handoffParent)
  assert.ok(held, 'the directory this attempt made is still there')
  const [prepared] = readdirSync(join(handoffParent, held))
  assert.deepEqual(
    readFileSync(join(handoffParent, held, prepared)),
    ARTIFACT,
    'the prepared copy is readable, so the installer has something to install from',
  )

  // A launch while the installer is running proves nothing about it having
  // finished, so nothing is removed and the copy is still where it was.
  await launch(app.userDataPath)
  assert.deepEqual(
    readdirSync(handoffParent),
    [held],
    'a launch while the installer is still running removes nothing',
  )

  const finished = once(installer, 'exit')
  installer.stdin.end()
  await finished
  writeFileSync(join(handoffParent, 'somebody-elses-file'), 'not ours')
  await launch(app.userDataPath)
  assert.deepEqual(
    readdirSync(handoffParent),
    ['somebody-elses-file'],
    'the copy goes once its installer has, and nothing else went with it',
  )

  // The other kind of install still cleans up: one that hands the copy to
  // nothing has nothing left holding it.
  const refused = harnessFor(feed.base, {
    install: async () => ({
      installed: false,
      reason: 'the platform installer refused the update',
    }),
  })
  await refused.service.start('stable')
  await refused.service.check()
  await refused.service.download()
  await refused.service.install()
  assert.deepEqual(
    readdirSync(join(refused.userDataPath, 'handoff')),
    [],
    'an install that left no installer running leaves no prepared copy behind',
  )
})

test('a stop asked for after the last byte arrived leaves nothing staged or offered', async (t) => {
  // The window between the download being committed to the staging directory
  // and the download reporting back is real: a cancel that arrives there used to
  // be accepted by the network layer, which had already finished, and the file
  // was then published as a download that was ready to install. The stop is
  // asked for at exactly that moment here, with the file already on disk.
  const feed = await startFeed()
  t.after(() => feed.close())
  feed.set({ version: '0.2.0', sequence: 1, bytes: ARTIFACT, channel: 'stable' })
  const committed = gate()
  const reached = gate()
  const app = harnessFor(feed.base, {
    onStaged: async (staged) => {
      // The verified bytes are on disk at this point, and the download has not
      // returned yet: this is the whole window.
      assert.ok(existsSync(staged.path), 'the file is committed before the caller hears about it')
      void reached.open()
      await committed.wait
    },
  })
  await app.service.start('stable')
  await app.service.check()
  const downloading = app.service.download()
  await reached.wait
  app.service.cancel()
  committed.open()
  const afterStop = await downloading
  assert.equal(afterStop.phase, 'cancelled', 'the stop is honoured after the last byte')
  assert.equal(afterStop.readyToInstall, false, 'nothing is offered as installable')
  assert.deepEqual(app.staged(), [], 'the file this run created is removed')
})

test('a change asked for after a reset is not overtaken by it', async (t) => {
  // Which channel a reset lands on comes out of the file the reset is about to
  // rewrite, because a policy that has fixed the channel keeps it. Reading that
  // file before the reset is admitted loses the person's ordering: the channel
  // asked for a moment later is admitted first, commits, and is then overwritten
  // by the reset that arrived behind it. So the read happens inside the boundary,
  // where the reset is already next in line.
  //
  // The read is held open here for exactly as long as the reviewer's window was:
  // the later request is made while it is still waiting, and the answer has to
  // be the later one in both the queue and the result.
  const feed = await startFeed()
  t.after(() => feed.close())
  const app = harnessFor(feed.base)
  const order: string[] = []
  const holding = gate()
  const reset = app.service.applyResolvedChannel(
    async () => {
      void holding.open()
      await holding.wait
      return 'stable'
    },
    async () => {
      order.push('reset')
    },
  )
  await holding.wait
  const later = app.service.applyChannel('beta', async () => {
    order.push('beta')
  })
  holding.open()
  await Promise.all([reset, later])
  assert.deepEqual(
    order,
    ['reset', 'beta'],
    'the two changes are written in the order they were asked in',
  )
  assert.equal(app.service.status().channel, 'beta', 'the later choice is the channel in force')
})
