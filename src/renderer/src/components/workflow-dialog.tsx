import * as React from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import type {
  Branch,
  Commit,
  DesktopAPI,
  GitAction,
  PublishLayerChoice,
  PublishProgress,
  PullRequest,
  PushPreview,
  RepositorySnapshot,
  StackKind,
  StackPreview,
  SyncLayerState,
} from '../../../shared/types'
import { actionBlockReason, stashRemovalBlockReason } from '../../../shared/capabilities'
import { Button } from './ui/button'
import { Badge, type BadgeProps } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Select } from './ui/select'
import { Textarea } from './ui/textarea'
import { workflowAction, workflowActionLabel, type WorkflowActionInput } from './workflow-action'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import {
  BlockerList,
  OperationContext,
  OperationSteps,
  PhaseStatus,
  PublishProgressPanel,
  TypedConfirmation,
  ImmutableApproval,
  WarningNote,
  WorkflowActions,
  WorkflowFrame,
  WorkflowSection,
  OperationFacts,
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

const stackLabels = { restack: 'Restack', publish: 'Publish', merge: 'Merge pull request', sync: 'Sync' }


const SYNC_LAYER_LABELS: Record<SyncLayerState, string> = {
  merged: 'Merged',
  retargeted: 'Retargeted',
  'needs-force': 'Needs force-with-lease',
  'needs-rebase': 'Needs rebase',
  'needs-push': 'Needs push',
  'up-to-date': 'Up to date',
  blocked: 'Blocked',
}

const SYNC_LAYER_BADGE: Record<SyncLayerState, BadgeProps['variant']> = {
  merged: 'merged',
  retargeted: 'warning',
  'needs-force': 'warning',
  'needs-rebase': 'info',
  'needs-push': 'info',
  'up-to-date': 'success',
  blocked: 'danger',
}

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

function requestActionType(request: WorkflowRequest): GitAction['type'] {
  switch (request.kind) {
    case 'confirm':
      return request.action.type
    case 'rename':
      return 'renameBranch'
    case 'parent':
      return 'setParent'
    case 'upstream':
      return 'setUpstream'
    case 'deleteRemote':
      return 'deleteRemoteBranch'
    case 'commitAction':
      return request.mode
    case 'stack':
      return 'executeStack'
    case 'pr':
      return 'updatePr'
    case 'forcePush':
      return 'forcePush'
    default:
      return request.kind
  }
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

export type WorkflowStackAPI = Pick<
  DesktopAPI,
  'stackPreview' | 'submitStackProgress' | 'onSubmitStackProgress'
>

export function WorkflowDialog({
  request,
  snapshot,
  busy,
  actionError,
  onClearActionError,
  runAction,
  onClose,
  onRequest,
  stackApi = window.desktop,
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
  stackApi?: WorkflowStackAPI
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
  const [layerChoices, setLayerChoices] = React.useState<Record<string, PublishLayerChoice>>({})
  const [progress, setProgress] = React.useState<PublishProgress | null>(null)
  const [mergeMethod, setMergeMethod] = React.useState<'' | 'merge' | 'squash' | 'rebase'>('')
  const [preview, setPreview] = React.useState<StackPreview | null>(null)
  const [push, setPush] = React.useState<PushPreview | null>(null)
  const [pr, setPr] = React.useState<(PullRequest & { body: string }) | null>(null)
  const [prTitle, setPrTitle] = React.useState('')
  const [body, setBody] = React.useState('')
  const [prDraft, setPrDraft] = React.useState(true)
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
  const shapeReason =
    actionBlockReason(snapshot.capabilities, requestActionType(request)) ??
    (request.kind === 'confirm' &&
    (request.action.type === 'stashPop' || request.action.type === 'stashDrop')
      ? stashRemovalBlockReason(snapshot.capabilities)
      : null)
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
    stackApi: WorkflowStackAPI
    promise: Promise<WorkflowData>
  } | null>(null)

  React.useEffect(() => {
    let active = true
    setError(null)
    setIdentity(null)
    setLoading(previewKinds.includes(request.kind))
    setLoaded(false)
    if (
      initialLoad.current?.request !== request ||
      initialLoad.current.attempt !== attempt ||
      initialLoad.current.stackApi !== stackApi
    ) {
      const load = async (): Promise<WorkflowData> => {
        if (request.kind === 'stack') {
          return {
            kind: 'stack',
            value: await stackApi.stackPreview(request.operation, request.branch),
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
      initialLoad.current = { request, attempt, stackApi, promise: load() }
    }
    void initialLoad.current.promise.then(
      (data) => {
        if (!active) return
        setRejectedIdentities([])
        if (data.kind === 'stack') {
          setPreview(data.value)
          // Entered layer choices survive a preview reload; untouched layers are seeded
          // from the reviewed offer so title, body, draft and base start where Git Stacks
          // proposes them.
          setLayerChoices((current) =>
            Object.fromEntries(
              (data.value.publish?.layers ?? []).map((layer) => [
                layer.branch,
                current[layer.branch] ?? {
                  title: layer.title,
                  body: layer.body,
                  draft: layer.draft,
                  updateBase: layer.updateBase,
                },
              ]),
            ),
          )
        } else if (data.kind === 'forcePush') {
          setPush(data.value)
        } else if (data.kind === 'pr') {
          setPr(data.value)
          if (!hasEditedRef.current) {
            setPrTitle(data.value.title)
            setBody(data.value.body)
            setPrDraft(data.value.draft)
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
  }, [request, attempt, stackApi])

  // A submission that stopped part-way survives a restart; show it before anything
  // else so a person can resume or dismiss it instead of starting a second one.
  React.useEffect(() => {
    if (request.kind !== 'stack' || request.operation !== 'publish') {
      setProgress(null)
      return
    }
    let active = true
    // A running submission pushes its own progress. Reading it on a timer cannot work: that
    // read queues behind the action producing the steps, so it would only ever report the
    // state after the whole operation finished.
    const unsubscribe = stackApi.onSubmitStackProgress?.((value) => {
      if (active) setProgress(value)
    })
    void stackApi.submitStackProgress?.().then(
      (value) => active && setProgress(value),
      () => active && setProgress(null),
    )
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [request, stackApi])

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
                              : request.kind === 'stack' && request.operation === 'sync'
                                ? 'Fetch and prune the remotes, then replay this stack bottom-to-top onto the trunk it reports. Replayed layers are pushed under the exact remote tips named below, and a conflict pauses the stack for Continue or Abort.'
                                : 'Merge one bottom PR into the default branch. Then explicitly restack and publish the remaining branches. No automatic merges or queue enrollment.'

  const readProgress = async () => {
    if (request.kind !== 'stack' || request.operation !== 'publish') return
    try {
      setProgress((await stackApi.submitStackProgress?.()) ?? null)
    } catch {
      setProgress(null)
    }
  }

  const run = async (action: GitAction, label: string) => {
    if (
      locked ||
      captured.current.path !== snapshot.path ||
      shapeReason ||
      actionBlockReason(snapshot.capabilities, action.type)
    )
      return
    const attemptRun = dispatch(async () => {
      const success = await runAction(action, label)
      if (!success) {
        // A stopped submission is resumable, so read what it managed to finish
        // before deciding the reviewed preview may or may not run again.
        await readProgress()
        if (identity) {
          setRejectedIdentities((current) =>
            current.includes(identity) ? current : [...current, identity],
          )
        }
      }
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
          ? request.operation === 'publish'
            ? {
                kind: 'submit',
                preview,
                allowForce,
                layers: layerChoices,
                confirmation,
                confirmationTarget,
              }
            : {
                kind: 'stack',
                operation: request.operation,
                preview,
                allowForce,
                confirmation,
                confirmationTarget,
                mergeMethod,
              }
          : null
        : request.kind === 'pr'
          ? { kind: 'pr', number: request.number, title: prTitle, body, draft: prDraft }
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
    if (blocker || shapeReason || !actionInput) return
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
  const publishOffer = preview?.publish ?? null
  // A saved submission that stopped part-way is being recovered, not planned. Its choices are
  // the ones already journalled, so the fields show them and stay locked: Resume republishes
  // exactly those. Changing them means dismissing the submission and taking a fresh preview.
  const recovering =
    request.kind === 'stack' &&
    request.operation === 'publish' &&
    (progress?.status === 'failed' || progress?.status === 'running') &&
    (progress?.layers.length ?? 0) > 0
  const resumeBlocked = progress?.steps.find(
    (step) => step.status !== 'completed' && step.failure?.retryable === false,
  )?.failure
  // While a saved submission is being recovered the journalled choices win over the fresh
  // preview: Resume republishes exactly those, and the fields are locked to match. Without
  // this the dialog would show a different title or readiness than the one that will open.
  React.useEffect(() => {
    const saved = recovering ? (progress?.layers ?? []) : []
    if (saved.length === 0) return
    setLayerChoices((current) => ({
      ...current,
      ...Object.fromEntries(
        saved.map((layer) => [
          layer.branch,
          {
            title: layer.title,
            body: layer.body,
            draft: layer.draft,
            updateBase: layer.updateBase,
          },
        ]),
      ),
    }))
  }, [progress, recovering])
  const untitledBranches =
    request.kind === 'stack' && request.operation === 'publish' && publishOffer
      ? publishOffer.layers
          .filter((layer) => layer.create && !layerChoices[layer.branch]?.title.trim())
          .map((layer) => layer.branch)
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
    requiresLeaseApproval: (preview?.sync?.forcePushes.length ?? 0) > 0,
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
    blocked: Boolean(blocker || shapeReason) && !finished,
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
                ? (shapeReason ?? blocker?.message)
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

  const syncOffer = request.kind === 'stack' ? (preview?.sync ?? null) : null

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
              {/*
                A recovered submission is described by its journal, not by a fresh preview.
                Gating this whole region on the preview would hide the saved steps, the saved
                consent and the base changes the moment a fresh read fails, while Resume
                stayed enabled. The preview-dependent parts stay gated; the saved ones do not.
              */}
              {request.kind === 'stack' && (preview || recovering) ? (
                <>
                  {!preview ? (
                    <WarningNote>
                      This stack could not be re-read just now, so it shows no new preview. The
                      saved submission below is the operation Resume will run.
                    </WarningNote>
                  ) : null}
                  {!recovering ? (
                    <>
                      <OperationSteps
                        steps={stackSteps}
                        label="Planned stack operations"
                        emptyNote="This preview contains no steps to run."
                      />
                      {(preview?.warnings ?? []).map((warning, index) => (
                        <WarningNote key={`${index}-${warning}`}>{warning}</WarningNote>
                      ))}
                      {preview ? <BlockerList items={preview.blockers} /> : null}
                    </>
                  ) : null}
                  {syncOffer ? (
                    <>
                      <OperationContext
                        title={`Trunk ${syncOffer.trunk.branch}`}
                        description={`Fetched from ${syncOffer.trunk.remote} and compared with the local ${syncOffer.trunk.branch}. A sync never rewrites the trunk itself.`}
                        facts={[
                          {
                            label: 'Local trunk tip',
                            value: syncOffer.trunk.localOid?.slice(0, 12) ?? 'Unavailable',
                            code: true,
                          },
                          {
                            label: 'Fetched trunk tip',
                            value: syncOffer.trunk.remoteOid?.slice(0, 12) ?? 'Unavailable',
                            code: true,
                          },
                          {
                            label: 'Difference',
                            value: syncOffer.trunk.diverged
                              ? `Rewritten upstream: ${syncOffer.trunk.ahead} local commit(s) are not on ${syncOffer.trunk.remote}/${syncOffer.trunk.branch}`
                              : `${syncOffer.trunk.behind} behind, ${syncOffer.trunk.ahead} ahead`,
                          },
                        ]}
                      />
                      {syncOffer.layers.map((layer) => (
                        <WorkflowSection
                          key={`sync-${layer.branch}`}
                          label={`${layer.branch} → ${layer.base}`}
                        >
                          <div className="workflow-row">
                            <Badge variant={SYNC_LAYER_BADGE[layer.state]}>
                              {SYNC_LAYER_LABELS[layer.state]}
                            </Badge>
                            <span className="workflow-note">
                              {layer.pullRequest === null
                                ? 'No pull request'
                                : `#${layer.pullRequest}${
                                    layer.pullRequestBase
                                      ? ` targets ${layer.pullRequestBase}`
                                      : ''
                                  }`}
                            </span>
                          </div>
                          <p className="workflow-note">{layer.note}</p>
                          {layer.push === 'force' ? (
                            <OperationFacts
                              facts={[
                                {
                                  label: 'Lease',
                                  value: `origin/${layer.branch} at ${
                                    layer.remoteOid?.slice(0, 12) ?? 'absent'
                                  }`,
                                  code: true,
                                },
                              ]}
                            />
                          ) : null}
                          {layer.blockers.length > 0 ? (
                            <BlockerList items={layer.blockers} />
                          ) : null}
                        </WorkflowSection>
                      ))}
                      {syncOffer.forcePushes.length > 0 ? (
                        <>
                          <Checkbox
                            id="workflow-sync-lease"
                            label="Replace published history on the listed branches with exact leases"
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
                                Remote-only commits on {syncOffer.forcePushes.join(', ')} may be
                                replaced. Each push names the exact tip above as its lease, so a
                                changed remote stops the sync instead of overwriting it.
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
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {request.operation === 'publish' && (publishOffer || recovering) ? (
                    <>
                      <PublishProgressPanel progress={progress} />
                      {/*
                        A resumed submission republishes the consent it was given. An
                        unchecked box here would read as "not agreed" while Resume force
                        pushes under the recorded value, so the saved consent is shown as
                        fixed text and the control is only offered for a new submission.
                      */}
                      {recovering ? (
                        <ImmutableApproval
                          label="Saved approval for rewritten branches"
                          summary={
                            progress?.allowForce
                              ? 'Recorded: branches with a rewritten history are pushed with exact leases.'
                              : 'Not given: no branch is pushed by replacing remote history.'
                          }
                        />
                      ) : (
                        <>
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
                        </>
                      )}
                      {/*
                        A recovered submission describes the saved operation, not a fresh
                        preview of a repository that may since have moved. Rendering the
                        fresh offer here would label each section with a new base and pull
                        request identity while Resume executes the journalled ones.
                        */}
                      {(recovering ? (progress?.layers ?? []) : (publishOffer?.layers ?? [])).map(
                        (layer) => {
                          const choice = recovering ? layer : layerChoices[layer.branch]
                          const id = encodeURIComponent(layer.branch)
                          const setChoice = (update: Partial<PublishLayerChoice>) => {
                            markEdited()
                            setLayerChoices((current) => ({
                              ...current,
                              [layer.branch]: { ...current[layer.branch], ...update },
                            }))
                          }
                          return (
                            <WorkflowSection
                              key={`layer-${id}`}
                              label={`${layer.branch} → ${layer.base}`}
                            >
                              <p className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
                                {layer.create
                                  ? 'A new pull request is opened with the title, description and readiness chosen below.'
                                  : `Pull request #${
                                      layer.pullRequest ?? '?'
                                    } keeps its title, description and review; only its base can change.`}
                              </p>
                              {recovering ? (
                                layer.updateBase ? (
                                  <ImmutableApproval
                                    label={`Saved approval: change the base of pull request #${
                                      layer.pullRequest ?? '?'
                                    } to ${layer.base}`}
                                    summary="Recorded: this base change is applied when the submission resumes."
                                  />
                                ) : null
                              ) : (publishOffer?.baseChanges.includes(layer.branch) ?? false) ? (
                                <Checkbox
                                  id={`base-${id}`}
                                  label={`Change the base of pull request #${
                                    layer.pullRequest ?? '?'
                                  } to ${layer.base}`}
                                  checked={choice?.updateBase ?? false}
                                  onChange={(event) =>
                                    setChoice({ updateBase: event.target.checked })
                                  }
                                />
                              ) : null}
                              {/*
                              An existing pull request keeps the title, description, and review
                              state it already has. This submission does not rewrite them, so
                              there is nothing truthful to edit: the title is shown for reading
                              and the description is not shown at all, because this preview
                              never read the real one.
                            */}
                              <Field
                                id={`title-${id}`}
                                label={`PR title for ${layer.branch}`}
                                required
                              >
                                <Input
                                  readOnly={!layer.create || recovering}
                                  value={choice?.title ?? ''}
                                  onChange={(event) => setChoice({ title: event.target.value })}
                                />
                              </Field>
                              {layer.create ? (
                                <Field
                                  id={`body-${id}`}
                                  label={`PR description for ${layer.branch}`}
                                >
                                  <Textarea
                                    readOnly={recovering}
                                    value={choice?.body ?? ''}
                                    onChange={(event) => setChoice({ body: event.target.value })}
                                  />
                                </Field>
                              ) : null}
                              {layer.create ? (
                                <Checkbox
                                  id={`draft-${id}`}
                                  label={`Open the pull request for ${layer.branch} as a draft`}
                                  checked={choice?.draft ?? true}
                                  disabled={recovering}
                                  onChange={(event) => setChoice({ draft: event.target.checked })}
                                />
                              ) : null}
                            </WorkflowSection>
                          )
                        },
                      )}
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
                        {(preview?.mergeMethods ?? []).map((method) => (
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
                    checked={prDraft}
                    disabled={pr.state !== 'OPEN'}
                    onChange={(event) => {
                      markEdited()
                      setPrDraft(event.target.checked)
                    }}
                  />
                  {pr.state === 'OPEN' &&
                  localBranches.some(
                    (branch) => branch.name === pr.head && branch.pr?.number === pr.number,
                  ) ? (
                    <Button
                      tooltip={
                        actionBlockReason(snapshot.capabilities, 'executeStack') ??
                        'Check the PR’s current head, reviews, checks, and allowed merge methods before merging.'
                      }
                      disabled={Boolean(actionBlockReason(snapshot.capabilities, 'executeStack'))}
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
                              disabled={Boolean(
                                actionBlockReason(
                                  snapshot.capabilities,
                                  pr.state === 'OPEN' ? 'closePr' : 'reopenPr',
                                ),
                              )}
                              tooltip={
                                actionBlockReason(
                                  snapshot.capabilities,
                                  pr.state === 'OPEN' ? 'closePr' : 'reopenPr',
                                ) ??
                                (pr.state === 'OPEN'
                                  ? 'Close this PR without merging or deleting its branch. Unsaved edits are not applied.'
                                  : 'Reopen this PR on GitHub. Unsaved edits are not applied.')
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
                          disabled={Boolean(
                            actionBlockReason(
                              snapshot.capabilities,
                              pr.state === 'OPEN' ? 'closePr' : 'reopenPr',
                            ),
                          )}
                          onClick={() => setConfirmPrState(true)}
                          tooltip={
                            actionBlockReason(
                              snapshot.capabilities,
                              pr.state === 'OPEN' ? 'closePr' : 'reopenPr',
                            ) ??
                            (pr.state === 'OPEN'
                              ? 'Review closing this PR without merging. Its branch and commits will remain.'
                              : 'Review reopening this closed PR on GitHub.')
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
              ) : progress && progress.status !== 'completed' ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run({ type: 'submitStackDismiss' }, 'Dismiss submission')}
                    tooltip="Stop tracking this submission. Pushed branches and pull requests stay on GitHub; take a fresh preview to submit again."
                  >
                    Dismiss submission
                  </Button>
                  <Button
                    variant="accent"
                    disabled={busy || Boolean(resumeBlocked)}
                    loading={busy}
                    onClick={() => run({ type: 'submitStackRetry' }, 'Resume submission')}
                    tooltip={
                      resumeBlocked
                        ? `This submission cannot be resumed. ${resumeBlocked.recovery}`
                        : 'Continue from the first unfinished step. Finished pushes and pull requests are not repeated.'
                    }
                  >
                    {busy ? (
                      <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                    ) : null}
                    Resume submission
                  </Button>
                </>
              ) : (
                <Button
                  type="submit"
                  variant={destructive ? 'danger' : 'accent'}
                  disabled={Boolean(blocker || shapeReason)}
                  loading={busy}
                  tooltip={shapeReason ?? (blocker ? blocker.message : description)}
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
