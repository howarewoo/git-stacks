import type { PullRequest } from './types'

/** Display-only open-PR listing; a partial or stale listing cannot authorize any operation. */
export interface PullRequestIndex {
  /** Qualified origin repository, for graph identities (not a local folder). */
  fullName: string
  repository: string
  host: string
  viewer: string | null
  pullRequests: PullRequest[]
  state: 'idle' | 'loading' | 'partial' | 'complete' | 'stale' | 'error'
  complete: boolean
  fetchedAt: string | null
  checkedAt: string | null
  message: string | null
  pages: number
}
