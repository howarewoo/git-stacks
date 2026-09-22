import * as React from 'react'
import {
  AlertCircle,
  Archive,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Cloud,
  Download,
  ExternalLink,
  Files,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  GitPullRequest,
  Info,
  LoaderCircle,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import type {
  Branch,
  ChangedFile,
  DesktopAPI,
  GitAction,
  PullRequest,
  RecentRepository,
  RepositorySnapshot,
} from '../../shared/types'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { Input } from './components/ui/input'
import { cn } from './lib/utils'
import { getCombinedBranches, getRepresentedRemoteRef } from './lib/branches'

type WorkspaceView = 'branches' | 'changes' | 'pullRequests' | 'stashes'
type BranchFilter = 'all' | 'local' | 'remote' | 'prs'

type BranchTreeInfo = {
  depth: number
  cycle: boolean
  missingParent: boolean
}

function readableError(value: unknown): string {
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'string' && value) return value
  return 'The operation failed. Check the repository and try again.'
}

function branchTreeInfo(branch: Branch, byName: Map<string, Branch>): BranchTreeInfo {
  const visited = new Set<string>([branch.name])
  let parent = branch.parent
  let depth = 0
  let cycle = false
  let missingParent = false

  while (parent) {
    if (visited.has(parent)) {
      cycle = true
      break
    }
    visited.add(parent)
    const parentBranch = byName.get(parent)
    if (!parentBranch) {
      missingParent = true
      break
    }
    depth += 1
    parent = parentBranch.parent
  }

  return { depth: Math.min(depth, 7), cycle, missingParent }
}

function formatBranchDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 60_000) return 'just now'
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m ago`
  if (elapsed < 86_400_000) return `${Math.max(1, Math.floor(elapsed / 3_600_000))}h ago`
  if (elapsed < 604_800_000) return `${Math.max(1, Math.floor(elapsed / 86_400_000))}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fileIsStaged(file: ChangedFile): boolean {
  return file.index !== '' && file.index !== ' ' && file.index !== '?'
}

function fileIsUnstaged(file: ChangedFile): boolean {
  return file.worktree !== '' && file.worktree !== ' '
}

function statusLetter(value: string): string {
  if (!value || value === ' ') return '·'
  if (value === '?') return 'U'
  return value
}

function checksVariant(
  checks: PullRequest['checks'],
): 'success' | 'danger' | 'warning' | 'secondary' {
  if (checks === 'passing') return 'success'
  if (checks === 'failing') return 'danger'
  if (checks === 'pending') return 'warning'
  return 'secondary'
}

function checkLabel(checks: PullRequest['checks']): string {
  if (checks === 'passing') return 'checks passing'
  if (checks === 'failing') return 'checks failing'
  if (checks === 'pending') return 'checks pending'
  return 'no checks'
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  variant = 'ghost',
  className,
}: {
  label: string
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: React.ComponentProps<typeof Button>['variant']
  className?: string
}) {
  return (
    <Button
      aria-label={label}
      className={cn('shrink-0', className)}
      disabled={disabled}
      onClick={onClick}
      size="icon-sm"
      title={label}
      variant={variant}
    >
      {children}
    </Button>
  )
}

function App() {
  const desktop: DesktopAPI | null =
    typeof window !== 'undefined' && window.desktop ? window.desktop : null
  const [snapshot, setSnapshot] = React.useState<RepositorySnapshot | null>(null)
  const [recentRepositories, setRecentRepositories] = React.useState<RecentRepository[]>([])
  const [selectedBranchRef, setSelectedBranchRef] = React.useState<string | null>(null)
  const [workspaceView, setWorkspaceView] = React.useState<WorkspaceView>('branches')
  const [branchFilter, setBranchFilter] = React.useState<BranchFilter>('all')
  const [search, setSearch] = React.useState('')
  const [bootLoading, setBootLoading] = React.useState(true)
  const [opening, setOpening] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [newBranchOpen, setNewBranchOpen] = React.useState(false)
  const [newBranchName, setNewBranchName] = React.useState('')
  const [newBranchParent, setNewBranchParent] = React.useState('')
  const [newBranchError, setNewBranchError] = React.useState<string | null>(null)
  const [prOpen, setPrOpen] = React.useState(false)
  const [prTitle, setPrTitle] = React.useState('')
  const [prBody, setPrBody] = React.useState('')
  const [prBase, setPrBase] = React.useState('')
  const [prDraft, setPrDraft] = React.useState(false)
  const [prError, setPrError] = React.useState<string | null>(null)
  const [commitMessage, setCommitMessage] = React.useState('')

  const [showDetails, setShowDetails] = React.useState(true)
  const refreshSequence = React.useRef(0)
  const busyRef = React.useRef<string | null>(null)
  const openingRef = React.useRef(false)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const setSnapshotAndSelection = React.useCallback((next: RepositorySnapshot) => {
    setSnapshot(next)
    setSelectedBranchRef((current) => {
      if (current && next.branches.some((branch) => branch.ref === current)) return current
      if (next.currentBranch) return `refs/heads/${next.currentBranch}`
      return next.branches[0]?.ref ?? null
    })
  }, [])

  const refreshSnapshot = React.useCallback(async (): Promise<RepositorySnapshot | null> => {
    if (!desktop) return null
    const sequence = ++refreshSequence.current
    setRefreshing(true)
    try {
      const next = await desktop.refresh()
      if (sequence !== refreshSequence.current) return null
      setSnapshotAndSelection(next)

      return next
    } catch (value) {
      if (sequence === refreshSequence.current) setError(readableError(value))
      return null
    } finally {
      if (sequence === refreshSequence.current) setRefreshing(false)
    }
  }, [desktop, setSnapshotAndSelection])

  React.useEffect(() => {
    let cancelled = false
    if (!desktop) {
      setBootLoading(false)
      return () => {
        cancelled = true
      }
    }

    setBootLoading(true)
    desktop
      .recentRepositories()
      .then((repositories) => {
        if (!cancelled) setRecentRepositories(repositories)
      })
      .catch((value) => {
        if (!cancelled) setError(readableError(value))
      })
      .finally(() => {
        if (!cancelled) setBootLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [desktop])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const openRepository = React.useCallback(
    async (path?: string) => {
      if (!desktop || openingRef.current || busyRef.current) return
      openingRef.current = true
      setOpening(true)
      setError(null)
      setActionError(null)
      setNotice(null)
      try {
        const next = await desktop.openRepository(path)
        if (next) {
          setSnapshotAndSelection(next)
          setWorkspaceView('branches')
          const repositories = await desktop.recentRepositories().catch(() => null)
          if (repositories) setRecentRepositories(repositories)
        }
      } catch (value) {
        setError(readableError(value))
      } finally {
        openingRef.current = false
        setOpening(false)
      }
    },
    [desktop, setSnapshotAndSelection],
  )

  const runAction = React.useCallback(
    async (action: GitAction, label: string): Promise<boolean> => {
      if (!desktop || !snapshot || busyRef.current) return false
      busyRef.current = label
      setBusyAction(label)
      setActionError(null)
      setNotice(null)
      try {
        const result = await desktop.runAction(action)
        if (result.message) setNotice(result.message)
        const next = await refreshSnapshot()
        if (action.type === 'switch' && next?.currentBranch)
          setSelectedBranchRef(`refs/heads/${next.currentBranch}`)
        return true
      } catch (value) {
        if (action.type === 'createBranch') setNewBranchError(readableError(value))
        if (action.type === 'createPr') setPrError(readableError(value))
        setActionError(`${label} failed: ${readableError(value)}`)
        await refreshSnapshot()
        return false
      } finally {
        busyRef.current = null
        setBusyAction(null)
      }
    },
    [desktop, refreshSnapshot, snapshot],
  )

  const selectedBranch = React.useMemo(() => {
    const branch = snapshot?.branches.find((candidate) => candidate.ref === selectedBranchRef)
    if (branch?.remote && branchFilter !== 'remote') {
      return (
        snapshot?.branches.find(
          (candidate) => !candidate.remote && candidate.upstreamRef === branch.ref,
        ) ??
        snapshot?.branches.find((candidate) => getRepresentedRemoteRef(candidate) === branch.ref) ??
        branch
      )
    }
    return branch ?? null
  }, [branchFilter, selectedBranchRef, snapshot])

  const selectedPullRequest = React.useMemo(() => {
    if (!snapshot || !selectedBranch) return null
    return selectedBranch.pr
  }, [selectedBranch, snapshot])

  const branchByName = React.useMemo(
    () =>
      new Map(
        (snapshot?.branches ?? [])
          .filter((branch) => !branch.remote)
          .map((branch) => [branch.name, branch]),
      ),
    [snapshot],
  )
  const combinedBranches = React.useMemo(
    () => getCombinedBranches(snapshot?.branches ?? []),
    [snapshot],
  )
  const orderedBranches = React.useMemo(() => {
    const branches = branchFilter === 'remote' ? (snapshot?.branches ?? []) : combinedBranches
    const children = new Map<string, Branch[]>()
    for (const branch of branches) {
      if (branch.parent) {
        const siblings = children.get(branch.parent) ?? []
        siblings.push(branch)
        children.set(branch.parent, siblings)
      }
    }
    const ordered: Branch[] = []
    const visited = new Set<Branch>()
    const visit = (branch: Branch) => {
      if (visited.has(branch)) return
      visited.add(branch)
      ordered.push(branch)
      if (!branch.remote) for (const child of children.get(branch.name) ?? []) visit(child)
    }
    for (const branch of branches) {
      if (!branch.parent || !branchByName.has(branch.parent)) visit(branch)
    }
    for (const branch of branches) visit(branch)
    return ordered
  }, [snapshot, branchByName, branchFilter, combinedBranches])

  const visibleBranches = React.useMemo(() => {
    if (!snapshot) return []
    const needle = search.trim().toLowerCase()
    return orderedBranches.filter((branch) => {
      if (branchFilter === 'local' && branch.remote) return false
      if (branchFilter === 'remote' && !branch.remote) return false
      if (branchFilter === 'prs' && !branch.pr) return false
      if (!needle) return true
      return `${branch.name} ${branch.subject} ${branch.upstream ?? ''}`
        .toLowerCase()
        .includes(needle)
    })
  }, [branchFilter, search, snapshot, orderedBranches])

  const stagedFiles = React.useMemo(
    () => snapshot?.files.filter((file) => fileIsStaged(file)) ?? [],
    [snapshot],
  )
  const unstagedFiles = React.useMemo(
    () =>
      snapshot?.files.filter(
        (file) => fileIsUnstaged(file) || (!fileIsStaged(file) && file.index === '?'),
      ) ?? [],
    [snapshot],
  )
  const fileSearch = search.trim().toLowerCase()
  const visibleStagedFiles = stagedFiles.filter((file) =>
    `${file.path} ${file.originalPath ?? ''}`.toLowerCase().includes(fileSearch),
  )
  const visibleUnstagedFiles = unstagedFiles.filter((file) =>
    `${file.path} ${file.originalPath ?? ''}`.toLowerCase().includes(fileSearch),
  )
  const conflictedFiles = React.useMemo(
    () => snapshot?.files.filter((file) => file.conflicted) ?? [],
    [snapshot],
  )
  const isBusy = Boolean(busyAction || opening || refreshing)
  const currentBranch = snapshot?.currentBranch ?? null
  const allBranches = snapshot?.branches ?? []
  const branchCount = combinedBranches.length
  const pullRequestCount = snapshot?.pullRequests.length ?? 0
  const stashCount = snapshot?.stashes.length ?? 0

  const openBranchDialog = React.useCallback(() => {
    if (!snapshot) return
    setNewBranchName('')
    setNewBranchParent(
      snapshot.currentBranch ?? snapshot.defaultBranch ?? snapshot.branches[0]?.name ?? '',
    )
    setNewBranchError(null)
    setNewBranchOpen(true)
  }, [snapshot])

  const openPrDialog = React.useCallback(() => {
    if (!snapshot || !selectedBranch?.current || selectedBranch.remote) return
    setPrTitle(selectedBranch.subject || `Open ${selectedBranch.name}`)
    setPrBody('')
    setPrBase(selectedBranch.parent ?? snapshot.defaultBranch)
    setPrDraft(false)
    setPrError(null)
    setPrOpen(true)
  }, [selectedBranch, snapshot])

  const submitBranch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = newBranchName.trim()
    const parent = newBranchParent.trim()
    if (!name) {
      setNewBranchError('Enter a branch name.')
      return
    }
    if (!parent) {
      setNewBranchError('Choose a parent branch.')
      return
    }
    if (snapshot?.branches.some((branch) => branch.name === name)) {
      setNewBranchError('A branch with that name already exists.')
      return
    }
    const success = await runAction({ type: 'createBranch', name, parent }, 'Create branch')
    if (success) {
      setSelectedBranchRef(`refs/heads/${name}`)
      setNewBranchOpen(false)
    }
  }

  const submitPr = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const title = prTitle.trim()
    const base = prBase.trim()
    if (!title) {
      setPrError('Enter a pull request title.')
      return
    }
    if (!base) {
      setPrError('Choose a base branch.')
      return
    }
    const success = await runAction(
      { type: 'createPr', title, body: prBody, base, draft: prDraft },
      'Create pull request',
    )
    if (success) setPrOpen(false)
  }

  const submitCommit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = commitMessage.trim()
    if (!message || stagedFiles.length === 0) return
    const success = await runAction({ type: 'commit', message }, 'Commit staged changes')
    if (success) setCommitMessage('')
  }

  const renderSidebar = () => (
    <aside className="sidebar" aria-label="Repository navigation">
      <div className="sidebar-repository">
        <div className="repo-mark" aria-hidden="true">
          <FolderGit2 className="size-4" />
        </div>
        <div className="repo-heading">
          <span className="repo-name">{snapshot?.name ?? 'No repository'}</span>
          <span className="repo-path" title={snapshot?.path}>
            {snapshot?.path ?? 'Open a local repository to begin'}
          </span>
        </div>
        <IconButton
          label="Open another repository"
          onClick={() => openRepository()}
          disabled={isBusy}
        >
          <MoreHorizontal className="size-4" />
        </IconButton>
      </div>

      <div className="sidebar-scroll">
        <div className="nav-section">
          <span className="nav-label">Workspace</span>
          <button
            className={cn('nav-item', workspaceView === 'branches' && 'nav-item-active')}
            onClick={() => setWorkspaceView('branches')}
            type="button"
          >
            <GitBranch className="size-4" />
            <span>Branches</span>
            <span className="nav-count">{branchCount}</span>
          </button>
          <button
            className={cn('nav-item', workspaceView === 'changes' && 'nav-item-active')}
            onClick={() => setWorkspaceView('changes')}
            type="button"
          >
            <Files className="size-4" />
            <span>Working changes</span>
            {snapshot && snapshot.files.length > 0 ? (
              <span className="nav-count nav-count-accent">{snapshot.files.length}</span>
            ) : null}
          </button>
          <button
            className={cn('nav-item', workspaceView === 'pullRequests' && 'nav-item-active')}
            onClick={() => setWorkspaceView('pullRequests')}
            type="button"
          >
            <GitPullRequest className="size-4" />
            <span>Pull requests</span>
            <span className="nav-count">{pullRequestCount}</span>
          </button>
          <button
            className={cn('nav-item', workspaceView === 'stashes' && 'nav-item-active')}
            onClick={() => setWorkspaceView('stashes')}
            type="button"
          >
            <Archive className="size-4" />
            <span>Stashes</span>
            <span className="nav-count">{stashCount}</span>
          </button>
        </div>

        {snapshot ? (
          <div className="nav-section nav-section-bordered">
            <span className="nav-label">Repository</span>
            <div className="sidebar-info-row">
              <GitFork className="size-4" />
              <span className="sidebar-info-value" title={snapshot.remoteUrl ?? undefined}>
                {snapshot.remoteUrl
                  ? snapshot.remoteUrl.replace(/^https?:\/\//, '')
                  : 'No remote configured'}
              </span>
            </div>
            <div className="sidebar-info-row">
              <Circle className="size-3 fill-[var(--success)] text-[var(--success)]" />
              <span className="sidebar-info-key">Default branch</span>
              <span className="sidebar-info-value sidebar-info-value-right">
                {snapshot.defaultBranch || '—'}
              </span>
            </div>
          </div>
        ) : null}

        <div className="nav-section nav-section-bordered recent-section">
          <div className="nav-label-row">
            <span className="nav-label">Recent repositories</span>
            <IconButton
              label="Open a repository"
              onClick={() => openRepository()}
              disabled={isBusy}
            >
              <Plus className="size-3.5" />
            </IconButton>
          </div>
          {bootLoading ? (
            <div className="sidebar-loading">
              <LoaderCircle className="size-3.5 animate-spin" />
              <span>Loading recents</span>
            </div>
          ) : recentRepositories.length > 0 ? (
            <div className="recent-list">
              {recentRepositories.map((repository) => (
                <button
                  className="recent-item"
                  disabled={isBusy}
                  key={repository.path}
                  onClick={() => openRepository(repository.path)}
                  type="button"
                >
                  <FolderOpen className="size-3.5" />
                  <span>
                    <strong>{repository.name}</strong>
                    <small title={repository.path}>{repository.path}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="sidebar-empty">Your recently opened repositories will appear here.</p>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="connection-state">
          <span
            className={cn(
              'connection-dot',
              desktop ? 'connection-dot-live' : 'connection-dot-offline',
            )}
          />
          <span>{desktop ? 'Desktop connected' : 'Desktop integration unavailable'}</span>
        </div>
        <span className="version-label">Git Stacks</span>
      </div>
    </aside>
  )

  const renderToolbar = () => (
    <div className="toolbar">
      <div className="toolbar-actions" aria-label="Repository actions">
        <Button
          disabled={!snapshot || isBusy}
          onClick={() => runAction({ type: 'fetch' }, 'Fetch')}
          size="sm"
          variant="secondary"
        >
          {busyAction === 'Fetch' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          Fetch
        </Button>
        <Button
          disabled={!snapshot || isBusy}
          onClick={() => runAction({ type: 'pull' }, 'Pull')}
          size="sm"
          variant="secondary"
        >
          {busyAction === 'Pull' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <ArrowDown className="size-3.5" />
          )}
          Pull
        </Button>
        <Button
          disabled={!snapshot || isBusy}
          onClick={() => runAction({ type: 'push' }, 'Push')}
          size="sm"
          variant="secondary"
        >
          {busyAction === 'Push' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Upload className="size-3.5" />
          )}
          Push
        </Button>
        <span className="toolbar-divider" />
        <Button
          disabled={!snapshot || isBusy}
          onClick={openBranchDialog}
          size="sm"
          variant="accent"
        >
          <Plus className="size-3.5" />
          New branch
        </Button>
      </div>
      <div className="toolbar-spacer" />
      <div className="toolbar-search">
        <Search className="size-3.5" />
        <Input
          aria-label="Search branches, files, and pull requests"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
          ref={searchRef}
          value={search}
        />
        <kbd>⌘ K</kbd>
      </div>
      <IconButton
        label="Refresh repository"
        onClick={() => refreshSnapshot()}
        disabled={!snapshot || isBusy}
        variant="secondary"
      >
        <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
      </IconButton>
      {snapshot ? (
        <IconButton
          label={showDetails ? 'Hide details pane' : 'Show details pane'}
          onClick={() => setShowDetails((value) => !value)}
          variant="secondary"
        >
          <PanelRightClose className="size-4" />
        </IconButton>
      ) : null}
    </div>
  )

  const renderBranchFilters = () => (
    <div className="list-toolbar">
      <div className="list-title-group">
        <h1>Branches</h1>
        <span className="list-subtitle">{visibleBranches.length} shown</span>
      </div>
      <div className="filter-group" aria-label="Branch filters">
        {(
          [
            ['all', 'All'],
            ['local', 'Local'],
            ['remote', 'Remote'],
            ['prs', 'With PRs'],
          ] as [BranchFilter, string][]
        ).map(([value, label]) => (
          <button
            className={cn('filter-button', branchFilter === value && 'filter-button-active')}
            key={value}
            onClick={() => setBranchFilter(value)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )

  const renderBranchList = () => {
    if (!snapshot) return null
    if (visibleBranches.length === 0) {
      return (
        <div className="empty-state compact-empty">
          <GitBranch className="empty-icon" />
          <h2>{search ? 'No matching branches' : 'No branches yet'}</h2>
          <p>
            {search
              ? 'Try a different search or clear the filter.'
              : 'Create a branch to start a stack.'}
          </p>
          {!search ? (
            <Button onClick={openBranchDialog} size="sm" variant="accent">
              <Plus className="size-3.5" />
              New branch
            </Button>
          ) : null}
        </div>
      )
    }

    return (
      <div className="branch-list" role="group" aria-label="Repository branches">
        {visibleBranches.map((branch) => {
          const tree = branchTreeInfo(branch, branchByName)
          const pullRequest = branch.pr
          const selected = branch.ref === selectedBranch?.ref
          return (
            <div
              className={cn('branch-row', selected && 'branch-row-selected')}
              key={branch.ref}
              style={{ '--branch-depth': tree.depth } as React.CSSProperties}
            >
              <button
                aria-current={selected ? 'true' : undefined}
                aria-label={`${branch.name}${branch.remote ? ', remote branch' : ''}${branch.current ? ', current branch' : ''}`}
                className="branch-select"
                onClick={() => setSelectedBranchRef(branch.ref)}
                type="button"
              />
              <span className="branch-tree-guide" aria-hidden="true" />
              <span className="branch-tree-elbow" aria-hidden="true" />
              <span className={cn('branch-icon', branch.current && 'branch-icon-current')}>
                {branch.remote ? (
                  <Cloud className="size-3.5" />
                ) : (
                  <GitBranch className="size-3.5" />
                )}
              </span>
              <span className="branch-copy">
                <span className="branch-name-line">
                  <strong>{branch.name}</strong>
                  {branch.current ? <Badge variant="accent">current</Badge> : null}
                  {branch.remote ? <Badge variant="outline">remote</Badge> : null}
                  {tree.cycle ? <Badge variant="warning">cycle</Badge> : null}
                  {tree.missingParent ? <Badge variant="warning">parent missing</Badge> : null}
                </span>
                <span className="branch-summary">
                  {pullRequest ? (
                    <a
                      className="branch-pr-link"
                      href={pullRequest.url}
                      aria-label={`Open pull request #${pullRequest.number} on GitHub`}
                      title={pullRequest.title}
                      onClick={(event) => {
                        event.preventDefault()
                        desktop
                          ?.openExternal(pullRequest.url)
                          .catch((value) => setError(readableError(value)))
                      }}
                    >
                      #{pullRequest.number}
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                  ) : null}
                  <span className="branch-subject">{branch.subject || 'No commit subject'}</span>
                </span>
              </span>
              <span className="branch-metrics">
                {pullRequest ? (
                  <Badge variant={checksVariant(pullRequest.checks)}>
                    <ShieldCheck className="size-3" />
                    {checkLabel(pullRequest.checks)}
                  </Badge>
                ) : null}
                <span
                  className="ahead-behind"
                  title={`${branch.ahead} ahead, ${branch.behind} behind upstream`}
                >
                  <span className={branch.ahead > 0 ? 'metric-positive' : 'metric-muted'}>
                    <ArrowUp className="size-3" />
                    {branch.ahead}
                  </span>
                  <span className={branch.behind > 0 ? 'metric-negative' : 'metric-muted'}>
                    <ArrowDown className="size-3" />
                    {branch.behind}
                  </span>
                </span>
                <span className="branch-updated">{formatBranchDate(branch.updatedAt)}</span>
              </span>
              <ChevronRight className="branch-chevron size-4" />
            </div>
          )
        })}
      </div>
    )
  }

  const renderChanges = () => {
    if (!snapshot) return null
    return (
      <div className="changes-view">
        <div className="list-toolbar">
          <div className="list-title-group">
            <h1>Working changes</h1>
            <span className="list-subtitle">
              {snapshot.files.length} file{snapshot.files.length === 1 ? '' : 's'}
            </span>
          </div>
          <Button
            disabled={snapshot.files.length === 0 || isBusy}
            onClick={() => runAction({ type: 'stash' }, 'Stash changes')}
            size="sm"
            variant="secondary"
          >
            {busyAction === 'Stash changes' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Archive className="size-3.5" />
            )}
            Stash changes
          </Button>
        </div>
        {conflictedFiles.length > 0 ? (
          <div className="conflict-banner" role="alert">
            <TriangleAlert className="size-4" />
            <div>
              <strong>
                {conflictedFiles.length} conflict{conflictedFiles.length === 1 ? '' : 's'} need
                attention
              </strong>
              <span>
                Resolve conflicts in your working tree, then continue or abort the rebase.
              </span>
            </div>
            <div className="conflict-actions">
              {snapshot.rebaseInProgress ? (
                <Button
                  disabled={isBusy}
                  onClick={() => runAction({ type: 'rebaseContinue' }, 'Continue rebase')}
                  size="sm"
                  variant="danger"
                >
                  Continue rebase
                </Button>
              ) : null}
              {snapshot.rebaseInProgress ? (
                <Button
                  disabled={isBusy}
                  onClick={() => runAction({ type: 'rebaseAbort' }, 'Abort rebase')}
                  size="sm"
                  variant="secondary"
                >
                  Abort
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {snapshot.rebaseInProgress && conflictedFiles.length === 0 ? (
          <div className="conflict-banner" role="status">
            <RotateCcw className="size-4" />
            <div>
              <strong>Rebase in progress</strong>
              <span>Complete the conflict resolution, then continue or abort.</span>
            </div>
            <div className="conflict-actions">
              <Button
                disabled={isBusy}
                onClick={() => runAction({ type: 'rebaseContinue' }, 'Continue rebase')}
                size="sm"
                variant="danger"
              >
                Continue
              </Button>
              <Button
                disabled={isBusy}
                onClick={() => runAction({ type: 'rebaseAbort' }, 'Abort rebase')}
                size="sm"
                variant="secondary"
              >
                Abort
              </Button>
            </div>
          </div>
        ) : null}
        <div className="changes-columns">
          <section className="change-section" aria-labelledby="staged-heading">
            <div className="change-section-header">
              <div>
                <h2 id="staged-heading">Staged</h2>
                <span>
                  {stagedFiles.length} file{stagedFiles.length === 1 ? '' : 's'} ready to commit
                </span>
              </div>
              <Badge variant={stagedFiles.length > 0 ? 'accent' : 'secondary'}>
                {stagedFiles.length}
              </Badge>
            </div>
            {visibleStagedFiles.length > 0 ? (
              <div className="file-list">
                {visibleStagedFiles.map((file) => renderFileRow(file, 'unstage'))}
              </div>
            ) : (
              <div className="section-empty">
                {fileSearch
                  ? 'No staged files match your search.'
                  : 'Stage files from the working tree to prepare a commit.'}
              </div>
            )}
          </section>
          <section className="change-section" aria-labelledby="unstaged-heading">
            <div className="change-section-header">
              <div>
                <h2 id="unstaged-heading">Unstaged</h2>
                <span>Changes in the working tree</span>
              </div>
              <Badge variant={unstagedFiles.length > 0 ? 'warning' : 'secondary'}>
                {unstagedFiles.length}
              </Badge>
            </div>
            {visibleUnstagedFiles.length > 0 ? (
              <div className="file-list">
                {visibleUnstagedFiles.map((file) => renderFileRow(file, 'stage'))}
              </div>
            ) : (
              <div className="section-empty">
                {fileSearch
                  ? 'No unstaged files match your search.'
                  : 'Your working tree is clean.'}
              </div>
            )}
          </section>
        </div>
        <form className="commit-panel" onSubmit={submitCommit}>
          <div className="commit-panel-heading">
            <GitCommitHorizontal className="size-4" />
            <div>
              <h2>Commit staged changes</h2>
              <span>Only staged files will be included.</span>
            </div>
          </div>
          <div className="commit-form-row">
            <Input
              aria-label="Commit message"
              disabled={stagedFiles.length === 0 || isBusy}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Describe the change"
              value={commitMessage}
            />
            <Button
              disabled={!commitMessage.trim() || stagedFiles.length === 0 || isBusy}
              type="submit"
              variant="accent"
            >
              {busyAction === 'Commit staged changes' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <GitCommitHorizontal className="size-3.5" />
              )}
              Commit
            </Button>
          </div>
        </form>
      </div>
    )
  }

  const renderFileRow = (file: ChangedFile, action: 'stage' | 'unstage') => (
    <div
      className={cn('file-row', file.conflicted && 'file-row-conflicted')}
      key={`${action}:${file.path}`}
    >
      <span
        className={cn('file-status', file.conflicted && 'file-status-conflicted')}
        title={
          file.conflicted ? 'Conflict' : `${statusLetter(file.index)}${statusLetter(file.worktree)}`
        }
      >
        {file.conflicted ? '!' : `${statusLetter(file.index)}${statusLetter(file.worktree)}`}
      </span>
      <span
        className="file-path"
        title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
      >
        {file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
      </span>
      <Button
        disabled={isBusy}
        onClick={() =>
          runAction(
            {
              type: action,
              paths: file.originalPath ? [file.path, file.originalPath] : [file.path],
            },
            action === 'stage' ? 'Stage file' : 'Unstage file',
          )
        }
        size="sm"
        variant="ghost"
      >
        {action === 'stage' ? 'Stage' : 'Unstage'}
      </Button>
    </div>
  )

  const renderPullRequests = () => {
    if (!snapshot) return null
    const pullRequests = snapshot.pullRequests.filter((pr) => {
      const needle = search.trim().toLowerCase()
      if (!needle) return true
      return `${pr.title} ${pr.head} ${pr.base} #${pr.number}`.toLowerCase().includes(needle)
    })
    return (
      <div className="pull-requests-view">
        <div className="list-toolbar">
          <div className="list-title-group">
            <h1>Pull requests</h1>
            <span className="list-subtitle">{pullRequests.length} shown</span>
          </div>
          <Button
            disabled={!selectedBranch?.current || !snapshot.github.available || isBusy}
            onClick={openPrDialog}
            size="sm"
            variant="accent"
          >
            <Plus className="size-3.5" />
            Create PR
          </Button>
        </div>
        {!snapshot.github.available ? (
          <div className="gh-banner" role="status">
            <Terminal className="size-4" />
            <div>
              <strong>GitHub CLI is unavailable</strong>
              <span>
                {snapshot.github.message ||
                  'Install and authenticate gh to list or create pull requests.'}
              </span>
            </div>
          </div>
        ) : null}
        {pullRequests.length > 0 ? (
          <div className="pr-list">
            {pullRequests.map((pr) => (
              <button
                className="pr-row"
                key={pr.number}
                onClick={() =>
                  desktop?.openExternal(pr.url).catch((value) => setError(readableError(value)))
                }
                title="Open pull request on GitHub"
                type="button"
              >
                <span className="pr-number">#{pr.number}</span>
                <span className="pr-copy">
                  <strong>{pr.title}</strong>
                  <small>
                    {pr.head} <span>→</span> {pr.base}
                  </small>
                </span>
                <Badge variant={checksVariant(pr.checks)}>
                  <ShieldCheck className="size-3" />
                  {checkLabel(pr.checks)}
                </Badge>
                <Badge variant={pr.state === 'OPEN' ? 'success' : 'secondary'}>
                  {pr.draft ? 'draft' : pr.state.toLowerCase()}
                </Badge>
                <ExternalLink className="size-4" />
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <GitPullRequest className="empty-icon" />
            <h2>{search ? 'No matching pull requests' : 'No pull requests'}</h2>
            <p>
              {snapshot.github.available
                ? 'Create a pull request from the current branch when it is ready.'
                : 'Connect the GitHub CLI to see pull requests.'}
            </p>
          </div>
        )}
      </div>
    )
  }

  const renderStashes = () => {
    if (!snapshot) return null
    return (
      <div className="stashes-view">
        <div className="list-toolbar">
          <div className="list-title-group">
            <h1>Stashes</h1>
            <span className="list-subtitle">{snapshot.stashes.length} saved</span>
          </div>
          <Button
            disabled={snapshot.files.length === 0 || isBusy}
            onClick={() => runAction({ type: 'stash' }, 'Stash changes')}
            size="sm"
            variant="accent"
          >
            <Archive className="size-3.5" />
            Stash current changes
          </Button>
        </div>
        {snapshot.stashes.length > 0 ? (
          <div className="stash-list" role="list">
            {snapshot.stashes.map((stash) => (
              <div className="stash-row" key={stash.ref}>
                <Archive className="size-4" />
                <span className="stash-copy">
                  <strong>{stash.message || 'WIP'}</strong>
                  <small>{stash.ref}</small>
                </span>
                <Button
                  disabled={isBusy}
                  onClick={() => runAction({ type: 'stashPop', ref: stash.ref }, 'Restore stash')}
                  size="sm"
                  variant="secondary"
                >
                  <RotateCcw className="size-3.5" />
                  Restore
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <Archive className="empty-icon" />
            <h2>No stashes</h2>
            <p>Stash changes before switching context when you need a clean tree.</p>
          </div>
        )}
      </div>
    )
  }

  const renderMainContent = () => {
    if (!snapshot) return null
    if (workspaceView === 'changes') return renderChanges()
    if (workspaceView === 'pullRequests') return renderPullRequests()
    if (workspaceView === 'stashes') return renderStashes()
    return (
      <div className="branches-view">
        {renderBranchFilters()}
        {renderBranchList()}
      </div>
    )
  }

  const renderDetails = () => {
    if (!snapshot) {
      return (
        <aside className="details-pane details-pane-empty">
          <div className="details-placeholder">
            <PanelRightClose className="size-5" />
            <span>Branch details will appear here.</span>
          </div>
        </aside>
      )
    }
    if (!selectedBranch) {
      return (
        <aside className="details-pane details-pane-empty">
          <div className="details-placeholder">
            <GitBranch className="size-5" />
            <span>Select a branch to inspect its stack.</span>
          </div>
        </aside>
      )
    }
    const parent = selectedBranch.parent
      ? snapshot.branches.find((branch) => branch.name === selectedBranch.parent)
      : null
    const canRebase = Boolean(
      selectedBranch.current &&
      selectedBranch.parent &&
      !selectedBranch.remote &&
      !snapshot.rebaseInProgress,
    )
    return (
      <aside className="details-pane" aria-label="Selected branch details">
        <div className="details-header">
          <div>
            <h2 title={selectedBranch.name}>{selectedBranch.name}</h2>
          </div>
          <IconButton label="Clear branch selection" onClick={() => setSelectedBranchRef(null)}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="details-scroll">
          <div className="details-status-row">
            {selectedBranch.current ? (
              <Badge variant="accent">
                <Circle className="size-2.5 fill-current" />
                Current
              </Badge>
            ) : (
              <Badge variant="secondary">{selectedBranch.remote ? 'Remote' : 'Local'}</Badge>
            )}
            {selectedPullRequest ? (
              <Badge variant={checksVariant(selectedPullRequest.checks)}>
                <ShieldCheck className="size-3" />
                {checkLabel(selectedPullRequest.checks)}
              </Badge>
            ) : null}
          </div>
          <section className="detail-section">
            <h3>Stack position</h3>
            <div className="detail-grid">
              <span>Parent</span>
              <strong className={selectedBranch.parent && !parent ? 'detail-missing' : ''}>
                {selectedBranch.parent ?? 'No parent'}
              </strong>
              <span>Upstream</span>
              <strong>{selectedBranch.upstream ?? 'Not tracking'}</strong>
              <span>Last update</span>
              <strong>{formatBranchDate(selectedBranch.updatedAt)}</strong>
            </div>
          </section>
          <section className="detail-section">
            <h3>Sync status</h3>
            <div className="sync-stat-grid">
              <div>
                <ArrowUp className="size-3.5" />
                <strong>{selectedBranch.ahead}</strong>
                <span>ahead</span>
              </div>
              <div>
                <ArrowDown className="size-3.5" />
                <strong>{selectedBranch.behind}</strong>
                <span>behind</span>
              </div>
            </div>
          </section>
          {selectedPullRequest ? (
            <section className="detail-section">
              <h3>Pull request</h3>
              <div className="pr-detail">
                <div className="pr-detail-heading">
                  <GitPullRequest className="size-4" />
                  <strong>
                    #{selectedPullRequest.number} {selectedPullRequest.title}
                  </strong>
                </div>
                <div className="pr-detail-meta">
                  <Badge variant={selectedPullRequest.state === 'OPEN' ? 'success' : 'secondary'}>
                    {selectedPullRequest.state.toLowerCase()}
                  </Badge>
                  {selectedPullRequest.draft ? <Badge variant="outline">draft</Badge> : null}
                  <span>
                    {selectedPullRequest.head} → {selectedPullRequest.base}
                  </span>
                </div>
                <Button
                  onClick={() =>
                    desktop
                      ?.openExternal(selectedPullRequest.url)
                      .catch((value) => setError(readableError(value)))
                  }
                  size="sm"
                  variant="secondary"
                >
                  <ExternalLink className="size-3.5" />
                  Open on GitHub
                </Button>
              </div>
            </section>
          ) : (
            <section className="detail-section detail-section-muted">
              <h3>Pull request</h3>
              <p>No pull request for this branch.</p>
              <Button
                disabled={!selectedBranch.current || !snapshot.github.available || isBusy}
                onClick={openPrDialog}
                size="sm"
                variant="secondary"
              >
                <GitPullRequest className="size-3.5" />
                Create pull request
              </Button>
              {!selectedBranch.current ? (
                <small>Switch to this branch to create its pull request.</small>
              ) : !snapshot.github.available ? (
                <small>{snapshot.github.message || 'GitHub CLI is unavailable.'}</small>
              ) : null}
            </section>
          )}
          <section className="detail-section detail-actions">
            <h3>Branch actions</h3>
            <Button
              disabled={selectedBranch.current || isBusy || snapshot.rebaseInProgress}
              onClick={() =>
                runAction({ type: 'switch', ref: selectedBranch.ref }, 'Switch branch')
              }
              variant="accent"
            >
              <ArrowLeftRight className="size-3.5" />
              Switch to this branch
            </Button>
            <Button
              disabled={!canRebase || isBusy}
              onClick={() =>
                runAction(
                  { type: 'rebase', parent: selectedBranch.parent as string },
                  'Rebase onto parent',
                )
              }
              variant="secondary"
            >
              <GitMerge className="size-3.5" />
              Rebase current onto parent
            </Button>
            {!selectedBranch.current ? (
              <span className="action-hint">Switch to this branch before rebasing.</span>
            ) : selectedBranch.remote ? (
              <span className="action-hint">Remote branches cannot be rebased directly.</span>
            ) : !selectedBranch.parent ? (
              <span className="action-hint">This branch has no recorded parent.</span>
            ) : null}
          </section>
        </div>
      </aside>
    )
  }

  const renderOnboarding = () => (
    <div className="onboarding-pane">
      <div className="onboarding-content">
        <div className="onboarding-icon">
          <GitBranch className="size-7" />
        </div>
        <h1>Open a repository</h1>
        <p>
          Git Stacks gives you a focused view of branches, working changes, and pull requests
          without leaving your desktop.
        </p>
        <Button disabled={opening} onClick={() => openRepository()} size="lg" variant="accent">
          {opening ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <FolderOpen className="size-4" />
          )}
          Open local repository
        </Button>
        {!desktop ? (
          <div className="desktop-notice" role="status">
            <Terminal className="size-4" />
            <span>
              Open Git Stacks in the desktop app to access local Git repositories. This browser view
              does not include demo data.
            </span>
          </div>
        ) : null}
        {recentRepositories.length > 0 ? (
          <div className="onboarding-recents">
            <div className="onboarding-recents-heading">
              <Clock3 className="size-4" />
              <h2>Recent repositories</h2>
            </div>
            {recentRepositories.map((repository) => (
              <button
                className="onboarding-recent"
                disabled={opening}
                key={repository.path}
                onClick={() => openRepository(repository.path)}
                type="button"
              >
                <FolderGit2 className="size-4" />
                <span>
                  <strong>{repository.name}</strong>
                  <small>{repository.path}</small>
                </span>
                <ChevronRight className="size-4" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="traffic-lights" aria-hidden="true" />
        <div className="titlebar-brand">
          <GitBranch className="size-4" />
          <strong>Git Stacks</strong>
        </div>
        <div className="titlebar-context">{snapshot ? snapshot.name : 'Repository workbench'}</div>
        <div className="titlebar-spacer" />
        {snapshot?.rebaseInProgress ? (
          <Badge variant="warning">
            <RotateCcw className="size-3" />
            Rebase in progress
          </Badge>
        ) : null}
        <span className="titlebar-build">Native Git workspace</span>
      </header>
      {error ? (
        <div className="global-banner global-banner-error" role="alert">
          <AlertCircle className="size-4" />
          <span>{error}</span>
          <IconButton label="Dismiss error" onClick={() => setError(null)}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      ) : null}
      {actionError ? (
        <div className="global-banner global-banner-error" role="alert">
          <TriangleAlert className="size-4" />
          <span>{actionError}</span>
          <IconButton label="Dismiss action error" onClick={() => setActionError(null)}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      ) : null}
      {notice ? (
        <div className="global-banner global-banner-success" role="status">
          <Check className="size-4" />
          <span>{notice}</span>
          <IconButton label="Dismiss notice" onClick={() => setNotice(null)}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      ) : null}
      {snapshot ? renderToolbar() : null}
      <div className={cn('workspace', !showDetails && 'workspace-details-hidden')}>
        {renderSidebar()}
        {snapshot ? <main className="main-pane">{renderMainContent()}</main> : renderOnboarding()}
        {showDetails ? renderDetails() : null}
      </div>
      <Dialog onOpenChange={setNewBranchOpen} open={newBranchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a branch</DialogTitle>
            <DialogDescription>
              Start a new stack branch from an existing local branch.
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={submitBranch}>
            <label htmlFor="new-branch-name">Branch name</label>
            <Input
              autoFocus
              id="new-branch-name"
              onChange={(event) => setNewBranchName(event.target.value)}
              placeholder="feature/short-description"
              value={newBranchName}
            />
            <label htmlFor="new-branch-parent">Parent branch</label>
            <select
              id="new-branch-parent"
              onChange={(event) => setNewBranchParent(event.target.value)}
              value={newBranchParent}
            >
              {(snapshot?.branches ?? [])
                .filter((branch) => !branch.remote)
                .map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                    {branch.current ? ' (current)' : ''}
                  </option>
                ))}
            </select>
            {newBranchError ? (
              <p className="form-error" role="alert">
                {newBranchError}
              </p>
            ) : null}
            <DialogFooter>
              <Button onClick={() => setNewBranchOpen(false)} variant="secondary">
                Cancel
              </Button>
              <Button disabled={isBusy} type="submit" variant="accent">
                {busyAction === 'Create branch' ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
                Create branch
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setPrOpen} open={prOpen}>
        <DialogContent className="pr-dialog-content">
          <DialogHeader>
            <DialogTitle>Create pull request</DialogTitle>
            <DialogDescription>
              Open a pull request from {selectedBranch?.name ?? 'this branch'} into a base branch.
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={submitPr}>
            <label htmlFor="pr-title">Title</label>
            <Input
              autoFocus
              id="pr-title"
              onChange={(event) => setPrTitle(event.target.value)}
              placeholder="What does this stack change?"
              value={prTitle}
            />
            <label htmlFor="pr-base">Base branch</label>
            <Input
              id="pr-base"
              list="pr-base-options"
              onChange={(event) => setPrBase(event.target.value)}
              value={prBase}
            />
            <datalist id="pr-base-options">
              {(snapshot?.branches ?? [])
                .filter((branch) => !branch.remote && branch.name !== currentBranch)
                .map((branch) => (
                  <option key={branch.name} value={branch.name} />
                ))}
            </datalist>
            <label htmlFor="pr-body">
              Description <span className="optional-label">optional</span>
            </label>
            <textarea
              id="pr-body"
              onChange={(event) => setPrBody(event.target.value)}
              placeholder="Add context for reviewers"
              rows={5}
              value={prBody}
            />
            <label className="checkbox-label" htmlFor="pr-draft">
              <input
                checked={prDraft}
                id="pr-draft"
                onChange={(event) => setPrDraft(event.target.checked)}
                type="checkbox"
              />
              <span>Mark as draft</span>
            </label>
            {prError ? (
              <p className="form-error" role="alert">
                {prError}
              </p>
            ) : null}
            <DialogFooter>
              <Button onClick={() => setPrOpen(false)} variant="secondary">
                Cancel
              </Button>
              <Button
                disabled={!snapshot?.github.available || !selectedBranch?.current || isBusy}
                type="submit"
                variant="accent"
              >
                {busyAction === 'Create pull request' ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <GitPullRequest className="size-3.5" />
                )}
                Create pull request
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {!desktop ? (
        <div className="browser-disclaimer">
          <Info className="size-3.5" />
          Desktop API unavailable — local repository actions are disabled outside Electron.
        </div>
      ) : null}
    </div>
  )
}

export default App
