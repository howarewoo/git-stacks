import type { Branch } from '../../../shared/types'
import { getCombinedBranches, indexBranchesByParentName, sortBranchesByUpdatedAt } from './branches'

export type StackRelation = 'parent' | 'child' | 'top' | 'bottom'

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
  const combined = getCombinedBranches(branches)
  const byName = indexBranchesByParentName(combined)
  const ordered = sortBranchesByUpdatedAt(combined)

  const childrenOf = (parent: Branch): Branch[] => {
    return ordered.filter(
      (branch) =>
        !branch.remote &&
        branch.ref !== parent.ref &&
        branch.parent !== null &&
        byName.get(branch.parent)?.ref === parent.ref,
    )
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
