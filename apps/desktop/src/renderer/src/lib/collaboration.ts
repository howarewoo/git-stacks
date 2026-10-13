import type { WorktreeInventory, RepositoryInventory } from '@git-stacks/shared/worktree-inventory'
import type { PullRequestInboxItem, PullRequestInboxReport } from '@git-stacks/shared/pr-inbox'
import type { PullRequest } from '@git-stacks/shared/types'
import type { BranchWorkbenchSnapshot } from '../components/branch-workbench-model'

export interface CollaborationTarget {
  repositoryId: string
  branchId?: string
  worktreeId?: string
  pullRequestId?: string
  number?: number
}
export interface AttentionItem {
  id: string
  repository: string
  title: string
  reasons: string[]
  group: 'review' | 'response' | 'checks' | 'local'
  target: CollaborationTarget
  source?: PullRequestInboxItem
}
export interface ObservedActivity {
  id: string
  repository: string
  target: CollaborationTarget
  label: string
  observedAt: string
  eventAt?: string
}
export interface PublishedObservation {
  headOid: string | null
  base: string
  baseOid: string | null
  state: PullRequest['state']
  draft: boolean
  checks: PullRequest['checks'] | null
  reviewDecision: string | null
}
export interface CollaborationObservation {
  id: string
  repository: string
  target: CollaborationTarget
  value: string | PublishedObservation
  label: string
  observedAt: string
}

/** Provider PRs count once; clone-local directories and ref blockers retain their own identity. */
export function attentionItems(
  inventory: WorktreeInventory | undefined,
  snapshot: BranchWorkbenchSnapshot,
  report: PullRequestInboxReport | undefined,
): AttentionItem[] {
  const result = new Map<string, AttentionItem>()
  const providerItems = new Set(
    (report?.items ?? []).map((item) =>
      JSON.stringify([item.host.toLowerCase(), item.repository.toLowerCase(), item.number]),
    ),
  )
  for (const item of report?.items ?? []) {
    if (item.state !== 'OPEN') continue
    const repo = inventory?.repositories.find(
      (repo) =>
        repo.registeredPaths.includes(item.repositoryPath) &&
        repo.remote?.host.toLowerCase() === item.host.toLowerCase() &&
        repo.remote.fullName.toLowerCase() === item.repository.toLowerCase(),
    )
    if (!repo) continue
    const pr = repo.pullRequests.find((pr) => pr.number === item.number)
    const id = JSON.stringify([item.host.toLowerCase(), item.repository.toLowerCase(), item.number])
    const reasons: string[] = []
    if (item.groups.includes('review-requested')) reasons.push('Direct review requested from you')
    if (item.groups.includes('needs-response'))
      reasons.push('Review or comment needs your response')
    if (
      item.reviewBaselineState !== 'unavailable' &&
      item.reviewBaseline &&
      item.headOid &&
      item.reviewBaseline.headOid !== item.headOid
    )
      reasons.push('Published head changed since your last confirmed review')
    if (
      item.metadata === 'full' &&
      item.reviewKnown !== false &&
      item.reviewDecision === 'CHANGES_REQUESTED'
    )
      reasons.push('Changes requested')
    if (item.metadata === 'full' && item.checksKnown !== false && item.checks === 'failing')
      reasons.push('Published-head checks failing')
    if (!reasons.length) continue
    const previous = result.get(id)
    if (previous) {
      previous.reasons = [...new Set([...previous.reasons, ...reasons])]
      continue
    }
    result.set(id, {
      id,
      repository: `${item.host}/${item.repository}`,
      title: `#${item.number} ${item.title}`,
      reasons,
      group: reasons.some((reason) => reason.includes('response') || reason === 'Changes requested')
        ? 'response'
        : reasons.includes('Published-head checks failing')
          ? 'checks'
          : 'review',
      target: { repositoryId: repo.identity.id, pullRequestId: pr?.id, number: item.number },
      source: item,
    })
  }
  // Inventory contributes provider facts even when the viewer-relative inbox is unavailable.
  for (const repo of inventory?.repositories ?? []) {
    for (const pr of repo.pullRequests) {
      const reasons: string[] = []
      if (pr.facts.state !== 'OPEN') continue
      if (pr.facts.metadata === 'full' && pr.facts.checks === 'failing')
        reasons.push('Published-head checks failing')
      if (pr.facts.metadata === 'full' && pr.facts.reviewDecision === 'CHANGES_REQUESTED')
        reasons.push('Changes requested')
      if (!reasons.length || !repo.remote) continue
      const id = JSON.stringify([
        repo.remote.host.toLowerCase(),
        repo.remote.fullName.toLowerCase(),
        pr.number,
      ])
      if (providerItems.has(id)) continue
      const previous = result.get(id)
      if (previous) previous.reasons = [...new Set([...previous.reasons, ...reasons])]
      else
        result.set(id, {
          id,
          repository: `${repo.remote.host}/${repo.remote.fullName}`,
          title: `#${pr.number} ${pr.facts.title}`,
          reasons,
          group: reasons.includes('Changes requested') ? 'response' : 'checks',
          target: { repositoryId: repo.identity.id, pullRequestId: pr.id, number: pr.number },
        })
    }
    for (const tree of repo.worktrees) {
      const reasons: string[] = []
      if (tree.status === 'conflicted') reasons.push('Local conflicts require external resolution')
      if (tree.operation) reasons.push(`Interrupted ${tree.operation}; inspect operation recovery`)
      if (!reasons.length) continue
      const branch = snapshot.branches.find(
        (branch) =>
          branch.repositoryId === repo.identity.id &&
          branch.worktrees.some((item) => item.id === tree.id),
      )
      result.set(tree.id, {
        id: tree.id,
        repository: repo.remote
          ? `${repo.remote.host}/${repo.remote.fullName}`
          : repo.registeredPaths[0],
        title: `${branch?.ref ?? (tree.detached ? 'Detached worktree' : 'Worktree')} · ${tree.path}`,
        reasons,
        group: 'local',
        target: { repositoryId: repo.identity.id, branchId: branch?.id, worktreeId: tree.id },
      })
    }
  }
  for (const branch of snapshot.branches) {
    if (!branch.needsRestack) continue
    const repo = inventory?.repositories.find((repo) => repo.identity.id === branch.repositoryId)
    result.set(branch.id, {
      id: branch.id,
      repository: repo?.remote
        ? `${repo.remote.host}/${repo.remote.fullName}`
        : (repo?.registeredPaths[0] ?? branch.repositoryId),
      title: branch.ref,
      reasons: ['Dependency requires restack'],
      group: 'local',
      target: { repositoryId: branch.repositoryId, branchId: branch.id },
    })
  }
  for (const item of result.values()) {
    if (item.group === 'local') continue
    item.group = item.reasons.some(
      (reason) => reason.includes('response') || reason === 'Changes requested',
    )
      ? 'response'
      : item.reasons.includes('Published-head checks failing')
        ? 'checks'
        : 'review'
  }
  return [...result.values()]
}

/** Known source values establish baselines, never an invented historical stream. */
export function collaborationObservations(
  inventory: WorktreeInventory | undefined,
  report?: PullRequestInboxReport,
): CollaborationObservation[] {
  const result: CollaborationObservation[] = []
  const provider = new Map<string, CollaborationObservation>()
  const repositoriesByPath = new Map<string, RepositoryInventory>()
  const prIds = new Map<string, Map<number, string>>()
  const observePr = (
    repo: RepositoryInventory,
    pr: PullRequest,
    observedAt: string,
    checksKnown = true,
    reviewKnown = true,
  ) => {
    if (!repo.remote) return
    const id = JSON.stringify([
      'provider-pr',
      repo.remote.host.toLowerCase(),
      repo.remote.fullName.toLowerCase(),
      pr.number,
    ])
    const before = provider.get(id)
    if (before && Date.parse(before.observedAt) > Date.parse(observedAt)) return
    provider.set(id, {
      id,
      repository: `${repo.remote.host}/${repo.remote.fullName}`,
      target: {
        repositoryId: repo.identity.id,
        pullRequestId: prIds.get(repo.identity.id)?.get(pr.number),
        number: pr.number,
      },
      value: {
        headOid: pr.headOid ?? null,
        base: pr.base,
        baseOid: pr.baseOid ?? null,
        state: pr.state,
        draft: pr.draft,
        checks: pr.metadata === 'full' && checksKnown ? pr.checks : null,
        reviewDecision: pr.metadata === 'full' && reviewKnown ? (pr.reviewDecision ?? null) : null,
      },
      label: `PR #${pr.number} published revision, lifecycle or collaboration observation changed`,
      observedAt,
    })
  }
  for (const repo of inventory?.repositories ?? []) {
    const ids = new Map<number, string>()
    for (const pr of repo.pullRequests) ids.set(pr.number, pr.id)
    prIds.set(repo.identity.id, ids)
    for (const path of repo.registeredPaths) repositoriesByPath.set(path, repo)
    const repository = repo.remote
      ? `${repo.remote.host}/${repo.remote.fullName}`
      : repo.registeredPaths[0]
    if (repo.refsRead.state === 'complete' && repo.refsRead.observedAt)
      for (const ref of repo.refs)
        result.push({
          id: ref.id,
          repository,
          target: { repositoryId: repo.identity.id, branchId: ref.id },
          value: ref.oid,
          label: `Revision changed on ${ref.name}`,
          observedAt: repo.refsRead.observedAt,
        })
    for (const tree of repo.worktrees) {
      if (tree.read.state !== 'complete' || !tree.read.observedAt) continue
      result.push({
        id: tree.id,
        repository,
        target: {
          repositoryId: repo.identity.id,
          branchId: tree.refId ?? undefined,
          worktreeId: tree.id,
        },
        value: JSON.stringify([tree.headOid, tree.status, tree.operation, tree.indexSignature]),
        label: `Worktree observation changed: ${tree.status}${tree.operation ? ` · ${tree.operation}` : ''}`,
        observedAt: tree.read.observedAt,
      })
    }
    if (repo.remoteFreshness?.state === 'fresh' && repo.remoteFreshness.fetchedAt)
      for (const pr of repo.pullRequests) observePr(repo, pr.facts, repo.remoteFreshness.fetchedAt)
  }
  if (report?.refresh.confirmedAt)
    for (const pr of report.items) {
      const repo = repositoriesByPath.get(pr.repositoryPath)
      if (
        !repo?.remote ||
        repo.remote.host.toLowerCase() !== pr.host.toLowerCase() ||
        repo.remote.fullName.toLowerCase() !== pr.repository.toLowerCase()
      )
        continue
      observePr(
        repo,
        pr,
        report.refresh.confirmedAt,
        pr.checksKnown !== false,
        pr.reviewKnown !== false,
      )
    }
  for (const item of provider.values()) result.push(item)
  return result
}

/** Advance the caller-owned baseline monotonically; unknown fields are not provider events. */
export function activityTransitions(
  previous: Map<string, CollaborationObservation>,
  current: readonly CollaborationObservation[],
): ObservedActivity[] {
  const result: ObservedActivity[] = []
  const seen = new Set<string>()
  for (const observation of current) {
    seen.add(observation.id)
    const before = previous.get(observation.id)
    if (before && Date.parse(observation.observedAt) < Date.parse(before.observedAt)) continue
    let item = observation
    let changed =
      before &&
      typeof before.value === 'string' &&
      typeof item.value === 'string' &&
      before.value !== item.value
    if (before && typeof before.value !== 'string' && typeof item.value !== 'string') {
      const a = before.value
      const b = item.value
      const headChanged = Boolean(a.headOid && b.headOid && a.headOid !== b.headOid)
      const baseChanged =
        a.base !== b.base || Boolean(a.baseOid && b.baseOid && a.baseOid !== b.baseOid)
      const sameKnownHead = Boolean(a.headOid && b.headOid && a.headOid === b.headOid)
      changed =
        headChanged ||
        baseChanged ||
        a.state !== b.state ||
        a.draft !== b.draft ||
        (sameKnownHead && a.checks !== null && b.checks !== null && a.checks !== b.checks) ||
        (sameKnownHead &&
          a.reviewDecision !== null &&
          b.reviewDecision !== null &&
          a.reviewDecision !== b.reviewDecision)
      item = {
        ...item,
        value: {
          ...b,
          headOid: b.headOid ?? a.headOid,
          baseOid: b.base === a.base ? (b.baseOid ?? a.baseOid) : b.baseOid,
          checks: b.headOid
            ? (b.checks ?? (sameKnownHead && !baseChanged ? a.checks : null))
            : null,
          reviewDecision: b.headOid
            ? (b.reviewDecision ?? (sameKnownHead && !baseChanged ? a.reviewDecision : null))
            : null,
        },
      }
    }
    if (changed)
      result.push({
        id: `${item.id}:${item.observedAt}:${typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}`,
        repository: item.repository,
        target: item.target,
        label: item.label,
        observedAt: item.observedAt,
      })
    previous.set(item.id, item)
  }
  for (const id of previous.keys()) if (!seen.has(id)) previous.delete(id)
  return result
}
