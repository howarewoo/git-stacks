/**
 * The one object guard in this project. Network, IPC, settings, and feed
 * payloads all narrow through it before their fields are read, so a field
 * remains `unknown` until the code that owns it has checked it.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
