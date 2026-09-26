import type { Branch } from '../../../shared/types'
import {
  getCombinedBranches,
  getRepresentedRemoteRef,
  indexBranchesByParentName,
  sortBranchesByUpdatedAt,
} from './branches'

export type BranchFilter = 'all' | 'local' | 'remote' | 'prs'

export const branchFilterOptions: { value: BranchFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'local', label: 'Local' },
  { value: 'remote', label: 'Remote' },
  { value: 'prs', label: 'With PRs' },
]

export type BranchTreeInfo = {
  depth: number
  cycle: boolean
  missingParent: boolean
}

export type BranchTreeTrunk = {
  lane: number
  kind: 'start' | 'start-node' | 'full' | 'end-parent' | 'end-child'
}

export type BranchTreeRow = BranchTreeInfo & {
  trunks: BranchTreeTrunk[]
  elbows: { lane: number }[]
  /**
   * Scratch lane -> edge identity, used only to decide which neighbouring rows share a
   * connector line. Emptied before the rows are returned, so it never reaches the view.
   */
  edges: Map<number, string>
}

export function branchTreeInfo(
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

/**
 * Connector strokes are derived per row from the row's own visible ancestry, so a
 * deeper branch keeps every ancestor lane even when the updated-time ordering is not
 * a contiguous depth-first walk. A lane segment is merged into a full line when a row
 * both continues an ancestor lane and terminates one for its own children.
 */
export function getBranchTreeGeometry(
  visibleBranches: readonly Branch[],
  byName: Map<string, Branch>,
): { rows: BranchTreeRow[] } {
  const childCounts = new Map<string, number>()
  for (const branch of getCombinedBranches([...new Set(byName.values())])) {
    const parent = byName.get(branch.parent ?? '')
    if (parent) childCounts.set(parent.ref, (childCounts.get(parent.ref) ?? 0) + 1)
  }
  const rows: BranchTreeRow[] = visibleBranches.map((branch) => ({
    ...branchTreeInfo(branch, byName, childCounts),
    trunks: [],
    elbows: [],
    edges: new Map(),
  }))
  const visibleByName = indexBranchesByParentName(visibleBranches)
  const visibleRefs = new Set(visibleBranches.map((branch) => branch.ref))
  const parentsWithVisibleChildren = new Set<string>()
  for (const branch of visibleBranches) {
    const parent = branch.parent ? visibleByName.get(branch.parent) : undefined
    if (parent) parentsWithVisibleChildren.add(parent.ref)
  }

  for (const [index, branch] of visibleBranches.entries()) {
    const row = rows[index]
    if (row.cycle || row.missingParent) continue
    const segments = new Map<number, { kind: BranchTreeTrunk['kind']; edge: string }>()
    let parentLane: number | null = null

    if (branch.parent) {
      const chain: { lane: number; visible: boolean; ref: string }[] = []
      const visited = new Set<string>([branch.name])
      let name: string | null = branch.parent
      while (name && !visited.has(name)) {
        visited.add(name)
        const ancestor = byName.get(name)
        if (!ancestor) break
        const visible = visibleRefs.has(ancestor.ref)
        chain.push({
          lane: branchTreeInfo(ancestor, byName, childCounts).depth,
          visible,
          ref: ancestor.ref,
        })
        if (!visible) break
        name = ancestor.parent
      }
      if (chain.length) {
        parentLane = chain[0].lane
        for (const { lane, visible, ref } of chain) {
          const kind: BranchTreeTrunk['kind'] =
            lane === row.depth
              ? visible
                ? 'start-node'
                : 'full'
              : lane === parentLane
                ? 'start'
                : 'full'
          const existing = segments.get(lane)
          segments.set(lane, {
            kind: existing && existing.kind !== kind ? 'full' : kind,
            edge: ref,
          })
        }
      }
    }

    if (parentsWithVisibleChildren.has(branch.ref)) {
      const existing = segments.get(row.depth)
      segments.set(row.depth, {
        kind: existing && existing.kind !== 'end-parent' ? 'full' : 'end-parent',
        edge: branch.ref,
      })
    }
    if (parentLane !== null && parentLane < row.depth) row.elbows.push({ lane: parentLane })
    row.trunks = [...segments.entries()]
      .sort(([left], [right]) => left - right)
      .map(([lane, { kind }]) => ({ lane, kind }))
    row.edges = new Map([...segments.entries()].map(([lane, { edge }]) => [lane, edge]))
  }

  // A lane is a continuous vertical line through the block of rows that draw it, so a
  // segment only opens at the top of a block and only closes at the parent node. The row
  // order is an updated-time sort, not a depth-first walk, so blocks are tested for real
  // adjacency instead of assuming a subtree stays contiguous.
  //
  // Adjacency alone is not enough: two independent stacks both use lane 0, so matching
  // on the lane number alone would weld one tree's closing segment to the next tree's
  // opening one and draw a connector between unrelated trunks. A segment therefore
  // continues only when the neighbouring row draws the same lane for the same edge, and
  // the edge is the branch whose node the line descends from.
  const edgeKey = (index: number, lane: number): string | null =>
    index >= 0 && index < rows.length ? (rows[index].edges.get(lane) ?? null) : null
  for (const [index, row] of rows.entries()) {
    row.trunks = row.trunks.map((trunk) => {
      const edge = edgeKey(index, trunk.lane)
      if (trunk.kind === 'start' || trunk.kind === 'start-node') {
        return edge !== null && edge === edgeKey(index - 1, trunk.lane)
          ? { ...trunk, kind: 'full' }
          : trunk
      }
      if (trunk.kind === 'end-parent') {
        return edge !== null && edge === edgeKey(index + 1, trunk.lane)
          ? { ...trunk, kind: 'full' }
          : trunk
      }
      return trunk
    })
  }

  for (const row of rows) row.edges = new Map()

  return { rows }
}

export type BranchWorkspace = {
  /** Every branch indexed by stack parent name, remotes included, for ancestry lookups. */
  byName: Map<string, Branch>
  /** One row per local/tracked-remote pair, used by the non-remote filters. */
  combined: Branch[]
  ordered: Branch[]
  visible: Branch[]
  rows: BranchTreeRow[]
  shown: number
  total: number
}

/**
 * One derivation for the branch tree, its filters, and its result count. The Remote
 * filter browses raw remote refs so an explicit remote view stays complete even when
 * a local branch already represents the same ref.
 */
export function getBranchWorkspace(
  branches: readonly Branch[],
  filter: BranchFilter,
  search: string,
): BranchWorkspace {
  const byName = indexBranchesByParentName(branches)
  const combined = getCombinedBranches([...branches])
  const ordered = sortBranchesByUpdatedAt(
    filter === 'remote' ? branches.filter((branch) => branch.remote) : combined,
  )
  const needle = search.trim().toLowerCase()
  const visible = ordered.filter((branch) => {
    if (filter === 'local' && branch.remote) return false
    if (filter === 'remote' && !branch.remote) return false
    if (filter === 'prs' && !branch.pr) return false
    if (!needle) return true
    return `${branch.name} ${branch.subject} ${branch.upstream ?? ''}`
      .toLowerCase()
      .includes(needle)
  })

  return {
    byName,
    combined,
    ordered,
    visible,
    rows: getBranchTreeGeometry(visible, byName).rows,
    shown: visible.length,
    total: ordered.length,
  }
}

/**
 * A remote row is the inspected row only while the user is explicitly browsing
 * remotes; otherwise selection follows the local branch that represents it.
 */
export function resolveSelectedBranch(
  branches: readonly Branch[],
  selectedBranchRef: string | null,
  filter: BranchFilter,
): Branch | null {
  if (!selectedBranchRef) return null
  const branch = branches.find((candidate) => candidate.ref === selectedBranchRef)
  if (!branch) return null
  if (!branch.remote || filter === 'remote') return branch
  return (
    branches.find((candidate) => !candidate.remote && candidate.upstreamRef === branch.ref) ??
    branches.find((candidate) => getRepresentedRemoteRef(candidate) === branch.ref) ??
    branch
  )
}

export function requiresRestack(branch: Branch): boolean {
  return Boolean(branch.needsRestack) || (branch.parentBehind ?? 0) > 0
}

export type ParentProvenance = 'recorded' | 'pullRequest' | 'inferred' | 'none'

/** Recorded parents are the only provenance that may read as confirmed. */
export function parentProvenanceLabel(branch: Branch): string {
  if (!branch.parent) return 'No recorded parent'
  if (branch.parentSource === 'recorded') return 'Recorded parent'
  if (branch.parentSource === 'pullRequest') return 'Parent from PR base'
  if (branch.parentSource === 'inferred') return 'Inferred parent — confirm before publishing'
  return 'Unconfirmed parent'
}

/** Parent names a row in the current view can actually point at. */
export function indexVisibleParentNames(visible: readonly Branch[]): Set<string> {
  return new Set(indexBranchesByParentName(visible).keys())
}

/**
 * Connector strokes are decorative, so ancestry is also published as text. That text
 * survives a clipped graph and a parent that the current filter hides.
 */
export function describeBranchAncestry(
  branch: Branch,
  tree: Pick<BranchTreeInfo, 'cycle' | 'missingParent'>,
  visibleParentNames: ReadonlySet<string>,
): string {
  if (!branch.parent) return 'No stack parent recorded.'
  if (tree.cycle) {
    return `Recorded stack parent ${branch.parent} completes a cycle, so ancestry could not be resolved.`
  }
  if (tree.missingParent || !visibleParentNames.has(branch.parent)) {
    return `Stack parent ${branch.parent} is not in the current view, so its row is hidden.`
  }
  return `Stack parent ${branch.parent}.`
}

export function branchRowLabel(
  branch: Branch,
  tree: Pick<BranchTreeInfo, 'cycle' | 'missingParent'>,
  ancestry: string,
): string {
  const parts = [branch.name, branch.remote ? 'remote branch' : 'local branch']
  if (branch.current) parts.push('current branch')
  if (branch.pr) {
    const lifecycle =
      branch.pr.state === 'OPEN' && branch.pr.draft ? 'draft open' : branch.pr.state.toLowerCase()
    parts.push(`pull request #${branch.pr.number} ${lifecycle}`)
  }
  if (requiresRestack(branch)) parts.push('requires restack')
  if (tree.cycle) parts.push('parent cycle')
  if (tree.missingParent) parts.push('parent missing')
  parts.push(ancestry)
  return parts.join(', ')
}

export function formatBranchDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 60_000) return 'just now'
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m ago`
  if (elapsed < 86_400_000) return `${Math.max(1, Math.floor(elapsed / 3_600_000))}h ago`
  if (elapsed < 604_800_000) return `${Math.max(1, Math.floor(elapsed / 86_400_000))}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
