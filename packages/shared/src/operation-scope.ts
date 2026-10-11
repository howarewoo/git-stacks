import { canonicalHostName } from './host'
import type { GitHubCliStatus } from './types'

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

export function sameOperationScope(left: OperationScope, right: OperationScope): boolean {
  return (
    left.repositoryPath === right.repositoryPath &&
    left.remoteUrl === right.remoteUrl &&
    left.authority === right.authority
  )
}
