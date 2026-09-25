import type { PullRequest } from '../../../shared/types'

export type StatusBadgeVariant =
  'secondary' | 'outline' | 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'merged'

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
