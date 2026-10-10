import * as React from 'react'
import { useForm, useSelector } from '@tanstack/react-form'
import { CancelledError, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  GitRuntimeStatus,
  GitHubCliState,
  GitHubCliStatus,
  PullRequest,
  RepositoryCloneResult,
  RepositorySnapshot,
  RemoteFreshness,
  RemoteFreshnessState,
} from '@git-stacks/shared/types'
import { GitEnvironmentPanel, RepositoryDiscoveryDialog } from './components/onboarding'
import { LIST_PAGE_SIZE } from '@git-stacks/shared/performance'
import { ListWindowMore } from './components/list-window'
import { useListWindow, useRovingListFocus } from './lib/list-window'
import { createRequestGate, type RequestClaim } from './lib/request-gate'
import { useSettingsMutation } from './lib/settings-query'
import { cliAuthority, withoutReplacedCredential } from './credential-identity'
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
import { claimsRovingKey, rovingAction, rovingTabIndex, rovingTarget } from './lib/tree-navigation'
import { WorkflowDialog, type WorkflowRequest } from './components/workflow-dialog'
import {
  WORKSPACE_VIEW_HEADING_ID,
  WORKSPACE_VIEW_SHORTCUTS,
  WorkspaceNavigation,
  type WorkspaceView,
  workspaceNeedsNoRepository,
  workspaceViewLabel,
} from './components/workspace-navigation'
import { ReviewView, type ReviewCommands } from './components/review-view'
import { ConflictResolver } from './components/conflict-resolver'
import { HistoryView, OperationBanner } from './components/repository-views'
import { GraphWorkbench } from './components/graph-workbench'
import { GitRuntimeDialog } from './components/git-runtime-dialog'
import { SettingsDialog } from './components/settings-dialog'
import { GitHubCliStatusDialog } from './components/github-cli-status'
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
} from '@git-stacks/shared/pr-inbox'
import type {
  PullRequestInboxFilterDraft,
  PullRequestInboxItem,
  PullRequestInboxReport,
} from '@git-stacks/shared/pr-inbox'
import { checkLabel, checksVariant } from './lib/pull-request-state'
import { branchDeleteReason } from './lib/branches'
import type {
  PullRequestCheckDetail,
  PullRequestChecksReport,
} from '@git-stacks/shared/pull-request-checks'
import {
  OperationContext,
  PhaseStatus,
  WorkflowActions,
  WorkflowFrame,
  WarningNote,
} from './components/workflow-composition'
import { CLOSE_INTENT_MESSAGES, closeIntent } from './components/workflow-policy'
import {
  actionBlockReason,
  capabilityAttentionCount,
  capabilityReport,
  stashRemovalBlockReason,
} from '@git-stacks/shared/capabilities'

import type { NotificationInbox, NotificationThread } from '@git-stacks/shared/notifications'
import { canonicalHostName, GITHUB_DEFAULT_HOST } from '@git-stacks/shared/host'
import {
  NotificationCenterView,
  NotificationCredentialDialog,
} from './components/notification-center-view'

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
} from '@git-stacks/shared/shortcuts'
import type { AppSettings, SettingsPatch, SettingsSnapshot } from '@git-stacks/shared/settings'
import { resolveStackNavigation, type StackRelation } from './lib/stack-navigation'
type BranchFilter = 'all' | 'local' | 'remote' | 'prs'
type NotificationOperation =
  | { kind: 'read'; id: string }
  | { kind: 'done'; id: string }
  | { kind: 'subscribe'; id: string; action: 'unsubscribe' | 'ignore' }
  | { kind: 'removeCredential' }

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

/**
 * These dialogs report one problem at a time, so the inline status line reads
 * the first field error and then the form-level submit error, which is where a
 * failed Git action is recorded.
 */
function firstFieldMessage(
  ...errorLists: ReadonlyArray<readonly unknown[] | undefined>
): string | null {
  for (const list of errorLists) {
    const message = list?.[0]
    if (typeof message === 'string' && message) return message
  }
  return null
}

/**
 * What a person is told when a change reached GitHub and the answer never came
 * back. The transport's own words describe this app, not GitHub, and reading
 * them says nothing about whether the change landed: what is true is that
 * nobody can tell from here, so that is what the window says.
 */
function unknownOutcomeError(message: string): string {
  return /fetch failed|ECONNRESET|EPIPE|socket hang up|network|timed? ?out|aborted/iu.test(message)
    ? 'GitHub never answered, so this app cannot tell whether the change was applied.'
    : message
}

/**
 * Whether an inbox answer is about the host this window is pointed at.
 *
 * A notification inbox is one host's private list, read with that host's own
 * credential, so an answer naming another host is not a slower version of this
 * one: it is another host's rows. A window with no authoritative host to
 * compare against (a main process that reports no settings) adopts the first
 * answer and fences nothing, because nothing has been established to fence on.
 */
function inboxForHost(inbox: NotificationInbox, host: string | null): boolean {
  return host === null || canonicalHostName(inbox.host) === host
}

/**
 * The status a host is reported as while its own read is outstanding.
 *
 * Naming the host matters more than filling the fields: this is what every
 * surface shows between a host change and the answer, and it must say which
 * host is being read rather than leave the previous host's facts standing as
 * this one's. It names no account, no version, and no credential, because
 * nothing has established any of those for this host yet.
 */
function cliCheckingStatus(host: string): GitHubCliStatus {
  return {
    state: 'checking',
    host,
    login: null,
    version: null,
    identity: null,
    message: null,
  }
}

const CLI_LABELS: Record<GitHubCliState, string> = {
  checking: 'GitHub CLI: checking',
  'missing-cli': 'GitHub CLI: not installed',
  'signed-out': 'GitHub CLI: signed out',
  authenticated: 'GitHub CLI: signed in',
  rejected: 'GitHub CLI: authentication rejected',
  'permission-denied': 'GitHub CLI: organization access required',
  offline: 'GitHub CLI: unreachable',
  unavailable: 'GitHub CLI: unavailable',
}

/**
 * The review workspace's file and layer steps, one binding per published
 * command. A key pressed while no pull request is open stays a no-op rather
 * than reaching into the view.
 */
const REVIEW_COMMANDS: readonly (readonly [ShortcutId, keyof ReviewCommands])[] = [
  ['review.nextFile', 'nextFile'],
  ['review.previousFile', 'previousFile'],
  ['review.nextLayer', 'nextLayer'],
  ['review.previousLayer', 'previousLayer'],
]

/** One keyboard route per stack relation, beside the relation the shell asks for. */
const STACK_NAVIGATION_SHORTCUTS: readonly (readonly [ShortcutId, StackRelation])[] = [
  ['stack.selectParent', 'parent'],
  ['stack.selectChild', 'child'],
  ['stack.selectTop', 'top'],
  ['stack.selectBottom', 'bottom'],
]

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
  const queryClient = useQueryClient()
  const fallbackShortcuts = React.useMemo(() => defaultShortcutBindings(), [])
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => desktop!.settings!(),
    enabled: Boolean(desktop?.settings),
  })
  const settings = settingsQuery.data?.settings ?? null
  const settingsLocks = settingsQuery.data?.locks ?? []
  const shortcutBindings = settings?.shortcuts ?? fallbackShortcuts
  const host = settings ? canonicalHostName(settings.github.host) : GITHUB_DEFAULT_HOST
  const cliKey = React.useMemo(() => ['github-cli', host] as const, [host])
  const cliKeyRef = React.useRef(cliKey)
  cliKeyRef.current = cliKey
  const setCliStatus = React.useCallback(
    (status: GitHubCliStatus) => {
      const key = ['github-cli', canonicalHostName(status.host)]
      void queryClient.cancelQueries({ queryKey: ['github-cli'] })
      queryClient.setQueryData(key, status)
    },
    [queryClient],
  )
  const cliQuery = useQuery<GitHubCliStatus | null>({ queryKey: cliKey, enabled: false })
  const cliStatus = cliQuery.data ?? null
  const [repositoryIdentity, setRepositoryIdentity] = React.useState<{
    path: string | null
    generation: number
    /** Seed the new observer even if the zero-lifetime cache is collected before render. */
    snapshot?: RepositorySnapshot | null
  }>({ path: null, generation: 0 })
  const repositoryKey = React.useMemo(
    () => ['repository-snapshot', repositoryIdentity.path, repositoryIdentity.generation] as const,
    [repositoryIdentity],
  )
  const repositoryKeyRef = React.useRef(repositoryKey)
  repositoryKeyRef.current = repositoryKey
  const snapshotQuery = useQuery<RepositorySnapshot | null>({
    queryKey: repositoryKey,
    enabled: false,
    structuralSharing: false,
    initialData: repositoryIdentity.snapshot,
  })
  const snapshot = snapshotQuery.data ?? null
  const recentRepositoriesQuery = useQuery({
    queryKey: ['recent-repositories'],
    queryFn: () => desktop!.recentRepositories(),
    enabled: Boolean(desktop),
  })
  const recentRepositories = recentRepositoriesQuery.data ?? []
  const [selectedBranchRef, setSelectedBranchRef] = React.useState<string | null>(null)
  const [branchSelection, setBranchSelection] = React.useState<{
    repoPath: string
    refs: Set<string>
  } | null>(null)
  const branchSelectionMode =
    branchSelection !== null && branchSelection.repoPath === snapshot?.path
  const [workspaceView, setWorkspaceView] = React.useState<WorkspaceView>('branches')
  const [branchFilter, setBranchFilter] = React.useState<BranchFilter>('all')
  const [search, setSearch] = React.useState('')
  const bootLoading = Boolean(desktop && recentRepositoriesQuery.isPending)
  const repositoryOpenMutation = useMutation({
    mutationFn: async ({
      path,
      mode,
      landing,
      claim,
    }: {
      path?: string
      mode: 'recent' | 'add'
      landing?: { reviewNumber: number }
      claim: RequestClaim
    }) => {
      setError(null)
      setActionError(null)
      setNotice(null)
      try {
        const next =
          mode === 'add'
            ? await desktop!.addRepository?.(path ?? '')
            : await desktop!.openRepository(path)
        if (next && openingRef.current === claim) {
          setSnapshotAndSelection(
            repositoryGate.current(claim) ? next : withoutReplacedCredential(next),
          )
          setDeleteTarget(null)
          setWorkflow(null)
          setInspectedPath(null)
          commitForm.reset()
          if (landing) setReviewNumber(landing.reviewNumber)
          setWorkspaceView(landing ? 'review' : 'branches')
        }
        await recentRepositoriesQuery.refetch()
      } catch (value) {
        if (openingRef.current === claim) setError(readableError(value))
      } finally {
        if (openingRef.current === claim) openingRef.current = null
      }
    },
  })
  const opening = repositoryOpenMutation.isPending
  const refreshing = snapshotQuery.isFetching
  const actionMutation = useMutation({
    mutationFn: async ({ action, label }: { action: GitAction; label: string }) => {
      setActionError(null)
      setNotice(null)
      try {
        const result = await desktop!.runAction(action)
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
          commitForm.reset()
        }
        return true
      } catch (value) {
        const failure = { form: readableError(value), fields: {} }
        if (action.type === 'createBranch') newBranchForm.setErrorMap({ onSubmit: failure })
        if (action.type === 'createPr') prForm.setErrorMap({ onSubmit: failure })
        if (
          action.type === 'deleteBranch' ||
          action.type === 'deleteBranches' ||
          action.type === 'deleteRemoteBranch' ||
          action.type === 'deleteRemoteBranches'
        ) {
          deleteForm.setErrorMap({ onSubmit: failure })
        }
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
      }
    },
  })
  const busyAction = actionMutation.isPending ? (actionMutation.variables?.label ?? null) : null
  const [error, setError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [newBranchOpen, setNewBranchOpen] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<{
    branches: Branch[]
    repoPath: string
  } | null>(null)
  const deletingRemote = deleteTarget?.branches[0]?.remote === true
  const deleteCount = deleteTarget?.branches.length ?? 0
  const deleteNoun = deleteCount > 1 ? 'branches' : 'branch'
  const deleteActionType: GitAction['type'] = deletingRemote
    ? deleteCount === 1
      ? 'deleteRemoteBranch'
      : 'deleteRemoteBranches'
    : deleteCount === 1
      ? 'deleteBranch'
      : 'deleteBranches'
  const deleteOpenerRef = React.useRef<HTMLElement | null>(null)
  const [prOpen, setPrOpen] = React.useState(false)
  const [deleteCloseNotice, setDeleteCloseNotice] = React.useState<string | null>(null)
  const [newBranchNotice, setNewBranchNotice] = React.useState<string | null>(null)
  const [prNotice, setPrNotice] = React.useState<string | null>(null)
  const [inspectedPath, setInspectedPath] = React.useState<string | null>(null)
  const [reviewNumber, setReviewNumber] = React.useState<number | null>(null)
  const [conflictPath, setConflictPath] = React.useState<string | null>(null)
  const [workflow, setWorkflow] = React.useState<{
    id: number
    repoPath: string
    request: WorkflowRequest
  } | null>(null)
  const [gitRuntimeOpen, setGitRuntimeOpen] = React.useState(false)
  const gitRuntimeQuery = useQuery<GitRuntimeStatus>({
    queryKey: ['git-runtime'],
    queryFn: () => desktop!.gitRuntimeStatus(),
    enabled: false,
  })
  const gitRuntimeStatus = gitRuntimeQuery.data ?? null
  const runtimeMutation = useMutation({
    mutationFn: (useSystemGit: boolean) => desktop!.setSystemGit(useSystemGit),
    onSuccess: (status) => queryClient.setQueryData(['git-runtime'], status),
  })
  const gitRuntimeBusy = runtimeMutation.isPending
  const [cliStatusOpen, setCliStatusOpen] = React.useState(false)
  const cliRefreshing = cliQuery.isFetching
  const [discoveryOpen, setDiscoveryOpen] = React.useState(false)
  const environmentQuery = useQuery({
    queryKey: ['git-environment', 'onboarding'],
    queryFn: () => desktop!.gitEnvironment!('onboarding:environment'),
    enabled: Boolean(desktop?.gitEnvironment),
  })
  const gitEnvironment = environmentQuery.data?.ok ? environmentQuery.data.value : null
  const gitEnvironmentFailure =
    environmentQuery.data && !environmentQuery.data.ok ? environmentQuery.data.failure : null
  // Counts every CLI status read this window has asked for. A refresh that
  // answers after a later one, or after a host or account change retired the
  // identity, must not paint the state it was asked about over the current one.
  const cliStatusRequest = React.useRef(0)
  /** The host the CLI status on screen was established for. */
  const cliStatusHost = React.useRef<string | null>(null)
  /**
   * The legacy import is offered once. Main decides at write time whether it
   * still applies, and a declined import leaves the stored bindings alone, so
   * asking again would only repeat a decision that has already been made.
   */
  const legacyImportOffered = React.useRef(false)
  const workflowSequence = React.useRef(0)

  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = React.useState(false)
  const settingsMutation = useSettingsMutation(
    ({ patch }: { patch: SettingsPatch; notificationOwner?: { request: number; host: string } }) =>
      desktop!.updateSettings!(patch),
    ({ notificationOwner }) =>
      !notificationOwner || notificationClaim(notificationOwner.request, notificationOwner.host),
  )
  const setSettings = React.useCallback(
    (next: AppSettings) => {
      void queryClient.cancelQueries({ queryKey: ['settings'] })
      queryClient.setQueryData<SettingsSnapshot>(['settings'], (current) =>
        current ? { ...current, settings: next } : current,
      )
    },
    [queryClient],
  )
  const setShortcutBindings = React.useCallback(
    (bindings: Record<ShortcutId, string>) => {
      void queryClient.cancelQueries({ queryKey: ['settings'] })
      queryClient.setQueryData<SettingsSnapshot>(['settings'], (current) =>
        current ? { ...current, settings: { ...current.settings, shortcuts: bindings } } : current,
      )
    },
    [queryClient],
  )
  /**
   * Writes a shortcut change and adopts only what main confirmed. A refused
   * write — a policy lock, an invalid chord — must leave the running app on
   * the bindings that are actually in force.
   */
  const persistShortcutBindings = React.useCallback(
    async (bindings: Record<ShortcutId, string>) => {
      if (!desktop?.updateSettings) return
      try {
        await settingsMutation.mutateAsync({ patch: { shortcuts: bindings } })
      } catch (value) {
        setError(readableError(value))
        // Re-read so the editor shows what is stored rather than what was tried.
        await settingsQuery.refetch()
      }
    },
    [desktop, settingsMutation, settingsQuery],
  )
  const shortcutLockReason =
    settingsLocks.find((lock) => lock.key === 'shortcuts')?.reason ?? undefined
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [checkoutGuardTarget, setCheckoutGuardTarget] = React.useState<{
    ref: string
    name: string
  } | null>(null)
  // The Notification Center's consent dialog owns focus the way every other
  // modal does, so global shortcuts and navigation focus stay out of it. It
  // is declared here because the gate below is read on every render, before
  // the notification state is reached.
  const [notificationDialogOpen, setNotificationDialogOpen] = React.useState(false)
  const anyModalOpen =
    paletteOpen ||
    shortcutSettingsOpen ||
    checkoutGuardTarget !== null ||
    deleteTarget !== null ||
    newBranchOpen ||
    prOpen ||
    workflow !== null ||
    notificationDialogOpen
  const [announcement, setAnnouncement] = React.useState('')
  const previousViewRef = React.useRef(workspaceView)
  const isMac = React.useMemo(() => isMacPlatform(), [])
  const [showDetails, setShowDetails] = React.useState(true)
  const busyRef = React.useRef<string | null>(null)
  /**
   * The local repository open this window is waiting for. Credential changes
   * retire its remote data, not the switch itself: main may already have
   * persisted the selection, so its completed local identity must be adopted.
   */
  const openingRef = React.useRef<RequestClaim | null>(null)
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
  const freshnessKey = React.useMemo(
    () => ['remote-freshness', repositoryIdentity.path, repositoryIdentity.generation] as const,
    [repositoryIdentity],
  )
  const freshnessKeyRef = React.useRef(freshnessKey)
  freshnessKeyRef.current = freshnessKey
  const freshnessQuery = useQuery<RemoteFreshness | null>({
    queryKey: freshnessKey,
    queryFn: async () => (await desktop!.remoteStatus?.()) ?? null,
    enabled: Boolean(desktop),
  })
  const remoteStatus = freshnessQuery.data ?? null
  const setRemoteStatus = React.useCallback(
    (next: React.SetStateAction<RemoteFreshness | null>) => {
      const key = freshnessKeyRef.current
      void queryClient.cancelQueries({ queryKey: key, exact: true })
      queryClient.setQueryData<RemoteFreshness | null>(key, (current) =>
        typeof next === 'function' ? next(current ?? null) : next,
      )
    },
    [queryClient],
  )
  const dismissPendingMutation = useMutation({
    mutationFn: async (id: string) => desktop!.dismissPendingMutation?.(id),
  })
  // The PR Inbox is its own destination with its own read: it spans every
  // registered repository rather than the one on screen, and it is the only
  // surface that answers "what is waiting on me?" across all of them.
  const inboxKey = React.useMemo(
    () => ['pull-request-inbox', host, repositoryIdentity.generation] as const,
    [host, repositoryIdentity.generation],
  )
  const inboxKeyRef = React.useRef(inboxKey)
  inboxKeyRef.current = inboxKey
  const inboxQuery = useQuery<PullRequestInboxReport | null>({
    queryKey: inboxKey,
    enabled: false,
  })
  const inboxReport = inboxQuery.data ?? null
  const filtersQuery = useQuery({
    queryKey: ['pull-request-inbox-filters'],
    queryFn: async () => (await desktop!.pullRequestInboxFilters?.()) ?? [],
    enabled: Boolean(desktop),
  })
  const inboxSavedFilters = filtersQuery.isFetching ? [] : (filtersQuery.data ?? [])
  const inboxLoading = inboxQuery.isFetching
  const inboxRefreshing = inboxQuery.isFetching
  const filtersMutation = useMutation({
    mutationFn: (drafts: PullRequestInboxFilterDraft[]) =>
      desktop!.savePullRequestInboxFilters!(drafts),
    onSuccess: async (saved) => {
      await queryClient.cancelQueries({ queryKey: ['pull-request-inbox-filters'] })
      queryClient.setQueryData(['pull-request-inbox-filters'], saved)
    },
  })
  const inboxSavingFilters = filtersMutation.isPending
  // The lock is a ref so a second mutation in the same event is refused before
  // the render that shows the controls as waiting has happened.
  const savingInboxFiltersRef = React.useRef(false)
  // Whether the stored list has been read. The save controls wait for it: each
  // one replaces the whole list, so a save taken against the list as it has not
  // been read yet would send back an empty list and store it.
  const inboxFiltersReady = !filtersQuery.isPending && !filtersQuery.isFetching
  const [inboxError, setInboxError] = React.useState<string | null>(null)
  // The account the rows on screen were read for. A ref, not a state: it is
  // read and written in the same event that retires those rows, and dropping the
  // rows is what renders, not the identity itself.
  const inboxIdentityRef = React.useRef<string | null>(null)
  const inboxGate = React.useRef(createRequestGate()).current
  // A background snapshot only applies to the repository the window still shows.
  const snapshotPathRef = React.useRef<string | null>(null)
  const setSnapshotAndSelection = React.useCallback(
    (next: RepositorySnapshot) => {
      setBranchSelection((current) => {
        if (current?.repoPath !== next.path) return null
        const refs = new Set(
          next.branches
            .filter(
              (branch) =>
                current.refs.has(branch.ref) && !branchDeleteReason(branch, next.defaultBranch),
            )
            .map((branch) => branch.ref),
        )
        return { ...current, refs }
      })
      const previous = repositoryKeyRef.current
      const key = ['repository-snapshot', next.path, previous[2]] as const
      void queryClient.cancelQueries({ queryKey: key, exact: true })
      queryClient.setQueryData(key, next)
      repositoryKeyRef.current = key
      if (previous[1] !== next.path) {
        setRepositoryIdentity({ path: next.path, generation: previous[2], snapshot: next })
      }
      snapshotPathRef.current = next.path
      // A snapshot the main process produced already knows its own freshness.
      const previousFreshness = queryClient.getQueryData<RemoteFreshness | null>(
        freshnessKeyRef.current,
      )
      freshnessKeyRef.current = ['remote-freshness', next.path, previous[2]]
      setRemoteStatus(next.remote ?? previousFreshness ?? null)
      setSelectedBranchRef((current) => {
        if (current && next.branches.some((branch) => branch.ref === current)) return current
        if (next.currentBranch) return `refs/heads/${next.currentBranch}`
        return next.branches[0]?.ref ?? null
      })
    },
    [queryClient, setRemoteStatus],
  )

  const refreshSnapshot = React.useCallback(async (): Promise<RepositorySnapshot | null> => {
    if (!desktop) return null
    const claim = repositoryGate.claim()
    await queryClient.cancelQueries({ queryKey: repositoryKeyRef.current, exact: true })
    try {
      const next = await queryClient.fetchQuery({
        queryKey: repositoryKeyRef.current,
        structuralSharing: false,
        queryFn: async () => {
          const result = await desktop.refresh()
          if (!repositoryGate.current(claim)) throw new CancelledError()
          return result
        },
        staleTime: 0,
      })
      if (!repositoryGate.current(claim)) return null
      setSnapshotAndSelection(next)
      return next
    } catch (value) {
      if (repositoryGate.current(claim) && !(value instanceof CancelledError))
        setError(readableError(value))
      return null
    }
  }, [desktop, queryClient, repositoryGate, setSnapshotAndSelection])

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
      void queryClient.cancelQueries({ queryKey: repositoryKeyRef.current, exact: true })
      queryClient.setQueryData<RepositorySnapshot | null>(repositoryKeyRef.current, (current) =>
        current ? { ...current, issues } : current,
      )
    })
    const offStatus = desktop.onRemoteStatus?.((freshness) => setRemoteStatus(freshness))
    return () => {
      offSnapshot?.()
      offIssues?.()
      offStatus?.()
    }
  }, [desktop, queryClient, setSnapshotAndSelection, setRemoteStatus])

  // Focus and visibility decide how often GitHub is read; the main process
  // cannot observe either on its own.
  const activityMutation = useMutation({
    mutationFn: (activity: { focused: boolean; visible: boolean }) =>
      desktop!.reportActivity!(activity),
  })
  React.useEffect(() => {
    if (!desktop?.reportActivity) return
    const report = () => {
      activityMutation.mutate({
        focused: document.hasFocus(),
        visible: document.visibilityState === 'visible',
      })
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
  }, [desktop, activityMutation.mutate])

  // Settings are read once at startup so the window opens in the appearance and
  // with the shortcuts the user last chose. Main owns the file.
  React.useEffect(() => {
    const failure = settingsQuery.error ?? recentRepositoriesQuery.error
    if (failure) setError(readableError(failure))
  }, [settingsQuery.error, recentRepositoriesQuery.error])

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
    settingsMutation
      .mutateAsync({ patch: { legacyShortcutImport: legacy } })
      .then(() => {
        clearLegacyShortcuts()
      })
      .catch(() => {
        // A migration that could not be written is left undone rather than
        // marked done, so the stored copy is kept for the next window.
        legacyImportOffered.current = false
      })
  }, [desktop, settings, settingsMutation.mutateAsync])

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
      // Resetting the gate before awaiting retires every in-flight refresh, so
      // a snapshot taken from the previous repository cannot land here.
      repositoryGate.reset()
      const claim = repositoryGate.claim()
      openingRef.current = claim
      return repositoryOpenMutation.mutateAsync({ path, mode, landing, claim })
    },
    [desktop, repositoryGate, repositoryOpenMutation.mutateAsync],
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
      // The host this read is for, taken as it stands when the read is asked
      // for: the rows it produces belong to that host, and a later change of host
      // has to retire them for that host and no other.
      const inboxRowsHost = notificationHostRef.current
      const key = inboxKeyRef.current
      setInboxError(null)
      try {
        await queryClient.cancelQueries({ queryKey: key, exact: true })
        await queryClient.fetchQuery({
          queryKey: key,
          staleTime: 0,
          queryFn: async () => {
            const report = await desktop.pullRequestInbox?.(request)
            if (!inboxGate.current(claim)) throw new CancelledError()
            inboxRowsHostRef.current = inboxRowsHost
            return report ?? null
          },
        })
      } catch (value) {
        if (!inboxGate.current(claim) || value instanceof CancelledError) return
        // A read that could not answer is reported, never emptied: the last
        // confirmed rows stay on screen behind the reason.
        setInboxError(readableError(value))
      }
    },
    [desktop, inboxGate, queryClient],
  )

  // Leaves the Inbox: ends the read the destination started, so the main process
  // stops spending its request budget on repositories nobody is looking at, and
  // retires the answer so it cannot repaint the destination when it lands.
  const leaveInbox = React.useCallback(() => {
    inboxGate.reset()
    void queryClient.cancelQueries({ queryKey: inboxKeyRef.current, exact: true })
    void desktop?.cancel?.(INBOX_REQUEST_ID)?.catch(() => undefined)
  }, [desktop, inboxGate, queryClient])

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
      try {
        await filtersMutation.mutateAsync(drafts)
      } catch (value) {
        setInboxError(readableError(value))
      } finally {
        savingInboxFiltersRef.current = false
      }
    },
    [desktop, filtersMutation.mutateAsync],
  )

  const isBusy = Boolean(busyAction || opening || refreshing)
  const operationActive = Boolean(snapshot?.operation || snapshot?.stackOperation)

  const openGitRuntime = React.useCallback(() => {
    if (!desktop || isBusy || operationActive) return
    setGitRuntimeOpen(true)
    void gitRuntimeQuery.refetch().then((result) => {
      if (result.error) setError(readableError(result.error))
    })
  }, [desktop, isBusy, operationActive, gitRuntimeQuery.refetch])

  const selectGitRuntime = React.useCallback(
    async (useSystemGit: boolean) => {
      if (!desktop || isBusy || operationActive) return
      try {
        await runtimeMutation.mutateAsync(useSystemGit)
      } catch (value) {
        setError(readableError(value))
      }
    },
    [desktop, isBusy, operationActive, runtimeMutation.mutateAsync],
  )

  // Main resolves the editor from settings and checks the path is inside the
  // open repository, so the window sends only a path it is already showing.
  const editorMutation = useMutation({
    mutationFn: (relativePath: string) => desktop!.openInEditor!(relativePath),
  })
  const openInEditor = React.useCallback(
    async (relativePath: string) => {
      if (!desktop?.openInEditor) return
      try {
        const result = await editorMutation.mutateAsync(relativePath)
        setNotice(result.reason)
      } catch (value) {
        setError(readableError(value))
      }
    },
    [desktop, editorMutation.mutateAsync],
  )

  // The identity the rows on screen belong to: the host this window reads for
  // AND the CLI account behind it. The host is part of it because switching from
  // github.com to an enterprise host changes whose pull requests these are even
  // when the CLI status is byte-for-byte unchanged.
  const inboxHostRef = React.useRef<string | null>(null)
  /**
   * The host the rows on screen were read for, which is not the same thing as
   * the host this window has seen a status for: a queue can be read and on
   * screen while this host's own CLI status is still outstanding, and naming the
   * host from a read rather than from a status is what lets a host change retire
   * those rows even when no status has answered for either host yet.
   */
  const inboxRowsHostRef = React.useRef<string | null>(null)
  /**
   * Everything this window holds that GitHub answered belongs to the authority
   * that asked, so one retirement covers all of it and runs for whichever
   * change replaced that authority — a new account, a new credential, or a new
   * host.
   *
   * The reads still running for the retired authority are ended with their
   * gates, and the flags those reads own go with them: a result this window
   * has already refused must not leave local work disabled while it waits.
   * What they had produced is dropped rather than repainted under a new
   * account — the queue, and in the repository the pull request each branch
   * carries with its checks and its links, which are read per branch rather
   * than on the list. Local Git is untouched: the repository, its branches,
   * the working tree, and everything already checked out all stay, and the
   * next refresh fills the rest in as the account in effect.
   */
  const retireGitHubAuthority = React.useCallback(() => {
    leaveInbox()
    queryClient.setQueryData(inboxKeyRef.current, null)
    setInboxError(null)
    repositoryGate.reset()
    // Keep an outstanding local switch locked until its completion is adopted.
    // Its gate is stale, so only the returned local Git facts can land.
    const previousKey = repositoryKeyRef.current
    void queryClient.cancelQueries({ queryKey: previousKey, exact: true })
    const current = queryClient.getQueryData<RepositorySnapshot | null>(previousKey)
    const nextKey = ['repository-snapshot', previousKey[1], previousKey[2] + 1] as const
    const retired = current ? withoutReplacedCredential(current) : null
    queryClient.setQueryData(nextKey, retired)
    repositoryKeyRef.current = nextKey
    setRepositoryIdentity({ path: nextKey[1], generation: nextKey[2], snapshot: retired })
    setReviewNumber(null)
  }, [leaveInbox, queryClient, repositoryGate])

  const retireInboxIdentity = React.useCallback(
    (status: GitHubCliStatus | null, host: string) => {
      // The host is the first half of the identity, so it retires on its own and
      // before any account field is folded in. Rows read for the previous host
      // cannot stay on screen under new settings while the CLI status is still
      // pending, has failed, or is byte-for-byte the same; and with no status
      // yet, leaving the previous rows keyed to the old host would let a later
      // first adoption pass them through.
      //
      // What decides the change is the host the rows on screen were read for,
      // not the host a status has been seen for. A window can hold one host's
      // queue while that host's own status is still outstanding, so a host
      // change during that window retires those rows on the host change alone —
      // waiting for a status would leave the previous host's pull requests on
      // screen under the new host's name for as long as the read takes.
      const rowsHost = inboxRowsHostRef.current
      const hostChanged =
        rowsHost !== null && canonicalHostName(rowsHost) !== canonicalHostName(host)
      if (hostChanged || (inboxHostRef.current !== null && inboxHostRef.current !== host)) {
        retireGitHubAuthority()
        inboxRowsHostRef.current = null
        inboxIdentityRef.current = null
        // The status on screen answered for the host just left. It is replaced
        // by the host now selected, still reading, so nothing on screen — not
        // the queue, not the checks, not the commands Settings offers — can be
        // read as this host's answer before its own read lands.
        setCliStatus(cliCheckingStatus(host))
      }
      inboxHostRef.current = host
      if (!status) return
      // `identity` is the opaque generation the main process stamped on the
      // host, account, and credential this status belongs to. It changes when
      // one of those is actually replaced and holds across equivalent
      // refreshes, which is what makes it the right half of this fence: a
      // swapped or revoked session retires the rows, and a re-read of the same
      // session does not.
      const identity = cliAuthority(host, status)
      if (inboxIdentityRef.current !== null && inboxIdentityRef.current !== identity) {
        retireGitHubAuthority()
      }
      inboxIdentityRef.current = identity
    },
    [retireGitHubAuthority, setCliStatus],
  )

  /**
   * A status is applied only when it is about the host this window is reading
   * for. A push that arrives after the host changed describes the host that was
   * left, and its answer would be the previous host's rows under this one's
   * name.
   */
  const applyCliStatus = React.useCallback(
    (status: GitHubCliStatus) => {
      const host = inboxHostRef.current ?? status.host
      if (canonicalHostName(status.host) !== canonicalHostName(host)) return
      retireInboxIdentity(status, host)
      setCliStatus(status)
    },
    [retireInboxIdentity, setCliStatus],
  )

  // A real read of what the CLI is doing. The main process runs the bounded,
  // host-scoped probes and answers with sanitized facts; nothing here installs a
  // tool, starts a login, switches an account, or signs out.
  //
  // The counter is retired by anything that makes the answer it is waiting for
  // obsolete — a pushed status that supersedes it, or a host change — so a slow
  // read of the previous account, host, or credential can never land over the
  // one now in effect.
  const readCliStatus = React.useCallback(async () => {
    if (!desktop?.githubCliStatus) return
    const request = ++cliStatusRequest.current
    try {
      const key = cliKeyRef.current
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      const status = await queryClient.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: async () => {
          const next = await desktop.githubCliStatus!()
          if (
            request !== cliStatusRequest.current ||
            (inboxHostRef.current !== null &&
              canonicalHostName(next.host) !== canonicalHostName(inboxHostRef.current))
          ) {
            throw new CancelledError()
          }
          return next
        },
      })
      if (request === cliStatusRequest.current) applyCliStatus(status)
    } catch (value) {
      if (request === cliStatusRequest.current && !(value instanceof CancelledError))
        setError(readableError(value))
    }
  }, [applyCliStatus, desktop, queryClient])

  const openCliStatus = React.useCallback(() => {
    if (!desktop || isBusy || operationActive) return
    setCliStatusOpen(true)
    void readCliStatus()
  }, [desktop, isBusy, operationActive, readCliStatus])

  // The host this window reads for is part of the identity, so a change to it
  // retires what the previous host answered — its queue, its repository's
  // GitHub fields, the review and checks read under its credential — even when
  // no status event arrives to report the switch, and the new host is then read
  // for itself. What is on screen is never the previous host's answer under the
  // new name.
  React.useEffect(() => {
    const host = settings?.github.host ?? null
    if (host === null) return
    const established = canonicalHostName(host)
    const previous = cliStatusHost.current
    // The same host arriving again, with the settings object that named it
    // replaced, established nothing and retires nothing.
    if (previous === established) return
    cliStatusHost.current = established
    if (previous === null) {
      // The first settings answer can move the observer from the startup host.
      // Read that key explicitly if the mount probe has not established it.
      if (!queryClient.getQueryData(cliKeyRef.current)) void readCliStatus()
      return
    }
    cliStatusRequest.current += 1
    retireInboxIdentity(null, host)
    void readCliStatus()
  }, [queryClient, readCliStatus, retireInboxIdentity, settings?.github.host])

  // The CLI session changes outside this window — a sign-in, a switch, a logout,
  // a revocation — so the status is pushed rather than polled, and the first
  // read is asked once on mount. A push is newer than any read still running,
  // so it retires them rather than racing them.
  React.useEffect(() => {
    if (!desktop) return
    const stop = desktop.onGitHubCliStatus?.((status) => {
      cliStatusRequest.current += 1
      applyCliStatus(status)
    })
    void readCliStatus()
    return stop
  }, [applyCliStatus, desktop, readCliStatus])

  /**
   * The one authority value every GitHub-fed surface is fenced by: the host
   * this window reads for, with the state, account, and opaque credential
   * generation behind the status on screen. A replacement retires this window's
   * own rows and, with the same value, the review workspace, the checks panel,
   * and anything discovery found — so those surfaces cannot keep showing one
   * session while the rest of the window shows another.
   */
  const authority = React.useMemo(
    () => cliAuthority(settings?.github.host ?? null, cliStatus),
    [cliStatus, settings?.github.host],
  )

  // The optional Notification Center. Its own state, its own request counter,
  // and two separate errors: a failed read must not report itself as a failed
  // repository operation, must not borrow the sign-in's panel, and a write that
  // GitHub refused must stay on the inbox even while the credential dialog is
  // closed over it.
  // Credential handoff is deliberately outside mutation storage.
  const [credentialBusy, setCredentialBusy] = React.useState(false)
  const notificationLock = React.useRef(false)
  /** Belongs to the consent dialog, and is dismissed with it. */
  const [notificationDialogError, setNotificationDialogError] = React.useState<string | null>(null)
  /** Belongs to the inbox, and is only cleared by answering it with a new action. */
  const [notificationActionError, setNotificationActionError] = React.useState<string | null>(null)
  const notificationRequest = React.useRef(0)

  /**
   * The host this window's notification state is allowed to be about. It is the
   * host the settings say this installation works against, canonicalized the
   * same way every other boundary canonicalizes a host, because the center main
   * publishes belongs to the selected one and an answer for another host is
   * another host's inbox rather than a slower version of this one. `null` means
   * nothing authoritative has been established yet, and claims nothing.
   */
  const notificationHost = settings ? canonicalHostName(settings.github.host) : null
  /** The same host, for continuations that outlive the render that started them. */
  const notificationHostRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    notificationHostRef.current = notificationHost
  }, [notificationHost])
  const notificationKey = React.useMemo(
    () => ['notification-inbox', notificationHost] as const,
    [notificationHost],
  )
  const notificationKeyRef = React.useRef(notificationKey)
  notificationKeyRef.current = notificationKey
  const notificationQuery = useQuery<NotificationInbox | null>({
    queryKey: notificationKey,
    enabled: false,
  })
  const notificationInbox = notificationQuery.data ?? null
  const setNotificationInbox = React.useCallback(
    (next: NotificationInbox | null) => {
      const key = notificationKeyRef.current
      void queryClient.cancelQueries({ queryKey: key, exact: true })
      queryClient.setQueryData(key, next)
    },
    [queryClient],
  )

  /**
   * Whether a reply still belongs to the window that asked for it.
   *
   * The counter refuses a reply that a newer request has already superseded;
   * the host refuses the ones a host change superseded, which no counter inside
   * this window would notice on its own — a settings change is not something
   * this window's own actions did.
   */
  const notificationClaim = React.useCallback(
    (request: number, host: string | null): boolean =>
      request === notificationRequest.current &&
      (host === null || host === notificationHostRef.current),
    [],
  )

  // The poll pushes the inbox; this only asks for what is already known, so
  // opening the view never turns into a read GitHub did not ask for. A change
  // of host re-runs the whole thing: the previous host's rows, its errors, and
  // a dialog opened for it are that host's private state, and the host now
  // selected is read from what main already stored rather than by asking GitHub
  // for anything on the strength of a settings change.
  React.useEffect(() => {
    if (!desktop) return
    const host = notificationHost
    const request = ++notificationRequest.current
    const stop = desktop.onNotifications?.((value) => {
      if (inboxForHost(value, notificationHostRef.current)) setNotificationInbox(value)
    })
    setNotificationInbox(null)
    setNotificationActionError(null)
    setCredentialBusy(false)
    notificationLock.current = false
    setNotificationDialogOpen(false)
    setNotificationDialogError(null)
    void queryClient
      .fetchQuery({
        queryKey: notificationKey,
        staleTime: 0,
        queryFn: async () => {
          const value = await desktop.notifications?.()
          if (!notificationClaim(request, host) || (value && !inboxForHost(value, host))) {
            throw new CancelledError()
          }
          return value ?? null
        },
      })
      .catch(() => undefined)
    return stop
  }, [
    desktop,
    notificationClaim,
    notificationHost,
    notificationKey,
    queryClient,
    setNotificationInbox,
  ])

  /**
   * One notification call at a time. The bridge method is looked up rather than
   * assumed, so a window talking to an older main process reports the missing
   * capability instead of dereferencing `undefined` inside a render.
   */
  const notificationCall = React.useCallback(
    <T,>(method: keyof DesktopAPI, ...args: unknown[]): Promise<T> => {
      const call = desktop?.[method] as ((...values: unknown[]) => Promise<T>) | undefined
      if (typeof call !== 'function') {
        return Promise.reject(new Error('This build of Git Stacks cannot read notifications.'))
      }
      return call(...args)
    },
    [desktop],
  )

  const notificationMutation = useMutation({
    mutationFn: async (operation: NotificationOperation) => {
      switch (operation.kind) {
        case 'read':
          return notificationCall<NotificationInbox>('markNotificationRead', operation.id)
        case 'done':
          return notificationCall<NotificationInbox>('markNotificationDone', operation.id)
        case 'subscribe':
          return notificationCall<NotificationInbox>(
            'setNotificationSubscription',
            operation.id,
            operation.action,
          )
        case 'removeCredential':
          await notificationCall('removeNotificationCredential')
          return notificationCall<NotificationInbox>('notifications')
      }
    },
  })
  const notificationBusy =
    credentialBusy || notificationMutation.isPending || notificationQuery.isFetching
  const runNotification = React.useCallback(
    async (operation: NotificationOperation | { kind: 'refresh' }) => {
      if (!desktop || notificationLock.current) return
      notificationLock.current = true
      const request = ++notificationRequest.current
      const host = notificationHostRef.current
      setNotificationActionError(null)
      try {
        const next =
          operation.kind === 'refresh'
            ? await queryClient.fetchQuery({
                queryKey: notificationKeyRef.current,
                staleTime: 0,
                queryFn: async () => {
                  const value = await notificationCall<NotificationInbox>('refreshNotifications')
                  if (!notificationClaim(request, host) || !inboxForHost(value, host)) {
                    throw new CancelledError()
                  }
                  return value
                },
              })
            : await notificationMutation.mutateAsync(operation)
        if (notificationClaim(request, host) && inboxForHost(next, host)) setNotificationInbox(next)
      } catch (value) {
        if (notificationClaim(request, host) && !(value instanceof CancelledError))
          setNotificationActionError(unknownOutcomeError(readableError(value)))
      } finally {
        if (notificationClaim(request, host)) notificationLock.current = false
      }
    },
    [
      desktop,
      notificationCall,
      notificationClaim,
      notificationMutation.mutateAsync,
      queryClient,
      setNotificationInbox,
    ],
  )

  /**
   * Consent first, then the credential. Both steps go through the boundary that
   * owns them: the setting main validates and policy can refuse, and the token
   * is handed over once, together with the acknowledgement the consent text
   * asked for, and never read back.
   */
  const readNotificationSnapshot = React.useCallback(
    (request: number, host: string | null) =>
      queryClient.fetchQuery({
        queryKey: notificationKeyRef.current,
        staleTime: 0,
        queryFn: async () => {
          const value = await notificationCall<NotificationInbox>('notifications')
          if (!notificationClaim(request, host) || !inboxForHost(value, host)) {
            throw new CancelledError()
          }
          return value
        },
      }),
    [notificationCall, notificationClaim, queryClient],
  )
  const saveNotificationCredential = React.useCallback(
    async (token: string, accepted: boolean, consentedHost: string) => {
      if (!desktop || notificationLock.current) return
      notificationLock.current = true
      const request = ++notificationRequest.current
      const host = canonicalHostName(consentedHost)
      setCredentialBusy(true)
      setNotificationDialogError(null)
      // The token was typed against the host this dialog named and the
      // acknowledgement was given for it, so the host travels with it and every
      // step re-asks whether that is still the host this window is pointed at.
      // If the host or dialog changed during any step, this continuation drops
      // silently without polluting the current dialog with stale errors: a step
      // already in flight cannot be called back, which is why the check sits
      // between the steps and why main validates the same host again.
      try {
        await settingsMutation.mutateAsync({
          patch: { notifications: { enabled: true } },
          notificationOwner: { request, host },
        })
        if (!notificationClaim(request, host)) return
        await notificationCall('saveNotificationCredential', token, accepted, consentedHost)
        if (!notificationClaim(request, host)) return
        const next = await readNotificationSnapshot(request, host)
        if (notificationClaim(request, host) && inboxForHost(next, host)) {
          setNotificationInbox(next)
          setNotificationDialogOpen(false)
        }
      } catch (value) {
        if (notificationClaim(request, host) && !(value instanceof CancelledError))
          setNotificationDialogError(readableError(value))
      } finally {
        if (notificationClaim(request, host)) {
          notificationLock.current = false
          setCredentialBusy(false)
        }
      }
    },
    [
      desktop,
      notificationCall,
      notificationClaim,
      readNotificationSnapshot,
      setNotificationInbox,
      settingsMutation.mutateAsync,
    ],
  )

  const removeNotificationCredential = React.useCallback(() => {
    void runNotification({ kind: 'removeCredential' })
  }, [runNotification])

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
        const next = await queryClient.fetchQuery({
          queryKey: ['repository-snapshot', result.path, repositoryKeyRef.current[2]],
          staleTime: 0,
          queryFn: async () => {
            const value = await desktop!.refresh()
            if (!repositoryGate.current(claim)) throw new CancelledError()
            return value
          },
        })
        if (next && repositoryGate.current(claim)) {
          setSnapshotAndSelection(next)
          setWorkspaceView('branches')
        }
        await recentRepositoriesQuery.refetch()
        setNotice(
          result.empty
            ? `Cloned ${result.name}. It has no commits yet — create a branch to add the first one.`
            : `Cloned ${result.name} into ${result.path}.`,
        )
      } catch (value) {
        if (repositoryGate.current(claim) && !(value instanceof CancelledError))
          setError(readableError(value))
      }
    },
    [
      desktop,
      queryClient,
      repositoryGate,
      setSnapshotAndSelection,
      recentRepositoriesQuery.refetch,
    ],
  )

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

  const cliLabel = CLI_LABELS[cliStatus?.state ?? 'checking']
  const cliConnected = cliStatus?.state === 'authenticated'
  /**
   * What a dialog opens on. The form re-reads `defaultValues` on every render,
   * so the seed and `reset` are always written together: a seed alone is
   * dropped once a field has been touched, and a reset alone is replaced by the
   * literal defaults on the next render.
   */
  const [newBranchDefaults, setNewBranchDefaults] = React.useState({ name: '', parent: '' })
  const newBranchForm = useForm({
    defaultValues: newBranchDefaults,
    validators: {
      onSubmit: ({ value }) => {
        const name = value.name.trim()
        const fields: { name?: string; parent?: string } = {}
        if (!name) fields.name = 'Enter a branch name.'
        if (!value.parent.trim()) fields.parent = 'Choose a parent branch.'
        if (name && snapshot?.branches.some((branch) => branch.name === name)) {
          fields.name = 'A branch with that name already exists.'
        }
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const name = value.name.trim()
      const success = await runAction(
        { type: 'createBranch', name, parent: value.parent.trim() },
        'Create branch',
      )
      if (success) {
        setSelectedBranchRef(`refs/heads/${name}`)
        setNewBranchOpen(false)
      }
    },
  })
  const newBranchName = useSelector(newBranchForm.store, (state) => state.values.name)
  const newBranchParent = useSelector(newBranchForm.store, (state) => state.values.parent)
  const newBranchDirty = useSelector(newBranchForm.store, (state) => state.isDirty)
  const newBranchSubmitting = useSelector(newBranchForm.store, (state) => state.isSubmitting)
  const newBranchError = useSelector(newBranchForm.store, (state) =>
    firstFieldMessage(state.fieldMeta.name?.errors, state.fieldMeta.parent?.errors, state.errors),
  )

  const [prDefaults, setPrDefaults] = React.useState({
    title: '',
    base: '',
    body: '',
    draft: false,
  })
  const prForm = useForm({
    defaultValues: prDefaults,
    validators: {
      onSubmit: ({ value }) => {
        const fields: { title?: string; base?: string } = {}
        if (!value.title.trim()) fields.title = 'Enter a pull request title.'
        if (!value.base.trim()) fields.base = 'Choose a base branch.'
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const success = await runAction(
        {
          type: 'createPr',
          title: value.title.trim(),
          body: value.body,
          base: value.base.trim(),
          draft: value.draft,
        },
        'Create pull request',
      )
      if (success) setPrOpen(false)
    },
  })
  const prBase = useSelector(prForm.store, (state) => state.values.base)
  const prDirty = useSelector(prForm.store, (state) => state.isDirty)
  const prSubmitting = useSelector(prForm.store, (state) => state.isSubmitting)
  const prError = useSelector(prForm.store, (state) =>
    firstFieldMessage(state.fieldMeta.title?.errors, state.fieldMeta.base?.errors, state.errors),
  )

  const deleteForm = useForm({
    defaultValues: { force: false },
    validators: {
      onSubmit: () => {
        const target = deleteTarget
        if (!target) return undefined
        if (snapshot?.path !== target.repoPath) {
          return 'The repository changed. Close this dialog and select the branch again.'
        }
        if (target.branches.length === 0 || target.branches.some((branch) => !branch.oid)) {
          return 'A branch tip is unknown. Close this dialog and select the branches again.'
        }
        return undefined
      },
    },
    onSubmit: async ({ value }) => {
      const target = deleteTarget
      if (!target || target.branches.length === 0) return
      const branches = target.branches.map((branch) => ({
        ref: branch.ref,
        expectedOid: branch.oid!,
      }))
      const remote = target.branches[0].remote
      const action: GitAction = remote
        ? branches.length === 1
          ? { type: 'deleteRemoteBranch', ...branches[0] }
          : { type: 'deleteRemoteBranches', branches }
        : branches.length === 1
          ? { type: 'deleteBranch', ...branches[0], force: value.force }
          : { type: 'deleteBranches', branches, force: value.force }
      const success = await runAction(
        action,
        `Delete ${remote ? 'remote ' : ''}${branches.length === 1 ? 'branch' : 'branches'}`,
      )
      if (success) {
        setDeleteTarget(null)
        setBranchSelection((current) => (current ? { ...current, refs: new Set<string>() } : null))
      }
    },
  })
  const deleteForce = useSelector(deleteForm.store, (state) => state.values.force)
  const deleteSubmitting = useSelector(deleteForm.store, (state) => state.isSubmitting)
  const deleteBranchError = useSelector(deleteForm.store, (state) =>
    firstFieldMessage(state.errors),
  )

  const commitForm = useForm({
    defaultValues: { message: '', amend: false },
    onSubmit: async ({ value }) => {
      const message = value.message.trim()
      if (!snapshot || !message || (!value.amend && stagedFiles.length === 0)) return
      const action: GitAction = {
        type: 'commit',
        message,
        amend: value.amend,
        expectedHead: snapshot.headOid,
        expectedHeadRef: snapshot.currentBranch ? `refs/heads/${snapshot.currentBranch}` : 'HEAD',
      }
      if (value.amend) {
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
    },
  })
  const commitMessage = useSelector(commitForm.store, (state) => state.values.message)
  const commitAmend = useSelector(commitForm.store, (state) => state.values.amend)

  const runAction = React.useCallback(
    async (action: GitAction, label: string): Promise<boolean> => {
      if (!desktop || !snapshot || busyRef.current) return false
      busyRef.current = label
      return actionMutation.mutateAsync({ action, label })
    },
    [actionMutation.mutateAsync, desktop, snapshot],
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

  // `selectedBranch` is already derived from the snapshot, so a missing
  // snapshot can only produce a missing branch: this is the branch's own pull
  // request, not a second lookup.
  const selectedPullRequest = selectedBranch?.pr ?? null
  const issueLinksQuery = useQuery({
    queryKey: [
      'pull-request-issue-links',
      snapshot?.path ?? null,
      authority,
      selectedPullRequest?.number ?? null,
    ],
    queryFn: async () => {
      const result = await desktop!.pullRequestIssueLinks?.(selectedPullRequest!.number)
      return result?.links ?? []
    },
    enabled: false,
  })
  const selectedPrIssueLinks = issueLinksQuery.data ?? []
  const selectedPrIssueLinksLoading = issueLinksQuery.isFetching
  React.useEffect(() => {
    if (!desktop || !selectedPullRequest) return
    const key = [
      'pull-request-issue-links',
      snapshot?.path ?? null,
      authority,
      selectedPullRequest.number,
    ]
    void queryClient.cancelQueries({ queryKey: key, exact: true })
    void issueLinksQuery.refetch()
    return () => {
      void queryClient.cancelQueries({ queryKey: key, exact: true })
    }
  }, [
    authority,
    desktop,
    issueLinksQuery.refetch,
    queryClient,
    selectedPullRequest?.number,
    snapshot,
  ])

  // The checks report is per pull request and carries its own freshness, so it is
  // never folded into the repository snapshot: a remembered report has to be able to
  // say it was not re-read without making the whole snapshot look stale.
  const [checksWatching, setChecksWatching] = React.useState(false)
  const checksGate = React.useRef(createRequestGate()).current
  const checksNumber = selectedPullRequest?.number ?? null
  const checksRepository = snapshot?.path ?? null
  const checksPr = snapshot?.pullRequests.find((pr) => pr.number === checksNumber)
  const checksKey = React.useMemo(
    () =>
      [
        'pull-request-checks',
        checksRepository,
        authority,
        checksNumber,
        checksPr?.headOid ?? null,
        checksPr?.base ?? null,
      ] as const,
    [checksRepository, authority, checksNumber, checksPr?.headOid, checksPr?.base],
  )
  const checksQuery = useQuery<PullRequestChecksReport | null>({
    queryKey: checksKey,
    enabled: false,
  })
  const checksReport = checksQuery.data ?? null
  const checksLoading = checksQuery.isFetching
  const rerunMutation = useMutation({
    mutationFn: (runId: number) => desktop!.rerunPullRequestCheck!(checksNumber ?? 0, runId),
  })
  const rerunningRunId = rerunMutation.isPending ? (rerunMutation.variables ?? null) : null
  const rerunLock = React.useRef(false)

  const loadChecks = React.useCallback(
    async (number: number, force: boolean): Promise<void> => {
      if (!desktop?.pullRequestChecks) return
      const claim = checksGate.claim()
      try {
        await queryClient.cancelQueries({ queryKey: checksKey, exact: true })
        await queryClient.fetchQuery({
          queryKey: checksKey,
          staleTime: 0,
          queryFn: async () => {
            const report = await desktop.pullRequestChecks!(number, {
              headSha: checksKey[4],
              base: checksKey[5],
              force,
            })
            if (!checksGate.current(claim)) throw new CancelledError()
            return report
          },
        })
      } catch (value) {
        if (checksGate.current(claim) && !(value instanceof CancelledError))
          setError(readableError(value))
      }
    },
    [checksGate, checksKey, desktop, queryClient],
  )

  // Changing what is selected retires the previous report: a checks drill-down for
  // one pull request must never be read as the state of another. A replaced
  // authority retires it explicitly rather than waiting for the selected pull
  // request number to change, because the same number can describe a different
  // account's pull request entirely.
  React.useEffect(() => {
    checksGate.reset()
    void queryClient.cancelQueries({ queryKey: checksKey, exact: true })
    queryClient.setQueryData(checksKey, null)
  }, [checksGate, checksKey, queryClient])
  React.useEffect(() => {
    setChecksWatching(false)
  }, [authority, checksNumber, checksRepository])

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
      if (!desktop?.rerunPullRequestCheck || check.workflowRunId === null || rerunLock.current)
        return
      rerunLock.current = true
      const claim = checksGate.claim()
      try {
        await queryClient.cancelQueries({ queryKey: checksKey, exact: true })
        const report = await rerunMutation.mutateAsync(check.workflowRunId)
        if (checksGate.current(claim)) queryClient.setQueryData(checksKey, report)
      } catch (value) {
        if (checksGate.current(claim)) setError(readableError(value))
      } finally {
        rerunLock.current = false
      }
    },
    [checksGate, checksKey, desktop, queryClient, rerunMutation.mutateAsync],
  )

  const externalMutation = useMutation({
    mutationFn: (url: string) => desktop!.openExternal(url),
  })
  const openExternal = React.useCallback(
    (url: string) => {
      if (!desktop) return
      void externalMutation.mutateAsync(url).catch((value) => setError(readableError(value)))
    },
    [desktop, externalMutation.mutateAsync],
  )
  const openCheckDetails = React.useCallback(
    (url: string): void => {
      openExternal(url)
    },
    [openExternal],
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
  const branchRows = useRovingListFocus(branchWindow, '[role="treeitem"]')

  const changeState = React.useMemo(
    () => changeGroups(snapshot?.files ?? [], search),
    [snapshot, search],
  )
  const visiblePullRequests = React.useMemo(
    () => (snapshot?.pullRequests ?? []).filter((pr) => matchesPullRequest(pr, search)),
    [search, snapshot],
  )
  const stagedFiles = changeState.staged
  const currentBranch = snapshot?.currentBranch ?? null
  const allBranches = snapshot?.branches ?? []
  const branchCount = combinedBranches.length
  const pullRequestCount = snapshot?.pullRequests.length ?? 0
  const stashCount = snapshot?.stashes.length ?? 0
  const capabilityAttention = React.useMemo(
    () => (snapshot ? capabilityAttentionCount(capabilityReport(snapshot.capabilities)) : 0),
    [snapshot],
  )
  const detailsVisible = showDetails && workspaceView === 'branches'
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
  let deleteChildCount = 0
  if (deleteTarget && !deletingRemote) {
    const deletedRefs = new Set<string>()
    for (const target of deleteTarget.branches) deletedRefs.add(target.ref)
    for (const branch of allBranches) {
      if (branch.remote || !branch.parent) continue
      const parent = branchByName.get(branch.parent)
      if (parent && deletedRefs.has(parent.ref)) deleteChildCount += 1
    }
  }

  const openBranchDialog = React.useCallback(() => {
    if (!snapshot) return
    const defaults = {
      name: '',
      parent: snapshot.currentBranch ?? snapshot.defaultBranch ?? snapshot.branches[0]?.name ?? '',
    }
    setNewBranchDefaults(defaults)
    newBranchForm.reset(defaults)
    setNewBranchNotice(null)
    setNewBranchOpen(true)
  }, [newBranchForm, snapshot])

  const openPrDialog = React.useCallback(
    (branchOverride?: Branch) => {
      const targetBranch = branchOverride ?? selectedBranch
      if (!snapshot || !targetBranch?.current || targetBranch.remote) return
      if (branchOverride) {
        setSelectedBranchRef(branchOverride.ref)
      }
      const defaults = {
        title: targetBranch.subject || `Open ${targetBranch.name}`,
        base: targetBranch.parent ?? snapshot.defaultBranch,
        body: '',
        draft: false,
      }
      setPrDefaults(defaults)
      prForm.reset(defaults)
      setPrNotice(null)
      setPrOpen(true)
    },
    [prForm, selectedBranch, setSelectedBranchRef, snapshot],
  )

  const selectedDeleteBranches =
    branchSelection && branchSelection.repoPath === snapshot?.path
      ? allBranches.filter((branch) => branchSelection.refs.has(branch.ref))
      : []
  const selectedRemote = selectedDeleteBranches[0]?.remote
  const selectingRemote =
    selectedRemote ??
    (branchFilter === 'remote' ||
      !branchWindow.visible.some(
        (branch) => !branch.remote && !branchDeleteReason(branch, snapshot?.defaultBranch ?? null),
      ))
  const selectionActionType = selectingRemote ? 'deleteRemoteBranches' : 'deleteBranches'
  const branchSelectionReason = (branch: Branch) =>
    branchDeleteReason(branch, snapshot?.defaultBranch ?? null) ??
    (selectedRemote !== undefined && branch.remote !== selectedRemote
      ? 'Clear the selection before switching between local and remote deletion.'
      : null)
  const selectableVisibleBranches = branchWindow.visible.filter(
    (branch) =>
      branch.remote === selectingRemote &&
      !branchDeleteReason(branch, snapshot?.defaultBranch ?? null),
  )
  const selectedVisibleCount = selectableVisibleBranches.reduce(
    (count, branch) => count + (branchSelection?.refs.has(branch.ref) ? 1 : 0),
    0,
  )
  const toggleBranchSelection = (branch: Branch) => {
    if (!snapshot || isBusy || operationActive || branchSelectionReason(branch)) return
    setBranchSelection((current) => {
      const refs = new Set(current?.repoPath === snapshot.path ? current.refs : [])
      if (refs.has(branch.ref)) refs.delete(branch.ref)
      else refs.add(branch.ref)
      return { repoPath: snapshot.path, refs }
    })
  }
  const openDeleteDialog = (branches: Branch[] = selectedBranch ? [selectedBranch] : []) => {
    if (
      !snapshot ||
      branches.length === 0 ||
      branches.some(
        (branch) =>
          branch.remote !== branches[0].remote ||
          branchDeleteReason(branch, snapshot.defaultBranch),
      ) ||
      isBusy ||
      operationActive ||
      shapeReason(
        branches[0].remote
          ? branches.length === 1
            ? 'deleteRemoteBranch'
            : 'deleteRemoteBranches'
          : branches.length === 1
            ? 'deleteBranch'
            : 'deleteBranches',
      )
    )
      return
    deleteOpenerRef.current = document.activeElement as HTMLElement | null
    setDeleteTarget({ branches, repoPath: snapshot.path })
    deleteForm.reset()
    setDeleteCloseNotice(null)
    setActionError(null)
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
            openExternal(intent.url)
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
      openExternal,
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
      for (const [shortcut, command] of REVIEW_COMMANDS) {
        if (!matchesChord(event, shortcutBindings[shortcut], isMac)) continue
        event.preventDefault()
        if (workspaceView === 'review') reviewCommands.current?.[command]()
        return
      }

      // Stack navigation commands, one binding per relation so a new relation
      // cannot ship without a keyboard route.
      for (const [shortcut, relation] of STACK_NAVIGATION_SHORTCUTS) {
        if (!matchesChord(event, shortcutBindings[shortcut], isMac)) continue
        event.preventDefault()
        if (snapshot) {
          const target = resolveStackNavigation(selectedBranch, snapshot.branches, relation)
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
          openExternal(selectedBranch.pr.url)
        } else if (selectedBranch?.current && snapshot?.github.available && !isBusy) {
          openPrDialog()
        }
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    // Every modal flag is listed because each one opens `anyModalOpen`, and the
    // handler must stop claiming chords the moment a dialog takes the window.
    checkoutGuardTarget,
    deleteTarget,
    desktop,
    isBusy,
    isMac,
    newBranchOpen,
    openExternal,
    openPrDialog,
    openWorkflow,
    operationActive,
    prOpen,
    requestCheckoutBranch,
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
          variant="ghost"
        >
          <FolderOpen className="size-4" />
        </IconButton>
      </div>

      <div className="sidebar-scroll">
        <div className="nav-section">
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
          <details className="nav-section nav-section-bordered sidebar-disclosure">
            <summary>Repository info</summary>
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
          </details>
        ) : null}

        <div className="nav-section nav-section-bordered recent-section">
          <div className="nav-label-row">
            <span className="nav-label">Recent repositories</span>
            <IconButton
              label="Open a repository"
              onClick={() => openRepository()}
              disabled={isBusy}
              variant="ghost"
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
                <Button
                  className="recent-item"
                  aria-current={repository.path === snapshot?.path ? 'true' : undefined}
                  disabled={isBusy}
                  key={repository.path}
                  onClick={() => openRepository(repository.path)}
                  type="button"
                  variant="unstyled"
                >
                  <FolderOpen className="size-3.5" />
                  <span>
                    <strong>{repository.name}</strong>
                    <small title={repository.path}>{repository.path}</small>
                  </span>
                </Button>
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
              cliConnected ? 'connection-dot-live' : 'connection-dot-offline',
            )}
          />
          <Button
            className="version-label version-label-action"
            disabled={!desktop || isBusy || operationActive}
            onClick={openCliStatus}
            title="GitHub CLI status"
            type="button"
            variant="unstyled"
          >
            {cliLabel}
          </Button>
        </div>
        <div className="sidebar-footer-actions">
          <Button
            className="version-label version-label-action"
            disabled={!desktop || isBusy || operationActive}
            onClick={openGitRuntime}
            title="Git runtime diagnostics"
            type="button"
            variant="unstyled"
          >
            Git runtime
          </Button>
        </div>
      </div>
    </aside>
  )

  const renderToolbar = () => (
    <div className="toolbar" role="toolbar" aria-label="Repository actions">
      {workspaceView !== 'review' ? (
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
                shapeReason('pull') ??
                'Choose how to integrate updates from this branch’s upstream.'
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
              <DropdownMenu.Trigger
                render={
                  <Button
                    aria-label="More Git actions"
                    tooltip="More actions: preview merge, force push with lease, stash, or browse history."
                    size="icon-sm"
                    variant="secondary"
                    disabled={!snapshot || isBusy}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              />
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="workflow-menu" align="start" sideOffset={6}>
                  <DropdownMenu.Item
                    disabled={operationActive || !currentBranch || Boolean(shapeReason('merge'))}
                    onClick={() => openWorkflow({ kind: 'merge' })}
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
                    onClick={() => openWorkflow({ kind: 'forcePush' })}
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
                    onClick={() => openWorkflow({ kind: 'stash' })}
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
                  <DropdownMenu.Item onClick={() => setWorkspaceView('history')}>
                    Browse commit history
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      ) : null}
      <div className="toolbar-spacer" />
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
          aria-controls={
            showDetails
              ? workspaceView === 'stacks'
                ? 'graph-inspector'
                : 'branch-inspector'
              : undefined
          }
          aria-expanded={showDetails}
          aria-label={showDetails ? 'Hide details pane' : 'Show details pane'}
          className="toolbar-control toolbar-details-toggle"
          onClick={() => setShowDetails((value) => !value)}
          size="sm"
          variant="secondary"
        >
          {showDetails ? (
            <PanelRightClose aria-hidden="true" className="size-4" />
          ) : (
            <PanelRightOpen aria-hidden="true" className="size-4" />
          )}
          Details
        </Button>
      ) : null}
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
          ref={branchRows.containerRef}
          role="tree"
          aria-multiselectable={branchSelectionMode || undefined}
        >
          {branchWindow.visible.map((branch, branchIndex) => {
            const tree = branchTree.rows[branchWindow.start + branchIndex]
            const pullRequest = branch.pr
            const selected = branchSelectionMode
              ? branchSelection.refs.has(branch.ref)
              : branch.ref === selectedBranch?.ref
            const requiresRestack = branch.needsRestack || (branch.parentBehind ?? 0) > 0
            return (
              <BranchHoverCard branch={branch}>
                <div
                  aria-current={branch.ref === selectedBranch?.ref ? 'true' : undefined}
                  aria-description={
                    branchSelectionMode ? (branchSelectionReason(branch) ?? undefined) : undefined
                  }
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
                    if (
                      hit !== event.currentTarget &&
                      hit.closest('a, button, label, [role="button"]')
                    ) {
                      return
                    }
                    if (branchSelectionMode) toggleBranchSelection(branch)
                    else setSelectedBranchRef(branch.ref)
                  }}
                  onFocus={() => branchRows.noteFocus(branchIndex)}
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
                      if (wholeList) branchRows.focusListIndex(target)
                      else branchRows.focusMounted(target)
                      return
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      if (branchSelectionMode) toggleBranchSelection(branch)
                      else setSelectedBranchRef(branch.ref)
                    }
                  }}
                  role="treeitem"
                  style={{ '--branch-depth': tree.depth } as React.CSSProperties}
                  tabIndex={rovingTabIndex(branchIndex, branchRows.activeIndex)}
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
                  {branchSelectionMode ? (
                    <Checkbox
                      aria-label={`Select ${branch.name}`}
                      className="relative z-[2] shrink-0"
                      checked={selected}
                      disabled={isBusy || operationActive || Boolean(branchSelectionReason(branch))}
                      tabIndex={-1}
                      title={branchSelectionReason(branch) ?? `Select ${branch.name} for deletion`}
                      onCheckedChange={() => toggleBranchSelection(branch)}
                    />
                  ) : null}
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
                              openExternal(pullRequest.url)
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
                      <TooltipTrigger
                        render={
                          <span
                            aria-hidden="true"
                            className="ahead-behind relative z-[2] rounded-sm"
                          >
                            <span className={branch.ahead > 0 ? 'metric-positive' : 'metric-muted'}>
                              <ArrowUp className="size-3" />
                              {branch.ahead}
                            </span>
                            <span
                              className={branch.behind > 0 ? 'metric-negative' : 'metric-muted'}
                            >
                              <ArrowDown className="size-3" />
                              {branch.behind}
                            </span>
                          </span>
                        }
                      />
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
        onCommitAmendChange={(amend) => commitForm.setFieldValue('amend', amend)}
        onCommitMessageChange={(message) => commitForm.setFieldValue('message', message)}
        onInspect={(path) => {
          setActionError(null)
          setInspectedPath(path)
        }}
        onOpenInEditor={openInEditor}
        onResolveConflict={openConflictResolver}
        onStash={() => openWorkflow({ kind: 'stash' })}
        onSubmitCommit={() => void commitForm.handleSubmit()}
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
        onCreate={() => openPrDialog()}
        onRequest={openWorkflow}
        onReviewNumber={(number) => {
          setReviewNumber(number)
          setWorkspaceView('review')
        }}
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

  const renderNotifications = () => {
    if (!desktop) return null
    return (
      <NotificationCenterView
        busy={notificationBusy}
        error={notificationActionError}
        inbox={notificationInbox}
        onDismissError={() => setNotificationActionError(null)}
        onMarkAllRead={() => {
          void runNotification({ kind: 'read', id: 'all' })
        }}
        onMarkDone={(threadId) => {
          void runNotification({ kind: 'done', id: threadId })
        }}
        onMarkRead={(threadId) => {
          void runNotification({ kind: 'read', id: threadId })
        }}
        onOpenCredential={() => {
          setNotificationDialogError(null)
          setNotificationDialogOpen(true)
        }}
        onOpenThread={(thread) => {
          if (!thread.url) return
          openExternal(thread.url)
        }}
        onRefresh={() => {
          void runNotification({ kind: 'refresh' })
        }}
        onRemoveCredential={removeNotificationCredential}
        onSubscribe={(thread, action) => {
          void runNotification({ kind: 'subscribe', id: thread.id, action })
        }}
      />
    )
  }

  const renderMainContent = () => {
    // Both cross-repository inboxes stay reachable before a repository is open.
    if (workspaceView === 'prInbox') return renderPrInbox()
    if (workspaceView === 'notifications') return renderNotifications()
    if (!snapshot) return null
    if (workspaceView === 'changes') return renderChanges()
    if (workspaceView === 'pullRequests') return renderPullRequests()
    if (workspaceView === 'review')
      return (
        <ReviewView
          key={JSON.stringify([authority, snapshot.path, snapshot.remoteUrl])}
          authority={JSON.stringify([authority, snapshot.path, snapshot.remoteUrl])}
          commands={reviewCommands}
          desktop={desktop ?? undefined}
          number={reviewNumber ?? selectedPullRequest?.number ?? null}
          onSelectNumber={setReviewNumber}
          onManageNumber={(number) => openWorkflow({ kind: 'pr', number })}
          pullRequests={visiblePullRequests}
          stackContext={snapshot}
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
        <GraphWorkbench
          actionError={actionError}
          onClearActionError={() => setActionError(null)}
          snapshot={snapshot}
          authority={authority}
          account={
            cliStatus?.state === 'authenticated' && cliStatus.login
              ? { host: cliStatus.host, login: cliStatus.login }
              : null
          }
          busy={isBusy}
          runAction={runAction}
          onRequest={openWorkflow}
          onReviewNumber={(number) => {
            setReviewNumber(number)
            setWorkspaceView('review')
          }}
          search={search}
          onSearchChange={setSearch}
          onCreate={openBranchDialog}
          onCheckout={requestCheckoutBranch}
          onOpenPr={openPrDialog}
          onOpenExternal={openExternal}
          onDeleteBranch={(branch) => openDeleteDialog([branch])}
          inspectorVisible={showDetails}
          onToggleInspector={() => setShowDetails((value) => !value)}
        />
      )
    return (
      <div className="branches-view">
        <div className="list-toolbar">
          <div className="list-title-group">
            <h1 id={WORKSPACE_VIEW_HEADING_ID} tabIndex={-1}>
              Branches
            </h1>
            <span className="list-subtitle">{visibleBranches.length} shown</span>
          </div>
          <div className="branch-header-controls">
            {!branchSelectionMode ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={isBusy || operationActive || Boolean(shapeReason(selectionActionType))}
                tooltip={
                  shapeReason(selectionActionType) ??
                  'Select local or remote branches to delete. Each batch uses one type.'
                }
                onClick={() => setBranchSelection({ repoPath: snapshot.path, refs: new Set() })}
              >
                Select branches
              </Button>
            ) : null}
            <SegmentedControl<BranchFilter>
              label="Branch filters"
              value={branchFilter}
              onValueChange={(value) => {
                if (
                  (value === 'remote' && selectedRemote === false) ||
                  (value === 'local' && selectedRemote === true)
                ) {
                  setBranchSelection((current) =>
                    current ? { ...current, refs: new Set<string>() } : null,
                  )
                }
                setBranchFilter(value)
              }}
              options={[
                { value: 'all', label: 'All' },
                { value: 'local', label: 'Local' },
                { value: 'remote', label: 'Remote' },
                { value: 'prs', label: 'With PRs' },
              ]}
            />
          </div>
        </div>
        {branchSelectionMode ? (
          <div className="branch-selection-controls">
            <Checkbox
              label="Select all visible"
              title={`Select eligible ${selectingRemote ? 'remote' : 'local'} branches on this page.`}
              checked={
                selectedVisibleCount > 0 &&
                selectedVisibleCount === selectableVisibleBranches.length
              }
              indeterminate={
                selectedVisibleCount > 0 && selectedVisibleCount < selectableVisibleBranches.length
              }
              disabled={isBusy || operationActive || selectableVisibleBranches.length === 0}
              onCheckedChange={(checked) => {
                const refs = new Set(branchSelection?.refs)
                for (const branch of selectableVisibleBranches) {
                  if (checked) refs.add(branch.ref)
                  else refs.delete(branch.ref)
                }
                setBranchSelection({ repoPath: snapshot.path, refs })
              }}
            />
            <span role="status" className="text-xs text-[var(--gs-semantic-text-secondary)]">
              {selectedDeleteBranches.length}{' '}
              {selectedRemote === undefined ? '' : selectedRemote ? 'remote ' : 'local '}selected
            </span>
            <Button
              size="sm"
              variant="danger"
              disabled={
                isBusy ||
                operationActive ||
                selectedDeleteBranches.length === 0 ||
                selectedDeleteBranches.some((branch) => branchSelectionReason(branch)) ||
                Boolean(shapeReason(selectionActionType))
              }
              tooltip={
                shapeReason(selectionActionType) ??
                `Review the selected ${selectingRemote ? 'remote' : 'local'} branches before deleting.`
              }
              onClick={() => openDeleteDialog(selectedDeleteBranches)}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              Delete selected ({selectedDeleteBranches.length})
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={() => setBranchSelection({ repoPath: snapshot.path, refs: new Set() })}
            >
              Clear selection
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={isBusy}
              onClick={() => setBranchSelection(null)}
            >
              Done selecting
            </Button>
          </div>
        ) : null}
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
          <IconButton
            label="Clear branch selection"
            onClick={() => setSelectedBranchRef(null)}
            variant="ghost"
          >
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
                      'Connect an authenticated GitHub repository to sync stacks.'
                    : 'Preview synchronizing this stack with trunk and updating remote branches.')
                }
                onClick={() =>
                  openWorkflow({ kind: 'stack', operation: 'sync', branch: selectedBranch.name })
                }
              >
                <GitBranch className="size-3.5" />
                Sync stack…
              </Button>
              <Button
                variant="secondary"
                disabled={
                  isBusy ||
                  operationActive ||
                  !snapshot.github.available ||
                  !selectedPullRequest ||
                  selectedPullRequest.state !== 'OPEN' ||
                  Boolean(shapeReason('executeStack'))
                }
                tooltip={
                  shapeReason('executeStack') ??
                  (!snapshot.github.available
                    ? snapshot.github.message ||
                      'Connect an authenticated GitHub repository to merge pull requests.'
                    : !selectedPullRequest
                      ? 'A pull request is required to preview downstack merge.'
                      : selectedPullRequest.state !== 'OPEN'
                        ? 'Only open pull requests can be merged.'
                        : 'Existing captured preview and confirmation gates determine the actual downstack scope.')
                }
                onClick={() =>
                  openWorkflow({ kind: 'stack', operation: 'merge', branch: selectedBranch.name })
                }
              >
                <GitPullRequest className="size-3.5" />
                Preview merge…
              </Button>
              <details className="detail-disclosure">
                <summary>Edit stack layers</summary>
                <div className="detail-disclosure-actions">
                  {(() => {
                    const immediateParentName =
                      selectedBranch.recordedParent ?? selectedBranch.parent ?? null
                    const immediateParent = immediateParentName
                      ? snapshot.branches.find(
                          (branch) => !branch.remote && branch.name === immediateParentName,
                        )
                      : null
                    const isTrunk =
                      !immediateParentName || immediateParentName === snapshot.defaultBranch
                    const lowerTarget = immediateParent
                      ? (immediateParent.recordedParent ??
                        immediateParent.parent ??
                        snapshot.defaultBranch)
                      : null
                    const above = snapshot.branches.find(
                      (branch) =>
                        !branch.remote &&
                        (branch.recordedParent === selectedBranch.name ||
                          branch.parent === selectedBranch.name),
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
                          disabled={
                            common ||
                            isTrunk ||
                            !lowerTarget ||
                            Boolean(shapeReason('executeSurgery'))
                          }
                          tooltip={
                            shapeReason('executeSurgery') ??
                            (isTrunk
                              ? 'This layer already sits directly on the stack trunk.'
                              : `Preview moving ${selectedBranch.name} below ${immediateParentName} onto ${lowerTarget} and replaying layers onto it.`)
                          }
                          onClick={() =>
                            !isTrunk && lowerTarget
                              ? openWorkflow({
                                  kind: 'surgery',
                                  request: {
                                    kind: 'move',
                                    branch: selectedBranch.name,
                                    target: lowerTarget,
                                  },
                                })
                              : undefined
                          }
                        >
                          Move layer down…
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={common || !above || Boolean(shapeReason('executeSurgery'))}
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
                          disabled={common || Boolean(shapeReason('executeSurgery'))}
                          tooltip={
                            shapeReason('executeSurgery') ??
                            (above
                              ? 'Preview deleting this local branch, replaying the layers above it onto its parent, and closing its pull request.'
                              : 'Preview deleting this local branch and closing its pull request.')
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
                </div>
              </details>
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
                            <Button
                              type="button"
                              className="truncate font-medium text-[var(--gs-semantic-text-primary)] hover:underline text-left bg-transparent border-none p-0 cursor-pointer"
                              title={issue.title}
                              onClick={() => issue.url && externalMutation.mutate(issue.url)}
                              variant="unstyled"
                            >
                              #{issue.number} {issue.title}
                            </Button>
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
                  onClick={() => openExternal(selectedPullRequest.url)}
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
                onClick={() => openPrDialog()}
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
                  onClick={() => openDeleteDialog()}
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
                  Boolean(branchDeleteReason(selectedBranch, snapshot.defaultBranch)) ||
                  Boolean(shapeReason('deleteRemoteBranch'))
                }
                onClick={() => openDeleteDialog()}
                tooltip={
                  shapeReason('deleteRemoteBranch') ??
                  branchDeleteReason(selectedBranch, snapshot.defaultBranch) ??
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
              <Button
                className="onboarding-recent"
                disabled={opening}
                key={repository.path}
                onClick={() => void openRepository(repository.path)}
                type="button"
                variant="unstyled"
              >
                <FolderGit2 aria-hidden="true" className="size-4" />
                <span>
                  <strong>{repository.name}</strong>
                  <small>{repository.path}</small>
                </span>
                <ChevronRight aria-hidden="true" className="size-4" />
              </Button>
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
        <Button
          className="titlebar-command"
          size="sm"
          variant="secondary"
          onClick={() => setPaletteOpen(true)}
          aria-keyshortcuts={ariaKeyShortcuts(shortcutBindings['palette.open'], isMac)}
          aria-label="Open command palette"
          tooltip="Search actions, repositories, branches, PRs, issues, and settings"
        >
          <Search className="size-3.5" />
          Palette
          <kbd className="ml-1 rounded border border-[var(--gs-semantic-border-essential)] px-1 font-sans text-xs">
            {formatChord(shortcutBindings['palette.open'], isMac)}
          </kbd>
        </Button>
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
              {`${pending.label} was sent once and its outcome is unknown: GitHub may have applied it and the answer was lost, so this app does not claim it failed and does not send it again on its own. ${pending.reason}`}
            </span>
            <IconButton
              label={`Dismiss ${pending.label}`}
              onClick={() => {
                dismissPendingMutation.mutate(pending.id)
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
          authority={authority}
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
        cliStatus={cliStatus}
        desktop={desktop}
        onReadCliStatus={() => void readCliStatus()}
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
      <GitHubCliStatusDialog
        onOpenChange={setCliStatusOpen}
        onRefresh={() => void readCliStatus()}
        open={cliStatusOpen}
        refreshing={cliRefreshing}
        status={cliStatus}
      />
      <NotificationCredentialDialog
        busy={notificationBusy}
        error={notificationDialogError}
        host={settings?.github.host ?? notificationInbox?.host ?? GITHUB_DEFAULT_HOST}
        login={
          notificationInbox && inboxForHost(notificationInbox, notificationHost)
            ? notificationInbox.login
            : null
        }
        onOpenChange={setNotificationDialogOpen}
        onSubmit={(token, accepted, host) => void saveNotificationCredential(token, accepted, host)}
        open={notificationDialogOpen}
      />
      <RepositoryDiscoveryDialog
        authority={authority}
        busy={isBusy || operationActive}
        cliStatus={cliStatus}
        onCloned={(result) => void adoptClonedRepository(result)}
        onOpenChange={setDiscoveryOpen}
        onOpenCliStatus={openCliStatus}
        open={discoveryOpen}
      />
      {conflictPath && snapshot ? (
        <ConflictResolver
          key={`${snapshot.path}:${conflictPath}`}
          repositoryPath={snapshot.path}
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
        onOpenChange={(open, details) => {
          if (open) return
          const intent = closeIntent({
            busy: isBusy || deleteSubmitting,
            dirty: deleteForce,
          })
          if (intent === 'allow') {
            setDeleteTarget(null)
            return
          }
          details.cancel()
          setDeleteCloseNotice(CLOSE_INTENT_MESSAGES[intent])
        }}
      >
        <DialogContent
          className="workflow-dialog"
          initialFocus={() => deleteCancelRef.current ?? false}
          finalFocus={() => {
            // The palette hands the dialog a row to return to, because the control
            // that opened it was the palette itself and no longer exists.
            if (paletteDeleteHandoffRef.current) {
              paletteDeleteHandoffRef.current = false
              const target = paletteHandoffFocusRef.current
              paletteHandoffFocusRef.current = null
              if (target?.isConnected && !('disabled' in target && target.disabled)) return target
              return searchRef.current ?? false
            }
            const opener = deleteOpenerRef.current
            if (opener?.isConnected && !('disabled' in opener && opener.disabled)) return opener
            const trigger = deleteTriggerRef.current
            if (trigger && !trigger.disabled) return trigger
            return searchRef.current ?? false
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {`Delete ${deletingRemote ? 'remote' : 'local'} ${deleteNoun}?`}
            </DialogTitle>
            <DialogDescription>
              Delete{' '}
              <strong>
                {deleteTarget?.branches.length === 1
                  ? deleteTarget.branches[0].name
                  : `${deleteCount} selected ${deletingRemote ? 'remote' : 'local'} branches`}
              </strong>{' '}
              {deletingRemote
                ? 'from the remote repository. Local branches remain. Open pull requests may close, and collaborators will need to prune their fetched refs.'
                : 'from this repository. Remote branches and pull requests will not be deleted.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void deleteForm.handleSubmit()
            }}
          >
            <WorkflowFrame composition="destructive">
              {deleteCloseNotice ? (
                <PhaseStatus phase="blocked" message={deleteCloseNotice} />
              ) : null}
              {deletingRemote ? (
                <WarningNote>
                  Remote-only commits may become unreachable. This cannot be undone from the app.
                  {deleteCount > 1
                    ? ' All selected branches must belong to one configured remote; deletion requires atomic push support.'
                    : null}
                  {' Changed tips stop deletion instead of deleting unseen work.'}
                </WarningNote>
              ) : (
                <p className="workflow-note">
                  {deleteChildCount > 0
                    ? `${deleteChildCount} local child branches use these parents. Deletion does not retarget those branches.`
                    : 'No local branches record these branches as their parents.'}
                </p>
              )}
              {deleteTarget?.branches.map((branch) => (
                <OperationContext
                  key={branch.ref}
                  title={branch.name}
                  facts={[
                    {
                      label: deletingRemote ? 'Remote ref' : 'Local ref',
                      value: branch.ref,
                      code: true,
                    },
                    { label: 'Current tip', value: branch.oid ?? 'Unavailable', code: true },
                  ]}
                />
              ))}
              {!deletingRemote ? (
                <>
                  <deleteForm.Field name="force">
                    {(field) => (
                      <Checkbox
                        id="delete-branch-force"
                        label="Delete even if not merged"
                        checked={field.state.value}
                        disabled={isBusy}
                        onCheckedChange={(checked) => {
                          field.handleChange(checked)
                          deleteForm.setErrorMap({ onSubmit: undefined })
                          setDeleteCloseNotice(null)
                        }}
                      />
                    )}
                  </deleteForm.Field>
                  <p className="delete-branch-note">
                    {deleteForce
                      ? 'Commits that exist only on the selected branches can become unreachable.'
                      : 'Git will refuse deletion if any selected branch is not fully merged.'}
                  </p>
                </>
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
                    snapshot?.path !== deleteTarget?.repoPath ||
                    Boolean(shapeReason(deleteActionType))
                  }
                  type="submit"
                  variant="danger"
                  loading={deleteSubmitting}
                  tooltip={
                    shapeReason(deleteActionType) ??
                    (deletingRemote
                      ? 'Delete these remote branches. Local branches remain; open pull requests may close.'
                      : 'Delete the selected local branches now. Remotes and pull requests are kept.')
                  }
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                  {`Delete ${deleteCount > 1 ? `${deleteCount} ` : ''}${deletingRemote ? 'remote ' : ''}${deleteNoun}`}
                </Button>
              </WorkflowActions>
            </WorkflowFrame>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open, details) => {
          if (open) {
            setNewBranchOpen(true)
            return
          }
          const intent = closeIntent({
            busy: isBusy || newBranchSubmitting,
            dirty: newBranchDirty,
          })
          if (intent === 'allow') {
            setNewBranchOpen(false)
            return
          }
          details.cancel()
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
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void newBranchForm.handleSubmit()
            }}
          >
            <WorkflowFrame composition="form">
              {newBranchNotice ? <PhaseStatus phase="blocked" message={newBranchNotice} /> : null}
              <newBranchForm.Field name="name">
                {(field) => (
                  <Field
                    id="new-branch-name"
                    label="Branch name"
                    required
                    description="Local only. Nothing is pushed and no commit is created."
                  >
                    <Input
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        field.handleChange(event.target.value)
                        setNewBranchNotice(null)
                      }}
                      placeholder="feature/short-description"
                      value={field.state.value}
                    />
                  </Field>
                )}
              </newBranchForm.Field>
              <newBranchForm.Field name="parent">
                {(field) => (
                  <Field id="new-branch-parent" label="Parent branch" required>
                    <Select
                      onValueChange={(value) => {
                        field.handleChange(value)
                        setNewBranchNotice(null)
                      }}
                      value={field.state.value}
                      options={(snapshot?.branches ?? [])
                        .filter((branch) => !branch.remote)
                        .map((branch) => ({
                          value: branch.name,
                          label: `${branch.name}${branch.current ? ' (current)' : ''}`,
                        }))}
                    />
                  </Field>
                )}
              </newBranchForm.Field>
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
        onOpenChange={(open, details) => {
          if (open) {
            setPrOpen(true)
            return
          }
          const intent = closeIntent({
            busy: isBusy || prSubmitting,
            dirty: prDirty,
          })
          if (intent === 'allow') {
            setPrOpen(false)
            return
          }
          details.cancel()
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
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void prForm.handleSubmit()
            }}
          >
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
              <prForm.Field name="title">
                {(field) => (
                  <Field id="pr-title" label="Title" required>
                    <Input
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        field.handleChange(event.target.value)
                        setPrNotice(null)
                      }}
                      placeholder="What does this stack change?"
                      value={field.state.value}
                    />
                  </Field>
                )}
              </prForm.Field>
              <prForm.Field name="base">
                {(field) => (
                  <Field
                    id="pr-base"
                    label="Base branch"
                    required
                    description="Pick a local branch other than the head branch."
                  >
                    <Input
                      list="pr-base-options"
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        field.handleChange(event.target.value)
                        setPrNotice(null)
                      }}
                      value={field.state.value}
                    />
                  </Field>
                )}
              </prForm.Field>
              <datalist id="pr-base-options">
                {(snapshot?.branches ?? [])
                  .filter((branch) => !branch.remote && branch.name !== currentBranch)
                  .map((branch) => (
                    <option key={branch.name} value={branch.name} />
                  ))}
              </datalist>
              <prForm.Field name="body">
                {(field) => (
                  <Field id="pr-body" label="Description (optional)">
                    <Textarea
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        field.handleChange(event.target.value)
                        setPrNotice(null)
                      }}
                      placeholder="Add context for reviewers"
                      rows={5}
                      value={field.state.value}
                    />
                  </Field>
                )}
              </prForm.Field>
              <prForm.Field name="draft">
                {(field) => (
                  <Checkbox
                    id="pr-draft"
                    label="Mark as draft"
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                  />
                )}
              </prForm.Field>
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
