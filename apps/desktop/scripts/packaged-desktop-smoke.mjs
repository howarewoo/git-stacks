#!/usr/bin/env node
/**
 * Packaged Git Stacks desktop smoke.
 *
 * Launches the real electron-builder output against a disposable environment (temporary Chromium
 * user data, temporary Git and gh configuration, temporary Git repository with a local bare
 * "remote") and drives the shipped renderer UI: packaging, window chrome, real 200% zoom,
 * sandbox/preload wiring, external-link guarding, captured Fetch, linked worktree creation,
 * and read-only Unicode file inspection. Every Git assertion is checked against the real `git`
 * binary on the disposable repository, never the app snapshot.
 *
 * The IPC boundary is exercised the same way: a second window this smoke owns, and the shipped
 * window's own main frame at a foreign origin, both send real requests through the shipped preload
 * bridge into the real `ipcMain` handlers, and are refused there while the authorized main frame
 * keeps answering.
 *
 * No production code or bundle edits: the runtime injections are the pre-main synthetic
 * credential fixture, a `shell.openExternal` patch, the hidden window the unauthorized-sender check
 * owns, and one foreign-origin document loaded into the app window's own frame at the end of the
 * run. The external-link call is issued only after its patch is proven in place.
 *
 * Credential sealing is fixture-synthetic: before the first production statement runs (the main
 * entry is held at `--inspect-brk`), the shared `tests/fixtures/isolated-desktop.cjs` installs its
 * fixture-owned AES-256-GCM `safeStorage` backend in place. The shipped bundle and packages are
 * byte-identical to the unsigned local development package; this is synthetic-store evidence only.
 * It claims no real OS-keychain acceptance and no signed-install behavior.
 *
 *   node scripts/packaged-desktop-smoke.mjs [--app <path>] [--timeout <seconds>] [--keep]
 */

import { deepStrictEqual } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { chromium, expect } from '@playwright/test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = 'packaged-smoke-fixture'
const FEATURE = 'packaged-smoke/feature'
const CONFLICT = 'conflict.txt'
const ORIGIN = 'app://git-stacks'
const UI_TIMEOUT = 20_000
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
        'Build one with "pnpm run package", or pass --app <path to the packaged app>.',
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
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'git-stacks-packaged-smoke-')))
  const workspace = {
    root,
    home: join(root, 'home'),
    userData: join(root, 'user-data'),
    temp: join(root, 'tmp'),
    repo: join(root, FIXTURE),
    origin: join(root, 'origin.git'),
    gitconfig: join(root, 'gitconfig'),
    // The one directory this run owns the contents of: the CLI the app is
    // allowed to start is the file written here and nothing else.
    bin: join(root, 'bin'),
    // A second CLI this run also writes, deliberately not in the owned
    // directory, so a launch that reached past the boundary would run this one
    // and leave a mark. Nothing on this machine can produce that mark.
    sentinel: join(root, 'sentinel-bin'),
    sentinelStamp: join(root, 'unowned-sentinel.log'),
    evidence: join(ROOT, 'out', 'packaged-smoke', new Date().toISOString().replace(/[:.]/g, '-')),
  }
  for (const directory of [
    workspace.bin,
    workspace.sentinel,
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

/**
 * The CLI this run writes outside its owned directory: a fallback that only runs
 * if a launch escapes the boundary, and whose whole behaviour is to leave a mark
 * saying so. It holds no account and answers nothing, and the machine's own gh
 * is never substituted for it.
 */
async function writeSentinelGh(workspace) {
  await writeFile(
    join(workspace.sentinel, 'gh'),
    [
      '#!/bin/sh',
      `printf 'sentinel %s\\n' "$*" >> ${JSON.stringify(workspace.sentinelStamp)}`,
      `printf 'gh version 0.0.0-sentinel\\n'`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
}

// Nothing the host shell exports may reach the app: git and gh state, GitHub credentials, any
// secret-shaped variable, the Node and Electron launch switches, and the SSH agent are dropped,
// and only fixture values are added back.
const UNSAFE_INHERITED =
  /^(GIT_|GH_|GITHUB_|GIT_STACKS_)|^NODE_OPTIONS$|^NODE_TLS_REJECT_UNAUTHORIZED$|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$|^SSH_AUTH_SOCK$|(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY)/iu

/**
 * macOS hands the packaged app the home directory the password database reports, and its sandboxed
 * helper processes are only spawned against that one: with HOME pointed at a synthetic directory
 * the browser process never finishes bringing those helpers up, and it stops answering on its own
 * DevTools endpoint, so no renderer can ever be attached. The smoke therefore inherits the host
 * home on macOS and keeps every path the app, git or gh actually reads or writes disposable.
 */
const INHERITED_HOME = process.platform === 'darwin'
const homeEnvironment = (workspace) => (INHERITED_HOME ? homedir() : workspace.home)

function environment(workspace, apiBase) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !UNSAFE_INHERITED.test(key)),
  )
  return {
    ...inherited,
    HOME: homeEnvironment(workspace),
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
    // This run's own bin directory leads PATH and the sentinel follows it, so a
    // launch that stepped past the process boundary would resolve the sentinel
    // and leave its mark instead of touching any account on this machine.
    PATH: [workspace.bin, workspace.sentinel, process.env.PATH ?? '']
      .filter(Boolean)
      .join(delimiter),
    // PATH alone cannot keep a packaged launch away from the machine's own CLI:
    // a Finder launch inherits none, and the production bootstrap adds the usual
    // installation directories back. The fixture's process boundary, installed
    // at the paused main entry, is what makes the CLI this run finds exclusively
    // the one it wrote - so "the CLI is missing" is an owned absence rather than
    // a PATH the app outgrew.
    GIT_STACKS_OWNED_GH_DIR: workspace.bin,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: workspace.gitconfig,
    ELECTRON_ENABLE_LOGGING: '1',
    // This run's own GitHub API, when it has one. The variable names an endpoint
    // and carries no credential, so it is the app's real request path being
    // observed rather than a credential being supplied.
    ...(apiBase ? { GIT_STACKS_GITHUB_API_URL: apiBase } : {}),
  }
}

/**
 * The GitHub CLI this run owns, written as a real executable on the PATH the app
 * is given, so the machine this executes on contributes no account of its own.
 *
 * It is not an echo of what it is asked: `auth token` answers with a credential
 * only this CLI holds, and `api` performs a real request to the endpoint the app
 * named, authenticated with whatever credential its own environment carries, and
 * prints the response the way `gh api --include` does. Every invocation is
 * appended to a log this run reads, so what the app asked is evidence too.
 */
/**
 * The GitHub API this run serves, so the app's real request path can be observed
 * rather than inferred. It answers the two shapes the primary path actually reads
 * — the authenticated account on `/user`, GraphQL data on `/graphql` — and
 * refuses anything else with the status GitHub would refuse it with, so a read
 * this run did not prepare for fails honestly instead of being answered by a
 * catch-all. Nothing here is GitHub, and no credential that reaches it came from
 * the machine. A request is recorded without its credential; the credential is
 * held in memory only, and is never written to a file or an assertion message.
 */
async function startApiDouble(workspace) {
  const requests = []
  const received = []
  const account = 'smoke-account'
  // Holds make a read in flight deterministic: while armed, every GraphQL
  // request waits for the release this run sends after the cancel it wants to
  // observe, so an expected cancellation always lands on a read that is
  // actually suspended on the provider.
  const held = []
  let holding = false
  const send = (response, status, body) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': status === 200 ? '4999' : '4998',
      'x-ratelimit-reset': '0',
    })
    response.end(JSON.stringify(body))
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const authorization = request.headers.authorization ?? null
    requests.push({
      method: request.method ?? '',
      path: url.pathname,
      authenticated: authorization !== null,
    })
    received.push(authorization)
    if (authorization === null) {
      send(response, 401, { message: 'Requires authentication', documentation_url: 'x' })
      return
    }
    // The account read is a REST read of `/user`, and answers with the shape
    // GitHub returns for it: a login and an id, not GraphQL data.
    if (request.method === 'GET' && url.pathname === '/user') {
      send(response, 200, { login: account, id: 1, type: 'User', name: 'Packaged Smoke' })
      return
    }
    if (request.method === 'POST' && url.pathname.endsWith('/graphql')) {
      if (holding) await new Promise((settle) => held.push(settle))
      send(response, 200, {
        data: {
          viewer: { login: account, id: 'U_kgDO' },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: '1970-01-01T00:00:00Z', cost: 1 },
        },
      })
      return
    }
    send(response, 404, { message: 'Not Found', documentation_url: 'x' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    /** The credentials this run's API received, in the order they arrived. */
    credentials: () => received,
    /** Arms the hold: every GraphQL request that follows suspends until release. */
    hold: () => {
      holding = true
    },
    /** Requests currently suspended inside the hold, not merely recorded. */
    suspended: () => held.length,
    release: () => {
      holding = false
      for (const settle of held.splice(0)) settle()
    },
    close: () => new Promise((resolve) => server.close(resolve)),
    workspace,
  }
}

/**
 * The GitHub CLI this run owns, written as a real executable on the PATH the app
 * is given, so the machine this executes on contributes no account of its own.
 *
 * It is not an echo of what it is asked. `auth status` answers with the JSON the
 * CLI itself writes — the account list under its host key — for a host this run
 * configured and no other; `auth token` answers with the synthetic credential it
 * holds; and `api` makes a real request to the endpoint the app named, with the
 * method, the headers and the request body the app supplied, and prints the
 * response the way `gh api --include` does, so a nonzero status leaves the API's
 * own answer on stdout exactly as the real CLI leaves it there.
 *
 * Nothing it writes records a credential: the invocation log and the request log
 * carry the arguments and the endpoint, and the credential travels only in the
 * request itself and in this run's own memory.
 */
async function writeControlledGh(workspace, { token, hosts, apiBase }) {
  const log = join(workspace.root, 'gh-invocations.log')
  const requests = join(workspace.root, 'gh-requests.log')
  const tokenFile = join(workspace.root, 'gh-token')
  const hostsFile = join(workspace.root, 'gh-hosts.json')
  const bodyFile = join(workspace.root, 'gh-request-body')
  await writeFile(tokenFile, `${token}\n`)
  // The shape `gh auth status --json hosts` actually writes: the account list is
  // under a host key, and each entry names the account as `login` — the field the
  // CLI's own `authEntry` marshals it from — so the app's parser sees what it
  // would see from the CLI itself rather than a map it would have to guess about.
  await writeFile(hostsFile, JSON.stringify({ hosts }))
  await writeFile(
    join(workspace.bin, 'gh'),
    [
      '#!/bin/sh',
      // Every invocation is recorded before it is answered, so what the app asked
      // is evidence even for a request this CLI refuses.
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      // The host the app addressed this read to, and whether this CLI holds an
      // account for it. A host this run never configured is refused rather than
      // answered with somebody else's account.
      'named_host() {',
      '  previous=""',
      '  for argument in "$@"; do',
      '    if [ "$previous" = "--hostname" ]; then printf "%s" "$argument"; return 0; fi',
      '    previous="$argument"',
      '  done',
      '  return 1',
      '}',
      'refused_host() {',
      '  if ! known_host "$1"; then printf "gh: no account for that host\\n" >&2; exit 1; fi',
      '}',
      'known_host() {',
      `  case "$1" in`,
      ...Object.keys(hosts).map((name) => `    ${name}) return 0 ;;`),
      '    *) return 1 ;;',
      '  esac',
      '}',
      // Whichever credential variable this host's CLI reads: the CLI-owned names
      // are not this run's business, and the one that is set is the one that
      // authenticates the request.
      'credential="${GH_TOKEN:-${GITHUB_TOKEN:-${GH_ENTERPRISE_TOKEN:-${GITHUB_ENTERPRISE_TOKEN:-}}}}"',
      'case "$1" in',
      "  --version) printf 'gh version 2.62.0\\n'; exit 0 ;;",
      '  auth)',
      '    case "$*" in',
      "      *--show-token*) printf 'gh: refusing to print a token\\n' >&2; exit 1 ;;",
      '    esac',
      '    case "$2" in',
      `      status) refused_host "$(named_host "$@" || printf github.com)"; cat ${JSON.stringify(hostsFile)}; exit 0 ;;`,
      `      token) refused_host "$(named_host "$@" || printf github.com)"; cat ${JSON.stringify(tokenFile)}; exit 0 ;;`,
      "      *) printf 'gh: unsupported auth subcommand\\n' >&2; exit 1 ;;",
      '    esac ;;',
      '  api)',
      '    endpoint=""',
      '    method="GET"',
      '    wants_input="no"',
      '    awaiting=""',
      '    for argument in "$@"; do',
      '      if [ -n "$awaiting" ]; then',
      '        if [ "$awaiting" = "--method" ]; then method="$argument"; fi',
      '        awaiting=""',
      '        continue',
      '      fi',
      '      case "$argument" in',
      "        --show-token) printf 'gh: refusing to print a token\\n' >&2; exit 1 ;;",
      '        --method|--hostname|--header) awaiting="$argument"; continue ;;',
      '        --include) continue ;;',
      '        --input) wants_input="yes"; awaiting="--input"; continue ;;',
      '        -*) printf "gh: unsupported api argument\\n" >&2; exit 1 ;;',
      '        *) endpoint="$argument" ;;',
      '      esac',
      '    done',
      '    if [ -z "$endpoint" ]; then printf "gh: no endpoint\\n" >&2; exit 1; fi',
      // An endpoint this run does not serve is refused: this CLI answers for the
      // API it was written against and nothing else.
      `    case "$endpoint" in`,
      `      ${JSON.stringify(apiBase)}/*) ;;`,
      '      *) printf "gh: endpoint this CLI does not serve\\n" >&2; exit 1 ;;',
      '    esac',
      '    body=""',
      // A body is read from this command\'s own input, and only when the request
      // asked for one: a read has no body, and waiting on input it will never be
      // given is how a request hangs.
      '    if [ "$wants_input" = "yes" ]; then',
      `      cat > ${JSON.stringify(bodyFile)}`,
      `      body=${JSON.stringify(bodyFile)}`,
      '    fi',
      `    printf 'api %s %s input=%s\\n' "$method" "$endpoint" "$wants_input" >> ${JSON.stringify(requests)}`,
      // This CLI is this run's own, and every request it makes goes to the loopback
      // server this run started. `--disable` is the first option on purpose: curl
      // otherwise reads the person's own ~/.curlrc, which can carry credentials,
      // proxies and directives that have nothing to do with this run. `--noproxy`
      // keeps a proxy directive out of a loopback request as well.
      '    if [ -n "$body" ]; then',
      '      curl --disable --noproxy \'*\' --silent --show-error --include --request "$method" --header "Authorization: Bearer $credential" --header "Accept: application/vnd.github+json" --header "Content-Type: application/json" --data-binary "@$body" "$endpoint"',
      '    else',
      '      curl --disable --noproxy \'*\' --silent --show-error --include --request "$method" --header "Authorization: Bearer $credential" --header "Accept: application/vnd.github+json" --header "Content-Type: application/json" "$endpoint"',
      '    fi',
      '    status=$?',
      '    rm -f "$body"',
      // The response is what the app reads, and its own status is this status.
      '    exit $status ;;',
      'esac',
      `printf 'gh: unsupported invocation\\n' >&2`,
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return log
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

  pauseAtEntry() {
    return new Promise((resolvePause, rejectPause) => {
      const finish = (error, paused) => {
        clearTimeout(timer)
        this.socket.removeEventListener('message', listener)
        if (error) rejectPause(error)
        else resolvePause(paused)
      }
      const listener = (event) => {
        const message = JSON.parse(event.data)
        if (message.method === 'Debugger.paused') finish(null, message.params)
      }
      const timer = setTimeout(() => finish(new Error('The main entry did not pause')), 30_000)
      timer.unref()
      this.socket.addEventListener('message', listener)
      this.send('Debugger.enable')
        .then(() => this.send('Runtime.runIfWaitingForDebugger'))
        .catch((error) => finish(error))
    })
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

  /** A paused entry needs synchronous frame evaluation, not a promise-backed runtime call. */
  async callPaused(callFrameId, source, ...args) {
    const expression = `(${source})(${args.map((arg) => JSON.stringify(arg ?? null)).join(',')})`
    const response = await this.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression,
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
    if (Module) return Module.createRequire(process.execPath)('electron')
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
  env: {
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    // The host home is inherited on macOS, so the git configuration the app reads is proved here
    // rather than assumed: both values have to point away from the machine's own configuration.
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    // The two this run names for itself, read back rather than tolerated: each has
    // to still point at the CLI this run wrote and the API this run stood up.
    GIT_STACKS_OWNED_GH_DIR: process.env.GIT_STACKS_OWNED_GH_DIR,
    GIT_STACKS_GITHUB_API_URL: process.env.GIT_STACKS_GITHUB_API_URL,
  },
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
else if (action === 'focus') { window.show(); window.focus() }
else if (action !== 'read') throw new Error('Unknown window action ' + action)
const visibilityState = window.webContents
  ? await window.webContents.executeJavaScript('document.visibilityState')
  : null
return {
  minimized: window.isMinimized(),
  maximized: window.isMaximized(),
  fullScreen: window.isFullScreen(),
  visible: window.isVisible(),
  visibilityState,
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

/**
 * Read-only bridge calls, run inside whichever renderer's own document is under test. Each call
 * resolves with either its value or the refusal main answered with, so the caller sees the real
 * boundary result and never has to infer it.
 */
const READ_ONLY_PROBE = `(async () => {
  const report = async (label, call) => {
    try {
      return { label, resolved: true, value: (await call()) ?? null }
    } catch (error) {
      return {
        label,
        resolved: false,
        message: String(error?.message ?? error),
        name: error?.name ?? null,
        cancelled: error?.cancelled === true,
      }
    }
  }
  return {
    href: location.href,
    bridge: typeof window.desktop?.recentRepositories,
    calls: [
      await report('recentRepositories', () => window.desktop.recentRepositories()),
      await report('worktreeInventory', () => window.desktop.worktreeInventory({ requestId: 'sender-inventory-smoke' })),
      await report('refresh', () => window.desktop.refresh()),
      await report('prIndexRefresh', () => window.desktop.prIndex({ refresh: true })),
    ],
  }
})()`

/**
 * A document with no path, no file and no privilege behind it, loaded into the app window's own
 * main frame so the sender and its frame are genuinely the app's own and only the origin differs.
 */
const FOREIGN_DOCUMENT = `data:text/html,${encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>foreign origin</title><p>foreign origin</p>',
)}`

/**
 * open | probe | close for the window this smoke owns.
 *
 * The window is created in the main process that shipped the app, with the shipped preload and the
 * same webPreferences the shipped window uses, and it loads the same app:// document. Its requests
 * therefore cross the real ipcMain boundary as a second webContents holding the trusted origin:
 * nothing here patches, wraps or re-implements the sender guard under test, and the window is
 * destroyed again before the check returns.
 */
const MAIN_UNTRUSTED = mainScript(
  'action, origin',
  `const { BrowserWindow, app } = resolveElectron()
const fs = process.getBuiltinModule('node:fs')
const nodePath = process.getBuiltinModule('node:path')
const probeSource = ${JSON.stringify(READ_ONLY_PROBE)}
const store = (globalThis.__packagedSmokeUntrusted ??= {})
const open = () => (store.window && !store.window.isDestroyed() ? store.window : null)
if (action === 'close') {
  const window = open()
  if (window) window.destroy()
  delete globalThis.__packagedSmokeUntrusted
  return true
}
if (action === 'probe') {
  const window = open()
  if (!window) throw new Error('The unauthorized window is not open')
  const contents = window.webContents
  const deadline = Date.now() + 15000
  while (contents.isLoading() && Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 100))
  }
  const report = await contents.executeJavaScript(probeSource)
  return {
    ...report,
    loading: contents.isLoading(),
    senderId: contents.id,
    appId: store.appId ?? null,
    appUrl: store.appUrl ?? null,
    windows: BrowserWindow.getAllWindows().length,
  }
}
if (action !== 'open') throw new Error('Unknown unauthorized-window action ' + action)
const previous = open()
if (previous) previous.destroy()
// The shipped window is identified while it is the only one, so the probe never has to guess which
// of the two windows a URL belongs to.
const shipped = BrowserWindow.getAllWindows().find(
  (entry) => entry.webContents.getURL().startsWith(origin),
)
if (!shipped) throw new Error('The packaged app window is not on ' + origin)
store.appId = shipped.webContents.id
store.appUrl = shipped.webContents.getURL()
const preload = nodePath.join(app.getAppPath(), 'out', 'preload', 'index.cjs')
if (!fs.existsSync(preload)) throw new Error('The shipped preload is missing at ' + preload)
store.window = new BrowserWindow({
  show: false,
  title: 'Git Stacks untrusted sender',
  webPreferences: {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  },
})
await store.window.webContents.loadURL(origin + '/index.html')
return { preload, visible: store.window.isVisible(), url: store.window.webContents.getURL() }`,
)

/**
 * Loads a foreign-origin document in the shipped window's own main frame.
 *
 * `webContents.loadURL` is a main-process capability that the renderer's navigation guards do not
 * cover, so it is the only way to reach the app window at an origin the renderer itself can never
 * obtain. The sender and its frame are then genuinely the app's own, which is what leaves the
 * origin check as the only thing standing between that document and every handler.
 */
const MAIN_FOREIGN_ORIGIN = mainScript(
  'origin, url',
  `const { BrowserWindow } = resolveElectron()
const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith(origin))
if (!window) throw new Error('The packaged app window is not on ' + origin)
const contents = window.webContents
const contentsIdBefore = contents.id
await contents.loadURL(url)
return {
  url: contents.getURL(),
  contentsIdBefore,
  contentsIdAfter: contents.id,
  frames: contents.mainFrame.frames.length,
}`,
)

/**
 * Reads every child frame the shipped window actually has, from the main process that owns them.
 *
 * A renderer can only read a frame it is same-origin with, so the parent's own view of a child
 * frame proves nothing; the main process has no such restriction. Each frame is asked what it
 * actually holds rather than what was requested for it, because a frame whose navigation was
 * refused still carries the requested URL.
 */
const MAIN_CHILD_FRAMES = mainScript(
  'origin',
  `const { BrowserWindow } = resolveElectron()
const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith(origin))
if (!window) throw new Error('The packaged app window is not on ' + origin)
const report = []
for (const frame of window.webContents.mainFrame.frames) {
  const inside = await frame.executeJavaScript(
    '({ href: location.href, state: document.readyState, desktop: typeof window.desktop, scripts: document.querySelectorAll("script").length })',
  )
  report.push({ name: frame.name, requested: frame.url, ...inside })
}
return { frames: report }`,
)

function launch(target, workspace, apiBase) {
  const logStream = createWriteStream(join(workspace.evidence, 'packaged-app.log'))
  if (process.env.ELECTRON_DISABLE_SANDBOX === '1') {
    note(
      'Caller explicitly set ELECTRON_DISABLE_SANDBOX=1: OS process sandbox is disabled and unverified; smoke checks cover configured renderer preferences, CSP, context isolation, and preload boundaries only.',
    )
  }
  const child = spawn(
    target.executable,
    [
      '--inspect-brk=0',
      '--remote-debugging-port=0',
      // The mock Chromium key store and the plaintext password store are forced
      // from startup, so the packaged app never touches the OS keychain while
      // the inspector installs the synthetic sealing backend.
      '--use-mock-keychain',
      '--password-store=basic',
      `--user-data-dir=${workspace.userData}`,
    ],
    {
      env: environment(workspace, apiBase),
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

/**
 * The app-owned files a refused request must leave exactly as they were, read as bytes so that any
 * write at all is visible rather than only a value the app itself would notice.
 */
function protectedState(userData) {
  const graphDirectory = join(userData, 'graph-preferences')
  const graphFiles = existsSync(graphDirectory)
    ? readdirSync(graphDirectory)
        .sort()
        .map((name) => join('graph-preferences', name))
    : []
  return ['repositories.json', 'settings.json', ...graphFiles]
    .map((name) => {
      const path = join(userData, name)
      return existsSync(path)
        ? `${name}=${readFileSync(path).toString('base64')}`
        : `${name}=absent`
    })
    .join('|')
}

/**
 * What the app's own main frame has to see before any repository is open: the recents read answered
 * by its handler, and a refresh refused by the handler's own precondition rather than by the guard.
 */
function assertAuthorized(report, context) {
  assertEqual(report.bridge, 'function', `The shipped window lost its preload bridge (${context})`)
  const read = report.calls.find((call) => call.label === 'recentRepositories')
  assert(
    read.resolved,
    `${context}: the authorized frame could not read the recents: ${read.message}`,
  )
  assertEqual(read.value.length, 1, `${context}: the authorized recents were not the seeded one`)
  const refresh = report.calls.find((call) => call.label === 'refresh')
  assert(
    !refresh.resolved && /Open a local Git repository/.test(refresh.message),
    `${context}: an authorized request never reached a handler body: ${refresh.message}`,
  )
}

/**
 * What a document the guard refuses has to see for every call: no value, the guard's own refusal,
 * and never a handler precondition, which would mean the request reached the body behind the guard.
 */
function assertRefused(report, refusal) {
  for (const call of report.calls) {
    assert(
      !call.resolved,
      `A refused document was answered by ${call.label}: ${JSON.stringify(call.value)}`,
    )
    assert(refusal.test(call.message), `${call.label} was refused with "${call.message}"`)
    assert(
      !/Open a local Git repository/.test(call.message),
      `${call.label} reached its handler body: ${call.message}`,
    )
  }
}

/**
 * Gives three child frames of the app document a chance to load a document and leaves them there,
 * so the main process can inspect them from outside the page, then reports what the parent can read.
 *
 * The parent's view is only part of the evidence: a frame the document is not same-origin with
 * throws on property access, and that frame is reported as unreadable rather than counted as safe.
 */
async function startSubframes(page) {
  return page.evaluate(async () => {
    const frames = ['index.html', 'about:blank', 'data:text/html,<p>subframe</p>'].map(
      (src, index) => {
        const frame = document.createElement('iframe')
        frame.name = `packaged-smoke-subframe-${index}`
        frame.setAttribute('src', src)
        frame.setAttribute('aria-hidden', 'true')
        frame.dataset.packagedSmokeSubframe = 'true'
        document.body.append(frame)
        return frame
      },
    )
    await new Promise((settle) => setTimeout(settle, 1500))
    return frames.map((frame) => {
      const entry = {
        name: frame.name,
        src: frame.getAttribute('src'),
        bridge: 'unreadable',
        url: 'unreadable',
      }
      try {
        // contextBridge publishes an object, so a frame holding it reports 'object' here, not
        // 'function'. Reading the URL is a second, separate step because it throws cross-origin.
        entry.bridge = typeof frame.contentWindow?.desktop
        try {
          entry.url = frame.contentWindow?.location.href ?? null
        } catch {
          entry.url = 'cross-origin'
        }
      } catch (error) {
        entry.bridge = `blocked:${error.name}`
      }
      return entry
    })
  })
}

/** Removes every frame the subframe probe added, so the renderer is left as it was found. */
async function stopSubframes(page) {
  await page.evaluate(() => {
    for (const frame of document.querySelectorAll('iframe[data-packaged-smoke-subframe]')) {
      frame.remove()
    }
  })
}

function ui(page) {
  return {
    page,
    nav: (label) =>
      page.locator('.bw-sidebar').getByRole('button', { name: new RegExp(`^${label}`) }),
  }
}

async function gotoView(locators, label) {
  const target = locators.nav(label)
  await target.waitFor()
  if ((await target.getAttribute('aria-current')) !== 'page') await target.click()
}

async function capturedContext(page, repositoryPath) {
  return page.evaluate(
    (path) =>
      new Promise((resolve, reject) => {
        let settled = false
        let unsubscribe
        let last = null
        const finish = (error, context) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribe?.()
          if (error) reject(error)
          else resolve(context)
        }
        const consume = (inventory) => {
          last = inventory
          if (settled) return
          const repository = inventory.repositories.find((repo) =>
            repo.worktrees.some((tree) => tree.path === path),
          )
          const tree = repository?.worktrees.find((tree) => tree.path === path)
          if (!repository || !tree) return
          finish(null, {
            repositoryId: repository.identity.id,
            worktreeId: tree.id,
            ...(tree.refId ? { refId: tree.refId } : {}),
          })
        }
        const timer = setTimeout(() => {
          // Only this run's own data: the requested fixture path, the
          // registrations the last observed inventory actually held, and its
          // recorded failures, so the failing acquisition is distinguishable
          // and the fixture state is visible without a rerun.
          const registrations =
            last && Array.isArray(last.repositories) && last.repositories.length > 0
              ? JSON.stringify(
                  last.repositories.map((repo) => ({
                    identity: repo.identity?.id ?? null,
                    registeredPaths: repo.registeredPaths ?? null,
                  })),
                )
              : 'none'
          const failures =
            last && Array.isArray(last.failures) && last.failures.length > 0
              ? JSON.stringify(last.failures)
              : 'none'
          finish(
            new Error(
              `Exact owned fixture directory ${path} was not discovered within 20 seconds. ` +
                `The last observed inventory registered ${registrations}, with failures ${failures}.`,
            ),
          )
        }, 20_000)
        try {
          unsubscribe = window.desktop.onWorktreeInventory(consume)
          window.desktop
            .worktreeInventory({ requestId: 'packaged-captured-context' })
            .then(consume, (error) => {
              // The shipped preload rejects a cancelled command with the
              // plain bridge-safe answer; anything else is a real failure.
              if (
                typeof error?.cancelled === 'boolean' &&
                error?.cancelled === true &&
                error?.name === 'CommandCancelled'
              )
                return
              finish(error)
            })
        } catch (error) {
          finish(error)
        }
      }),
    repositoryPath,
  )
}

async function openCliSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'GitHub CLI', exact: true })
    .click()
  return dialog
}

const viewport = (page) =>
  page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scale: window.visualViewport ? Number(window.visualViewport.scale.toFixed(3)) : null,
    devicePixelRatio: window.devicePixelRatio,
    shell: Math.round(document.querySelector('.bw-app')?.getBoundingClientRect().width ?? 0),
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
  let api = null
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
      await api?.close()
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
    // The CLI this run does not own, written before the app is launched: a launch
    // that stepped past the process boundary would resolve it on PATH and leave
    // its mark, and nothing on this machine can produce that mark.
    await writeSentinelGh(workspace)
    api = await startApiDouble(workspace)

    await check(
      'the PATH this run gives the app really does reach a CLI it does not own',
      async () => {
        // The empty directory leads PATH and the sentinel follows it, so with no
        // CLI of this run's own installed the operating system resolves the
        // sentinel. That is what makes the end-of-run assertion about the sentinel
        // mean something: the sentinel was reachable, and only the process boundary
        // kept the app out of it.
        const found = spawnSync('/bin/sh', ['-c', 'command -v gh'], {
          env: environment(workspace, api.base),
          encoding: 'utf8',
        })
        assertEqual(
          found.stdout.trim(),
          join(workspace.sentinel, 'gh'),
          'the PATH this run gives the app does not fall through to a CLI it does not own',
        )
        return `with no owned CLI installed, the PATH this run hands the app resolves gh to ${join(workspace.sentinel, 'gh')}`
      },
    )
    const canonicalRepo = realpathSync(workspace.repo)
    // Constants later scenarios share: the second registered repository is the
    // provider-backed read target (the primary keeps its disposable local
    // origin), and the controlled CLI's credentials are named once, since the
    // cancellation scenario must re-arm the CLI the credential check retires.
    const recordsSecond = join(workspace.root, 'records-second-Ω')
    const smokeCredentials = [
      'gho_smoke_credential_0000000000000000000000000000000000',
      'gho_smoke_credential_1111111111111111111111111111111111',
    ]
    app = launch(target, workspace, api.base)
    inspector = await Cdp.open(
      await endpoint(app, 'inspector', deadline, 'a main-process inspector endpoint'),
    )
    const paused = await inspector.pauseAtEntry()
    log(`paused main entry  : ${paused.reason}`)
    // The entry pause (--inspect-brk) means no production statement has run
    // yet. Install the synthetic sealing backend and the owned-CLI process
    // boundary through the same shared helper the dev-main fixture uses, then
    // resume the app. The boundary is installed here, at the entry this packaged
    // launch actually reaches, because requiring the helper is not installing it:
    // without this the app would resolve the machine's own CLI through the
    // installation directories the production bootstrap appends to PATH.
    const fixtureRoot = join(workspace.root, 'credential-fixture')
    const installed = await inspector.callPaused(
      paused.callFrames[0].callFrameId,
      (helperPath, root) =>
        (() => {
          const Module = process.getBuiltinModule ? process.getBuiltinModule('module') : null
          const resolveElectronModule = () => {
            if (typeof require === 'function') {
              try {
                return require('electron')
              } catch {}
            }
            if (process.mainModule && typeof process.mainModule.require === 'function') {
              try {
                return process.mainModule.require('electron')
              } catch {}
            }
            if (Module && Module.createRequire) {
              return Module.createRequire(process.execPath)('electron')
            }
            throw new Error('electron unavailable')
          }
          const createRequireFn = Module?.createRequire?.bind(Module)
          if (!createRequireFn) throw new Error('module.createRequire unavailable')
          const requireFromMain = createRequireFn(process.execPath)
          const helper = requireFromMain(helperPath)
          const electron = resolveElectronModule()
          helper.installIsolatedSafeStorage({
            electron,
            keyFile: `${root}/synthetic-key.bin`,
            fixtureRoot: root,
          })
          // Before the production main is imported, and before it can hold a
          // reference to a spawn function: this is the child's own boundary.
          helper.installOwnedProviderCliBoundary(root)
          return true
        })(),
      join(ROOT, 'tests', 'fixtures', 'isolated-desktop.cjs'),
      fixtureRoot,
    )
    assert(installed === true, 'The synthetic credential fixture failed to install')
    await inspector.send('Debugger.resume')
    const devtools = await endpoint(app, 'devtools', deadline, 'a renderer DevTools endpoint')
    page = await connectRenderer(devtools)
    page.on('pageerror', (error) => log(`  [renderer:error] ${error.message}`))
    let locators = ui(page)
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
      assertEqual(
        probe.env.HOME,
        homeEnvironment(workspace),
        INHERITED_HOME
          ? 'The macOS app did not inherit the host home its helper processes are spawned against'
          : 'The app inherited a HOME outside the workspace',
      )
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
        probe.env.GIT_CONFIG_GLOBAL,
        workspace.gitconfig,
        'git was not pointed at the disposable global configuration',
      )
      assertEqual(
        probe.env.GIT_CONFIG_NOSYSTEM,
        '1',
        'git was left able to read the host system configuration',
      )
      assertEqual(
        readFileSync(workspace.gitconfig, 'utf8'),
        '',
        'The disposable git configuration is not empty',
      )
      assertEqual(
        probe.secretKeys.join(','),
        '',
        `Credential-shaped variables reached the app: ${probe.secretKeys.join(', ')}`,
      )
      const unexpected = probe.gitEnvKeys.filter(
        (key) =>
          !/^(GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GH_CONFIG_DIR|GH_PROMPT_DISABLED|GIT_STACKS_OWNED_GH_DIR|GIT_STACKS_GITHUB_API_URL)$/u.test(
            key,
          ),
      )
      assertEqual(
        unexpected.join(','),
        '',
        `Unexpected git or gh variables reached the app: ${unexpected.join(', ')}`,
      )
      // The two this run names itself are not inherited state and are not left
      // merely tolerated: each one has to still be pointing at the CLI this run
      // wrote and the API this run stood up, so a variable that arrived from
      // outside cannot hide behind a name this run also uses.
      assertEqual(
        probe.env.GIT_STACKS_OWNED_GH_DIR,
        workspace.bin,
        'The app was not fenced to the GitHub CLI this run wrote',
      )
      assertEqual(
        probe.env.GIT_STACKS_GITHUB_API_URL,
        api === null ? '' : api.base,
        'The app was not pointed at the API this run stood up',
      )
      note(
        `Inherited GIT_*/GH_*/GITHUB_* state, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, and SSH_AUTH_SOCK are dropped; git reads only the empty ${workspace.gitconfig} (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL set), so the host home it inherits carries no identity, credential helper or include directive into the fixture.`,
      )
      // macOS spawns the app's sandboxed helpers against the home directory the password database
      // reports, so that one is inherited and the app reads nothing from it: userData stays the
      // only app-level path the smoke owns, and git and gh are held to the workspace by
      // GIT_CONFIG_NOSYSTEM, the empty GIT_CONFIG_GLOBAL, and GH_CONFIG_DIR.
      note(
        `macOS kept HOME=${probe.env.HOME}, app.getPath("home")=${probe.home} and app.getPath("temp")=${probe.temp}; the app reads none of them.`,
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
      return `${window.bounds.width}x${window.bounds.height}, ${chrome}`
    })

    await check(
      'native window state follows minimize/restore and maximize/unmaximize',
      async () => {
        // Chromium DevTools Protocol keeps inspected renderers in the foreground to prevent
        // background throttling during debugging. Disconnecting Playwright during the minimize
        // check allows the renderer Page Visibility API to transition to hidden naturally.
        await page.context().browser().close()

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
        assertEqual(minimized.minimized, true, 'The window did not report minimized=true')
        await state('read', 'visibilityState', 'hidden')
        const restored = await state('restore', 'minimized', false)
        assertEqual(
          restored.minimized,
          false,
          'The window did not report minimized=false after restore',
        )
        await state('read', 'visibilityState', 'visible')
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

        // Reconnect Playwright renderer connection for subsequent UI smoke steps
        page = await connectRenderer(devtools)
        page.on('pageerror', (error) => log(`  [renderer:error] ${error.message}`))
        locators = ui(page)
        assertEqual(
          await page.evaluate(() => document.visibilityState),
          'visible',
          'The restored renderer document.visibilityState was not visible through DevTools',
        )
        // The state is driven through Electron's own window API on the smoke-owned window.
        // No other application is touched, and the title-bar buttons are not physically clicked, so
        // pointer hit-testing and VoiceOver on the native controls stay a manual pass.
        note(
          'Window state was driven through the Electron BrowserWindow API on the smoke-owned window; the native title-bar buttons were not clicked and were not read through macOS accessibility.',
        )
        return `minimize -> minimized (document hidden), restore -> unminimized (document visible), maximize ${before.bounds.width}x${before.bounds.height} -> ${maximized.bounds.width}x${maximized.bounds.height}, unmaximize -> ${unmaximized.bounds.width}x${unmaximized.bounds.height}`
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
          await page.locator('.bw-brand').isVisible(),
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
      // actually works is proved by the captured Fetch, linked worktree and
      // read-only inspection steps below, which assert real repository state.
      for (const [key, value] of Object.entries(renderer.types)) {
        assertEqual(value, 'function', `window.desktop.${key} is not callable`)
      }
      return `sandbox with context isolation, ${renderer.api.length} bridged methods, no Node globals in the page world`
    })

    // The authorized frame answers first, so a refusal below can only come from the sender guard:
    // the same preload, in the same main process, is proved to reach the handler bodies.
    await check('IPC from an unauthorized sender is refused at the real boundary', async () => {
      const authorized = await page.evaluate(READ_ONLY_PROBE)
      assertAuthorized(authorized, 'before the unauthorized sender')
      const protectedBefore = protectedState(probe.userData)
      const opened = await inspector.call(MAIN_UNTRUSTED, 'open', ORIGIN)
      assertEqual(opened.visible, false, 'The unauthorized sender window was shown on screen')
      let unauthorized
      try {
        unauthorized = await inspector.call(MAIN_UNTRUSTED, 'probe', ORIGIN)
        assert(
          typeof unauthorized.senderId === 'number' &&
            unauthorized.appId !== null &&
            unauthorized.senderId !== unauthorized.appId,
          `The unauthorized window is the shipped window (webContents ${unauthorized.senderId} against ${unauthorized.appId})`,
        )
        assert(unauthorized.loading === false, 'The unauthorized document never finished loading')
        assert(
          unauthorized.windows >= 2,
          `The main process held ${unauthorized.windows} window, so no second sender existed`,
        )
        assertEqual(
          unauthorized.bridge,
          'function',
          'The unauthorized document ran without the shipped preload bridge',
        )
        assert(
          unauthorized.href.startsWith(`${ORIGIN}/`),
          `The unauthorized document is ${unauthorized.href}, not the app origin`,
        )
        assertEqual(
          unauthorized.appUrl.startsWith(`${ORIGIN}/`),
          true,
          'The shipped window is no longer on the app origin',
        )
        assertRefused(unauthorized, /Untrusted application request\.?/u)
      } finally {
        await inspector.call(MAIN_UNTRUSTED, 'close', ORIGIN)
      }
      assertEqual(
        protectedState(probe.userData),
        protectedBefore,
        'A refused request changed the app-owned files',
      )
      assertAuthorized(await page.evaluate(READ_ONLY_PROBE), 'after the refusal')
      return `webContents ${unauthorized.senderId} on ${ORIGIN} was refused by the shipped main process (preload ${opened.preload}) while webContents ${unauthorized.appId} kept answering, and the app-owned files are unchanged`
    })

    await check('no subframe of the app window can reach the preload bridge', async () => {
      const holdsBridge = (desktop) => desktop === 'object' || desktop === 'function'
      const parentView = await startSubframes(page)
      let children
      try {
        assertEqual(parentView.length, 3, 'The subframe probe did not run every attempt')
        // The parent's view stops at its own origin, so every child frame is read again from the
        // main process, which asks the frame itself what it holds rather than what was requested.
        children = await inspector.call(MAIN_CHILD_FRAMES, ORIGIN)
      } finally {
        await stopSubframes(page)
      }
      const describe = (frame) =>
        `requested ${frame.requested ?? frame.src}, holds ${frame.href ?? frame.url} (${frame.state ?? 'unknown'}, ${frame.scripts ?? '?'} scripts, desktop ${frame.desktop ?? frame.bridge})`
      const frames = [
        ...parentView.map((frame) => ({
          src: frame.src,
          href: frame.url,
          state: 'unknown',
          scripts: '?',
          desktop: frame.bridge,
        })),
        ...children.frames,
      ]
      const evidence = frames.map(describe).join('; ')
      assertEqual(
        children.frames.length,
        parentView.length,
        `The main-process inspection did not cover every frame attempt: ${evidence}`,
      )
      for (const frame of parentView) {
        assertEqual(
          children.frames.filter((child) => child.name === frame.name).length,
          1,
          `The main-process inspection did not uniquely observe ${frame.name}: ${evidence}`,
        )
        assert(
          !holdsBridge(frame.bridge),
          `The app document reached a preload bridge in its ${frame.src} frame: ${evidence}`,
        )
      }
      for (const frame of children.frames) {
        assertEqual(
          frame.desktop,
          'undefined',
          `A child frame did not prove preload bridge absence: ${evidence}`,
        )
        assert(
          !frame.href.startsWith(`${ORIGIN}/`),
          `A child frame of the app window loaded an app document: ${evidence}`,
        )
      }
      // No child frame of the shipped window holds an ipcRenderer, so the guard's frame clause has
      // nothing to reject: this run measures that unavailability, it does not refuse a frame.
      note(
        'Subframe sender rejection is measured as unreachable rather than as a refused call: CSP frame-src none, the will-frame-navigate and will-attach-webview guards, and nodeIntegrationInSubFrames=false mean no child frame of the shipped window ever holds ipcRenderer.',
      )
      return `${parentView.length} frame attempts produced ${children.frames.length} child frame(s) in the app window, none holding the preload bridge: ${evidence}`
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

    await check(
      'the disposable repository is selected through the actual Workbench sidebar without checkout',
      async () => {
        const entry = page.locator('.bw-repo').first()
        await entry.waitFor()
        assertEqual(
          await entry.getAttribute('title'),
          canonicalRepo,
          'Qualified sidebar fixture path',
        )
        await entry.click()
        await page.getByRole('main', { name: 'Branch workbench', exact: true }).waitFor()
        const context = await capturedContext(page, canonicalRepo)
        const opened = await page.evaluate(
          async (context) => (await window.desktop.inspect(context, 'refresh', [])).path,
          context,
        )
        assertEqual(opened, canonicalRepo, 'Captured selected repository path')
        assertEqual(head(workspace), 'main', 'Selection changed Git HEAD')
        assertEqual(porcelain(workspace), '', 'Selection changed the index or directory')
        return `actual sidebar and captured inspection selected ${opened} without checkout`
      },
    )

    await check('GitHub stays unavailable without a CLI, and local Git still works', async () => {
      // This run owns the CLI on PATH and has not written one yet, so the machine
      // this executes on cannot contribute an account of its own. The API it is
      // pointed at is this run's own, and is reachable: what is missing is the
      // CLI, so nothing can be asked for a credential with which to reach it.
      await gotoView(locators, 'Pull requests')
      const absent = await page.evaluate(async () => await window.desktop.githubCliStatus())
      assertEqual(
        absent === null ? 'none' : absent.state,
        'missing-cli',
        'A machine with no GitHub CLI on its PATH reports that, and not an account',
      )
      assertEqual(
        absent === null ? 'none' : absent.login,
        null,
        'A machine with no CLI names no account, rather than inheriting one',
      )
      assertEqual(
        api.requests.length,
        0,
        'The app reached its API without a CLI to authenticate the request with',
      )
      const context = await capturedContext(page, canonicalRepo)
      const pullRequests = await page.evaluate(
        async (context) => (await window.desktop.inspect(context, 'refresh', [])).pullRequests,
        context,
      )
      assertEqual(
        pullRequests.length,
        0,
        'Pull requests appeared without an authenticated gh session',
      )
      const dialog = await openCliSettings(page)
      await expect(dialog.getByRole('region', { name: 'GitHub CLI' })).toContainText(
        'not installed',
      )
      await page.keyboard.press('Escape')
      await gotoView(locators, 'Branches')
      assertEqual(
        git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']),
        'main',
        'Local Git after no CLI',
      )
      return 'no CLI on this machine, GitHub unavailable, and local Git unaffected'
    })

    await check('the real API path runs on the credential this CLI holds', async () => {
      const first = smokeCredentials[0]
      const second = smokeCredentials[1]
      // The host this run serves its API from is the host the app decides first:
      // a configured base outranks the host a repository names, because the CLI
      // is sent to that base and authenticates as whoever serves it. The account
      // this CLI holds therefore belongs to that host, and a request to any other
      // host is refused rather than answered with this account.
      const apiHost = new URL(api.base).host
      const log = await writeControlledGh(workspace, {
        token: first,
        apiBase: api.base,
        hosts: {
          [apiHost]: [
            {
              state: 'success',
              active: true,
              host: apiHost,
              login: 'smoke-account',
            },
          ],
        },
      })
      const statusOf = () =>
        page.evaluate(async () => {
          const status = await window.desktop.githubCliStatus()
          return status === null ? null : { ...status }
        })
      try {
        // A real read: the CLI is asked what account it holds, and that account's
        // own authenticated request to this run's API has to answer before this
        // window is told anyone is signed in.
        const firstRead = await statusOf()
        assertEqual(firstRead?.state, 'authenticated', 'the first status this window received')
        assertEqual(firstRead?.login, 'smoke-account', 'the account the CLI named')
        // The account is proved against the host that serves this run's API, and
        // published under the host this repository names: which host the CLI is
        // asked about and which host the answer belongs to are two different
        // questions, and a base in between is exactly why.
        assertEqual(firstRead?.host, 'github.com', 'the host the status was published for')
        assert(firstRead?.identity, 'a proven credential has an identity to fence on')
        assert(
          api.credentials().some((credential) => credential === `Bearer ${first}`),
          `The API never received the credential this CLI holds (${api.requests.length} requests reached it)`,
        )

        // A credential replaced in the CLI, outside this app, with no status
        // pushed and nothing rebuilt: the next read proves the new one, and the
        // identity that fences rows moves with it.
        await writeFile(join(workspace.root, 'gh-token'), `${second}\n`)
        const secondRead = await statusOf()
        assertEqual(
          secondRead?.state,
          'authenticated',
          'a credential replaced in the CLI still proves itself',
        )
        assert(
          secondRead?.identity !== firstRead.identity,
          'A credential replaced in the CLI did not change the identity rows are fenced on',
        )
        assert(
          api.credentials().some((credential) => credential === `Bearer ${second}`),
          `The API never received the replacement credential (${api.requests.length} requests reached it)`,
        )
        // The window is told what it may act on and nothing else: this CLI
        // refuses to print a token, so an app that asked for one would have got
        // a failure rather than a credential.
        const asked = readFileSync(log, 'utf8')
        assert(!asked.includes('--show-token'), `The app asked the CLI to show its token: ${asked}`)
        for (const published of [firstRead, secondRead]) {
          const text = JSON.stringify(published)
          for (const secret of [/gh[pousr]_[A-Za-z0-9]+/u, /Bearer\s/iu]) {
            assert(!secret.test(text), `The status carried credential-shaped text: ${text}`)
          }
        }
        // The current consumer is the shared GitHub CLI section in Settings.
        const dialog = await openCliSettings(page)
        await dialog.waitFor()
        assert(
          (await dialog.innerText()).includes('smoke-account'),
          `The GitHub CLI status dialog did not name the account it read: ${await dialog.innerText()}`,
        )
        await page.keyboard.press('Escape')

        await check('trusted PR index refresh rejects malformed options', async () => {
          for (const options of [
            null,
            {},
            { refresh: 'yes' },
            { refresh: true, repository: 'foreign' },
          ]) {
            const refusal = await page.evaluate(async (value) => {
              try {
                return { resolved: true, value: await window.desktop.prIndex(value) }
              } catch (error) {
                return { resolved: false, message: String(error.message) }
              }
            }, options)
            assert(
              !refusal.resolved &&
                /PR index options must contain only a boolean refresh flag/.test(refusal.message),
              'Malformed PR index refresh options were not refused by the trusted handler',
            )
          }
          return 'null, missing flag, non-boolean flag and renderer authority fields refused'
        })
      } finally {
        // Removing the controlled executable is the fault injection: the fixture
        // answers any `gh` that is not it with ENOENT, exactly as a machine
        // without the CLI would, and records the attempt.
        await rm(join(workspace.bin, 'gh'), { force: true })
      }
      const retired = await statusOf()
      assertEqual(
        retired?.state,
        'missing-cli',
        'Removing the owned CLI retires authenticated status',
      )
      assertEqual(retired?.login, null, 'Removing the owned CLI retires the authenticated account')
      // The removal above served the retirement proof; every later read runs
      // against the CLI this run started with, restored to the credential it
      // ended holding. Both host names this run routes (the configured API
      // base's own host and the dotcom host that base serves for) are
      // configured again so provider reads answer through and only this CLI.
      await writeControlledGh(workspace, {
        token: second,
        apiBase: api.base,
        hosts: {
          [apiHost]: [{ state: 'success', active: true, host: apiHost, login: 'smoke-account' }],
          'github.com': [
            { state: 'success', active: true, host: 'github.com', login: 'smoke-account' },
          ],
        },
      })
      return 'the CLI status came from a real authenticated request, and a replaced credential moved the identity'
    })

    await check('fetch transfers the published commit', async () => {
      const context = await capturedContext(page, canonicalRepo)
      const result = await page.evaluate(async (context) => {
        const approval = await window.desktop.captureOperation(context)
        return window.desktop.executeOperation(approval.token, { type: 'fetch' })
      }, context)
      assertEqual(
        result.message,
        'Fetched all remotes',
        'The captured fetch was not credited to this repository',
      )
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

    await check(
      'captured lifecycle creates a new linked worktree while preserving the primary directory',
      async () => {
        const context = await capturedContext(page, canonicalRepo)
        const directory = join(workspace.root, 'captured linked Ω')
        const primaryHead = git(workspace, ['rev-parse', 'HEAD'])
        const primaryIndex = await readFile(join(workspace.repo, '.git', 'index'))
        const result = await page.evaluate(
          async ({ context, directory, branch }) => {
            const approval = await window.desktop.captureOperation(context)
            const preview = await window.desktop.inspect(
              { ...context, operationToken: approval.token },
              'worktreeLifecyclePreview',
              [
                {
                  kind: 'create',
                  repositoryId: context.repositoryId,
                  sourceRefId: context.refId,
                  directory,
                  newBranch: branch,
                },
              ],
            )
            if (preview.blockers.length) throw new Error(preview.blockers.join('; '))
            return window.desktop.executeOperation(approval.token, {
              type: 'executeWorktreeLifecycle',
              token: preview.token,
              coordinationConfirmed: true,
            })
          },
          { context, directory, branch: FEATURE },
        )
        assert(
          result.worktreeLifecycle?.targets.some((target) => target.state === 'completed'),
          'Actual captured lifecycle did not confirm its created target',
        )
        assertEqual(
          git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: directory }),
          FEATURE,
          'New linked branch',
        )
        assertEqual(
          git(workspace, ['rev-parse', 'HEAD']),
          primaryHead,
          'Lifecycle changed primary HEAD',
        )
        assert(
          (await readFile(join(workspace.repo, '.git', 'index'))).equals(primaryIndex),
          'Lifecycle rewrote primary index',
        )
        await writeFile(join(directory, 'native-Ω.txt'), 'Original captured directory bytes Ω\n')
        const selected = await capturedContext(page, directory)
        // Explicit capture on a linked worktree: the directory is a registered
        // worktree of the primary repository, and the approval is minted for
        // this directory without needing to match the repository the window
        // shows — registration, not the active checkout, is what qualifies it.
        const linkedApproval = await page.evaluate(async (context) => {
          try {
            const approval = await window.desktop.captureOperation(context)
            return {
              token: typeof approval?.token === 'string',
              repositoryPath: approval?.scope.repositoryPath ?? null,
            }
          } catch (error) {
            return { error: error?.message ?? String(error) }
          }
        }, selected)
        assertEqual(linkedApproval.repositoryPath, directory, 'Captured linked-worktree authority')
        assert(linkedApproval.token, 'Explicit linked worktree minted no operation token')
        const before = await readFile(join(workspace.repo, '.git', 'config'))
        const inspected = await page.evaluate(
          async (context) => ({
            status: await window.desktop.inspect(context, 'worktreeStatus', []),
            file: await window.desktop.inspect(context, 'fileView', ['native-Ω.txt']),
          }),
          selected,
        )
        assertEqual(
          inspected.status.path,
          directory,
          'Read-only inspector borrowed another directory',
        )
        assert(
          inspected.status.files.some((file) => file.path === 'native-Ω.txt' && file.index === '?'),
          'Actual untracked fact was lost',
        )
        assertEqual(
          inspected.file.content,
          'Original captured directory bytes Ω\n',
          'Actual read-only file bytes',
        )
        assertEqual(
          git(workspace, ['rev-parse', 'HEAD']),
          primaryHead,
          'Inspection changed primary HEAD',
        )
        assert(
          (await readFile(join(workspace.repo, '.git', 'index'))).equals(primaryIndex),
          'Inspection rewrote primary index',
        )
        assert(
          (await readFile(join(workspace.repo, '.git', 'config'))).equals(before),
          'Inspection rewrote Git config',
        )
        return 'Shipped main/preload captured lifecycle and read-only Unicode directory inspection; no primary checkout/index change'
      },
    )

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

    // Run the last two together: the blocked navigation leaves a pending load in the renderer, and
    // the foreign-origin document replaces the window's own frame, so every UI interaction and
    // every authorized bridge call has to happen before them.
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

    await check(
      'packaged inventory bridge discovers simultaneous worktrees without checkout or Git writes',
      async () => {
        // The linked directory is created once and deliberately kept for the
        // whole run: the adoption below registers it in the running app, and
        // the records and cancellation scenarios that follow still resolve
        // provider reads through it. Removing a registered fixture directory
        // mid-run leaves operation readers a missing spawn cwd (ENOENT), so
        // the disposable root owns this worktree's lifetime.
        const linked = join(workspace.root, 'inventory linked Ω')
        git(workspace, ['worktree', 'add', '-b', 'inventory/smoke', linked])
        await writeFile(join(linked, 'inventory-untracked.txt'), 'Read-only inventory fixture\n')
        const head = git(workspace, ['rev-parse', 'HEAD'])
        const index = await readFile(join(workspace.repo, '.git', 'index'))
        const config = await readFile(join(workspace.repo, '.git', 'config'))
        // The same acquisition shape as capturedContext: watch the published
        // channel, kick exactly one manual read, and accept the first
        // inventory that already holds the expected worktrees. A manual read
        // a watcher refresh supersedes answers as a plain cancellation and is
        // ignored; the published inventory still arrives.
        const discovered = await page.evaluate(
          ({ repo, linked }) =>
            new Promise((resolve, reject) => {
              let settled = false
              let unsubscribe
              const finish = (error, value) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                try {
                  unsubscribe?.()
                } catch {}
                if (error) reject(error)
                else resolve(value)
              }
              const wanted = (inventory) => {
                const repository = inventory.repositories?.find((item) =>
                  item.registeredPaths?.includes(repo),
                )
                if (!repository) return null
                const primary = repository.worktrees.find((tree) => tree.path === repo)
                const worktree = repository.worktrees.find((tree) => tree.path === linked)
                if (!primary || !worktree) return null
                if (primary.read.state !== 'complete' || worktree.read.state !== 'complete')
                  return null
                return inventory
              }
              const consume = (inventory) => {
                if (settled) return
                const value = wanted(inventory)
                if (value) finish(null, value)
              }
              const timer = setTimeout(
                () =>
                  finish(new Error('Published inventory never reached the wanted inspections.')),
                20_000,
              )
              try {
                unsubscribe = window.desktop.onWorktreeInventory(consume)
                window.desktop
                  .worktreeInventory({ requestId: 'packaged-inventory' })
                  .then(consume, (error) => {
                    // The shipped preload rejects a cancelled command with
                    // the plain bridge-safe answer; anything else is real.
                    if (
                      typeof error?.cancelled === 'boolean' &&
                      error?.cancelled === true &&
                      error?.name === 'CommandCancelled'
                    )
                      return
                    finish(error)
                  })
              } catch (error) {
                finish(error)
              }
            }),
          { repo: workspace.repo, linked },
        )
        const repository = discovered.repositories.find((item) =>
          item.registeredPaths.includes(workspace.repo),
        )
        assert(repository, 'The registered local authority was absent from inventory')
        const primary = repository.worktrees.find((tree) => tree.path === workspace.repo)
        const worktree = repository.worktrees.find((tree) => tree.path === linked)
        assert(primary && worktree, 'The primary and linked worktrees were not discovered together')
        assertEqual(worktree.kind, 'linked', 'Linked worktree classification')
        assertEqual(worktree.status, 'dirty', 'Linked worktree status')
        assertEqual(worktree.counts.untracked, 1, 'Linked untracked count')
        assert(primary.id !== worktree.id, 'Worktree identities were conflated')
        assertEqual(primary.repositoryId, worktree.repositoryId, 'Common local authority')
        assertEqual(
          git(workspace, ['rev-parse', 'HEAD']),
          head,
          'Inventory changed the primary HEAD',
        )
        assert(
          (await readFile(join(workspace.repo, '.git', 'index'))).equals(index),
          'Inventory rewrote the primary index',
        )
        assert(
          (await readFile(join(workspace.repo, '.git', 'config'))).equals(config),
          'Inventory rewrote Git config',
        )
        const refused = await page.evaluate(async () => {
          try {
            await window.desktop.adoptWorktrees(['unknown-authority'], 'adoption-refusal')
            return false
          } catch {
            return true
          }
        })
        assert(refused, 'Adoption accepted an undiscovered identity')
        const original = await capturedContext(page, canonicalRepo)
        const adopted = await page.evaluate(
          async ({ id, context }) => {
            const registered = await window.desktop.adoptWorktrees([id], 'packaged-adoption')
            const active = await window.desktop.inspect(context, 'refresh', [])
            return { registered, activePath: active.path }
          },
          { id: worktree.id, context: original },
        )
        assert(
          adopted.registered.some((item) => item.path === linked),
          'Adoption did not register the existing linked directory',
        )
        assertEqual(
          adopted.activePath,
          workspace.repo,
          'Adoption changed the active checkout context',
        )
        assertEqual(git(workspace, ['rev-parse', 'HEAD']), head, 'Adoption changed HEAD')
        assert(
          (await readFile(join(workspace.repo, '.git', 'config'))).equals(config),
          'Adoption rewrote Git config',
        )
        return 'Actual shipped main/preload: shared common authority, dirty local facts, existing-directory adoption without focus/checkout change and refused forged adoption'
      },
    )
    await check(
      'operation records still enumerate the non-active primary journal entry after the second repository registers',
      async () => {
        // A second registered repository the window is not showing. Its origin
        // is the owned local bare repository the primary already uses — a valid
        // Git remote the app can read — so inventory discovers it like any
        // local repository: the API double this run owns is not a Git HTTP
        // remote. The provider scenario below temporarily swaps the origin to a
        // github-shaped URL and restores this borrowed local one.
        const second = recordsSecond
        await mkdir(second)
        git(workspace, ['init', '-b', 'main'], { cwd: second })
        await writeFile(join(second, 'notes.txt'), 'Second registered fixture Ω\n')
        git(workspace, ['add', '.'], { cwd: second })
        git(workspace, ['commit', '-m', 'Second registered base'], { cwd: second })
        git(workspace, ['remote', 'add', 'origin', workspace.origin], { cwd: second })
        const opened = await page.evaluate(async (path) => {
          try {
            const snapshot = await window.desktop.addRepository(path)
            return { path: snapshot?.path ?? null }
          } catch (error) {
            return { error: error?.message ?? String(error) }
          }
        }, second)
        assertEqual(opened.path, second, 'The second registered repository did not open')
        // The registration is only a prerequisite: the shared acquisition
        // helper proves the inventory actually discovered the second
        // repository, so the multi-repository records query below cannot pass
        // against a partial registration state.
        // The driver owns this window: registration is not itself React navigation or focus.
        // Foreground it before awaiting discovery so a superseding automatic read can publish.
        await inspector.call(MAIN_WINDOW_STATE, 'focus')
        await capturedContext(page, second)
        const records = await page.evaluate(() => window.desktop.operationRecords())
        assert(Array.isArray(records), 'Operation records did not answer an array')
        assert(
          records.some((record) => record.worktreePath === canonicalRepo),
          "The non-active repository's recorded operations were not enumerated",
        )
        const restored = await page.evaluate(async (path) => {
          const snapshot = await window.desktop.addRepository(path)
          return snapshot?.path ?? null
        }, canonicalRepo)
        assertEqual(restored, canonicalRepo, 'The primary repository was not restored')
        return 'records still enumerated the non-active primary journal entry after the second repository opened'
      },
    )

    await check(
      'a cancelled read answers as plaintext cancellation without an error stack, and a genuine failure stays one',
      async () => {
        const context = await capturedContext(page, canonicalRepo)
        const packagedLog = join(workspace.evidence, 'packaged-app.log')
        const handlerDiagnostics = () =>
          existsSync(packagedLog)
            ? readFileSync(packagedLog, 'utf8')
                .split('\n')
                .filter((line) =>
                  line.includes("Error occurred in handler for 'inspection:request'"),
                )
            : []
        const handlerErrors = () => handlerDiagnostics().length
        const before = handlerErrors()
        const requestId = 'packaged-transport-cancellation'
        // The suspended read has to be genuinely provider-backed. The dispatch
        // therefore targets the second registered repository with a
        // repository-only context: GitHub inspection routes such a refresh to
        // the live provider read (`inspect:snapshot` selects it when no
        // worktree is named), while the primary keeps its disposable local
        // origin and every captured-worktree context stays local. The origin
        // the read resolves is this run's own alias of the configured base, so
        // the provider request lands on the API double this run owns and is
        // restored afterwards. The registration is acquired through the shared
        // capturedContext helper, so a manual inventory read a watcher refresh
        // supersedes answers as an ignored plain cancellation instead of an
        // escaped rejection; only the repository identity rides into the
        // repository-only dispatch.
        const { repositoryId } = await capturedContext(page, recordsSecond)
        const readContext = { repositoryId }
        const borrowedOrigin = git(workspace, ['config', '--get', 'remote.origin.url'], {
          cwd: recordsSecond,
        })
        const servedOrigin = `https://github.com/SmokeFixture/${basename(recordsSecond)}.git`
        git(workspace, ['remote', 'set-url', 'origin', servedOrigin], { cwd: recordsSecond })
        // The hold is armed before the read is dispatched and released in this
        // scenario's finally: a provider request that arrives while armed is
        // genuinely suspended, so the cancel below always lands on a read that
        // is in flight, never on a read that already answered.
        api.hold()
        try {
          const seen = api.requests.filter(
            (entry) => entry.path === '/user' || entry.path === '/graphql',
          ).length
          await page.evaluate(
            async ({ context, requestId }) => {
              window.__packagedCancelled = false
              window.desktop.inspect(context, 'refresh', [], requestId).then(
                () => {
                  window.__packagedCancelled = { resolved: true }
                },
                (error) => {
                  // Plain bridge data: this captures exactly what the page world
                  // received from the shipped preload after a cancelled read.
                  window.__packagedCancelled = {
                    name: error?.name ?? null,
                    message: error?.message ?? null,
                    cancelled: error?.cancelled ?? null,
                  }
                },
              )
            },
            { context: readContext, requestId },
          )
          const deadline = Date.now() + UI_TIMEOUT
          while (
            Date.now() < deadline &&
            (api.suspended() === 0 ||
              api.requests.filter((entry) => entry.path === '/user' || entry.path === '/graphql')
                .length === seen)
          )
            await new Promise((wait) => setTimeout(wait, 50))
          assert(api.suspended() > 0, 'The captured refresh never reached its provider read')
          await page.evaluate(
            ({ context, requestId }) => window.desktop.inspect(context, 'cancel', [requestId]),
            { context: readContext, requestId },
          )
          const cancelledAt = Date.now() + UI_TIMEOUT
          while (Date.now() < cancelledAt) {
            const cancelled = await page.evaluate(() => window.__packagedCancelled)
            if (cancelled) break
            await new Promise((wait) => setTimeout(wait, 50))
          }
          const cancelled = await page.evaluate(() => window.__packagedCancelled)
          assert(
            cancelled && cancelled.resolved !== true,
            'A cancelled read was answered with a success value',
          )
          assertEqual(
            cancelled.name,
            'CommandCancelled',
            'Renderer cancellation name after the real bridge',
          )
          assert(cancelled.cancelled === true, 'Renderer cancelled fact after the real bridge')
          assertEqual(
            handlerErrors(),
            before,
            'An expected cancellation reached the console as an error stack',
          )
        } finally {
          git(workspace, ['remote', 'set-url', 'origin', borrowedOrigin], { cwd: recordsSecond })
          api.release()
        }
        const genuine = await page.evaluate(async (context) => {
          try {
            await window.desktop.inspect(
              { repositoryId: context.repositoryId },
              'worktreeStatus',
              [],
            )
            return { resolved: true }
          } catch (error) {
            return {
              resolved: false,
              name: error?.name ?? null,
              message: error?.message ?? String(error),
              cancelled: error?.cancelled ?? null,
            }
          }
        }, context)
        assert(!genuine.resolved, 'A genuine failure was answered as a success')
        assert(genuine.cancelled === null, 'A genuine failure was decoded as a cancellation')
        assert(
          genuine.name && genuine.name !== 'CommandCancelled',
          'A genuine failure adopted the cancellation name',
        )
        const diagnostic = genuine.message.replace(
          /^Error invoking remote method 'inspection:request': /u,
          '',
        )
        const loggedGenuine = () => handlerDiagnostics().some((line) => line.endsWith(diagnostic))
        const loggedBy = Date.now() + UI_TIMEOUT
        while (!loggedGenuine() && Date.now() < loggedBy)
          await new Promise((wait) => setTimeout(wait, 50))
        assert(loggedGenuine(), 'The genuine handler diagnostic was not logged')
        assertEqual(handlerErrors(), before + 1, 'A genuine failure was not logged for the record')
        return 'cancelled read stayed plaintext without a new handler error line, genuine failure stayed logged'
      },
    )

    await check('main answers the app origin and refuses a foreign one', async () => {
      // Local Git is open, so refresh reaches its handler while PR indexing truthfully refuses
      // the local-only origin. The refusal that follows must instead be the origin guard alone.
      const authorized = await page.evaluate(READ_ONLY_PROBE)
      // A deliberately superseded read answers its manual invocation with the
      // plain bridge-safe cancellation the shipped preload decodes (name
      // 'CommandCancelled', cancelled true). The sender guard never emits that
      // typed cancellation regardless of message prose, so a call rejected in
      // exactly this shape in the authorized frame still proved the trusted
      // handler reached it. Every other rejection must stay a failure, and the
      // unauthorized and foreign reports below still have to show the actual
      // untrusted refusal on every method, never a cancellation.
      for (const call of authorized.calls) {
        if (call.label === 'prIndexRefresh') {
          assert(
            !call.resolved &&
              /A GitHub origin remote is required for PR indexing/.test(call.message),
            `Trusted PR index refresh did not reach its origin precondition: ${call.message}`,
          )
          continue
        }
        if (
          !call.resolved &&
          call.name === 'CommandCancelled' &&
          call.cancelled &&
          (call.label === 'worktreeInventory' || call.label === 'refresh')
        ) {
          continue
        }
        assert(call.resolved, `The authorized frame could not call ${call.label}: ${call.message}`)
      }
      const protectedBefore = protectedState(probe.userData)
      const navigated = await inspector.call(MAIN_FOREIGN_ORIGIN, ORIGIN, FOREIGN_DOCUMENT)
      assertEqual(
        navigated.contentsIdAfter,
        navigated.contentsIdBefore,
        'The foreign document did not load in the app webContents',
      )
      assertEqual(navigated.frames, 0, 'The foreign document created child frames')
      const deadline = Date.now() + UI_TIMEOUT
      while (!page.url().startsWith('data:') && Date.now() < deadline) {
        await new Promise((wait) => setTimeout(wait, 100))
      }
      assert(page.url().startsWith('data:'), `The app window still shows ${page.url()}`)
      const foreign = await page.evaluate(READ_ONLY_PROBE)
      assertEqual(foreign.bridge, 'function', 'The foreign origin did not run the shipped preload')
      assertRefused(foreign, /Untrusted application origin\.?/u)
      assertEqual(
        protectedState(probe.userData),
        protectedBefore,
        'A refused foreign-origin request changed the app-owned files',
      )
      // The renderer cannot reach this state: the check above proves window.open and off-app
      // navigation are refused, and only the main process can load a document into its own frame.
      note(
        'The foreign-origin document was loaded with webContents.loadURL in the shipped main process, which no renderer can reach; the attempt a renderer can make to leave the app origin is the navigation check above.',
      )
      return `${foreign.calls.length} read-only calls from that same main frame at a data: origin were refused as untrusted, the authorized frame answered immediately before, and the app-owned files are unchanged`
    })

    await report(null)
    // Nothing in this run may have reached a CLI that is not the one it wrote:
    // a machine's own gh would have answered the version probe, the auth status
    // or a token read with somebody's real account, and the "missing CLI" step
    // would have proved nothing.
    const refusals = join(workspace.root, 'credential-fixture', 'unowned-gh-launches.log')
    const attempts = existsSync(refusals)
      ? readFileSync(refusals, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
      : []
    const whileInstalled = attempts.filter((line) => line.startsWith('owned-present'))
    assert(
      whileInstalled.length === 0,
      `The app started a CLI it did not own while one was installed: ${whileInstalled.join(', ')}`,
    )
    // The stronger of the two: a launch that reached past the boundary at all
    // would have resolved the sentinel this run put on PATH behind its own
    // directory and written its mark. The machine's own CLI could not have.
    assertEqual(
      existsSync(workspace.sentinelStamp) ? readFileSync(workspace.sentinelStamp, 'utf8') : '',
      '',
      'The packaged app ran a GitHub CLI outside the directory this run owns',
    )
    note(
      attempts.length === 0
        ? "No gh outside this run's own executable was ever started, and the CLI this run put on PATH behind its own directory never ran."
        : `Every gh start this run blocked (${attempts.length}) was for the fault-injected absence; ${attempts.join('; ')}. The CLI behind this run's own directory on PATH never ran.`,
    )
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
