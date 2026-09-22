export interface PullRequest {
  number: number
  title: string
  url: string
  head: string
  base: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  checks: 'passing' | 'failing' | 'pending' | 'none'
}
export interface Branch {
  ref: string
  name: string
  current: boolean
  remote: boolean
  upstream: string | null
  ahead: number
  behind: number
  subject: string
  updatedAt: string
  parent: string | null
  pr: PullRequest | null
}
export interface ChangedFile {
  path: string
  originalPath?: string
  index: string
  worktree: string
  conflicted: boolean
}
export interface RepositorySnapshot {
  path: string
  name: string
  currentBranch: string | null
  defaultBranch: string
  remoteUrl: string | null
  branches: Branch[]
  pullRequests: PullRequest[]
  files: ChangedFile[]
  stashes: { ref: string; message: string }[]
  rebaseInProgress: boolean
  github: { available: boolean; message: string }
}
export interface RecentRepository {
  path: string
  name: string
}
export type GitAction =
  | { type: 'switch'; ref: string }
  | { type: 'createBranch'; name: string; parent: string }
  | { type: 'stage' | 'unstage'; paths: string[] }
  | { type: 'commit'; message: string }
  | { type: 'fetch' | 'pull' | 'push' | 'stash' | 'rebaseContinue' | 'rebaseAbort' }
  | { type: 'stashPop'; ref: string }
  | { type: 'rebase'; parent: string }
  | { type: 'createPr'; title: string; body: string; base: string; draft: boolean }
export interface ActionResult {
  message: string
  url?: string
}
export interface DesktopAPI {
  recentRepositories(): Promise<RecentRepository[]>
  openRepository(path?: string): Promise<RepositorySnapshot | null>
  refresh(): Promise<RepositorySnapshot>
  runAction(action: GitAction): Promise<ActionResult>
  openExternal(url: string): Promise<void>
}
declare global {
  interface Window {
    desktop: DesktopAPI
  }
}
