/**
 * Disposable real Git repositories for the flatten-pr-graph authoring fixtures.
 *
 * Every Git call goes through an argument array into the real `git` executable; no
 * shell, no string interpolation, and no network. A world is one bare "remote" plus
 * one working checkout that stands in for the user's repository, plus task-owned
 * scratch clones. Everything lives under one temporary directory that the fixture
 * removes when it ends.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface GitCommandRecord {
  cwd: string
  args: string[]
}

export interface UserFingerprint {
  headRef: string
  headOid: string | null
  status: string
  stashCount: number
  configDigest: string
}

export interface ScratchWorkspace {
  path: string
  write(path: string, content: string): Promise<void>
  checkout(branch: string): void
  checkoutNew(branch: string): void
  /** Stages everything in the workspace and returns the new commit id. */
  commit(message: string): string
  fetch(): void
  merge(branch: string): void
  push(branch: string, options?: { leaseFrom?: string; force?: boolean }): void
  mergeExpectingConflict(branch: string): void
  unmergedPaths(): string[]
  operationsInProgress(): string[]
  conflictMarkerPaths(): string[]
  headOid(): string
}

/**
 * Variables that would let a fixture reach a real remote, a real identity, or a real
 * credential. The world sets its own values on top of this list rather than
 * inheriting whatever the developer shell exported.
 */
const STRIPPED_ENVIRONMENT = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'GIT_CREDENTIAL_HELPER',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_PAT',
])

export interface World {
  readonly root: string
  readonly remote: string
  readonly repo: string
  readonly origin: string
  readonly commands: GitCommandRecord[]
  git(...args: string[]): string
  gitIn(cwd: string, ...args: string[]): string
  /** Runs Git and returns trimmed stdout, or null when Git exits non-zero. */
  tryGitIn(cwd: string, ...args: string[]): string | null
  remoteRefs(): Record<string, string>
  resolveIn(cwd: string, ref: string): string | null
  isAncestor(cwd: string, ancestor: string, descendant: string): boolean
  /**
   * Ancestry over the bare remote, which holds every published object. The working
   * checkout lags behind and cannot answer for branches it has not fetched.
   */
  isRemoteAncestor(ancestor: string, descendant: string): boolean
  /** Real `git push` from a checkout, optionally guarded by a real force-with-lease. */
  pushRef(branch: string, source: string, options?: { from?: string; leaseFrom?: string }): void
  /** Moves a remote ref directly, standing in for a concurrent push by somebody else. */
  moveRemoteRef(branch: string, oid: string): void
  createScratch(name: string): Promise<ScratchWorkspace>
  /** Replaces the user checkout with a real shallow clone, so history is genuinely absent. */
  makeShallowUserCheckout(): Promise<string>
  historyFacts(): { shallow: boolean; grafted: number }
  userFingerprint(): UserFingerprint
  cleanup(): Promise<void>
}

function sanitizedEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!STRIPPED_ENVIRONMENT.has(name)) env[name] = value
  }
  return {
    ...env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_SYSTEM: join(root, 'gitconfig-system'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.invalid',
  }
}

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function createWorld(label: string): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), `flatten-pr-graph-${label}-`))
  await mkdir(join(root, 'xdg'), { recursive: true })
  await writeFile(join(root, 'gitconfig'), '')
  await writeFile(join(root, 'gitconfig-system'), '')
  const env = sanitizedEnvironment(root)
  const remote = join(root, 'remote.git')
  const repo = join(root, 'checkout')
  const commands: GitCommandRecord[] = []

  const gitIn = (cwd: string, args: string[], quietStderr = false): string => {
    commands.push({ cwd, args: [...args] })
    return execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: quietStderr ? ['ignore', 'pipe', 'pipe'] : undefined,
    })
  }
  const tryGitIn = (cwd: string, ...args: string[]): string | null => {
    try {
      return gitIn(cwd, args).trim()
    } catch {
      return null
    }
  }

  gitIn(root, ['init', '--bare', '--initial-branch=main', remote])
  // The bare remote is still empty here, so Git's empty-clone warning is expected noise.
  gitIn(root, ['clone', '--quiet', remote, repo], true)
  gitIn(repo, ['config', 'user.name', 'Fixture Committer'])
  gitIn(repo, ['config', 'user.email', 'committer@example.invalid'])
  gitIn(repo, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(repo, 'README.md'), '# fixture\n')
  gitIn(repo, ['add', 'README.md'])
  gitIn(repo, ['commit', '--quiet', '-m', 'Root commit'])
  gitIn(repo, ['push', '--quiet', '--set-upstream', 'origin', 'main'])

  const world: World = {
    root,
    remote,
    repo,
    origin: remote,
    commands,
    git: (...args: string[]) => gitIn(repo, args),
    gitIn: (cwd, ...args) => gitIn(cwd, args),
    tryGitIn,
    remoteRefs(): Record<string, string> {
      const output = gitIn(root, [
        '--git-dir',
        remote,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
      ])
      const refs: Record<string, string> = {}
      for (const [ref, oid] of lines(output).map((line) => line.split(' '))) {
        if (ref.startsWith('refs/heads/') && oid) refs[ref] = oid
      }
      return refs
    },
    resolveIn(cwd, ref) {
      return tryGitIn(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
    },
    isAncestor(cwd, ancestor, descendant) {
      return tryGitIn(cwd, 'merge-base', '--is-ancestor', ancestor, descendant) !== null
    },
    isRemoteAncestor(ancestor, descendant) {
      return (
        tryGitIn(root, '--git-dir', remote, 'merge-base', '--is-ancestor', ancestor, descendant) !==
        null
      )
    },
    pushRef(branch, source, options = {}) {
      const args = ['push', '--quiet']
      if (options.leaseFrom) {
        args.push(`--force-with-lease=refs/heads/${branch}:${options.leaseFrom}`)
      }
      args.push('origin', `${options.from ?? source}:refs/heads/${branch}`)
      gitIn(repo, args)
    },
    moveRemoteRef(branch, oid) {
      gitIn(root, ['--git-dir', remote, 'update-ref', `refs/heads/${branch}`, oid])
    },
    async makeShallowUserCheckout() {
      await rm(repo, { recursive: true, force: true })
      // A local-path clone refuses --depth, so the remote is addressed over file://.
      gitIn(root, ['clone', '--quiet', '--depth', '1', `file://${remote}`, repo])
      gitIn(repo, ['config', 'user.name', 'Fixture Committer'])
      gitIn(repo, ['config', 'user.email', 'committer@example.invalid'])
      return repo
    },
    historyFacts() {
      const shallow = tryGitIn(repo, 'rev-parse', '--is-shallow-repository') === 'true'
      const shallowFile = join(repo, '.git', 'shallow')
      return {
        shallow,
        grafted: existsSync(shallowFile) ? lines(readFileSync(shallowFile, 'utf8')).length : 0,
      }
    },
    async createScratch(name) {
      const path = join(root, `scratch-${name}`)
      gitIn(root, ['clone', '--quiet', remote, path])
      gitIn(path, ['config', 'user.name', 'Fixture Committer'])
      gitIn(path, ['config', 'user.email', 'committer@example.invalid'])
      gitIn(path, ['config', 'commit.gpgsign', 'false'])
      const localName = (branch: string): string =>
        tryGitIn(path, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`)
          ? branch
          : `origin/${branch}`
      return {
        path,
        async write(relative, content) {
          const target = join(path, relative)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, content)
        },
        checkout(branch) {
          gitIn(path, ['checkout', '--quiet', branch])
        },
        commit(message: string) {
          gitIn(path, ['add', '-A'])
          gitIn(path, ['commit', '--quiet', '-m', message])
          return gitIn(path, ['rev-parse', 'HEAD']).trim()
        },
        checkoutNew(branch) {
          gitIn(path, ['checkout', '--quiet', '-b', branch])
        },
        fetch() {
          gitIn(path, ['fetch', '--quiet', 'origin'])
        },
        merge(branch) {
          gitIn(path, ['merge', '--no-edit', '--no-ff', localName(branch)])
        },
        push(branch, options = {}) {
          const args = ['push', '--quiet']
          if (options.leaseFrom) {
            args.push(`--force-with-lease=refs/heads/${branch}:${options.leaseFrom}`)
          } else if (options.force) {
            args.push('--force')
          }
          args.push('origin', `HEAD:refs/heads/${branch}`)
          gitIn(path, args)
        },
        mergeExpectingConflict(branch) {
          // `--no-commit` keeps the conflicted index on disk for the oracle to read.
          try {
            gitIn(path, ['merge', '--no-commit', '--no-ff', localName(branch)])
          } catch {
            // A non-zero exit is the expected outcome when the branches disagree.
          }
        },
        unmergedPaths() {
          return lines(tryGitIn(path, 'diff', '--name-only', '--diff-filter=U') ?? '')
        },
        operationsInProgress() {
          const gitDir = join(path, '.git')
          return [
            'MERGE_HEAD',
            'REBASE_HEAD',
            'CHERRY_PICK_HEAD',
            'rebase-merge',
            'rebase-apply',
          ].filter((marker) => existsSync(join(gitDir, marker)))
        },
        conflictMarkerPaths() {
          return lines(tryGitIn(path, 'grep', '--name-only', '-e', '<<<<<<<') ?? '')
        },
        headOid() {
          return gitIn(path, ['rev-parse', 'HEAD']).trim()
        },
      }
    },
    userFingerprint(): UserFingerprint {
      return {
        headRef: tryGitIn(repo, 'symbolic-ref', '--quiet', 'HEAD') ?? 'DETACHED',
        headOid: world.resolveIn(repo, 'HEAD'),
        status: lines(gitIn(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).join(
          '\n',
        ),
        stashCount: (tryGitIn(repo, 'stash', 'list') ?? '').split('\n').filter(Boolean).length,
        configDigest: digest(lines(gitIn(repo, ['config', '--local', '--list'])).join('\n')),
      }
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
  return world
}
