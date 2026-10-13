import { canonicalHostName } from './host'
import type { GitHubCliStatus } from './types'
import type { InspectionContext } from './inspection'
import type { GitAction, ActionResult, StackProgress, PublishProgress } from './types'
import type { StackPreview, SurgeryPlanPreview } from './types'
import type { NativeOperationPreview } from './native-operation'
import type { WorktreeLifecyclePreview } from './worktree-lifecycle'

/** Public host/account/session identity, never a credential. Equivalent re-reads retain it. */
export function cliAuthority(host: string | null, status: GitHubCliStatus | null): string {
  const name = host === null ? '' : canonicalHostName(host)
  return [
    name,
    canonicalHostName(status?.host ?? name),
    status?.state ?? 'checking',
    status?.login ?? '',
    status?.identity ?? '',
  ].join('|')
}

/** Captured transport origin, not the creator identity of a previously saved journal. */
export interface OperationScope {
  repositoryPath: string
  remoteUrl: string | null
  authority: string
}

export interface OperationProgress<T> {
  scope: OperationScope
  /** Older journal bytes do not record creator authority; a read must not invent it. */
  source: 'action' | 'journal-read'
  progress: T | null
}

/** Main-minted, immutable local/provider authority; inspection alone cannot execute. */
export interface OperationCapture {
  token: string
  context: InspectionContext
  scope: OperationScope
  repositoryId: string
  commonDirectory: string
  directoryIdentity: string
  commonIdentity: string
  gitDirectory: string
  gitDirectoryIdentity: string
  worktreeId: string
  worktreePath: string
  headOid: string | null
  /** Exact paused commit, distinct from the temporary replay HEAD. */
  operationCommitOid: string | null
  fingerprint: string
  refs: { id: string; ref: string; oid: string }[]
  capturedAt: string
  coordination: string
}

export interface OperationRecord {
  id: string
  repositoryId: string
  context: InspectionContext
  scope: OperationScope
  worktreePath: string
  action: GitAction
  capture: OperationCapture
  preview?: StackPreview | SurgeryPlanPreview | NativeOperationPreview | WorktreeLifecyclePreview
  state: 'active' | 'paused' | 'failed' | 'unconfirmed' | 'completed'
  startedAt: string
  updatedAt: string
  message: string
  result: ActionResult | null
  stackProgress?: StackProgress | null
  /** An original record cannot be retargeted to a later journal at the same path. */
  recovery?: { kind: 'stack' | 'publication'; id: string }
  /** Intent is synced before transport; rejected records a definite non-applied provider response. */
  remoteDispatch?: 'intent' | 'rejected'
  /** Read-only projection of a later explicit action on this exact recovery identity. */
  resolution?: 'completed' | 'aborted' | 'dismissed'
  publication?: PublishProgress | null
}

export function sameOperationScope(left: OperationScope, right: OperationScope): boolean {
  return (
    left.repositoryPath === right.repositoryPath &&
    left.remoteUrl === right.remoteUrl &&
    left.authority === right.authority
  )
}
