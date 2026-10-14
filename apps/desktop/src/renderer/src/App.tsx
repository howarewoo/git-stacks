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
import {
  NotificationCenterView,
  NotificationCredentialDialog,
} from './components/notification-center-view'
import { WorkflowDialog, type WorkflowRequest } from './components/workflow-dialog'
import { OperationBanner } from './components/repository-views'
import { PullRequestInboxView } from './components/pr-inbox-view'
import { useWorktreeInventory } from './lib/worktree-inventory'
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
import type { DesktopAPI, GitHubCliStatus, RepositorySnapshot } from '@git-stacks/shared/types'
import type { AppSettings } from '@git-stacks/shared/settings'
import type { InspectionContext } from '@git-stacks/shared/inspection'
import type { NotificationInbox, NotificationThread } from '@git-stacks/shared/notifications'
import type { PullRequestInboxFilter } from '@git-stacks/shared/pr-inbox'
import { LIST_PAGE_SIZE } from '@git-stacks/shared/performance'
import { cliAuthority, sameOperationScope, type OperationScope } from '@git-stacks/shared/operation-scope'
import './components/workbench-shell.css'

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
  const [activityPage, setActivityPage] = React.useState(0)
  const pullRequestScroll = React.useRef<HTMLDivElement>(null)
  const [searchReady, setSearchReady] = React.useState(true)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
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
  const [attentionFilter, setAttentionFilter] = React.useState<PullRequestInboxFilter>()
  const [operationAuthority, setOperationAuthority] = React.useState('')
  const [workflow, setWorkflow] = React.useState<WorkflowRequest | null>(null)
  const [operationSnapshot, setOperationSnapshot] = React.useState<RepositorySnapshot | null>(null)
  const operationScope = React.useRef<OperationScope | null>(null)
  const operationContext = React.useRef<InspectionContext | null>(null)
  const [returnOrigin, setReturnOrigin] = React.useState<RepositoryViewMemory['reviewOrigin']>(null)
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [pendingReview, setPendingReview] = React.useState<{
    repositoryId: string
    number: number
    generation: number
  } | null>(null)
  const navigationGeneration = React.useRef(0)
  const retirePendingReview = React.useCallback(() => {
    navigationGeneration.current += 1
    setPendingReview(null)
  }, [])
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
  const repoRead = useQuery({
    queryKey: ['inspection-repository', repositoryId, refRevision, providerEpoch],
    enabled: Boolean(desktop?.inspect && repositoryId),
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
  const inbox = useQuery({
    queryKey: ['workbench-attention', cliStatus?.host, cliStatus?.identity],
    enabled: Boolean(desktop?.pullRequestInbox && surface === 'attention'),
    queryFn: async ({ signal }) => {
      const id = `attention-${crypto.randomUUID()}`
      signal.addEventListener('abort', () => void desktop?.cancel(id), { once: true })
      const value = await desktop!.pullRequestInbox!({ requestId: id })
      signal.throwIfAborted()
      return value
    },
    gcTime: 0,
  })
  const inboxFilters = useQuery({
    queryKey: ['workbench-attention-filters'],
    enabled: Boolean(desktop?.pullRequestInboxFilters && surface === 'attention'),
    queryFn: () => desktop!.pullRequestInboxFilters!(),
  })
  const updateMemory = React.useCallback(
    (id: string, patch: Partial<RepositoryViewMemory>) => {
      if (
        patch.selectedId !== undefined ||
        patch.surface !== undefined ||
        patch.pullRequestId !== undefined
      )
        retirePendingReview()
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
    if (!repositoryId && snapshot.repositories.length) {
      const first = snapshot.repositories[0].id
      setRepositoryId(first)
      setSurface((memoryRef.current[first] ?? emptyRepositoryMemory).surface)
    }
  }, [snapshot.repositories, repositoryId])
  React.useEffect(() => {
    if (!desktop) return
    let retired = false
    let statusVersion = 0
    const principals = new Map<string, string>()
    void desktop
      .githubCliStatus?.()
      .then((value) => {
        if (!retired && statusVersion === 0) {
          principals.set(value.host, value.identity ?? '')
          setCliStatus(value)
        }
      })
      .catch((value) => setError(String(value)))
    const stopStatus = desktop.onGitHubCliStatus?.((value) => {
      statusVersion += 1
      const next = value.identity ?? ''
      const previous = principals.get(value.host)
      principals.set(value.host, next)
      if (value.host === configuredHost.current) {
        cliReadGeneration.current += 1
        setCliRefreshing(false)
        setCliStatus(value)
      }
      if (operationScope.current?.authority.split('|')[0] === value.host)
        setOperationAuthority(cliAuthority(value.host, value))
      if (previous === undefined || previous === next) return
      setProviderEpoch((epoch) => epoch + 1)
      setDetails({})
      retirePendingReview()
      setReturnOrigin(null)
      const capturedReads = (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0]?.toString().startsWith('inspection-') === true ||
        query.queryKey[0] === 'workbench-attention'
      void client.cancelQueries({ predicate: capturedReads })
      client.removeQueries({ predicate: capturedReads })
      // Account-owned text and journals survive; a review target is not transferred to another principal.
      setSurface((value) => (value === 'review' ? 'branches' : value))
      setMemory((previous) => {
        const next = { ...previous }
        for (const [id, saved] of Object.entries(next))
          next[id] = {
            ...saved,
            pullRequestId: null,
            reviewOrigin: null,
            surface: saved.surface === 'review' ? 'branches' : saved.surface,
          }
        saveWorkbenchMemory(next)
        return next
      })
    })
    const stopDrop = desktop.onRepositoryDropped?.((paths) => {
      for (const path of paths)
        void desktop
          .addRepository?.(path)
          .then(() => {
            void inventory.refetch()
          })
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
      retired = true
      stopStatus?.()
      stopDrop?.()
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
      document.removeEventListener('visibilitychange', report)
    }
  }, [desktop, client])
  React.useEffect(() => {
    if (!settings) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.gsTheme = settings.appearance.theme
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
      ) ??
      document.querySelector<HTMLButtonElement>('.bw-branch-name[aria-pressed="true"]')
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
    if (!pendingReview) return
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
  }, [pendingReview, snapshot.branches, updateMemory, repositoryId, surface])
  React.useLayoutEffect(() => {
    if (surface === 'pull-requests' && pullRequestScroll.current)
      pullRequestScroll.current.scrollTop = current.pullRequestScroll
  }, [repositoryId, surface])
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
        worktreeId: tree?.kind === 'bare' ? undefined : tree?.id,
      }
      setOperationSnapshot(value)
      return value
    } finally {
      setOperationBusy(false)
    }
  }
  const prepareWorkflow = async (request: WorkflowRequest, target: InspectionContext = context) => {
    try {
      await captureOperationalTarget(target)
      setWorkflow(request)
    } catch (value) {
      setError(String(value))
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
      setReturnOrigin(captureOrigin())
      setSurface(action)
      return
    }
    if (action === 'branches' || action === 'pull-requests') {
      navigate(captured.repositoryId, action)
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
    const expected = operationScope.current
    const captured = operationContext.current
    if (!desktop || !operationSnapshot || !expected || !captured) {
      setError('Choose a captured operational repository first.')
      return false
    }
    setOperationBusy(true)
    try {
      const scope = await desktop.repositoryOperationScope()
      const confirmed = await inspectionAPI(desktop, captured).repositoryOperationScope()
      if (!sameOperationScope(scope, expected) || !sameOperationScope(confirmed, expected))
        throw new Error(
          'The captured directory, provider or principal changed; this action was not sent.',
        )
      await desktop.runAction(action)
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
            .querySelector<HTMLInputElement>('[aria-label="Filter branches by branch, PR, or path"]')
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
  const secondaryRows = React.useMemo(() => {
    if (surface !== 'pull-requests')
      return snapshot.branches.filter((branch) => branch.worktrees.length || branch.pullRequest)
    const byPr = new Map<string, WorkbenchBranch>()
    for (const branch of snapshot.branches)
      if (
        branch.repositoryId === repositoryId &&
        branch.pullRequest &&
        !byPr.has(branch.pullRequest.id)
      )
        byPr.set(branch.pullRequest.id, branch)
    return (repository?.pullRequests ?? []).flatMap((pr) => {
      const branch = byPr.get(pr.id)
      return branch ? [branch] : []
    })
  }, [surface, snapshot.branches, repository, repositoryId])
  const secondaryPages = Math.max(1, Math.ceil(secondaryRows.length / LIST_PAGE_SIZE))
  const secondaryPage = Math.min(
    surface === 'pull-requests' ? current.pullRequestPage : activityPage,
    secondaryPages - 1,
  )
  const changeSecondaryPage = (page: number) =>
    surface === 'pull-requests'
      ? updateMemory(repositoryId, { pullRequestPage: page })
      : setActivityPage(page)
  React.useLayoutEffect(() => {
    if (surface === 'pull-requests' && pullRequestScroll.current)
      pullRequestScroll.current.scrollTop = current.pullRequestScroll
  }, [repositoryId, surface, secondaryPage])
  const mainPanel =
    surface === 'branches' ? undefined : (
      <WorkbenchPane
        className="bw-main wb-secondary"
        role="main"
        aria-label={surface}
        header={
          <div className="bw-panel-head">
            <h1>
              {surface === 'pull-requests'
                ? 'Pull requests'
                : surface === 'attention'
                  ? 'Needs attention'
                  : surface === 'activity'
                    ? 'Activity'
                    : 'Review'}
            </h1>
            {returnOrigin || current.reviewOrigin ? (
              <Button size="sm" variant="ghost" onClick={returnToOrigin}>
                Return to origin
              </Button>
            ) : null}
          </div>
        }
      >
        {surface === 'review' &&
        selected?.pullRequest?.id === current.pullRequestId &&
        selected?.pullRequest &&
        published &&
        repository &&
        repoRead.data ? (
          <ReviewView
            authority={authority}
            desktop={published}
            pullRequests={repository.pullRequests.map((pr) => pr.facts)}
            stackContext={repoRead.data}
            number={selected.pullRequest.number}
            onSelectNumber={(number) => {
              const row = snapshot.branches.find(
                (branch) =>
                  branch.repositoryId === repositoryId && branch.pullRequest?.number === number,
              )
              if (row)
                updateMemory(repositoryId, {
                  selectedId: row.id,
                  pullRequestId: row.pullRequest!.id,
                  view: { ...current.view, worktreeId: null },
                })
              else setError('This PR has no current qualified inventory association.')
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
            busy={false}
            observedPullRequest={
              repository.pullRequests.find((pr) => pr.id === selected.pullRequest?.id)?.facts ??
              null
            }
            returnContext={{ label: 'Return to original context', onReturn: returnToOrigin }}
          />
        ) : surface === 'review' ? (
          <p>
            {pendingReview
              ? `Loading qualified PR #${pendingReview.number} in the selected repository…`
              : 'Choose a qualified pull request.'}{' '}
            {repoRead.error?.message}
          </p>
        ) : surface === 'attention' ? (
          <PullRequestInboxView
            report={inbox.data ?? null}
            loading={inbox.isPending}
            refreshing={inbox.isFetching}
            activating={false}
            error={inbox.error?.message ?? error}
            savedFilters={inboxFilters.data ?? []}
            savingFilters={savingInboxFilters}
            filtersReady={inboxFilters.isSuccess}
            initialFilter={attentionFilter}
            onFilterChange={setAttentionFilter}
            searchInputRef={attentionSearch}
            onDismissError={() => setError(null)}
            onRefresh={() => void inbox.refetch()}
            onOpen={(item) => {
              const repo = inventory.data?.repositories.find(
                (repo) =>
                  repo.registeredPaths.includes(item.repositoryPath) &&
                  repo.remote?.host === item.host &&
                  repo.remote?.fullName.toLowerCase() === item.repository.toLowerCase(),
              )
              if (!repo) {
                setError('The queue item no longer has a matching registered local authority.')
                return
              }
              setReturnOrigin({ ...captureOrigin(), surface: 'attention' })
              navigate(repo.identity.id, 'review')
              setPendingReview({
                repositoryId: repo.identity.id,
                number: item.number,
                generation: navigationGeneration.current,
              })
            }}
            onSaveFilters={async (drafts) => {
              if (!desktop?.savePullRequestInboxFilters)
                throw new Error('Saved attention filters are unavailable.')
              setSavingInboxFilters(true)
              try {
                client.setQueryData(
                  ['workbench-attention-filters'],
                  await desktop.savePullRequestInboxFilters(drafts),
                )
              } finally {
                setSavingInboxFilters(false)
              }
            }}
          />
        ) : (
          <div
            className="wb-secondary-list"
            ref={pullRequestScroll}
            onScroll={(event) => {
              if (surface === 'pull-requests')
                updateMemory(repositoryId, { pullRequestScroll: event.currentTarget.scrollTop })
            }}
          >
            {secondaryRows
              .slice(secondaryPage * LIST_PAGE_SIZE, (secondaryPage + 1) * LIST_PAGE_SIZE)
              .map((branch) => (
                <Button
                  key={branch.id}
                  variant="ghost"
                  onClick={() => {
                    if (surface === 'pull-requests' && branch.pullRequest) {
                      const origin = { ...captureOrigin(), surface: 'pull-requests' as const }
                      setReturnOrigin(origin)
                      navigate(branch.repositoryId, 'review', branch.id)
                      updateMemory(branch.repositoryId, {
                        selectedId: branch.id,
                        pullRequestId: branch.pullRequest.id,
                        reviewOrigin: origin,
                        surface: 'review',
                      })
                    } else navigate(branch.repositoryId, 'branches', branch.id)
                  }}
                >
                  <span>
                    {snapshot.repositories.find((repo) => repo.id === branch.repositoryId)?.name} ·{' '}
                    {branch.ref}
                  </span>
                  <small>
                    {surface === 'activity'
                      ? 'Observed inventory facts, not external-tool liveness'
                      : branch.pullRequest
                        ? `#${branch.pullRequest.number} · ${branch.pullRequest.checks.label}`
                        : branch.local.label}
                  </small>
                </Button>
              ))}
            <p>
              Unavailable and partial sources are not an empty queue. {snapshot.remoteFreshness}
            </p>
            <Button
              disabled={!secondaryPage}
              onClick={() => changeSecondaryPage(secondaryPage - 1)}
            >
              Previous page
            </Button>
            <span>
              Page {secondaryPage + 1} / {secondaryPages}
            </span>
            <Button
              disabled={secondaryPage + 1 >= secondaryPages}
              onClick={() => changeSecondaryPage(secondaryPage + 1)}
            >
              Next page
            </Button>
          </div>
        )}
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
        snapshot={snapshot}
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
            <Button
              variant="ghost"
              disabled={repositoryOpening}
              onClick={() => {
                if (repositoryOpening) return
                setRepositoryOpening(true)
                void desktop
                  .openRepository()
                  .then(() => {
                    void inventory.refetch()
                  })
                  .catch((value) => setError(String(value)))
                  .finally(() => setRepositoryOpening(false))
              }}
            >
              Add repository
            </Button>
            <Button variant="ghost" onClick={() => setDiscoveryOpen(true)}>
              Find and clone
            </Button>
            <Button variant="ghost" onClick={() => setNotificationOpen(true)}>
              Notifications
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
        open={credentialOpen}
        onOpenChange={setCredentialOpen}
        busy={notificationBusy}
        error={credentialError}
        host={settings?.github.host ?? cliStatus?.host ?? 'github.com'}
        login={cliStatus?.login ?? null}
        onSubmit={(token, consent, host) =>
          void notify(async (current) => {
            await desktop.updateSettings?.({ notifications: { enabled: true } })
            if (!current()) return
            await desktop.saveNotificationCredential?.(token, consent, host)
            if (current()) return desktop.notifications?.()
          }, true)
        }
      />
      {workflow && operationSnapshot ? (
        <WorkflowDialog
          request={workflow}
          snapshot={operationSnapshot}
          authority={operationAuthority}
          busy={operationBusy}
          actionError={error}
          onClearActionError={() => setError(null)}
          defaults={settings}
          onClose={() => setWorkflow(null)}
          onRequest={setWorkflow}
          runAction={runCapturedAction}
        />
      ) : null}
    </>
  )
}
export default App
