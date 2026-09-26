import * as React from 'react'
import { DropdownMenu } from './components/ui/dropdown-menu'
import {
  AlertCircle,
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
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitFork,
  GitMerge,
  GitPullRequest,
  Info,
  Layers,
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
  DesktopAPI,
  GitAction,
  PullRequest,
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
import {
  getCombinedBranches,
  getRepresentedRemoteRef,
  indexBranchesByParentName,
  sortBranchesByUpdatedAt,
} from './lib/branches'
import { WorkflowDialog, type WorkflowRequest } from './components/workflow-dialog'
import { WorkspaceNavigation } from './components/workspace-navigation'
import { ConflictResolver } from './components/conflict-resolver'
import { HistoryView, OperationBanner, StackView } from './components/repository-views'
import {
  ChangesView,
  PullRequestListView,
  StashesView,
  changeGroups,
  matchesPullRequest,
} from './components/data-views'
import { checkLabel, checksVariant } from './lib/pull-request-state'
import {
  OperationContext,
  PhaseStatus,
  WorkflowActions,
  TypedConfirmation,
  WorkflowFrame,
} from './components/workflow-composition'
import { CLOSE_INTENT_MESSAGES, closeIntent } from './components/workflow-policy'

type WorkspaceView = 'branches' | 'stacks' | 'history' | 'changes' | 'pullRequests' | 'stashes'
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

function branchTreeInfo(
  branch: Branch,
  byName: Map<string, Branch>,
  childCounts: Map<string, number>,
): BranchTreeInfo {
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
    if (!parentBranch.parent || (childCounts.get(parentBranch.ref) ?? 0) > 1) depth += 1
    parent = parentBranch.parent
  }

  return { depth, cycle, missingParent }
}

type BranchTreeRow = BranchTreeInfo & {
  trunks: { lane: number; kind: 'start' | 'start-node' | 'full' | 'end-parent' | 'end-child' }[]
  elbows: { lane: number }[]
}

function getBranchTreeGeometry(visibleBranches: readonly Branch[], byName: Map<string, Branch>) {
  const childCounts = new Map<string, number>()
  for (const branch of getCombinedBranches([...new Set(byName.values())])) {
    const parent = byName.get(branch.parent ?? '')
    if (parent) childCounts.set(parent.ref, (childCounts.get(parent.ref) ?? 0) + 1)
  }
  const rows: BranchTreeRow[] = visibleBranches.map((branch) => ({
    ...branchTreeInfo(branch, byName, childCounts),
    trunks: [],
    elbows: [],
  }))
  const visibleByName = indexBranchesByParentName(visibleBranches)
  const visibleIndex = new Map(visibleBranches.map((branch, index) => [branch.ref, index]))
  for (let index = 0; index < visibleBranches.length; index += 1) {
    const counterpart = getRepresentedRemoteRef(visibleBranches[index])
    if (counterpart && !visibleIndex.has(counterpart)) visibleIndex.set(counterpart, index)
  }
  const groups = new Map<
    string,
    { parent: number | undefined; depth: number; children: number[]; start: number; end: number }
  >()

  for (let index = 0; index < visibleBranches.length; index += 1) {
    const branch = visibleBranches[index]
    if (!branch.parent || rows[index].cycle || rows[index].missingParent) continue
    const parent = visibleByName.get(branch.parent) ?? byName.get(branch.parent)
    if (!parent) continue
    const parentIndex = visibleIndex.get(parent.ref)
    if (parentIndex !== undefined && parentIndex <= index) continue
    const key = parentIndex === undefined ? parent.ref : visibleBranches[parentIndex].ref
    const group = groups.get(key)
    if (group) {
      group.children.push(index)
      if (group.parent === undefined) group.end = index
    } else {
      groups.set(key, {
        parent: parentIndex,
        depth:
          parentIndex === undefined
            ? branchTreeInfo(parent, byName, childCounts).depth
            : rows[parentIndex].depth,
        children: [index],
        start: index,
        end: parentIndex ?? index,
      })
    }
  }

  for (const group of groups.values()) {
    const lane = group.depth
    for (let index = group.start; index <= group.end && group.start !== group.end; index += 1) {
      rows[index].trunks.push({
        lane,
        kind:
          index === group.start
            ? rows[group.start].depth === lane
              ? 'start-node'
              : 'start'
            : index === group.end
              ? group.parent === undefined
                ? 'end-child'
                : 'end-parent'
              : 'full',
      })
    }
    for (const child of group.children) {
      if (rows[child].depth !== lane) rows[child].elbows.push({ lane })
    }
  }

  return { rows }
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
  const [conflictPath, setConflictPath] = React.useState<string | null>(null)
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
    () => indexBranchesByParentName(snapshot?.branches ?? []),
    [snapshot],
  )
  const combinedBranches = React.useMemo(
    () => getCombinedBranches(snapshot?.branches ?? []),
    [snapshot],
  )
  const orderedBranches = React.useMemo(
    () =>
      sortBranchesByUpdatedAt(
        branchFilter === 'remote'
          ? (snapshot?.branches.filter((branch) => branch.remote) ?? [])
          : combinedBranches,
      ),
    [snapshot, branchFilter, combinedBranches],
  )

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
  const branchTree = React.useMemo(
    () => getBranchTreeGeometry(visibleBranches, branchByName),
    [branchByName, visibleBranches],
  )

  const changeState = React.useMemo(
    () => changeGroups(snapshot?.files ?? [], search),
    [snapshot, search],
  )
  const stagedFiles = changeState.staged
  const conflictedFiles = changeState.conflicted
  const isBusy = Boolean(busyAction || opening || refreshing)
  const currentBranch = snapshot?.currentBranch ?? null
  const allBranches = snapshot?.branches ?? []
  const branchCount = combinedBranches.length
  const pullRequestCount = snapshot?.pullRequests.length ?? 0
  const stashCount = snapshot?.stashes.length ?? 0
  const detailsVisible = showDetails && (workspaceView === 'branches' || workspaceView === 'stacks')
  const operationActive = Boolean(snapshot?.operation || snapshot?.stackOperation)
  const openWorkflow = (request: WorkflowRequest) => {
    if (!snapshot || isBusy) return
    setActionError(null)
    setWorkflow({ id: ++workflowSequence.current, repoPath: snapshot.path, request })
  }
  const openConflictResolver = (path: string) => {
    if (!snapshot || isBusy) return
    setActionError(null)
    setConflictPath(path)
  }
  const deleteChildren = deleteTarget
    ? allBranches.filter(
        (branch) =>
          !branch.remote &&
          branch.parent &&
          branchByName.get(branch.parent)?.ref === deleteTarget.branch.ref,
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
    setNewBranchNotice(null)
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
    setPrNotice(null)
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
    setDeleteCloseNotice(null)
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
        <span className="list-subtitle">{visibleBranches.length} shown</span>
      </div>
      <SegmentedControl<BranchFilter>
        label="Branch filters"
        value={branchFilter}
        onValueChange={setBranchFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'local', label: 'Local' },
          { value: 'remote', label: 'Remote' },
          { value: 'prs', label: 'With PRs' },
        ]}
      />
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
      <div className="branch-list" role="group" aria-label="Repository branches">
        {visibleBranches.map((branch, branchIndex) => {
          const tree = branchTree.rows[branchIndex]
          const pullRequest = branch.pr
          const selected = branch.ref === selectedBranch?.ref
          return (
            <div
              className={cn('branch-row', selected && 'branch-row-selected')}
              key={branch.ref}
              style={{ '--branch-depth': tree.depth } as React.CSSProperties}
            >
              <BranchHoverCard branch={branch}>
                <button
                  aria-current={selected ? 'true' : undefined}
                  aria-label={`${branch.name}${branch.remote ? ', remote branch' : ''}${branch.current ? ', current branch' : ''}`}
                  className="branch-select"
                  onClick={() => setSelectedBranchRef(branch.ref)}
                  type="button"
                />
              </BranchHoverCard>
              {tree.trunks.map((trunk, segmentIndex) => (
                <span
                  aria-hidden="true"
                  className={cn('branch-tree-trunk', `branch-tree-trunk-${trunk.kind}`)}
                  key={`trunk-${segmentIndex}`}
                  style={{ '--branch-lane': trunk.lane } as React.CSSProperties}
                />
              ))}
              {tree.elbows.map((elbow, segmentIndex) => (
                <span
                  aria-hidden="true"
                  className="branch-tree-elbow"
                  key={`elbow-${segmentIndex}`}
                  style={{ '--branch-lane': elbow.lane } as React.CSSProperties}
                />
              ))}
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
                  {branch.needsRestack || (branch.parentBehind ?? 0) > 0 ? (
                    <Badge variant="warning">Requires restack</Badge>
                  ) : null}
                </span>
                <span className="branch-summary">
                  {pullRequest ? (
                    <PullRequestHoverCard pr={pullRequest}>
                      <a
                        className="branch-pr-link"
                        href={pullRequest.url}
                        aria-label={`Open pull request #${pullRequest.number} on GitHub`}
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
                    </PullRequestHoverCard>
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="ahead-behind relative z-[2] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      tabIndex={0}
                      aria-label={
                        branch.upstream
                          ? `${branch.ahead} ahead, ${branch.behind} behind ${branch.upstream}`
                          : 'No upstream configured'
                      }
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
                  </TooltipTrigger>
                  <TooltipContent>
                    {branch.upstream
                      ? `${branch.ahead} commits ahead and ${branch.behind} behind ${branch.upstream}`
                      : 'Set an upstream to compare this branch with its remote.'}
                  </TooltipContent>
                </Tooltip>
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
      <ChangesView
        actionError={actionError}
        busy={isBusy}
        busyAction={busyAction}
        commitAmend={commitAmend}
        commitMessage={commitMessage}
        groups={changeState}
        inspectedPath={inspectedPath}
        onCommitAmendChange={setCommitAmend}
        onCommitMessageChange={setCommitMessage}
        onInspect={(path) => {
          setActionError(null)
          setInspectedPath(path)
        }}
        onResolveConflict={openConflictResolver}
        onStash={() => openWorkflow({ kind: 'stash' })}
        onSubmitCommit={submitCommit}
        operationActive={operationActive}
        runAction={runAction}
        snapshot={snapshot}
      />
    )
  }

  const renderPullRequests = () => {
    if (!snapshot) return null
    return (
      <PullRequestListView
        busy={isBusy}
        canCreate={Boolean(selectedBranch?.current) && snapshot.github.available && !isBusy}
        createTooltip={
          !snapshot.github.available
            ? snapshot.github.message ||
              'Connect an authenticated GitHub repository to create pull requests.'
            : !selectedBranch?.current
              ? 'Switch to a local branch to open its pull request on GitHub.'
              : 'Review creating a PR from this branch’s published upstream. Unpushed commits are not included.'
        }
        onCreate={openPrDialog}
        onRequest={openWorkflow}
        pullRequests={snapshot.pullRequests.filter((pr) => matchesPullRequest(pr, search))}
        snapshot={snapshot}
      />
    )
  }

  const renderStashes = () => {
    if (!snapshot) return null
    return (
      <StashesView
        busy={isBusy}
        busyAction={busyAction}
        onRequest={openWorkflow}
        onStash={() => openWorkflow({ kind: 'stash' })}
        operationActive={operationActive}
        runAction={runAction}
        snapshot={snapshot}
      />
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
    const parent = selectedBranch.parent ? branchByName.get(selectedBranch.parent) : null
    const canRebase = Boolean(
      selectedBranch.current &&
      selectedBranch.parent &&
      parent &&
      !selectedBranch.remote &&
      !operationActive,
    )
    return (
      <aside className="details-pane" id="branch-inspector" aria-label="Selected branch details">
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
            {selectedBranch.needsRestack || (selectedBranch.parentBehind ?? 0) > 0 ? (
              <div className="restack-notice">
                <strong>Requires restack</strong>
                <p>
                  {selectedBranch.parentTip
                    ? 'The parent or recorded boundary changed. Preview a stack restack to update this branch and its descendants together.'
                    : `${selectedBranch.parent} has ${selectedBranch.parentBehind ?? 0} commits not in this branch. Preview a restack before publishing.`}
                </p>
              </div>
            ) : null}
          </section>
          {!selectedBranch.remote && selectedBranch.name !== snapshot.defaultBranch ? (
            <section className="detail-section detail-actions">
              <h3>Stack workflow</h3>
              <Button
                variant="accent"
                disabled={isBusy || operationActive}
                tooltip="Preview rebasing this stack onto updated parents locally, branch by branch. Remotes stay unchanged until published."
                onClick={() =>
                  openWorkflow({ kind: 'stack', operation: 'restack', branch: selectedBranch.name })
                }
              >
                <Layers className="size-3.5" />
                Restack stack…
              </Button>
              <Button
                variant="secondary"
                disabled={isBusy || operationActive || !snapshot.github.available}
                tooltip={
                  !snapshot.github.available
                    ? snapshot.github.message ||
                      'Connect an authenticated GitHub repository to publish stacks.'
                    : 'Push reviewed stack tips and update their pull requests without rebasing. Requires a clean, restacked stack.'
                }
                onClick={() =>
                  openWorkflow({ kind: 'stack', operation: 'publish', branch: selectedBranch.name })
                }
              >
                <Upload className="size-3.5" />
                Publish stack…
              </Button>
              <Button
                variant="ghost"
                disabled={isBusy || operationActive}
                tooltip="Record a different local parent without rewriting commits. Preview Restack next to move this branch and descendants."
                onClick={() => openWorkflow({ kind: 'parent', branch: selectedBranch })}
              >
                Set stack parent…
              </Button>
              {selectedPullRequest?.state === 'OPEN' ? (
                <Button
                  variant="secondary"
                  disabled={isBusy || operationActive}
                  tooltip="Preview merging this open pull request into the default branch. Nothing merges until confirmed; remaining branches still need restack."
                  onClick={() =>
                    openWorkflow({ kind: 'stack', operation: 'merge', branch: selectedBranch.name })
                  }
                >
                  <GitMerge className="size-3.5" />
                  Preview PR merge
                </Button>
              ) : null}
            </section>
          ) : null}
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
                  tooltip="Open this pull request in the browser. Read-only; no local or remote changes."
                >
                  <ExternalLink className="size-3.5" />
                  Open on GitHub
                </Button>
                <Button
                  disabled={isBusy}
                  tooltip="Preview checks, reviews, and merge or close options for this pull request. Nothing changes until confirmed."
                  size="sm"
                  variant="accent"
                  onClick={() => openWorkflow({ kind: 'pr', number: selectedPullRequest.number })}
                >
                  Manage pull request
                </Button>
              </div>
            </section>
          ) : (
            <section className="detail-section detail-section-muted">
              <h3>Pull request</h3>
              <p>No pull request for this branch.</p>
              <Button
                disabled={!selectedBranch.current || !snapshot.github.available || isBusy}
                tooltip={
                  !snapshot.github.available
                    ? snapshot.github.message ||
                      'Connect an authenticated GitHub repository to create pull requests.'
                    : !selectedBranch.current
                      ? 'Switch to this branch to open its pull request on GitHub.'
                      : 'Review creating a PR from this branch’s published upstream. Unpushed commits are not included.'
                }
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
              disabled={selectedBranch.current || isBusy || operationActive}
              tooltip={
                selectedBranch.current
                  ? 'This is already the checked-out branch.'
                  : 'Switch the working tree to this branch. Requires a clean tree; remotes create a local tracking copy.'
              }
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
              tooltip="Rebase only the current branch onto its recorded parent locally. Rewrites its history; use Restack to move descendants together."
              onClick={() =>
                openWorkflow({
                  kind: 'confirm',
                  action: { type: 'rebase', parent: selectedBranch.parent as string },
                  title: 'Rebase current branch?',
                  label: 'Rebase onto parent',
                  description:
                    'This rewrites only the current branch. Use Restack stack to update dependent branches together.',
                })
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
            {!selectedBranch.remote ? (
              <>
                <Button
                  variant="secondary"
                  disabled={
                    isBusy || operationActive || selectedBranch.name === snapshot.defaultBranch
                  }
                  tooltip={
                    selectedBranch.name === snapshot.defaultBranch
                      ? 'The default branch cannot be renamed here.'
                      : 'Rename this local branch. Remote tracking and open pull requests may need updating.'
                  }
                  onClick={() => openWorkflow({ kind: 'rename', branch: selectedBranch })}
                >
                  Rename local branch…
                </Button>
                <Button
                  variant="secondary"
                  disabled={isBusy || operationActive}
                  tooltip="Choose which remote branch this branch pushes to and pulls from. Local config only; no commits move."
                  onClick={() => openWorkflow({ kind: 'upstream', branch: selectedBranch })}
                >
                  Set upstream…
                </Button>
                <Button
                  ref={deleteTriggerRef}
                  disabled={
                    selectedBranch.current ||
                    selectedBranch.name === snapshot.defaultBranch ||
                    isBusy ||
                    operationActive
                  }
                  onClick={openDeleteDialog}
                  tooltip={
                    selectedBranch.name === snapshot.defaultBranch
                      ? 'The default branch cannot be deleted.'
                      : selectedBranch.current
                        ? 'Cannot delete the checked-out branch — switch away first. Remotes and pull requests are kept.'
                        : 'Delete this local branch. Remotes and pull requests are kept; unmerged work needs force and can orphan commits.'
                  }
                  variant="danger"
                >
                  <Trash2 className="size-3.5" />
                  Delete local branch
                </Button>
                {selectedBranch.name === snapshot.defaultBranch ? (
                  <span className="action-hint">The default branch cannot be deleted.</span>
                ) : selectedBranch.current ? (
                  <span className="action-hint">
                    Switch to another branch before deleting this one.
                  </span>
                ) : null}
              </>
            ) : null}
            {selectedBranch.remote ? (
              <Button
                variant="danger"
                disabled={
                  isBusy ||
                  operationActive ||
                  !selectedBranch.oid ||
                  selectedBranch.name.endsWith(`/${snapshot.defaultBranch}`)
                }
                onClick={() => openWorkflow({ kind: 'deleteRemote', branch: selectedBranch })}
                tooltip="Preview removing this branch from its remote. Local copies remain; open PRs may close and collaborators must prune."
              >
                <Trash2 className="size-3.5" />
                Delete remote branch…
              </Button>
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
          onResolveConflict={openConflictResolver}
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
      {conflictPath &&
      snapshot &&
      snapshot.files.some((file) => file.conflicted && file.path === conflictPath) ? (
        <ConflictResolver
          key={conflictPath}
          busy={isBusy}
          actionError={actionError}
          path={conflictPath}
          runAction={runAction}
          onClose={() => setConflictPath(null)}
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
