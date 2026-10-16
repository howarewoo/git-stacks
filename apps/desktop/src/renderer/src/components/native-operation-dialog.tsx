import * as React from 'react'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Field,
  Input,
  Select,
} from '@git-stacks/ui'
import type { DesktopAPI, NativeStack } from '@git-stacks/shared/types'
import type { RepositoryInventory } from '@git-stacks/shared/worktree-inventory'
import type { OperationCapture } from '@git-stacks/shared/operation-scope'
import type {
  NativeOperationRequest,
  NativeOperationPreview,
} from '@git-stacks/shared/native-operation'
import { inspectionAPI } from '../lib/inspection-api'
import { sameOperationScope } from '@git-stacks/shared/operation-scope'
import { CapturedOperationContext } from './workflow-composition'
import { useOperationSafety } from '../lib/operation-safety'

export function NativeOperationDialog({
  api,
  repository,
  sourceVersion,
  initialNumber,
  onClose,
  onChanged,
}: {
  api: DesktopAPI
  repository: RepositoryInventory
  initialNumber?: number
  sourceVersion: number
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [worktreeId, setWorktreeId] = React.useState('')
  const [kind, setKind] = React.useState<NativeOperationRequest['kind']>('create')
  const [numbers, setNumbers] = React.useState(initialNumber ? String(initialNumber) : '')
  const [stackNumber, setStackNumber] = React.useState('')
  const [stacks, setStacks] = React.useState<NativeStack[] | null>(null)
  const [authority, setAuthority] = React.useState<OperationCapture | null>(null)
  const [preview, setPreview] = React.useState<NativeOperationPreview | null>(null)
  const capture = React.useRef<OperationCapture | null>(null)
  const lock = React.useRef(false)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [busy, setBusy] = React.useState(false)
  const [consent, setConsent] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState<string | null>(null)
  const [approvalVersion, setApprovalVersion] = React.useState<number | null>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const safety = useOperationSafety(
    api,
    authority?.token,
    preview ? { kind: 'native', token: preview.token } : undefined,
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
  const retire = () => {
    capture.current = null
    setAuthority(null)
    setPreview(null)
    setConsent(false)
    setTyped('')
    setResult(null)
  }
  const prepare = async (listOnly = false) => {
    if (lock.current || !worktreeId) return
    lock.current = true
    setBusy(true)
    setError('')
    retire()
    try {
      if (!api.captureOperation) throw new Error('Captured operation authority is unavailable.')
      const target = { repositoryId: repository.identity.id, worktreeId }
      const approved = await api.captureOperation(target)
      const scoped = inspectionAPI(api, { ...target, operationToken: approved.token })
      const observation = await scoped.refresh()
      setStacks(observation.nativeStacks ?? [])
      if (listOnly) return
      if (!scoped.nativeOperationPreview)
        throw new Error('Native management preview is unavailable.')
      const pullRequests = numbers.split(',').map((value) => Number(value.trim()))
      const request: NativeOperationRequest =
        kind === 'create'
          ? { kind, pullRequests }
          : kind === 'extend'
            ? { kind, stackNumber: Number(stackNumber), pullRequests }
            : { kind, stackNumber: Number(stackNumber) }
      const value = await scoped.nativeOperationPreview(request)
      capture.current = approved
      setAuthority(approved)
      setApprovalVersion(sourceVersion)
      setPreview(value)
    } catch (cause) {
      setError(String(cause))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const execute = async () => {
    if (
      lock.current ||
      !capture.current ||
      !preview ||
      preview.blockers.length ||
      !safety.current ||
      !sourceCurrent ||
      !consent ||
      (kind === 'unstack' && typed !== 'UNSTACK')
    )
      return
    const approved = capture.current
    capture.current = null
    lock.current = true
    setBusy(true)
    setError('')
    try {
      if (!api.executeOperation) throw new Error('Captured dispatch is unavailable.')
      const value = await api.executeOperation(approved.token, {
        type: 'executeNativeOperation',
        token: preview.token,
        confirmed: true,
      })
      if (!mounted.current) return
      const current = await inspectionAPI(api, approved.context).repositoryOperationScope()
      if (!mounted.current) return
      if (!sameOperationScope(approved.scope, current))
        throw new Error(
          'The result remains under its original authority in Operations; it cannot move to the current account.',
        )
      setResult(value.message)
      await onChanged()
    } catch (cause) {
      setError(
        `${String(cause)} This confirmation is spent. Inspect durable Operations status before preparing another request; an uncertain provider write is not replayed.`,
      )
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
          <DialogTitle>Native stack management</DialogTitle>
          <DialogDescription>
            Provider registration is separate from publication, branch dependencies, merge and
            deletion. Inspect the actual provider-owned order; no local file or checkout action is
            implied.
          </DialogDescription>
        </DialogHeader>
        {!preview ? (
          <>
            <Field id="native-worktree" label="Explicit execution directory">
              <Select
                id="native-worktree"
                value={worktreeId}
                disabled={busy}
                onValueChange={(value) => {
                  retire()
                  setWorktreeId(value)
                  setStacks(null)
                }}
                options={[
                  { value: '', label: 'Choose an existing directory' },
                  ...repository.worktrees
                    .filter((tree) => !tree.missing && tree.kind !== 'bare')
                    .map((tree) => ({ value: tree.id, label: tree.path })),
                ]}
              />
            </Field>
            <Button
              variant="secondary"
              disabled={busy || !worktreeId}
              onClick={() => void prepare(true)}
            >
              Inspect current native stacks
            </Button>
            {stacks ? (
              <ul>
                {stacks.map((stack) => (
                  <li key={stack.number}>
                    Stack #{stack.number} · {stack.open ? 'Open' : 'Closed'} ·{' '}
                    {stack.pullRequests.map((pr) => `#${pr.number} ${pr.head}`).join(' → ')} ·{' '}
                    {stack.status}
                  </li>
                ))}
              </ul>
            ) : null}
            <Field id="native-kind" label="Distinct registration action">
              <Select
                id="native-kind"
                value={kind}
                disabled={busy}
                onValueChange={(value) => {
                  retire()
                  setKind(value as NativeOperationRequest['kind'])
                }}
                options={[
                  { value: 'create', label: 'Create from an exact bottom-to-top PR chain' },
                  { value: 'extend', label: 'Append to the observed stack top' },
                  { value: 'unstack', label: 'Unstack observed unmerged members' },
                ]}
              />
            </Field>
            {kind !== 'create' ? (
              <Field id="native-stack-number" label="Observed native stack">
                <Select
                  id="native-stack-number"
                  value={stackNumber}
                  disabled={busy}
                  onValueChange={(value) => {
                    retire()
                    setStackNumber(value)
                  }}
                  options={[
                    { value: '', label: 'Inspect and choose a native stack' },
                    ...(stacks ?? [])
                      .filter((stack) => stack.open)
                      .map((stack) => ({
                        value: String(stack.number),
                        label: `Stack #${stack.number}: ${stack.pullRequests.map((pr) => `#${pr.number}`).join(' → ')}`,
                      })),
                  ]}
                />
              </Field>
            ) : null}
            {kind !== 'unstack' ? (
              <Field
                id="native-pr-numbers"
                label="Exact PR numbers, bottom-to-top (comma separated)"
              >
                <Input
                  id="native-pr-numbers"
                  value={numbers}
                  disabled={busy}
                  onChange={(event) => {
                    retire()
                    setNumbers(event.target.value)
                  }}
                />
              </Field>
            ) : null}
            <Button
              disabled={busy || !worktreeId || (kind !== 'create' && !stackNumber)}
              onClick={() => void prepare()}
            >
              Preview actual native change
            </Button>
          </>
        ) : (
          <>
            {authority ? <CapturedOperationContext capture={authority} /> : null}
            {!safety.current || !sourceCurrent ? (
              <p role="alert">
                {!sourceCurrent ? 'The original provider session changed.' : safety.reason} The
                original preview and input remain retained; prepare a fresh preview explicitly.
              </p>
            ) : null}
            <p>
              Provider native resource: <code>{preview.fullName}</code>
            </p>
            <ol className="stack-preview-list">
              {preview.pullRequests.map((pr) => (
                <li key={pr.number}>
                  <div>
                    <strong>
                      #{pr.number} {pr.head}
                    </strong>
                    <p>
                      Head: <code className="break-all">{pr.headOid}</code>
                    </p>
                    <p>
                      Base: {pr.base} · <code className="break-all">{pr.baseOid}</code>
                    </p>
                    <p>{pr.state}</p>
                  </div>
                </li>
              ))}
            </ol>
            {preview.stack ? (
              <p>
                Original membership:{' '}
                {preview.stack.pullRequests.map((pr) => `#${pr.number}`).join(' → ')}
              </p>
            ) : null}
            <ul>
              {preview.effects.map((effect) => (
                <li key={effect}>{effect}</li>
              ))}
              {preview.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
            <Checkbox
              checked={consent}
              disabled={busy || Boolean(result)}
              onCheckedChange={(value) => setConsent(value === true)}
              label="I approve this exact membership/order change and have coordinated external provider writers."
            />
            {kind === 'unstack' ? (
              <Field
                id="native-unstack-confirmation"
                label="Type UNSTACK to confirm the distinct registration removal"
              >
                <Input
                  id="native-unstack-confirmation"
                  value={typed}
                  disabled={busy}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </Field>
            ) : null}
            <Button
              disabled={
                busy ||
                Boolean(result) ||
                !capture.current ||
                !consent ||
                !safety.current ||
                !sourceCurrent ||
                preview.blockers.length > 0 ||
                (kind === 'unstack' && typed !== 'UNSTACK')
              }
              onClick={() => void execute()}
            >
              Apply reviewed native change
            </Button>
            <Button variant="secondary" disabled={busy} onClick={retire}>
              Inspect and prepare a fresh preview
            </Button>
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
        {result ? <p role="status">{result}</p> : null}
        <Button ref={cancelRef} variant="secondary" onClick={onClose}>
          {busy
            ? preview
              ? 'Hide running operation'
              : 'Close inspection'
            : 'Close without replay'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
