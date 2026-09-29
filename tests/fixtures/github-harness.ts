import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  execFileSync as execFileSyncFunction,
  ChildProcess,
  ExecFileOptions,
} from 'node:child_process'

const nodeRequire = createRequire(import.meta.url)
const childProcess = nodeRequire('node:child_process') as {
  execFile: ExecFileBoundary
  execFileSync: typeof execFileSyncFunction
}
const gitTransportFixture = nodeRequire('./git-transport.cjs') as GitTransportFixture
const githubCliFixture = nodeRequire('./github-cli.cjs') as GitHubCliFixture

/** The `git` and `gh` this harness answers, and the real Git they delegate to. */
interface ActiveHarness {
  realGit: string
  barePath: string
  statePath: string
  transportLog: string
  overrides: GitOverride[]
  pushHooks: GitPushHook[]
}

type ExecFileDone = (error: Error | null, stdout: string, stderr: string) => void

interface ExecFileBoundary {
  (
    file: string,
    args?: readonly string[],
    options?: ExecFileOptions,
    callback?: ExecFileDone,
  ): ChildProcess
  /**
   * Node's own promisified form of `execFile`. Git Stacks wraps `execFile` with
   * `promisify` when its modules load, and `promisify` hands back this form, so
   * the harness has to carry it to keep answering the commands Git Stacks makes.
   */
  [promisify.custom]: (
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
  ) => Promise<{ stdout: string; stderr: string }>
}

/**
 * What a real `execFile` call hands back: the promise Git Stacks awaits, plus
 * the child whose stdin it writes the request body to before awaiting.
 */
interface PromiseWithChild<T> extends Promise<T> {
  child: { stdin: { end(chunk: string): void } }
}

interface CommandError extends Error {
  code: number
  stdout: string
  stderr: string
  killed: boolean
  signal: null
  cmd: string
}

interface GitTransportFixture {
  planGitTransport(request: {
    args: string[]
    barePath: string
    logPath: string
    cwd: string
  }): { ok: true; args: string[] } | { ok: false; refused: string }
}

interface GitHubCliFixture {
  runGitHubCli(request: {
    statePath: string
    barePath: string
    realGit: string
    args: string[]
    cwd: string
    input: string
  }): string
}

export interface GitHubFixtureComment {
  id: number
  body: string
  user?: { login: string }
  author?: string
}

export interface GitHubFixturePullRequest {
  number: number
  title: string
  body: string
  base: string
  head: string
  headRepository: string
  draft: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  checks: 'none' | 'passing' | 'pending' | 'failing'
  reviewDecision: string | null
  mergeState: string | null
  url: string
  headOid: string | null
  mergeOid: string | null
  mergedAt: string | null
}

export interface GitHubFixtureStack {
  id: number
  number: number
  node_id: string
  url: string
  base: { ref: string }
  open: boolean
  created_at: string
  pull_requests: Array<{
    number: number
    state: 'open' | 'closed'
    draft: boolean
    merged_at: string | null
    head: { ref: string; sha: string }
  }>
}
export interface GitHubFixtureState {
  version: 1
  repository: {
    owner: string
    name: string
    defaultBranch: string
    allowMergeCommit: boolean
    allowSquashMerge: boolean
    allowRebaseMerge: boolean
  }
  currentUser: string
  nextNumber: number
  nextCommentId: number
  nextStackNumber?: number
  stacksPreviewDisabled?: boolean
  /** When set, every native-stacks endpoint answers with this error instead of stack data. */
  stacksFailure?: {
    status: number
    reason: string
    message: string
    rateLimitRemaining?: number
  }
  issuesFailure?: {
    status: number
    reason: string
    message: string
  }
  prWriteFailure?: {
    status: number
    reason: string
    message: string
  }
  /**
   * Mutations that succeed on GitHub but whose response never reaches the caller, which is
   * what a dropped connection mid-request looks like to the person waiting. Each entry is
   * consumed once, in order, by the first matching method and path.
   */
  lostResponses?: Array<{
    method: string
    pathIncludes: string
    status: number
    message: string
  }>
  /**
   * Branch refs moved by somebody else while a request is in flight, applied by the double
   * before it answers the first matching request. This is the window a client cannot close
   * with one read: the value changes between two reads that both looked consistent.
   */
  /**
   * Branch refs moved by somebody else while a request is in flight, applied by the double
   * before it answers the `after`-th matching request. Zero is the first match, so the rule
   * can target a later read rather than the one that opened the step.
   */
  driftOnRequest?: Array<{
    pathIncludes: string
    ref: string
    to: string
    after?: number
  }>
  /**
   * Pull requests closed by somebody else while a request is in flight, so a change that
   * lands after an earlier step is read still shows up in the next one.
   */
  closeOnRequest?: Array<{ pathIncludes: string; number: number; after?: number }>
  prs: GitHubFixturePullRequest[]
  comments: Record<string, GitHubFixtureComment[]>
  stacks?: GitHubFixtureStack[]
  issues?: Array<{
    number: number
    title: string
    url: string
    state: 'OPEN' | 'CLOSED'
    /** Repository that owns the issue; search results expose it so foreign issues are rejected. */
    repository?: string
  }>
  asyncMerge?: { number: number; sha: string; method: string }
  requests: Array<{ argv: string[]; cwd: string; at: string; body?: Record<string, unknown> }>
}

/**
 * Answers a Git command Git Stacks would otherwise run for real. `match` sees
 * the arguments after any leading `-C <repository>`, and `run` returns what the
 * command would have written to stdout.
 */
export interface GitOverride {
  match(args: readonly string[]): boolean
  run(args: readonly string[]): string
}

/**
 * Mutates the fixture at the moment Git Stacks publishes `branch`. `before` runs
 * once the push is claimed and before real Git sees it, and `after` runs only
 * once that push has succeeded, which is the window Git Stacks has to notice a
 * concurrently deleted branch, closed pull request, or new pull request.
 */
export interface GitPushHook {
  branch: string
  armed: boolean
  before?(): void
  after?(): void
}

export interface GitHubHarness {
  root: string
  repo: string
  bare: string
  statePath: string
  env: NodeJS.ProcessEnv
  /** Installs `override`; later overrides are consulted first. */
  overrideGit(override: GitOverride): void
  /** Installs `hook`, which the test keeps a handle on so it can disarm it. */
  hookGitPush(hook: GitPushHook): void
  /** Runs a Git command against real Git, bypassing the fixture's own answers. */
  runGit(args: string[]): string
  readState(): Promise<GitHubFixtureState>
  writeState(state: GitHubFixtureState): Promise<void>
  close(): Promise<void>
}

/**
 * Resolves the one real Git the fixture delegates to, the way the platform does
 * it, by walking `PATH`. `which` is a POSIX program Windows does not have, and a
 * fixed `/usr/bin/git` names nothing on the other platforms, so the scan honours
 * `PATHEXT` and fails loudly when Git is not installed.
 */
function resolveRealGit(): string {
  const searchPath = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const directory of searchPath) {
    for (const extension of extensions) {
      const candidate = join(directory, `git${extension}`)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
  }
  throw new Error('The GitHub harness needs a real git executable on PATH')
}

const realExecFile = childProcess.execFile
const realPromisifiedExecFile = realExecFile[promisify.custom]
const realExecFileSync = childProcess.execFileSync
let active: ActiveHarness | null = null

function commandError(file: string, args: readonly string[], code: number, stderr: string) {
  const cmd = [file, ...args].join(' ')
  const error = new Error(`Command failed: ${cmd}\n${stderr}`) as CommandError
  error.code = code
  error.stdout = ''
  error.stderr = stderr
  error.killed = false
  error.signal = null
  error.cmd = cmd
  return error
}

function withoutRepository(args: readonly string[]): { repository: string | null; args: string[] } {
  if (args[0] === '-C' && typeof args[1] === 'string') {
    return { repository: args[1], args: args.slice(2) }
  }
  return { repository: null, args: [...args] }
}

function claimedPushHook(harness: ActiveHarness, args: readonly string[]): GitPushHook | null {
  if (!args.includes('push')) return null
  return (
    harness.pushHooks.find(
      (hook) => hook.armed && args.some((arg) => arg.endsWith(`:refs/heads/${hook.branch}`)),
    ) || null
  )
}

function runHookStep(
  hook: GitPushHook | null,
  step: 'before' | 'after',
  file: string,
  argv: readonly string[],
): void {
  try {
    hook?.[step]?.()
  } catch (error) {
    throw commandError(file, argv, 1, error instanceof Error ? error.message : String(error))
  }
}

function commandName(file: string): string {
  return basename(file)
    .replace(/\.exe$/iu, '')
    .toLowerCase()
}

async function runGitFixture(
  harness: ActiveHarness,
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const argv = [...args]
  const { repository, args: rest } = withoutRepository(argv)
  const override = harness.overrides.find((entry) => entry.match(rest))
  if (override) return { stdout: override.run(rest), stderr: '' }
  const hook = claimedPushHook(harness, argv)
  runHookStep(hook, 'before', file, argv)
  const plan = gitTransportFixture.planGitTransport({
    args: argv,
    barePath: harness.barePath,
    logPath: harness.transportLog,
    cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
  })
  if (!plan.ok) throw commandError(file, argv, 2, `${plan.refused}\n`)
  const command = repository ? ['-C', repository, ...plan.args] : plan.args
  const result = await realPromisifiedExecFile(harness.realGit, command, options)
  runHookStep(hook, 'after', file, argv)
  return result
}

/**
 * Answers a `gh` request, and answers it only once the caller has finished
 * writing the request body. The `gh` transport runs `child.child.stdin?.end(input)`
 * and only then awaits the call, so the body reaches the fixture through a
 * deferred promise instead of the stdin it would have been written to.
 */
function runGhFixture(
  harness: ActiveHarness,
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): PromiseWithChild<{ stdout: string; stderr: string }> {
  let input = ''
  const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    queueMicrotask(() => {
      try {
        resolve({
          stdout: githubCliFixture.runGitHubCli({
            statePath: harness.statePath,
            barePath: harness.barePath,
            realGit: harness.realGit,
            args: [...args],
            cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
            input,
          }),
          stderr: '',
        })
      } catch (error) {
        const code = (error as { code?: unknown }).code
        reject(
          commandError(
            file,
            args,
            typeof code === 'number' ? code : 2,
            `${error instanceof Error ? error.message : String(error)}\n`,
          ),
        )
      }
    })
  })
  return Object.assign(result, {
    child: {
      stdin: {
        end(chunk: string) {
          input += chunk
        },
      },
    },
  })
}

function runFixtureCommand(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const harness = active
  if (!harness) return realPromisifiedExecFile(file, args, options)
  const command = commandName(file)
  if (command === 'git') return runGitFixture(harness, file, args, options)
  if (command === 'gh') return runGhFixture(harness, file, args, options)
  return realPromisifiedExecFile(file, args, options)
}

childProcess.execFile = Object.assign(
  function execFileWithGitHubFixture(
    file: string,
    args?: readonly string[],
    options?: ExecFileOptions,
    callback?: ExecFileDone,
  ): ChildProcess {
    if (typeof callback === 'function') {
      const command = commandName(file)
      // A `gh` or `git` request that bypasses the promisified boundary would
      // reach the real tools, so it fails here instead of answering from the
      // wrong process.
      if (active && ['git', 'gh'].includes(command)) {
        throw new Error(
          `The GitHub harness answers ${file} only through the promisified execFile boundary`,
        )
      }
      return realExecFile(file, args, options, callback)
    }
    return realExecFile(file, args, options)
  },
  { [promisify.custom]: runFixtureCommand },
)

async function runRealGit(
  realGit: string,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await realPromisifiedExecFile(realGit, args, {
    cwd,
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return String(result.stdout || '').trim()
}

async function runBareGit(realGit: string, bare: string, args: string[]): Promise<string> {
  return runRealGit(realGit, process.cwd(), ['--git-dir', bare, ...args])
}

const initialState = (): GitHubFixtureState => ({
  version: 1,
  repository: {
    owner: 'acme',
    name: 'widgets',
    defaultBranch: 'main',
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: true,
  },
  currentUser: 'fixture-user',
  nextNumber: 1,
  nextCommentId: 1,
  nextStackNumber: 1,
  prs: [],
  comments: {},
  stacks: [],
  issues: [],
  requests: [],
})

export async function createGitHubHarness(): Promise<GitHubHarness> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-github-harness-'))
  const repo = join(root, 'repo')
  const bare = join(root, 'remote.git')
  const statePath = join(root, 'github-state.json')
  const transportLog = join(root, 'git-transport.jsonl')
  const realGit = resolveRealGit()
  let isClosed = false
  try {
    await mkdir(repo)
    await writeFile(statePath, `${JSON.stringify(initialState(), null, 2)}\n`, 'utf8')
    await writeFile(transportLog, '', 'utf8')
    await runRealGit(realGit, root, ['init', '--bare', bare])
    await runBareGit(realGit, bare, ['config', 'user.name', 'GitHub Fixture'])
    await runBareGit(realGit, bare, ['config', 'user.email', 'github-fixture@example.invalid'])
    await runRealGit(realGit, repo, ['init', '-b', 'main'])
    await runRealGit(realGit, repo, ['config', 'user.name', 'Git Stacks GitHub fixture'])
    await runRealGit(realGit, repo, [
      'config',
      'user.email',
      'git-stacks-github-fixture@example.invalid',
    ])
    await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8')
    await runRealGit(realGit, repo, ['add', '--', 'base.txt'])
    await runRealGit(realGit, repo, ['commit', '-m', 'Fixture baseline'])
    await runRealGit(realGit, repo, ['push', bare, 'refs/heads/main:refs/heads/main'])
    await runBareGit(realGit, bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await runRealGit(realGit, repo, [
      'remote',
      'add',
      'origin',
      'https://github.com/acme/widgets.git',
    ])
    await runRealGit(realGit, repo, [
      'remote',
      'set-url',
      '--push',
      'origin',
      'https://github.com/acme/widgets.git',
    ])
    await runRealGit(realGit, repo, ['fetch', bare, `refs/heads/main:refs/remotes/origin/main`])
    await runRealGit(realGit, repo, ['branch', '--set-upstream-to=origin/main', 'main'])
    await runRealGit(realGit, repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ])

    const fixture: ActiveHarness = {
      realGit,
      barePath: bare,
      statePath,
      transportLog,
      overrides: [],
      pushHooks: [],
    }
    active = fixture

    // The API double and the transport log read the fixture through the
    // environment, because they are loaded as plain modules the test process
    // imports rather than as the intercepted `gh` and `git` commands.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_STACKS_FIXTURE_ROOT: root,
      GIT_STACKS_FIXTURE_STATE: statePath,
      GIT_STACKS_FIXTURE_BARE: bare,
      GIT_STACKS_REAL_GIT: realGit,
      GIT_STACKS_TRANSPORT_LOG: transportLog,
      GH_HOST: 'github.com',
      GH_TOKEN: 'fixture-token',
      GH_REPO: 'acme/widgets',
    }

    return {
      root,
      repo,
      bare,
      statePath,
      env,
      overrideGit(override) {
        fixture.overrides.unshift(override)
      },
      hookGitPush(hook) {
        fixture.pushHooks.push(hook)
      },
      runGit(args) {
        return realExecFileSync(realGit, args, {
          encoding: 'utf8',
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim()
      },
      async readState() {
        return JSON.parse(await readFile(statePath, 'utf8')) as GitHubFixtureState
      },
      async writeState(state) {
        const temporary = `${statePath}.${process.pid}.write.tmp`
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        await rename(temporary, statePath)
      },
      async close() {
        if (isClosed) return
        isClosed = true
        if (active?.statePath === statePath) active = null
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
