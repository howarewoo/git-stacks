import * as React from 'react'
import { CancelledError, useQuery, useQueryClient } from '@tanstack/react-query'
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
  cliAuthority,
  sameOperationScope,
  type OperationScope,
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
  const [globalQuery, setGlobalQuery] = React.useState('')
  const [globalPage, setGlobalPage] = React.useState(0)
  const [searchReady, setSearchReady] = React.useState(true)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [localRepositoryOpen, setLocalRepositoryOpen] = React.useState(false)
  const [discoveryOpen, setDiscoveryOpen] = React.useState(false)
  const [recoveryOpen, setRecoveryOpen] = React.useState(false)
  const [operationBusy, setOperationBusy] = React.useState(false)
  const [repositoryOpening, setRepositoryOpening] = React.useState(false)
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
  const [operationAuthority, setOperationAuthority] = React.useState('')
  const [workflow, setWorkflow] = React.useState<WorkflowRequest | null>(null)
  const [operationSnapshot, setOperationSnapshot] = React.useState<RepositorySnapshot | null>(null)
  const [providerWorkflow, setProviderWorkflow] = React.useState<{
    api: DesktopAPI
    scope: OperationScope
    target: InspectionContext
    generation: number
  } | null>(null)
  const actionLock = React.useRef(false)
  const workflowAdmissionLock = React.useRef(false)
  const [createPrTarget, setCreatePrTarget] = React.useState<{
    repositoryId: string
    branches: { id: string; name: string }[]
  } | null>(null)
  const [createPrRef, setCreatePrRef] = React.useState('')
  const operationScope = React.useRef<OperationScope | null>(null)
  const operationContext = React.useRef<InspectionContext | null>(null)
  const journalScope = React.useMemo(
    () =>
      operationSnapshot
        ? {
            repositoryPath: operationSnapshot.path,
            remoteUrl: operationSnapshot.remoteUrl,
            authority: operationAuthority,
          }
        : null,
    [operationSnapshot?.path, operationSnapshot?.remoteUrl, operationAuthority],
  )
  useOperationProgressProjection(desktop, journalScope)
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
  const principals = React.useRef(new Map<string, string>())
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
  const authorityRead = useQuery({
    queryKey: ['inspection-authority', repositoryId, repository?.remote?.id, providerEpoch],
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
      if (operationScope.current?.authority.split('|')[0] === value.host)
        setOperationAuthority(cliAuthority(value.host, value))
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
  /** Explicit operational adoption only; navigation never activates a checkout or recovers journals. */
  const captureOperationalTarget = async (target: InspectionContext = context) => {
    if (!desktop || operationBusy)
      throw new Error(
        'Another captured operation is running; browsing and inspection remain available.',
      )
    const owner = inventory.data?.repositories.find(
      (repo) => repo.identity.id === target.repositoryId,
    )
    const scopedTarget = inspectionAPI(desktop, target)
    setOperationBusy(true)
    try {
      const scope = await scopedTarget.repositoryOperationScope()
      if (!owner?.registeredPaths.includes(scope.repositoryPath))
        throw new Error('Adopt this existing directory before preparing an operation.')
      const value = await desktop.openRepository(scope.repositoryPath)
      if (!value || value.path !== scope.repositoryPath)
        throw new Error('The operational directory changed; no action was sent.')
      const confirmed = await scopedTarget.repositoryOperationScope()
      const active = await desktop.repositoryOperationScope()
      if (!sameOperationScope(scope, confirmed) || !sameOperationScope(scope, active))
        throw new Error(
          'The directory, provider or principal changed while preparing the operation.',
        )
      operationScope.current = scope
      setOperationAuthority(scope.authority)
      const tree = owner.worktrees.find((tree) => tree.path === scope.repositoryPath)
      operationContext.current = {
        ...target,
        worktreeId:
          target.worktreeId ??
          (!target.refId || tree?.refId === target.refId
            ? tree?.kind === 'bare'
              ? undefined
              : tree?.id
            : undefined),
      }
      setOperationSnapshot(value)
      return value
    } finally {
      setOperationBusy(false)
    }
  }
  const prepareWorkflow = async (
    request: WorkflowRequest,
    target: InspectionContext = context,
    expectedScope?: OperationScope,
  ) => {
    if (!desktop || actionLock.current || workflowAdmissionLock.current || operationBusy)
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
    const branch = snapshot.branches.find(
      (row) =>
        row.repositoryId === captured.repositoryId &&
        row.id === (captured.branchId ?? selected?.id),
    )
    const worktreeId =
      captured.worktreeId ?? (branch?.id === selected?.id ? context.worktreeId : undefined)
    if (!branch || branch.refKind !== 'local' || !worktreeId) {
      setError('Choose an exact existing local worktree before preparing a Git operation.')
      return
    }
    if (action === 'restack' || action === 'sync' || action === 'publish')
      void prepareWorkflow(
        { kind: 'stack', branch: branch.ref, operation: action },
        {
          repositoryId: captured.repositoryId,
          refId: branch.id,
          worktreeId,
          pullRequestId: branch.pullRequest?.id,
        },
      )
    else setError('Choose a qualified operational preview before changing repository state.')
  }
  const runCapturedAction = async (action: Parameters<DesktopAPI['runAction']>[0]) => {
    if (actionLock.current) return false
    if (providerWorkflow) {
      if (!['updatePr', 'closePr', 'reopenPr', 'linkIssue', 'unlinkIssue'].includes(action.type)) {
        setError('This form addresses provider PR management, not a local Git operation.')
        return false
      }
      actionLock.current = true
      setOperationBusy(true)
      try {
        if (!providerWorkflow.api.pullRequestAction)
          throw new Error('Captured PR management is unavailable.')
        const providerAction = action as PullRequestAction
        const result = await providerWorkflow.api.pullRequestAction(
          providerAction,
          providerWorkflow.scope,
        )
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
          setDetails((previous) => ({
            ...previous,
            [providerWorkflow.target.repositoryId]: refreshed,
          }))
          setOperationSnapshot(refreshed)
          await inventory.refetch()
        } catch (value) {
          setError(`The provider action completed, but its follow-up read failed: ${String(value)}`)
        }
        return true
      } catch (value) {
        setError(String(value))
        return false
      } finally {
        actionLock.current = false
        setOperationBusy(false)
      }
    }
    const expected = operationScope.current
    const captured = operationContext.current
    if (!desktop || !operationSnapshot || !expected || !captured) {
      setError('Choose a captured operational repository first.')
      return false
    }
    actionLock.current = true
    setOperationBusy(true)
    try {
      const scope = await desktop.repositoryOperationScope()
      const confirmed = await inspectionAPI(desktop, captured).repositoryOperationScope()
      if (!sameOperationScope(scope, expected) || !sameOperationScope(confirmed, expected))
        throw new Error(
          'The captured directory, provider or principal changed; this action was not sent.',
        )
      const result = await desktop.runAction(action)
      const observedAt = new Date().toISOString()
      setEvents((events) =>
        [
          {
            id: crypto.randomUUID(),
            repository: operationSnapshot.name,
            target: {
              repositoryId: captured.repositoryId,
              branchId: captured.refId,
              worktreeId: captured.worktreeId,
            },
            label: result.message,
            observedAt,
            eventAt: observedAt,
          },
          ...events,
        ].slice(0, LIST_PAGE_SIZE),
      )
      try {
        const snapshot = await inspectionAPI(desktop, captured).refresh()
        if (operationScope.current && sameOperationScope(operationScope.current, expected))
          setOperationSnapshot(snapshot)
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
      actionLock.current = false
      setOperationBusy(false)
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
              const sourceNumber = selected?.pullRequest?.number
              if (!desktop || !sourceNumber) {
                setError('Captured native-layer reading is unavailable.')
                return
              }
              const generation = providerGeneration.current
              const api = inspectionAPI(
                desktop,
                publishedContext,
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
            events={events}
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
          ...(selected?.refKind === 'local' && selectedTree && !selectedLocalFact?.missing
            ? { restack: {}, sync: {}, publish: {} }
            : {}),
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
              const opened = await prepareWorkflow(
                { kind: 'stack', branch: branch.name, operation: 'publish' },
                { repositoryId: createPrTarget.repositoryId, refId: branch.id },
              )
              if (opened) setCreatePrTarget(null)
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
      <Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
        <DialogContent className="wb-history-dialog">
          <DialogHeader>
            <DialogTitle>Repository-qualified operations and recovery</DialogTitle>
            <DialogDescription>
              Browsing does not abort, replay or retarget an operation.
            </DialogDescription>
          </DialogHeader>
          {recovery.data &&
          scoped &&
          operationSnapshot?.path === recovery.data.path &&
          operationScope.current?.repositoryPath === recovery.data.path ? (
            <OperationBanner
              snapshot={recovery.data}
              authority={operationAuthority}
              desktop={scoped}
              showingOperation={null}
              busy={operationBusy}
              runAction={runCapturedAction}
              onRequest={(request) => void prepareWorkflow(request)}
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
          authority={providerWorkflow?.scope.authority ?? operationAuthority}
          busy={operationBusy}
          stackApi={providerWorkflow?.api ?? desktop}
          providerManagement={Boolean(providerWorkflow)}
          providerSourceCurrent={
            !providerWorkflow || providerWorkflow.generation === providerGeneration.current
          }
          actionError={error}
          onClearActionError={() => setError(null)}
          defaults={settings}
          onClose={() => {
            setWorkflow(null)
            setProviderWorkflow(null)
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
