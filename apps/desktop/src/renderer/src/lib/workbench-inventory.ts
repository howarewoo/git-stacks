import type { RepositorySnapshot, PullRequest } from '@git-stacks/shared/types'
import type {
  WorktreeInventory,
  RepositoryInventory,
  InventoryRef,
} from '@git-stacks/shared/worktree-inventory'
import type {
  BranchWorkbenchSnapshot,
  WorkbenchBranch,
  WorkbenchFact,
} from '../components/branch-workbench-model'

const parentSources: Record<string, string> = {
  recorded: 'Local recorded parent hint',
  inferred: 'Observed Git ancestry',
  pullRequest: 'Published PR head/base',
  stack: 'Source-confirmed native base hint',
}
function prFacts(pr: PullRequest, id: string): NonNullable<WorkbenchBranch['pullRequest']> {
  const checks: WorkbenchFact =
    pr.metadata !== 'full'
      ? { label: 'Checks unknown' }
      : pr.checks === 'passing'
        ? { label: 'Checks passing', tone: 'success', icon: 'check' }
        : pr.checks === 'failing'
          ? { label: 'Checks failing', tone: 'error', icon: 'error' }
          : { label: `Checks ${pr.checks}`, icon: 'clock' }
  return {
    id,
    number: pr.number,
    author: pr.author ?? null,
    state: pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed',
    lifecycle: {
      label: pr.state === 'OPEN' && pr.draft ? 'Draft' : pr.state,
      tone: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'error' : 'info',
    },
    review: {
      label:
        pr.metadata !== 'full' ? 'Review unknown' : pr.reviewDecision || 'Review policy unknown',
      icon: 'review',
    },
    checks,
    publishedHead: pr.headOid ?? null,
    draft: pr.draft,
    baseRef: pr.base,
    nativeMembership: pr.stack
      ? {
          stackNumber: pr.stack.stackNumber,
          position: pr.stack.position,
          total: pr.stack.size,
          base: pr.stack.base,
          url: pr.stack.url,
        }
      : undefined,
  }
}
/** Observed collaboration state, never the current viewer's mutation permission. */
function publishedReady(pr: PullRequest, fresh: boolean) {
  if (pr.state !== 'OPEN') return false
  if (!fresh || !pr.headOid || pr.metadata !== 'full' || !pr.mergeState || !pr.reviewDecision)
    return null
  return (
    !pr.draft &&
    pr.checks === 'passing' &&
    pr.reviewDecision === 'APPROVED' &&
    pr.mergeState === 'CLEAN'
  )
}
function changedCount(tree: RepositoryInventory['worktrees'][number]) {
  if (!tree.counts || tree.read.state !== 'complete') return null
  // Dual staged/directory edits can name the same file; counts cannot establish their union.
  if (tree.counts.staged && tree.counts.unstaged) return null
  return tree.counts.staged + tree.counts.unstaged + tree.counts.untracked
}
export function projectWorkbenchInventory(
  inventory: WorktreeInventory | undefined,
  details: Readonly<Record<string, RepositorySnapshot>>,
): BranchWorkbenchSnapshot {
  const branches: WorkbenchBranch[] = []
  const globalReady = new Map<string, boolean | null>()
  let globalAttention: number | null = inventory?.state === 'complete' ? 0 : null
  let readyComplete = inventory?.state === 'complete'
  const repositories = (inventory?.repositories ?? []).map((repo) => {
    const id = repo.identity.id
    const start = branches.length
    const detail = details[id]
    const remoteKnown = repo.remoteFreshness?.state === 'fresh'
    const directoriesKnown = repo.discovery.state === 'complete'
    const byRef = new Map(detail?.branches.map((branch) => [branch.ref, branch]) ?? [])
    const byName = new Map(repo.refs.map((ref) => [ref.name, ref]))
    const refIds = new Set(repo.refs.map((ref) => ref.id))
    const prsById = new Map(repo.pullRequests.map((pr) => [pr.id, pr]))
    const treesById = new Map(repo.worktrees.map((tree) => [tree.id, tree]))
    const representedPrIds = new Set<string>()
    const publishedBases = new Map<string, InventoryRef[]>()
    const readyByPr = new Map<string, boolean | null>()
    let openPullRequestCount = 0
    for (const ref of repo.refs) {
      if (ref.kind !== 'remote' || !ref.remoteId || !ref.remoteName) continue
      const prefix = `refs/remotes/${ref.remoteName}/`
      if (!ref.name.startsWith(prefix)) continue
      const key = JSON.stringify([ref.remoteId, ref.name.slice(prefix.length)])
      const matches = publishedBases.get(key) ?? []
      matches.push(ref)
      publishedBases.set(key, matches)
    }
    for (const pr of repo.pullRequests) {
      if (pr.facts.state === 'OPEN') openPullRequestCount += 1
      const ready = publishedReady(pr.facts, remoteKnown)
      readyByPr.set(pr.id, ready)
      const previous = globalReady.get(pr.id)
      globalReady.set(pr.id, previous === undefined ? ready : previous === ready ? ready : null)
    }
    const publishedParent = (
      pr: RepositoryInventory['pullRequests'][number],
      remoteName?: string | null,
    ) => {
      if (pr.facts.stack && pr.facts.stack.base !== pr.facts.base)
        return { parentId: null, parentIssue: 'Native base and published PR base disagree' }
      const candidates = publishedBases.get(JSON.stringify([pr.remoteId, pr.facts.base])) ?? []
      const namespace =
        remoteName ??
        repo.remotes?.find(
          (remote) => remote.name === 'origin' && remote.identity?.id === pr.remoteId,
        )?.name
      const matches = namespace
        ? candidates.filter((ref) => ref.remoteName === namespace)
        : candidates
      return matches.length === 1
        ? { parentId: matches[0].id, parentIssue: undefined }
        : {
            parentId: null,
            parentIssue: matches.length
              ? 'Ambiguous published base namespace'
              : `Published base ${pr.facts.base} outside observed qualified refs`,
          }
    }
    for (const ref of repo.refs) {
      const branch = byRef.get(ref.name)
      const prs = ref.pullRequestIds.flatMap((id) => {
        const pr = prsById.get(id)
        return pr ? [pr] : []
      })
      const pr = prs.length === 1 ? prs[0] : null
      const trees = ref.worktreeIds.flatMap((id) => {
        const tree = treesById.get(id)
        return tree ? [tree] : []
      })
      let parentId: string | null = null
      let parentIssue: string | undefined
      let provenance = branch?.parentSource ? parentSources[branch.parentSource] : undefined
      if (
        pr &&
        (branch?.parentSource === 'stack' || branch?.parentSource === 'pullRequest' || !branch)
      ) {
        ;({ parentId, parentIssue } = publishedParent(pr, ref.remoteName))
        provenance = 'Published PR head/base; native membership shown independently'
      } else if (branch?.parent) {
        if (branch.parentRef) {
          parentId = byName.get(branch.parentRef)?.id ?? null
          if (!parentId) parentIssue = 'Main-resolved parent outside observed inventory'
        } else if (branch.parentRef === null)
          parentIssue = 'Main could not resolve the parent endpoint'
        else parentIssue = 'Qualified parent endpoint unavailable'
      } else if (!detail || !branch) parentIssue = 'Dependency evidence not loaded'
      else if (detail.limits.branchesSkipped && !branch.parentSource)
        parentIssue = 'Ancestry analysis incomplete at the snapshot budget'
      branches.push({
        id: ref.id,
        repositoryId: id,
        ref: ref.name.replace(/^refs\/(heads|remotes)\//, ''),
        title: pr?.facts.title ?? branch?.subject ?? ref.name,
        parentId,
        parentIssue,
        recordedParent: branch?.recordedParent,
        refKind: ref.kind,
        worktreesKnown: directoriesKnown,
        bulkEligible:
          repo.refsRead.state === 'complete' &&
          (ref.kind === 'remote'
            ? Boolean(detail)
            : ref.kind === 'local' &&
              directoriesKnown &&
              trees.every(
                (tree) =>
                  tree.read.state === 'complete' &&
                  tree.status === 'clean' &&
                  !tree.missing &&
                  !tree.locked &&
                  !tree.operation,
              )),
        trunk: Boolean(
          detail &&
            (ref.name === `refs/heads/${detail.defaultBranch}` ||
              (ref.kind === 'remote' &&
                ref.remoteId === repo.remote?.id &&
                ref.name === `refs/remotes/${ref.remoteName}/${detail.defaultBranch}`)),
        ),
        worktrees: trees.map((tree) => ({
          id: tree.id,
          name: tree.path.split(/[\\/]/).pop() ?? tree.path,
          path: tree.path,
          status: {
            label: tree.missing
              ? 'Directory missing'
              : tree.read.state === 'partial'
                ? `${tree.status} · partial`
                : tree.status,
            tone:
              tree.status === 'conflicted'
                ? 'error'
                : tree.status === 'dirty'
                  ? 'warning'
                  : 'neutral',
          },
          changedFiles: changedCount(tree),
        })),
        local: {
          label:
            ref.kind === 'remote'
              ? 'Remote ref'
              : ref.upstream
                ? 'Local / tracking'
                : 'Local / no tracking upstream',
        },
        unpushed: ref.ahead,
        commits: null,
        attention:
          trees.some((tree) => tree.status === 'conflicted' || tree.operation) ||
          pr?.facts.checks === 'failing' ||
          pr?.facts.reviewDecision === 'CHANGES_REQUESTED',
        needsRestack: ref.needsRestack ?? branch?.needsRestack ?? false,
        conflicted:
          !directoriesKnown || trees.some((tree) => tree.status === 'unknown')
            ? null
            : trees.some((tree) => tree.status === 'conflicted'),
        readyToMerge: pr ? (readyByPr.get(pr.id) ?? null) : null,
        pullRequest:
          prs.length > 1
            ? undefined
            : pr
              ? prFacts(pr.facts, pr.id)
              : remoteKnown && repo.refsRead.state === 'complete'
                ? null
                : undefined,
        notice:
          prs.length > 1
            ? {
                title: 'Multiple PR associations',
                body: 'Select the exact source-qualified PR in Pull requests.',
                tone: 'warning',
              }
            : provenance
              ? {
                  title: `Parent evidence: ${provenance}`,
                  body: `Observed parent: ${branch?.parent ?? pr?.facts.base ?? 'none'}. Tracking upstream is not parentage; a published base is not proof of local Git ancestry.`,
                  tone: 'neutral',
                }
              : undefined,
      })
      if (pr) representedPrIds.add(pr.id)
    }
    for (const pr of repo.pullRequests) {
      if (representedPrIds.has(pr.id)) continue
      branches.push({
        id: JSON.stringify(['published-pr', id, pr.id]),
        repositoryId: id,
        ref: pr.headRef,
        title: pr.facts.title,
        ...publishedParent(pr),
        trunk: false,
        worktrees: [],
        worktreesKnown: directoriesKnown && repo.refsRead.state === 'complete',
        local: { label: 'Published PR; no observed local ref association' },
        unpushed: null,
        commits: null,
        attention: pr.facts.checks === 'failing' || pr.facts.reviewDecision === 'CHANGES_REQUESTED',
        needsRestack: false,
        conflicted: null,
        readyToMerge: readyByPr.get(pr.id) ?? null,
        pullRequest: prFacts(pr.facts, pr.id),
        notice: {
          title: 'Published relationship',
          body: 'The base is source-qualified provider data, not asserted local ancestry.',
          tone: 'neutral',
        },
      })
    }
    for (const tree of repo.worktrees) {
      if (!tree.detached && tree.kind !== 'bare' && tree.refId && refIds.has(tree.refId)) continue
      branches.push({
        id: tree.id,
        repositoryId: id,
        ref: tree.detached
          ? `Detached HEAD ${tree.headOid?.slice(0, 10) ?? 'unknown'}`
          : tree.kind === 'bare'
            ? 'Bare repository'
            : 'Worktree · branch ref unavailable',
        title: tree.path,
        parentId: null,
        trunk: false,
        worktreesKnown: true,
        worktrees:
          tree.kind === 'bare'
            ? []
            : [
                {
                  id: tree.id,
                  name: tree.path.split(/[\\/]/).pop() ?? tree.path,
                  path: tree.path,
                  status: { label: tree.missing ? 'Directory missing' : tree.status },
                  changedFiles: changedCount(tree),
                },
              ],
        local: {
          label: tree.detached
            ? 'Detached HEAD, not a branch'
            : tree.kind === 'bare'
              ? 'No working directory'
              : 'Unborn or unresolved branch ref',
        },
        unpushed: null,
        commits: null,
        attention: Boolean(tree.operation),
        needsRestack: false,
        conflicted: tree.status === 'unknown' ? null : tree.status === 'conflicted',
        readyToMerge: null,
        pullRequest: null,
      })
    }
    const rows = branches.slice(start)
    const name =
      repo.remote?.fullName.split('/').pop() ??
      repo.registeredPaths[0]?.split(/[\\/]/).pop() ??
      'Repository'
    const attentionCount =
      remoteKnown &&
      directoriesKnown &&
      repo.worktrees.every((tree) => tree.kind === 'bare' || tree.read.state === 'complete')
        ? rows.filter((row) => row.attention).length
        : null
    if (globalAttention !== null)
      globalAttention = attentionCount === null ? null : globalAttention + attentionCount
    if (!remoteKnown) readyComplete = false
    const readinessKnown = remoteKnown && [...readyByPr.values()].every((ready) => ready !== null)
    return {
      id,
      name,
      path: repo.registeredPaths[0],
      owner: repo.remote?.fullName.split('/')[0] ?? 'Local',
      mark: name.slice(0, 2).toUpperCase(),
      branchCount: repo.refsRead.state === 'complete' ? repo.refs.length : null,
      worktreeCount: directoriesKnown
        ? repo.worktrees.filter((tree) => tree.kind !== 'bare').length
        : null,
      pullRequestCount: remoteKnown ? openPullRequestCount : null,
      attentionCount,
      unpublishedCount:
        repo.refsRead.state === 'complete' &&
        repo.refs.filter((ref) => ref.kind === 'local').every((ref) => ref.ahead !== null)
          ? rows.filter((row) => row.refKind === 'local' && (row.unpushed ?? 0) > 0).length
          : null,
      readyBranchCount: readinessKnown
        ? rows.filter((row) => row.readyToMerge === true).length
        : null,
      readyToMergeCount: readinessKnown
        ? [...readyByPr.values()].filter((ready) => ready === true).length
        : null,
    }
  })
  return {
    repositories,
    branches,
    globalCounts: {
      attention: globalAttention,
      readyToMerge:
        readyComplete && [...globalReady.values()].every((ready) => ready !== null)
          ? [...globalReady.values()].filter((ready) => ready === true).length
          : null,
    },
    localFreshness: inventory ? `Local inventory ${inventory.state}` : 'Loading local inventory',
    remoteFreshness: 'GitHub freshness is repository-specific',
    notice: inventory?.failures.map((failure) => failure.error).join(' · ') || undefined,
  }
}
