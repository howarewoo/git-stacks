import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { RepositorySnapshot } from '@git-stacks/shared/types'
import { DIFF_PAGE_SIZE, LIST_PAGE_SIZE } from '@git-stacks/shared/performance'
import { useListWindow, useRovingListFocus } from '../lib/list-window'
import { createRequestGate } from '../lib/request-gate'
import { ListWindowMore } from './list-window'
import { actionBlockReason, submodulePathReason } from '@git-stacks/shared/capabilities'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'
import { EmptyState, InlineAlert } from './ui/surface'
import { Select } from './ui/select'
import {
  claimsRovingKey,
  clampRovingIndex,
  rovingAction,
  rovingTabIndex,
  rovingTarget,
} from '../lib/tree-navigation'
import { WORKSPACE_VIEW_HEADING_ID } from './workspace-navigation'
import { workflowError, type RunAction, type WorkflowRequest } from './workflow-dialog'
import { PhaseStatus, WorkflowActions } from './workflow-composition'
import { partialProgress, workflowPhase } from './workflow-policy'
import { HunkDiffView } from './hunk-diff'

type CommonProps = {
  snapshot: RepositorySnapshot
  busy: boolean
  runAction: RunAction
  onRequest: (request: WorkflowRequest) => void
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
}: CommonProps & { onShowChanges: () => void; onResolveConflict: (path: string) => void }) {
  const operation = snapshot.operation
  const stack = snapshot.stackOperation
  const conflicts = snapshot.files.filter((file) => file.conflicted).length
  const firstConflict = snapshot.files.find((file) => file.conflicted)?.path ?? null
  if (!operation && !stack && !conflicts) return null
  const label = stack
    ? 'Stack restack'
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
  const phase = workflowPhase({
    loading: false,
    busy: false,
    failed: false,
    stale: false,
    finished: progress !== null && progress.remaining === 0,
    partial: progress !== null && progress.completed > 0 && progress.remaining > 0,
    blocked: resumable && conflicts > 0,
  })
  const message =
    conflicts > 0
      ? `${conflicts} conflicted file${conflicts === 1 ? '' : 's'}. Resolve and stage each file before continuing.`
      : progress
        ? `${progress.summary}. ${progress.message}`
        : 'Review the working tree, then continue or abort.'
  return (
    <section className="operation-banner" aria-label="Git operation status">
      <PhaseStatus
        phase={phase}
        title={`${label} ${operation || stack ? 'in progress' : 'need attention'}`}
        message={message}
        className="operation-status"
      />
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
              variant="accent"
              tooltip={
                conflicts > 0
                  ? 'Blocked until every conflicted file is resolved and staged.'
                  : stack
                    ? 'Resume the stack restack locally using staged resolutions.'
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
            {!stack && ['rebase', 'cherryPick', 'revert'].includes(operation ?? '') ? (
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
                  ? 'Abort the restack and restore completed branches to their saved tips. In-progress resolutions are discarded; changed external refs stop the rollback.'
                  : 'Abort this operation and restore the pre-operation state locally. In-progress resolutions are discarded.'
              }
              onClick={() =>
                onRequest({
                  kind: 'confirm',
                  title: `Abort ${label.toLowerCase()}?`,
                  description: stack
                    ? 'Abort the current rebase and restore completed stack branches to their saved tips. In-progress conflict resolutions will be discarded. Newer external changes are never overwritten.'
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

export function FileInspector({
  snapshot,
  path,
  busy,
  runAction,
  onClose,
  onResolveConflict,
  actionError,
  onOpenInEditor,
}: Omit<CommonProps, 'onRequest'> & {
  path: string
  onClose: () => void
  onResolveConflict: (path: string) => void
  actionError: string | null
  /** Opens the file in the editor configured in Settings. */
  onOpenInEditor?: (relativePath: string) => void
}) {
  const [revision, setRevision] = React.useState(0)
  const freshness = React.useRef({ snapshot, generation: 0 })
  if (freshness.current.snapshot !== snapshot) {
    freshness.current = { snapshot, generation: freshness.current.generation + 1 }
  }
  const fileQuery = useQuery({
    queryKey: ['repository-file', snapshot.path, path, freshness.current.generation, revision],
    queryFn: ({ signal }) => {
      signal.addEventListener('abort', () => void window.desktop.cancel(`file:${path}`), {
        once: true,
      })
      return window.desktop.fileView(path)
    },
  })
  const file = fileQuery.data ?? null
  const loading = fileQuery.isFetching
  const error = fileQuery.error ? workflowError(fileQuery.error) : null
  const [tab, setTab] = React.useState<'working' | 'staged' | 'resolve'>('working')
  const [pending, setPending] = React.useState<'discard' | null>(null)
  React.useEffect(() => {
    setPending(null)
    if (!file) return
    setTab(
      file.conflicted ? 'resolve' : file.unstagedDiff || !file.stagedDiff ? 'working' : 'staged',
    )
  }, [file])

  const discard = async () => {
    if (!file || file.submodule || busy || loading) return
    if (
      await runAction(
        { type: 'discardFile', path, fingerprint: file.fingerprint },
        'Discard unstaged file changes',
      )
    )
      onClose()
  }
  const state = snapshot.files.find((item) => item.path === path)
  const canDiscard = state && !state.conflicted && (state.worktree !== ' ' || state.index === '?')
  const submoduleReason = file?.submodule ? submodulePathReason(path) : null
  const tabOptions = (
    [
      { value: 'working', label: 'Working tree' },
      { value: 'staged', label: 'Staged' },
      ...(file?.conflicted ? [{ value: 'resolve' as const, label: 'Resolve conflict' }] : []),
    ] as { value: 'working' | 'staged' | 'resolve'; label: string }[]
  ).filter((option) => option.value !== 'resolve' || file?.conflicted)
  return (
    <section className="file-inspector" aria-label={`Inspect ${path}`}>
      <header className="inspector-heading">
        <div className="inspector-title">
          <strong title={path}>{path}</strong>
          <small>
            {file?.conflicted
              ? 'Conflicted — resolve before staging'
              : (state?.index ?? ' ') === '?'
                ? 'Untracked file'
                : 'Working tree and index'}
          </small>
        </div>
        <div className="workflow-row">
          {onOpenInEditor ? (
            <Button
              aria-label="Open in editor"
              size="icon-sm"
              variant="ghost"
              disabled={busy || loading || Boolean(file?.lfs)}
              title={
                file?.lfs
                  ? 'This is an LFS pointer, not the file contents'
                  : 'Open this file in the editor configured in Settings'
              }
              onClick={() => onOpenInEditor(path)}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          ) : null}
          <Button
            aria-label="Reload file"
            size="icon-sm"
            variant="ghost"
            disabled={busy || loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            aria-label="Close file inspector"
            size="icon-sm"
            variant="ghost"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>
      {loading ? (
        <p className="workflow-loading" role="status">
          <LoaderCircle className="size-4 animate-spin" />
          Reading file and index…
        </p>
      ) : error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : file ? (
        <>
          {file.lfs ? (
            <InlineAlert className="mx-4 mt-3" title="Git LFS pointer, not object content">
              Object sha256:{file.lfs.oid} · {file.lfs.size.toLocaleString()} bytes. Git Stacks does
              not check whether the object is available locally; use Git LFS to retrieve it.
            </InlineAlert>
          ) : null}
          <div className="inspector-tabs">
            <SegmentedControl
              className="inspector-tab-control"
              label="File views"
              onValueChange={(value) => setTab(value)}
              options={tabOptions}
              value={tab}
            />
          </div>
          {tab === 'resolve' ? (
            <div className="conflict-editor dialog-form">
              <p className="workflow-note">
                The resolver reads index stages 1, 2, and 3 for this path, names both sides the way
                the active Git operation means them, and stages a result only after the file it
                showed is still the file on disk.
              </p>
              <Button
                variant="accent"
                disabled={busy}
                tooltip="Open the three-way resolver for this file. Nothing is staged until you mark the conflict resolved there."
                onClick={() => onResolveConflict(path)}
              >
                Open conflict resolver
              </Button>
            </div>
          ) : tab === 'working' && state?.index === '?' ? (
            <div className="code-region">
              <div className="code-region-header">
                <strong>Untracked file content</strong>
                <span className="code-region-meta">Not staged</span>
                {file.truncated ? <Badge variant="warning">truncated preview</Badge> : null}
              </div>
              {file.truncated ? (
                <p className="code-region-note">
                  This preview is truncated. Inspect the full file in your editor before discarding
                  it.
                </p>
              ) : null}
              <pre
                className="code-diff"
                role="region"
                tabIndex={0}
                aria-label="Untracked file content"
              >
                {file.binary
                  ? 'Binary or non-UTF-8 file. A text preview is not available.'
                  : (file.content ?? 'No file content available.')}
              </pre>
            </div>
          ) : (
            <>
              <HunkDiffView
                key={`${file.path}:${tab}`}
                side={tab === 'staged' ? file.hunks.staged : file.hunks.unstaged}
                sideName={tab === 'staged' ? 'staged' : 'unstaged'}
                busy={busy || loading}
                onApply={(selection) =>
                  runAction(
                    {
                      type: tab === 'staged' ? 'unstageHunk' : 'stageHunk',
                      path: file.path,
                      fingerprint: file.fingerprint,
                      ...selection,
                    },
                    tab === 'staged' ? 'Unstage hunk' : 'Stage hunk',
                  )
                }
              />
              {(tab === 'staged' ? file.hunks.staged : file.hunks.unstaged).unavailable &&
              (tab === 'staged' ? file.stagedDiff : file.unstagedDiff) ? (
                <DiffView
                  text={tab === 'staged' ? file.stagedDiff : file.unstagedDiff}
                  truncated={file.truncated}
                />
              ) : null}
            </>
          )}
          {canDiscard && tab === 'working' ? (
            <div className="inspector-actions">
              <Button
                size="sm"
                variant="danger"
                disabled={busy || Boolean(submoduleReason)}
                tooltip={
                  submoduleReason ??
                  'Discard unstaged working-tree changes only; staged content is kept. Untracked files are deleted and cannot be recovered through Git.'
                }
                onClick={() => setPending('discard')}
              >
                Discard unstaged changes…
              </Button>
              <span className="workflow-note">
                {submoduleReason ?? 'Staged content is preserved.'}
              </span>
            </div>
          ) : null}
          {pending ? (
            <div className="inline-confirm" data-composition="destructive">
              <PhaseStatus
                phase="blocked"
                message="Discard the displayed unstaged changes? An untracked file will be deleted. This cannot be undone through Git."
              />
              <WorkflowActions>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setPending(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  tooltip="Confirm discarding the displayed unstaged changes. Untracked files are deleted and cannot be recovered through Git."
                  onClick={discard}
                >
                  Confirm discard
                </Button>
              </WorkflowActions>
            </div>
          ) : null}
          {actionError ? (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

export function HistoryView({
  snapshot,
  busy,
  onRequest,
  search,
}: Omit<CommonProps, 'runAction'> & { search: string }) {
  const [ref, setRef] = React.useState(
    snapshot.currentBranch ? `refs/heads/${snapshot.currentBranch}` : 'HEAD',
  )
  const [offset, setOffset] = React.useState(0)
  const [selection, setSelection] = React.useState<{ scope: string; oid: string } | null>(null)
  const [revision, setRevision] = React.useState(0)
  const selectionScope = JSON.stringify([snapshot.path, snapshot.headOid, ref, offset, revision])
  // Two independent streams: the page of commits, and the diff of the selected
  // commit. Each gate retires its own superseded work, and each request is
  // cancelled in the main process rather than left to finish into a dead view.
  const historyGate = React.useRef(createRequestGate()).current
  const diffGate = React.useRef(createRequestGate()).current
  const historyQuery = useQuery({
    queryKey: ['repository-history', snapshot.path, snapshot.headOid, ref, offset, revision],
    queryFn: async ({ signal }) => {
      const claim = historyGate.claim()
      const requestId = `history:${ref}`
      signal.addEventListener(
        'abort',
        () => {
          historyGate.reset()
          void window.desktop.cancel(requestId)
        },
        { once: true },
      )
      const page = await window.desktop.history(ref, offset, requestId)
      if (!historyGate.current(claim)) throw new Error('History request superseded.')
      return page
    },
  })
  const commits = historyQuery.data?.commits ?? []
  const hasMore = historyQuery.data?.hasMore ?? false
  const loading = historyQuery.isFetching
  const error = historyQuery.error ? workflowError(historyQuery.error) : null
  const selected =
    (selection?.scope === selectionScope
      ? commits.find((commit) => commit.oid === selection.oid)
      : null) ??
    commits[0] ??
    null
  const selectedOid = selected?.oid
  const diffQuery = useQuery({
    queryKey: ['repository-commit-diff', snapshot.path, selectedOid],
    enabled: Boolean(selectedOid),
    queryFn: async ({ signal }) => {
      const claim = diffGate.claim()
      const requestId = `commit-diff:${selectedOid}`
      signal.addEventListener(
        'abort',
        () => {
          diffGate.reset()
          void window.desktop.cancel(requestId)
        },
        { once: true },
      )
      const value = await window.desktop.commitDiff(selectedOid!, requestId)
      if (!diffGate.current(claim)) throw new Error('Commit diff request superseded.')
      return value
    },
  })
  const diff = selectedOid ? (diffQuery.data ?? null) : null
  const diffLoading = diffQuery.isFetching
  const diffError = diffQuery.error ? workflowError(diffQuery.error) : null
  const loadMore = () => {
    if (loading || diffLoading || busy || commits.length === 0) return
    setOffset((value) => value + commits.length)
  }
  const visible = React.useMemo(
    () =>
      commits.filter((commit) =>
        `${commit.subject} ${commit.author} ${commit.oid}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      ),
    [commits, search],
  )
  // The commit list is one composite widget: a single Tab stop with arrow-key
  // movement, matching the branch tree and the stack rail.
  const [activeCommitIndex, setActiveCommitIndex] = React.useState(0)
  const commitListRef = React.useRef<HTMLDivElement>(null)
  const focusCommit = (index: number) => {
    const row = commitListRef.current?.querySelectorAll<HTMLButtonElement>('.history-row')[index]
    if (!row) return
    setActiveCommitIndex(index)
    row.focus()
  }
  React.useEffect(() => {
    setActiveCommitIndex((index) => clampRovingIndex(index, visible.length))
  }, [visible.length])
  const actionable =
    !busy &&
    !snapshot.operation &&
    !snapshot.stackOperation &&
    !!snapshot.currentBranch &&
    !!snapshot.headOid &&
    snapshot.files.length === 0
  const refName = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
  return (
    <div className="history-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1 id={WORKSPACE_VIEW_HEADING_ID} tabIndex={-1}>
            History
          </h1>
          <span className="list-subtitle">
            <code>{refName}</code> ·{' '}
            {loading
              ? 'Loading commits…'
              : error
                ? 'History unavailable'
                : commits.length > 0
                  ? `commits ${offset + 1}–${offset + commits.length}${hasMore ? ' (more available)' : ''}`
                  : 'No commits'}
          </span>
        </div>
        <div className="workflow-row">
          <label className="sr-only" htmlFor="history-ref">
            History branch
          </label>
          <Select
            className="workflow-select w-auto"
            id="history-ref"
            controlSize="compact"
            disabled={busy || loading || diffLoading}
            value={ref}
            onValueChange={(value) => {
              setOffset(0)
              setRef(value)
            }}
            options={[
              ...(!snapshot.branches.some((branch) => branch.ref === ref)
                ? [{ value: ref, label: ref }]
                : []),
              ...snapshot.branches.map((branch) => ({ value: branch.ref, label: branch.name })),
            ]}
          />
          <Button
            aria-label="Reload history"
            variant="ghost"
            size="icon-sm"
            disabled={busy || loading || diffLoading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
      {error ? (
        <p className="form-error history-message" role="alert">
          {error}
        </p>
      ) : null}
      <div className="history-list">
        <div className="history-entries" role="list" aria-label="Commits" ref={commitListRef}>
          {visible.map((commit, commitIndex) => (
            <div className="history-item" key={commit.oid} role="listitem">
              <Button
                aria-current={selected?.oid === commit.oid ? 'true' : undefined}
                className={`history-row ${selected?.oid === commit.oid ? 'history-row-selected' : ''}`}
                variant="unstyled"
                disabled={diffLoading}
                onClick={() => setSelection({ scope: selectionScope, oid: commit.oid })}
                onFocus={() => setActiveCommitIndex(commitIndex)}
                onKeyDown={(event) => {
                  // Only unmodified keys are claimed; a chord belongs to the global
                  // shortcut dispatcher.
                  if (!claimsRovingKey(event)) return
                  const action = rovingAction(event.key)
                  if (!action) return
                  const target = rovingTarget(action, commitIndex, visible.length)
                  if (target === null) return
                  event.preventDefault()
                  focusCommit(target)
                }}
                tabIndex={rovingTabIndex(commitIndex, activeCommitIndex)}
              >
                <GitCommitHorizontal className="size-4" />
                <span className="history-copy">
                  <strong title={commit.subject}>{commit.subject}</strong>
                  <small>
                    {commit.author} · {new Date(commit.date).toLocaleDateString()}
                  </small>
                </span>
                <code className="history-oid">{commit.oid.slice(0, 8)}</code>
              </Button>
            </div>
          ))}
        </div>
        {loading ? (
          <p className="workflow-loading" role="status">
            <LoaderCircle className="size-4 animate-spin" />
            Loading commits…
          </p>
        ) : !error && visible.length === 0 ? (
          <p className="section-empty">
            {search
              ? 'No matching loaded commits. Load more history or change your search.'
              : 'No commits in this history yet.'}
          </p>
        ) : null}
        {offset > 0 ? (
          <Button
            className="history-more"
            size="sm"
            variant="ghost"
            disabled={loading || busy || diffLoading}
            onClick={() => setOffset((value) => Math.max(0, value - 50))}
          >
            Load newer commits
          </Button>
        ) : null}
        {hasMore ? (
          <Button
            className="history-more"
            size="sm"
            variant="ghost"
            disabled={loading || busy || diffLoading}
            onClick={loadMore}
          >
            Load older commits
          </Button>
        ) : null}
      </div>
      {selected ? (
        <section className="commit-inspector" aria-label="Selected commit">
          <header className="inspector-heading">
            <div className="inspector-title">
              <strong className="commit-subject">{selected.subject}</strong>
              <small>
                {selected.author} · {new Date(selected.date).toLocaleDateString()}
              </small>
              <code>{selected.oid}</code>
            </div>
            <div className="workflow-row">
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  !actionable ||
                  diffLoading ||
                  Boolean(actionBlockReason(snapshot.capabilities, 'cherryPick'))
                }
                tooltip={
                  actionBlockReason(snapshot.capabilities, 'cherryPick') ??
                  `Copy this commit onto ${snapshot.currentBranch ?? 'the current branch'} locally as a new commit. Remote branches stay unchanged until pushed.`
                }
                onClick={() =>
                  onRequest({ kind: 'commitAction', commit: selected, mode: 'cherryPick' })
                }
              >
                Cherry-pick…
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  !actionable ||
                  diffLoading ||
                  Boolean(actionBlockReason(snapshot.capabilities, 'revert'))
                }
                tooltip={
                  actionBlockReason(snapshot.capabilities, 'revert') ??
                  `Create a new local commit on ${snapshot.currentBranch ?? 'the current branch'} that undoes this commit. Original history is kept; remote stays unchanged until pushed.`
                }
                onClick={() =>
                  onRequest({ kind: 'commitAction', commit: selected, mode: 'revert' })
                }
              >
                Revert…
              </Button>
            </div>
          </header>
          <p className="workflow-note history-message history-target">
            {actionable
              ? 'Cherry-pick and revert apply to the current branch'
              : 'Commit actions are blocked'}{' '}
            <strong>{snapshot.currentBranch ?? 'no branch attached'}</strong>
            {!actionable
              ? '. They require a clean working tree, an attached branch, and no active operation.'
              : '. The remote stays unchanged until you push.'}
          </p>
          {diffLoading ? (
            <p className="workflow-loading" role="status">
              <LoaderCircle className="size-4 animate-spin" />
              Reading commit diff…
            </p>
          ) : diffError ? (
            <p className="form-error history-message" role="alert">
              {diffError}
            </p>
          ) : diff ? (
            <DiffView {...diff} />
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
