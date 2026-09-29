import type {
  GitAction,
  PendingRemoteMutation,
  RemoteFreshness,
  RemoteFreshnessState,
  RepositoryIssue,
  RepositorySnapshot,
  SyncActivity,
} from '../shared/types'
import { lastGitHubRateLimit } from './github-transport'
import { RemoteMutationLedger } from './remote-mutations'
import type { RepositoryScheduler } from './repository-scheduler'

export type SyncTimer = ReturnType<typeof setTimeout> | number

export interface SyncClock {
  now(): number
  setTimeout(run: () => void, ms: number): SyncTimer
  clearTimeout(handle: SyncTimer | undefined): void
  setInterval(run: () => void, ms: number): NodeJS.Timeout
  clearInterval(handle: NodeJS.Timeout | undefined): void
}

export const systemClock: SyncClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle),
}

export interface SnapshotGitHubRequest {
  /**
   * `live` reads GitHub now, `reuse` renders this repository's last confirmed
   * payload without asking GitHub, and `on-failure` reads now but keeps that
   * payload when GitHub cannot answer.
   */
  remote: 'live' | 'reuse' | 'on-failure'
}

export interface SyncEvent {
  kind: 'snapshot' | 'issues' | 'status'
  snapshot?: RepositorySnapshot
  issues?: RepositoryIssue[]
  freshness?: RemoteFreshness
}

export interface SyncCoordinatorDependencies {
  /** A repository snapshot read; `requestId` names the cancellable read claim. */
  readSnapshot: (
    repository: string,
    signal: AbortSignal,
    request: { requestId: string; github: SnapshotGitHubRequest },
  ) => Promise<RepositorySnapshot>
  /** The inbox refresh: open issues, without re-reading pull requests. */
  readIssues: (repository: string, signal: AbortSignal) => Promise<RepositoryIssue[]>
  scheduler: RepositoryScheduler
  clock?: SyncClock
}

export interface SyncIntervals {
  /** Full pull-request, stack, and check refresh while the window is in use. */
  visibleMs: number
  /** Inbox and repository refresh while the window is backgrounded. */
  secondaryMs: number
  /** Settle time after a filesystem event before reading the repository. */
  localSettleMs: number
  /** First delay after a failed refresh; each further failure doubles it. */
  failureBaseMs: number
  failureMaxMs: number
  /** Remaining requests below which nonessential polling stops. */
  budgetFloor: number
}

export const DEFAULT_INTERVALS: SyncIntervals = {
  visibleMs: 45_000,
  secondaryMs: 300_000,
  localSettleMs: 120,
  failureBaseMs: 4_000,
  failureMaxMs: 300_000,
  budgetFloor: 250,
}

interface RemoteFailure {
  state: RemoteFreshnessState
  detail: string
  /** Everything, including the visible tier, waits until this instant. */
  resumeAt: number | null
  /** Only nonessential polling parks; the visible tier keeps its own backoff. */
  secondaryOnly: boolean
}

/**
 * Classifies why a refresh did not reach GitHub. A dropped connection backs off
 * and retries, an expired token stops polling until the person acts, a spent
 * budget waits for GitHub's reset, and a secondary rate limit parks the inbox
 * refresh while the visible tier slows down instead of stopping.
 */
export function classifyRemoteFailure(
  detail: string,
  report: { kind: string | null; remaining: number | null; reset: Date | null },
): RemoteFailure {
  if (
    report.kind === 'secondary-rate-limit' ||
    /secondary rate limit|abuse detection/iu.test(detail)
  ) {
    return { state: 'rate-limited', detail, resumeAt: null, secondaryOnly: true }
  }
  if (report.remaining === 0 || /rate limit exceeded|rate limit reached/iu.test(detail)) {
    return {
      state: 'rate-limited',
      detail,
      resumeAt: report.reset?.getTime() ?? null,
      secondaryOnly: false,
    }
  }
  if (/authentication is required|bad credentials|expired token/iu.test(detail)) {
    return { state: 'unauthorized', detail, resumeAt: null, secondaryOnly: false }
  }
  if (report.kind === 'network' || /network request failed|fetch failed/iu.test(detail)) {
    return { state: 'offline', detail, resumeAt: null, secondaryOnly: false }
  }
  return { state: 'stale', detail, resumeAt: null, secondaryOnly: false }
}

/** Doubling backoff, capped, so a long outage settles into one attempt a while. */
export function failureDelay(failures: number, intervals: SyncIntervals): number {
  const exponent = Math.max(0, failures - 1)
  return Math.min(intervals.failureMaxMs, intervals.failureBaseMs * 2 ** exponent)
}

/**
 * Keeps one open repository fresh without the person asking. Local work comes
 * from a filesystem watcher; GitHub data comes from focus-aware intervals that
 * slow down, stop, and recover on their own. Nothing here writes to GitHub: a
 * reconnect resumes reads only, so a high-impact mutation that lost its answer
 * stays listed for the person instead of being replayed behind their back.
 */
export class RepositorySyncCoordinator {
  private readonly deps: SyncCoordinatorDependencies
  private readonly intervals: SyncIntervals
  private readonly clock: SyncClock
  private readonly ledgers = new Map<string, RemoteMutationLedger>()
  private ledger: RemoteMutationLedger = new RemoteMutationLedger()
  private readonly listeners = new Set<(event: SyncEvent) => void>()
  private repository: string | null = null
  private activity: SyncActivity = { focused: true, visible: true }
  private remoteTimer: SyncTimer | undefined
  private localTimer: SyncTimer | undefined
  private running: Promise<unknown> | null = null
  private dirtyLocal = false
  private dirtyRemoteTier: 'visible' | 'secondary' | null = null
  private failures = 0
  private state: RemoteFreshnessState = 'stale'
  private detail: string | null = null
  private fetchedAt: number | null = null
  private checkedAt: number | null = null
  private rateLimitReset: number | null = null
  private resumeAt: number | null = null
  private secondarySuspended = false
  /** When the parked tier is allowed to try GitHub again. */
  private parkUntil = 0

  constructor(deps: SyncCoordinatorDependencies, intervals: Partial<SyncIntervals> = {}) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    this.intervals = { ...DEFAULT_INTERVALS, ...intervals }
  }

  get attachedRepository(): string | null {
    return this.repository
  }

  freshness(): RemoteFreshness {
    return {
      state: this.state,
      fetchedAt: this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString(),
      checkedAt: this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
      detail: this.detail,
      rateLimitReset:
        this.rateLimitReset === null ? null : new Date(this.rateLimitReset).toISOString(),
      pendingMutations: this.ledger.pending(),
    }
  }

  onEvent(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Opens a repository for background refresh; a snapshot seeds its freshness. */
  attach(repository: string, snapshot?: RepositorySnapshot): void {
    this.detach()
    this.repository = repository
    // Retain pending mutation ledgers per repository across attach-switch-return,
    // so switching repositories never dismisses an unresolved mutation warning.
    let ledger = this.ledgers.get(repository)
    if (!ledger) {
      ledger = new RemoteMutationLedger()
      this.ledgers.set(repository, ledger)
    }
    this.ledger = ledger
    if (snapshot) this.adopt(snapshot)
    this.emit({ kind: 'status', freshness: this.freshness() })
    this.scheduleRemote(this.intervalFor(this.currentTier()))
  }

  detach(): void {
    this.clock.clearTimeout(this.remoteTimer)
    this.clock.clearTimeout(this.localTimer)
    this.remoteTimer = undefined
    this.localTimer = undefined
    this.repository = null
    this.ledger = new RemoteMutationLedger()
    this.running = null
    this.dirtyLocal = false
    this.dirtyRemoteTier = null
    this.failures = 0
    this.state = 'stale'
    this.detail = null
    this.fetchedAt = null
    this.checkedAt = null
    this.rateLimitReset = null
    this.resumeAt = null
    this.secondarySuspended = false
    this.parkUntil = 0
  }

  reportActivity(activity: SyncActivity): void {
    const changed =
      activity.focused !== this.activity.focused || activity.visible !== this.activity.visible
    this.activity = activity
    if (!changed || !this.repository) return
    // An unauthorized state stops polling until the person refreshes manually.
    if (this.state === 'unauthorized') return
    const due =
      this.fetchedAt === null || this.clock.now() - this.fetchedAt >= this.intervals.visibleMs
    // Returning to the window with due data earns an immediate read; hiding it
    // earns the slower inbox tier instead of nothing.
    if (activity.focused && activity.visible && due) {
      const wait = this.resumeAt === null ? 0 : this.resumeAt - this.clock.now()
      if (wait <= 0) void this.run('visible')
      else this.scheduleRemote(wait)
    } else {
      this.scheduleRemote(this.intervalFor(this.currentTier()))
    }
  }

  /** A filesystem event: read local Git now, GitHub only when it is due. */
  notifyLocalChange(): void {
    if (!this.repository) return
    if (this.running) {
      this.dirtyLocal = true
      return
    }
    this.scheduleLocal(this.intervals.localSettleMs)
  }

  /** The person's own refresh: never deferred, always a live remote read. */
  async refreshNow(): Promise<RepositorySnapshot> {
    const snapshot = await this.run('visible', { manual: true, requestId: 'refresh' })
    if (!snapshot) throw new Error('Refresh failed.')
    return snapshot
  }

  /**
   * Records a high-impact mutation whose answer was lost. It stays listed until
   * the person dismisses it; no refresh path replays it.
   */
  recordMutationFailure(action: GitAction, error: unknown): PendingRemoteMutation | null {
    const entry = this.ledger.recordFailure(action, error)
    if (entry) this.emit({ kind: 'status', freshness: this.freshness() })
    return entry
  }

  dismissPendingMutation(id: string): boolean {
    const removed = this.ledger.dismiss(id)
    if (removed) this.emit({ kind: 'status', freshness: this.freshness() })
    return removed
  }

  private adopt(snapshot: RepositorySnapshot): void {
    this.checkedAt = this.clock.now()
    if (snapshot.githubStale) {
      this.fetchedAt = Date.parse(snapshot.githubStale.fetchedAt) || this.clock.now()
      this.state = 'stale'
      this.detail = snapshot.githubStale.reason
      return
    }
    // No confirmed GitHub data at all: the origin is not a usable GitHub
    // repository, so there is nothing to keep fresh and nothing to fall back to.
    this.fetchedAt = this.clock.now()
    this.state = snapshot.github.available ? 'fresh' : 'stale'
    this.detail = snapshot.github.available ? null : snapshot.github.message
  }

  private scheduleRemote(delayMs: number): void {
    if (!this.repository) return
    this.clock.clearTimeout(this.remoteTimer)
    this.remoteTimer = this.clock.setTimeout(
      () => {
        this.remoteTimer = undefined
        void this.run(this.currentTier())
      },
      Math.max(0, delayMs),
    )
  }

  private scheduleLocal(delayMs: number): void {
    if (!this.repository) return
    this.clock.clearTimeout(this.localTimer)
    this.localTimer = this.clock.setTimeout(
      () => {
        this.localTimer = undefined
        void this.run('local')
      },
      Math.max(0, delayMs),
    )
  }

  /** The interval the current activity and health justify. */
  private currentTier(): 'visible' | 'secondary' {
    return this.activity.focused && this.activity.visible ? 'visible' : 'secondary'
  }

  /** True while the visible tier may also be doing local-only work. */
  private async run(
    tier: 'visible' | 'local' | 'secondary',
    options: { manual?: boolean; requestId?: string } = {},
  ): Promise<RepositorySnapshot | null> {
    const repository = this.repository
    if (!repository) return null
    if (!options.manual) {
      if (tier === 'secondary') {
        if (this.budgetExhausted()) {
          const report = lastGitHubRateLimit()
          const resetMs = report.rateLimit.reset ? report.rateLimit.reset.getTime() : null
          const deadline =
            resetMs !== null && resetMs > this.clock.now()
              ? resetMs
              : this.clock.now() + this.intervals.secondaryMs
          if (this.parkUntil < deadline) {
            this.parkUntil = deadline
          }
          if (this.clock.now() < this.parkUntil) {
            this.scheduleRemote(this.parkUntil - this.clock.now())
            return null
          }
        }
        if (this.secondarySuspended && this.clock.now() < this.parkUntil) {
          this.scheduleRemote(this.parkUntil - this.clock.now())
          return null
        }
        this.secondarySuspended = false
      }
      if (tier !== 'local') {
        if (this.state === 'unauthorized') return null
        const wait = this.resumeAt === null ? 0 : this.resumeAt - this.clock.now()
        if (wait > 0) {
          this.scheduleRemote(wait)
          return null
        }
      }
      if (this.running) {
        if (tier === 'local') {
          this.dirtyLocal = true
        } else {
          this.dirtyRemoteTier = tier
        }
        return null
      }
    } else {
      this.clock.clearTimeout(this.remoteTimer)
      this.remoteTimer = undefined
    }
    const work = this.execute(repository, tier, options).finally(() => {
      this.running = null
      if (this.repository !== repository) return
      if (this.dirtyLocal) {
        this.dirtyLocal = false
        this.scheduleLocal(this.intervals.localSettleMs)
      }
      if (this.dirtyRemoteTier) {
        const deferredTier = this.dirtyRemoteTier
        this.dirtyRemoteTier = null
        if (!this.dirtyLocal) {
          void this.run(deferredTier)
        } else {
          this.scheduleRemote(this.intervals.localSettleMs + 10)
        }
      } else if (!this.remoteTimer && this.state !== 'unauthorized') {
        const wait = this.resumeAt === null ? 0 : this.resumeAt - this.clock.now()
        this.scheduleRemote(Math.max(wait, this.intervalFor(this.currentTier())))
      }
    })
    this.running = work
    try {
      return await work
    } catch (error) {
      if (this.repository === repository && tier !== 'local') this.recordFailure(error)
      return null
    }
  }

  private async execute(
    repository: string,
    tier: 'visible' | 'local' | 'secondary',
    options: { manual?: boolean; requestId?: string },
  ): Promise<RepositorySnapshot | null> {
    if (tier === 'secondary') return this.refreshInbox(repository)

    if (tier === 'local') {
      // A filesystem event reads local Git immediately; remote health, failures,
      // rate limits, and backoff belong to GitHub and are untouched by local work.
      const snapshot = await this.deps.scheduler.read(repository, (signal) =>
        this.deps.readSnapshot(repository, signal, {
          requestId: options.requestId ?? 'sync-local',
          github: { remote: 'reuse' },
        }),
      )
      if (this.repository !== repository) return null
      this.emit({ kind: 'snapshot', snapshot: { ...snapshot, remote: this.freshness() } })
      return snapshot
    }

    const live = options.manual === true
    this.state = 'refreshing'
    const snapshot = await this.deps.scheduler.read(repository, (signal) =>
      this.deps.readSnapshot(repository, signal, {
        requestId: options.requestId ?? 'sync-refresh',
        github: { remote: live ? 'live' : 'on-failure' },
      }),
    )
    if (this.repository !== repository) return null
    // A read that fell back to the last confirmed payload is still a failed
    // read: local Git is usable, but the backoff and the state must survive it.
    if (snapshot.githubFailure) {
      this.emit({ kind: 'snapshot', snapshot: { ...snapshot, remote: this.freshness() } })
      this.recordFailure(snapshot.githubFailure)
      return snapshot
    }
    this.adopt(snapshot)
    this.failures = 0
    this.resumeAt = null
    this.rateLimitReset = null
    this.secondarySuspended = false
    if (!this.budgetExhausted()) {
      this.parkUntil = 0
    }
    this.emit({ kind: 'snapshot', snapshot: { ...snapshot, remote: this.freshness() } })
    this.emit({ kind: 'status', freshness: this.freshness() })
    this.scheduleRemote(this.intervalFor(this.currentTier()))
    return snapshot
  }

  private async refreshInbox(repository: string): Promise<null> {
    const issues = await this.deps.scheduler.read(repository, (signal) =>
      this.deps.readIssues(repository, signal),
    )
    if (this.repository !== repository) return null
    this.checkedAt = this.clock.now()
    this.failures = 0
    this.secondarySuspended = false
    if (!this.budgetExhausted()) {
      this.parkUntil = 0
    }
    // An answer at all proves the limit is over, so a parked state lifts without
    // the person having to do anything.
    if (this.state === 'rate-limited') this.state = this.fetchedAt === null ? 'stale' : 'fresh'
    this.emit({ kind: 'issues', issues })
    this.emit({ kind: 'status', freshness: this.freshness() })
    this.scheduleRemote(this.intervalFor('secondary'))
    return null
  }

  private intervalFor(tier: 'visible' | 'secondary'): number {
    if (this.failures > 0) return failureDelay(this.failures, this.intervals)
    return tier === 'visible' ? this.intervals.visibleMs : this.intervals.secondaryMs
  }

  /** Nonessential polling stops once GitHub's remaining budget runs low. */
  private budgetExhausted(): boolean {
    const report = lastGitHubRateLimit()
    const remaining = report.rateLimit.remaining
    const reset = report.rateLimit.reset
    if (reset && this.clock.now() >= reset.getTime()) return false
    return remaining !== null && remaining <= this.intervals.budgetFloor
  }

  private recordFailure(error: unknown): void {
    this.checkedAt = this.clock.now()
    this.failures += 1
    const report = lastGitHubRateLimit()
    const typed = error as { kind?: string; detail?: string }
    const failure = classifyRemoteFailure(
      typed?.detail ?? (error instanceof Error ? error.message : String(error)),
      {
        kind: typed?.kind ?? report.kind,
        remaining: report.rateLimit.remaining,
        reset: report.rateLimit.reset,
      },
    )
    this.state = failure.state
    this.detail = failure.detail
    this.resumeAt = failure.resumeAt
    this.rateLimitReset = failure.resumeAt
    this.secondarySuspended = failure.secondaryOnly
    this.emit({ kind: 'status', freshness: this.freshness() })
    // Without valid credentials every retry fails the same way, so polling waits
    // for the person. Their own refresh is not a retry and still runs.
    if (this.state === 'unauthorized') return
    const delay =
      failure.resumeAt === null
        ? failureDelay(this.failures, this.intervals)
        : failure.resumeAt - this.clock.now()
    this.parkUntil = this.clock.now() + Math.max(delay, this.intervals.localSettleMs)
    this.scheduleRemote(Math.max(delay, this.intervals.localSettleMs))
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
