import * as React from 'react'
import {
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  ExternalLink,
  Layers,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import type { Branch, Commit, FileView, RepositorySnapshot } from '../../../shared/types'
import { DIFF_PAGE_SIZE, LIST_PAGE_SIZE } from '../../../shared/performance'
import { useListWindow, useRovingListFocus } from '../lib/list-window'
import { createRequestGate } from '../lib/request-gate'
import { ListWindowMore } from './list-window'
import { actionBlockReason, submodulePathReason } from '../../../shared/capabilities'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'
import { InlineAlert } from './ui/surface'
import { Select } from './ui/select'
import { describeBranchRow, sortBranchesByUpdatedAt } from '../lib/branches'
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
import { BranchHoverCard, PullRequestHoverCard } from './repository-hover-cards'
import { HunkDiffView } from './hunk-diff'
import { ReconciliationPanel } from './reconciliation-view'

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
  const [file, setFile] = React.useState<FileView | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'working' | 'staged' | 'resolve'>('working')
  const [pending, setPending] = React.useState<'discard' | null>(null)
  const [revision, setRevision] = React.useState(0)
  React.useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setPending(null)
    window.desktop
      .fileView(path)
      .then((next) => {
        if (!active) return
        setFile(next)
        setTab(
          next.conflicted
            ? 'resolve'
            : next.unstagedDiff || !next.stagedDiff
              ? 'working'
              : 'staged',
        )
      })
      .catch((value) => {
        if (active) setError(workflowError(value))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      void window.desktop.cancel(`file:${path}`)
    }
  }, [path, snapshot, revision])

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
  const [commits, setCommits] = React.useState<Commit[]>([])
  const [hasMore, setHasMore] = React.useState(false)
  const [offset, setOffset] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<Commit | null>(null)
  const [diff, setDiff] = React.useState<{ text: string; truncated: boolean } | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [diffError, setDiffError] = React.useState<string | null>(null)
  const [revision, setRevision] = React.useState(0)
  // Two independent streams: the page of commits, and the diff of the selected
  // commit. Each gate retires its own superseded work, and each request is
  // cancelled in the main process rather than left to finish into a dead view.
  const historyGate = React.useRef(createRequestGate()).current
  const diffGate = React.useRef(createRequestGate()).current
  React.useEffect(() => {
    const claim = historyGate.claim()
    const requestId = `history:${ref}`
    setLoading(true)
    setError(null)
    setSelected(null)
    setCommits([])
    window.desktop
      .history(ref, offset, requestId)
      .then((page) => {
        if (!historyGate.current(claim)) return
        setCommits(page.commits)
        setHasMore(page.hasMore)
        setSelected(page.commits[0] ?? null)
      })
      .catch((value) => {
        if (historyGate.current(claim)) setError(workflowError(value))
      })
      .finally(() => {
        if (historyGate.current(claim)) setLoading(false)
      })
    return () => {
      historyGate.reset()
      void window.desktop.cancel(requestId)
    }
  }, [historyGate, snapshot.path, snapshot.headOid, ref, offset, revision])
  const selectedOid = selected?.oid
  React.useEffect(() => {
    const claim = diffGate.claim()
    setDiff(null)
    setDiffError(null)
    if (!selectedOid) {
      setDiffLoading(false)
      return
    }
    const requestId = `commit-diff:${selectedOid}`
    setDiffLoading(true)
    window.desktop
      .commitDiff(selectedOid, requestId)
      .then((value) => {
        if (diffGate.current(claim)) setDiff(value)
      })
      .catch((value) => {
        if (diffGate.current(claim)) setDiffError(workflowError(value))
      })
      .finally(() => {
        if (diffGate.current(claim)) setDiffLoading(false)
      })
    return () => {
      diffGate.reset()
      void window.desktop.cancel(requestId)
    }
  }, [diffGate, snapshot.path, selectedOid])
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
            {refName} · commits {offset + 1}–{offset + commits.length}
            {hasMore ? ' (more available)' : ''}
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
                onClick={() => setSelected(commit)}
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
                  <strong>{commit.subject}</strong>
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
        ) : visible.length === 0 ? (
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
              <strong>{selected.subject}</strong>
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

function stackRoot(branch: Branch, byName: Map<string, Branch>, defaultBranch: string): string {
  const seen = new Set<string>()
  let current = branch
  while (current.parent && current.parent !== defaultBranch) {
    if (seen.has(current.name)) return [...seen].sort()[0]
    seen.add(current.name)
    const parent = byName.get(current.parent)
    if (!parent) break
    current = parent
  }
  return current.name
}

export function StackView({
  actionError,
  onClearActionError,
  snapshot,
  busy,
  runAction,
  onRequest,
  onReviewNumber,
  onSelect,
  search,
  onCreate,
}: CommonProps & {
  actionError: string | null
  onClearActionError: () => void
  onSelect: (branch: Branch) => void
  search: string
  onCreate: () => void
  onReviewNumber: (number: number) => void
}) {
  const [selection, setSelection] = React.useState<string | null>(null)
  const { byName, groups } = React.useMemo(() => {
    const local = snapshot.branches.filter(
      (branch) => !branch.remote && branch.name !== snapshot.defaultBranch,
    )
    const byName = new Map(local.map((branch) => [branch.name, branch]))
    const groups = new Map<string, Branch[]>()
    for (const branch of local) {
      const root = stackRoot(branch, byName, snapshot.defaultBranch)
      const members = groups.get(root) ?? []
      members.push(branch)
      groups.set(root, members)
    }
    return { byName, groups }
  }, [snapshot.branches, snapshot.defaultBranch])
  const current = snapshot.currentBranch ? byName.get(snapshot.currentBranch) : null
  const root =
    selection && groups.has(selection)
      ? selection
      : current
        ? stackRoot(current, byName, snapshot.defaultBranch)
        : (groups.keys().next().value ?? null)
  const members = root ? (groups.get(root) ?? []) : []
  const ordered = React.useMemo(() => sortBranchesByUpdatedAt(members), [members])
  const visibleMembers = React.useMemo(
    () =>
      ordered.filter((branch) =>
        `${branch.name} ${branch.pr?.title ?? ''}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      ),
    [ordered, search],
  )
  const memberWindow = useListWindow(visibleMembers, LIST_PAGE_SIZE)
  const stale = members.filter(
    (branch) => branch.needsRestack || (branch.parentBehind ?? 0) > 0,
  ).length
  const unknown = members.filter(
    (branch) => branch.parent && branch.parentBehind === null && !branch.needsRestack,
  ).length
  const blocked = busy || !!snapshot.operation || !!snapshot.stackOperation
  // The stack rail is one composite widget, matching the branch tree and the
  // commit history list: one Tab stop, arrow keys between members.
  const memberRows = useRovingListFocus(memberWindow, '.stack-member-name')
  return (
    <div className="stacks-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1 id={WORKSPACE_VIEW_HEADING_ID} tabIndex={-1}>
            Stacks
          </h1>
          <span className="list-subtitle">
            {groups.size} local stack{groups.size === 1 ? '' : 's'}
            {snapshot.nativeStacks && snapshot.nativeStacks.length > 0
              ? ` · ${snapshot.nativeStacks.length} GitHub native stack${snapshot.nativeStacks.length === 1 ? '' : 's'}`
              : ''}
          </span>
        </div>
        <Button
          size="sm"
          variant="accent"
          disabled={blocked || Boolean(actionBlockReason(snapshot.capabilities, 'createBranch'))}
          tooltip={
            actionBlockReason(snapshot.capabilities, 'createBranch') ??
            'Create a local branch and switch to it.'
          }
          onClick={onCreate}
        >
          New branch
        </Button>
      </div>
      <ReconciliationPanel
        snapshot={snapshot}
        busy={busy}
        runAction={runAction}
        actionError={actionError}
        onClearActionError={onClearActionError}
      />
      {!root ? (
        <div className="empty-state">
          <Layers className="empty-icon" />
          <h2>Build a stack from a branch</h2>
          <p>
            Create a branch from your default branch, then add dependent branches. Existing branches
            can be adopted by setting their stack parent.
          </p>
          <Button
            variant="accent"
            disabled={blocked || Boolean(actionBlockReason(snapshot.capabilities, 'createBranch'))}
            tooltip={
              actionBlockReason(snapshot.capabilities, 'createBranch') ??
              'Create a local branch and switch to it.'
            }
            onClick={onCreate}
          >
            Create a stack branch
          </Button>
        </div>
      ) : (
        <>
          <div className="stack-workspace-header">
            <label htmlFor="stack-selection">Stack root</label>
            <Select
              id="stack-selection"
              className="workflow-select"
              value={root}
              onValueChange={(value) => {
                setSelection(value)
                const branch = byName.get(value)
                if (branch) onSelect(branch)
              }}
              options={[...groups].map(([name, branches]) => ({
                value: name,
                label: `${name} · ${branches.length} branch${branches.length === 1 ? '' : 'es'}`,
              }))}
            />
            <p>
              {stale || unknown
                ? [
                    stale
                      ? `${stale} branch${stale === 1 ? ' requires' : 'es require'} restacking.`
                      : '',
                    unknown
                      ? `${unknown} parent comparison${unknown === 1 ? ' is' : 's are'} unavailable. Check ancestry before publishing.`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                : 'Review the stack, publish its PRs, and merge from the base upward.'}
            </p>
            <div className="workflow-row">
              <Button
                size="sm"
                variant={stale ? 'accent' : 'secondary'}
                disabled={
                  blocked || Boolean(actionBlockReason(snapshot.capabilities, 'executeStack'))
                }
                onClick={() => onRequest({ kind: 'stack', branch: root, operation: 'restack' })}
                tooltip={
                  actionBlockReason(snapshot.capabilities, 'executeStack') ??
                  'Preview parent-first rebases of this stack. Publishing is a separate step.'
                }
              >
                <RefreshCw className="size-3.5" />
                Restack…
              </Button>
              <Button
                size="sm"
                variant={stale || unknown ? 'secondary' : 'accent'}
                disabled={
                  blocked ||
                  !snapshot.github.available ||
                  Boolean(actionBlockReason(snapshot.capabilities, 'executeStack'))
                }
                onClick={() => onRequest({ kind: 'stack', branch: root, operation: 'publish' })}
                tooltip={
                  actionBlockReason(snapshot.capabilities, 'executeStack') ??
                  (snapshot.github.available
                    ? 'Push reviewed branches and update their pull requests without restacking.'
                    : snapshot.github.message ||
                      'Connect an authenticated GitHub repository to publish.')
                }
              >
                <Upload className="size-3.5" />
                Publish stack…
              </Button>
            </div>
          </div>
          {!snapshot.github.available ? (
            <p className="workflow-note stack-github-note">
              {snapshot.github.message} Local parent management and restacking remain available.
            </p>
          ) : snapshot.nativeStackPreviewAvailable === false ? (
            <p className="workflow-note stack-github-note">
              {snapshot.nativeStackMessage ??
                'GitHub native stacked pull requests preview API is unavailable; degraded to chained PRs.'}{' '}
              Local parent management and restacking remain available.
            </p>
          ) : null}
          <div
            aria-label="Stack branches, children above parents"
            className="stack-members"
            ref={memberRows.containerRef}
            role="list"
          >
            {memberWindow.visible.map((branch, memberIndex) => (
              <div className="stack-member" key={branch.ref} role="listitem">
                <div className="stack-member-heading">
                  <BranchHoverCard branch={branch}>
                    <Button
                      variant="unstyled"
                      aria-label={describeBranchRow({
                        ahead: branch.ahead,
                        behind: branch.behind,
                        checks: branch.pr?.checks ?? null,
                        current: branch.current,
                        cycle: false,
                        missingParent: false,
                        name: branch.name,
                        pullRequestNumber: branch.pr?.number ?? null,
                        remote: branch.remote,
                        requiresRestack: branch.needsRestack || (branch.parentBehind ?? 0) > 0,
                        upstream: branch.upstream,
                      })}
                      className="stack-member-name"
                      onClick={() => onSelect(branch)}
                      onFocus={() => memberRows.noteFocus(memberIndex)}
                      onKeyDown={(event) => {
                        // Only unmodified keys are claimed; a chord belongs to the
                        // global shortcut dispatcher.
                        if (!claimsRovingKey(event)) return
                        const action = rovingAction(event.key)
                        if (!action) return
                        // Up/Down walk the mounted members in mounted coordinates;
                        // Home and End name the first and last member of the whole
                        // filtered rail, which can sit outside the mounted window.
                        const wholeList = action === 'first' || action === 'last'
                        const target = wholeList
                          ? rovingTarget(
                              action,
                              memberIndex + memberWindow.start,
                              visibleMembers.length,
                            )
                          : rovingTarget(action, memberIndex, memberWindow.visible.length)
                        if (target === null) return
                        event.preventDefault()
                        if (wholeList) memberRows.focusListIndex(target)
                        else memberRows.focusMounted(target)
                      }}
                      tabIndex={rovingTabIndex(memberIndex, memberRows.activeIndex)}
                    >
                      <GitBranch className="size-4" />
                      <strong>{branch.name}</strong>
                      <ChevronRight className="size-3.5" />
                    </Button>
                  </BranchHoverCard>
                  {branch.current ? <Badge variant="accent">current</Badge> : null}
                  {branch.needsRestack || (branch.parentBehind ?? 0) > 0 ? (
                    <Badge variant="warning">Requires restack</Badge>
                  ) : branch.parent && branch.parentBehind === null ? (
                    <Badge variant="secondary">Parent comparison unavailable</Badge>
                  ) : null}
                </div>
                <div className="stack-member-meta">
                  <span>
                    Parent: <strong>{branch.parent ?? 'Not set'}</strong>
                  </span>
                  <span>
                    {branch.parentSource === 'recorded'
                      ? 'Recorded parent'
                      : branch.parentSource === 'stack'
                        ? 'GitHub native stack'
                        : branch.parentSource === 'pullRequest'
                          ? 'From PR base'
                          : 'Inferred — confirm before publishing'}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      blocked || Boolean(actionBlockReason(snapshot.capabilities, 'setParent'))
                    }
                    tooltip={
                      actionBlockReason(snapshot.capabilities, 'setParent') ??
                      'Record the intended parent locally without rewriting commits. Preview Restack next to move this branch and descendants.'
                    }
                    onClick={() => onRequest({ kind: 'parent', branch })}
                  >
                    Set parent…
                  </Button>
                </div>
                {branch.pr ? (
                  <div className="stack-pr-row">
                    <PullRequestHoverCard pr={branch.pr}>
                      <Button
                        size="sm"
                        variant="link"
                        disabled={busy}
                        onClick={() => onReviewNumber(branch.pr!.number)}
                      >
                        #{branch.pr.number} {branch.pr.title}
                      </Button>
                    </PullRequestHoverCard>
                    <div className="workflow-row">
                      {branch.pr.stack ? (
                        <Badge variant="accent">
                          Stack #{branch.pr.stack.stackNumber} ({branch.pr.stack.position}/
                          {branch.pr.stack.size})
                        </Badge>
                      ) : null}
                      <Badge variant={branch.pr.state === 'MERGED' ? 'accent' : 'secondary'}>
                        {branch.pr.draft ? 'draft' : branch.pr.state.toLowerCase()}
                      </Badge>
                      <Badge
                        variant={
                          branch.pr.checks === 'failing'
                            ? 'danger'
                            : branch.pr.checks === 'passing'
                              ? 'success'
                              : 'secondary'
                        }
                      >
                        {branch.pr.checks === 'none' ? 'No checks' : `Checks ${branch.pr.checks}`}
                      </Badge>
                      <span className="workflow-note">
                        {branch.pr.reviewDecision?.replaceAll('_', ' ').toLowerCase() ||
                          'No review decision'}
                      </span>
                    </div>
                    {branch.pr.state === 'OPEN' && branch.pr.base === snapshot.defaultBranch ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={
                          blocked ||
                          Boolean(actionBlockReason(snapshot.capabilities, 'executeStack'))
                        }
                        tooltip={
                          actionBlockReason(snapshot.capabilities, 'executeStack') ??
                          'Preview merging this pull request into the default branch. Nothing is merged until confirmed; remaining branches still need restack and publish.'
                        }
                        onClick={() =>
                          onRequest({ kind: 'stack', branch: branch.name, operation: 'merge' })
                        }
                      >
                        <GitMerge className="size-3.5" />
                        Preview merge
                      </Button>
                    ) : branch.pr.state === 'MERGED' ? (
                      <p className="workflow-note">
                        Merged parent: restack remaining branches, then publish their updated bases.
                      </p>
                    ) : (
                      <p className="workflow-note">
                        Merge the parent PR first, then restack and publish this branch.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="workflow-note">No pull request. Publish the stack to create one.</p>
                )}
              </div>
            ))}
          </div>
          <ListWindowMore
            pageSize={LIST_PAGE_SIZE}
            remaining={memberWindow.remaining}
            previous={memberWindow.hasPrevious}
            noun="stack branches"
            onReveal={memberWindow.reveal}
            onPrevious={memberWindow.retreat}
          />
        </>
      )}
    </div>
  )
}
