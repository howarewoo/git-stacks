import type { Branch } from '../../../shared/types'
import {
  getCombinedBranches,
  getRepresentedRemoteRef,
  indexBranchesByParentName,
  sortBranchesByUpdatedAt,
} from './branches'

export type StackRelation = 'parent' | 'child' | 'top' | 'bottom'

/**
 * Identity used to decide whether a recorded parent is the branch in hand.
 * A local branch and the remote row it represents share it, so navigation
 * matches whichever of the pair the user selected.
 */
function branchIdentity(branch: Branch): string {
  return getRepresentedRemoteRef(branch) ?? branch.ref
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
    const parentIdentity = branchIdentity(parent)
    return ordered.filter((branch) => {
      if (branch.remote || branch.ref === parent.ref || branch.parent === null) return false
      const recordedParent = byName.get(branch.parent)
      return recordedParent !== undefined && branchIdentity(recordedParent) === parentIdentity
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
