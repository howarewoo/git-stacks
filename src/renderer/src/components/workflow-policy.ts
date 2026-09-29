/**
 * Pure policy for workflow dialogs: the shared visual state model, the reasons a
 * reviewed mutation may not be dispatched, and the close/focus rules that keep
 * entered work and active Git operations safe.
 *
 * Nothing here talks to React, IPC, or Git. The dialogs and the persistent
 * operation banner derive their state from these functions so that the safety
 * rules stay testable and identical everywhere.
 */

export type WorkflowKind =
  | 'rename'
  | 'parent'
  | 'upstream'
  | 'deleteRemote'
  | 'pull'
  | 'merge'
  | 'stash'
  | 'forcePush'
  | 'commitAction'
  | 'stack'
  | 'surgery'
  | 'pr'
  | 'confirm'

/** The three compositions every dialog in the app is built from. */
export type WorkflowComposition = 'form' | 'reviewed' | 'destructive'

/**
 * The visual state model. Each phase is derived from data the backend actually
 * supplied; no phase is synthesized and no phase carries a fabricated
 * completion percentage.
 */
export type WorkflowPhase =
  'loading' | 'submitting' | 'failed' | 'stale' | 'succeeded' | 'partial' | 'blocked' | 'ready'

export interface PhasePresentation {
  label: string
  tone: 'info' | 'success' | 'warning' | 'error' | 'neutral'
  /** Errors interrupt; everything else is announced politely. */
  live: 'assertive' | 'polite' | 'off'
}

export const PHASE_PRESENTATION: Record<WorkflowPhase, PhasePresentation> = {
  loading: { label: 'Reading current state', tone: 'info', live: 'polite' },
  submitting: { label: 'Submitting', tone: 'info', live: 'polite' },
  failed: { label: 'Not applied', tone: 'error', live: 'assertive' },
  stale: { label: 'Preview out of date', tone: 'warning', live: 'assertive' },
  succeeded: { label: 'Completed', tone: 'success', live: 'polite' },
  partial: { label: 'Partially completed', tone: 'warning', live: 'polite' },
  blocked: { label: 'Blocked', tone: 'warning', live: 'polite' },
  ready: { label: 'Ready to review', tone: 'neutral', live: 'off' },
}

export interface PhaseInput {
  loading: boolean
  busy: boolean
  failed: boolean
  stale: boolean
  finished: boolean
  partial: boolean
  blocked: boolean
}

/**
 * Phase precedence keeps the most urgent, most actionable state visible: an
 * in-flight read or submit outranks its own outcome, a failure outranks a stale
 * preview, and a terminal success outranks a leftover blocker.
 */
export function workflowPhase(input: PhaseInput): WorkflowPhase {
  if (input.loading) return 'loading'
  if (input.busy) return 'submitting'
  if (input.failed) return 'failed'
  if (input.stale) return 'stale'
  if (input.finished) return 'succeeded'
  if (input.partial) return 'partial'
  if (input.blocked) return 'blocked'
  return 'ready'
}

export type WorkflowBlockerCode =
  | 'busy'
  | 'loading'
  | 'unfinished'
  | 'repository-changed'
  | 'preview-missing'
  | 'preview-blocked'
  | 'preview-stale'
  | 'confirmation-incomplete'
  | 'name-required'
  | 'pull-request-unavailable'
  | 'pull-request-title-required'
  | 'mainline-required'
  | 'merge-method-required'
  | 'publish-title-required'
  | 'remote-tip-unavailable'
  | 'completed'
  | 'lease-approval-required'

export interface WorkflowBlocker {
  code: WorkflowBlockerCode
  /** The next safe step, phrased for a person. Never a bare "invalid". */
  message: string
}

export const WORKFLOW_BLOCKER_MESSAGES: Record<WorkflowBlockerCode, string> = {
  busy: 'Another Git action is running. Wait for it to finish before continuing here.',
  loading: 'Reading the current repository state. Try again once the preview is ready.',
  unfinished: 'This dialog is still reading current state. Wait for it to finish.',
  'repository-changed':
    'The open repository changed. Close this dialog and reopen the operation against the current repository.',
  'preview-missing':
    'No preview is loaded. Reload the preview to read the current state before this runs.',
  'preview-blocked': 'The preview reports blockers. Resolve each one, then reload the preview.',
  'preview-stale':
    'This preview was already rejected. Reload the preview to review the current state before retrying.',
  'confirmation-incomplete':
    'Type the exact name shown above to enable this action. Nothing runs until it matches.',
  'name-required': 'Choose or enter a value before continuing.',
  'pull-request-unavailable':
    'This pull request is no longer editable. Close the dialog and review it on GitHub.',
  'pull-request-title-required': 'Enter a pull request title before saving.',
  'mainline-required':
    'Choose which parent to keep for this merge commit. Revert needs that choice.',
  'merge-method-required': 'Choose a merge method before merging this pull request.',
  'publish-title-required':
    'Every branch without an existing pull request needs a title before publishing.',
  'remote-tip-unavailable':
    'The remote tip is unknown, so deletion cannot be verified. Fetch and try again.',
  'lease-approval-required':
    'Approve replacing published history with the exact remote tips listed below. Nothing is force pushed without that approval.',
  completed: 'This step already completed. Review the result, then choose the next operation.',
}

export interface WorkflowGuardInput {
  kind: WorkflowKind
  busy: boolean
  loading: boolean
  loaded: boolean
  finished: boolean
  capturedPath: string
  currentPath: string
  /** Preview identity currently on screen, or null when nothing is loaded. */
  previewToken: string | null
  /** Preview identities already rejected by a failed or expired execution. */
  rejectedTokens: readonly string[]
  previewBlockers: readonly string[]
  /** Branch name the typed confirmation must equal, or null when none applies. */
  confirmationTarget: string | null
  confirmation: string
  /** True when a required remote OID is missing (remote deletion, lease push). */
  expectedOidMissing: boolean
  requiresName: boolean
  name: string
  requiresMainline: boolean
  mainline: string
  requiresMergeMethod: boolean
  mergeMethod: string
  /** Branches that need a PR title before a publish can run. */
  untitledBranches: readonly string[]
  /** True when a reviewed stack sync would replace published remote history. */
  requiresLeaseApproval: boolean
  /** True when a stack publication may replace remote history. */
  allowForce: boolean
  pullRequestMissing: boolean
  pullRequestMerged: boolean
  pullRequestTitle: string
}

const nameKinds: readonly WorkflowKind[] = ['rename', 'parent', 'merge']

/**
 * Kinds whose action replaces remote history and therefore always require the
 * exact branch name to be typed, whatever other boxes are ticked.
 */
function needsTypedConfirmation(input: WorkflowGuardInput): boolean {
  return (
    input.kind === 'forcePush' ||
    input.kind === 'deleteRemote' ||
    (input.kind === 'stack' && input.allowForce)
  )
}

/**
 * The single reason a reviewed mutation may not be dispatched, or `null` when it
 * may. Ordered so the first failure a person meets is the one they can act on:
 * the run in flight, the dialog that is still loading, a repository that moved
 * underneath the dialog, then the preview, then the confirmation and inputs.
 */
export function workflowBlocker(input: WorkflowGuardInput): WorkflowBlocker | null {
  const block = (code: WorkflowBlockerCode): WorkflowBlocker => ({
    code,
    message: WORKFLOW_BLOCKER_MESSAGES[code],
  })

  if (input.busy) return block('busy')
  if (input.loading) return block('loading')
  if (!input.loaded) return block('unfinished')
  if (input.finished) return block('completed')
  if (input.capturedPath !== input.currentPath) return block('repository-changed')

  if (input.kind === 'stack') {
    if (!input.previewToken) return block('preview-missing')
    if (input.rejectedTokens.includes(input.previewToken)) return block('preview-stale')
    if (input.previewBlockers.length > 0) return block('preview-blocked')
  }

  if (input.kind === 'forcePush') {
    if (!input.previewToken) return block('preview-missing')
    if (input.expectedOidMissing) return block('remote-tip-unavailable')
    if (input.rejectedTokens.includes(input.previewToken)) return block('preview-stale')
  }

  // Remote deletion has no preview to read: it is guarded by the exact branch
  // name and the remote OID captured when the dialog opened.
  if (input.kind === 'deleteRemote') {
    if (input.expectedOidMissing) return block('remote-tip-unavailable')
  }

  // Replacing remote history always requires typing the branch name, including
  // a forced stack publication that checked "allow force".
  if (needsTypedConfirmation(input)) {
    if (input.confirmationTarget === null || input.confirmation !== input.confirmationTarget)
      return block('confirmation-incomplete')
  }

  if (nameKinds.includes(input.kind) && !input.name.trim()) return block('name-required')

  if (input.kind === 'pr') {
    if (input.previewToken && input.rejectedTokens.includes(input.previewToken))
      return block('preview-stale')
    if (input.pullRequestMissing || input.pullRequestMerged)
      return block('pull-request-unavailable')
    if (!input.pullRequestTitle.trim()) return block('pull-request-title-required')
  }

  if (input.kind === 'commitAction' && input.requiresMainline && !input.mainline)
    return block('mainline-required')

  if (input.kind === 'stack') {
    if (input.requiresMergeMethod && !input.mergeMethod) return block('merge-method-required')
    if (input.untitledBranches.length > 0) return block('publish-title-required')
    if (input.requiresLeaseApproval && !input.allowForce) return block('lease-approval-required')
  }

  return null
}

export type CloseIntent = 'allow' | 'blocked-busy' | 'blocked-unsaved'

export const CLOSE_INTENT_MESSAGES: Record<Exclude<CloseIntent, 'allow'>, string> = {
  'blocked-busy': 'A Git action is still running. Wait for it to finish, then close this dialog.',
  'blocked-unsaved':
    'Escape and backdrop clicks do not discard what you typed. Use Cancel to discard it explicitly.',
}

/**
 * Escape and backdrop clicks must never interrupt an active mutation and never
 * silently discard entered work. Both cases keep the dialog open and explain
 * the way out; only the explicit Cancel control discards.
 */
export function closeIntent(input: { busy: boolean; dirty: boolean }): CloseIntent {
  if (input.busy) return 'blocked-busy'
  if (input.dirty) return 'blocked-unsaved'
  return 'allow'
}

/** Destructive and reviewed operations open on Cancel; ordinary forms open on their first field. */
export function initialFocusTarget(composition: WorkflowComposition): 'cancel' | 'first-field' {
  return composition === 'form' ? 'first-field' : 'cancel'
}

/**
 * Serializes dispatch so repeated activation — a double Enter, a click that
 * lands before React re-renders — cannot send a second Git action. Returns
 * whether this caller actually owned the dispatch.
 */
export function createDispatchLock(): <T>(
  dispatch: () => Promise<T>,
) => Promise<{ dispatched: boolean; value?: T }> {
  let inFlight: Promise<unknown> | null = null
  return async <T>(dispatch: () => Promise<T>) => {
    if (inFlight) return { dispatched: false }
    const owned = (async () => dispatch())()
    inFlight = owned
    try {
      return { dispatched: true, value: await owned }
    } finally {
      if (inFlight === owned) inFlight = null
    }
  }
}

export interface PartialProgress {
  completed: number
  remaining: number
  summary: string
  message: string
}

/**
 * Progress copy derived from a real snapshot. Indeterminate work is described
 * rather than counted: an operation with no completed steps reports no totals
 * instead of an invented percentage.
 */
export function partialProgress(progress: {
  completed: readonly string[]
  remaining: readonly string[]
  message: string
}): PartialProgress {
  const completed = progress.completed.length
  const remaining = progress.remaining.length
  return {
    completed,
    remaining,
    summary:
      completed > 0
        ? `${completed} of ${completed + remaining} steps completed`
        : `No steps completed yet · ${remaining} remaining`,
    message: progress.message,
  }
}
