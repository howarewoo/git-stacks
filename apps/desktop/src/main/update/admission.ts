import { randomUUID } from 'node:crypto'
import type { UpdateStatus } from '@git-stacks/shared/update'

/**
 * An authority that runs or queues mutations against one or more repositories.
 * Long background reads and external tool activity do not implement this.
 */
export interface MutationAuthority {
  hasActiveOrQueuedMutations(): boolean
}

export interface UpdateReadinessReport {
  ready: boolean
  reason?: string
}
export type UpdateReadinessResult = UpdateReadinessReport & { session?: ReadinessSession }

export type AdmissionState = 'idle' | 'fenced' | 'sealed' | 'installing'

export interface AdmissionResult {
  ok: boolean
  reason?: string
}

/**
 * Minimal interface for an Electron WebContents or compatible test double.
 */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  once?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

/**
 * A lifecycle-bound readiness session tracking the renderer window through
 * pre-native dispatch.
 */
export interface ReadinessSession {
  nonce: string
  webContents: WebContentsLike
  abortController: AbortController
  isInvalidated(): boolean
  getInvalidationReason(): string | undefined
  cleanup(): void
}

/**
 * App-wide installation admission barrier.
 *
 * Ensures that an update install dispatch cannot race mutations or lose
 * authored text across any repository.
 *
 * Admission is synchronous: before any async wait, it atomically refuses if
 * relevant mutations are queued or running across any repository or clone.
 * Once admitted, the fence prevents any new conflicting mutations or clones from
 * starting or queueing until safe cutover, failure, or cancellation.
 *
 * Already-authored draft saves in the renderer's scoped FIFO queue are permitted
 * to complete and persist to disk during the readiness drain window, while any
 * new draft saves are blocked once cutover begins.
 */
export class InstallAdmissionFence {
  state: AdmissionState = 'idle'
  activeClones = 0
  activeDraftWrites = 0
  private readonly authorities = new Set<MutationAuthority>()
  private readonly draftDrainWaiters: Array<() => void> = []

  registerAuthority(authority: MutationAuthority): () => void {
    this.authorities.add(authority)
    return () => {
      this.authorities.delete(authority)
    }
  }

  get isFenced(): boolean {
    return this.state !== 'idle'
  }

  hasActiveClones(): boolean {
    return this.activeClones > 0
  }

  hasActiveDraftWrites(): boolean {
    return this.activeDraftWrites > 0
  }

  /**
   * True if any registered authority has active or queued mutations, or if
   * clone or draft writes are active.
   */
  hasActiveOrQueuedMutations(): boolean {
    if (this.activeClones > 0 || this.activeDraftWrites > 0) return true
    for (const authority of this.authorities) {
      if (authority.hasActiveOrQueuedMutations()) return true
    }
    return false
  }

  /**
   * Synchronously checks all mutation entrypoints across all repositories and
   * claims the fence.
   *
   * Must be invoked BEFORE the first async wait in an install request.
   */
  admit(): AdmissionResult {
    if (this.state !== 'idle') {
      return {
        ok: false,
        reason: 'An update installation is already in progress.',
      }
    }

    if (this.activeClones > 0) {
      return {
        ok: false,
        reason: 'Cannot install an update while a repository clone is in progress.',
      }
    }

    for (const authority of this.authorities) {
      if (authority.hasActiveOrQueuedMutations()) {
        return {
          ok: false,
          reason: 'Cannot install an update while repository mutations are queued or running.',
        }
      }
    }

    this.state = 'fenced'
    return { ok: true }
  }

  /**
   * Asserts that no update installation fence is held. Throws if fenced.
   */
  assertNotFenced(operationName = 'operation'): void {
    if (this.state !== 'idle') {
      throw new Error(`Cannot run ${operationName}: an update installation is in progress.`)
    }
  }

  /**
   * Marks that the native cutover step has begun.
   */
  markInstalling(): void {
    this.state = 'installing'
  }
  /**
   * Seals the fence after readiness and draft drain complete, blocking any
   * new draft saves before native cutover.
   */
  seal(): void {
    if (this.state === 'fenced') {
      this.state = 'sealed'
    }
  }

  /**
   * Releases the fence and returns state to idle.
   */
  release(): void {
    this.state = 'idle'
  }

  /**
   * Guards a clone operation. Checks the fence before starting and tracks
   * in-flight activity while running.
   */
  async trackClone<T>(operation: () => Promise<T>): Promise<T> {
    this.assertNotFenced('repository clone')
    this.activeClones += 1
    try {
      return await operation()
    } finally {
      this.activeClones -= 1
    }
  }

  /**
   * Guards a draft write. Permits in-flight and FIFO successor draft saves to
   * finish persisting to disk while fenced, but rejects any draft saves once
   * native cutover begins.
   */
  async trackDraftWrite<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'sealed' || this.state === 'installing') {
      throw new Error(
        'Cannot save review drafts: an update installation preparation is in progress.',
      )
    }
    this.activeDraftWrites += 1
    try {
      return await operation()
    } finally {
      this.activeDraftWrites -= 1
      if (this.activeDraftWrites === 0) {
        for (const done of this.draftDrainWaiters.splice(0)) done()
      }
    }
  }

  /**
   * Waits for all in-flight draft writes to settle to disk.
   */
  async waitForActiveDraftWrites(timeoutMs = 15_000): Promise<boolean> {
    if (this.activeDraftWrites === 0) return true
    return new Promise<boolean>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const idx = this.draftDrainWaiters.indexOf(done)
        if (idx !== -1) this.draftDrainWaiters.splice(idx, 1)
        resolve(this.activeDraftWrites === 0)
      }, timeoutMs)

      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      }
      this.draftDrainWaiters.push(done)
    })
  }
}

/**
 * Coordinates renderer draft readiness before native cutover dispatch.
 * Binds lifecycle listeners to the renderer window to fail closed if the
 * window closes, crashes, or reloads before native cutover.
 */
export class RendererReadinessCoordinator {
  private pendingRequests = new Map<
    string,
    {
      resolve: (report: UpdateReadinessResult) => void
      timer: NodeJS.Timeout
      session: ReadinessSession
    }
  >()

  /**
   * Sends readiness preparation request to the renderer window and awaits
   * its report. Fails closed if the renderer is missing, destroyed, or closes.
   */
  async checkReadiness(
    webContents: WebContentsLike | null,
    timeoutMs = 15_000,
  ): Promise<UpdateReadinessResult> {
    if (!webContents || webContents.isDestroyed()) {
      return {
        ready: false,
        reason: 'Active application window is required to coordinate update readiness.',
      }
    }
    const nonce = randomUUID()
    const abortController = new AbortController()
    let invalidated = false
    let invalidationReason: string | undefined

    const onDestroyed = () => invalidate('Renderer window was destroyed.')
    const onCrashed = () => invalidate('Renderer process exited unexpectedly.')
    const onNavigated = () => invalidate('Renderer window navigated or reloaded.')

    const cleanup = () => {
      webContents.removeListener?.('destroyed', onDestroyed)
      webContents.removeListener?.('render-process-gone', onCrashed)
      webContents.removeListener?.('did-start-navigation', onNavigated)
    }

    const session: ReadinessSession = {
      nonce,
      webContents,
      abortController,
      isInvalidated: () => invalidated,
      getInvalidationReason: () => invalidationReason,
      cleanup,
    }

    const invalidate = (reason: string) => {
      if (invalidated) return
      invalidated = true
      invalidationReason = reason
      abortController.abort()
      cleanup()
      const pending = this.pendingRequests.get(nonce)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(nonce)
        pending.resolve({ ready: false, reason, session })
      }
    }

    webContents.once?.('destroyed', onDestroyed)
    webContents.once?.('render-process-gone', onCrashed)
    webContents.once?.('did-start-navigation', onNavigated)

    return new Promise<UpdateReadinessResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(nonce)
        session.cleanup()
        resolve({
          ready: false,
          reason: 'Timed out waiting for editor and review draft readiness.',
          session,
        })
      }, timeoutMs)

      this.pendingRequests.set(nonce, { resolve, timer, session })
      try {
        webContents.send('update:prepare-readiness', { nonce })
      } catch (error) {
        clearTimeout(timer)
        this.pendingRequests.delete(nonce)
        session.cleanup()
        resolve({
          ready: false,
          reason: `Failed to request readiness from renderer: ${error instanceof Error ? error.message : String(error)}`,
          session,
        })
      }
    })
  }

  /**
   * Receives readiness report from renderer.
   */
  reportReadiness(report: { nonce: string; ready: boolean; reason?: string }): boolean {
    const pending = this.pendingRequests.get(report.nonce)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pendingRequests.delete(report.nonce)
    if (!report.ready) {
      pending.session.cleanup()
    }
    pending.resolve({
      ready: report.ready,
      reason: report.reason,
      session: pending.session,
    })
    return true
  }

  /**
   * Revalidates that the session is still valid right before native dispatch.
   */
  revalidate(session: ReadinessSession): { valid: boolean; reason?: string } {
    if (session.isInvalidated()) {
      return {
        valid: false,
        reason: session.getInvalidationReason() ?? 'Renderer readiness was invalidated.',
      }
    }
    if (session.webContents.isDestroyed()) {
      return {
        valid: false,
        reason: 'Renderer window is destroyed.',
      }
    }
    return { valid: true }
  }

  /**
   * Notifies renderer that admission settled (whether cut over or released).
   */
  notifySettled(webContents: WebContentsLike | null, admitted: boolean, nonce?: string): void {
    if (!webContents || webContents.isDestroyed()) return
    try {
      webContents.send('update:admission-settled', { admitted, nonce })
    } catch {
      // Window may have already closed.
    }
  }
}

export interface InstallInvocationOptions {
  beforeNativeCutover?: () => void
  onNativeCutover?: () => void
  signal?: AbortSignal
}

export interface CoordinateSafeInstallOptions {
  fence: InstallAdmissionFence
  readiness: RendererReadinessCoordinator
  getWebContents: () => WebContentsLike | null
  install: (options: InstallInvocationOptions) => Promise<UpdateStatus>
  readinessTimeoutMs?: number
}

/**
 * Executes safe installation flow:
 * 1. Synchronously checks and claims admission fence before any async wait.
 * 2. Coordinates lifecycle-bound renderer readiness (pending/FIFO draft saves).
 * 3. Drains any in-flight draft writes to completion.
 * 4. Revalidates renderer window lifecycle before native cutover.
 * 5. Dispatches to installer with explicit native cutover listener.
 * 6. Holds fence ONLY upon actual native cutover dispatch (macOS live bundle swap or
 *    Windows NSIS detached spawn); releases fence and restores usability on safe
 *    refusal, cancelled attempt, or pre-dispatch failure.
 */
export async function coordinateSafeInstall(
  options: CoordinateSafeInstallOptions,
): Promise<UpdateStatus> {
  const { fence, readiness, getWebContents, install, readinessTimeoutMs } = options

  // 1. Synchronous admission check before ANY async await
  const admission = fence.admit()
  if (!admission.ok) {
    throw new Error(admission.reason ?? 'Update installation admission was refused.')
  }

  let cutoverReached = false
  let attemptNonce: string | undefined
  const webContents = getWebContents()

  try {
    // 2. Coordinate renderer readiness
    const report = await readiness.checkReadiness(webContents, readinessTimeoutMs)
    attemptNonce = report.session?.nonce
    if (!report.ready || !report.session) {
      report.session?.cleanup()
      throw new Error(
        report.reason ?? 'Unsaved authored drafts or pending edits prevent update installation.',
      )
    }
    const session = report.session

    try {
      // 3. Drain any in-flight / FIFO draft saves that were already in progress
      const drained = await fence.waitForActiveDraftWrites(readinessTimeoutMs)
      if (!drained || fence.activeDraftWrites > 0) {
        throw new Error('Timed out waiting for existing review drafts to save.')
      }
      // 4. Seal the fence: from this point forward, NO draft saves are permitted
      fence.seal()

      // 4. Revalidate renderer window lifecycle right before native dispatch
      const validity = readiness.revalidate(session)
      if (!validity.valid) {
        throw new Error(`Renderer readiness was invalidated before cutover: ${validity.reason}`)
      }

      // 5. Dispatch install with pre-cutover validation and native cutover listener
      const status = await install({
        beforeNativeCutover: () => {
          const preCutoverCheck = readiness.revalidate(session)
          if (!preCutoverCheck.valid) {
            throw new Error(
              `Renderer readiness was invalidated during preparation: ${preCutoverCheck.reason}`,
            )
          }
          if (fence.state !== 'sealed') {
            throw new Error('Admission fence is not sealed for native cutover.')
          }
        },
        onNativeCutover: () => {
          cutoverReached = true
          fence.markInstalling()
        },
        signal: session.abortController.signal,
      })

      // 6. If native cutover was not reached (e.g. installer returned refusal, digest mismatch):
      if (!cutoverReached) {
        fence.release()
        readiness.notifySettled(webContents, false, attemptNonce)
      }

      return status
    } finally {
      session.cleanup()
    }
  } catch (error) {
    if (!cutoverReached) {
      fence.release()
      readiness.notifySettled(webContents, false, attemptNonce)
    }
    throw error
  }
}
