export type WorkbenchTone = 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'merged'

export interface WorkbenchFact {
  label: string
  tone?: WorkbenchTone
  icon?: 'circle' | 'check' | 'review' | 'comment' | 'error' | 'clock' | 'merge'
}

export interface WorkbenchRepository {
  id: string
  name: string
  path?: string
  owner: string
  mark: string
  /** Main-owned complete totals; null means unavailable/partial, not zero. */
  branchCount: number | null
  pullRequestCount: number | null
  unpublishedCount: number | null
  readyToMergeCount: number | null
  readyBranchCount?: number | null
  worktreeCount: number | null
  attentionCount: number | null
}

export interface WorkbenchBranch {
  /** Qualified main-owned identity, never the display name. */
  id: string
  repositoryId: string
  ref: string
  title: string
  parentId: string | null
  parentIssue?: string
  recordedParent?: string | null
  worktreesKnown?: boolean
  trunk: boolean
  refKind?: 'local' | 'remote'
  /** Read affordance only; never authority to execute a Git mutation. */
  bulkEligible?: boolean
  worktrees: readonly {
    id: string
    name: string
    path: string
    displayPath?: string
    status: WorkbenchFact
    changedFiles: number | null
  }[]
  local: WorkbenchFact
  unpushed: number | null
  commits: number | null
  attention: boolean
  needsRestack: boolean
  conflicted: boolean | null
  readyToMerge: boolean | null
  /** null is confirmed absence; undefined is unavailable association metadata. */
  pullRequest?: {
    id: string
    number: number
    author: string | null
    state: 'open' | 'closed' | 'merged' | 'unknown'
    lifecycle: WorkbenchFact
    review: WorkbenchFact
    checks: WorkbenchFact
    publishedHead: string | null
    baseRef?: string
    nativeMembership?: {
      stackNumber: number
      position: number
      total: number
      base: string
      url: string
    }
    draft: boolean
  } | null
  notice?: { title: string; body: string; tone: WorkbenchTone }
}

export interface BranchWorkbenchSnapshot {
  repositories: readonly WorkbenchRepository[]
  branches: readonly WorkbenchBranch[]
  globalCounts?: { attention: number | null; readyToMerge: number | null }
  localFreshness: string
  remoteFreshness: string
  notice?: string
}

export type WorkbenchAction =
  | 'branches'
  | 'discover'
  | 'create-worktree'
  | 'review'
  | 'history'
  | 'restack'
  | 'sync'
  | 'publish'
  | 'merge'
  | 'open-directory'
  | 'pull-requests'
  | 'attention'
  | 'activity'
  | 'search'
  | 'settings'

export interface WorkbenchActionContext {
  repositoryId: string
  branchId?: string
  worktreeId?: string
  pullRequestId?: string
}

/** Availability is supplied by the integration owner, not inferred from display badges. */
export type WorkbenchCapabilities = Partial<Record<WorkbenchAction, { reason?: string }>>

export interface LaneEntry {
  branch: WorkbenchBranch
  lane: number
  parentId: string | null
  issue?: string
}

/** Iterative postorder; each dependency is visited once, including deep/cyclic inventories. */
export function projectBranchLanes(branches: readonly WorkbenchBranch[]): LaneEntry[] {
  const ordered = [...branches].sort((a, b) => a.id.localeCompare(b.id))
  const byId = new Map(ordered.map((branch) => [branch.id, branch]))
  const parents = new Map<string, string | null>()
  const issues = new Map<string, string>()
  for (const branch of ordered) {
    const parent = branch.parentId ? byId.get(branch.parentId) : undefined
    const issue =
      branch.parentIssue ??
      (branch.parentId && (!parent || parent.repositoryId !== branch.repositoryId)
        ? 'Parent unavailable'
        : undefined)
    parents.set(branch.id, issue ? null : branch.parentId)
    if (issue) issues.set(branch.id, issue)
  }
  const visited = new Set<string>()
  for (const branch of ordered) {
    if (visited.has(branch.id)) continue
    const path: string[] = []
    const positions = new Map<string, number>()
    let id: string | null = branch.id
    while (id && !visited.has(id) && !positions.has(id)) {
      positions.set(id, path.length)
      path.push(id)
      id = parents.get(id) ?? null
    }
    if (id && positions.has(id)) {
      for (let index = positions.get(id)!; index < path.length; index++) {
        parents.set(path[index], null)
        issues.set(path[index], 'Parent cycle')
      }
    }
    for (const key of path) visited.add(key)
  }
  const children = new Map<string, WorkbenchBranch[]>()
  for (const branch of ordered) {
    const parent = parents.get(branch.id)
    if (!parent) continue
    const dependents = children.get(parent) ?? []
    dependents.push(branch)
    children.set(parent, dependents)
  }
  const entries: LaneEntry[] = []
  const pending: { branch: WorkbenchBranch; lane: number; exit: boolean }[] = []
  for (const root of ordered
    .filter((branch) => !parents.get(branch.id))
    .sort((a, b) => Number(a.trunk) - Number(b.trunk))
    .reverse())
    pending.push({ branch: root, lane: 0, exit: false })
  while (pending.length) {
    const { branch, lane, exit } = pending.pop()!
    if (exit) {
      entries.push({
        branch,
        lane,
        parentId: parents.get(branch.id) ?? null,
        issue: issues.get(branch.id),
      })
      continue
    }
    pending.push({ branch, lane, exit: true })
    const dependents = children.get(branch.id) ?? []
    for (let index = dependents.length - 1; index >= 0; index--)
      pending.push({
        branch: dependents[index],
        // Deep/wide continuations share bounded tracks; edges still target exact parents.
        lane: Math.min(6, lane + (branch.trunk || dependents.length > 1 ? index + 1 : 0)),
        exit: false,
      })
  }
  return entries
}

export interface WorkbenchViewState {
  query: string
  filter: string
  scope: string
  refScope: 'all' | 'local' | 'remote'
  folded: string[]
  tab: 'overview' | 'changes' | 'checks' | 'discussion'
  worktreeId: string | null
  scroll: number
  page: number
  unfilteredScroll?: number
  unfilteredPage?: number
  density: 'compact' | 'standard'
}

export const initialWorkbenchView: WorkbenchViewState = {
  query: '',
  filter: 'All branches',
  scope: 'all',
  refScope: 'all',
  folded: [],
  tab: 'overview',
  worktreeId: null,
  scroll: 0,
  page: 0,
  density: 'compact',
}

/** Postorder lets descendant counts propagate once, without repeated ancestor walks. */
export function laneDescendantCounts(entries: readonly LaneEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.parentId)
      counts.set(
        entry.parentId,
        (counts.get(entry.parentId) ?? 0) + 1 + (counts.get(entry.branch.id) ?? 0),
      )
  }
  return counts
}

export function relatedLaneIds(
  entries: readonly LaneEntry[],
  selected: string | null,
): Set<string> {
  const byId = new Map(entries.map((entry) => [entry.branch.id, entry]))
  const related = new Set<string>()
  let id = selected
  while (id && byId.has(id) && !related.has(id)) {
    related.add(id)
    id = byId.get(id)!.parentId
  }
  const descendants = new Set<string>(selected ? [selected] : [])
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.parentId && descendants.has(entry.parentId)) descendants.add(entry.branch.id)
  }
  for (const key of descendants) related.add(key)
  return related
}
