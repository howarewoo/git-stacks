import type { Branch } from '../../../shared/types'

export function getRepresentedRemoteRef(branch: Branch): string | null {
  if (branch.remote) return null
  return branch.upstreamRef ?? `refs/remotes/origin/${branch.name}`
}

export function getCombinedBranches(branches: readonly Branch[]): Branch[] {
  const representedRefs = new Set<string>()
  for (const branch of branches) {
    const ref = getRepresentedRemoteRef(branch)
    if (ref) representedRefs.add(ref)
  }
  return branches.filter((branch) => !branch.remote || !representedRefs.has(branch.ref))
}
