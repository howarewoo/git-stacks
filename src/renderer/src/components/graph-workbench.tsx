import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { canonicalHostName } from '../../../shared/host'
import {
  parseGraphPreferencesPublicScope,
  type GraphPreferencesResult,
  type GraphPreferencesPublicScope,
} from '../../../shared/graph-preferences'
import { GitBranch, GitPullRequest, Minus, Plus, RefreshCw, Maximize2 } from 'lucide-react'
import type { RepositorySnapshot, PullRequest, DesktopAPI } from '../../../shared/types'
import type { PullRequestIndex } from '../../../shared/pr-index'
import { projectPrGraph, type PrGraphNode, type PrGraphSource } from '../../../shared/pr-graph'
import {
  graphDiscovery,
  graphOutline,
  focusedGraph,
  dependentPaths,
  type GraphCriteria,
  type GraphPreset,
} from '../../../shared/graph-workbench'
import {
  GRAPH_OUTLINE_ROW_LIMIT,
  GRAPH_DETAIL_NODE_LIMIT,
  GRAPH_PATH_PAGE_SIZE,
} from '../../../shared/performance'
import { actionBlockReason } from '../../../shared/capabilities'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Select } from './ui/select'
import { ReconciliationPanel } from './reconciliation-view'
import { WORKSPACE_VIEW_HEADING_ID } from './workspace-navigation'
import type { RunAction, WorkflowRequest } from './workflow-dialog'

const PRESETS: { value: GraphPreset; label: string; description: string }[] = [
  {
    value: 'my-prs',
    label: 'My PRs',
    description: 'Open PRs authored by the signed-in account; drafts included.',
  },
  {
    value: 'review-requested',
    label: 'Review requested',
    description:
      'Open PRs directly requesting the signed-in account; team requests do not qualify. Drafts included.',
  },
  {
    value: 'current-branch',
    label: 'Current branch',
    description: 'The actual local checkout, with its recorded dependencies. No PR is required.',
  },
  {
    value: 'all-open',
    label: 'All open PRs',
    description:
      'Every indexed open PR in this repository, including drafts. No recency exclusion.',
  },
]
const SOURCE_LABEL: Record<PrGraphSource, string> = {
  'github-base': 'GitHub PR base target',
  'github-head': 'Source-backed PR head association',
  'local-parent': 'Recorded local parent intent',
  ancestry: 'Inferred Git ancestry',
  'native-membership': 'Submitted native membership/order',
  unknown: 'Parent evidence · provenance unknown',
}
const DEFAULT_CRITERIA: GraphCriteria = {
  preset: 'all-open',
  text: '',
  author: '',
  status: 'all',
  collapse: true,
}
const ROW_HEIGHT = 88
function nodeLabel(node: PrGraphNode): string {
  return node.pr ? `#${node.pr.number} ${node.pr.title}` : node.name
}
function checksLabel(pr: PullRequest): string {
  return pr.metadata === 'degraded'
    ? 'Checks unknown · lightweight index'
    : pr.checks === 'none'
      ? 'No checks reported'
      : `Checks ${pr.checks}`
}
function originIdentity(remote: string | null): { host: string; repository: string } | null {
  if (!remote) return null
  try {
    const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/u.exec(remote.trim())
    const url = scp ? null : new URL(remote.trim())
    const host = canonicalHostName(
      scp ? scp[1] : url!.protocol === 'ssh:' ? url!.hostname : url!.host,
    )
    const segments = (scp ? scp[2] : url!.pathname)
      .replace(/^\/+|\/+$/gu, '')
      .replace(/\.git$/u, '')
      .split('/')
      .filter(Boolean)
    return host && segments.length >= 2
      ? { host, repository: segments.slice(-2).join('/').toLowerCase() }
      : null
  } catch {
    return null
  }
}
interface GraphIndexRead {
  index: PullRequestIndex | null
  scopeMismatch: string | null
}
function validatePreferencesReply(
  result: GraphPreferencesResult,
  expected: GraphPreferencesPublicScope | null,
): GraphPreferencesResult {
  if (result.state === 'unavailable') return { ...result, scope: null, preferences: null }
  const scope = parseGraphPreferencesPublicScope(result.scope)
  if (
    !scope ||
    !expected ||
    scope.repositoryPath !== expected.repositoryPath ||
    canonicalHostName(scope.host) !== canonicalHostName(expected.host) ||
    scope.repository.toLowerCase() !== expected.repository.toLowerCase() ||
    scope.account.toLowerCase() !== expected.account.toLowerCase()
  )
    throw new Error('Saved view response belongs to a different repository or account.')
  return result
}
export interface GraphWorkbenchProps {
  snapshot: RepositorySnapshot
  authority: string
  account: { host: string; login: string } | null
  busy: boolean
  runAction: RunAction
  onRequest: (request: WorkflowRequest) => void
  onReviewNumber: (number: number) => void
  search: string
  onSearchChange?: (text: string) => void
  onCreate: () => void
  actionError: string | null
  onClearActionError: () => void
  inspectorVisible?: boolean
  onToggleInspector?: () => void
}
export function GraphWorkbench({
  snapshot,
  authority,
  account,
  busy,
  runAction,
  onRequest,
  onReviewNumber,
  search,
  onCreate,
  actionError,
  onClearActionError,
  inspectorVisible,
  onToggleInspector,
  onSearchChange,
}: GraphWorkbenchProps) {
  const desktop: DesktopAPI | null = typeof window === 'undefined' ? null : (window.desktop ?? null)
  const queryClient = useQueryClient()
  const origin = React.useMemo(() => originIdentity(snapshot.remoteUrl), [snapshot.remoteUrl])
  const accountLogin =
    account && origin && canonicalHostName(account.host) === origin.host
      ? account.login.toLowerCase()
      : null
  const prBelongsToOrigin = React.useCallback(
    (pr: PullRequest) => {
      try {
        const url = new URL(pr.url)
        return (
          origin !== null &&
          canonicalHostName(url.host) === origin.host &&
          url.pathname.toLowerCase() === `/${origin.repository}/pull/${pr.number}`
        )
      } catch {
        return false
      }
    },
    [origin],
  )
  const rootScope = JSON.stringify([
    snapshot.path,
    origin?.host ?? null,
    origin?.repository ?? snapshot.remoteUrl,
    authority,
    accountLogin,
  ])
  const indexKey = React.useMemo(() => ['graph-index', rootScope] as const, [rootScope])
  const sourceGeneration = React.useRef(0)
  const [detailRevision, setDetailRevision] = React.useState(0)
  const acceptIndex = React.useCallback(
    (next: PullRequestIndex): GraphIndexRead =>
      next.repository === snapshot.path &&
      origin !== null &&
      canonicalHostName(next.host) === origin.host &&
      next.fullName.toLowerCase() === origin.repository &&
      (!accountLogin || !next.viewer || next.viewer.toLowerCase() === accountLogin)
        ? { index: next, scopeMismatch: null }
        : {
            index: null,
            scopeMismatch:
              'PR index scope changed or does not match this checkout origin/account. Previous remote selection and saved view were retired.',
          },
    [snapshot.path, origin, accountLogin],
  )
  const readIndex = React.useCallback(
    async (signal: AbortSignal, refresh = false) => {
      if (!desktop?.prIndex) throw new Error('Progressive PR indexing is unavailable.')
      const generation = sourceGeneration.current
      const next = await desktop.prIndex(refresh ? { refresh: true } : undefined)
      // Index pushes can cancel this query while the forced main-process read still completes.
      if (refresh && generation === sourceGeneration.current)
        setDetailRevision((value) => value + 1)
      signal.throwIfAborted()
      return acceptIndex(next)
    },
    [desktop, acceptIndex],
  )
  const indexQuery = useQuery({
    queryKey: indexKey,
    enabled: false,
    queryFn: ({ signal }) => readIndex(signal),
  })
  const index = indexQuery.data?.index ?? null
  const indexedByNumber = React.useMemo(
    () => new Map(index?.pullRequests.map((pr) => [pr.number, pr]) ?? []),
    [index],
  )
  const scopeMismatch = indexQuery.data?.scopeMismatch ?? null
  const indexError =
    scopeMismatch ??
    (indexQuery.error
      ? String(indexQuery.error)
      : !desktop?.prIndex
        ? 'Progressive PR indexing is unavailable. Local refs remain inspectable; remote completeness is unknown.'
        : null)
  const viewerIdentity = accountLogin ?? index?.viewer?.toLowerCase() ?? null
  const expectedPreferencesScope = React.useMemo<GraphPreferencesPublicScope | null>(() => {
    const login = accountLogin ?? viewerIdentity
    return origin && login
      ? {
          repositoryPath: snapshot.path,
          host: origin.host,
          repository: origin.repository,
          account: login,
        }
      : null
  }, [accountLogin, viewerIdentity, origin, snapshot.path])
  // The origin is already canonical in rootScope and every index answer is qualified against it.
  // Initial index adoption must not create a second namespace when the typed CLI account is known.
  const sourceScope = JSON.stringify([rootScope, viewerIdentity, scopeMismatch])
  const [criteria, setCriteria] = React.useState<GraphCriteria>(DEFAULT_CRITERIA)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const [path, setPath] = React.useState<string | null>(null)
  const [pathSearch, setPathSearch] = React.useState('')
  const [pathPage, setPathPage] = React.useState(0)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [activeRow, setActiveRow] = React.useState(0)
  const [zoom, setZoom] = React.useState(1)
  const [localInspectorVisible, setLocalInspectorVisible] = React.useState(false)
  const showInspector = inspectorVisible ?? localInspectorVisible
  const toggleInspector = () => {
    if (onToggleInspector) onToggleInspector()
    else setLocalInspectorVisible((value) => !value)
  }
  const formRevision = React.useRef(0)
  const programmedSearch = React.useRef<string | null>(null)
  const restoreSearch = (text: string) => {
    programmedSearch.current = text
    if (onSearchChange) onSearchChange(text)
    else setCriteria((value) => ({ ...value, text }))
  }
  const changeCriteria: typeof setCriteria = (next) => {
    formRevision.current++
    setCriteria(next)
  }
  const changeSearch = (text: string) => {
    formRevision.current++
    if (onSearchChange) onSearchChange(text)
    else setCriteria((value) => ({ ...value, text }))
  }
  const [savedName, setSavedName] = React.useState('')
  const [preferenceMessage, setPreferenceMessage] = React.useState(
    'Preferences are stored on this device, scoped to host, repository and account.',
  )
  const preferencesKey = React.useMemo(
    () => ['graph-preferences', sourceScope] as const,
    [sourceScope],
  )
  const preferencesQuery = useQuery({
    queryKey: preferencesKey,
    enabled: !scopeMismatch && expectedPreferencesScope !== null,
    queryFn: async ({ signal }): Promise<GraphPreferencesResult> => {
      const result = (await desktop?.graphPreferences?.()) ?? {
        state: 'unavailable' as const,
        scope: null,
        preferences: null,
        message: 'Saved graph preferences are unavailable in this runtime.',
      }
      signal.throwIfAborted()
      return validatePreferencesReply(result, expectedPreferencesScope)
    },
  })
  const saved = scopeMismatch ? null : (preferencesQuery.data?.preferences ?? null)
  const snapshotFactsRetired = React.useRef(false)
  const preferenceAvailable =
    !scopeMismatch &&
    expectedPreferencesScope !== null &&
    Boolean(desktop?.saveGraphPreferences) &&
    (preferencesQuery.data ? preferencesQuery.data.state !== 'unavailable' : true)
  const outlineRef = React.useRef<HTMLDivElement>(null)
  const graphRef = React.useRef<HTMLDivElement>(null)
  const previousScope = React.useRef({
    root: rootScope,
    viewer: null as string | null,
    mismatch: null as string | null,
  })
  const scopeRetiring =
    previousScope.current.root !== rootScope ||
    (previousScope.current.viewer !== null && previousScope.current.viewer !== viewerIdentity) ||
    previousScope.current.mismatch !== scopeMismatch
  const preferencesApplied = React.useRef<string | null>(null)
  const previousSearch = React.useRef(search)
  React.useEffect(() => {
    if (previousSearch.current !== search && programmedSearch.current !== search)
      formRevision.current++
    previousSearch.current = search
    if (programmedSearch.current === search) programmedSearch.current = null
  }, [search])
  React.useLayoutEffect(() => {
    const previous = previousScope.current
    const boundary =
      previous.root !== rootScope ||
      (previous.viewer !== null && previous.viewer !== viewerIdentity) ||
      previous.mismatch !== scopeMismatch
    previousScope.current = { root: rootScope, viewer: viewerIdentity, mismatch: scopeMismatch }
    if (!boundary) return
    snapshotFactsRetired.current = true
    ++sourceGeneration.current
    setSelected(null)
    setPath(null)
    setPathPage(0)
    setPathSearch('')
    setExpanded(new Set())
    setCriteria(DEFAULT_CRITERIA)
    restoreSearch('')
    setSavedName('')
    setPreferenceMessage('Repository/account scope changed. Previous view and selection retired.')
    setZoom(1)
    formRevision.current = 0
    preferencesApplied.current = null
  }, [rootScope, viewerIdentity, scopeMismatch, onSearchChange])
  React.useEffect(() => {
    let alive = true
    // Subscribe before the initial query: pushes cancel late read answers and update this scoped cache.
    const unsubscribe = desktop?.onPrIndex?.((next) => {
      if (!alive || next.repository !== snapshot.path) return
      void queryClient.cancelQueries({ queryKey: indexKey, exact: true })
      queryClient.setQueryData(indexKey, acceptIndex(next))
    })
    if (desktop?.prIndex) void indexQuery.refetch()
    return () => {
      alive = false
      unsubscribe?.()
      void queryClient.cancelQueries({ queryKey: indexKey, exact: true })
    }
  }, [desktop, indexKey, acceptIndex, queryClient])
  React.useEffect(() => {
    if (
      !preferencesQuery.data ||
      scopeMismatch ||
      scopeRetiring ||
      preferencesApplied.current === sourceScope
    )
      return
    preferencesApplied.current = sourceScope
    // An initial read may restore a view, but never erase an edit made while that read was pending.
    if (formRevision.current === 0 && !search) {
      const value = preferencesQuery.data.preferences
      setCriteria(value ?? DEFAULT_CRITERIA)
      setSavedName(value?.name ?? '')
      restoreSearch(value?.text ?? '')
    }
    setPreferenceMessage(
      preferencesQuery.data.message ??
        'Preferences are stored on this device, scoped to host, repository and account.',
    )
  }, [preferencesQuery.data, sourceScope, scopeMismatch, scopeRetiring, search, onSearchChange])

  // Consumer-visible instrumentation for the final Electron gate; no samples or PR bodies are retained.
  const computationStart = performance.now()
  const graph = React.useMemo(
    () =>
      projectPrGraph({
        host: origin?.host ?? 'local',
        repository: origin?.repository ?? snapshot.path,
        pullRequests:
          index?.pullRequests ??
          (scopeMismatch || scopeRetiring || snapshotFactsRetired.current
            ? []
            : snapshot.pullRequests.filter(prBelongsToOrigin)),
        branches: snapshot.branches.map((branch) => {
          if (!branch.pr) return branch
          if (!prBelongsToOrigin(branch.pr)) return { ...branch, pr: null }
          const currentPr = indexedByNumber.get(branch.pr.number)
          if (currentPr) {
            if (branch.parentSource === 'pullRequest' && branch.parent !== currentPr.base)
              return {
                ...branch,
                pr: currentPr,
                parent: currentPr.base,
                parentBehind: null,
                parentTip: null,
                needsRestack: undefined,
              }
            return { ...branch, pr: currentPr }
          }
          return scopeRetiring || snapshotFactsRetired.current ? { ...branch, pr: null } : branch
        }),
        nativeStacks: snapshot.nativeStacks,
        complete: Boolean(index?.complete && snapshot.limits.branchesSkipped === 0),
      }),
    [
      index,
      indexedByNumber,
      origin,
      prBelongsToOrigin,
      scopeMismatch,
      scopeRetiring,
      snapshot.path,
      snapshot.pullRequests,
      snapshot.branches,
      snapshot.nativeStacks,
      snapshot.limits.branchesSkipped,
    ],
  )
  const discovery = React.useMemo(() => graphDiscovery(graph), [graph])
  const effectiveCriteria = React.useMemo(
    () => ({ ...criteria, text: onSearchChange ? search : criteria.text }),
    [criteria, search, onSearchChange],
  )
  const outline = React.useMemo(
    () => graphOutline(discovery, effectiveCriteria, viewerIdentity, selected, expanded),
    [discovery, effectiveCriteria, viewerIdentity, selected, expanded],
  )
  const selectedNode =
    selected && !scopeRetiring && !scopeMismatch ? discovery.byId.get(selected) : null
  const focused = React.useMemo(
    () => focusedGraph(discovery, selected, path),
    [discovery, selected, path],
  )
  const allPaths = React.useMemo(() => dependentPaths(discovery, selected), [discovery, selected])
  const paths = React.useMemo(
    () =>
      allPaths.filter((node) => nodeLabel(node).toLowerCase().includes(pathSearch.toLowerCase())),
    [allPaths, pathSearch],
  )
  const authors = React.useMemo(
    () =>
      [...new Set(graph.nodes.flatMap((node) => (node.pr?.author ? [node.pr.author] : [])))].sort(),
    [graph],
  )
  // Coordinates depend only on reduced topology, not checks, review status, detail or camera.
  const topology = JSON.stringify({
    ids: focused.nodes.map((node) => node.id),
    edges: focused.edges.map((edge) => [edge.from, edge.to, edge.source]),
  })
  const layout = React.useMemo(() => {
    const topologyData = JSON.parse(topology) as { ids: string[]; edges: (string | null)[][] }
    const depth = new Map(topologyData.ids.map((id) => [id, 0]))
    for (let pass = 0; pass < topologyData.ids.length; pass++) {
      let changed = false
      for (const [child, parent] of topologyData.edges) {
        if (!child || !parent || !depth.has(parent)) continue
        const next = (depth.get(child) ?? 0) + 1
        if (next > (depth.get(parent) ?? 0)) {
          depth.set(parent, next)
          changed = true
        }
      }
      if (!changed) break
    }
    const ordered = [...topologyData.ids].sort((a, b) => depth.get(a)! - depth.get(b)!)
    const positions = new Map<string, { x: number; y: number }>()
    let row = 0
    let previousDepth = -1
    let lane = 0
    for (const id of ordered) {
      const level = depth.get(id)!
      if (level !== previousDepth || lane === 2) {
        if (positions.size) row++
        lane = 0
        previousDepth = level
      }
      positions.set(id, { x: 28 + lane++ * 270, y: 28 + row * 180 })
    }
    return {
      positions,
      width: [...positions.values()].some((position) => position.x > 28) ? 566 : 296,
      height: Math.max(220, (row + 1) * 180 + 28),
    }
  }, [topology])
  const projectionLayoutMs = performance.now() - computationStart
  const select = (id: string) => {
    setSelected(id)
    setPath(null)
    setPathPage(0)
    setPathSearch('')
  }
  React.useEffect(() => {
    if (scopeMismatch) return
    // IDs are origin-qualified from the first render. Never remap known repositories by PR number.
    if (selected && !selectedNode) setSelected(null)
    else if (!selected && outline.rows.length) setSelected(outline.rows[0].id)
  }, [selected, selectedNode, outline.rows, scopeMismatch])
  const detailPr = selectedNode?.pr ?? selectedNode?.branch?.pr
  const detailQuery = useQuery({
    queryKey: [
      'graph-selected-detail',
      sourceScope,
      detailRevision,
      selectedNode?.id,
      detailPr?.head,
      detailPr?.base,
      detailPr?.headOid,
      detailPr?.checks,
      detailPr?.reviewDecision,
      detailPr?.draft,
      detailPr?.state,
      detailPr?.author,
      detailPr?.metadata,
      detailPr?.title,
      detailPr?.headRepository,
      detailPr?.url,
    ],
    enabled: Boolean(
      index && detailPr && desktop?.prIndexDetail && !scopeMismatch && !scopeRetiring,
    ),
    queryFn: async ({ signal }) => {
      const pr = detailPr!
      const next = await desktop!.prIndexDetail!(pr.number)
      signal.throwIfAborted()
      if (
        !prBelongsToOrigin(next) ||
        next.number !== pr.number ||
        next.url !== pr.url ||
        next.headRepository !== pr.headRepository ||
        next.head !== pr.head ||
        next.base !== pr.base ||
        next.headOid !== pr.headOid
      )
        throw new Error(
          'Detail changed externally or belongs to another repository; refresh the index.',
        )
      return next
    },
  })
  const detail = detailQuery.data ?? null
  const detailState = !detailPr
    ? 'Branch facts only; no synthetic pull request'
    : !index || !desktop?.prIndexDetail
      ? 'Selected PR detail unavailable'
      : detailQuery.isFetching
        ? 'Loading selected PR detail…'
        : detailQuery.error
          ? `Selected detail unavailable: ${String(detailQuery.error)}`
          : detail
            ? 'Selected PR detail loaded'
            : 'No selected detail loaded'
  React.useEffect(() => {
    setScrollTop(0)
    setActiveRow(0)
    if (outlineRef.current) outlineRef.current.scrollTop = 0
  }, [criteria, search])
  const start = Math.min(
    Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3),
    Math.max(0, outline.rows.length - GRAPH_OUTLINE_ROW_LIMIT),
  )
  const mounted = outline.rows.slice(start, start + GRAPH_OUTLINE_ROW_LIMIT)
  const mountedActiveRow = Math.max(start, Math.min(activeRow, start + mounted.length - 1))
  const focusRow = (position: number) => {
    const target = Math.max(0, Math.min(outline.rows.length - 1, position))
    setActiveRow(target)
    const viewport = outlineRef.current
    if (!viewport) return
    viewport.scrollTop = target * ROW_HEIGHT
    setScrollTop(viewport.scrollTop)
    requestAnimationFrame(() =>
      viewport.querySelector<HTMLButtonElement>(`[data-outline-position="${target}"]`)?.focus(),
    )
  }
  const preferenceMutation = useMutation({
    mutationFn: async (request: {
      operation: 'save' | 'reset'
      scope: string
      generation: number
      revision: number
      value: GraphCriteria & { name: string }
      namespace: GraphPreferencesPublicScope
    }) => {
      const result =
        request.operation === 'save'
          ? await desktop?.saveGraphPreferences?.(request.value, request.namespace)
          : await desktop?.resetGraphPreferences?.(request.namespace)
      if (!result) throw new Error('Saved graph preferences are unavailable in this runtime.')
      return validatePreferencesReply(result, request.namespace)
    },
    onSuccess: async (result, request) => {
      if (
        request.generation !== sourceGeneration.current ||
        request.scope !== previousScopeKey.current
      )
        return
      await queryClient.cancelQueries({ queryKey: preferencesKey, exact: true })
      if (
        request.generation !== sourceGeneration.current ||
        request.scope !== previousScopeKey.current
      )
        return
      preferencesApplied.current = sourceScope
      queryClient.setQueryData(preferencesKey, result)
      setPreferenceMessage(
        result.message ??
          (request.operation === 'save' ? 'View saved on this device.' : 'Saved view reset.'),
      )
      if (request.operation === 'reset' && request.revision === formRevision.current) {
        setCriteria(DEFAULT_CRITERIA)
        restoreSearch('')
        setSavedName('')
      }
    },
    onError: (error, request) => {
      if (
        request.generation === sourceGeneration.current &&
        request.scope === previousScopeKey.current
      )
        setPreferenceMessage(`Could not ${request.operation} preferences: ${String(error)}`)
    },
  })
  const previousScopeKey = React.useRef(sourceScope)
  previousScopeKey.current = sourceScope
  const preferenceBusy =
    preferenceMutation.isPending && preferenceMutation.variables?.scope === sourceScope
  const savePreference = (operation: 'save' | 'reset') => {
    if (preferenceBusy || !preferenceAvailable || !expectedPreferencesScope) return
    preferenceMutation.mutate({
      operation,
      scope: sourceScope,
      generation: sourceGeneration.current,
      revision: formRevision.current,
      value: { ...effectiveCriteria, name: savedName.trim() },
      namespace: expectedPreferencesScope,
    })
  }
  // The index owns current headline/status facts. Selected detail enriches body, never overwrites them.
  const selectedPr = detailPr
    ? { ...detailPr, ...(detail ? { body: detail.body } : {}) }
    : undefined
  const local =
    selectedNode?.branch && !selectedNode.branch.remote
      ? selectedNode.branch
      : selectedNode
        ? graph.edges
            .filter(
              (edge) =>
                edge.from === selectedNode.id &&
                edge.source === 'github-head' &&
                edge.resolution === 'resolved',
            )
            .map((edge) => (edge.to ? discovery.byId.get(edge.to)?.branch : undefined))
            .find((branch) => branch && !branch.remote)
        : undefined
  const blocked = busy || Boolean(snapshot.operation || snapshot.stackOperation)
  const status = index
    ? `${index.state} · ${index.pullRequests.length} indexed PRs · ${index.pages} pages${index.complete ? '' : ' · incomplete: missing data does not imply independence'}`
    : 'Remote index unavailable · local refs retained'
  return (
    <div className="graph-workbench" data-graph-projection-layout-ms={projectionLayoutMs}>
      <header className="graph-page-heading">
        <div>
          <h1 id={WORKSPACE_VIEW_HEADING_ID} tabIndex={-1}>
            Stacks
          </h1>
          <p>Actual pull requests and refs, with their dependency evidence.</p>
        </div>
        <Button
          size="sm"
          disabled={indexQuery.isFetching}
          onClick={() => {
            void queryClient
              .fetchQuery({
                queryKey: indexKey,
                staleTime: 0,
                queryFn: ({ signal }) => readIndex(signal, true),
              })
              .catch(() => {})
          }}
        >
          <RefreshCw className="size-3.5" />
          Refresh index
        </Button>
      </header>
      <nav className="graph-presets" aria-label="Repository PR views">
        {PRESETS.map((preset) => (
          <Button
            key={preset.value}
            size="sm"
            variant={criteria.preset === preset.value ? 'accent' : 'ghost'}
            aria-pressed={criteria.preset === preset.value}
            onClick={() => changeCriteria((value) => ({ ...value, preset: preset.value }))}
          >
            {preset.label}
          </Button>
        ))}
      </nav>
      <div className="graph-filters">
        <label>
          Search indexed PRs
          <input
            type="search"
            value={effectiveCriteria.text}
            maxLength={256}
            placeholder="PR, title or ref…"
            onChange={(event) => changeSearch(event.target.value)}
          />
        </label>
        <label>
          Author
          <Select
            value={criteria.author}
            onValueChange={(author) => changeCriteria((value) => ({ ...value, author }))}
            options={[
              { value: '', label: 'Any author' },
              ...authors.map((author) => ({ value: author, label: `@${author}` })),
            ]}
          />
        </label>
        <label>
          Status
          <Select
            value={criteria.status}
            onValueChange={(status) =>
              changeCriteria((value) => ({ ...value, status: status as GraphCriteria['status'] }))
            }
            options={[
              { value: 'all', label: 'All · drafts included' },
              { value: 'draft', label: 'Draft' },
              { value: 'ready', label: 'Not draft' },
              { value: 'checks-failed', label: 'Known failing checks' },
              { value: 'checks-pending', label: 'Known pending checks' },
            ]}
          />
        </label>
        <label className="graph-collapse">
          <input
            type="checkbox"
            checked={criteria.collapse}
            onChange={(event) =>
              changeCriteria((value) => ({ ...value, collapse: event.target.checked }))
            }
          />
          Collapse linear runs
        </label>
      </div>
      <div className="graph-index-status" role="status">
        {status}
        {index?.message ? ` · ${index.message}` : ''}
        {indexError ? ` · ${indexError}` : ''}
        {snapshot.githubStale ? ` · Remote snapshot stale: ${snapshot.githubStale.reason}` : ''}
      </div>
      <details className="graph-saved">
        <summary>Saved view preferences</summary>
        <div className="graph-saved-controls">
          <label>
            View name
            <input
              value={savedName}
              maxLength={80}
              onChange={(event) => {
                formRevision.current++
                setSavedName(event.target.value)
              }}
            />
          </label>
          <Button
            size="sm"
            disabled={
              preferenceBusy ||
              !savedName.trim() ||
              !desktop?.saveGraphPreferences ||
              !preferenceAvailable
            }
            onClick={() => void savePreference('save')}
          >
            Save view
          </Button>
          <Button
            size="sm"
            disabled={!saved || preferenceBusy}
            onClick={() => {
              if (saved) {
                changeCriteria(saved)
                restoreSearch(saved.text)
                setSavedName(saved.name)
              }
            }}
          >
            Restore saved view
          </Button>
          <Button
            size="sm"
            disabled={preferenceBusy || !desktop?.resetGraphPreferences || !preferenceAvailable}
            onClick={() => void savePreference('reset')}
          >
            Reset saved view
          </Button>
        </div>
        <p role="status">
          {preferencesQuery.error
            ? `Could not restore saved view: ${String(preferencesQuery.error)}`
            : preferenceMessage}
        </p>
        <p>
          A view name is a local preference label, never stack metadata. Camera and selection are
          not persisted.
        </p>
      </details>
      <div
        className={
          showInspector ? 'graph-work-area' : 'graph-work-area graph-work-area-inspector-hidden'
        }
      >
        <section className="graph-outline" aria-label="PR and ref outline">
          <header>
            <h2>
              {PRESETS.find((preset) => preset.value === criteria.preset)?.label}{' '}
              <Badge>{outline.matches}</Badge>
            </h2>
            <p>{PRESETS.find((preset) => preset.value === criteria.preset)?.description}</p>
          </header>
          {outline.unknownIdentity ? (
            <p className="graph-notice">
              Signed-in account unknown. Personal matches cannot be established; retained context is
              not an empty personal result.
            </p>
          ) : null}
          <div
            className="graph-outline-scroll"
            ref={outlineRef}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            role="list"
            aria-label="Matching items and prerequisite context"
          >
            <div style={{ height: outline.rows.length * ROW_HEIGHT, position: 'relative' }}>
              {mounted.map((row, offset) => (
                <div
                  className="graph-outline-row"
                  role="listitem"
                  data-graph-outline-row
                  key={row.id}
                  style={{
                    position: 'absolute',
                    top: (start + offset) * ROW_HEIGHT,
                    height: ROW_HEIGHT,
                  }}
                >
                  <button
                    type="button"
                    aria-pressed={row.path.includes(selected ?? '')}
                    data-outline-position={start + offset}
                    tabIndex={start + offset === mountedActiveRow ? 0 : -1}
                    onFocus={() => setActiveRow(start + offset)}
                    onClick={() => select(row.id)}
                    onKeyDown={(event) => {
                      if (event.altKey || event.ctrlKey || event.metaKey) return
                      const position =
                        event.key === 'ArrowDown'
                          ? start + offset + 1
                          : event.key === 'ArrowUp'
                            ? start + offset - 1
                            : event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? outline.rows.length - 1
                                : null
                      if (position !== null) {
                        event.preventDefault()
                        focusRow(position)
                      }
                    }}
                  >
                    <span className="graph-row-title">
                      {row.nodes[0].pr ? (
                        <GitPullRequest className="size-3.5" />
                      ) : (
                        <GitBranch className="size-3.5" />
                      )}
                      <strong>
                        {row.nodes.length > 1
                          ? `${row.nodes[0].name} → ${row.nodes[row.nodes.length - 1].name} · ${row.nodes.length} items`
                          : nodeLabel(row.nodes[0])}
                      </strong>
                    </span>
                    <small>
                      {row.role === 'selected-context'
                        ? 'Selected · outside active filter'
                        : row.role === 'context'
                          ? row.nodes[0].branch && !row.nodes[0].branch.pr
                            ? 'Branch-only discovery · not a PR'
                            : 'Prerequisite context · not a match'
                          : row.nodes.length > 1
                            ? 'Matching PRs · authors remain individual'
                            : row.nodes[0].pr?.author
                              ? `Match · @${row.nodes[0].pr.author}`
                              : 'Current local checkout'}
                      {row.nodes.length > 1 ? ' · collapsed actual path' : ''}
                    </small>
                  </button>
                  {row.nodes.length > 1 ? (
                    <Button
                      size="sm"
                      variant="link"
                      onClick={() => setExpanded((value) => new Set([...value, ...row.path]))}
                    >
                      Expand {row.nodes.length} items
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            {!outline.rows.length ? (
              <p className="graph-notice">
                {index?.complete
                  ? 'No known items match these filters.'
                  : 'No matches in loaded data. The repository index is incomplete.'}
              </p>
            ) : null}
          </div>
          <footer>
            {mounted.length} mounted / {outline.rows.length} rows · limit {GRAPH_OUTLINE_ROW_LIMIT}
          </footer>
        </section>
        <section className="graph-focused" aria-label="Focused dependency graph">
          <header>
            <h2>
              PR dependencies <Badge variant="accent">Focused</Badge>
            </h2>
            <p>Parents retain exact source attachments. View grouping never scopes a mutation.</p>
          </header>
          <div className="graph-camera">
            <Button
              size="icon-sm"
              aria-label="Zoom graph out"
              disabled={zoom <= 0.5}
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}
            >
              <Minus className="size-3.5" />
            </Button>
            <span>{Math.round(zoom * 100)}%</span>
            <Button
              size="icon-sm"
              aria-label="Zoom graph in"
              disabled={zoom >= 1.5}
              onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}
            >
              <Plus className="size-3.5" />
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const viewport = graphRef.current
                if (viewport) {
                  setZoom(Math.max(0.5, Math.min(1, (viewport.clientWidth - 24) / layout.width)))
                  viewport.scrollTo(0, 0)
                }
              }}
            >
              <Maximize2 className="size-3.5" />
              Fit graph
            </Button>
            <Button
              size="sm"
              className="graph-inspector-toggle"
              aria-expanded={showInspector}
              onClick={() => toggleInspector()}
            >
              Selected details
            </Button>
          </div>
          <div
            className="graph-viewport"
            ref={graphRef}
            role="region"
            tabIndex={0}
            aria-label="Scrollable graph canvas"
          >
            <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
              <div
                className="graph-world"
                style={{
                  width: layout.width,
                  height: layout.height,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              >
                <svg
                  width={layout.width}
                  height={layout.height}
                  aria-label="Source-backed dependency attachments"
                  className="graph-edges"
                >
                  {focused.edges.map((edge, i) => {
                    const from = layout.positions.get(edge.from)
                    const to = edge.to ? layout.positions.get(edge.to) : null
                    return from && to ? (
                      <g key={i}>
                        <path
                          className={`graph-edge graph-edge-${edge.source}`}
                          d={`M${from.x + 122},${from.y + 142} C${from.x + 122},${from.y + 162} ${to.x + 122},${to.y - 20} ${to.x + 122},${to.y}`}
                        />
                        <title>
                          {SOURCE_LABEL[edge.source]}: {edge.target}
                        </title>
                      </g>
                    ) : null
                  })}
                </svg>
                {focused.nodes.map((node) => {
                  const position = layout.positions.get(node.id)!
                  return (
                    <button
                      type="button"
                      className="graph-node"
                      data-graph-node
                      key={node.id}
                      aria-pressed={node.id === selected}
                      style={{ left: position.x, top: position.y }}
                      onClick={() => select(node.id)}
                    >
                      <span className="graph-node-identity">
                        {node.pr ? (
                          <GitPullRequest className="size-3.5" />
                        ) : (
                          <GitBranch className="size-3.5" />
                        )}
                        {node.name}
                        <Badge>
                          {node.pr?.state.toLowerCase() ??
                            (node.branch?.remote ? 'Remote ref' : 'Local branch')}
                        </Badge>
                      </span>
                      <strong>{node.pr?.title ?? node.branch?.subject ?? node.name}</strong>
                      <code title={node.pr?.head ?? node.name}>{node.pr?.head ?? node.name}</code>
                      <small>
                        {node.pr
                          ? `${node.pr.author ? `@${node.pr.author}` : 'Author unknown'} · ${node.pr.draft ? 'Draft · ' : ''}${checksLabel(node.pr)}`
                          : node.branch?.current
                            ? 'Current checkout · selection is read-only'
                            : 'Ref facts · not a synthetic PR'}
                      </small>
                    </button>
                  )
                })}
              </div>
            </div>
            {!selectedNode ? (
              <p className="graph-notice">Select an actual PR or branch to inspect dependencies.</p>
            ) : null}
          </div>
          <details className="graph-paths">
            <summary>Dependent paths · {allPaths.length} available endpoints</summary>
            <label>
              Search dependent paths
              <input
                type="search"
                value={pathSearch}
                onChange={(event) => {
                  setPathSearch(event.target.value)
                  setPathPage(0)
                }}
              />
            </label>
            <ul>
              {paths
                .slice(pathPage * GRAPH_PATH_PAGE_SIZE, (pathPage + 1) * GRAPH_PATH_PAGE_SIZE)
                .map((node) => (
                  <li key={node.id}>
                    <Button variant="link" size="sm" onClick={() => setPath(node.id)}>
                      {nodeLabel(node)}
                    </Button>
                    <small>Exact prerequisites retained; no sibling lanes inferred.</small>
                  </li>
                ))}
            </ul>
            <div className="graph-path-paging">
              <Button
                size="sm"
                disabled={!pathPage}
                onClick={() => setPathPage((value) => value - 1)}
              >
                Previous paths
              </Button>
              <span>
                {Math.min(paths.length, pathPage * GRAPH_PATH_PAGE_SIZE + 1)}–
                {Math.min(paths.length, (pathPage + 1) * GRAPH_PATH_PAGE_SIZE)} / {paths.length}
              </span>
              <Button
                size="sm"
                disabled={(pathPage + 1) * GRAPH_PATH_PAGE_SIZE >= paths.length}
                onClick={() => setPathPage((value) => value + 1)}
              >
                Next paths
              </Button>
            </div>
          </details>
          <footer>
            {focused.nodes.length} detailed nodes · limit {GRAPH_DETAIL_NODE_LIMIT}
            {focused.omitted
              ? ` · ${focused.omitted} queued prerequisites omitted; inspect endpoints in outline`
              : ''}{' '}
            · PR base: solid; local intent: dashed; ancestry: dotted
          </footer>
        </section>
        <aside
          id="graph-inspector"
          className={`graph-inspector${showInspector ? ' graph-inspector-open' : ''}`}
          aria-label="Selected PR or ref details"
        >
          <header>
            <h2>Selected details</h2>
          </header>
          {selectedNode ? (
            <div className="graph-inspector-content">
              <h3>{nodeLabel(selectedNode)}</h3>
              <p>{selectedNode.repository}</p>
              {selectedPr ? (
                <>
                  <p>Author: {selectedPr.author ? `@${selectedPr.author}` : 'Unknown'}</p>
                  <p>
                    {selectedPr.state.toLowerCase()} · {selectedPr.draft ? 'draft' : 'not draft'} ·{' '}
                    {checksLabel(selectedPr)}
                  </p>
                  <dl>
                    <dt>Head</dt>
                    <dd>
                      <code>{selectedPr.head}</code>
                    </dd>
                    <dt>Head repository</dt>
                    <dd>{selectedPr.headRepository ?? 'Unknown'}</dd>
                    <dt>PR base target</dt>
                    <dd>
                      <code>{selectedPr.base}</code>
                    </dd>
                  </dl>
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={() => onReviewNumber(selectedPr.number)}
                  >
                    Review #{selectedPr.number}
                  </Button>
                  <p role="status">{detailState}</p>
                  {detail?.body ? (
                    <details>
                      <summary>PR description</summary>
                      <p className="graph-description">{detail.body}</p>
                    </details>
                  ) : null}
                </>
              ) : (
                <p>
                  {selectedNode.branch?.remote
                    ? 'Remote ref · no local checkout established'
                    : 'Local branch · no PR identity established'}
                </p>
              )}
              <h3>Relationship evidence</h3>
              <ul className="graph-evidence">
                {graph.edges
                  .filter(
                    (edge) =>
                      edge.from === selectedNode.id ||
                      (local &&
                        edge.from ===
                          graph.nodes.find((node) => node.branch?.ref === local.ref)?.id),
                  )
                  .map((edge, i) => (
                    <li key={i}>
                      <strong>{SOURCE_LABEL[edge.source]}</strong>
                      <code>{edge.target}</code>
                      <span>
                        {edge.resolution}
                        {edge.candidates.length > 1
                          ? ` · ${edge.candidates.length} candidates`
                          : ''}
                      </span>
                    </li>
                  ))}
              </ul>
              {graph.conflicts
                .filter((conflict) => conflict.pr === selectedNode.id)
                .map((conflict, i) => (
                  <p className="graph-notice" key={i}>
                    Source disagreement: GitHub target {conflict.githubTarget};{' '}
                    {SOURCE_LABEL[conflict.source]} {conflict.otherTarget}. Nothing is rewritten.
                  </p>
                ))}
              {selectedPr?.stack ? (
                <p>
                  Native annotation: submitted #{selectedPr.stack.stackNumber}, position{' '}
                  {selectedPr.stack.position}/{selectedPr.stack.size}. Not a local owner or mutation
                  partition.
                </p>
              ) : null}
              {local ? (
                <>
                  <h3>Actual local branch</h3>
                  <code>{local.ref}</code>
                  <p>
                    {local.current
                      ? 'Current checkout'
                      : `Checkout remains ${snapshot.currentBranch ?? 'detached'}`}
                  </p>
                  <p>
                    Recorded parent: {local.recordedParent ?? 'Not recorded'} · parent comparison{' '}
                    {local.parentBehind === null
                      ? 'unknown'
                      : `${local.parentBehind} commits behind`}
                    {local.needsRestack ? ' · restack required' : ''}
                  </p>
                  <div className="graph-local-actions">
                    <Button
                      size="sm"
                      disabled={
                        blocked || Boolean(actionBlockReason(snapshot.capabilities, 'setParent'))
                      }
                      tooltip={
                        actionBlockReason(snapshot.capabilities, 'setParent') ??
                        'Record local intent through the existing parent workflow.'
                      }
                      onClick={() => onRequest({ kind: 'parent', branch: local })}
                    >
                      Set parent…
                    </Button>
                    {(['restack', 'publish', 'merge'] as const).map((operation) => (
                      <Button
                        key={operation}
                        size="sm"
                        disabled={
                          blocked ||
                          Boolean(actionBlockReason(snapshot.capabilities, 'executeStack')) ||
                          (operation !== 'restack' && !snapshot.github.available) ||
                          (operation === 'merge' &&
                            (!selectedPr ||
                              selectedPr.state !== 'OPEN' ||
                              selectedPr.base !== snapshot.defaultBranch))
                        }
                        tooltip={
                          actionBlockReason(snapshot.capabilities, 'executeStack') ??
                          'Existing captured preview and confirmation gates determine the actual scope.'
                        }
                        onClick={() => onRequest({ kind: 'stack', branch: local.name, operation })}
                      >
                        {operation === 'merge'
                          ? 'Preview merge…'
                          : operation === 'publish'
                            ? 'Publish…'
                            : 'Restack…'}
                      </Button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="graph-notice">
                  No actual local branch established. Remote facts are inspectable; local mutation
                  controls are unavailable. Selecting never checks out or fetches refs.
                </p>
              )}
            </div>
          ) : (
            <p className="graph-notice">No item selected.</p>
          )}
        </aside>
      </div>
      <details className="graph-reconciliation">
        <summary>Submitted native order and reconciliation</summary>
        {snapshot.nativeStackPreviewAvailable === false ? (
          <p>
            {snapshot.nativeStackMessage ??
              'Native preview unavailable; chained PR facts remain separate.'}
          </p>
        ) : null}
        {snapshot.nativeStacks?.map((native) => (
          <section key={native.id}>
            <h3>
              Submitted native #{native.number} · {native.status}
            </h3>
            <ol className="graph-submitted-order">
              {[...native.pullRequests]
                .sort((a, b) => a.position - b.position)
                .map((member) => (
                  <li key={member.number}>
                    <Button size="sm" variant="link" onClick={() => onReviewNumber(member.number)}>
                      #{member.number}{' '}
                      {snapshot.pullRequests.find((pr) => pr.number === member.number)?.title ??
                        member.head}
                    </Button>{' '}
                    · {member.state.toLowerCase()} · position {member.position}/{member.total}
                  </li>
                ))}
            </ol>
          </section>
        ))}
        <ReconciliationPanel
          snapshot={snapshot}
          authority={authority}
          busy={busy}
          runAction={runAction}
          actionError={actionError}
          onClearActionError={onClearActionError}
        />
      </details>
      <footer className="graph-workbench-footer">
        <span>
          Current checkout: {snapshot.currentBranch ?? 'detached'} · Selection is not checkout.
          Unknown is not absent.
        </span>
        <Button
          size="sm"
          disabled={blocked || Boolean(actionBlockReason(snapshot.capabilities, 'createBranch'))}
          tooltip={
            actionBlockReason(snapshot.capabilities, 'createBranch') ??
            'Open the existing create-branch workflow.'
          }
          onClick={onCreate}
        >
          New branch…
        </Button>
      </footer>
    </div>
  )
}
