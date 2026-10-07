import type { PrGraph, PrGraphEdge, PrGraphNode } from './pr-graph'
import { GRAPH_DETAIL_NODE_LIMIT } from './performance'

export type GraphPreset = 'my-prs' | 'review-requested' | 'current-branch' | 'all-open'
export interface GraphCriteria {
  preset: GraphPreset
  text: string
  author: string
  status: 'all' | 'draft' | 'ready' | 'checks-failed' | 'checks-pending'
  collapse: boolean
}
export interface GraphOutlineRow {
  id: string
  nodes: PrGraphNode[]
  role: 'match' | 'context' | 'selected-context'
  /** Actual ordered child-to-parent path; never a synthetic direct dependency. */
  path: string[]
}
export interface GraphDiscovery {
  byId: Map<string, PrGraphNode>
  parents: Map<string, string[]>
  children: Map<string, string[]>
  edges: PrGraphEdge[]
  conflicts: Set<string>
  indexedPrs: Set<number>
}
export function graphDiscovery(graph: PrGraph): GraphDiscovery {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  const edges = graph.edges.filter(
    (edge) => edge.source !== 'github-head' && edge.source !== 'native-membership',
  )
  for (const edge of edges) {
    if (!edge.to || edge.resolution !== 'resolved') continue
    const p = parents.get(edge.from) ?? []
    if (!p.includes(edge.to)) p.push(edge.to)
    parents.set(edge.from, p)
    const c = children.get(edge.to) ?? []
    if (!c.includes(edge.from)) c.push(edge.from)
    children.set(edge.to, c)
  }
  return {
    byId,
    parents,
    children,
    edges,
    conflicts: new Set(graph.conflicts.map((conflict) => conflict.pr)),
    indexedPrs: new Set(graph.nodes.flatMap((node) => (node.pr ? [node.pr.number] : []))),
  }
}
export function graphMatches(
  node: PrGraphNode,
  criteria: GraphCriteria,
  viewer: string | null,
): boolean {
  const pr = node.pr ?? (criteria.preset === 'current-branch' ? node.branch?.pr : null)
  let preset = false
  if (criteria.preset === 'current-branch')
    preset = Boolean(node.branch?.current && !node.branch.remote)
  else if (node.kind === 'pr' && pr?.state === 'OPEN') {
    if (criteria.preset === 'all-open') preset = true
    if (criteria.preset === 'my-prs')
      preset = Boolean(viewer && pr.author?.toLowerCase() === viewer.toLowerCase())
    if (criteria.preset === 'review-requested')
      preset = Boolean(
        viewer && pr.reviewRequested?.some((login) => login.toLowerCase() === viewer.toLowerCase()),
      )
  }
  if (!preset) return false
  if (criteria.author && pr?.author?.toLowerCase() !== criteria.author.toLowerCase()) return false
  const text = criteria.text.trim().toLowerCase()
  if (
    text &&
    !`${node.name} ${pr?.title ?? ''} ${pr?.head ?? ''} ${pr?.base ?? ''} ${pr?.author ?? ''}`
      .toLowerCase()
      .includes(text)
  )
    return false
  if (criteria.status === 'draft' && !pr?.draft) return false
  if (criteria.status === 'ready' && (!pr || pr.draft)) return false
  if (
    criteria.status === 'checks-failed' &&
    (!pr || pr.metadata === 'degraded' || pr.checks !== 'failing')
  )
    return false
  if (
    criteria.status === 'checks-pending' &&
    (!pr || pr.metadata === 'degraded' || pr.checks !== 'pending')
  )
    return false
  return true
}
export function graphOutline(
  discovery: GraphDiscovery,
  criteria: GraphCriteria,
  viewer: string | null,
  selected: string | null,
  expanded: ReadonlySet<string>,
): { rows: GraphOutlineRow[]; matches: number; unknownIdentity: boolean } {
  const matches = new Set<string>()
  for (const node of discovery.byId.values())
    if (graphMatches(node, criteria, viewer)) matches.add(node.id)
  // Current checkout's source-backed PR head association is added by the caller as a selected fact;
  // traversal here follows dependency evidence only, never every sibling sharing main.
  const visible = new Set(matches)
  // Branch-only discovery is explicitly context beside All open PRs, never an invented PR match.
  if (criteria.preset === 'all-open' && !criteria.author && criteria.status === 'all') {
    const text = criteria.text.trim().toLowerCase()
    for (const node of discovery.byId.values()) {
      if (
        node.branch &&
        (!node.branch.pr || !discovery.indexedPrs.has(node.branch.pr.number)) &&
        (!text || node.name.toLowerCase().includes(text))
      )
        visible.add(node.id)
    }
  }
  if (selected && discovery.byId.has(selected)) visible.add(selected)
  const pending = [...visible]
  while (pending.length) {
    for (const parent of discovery.parents.get(pending.pop()!) ?? []) {
      if (visible.has(parent)) continue
      visible.add(parent)
      pending.push(parent)
    }
  }
  const seen = new Set<string>()
  const rows: GraphOutlineRow[] = []
  const role = (id: string): GraphOutlineRow['role'] =>
    matches.has(id) ? 'match' : id === selected ? 'selected-context' : 'context'
  // Begin at actual leaves. A shared ancestor is emitted once, with attachments still in edges.
  const starts = [...visible].filter(
    (id) => !(discovery.children.get(id) ?? []).some((child) => visible.has(child)),
  )
  const ordered = [...starts, ...visible]
  for (const start of ordered) {
    if (seen.has(start)) continue
    let id: string | undefined = start
    while (id && visible.has(id) && !seen.has(id)) {
      const path: string[] = [id]
      seen.add(id)
      if (
        criteria.collapse &&
        !expanded.has(id) &&
        id !== selected &&
        !discovery.conflicts.has(id) &&
        (discovery.children.get(id)?.length ?? 0) <= 1
      ) {
        let tail = id
        for (;;) {
          const parents: string[] = discovery.parents.get(tail) ?? []
          if (parents.length !== 1) break
          const parent: string = parents[0]
          // Exact forks, shared ancestors, source conflicts and selected nodes cannot be hidden.
          if (
            !visible.has(parent) ||
            seen.has(parent) ||
            parent === selected ||
            expanded.has(parent) ||
            discovery.conflicts.has(parent) ||
            (discovery.children.get(parent)?.length ?? 0) !== 1 ||
            (discovery.parents.get(parent)?.length ?? 0) !== 1 ||
            role(parent) !== role(id)
          )
            break
          path.push(parent)
          seen.add(parent)
          tail = parent
        }
      }
      rows.push({ id, nodes: path.map((key) => discovery.byId.get(key)!), role: role(id), path })
      id = discovery.parents
        .get(path[path.length - 1])
        ?.find((parent) => visible.has(parent) && !seen.has(parent))
    }
  }
  return {
    rows,
    matches: matches.size,
    unknownIdentity:
      !viewer && (criteria.preset === 'my-prs' || criteria.preset === 'review-requested'),
  }
}
export interface FocusedGraph {
  nodes: PrGraphNode[]
  edges: PrGraphEdge[]
  omitted: number
}
/** Layout input is bounded before any coordinates are allocated. */
export function focusedGraph(
  discovery: GraphDiscovery,
  selected: string | null,
  chosenPath: string | null,
): FocusedGraph {
  const visible = new Set<string>()
  const queue = [chosenPath, selected].filter((id): id is string =>
    Boolean(id && discovery.byId.has(id)),
  )
  let cursor = 0
  while (cursor < queue.length && visible.size < GRAPH_DETAIL_NODE_LIMIT) {
    const id = queue[cursor++]
    if (visible.has(id)) continue
    visible.add(id)
    for (const parent of discovery.parents.get(id) ?? [])
      if (!visible.has(parent)) queue.push(parent)
  }
  // A focused path does not eagerly mount a wide fork. The path chooser supplies its endpoint.
  return {
    nodes: [...visible].map((id) => discovery.byId.get(id)!),
    edges: discovery.edges.filter(
      (edge) => visible.has(edge.from) && (!edge.to || visible.has(edge.to)),
    ),
    omitted: new Set(queue.slice(cursor).filter((id) => !visible.has(id))).size,
  }
}
export function dependentPaths(discovery: GraphDiscovery, selected: string | null): PrGraphNode[] {
  if (!selected) return []
  const seen = new Set<string>([selected])
  const queue = [...(discovery.children.get(selected) ?? [])]
  const result: PrGraphNode[] = []
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (seen.has(id)) continue
    seen.add(id)
    const node = discovery.byId.get(id)
    if (node) result.push(node)
    queue.push(...(discovery.children.get(id) ?? []))
  }
  return result
}
