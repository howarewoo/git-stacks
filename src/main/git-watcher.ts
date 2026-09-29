import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tryGit } from './git-core'

export type RepositoryWatchReason = 'change' | 'missing' | 'restored'

export interface RepositoryWatchEvent {
  reason: RepositoryWatchReason
  root: string
  /** Git paths seen since the last emitted event, for logging and diagnostics. */
  paths: string[]
}

export interface RepositoryWatcherOptions {
  /** Quiet period a burst of filesystem events must survive before one refresh. */
  debounceMs?: number
  /** Longest a continuous burst may defer the refresh, however busy the tree is. */
  maxDelayMs?: number
  /** Safety net for filesystems that deliver no events at all. */
  sweepMs?: number
  /** Overridable so a test can watch a directory without spawning Git. */
  resolveGitDirectories?: (root: string) => Promise<string[]>
}

const DEFAULT_DEBOUNCE_MS = 400
const DEFAULT_MAX_DELAY_MS = 2_000
const DEFAULT_SWEEP_MS = 15_000

/**
 * Subdirectories that carry the ref, index, and operation state a snapshot reads.
 * Watched individually only when the platform refuses a recursive watch.
 */
const WATCHED_SUBDIRECTORIES = [
  'refs',
  'logs',
  'rebase-merge',
  'rebase-apply',
  'worktrees',
  'modules',
]

/** Files whose modification means HEAD, the index, or the ref set moved. */
const WATCHED_FILES = [
  'HEAD',
  'index',
  'packed-refs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'config',
]

async function defaultGitDirectories(root: string): Promise<string[]> {
  const directories = new Set<string>()
  for (const args of [
    ['rev-parse', '--absolute-git-dir'],
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  ]) {
    try {
      const output = await tryGit(root, args)
      const resolved = output?.trim()
      if (resolved) directories.add(resolved)
    } catch {
      // A repository Git cannot describe yet still has a conventional location.
    }
  }
  if (directories.size === 0) directories.add(join(root, '.git'))
  return [...directories]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function statSignature(path: string): Promise<string | null> {
  try {
    const details = await stat(path)
    return `${path}:${details.mtimeMs}:${details.size}`
  } catch {
    return null
  }
}

/**
 * A cheap fingerprint of the Git state a snapshot reads, used by the sweep to
 * notice a branch switch or a fetch on a filesystem that delivers no events.
 */
async function gitStateSignature(directories: readonly string[]): Promise<string> {
  const parts: (string | null)[] = []
  for (const directory of directories) {
    parts.push(await statSignature(directory))
    for (const file of WATCHED_FILES) parts.push(await statSignature(join(directory, file)))
  }
  return parts.filter((part): part is string => part !== null).join('|')
}

/**
 * Notices worktree, index, and ref changes made outside this window — a commit
 * typed in a terminal, a branch switch, or a background fetch — and reports one
 * coalesced event instead of one per file. Deleting or moving the repository is
 * reported too, and the watch is re-armed when it comes back.
 */
export class RepositoryWatcher {
  private readonly root: string
  private readonly onEvent: (event: RepositoryWatchEvent) => void
  private readonly options: Required<RepositoryWatcherOptions>
  private watchers: FSWatcher[] = []
  private gitDirectories: string[] = []
  private debounceTimer: NodeJS.Timeout | undefined
  private sweepTimer: NodeJS.Timeout | undefined
  private deadlineTimer: NodeJS.Timeout | undefined
  private deadlineAt = 0
  private pendingPaths = new Set<string>()
  private signature: string | null = null
  private present = true
  private started = false
  private stopping = false
  private presenceTimer: NodeJS.Timeout | undefined
  constructor(
    root: string,
    onEvent: (event: RepositoryWatchEvent) => void,
    options: RepositoryWatcherOptions = {},
  ) {
    this.root = root
    this.onEvent = onEvent
    this.options = {
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      sweepMs: options.sweepMs ?? DEFAULT_SWEEP_MS,
      resolveGitDirectories: options.resolveGitDirectories ?? defaultGitDirectories,
    }
  }

  get watching(): boolean {
    return this.started && !this.stopping
  }

  async start(): Promise<void> {
    if (this.started || this.stopping) return
    this.started = true
    this.present = await pathExists(this.root)
    await this.arm()
    this.scheduleSweep()
  }

  stop(): void {
    this.stopping = true
    this.started = false
    this.closeWatchers()
    clearTimeout(this.debounceTimer)
    clearTimeout(this.deadlineTimer)
    clearInterval(this.sweepTimer)
    clearInterval(this.presenceTimer)
    this.sweepTimer = undefined
    this.debounceTimer = undefined
    this.deadlineTimer = undefined
    this.sweepTimer = undefined
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // A watcher whose target was removed is already gone.
      }
    }
    this.watchers = []
  }

  private async arm(): Promise<void> {
    this.closeWatchers()
    this.gitDirectories = await this.options.resolveGitDirectories(this.root)
    this.signature = await gitStateSignature(this.gitDirectories)
    const name = basename(this.root)
    // The repository's own directory can vanish; its parent is how a move is seen.
    this.attach(dirname(this.root), false, (changed) => {
      if (changed === null || changed === name) void this.checkPresence()
    })
    // Watch the worktree as well as Git metadata, so editing a tracked source
    // file or creating an untracked file triggers a debounced local refresh
    // without having to run a Git command first.
    this.attachWorktree(this.root)
    for (const directory of this.gitDirectories) this.attachGitDirectory(directory)
  }

  private attachWorktree(root: string): void {
    if (this.attach(root, true)) return
    this.attach(root, false)
  }
  private attachGitDirectory(directory: string): void {
    if (this.attach(directory, true)) return
    // Recursive watches are unavailable here; cover the state a snapshot reads.
    this.attach(directory, false)
    for (const child of WATCHED_SUBDIRECTORIES) this.attach(join(directory, child), false)
  }

  /** Returns false when the target could not be watched even without recursion. */
  private attach(
    target: string,
    recursive: boolean,
    onChanged?: (changed: string | null) => void,
  ): boolean {
    try {
      const watcher = watch(target, { recursive }, (_event, filename) => {
        const changed = typeof filename === 'string' ? filename : null
        if (onChanged) {
          onChanged(changed)
          return
        }
        this.noteChange(changed ? join(target, changed) : target)
      })
      watcher.on('error', () => {
        // Watch limits and removed targets both land here; re-arm and continue.
        if (!this.started || this.stopping) return
        void this.arm()
      })
      this.watchers.push(watcher)
      return true
    } catch {
      return false
    }
  }

  private noteChange(path: string): void {
    this.pendingPaths.add(path)
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.emit()
    }, this.options.debounceMs)
    if (this.deadlineTimer) return
    this.deadlineAt = Date.now() + this.options.maxDelayMs
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
      void this.emit()
    }, this.options.maxDelayMs)
  }

  private async emit(): Promise<void> {
    const exists = await pathExists(this.root)
    this.deadlineTimer = undefined
    if (!exists) {
      this.present = false
      this.closeWatchers()
      this.pendingPaths.clear()
      this.onEvent({ reason: 'missing', root: this.root, paths: [] })
      // Nothing is watched now, including the parent that saw the move, so
      // nothing else would notice the repository coming back.
      this.pollForReturn()
      return
    }
    this.stopPollingForReturn()
    const restored = !this.present
    this.present = true
    if (restored) await this.arm()
    const paths = [...this.pendingPaths]
    this.pendingPaths.clear()
    this.onEvent({ reason: restored ? 'restored' : 'change', root: this.root, paths })
  }

  private pollForReturn(): void {
    if (this.presenceTimer || this.stopping) return
    this.presenceTimer = setInterval(
      () => {
        void this.checkPresence()
      },
      Math.max(this.options.debounceMs, 250),
    )
    this.presenceTimer.unref()
  }

  private stopPollingForReturn(): void {
    if (!this.presenceTimer) return
    clearInterval(this.presenceTimer)
    this.presenceTimer = undefined
  }
  private async checkPresence(): Promise<void> {
    if (!this.started || this.stopping) return
    if ((await pathExists(this.root)) === this.present) return
    await this.emit()
  }

  private scheduleSweep(): void {
    if (this.options.sweepMs <= 0) return
    this.sweepTimer = setInterval(() => {
      void this.sweep()
    }, this.options.sweepMs)
    // A pending sweep must never hold the process open on quit.
    this.sweepTimer.unref()
  }

  private async sweep(): Promise<void> {
    if (!this.started || this.stopping) return
    // A platform can drop the event for a directory that vanishes, so the sweep
    // also asks whether the repository is still there.
    await this.checkPresence()
    if (!this.present) return
    const next = await gitStateSignature(this.gitDirectories)
    if (next === this.signature) return
    this.signature = next
    this.noteChange(this.root)
  }
}
