import {
  COMMAND_CANCELLATION_MESSAGE,
  COMMAND_CANCELLATION_NAME,
} from '@git-stacks/shared/cancellation'

export function errorMessage(value: unknown, fallback?: string): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === COMMAND_CANCELLATION_NAME &&
    'cancelled' in value &&
    value.cancelled === true &&
    'message' in value &&
    value.message === COMMAND_CANCELLATION_MESSAGE
  )
    return value.message
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'string' && value) return value
  return fallback ?? String(value)
}
