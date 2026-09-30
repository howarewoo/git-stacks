import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tryGit } from './git-core'

export type RepositoryWatchReason = 'change' | 'missing' | 'restored' | 'replaced'

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
  /**
   * Whether a recursive watch is available. `false` reproduces the platforms
   * and filesystems that refuse one, where only the top level delivers events.
   */
  recursiveWatch?: boolean
}

const DEFAULT_DEBOUNCE_MS = 400
const DEFAULT_MAX_DELAY_MS = 2_000
const DEFAULT_SWEEP_MS = 15_000

/**
 * How many times one settle pass re-resolves the Git directories of a root
 * that keeps being replaced underneath it. Each attempt is asynchronous and
 * the path cannot be held still, so the pass gives up rather than spin; the
 * sweep settles it on a later turn.
 */
const MAX_ARM_ATTEMPTS = 3

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

/**
 * Which directory this path currently is. Device and inode survive no
 * replacement: a directory moved away and a new one put in its place keeps the
 * path but not the identity, which is the only evidence a replacement left when
 * no event ever showed the path missing. Creation time is the fallback for the
 * filesystems that report no inode.
 */
async function directoryIdentity(path: string): Promise<string | null> {
  try {
    const details = await stat(path)
    if (details.ino > 0) return `${details.dev}:${details.ino}`
    return `${details.birthtimeMs}:${details.ctimeMs}`
  } catch {
    return null
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
 * The worktree and ref content a snapshot reads, as Git reports it. A recursive
 * watch delivers these changes as events; without one, nothing else sees a
 * nested file or a loose ref below `refs/heads/feature/`, because no
 * `fs.watch` on an ancestor of those paths reports them. The status refresh
 * reads the index stat cache rather than every file, and the ref listing reads
 * the packed refs plus the loose ones.
 */
async function repositoryContentSignature(root: string): Promise<string> {
  try {
    // `--no-optional-locks` is a global option: it keeps the read from writing
    // the index, so a sweep running beside a Git operation of the person's
    // cannot take its lock.
    const status = await tryGit(root, [
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '--branch',
    ])
    const refs = await tryGit(root, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)'])
    return `${status ?? ''}\u0000${refs ?? ''}`
  } catch {
    // A repository Git cannot describe yet has no content to fingerprint.
    return ''
  }
}

/**
 * Notices worktree, index, and ref changes made outside this window — a commit
 * typed in a terminal, a branch switch, or a background fetch — and reports one
 * coalesced event instead of one per file. Deleting or moving the repository is
 * reported too, and the watch is re-armed when it comes back. A directory
 * replaced at the same path is reported the same way, because the old
 * subscriptions follow the tree that moved away rather than the new one.
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
  /** True while a presence check runs, so one replacement is noticed once. */
  private checking = false
  /** The directory the armed watches belong to; null while it is absent. */
  private identity: string | null = null
  /**
   * True once a resolution's identity has held, which is what the Git
   * directory watches and the fingerprint are allowed to describe. False means
   * nothing is watched for them, because no resolution has been shown to
   * belong to the directory now at the path.
   */
  private targetSettled = false
  private settling: { gen: number; promise: Promise<void> } | undefined
  private started = false
  private stopping = false
  private generation = 0
  /** False where only the top level delivers events, so the sweep reads content. */
  private deepWatch = true
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
      recursiveWatch: options.recursiveWatch !== false,
    }
  }

  get watching(): boolean {
    return this.started && !this.stopping
  }

  async start(): Promise<void> {
    if (this.started || this.stopping) return
    this.started = true
    const gen = ++this.generation
    const exists = await pathExists(this.root)
    if (!this.started || this.stopping || this.generation !== gen) return
    this.present = exists
    await this.arm(gen)
    if (!this.started || this.stopping || this.generation !== gen) return
    this.scheduleSweep()
  }

  stop(): void {
    this.generation++
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
    this.presenceTimer = undefined
    this.pendingPaths.clear()
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

  private async arm(expectedGen?: number): Promise<void> {
    const gen = expectedGen ?? ++this.generation
    this.closeWatchers()
    if (!this.armed(gen)) return
    // Nothing is watched on the Git directories until the target settles, and
    // nothing at all until then, so a replacement arriving now delivers no
    // event. The identity stays unset until the resolution holds, so a
    // presence check running alongside has nothing to claim it against.
    this.identity = null
    this.gitDirectories = []
    this.targetSettled = false
    await this.settleTarget(gen)
    if (!this.armed(gen) || this.targetSettled) return
    // A root rewritten past every attempt has no Git directory that can be
    // watched without watching the tree that moved away. The watches below
    // describe the path rather than a tree, so they still deliver the worktree
    // and the parent's view of a move until a later turn settles the target.
    this.attachPathWatches()
  }

  /** The watcher is still running, and this arm is still the current one. */
  private armed(gen: number): boolean {
    return this.started && !this.stopping && this.generation === gen
  }

  /**
   * Resolves the Git directories of the directory now at the root, and on a
   * resolution that still holds, attaches every watch belonging to it and
   * takes the signature the sweep compares against.
   *
   * A replacement can land between the identity check and the lookups that
   * follow it. No watch is subscribed on the Git directories until this
   * returns, so nothing reports that, and the directories just resolved
   * describe the tree that moved away. The identity is therefore rechecked
   * after every lookup, and a resolution whose identity no longer holds is
   * discarded rather than watched: the worktree and the parent are re-armed
   * from the same tree the identity names, so the two can never disagree.
   * Nothing is committed if the path is still moving when the attempts run
   * out, which leaves the watches off the Git directories instead of on the
   * directories of a tree that is gone.
   */
  private async settleTarget(gen: number): Promise<void> {
    if (this.settling?.gen === gen) return this.settling.promise
    const promise = this.resolveTarget(gen)
    this.settling = { gen, promise }
    try {
      await promise
    } finally {
      if (this.settling?.promise === promise) this.settling = undefined
    }
  }

  private async resolveTarget(gen: number): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ARM_ATTEMPTS; attempt += 1) {
      const identity = await directoryIdentity(this.root)
      if (!this.armed(gen)) return
      const gitDirectories = await this.options.resolveGitDirectories(this.root)
      if (!this.armed(gen)) return
      const resolved = await directoryIdentity(this.root)
      if (!this.armed(gen)) return
      if (resolved !== identity) continue
      this.closeWatchers()
      this.identity = identity
      this.gitDirectories = gitDirectories
      this.attachPathWatches()
      for (const directory of this.gitDirectories) this.attachGitDirectory(directory)
      this.targetSettled = true
      // The signature is taken once every watch is armed, because whether the
      // worktree watch reached below the top level decides what it must cover.
      const signature = await this.currentSignature()
      if (!this.armed(gen)) return
      this.signature = signature
      return
    }
  }

  /**
   * The watches that follow the path rather than a particular tree: the
   * worktree, and the parent that shows the repository being moved.
   */
  private attachPathWatches(): void {
    const name = basename(this.root)
    // The repository's own directory can vanish; its parent is how a move is seen.
    this.attach(dirname(this.root), false, (changed) => {
      if (changed === null || changed === name) void this.checkPresence()
    })
    // Watch the worktree as well as Git metadata, so editing a tracked source
    // file or creating an untracked file triggers a debounced local refresh
    // without having to run a Git command first.
    this.attachWorktree(this.root)
  }

  private attachWorktree(root: string): void {
    // Only a recursive watch reaches every path below the worktree. Where the
    // platform refuses one, the top level is all that delivers events and the
    // sweep has to fingerprint the worktree and ref content instead.
    this.deepWatch = this.options.recursiveWatch ? this.attach(root, true) : false
    if (!this.deepWatch) this.attach(root, false)
  }
  private attachGitDirectory(directory: string): void {
    if (this.attach(directory, this.options.recursiveWatch) && this.options.recursiveWatch) return
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
    if (!this.started || this.stopping) return false
    try {
      const watcher = watch(target, { recursive }, (_event, filename) => {
        if (!this.started || this.stopping) return
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
      if (!this.started || this.stopping) {
        try {
          watcher.close()
        } catch {
          // A watcher whose target was removed is already gone.
        }
        return false
      }
      this.watchers.push(watcher)
      return true
    } catch {
      return false
    }
  }

  private noteChange(path: string): void {
    if (!this.started || this.stopping) return
    this.pendingPaths.add(path)
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      if (!this.started || this.stopping) return
      void this.emit()
    }, this.options.debounceMs)
    if (this.deadlineTimer) return
    this.deadlineAt = Date.now() + this.options.maxDelayMs
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
      if (!this.started || this.stopping) return
      void this.emit()
    }, this.options.maxDelayMs)
  }

  private async emit(): Promise<void> {
    if (!this.started || this.stopping) return
    const gen = this.generation
    const exists = await pathExists(this.root)
    if (!this.started || this.stopping || this.generation !== gen) return
    this.deadlineTimer = undefined
    if (!exists) {
      this.present = false
      this.identity = null
      this.closeWatchers()
      this.pendingPaths.clear()
      if (!this.started || this.stopping || this.generation !== gen) return
      this.onEvent({ reason: 'missing', root: this.root, paths: [] })
      // Nothing is watched now, including the parent that saw the move, so
      // nothing else would notice the repository coming back.
      this.pollForReturn()
      return
    }
    this.stopPollingForReturn()
    const restored = !this.present
    // A different directory at the same path replaces the watched one even when
    // nothing ever showed the path missing: the subscriptions belong to the tree
    // that moved away, so they must be re-armed and the new tree read. The
    // replacement is claimed before the re-arm, so the several triggers that can
    // report one replacement re-arm it once.
    const identity = await directoryIdentity(this.root)
    if (!this.started || this.stopping || this.generation !== gen) return
    const replaced = this.identity !== null && identity !== this.identity
    if (replaced) this.identity = identity
    this.present = true
    if (restored || replaced) {
      await this.arm(gen)
      if (!this.started || this.stopping || this.generation !== gen) return
    }
    const paths = [...this.pendingPaths]
    this.pendingPaths.clear()
    if (!this.started || this.stopping || this.generation !== gen) return
    this.onEvent({
      reason: restored ? 'restored' : replaced ? 'replaced' : 'change',
      root: this.root,
      paths,
    })
  }

  private pollForReturn(): void {
    if (this.presenceTimer || this.stopping || !this.started) return
    this.presenceTimer = setInterval(
      () => {
        if (!this.started || this.stopping) {
          this.stopPollingForReturn()
          return
        }
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
    // The parent watch and the sweep both ask. One check at a time keeps a
    // single replacement from being reported twice; whatever a running check
    // does not see is the sweep's next turn to find.
    if (!this.started || this.stopping || this.checking) return
    this.checking = true
    const gen = this.generation
    try {
      const exists = await pathExists(this.root)
      if (!this.armed(gen)) return
      if (exists !== this.present) {
        await this.emit()
        return
      }
      if (!exists) return
      if (!this.targetSettled) {
        // The arm gave up on a root that kept being replaced, so nothing is
        // watched for its Git directories. The path watches are still armed,
        // and a change at this path is the moment to finish settling it.
        await this.settleTarget(gen)
        return
      }
      // Still here, so the only thing left that can invalidate the armed
      // watches is a replacement at this path.
      const identity = await directoryIdentity(this.root)
      if (!this.armed(gen)) return
      if (identity === null || identity === this.identity) return
      await this.emit()
    } finally {
      this.checking = false
    }
  }

  private scheduleSweep(): void {
    if (this.options.sweepMs <= 0 || !this.started || this.stopping) return
    this.sweepTimer = setInterval(() => {
      if (!this.started || this.stopping) {
        clearInterval(this.sweepTimer)
        this.sweepTimer = undefined
        return
      }
      void this.sweep()
    }, this.options.sweepMs)

    // A pending sweep must never hold the process open on quit.
    this.sweepTimer.unref()
  }

  /**
   * What the next sweep compares against: the Git state files a snapshot
   * reads, plus the worktree and ref content where no watch reaches below the
   * top level.
   */
  private async currentSignature(): Promise<string> {
    const metadata = await gitStateSignature(this.gitDirectories)
    if (this.deepWatch) return metadata
    return `${metadata}\u0000${await repositoryContentSignature(this.root)}`
  }

  private async sweep(): Promise<void> {
    if (!this.started || this.stopping) return
    const gen = this.generation
    if (!this.targetSettled) {
      // A root that kept being replaced during the arm has no Git directory
      // that can be watched, so there is no state here to fingerprint yet.
      // The path watches are still armed; this is where it gets settled.
      await this.settleTarget(gen)
      return
    }
    await this.checkPresence()
    if (!this.started || this.stopping || this.generation !== gen) return
    if (!this.present) return
    const next = await this.currentSignature()
    if (!this.started || this.stopping || this.generation !== gen) return
    if (next === this.signature) return
    this.signature = next
    this.noteChange(this.root)
  }
}
