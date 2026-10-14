import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  IconButton,
  Input,
  Select,
  SegmentedControl,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Sheet,
  SheetContent,
  SheetTitle,
  WorkbenchPane,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@git-stacks/ui'
import {
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  Copy,
  Eye,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  History,
  Inbox,
  Info,
  Layers,
  MoreHorizontal,
  Search,
  Settings2,
  ShieldCheck,
  X,
  Clock,
  CircleAlert,
  MessageSquare,
} from 'lucide-react'
import {
  initialWorkbenchView,
  laneDescendantCounts,
  relatedLaneIds,
  type WorkbenchViewState,
  projectBranchLanes,
  type BranchWorkbenchSnapshot,
  type LaneEntry,
  type WorkbenchAction,
  type WorkbenchActionContext,
  type WorkbenchCapabilities,
  type WorkbenchFact,
} from './branch-workbench-model'
import './branch-workbench.css'
import { LIST_PAGE_SIZE } from '@git-stacks/shared/performance'

export interface BranchWorkbenchProps {
  snapshot: BranchWorkbenchSnapshot
  repositoryId: string
  density?: 'compact' | 'standard'
  selectedBranchId: string | null
  capabilities: WorkbenchCapabilities
  onRepositoryChange: (id: string) => void
  onSelectionChange: (id: string) => void
  onAction: (action: WorkbenchAction, context: WorkbenchActionContext) => void
  /** Real detail/review consumers can supply read-only tab contents without a second route. */
  detailPanels?: Partial<Record<'overview' | 'changes' | 'checks' | 'discussion', React.ReactNode>>
  viewState?: WorkbenchViewState
  onViewStateChange?: (state: WorkbenchViewState) => void
  onWorktreeChange?: (id: string | null) => void
  resolveCopyPath?: (context: WorkbenchActionContext) => Promise<string>
  surface?: 'branches' | 'pull-requests' | 'attention' | 'activity' | 'review'
  mainPanel?: React.ReactNode
  topUtilities?: React.ReactNode
  sidebarUtilities?: React.ReactNode
}

const filters = ['All branches', 'Needs you', 'Unpublished', 'Ready to merge'] as const

function BranchActions({
  context,
  capabilities,
  onAction,
}: Pick<BranchWorkbenchProps, 'capabilities' | 'onAction'> & { context: WorkbenchActionContext }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton label="More branch and worktree actions" variant="ghost">
            <MoreHorizontal />
          </IconButton>
        }
      />
      <DropdownMenuContent align="end">
        {(
          [
            ['create-worktree', 'Create worktree…'],
            ['restack', 'Preview restack…'],
            ['sync', 'Preview synchronization…'],
            ['publish', 'Preview publication…'],
            ['open-directory', 'Open working directory'],
          ] as const
        ).map(([kind, label]) => {
          const capability = capabilities[kind]
          const reason =
            capability?.reason ??
            (!capability
              ? 'Unavailable in this context'
              : kind === 'open-directory' && !context.worktreeId
                ? 'No associated worktree'
                : undefined)
          return (
            <DropdownMenuItem
              key={kind}
              disabled={Boolean(reason)}
              onClick={() => onAction(kind, context)}
            >
              {label}
              {reason ? <small className="ml-2">{reason}</small> : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const FACT_ICONS = {
  circle: Circle,
  check: CheckCircle2,
  review: Eye,
  comment: MessageSquare,
  error: CircleAlert,
  clock: Clock,
  merge: GitMerge,
}

function Fact({ fact }: { fact: WorkbenchFact }) {
  const Icon = FACT_ICONS[fact.icon ?? 'circle']
  return (
    <span className={`bw-fact bw-${fact.tone ?? 'neutral'}`}>
      <Icon aria-hidden="true" />
      {fact.label}
    </span>
  )
}

function RelationshipLines({
  entries,
  related,
  selectedId,
}: {
  entries: LaneEntry[]
  related: ReadonlySet<string>
  selectedId: string | null
}) {
  const svg = useRef<SVGSVGElement>(null)
  const [points, setPoints] = useState<Record<string, { x: number; y: number }>>({})
  useLayoutEffect(() => {
    const body = svg.current?.parentElement
    if (!body) return
    const measure = () => {
      const origin = body.getBoundingClientRect()
      const next: Record<string, { x: number; y: number }> = {}
      for (const row of body.querySelectorAll<HTMLElement>('[data-branch-id]')) {
        const track = row.querySelector<HTMLElement>('.bw-track')
        if (!track) continue
        const box = row.getBoundingClientRect()
        const trackBox = track.getBoundingClientRect()
        const step = Number.parseFloat(getComputedStyle(body).getPropertyValue('--bw-step')) || 20
        next[row.dataset.branchId!] = {
          x: trackBox.left - origin.left + 14 + Number(row.dataset.lane) * step,
          y: box.top - origin.top + box.height / 2,
        }
      }
      setPoints(next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    for (const row of body.querySelectorAll('[data-branch-id]')) observer.observe(row)
    measure()
    return () => observer.disconnect()
  }, [entries])
  return (
    <svg ref={svg} className="bw-lines" aria-hidden="true">
      {entries.map((entry) => {
        const point = points[entry.branch.id]
        const parent = entry.parentId ? points[entry.parentId] : null
        if (!point || !parent) return null
        const path =
          point.x === parent.x
            ? `M ${parent.x} ${parent.y} V ${point.y}`
            : `M ${parent.x} ${parent.y} V ${point.y + 12} Q ${parent.x} ${point.y} ${parent.x + 12} ${point.y} H ${point.x}`
        return (
          <path
            key={entry.branch.id}
            className={related.has(entry.branch.id) ? 'bw-related' : ''}
            d={path}
          />
        )
      })}
      {entries.map((entry) => {
        const point = points[entry.branch.id]
        if (!point) return null
        const active = entry.branch.id === selectedId
        return (
          <g key={entry.branch.id}>
            {active ? <circle className="bw-halo" cx={point.x} cy={point.y} r={9} /> : null}
            <circle
              className={`bw-node ${active ? 'bw-active-node' : related.has(entry.branch.id) ? 'bw-related-node' : ''}`}
              cx={point.x}
              cy={point.y}
              r={entry.branch.trunk ? 4.5 : active ? 5 : 4}
            />
          </g>
        )
      })}
    </svg>
  )
}

export function BranchWorkbench({
  snapshot,
  repositoryId,
  density = 'compact',
  selectedBranchId,
  capabilities,
  onRepositoryChange,
  onSelectionChange,
  onAction,
  detailPanels,
  viewState: suppliedViewState,
  onViewStateChange,
  onWorktreeChange,
  resolveCopyPath,
  surface = 'branches',
  mainPanel,
  topUtilities,
  sidebarUtilities,
}: BranchWorkbenchProps) {
  const viewState = suppliedViewState ?? initialWorkbenchView
  const controlledInspector = suppliedViewState !== undefined && onViewStateChange !== undefined
  const repository = snapshot.repositories.find((repo) => repo.id === repositoryId)
  const branches = useMemo(
    () => snapshot.branches.filter((branch) => branch.repositoryId === repositoryId),
    [snapshot.branches, repositoryId],
  )
  const layout = useMemo(() => {
    const start = performance.now()
    const entries = projectBranchLanes(branches)
    return { entries, elapsed: performance.now() - start }
  }, [branches])
  const topology = layout.entries
  const related = useMemo(
    () => relatedLaneIds(topology, selectedBranchId),
    [topology, selectedBranchId],
  )
  const descendants = useMemo(() => laneDescendantCounts(topology), [topology])
  const byId = useMemo(() => new Map(topology.map((entry) => [entry.branch.id, entry])), [topology])
  const childCounts = useMemo(() => {
    const result = new Map<string, number>()
    for (const entry of topology)
      if (entry.parentId) result.set(entry.parentId, (result.get(entry.parentId) ?? 0) + 1)
    return result
  }, [topology])
  const [query, setQuery] = useState(viewState.query)
  const [filter, setFilter] = useState<string>(viewState.filter)
  const [scope, setScope] = useState(viewState.scope)
  const [refScope, setRefScope] = useState(viewState.refScope)
  const [page, setPage] = useState(viewState.page)
  const [displayDensity, setDisplayDensity] = useState(viewState.density ?? density)
  const [folded, setFolded] = useState<Set<string>>(new Set(viewState.folded))
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [focusedBranchId, setFocusedBranchId] = useState<string | null>(selectedBranchId)
  const pendingRowFocus = useRef<string | null>(null)
  const [localTab, setLocalTab] = useState(viewState.tab)
  const tab = controlledInspector ? viewState.tab : localTab
  const [relationshipPage, setRelationshipPage] = useState(0)
  const [worktreePage, setWorktreePage] = useState(0)
  const [repositoryPage, setRepositoryPage] = useState(() =>
    Math.max(
      0,
      Math.floor(
        snapshot.repositories.findIndex((repo) => repo.id === repositoryId) / LIST_PAGE_SIZE,
      ),
    ),
  )
  const repositoryPages = Math.max(1, Math.ceil(snapshot.repositories.length / LIST_PAGE_SIZE))
  const currentRepositoryPage = Math.min(repositoryPage, repositoryPages - 1)
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1040)
  const [localWorktreeId, setLocalWorktreeId] = useState<string | null>(viewState.worktreeId)
  const worktreeId = controlledInspector ? viewState.worktreeId : localWorktreeId
  const [copyResult, setCopyResult] = useState('')
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1039px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1039px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = viewState.scroll
  }, [surface, repositoryId])
  const filtering = Boolean(query) || filter !== filters[0] || scope !== 'all' || refScope !== 'all'
  const unfiltered = useRef({
    scroll: viewState.unfilteredScroll ?? viewState.scroll,
    page: viewState.unfilteredPage ?? page,
  })
  const restoringFilter = useRef(false)
  const persistView = (
    scrollTop = scroll.current?.scrollTop ?? viewState.scroll,
    overrides: Partial<WorkbenchViewState> = {},
  ) => {
    if (!filtering && !restoringFilter.current) unfiltered.current = { scroll: scrollTop, page }
    onViewStateChange?.({
      query,
      filter,
      scope,
      refScope,
      folded: [...folded],
      tab,
      worktreeId,
      scroll: scrollTop,
      page,
      unfilteredScroll: unfiltered.current.scroll,
      unfilteredPage: unfiltered.current.page,
      density: displayDensity,
      ...overrides,
    })
  }
  const setTab = (value: WorkbenchViewState['tab']) => {
    if (controlledInspector) persistView(undefined, { tab: value })
    else setLocalTab(value)
  }
  const setWorktreeId = (value: string | null) => {
    if (controlledInspector) persistView(undefined, { worktreeId: value })
    else setLocalWorktreeId(value)
  }
  useEffect(() => {
    persistView()
  }, [query, filter, scope, refScope, folded, tab, worktreeId, page, displayDensity])
  const filterIdentity = `${query}\0${filter}\0${scope}\0${refScope}`
  const previousFilter = useRef({ identity: filterIdentity, active: filtering })
  useLayoutEffect(() => {
    if (previousFilter.current.identity !== filterIdentity) {
      setChecked(new Set())
      if (previousFilter.current.active && !filtering) {
        restoringFilter.current = true
        setPage(unfiltered.current.page)
      } else if (filtering) setPage(0)
    }
    previousFilter.current = { identity: filterIdentity, active: filtering }
  }, [filterIdentity])
  useLayoutEffect(() => {
    if (restoringFilter.current && page === unfiltered.current.page && scroll.current) {
      scroll.current.scrollTop = unfiltered.current.scroll
      restoringFilter.current = false
    }
  }, [page, filterIdentity])
  const foldAnchor = useRef<{ id: string; top: number } | null>(null)
  useLayoutEffect(() => {
    const anchor = foldAnchor.current
    foldAnchor.current = null
    if (!anchor || !scroll.current) return
    const row = document.getElementById(`branch-${anchor.id}`)
    if (row) scroll.current.scrollTop += row.getBoundingClientRect().top - anchor.top
  }, [folded])
  const selected = branches.find((branch) => branch.id === selectedBranchId)
  const selectedLane = topology.find((entry) => entry.branch.id === selectedBranchId)
  const worktree =
    selected?.worktrees.find((tree) => tree.id === worktreeId) ??
    (worktreeId === null && selected?.worktreesKnown === true && selected.worktrees.length === 1
      ? selected.worktrees[0]
      : undefined)
  const worktreePages = Math.max(1, Math.ceil((selected?.worktrees.length ?? 0) / LIST_PAGE_SIZE))
  const currentWorktreePage = Math.min(worktreePage, worktreePages - 1)
  const worktreeChoices =
    selected?.worktrees.slice(
      currentWorktreePage * LIST_PAGE_SIZE,
      (currentWorktreePage + 1) * LIST_PAGE_SIZE,
    ) ?? []
  if (worktree && !worktreeChoices.some((tree) => tree.id === worktree.id))
    worktreeChoices.unshift(worktree)
  const context: WorkbenchActionContext = {
    repositoryId,
    branchId: selected?.id,
    worktreeId: worktree?.id,
    pullRequestId: selected?.pullRequest?.id,
  }
  const editorReason = !worktree
    ? selected && selected.worktrees.length > 1
      ? 'Choose a working directory first'
      : 'No associated working directory'
    : (capabilities['open-directory']?.reason ??
      (!capabilities['open-directory'] ? 'Editor handoff is unavailable' : undefined))
  const hidden = new Set<string>()
  if (!filtering) {
    for (let index = topology.length - 1; index >= 0; index--) {
      const entry = topology[index]
      if (entry.parentId && (folded.has(entry.parentId) || hidden.has(entry.parentId)))
        hidden.add(entry.branch.id)
    }
  }
  const matching = topology.filter(({ branch }) => {
    if (hidden.has(branch.id)) return false
    if (refScope === 'local' && branch.refKind !== 'local') return false
    if (refScope === 'remote' && branch.refKind !== 'remote') return false
    if (scope === 'with' && !branch.worktrees.length) return false
    if (scope === 'without' && (branch.worktreesKnown !== true || branch.worktrees.length))
      return false
    if (filter === 'Needs you' && !branch.attention) return false
    if (filter === 'Unpublished' && !(branch.unpushed && branch.unpushed > 0)) return false
    if (filter === 'Ready to merge' && branch.readyToMerge !== true) return false
    if (
      query &&
      !`${branch.ref} ${branch.title} ${branch.pullRequest ? `#${branch.pullRequest.number}` : ''} ${branch.worktrees.map((tree) => tree.path).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
      return false
    return true
  })
  const matchIds = new Set(matching.map(({ branch }) => branch.id))
  const included = new Set(matchIds)
  for (const entry of matching) {
    let parent = entry.parentId ? byId.get(entry.parentId) : undefined
    while (parent && !included.has(parent.branch.id)) {
      included.add(parent.branch.id)
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }
  }
  let selectedContext = selectedBranchId ? byId.get(selectedBranchId) : undefined
  while (selectedContext && !included.has(selectedContext.branch.id)) {
    included.add(selectedContext.branch.id)
    selectedContext = selectedContext.parentId ? byId.get(selectedContext.parentId) : undefined
  }
  const allEntries = topology.filter((entry) => included.has(entry.branch.id))
  const pageCount = Math.max(1, Math.ceil(allEntries.length / LIST_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const entries = allEntries.slice(currentPage * LIST_PAGE_SIZE, (currentPage + 1) * LIST_PAGE_SIZE)
  useLayoutEffect(() => {
    if (!pendingRowFocus.current) return
    document.getElementById(`branch-${pendingRowFocus.current}`)?.focus()
    pendingRowFocus.current = null
  }, [currentPage, focusedBranchId])
  const pageIds = new Set(entries.map((entry) => entry.branch.id))
  const omittedEdges = entries.filter(
    (entry) => entry.parentId && !pageIds.has(entry.parentId),
  ).length
  const mountedChildren = new Map<string, number>()
  for (const entry of entries)
    if (entry.parentId)
      mountedChildren.set(entry.parentId, (mountedChildren.get(entry.parentId) ?? 0) + 1)
  const selectedChildren = topology.filter((entry) => entry.parentId === selectedBranchId)
  const oldSelection = useRef(selectedBranchId)
  useEffect(() => {
    if (oldSelection.current === selectedBranchId) return
    oldSelection.current = selectedBranchId
    const index = allEntries.findIndex((entry) => entry.branch.id === selectedBranchId)
    if (index >= 0) setPage(Math.floor(index / LIST_PAGE_SIZE))
    setChecked(new Set())
    setRelationshipPage(0)
    setWorktreePage(0)
    if (!narrow) setInspectorOpen(Boolean(selectedBranchId))
  }, [selectedBranchId, allEntries])
  const focusId = entries.some((entry) => entry.branch.id === focusedBranchId)
    ? focusedBranchId
    : entries.some((entry) => entry.branch.id === selectedBranchId)
      ? selectedBranchId
      : entries[0]?.branch.id
  const selectable = entries
    .filter(
      ({ branch }) =>
        matchIds.has(branch.id) &&
        !branch.trunk &&
        branch.bulkEligible === true &&
        branch.conflicted === false &&
        !branch.parentIssue,
    )
    .map(({ branch }) => branch.id)
  const eligibility = selectable.join('\0')
  useEffect(() => {
    setChecked((previous) => {
      const next = new Set([...previous].filter((id) => selectable.includes(id)))
      return next.size === previous.size ? previous : next
    })
  }, [eligibility])
  let countAttention: number | null = 0
  let countReady: number | null = 0
  for (const repo of snapshot.repositories) {
    countAttention =
      countAttention === null || repo.attentionCount === null
        ? null
        : countAttention + repo.attentionCount
    countReady =
      countReady === null || repo.readyToMergeCount === null
        ? null
        : countReady + repo.readyToMergeCount
  }
  if (snapshot.globalCounts) {
    countAttention = snapshot.globalCounts.attention
    countReady = snapshot.globalCounts.readyToMerge
  }
  const action = (
    kind: WorkbenchAction,
    label: React.ReactNode,
    localContext = context,
    variant: 'default' | 'secondary' | 'ghost' = 'secondary',
  ) => {
    const capability = capabilities[kind]
    const reason = capability?.reason ?? (!capability ? 'Unavailable in this context' : undefined)
    return (
      <Button
        size="sm"
        variant={variant}
        disabled={Boolean(reason)}
        tooltip={reason}
        onClick={() => onAction(kind, localContext)}
      >
        {label}
      </Button>
    )
  }
  function inspect(id: string) {
    setFocusedBranchId(id)
    onSelectionChange(id)
    if (!controlledInspector) {
      setLocalWorktreeId(null)
      setLocalTab('overview')
    }
    setCopyResult('')
    setInspectorOpen(true)
  }
  function switchRepository(id: string) {
    persistView()
    onRepositoryChange(id)
  }
  function toggleFold(id: string) {
    const row = document.getElementById(`branch-${id}`)
    if (row) foldAnchor.current = { id, top: row.getBoundingClientRect().top }
    setFolded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setChecked(new Set())
  }
  async function copyPath() {
    if (!worktree) return
    let path = worktree.path
    try {
      if (resolveCopyPath) path = await resolveCopyPath(context)
    } catch (error) {
      setCopyResult(error instanceof Error ? error.message : String(error))
      return
    }
    try {
      await navigator.clipboard.writeText(path)
      setCopyResult(`Path copied: ${path}`)
    } catch {
      setCopyResult(`Clipboard unavailable. Copy the validated full path: ${path}`)
    }
  }
  const inspector =
    selected && inspectorOpen && surface === 'branches' ? (
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as WorkbenchViewState['tab'])}
        style={{ display: 'contents' }}
      >
        <WorkbenchPane
          className="bw-inspector"
          role="complementary"
          aria-label="Selected branch details"
          header={
            <>
              <div className="bw-inspector-head">
                <div className="bw-between">
                  <span className="bw-muted">
                    <GitBranch />
                    {repository?.name ?? 'Repository unavailable'} / Branch inspector
                  </span>
                  <IconButton
                    label="Close inspector"
                    variant="ghost"
                    onClick={() => setInspectorOpen(false)}
                  >
                    <X />
                  </IconButton>
                </div>
                <div className="bw-ref">{selected.ref}</div>
                <h2>{selected.title}</h2>
                <div className="bw-meta">
                  {selected.pullRequest ? (
                    <>
                      <Badge
                        variant={
                          selected.pullRequest.lifecycle.tone === 'merged'
                            ? 'merged'
                            : selected.pullRequest.lifecycle.tone === 'success'
                              ? 'success'
                              : selected.pullRequest.lifecycle.tone === 'error'
                                ? 'danger'
                                : 'secondary'
                        }
                      >
                        <GitPullRequest />
                        {selected.pullRequest.lifecycle.label}
                      </Badge>
                      <span>#{selected.pullRequest.number}</span>
                      <span>·</span>
                      <span>{selected.pullRequest.author ?? 'Unknown author'}</span>
                    </>
                  ) : (
                    <Badge variant="secondary">
                      {selected.pullRequest === null ? 'Branch / ref' : 'PR metadata unknown'}
                    </Badge>
                  )}
                </div>
              </div>
              <TabsList
                variant="line"
                controlSize="compact"
                className="bw-tabs"
                aria-label="Branch details"
              >
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="changes">
                  Changes{worktree?.changedFiles ? ` ${worktree.changedFiles}` : ''}
                </TabsTrigger>
                <TabsTrigger value="checks">Checks</TabsTrigger>
                <TabsTrigger value="discussion">Discussion</TabsTrigger>
              </TabsList>
            </>
          }
          footer={
            <div className="bw-inspector-actions">
              {action(
                selected.pullRequest ? 'review' : 'history',
                <>
                  <Eye />
                  {selected.pullRequest ? 'Review pull request' : 'Inspect branch history'}
                  <ArrowUpRight />
                </>,
                context,
                'default',
              )}
              <div className="bw-between">
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
                  disabled={!worktree}
                  tooltip={!worktree ? 'No associated worktree' : undefined}
                  onClick={() => void copyPath()}
                >
                  <Copy />
                  Copy worktree path
                </Button>
                <span className="bw-directory-actions">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <IconButton label="Selected working directory actions" variant="ghost">
                          <MoreHorizontal />
                        </IconButton>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={Boolean(editorReason)}
                        onClick={() => onAction('open-directory', context)}
                      >
                        Open working directory
                        {editorReason ? <small className="ml-2">{editorReason}</small> : null}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </div>
              <small>
                {worktree
                  ? 'Review here. Develop in your editor.'
                  : 'Review without creating a worktree'}
              </small>
              {copyResult ? <p role="status">{copyResult}</p> : null}
            </div>
          }
          bodyClassName="bw-inspector-scroll"
        >
          <TabsContent key={tab} value={tab}>
            {tab !== 'overview' ? (
              (detailPanels?.[tab as 'changes' | 'checks' | 'discussion'] ?? (
                <div role="status" className="bw-notice">
                  <Info />
                  <div>
                    <strong>
                      {tab === 'changes'
                        ? 'Read-only changes'
                        : tab === 'checks'
                          ? 'Published-head checks'
                          : 'Pull request discussion'}
                    </strong>
                    <p>
                      Detailed {tab} data is unavailable in this snapshot. No checkout or mutation
                      was performed.
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <>
                {selected.notice ? (
                  <div className={`bw-notice bw-notice-${selected.notice.tone}`}>
                    <Eye />
                    <div>
                      <strong>{selected.notice.title}</strong>
                      <p>{selected.notice.body}</p>
                    </div>
                  </div>
                ) : null}
                <section className="bw-section">
                  <div className="bw-between">
                    <h3>Working directory</h3>
                    {worktree ? (
                      <IconButton
                        label="Copy full worktree path"
                        variant="ghost"
                        onClick={() => void copyPath()}
                      >
                        <Copy />
                      </IconButton>
                    ) : null}
                  </div>
                  {worktreeId && !worktree ? (
                    <p role="status">
                      The selected directory is no longer associated with this qualified branch.
                      Choose another directory explicitly.
                    </p>
                  ) : null}
                  {selected.worktrees.length > 0 &&
                  (selected.worktrees.length > 1 ||
                    selected.worktreesKnown !== true ||
                    (worktreeId && !worktree)) ? (
                    <Select
                      value={worktree?.id ?? ''}
                      aria-label="Worktree to inspect"
                      onValueChange={(value) => {
                        setWorktreeId(String(value))
                        onWorktreeChange?.(String(value))
                      }}
                      options={[
                        { value: '', label: 'Choose the local directory', disabled: true },
                        ...worktreeChoices.map((tree) => ({
                          value: tree.id,
                          label: tree.path,
                        })),
                      ]}
                    />
                  ) : null}
                  {worktreePages > 1 ? (
                    <div className="bw-between">
                      <Button
                        size="xs"
                        disabled={!currentWorktreePage}
                        onClick={() => setWorktreePage(currentWorktreePage - 1)}
                      >
                        Previous directories
                      </Button>
                      <span>
                        Directory choices {currentWorktreePage + 1} / {worktreePages}
                      </span>
                      <Button
                        size="xs"
                        disabled={currentWorktreePage + 1 >= worktreePages}
                        onClick={() => setWorktreePage(currentWorktreePage + 1)}
                      >
                        Next directories
                      </Button>
                    </div>
                  ) : null}
                  <div className="bw-directory">
                    <div className="bw-between">
                      <span>
                        <Folder />
                        {worktree?.name ??
                          (selected.worktreesKnown === false
                            ? 'Directory association unknown'
                            : 'Not checked out')}
                      </span>
                      <Badge variant="secondary">{worktree?.status.label ?? 'No worktree'}</Badge>
                    </div>
                    <code>
                      {worktree?.displayPath ?? worktree?.path ?? 'Inspect without checkout'}
                    </code>
                  </div>
                  <div className="bw-facts">
                    <div>
                      <strong>{selected.commits ?? 'Unknown'}</strong>
                      <small>branch commits</small>
                    </div>
                    <div>
                      <strong>{worktree ? (worktree.changedFiles ?? 'Unknown') : '—'}</strong>
                      <small>uncommitted files</small>
                    </div>
                    <div>
                      <strong>{selected.unpushed ?? 'Unknown'}</strong>
                      <small>unpushed commits</small>
                    </div>
                  </div>
                </section>
                {detailPanels?.overview}
                {selected.pullRequest ? (
                  <section className="bw-section">
                    <div className="bw-between">
                      <h3>Pull request status</h3>
                    </div>
                    <div className="bw-readiness">
                      <span>
                        <CheckCircle2 />
                        Checks
                      </span>
                      <Fact fact={selected.pullRequest.checks} />
                    </div>
                    <div className="bw-readiness">
                      <span>
                        <Eye />
                        GitHub review
                      </span>
                      <Fact fact={selected.pullRequest.review} />
                    </div>
                    <div className="bw-readiness">
                      <span>
                        <GitBranch />
                        Published head
                      </span>
                      <code>{selected.pullRequest.publishedHead ?? 'Unknown'}</code>
                    </div>
                  </section>
                ) : null}
                <section className="bw-section">
                  <div className="bw-between">
                    <h3>Branch relationships</h3>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        const index = allEntries.findIndex(
                          (entry) => entry.branch.id === selected.id,
                        )
                        if (index >= 0) {
                          setPage(Math.floor(index / LIST_PAGE_SIZE))
                          setChecked(new Set())
                        }
                        document
                          .getElementById(`branch-${selected.id}`)
                          ?.scrollIntoView({ block: 'nearest' })
                      }}
                    >
                      Locate in lanes
                      <ArrowUpRight />
                    </Button>
                  </div>
                  {selectedChildren
                    .slice(
                      relationshipPage * LIST_PAGE_SIZE,
                      (relationshipPage + 1) * LIST_PAGE_SIZE,
                    )
                    .map(({ branch }) => (
                      <Button
                        key={branch.id}
                        variant="unstyled"
                        className="bw-relationship bw-child"
                        onClick={() => inspect(branch.id)}
                      >
                        <GitBranch />
                        <code>{branch.ref}</code>
                        <small>
                          {branch.pullRequest
                            ? `#${branch.pullRequest.number}`
                            : branch.pullRequest === null
                              ? 'ref'
                              : 'PR unknown'}
                        </small>
                      </Button>
                    ))}
                  {selectedChildren.length > LIST_PAGE_SIZE ? (
                    <div className="bw-between">
                      <Button
                        size="xs"
                        disabled={!relationshipPage}
                        onClick={() => setRelationshipPage(relationshipPage - 1)}
                      >
                        Previous descendants
                      </Button>
                      <span>{selectedChildren.length} actual immediate children</span>
                      <Button
                        size="xs"
                        disabled={
                          (relationshipPage + 1) * LIST_PAGE_SIZE >= selectedChildren.length
                        }
                        onClick={() => setRelationshipPage(relationshipPage + 1)}
                      >
                        Next descendants
                      </Button>
                    </div>
                  ) : null}
                  <Button
                    variant="unstyled"
                    className="bw-relationship bw-selected"
                    onClick={() => inspect(selected.id)}
                  >
                    <GitBranch />
                    <code>{selected.ref}</code>
                    <small>
                      {selected.pullRequest
                        ? `#${selected.pullRequest.number}`
                        : selected.pullRequest === null
                          ? 'ref'
                          : 'PR unknown'}
                    </small>
                  </Button>
                  {branches
                    .filter((branch) => branch.id === selectedLane?.parentId)
                    .map((branch) => (
                      <Button
                        key={branch.id}
                        variant="unstyled"
                        className="bw-relationship"
                        onClick={() => inspect(branch.id)}
                      >
                        <GitBranch />
                        <code>{branch.ref}</code>
                        <small>base</small>
                      </Button>
                    ))}
                  {selectedLane?.issue ? <p className="bw-warning">{selectedLane.issue}</p> : null}
                </section>
              </>
            )}
          </TabsContent>
        </WorkbenchPane>
      </Tabs>
    ) : null
  return (
    <div
      className="bw-app"
      data-density={displayDensity}
      data-lane-projection-layout-ms={layout.elapsed}
    >
      <header className="bw-topbar">
        <div className="bw-brand">
          <span>
            <Layers />
          </span>
          Git Stacks
        </div>
        {action(
          'search',
          <>
            <Search />
            Jump to a repository, worktree, or PR…
          </>,
          { repositoryId },
          'ghost',
        )}
        <div className="bw-top-right">
          {topUtilities}
          {action(
            'settings',
            <>
              <Settings2 />
              <span className="sr-only">Settings</span>
            </>,
            { repositoryId },
            'ghost',
          )}
        </div>
      </header>
      <div className={`bw-shell ${inspector ? '' : 'bw-no-inspector'}`}>
        <aside className="bw-sidebar" aria-label="Workspace navigation">
          <div className="bw-workspace-name">
            <strong>Personal workspace</strong>
            <small>One developer. Many worktrees.</small>
          </div>
          <nav>
            <div className="bw-nav-heading">Your workspace</div>
            {action(
              'attention',
              <>
                <Inbox />
                Needs attention<span className="bw-count">{countAttention ?? 'Unknown'}</span>
              </>,
              { repositoryId },
              'ghost',
            )}
            {action(
              'activity',
              <>
                <History />
                Activity
              </>,
              { repositoryId },
              'ghost',
            )}
            <div className="bw-nav-heading">
              Repository<span>{repository?.mark}</span>
            </div>
            <Button
              variant="unstyled"
              className={`bw-nav ${surface === 'branches' ? 'bw-selected' : ''}`}
              aria-current={surface === 'branches' ? 'page' : undefined}
              onClick={() => onAction('branches', { repositoryId })}
            >
              <GitBranch />
              Branches<span>{repository?.branchCount ?? 'Unknown'}</span>
            </Button>
            {action(
              'pull-requests',
              <>
                <GitPullRequest />
                Pull requests
                <span className="bw-count">{repository?.pullRequestCount ?? 'Unknown'}</span>
              </>,
              { repositoryId },
              'ghost',
            )}
            <div className="bw-nav-heading">Pinned repositories</div>
            {snapshot.repositories
              .slice(
                currentRepositoryPage * LIST_PAGE_SIZE,
                (currentRepositoryPage + 1) * LIST_PAGE_SIZE,
              )
              .map((repo) => (
                <Button
                  key={repo.id}
                  variant="unstyled"
                  className={`bw-repo ${repo.id === repositoryId ? 'bw-repo-active' : ''}`}
                  aria-pressed={repo.id === repositoryId}
                  aria-label={`${repo.owner}/${repo.name}${repo.path ? ` · ${repo.path}` : ''}`}
                  title={repo.path}
                  onClick={() => switchRepository(repo.id)}
                >
                  <span className="bw-repo-mark">{repo.mark}</span>
                  <span>
                    <strong>{repo.name}</strong>
                    <small>{repo.worktreeCount ?? 'Unknown'} worktrees</small>
                  </span>
                  {repo.attentionCount !== 0 ? (
                    <span className="bw-warning bw-count">
                      {repo.attentionCount ?? 'Unknown'} ·
                    </span>
                  ) : null}
                </Button>
              ))}
            {repositoryPages > 1 ? (
              <div>
                <Button
                  size="xs"
                  disabled={!currentRepositoryPage}
                  onClick={() => setRepositoryPage(currentRepositoryPage - 1)}
                >
                  Previous repositories
                </Button>
                <span>
                  {currentRepositoryPage + 1} / {repositoryPages}
                </span>
                <Button
                  size="xs"
                  disabled={currentRepositoryPage + 1 >= repositoryPages}
                  onClick={() => setRepositoryPage(currentRepositoryPage + 1)}
                >
                  Next repositories
                </Button>
              </div>
            ) : null}
          </nav>
          <div className="bw-sidebar-bottom">
            <div className="bw-shipping">
              <GitMerge />
              <div>
                <strong>{countReady ?? 'Unknown'} ready to merge</strong>
                <small>Across all repositories</small>
              </div>
            </div>
            <small>Git / GitHub workbench</small>
            {sidebarUtilities}
          </div>
        </aside>
        {mainPanel}
        {(!mainPanel || surface === 'branches') && (
          <WorkbenchPane
            className="bw-main"
            role="main"
            aria-label="Branch workbench"
            header={
              <>
                <div className="bw-panel-head">
                  <div className="bw-breadcrumb">
                    <Folder />
                    {repository?.owner} / {repository?.name}
                  </div>
                  <div className="bw-between">
                    <h1>Branches &amp; worktrees</h1>
                    <div className="bw-actions">
                      {action(
                        'discover',
                        <>
                          <Search />
                          Discover worktrees
                        </>,
                        { repositoryId },
                        'default',
                      )}
                    </div>
                  </div>
                  <p>One row per branch. Worktree context and dependencies, together.</p>
                </div>
                <SegmentedControl
                  label="Branch status filter"
                  className="bw-filters"
                  value={filter}
                  onValueChange={(value) => {
                    setFilter(value)
                    setChecked(new Set())
                  }}
                  options={filters.map((label) => ({
                    value: label,
                    label: (
                      <>
                        {label}
                        <span>
                          {(label === 'All branches'
                            ? repository?.branchCount
                            : label === 'Needs you'
                              ? repository?.attentionCount
                              : label === 'Unpublished'
                                ? repository?.unpublishedCount
                                : repository?.readyBranchCount === undefined
                                  ? repository?.readyToMergeCount
                                  : repository.readyBranchCount) ?? 'Unknown'}
                        </span>
                      </>
                    ),
                  }))}
                />
                <div className="bw-toolbar">
                  <div className="bw-search">
                    <Search />
                    <Input
                      aria-label="Filter branches by branch, PR, or path"
                      placeholder="Filter by branch, PR, or path…"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value)
                        setChecked(new Set())
                      }}
                    />
                  </div>
                  <Select
                    aria-label="Worktree availability"
                    controlSize="compact"
                    value={scope}
                    onValueChange={(value) => {
                      setScope(String(value))
                      setChecked(new Set())
                    }}
                    options={[
                      { value: 'all', label: 'Any worktree' },
                      { value: 'with', label: 'Has worktree' },
                      { value: 'without', label: 'No worktree' },
                    ]}
                  />
                  <Select
                    aria-label="Display density"
                    controlSize="compact"
                    value={displayDensity}
                    onValueChange={(value) =>
                      setDisplayDensity(value as WorkbenchViewState['density'])
                    }
                    options={[
                      { value: 'compact', label: 'Compact display' },
                      { value: 'standard', label: 'Standard display' },
                    ]}
                  />
                  <Select
                    aria-label="Ref source"
                    controlSize="compact"
                    value={refScope}
                    onValueChange={(value) => setRefScope(value as WorkbenchViewState['refScope'])}
                    options={[
                      { value: 'all', label: 'Local and remote' },
                      { value: 'local', label: 'Local refs' },
                      { value: 'remote', label: 'Remote refs' },
                    ]}
                  />
                  {filtering ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setQuery('')
                        setScope('all')
                        setFilter(filters[0])
                        setRefScope('all')
                        setChecked(new Set())
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : null}
                  {!inspectorOpen ? (
                    <Button size="sm" variant="ghost" onClick={() => setInspectorOpen(true)}>
                      Inspector
                    </Button>
                  ) : null}
                </div>
                {snapshot.notice ? (
                  <p role="status" className="bw-data-notice">
                    {snapshot.notice}
                  </p>
                ) : null}
                {checked.size ? (
                  <div className="bw-bulk" role="status">
                    {checked.size} selected on this page only · filters, folds and pages clear
                    selection
                    <Button size="xs" variant="ghost" onClick={() => setChecked(new Set())}>
                      Clear selection
                    </Button>
                  </div>
                ) : null}
              </>
            }
            footer={
              <div className="bw-panel-bottom">
                <span>
                  {matching.length} matches · {allEntries.length - matching.length} context ·{' '}
                  {allEntries.length - entries.length} unmounted
                </span>
                <span>Selection changes inspection, never checkout</span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={currentPage === 0}
                  onClick={() => {
                    setPage(currentPage - 1)
                    setChecked(new Set())
                  }}
                >
                  Previous page
                </Button>
                <span>
                  Page {currentPage + 1} / {pageCount}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={currentPage + 1 >= pageCount}
                  onClick={() => {
                    setPage(currentPage + 1)
                    setChecked(new Set())
                  }}
                >
                  Next page
                </Button>
              </div>
            }
          >
            <div
              ref={scroll}
              className="bw-main-scroll"
              onScroll={(event) => persistView(event.currentTarget.scrollTop)}
            >
              {selectedBranchId && !branches.some((branch) => branch.id === selectedBranchId) ? (
                <p role="status">
                  The selected qualified object is unavailable in the current observed scope. Choose
                  another object explicitly; no similarly named object is substituted.
                </p>
              ) : null}
              {omittedEdges ? (
                <p role="status">
                  {omittedEdges} parent connections continue on another page; no complete edge is
                  drawn.
                </p>
              ) : null}
              <div className="bw-lane-guide">
                <GitBranch />
                <span>Branches ↑ · base ↓</span>
                <span>Relationships, not a commit timeline</span>
              </div>
              <div
                className="bw-lane-group"
                style={
                  {
                    '--bw-max-lane': Math.max(2, ...topology.map((entry) => entry.lane)),
                  } as CSSProperties
                }
              >
                <div className="bw-grid bw-labels">
                  <Checkbox
                    aria-label="Select visible matching branches; excludes trunk and context"
                    checked={selectable.length > 0 && selectable.every((id) => checked.has(id))}
                    indeterminate={
                      selectable.some((id) => checked.has(id)) &&
                      !selectable.every((id) => checked.has(id))
                    }
                    disabled={!selectable.length}
                    onCheckedChange={(value) => setChecked(value ? new Set(selectable) : new Set())}
                  />
                  <span>Lanes</span>
                  <span>Branch / pull request</span>
                  <span className="bw-worktree-column">Working directory</span>
                  <span>PR status</span>
                  <span />
                </div>
                <div className="bw-lane-body">
                  <RelationshipLines
                    entries={entries}
                    related={related}
                    selectedId={selectedBranchId}
                  />
                  {entries.map((entry) => {
                    const branch = entry.branch
                    const tree = branch.worktrees[0]
                    const isContext = !matchIds.has(branch.id)
                    const children = childCounts.get(branch.id) ?? 0
                    return (
                      <div
                        key={branch.id}
                        id={`branch-${branch.id}`}
                        data-branch-id={branch.id}
                        data-lane={entry.lane}
                        className={`bw-grid bw-lane-row ${branch.trunk ? 'bw-trunk' : ''} ${selectedBranchId === branch.id ? 'bw-selected' : ''} ${isContext ? 'bw-context' : ''}`}
                        role="group"
                        aria-label={`${branch.ref}. ${entry.parentId ? `Parent: ${byId.get(entry.parentId)?.branch.ref}.` : (entry.issue ?? 'No recorded parent.')} ${isContext ? 'Context: does not match current filter.' : ''} ${tree?.status.label ?? 'No worktree'}. ${branch.pullRequest?.review.label ?? (branch.pullRequest === null ? 'No pull request' : 'PR association unknown')}. ${branch.pullRequest?.checks.label ?? ''}`}
                        onKeyDown={(event) => {
                          if (
                            event.defaultPrevented ||
                            event.altKey ||
                            event.ctrlKey ||
                            event.metaKey ||
                            event.shiftKey ||
                            event.nativeEvent.isComposing
                          )
                            return
                          const identityControl =
                            event.target instanceof HTMLElement &&
                            event.target.closest('.bw-branch-name, .bw-subtitle')
                          if (event.target !== event.currentTarget && !identityControl) return
                          if (event.key === 'Home' || event.key === 'End') {
                            event.preventDefault()
                            const index = event.key === 'Home' ? 0 : allEntries.length - 1
                            const id = allEntries[index].branch.id
                            setFocusedBranchId(id)
                            if (Math.floor(index / LIST_PAGE_SIZE) !== currentPage) {
                              pendingRowFocus.current = id
                              setPage(Math.floor(index / LIST_PAGE_SIZE))
                            } else document.getElementById(`branch-${id}`)?.focus()
                            return
                          }
                          const index = entries.indexOf(entry)
                          const next =
                            event.key === 'ArrowDown'
                              ? Math.min(index + 1, entries.length - 1)
                              : event.key === 'ArrowUp'
                                ? Math.max(index - 1, 0)
                                : null
                          if (next !== null) {
                            event.preventDefault()
                            setFocusedBranchId(entries[next].branch.id)
                            document.getElementById(`branch-${entries[next].branch.id}`)?.focus()
                          } else if (
                            event.target === event.currentTarget &&
                            (event.key === 'Enter' || event.key === ' ')
                          ) {
                            event.preventDefault()
                            inspect(branch.id)
                          }
                        }}
                        onFocus={() => setFocusedBranchId(branch.id)}
                        tabIndex={focusId === branch.id ? 0 : -1}
                      >
                        <Checkbox
                          aria-label={`Select branch for bulk action: ${branch.ref}`}
                          disabled={!selectable.includes(branch.id)}
                          checked={checked.has(branch.id)}
                          onCheckedChange={(value) =>
                            setChecked((previous) => {
                              const next = new Set(previous)
                              if (value) next.add(branch.id)
                              else next.delete(branch.id)
                              return next
                            })
                          }
                        />
                        <span className="bw-track" />
                        <div className="bw-identity">
                          <div className="bw-between">
                            <Button
                              variant="unstyled"
                              className="bw-branch-name"
                              aria-pressed={selectedBranchId === branch.id}
                              title={branch.ref}
                              onClick={() => inspect(branch.id)}
                            >
                              {branch.ref}
                            </Button>
                            {branch.trunk ? (
                              <span className="bw-tag">Trunk</span>
                            ) : isContext ? (
                              <span className="bw-tag">Context</span>
                            ) : children && !filtering ? (
                              <Button
                                variant="unstyled"
                                className="bw-fold"
                                aria-expanded={!folded.has(branch.id)}
                                aria-label={`${folded.has(branch.id) ? 'Expand' : 'Collapse'} descendants of ${branch.ref}`}
                                onClick={() => toggleFold(branch.id)}
                              >
                                <ArrowUp />
                                {descendants.get(branch.id) ?? 0}
                              </Button>
                            ) : null}
                          </div>
                          {entry.parentId && !pageIds.has(entry.parentId) ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => inspect(entry.parentId!)}
                            >
                              Parent continues outside this page
                            </Button>
                          ) : null}
                          {(childCounts.get(branch.id) ?? 0) >
                          (mountedChildren.get(branch.id) ?? 0) ? (
                            <small>
                              {(childCounts.get(branch.id) ?? 0) -
                                (mountedChildren.get(branch.id) ?? 0)}{' '}
                              child connections continue outside this page
                            </small>
                          ) : null}
                          <Button
                            variant="unstyled"
                            className="bw-subtitle"
                            onClick={() => inspect(branch.id)}
                          >
                            {branch.pullRequest ? (
                              <span
                                className={`bw-pr bw-${branch.pullRequest.lifecycle.tone ?? 'neutral'}`}
                              >
                                <GitPullRequest />#{branch.pullRequest.number}
                                <span>·</span>
                              </span>
                            ) : null}
                            {branch.needsRestack ? (
                              <span className="bw-warning">Restack ·</span>
                            ) : null}
                            {branch.conflicted ? (
                              <span className="bw-warning">Conflict ·</span>
                            ) : null}
                            <span>{branch.trunk ? 'Default branch' : branch.title}</span>
                          </Button>
                          <div className="bw-inline-directory">
                            <Folder />
                            {branch.worktrees.length > 1
                              ? `${branch.worktrees.length} associated directories`
                              : (tree?.name ??
                                (branch.worktreesKnown === false
                                  ? 'Directories unknown'
                                  : 'No worktree'))}{' '}
                            ·{' '}
                            {branch.worktrees.length > 1
                              ? 'Choose exact directory in inspector'
                              : (tree?.status.label ?? 'Inspect without checkout')}
                            {branch.unpushed ? (
                              <span className="bw-info">↑ {branch.unpushed}</span>
                            ) : null}
                          </div>
                          {entry.issue || branch.parentIssue ? (
                            <small className="bw-warning">
                              {entry.issue ?? branch.parentIssue} · no edge shown
                            </small>
                          ) : null}
                        </div>
                        <div className="bw-worktree-column bw-local">
                          <span>
                            <Folder />
                            {branch.worktrees.length > 1
                              ? `${branch.worktrees.length} directories`
                              : (tree?.name ??
                                (branch.worktreesKnown === false
                                  ? 'Directories unknown'
                                  : 'No worktree'))}
                          </span>
                          <div>
                            <span className={tree?.status.tone === 'warning' ? 'bw-warning' : ''}>
                              {branch.worktrees.length > 1
                                ? 'Choose exact directory'
                                : (tree?.status.label ?? 'Inspect without checkout')}
                            </span>
                            {tree || branch.unpushed !== 0 ? (
                              <span className={branch.unpushed ? 'bw-info' : ''}>
                                {branch.trunk
                                  ? ''
                                  : branch.unpushed === null
                                    ? 'Unpushed unknown'
                                    : branch.unpushed
                                      ? `↑ ${branch.unpushed} unpushed`
                                      : branch.local.label}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="bw-pr-status">
                          {branch.pullRequest ? (
                            <>
                              <Fact
                                fact={
                                  branch.pullRequest.state === 'merged'
                                    ? branch.pullRequest.lifecycle
                                    : branch.pullRequest.review
                                }
                              />
                              <Fact fact={branch.pullRequest.checks} />
                            </>
                          ) : (
                            <>
                              <span>
                                <GitBranch />
                                {branch.trunk
                                  ? 'Default branch'
                                  : branch.pullRequest === null
                                    ? 'No pull request'
                                    : 'PR association unknown'}
                              </span>
                              <small>
                                {branch.trunk
                                  ? ''
                                  : branch.unpushed
                                    ? 'Unpublished commits'
                                    : branch.local.label}
                              </small>
                            </>
                          )}
                        </div>
                        <BranchActions
                          context={{
                            repositoryId,
                            branchId: branch.id,
                            worktreeId: branch.worktrees.length === 1 ? tree?.id : undefined,
                            pullRequestId: branch.pullRequest?.id,
                          }}
                          capabilities={capabilities}
                          onAction={onAction}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
              {!entries.length ? (
                <div className="bw-empty">
                  <Search />
                  <h2>No matching branches</h2>
                  <p>Try another branch, PR, path, or worktree filter.</p>
                </div>
              ) : null}
            </div>
          </WorkbenchPane>
        )}
        {narrow ? (
          <Sheet open={Boolean(inspector)} onOpenChange={setInspectorOpen}>
            <SheetContent
              className="bw-inspector-sheet"
              showCloseButton={false}
              aria-describedby={undefined}
            >
              <SheetTitle className="sr-only">Selected branch details</SheetTitle>
              {inspector}
            </SheetContent>
          </Sheet>
        ) : (
          inspector
        )}
      </div>
      <footer className="bw-statusbar">
        <span>
          <ShieldCheck />
          {snapshot.localFreshness}
        </span>
        <span>{snapshot.remoteFreshness}</span>
        <span>Selection changes focus, never checkout</span>
      </footer>
    </div>
  )
}
