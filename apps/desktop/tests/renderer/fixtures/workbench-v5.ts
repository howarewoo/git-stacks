import type {
  BranchWorkbenchSnapshot,
  WorkbenchBranch,
  WorkbenchRepository,
} from '../../../src/renderer/src/components/branch-workbench-model'

const localId = (key: string) => JSON.stringify(['local', `fixture-common-${key}:1`])
const refId = (key: string, name: string) =>
  JSON.stringify([localId(key), 'ref', `refs/heads/${name}`])
const remoteId = (name: string) => JSON.stringify(['remote', 'github.com', `howarewoo/${name}`])
const repositorySeeds = [
  { key: 'gs', name: 'git-stacks', mark: 'GS' },
  { key: 'ak', name: 'toolkit', mark: 'TK' },
  { key: 'wp', name: 'web-platform', mark: 'WP' },
]

// Approved reference facts only. No prototype operation/state engine is imported.
type Seed = [string, string, string, string, number | null, string, number, string | null, number]
const seeds: Seed[] = [
  [
    'w1',
    'gs',
    'feat/worktree-registry',
    'Discover and track linked worktrees',
    247,
    'review',
    0,
    'main',
    0,
  ],
  [
    'w2',
    'gs',
    'feat/worktree-switcher',
    'Keep context when switching worktrees',
    248,
    'changes',
    3,
    'w1',
    2,
  ],
  [
    'w3',
    'gs',
    'fix/parallel-refresh',
    'Avoid stale results during parallel refresh',
    250,
    'failed',
    0,
    'main',
    0,
  ],
  [
    'w4',
    'gs',
    'feat/stack-order',
    'Preserve PR order across restacks',
    251,
    'conflict',
    2,
    'w1',
    0,
  ],
  [
    'w5',
    'gs',
    'feat/background-fetch',
    'Refresh repositories independently',
    252,
    'local',
    4,
    'main',
    1,
  ],
  [
    'w6',
    'gs',
    'feat/repository-history',
    'Browse changes across repositories',
    null,
    'unpublished',
    6,
    'main',
    3,
  ],
  [
    'w7',
    'gs',
    'feat/keyboard-navigation',
    'Navigate worktrees without the mouse',
    253,
    'restack',
    0,
    'w5',
    0,
  ],
  [
    'w8',
    'gs',
    'perf/large-repo-index',
    'Bound reads for large repositories',
    254,
    'local',
    8,
    'main',
    2,
  ],
  [
    'w9',
    'gs',
    'fix/stale-check-status',
    'Invalidate checks when the head changes',
    245,
    'ready',
    0,
    'main',
    0,
  ],
  [
    'w10',
    'gs',
    'feat/branch-search',
    'Search branches by name and PR title',
    244,
    'ready',
    0,
    'main',
    0,
  ],
  [
    'w11',
    'gs',
    'chore/design-token-sync',
    'Use shared tokens in every work surface',
    243,
    'ready',
    0,
    'main',
    0,
  ],
  ['w12', 'gs', 'main', 'Primary worktree', null, 'quiet', 0, null, 0],
  [
    'w13',
    'gs',
    'docs/worktree-workflows',
    'Document the parallel development workflow',
    null,
    'unpublished',
    0,
    'w2',
    2,
  ],
  [
    'w14',
    'gs',
    'fix/review-scroll',
    'Keep review position when opening a thread',
    241,
    'merged',
    0,
    'main',
    0,
  ],
  [
    'w15',
    'gs',
    'chore/remove-legacy-cache',
    'Remove the old repository snapshot cache',
    239,
    'merged',
    1,
    'main',
    0,
  ],
  [
    'a1',
    'ak',
    'feat/request-tracing',
    'Carry request context across services',
    86,
    'changes',
    2,
    'main',
    1,
  ],
  [
    'a2',
    'ak',
    'feat/tool-permissions',
    'Scope permissions to each tool',
    87,
    'local',
    4,
    'main',
    2,
  ],
  ['a3', 'ak', 'fix/stream-buffer', 'Keep streamed messages in order', 88, 'local', 2, 'main', 1],
  [
    'a4',
    'ak',
    'fix/retry-budget',
    'Stop retries after the configured budget',
    82,
    'ready',
    0,
    'main',
    0,
  ],
  ['a5', 'ak', 'main', 'Primary worktree', null, 'quiet', 0, null, 0],
  ['a6', 'ak', 'chore/typed-events', 'Add typed application events', 79, 'merged', 0, 'main', 0],
  [
    'p1',
    'wp',
    'fix/hydration-order',
    'Avoid a hydration mismatch in navigation',
    412,
    'failed',
    0,
    'main',
    0,
  ],
  [
    'p2',
    'wp',
    'feat/account-settings',
    'Build the account settings page',
    415,
    'local',
    6,
    'main',
    2,
  ],
  [
    'p3',
    'wp',
    'feat/accessibility-audit',
    'Improve keyboard and screen reader support',
    411,
    'review',
    0,
    'main',
    0,
  ],
  [
    'p4',
    'wp',
    'fix/avatar-fallback',
    'Show initials when an image is unavailable',
    410,
    'ready',
    0,
    'main',
    0,
  ],
  ['p5', 'wp', 'main', 'Primary worktree', null, 'quiet', 0, null, 0],
  [
    'b1',
    'gs',
    'feat/remote-pr-search',
    'Search pull requests without a local branch',
    256,
    'remote',
    0,
    'main',
    0,
  ],
  [
    'b2',
    'gs',
    'fix/notification-count',
    'Count unique repository notifications',
    257,
    'remote',
    0,
    'main',
    0,
  ],
  [
    'b3',
    'gs',
    'experiment/diff-layout',
    'Explore a side-by-side diff layout',
    null,
    'remote',
    0,
    'w1',
    0,
  ],
  ['b4', 'gs', 'release/next', 'Prepare the next release', null, 'remote', 0, 'main', 0],
]

export const V5_REPOSITORY_ID = localId('gs')
export const V5_REGISTRY_ID = refId('gs', 'feat/worktree-registry')

export function workbenchV5Fixture(degraded = false): BranchWorkbenchSnapshot {
  const branches: WorkbenchBranch[] = seeds.map(
    ([key, repo, ref, title, number, state, dirty, parent, ahead], index) => {
      const repository = repositorySeeds.find((candidate) => candidate.key === repo)!
      const parentSeed =
        parent === 'main'
          ? seeds.find((seed) => seed[1] === repo && seed[2] === 'main')
          : seeds.find((seed) => seed[0] === parent)
      const primary = ref === 'main'
      const path = `/Users/woo/Code/${repository.name}`
      const unknown = degraded && (key === 'w1' || key === 'b2')
      const head = `d8c4${(24731 + index * 135).toString(16)}b`.slice(0, 8)
      const review =
        unknown || key === 'b2'
          ? 'Unavailable'
          : state === 'ready' || state === 'merged'
            ? 'Approved'
            : state === 'changes'
              ? 'Changes requested'
              : state === 'review'
                ? 'Review requested'
                : 'Not requested'
      const check =
        unknown || state === 'conflict' || key === 'b2'
          ? 'Unavailable'
          : state === 'failed'
            ? '1 failed'
            : state === 'local'
              ? 'Running'
              : '6 / 6 passed'
      return {
        id: refId(repo, ref),
        repositoryId: localId(repo),
        ref,
        title,
        parentId: parentSeed ? refId(repo, parentSeed[2]) : null,
        trunk: primary,
        refKind: state === 'remote' ? 'remote' : 'local',
        worktreesKnown: !unknown,
        bulkEligible:
          !primary && !unknown && state !== 'remote' && dirty === 0 && state !== 'conflict',
        worktrees:
          state === 'remote'
            ? []
            : [
                {
                  id: JSON.stringify([localId(repo), 'worktree', `fixture-admin-${key}:1`]),
                  name: primary ? 'Primary worktree' : ref.split('/').slice(1).join('-'),
                  path: primary ? path : `${path}/.worktrees/${ref.split('/').slice(1).join('-')}`,
                  displayPath: primary
                    ? `~/Code/${repository.name}`
                    : `~/Code/${repository.name}/.worktrees/${ref.split('/').slice(1).join('-')}`,
                  status: {
                    label: unknown
                      ? 'Unknown'
                      : dirty
                        ? `${dirty} ${state === 'conflict' ? 'conflicts' : 'files'}`
                        : 'Clean',
                    tone: dirty ? 'warning' : 'neutral',
                  },
                  changedFiles: unknown ? null : dirty,
                },
              ],
        local: { label: number ? 'Published' : 'Local only' },
        unpushed: unknown ? null : ahead,
        commits: number ? 3 : ahead,
        attention: ['review', 'changes', 'failed', 'conflict', 'restack'].includes(state),
        needsRestack: state === 'restack',
        conflicted: unknown ? null : state === 'conflict',
        readyToMerge: unknown ? null : state === 'ready',
        pullRequest: number
          ? {
              id: JSON.stringify([remoteId(repository.name), 'pr', number]),
              number,
              author: 'howarewoo',
              state: state === 'merged' ? 'merged' : 'open',
              lifecycle: {
                label: state === 'merged' ? 'Merged' : state === 'local' ? 'Draft' : 'Open',
                tone: state === 'merged' ? 'merged' : 'success',
              },
              review: {
                label: review,
                icon:
                  review === 'Approved'
                    ? 'check'
                    : review === 'Changes requested'
                      ? 'comment'
                      : review === 'Unavailable'
                        ? 'circle'
                        : 'review',
                tone:
                  review === 'Approved'
                    ? 'success'
                    : review === 'Changes requested'
                      ? 'warning'
                      : 'neutral',
              },
              checks: {
                label: check,
                icon:
                  check === '6 / 6 passed'
                    ? 'check'
                    : check === '1 failed'
                      ? 'error'
                      : check === 'Running'
                        ? 'clock'
                        : 'circle',
                tone:
                  check === '6 / 6 passed' ? 'success' : check === '1 failed' ? 'error' : 'neutral',
              },
              draft: state === 'local',
              publishedHead: unknown
                ? null
                : ahead
                  ? (Number.parseInt(head, 16) - 17).toString(16)
                  : head,
            }
          : degraded
            ? undefined
            : null,
        notice:
          key === 'w1'
            ? {
                title: unknown ? 'Worktree and GitHub data unavailable' : 'New commits to review',
                body: unknown
                  ? 'The local read failed and the provider is offline. Unknown is not clean or passing.'
                  : 'The published head changed since your last look. Review it without switching checkouts.',
                tone: 'neutral',
              }
            : undefined,
      }
    },
  )
  const repositories: WorkbenchRepository[] = repositorySeeds.map((repo) => {
    const rows = branches.filter((branch) => branch.repositoryId === localId(repo.key))
    const localUnknown = degraded && repo.key === 'gs'
    return {
      id: localId(repo.key),
      name: repo.name,
      owner: 'howarewoo',
      mark: repo.mark,
      branchCount: localUnknown ? null : rows.length,
      pullRequestCount: degraded
        ? null
        : rows.filter((branch) => branch.pullRequest?.state === 'open').length,
      unpublishedCount: localUnknown
        ? null
        : rows.filter((branch) => branch.unpushed !== null && branch.unpushed > 0).length,
      readyToMergeCount: degraded
        ? null
        : rows.filter((branch) => branch.readyToMerge === true).length,
      worktreeCount: localUnknown ? null : rows.filter((branch) => branch.worktrees.length).length,
      attentionCount: degraded ? null : rows.filter((branch) => branch.attention).length,
    }
  })
  return {
    repositories,
    branches,
    localFreshness: degraded
      ? 'Local snapshot partial · worktree read failed'
      : 'Deterministic v5 fixture · no Git writes',
    remoteFreshness: degraded
      ? 'GitHub offline · last facts unconfirmed'
      : '26 worktrees · 3 repositories · snapshot data',
    notice: degraded
      ? 'Partial local inventory; GitHub offline. Unavailable facts remain unknown.'
      : undefined,
  }
}
