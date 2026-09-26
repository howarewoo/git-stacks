import * as React from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import type {
  Branch,
  Commit,
  GitAction,
  PullRequest,
  PushPreview,
  RepositorySnapshot,
  StackKind,
  StackPreview,
} from '../../../shared/types'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Field } from './ui/field'
import { Select } from './ui/select'
import { Textarea } from './ui/textarea'
import { workflowAction, workflowActionLabel, type WorkflowActionInput } from './workflow-action'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import {
  BlockerList,
  OperationContext,
  OperationSteps,
  PhaseStatus,
  TypedConfirmation,
  WarningNote,
  WorkflowActions,
  WorkflowFrame,
  type ContextFact,
} from './workflow-composition'
import {
  CLOSE_INTENT_MESSAGES,
  closeIntent,
  createDispatchLock,
  initialFocusTarget,
  workflowBlocker,
  workflowPhase,
  type WorkflowComposition,
} from './workflow-policy'

export type RunAction = (action: GitAction, label: string) => Promise<boolean>
export type WorkflowRequest =
  | { kind: 'rename' | 'parent' | 'upstream' | 'deleteRemote'; branch: Branch }
  | { kind: 'pull' | 'merge' | 'stash' | 'forcePush' }
  | { kind: 'commitAction'; commit: Commit; mode: 'cherryPick' | 'revert' }
  | { kind: 'stack'; branch: string; operation: StackKind }
  | { kind: 'pr'; number: number }
  | {
      kind: 'confirm'
      action: GitAction
      title: string
      description: string
      label: string
      destructive?: boolean
    }

export function workflowError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const stackLabels = { restack: 'Restack', publish: 'Publish', merge: 'Merge pull request' }

/** Request kinds that read backend state before the action can be reviewed. */
const previewKinds: readonly string[] = ['stack', 'forcePush', 'pr']

type WorkflowData =
  | { kind: 'stack'; value: StackPreview }
  | { kind: 'forcePush'; value: PushPreview }
  | { kind: 'pr'; value: PullRequest & { body: string } }
  | { kind: 'local' }

function workflowComposition(request: WorkflowRequest): WorkflowComposition {
  if (request.kind === 'confirm') return request.destructive ? 'destructive' : 'form'
  if (request.kind === 'forcePush' || request.kind === 'deleteRemote') return 'destructive'
  if (request.kind === 'stack') return request.operation === 'merge' ? 'destructive' : 'reviewed'
  if (request.kind === 'pull' || request.kind === 'merge' || request.kind === 'commitAction')
    return 'reviewed'
  return 'form'
}

/**
 * The identity a reviewed preview was issued under. A rejected identity can
 * never be dispatched again: the dialog keeps it until the person explicitly
 * reloads, so a retry can never silently reuse it.
 */
export function previewIdentity(data: WorkflowData): string | null {
  if (data.kind === 'stack') return `stack:${data.value.token}`
  if (data.kind === 'forcePush')
    return `lease:${data.value.remote}/${data.value.destination.replace(/^refs\/heads\//, '')}:${data.value.localOid}:${data.value.remoteOid ?? 'new'}`
  if (data.kind === 'pr') return `pr:${data.value.number}:${data.value.headOid ?? 'unknown'}`
  return null
}

export function WorkflowDialog({
  request,
  snapshot,
  busy,
  actionError,
  onClearActionError,
  runAction,
  onClose,
  onRequest,
}: {
  request: WorkflowRequest
  snapshot: RepositorySnapshot
  busy: boolean
  actionError: string | null
  /** Retires the previous attempt's failure when a fresh preview is read. */
  onClearActionError: () => void
  runAction: RunAction
  onClose: () => void
  onRequest: (request: WorkflowRequest) => void
}) {
  const [name, setName] = React.useState(
    'branch' in request
      ? typeof request.branch === 'string'
        ? request.branch
        : request.kind === 'rename'
          ? request.branch.name
          : request.kind === 'upstream'
            ? (request.branch.upstreamRef ?? '')
            : (request.branch.parent ?? snapshot.defaultBranch)
      : '',
  )
  const [message, setMessage] = React.useState('')
  const [includeUntracked, setIncludeUntracked] = React.useState(true)
  const [strategy, setStrategy] = React.useState<'ff-only' | 'merge' | 'rebase'>('ff-only')
  const [mainline, setMainline] = React.useState('')
  const [confirmation, setConfirmation] = React.useState('')
  const [allowForce, setAllowForce] = React.useState(false)
  const [draft, setDraft] = React.useState(true)
  const [titles, setTitles] = React.useState<Record<string, string>>({})
  const [mergeMethod, setMergeMethod] = React.useState<'' | 'merge' | 'squash' | 'rebase'>('')
  const [preview, setPreview] = React.useState<StackPreview | null>(null)
  const [push, setPush] = React.useState<PushPreview | null>(null)
  const [pr, setPr] = React.useState<(PullRequest & { body: string }) | null>(null)
  const [prTitle, setPrTitle] = React.useState('')
  const [body, setBody] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(previewKinds.includes(request.kind))
  const [loaded, setLoaded] = React.useState(false)
  const [finished, setFinished] = React.useState(false)
  const [confirmPrState, setConfirmPrState] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const [rejectedIdentities, setRejectedIdentities] = React.useState<string[]>([])
  const [identity, setIdentity] = React.useState<string | null>(null)
  const [edited, setEdited] = React.useState(false)
  const [closeNotice, setCloseNotice] = React.useState<string | null>(null)
  const hasEditedRef = React.useRef(false)
  const captured = React.useRef({
    path: snapshot.path,
    head: snapshot.headOid,
    branch: snapshot.currentBranch,
  })
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const trigger = React.useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const dispatch = React.useRef(createDispatchLock()).current
  const locked = busy || loading
  const composition = workflowComposition(request)
  const localBranches = snapshot.branches.filter((branch) => !branch.remote)
  const parentNames = localBranches.map((branch) => branch.name)
  if (
    !parentNames.includes(snapshot.defaultBranch) &&
    snapshot.branches.some(
      (branch) => branch.ref === `refs/remotes/origin/${snapshot.defaultBranch}`,
    )
  )
    parentNames.push(snapshot.defaultBranch)

  const stale = identity !== null && rejectedIdentities.includes(identity)
  const markEdited = () => {
    hasEditedRef.current = true
    setEdited(true)
    setCloseNotice(null)
  }

  const initialLoad = React.useRef<{
    request: WorkflowRequest
    attempt: number
    promise: Promise<WorkflowData>
  } | null>(null)

  React.useEffect(() => {
    let active = true
    setError(null)
    setIdentity(null)
    setLoading(previewKinds.includes(request.kind))
    setLoaded(false)
    if (initialLoad.current?.request !== request || initialLoad.current.attempt !== attempt) {
      const load = async (): Promise<WorkflowData> => {
        if (request.kind === 'stack') {
          return {
            kind: 'stack',
            value: await window.desktop.stackPreview(request.operation, request.branch),
          }
        }
        if (request.kind === 'forcePush') {
          return { kind: 'forcePush', value: await window.desktop.pushPreview() }
        }
        if (request.kind === 'pr') {
          return { kind: 'pr', value: await window.desktop.pullRequest(request.number) }
        }
        return { kind: 'local' }
      }
      initialLoad.current = { request, attempt, promise: load() }
    }
    void initialLoad.current.promise.then(
      (data) => {
        if (!active) return
        setRejectedIdentities([])
        if (data.kind === 'stack') {
          setPreview(data.value)
          // Entered titles survive a preview reload; only untouched branches are seeded.
          setTitles((current) =>
            Object.fromEntries(
              data.value.steps.map((step) => [step.branch, current[step.branch] ?? step.title]),
            ),
          )
        } else if (data.kind === 'forcePush') {
          setPush(data.value)
        } else if (data.kind === 'pr') {
          setPr(data.value)
          if (!hasEditedRef.current) {
            setPrTitle(data.value.title)
            setBody(data.value.body)
            setDraft(data.value.draft)
          }
        }
        setLoaded(true)
        setLoading(false)
        setIdentity(previewIdentity(data))
      },
      (value) => {
        if (!active) return
        setError(workflowError(value))
        setLoading(false)
        setIdentity(null)
      },
    )
    return () => {
      active = false
    }
  }, [request, attempt])

  const title =
    request.kind === 'stack'
      ? `${stackLabels[request.operation]}${request.operation === 'merge' ? '' : ' stack'}`
      : request.kind === 'confirm'
        ? request.title
        : request.kind === 'commitAction'
          ? `${request.mode === 'cherryPick' ? 'Cherry-pick' : 'Revert'} commit`
          : (
              {
                rename: 'Rename local branch',
                deleteRemote: 'Delete remote branch',
                parent: 'Set stack parent',
                upstream: 'Set upstream',
                pull: 'Pull changes',
                merge: 'Merge into current branch',
                stash: 'Stash working changes',
                forcePush: 'Force push with lease',
                pr: `Pull request #${request.kind === 'pr' ? request.number : ''}`,
              } as Record<string, string>
            )[request.kind]
  const description =
    request.kind === 'confirm'
      ? request.description
      : request.kind === 'rename'
        ? 'Rename the local branch and update its recorded children. Remote branch names and PRs stay unchanged.'
        : request.kind === 'deleteRemote'
          ? 'Delete this branch from its remote repository. Open PRs may close. Local branches and child relationships are not changed. A changed remote tip stops deletion.'
          : request.kind === 'parent'
            ? 'Record the intended parent without rewriting commits. Preview Restack next to move this branch and its descendants.'
            : request.kind === 'upstream'
              ? 'Choose the remote branch used by Pull and Push. This does not change the stack parent.'
              : request.kind === 'pull'
                ? `Integrate the upstream of ${captured.current.branch ?? 'the current branch'}. Fast-forward only never creates or rewrites commits.`
                : request.kind === 'merge'
                  ? `Merge a selected branch into ${captured.current.branch ?? 'the current branch'}. Git stops if conflicts need attention.`
                  : request.kind === 'stash'
                    ? 'Save work without creating a commit. Ignored files are not included.'
                    : request.kind === 'forcePush'
                      ? 'Replace remote history only if its tip still matches this preview. Someone else’s newer push will be rejected.'
                      : request.kind === 'commitAction'
                        ? `${request.commit.subject} · ${request.commit.oid.slice(0, 10)} → ${captured.current.branch ?? 'current branch'}`
                        : request.kind === 'pr'
                          ? 'Manage this pull request, or open GitHub for the full review discussion.'
                          : request.kind === 'stack' && request.operation === 'restack'
                            ? 'Rebase parent-first using each branch’s recorded boundary. Conflicts pause the stack; your original checkout is restored on completion.'
                            : request.kind === 'stack' && request.operation === 'publish'
                              ? 'Push the reviewed branches, create missing PRs, and update their bases and linked stack navigation.'
                              : 'Merge one bottom PR into the default branch. Then explicitly restack and publish the remaining branches. No automatic merges or queue enrollment.'

  const run = async (action: GitAction, label: string) => {
    if (locked || captured.current.path !== snapshot.path) return
    const attemptRun = dispatch(async () => {
      const success = await runAction(action, label)
      if (!success && identity)
        setRejectedIdentities((current) =>
          current.includes(identity) ? current : [...current, identity],
        )
      return success
    })
    const { dispatched, value: success } = await attemptRun
    if (!dispatched || !success) return
    if (request.kind === 'stack' && request.operation !== 'publish') setFinished(true)
    else onClose()
  }

  const confirmationTarget =
    request.kind === 'forcePush'
      ? (push?.branch ?? null)
      : request.kind === 'deleteRemote'
        ? request.branch.name
        : request.kind === 'stack' && allowForce
          ? request.branch
          : null
  const actionInput: WorkflowActionInput | null =
    request.kind === 'confirm'
      ? { kind: 'confirm', action: request.action, label: request.label }
      : request.kind === 'stack'
        ? preview
          ? {
              kind: 'stack',
              operation: request.operation,
              preview,
              allowForce,
              confirmation,
              confirmationTarget,
              draft,
              titles,
              mergeMethod,
            }
          : null
        : request.kind === 'pr'
          ? { kind: 'pr', number: request.number, title: prTitle, body, draft }
          : request.kind === 'forcePush'
            ? { kind: 'forcePush', push, confirmation }
            : request.kind === 'deleteRemote'
              ? { kind: 'deleteRemote', branch: request.branch, confirmation }
              : request.kind === 'rename'
                ? { kind: 'rename', branch: request.branch, name }
                : request.kind === 'parent'
                  ? { kind: 'parent', branch: request.branch, name }
                  : request.kind === 'upstream'
                    ? { kind: 'upstream', branch: request.branch, name }
                    : request.kind === 'pull'
                      ? { kind: 'pull', strategy }
                      : request.kind === 'merge'
                        ? { kind: 'merge', ref: name }
                        : request.kind === 'stash'
                          ? { kind: 'stash', message, includeUntracked }
                          : request.kind === 'commitAction'
                            ? {
                                kind: 'commitAction',
                                commit: request.commit,
                                mode: request.mode,
                                mainline,
                              }
                            : null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (blocker || !actionInput) return
    const action = workflowAction(actionInput, {
      headOid: captured.current.head,
      currentBranch: captured.current.branch,
    })
    if (!action) return
    return run(action, workflowActionLabel(actionInput))
  }

  const stackSteps =
    preview && request.kind === 'stack'
      ? preview.steps.filter(
          (step) => request.operation !== 'merge' || step.branch === request.branch,
        )
      : []
  const untitledBranches =
    request.kind === 'stack' && request.operation === 'publish' && preview
      ? preview.steps
          .filter((step) => !step.pr && !titles[step.branch]?.trim())
          .map((s) => s.branch)
      : []
  const blocker = workflowBlocker({
    kind: request.kind,
    busy,
    loading,
    loaded,
    finished,
    capturedPath: captured.current.path,
    currentPath: snapshot.path,
    previewToken: identity,
    rejectedTokens: rejectedIdentities,
    previewBlockers: preview?.blockers ?? [],
    confirmationTarget,
    confirmation,
    allowForce,
    expectedOidMissing:
      (request.kind === 'deleteRemote' && !request.branch.oid) ||
      (request.kind === 'forcePush' && !push),
    requiresName: ['rename', 'parent', 'merge'].includes(request.kind),
    name,
    requiresMainline: request.kind === 'commitAction' && request.commit.parents.length > 1,
    mainline,
    requiresMergeMethod: request.kind === 'stack' && request.operation === 'merge',
    mergeMethod,
    untitledBranches,
    pullRequestMissing: request.kind === 'pr' && !pr,
    pullRequestMerged: request.kind === 'pr' && pr?.state === 'MERGED',
    pullRequestTitle: prTitle,
  })
  const failed = Boolean(error || actionError)
  const phase = workflowPhase({
    loading,
    busy,
    failed,
    stale,
    finished,
    partial: false,
    blocked: Boolean(blocker) && !finished,
  })
  const actionLabel =
    request.kind === 'confirm'
      ? request.label
      : request.kind === 'stack'
        ? `${stackLabels[request.operation]}${request.operation === 'merge' ? '' : ' stack'}`
        : request.kind === 'pr'
          ? 'Save PR changes'
          : title
  const statusMessage =
    phase === 'loading'
      ? 'Reading current repository state…'
      : phase === 'submitting'
        ? `${actionLabel} is running. Wait for it to finish before doing anything else here.`
        : phase === 'failed'
          ? (error ?? (actionError as string))
          : phase === 'stale'
            ? 'This preview was already rejected. Reload it to read the current state; the rejected preview will not run again.'
            : phase === 'succeeded'
              ? request.kind === 'stack' && request.operation === 'merge'
                ? 'Restack the remaining branches onto the updated base, then publish to update their pull requests.'
                : 'Publish next to update remote branches and PR bases. Rewritten branches require your explicit force-with-lease approval.'
              : phase === 'blocked'
                ? blocker?.message
                : undefined
  const destructive = composition === 'destructive'

  const publicationRoots =
    finished && request.kind === 'stack' && request.operation === 'restack'
      ? (preview?.steps.filter(
          (step) => !preview.steps.some((candidate) => candidate.branch === step.parent),
        ) ?? [])
      : []

  const contextFacts: ContextFact[] =
    request.kind === 'deleteRemote'
      ? [
          { label: 'Remote ref', value: request.branch.ref, code: true },
          {
            label: 'Expected remote tip',
            value: request.branch.oid?.slice(0, 12) ?? 'Unavailable — fetch and try again',
            code: true,
          },
        ]
      : request.kind === 'forcePush' && push
        ? [
            {
              label: 'Destination',
              value: `${push.remote}/${push.destination.replace(/^refs\/heads\//, '')}`,
              code: true,
            },
            {
              label: 'Expected remote tip',
              value: push.remoteOid?.slice(0, 12) ?? 'New branch',
              code: true,
            },
            { label: 'Local tip', value: push.localOid.slice(0, 12), code: true },
          ]
        : request.kind === 'merge' && captured.current.branch
          ? [
              { label: 'Target branch', value: captured.current.branch },
              { label: 'Current tip', value: captured.current.head ?? 'Unavailable', code: true },
            ]
          : request.kind === 'rename' && 'branch' in request
            ? [
                { label: 'Local ref', value: request.branch.ref, code: true },
                { label: 'Current name', value: request.branch.name },
              ]
            : []

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return
        const intent = closeIntent({ busy, dirty: edited && !finished })
        if (intent === 'allow') {
          onClose()
          return
        }
        setCloseNotice(CLOSE_INTENT_MESSAGES[intent])
      }}
    >
      <DialogContent
        ref={contentRef}
        className="workflow-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (initialFocusTarget(composition) === 'cancel') {
            cancelRef.current?.focus()
            return
          }
          const firstField = contentRef.current?.querySelector<HTMLElement>(
            '[data-workflow-first-field]',
          )
          ;(firstField ?? cancelRef.current)?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (trigger.current?.isConnected && !trigger.current.matches(':disabled'))
            trigger.current.focus()
          else document.querySelector<HTMLInputElement>('.toolbar-search input')?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="workflow-form" onSubmit={submit}>
          <WorkflowFrame composition={composition} wide={request.kind === 'stack'}>
            <fieldset className="workflow-fields" disabled={locked || finished}>
              {closeNotice ? <WarningNote>{closeNotice}</WarningNote> : null}
              {contextFacts.length ? <OperationContext facts={contextFacts} /> : null}
              <PhaseStatus phase={phase} message={statusMessage} />
              {request.kind === 'rename' ? (
                <Field id="workflow-name" label="New branch name" required>
                  <Input
                    data-workflow-first-field=""
                    value={name}
                    onChange={(event) => {
                      markEdited()
                      setName(event.target.value)
                    }}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              ) : null}
              {request.kind === 'deleteRemote' ? (
                <>
                  <WarningNote>
                    Remote-only commits may become unreachable. This cannot be undone from the app.
                  </WarningNote>
                  <TypedConfirmation
                    id="workflow-confirm"
                    value={confirmation}
                    target={request.branch.name}
                    onChange={(value) => {
                      markEdited()
                      setConfirmation(value)
                    }}
                    disabled={locked}
                  />
                </>
              ) : null}
              {request.kind === 'parent' || request.kind === 'merge' ? (
                <>
                  <Field
                    id="workflow-branch"
                    label={request.kind === 'parent' ? 'Parent branch' : 'Branch to merge'}
                    required={request.kind === 'parent'}
                    description={
                      request.kind === 'parent'
                        ? 'The original boundary is retained so restacking does not replay the previous parent’s commits.'
                        : undefined
                    }
                  >
                    <Select
                      data-workflow-first-field=""
                      value={name}
                      onChange={(event) => {
                        markEdited()
                        setName(event.target.value)
                      }}
                    >
                      <option value="">Choose a branch</option>
                      {request.kind === 'parent'
                        ? parentNames
                            .filter((parent) => parent !== request.branch.name)
                            .map((parent) => (
                              <option key={parent} value={parent}>
                                {parent}
                              </option>
                            ))
                        : snapshot.branches
                            .filter((branch) => !branch.current)
                            .map((branch) => (
                              <option key={branch.ref} value={branch.ref}>
                                {branch.name}
                              </option>
                            ))}
                    </Select>
                  </Field>
                </>
              ) : null}
              {request.kind === 'upstream' ? (
                <Field id="workflow-upstream" label="Remote tracking branch">
                  <Select
                    data-workflow-first-field=""
                    value={name}
                    onChange={(event) => {
                      markEdited()
                      setName(event.target.value)
                    }}
                  >
                    <option value="">No upstream</option>
                    {snapshot.branches
                      .filter((branch) => branch.remote)
                      .map((branch) => (
                        <option value={branch.ref} key={branch.ref}>
                          {branch.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              ) : null}
              {request.kind === 'pull' ? (
                <>
                  <Field id="workflow-pull" label="Integration strategy">
                    <Select
                      data-workflow-first-field=""
                      value={strategy}
                      onChange={(event) => {
                        markEdited()
                        setStrategy(event.target.value as typeof strategy)
                      }}
                    >
                      <option value="ff-only">Fast-forward only</option>
                      <option value="merge">Merge upstream changes</option>
                      <option value="rebase">Rebase local commits onto upstream</option>
                    </Select>
                  </Field>
                  {strategy === 'rebase' ? (
                    <WarningNote>
                      Rebase rewrites local commits. Restack dependent branches afterward.
                    </WarningNote>
                  ) : null}
                </>
              ) : null}
              {request.kind === 'forcePush' ? (
                <>
                  <WarningNote>
                    Commits present only on the remote can become unreachable. A newer push by
                    someone else is rejected rather than overwritten.
                  </WarningNote>
                  <TypedConfirmation
                    id="workflow-force-confirmation"
                    label={`Type ${confirmationTarget ?? ''} to confirm`}
                    value={confirmation}
                    onChange={(value) => {
                      markEdited()
                      setConfirmation(value)
                    }}
                    target={confirmationTarget ?? ''}
                  />
                </>
              ) : null}
              {request.kind === 'stash' ? (
                <>
                  <Field id="workflow-stash-message" label="Message (optional)">
                    <Input
                      data-workflow-first-field=""
                      value={message}
                      onChange={(event) => {
                        markEdited()
                        setMessage(event.target.value)
                      }}
                      placeholder="Work to return to"
                    />
                  </Field>
                  <Checkbox
                    id="workflow-include-untracked"
                    label="Include untracked files"
                    checked={includeUntracked}
                    onChange={(event) => {
                      markEdited()
                      setIncludeUntracked(event.target.checked)
                    }}
                  />
                </>
              ) : null}
              {request.kind === 'commitAction' && request.commit.parents.length > 1 ? (
                <Field
                  id="workflow-mainline"
                  label="Mainline parent for this merge commit"
                  required
                >
                  <Select
                    data-workflow-first-field=""
                    value={mainline}
                    onChange={(event) => {
                      markEdited()
                      setMainline(event.target.value)
                    }}
                  >
                    <option value="">Choose the parent whose changes to keep</option>
                    {request.commit.parents.map((oid, index) => (
                      <option key={oid} value={index + 1}>
                        Parent {index + 1}: {oid.slice(0, 12)}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {request.kind === 'stack' && preview ? (
                <>
                  <OperationSteps
                    steps={stackSteps}
                    label="Planned stack operations"
                    emptyNote="This preview contains no steps to run."
                  />
                  {preview.warnings.map((warning, index) => (
                    <WarningNote key={`${index}-${warning}`}>{warning}</WarningNote>
                  ))}
                  <BlockerList items={preview.blockers} />
                  {request.operation === 'publish' ? (
                    <>
                      <Checkbox
                        id="workflow-create-drafts"
                        label="Create new PRs as drafts"
                        checked={draft}
                        onChange={(event) => {
                          markEdited()
                          setDraft(event.target.checked)
                        }}
                      />
                      <Checkbox
                        id="workflow-allow-force"
                        label="Allow rewritten branches to be pushed with exact leases"
                        checked={allowForce}
                        onChange={(event) => {
                          markEdited()
                          setAllowForce(event.target.checked)
                          setConfirmation('')
                        }}
                      />
                      {allowForce ? (
                        <>
                          <WarningNote>
                            Remote-only commits may be replaced. A changed remote tip stops the
                            push.
                          </WarningNote>
                          <TypedConfirmation
                            id="workflow-confirm"
                            value={confirmation}
                            target={request.branch}
                            onChange={(value) => {
                              markEdited()
                              setConfirmation(value)
                            }}
                            disabled={locked}
                          />
                        </>
                      ) : null}
                      {stackSteps
                        .filter((step) => !step.pr)
                        .map((step) => (
                          <Field
                            key={`title-${encodeURIComponent(step.branch)}`}
                            id={`title-${encodeURIComponent(step.branch)}`}
                            label={`PR title for ${step.branch}`}
                            required
                          >
                            <Input
                              value={titles[step.branch] ?? ''}
                              onChange={(event) => {
                                markEdited()
                                setTitles((current) => ({
                                  ...current,
                                  [step.branch]: event.target.value,
                                }))
                              }}
                            />
                          </Field>
                        ))}
                    </>
                  ) : null}
                  {request.operation === 'merge' ? (
                    <Field id="workflow-merge-method" label="Merge method" required>
                      <Select
                        data-workflow-first-field=""
                        value={mergeMethod}
                        onChange={(event) => {
                          markEdited()
                          setMergeMethod(event.target.value as typeof mergeMethod)
                        }}
                      >
                        <option value="">Choose a repository-supported method</option>
                        {preview.mergeMethods.map((method) => (
                          <option key={method} value={method}>
                            {method === 'squash'
                              ? 'Squash and merge'
                              : method === 'rebase'
                                ? 'Rebase and merge'
                                : 'Create a merge commit'}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                </>
              ) : null}
              {request.kind === 'pr' && pr ? (
                <>
                  <div className="workflow-row">
                    <Badge variant={pr.state === 'MERGED' ? 'accent' : 'secondary'}>
                      {pr.state.toLowerCase()}
                    </Badge>
                    <span className="workflow-note">
                      {pr.head} → {pr.base}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        window.desktop
                          .openExternal(pr.url)
                          .catch((value) => setError(workflowError(value)))
                      }
                    >
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                      GitHub
                    </Button>
                  </div>
                  <p className="workflow-note">
                    Checks: {pr.checks} · Reviews:{' '}
                    {pr.reviewDecision?.replaceAll('_', ' ').toLowerCase() || 'No decision'} · Merge
                    state: {pr.mergeState?.replaceAll('_', ' ').toLowerCase() || 'Unknown'}
                  </p>
                  <Field id="workflow-pr-title" label="Title" required>
                    <Input
                      data-workflow-first-field=""
                      value={prTitle}
                      disabled={pr.state === 'MERGED'}
                      onChange={(event) => {
                        markEdited()
                        setPrTitle(event.target.value)
                      }}
                    />
                  </Field>
                  <Field id="workflow-pr-body" label="Description (optional)">
                    <Textarea
                      rows={6}
                      value={body}
                      disabled={pr.state === 'MERGED'}
                      onChange={(event) => {
                        markEdited()
                        setBody(event.target.value)
                      }}
                    />
                  </Field>
                  <Checkbox
                    id="workflow-pr-draft"
                    label="Draft pull request"
                    checked={draft}
                    disabled={pr.state !== 'OPEN'}
                    onChange={(event) => {
                      markEdited()
                      setDraft(event.target.checked)
                    }}
                  />
                  {pr.state === 'OPEN' &&
                  localBranches.some(
                    (branch) => branch.name === pr.head && branch.pr?.number === pr.number,
                  ) ? (
                    <Button
                      variant="secondary"
                      tooltip="Check the PR’s current head, reviews, checks, and allowed merge methods before merging."
                      onClick={() =>
                        onRequest({ kind: 'stack', operation: 'merge', branch: pr.head })
                      }
                    >
                      Preview merge
                    </Button>
                  ) : null}
                  {pr.state === 'OPEN' &&
                  !localBranches.some((branch) => branch.pr?.number === pr.number) ? (
                    <p className="workflow-note">
                      Check out the PR’s branch to manage it as a local stack. Fork PRs remain
                      available on GitHub.
                    </p>
                  ) : null}
                  {pr.state !== 'MERGED' ? (
                    <div className="pr-lifecycle">
                      {confirmPrState ? (
                        <>
                          <WarningNote>
                            {pr.state === 'OPEN'
                              ? 'Close this PR without merging? Its branch and commits remain. Unsaved form edits are not applied.'
                              : 'Reopen this pull request? Unsaved form edits will not be applied.'}
                          </WarningNote>
                          <div className="workflow-row">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setConfirmPrState(false)}
                            >
                              Cancel
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              tooltip={
                                pr.state === 'OPEN'
                                  ? 'Close this PR without merging or deleting its branch. Unsaved edits are not applied.'
                                  : 'Reopen this PR on GitHub. Unsaved edits are not applied.'
                              }
                              onClick={() =>
                                run(
                                  {
                                    type: pr.state === 'OPEN' ? 'closePr' : 'reopenPr',
                                    number: pr.number,
                                  },
                                  pr.state === 'OPEN'
                                    ? 'Close pull request'
                                    : 'Reopen pull request',
                                )
                              }
                            >
                              {pr.state === 'OPEN' ? 'Confirm close' : 'Confirm reopen'}
                            </Button>
                          </div>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmPrState(true)}
                          tooltip={
                            pr.state === 'OPEN'
                              ? 'Review closing this PR without merging. Its branch and commits will remain.'
                              : 'Review reopening this closed PR on GitHub.'
                          }
                        >
                          {pr.state === 'OPEN' ? 'Close without merging…' : 'Reopen pull request…'}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </>
              ) : null}
            </fieldset>
            {!loading && (error || actionError) && previewKinds.includes(request.kind) ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  onClearActionError()
                  setAttempt((value) => value + 1)
                }}
                tooltip="Read the latest repository and GitHub state to replace this preview. No Git changes are made."
              >
                Reload preview
              </Button>
            ) : null}
            <WorkflowActions>
              <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={onClose}>
                {finished ? 'Done' : 'Cancel'}
              </Button>
              {finished && request.kind === 'stack' ? (
                request.operation === 'merge' ? (
                  <Button
                    variant="accent"
                    tooltip="Preview rebasing the remaining branches onto the merged base. No changes are made yet."
                    onClick={() =>
                      onRequest({ kind: 'stack', branch: request.branch, operation: 'restack' })
                    }
                  >
                    Preview remaining restack
                  </Button>
                ) : (
                  publicationRoots.map((root) => (
                    <Button
                      key={root.branch}
                      variant="accent"
                      tooltip="Review remote updates and PR base changes before publishing this remaining stack."
                      onClick={() =>
                        onRequest({ kind: 'stack', branch: root.branch, operation: 'publish' })
                      }
                    >
                      {publicationRoots.length === 1
                        ? 'Preview publication'
                        : `Publish ${root.branch}…`}
                    </Button>
                  ))
                )
              ) : (
                <Button
                  type="submit"
                  variant={destructive ? 'danger' : 'accent'}
                  disabled={Boolean(blocker)}
                  loading={busy}
                  tooltip={blocker ? blocker.message : description}
                >
                  {busy ? (
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : null}
                  {actionLabel}
                </Button>
              )}
            </WorkflowActions>
          </WorkflowFrame>
        </form>
      </DialogContent>
    </Dialog>
  )
}
