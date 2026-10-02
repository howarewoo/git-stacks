/**
 * The PR Inbox, driven through the real application.
 *
 * Electron runs the built main process through the shared isolated-desktop
 * fixture (tests/fixtures/isolated-desktop.cjs), which installs a synthetic
 * credential-sealing backend before the production main module loads and never
 * touches the OS key store. The window reaches a local synthetic GitHub host
 * over verified TLS: the fixture certificate is trusted through
 * NODE_EXTRA_CA_CERTS, no client is told to skip verification, and every token
 * belongs to this run. The six queue groups, the `/` search chord, the
 * filtered-empty state, row-to-Review navigation, and a saved filter that
 * survives a real process restart are all observed in the live window.
 *
 * Nothing here writes to github.com: the only server is this script's own, the
 * fixture repositories live in the owned temporary root, their remotes name
 * this run's host, and the inherited environment is stripped of GitHub/token
 * shape before the window starts.
 */
const { spawn, execFileSync } = require('node:child_process')
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const net = require('node:net')
const { createServer } = require('node:https')
const { chromium } = require('@playwright/test')

const TOKEN = 'ghp_smoke_token_that_must_never_appear_again'

const ROOT_DIR = resolve(__dirname, '..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-stacks-inbox-e2e-')))
const userData = join(root, 'userdata')
mkdirSync(userData, { recursive: true })
const fixtureRoot = join(root, 'desktop-fixture')
mkdirSync(fixtureRoot, { recursive: true })

const defaultShotsDir = join(
  ROOT_DIR,
  'test-results',
  'inbox-electron',
  `run-${Date.now()}-${process.pid}`,
)
const shotDir = process.argv[2] ? resolve(process.argv[2]) : defaultShotsDir
mkdirSync(shotDir, { recursive: true })
const UNSAFE_INHERITED =
  /^(GIT_|GH_|GITHUB_|GIT_STACKS_)|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^SSH_AUTH_SOCK$|(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY)/iu
const disposableHome = join(root, 'home')
mkdirSync(disposableHome, { recursive: true })
const emptyGitConfig = join(root, 'gitconfig')
writeFileSync(emptyGitConfig, '')

function environment() {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !UNSAFE_INHERITED.test(key)),
  )
  delete inherited.NODE_TLS_REJECT_UNAUTHORIZED
  delete inherited.ELECTRON_RENDERER_URL
  return {
    ...inherited,
    HOME: process.platform === 'darwin' ? process.env.HOME : disposableHome,
    XDG_CONFIG_HOME: join(disposableHome, '.config'),
    GH_CONFIG_DIR: join(disposableHome, '.config', 'gh'),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGitConfig,
  }
}

const gitEnv = {
  ...environment(),
  GIT_AUTHOR_NAME: 'Inbox Fixture',
  GIT_AUTHOR_EMAIL: 'inbox@example.invalid',
  GIT_COMMITTER_NAME: 'Inbox Fixture',
  GIT_COMMITTER_EMAIL: 'inbox@example.invalid',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgSign',
  GIT_CONFIG_VALUE_0: 'false',
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: gitEnv,
  }).trim()
}

function gitState() {
  const snapshot = {}
  for (const dir of [repositoryA, repositoryB]) {
    snapshot[dir] = {
      head: git(dir, 'rev-parse', 'HEAD'),
      branch: git(dir, 'branch', '--show-current'),
      refs: git(dir, 'for-each-ref', '--format=%(refname)'),
      status: git(dir, 'status', '--porcelain=v1'),
    }
  }
  return snapshot
}
const certificate = mkdtempSync(join(root, 'cert-'))
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

/** Two registered repositories: the primary and one other, so a row that names
 * another owning repository adopts it rather than borrowing the on-screen one. */
const repositoryA = join(root, 'repo-git-stacks')
const repositoryB = join(root, 'repo-specimens')
for (const dir of [repositoryA, repositoryB]) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-m', 'baseline')
}
const headA = git(repositoryA, 'rev-parse', 'HEAD')
const headB = git(repositoryB, 'rev-parse', 'HEAD')

const VIEWER = 'ada'

/** The queue's facts, shaped the way the GitHub GraphQL schema hands them out.
 * Membership rules live in src/shared/pr-inbox.ts; these facts put one row in
 * each of the six groups, and no row anywhere else. */
function prNode({
  number,
  title,
  url,
  headRefName,
  baseRefName = 'main',
  isDraft = false,
  state = 'OPEN',
  mergedAt = null,
  author = null,
  reviewRequested = [],
  reviewDecision = null,
  lastReview = null,
  lastComment = null,
  checkState = null,
  repository,
  headOid,
  updatedAt = '2026-09-28T09:00:00Z',
}) {
  return {
    number,
    title,
    url,
    headRefName,
    baseRefName,
    headRefOid: headOid,
    isDraft,
    state,
    updatedAt,
    mergedAt,
    author: author === null ? null : { login: author },
    headRepository: { nameWithOwner: repository },
    reviewDecision,
    mergeCommit: { oid: headOid },
    mergeStateStatus: 'CLEAN',
    reviewRequests: { nodes: reviewRequested.map((login) => ({ requestedReviewer: { login } })) },
    latestReviews: {
      nodes: lastReview
        ? [{ author: { login: lastReview.login }, submittedAt: lastReview.at }]
        : [],
    },
    comments: {
      nodes: lastComment
        ? [{ author: { login: lastComment.login }, createdAt: lastComment.at }]
        : [],
    },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: checkState === null ? null : { state: checkState },
          },
        },
      ],
    },
  }
}

function buildRepos(host) {
  return {
    'howarewoo/git-stacks': {
      open: [
        prNode({
          number: 81,
          title: 'Add a GitHub-derived PR Inbox across registered repositories',
          url: `https://${host}/howarewoo/git-stacks/pull/81`,
          headRefName: 'feature/pr-inbox',
          author: 'grace',
          reviewRequested: [VIEWER],
          reviewDecision: 'REVIEW_REQUIRED',
          checkState: 'SUCCESS',
          repository: 'howarewoo/git-stacks',
          headOid: headA,
          updatedAt: '2026-09-28T12:00:00Z',
        }),
        prNode({
          number: 64,
          title: 'Keep the Inbox rows an earlier account read off the screen',
          url: `https://${host}/howarewoo/git-stacks/pull/64`,
          headRefName: 'feature/inbox-identity',
          author: VIEWER,
          reviewDecision: 'REVIEW_REQUIRED',
          lastReview: { login: 'grace', at: '2026-09-28T10:00:00Z' },
          repository: 'howarewoo/git-stacks',
          headOid: headA,
          updatedAt: '2026-09-28T10:00:00Z',
        }),
        prNode({
          number: 58,
          title: 'Name the repositories a refresh did not attempt',
          url: `https://${host}/howarewoo/git-stacks/pull/58`,
          headRefName: 'feature/inbox-partial',
          author: VIEWER,
          repository: 'howarewoo/git-stacks',
          headOid: headA,
          updatedAt: '2026-09-28T09:00:00Z',
        }),
        prNode({
          number: 51,
          title: 'Sketch the Inbox group rail',
          url: `https://${host}/howarewoo/git-stacks/pull/51`,
          headRefName: 'feature/inbox-draft',
          isDraft: true,
          author: 'grace',
          repository: 'howarewoo/git-stacks',
          headOid: headA,
          updatedAt: '2026-09-28T08:00:00Z',
        }),
        prNode({
          number: 96,
          title: 'Ship the approved lane',
          url: `https://${host}/howarewoo/git-stacks/pull/96`,
          headRefName: 'feature/approved-lane',
          author: VIEWER,
          reviewDecision: 'APPROVED',
          lastComment: { login: 'grace', at: '2026-09-28T11:00:00Z' },
          repository: 'howarewoo/git-stacks',
          headOid: headA,
          updatedAt: '2026-09-28T11:00:00Z',
        }),
      ],
      merged: [
        prNode({
          number: 44,
          title: 'Land the first queue read',
          url: `https://${host}/howarewoo/git-stacks/pull/44`,
          headRefName: 'feature/inbox-merged',
          state: 'MERGED',
          mergedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          author: null,
          repository: 'howarewoo/git-stacks',
          headOid: headA,
        }),
      ],
    },
    'howarewoo/design-system-specimens': {
      open: [
        prNode({
          number: 77,
          title: 'Charge every native-stack page to the refresh budget',
          url: `https://${host}/howarewoo/design-system-specimens/pull/77`,
          headRefName: 'feature/inbox-budget',
          author: 'grace',
          reviewRequested: [VIEWER],
          reviewDecision: 'REVIEW_REQUIRED',
          checkState: 'FAILURE',
          repository: 'howarewoo/design-system-specimens',
          headOid: headB,
          updatedAt: '2026-09-28T11:00:00Z',
        }),
      ],
      merged: [],
    },
  }
}
let REPOS = null

function inboxAnswer(variables) {
  const key = `${variables.owner}/${variables.name}`
  const facts = REPOS[key] ?? { open: [], merged: [] }
  return {
    viewer: { login: VIEWER },
    repository: {
      open: {
        nodes: facts.open,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      merged: {
        nodes: facts.merged,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
}

function repositoryAnswer(variables) {
  const key = `${variables.owner}/${variables.name}`
  const facts = REPOS[key] ?? { open: [], merged: [] }
  const nodes = facts.open.map((node) => ({
    ...node,
    body: '',
  }))
  return {
    repository: {
      pullRequests: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
}

function pullRequestAnswer(variables) {
  const key = `${variables.owner}/${variables.name}`
  const facts = REPOS[key] ?? { open: [], merged: [] }
  const node = [...facts.open, ...facts.merged].find((entry) => entry.number === variables.number)
  return {
    repository: {
      pullRequest: node ? { ...node, body: '' } : null,
    },
  }
}

const asked = []
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
      const body = Buffer.concat(chunks).toString('utf8')
      asked.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.authorization ?? null,
      })
      const answer = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (url.pathname === '/api/graphql' && request.method === 'POST') {
        const parsed = JSON.parse(body || '{}')
        const query = typeof parsed.query === 'string' ? parsed.query : ''
        const variables = parsed.variables ?? {}
        if (query.includes('viewer { login }') && query.includes('open: pullRequests')) {
          return answer(200, { data: inboxAnswer(variables) })
        }
        if (query.includes('reviewThreads')) {
          return answer(200, {
            data: {
              repository: {
                viewerPermission: 'ADMIN',
                pullRequest: {
                  state: 'OPEN',
                  viewerDidAuthor: false,
                  reviewThreads: {
                    totalCount: 0,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          })
        }
        if (query.includes('viewerPermission')) {
          return answer(200, {
            data: {
              viewer: { login: VIEWER },
              repository: {
                viewerPermission: 'ADMIN',
                pullRequest: { state: 'OPEN', viewerDidAuthor: false },
              },
            },
          })
        }
        if (query.includes('pullRequest(number')) {
          return answer(200, { data: pullRequestAnswer(variables) })
        }
        return answer(200, { data: repositoryAnswer(variables) })
      }
      if (url.pathname.endsWith('/check-runs'))
        return answer(200, { check_runs: [], total_count: 0 })
      if (url.pathname.endsWith('/status'))
        return answer(200, { statuses: [], state: 'pending', total_count: 0 })
      if (url.pathname.includes('/actions/runs'))
        return answer(200, { workflow_runs: [], total_count: 0 })
      if (url.pathname.endsWith('/reviews')) return answer(200, [])
      if (url.pathname.endsWith('/comments')) return answer(200, [])
      if (/\/pulls\/[^/]+\/files$/u.test(url.pathname)) return answer(200, [])
      if (/\/pulls\/[^/]+\/commits$/u.test(url.pathname)) return answer(200, [])
      if (/\/pulls\/[^/]+$/u.test(url.pathname) && request.method === 'GET') {
        return answer(200, { number: Number(url.pathname.split('/').pop()), state: 'open' })
      }
      if (
        /\/repos\/[^/]+\/[^/]+\/branches\/.+\/protection\/required_status_checks$/.test(
          url.pathname,
        )
      ) {
        return answer(404, { message: 'Branch not protected' })
      }
      if (/\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
        return answer(404, { message: 'Not Found' })
      }
      if (url.pathname === '/api/v3/user') return answer(200, { login: VIEWER })
      return answer(404, { message: `unhandled ${request.method} ${url.pathname}` })
    })
  },
)

const activeSockets = new Set()
server.on('connection', (socket) => {
  activeSockets.add(socket)
  socket.once('close', () => activeSockets.delete(socket))
})

async function closeServer() {
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections()
  }
  for (const socket of activeSockets) {
    try {
      socket.destroy()
    } catch {}
  }
  activeSockets.clear()
  await new Promise((resolve) => server.close(() => resolve())).catch(() => {})
}

function slug(value) {
  return Buffer.from(value, 'utf8').toString('hex').toUpperCase()
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const activeApps = new Set()
const activeBrowsers = new Set()

async function stop(app) {
  if (!app?.pid) return
  const signal = (name) => {
    try {
      process.kill(-app.pid, name)
    } catch {
      try {
        app.kill(name)
      } catch {
        // Already gone.
      }
    }
  }
  const running = () => {
    if (app.exitCode !== null || app.signalCode !== null) return false
    if (process.platform === 'win32') return false
    try {
      process.kill(-app.pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      if (error.code === 'EPERM') return true
      throw error
    }
  }
  const waitForExit = async () => {
    const deadline = Date.now() + 5000
    while (running() && Date.now() < deadline) {
      await delay(100)
    }
  }
  signal('SIGTERM')
  await waitForExit()
  if (running()) {
    signal('SIGKILL')
    await waitForExit()
  }
  if (running()) {
    throw new Error(`The smoke-owned process group ${app.pid} did not terminate`)
  }
  activeApps.delete(app)
}

let cleanupPromise = null
function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    for (const browser of Array.from(activeBrowsers)) {
      try {
        await browser.close()
      } catch {}
    }
    activeBrowsers.clear()

    for (const app of Array.from(activeApps)) {
      try {
        await stop(app)
      } catch (error) {
        console.error(`Error stopping app ${app.pid}:`, error)
      }
    }

    await closeServer()

    if (existsSync(root)) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch (error) {
        console.error(`Error cleaning up fixture root ${root}:`, error)
      }
    }
  })()
  return cleanupPromise
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  })
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function launch() {
  const port = await availablePort()
  const host = `127.0.0.1:${server.address().port}`
  const env = {
    ...environment(),
    GIT_STACKS_USER_DATA: userData,
    NODE_EXTRA_CA_CERTS: join(certificate, 'cert.pem'),
    GIT_STACKS_GITHUB_TRANSPORT: 'direct',
    [`GIT_STACKS_GITHUB_TOKEN_${slug(host)}`]: TOKEN,
  }
  const app = spawn(
    require('electron'),
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
      join(ROOT_DIR, 'out', 'main', 'index.js'),
    ],
    {
      env,
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  let output = ''
  app.stdout.on('data', (chunk) => (output += chunk))
  app.stderr.on('data', (chunk) => (output += chunk))
  activeApps.add(app)
  return { app, output: () => output, port }
}

async function waitForCdp(app, output, port) {
  let target = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`Electron exited: ${output()}`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (target) return target
    } catch {
      /* the window has not come up yet */
    }
    await delay(100)
  }
  throw new Error(`the renderer was unavailable: ${output()}`)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'SMOKE_OK  ' : 'SMOKE_BAD '} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const host = `127.0.0.1:${server.address().port}`
    REPOS = buildRepos(host)
    writeFileSync(
      join(userData, 'repositories.json'),
      JSON.stringify(
        [
          { path: repositoryA, name: 'git-stacks' },
          { path: repositoryB, name: 'design-system-specimens' },
        ],
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify(
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
      ) + '\n',
    )
    // Remotes point the fixture repositories at this run's host.
    git(repositoryA, 'remote', 'add', 'origin', `https://${host}/howarewoo/git-stacks.git`)
    git(
      repositoryB,
      'remote',
      'add',
      'origin',
      `https://${host}/howarewoo/design-system-specimens.git`,
    )

    const first = await launch()
    let firstBrowser = null

    try {
      const target = await waitForCdp(first.app, first.output, first.port)
      firstBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${first.port}`)
      activeBrowsers.add(firstBrowser)
      const context = firstBrowser.contexts()[0]
      const page = context.pages()[0] ?? (await context.newPage())
      // Open the PR Inbox the way a person does: Mod+9.
      await page.waitForSelector('text=PR Inbox', { timeout: 30_000 })
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+9' : 'Control+9')
      await page.waitForSelector('nav[aria-label="Inbox groups"]', { timeout: 30_000 })

      // Six groups, each named and counted by the facts the host answered.
      const rail = page.getByRole('navigation', { name: 'Inbox groups' })
      let allGroupsVisible = true
      for (const [label, count] of [
        ['Review requested', 2],
        ['Needs my response', 2],
        ['My PRs — waiting', 1],
        ['My PRs — approved', 1],
        ['Drafts', 1],
        ['Recently merged', 1],
      ]) {
        const btn = rail.getByRole('button', { name: `${label} ${count}` })
        await btn.waitFor({ timeout: 15_000 })
        if ((await btn.count()) !== 1) allGroupsVisible = false
      }
      check('the queue shows all six groups with the counts the facts decide', allGroupsVisible)
      const rows = page.locator('.pr-inbox-item')
      await rows.first().waitFor({ timeout: 15_000 })
      check(
        'both Review requested rows are listed',
        (await rows.count()) === 2,
        `${await rows.count()}`,
      )
      const firstRowLabel = await rows
        .filter({ hasText: 'Add a GitHub-derived PR Inbox' })
        .first()
        .getByRole('button')
        .getAttribute('aria-label')
      check(
        'the Review requested row announces its pull request and author',
        /Add a GitHub-derived PR Inbox/.test(firstRowLabel ?? '') &&
          /grace/.test(firstRowLabel ?? ''),
        firstRowLabel ?? '',
      )
      await page.screenshot({ path: join(shotDir, 'inbox-groups.png') })

      // The `/` chord lands in the queue's own field.
      await page.getByRole('heading', { level: 1, name: 'PR Inbox' }).click()
      await page.keyboard.press('/')
      const searchBox = page.getByRole('searchbox', { name: 'Search the queue' })
      await searchBox.waitFor({ timeout: 10_000 })
      const focusedPlaceholder = await page.evaluate(
        () => document.activeElement?.getAttribute('placeholder') ?? '',
      )
      check(
        'the `/` chord focuses the queue field',
        /Title, #number/.test(focusedPlaceholder),
        focusedPlaceholder,
      )

      // Search → filtered empty (distinguished from an empty queue) → clear.
      await page.keyboard.type('zzz-nothing-matches')
      const emptyHeading = page.getByRole('heading', { name: 'No matching pull requests' })
      await emptyHeading.waitFor({ timeout: 10_000 })
      check(
        'a matchless search reports filtered-empty, not an empty queue',
        (await emptyHeading.count()) === 1 && (await rows.count()) === 0,
        `heading count=${await emptyHeading.count()}, rows count=${await rows.count()}`,
      )
      await page.screenshot({ path: join(shotDir, 'inbox-filtered-empty.png') })
      await page.getByRole('button', { name: 'Clear filters' }).click()
      await rows.first().waitFor({ timeout: 10_000 })
      check(
        'clearing the search restores the rows',
        (await rows.count()) === 2,
        `${await rows.count()}`,
      )

      // Approved work lands in Approved, and the same approved pull request with a
      // later foreign comment is the queue's intentional Needs-my-response overlap.
      await rail.getByRole('button', { name: 'My PRs — approved 1' }).click()
      await page.waitForTimeout(400)
      check(
        'the Approved group holds the approved pull request',
        (await rows.count()) === 1 &&
          (await rows.filter({ hasText: 'Ship the approved lane' }).count()) === 1,
        `${await rows.count()}`,
      )
      await rail.getByRole('button', { name: 'Needs my response 2' }).click()
      await page.waitForTimeout(400)
      check(
        'Needs my response holds the same approved pull request plus the older one',
        (await rows.count()) === 2 &&
          (await rows.filter({ hasText: 'Ship the approved lane' }).count()) === 1 &&
          (await rows
            .filter({ hasText: 'Keep the Inbox rows an earlier account read off the screen' })
            .count()) === 1,
        `${await rows.count()}`,
      )
      await rail.getByRole('button', { name: 'Review requested 2' }).click()
      await page.waitForTimeout(400)

      // Row for a repository that is not on screen adopts that repository; the
      // row that is on screen opens it directly. Both render their own Review
      // without any Git action.
      const stateBefore81 = gitState()
      await rows
        .filter({ hasText: 'Add a GitHub-derived PR Inbox' })
        .first()
        .getByRole('button')
        .click()
      const headline = page.locator('header.review-headline')
      await headline.waitFor({ timeout: 20_000 })
      const headlineTitle = await headline.locator('.review-headline-title strong').textContent()
      check(
        'opening a row renders the loaded Review headline for #81',
        headlineTitle?.includes('#81') && headlineTitle?.includes('Add a GitHub-derived PR Inbox'),
        headlineTitle ?? '',
      )
      check(
        'loaded Review renders conversation section and no chooser list remains',
        (await page.locator('section.review-conversation').count()) === 1 &&
          (await page.locator('.review-chooser').count()) === 0,
      )
      check(
        'opening a row leaves every repository HEAD, branch, refs and worktree unchanged',
        JSON.stringify(gitState()) === JSON.stringify(stateBefore81),
      )
      await page.screenshot({ path: join(shotDir, 'inbox-review.png') })

      // The second-row repository adopts the other registered repository.
      await page
        .getByRole('button', { name: /PR Inbox/ })
        .first()
        .click()
      await page.waitForSelector('nav[aria-label="Inbox groups"]', { timeout: 20_000 })
      const stateBefore77 = gitState()
      await rows
        .filter({ hasText: 'Charge every native-stack page' })
        .first()
        .getByRole('button')
        .click()
      const foreignHeadline = page.locator('header.review-headline')
      await foreignHeadline.waitFor({ timeout: 20_000 })
      const foreignTitle = await foreignHeadline
        .locator('.review-headline-title strong')
        .textContent()
      check(
        'adopting another repository renders its loaded Review headline for #77',
        foreignTitle?.includes('#77') && foreignTitle?.includes('Charge every native-stack page'),
        foreignTitle ?? '',
      )
      check(
        'foreign Review renders conversation section and no chooser list remains',
        (await page.locator('section.review-conversation').count()) === 1 &&
          (await page.locator('.review-chooser').count()) === 0,
      )
      check(
        'adopting another repository leaves Git state unchanged',
        JSON.stringify(gitState()) === JSON.stringify(stateBefore77),
      )
      await page.screenshot({ path: join(shotDir, 'inbox-foreign-repo.png') })

      // Save a filter with non-default group, search, and repository, then restart
      // and prove it survives the process boundary.
      await page
        .getByRole('button', { name: /PR Inbox/ })
        .first()
        .click()
      await page.waitForSelector('nav[aria-label="Inbox groups"]', { timeout: 20_000 })
      const filterName = page.getByPlaceholder('Filter name')
      await rail.getByRole('button', { name: 'Drafts 1' }).click()
      await page.waitForTimeout(400)
      await filterName.fill('My draft sketches')
      await page.getByPlaceholder('Title, #number, repository, branch, or author').fill('sketch')
      await page.getByRole('combobox', { name: 'Repository' }).selectOption('howarewoo/git-stacks')
      await page.getByRole('button', { name: 'Save', exact: true }).first().click()
      await page.waitForTimeout(700)
      await page.screenshot({ path: join(shotDir, 'inbox-saved-filter.png') })
    } finally {
      if (firstBrowser) {
        activeBrowsers.delete(firstBrowser)
        await firstBrowser.close().catch(() => {})
      }
      await stop(first.app)
    }

    const second = await launch()
    let secondBrowser = null

    try {
      const target = await waitForCdp(second.app, second.output, second.port)
      secondBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${second.port}`)
      activeBrowsers.add(secondBrowser)
      const context = secondBrowser.contexts()[0]
      const page = context.pages()[0] ?? (await context.newPage())
      await page.waitForSelector('text=PR Inbox', { timeout: 30_000 })
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+9' : 'Control+9')
      await page.waitForSelector('nav[aria-label="Inbox groups"]', { timeout: 30_000 })
      const restartRail = page.getByRole('navigation', { name: 'Inbox groups' })
      const chip = restartRail.getByRole('button', { name: 'My draft sketches', exact: true })
      await chip.waitFor({ timeout: 20_000 })
      await chip.click()
      await page.waitForTimeout(400)

      const draftsGroup = restartRail.getByRole('button', { name: /Drafts/ })
      const groupCurrent = await draftsGroup.getAttribute('aria-current')
      const searchBox = page.getByRole('searchbox', { name: 'Search the queue' })
      const searchValue = await searchBox.inputValue()
      const repoSelect = page.getByRole('combobox', { name: 'Repository' })
      const repoValue = await repoSelect.inputValue()

      check(
        'restored saved filter activates its group, search and repository controls',
        groupCurrent === 'true' && searchValue === 'sketch' && repoValue === 'howarewoo/git-stacks',
        `group aria-current=${groupCurrent}, search=${searchValue}, repo=${repoValue}`,
      )

      const restoredRows = page.locator('.pr-inbox-item')
      check(
        'restored filter includes matching draft row and excludes other requests',
        (await restoredRows.count()) === 1 &&
          (await restoredRows.filter({ hasText: 'Sketch the Inbox group rail' }).count()) === 1 &&
          (await restoredRows.filter({ hasText: 'Charge every native-stack page' }).count()) ===
            0 &&
          (await restoredRows.filter({ hasText: 'Add a GitHub-derived PR Inbox' }).count()) === 0,
        `${await restoredRows.count()}`,
      )
      await page.screenshot({ path: join(shotDir, 'inbox-filter-after-restart.png') })
    } finally {
      if (secondBrowser) {
        activeBrowsers.delete(secondBrowser)
        await secondBrowser.close().catch(() => {})
      }
      await stop(second.app)
    }

    console.log(`SMOKE_ROOT ${root}`)
    console.log(`SMOKE_SHOTS ${shotDir}`)
    const failed = results.filter((r) => !r.ok).length
    console.log(`SMOKE_DONE ${results.length - failed}/${results.length} checks passed`)
    if (failed > 0) process.exitCode = 1
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
