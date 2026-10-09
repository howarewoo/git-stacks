import type { Branch, PullRequest } from '@git-stacks/shared/types'
import { checkLabel } from './pull-request-state'

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
  // A recorded parent may name the remote ref (`origin/main`) even when a local
  // branch already tracks that same ref. Remote names resolve to the local
  // representative so a qualified parent and its short name select the same
  // branch instead of a deduplicated remote row.
  const localByRepresentedRef = new Map<string, Branch>()
  for (const branch of branches) {
    if (branch.remote) continue
    const ref = branch.upstreamRef
    if (ref && !localByRepresentedRef.has(ref)) localByRepresentedRef.set(ref, branch)
  }
  const representative = (branch: Branch): Branch =>
    branch.remote ? (localByRepresentedRef.get(branch.ref) ?? branch) : branch

  const index = new Map<string, Branch>()
  for (const branch of branches) {
    if (!branch.remote) index.set(branch.name, branch)
  }
  for (const branch of branches) {
    if (branch.remote && !index.has(branch.name)) index.set(branch.name, representative(branch))
  }
  for (const branch of branches) {
    if (branch.remote && branch.name.startsWith('origin/')) {
      const name = branch.name.slice('origin/'.length)
      if (!index.has(name)) index.set(name, representative(branch))
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
  // children-first. Contiguous subtrees keep stack lanes unambiguous.
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

export interface BranchRowFacts {
  name: string
  current: boolean
  remote: boolean
  requiresRestack: boolean
  cycle: boolean
  missingParent: boolean
  pullRequestNumber: number | null
  checks: PullRequest['checks'] | null
  ahead: number
  behind: number
  upstream: string | null
}

/**
 * The branch row's accessible name. Every state the row also renders with a
 * colour or an icon is spelled out here, so a screen reader, a monochrome
 * window, or a 200% zoomed row communicates the same thing as the pixels.
 */
export function describeBranchRow(facts: BranchRowFacts): string {
  const parts = [facts.name]
  if (facts.current) parts.push('current branch')
  if (facts.remote) parts.push('remote branch')
  if (facts.cycle) parts.push('parent cycle')
  if (facts.missingParent) parts.push('parent missing')
  if (facts.requiresRestack) parts.push('requires restack')
  if (facts.pullRequestNumber !== null) {
    parts.push(`pull request #${facts.pullRequestNumber}`)
    parts.push(facts.checks ? checkLabel(facts.checks) : 'checks unknown')
  }
  parts.push(
    facts.upstream
      ? `${facts.ahead} ahead, ${facts.behind} behind ${facts.upstream}`
      : 'no upstream configured',
  )
  return parts.join(', ')
}
