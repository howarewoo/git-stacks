import type { GitAction, PendingRemoteMutation, RemoteMutationKind } from '../shared/types'
import { commandDetail } from './git-core'
import { GitHubTransportError, type GitHubErrorKind } from './github-transport'

/**
 * The kinds whose failure leaves GitHub's answer unknown: the request may have
 * been applied, or may never have reached it. Everything else either changed
 * only local Git or failed in a way GitHub itself reported.
 */
const UNKNOWN_OUTCOME_KINDS: Partial<Record<GitHubErrorKind, true>> = {
  network: true,
  timeout: true,
  'rate-limited': true,
  'secondary-rate-limit': true,
}

const CONNECTIVITY =
  /(?:fetch failed|network|connect|timeout|timed out|socket|dns|api\.github|econnrefused|enotfound|eai_again|getaddrinfo)/iu

/** The human label for each kind, phrased as the work the person asked for. */
const KIND_LABEL: Record<RemoteMutationKind, string> = {
  merge: 'Merge',
  'review-submit': 'Review submission',
  'force-push': 'Force push',
  delete: 'Delete',
  retarget: 'Pull request update',
  'create-pr': 'Pull request creation',
  publish: 'Submit stack',
}

/**
 * The high-impact remote mutation an action performs, or null when the action
 * changes only local Git, is read-only, or is a reversible pull-request edit.
 */
export function classifyRemoteMutation(action: GitAction): RemoteMutationKind | null {
  switch (action.type) {
    case 'merge':
      return 'merge'
    case 'forcePush':
      return 'force-push'
    case 'deleteRemoteBranch':
    case 'deleteRemoteBranches':
    case 'unstackNativeStack':
      return 'delete'
    case 'createPr':
      return 'create-pr'
    case 'updatePr':
      return 'retarget'
    case 'submitStack':
    case 'submitStackRetry':
      return 'publish'
    case 'executeStack':
      // Executing a stack is a publish first and merges only when it asks for
      // them; a lost answer has to be resolved by the person either way.
      return 'publish'
    default:
      return null
  }
}

export function remoteMutationLabel(kind: RemoteMutationKind, action: GitAction): string {
  const base = KIND_LABEL[kind]
  const detail =
    'ref' in action && typeof action.ref === 'string'
      ? action.ref.replace(/^refs\/heads\//u, '')
      : 'number' in action && typeof action.number === 'number'
        ? `#${action.number}`
        : ''
  return detail ? `${base} ${detail}` : base
}

/**
 * Why a GitHub mutation's outcome is unknown, or null when the failure proves
 * the request did not apply. A rejected, unauthenticated, or missing-resource
 * response never reached the mutation; a dropped connection may have.
 */
export function unknownRemoteOutcome(error: unknown): string | null {
  if (error instanceof GitHubTransportError) {
    if (UNKNOWN_OUTCOME_KINDS[error.kind]) return error.detail
    return null
  }
  const detail = commandDetail(error)
  return CONNECTIVITY.test(detail) ? detail : null
}

/**
 * The record of high-impact mutations that did not complete. Reconnecting
 * never drains it: resuming one of these would re-send a merge or a forced push
 * whose effect nobody has seen, so each entry waits for an explicit action.
 */
export class RemoteMutationLedger {
  private entries: PendingRemoteMutation[] = []
  private sequence = 0

  record(input: {
    kind: RemoteMutationKind
    label: string
    reason: string
    at?: Date
  }): PendingRemoteMutation {
    const failedAt = input.at ?? new Date()
    this.sequence += 1
    const entry: PendingRemoteMutation = {
      id: `${input.kind}-${failedAt.getTime()}-${this.sequence}`,
      kind: input.kind,
      label: input.label,
      reason: input.reason,
      failedAt: failedAt.toISOString(),
    }
    this.entries = [entry, ...this.entries].slice(0, 20)
    return entry
  }

  /** Records the action when it is high-impact and its outcome is unknown. */
  recordFailure(action: GitAction, error: unknown, at?: Date): PendingRemoteMutation | null {
    const kind = classifyRemoteMutation(action)
    const reason = unknownRemoteOutcome(error)
    if (!kind || !reason) return null
    return this.record({
      kind,
      label: remoteMutationLabel(kind, action),
      reason,
      ...(at ? { at } : {}),
    })
  }

  pending(): PendingRemoteMutation[] {
    return [...this.entries]
  }

  dismiss(id: string): boolean {
    const next = this.entries.filter((entry) => entry.id !== id)
    if (next.length === this.entries.length) return false
    this.entries = next
    return true
  }

  clear(): void {
    this.entries = []
  }
}
