import type { Branch, NativeStack, PullRequest } from './types'

/** A display-only relationship. Neither this projection nor its completeness authorizes a mutation. */
export type PrGraphSource =
  | 'github-base'
  | 'github-head'
  | 'local-parent'
  | 'ancestry'
  | 'native-membership'
export type PrGraphResolution = 'resolved' | 'unresolved' | 'ambiguous' | 'incomplete' | 'cycle'
export interface PrGraphNode {
  id: string
  kind: 'pr' | 'ref'
  repository: string
  name: string
  pr?: PullRequest
  branch?: Branch
  /** Native submission is an annotation, not proof of a GitHub target or local ancestry. */
  nativeStack?: PullRequest['stack']
}
export interface PrGraphEdge {
  from: string
  to: string | null
  candidates: string[]
  target: string
  source: PrGraphSource
  resolution: PrGraphResolution
}
export interface PrGraphConflict {
  pr: string
  githubTarget: string
  otherTarget: string
  source: 'local-parent' | 'native-membership'
}
export interface PrGraph {
  nodes: PrGraphNode[]
  edges: PrGraphEdge[]
  conflicts: PrGraphConflict[]
  complete: boolean
}
export interface PrGraphInput {
  host: string
  repository: string
  pullRequests: readonly PullRequest[]
  branches: readonly Branch[]
  nativeStacks?: readonly NativeStack[]
  /** False while any PR page is unread, failed, or obsolete. */
  complete: boolean
}

/** Stable identities are tuples, not short ref names or object SHA values. */
export function prGraphId(
  host: string,
  repository: string,
  kind: 'pr' | 'ref',
  identity: string,
): string {
  return JSON.stringify([host.toLowerCase(), repository.toLowerCase(), kind, identity])
}

export function projectPrGraph(input: PrGraphInput): PrGraph {
  const { host, repository, complete } = input
  const origin = repository.toLowerCase()
  const nodes: PrGraphNode[] = []
  const byId = new Map<string, PrGraphNode>()
  const prHeads = new Map<string, string[]>()
  const refs = new Map<string, string>()
  const localHeads = new Map<number, string[]>()
  const add = (node: PrGraphNode) => {
    if (!byId.has(node.id)) {
      byId.set(node.id, node)
      nodes.push(node)
    }
  }
  for (const branch of input.branches) {
    const id = prGraphId(host, repository, 'ref', branch.ref)
    refs.set(branch.ref, id)
    add({ id, kind: 'ref', repository, name: branch.ref, branch })
    if (!branch.remote && branch.pr) {
      const known = localHeads.get(branch.pr.number) ?? []
      known.push(id)
      localHeads.set(branch.pr.number, known)
    }
  }
  for (const pr of input.pullRequests) {
    const id = prGraphId(host, repository, 'pr', String(pr.number))
    add({ id, kind: 'pr', repository, name: `#${pr.number}`, pr, nativeStack: pr.stack })
    // A missing head repository is not evidence that this is a same-repository head.
    if (pr.headRepository?.toLowerCase() === origin) {
      const candidates = prHeads.get(pr.head) ?? []
      candidates.push(id)
      prHeads.set(pr.head, candidates)
    }
  }
  const edges: PrGraphEdge[] = []
  const githubTargets = new Map<string, PrGraphEdge>()
  const localTargets = new Map<string, PrGraphEdge>()
  const connect = (from: string, target: string, source: PrGraphSource, candidates: string[]) => {
    const unique = [...new Set(candidates)]
    const edge: PrGraphEdge = {
      from,
      target,
      source,
      to: unique.length === 1 ? unique[0] : null,
      candidates: unique,
      resolution:
        unique.length > 1
          ? 'ambiguous'
          : unique.length === 1
            ? 'resolved'
            : complete
              ? 'unresolved'
              : 'incomplete',
    }
    edges.push(edge)
    if (source === 'github-base') githubTargets.set(from, edge)
    if (source === 'local-parent' && !localTargets.has(from)) localTargets.set(from, edge)
  }
  for (const pr of input.pullRequests) {
    const id = prGraphId(host, repository, 'pr', String(pr.number))
    const candidates = prHeads.get(pr.base) ?? []
    // A GitHub target is another open PR only if its head is uniquely established.
    // A ref remains a possible target alongside ambiguous PR heads, never an inferred stack.
    const ref = refs.get(`refs/remotes/origin/${pr.base}`)
    connect(id, pr.base, 'github-base', candidates.length ? candidates : ref ? [ref] : [])
  }
  for (const pr of input.pullRequests) {
    if (pr.headRepository?.toLowerCase() !== origin) continue
    const id = prGraphId(host, repository, 'pr', String(pr.number))
    const remote = refs.get(`refs/remotes/origin/${pr.head}`)
    if (remote) connect(id, pr.head, 'github-head', [remote])
    for (const local of localHeads.get(pr.number) ?? []) connect(id, local, 'github-head', [local])
  }
  for (const branch of input.branches) {
    const id = prGraphId(host, repository, 'ref', branch.ref)
    const parentFacts: { target: string; source: PrGraphSource }[] = []
    if (branch.recordedParent)
      parentFacts.push({ target: branch.recordedParent, source: 'local-parent' })
    if (
      branch.parent &&
      !(branch.recordedParent === branch.parent && branch.parentSource === 'recorded')
    ) {
      const source: PrGraphSource =
        branch.parentSource === 'inferred'
          ? 'ancestry'
          : branch.parentSource === 'stack'
            ? 'native-membership'
            : branch.parentSource === 'pullRequest'
              ? 'github-base'
              : 'local-parent'
      parentFacts.push({ target: branch.parent, source })
    }
    for (const { target, source } of parentFacts) {
      const qualified = target.startsWith('refs/')
        ? refs.get(target)
        : target.startsWith('origin/')
          ? refs.get(`refs/remotes/${target}`)
          : undefined
      const local = refs.get(`refs/heads/${target}`)
      const remote = refs.get(`refs/remotes/origin/${target}`)
      const candidates = qualified
        ? [qualified]
        : target.startsWith('refs/') || target.startsWith('origin/')
          ? []
          : local
            ? [local]
            : remote
              ? [remote]
              : []
      connect(id, target, source, candidates)
    }
  }
  const nativeParents = new Map<string, string[]>()
  for (const stack of input.nativeStacks ?? []) {
    for (let i = 1; i < stack.pullRequests.length; i++) {
      const child = prGraphId(host, repository, 'pr', String(stack.pullRequests[i].number))
      const parent = prGraphId(host, repository, 'pr', String(stack.pullRequests[i - 1].number))
      if (byId.has(child)) {
        connect(child, String(stack.number), 'native-membership', byId.has(parent) ? [parent] : [])
        if (byId.has(parent)) {
          const parents = nativeParents.get(child) ?? []
          parents.push(parent)
          nativeParents.set(child, parents)
        }
      }
    }
  }
  // A head association and native order do not establish a dependency. The
  // resolved target, local intent, and inferred ancestry edges can form cycles.
  const dependency = edges.filter(
    (edge) => edge.source !== 'native-membership' && edge.source !== 'github-head' && edge.to,
  )
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const edge of dependency) {
    const children = outgoing.get(edge.from) ?? []
    children.push(edge.to!)
    outgoing.set(edge.from, children)
    const parents = incoming.get(edge.to!) ?? []
    parents.push(edge.from)
    incoming.set(edge.to!, parents)
  }
  const visited = new Set<string>()
  const order: string[] = []
  for (const node of nodes) {
    if (visited.has(node.id)) continue
    const walk: { id: string; next: number }[] = [{ id: node.id, next: 0 }]
    visited.add(node.id)
    while (walk.length) {
      const frame = walk[walk.length - 1]
      const successors = outgoing.get(frame.id) ?? []
      if (frame.next === successors.length) {
        order.push(frame.id)
        walk.pop()
      } else {
        const next = successors[frame.next++]
        if (!visited.has(next)) {
          visited.add(next)
          walk.push({ id: next, next: 0 })
        }
      }
    }
  }
  const component = new Map<string, number>()
  const sizes: number[] = []
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i]
    if (component.has(root)) continue
    const group = sizes.length
    let size = 0
    const pending = [root]
    component.set(root, group)
    while (pending.length) {
      const current = pending.pop()!
      size++
      for (const parent of incoming.get(current) ?? []) {
        if (component.has(parent)) continue
        component.set(parent, group)
        pending.push(parent)
      }
    }
    sizes.push(size)
  }
  for (const edge of dependency) {
    const group = component.get(edge.from)
    if (
      group !== undefined &&
      group === component.get(edge.to!) &&
      (sizes[group] > 1 || edge.from === edge.to)
    )
      edge.resolution = 'cycle'
  }
  const conflicts: PrGraphConflict[] = []
  for (const pr of input.pullRequests) {
    const id = prGraphId(host, repository, 'pr', String(pr.number))
    for (const local of localHeads.get(pr.number) ?? []) {
      const branch = byId.get(local)?.branch
      const recorded =
        branch?.recordedParent ?? (branch?.parentSource === 'recorded' ? branch.parent : null)
      const githubTarget = githubTargets.get(id)
      const localTarget = localTargets.get(local)
      const hasResolvedEvidence = githubTarget?.to && localTarget?.to
      const differs = hasResolvedEvidence
        ? githubTarget.to !== localTarget.to
        : recorded !== pr.base &&
          !githubTarget?.candidates.some((candidate) => localTarget?.candidates.includes(candidate))
      if (recorded && differs)
        conflicts.push({
          pr: id,
          githubTarget: pr.base,
          otherTarget: recorded,
          source: 'local-parent',
        })
    }
    for (const parentId of nativeParents.get(id) ?? []) {
      const parent = byId.get(parentId)?.pr
      if (parent && parent.head !== pr.base)
        conflicts.push({
          pr: id,
          githubTarget: pr.base,
          otherTarget: parent.head,
          source: 'native-membership',
        })
    }
  }
  return { nodes, edges, conflicts, complete }
}
