import type { GitAction } from './types'

/** How much of the workspace a detected repository shape supports. */
export type CapabilityState = 'supported' | 'limited' | 'unsupported'

/** `other` covers any reference storage this build does not know how to name. */
export type RefStorageFormat = 'files' | 'reftable' | 'other'

/** The two facts that gate whole operations rather than individual paths. */
export interface RepositoryShapeFacts {
  bare: boolean
  detachedHead: boolean
}

export interface RepositoryCapabilities extends RepositoryShapeFacts {
  linkedWorktree: boolean
  worktreeCount: number
  refStorage: RefStorageFormat
  /** The raw `extensions.refstorage` value when it is not a plain `files` repository. */
  refStorageDetail: string | null
  sparseCheckout: boolean
  sparseCheckoutCone: boolean
  submodules: boolean
  gitLfs: boolean
  worktreeConfig: boolean
  objectFormat: string | null
  gitVersion: string | null
}

export interface CapabilityRestriction {
  operation: string
  reason: string
}

export interface CapabilityReportEntry {
  id: string
  label: string
  state: CapabilityState
  detail: string
  restrictions: CapabilityRestriction[]
}

export const BARE_REASON =
  'This repository has no working tree. Git Stacks limits bare repositories to reading refs, fetching, and pushing.'
export const DETACHED_REASON =
  'HEAD is detached, so no branch owns the current commit. Switch to a branch first; Git Stacks will not guess a branch name.'
export const SUBMODULE_REASON =
  'is a submodule. Git Stacks shows its recorded commit and never reads or rewrites submodule contents.'
export const SPARSE_REASON =
  'is outside this repository’s sparse working set. Git Stacks treats an unmaterialized path as unchanged, not deleted.'
export const LFS_PUSH_NOTE =
  'Git LFS objects travel with the Git LFS client; Git Stacks does not transfer those objects itself.'

/** Operations that need a working tree to read or change a file. */
const WORKING_TREE_ACTIONS: readonly GitAction['type'][] = [
  'stage',
  'unstage',
  'commit',
  'discardFile',
  'resolveConflict',
  'conflictMergeTool',
  'switch',
  'createBranch',
  'rebase',
  'rebaseContinue',
  'merge',
  'cherryPick',
  'revert',
  'pull',
  'stash',
  'stashPop',
  'stashApply',
  'operationContinue',
  'operationSkip',
  'operationAbort',
  'executeStack',
  'stackContinue',
  'stackAbort',
]

/** Bare repositories expose refs and remotes, but cannot own worktree or branch mutations here. */
const BARE_RESTRICTED_ACTIONS: readonly GitAction['type'][] = [
  ...WORKING_TREE_ACTIONS,
  'rebaseAbort',
  'forcePush',
  'stashDrop',
  'deleteBranch',
  'deleteBranches',
  'deleteRemoteBranch',
  'renameBranch',
  'setUpstream',
  'setParent',
  'createPr',
  'updatePr',
  'closePr',
  'reopenPr',
  'linkIssue',
  'unlinkIssue',
]
/** Operations that need the current checkout to be a branch. */
const BRANCH_ACTIONS: readonly GitAction['type'][] = [
  'push',
  'forcePush',
  'pull',
  'rebase',
  'rebaseContinue',
  'merge',
  'cherryPick',
  'revert',
  'createPr',
  'renameBranch',
  'setUpstream',
]

const operationLabels: Partial<Record<GitAction['type'], string>> = {
  stage: 'Stage files',
  unstage: 'Unstage files',
  commit: 'Commit',
  discardFile: 'Discard file changes',
  resolveConflict: 'Resolve conflict',
  conflictMergeTool: 'Open merge tool',
  deleteBranch: 'Delete branch',
  deleteBranches: 'Delete branches',
  deleteRemoteBranch: 'Delete remote branch',
  switch: 'Switch branch',
  createBranch: 'Create branch',
  rebase: 'Rebase',
  rebaseContinue: 'Continue rebase',
  merge: 'Merge',
  cherryPick: 'Cherry-pick',
  revert: 'Revert commit',
  pull: 'Pull',
  push: 'Push',
  forcePush: 'Force push',
  stash: 'Stash changes',
  rebaseAbort: 'Abort rebase',
  stashPop: 'Pop stash',
  stashApply: 'Apply stash',
  stashDrop: 'Drop stash',
  operationContinue: 'Continue operation',
  operationSkip: 'Skip operation',
  operationAbort: 'Abort operation',
  executeStack: 'Run stack restack',
  stackContinue: 'Continue stack operation',
  stackAbort: 'Abort stack operation',
  createPr: 'Create pull request',
  renameBranch: 'Rename branch',
  setUpstream: 'Set upstream',
  setParent: 'Set stack parent',
  updatePr: 'Update pull request',
  closePr: 'Close pull request',
  reopenPr: 'Reopen pull request',
  linkIssue: 'Link issue',
  unlinkIssue: 'Remove linked issue',
}
function restrictions(
  types: readonly GitAction['type'][],
  reason: string,
): CapabilityRestriction[] {
  return [...new Set(types)].map((type) => ({
    operation: operationLabels[type] ?? type,
    reason,
  }))
}

/** The single reason an action must not run, or null when the shape allows it. */
export function actionBlockReason(
  shape: RepositoryShapeFacts,
  type: GitAction['type'],
): string | null {
  if (shape.bare && BARE_RESTRICTED_ACTIONS.includes(type)) return BARE_REASON
  if (shape.detachedHead && BRANCH_ACTIONS.includes(type)) return DETACHED_REASON
  return null
}

/** Removing a stash requires direct files-backed ref/reflog locks. Applying it does not. */
export function stashRemovalBlockReason(capabilities: RepositoryCapabilities): string | null {
  if (capabilities.refStorage === 'files') return null
  return `Cannot safely remove a stash with ${capabilities.refStorageDetail ?? capabilities.refStorage} reference storage. Apply the stash without removing it instead.`
}

export function sparsePathReason(path: string): string {
  return `${path} ${SPARSE_REASON}`
}

export function submodulePathReason(path: string): string {
  return `${path} ${SUBMODULE_REASON}`
}

/**
 * The support matrix Settings reports. Every entry names the operations its
 * repository shape refuses and why, so an unsupported action is explained
 * before it is attempted rather than after it fails.
 */
export function capabilityReport(capabilities: RepositoryCapabilities): CapabilityReportEntry[] {
  const removalReason = stashRemovalBlockReason(capabilities)
  const entries: CapabilityReportEntry[] = [
    {
      id: 'worktree',
      label: 'Working tree',
      state: capabilities.bare ? 'unsupported' : 'supported',
      detail: capabilities.bare
        ? BARE_REASON
        : 'This repository has a working tree; file actions stage and discard its files.',
      restrictions: capabilities.bare ? restrictions(BARE_RESTRICTED_ACTIONS, BARE_REASON) : [],
    },
    {
      id: 'head',
      label: 'Current branch',
      state: capabilities.detachedHead ? 'limited' : 'supported',
      detail: capabilities.detachedHead
        ? DETACHED_REASON
        : 'HEAD names a branch, so branch-owned operations are available.',
      restrictions: capabilities.detachedHead ? restrictions(BRANCH_ACTIONS, DETACHED_REASON) : [],
    },
    {
      id: 'worktrees',
      label: 'Linked worktrees',
      state: capabilities.worktreeCount > 1 ? 'limited' : 'supported',
      detail:
        capabilities.worktreeCount > 1
          ? `${capabilities.worktreeCount} worktrees share one repository. Checking out, deleting, or rebasing a branch is refused while another worktree owns it, and stack parents stay in the shared repository config.`
          : 'This is the repository’s only worktree.',
      restrictions: [],
    },
    {
      id: 'submodules',
      label: 'Submodules',
      state: capabilities.submodules ? 'limited' : 'supported',
      detail: capabilities.submodules
        ? 'Tracked submodules are listed by recorded commit. Staging a gitlink records that commit only; Discard and in-app conflict resolution are disabled because Git Stacks never rewrites submodule contents.'
        : 'No tracked submodule configuration is present.',
      restrictions: [],
    },
    {
      id: 'git-lfs',
      label: 'Git LFS',
      state: capabilities.gitLfs ? 'limited' : 'supported',
      detail: capabilities.gitLfs
        ? `A Git LFS filter is configured. Pointer files are shown as pointers and push results say so; the Git LFS client owns object transfer.`
        : 'No Git LFS filter is configured in this repository.',
      restrictions: [],
    },
    {
      id: 'sparse-checkout',
      label: 'Sparse checkout',
      state: capabilities.sparseCheckout ? 'limited' : 'supported',
      detail: capabilities.sparseCheckout
        ? `Sparse checkout is enabled${capabilities.sparseCheckoutCone ? ' in cone mode' : ''}. Paths outside the sparse set are not reported as changes, so an unmaterialized file is never staged as deleted.`
        : 'The working tree is fully materialized.',
      restrictions: [],
    },
    {
      id: 'ref-storage',
      label: 'Reference storage',
      state:
        capabilities.refStorage === 'files'
          ? 'supported'
          : capabilities.refStorage === 'reftable'
            ? 'limited'
            : 'unsupported',
      detail:
        capabilities.refStorage === 'files'
          ? 'Refs are loose files and packed-refs, so ref paths can be resolved directly.'
          : capabilities.refStorage === 'reftable'
            ? 'This repository stores refs in the reftable format. Applying stashes is supported, but Pop and Drop cannot safely remove a stash.'
            : `This repository declares ${capabilities.refStorageDetail ?? 'an unknown'} reference storage. Applying stashes is supported, but Pop and Drop cannot safely remove a stash.`,
      restrictions: removalReason ? restrictions(['stashPop', 'stashDrop'], removalReason) : [],
    },
  ]
  return entries
}

/** How many entries need a limitation notice, used as the navigation badge. */
export function capabilityAttentionCount(report: readonly CapabilityReportEntry[]): number {
  return report.filter((entry) => entry.state !== 'supported').length
}
