import { AsyncLocalStorage } from 'node:async_hooks'
import type { InspectionContext } from '@git-stacks/shared/inspection'

/** Main-only request authority; never persisted or exposed to the renderer. */
export const inspectionAuthority = new AsyncLocalStorage<{
  root: string
  context: InspectionContext
  signal: AbortSignal
  origin: string | null
  originUrl: string | null
  validate: () => Promise<void>
  /** Management-only final effect fence; ordinary inspections never install it. */
  validateEffect?: () => Promise<void>
}>()

/** An engine can add evolved target facts without replacing original owner authority. */
export const operationEffectGuard = new AsyncLocalStorage<() => Promise<void>>()

export function assertInspectionOrigin(origin: string | null, resolved = false): void {
  const captured = inspectionAuthority.getStore()
  if (!captured) return
  captured.signal.throwIfAborted()
  if (origin !== (resolved ? captured.originUrl : captured.origin))
    throw new Error('The captured origin changed; this request was retired.')
}

/** Called immediately before a provider/editor dispatch, after its other awaits. */
export async function validateInspectionDispatch(): Promise<void> {
  const captured = inspectionAuthority.getStore()
  if (!captured) return
  captured.signal.throwIfAborted()
  await captured.validate()
  captured.signal.throwIfAborted()
}

export async function validateOperationEffect(): Promise<void> {
  const captured = inspectionAuthority.getStore()
  if (captured?.validateEffect) {
    captured.signal.throwIfAborted()
    await captured.validateEffect()
    captured.signal.throwIfAborted()
  }
  await operationEffectGuard.getStore()?.()
}
