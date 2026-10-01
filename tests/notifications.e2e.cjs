/**
 * The optional Notification Center, driven through the real application.
 *
 * Electron runs the built main process, which answers on its own TLS socket as
 * a GitHub host, and the window reaches it only through the preload bridge: the
 * token is pasted into the dialog, crosses one IPC channel, and is sealed in the
 * operating system's store. Nothing here mutates anything on github.com — the
 * host is this script's own server — and the token never appears in a rendered
 * surface, an accessibility read, or a screenshot.
 */
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require('node:fs')
const { homedir, tmpdir } = require('node:os')
const { join } = require('node:path')
const net = require('node:net')
const { createServer } = require('node:https')
const electron = require('electron')

const TOKEN = 'ghp_smoke_token_that_must_never_appear_again'
const LAST_MODIFIED = 'Tue, 22 Sep 2026 09:41:07 GMT'

const root = mkdtempSync(join(tmpdir(), 'git-stacks-notifications-e2e-'))
const userData = join(root, 'userdata')
mkdirSync(userData, { recursive: true })
// Nothing the caller exported may reach this run: an ambient signing key, a
// real hooks path, or a real GitHub login would all turn a disposable smoke into
// an operation on the machine it happens to run on. The filter and the macOS
// HOME rule are the packaged smoke's, because that is where they were proved
// against a real window: macOS hands a sandboxed app the home the password
// database reports, and its helpers never come up against a synthetic one.
const UNSAFE_INHERITED =
  /^(GIT_|GH_|GITHUB_|GIT_STACKS_)|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^SSH_AUTH_SOCK$|(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY)/iu
const INHERITED_HOME = process.platform === 'darwin'
const disposableHome = join(root, 'home')
mkdirSync(disposableHome, { recursive: true })
// The file `git` reads instead of the caller's global configuration, so no
// commit.gpgSign, core.hooksPath, or include directive can reach a fixture commit.
const emptyGitConfig = join(root, 'gitconfig')
writeFileSync(emptyGitConfig, '')

function environment() {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !UNSAFE_INHERITED.test(key)),
  )
  return {
    ...inherited,
    HOME: INHERITED_HOME ? homedir() : disposableHome,
    XDG_CONFIG_HOME: join(disposableHome, '.config'),
    // gh reads its own configuration directory, so a real GitHub login cannot
    // be reused and no GitHub call this run makes can succeed by accident.
    GH_CONFIG_DIR: join(disposableHome, '.config', 'gh'),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGitConfig,
  }
}

const gitEnv = {
  ...environment(),
  GIT_AUTHOR_NAME: 'Notification Fixture',
  GIT_AUTHOR_EMAIL: 'notifications@example.invalid',
  GIT_COMMITTER_NAME: 'Notification Fixture',
  GIT_COMMITTER_EMAIL: 'notifications@example.invalid',
  // Belt and braces against signing: even a configuration that bypassed the
  // empty global file would have nothing here to sign with.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgSign',
  GIT_CONFIG_VALUE_0: 'false',
}
const certificate = mkdtempSync(join(root, 'cert-'))
// Generated for this run, with the address it serves named as a subject
// alternative name, because that is the part a client verifies. The application
// is given this exact file as an extra certificate authority when it starts, so
// the handshake it completes is verified rather than waved through.
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(certificate, 'key.pem'),
    '-out',
    join(certificate, 'cert.pem'),
    '-days',
    '1',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-subj',
    '/CN=127.0.0.1',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

const repository = join(root, 'fixture')
mkdirSync(repository)
// The fixture repository is committed by the same isolated `git` the app will
// see: this disposable run must not sign, run hooks, or read the machine's own
// identity and credential helpers, in either process.
function git(...args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: gitEnv,
  }).trim()
}
git('init', '-b', 'main')
writeFileSync(join(repository, 'shared.txt'), 'baseline\n')
git('add', 'shared.txt')
git('commit', '-m', 'baseline')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startGitHubHost() {
  const asked = []
  // The threads the host holds, so a write the run performs is a write the host
  // really has: a mark-read that the host forgot would make the list disagree
  // with the requests, and the point of this run is that the two agree.
  //
  // A subject URL is served by the same host the module is pinned to, on that
  // host's own API base. `SELF` stands for the origin this run's server
  // actually listened on, filled in below: a subject from another origin is not
  // this module's business, and one this host never served says nothing about
  // where its page lives.
  const SELF = '\u0000'
  let threads = [
    {
      id: '101',
      unread: true,
      reason: 'review_requested',
      subject: {
        title: 'Tidy the stack ordering rules',
        url: `${SELF}api/v3/repos/acme/widgets/pulls/101`,
        type: 'PullRequest',
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      updated_at: '2026-09-22T09:41:07Z',
    },
    {
      id: '102',
      unread: true,
      reason: 'mention',
      subject: {
        title: 'Mentioned in "Release checklist"',
        url: `${SELF}api/v3/repos/acme/widgets/issues/102`,
        type: 'Issue',
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      updated_at: '2026-09-22T09:39:00Z',
    },
    {
      // A commit is a subject this build has to resolve into a page rather than
      // hand over as an API URL, and it is served from this host's own base, so
      // the run can say which page a person would have been taken to.
      id: '103',
      unread: true,
      reason: 'subscribed',
      subject: {
        title: 'Record the stack ordering rules',
        url: `${SELF}api/v3/repos/acme/widgets/commits/9f1c0b7`,
        type: 'Commit',
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      updated_at: '2026-09-22T09:37:00Z',
    },
    {
      // A subject kind this build does not know. It stays in the inbox under the
      // label for what it could not name, and it keeps the operations that do
      // not need to understand it.
      id: '104',
      unread: true,
      reason: 'subscribed',
      subject: {
        title: 'Something this build has no name for',
        url: `${SELF}api/v3/notifications/threads/104`,
        type: 'CheckSuite',
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      updated_at: '2026-09-22T09:35:00Z',
    },
    {
      // Already read, so marking it read again is a change GitHub has nothing
      // to do, which it answers without touching the list.
      id: '105',
      unread: false,
      reason: 'subscribed',
      subject: {
        title: 'Settle the review queue ordering',
        url: `${SELF}api/v3/repos/acme/widgets/pulls/105`,
        type: 'PullRequest',
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      updated_at: '2026-09-22T09:30:00Z',
    },
  ]
  // GitHub hands the validator out with every answer and expects it back
  // unchanged, and it only answers 304 while nothing has changed. Every write
  // this host accepts moves the list, so the list it serves afterwards is a
  // different one and carries a later validator.
  let changes = 0
  const issued = () => new Date(Date.parse(LAST_MODIFIED) + changes * 1_000).toUTCString()
  // The validator the client was actually given, which is the one it has to
  // send back: the newest one would only be the answer this host has not given
  // yet.
  let answered = issued()
  // A write this host applies and then loses the answer to. GitHub can accept a
  // change and still leave the client without an answer, and the only honest
  // thing the client can then say is that it does not know, so this host does
  // exactly that: the change is real, and the answer never arrives.
  let loseNextWrite = false
  const server = createServer(
    {
      key: readFileSync(join(certificate, 'key.pem')),
      cert: readFileSync(join(certificate, 'cert.pem')),
    },
    (request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const url = new URL(request.url, 'https://127.0.0.1')
        asked.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          ifModifiedSince: request.headers['if-modified-since'] ?? null,
          authorization: request.headers.authorization ?? null,
          validatorAtArrival: answered,
        })
        const answer = (status, body, headers) => {
          response.writeHead(status, { 'content-type': 'application/json', ...headers })
          response.end(body === null ? '' : JSON.stringify(body))
        }
        // A write the host applies and then loses the answer to: the change is
        // made here, and the connection is dropped before anything is sent
        // back, so nothing can tell the client whether it landed.
        const loseAnswer = () => {
          if (!loseNextWrite) return false
          loseNextWrite = false
          request.socket.destroy()
          return true
        }
        // A host that answers anything with a success code would let a wrong
        // verb, a wrong path, and a right one all pass this run. Each request is
        // answered the way GitHub documents it, and anything else is a failure
        // the run reports rather than absorbs.
        if (url.pathname === '/api/v3/user') return answer(200, { login: 'octo' })
        const singleThread = /^\/api\/v3\/notifications\/threads\/([^/]+)$/.exec(url.pathname)
        const subscribed = /^\/api\/v3\/notifications\/threads\/([^/]+)\/subscription$/.exec(
          url.pathname,
        )
        if (request.method === 'PUT' && subscribed) {
          // Ignore is a subscription GitHub keeps: the thread stays in the
          // inbox and stops arriving.
          threads = threads.map((thread) =>
            thread.id === subscribed[1] ? { ...thread, unread: false } : thread,
          )
          changes += 1
          if (loseAnswer()) return undefined
          return answer(200, {}, {})
        }
        if (request.method === 'DELETE' && subscribed) {
          threads = threads.filter((thread) => thread.id !== subscribed[1])
          changes += 1
          if (loseAnswer()) return undefined
          return answer(204, null, {})
        }
        // Done is the thread itself and not its subscription: the conversation
        // stays watched and the thread leaves the inbox.
        if (request.method === 'DELETE' && singleThread) {
          threads = threads.filter((thread) => thread.id !== singleThread[1])
          changes += 1
          if (loseAnswer()) return undefined
          return answer(204, null, {})
        }
        // Mark all read is PUT /notifications and is accepted rather than
        // finished: GitHub answers 202 and does the work on its own time, so the
        // rows it has already changed are only confirmed by a later read.
        if (request.method === 'PUT' && url.pathname === '/api/v3/notifications') {
          threads = threads.map((thread) => ({ ...thread, unread: false }))
          changes += 1
          if (loseAnswer()) return undefined
          return answer(202, { message: 'Notifications will be marked as read.' })
        }
        // Marking one thread read is PATCH /notifications/threads/{thread_id},
        // and a thread GitHub already has read is answered 304 with no change.
        if (request.method === 'PATCH' && singleThread) {
          const held = threads.find((thread) => thread.id === singleThread[1])
          if (!held) return answer(404, { message: 'Not Found' })
          if (!held.unread) return answer(304, null, {})
          threads = threads.map((thread) =>
            thread.id === singleThread[1] ? { ...thread, unread: false } : thread,
          )
          changes += 1
          if (loseAnswer()) return undefined
          return answer(205, null, {})
        }
        if (request.method !== 'GET') return answer(405, { message: 'Method Not Allowed' })
        if (url.pathname.startsWith('/api/v3/notifications')) {
          // A conditional read is answered the way GitHub answers one: nothing
          // changed, so there is no body to send and only the validator.
          if (request.headers['if-modified-since'] === issued()) {
            return answer(304, null, { 'x-poll-interval': '60' })
          }
          answered = issued()
          return answer(200, threads, { 'last-modified': answered, 'x-poll-interval': '60' })
        }
        answer(404, { message: 'Not Found' })
      })
    },
  )
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      // The subject URLs name the origin this server really answered on, so
      // the fixture is shaped like the host the module is pinned to rather than
      // like a public one that is not in this run at all.
      const origin = `https://127.0.0.1:${server.address().port}/`
      threads = threads.map((thread) => ({
        ...thread,
        subject: { ...thread.subject, url: thread.subject.url.replace(SELF, origin) },
      }))
      resolve({
        server,
        asked,
        threads: () => threads,
        validator: () => answered,
        loseNextWrite: () => {
          loseNextWrite = true
        },
      })
    })
  })
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Writes the state this computer starts the smoke with.
 *
 * The repository is a recent one rather than a picked one, because the picker
 * is a native dialog this script cannot drive; the recents list the app itself
 * keeps and renders is the real path into the workspace, and using it means the
 * window that opens is the window a person opens.
 */
function writeStartState(host) {
  writeFileSync(
    join(userData, 'repositories.json'),
    `${JSON.stringify([{ path: repository, name: 'fixture' }], null, 2)}\n`,
  )
  writeFileSync(
    join(userData, 'settings.json'),
    `${JSON.stringify(
      {
        version: 1,
        github: { host },
        git: { useSystemGit: true },
        notifications: { enabled: false },
        privacy: { includeLocalPaths: false },
        updates: { channel: 'stable' },
        shortcuts: {},
        migrated: { legacyShortcutStorage: true },
      },
      null,
      2,
    )}\n`,
  )
}

/** Every file the app wrote, with its whole body, for the secrecy check. */
function storedFiles() {
  const bodies = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else bodies.push(readFileSync(path))
    }
  }
  walk(userData)
  return bodies.join('\n')
}
/**
 * Minimal CDP client, used to reach the main process: the window's real zoom
 * factor belongs to its webContents, and no renderer-side call can change it.
 */
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

  static async open(endpoint) {
    const socket = new WebSocket(endpoint)
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true })
      socket.addEventListener('error', () => rejectOpen(new Error(`could not open ${endpoint}`)), {
        once: true,
      })
    })
    return new Cdp(socket)
  }

  call(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluates in the inspected process and returns the value it returned. */
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
}

/** Reads or sets the real Electron zoom factor of the app window. */
const MAIN_ZOOM = `(async (factor) => {
  function resolveElectron() {
    if (typeof require === 'function') { try { return require('electron') } catch {} }
    if (process.mainModule && typeof process.mainModule.require === 'function') {
      try { return process.mainModule.require('electron') } catch {}
    }
    const getBuiltin = process.getBuiltinModule
    if (typeof getBuiltin === 'function') {
      const registered = getBuiltin('electron')
      if (registered) return registered
      const Module = getBuiltin('module')
      if (Module) return Module.createRequire(process.execPath)('electron')
    }
    throw new Error('Could not resolve the electron module from the main process')
  }
  const { BrowserWindow } = resolveElectron()
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) throw new Error('The app has no window to zoom')
  const previous = window.webContents.getZoomFactor()
  if (factor !== null) window.webContents.setZoomFactor(factor)
  return previous
})`

/**
 * Records what the app asked the operating system to open, in the main process
 * that actually calls `shell.openExternal`. A notification subject arrives as an
 * API URL, so what leaves here is what proves it was resolved into a page a
 * person can actually read on the host this run is pinned to.
 */
const MAIN_EXTERNAL = `(async (action) => {
  function resolveElectron() {
    if (typeof require === 'function') { try { return require('electron') } catch {} }
    if (process.mainModule && typeof process.mainModule.require === 'function') {
      try { return process.mainModule.require('electron') } catch {}
    }
    const getBuiltin = process.getBuiltinModule
    if (typeof getBuiltin === 'function') {
      const registered = getBuiltin('electron')
      if (registered) return registered
      const Module = getBuiltin('module')
      if (Module) return Module.createRequire(process.execPath)('electron')
    }
    throw new Error('Could not resolve the electron module from the main process')
  }
  const { shell } = resolveElectron()
  const active = globalThis.__notificationE2eLinks
  if (action === 'calls') return (active?.calls ?? []).slice()
  if (action === 'restore') {
    if (active) delete globalThis.__notificationE2eLinks
    if (active && typeof active.original === 'function') shell.openExternal = active.original
    return true
  }
  if (active) return { installed: true }
  const store = { original: shell.openExternal, calls: [] }
  const patched = async (url, options, callback) => {
    store.calls.push(String(url))
    if (typeof options === 'function') options()
    else if (typeof callback === 'function') callback()
    return true
  }
  shell.openExternal = patched
  globalThis.__notificationE2eLinks = store
  return { installed: shell.openExternal === patched }
})`

async function main() {
  const host = await startGitHubHost()
  const hostName = `127.0.0.1:${host.server.address().port}`
  writeStartState(hostName)
  const port = await availablePort()
  const env = {
    ...environment(),
    GIT_STACKS_USER_DATA: userData,
    // This run's certificate is added to the trust store the process starts
    // with. Verification is on and the chain is checked; nothing anywhere in
    // this run is told to stop checking.
    NODE_EXTRA_CA_CERTS: join(certificate, 'cert.pem'),
  }
  const app = spawn(
    electron,
    [
      join(__dirname, '..', 'out', 'main', 'index.js'),
      `--remote-debugging-port=${port}`,
      '--inspect=0',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  let inspectorEndpoint = null
  const harvest = (chunk) => {
    output += chunk
    inspectorEndpoint ??= output.match(/Debugger listening on (ws:\/\/\S+)/)?.[1] ?? null
  }
  app.stdout.on('data', harvest)
  app.stderr.on('data', harvest)
  let socket
  let main = null
  try {
    let target
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (app.exitCode !== null) throw new Error(`Electron exited: ${output}`)
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (target) break
      } catch {
        /* the main process has not started listening yet */
      }
      await delay(100)
    }
    assert.ok(target, `the renderer was unavailable: ${output}`)
    for (let attempt = 0; attempt < 200 && !inspectorEndpoint; attempt += 1) await delay(100)
    assert.ok(inspectorEndpoint, `the main process inspector never announced itself: ${output}`)
    main = await Cdp.open(inspectorEndpoint)
    await main.call('Runtime.enable')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    let nextId = 0
    const pending = new Map()
    // What the window itself complained about, so a failure names the render that
    // failed rather than only what stopped appearing on screen.
    const rendererErrors = []
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails
        rendererErrors.push(
          details?.exception?.description ?? details?.text ?? 'an exception with no description',
        )
        return
      }
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      message.error
        ? waiter.reject(new Error(message.error.message))
        : waiter.resolve(message.result)
    })
    const send = (method, params = {}) => {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    }
    await send('Runtime.enable')
    const page = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (result.exceptionDetails) {
        throw new Error(`${result.exceptionDetails.text}: ${JSON.stringify(expression)}`)
      }
      return result.result.value
    }
    const until = async (description, expression, attempts = 900) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await page(`Boolean(${expression})`)) return
        await delay(50)
      }
      throw new Error(
        `timed out waiting for ${description}; the window reads: ${await page('document.body.innerText')}\nthe window reported: ${rendererErrors.join('\n') || 'nothing'}`,
      )
    }
    // Evidence is written where the run is asked to keep it, so a reviewer can
    // look at what the window actually showed; without that it stays in the
    // disposable workspace and is cleaned up with everything else.
    const evidence = process.env.GIT_STACKS_NOTIFICATION_EVIDENCE
    if (evidence) mkdirSync(evidence, { recursive: true })
    const screenshot = async (name, options = {}) => {
      // A viewport shot is what a person actually sees. Growing the capture past
      // the viewport to take in the whole document repaints a fixed dialog at
      // the position it held in the shorter viewport it was opened in, so an
      // overlaid surface is only trustworthy in a shot of the viewport itself.
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        ...(options.viewportOnly
          ? { captureBeyondViewport: false }
          : { captureBeyondViewport: true }),
      })
      const path = join(evidence ?? root, `${name}.png`)
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
      return path
    }
    const resize = async (width, height) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await delay(400)
    }
    /**
     * The window's real zoom factor, set by the process that owns it. A
     * doubled deviceScaleFactor would only make more pixels of the same layout,
     * so the only thing that proves 200% is the halved CSS viewport this returns.
     */
    const zoom = async (factor, expectedWidth) => {
      const previous = await main.evaluate(`(${MAIN_ZOOM})(${JSON.stringify(factor)})`)
      let reached = null
      for (let attempt = 0; attempt < 150; attempt += 1) {
        reached = await page(
          '({ width: window.innerWidth, scale: window.visualViewport ? window.visualViewport.scale : null })',
        )
        if (Math.abs(reached.width - expectedWidth) <= 2) break
        await delay(100)
      }
      assert.ok(
        reached !== null && Math.abs(reached.width - expectedWidth) <= 2,
        `zoom factor ${factor} left a ${reached?.width}px CSS viewport, not the ${expectedWidth}px that zoom produces: ${output.slice(-1500)}`,
      )
      return previous
    }
    const key = async (keyName, code, virtual, modifiers = 0) => {
      const options = { key: keyName, code, windowsVirtualKeyCode: virtual, modifiers }
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyDown' })
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyUp' })
    }
    /** The box of the element an expression finds, in CSS pixels, or null. */
    const boxOf = async (expression) =>
      page(`(() => {
        const el = ${expression}
        if (!el) return null
        const box = el.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      })()`)
    /**
     * A real pointer press at a real point. The press travels the same path a
     * person's does, so a control that was scrolled out of the viewport or
     * covered by something else is reported as unreachable rather than being
     * pressed anyway by a click that never went through the window.
     */
    const press = async (expression, description) => {
      const box = await boxOf(expression)
      if (!box) {
        throw new Error(`no ${description} on screen: ${await page('document.body.innerText')}`)
      }
      const viewport = await page('({ width: window.innerWidth, height: window.innerHeight })')
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1,
        `${description} is not inside the viewport a person presses in: ${JSON.stringify({ box, viewport })}`,
      )
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
    }
    /** Scrolls a control into the viewport the way a person scrolls to it. */
    const reveal = async (expression, description) => {
      const scrolled = await page(
        `(() => { const el = ${expression}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`,
      )
      assert.equal(scrolled, true, `no ${description} to scroll to`)
      await delay(300)
    }
    /** A control on the row that names this thread, labelled as it is on screen. */
    const control = (title, label) =>
      `[...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))?.querySelector('[aria-label=${JSON.stringify(label)}]')`
    const viewportOf = () => page('({ width: window.innerWidth, height: window.innerHeight })')
    /** Whether the box is really inside the viewport a person is looking at. */
    const inView = async (expression, description) => {
      const box = await boxOf(expression)
      assert.ok(box, `no ${description} on screen`)
      const viewport = await viewportOf()
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1,
        `${description} is on screen but not inside the viewport: ${JSON.stringify({ box, viewport })}`,
      )
      return box
    }

    // The window starts in onboarding with this run's repository among its
    // recents, and opening it from there is the same path a person takes.
    await until(
      'the recent repository',
      `document.querySelector('button.onboarding-recent strong')?.textContent === 'fixture'`,
    )
    await page(`document.querySelector('button.onboarding-recent').click()`)
    await until(
      'the workspace navigation',
      `document.querySelector('nav') && !document.body.innerText.includes('Start with a repository')`,
      1800,
    )
    assert.ok(
      await page(
        `Boolean([...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('Notifications')))`,
      ),
      'the destination is in the navigation a person can reach',
    )
    await page(
      `[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('Notifications')).click()`,
    )
    const heading = await page(`document.querySelector('h1')?.textContent ?? ''`)
    assert.equal(heading, 'GitHub Notifications', `the view the click reached reads: ${heading}`)
    assert.equal(
      await page(`document.body.innerText.includes('This module is off')`),
      true,
      'a module nobody has enabled says so, and does not ask for a token yet',
    )
    assert.equal(
      await page(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Authorize notifications')`,
      ),
      false,
      'no authorization is offered before this computer has agreed to the module at all',
    )
    assert.equal(
      await page(`document.body.innerText.includes(${JSON.stringify(TOKEN)})`),
      false,
      'no token is on screen before one is entered',
    )
    const offScreenshot = await screenshot('notifications-off')

    // The module is enabled the way a person enables it: from Settings, which
    // states the credential boundary in full before the switch is touched.
    await key('k', 'KeyK', 75, 4)
    await until('the command palette', `document.querySelector('[aria-label^="Search actions"]')`)
    for (const character of 'Settings') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    await until(
      'the settings command',
      `[...document.querySelectorAll('[aria-label="Command suggestions"] [role="option"]')].some((b) => b.textContent.includes('Settings'))`,
    )
    await page(
      `[...document.querySelectorAll('[aria-label="Command suggestions"] [role="option"]')].find((b) => b.textContent.includes('Settings')).click()`,
    )
    await until(
      'the settings dialog',
      `document.querySelector('nav[aria-label="Settings sections"]')`,
    )
    await page(
      `[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find((b) => b.textContent.trim() === 'Notifications').click()`,
    )
    await until('the notifications setting', `document.querySelector('#settings-notifications')`)
    const enabledScreenshot = await screenshot('notifications-setting')
    await page(`document.querySelector('#settings-notifications').click()`)
    await until(
      'the module to be enabled',
      `document.body.innerText.includes('GitHub Notifications enabled')`,
    )
    await key('Escape', 'Escape', 27)
    await until(
      'the settings dialog to close',
      `!document.querySelector('nav[aria-label="Settings sections"]')`,
    )
    await until(
      'the notification destination to be open again',
      `document.querySelector('h1')?.textContent === 'GitHub Notifications'`,
    )
    assert.equal(
      await page(`document.body.innerText.includes('This module is off')`),
      false,
      'the module is no longer off once this computer has turned it on',
    )
    assert.equal(
      await page(`document.body.innerText.includes('No credential stored')`),
      true,
      'enabling asks for no token by itself; only a stored one makes this a live inbox',
    )
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Authorize notifications').click()`,
    )
    await until(
      'the credential dialog',
      `document.querySelector('[aria-label="GitHub Notifications credential"]')`,
    )
    // The dialog's facts, not its copy: it names the host this run's credential
    // is pinned to, and nothing can be submitted until the boundary is ticked.
    const boundary = await page(
      `(() => {
        const dialog = document.querySelector('[aria-label="GitHub Notifications credential"]')
        const terms = [...dialog.querySelectorAll('dt')].map((dt) => dt.textContent.trim())
        const values = [...dialog.querySelectorAll('dd')].map((dd) => dd.textContent.trim())
        const checked = [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].some((box) => box.getAttribute('aria-checked') === 'true' || box.checked === true)
        return { host: terms.indexOf('Host') === -1 ? null : values[terms.indexOf('Host')], checked }
      })()`,
    )
    assert.equal(
      boundary.host,
      hostName,
      `the consent names the host this credential is pinned to: ${JSON.stringify(boundary)}`,
    )
    assert.equal(boundary.checked, false, 'no consent is given before the dialog is opened')
    const submitDisabledBeforeConsent = await page(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].filter((b) => b.textContent.includes('Authorize')).every((b) => b.disabled)`,
    )
    assert.equal(submitDisabledBeforeConsent, true, 'consent is required before a token is stored')

    // While the dialog owns focus it is the only modal: a global shortcut
    // pressed from inside its fields must not open the command palette
    // underneath it.
    await key('k', 'KeyK', 75, 4)
    await delay(500)
    assert.equal(
      await page(`Boolean(document.querySelector('[aria-label^="Search actions"]'))`),
      false,
      'a global shortcut inside the credential dialog does not open the command palette through it',
    )

    // Type into the real input so the value travels the real event path.
    await page(
      `(() => { const input = document.querySelector('[aria-label="GitHub Notifications credential"] input'); input.focus(); return true })()`,
    )
    for (const character of TOKEN) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    await page(
      `(() => { const box = [...document.querySelectorAll('[aria-label="GitHub Notifications credential"] input')].find((i) => i.type === 'checkbox' || i.getAttribute('role') === 'checkbox') || document.querySelector('[aria-label="GitHub Notifications credential"] [role="checkbox"]'); box.click(); return true })()`,
    )
    await page(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.includes('Authorize')).click()`,
    )

    // The list GitHub served appears, marked as its own thing.
    await until(
      'the notification threads',
      `document.body.innerText.includes('Tidy the stack ordering rules')`,
      1200,
    )
    const ready = await page(`document.body.innerText`)
    assert.ok(
      ready.includes('Enabled'),
      `the module reports itself enabled: ${ready.slice(0, 400)}`,
    )
    assert.ok(
      ready.includes('at most one read every 60s'),
      'the interval GitHub asked for is on screen',
    )
    assert.equal(ready.includes(TOKEN), false, 'the token is not on screen once it is stored')
    assert.deepEqual(
      host.asked.map((entry) => `${entry.method} ${entry.path}`),
      ['GET /api/v3/user', 'GET /api/v3/notifications?per_page=50&all=true'],
      'the module identifies the token and reads the list once, over its own transport only',
    )
    assert.equal(
      host.asked.every((entry) => entry.authorization === `Bearer ${TOKEN}`),
      true,
      'every request carried this module’s own credential and nothing else',
    )

    // The stored token reached the sealed store, not a readable file.
    const stored = storedFiles()
    assert.equal(stored.includes(TOKEN), false, 'no file this app wrote holds the token')

    const standard = await screenshot('notifications-standard')

    // Opening a thread hands the operating system a page, not an API endpoint.
    // The host this run is pinned to is the only origin allowed, and each
    // subject has to arrive there as the page a person can read: a pull request
    // and a commit are different subjects with different pages, so one of them
    // resolving to the other's address would pass a run that only ever saw one.
    assert.deepEqual(
      await main.evaluate(`(${MAIN_EXTERNAL})('install')`),
      { installed: true },
      'the run could not intercept the links this app opens',
    )
    const openedPages = async (title, label) => {
      const controlOnRow = control(title, label)
      const before = await main.evaluate(`(${MAIN_EXTERNAL})('calls')`)
      await reveal(controlOnRow, `the Open control for ${title}`)
      await inView(controlOnRow, `the Open control for ${title}`)
      await press(controlOnRow, `the Open control for ${title}`)
      let calls = before
      for (let attempt = 0; attempt < 100 && calls.length === before.length; attempt += 1) {
        await delay(100)
        calls = await main.evaluate(`(${MAIN_EXTERNAL})('calls')`)
      }
      const opened = calls.slice(before.length)
      if (opened.length === 0) {
        throw new Error(
          `opening ${title} reached no browser: the window reads ${JSON.stringify(
            await page(
              `[...document.querySelectorAll('[role="listitem"]')].map((r) => ({ text: r.innerText.slice(0, 60), open: Boolean(r.querySelector('[aria-label^="Open "]:not([disabled])')) }))`,
            ),
          )} and reported ${JSON.stringify(await page('document.body.innerText.slice(-400)'))}`,
        )
      }
      return opened
    }
    assert.deepEqual(
      await openedPages(
        'Tidy the stack ordering rules',
        'Open Tidy the stack ordering rules on GitHub',
      ),
      [`https://${hostName}/acme/widgets/pull/101`],
      'the pull request API URL was resolved to a page on the host this module is pinned to',
    )
    assert.deepEqual(
      await openedPages(
        'Record the stack ordering rules',
        'Open Record the stack ordering rules on GitHub',
      ),
      [`https://${hostName}/acme/widgets/commit/9f1c0b7`],
      'a commit subject resolves to the commit page, singular, and not an API URL or a plural tree',
    )
    await main.evaluate(`(${MAIN_EXTERNAL})('restore')`)
    /** What the window says each row is: the badge, not the button's wording. */
    const rowsOnScreen = async () =>
      page(
        `[...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].map((row) => ({
          title: row.querySelector('strong')?.textContent.trim() ?? '',
          state: row.querySelector('[class*="badge"]')?.textContent.trim()
            ?? [...row.querySelectorAll('span')].map((s) => s.textContent.trim()).find((t) => t === 'Read' || t === 'Unread')
            ?? null,
          controls: [...row.querySelectorAll('button')].map((b) => ({
            name: b.getAttribute('aria-label') ?? b.textContent.trim(),
            enabled: !b.disabled,
          })),
        }))`,
      )


    // Marking one thread read writes to this host once and updates the row. The
    // control is the one on the row it acts on, pressed with a real pointer.
    await reveal(
      control('Tidy the stack ordering rules', 'Mark Tidy the stack ordering rules as read'),
      'the mark read control',
    )
    await press(
      control('Tidy the stack ordering rules', 'Mark Tidy the stack ordering rules as read'),
      'the mark read control',
    )
    await until(
      'the first thread to be marked read',
      `[...document.querySelectorAll('[role="listitem"]')].some((r) => r.innerText.includes('Tidy the stack ordering rules') && !r.innerText.includes('Unread'))`,
      600,
    )
    const writes = host.asked.filter((entry) => entry.method === 'PATCH')
    assert.equal(writes.length, 1, `marking read is sent once: ${JSON.stringify(writes)}`)
    assert.equal(writes[0].path, '/api/v3/notifications/threads/101')


    // A thread GitHub already has read is a change it has nothing to do, and it
    // says so with 304 rather than pretending the row changed.
    assert.equal(
      (await rowsOnScreen()).find((row) => row.title.includes('Settle the review queue ordering'))
        ?.state,
      'Read',
      'a thread this host already had read is on screen as read',
    )
    assert.equal(
      (await rowsOnScreen()).find(
        (row) => row.title.includes('Settle the review queue ordering'),
      )?.controls.find((entry) => entry.name === 'Mark Settle the review queue ordering as read')
        ?.enabled,
      false,
      'and this app offers no read to repeat for a row that is already read',
    )

    // Mark all read is the bulk operation GitHub documents as PUT /notifications,
    // and it is the one operation GitHub accepts without finishing: the answer
    // is 202 and the rows keep the state they were last confirmed in until a
    // later read says what GitHub did.
    await reveal(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Mark all read')`,
      'the mark all read control',
    )
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Mark all read')`,
      'the mark all read control',
    )
    const bulkDeadline = Date.now() + 10_000
    let bulk = host.asked.filter((entry) => entry.method === 'PUT')
    while (Date.now() < bulkDeadline && bulk.length === 0) {
      await delay(100)
      bulk = host.asked.filter((entry) => entry.method === 'PUT')
    }
    assert.deepEqual(
      bulk.map((entry) => `${entry.method} ${entry.path}`),
      ['PUT /api/v3/notifications'],
      'marking the whole inbox read is the documented bulk request, sent once',
    )
    await until(
      'the accepted change to be announced',
      `Boolean(document.querySelector('[role="status"]'))`,
      600,
    )
    const accepted = await page(`document.querySelector('[role="status"]')?.innerText ?? ''`)
    assert.ok(
      !/failed|did not|unsuccessful|not applied/i.test(accepted),
      `an accepted change is not reported as a failure: ${accepted}`,
    )
    const stillUnread = (await rowsOnScreen()).filter((row) => row.state === 'Unread')
    assert.ok(
      stillUnread.length > 0,
      `an accepted change leaves the rows as they were last confirmed: ${JSON.stringify(await rowsOnScreen())}`,
    )
    assert.equal(
      await page(
        `[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Mark all read').some((b) => !b.disabled)`,
      ),
      false,
      'and the same change is not offered again while it is still unconfirmed',
    )

    // The interval GitHub asked for is a floor a person cannot outrun either:
    // asking again straight away sends nothing, so the accepted change is still
    // waiting to be confirmed rather than quietly becoming confirmed.
    const readsBefore = host.asked.length
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh')`,
      'the refresh control',
    )
    await delay(1_000)
    assert.equal(
      host.asked.length,
      readsBefore,
      'a read asked for inside the interval GitHub named is not sent at all',
    )
    assert.equal(
      (await rowsOnScreen()).filter((row) => row.state === 'Unread').length,
      stillUnread.length,
      'and nothing is claimed as confirmed on the strength of a read that was never sent',
    )

    // Once the interval has passed, the read is sent and it is conditional. The
    // host has changed since the last list, so it answers with the list it now
    // holds rather than 304, and that answer is what confirms the accepted bulk
    // change: the notice goes away because GitHub's own list says it is done,
    // not because this app decided to call it done.
    await delay(62_000)
    const readsBeforeConfirmation = host.asked.length
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh')`,
      'the refresh control',
    )
    for (
      let attempt = 0;
      attempt < 200 && host.asked.length === readsBeforeConfirmation;
      attempt += 1
    ) {
      await delay(50)
    }
    const confirming = host.asked.at(-1)
    assert.equal(
      confirming.ifModifiedSince,
      confirming.validatorAtArrival,
      'the validator sent back is the one this host last issued, unchanged',
    )
    assert.equal(
      host.asked.length <= readsBeforeConfirmation + 1,
      true,
      'a changed list ends the read rather than asking for another page',
    )
    await until(
      'the accepted change to be confirmed by what GitHub holds',
      `[...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].length > 0 && [...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].every((row) => row.innerText.includes('Read') && !row.innerText.includes('Unread'))`,
      600,
    )
    assert.equal(
      await page(`Boolean(document.querySelector('[role="status"]'))`),
      false,
      'the accepted notice is gone once a read says what GitHub did',
    )
    assert.equal(
      (await rowsOnScreen()).every((row) => row.state === 'Read'),
      true,
      'the inbox on screen agrees with the host after the bulk change: ' +
        JSON.stringify(await rowsOnScreen()),
    )

    // A subject kind this build does not know stays in the inbox. It keeps every
    // operation that addresses the thread by its own id, and it is the only one
    // with no Open, because there is no page for it to open.
    const unnamed = (await rowsOnScreen()).find(
      (row) => row.title.includes('Something this build has no name for'),
    )
    assert.ok(unnamed, 'a subject this build cannot name is still in the inbox')
    assert.deepEqual(
      unnamed.controls.map((entry) => entry.name),
      [
        'Mark Something this build has no name for as read',
        'Mark Something this build has no name for as done',
        'Open Something this build has no name for on GitHub',
        'Ignore Something this build has no name for',
        'Unsubscribe from Something this build has no name for',
      ],
      'every thread offers its own operations, and only the browser link needs a page',
    )
    assert.equal(
      unnamed.controls.find((entry) => entry.name.startsWith('Open ')).enabled,
      false,
      'and the one operation that would need a page this host named is not offered',
    )

    // Done is the thread and not the subscription: the row leaves the inbox, the
    // request is the thread's own, and no subscription is touched by it.
    await reveal(
      control('Record the stack ordering rules', 'Mark Record the stack ordering rules as done'),
      'the done control',
    )
    await press(
      control('Record the stack ordering rules', 'Mark Record the stack ordering rules as done'),
      'the done control',
    )
    await until(
      'the completed thread to leave the inbox',
      `!document.body.innerText.includes('Record the stack ordering rules') && document.body.innerText.includes('Tidy the stack ordering rules')`,
      600,
    )
    assert.equal(
      host.threads().some((thread) => thread.id === '103'),
      false,
      'the host removed that thread itself',
    )

    // Unsubscribing is per thread, so the named row's own control is the one
    // used: the row that leaves the list is the row that was acted on, and the
    // host is the one that decides it left.
    await reveal(
      control('Mentioned in "Release checklist"', 'Unsubscribe from Mentioned in "Release checklist"'),
      'the unsubscribe control',
    )
    await press(
      control('Mentioned in "Release checklist"', 'Unsubscribe from Mentioned in "Release checklist"'),
      'the unsubscribe control',
    )
    await until(
      'the unsubscribed thread to leave the list',
      `!document.body.innerText.includes('Release checklist') && document.body.innerText.includes('Tidy the stack ordering rules')`,
      600,
    )
    assert.deepEqual(
      host.asked.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path),
      [
        '/api/v3/notifications/threads/103',
        '/api/v3/notifications/threads/102/subscription',
      ],
      'Done and Unsubscribe are two different requests, and each took the thread it named with it',
    )

    // The conditional read that follows a list nothing changed keeps that list
    // whole rather than replacing it with whatever page answered, so the
    // acknowledged reads and the removals stay on screen.
    await delay(62_000)
    const readsBeforeReplay = host.asked.length
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh')`,
      'the refresh control',
    )
    for (let attempt = 0; attempt < 200 && host.asked.length === readsBeforeReplay; attempt += 1) {
      await delay(50)
    }
    assert.equal(host.asked.length, readsBeforeReplay + 1, 'a 304 ends the read')
    await delay(500)
    const replayed = await rowsOnScreen()
    assert.equal(
      replayed.some((row) => row.title.includes('Record the stack ordering rules')),
      false,
      'a completed thread does not come back on the replay of an unchanged list',
    )
    assert.equal(
      replayed.every((row) => row.state === 'Read'),
      true,
      'the acknowledged read marks survive the conditional read: ' + JSON.stringify(replayed),
    )
    assert.equal(
      replayed.length,
      host.threads().length,
      'and the list on screen is the list the host holds',
    )

    // The keyboard route reaches the view and the dialog, without a pointer.
    await resize(1024, 768)
    await page(`document.body.focus()`)
    await page(`document.querySelector('nav button').focus()`)
    for (let index = 0; index < 8; index += 1) {
      await key('ArrowDown', 'ArrowDown', 40)
    }
    const keyboardFocused = await page(`document.activeElement?.textContent ?? ''`)
    assert.ok(
      keyboardFocused.includes('GitHub Notifications'),
      `the notification destination is reachable by keyboard: ${keyboardFocused}`,
    )
    const minimum = await screenshot('notifications-minimum')

    // Real 200% zoom, applied by the process that owns the window. More
    // screenshot pixels would only be the same layout at a higher density, so
    // what is checked here is the halved CSS viewport, and then the rows and
    // their controls being brought into it and used there: a camera pointed at
    // a layout that only exists off screen says nothing about using it.
    const baselineWidth = await page('window.innerWidth')
    const originalZoom = await zoom(2, Math.round(baselineWidth / 2))
    assert.equal(
      await page(`document.documentElement.scrollWidth > window.innerWidth`),
      false,
      'the view reflows at 200% zoom rather than forcing a horizontal scrollbar',
    )
    const remainingRows = (await rowsOnScreen()).filter((row) =>
      row.title.includes('Tidy the stack ordering rules') ||
      row.title.includes('Something this build has no name for') ||
      row.title.includes('Settle the review queue ordering'),
    )
    assert.ok(remainingRows.length === 3, `the inbox still holds its threads: ${remainingRows.length}`)
    const rowTitles = remainingRows.map((row) => row.title.trim())
    let zoomedInbox = null
    for (const title of rowTitles) {
      await reveal(
        `[...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`,
        `the row for ${title}`,
      )
      await inView(
        `[...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`,
        `the row for ${title}`,
      )
      for (const name of [
        `Mark ${title} as read`,
        `Mark ${title} as done`,
        `Open ${title} on GitHub`,
        `Ignore ${title}`,
        `Unsubscribe from ${title}`,
      ]) {
        const controlOnThisRow = `[...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))?.querySelector('[aria-label=${JSON.stringify(name)}]')`
        await inView(controlOnThisRow, `the ${name} control at 200% zoom`)
      }
      zoomedInbox ??= await screenshot(`notifications-zoom-200-row`, { viewportOnly: true })
    }
    const firstRowTitle = rowTitles[0]
    const actedRow = (title) =>
      `[...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`
    // Reading a row at the zoom with a real pointer, and the host's own answer
    // to it. It is a row the host still has unread, so the change is a real one
    // rather than a control that has nothing left to do.
    const readRowTitle = 'Something this build has no name for'
    const readLabel = `Mark ${readRowTitle} as read`
    await reveal(control(readRowTitle, readLabel), `the ${readLabel} control`)
    await press(control(readRowTitle, readLabel), `the ${readLabel} control`)
    await until(
      'the row to be read',
      `${actedRow(readRowTitle)}?.innerText.includes('Read') && !${actedRow(readRowTitle)}?.innerText.includes('Unread')`,
      600,
    )
    assert.ok(
      host.asked.some(
        (entry) => entry.method === 'PATCH' && entry.path === '/api/v3/notifications/threads/104',
      ),
      'reading a row at 200% zoom reaches GitHub as the thread it names',
    )
    const zoomedRead = await screenshot('notifications-zoom-200-read', { viewportOnly: true })
    // The browser link for the same row at the zoom, resolved by the producer and
    // handed to the operating system.
    assert.deepEqual(
      await main.evaluate(`(${MAIN_EXTERNAL})('install')`),
      { installed: true },
      'the run could not intercept the links this app opens at this zoom',
    )
    const openLabel = `Open ${firstRowTitle} on GitHub`
    await reveal(control(firstRowTitle, openLabel), `the ${openLabel} control`)
    await press(control(firstRowTitle, openLabel), `the ${openLabel} control`)
    let zoomedOpened = []
    for (let attempt = 0; attempt < 100 && zoomedOpened.length === 0; attempt += 1) {
      await delay(100)
      zoomedOpened = await main.evaluate(`(${MAIN_EXTERNAL})('calls')`)
    }
    assert.deepEqual(
      zoomedOpened,
      [`https://${hostName}/acme/widgets/pull/101`],
      'a thread is opened to its page at 200% zoom as well as at 100%',
    )
    const zoomedOpen = await screenshot('notifications-zoom-200-open', { viewportOnly: true })
    // The thread this build cannot name keeps its operations at this zoom, and
    // the one operation that would need a page it does not have is pressed and
    // observed not to do anything, rather than quietly reaching GitHub.
    const unnamedTitle = 'Something this build has no name for'
    const unnamedOpen = `Open ${unnamedTitle} on GitHub`
    await reveal(control(unnamedTitle, unnamedOpen), `the ${unnamedOpen} control`)
    const opensBefore = host.asked.length
    await press(control(unnamedTitle, unnamedOpen), `the ${unnamedOpen} control`)
    await delay(1_000)
    assert.equal(
      host.asked.length,
      opensBefore,
      'a row with no page of its own sends nothing when its link is pressed',
    )
    const zoomedUnnamed = await screenshot('notifications-zoom-200-unnamed', { viewportOnly: true })
    // Completing a thread at the zoom, which is the operation this build added
    // as its own: the row leaves the inbox and the subscription is untouched.
    const doneTitle = 'Settle the review queue ordering'
    const doneLabel = `Mark ${doneTitle} as done`
    await reveal(control(doneTitle, doneLabel), `the ${doneLabel} control`)
    await press(control(doneTitle, doneLabel), `the ${doneLabel} control`)
    await until(
      'the completed thread to leave the inbox',
      `!document.body.innerText.includes(${JSON.stringify(doneTitle)})`,
      600,
    )
    assert.ok(
      host.asked.some(
        (entry) => entry.method === 'DELETE' && entry.path === '/api/v3/notifications/threads/105',
      ),
      'Done is sent as the thread itself, not as its subscription',
    )
    const zoomedDone = await screenshot('notifications-zoom-200-done', { viewportOnly: true })
    await main.evaluate(`(${MAIN_EXTERNAL})('restore')`)
    // The remaining subscription control, reached with the keyboard alone, and
    // what it did is read back off the host.
    const ignoreLabel = `Ignore ${firstRowTitle}`
    await reveal(control(firstRowTitle, ignoreLabel), `the ${ignoreLabel} control`)
    await press(control(firstRowTitle, ignoreLabel), `the ${ignoreLabel} control`)
    await until(
      'the ignored thread to be read on the host',
      `${actedRow(firstRowTitle)}?.innerText.includes('Read')`,
      600,
    )
    assert.ok(
      host.asked.some((entry) => entry.method === 'PUT' && entry.path.endsWith('/subscription')),
      'ignoring a thread is the subscription change GitHub documents, sent once',
    )
    const zoomedAction = await screenshot('notifications-zoom-200-action', { viewportOnly: true })
    await page(
      `document.querySelector('[aria-label=${JSON.stringify(`Unsubscribe from ${firstRowTitle}`)}]')?.focus()`,
    )
    await key('Enter', 'Enter', 13)
    await until(
      'the keyboard to unsubscribe the focused thread',
      `!document.body.innerText.includes(${JSON.stringify(firstRowTitle)})`,
      600,
    )
    assert.ok(
      host.asked.some(
        (entry) => entry.method === 'DELETE' && entry.path.endsWith('/subscription'),
      ),
      'the keyboard reached the same subscription control a pointer reaches',
    )
    const zoomedKeyboard = await screenshot('notifications-zoom-200-keyboard', { viewportOnly: true })

    // The consent step has to stay reachable at the same zoom: it is the one
    // control that cannot be reached by resizing the window, so its input, its
    // consent, and its submit are scrolled to, pressed, and used there.
    await reveal(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove credential')`,
      'the remove credential control',
    )
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove credential')`,
      'the remove credential control',
    )
    await until(
      'the module to be back to needing a credential',
      `document.body.innerText.includes('No credential stored')`,
      600,
    )
    await reveal(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Authorize notifications')`,
      'the authorize control',
    )
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Authorize notifications')`,
      'the authorize control',
    )
    await until(
      'the credential dialog at 200% zoom',
      `document.querySelector('[aria-label="GitHub Notifications credential"]')`,
    )
    const dialog = (part) =>
      `document.querySelector('[aria-label="GitHub Notifications credential"] ${part}')`
    await inView(dialog('*'), 'the consent dialog')
    await reveal(dialog('input:not([type="checkbox"])'), 'the token field at 200% zoom')
    await inView(dialog('input:not([type="checkbox"])'), 'the token field at 200% zoom')
    await page(`(() => { const input = ${dialog('input:not([type="checkbox"])')}; input.focus(); return true })()`)
    for (const character of TOKEN) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    // Cancel has to be reachable from inside the dialog with the keyboard too,
    // and a cancelled consent is a consent that stored nothing: the token typed
    // before it is gone when the dialog is opened again.
    await page(`(() => { const box = ${dialog('input[type="checkbox"], [role="checkbox"]')}; if (box) box.focus(); return true })()`)
    await reveal(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.trim() === 'Cancel')`,
      'the consent cancel at 200% zoom',
    )
    await inView(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.trim() === 'Cancel')`,
      'the consent cancel',
    )
    await page(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.trim() === 'Cancel').focus()`,
    )
    await key('Enter', 'Enter', 13)
    await until(
      'the dialog to close on cancel',
      `!document.querySelector('[aria-label="GitHub Notifications credential"]')`,
      600,
    )
    const zoomedCancel = await screenshot('notifications-zoom-200-consent-cancel', {
      viewportOnly: true,
    })
    const asksBeforeReopen = host.asked.length
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Authorize notifications')`,
      'the authorize control',
    )
    await until(
      'the credential dialog to open again',
      `document.querySelector('[aria-label="GitHub Notifications credential"]')`,
    )
    assert.equal(
      await page(`${dialog('input:not([type="checkbox"])')}?.value ?? ''`),
      '',
      'a cancelled consent stores nothing: reopening asks for the token again',
    )
    assert.equal(
      host.asked.length,
      asksBeforeReopen,
      'and a cancelled consent is not a credential GitHub was asked about',
    )
    await reveal(dialog('input:not([type="checkbox"])'), 'the token field at 200% zoom')
    await page(`(() => { const input = ${dialog('input:not([type="checkbox"])')}; input.focus(); return true })()`)
    for (const character of TOKEN) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    await reveal(
      dialog('input[type="checkbox"], [role="checkbox"]'),
      'the consent control at 200% zoom',
    )
    await inView(
      dialog('input[type="checkbox"], [role="checkbox"]'),
      'the consent control',
    )
    await press(
      dialog('input[type="checkbox"], [role="checkbox"]'),
      'the consent control at 200% zoom',
    )
    const zoomedConsent = await screenshot('notifications-zoom-200-consent', { viewportOnly: true })
    await reveal(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.trim() === 'Authorize')`,
      'the consent submit at 200% zoom',
    )
    await press(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.trim() === 'Authorize')`,
      'the consent submit at 200% zoom',
    )
    await until(
      'the list this credential is for, read at 200% zoom',
      `document.body.innerText.includes('Something this build has no name for')`,
      1200,
    )
    await zoom(originalZoom, baselineWidth)
    await resize(1024, 768)

    // The unknown subject the producer stored is this producer's own record, not
    // something this run handed the view: it is in the file the module wrote for
    // this host, and the restart below reads it back without any help from here.
    const unknownRowTitle = 'Something this build has no name for'
    // The in-place host change a person makes in Settings, with this app's own
    // account still absent and no push anything: the inbox this window is
    // showing belongs to one host, and changing the host in place has to
    // replace it rather than leave the previous host's private threads in a
    // window that is now pointed somewhere else.
    const second = await startGitHubHost()
    const secondName = `127.0.0.1:${second.server.address().port}`
    await key('k', 'KeyK', 75, 4)
    await until('the command palette', `document.querySelector('[aria-label^="Search actions"]')`)
    for (const character of 'Settings') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    await until(
      'the settings command',
      `[...document.querySelectorAll('[aria-label="Command suggestions"] [role="option"]')].some((b) => b.textContent.includes('Settings'))`,
    )
    await page(
      `[...document.querySelectorAll('[aria-label="Command suggestions"] [role="option"]')].find((b) => b.textContent.includes('Settings')).click()`,
    )
    await until(
      'the settings dialog',
      `document.querySelector('nav[aria-label="Settings sections"]')`,
    )
    await page(
      `[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find((b) => b.textContent.trim() === 'GitHub').click()`,
    )
    await until('the host field', `document.querySelector('#settings-github-host')`)
    await page(
      `(() => { const field = document.querySelector('#settings-github-host'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(field, ${JSON.stringify(secondName)}); field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
    )
    await reveal(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Use this host')`,
      'the use this host control',
    )
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Use this host')`,
      'the use this host control',
    )
    await until(
      'the new host to be stored',
      `document.body.innerText.includes(${JSON.stringify(`GitHub host set to ${secondName}`)})`,
      900,
    )
    // The account this app signs in with is observed in the window itself, not
    // inferred from a file that happens to be absent: this run has no GitHub
    // account of its own and no remote to push anything to, and both are facts
    // about this window rather than about the module under test.
    assert.ok(
      await page(`document.body.innerText.includes('Not signed in')`),
      "this window's own account state reads as absent while it changes host",
    )
    assert.equal(
      git('remote').length,
      0,
      'the repository this run opened has no remote, so no push exists to be sent or observed',
    )
    await key('Escape', 'Escape', 27)
    await until(
      'the settings dialog to close',
      `!document.querySelector('nav[aria-label="Settings sections"]')`,
    )
    await until(
      'the inbox to belong to the host that was just selected',
      `document.body.innerText.includes('No credential stored') && !document.body.innerText.includes('Tidy the stack ordering rules')`,
      1200,
    )
    assert.equal(
      (await rowsOnScreen()).length,
      0,
      "the previous host's threads are gone from a window that is not pointed at that host",
    )
    // The credential is per host, so the new host has none until it is given
    // one, and asking for it is the whole of what this window can offer now.
    await press(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Authorize notifications')`,
      'the authorize control for the new host',
    )
    await until(
      'the consent dialog for the new host',
      `document.querySelector('[aria-label="GitHub Notifications credential"]')`,
    )
    const secondBoundary = await page(
      `(() => {
        const box = document.querySelector('[aria-label="GitHub Notifications credential"]')
        const terms = [...box.querySelectorAll('dt')].map((dt) => dt.textContent.trim())
        const values = [...box.querySelectorAll('dd')].map((dd) => dd.textContent.trim())
        return terms.indexOf('Host') === -1 ? null : values[terms.indexOf('Host')]
      })()`,
    )
    assert.equal(
      secondBoundary,
      secondName,
      'the consent names the host the window is now pointed at, not the one it came from',
    )
    await page(`(() => { const input = document.querySelector('[aria-label="GitHub Notifications credential"] input'); input.focus(); return true })()`)
    for (const character of TOKEN) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    await page(
      `(() => { const box = document.querySelector('[aria-label="GitHub Notifications credential"] [role="checkbox"]') || [...document.querySelectorAll('[aria-label="GitHub Notifications credential"] input')].find((i) => i.type === 'checkbox'); box.click(); return true })()`,
    )
    await press(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.includes('Authorize'))`,
      'the consent submit for the new host',
    )
    await until(
      "the new host's own threads",
      `document.body.innerText.includes('Tidy the stack ordering rules')`,
      1200,
    )
    const afterCutover = await rowsOnScreen()
    assert.equal(
      afterCutover.every((row) => row.title.includes('acme/widgets')),
      true,
      'the inbox now holds what the selected host serves',
    )
    assert.ok(
      second.asked.every((entry) => entry.authorization === `Bearer ${TOKEN}`),
      'and every read of it went to that host over this module’s own credential',
    )
    assert.equal(
      existsSync(join(userData, 'github-account.json')),
      false,
      "the application's own GitHub sign-in is still absent through the host change",
    )
    const afterCutoverShot = await screenshot('notifications-host-cutover')

    const afterRemoval = await page(`document.body.innerText`)
    assert.equal(
      afterRemoval.includes('Tidy the stack ordering rules'),
      true,
      'the list read with the credential the selected host was given is on screen',
    )
    // A write the selected host applies and then loses the answer to. The change
    // is real there, and nothing can tell this window whether it landed: what it
    // must not do is call it failed, or send it again, or mark the row either way
    // on a guess.
    second.loseNextWrite()
    const lostRowTitle = 'Mentioned in "Release checklist"'
    const lostLabel = `Mark ${lostRowTitle} as read`
    await reveal(control(lostRowTitle, lostLabel), `the ${lostLabel} control`)
    const beforeLost = second.asked.length
    await press(control(lostRowTitle, lostLabel), `the ${lostLabel} control`)
    await until(
      'the unknown outcome to be reported',
      `Boolean(document.querySelector('[role="alert"]'))`,
      600,
    )
    await delay(2_500)
    const lostRequests = second.asked.slice(beforeLost)
    assert.deepEqual(
      lostRequests.map((entry) => `${entry.method} ${entry.path}`),
      ['PATCH /api/v3/notifications/threads/102'],
      'a write whose answer was lost is sent once and never quietly sent again',
    )
    assert.equal(
      second.threads().find((thread) => thread.id === '102').unread,
      false,
      'the host really did apply it, which is exactly what the window cannot know',
    )
    const unknownOutcome = await page(`document.querySelector('[role="alert"]')?.innerText ?? ''`)
    assert.ok(
      !/did not reach|never reached|was not applied|failed/i.test(unknownOutcome),
      `an unknown outcome is not reported as a failure: ${unknownOutcome}`,
    )
    assert.ok(
      /unknown|whether|cannot tell|lost/i.test(unknownOutcome),
      `an unknown outcome says so plainly: ${unknownOutcome}`,
    )
    assert.equal(
      (await rowsOnScreen()).find((row) => row.title.includes('Release checklist'))?.state,
      'Unread',
      'and the row keeps the state it was last confirmed in rather than one this window guessed',
    )
    const unknownOutcomeShot = await screenshot('notifications-unknown-outcome')

    // The same user data a second time. Whatever the inbox shows after a restart
    // is what the producer restored from its own files for the host this window
    // is pointed at, including a subject this build cannot name: this run hands
    // the view nothing here, so a row that appears came from the producer.
    socket.close()
    app.kill()
    await delay(1_500)
    const restartPort = await availablePort()
    const restartedApp = spawn(
      electron,
      [join(__dirname, '..', 'out', 'main', 'index.js'), `--remote-debugging-port=${restartPort}`],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let restartText = ''
    restartedApp.stdout.on('data', (chunk) => {
      restartText += chunk
    })
    restartedApp.stderr.on('data', (chunk) => {
      restartText += chunk
    })
    let restartTarget = null
    for (let attempt = 0; attempt < 300 && !restartTarget; attempt += 1) {
      await delay(100)
      try {
        const targets = await (await fetch(`http://127.0.0.1:${restartPort}/json`)).json()
        restartTarget = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      } catch {
        /* the restarted window is not listening yet */
      }
    }
    assert.ok(restartTarget, `the restarted window was unavailable: ${restartText}`)
    const restartSocket = new WebSocket(restartTarget.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      restartSocket.addEventListener('open', resolve, { once: true })
      restartSocket.addEventListener('error', reject, { once: true })
    })
    let restartId = 0
    const restartPending = new Map()
    restartSocket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      const waiter = restartPending.get(message.id)
      if (!waiter) return
      restartPending.delete(message.id)
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
    })
    const restartPage = async (expression) => {
      const id = ++restartId
      const answered = new Promise((resolve, reject) => {
        restartPending.set(id, { resolve, reject })
      })
      restartSocket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      )
      const result = await answered
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result.value
    }
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await delay(100)
      if (
        await restartPage(
          `[...document.querySelectorAll('nav button')].some((b) => b.textContent.includes('Notifications'))`,
        )
      ) {
        break
      }
    }
    await restartPage(
      `[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('Notifications')).click()`,
    )
    const readsBeforeRestart = second.asked.length
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await delay(100)
      if (await restartPage(`document.body.innerText.includes(${JSON.stringify(unknownRowTitle)})`)) {
        break
      }
    }
    const restartedRows = await restartPage(
      `[...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].map((row) => row.innerText)`,
    )
    assert.ok(
      restartedRows.some((text) => text.includes(unknownRowTitle)),
      `the producer's own stored list still holds the subject this build cannot name after a restart: ${JSON.stringify(restartedRows)}`,
    )
    assert.ok(
      second.asked.length > readsBeforeRestart,
      'and the restarted window asked the selected host for its list rather than showing one it kept',
    )
    restartSocket.close()
    restartedApp.kill()

    console.log(
      JSON.stringify(
        {
          off: offScreenshot,
          setting: enabledScreenshot,
          standard,
          minimum,
          zoomedInbox,
          zoomedRead,
          zoomedOpen,
          zoomedDone,
          zoomedUnnamed,
          zoomedAction,
          zoomedKeyboard,
          zoomedConsent,
          zoomedCancel,
          unknownOutcome: unknownOutcomeShot,
          afterCutover: afterCutoverShot,
          hostRequests: host.asked.map((entry) => `${entry.method} ${entry.path}`),
          cutoverRequests: second.asked.map((entry) => `${entry.method} ${entry.path}`),
          secretInFiles: stored.includes(TOKEN),
          rendererErrors,
        },
        null,
        2,
      ),
    )
    second.server.close()
    second.server.closeAllConnections()
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
    if (main) {
      try {
        main.socket.close()
      } catch {
        /* the socket dies with the app process */
      }
    }
    app.kill()
    host.server.close()
    host.server.closeAllConnections()
    setTimeout(() => rmSync(root, { recursive: true, force: true }), 2000).unref()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
