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
  MessageSquareDiff,
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
  GitEnvironmentStatus,
  GitRuntimeStatus,
  GitHubAccountState,
  GitHubAccountStatus,
  LinkedIssue,
  OnboardingFailure,
  PullRequest,
  RecentRepository,
  RepositoryCloneResult,
  RepositorySnapshot,
  RemoteFreshness,
  RemoteFreshnessState,
} from '../../shared/types'
import { GitEnvironmentPanel, RepositoryDiscoveryDialog } from './components/onboarding'
import { LIST_PAGE_SIZE } from '../../shared/performance'
import { ListWindowMore } from './components/list-window'
import { useListWindow } from './lib/list-window'
import { createRequestGate } from './lib/request-gate'
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
import { RemoteFreshnessBadge } from './components/remote-freshness'
import {
  describeBranchRow,
  getCombinedBranches,
  getRepresentedRemoteRef,
  indexBranchesByParentName,
  sortBranchesByUpdatedAt,
} from './lib/branches'
import {
  claimsRovingKey,
  clampRovingIndex,
  rovingAction,
  rovingTabIndex,
  rovingTarget,
} from './lib/tree-navigation'
import { WorkflowDialog, type WorkflowRequest } from './components/workflow-dialog'
import {
  WORKSPACE_VIEW_HEADING_ID,
  WORKSPACE_VIEW_SHORTCUTS,
  WorkspaceNavigation,
  workspaceNeedsNoRepository,
  workspaceViewLabel,
} from './components/workspace-navigation'
import { ReviewView, type ReviewCommands } from './components/review-view'
import { ConflictResolver } from './components/conflict-resolver'
import { HistoryView, OperationBanner, StackView } from './components/repository-views'
import { GitRuntimeDialog } from './components/git-runtime-dialog'
import { SettingsDialog } from './components/settings-dialog'
import { GitHubAccountDialog } from './components/github-account-dialog'
import {
  ChangesView,
  DiagnosticsView,
  PullRequestListView,
  StashesView,
  changeGroups,
  matchesPullRequest,
} from './components/data-views'
import { PullRequestChecksPanel } from './components/check-details'
import { PullRequestInboxView } from './components/pr-inbox-view'
import {
  PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS,
  PULL_REQUEST_INBOX_REFRESH_MS,
  pullRequestInboxQueueCount,
} from '../../shared/pr-inbox'
import type {
  PullRequestInboxFilterDraft,
  PullRequestInboxItem,
  PullRequestInboxReport,
  PullRequestInboxSavedFilter,
} from '../../shared/pr-inbox'
import { checkLabel, checksVariant } from './lib/pull-request-state'
import type {
  PullRequestCheckDetail,
  PullRequestChecksReport,
} from '../../shared/pull-request-checks'
import {
  OperationContext,
  PhaseStatus,
  WorkflowActions,
  TypedConfirmation,
  WorkflowFrame,
} from './components/workflow-composition'
import { CLOSE_INTENT_MESSAGES, closeIntent } from './components/workflow-policy'
import {
  actionBlockReason,
  capabilityAttentionCount,
  capabilityReport,
  stashRemovalBlockReason,
} from '../../shared/capabilities'

type WorkspaceView =
  | 'branches'
  | 'stacks'
  | 'history'
  | 'changes'
  | 'pullRequests'
  | 'prInbox'
  | 'review'
  | 'stashes'
  | 'diagnostics'

/**
 * The one request id every queue read claims. A later refresh supersedes the
 * read before it, and leaving the destination cancels the read that is running.
 */
const INBOX_REQUEST_ID = 'inbox-refresh'
import { CommandPalette } from './components/command-palette'
import { ShortcutSettings } from './components/shortcut-settings'
import { DirtyCheckoutGuard } from './components/dirty-checkout-guard'
import { buildPaletteItems, type PaletteItem } from './lib/command-palette'
import {
  ariaKeyShortcuts,
  clearLegacyShortcuts,
  defaultShortcutBindings,
  formatChord,
  isComposingKeyEvent,
  isEditableTarget,
  isMacPlatform,
  matchesChord,
  readLegacyShortcuts,
  type ShortcutId,
} from '../../shared/shortcuts'
import type { AppSettings, SettingsLock } from '../../shared/settings'
import { resolveStackNavigation } from './lib/stack-navigation'
type BranchFilter = 'all' | 'local' | 'remote' | 'prs'

type BranchTreeInfo = {
  /** Visual lane depth used for connector geometry only. */
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
  /** Presented hierarchy depth, one per reachable parent hop. Drives `aria-level`. */
  level: number
  trunks: { lane: number; kind: 'start' | 'start-node' | 'full' | 'end-parent' | 'end-child' }[]
  elbows: { lane: number }[]
  /** 1-based position and size within the row's sibling set, for `aria-posinset`/`aria-setsize`. */
  posInSet: number
  setSize: number
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
    level: 0,
    posInSet: 1,
    setSize: 1,
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

  // Screen readers need the hierarchy of the rows a reader can actually reach,
  // not the repository's full ancestry: the connector lanes above may still
  // draw a parent that a filter removed or a cycle makes unreachable, but
  // `aria-level` must not announce a parent no row in this list can reach. A row
  // with no reachable parent is therefore a root here, and every root shares the
  // one root sibling set instead of each claiming a set of its own.
  const presentedParents = visibleBranches.map((branch, index) => {
    if (!branch.parent || rows[index].cycle || rows[index].missingParent) return -1
    const parent = visibleByName.get(branch.parent)
    const parentIndex = parent ? visibleIndex.get(parent.ref) : undefined
    return parentIndex === undefined || parentIndex === index ? -1 : parentIndex
  })
  const levelOf = new Array<number>(visibleBranches.length).fill(0)
  for (let index = 0; index < visibleBranches.length; index += 1) {
    const chain: number[] = []
    let cursor = index
    while (presentedParents[cursor] >= 0 && !levelOf[cursor] && chain.indexOf(cursor) < 0) {
      chain.push(cursor)
      cursor = presentedParents[cursor]
    }
    // A root ends the chain; an already-solved row lends its level to the rows
    // beneath it. A chain that closes on itself cannot be traversed, so it is
    // read as a root rather than as a hierarchy the reader could not follow.
    const base = levelOf[cursor]
    for (let step = chain.length - 1; step >= 0; step -= 1) {
      levelOf[chain[step]] = base + chain.length - step
    }
  }
  // `-1` is the root set: every presented root is a sibling of the others, and a
  // presented parent's key holds the children a reader can reach from it.
  const siblingSets = new Map<number, number[]>()
  for (let index = 0; index < visibleBranches.length; index += 1) {
    const key = presentedParents[index]
    const set = siblingSets.get(key)
    if (set) set.push(index)
    else siblingSets.set(key, [index])
  }
  for (const set of siblingSets.values()) {
    set.forEach((rowIndex, position) => {
      rows[rowIndex].level = levelOf[rowIndex]
      rows[rowIndex].posInSet = position + 1
      rows[rowIndex].setSize = set.length
    })
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
  const [reviewNumber, setReviewNumber] = React.useState<number | null>(null)
  const [conflictPath, setConflictPath] = React.useState<string | null>(null)
  const [workflow, setWorkflow] = React.useState<{
    id: number
    repoPath: string
    request: WorkflowRequest
  } | null>(null)
  const [gitRuntimeOpen, setGitRuntimeOpen] = React.useState(false)
  const [gitRuntimeStatus, setGitRuntimeStatus] = React.useState<GitRuntimeStatus | null>(null)
  const [gitRuntimeBusy, setGitRuntimeBusy] = React.useState(false)
  const [accountOpen, setAccountOpen] = React.useState(false)
  const [account, setAccount] = React.useState<GitHubAccountStatus | null>(null)
  const [accountBusy, setAccountBusy] = React.useState(false)
  const [discoveryOpen, setDiscoveryOpen] = React.useState(false)
  const [gitEnvironment, setGitEnvironment] = React.useState<GitEnvironmentStatus | null>(null)
  const [gitEnvironmentFailure, setGitEnvironmentFailure] =
    React.useState<OnboardingFailure | null>(null)
  const accountRequest = React.useRef(0)
  /**
   * The legacy import is offered once. Main decides at write time whether it
   * still applies, and a declined import leaves the stored bindings alone, so
   * asking again would only repeat a decision that has already been made.
   */
  const legacyImportOffered = React.useRef(false)
  const workflowSequence = React.useRef(0)

  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = React.useState(false)
  const [shortcutBindings, setShortcutBindings] = React.useState<Record<ShortcutId, string>>(() =>
    defaultShortcutBindings(),
  )
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [settingsLocks, setSettingsLocks] = React.useState<readonly SettingsLock[]>([])
  /**
   * Writes a shortcut change and adopts only what main confirmed. A refused
   * write — a policy lock, an invalid chord — must leave the running app on
   * the bindings that are actually in force.
   */
  const persistShortcutBindings = React.useCallback(
    async (bindings: Record<ShortcutId, string>) => {
      if (!desktop?.updateSettings) return
      try {
        const snapshot = await desktop.updateSettings({ shortcuts: bindings })
        setSettings(snapshot.settings)
        setShortcutBindings(snapshot.settings.shortcuts)
      } catch (value) {
        setError(readableError(value))
        // Re-read so the editor shows what is stored rather than what was tried.
        const current = await desktop?.settings?.().catch(() => null)
        if (current) setShortcutBindings(current.settings.shortcuts)
      }
    },
    [desktop],
  )
  const shortcutLockReason =
    settingsLocks.find((lock) => lock.key === 'shortcuts')?.reason ?? undefined
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [checkoutGuardTarget, setCheckoutGuardTarget] = React.useState<{
    ref: string
    name: string
  } | null>(null)
  const anyModalOpen =
    paletteOpen ||
    shortcutSettingsOpen ||
    checkoutGuardTarget !== null ||
    deleteTarget !== null ||
    newBranchOpen ||
    prOpen ||
    workflow !== null
  const [announcement, setAnnouncement] = React.useState('')
  const previousViewRef = React.useRef(workspaceView)
  const isMac = React.useMemo(() => isMacPlatform(), [])
  const [showDetails, setShowDetails] = React.useState(true)
  const busyRef = React.useRef<string | null>(null)
  const openingRef = React.useRef(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  /** The queue's own filter field, which the search chord focuses while it is on screen. */
  const inboxSearchRef = React.useRef<HTMLInputElement>(null)
  const reviewCommands = React.useRef<ReviewCommands | null>(null)
  const deleteCancelRef = React.useRef<HTMLButtonElement>(null)
  const paletteHandoffFocusRef = React.useRef<HTMLElement | null>(null)
  const paletteDeleteHandoffRef = React.useRef(false)
  const deleteTriggerRef = React.useRef<HTMLButtonElement>(null)
  // One gate covers every read that can paint the repository: an open, a
  // refresh, or the snapshot either returns. Switching repositories resets it
  // so no result computed for the previous repository is ever applied.
  const repositoryGate = React.useRef(createRequestGate()).current
  const [remoteStatus, setRemoteStatus] = React.useState<RemoteFreshness | null>(null)
  // The PR Inbox is its own destination with its own read: it spans every
  // registered repository rather than the one on screen, and it is the only
  // surface that answers "what is waiting on me?" across all of them.
  const [inboxReport, setInboxReport] = React.useState<PullRequestInboxReport | null>(null)
  const [inboxSavedFilters, setInboxSavedFilters] = React.useState<PullRequestInboxSavedFilter[]>(
    [],
  )
  const [inboxLoading, setInboxLoading] = React.useState(false)
  const [inboxRefreshing, setInboxRefreshing] = React.useState(false)
  const [inboxSavingFilters, setInboxSavingFilters] = React.useState(false)
  // The lock is a ref so a second mutation in the same event is refused before
  // the render that shows the controls as waiting has happened.
  const savingInboxFiltersRef = React.useRef(false)
  // Whether the stored list has been read. The save controls wait for it: each
  // one replaces the whole list, so a save taken against the list as it has not
  // been read yet would send back an empty list and store it.
  const [inboxFiltersReady, setInboxFiltersReady] = React.useState(false)
  // Advances with every read and every accepted write, so an initialization
  // answer that arrives after a save cannot put the list it read back.
  const inboxFiltersGeneration = React.useRef(0)
  const [inboxError, setInboxError] = React.useState<string | null>(null)
  // The account the rows on screen were read for. A ref, not a state: it is
  // read and written in the same event that retires those rows, and dropping the
  // rows is what renders, not the identity itself.
  const inboxIdentityRef = React.useRef<string | null>(null)
  const inboxGate = React.useRef(createRequestGate()).current
  // A background snapshot only applies to the repository the window still shows.
  const snapshotPathRef = React.useRef<string | null>(null)
  const setSnapshotAndSelection = React.useCallback((next: RepositorySnapshot) => {
    setSnapshot(next)
    snapshotPathRef.current = next.path
    // A snapshot the main process produced already knows its own freshness.
    setRemoteStatus((current) => next.remote ?? current)
    setSelectedBranchRef((current) => {
      if (current && next.branches.some((branch) => branch.ref === current)) return current
      if (next.currentBranch) return `refs/heads/${next.currentBranch}`
      return next.branches[0]?.ref ?? null
    })
  }, [])

  const refreshSnapshot = React.useCallback(async (): Promise<RepositorySnapshot | null> => {
    if (!desktop) return null
    const claim = repositoryGate.claim()
    setRefreshing(true)
    try {
      const next = await desktop.refresh()
      if (!repositoryGate.current(claim)) return null
      setSnapshotAndSelection(next)
      return next
    } catch (value) {
      if (repositoryGate.current(claim)) setError(readableError(value))
      return null
    } finally {
      if (repositoryGate.current(claim)) setRefreshing(false)
    }
  }, [desktop, repositoryGate, setSnapshotAndSelection])

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

  // The main process pushes what its watcher and refresh timers find: local Git
  // made outside this window, a newer pull-request state, or a change in how
  // fresh the remote data is.
  React.useEffect(() => {
    if (!desktop) return
    const offSnapshot = desktop.onBackgroundSnapshot?.((next) => {
      if (next.path !== snapshotPathRef.current) return
      setSnapshotAndSelection(next)
    })
    const offIssues = desktop.onBackgroundIssues?.((issues) => {
      setSnapshot((current) => (current ? { ...current, issues } : current))
    })
    const offStatus = desktop.onRemoteStatus?.((freshness) => setRemoteStatus(freshness))
    desktop
      .remoteStatus?.()
      .then((freshness) => setRemoteStatus(freshness))
      .catch(() => {})
    return () => {
      offSnapshot?.()
      offIssues?.()
      offStatus?.()
    }
  }, [desktop, setSnapshotAndSelection])

  // Focus and visibility decide how often GitHub is read; the main process
  // cannot observe either on its own.
  React.useEffect(() => {
    if (!desktop?.reportActivity) return
    const report = () => {
      desktop
        ?.reportActivity?.({
          focused: document.hasFocus(),
          visible: document.visibilityState === 'visible',
        })
        .catch(() => {})
    }
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    document.addEventListener('visibilitychange', report)
    report()
    return () => {
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
      document.removeEventListener('visibilitychange', report)
    }
  }, [desktop])

  // Settings are read once at startup so the window opens in the appearance and
  // with the shortcuts the user last chose. Main owns the file.
  React.useEffect(() => {
    if (!desktop?.settings) return
    let cancelled = false
    desktop
      .settings()
      .then((snapshot) => {
        if (cancelled) return
        setSettings(snapshot.settings)
        setSettingsLocks(snapshot.locks)
        setShortcutBindings(snapshot.settings.shortcuts)
      })
      .catch((value) => {
        if (!cancelled) setError(readableError(value))
      })
    return () => {
      cancelled = true
    }
  }, [desktop])

  // The build before this one kept shortcuts in web storage. Those bindings
  // belong to the user, so they are offered for import once, before anything
  // saves over them with defaults.
  //
  // The import is an intent, not an assignment. Main commits it only if the
  // settings file still holds the untouched state this offer was decided from,
  // so a reset or a shortcut edit that lands while this write is in flight is
  // never overwritten by bindings the user has moved on from. Either way the
  // stored copy is dropped afterwards: a committed import cannot run again, and
  // a declined one is a decision, not a failure to retry.
  React.useEffect(() => {
    if (!desktop?.updateSettings || !settings || legacyImportOffered.current) return
    if (settings.migrated.legacyShortcutStorage) return
    const legacy = readLegacyShortcuts()
    if (!legacy) return
    legacyImportOffered.current = true
    let cancelled = false
    desktop
      .updateSettings({ legacyShortcutImport: legacy })
      .then((snapshot) => {
        clearLegacyShortcuts()
        if (cancelled) return
        setSettings(snapshot.settings)
        setSettingsLocks(snapshot.locks)
        setShortcutBindings(snapshot.settings.shortcuts)
      })
      .catch(() => {
        // A migration that could not be written is left undone rather than
        // marked done, so the stored copy is kept for the next window.
        legacyImportOffered.current = false
      })
    return () => {
      cancelled = true
    }
  }, [desktop, settings])

  // The theme attribute is the only place the preference takes effect: the
  // generated token sheet switches on it, and "system" defers to the operating
  // system in CSS so a later change is followed with no script involved.
  React.useEffect(() => {
    const root = document.documentElement
    root.dataset.gsTheme = settings?.appearance.theme ?? 'system'
    // The reduced-motion sheet reads this attribute as well as the media
    // query, so the choice holds on a computer that did not ask for it.
    if (settings?.appearance.reduceMotion) {
      root.dataset.motion = 'reduced'
    } else {
      delete root.dataset.motion
    }
  }, [settings?.appearance.theme, settings?.appearance.reduceMotion])

  // Background refresh has no timer here on purpose. The main process's sync
  // coordinator is the one automatic owner of remote reads and applies the
  // stored interval itself, so a second timer in the window would read on a
  // different schedule and bypass the coordinator's focus, backoff, and
  // busy-state policy. An explicit refresh still reads on demand.
  /**
   * Adopts a repository the main process just opened, whether it came from the
   * recents list, the folder dialog, a dropped folder, or a finished clone.
   */
  const openRepository = React.useCallback(
    async (
      path?: string,
      mode: 'recent' | 'add' = 'recent',
      landing?: { reviewNumber: number },
    ) => {
      if (!desktop || openingRef.current || busyRef.current) return
      openingRef.current = true
      // Resetting the gate before awaiting retires every in-flight refresh, so
      // a snapshot taken from the previous repository cannot land here.
      repositoryGate.reset()
      const claim = repositoryGate.claim()
      setOpening(true)
      setError(null)
      setActionError(null)
      setNotice(null)
      try {
        const next =
          mode === 'add'
            ? await desktop.addRepository?.(path ?? '')
            : await desktop.openRepository(path)
        if (next && repositoryGate.current(claim)) {
          setSnapshotAndSelection(next)
          setDeleteTarget(null)
          setWorkflow(null)
          setInspectedPath(null)
          setCommitAmend(false)
          setCommitMessage('')
          // Opening a repository reads it; it never changes what is checked out.
          // Landing straight in Review is how a queue row reaches the workspace
          // for its own repository without a checkout or a branch switch.
          if (landing) setReviewNumber(landing.reviewNumber)
          setWorkspaceView(landing ? 'review' : 'branches')
        }
        const repositories = await desktop.recentRepositories().catch(() => null)
        if (repositories) setRecentRepositories(repositories)
      } catch (value) {
        if (repositoryGate.current(claim)) setError(readableError(value))
      } finally {
        if (repositoryGate.current(claim)) setOpening(false)
        openingRef.current = false
      }
    },
    [desktop, repositoryGate, setSnapshotAndSelection],
  )

  /**
   * Reads the queue. The main process owns cancellation, so closing the Inbox
   * or starting another refresh retires this one; the gate keeps a late answer
   * for an abandoned read off the screen.
   */
  const loadInbox = React.useCallback(
    async (request: { mergedWithinDays: number; requestId: string }) => {
      if (!desktop) return
      inboxGate.reset()
      const claim = inboxGate.claim()
      setInboxLoading(true)
      setInboxRefreshing(true)
      setInboxError(null)
      try {
        const report = await desktop.pullRequestInbox?.(request)
        if (!report) return
        if (!inboxGate.current(claim)) return
        setInboxReport(report)
      } catch (value) {
        if (!inboxGate.current(claim)) return
        // A read that could not answer is reported, never emptied: the last
        // confirmed rows stay on screen behind the reason.
        setInboxError(readableError(value))
      } finally {
        if (inboxGate.current(claim)) {
          setInboxLoading(false)
          setInboxRefreshing(false)
        }
      }
    },
    [desktop, inboxGate],
  )

  // Leaves the Inbox: ends the read the destination started, so the main process
  // stops spending its request budget on repositories nobody is looking at, and
  // retires the answer so it cannot repaint the destination when it lands.
  const leaveInbox = React.useCallback(() => {
    inboxGate.reset()
    // The flags belong to the read this destination started, so they end with
    // it. Leaving mid-read and coming back would otherwise find Refresh
    // disabled for a read that is no longer running.
    setInboxLoading(false)
    setInboxRefreshing(false)
    void desktop?.cancel?.(INBOX_REQUEST_ID)?.catch(() => undefined)
  }, [desktop, inboxGate])

  // The queue reads on open and on the stored cadence. It never reads while the
  // window is hidden, so a background app is not spending rate budget.
  React.useEffect(() => {
    if (workspaceView !== 'prInbox' || !desktop) return
    const read = {
      mergedWithinDays: PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS,
      requestId: INBOX_REQUEST_ID,
    }
    void loadInbox(read)
    const timer = window.setInterval(() => {
      if (document.hidden) return
      void loadInbox(read)
    }, PULL_REQUEST_INBOX_REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      leaveInbox()
    }
  }, [desktop, leaveInbox, loadInbox, workspaceView])

  // Opening a row lands in that repository's Review. While another repository is
  // still opening, both paths are refused: the pending open would otherwise land
  // after this one and replace the selection the person just made.
  const openInboxItem = React.useCallback(
    (item: PullRequestInboxItem) => {
      if (openingRef.current) return
      if (snapshot?.path === item.repositoryPath) {
        setReviewNumber(item.number)
        setWorkspaceView('review')
        return
      }
      void openRepository(item.repositoryPath, 'recent', { reviewNumber: item.number })
    },
    [openRepository, snapshot?.path],
  )

  const saveInboxFilters = React.useCallback(
    async (drafts: PullRequestInboxFilterDraft[]) => {
      if (!desktop) return
      // Every one of these replaces the whole list, so two of them overlap only
      // to drop one of the two changes. The lock is this window's answer to the
      // stored list, not the main process's write queue.
      if (savingInboxFiltersRef.current) return
      savingInboxFiltersRef.current = true
      setInboxSavingFilters(true)
      try {
        const saved = await desktop.savePullRequestInboxFilters?.(drafts)
        // The stored list has moved past the read the initialization answer
        // belongs to, so that answer must not be able to put this one back.
        if (saved) inboxFiltersGeneration.current += 1
        if (saved) setInboxSavedFilters(saved)
      } catch (value) {
        setInboxError(readableError(value))
      } finally {
        savingInboxFiltersRef.current = false
        setInboxSavingFilters(false)
      }
    },
    [desktop],
  )

  React.useEffect(() => {
    if (!desktop) return
    let live = true
    const generation = ++inboxFiltersGeneration.current
    const settle = (filters?: readonly PullRequestInboxSavedFilter[] | null) => {
      if (live && generation === inboxFiltersGeneration.current) {
        setInboxSavedFilters(filters ? [...filters] : [])
      }
    }
    void desktop
      .pullRequestInboxFilters?.()
      .then((filters) => settle(filters))
      .catch(() => settle([]))
      .finally(() => {
        if (live && generation === inboxFiltersGeneration.current) setInboxFiltersReady(true)
      })
    return () => {
      live = false
    }
  }, [desktop])

  const isBusy = Boolean(busyAction || opening || refreshing)
  const operationActive = Boolean(snapshot?.operation || snapshot?.stackOperation)

  const openGitRuntime = React.useCallback(() => {
    if (!desktop || isBusy || operationActive) return
    setGitRuntimeOpen(true)
    desktop
      .gitRuntimeStatus()
      .then(setGitRuntimeStatus)
      .catch((value) => setError(readableError(value)))
  }, [desktop, isBusy, operationActive])

  const selectGitRuntime = React.useCallback(
    async (useSystemGit: boolean) => {
      if (!desktop || isBusy || operationActive) return
      setGitRuntimeBusy(true)
      try {
        setGitRuntimeStatus(await desktop.setSystemGit(useSystemGit))
      } catch (value) {
        setError(readableError(value))
      } finally {
        setGitRuntimeBusy(false)
      }
    },
    [desktop, isBusy, operationActive],
  )

  // Main resolves the editor from settings and checks the path is inside the
  // open repository, so the window sends only a path it is already showing.
  const openInEditor = React.useCallback(
    async (relativePath: string) => {
      if (!desktop?.openInEditor) return
      try {
        const result = await desktop.openInEditor(relativePath)
        setNotice(result.opened ? result.reason : result.reason)
      } catch (value) {
        setError(readableError(value))
      }
    },
    [desktop],
  )

  const openAccount = React.useCallback(() => {
    if (!desktop || isBusy || operationActive) return
    setAccountOpen(true)
    desktop
      .githubAccountStatus?.()
      .then((value) => value && setAccount(value))
      .catch((value) => setError(readableError(value)))
  }, [desktop, isBusy, operationActive])

  // The identity the rows on screen belong to: the host this window reads for
  // AND the account behind it. The host is part of it because switching from
  // github.com to an enterprise host changes whose pull requests these are
  // even when the account status is byte-for-byte unchanged.
  const inboxHostRef = React.useRef<string | null>(null)
  const retireInboxIdentity = React.useCallback(
    (status: GitHubAccountStatus | null, host: string) => {
      // The host is the first half of the identity, so it retires the queue on
      // its own and before any account field is folded in. Rows read for the
      // previous host cannot stay on screen under new settings while the
      // account status is still pending, has failed, or is byte-for-byte the
      // same; and with no account status yet, leaving the previous rows keyed to
      // the old host would let a later first adoption pass them through.
      if (inboxHostRef.current !== host) {
        leaveInbox()
        setInboxReport(null)
        setInboxError(null)
        inboxIdentityRef.current = null
      }
      inboxHostRef.current = host
      if (!status) return
      const identity = [
        host,
        status.host,
        status.state,
        status.login ?? '',
        status.reference ?? '',
      ].join('|')
      if (inboxIdentityRef.current !== null && inboxIdentityRef.current !== identity) {
        leaveInbox()
        setInboxReport(null)
        setInboxError(null)
      }
      inboxIdentityRef.current = identity
    },
    [leaveInbox],
  )

  const applyAccount = React.useCallback(
    (status: GitHubAccountStatus) => {
      retireInboxIdentity(status, inboxHostRef.current ?? status.host)
      setAccount(status)
    },
    [retireInboxIdentity],
  )

  // A host this window reads for is part of that identity, so changing it
  // retires the read still running for the previous host even when no account
  // event arrives to report the switch.
  React.useEffect(() => {
    const host = settings?.github.host ?? null
    if (host === null) return
    retireInboxIdentity(account, host)
  }, [account, retireInboxIdentity, settings?.github.host])

  // A running sign-in pushes its own state, so the panel is never left waiting on a read.
  React.useEffect(() => {
    if (!desktop) return
    const stop = desktop.onGitHubAccount?.(applyAccount)
    desktop
      .githubAccountStatus?.()
      .then((value) => value && applyAccount(value))
      .catch(() => undefined)
    return stop
  }, [applyAccount, desktop])

  const runAccountAction = React.useCallback(
    async (action: () => Promise<GitHubAccountStatus>, interruptible = false) => {
      // Cancelling and signing out must stay reachable while a sign-in is in
      // progress; only starting one is prevented from being doubled up.
      if (!desktop || (accountBusy && !interruptible)) return
      const request = ++accountRequest.current
      setAccountBusy(true)
      try {
        const next = await action()
        // A slow sign-in must not overwrite the state a later cancel already
        // reached; only the newest action's result is applied. It still passes
        // the identity boundary, because signing out is exactly the change that
        // must not leave the previous account's queue on screen.
        if (request === accountRequest.current) applyAccount(next)
      } catch (value) {
        if (request === accountRequest.current) setError(readableError(value))
      } finally {
        if (request === accountRequest.current) setAccountBusy(false)
      }
    },
    [accountBusy, applyAccount, desktop],
  )

  const openDevicePage = React.useCallback(() => {
    const uri = account?.challenge?.verificationUri
    if (!desktop || !uri) return
    desktop.openExternal(uri).catch((value) => setError(readableError(value)))
  }, [account, desktop])

  const openDiscovery = React.useCallback(() => {
    if (!desktop || isBusy || operationActive) return
    setDiscoveryOpen(true)
  }, [desktop, isBusy, operationActive])

  // A finished clone registered its repository in the main process, so the
  // window only has to read the repository it is now showing.
  const adoptClonedRepository = React.useCallback(
    async (result: RepositoryCloneResult) => {
      repositoryGate.reset()
      const claim = repositoryGate.claim()
      setError(null)
      try {
        const next = await desktop?.refresh()
        if (next && repositoryGate.current(claim)) {
          setSnapshotAndSelection(next)
          setWorkspaceView('branches')
        }
        const repositories = await desktop?.recentRepositories().catch(() => null)
        if (repositories) setRecentRepositories(repositories)
        setNotice(
          result.empty
            ? `Cloned ${result.name}. It has no commits yet — create a branch to add the first one.`
            : `Cloned ${result.name} into ${result.path}.`,
        )
      } catch (value) {
        if (repositoryGate.current(claim)) setError(readableError(value))
      }
    },
    [desktop, repositoryGate, setSnapshotAndSelection],
  )

  // Onboarding reads this machine's Git facts once; they never change while the
  // window shows them, and nothing here writes a Git setting.
  React.useEffect(() => {
    if (!desktop?.gitEnvironment) return
    let cancelled = false
    desktop
      .gitEnvironment('onboarding:environment')
      .then((outcome) => {
        if (cancelled) return
        if (outcome.ok) {
          setGitEnvironment(outcome.value)
          setGitEnvironmentFailure(null)
        } else {
          setGitEnvironmentFailure(outcome.failure)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [desktop])

  // A folder dropped on the window is added as it was found, and only while no
  // repository is open: switching away from a workspace by accident is worse
  // than asking for the action again.
  React.useEffect(() => {
    if (!desktop?.onRepositoryDropped) return
    return desktop.onRepositoryDropped((paths) => {
      if (snapshot || openingRef.current || busyRef.current) return
      const first = paths[0]
      if (first) void openRepository(first, 'add')
    })
  }, [desktop, openRepository, snapshot])

  const ACCOUNT_LABELS: Record<GitHubAccountState, string> = {
    'not-configured': 'GitHub: not configured',
    'signed-out': 'GitHub: signed out',
    'signing-in': 'GitHub: waiting for sign-in',
    'signed-in': 'GitHub: signed in',
    expired: 'GitHub: sign-in expired',
    revoked: 'GitHub: authorization revoked',
    'permission-denied': 'GitHub: organization access required',
    offline: 'GitHub: unreachable',
    'storage-unavailable': 'GitHub: no secure store',
  }
  const accountLabel = ACCOUNT_LABELS[account?.state ?? 'signed-out']
  const accountConnected = account?.state === 'signed-in' || account?.state === 'signing-in'
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
  const [selectedPrIssueLinks, setSelectedPrIssueLinks] = React.useState<LinkedIssue[]>([])
  const [selectedPrIssueLinksLoading, setSelectedPrIssueLinksLoading] = React.useState(false)

  React.useEffect(() => {
    if (!selectedPullRequest) {
      setSelectedPrIssueLinks([])
      setSelectedPrIssueLinksLoading(false)
      return
    }
    let active = true
    setSelectedPrIssueLinksLoading(true)
    desktop
      ?.pullRequestIssueLinks?.(selectedPullRequest.number)
      .then((res) => {
        if (!active) return
        setSelectedPrIssueLinks(res?.links ?? [])
        setSelectedPrIssueLinksLoading(false)
      })
      .catch(() => {
        if (!active) return
        setSelectedPrIssueLinks([])
        setSelectedPrIssueLinksLoading(false)
      })
    return () => {
      active = false
    }
  }, [selectedPullRequest?.number, snapshot])

  // The checks report is per pull request and carries its own freshness, so it is
  // never folded into the repository snapshot: a remembered report has to be able to
  // say it was not re-read without making the whole snapshot look stale.
  const [checksReport, setChecksReport] = React.useState<PullRequestChecksReport | null>(null)
  const [checksLoading, setChecksLoading] = React.useState(false)
  const [checksWatching, setChecksWatching] = React.useState(false)
  const [rerunningRunId, setRerunningRunId] = React.useState<number | null>(null)
  const checksGate = React.useRef(createRequestGate()).current
  const checksNumber = selectedPullRequest?.number ?? null
  const checksRepository = snapshot?.path ?? null
  // The head commit and base travel with the read, so the loader reads them from a ref:
  // depending on the snapshot itself would re-read every pull request's checks on each
  // ordinary repository refresh, which is not what refreshing the list asked for.
  const pullRequestsRef = React.useRef(snapshot?.pullRequests)
  pullRequestsRef.current = snapshot?.pullRequests

  const loadChecks = React.useCallback(
    async (number: number, force: boolean): Promise<void> => {
      if (!desktop?.pullRequestChecks) return
      const pr = pullRequestsRef.current?.find((entry) => entry.number === number) ?? null
      const claim = checksGate.claim()
      setChecksLoading(true)
      try {
        const report = await desktop.pullRequestChecks(number, {
          headSha: pr?.headOid ?? null,
          base: pr?.base ?? null,
          force,
        })
        if (checksGate.current(claim)) setChecksReport(report)
      } catch (value) {
        if (checksGate.current(claim)) setError(readableError(value))
      } finally {
        if (checksGate.current(claim)) setChecksLoading(false)
      }
    },
    [checksGate, desktop],
  )

  // Changing what is selected retires the previous report: a checks drill-down for
  // one pull request must never be read as the state of another.
  React.useEffect(() => {
    checksGate.reset()
    setChecksReport(null)
    setChecksWatching(false)
  }, [checksGate, checksNumber, checksRepository])

  React.useEffect(() => {
    if (checksNumber === null) return
    void loadChecks(checksNumber, false)
  }, [checksNumber, loadChecks])

  // Watching re-reads only while the panel is open; the interval belongs to this view,
  // and the main process still decides whether a read is due or is backing off.
  React.useEffect(() => {
    if (!checksWatching || checksNumber === null) return
    const timer = setInterval(() => void loadChecks(checksNumber, true), 10_000)
    return () => clearInterval(timer)
  }, [checksNumber, checksWatching, loadChecks])

  const rerunCheck = React.useCallback(
    async (check: PullRequestCheckDetail): Promise<void> => {
      if (!desktop?.rerunPullRequestCheck || check.workflowRunId === null) return
      const claim = checksGate.claim()
      setRerunningRunId(check.workflowRunId)
      try {
        const report = await desktop.rerunPullRequestCheck(checksNumber ?? 0, check.workflowRunId)
        if (checksGate.current(claim)) setChecksReport(report)
      } catch (value) {
        if (checksGate.current(claim)) setError(readableError(value))
      } finally {
        setRerunningRunId(null)
      }
    },
    [checksGate, checksNumber, desktop],
  )

  const openCheckDetails = React.useCallback(
    (url: string): void => {
      desktop?.openExternal(url).catch((value) => setError(readableError(value)))
    },
    [desktop],
  )

  // The inspector badge follows the detailed report once it is loaded, so the badge
  // and the drill-down below it can never disagree about the same head.
  const inspectorChecks: PullRequest['checks'] =
    checksReport && checksReport.number === checksNumber
      ? checksReport.summary
      : (selectedPullRequest?.checks ?? 'none')

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
  const branchWindow = useListWindow(visibleBranches, LIST_PAGE_SIZE)
  // The branch tree is one composite widget: a single Tab stop whose position
  // follows keyboard focus, so Tab reaches the tree once instead of once per row.
  // The active row is tracked by its position inside the mounted window, which is
  // the same coordinate system the DOM lookup and the tabindex comparison use.
  const [branchTreeActiveIndex, setBranchTreeActiveIndex] = React.useState(0)
  const branchTreeListRef = React.useRef<HTMLDivElement>(null)
  const focusBranchRowInWindow = (mountedIndex: number) => {
    const row =
      branchTreeListRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[mountedIndex]
    if (!row) return
    setBranchTreeActiveIndex(mountedIndex)
    row.focus()
  }
  // Only Home and End address the whole filtered list, so the row they name may
  // not be mounted yet. The window is asked to reveal it and the pending index is
  // applied once that row exists, which keeps the surface's single Tab stop with
  // the focus. Arrow keys must never come through here: they are already in
  // mounted coordinates, and re-basing them by the window start would send them
  // to the page the reader has already scrolled away from.
  const pendingBranchFocus = React.useRef<number | null>(null)
  const focusBranchRowInList = (listIndex: number) => {
    const mountedIndex = listIndex - branchWindow.start
    if (mountedIndex >= 0 && mountedIndex < branchWindow.visible.length) {
      focusBranchRowInWindow(mountedIndex)
      return
    }
    pendingBranchFocus.current = listIndex
    branchWindow.revealIndex(listIndex)
  }
  React.useEffect(() => {
    setBranchTreeActiveIndex((index) => clampRovingIndex(index, branchWindow.visible.length))
  }, [branchWindow.start, branchWindow.visible.length])
  React.useEffect(() => {
    const pending = pendingBranchFocus.current
    if (pending === null) return
    const mountedIndex = pending - branchWindow.start
    if (mountedIndex < 0 || mountedIndex >= branchWindow.visible.length) return
    pendingBranchFocus.current = null
    focusBranchRowInWindow(mountedIndex)
  }, [branchWindow.start, branchWindow.visible.length])

  const changeState = React.useMemo(
    () => changeGroups(snapshot?.files ?? [], search),
    [snapshot, search],
  )
  const visiblePullRequests = React.useMemo(
    () => (snapshot?.pullRequests ?? []).filter((pr) => matchesPullRequest(pr, search)),
    [search, snapshot],
  )
  const stagedFiles = changeState.staged
  const conflictedFiles = changeState.conflicted
  const currentBranch = snapshot?.currentBranch ?? null
  const allBranches = snapshot?.branches ?? []
  const branchCount = combinedBranches.length
  const pullRequestCount = snapshot?.pullRequests.length ?? 0
  const stashCount = snapshot?.stashes.length ?? 0
  const capabilityAttention = React.useMemo(
    () => (snapshot ? capabilityAttentionCount(capabilityReport(snapshot.capabilities)) : 0),
    [snapshot],
  )
  const detailsVisible = showDetails && (workspaceView === 'branches' || workspaceView === 'stacks')
  const openWorkflow = (request: WorkflowRequest) => {
    if (!snapshot || isBusy) return
    setActionError(null)
    setWorkflow({ id: ++workflowSequence.current, repoPath: snapshot.path, request })
  }
  const shapeReason = React.useCallback(
    (type: GitAction['type']) => {
      if (!snapshot) return null
      return (
        actionBlockReason(snapshot.capabilities, type) ??
        (type === 'stashPop' || type === 'stashDrop'
          ? stashRemovalBlockReason(snapshot.capabilities)
          : null)
      )
    },
    [snapshot],
  )
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
  const requestCheckoutBranch = React.useCallback(
    async (ref: string, name: string) => {
      if (!snapshot || isBusy || operationActive) return
      setSelectedBranchRef(ref)

      // Dirty-working-tree checkout routes through existing carry/stash/commit/cancel safeguards
      if (snapshot.files.length > 0) {
        setCheckoutGuardTarget({ ref, name })
        return
      }

      await runAction({ type: 'switch', ref }, 'Switch branch')
    },
    [isBusy, operationActive, runAction, snapshot],
  )
  const carryCheckoutBranch = React.useCallback(() => {
    if (!checkoutGuardTarget || !snapshot || isBusy || operationActive) return
    const target = checkoutGuardTarget
    setCheckoutGuardTarget(null)
    void runAction(
      { type: 'switch', ref: target.ref, carry: true },
      'Carry changes and switch branch',
    )
  }, [checkoutGuardTarget, snapshot, isBusy, operationActive, runAction])

  const paletteItems = React.useMemo(() => {
    return buildPaletteItems({
      snapshot,
      selectedBranch,
      recentRepositories,
      isBusy,
      operationActive,
      shortcutMap: shortcutBindings,
      isMac,
    })
  }, [
    snapshot,
    selectedBranch,
    recentRepositories,
    isBusy,
    operationActive,
    shortcutBindings,
    isMac,
  ])

  const handlePaletteExecute = React.useCallback(
    (item: PaletteItem, opener: HTMLElement | null) => {
      const intent = item.intent
      if (
        intent.kind === 'newBranch' ||
        intent.kind === 'createPr' ||
        intent.kind === 'workflow' ||
        intent.kind === 'deleteBranch' ||
        intent.kind === 'openShortcutsSettings' ||
        (intent.kind === 'checkoutBranch' && Boolean(snapshot?.files.length))
      ) {
        paletteHandoffFocusRef.current = opener
        paletteDeleteHandoffRef.current = intent.kind === 'deleteBranch'
      }
      switch (intent.kind) {
        case 'view':
          setWorkspaceView(intent.view)
          break
        case 'refresh':
          void refreshSnapshot()
          break
        case 'toggleDetails':
          setShowDetails((prev) => !prev)
          break
        case 'openRepo':
          void openRepository(intent.path)
          break
        case 'newBranch':
          openBranchDialog()
          break
        case 'createPr':
          openPrDialog()
          break
        case 'openPrUrl':
          if (desktop) {
            desktop.openExternal(intent.url).catch((err) => setError(readableError(err)))
          }
          break
        case 'selectBranch':
          setSelectedBranchRef(intent.ref)
          break
        case 'checkoutBranch':
          void requestCheckoutBranch(intent.ref, intent.name)
          break
        case 'navigateStack': {
          if (!snapshot) break
          const target = resolveStackNavigation(selectedBranch, snapshot.branches, intent.relation)
          if (target) {
            setSelectedBranchRef(target.ref)
          }
          break
        }
        case 'reviewPullRequest':
          setReviewNumber(intent.number)
          setWorkspaceView('review')
          break
        case 'reviewFile':
          if (intent.direction === 1) reviewCommands.current?.nextFile()
          else reviewCommands.current?.previousFile()
          break
        case 'reviewLayer':
          if (intent.direction === 1) reviewCommands.current?.nextLayer()
          else reviewCommands.current?.previousLayer()
          break
        case 'workflow':
          openWorkflow(intent.request)
          break
        case 'deleteBranch':
          openDeleteDialog()
          break
        case 'action':
          void runAction(intent.action, intent.label)
          break
        case 'openShortcutsSettings':
          setShortcutSettingsOpen(true)
          break
        case 'openSettings':
          setSettingsOpen(true)
          break
      }
    },
    [
      desktop,
      openBranchDialog,
      openDeleteDialog,
      openPrDialog,
      openRepository,
      openWorkflow,
      refreshSnapshot,
      requestCheckoutBranch,
      runAction,
      selectedBranch,
      snapshot,
    ],
  )
  // Focus follows navigation: switching destination moves focus to the new
  // workspace heading instead of leaving it on the control that was pressed, and
  // the same change is announced politely for readers that track the live region.
  React.useEffect(() => {
    if (previousViewRef.current === workspaceView) return
    previousViewRef.current = workspaceView
    setAnnouncement(`${workspaceViewLabel(workspaceView)} workspace`)
    if (anyModalOpen) return
    document.getElementById(WORKSPACE_VIEW_HEADING_ID)?.focus()
  }, [anyModalOpen, workspaceView])

  // A raised error answers something the user just did, so focus is taken to it
  // — except while a modal owns focus and presents its own inline error. Only a
  // newly raised error may take it: a banner that is already on screen must not
  // pull focus back when a dialog closes and returns focus to its trigger.
  const focusedErrorRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    const raised = error ?? actionError
    // A dismissed banner stops standing in for an error, so the same message
    // raised again is a new error and takes focus again.
    if (!raised) {
      focusedErrorRef.current = null
      return
    }
    if (anyModalOpen || focusedErrorRef.current === raised) return
    focusedErrorRef.current = raised
    document.getElementById(error ? 'global-error-banner' : 'global-action-error-banner')?.focus()
  }, [actionError, anyModalOpen, error])
  React.useEffect(() => {
    if (
      !paletteHandoffFocusRef.current ||
      paletteDeleteHandoffRef.current ||
      paletteOpen ||
      shortcutSettingsOpen ||
      checkoutGuardTarget ||
      deleteTarget ||
      newBranchOpen ||
      prOpen ||
      workflow
    )
      return
    const target = paletteHandoffFocusRef.current
    paletteHandoffFocusRef.current = null
    const frame = requestAnimationFrame(() => {
      if (target.isConnected && !('disabled' in target && target.disabled)) target.focus()
      else searchRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [
    paletteOpen,
    shortcutSettingsOpen,
    checkoutGuardTarget,
    deleteTarget,
    newBranchOpen,
    prOpen,
    workflow,
  ])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A focused control that already handled the key owns it: the palette's
      // search input consumes navigation and confirmation keys before this
      // window listener sees the same bubbling event.
      if (event.defaultPrevented) return
      if (isComposingKeyEvent(event)) return

      // If any modal dialog is currently open, don't execute global hotkeys underneath
      if (anyModalOpen) return

      // A bare printable remap must not steal text from either search field.
      // Modified openers such as Cmd/Ctrl+K still work while editing.
      if (matchesChord(event, shortcutBindings['palette.open'], isMac)) {
        if (anyModalOpen && !paletteOpen) return
        if (
          isEditableTarget(event.target) &&
          event.key.length === 1 &&
          !event.metaKey &&
          !event.ctrlKey
        )
          return
        event.preventDefault()
        if (!event.repeat) setPaletteOpen((prev) => !prev)
        return
      }

      if (anyModalOpen) return

      // Search/filter fields keep their own focused shortcuts and are not conflated with global command search
      if (matchesChord(event, shortcutBindings['search.focus'], isMac)) {
        if (!isEditableTarget(event.target)) {
          event.preventDefault()
          // The destination on screen owns the search this chord promises. The
          // queue filters itself, so `/` there has to reach the queue's own
          // field: focusing the toolbar's search would filter something else,
          // and with no repository open that field does not exist at all.
          const inboxSearch = inboxSearchRef.current
          if (workspaceView === 'prInbox' && inboxSearch) {
            inboxSearch.focus()
            inboxSearch.select()
            return
          }
          searchRef.current?.focus()
          searchRef.current?.select()
          return
        }
      }

      if (isEditableTarget(event.target)) {
        return
      }

      // View navigation shortcuts, one binding per destination so a new
      // destination cannot ship without a keyboard route.
      for (const [shortcut, view] of WORKSPACE_VIEW_SHORTCUTS) {
        if (!matchesChord(event, shortcutBindings[shortcut], isMac)) continue
        event.preventDefault()
        setWorkspaceView(view)
        return
      }

      // The review workspace publishes its file and layer steps through a ref.
      // The shell keeps every remappable key, and a key pressed while no pull
      // request is open stays a no-op rather than reaching into the view.
      const reviewChords: Array<[ShortcutId, () => void]> = [
        ['review.nextFile', () => reviewCommands.current?.nextFile()],
        ['review.previousFile', () => reviewCommands.current?.previousFile()],
        ['review.nextLayer', () => reviewCommands.current?.nextLayer()],
        ['review.previousLayer', () => reviewCommands.current?.previousLayer()],
      ]
      for (const [id, run] of reviewChords) {
        if (!matchesChord(event, shortcutBindings[id], isMac)) continue
        event.preventDefault()
        if (workspaceView === 'review') run()
        return
      }

      // Stack navigation commands
      if (matchesChord(event, shortcutBindings['stack.selectParent'], isMac)) {
        event.preventDefault()
        if (snapshot) {
          const target = resolveStackNavigation(selectedBranch, snapshot.branches, 'parent')
          if (target) setSelectedBranchRef(target.ref)
        }
        return
      }
      if (matchesChord(event, shortcutBindings['stack.selectChild'], isMac)) {
        event.preventDefault()
        if (snapshot) {
          const target = resolveStackNavigation(selectedBranch, snapshot.branches, 'child')
          if (target) setSelectedBranchRef(target.ref)
        }
        return
      }
      if (matchesChord(event, shortcutBindings['stack.selectTop'], isMac)) {
        event.preventDefault()
        if (snapshot) {
          const target = resolveStackNavigation(selectedBranch, snapshot.branches, 'top')
          if (target) setSelectedBranchRef(target.ref)
        }
        return
      }
      if (matchesChord(event, shortcutBindings['stack.selectBottom'], isMac)) {
        event.preventDefault()
        if (snapshot) {
          const target = resolveStackNavigation(selectedBranch, snapshot.branches, 'bottom')
          if (target) setSelectedBranchRef(target.ref)
        }
        return
      }
      if (matchesChord(event, shortcutBindings['stack.checkout'], isMac)) {
        event.preventDefault()
        if (selectedBranch && !selectedBranch.current) {
          void requestCheckoutBranch(selectedBranch.ref, selectedBranch.name)
        }
        return
      }
      if (matchesChord(event, shortcutBindings['stack.restack'], isMac)) {
        event.preventDefault()
        if (
          selectedBranch &&
          !selectedBranch.remote &&
          selectedBranch.name !== snapshot?.defaultBranch &&
          !isBusy &&
          !operationActive
        ) {
          openWorkflow({ kind: 'stack', operation: 'restack', branch: selectedBranch.name })
        }
        return
      }
      if (matchesChord(event, shortcutBindings['stack.sync'], isMac)) {
        event.preventDefault()
        if (
          selectedBranch &&
          !selectedBranch.remote &&
          selectedBranch.name !== snapshot?.defaultBranch &&
          !isBusy &&
          !operationActive
        ) {
          openWorkflow({ kind: 'stack', operation: 'sync', branch: selectedBranch.name })
        }
        return
      }
      if (matchesChord(event, shortcutBindings['stack.openPr'], isMac)) {
        event.preventDefault()
        if (selectedBranch?.pr) {
          desktop?.openExternal(selectedBranch.pr.url).catch((err) => setError(readableError(err)))
        } else if (selectedBranch?.current && snapshot?.github.available && !isBusy) {
          openPrDialog()
        }
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    checkoutGuardTarget,
    deleteTarget,
    desktop,
    isBusy,
    isMac,
    newBranchOpen,
    openPrDialog,
    openWorkflow,
    operationActive,
    paletteOpen,
    prOpen,
    requestCheckoutBranch,
    runAction,
    selectedBranch,
    shortcutBindings,
    shortcutSettingsOpen,
    snapshot,
    workflow,
  ])

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
            attentionCount={capabilityAttention}
            branchCount={branchCount}
            changeCount={snapshot?.files.length ?? 0}
            onSelect={setWorkspaceView}
            pullRequestCount={pullRequestCount}
            inboxCount={pullRequestInboxQueueCount(inboxReport?.items ?? [])}
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
        <div className="connection-state">
          <span
            className={cn(
              'connection-dot',
              accountConnected ? 'connection-dot-live' : 'connection-dot-offline',
            )}
          />
          <button
            className="version-label version-label-action"
            disabled={!desktop || isBusy || operationActive}
            onClick={openAccount}
            title="GitHub account"
            type="button"
          >
            {accountLabel}
          </button>
        </div>
        <div className="sidebar-footer-actions">
          <button
            className="version-label version-label-action"
            disabled={!desktop || isBusy || operationActive}
            onClick={openGitRuntime}
            title="Git runtime diagnostics"
            type="button"
          >
            Git runtime
          </button>
          <span className="version-label">Git Stacks</span>
        </div>
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
            disabled={!snapshot || isBusy || operationActive || Boolean(shapeReason('pull'))}
            onClick={() => openWorkflow({ kind: 'pull' })}
            tooltip={
              shapeReason('pull') ?? 'Choose how to integrate updates from this branch’s upstream.'
            }
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
            disabled={!snapshot || isBusy || operationActive || Boolean(shapeReason('push'))}
            onClick={() => runAction({ type: 'push' }, 'Push')}
            tooltip={
              shapeReason('push') ?? 'Push the current branch without rewriting remote history.'
            }
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
            disabled={
              !snapshot || isBusy || operationActive || Boolean(shapeReason('createBranch'))
            }
            tooltip={
              shapeReason('createBranch') ??
              'Create a local branch from an existing branch and switch to it. Records its stack parent; nothing is pushed.'
            }
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
                  disabled={operationActive || !currentBranch || Boolean(shapeReason('merge'))}
                  onSelect={() => openWorkflow({ kind: 'merge' })}
                >
                  Merge into current branch…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={
                    operationActive ||
                    !currentBranch ||
                    currentBranch === snapshot?.defaultBranch ||
                    Boolean(shapeReason('forcePush'))
                  }
                  onSelect={() => openWorkflow({ kind: 'forcePush' })}
                >
                  Force push with lease…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={
                    operationActive ||
                    !snapshot?.files.length ||
                    snapshot.limits.filesTruncated ||
                    Boolean(shapeReason('stash'))
                  }
                  onSelect={() => openWorkflow({ kind: 'stash' })}
                >
                  Stash changes…
                </DropdownMenu.Item>
                {shapeReason('merge') ||
                shapeReason('forcePush') ||
                shapeReason('stash') ||
                snapshot?.limits.filesTruncated ? (
                  <p className="workflow-note" role="status">
                    {shapeReason('merge') ??
                      shapeReason('forcePush') ??
                      shapeReason('stash') ??
                      'Stash unavailable while the changed-file listing is incomplete.'}
                  </p>
                ) : null}
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
      <Button
        className="toolbar-control"
        size="sm"
        variant="secondary"
        onClick={() => setPaletteOpen(true)}
        aria-keyshortcuts={ariaKeyShortcuts(shortcutBindings['palette.open'], isMac)}
        aria-label="Open command palette"
        tooltip="Search actions, repositories, branches, PRs, issues, and settings"
      >
        <Search className="size-3.5" />
        Palette
        <kbd className="ml-1 rounded border border-[var(--gs-semantic-border-essential)] px-1 font-mono text-[10px] opacity-75">
          {formatChord(shortcutBindings['palette.open'], isMac)}
        </kbd>
      </Button>
      <div className="toolbar-search">
        <Search className="size-3.5" />
        <Input
          aria-keyshortcuts={ariaKeyShortcuts(shortcutBindings['search.focus'], isMac)}
          aria-label="Filter current view branches, files, and pull requests"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter view"
          ref={searchRef}
          value={search}
        />
        <kbd>{formatChord(shortcutBindings['search.focus'], isMac)}</kbd>
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
        <h1 id={WORKSPACE_VIEW_HEADING_ID} tabIndex={-1}>
          Branches
        </h1>
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

  // Extreme repositories are reported, never silently truncated: the reader
  // learns which per-branch analysis the budget left out and what that means.
  const renderBranchBudgetNote = () => {
    const skipped = snapshot?.limits.branchesSkipped ?? 0
    if (!skipped) return null
    return (
      <p className="workflow-note" role="status">
        {skipped} branch{skipped === 1 ? ' has' : 'es have'} incomplete parent or behind analysis
        under the snapshot budget. Recorded parents remain available; inspect omitted branches with
        Git when an exact comparison is needed.
      </p>
    )
  }

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
              disabled={Boolean(shapeReason('createBranch'))}
              onClick={openBranchDialog}
              size="sm"
              variant="accent"
              tooltip={
                shapeReason('createBranch') ??
                'Create a local branch to start a stack. Switches to it; nothing is pushed.'
              }
            >
              <Plus className="size-3.5" />
              New branch
            </Button>
          ) : null}
        </div>
      )
    }

    return (
      <>
        {renderBranchBudgetNote()}
        <div
          aria-label="Repository branches"
          className="branch-list"
          ref={branchTreeListRef}
          role="tree"
        >
          {branchWindow.visible.map((branch, branchIndex) => {
            const tree = branchTree.rows[branchWindow.start + branchIndex]
            const pullRequest = branch.pr
            const selected = branch.ref === selectedBranch?.ref
            const requiresRestack = branch.needsRestack || (branch.parentBehind ?? 0) > 0
            return (
              <BranchHoverCard branch={branch}>
                <div
                  aria-current={selected ? 'true' : undefined}
                  aria-label={describeBranchRow({
                    ahead: branch.ahead,
                    behind: branch.behind,
                    checks: pullRequest?.checks ?? null,
                    current: branch.current,
                    cycle: tree.cycle,
                    missingParent: tree.missingParent,
                    name: branch.name,
                    pullRequestNumber: pullRequest?.number ?? null,
                    remote: branch.remote,
                    requiresRestack,
                    upstream: branch.upstream,
                  })}
                  aria-level={tree.level + 1}
                  aria-posinset={tree.posInSet}
                  aria-selected={selected}
                  aria-setsize={tree.setSize}
                  className={cn('branch-row', selected && 'branch-row-selected')}
                  key={branch.ref}
                  onClick={(event) => {
                    // The row's own controls keep their own activation; only the
                    // row background selects the branch.
                    const hit = event.target as Element
                    if (hit !== event.currentTarget && hit.closest('a, button, [role="button"]')) {
                      return
                    }
                    setSelectedBranchRef(branch.ref)
                  }}
                  onFocus={() => setBranchTreeActiveIndex(branchIndex)}
                  onKeyDown={(event) => {
                    // A control inside the row owns its own keys, and a chord is
                    // the global shortcut dispatcher's business; the roving
                    // contract covers unmodified keys on the row itself only.
                    if (event.target !== event.currentTarget) return
                    if (!claimsRovingKey(event)) return
                    const action = rovingAction(event.key)
                    if (action) {
                      // Up/Down walk the mounted rows in mounted coordinates;
                      // Home and End name the first and last row of the whole
                      // filtered list, which can sit outside the mounted window.
                      const wholeList = action === 'first' || action === 'last'
                      const target = wholeList
                        ? rovingTarget(
                            action,
                            branchIndex + branchWindow.start,
                            visibleBranches.length,
                          )
                        : rovingTarget(action, branchIndex, branchWindow.visible.length)
                      if (target === null) return
                      event.preventDefault()
                      if (wholeList) focusBranchRowInList(target)
                      else focusBranchRowInWindow(target)
                      return
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelectedBranchRef(branch.ref)
                    }
                  }}
                  role="treeitem"
                  style={{ '--branch-depth': tree.depth } as React.CSSProperties}
                  tabIndex={rovingTabIndex(branchIndex, branchTreeActiveIndex)}
                >
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
                      <span className="branch-subject">
                        {branch.subject || 'No commit subject'}
                      </span>
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
                        <span aria-hidden="true" className="ahead-behind relative z-[2] rounded-sm">
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
              </BranchHoverCard>
            )
          })}
        </div>
        <ListWindowMore
          pageSize={LIST_PAGE_SIZE}
          remaining={branchWindow.remaining}
          previous={branchWindow.hasPrevious}
          noun="branches"
          onReveal={branchWindow.reveal}
          onPrevious={branchWindow.retreat}
        />
      </>
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
        onOpenInEditor={openInEditor}
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
        canCreate={
          Boolean(selectedBranch?.current) &&
          snapshot.github.available &&
          !isBusy &&
          !shapeReason('createPr')
        }
        createTooltip={
          shapeReason('createPr') ??
          (!snapshot.github.available
            ? snapshot.github.message ||
              'Connect an authenticated GitHub repository to create pull requests.'
            : !selectedBranch?.current
              ? 'Switch to a local branch to open its pull request on GitHub.'
              : 'Review creating a PR from this branch’s published upstream. Unpushed commits are not included.')
        }
        onCreate={openPrDialog}
        onRequest={openWorkflow}
        pullRequests={visiblePullRequests}
        snapshot={snapshot}
      />
    )
  }

  const renderPrInbox = () => (
    <PullRequestInboxView
      filtersReady={inboxFiltersReady}
      searchInputRef={inboxSearchRef}
      activating={opening}
      error={inboxError}
      loading={inboxLoading}
      onDismissError={() => setInboxError(null)}
      onOpen={openInboxItem}
      onRefresh={() =>
        void loadInbox({
          mergedWithinDays: PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS,
          requestId: INBOX_REQUEST_ID,
        })
      }
      onSaveFilters={(drafts) => void saveInboxFilters(drafts)}
      savingFilters={inboxSavingFilters}
      refreshing={inboxRefreshing}
      report={inboxReport}
      savedFilters={inboxSavedFilters}
    />
  )

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
    // The queue is the one destination that is useful with no repository open:
    // it reads every registered repository rather than the one on screen.
    if (workspaceNeedsNoRepository(workspaceView)) return renderPrInbox()
    if (!snapshot) return null
    if (workspaceView === 'changes') return renderChanges()
    if (workspaceView === 'pullRequests') return renderPullRequests()
    if (workspaceView === 'review')
      return (
        <ReviewView
          commands={reviewCommands}
          desktop={desktop ?? undefined}
          number={reviewNumber ?? selectedPullRequest?.number ?? null}
          onSelectNumber={setReviewNumber}
          pullRequests={visiblePullRequests}
        />
      )
    if (workspaceView === 'stashes') return renderStashes()
    if (workspaceView === 'diagnostics') return <DiagnosticsView snapshot={snapshot} />
    if (workspaceView === 'history')
      return (
        <HistoryView snapshot={snapshot} busy={isBusy} onRequest={openWorkflow} search={search} />
      )
    if (workspaceView === 'stacks')
      return (
        <StackView
          actionError={actionError}
          onClearActionError={() => setActionError(null)}
          snapshot={snapshot}
          busy={isBusy}
          runAction={runAction}
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
              <Badge variant={checksVariant(inspectorChecks)}>
                <ShieldCheck className="size-3" />
                {checkLabel(inspectorChecks)}
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
            ) : selectedBranch.parent && selectedBranch.parentBehind === null ? (
              <div className="restack-notice">
                <strong>Parent comparison unavailable</strong>
                <p>Parent ancestry was not measured. Check the stack before publishing.</p>
              </div>
            ) : null}
          </section>
          {!selectedBranch.remote && selectedBranch.name !== snapshot.defaultBranch ? (
            <section className="detail-section detail-actions">
              <h3>Stack workflow</h3>
              <Button
                variant="accent"
                disabled={isBusy || operationActive || Boolean(shapeReason('executeStack'))}
                tooltip={
                  shapeReason('executeStack') ??
                  'Preview rebasing this stack onto updated parents locally, branch by branch. Remotes stay unchanged until published.'
                }
                onClick={() =>
                  openWorkflow({ kind: 'stack', operation: 'restack', branch: selectedBranch.name })
                }
              >
                <Layers className="size-3.5" />
                Restack stack…
              </Button>
              <Button
                variant="secondary"
                disabled={
                  isBusy ||
                  operationActive ||
                  !snapshot.github.available ||
                  Boolean(shapeReason('executeStack'))
                }
                tooltip={
                  shapeReason('executeStack') ??
                  (!snapshot.github.available
                    ? snapshot.github.message ||
                      'Connect an authenticated GitHub repository to publish stacks.'
                    : 'Push reviewed stack tips and update their pull requests without rebasing. Requires a clean, restacked stack.')
                }
                onClick={() =>
                  openWorkflow({ kind: 'stack', operation: 'publish', branch: selectedBranch.name })
                }
              >
                <Upload className="size-3.5" />
                Publish stack…
              </Button>
              {(() => {
                // The three surgeries act on the selected layer, so each one is offered
                // only where it can be expressed: a parent to move down onto, a layer
                // above to move up past, and no layer above to remove.
                const parent = selectedBranch.parent ?? null
                const above = snapshot.branches.find(
                  (branch) => !branch.remote && branch.parent === selectedBranch.name,
                )
                const common = isBusy || operationActive
                return (
                  <>
                    <Button
                      variant="ghost"
                      disabled={common || Boolean(shapeReason('executeSurgery'))}
                      tooltip={
                        shapeReason('executeSurgery') ??
                        'Preview a new layer on this branch, replaying the layers above it onto it.'
                      }
                      onClick={() =>
                        openWorkflow({
                          kind: 'surgery',
                          request: { kind: 'insert', branch: selectedBranch.name, name: '' },
                        })
                      }
                    >
                      <Layers className="size-3.5" />
                      Insert layer above…
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={common || !parent || Boolean(shapeReason('executeSurgery'))}
                      tooltip={
                        shapeReason('executeSurgery') ??
                        (parent
                          ? `Preview reparenting ${selectedBranch.name} onto ${parent} and replaying the layers above it.`
                          : 'This layer already sits directly on the stack trunk.')
                      }
                      onClick={() =>
                        parent
                          ? openWorkflow({
                              kind: 'surgery',
                              request: {
                                kind: 'move',
                                branch: selectedBranch.name,
                                target: parent,
                              },
                            })
                          : undefined
                      }
                    >
                      Move layer down…
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={common || !above?.parent || Boolean(shapeReason('executeSurgery'))}
                      tooltip={
                        shapeReason('executeSurgery') ??
                        (above
                          ? `Preview moving ${selectedBranch.name} above ${above.name} and replaying both layers.`
                          : 'No layer sits above this one.')
                      }
                      onClick={() =>
                        above
                          ? openWorkflow({
                              kind: 'surgery',
                              request: {
                                kind: 'move',
                                branch: selectedBranch.name,
                                target: above.name,
                              },
                            })
                          : undefined
                      }
                    >
                      Move layer up…
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={common || Boolean(above) || Boolean(shapeReason('executeSurgery'))}
                      tooltip={
                        shapeReason('executeSurgery') ??
                        (above
                          ? 'Reorder the layers above this one first: removing a middle layer has to replay them, and the preview shows it.'
                          : 'Preview deleting this local branch, retargeting nothing above it, and closing its pull request.')
                      }
                      onClick={() =>
                        openWorkflow({
                          kind: 'surgery',
                          request: { kind: 'remove', branch: selectedBranch.name },
                        })
                      }
                    >
                      Remove layer…
                    </Button>
                  </>
                )
              })()}
              <Button
                variant="ghost"
                disabled={isBusy || operationActive || Boolean(shapeReason('setParent'))}
                tooltip={
                  shapeReason('setParent') ??
                  'Record a different local parent without rewriting commits. Preview Restack next to move this branch and descendants.'
                }
                onClick={() => openWorkflow({ kind: 'parent', branch: selectedBranch })}
              >
                Set stack parent…
              </Button>
              {selectedPullRequest?.state === 'OPEN' ? (
                <Button
                  variant="secondary"
                  disabled={isBusy || operationActive || Boolean(shapeReason('executeStack'))}
                  tooltip={
                    shapeReason('executeStack') ??
                    'Preview merging this open pull request into the default branch. Nothing merges until confirmed; remaining branches still need restack.'
                  }
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
                <div className="pr-linked-issues-detail py-1">
                  <div className="flex items-center justify-between text-xs text-[var(--gs-semantic-text-secondary)] font-medium mb-1">
                    <span>Linked issues</span>
                    {selectedPrIssueLinksLoading ? <span>Loading…</span> : null}
                  </div>
                  {selectedPrIssueLinks.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {selectedPrIssueLinks.map((issue) => (
                        <div
                          key={issue.number}
                          className="flex items-center justify-between gap-2 p-1.5 rounded bg-[var(--gs-semantic-surface-raised)] border border-[var(--gs-semantic-border-subtle)] text-xs"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Badge variant={issue.state === 'OPEN' ? 'success' : 'secondary'}>
                              {issue.state.toLowerCase()}
                            </Badge>
                            <Badge variant={issue.relation === 'closing' ? 'accent' : 'outline'}>
                              {issue.relation === 'closing' ? 'closes on merge' : 'related'}
                            </Badge>
                            <button
                              type="button"
                              className="truncate font-medium text-[var(--gs-semantic-text-primary)] hover:underline text-left bg-transparent border-none p-0 cursor-pointer"
                              title={issue.title}
                              onClick={() => issue.url && desktop?.openExternal(issue.url)}
                            >
                              #{issue.number} {issue.title}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : !selectedPrIssueLinksLoading ? (
                    <p className="text-xs text-[var(--gs-semantic-text-muted)] m-0">
                      No linked issues.
                    </p>
                  ) : null}
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
                  onClick={() => {
                    setReviewNumber(selectedPullRequest.number)
                    setWorkspaceView('review')
                  }}
                  size="sm"
                  variant="secondary"
                  tooltip="Read this pull request's files, commits, and stack position in Git Stacks. Nothing is checked out and nothing changes on GitHub."
                >
                  <MessageSquareDiff className="size-3.5" />
                  Review changes
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
          ) : null}
          {selectedPullRequest ? (
            <PullRequestChecksPanel
              loading={checksLoading}
              report={checksReport}
              rerunningRunId={rerunningRunId}
              watching={checksWatching}
              onOpenDetails={openCheckDetails}
              onRefresh={() => void loadChecks(selectedPullRequest.number, true)}
              onRerun={(check) => void rerunCheck(check)}
              onToggleWatch={() => setChecksWatching((current) => !current)}
            />
          ) : (
            <section className="detail-section detail-section-muted">
              <h3>Pull request</h3>
              <p>No pull request for this branch.</p>
              <Button
                disabled={
                  !selectedBranch.current ||
                  !snapshot.github.available ||
                  isBusy ||
                  Boolean(shapeReason('createPr'))
                }
                tooltip={
                  shapeReason('createPr') ??
                  (!snapshot.github.available
                    ? snapshot.github.message ||
                      'Connect an authenticated GitHub repository to create pull requests.'
                    : !selectedBranch.current
                      ? 'Switch to this branch to open its pull request on GitHub.'
                      : 'Review creating a PR from this branch’s published upstream. Unpushed commits are not included.')
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
              disabled={
                selectedBranch.current ||
                isBusy ||
                operationActive ||
                Boolean(shapeReason('switch'))
              }
              tooltip={
                shapeReason('switch') ??
                (selectedBranch.current
                  ? 'This is already the checked-out branch.'
                  : 'Switch the working tree to this branch. Requires a clean tree; remotes create a local tracking copy.')
              }
              onClick={() => requestCheckoutBranch(selectedBranch.ref, selectedBranch.name)}
              variant="accent"
            >
              <ArrowLeftRight className="size-3.5" />
              Switch to this branch
            </Button>
            <Button
              disabled={!canRebase || isBusy || Boolean(shapeReason('rebase'))}
              tooltip={
                shapeReason('rebase') ??
                'Rebase only the current branch onto its recorded parent locally. Rewrites its history; use Restack to move descendants together.'
              }
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
                    isBusy ||
                    operationActive ||
                    selectedBranch.name === snapshot.defaultBranch ||
                    Boolean(shapeReason('renameBranch'))
                  }
                  tooltip={
                    shapeReason('renameBranch') ??
                    (selectedBranch.name === snapshot.defaultBranch
                      ? 'The default branch cannot be renamed here.'
                      : 'Rename this local branch. Remote tracking and open pull requests may need updating.')
                  }
                  onClick={() => openWorkflow({ kind: 'rename', branch: selectedBranch })}
                >
                  Rename local branch…
                </Button>
                <Button
                  variant="secondary"
                  disabled={isBusy || operationActive || Boolean(shapeReason('setUpstream'))}
                  tooltip={
                    shapeReason('setUpstream') ??
                    'Choose which remote branch this branch pushes to and pulls from. Local config only; no commits move.'
                  }
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
                    operationActive ||
                    Boolean(shapeReason('deleteBranch'))
                  }
                  onClick={openDeleteDialog}
                  tooltip={
                    shapeReason('deleteBranch') ??
                    (selectedBranch.name === snapshot.defaultBranch
                      ? 'The default branch cannot be deleted.'
                      : selectedBranch.current
                        ? 'Cannot delete the checked-out branch — switch away first. Remotes and pull requests are kept.'
                        : 'Delete this local branch. Remotes and pull requests are kept; unmerged work needs force and can orphan commits.')
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
                  selectedBranch.name.endsWith(`/${snapshot.defaultBranch}`) ||
                  Boolean(shapeReason('deleteRemoteBranch'))
                }
                onClick={() => openWorkflow({ kind: 'deleteRemote', branch: selectedBranch })}
                tooltip={
                  shapeReason('deleteRemoteBranch') ??
                  'Preview removing this branch from its remote. Local copies remain; open PRs may close and collaborators must prune.'
                }
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
    <main className="onboarding-pane">
      <div className="onboarding-content">
        <div className="onboarding-icon">
          <GitBranch className="size-7" />
        </div>
        <h1>Start with a repository</h1>
        <p>
          Git Stacks gives you a focused view of branches, working changes, and pull requests
          without leaving your desktop. A repository stays ordinary Git: clone it here, then keep
          using it in your terminal, your editor, or GitHub Desktop.
        </p>
        <div className="onboarding-actions">
          <Button disabled={opening || !desktop} onClick={openDiscovery} size="lg" variant="accent">
            {opening ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Search aria-hidden="true" className="size-4" />
            )}
            Search GitHub
          </Button>
          <Button
            disabled={opening || !desktop}
            onClick={() => void openRepository(undefined, 'recent')}
            size="lg"
            variant="secondary"
          >
            <FolderOpen aria-hidden="true" className="size-4" />
            Add local repository
          </Button>
        </div>
        <p className="onboarding-hint">Or drop a Git repository folder anywhere on this window.</p>
        {!desktop ? (
          <div className="desktop-notice" role="status">
            <Terminal aria-hidden="true" className="size-4" />
            <span>
              Open Git Stacks in the desktop app to access local Git repositories. This browser view
              does not include demo data.
            </span>
          </div>
        ) : null}
        {recentRepositories.length > 0 ? (
          <div className="onboarding-recents">
            <div className="onboarding-recents-heading">
              <Clock3 aria-hidden="true" className="size-4" />
              <h2>Recent repositories</h2>
            </div>
            {recentRepositories.map((repository) => (
              <button
                className="onboarding-recent"
                disabled={opening}
                key={repository.path}
                onClick={() => void openRepository(repository.path)}
                type="button"
              >
                <FolderGit2 aria-hidden="true" className="size-4" />
                <span>
                  <strong>{repository.name}</strong>
                  <small>{repository.path}</small>
                </span>
                <ChevronRight aria-hidden="true" className="size-4" />
              </button>
            ))}
          </div>
        ) : null}
        <GitEnvironmentPanel failure={gitEnvironmentFailure} status={gitEnvironment} />
      </div>
    </main>
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
          role="group"
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
        {snapshot ? <RemoteFreshnessBadge freshness={remoteStatus ?? snapshot.remote} /> : null}
        <span className="titlebar-build">Native Git workspace</span>
      </header>
      {error ? (
        <InlineAlert
          tone="error"
          className="global-banner"
          id="global-error-banner"
          role="alert"
          tabIndex={-1}
        >
          <span className="global-banner-row">
            <span>{error}</span>
            <IconButton label="Dismiss error" onClick={() => setError(null)}>
              <X aria-hidden="true" className="size-3.5" />
            </IconButton>
          </span>
        </InlineAlert>
      ) : null}
      {actionError ? (
        <InlineAlert
          tone="error"
          className="global-banner"
          id="global-action-error-banner"
          role="alert"
          tabIndex={-1}
        >
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
      {(remoteStatus?.pendingMutations ?? []).map((pending) => (
        <InlineAlert key={pending.id} tone="error" className="global-banner" role="alert">
          <span className="global-banner-row">
            <span>
              {`${pending.label} did not reach GitHub and will not be retried automatically. ${pending.reason}`}
            </span>
            <IconButton
              label={`Dismiss ${pending.label}`}
              onClick={() => {
                void desktop?.dismissPendingMutation?.(pending.id)
                setRemoteStatus((current) =>
                  current
                    ? {
                        ...current,
                        pendingMutations: current.pendingMutations.filter(
                          (entry) => entry.id !== pending.id,
                        ),
                      }
                    : current,
                )
              }}
            >
              <X aria-hidden="true" className="size-3.5" />
            </IconButton>
          </span>
        </InlineAlert>
      ))}
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {snapshot ? <section aria-label="Repository controls">{renderToolbar()}</section> : null}
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
        {snapshot || workspaceNeedsNoRepository(workspaceView) ? (
          <main className="main-pane">{renderMainContent()}</main>
        ) : (
          renderOnboarding()
        )}
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
          defaults={settings}
        />
      ) : null}
      <SettingsDialog
        account={account}
        desktop={desktop}
        onAccountChange={setAccount}
        onError={setError}
        onSettingsChange={setSettings}
        onShortcutBindingsChange={setShortcutBindings}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        shortcutBindings={shortcutBindings}
      />
      <GitRuntimeDialog
        busy={gitRuntimeBusy || isBusy || operationActive}
        onOpenChange={setGitRuntimeOpen}
        onSelectSystemGit={selectGitRuntime}
        open={gitRuntimeOpen}
        status={gitRuntimeStatus}
      />
      <GitHubAccountDialog
        busy={accountBusy || isBusy || operationActive}
        onCancelSignIn={() => runAccountAction(() => desktop!.cancelGitHubSignIn!(), true)}
        onOpenChange={setAccountOpen}
        onOpenVerification={openDevicePage}
        onSignIn={() => runAccountAction(() => desktop!.startGitHubSignIn!())}
        onSignOut={() => runAccountAction(() => desktop!.signOutOfGitHub!(), true)}
        open={accountOpen}
        status={account}
      />
      <RepositoryDiscoveryDialog
        account={account}
        busy={isBusy || operationActive}
        onCloned={(result) => void adoptClonedRepository(result)}
        onOpenAccount={openAccount}
        onOpenChange={setDiscoveryOpen}
        open={discoveryOpen}
      />
      {conflictPath && snapshot ? (
        <ConflictResolver
          key={conflictPath}
          busy={isBusy}
          actionError={actionError}
          path={conflictPath}
          conflictPresent={snapshot.files.some(
            (file) => file.conflicted && file.path === conflictPath,
          )}
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
            if (paletteDeleteHandoffRef.current) {
              paletteDeleteHandoffRef.current = false
              const target = paletteHandoffFocusRef.current
              paletteHandoffFocusRef.current = null
              if (target?.isConnected && !('disabled' in target && target.disabled)) target.focus()
              else searchRef.current?.focus()
              return
            }
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
                    isBusy ||
                    Boolean(shapeReason('deleteBranch')) ||
                    (deleteForce && deleteConfirmation !== deleteTarget?.branch.name)
                  }
                  type="submit"
                  variant="danger"
                  loading={busyAction === 'Delete branch'}
                  tooltip={
                    shapeReason('deleteBranch') ??
                    (deleteForce && deleteConfirmation !== deleteTarget?.branch.name
                      ? 'Type the branch name to enable force deletion. Unmerged commits can become unreachable.'
                      : 'Delete this local branch now. Remotes and pull requests are kept.')
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
                  disabled={
                    isBusy ||
                    Boolean(shapeReason('createBranch')) ||
                    !newBranchName.trim() ||
                    !newBranchParent
                  }
                  type="submit"
                  variant="accent"
                  loading={busyAction === 'Create branch'}
                  tooltip={
                    shapeReason('createBranch') ??
                    (!newBranchName.trim() || !newBranchParent
                      ? 'Enter a branch name and choose a parent branch first.'
                      : 'Create the local branch, record its stack parent, and switch to it. Nothing is pushed.')
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
                    !prBase.trim() ||
                    Boolean(shapeReason('createPr'))
                  }
                  loading={busyAction === 'Create pull request'}
                  tooltip={
                    shapeReason('createPr') ??
                    (!snapshot?.github.available
                      ? snapshot?.github.message ||
                        'Connect an authenticated GitHub repository to create pull requests.'
                      : !selectedBranch?.current
                        ? 'Switch to a local branch to create its pull request.'
                        : !prBase.trim()
                          ? 'Choose the base branch this pull request targets.'
                          : 'Create the PR using this branch’s published upstream. This does not push newer local commits.')
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
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        items={paletteItems}
        onExecute={handlePaletteExecute}
        searchFallbackRef={searchRef}
      />
      <ShortcutSettings
        open={shortcutSettingsOpen}
        onOpenChange={setShortcutSettingsOpen}
        bindings={shortcutBindings}
        onBindingsChange={(bindings) => {
          void persistShortcutBindings(bindings)
        }}
        disabledReason={shortcutLockReason}
      />
      <DirtyCheckoutGuard
        target={checkoutGuardTarget}
        snapshot={snapshot}
        onCarry={carryCheckoutBranch}
        onClose={() => setCheckoutGuardTarget(null)}
        onStash={() => openWorkflow({ kind: 'stash' })}
        onReviewChanges={() => setWorkspaceView('changes')}
      />
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
