export type WorktreeLifecycleRequest =
  | {
      kind: 'create'
      repositoryId: string
      sourceRefId: string
      directory: string
      newBranch?: string
    }
  | { kind: 'remove'; repositoryId: string; worktreeIds: string[] }

/** Original target identity, distinct from the operation's execution owner. */
export interface WorktreeLifecycleTargetAuthority {
  commonDirectory: string
  commonIdentity: string
  directoryIdentity: string | null
  gitDirectory: string | null
  gitDirectoryIdentity: string | null
}
export interface WorktreeLifecycleTarget {
  worktreeId: string | null
  path: string
  ref: string | null
  oid: string | null
  authority: WorktreeLifecycleTargetAuthority
  blockers: string[]
  effect: string
}
export interface WorktreeLifecyclePreview {
  token: string
  repositoryId: string
  kind: WorktreeLifecycleRequest['kind']
  targets: WorktreeLifecycleTarget[]
  blockers: string[]
  coordination: string
}
export interface WorktreeLifecycleResult {
  kind: WorktreeLifecycleRequest['kind']
  targets: {
    path: string
    state: 'completed' | 'failed' | 'not-run' | 'unconfirmed'
    detail: string
  }[]
  createdWorktreeId: string | null
  message: string
}
