/**
 * Tracks in-flight repository reads by the request id the renderer supplied.
 * Claiming a key ends the previous holder, so switching repository, ref, or
 * commit never leaves an obsolete Git process — or its result — in flight.
 */
export class RequestRegistry {
  private readonly live = new Map<string, Map<string, AbortController>>()

  claim(root: string, requestId: string): AbortController {
    const forRoot = this.live.get(root) ?? new Map<string, AbortController>()
    forRoot.get(requestId)?.abort()
    const controller = new AbortController()
    forRoot.set(requestId, controller)
    this.live.set(root, forRoot)
    return controller
  }

  release(root: string, requestId: string, controller: AbortController): void {
    const forRoot = this.live.get(root)
    if (forRoot?.get(requestId) !== controller) return
    forRoot.delete(requestId)
    if (forRoot.size === 0) this.live.delete(root)
  }

  cancel(root: string, requestId: string): void {
    const controller = this.live.get(root)?.get(requestId)
    if (!controller) return
    controller.abort()
    this.live.get(root)?.delete(requestId)
  }

  /** Ends every read still running for `root`, used when the window switches. */
  cancelRoot(root: string): void {
    const forRoot = this.live.get(root)
    if (!forRoot) return
    for (const controller of forRoot.values()) controller.abort()
    this.live.delete(root)
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
): Promise<T> {
  const controller = registry.claim(root, requestId)
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal
  try {
    return await operation(combined)
  } finally {
    registry.release(root, requestId, controller)
  }
}
