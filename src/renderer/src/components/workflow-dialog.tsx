import * as React from 'react'
import { ExternalLink, GitBranch, LoaderCircle, TriangleAlert } from 'lucide-react'
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
import { Select } from './ui/select'
import { Textarea } from './ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

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

type WorkflowData =
  | { kind: 'stack'; value: StackPreview }
  | { kind: 'forcePush'; value: PushPreview }
  | { kind: 'pr'; value: PullRequest & { body: string } }
  | { kind: 'local' }

export function WorkflowDialog({
  request,
  snapshot,
  busy,
  actionError,
  runAction,
  onClose,
  onRequest,
}: {
  request: WorkflowRequest
  snapshot: RepositorySnapshot
  busy: boolean
  actionError: string | null
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
  const [loading, setLoading] = React.useState(['stack', 'forcePush', 'pr'].includes(request.kind))
  const [loaded, setLoaded] = React.useState(false)
  const [finished, setFinished] = React.useState(false)
  const [confirmPrState, setConfirmPrState] = React.useState(false)
  const captured = React.useRef({
    path: snapshot.path,
    head: snapshot.headOid,
    branch: snapshot.currentBranch,
  })
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const trigger = React.useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const locked = busy || loading
  const localBranches = snapshot.branches.filter((branch) => !branch.remote)
  const parentNames = localBranches.map((branch) => branch.name)
  if (
    !parentNames.includes(snapshot.defaultBranch) &&
    snapshot.branches.some(
      (branch) => branch.ref === `refs/remotes/origin/${snapshot.defaultBranch}`,
    )
  )
    parentNames.push(snapshot.defaultBranch)

  const initialLoad = React.useRef<{
    request: WorkflowRequest
    promise: Promise<WorkflowData>
  } | null>(null)

  React.useEffect(() => {
    let active = true
    setError(null)
    setLoading(['stack', 'forcePush', 'pr'].includes(request.kind))
    setLoaded(false)
    if (initialLoad.current?.request !== request) {
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
      initialLoad.current = { request, promise: load() }
    }
    void initialLoad.current.promise.then(
      (data) => {
        if (!active) return
        if (data.kind === 'stack') {
          setPreview(data.value)
          setTitles(Object.fromEntries(data.value.steps.map((step) => [step.branch, step.title])))
        } else if (data.kind === 'forcePush') {
          setPush(data.value)
        } else if (data.kind === 'pr') {
          setPr(data.value)
          setPrTitle(data.value.title)
          setBody(data.value.body)
          setDraft(data.value.draft)
        }
        setLoaded(true)
        setLoading(false)
      },
      (value) => {
        if (!active) return
        setError(workflowError(value))
        setLoading(false)
      },
    )
    return () => {
      active = false
    }
  }, [request])

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
    const success = await runAction(action, label)
    if (!success) return
    if (request.kind === 'stack' && request.operation !== 'publish') setFinished(true)
    else onClose()
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (disabled) return
    switch (request.kind) {
      case 'rename':
        return run(
          { type: 'renameBranch', ref: request.branch.ref, name: name.trim() },
          'Rename branch',
        )
      case 'deleteRemote':
        if (request.branch.oid && confirmation === request.branch.name)
          return run(
            {
              type: 'deleteRemoteBranch',
              ref: request.branch.ref,
              expectedOid: request.branch.oid,
            },
            'Delete remote branch',
          )
        return
      case 'parent':
        return run(
          { type: 'setParent', branch: request.branch.name, parent: name },
          'Set stack parent',
        )
      case 'upstream':
        return run(
          { type: 'setUpstream', ref: request.branch.ref, upstream: name || null },
          'Set upstream',
        )
      case 'pull':
        return run({ type: 'pull', strategy }, 'Pull changes')
      case 'merge':
        if (captured.current.head)
          return run(
            {
              type: 'merge',
              ref: name,
              expectedHead: captured.current.head,
              expectedHeadRef: captured.current.branch
                ? `refs/heads/${captured.current.branch}`
                : 'HEAD',
            },
            'Merge branch',
          )
        return
      case 'stash':
        return run({ type: 'stash', message: message.trim(), includeUntracked }, 'Stash changes')
      case 'forcePush':
        if (push && confirmation === push.branch)
          return run({ type: 'forcePush', preview: push }, 'Force push with lease')
        return
      case 'commitAction':
        if (captured.current.head)
          return run(
            {
              type: request.mode,
              oid: request.commit.oid,
              expectedHead: captured.current.head,
              expectedHeadRef: captured.current.branch
                ? `refs/heads/${captured.current.branch}`
                : 'HEAD',
              mainline: mainline ? Number(mainline) : null,
            },
            request.mode === 'cherryPick' ? 'Cherry-pick commit' : 'Revert commit',
          )
        return
      case 'confirm':
        return run(request.action, request.label)
      case 'pr':
        return run(
          { type: 'updatePr', number: request.number, title: prTitle.trim(), body, draft },
          'Update pull request',
        )
      case 'stack':
        if (preview && !preview.blockers.length)
          return run(
            {
              type: 'executeStack',
              token: preview.token,
              allowForce,
              draft,
              titles,
              mergeMethod: mergeMethod || 'squash',
            },
            `${stackLabels[request.operation]}${request.operation === 'merge' ? '' : ' stack'}`,
          )
        return
    }
  }

  const disabled =
    locked ||
    !loaded ||
    finished ||
    captured.current.path !== snapshot.path ||
    (['rename', 'parent', 'merge'].includes(request.kind) && !name.trim()) ||
    (request.kind === 'pr' && (!pr || !prTitle.trim() || pr.state === 'MERGED')) ||
    (request.kind === 'forcePush' && (!push || confirmation !== push.branch)) ||
    (request.kind === 'deleteRemote' &&
      (!request.branch.oid || confirmation !== request.branch.name)) ||
    (request.kind === 'commitAction' && request.commit.parents.length > 1 && !mainline) ||
    (request.kind === 'stack' &&
      (!preview ||
        preview.blockers.length > 0 ||
        (request.operation === 'merge' && !mergeMethod) ||
        (allowForce && confirmation !== request.branch) ||
        preview.steps.some(
          (step) => request.operation === 'publish' && !step.pr && !titles[step.branch]?.trim(),
        )))
  const actionLabel =
    request.kind === 'confirm'
      ? request.label
      : request.kind === 'stack'
        ? `${stackLabels[request.operation]}${request.operation === 'merge' ? '' : ' stack'}`
        : request.kind === 'pr'
          ? 'Save PR changes'
          : title
  const destructive =
    request.kind === 'forcePush' ||
    request.kind === 'deleteRemote' ||
    (request.kind === 'confirm' && request.destructive) ||
    (request.kind === 'stack' && request.operation === 'merge')

  const publicationRoots =
    finished && request.kind === 'stack' && request.operation === 'restack'
      ? (preview?.steps.filter(
          (step) => !preview.steps.some((candidate) => candidate.branch === step.parent),
        ) ?? [])
      : []

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className={`workflow-dialog ${request.kind === 'stack' ? 'stack-dialog' : ''}`}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelRef.current?.focus()
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
        <form className="dialog-form workflow-form" onSubmit={submit}>
          <fieldset disabled={locked || finished} className="workflow-fields">
            {loading ? (
              <p className="workflow-loading" role="status">
                <LoaderCircle className="size-4 animate-spin" />
                Reading current repository state…
              </p>
            ) : null}
            {request.kind === 'rename' ? (
              <>
                <label htmlFor="workflow-name">New branch name</label>
                <Input
                  id="workflow-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </>
            ) : null}
            {request.kind === 'deleteRemote' ? (
              <>
                <p className="workflow-warning">
                  Remote-only commits may become unreachable. This cannot be undone from the app.
                </p>
                <label htmlFor="workflow-confirm">Type {request.branch.name} to confirm</label>
                <Input
                  id="workflow-confirm"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="workflow-note">
                  Expected remote tip:{' '}
                  {request.branch.oid?.slice(0, 12) ?? 'Unavailable — fetch and try again'}
                </p>
              </>
            ) : null}
            {request.kind === 'parent' || request.kind === 'merge' ? (
              <>
                <label htmlFor="workflow-branch">
                  {request.kind === 'parent' ? 'Parent branch' : 'Branch to merge'}
                </label>
                <Select
                  id="workflow-branch"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
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
                {request.kind === 'parent' ? (
                  <p className="workflow-note">
                    The original boundary is retained so restacking does not replay the previous
                    parent’s commits.
                  </p>
                ) : null}
              </>
            ) : null}
            {request.kind === 'upstream' ? (
              <>
                <label htmlFor="workflow-upstream">Remote tracking branch</label>
                <Select
                  id="workflow-upstream"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
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
              </>
            ) : null}
            {request.kind === 'pull' ? (
              <>
                <label htmlFor="workflow-pull">Integration strategy</label>
                <Select
                  id="workflow-pull"
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value as typeof strategy)}
                >
                  <option value="ff-only">Fast-forward only</option>
                  <option value="merge">Merge upstream changes</option>
                  <option value="rebase">Rebase local commits onto upstream</option>
                </Select>
                {strategy === 'rebase' ? (
                  <p className="workflow-warning">
                    Rebase rewrites local commits. Restack dependent branches afterward.
                  </p>
                ) : null}
              </>
            ) : null}
            {request.kind === 'stash' ? (
              <>
                <label htmlFor="workflow-stash-message">
                  Message <span className="optional-label">optional</span>
                </label>
                <Input
                  id="workflow-stash-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Work to return to"
                />
                <Checkbox
                  id="workflow-include-untracked"
                  label="Include untracked files"
                  checked={includeUntracked}
                  onChange={(event) => setIncludeUntracked(event.target.checked)}
                />
              </>
            ) : null}
            {request.kind === 'forcePush' && push ? (
              <>
                <dl className="workflow-facts">
                  <dt>Destination</dt>
                  <dd>
                    {push.remote}/{push.destination.replace(/^refs\/heads\//, '')}
                  </dd>
                  <dt>Expected remote tip</dt>
                  <dd>
                    <code>{push.remoteOid?.slice(0, 12) ?? 'New branch'}</code>
                  </dd>
                  <dt>Local tip</dt>
                  <dd>
                    <code>{push.localOid.slice(0, 12)}</code>
                  </dd>
                </dl>
                <p className="workflow-warning">
                  Commits present only on the remote can become unreachable.
                </p>
                <label htmlFor="workflow-confirm">Type {push.branch} to confirm</label>
                <Input
                  id="workflow-confirm"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </>
            ) : null}
            {request.kind === 'commitAction' && request.commit.parents.length > 1 ? (
              <>
                <label htmlFor="workflow-mainline">Mainline parent for this merge commit</label>
                <Select
                  id="workflow-mainline"
                  value={mainline}
                  onChange={(event) => setMainline(event.target.value)}
                >
                  <option value="">Choose the parent whose changes to keep</option>
                  {request.commit.parents.map((oid, index) => (
                    <option key={oid} value={index + 1}>
                      Parent {index + 1}: {oid.slice(0, 12)}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}
            {request.kind === 'stack' && preview ? (
              <>
                <ol className="stack-preview-list" aria-label="Planned stack operations">
                  {preview.steps
                    .filter(
                      (step) => request.operation !== 'merge' || step.branch === request.branch,
                    )
                    .map((step) => (
                      <li key={step.branch}>
                        <GitBranch className="size-4" />
                        <div>
                          <strong>{step.branch}</strong>
                          <span>
                            into {step.parent} · {step.commits} commit
                            {step.commits === 1 ? '' : 's'}
                            {step.pr ? ` · #${step.pr.number}` : ''}
                          </span>
                          {step.note && request.operation !== 'merge' ? <p>{step.note}</p> : null}
                          {request.operation === 'publish' && !step.pr ? (
                            <>
                              <label htmlFor={`title-${encodeURIComponent(step.branch)}`}>
                                PR title
                              </label>
                              <Input
                                id={`title-${encodeURIComponent(step.branch)}`}
                                value={titles[step.branch] ?? ''}
                                onChange={(event) =>
                                  setTitles((current) => ({
                                    ...current,
                                    [step.branch]: event.target.value,
                                  }))
                                }
                              />
                            </>
                          ) : null}
                        </div>
                        {step.pr ? (
                          <Badge variant={step.pr.state === 'MERGED' ? 'accent' : 'secondary'}>
                            {step.pr.draft ? 'draft' : step.pr.state.toLowerCase()}
                          </Badge>
                        ) : null}
                      </li>
                    ))}
                </ol>
                {preview.warnings.map((warning, index) => (
                  <p className="workflow-warning" key={index}>
                    <TriangleAlert className="size-4" />
                    {warning}
                  </p>
                ))}
                {preview.blockers.length ? (
                  <div className="workflow-blockers" role="alert">
                    <strong>Resolve before continuing</strong>
                    <ul>
                      {preview.blockers.map((blocker, index) => (
                        <li key={index}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {request.operation === 'publish' ? (
                  <>
                    <Checkbox
                      id="workflow-create-drafts"
                      label="Create new PRs as drafts"
                      checked={draft}
                      onChange={(event) => setDraft(event.target.checked)}
                    />
                    <Checkbox
                      id="workflow-allow-force"
                      label="Allow rewritten branches to be pushed with exact leases"
                      checked={allowForce}
                      onChange={(event) => {
                        setAllowForce(event.target.checked)
                        setConfirmation('')
                      }}
                    />
                    {allowForce ? (
                      <>
                        <p className="workflow-warning">
                          Remote-only commits may be replaced. A changed remote tip stops the push.
                        </p>
                        <label htmlFor="workflow-confirm">Type {request.branch} to confirm</label>
                        <Input
                          id="workflow-confirm"
                          value={confirmation}
                          onChange={(event) => setConfirmation(event.target.value)}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </>
                    ) : null}
                  </>
                ) : null}
                {request.operation === 'merge' ? (
                  <>
                    <label htmlFor="workflow-merge-method">Merge method</label>
                    <Select
                      id="workflow-merge-method"
                      value={mergeMethod}
                      onChange={(event) => setMergeMethod(event.target.value as typeof mergeMethod)}
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
                  </>
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
                    <ExternalLink className="size-3.5" />
                    GitHub
                  </Button>
                </div>
                <p className="workflow-note">
                  Checks: {pr.checks} · Reviews:{' '}
                  {pr.reviewDecision?.replaceAll('_', ' ').toLowerCase() || 'No decision'} · Merge
                  state: {pr.mergeState?.replaceAll('_', ' ').toLowerCase() || 'Unknown'}
                </p>
                <label htmlFor="workflow-pr-title">Title</label>
                <Input
                  id="workflow-pr-title"
                  value={prTitle}
                  disabled={pr.state === 'MERGED'}
                  onChange={(event) => setPrTitle(event.target.value)}
                />
                <label htmlFor="workflow-pr-body">Description</label>
                <Textarea
                  id="workflow-pr-body"
                  rows={6}
                  disabled={pr.state === 'MERGED'}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                />
                <Checkbox
                  id="workflow-pr-draft"
                  label="Draft pull request"
                  checked={draft}
                  disabled={pr.state !== 'OPEN'}
                  onChange={(event) => setDraft(event.target.checked)}
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
                        <p className="workflow-warning">
                          {pr.state === 'OPEN'
                            ? 'Close this PR without merging? Its branch and commits remain. Unsaved form edits are not applied.'
                            : 'Reopen this pull request? Unsaved form edits will not be applied.'}
                        </p>
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
                                pr.state === 'OPEN' ? 'Close pull request' : 'Reopen pull request',
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
          {error || actionError ? (
            <p className="form-error" role="alert">
              {error || actionError}
            </p>
          ) : null}
          {!loading &&
          (error || actionError) &&
          ['stack', 'forcePush', 'pr'].includes(request.kind) ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => onRequest(request)}
              tooltip="Read the latest repository and GitHub state to replace this preview. No Git changes are made."
            >
              Reload preview
            </Button>
          ) : null}
          {finished && request.kind === 'stack' ? (
            <div className="workflow-complete" role="status">
              <strong>
                {request.operation === 'merge' ? 'Pull request merged' : 'Local stack updated'}
              </strong>
              <p>
                {request.operation === 'merge'
                  ? 'Restack the remaining branches onto the updated base, then publish to update their pull requests.'
                  : 'Publish next to update remote branches and PR bases. Rewritten branches require your explicit force-with-lease approval.'}
              </p>
            </div>
          ) : null}
          <DialogFooter>
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
                disabled={disabled}
                tooltip={description}
              >
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {actionLabel}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
