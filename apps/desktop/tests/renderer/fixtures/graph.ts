import type { Branch, PullRequest, RepositorySnapshot } from '@git-stacks/shared/types'
import type { PullRequestIndex } from '@git-stacks/shared/pr-index'

/** Fixed source facts, not inferred stack partitions or application team records. */
export const GRAPH_SEED = 'graph-220-v1'
export const GRAPH_SIZES = [250, 1000, 5000] as const
export type GraphSize = (typeof GRAPH_SIZES)[number]
export type GraphChange = 'head' | 'base' | 'status'
const TIME = '2026-02-04T09:00:00.000Z'
export const GRAPH_REPOSITORY = 'fixture/graph-workbench'
export const GRAPH_AUTHORS = Array.from(
  { length: 50 },
  (_, i) => `author-${String(i + 1).padStart(2, '0')}`,
)
const head = (n: number): string => `graph/change-${n}`
const oid = (n: number): string => n.toString(16).padStart(40, '0')

export function graphRows(size: GraphSize): PullRequest[] {
  return Array.from({ length: size }, (_, i) => {
    const n = i + 1
    // 1..100: deep mixed-author chain. 101..180: wide intermediate fork.
    // 181..200: nested fork; remaining rows mix short chains and shared roots.
    const parent =
      n === 1 ? 0 : n <= 100 ? n - 1 : n <= 180 ? 40 : n <= 200 ? 120 : n % 10 === 1 ? 20 : n - 1
    return {
      number: n,
      title:
        n % 37 === 0
          ? `Change ${n}: preserve qualified repository and pull request identities across long mixed-author dependency paths and external retargets`
          : `Change ${n}`,
      url: `https://github.com/${GRAPH_REPOSITORY}/pull/${n}`,
      head: head(n),
      base: parent ? head(parent) : 'main',
      state: 'OPEN',
      draft: n % 7 === 0,
      checks: n % 11 === 0 ? 'failing' : n % 5 === 0 ? 'pending' : 'passing',
      headOid: oid(n),
      headRepository: GRAPH_REPOSITORY,
      author: GRAPH_AUTHORS[i % 50],
      reviewRequested: n % 3 === 0 ? ['author-01'] : [],
      reviewRequestsComplete: true,
      metadata: 'full',
      reviewDecision: n % 13 === 0 ? 'CHANGES_REQUESTED' : 'APPROVED',
    }
  })
}

export function graphIndex(
  size: GraphSize,
  state: PullRequestIndex['state'] = 'complete',
  degraded = false,
): PullRequestIndex {
  const rows = graphRows(size)
  return {
    fullName: GRAPH_REPOSITORY,
    repository: '/fixtures/graph-workbench',
    host: 'github.com',
    viewer: 'author-01',
    pullRequests: (state === 'partial' || state === 'error' ? rows.slice(0, 100) : rows).map(
      (row) =>
        degraded
          ? {
              ...row,
              metadata: 'degraded',
              checks: 'none',
              reviewDecision: undefined,
              reviewRequested: undefined,
              reviewRequestsComplete: false,
            }
          : row,
    ),
    state,
    complete: state === 'complete',
    fetchedAt: TIME,
    checkedAt: TIME,
    message:
      state === 'error'
        ? 'Page 2 failed; retained page 1 is incomplete.'
        : state === 'partial'
          ? 'Page 1 loaded; more pages remain.'
          : degraded
            ? 'Host review/check fields are unsupported; metadata is unknown.'
            : state === 'stale'
              ? 'Retained statuses have not been reconfirmed.'
              : null,
    pages: state === 'partial' || state === 'error' ? 1 : Math.ceil(size / 100),
  }
}

export function graphBranches(rows: PullRequest[]): Branch[] {
  const branch = (name: string, pr: PullRequest | null, remote = false): Branch => ({
    ref: remote ? `refs/remotes/origin/${name}` : `refs/heads/${name}`,
    name: remote ? `origin/${name}` : name,
    current: name === head(1),
    remote,
    upstream: null,
    upstreamRef: null,
    ahead: 0,
    behind: 0,
    subject: `Update ${name}`,
    updatedAt: TIME,
    parent: pr?.base ?? null,
    parentBehind: 0,
    parentSource: pr ? 'recorded' : null,
    recordedParent: pr?.base ?? null,
    pr,
    oid: pr?.headOid ?? oid(90001),
  })
  // Most PRs have no local checkout. A remote-tracking-only ref is distinct from a local-only ref.
  return [
    branch('main', null),
    ...rows.slice(0, 24).map((row) => branch(row.head, row)),
    branch('graph/local-only', null),
    branch('graph/remote-only', null, true),
  ]
}

export function graphSnapshot(
  base: RepositorySnapshot,
  index: PullRequestIndex,
): RepositorySnapshot {
  return {
    ...base,
    path: '/fixtures/graph-workbench',
    name: 'graph-workbench',
    remoteUrl: `https://github.com/${GRAPH_REPOSITORY}.git`,
    currentBranch: head(1),
    branches: graphBranches(index.pullRequests),
    pullRequests: index.pullRequests,
    headOid: oid(1),
    files: [],
    stashes: [],
    nativeStacks: undefined,
  }
}

/** External source update: same-head base retargets remain independently observable. */
export function changeGraphIndex(
  index: PullRequestIndex,
  number: number,
  change: GraphChange,
): PullRequestIndex {
  if (!index.pullRequests.some((row) => row.number === number))
    throw new Error(`Unknown graph PR ${number}`)
  return {
    ...index,
    checkedAt: '2026-02-04T09:01:00.000Z',
    pullRequests: index.pullRequests.map((row) =>
      row.number !== number
        ? row
        : change === 'head'
          ? { ...row, headOid: oid(number + 100000) }
          : change === 'base'
            ? { ...row, base: row.base === 'main' ? head(20) : 'main' }
            : { ...row, checks: 'failing', reviewDecision: 'CHANGES_REQUESTED' },
    ),
  }
}

export function graphDetail(
  index: PullRequestIndex,
  number: number,
): PullRequest & { body: string } {
  const row = index.pullRequests.find((row) => row.number === number)
  if (!row) throw new Error(`PR ${number} is not in this repository index`)
  return {
    ...row,
    body: `# Change ${number}\n\nDeterministic selected-only detail (${GRAPH_SEED}).\n\n${'Long source-backed description with dependency context. '.repeat(80)}`,
  }
}
