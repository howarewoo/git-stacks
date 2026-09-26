import * as React from 'react'
import { DropdownMenu } from './components/ui/dropdown-menu'
import {
  Archive,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Download,
  Files,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  Info,
  History,
  LoaderCircle,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import type {
  Branch,
  ChangedFile,
  DesktopAPI,
  GitAction,
  RecentRepository,
  RepositorySnapshot,
} from '../../shared/types'
import { Badge } from './components/ui/badge'
import { Button, IconButton } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { Input } from './components/ui/input'
import { SegmentedControl } from './components/ui/segmented-control'
import { Select } from './components/ui/select'
import { Textarea } from './components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip'
import { BranchHoverCard, PullRequestHoverCard } from './components/repository-hover-cards'
import { Field } from './components/ui/field'
import { cn } from './lib/utils'
import { EmptyState, InlineAlert } from './components/ui/surface'
import { checkLabel, checksVariant } from './lib/pull-request-state'
import {
  branchFilterOptions,
  getBranchWorkspace,
  resolveSelectedBranch,
  type BranchFilter,
} from './lib/branch-workspace'
import { BranchTree } from './components/branch-workspace'
import { BranchInspector } from './components/branch-inspector'
import { WorkflowDialog, type WorkflowRequest } from './components/workflow-dialog'
import { WorkspaceNavigation } from './components/workspace-navigation'
import {
  FileInspector,
  HistoryView,
  OperationBanner,
  StackView,
} from './components/repository-views'
import {
  OperationContext,
  PhaseStatus,
  WorkflowActions,
  TypedConfirmation,
  WorkflowFrame,
} from './components/workflow-composition'
import { CLOSE_INTENT_MESSAGES, closeIntent } from './components/workflow-policy'

type WorkspaceView = 'branches' | 'stacks' | 'history' | 'changes' | 'pullRequests' | 'stashes'

function readableError(value: unknown): string {
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'string' && value) return value
  return 'The operation failed. Check the repository and try again.'
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
  const [newBranchEdited, setNewBranchEdited] = React.useState(false)
  const [newBranchError, setNewBranchError] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<{
    branch: Branch
    repoPath: string
  } | null>(null)
  const [deleteForce, setDeleteForce] = React.useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = React.useState('')
  const [deleteBranchError, setDeleteBranchError] = React.useState<string | null>(null)
  const [prOpen, setPrOpen] = React.useState(false)
  const [prTitle, setPrTitle] = React.useState('')
  const [deleteCloseNotice, setDeleteCloseNotice] = React.useState<string | null>(null)
  const [newBranchNotice, setNewBranchNotice] = React.useState<string | null>(null)
  const [prNotice, setPrNotice] = React.useState<string | null>(null)
  const [prBody, setPrBody] = React.useState('')
  const [prBase, setPrBase] = React.useState('')
  const [prDraft, setPrDraft] = React.useState(false)
  const [prEdited, setPrEdited] = React.useState(false)
  const [prError, setPrError] = React.useState<string | null>(null)
  const [commitMessage, setCommitMessage] = React.useState('')
  const [commitAmend, setCommitAmend] = React.useState(false)
  const [inspectedPath, setInspectedPath] = React.useState<string | null>(null)
  const [workflow, setWorkflow] = React.useState<{
    id: number
    repoPath: string
    request: WorkflowRequest
  } | null>(null)
  const workflowSequence = React.useRef(0)

  const [showDetails, setShowDetails] = React.useState(true)
  const refreshSequence = React.useRef(0)
  const busyRef = React.useRef<string | null>(null)
  const openingRef = React.useRef(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const deleteCancelRef = React.useRef<HTMLButtonElement>(null)
  const deleteTriggerRef = React.useRef<HTMLButtonElement>(null)

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
          setDeleteTarget(null)
          setWorkflow(null)
          setInspectedPath(null)
          setCommitAmend(false)
          setCommitMessage('')
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
        if (action.type === 'renameBranch') setSelectedBranchRef(`refs/heads/${action.name}`)
        if (
          action.type === 'commit' ||
          action.type === 'switch' ||
          action.type === 'createBranch'
        ) {
          setCommitAmend(false)
          setCommitMessage('')
        }
        return true
      } catch (value) {
        if (action.type === 'createBranch') setNewBranchError(readableError(value))
        if (action.type === 'createPr') setPrError(readableError(value))
        if (action.type === 'deleteBranch') setDeleteBranchError(readableError(value))
        setActionError(`${label} failed: ${readableError(value)}`)
        const next = await refreshSnapshot()
        if (
          next?.operation ||
          next?.stackOperation ||
          next?.files.some((file) => file.conflicted)
        ) {
          setWorkspaceView('changes')
          setInspectedPath(next.files.find((file) => file.conflicted)?.path ?? null)
          setWorkflow(null)
        }
        return false
      } finally {
        busyRef.current = null
        setBusyAction(null)
      }
    },
    [desktop, refreshSnapshot, snapshot],
  )

  const branchWorkspace = React.useMemo(
    () => getBranchWorkspace(snapshot?.branches ?? [], branchFilter, search),
    [branchFilter, search, snapshot],
  )

  const selectedBranch = React.useMemo(
    () => resolveSelectedBranch(snapshot?.branches ?? [], selectedBranchRef, branchFilter),
    [branchFilter, selectedBranchRef, snapshot],
  )

  const selectedPullRequest = React.useMemo(() => {
    if (!snapshot || !selectedBranch) return null
    return selectedBranch.pr
  }, [selectedBranch, snapshot])

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
  const branchCount = branchWorkspace.combined.length
  const pullRequestCount = snapshot?.pullRequests.length ?? 0
  const stashCount = snapshot?.stashes.length ?? 0
  const detailsVisible = showDetails && (workspaceView === 'branches' || workspaceView === 'stacks')
  const operationActive = Boolean(snapshot?.operation || snapshot?.stackOperation)
  const openWorkflow = (request: WorkflowRequest) => {
    if (!snapshot || isBusy) return
    setActionError(null)
    setWorkflow({ id: ++workflowSequence.current, repoPath: snapshot.path, request })
  }
  const deleteChildren = deleteTarget
    ? allBranches.filter(
        (branch) =>
          !branch.remote &&
          branch.parent &&
          branchWorkspace.byName.get(branch.parent)?.ref === deleteTarget.branch.ref,
      )
    : []

  const openBranchDialog = React.useCallback(() => {
    if (!snapshot) return
    setNewBranchName('')
    setNewBranchParent(
      snapshot.currentBranch ?? snapshot.defaultBranch ?? snapshot.branches[0]?.name ?? '',
    )
    setNewBranchEdited(false)
    setNewBranchError(null)
    setNewBranchOpen(true)
  }, [snapshot])

  const openPrDialog = React.useCallback(() => {
    if (!snapshot || !selectedBranch?.current || selectedBranch.remote) return
    setPrTitle(selectedBranch.subject || `Open ${selectedBranch.name}`)
    setPrBody('')
    setPrBase(selectedBranch.parent ?? snapshot.defaultBranch)
    setPrDraft(false)
    setPrEdited(false)
    setPrError(null)
    setPrOpen(true)
  }, [selectedBranch, snapshot])

  const openDeleteDialog = () => {
    if (
      !snapshot ||
      !selectedBranch ||
      selectedBranch.remote ||
      selectedBranch.current ||
      selectedBranch.name === snapshot.defaultBranch ||
      isBusy ||
      operationActive
    )
      return
    setDeleteTarget({ branch: selectedBranch, repoPath: snapshot.path })
    setDeleteForce(false)
    setDeleteConfirmation('')
    setDeleteBranchError(null)
    setActionError(null)
  }

  const submitDeleteBranch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!deleteTarget || isBusy) return
    if (snapshot?.path !== deleteTarget.repoPath) {
      setDeleteBranchError('The repository changed. Close this dialog and select the branch again.')
      return
    }
    if (deleteForce && deleteConfirmation !== deleteTarget.branch.name) {
      setDeleteBranchError('Type the exact branch name to confirm deletion of unmerged work.')
      return
    }
    const expectedOid = deleteTarget.branch.oid
    if (!expectedOid) {
      setDeleteBranchError('The branch tip is unknown. Close this dialog and select it again.')
      return
    }
    setDeleteBranchError(null)
    const success = await runAction(
      {
        type: 'deleteBranch',
        ref: deleteTarget.branch.ref,
        force: deleteForce,
        expectedOid,
      },
      'Delete branch',
    )
    if (success) setDeleteTarget(null)
  }

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
    if (!snapshot || !message || (!commitAmend && stagedFiles.length === 0)) return
    const action: GitAction = {
      type: 'commit',
      message,
      amend: commitAmend,
      expectedHead: snapshot.headOid,
      expectedHeadRef: snapshot.currentBranch ? `refs/heads/${snapshot.currentBranch}` : 'HEAD',
    }
    if (commitAmend) {
      openWorkflow({
        kind: 'confirm',
        action,
        title: 'Amend the last commit?',
        description: `Replace the last commit on ${currentBranch} with the entered message and staged changes. Its commit ID will change. Restack dependent branches and use force-with-lease if already published.`,
        label: 'Amend commit',
        destructive: true,
      })
    } else {
      await runAction(action, 'Commit staged changes')
    }
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
          <WorkspaceNavigation
            activeView={workspaceView}
            branchCount={branchCount}
            changeCount={snapshot?.files.length ?? 0}
            onSelect={setWorkspaceView}
            pullRequestCount={pullRequestCount}
            stashCount={stashCount}
          />
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

  const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+'

  const renderToolbar = () => (
    <div className="toolbar" role="toolbar" aria-label="Repository actions">
      <div className="toolbar-actions">
        <div className="toolbar-action-group" role="group" aria-label="Synchronization actions">
          <Button
            disabled={!snapshot || isBusy || operationActive}
            onClick={() => runAction({ type: 'fetch' }, 'Fetch')}
            tooltip="Fetch remote updates without changing your working tree."
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
            disabled={!snapshot || isBusy || operationActive}
            onClick={() => openWorkflow({ kind: 'pull' })}
            tooltip="Choose how to integrate updates from this branch’s upstream."
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
            disabled={!snapshot || isBusy || operationActive}
            onClick={() => runAction({ type: 'push' }, 'Push')}
            tooltip="Push the current branch without rewriting remote history."
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
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-action-group" role="group" aria-label="Branch and Git actions">
          <Button
            disabled={!snapshot || isBusy || operationActive}
            tooltip="Create a local branch from an existing branch and switch to it. Records its stack parent; nothing is pushed."
            onClick={openBranchDialog}
            size="sm"
          >
            <Plus className="size-3.5" />
            New branch
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                aria-label="More Git actions"
                tooltip="More actions: preview merge, force push with lease, stash, or browse history."
                size="icon-sm"
                variant="secondary"
                disabled={!snapshot || isBusy}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="workflow-menu" align="start" sideOffset={6}>
                <DropdownMenu.Item
                  disabled={operationActive || !currentBranch}
                  onSelect={() => openWorkflow({ kind: 'merge' })}
                >
                  Merge into current branch…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={
                    operationActive || !currentBranch || currentBranch === snapshot?.defaultBranch
                  }
                  onSelect={() => openWorkflow({ kind: 'forcePush' })}
                >
                  Force push with lease…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={operationActive || !snapshot?.files.length}
                  onSelect={() => openWorkflow({ kind: 'stash' })}
                >
                  Stash changes…
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="workflow-menu-separator" />
                <DropdownMenu.Item onSelect={() => setWorkspaceView('history')}>
                  Browse commit history
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      <div className="toolbar-spacer" />
      <div className="toolbar-search">
        <Search className="size-3.5" />
        <Input
          aria-keyshortcuts="Meta+K Control+K"
          aria-label="Search branches, files, and pull requests"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
          ref={searchRef}
          value={search}
        />
        <kbd>{shortcutModifier} K</kbd>
      </div>
      <div className="toolbar-control-slot">
        <IconButton
          className="toolbar-control"
          label="Refresh repository"
          onClick={() => refreshSnapshot()}
          disabled={!snapshot || isBusy}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className={cn('size-4', refreshing && 'animate-spin')} />
        </IconButton>
      </div>
      {snapshot && (workspaceView === 'branches' || workspaceView === 'stacks') ? (
        <Button
          aria-controls={detailsVisible ? 'branch-inspector' : undefined}
          aria-expanded={detailsVisible}
          aria-label={detailsVisible ? 'Hide details pane' : 'Show details pane'}
          className="toolbar-control toolbar-details-toggle"
          onClick={() => setShowDetails((value) => !value)}
          size="sm"
          variant="secondary"
        >
          {detailsVisible ? (
            <PanelRightClose aria-hidden="true" className="size-4" />
          ) : (
            <PanelRightOpen aria-hidden="true" className="size-4" />
          )}
          Details
        </Button>
      ) : null}
    </div>
  )

  const renderBranchFilters = () => (
    <div className="list-toolbar">
      <div className="list-title-group">
        <h1>Branches</h1>
        <span className="list-subtitle">
          {branchWorkspace.shown} of {branchWorkspace.total} shown
        </span>
      </div>
      <SegmentedControl<BranchFilter>
        label="Branch filters"
        value={branchFilter}
        onValueChange={setBranchFilter}
        options={branchFilterOptions}
      />
    </div>
  )

  const renderBranchList = () => {
    if (!snapshot) return null
    if (!branchWorkspace.visible.length) {
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
            <Button
              onClick={openBranchDialog}
              size="sm"
              variant="accent"
              tooltip="Create a local branch to start a stack. Switches to it; nothing is pushed."
            >
              <Plus className="size-3.5" />
              New branch
            </Button>
          ) : null}
        </div>
      )
    }

    return (
      <BranchTree
        branches={branchWorkspace.visible}
        onOpenPullRequest={(pullRequest) =>
          desktop?.openExternal(pullRequest.url).catch((value) => setError(readableError(value)))
        }
        onSelect={setSelectedBranchRef}
        rows={branchWorkspace.rows}
        selectedRef={selectedBranch?.ref ?? null}
      />
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
            tooltip="Shelve tracked working changes into a local stash and restore a clean tree. Choose whether untracked files are included."
            onClick={() => openWorkflow({ kind: 'stash' })}
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
              <Button
                size="sm"
                variant="ghost"
                disabled={isBusy || !visibleStagedFiles.length}
                tooltip={
                  fileSearch
                    ? 'Remove the shown files from the index; working-tree edits remain. Hidden staged files stay staged.'
                    : 'Remove all staged changes from the index; working-tree edits remain. Nothing is discarded.'
                }
                onClick={() =>
                  runAction(
                    {
                      type: 'unstage',
                      paths: [
                        ...new Set(
                          visibleStagedFiles.flatMap((file) =>
                            file.originalPath ? [file.path, file.originalPath] : [file.path],
                          ),
                        ),
                      ],
                    },
                    'Unstage files',
                  )
                }
              >
                {fileSearch ? 'Unstage shown' : 'Unstage all'}
              </Button>
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
              <Button
                size="sm"
                variant="ghost"
                disabled={isBusy || !visibleUnstagedFiles.length || conflictedFiles.length > 0}
                tooltip={
                  conflictedFiles.length > 0
                    ? 'Resolve conflicts before staging — conflicted files cannot be staged in bulk.'
                    : fileSearch
                      ? 'Stage the shown working-tree changes for the next commit. Hidden unstaged files stay unstaged.'
                      : 'Stage all working-tree changes for the next commit. Local index only; nothing is committed yet.'
                }
                onClick={() =>
                  runAction(
                    { type: 'stage', paths: visibleUnstagedFiles.map((file) => file.path) },
                    'Stage files',
                  )
                }
              >
                {fileSearch ? 'Stage shown' : 'Stage all'}
              </Button>
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
        {inspectedPath && snapshot.files.some((file) => file.path === inspectedPath) ? (
          <FileInspector
            key={inspectedPath}
            path={inspectedPath}
            snapshot={snapshot}
            busy={isBusy}
            runAction={runAction}
            onClose={() => setInspectedPath(null)}
            actionError={actionError}
          />
        ) : null}
        <form className="commit-panel" onSubmit={submitCommit}>
          <div className="commit-panel-heading">
            <GitCommitHorizontal className="size-4" />
            <div>
              <h2>{commitAmend ? 'Amend the last commit' : 'Commit staged changes'}</h2>
              <span>
                {commitAmend
                  ? 'Enter the full replacement message. Staged changes are included.'
                  : 'Only staged files will be included.'}
              </span>
            </div>
          </div>
          <Checkbox
            id="commit-amend"
            className="commit-amend"
            label={
              <>
                Amend last commit
                {currentBranch === snapshot.defaultBranch ? ' (protected on default branch)' : ''}
              </>
            }
            checked={commitAmend}
            disabled={
              isBusy ||
              operationActive ||
              !snapshot.headOid ||
              currentBranch === snapshot.defaultBranch
            }
            onChange={(event) => setCommitAmend(event.target.checked)}
          />
          <div className="commit-form-row">
            <Textarea
              className="commit-message"
              aria-label="Commit message"
              disabled={(!commitAmend && stagedFiles.length === 0) || isBusy || operationActive}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Summary and optional commit body"
              rows={2}
              value={commitMessage}
            />
            <Button
              disabled={
                !commitMessage.trim() ||
                (!commitAmend && stagedFiles.length === 0) ||
                isBusy ||
                operationActive
              }
              type="submit"
              variant="accent"
              tooltip={
                commitAmend
                  ? 'Preview rewriting the last commit with the new message plus staged changes. Rewrites local history; pushed commits will need force push.'
                  : 'Create a local commit from staged changes only. Unstaged edits stay in the working tree; nothing is pushed.'
              }
            >
              {busyAction === 'Commit staged changes' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <GitCommitHorizontal className="size-3.5" />
              )}
              {commitAmend ? 'Review amend…' : 'Commit'}
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
      <button
        className="file-path"
        title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
        type="button"
        onClick={() => {
          setActionError(null)
          setInspectedPath(file.path)
        }}
        aria-label={`${file.conflicted ? 'Resolve' : 'Inspect'} ${file.path}`}
      >
        {file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
      </button>
      <Button
        disabled={isBusy}
        tooltip={
          action === 'stage'
            ? "Stage this file's working-tree changes for the next commit. Local index only."
            : 'Remove this file from the index; its working-tree edits remain. Nothing is discarded.'
        }
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
            tooltip={
              !snapshot.github.available
                ? snapshot.github.message ||
                  'Connect an authenticated GitHub repository to create pull requests.'
                : !selectedBranch?.current
                  ? 'Switch to a local branch to open its pull request on GitHub.'
                  : 'Review creating a PR from this branch’s published upstream. Unpushed commits are not included.'
            }
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
              <PullRequestHoverCard pr={pr} key={pr.number}>
                <button
                  className="pr-row"
                  onClick={() => openWorkflow({ kind: 'pr', number: pr.number })}
                  disabled={isBusy}
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
                  <ChevronRight className="size-4" />
                </button>
              </PullRequestHoverCard>
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
            tooltip="Shelve current working changes into a local stash and restore a clean tree. Choose whether untracked files are included."
            onClick={() => openWorkflow({ kind: 'stash' })}
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
              <div className="stash-row" key={stash.oid}>
                <Archive className="size-4" />
                <span className="stash-copy">
                  <strong>{stash.message || 'WIP'}</strong>
                  <small>{stash.ref}</small>
                </span>
                <Button
                  disabled={isBusy || operationActive}
                  tooltip="Restore this stash’s working changes and saved staging state, and keep the stash. May conflict with current edits."
                  onClick={() =>
                    runAction({ type: 'stashApply', ref: stash.ref, oid: stash.oid }, 'Apply stash')
                  }
                  size="sm"
                  variant="ghost"
                >
                  Apply
                </Button>
                <Button
                  disabled={isBusy}
                  tooltip="Reapply this stash to the working tree, then delete it from the list. Stops on conflicts so saved changes are not lost silently."
                  onClick={() =>
                    runAction({ type: 'stashPop', ref: stash.ref, oid: stash.oid }, 'Pop stash')
                  }
                  size="sm"
                  variant="secondary"
                >
                  <RotateCcw className="size-3.5" />
                  Pop
                </Button>
                <Button
                  disabled={isBusy || operationActive}
                  tooltip="Preview permanently removing this saved stash without applying it. This app cannot restore a dropped stash."
                  onClick={() =>
                    openWorkflow({
                      kind: 'confirm',
                      title: 'Drop this stash?',
                      description: `Permanently remove ${stash.ref}: ${stash.message}. Its saved changes will not be applied.`,
                      label: 'Drop stash',
                      action: { type: 'stashDrop', ref: stash.ref, oid: stash.oid },
                      destructive: true,
                    })
                  }
                  size="sm"
                  variant="danger"
                >
                  Drop…
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
    if (workspaceView === 'history')
      return (
        <HistoryView snapshot={snapshot} busy={isBusy} onRequest={openWorkflow} search={search} />
      )
    if (workspaceView === 'stacks')
      return (
        <StackView
          snapshot={snapshot}
          busy={isBusy}
          onRequest={openWorkflow}
          onSelect={(branch) => setSelectedBranchRef(branch.ref)}
          search={search}
          onCreate={openBranchDialog}
        />
      )
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
        <aside className="details-pane details-pane-empty" id="branch-inspector">
          <EmptyState>
            <PanelRightClose aria-hidden="true" className="size-5" />
            <strong>No repository open</strong>
            <span>Open a local repository to inspect branches, changes, and pull requests.</span>
            <Button
              disabled={opening}
              onClick={() => openRepository()}
              size="sm"
              variant="secondary"
            >
              Open repository
            </Button>
          </EmptyState>
        </aside>
      )
    }
    if (!selectedBranch) {
      return (
        <aside className="details-pane details-pane-empty" id="branch-inspector">
          <EmptyState>
            <GitBranch aria-hidden="true" className="size-5" />
            <strong>No branch selected</strong>
            <span>Select a branch to inspect its stack position, upstream, and pull request.</span>
          </EmptyState>
        </aside>
      )
    }
    const parent = selectedBranch.parent
      ? (branchWorkspace.byName.get(selectedBranch.parent) ?? null)
      : null
    return (
      <BranchInspector
        branch={selectedBranch}
        busy={isBusy}
        defaultBranch={snapshot.defaultBranch}
        deleteButtonRef={deleteTriggerRef}
        github={snapshot.github}
        onClose={() => setSelectedBranchRef(null)}
        onCreatePullRequest={openPrDialog}
        onDeleteLocal={openDeleteDialog}
        onDeleteRemote={() => openWorkflow({ kind: 'deleteRemote', branch: selectedBranch })}
        onManagePullRequest={() =>
          openWorkflow({ kind: 'pr', number: selectedPullRequest?.number as number })
        }
        onOpenExternal={(url) =>
          desktop?.openExternal(url).catch((value) => setError(readableError(value)))
        }
        onPreviewMerge={() =>
          openWorkflow({ kind: 'stack', operation: 'merge', branch: selectedBranch.name })
        }
        onPublish={() =>
          openWorkflow({ kind: 'stack', operation: 'publish', branch: selectedBranch.name })
        }
        onRebaseOntoParent={() =>
          openWorkflow({
            kind: 'confirm',
            action: { type: 'rebase', parent: selectedBranch.parent as string },
            title: 'Rebase current branch?',
            label: 'Rebase onto parent',
            description:
              'This rewrites only the current branch. Use Restack stack to update dependent branches together.',
          })
        }
        onRename={() => openWorkflow({ kind: 'rename', branch: selectedBranch })}
        onRestack={() =>
          openWorkflow({ kind: 'stack', operation: 'restack', branch: selectedBranch.name })
        }
        onSetParent={() => openWorkflow({ kind: 'parent', branch: selectedBranch })}
        onSetUpstream={() => openWorkflow({ kind: 'upstream', branch: selectedBranch })}
        onSwitch={() => runAction({ type: 'switch', ref: selectedBranch.ref }, 'Switch branch')}
        operationActive={operationActive}
        parent={parent}
        pullRequest={selectedPullRequest}
      />
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
        <div
          aria-label={
            snapshot ? `Repository ${snapshot.name}, ${snapshot.path}` : 'Repository workbench'
          }
          className="titlebar-context"
          tabIndex={snapshot ? 0 : undefined}
          title={snapshot?.path}
        >
          {snapshot ? snapshot.name : 'Repository workbench'}
        </div>
        <div className="titlebar-spacer" />
        {operationActive ? (
          <Badge variant="warning">
            <RotateCcw className="size-3" />
            {snapshot?.stackOperation ? 'Stack operation in progress' : 'Git operation in progress'}
          </Badge>
        ) : null}
        <span className="titlebar-build">Native Git workspace</span>
      </header>
      {error ? (
        <InlineAlert tone="error" className="global-banner" role="alert">
          <span className="global-banner-row">
            <span>{error}</span>
            <IconButton label="Dismiss error" onClick={() => setError(null)}>
              <X aria-hidden="true" className="size-3.5" />
            </IconButton>
          </span>
        </InlineAlert>
      ) : null}
      {actionError ? (
        <InlineAlert tone="error" className="global-banner" role="alert">
          <span className="global-banner-row">
            <span>{actionError}</span>
            <IconButton label="Dismiss action error" onClick={() => setActionError(null)}>
              <X aria-hidden="true" className="size-3.5" />
            </IconButton>
          </span>
        </InlineAlert>
      ) : null}
      {notice ? (
        <InlineAlert tone="success" className="global-banner" aria-live="polite">
          <span className="global-banner-row">
            <span>{notice}</span>
            <IconButton label="Dismiss notice" onClick={() => setNotice(null)}>
              <X aria-hidden="true" className="size-3.5" />
            </IconButton>
          </span>
        </InlineAlert>
      ) : null}
      {snapshot ? renderToolbar() : null}
      {snapshot ? (
        <OperationBanner
          snapshot={snapshot}
          busy={isBusy}
          runAction={runAction}
          onRequest={openWorkflow}
          onShowChanges={() => setWorkspaceView('changes')}
        />
      ) : null}
      <div className={cn('workspace', !detailsVisible && 'workspace-details-hidden')}>
        {renderSidebar()}
        {snapshot ? <main className="main-pane">{renderMainContent()}</main> : renderOnboarding()}
        {detailsVisible ? renderDetails() : null}
      </div>
      {workflow && snapshot && workflow.repoPath === snapshot.path ? (
        <WorkflowDialog
          key={workflow.id}
          request={workflow.request}
          snapshot={snapshot}
          busy={isBusy}
          actionError={actionError}
          onClearActionError={() => setActionError(null)}
          runAction={runAction}
          onClose={() => setWorkflow(null)}
          onRequest={openWorkflow}
        />
      ) : null}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (open) return
          const intent = closeIntent({
            busy: isBusy,
            dirty: deleteForce || Boolean(deleteConfirmation),
          })
          if (intent === 'allow') {
            setDeleteTarget(null)
            return
          }
          setDeleteCloseNotice(CLOSE_INTENT_MESSAGES[intent])
        }}
      >
        <DialogContent
          className="workflow-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            deleteCancelRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const trigger = deleteTriggerRef.current
            if (trigger && !trigger.disabled) trigger.focus()
            else searchRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete local branch?</DialogTitle>
            <DialogDescription>
              Delete <strong>{deleteTarget?.branch.name}</strong> from this repository. Remote
              branches and pull requests will not be deleted.
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={submitDeleteBranch}>
            <WorkflowFrame composition="destructive">
              {deleteCloseNotice ? (
                <PhaseStatus phase="blocked" message={deleteCloseNotice} />
              ) : null}
              <OperationContext
                title={deleteTarget?.branch.name}
                description={`Delete this local branch. ${
                  deleteChildren.length > 0
                    ? `${deleteChildren.length} child ${deleteChildren.length === 1 ? 'branch uses' : 'branches use'} this parent; deleting it does not retarget those branches.`
                    : 'No local branches record this branch as their parent.'
                }`}
                facts={
                  deleteTarget
                    ? [
                        { label: 'Local ref', value: deleteTarget.branch.ref, code: true },
                        {
                          label: 'Current tip',
                          value: deleteTarget.branch.oid ?? 'Unavailable',
                          code: true,
                        },
                      ]
                    : []
                }
              />
              <Checkbox
                id="delete-branch-force"
                label="Delete even if not merged"
                checked={deleteForce}
                disabled={isBusy}
                onChange={(event) => {
                  setDeleteForce(event.target.checked)
                  setDeleteConfirmation('')
                  setDeleteBranchError(null)
                  setDeleteCloseNotice(null)
                }}
              />
              <p className="delete-branch-note">
                {deleteForce
                  ? 'Commits that exist only on this branch can become unreachable.'
                  : 'Git will refuse deletion if the branch is not fully merged.'}
              </p>
              {deleteForce && deleteTarget ? (
                <TypedConfirmation
                  id="delete-branch-confirmation"
                  label="Type the branch name to confirm"
                  value={deleteConfirmation}
                  target={deleteTarget.branch.name}
                  disabled={isBusy}
                  onChange={(value) => {
                    setDeleteConfirmation(value)
                    setDeleteCloseNotice(null)
                  }}
                />
              ) : null}
              {deleteBranchError ? (
                <PhaseStatus phase="failed" message={deleteBranchError} />
              ) : null}
              <WorkflowActions>
                <Button
                  ref={deleteCancelRef}
                  disabled={isBusy}
                  onClick={() => setDeleteTarget(null)}
                  variant="secondary"
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    isBusy || (deleteForce && deleteConfirmation !== deleteTarget?.branch.name)
                  }
                  type="submit"
                  variant="danger"
                  loading={busyAction === 'Delete branch'}
                  tooltip={
                    deleteForce && deleteConfirmation !== deleteTarget?.branch.name
                      ? 'Type the branch name to enable force deletion. Unmerged commits can become unreachable.'
                      : 'Delete this local branch now. Remotes and pull requests are kept.'
                  }
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                  Delete branch
                </Button>
              </WorkflowActions>
            </WorkflowFrame>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (open) {
            setNewBranchOpen(true)
            return
          }
          const intent = closeIntent({
            busy: isBusy,
            dirty: newBranchEdited,
          })
          if (intent === 'allow') {
            setNewBranchOpen(false)
            return
          }
          setNewBranchNotice(CLOSE_INTENT_MESSAGES[intent])
        }}
        open={newBranchOpen}
      >
        <DialogContent className="workflow-dialog">
          <DialogHeader>
            <DialogTitle>Create a branch</DialogTitle>
            <DialogDescription>
              Start a new stack branch from an existing local branch.
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={submitBranch}>
            <WorkflowFrame composition="form">
              {newBranchNotice ? <PhaseStatus phase="blocked" message={newBranchNotice} /> : null}
              <Field
                id="new-branch-name"
                label="Branch name"
                required
                description="Local only. Nothing is pushed and no commit is created."
              >
                <Input
                  autoFocus
                  onChange={(event) => {
                    setNewBranchName(event.target.value)
                    setNewBranchEdited(true)
                    setNewBranchNotice(null)
                  }}
                  placeholder="feature/short-description"
                  value={newBranchName}
                />
              </Field>
              <Field id="new-branch-parent" label="Parent branch" required>
                <Select
                  onChange={(event) => {
                    setNewBranchParent(event.target.value)
                    setNewBranchEdited(true)
                    setNewBranchNotice(null)
                  }}
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
                </Select>
              </Field>
              {newBranchError ? <PhaseStatus phase="failed" message={newBranchError} /> : null}
              <WorkflowActions>
                <Button onClick={() => setNewBranchOpen(false)} variant="secondary">
                  Cancel
                </Button>
                <Button
                  disabled={isBusy || !newBranchName.trim() || !newBranchParent}
                  type="submit"
                  variant="accent"
                  loading={busyAction === 'Create branch'}
                  tooltip={
                    !newBranchName.trim() || !newBranchParent
                      ? 'Enter a branch name and choose a parent branch first.'
                      : 'Create the local branch, record its stack parent, and switch to it. Nothing is pushed.'
                  }
                >
                  <Plus aria-hidden="true" className="size-3.5" />
                  Create branch
                </Button>
              </WorkflowActions>
            </WorkflowFrame>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (open) {
            setPrOpen(true)
            return
          }
          const intent = closeIntent({
            busy: isBusy,
            dirty: prEdited,
          })
          if (intent === 'allow') {
            setPrOpen(false)
            return
          }
          setPrNotice(CLOSE_INTENT_MESSAGES[intent])
        }}
        open={prOpen}
      >
        <DialogContent className="workflow-dialog pr-dialog-content">
          <DialogHeader>
            <DialogTitle>Create pull request</DialogTitle>
            <DialogDescription>
              Open a pull request from {selectedBranch?.name ?? 'this branch'} into a base branch.
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={submitPr}>
            <WorkflowFrame composition="form">
              {prNotice ? <PhaseStatus phase="blocked" message={prNotice} /> : null}
              {snapshot && !snapshot.github.available ? (
                <PhaseStatus
                  phase="blocked"
                  message={
                    snapshot.github.message ||
                    'GitHub is unavailable for this repository, so pull requests cannot be created or listed here.'
                  }
                />
              ) : null}
              <OperationContext
                title={`${selectedBranch?.name ?? 'This branch'} → ${prBase || 'base branch'}`}
                description="The pull request is created against this branch’s published upstream. Newer local commits are not pushed."
                facts={
                  selectedBranch
                    ? [
                        { label: 'Head branch', value: selectedBranch.name },
                        {
                          label: 'Upstream',
                          value: selectedBranch.upstream ?? 'No upstream configured',
                          code: true,
                        },
                      ]
                    : []
                }
              />
              <Field id="pr-title" label="Title" required>
                <Input
                  autoFocus
                  onChange={(event) => {
                    setPrTitle(event.target.value)
                    setPrEdited(true)
                    setPrNotice(null)
                  }}
                  placeholder="What does this stack change?"
                  value={prTitle}
                />
              </Field>
              <Field
                id="pr-base"
                label="Base branch"
                required
                description="Pick a local branch other than the head branch."
              >
                <Input
                  list="pr-base-options"
                  onChange={(event) => {
                    setPrBase(event.target.value)
                    setPrEdited(true)
                    setPrNotice(null)
                  }}
                  value={prBase}
                />
              </Field>
              <datalist id="pr-base-options">
                {(snapshot?.branches ?? [])
                  .filter((branch) => !branch.remote && branch.name !== currentBranch)
                  .map((branch) => (
                    <option key={branch.name} value={branch.name} />
                  ))}
              </datalist>
              <Field id="pr-body" label="Description (optional)">
                <Textarea
                  onChange={(event) => {
                    setPrBody(event.target.value)
                    setPrEdited(true)
                    setPrNotice(null)
                  }}
                  placeholder="Add context for reviewers"
                  rows={5}
                  value={prBody}
                />
              </Field>
              <Checkbox
                id="pr-draft"
                label="Mark as draft"
                checked={prDraft}
                onChange={(event) => {
                  setPrDraft(event.target.checked)
                  setPrEdited(true)
                }}
              />
              {prError ? <PhaseStatus phase="failed" message={prError} /> : null}
              <WorkflowActions>
                <Button onClick={() => setPrOpen(false)} variant="secondary">
                  Cancel
                </Button>
                <Button
                  disabled={
                    !snapshot?.github.available ||
                    !selectedBranch?.current ||
                    isBusy ||
                    !prBase.trim()
                  }
                  loading={busyAction === 'Create pull request'}
                  tooltip={
                    !snapshot?.github.available
                      ? snapshot?.github.message ||
                        'Connect an authenticated GitHub repository to create pull requests.'
                      : !selectedBranch?.current
                        ? 'Switch to a local branch to create its pull request.'
                        : !prBase.trim()
                          ? 'Choose the base branch this pull request targets.'
                          : 'Create the PR using this branch’s published upstream. This does not push newer local commits.'
                  }
                  type="submit"
                  variant="accent"
                >
                  <GitPullRequest aria-hidden="true" className="size-3.5" />
                  Create pull request
                </Button>
              </WorkflowActions>
            </WorkflowFrame>
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
