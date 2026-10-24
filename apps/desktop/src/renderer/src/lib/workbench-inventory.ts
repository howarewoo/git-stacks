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
    const providerReason = !repo.remote
      ? repo.remotes?.length
        ? 'Configured remote has no supported pull request provider'
        : 'No remote configured'
      : undefined
    const pullRequestIssue = providerReason
      ? `PR N/A: ${providerReason}`
      : !remoteKnown
        ? `PR ${repo.remoteFreshness?.state ?? 'unavailable'}: ${repo.remoteFreshness?.detail ?? 'Provider metadata not loaded'}`
        : undefined
    const detailByRef = new Map(detail?.branches.map((branch) => [branch.ref, branch]) ?? [])
    // Dependency facts travel with their own inventory observation. Retained inspector
    // detail can supply a subject, but never an old parent/no-parent decision.
    const byRef = repo.dependencies
      ? new Map(
          repo.dependencies.map((branch) => [
            branch.ref,
            { ...detailByRef.get(branch.ref), ...branch },
          ]),
        )
      : repo.dependenciesRead
        ? new Map<string, Partial<RepositorySnapshot['branches'][number]>>()
        : detailByRef
    const defaultBranch = repo.dependenciesRead
      ? repo.dependencyDefaultBranch
      : detail?.defaultBranch
    const dependencyIncomplete = repo.dependenciesRead
      ? repo.dependenciesRead.state !== 'complete'
      : detail?.limits.branchesSkipped
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
    const publishedParent = (pr: RepositoryInventory['pullRequests'][number]) => {
      if (pr.facts.stack && pr.facts.stack.base !== pr.facts.base)
        return { parentId: null, parentIssue: 'Native base and published PR base disagree' }
      const candidates = publishedBases.get(JSON.stringify([pr.remoteId, pr.facts.base])) ?? []
      const matchingRemotes =
        repo.remotes?.filter((remote) => remote.identity?.id === pr.remoteId) ?? []
      const baseRemote =
        matchingRemotes.length === 1
          ? matchingRemotes[0].name
          : matchingRemotes.some((r) => r.name === 'origin')
            ? 'origin'
            : undefined
      const matches =
        candidates.length === 1
          ? candidates
          : baseRemote
            ? candidates.filter((ref) => ref.remoteName === baseRemote)
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
    const byId = new Map(repo.refs.map((ref) => [ref.id, ref]))
    const locals = repo.refs.filter((ref) => ref.kind === 'local')
    const remotes = repo.refs.filter((ref) => ref.kind === 'remote')

    // Remotes represented as the configured tracking upstream of a local branch
    const representedRemoteIds = new Set<string>()
    for (const local of locals) {
      if (local.upstream && byId.has(local.upstream)) {
        const tracking = byId.get(local.upstream)!
        if (tracking.kind === 'remote') {
          representedRemoteIds.add(tracking.id)
        }
      }
    }

    const repoBranchRows: WorkbenchBranch[] = []
    const refToRowId = new Map<string, string>()

    for (const local of locals) {
      const branch = byRef.get(local.name)
      const tracking =
        local.upstream && byId.has(local.upstream) && byId.get(local.upstream)!.kind === 'remote'
          ? byId.get(local.upstream)!
          : null
      const prIds = [...new Set([...local.pullRequestIds, ...(tracking?.pullRequestIds ?? [])])]
      const prs = prIds.flatMap((id) => {
        const pr = prsById.get(id)
        return pr ? [pr] : []
      })
      const pr = prs.length === 1 ? prs[0] : null
      const trees = local.worktreeIds.flatMap((id) => {
        const tree = treesById.get(id)
        return tree ? [tree] : []
      })
      let parentId: string | null = null
      let parentIssue: string | undefined
      let provenance = branch?.parentSource ? parentSources[branch.parentSource] : undefined
      const isTrunk = Boolean(defaultBranch && local.name === `refs/heads/${defaultBranch}`)
      let dependencyParentRefId: string | null = null
      let dependencyParentOid: string | null = null
      let dependencyParentIssue: string | undefined
      if (isTrunk) {
        // Trunk has no parent
      } else if (!branch) {
        dependencyParentIssue = 'Dependency evidence not loaded'
      } else if (branch.parent) {
        if (branch.parentRef) {
          const pRef = byName.get(branch.parentRef)
          if (pRef) {
            dependencyParentRefId = pRef.id
            dependencyParentOid = pRef.oid
          } else {
            dependencyParentIssue = 'Main-resolved parent outside observed inventory'
          }
        } else if (branch.parentRef === null) {
          dependencyParentIssue = 'Main could not resolve the parent endpoint'
        } else {
          dependencyParentIssue = 'Qualified parent endpoint unavailable'
        }
      } else if (dependencyIncomplete) {
        dependencyParentIssue = 'Ancestry analysis incomplete at the snapshot budget'
      }
      if (
        pr &&
        (branch?.parentSource === 'stack' || branch?.parentSource === 'pullRequest' || !branch)
      ) {
        ;({ parentId, parentIssue } = publishedParent(pr))
        provenance = 'Published PR head/base; native membership shown independently'
      } else if (branch?.parent) {
        if (branch.parentRef) {
          parentId = byName.get(branch.parentRef)?.id ?? null
          if (!parentId) parentIssue = 'Main-resolved parent outside observed inventory'
        } else if (branch.parentRef === null)
          parentIssue = 'Main could not resolve the parent endpoint'
        else parentIssue = 'Qualified parent endpoint unavailable'
      } else if (!branch) parentIssue = 'Dependency evidence not loaded'
      else if (dependencyIncomplete && !branch.parentSource)
        parentIssue = 'Ancestry analysis incomplete at the snapshot budget'
      const parentRef = parentId ? byId.get(parentId) : null
      const parentOid = parentRef?.oid ?? null

      let localLabel: string
      let localTone: WorkbenchFact['tone']
      if (tracking) {
        if (
          local.oid === tracking.oid &&
          local.ahead === 0 &&
          (local.behind === 0 || local.behind === null)
        ) {
          localLabel = 'Local / in sync with tracking'
        } else if ((local.ahead ?? 0) > 0 && (local.behind ?? 0) > 0) {
          localLabel = `Local / diverged (↑ ${local.ahead} · ↓ ${local.behind})`
          localTone = 'warning'
        } else if ((local.ahead ?? 0) > 0) {
          localLabel = `Local / ↑ ${local.ahead} unpushed`
        } else if ((local.behind ?? 0) > 0) {
          localLabel = `Local / ↓ ${local.behind} behind upstream`
          localTone = 'info'
        } else if (local.ahead === null && local.behind === null) {
          localLabel = 'Local / tracking comparison unavailable'
        } else {
          localLabel = 'Local / tracking'
        }
      } else if (local.upstream) {
        localLabel = 'Local / tracking upstream not observed'
        localTone = 'neutral'
      } else {
        localLabel = 'Local / no tracking upstream'
      }

      const row: WorkbenchBranch = {
        id: local.id,
        repositoryId: id,
        ref: local.name.replace(/^refs\/heads\//, ''),
        title: pr?.facts.title ?? branch?.subject ?? local.name.replace(/^refs\/heads\//, ''),
        parentId,
        parentIssue,
        recordedParent: branch?.recordedParent,
        parentRefId: parentId,
        parentOid,
        dependencyParentRefId,
        dependencyParentOid,
        dependencyParentIssue,
        refKind: 'local',
        localRef: { id: local.id, name: local.name, oid: local.oid },
        remoteRef: tracking
          ? {
              id: tracking.id,
              name: tracking.name,
              oid: tracking.oid,
              remoteId: tracking.remoteId ?? null,
              remoteName: tracking.remoteName ?? null,
            }
          : null,
        configuredUpstream: local.upstream ?? null,
        worktreesKnown: directoriesKnown,
        bulkEligible:
          repo.refsRead.state === 'complete' &&
          directoriesKnown &&
          trees.every(
            (tree) =>
              tree.read.state === 'complete' &&
              tree.status === 'clean' &&
              !tree.missing &&
              !tree.locked &&
              !tree.operation,
          ),
        trunk: isTrunk,
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
          label: localLabel,
          tone: localTone,
        },
        unpushed: local.ahead,
        behind: local.behind,
        commits: null,
        commitsIssue: isTrunk ? 'na' : undefined,
        attention:
          trees.some((tree) => tree.status === 'conflicted' || tree.operation) ||
          pr?.facts.checks === 'failing' ||
          pr?.facts.reviewDecision === 'CHANGES_REQUESTED',
        needsRestack: local.needsRestack ?? branch?.needsRestack ?? false,
        conflicted:
          !directoriesKnown || trees.some((tree) => tree.status === 'unknown')
            ? null
            : trees.some((tree) => tree.status === 'conflicted'),
        readyToMerge: pr ? (readyByPr.get(pr.id) ?? null) : null,
        pullRequestIssue,
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
              : local.upstream && !tracking
                ? {
                    title: 'Tracking upstream unavailable',
                    body: 'Configured tracking ref is not present in observed remote refs.',
                    tone: 'neutral',
                  }
                : undefined,
      }
      repoBranchRows.push(row)
      if (pr) representedPrIds.add(pr.id)
      refToRowId.set(local.id, row.id)
      if (tracking) {
        if (!refToRowId.has(tracking.id)) {
          refToRowId.set(tracking.id, row.id)
        } else {
          refToRowId.set(tracking.id, '')
        }
      }
    }

    for (const ref of remotes) {
      if (representedRemoteIds.has(ref.id)) continue
      const branch = byRef.get(ref.name)
      const prs = ref.pullRequestIds.flatMap((id) => {
        const pr = prsById.get(id)
        return pr ? [pr] : []
      })
      const pr = prs.length === 1 ? prs[0] : null
      let parentId: string | null = null
      let parentIssue: string | undefined
      let provenance = branch?.parentSource ? parentSources[branch.parentSource] : undefined
      let dependencyParentRefId: string | null = null
      let dependencyParentOid: string | null = null
      if (branch?.parentRef) {
        const pRef = byName.get(branch.parentRef)
        dependencyParentRefId = pRef?.id ?? null
        dependencyParentOid = pRef?.oid ?? null
      }
      if (
        pr &&
        (branch?.parentSource === 'stack' || branch?.parentSource === 'pullRequest' || !branch)
      ) {
        ;({ parentId, parentIssue } = publishedParent(pr))
        provenance = 'Published PR head/base; native membership shown independently'
      } else if (branch?.parent) {
        if (branch.parentRef) {
          parentId = byName.get(branch.parentRef)?.id ?? null
          if (!parentId) parentIssue = 'Main-resolved parent outside observed inventory'
        } else if (branch.parentRef === null)
          parentIssue = 'Main could not resolve the parent endpoint'
        else parentIssue = 'Qualified parent endpoint unavailable'
      } else if (!branch) parentIssue = 'Dependency evidence not loaded'
      else if (dependencyIncomplete && !branch.parentSource)
        parentIssue = 'Ancestry analysis incomplete at the snapshot budget'

      const parentRef = parentId ? byId.get(parentId) : null
      const parentOid = parentRef?.oid ?? null
      const isTrunk = Boolean(
        defaultBranch &&
          ref.remoteId === repo.remote?.id &&
          ref.name === `refs/remotes/${ref.remoteName}/${defaultBranch}`,
      )

      const row: WorkbenchBranch = {
        id: ref.id,
        repositoryId: id,
        ref: ref.name.replace(/^refs\/remotes\//, ''),
        title: pr?.facts.title ?? branch?.subject ?? ref.name.replace(/^refs\/remotes\//, ''),
        parentId,
        parentIssue,
        recordedParent: branch?.recordedParent,
        parentRefId: parentId,
        parentOid,
        dependencyParentRefId,
        dependencyParentOid,
        dependencyParentIssue:
          repo.dependenciesRead?.state !== 'complete'
            ? (repo.dependenciesRead?.error ?? 'Dependency evidence not loaded')
            : !branch
              ? 'Dependency evidence not loaded'
              : branch.parent && !dependencyParentRefId
                ? 'Main could not resolve the parent endpoint'
                : dependencyIncomplete && !branch.parentSource
                  ? 'Ancestry analysis incomplete at the snapshot budget'
                  : undefined,
        refKind: 'remote',
        localRef: null,
        remoteRef: {
          id: ref.id,
          name: ref.name,
          oid: ref.oid,
          remoteId: ref.remoteId ?? null,
          remoteName: ref.remoteName ?? null,
        },
        worktreesKnown: directoriesKnown,
        bulkEligible: repo.refsRead.state === 'complete' && Boolean(detail),
        trunk: isTrunk,
        worktrees: [],
        local: {
          label: 'Remote ref',
        },
        unpushed: null,
        behind: null,
        commits: null,
        commitsIssue: isTrunk ? 'na' : undefined,
        attention:
          pr?.facts.checks === 'failing' || pr?.facts.reviewDecision === 'CHANGES_REQUESTED',
        needsRestack: false,
        conflicted: null,
        readyToMerge: pr ? (readyByPr.get(pr.id) ?? null) : null,
        pullRequestIssue,
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
      }
      repoBranchRows.push(row)
      if (pr) representedPrIds.add(pr.id)
      refToRowId.set(ref.id, row.id)
    }

    branches.push(...repoBranchRows)
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
    for (const row of rows) {
      if (row.parentId) {
        const mapped = refToRowId.get(row.parentId)
        if (mapped) {
          row.parentId = mapped === row.id ? null : mapped
        } else if (mapped === '') {
          row.parentId = null
          row.parentIssue = 'Ambiguous parent endpoint namespace'
        }
      }
    }
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

    if (!remoteKnown) readyComplete = false
    const readinessKnown = remoteKnown && [...readyByPr.values()].every((ready) => ready !== null)
    return {
      id,
      name,
      path: repo.registeredPaths[0],
      owner: repo.remote?.fullName.split('/')[0] ?? 'Local',
      mark: name.slice(0, 2).toUpperCase(),
      branchCount: repo.refsRead.state === 'complete' ? repoBranchRows.length : null,
      worktreeCount: directoriesKnown
        ? repo.worktrees.filter((tree) => tree.kind !== 'bare').length
        : null,
      pullRequestCount: remoteKnown ? openPullRequestCount : null,
      attentionCount,
      unpublishedCount:
        repo.refsRead.state === 'complete' &&
        repo.refs.filter((ref) => ref.kind === 'local').every((ref) => ref.ahead !== null)
          ? repoBranchRows.filter((row) => row.localRef && (row.unpushed ?? 0) > 0).length
          : null,
      readyBranchCount: readinessKnown
        ? rows.filter((row) => row.readyToMerge === true).length
        : null,
      readyToMergeCount: readinessKnown
        ? [...readyByPr.values()].filter((ready) => ready === true).length
        : null,
      countProvenance: {
        branch: {
          state: repo.refsRead.state,
          reason: repo.refsRead.error ?? undefined,
        },
        worktree: {
          state: repo.discovery.state,
          reason: repo.discovery.error ?? undefined,
        },
        pullRequest: {
          state: repo.remote ? (repo.remoteFreshness?.state ?? 'unavailable') : 'na',
          reason: providerReason ?? repo.remoteFreshness?.detail ?? 'Provider metadata not loaded',
        },
        unpublished: {
          state:
            repo.refsRead.state === 'complete' &&
            repo.refs.filter((r) => r.kind === 'local').every((r) => r.ahead !== null)
              ? 'complete'
              : 'partial',
          reason: repo.refs.some((r) => r.kind === 'local' && r.ahead === null)
            ? 'Some local branches lack upstream tracking comparisons'
            : undefined,
        },
        ready: {
          state: providerReason
            ? 'na'
            : readinessKnown
              ? 'complete'
              : !remoteKnown
                ? (repo.remoteFreshness?.state ?? 'unavailable')
                : 'partial',
          reason:
            providerReason ??
            (!remoteKnown
              ? (repo.remoteFreshness?.detail ?? 'Provider metadata not loaded')
              : !readinessKnown
                ? 'Required pull request review, checks or merge evidence incomplete'
                : undefined),
        },
        attention: {
          state: attentionCount !== null ? 'complete' : 'partial',
          reason: !directoriesKnown
            ? 'Worktree discovery incomplete'
            : !remoteKnown
              ? 'Remote freshness incomplete'
              : undefined,
        },
      },
    }
  })
  return {
    repositories,
    branches,
    globalCounts: (() => {
      const attentionUnconfirmedRepos: string[] = []
      let sumConfirmedAttention: number | null = null
      for (const repo of repositories) {
        if (repo.attentionCount !== null) {
          sumConfirmedAttention = (sumConfirmedAttention ?? 0) + repo.attentionCount
        } else {
          attentionUnconfirmedRepos.push(repo.name)
        }
      }
      if (repositories.length === 0 && inventory?.state === 'complete') {
        sumConfirmedAttention = 0
      }
      return {
        attention: sumConfirmedAttention,
        readyToMerge:
          readyComplete && [...globalReady.values()].every((ready) => ready !== null)
            ? [...globalReady.values()].filter((ready) => ready === true).length
            : null,
        readyReason:
          repositories
            .filter((repo) => repo.countProvenance.ready.state !== 'complete')
            .map(
              (repo) =>
                `${repo.name}: ${repo.countProvenance.ready.state} — ${repo.countProvenance.ready.reason ?? 'Readiness unavailable'}`,
            )
            .join('; ') || undefined,
        attentionReason: attentionUnconfirmedRepos.length
          ? `Missing coverage for ${attentionUnconfirmedRepos.join(', ')}`
          : undefined,
        attentionMissingCoverage: attentionUnconfirmedRepos.length
          ? attentionUnconfirmedRepos
          : undefined,
      }
    })(),
    localFreshness: inventory ? `Local inventory ${inventory.state}` : 'Loading local inventory',
    remoteFreshness: 'GitHub freshness is repository-specific',
    notice: inventory?.failures.map((failure) => failure.error).join(' · ') || undefined,
  }
}
