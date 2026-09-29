import { CommandCancelled } from './git-core'

const DEFAULT_READ_CONCURRENCY = 2

interface RepositoryLane {
  repository: string
  /** Reads waiting for the lane to clear. */
  waiting: (() => void)[]
  /** Mutations waiting for the lane, in submission order. */
  mutations: (() => void)[]
  mutationActive: boolean
  readsActive: number
  /** The controllers of the reads running right now, so a mutation can end them. */
  activeReads: Set<AbortController>
  /** Waiters for the lane to have no running read. */
  settled: (() => void)[]
  /** A mutation that has claimed the lane and waits for the reads it ended. */
  pendingStart: (() => void) | null
}

/**
 * Per-repository ordering for background refresh reads and repository
 * mutations. Background reads may overlap each other, because several views ask
 * for different data at once, but a mutation first claims the lane: it ends the
 * reads still running, waits for them to settle, and holds the lane until it
 * does. A Git operation therefore never waits on a network that is not
 * answering, never overlaps a read still unwinding from that abort, and no
 * read starts against a repository that is mid-mutation.
 *
 * Reads routed here are background work the user did not request. A foreground
 * read the user is waiting on belongs to `RepositoryOperations`, which serialises
 * it against the action it belongs to.
 */
export class RepositoryScheduler {
  private readonly lanes = new Map<string, RepositoryLane>()
  private readonly readConcurrency: number

  constructor(readConcurrency = DEFAULT_READ_CONCURRENCY) {
    this.readConcurrency = Math.max(1, readConcurrency)
  }

  private lane(repository: string): RepositoryLane {
    const existing = this.lanes.get(repository)
    if (existing) return existing
    const lane: RepositoryLane = {
      repository,
      waiting: [],
      mutations: [],
      mutationActive: false,
      readsActive: 0,
      activeReads: new Set(),
      settled: [],
      pendingStart: null,
    }
    this.lanes.set(repository, lane)
    return lane
  }

  /** True while any mutation holds or awaits this repository's lane. */
  busy(repository: string): boolean {
    const lane = this.lanes.get(repository)
    return Boolean(lane && (lane.mutationActive || lane.mutations.length > 0))
  }

  pendingReads(repository: string): number {
    return this.lanes.get(repository)?.waiting.length ?? 0
  }

  /**
   * A background read. It runs concurrently with other reads up to the limit,
   * waits its turn while a mutation is queued or running, and is ended — not
   * awaited — when a mutation claims the lane.
   */
  read<T>(
    repository: string,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lane = this.lane(repository)
    const start = (): Promise<T> => {
      if (signal?.aborted) throw new CommandCancelled()
      const controller = new AbortController()
      const forward = () => controller.abort()
      if (signal) signal.addEventListener('abort', forward, { once: true })
      lane.activeReads.add(controller)
      lane.readsActive += 1
      return Promise.resolve()
        .then(() => {
          // A mutation claimed the lane before this read began, so the read
          // never runs: an already-ended signal would otherwise leave it
          // holding a lane that nothing can release.
          if (controller.signal.aborted) throw new CommandCancelled()
          return task(controller.signal)
        })
        .finally(() => {
          lane.activeReads.delete(controller)
          lane.readsActive -= 1
          signal?.removeEventListener('abort', forward)
          this.notifySettled(lane)
          this.drain(lane)
          this.retire(lane)
        })
    }
    if (!lane.mutationActive && lane.mutations.length === 0) {
      return this.whenReadable(lane, start)
    }
    return new Promise<T>((resolve, reject) => {
      lane.waiting.push(() => {
        this.whenReadable(lane, start).then(resolve, reject)
      })
    })
  }

  private whenReadable<T>(lane: RepositoryLane, start: () => Promise<T>): Promise<T> {
    if (lane.readsActive < this.readConcurrency) return start()
    return new Promise<T>((resolve, reject) => {
      lane.waiting.push(() => {
        start().then(resolve, reject)
      })
    })
  }

  /**
   * A repository mutation. Every mutation for one repository runs alone and in
   * submission order, and it ends the background reads that would interleave
   * and waits for those reads to settle before its own work begins.
   */
  async mutate<T>(repository: string, task: () => Promise<T>): Promise<T> {
    const lane = this.lane(repository)
    await new Promise<void>((start) => {
      lane.mutations.push(start)
      this.drain(lane)
    })
    try {
      return await task()
    } finally {
      lane.mutationActive = false
      this.notifySettled(lane)
      this.drain(lane)
      this.retire(lane)
    }
  }

  /**
   * Ends every background read for the repository and waits for them to settle,
   * so work that must not overlap a Git command can start immediately.
   */
  quiesce(repository: string): Promise<void> {
    const lane = this.lanes.get(repository)
    if (!lane) return Promise.resolve()
    this.endReads(lane)
    if (lane.readsActive === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      lane.settled.push(resolve)
    })
  }

  private endReads(lane: RepositoryLane): void {
    for (const controller of lane.activeReads) controller.abort()
  }

  private notifySettled(lane: RepositoryLane): void {
    if (lane.readsActive > 0) return
    for (const done of lane.settled.splice(0)) done()
    const start = lane.pendingStart
    lane.pendingStart = null
    start?.()
  }

  private drain(lane: RepositoryLane): void {
    if (lane.mutationActive) return
    const start = lane.mutations.shift()
    if (start) {
      lane.mutationActive = true
      // A Git command must not interleave with a read of the same repository,
      // and a read that is stuck on an unreachable network must not delay it:
      // the abort ends it, and the mutation starts as soon as it has settled.
      this.endReads(lane)
      if (lane.readsActive > 0) {
        lane.pendingStart = start
        return
      }
      start()
      return
    }
    while (lane.readsActive < this.readConcurrency && lane.waiting.length > 0) {
      lane.waiting.shift()?.()
    }
  }

  private retire(lane: RepositoryLane): void {
    if (lane.mutationActive || lane.mutations.length > 0) return
    if (lane.pendingStart) return
    if (lane.readsActive > 0 || lane.waiting.length > 0 || lane.settled.length > 0) return
    if (this.lanes.get(lane.repository) === lane) this.lanes.delete(lane.repository)
  }
}
