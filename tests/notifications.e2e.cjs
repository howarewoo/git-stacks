/**
 * The optional Notification Center, driven through the real application.
 *
 * Electron runs the built main process, which answers on its own TLS socket as
 * a GitHub host, and the window reaches it only through the preload bridge: the
 * token is pasted into the dialog, crosses one IPC channel, and is sealed with
 * a synthetic fixture-owned authenticated-encryption key: no operating-system
 * credential store is read or written by this run. Nothing here mutates
 * anything on github.com — the host is this script's own server — and the
 * token never appears in a rendered surface, an accessibility read, or a
 * screenshot.
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
// The fixture root the isolated desktop fixture seals with: one per run, reused
// across the initial and restarted launches so the synthetic key persists and
// the sealed credential file survives the restart it then proves. Caller-owned,
// never the user's real store.
const fixtureRoot = join(root, 'isolated-desktop')
mkdirSync(fixtureRoot, { recursive: true })
// Nothing the caller exported may reach this run: an ambient signing key, a
// real hooks path, or a real GitHub login would all turn a disposable smoke into
// an operation on the machine it happens to run on. The filter and the macOS
// HOME rule are the packaged smoke's, because that is where they were proved
// against a real window: macOS hands a sandboxed app the home the password
// database reports, and its helpers never come up against a synthetic one.
const UNSAFE_INHERITED =
  /^(GIT_|GH_|GITHUB_|GIT_STACKS_)|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$|^NODE_TLS_REJECT_UNAUTHORIZED$|^SSH_AUTH_SOCK$|(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY)/iu
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
      // A reason this build has no name for, on the same record whose subject
      // type it also has no name for. Both halves have to survive the producer's
      // own storage; naming only the kind would leave the reason unobserved.
      reason: 'future_reason',
      subject: {
        title: 'Something this build has no name for',
        url: `${SELF}api/v3/repos/acme/widgets/check-suites/104`,
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
  // The interval this host declares in its own answers, which is the floor the
  // app keeps for a person's press as well as for its own poll.
  let pollInterval = 0
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
        const askedEntry = {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          ifModifiedSince: request.headers['if-modified-since'] ?? null,
          authorization: request.headers.authorization ?? null,
          validatorAtArrival: answered,
          at: Date.now(),
          // The status this host actually answered with, so a claim about what a
          // 304 preserved is a claim about a 304 and not about a fresh list.
          status: null,
        }
        asked.push(askedEntry)
        const answer = (status, body, headers) => {
          askedEntry.status = status
          if (headers?.['x-poll-interval']) pollInterval = Number(headers['x-poll-interval'])
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
        pollInterval: () => pollInterval,
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
 * The record this module wrote for one host, read back whole.
 *
 * The name carries the host in hex, so one host's list can never be read as
 * another's, and the body is the producer's own normalised schema rather than
 * anything this run hands the view: a thread or a validator found in here was
 * written by the producer, for this host, on its own.
 */
function cacheOf(host) {
  const scope = Buffer.from(host, 'utf8').toString('hex')
  return JSON.parse(
    readFileSync(join(userData, `github-notifications-cache.${scope}.json`), 'utf8'),
  )
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

/**
 * The Electron module, resolved from inside the main process this run talks to
 * over CDP. It is written once here because every main-process probe below
 * needs the same answer, and a resolver that differed between them would make
 * one probe prove something another could not.
 */
const RESOLVER = `  function resolveElectron() {
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
  }`

/** Reads or sets the real Electron zoom factor of the app window. */
const MAIN_ZOOM = `(async (factor) => {
${RESOLVER}
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
${RESOLVER}
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
  // The isolated fixture installs its synthetic sealing backend and proves no
  // native safeStorage path remains before it imports the production main, so
  // this run never touches the real operating-system key store.
  const app = spawn(
    electron,
    [
      join(__dirname, 'fixtures', 'isolated-desktop.cjs'),
      '--use-mock-keychain',
      '--password-store=basic',
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${port}`,
      '--inspect=0',
      '--fixture-root',
      fixtureRoot,
      '--main',
      join(__dirname, '..', 'out', 'main', 'index.js'),
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
  let second = null
  let restartedApp = null
  let restartSocket = null
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
    // Dialog teardown waits for a rendered frame. Keep this test-owned window
    // rendering even when another desktop window occludes the automated run.
    await main.evaluate(`(() => {
      ${RESOLVER}
      const window = resolveElectron().BrowserWindow.getAllWindows()[0]
      window.webContents.setBackgroundThrottling(false)
    })()`)
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
        throw new Error(
          `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}: ${JSON.stringify(expression)}`,
        )
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
    /**
     * Waits for the controlled host to record a read of the list that satisfies
     * `accept`, and fails the run when none arrives.
     *
     * Every read waited for below is one the host's own interval had already
     * permitted, so one that never lands is a failure of the run rather than a
     * reason to carry on past a wait that ran out.
     */
    const hostRead = async (served, from, description, accept, attempts = 600) => {
      const reads = () =>
        served.asked
          .slice(from)
          .filter(
            (entry) => entry.method === 'GET' && entry.path.startsWith('/api/v3/notifications'),
          )
      let found = null
      for (let attempt = 0; attempt < attempts && found === null; attempt += 1) {
        await delay(50)
        found = reads().find(accept) ?? null
      }
      assert.ok(
        found !== null,
        `no read of the list matching ${description} reached the host, which was asked: ${JSON.stringify(reads().map((entry) => ({ path: entry.path, validator: entry.ifModifiedSince, status: entry.status })))}`,
      )
      return found
    }
    /**
     * Waits for the producer to write back its own record for one host, and
     * fails the run when it does not.
     *
     * A read that reached the socket says nothing about whether the app has
     * finished acting on it: the answer is written to the socket before the app
     * has seen it. The list and its validator are republished together and land
     * in one file, so a record that moved is the producer saying it finished.
     */
    const republished = async (named, previous, description, attempts = 600) => {
      let record = null
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const cached = cacheOf(named)
          if (cached.fetchedAt !== previous.fetchedAt) {
            record = cached
            break
          }
        } catch {
          /* the write is a rename over the old file, so a miss is mid-write */
        }
        await delay(50)
      }
      assert.ok(
        record !== null,
        `the producer never republished its stored list ${description}; the file still holds ${JSON.stringify(previous)}`,
      )
      return record
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
      // Enter activates a focused button the way it activates one for a person,
      // which needs the character it carries and the auto-repeat flag the real
      // keyboard sends alongside it.
      await send('Input.dispatchKeyEvent', {
        ...options,
        type: keyName === ' ' ? 'keyDown' : 'rawKeyDown',
        ...(keyName === 'Enter'
          ? { text: '\r', unmodifiedText: '\r', isKeypad: false }
          : keyName === ' '
            ? { text: ' ', unmodifiedText: ' ' }
            : {}),
      })
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyUp' })
    }
    /**
     * Walks a dialog's own tab order onto one of its controls, checking the
     * focus at every step.
     *
     * The route is real key events from wherever the dialog put focus, and the
     * dialog's focus scope keeps them inside it, exactly as a person's are. A
     * control this run reached by calling `focus()` on itself would say nothing
     * about whether a person can reach it, so nothing here moves focus
     * directly: the run reads where focus actually lands, and fails when the
     * route it needs is not there.
     */
    const tabTo = async (test, description, steps = 12) => {
      for (let step = 0; step <= steps; step += 1) {
        if (await page(`Boolean(${test})`)) return
        await key('Tab', 'Tab', 9)
        await delay(100)
      }
      assert.fail(
        `the keyboard could not reach the ${description} from where the dialog put focus, which is on ${await page("document.activeElement?.outerHTML?.slice(0, 160) ?? 'nothing'")} after ${steps} presses of Tab`,
      )
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
     * What a press can land on that is not the control it was aimed at but is
     * still a control of its own, so that reaching one is never mistaken for
     * reaching the one this run meant to press.
     */
    const PRESS_INTERACTIVE =
      'a[href],button,input,select,textarea,summary,[role="button"],[role="checkbox"],[role="combobox"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="radio"],[role="searchbox"],[role="slider"],[role="spinbutton"],[role="switch"],[role="tab"],[role="textbox"],[role="treeitem"],[contenteditable="true"]'
    /**
     * A press at a real point on a real control, settled only by what the
     * window reports having received. The reach check is against the geometry
     * of the moment it was taken, and the window can re-lay-out between that
     * and the dispatch: the capability matrix that replaces the host field's
     * "not answered yet" line grows this vertically centred dialog and carries
     * its button up with it, so a press aimed a moment earlier lands beside the
     * control instead of on it.
     *
     * The watcher is on the document in the capture phase and settles what it
     * saw there and then, while the nodes are still the ones that were
     * clicked, because a handler may remove or reparent them before anything
     * gets to look. Only one answer is a press that happened: the control
     * itself receiving the click.
     *
     * A press another control received is never repeated, because that control
     * may already have acted. A press that reached neither the control nor any
     * other control is aimed again, up to a fixed number of times. Anything the
     * window cannot account for — the control leaving the screen without the
     * press reaching it, or the report never coming back — is an error and
     * never a press that worked.
     */
    const press = async (expression, description) => {
      // A press that reached nothing at all is aimed again a few times, which
      // is a person pressing again while the window is still settling and not a
      // way of waiting on a control that never stops moving.
      const attempts = 4
      for (let attempt = 1; ; attempt += 1) {
        // Sample geometry and hit-testing in one renderer task; a host probe
        // can otherwise move the dialog between two inspector round trips.
        const measurement = await page(`(() => {
          const el = ${expression}
          if (!el) return null
          const rect = el.getBoundingClientRect()
          const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          const x = box.x + box.width / 2
          const y = box.y + box.height / 2
          const hit = document.elementFromPoint(x, y)
          return {
            box, x, y,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            reaches: hit === el || (hit !== null && el.contains(hit))
              ? null
              : hit ? hit.tagName + '.' + hit.className + ' "' + (hit.innerText || '').slice(0, 40) + '"' : 'nothing at that point'
          }
        })()`)
        if (!measurement) {
          throw new Error(`no ${description} on screen: ${await page('document.body.innerText')}`)
        }
        const { box, viewport, x, y, reaches } = measurement
        assert.ok(
          box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= viewport.width + 1 &&
            box.y + box.height <= viewport.height + 1,
          `${description} is not inside the viewport a person presses in: ${JSON.stringify({ box, viewport })}`,
        )
        assert.equal(reaches, null, `${description} is covered by something else: ${reaches}`)
        const watched = await page(
          `(() => {
            const el = ${expression}
            if (!el) return false
            const watch = { el, delivered: false, foreign: null, onClick: null }
            watch.onClick = (event) => {
              const target = event.target
              if (!(target instanceof Element)) return
              if (target === el || el.contains(target)) { watch.delivered = true; return }
              if (watch.foreign !== null) return
              const control = target.closest('${PRESS_INTERACTIVE}')
              if (control !== null) {
                watch.foreign = control.tagName + ' "' + (control.innerText || control.getAttribute('aria-label') || '').trim().slice(0, 60) + '"'
              }
            }
            document.addEventListener('click', watch.onClick, true)
            window.__pressWatch = watch
            return true
          })()`,
        )
        assert.equal(
          watched,
          true,
          `the window would not report what the ${description} received, so no press of it can be proved`,
        )
        let landed = null
        try {
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
          landed = await page(
            `(() => {
              const watch = window.__pressWatch
              if (!watch) return { watched: false }
              // Detached before the handle is dropped, so that a detach that
              // throws still leaves the finally below something to clean up.
              document.removeEventListener('click', watch.onClick, true)
              delete window.__pressWatch
              return {
                watched: true,
                delivered: watch.delivered,
                foreign: watch.foreign,
                connected: watch.el.isConnected,
              }
            })()`,
          )
        } finally {
          // A dispatch that never came back leaves the watcher attached, and a
          // watcher left attached would report the next press's click as this
          // one's.
          await page(
            `(() => { const watch = window.__pressWatch; if (!watch) return true; document.removeEventListener('click', watch.onClick, true); delete window.__pressWatch; return true })()`,
          ).catch(() => {})
        }
        if (!landed?.watched) {
          throw new Error(
            `the window never reported what the press aimed at ${JSON.stringify({ x, y })} received, so the ${description} is unaccounted for rather than pressed`,
          )
        }
        if (landed.delivered) return
        if (landed.foreign !== null) {
          throw new Error(
            `the press aimed at ${JSON.stringify({ x, y })} for the ${description} reached ${landed.foreign}, a control of its own that may already have acted, so it is not pressed again`,
          )
        }
        if (!landed.connected) {
          throw new Error(
            `the ${description} left the screen without the press aimed at ${JSON.stringify({ x, y })} reaching it, so it is unaccounted for rather than pressed`,
          )
        }
        if (attempt >= attempts) {
          throw new Error(
            `the ${description} moved out from under ${attempt} presses aimed at it and none of them reached anything the window reports as a control`,
          )
        }
      }
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
      `(() => { const row = [...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(title)})); return row ? [...row.querySelectorAll('[aria-label]')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)}) ?? null : null })()`
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

    // The token is typed into the field the dialog itself focused, reached by
    // real Tab presses from wherever it put focus. Nothing here calls `focus()`
    // on the input: a field the run had to aim at itself would prove nothing
    // about the one a person meets when this dialog opens.
    await tabTo(
      `document.activeElement?.id === 'notification-token'`,
      'token field once the dialog has opened',
    )
    assert.equal(
      await page(`document.activeElement?.getAttribute('type') ?? null`),
      'password',
      'the field the cursor lands in is the masked one, reached without this run touching focus',
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
      (await rowsOnScreen())
        .find((row) => row.title.includes('Settle the review queue ordering'))
        ?.controls.find((entry) => entry.name === 'Mark Settle the review queue ordering as read')
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
    const readsBeforeConfirmation = host.asked.length
    const refreshControl = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh')`
    // The floor is the one this host declared, measured from its last read, and
    // the control is pressed once after it: this is a person asking again, not
    // the run retrying the API around the app's rule.
    const lastRead = host.asked
      .filter((entry) => entry.path.startsWith('/api/v3/notifications'))
      .at(-1)
    const floor = Math.max(0, (lastRead?.at ?? 0) + host.pollInterval() * 1000 - Date.now())
    if (floor > 0) await delay(floor)
    await reveal(refreshControl, 'the refresh control')
    await press(refreshControl, 'the refresh control')
    let confirmedRead = null
    for (let attempt = 0; attempt < 300 && confirmedRead === null; attempt += 1) {
      await delay(50)
      confirmedRead =
        host.asked
          .slice(readsBeforeConfirmation)
          .find(
            (entry) => entry.method === 'GET' && entry.path.startsWith('/api/v3/notifications'),
          ) ?? null
    }
    assert.ok(confirmedRead !== null, 'a read of the changed list really reached the host')
    assert.equal(
      confirmedRead.ifModifiedSince,
      confirmedRead.validatorAtArrival,
      'the validator sent back is the one this host last issued, unchanged',
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
    const unnamed = (await rowsOnScreen()).find((row) =>
      row.title.includes('Something this build has no name for'),
    )
    assert.ok(unnamed, 'a subject this build cannot name is still in the inbox')
    assert.deepEqual(
      unnamed.controls.map((entry) => entry.name).sort(),
      [
        'Ignore Something this build has no name for',
        'Mark Something this build has no name for as done',
        'Mark Something this build has no name for as read',
        'Open Something this build has no name for on GitHub',
        'Unsubscribe from Something this build has no name for',
      ],
      'every thread offers its own operations, and the browser link is disclosed rather than hidden',
    )
    assert.equal(
      unnamed.controls.find((entry) => entry.name.startsWith('Open ')).enabled,
      false,
      'the browser link is offered but disabled, because this host named no page for a subject this build cannot map',
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
      control(
        'Mentioned in "Release checklist"',
        'Unsubscribe from Mentioned in "Release checklist"',
      ),
      'the unsubscribe control',
    )
    await press(
      control(
        'Mentioned in "Release checklist"',
        'Unsubscribe from Mentioned in "Release checklist"',
      ),
      'the unsubscribe control',
    )
    await until(
      'the unsubscribed thread to leave the list',
      `!document.body.innerText.includes('Release checklist') && document.body.innerText.includes('Tidy the stack ordering rules')`,
      600,
    )
    assert.deepEqual(
      host.asked.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path),
      ['/api/v3/notifications/threads/103', '/api/v3/notifications/threads/102/subscription'],
      'Done and Unsubscribe are two different requests, and each took the thread it named with it',
    )

    // The conditional read that follows a list nothing changed keeps that list
    // whole rather than replacing it with whatever page answered, so the
    // acknowledged reads and the removals stay on screen.
    const readsBeforeReplay = host.asked.length
    const replayControl = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh')`
    // The same floor as before: this host's own declared interval, measured from
    // its last read, and one press after it. Nothing here reaches past the app.
    const replayLastRead = host.asked
      .filter((entry) => entry.path.startsWith('/api/v3/notifications'))
      .at(-1)
    const replayFloor = Math.max(
      0,
      (replayLastRead?.at ?? 0) + host.pollInterval() * 1000 - Date.now(),
    )
    if (replayFloor > 0) await delay(replayFloor)
    await reveal(replayControl, 'the refresh control')
    await press(replayControl, 'the refresh control')
    let replayedRead = null
    for (let attempt = 0; attempt < 300 && replayedRead === null; attempt += 1) {
      await delay(50)
      replayedRead =
        host.asked
          .slice(readsBeforeReplay)
          .find(
            (entry) => entry.method === 'GET' && entry.path.startsWith('/api/v3/notifications'),
          ) ?? null
    }
    assert.ok(replayedRead !== null, 'the replaying read really reached the host')
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
    const notificationOffset = await page(`
      [...document.querySelectorAll('nav[aria-label="Workspace destinations"] button')]
        .findIndex((button) => button.textContent?.includes('GitHub Notifications'))
    `)
    assert.ok(notificationOffset >= 0, 'the notification destination is listed in navigation')
    await page(`document.querySelector('nav[aria-label="Workspace destinations"] button').focus()`)
    for (let index = 0; index < notificationOffset; index += 1) {
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
    const remainingRows = (await rowsOnScreen()).filter(
      (row) =>
        row.title.includes('Tidy the stack ordering rules') ||
        row.title.includes('Something this build has no name for') ||
        row.title.includes('Settle the review queue ordering'),
    )
    assert.ok(
      remainingRows.length === 3,
      `the inbox still holds its threads: ${remainingRows.length}`,
    )
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
        const controlOnThisRow = `(() => { const row = [...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(title)})); return row ? [...row.querySelectorAll('[aria-label]')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(name)}) ?? null : null })()`
        await inView(controlOnThisRow, `the ${name} control at 200% zoom`)
      }
      zoomedInbox ??= await screenshot(`notifications-zoom-200-row`, { viewportOnly: true })
    }
    const firstRowTitle = rowTitles[0]
    const actedRow = (title) =>
      `[...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`
    // Every row here has already been confirmed read by this host, so its read
    // control is disabled rather than pretending to do work: what a person sees
    // at this zoom is a control with nothing left to do. The read that does
    // reach a host at this zoom is driven against the second host's own fresh
    // rows, further down, where there is genuinely something to read.
    const readRowTitle = 'Something this build has no name for'
    const readLabel = `Mark ${readRowTitle} as read`
    assert.equal(
      await page(
        `(() => { const row = [...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(readRowTitle)})); const b = row && [...row.querySelectorAll('[aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(readLabel)}); return b === null ? null : b.disabled })()`,
      ),
      true,
      'a row this host already confirmed read offers no read at 200% zoom, because there is nothing left to do',
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
    // The thread whose kind this build does not know keeps every operation at
    // this zoom, and its browser link is disclosed as unavailable rather than
    // removed: what a person sees is a control that says why it cannot open
    // this subject, and no address this app invented for it.
    const unnamedTitle = 'Something this build has no name for'
    assert.equal(
      await page(
        `(() => { const row = [...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(unnamedTitle)})); const link = row && [...row.querySelectorAll('[aria-label]')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(`Open ${unnamedTitle} on GitHub`)}); return link === null ? null : link.disabled })()`,
      ),
      true,
      'the row at 200% zoom still discloses its browser link, and it is disabled',
    )
    const opensBefore = host.asked.length
    await delay(1_000)
    assert.equal(
      host.asked.length,
      opensBefore,
      'and the row whose subject has no page sends nothing while it sits at this zoom',
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
    // Start from an established user-reachable focus point, dispatch real Tab / Shift+Tab
    // to these controls, assert focus and visibility at each step, and then activate with Space.
    const unsubscribeSelector = `[...document.querySelectorAll('[aria-label]')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(`Unsubscribe from ${firstRowTitle}`)})`
    await reveal(unsubscribeSelector, 'the unsubscribe button')
    // Pending actions can leave focus on body. Allow one full page tab cycle,
    // including keyboard-discoverable disabled-action wrappers.
    const tabCycleLength = await page(`[
      ...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')
    ].filter(el => !el.disabled && el.tabIndex >= 0 && !el.closest('[inert]') &&
      el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden').length + 1`)
    for (let attempt = 0; attempt < tabCycleLength; attempt += 1) {
      const active = await page(`document.activeElement?.getAttribute('aria-label')`)
      if (active === `Unsubscribe from ${firstRowTitle}`) break
      await key('Tab', 'Tab', 9)
      await delay(100)
    }
    const focusedLabel = await page(`document.activeElement?.getAttribute('aria-label')`)
    assert.equal(
      focusedLabel,
      `Unsubscribe from ${firstRowTitle}`,
      'the keyboard reached the unsubscribe control via Tab navigation',
    )
    const isUnsubscribeVisible = await page(`(() => {
      const el = ${unsubscribeSelector}
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight
    })()`)
    assert.ok(
      isUnsubscribeVisible,
      'the unsubscribe control is focused and visible in the 200% viewport',
    )
    await key(' ', 'Space', 32)
    await delay(1_000)
    await until(
      'the keyboard to unsubscribe the focused thread',
      `!document.body.innerText.includes(${JSON.stringify(firstRowTitle)})`,
      600,
    )
    assert.ok(
      host.asked.some((entry) => entry.method === 'DELETE' && entry.path.endsWith('/subscription')),
      'the keyboard reached the same subscription control a pointer reaches',
    )
    const zoomedKeyboard = await screenshot('notifications-zoom-200-keyboard', {
      viewportOnly: true,
    })

    // The consent step has to stay reachable at the same zoom: it is the one
    // place a person has to type, and typing has to work in the viewport this
    // zoom leaves rather than only in a wider window. Its field, its
    // acknowledgement, and its submit are scrolled to and used there, and the
    // three of them are reached the way a person reaches them: from the focus
    // the dialog put on opening, by Tab, with the key that acts on the focused
    // control. Nothing in this run moves the caret into the field itself, so a
    // field it had to aim at cannot be mistaken for one a person finds.
    // That is a claim about this window's own focus order and its own key
    // handling, and nothing more: it is not a claim about what the operating
    // system's own keyboard navigation or assistive technology does, which this
    // run does not drive and does not measure.
    // A control a person can actually press: while a write of theirs is still
    // being applied the same control is disabled, and pressing a disabled
    // button is not an action.
    const usableButton = (text) =>
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`
    // A person presses, sees nothing happen while the app finishes what it was
    // doing, and presses again: the press is retried a bounded number of times
    // and the result is read off the window, never off the request.
    const removedExpression = `document.body.innerText.includes('no credential') && document.body.innerText.includes('Authorize notifications')`
    for (let attempt = 0; attempt < 8 && !(await page(removedExpression)); attempt += 1) {
      await reveal(usableButton('Remove credential'), 'the remove credential control')
      await press(usableButton('Remove credential'), 'the remove credential control')
      await delay(1_500)
    }
    await until('the module to be back to needing a credential', removedExpression, 600)
    await reveal(usableButton('Authorize notifications'), 'the authorize control')
    await press(usableButton('Authorize notifications'), 'the authorize control')
    await until(
      'the credential dialog at 200% zoom',
      `document.querySelector('[aria-label="GitHub Notifications credential"]')`,
    )
    const dialog = (part) =>
      `document.querySelector('[aria-label="GitHub Notifications credential"] ${part}')`
    await inView(
      `document.querySelector('[aria-label="GitHub Notifications credential"]')`,
      'the consent dialog',
    )
    await reveal(dialog('input:not([type="checkbox"])'), 'the token field at 200% zoom')
    await inView(dialog('input:not([type="checkbox"])'), 'the token field at 200% zoom')
    // The token goes into the field the dialog itself focused, walked to with
    // real Tab presses rather than aimed at by this run: at this zoom the field
    // is below the fold and a person scrolls to it and types, and the only
    // honest version of that is the dialog's own focus order.
    await tabTo(`document.activeElement?.id === 'notification-token'`, 'token field at 200% zoom')
    for (const character of TOKEN) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    // Cancel has to be reachable from inside the dialog with the keyboard too:
    // from the token field that was just typed into, Tab through the dialog's
    // own order to Cancel, check the focus there, and activate with Space.
    const cancelSelector = `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.trim() === 'Cancel')`
    await reveal(cancelSelector, 'the consent cancel button')
    await tabTo(
      `document.activeElement?.textContent?.trim() === 'Cancel'`,
      'consent cancel at 200% zoom',
    )
    assert.equal(
      await page(`document.activeElement?.textContent?.trim()`),
      'Cancel',
      'the keyboard reached Cancel through the tab order the dialog itself has',
    )
    await inView(cancelSelector, 'the consent cancel')
    // Space, because Enter is this app's own command key and never reaches the
    // focused control: the keyboard proof has to use the key that does.
    await key(' ', 'Space', 32)
    await until(
      'the dialog to close on cancel',
      `!document.querySelector('[aria-label="GitHub Notifications credential"]')`,
      600,
    )
    const zoomedCancel = await screenshot('notifications-zoom-200-consent-cancel', {
      viewportOnly: true,
    })
    const asksBeforeReopen = host.asked.length
    await press(usableButton('Authorize notifications'), 'the authorize control')
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
    // The whole consent, at this zoom, without a pointer: the token into the
    // field the dialog focused, Tab to the acknowledgement, Space to give it,
    // Tab to the submit, Space to send. Each step checks the focus it claims to
    // have reached before the key that acts on it, so a route that silently
    // stopped working fails here rather than three steps later.
    await reveal(dialog('input:not([type="checkbox"])'), 'the token field at 200% zoom')
    await inView(dialog('input:not([type="checkbox"])'), 'the token field at 200% zoom')
    await tabTo(
      `document.activeElement?.id === 'notification-token'`,
      'token field on the reopened dialog at 200% zoom',
    )
    for (const character of TOKEN) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    await reveal(dialog('[role="checkbox"]'), 'the consent control at 200% zoom')
    await tabTo(
      `document.activeElement?.getAttribute('role') === 'checkbox'`,
      'the consent control at 200% zoom',
    )
    await inView(dialog('[role="checkbox"]'), 'the consent control')
    await key(' ', 'Space', 32)
    await until(
      'the acknowledgement to be given from the keyboard at 200% zoom',
      `${dialog('[role="checkbox"]')}?.getAttribute('aria-checked') === 'true'`,
      600,
    )
    const zoomedConsent = await screenshot('notifications-zoom-200-consent', { viewportOnly: true })
    const authorizeSelector = `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.trim() === 'Authorize notifications')`
    await reveal(authorizeSelector, 'the consent submit at 200% zoom')
    await tabTo(
      `document.activeElement?.textContent?.trim() === 'Authorize notifications'`,
      'the consent submit at 200% zoom',
    )
    await inView(authorizeSelector, 'the consent submit')
    assert.equal(
      await page(`${authorizeSelector}?.disabled ?? null`),
      false,
      'the submit is offered once the token is typed and the boundary acknowledged, reached by keyboard',
    )
    await key(' ', 'Space', 32)
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
    // What the producer itself wrote, read back out of the file it wrote for
    // this host. This is the normalized record, so a value this build does not
    // recognise has to be stored as the name this build uses for that, not as
    // the wire value it could not decode — otherwise the row is only understood
    // until something reads it back.
    const storedCache = cacheOf(hostName)
    const storedUnnamed = storedCache.threads.find((thread) => thread.id === '104')
    assert.ok(
      storedUnnamed,
      `the producer stored the record it could not name: ${JSON.stringify(storedCache.threads)}`,
    )
    assert.equal(
      storedUnnamed.reason,
      'unknown',
      `a reason this build does not recognise is stored as the name this build uses for it: ${JSON.stringify(storedUnnamed)}`,
    )
    assert.equal(
      storedUnnamed.kind,
      'unknown',
      `a subject type this build does not recognise is stored the same way: ${JSON.stringify(storedUnnamed)}`,
    )
    assert.ok(
      storedUnnamed.title === unknownRowTitle && storedUnnamed.url === null,
      `the record kept what it does know and offers no page it cannot name: ${JSON.stringify(storedUnnamed)}`,
    )
    // The in-place host change a person makes in Settings, with this app's own
    // account still absent and no push anything: the inbox this window is
    // showing belongs to one host, and changing the host in place has to
    // replace it rather than leave the previous host's private threads in a
    // window that is now pointed somewhere else.
    second = await startGitHubHost()
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
    // The status this window is reading for, read from the app's own bridge:
    // what GitHub CLI session is in effect, and not an inference from a file that
    // happens to be absent. This run has no CLI signed in and no remote to push
    // anything to, and both are facts about this window rather than about the
    // module under test.
    const cliStatus = await page(
      `(async () => { const bridge = Object.values(window).find((value) => value && typeof value.githubCliStatus === 'function'); return bridge ? await bridge.githubCliStatus() : null })()`,
    )
    // The status has to have been read before it can say anything: a bridge this
    // build does not expose would otherwise read the same as a CLI that is
    // absent, and "nothing answered" is not the claim being made here.
    assert.ok(
      cliStatus !== null && typeof cliStatus === 'object',
      `the app's own CLI status was read through its bridge: ${JSON.stringify(cliStatus)}`,
    )
    assert.equal(
      cliStatus.host,
      secondName,
      `the CLI status answered for the host the window is now pointed at: ${JSON.stringify(cliStatus)}`,
    )
    assert.equal(
      cliStatus.state,
      'signed-out',
      `this window's isolated CLI configuration has no authenticated account: ${JSON.stringify(cliStatus)}`,
    )
    assert.equal(cliStatus.identity, null, 'the CLI has no credential identity in this fixture')
    assert.equal(cliStatus.login, null, 'the CLI has no authenticated login in this fixture')
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
    await press(usableButton('Authorize notifications'), 'the authorize control for the new host')
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
    // The token for the new host goes into the field this dialog focused, the
    // same route as the one already walked above: no aiming, just Tab from
    // wherever the dialog opened its focus.
    await tabTo(
      `document.activeElement?.id === 'notification-token'`,
      'token field for the new host',
    )
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
    assert.equal(
      await page(
        `[...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].length > 0 && [...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].every((row) => row.innerText.includes('acme/widgets'))`,
      ),
      true,
      "the inbox now holds what the selected host serves, and every row names that host's repository",
    )
    assert.ok(
      second.asked.every((entry) => entry.authorization === `Bearer ${TOKEN}`),
      'and every read of it went to that host over this module’s own credential',
    )
    assert.equal(
      existsSync(join(userData, 'github-account.json')),
      false,
      'the app-owned primary record of an earlier build is still absent through the host change',
    )
    // A real read at the zoom on a row this second host still has unread, with
    // the host's own answer, so the 200% camera covers a real write too.
    const freshReadTitle = 'Tidy the stack ordering rules'
    const freshReadLabel = `Mark ${freshReadTitle} as read`
    // At the same 200% the camera above was taken at, on this host's own rows.
    await zoom(2, Math.round(baselineWidth / 2))
    await reveal(control(freshReadTitle, freshReadLabel), `the ${freshReadLabel} control`)
    await press(control(freshReadTitle, freshReadLabel), `the ${freshReadLabel} control`)
    await until(
      'the freshly read row to be read',
      `[...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(freshReadTitle)}))?.innerText.includes('Read') && ![...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(freshReadTitle)}))?.innerText.includes('Unread')`,
      600,
    )
    assert.ok(
      second.asked.some(
        (entry) => entry.method === 'PATCH' && entry.path === '/api/v3/notifications/threads/101',
      ),
      'reading a row at 200% zoom reaches the selected host as the thread it names',
    )
    const zoomedFreshRead = await screenshot('notifications-zoom-200-fresh-read', {
      viewportOnly: true,
    })
    await zoom(originalZoom, baselineWidth)
    await resize(1024, 768)
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
    //
    // What this host has been asked, and the validator it is holding, are read
    // here rather than at the gate below: this write is what makes its list
    // different from the one the window is showing, so anything the module sends
    // after this point is the reconciliation of it, whether it sends it on this
    // run's timing or on its own.
    const readsBeforeReconcile = second.asked.length
    const validatorBeforeReconcile = second.validator()
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
    const unknownOutcome = await page(
      `[...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent.trim()).join(' ')`,
    )
    assert.ok(
      !/fetch failed|Error invoking remote|did not reach|never reached|was not applied|failed/i.test(
        unknownOutcome,
      ),
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
    // Before the first process is killed, that host's changed list is reconciled
    // for real. It applied the write above and then lost the answer to it, so
    // what this window is showing is a read state GitHub had already moved and
    // this window could not learn. Reconciling it is also what leaves the stored
    // record holding the validator this host's current list actually has, so the
    // read after the restart is a conditional one about the same list rather
    // than a download of it.
    //
    // The floor below is the interval this host declared, measured from its own
    // last read, and the read is waited for rather than demanded of a button.
    // Once that floor has passed the module reconciles on its own timer, so
    // pressing Refresh again would be a person asking for something the floor
    // may well refuse; the run does not need it to and does not claim that it
    // did it. The count of what this host has been asked, and the validator it
    // was holding, were taken before the write above rather than here, because a
    // read the app sends by itself is exactly the one a baseline measured from
    // too late would miss.
    const cacheBeforeReconcile = cacheOf(secondName)
    const preRestartLastRead = second.asked
      .filter((entry) => entry.path.startsWith('/api/v3/notifications'))
      .at(-1)
    const preRestartFloor = Math.max(
      0,
      (preRestartLastRead?.at ?? 0) + second.pollInterval() * 1000 - Date.now(),
    )
    if (preRestartFloor > 0) await delay(preRestartFloor)
    const reconciledRead = await hostRead(
      second,
      readsBeforeReconcile,
      'this host had changed after it lost the answer to a write it had applied',
      (entry) => entry.status !== null,
    )
    assert.equal(
      reconciledRead.status,
      200,
      `the changed list was read in full, not left to a 304 that says nothing about the write whose answer was lost: ${JSON.stringify(reconciledRead)}`,
    )
    assert.equal(
      reconciledRead.ifModifiedSince,
      reconciledRead.validatorAtArrival,
      'and the read went back with the validator this host last issued, unchanged',
    )
    assert.notEqual(
      second.validator(),
      validatorBeforeReconcile,
      'this host had moved its list on, so what answered this window was its changed list and not the one it already sent',
    )
    // That the answer reached the socket is not the app having acted on it, and
    // the app is the only thing that can move what it stored: the list and the
    // validator are published together and written back to one file.
    const reconciledCache = await republished(
      secondName,
      cacheBeforeReconcile,
      'after reading the list this host had changed',
    )
    assert.equal(
      reconciledCache.lastModified,
      second.validator(),
      `the stored record carries the validator this host answered that read with: ${JSON.stringify(reconciledCache)}`,
    )
    assert.deepEqual(
      reconciledCache.threads.map((thread) => [thread.id, thread.title, thread.unread]),
      second.threads().map((thread) => [thread.id, thread.subject.title, thread.unread]),
      'and the stored list is the list this host now holds, thread for thread',
    )
    // And the window is showing it. The row whose read this host applied and
    // lost the answer to is read on screen now because a list GitHub confirmed
    // said so, not because this window guessed either way about a write.
    await until(
      'the window to show what this host confirmed about the write it lost the answer to',
      `[...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].some((row) => row.innerText.includes(${JSON.stringify(lostRowTitle)}) && row.innerText.includes('Read') && !row.innerText.includes('Unread'))`,
      1200,
    )
    socket.close()
    app.kill()
    await delay(1_500)
    const restartPort = await availablePort()
    restartedApp = spawn(
      electron,
      [
        join(__dirname, 'fixtures', 'isolated-desktop.cjs'),
        '--use-mock-keychain',
        '--password-store=basic',
        `--user-data-dir=${userData}`,
        `--remote-debugging-port=${restartPort}`,
        '--fixture-root',
        fixtureRoot,
        '--main',
        join(__dirname, '..', 'out', 'main', 'index.js'),
      ],
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
    restartSocket = new WebSocket(restartTarget.webSocketDebuggerUrl)
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
      message.error
        ? waiter.reject(new Error(message.error.message))
        : waiter.resolve(message.result)
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
    /** Waits for the restarted window, and fails the run rather than falling through. */
    const restartUntil = async (description, expression, attempts = 600) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await restartPage(`Boolean(${expression})`)) return
        await delay(50)
      }
      throw new Error(
        `timed out waiting for ${description}; the window reads: ${await restartPage('document.body.innerText')}`,
      )
    }
    await restartUntil(
      'the restarted window to come up',
      `[...document.querySelectorAll('nav button')].some((b) => b.textContent.includes('Notifications'))`,
    )
    await restartPage(
      `[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('Notifications')).click()`,
    )
    await restartUntil(
      "the producer's restored list to reach the window",
      `document.body.innerText.includes(${JSON.stringify(unknownRowTitle)})`,
    )
    const restartedRows = await restartPage(
      `[...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].map((row) => row.innerText)`,
    )
    assert.ok(
      restartedRows.some((text) => text.includes(unknownRowTitle)),
      `the producer's own stored list still holds the subject this build cannot name after a restart: ${JSON.stringify(restartedRows)}`,
    )
    // The interval GitHub named does not reset because this app restarted, so
    // the restored list is what the window honestly has to show first. Asking
    // again once that floor has passed is what reaches the host, and what comes
    // back is the host's own answer.
    const cacheBeforeRefresh = cacheOf(secondName)
    const validatorBeforeRefresh = second.validator()
    const readsBeforeRestart = second.asked.length
    const restartLastRead = second.asked
      .filter((entry) => entry.path.startsWith('/api/v3/notifications'))
      .at(-1)
    const restartFloor = Math.max(
      0,
      (restartLastRead?.at ?? 0) + second.pollInterval() * 1000 - Date.now(),
    )
    if (restartFloor > 0) await delay(restartFloor)
    await restartPage(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh' && !b.disabled)?.click()`,
    )
    const restartRead = await hostRead(
      second,
      readsBeforeRestart,
      "this host's list, asked for again after the restart",
      (entry) => entry.status !== null,
    )
    assert.ok(
      second.asked
        .slice(readsBeforeRestart)
        .every((entry) => entry.authorization === `Bearer ${TOKEN}`),
      "and it read with this module's own credential, on the host the settings name",
    )
    // The record the restarted window could not have learned from a fresh list:
    // the read above was answered conditionally, so what still holds the record
    // afterwards is the producer's own stored list replaying through a 304.
    assert.equal(
      restartRead.status,
      304,
      `the restarted window's read was answered conditionally, so a retained record is retained through a 304: ${JSON.stringify(restartRead)}`,
    )
    assert.equal(
      restartRead.ifModifiedSince,
      validatorBeforeRefresh,
      'and the validator it sent back is the one this host last issued for this list, unchanged',
    )
    // A 304 on the socket says only that this host had nothing new to send.
    // Whether the window has finished acting on it is a different fact, owned by
    // the app, and it is waited for rather than inferred: the confirmed list and
    // the validator it belongs to are republished and written back together,
    // and only then is the window rendered from that. Every claim below is
    // about what this host holds after all of that, not about what it held when
    // the answer went out.
    const afterConditionalCache = await republished(
      secondName,
      cacheBeforeRefresh,
      'after the restarted window was answered conditionally',
    )
    assert.equal(
      afterConditionalCache.lastModified,
      second.validator(),
      `the stored record still carries the validator this host answered the conditional read with: ${JSON.stringify(afterConditionalCache)}`,
    )
    assert.deepEqual(
      afterConditionalCache.threads.map((thread) => [thread.id, thread.title, thread.unread]),
      second.threads().map((thread) => [thread.id, thread.subject.title, thread.unread]),
      'and the stored list is still the list this host holds, after a 304 that carried no body at all',
    )
    const afterConditional = afterConditionalCache.threads.find((thread) => thread.id === '104')
    assert.ok(
      afterConditional &&
        afterConditional.reason === 'unknown' &&
        afterConditional.kind === 'unknown',
      `a record this build cannot name keeps its normalized reason and kind through a restart and a 304: ${JSON.stringify(afterConditional)}`,
    )
    // The window is settled on that answer when its own Refresh control is
    // offered again, which is what an idle module looks like.
    await restartUntil(
      'the restarted window to finish the refresh it was sent',
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Refresh' && !b.disabled)`,
    )
    // And the row a person is looking at, on this host, after all of that.
    const settledUnknownRow = await restartPage(
      `(() => {
        const row = [...document.querySelectorAll('[role="list"][aria-label="GitHub notification threads"] [role="listitem"]')].find((r) => r.innerText.includes(${JSON.stringify(unknownRowTitle)}))
        if (!row) return null
        const open = [...row.querySelectorAll('[aria-label]')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(`Open ${unknownRowTitle} on GitHub`)})
        return {
          subject: row.querySelector('small')?.textContent.trim() ?? '',
          state: [...row.querySelectorAll('span')].map((s) => s.textContent.trim()).find((t) => t === 'Read' || t === 'Unread') ?? null,
          open: open ? open.disabled : null,
        }
      })()`,
    )
    assert.ok(
      settledUnknownRow,
      `the window is still showing the subject this build cannot name once that refresh settled: ${JSON.stringify(restartedRows)}`,
    )
    assert.ok(
      settledUnknownRow.subject.includes('Item') && settledUnknownRow.subject.includes('Other'),
      `the row is labelled as the kind and the reason this build has no other name for, not as something it invented: ${JSON.stringify(settledUnknownRow)}`,
    )
    assert.equal(
      settledUnknownRow.open,
      true,
      'and its browser link is disclosed and disabled, because this host named no page for a subject this build cannot resolve',
    )
    assert.equal(
      settledUnknownRow.state,
      second.threads().find((thread) => thread.id === '104').unread ? 'Unread' : 'Read',
      `and the row is in the state this host confirmed, rather than one this window guessed: ${JSON.stringify(settledUnknownRow)}`,
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
          zoomedFreshRead,
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
  } finally {
    if (restartSocket && restartSocket.readyState !== WebSocket.CLOSED) {
      try {
        restartSocket.close()
      } catch {}
    }
    if (restartedApp) {
      try {
        restartedApp.kill()
      } catch {}
    }
    if (second && second.server) {
      try {
        second.server.close()
        second.server.closeAllConnections()
      } catch {}
    }
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
