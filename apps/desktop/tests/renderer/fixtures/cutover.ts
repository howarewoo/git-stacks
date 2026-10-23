import type { Branch, PullRequest, RepositorySnapshot } from '@git-stacks/shared/types'
import type { WorktreeInventory, InventoryWorktree } from '@git-stacks/shared/worktree-inventory'
import type { BranchWorkbenchSnapshot } from '../../../src/renderer/src/components/branch-workbench-model'
import { baseSnapshot } from '../../fixtures/workflow-scenarios'
import { workbenchV5Fixture } from './workbench-v5'
import { graphIndex, graphSnapshot, type GraphSize } from './graph'
import { snapshotInventory } from './inventory'
import type { FixtureScenario } from './types'
import { changedFile, fileViewFixtures, largeDiffText } from './data'

const observedAt = '2026-09-25T12:00:00.000Z'
const read = { state: 'complete' as const, observedAt, error: null }
const oid = (index: number) => index.toString(16).padStart(40, '0')

/** Approved source facts enter the same typed inventory/detail dispatcher as native reads. */
export function presentationScenario(source: BranchWorkbenchSnapshot): FixtureScenario {
  const snapshotsByPath: Record<string, RepositorySnapshot> = {}
  const inventory: WorktreeInventory = {
    generation: 1,
    state: 'complete',
    failures: [],
    repositories: [],
  }
  for (const repository of source.repositories) {
    const path = repository.path ?? `/Users/woo/Code/${repository.name}`
    const rows = source.branches.filter((branch) => branch.repositoryId === repository.id)
    const branches: Branch[] = rows.map((row, index) => {
      const parent = rows.find((candidate) => candidate.id === row.parentId)
      const pr: PullRequest | null = row.pullRequest
        ? {
            number: row.pullRequest.number,
            title: row.title,
            url: `https://github.com/${repository.owner}/${repository.name}/pull/${row.pullRequest.number}`,
            head: row.ref,
            base: parent?.ref ?? 'main',
            state:
              row.pullRequest.state === 'merged'
                ? 'MERGED'
                : row.pullRequest.state === 'closed'
                  ? 'CLOSED'
                  : 'OPEN',
            draft: row.pullRequest.draft,
            checks:
              row.pullRequest.checks.tone === 'error'
                ? 'failing'
                : row.pullRequest.checks.tone === 'success'
                  ? 'passing'
                  : 'pending',
            metadata: row.pullRequest.checks.label === 'Unavailable' ? 'degraded' : 'full',
            headOid: oid(index + 1),
            headRepository: `${repository.owner}/${repository.name}`,
            author: row.pullRequest.author ?? undefined,
            reviewDecision:
              row.pullRequest.review.label === 'Approved'
                ? 'APPROVED'
                : row.pullRequest.review.label === 'Changes requested'
                  ? 'CHANGES_REQUESTED'
                  : undefined,
            reviewRequested:
              row.pullRequest.review.label === 'Review requested' ? ['howarewoo'] : [],
            reviewRequestsComplete: true,
            mergeState: row.readyToMerge ? 'CLEAN' : undefined,
          }
        : null
      return {
        ref: `refs/heads/${row.ref}`,
        name: row.ref,
        current: row.trunk,
        remote: false,
        oid: oid(index + 1),
        upstream: null,
        upstreamRef: null,
        ahead: row.unpushed ?? 0,
        behind: 0,
        subject: row.title,
        updatedAt: observedAt,
        parent: parent?.ref ?? null,
        parentRef: parent ? `refs/heads/${parent.ref}` : null,
        parentSource: parent ? 'recorded' : null,
        recordedParent: parent?.ref ?? null,
        parentBehind: row.needsRestack ? 1 : 0,
        needsRestack: row.needsRestack,
        pr,
      }
    })
    const snapshot: RepositorySnapshot = {
      ...baseSnapshot,
      path,
      name: repository.name,
      currentBranch: 'main',
      defaultBranch: 'main',
      headOid: branches.find((branch) => branch.current)?.oid ?? null,
      remoteUrl: `https://github.com/${repository.owner}/${repository.name}.git`,
      branches,
      files: [],
      stashes: [],
      pullRequests: branches.flatMap((branch) => (branch.pr ? [branch.pr] : [])),
      remote: {
        state: 'fresh',
        fetchedAt: observedAt,
        checkedAt: observedAt,
        detail: null,
        rateLimitReset: null,
        pendingMutations: [],
      },
    }
    snapshotsByPath[path] = snapshot
    const repo = snapshotInventory([snapshot]).repositories[0]
    const remoteId = repo.remote!.id
    repo.identity.id = repository.id
    repo.refs = branches.map((branch, index) => ({
      id: rows[index].id,
      repositoryId: repository.id,
      name: branch.ref,
      kind: 'local',
      oid: branch.oid!,
      upstream: null,
      ahead: rows[index].unpushed,
      behind: branch.behind,
      worktreeIds: rows[index].worktrees.map((tree) => tree.id),
      pullRequestIds: branch.pr ? [JSON.stringify([remoteId, 'pr', String(branch.pr.number)])] : [],
      needsRestack: branch.needsRestack,
    }))
    repo.worktrees = rows.flatMap((row, index) =>
      row.worktrees.map(
        (tree): InventoryWorktree => ({
          id: tree.id,
          repositoryId: repository.id,
          path: tree.path,
          gitDirectory: row.trunk ? `${path}/.git` : `${path}/.git/worktrees/${index}`,
          kind: row.trunk ? 'primary' : 'linked',
          headOid: oid(index + 1),
          refId: row.id,
          detached: false,
          missing: false,
          prunable: null,
          locked: null,
          status:
            tree.changedFiles === null
              ? 'unknown'
              : row.conflicted
                ? 'conflicted'
                : tree.changedFiles
                  ? 'dirty'
                  : 'clean',
          counts:
            tree.changedFiles === null
              ? null
              : {
                  staged: 0,
                  unstaged: tree.changedFiles,
                  untracked: 0,
                  renamed: 0,
                  conflicted: row.conflicted ? tree.changedFiles : 0,
                },
          operation: null,
          indexSignature: `fixture-index-${index}`,
          read:
            tree.changedFiles === null
              ? { state: 'failed', observedAt: null, error: 'Fixture status unavailable' }
              : read,
        }),
      ),
    )
    repo.pullRequests = repo.pullRequests.map((pr) => ({
      ...pr,
      refIds: repo.refs.filter((ref) => ref.pullRequestIds.includes(pr.id)).map((ref) => ref.id),
    }))
    repo.dependenciesRead = read
    repo.dependencies = branches.map(
      ({ ref, parent, parentRef, parentSource, recordedParent }) => ({
        ref,
        parent,
        parentRef,
        parentSource,
        recordedParent,
      }),
    )
    repo.dependencyDefaultBranch = snapshot.defaultBranch
    inventory.repositories.push(repo)
  }
  return {
    name: 'cutover-reference',
    summary:
      'Immutable v5 source facts through the real production App/inventory/inspection dispatcher; no demo state engine.',
    snapshot: Object.values(snapshotsByPath)[0],
    snapshotsByPath,
    inventory,
    recentRepositories: Object.values(snapshotsByPath).map(({ path, name }) => ({ path, name })),
  }
}

export const cutoverReference = presentationScenario(workbenchV5Fixture())

/** Large branch/PR domain, 120 distinct concurrent directory contexts, independent clone. */
export function cutoverScale(size: GraphSize): FixtureScenario {
  const index = graphIndex(size)
  const primary = graphSnapshot(baseSnapshot, index)
  primary.branches = [
    primary.branches[0],
    ...index.pullRequests
      .filter((pr) => pr.number !== size && pr.headRepository === index.fullName)
      .map((pr) => ({
        ...primary.branches[1],
        current: pr.number === 1,
        ref: `refs/heads/${pr.head}`,
        name: pr.head,
        oid: pr.headOid ?? undefined,
        parent: pr.base,
        parentRef: `refs/heads/${pr.base}`,
        recordedParent: pr.base,
        parentSource: 'recorded' as const,
        pr,
      })),
    ...primary.branches.slice(-2),
  ]
  const clone = {
    ...primary,
    path: '/fixtures/independent clone 雪',
    name: 'independent-clone',
    branches: primary.branches.slice(0, 4),
    pullRequests: primary.pullRequests.slice(0, 3),
  }
  const snapshots = [primary, clone]
  const inventory = snapshotInventory(snapshots)
  const repo = inventory.repositories[0]
  const tree = repo.worktrees[0]
  repo.worktrees = Array.from({ length: 120 }, (_, position) => {
    const ref = position === 119 ? null : repo.refs[position + 1]
    return {
      ...tree,
      id: JSON.stringify([repo.identity.id, 'worktree', `admin-${position}`]),
      path:
        position === 0
          ? primary.path
          : `${primary.path}/linked contexts/${'long-directory/'.repeat(position % 4)}topic ${position} 雪`,
      gitDirectory:
        position === 0
          ? `${primary.path}/.git`
          : `${primary.path}/.git/worktrees/admin-${position}`,
      kind: position === 0 ? ('primary' as const) : ('linked' as const),
      refId: ref?.id ?? null,
      headOid: ref?.oid ?? tree.headOid,
      detached: position === 119,
      status:
        position % 17 === 0
          ? ('dirty' as const)
          : position % 31 === 0
            ? ('unknown' as const)
            : ('clean' as const),
      counts:
        position % 31 === 0
          ? null
          : {
              staged: 0,
              unstaged: position % 17 === 0 ? 1 : 0,
              untracked: 0,
              renamed: 0,
              conflicted: 0,
            },
      read:
        position % 31 === 0
          ? { state: 'failed' as const, observedAt: null, error: 'External status unavailable' }
          : read,
    }
  })
  for (const ref of repo.refs)
    ref.worktreeIds = repo.worktrees
      .filter((worktree) => worktree.refId === ref.id)
      .map((worktree) => worktree.id)
  // The PR-only tip's published base needs an observed remote facet, not a
  // display-name match against a local branch.
  const publishedOnly = repo.pullRequests.find((pr) => pr.refIds.length === 0)!
  const baseRef = repo.refs.find(
    (ref) => ref.kind === 'local' && ref.name === `refs/heads/${publishedOnly.facts.base}`,
  )!
  const publishedBaseName = `refs/remotes/origin/${publishedOnly.facts.base}`
  const publishedBaseId = JSON.stringify([repo.identity.id, 'ref', publishedBaseName])
  baseRef.upstream = publishedBaseId
  repo.refs.push({
    ...baseRef,
    id: publishedBaseId,
    name: publishedBaseName,
    kind: 'remote',
    remoteName: 'origin',
    remoteId: repo.remote!.id,
    upstream: null,
    worktreeIds: [],
  })
  for (const [index, repository] of inventory.repositories.entries()) {
    repository.dependenciesRead = read
    repository.dependencies = snapshots[index].branches.map(
      ({ ref, parent, parentRef, parentSource, recordedParent }) => ({
        ref,
        parent,
        parentRef,
        parentSource,
        recordedParent,
      }),
    )
    repository.dependencyDefaultBranch = snapshots[index].defaultBranch
  }
  return {
    name: `cutover-${size}`,
    summary: `Deterministic ${size} PR/ref objects, deep and wide forks, no-directory and remote-only refs, 120 distinct worktrees and independent clone.`,
    snapshot: primary,
    snapshotsByPath: { [primary.path]: primary, [clone.path]: clone },
    inventory,
    prIndex: index,
    recentRepositories: [primary, clone].map(({ path, name }) => ({ path, name })),
  }
}

/** Per-directory dual edits, rename preimage and Unicode untracked bytes through real inspector. */
export function cutoverInspection(): FixtureScenario {
  const scenario = structuredClone(cutoverReference)
  const repository = scenario.inventory!.repositories[0]
  const ref = repository.refs.find((ref) => ref.name === 'refs/heads/feat/repository-history')!
  const tree = repository.worktrees.find((tree) => tree.refId === ref.id)!
  const files = [
    changedFile('src/dual.ts', 'M', 'M'),
    changedFile('src/new Ω.ts', '?', '?'),
    changedFile('src/new name.ts', 'R', ' ', { originalPath: 'src/old name.ts' }),
    changedFile('src/generated.ts', 'M', ' '),
  ]
  tree.status = 'dirty'
  tree.counts = { staged: 3, unstaged: 1, untracked: 1, renamed: 1, conflicted: 0 }
  const snapshotsByPath = {
    ...scenario.snapshotsByPath,
    [tree.path]: {
      ...scenario.snapshotsByPath![repository.registeredPaths[0]],
      path: tree.path,
      currentBranch: 'feat/repository-history',
      headOid: tree.headOid,
      files,
    },
  }
  const fileViews = {
    'src/dual.ts': { ...fileViewFixtures.bothSides, path: 'src/dual.ts' },
    'src/new Ω.ts': {
      ...fileViewFixtures.rename,
      path: 'src/new Ω.ts',
      content: 'original Unicode bytes Ω\n',
      fingerprint: 'cutover-untracked',
    },
    'src/new name.ts': { ...fileViewFixtures.rename, path: 'src/new name.ts' },
    'src/generated.ts': {
      ...fileViewFixtures.bothSides,
      path: 'src/generated.ts',
      stagedDiff: largeDiffText,
      unstagedDiff: '',
      fingerprint: 'cutover-generated',
    },
  }
  return { ...scenario, name: 'cutover-inspection', snapshotsByPath, fileViews }
}
