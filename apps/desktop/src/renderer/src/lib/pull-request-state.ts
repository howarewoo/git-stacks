import type { PullRequest } from '@git-stacks/shared/types'
import type {
  PullRequestCheckRequirement,
  PullRequestCheckSource,
  PullRequestCheckState,
  PullRequestChecksReport,
} from '@git-stacks/shared/pull-request-checks'

export type StatusBadgeVariant =
  | 'secondary'
  | 'outline'
  | 'accent'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'merged'

/** Checks are their own state: pending, failing, passing, or genuinely none. */
export function checksVariant(checks: PullRequest['checks']): StatusBadgeVariant {
  if (checks === 'passing') return 'success'
  if (checks === 'failing') return 'danger'
  if (checks === 'pending') return 'warning'
  return 'secondary'
}

export function checkLabel(checks: PullRequest['checks']): string {
  if (checks === 'passing') return 'checks passing'
  if (checks === 'failing') return 'checks failing'
  if (checks === 'pending') return 'checks pending'
  return 'no checks'
}

const CHECK_STATE_LABEL: Record<PullRequestCheckState, string> = {
  queued: 'queued',
  'in-progress': 'running',
  waiting: 'waiting',
  success: 'passed',
  failure: 'failed',
  'action-required': 'action required',
  cancelled: 'cancelled',
  skipped: 'skipped',
  neutral: 'neutral',
  unknown: 'unknown',
}

const CHECK_STATE_VARIANT: Record<PullRequestCheckState, StatusBadgeVariant> = {
  queued: 'warning',
  'in-progress': 'warning',
  waiting: 'warning',
  success: 'success',
  failure: 'danger',
  'action-required': 'danger',
  cancelled: 'danger',
  skipped: 'secondary',
  neutral: 'secondary',
  unknown: 'secondary',
}

const CHECK_SOURCE_LABEL: Record<PullRequestCheckSource, string> = {
  'check-run': 'Check run',
  'commit-status': 'Commit status',
  'workflow-run': 'Actions run',
  expected: 'Not reported yet',
}

const CHECK_REQUIREMENT_LABEL: Record<PullRequestCheckRequirement, string> = {
  required: 'required',
  informational: 'informational',
  unknown: 'requirement unknown',
}

/**
 * One reported check keeps GitHub's own state as a text label. `unknown` and a
 * neutral/unknown requirement stay visibly unproven rather than reading as a pass.
 */
export function checkStateLabel(state: PullRequestCheckState): string {
  return CHECK_STATE_LABEL[state]
}

export function checkStateVariant(state: PullRequestCheckState): StatusBadgeVariant {
  return CHECK_STATE_VARIANT[state]
}

export function checkSourceLabel(source: PullRequestCheckSource): string {
  return CHECK_SOURCE_LABEL[source]
}

export function checkRequirementLabel(requirement: PullRequestCheckRequirement): string {
  return CHECK_REQUIREMENT_LABEL[requirement]
}

/** Required, informational, and unproven checks are three different claims. */
export function checkRequirementVariant(
  requirement: PullRequestCheckRequirement,
): StatusBadgeVariant {
  if (requirement === 'required') return 'accent'
  if (requirement === 'unknown') return 'outline'
  return 'secondary'
}

function checkedTime(value: string | null): string {
  if (!value) return 'an unknown time'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'an unknown time' : parsed.toLocaleString()
}

/**
 * How the report should present its own currency. Only a read GitHub confirmed in
 * this call is presented as current; a remembered report always says so, because a
 * cached failure is not a passing check.
 */
export function checksFreshnessNote(report: PullRequestChecksReport): {
  tone: 'info' | 'warning'
  title: string
  detail: string
} {
  if (report.freshness === 'live') {
    return {
      tone: 'info',
      title: 'Checks read from GitHub',
      detail: `Confirmed at ${checkedTime(report.checkedAt)}.`,
    }
  }
  if (report.freshness === 'not-modified') {
    return {
      tone: 'info',
      title: 'GitHub confirmed these checks are unchanged',
      detail: `Confirmed at ${checkedTime(report.checkedAt)}; last read at ${checkedTime(report.fetchedAt)}.`,
    }
  }
  if (report.freshness === 'cached') {
    return {
      tone: 'warning',
      title: 'Showing the last checks Git Stacks read',
      detail: `Read at ${checkedTime(report.fetchedAt)}; GitHub has not been asked again for this pull request yet.`,
    }
  }
  return {
    tone: 'warning',
    title: 'Showing stale checks',
    detail: `${report.staleReason ?? 'The last refresh failed.'} Last good read at ${checkedTime(report.fetchedAt)}.`,
  }
}

export function checksWatchDisabledReason(report: PullRequestChecksReport): string | null {
  if (!report.available) return 'GitHub checks are unavailable, so there is nothing to watch.'
  if (report.nextAttemptAt) {
    return `GitHub asked Git Stacks to wait until ${checkedTime(report.nextAttemptAt)} before reading again.`
  }
  return null
}

/** Lifecycle is independent of checks and review; a draft is never presented as open. */
export function lifecycleVariant(pr: PullRequest): StatusBadgeVariant {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'secondary'
  return pr.draft ? 'outline' : 'info'
}

export function lifecycleLabel(pr: PullRequest): string {
  if (pr.draft) return 'draft'
  return pr.state.toLowerCase()
}

/** An unreported review decision stays unknown; it is never read as approval. */
export function reviewVariant(pr: PullRequest): StatusBadgeVariant {
  const decision = pr.reviewDecision?.toUpperCase()
  if (decision === 'APPROVED') return 'success'
  if (decision === 'CHANGES_REQUESTED') return 'danger'
  if (decision === 'REVIEW_REQUIRED') return 'warning'
  return 'secondary'
}

export function reviewLabel(pr: PullRequest): string {
  const decision = pr.reviewDecision?.toUpperCase()
  if (decision === 'APPROVED') return 'review approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes requested'
  if (decision === 'REVIEW_REQUIRED') return 'review required'
  return 'no review decision'
}
