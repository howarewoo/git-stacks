/**
 * A bounded in-memory record of failures the main process handled. It exists so
 * a support bundle can carry what went wrong on this machine, and it holds
 * nothing else: no repository, no file, no command, no token. Entries are
 * dropped when the cap is reached, so a failing action in a loop cannot grow
 * the process without bound.
 */
const MAX_ENTRIES = 40
const entries: string[] = []

/**
 * Records one handled failure. The message is kept as the main process already
 * worded it for the window; anything that looks like a credential is redacted
 * by the bundle before it is written, never stored here.
 */
export function recordFailure(scope: string, message: string): void {
  const line = `${new Date().toISOString()} ${scope}: ${message.split('\n')[0].slice(0, 300)}`
  entries.push(line)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

export function recordedFailures(): readonly string[] {
  return entries
}
