import * as React from 'react'
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OperationProgress } from '@git-stacks/shared/operation-scope'
import {
  mergeProgressAfterRead,
  operationProgressKeys,
  readOperationProgress,
} from '../lib/operation-progress'
import { GitBranch, GitMerge, LoaderCircle, TriangleAlert } from 'lucide-react'
import type {
  RepositorySnapshot,
  DesktopAPI,
  PublishProgress,
  MergeProgress,
  MergeStatus,
} from '@git-stacks/shared/types'
import { DIFF_PAGE_SIZE } from '@git-stacks/shared/performance'
import { useListWindow } from '../lib/list-window'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import type { RunAction, WorkflowRequest } from './workflow-dialog'
import { PhaseStatus, WorkflowActions } from './workflow-composition'
import { partialProgress, workflowPhase } from './workflow-policy'

interface CommonProps {
  snapshot: RepositorySnapshot
  busy: boolean
  runAction: RunAction
  onRequest: (request: WorkflowRequest) => void
}

function RemoteOperationStatus({
  snapshot,
  authority,
  desktop,
  onRequest,
  showingOperation,
  busy,
}: {
  snapshot: RepositorySnapshot
  authority: string
  desktop?: DesktopAPI
  onRequest: (request: WorkflowRequest) => void
  showingOperation: 'publish' | 'merge' | null
  busy: boolean
}) {
  const queryClient = useQueryClient()
  const scope = React.useMemo(
    () => ({ repositoryPath: snapshot.path, remoteUrl: snapshot.remoteUrl, authority }),
    [snapshot.path, snapshot.remoteUrl, authority],
  )
  const keys = React.useMemo(() => operationProgressKeys(scope), [scope])
  const { publication: publicationKey, merge: mergeKey, mergeProgress: mergeProgressKey } = keys
  const publication = useQuery<OperationProgress<PublishProgress>>({
    queryKey: publicationKey,
    enabled: false,
    queryFn: ({ signal }) => readOperationProgress(desktop!.submitStackProgress!, scope, signal),
  })
  const merge = useQuery<OperationProgress<MergeStatus>>({
    queryKey: mergeKey,
    enabled: false,
    queryFn: async ({ signal }) => {
      const result = await readOperationProgress(desktop!.mergeStatus!, scope, signal)
      queryClient.setQueryData<OperationProgress<MergeProgress> | null>(
        mergeProgressKey,
        (previous) => mergeProgressAfterRead(previous, result),
      )
      return result
    },
  })
  const pushedMerge = useQuery<OperationProgress<MergeProgress> | null>({
    queryKey: mergeProgressKey,
    queryFn: skipToken,
    enabled: false,
  })
  const progress = publication.data?.progress
  const mergeEnvelope = pushedMerge.data ?? merge.data
  const mergeResult = mergeEnvelope?.progress
  if (!progress && !mergeResult && !publication.error && !merge.error) return null
  return (
    <section className="operation-banner" aria-label="Remote operation recovery">
      <p role="status" aria-live="polite" className="sr-only">
        {progress && showingOperation !== 'publish'
          ? `Publication ${progress.status}. ${progress.message}`
          : ''}
        {mergeResult && showingOperation !== 'merge'
          ? `Merge outcomes. ${mergeResult.message}`
          : ''}
        {(publication.error && showingOperation !== 'publish') ||
        (merge.error && showingOperation !== 'merge')
          ? 'Recovery read unavailable. Last confirmed results remain visible.'
          : ''}
      </p>
      {progress ? (
        <div className="grid gap-2">
          <p>
            <strong>Publication · {progress.status}</strong> · {progress.message}
          </p>
          <p className="workflow-note">
            Captured layers: {progress.layers.map((layer) => layer.branch).join(', ')}. Published
            remote changes are not undone by local Abort.
          </p>
          {publication.data?.source === 'journal-read' ? (
            <p className="workflow-note">
              Saved journal read. Original operation authority was not recorded; this read does not
              grant retry consent.
            </p>
          ) : null}
          <ul>
            {progress.steps.map((step, index) => (
              <li key={index}>
                {step.status} · {step.label}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onRequest({
                kind: 'stack',
                operation: 'publish',
                branch: progress.layers[0]?.branch ?? snapshot.currentBranch ?? '',
              })
            }
          >
            Review publication recovery
          </Button>
        </div>
      ) : null}
      {mergeResult ? (
        <div className="grid gap-2">
          <p>
            <strong>Merge outcomes</strong> · {mergeResult.message}
          </p>
          {mergeEnvelope?.source === 'journal-read' ? (
            <p className="workflow-note">
              Saved merge journal read. Original operation authority was not recorded; no merge was
              requested.
            </p>
          ) : null}
          <ul>
            {mergeResult.layers.map((layer) => (
              <li key={layer.pullRequest}>
                #{layer.pullRequest} {layer.branch} · {layer.status} · {layer.detail}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onRequest({
                kind: 'stack',
                operation: 'merge',
                branch: mergeResult.layers[0]?.branch ?? snapshot.currentBranch ?? '',
              })
            }
          >
            Review merge outcomes
          </Button>
        </div>
      ) : null}
      {publication.error || merge.error ? (
        <p className="workflow-note">
          Recovery read unavailable. Last confirmed results remain visible; no mutation was retried.
        </p>
      ) : null}
      {desktop?.mergeStatus && mergeResult ? (
        <Button
          size="sm"
          variant="secondary"
          loading={merge.isFetching}
          disabled={busy}
          onClick={() => {
            void merge.refetch({ throwOnError: true }).catch(() => {})
          }}
        >
          Refresh merge outcomes
        </Button>
      ) : null}
    </section>
  )
}

/**
 * The persistent operation banner. It stays on screen across every workspace
 * view while a Git operation or stack restack is in flight, and it renders the
 * same state model the dialogs use: real progress from the snapshot, real
 * blocker counts from the working tree, and never a synthesized percentage.
 */
export function OperationBanner({
  snapshot,
  busy,
  runAction,
  onRequest,
  onShowChanges,
  onResolveConflict,
  authority,
  desktop,
  showingOperation,
}: CommonProps & {
  authority: string
  desktop?: DesktopAPI
  showingOperation: 'publish' | 'merge' | null
  onShowChanges: () => void
  onResolveConflict: (path: string) => void
}) {
  const operation = snapshot.operation
  const stack = snapshot.stackOperation
  const conflicts = snapshot.files.filter((file) => file.conflicted).length
  const firstConflict = snapshot.files.find((file) => file.conflicted)?.path ?? null
  const remoteStatus = (
    <RemoteOperationStatus
      key={JSON.stringify([snapshot.path, snapshot.remoteUrl, authority])}
      snapshot={snapshot}
      authority={authority}
      desktop={desktop}
      onRequest={onRequest}
      showingOperation={showingOperation}
      busy={busy}
    />
  )
  if (!operation && !stack && !conflicts) return remoteStatus
  const label = stack
    ? stack.surgery
      ? 'Stack surgery'
      : stack.kind === 'sync'
        ? 'Stack Sync'
        : 'Stack restack'
    : operation === 'cherryPick'
      ? 'Cherry-pick'
      : operation
        ? operation.charAt(0).toUpperCase() + operation.slice(1)
        : 'Conflicts'
  const resumable = Boolean(stack || (operation && operation !== 'other'))
  const progress = stack
    ? partialProgress({
        completed: stack.completed,
        remaining: stack.remaining,
        message: stack.message,
      })
    : null
  const pendingRemoteEffects = Boolean(
    stack?.surgery?.pullRequests.some((step) => step.status !== 'completed') ||
      (stack?.surgery?.nativeStack &&
        (stack.surgery.nativeStack.unstackStatus !== 'completed' ||
          (stack.surgery.nativeStack.action === 'unstack-and-create' &&
            stack.surgery.nativeStack.createStatus === 'pending'))),
  )
  const phase = workflowPhase({
    loading: false,
    busy: false,
    failed: false,
    stale: false,
    finished: progress !== null && progress.remaining === 0 && !pendingRemoteEffects,
    partial:
      progress !== null &&
      progress.completed > 0 &&
      (progress.remaining > 0 || pendingRemoteEffects),
    blocked: resumable && conflicts > 0,
  })
  const message =
    conflicts > 0
      ? `${conflicts} conflicted file${conflicts === 1 ? '' : 's'}. Resolve and stage each file before continuing.`
      : progress
        ? `${progress.summary}. ${progress.message}`
        : 'Review the working tree, then continue or abort.'
  return (
    <>
      {remoteStatus}
      <section className="operation-banner" aria-label="Git operation status">
        <PhaseStatus
          phase={phase}
          title={`${label} ${operation || stack ? 'in progress' : 'need attention'}`}
          message={message}
          className="operation-status"
        />
        {stack?.surgery ? (
          <div className="grid gap-2">
            <p className="workflow-note">
              Captured surgery effects remain journalled; local Abort does not undo remote effects.
            </p>
            <ul>
              {stack.surgery.pullRequests.map((step) => (
                <li key={`${step.number}:${step.action}`}>
                  #{step.number} · {step.action} · {step.status}
                </li>
              ))}
              {stack.surgery.nativeStack ? (
                <li>
                  Native stack #{stack.surgery.nativeStack.number} ·{' '}
                  {stack.surgery.nativeStack.action} · unstack{' '}
                  {stack.surgery.nativeStack.unstackStatus}
                  {stack.surgery.nativeStack.action === 'unstack-and-create'
                    ? ` · replacement ${stack.surgery.nativeStack.createStatus}`
                    : ''}
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
        <div className="workflow-row">
          <Button size="sm" variant="secondary" onClick={onShowChanges}>
            View changes
          </Button>
          {conflicts > 0 && firstConflict ? (
            <Button
              size="sm"
              variant="secondary"
              tooltip="Open the three-way resolver for the first conflicted file. It explains the operation, shows index stages 1, 2, and 3, and stages a result only after the file is revalidated."
              onClick={() => onResolveConflict(firstConflict)}
            >
              Resolve conflicts
            </Button>
          ) : null}
          {resumable ? (
            <>
              <Button
                disabled={busy || conflicts > 0}
                size="sm"
                variant="default"
                tooltip={
                  conflicts > 0
                    ? 'Blocked until every conflicted file is resolved and staged.'
                    : stack
                      ? `Resume ${label.toLowerCase()} using the saved journal and staged resolutions.`
                      : `Resume the ${label.toLowerCase()} locally using staged resolutions.`
                }
                onClick={() =>
                  runAction(
                    { type: stack ? 'stackContinue' : 'operationContinue' },
                    `Continue ${label.toLowerCase()}`,
                  )
                }
              >
                Continue
              </Button>
              {(
                stack
                  ? operation === 'rebase' && Boolean(stack.currentBranch)
                  : ['rebase', 'cherryPick', 'revert'].includes(operation ?? '')
              ) ? (
                <Button
                  disabled={busy}
                  size="sm"
                  variant="secondary"
                  tooltip="Skip the current commit without applying it locally. Its conflict resolutions are discarded."
                  onClick={() =>
                    onRequest({
                      kind: 'confirm',
                      title: `Skip current ${label.toLowerCase()} step?`,
                      description:
                        'The current commit will not be applied. Its conflict resolutions will be discarded.',
                      label: 'Skip current commit',
                      action: { type: 'operationSkip' },
                      destructive: true,
                    })
                  }
                >
                  Skip…
                </Button>
              ) : null}
              <Button
                disabled={busy}
                size="sm"
                variant="secondary"
                tooltip={
                  stack
                    ? 'Abort local replay and restore saved local tips where safe. Already published remote effects are not undone.'
                    : 'Abort this operation and restore the pre-operation state locally. In-progress resolutions are discarded.'
                }
                onClick={() =>
                  onRequest({
                    kind: 'confirm',
                    title: `Abort ${label.toLowerCase()}?`,
                    description: stack
                      ? 'Abort the current rebase and restore saved local tips where safe. In-progress resolutions are discarded. Newer external changes are never overwritten. Already published branches, PR changes and native membership effects are not undone.'
                      : 'Restore the state before this operation. In-progress conflict resolutions will be discarded.',
                    label: `Abort ${label.toLowerCase()}`,
                    action: { type: stack ? 'stackAbort' : 'operationAbort' },
                    destructive: true,
                  })
                }
              >
                Abort…
              </Button>
            </>
          ) : null}
          {operation === 'other' ? (
            <span className="workflow-note">Finish the active Git operation in your terminal.</span>
          ) : null}
        </div>
      </section>
    </>
  )
}

export type DiffLineKind = 'add' | 'remove' | 'hunk'

/** Unified-diff markers drive the surface; the literal text is always preserved. */
export function diffLineKind(line: string): DiffLineKind | null {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'remove'
  if (line.startsWith('@@')) return 'hunk'
  return null
}

export function DiffView({ text, truncated = false }: { text: string; truncated?: boolean }) {
  const preview = React.useMemo(() => {
    const previewText = text.slice(0, 512 * 1024)
    const lines = previewText ? previewText.split('\n') : []
    if (previewText.endsWith('\n')) lines.pop()
    return { lines, clipped: text.length > 512 * 1024 }
  }, [text])
  const window_ = useListWindow(preview.lines, DIFF_PAGE_SIZE)
  const shown = window_.visible
  const counts = shown.reduce(
    (total, line) => {
      const kind = diffLineKind(line)
      if (kind === 'add') total.added += 1
      if (kind === 'remove') total.removed += 1
      return total
    },
    { added: 0, removed: 0 },
  )
  return (
    <div className="code-region">
      <div className="code-region-header">
        <strong>Unified diff</strong>
        <span className="code-region-meta">
          {text
            ? `${counts.added} added · ${counts.removed} removed · ${shown.length} of ${preview.lines.length} lines`
            : 'No textual diff'}
        </span>
        {truncated || preview.clipped ? <Badge variant="warning">truncated preview</Badge> : null}
      </div>
      {truncated || preview.clipped ? (
        <p className="code-region-note">
          This preview is truncated. Inspect the full change in your editor before applying it.
        </p>
      ) : null}
      <pre
        className="code-diff"
        role="region"
        tabIndex={0}
        aria-label={`Unified diff, ${shown.length} of ${preview.lines.length} lines shown`}
      >
        {text
          ? shown.map((line, index) => {
              const kind = diffLineKind(line)
              return (
                <span key={index} className={kind ? `diff-${kind}` : undefined}>
                  {line}
                  {'\n'}
                </span>
              )
            })
          : 'No textual diff in this view.'}
      </pre>
      <div className="list-window-controls">
        {window_.hasPrevious ? (
          <Button
            className="code-region-more"
            variant="secondary"
            size="sm"
            onClick={window_.retreat}
          >
            Show previous diff lines
          </Button>
        ) : null}
        {window_.hasMore ? (
          <Button
            className="code-region-more"
            variant="secondary"
            size="sm"
            onClick={window_.reveal}
          >
            Show more diff lines ({window_.remaining} remaining)
          </Button>
        ) : null}
      </div>
    </div>
  )
}
