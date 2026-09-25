import type { PullRequest } from '../../../shared/types'

export type StatusBadgeVariant = 'success' | 'danger' | 'warning' | 'secondary' | 'info' | 'merged'

/**
 * Checks and lifecycle are independent roles. `none` is an explicit absent state,
 * never a passing one, so an unreported check run cannot read as green.
 */
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
  return 'no checks reported'
}

export function prStateVariant(pr: PullRequest): StatusBadgeVariant {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'OPEN') return 'info'
  return 'secondary'
}

export function prStateLabel(pr: PullRequest): string {
  if (pr.state === 'OPEN' && pr.draft) return 'draft open'
  return pr.state.toLowerCase()
}

export function reviewLabel(pr: PullRequest): string {
  const decision = pr.reviewDecision?.replaceAll('_', ' ').toLowerCase()
  if (!decision) return 'no review decision reported'
  return `review ${decision}`
}

export function mergeStateLabel(pr: PullRequest): string {
  const state = pr.mergeState?.replaceAll('_', ' ').toLowerCase()
  if (!state) return 'merge state not reported'
  return `merge state ${state}`
}
