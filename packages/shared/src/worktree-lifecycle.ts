export type WorktreeLifecycleRequest =
  | {
      kind: 'create'
      repositoryId: string
      sourceRefId: string
      directory: string
      newBranch?: string
    }
  | { kind: 'remove'; repositoryId: string; worktreeIds: string[] }

export interface WorktreeLifecycleTarget {
  worktreeId: string | null
  path: string
  ref: string | null
  oid: string | null
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
