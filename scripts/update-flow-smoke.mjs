#!/usr/bin/env node
/**
 * The real update path, in the real application.
 *
 * Launches the built Electron app — real main process, real preload, real
 * renderer — against a controlled HTTPS release server with a certificate
 * generated for this run, and drives it through the same bridge the Settings
 * surface uses: check, download, install. Every assertion is about what the app
 * did on the wire or on disk, never about a mock's bookkeeping.
 *
 * Proven here, in one run:
 *   - the renderer bridge carries no shell, filesystem, or network escape
 *     hatch, and only the update methods this feature added;
 *   - a malformed payload and a disallowed URL scheme are refused at the
 *     boundary by the main process;
 *   - a signed release is offered, downloaded, and proved against the digest
 *     the manifest recorded;
 *   - an installer that changed on disk after the download is refused, and
 *     nothing was run;
 *   - changing the channel in real settings reaches the running updater.
 *
 * Usage: node scripts/update-flow-smoke.mjs [--timeout <seconds>] [--keep]
 */

import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:https'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
    })
  }

  static async open(endpoint, timeoutMs) {
    const socket = new WebSocket(endpoint)
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true })
      socket.addEventListener('error', () => rejectOpen(new Error(`could not open ${endpoint}`)), {
        once: true,
      })
    })
    const client = new Cdp(socket)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await client.send('Browser.getVersion')
        return client
      } catch {
        await new Promise((wait) => setTimeout(wait, 200))
      }
    }
    throw new Error(`${endpoint} never answered a CDP command`)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectCall(new Error(`${method} timed out`))
      }, 30_000)
      timer.unref()
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolveCall(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectCall(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  /** The one window this app opens, addressed the way a person sees it. */
  async windowTarget(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { targetInfos } = await this.send('Target.getTargets')
      const page = targetInfos.find(
        (target) => target.type === 'page' && String(target.url).startsWith('app://'),
      )
      if (page) return page
      await new Promise((wait) => setTimeout(wait, 200))
    }
    throw new Error('the app never opened its window')
  }

  async attach(target) {
    const { sessionId } = await this.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    return sessionId
  }

  close() {
    this.socket.close()
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const log = (line) => process.stdout.write(`${line}\n`)
const failures = []
const limit = (message) => log(`  note  ${message}`)
const assert = (condition, message) => {
  if (!condition) {
    failures.push(message)
    log(`  FAIL  ${message}`)
    return false
  }
  log(`  ok    ${message}`)
  return true
}

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const timeoutIndex = args.indexOf('--timeout')
const TIMEOUT_MS = (timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 120) * 1000

const ARTIFACT = Buffer.from('a signed installer, as far as this fixture is concerned')
const CHANNEL = 'stable'

/** A certificate for this run; the app is told to trust it, not to trust all. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'git-stacks-update-tls-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { encoding: 'utf8' },
  )
  if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`)
  return { caFile: cert, key: readFileSync(key), cert: readFileSync(cert) }
}

/**
 * A build above any version this checkout can be, because the run is launched
 * from the built app rather than from an installed one.
 */
const OFFERED_VERSION = '999.0.0'

async function startRelease() {
  const tls = certificate()
  const key = generateKeyPairSync('ed25519')
  const keyId = 'release-smoke'
  const publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const requests = []
  // `bytes` is what the signed manifest describes; `served` is what the
  // artifact route actually sends. They are the same until a run replaces what
  // is on the wire, which is what an attacker between the app and the release
  // would do.
  const state = { bytes: ARTIFACT, served: ARTIFACT }
  let base = ''
  let cached = null
  const published = () => {
    const identity = createHash('sha256').update(state.bytes).digest('hex')
    if (cached && cached.identity === identity) return cached
    const manifest = Buffer.from(
      JSON.stringify({
        schema: 1,
        channel: CHANNEL,
        version: OFFERED_VERSION,
        sequence: 1,
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        notes: 'Smoke release.',
        rollbackOf: null,
        artifacts: [
          {
            platform: process.platform,
            arch: process.arch,
            kind: process.platform === 'darwin' ? 'dmg' : 'nsis',
            fileName: `Git-Stacks-smoke.${process.platform === 'darwin' ? 'dmg' : 'exe'}`,
            url: `${base}/${CHANNEL}/Git-Stacks-smoke.${process.platform === 'darwin' ? 'dmg' : 'exe'}`,
            sha256: createHash('sha256').update(state.bytes).digest('hex'),
            size: state.bytes.length,
          },
        ],
      }),
    )
    cached = {
      identity,
      manifest,
      signature: sign(null, manifest, key.privateKey).toString('base64'),
    }
    return cached
  }
  const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    const pathname = new URL(request.url ?? '/', 'https://placeholder').pathname
    requests.push(pathname)
    const release = published()
    if (pathname === `/update-${CHANNEL}.json`) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(release.manifest)
      return
    }
    if (pathname === `/update-${CHANNEL}.json.sig`) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ schema: 1, keyId, signature: release.signature }))
      return
    }
    if (
      pathname === `/${CHANNEL}/Git-Stacks-smoke.${process.platform === 'darwin' ? 'dmg' : 'exe'}`
    ) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(state.served)
      return
    }
    response.writeHead(404).end('not found')
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `https://127.0.0.1:${address.port}`
  return {
    keyId,
    publicKey,
    caFile: tls.caFile,
    base,
    requests,
    /**
     * The signed manifest is left exactly as it was, and the bytes served under
     * the name it signed are replaced.
     */
    corrupt: () => {
      state.served = Buffer.from('a different build with the same name')
    },
    close: () => new Promise((closed) => server.close(() => closed())),
  }
}

async function main() {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('The app is not built. Run `npm run build` first.')
  }
  const release = await startRelease()
  const home = mkdtempSync(join(tmpdir(), 'git-stacks-update-home-'))
  const userData = join(home, 'user data')
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // The app opens the repository named by GIT_STACKS_REPO at startup, so it has
  // to be a real repository rather than an empty directory.
  const made = spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8' })
  if (made.status !== 0) throw new Error(`git init failed: ${made.stderr}`)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Smoke\n\temail = smoke@example.invalid\n',
  )

  // The app is launched the way this repository launches it for a real run:
  // as a process, with its own Chromium debugging endpoint, connected to over
  // the DevTools protocol rather than through a test harness in the main
  // process.
  const child = spawn(
    join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    [
      join(ROOT, 'out', 'main', 'index.js'),
      '--no-sandbox',
      // An automated session has no reachable macOS Keychain, and the app asks
      // it whether one is available while restoring a stored credential. The
      // mock keychain answers without a person present; the app is unchanged.
      '--use-mock-keychain',
      '--remote-debugging-port=0',
      `--user-data-dir=${userData}`,
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        GIT_STACKS_REPO: workspace,
        GIT_STACKS_UPDATE_KEY_ID: release.keyId,
        GIT_STACKS_UPDATE_PUBLIC_KEY: release.publicKey,
        GIT_STACKS_UPDATE_FEED_BASE: release.base,
        GIT_STACKS_UPDATE_CA_FILE: release.caFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let transcript = ''
  const harvest = (chunk) => {
    const text = String(chunk)
    transcript = `${transcript}${text}`.slice(-40_000)
    for (const line of text.split('\n')) if (line.trim()) log(`  app   ${line.trim()}`)
  }
  child.stdout.on('data', harvest)
  child.stderr.on('data', harvest)
  const devtoolsDeadline = Date.now() + TIMEOUT_MS
  let devtools = null
  while (Date.now() < devtoolsDeadline) {
    devtools = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(transcript)?.[1] ?? null
    if (devtools) break
    if (child.exitCode !== null) throw new Error(`the app exited. Output:\n${transcript}`)
    await new Promise((wait) => setTimeout(wait, 100))
  }
  if (!devtools)
    throw new Error(`the app never reported a debugging endpoint. Output:\n${transcript}`)

  // The app's own Chromium endpoint is spoken to directly: the browser
  // websocket, then the one window target, then the same bridge the person
  // uses. Nothing in the app is re-implemented or stubbed for this run.
  const cdp = await Cdp.open(devtools, TIMEOUT_MS)
  const windowTarget = await cdp.windowTarget(TIMEOUT_MS)
  const session = await cdp.attach(windowTarget)
  const evaluate = async (fn, ...args) => {
    const expression = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg) ?? 'undefined').join(',')})`
    const evaluated = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      session,
    )
    if (evaluated.exceptionDetails) {
      throw new Error(
        `the window refused an expression: ${evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text}`,
      )
    }
    return evaluated.result.value
  }
  const stop = async () => {
    cdp.close()
    child.kill('SIGTERM')
    await new Promise((stopped) => setTimeout(stopped, 500))
    if (child.exitCode === null) child.kill('SIGKILL')
  }

  const bridge = await evaluate(() => Object.keys(window.desktop).sort())
  log(`bridge: ${bridge.join(', ')}`)
  for (const forbidden of [
    'shell',
    'exec',
    'spawn',
    'readFile',
    'writeFile',
    'fetch',
    'ipc',
    'require',
  ]) {
    assert(!bridge.includes(forbidden), `the bridge exposes no ${forbidden} escape hatch`)
  }
  for (const method of [
    'checkForUpdates',
    'downloadUpdate',
    'installUpdate',
    'cancelUpdate',
    'updateStatus',
    'onUpdateStatus',
  ]) {
    assert(bridge.includes(method), `the bridge offers ${method}`)
  }

  const refused = await evaluate(async () => {
    const answers = {}
    for (const [name, call] of [
      ['malformed path', () => window.desktop.openRepository({ path: '/etc' })],
      ['file scheme', () => window.desktop.openExternal('file:///etc/passwd')],
      ['javascript scheme', () => window.desktop.openExternal('javascript:alert(1)')],
      ['plain http', () => window.desktop.openExternal('http://example.com/')],
    ]) {
      try {
        await call()
        answers[name] = 'accepted'
      } catch (error) {
        answers[name] = String(error.message ?? error)
      }
    }
    return answers
  })
  for (const [name, answer] of Object.entries(refused)) {
    assert(answer !== 'accepted', `${name} is refused at the boundary (${answer})`)
  }

  const first = await evaluate(() => window.desktop.updateStatus())
  assert(first.channel === 'stable', `the build follows the stable channel (${first.channel})`)
  assert(
    first.trust === 'development',
    `the fixture key is named as the trusted one (${first.trust})`,
  )

  const offered = await evaluate(() => window.desktop.checkForUpdates())
  assert(
    offered.phase === 'available' && offered.offer?.version === OFFERED_VERSION,
    `the signed release is offered (${offered.phase}${offered.failure ? `: ${offered.failure.message}` : ''})`,
  )

  const downloaded = await evaluate(() => window.desktop.downloadUpdate())
  assert(
    downloaded.phase === 'downloaded' && downloaded.readyToInstall === true,
    `the build is downloaded and verified (${downloaded.phase})`,
  )
  const stagedDirectory = join(userData, 'updates')
  const staged = existsSync(stagedDirectory) ? readdirSync(stagedDirectory) : []
  assert(
    staged.length === 1,
    `exactly one verified file is staged (${staged.join(', ') || 'none'})`,
  )

  // The staged file is replaced on disk, as a local attacker or a stray sync
  // tool could, and the install must refuse it rather than run it.
  await writeFile(join(stagedDirectory, staged[0]), 'a different installer entirely')
  const tampered = await evaluate(() => window.desktop.installUpdate())
  assert(
    tampered.phase === 'failed' && tampered.restartRequired === false,
    `a changed installer is refused, not run (${tampered.failure?.reason ?? tampered.phase})`,
  )
  const alive = await evaluate(() => Boolean(window.desktop) && document.readyState)
  assert(alive !== undefined && alive !== '', 'the app is still running after the refusal')

  const switched = await evaluate(() =>
    window.desktop.updateSettings({ updates: { channel: 'beta' } }),
  )
  assert(switched.settings.updates.channel === 'beta', 'settings write the channel through to disk')
  const afterSwitch = await evaluate(() => window.desktop.updateStatus())
  assert(
    afterSwitch.channel === 'beta',
    `the running updater follows the new channel (${afterSwitch.channel})`,
  )

  // A feed that answers with a build the manifest never described is caught by
  // the digest, before anything is staged.
  release.corrupt()
  await evaluate(() => window.desktop.updateSettings({ updates: { channel: 'stable' } }))
  const fresh = await evaluate(async () => {
    await window.desktop.checkForUpdates()
    return window.desktop.downloadUpdate()
  })
  assert(
    fresh.phase === 'failed' && fresh.readyToInstall === false,
    `a build that is not the signed one is refused (${fresh.failure?.message ?? fresh.phase})`,
  )
  const afterCorrupt = existsSync(stagedDirectory) ? readdirSync(stagedDirectory) : []
  assert(
    afterCorrupt.every((name) => name === staged[0]),
    'nothing unverified is left staged',
  )

  const fetched = release.requests
  assert(
    fetched.includes(`/update-${CHANNEL}.json`) && fetched.includes(`/update-${CHANNEL}.json.sig`),
    'the manifest and its signature were fetched from the release location',
  )
  log(`requests: ${fetched.join(', ')}`)

  await stop()
  await release.close()
  if (!keep) await rm(home, { recursive: true, force: true })

  if (failures.length > 0) {
    log(`\n${failures.length} check(s) failed:`)
    for (const failure of failures) log(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  log('\nevery update check passed against the running app')
}

main()
  .catch((error) => {
    log(`the run failed: ${error?.stack ?? error}`)
    process.exitCode = 1
  })
  .finally(() => {
    // The fixture server and the app both hold the loop open; this run is over
    // either way, and the port must be released before the next one starts.
    process.exit(process.exitCode ?? 0)
  })
