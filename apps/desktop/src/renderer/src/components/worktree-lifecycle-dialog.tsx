import * as React from 'react'
import { Button } from '@git-stacks/ui/components/button'
import { Checkbox } from '@git-stacks/ui/components/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@git-stacks/ui/components/dialog'
import { Field } from '@git-stacks/ui/components/field'
import { Input } from '@git-stacks/ui/components/input'
import { Select } from '@git-stacks/ui/components/select'
import type { DesktopAPI } from '@git-stacks/shared/types'
import type { RepositoryInventory } from '@git-stacks/shared/worktree-inventory'
import type { OperationCapture } from '@git-stacks/shared/operation-scope'
import type {
  WorktreeLifecyclePreview,
  WorktreeLifecycleResult,
} from '@git-stacks/shared/worktree-lifecycle'
import { inspectionAPI } from '../lib/inspection-api'
import { sameOperationScope } from '@git-stacks/shared/operation-scope'
import { CapturedOperationContext } from './workflow-composition'
import { useOperationSafety } from '../lib/operation-safety'

/** Exact selected IDs; never infer eligibility from the visible page or clean badges. */
export function WorktreeLifecycleDialog({
  api,
  repository,
  sourceVersion,
  mode,
  sourceRefId,
  worktreeIds,
  onClose,
  onChanged,
}: {
  api: DesktopAPI
  sourceVersion: number
  repository: RepositoryInventory
  mode: 'create' | 'remove'
  sourceRefId?: string
  worktreeIds: string[]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [executionId, setExecutionId] = React.useState('')
  const [refId, setRefId] = React.useState(sourceRefId ?? '')
  const [directory, setDirectory] = React.useState('')
  const [newBranch, setNewBranch] = React.useState('')
  const [coordinated, setCoordinated] = React.useState(false)
  const [confirmation, setConfirmation] = React.useState('')
  const [authority, setAuthority] = React.useState<OperationCapture | null>(null)
  const [preview, setPreview] = React.useState<WorktreeLifecyclePreview | null>(null)
  const [result, setResult] = React.useState<WorktreeLifecycleResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [approvalVersion, setApprovalVersion] = React.useState<number | null>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const safety = useOperationSafety(
    api,
    authority?.token,
    preview ? { kind: 'lifecycle', token: preview.token } : undefined,
    busy,
    JSON.stringify([
      sourceVersion,
      repository.refs,
      repository.worktrees.map((tree) => [
        tree.id,
        tree.path,
        tree.headOid,
        tree.refId,
        tree.indexSignature,
        tree.status,
        tree.locked,
        tree.missing,
      ]),
    ]),
  )
  const sourceCurrent = approvalVersion === sourceVersion
  const capture = React.useRef<OperationCapture | null>(null)
  const lock = React.useRef(false)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const trees = repository.worktrees.filter(
    (tree) =>
      !tree.missing &&
      tree.kind !== 'bare' &&
      (mode === 'create' || !worktreeIds.includes(tree.id)),
  )
  const retire = () => {
    setPreview(null)
    setAuthority(null)
    capture.current = null
    setCoordinated(false)
    setConfirmation('')
  }
  const prepare = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      if (!api.captureOperation || !api.worktreeLifecyclePreview)
        throw new Error('Lifecycle authority is unavailable.')
      const context = { repositoryId: repository.identity.id, worktreeId: executionId }
      const approval = await api.captureOperation(context)
      const scoped = inspectionAPI(api, { ...context, operationToken: approval.token })
      const value = await scoped.worktreeLifecyclePreview!(
        mode === 'create'
          ? {
              kind: 'create',
              repositoryId: repository.identity.id,
              sourceRefId: refId,
              directory,
              ...(newBranch.trim() ? { newBranch: newBranch.trim() } : {}),
            }
          : { kind: 'remove', repositoryId: repository.identity.id, worktreeIds: [...worktreeIds] },
      )
      capture.current = approval
      setAuthority(approval)
      setApprovalVersion(sourceVersion)
      setPreview(value)
    } catch (error) {
      setError(String(error))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const execute = async () => {
    if (
      lock.current ||
      !preview ||
      !capture.current ||
      !safety.current ||
      !sourceCurrent ||
      !coordinated ||
      preview.blockers.length ||
      (mode === 'remove' && confirmation !== 'REMOVE')
    )
      return
    lock.current = true
    setBusy(true)
    setError(null)
    const approval = capture.current
    capture.current = null
    try {
      if (!api.executeOperation) throw new Error('Captured execution is unavailable.')
      const value = await api.executeOperation(approval.token, {
        type: 'executeWorktreeLifecycle',
        token: preview.token,
        coordinationConfirmed: true,
      })
      if (!mounted.current) return
      const current = await inspectionAPI(api, approval.context).repositoryOperationScope()
      if (!mounted.current) return
      if (!sameOperationScope(approval.scope, current))
        throw new Error(
          'The result remains under its original authority in Operations; it cannot move to the current account.',
        )
      if (!value.worktreeLifecycle)
        throw new Error('The lifecycle result is unconfirmed; do not replay it.')
      setResult(value.worktreeLifecycle)
      await onChanged()
    } catch (error) {
      setError(String(error))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="workflow-dialog" initialFocus={() => cancelRef.current ?? false}>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'Create worktree' : 'Remove selected worktree directories'}
          </DialogTitle>
          <DialogDescription>
            Branches and pull requests are retained. No existing checkout is switched, stashed or
            reset. Closing this result is not an abort.
          </DialogDescription>
        </DialogHeader>
        <div className="workflow-form">
          {!preview && !result ? (
            <>
              <Field id="lifecycle-execution" label="Explicit Git execution directory">
                <Select
                  id="lifecycle-execution"
                  value={executionId}
                  disabled={busy}
                  onValueChange={(value) => {
                    setExecutionId(value)
                    retire()
                  }}
                  options={[
                    { value: '', label: 'Choose an existing directory' },
                    ...trees.map((tree) => ({ value: tree.id, label: tree.path })),
                  ]}
                />
              </Field>
              {mode === 'create' ? (
                <>
                  <Field id="lifecycle-ref" label="Qualified existing branch or base">
                    <Select
                      id="lifecycle-ref"
                      value={refId}
                      disabled={busy}
                      onValueChange={(value) => {
                        setRefId(value)
                        retire()
                      }}
                      options={[
                        { value: '', label: 'Choose an explicit ref' },
                        ...repository.refs.map((ref) => ({
                          value: ref.id,
                          label: `${ref.name} · ${ref.oid.slice(0, 12)}`,
                        })),
                      ]}
                    />
                  </Field>
                  <Field id="lifecycle-directory" label="New absolute directory">
                    <Input
                      id="lifecycle-directory"
                      value={directory}
                      disabled={busy}
                      onChange={(event) => {
                        setDirectory(event.target.value)
                        retire()
                      }}
                    />
                  </Field>
                  <Field
                    id="lifecycle-branch"
                    label="New branch (optional; empty uses the existing local branch)"
                  >
                    <Input
                      id="lifecycle-branch"
                      value={newBranch}
                      disabled={busy}
                      onChange={(event) => {
                        setNewBranch(event.target.value)
                        retire()
                      }}
                    />
                  </Field>
                </>
              ) : (
                <p>
                  {worktreeIds.length} exact selected directories. Eligibility is resolved by the
                  backend for the whole subset; rejected rows are never silently removed from it.
                </p>
              )}
              <Button
                disabled={!executionId || (mode === 'create' && (!refId || !directory)) || busy}
                onClick={() => void prepare()}
              >
                Preview actual effects
              </Button>
            </>
          ) : null}
          {preview ? (
            <>
              {authority ? <CapturedOperationContext capture={authority} /> : null}
              {!safety.current || !sourceCurrent ? (
                <p role="alert">
                  {!sourceCurrent ? 'The original provider session changed.' : safety.reason} The
                  original preview and input remain retained; prepare a fresh preview explicitly.
                </p>
              ) : null}
              <ol className="stack-preview-list">
                {preview.targets.map((target) => (
                  <li key={target.path}>
                    <div>
                      <code className="break-all">{target.path}</code>
                      <p>
                        {target.ref} · <code className="break-all">{target.oid}</code>
                      </p>
                      <p>{target.effect}</p>
                      {target.blockers.map((reason) => (
                        <p key={reason} role="alert">
                          {reason}
                        </p>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              <p>{preview.coordination}</p>
              {!result ? (
                <>
                  <Checkbox
                    checked={coordinated}
                    disabled={busy}
                    onCheckedChange={(value) => setCoordinated(value === true)}
                    label="I have coordinated external tools for these exact directories; this is not proof of exclusive access."
                  />
                  {mode === 'remove' ? (
                    <Field
                      id="lifecycle-confirmation"
                      label="Type REMOVE to confirm directory deletion"
                    >
                      <Input
                        id="lifecycle-confirmation"
                        value={confirmation}
                        disabled={busy}
                        onChange={(event) => setConfirmation(event.target.value)}
                      />
                    </Field>
                  ) : null}
                  <Button
                    variant={mode === 'remove' ? 'danger' : 'default'}
                    disabled={
                      busy ||
                      !capture.current ||
                      !safety.current ||
                      !sourceCurrent ||
                      !coordinated ||
                      Boolean(preview.blockers.length) ||
                      (mode === 'remove' && confirmation !== 'REMOVE')
                    }
                    onClick={() => void execute()}
                  >
                    {mode === 'create' ? 'Create reviewed worktree' : 'Remove reviewed directories'}
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={retire}>
                    Inspect and prepare a fresh preview
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
          {result ? (
            <div role="status">
              <p>{result.message}</p>
              <ol>
                {result.targets.map((target) => (
                  <li key={target.path}>
                    <code>{target.path}</code>: {target.state} — {target.detail}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <Button ref={cancelRef} variant="secondary" onClick={onClose}>
            {busy
              ? preview
                ? 'Hide running operation'
                : 'Close inspection'
              : result
                ? 'Close result'
                : 'Cancel preview'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
