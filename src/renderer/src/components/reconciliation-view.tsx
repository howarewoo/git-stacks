import * as React from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useForm, useSelector } from '@tanstack/react-form'
import {
  AlertTriangle,
  GitPullRequest,
  History,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from 'lucide-react'
import type {
  ReconciledStack,
  ReconciliationPreview,
  ReconciliationRepair,
  ReconciliationRepairKind,
  ReconciliationState,
  RepositorySnapshot,
} from '../../../shared/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import {
  BlockerList,
  OperationContext,
  TypedConfirmation,
  WarningNote,
  WorkflowActions,
  WorkflowFrame,
  type ContextFact,
} from './workflow-composition'
import { RunAction, workflowError } from './workflow-dialog'

const stateLabels: Record<ReconciliationState, string> = {
  'local-only': 'Local only',
  'remote-native': 'Remote-native order',
  matching: 'Matching',
  stale: 'Stale',
  diverged: 'Diverged',
  reordered: 'Reordered',
  'missing-branch': 'Missing branch',
  retargeted: 'Retargeted',
  merged: 'Merged member',
  'externally-unstacked': 'Externally unstacked',
  ambiguous: 'Ambiguous',
}

const stateVariants: Record<
  ReconciliationState,
  'secondary' | 'outline' | 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'merged'
> = {
  'local-only': 'secondary',
  'remote-native': 'info',
  matching: 'success',
  stale: 'warning',
  diverged: 'danger',
  reordered: 'warning',
  'missing-branch': 'danger',
  retargeted: 'warning',
  merged: 'merged',
  'externally-unstacked': 'warning',
  ambiguous: 'danger',
}

const repairLabels: Record<ReconciliationRepairKind, string> = {
  'adopt-remote-order': 'Adopt submitted order',
  'clear-stale-hint': 'Clear stale local hint',
  'adopt-remote-tip': 'Move branch to submitted head',
  'restore-missing-branch': 'Restore deleted local branch',
  'retarget-pull-request': 'Retarget pull request',
}

function stateBadge(state: ReconciliationState) {
  return (
    <Badge variant={stateVariants[state]}>
      {state === 'ambiguous' ? <AlertTriangle className="size-3" /> : null}
      {state === 'matching' ? <RefreshCw className="size-3" /> : null}
      {stateLabels[state]}
    </Badge>
  )
}

function RepairRow({
  repair,
  checked,
  disabled,
  onChange,
}: {
  repair: ReconciliationRepair
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <li className="gs-reconciliation-repair grid gap-2 rounded-[var(--gs-semantic-radius-item)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-content)] p-3">
      <Checkbox
        id={`repair-${repair.kind}-${repair.branch ?? repair.pullRequest ?? 'stack'}`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        label={
          <span className="grid gap-1">
            <span className="font-medium text-[length:var(--gs-semantic-type-label-size)] text-[var(--gs-semantic-text-primary)]">
              {repairLabels[repair.kind]}
            </span>
            <span className="text-xs text-[var(--gs-semantic-text-secondary)]">
              {repair.summary}
            </span>
          </span>
        }
      />
      <p className="m-0 text-[length:var(--gs-semantic-type-body-size)] leading-[1.5] text-[var(--gs-semantic-text-secondary)]">
        {repair.detail}
      </p>
      {repair.requiresConfirmation ? (
        <p className="m-0 text-xs text-[var(--gs-semantic-text-secondary)]">
          Rewrites a branch tip or a pull-request base.
        </p>
      ) : null}
      {repair.evidence ? (
        <p className="m-0 font-mono text-xs text-[var(--gs-semantic-text-secondary)]">
          {repair.evidence.previousParent ?? 'no recorded parent'} @{' '}
          {repair.evidence.previousParentTip?.slice(0, 10) ?? 'no recorded boundary'}
        </p>
      ) : null}
    </li>
  )
}

function ReconciliationDialog({
  snapshotKey,
  preview,
  previewError,
  loading,
  busy,
  actionError,
  onCancel,
  onReload,
  onRun,
}: {
  snapshotKey: string
  preview: ReconciliationPreview | null
  previewError: string | null
  loading: boolean
  busy: boolean
  actionError: string | null
  onCancel: () => void
  onReload: () => void
  onRun: (ids: string[], confirmRewrites: boolean) => Promise<void>
}) {
  const form = useForm({
    defaultValues: { selected: preview?.repairs.map((repair) => repair.id) ?? [], typed: '' },
    validators: {
      onSubmit: ({ value }) => {
        if (!value.selected.length) return 'Select at least one repair.'
        const rewrites = preview?.repairs.some(
          (repair) => repair.requiresConfirmation && value.selected.includes(repair.id),
        )
        return rewrites && value.typed.trim() !== (preview?.stackKey ?? snapshotKey)
          ? 'Type the exact stack name to confirm rewrites.'
          : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (busy || loading || !preview || !preview.repairs.length) return
      const rewrites = preview.repairs.some(
        (repair) => repair.requiresConfirmation && value.selected.includes(repair.id),
      )
      await onRun(value.selected, rewrites)
    },
  })
  const { selected, typed } = useSelector(form.store, (state) => state.values)
  const submitting = useSelector(form.store, (state) => state.isSubmitting)
  React.useEffect(() => {
    form.reset({ selected: preview?.repairs.map((repair) => repair.id) ?? [], typed: '' })
  }, [form, preview])

  const rewrites = (preview?.repairs ?? []).filter(
    (repair) => repair.requiresConfirmation && selected.includes(repair.id),
  )
  const target = preview?.stackKey ?? snapshotKey
  const facts: ContextFact[] = preview
    ? [
        { label: 'Stack', value: preview.stackKey },
        { label: 'State', value: stateLabels[preview.state] },
        { label: 'Submitted base', value: preview.base },
        {
          label: 'Submitted order',
          value: preview.submittedOrder.length
            ? preview.submittedOrder.join(' → ')
            : 'No submitted members',
          code: true,
        },
        { label: 'Captured', value: preview.capturedAt, code: true },
      ]
    : []
  const confirmReady = rewrites.length === 0 || typed.trim() === target

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && !submitting && onCancel()}>
      <DialogContent className="gs-reconciliation-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <WorkflowFrame composition="destructive">
            <DialogHeader>
              <DialogTitle>Reconcile submitted stack</DialogTitle>
              <DialogDescription>
                GitHub stays authoritative for submitted order. Nothing is written until you run a
                selected repair, and every repair re-checks the captured commits and pull requests
                immediately before it runs.
              </DialogDescription>
            </DialogHeader>
            {loading ? (
              <p role="status" className="m-0 text-xs text-[var(--gs-semantic-text-secondary)]">
                Reading the submitted stack and the local graph…
              </p>
            ) : previewError ? (
              <p role="alert" className="m-0 text-xs text-[var(--gs-semantic-feedback-error-text)]">
                {previewError}
              </p>
            ) : preview ? (
              <>
                <OperationContext title={preview.summary} facts={facts} />
                {preview.blockers.length ? <BlockerList items={preview.blockers} /> : null}
                {preview.repairs.length ? (
                  <ol aria-label="Proposed repairs" className="m-0 grid list-none gap-2 p-0">
                    {preview.repairs.map((repair) => (
                      <RepairRow
                        key={repair.id}
                        repair={repair}
                        checked={selected.includes(repair.id)}
                        disabled={busy || submitting}
                        onChange={(checked) =>
                          form.setFieldValue('selected', (current) =>
                            checked
                              ? [...new Set([...current, repair.id])]
                              : current.filter((id) => id !== repair.id),
                          )
                        }
                      />
                    ))}
                  </ol>
                ) : (
                  <p className="m-0 text-xs text-[var(--gs-semantic-text-secondary)]">
                    {preview.state === 'ambiguous'
                      ? 'Resolve the reported ambiguity on GitHub or in Git, then review again.'
                      : 'Nothing to repair for this stack.'}
                  </p>
                )}
                {rewrites.length ? (
                  <>
                    <WarningNote>
                      <span className="inline-flex items-center gap-2">
                        <ShieldAlert className="size-3.5" />
                        {rewrites.length} selected repair
                        {rewrites.length === 1 ? ' rewrites' : 's rewrite'} a branch tip or a
                        pull-request base. The previous commit is kept at
                        refs/git-stacks/reconciliation.
                      </span>
                    </WarningNote>
                    <TypedConfirmation
                      id="reconciliation-confirm"
                      value={typed}
                      target={target}
                      disabled={busy || submitting}
                      onChange={(value) => form.setFieldValue('typed', value)}
                      label={`Type ${target} to enable branch and pull-request rewrites`}
                    />
                  </>
                ) : null}
              </>
            ) : null}
            {actionError ? (
              <p role="alert" className="m-0 text-xs text-[var(--gs-semantic-feedback-error-text)]">
                {actionError}
              </p>
            ) : null}
            <WorkflowActions>
              <Button variant="secondary" onClick={onCancel} disabled={busy || submitting}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                onClick={onReload}
                disabled={busy || submitting || loading}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {loading ? 'Re-reading…' : 'Re-read'}
              </Button>
              <Button
                variant="accent"
                type="submit"
                loading={busy || submitting}
                disabled={
                  busy ||
                  submitting ||
                  loading ||
                  !preview ||
                  !preview.repairs.length ||
                  !selected.length ||
                  !confirmReady
                }
              >
                <Wrench className="size-3.5" aria-hidden="true" />
                {busy || submitting
                  ? 'Running repairs…'
                  : `Run ${selected.length || ''} repair${selected.length === 1 ? '' : 's'}`}
              </Button>
            </WorkflowActions>
          </WorkflowFrame>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function StackRow({
  stack,
  blocked,
  onReview,
}: {
  stack: ReconciledStack
  blocked: boolean
  onReview: () => void
}) {
  const openExternal = useMutation({
    mutationFn: (url: string) => window.desktop.openExternal(url),
  })
  return (
    <li className="gs-reconciliation-stack grid gap-2 rounded-[var(--gs-semantic-radius-panel)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-content)] px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[length:var(--gs-semantic-type-label-size)] text-[var(--gs-semantic-text-primary)]">
          {stack.stackNumber === null ? 'Local stack' : `GitHub stack #${stack.stackNumber}`}
        </strong>
        {stateBadge(stack.state)}
        <span className="font-mono text-xs text-[var(--gs-semantic-text-secondary)]">
          {stack.key}
        </span>
      </div>
      <p className="m-0 text-xs text-[var(--gs-semantic-text-secondary)]">{stack.summary}</p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {stack.members.map((member) => (
          <li
            key={member.branch}
            className="flex flex-wrap items-center gap-2 text-[length:var(--gs-semantic-type-metadata-size)] leading-[var(--gs-semantic-type-metadata-line)] text-[var(--gs-semantic-text-secondary)]"
          >
            <GitPullRequest className="size-3" />
            <span className="font-mono">{member.branch}</span>
            {member.position ? <span>position {member.position}</span> : null}
            {member.pullRequest ? <span>#{member.pullRequest}</span> : null}
            {member.state === 'matching' ? null : stateBadge(member.state)}
            <span>{member.detail}</span>
          </li>
        ))}
      </ul>
      {stack.blockers.length ? <BlockerList title="Blocked" items={stack.blockers} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={stack.repairs.length ? 'accent' : 'secondary'}
          disabled={blocked}
          tooltip={
            stack.state === 'ambiguous'
              ? 'Ambiguous ancestry and GitHub state must be resolved before Git Stacks will repair this stack.'
              : stack.repairs.length
                ? 'Preview the exact writes, then run the selected repairs.'
                : 'No repair is available for this state; restack or resolve it on GitHub.'
          }
          onClick={onReview}
        >
          <Wrench className="size-3.5" />
          Review repairs…
        </Button>
        {stack.stackUrl ? (
          <Button
            size="sm"
            variant="ghost"
            tooltip="Open this stack on GitHub"
            onClick={() => openExternal.mutate(stack.stackUrl!)}
          >
            Open on GitHub
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The Stacks workspace's reconciliation surface. It only reports what GitHub's
 * submitted membership says about the local graph; every write happens through
 * an explicit, previewed repair.
 */
export function ReconciliationPanel({
  snapshot,
  authority,
  busy,
  runAction,
  actionError,
  onClearActionError,
}: {
  snapshot: RepositorySnapshot
  authority: string
  busy: boolean
  runAction: RunAction
  actionError: string | null
  onClearActionError: () => void
}) {
  const report = snapshot.reconciliation
  const [openKey, setOpenKey] = React.useState<string | null>(null)
  const [revision, setRevision] = React.useState(0)
  const [fallbackError, setFallbackError] = React.useState<string | null>(null)
  const request = React.useRef(0)
  const previewQuery = useQuery({
    queryKey: ['repository-reconciliation-preview', snapshot.path, authority, openKey, revision],
    enabled: Boolean(report && openKey),
    queryFn: async ({ signal }) => {
      if (!window.desktop?.reconciliationPreview) {
        throw new Error('This build cannot read reconciliation previews.')
      }
      const result = await window.desktop.reconciliationPreview(openKey!)
      signal.throwIfAborted()
      return result
    },
  })
  const preview = report && openKey ? (previewQuery.data ?? null) : null
  const previewError = previewQuery.error ? workflowError(previewQuery.error) : null
  const loading = previewQuery.isFetching
  React.useEffect(() => {
    request.current++
    return () => {
      request.current++
    }
  }, [snapshot.path, authority, openKey, revision])
  React.useEffect(() => {
    if (report) return
    // A retired credential takes the preview as well as the report. Invalidate
    // its outstanding read before a new account can repopulate reconciliation.
    request.current++
    setOpenKey(null)
    setFallbackError(null)
  }, [report])

  const load = () => {
    request.current++
    setRevision((value) => value + 1)
    setFallbackError(null)
    onClearActionError()
  }

  const review = (stackKey: string) => {
    setOpenKey(stackKey)
    load()
  }

  const close = () => {
    request.current++
    setOpenKey(null)
    setFallbackError(null)
  }

  const run = async (ids: string[], confirmRewrites: boolean) => {
    if (!preview) return
    const generation = request.current
    setFallbackError(null)
    const succeeded = await runAction(
      { type: 'reconcileRepair', token: preview.token, ids, confirmRewrites },
      'Reconcile stack',
    )
    if (generation !== request.current) return
    if (succeeded) close()
    else setFallbackError('The repair was rejected. Re-read the preview before running it again.')
  }

  if (!report) return null
  const blocked = !report.available || busy || !!snapshot.operation || !!snapshot.stackOperation

  return (
    <section className="gs-reconciliation" aria-label="Submitted stack reconciliation" tabIndex={0}>
      <div className="list-toolbar">
        <div className="list-title-group">
          <h2 className="m-0 flex items-center gap-2 text-[length:var(--gs-semantic-type-heading-size)] font-semibold leading-[var(--gs-semantic-type-heading-line)] text-[var(--gs-semantic-text-primary)]">
            <History className="size-4" />
            Reconciliation
          </h2>
          <span className="list-subtitle">{report.message}</span>
        </div>
      </div>
      {!report.available ? (
        <p className="workflow-note">{report.message} Local restacking remains available.</p>
      ) : null}
      {report.evidence ? (
        <p className="workflow-note">
          Last repair {report.evidence.stackKey} ({stateLabels[report.evidence.state]}) recorded{' '}
          {report.evidence.applied.length} change
          {report.evidence.applied.length === 1 ? '' : 's'} and {report.evidence.evidence.length}{' '}
          recovery entr
          {report.evidence.evidence.length === 1 ? 'y' : 'ies'} in git-stacks-reconciled.json.
        </p>
      ) : null}
      {report.stacks.length ? (
        <ul className="m-0 grid list-none gap-2 p-0">
          {report.stacks.map((stack) => (
            <StackRow
              key={stack.key}
              stack={stack}
              blocked={blocked}
              onReview={() => review(stack.key)}
            />
          ))}
        </ul>
      ) : report.available ? (
        <p className="workflow-note">No local or submitted stack relationships were found.</p>
      ) : null}
      {openKey ? (
        <ReconciliationDialog
          snapshotKey={openKey}
          preview={preview}
          previewError={previewError}
          loading={loading}
          busy={busy}
          actionError={actionError ?? fallbackError}
          onCancel={close}
          onReload={load}
          onRun={run}
        />
      ) : null}
    </section>
  )
}
