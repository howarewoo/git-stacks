import type { PullRequestIndex } from '../shared/pr-index'
import type { PullRequest } from '../shared/types'
import { CommandCancelled, isCancelled, parseRemote } from './git-core'
import { githubErrorMessage } from './github'

export interface PullRequestIndexPage {
  pullRequests: PullRequest[]
  next: string | null
  viewer: string | null
  conservative: boolean
}

/** Main-owned, display-only index. A page never becomes a complete mutation input. */
export class ProgressivePullRequestIndex {
  private state: PullRequestIndex | null = null
  private generation = 0
  private controller: AbortController | null = null
  private first: Promise<PullRequestIndex> | null = null
  private rejectFirst: ((error: Error) => void) | null = null
  private resolveFirst: ((state: PullRequestIndex) => void) | null = null
  private detail = new Map<number, PullRequest & { body: string }>()
  private retainedAuthority: string | null = null
  private viewerConfirmed = false

  constructor(
    private readonly page: (
      origin: string,
      cursor: string | null,
      basic: boolean,
      signal: AbortSignal,
    ) => Promise<PullRequestIndexPage>,
    private readonly authority: (host: string) => Promise<string>,
    private readonly publish: (state: PullRequestIndex) => void,
    private readonly canContinue: (host: string) => boolean,
  ) {}

  current(): PullRequestIndex | null {
    return this.state
  }

  invalidate(): void {
    this.generation++
    this.rejectFirst?.(new CommandCancelled())
    this.rejectFirst = null
    this.resolveFirst = null
    this.controller?.abort()
    this.controller = null
    this.first = null
    this.detail.clear()
    this.viewerConfirmed = false
    if (this.state)
      this.publish({
        ...this.state,
        viewer: null,
        pullRequests: [],
        state: 'stale',
        complete: false,
        fetchedAt: null,
        message: 'PR index authority changed',
      })
    this.state = null
  }

  cancel(): void {
    this.generation++
    this.rejectFirst?.(new CommandCancelled())
    this.rejectFirst = null
    this.resolveFirst = null
    this.controller?.abort()
    this.controller = null
    this.first = null
    if (this.state)
      this.update({
        ...this.state,
        state: 'stale',
        complete: false,
        message: 'PR indexing was cancelled',
      })
  }

  /** The first response is published and returned without waiting for later pages. */
  async load(repository: string, host: string, origin: string): Promise<PullRequestIndex> {
    const admission = this.generation
    const fullName = parseRemote(origin)?.fullName ?? origin
    const currentAuthority = await this.authority(host)
    if (admission !== this.generation) throw new CommandCancelled()
    if (this.retainedAuthority !== null && currentAuthority !== this.retainedAuthority)
      this.invalidate()
    this.retainedAuthority = currentAuthority
    if (
      this.state &&
      (this.state.repository !== repository ||
        this.state.host !== host ||
        this.state.fullName.toLowerCase() !== fullName.toLowerCase())
    )
      this.invalidate()
    if (this.first) return this.resolveFirst ? this.first : this.state!
    if (this.state?.state === 'complete' && this.viewerConfirmed) return this.state
    const previous = this.state
    this.update({
      repository,
      host,
      fullName,
      viewer: previous?.viewer ?? null,
      pullRequests: previous?.pullRequests ?? [],
      state: 'loading',
      complete: false,
      fetchedAt: previous?.fetchedAt ?? null,
      checkedAt: previous?.checkedAt ?? null,
      message: null,
      pages: previous?.pages ?? 0,
    })
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    const { promise, resolve, reject } = Promise.withResolvers<PullRequestIndex>()
    this.first = promise
    this.resolveFirst = resolve
    this.rejectFirst = reject
    const started = promise
    void (async () => {
      let cursor: string | null = null
      let basic = false
      let viewer: string | null = null
      let pages = 0
      const fetched = new Map<number, PullRequest>()
      try {
        const authority = await this.authority(host)
        for (;;) {
          if (controller.signal.aborted || generation !== this.generation)
            throw new CommandCancelled()
          const result = await this.page(origin, cursor, basic, controller.signal)
          if (controller.signal.aborted || generation !== this.generation)
            throw new CommandCancelled()
          if (authority !== (await this.authority(host))) {
            this.invalidate()
            throw new CommandCancelled()
          }
          if (pages > 0 && result.viewer !== viewer) {
            this.invalidate()
            throw new CommandCancelled()
          }
          viewer = result.viewer
          this.viewerConfirmed = true
          basic = result.conservative
          pages++
          for (const pr of result.pullRequests) fetched.set(pr.number, pr)
          const complete = result.next === null
          const known = new Map(
            (complete ? [] : (previous?.pullRequests ?? [])).map((pr) => [pr.number, pr]),
          )
          for (const [number, pr] of fetched) known.set(number, pr)
          const state: PullRequestIndex = {
            repository,
            host,
            fullName,
            viewer,
            pullRequests: [...known.values()],
            state: complete ? 'complete' : 'partial',
            complete,
            fetchedAt: complete ? new Date().toISOString() : (previous?.fetchedAt ?? null),
            checkedAt: new Date().toISOString(),
            message: null,
            pages,
          }
          this.update(state)
          if (this.resolveFirst) {
            this.resolveFirst(state)
            this.resolveFirst = null
            this.rejectFirst = null
          }
          if (complete) return
          cursor = result.next
          if (!this.canContinue(host)) {
            this.update({
              ...state,
              message: 'Further pages paused by the host rate-limit budget',
            })
            return
          }
        }
      } catch (error) {
        if (generation !== this.generation) return
        const state = this.state!
        this.update({
          ...state,
          state: isCancelled(error) ? 'stale' : 'error',
          complete: false,
          message: isCancelled(error) ? 'PR indexing was cancelled' : githubErrorMessage(error),
        })
        if (this.resolveFirst) {
          this.resolveFirst(this.state!)
          this.resolveFirst = null
          this.rejectFirst = null
        }
      } finally {
        if (generation === this.generation) {
          this.controller = null
          this.first = null
        }
      }
    })()
    return started
  }

  /** A coordinator-confirmed full snapshot supersedes any older page sequence. */
  adopt(repository: string, host: string, fullName: string, pullRequests: PullRequest[]): void {
    if (
      this.state &&
      (this.state.repository !== repository ||
        this.state.host !== host ||
        this.state.fullName.toLowerCase() !== fullName.toLowerCase())
    )
      this.invalidate()
    this.generation++
    this.controller?.abort()
    this.controller = null
    this.first = null
    this.detail.clear()
    const now = new Date().toISOString()
    this.update({
      repository,
      host,
      fullName,
      viewer: this.state?.viewer ?? null,
      pullRequests: pullRequests.filter((pr) => pr.state === 'OPEN'),
      state: 'complete',
      complete: true,
      fetchedAt: now,
      checkedAt: now,
      message: null,
      pages: 0,
    })
    this.resolveFirst?.(this.state!)
    this.resolveFirst = null
    this.rejectFirst = null
  }

  /** Only selected details are retained; unsent drafts and recovery journals are elsewhere. */
  async selected(
    number: number,
    read: () => Promise<PullRequest & { body: string }>,
  ): Promise<PullRequest & { body: string }> {
    if (
      this.state &&
      this.retainedAuthority !== null &&
      this.retainedAuthority !== (await this.authority(this.state.host))
    ) {
      this.invalidate()
      throw new CommandCancelled()
    }
    const cached = this.detail.get(number)
    if (cached) return cached
    const generation = this.generation
    const captured = this.state?.pullRequests.find((pr) => pr.number === number)
    const value = await read()
    if (generation !== this.generation) throw new CommandCancelled()
    if (
      this.state &&
      this.retainedAuthority !== null &&
      this.retainedAuthority !== (await this.authority(this.state.host))
    ) {
      this.invalidate()
      throw new CommandCancelled()
    }
    const current = this.state?.pullRequests.find((pr) => pr.number === number)
    if (
      captured &&
      (!current ||
        captured.headOid !== current.headOid ||
        captured.head !== current.head ||
        captured.base !== current.base ||
        captured.headRepository !== current.headRepository)
    )
      throw new CommandCancelled()
    if (
      current &&
      ((current.headOid !== undefined && current.headOid !== value.headOid) ||
        current.head !== value.head ||
        current.base !== value.base ||
        (current.headRepository !== undefined && current.headRepository !== value.headRepository))
    )
      throw new CommandCancelled()
    if (generation !== this.generation) throw new CommandCancelled()
    if (generation === this.generation) {
      this.detail.delete(number)
      this.detail.set(number, value)
      if (this.detail.size > 4) this.detail.delete(this.detail.keys().next().value!)
    }
    return value
  }

  private update(state: PullRequestIndex): void {
    const byNumber = new Map(state.pullRequests.map((pr) => [pr.number, pr]))
    for (const [number, detail] of this.detail) {
      const source = byNumber.get(number)
      if (
        (!source && state.complete) ||
        (source &&
          (source.headOid !== detail.headOid ||
            source.head !== detail.head ||
            source.base !== detail.base ||
            source.headRepository !== detail.headRepository))
      )
        this.detail.delete(number)
    }
    this.state = state
    this.publish(state)
  }
}
