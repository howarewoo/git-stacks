import * as React from 'react'
import {
  Check,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Layers,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import type { Branch, Commit, FileView, RepositorySnapshot } from '../../../shared/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { sortBranchesByUpdatedAt } from '../lib/branches'
import { workflowError, type RunAction, type WorkflowRequest } from './workflow-dialog'

type CommonProps = {
  snapshot: RepositorySnapshot
  busy: boolean
  runAction: RunAction
  onRequest: (request: WorkflowRequest) => void
}

export function OperationBanner({
  snapshot,
  busy,
  runAction,
  onRequest,
  onShowChanges,
}: CommonProps & { onShowChanges: () => void }) {
  const operation = snapshot.operation
  const stack = snapshot.stackOperation
  const conflicts = snapshot.files.filter((file) => file.conflicted).length
  if (!operation && !stack && !conflicts) return null
  const label = stack
    ? 'Stack restack'
    : operation === 'cherryPick'
      ? 'Cherry-pick'
      : operation
        ? operation.charAt(0).toUpperCase() + operation.slice(1)
        : 'Conflicts'
  return (
    <div className="operation-banner" role="status">
      <TriangleAlert className="size-4" />
      <div className="operation-copy">
        <strong>
          {label}
          {operation || stack ? ' in progress' : ' need attention'}
        </strong>
        <span>
          {stack
            ? `${stack.completed.length} completed · ${stack.remaining.length} remaining. ${stack.message}`
            : conflicts
              ? `${conflicts} conflicted file${conflicts === 1 ? '' : 's'}. Resolve and stage each file before continuing.`
              : 'Review the working tree, then continue or abort.'}
        </span>
      </div>
      <div className="workflow-row">
        <Button size="sm" variant="secondary" onClick={onShowChanges}>
          View changes
        </Button>
        {stack || (operation && operation !== 'other') ? (
          <>
            <Button
              disabled={busy || conflicts > 0}
              size="sm"
              variant="accent"
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
    </div>
  )
}

export function DiffView({ text, truncated = false }: { text: string; truncated?: boolean }) {
  const preview = React.useMemo(
    () => ({ lines: text.slice(0, 512 * 1024).split('\n'), clipped: text.length > 512 * 1024 }),
    [text],
  )
  const [visibleLines, setVisibleLines] = React.useState(1000)
  React.useEffect(() => setVisibleLines(1000), [text])
  return (
    <>
      {truncated || preview.clipped ? (
        <p className="workflow-warning">
          This preview is truncated. Inspect the full change in your editor before applying it.
        </p>
      ) : null}
      <pre className="code-diff" tabIndex={0} aria-label="Unified diff">
        {text
          ? preview.lines.slice(0, visibleLines).map((line, index) => (
              <span
                key={index}
                className={
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'diff-add'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'diff-remove'
                      : line.startsWith('@@')
                        ? 'diff-hunk'
                        : undefined
                }
              >
                {line}
                {'\n'}
              </span>
            ))
          : 'No textual diff in this view.'}
      </pre>
      {preview.lines.length > visibleLines ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setVisibleLines((value) => value + 1000)}
        >
          Show more diff lines ({preview.lines.length - visibleLines} remaining)
        </Button>
      ) : null}
    </>
  )
}

export function FileInspector({
  snapshot,
  path,
  busy,
  runAction,
  onClose,
  actionError,
}: Omit<CommonProps, 'onRequest'> & {
  path: string
  onClose: () => void
  actionError: string | null
}) {
  const [file, setFile] = React.useState<FileView | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'working' | 'staged' | 'resolve'>('working')
  const [content, setContent] = React.useState('')
  const [pending, setPending] = React.useState<'discard' | 'ours' | 'theirs' | null>(null)
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
        setContent(next.content ?? '')
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
    }
  }, [path, snapshot, revision])
  const resolve = async (strategy: 'ours' | 'theirs' | 'manual') => {
    if (!file || busy || loading) return
    const success = await runAction(
      {
        type: 'resolveFile',
        path,
        fingerprint: file.fingerprint,
        strategy,
        content: strategy === 'manual' ? content : '',
      },
      'Resolve and stage file',
    )
    if (success) setPending(null)
  }
  const discard = async () => {
    if (!file || busy || loading) return
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
  const rebase = snapshot.operation === 'rebase'
  return (
    <section className="file-inspector" aria-label={`Inspect ${path}`}>
      <header className="inspector-heading">
        <strong title={path}>{path}</strong>
        <div className="workflow-row">
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
          <div className="inspector-tabs" aria-label="File views">
            {(['working', 'staged', ...(file.conflicted ? ['resolve'] : [])] as const).map(
              (value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={tab === value ? 'subtle' : 'ghost'}
                  aria-pressed={tab === value}
                  onClick={() => setTab(value as typeof tab)}
                >
                  {value === 'working'
                    ? 'Working tree'
                    : value === 'staged'
                      ? 'Staged'
                      : 'Resolve conflict'}
                </Button>
              ),
            )}
          </div>
          {tab === 'resolve' ? (
            <div className="conflict-editor dialog-form">
              <p className="workflow-note">
                {rebase
                  ? 'During rebase, “ours” is the new base; “theirs” is the commit being replayed.'
                  : '“Ours” is the current branch; “theirs” is the incoming version. A deleted side resolves by deleting the file.'}
              </p>
              <div className="workflow-row">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setPending('ours')}
                >
                  {rebase ? 'Use new base (ours)…' : 'Use ours…'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setPending('theirs')}
                >
                  {rebase ? 'Use replayed commit (theirs)…' : 'Use theirs…'}
                </Button>
              </div>
              {file.content !== null && !file.binary && !file.truncated ? (
                <>
                  <label htmlFor="conflict-content">Edit the resolved file</label>
                  <textarea
                    id="conflict-content"
                    className="conflict-content"
                    rows={12}
                    spellCheck={false}
                    value={content}
                    disabled={busy}
                    onChange={(event) => setContent(event.target.value)}
                  />
                  <p className="workflow-note">
                    Remove conflict markers, keep the intended content, then save and stage.
                  </p>
                  <Button variant="accent" disabled={busy} onClick={() => resolve('manual')}>
                    <Check className="size-3.5" />
                    Save and stage resolution
                  </Button>
                </>
              ) : (
                <p className="workflow-note">
                  This file cannot be safely edited as text here. Choose a side, or resolve it in
                  your editor and stage it.
                </p>
              )}
            </div>
          ) : tab === 'working' && state?.index === '?' ? (
            <>
              <p className="workflow-note">Untracked file contents — not yet staged.</p>
              {file.truncated ? (
                <p className="workflow-warning">
                  This preview is truncated. Inspect the full file in your editor before discarding
                  it.
                </p>
              ) : null}
              <pre className="code-diff" tabIndex={0} aria-label="Untracked file content">
                {file.binary
                  ? 'Binary or non-UTF-8 file. A text preview is not available.'
                  : (file.content ?? 'No file content available.')}
              </pre>
            </>
          ) : (
            <DiffView
              text={tab === 'staged' ? file.stagedDiff : file.unstagedDiff}
              truncated={file.truncated}
            />
          )}
          {canDiscard && tab === 'working' ? (
            <div className="inspector-actions">
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => setPending('discard')}
              >
                Discard unstaged changes…
              </Button>
              <span className="workflow-note">Staged content is preserved.</span>
            </div>
          ) : null}
          {pending ? (
            <div className="inline-confirm" role="alert">
              <p>
                {pending === 'discard'
                  ? 'Discard the displayed unstaged changes? An untracked file will be deleted. This cannot be undone through Git.'
                  : `Replace this conflicted file with the ${pending} version and stage it? Manual edits to the file will be replaced.`}
              </p>
              <div className="workflow-row">
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
                  onClick={() => (pending === 'discard' ? discard() : resolve(pending))}
                >
                  Confirm {pending === 'discard' ? 'discard' : 'resolution'}
                </Button>
              </div>
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
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<Commit | null>(null)
  const [diff, setDiff] = React.useState<{ text: string; truncated: boolean } | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [diffError, setDiffError] = React.useState<string | null>(null)
  const [revision, setRevision] = React.useState(0)
  const generation = React.useRef(0)
  React.useEffect(() => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    setSelected(null)
    window.desktop
      .history(ref, 0)
      .then((page) => {
        if (generation.current !== current) return
        setCommits(page.commits)
        setHasMore(page.hasMore)
        setSelected(page.commits[0] ?? null)
      })
      .catch((value) => {
        if (generation.current === current) setError(workflowError(value))
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
    return () => {
      generation.current++
    }
  }, [snapshot.path, snapshot.headOid, ref, revision])
  React.useEffect(() => {
    let active = true
    setDiff(null)
    setDiffError(null)
    if (!selected) return
    setDiffLoading(true)
    window.desktop
      .commitDiff(selected.oid)
      .then((value) => {
        if (active) setDiff(value)
      })
      .catch((value) => {
        if (active) setDiffError(workflowError(value))
      })
      .finally(() => {
        if (active) setDiffLoading(false)
      })
    return () => {
      active = false
    }
  }, [snapshot.path, selected?.oid])
  const loadMore = async () => {
    if (loading || diffLoading || busy) return
    const current = generation.current
    setLoading(true)
    setError(null)
    try {
      const page = await window.desktop.history(ref, commits.length)
      if (generation.current !== current) return
      setCommits((previous) => [...previous, ...page.commits])
      setHasMore(page.hasMore)
    } catch (value) {
      if (generation.current === current) setError(workflowError(value))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }
  const visible = commits.filter((commit) =>
    `${commit.subject} ${commit.author} ${commit.oid}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  )
  const actionable =
    !busy &&
    !snapshot.operation &&
    !snapshot.stackOperation &&
    !!snapshot.currentBranch &&
    !!snapshot.headOid &&
    snapshot.files.length === 0
  return (
    <div className="history-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1>History</h1>
          <span className="list-subtitle">{commits.length} loaded</span>
        </div>
        <div className="workflow-row">
          <label className="sr-only" htmlFor="history-ref">
            History branch
          </label>
          <select
            className="workflow-select"
            id="history-ref"
            disabled={busy || loading || diffLoading}
            value={ref}
            onChange={(event) => setRef(event.target.value)}
          >
            {!snapshot.branches.some((branch) => branch.ref === ref) ? (
              <option value={ref}>{ref}</option>
            ) : null}
            {snapshot.branches.map((branch) => (
              <option key={branch.ref} value={branch.ref}>
                {branch.name}
              </option>
            ))}
          </select>
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
      <div className="history-list" aria-label="Commit history">
        {visible.map((commit) => (
          <button
            className={`history-row ${selected?.oid === commit.oid ? 'history-row-selected' : ''}`}
            key={commit.oid}
            disabled={diffLoading}
            onClick={() => setSelected(commit)}
            aria-pressed={selected?.oid === commit.oid}
          >
            <GitCommitHorizontal className="size-4" />
            <span>
              <strong>{commit.subject}</strong>
              <small>
                {commit.author} · {new Date(commit.date).toLocaleDateString()}
              </small>
            </span>
            <code>{commit.oid.slice(0, 8)}</code>
          </button>
        ))}
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
            <div>
              <strong>{selected.subject}</strong>
              <code>{selected.oid}</code>
            </div>
            <div className="workflow-row">
              <Button
                size="sm"
                variant="secondary"
                disabled={!actionable || diffLoading}
                onClick={() =>
                  onRequest({ kind: 'commitAction', commit: selected, mode: 'cherryPick' })
                }
              >
                Cherry-pick…
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!actionable || diffLoading}
                onClick={() =>
                  onRequest({ kind: 'commitAction', commit: selected, mode: 'revert' })
                }
              >
                Revert…
              </Button>
            </div>
          </header>
          {!actionable ? (
            <p className="workflow-note history-message">
              Commit actions require a clean working tree, an attached branch, and no active
              operation.
            </p>
          ) : (
            <p className="workflow-note history-message">
              Apply to current branch: <strong>{snapshot.currentBranch}</strong>
            </p>
          )}
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
  snapshot,
  busy,
  onRequest,
  onSelect,
  search,
  onCreate,
}: Omit<CommonProps, 'runAction'> & {
  onSelect: (branch: Branch) => void
  search: string
  onCreate: () => void
}) {
  const [selection, setSelection] = React.useState<string | null>(null)
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
  const current = snapshot.currentBranch ? byName.get(snapshot.currentBranch) : null
  const root =
    selection && groups.has(selection)
      ? selection
      : current
        ? stackRoot(current, byName, snapshot.defaultBranch)
        : (groups.keys().next().value ?? null)
  const members = root ? (groups.get(root) ?? []) : []
  const ordered = sortBranchesByUpdatedAt(members)
  const stale = members.filter(
    (branch) => branch.needsRestack || (branch.parentBehind ?? 0) > 0,
  ).length
  const blocked = busy || !!snapshot.operation || !!snapshot.stackOperation
  return (
    <div className="stacks-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1>Stacks</h1>
          <span className="list-subtitle">
            {groups.size} local stack{groups.size === 1 ? '' : 's'}
          </span>
        </div>
        <Button size="sm" variant="accent" disabled={blocked} onClick={onCreate}>
          New branch
        </Button>
      </div>
      {!root ? (
        <div className="empty-state">
          <Layers className="empty-icon" />
          <h2>Build a stack from a branch</h2>
          <p>
            Create a branch from your default branch, then add dependent branches. Existing branches
            can be adopted by setting their stack parent.
          </p>
          <Button variant="accent" disabled={blocked} onClick={onCreate}>
            Create a stack branch
          </Button>
        </div>
      ) : (
        <>
          <div className="stack-workspace-header">
            <label htmlFor="stack-selection">Stack root</label>
            <select
              id="stack-selection"
              className="workflow-select"
              value={root}
              onChange={(event) => {
                setSelection(event.target.value)
                const branch = byName.get(event.target.value)
                if (branch) onSelect(branch)
              }}
            >
              {[...groups].map(([name, branches]) => (
                <option value={name} key={name}>
                  {name} · {branches.length} branch{branches.length === 1 ? '' : 'es'}
                </option>
              ))}
            </select>
            <p>
              {stale
                ? `${stale} branch${stale === 1 ? ' requires' : 'es require'} restacking.`
                : 'Review the stack, publish its PRs, and merge from the base upward.'}
            </p>
            <div className="workflow-row">
              <Button
                size="sm"
                variant={stale ? 'accent' : 'secondary'}
                disabled={blocked}
                onClick={() => onRequest({ kind: 'stack', branch: root, operation: 'restack' })}
              >
                <RefreshCw className="size-3.5" />
                Restack…
              </Button>
              <Button
                size="sm"
                variant={stale ? 'secondary' : 'accent'}
                disabled={blocked || !snapshot.github.available}
                onClick={() => onRequest({ kind: 'stack', branch: root, operation: 'publish' })}
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
          ) : null}
          <div className="stack-members" aria-label="Stack branches, children above parents">
            {ordered
              .filter((branch) =>
                `${branch.name} ${branch.pr?.title ?? ''}`
                  .toLowerCase()
                  .includes(search.trim().toLowerCase()),
              )
              .map((branch) => (
                <article className="stack-member" key={branch.ref}>
                  <div className="stack-member-heading">
                    <button onClick={() => onSelect(branch)} className="stack-member-name">
                      <GitBranch className="size-4" />
                      <strong>{branch.name}</strong>
                      <ChevronRight className="size-3.5" />
                    </button>
                    {branch.current ? <Badge variant="accent">current</Badge> : null}
                    {branch.needsRestack || (branch.parentBehind ?? 0) > 0 ? (
                      <Badge variant="warning">Requires restack</Badge>
                    ) : null}
                  </div>
                  <div className="stack-member-meta">
                    <span>
                      Parent: <strong>{branch.parent ?? 'Not set'}</strong>
                    </span>
                    <span>
                      {branch.parentSource === 'recorded'
                        ? 'Recorded parent'
                        : branch.parentSource === 'pullRequest'
                          ? 'From PR base'
                          : 'Inferred — confirm before publishing'}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={blocked}
                      onClick={() => onRequest({ kind: 'parent', branch })}
                    >
                      Set parent…
                    </Button>
                  </div>
                  {branch.pr ? (
                    <div className="stack-pr-row">
                      <Button
                        size="sm"
                        variant="link"
                        disabled={busy}
                        onClick={() => onRequest({ kind: 'pr', number: branch.pr!.number })}
                      >
                        #{branch.pr.number} {branch.pr.title}
                      </Button>
                      <div className="workflow-row">
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
                          disabled={blocked}
                          onClick={() =>
                            onRequest({ kind: 'stack', branch: branch.name, operation: 'merge' })
                          }
                        >
                          <GitMerge className="size-3.5" />
                          Preview merge
                        </Button>
                      ) : branch.pr.state === 'MERGED' ? (
                        <p className="workflow-note">
                          Merged parent: restack remaining branches, then publish their updated
                          bases.
                        </p>
                      ) : (
                        <p className="workflow-note">
                          Merge the parent PR first, then restack and publish this branch.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="workflow-note">
                      No pull request. Publish the stack to create one.
                    </p>
                  )}
                </article>
              ))}
          </div>
        </>
      )}
    </div>
  )
}
