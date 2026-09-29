/**
 * GitHub reports a pull request's CI three ways — check runs, legacy commit statuses,
 * and Actions workflow runs — and each has its own vocabulary. This module is the one
 * place that turns those vocabularies into the states Git Stacks shows, so a row
 * badge, the inspector, and a merge blocker can never read one check two ways.
 *
 * Nothing here performs I/O: classification and rollup are pure functions over values
 * GitHub already returned, which is what makes them testable without a network double.
 */

/** Where one reported check came from. A workflow run is distinct from its check run. */
export type PullRequestCheckSource = 'check-run' | 'commit-status' | 'workflow-run' | 'expected'

/**
 * The states GitHub can report, normalised. `unknown` is reserved for a value this
 * build does not recognise: it is never a synonym for success or for "no checks".
 */
export type PullRequestCheckState =
  | 'queued'
  | 'in-progress'
  | 'waiting'
  | 'success'
  | 'failure'
  | 'action-required'
  | 'cancelled'
  | 'skipped'
  | 'neutral'
  | 'unknown'

/**
 * Whether a check gates the merge. `unknown` is the honest answer whenever the
 * repository's required-checks data could not be read; it is not "informational".
 */
export type PullRequestCheckRequirement = 'required' | 'informational' | 'unknown'

export interface PullRequestCheckDetail {
  /** Stable identity for one reported check, unique within a report. */
  key: string
  name: string
  source: PullRequestCheckSource
  /** The reporting app or status creator, when GitHub named one. */
  app: string | null
  state: PullRequestCheckState
  requirement: PullRequestCheckRequirement
  /** GitHub's own one-line result, shown under the name rather than replacing it. */
  summary: string | null
  /** A `https://github.com` details/logs URL, or null when GitHub gave nothing safe. */
  detailsUrl: string | null
  startedAt: string | null
  completedAt: string | null
  /** The Actions workflow run backing this check, when one does. */
  workflowRunId: number | null
  /**
   * True when GitHub lists this check as required but has not reported it yet. It is
   * reported as a real check so an expected-but-silent check is never read as absent.
   */
  expected: boolean
}

export interface PullRequestCheckRollup {
  total: number
  passing: number
  failing: number
  pending: number
  skipped: number
  neutral: number
  unknown: number
  requiredTotal: number
  requiredFailing: number
  requiredPending: number
  /** True when the repository's required-checks data was readable. */
  requirementKnown: boolean
}

/** The compact four-value aggregate the rows already show. */
export type PullRequestChecksSummary = 'passing' | 'failing' | 'pending' | 'none'

const FAILING_STATES: readonly PullRequestCheckState[] = ['failure', 'action-required', 'cancelled']
const PENDING_STATES: readonly PullRequestCheckState[] = [
  'queued',
  'in-progress',
  'waiting',
  'unknown',
]

function upper(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

/**
 * A check run's `status` and `conclusion` are two fields describing one state, and
 * GitHub only fills in `conclusion` once the run is `completed`.
 */
export function classifyCheckRun(status: unknown, conclusion: unknown): PullRequestCheckState {
  const run = upper(status)
  const done = upper(conclusion)
  if (run === 'COMPLETED') {
    switch (done) {
      case 'SUCCESS':
        return 'success'
      case 'FAILURE':
      case 'TIMED_OUT':
      case 'STARTUP_FAILURE':
        return 'failure'
      // A stale run was never current for this head, so it cannot satisfy a merge.
      case 'STALE':
        return 'failure'
      case 'CANCELLED':
        return 'cancelled'
      case 'SKIPPED':
        return 'skipped'
      case 'NEUTRAL':
        return 'neutral'
      case 'ACTION_REQUIRED':
        return 'action-required'
      default:
        return 'unknown'
    }
  }
  switch (run) {
    case 'QUEUED':
    case 'REQUESTED':
    case 'PENDING':
      return 'queued'
    case 'IN_PROGRESS':
      return 'in-progress'
    // GitHub's own wording for a check it is still waiting on.
    case 'WAITING':
      return 'waiting'
    case 'EXPECTED':
      return 'waiting'
    default:
      return 'unknown'
  }
}

/** A legacy commit status carries one `state` instead of a status/conclusion pair. */
export function classifyCommitStatus(state: unknown): PullRequestCheckState {
  switch (upper(state)) {
    case 'SUCCESS':
      return 'success'
    case 'PENDING':
      return 'queued'
    case 'EXPECTED':
      return 'waiting'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    default:
      return 'unknown'
  }
}

/**
 * An Actions workflow run reports the same status/conclusion pair a check run does,
 * so it shares the classifier rather than carrying a second copy of the mapping.
 */
export const classifyWorkflowRun = classifyCheckRun

export function isFailingState(state: PullRequestCheckState): boolean {
  return FAILING_STATES.includes(state)
}

export function isPendingState(state: PullRequestCheckState): boolean {
  return PENDING_STATES.includes(state)
}

/**
 * Aggregate the reported checks. A single failing or cancelled check fails the whole
 * rollup even when a required check is still running, matching what GitHub shows on
 * the pull request itself.
 */
export function deriveCheckRollup(
  checks: readonly PullRequestCheckDetail[],
): PullRequestCheckRollup {
  const rollup: PullRequestCheckRollup = {
    total: checks.length,
    passing: 0,
    failing: 0,
    pending: 0,
    skipped: 0,
    neutral: 0,
    unknown: 0,
    requiredTotal: 0,
    requiredFailing: 0,
    requiredPending: 0,
    requirementKnown: true,
  }
  for (const check of checks) {
    if (isFailingState(check.state)) rollup.failing += 1
    else if (isPendingState(check.state)) rollup.pending += 1
    else if (check.state === 'skipped') rollup.skipped += 1
    else if (check.state === 'neutral') rollup.neutral += 1
    else if (check.state === 'success') rollup.passing += 1
    else rollup.unknown += 1
    if (check.requirement === 'required') {
      rollup.requiredTotal += 1
      if (isFailingState(check.state)) rollup.requiredFailing += 1
      else if (isPendingState(check.state)) rollup.requiredPending += 1
    } else if (check.requirement === 'unknown') {
      rollup.requirementKnown = false
    }
  }
  return rollup
}

/**
 * The compact aggregate the list rows and branch badges already show. It is derived
 * from the detailed checks, so a badge can never claim more than the drill-down does.
 */
export function summariseChecks(
  checks: readonly PullRequestCheckDetail[],
): PullRequestChecksSummary {
  if (checks.length === 0) return 'none'
  if (checks.some((check) => isFailingState(check.state))) return 'failing'
  if (checks.some((check) => isPendingState(check.state))) return 'pending'
  return 'passing'
}

/**
 * GitHub's own `statusCheckRollup.state` for a commit, used by the list read that
 * cannot afford a detail read per row. An aggregate this build does not recognise
 * stays pending: unreported is never read as passing, and never as "no checks".
 */
export function summariseCheckRollupState(state: unknown): PullRequestChecksSummary {
  switch (upper(state)) {
    case 'SUCCESS':
      return 'passing'
    case 'FAILURE':
    case 'ERROR':
      return 'failing'
    default:
      return 'pending'
  }
}

/**
 * How current a report is. `live` and `not-modified` were both confirmed by GitHub in
 * this call; `cached` was not asked about at all, and `stale` is a last-known report
 * kept because the read that should have replaced it failed.
 */
export type PullRequestChecksFreshness = 'live' | 'not-modified' | 'cached' | 'stale'

/** What GitHub's Actions permission endpoint reported, and what it therefore allows. */
export interface PullRequestChecksPermissions {
  actionsEnabled: boolean
  canRerun: boolean
  reason: string
}

export interface PullRequestChecksRateLimit {
  remaining: number | null
  reset: string | null
}

export interface PullRequestChecksReport {
  number: number
  headSha: string | null
  base: string | null
  available: boolean
  message: string
  checks: PullRequestCheckDetail[]
  rollup: PullRequestCheckRollup
  summary: PullRequestChecksSummary
  /** When GitHub last returned this content. */
  fetchedAt: string | null
  /** When GitHub last confirmed the content was still current. */
  checkedAt: string | null
  freshness: PullRequestChecksFreshness
  /** Why a remembered report is being shown, or null when GitHub just confirmed it. */
  staleReason: string | null
  rateLimit: PullRequestChecksRateLimit
  /** The earliest time the next read may be attempted. */
  nextAttemptAt: string | null
  permissions: PullRequestChecksPermissions
}

const GITHUB_HOST = 'github.com'

/**
 * Only a plain `https://github.com` URL is ever handed to `external:open`. GitHub
 * check details come from third-party apps, so an unvetted URL is a link the app
 * must not be willing to open.
 */
export function safeGitHubUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== GITHUB_HOST) return null
  if (url.port || url.username || url.password) return null
  return url.href
}
