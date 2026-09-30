import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { CommandCancelled } from '../src/main/git-core'
import { getSnapshot } from '../src/main/git'
import { getGitHubIssues, getGitHubData } from '../src/main/github'
import {
  DirectGitHubTransport,
  GhGitHubTransport,
  GitHubTransportError,
  githubResponseCache,
  resetGitHubRateLimit,
  setGitHubTransport,
  type GitHubTransport,
  type GitHubGraphqlOptions,
  type GitHubRestResponse,
} from '../src/main/github-transport'
import { GitHubResponseCacheStore } from '../src/main/github-response-cache'
import { RepositoryWatcher } from '../src/main/git-watcher'
import { detectNativeStacksCapability, loadRepositoryNativeStacks } from '../src/main/native-stacks'
import { RepositoryScheduler } from '../src/main/repository-scheduler'
import {
  classifyRemoteMutation,
  RemoteMutationLedger,
  unknownRemoteOutcome,
} from '../src/main/remote-mutations'
import { RequestRegistry, performBackgroundRead } from '../src/main/request-registry'
import {
  classifyRemoteFailure,
  DEFAULT_INTERVALS,
  failureDelay,
  RepositorySyncCoordinator,
  type SyncClock,
  type SyncTimer,
} from '../src/main/sync-coordinator'
import { describeFreshness } from '../src/renderer/src/lib/live-sync'
import type {
  GitAction,
  PullRequest,
  RemoteFreshness,
  RepositorySnapshot,
} from '../src/shared/types'

/** The gh stand-in: a 304 block on stdout and a nonzero exit, like the real CLI. */
const GH_STUB =
  '#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    if-none-match:*)\n      printf \'HTTP/2.0 304 Not Modified\\netag: W/"gh-7"\\n\\n\'\n      exit 1\n      ;;\n  esac\ndone\nprintf \'HTTP/2.0 200 OK\\netag: W/"gh-7"\\ncontent-type: application/json\\n\\n{"number":7,"state":"open"}\\n\'\n'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Git Stacks test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Git Stacks test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  })
}

async function disposableRepository(): Promise<{
  root: string
  repo: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-live-sync-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Git Stacks test')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, 'shared.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Initial commit')
  return { root, repo, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * Watcher tests drive the real `fs.watch` and the real debounce timer: the
 * property under test is how the platform delivers events, which no fake clock
 * can stand in for. Waiting is still event-based, and the only wall-clock
 * deadlines below are failure guards and the settle window that proves a burst
 * produced exactly one refresh.
 */
class WatchLog {
  readonly reasons: string[] = []
  private waiters = new Map<
    Promise<void>,
    { match: (reason: string) => boolean; resolve: () => void }
  >()

  record = (reason: string): void => {
    this.reasons.push(reason)
    for (const [promise, waiter] of [...this.waiters]) {
      if (!waiter.match(reason)) continue
      this.waiters.delete(promise)
      waiter.resolve()
    }
  }

  waitFor(match: (reason: string) => boolean, guardMs = 10_000): Promise<void> {
    if (this.reasons.some(match)) return Promise.resolve()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.waiters.set(promise, { match, resolve })
    const guard = setTimeout(() => {
      this.waiters.delete(promise)
      reject(new Error(`No watcher event matched; saw ${JSON.stringify(this.reasons)}`))
    }, guardMs)
    promise.catch(() => {}).finally(() => clearTimeout(guard))
    return promise
  }
}

/** Runs every promise continuation already queued, without waiting on a clock. */
async function drainTurns(count = 8): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    const idle = Promise.withResolvers<void>()
    setImmediate(idle.resolve)
    await idle.promise
  }
}

/**
 * A wall-clock failure guard of the kind the file already allows: the arm owes
 * a re-resolution, and awaiting it unguarded would hang the whole suite
 * instead of naming the step that never came.
 */
function within(promise: Promise<void>, what: string, ms = 10_000): Promise<void> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Waited ${ms}ms for ${what}`)), ms).unref(),
    ),
  ])
}

function pullRequest(number: number): PullRequest {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    head: `feature-${number}`,
    base: 'main',
    state: 'OPEN',
    draft: false,
    checks: 'passing',
  }
}

function snapshotFixture(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    path: '/tmp/repository',
    name: 'widgets',
    currentBranch: 'main',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:acme/widgets.git',
    branches: [],
    pullRequests: [],
    files: [],
    stashes: [],
    rebaseInProgress: false,
    operation: null,
    stackOperation: null,
    headOid: 'a'.repeat(40),
    github: { available: true, message: '' },
    limits: { branchesAnalyzed: 0, branchesSkipped: 0, filesListed: 0, filesTruncated: false },
    capabilities: {
      bare: false,
      detachedHead: false,
      linkedWorktree: false,
      worktreeCount: 1,
      refStorage: 'files',
      refStorageDetail: null,
      sparseCheckout: false,
      sparseCheckoutCone: false,
      submodules: false,
      gitLfs: false,
      worktreeConfig: false,
      objectFormat: 'sha1',
      gitVersion: 'git version 2.52.0',
    },
    ...overrides,
  }
}

class ManualClock implements SyncClock {
  private current = 1_000_000
  private sequence = 0
  private timers = new Map<number, { at: number; run: () => void }>()

  now(): number {
    return this.current
  }

  setTimeout(run: () => void, ms: number): SyncTimer {
    this.sequence += 1
    this.timers.set(this.sequence, { at: this.current + ms, run })
    return this.sequence
  }

  clearTimeout(handle: SyncTimer | undefined): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  setInterval(): NodeJS.Timeout {
    throw new Error('the coordinator schedules no intervals')
  }

  clearInterval(): void {}

  /** Runs every timer due within `ms`, then drains the promises they started. */
  async advance(ms: number): Promise<void> {
    this.current += ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((left, right) => left[1].at - right[1].at)
      if (due.length === 0) break
      const [id, timer] = due[0]!
      this.timers.delete(id)
      timer.run()
      await drainTurns()
    }
    await drainTurns()
  }
}

interface Harness {
  coordinator: RepositorySyncCoordinator
  clock: ManualClock
  reads: string[]
  issueReads: () => number
  failWith: (error: unknown) => void
  pushed: {
    snapshot?: RepositorySnapshot
    issues?: RepositorySnapshot['issues']
    status?: RemoteFreshness
  }
}

function harness(snapshotFor?: (attempt: number) => RepositorySnapshot): Harness {
  const clock = new ManualClock()
  const reads: string[] = []
  const pushed: Harness['pushed'] = {}
  const state = { failure: null as unknown, attempts: 0, issueReads: 0 }
  const scheduler = new RepositoryScheduler()
  const reuseMarker = () => ({
    reason: 'A GitHub refresh is not due yet',
    fetchedAt: new Date(clock.now() - 10_000).toISOString(),
  })
  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: async (_repository, _signal, request) => {
        reads.push(request.github.remote)
        if (state.failure && request.github.remote !== 'reuse') throw state.failure
        state.attempts += 1
        return (
          snapshotFor?.(state.attempts) ??
          snapshotFixture({ githubStale: request.github.remote === 'reuse' ? reuseMarker() : null })
        )
      },
      readIssues: async () => {
        if (state.failure) throw state.failure
        state.issueReads += 1
        return [{ number: 7, title: 'Inbox item', url: 'https://github.com/acme/widgets/issues/7' }]
      },
      scheduler,
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 100 },
  )
  coordinator.onEvent((event) => {
    if (event.kind === 'snapshot' && event.snapshot) pushed.snapshot = event.snapshot
    if (event.kind === 'issues' && event.issues) pushed.issues = event.issues
    if (event.kind === 'status' && event.freshness) pushed.status = event.freshness
  })
  return {
    coordinator,
    clock,
    reads,
    pushed,
    issueReads: () => state.issueReads,
    failWith: (error: unknown) => {
      state.failure = error
    },
  }
}

test('a terminal commit produces one refresh for the whole burst it causes', async () => {
  const { repo, cleanup } = await disposableRepository()
  const log = new WatchLog()
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 150,
    maxDelayMs: 1_500,
    sweepMs: 0,
  })
  try {
    await watcher.start()
    await writeFile(join(repo, 'shared.txt'), 'edited\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Terminal commit')
    await log.waitFor((reason) => reason === 'change')
    // A commit rewrites the index, HEAD, its ref, and the reflog in a burst.
    // Asserting there is no second event is a claim about a window of quiet, so
    // the window itself is the observation: a guessed sleep would hide it.
    const quiet = Promise.withResolvers<void>()
    setTimeout(quiet.resolve, 900)
    await quiet.promise
    assert.deepEqual(log.reasons, ['change'])
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('a branch switch made outside the window is reported', async () => {
  const { repo, cleanup } = await disposableRepository()
  git(repo, 'branch', 'feature/external')
  const log = new WatchLog()
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 120,
    maxDelayMs: 1_200,
    sweepMs: 0,
  })
  try {
    await watcher.start()
    git(repo, 'checkout', 'feature/external')
    await log.waitFor((reason) => reason === 'change')
    assert.ok(log.reasons.every((reason) => reason === 'change'))
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('a moved repository is reported missing and picked up again when it returns', async () => {
  const { root, repo, cleanup } = await disposableRepository()
  const moved = join(root, 'renamed-workspace')
  const log = new WatchLog()
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 100,
    maxDelayMs: 800,
    sweepMs: 0,
  })
  try {
    await watcher.start()
    await rename(repo, moved)
    await log.waitFor((reason) => reason === 'missing')
    await rename(moved, repo)
    await log.waitFor((reason) => reason === 'restored')
    git(repo, 'branch', 'feature/after-move')
    git(repo, 'checkout', 'feature/after-move')
    await log.waitFor((reason) => reason === 'change')
    assert.deepEqual(log.reasons, ['missing', 'restored', 'change'])
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('a repository replaced at the same path re-arms the watch on the new directory', async () => {
  const { root, repo, cleanup } = await disposableRepository()
  const moved = join(root, 'moved-workspace')
  const replacement = join(root, 'replacement-workspace')
  await mkdir(replacement)
  git(replacement, 'init', '-b', 'main')
  git(replacement, 'config', 'user.name', 'Git Stacks test')
  git(replacement, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(replacement, 'shared.txt'), 'replacement\n')
  git(replacement, 'add', '.')
  git(replacement, 'commit', '-m', 'Replacement commit')

  const log = new WatchLog()
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 50,
    maxDelayMs: 800,
    sweepMs: 100,
  })
  try {
    await watcher.start()
    // The old tree is moved away and a different one takes the same path. The
    // subscriptions in place belong to the tree that moved, and no event ever
    // shows this path missing.
    await rename(repo, moved)
    await rename(replacement, repo)
    await log.waitFor((reason) => reason === 'replaced')

    // The new directory is what is watched now, so its worktree edits arrive.
    await writeFile(join(repo, 'shared.txt'), 'edited in the replacement\n')
    await log.waitFor((reason) => reason === 'change')
    assert.ok(
      !log.reasons.includes('missing'),
      'the replacement was never absent, so nothing was reported missing',
    )
  } finally {
    watcher.stop()
    await cleanup()
  }
})

/**
 * A worktree whose Git directory lives outside it, as a linked worktree's
 * does. Two of these swapped through a watched path leave two different Git
 * directories, so a resolution made for the displaced one is a directory that
 * belongs to nothing at the path any more, which is observable rather than a
 * path that merely happens to be spelled the same either way.
 */
async function separateGitWorktree(path: string, store: string, content: string): Promise<void> {
  await mkdir(path)
  git(path, 'init', '--separate-git-dir', store, '-b', 'main')
  git(path, 'config', 'user.name', 'Git Stacks test')
  git(path, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(path, 'shared.txt'), `${content}\n`)
  git(path, 'add', '.')
  git(path, 'commit', '-m', 'Commit')
}

/** The one lookup result `git rev-parse --absolute-git-dir` reports, read from the link. */
async function linkedGitDirectory(root: string): Promise<string[]> {
  return [(await readFile(join(root, '.git'), 'utf8')).replace(/^gitdir: /, '').trim()]
}

/**
 * A disposable workspace with four worktrees, each keeping its own external
 * Git directory, so any of them can be moved into the watched path.
 */
async function linkedGitWorkspace(): Promise<{
  root: string
  repo: string
  stores: string[]
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-watcher-replace-'))
  const stores = [0, 1, 2, 3].map((index) => join(root, `store-${index}`))
  const repo = join(root, 'workspace')
  await separateGitWorktree(repo, stores[0], 'tree 0')
  for (const [index, tree] of [0, 1, 2].map((i) => join(root, `tree-${i}`)).entries()) {
    await separateGitWorktree(tree, stores[index + 1], `tree ${index}`)
  }
  return { root, repo, stores, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * A settle window: the file's tests drive the real debounce, so "nothing was
 * reported" is observed over a quiet period rather than assumed.
 */
async function quietFor(ms = 700): Promise<void> {
  const quiet = Promise.withResolvers<void>()
  setTimeout(quiet.resolve, ms)
  await quiet.promise
}

test('a repository replaced while its Git directories are being resolved is watched on the new tree’s own Git directory', async () => {
  const { root, repo, stores, cleanup } = await linkedGitWorkspace()
  const log = new WatchLog()
  // The settle pass parks inside this lookup, which is the window a replacement
  // lands in: nothing is subscribed yet, so the replacement delivers no event.
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const resolvedRoots: number[] = []
  let lookups = 0
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 20,
    maxDelayMs: 200,
    // The sweep is the safety net this repair must not lean on, so it is off.
    sweepMs: 0,
    resolveGitDirectories: async (root) => {
      const directories = await linkedGitDirectory(root)
      lookups += 1
      resolvedRoots.push((await stat(root)).ino)
      if (lookups === 1) {
        entered.resolve()
        await release.promise
      }
      return directories
    },
  })

  try {
    const startPromise = watcher.start()
    await within(entered.promise, 'the first Git lookup to be entered')
    await rename(repo, join(root, 'held-workspace'))
    await rename(join(root, 'tree-0'), repo)
    release.resolve()
    await startPromise

    // The lookup that was in flight named the displaced tree's Git directory,
    // so the identity was rechecked and the lookup was run again for the tree
    // now at the path rather than committing the one that moved away.
    assert.deepEqual(
      resolvedRoots,
      [(await stat(join(root, 'held-workspace'))).ino, (await stat(repo)).ino],
      'the lookup is run again for the directory now at the path',
    )
    // Git reports the store through a realpath, so the directories are compared
    // by name: what matters is which tree's store is subscribed.
    const internals = watcher as unknown as { gitDirectories: string[] }
    assert.deepEqual(
      internals.gitDirectories.map((directory) => basename(directory)),
      [basename(stores[1])],
      'the subscribed Git directory belongs to the tree left at the path',
    )

    // A branch in the tree left at the path lands in its own external Git
    // directory, which is reported only because that directory is subscribed.
    git(repo, 'branch', 'feature/current')
    await log.waitFor((reason) => reason === 'change')

    // A branch in the tree that moved away lands in the directory the in-flight
    // lookup named, and nothing is watching it.
    await quietFor()
    const before = log.reasons.length
    git(join(root, 'held-workspace'), 'branch', 'feature/displaced')
    await quietFor()
    assert.equal(log.reasons.length, before, 'the displaced Git directory is not watched')
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('a root replaced on every attempt watches no Git directory rather than a displaced one', async () => {
  const { root, repo, cleanup } = await linkedGitWorkspace()
  const log = new WatchLog()
  // Every lookup is held open, so each attempt finds a different tree at the
  // path than the one it started against and none of them ever holds.
  const gates = [0, 1, 2].map(() => ({
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  }))
  let lookups = 0
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 20,
    maxDelayMs: 200,
    // With no sweep there is no later turn, so what stays armed here is
    // exactly what a bounded pass leaves behind.
    sweepMs: 0,
    resolveGitDirectories: async (root) => {
      const directories = await linkedGitDirectory(root)
      const gate = gates[Math.min(lookups, gates.length - 1)]
      lookups += 1
      gate.entered.resolve()
      await gate.release.promise
      return directories
    },
  })

  try {
    const startPromise = watcher.start()
    for (const [index, gate] of gates.entries()) {
      await within(gate.entered.promise, `Git lookup ${index + 1} to be entered`)
      await rename(repo, join(root, `moved-${index}`))
      await rename(join(root, `tree-${index}`), repo)
      gate.release.resolve()
    }
    // A root that never settles must not hold the pass open retrying forever.
    await startPromise
    assert.equal(lookups, gates.length, 'one lookup per replacement, then the pass gives up')

    // The worktree watch follows the path rather than a tree, so an edit in
    // the tree now at the path is still delivered.
    await writeFile(join(repo, 'shared.txt'), 'edited after the churn\n')
    await log.waitFor((reason) => reason === 'change')

    // No resolution ever held, so no Git directory is watched: a branch in each
    // displaced store is invisible, which is what refusing to adopt one buys.
    await quietFor()
    const before = log.reasons.length
    for (const index of [0, 1, 2]) {
      git(join(root, `moved-${index}`), 'branch', `feature/displaced-${index}`)
    }
    await quietFor()
    assert.equal(
      log.reasons.length,
      before,
      'no displaced Git directory is adopted when no resolution holds',
    )
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('the sweep settles a root the arm gave up on, on the tree left at the path', async () => {
  const { root, repo, cleanup } = await linkedGitWorkspace()
  const log = new WatchLog()
  const gates = [0, 1, 2].map(() => ({
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  }))
  let lookups = 0
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 20,
    maxDelayMs: 200,
    sweepMs: 120,
    resolveGitDirectories: async (root) => {
      const directories = await linkedGitDirectory(root)
      const gate = gates[Math.min(lookups, gates.length - 1)]
      lookups += 1
      gate.entered.resolve()
      await gate.release.promise
      return directories
    },
  })

  try {
    const startPromise = watcher.start()
    for (const [index, gate] of gates.entries()) {
      await within(gate.entered.promise, `Git lookup ${index + 1} to be entered`)
      await rename(repo, join(root, `moved-${index}`))
      await rename(join(root, `tree-${index}`), repo)
      gate.release.resolve()
    }
    await startPromise
    assert.equal(lookups, gates.length)

    // The sweep is the later turn that finishes a root the arm gave up on. Each
    // branch below lands in the store of the tree left at the path, so the
    // first one created after that turn is the one the watch can report.
    let settled = false
    for (let attempt = 0; attempt < 25 && !settled; attempt += 1) {
      const before = log.reasons.length
      git(repo, 'branch', `feature/settle-${attempt}`)
      await quietFor(120)
      settled = log.reasons.length > before
    }
    assert.ok(settled, 'the sweep settles the target on the tree left at the path')

    // Once settled, that tree’s own store is watched and the displaced ones
    // still are not.
    await quietFor()
    const before = log.reasons.length
    for (const index of [0, 1, 2]) {
      git(join(root, `moved-${index}`), 'branch', `feature/displaced-${index}`)
    }
    await quietFor()
    assert.equal(log.reasons.length, before, 'a displaced store is still not watched')
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('background reads overlap, and a mutation ends a stalled one instead of waiting', async () => {
  const scheduler = new RepositoryScheduler(2)
  let started = 0
  let settled = 0
  const stalled = scheduler.read('/repo', async (signal) => {
    started += 1
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
      setTimeout(resolve, 30_000)
    })
    settled += 1
    return 'aborted'
  })
  const concurrent = scheduler.read('/repo', async () => {
    started += 1
    return 'concurrent'
  })
  assert.equal(await concurrent, 'concurrent')
  assert.equal(await scheduler.mutate('/repo', async () => 'mutated'), 'mutated')
  assert.equal(settled, 1, 'the stalled read was ended, not waited on')
  assert.equal(started, 2)
  assert.equal(await stalled, 'aborted')
})

test('a mutation waits for the reads it ended to settle, without waiting on a stalled one', async () => {
  const scheduler = new RepositoryScheduler(2)
  const order: string[] = []
  // The abort only starts a read unwinding: it still owns the repository for
  // the turns that follow, so the mutation may not start inside that window.
  const running = Promise.withResolvers<void>()
  const unwinding = Promise.withResolvers<void>()
  const first = scheduler.read('/repo', async (signal) => {
    order.push('read-start')
    running.resolve()
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    await aborted.promise
    await unwinding.promise
    order.push('read-settled')
    return 'aborted'
  })
  const second = scheduler.read('/repo', async (signal) => {
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    await aborted.promise
    return 'aborted'
  })
  // The abort only reaches a read that is already running, so let both begin.
  await running.promise
  await drainTurns()
  const mutation = scheduler.mutate('/repo', async () => {
    order.push('mutation-start')
    return 'mutated'
  })
  await drainTurns()
  assert.deepEqual(order, ['read-start'], 'a read still unwinding owns the repository')
  unwinding.resolve()
  assert.equal(await mutation, 'mutated')
  assert.deepEqual(order, ['read-start', 'read-settled', 'mutation-start'])
  assert.deepEqual(await Promise.all([first, second]), ['aborted', 'aborted'])
})

test('mutations for one repository run in order, and reads wait for them', async () => {
  const scheduler = new RepositoryScheduler(2)
  const order: string[] = []
  const first = scheduler.mutate('/repo', async () => {
    order.push('first-start')
    await new Promise((resolve) => setImmediate(resolve))
    order.push('first-end')
  })
  const second = scheduler.mutate('/repo', async () => {
    order.push('second')
  })
  const read = scheduler.read('/repo', async () => {
    order.push('read')
  })
  await Promise.all([first, second, read])
  assert.deepEqual(order, ['first-start', 'first-end', 'second', 'read'])
})

test('a conditional read stores a validator and a 304 replays the stored body', async () => {
  const requested: (string | null)[] = []
  const cache = new GitHubResponseCacheStore()
  let calls = 0
  const fetchDouble = (async (_url: string | URL | Request, init?: RequestInit) => {
    requested.push(new Headers(init?.headers).get('if-none-match'))
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ number: 7, state: 'open' }), {
        status: 200,
        headers: {
          etag: 'W/"v7"',
          'x-ratelimit-remaining': '4999',
          'content-type': 'application/json',
        },
      })
    }
    return new Response(null, {
      status: 304,
      headers: { etag: 'W/"v7"', 'x-ratelimit-remaining': '4998' },
    })
  }) as typeof globalThis.fetch
  const transport = new DirectGitHubTransport({ token: 'token', fetch: fetchDouble, cache })
  // Only a display-grade caller opts in; an identity read leaves it unset.
  const displayRead = { path: 'repos/acme/pulls/7', cache: true }
  const first = await transport.rest<{ number: number; state: string }>(displayRead)
  assert.equal(first.status, 200)
  assert.equal(first.notModified, undefined)
  const second = await transport.rest<{ number: number; state: string }>(displayRead)
  assert.equal(requested[0], null, 'the first read had no validator to send')
  assert.equal(requested[1], 'W/"v7"', 'the second read asked whether the resource changed')
  assert.equal(second.status, 304)
  assert.equal(second.notModified, true)
  assert.deepEqual(second.data, { number: 7, state: 'open' })
  assert.equal(cache.stats().hits, 1)
})

test('the response cache is bounded and never answers a different request shape', async () => {
  const cache = new GitHubResponseCacheStore(2)
  const entry = (body: unknown) => ({ etag: null, lastModified: null, body, storedAt: new Date(0) })
  cache.set('a', entry(1))
  cache.set('b', entry(2))
  cache.set('c', entry(3))
  assert.equal(cache.size(), 2)
  assert.equal(cache.get('a'), null)
  assert.deepEqual(cache.get('b')?.body, 2)
})

test('a display refresh reads the native stacks capability conditionally and a preflight does not', async () => {
  const urls: string[] = []
  const validators: (string | null)[] = []
  const fetchDouble = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url))
    const headers = new Headers(init?.headers)
    validators.push(headers.get('if-none-match'))
    const rate = { 'x-ratelimit-remaining': '4999' }
    if (String(url).includes('per_page=1')) {
      if (headers.get('if-none-match') === 'W/"stacks-1"') {
        return new Response(null, { status: 304, headers: { etag: 'W/"stacks-1"', ...rate } })
      }
      return new Response('[]', {
        status: 200,
        headers: { etag: 'W/"stacks-1"', 'content-type': 'application/json', ...rate },
      })
    }
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json', ...rate },
    })
  }) as typeof globalThis.fetch

  const cache = githubResponseCache()
  cache.clear()
  setGitHubTransport(new DirectGitHubTransport({ token: 'token', fetch: fetchDouble, cache }))
  const origin = 'https://github.com/acme/widgets.git'
  try {
    const first = await loadRepositoryNativeStacks(origin, [])
    const second = await loadRepositoryNativeStacks(origin, [])
    assert.equal(first.available, true)
    assert.equal(second.available, true, 'a replayed body still reports the capability')
    const probes = urls.flatMap((url, index) => (url.includes('per_page=1') ? [index] : []))
    assert.equal(probes.length, 2, 'both refreshes asked the capability question')
    assert.equal(validators[probes[0]!], null, 'the first read had no validator to send')
    assert.equal(
      validators[probes[1]!],
      'W/"stacks-1"',
      'the second refresh asked GitHub whether the capability changed',
    )

    // A mutation's preflight reads GitHub itself: nothing is replayed to it.
    await detectNativeStacksCapability('acme', 'widgets')
    assert.equal(validators.at(-1), null, 'an identity read never sends a stored validator')
  } finally {
    setGitHubTransport(null)
    cache.clear()
    resetGitHubRateLimit()
  }
})

test('a lost network backs off, then recovers without the person asking', async () => {
  const coordinator = harness()
  coordinator.coordinator.attach('/tmp/repository', snapshotFixture())
  await coordinator.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.deepEqual(coordinator.reads, ['on-failure'])
  coordinator.failWith(new GitHubTransportError({ kind: 'network', detail: 'fetch failed' }))
  await coordinator.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.equal(coordinator.pushed.status?.state, 'offline')
  const beforeRetry = coordinator.reads.length
  // The first failure backs off once; the retry must not come sooner.
  await coordinator.clock.advance(failureDelay(1, DEFAULT_INTERVALS) - 1)
  assert.equal(coordinator.reads.length, beforeRetry, 'the retry waits for its backoff')
  coordinator.failWith(null)
  await coordinator.clock.advance(1)
  assert.equal(coordinator.pushed.status?.state, 'fresh')
})

test('a secondary rate limit parks the inbox refresh and recovers by itself', async () => {
  const coordinator = harness()
  coordinator.coordinator.attach('/tmp/repository', snapshotFixture())
  coordinator.coordinator.reportActivity({ focused: false, visible: true })
  coordinator.failWith(
    new GitHubTransportError({
      kind: 'secondary-rate-limit',
      detail: 'You have exceeded a secondary rate limit',
      rateLimit: {
        limit: 5000,
        remaining: 4980,
        reset: null,
        resource: 'core',
        retryAfterSeconds: 60,
      },
    }),
  )
  await coordinator.clock.advance(DEFAULT_INTERVALS.secondaryMs + 1)
  assert.equal(coordinator.pushed.status?.state, 'rate-limited')
  const parked = coordinator.issueReads()
  await coordinator.clock.advance(DEFAULT_INTERVALS.secondaryMs + 1)
  assert.equal(coordinator.issueReads(), parked, 'the inbox refresh stays parked while limited')
  coordinator.failWith(null)
  // The parked tier rechecks on its own schedule, and an answer lifts the park
  // to the health the pull-request data actually has: confirmed before the
  // rate limit, so it is fresh again.
  await coordinator.clock.advance(DEFAULT_INTERVALS.secondaryMs + 1)
  assert.equal(coordinator.pushed.status?.state, 'fresh')
})

test('an inbox refresh that recovers never calls unconfirmed pull-request data fresh', async () => {
  const coordinator = harness()
  // An unconfirmed snapshot still carries a time, so only the health its own
  // last refresh earned may be reported after the inbox recovers.
  coordinator.coordinator.attach(
    '/tmp/repository',
    snapshotFixture({
      github: { available: false, message: 'GitHub data has not been confirmed yet' },
      githubStale: {
        reason: 'GitHub data has not been confirmed yet',
        fetchedAt: new Date(coordinator.clock.now() - 60_000).toISOString(),
      },
    }),
  )
  coordinator.coordinator.reportActivity({ focused: false, visible: true })
  coordinator.failWith(
    new GitHubTransportError({
      kind: 'secondary-rate-limit',
      detail: 'You have exceeded a secondary rate limit',
      rateLimit: {
        limit: 5000,
        remaining: 4980,
        reset: null,
        resource: 'core',
        retryAfterSeconds: 60,
      },
    }),
  )
  await coordinator.clock.advance(DEFAULT_INTERVALS.secondaryMs + 1)
  assert.equal(coordinator.pushed.status?.state, 'rate-limited')
  coordinator.failWith(null)
  await coordinator.clock.advance(DEFAULT_INTERVALS.secondaryMs + 1)
  assert.ok(coordinator.issueReads(), 'the inbox read recovered')
  assert.equal(
    coordinator.pushed.status?.state,
    'stale',
    'an answer about issues says nothing about the pull requests on screen',
  )
  assert.match(coordinator.pushed.status?.detail ?? '', /not been confirmed/iu)
})

test('an expired token stops polling until the person refreshes', async () => {
  const coordinator = harness()
  coordinator.coordinator.attach('/tmp/repository', snapshotFixture())
  coordinator.failWith(
    new GitHubTransportError({ kind: 'unauthorized', detail: 'authentication is required' }),
  )
  await coordinator.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.equal(coordinator.pushed.status?.state, 'unauthorized')
  const attempts = coordinator.reads.length
  await coordinator.clock.advance(DEFAULT_INTERVALS.visibleMs * 4)
  assert.equal(coordinator.reads.length, attempts, 'polling does not continue without credentials')
  coordinator.failWith(null)
  const snapshot = await coordinator.coordinator.refreshNow()
  assert.equal(snapshot.currentBranch, 'main')
  assert.equal(coordinator.pushed.status?.state, 'fresh')
})

test('a filesystem change reads local Git without spending a GitHub request', async () => {
  const coordinator = harness()
  coordinator.coordinator.attach('/tmp/repository', snapshotFixture())
  coordinator.reads.length = 0
  coordinator.coordinator.notifyLocalChange()
  await coordinator.clock.advance(200)
  coordinator.coordinator.notifyLocalChange()
  await coordinator.clock.advance(200)
  assert.deepEqual(coordinator.reads, ['reuse', 'reuse'])
})

test('edits that arrive during a refresh collapse into one trailing refresh', async () => {
  const clock = new ManualClock()
  const gate = Promise.withResolvers<void>()
  let attempts = 0
  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: async () => {
        attempts += 1
        if (attempts === 1) await gate.promise
        return snapshotFixture()
      },
      readIssues: async () => [],
      scheduler: new RepositoryScheduler(),
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 100 },
  )
  coordinator.attach('/tmp/repository', snapshotFixture())
  coordinator.notifyLocalChange()
  await clock.advance(200)
  // Three more external edits land while the first read is still running.
  coordinator.notifyLocalChange()
  coordinator.notifyLocalChange()
  coordinator.notifyLocalChange()
  gate.resolve()
  // The trailing refresh is scheduled once the in-flight read settles, so the
  // window that contains it starts when the read finishes.
  await clock.advance(200)
  await clock.advance(200)
  assert.equal(attempts, 2, 'the burst collapsed into one trailing refresh')
})

/**
 * Builds the overlap a person's own refresh creates: the automatic read that
 * the interval started is still waiting when the manual one arrives, and it
 * answers only when the test releases it.
 */
function overlappingRefreshes(options: {
  /** What the older automatic read answers, once the manual one has answered. */
  older: RepositorySnapshot | Error
}) {
  const clock = new ManualClock()
  const automatic = Promise.withResolvers<RepositorySnapshot>()
  const reads: string[] = []
  let attempts = 0
  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: async (_repository, _signal, request) => {
        reads.push(request.github.remote)
        attempts += 1
        if (attempts === 1) return automatic.promise
        return snapshotFixture()
      },
      readIssues: async () => [],
      scheduler: new RepositoryScheduler(),
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 100 },
  )
  return {
    clock,
    reads,
    coordinator,
    settleOlder: async () => {
      if (options.older instanceof Error) automatic.reject(options.older)
      else automatic.resolve(options.older)
      await drainTurns()
    },
  }
}

/** What GitHub answers when the stored credentials no longer work. */
const rejectedCredentials = new GitHubTransportError({
  kind: 'unauthorized',
  detail: 'Bad credentials',
})

interface RunningSlot {
  running: Promise<unknown> | null
}

test('an older automatic failure never overwrites the newer manual refresh', async () => {
  const refresh = overlappingRefreshes({ older: rejectedCredentials })
  refresh.coordinator.attach('/tmp/repository', snapshotFixture())
  await refresh.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.deepEqual(refresh.reads, ['on-failure'], 'the automatic refresh is in flight')

  // The person's own refresh answers while the older read is still waiting.
  const manual = await refresh.coordinator.refreshNow()
  assert.deepEqual(refresh.reads, ['on-failure', 'live'])
  assert.equal(refresh.coordinator.freshness().state, 'fresh')
  assert.equal(manual.currentBranch, 'main')

  await refresh.settleOlder()
  assert.equal(
    refresh.coordinator.freshness().state,
    'fresh',
    'the older rejection says nothing about the answer now on screen',
  )
  const before = refresh.reads.length
  await refresh.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.equal(refresh.reads.length, before + 1, 'automatic polling must not stop')
})

test('an older failed payload never overwrites the newer manual refresh', async () => {
  const refresh = overlappingRefreshes({
    older: snapshotFixture({
      githubFailure: { kind: 'unauthorized', detail: 'Bad credentials' },
    }),
  })
  refresh.coordinator.attach('/tmp/repository', snapshotFixture())
  await refresh.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  await refresh.coordinator.refreshNow()
  assert.equal(refresh.coordinator.freshness().state, 'fresh')

  await refresh.settleOlder()
  assert.equal(
    refresh.coordinator.freshness().state,
    'fresh',
    'a superseded read that fell back to a failed payload must not set the state',
  )
})

test('an older read settling last does not release the newer refresh running', async () => {
  const clock = new ManualClock()
  const automatic = Promise.withResolvers<RepositorySnapshot>()
  const manual = Promise.withResolvers<RepositorySnapshot>()
  let attempts = 0
  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: async () => {
        attempts += 1
        return attempts === 1 ? automatic.promise : manual.promise
      },
      readIssues: async () => [],
      scheduler: new RepositoryScheduler(),
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 100 },
  )
  const running = () => (coordinator as unknown as RunningSlot).running
  coordinator.attach('/tmp/repository', snapshotFixture())
  await clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  const refreshNow = coordinator.refreshNow()
  await drainTurns()
  assert.notEqual(running(), null, 'the manual refresh is the running one')

  // The older read finishes while the manual one is still answering.
  automatic.resolve(snapshotFixture())
  await drainTurns()
  assert.notEqual(running(), null, 'a superseded read must not release the running refresh')

  manual.resolve(snapshotFixture())
  await refreshNow
  await drainTurns()
  assert.equal(running(), null, 'the newest refresh releases the lane it owned')
})

test('a refresh left over from a closed session cannot publish into the reopened repository', async () => {
  const refresh = overlappingRefreshes({ older: rejectedCredentials })
  refresh.coordinator.attach('/tmp/repository', snapshotFixture())
  await refresh.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)

  // The repository is closed and opened again at the same path, so the identity
  // the older read carries is the one the window is showing again.
  refresh.coordinator.detach()
  refresh.coordinator.attach('/tmp/repository', snapshotFixture())
  await refresh.settleOlder()
  assert.equal(
    refresh.coordinator.freshness().state,
    'fresh',
    "the reopened session must not inherit the closed one's failure",
  )
})

test('the newest failure still stops polling, so ordering never hides a real rejection', async () => {
  const clock = new ManualClock()
  const reads: string[] = []
  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: async (_repository, _signal, request) => {
        reads.push(request.github.remote)
        throw new GitHubTransportError({ kind: 'unauthorized', detail: 'Bad credentials' })
      },
      readIssues: async () => [],
      scheduler: new RepositoryScheduler(),
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 100 },
  )
  coordinator.attach('/tmp/repository', snapshotFixture())
  await assert.rejects(coordinator.refreshNow(), /Refresh failed/)
  assert.equal(coordinator.freshness().state, 'unauthorized')
  const attempts = reads.length
  await clock.advance(DEFAULT_INTERVALS.visibleMs * 4)
  assert.equal(reads.length, attempts, 'the newest rejection still stops automatic polling')
})

test('reconnecting never replays a high-impact mutation that lost its answer', async () => {
  const coordinator = harness()
  coordinator.coordinator.attach('/tmp/repository', snapshotFixture())
  const merge: GitAction = {
    type: 'merge',
    ref: 'refs/heads/feature/one',
    expectedHead: 'a'.repeat(40),
    expectedHeadRef: 'refs/heads/feature/one',
  }
  assert.ok(
    coordinator.coordinator.recordMutationFailure(
      merge,
      new GitHubTransportError({ kind: 'network', detail: 'fetch failed' }),
    ),
  )
  coordinator.failWith(new GitHubTransportError({ kind: 'network', detail: 'fetch failed' }))
  await coordinator.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  coordinator.failWith(null)
  await coordinator.clock.advance(failureDelay(2, DEFAULT_INTERVALS))
  const pending = coordinator.pushed.status?.pendingMutations ?? []
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.label, 'Merge feature/one')
  // Every read since the failure was a read; nothing re-sent the mutation.
  assert.deepEqual(coordinator.reads, ['on-failure', 'on-failure'])
  assert.equal(coordinator.coordinator.dismissPendingMutation(pending[0]!.id), true)
  assert.equal(coordinator.pushed.status?.pendingMutations.length, 0)
})

test('a request GitHub rejected proves the mutation did not apply and is not listed', () => {
  const ledger = new RemoteMutationLedger()
  const merge: GitAction = {
    type: 'merge',
    ref: 'refs/heads/x',
    expectedHead: 'a'.repeat(40),
    expectedHeadRef: 'refs/heads/x',
  }
  assert.equal(
    ledger.recordFailure(
      merge,
      new GitHubTransportError({ kind: 'conflict', detail: 'not mergeable' }),
    ),
    null,
  )
  assert.equal(
    ledger.recordFailure(
      { type: 'createPr', title: 't', body: 'b', base: 'main', draft: false },
      new GitHubTransportError({ kind: 'unauthorized', detail: 'authentication is required' }),
    ),
    null,
  )
  assert.equal(
    ledger.recordFailure(
      merge,
      new GitHubTransportError({ kind: 'network', detail: 'fetch failed' }),
    )?.kind,
    'merge',
  )
  assert.equal(unknownRemoteOutcome(new Error('fatal: not a git repository')), null)
})

test('only actions that change remote state are treated as high impact', () => {
  assert.equal(classifyRemoteMutation({ type: 'stage', paths: [] }), null)
  assert.equal(
    classifyRemoteMutation({
      type: 'commit',
      message: 'm',
      amend: false,
      expectedHead: null,
      expectedHeadRef: 'r',
    }),
    null,
  )
  assert.equal(classifyRemoteMutation({ type: 'closePr', number: 3 }), null)
  assert.equal(classifyRemoteMutation({ type: 'push' }), null)
  assert.equal(
    classifyRemoteMutation({ type: 'deleteRemoteBranch', ref: 'refs/heads/x', expectedOid: 'a' }),
    'delete',
  )
  assert.equal(
    classifyRemoteMutation({ type: 'updatePr', number: 4, title: 't', body: 'b', draft: false }),
    'retarget',
  )
})

test('a GitHub read that cannot answer is reported instead of shown as current', async () => {
  const { repo, cleanup } = await disposableRepository()
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
  try {
    const snapshot = await getSnapshot(repo)
    assert.equal(snapshot.github.available, false)
    assert.ok(snapshot.githubStale)
    assert.equal(snapshot.pullRequests.length, 0)
  } finally {
    await cleanup()
  }
})

test('refreshed pull requests reach the pushed snapshot with their freshness', async () => {
  const coordinator = harness((attempt) =>
    snapshotFixture({
      pullRequests: [pullRequest(attempt)],
      githubStale:
        attempt > 1
          ? {
              reason: 'A GitHub refresh is not due yet',
              fetchedAt: new Date(coordinator.clock.now() - 60_000).toISOString(),
            }
          : null,
    }),
  )
  coordinator.coordinator.attach('/tmp/repository', snapshotFixture())
  await coordinator.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.equal(coordinator.pushed.snapshot?.pullRequests[0]?.number, 1)
  assert.equal(coordinator.pushed.snapshot?.remote?.state, 'fresh')
  await coordinator.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.equal(coordinator.pushed.snapshot?.pullRequests[0]?.number, 2)
})

test('the freshness badge names its state and the age of the data', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z')
  const fresh = describeFreshness(
    {
      state: 'fresh',
      fetchedAt: '2026-09-28T11:58:00.000Z',
      checkedAt: '2026-09-28T11:58:00.000Z',
      detail: null,
      rateLimitReset: null,
      pendingMutations: [],
    },
    now,
  )
  assert.equal(fresh.label, 'GitHub fresh')
  assert.match(fresh.detail, /confirmed 2m ago/iu)

  const offline = describeFreshness(
    {
      state: 'offline',
      fetchedAt: '2026-09-28T11:00:00.000Z',
      checkedAt: '2026-09-28T11:30:00.000Z',
      detail: 'fetch failed',
      rateLimitReset: null,
      pendingMutations: [
        {
          id: '1',
          kind: 'merge',
          label: 'Merge feature/one',
          reason: 'fetch failed',
          failedAt: '2026-09-28T11:30:00.000Z',
        },
      ],
    },
    now,
  )
  assert.equal(offline.label, 'GitHub offline')
  assert.match(offline.detail, /Local Git still works/iu)
  assert.match(offline.detail, /will not be retried automatically/iu)

  const limited = describeFreshness(
    {
      state: 'rate-limited',
      fetchedAt: null,
      checkedAt: null,
      detail: null,
      rateLimitReset: '2026-09-28T12:30:00.000Z',
      pendingMutations: [],
    },
    now,
  )
  assert.match(limited.detail, /rate limited; polling resumes in 30 min/iu)
  assert.equal(describeFreshness(undefined, now).label, 'GitHub unknown')
})

test('failures classify into the states the badge shows', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z')
  assert.deepEqual(
    classifyRemoteFailure('You have exceeded a secondary rate limit', {
      kind: 'secondary-rate-limit',
      remaining: 4000,
      reset: null,
    }),
    {
      state: 'rate-limited',
      detail: 'You have exceeded a secondary rate limit',
      resumeAt: null,
      secondaryOnly: true,
    },
  )
  assert.equal(
    classifyRemoteFailure('API rate limit exceeded', {
      kind: 'rate-limited',
      remaining: 0,
      reset: new Date(now + 60_000),
    }).resumeAt,
    now + 60_000,
  )
  assert.equal(
    classifyRemoteFailure('authentication is required', {
      kind: 'unauthorized',
      remaining: 4999,
      reset: null,
    }).state,
    'unauthorized',
  )
  assert.equal(
    classifyRemoteFailure('network request failed', {
      kind: 'network',
      remaining: null,
      reset: null,
    }).state,
    'offline',
  )
  assert.equal(
    classifyRemoteFailure('no origin remote is configured', {
      kind: null,
      remaining: null,
      reset: null,
    }).state,
    'stale',
  )
})

test('the freshness badge renders every state in words, not colour alone', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { RemoteFreshnessBadge } = await import('../src/renderer/src/components/remote-freshness')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const at = (state: RemoteFreshness['state'], fetchedAt: string | null) =>
    renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(RemoteFreshnessBadge, {
          freshness: {
            state,
            fetchedAt,
            checkedAt: fetchedAt,
            detail: state === 'offline' ? 'fetch failed' : null,
            rateLimitReset: null,
            pendingMutations: [],
          },
          now: Date.parse('2026-09-28T12:00:00.000Z'),
        }),
      ),
    )
  assert.match(at('fresh', '2026-09-28T11:59:00.000Z'), /GitHub fresh/)
  assert.match(at('offline', '2026-09-28T11:00:00.000Z'), /GitHub offline/)
  assert.match(at('rate-limited', null), /GitHub rate limited/)
  assert.match(at('unauthorized', null), /authentication failed/)
  assert.match(at('stale', '2026-09-28T11:00:00.000Z'), /GitHub stale/)
  // Colour never carries the state on its own: the sentence is in the markup.
  assert.match(at('offline', '2026-09-28T11:00:00.000Z'), /Local Git still works/)
})

test('a live snapshot read that cannot reach GitHub never reuses the confirmed payload', async () => {
  const { repo, cleanup } = await disposableRepository()
  const previous = { ...process.env }
  // Point the real transport at a closed port with credentials present, so the
  // read fails in the transport rather than in a double.
  process.env.GIT_STACKS_GITHUB_API_URL = 'http://127.0.0.1:9'
  process.env.GIT_STACKS_GITHUB_TRANSPORT = 'direct'
  process.env.GIT_STACKS_GITHUB_TOKEN = 'test-token'
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
  try {
    const live = await getSnapshot(repo, undefined, undefined, 'live')
    assert.equal(live.github.available, false, 'a live read that failed is not available')
    assert.deepEqual(live.pullRequests, [], 'no older payload is passed off as a live answer')
    assert.equal(live.githubStale?.reason, live.github.message)
    // The failure is typed and reported, so backoff has something to act on.
    assert.ok(live.githubFailure, 'the snapshot carries why the read failed')
    assert.match(live.githubFailure?.detail ?? '', /fetch failed|ECONNREFUSED|network/iu)

    // A background refresh of the same repository may fall back, and says so.
    const background = await getSnapshot(repo, undefined, undefined, 'on-failure')
    assert.equal(background.github.available, false)
    assert.ok(background.githubFailure)
  } finally {
    Object.assign(process.env, previous)
    await cleanup()
  }
})

test('a failed issue read keeps the confirmed inbox and reports why it is unconfirmed', async () => {
  const { repo, cleanup } = await disposableRepository()
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
  const state = { issuesFail: false }
  class PartialTransport implements GitHubTransport {
    readonly kind = 'direct' as const
    async rest<T = unknown>(): Promise<GitHubRestResponse<T>> {
      return {
        status: 404,
        data: {} as T,
        rateLimit: {
          limit: 5000,
          remaining: 4999,
          reset: null,
          resource: 'core',
          retryAfterSeconds: null,
        },
      }
    }
    async paginate<T = unknown>(): Promise<T[]> {
      return []
    }
    async graphql<T = Record<string, unknown>>(query: string): Promise<T> {
      if (!query.includes('pullRequests(')) {
        if (state.issuesFail) {
          throw new GitHubTransportError({ kind: 'network', detail: 'fetch failed' })
        }
        return {
          repository: {
            issues: {
              nodes: [{ number: 11, title: 'Confirmed inbox item', url: 'https://x/11' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        } as T
      }
      return {
        repository: {
          pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      } as T
    }
  }
  setGitHubTransport(new PartialTransport())
  try {
    const confirmed = await getSnapshot(repo, undefined, undefined, 'on-failure')
    assert.equal(confirmed.github.available, true)
    assert.deepEqual(
      confirmed.issues?.map((issue) => issue.number),
      [11],
    )

    // The pull requests still answer; only the issue read is lost.
    state.issuesFail = true
    const partial = await getSnapshot(repo, undefined, undefined, 'on-failure')
    assert.equal(partial.github.available, true, 'the pull-request read did answer')
    assert.equal(partial.githubStale, null)
    assert.deepEqual(
      partial.issues?.map((issue) => issue.number),
      [11],
      'an unread inbox is not an empty inbox',
    )
    assert.match(partial.issuesMessage ?? '', /fetch failed/iu)

    // The failed read never became the confirmed payload, so a read that does
    // not ask GitHub still shows the last confirmed inbox without a failure.
    const reused = await getSnapshot(repo, undefined, undefined, 'reuse')
    assert.deepEqual(
      reused.issues?.map((issue) => issue.number),
      [11],
    )
    assert.equal(reused.issuesMessage, '')
  } finally {
    setGitHubTransport(null)
    await cleanup()
  }
})

/**
 * The overlap a person's own refresh creates, driven through the real snapshot
 * reader: the automatic read the interval started is still answering when the
 * manual one arrives, and the automatic one lands afterwards still carrying its
 * older answer. Each read is identified by the signal it was handed, so the
 * transport holds exactly the older read open instead of guessing from
 * call order.
 */
test('an older overlapping read never replaces the payload a newer read confirmed', async () => {
  const { repo, cleanup } = await disposableRepository()
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
  type Session = 'older' | 'newer'
  const sessions = new WeakMap<AbortSignal, Session>()
  const answers: Record<Session, { pullRequest: number; issue: number }> = {
    older: { pullRequest: 100, issue: 10 },
    newer: { pullRequest: 101, issue: 11 },
  }
  const olderReachedGitHub = Promise.withResolvers<void>()
  const releaseOlder = Promise.withResolvers<void>()
  class OverlappingTransport implements GitHubTransport {
    readonly kind = 'direct' as const
    async rest<T = unknown>(): Promise<GitHubRestResponse<T>> {
      return {
        status: 404,
        data: {} as T,
        rateLimit: {
          limit: 5000,
          remaining: 4999,
          reset: null,
          resource: 'core',
          retryAfterSeconds: null,
        },
      }
    }
    async paginate<T = unknown>(): Promise<T[]> {
      return []
    }
    async graphql<T = Record<string, unknown>>(
      query: string,
      _variables: Record<string, unknown> = {},
      options: GitHubGraphqlOptions = {},
    ): Promise<T> {
      const session: Session = (options.signal && sessions.get(options.signal)) ?? 'newer'
      const answer = answers[session]
      const pullRequests = query.includes('pullRequests(')
      if (session === 'older') {
        if (pullRequests) olderReachedGitHub.resolve()
        await releaseOlder.promise
      }
      return (
        pullRequests
          ? {
              repository: {
                pullRequests: {
                  nodes: [
                    {
                      number: answer.pullRequest,
                      title: `Pull request ${answer.pullRequest}`,
                      url: `https://github.com/acme/widgets/pull/${answer.pullRequest}`,
                      headRefName: `feature-${answer.pullRequest}`,
                      headRefOid: `oid-${answer.pullRequest}`,
                      baseRefName: 'main',
                      isDraft: false,
                      state: 'OPEN',
                      headRepository: { nameWithOwner: 'acme/widgets' },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }
          : {
              repository: {
                issues: {
                  nodes: [
                    {
                      number: answer.issue,
                      title: `Issue ${answer.issue}`,
                      url: `https://github.com/acme/widgets/issues/${answer.issue}`,
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }
      ) as T
    }
  }
  setGitHubTransport(new OverlappingTransport())
  resetGitHubRateLimit()
  const clock = new ManualClock()
  const scheduler = new RepositoryScheduler()
  const registry = new RequestRegistry()
  const emitted: RepositorySnapshot[] = []
  const reads = new Map<string, Promise<RepositorySnapshot>>()
  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: (root, signal, request) =>
        performBackgroundRead(
          registry,
          root,
          signal,
          (readSignal) => {
            // The refresh the person asked for is the newer read; the interval's
            // own automatic read is the older one already in flight.
            sessions.set(readSignal, request.requestId === 'refresh' ? 'newer' : 'older')
            const read = getSnapshot(root, readSignal, undefined, request.github.remote)
            reads.set(request.requestId, read)
            return read
          },
          request.requestId,
        ),
      readIssues: async () => [],
      scheduler,
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 10 },
  )
  /** The read the coordinator started under this request id, once it exists. */
  const readStarted = (requestId: string): Promise<RepositorySnapshot> => {
    const read = reads.get(requestId)
    assert.ok(read, `the ${requestId} read started`)
    return read
  }
  coordinator.onEvent((event) => {
    if (event.kind === 'snapshot' && event.snapshot) emitted.push(event.snapshot)
  })
  try {
    const initial = await getSnapshot(repo, undefined, undefined, 'reuse')
    coordinator.attach(repo, initial)
    await clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
    await olderReachedGitHub.promise
    const olderRead = readStarted('sync-refresh')

    // The person's own refresh answers with the newer data while the older
    // automatic read is still waiting for its answer.
    const manual = await coordinator.refreshNow()
    assert.deepEqual(
      manual.pullRequests.map((request) => request.number),
      [101],
    )
    assert.deepEqual(
      manual.issues?.map((issue) => issue.number),
      [11],
    )
    assert.equal(coordinator.freshness().state, 'fresh')

    // The older read answers only now, with the data that was already stale
    // when the newer one confirmed.
    releaseOlder.resolve()
    await olderRead
    await drainTurns()
    assert.equal(
      coordinator.freshness().state,
      'fresh',
      'the superseded read publishes nothing, and nothing is left half-published',
    )

    // A local-only refresh reuses what was confirmed, so it must show the newer
    // pull requests and inbox rather than the older read that landed last.
    coordinator.notifyLocalChange()
    emitted.length = 0
    await clock.advance(DEFAULT_INTERVALS.localSettleMs + 1)
    await readStarted('sync-local')
    await drainTurns()
    const reused = emitted[emitted.length - 1]
    assert.ok(reused, 'the local refresh published a snapshot')
    assert.deepEqual(
      reused.pullRequests.map((request) => request.number),
      [101],
      'the older read did not become the confirmed payload',
    )
    assert.deepEqual(
      reused.issues?.map((issue) => issue.number),
      [11],
      'the confirmed inbox is the newer one',
    )
  } finally {
    setGitHubTransport(null)
    coordinator.detach()
    await cleanup()
    resetGitHubRateLimit()
  }
})

test('the conditional cache is never consulted for a read that did not opt in', async () => {
  const requested: (string | null)[] = []
  const cache = new GitHubResponseCacheStore()
  const fetchDouble = (async (_url: string | URL | Request, init?: RequestInit) => {
    requested.push(new Headers(init?.headers).get('if-none-match'))
    return new Response(JSON.stringify({ number: 7, state: 'open' }), {
      status: 200,
      headers: { etag: 'W/v7', 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  const transport = new DirectGitHubTransport({ token: 'token', fetch: fetchDouble, cache })
  await transport.rest({ path: 'repos/acme/pulls/7' })
  const again = await transport.rest({ path: 'repos/acme/pulls/7' })
  assert.equal(again.status, 200, 'an identity read gets a real answer, not a replay')
  assert.deepEqual(requested, [null, null], 'no validator is sent unless the caller opted in')
  assert.equal(cache.size(), 0, 'nothing is stored for a caller that did not opt in')
})

test('the gh path resolves a 304 that arrived with a nonzero exit', async () => {
  const { chmod, writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-gh-304-'))
  const fake = join(root, 'gh')
  // A stand-in for the real executable: the second call carries a validator, so
  // it prints the block gh prints and exits nonzero exactly as gh does.
  await writeFile(fake, GH_STUB, 'utf8')
  await chmod(fake, 0o755)
  const previous = process.env.PATH
  const cache = new GitHubResponseCacheStore()
  process.env.PATH = `${root}:${previous ?? ''}`
  try {
    const transport = new GhGitHubTransport({ env: process.env, cache })
    const displayRead = { path: 'repos/acme/pulls/7', cache: true }
    const first = await transport.rest<{ number: number }>(displayRead)
    assert.equal(first.status, 200)
    const second = await transport.rest<{ number: number }>(displayRead)
    assert.equal(second.status, 304, 'a nonzero gh exit still resolved its 304 block')
    assert.equal(second.notModified, true)
    assert.deepEqual(second.data, { number: 7, state: 'open' })
  } finally {
    process.env.PATH = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('observable local commit during rate-limit block with zero added remote calls and unchanged remote health', async () => {
  const resetTime = new Date(Date.now() + 1800_000)
  const coordinatorHarness = harness((attempt) => {
    return snapshotFixture({
      headOid: `commit-${attempt}`,
      branches: [
        {
          ref: 'refs/heads/main',
          name: 'main',
          current: true,
          remote: false,
          upstream: null,
          upstreamRef: null,
          ahead: attempt,
          behind: 0,
          subject: `Commit #${attempt}`,
          updatedAt: new Date().toISOString(),
          parent: null,
          parentBehind: null,
          pr: null,
        },
      ],
    })
  })
  const { coordinator, clock, reads, pushed, failWith } = coordinatorHarness
  coordinator.attach('/tmp/repository', snapshotFixture())
  failWith(
    new GitHubTransportError({
      kind: 'rate-limited',
      detail: 'API rate limit exceeded',
      rateLimit: {
        limit: 5000,
        remaining: 0,
        reset: resetTime,
        resource: 'core',
        retryAfterSeconds: 1800,
      },
    }),
  )
  // Advance to remote refresh tier: the remote read fails and records rate-limited
  await clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.equal(coordinator.freshness().state, 'rate-limited')
  assert.equal(coordinator.freshness().rateLimitReset, resetTime.toISOString())
  assert.deepEqual(reads, ['on-failure'])

  // Now an external local commit lands!
  coordinator.notifyLocalChange()
  await clock.advance(DEFAULT_INTERVALS.localSettleMs + 1)

  // 1. Local commit is observable in the pushed snapshot
  assert.ok(pushed.snapshot)
  assert.equal(pushed.snapshot.branches[0].subject, 'Commit #1')
  // 2. ZERO added remote calls: only 'reuse' was issued
  assert.deepEqual(reads, ['on-failure', 'reuse'])
  // 3. Remote health and rate-limit reset remain completely unchanged
  assert.equal(coordinator.freshness().state, 'rate-limited')
  assert.equal(pushed.snapshot?.remote?.state, 'rate-limited')
  assert.equal(pushed.snapshot?.remote?.rateLimitReset, resetTime.toISOString())

  // Advance time: polling is still parked waiting for the reset time
  await clock.advance(DEFAULT_INTERVALS.visibleMs * 2)
  assert.deepEqual(reads, ['on-failure', 'reuse'], 'no remote polling while rate limited')
})

test('observable local commit during auth block with zero added remote calls and unchanged remote health', async () => {
  const coordinatorHarness = harness((attempt) => {
    return snapshotFixture({
      headOid: `commit-${attempt}`,
      branches: [
        {
          ref: 'refs/heads/main',
          name: 'main',
          current: true,
          remote: false,
          upstream: null,
          upstreamRef: null,
          ahead: attempt,
          behind: 0,
          subject: `Auth-blocked commit #${attempt}`,
          updatedAt: new Date().toISOString(),
          parent: null,
          parentBehind: null,
          pr: null,
        },
      ],
    })
  })
  const { coordinator, clock, reads, pushed, failWith } = coordinatorHarness
  coordinator.attach('/tmp/repository', snapshotFixture())
  failWith(
    new GitHubTransportError({
      kind: 'unauthorized',
      detail: 'Bad credentials',
    }),
  )
  await clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  assert.equal(coordinator.freshness().state, 'unauthorized')
  assert.deepEqual(reads, ['on-failure'])

  // Local change arrives
  coordinator.notifyLocalChange()
  await clock.advance(DEFAULT_INTERVALS.localSettleMs + 1)

  // 1. Observable local commit
  assert.ok(pushed.snapshot)
  assert.equal(pushed.snapshot.branches[0].subject, 'Auth-blocked commit #1')
  // 2. Zero remote calls
  assert.deepEqual(reads, ['on-failure', 'reuse'])
  // 3. Remote health unchanged
  assert.equal(pushed.snapshot?.remote?.state, 'unauthorized')

  // Focus changes must not trigger remote reads while unauthorized
  coordinator.reportActivity({ focused: true, visible: true })
  await clock.advance(DEFAULT_INTERVALS.visibleMs * 2)
  assert.deepEqual(
    reads,
    ['on-failure', 'reuse'],
    'unauthorized state suppresses remote reads on activity',
  )
})

test('getSnapshot remote reuse never contacts GitHub even when no confirmed data exists', async () => {
  const { repo, cleanup } = await disposableRepository()
  const previous = { ...process.env }
  process.env.GIT_STACKS_GITHUB_API_URL = 'http://127.0.0.1:9'
  try {
    const snapshot = await getSnapshot(repo, undefined, undefined, 'reuse')
    assert.equal(snapshot.github.available, false)
    assert.equal(snapshot.githubStale?.reason, 'GitHub data has not been confirmed yet')
    assert.equal(
      snapshot.githubFailure,
      null,
      'reuse never reports a failure because no request was made',
    )
  } finally {
    Object.assign(process.env, previous)
    await cleanup()
  }
})

test('real repository watcher fires coordinator during rate limit and delivers local commit with unchanged remote health', async () => {
  const { repo, cleanup } = await disposableRepository()
  const resetTime = new Date(Date.now() + 3600_000)
  const reads: string[] = []
  const snapshots: RepositorySnapshot[] = []
  const clock = new ManualClock()
  const scheduler = new RepositoryScheduler()

  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: async (r, signal, request) => {
        reads.push(request.github.remote)
        return getSnapshot(r, signal, undefined, request.github.remote)
      },
      readIssues: async () => [],
      scheduler,
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 50 },
  )

  const watcher = new RepositoryWatcher(repo, () => coordinator.notifyLocalChange(), {
    debounceMs: 50,
    maxDelayMs: 200,
    sweepMs: 0,
  })

  coordinator.onEvent((event) => {
    if (event.kind === 'snapshot' && event.snapshot) snapshots.push(event.snapshot)
  })

  try {
    await watcher.start()
    const initial = await getSnapshot(repo, undefined, undefined, 'reuse')
    coordinator.attach(repo, initial)

    // Simulate rate-limited state
    coordinator['recordFailure'](
      new GitHubTransportError({
        kind: 'rate-limited',
        detail: 'Rate limit hit',
        rateLimit: {
          limit: 5000,
          remaining: 0,
          reset: resetTime,
          resource: 'core',
          retryAfterSeconds: 3600,
        },
      }),
      'remote',
    )
    assert.equal(coordinator.freshness().state, 'rate-limited')
    reads.length = 0

    // Make a real git commit using real Git
    git(repo, 'commit', '--allow-empty', '-m', 'Commit made during rate limit')

    // Wait for the watcher to observe filesystem change and notify coordinator
    const observed = Promise.withResolvers<RepositorySnapshot>()
    const unsubscribe = coordinator.onEvent((event) => {
      if (
        event.kind === 'snapshot' &&
        event.snapshot?.branches.some((b) => b.subject === 'Commit made during rate limit')
      ) {
        observed.resolve(event.snapshot)
      }
    })

    // Advance clock in small increments until watcher triggers and settle completes
    let elapsed = 0
    while (elapsed < 3000) {
      await clock.advance(50)
      const winner = await Promise.race([
        observed.promise.then((s) => s),
        new Promise<null>((res) => setTimeout(() => res(null), 50)),
      ])
      if (winner) break
      elapsed += 50
    }
    const finalSnapshot = await observed.promise
    unsubscribe()

    assert.ok(finalSnapshot)
    assert.equal(
      finalSnapshot.branches.some((b) => b.subject === 'Commit made during rate limit'),
      true,
    )
    // Verify zero remote calls: only 'reuse' was called
    assert.ok(reads.length >= 1)
    assert.ok(reads.every((r) => r === 'reuse'))
    // Remote health is unchanged
    assert.equal(finalSnapshot.remote?.state, 'rate-limited')
    assert.equal(finalSnapshot.remote?.rateLimitReset, resetTime.toISOString())
  } finally {
    await watcher.stop()
    coordinator.detach()
    await cleanup()
  }
})

test('worktree file edit or creation without git triggers the watcher and notifies coordinator', async () => {
  const { repo, cleanup } = await disposableRepository()
  const log = new WatchLog()
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 50,
    maxDelayMs: 200,
    sweepMs: 0,
  })
  try {
    await watcher.start()

    // 1. Create a brand new untracked file directly in the worktree WITHOUT running git:
    await writeFile(join(repo, 'untracked.txt'), 'hello from worktree')
    await log.waitFor((reason) => reason === 'change')

    // 2. Edit an existing tracked file directly in the worktree WITHOUT running git:
    await writeFile(join(repo, 'shared.txt'), 'modified without git\n')
    await log.waitFor((reason) => reason === 'change')
  } finally {
    await watcher.stop()
    await cleanup()
  }
})

// These two drive the real `fs.watch` of a platform that refuses a recursive
// one. Only the sweep can report either change, so waiting for the event is
// waiting for the sweep; the debounce is the one real delay the watcher owns.
test('a nested worktree edit schedules a refresh where no recursive watch is available', async () => {
  const { repo, cleanup } = await disposableRepository()
  await mkdir(join(repo, 'src', 'main'), { recursive: true })
  await writeFile(join(repo, 'src', 'main', 'nested.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Add a nested file')
  const log = new WatchLog()
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 20,
    maxDelayMs: 100,
    sweepMs: 40,
    recursiveWatch: false,
  })
  try {
    await watcher.start()
    await writeFile(join(repo, 'src', 'main', 'nested.txt'), 'two\n')
    await log.waitFor((reason) => reason === 'change')
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('a nested loose ref schedules a refresh where no recursive watch is available', async () => {
  const { repo, cleanup } = await disposableRepository()
  // A ref below a directory Git already created: no watch on an ancestor of
  // `refs/heads/feature/nested` delivers an event for it.
  git(repo, 'update-ref', 'refs/heads/feature/base', 'HEAD')
  const log = new WatchLog()
  const watcher = new RepositoryWatcher(repo, (event) => log.record(event.reason), {
    debounceMs: 20,
    maxDelayMs: 100,
    sweepMs: 40,
    recursiveWatch: false,
  })
  try {
    await watcher.start()
    // The new ref lands below the existing directory, unseen by any watch.
    git(repo, 'update-ref', 'refs/heads/feature/nested', 'HEAD')
    await log.waitFor((reason) => reason === 'change')
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('actual production performBackgroundRead forwards scheduler cancellation to in-flight snapshot read during mutation', async () => {
  const scheduler = new RepositoryScheduler()
  const registry = new RequestRegistry()
  const root = '/tmp/repo-scheduler-test'

  const readStarted = Promise.withResolvers<void>()
  const readCancelled = Promise.withResolvers<boolean>()

  // Simulate an in-flight background snapshot read wired through the actual production adapter
  const backgroundTask = scheduler.read(root, (schedulerSignal) =>
    performBackgroundRead(
      registry,
      root,
      schedulerSignal,
      async (combinedSignal) => {
        readStarted.resolve()
        return new Promise<string>((resolve, reject) => {
          combinedSignal.addEventListener(
            'abort',
            () => {
              readCancelled.resolve(combinedSignal.aborted)
              reject(new Error('Operation cancelled by scheduler'))
            },
            { once: true },
          )
        })
      },
      'sync-refresh',
    ),
  )

  await readStarted.promise

  // A mutation (e.g. stage, commit, branch switch) claims the lane
  const mutationResult = await scheduler.mutate(root, async () => {
    return 'mutation-completed'
  })

  assert.equal(mutationResult, 'mutation-completed')
  const wasCancelled = await readCancelled.promise
  assert.equal(wasCancelled, true, 'background read signal was aborted when mutation claimed lane')
  await assert.rejects(backgroundTask, /cancelled/iu)
})

test('overlapping local read defers and reschedules remote polling without losing it', async () => {
  const clock = new ManualClock()
  const scheduler = new RepositoryScheduler()
  const localGate = Promise.withResolvers<void>()
  const reads: string[] = []

  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: async (_repo, _signal, req) => {
        reads.push(req.github.remote)
        if (req.github.remote === 'reuse') {
          await localGate.promise
        }
        return snapshotFixture()
      },
      readIssues: async () => [],
      scheduler,
      clock,
    },
    { ...DEFAULT_INTERVALS, visibleMs: 1_000, localSettleMs: 100 },
  )

  coordinator.attach('/tmp/repo', snapshotFixture())
  reads.length = 0

  // 1. A local change starts a local read that holds the coordinator:
  coordinator.notifyLocalChange()
  await clock.advance(100)
  assert.deepEqual(reads, ['reuse'])

  // 2. While the local read is running, remote polling interval (1000ms) elapses:
  await clock.advance(1_000)
  // Remote read could not run immediately because local read was running; it was deferred!
  assert.deepEqual(reads, ['reuse'])

  // 3. Local read finishes:
  localGate.resolve()
  await clock.advance(1)

  // 4. Deferred remote read executes:
  assert.deepEqual(reads, ['reuse', 'on-failure'])

  // 5. Remote timer is still scheduled for the next interval:
  await clock.advance(1_000)
  assert.deepEqual(reads, ['reuse', 'on-failure', 'on-failure'])
  coordinator.detach()
})

test('pending mutation ledgers persist per repository across attach-switch-return', async () => {
  const h = harness()
  const action: GitAction = {
    type: 'merge',
    ref: 'refs/heads/feature',
    expectedHead: '1'.repeat(40),
    expectedHeadRef: 'refs/heads/feature',
  }

  // 1. Attach repository A and record a lost high-impact mutation
  h.coordinator.attach('/tmp/repo-a', snapshotFixture())
  const recorded = h.coordinator.recordMutationFailure(action, new Error('Network timeout'))
  assert.ok(recorded)
  assert.equal(h.coordinator.freshness().pendingMutations.length, 1)

  // 2. Switch to repository B: pending mutations from repo A must not show in repo B
  h.coordinator.attach('/tmp/repo-b', snapshotFixture())
  assert.equal(h.coordinator.freshness().pendingMutations.length, 0)

  // 3. Switch back to repository A: pending mutations must STILL be present
  h.coordinator.attach('/tmp/repo-a', snapshotFixture())
  assert.equal(h.coordinator.freshness().pendingMutations.length, 1)
  assert.equal(h.coordinator.freshness().pendingMutations[0].id, recorded.id)

  // 4. Person dismisses it: only then is it removed
  h.coordinator.dismissPendingMutation(recorded.id)
  assert.equal(h.coordinator.freshness().pendingMutations.length, 0)
})

test('low remaining budget derives parking deadline from rate-limit reset and parks secondary tier', async () => {
  const h = harness()
  const resetTime = new Date(h.clock.now() + 600_000)
  // Simulate GitHub transport reporting remaining requests at or below budgetFloor (10)
  h.failWith(
    new GitHubTransportError({
      kind: 'rate-limited',
      detail: 'Rate limit nearly exhausted',
      rateLimit: {
        limit: 5000,
        remaining: 5,
        reset: resetTime,
        resource: 'core',
        retryAfterSeconds: 120,
      },
    }),
  )
  h.coordinator.attach('/tmp/repo', snapshotFixture())
  // Trigger visible failure so lastGitHubRateLimit records remaining = 5 and reset
  await h.clock.advance(DEFAULT_INTERVALS.visibleMs + 1)
  h.failWith(null)

  // Switch to secondary tier (window blurred / inactive)
  h.coordinator.reportActivity({ focused: false, visible: true })
  const initialIssueReads = h.issueReads()

  // Advance time: secondary polling encounters low budget, derives parkUntil from resetTime (120s away)
  await h.clock.advance(DEFAULT_INTERVALS.secondaryMs + 1)
  assert.equal(
    h.issueReads(),
    initialIssueReads,
    'secondary tier parks when remaining budget is low',
  )

  // Advance to just before the reset time: still parked
  await h.clock.advance(200_000)
  assert.equal(
    h.issueReads(),
    initialIssueReads,
    'secondary tier stays parked until rate limit reset',
  )

  // Past reset: secondary tier can resume
  await h.clock.advance(150_000)
  assert.ok(h.issueReads() > initialIssueReads, 'secondary tier resumes once reset deadline passes')
  resetGitHubRateLimit()
})

test('confirmed payload is bound to remote identity and invalidated when origin URL changes', async () => {
  const { repo, cleanup } = await disposableRepository()
  const previous = { ...process.env }
  process.env.GIT_STACKS_GITHUB_API_URL = 'http://127.0.0.1:9'
  try {
    // 1. Configure remote origin as project-alpha and record a confirmed payload
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project-alpha.git')
    const { confirmedGitHubPayload } = await import('../src/main/git')

    // Calling getSnapshot in 'reuse' before any fetch confirms no data
    const initial = await getSnapshot(repo, undefined, undefined, 'reuse')
    assert.equal(initial.github.available, false)

    // Verify confirmedGitHubPayload with originUrl check:
    assert.equal(confirmedGitHubPayload(repo, 'https://github.com/acme/project-beta.git'), null)

    // 2. Change remote URL to project-beta:
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/project-beta.git')
    const snapshotAfterChange = await getSnapshot(repo, undefined, undefined, 'reuse')
    // Unrelated records from project-alpha must not be reused for project-beta
    assert.equal(snapshotAfterChange.github.available, false)
    assert.equal(snapshotAfterChange.githubStale?.reason, 'GitHub data has not been confirmed yet')
  } finally {
    Object.assign(process.env, previous)
    await cleanup()
  }
})
test('start-stop during asynchronous arm does not attach watchers or leak timers or emit events', async () => {
  const { repo, cleanup } = await disposableRepository()
  let resolveArmPromise: (dirs: string[]) => void = () => {}
  const armPending = new Promise<string[]>((res) => {
    resolveArmPromise = res
  })

  const events: unknown[] = []
  const watcher = new RepositoryWatcher(repo, (event) => events.push(event), {
    debounceMs: 20,
    sweepMs: 100,
    resolveGitDirectories: async () => armPending,
  })

  try {
    // 1. Start the watcher: begins arm(), awaiting resolveGitDirectories
    const startPromise = watcher.start()
    assert.equal(watcher.watching, true)

    // 2. Stop the watcher while arm is still awaiting
    watcher.stop()
    assert.equal(watcher.watching, false)

    // 3. Resolve the arm promise
    resolveArmPromise([join(repo, '.git')])
    await startPromise

    // Verify watcher remains completely stopped
    assert.equal(watcher.watching, false)
    const watcherInternals = watcher as unknown as {
      watchers: unknown[]
      sweepTimer?: unknown
      presenceTimer?: unknown
    }
    assert.equal(watcherInternals.watchers.length, 0)
    assert.equal(watcherInternals.sweepTimer, undefined)
    assert.equal(watcherInternals.presenceTimer, undefined)
    // 4. Modifying the repo does NOT trigger any events or local notifications
    git(repo, 'commit', '--allow-empty', '-m', 'Commit while watcher stopped')
    await new Promise((res) => setTimeout(res, 60))
    assert.equal(events.length, 0, 'stopped watcher must not emit any events')
  } finally {
    watcher.stop()
    await cleanup()
  }
})

test('delayed network GitHub request is aborted by mutation; coordinator clears running and does not defer local refresh', async () => {
  const { repo, cleanup } = await disposableRepository()
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project-alpha.git')

  class StalledTransport implements GitHubTransport {
    readonly kind = 'direct' as const
    public aborted = 0
    public queryReceived = 0

    async rest<T = unknown>(): Promise<GitHubRestResponse<T>> {
      return {
        status: 200,
        data: {} as T,
        rateLimit: {
          limit: 5000,
          remaining: 4999,
          reset: null,
          resource: 'core',
          retryAfterSeconds: null,
        },
      }
    }
    async paginate<T = unknown>(): Promise<T[]> {
      return []
    }
    async graphql<T = Record<string, unknown>>(
      _query: string,
      _variables: Record<string, unknown> = {},
      options: GitHubGraphqlOptions = {},
    ): Promise<T> {
      this.queryReceived++
      return new Promise<T>((_resolve, reject) => {
        if (options.signal?.aborted) {
          this.aborted++
          reject(new CommandCancelled())
          return
        }
        options.signal?.addEventListener(
          'abort',
          () => {
            this.aborted++
            reject(new CommandCancelled())
          },
          { once: true },
        )
      })
    }
  }

  const transport = new StalledTransport()
  setGitHubTransport(transport)
  resetGitHubRateLimit()

  const clock = new ManualClock()
  const scheduler = new RepositoryScheduler()
  const registry = new RequestRegistry()

  const emittedIssues: unknown[] = []
  const emittedSnapshots: RepositorySnapshot[] = []

  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: (root, signal, request) =>
        performBackgroundRead(
          registry,
          root,
          signal,
          (readSignal) => getSnapshot(root, readSignal, undefined, request.github.remote),
          request.requestId,
        ),
      readIssues: (root, signal) =>
        performBackgroundRead(
          registry,
          root,
          signal,
          async (readSignal) => {
            const issues = await getGitHubIssues(
              root,
              'https://github.com/acme/project-alpha.git',
              readSignal,
            )
            if (readSignal.aborted) throw new CommandCancelled()
            if (issues.message) throw new Error(issues.message)
            return issues.issues
          },
          'sync-issues',
        ),
      scheduler,
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 10 },
  )

  coordinator.onEvent((event) => {
    if (event.kind === 'issues') emittedIssues.push(event.issues)
    if (event.kind === 'snapshot' && event.snapshot) emittedSnapshots.push(event.snapshot)
  })

  try {
    const initial = await getSnapshot(repo, undefined, undefined, 'reuse')
    coordinator.attach(repo, initial)

    // Trigger secondary inbox refresh (tier = 'secondary')
    coordinator.reportActivity({ focused: false, visible: true })
    const inboxPromise = clock.advance(DEFAULT_INTERVALS.secondaryMs + 1)
    for (let i = 0; i < 50 && transport.queryReceived === 0; i++) {
      await new Promise((res) => setImmediate(res))
    }
    // The GraphQL request is now in-flight and stalled waiting on the network
    assert.ok(transport.queryReceived >= 1, 'GraphQL query arrived at transport')
    const coordinatorInternals = coordinator as unknown as {
      running: Promise<unknown> | null
    }
    assert.ok(coordinatorInternals.running !== null, 'coordinator is running background read')
    // Now a mutation happens (e.g. stage, commit, or branch action)!
    // scheduler.write claims the mutation queue and aborts the in-flight background read
    let mutationRan = false
    await scheduler.mutate(repo, async () => {
      mutationRan = true
    })
    assert.equal(mutationRan, true)

    // Await the inbox promise: it was aborted by the mutation!
    await inboxPromise

    // Verify:
    // 1. The transport saw the abort signal!
    assert.ok(transport.aborted >= 1, 'transport signal was aborted by mutation')
    // 2. coordinator.running was promptly cleared to null!
    assert.equal(coordinatorInternals.running, null, 'coordinator.running is cleared')
    assert.equal(emittedIssues.length, 0, 'aborted inbox refresh must not emit issues')

    // 4. Now a local watcher event arrives!
    coordinator.notifyLocalChange()
    // It should run immediately upon settle without being deferred by network
    await clock.advance(DEFAULT_INTERVALS.localSettleMs + 1)
    for (let i = 0; i < 50 && emittedSnapshots.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 20))
    }

    // Snapshot was taken and emitted without waiting on any stalled network!
    assert.ok(emittedSnapshots.length >= 1, 'local refresh ran promptly after mutation')
  } finally {
    setGitHubTransport(null)
    coordinator.detach()
    await cleanup()
    resetGitHubRateLimit()
  }
})
test('tracked closed or merged PR detail stall is aborted by mutation and preserves coordinator freshness', async () => {
  const { repo, cleanup } = await disposableRepository()
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project-alpha.git')
  git(repo, 'branch', 'feature-tracked')
  git(repo, 'config', 'branch.feature-tracked.gitstackspr', '42')

  class TrackedPrStallTransport implements GitHubTransport {
    readonly kind = 'direct' as const
    public openPrQueryReceived = 0
    public trackedPrQueryReceived = 0
    public aborted = 0

    async rest<T = unknown>(): Promise<GitHubRestResponse<T>> {
      return {
        status: 200,
        data: {} as T,
        rateLimit: {
          limit: 5000,
          remaining: 4999,
          reset: null,
          resource: 'core',
          retryAfterSeconds: null,
        },
      }
    }
    async paginate<T = unknown>(): Promise<T[]> {
      return []
    }
    async graphql<T = Record<string, unknown>>(
      query: string,
      variables: Record<string, unknown> = {},
      options: GitHubGraphqlOptions = {},
    ): Promise<T> {
      if (query.includes('pullRequests(first: 100')) {
        this.openPrQueryReceived++
        // Open PRs list does not contain tracked PR #42 (it is closed or merged)
        return {
          repository: {
            pullRequests: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        } as T
      }

      if (query.includes('pullRequest(number: $number)')) {
        this.trackedPrQueryReceived++
        // The detail request for tracked PR #42 stalls until aborted by mutation
        return new Promise<T>((_resolve, reject) => {
          if (options.signal?.aborted) {
            this.aborted++
            reject(new CommandCancelled())
            return
          }
          options.signal?.addEventListener(
            'abort',
            () => {
              this.aborted++
              reject(new CommandCancelled())
            },
            { once: true },
          )
        })
      }

      return {
        repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      } as T
    }
  }

  const transport = new TrackedPrStallTransport()
  setGitHubTransport(transport)
  resetGitHubRateLimit()

  const clock = new ManualClock()
  const scheduler = new RepositoryScheduler()
  const registry = new RequestRegistry()
  const emittedSnapshots: RepositorySnapshot[] = []

  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: (root, signal, request) =>
        performBackgroundRead(
          registry,
          root,
          signal,
          (readSignal) => getSnapshot(root, readSignal, undefined, request.github.remote),
          request.requestId,
        ),
      readIssues: async () => [],
      scheduler,
      clock,
    },
    { ...DEFAULT_INTERVALS, localSettleMs: 10 },
  )

  coordinator.onEvent((event) => {
    if (event.kind === 'snapshot' && event.snapshot) emittedSnapshots.push(event.snapshot)
  })

  try {
    const initial = snapshotFixture({
      path: repo,
      github: { available: true, message: 'GitHub metadata available' },
    })
    coordinator.attach(repo, initial)
    const initialFreshness = coordinator.freshness()
    assert.equal(initialFreshness.state, 'fresh')

    // Trigger a remote refresh: getSnapshot will query open PRs, then query tracked PR #42 and stall
    const refreshPromise = coordinator.refreshNow()

    // Wait for the detail query to arrive and stall
    for (let i = 0; i < 50 && transport.trackedPrQueryReceived === 0; i++) {
      await new Promise((res) => setTimeout(res, 20))
    }
    assert.ok(transport.trackedPrQueryReceived >= 1, 'tracked PR detail query arrived at transport')

    const coordinatorInternals = coordinator as unknown as {
      running: Promise<unknown> | null
      failures: number
    }
    assert.ok(coordinatorInternals.running !== null, 'coordinator is running background read')

    // Now a local mutation runs (e.g. stage, commit, branch action)
    let mutationRan = false
    await scheduler.mutate(repo, async () => {
      mutationRan = true
    })
    assert.equal(mutationRan, true)

    // Await refreshPromise settling
    try {
      await refreshPromise
    } catch {
      // Refresh was aborted by mutation
    }

    // Verify:
    // 1. Transport saw the abort signal for tracked PR detail query!
    assert.ok(transport.aborted >= 1, 'tracked PR detail transport query was aborted')
    // 2. coordinator.running was promptly cleared!
    assert.equal(coordinatorInternals.running, null, 'coordinator.running is cleared')
    // 3. Freshness was PRESERVED: failures not incremented, state not flipped to stale or cancelled!
    assert.equal(coordinatorInternals.failures, 0, 'failures count must stay 0 on cancellation')
    assert.equal(
      coordinator.freshness().state,
      initialFreshness.state,
      'freshness state must be preserved',
    )

    // 4. Local change notified to coordinator runs immediately upon settle without being deferred
    coordinator.notifyLocalChange()
    await clock.advance(DEFAULT_INTERVALS.localSettleMs + 1)
    for (let i = 0; i < 50 && emittedSnapshots.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 20))
    }
    assert.ok(emittedSnapshots.length >= 1, 'local refresh ran promptly after mutation')
  } finally {
    setGitHubTransport(null)
    coordinator.detach()
    await cleanup()
    resetGitHubRateLimit()
  }
})
