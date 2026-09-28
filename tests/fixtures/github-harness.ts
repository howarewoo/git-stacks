import { chmod, copyFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const thisDirectory = dirname(fileURLToPath(import.meta.url))
const gitTransportFixture = join(thisDirectory, 'git-transport.cjs')
const githubCliFixture = join(thisDirectory, 'github-cli.cjs')

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
  requests: Array<{ argv: string[]; cwd: string; at: string; body?: Record<string, unknown> }>
}

export interface GitHubHarness {
  root: string
  repo: string
  bare: string
  bin: string
  env: NodeJS.ProcessEnv
  readState(): Promise<GitHubFixtureState>
  writeState(state: GitHubFixtureState): Promise<void>
  close(): Promise<void>
}

async function runGit(
  realGit: string,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync(realGit, args, {
    cwd,
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return String(result.stdout || '').trim()
}

async function runBareGit(realGit: string, bare: string, args: string[]): Promise<string> {
  return runGit(realGit, process.cwd(), ['--git-dir', bare, ...args])
}

function realGitPath(): string {
  try {
    return execFileSync('which', ['git'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return '/usr/bin/git'
  }
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
  requests: [],
})

export async function createGitHubHarness(
  options: { ghCli?: boolean } = {},
): Promise<GitHubHarness> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-github-harness-'))
  const repo = join(root, 'repo')
  const bare = join(root, 'remote.git')
  const bin = join(root, 'bin')
  const statePath = join(root, 'github-state.json')
  const transportLog = join(root, 'git-transport.jsonl')
  const realGit = realGitPath()
  let isClosed = false
  try {
    await Promise.all([mkdir(repo), mkdir(bin)])
    await writeFile(statePath, `${JSON.stringify(initialState(), null, 2)}\n`, 'utf8')
    await writeFile(transportLog, '', 'utf8')
    await copyFile(gitTransportFixture, join(bin, 'git'))
    await chmod(join(bin, 'git'), 0o755)
    if (options.ghCli !== false) {
      await copyFile(githubCliFixture, join(bin, 'gh'))
      await chmod(join(bin, 'gh'), 0o755)
    }

    await runGit(realGit, root, ['init', '--bare', bare])
    await runBareGit(realGit, bare, ['config', 'user.name', 'GitHub Fixture'])
    await runBareGit(realGit, bare, ['config', 'user.email', 'github-fixture@example.invalid'])
    await runGit(realGit, repo, ['init', '-b', 'main'])
    await runGit(realGit, repo, ['config', 'user.name', 'Git Stacks GitHub fixture'])
    await runGit(realGit, repo, [
      'config',
      'user.email',
      'git-stacks-github-fixture@example.invalid',
    ])
    await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8')
    await runGit(realGit, repo, ['add', '--', 'base.txt'])
    await runGit(realGit, repo, ['commit', '-m', 'Fixture baseline'])
    await runGit(realGit, repo, ['push', bare, 'refs/heads/main:refs/heads/main'])
    await runBareGit(realGit, bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await runGit(realGit, repo, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
    await runGit(realGit, repo, [
      'remote',
      'set-url',
      '--push',
      'origin',
      'https://github.com/acme/widgets.git',
    ])
    await runGit(realGit, repo, ['fetch', bare, `refs/heads/main:refs/remotes/origin/main`])
    await runGit(realGit, repo, ['branch', '--set-upstream-to=origin/main', 'main'])
    await runGit(realGit, repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ])

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ''}`,
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
      bin,
      env,
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
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
