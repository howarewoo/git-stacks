import type { Branch } from '@git-stacks/shared/types'
import { getCombinedBranches, indexBranchesByParentName, sortBranchesByUpdatedAt } from './branches'

export type StackRelation = 'parent' | 'child' | 'top' | 'bottom'
/**
 * Resolves the local row a selection stands for. Only a remote row is
 * canonicalized: a local branch already is itself, and two local branches may
 * track the same upstream ref without being the same branch.
 */
function localRepresentative(branch: Branch, byName: Map<string, Branch>): Branch {
  if (!branch.remote) return branch
  return byName.get(branch.name) ?? branch
}

/**
 * Returns the target branch for a stack navigation step, or null when the step
 * is not possible (e.g. no parent, no children, or already at the boundary).
 */
export function resolveStackNavigation(
  current: Branch | null,
  branches: readonly Branch[],
  relation: StackRelation,
): Branch | null {
  if (!current) return null
  // Parent names are resolved against the full snapshot: deduplicating remote
  // rows would drop the qualified aliases (`origin/main`) that a recorded
  // parent can name.
  const byName = indexBranchesByParentName(branches)
  const ordered = sortBranchesByUpdatedAt(getCombinedBranches(branches))

  const childrenOf = (parent: Branch): Branch[] => {
    // Parents are matched by their resolved local ref, because that is what a
    // recorded parent name identifies. Equating branches that share an upstream
    // ref would hand every one of them the same children.
    const parentRef = localRepresentative(parent, byName).ref
    return ordered.filter((branch) => {
      if (branch.remote || branch.ref === parentRef || branch.parent === null) return false
      const recordedParent = byName.get(branch.parent)
      return recordedParent !== undefined && recordedParent.ref === parentRef
    })
  }

  switch (relation) {
    case 'parent': {
      if (!current.parent) return null
      return byName.get(current.parent) ?? null
    }

    case 'child': {
      const children = childrenOf(current)
      return children[0] ?? null
    }

    case 'bottom': {
      let candidate: Branch = current
      const visited = new Set<string>([candidate.name])
      while (candidate.parent) {
        const next = byName.get(candidate.parent)
        if (!next || visited.has(next.name)) break
        visited.add(next.name)
        candidate = next
      }
      return candidate.ref === current.ref ? null : candidate
    }

    case 'top': {
      let candidate: Branch = current
      const visited = new Set<string>([candidate.name])
      while (true) {
        const children = childrenOf(candidate).filter((branch) => !visited.has(branch.name))
        if (children.length === 0) break
        candidate = children[0]
        visited.add(candidate.name)
      }
      return candidate.ref === current.ref ? null : candidate
    }
  }
}
