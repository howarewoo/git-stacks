import type { SnapshotGitHubRequest } from './sync-coordinator'

/**
 * Tracks in-flight repository reads by the request id the renderer supplied.
 * Claiming a key ends the previous holder, so switching repository, ref, or
 * commit never leaves an obsolete Git process — or its result — in flight.
 */

/**
 * What a read depends on. A local read answers from this repository's Git and
 * file state and is unaffected by which GitHub account is signed in; a GitHub
 * read was pinned to one credential and must not answer for another.
 */
export type ReadPurpose = 'local' | 'github'

/**
 * What a background snapshot read depends on, from the request that asked for
 * it.
 *
 * `live` and `on-failure` both reach GitHub now, so both were read under one
 * credential and both are ended when that credential is replaced. `reuse` asks
 * GitHub nothing at all: its answer is this repository's last confirmed payload
 * plus its own local Git, and a replacement costs it no answer of its own — its
 * generation check drops the payload and the read is rebuilt from local state.
 * Tagging it `github` would end it in `cancelGitHub` instead, which is the one
 * outcome that read is built to survive: the local refresh a filesystem event
 * asked for would be discarded, and the external edit behind it would stay
 * unseen until something else happened to trigger another read.
 */
export function snapshotReadPurpose(request: SnapshotGitHubRequest): ReadPurpose {
  return request.remote === 'reuse' ? 'local' : 'github'
}

export class RequestRegistry {
  private readonly live = new Map<
    string,
    Map<string, { controller: AbortController; purpose: ReadPurpose }>
  >()

  claim(root: string, requestId: string, purpose: ReadPurpose = 'local'): AbortController {
    const forRoot = this.live.get(root) ?? new Map()
    forRoot.get(requestId)?.controller.abort()
    const controller = new AbortController()
    forRoot.set(requestId, { controller, purpose })
    this.live.set(root, forRoot)
    return controller
  }

  release(root: string, requestId: string, controller: AbortController): void {
    const forRoot = this.live.get(root)
    if (forRoot?.get(requestId)?.controller !== controller) return
    forRoot.delete(requestId)
    if (forRoot.size === 0) this.live.delete(root)
  }

  cancel(root: string, requestId: string): void {
    const held = this.live.get(root)?.get(requestId)
    if (!held) return
    held.controller.abort()
    this.live.get(root)?.delete(requestId)
  }

  /** Ends every read still running for `root`, used when the window switches. */
  cancelRoot(root: string): void {
    const forRoot = this.live.get(root)
    if (!forRoot) return
    for (const held of forRoot.values()) held.controller.abort()
    this.live.delete(root)
  }

  /**
   * Ends every GitHub read still running for any root, and leaves the local ones
   * running. A credential replaced behind this app's back leaves reads that were
   * pinned to the old one running: they would otherwise answer later, into rows
   * that now describe another account. A local read carries no credential and
   * answers the same whoever is signed in, so cancelling it would take away
   * history, diffs and file views for a change to a GitHub account, which is the
   * opposite of what that account change should do.
   *
   * A repository switch still ends everything through `cancelRoot`: there, the
   * local work is as obsolete as the GitHub work.
   */
  cancelGitHub(): void {
    for (const [root, forRoot] of this.live.entries()) {
      for (const [requestId, held] of forRoot.entries()) {
        if (held.purpose !== 'github') continue
        held.controller.abort()
        forRoot.delete(requestId)
      }
      if (forRoot.size === 0) this.live.delete(root)
    }
  }
}

/**
 * Runs a background read operation on behalf of the scheduler or sync coordinator,
 * combining the outer scheduler signal with the registry controller signal.
 * When a mutation aborts the scheduler lane, or when the request id is superseded / cancelled,
 * the combined signal aborts immediately.
 */
export async function performBackgroundRead<T>(
  registry: RequestRegistry,
  root: string,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  requestId: string,
  purpose: ReadPurpose = 'local',
): Promise<T> {
  const controller = registry.claim(root, requestId, purpose)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    return await operation(combined)
  } finally {
    registry.release(root, requestId, controller)
  }
}
