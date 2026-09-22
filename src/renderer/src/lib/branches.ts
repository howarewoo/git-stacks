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

export function indexBranchesByParentName(branches: readonly Branch[]): Map<string, Branch> {
  const index = new Map<string, Branch>()
  for (const branch of branches) {
    if (!branch.remote) index.set(branch.name, branch)
  }
  for (const branch of branches) {
    if (branch.remote && !index.has(branch.name)) index.set(branch.name, branch)
  }
  for (const branch of branches) {
    if (branch.remote && branch.name.startsWith('origin/')) {
      const name = branch.name.slice('origin/'.length)
      if (!index.has(name)) index.set(name, branch)
    }
  }
  return index
}

export function sortBranchesByUpdatedAt(branches: readonly Branch[]): Branch[] {
  const ranked = branches
    .map((branch) => {
      const timestamp = Date.parse(branch.updatedAt)
      return { branch, timestamp: Number.isNaN(timestamp) ? -Infinity : timestamp }
    })
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || left.branch.ref.localeCompare(right.branch.ref),
    )
    .map(({ branch }) => branch)
  const byName = indexBranchesByParentName(ranked)
  const rankByRef = new Map(ranked.map((branch, rank) => [branch.ref, rank]))
  const parentRanks = new Int32Array(ranked.length).fill(-1)
  const children: number[][] = ranked.map(() => [])
  for (let rank = 0; rank < ranked.length; rank += 1) {
    const parent = byName.get(ranked[rank].parent ?? '')
    if (!parent) continue
    const parentRank = rankByRef.get(parent.ref)!
    parentRanks[rank] = parentRank
    children[parentRank].push(rank)
  }

  // Rank sibling stacks by their newest member, then emit each entire stack
  // children-first. Contiguous subtrees keep fixed depth lanes unambiguous.
  const recentRanks = Int32Array.from(ranked, (_, rank) => rank)
  const remainingChildren = Int32Array.from(children, (entries) => entries.length)
  const ready = ranked.flatMap((_, rank) => (remainingChildren[rank] === 0 ? [rank] : []))
  for (let index = 0; index < ready.length; index += 1) {
    const rank = ready[index]
    const parent = parentRanks[rank]
    if (parent < 0) continue
    recentRanks[parent] = Math.min(recentRanks[parent], recentRanks[rank])
    if (--remainingChildren[parent] === 0) ready.push(parent)
  }
  const byRecency = (left: number, right: number) => recentRanks[left] - recentRanks[right]
  for (const siblings of children) siblings.sort(byRecency)
  const roots = ranked.flatMap((_, rank) => (parentRanks[rank] < 0 ? [rank] : []))
  roots.sort(byRecency)
  const ordered: Branch[] = []
  const emitted = new Uint8Array(ranked.length)
  for (const root of roots) {
    const pending = [root]
    while (pending.length) {
      const rank = pending.pop()!
      if (rank < 0) {
        const completed = ~rank
        ordered.push(ranked[completed])
        emitted[completed] = 1
        continue
      }
      pending.push(~rank)
      for (let index = children[rank].length - 1; index >= 0; index -= 1) {
        pending.push(children[rank][index])
      }
    }
  }
  // Cyclic parent metadata cannot be ordered; retain those rows and their existing cycle warning.
  for (let rank = 0; rank < ranked.length; rank += 1) {
    if (!emitted[rank]) ordered.push(ranked[rank])
  }
  return ordered
}
