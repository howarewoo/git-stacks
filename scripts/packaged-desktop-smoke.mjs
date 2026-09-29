#!/usr/bin/env node
/**
 * Packaged Git Stacks desktop smoke.
 *
 * Launches the real electron-builder output against a disposable environment (temporary HOME,
 * temporary Chromium user data, temporary Git repository with a local bare "remote") and drives
 * the shipped renderer UI: packaging, window chrome, real 200% zoom, sandbox/preload wiring,
 * external-link guarding, and representative Git operations (fetch, branch creation,
 * stage/commit, stash/pop, merge-conflict resolution, merge abort). Every Git assertion is
 * checked against the real `git` binary on the disposable repository, never the app snapshot.
 *
 * No production code changes and no production file edits: the only injection is a runtime patch
 * of `shell.openExternal` inside the already-running main process, and the single call that
 * could reach it is only issued after the patch is proven in place.
 *
 *   node scripts/packaged-desktop-smoke.mjs [--app <path>] [--timeout <seconds>] [--keep]
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { chromium, expect } from '@playwright/test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = 'packaged-smoke-fixture'
const FEATURE = 'packaged-smoke/feature'
const CONFLICT = 'conflict.txt'
const ORIGIN = 'app://git-stacks'
const UI_TIMEOUT = 20_000
const API = [
  'cancel',
  'cancelGitHubSignIn',
  'commitDiff',
  'conflictView',
  'dismissPendingMutation',
  'fileView',
  'gitRuntimeStatus',
  'githubAccountStatus',
  'history',
  'mergeStatus',
  'onBackgroundIssues',
  'onBackgroundSnapshot',
  'onGitHubAccount',
  'onMergeProgress',
  'onRemoteStatus',
  'onSubmitStackProgress',
  'openExternal',
  'openRepository',
  'previewIssueLink',
  'pullRequest',
  'pullRequestChecks',
  'pullRequestIssueLinks',
  'pushPreview',
  'recentRepositories',
  'reconciliationPreview',
  'refresh',
  'remoteStatus',
  'reportActivity',
  'rerunPullRequestCheck',
  'reviewClearHistory',
  'reviewCommits',
  'reviewDrafts',
  'reviewFiles',
  'reviewHeadline',
  'reviewHistory',
  'reviewHistoryDiff',
  'reviewReply',
  'reviewResolveDrafts',
  'reviewSetDrafts',
  'reviewSetResolved',
  'reviewSetViewed',
  'reviewSubmit',
  'reviewThreads',
  'reviewViewed',
  'runAction',
  'searchIssues',
  'setSystemGit',
  'signOutOfGitHub',
  'stackPreview',
  'startGitHubSignIn',
  'submitStackProgress',
  'surgeryPreview',
]
const results = []
const limits = []
const log = (line) => process.stdout.write(`${line}\n`)
const text = (value) => (value ?? '').replace(/\s+/g, ' ').trim()
const note = (message) => {
  limits.push(message)
  log(`  note  ${message}`)
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const assertEqual = (actual, expected, message) => {
  if (actual !== expected)
    throw new Error(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    )
}

async function check(step, body) {
  try {
    const detail = (await body()) ?? ''
    results.push({ step, ok: true, detail })
    log(`  ok    ${step}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ step, ok: false, detail })
    log(`  FAIL  ${step} — ${detail}`)
    error.step = step
    throw error
  }
}

function parseArgs(argv) {
  const usage =
    'Usage: node scripts/packaged-desktop-smoke.mjs [--app <path>] [--timeout <seconds>] [--keep]'
  const options = { app: null, timeout: 420, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${arg} needs a value\n${usage}`)
      index += 1
      return next
    }
    if (arg === '--app') options.app = value()
    else if (arg.startsWith('--app=')) options.app = arg.slice(6)
    else if (arg === '--timeout') options.timeout = Number(value())
    else if (arg.startsWith('--timeout=')) options.timeout = Number(arg.slice(10))
    else if (arg === '--keep') options.keep = true
    else if (arg === '--help' || arg === '-h') {
      log(usage)
      process.exit(0)
    } else throw new Error(`Unknown argument: ${arg}\n${usage}`)
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 30) {
    throw new Error('--timeout must be a number of seconds of at least 30')
  }
  return options
}

function resolveTarget(explicit) {
  const candidates = explicit
    ? [resolve(ROOT, explicit)]
    : (
        {
          darwin: ['release/mac-arm64/Git Stacks.app', 'release/mac/Git Stacks.app'],
        }[process.platform] ?? ['release/linux-unpacked/git-stacks']
      ).map((candidate) => join(ROOT, candidate))
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      `No packaged application found. Looked for:\n  ${candidates.join('\n  ')}\n` +
        'Build one with "npm run package", or pass --app <path to the packaged app>.',
    )
  }
  if (!found.endsWith('.app')) return { bundle: null, executable: found }
  const binaries = readdirSync(join(found, 'Contents', 'MacOS')).filter((n) => !n.startsWith('.'))
  assertEqual(binaries.length, 1, `Expected one executable in ${found}/Contents/MacOS`)
  return { bundle: found, executable: join(found, 'Contents', 'MacOS', binaries[0]) }
}

/** The shipped payload, whether electron-builder packed it into app.asar or left it unpacked. */
function payload(target) {
  const resources = target.bundle
    ? join(target.bundle, 'Contents', 'Resources')
    : join(dirname(target.executable), 'resources')
  const asar = join(resources, 'app.asar')
  if (existsSync(asar)) {
    return {
      packed: basename(asar),
      paths: listPackage(asar).map((entry) => entry.replace(/^\//, '')),
      read: (entry) => extractFile(asar, entry),
    }
  }
  const unpacked = join(resources, 'app')
  if (!existsSync(unpacked))
    throw new Error(`No app.asar or unpacked app directory in ${resources}`)
  return {
    packed: 'the unpacked app directory',
    paths: readdirSync(unpacked, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => relative(unpacked, join(entry.parentPath, entry.name)).split(sep).join('/')),
    read: (entry) => readFileSync(join(unpacked, entry)),
  }
}

async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-packaged-smoke-'))
  const workspace = {
    root,
    home: join(root, 'home'),
    userData: join(root, 'user-data'),
    temp: join(root, 'tmp'),
    repo: join(root, FIXTURE),
    origin: join(root, 'origin.git'),
    gitconfig: join(root, 'gitconfig'),
    evidence: join(ROOT, 'out', 'packaged-smoke', new Date().toISOString().replace(/[:.]/g, '-')),
  }
  for (const directory of [
    workspace.home,
    workspace.userData,
    workspace.temp,
    workspace.evidence,
  ]) {
    await mkdir(directory, { recursive: true })
  }
  // An empty global config replaces whatever the host user has, so no git identity, credential
  // helper, or include directive from the machine can reach the fixture.
  await writeFile(workspace.gitconfig, '')
  return workspace
}

// Nothing the host shell exports may reach the app: git and gh state, GitHub credentials, any
// secret-shaped variable, the Node and Electron launch switches, and the SSH agent are dropped,
// and only fixture values are added back.
const UNSAFE_INHERITED =
  /^(GIT_|GH_|GITHUB_|GIT_STACKS_)|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^SSH_AUTH_SOCK$|(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY)/iu

function environment(workspace) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !UNSAFE_INHERITED.test(key)),
  )
  return {
    ...inherited,
    HOME: workspace.home,
    TMPDIR: workspace.temp,
    TEMP: workspace.temp,
    TMP: workspace.temp,
    XDG_CONFIG_HOME: join(workspace.home, '.config'),
    APPDATA: join(workspace.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(workspace.home, 'AppData', 'Local'),
    // gh reads its own configuration directory: pointing it at the disposable home means the
    // smoke can never reuse a real GitHub login, so no GitHub call can succeed or write.
    GH_CONFIG_DIR: join(workspace.home, '.config', 'gh'),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: workspace.gitconfig,
    ELECTRON_ENABLE_LOGGING: '1',
  }
}

const gitEnv = (workspace) => ({
  ...environment(workspace),
  GIT_AUTHOR_NAME: 'Packaged Smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'Packaged Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
})

function git(workspace, args, { cwd = workspace.repo, allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, env: gitEnv(workspace), encoding: 'utf8' })
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').trim()}`,
    )
  }
  return (result.stdout ?? '').trim()
}

const head = (workspace) => git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])
const porcelain = (workspace) => git(workspace, ['status', '--porcelain'])
const mergeInProgress = (workspace) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
    cwd: workspace.repo,
    env: gitEnv(workspace),
  }).status === 0

async function seedFixture(workspace) {
  const write = async (repo, relative, contents) => {
    await mkdir(dirname(join(repo, relative)), { recursive: true })
    await writeFile(join(repo, relative), contents)
  }
  let tick = 0
  const commitIn = (repo, message) => {
    tick += 60
    const stamp = new Date(Date.UTC(2024, 0, 1, 0, 0, tick)).toISOString()
    git(workspace, ['add', '-A'], { cwd: repo, env: undefined })
    spawnSync('git', ['commit', '--quiet', '-m', message], {
      cwd: repo,
      env: { ...gitEnv(workspace), GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    })
  }
  const identify = (repo) => {
    git(workspace, ['config', 'user.name', 'Packaged Smoke'], { cwd: repo })
    git(workspace, ['config', 'user.email', 'smoke@example.invalid'], { cwd: repo })
    git(workspace, ['config', 'commit.gpgsign', 'false'], { cwd: repo })
  }

  await mkdir(workspace.repo, { recursive: true })
  git(workspace, ['init', '--quiet', '--initial-branch=main', workspace.repo])
  identify(workspace.repo)
  await write(workspace.repo, 'README.md', '# Packaged smoke fixture\n\nseed\n')
  await write(workspace.repo, CONFLICT, 'base\n')
  commitIn(workspace.repo, 'Seed commit')

  // A local bare repository is the "remote": real fetch/push plumbing, no network, no GitHub.
  git(workspace, ['init', '--quiet', '--bare', '--initial-branch=main', workspace.origin])
  git(workspace, ['remote', 'add', 'origin', workspace.origin])
  git(workspace, ['push', '--quiet', '--set-upstream', 'origin', 'main'])
  await write(workspace.repo, 'README.md', '# Packaged smoke fixture\n\nsecond\n')
  commitIn(workspace.repo, 'Second commit')
  git(workspace, ['push', '--quiet', 'origin', 'main'])

  // A commit that exists only on the remote gives the in-app Fetch something real to transfer.
  const publisher = join(workspace.root, 'publisher')
  git(workspace, ['clone', '--quiet', workspace.origin, publisher])
  identify(publisher)
  await write(publisher, 'README.md', '# Packaged smoke fixture\n\nsecond\npublished\n')
  commitIn(publisher, 'Published commit')
  git(workspace, ['push', '--quiet', 'origin', 'main'], { cwd: publisher })
  workspace.publishedTip = git(workspace, ['rev-parse', 'HEAD'], { cwd: publisher })

  // repositories.json lives in app.getPath('userData'), so the onboarding list can offer the
  // fixture without a native file dialog. Seed every location macOS could resolve it from.
  const recents = `${JSON.stringify([{ path: workspace.repo, name: FIXTURE }])}\n`
  for (const target of [
    join(workspace.userData, 'repositories.json'),
    join(workspace.home, 'Library', 'Application Support', 'Git Stacks', 'repositories.json'),
  ]) {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, recents, { mode: 0o600 })
  }
  return workspace
}

/**
 * Minimal CDP client. The packaged main bundle is ESM, so `require` is out of scope there and
 * dynamic import() is unavailable inside an inspector evaluation; Node's builtin `module` plus
 * createRequire reaches Electron's registered `electron` module.
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
        await client.send('Runtime.evaluate', { expression: '1', returnByValue: true })
        return client
      } catch {
        await new Promise((wait) => setTimeout(wait, 200))
      }
    }
    throw new Error(`${endpoint} never answered a CDP command`)
  }

  send(method, params = {}) {
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
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluates a self-contained async arrow function source and returns its value by value. */
  async call(source, ...args) {
    const expression = `(${source})(${args.map((arg) => JSON.stringify(arg ?? null)).join(',')})`
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
      throw new Error(text(String(description).split('\n')[0]))
    }
    return response.result.value
  }

  close() {
    try {
      this.socket.close()
    } catch {
      // The socket dies with the app process.
    }
  }
}

const RESOLVER = `function resolveElectron() {
  if (typeof require === 'function') { try { return require('electron') } catch {} }
  if (process.mainModule && typeof process.mainModule.require === 'function') {
    try { return process.mainModule.require('electron') } catch {}
  }
  const getBuiltin = process.getBuiltinModule
  if (typeof getBuiltin === 'function') {
    const registered = getBuiltin('electron')
    if (registered) return registered
    const Module = getBuiltin('module')
    if (Module) return Module.createRequire(process.argv[1] || process.execPath)('electron')
  }
  throw new Error('Could not resolve the electron module from the packaged main process')
}`
const mainScript = (parameters, body) => `(async (${parameters}) => {${RESOLVER}\n${body}\n})`

const MAIN_PROBE = mainScript(
  '',
  `const { app } = resolveElectron()
return {
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  execPath: process.execPath,
  processType: process.type,
  userData: app.getPath('userData'),
  home: app.getPath('home'),
  temp: app.getPath('temp'),
  env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR },
  // Names only, never values: evidence that no inherited credential or git state reached the app.
  gitEnvKeys: Object.keys(process.env).filter((key) => /^(GIT_|GH_|GITHUB_)/iu.test(key)).sort(),
  secretKeys: Object.keys(process.env)
    .filter((key) => /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|APIKEY|API_KEY)/iu.test(key))
    .sort(),
  versions: { electron: process.versions.electron, node: process.versions.node },
}`,
)

const MAIN_WINDOW = mainScript(
  '',
  `const { BrowserWindow } = resolveElectron()
const window = BrowserWindow.getAllWindows()[0]
if (!window) return null
const size = window.getMinimumSize()
const preferences = window.webContents.getLastWebPreferences() ?? {}
return {
  title: window.getTitle(),
  bounds: window.getBounds(),
  // Electron reports the minimum size as [width, height] in current versions.
  minSize: { width: size[0] ?? size.width, height: size[1] ?? size.height },
  backgroundColor: window.getBackgroundColor(),
  contentBounds: window.getContentBounds(),
  visible: window.isVisible(),
  minimized: window.isMinimized(),
  url: window.webContents.getURL(),
  preferences: {
    sandbox: preferences.sandbox ?? null,
    contextIsolation: preferences.contextIsolation ?? null,
    nodeIntegration: preferences.nodeIntegration ?? null,
    nodeIntegrationInWorker: preferences.nodeIntegrationInWorker ?? null,
    nodeIntegrationInSubFrames: preferences.nodeIntegrationInSubFrames ?? null,
    webSecurity: preferences.webSecurity ?? null,
    webviewTag: preferences.webviewTag ?? null,
  },
}`,
)

/** Reads or sets the real Electron zoom factor of the app window; `null` only reads it. */
const MAIN_ZOOM = mainScript(
  'factor',
  `const { BrowserWindow } = resolveElectron()
const window = BrowserWindow.getAllWindows()[0]
if (!window) throw new Error('The packaged app has no window to zoom')
const previous = window.webContents.getZoomFactor()
if (factor !== null) window.webContents.setZoomFactor(factor)
return previous`,
)

/** Applies one window action (or reads the state) on the smoke-owned BrowserWindow. */
const MAIN_WINDOW_STATE = mainScript(
  'action',
  `const { BrowserWindow } = resolveElectron()
const window = BrowserWindow.getAllWindows()[0]
if (!window) throw new Error('The packaged app has no window')
if (action === 'minimize') window.minimize()
else if (action === 'restore') window.restore()
else if (action === 'maximize') window.maximize()
else if (action === 'unmaximize') window.unmaximize()
else if (action !== 'read') throw new Error('Unknown window action ' + action)
return {
  minimized: window.isMinimized(),
  maximized: window.isMaximized(),
  fullScreen: window.isFullScreen(),
  visible: window.isVisible(),
  bounds: window.getBounds(),
}`,
)

/** install | calls | restore for the shell.openExternal interceptor. */
const MAIN_EXTERNAL = mainScript(
  'action',
  `const { shell } = resolveElectron()
const active = globalThis.__packagedSmokeExternalLinks
if (action === 'calls') return (active?.calls ?? []).slice()
if (action === 'restore') {
  delete globalThis.__packagedSmokeExternalLinks
  if (typeof active?.original === 'function') shell.openExternal = active.original
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
patched.packagedSmokeInterceptor = true
shell.openExternal = patched
globalThis.__packagedSmokeExternalLinks = store
return {
  installed: shell.openExternal === patched && shell.openExternal.packagedSmokeInterceptor === true,
}`,
)

function launch(target, workspace) {
  const logStream = createWriteStream(join(workspace.evidence, 'packaged-app.log'))
  const child = spawn(
    target.executable,
    ['--inspect=0', '--remote-debugging-port=0', `--user-data-dir=${workspace.userData}`],
    {
      env: environment(workspace),
      cwd: workspace.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  const endpoints = {}
  let output = ''
  const harvest = (chunk) => {
    logStream.write(chunk)
    output = (output + chunk.toString()).slice(-200_000)
    for (const [key, pattern] of [
      ['inspector', /Debugger listening on (ws:\/\/\S+)/],
      ['devtools', /DevTools listening on (ws:\/\/\S+)/],
    ]) {
      endpoints[key] ??= output.match(pattern)?.[1]
    }
  }
  child.stdout.on('data', harvest)
  child.stderr.on('data', harvest)
  return {
    child,
    logStream,
    endpoints,
    transcript: () => output.slice(-2000),
    exited: () => child.exitCode !== null || child.signalCode !== null,
  }
}

async function endpoint(app, key, deadline, description) {
  while (!app.endpoints[key]) {
    if (Date.now() > deadline || app.exited()) {
      throw new Error(
        `The packaged app never reported ${description}. Launch output:\n${app.transcript()}`,
      )
    }
    await new Promise((wait) => setTimeout(wait, 150))
  }
  return app.endpoints[key]
}

async function stop(app) {
  if (!app?.child.pid) return
  const signal = (name) => {
    try {
      process.kill(-app.child.pid, name)
    } catch {
      try {
        app.child.kill(name)
      } catch {
        // Already gone.
      }
    }
  }
  const running = () => {
    if (process.platform === 'win32') return !app.exited()
    try {
      process.kill(-app.child.pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      // EPERM still means the group exists; keep waiting rather than declaring it gone.
      if (error.code === 'EPERM') return true
      throw error
    }
  }
  const waitForExit = async () => {
    const deadline = Date.now() + 5000
    while (running() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
  }
  signal('SIGTERM')
  await waitForExit()
  if (running()) {
    signal('SIGKILL')
    await waitForExit()
  }
  assert(!running(), `The smoke-owned process group ${app.child.pid} did not terminate`)
}

async function connectRenderer(devtools) {
  const browser = await chromium.connectOverCDP(
    devtools.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, ''),
  )
  const deadline = Date.now() + UI_TIMEOUT
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('app://')) {
          page.setDefaultTimeout(UI_TIMEOUT)
          return page
        }
      }
    }
    await new Promise((wait) => setTimeout(wait, 250))
  }
  throw new Error('The packaged window never exposed an app:// page over the DevTools endpoint')
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ui(page) {
  const button = (name) => page.getByRole('button', { name, exact: true })
  return {
    page,
    button,
    nav: (label) =>
      page
        .getByRole('navigation', { name: 'Workspace destinations' })
        .getByRole('button', { name: new RegExp(`^${label}(?: \\d+)?$`) }),
    success: () => page.locator('.global-banner[aria-live="polite"]'),
    operation: () => page.locator('section[aria-label="Git operation status"]'),
    branch: (name, current = false) =>
      page
        .getByRole('tree', { name: 'Repository branches' })
        .getByRole('treeitem', {
          name: new RegExp(`^${escapeForRegExp(name)}${current ? ', current branch' : ''}(,|$)`),
        })
        .first(),
    dialog: () => page.getByRole('dialog'),
    staged: () => page.locator('section[aria-labelledby="staged-heading"]'),
    unstaged: () => page.locator('section[aria-labelledby="unstaged-heading"]'),
  }
}

async function withNotice(locators, action, matcher) {
  for (const label of ['Dismiss notice', 'Dismiss action error', 'Dismiss error']) {
    const dismiss = locators.page.getByRole('button', { name: label, exact: true })
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {})
  }
  await action()
  const banner = locators.success()
  await banner.waitFor()
  const reported = text(await banner.innerText())
  assert(reported.length > 0, 'The success banner was empty')
  assert(matcher.test(reported), `The app reported "${reported}"`)
  await expect(locators.button('Refresh repository')).toBeEnabled({ timeout: UI_TIMEOUT })
  return reported
}

/** The app only sees outside-the-app changes after the repository is refreshed. */
async function refreshSnapshot(locators) {
  const refresh = locators.button('Refresh repository')
  await refresh.click()
  await expect(refresh).toBeEnabled({ timeout: UI_TIMEOUT })
}

async function gotoView(locators, label) {
  const target = locators.nav(label)
  await target.waitFor()
  if ((await target.getAttribute('aria-current')) !== 'page') await target.click()
}

async function selectBranch(locators, name) {
  await locators.branch(name).click()
  const heading = locators.page.locator('#branch-inspector .details-header h2')
  await heading.waitFor()
  assertEqual(
    text(await heading.innerText()),
    name,
    'The details pane did not follow the selection',
  )
}

async function switchToBranch(workspace, locators, name) {
  await gotoView(locators, 'Branches')
  await selectBranch(locators, name)
  const button = locators.button('Switch to this branch')
  await button.waitFor()
  assert(!(await button.isDisabled()), `"Switch to this branch" stayed disabled for ${name}`)
  await withNotice(locators, () => button.click(), /^Switched to /)
  assertEqual(head(workspace), name, 'git HEAD after switching branches')
}

/** Stages and commits through the shipped form. */
async function commitThroughUi(workspace, locators, message) {
  await refreshSnapshot(locators)
  await gotoView(locators, 'Working changes')
  const stageAll = locators.button('Stage all')
  await stageAll.waitFor()
  assert(!(await stageAll.isDisabled()), '"Stage all" stayed disabled with unstaged changes')
  await withNotice(locators, () => stageAll.click(), /^Staged \d+ path/)
  const field = locators.page.getByRole('textbox', { name: 'Commit message' })
  await field.waitFor()
  await field.fill(message)
  const commit = locators.button('Commit')
  assert(!(await commit.isDisabled()), '"Commit" stayed disabled with staged changes and a message')
  await withNotice(locators, () => commit.click(), /^Committed staged changes/)
  assertEqual(git(workspace, ['log', '-1', '--pretty=%s']), message, 'The new commit subject')
  assertEqual(porcelain(workspace), '', 'The working tree after committing')
}

async function mergeThroughUi(locators, branch) {
  await locators.button('More Git actions').click()
  await locators.page.getByRole('menuitem', { name: /Merge into current branch/ }).click()
  const dialog = locators.dialog()
  await dialog.waitFor()
  await dialog.getByRole('combobox', { name: 'Branch to merge', exact: true }).selectOption(branch)
  const submit = dialog.getByRole('button', { name: 'Merge into current branch', exact: true })
  await submit.waitFor()
  assert(!(await submit.isDisabled()), 'The merge dialog stayed disabled after choosing a branch')
  await submit.click()
}

const commitFromGit = (workspace, message) => {
  git(workspace, ['add', '-A'])
  git(workspace, ['commit', '--quiet', '-m', message])
}

const viewport = (page) =>
  page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scale: window.visualViewport ? Number(window.visualViewport.scale.toFixed(3)) : null,
    devicePixelRatio: window.devicePixelRatio,
    shell: Math.round(document.querySelector('.app-shell')?.getBoundingClientRect().width ?? 0),
  }))

async function waitForViewport(page, expectedWidth, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let latest = await viewport(page)
  while (Date.now() < deadline) {
    if (Math.abs(latest.innerWidth - expectedWidth) <= 2) return latest
    await new Promise((wait) => setTimeout(wait, 200))
    latest = await viewport(page)
  }
  throw new Error(
    `The renderer never reached a ${expectedWidth}px CSS viewport (last ${latest.innerWidth}px)`,
  )
}

async function run(options) {
  if (process.platform === 'win32') {
    throw new Error(
      'Packaged desktop smoke supports macOS and Linux only; Windows process-tree cleanup is not implemented.',
    )
  }
  const target = resolveTarget(options.app)
  const shipped = payload(target)
  const workspace = await createWorkspace()
  log(`packaged executable : ${target.executable}`)
  log(`packaged payload    : ${shipped.packed} (${shipped.paths.length} files)`)
  log(`disposable root     : ${workspace.root}`)
  log(`evidence            : ${workspace.evidence}`)

  const deadline = Date.now() + options.timeout * 1000
  let app = null
  let inspector = null
  let page = null
  const report = async (failure) => {
    await writeFile(
      join(workspace.evidence, 'report.json'),
      `${JSON.stringify(
        { executable: target.executable, workspace: workspace.root, failure, results, limits },
        null,
        2,
      )}\n`,
    ).catch(() => {})
  }
  let cleanupPromise
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      inspector?.close()
      await stop(app)
      app?.logStream.end()
      if (options.keep) log(`Disposable workspace kept at ${workspace.root}`)
      else await rm(workspace.root, { recursive: true, force: true })
    })()
    return cleanupPromise
  }
  const timer = setTimeout(async () => {
    const message = 'The smoke exceeded its --timeout budget.'
    log(`\n${message}`)
    try {
      await report(message)
      await cleanup()
    } catch (error) {
      log(`Timeout cleanup failed: ${error.message ?? error}`)
    } finally {
      process.exit(1)
    }
  }, options.timeout * 1000)
  timer.unref()

  try {
    await seedFixture(workspace)
    const canonicalRepo = realpathSync(workspace.repo)
    app = launch(target, workspace)
    inspector = await Cdp.open(
      await endpoint(app, 'inspector', deadline, 'a main-process inspector endpoint'),
      Math.max(1000, Math.min(30_000, deadline - Date.now())),
    )
    page = await connectRenderer(
      await endpoint(app, 'devtools', deadline, 'a renderer DevTools endpoint'),
    )
    page.on('pageerror', (error) => log(`  [renderer:error] ${error.message}`))
    const locators = ui(page)
    const probe = await inspector.call(MAIN_PROBE)
    assertEqual(
      probe.processType,
      'browser',
      'The inspected process is not an Electron main process',
    )

    await check('the packaged build runs from its own bundle', async () => {
      assert(probe.isPackaged === true, 'app.isPackaged was false for the electron-builder output')
      const bundle = realpathSync(target.bundle ?? dirname(target.executable))
      assert(
        probe.appPath === bundle || probe.appPath.startsWith(bundle),
        `app.getAppPath() is ${probe.appPath}, outside ${bundle}`,
      )
      assert(
        [realpathSync(target.executable), target.executable].includes(probe.execPath),
        `The running executable is ${probe.execPath}, not ${target.executable}`,
      )
      return `app.getAppPath()=${probe.appPath}, electron ${probe.versions.electron}, node ${probe.versions.node}`
    })

    await check('user data and child-process paths are disposable', async () => {
      const within = (actual, expected, label) => {
        const resolved = realpathSync(actual.replace(/\/$/, ''))
        assert(
          resolved === expected || resolved.startsWith(`${expected}${sep}`),
          `${label} is ${resolved}, outside ${expected}`,
        )
      }
      within(probe.userData, realpathSync(workspace.userData), 'app.getPath("userData")')
      assertEqual(probe.env.HOME, workspace.home, 'The app inherited a HOME outside the workspace')
      assertEqual(
        probe.env.TMPDIR,
        workspace.temp,
        'The app inherited a TMPDIR outside the workspace',
      )
      assertEqual(
        probe.env.GH_CONFIG_DIR,
        join(workspace.home, '.config', 'gh'),
        'gh was not pointed at a disposable configuration directory',
      )
      assertEqual(
        probe.secretKeys.join(','),
        '',
        `Credential-shaped variables reached the app: ${probe.secretKeys.join(', ')}`,
      )
      const unexpected = probe.gitEnvKeys.filter(
        (key) =>
          !/^(GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GH_CONFIG_DIR|GH_PROMPT_DISABLED)$/u.test(
            key,
          ),
      )
      assertEqual(
        unexpected.join(','),
        '',
        `Unexpected git or gh variables reached the app: ${unexpected.join(', ')}`,
      )
      note(
        `Inherited GIT_*/GH_*/GITHUB_* state, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, and SSH_AUTH_SOCK are dropped; git reads only the empty ${workspace.gitconfig} (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL set).`,
      )
      // macOS resolves the home and temp directories from the system rather than the environment,
      // and the app reads neither: userData is its only app-level path, while git and gh inherit
      // the disposable HOME, TMPDIR, and GH_CONFIG_DIR.
      note(
        `macOS kept app.getPath("home")=${probe.home} and app.getPath("temp")=${probe.temp}; the app reads neither.`,
      )
      assert(
        existsSync(join(probe.userData, 'repositories.json')),
        'The app did not read the seeded recents file',
      )
      return `userData=${probe.userData}, HOME=${probe.env.HOME}`
    })

    await check('only the disposable repository is offered', async () => {
      const recents = await page.evaluate(() => window.desktop.recentRepositories())
      assertEqual(recents.length, 1, 'The recent repository list was not limited to the fixture')
      assertEqual(recents[0].path, workspace.repo, 'The recent repository path')
      return `${recents[0].name} -> ${recents[0].path}`
    })

    await check('renderer assets ship inside the bundle', async () => {
      for (const entry of [
        'out/renderer/index.html',
        'out/main/index.js',
        'out/preload/index.cjs',
        'package.json',
      ]) {
        assert(shipped.paths.includes(entry), `${entry} is missing from ${shipped.packed}`)
        assert(shipped.read(entry).length > 0, `${entry} is empty in ${shipped.packed}`)
      }
      const assets = await page.evaluate(async () => {
        const urls = [
          ...[...document.querySelectorAll('script[src]')].map((node) => node.src),
          ...[...document.querySelectorAll('link[rel="stylesheet"]')].map((node) => node.href),
        ]
        const fetched = []
        for (const url of urls) {
          const response = await fetch(url)
          fetched.push({ url, status: response.status, length: (await response.text()).length })
        }
        return {
          href: location.href,
          fetched,
          resources: performance.getEntriesByType('resource').map((entry) => entry.name),
          csp: (await fetch(location.href)).headers.get('content-security-policy') ?? '',
        }
      })
      assert(
        assets.href.startsWith(`${ORIGIN}/`),
        `The document is ${assets.href}, not an app:// URL`,
      )
      assert(
        assets.fetched.length > 0,
        'The packaged renderer document referenced no scripts or styles',
      )
      for (const asset of assets.fetched) {
        assert(asset.url.startsWith(`${ORIGIN}/`), `${asset.url} is not served by the app protocol`)
        assertEqual(asset.status, 200, `Fetching ${asset.url}`)
        assert(asset.length > 0, `${asset.url} served an empty body`)
      }
      const remote = assets.resources.filter((name) => /^https?:\/\//.test(name))
      assertEqual(remote.length, 0, `The renderer loaded remote resources: ${remote.join(', ')}`)
      assert(assets.csp.includes("default-src 'self'"), `No default-src CSP (${assets.csp})`)
      assert(assets.csp.includes("frame-src 'none'"), 'The CSP does not block frames')
      return `${assets.fetched.length} renderer assets served over ${ORIGIN} with a self-only CSP`
    })

    await check('the package carries no test or specimen payload', async () => {
      // electron-builder ships the production dependency tree, so only the app's own payload is
      // held to out/{main,preload,renderer} + package.json; the vendored tree is checked for
      // test and build tooling instead.
      const vendored = shipped.paths.filter(
        (entry) => entry === 'node_modules' || entry.startsWith('node_modules/'),
      )
      const own = shipped.paths.filter(
        (entry) => entry !== 'node_modules' && !entry.startsWith('node_modules/'),
      )
      const tooling = [
        'playwright',
        'playwright-core',
        '@playwright',
        '@playwright/test',
        'axe-core',
        '@axe-core',
        'vite',
        'vitest',
        '@vitest',
        'tsx',
        'typescript',
        'esbuild',
        'electron',
        'electron-builder',
        '@electron',
        'electron-vite',
      ]
      const packages = new Set(
        vendored
          .filter((entry) => entry.split('/').length > 1)
          .map((entry) => entry.split('/').slice(0, 2).join('/').replace('node_modules/', '')),
      )
      const banned = [...packages]
        .filter(
          (name) =>
            tooling.includes(name) ||
            /(^|\/)(tests?|spec|specimens?|e2e|fixtures?)(\/|$)/iu.test(name),
        )
        .sort()
      assertEqual(banned.join(', '), '', 'Test or build tooling shipped in node_modules')
      const fixtures = vendored.filter(
        (entry) =>
          /renderer-fixtures|specimen/iu.test(entry) ||
          /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/iu.test(entry),
      )
      assertEqual(
        fixtures.slice(0, 5).join(', '),
        '',
        'Test or specimen paths found inside the vendored dependencies',
      )
      const forbidden = own.filter(
        (entry) =>
          /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)(\/|$)/iu.test(entry) ||
          /(^|\/)\.(github|woostack|agents|impeccable)(\/|$)/u.test(entry) ||
          /\.(test|spec)\.[cm]?[jt]sx?$/iu.test(entry),
      )
      assertEqual(forbidden.join(', '), '', 'Test-only paths found in the packaged app payload')
      const topLevel = [...new Set(own.map((entry) => entry.split('/')[0]))].sort()
      assertEqual(
        topLevel.filter((entry) => entry !== 'out' && entry !== 'package.json').join(', '),
        '',
        'Unexpected top-level entries in the packaged app payload',
      )
      const outDirs = [
        ...new Set(
          own.filter((e) => e.startsWith('out/')).map((e) => e.split('/').slice(0, 2).join('/')),
        ),
      ]
      assertEqual(
        outDirs.filter((entry) => !/^out\/(main|preload|renderer)$/u.test(entry)).join(', '),
        '',
        'Unexpected build output directories in the packaged app payload',
      )
      // Minified bundles keep string literals, so specimen-only copy would still be visible.
      const markers = [
        'Recorded dispatches',
        'Git Stacks shared controls',
        'specimen-banner-note',
        'shell-fixture-inspector',
      ]
      const renderer = own.filter((entry) => /^out\/renderer\/.*\.(js|css|html)$/u.test(entry))
      for (const entry of renderer) {
        const source = shipped.read(entry).toString('utf8')
        for (const marker of markers) {
          assert(
            !source.includes(marker),
            `The shipped ${entry} contains specimen code ("${marker}")`,
          )
        }
      }
      return `${own.length} app files limited to out/{main,preload,renderer} + package.json, ${packages.size} vendored production packages with no test tooling, no specimen markers in ${renderer.length} renderer assets`
    })

    await check('window chrome and native controls are configured', async () => {
      const window = await inspector.call(MAIN_WINDOW)
      assert(window, 'The main process reported no BrowserWindow')
      assertEqual(window.title, 'Git Stacks', 'The window title')
      assertEqual(window.bounds.width, 1440, 'The window width')
      assertEqual(window.bounds.height, 940, 'The window height')
      assertEqual(window.minSize.width, 1000, 'The window minimum width')
      assertEqual(window.minSize.height, 700, 'The window minimum height')
      assertEqual(window.backgroundColor.toLowerCase(), '#e8ecf3', 'The window background colour')
      assert(window.visible === true, 'The window is not visible')
      assert(window.minimized === false, 'The window is minimized')
      assert(window.url.startsWith(`${ORIGIN}/`), `The window shows ${window.url}`)
      let chrome = 'standard title bar'
      if (process.platform === 'darwin') {
        // Electron 44 has no getTitleBarStyle getter, so a hidden title bar is proven from the
        // renderer content filling the whole window frame instead.
        assertEqual(window.contentBounds.y, window.bounds.y, 'A title bar is showing at the top')
        assertEqual(
          window.contentBounds.height,
          window.bounds.height,
          'The content is shorter than the frame',
        )
        chrome = 'content fills the window frame behind the native traffic lights'
      }
      const inset = await page.locator('.traffic-lights').boundingBox()
      assert(
        inset && inset.width > 0,
        'The renderer reserved no space for the native window controls',
      )
      return `${window.bounds.width}x${window.bounds.height}, ${chrome}, ${Math.round(inset.width)}px native-control inset`
    })

    await check(
      'native window state follows minimize/restore and maximize/unmaximize',
      async () => {
        const state = async (action, key, expected = true, timeout = 5000) => {
          const deadline = Date.now() + timeout
          let current = await inspector.call(MAIN_WINDOW_STATE, action)
          while (current[key] !== expected && Date.now() < deadline) {
            await new Promise((wait) => setTimeout(wait, 150))
            current = await inspector.call(MAIN_WINDOW_STATE, 'read')
          }
          assertEqual(
            current[key],
            expected,
            `The window did not report ${key}=${expected} (${JSON.stringify(current)})`,
          )
          return current
        }
        const before = await inspector.call(MAIN_WINDOW_STATE, 'read')
        assertEqual(before.minimized, false, 'The window started minimized')
        assertEqual(before.maximized, false, 'The window started maximized')
        const minimized = await state('minimize', 'minimized')
        assertEqual(minimized.visible, false, 'A minimized window still reported itself visible')
        const restored = await state('restore', 'minimized', false)
        assertEqual(restored.visible, true, 'The window stayed hidden after restore')
        const maximized = await state('maximize', 'maximized')
        const unmaximized = await state('unmaximize', 'maximized', false)
        assertEqual(
          unmaximized.bounds.width,
          before.bounds.width,
          'The window width after unmaximize',
        )
        assertEqual(
          unmaximized.bounds.height,
          before.bounds.height,
          'The window height after unmaximize',
        )
        // The state is driven through Electron's own window API on the window this smoke launched.
        // No other application is touched, and the title-bar buttons are not physically clicked, so
        // pointer hit-testing and VoiceOver on the native controls stay a manual pass.
        note(
          'Window state was driven through the Electron BrowserWindow API on the smoke-owned window; the native title-bar buttons were not clicked and were not read through macOS accessibility.',
        )
        return `minimize -> minimized, restore -> visible, maximize ${before.bounds.width}x${before.bounds.height} -> ${maximized.bounds.width}x${maximized.bounds.height}, unmaximize -> ${unmaximized.bounds.width}x${unmaximized.bounds.height}`
      },
    )

    await check('the packaged window zooms to 200% and restores', async () => {
      const baseline = await viewport(page)
      const original = await inspector.call(MAIN_ZOOM, null)
      assertEqual(original, 1, 'The packaged window did not start at zoom factor 1')
      let zoomed = null
      let restored = null
      try {
        await inspector.call(MAIN_ZOOM, 2)
        zoomed = await waitForViewport(page, Math.round(baseline.innerWidth / 2))
        if (zoomed.scale !== null && Math.abs(zoomed.scale - 2) >= 0.05) {
          note(
            `visualViewport.scale read ${zoomed.scale} at zoom factor 2; the halved CSS viewport is the authoritative zoom signal.`,
          )
        }
        assert(zoomed.shell > 0, 'The app shell disappeared at 200% zoom')
        assert(
          await page.locator('.titlebar-brand').isVisible(),
          'The title bar brand vanished at 200% zoom',
        )
      } finally {
        await inspector.call(MAIN_ZOOM, original)
        restored = await waitForViewport(page, baseline.innerWidth)
      }
      assertEqual(
        restored.innerWidth,
        baseline.innerWidth,
        'The CSS viewport width after restoring zoom',
      )
      assertEqual(
        restored.devicePixelRatio,
        baseline.devicePixelRatio,
        'devicePixelRatio after restoring zoom',
      )
      // A resized browser viewport is only a reflow; the zoom factor above is the real signal.
      return `zoom ${original}->2->${original}: innerWidth ${baseline.innerWidth}->${zoomed.innerWidth}->${restored.innerWidth}, dpr ${restored.devicePixelRatio}`
    })

    await check('renderer runs sandboxed behind the preload bridge', async () => {
      const window = await inspector.call(MAIN_WINDOW)
      const preferences = window.preferences
      for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) {
        assertEqual(preferences[key], true, `webPreferences.${key}`)
      }
      for (const key of [
        'nodeIntegration',
        'nodeIntegrationInWorker',
        'nodeIntegrationInSubFrames',
        'webviewTag',
      ]) {
        assertEqual(preferences[key], false, `webPreferences.${key}`)
      }
      // Electron 44 no longer reports the preload path from getLastWebPreferences(), so the preload
      // is proven by the bridge it installs here plus the shipped out/preload/index.cjs entry.
      const renderer = await page.evaluate(() => {
        const bridge = window.desktop ?? {}
        return {
          require: typeof window.require,
          process: typeof window.process,
          module: typeof window.module,
          buffer: typeof window.Buffer,
          api: Object.keys(bridge).sort(),
          // Functions cannot cross the DevTools boundary, so the types are read in the page.
          types: Object.fromEntries(
            Object.entries(bridge).map(([key, value]) => [key, typeof value]),
          ),
        }
      })
      for (const key of ['require', 'process', 'module', 'buffer']) {
        assertEqual(
          renderer[key],
          'undefined',
          `window.${key} is reachable in the sandboxed renderer`,
        )
      }
      // The privilege boundary is what matters here: the renderer reaches the
      // main process only through callable bridge members, with no Node globals
      // and no direct module access. Which members the bridge offers is the
      // product's business, not a fixed inventory to re-pin; that the bridge
      // actually works is proved by the repository, commit, and conflict steps
      // below, which all drive it and assert their Git effects.
      for (const [key, value] of Object.entries(renderer.types)) {
        assertEqual(value, 'function', `window.desktop.${key} is not callable`)
      }
      return `sandbox with context isolation, ${renderer.api.length} bridged methods, no Node globals in the page world`
    })

    await check('external links are validated before the shell sees them', async () => {
      const interception = await inspector.call(MAIN_EXTERNAL, 'install')
      assertEqual(
        (await inspector.call(MAIN_EXTERNAL, 'calls')).length,
        0,
        'An external link was opened before this check',
      )
      const rejections = await page.evaluate(async () => {
        const attempts = [
          'http://github.com/howarewoo/git-stacks',
          'https://gitlab.com/howarewoo/git-stacks',
          'https://github.com.evil.example/howarewoo',
          'https://user:token@github.com/howarewoo/git-stacks',
          'file:///etc/passwd',
          42,
        ]
        const results = []
        for (const value of attempts) {
          try {
            await window.desktop.openExternal(value)
            results.push({ value: String(value), rejected: false })
          } catch {
            results.push({ value: String(value), rejected: true })
          }
        }
        return results
      })
      for (const attempt of rejections) {
        assert(attempt.rejected, `The app accepted the external URL ${attempt.value}`)
      }
      assertEqual(
        (await inspector.call(MAIN_EXTERNAL, 'calls')).length,
        0,
        'A rejected URL still reached shell.openExternal',
      )
      if (!interception.installed) {
        note(
          'shell.openExternal could not be replaced at runtime, so only the rejected URLs were verified. No browser was launched.',
        )
        return `${rejections.length} rejected URLs, positive handoff skipped (interception unavailable)`
      }
      const allowed = 'https://github.com/howarewoo/git-stacks/pull/1'
      await page.evaluate((url) => window.desktop.openExternal(url), allowed)
      const calls = await inspector.call(MAIN_EXTERNAL, 'calls')
      assertEqual(calls.length, 1, 'The allowed link did not reach the shell exactly once')
      assertEqual(calls[0], allowed, 'The URL handed to the shell')
      await inspector.call(MAIN_EXTERNAL, 'restore')
      return `${rejections.length} rejected URLs, 1 allowed URL intercepted, no browser launched`
    })

    await check('opens the disposable repository from the onboarding list', async () => {
      const entry = page.locator('.onboarding-recent', { hasText: FIXTURE })
      await entry.waitFor()
      assertEqual(
        text(await entry.locator('small').innerText()),
        workspace.repo,
        'The onboarding entry path',
      )
      await entry.click()
      await page.locator('.toolbar[role="toolbar"]').waitFor()
      assert(
        (await page.locator('.titlebar-context').innerText()).includes(FIXTURE),
        'The title bar never showed the opened repository',
      )
      const opened = await page.evaluate(async () => (await window.desktop.refresh()).path)
      assertEqual(opened, canonicalRepo, 'The opened repository path reported by the app')
      assertEqual(head(workspace), 'main', 'git HEAD after opening the repository')
      assertEqual(porcelain(workspace), '', 'The fixture started with a dirty tree')
      return `opened ${opened}`
    })

    await check('GitHub stays unavailable without credentials', async () => {
      await gotoView(locators, 'Pull requests')
      const banner = page.locator('.gh-banner[role="status"]')
      await banner.waitFor()
      assert(
        (await banner.innerText()).includes('GitHub data unavailable'),
        'The pull request view did not report GitHub as unavailable',
      )
      const pullRequests = await page.evaluate(
        async () => (await window.desktop.refresh()).pullRequests,
      )
      assertEqual(
        pullRequests.length,
        0,
        'Pull requests appeared without an authenticated gh session',
      )
      await gotoView(locators, 'Branches')
      return 'the pull request view reports GitHub as unavailable and lists nothing'
    })

    await check('fetch transfers the published commit', async () => {
      await withNotice(locators, () => locators.button('Fetch').click(), /^Fetched /)
      assertEqual(
        git(workspace, ['rev-parse', 'refs/remotes/origin/main']),
        workspace.publishedTip,
        'refs/remotes/origin/main after Fetch',
      )
      assertEqual(
        git(workspace, ['rev-list', '--count', 'main..origin/main']),
        '1',
        'Commits behind after Fetch',
      )
      return `origin/main advanced to ${workspace.publishedTip.slice(0, 10)}`
    })

    await check('creates a branch and records its stack parent', async () => {
      await locators.button('New branch').click()
      const dialog = locators.dialog()
      await dialog.waitFor()
      await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill(FEATURE)
      await dialog
        .getByRole('combobox', { name: 'Parent branch', exact: true })
        .selectOption('main')
      const create = dialog.getByRole('button', { name: 'Create branch', exact: true })
      assert(
        !(await create.isDisabled()),
        '"Create branch" stayed disabled with a name and a parent',
      )
      await withNotice(locators, () => create.click(), /^Created and switched /)
      await locators.branch(FEATURE, true).waitFor()
      assertEqual(head(workspace), FEATURE, 'git HEAD after creating the branch')
      assertEqual(
        git(workspace, ['rev-parse', `refs/heads/${FEATURE}^{commit}`]),
        git(workspace, ['rev-parse', 'refs/heads/main^{commit}']),
        'The new branch tip against its parent tip',
      )
      assertEqual(
        git(workspace, ['config', '--local', '--get', `branch.${FEATURE}.parent`]),
        'main',
        'The recorded stack parent',
      )
      return `${FEATURE} created from main, checked out, with its parent recorded in git config`
    })

    await check('stages and commits through the working-changes view', async () => {
      await writeFile(join(workspace.repo, 'feature.txt'), 'first pass\n')
      await refreshSnapshot(locators)
      await gotoView(locators, 'Working changes')
      await locators.unstaged().getByRole('button', { name: 'Inspect feature.txt' }).waitFor()
      await withNotice(locators, () => locators.button('Stage all').click(), /^Staged \d+ path/)
      await locators.staged().getByRole('button', { name: 'Inspect feature.txt' }).waitFor()
      assertEqual(porcelain(workspace), 'A  feature.txt', 'The index after staging')
      const message = 'Add feature file from the packaged app'
      await locators.page.getByRole('textbox', { name: 'Commit message' }).fill(message)
      const commit = locators.button('Commit')
      assert(
        !(await commit.isDisabled()),
        '"Commit" stayed disabled with a staged file and a message',
      )
      await withNotice(locators, () => commit.click(), /^Committed staged changes/)
      assertEqual(git(workspace, ['log', '-1', '--pretty=%s']), message, 'The new commit subject')
      assertEqual(
        git(workspace, ['show', 'HEAD:feature.txt']),
        'first pass',
        'The committed file content',
      )
      assertEqual(porcelain(workspace), '', 'The working tree after committing')
      return `staged and committed "${message}"`
    })

    await check('stashes and pops working changes', async () => {
      await writeFile(join(workspace.repo, 'feature.txt'), 'second pass\n')
      await writeFile(join(workspace.repo, 'scratch.txt'), 'untracked\n')
      await refreshSnapshot(locators)
      await gotoView(locators, 'Working changes')
      await locators.button('Stash changes').click()
      const dialog = locators.dialog()
      await dialog.waitFor()
      const message = 'work in progress from the packaged smoke'
      await dialog.getByRole('textbox', { name: 'Message (optional)', exact: true }).fill(message)
      await dialog.getByRole('checkbox', { name: 'Include untracked files' }).check()
      const submit = dialog.getByRole('button', { name: 'Stash working changes', exact: true })
      assert(!(await submit.isDisabled()), 'The stash dialog stayed disabled')
      await withNotice(locators, () => submit.click(), /^Stashed /)
      assertEqual(porcelain(workspace), '', 'The working tree after stashing')
      assert(
        !existsSync(join(workspace.repo, 'scratch.txt')),
        'The untracked file survived the stash',
      )
      assert(git(workspace, ['stash', 'list']).includes(message), 'git stash list lost the message')
      await gotoView(locators, 'Stashes')
      await page.getByRole('listitem', { name: 'Stash stash@{0}' }).waitFor()
      await withNotice(
        locators,
        () => page.getByRole('button', { name: 'Pop stash@{0}' }).click(),
        /^Applied and removed /,
      )
      assertEqual(git(workspace, ['stash', 'list']), '', 'git stash list after popping')
      const restored = porcelain(workspace)
      assert(
        restored.includes('feature.txt') && restored.includes('scratch.txt'),
        `The stash was not fully restored (${restored})`,
      )
      assertEqual(
        readFileSync(join(workspace.repo, 'feature.txt'), 'utf8'),
        'second pass\n',
        'The restored content',
      )
      await gotoView(locators, 'Branches')
      return `stashed and popped "${message}" including the untracked file`
    })

    await check('resolves a merge conflict and continues the operation', async () => {
      await writeFile(join(workspace.repo, CONFLICT), 'feature side\n')
      await commitThroughUi(workspace, locators, 'Feature side change')
      await switchToBranch(workspace, locators, 'main')
      await writeFile(join(workspace.repo, CONFLICT), 'main side\n')
      commitFromGit(workspace, 'Main side change')
      await refreshSnapshot(locators)
      const expectedParents = `${git(workspace, ['rev-parse', 'HEAD'])} ${git(workspace, ['rev-parse', FEATURE])}`

      await mergeThroughUi(locators, FEATURE)
      const banner = locators.operation()
      await banner.waitFor()
      assert(
        /1 conflicted file/.test(text(await banner.innerText())),
        'The operation banner did not report the conflict',
      )
      assert(
        await banner.getByRole('button', { name: 'Continue', exact: true }).isDisabled(),
        '"Continue" was enabled while the conflict was unresolved',
      )
      assert(mergeInProgress(workspace), 'git has no MERGE_HEAD after the conflicting merge')

      await gotoView(locators, 'Working changes')
      // A conflicted file is both staged and unstaged in Git's index, so it renders in both
      // sections; scope the click to the unstaged list to keep the locator unambiguous.
      await locators
        .unstaged()
        .getByRole('button', { name: `Resolve ${CONFLICT}`, exact: true })
        .click()
      const inspectorPanel = page.locator(`section[aria-label="Inspect ${CONFLICT}"]`)
      await inspectorPanel.waitFor()
      // Resolution now happens in the three-way resolver the inspector opens. The
      // resolver names each side by what it means for the active operation, so the
      // stage-3 (incoming) label is read from the pane instead of hardcoded.
      await inspectorPanel.getByRole('button', { name: 'Open conflict resolver' }).click()
      const resolver = page.getByRole('dialog')
      await resolver.waitFor()
      const incomingSide = text(
        await resolver
          .locator('.conflict-pane')
          .nth(2)
          .locator('.conflict-pane-head > span')
          .first()
          .innerText(),
      )
      // A file with conflicting regions is decided one region at a time, then the
      // edited result is staged; the whole-file accept controls only exist for a
      // file with no regions.
      await resolver.getByRole('button', { name: `Accept ${incomingSide} for conflict 1` }).click()
      await withNotice(
        locators,
        () => resolver.getByRole('button', { name: 'Mark resolved and stage' }).click(),
        /^Resolved /,
      )
      await locators
        .staged()
        .getByRole('button', { name: `Inspect ${CONFLICT}` })
        .waitFor()
      const resolved = readFileSync(join(workspace.repo, CONFLICT), 'utf8')
      assert(
        !/^<{7}|^={7}|^>{7}/m.test(resolved),
        `The resolved file still has conflict markers: ${resolved}`,
      )
      assertEqual(resolved, 'feature side\n', 'The resolved file content')

      const resume = locators.operation().getByRole('button', { name: 'Continue', exact: true })
      await resume.waitFor()
      assert(
        !(await resume.isDisabled()),
        '"Continue" stayed disabled after the resolution was staged',
      )
      await withNotice(locators, () => resume.click(), /^Continued /)
      assert(!mergeInProgress(workspace), 'MERGE_HEAD survived the continue')
      assertEqual(
        git(workspace, ['log', '-1', '--pretty=%P']),
        expectedParents,
        'The completed merge must contain the reviewed main and feature tips',
      )
      await locators.operation().waitFor({ state: 'hidden' })
      assertEqual(head(workspace), 'main', 'git HEAD after completing the merge')
      return 'the conflict was resolved in the file inspector and Continue created the merge commit'
    })

    await check('aborts a conflicted merge and restores the pre-merge state', async () => {
      await writeFile(join(workspace.repo, CONFLICT), 'abort main side\n')
      await commitThroughUi(workspace, locators, 'Abort scenario main side')
      const before = readFileSync(join(workspace.repo, CONFLICT), 'utf8')

      // The far side of the conflict is prepared with real git; the conflict, the abort, and the
      // recovery all happen through the shipped renderer.
      git(workspace, ['switch', '--quiet', FEATURE])
      await writeFile(join(workspace.repo, CONFLICT), 'abort feature side\n')
      commitFromGit(workspace, 'Abort scenario feature side')
      git(workspace, ['switch', '--quiet', 'main'])
      await refreshSnapshot(locators)

      await mergeThroughUi(locators, FEATURE)
      const banner = locators.operation()
      await banner.waitFor()
      assert(mergeInProgress(workspace), 'git has no MERGE_HEAD after the second conflicting merge')
      await banner.getByRole('button', { name: /^Abort/ }).click()
      const dialog = locators.dialog()
      await dialog.waitFor()
      const abort = dialog.getByRole('button', { name: 'Abort merge', exact: true })
      await abort.waitFor()
      assert(!(await abort.isDisabled()), '"Abort merge" stayed disabled')
      await withNotice(locators, () => abort.click(), /^Aborted /)
      assert(!mergeInProgress(workspace), 'MERGE_HEAD survived the abort')
      assertEqual(
        readFileSync(join(workspace.repo, CONFLICT), 'utf8'),
        before,
        'The file after the abort',
      )
      assertEqual(porcelain(workspace), '', 'The working tree after the abort')
      await locators.operation().waitFor({ state: 'hidden' })
      return 'the abort restored the pre-merge file and cleared the operation banner'
    })

    await check('the disposable remote was never written to', async () => {
      assertEqual(
        git(workspace, ['for-each-ref', '--format=%(refname)'], { cwd: workspace.origin }),
        'refs/heads/main',
        'The refs of the bare origin repository',
      )
      assertEqual(
        git(workspace, ['rev-parse', 'main'], { cwd: workspace.origin }),
        workspace.publishedTip,
        'The published tip on the bare origin',
      )
      return 'origin still holds only the fixture main branch at the published commit'
    })

    // Run last: the blocked navigation leaves a pending load in the renderer, so every UI
    // interaction has to happen before it.
    await check('navigation and popups stay inside the app', async () => {
      const pagesBefore = page.context().pages().length
      const denied = await page.evaluate(() => {
        const opened = window.open('https://github.com/howarewoo/git-stacks')
        try {
          window.location.href = 'https://127.0.0.1:9/blocked-navigation'
        } catch {
          // A blocked navigation may surface as a throw; the assertions below are the check.
        }
        return opened === null
      })
      assert(denied, 'window.open returned a window instead of being denied')
      // Wait for the real stop rather than suppressing it: the load either fails at the network
      // layer or the main process cancels it, and either way the document must stay on app://.
      await page
        .waitForLoadState('load', { timeout: 10_000 })
        .catch(() =>
          note('The blocked navigation never settled a load state; the document stayed put.'),
        )
      assert(page.url().startsWith(`${ORIGIN}/`), `The window navigated to ${page.url()}`)
      assertEqual(page.context().pages().length, pagesBefore, 'A popup opened a new page')
      return 'window.open denied and the off-app navigation was prevented'
    })

    await report(null)
    return { evidence: workspace.evidence, passed: results.filter((result) => result.ok).length }
  } catch (error) {
    if (page) {
      await page
        .screenshot({ path: join(workspace.evidence, 'failure.png'), fullPage: true })
        .catch(() => {})
    }
    await report(error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    clearTimeout(timer)
    await cleanup()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  let summary
  try {
    summary = await run(options)
  } catch (error) {
    const step = error.step ?? 'startup'
    if (!error.step) results.push({ step, ok: false, detail: String(error.message ?? error) })
    log(`\nThe smoke stopped at: ${step}`)
    for (const result of results.filter((entry) => !entry.ok))
      log(`  - ${result.step}: ${result.detail}`)
    if (!error.step)
      log(
        String(error.stack ?? error)
          .split('\n')
          .slice(0, 6)
          .join('\n'),
      )
    return 1
  }
  log(`\n${summary.passed}/${results.length} packaged checks passed`)
  if (limits.length > 0) {
    log('\nStated limits:')
    for (const limit of limits) log(`  - ${limit}`)
  }
  log(`Evidence: ${summary.evidence}`)
  return 0
}

process.exit(await main())
