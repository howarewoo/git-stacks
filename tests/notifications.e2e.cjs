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
  ]
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
        })
        const answer = (status, body, headers) => {
          response.writeHead(status, { 'content-type': 'application/json', ...headers })
          response.end(body === null ? '' : JSON.stringify(body))
        }
        // A host that answers anything with 205 would let a wrong verb, a wrong
        // path, and a right one all pass this run. Each request is answered the
        // way GitHub documents it, and anything else is a failure the run
        // reports rather than absorbs.
        if (url.pathname === '/api/v3/user') return answer(200, { login: 'octo' })
        if (request.method === 'DELETE' && url.pathname.endsWith('/subscription')) {
          threads = threads.filter(
            (thread) => url.pathname.indexOf(`/threads/${thread.id}/`) === -1,
          )
          return answer(204, null, {})
        }
        // Mark all read is PUT /notifications; marking one thread read is
        // PATCH /notifications/threads/{thread_id}. Both end at 205.
        const singleThread = /^\/api\/v3\/notifications\/threads\/([^/]+)$/.exec(url.pathname)
        if (request.method === 'PUT' && url.pathname === '/api/v3/notifications') {
          threads = threads.map((thread) => ({ ...thread, unread: false }))
          return answer(205, null, {})
        }
        if (request.method === 'PATCH' && singleThread) {
          threads = threads.map((thread) =>
            thread.id === singleThread[1] ? { ...thread, unread: false } : thread,
          )
          return answer(205, null, {})
        }
        if (request.method !== 'GET') return answer(405, { message: 'Method Not Allowed' })
        if (url.pathname.startsWith('/api/v3/notifications')) {
          // A conditional read is answered the way GitHub answers one: nothing
          // changed, so there is no body to send and only the validator.
          if (request.headers['if-modified-since'] === LAST_MODIFIED) {
            return answer(304, null, { 'x-poll-interval': '60' })
          }
          return answer(200, threads, {
            'last-modified': LAST_MODIFIED,
            'x-poll-interval': '60',
          })
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
      resolve({ server, asked, threads: () => threads })
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
    /** Every box a person has to reach, in CSS pixels, at the current zoom. */
    const unclipped = async (selector) => {
      const boxes = await page(
        `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => {
          const box = el.getBoundingClientRect()
          return { text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 40), left: box.left, right: box.right, width: window.innerWidth }
        })`,
      )
      for (const box of boxes) {
        assert.ok(
          box.left >= -1 && box.right <= box.width + 1,
          `"${box.text}" runs outside the viewport at this zoom: ${JSON.stringify(box)}`,
        )
      }
      return boxes.length
    }
    const key = async (keyName, code, virtual, modifiers = 0) => {
      const options = { key: keyName, code, windowsVirtualKeyCode: virtual, modifiers }
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyDown' })
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyUp' })
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
    // The host this run is pinned to is the only origin allowed, and the
    // subject has to arrive there as the pull request a person can read.
    assert.deepEqual(
      await main.evaluate(`(${MAIN_EXTERNAL})('install')`),
      { installed: true },
      'the run could not intercept the links this app opens',
    )
    await page(
      `(() => {
        const row = [...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes('Tidy the stack ordering rules'))
        if (!row) throw new Error('no row names this thread: ' + document.body.innerText)
        const open = [...row.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Open '))
        if (!open) throw new Error('this row offers no Open control: ' + row.innerText)
        open.click()
        return true
      })()`,
    )
    let opened = []
    for (let attempt = 0; attempt < 100 && opened.length === 0; attempt += 1) {
      await delay(100)
      opened = await main.evaluate(`(${MAIN_EXTERNAL})('calls')`)
    }
    assert.deepEqual(
      opened,
      [`https://${hostName}/acme/widgets/pull/101`],
      'the subject API URL was resolved to a page on the host this module is pinned to',
    )
    await main.evaluate(`(${MAIN_EXTERNAL})('restore')`)

    // Marking one thread read writes to this host once and updates the row.
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Mark read').click()`,
    )
    await until(
      'the first thread to be marked read',
      `document.querySelector('[role="listitem"]')?.innerText.includes('Read')`,
      600,
    )
    const writes = host.asked.filter((entry) => entry.method === 'PATCH')
    assert.equal(writes.length, 1, `marking read is sent once: ${JSON.stringify(writes)}`)
    assert.equal(writes[0].path, '/api/v3/notifications/threads/101')

    /** What the window says each row is: the badge, not the button's wording. */
    const rowsOnScreen = async () =>
      page(
        `[...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].map((row) => ({
          title: row.querySelector('strong')?.textContent.trim() ?? '',
          state: row.querySelector('[class*="badge"]')?.textContent.trim()
            ?? [...row.querySelectorAll('span')].map((s) => s.textContent.trim()).find((t) => t === 'Read' || t === 'Unread')
            ?? null,
        }))`,
      )

    // Mark all read is the bulk operation, which GitHub documents as
    // PUT /notifications, and it is judged by the inbox it leaves behind rather
    // than by the request alone.
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Mark all read').click()`,
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
      'marking the whole inbox read is the documented bulk request',
    )
    await until(
      'every thread to be marked read',
      `[...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].length > 0 && [...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].every((row) => row.innerText.includes('Read') && !row.innerText.includes('Unread'))`,
      600,
    )
    const afterBulk = await rowsOnScreen()
    assert.equal(
      afterBulk.every((row) => row.state === 'Read'),
      true,
      `the inbox on screen agrees with the host's state after the bulk write: ${JSON.stringify(afterBulk)}`,
    )
    assert.equal(
      host.threads().every((thread) => thread.unread === false),
      true,
      'the host really did mark every thread read',
    )

    // The interval GitHub asked for is a floor a person cannot outrun either:
    // asking again straight away sends nothing and changes nothing.
    const readsBefore = host.asked.length
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh').click()`,
    )
    await delay(1_000)
    assert.equal(
      host.asked.length,
      readsBefore,
      'a read asked for inside the interval GitHub named is not sent at all',
    )
    assert.equal(
      (await rowsOnScreen()).every((row) => row.state === 'Read'),
      true,
      'and the list GitHub last confirmed is still the one on screen, reads and all',
    )

    // Once the interval has passed, the read is conditional, and a host that
    // says nothing changed keeps the whole list rather than replacing it with
    // the page that answered.
    await delay(62_000)
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh').click()`,
    )
    for (let attempt = 0; attempt < 200 && host.asked.length === readsBefore; attempt += 1) {
      await delay(50)
    }
    const conditional = host.asked.at(-1)
    assert.equal(
      conditional.ifModifiedSince,
      LAST_MODIFIED,
      'the validator sent back is the one GitHub issued, unchanged',
    )
    assert.equal(
      host.asked.length,
      readsBefore + 1,
      'a 304 ends the read rather than asking for another page',
    )
    assert.equal(
      (await page(`document.body.innerText`)).includes('Tidy the stack ordering rules'),
      true,
      'the list is replayed whole, not replaced by whatever page answered',
    )
    // A conditional read replays what the module last saw, and what it last saw
    // is after the writes this run performed. Replaying a pre-write list would
    // put acknowledged reads back in front of the person who acknowledged them.
    assert.equal(
      (await rowsOnScreen()).every((row) => row.state === 'Read'),
      true,
      'the acknowledged read marks survive the conditional read: ' +
        JSON.stringify(await rowsOnScreen()),
    )
    assert.equal(
      host.threads().every((thread) => thread.unread === false),
      true,
      'and the host agrees the inbox is read',
    )

    // Unsubscribing is per thread, so the named row's own control is the one
    // used: the row that leaves the list is the row that was acted on, and the
    // host is the one that decides it left.
    await page(
      `(() => {
        const row = [...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes('Release checklist'))
        if (!row) throw new Error('no row names this thread: ' + document.body.innerText)
        const button = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Unsubscribe')
        if (!button) throw new Error('this row offers no unsubscribe: ' + row.innerText)
        button.click()
        return true
      })()`,
    )
    await until(
      'the unsubscribed thread to leave the list',
      `!document.body.innerText.includes('Release checklist') && document.body.innerText.includes('Tidy the stack ordering rules')`,
      600,
    )
    assert.deepEqual(
      host.asked.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path),
      ['/api/v3/notifications/threads/102/subscription'],
      'exactly the subscription the row names was removed, and only that one',
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
    // what is checked here is the halved CSS viewport and what still fits in it.
    const baselineWidth = await page('window.innerWidth')
    const originalZoom = await zoom(2, Math.round(baselineWidth / 2))
    assert.equal(
      await page(`document.documentElement.scrollWidth > window.innerWidth`),
      false,
      'the view reflows at 200% zoom rather than forcing a horizontal scrollbar',
    )
    const rowsAtZoom = await unclipped(
      '[role="list"][aria-label="GitHub notification threads"] [role="listitem"]',
    )
    assert.ok(rowsAtZoom > 0, `the inbox is on screen at 200% zoom: ${rowsAtZoom} rows`)
    const controlsAtZoom = await unclipped('.list-toolbar button, .capability-row button')
    assert.ok(
      controlsAtZoom >= 4,
      `the inbox's own controls survive 200% zoom: ${controlsAtZoom} buttons`,
    )
    const zoomedInbox = await screenshot('notifications-zoom-200', { viewportOnly: true })

    // The consent step has to stay reachable and unclipped at the same zoom:
    // it is the one control that cannot be reached by resizing the window.
    await page(
      `(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove credential')
        if (button) button.click()
        return true
      })()`,
    )
    await until(
      'the module to be back to needing a credential',
      `document.body.innerText.includes('No credential stored')`,
      600,
    )
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Authorize notifications').click()`,
    )
    await until(
      'the credential dialog at 200% zoom',
      `document.querySelector('[aria-label="GitHub Notifications credential"]')`,
    )
    const dialogAtZoom = await unclipped('[aria-label="GitHub Notifications credential"] *')
    assert.ok(dialogAtZoom > 0, 'the consent dialog is laid out at 200% zoom')
    await unclipped('[aria-label="GitHub Notifications credential"] button')
    const zoomedConsent = await screenshot('notifications-zoom-200-consent', { viewportOnly: true })
    await page(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.trim() === 'Cancel').click()`,
    )
    await until(
      'the credential dialog to close',
      `!document.querySelector('[aria-label="GitHub Notifications credential"]')`,
    )
    await zoom(originalZoom, baselineWidth)
    await resize(1024, 768)

    const afterRemoval = await page(`document.body.innerText`)
    assert.equal(
      afterRemoval.includes('Tidy the stack ordering rules'),
      false,
      'the list read with that credential is gone',
    )
    assert.equal(
      existsSync(join(userData, 'github-account.json')),
      false,
      "the application's own GitHub sign-in was never involved and is still absent",
    )

    console.log(
      JSON.stringify(
        {
          off: offScreenshot,
          setting: enabledScreenshot,
          standard,
          minimum,
          zoomedInbox,
          zoomedConsent,
          hostRequests: host.asked.map((entry) => `${entry.method} ${entry.path}`),
          secretInFiles: stored.includes(TOKEN),
          rendererErrors,
        },
        null,
        2,
      ),
    )
    socket.close()
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
