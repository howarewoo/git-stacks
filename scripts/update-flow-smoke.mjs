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

/**
 * Untrusted text as a real repository carries it: the subject of a commit
 * anyone who can push can choose. The app has to show it to someone, and
 * nothing here is a Markdown document — these surfaces are React text children,
 * so the question this run answers is whether the value is ever turned into
 * markup instead of being shown.
 */
const HOSTILE_TEXT =
  '<img src=x onerror="window.__gitStacksXss = true"> <script>window.__gitStacksXss = true</script> <b>bold</b>'

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
    /** What the signed manifest says, so the run can report what it proved. */
    manifest: () => JSON.parse(published().manifest.toString('utf8')),
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
  // A commit whose subject is hostile, written before the app opens the
  // repository, so the History view has it to render from the first frame.
  const commit = spawnSync('git', ['commit', '--quiet', '--allow-empty', '-m', HOSTILE_TEXT], {
    encoding: 'utf8',
    cwd: workspace,
  })
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`)

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
  /**
   * The window as a person uses it: real mouse events on real controls, real
   * typing, and a screenshot of what the screen actually says at each step.
   */
  const shotDirectory = join(ROOT, 'test-results', 'update-ui')
  mkdirSync(shotDirectory, { recursive: true })
  const ui = {
    shots: [],
    /**
     * Clicks a real control by what it says. A control that contains the text
     * as well counts, and the smallest such control wins, so a label inside a
     * button is the button rather than the panel around it.
     */
    async clickText(label) {
      // A control that is still on its way onto the screen is not a missing
      // control, so this waits for one rather than failing on the race.
      const deadline = Date.now() + TIMEOUT_MS
      let last = null
      while (Date.now() < deadline) {
        try {
          return await ui.click(finder, label)
        } catch (error) {
          last = error
          await new Promise((settle) => setTimeout(settle, 150))
        }
      }
      throw last ?? new Error(`no control on screen says "${label}"`)
    },
    async click(find, wanted) {
      const point = await evaluate(find, wanted)
      if (!point) {
        const visible = await evaluate(() => document.body.innerText)
        throw new Error(`no control on screen says "${wanted}". The screen says:\n${visible}`)
      }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send(
          'Input.dispatchMouseEvent',
          {
            type,
            x: Math.round(point.x),
            y: Math.round(point.y),
            button: 'left',
            buttons: type === 'mouseReleased' ? 0 : 1,
            clickCount: type === 'mouseMoved' ? 0 : 1,
          },
          session,
        )
      }
      // A click is not a state change until the app has had a frame to react.
      await new Promise((settle) => setTimeout(settle, 120))
    },
    /** Presses a key the way a person does, so a dialog can be dismissed. */
    async press(key, code, keyCode) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await cdp.send(
          'Input.dispatchKeyEvent',
          { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode },
          session,
        )
      }
      await new Promise((settle) => setTimeout(settle, 200))
    },
    /**
     * Waits until the window stops showing a dialog. Used before a dialog is
     * opened again, so what is read afterwards is what the app says when it
     * reads its own state afresh rather than what it was already showing.
     */
    async waitForGone(selector, timeoutMs = TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await ui.foreground()
        if (!(await evaluate((wanted) => Boolean(document.querySelector(wanted)), selector))) {
          return
        }
        await new Promise((settle) => setTimeout(settle, 200))
      }
      throw new Error(`the window still shows ${selector} after ${timeoutMs}ms`)
    },
    /** Types into whatever has the keyboard focus, as a person would. */
    async type(text) {
      await cdp.send('Input.insertText', { text }, session)
      await new Promise((settle) => setTimeout(settle, 200))
    },
    /**
     * A window that is not in front renders nothing Chromium will measure, and
     * an unlaid-out window reports no text. This is what a person does when
     * they look at the app, so it is done before every reading.
     */
    async foreground() {
      await cdp.send('Page.bringToFront', {}, session).catch(() => undefined)
    },
    /**
     * Clicks a control and keeps clicking until the window says what that
     * click was supposed to cause. A control that is still disabled when the
     * click lands is not a failure, it is a control that was not ready yet.
     */
    async clickUntil(label, expected) {
      const deadline = Date.now() + TIMEOUT_MS
      let last = ''
      while (Date.now() < deadline) {
        await ui.clickText(label)
        // The click is given time to land and the window to say what it caused
        // before it is tried again, because a control that was not ready yet is
        // not a control that failed.
        const until = Math.min(deadline, Date.now() + 3000)
        while (Date.now() < until) {
          await new Promise((settle) => setTimeout(settle, 200))
          await ui.foreground()
          const current = await evaluate(() => document.body.innerText)
          if (current.length > 0) last = current
          if (last.includes(expected)) return
        }
      }
      throw new Error(`clicking "${label}" never produced "${expected}". The window says:\n${last}`)
    },
    /** Waits until the updater's own status says what it should. */
    async waitForStatus(predicate, timeoutMs = TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        await ui.foreground()
        last = await evaluate(() => window.desktop.updateStatus())
        if (predicate(last)) return last
        await new Promise((settle) => setTimeout(settle, 200))
      }
      throw new Error(
        `the updater never reached the expected state. It says: ${JSON.stringify(last)}`,
      )
    },
    async text() {
      await ui.foreground()
      return evaluate(() => document.body.innerText)
    },
    /** Waits until the window has rendered something to read and click. */
    async waitForText(timeoutMs = TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await ui.foreground()
        const current = await evaluate(() => document.body.innerText)
        if (current.trim().length > 0) return current
        await new Promise((settle) => setTimeout(settle, 150))
      }
      throw new Error('the window never rendered anything to read')
    },
    /** Waits for the window to say something, so nothing is asserted on a race. */
    async waitFor(fragment, timeoutMs = TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs
      let seen = ''
      while (Date.now() < deadline) {
        await ui.foreground()
        const current = await evaluate(() => document.body.innerText)
        if (current.length > 0) seen = current
        if (seen.includes(fragment)) return
        await new Promise((settle) => setTimeout(settle, 150))
      }
      throw new Error(`the window never said "${fragment}". It says:\n${seen}`)
    },
  }
  /**
   * The smallest control on screen that says the wanted text, and where its
   * centre is. A label inside a button is the button rather than the panel
   * around it, which is why the smallest match wins.
   */
  const finder = (wanted) => {
    const controls = document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="radio"], [role="option"], [role="menuitem"], a, label',
    )
    const hits = []
    for (const control of controls) {
      const text = (control.textContent ?? '').trim()
      const named = control.getAttribute('aria-label')
      if (!text.includes(wanted) && named !== wanted) continue
      // Scrolled into view first, and only then measured: a rectangle taken
      // before the scroll points somewhere the control is not, and a click
      // outside the dialog closes it.
      control.scrollIntoView({ block: 'center' })
      const box = control.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      hits.push({ control, box, area: box.width * box.height })
    }
    if (hits.length === 0) return null
    const smallest = hits.sort((a, b) => a.area - b.area)[0]
    return {
      x: smallest.box.x + smallest.box.width / 2,
      y: smallest.box.y + smallest.box.height / 2,
      text: (smallest.control.textContent ?? '').trim(),
    }
  }

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session)
    const file = join(shotDirectory, `${name}.png`)
    await writeFile(file, Buffer.from(data, 'base64'))
    ui.shots.push(`${name}.png`)
    log(`  shot  ${file}`)
  }

  const stop = async () => {
    cdp.close()
    child.kill('SIGTERM')
    await new Promise((stopped) => setTimeout(stopped, 500))
    if (child.exitCode === null) child.kill('SIGKILL')
  }

  // An interrupted run must not leave a real Electron process behind holding a
  // user data directory and a debugging port. A signal or an early exit takes
  // the child down immediately; SIGKILL is used because the app is being
  // abandoned rather than asked, and nothing of this run's survives it.
  const abandon = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      abandon()
      process.exit(1)
    })
  }
  process.on('exit', abandon)

  // The window is still loading at this point; its bridge is not there yet.
  const bridgeDeadline = Date.now() + TIMEOUT_MS
  while (Date.now() < bridgeDeadline) {
    const ready = await evaluate(
      () => typeof window.desktop === 'object' && window.desktop !== null,
    )
    if (ready) break
    await new Promise((settle) => setTimeout(settle, 100))
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

  // Boundary refusals have no Settings control behind them, so they are asked of
  // the bridge directly and the answer that comes back is main's own.
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

  // The rest of the run is a person using the app: the palette, the settings
  // dialog, the Updates section, and the buttons in it. Each step is a real
  // mouse click on the real control, and what the window then says is read out
  // of the rendered page.
  const stagedDirectory = join(userData, 'updates')
  const stagedFiles = () => (existsSync(stagedDirectory) ? readdirSync(stagedDirectory).sort() : [])

  // The window is brought forward and given a layout before anything is clicked
  // at, because a window that has not been laid out reports no text and no
  // positions.
  await ui.waitForText()
  // A repository has to be open before the window offers its toolbar, and a
  // person opens one by clicking it on the start screen.
  await ui.clickText('workspace')
  await ui.waitForText()
  await ui.clickText('Open command palette')
  await ui.waitFor('esc Dismiss')
  await ui.type('Settings')
  await shot('01-command-palette')
  await ui.clickText('Settings…')
  await ui.clickText('Updates')
  await ui.waitFor('Channel')
  await shot('02-updates-idle')

  await ui.clickUntil('Check for updates', `Version ${OFFERED_VERSION} on the ${CHANNEL} channel`)
  await ui.waitFor(`Version ${OFFERED_VERSION} on the ${CHANNEL} channel`)
  await shot('03-update-offered')

  await ui.clickUntil('Download update', 'The release is downloaded and verified')
  await ui.waitFor('The release is downloaded and verified')
  await shot('04-update-downloaded')
  const staged = stagedFiles()
  assert(
    staged.length === 1,
    `exactly one verified file is staged (${staged.join(', ') || 'none'})`,
  )
  const stagedPath = join(stagedDirectory, staged[0])
  const signed = release.manifest().artifacts[0]
  assert(
    createHash('sha256').update(readFileSync(stagedPath)).digest('hex') === signed.sha256,
    'the staged file is the build the signed manifest described',
  )
  log(
    `the signed manifest named version ${OFFERED_VERSION} on ${CHANNEL}: ${signed.sha256.slice(0, 16)}…, ${signed.size} bytes, ${signed.platform} ${signed.arch}`,
  )

  // The staged file is replaced on disk, as a local attacker or a stray sync
  // tool could, and the install must refuse it rather than run it — and must
  // not leave the file it refused behind.
  await writeFile(stagedPath, 'a different installer entirely')
  await ui.clickUntil('Install and restart', 'The last attempt did not finish')
  await ui.waitFor('The last attempt did not finish')
  await shot('05-install-refused')
  const afterRefusal = await ui.text()
  assert(
    afterRefusal.includes('The downloaded installer no longer matches the signed release'),
    `the window shows why the install was refused (${afterRefusal.slice(0, 120)}…)`,
  )
  assert(
    !stagedFiles().includes(staged[0]),
    `the refused installer is gone from disk (${stagedFiles().join(', ') || 'nothing staged'})`,
  )
  const stillRunning = await evaluate(() => Boolean(window.desktop) && document.readyState)
  assert(
    stillRunning !== undefined && stillRunning !== '',
    'the app is still running after the refusal',
  )

  // The channel control in Settings is the same one a person uses, and the
  // running updater follows what was written.
  await ui.clickText('Beta')
  await ui.waitFor('Following the beta channel')
  await shot('06-beta-channel')
  const afterSwitch = await evaluate(() => window.desktop.updateStatus())
  assert(
    afterSwitch.channel === 'beta',
    `the running updater follows the new channel (${afterSwitch.channel})`,
  )

  // The manifest is still the one that was signed, but the build served under
  // the name it signed is a different one. The digest catches that before
  // anything is staged, and the window says so.
  await ui.clickText('Stable')
  await ui.waitFor('Following the stable channel')
  release.corrupt()
  await ui.clickUntil('Check for updates', `Version ${OFFERED_VERSION} on the ${CHANNEL} channel`)
  await ui.clickUntil('Download update', 'The last attempt did not finish')
  await ui.waitFor('The last attempt did not finish')
  await shot('07-tampered-build-refused')
  const afterTamper = await ui.text()
  assert(
    afterTamper.includes('not the size the signed manifest allowed') ||
      afterTamper.includes('does not match the signed manifest'),
    `the window shows why the build was refused (${afterTamper.slice(0, 160)}…)`,
  )
  const leftover = stagedFiles()
  for (const name of leftover) {
    const digest = createHash('sha256')
      .update(readFileSync(join(stagedDirectory, name)))
      .digest('hex')
    assert(
      digest === signed.sha256,
      `nothing unverified is left staged (${name} does not match the signed digest)`,
    )
  }
  assert(
    !leftover.includes(staged[0]),
    `the replaced installer is not left staged (${leftover.join(', ')})`,
  )

  // What the person has to be able to read is the characters of a commit subject
  // they did not write; what the DOM must not get is markup. The subject is on
  // screen in the branch card this view opens with, so the run reads that
  // surface and does not navigate somewhere else to make the point.
  await ui.press('Escape', 'Escape', 27)
  await ui.waitFor(HOSTILE_TEXT)
  const probe = await evaluate((wanted) => {
    const every = [...document.querySelectorAll('*')]
    // The deepest element that still contains the payload is the element the
    // text node sits in: everything the payload says is one text node, or the
    // renderer made part of it an element.
    let holder = null
    for (const element of every) {
      if (!(element.textContent ?? '').includes(wanted)) continue
      if (holder === null || holder.contains(element)) holder = element
    }
    return {
      holder: holder?.tagName ?? null,
      children: holder?.children.length ?? -1,
      handlers: every.filter((element) =>
        [...element.attributes].some((attribute) => attribute.name.startsWith('on')),
      ).length,
      payloadElements: document.querySelectorAll('img[src="x"], object, embed, iframe').length,
      fired: window.__gitStacksXss === true,
    }
  }, HOSTILE_TEXT)
  assert(
    probe.children === 0,
    `the subject is one text node, not markup (${probe.holder} holds ${probe.children} element(s))`,
  )
  assert(
    probe.handlers === 0,
    `nothing in the window carries an inline handler (${probe.handlers})`,
  )
  assert(
    probe.payloadElements === 0,
    `the payload became no elements (${probe.payloadElements} img/object/embed/iframe)`,
  )
  assert(probe.fired === false, 'nothing in the payload ran')
  await shot('08-untrusted-text')

  // A reset is a change like any other, and it carries the channel with it: the
  // Settings control a person presses, through the real IPC, on a running app
  // that is following the beta channel.
  await ui.clickText('Open command palette')
  await ui.waitFor('esc Dismiss')
  await ui.type('Settings')
  await ui.clickText('Settings…')
  await ui.clickText('Updates')
  await ui.waitFor('Channel')
  await ui.clickText('Beta')
  await ui.waitFor('Following the beta channel')
  const onBeta = await evaluate(() => window.desktop.updateStatus())
  assert(
    onBeta.channel === 'beta',
    `the app is following beta before the reset (${onBeta.channel})`,
  )
  await ui.clickText('Reset all')
  // A confirmation may stand between the control and the change; a person
  // answers it, and so does this.
  await Promise.resolve()
  const answered = await evaluate(() => {
    const buttons = [...document.querySelectorAll('button')]
    const confirm = buttons.find((button) => /^Reset$/u.test(button.textContent?.trim() ?? ''))
    if (!confirm) return false
    confirm.click()
    return true
  })
  if (answered) log('  confirmed the reset the dialog asked for')
  const settled = await ui.waitForStatus((status) => status.channel === 'stable')
  await shot('09-after-reset')
  const afterReset = settled
  assert(
    afterReset.channel === 'stable',
    `the reset put the running updater back on the default channel (${afterReset.channel})`,
  )
  const stored = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  assert(
    stored.updates.channel === 'stable',
    `the stored channel is the one the app is following (${stored.updates.channel})`,
  )

  // Two changes asked for at once, in the order a person asked in them, through
  // the same two public methods the Settings surface calls: a reset, and then a
  // channel. The reset has to find the channel it lands on by reading the file
  // it is about to rewrite, and doing that read before it is admitted let the
  // later request commit first and then be overwritten by the reset. The later
  // choice is the one that must survive, in the running updater and on disk.
  const raced = await evaluate(async () => {
    const answers = await Promise.allSettled([
      window.desktop.resetSettings(),
      window.desktop.updateSettings({ updates: { channel: 'beta' } }),
    ])
    return answers.map((answer) => answer.status)
  })
  assert(
    raced.every((status) => status === 'fulfilled'),
    `both changes were answered (${raced.join(', ')})`,
  )
  const racedStatus = await ui.waitForStatus((status) => status.channel === 'beta')
  assert(
    racedStatus.channel === 'beta',
    `the later choice is the one the app is following (${racedStatus.channel})`,
  )
  const racedStored = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  assert(
    racedStored.updates.channel === 'beta',
    `the stored channel is the later one (${racedStored.updates.channel})`,
  )
  // Those two say what the app is doing. They do not say what a person can see:
  // the Settings window was open across both calls and is still showing the
  // state it read when it opened, and a call made through the bridge bypasses
  // the control that would have moved the segment with it. So the window is
  // closed and opened again — a fresh read, the way a person would see it — and
  // the channel on screen is the one asserted. A stale control is a picture of
  // the past, not a claim about the app, so it is not what gets captured here.
  await ui.press('Escape', 'Escape', 27)
  await ui.waitForGone('[role="dialog"]')
  await ui.clickText('Open command palette')
  await ui.waitFor('esc Dismiss')
  await ui.type('Settings')
  await ui.clickText('Settings…')
  await ui.clickText('Updates')
  await ui.waitFor('Channel')
  const visible = await evaluate(() => {
    const group = document.querySelector('[aria-label="Channel"]')
    const pressed = group?.querySelector('button[aria-pressed="true"]')
    return pressed?.textContent?.trim() ?? null
  })
  assert(
    visible?.toLowerCase() === racedStatus.channel,
    `the channel a person can see is the one the app is following (${visible} / ${racedStatus.channel})`,
  )
  await shot('10-after-raced-reset-and-channel')

  const fetched = release.requests
  assert(
    fetched.includes(`/update-${CHANNEL}.json`) && fetched.includes(`/update-${CHANNEL}.json.sig`),
    'the manifest and its signature were fetched from the release location',
  )
  log(`requests: ${fetched.join(', ')}`)
  log(`screenshots: ${ui.shots.join(', ')}`)

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
