/**
 * The action vocabulary shared by the fixture declarations, the fake provider, and
 * the oracle. These names are the machine-readable half of the action boundaries in
 * `.agents/skills/flatten-pr-graph/references/contract.md` §8; the fixture schema
 * enumerates exactly the same two sets, and the discovery test fails when they drift.
 */

export const PERMITTED_ACTIONS = [
  'read-pr-metadata',
  'list-pull-requests',
  'read-ref',
  'read-ancestry',
  'read-branch-protection',
  'read-landing-arrangement',
  'write-task-owned-scratch',
  'update-pr-base',
  'push-selected-head',
] as const

export const FORBIDDEN_ACTIONS = [
  'run-checks',
  'await-checks',
  'rerun-checks',
  'weaken-protection',
  'merge-pr',
  'close-pr',
  'reopen-pr',
  'delete-branch',
  'push-root',
  'disable-auto-merge',
  'join-merge-queue',
  'modify-workflow-config',
  'edit-user-checkout',
  'edit-user-config',
  'write-unselected-ref',
  'write-outside-scratch',
  'clone-recreate-pr',
  'drop-selection',
  'expand-selection',
] as const

export type PermittedAction = (typeof PERMITTED_ACTIONS)[number]
export type ForbiddenAction = (typeof FORBIDDEN_ACTIONS)[number]
export type PrActionKind = PermittedAction | ForbiddenAction

export function isPermitted(kind: string): kind is PermittedAction {
  return (PERMITTED_ACTIONS as readonly string[]).includes(kind)
}

/** Git commands that would run, poll, or repair checks, which no run may issue. */
export const FORBIDDEN_COMMAND_PATTERNS: readonly string[] = [
  'npm test',
  'npm run test',
  'npm run typecheck',
  'npm run build',
  'npm run lint',
  'gh pr checks',
  'gh pr merge',
  'gh run watch',
  'gh run rerun',
  'gh workflow',
  'make test',
  'cargo test',
  'go test',
  'pytest',
  'jest',
  'playwright test',
]

/** Maps a recorded action or command onto the invariant it can violate. */
export const INVARIANTS = [
  'selection.complete',
  'selection.no-expansion',
  'topology.chain',
  'topology.dependencies',
  'preservation.root',
  'preservation.unselected-refs',
  'preservation.original-commits',
  'preservation.cumulative',
  'preservation.user-worktree',
  'integrity.clean',
  'remote.claims-match',
  'remote.actions-permitted',
  'status.legality',
] as const

export type Invariant = (typeof INVARIANTS)[number]
