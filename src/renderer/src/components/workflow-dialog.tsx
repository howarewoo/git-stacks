import * as React from 'react'
import { useForm, useSelector } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Link2, LoaderCircle, Search, Trash2 } from 'lucide-react'
import type {
  Branch,
  Commit,
  DesktopAPI,
  GitAction,
  MergeAction,
  MergeLayerResult,
  MergeProgress,
  PublishLayerChoice,
  PublishProgress,
  PullRequest,
  PushPreview,
  RepositorySnapshot,
  StackKind,
  StackPreview,
  SurgeryLayerAction,
  SurgeryPreview,
  SurgeryRequest,
  SyncLayerState,
  IssueLinkPreview,
  IssueLinkRelation,
  LinkedIssue,
  RepositoryIssue,
} from '../../../shared/types'
import type { AppSettings } from '../../../shared/settings'
import { actionBlockReason, stashRemovalBlockReason } from '../../../shared/capabilities'
import { Button } from './ui/button'
import { InlineAlert } from './ui/surface'
import { Badge, type BadgeProps } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Select } from './ui/select'
import { Textarea } from './ui/textarea'
import {
  surgeryActionLabel,
  workflowAction,
  workflowActionLabel,
  type WorkflowActionInput,
} from './workflow-action'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import {
  BlockerList,
  MergeOutcomePanel,
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
  type WorkflowBlocker,
  type WorkflowComposition,
} from './workflow-policy'

export type RunAction = (action: GitAction, label: string) => Promise<boolean>
export type WorkflowRequest =
  | { kind: 'rename' | 'parent' | 'upstream'; branch: Branch }
  | { kind: 'pull' | 'merge' | 'stash' | 'forcePush' }
  | { kind: 'commitAction'; commit: Commit; mode: 'cherryPick' | 'revert' }
  | { kind: 'stack'; branch: string; operation: StackKind }
  | { kind: 'surgery'; request: SurgeryRequest }
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

const stackLabels = {
  restack: 'Restack',
  publish: 'Publish',
  merge: 'Merge pull request',
  sync: 'Sync',
}

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

const SURGERY_ACTION_LABELS: Record<SurgeryLayerAction, string> = {
  insert: 'New layer',
  rewrite: 'Replayed',
  retarget: 'Rebased onto a new parent',
  remove: 'Removed',
}

const SURGERY_ACTION_BADGE: Record<SurgeryLayerAction, BadgeProps['variant']> = {
  insert: 'info',
  rewrite: 'warning',
  retarget: 'warning',
  remove: 'danger',
}

const SURGERY_STACK_LABELS: Record<NonNullable<SurgeryPreview['nativeStack']>['action'], string> = {
  none: 'Native stack membership is unchanged',
  unstack: `Unstack the native stack, then register the pull requests in the new order`,
  'unstack-and-create': `Unstack the native stack, then register it again in the new order`,
}

/** Request kinds that read backend state before the action can be reviewed. */
const previewKinds: readonly string[] = ['stack', 'surgery', 'forcePush', 'pr']

/**
 * The surgery the person asked for, with a typed branch name folded in. An insert
 * is only reviewable once it names its branch, so the name is part of the request
 * the preview is read for.
 */
export function surgeryRequestFor(
  request: Extract<WorkflowRequest, { kind: 'surgery' }>,
  name: string,
): SurgeryRequest {
  return request.request.kind === 'insert'
    ? { ...request.request, name: name.trim() }
    : request.request
}

type WorkflowData =
  | { kind: 'stack'; value: StackPreview }
  | { kind: 'surgery'; value: SurgeryPreview }
  | { kind: 'forcePush'; value: PushPreview }
  | { kind: 'pr'; value: PullRequest & { body: string } }
  | { kind: 'local' }

/**
 * Everything the workflow dialog lets a person edit. One TanStack Form store owns
 * these values: the controls render from it, the domain rules read it, and the
 * dispatched payload is built from it.
 */
interface WorkflowFormValues {
  /** Branch name typed for a rename, parent, upstream, merge, or surgery insert. */
  name: string
  message: string
  includeUntracked: boolean
  strategy: 'ff-only' | 'merge' | 'rebase'
  mainline: string
  confirmation: string
  allowForce: boolean
  /** Per-branch publish choices, keyed by branch name. */
  layerChoices: Record<string, PublishLayerChoice>
  mergeMethod: '' | 'merge' | 'squash' | 'rebase'
  mergeAction: MergeAction
  closePullRequests: boolean
  prTitle: string
  body: string
  prDraft: boolean
}

/** The name a dialog opens with, taken from the request that opened it. */
function initialWorkflowName(request: WorkflowRequest, snapshot: RepositorySnapshot): string {
  if ('branch' in request) {
    if (typeof request.branch === 'string') return request.branch
    if (request.kind === 'rename') return request.branch.name
    if (request.kind === 'upstream') return request.branch.upstreamRef ?? ''
    return request.branch.parent ?? snapshot.defaultBranch
  }
  return request.kind === 'surgery' && request.request.kind === 'insert' ? request.request.name : ''
}

function workflowComposition(request: WorkflowRequest): WorkflowComposition {
  if (request.kind === 'confirm') return request.destructive ? 'destructive' : 'form'
  if (request.kind === 'forcePush') return 'destructive'
  if (request.kind === 'stack') return request.operation === 'merge' ? 'destructive' : 'reviewed'
  // Removing a layer deletes a local branch and can close its pull request; the other two
  // surgeries only rewrite the order.
  if (request.kind === 'surgery')
    return request.request.kind === 'remove' ? 'destructive' : 'reviewed'
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
    case 'commitAction':
      return request.mode
    case 'stack':
      return 'executeStack'
    case 'surgery':
      return 'executeSurgery'
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
  if (data.kind === 'surgery') return `surgery:${data.value.token}`
  if (data.kind === 'forcePush')
    return `lease:${data.value.remote}/${data.value.destination.replace(/^refs\/heads\//, '')}:${data.value.localOid}:${data.value.remoteOid ?? 'new'}`
  if (data.kind === 'pr') return `pr:${data.value.number}:${data.value.headOid ?? 'unknown'}`
  return null
}

export type WorkflowStackAPI = Pick<
  DesktopAPI,
  | 'stackPreview'
  | 'submitStackProgress'
  | 'onSubmitStackProgress'
  | 'onMergeProgress'
  | 'mergeStatus'
> &
  Partial<
    Pick<DesktopAPI, 'searchIssues' | 'pullRequestIssueLinks' | 'previewIssueLink' | 'pullRequest'>
  >

interface PrLinkedIssuesSectionProps {
  pr: PullRequest & { body: string }
  repositoryPath: string
  authority: string
  onPrUpdate: (updated: PullRequest & { body: string }) => void
  disabled: boolean
  hasFormEdits: boolean
  runAction: (action: GitAction, label: string) => Promise<boolean>
  stackApi: WorkflowStackAPI
  defaultBranch: string
  onMutationBusy: (busy: boolean) => void
  onBodyMutation: (preview: IssueLinkPreview) => void
}

function PrLinkedIssuesSection({
  pr,
  repositoryPath,
  authority,
  onPrUpdate,
  disabled,
  hasFormEdits,
  runAction,
  stackApi,
  defaultBranch,
  onMutationBusy,
  onBodyMutation,
}: PrLinkedIssuesSectionProps) {
  const queryClient = useQueryClient()
  const instance = React.useId()
  const scope = { repositoryPath, authority, instance }
  const [submittedQuery, setSubmittedQuery] = React.useState('')
  const linksQuery = useQuery({
    queryKey: ['workflow-issue-links', scope, pr.number],
    enabled: false,
    queryFn: async () => (await stackApi.pullRequestIssueLinks?.(pr.number)) ?? null,
  })
  const searchQuery = useQuery({
    queryKey: ['workflow-issue-search', scope, submittedQuery],
    enabled: false,
    queryFn: async () => (await stackApi.searchIssues?.(submittedQuery)) ?? null,
  })
  const [linkIssueNumber, setLinkIssueNumber] = React.useState<number | null>(null)
  const [unlinkIssueNumber, setUnlinkIssueNumber] = React.useState<number | null>(null)
  const linkKey = ['workflow-issue-link-preview', scope, pr.number, linkIssueNumber] as const
  const unlinkKey = ['workflow-issue-unlink-preview', scope, pr.number, unlinkIssueNumber] as const
  const linkQuery = useQuery<IssueLinkPreview | null>({ queryKey: linkKey, enabled: false })
  const unlinkQuery = useQuery<IssueLinkPreview | null>({ queryKey: unlinkKey, enabled: false })
  const links = linksQuery.data?.links ?? []
  const loading = linksQuery.isFetching
  // The issue search is its own form: it is submitted without nesting a second HTML
  // form inside the pull request form, and its query never enters the pull request
  // values the workflow submits.
  const search = useForm({
    defaultValues: { query: '' },
    onSubmit: async ({ value }) => {
      const query = value.query.trim()
      if (!query) {
        setSubmittedQuery('')
        return
      }
      setSubmittedQuery(query)
      try {
        await queryClient.fetchQuery({
          queryKey: ['workflow-issue-search', scope, query],
          staleTime: 0,
          queryFn: async () => (await stackApi.searchIssues?.(query)) ?? null,
        })
      } catch {
        // The query error is rendered below; no failed read may offer stale rows.
      }
    },
  })
  const query = useSelector(search.store, (state) => state.values.query)
  const searching = searchQuery.isFetching
  const searchResults =
    submittedQuery && !searchQuery.isError ? (searchQuery.data?.issues ?? []) : []
  const searchMessage = !submittedQuery
    ? null
    : searchQuery.isError
      ? 'Failed to search issues.'
      : (searchQuery.data?.message ??
        (searchQuery.data?.issues.length === 0
          ? 'No accessible issues found matching this query.'
          : null))
  const [pendingUnlink, setPendingUnlink] = React.useState<LinkedIssue | null>(null)
  const [pendingClosingLink, setPendingClosingLink] = React.useState<RepositoryIssue | null>(null)
  const linkPreview = linkQuery.data ?? null
  const unlinkPreview = unlinkQuery.data ?? null
  const [writing, setActionBusy] = React.useState(false)
  const actionBusy = writing || linkQuery.isFetching || unlinkQuery.isFetching
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null)
  const closingAvailable = pr.base === defaultBranch

  const loadLinks = React.useCallback(async () => {
    try {
      await linksQuery.refetch({ throwOnError: true })
    } catch {
      queryClient.setQueryData(['workflow-issue-links', scope, pr.number], null)
    }
  }, [pr.number, stackApi, linksQuery.refetch, authority])

  const previewLink = React.useCallback(
    async (issue: RepositoryIssue): Promise<IssueLinkPreview | null> => {
      setLinkIssueNumber(issue.number)
      const key = ['workflow-issue-link-preview', scope, pr.number, issue.number] as const
      try {
        const preview = await queryClient.fetchQuery({
          queryKey: key,
          staleTime: 0,
          queryFn: async () =>
            (await stackApi.previewIssueLink?.(pr.number, issue.number, 'closing', 'link')) ?? null,
        })
        return preview
      } catch {
        queryClient.setQueryData(key, null)
        setStatusMessage(
          'Could not read the pull request description, so the change cannot be previewed. Reload and try again.',
        )
        return null
      }
    },
    [pr.number, stackApi, repositoryPath, authority, queryClient, instance],
  )

  const previewUnlink = React.useCallback(
    async (issue: LinkedIssue): Promise<IssueLinkPreview | null> => {
      setUnlinkIssueNumber(issue.number)
      const key = ['workflow-issue-unlink-preview', scope, pr.number, issue.number] as const
      try {
        const preview = await queryClient.fetchQuery({
          queryKey: key,
          staleTime: 0,
          queryFn: async () =>
            (await stackApi.previewIssueLink?.(pr.number, issue.number, 'closing', 'unlink')) ??
            null,
        })
        return preview
      } catch {
        queryClient.setQueryData(key, null)
        setStatusMessage(
          'Could not read the pull request description, so the change cannot be previewed. Reload and try again.',
        )
        return null
      }
    },
    [pr.number, stackApi, repositoryPath, authority, queryClient, instance],
  )

  React.useEffect(() => {
    void loadLinks()
  }, [loadLinks])

  const handleLinkContextual = async (issue: RepositoryIssue) => {
    setActionBusy(true)
    setStatusMessage(null)
    try {
      const ok = await runAction(
        {
          type: 'linkIssue',
          prNumber: pr.number,
          issueNumber: issue.number,
          relation: 'contextual',
        },
        `Link issue #${issue.number} as related`,
      )
      if (ok) {
        await loadLinks()
      }
    } finally {
      setActionBusy(false)
    }
  }

  const handleConfirmCloseWhenMerged = async (issue: RepositoryIssue) => {
    if (!linkPreview || linkPreview.prNumber !== pr.number || linkPreview.action !== 'link') return
    setActionBusy(true)
    onMutationBusy(true)
    setStatusMessage(null)
    try {
      const ok = await runAction(
        {
          type: 'linkIssue',
          prNumber: pr.number,
          issueNumber: issue.number,
          relation: 'closing',
          // Revalidate against the exact body the user previewed and confirmed.
          expectedBody: linkPreview.currentBody,
        },
        `Add closing link for issue #${issue.number}`,
      )
      if (ok) {
        setPendingClosingLink(null)
        onBodyMutation(linkPreview)
        if (stackApi.pullRequest) {
          try {
            onPrUpdate(
              await queryClient.fetchQuery({
                queryKey: ['workflow-pr', scope, pr.number],
                staleTime: 0,
                queryFn: () => stackApi.pullRequest!(pr.number),
              }),
            )
          } catch {
            setStatusMessage(
              'Closing link saved, but the latest pull request could not be read. Reload before editing more links.',
            )
          }
        }
        await loadLinks()
      }
    } finally {
      setActionBusy(false)
      onMutationBusy(false)
    }
  }

  const handleRequestClosingLink = async (issue: RepositoryIssue) => {
    // No preview, no confirmation: the write must never proceed unseen.
    if (!(await previewLink(issue))) return
    setPendingClosingLink(issue)
  }

  const handleUnlink = async (issue: LinkedIssue) => {
    if (issue.relation === 'closing') {
      if (!(await previewUnlink(issue))) return
      setPendingUnlink(issue)
      return
    }
    setActionBusy(true)
    setStatusMessage(null)
    try {
      const ok = await runAction(
        {
          type: 'unlinkIssue',
          prNumber: pr.number,
          issueNumber: issue.number,
          relation: 'contextual',
        },
        `Remove local link to issue #${issue.number}`,
      )
      if (ok) {
        await loadLinks()
      }
    } finally {
      setActionBusy(false)
    }
  }

  const handleConfirmUnlinkClosing = async (issue: LinkedIssue) => {
    if (
      !unlinkPreview ||
      unlinkPreview.prNumber !== pr.number ||
      unlinkPreview.action !== 'unlink'
    ) {
      return
    }
    setActionBusy(true)
    onMutationBusy(true)
    setStatusMessage(null)
    try {
      const ok = await runAction(
        {
          type: 'unlinkIssue',
          prNumber: pr.number,
          issueNumber: issue.number,
          relation: 'closing',
          // Revalidate against the exact body shown in the removal preview.
          expectedBody: unlinkPreview.currentBody,
        },
        `Remove closing reference for issue #${issue.number}`,
      )
      if (ok) {
        setPendingUnlink(null)
        onBodyMutation(unlinkPreview)
        if (stackApi.pullRequest) {
          try {
            onPrUpdate(
              await queryClient.fetchQuery({
                queryKey: ['workflow-pr', scope, pr.number],
                staleTime: 0,
                queryFn: () => stackApi.pullRequest!(pr.number),
              }),
            )
          } catch {
            setStatusMessage(
              'Closing link removed, but the latest pull request could not be read. Reload before editing more links.',
            )
          }
        }
        await loadLinks()
      }
    } finally {
      setActionBusy(false)
      onMutationBusy(false)
    }
  }

  const linkedNumbers = new Set(links.map((l) => l.number))

  return (
    <div className="workflow-section border-t border-[var(--gs-semantic-border-subtle)] pt-3 mt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Link2 className="size-4 text-[var(--gs-semantic-text-secondary)]" />
          <strong className="text-sm font-semibold">Linked issues</strong>
          {links.length > 0 ? <Badge variant="secondary">{links.length}</Badge> : null}
        </div>
        {loading ? (
          <span className="text-xs text-[var(--gs-semantic-text-muted)] flex items-center gap-1">
            <LoaderCircle className="size-3 animate-spin" /> Loading…
          </span>
        ) : null}
      </div>

      {statusMessage || linksQuery.data?.message ? (
        <p className="text-xs text-[var(--gs-semantic-text-secondary)] mb-2">
          {statusMessage ?? linksQuery.data?.message}
        </p>
      ) : null}
      {!closingAvailable ? (
        <p className="text-xs text-[var(--gs-semantic-text-secondary)] mb-2">
          Closing keywords only close issues on pull requests targeting {defaultBranch}. This pull
          request targets {pr.base}; use a related link instead.
        </p>
      ) : null}

      {links.length > 0 ? (
        <div className="flex flex-col gap-1.5 mb-3">
          {links.map((link) => (
            <div
              key={link.number}
              className="flex items-center justify-between gap-2 p-2 rounded bg-[var(--gs-semantic-surface-raised)] border border-[var(--gs-semantic-border-subtle)] text-xs"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Badge variant={link.state === 'OPEN' ? 'success' : 'secondary'}>
                  {link.state.toLowerCase()}
                </Badge>
                <Badge variant={link.relation === 'closing' ? 'accent' : 'outline'}>
                  {link.relation === 'closing' ? 'closes on merge' : 'related'}
                </Badge>
                <span className="font-medium truncate" title={link.title}>
                  #{link.number} {link.title}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || actionBusy}
                aria-label={`Remove link to issue #${link.number} from this pull request`}
                tooltip={`Remove ${link.relation === 'closing' ? 'closing keyword from PR description' : 'local related link'}`}
                onClick={() => void handleUnlink(link)}
              >
                <Trash2 className="size-3 text-[var(--gs-semantic-text-muted)] hover:text-[var(--gs-semantic-color-danger-fg)]" />
              </Button>
            </div>
          ))}
        </div>
      ) : !loading ? (
        <p className="text-xs text-[var(--gs-semantic-text-muted)] mb-3">
          No issues linked to this pull request.
        </p>
      ) : null}

      {pendingUnlink ? (
        <div className="p-3 mb-3 rounded bg-[var(--gs-semantic-surface-raised)] border border-[var(--gs-semantic-border-essential)] text-xs">
          <p className="font-medium text-[var(--gs-semantic-text-primary)] mb-1">
            Remove closing reference for issue #{pendingUnlink.number}?
          </p>
          <p className="text-[var(--gs-semantic-text-secondary)] mb-2">
            This will update the pull request description to remove{' '}
            <code className="px-1 py-0.5 rounded bg-[var(--gs-semantic-surface-sunken)]">
              {unlinkPreview?.closingSyntax ?? `Closes #${pendingUnlink.number}`}
            </code>
            .
          </p>
          {unlinkPreview?.changed ? (
            <pre className="p-2 mb-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[var(--gs-semantic-surface-sunken)] text-[var(--gs-semantic-text-secondary)]">
              {unlinkPreview.newBody}
            </pre>
          ) : null}
          {hasFormEdits ? (
            <div className="p-2 mb-2 rounded bg-[var(--gs-semantic-surface-sunken)] text-[var(--gs-semantic-color-warning-fg)] text-xs">
              You have unsaved edits in the pull request description above. Save your description
              before removing closing issue links.
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={actionBusy}
              onClick={() => setPendingUnlink(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={disabled || actionBusy || hasFormEdits}
              onClick={() => handleConfirmUnlinkClosing(pendingUnlink)}
            >
              {actionBusy ? (
                <>
                  <LoaderCircle className="size-3 animate-spin mr-1" />
                  Removing…
                </>
              ) : (
                'Confirm removal'
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {pendingClosingLink ? (
        <div className="p-3 mb-3 rounded bg-[var(--gs-semantic-surface-raised)] border border-[var(--gs-semantic-border-essential)] text-xs">
          <p className="font-medium text-[var(--gs-semantic-text-primary)] mb-1">
            Close #{pendingClosingLink.number} when pull request is merged?
          </p>
          <p className="text-[var(--gs-semantic-text-secondary)] mb-2">
            This will append{' '}
            <code className="px-1 py-0.5 rounded bg-[var(--gs-semantic-surface-sunken)]">
              {linkPreview?.closingSyntax ?? `Closes #${pendingClosingLink.number}`}
            </code>{' '}
            to the pull request description on GitHub.
          </p>
          {linkPreview?.changed ? (
            <pre className="p-2 mb-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[var(--gs-semantic-surface-sunken)] text-[var(--gs-semantic-text-secondary)]">
              {linkPreview.newBody}
            </pre>
          ) : null}
          {hasFormEdits ? (
            <div className="p-2 mb-2 rounded bg-[var(--gs-semantic-surface-sunken)] text-[var(--gs-semantic-color-warning-fg)] text-xs">
              You have unsaved edits in the pull request description above. Save your description
              before adding closing issue links.
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={actionBusy}
              onClick={() => setPendingClosingLink(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="accent"
              disabled={disabled || actionBusy || hasFormEdits}
              onClick={() => handleConfirmCloseWhenMerged(pendingClosingLink)}
            >
              {actionBusy ? (
                <>
                  <LoaderCircle className="size-3 animate-spin mr-1" />
                  Updating PR…
                </>
              ) : (
                'Confirm close when merged'
              )}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <span className="text-xs font-medium text-[var(--gs-semantic-text-secondary)]">
          Search and link issues
        </span>
        <div className="flex items-center gap-2">
          <search.Field name="query">
            {(field) => (
              <Input
                value={field.state.value}
                placeholder="Search issues by number or title…"
                disabled={disabled || actionBusy}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                onKeyDown={(event) => {
                  // Enter runs this form's search instead of submitting the pull
                  // request form the dialog is wrapped in.
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    void search.handleSubmit()
                  }
                }}
              />
            )}
          </search.Field>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || searching || actionBusy || !query.trim()}
            onClick={() => void search.handleSubmit()}
          >
            {searching ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            Search
          </Button>
        </div>

        {searchMessage ? (
          <p className="text-xs text-[var(--gs-semantic-text-muted)] m-0">{searchMessage}</p>
        ) : null}

        {searchResults.length > 0 ? (
          <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto p-1.5 rounded border border-[var(--gs-semantic-border-subtle)] bg-[var(--gs-semantic-surface-sunken)]">
            {searchResults.map((issue) => {
              const isAlreadyLinked = linkedNumbers.has(issue.number)
              return (
                <div
                  key={issue.number}
                  className="flex items-center justify-between gap-2 p-1.5 rounded bg-[var(--gs-semantic-surface-raised)] border border-[var(--gs-semantic-border-subtle)] text-xs"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Badge variant={issue.state === 'OPEN' ? 'success' : 'secondary'}>
                      {issue.state?.toLowerCase() ?? 'open'}
                    </Badge>
                    <span className="font-medium truncate" title={issue.title}>
                      #{issue.number} {issue.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isAlreadyLinked ? (
                      <Badge variant="outline">Linked</Badge>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disabled || actionBusy}
                          tooltip="Link locally as related without modifying the pull request description"
                          onClick={() => handleLinkContextual(issue)}
                        >
                          Link related
                        </Button>
                        {closingAvailable ? (
                          <Button
                            size="sm"
                            variant="accent"
                            disabled={disabled || actionBusy}
                            tooltip="Insert closing keyword into PR description to close this issue when PR is merged"
                            onClick={() => void handleRequestClosingLink(issue)}
                          >
                            Close when merged
                          </Button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function WorkflowDialog({
  request,
  snapshot,
  authority,
  busy,
  actionError,
  onClearActionError,
  runAction,
  onClose,
  onRequest,
  stackApi = window.desktop,
  defaults,
}: {
  request: WorkflowRequest
  snapshot: RepositorySnapshot
  authority: string
  busy: boolean
  actionError: string | null
  /** Retires the previous attempt's failure when a fresh preview is read. */
  onClearActionError: () => void
  runAction: RunAction
  onClose: () => void
  onRequest: (request: WorkflowRequest) => void
  stackApi?: WorkflowStackAPI
  /** Stored defaults, used to seed the pull strategy and merge method. */
  defaults?: AppSettings | null
}) {
  // TanStack Form owns every editable value in this dialog. The state declared below
  // it is domain state: reviewed previews, progress, recovery and dispatch identity.
  //
  // The defaults are captured once, when the dialog opens. TanStack re-applies
  // `defaultValues` whenever they change while the form is untouched, so recomputing
  // them per render could overwrite a value a preview, a recovery journal or a read
  // pull request seeded after opening.
  const [initialValues] = React.useState<WorkflowFormValues>(() => ({
    name: initialWorkflowName(request, snapshot),
    message: '',
    includeUntracked: true,
    // Seeded from the app's stored defaults; the person can still change either
    // before the operation runs.
    strategy: defaults?.git.defaultPullStrategy ?? 'ff-only',
    mainline: '',
    confirmation: '',
    allowForce: false,
    layerChoices: {},
    mergeMethod: defaults?.git.defaultMergeMethod ?? '',
    mergeAction: 'default',
    closePullRequests: false,
    prTitle: '',
    body: '',
    prDraft: true,
  }))
  const form = useForm({
    defaultValues: initialValues,
    onSubmit: async ({ value }) => {
      // Submission re-reads the same domain rules that gate the button, so a
      // programmatic or stale submit cannot dispatch an action the reviewed preview
      // forbids.
      const input = actionInputFor(value)
      if (guardFor(value) || shapeReason || !input) return
      const action = workflowAction(input, {
        headOid: captured.current.head,
        currentBranch: captured.current.branch,
      })
      if (!action) return
      await run(action, workflowActionLabel(input))
    },
  })
  const values = useSelector(form.store, (state) => state.values)
  const formSubmitting = useSelector(form.store, (state) => state.isSubmitting)
  const queryClient = useQueryClient()
  const instance = React.useId()
  const queryScope = React.useMemo(() => ({ instance, authority }), [instance, authority])
  const progressKey = ['workflow-publication-progress', snapshot.path, queryScope] as const
  const mergeProgressKey = ['workflow-merge-progress', snapshot.path, queryScope] as const
  const mergeStatusKey = ['workflow-merge-status', snapshot.path, queryScope] as const
  const progressQuery = useQuery({
    queryKey: progressKey,
    enabled: false,
    queryFn: async () => (await stackApi.submitStackProgress?.()) ?? null,
  })
  const mergeProgressQuery = useQuery<MergeProgress | null>({
    queryKey: mergeProgressKey,
    enabled: false,
  })
  const mergeStatusQuery = useQuery({
    queryKey: mergeStatusKey,
    enabled: false,
    queryFn: () => stackApi.mergeStatus!(),
  })
  const progress = progressQuery.data ?? null
  const mergeProgress = mergeProgressQuery.data ?? null
  const mergeStatus = mergeStatusQuery.data ?? null
  const setProgress = (value: PublishProgress | null) =>
    queryClient.setQueryData(progressKey, value)
  const mergeStatusError = mergeStatusQuery.error ? workflowError(mergeStatusQuery.error) : null
  const [mergeRunning, setMergeRunning] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const previewKey = ['workflow-preview', snapshot.path, queryScope, request, attempt] as const
  const previewQuery = useQuery<WorkflowData>({ queryKey: previewKey, enabled: false })
  const preview = previewQuery.data?.kind === 'stack' ? previewQuery.data.value : null
  const surgery = previewQuery.data?.kind === 'surgery' ? previewQuery.data.value : null
  const push = previewQuery.data?.kind === 'forcePush' ? previewQuery.data.value : null
  const pr = previewQuery.data?.kind === 'pr' ? previewQuery.data.value : null
  const externalMutation = useMutation({
    mutationFn: (url: string) => window.desktop.openExternal(url),
  })
  const [issueMutationBusy, setIssueMutationBusy] = React.useState(false)
  const [localError, setError] = React.useState<string | null>(null)
  const error = localError ?? (previewQuery.error ? workflowError(previewQuery.error) : null)
  const loading =
    previewKinds.includes(request.kind) && (previewQuery.isPending || previewQuery.isFetching)
  const loaded = previewQuery.isSuccess
  const [finished, setFinished] = React.useState(false)
  const [confirmPrState, setConfirmPrState] = React.useState(false)
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
  // What the domain itself holds still: a run in flight, a read still landing, or a
  // pull request link being written.
  const dispatchLocked = busy || loading || issueMutationBusy
  // What the controls hold still. A form that is submitting is locked too, so the
  // review cannot be edited underneath the action it just started.
  const locked = dispatchLocked || formSubmitting
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

  React.useEffect(() => {
    let active = true
    // Read from the store rather than a render snapshot: the insert preview is always
    // the one for the branch name actually written.
    const requestedName =
      request.kind === 'surgery' && request.request.kind === 'insert'
        ? form.getFieldValue('name')
        : null
    setError(null)
    setIdentity(null)
    const load = async (): Promise<WorkflowData> => {
      if (request.kind === 'stack') {
        return {
          kind: 'stack',
          value: await stackApi.stackPreview(request.operation, request.branch),
        }
      }
      if (request.kind === 'surgery') {
        return {
          kind: 'surgery',
          value: await window.desktop.surgeryPreview(
            surgeryRequestFor(request, requestedName ?? ''),
          ),
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
    void queryClient.fetchQuery({ queryKey: previewKey, queryFn: load, staleTime: 0 }).then(
      (data) => {
        if (!active) return
        setRejectedIdentities([])
        if (data.kind === 'stack') {
          // Entered layer choices survive a preview reload; untouched layers are seeded
          // from the reviewed offer so title, body, draft and base start where Git Stacks
          // proposes them.
          form.setFieldValue('layerChoices', (current) =>
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
        } else if (data.kind === 'surgery') {
          if (requestedName !== null && requestedName !== form.getFieldValue('name'))
            queryClient.setQueryData(previewKey, { kind: 'local' })
        } else if (data.kind === 'pr') {
          if (!hasEditedRef.current) {
            form.setFieldValue('prTitle', data.value.title)
            form.setFieldValue('body', data.value.body)
            form.setFieldValue('prDraft', data.value.draft)
          }
        }
        setIdentity(
          data.kind === 'surgery' &&
            requestedName !== null &&
            requestedName !== form.getFieldValue('name')
            ? null
            : previewIdentity(data),
        )
      },
      () => {
        if (!active) return
        setIdentity(null)
      },
    )
    return () => {
      active = false
    }
  }, [request, attempt, stackApi, queryScope])

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
      if (active) {
        void queryClient.cancelQueries({ queryKey: progressKey }).then(() => {
          if (active) queryClient.setQueryData(progressKey, value)
        })
      }
    })
    void progressQuery.refetch({ throwOnError: true }).then(
      () => undefined,
      () => active && setProgress(null),
    )
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [request, stackApi, queryScope])

  // A merge waits on GitHub's background result, so the running state is pushed rather than
  // polled: a read would queue behind the merge that is producing it.
  React.useEffect(() => {
    if (request.kind !== 'stack' || request.operation !== 'merge') {
      queryClient.setQueryData(mergeProgressKey, null)
      return
    }
    const unsubscribe = stackApi.onMergeProgress?.((value) =>
      queryClient.setQueryData(mergeProgressKey, value),
    )
    return () => {
      unsubscribe?.()
    }
  }, [request, stackApi, queryScope])

  // What GitHub reported for earlier merge requests is read, never re-requested: a queue that
  // later merged or dropped a pull request, or a request that is still running, is only
  // visible through a read. Reopening the dialog reads it again, so a refresh replaces what
  // the previous run left behind without another merge.
  const readMergeStatus = React.useCallback(async () => {
    if (!stackApi.mergeStatus) return
    try {
      await mergeStatusQuery.refetch({ throwOnError: true })
    } catch {
      // The last result GitHub reported is kept: a failed read is not evidence that the
      // request or the queue changed.
    }
  }, [stackApi, mergeStatusQuery.refetch, queryScope])
  React.useEffect(() => {
    if (request.kind !== 'stack' || request.operation !== 'merge') {
      queryClient.setQueryData(mergeStatusKey, null)
      void queryClient.resetQueries({ queryKey: mergeStatusKey })
      return
    }
    void readMergeStatus()
    // A run that ends is read again: its result is what GitHub published, and a read is
    // newer than the progress that run pushed.
  }, [request, readMergeStatus, mergeProgress, mergeRunning])

  const title =
    request.kind === 'surgery'
      ? surgeryActionLabel(request.request.kind)
      : request.kind === 'stack'
        ? `${stackLabels[request.operation]}${request.operation === 'merge' ? '' : ' stack'}`
        : request.kind === 'confirm'
          ? request.title
          : request.kind === 'commitAction'
            ? `${request.mode === 'cherryPick' ? 'Cherry-pick' : 'Revert'} commit`
            : (
                {
                  rename: 'Rename local branch',
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
    request.kind === 'surgery'
      ? request.request.kind === 'insert'
        ? `Create ${request.request.name} on ${request.request.branch} and replay the layers above it onto the new parent.`
        : request.request.kind === 'move'
          ? `Reparent ${request.request.branch} onto ${request.request.target} and replay the layers above it.`
          : `Delete the local branch ${request.request.branch} and replay the layers above it onto its parent. Its recovery ref keeps the commits until this surgery finishes.`
      : request.kind === 'confirm'
        ? request.description
        : request.kind === 'rename'
          ? 'Rename the local branch and update its recorded children. Remote branch names and PRs stay unchanged.'
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
                                : 'GitHub merges the reviewed pull requests itself, bottom-to-top, and this dialog follows the result. Local branches are never retargeted or deleted for you; restack and publish the rest afterwards.'

  const readProgress = async () => {
    if (request.kind !== 'stack' || request.operation !== 'publish') return
    try {
      await progressQuery.refetch({ throwOnError: true })
    } catch {
      setProgress(null)
    }
  }

  // A merge that landed some pull requests and not others is a finished run with a partial
  // outcome. Treating it as a stopped operation would offer a retry that GitHub would reject
  // for the pull requests that are already merged.
  const mergePartial =
    finished &&
    mergeProgress !== null &&
    mergeProgress.layers.some((layer) => layer.status !== 'merged')

  const run = async (action: GitAction, label: string) => {
    if (
      // The submitting state is deliberately not a dispatch lock: it is this very
      // submission, and the dispatch lock below is what stops a second one.
      dispatchLocked ||
      captured.current.path !== snapshot.path ||
      shapeReason ||
      actionBlockReason(snapshot.capabilities, action.type)
    )
      return
    const merging =
      action.type === 'executeStack' && request.kind === 'stack' && request.operation === 'merge'
    const attemptRun = dispatch(async () => {
      if (merging) setMergeRunning(true)
      try {
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
      } finally {
        // The run is over: what GitHub reports from here on is a read, and that read is
        // newer than the progress this run pushed.
        if (merging) setMergeRunning(false)
      }
    })
    const { dispatched, value: success } = await attemptRun
    if (!dispatched || !success) return
    if (request.kind === 'surgery') setFinished(true)
    else if (request.kind === 'stack' && request.operation !== 'publish') setFinished(true)
    else onClose()
  }

  // The branch name a force consent must match, read from the same submitted values
  // the payload is built from.
  const confirmationTargetFor = (values: WorkflowFormValues): string | null =>
    request.kind === 'forcePush'
      ? (push?.branch ?? null)
      : request.kind === 'stack' && values.allowForce
        ? request.branch
        : request.kind === 'surgery' && values.allowForce
          ? (surgery?.forcePushes[0] ?? null)
          : null

  /**
   * The exact action payload a set of form values describes, or `null` while the
   * reviewed preview they depend on is missing.
   */
  const actionInputFor = (values: WorkflowFormValues): WorkflowActionInput | null => {
    const {
      name,
      message,
      includeUntracked,
      strategy,
      mainline,
      confirmation,
      allowForce,
      layerChoices,
      mergeMethod,
      mergeAction,
      closePullRequests,
      prTitle,
      body,
      prDraft,
    } = values
    const confirmationTarget = confirmationTargetFor(values)
    if (request.kind === 'confirm')
      return { kind: 'confirm', action: request.action, label: request.label }
    if (request.kind === 'stack') {
      if (!preview) return null
      return request.operation === 'publish'
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
            mergeAction,
          }
    }
    if (request.kind === 'surgery') {
      if (!surgery) return null
      return {
        kind: 'surgery',
        preview: surgery,
        allowForce,
        closePullRequests,
        confirmation,
        confirmationTarget,
      }
    }
    if (request.kind === 'pr')
      return { kind: 'pr', number: request.number, title: prTitle, body, draft: prDraft }
    if (request.kind === 'forcePush') return { kind: 'forcePush', push, confirmation }
    if (request.kind === 'rename') return { kind: 'rename', branch: request.branch, name }
    if (request.kind === 'parent') return { kind: 'parent', branch: request.branch, name }
    if (request.kind === 'upstream') return { kind: 'upstream', branch: request.branch, name }
    if (request.kind === 'pull') return { kind: 'pull', strategy }
    if (request.kind === 'merge') return { kind: 'merge', ref: name }
    if (request.kind === 'stash') return { kind: 'stash', message, includeUntracked }
    if (request.kind === 'commitAction')
      return {
        kind: 'commitAction',
        commit: request.commit,
        mode: request.mode,
        mainline,
      }
    return null
  }

  const confirmationTarget = confirmationTargetFor(values)

  // A merge review is the contiguous portion of the stack that one action lands, so every
  // layer of it stays listed rather than only the selected branch.
  const stackSteps = preview && request.kind === 'stack' ? preview.steps : []
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
    // The journalled choices are immutable while a submission is being recovered: they
    // replace whatever the fresh preview seeded so Resume republishes exactly these.
    form.setFieldValue('layerChoices', (current) => ({
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
  /**
   * The single reason a set of values may not be dispatched, or `null`. The button
   * and the submit handler ask this same question of the same values, so a
   * bypassed control cannot dispatch what the reviewed preview forbids.
   */
  const guardFor = (values: WorkflowFormValues): WorkflowBlocker | null =>
    workflowBlocker({
      kind: request.kind,
      busy,
      loading,
      loaded,
      finished,
      capturedPath: captured.current.path,
      currentPath: snapshot.path,
      previewToken: identity,
      rejectedTokens: rejectedIdentities,
      previewBlockers:
        request.kind === 'surgery' ? (surgery?.blockers ?? []) : (preview?.blockers ?? []),
      confirmationTarget: confirmationTargetFor(values),
      confirmation: values.confirmation,
      allowForce: values.allowForce,
      expectedOidMissing: request.kind === 'forcePush' && !push,
      requiresName:
        ['rename', 'parent', 'merge'].includes(request.kind) ||
        (request.kind === 'surgery' && request.request.kind === 'insert'),
      name: values.name,
      requiresMainline: request.kind === 'commitAction' && request.commit.parents.length > 1,
      mainline: values.mainline,
      requiresMergeMethod:
        request.kind === 'stack' &&
        request.operation === 'merge' &&
        values.mergeAction === 'direct_merge',
      mergeMethod: values.mergeMethod,
      requiresLeaseApproval:
        (preview?.sync?.forcePushes.length ?? 0) > 0 || (surgery?.forcePushes.length ?? 0) > 0,
      untitledBranches:
        request.kind === 'stack' && request.operation === 'publish' && publishOffer
          ? publishOffer.layers
              .filter((layer) => layer.create && !values.layerChoices[layer.branch]?.title.trim())
              .map((layer) => layer.branch)
          : [],
      pullRequestMissing: request.kind === 'pr' && !pr,
      pullRequestMerged: request.kind === 'pr' && pr?.state === 'MERGED',
      pullRequestTitle: values.prTitle,
    })
  const blocker = guardFor(values)
  const failed = Boolean(error || actionError)
  const phase = workflowPhase({
    loading,
    busy,
    failed,
    stale,
    finished: finished && !mergePartial,
    partial: mergePartial,
    blocked: Boolean(blocker || shapeReason) && !finished,
  })
  const actionLabel =
    request.kind === 'surgery'
      ? surgeryActionLabel(request.request.kind)
      : request.kind === 'confirm'
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
            : phase === 'partial'
              ? 'Only part of this stack merged. Read which pull requests GitHub merged, then restack and publish the rest; nothing local changed.'
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
    request.kind === 'forcePush' && push
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
      onOpenChange={(open, details) => {
        if (open) return
        const intent = closeIntent({
          // A dispatch the form owns is still a dispatch: dismissing it mid-flight would
          // hide a Git action that is already running.
          busy: busy || formSubmitting,
          dirty: edited && !finished,
        })
        if (intent === 'allow') {
          onClose()
          return
        }
        // A refused dismissal is cancelled, not merely ignored: the controlled `open`
        // stays true, and cancelling also stops Base UI from moving focus out of a
        // dialog that is still open.
        details.cancel()
        setCloseNotice(CLOSE_INTENT_MESSAGES[intent])
      }}
    >
      <DialogContent
        ref={contentRef}
        className="workflow-dialog"
        initialFocus={() => {
          // Destructive and reviewed operations open on Cancel; ordinary forms open
          // on their first field.
          if (initialFocusTarget(composition) === 'cancel') {
            return cancelRef.current ?? false
          }
          const firstField = contentRef.current?.querySelector<HTMLElement>(
            '[data-workflow-first-field]',
          )
          return firstField ?? cancelRef.current ?? false
        }}
        finalFocus={() => {
          if (trigger.current?.isConnected && !trigger.current.matches(':disabled'))
            return trigger.current
          return document.querySelector<HTMLInputElement>('.toolbar-search input') ?? false
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="workflow-form"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <WorkflowFrame
            composition={composition}
            wide={request.kind === 'stack' || request.kind === 'surgery'}
          >
            <fieldset className="workflow-fields" disabled={locked || finished}>
              {closeNotice ? <WarningNote>{closeNotice}</WarningNote> : null}
              {contextFacts.length ? <OperationContext facts={contextFacts} /> : null}
              <PhaseStatus phase={phase} message={statusMessage} />
              {request.kind === 'rename' ? (
                <form.Field name="name">
                  {(field) => (
                    <Field id="workflow-name" label="New branch name" required>
                      <Input
                        data-workflow-first-field=""
                        value={field.state.value}
                        onChange={(event) => {
                          markEdited()
                          field.handleChange(event.target.value)
                        }}
                        onBlur={field.handleBlur}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                  )}
                </form.Field>
              ) : null}
              {request.kind === 'parent' || request.kind === 'merge' ? (
                <>
                  <form.Field name="name">
                    {(field) => (
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
                          disabled={locked || finished}
                          value={field.state.value}
                          onValueChange={(value) => {
                            markEdited()
                            field.handleChange(value)
                          }}
                          options={[
                            { value: '', label: 'Choose a branch' },
                            ...(request.kind === 'parent'
                              ? parentNames
                                  .filter((parent) => parent !== request.branch.name)
                                  .map((parent) => ({ value: parent, label: parent }))
                              : snapshot.branches
                                  .filter((branch) => !branch.current)
                                  .map((branch) => ({ value: branch.ref, label: branch.name }))),
                          ]}
                        />
                      </Field>
                    )}
                  </form.Field>
                </>
              ) : null}
              {request.kind === 'upstream' ? (
                <form.Field name="name">
                  {(field) => (
                    <Field id="workflow-upstream" label="Remote tracking branch">
                      <Select
                        data-workflow-first-field=""
                        disabled={locked || finished}
                        value={field.state.value}
                        onValueChange={(value) => {
                          markEdited()
                          field.handleChange(value)
                        }}
                        options={[
                          { value: '', label: 'No upstream' },
                          ...snapshot.branches
                            .filter((branch) => branch.remote)
                            .map((branch) => ({ value: branch.ref, label: branch.name })),
                        ]}
                      />
                    </Field>
                  )}
                </form.Field>
              ) : null}
              {request.kind === 'pull' ? (
                <>
                  <form.Field name="strategy">
                    {(field) => (
                      <Field id="workflow-pull" label="Integration strategy">
                        <Select
                          data-workflow-first-field=""
                          disabled={locked || finished}
                          value={field.state.value}
                          onValueChange={(value) => {
                            markEdited()
                            field.handleChange(value as typeof field.state.value)
                          }}
                          options={[
                            { value: 'ff-only', label: 'Fast-forward only' },
                            { value: 'merge', label: 'Merge upstream changes' },
                            { value: 'rebase', label: 'Rebase local commits onto upstream' },
                          ]}
                        />
                      </Field>
                    )}
                  </form.Field>
                  {values.strategy === 'rebase' ? (
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
                  <form.Field name="confirmation">
                    {(field) => (
                      <TypedConfirmation
                        id="workflow-force-confirmation"
                        label={`Type ${confirmationTarget ?? ''} to confirm`}
                        value={field.state.value}
                        onChange={(value) => {
                          markEdited()
                          field.handleChange(value)
                        }}
                        target={confirmationTarget ?? ''}
                      />
                    )}
                  </form.Field>
                </>
              ) : null}
              {request.kind === 'stash' ? (
                <>
                  <form.Field name="message">
                    {(field) => (
                      <Field id="workflow-stash-message" label="Message (optional)">
                        <Input
                          data-workflow-first-field=""
                          value={field.state.value}
                          onChange={(event) => {
                            markEdited()
                            field.handleChange(event.target.value)
                          }}
                          onBlur={field.handleBlur}
                          placeholder="Work to return to"
                        />
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name="includeUntracked">
                    {(field) => (
                      <Checkbox
                        id="workflow-include-untracked"
                        label="Include untracked files"
                        disabled={locked || finished}
                        checked={field.state.value}
                        onCheckedChange={(checked) => {
                          markEdited()
                          field.handleChange(checked)
                        }}
                      />
                    )}
                  </form.Field>
                </>
              ) : null}
              {request.kind === 'commitAction' && request.commit.parents.length > 1 ? (
                <form.Field name="mainline">
                  {(field) => (
                    <Field
                      id="workflow-mainline"
                      label="Mainline parent for this merge commit"
                      required
                    >
                      <Select
                        data-workflow-first-field=""
                        disabled={locked || finished}
                        value={field.state.value}
                        onValueChange={(value) => {
                          markEdited()
                          field.handleChange(value)
                        }}
                        options={[
                          { value: '', label: 'Choose the parent whose changes to keep' },
                          ...request.commit.parents.map((oid, index) => ({
                            value: String(index + 1),
                            label: `Parent ${index + 1}: ${oid.slice(0, 12)}`,
                          })),
                        ]}
                      />
                    </Field>
                  )}
                </form.Field>
              ) : null}
              {/*
                A recovered submission is described by its journal, not by a fresh preview.
                Gating this whole region on the preview would hide the saved steps, the saved
                consent and the base changes the moment a fresh read fails, while Resume
                stayed enabled. The preview-dependent parts stay gated; the saved ones do not.
              */}
              {request.kind === 'surgery' && request.request.kind === 'insert' ? (
                <>
                  <form.Field name="name">
                    {(field) => (
                      <Field id="workflow-surgery-name" label="New branch name" required>
                        <Input
                          data-workflow-first-field=""
                          value={field.state.value}
                          onChange={(event) => {
                            markEdited()
                            field.handleChange(event.target.value)
                            // A named insert has no preview yet: the reviewed rewrites below
                            // are the ones this exact name costs, so they are read again.
                            queryClient.setQueryData(previewKey, { kind: 'local' })
                            setIdentity(null)
                          }}
                          onBlur={field.handleBlur}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </Field>
                    )}
                  </form.Field>
                  <WarningNote>
                    Reload the preview after naming the branch: the reviewed rewrites, pull request
                    bases and pushes below are the ones this exact name costs.
                  </WarningNote>
                </>
              ) : null}
              {request.kind === 'surgery' && surgery ? (
                <>
                  <OperationContext
                    title={`Stack order after this ${surgery.kind}`}
                    description={`Every layer hangs from ${surgery.trunk} in this order: ${surgery.order.join(' → ')}.`}
                    facts={[
                      { label: 'Anchored on', value: surgery.branch },
                      { label: 'Trunk', value: surgery.trunk },
                      {
                        label: 'Layers',
                        value: `${surgery.layers.length} of ${surgery.order.length}`,
                      },
                    ]}
                  />
                  {surgery.layers.map((layer) => (
                    <WorkflowSection
                      key={`surgery-${layer.branch}`}
                      label={`${layer.branch}: ${layer.fromParent ?? 'new'} → ${layer.toParent}`}
                    >
                      <div className="workflow-row">
                        <Badge variant={SURGERY_ACTION_BADGE[layer.action]}>
                          {SURGERY_ACTION_LABELS[layer.action]}
                        </Badge>
                        <span className="workflow-note">
                          {layer.pullRequest === null
                            ? 'No pull request'
                            : `#${layer.pullRequest}${layer.pullRequestAction === 'close' ? ' will close' : layer.pullRequestAction === 'retarget' ? ` retargeted from ${layer.pullRequestBase}` : layer.pullRequestBase ? ` targets ${layer.pullRequestBase}` : ''}`}
                        </span>
                      </div>
                      <p className="workflow-note">{layer.note}</p>
                      {layer.push === 'force' ? (
                        <OperationFacts
                          facts={[
                            {
                              label: 'Lease',
                              value: `origin/${layer.branch} at ${layer.remoteOid?.slice(0, 12) ?? 'absent'}`,
                              code: true,
                            },
                            {
                              label: 'New tip',
                              value: layer.oid?.slice(0, 12) ?? 'Not written yet',
                              code: true,
                            },
                          ]}
                        />
                      ) : null}
                      {layer.blockers.length > 0 ? <BlockerList items={layer.blockers} /> : null}
                    </WorkflowSection>
                  ))}
                  {surgery.nativeStack && surgery.nativeStack.action !== 'none' ? (
                    <OperationContext
                      title="Native stack"
                      description={
                        surgery.nativeStack.number === null
                          ? SURGERY_STACK_LABELS[surgery.nativeStack.action]
                          : `${SURGERY_STACK_LABELS[surgery.nativeStack.action]} (stack #${
                              surgery.nativeStack.number
                            }${
                              surgery.nativeStack.members.length > 0
                                ? `, new members ${surgery.nativeStack.members
                                    .map((number) => `#${number}`)
                                    .join(', ')}`
                                : ''
                            }).`
                      }
                      facts={[]}
                    />
                  ) : null}
                  {(surgery.creates ?? []).length > 0 ? (
                    <WarningNote>
                      {surgery.creates.join(', ')} {surgery.creates.length === 1 ? 'is' : 'are'}{' '}
                      published as a new branch on the remote before the pull request above{' '}
                      {surgery.creates.length === 1 ? 'it is' : 'them are'} retargeted onto{' '}
                      {surgery.creates.length === 1 ? 'it' : 'them'}. That push refuses to replace a
                      branch that already exists there.
                    </WarningNote>
                  ) : null}
                  {surgery.closes.length > 0 ? (
                    <WarningNote>
                      Pull request {surgery.closes.map((number) => `#${number}`).join(', ')} will
                      close. Its commits stay reachable from the local recovery ref this run
                      creates, and no other pull request is touched.
                    </WarningNote>
                  ) : null}
                  {(surgery.warnings ?? []).map((warning, index) => (
                    <WarningNote key={`${index}-${warning}`}>{warning}</WarningNote>
                  ))}
                  <BlockerList items={surgery.blockers} />
                  {surgery.forcePushes.length > 0 ? (
                    <>
                      <form.Field name="allowForce">
                        {(field) => (
                          <Checkbox
                            id="workflow-surgery-lease"
                            label="Replace published history on the listed branches with exact leases"
                            disabled={locked || finished}
                            checked={field.state.value}
                            onCheckedChange={(checked) => {
                              markEdited()
                              field.handleChange(checked)
                              // Consent is retyped for every approval: a name typed for one
                              // consent never carries into the next.
                              form.setFieldValue('confirmation', '')
                            }}
                          />
                        )}
                      </form.Field>
                      {values.allowForce ? (
                        <>
                          <WarningNote>
                            Remote-only commits on {surgery.forcePushes.join(', ')} may be replaced.
                            Each push names the exact tip above as its lease, so a changed remote
                            stops the surgery instead of overwriting it.
                          </WarningNote>
                          <form.Field name="confirmation">
                            {(field) => (
                              <TypedConfirmation
                                id="workflow-confirm"
                                value={field.state.value}
                                target={confirmationTarget ?? ''}
                                onChange={(value) => {
                                  markEdited()
                                  field.handleChange(value)
                                }}
                                disabled={locked}
                              />
                            )}
                          </form.Field>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {surgery.closes.length > 0 ? (
                    <form.Field name="closePullRequests">
                      {(field) => (
                        <Checkbox
                          id="workflow-surgery-close-prs"
                          label="Close the pull requests of the removed layer"
                          disabled={locked || finished}
                          checked={field.state.value}
                          onCheckedChange={(checked) => {
                            markEdited()
                            field.handleChange(checked)
                          }}
                        />
                      )}
                    </form.Field>
                  ) : null}
                </>
              ) : null}
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
                                    layer.pullRequestBase ? ` targets ${layer.pullRequestBase}` : ''
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
                          <form.Field name="allowForce">
                            {(field) => (
                              <Checkbox
                                id="workflow-sync-lease"
                                label="Replace published history on the listed branches with exact leases"
                                disabled={locked || finished}
                                checked={field.state.value}
                                onCheckedChange={(checked) => {
                                  markEdited()
                                  field.handleChange(checked)
                                  form.setFieldValue('confirmation', '')
                                }}
                              />
                            )}
                          </form.Field>
                          {values.allowForce ? (
                            <>
                              <WarningNote>
                                Remote-only commits on {syncOffer.forcePushes.join(', ')} may be
                                replaced. Each push names the exact tip above as its lease, so a
                                changed remote stops the sync instead of overwriting it.
                              </WarningNote>
                              <form.Field name="confirmation">
                                {(field) => (
                                  <TypedConfirmation
                                    id="workflow-confirm"
                                    value={field.state.value}
                                    target={request.branch}
                                    onChange={(value) => {
                                      markEdited()
                                      field.handleChange(value)
                                    }}
                                    disabled={locked}
                                  />
                                )}
                              </form.Field>
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
                          <form.Field name="allowForce">
                            {(field) => (
                              <Checkbox
                                id="workflow-allow-force"
                                label="Allow rewritten branches to be pushed with exact leases"
                                disabled={locked || finished}
                                checked={field.state.value}
                                onCheckedChange={(checked) => {
                                  markEdited()
                                  field.handleChange(checked)
                                  form.setFieldValue('confirmation', '')
                                }}
                              />
                            )}
                          </form.Field>
                          {values.allowForce ? (
                            <>
                              <WarningNote>
                                Remote-only commits may be replaced. A changed remote tip stops the
                                push.
                              </WarningNote>
                              <form.Field name="confirmation">
                                {(field) => (
                                  <TypedConfirmation
                                    id="workflow-confirm"
                                    value={field.state.value}
                                    target={request.branch}
                                    onChange={(value) => {
                                      markEdited()
                                      field.handleChange(value)
                                    }}
                                    disabled={locked}
                                  />
                                )}
                              </form.Field>
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
                      <form.Field name="layerChoices">
                        {(field) => {
                          const layers = recovering
                            ? (progress?.layers ?? [])
                            : (publishOffer?.layers ?? [])
                          return layers.map((layer) => {
                            const choice = recovering ? layer : field.state.value[layer.branch]
                            const id = encodeURIComponent(layer.branch)
                            const setChoice = (update: Partial<PublishLayerChoice>) => {
                              markEdited()
                              field.handleChange((current) => ({
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
                                    disabled={locked || finished}
                                    checked={choice?.updateBase ?? false}
                                    onCheckedChange={(checked) =>
                                      setChoice({ updateBase: checked })
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
                                    disabled={recovering || locked || finished}
                                    onCheckedChange={(checked) => setChoice({ draft: checked })}
                                  />
                                ) : null}
                              </WorkflowSection>
                            )
                          })
                        }}
                      </form.Field>
                    </>
                  ) : null}
                  {request.operation === 'merge' ? (
                    <form.Field name="mergeAction">
                      {(field) => (
                        <Field
                          id="workflow-merge-action"
                          label="How GitHub lands it"
                          description={
                            values.mergeAction === 'merge_queue'
                              ? 'The merge queue runs the repository\u2019s required checks and either merges the group or ejects it. The merge method below is not sent.'
                              : 'GitHub merges the reviewed pull requests itself, in the background, while this dialog follows the result.'
                          }
                        >
                          <Select
                            data-workflow-first-field=""
                            disabled={locked || finished}
                            value={field.state.value}
                            onValueChange={(value) => {
                              markEdited()
                              field.handleChange(value as MergeAction)
                            }}
                            options={(preview?.merge?.actions ?? []).map((action) => ({
                              value: action,
                              label:
                                action === 'merge_queue'
                                  ? 'Add to the merge queue'
                                  : action === 'direct_merge'
                                    ? 'Merge directly, without the queue'
                                    : 'Let the repository decide (queue when one is configured)',
                            }))}
                          />
                        </Field>
                      )}
                    </form.Field>
                  ) : null}
                  {request.operation === 'merge' && values.mergeAction === 'direct_merge' ? (
                    <form.Field name="mergeMethod">
                      {(field) => (
                        <Field id="workflow-merge-method" label="Merge method" required>
                          <Select
                            disabled={locked || finished}
                            value={field.state.value}
                            onValueChange={(value) => {
                              markEdited()
                              field.handleChange(value as '' | 'merge' | 'squash' | 'rebase')
                            }}
                            options={[
                              { value: '', label: 'Choose a repository-supported method' },
                              ...(preview?.mergeMethods ?? []).map((method) => ({
                                value: method,
                                label:
                                  method === 'squash'
                                    ? 'Squash and merge'
                                    : method === 'rebase'
                                      ? 'Rebase and merge'
                                      : 'Create a merge commit',
                              })),
                            ]}
                          />
                        </Field>
                      )}
                    </form.Field>
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
                        externalMutation
                          .mutateAsync(pr.url)
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
                  <form.Field name="prTitle">
                    {(field) => (
                      <Field id="workflow-pr-title" label="Title" required>
                        <Input
                          data-workflow-first-field=""
                          value={field.state.value}
                          disabled={pr.state === 'MERGED'}
                          onChange={(event) => {
                            markEdited()
                            field.handleChange(event.target.value)
                          }}
                          onBlur={field.handleBlur}
                        />
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name="body">
                    {(field) => (
                      <Field id="workflow-pr-body" label="Description (optional)">
                        <Textarea
                          rows={6}
                          value={field.state.value}
                          disabled={pr.state === 'MERGED' || issueMutationBusy}
                          onChange={(event) => {
                            markEdited()
                            field.handleChange(event.target.value)
                          }}
                          onBlur={field.handleBlur}
                        />
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name="prDraft">
                    {(field) => (
                      <Checkbox
                        id="workflow-pr-draft"
                        label="Draft pull request"
                        disabled={pr.state !== 'OPEN' || locked || finished}
                        checked={field.state.value}
                        onCheckedChange={(checked) => {
                          markEdited()
                          field.handleChange(checked)
                        }}
                      />
                    )}
                  </form.Field>
                  <PrLinkedIssuesSection
                    pr={pr}
                    repositoryPath={snapshot.path}
                    authority={authority}
                    onPrUpdate={(updated) => {
                      queryClient.setQueryData(previewKey, { kind: 'pr', value: updated })
                      form.setFieldValue('body', updated.body)
                    }}
                    onBodyMutation={(mutation) => {
                      queryClient.setQueryData<WorkflowData>(previewKey, (current) =>
                        current?.kind === 'pr'
                          ? { ...current, value: { ...current.value, body: mutation.newBody } }
                          : current,
                      )
                      form.setFieldValue('body', mutation.newBody)
                    }}
                    onMutationBusy={setIssueMutationBusy}
                    defaultBranch={snapshot.defaultBranch}
                    disabled={busy || pr.state === 'MERGED'}
                    hasFormEdits={edited}
                    runAction={runAction}
                    stackApi={stackApi}
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

            {/* Outside the fieldset on purpose: a finished run locks every control that
                dispatches, and reading what GitHub did afterwards is not a dispatch. */}
            {request.kind === 'stack' &&
            request.operation === 'merge' &&
            (mergeProgress || mergeStatus) ? (
              <div className="grid gap-2">
                {mergeStatusError ? (
                  <InlineAlert tone="error">
                    GitHub could not be read: {mergeStatusError} The last result it reported is kept
                    until a read succeeds.
                  </InlineAlert>
                ) : null}
                {/* A run in flight speaks for itself. Once it returns, a read is newer
                          than the progress it pushed, and a read that arrives later is newer
                          still, so the read-back is what the panel shows; the run's own result
                          stands only until a read answers. */}
                {mergeProgress && (mergeRunning || !mergeStatus) ? (
                  <MergeOutcomePanel progress={mergeProgress} />
                ) : (
                  <MergeOutcomePanel
                    label={`What GitHub reports now \u2014 ${mergeStatus!.layers.length} pull request${
                      mergeStatus!.layers.length === 1 ? '' : 's'
                    } from this and earlier merge requests`}
                    progress={{
                      action: 'default',
                      status: mergeStatus!.layers.some((layer) => layer.status === 'failed')
                        ? 'failed'
                        : mergeStatus!.layers.some((layer) => layer.status === 'pending')
                          ? 'running'
                          : mergeStatus!.layers.some((layer) => layer.status === 'enqueued')
                            ? 'queued'
                            : 'succeeded',
                      layers: mergeStatus!.layers,
                      message: mergeStatus!.message,
                    }}
                  />
                )}
                <div>
                  <Button type="button" onClick={() => void readMergeStatus()}>
                    Refresh what GitHub reports
                  </Button>
                </div>
              </div>
            ) : null}
            {!loading &&
            (((error || actionError) && previewKinds.includes(request.kind)) ||
              (request.kind === 'surgery' && !surgery)) ? (
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
                  disabled={Boolean(blocker || shapeReason || issueMutationBusy || formSubmitting)}
                  loading={busy || formSubmitting}
                  tooltip={shapeReason ?? (blocker ? blocker.message : description)}
                >
                  {busy || formSubmitting ? (
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
