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
  projectBranchLanes,
  type BranchWorkbenchSnapshot,
  type LaneEntry,
  type WorkbenchAction,
  type WorkbenchActionContext,
  type WorkbenchCapabilities,
  type WorkbenchFact,
} from './branch-workbench-model'
import './branch-workbench.css'

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
  detailPanels?: Partial<Record<'changes' | 'checks' | 'discussion', React.ReactNode>>
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
  selectedId,
}: {
  entries: LaneEntry[]
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
  const related = new Set<string>()
  let current = entries.find((entry) => entry.branch.id === selectedId)
  while (current && !related.has(current.branch.id)) {
    related.add(current.branch.id)
    current = entries.find((entry) => entry.branch.id === current?.parentId)
  }
  for (const entry of entries) {
    let parent = entries.find((candidate) => candidate.branch.id === entry.parentId)
    while (parent) {
      if (parent.branch.id === selectedId) {
        related.add(entry.branch.id)
        break
      }
      parent = entries.find((candidate) => candidate.branch.id === parent?.parentId)
    }
  }
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
}: BranchWorkbenchProps) {
  const repository = snapshot.repositories.find((repo) => repo.id === repositoryId)
  const branches = useMemo(
    () => snapshot.branches.filter((branch) => branch.repositoryId === repositoryId),
    [snapshot.branches, repositoryId],
  )
  const topology = useMemo(() => projectBranchLanes(branches), [branches])
  const descendants = useMemo(() => {
    const counts: Record<string, number> = {}
    const byId = new Map(topology.map((entry) => [entry.branch.id, entry]))
    for (const entry of topology) {
      let parent = entry.parentId ? byId.get(entry.parentId) : undefined
      while (parent) {
        counts[parent.branch.id] = (counts[parent.branch.id] ?? 0) + 1
        parent = parent.parentId ? byId.get(parent.parentId) : undefined
      }
    }
    return counts
  }, [topology])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string>(filters[0])
  const [scope, setScope] = useState('all')
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [focusedBranchId, setFocusedBranchId] = useState<string | null>(selectedBranchId)
  const [tab, setTab] = useState('overview')
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1040)
  const [worktreeId, setWorktreeId] = useState<string | null>(null)
  const [copyResult, setCopyResult] = useState('')
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1039px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1039px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const scroll = useRef<HTMLDivElement>(null)
  const foldAnchor = useRef<{ id: string; top: number } | null>(null)
  useLayoutEffect(() => {
    const anchor = foldAnchor.current
    foldAnchor.current = null
    if (!anchor || !scroll.current) return
    const row = document.getElementById(`branch-${anchor.id}`)
    if (row) scroll.current.scrollTop += row.getBoundingClientRect().top - anchor.top
  }, [folded])
  const memory = useRef<
    Record<
      string,
      { query: string; filter: string; scope: string; folded: Set<string>; scroll: number }
    >
  >({})
  const oldRepository = useRef(repositoryId)
  useEffect(() => {
    if (oldRepository.current === repositoryId) return
    const saved = memory.current[repositoryId]
    setQuery(saved?.query ?? '')
    setFilter(saved?.filter ?? filters[0])
    setScope(saved?.scope ?? 'all')
    setFolded(saved?.folded ?? new Set())
    setChecked(new Set())
    setTab('overview')
    if (scroll.current) scroll.current.scrollTop = saved?.scroll ?? 0
    setCopyResult('')
    setWorktreeId(null)
    oldRepository.current = repositoryId
  }, [repositoryId])
  const selected = branches.find((branch) => branch.id === selectedBranchId)
  const selectedLane = topology.find((entry) => entry.branch.id === selectedBranchId)
  const worktree =
    selected?.worktrees.find((tree) => tree.id === worktreeId) ?? selected?.worktrees[0]
  const context: WorkbenchActionContext = {
    repositoryId,
    branchId: selected?.id,
    worktreeId: worktree?.id,
    pullRequestId: selected?.pullRequest?.id,
  }
  const filtering = Boolean(query) || filter !== filters[0] || scope !== 'all'
  const matching = topology.filter(({ branch, parentId }) => {
    if (scope === 'with' && !branch.worktrees.length) return false
    if (scope === 'without' && branch.worktrees.length) return false
    if (filter === 'Needs you' && !branch.attention) return false
    if (filter === 'Unpublished' && !(branch.unpushed && branch.unpushed > 0)) return false
    if (filter === 'Ready to merge' && branch.readyToMerge !== true) return false
    if (
      query &&
      !`${branch.ref} ${branch.title} ${branch.pullRequest?.number ?? ''} ${branch.worktrees.map((tree) => tree.path).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
      return false
    let parent = topology.find((entry) => entry.branch.id === parentId)
    while (!filtering && parent) {
      if (folded.has(parent.branch.id)) return false
      parent = topology.find((entry) => entry.branch.id === parent?.parentId)
    }
    return true
  })
  const matchIds = new Set(matching.map(({ branch }) => branch.id))
  const included = new Set(matchIds)
  for (const entry of matching) {
    let parent = topology.find((candidate) => candidate.branch.id === entry.parentId)
    while (parent && !included.has(parent.branch.id)) {
      included.add(parent.branch.id)
      parent = topology.find((candidate) => candidate.branch.id === parent?.parentId)
    }
  }
  const entries = topology.filter((entry) => included.has(entry.branch.id))
  const focusId = entries.some((entry) => entry.branch.id === focusedBranchId)
    ? focusedBranchId
    : entries.some((entry) => entry.branch.id === selectedBranchId)
      ? selectedBranchId
      : entries[0]?.branch.id
  const selectable = matching.filter(({ branch }) => !branch.trunk).map(({ branch }) => branch.id)
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
    setWorktreeId(null)
    setCopyResult('')
    setTab('overview')
    setInspectorOpen(true)
  }
  function switchRepository(id: string) {
    memory.current[repositoryId] = {
      query,
      filter,
      scope,
      folded,
      scroll: scroll.current?.scrollTop ?? 0,
    }
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
    try {
      await navigator.clipboard.writeText(worktree.path)
      setCopyResult('Path copied.')
    } catch {
      setCopyResult(`Clipboard unavailable. Copy the full path: ${worktree.path}`)
    }
  }
  const inspector =
    selected && inspectorOpen ? (
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        style={{ display: 'contents' }}
      >
        <WorkbenchPane
          className="bw-inspector"
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
                selected.pullRequest ? 'review' : selected.trunk ? 'history' : 'publish',
                <>
                  <Eye />
                  {selected.pullRequest
                    ? 'Review pull request'
                    : selected.trunk
                      ? 'Inspect branch history'
                      : 'Publish pull request…'}
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
                <BranchActions context={context} capabilities={capabilities} onAction={onAction} />
              </div>
              <small>
                {worktree
                  ? 'Review here. Develop in your editor.'
                  : 'Review without creating a worktree'}
              </small>
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
                  {selected.worktrees.length > 1 ? (
                    <Select
                      aria-label="Worktree to inspect"
                      value={worktree?.id ?? ''}
                      onValueChange={(value) => setWorktreeId(String(value))}
                      options={selected.worktrees.map((tree) => ({
                        value: tree.id,
                        label: tree.path,
                      }))}
                    />
                  ) : null}
                  <div className="bw-directory">
                    <div className="bw-between">
                      <span>
                        <Folder />
                        {worktree?.name ?? 'Not checked out'}
                      </span>
                      <Badge variant="secondary">{worktree?.status.label ?? 'No worktree'}</Badge>
                    </div>
                    <code>
                      {worktree?.displayPath ?? worktree?.path ?? 'Inspect without checkout'}
                    </code>
                  </div>
                  {copyResult ? <p role="status">{copyResult}</p> : null}
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
                {selected.pullRequest ? (
                  <section className="bw-section">
                    <div className="bw-between">
                      <h3>Pull request status</h3>
                      {action(
                        'merge',
                        <>
                          Preview merge
                          <ArrowUpRight />
                        </>,
                        context,
                        'ghost',
                      )}
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
                      onClick={() =>
                        document
                          .getElementById(`branch-${selected.id}`)
                          ?.scrollIntoView({ block: 'nearest' })
                      }
                    >
                      Locate in lanes
                      <ArrowUpRight />
                    </Button>
                  </div>
                  {topology
                    .filter((entry) => entry.parentId === selected.id)
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
    <div className="bw-app" data-density={density}>
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
            <div className="bw-nav bw-selected" aria-current="page">
              <GitBranch />
              Branches<span>{repository?.branchCount ?? 'Unknown'}</span>
            </div>
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
            {snapshot.repositories.map((repo) => (
              <Button
                key={repo.id}
                variant="unstyled"
                className={`bw-repo ${repo.id === repositoryId ? 'bw-repo-active' : ''}`}
                aria-pressed={repo.id === repositoryId}
                aria-label={`${repo.owner}/${repo.name}`}
                onClick={() => switchRepository(repo.id)}
              >
                <span className="bw-repo-mark">{repo.mark}</span>
                <span>
                  <strong>{repo.name}</strong>
                  <small>{repo.worktreeCount ?? 'Unknown'} worktrees</small>
                </span>
                {repo.attentionCount !== 0 ? (
                  <span className="bw-warning bw-count">{repo.attentionCount ?? 'Unknown'} ·</span>
                ) : null}
              </Button>
            ))}
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
          </div>
        </aside>
        <WorkbenchPane
          className="bw-main"
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
                              : repository?.readyToMergeCount) ?? 'Unknown'}
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
                {action(
                  'settings',
                  <>
                    <Settings2 />
                    Display
                  </>,
                  { repositoryId },
                  'ghost',
                )}
                {filtering ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setQuery('')
                      setScope('all')
                      setFilter(filters[0])
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
                  {checked.size} selected · no operation dispatched
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
                {matching.length} branches
                {entries.length > matching.length
                  ? ` + ${entries.length - matching.length} context`
                  : ''}
              </span>
              <span>Selection changes inspection, never checkout</span>
            </div>
          }
        >
          <div ref={scroll} className="bw-main-scroll">
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
                <RelationshipLines entries={entries} selectedId={selectedBranchId} />
                {entries.map((entry) => {
                  const branch = entry.branch
                  const tree = branch.worktrees[0]
                  const isContext = !matchIds.has(branch.id)
                  const children = topology.filter((candidate) => candidate.parentId === branch.id)
                  return (
                    <div
                      key={branch.id}
                      id={`branch-${branch.id}`}
                      data-branch-id={branch.id}
                      data-lane={entry.lane}
                      className={`bw-grid bw-lane-row ${branch.trunk ? 'bw-trunk' : ''} ${selectedBranchId === branch.id ? 'bw-selected' : ''} ${isContext ? 'bw-context' : ''}`}
                      role="group"
                      aria-label={`${branch.ref}. ${entry.parentId ? `Parent: ${branches.find((parent) => parent.id === entry.parentId)?.ref}.` : (entry.issue ?? 'No recorded parent.')} ${isContext ? 'Ancestor context.' : ''} ${tree?.status.label ?? 'No worktree'}. ${branch.pullRequest?.review.label ?? (branch.pullRequest === null ? 'No pull request' : 'PR association unknown')}. ${branch.pullRequest?.checks.label ?? ''}`}
                      onKeyDown={(event) => {
                        if (event.defaultPrevented) return
                        const identityControl =
                          event.target instanceof HTMLElement &&
                          event.target.closest('.bw-branch-name, .bw-subtitle')
                        if (event.target !== event.currentTarget && !identityControl) return
                        const index = entries.indexOf(entry)
                        const next =
                          event.key === 'ArrowDown'
                            ? Math.min(index + 1, entries.length - 1)
                            : event.key === 'ArrowUp'
                              ? Math.max(index - 1, 0)
                              : event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? entries.length - 1
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
                        disabled={branch.trunk || isContext}
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
                          ) : children.length && !filtering ? (
                            <Button
                              variant="unstyled"
                              className="bw-fold"
                              aria-expanded={!folded.has(branch.id)}
                              aria-label={`${folded.has(branch.id) ? 'Expand' : 'Collapse'} descendants of ${branch.ref}`}
                              onClick={() => toggleFold(branch.id)}
                            >
                              <ArrowUp />
                              {descendants[branch.id] ?? 0}
                            </Button>
                          ) : null}
                        </div>
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
                          {tree?.name ?? 'No worktree'} ·{' '}
                          {tree?.status.label ?? 'Inspect without checkout'}
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
                          {tree?.name ?? 'No worktree'}
                        </span>
                        <div>
                          <span className={tree?.status.tone === 'warning' ? 'bw-warning' : ''}>
                            {tree?.status.label ?? 'Inspect without checkout'}
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
                <h3>No matching branches</h3>
                <p>Try another branch, PR, path, or worktree filter.</p>
              </div>
            ) : null}
          </div>
        </WorkbenchPane>
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
