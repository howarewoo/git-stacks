/**
 * Cancellation is the answer the user asked for, never a failure: main records
 * no failure for it, and a rejected handler would also log the expected stop as
 * an Electron error stack and flatten it, on the renderer side, to a message
 * string. A cancelled handler therefore resolves with this exact token instead.
 * At the main/preload boundary the preload decodes it back into a rejection
 * before any `DesktopAPI` promise exists, so callers keep rejection semantics
 * and never receive the token as a value.
 *
 * The token is wire-interface exact (structured-clone safe, no Symbols): a
 * genuine result never carries `commandCancellation`.
 */
export const COMMAND_CANCELLATION_NAME = 'CommandCancelled'
export const COMMAND_CANCELLATION_MESSAGE = 'The request was cancelled.'
export const COMMAND_CANCELLATION_WIRE = Object.freeze({
  commandCancellation: true,
})

export interface CommandCancellationWire {
  commandCancellation: true
}

/** A result can never be cancelled, so narrowing is exact: the token is one
 *  record carrying that one field, never a larger payload it rides along in. */
export function isCommandCancellationWire(value: unknown): value is CommandCancellationWire {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as CommandCancellationWire).commandCancellation === true &&
    Object.keys(value).length === 1
  )
}

export interface CancelledAttempt {
  readonly name: typeof COMMAND_CANCELLATION_NAME
  readonly message: typeof COMMAND_CANCELLATION_MESSAGE
  readonly cancelled: true
}

/**
 * The preload rejects a cancelled command with this instead of an `Error`:
 * contextBridge reconstructs a crossing Error from its message only and
 * drops every other fact, so the renderer answer has to be plain data. Every
 * field here survives the bridge, which keeps the renderer's cancelled
 * rejection recognizable and readable while still being a rejection.
 */
export const COMMAND_CANCELLATION_ATTEMPT: CancelledAttempt = Object.freeze({
  name: COMMAND_CANCELLATION_NAME,
  message: COMMAND_CANCELLATION_MESSAGE,
  cancelled: true,
})
