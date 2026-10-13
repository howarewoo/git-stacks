export type WorkbenchTone = 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'merged'

export interface WorkbenchFact {
  label: string
  tone?: WorkbenchTone
  icon?: 'circle' | 'check' | 'review' | 'comment' | 'error' | 'clock' | 'merge'
}

export interface WorkbenchRepository {
  id: string
  name: string
  owner: string
  mark: string
  /** Main-owned complete totals; null means unavailable/partial, not zero. */
  branchCount: number | null
  pullRequestCount: number | null
  unpublishedCount: number | null
  readyToMergeCount: number | null
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
  trunk: boolean
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
    draft: boolean
  } | null
  notice?: { title: string; body: string; tone: WorkbenchTone }
}

export interface BranchWorkbenchSnapshot {
  repositories: readonly WorkbenchRepository[]
  branches: readonly WorkbenchBranch[]
  localFreshness: string
  remoteFreshness: string
  notice?: string
}

export type WorkbenchAction =
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

/** Stable postorder of qualified dependencies; cycles and unresolved parents do not gain edges. */
export function projectBranchLanes(branches: readonly WorkbenchBranch[]): LaneEntry[] {
  const byId = new Map(branches.map((branch) => [branch.id, branch]))
  const parents = new Map<string, string | null>()
  const issues = new Map<string, string>()
  for (const branch of branches) {
    let parentId = branch.parentIssue ? null : branch.parentId
    if (branch.parentIssue) issues.set(branch.id, branch.parentIssue)
    const visited = new Set([branch.id])
    let next = parentId
    while (next) {
      const parent = byId.get(next)
      if (!parent || parent.repositoryId !== branch.repositoryId) {
        if (next === parentId) {
          issues.set(branch.id, 'Parent unavailable')
          parentId = null
        }
        break
      }
      if (visited.has(next)) {
        issues.set(branch.id, 'Parent cycle')
        parentId = null
        break
      }
      visited.add(next)
      next = parent.parentIssue ? null : parent.parentId
    }
    parents.set(branch.id, parentId)
  }
  const children = new Map<string, WorkbenchBranch[]>()
  for (const branch of branches) {
    const parent = parents.get(branch.id)
    if (!parent) continue
    const dependents = children.get(parent)
    if (dependents) dependents.push(branch)
    else children.set(parent, [branch])
  }
  const entries: LaneEntry[] = []
  const seen = new Set<string>()
  function walk(branch: WorkbenchBranch, lane: number) {
    if (seen.has(branch.id)) return
    seen.add(branch.id)
    const dependents = children.get(branch.id) ?? []
    for (const child of dependents) {
      walk(child, lane + (branch.trunk || dependents.length > 1 ? 1 : 0))
    }
    entries.push({
      branch,
      lane,
      parentId: parents.get(branch.id) ?? null,
      issue: issues.get(branch.id),
    })
  }
  for (const branch of branches.filter((branch) => branch.trunk || !parents.get(branch.id))) {
    walk(branch, 0)
  }
  for (const branch of branches) walk(branch, 0)
  return entries
}
