import { sanitizePaths, sanitizeSecrets } from '../../src/main/support-bundle'
import type { LiveFailureReport, LiveScenarioResult } from './contract'

/**
 * What a live run is allowed to print, and what it is never allowed to.
 *
 * The application's own sanitizers know the shapes of GitHub tokens and of local
 * paths. They cannot know the literal secret this run was configured with: a
 * fine-grained token, a test password, or a value that happens not to match any
 * published prefix. So every configured secret is also redacted by value, and
 * the two together are what a failure report is rendered through before it
 * reaches a log, an artifact, or a pull request.
 */
export class LiveRedactor {
  private readonly literals: string[]

  constructor(secrets: readonly string[]) {
    // Longest first, so a secret that contains another is replaced whole rather
    // than leaving a recognizable tail of itself behind.
    this.literals = [...new Set(secrets.filter((value) => value.length >= 4))].sort(
      (left, right) => right.length - left.length,
    )
  }

  /**
   * Removes configured secrets, then the shapes the application already knows, then any
   * credential that happened to be part of a URL.
   *
   * A remote URL is the one place a credential turns up that is not the credential: a
   * Git remote carries `user:password@host`, and a failure report that quotes the remote
   * a push was refused for is quoting the secret along with everything else. Redacting
   * only the literals this run was configured with cannot help there, because the
   * literal appears inside a larger token and the surrounding text survives a
   * replacement that was never attempted.
   */
  text(value: string): string {
    let result = value
    for (const literal of this.literals) {
      result = result.split(literal).join('[REDACTED_SECRET]')
    }
    result = result.replace(/:\/\/[^\s/@]+:[^\s/@]*@/gu, '://[REDACTED_CREDENTIAL]@')
    return sanitizePaths(sanitizeSecrets(result))
  }

  /** The same rule over anything JSON-shaped, keeping the structure readable. */
  value(input: unknown): string {
    try {
      return this.text(JSON.stringify(input) ?? String(input))
    } catch {
      return this.text(String(input))
    }
  }
}

/**
 * The request pairs that led to a failure, with anything credential-shaped
 * removed from the method line. The status is kept because a 409 and a 422 are
 * different bugs; the body is not, because bodies carry repository contents.
 */
export function sanitizeExchange(
  redactor: LiveRedactor,
  exchange: { method: string; path: string; status: number | string },
): string {
  return redactor.text(`${exchange.method} ${exchange.path} -> ${exchange.status}`)
}

export interface LiveFailureInput {
  scenario: string
  error: unknown
  redactor: LiveRedactor
  exchanges?: readonly { method: string; path: string; status: number | string }[]
  blockedBy?: string
}
/**
 * One failure, in a form that can be published. The message and stack go through
 * the redactor, and the exchanges are reduced to method, path, and status:
 * a 409 and a 422 are different bugs, but a body carries repository contents.
 */
export function failureReport(input: LiveFailureInput): LiveFailureReport {
  const { error, redactor } = input
  const message =
    error instanceof Error ? redactor.text(error.message) : redactor.text(String(error))
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : null
  return {
    scenario: input.scenario,
    message: message || `${error instanceof Error ? error.name : typeof error} with no message`,
    ...(stack ? { stack: redactor.text(stack.split('\n').slice(0, 12).join('\n')) } : {}),
    ...(input.blockedBy ? { blockedBy: redactor.text(input.blockedBy) } : {}),
    exchanges: (input.exchanges ?? [])
      .slice(-12)
      .map((exchange) =>
        redactor.text(`${exchange.method} ${exchange.path} -> ${exchange.status}`),
      ),
  }
}

/** A scenario's progress lines, sanitized and bounded, so a log cannot grow without limit. */
/**
 * What a thrown value says, in one line.
 *
 * A failure is the only text a run leaves behind, so the message is taken from the
 * `Error` itself rather than from a stack. The redactor still runs over whatever this
 * returns before it is printed or committed.
 */
export function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sanitizeLog(redactor: LiveRedactor, lines: readonly string[]): string[] {
  return lines.slice(0, 200).map((line) => redactor.text(line))
}

/** The human summary a run prints and a workflow step fails on. */
export function renderRunSummary(
  results: readonly LiveScenarioResult[],
  redactor: LiveRedactor,
): string {
  const passed = results.filter((result) => result.outcome === 'passed')
  const failed = results.filter((result) => result.outcome === 'failed')
  const lines = [
    `live GitHub suite: ${passed.length} passed, ${failed.length} failed, ${results.length} total`,
  ]
  for (const result of failed) {
    lines.push('', `FAILED ${result.id} — ${result.title}`)
    if (result.failure?.blockedBy) lines.push(`  blocked by: ${result.failure.blockedBy}`)
    lines.push(`  ${result.failure?.message ?? 'no message'}`)
    for (const exchange of result.failure?.exchanges ?? []) lines.push(`  ${exchange}`)
  }
  return redactor.text(lines.join('\n'))
}
