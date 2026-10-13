import type { GitOperation, PullRequest, RemoteFreshness } from './types'

/** Opaque qualified tuples; display names never grant local authority. */
export type InventoryId = string
export type ReadCompleteness = 'complete' | 'partial' | 'failed'
export interface InventoryRead {
  state: ReadCompleteness
  observedAt: string | null
  error: string | null
}
export interface LocalRepositoryIdentity {
  id: InventoryId
  commonDirectory: string
}
export interface RemoteRepositoryIdentity {
  id: InventoryId
  host: string
  fullName: string
}
export interface InventoryRef {
  id: InventoryId
  repositoryId: InventoryId
  name: string
  kind: 'local' | 'remote'
  oid: string
  /** A tracking ref's remote name and qualified provider repository, never a display-name join. */
  remoteName?: string | null
  remoteId?: InventoryId | null
  upstream: InventoryId | null
  ahead: number | null
  behind: number | null
  worktreeIds: InventoryId[]
  pullRequestIds: InventoryId[]
}
export interface WorktreeCounts {
  staged: number
  unstaged: number
  untracked: number
  renamed: number
  conflicted: number
}
export interface InventoryWorktree {
  id: InventoryId
  repositoryId: InventoryId
  path: string
  gitDirectory: string | null
  kind: 'primary' | 'linked' | 'bare'
  headOid: string | null
  refId: InventoryId | null
  detached: boolean
  missing: boolean
  prunable: string | null
  locked: string | null
  status: 'clean' | 'dirty' | 'conflicted' | 'unknown'
  /** Partial counts are lower bounds, never totals; failed reads carry null. */
  counts: WorktreeCounts | null
  operation: GitOperation | null
  indexSignature: string | null
  read: InventoryRead
}
export interface InventoryPullRequest {
  id: InventoryId
  remoteId: InventoryId
  number: number
  headRef: string
  headOid: string | null
  refIds: InventoryId[]
  facts: PullRequest
}
export interface RepositoryInventory {
  identity: LocalRepositoryIdentity
  registeredPaths: string[]
  remote: RemoteRepositoryIdentity | null
  remotes?: { name: string; identity: RemoteRepositoryIdentity | null }[]
  discovery: InventoryRead
  refsRead: InventoryRead
  refs: InventoryRef[]
  worktrees: InventoryWorktree[]
  pullRequests: InventoryPullRequest[]
  /** Local discovery never waits for or refreshes GitHub. */
  remoteFreshness: RemoteFreshness | null
}
export interface WorktreeInventory {
  generation: number
  repositories: RepositoryInventory[]
  failures: { path: string; error: string }[]
  state: ReadCompleteness
}
export interface InventoryRequest {
  requestId: string
  /** A scheduling hint only; main independently resolves all authorities. */
  selectedWorktreeId?: InventoryId
  visibleWorktreeIds?: InventoryId[]
}
