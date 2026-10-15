import { NativeOperationDialog } from './components/native-operation-dialog'
import { operationInspectionAPI } from './lib/operation-api'
import { WorktreeLifecycleDialog } from './components/worktree-lifecycle-dialog'
import { ReconciliationPanel } from './components/reconciliation-view'
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  WorkbenchPane,
  Select,
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@git-stacks/ui'
import { BranchWorkbench } from './components/branch-workbench'
import {
  projectBranchLanes,
  type WorkbenchAction,
  type WorkbenchActionContext,
  type WorkbenchViewState,
} from './components/branch-workbench-model'
import type { WorkbenchBranch } from './components/branch-workbench-model'
import {
  LocalInspection,
  PublishedInspection,
  ContextHistory,
} from './components/workbench-inspection'
import {
  ReviewView,
  UnsentReviewChangesNotice,
  type ReviewCommands,
} from './components/review-view'
import { SettingsDialog } from './components/settings-dialog'
import { RepositoryDiscoveryDialog } from './components/onboarding'
import { LocalRepositoryDialog } from './components/local-repository-dialog'
import {
  NotificationCenterView,
  NotificationCredentialDialog,
} from './components/notification-center-view'
import { WorkflowDialog, type WorkflowRequest } from './components/workflow-dialog'
import { OperationBanner } from './components/repository-views'
import {
  AttentionView,
  ActivityView,
  PullRequestList,
  type AttentionViewState,
  type ActivityViewState,
} from './components/collaboration-views'
import {
  attentionItems,
  collaborationObservations,
  activityTransitions,
  type CollaborationTarget,
  type CollaborationObservation,
  type ObservedActivity,
} from './lib/collaboration'
import {
  PULL_REQUEST_INBOX_REFRESH_MS,
  type PullRequestInboxFilter,
} from '@git-stacks/shared/pr-inbox'
import { useWorktreeInventory } from './lib/worktree-inventory'
import { useSettingsMutation } from './lib/settings-query'
import { projectWorkbenchInventory } from './lib/workbench-inventory'
import { inspectionAPI } from './lib/inspection-api'
import {
  emptyRepositoryMemory,
  readWorkbenchMemory,
  saveWorkbenchMemory,
  type RepositoryViewMemory,
  type WorkbenchSurface,
} from './lib/workbench-context'
import {
  defaultShortcutBindings,
  isComposingKeyEvent,
  isEditableTarget,
  isMacPlatform,
  matchesChord,
  type ShortcutId,
} from '@git-stacks/shared/shortcuts'
import type {
  DesktopAPI,
  GitHubCliStatus,
  RepositorySnapshot,
  PullRequestAction,
} from '@git-stacks/shared/types'
import type { AppSettings } from '@git-stacks/shared/settings'
import type { InspectionContext } from '@git-stacks/shared/inspection'
import type { NotificationInbox, NotificationThread } from '@git-stacks/shared/notifications'
import { LIST_PAGE_SIZE } from '@git-stacks/shared/performance'
import {
  sameOperationScope,
  type OperationScope,
  type OperationCapture,
} from '@git-stacks/shared/operation-scope'
import { useOperationProgressProjection } from './lib/operation-progress'
import './components/workbench-shell.css'

const providerReadQuery = (query: { queryKey: readonly unknown[] }) =>
  [
    'inspection-repository',
    'inspection-authority',
    'workbench-attention',
    'collaboration-pr-page',
  ].includes(String(query.queryKey[0])) ||
  (query.queryKey[0] === 'review' && !query.queryKey.includes('drafts'))

function App() {
  const desktop: DesktopAPI | null = window.desktop ?? null
  const client = useQueryClient()
  React.useEffect(() => {
    if (/Electron/.test(navigator.userAgent) && /Mac/.test(navigator.platform))
      document.documentElement.dataset.nativeMac = 'true'
    return () => {
      delete document.documentElement.dataset.nativeMac
    }
  }, [])
  const [memory, setMemory] = React.useState(readWorkbenchMemory)
  const memoryRef = React.useRef(memory)
  memoryRef.current = memory
  const [repositoryId, setRepositoryId] = React.useState('')
  const [surface, setSurface] = React.useState<WorkbenchSurface>('branches')
  const [details, setDetails] = React.useState<Record<string, RepositorySnapshot>>({})
  const [error, setError] = React.useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [reconciliationOpen, setReconciliationOpen] = React.useState(false)
  const [globalQuery, setGlobalQuery] = React.useState('')
  const [globalPage, setGlobalPage] = React.useState(0)
  const [searchReady, setSearchReady] = React.useState(true)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [localRepositoryOpen, setLocalRepositoryOpen] = React.useState(false)
  const [discoveryOpen, setDiscoveryOpen] = React.useState(false)
  const [recoveryOpen, setRecoveryOpen] = React.useState(false)
  const [preparingOperation, setOperationBusy] = React.useState(false)
  const [, updateRunningOperations] = React.useReducer((value: number) => value + 1, 0)
  const [discoveryWorktrees, setDiscoveryWorktrees] = React.useState(false)
  const [discoveryPage, setDiscoveryPage] = React.useState(0)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [notificationOpen, setNotificationOpen] = React.useState(false)
  const [credentialOpen, setCredentialOpen] = React.useState(false)
  const [notificationInbox, setNotificationInbox] = React.useState<NotificationInbox | null>(null)
  const [notificationBusy, setNotificationBusy] = React.useState(false)
  const [notificationError, setNotificationError] = React.useState<string | null>(null)
  const [credentialError, setCredentialError] = React.useState<string | null>(null)
  const notificationGeneration = React.useRef(0)
  const notificationLock = React.useRef(false)
  const cliReadGeneration = React.useRef(0)
  const [cliRefreshing, setCliRefreshing] = React.useState(false)
  const originFocus = React.useRef<string | null>(null)
  const restoreOriginFocus = React.useRef(false)
  const [attentionFilter, setAttentionFilter] = React.useState<PullRequestInboxFilter>({
    group: 'all',
    search: '',
    criteria: {},
    sort: 'updated-desc',
  })
  const [attentionState, setAttentionState] = React.useState<AttentionViewState>({
    page: 0,
    scroll: 0,
    filterName: '',
    savedFilterId: '',
  })
  const [activityState, setActivityState] = React.useState<ActivityViewState>({
    repositoryId: '',
    page: 0,
    scroll: 0,
  })
  const inboxFilterLock = React.useRef(false)
  const [events, setEvents] = React.useState<ObservedActivity[]>([])
  const previousObservations = React.useRef(new Map<string, CollaborationObservation>())
  const [workflow, setWorkflow] = React.useState<WorkflowRequest | null>(null)
  const [operationSnapshot, setOperationSnapshot] = React.useState<RepositorySnapshot | null>(null)
  const [providerWorkflow, setProviderWorkflow] = React.useState<{
    api: DesktopAPI
    scope: OperationScope
    target: InspectionContext
    generation: number
  } | null>(null)
  const actionLock = React.useRef(new Set<string>())
  const workflowAdmissionLock = React.useRef(false)
  const [createPrTarget, setCreatePrTarget] = React.useState<{
    repositoryId: string
    branches: { id: string; name: string }[]
  } | null>(null)
  const [createPrRef, setCreatePrRef] = React.useState('')
  const operationScope = React.useRef<OperationScope | null>(null)
  const operationCaptureGeneration = React.useRef<number | null>(null)
  const operationContext = React.useRef<InspectionContext | null>(null)
  const operationBusy =
    preparingOperation ||
    actionLock.current.has(
      providerWorkflow?.target.repositoryId ?? operationContext.current?.repositoryId ?? '',
    )
  const operationCapture = React.useRef<OperationCapture | null>(null)
  const [approvedCapture, setApprovedCapture] = React.useState<OperationCapture | null>(null)
  const approvedScope = approvedCapture?.scope
  const [lifecycle, setLifecycle] = React.useState<{
    repositoryId: string
    mode: 'create' | 'remove'
    sourceRefId?: string
    worktreeIds: string[]
  } | null>(null)
  const [nativeManagement, setNativeManagement] = React.useState<{
    repositoryId: string
    number?: number
  } | null>(null)
  const [executionChoice, setExecutionChoice] = React.useState<{
    action: WorkbenchAction
    context: WorkbenchActionContext
  } | null>(null)
  const [executionChoiceId, setExecutionChoiceId] = React.useState('')
  const [returnOrigin, setReturnOrigin] = React.useState<RepositoryViewMemory['reviewOrigin']>(null)
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [pendingReview, setPendingReview] = React.useState<{
    repositoryId: string
    number: number
    generation: number
    remoteId?: string
    error?: string
  } | null>(null)
  const navigationGeneration = React.useRef(0)
  const inspectionNavigation = React.useRef(0)
  const retirePendingReview = React.useCallback(() => {
    navigationGeneration.current += 1
    setPendingReview(null)
  }, [])
  const densityWrite = useSettingsMutation((density: 'compact' | 'standard') => {
    if (!desktop?.updateSettings) throw new Error('Settings writes are unavailable.')
    return desktop.updateSettings({ appearance: { density } })
  })
  const [savingInboxFilters, setSavingInboxFilters] = React.useState(false)
  const attentionSearch = React.useRef<HTMLInputElement>(null)
  const [bindings, setBindings] = React.useState(defaultShortcutBindings)
  const settingsRead = useQuery({
    queryKey: ['settings'],
    queryFn: () => desktop!.settings!(),
    enabled: Boolean(desktop?.settings),
  })
  React.useEffect(() => {
    if (settingsRead.error) setError(settingsRead.error.message)
    if (!settingsRead.data) return
    setSettings(settingsRead.data.settings)
    setBindings(settingsRead.data.settings.shortcuts)
  }, [settingsRead.data, settingsRead.error])
  const [cliStatus, setCliStatus] = React.useState<GitHubCliStatus | null>(null)
  const [providerEpoch, setProviderEpoch] = React.useState(0)
  const providerGeneration = React.useRef(0)
  const principalIdentities = React.useRef(new Map<string, string>())
  const cliStatusVersion = React.useRef(0)
  const configuredHost = React.useRef(settings?.github.host ?? 'github.com')
  configuredHost.current = settings?.github.host ?? 'github.com'
  const reviewCommands = React.useRef<ReviewCommands | null>(null)
  const current = memory[repositoryId] ?? emptyRepositoryMemory
  const inventory = useWorktreeInventory(desktop ?? ({} as DesktopAPI), 'workbench', {
    selectedWorktreeId: current.view.worktreeId ?? undefined,
  })
  const snapshot = React.useMemo(
    () => projectWorkbenchInventory(inventory.data, details),
    [inventory.data, details],
  )
  React.useEffect(() => {
    previousObservations.current.clear()
    setEvents([])
  }, [providerEpoch, settings?.github.host])
  React.useEffect(() => {
    const registered = new Set(inventory.data?.repositories.map((repo) => repo.identity.id) ?? [])
    setEvents((events) => events.filter((event) => registered.has(event.target.repositoryId)))
  }, [inventory.data?.repositories.map((repo) => repo.identity.id).join('\0')])
  const repository = inventory.data?.repositories.find((repo) => repo.identity.id === repositoryId)
  const selected = snapshot.branches.find(
    (branch) => branch.id === current.selectedId && branch.repositoryId === repositoryId,
  )
  const selectedTree =
    selected?.worktrees.find((tree) => tree.id === current.view.worktreeId) ??
    (current.view.worktreeId === null &&
    selected?.worktreesKnown === true &&
    selected.worktrees.length === 1
      ? selected.worktrees[0]
      : undefined)
  const selectedRefId = repository?.refs.some((ref) => ref.id === selected?.id)
    ? selected?.id
    : undefined
  const context: InspectionContext = React.useMemo(
    () => ({ repositoryId, refId: selectedRefId, worktreeId: selectedTree?.id }),
    [repositoryId, selectedRefId, selectedTree?.id],
  )
  const scoped = React.useMemo(
    () => (desktop ? inspectionAPI(desktop, context) : null),
    [desktop, context],
  )
  const publishedContext: InspectionContext = React.useMemo(
    () => ({ repositoryId, refId: context.refId, pullRequestId: selected?.pullRequest?.id }),
    [repositoryId, context.refId, selected?.pullRequest?.id],
  )
  const reviewBranch = snapshot.branches.find(
    (branch) =>
      branch.repositoryId === repositoryId && branch.pullRequest?.id === current.pullRequestId,
  )
  const reviewContext: InspectionContext = React.useMemo(
    () => ({
      repositoryId,
      refId: repository?.refs.some((ref) => ref.id === reviewBranch?.id)
        ? reviewBranch?.id
        : undefined,
      pullRequestId: reviewBranch?.pullRequest?.id,
    }),
    [repositoryId, reviewBranch?.id, reviewBranch?.pullRequest?.id],
  )
  const reviewAPI = React.useMemo(
    () => (desktop ? inspectionAPI(desktop, reviewContext) : null),
    [desktop, reviewContext],
  )
  const published = React.useMemo(
    () => (desktop ? inspectionAPI(desktop, publishedContext) : null),
    [desktop, publishedContext],
  )
  const identity = JSON.stringify(context)
  const selectedLocalFact = repository?.worktrees.find((tree) => tree.id === selectedTree?.id)
  const local = useQuery({
    queryKey: [
      'inspection-local',
      identity,
      selectedLocalFact?.headOid,
      selectedLocalFact?.indexSignature,
      selectedLocalFact?.read.observedAt,
    ],
    enabled: Boolean(scoped && selectedTree && current.view.tab === 'changes'),
    queryFn: async ({ signal }) => {
      const cancel = () => void scoped!.cancel('worktree-status')
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const value = await scoped!.worktreeStatus!()
        signal.throwIfAborted()
        return value
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    gcTime: 0,
  })
  const recovery = useQuery({
    queryKey: [
      'inspection-recovery',
      identity,
      selectedLocalFact?.headOid,
      selectedLocalFact?.indexSignature,
      selectedLocalFact?.read.observedAt,
    ],
    enabled: Boolean(scoped && selectedTree && recoveryOpen),
    queryFn: async ({ signal }) => {
      const cancel = () => void scoped!.cancel('refresh')
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const value = await scoped!.refresh()
        signal.throwIfAborted()
        return value
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    gcTime: 0,
  })
  const operationRecords = useQuery({
    queryKey: ['workbench-operation-records', providerEpoch],
    enabled: Boolean(desktop?.operationRecords),
    queryFn: () => desktop!.operationRecords!(),
    refetchInterval: actionLock.current.size || recoveryOpen ? 2000 : PULL_REQUEST_INBOX_REFRESH_MS,
  })
  const retainedOperationCount = (operationRecords.data ?? []).reduce(
    (count, record) => count + (record.state !== 'completed' && !record.resolution ? 1 : 0),
    0,
  )
  const operationApi = React.useMemo(() => {
    const target = operationContext.current
    const expected = operationScope.current
    const original = approvedCapture
    const generation = operationCaptureGeneration.current
    if (!desktop || !target || !expected || !original) return undefined
    return operationInspectionAPI(
      desktop,
      target,
      expected,
      original,
      () => providerGeneration.current === generation,
      (value) => {
        if (
          JSON.stringify(operationContext.current) !== JSON.stringify(target) ||
          !operationScope.current ||
          !sameOperationScope(operationScope.current, expected)
        )
          throw new Error(
            'The original preview was retired; its approval cannot replace a newer target.',
          )
        operationCapture.current = value
        operationCaptureGeneration.current = providerGeneration.current
        setApprovedCapture(value)
      },
    )
  }, [
    desktop,
    workflow,
    operationSnapshot?.path,
    operationSnapshot?.remoteUrl,
    JSON.stringify(operationContext.current),
    operationScope.current?.authority,
  ])
  useOperationProgressProjection(operationApi ?? null, approvedScope ?? null)
  const refRevision = repository?.refs.map((ref) => `${ref.id}:${ref.oid}`).join('\0')
  const repoRead = useQuery<RepositorySnapshot>({
    queryKey: ['inspection-repository', repositoryId, refRevision, providerEpoch],
    enabled: Boolean(desktop?.inspect && repositoryId),
    placeholderData: (previous, query) =>
      query?.queryKey[1] === repositoryId && query.queryKey[3] === providerEpoch
        ? previous
        : undefined,
    queryFn: async ({ signal }) => {
      const id = `repository-inspection-${crypto.randomUUID()}`
      const cancel = () => void desktop!.inspect!({ repositoryId }, 'cancel', [id])
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const value = await desktop!.inspect!({ repositoryId }, 'refresh', [], id)
        signal.throwIfAborted()
        return value
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    gcTime: 0,
  })
  const publishedIdentity = JSON.stringify(publishedContext)
  const authorityRead = useQuery({
    queryKey: ['inspection-authority', publishedIdentity, providerEpoch],
    enabled: Boolean(published && repositoryId),
    queryFn: async ({ signal }) => {
      const cancel = () => void published!.cancel('repository-operation-scope')
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const value = await published!.repositoryOperationScope()
        signal.throwIfAborted()
        return value
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    gcTime: 0,
  })
  const authority = JSON.stringify([
    repositoryId,
    repository?.remote?.id,
    authorityRead.data?.authority,
  ])
  const prPage = useQuery({
    queryKey: [
      'collaboration-pr-page',
      repositoryId,
      current.pullRequestLifecycle,
      current.pullRequestCursor,
      providerEpoch,
    ],
    enabled: Boolean(desktop?.inspect && repository?.remote && surface === 'pull-requests'),
    queryFn: async ({ signal }) => {
      const api = inspectionAPI(desktop!, { repositoryId })
      const cancel = () => void api.cancel('pull-request-page')
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (!api.pullRequestPage) throw new Error('Captured provider listing is unavailable.')
        const state =
          current.pullRequestLifecycle === 'draft'
            ? 'OPEN'
            : (current.pullRequestLifecycle.toUpperCase() as 'ALL' | 'OPEN' | 'CLOSED' | 'MERGED')
        const page = await api.pullRequestPage(state, current.pullRequestCursor)
        signal.throwIfAborted()
        return page
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    refetchOnWindowFocus: false,
    retry: false,
  })
  const inbox = useQuery({
    queryKey: [
      'workbench-attention',
      cliStatus?.host,
      cliStatus?.identity,
      providerEpoch,
      inventory.data?.repositories.map((repo) => repo.identity.id).join('\0'),
    ],
    enabled: Boolean(desktop?.pullRequestInbox && surface === 'attention'),
    queryFn: async ({ signal }) => {
      const id = `attention-${crypto.randomUUID()}`
      signal.addEventListener('abort', () => void desktop?.cancel(id), { once: true })
      const value = await desktop!.pullRequestInbox!({ requestId: id })
      signal.throwIfAborted()
      return value
    },
    gcTime: 0,
    refetchInterval: () =>
      document.visibilityState === 'visible' && document.hasFocus()
        ? PULL_REQUEST_INBOX_REFRESH_MS
        : false,
    refetchOnWindowFocus: false,
    retry: false,
  })
  React.useEffect(() => {
    const current = collaborationObservations(inventory.data, inbox.data)
    const transitions = activityTransitions(previousObservations.current, current)
    if (transitions.length)
      setEvents((events) => [...transitions.reverse(), ...events].slice(0, LIST_PAGE_SIZE))
  }, [inventory.data, inbox.data])
  const inboxFilters = useQuery({
    queryKey: ['workbench-attention-filters'],
    enabled: Boolean(desktop?.pullRequestInboxFilters && surface === 'attention'),
    queryFn: () => desktop!.pullRequestInboxFilters!(),
  })
  React.useEffect(() => {
    if (surface !== 'attention') void client.cancelQueries({ queryKey: ['workbench-attention'] })
    if (surface !== 'pull-requests')
      void client.cancelQueries({ queryKey: ['collaboration-pr-page'] })
    const retireHidden = () => {
      if (document.visibilityState !== 'visible') {
        void client.cancelQueries({ queryKey: ['workbench-attention'] })
        void client.cancelQueries({ queryKey: ['collaboration-pr-page'] })
      }
    }
    document.addEventListener('visibilitychange', retireHidden)
    return () => document.removeEventListener('visibilitychange', retireHidden)
  }, [surface, client])
  const updateMemory = React.useCallback(
    (id: string, patch: Partial<RepositoryViewMemory>) => {
      if (
        patch.selectedId !== undefined ||
        patch.surface !== undefined ||
        patch.pullRequestId !== undefined
      ) {
        inspectionNavigation.current += 1
        retirePendingReview()
      }
      setMemory((previous) => {
        const next = { ...previous, [id]: { ...(previous[id] ?? emptyRepositoryMemory), ...patch } }
        const refusal = saveWorkbenchMemory(next)
        if (refusal) setError(refusal)
        return next
      })
    },
    [retirePendingReview],
  )
  React.useEffect(() => {
    if (selectedTree && current.view.worktreeId === null)
      updateMemory(repositoryId, { view: { ...current.view, worktreeId: selectedTree.id } })
  }, [repositoryId, selectedTree?.id, current.view.worktreeId, updateMemory])
  React.useEffect(() => {
    if (repoRead.data && repositoryId)
      setDetails((previous) => ({ ...previous, [repositoryId]: repoRead.data! }))
  }, [repoRead.data, repositoryId])
  React.useEffect(() => {
    if (
      !repositoryId &&
      surface !== 'attention' &&
      surface !== 'activity' &&
      snapshot.repositories.length
    ) {
      const first = snapshot.repositories[0].id
      setRepositoryId(first)
      setSurface((memoryRef.current[first] ?? emptyRepositoryMemory).surface)
    }
  }, [snapshot.repositories, repositoryId])
  React.useEffect(() => {
    if (!desktop?.githubCliStatus || !settings?.github.host) return
    let retired = false
    const host = settings.github.host
    const version = cliStatusVersion.current
    setCliStatus(null)
    setDetails({})
    providerGeneration.current += 1
    setProviderEpoch((epoch) => epoch + 1)
    void client.cancelQueries({ predicate: providerReadQuery })
    client.removeQueries({ predicate: providerReadQuery })
    void desktop
      .githubCliStatus()
      .then((value) => {
        if (retired || cliStatusVersion.current !== version || value.host !== host) return
        principalIdentities.current.set(value.host, value.identity ?? '')
        setCliStatus(value)
      })
      .catch((value) => {
        if (!retired) setError(String(value))
      })
    return () => {
      retired = true
    }
  }, [desktop, settings?.github.host, client])
  React.useEffect(() => {
    if (!desktop) return
    const stopStatus = desktop.onGitHubCliStatus?.((value) => {
      cliStatusVersion.current += 1
      const next = value.identity ?? ''
      const previous = principalIdentities.current.get(value.host)
      principalIdentities.current.set(value.host, next)
      if (value.host === configuredHost.current) {
        cliReadGeneration.current += 1
        setCliRefreshing(false)
        setCliStatus(value)
      }
      if (previous === undefined || previous === next) return
      providerGeneration.current += 1
      setProviderEpoch((epoch) => epoch + 1)
      setDetails({})
      retirePendingReview()
      setReturnOrigin(null)
      void client.cancelQueries({ predicate: providerReadQuery })
      client.removeQueries({ predicate: providerReadQuery })
      // Account-owned text and journals survive; a review target is not transferred to another principal.
      setSurface((value) => (value === 'review' ? 'branches' : value))
      setMemory((previous) => {
        const next = { ...previous }
        for (const [id, saved] of Object.entries(next))
          next[id] = {
            ...saved,
            pullRequestId: null,
            pullRequestCursor: null,
            pullRequestPage: 0,
            pullRequestScroll: 0,
            reviewOrigin: null,
            surface: saved.surface === 'review' ? 'branches' : saved.surface,
          }
        saveWorkbenchMemory(next)
        return next
      })
    })
    const adoptOpened = async (value: RepositorySnapshot | null | undefined) => {
      if (!value) return
      const refreshed = await inventory.refetch()
      const repo = refreshed.data?.repositories.find((repo) =>
        repo.registeredPaths.includes(value.path),
      )
      if (!repo)
        throw new Error('The opened repository was not confirmed by the registered inventory.')
      setRepositoryId(repo.identity.id)
      setSurface('branches')
      retirePendingReview()
    }
    const stopDrop = desktop.onRepositoryDropped?.((paths) => {
      void paths
        .reduce(async (previous, path) => {
          await previous
          if (!desktop.addRepository) throw new Error('Folder-drop opening is unavailable.')
          await adoptOpened(await desktop.addRepository(path))
        }, Promise.resolve())
        .catch((value) => setError(String(value)))
    })
    const report = () =>
      void desktop.reportActivity?.({
        focused: document.hasFocus(),
        visible: document.visibilityState === 'visible',
      })
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    document.addEventListener('visibilitychange', report)
    report()
    return () => {
      stopStatus?.()
      stopDrop?.()
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
      document.removeEventListener('visibilitychange', report)
    }
  }, [desktop, client, settings?.github.host])
  React.useEffect(() => {
    if (!settings) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.gsTheme = settings.appearance.theme
      document.documentElement.dataset.motion = settings.appearance.reduceMotion
        ? 'reduced'
        : 'system'
      document.documentElement.classList.toggle(
        'dark',
        settings.appearance.theme === 'dark' ||
          (settings.appearance.theme === 'system' && media.matches),
      )
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings])
  React.useEffect(() => {
    notificationGeneration.current += 1
    notificationLock.current = false
    setNotificationBusy(false)
    setNotificationInbox(null)
    setNotificationError(null)
    setCredentialError(null)
    setCredentialOpen(false)
  }, [settings?.github.host])
  React.useEffect(() => {
    if (!desktop || !notificationOpen) return
    let retired = false
    notificationGeneration.current += 1
    setNotificationInbox(null)
    const accept = (value: NotificationInbox) => {
      if (!retired && value.host === settings?.github.host) setNotificationInbox(value)
    }
    if (!desktop.notifications) {
      setNotificationError('The Notifications service is unavailable in this runtime.')
      return
    }
    void desktop
      .notifications()
      .then(accept)
      .catch((value) => {
        if (!retired) setNotificationError(String(value))
      })
    const stop = desktop.onNotifications?.(accept)
    return () => {
      retired = true
      notificationGeneration.current += 1
      stop?.()
    }
  }, [desktop, notificationOpen, settings?.github.host])
  React.useEffect(() => {
    setSearchReady(false)
    const timer = window.setTimeout(() => {
      setSearchReady(true)
      setGlobalPage(0)
    }, 120)
    return () => clearTimeout(timer)
  }, [globalQuery, paletteOpen])
  const navigate = React.useCallback(
    (id: string, nextSurface?: WorkbenchSurface, selectedId?: string, worktreeId?: string) => {
      inspectionNavigation.current += 1
      setRepositoryId(id)
      const saved = memoryRef.current[id] ?? emptyRepositoryMemory
      const next = nextSurface ?? saved.surface
      setSurface(next)
      updateMemory(id, {
        surface: next === 'attention' || next === 'activity' ? saved.surface : next,
        ...(selectedId !== undefined || worktreeId !== undefined
          ? {
              selectedId: selectedId ?? null,
              view: {
                ...saved.view,
                worktreeId:
                  worktreeId ??
                  (next === 'review' && saved.selectedId === selectedId
                    ? saved.view.worktreeId
                    : null),
                tab:
                  next === 'review' && saved.selectedId === selectedId
                    ? saved.view.tab
                    : 'overview',
              },
            }
          : {}),
      })
    },
    [updateMemory],
  )
  const captureOrigin = (): NonNullable<RepositoryViewMemory['reviewOrigin']> => {
    if (surface === 'review') {
      const origin = current.reviewOrigin ?? returnOrigin
      if (origin) return origin
    }
    originFocus.current =
      surface !== 'branches' && document.activeElement instanceof HTMLElement
        ? (document.activeElement.getAttribute('aria-label') ??
          document.activeElement.textContent?.trim() ??
          null)
        : null
    return {
      repositoryId,
      surface: surface === 'review' ? 'branches' : surface,
      selectedId: current.selectedId,
      worktreeId: current.view.worktreeId,
      tab: current.view.tab,
      pullRequestId: current.pullRequestId,
    }
  }
  const returnToOrigin = () => {
    const origin = surface === 'review' ? (current.reviewOrigin ?? returnOrigin) : returnOrigin
    restoreOriginFocus.current = true
    if (origin) {
      navigate(origin.repositoryId, origin.surface)
      const saved = memoryRef.current[origin.repositoryId] ?? emptyRepositoryMemory
      updateMemory(origin.repositoryId, {
        selectedId: origin.selectedId === undefined ? saved.selectedId : origin.selectedId,
        pullRequestId: origin.pullRequestId ?? null,
        reviewOrigin: null,
        view: {
          ...saved.view,
          worktreeId: origin.worktreeId ?? null,
          tab: origin.tab ?? saved.view.tab,
        },
      })
    } else {
      retirePendingReview()
      inspectionNavigation.current += 1
      setSurface('branches')
    }
    setReturnOrigin(null)
  }
  React.useLayoutEffect(() => {
    if (!restoreOriginFocus.current || surface === 'review') return
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="main"] button')]
    const target =
      buttons.find(
        (button) =>
          originFocus.current !== null &&
          (button.getAttribute('aria-label') === originFocus.current ||
            button.textContent?.trim() === originFocus.current),
      ) ?? document.querySelector<HTMLButtonElement>('.bw-branch-name[aria-pressed="true"]')
    if (target) {
      target.focus({ preventScroll: true })
      restoreOriginFocus.current = false
    }
  }, [surface, current.selectedId, inbox.data])
  const reviewSelected = () => {
    if (!selected?.pullRequest) {
      setError('Select a source-qualified pull request to review.')
      return
    }
    const origin = captureOrigin()
    setReturnOrigin(origin)
    setSurface('review')
    updateMemory(repositoryId, {
      surface: 'review',
      pullRequestId: selected.pullRequest.id,
      reviewOrigin: origin,
    })
  }
  React.useEffect(() => {
    if (
      !pendingReview ||
      pendingReview.error ||
      (pendingReview.remoteId !== undefined && pendingReview.remoteId !== repository?.remote?.id)
    )
      return
    if (
      pendingReview.generation !== navigationGeneration.current ||
      pendingReview.repositoryId !== repositoryId ||
      surface !== 'review'
    )
      return
    const row = snapshot.branches.find(
      (branch) =>
        branch.repositoryId === pendingReview.repositoryId &&
        branch.pullRequest?.number === pendingReview.number,
    )
    if (!row) return
    updateMemory(pendingReview.repositoryId, {
      selectedId: row.id,
      pullRequestId: row.pullRequest!.id,
    })
    setSurface('review')
    setPendingReview(null)
  }, [
    pendingReview,
    snapshot.branches,
    updateMemory,
    repositoryId,
    repository?.remote?.id,
    surface,
  ])
  /** Preparation reads exact selected context; it never opens or switches an ambient repository. */
  const captureOperationalTarget = async (
    target: InspectionContext = context,
    original?: OperationCapture,
  ) => {
    if (!desktop?.captureOperation || !target.worktreeId)
      throw new Error('Choose an explicit discovered execution worktree.')
    const capture = await desktop.captureOperation(target)
    if (
      original &&
      (!sameOperationScope(original.scope, capture.scope) ||
        original.directoryIdentity !== capture.directoryIdentity ||
        original.commonIdentity !== capture.commonIdentity ||
        original.gitDirectoryIdentity !== capture.gitDirectoryIdentity)
    )
      throw new Error(
        'The original physical directory or provider authority is unavailable; saved approval cannot be requalified.',
      )
    const generation = providerGeneration.current
    const api = inspectionAPI(
      desktop,
      {
        repositoryId: target.repositoryId,
        worktreeId: target.worktreeId,
        operationToken: capture.token,
      },
      () => providerGeneration.current === generation,
    )
    const value = await api.refresh()
    if (!sameOperationScope(capture.scope, await api.repositoryOperationScope()))
      throw new Error('The captured provider changed while preparing this workflow.')
    operationCapture.current = capture
    setApprovedCapture(capture)
    operationCaptureGeneration.current = generation
    operationScope.current = capture.scope
    operationContext.current = { ...target }
    setOperationSnapshot(value)
    return value
  }
  const prepareWorkflow = async (
    request: WorkflowRequest,
    target: InspectionContext = context,
    expectedScope?: OperationScope,
  ) => {
    if (!desktop || workflowAdmissionLock.current || actionLock.current.has(target.repositoryId))
      return false
    if (workflow?.kind === 'pr') {
      setError(
        'Close the captured PR form before opening another source. Authored input remains in that form.',
      )
      return false
    }
    workflowAdmissionLock.current = true
    setOperationBusy(true)
    try {
      if (
        expectedScope &&
        !sameOperationScope(
          expectedScope,
          await inspectionAPI(desktop, target).repositoryOperationScope(),
        )
      )
        throw new Error(
          'The original form authority changed; reopen its captured source explicitly.',
        )
      if (request.kind === 'pr') {
        const generation = providerGeneration.current
        const api = inspectionAPI(desktop, target, () => providerGeneration.current === generation)
        const scope = await api.repositoryOperationScope()
        const value = await api.refresh()
        if (!sameOperationScope(scope, await api.repositoryOperationScope()))
          throw new Error('The captured provider changed while opening this form.')
        setProviderWorkflow({ api, scope, target, generation })
        setOperationSnapshot(value)
      } else {
        setProviderWorkflow(null)
        await captureOperationalTarget(target)
      }
      setWorkflow(request)
      return true
    } catch (value) {
      setError(String(value))
      return false
    } finally {
      workflowAdmissionLock.current = false
      setOperationBusy(false)
    }
  }
  const dispatch = (action: WorkbenchAction, captured: WorkbenchActionContext) => {
    if (action === 'search') {
      setPaletteOpen(true)
      return
    }
    if (action === 'settings') {
      setSettingsOpen(true)
      return
    }
    if (action === 'attention' || action === 'activity') {
      retirePendingReview()
      inspectionNavigation.current += 1
      setReturnOrigin(captureOrigin())
      setSurface(action)
      setRepositoryId('')
      return
    }
    if (action === 'branches' || action === 'pull-requests') {
      navigate(captured.repositoryId || snapshot.repositories[0]?.id || '', action)
      return
    }
    if (action === 'discover') {
      void inventory.refetch()
      setDiscoveryWorktrees(true)
      return
    }
    if (action === 'refresh-metadata') {
      if (!desktop || !captured.repositoryId) return
      const generation = providerGeneration.current
      const current = () => providerGeneration.current === generation
      void inspectionAPI(desktop, { repositoryId: captured.repositoryId }, current)
        .refresh()
        .then(async (value) => {
          if (!current()) return
          setDetails((previous) =>
            current() ? { ...previous, [captured.repositoryId]: value } : previous,
          )
          if (current()) await inventory.refetch()
        })
        .catch((value) => {
          if (current()) setError(String(value))
        })
      return
    }
    if (action === 'reconcile') {
      if (!captured.worktreeId) {
        setExecutionChoice({ action, context: captured })
        setExecutionChoiceId('')
        return
      }
      void captureOperationalTarget({
        repositoryId: captured.repositoryId,
        worktreeId: captured.worktreeId,
      })
        .then(() => setReconciliationOpen(true))
        .catch((value) => setError(String(value)))
      return
    }
    if (captured.branchIds) {
      const repo = inventory.data?.repositories.find(
        (repo) => repo.identity.id === captured.repositoryId,
      )
      const ids = captured.branchIds
      if (!repo || !ids.length || new Set(ids).size !== ids.length) {
        setError('Choose an exact nonempty page-only branch subset without duplicates.')
        return
      }
      if (action === 'remove-worktree') {
        const targets = ids.map((id) => repo.worktrees.filter((tree) => tree.refId === id))
        if (targets.some((trees) => trees.length !== 1)) {
          setError(
            'Each selected branch must name exactly one worktree; ambiguous or branch-only targets require explicit directory selection.',
          )
          return
        }
        setLifecycle({
          repositoryId: repo.identity.id,
          mode: 'remove',
          worktreeIds: targets.map((trees) => trees[0].id),
        })
        return
      }
      if (action === 'delete-local' || action === 'delete-remote') {
        const refs = ids.map((id) => repo.refs.find((ref) => ref.id === id))
        const remote = action === 'delete-remote'
        if (refs.some((ref) => !ref || ref.kind !== (remote ? 'remote' : 'local'))) {
          setError(
            `Every selected target must be a qualified ${remote ? 'remote tracking' : 'local'} branch; no rejected target is dropped.`,
          )
          return
        }
        if (!captured.worktreeId) {
          setExecutionChoice({ action, context: { ...captured } })
          setExecutionChoiceId('')
          return
        }
        const branches = refs.map((ref) => ({ ref: ref!.name, expectedOid: ref!.oid }))
        void prepareWorkflow(
          {
            kind: 'confirm',
            action: remote
              ? { type: 'deleteRemoteBranches', branches }
              : { type: 'deleteBranches', branches, force: false },
            title: `Delete exact selected ${remote ? 'remote' : 'local'} branches`,
            description: `${branches.map((ref) => `${ref.ref} @ ${ref.expectedOid}`).join('; ')}. ${
              remote
                ? 'Every target must use the same configured remote and captured lease. Atomic multi-ref support is required; there is no non-atomic fallback or replay after an unknown outcome. Open collaborator PRs may close; local branches and directories remain.'
                : 'The entire batch is preflighted and deleted atomically or refused. Default/current/checked-out-in-any-worktree protections apply. Remote branches, directories and PRs remain.'
            }`,
            label: `Delete reviewed ${remote ? 'remote' : 'local'} branch subset`,
            destructive: true,
          },
          { repositoryId: repo.identity.id, worktreeId: captured.worktreeId },
        )
        return
      }
      setError('This batch action is not supported; no visible subset is substituted.')
      return
    }
    if (action === 'review') {
      const target = snapshot.branches.find(
        (branch) =>
          branch.repositoryId === captured.repositoryId &&
          branch.id === (captured.branchId ?? current.selectedId),
      )
      if (!target?.pullRequest) {
        setError('Choose the exact published PR association.')
        return
      }
      const origin = captureOrigin()
      setReturnOrigin(origin)
      navigate(captured.repositoryId, 'review', target.id)
      updateMemory(captured.repositoryId, {
        selectedId: target.id,
        surface: 'review',
        pullRequestId: target.pullRequest.id,
        reviewOrigin: origin,
      })
      return
    }
    if (action === 'history') {
      if (captured.branchId) {
        const saved = memoryRef.current[captured.repositoryId] ?? emptyRepositoryMemory
        navigate(captured.repositoryId, 'branches', captured.branchId)
        updateMemory(captured.repositoryId, {
          selectedId: captured.branchId,
          view: { ...saved.view, worktreeId: captured.worktreeId ?? null },
        })
      }
      setHistoryOpen(true)
      return
    }
    if (action === 'open-directory') {
      if (
        !scoped?.openInEditor ||
        !captured.worktreeId ||
        captured.worktreeId !== selectedTree?.id
      ) {
        setError('Choose an existing selected worktree first.')
        return
      }
      void scoped
        .openInEditor('.')
        .then((result) => {
          if (!result.opened) setError(result.reason)
        })
        .catch((value) => setError(String(value)))
      return
    }
    if (action === 'native-stack') {
      const pr = inventory.data?.repositories
        .find((repo) => repo.identity.id === captured.repositoryId)
        ?.pullRequests.find((pr) => pr.id === captured.pullRequestId)
      setNativeManagement({ repositoryId: captured.repositoryId, number: pr?.number })
      return
    }
    if (action === 'create-worktree' || action === 'remove-worktree') {
      if (!captured.repositoryId || (action === 'remove-worktree' && !captured.worktreeId)) {
        setError('Choose the exact qualified worktree directory subset.')
        return
      }
      setLifecycle({
        repositoryId: captured.repositoryId,
        mode: action === 'create-worktree' ? 'create' : 'remove',
        sourceRefId: captured.branchId,
        worktreeIds: captured.worktreeId ? [captured.worktreeId] : [],
      })
      return
    }
    if (action === 'unregister-worktree') {
      if (!captured.worktreeId) {
        setError('Choose the exact registered directory.')
        return
      }
      void prepareWorkflow(
        {
          kind: 'confirm',
          action: { type: 'unregisterWorktrees', worktreeIds: [captured.worktreeId] },
          title: 'Remove app registration only',
          description:
            'Remove only this captured directory from the recent repository registry. Its files, Git worktree administration, local branches and PRs remain unchanged.',
          label: 'Remove captured registration',
          destructive: true,
        },
        { repositoryId: captured.repositoryId, worktreeId: captured.worktreeId },
      )
      return
    }
    const branch = snapshot.branches.find(
      (row) =>
        row.repositoryId === captured.repositoryId &&
        row.id === (captured.branchId ?? selected?.id),
    )
    const worktreeId =
      captured.worktreeId ?? (branch?.id === selected?.id ? context.worktreeId : undefined)
    if (
      !branch ||
      (branch.refKind !== 'local' &&
        action !== 'delete-remote' &&
        action !== 'merge' &&
        action !== 'fetch')
    ) {
      setError('Choose an exact qualified target branch.')
      return
    }
    if (!worktreeId) {
      setExecutionChoice({ action, context: { ...captured, branchId: branch.id } })
      setExecutionChoiceId('')
      return
    }
    const target = {
      repositoryId: captured.repositoryId,
      refId: action === 'merge' ? undefined : branch.id,
      worktreeId,
      pullRequestId: branch.pullRequest?.id,
    }
    if (action === 'restack' || action === 'sync' || action === 'publish' || action === 'merge') {
      if (action === 'merge' && !branch.pullRequest) {
        setError('Choose the exact qualified reviewed PR.')
        return
      }
      void prepareWorkflow(
        {
          kind: 'stack',
          branch: branch.ref,
          operation: action,
          ...(action === 'merge' ? { pullRequest: branch.pullRequest!.number } : {}),
        },
        target,
      )
    } else if (action === 'fetch')
      void prepareWorkflow(
        {
          kind: 'confirm',
          action: { type: 'fetch' },
          title: 'Fetch Git refs',
          description:
            'Fetch all configured remotes and prune tracking refs in this explicit common repository. No checkout, pull, stash or restack.',
          label: 'Fetch Git refs',
        },
        target,
      )
    else if (action === 'rename' || action === 'parent' || action === 'upstream') {
      void (async () => {
        const value = await captureOperationalTarget(target)
        const selected = value.branches.find((item) => !item.remote && item.name === branch.ref)
        if (!selected) throw new Error('The captured qualified branch is unavailable.')
        setWorkflow({ kind: action, branch: selected })
      })().catch((value) => setError(String(value)))
    } else if (action === 'delete-local') {
      const ref = inventory.data?.repositories
        .find((repo) => repo.identity.id === captured.repositoryId)
        ?.refs.find((ref) => ref.id === branch.id)
      if (!ref) {
        setError('Captured branch tip is unavailable.')
        return
      }
      void prepareWorkflow(
        {
          kind: 'confirm',
          action: { type: 'deleteBranch', ref: ref.name, expectedOid: ref.oid, force: false },
          title: 'Delete local branch',
          description: `Delete only ${ref.name} at ${ref.oid}. Default/current/checked-out-in-any-worktree protections remain enforced; branch configuration cleanup is reported separately. No worktree or remote branch is deleted.`,
          label: 'Delete captured local branch',
          destructive: true,
        },
        target,
      )
    } else if (action === 'delete-remote') {
      const ref = inventory.data?.repositories
        .find((repo) => repo.identity.id === captured.repositoryId)
        ?.refs.find((ref) => ref.id === branch.id)
      if (!ref || ref.kind !== 'remote') {
        setError('Choose a qualified remote tracking ref.')
        return
      }
      void prepareWorkflow(
        {
          kind: 'confirm',
          action: { type: 'deleteRemoteBranch', ref: ref.name, expectedOid: ref.oid },
          title: 'Delete remote branch',
          description: `Delete ${ref.name} only under captured lease ${ref.oid}. Open collaborator PRs may close; local branches and directories remain. No automatic replay after an unknown response.`,
          label: 'Delete captured remote branch',
          destructive: true,
        },
        target,
      )
    } else if (action === 'insert-layer')
      void prepareWorkflow(
        { kind: 'surgery', request: { kind: 'insert', branch: branch.ref, name: '' } },
        target,
      )
    else if (action === 'move-layer')
      void prepareWorkflow(
        { kind: 'surgery', request: { kind: 'move', branch: branch.ref, target: '' } },
        target,
      )
    else if (action === 'remove-layer')
      void prepareWorkflow(
        { kind: 'surgery', request: { kind: 'remove', branch: branch.ref } },
        target,
      )
    else setError('Choose a qualified operational preview before changing repository state.')
  }
  const runCapturedAction = async (action: Parameters<DesktopAPI['runAction']>[0]) => {
    const localDomain =
      providerWorkflow?.target.repositoryId ?? operationContext.current?.repositoryId
    if (!localDomain || actionLock.current.has(localDomain)) return false
    if (providerWorkflow) {
      if (!['updatePr', 'closePr', 'reopenPr', 'linkIssue', 'unlinkIssue'].includes(action.type)) {
        setError('This form addresses provider PR management, not a local Git operation.')
        return false
      }
      actionLock.current.add(localDomain)
      updateRunningOperations()
      try {
        if (!providerWorkflow.api.pullRequestAction)
          throw new Error('Captured PR management is unavailable.')
        const providerAction = action as PullRequestAction
        const result = await providerWorkflow.api.pullRequestAction(
          providerAction,
          providerWorkflow.scope,
        )
        if (providerGeneration.current !== providerWorkflow.generation) return true
        const observedAt = new Date().toISOString()
        const number = 'number' in providerAction ? providerAction.number : providerAction.prNumber
        setEvents((events) =>
          [
            {
              id: crypto.randomUUID(),
              repository: operationSnapshot?.name ?? providerWorkflow.target.repositoryId,
              target: {
                repositoryId: providerWorkflow.target.repositoryId,
                pullRequestId: providerWorkflow.target.pullRequestId,
                number,
              },
              label: result.message,
              observedAt,
              eventAt: observedAt,
            },
            ...events,
          ].slice(0, LIST_PAGE_SIZE),
        )
        try {
          const refreshed = await providerWorkflow.api.refresh()
          if (
            providerGeneration.current !== providerWorkflow.generation ||
            !sameOperationScope(
              await providerWorkflow.api.repositoryOperationScope(),
              providerWorkflow.scope,
            )
          )
            return true
          setDetails((previous) => ({
            ...previous,
            [providerWorkflow.target.repositoryId]: refreshed,
          }))
          setOperationSnapshot((previous) =>
            previous === operationSnapshot ? refreshed : previous,
          )
          await inventory.refetch()
        } catch (value) {
          setError(`The provider action completed, but its follow-up read failed: ${String(value)}`)
        }
        return true
      } catch (value) {
        setError(String(value))
        return false
      } finally {
        actionLock.current.delete(localDomain)
        updateRunningOperations()
      }
    }
    const expected = operationScope.current
    const captured = operationContext.current
    if (!desktop || !operationSnapshot || !expected || !captured) {
      setError('Choose a captured operational repository first.')
      return false
    }
    actionLock.current.add(localDomain)
    updateRunningOperations()
    try {
      const approval = operationCapture.current
      if (!approval || !desktop.executeOperation)
        throw new Error(
          'This operation approval has already been spent. Review a fresh preview; uncertain writes are never replayed.',
        )
      const confirmed = await inspectionAPI(desktop, {
        repositoryId: captured.repositoryId,
        worktreeId: captured.worktreeId,
      }).repositoryOperationScope()
      if (!sameOperationScope(confirmed, expected))
        throw new Error('The captured provider changed; nothing was sent.')
      operationCapture.current = null
      const result = await desktop.executeOperation(approval.token, action)
      try {
        const snapshot = await inspectionAPI(desktop, {
          repositoryId: captured.repositoryId,
          worktreeId: captured.worktreeId,
        }).refresh()
        if (
          operationScope.current &&
          sameOperationScope(operationScope.current, expected) &&
          sameOperationScope(
            await inspectionAPI(desktop, {
              repositoryId: captured.repositoryId,
              worktreeId: captured.worktreeId,
            }).repositoryOperationScope(),
            expected,
          )
        )
          setOperationSnapshot((previous) =>
            previous?.path === expected.repositoryPath ? snapshot : previous,
          )
      } catch (value) {
        setError(
          `Action completed; the captured directory could not be refreshed: ${String(value)}`,
        )
      }
      return true
    } catch (value) {
      setError(String(value))
      return false
    } finally {
      actionLock.current.delete(localDomain)
      updateRunningOperations()
      void operationRecords.refetch()
      void inventory.refetch()
    }
  }
  const dispatchRef = React.useRef(dispatch)
  dispatchRef.current = dispatch
  React.useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKeyEvent(event) || isEditableTarget(event.target))
        return
      if (document.querySelector('[role="dialog"]')) return
      const id = (Object.keys(bindings) as ShortcutId[]).find((id) =>
        matchesChord(event, bindings[id], isMacPlatform()),
      )
      if (!id) return
      if (id === 'repository.next' || id === 'repository.previous') {
        const index = snapshot.repositories.findIndex((repo) => repo.id === repositoryId)
        const direction = id === 'repository.next' ? 1 : -1
        const target =
          snapshot.repositories[
            (index + direction + snapshot.repositories.length) % snapshot.repositories.length
          ]
        if (target) {
          event.preventDefault()
          navigate(target.id)
        }
        return
      }
      if (
        surface === 'branches' &&
        [
          'stack.selectParent',
          'stack.selectChild',
          'stack.selectTop',
          'stack.selectBottom',
        ].includes(id)
      ) {
        const topology = projectBranchLanes(
          snapshot.branches.filter((branch) => branch.repositoryId === repositoryId),
        )
        const selectedId = memoryRef.current[repositoryId]?.selectedId
        const byId = new Map(topology.map((entry) => [entry.branch.id, entry]))
        const children = new Map<string, (typeof topology)[number]>()
        for (const entry of topology)
          if (entry.parentId && !children.has(entry.parentId)) children.set(entry.parentId, entry)
        let target = selectedId ? byId.get(selectedId) : undefined
        if (target) {
          if (id === 'stack.selectParent')
            target = target.parentId ? byId.get(target.parentId) : undefined
          else if (id === 'stack.selectChild') target = children.get(target.branch.id)
          else if (id === 'stack.selectTop') {
            while (target && children.has(target.branch.id)) target = children.get(target.branch.id)
          } else {
            while (target?.parentId) target = byId.get(target.parentId)
          }
        }
        if (target) {
          event.preventDefault()
          updateMemory(repositoryId, {
            selectedId: target.branch.id,
            view: {
              ...(memoryRef.current[repositoryId] ?? emptyRepositoryMemory).view,
              worktreeId: null,
              tab: 'overview',
            },
          })
        }
        return
      }
      if (id === 'view.notifications') {
        event.preventDefault()
        setNotificationOpen(true)
        return
      }
      const action: Partial<Record<ShortcutId, WorkbenchAction>> = {
        'palette.open': 'search',
        'view.branches': 'branches',
        'view.pullRequests': 'pull-requests',
        'view.prInbox': 'attention',
        'view.review': 'review',
        'stack.openPr': 'review',
        'view.diagnostics': 'settings',
        'stack.restack': 'restack',
        'stack.sync': 'sync',
      }
      if (action[id]) {
        event.preventDefault()
        dispatchRef.current(action[id]!, { repositoryId })
        return
      }
      const command = {
        'review.nextFile': 'nextFile',
        'review.previousFile': 'previousFile',
        'review.nextLayer': 'nextLayer',
        'review.previousLayer': 'previousLayer',
      } as const
      if (id in command && surface === 'review') {
        event.preventDefault()
        reviewCommands.current?.[command[id as keyof typeof command]]()
        return
      }
      if (id === 'search.focus') {
        event.preventDefault()
        if (surface === 'attention') attentionSearch.current?.focus()
        else
          document
            .querySelector<HTMLInputElement>(
              '[aria-label="Filter branches by branch, PR, or path"]',
            )
            ?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [
    bindings,
    repositoryId,
    surface,
    snapshot.repositories,
    snapshot.branches,
    navigate,
    updateMemory,
  ])
  const setView = React.useCallback(
    (view: WorkbenchViewState) => updateMemory(repositoryId, { view }),
    [repositoryId, updateMemory],
  )
  const setWorktree = React.useCallback(
    (id: string | null) => {
      const current = memoryRef.current[repositoryId] ?? emptyRepositoryMemory
      if (id !== current.view.worktreeId)
        updateMemory(repositoryId, { view: { ...current.view, worktreeId: id } })
    },
    [repositoryId, updateMemory],
  )
  const select = (id: string) =>
    updateMemory(repositoryId, {
      selectedId: id,
      view: { ...current.view, worktreeId: null, tab: 'overview' },
    })
  const searchItems = React.useMemo(() => {
    const items: {
      id: string
      repositoryId: string
      branchId?: string
      worktreeId?: string
      label: string
      context: string
    }[] = snapshot.repositories.map((repo) => ({
      id: repo.id,
      repositoryId: repo.id,
      label: `${repo.owner}/${repo.name}`,
      context:
        inventory.data?.repositories
          .find((candidate) => candidate.identity.id === repo.id)
          ?.registeredPaths.join(' · ') ?? '',
    }))
    for (const branch of snapshot.branches) {
      const repo = snapshot.repositories.find((repo) => repo.id === branch.repositoryId)
      items.push({
        id: branch.id,
        repositoryId: branch.repositoryId,
        branchId: branch.id,
        label: `${branch.refKind ?? 'Published'} · ${branch.ref}${branch.pullRequest ? ` · #${branch.pullRequest.number} ${branch.title}` : ''}`,
        context: `${repo?.owner}/${repo?.name} · ${branch.worktrees.map((tree) => tree.path).join(' · ') || 'No worktree'}`,
      })
    }
    for (const repo of inventory.data?.repositories ?? []) {
      for (const tree of repo.worktrees)
        items.push({
          id: `worktree:${tree.id}`,
          repositoryId: repo.identity.id,
          branchId: snapshot.branches.find(
            (branch) =>
              branch.repositoryId === repo.identity.id &&
              (branch.id === tree.id || branch.worktrees.some((item) => item.id === tree.id)),
          )?.id,
          worktreeId: tree.kind === 'bare' ? undefined : tree.id,
          label: `${tree.kind === 'bare' ? 'Bare administrative repository' : 'Worktree'} · ${tree.path}`,
          context: `${repo.remote?.fullName ?? 'Local repository'} · ${tree.detached ? 'Detached HEAD' : (repo.refs.find((ref) => ref.id === tree.refId)?.name ?? 'No resolved branch')} · ${tree.missing ? 'Directory missing' : tree.status}`,
        })
    }
    const query = globalQuery.toLowerCase().trim()
    return items.filter(
      (item) => !query || `${item.label} ${item.context}`.toLowerCase().includes(query),
    )
  }, [snapshot, globalQuery, inventory.data])
  const notify = async (
    operation: (current: () => boolean) => Promise<NotificationInbox | undefined> | undefined,
    credential = false,
  ) => {
    if (notificationLock.current) return
    const generation = ++notificationGeneration.current
    const host = configuredHost.current
    const current = () =>
      generation === notificationGeneration.current && host === configuredHost.current
    notificationLock.current = true
    setNotificationBusy(true)
    const setFailure = credential ? setCredentialError : setNotificationError
    setFailure(null)
    try {
      const value = await operation(current)
      if (!current()) return
      if (!value) throw new Error('This Notifications action is unavailable in this runtime.')
      if (value.host === host) {
        setNotificationInbox(value)
        if (credential) setCredentialOpen(false)
      }
    } catch (value) {
      if (current()) setFailure(String(value))
    } finally {
      if (current()) {
        notificationLock.current = false
        setNotificationBusy(false)
      }
    }
  }
  const openCollaborationTarget = (target: CollaborationTarget) => {
    const origin = captureOrigin()
    setReturnOrigin(origin)
    if (target.number !== undefined) {
      const row = snapshot.branches.find(
        (branch) =>
          branch.repositoryId === target.repositoryId &&
          (target.pullRequestId
            ? branch.pullRequest?.id === target.pullRequestId
            : branch.pullRequest?.number === target.number),
      )
      navigate(target.repositoryId, 'review', row?.id)
      updateMemory(target.repositoryId, {
        surface: 'review',
        selectedId: row?.id ?? null,
        pullRequestId: row?.pullRequest?.id ?? null,
        reviewOrigin: origin,
      })
      if (!row)
        setPendingReview({
          repositoryId: target.repositoryId,
          number: target.number,
          generation: navigationGeneration.current,
        })
    } else {
      navigate(target.repositoryId, 'branches', target.branchId, target.worktreeId)
    }
  }
  const attention = React.useMemo(
    () => attentionItems(inventory.data, snapshot, inbox.data),
    [inventory.data, snapshot, inbox.data],
  )
  const attentionStatus = [
    inbox.data?.refresh.detail ?? 'Viewer-relative provider attention has not been confirmed',
    inventory.data?.state === 'complete'
      ? 'Local inventory complete'
      : 'Local inventory incomplete',
    ...(inventory.data?.failures.map((failure) => failure.error) ?? []),
    ...(inventory.data?.repositories
      .filter((repo) => repo.remote && repo.remoteFreshness?.state !== 'fresh')
      .map(
        (repo) =>
          `${repo.remote!.fullName}: ${repo.remoteFreshness?.detail ?? 'remote facts not current'}`,
      ) ?? []),
    ...(inventory.data?.repositories
      .filter((repo) => repo.dependenciesRead?.state !== 'complete')
      .map(
        (repo) =>
          `${repo.remote?.fullName ?? 'Local repository'}: ${repo.dependenciesRead?.error ?? 'dependency observations incomplete'}`,
      ) ?? []),
    ...(inbox.data?.refresh.repositories
      .filter((repo) => repo.status !== 'ok')
      .map((repo) => `${repo.repository}: ${repo.detail}`) ?? []),
    ...(inbox.data?.items.some((item) => item.reviewBaselineState === 'unavailable')
      ? ['Confirmed review baseline unavailable; changed-head attention is unknown']
      : []),
  ].join(' · ')
  const attentionComplete =
    inventory.data?.state === 'complete' &&
    inbox.data?.refresh.state === 'fresh' &&
    inbox.data.refresh.repositories.every((repo) => repo.status === 'ok' && Boolean(repo.viewer)) &&
    inbox.data.items.every(
      (item) =>
        item.state !== 'OPEN' ||
        (item.metadata === 'full' &&
          Boolean(item.headOid) &&
          Boolean(item.author) &&
          item.reviewRequestsComplete !== false &&
          item.checksKnown !== false &&
          item.reviewKnown !== false &&
          item.reviewBaselineState !== 'unavailable'),
    ) &&
    inventory.data.repositories.every(
      (repo) =>
        repo.dependenciesRead?.state === 'complete' &&
        repo.worktrees.every((tree) => tree.kind === 'bare' || tree.read.state === 'complete'),
    )
  const collaborationSnapshot = {
    ...snapshot,
    globalCounts: {
      readyToMerge: snapshot.globalCounts?.readyToMerge ?? null,
      attention: attentionComplete ? attention.length : null,
    },
    repositories: snapshot.repositories.map((repo) => ({
      ...repo,
      attentionCount: attentionComplete
        ? attention.filter((item) => item.target.repositoryId === repo.id).length
        : null,
    })),
  }
  const mainPanel = (
    <WorkbenchPane
      className="bw-main wb-secondary"
      style={surface === 'branches' ? { display: 'none' } : undefined}
      role="main"
      aria-label={surface}
      header={
        surface === 'review' || surface === 'branches' ? null : (
          <div className="bw-panel-head">
            <h1>
              {surface === 'pull-requests'
                ? 'Pull requests'
                : surface === 'attention'
                  ? 'Needs attention'
                  : 'Activity'}
            </h1>
            {returnOrigin || current.reviewOrigin ? (
              <Button size="sm" variant="ghost" onClick={returnToOrigin}>
                Return to origin
              </Button>
            ) : null}
          </div>
        )
      }
    >
      <div
        className="h-full min-h-0 min-w-0 flex-1"
        style={surface === 'review' ? undefined : { display: 'none' }}
      >
        {(surface === 'review' || current.pullRequestId !== null) &&
        reviewAPI &&
        repository &&
        repoRead.data ? (
          <ReviewView
            authority={authority}
            desktop={reviewAPI}
            pullRequests={repository.pullRequests.map((pr) => pr.facts)}
            stackContext={repoRead.data}
            number={reviewBranch?.pullRequest?.number ?? null}
            onSelectNumber={(number) => {
              const row = snapshot.branches.find(
                (branch) =>
                  branch.repositoryId === repositoryId && branch.pullRequest?.number === number,
              )
              if (row) {
                updateMemory(repositoryId, {
                  selectedId: row.id,
                  pullRequestId: row.pullRequest!.id,
                  view: { ...current.view, worktreeId: null },
                })
                return
              }
              const sourceNumber = reviewBranch?.pullRequest?.number
              if (!desktop || !sourceNumber) {
                setError('Captured native-layer reading is unavailable.')
                return
              }
              const generation = providerGeneration.current
              const api = inspectionAPI(
                desktop,
                reviewContext,
                () => providerGeneration.current === generation,
              )
              if (!api.pullRequestLayer) {
                setError('Captured native-layer reading is unavailable.')
                return
              }
              updateMemory(repositoryId, {
                selectedId: null,
                pullRequestId: null,
                view: { ...current.view, worktreeId: null },
              })
              const navigation = navigationGeneration.current
              setPendingReview({
                repositoryId,
                number,
                generation: navigation,
                remoteId: repository.remote?.id,
              })
              void api.pullRequestLayer(sourceNumber, number).catch((cause) => {
                if (
                  providerGeneration.current !== generation ||
                  navigationGeneration.current !== navigation
                )
                  return
                const message = cause instanceof Error ? cause.message : String(cause)
                setPendingReview((pending) =>
                  pending?.generation === navigation ? { ...pending, error: message } : pending,
                )
              })
            }}
            onManageNumber={(number) => {
              const target = repository.pullRequests.find((pr) => pr.number === number)
              if (target)
                void prepareWorkflow(
                  { kind: 'pr', number },
                  { repositoryId, pullRequestId: target.id },
                )
              else setError('Choose a currently registered source-qualified pull request.')
            }}
            onMergeNumber={(number) => {
              const row = snapshot.branches.find(
                (row) => row.repositoryId === repositoryId && row.pullRequest?.number === number,
              )
              if (row)
                dispatch('merge', {
                  repositoryId,
                  branchId: row.id,
                  pullRequestId: row.pullRequest!.id,
                })
              else
                setError(
                  'The exact reviewed provider PR is no longer available in this source repository.',
                )
            }}
            commands={reviewCommands}
            busy={operationBusy}
            observedPullRequest={
              repository.pullRequests.find((pr) => pr.id === current.pullRequestId)?.facts ?? null
            }
            returnContext={{ label: 'Return to origin', onReturn: returnToOrigin }}
          />
        ) : surface === 'review' ? (
          <p>
            {pendingReview
              ? pendingReview.error
                ? `Could not open qualified PR #${pendingReview.number}: ${pendingReview.error}`
                : `Loading qualified PR #${pendingReview.number} in the selected repository…`
              : 'Choose a qualified pull request.'}{' '}
            {repoRead.error?.message}
          </p>
        ) : null}
      </div>
      {surface !== 'review' &&
        (surface === 'attention' ? (
          <AttentionView
            items={attention}
            repositories={[
              ...new Set(
                inventory.data?.repositories.map((repo) =>
                  repo.remote
                    ? `${repo.remote.host}/${repo.remote.fullName}`
                    : repo.registeredPaths[0],
                ) ?? [],
              ),
            ].sort()}
            sourceStatus={attentionStatus}
            loading={inbox.isFetching}
            error={inbox.error?.message ?? error}
            filter={attentionFilter}
            onFilterChange={setAttentionFilter}
            state={attentionState}
            onStateChange={setAttentionState}
            savedFilters={inboxFilters.isFetching ? [] : (inboxFilters.data ?? [])}
            saving={savingInboxFilters || !inboxFilters.isSuccess || inboxFilters.isFetching}
            searchInputRef={attentionSearch}
            onRefresh={() => void inbox.refetch()}
            onOpen={openCollaborationTarget}
            onSaveFilters={async (drafts) => {
              if (!desktop?.savePullRequestInboxFilters)
                throw new Error('Saved attention filters are unavailable.')
              if (inboxFilterLock.current)
                throw new Error('A saved-filter write is already in progress.')
              inboxFilterLock.current = true
              setSavingInboxFilters(true)
              try {
                const confirmed = await desktop.savePullRequestInboxFilters(drafts)
                client.setQueryData(['workbench-attention-filters'], confirmed)
                return confirmed
              } finally {
                inboxFilterLock.current = false
                setSavingInboxFilters(false)
              }
            }}
          />
        ) : surface === 'activity' ? (
          <ActivityView
            events={[
              ...(operationRecords.data ?? []).map((record) => ({
                id: `operation:${record.id}`,
                repository: record.worktreePath,
                target: {
                  repositoryId: record.repositoryId,
                  branchId: record.context.refId,
                  worktreeId: record.context.worktreeId,
                },
                label: `${record.resolution ?? record.state}: ${record.message}`,
                observedAt: record.updatedAt,
                eventAt: record.startedAt,
              })),
              ...events,
            ]}
            repositories={snapshot.repositories}
            onOpen={openCollaborationTarget}
            state={activityState}
            onStateChange={setActivityState}
          />
        ) : (
          <PullRequestList
            repository={repository}
            source={prPage.data}
            pending={prPage.isFetching}
            state={{
              query: current.pullRequestQuery,
              lifecycle: current.pullRequestLifecycle,
              page: current.pullRequestPage,
              scroll: current.pullRequestScroll,
              cursor: current.pullRequestCursor,
            }}
            onChange={(state) =>
              updateMemory(repositoryId, {
                pullRequestQuery: state.query,
                pullRequestLifecycle: state.lifecycle,
                pullRequestPage: state.page,
                pullRequestScroll: state.scroll,
                pullRequestCursor: state.cursor,
              })
            }
            onOpen={openCollaborationTarget}
            onCreate={() => {
              if (!repository) return
              const openPullRequests = new Set<string>()
              for (const pr of repository.pullRequests)
                if (pr.facts.state === 'OPEN') openPullRequests.add(pr.id)
              const branches: { id: string; name: string }[] = []
              for (const ref of repository.refs)
                if (
                  ref.kind === 'local' &&
                  !ref.pullRequestIds.some((id) => openPullRequests.has(id))
                )
                  branches.push({ id: ref.id, name: ref.name.replace(/^refs\/heads\//, '') })
              setCreatePrTarget({ repositoryId, branches })
              setCreatePrRef(branches[0]?.id ?? '')
            }}
            error={prPage.error?.message ?? repoRead.error?.message ?? null}
          />
        ))}
    </WorkbenchPane>
  )
  if (!desktop)
    return (
      <main>
        <h1>Git Stacks</h1>
        <p>
          The production desktop bridge is unavailable. Open the Electron application for repository
          inspection.
        </p>
      </main>
    )
  return (
    <>
      <BranchWorkbench
        key={repositoryId}
        density={settings?.appearance.density ?? 'compact'}
        densityDisabled={
          densityWrite.isPending ||
          !settingsRead.isSuccess ||
          settingsRead.data?.locks.some((lock) => lock.key === 'appearance.density')
        }
        onDensityChange={(density) =>
          void densityWrite.mutateAsync(density).catch((value) => setError(String(value)))
        }
        snapshot={collaborationSnapshot}
        repositoryId={repositoryId}
        selectedBranchId={current.selectedId}
        viewState={current.view}
        onViewStateChange={setView}
        onWorktreeChange={setWorktree}
        resolveCopyPath={async (captured) => {
          if (!desktop.inspect || !captured.worktreeId)
            throw new Error('Choose an existing captured directory first.')
          const root = inspectionAPI(desktop, {
            repositoryId: captured.repositoryId,
            refId:
              captured.branchId && repository?.refs.some((ref) => ref.id === captured.branchId)
                ? captured.branchId
                : undefined,
            worktreeId: captured.worktreeId,
          })
          return (await root.repositoryOperationScope()).repositoryPath
        }}
        surface={surface}
        mainPanel={mainPanel}
        topUtilities={
          <Button variant="ghost" onClick={() => setNotificationOpen(true)}>
            Notifications
          </Button>
        }
        capabilities={{
          search: {},
          settings: {},
          attention: {},
          activity: {},
          branches: {},
          'pull-requests': {},
          discover: {},
          review: selected?.pullRequest ? {} : { reason: 'No selected pull request' },
          history:
            selectedRefId || selectedLocalFact?.headOid
              ? {}
              : { reason: 'No committed local revision in this context' },
          'open-directory':
            selectedTree && !selectedLocalFact?.missing
              ? {}
              : {
                  reason: selectedLocalFact?.missing
                    ? 'Selected directory is missing'
                    : 'Choose an existing worktree',
                },
          ...(repository
            ? {
                restack: {},
                sync: {},
                publish: {},
                'native-stack': {},
                'delete-remote': {},
                'move-layer': {},
              }
            : {}),
          'create-worktree': repository ? {} : { reason: 'Choose a repository' },
          'remove-worktree': selectedTree ? {} : { reason: 'Choose an exact worktree directory' },
          fetch: repository ? {} : { reason: 'Choose a repository' },
          'refresh-metadata': repository ? {} : { reason: 'Choose a repository' },
          reconcile: repository ? {} : { reason: 'Choose a repository' },
          rename: repository ? {} : { reason: 'Choose a qualified local branch' },
          parent: repository ? {} : { reason: 'Choose a qualified local branch' },
          upstream: repository ? {} : { reason: 'Choose a qualified local branch' },
          merge: repository ? {} : { reason: 'Choose a qualified reviewed PR' },
          'delete-local': repository ? {} : { reason: 'Choose a qualified local branch' },
          'insert-layer': repository ? {} : { reason: 'Choose a qualified local branch' },
          'remove-layer': repository ? {} : { reason: 'Choose a qualified local branch' },
          'unregister-worktree': selectedTree
            ? {}
            : { reason: 'Choose an exact registered directory' },
        }}
        onRepositoryChange={(id) => navigate(id)}
        onSelectionChange={select}
        onAction={dispatch}
        sidebarUtilities={
          <>
            <Button variant="ghost" onClick={() => setLocalRepositoryOpen(true)}>
              Add repository
            </Button>
            <Button variant="ghost" onClick={() => setDiscoveryOpen(true)}>
              Find and clone
            </Button>
            <Button variant="ghost" onClick={() => setRecoveryOpen(true)}>
              Operations and recovery
              {retainedOperationCount ? ` · ${retainedOperationCount} retained` : ''}
            </Button>
            {repository?.worktrees
              .filter((tree) => tree.operation)
              .slice(0, LIST_PAGE_SIZE)
              .map((tree) => (
                <Button
                  key={tree.id}
                  variant="ghost"
                  onClick={() => {
                    const saved = memoryRef.current[repositoryId] ?? emptyRepositoryMemory
                    const branch = snapshot.branches.find(
                      (branch) =>
                        branch.repositoryId === repositoryId &&
                        branch.worktrees.some((item) => item.id === tree.id),
                    )
                    navigate(repositoryId, 'branches', branch?.id)
                    updateMemory(repositoryId, {
                      selectedId: branch?.id ?? null,
                      view: { ...saved.view, worktreeId: tree.id },
                    })
                    setRecoveryOpen(true)
                  }}
                >
                  Recovery · {tree.operation} · {tree.path}
                </Button>
              ))}
            {operationContext.current ? (
              <Button
                variant="ghost"
                onClick={() => {
                  const target = operationContext.current!
                  const saved = memoryRef.current[target.repositoryId] ?? emptyRepositoryMemory
                  navigate(target.repositoryId, 'branches', target.refId ?? target.worktreeId)
                  updateMemory(target.repositoryId, {
                    selectedId: target.refId ?? target.worktreeId ?? null,
                    view: { ...saved.view, worktreeId: target.worktreeId ?? null },
                  })
                  setRecoveryOpen(true)
                }}
              >
                Inspect captured operation
              </Button>
            ) : null}
          </>
        }
        detailPanels={
          scoped
            ? {
                overview: (
                  <section className="bw-section">
                    <h3>Directory observations</h3>
                    <p>
                      <code>{selectedLocalFact?.path ?? 'No selected working directory'}</code>
                    </p>
                    <p>
                      Local HEAD:{' '}
                      <code>{selectedLocalFact?.headOid?.slice(0, 7) ?? 'Not observed'}</code>
                      {' · '}
                      {selectedLocalFact?.missing
                        ? 'Directory missing'
                        : (selectedTree?.status.label ?? 'Status unknown')}
                    </p>
                    {selectedLocalFact?.headOid ? (
                      <details>
                        <summary>Full local revision</summary>
                        <code>{selectedLocalFact.headOid}</code>
                      </details>
                    ) : null}
                    <p>
                      Index: {selectedLocalFact?.indexSignature ? 'Observed' : 'Not observed'}
                      {' · '}
                      {selectedLocalFact?.read.state ?? 'Unknown'}
                      {selectedLocalFact?.read.observedAt ? (
                        <>
                          {' '}
                          ·{' '}
                          <time dateTime={selectedLocalFact.read.observedAt}>
                            {new Date(selectedLocalFact.read.observedAt).toLocaleString()}
                          </time>
                        </>
                      ) : null}
                    </p>
                    {selectedLocalFact?.locked || selectedLocalFact?.prunable ? (
                      <p>
                        Administrative state: {selectedLocalFact.locked ?? 'Not locked'} ·{' '}
                        {selectedLocalFact.prunable ?? 'Not prunable'}
                      </p>
                    ) : null}
                    <p>
                      Published PR head:{' '}
                      <code>{selected?.pullRequest?.publishedHead ?? 'Unknown / no PR'}</code>
                    </p>
                    <p>
                      Upstream:{' '}
                      <code>
                        {repository?.refs.find(
                          (ref) =>
                            ref.id ===
                            repository.refs.find((ref) => ref.id === selected?.id)?.upstream,
                        )?.name ?? 'Missing / unknown'}
                      </code>
                    </p>
                    <p>
                      Published base:{' '}
                      <code>{selected?.pullRequest?.baseRef ?? 'Unknown / no PR'}</code>
                    </p>
                    <p>
                      Native stack:{' '}
                      {selected?.pullRequest?.nativeMembership
                        ? `#${selected.pullRequest.nativeMembership.stackNumber} · ${selected.pullRequest.nativeMembership.position} of ${selected.pullRequest.nativeMembership.total}`
                        : 'No confirmed membership'}
                    </p>
                    <p>
                      Dependency parent:{' '}
                      <code>
                        {selected?.parentId
                          ? snapshot.branches.find((branch) => branch.id === selected.parentId)?.ref
                          : (selected?.parentIssue ?? 'No observed parent')}
                      </code>
                    </p>
                    {selectedLocalFact?.operation ? (
                      <p>
                        Operational recovery remains associated with {selectedLocalFact.path}:{' '}
                        {selectedLocalFact.operation}. No implicit Continue or Abort.
                      </p>
                    ) : null}
                  </section>
                ),
                changes: selectedLocalFact?.missing ? (
                  <p>
                    The selected directory is missing. Published review remains available; no other
                    directory is substituted.
                  </p>
                ) : selectedTree ? (
                  <LocalInspection
                    api={scoped}
                    identity={identity}
                    revision={JSON.stringify([
                      selectedLocalFact?.headOid,
                      selectedLocalFact?.indexSignature,
                      selectedLocalFact?.read.observedAt,
                    ])}
                    snapshot={local.data}
                    loading={local.isFetching}
                    error={local.error}
                  />
                ) : (
                  <p>
                    {selected?.worktrees.length
                      ? 'Choose an explicit working directory in Overview.'
                      : 'No worktree. Published committed changes remain available in full PR review; they are not local changes.'}
                  </p>
                ),
                checks: published ? (
                  <PublishedInspection
                    api={published}
                    identity={authority}
                    number={selected?.pullRequest?.number ?? null}
                    tab="checks"
                    head={selected?.pullRequest?.publishedHead ?? null}
                    onReview={reviewSelected}
                  />
                ) : null,
                discussion: published ? (
                  <PublishedInspection
                    api={published}
                    identity={authority}
                    number={selected?.pullRequest?.number ?? null}
                    tab="discussion"
                    head={selected?.pullRequest?.publishedHead ?? null}
                    onReview={reviewSelected}
                  />
                ) : null,
              }
            : undefined
        }
      />
      <UnsentReviewChangesNotice />
      {error || inventory.error || repoRead.error ? (
        <div className="wb-error" role="alert">
          {error ?? inventory.error?.message ?? repoRead.error?.message}
          <Button size="xs" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Global search</DialogTitle>
            <DialogDescription>
              Repository, qualified branch, worktree path or pull request. Navigation never checks
              out or creates a directory.
            </DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false}>
            <CommandInput
              autoFocus
              aria-label="Global search"
              value={globalQuery}
              onValueChange={setGlobalQuery}
            />
            {!searchReady || inventory.isFetching ? (
              <p role="status">Searching observed inventory…</p>
            ) : null}
            {inventory.error ? <p role="alert">{inventory.error.message}</p> : null}
            <CommandList className="wb-search-results">
              {selected
                ? (
                    [
                      ['refresh-metadata', 'Refresh selected repository metadata'],
                      ['fetch', 'Preview Git Fetch'],
                      ['restack', 'Preview selected Restack'],
                      ['sync', 'Preview selected Sync'],
                      ['publish', 'Preview selected Publish / Submit'],
                      ['merge', 'Preview reviewed downstack merge'],
                      ['reconcile', 'Inspect source discrepancies and repairs'],
                      ['delete-local', 'Preview protected local branch deletion'],
                      ['delete-remote', 'Preview leased remote branch deletion'],
                    ] as const
                  )
                    .filter(([action]) =>
                      action === 'delete-local'
                        ? selected.refKind === 'local'
                        : action === 'delete-remote'
                          ? selected.refKind === 'remote'
                          : true,
                    )
                    .filter(([, label]) => label.toLowerCase().includes(globalQuery.toLowerCase()))
                    .map(([action, label]) => (
                      <CommandItem
                        key={action}
                        value={action}
                        onSelect={() => {
                          const target = {
                            repositoryId,
                            branchId: selected.id,
                            worktreeId: context.worktreeId,
                            pullRequestId: selected.pullRequest?.id,
                          }
                          setPaletteOpen(false)
                          dispatch(action, target)
                        }}
                      >
                        {label} · {selected.ref}
                      </CommandItem>
                    ))
                : null}
              {searchReady && !inventory.isPending ? (
                <CommandEmpty>No matching observed objects.</CommandEmpty>
              ) : null}
              {searchReady
                ? searchItems
                    .slice(globalPage * LIST_PAGE_SIZE, (globalPage + 1) * LIST_PAGE_SIZE)
                    .map((item) => (
                      <CommandItem
                        key={item.id}
                        value={item.id}
                        onSelect={() => {
                          navigate(item.repositoryId, 'branches', item.branchId, item.worktreeId)
                          setPaletteOpen(false)
                        }}
                      >
                        <span>
                          {item.label}
                          <small>{item.context}</small>
                        </span>
                      </CommandItem>
                    ))
                : null}
            </CommandList>
          </Command>
          <p>{searchItems.length} observed results; omitted backend data remains unknown.</p>
          <Button disabled={!globalPage} onClick={() => setGlobalPage(globalPage - 1)}>
            Previous results
          </Button>
          <Button
            disabled={(globalPage + 1) * LIST_PAGE_SIZE >= searchItems.length}
            onClick={() => setGlobalPage(globalPage + 1)}
          >
            Next results
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={discoveryWorktrees} onOpenChange={setDiscoveryWorktrees}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discovered existing worktrees</DialogTitle>
            <DialogDescription>
              Read-only discovery. Adoption registers an existing directory, without checkout or
              creation.
            </DialogDescription>
          </DialogHeader>
          {repository?.worktrees
            .slice(discoveryPage * LIST_PAGE_SIZE, (discoveryPage + 1) * LIST_PAGE_SIZE)
            .map((tree) => (
              <div key={tree.id}>
                <code>{tree.path}</code>
                <p>
                  {tree.kind} · {tree.detached ? 'Detached HEAD' : tree.headOid} ·{' '}
                  {tree.missing ? 'Missing directory' : tree.status} ·{' '}
                  {tree.locked ?? 'No administrative lock'}
                </p>
                <Button
                  disabled={tree.missing || tree.kind === 'bare'}
                  onClick={() =>
                    void desktop
                      .adoptWorktrees?.([tree.id], crypto.randomUUID())
                      .then(() => inventory.refetch())
                      .catch((value) => setError(String(value)))
                  }
                >
                  Adopt existing directory
                </Button>
              </div>
            ))}
          <p>{repository?.discovery.state ?? 'Unknown'} discovery</p>
          <Button disabled={!discoveryPage} onClick={() => setDiscoveryPage(discoveryPage - 1)}>
            Previous directories
          </Button>
          <span>Page {discoveryPage + 1}</span>
          <Button
            disabled={(discoveryPage + 1) * LIST_PAGE_SIZE >= (repository?.worktrees.length ?? 0)}
            onClick={() => setDiscoveryPage(discoveryPage + 1)}
          >
            Next directories
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="wb-history-dialog">
          <DialogHeader>
            <DialogTitle>Selected committed history</DialogTitle>
            <DialogDescription>Read-only context, independent of checkout.</DialogDescription>
          </DialogHeader>
          {scoped && selected ? (
            <ContextHistory
              key={identity}
              api={scoped}
              identity={identity}
              ref={repository?.refs.find((ref) => ref.id === selected.id)?.name ?? 'HEAD'}
            />
          ) : (
            <p>Select a qualified branch or worktree.</p>
          )}
        </DialogContent>
      </Dialog>
      <LocalRepositoryDialog
        desktop={desktop}
        open={localRepositoryOpen}
        onOpenChange={setLocalRepositoryOpen}
        onClone={() => setDiscoveryOpen(true)}
        onOpened={(value) => {
          void inventory
            .refetch()
            .then((result) => {
              const repo = result.data?.repositories.find((repo) =>
                repo.registeredPaths.includes(value.path),
              )
              if (!repo) {
                setError('The opened repository was not confirmed in the inventory.')
                return
              }
              navigate(repo.identity.id, 'branches')
            })
            .catch((value) => setError(String(value)))
        }}
      />
      <Dialog
        open={createPrTarget !== null}
        onOpenChange={(open) => {
          if (!open && !operationBusy) setCreatePrTarget(null)
        }}
      >
        <DialogContent className="wb-local-repository-dialog">
          <DialogHeader>
            <DialogTitle>Create a pull request</DialogTitle>
            <DialogDescription>
              Choose an existing unpublished branch. The next preview captures its exact head,
              dependencies and published destination; it never checks out or creates a worktree.
            </DialogDescription>
          </DialogHeader>
          <Select
            disabled={operationBusy}
            aria-label="Unpublished branch"
            value={createPrRef}
            onValueChange={setCreatePrRef}
            options={
              createPrTarget?.branches.map((branch) => ({
                value: branch.id,
                label: branch.name,
              })) ?? []
            }
          />
          {!createPrTarget?.branches.length ? (
            <p>
              No observed unpublished local branch is available. Create your development branch in
              an external tool, then refresh the inventory.
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <Button
            loading={operationBusy}
            disabled={!createPrRef || operationBusy}
            onClick={async () => {
              const branch = createPrTarget?.branches.find((branch) => branch.id === createPrRef)
              if (!branch || !createPrTarget) return
              setCreatePrTarget(null)
              setExecutionChoice({
                action: 'publish',
                context: { repositoryId: createPrTarget.repositoryId, branchId: branch.id },
              })
              setExecutionChoiceId('')
            }}
          >
            Preview publication
          </Button>
        </DialogContent>
      </Dialog>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        desktop={desktop}
        cliStatus={cliStatus}
        cliRefreshing={cliRefreshing}
        onReadCliStatus={() => {
          const generation = ++cliReadGeneration.current
          const host = configuredHost.current
          setCliRefreshing(true)
          void desktop
            .githubCliStatus?.()
            .then((value) => {
              if (generation === cliReadGeneration.current && host === configuredHost.current)
                setCliStatus(value)
            })
            .catch((value) => {
              if (generation === cliReadGeneration.current && host === configuredHost.current)
                setError(String(value))
            })
            .finally(() => {
              if (generation === cliReadGeneration.current) setCliRefreshing(false)
            })
        }}
        onSettingsChange={setSettings}
        shortcutBindings={bindings}
        onShortcutBindingsChange={setBindings}
        onError={setError}
      />
      <RepositoryDiscoveryDialog
        open={discoveryOpen}
        onOpenChange={setDiscoveryOpen}
        authority={JSON.stringify(cliStatus)}
        busy={false}
        cliStatus={cliStatus}
        onCloned={() => {
          setDiscoveryOpen(false)
          void inventory.refetch()
        }}
        onOpenCliStatus={() => setSettingsOpen(true)}
      />
      <Dialog open={notificationOpen} onOpenChange={setNotificationOpen}>
        <DialogContent className="wb-history-dialog">
          <DialogTitle>Optional Notifications</DialogTitle>
          <NotificationCenterView
            busy={notificationBusy}
            error={notificationError}
            inbox={notificationInbox}
            onDismissError={() => setNotificationError(null)}
            onRefresh={() => void notify(() => desktop.refreshNotifications?.())}
            onMarkAllRead={() => void notify(() => desktop.markNotificationRead?.('all'))}
            onMarkRead={(id) => void notify(() => desktop.markNotificationRead?.(id))}
            onMarkDone={(id) => void notify(() => desktop.markNotificationDone?.(id))}
            onSubscribe={(thread, action) =>
              void notify(() => desktop.setNotificationSubscription?.(thread.id, action))
            }
            onOpenThread={(thread: NotificationThread) => {
              if (thread.url)
                void desktop.openExternal(thread.url).catch((value) => setError(String(value)))
            }}
            onOpenCredential={() => {
              setCredentialError(null)
              setCredentialOpen(true)
            }}
            onRemoveCredential={() =>
              void notify(async (current) => {
                await desktop.removeNotificationCredential?.()
                if (current()) return desktop.notifications?.()
              })
            }
          />
        </DialogContent>
      </Dialog>
      <Dialog open={reconciliationOpen} onOpenChange={setReconciliationOpen}>
        <DialogContent className="wb-history-dialog">
          <DialogHeader>
            <DialogTitle>Source discrepancies and explicit repairs</DialogTitle>
            <DialogDescription>
              Refresh reports facts without repairing refs, PR bases or native membership. Choose
              exact repair IDs and review their real backend effects.
            </DialogDescription>
          </DialogHeader>
          {operationSnapshot && operationApi ? (
            <ReconciliationPanel
              snapshot={operationSnapshot}
              desktop={operationApi}
              authority={operationScope.current?.authority ?? ''}
              busy={operationBusy}
              runAction={runCapturedAction}
              actionError={error}
              onClearActionError={() => setError(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
        <DialogContent className="wb-history-dialog">
          <DialogHeader>
            <DialogTitle>Repository-qualified operations and recovery</DialogTitle>
            <DialogDescription>
              Browsing does not abort, replay or retarget an operation.
            </DialogDescription>
          </DialogHeader>
          {operationRecords.error ? (
            <p role="alert">
              Persistent operation status unavailable: {operationRecords.error.message}
            </p>
          ) : null}
          {operationRecords.isPending ? (
            <p role="status">Loading original operation status…</p>
          ) : null}
          {operationRecords.data?.length === 0 ? (
            <p>No retained operations for currently available original authorities.</p>
          ) : null}
          <ol className="grid max-h-[65vh] gap-3 overflow-auto">
            {(operationRecords.data ?? []).map((record) => (
              <li key={record.id} className="grid min-w-0 gap-2 rounded-md border p-3">
                <strong>
                  {record.action.type}
                  {record.preview && 'kind' in record.preview ? ` (${record.preview.kind})` : ''} ·{' '}
                  {record.resolution ?? record.state}
                </strong>
                <code className="break-all text-xs">{record.worktreePath}</code>
                <p>{record.message}</p>
                {record.stackProgress ? (
                  <p>
                    Completed: {record.stackProgress.completed.join(', ') || 'none'}; remaining:{' '}
                    {record.stackProgress.remaining.join(', ') || 'none'}.{' '}
                    {record.stackProgress.message}
                  </p>
                ) : null}
                {record.publication ? (
                  <ol>
                    {record.publication.steps.map((step, index) => (
                      <li key={index}>
                        {step.label}: {step.status} · {step.detail}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {record.result?.worktreeLifecycle ? (
                  <ol>
                    {record.result.worktreeLifecycle.targets.map((target) => (
                      <li key={target.path}>
                        {target.path}: {target.state} · {target.detail}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {record.result?.merge ? (
                  <ol>
                    {record.result.merge.layers.map((layer) => (
                      <li key={layer.pullRequest}>
                        #{layer.pullRequest} {layer.branch}: {layer.status} · {layer.detail}
                      </li>
                    ))}
                  </ol>
                ) : null}
                <Accordion>
                  <AccordionItem value="immutable-approval">
                    <AccordionTrigger>
                      Saved immutable preview and approved choices
                    </AccordionTrigger>
                    <AccordionContent>
                      <pre className="whitespace-pre-wrap break-all text-xs">
                        {JSON.stringify(
                          { preview: record.preview ?? null, action: record.action },
                          null,
                          2,
                        )}
                      </pre>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={operationBusy}
                  onClick={() => {
                    void (async () => {
                      if (!desktop) throw new Error('Captured operation authority is unavailable.')
                      await captureOperationalTarget(
                        {
                          repositoryId: record.repositoryId,
                          worktreeId: record.context.worktreeId,
                        },
                        record.capture,
                      )
                      if (record.publication && record.publication.status !== 'completed')
                        setWorkflow({
                          kind: 'stack',
                          operation: 'publish',
                          branch: record.publication.layers[0]?.branch ?? '',
                        })
                      else if (record.result?.merge) {
                        const top = record.result.merge.layers.at(-1)
                        if (top)
                          setWorkflow({
                            kind: 'stack',
                            operation: 'merge',
                            branch: top.branch,
                            pullRequest: top.pullRequest,
                          })
                      } else
                        setError(
                          'Original directory captured. Continue/Skip/Abort remain explicit supported backend recovery decisions, not automatic replay.',
                        )
                    })().catch((value) => setError(String(value)))
                  }}
                >
                  Inspect original authority and recovery
                </Button>
              </li>
            ))}
          </ol>
          {operationSnapshot && operationApi && operationScope.current ? (
            <OperationBanner
              snapshot={operationSnapshot}
              authority={operationScope.current.authority}
              desktop={operationApi}
              showingOperation={null}
              busy={operationBusy}
              runAction={runCapturedAction}
              onRequest={(request) =>
                void prepareWorkflow(request, operationContext.current ?? context)
              }
              onShowChanges={() => {
                setView({ ...current.view, tab: 'changes' })
                setRecoveryOpen(false)
              }}
              onResolveConflict={(path) => {
                setView({ ...current.view, tab: 'changes' })
                setRecoveryOpen(false)
                setError(
                  `Inspect ${path} read-only; resolve it externally before an explicit recovery decision.`,
                )
              }}
            />
          ) : (
            <div>
              <p>
                Inspect the exact selected directory without replaying a journal. Capture that
                directory explicitly before any recovery decision.
              </p>
              <Button
                disabled={!selectedTree || operationBusy}
                onClick={() =>
                  void captureOperationalTarget().catch((value) => setError(String(value)))
                }
              >
                Capture selected directory for recovery
              </Button>
            </div>
          )}
          {operationBusy ? (
            <p role="status">
              An explicit operation is running in {operationSnapshot?.path}; navigation never
              cancels it.
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
      <NotificationCredentialDialog
        key={settings?.github.host ?? 'github.com'}
        open={credentialOpen}
        onOpenChange={setCredentialOpen}
        busy={notificationBusy}
        error={credentialError}
        host={settings?.github.host ?? cliStatus?.host ?? 'github.com'}
        login={notificationInbox?.login ?? null}
        onSubmit={(token, consent, host) => {
          void notify(async (current) => {
            if (
              !desktop.updateSettings ||
              !desktop.saveNotificationCredential ||
              !desktop.notifications
            )
              throw new Error('Notifications credential storage is unavailable.')
            await desktop.updateSettings({ notifications: { enabled: true } })
            if (!current()) return
            await desktop.saveNotificationCredential(token, consent, host)
            if (current()) return desktop.notifications()
          }, true)
        }}
      />
      {nativeManagement &&
      desktop &&
      inventory.data?.repositories.find(
        (repo) => repo.identity.id === nativeManagement.repositoryId,
      ) ? (
        <NativeOperationDialog
          api={desktop}
          sourceVersion={providerEpoch}
          repository={
            inventory.data.repositories.find(
              (repo) => repo.identity.id === nativeManagement.repositoryId,
            )!
          }
          initialNumber={nativeManagement.number}
          onClose={() => setNativeManagement(null)}
          onChanged={async () => {
            await inventory.refetch()
            await operationRecords.refetch()
          }}
        />
      ) : null}
      <Dialog
        open={Boolean(executionChoice)}
        onOpenChange={(open) => {
          if (!open) setExecutionChoice(null)
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogHeader>
            <DialogTitle>Choose explicit execution directory</DialogTitle>
            <DialogDescription>
              Selection is not mutation authority. The backend preview discloses every replay and
              refuses branches checked out elsewhere. No primary directory is borrowed or activated.
            </DialogDescription>
          </DialogHeader>
          <Select
            aria-label="Explicit execution directory"
            value={executionChoiceId}
            onValueChange={setExecutionChoiceId}
            options={[
              { value: '', label: 'Choose an existing directory' },
              ...(inventory.data?.repositories
                .find((repo) => repo.identity.id === executionChoice?.context.repositoryId)
                ?.worktrees.filter((tree) => !tree.missing && tree.kind !== 'bare')
                .map((tree) => ({ value: tree.id, label: tree.path })) ?? []),
            ]}
          />
          <Button
            disabled={!executionChoiceId}
            onClick={() => {
              if (!executionChoice) return
              const chosen = executionChoice
              setExecutionChoice(null)
              dispatch(chosen.action, { ...chosen.context, worktreeId: executionChoiceId })
            }}
          >
            Prepare exact scoped preview
          </Button>
          <Button variant="secondary" onClick={() => setExecutionChoice(null)}>
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
      {lifecycle &&
      desktop &&
      inventory.data?.repositories.find((repo) => repo.identity.id === lifecycle.repositoryId) ? (
        <WorktreeLifecycleDialog
          sourceVersion={providerEpoch}
          api={desktop}
          repository={
            inventory.data.repositories.find((repo) => repo.identity.id === lifecycle.repositoryId)!
          }
          mode={lifecycle.mode}
          sourceRefId={lifecycle.sourceRefId}
          worktreeIds={lifecycle.worktreeIds}
          onClose={() => setLifecycle(null)}
          onChanged={async () => {
            await inventory.refetch()
          }}
        />
      ) : null}
      {workflow && operationSnapshot ? (
        <WorkflowDialog
          key={JSON.stringify([
            operationSnapshot.path,
            providerWorkflow?.scope ?? operationScope.current,
            workflow.kind,
            workflow.kind === 'pr' ? workflow.number : null,
          ])}
          request={workflow}
          snapshot={operationSnapshot}
          authority={JSON.stringify(
            providerWorkflow?.scope ?? [operationSnapshot.path, operationSnapshot.remoteUrl],
          )}
          busy={operationBusy}
          stackApi={providerWorkflow?.api ?? operationApi}
          safetyRevision={JSON.stringify([
            providerEpoch,
            inventory.data?.repositories.find(
              (repo) => repo.identity.id === approvedCapture?.repositoryId,
            )?.refs,
            inventory.data?.repositories
              .find((repo) => repo.identity.id === approvedCapture?.repositoryId)
              ?.worktrees.map((tree) => [
                tree.id,
                tree.path,
                tree.headOid,
                tree.refId,
                tree.indexSignature,
                tree.status,
                tree.locked,
                tree.missing,
              ]),
          ])}
          capturedAuthority={providerWorkflow ? null : approvedCapture}
          providerManagement={Boolean(providerWorkflow)}
          providerSourceCurrent={
            providerWorkflow
              ? providerWorkflow.generation === providerGeneration.current
              : !approvedCapture ||
                operationCaptureGeneration.current === providerGeneration.current
          }
          actionError={error}
          onClearActionError={() => setError(null)}
          defaults={settings}
          onClose={() => {
            setWorkflow((previous) => (previous === workflow ? null : previous))
            setProviderWorkflow((previous) => (previous === providerWorkflow ? null : previous))
          }}
          onRequest={(request) =>
            void prepareWorkflow(
              request,
              providerWorkflow?.target ?? operationContext.current ?? context,
              providerWorkflow?.scope ?? operationScope.current ?? undefined,
            )
          }
          runAction={runCapturedAction}
        />
      ) : null}
    </>
  )
}
export default App
