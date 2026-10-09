import type { LiveCleanupReport, LiveScenarioResult, LiveTarget } from './contract'
import {
  describeThrown,
  failureReport,
  renderRunSummary,
  sanitizeLog,
  type LiveRedactor,
} from './diagnostics'
import { missingCapability, type LiveScenario, type LiveScenarioContext } from './scenario'
import { LIVE_SCENARIOS } from './scenarios'

export interface LiveRunOptions {
  readonly target: LiveTarget
  readonly redactor: LiveRedactor
  /** Scenario ids to run. Empty means the whole catalogue. */
  readonly only?: readonly string[]
  /** Prints each result as it lands, so a long run shows progress. */
  readonly onResult?: (result: LiveScenarioResult) => void
}

export interface LiveRunReport {
  readonly results: readonly LiveScenarioResult[]
  readonly cleanup: LiveCleanupReport
  readonly summary: string
  readonly passed: boolean
}

/**
 * The run.
 *
 * Two properties matter more than the order. First, a scenario whose required
 * capability the target does not have is a failure, not a skip: a suite that
 * silently stops covering merge queues reports green while the thing it exists to
 * catch goes uncaught. Second, cleanup runs whatever happened, and its result is
 * part of the verdict, so a run that left a repository behind is a failed run even
 * when every scenario passed.
 */
export async function runLiveSuite(options: LiveRunOptions): Promise<LiveRunReport> {
  const { target, redactor } = options
  const selected =
    options.only && options.only.length > 0
      ? LIVE_SCENARIOS.filter((scenario) => options.only?.includes(scenario.id))
      : LIVE_SCENARIOS

  const unknown = (options.only ?? []).filter(
    (id) => !LIVE_SCENARIOS.some((scenario) => scenario.id === id),
  )
  const results: LiveScenarioResult[] = []
  for (const id of unknown) {
    results.push({
      id,
      title: 'no such scenario',
      outcome: 'failed',
      durationMs: 0,
      log: [],
      failure: {
        scenario: id,
        message: `no scenario is registered under ${id}`,
        exchanges: [],
      },
    })
  }

  // The workspace comes first because a capability probe is a real write: it needs a
  // branch, a commit, and a pull request to ask the host about, all inside the
  // disposable repository the run owns.
  // Everything that runs after the target exists is inside this try, because everything
  // that runs after the target exists can also fail. A clone that cannot be made, a
  // capability probe the host refuses, an accessor that throws: each of those would
  // otherwise return past the only cleanup this run has and leave a provisioned
  // repository behind, on a host that was reached with somebody's token.
  let startup: unknown = null
  let cleanup: LiveCleanupReport
  try {
    const workspace = await target.workspace()
    const capabilities = await target.probeCapabilities()
    const faults = target.faults()

    for (const scenario of selected) {
      const blocked = missingCapability(capabilities, scenario.requires)
      if (blocked !== null) {
        results.push(
          blockedResult(
            scenario,
            blocked,
            `the target cannot provide what this scenario needs: ${blocked}`,
          ),
        )
        continue
      }
      const log: string[] = []
      const context: LiveScenarioContext = {
        runId: target.runId,
        marker: target.marker,
        target,
        host: target.host,
        repository: target.repository(),
        transport: target.transport(),
        faults,
        workspace,
        admin: target.admin,
        capabilities,
        log: (message: string) => log.push(message),
      }
      const startedAt = Date.now()
      try {
        await scenario.run(context)
        faults.clearFaults()
        const result: LiveScenarioResult = {
          id: scenario.id,
          title: scenario.title,
          outcome: 'passed',
          durationMs: Date.now() - startedAt,
          log: sanitizeLog(redactor, log),
        }
        results.push(result)
        options.onResult?.(result)
      } catch (error) {
        faults.clearFaults()
        const result: LiveScenarioResult = {
          id: scenario.id,
          title: scenario.title,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          log: sanitizeLog(redactor, log),
          failure: failureReport({
            scenario: scenario.id,
            error,
            redactor,
            exchanges: faults.recentExchanges(12),
          }),
        }
        results.push(result)
        options.onResult?.(result)
      }
    }
  } catch (error) {
    // Reported as a result rather than thrown, so the run still ends on its own
    // verdict and the cleanup report is not lost with the stack that led to it.
    startup = error
  } finally {
    cleanup = await settleCleanup(target, redactor)
  }

  if (startup !== null) {
    results.push({
      id: `${selected.length === 0 ? 'suite' : 'suite'}-startup`,
      title: 'the run could not get as far as its scenarios',
      outcome: 'failed',
      durationMs: 0,
      log: [],
      failure: {
        scenario: 'suite-startup',
        message: redactor.text(`the run stopped before its scenarios: ${describeThrown(startup)}`),
        exchanges: [],
      },
    })
  }

  const summary = renderRunSummary(results, redactor)
  return {
    results,
    cleanup,
    summary,
    passed: results.every((result) => result.outcome === 'passed') && cleanup.complete,
  }
}

/**
 * Cleanup that always reports.
 *
 * A cleanup which itself throws has still run, and what it removed before throwing is
 * the truth about the run. Reporting that as an incomplete cleanup with the reason
 * attached keeps the failure of the run and the failure of its cleanup both visible,
 * rather than letting the second replace the first.
 */
async function settleCleanup(
  target: LiveTarget,
  redactor: LiveRedactor,
): Promise<LiveCleanupReport> {
  try {
    return await target.cleanup()
  } catch (error) {
    return {
      removed: [],
      refused: [
        { handle: target.runId, reason: redactor.text(`cleanup failed: ${describeThrown(error)}`) },
      ],
      remaining: [target.marker],
      complete: false,
    }
  }
}

function blockedResult(
  scenario: LiveScenario,
  blockedBy: string,
  message: string,
): LiveScenarioResult {
  return {
    id: scenario.id,
    title: scenario.title,
    outcome: 'failed',
    durationMs: 0,
    log: [],
    failure: { scenario: scenario.id, message, blockedBy, exchanges: [] },
  }
}
