import { setTimeout } from 'node:timers/promises'
import {
  GitHubTransportError,
  type GitHubErrorKind,
  type GitHubGraphqlOptions,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type GitHubTransport,
} from '../../src/main/github-transport'

/** Shared by authorized actors so setup, product writes, and cleanup cannot burst. */
export class LiveRequestPacing {
  private tail: Promise<void> = Promise.resolve()
  private nextMutationAt = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly wait: (milliseconds: number) => Promise<unknown> = setTimeout,
  ) {}

  async run<T>(mutation: boolean, send: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      if (mutation && this.nextMutationAt > this.now()) {
        await this.wait(this.nextMutationAt - this.now())
      }
      try {
        return await send()
      } catch (error) {
        if (
          error instanceof GitHubTransportError &&
          (error.kind === 'rate-limited' || error.kind === 'secondary-rate-limit')
        ) {
          const limit = error.rateLimit
          const deadline = Math.max(
            this.now() + (limit.retryAfterSeconds ?? 60) * 1_000,
            limit.remaining === 0 ? (limit.reset?.getTime() ?? 0) : 0,
          )
          // Park subsequent scenarios and cleanup, but never replay this mutation.
          await this.wait(Math.max(0, deadline - this.now()))
        }
        throw error
      } finally {
        if (mutation) this.nextMutationAt = this.now() + 1_000
      }
    } finally {
      release()
    }
  }
}

/** One request the run made, reduced to what a failure report may publish. */
export interface LiveExchange {
  readonly method: string
  readonly path: string
  readonly status: number | string
}

/** Which request a fault applies to. A rule with no method matches every method. */
export interface LiveFaultMatch {
  method?: string
  pathIncludes: string
}

interface RestRule {
  match: LiveFaultMatch
  /** How many more requests this rule applies to. */
  remaining: number
  /**
   * `lost` sends the request and then reports that nothing came back; the other arm
   * answers without sending, so the host never sees it. The two are different faults
   * and a scenario that wants one must not get the other.
   */
  fault: 'lost' | { status: number; kind: GitHubErrorKind; message: string }
}

/**
 * A transport decorator that records what the run asked GitHub and can break one
 * request at a time.
 *
 * The faults are injected at the adapter boundary rather than in a server, which
 * is what makes them usable against a real host. A lost response is the one fault
 * a fixture cannot stage honestly and a live host must not be asked to produce: the
 * request really is sent, GitHub really does apply it, and only the answer is
 * discarded. That is the exact state a person is in when a merge may or may not
 * have been requested, and it is the only way to prove that a retry does not
 * create a second merge, a second stack, or a second pull request.
 */
export class FaultInjectingTransport implements GitHubTransport {
  readonly kind: 'direct' | 'gh'
  private readonly inner: GitHubTransport
  private readonly rules: RestRule[] = []
  private readonly seen: LiveExchange[] = []

  constructor(
    inner: GitHubTransport,
    private readonly pacing?: LiveRequestPacing,
  ) {
    this.inner = inner
    this.kind = inner.kind
  }

  get destinationHost(): string {
    return this.inner.destinationHost
  }

  credentialAuthority(): Promise<string> {
    return this.inner.credentialAuthority()
  }

  /**
   * Sends the next matching request and then reports that nothing came back.
   * The host has applied it; the caller cannot know that.
   */
  loseOnce(match: LiveFaultMatch): void {
    this.rules.push({ match, remaining: 1, fault: 'lost' })
  }

  /**
   * Answers the next matching request without sending it, so the mutation never
   * reaches the host. This is a refusal the transport has to survive: a spent
   * rate limit, a server error, or a permission the account does not have.
   */
  refuseOnce(
    match: LiveFaultMatch,
    outcome: { status: number; kind: GitHubErrorKind; message: string },
  ): void {
    this.rules.push({ match, remaining: 1, fault: outcome })
  }

  /** Every request the run made, oldest first. Bounded so a long run cannot grow without limit. */
  exchanges(): readonly LiveExchange[] {
    return this.seen
  }

  /** The last requests, which is what a failure report shows. */
  recentExchanges(count = 12): LiveExchange[] {
    return this.seen.slice(-count)
  }

  clearFaults(): void {
    this.rules.length = 0
  }

  private ruleFor(method: string, path: string): RestRule | null {
    const index = this.rules.findIndex(
      (rule) =>
        rule.remaining > 0 &&
        (rule.match.method === undefined || rule.match.method === method) &&
        path.includes(rule.match.pathIncludes),
    )
    if (index === -1) return null
    const rule = this.rules[index]
    rule.remaining -= 1
    return rule
  }

  private record(method: string, path: string, status: number | string): void {
    this.seen.push({ method, path, status })
    if (this.seen.length > 2_000) this.seen.splice(0, this.seen.length - 2_000)
  }

  async rest<T = unknown>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
    const method = request.method ?? 'GET'
    const rule = this.ruleFor(method, request.path)
    if (rule && rule.fault !== 'lost') {
      this.record(method, request.path, rule.fault.status)
      throw new GitHubTransportError({
        kind: rule.fault.kind,
        status: rule.fault.status,
        detail: rule.fault.message,
        ...(rule.fault.kind === 'rate-limited'
          ? {
              rateLimit: {
                limit: 5_000,
                remaining: 0,
                reset: new Date(Date.now() + 60_000),
                resource: 'core',
                retryAfterSeconds: 60,
              },
            }
          : {}),
      })
    }
    try {
      const send = (): Promise<GitHubRestResponse<T>> => this.inner.rest<T>(request)
      const response = await (this.pacing ? this.pacing.run(method !== 'GET', send) : send())
      this.record(method, request.path, response.status)
      if (rule) {
        throw new GitHubTransportError({
          kind: 'network',
          detail: 'the connection dropped after GitHub applied the request',
        })
      }
      return response
    } catch (error) {
      if (error instanceof GitHubTransportError && rule) {
        this.record(method, request.path, error.status ?? error.kind)
      }
      throw error
    }
  }

  async paginate<T = unknown>(request: GitHubRestRequest): Promise<T[]> {
    const method = request.method ?? 'GET'
    try {
      const send = (): Promise<T[]> => this.inner.paginate<T>(request)
      const items = await (this.pacing ? this.pacing.run(method !== 'GET', send) : send())
      this.record(method, request.path, 200)
      return items
    } catch (error) {
      this.record(
        method,
        request.path,
        error instanceof GitHubTransportError ? (error.status ?? error.kind) : 'error',
      )
      throw error
    }
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
    options: GitHubGraphqlOptions = {},
  ): Promise<T> {
    // A GraphQL request has no path, so the operation is what names it. Matching and
    // recording use the same label, which is what lets a scenario aim a fault at one
    // mutation instead of at whichever GraphQL call happens to come first.
    const operation = `graphql:${/^\s*(?:query|mutation)\s+(\w+)/u.exec(query)?.[1] ?? 'anonymous'}`
    const rule = this.ruleFor('POST', operation)
    if (rule && rule.fault !== 'lost') {
      this.record('POST', operation, rule.fault.status)
      throw new GitHubTransportError({
        kind: rule.fault.kind,
        status: rule.fault.status,
        detail: rule.fault.message,
      })
    }
    try {
      const send = (): Promise<T> => this.inner.graphql<T>(query, variables, options)
      const data = await (this.pacing
        ? this.pacing.run(/^\s*mutation\b/u.test(query), send)
        : send())
      this.record('POST', operation, 200)
      if (rule) {
        throw new GitHubTransportError({
          kind: 'network',
          detail: 'the connection dropped after GitHub applied the request',
        })
      }
      return data
    } catch (error) {
      if (error instanceof GitHubTransportError && rule) {
        this.record('POST', operation, error.status ?? error.kind)
      }
      throw error
    }
  }
}
