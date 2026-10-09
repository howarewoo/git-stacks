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
 * Records only the fixed IPC channel and a known error category. Error messages
 * and names can contain repository data, so neither is stored or exported.
 */
export function recordFailure(scope: string, error: unknown): void {
  const category =
    error instanceof TypeError
      ? 'type error'
      : error instanceof RangeError
        ? 'range error'
        : error instanceof SyntaxError
          ? 'syntax error'
          : 'operation failed'
  const line = `${new Date().toISOString()} ${scope}: ${category}`
  entries.push(line)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

export function recordedFailures(): readonly string[] {
  return entries
}
