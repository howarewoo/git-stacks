export interface PullRequest {
  number: number
  title: string
  url: string
  head: string
  base: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  checks: 'passing' | 'failing' | 'pending' | 'none'
  headOid?: string
  mergeOid?: string
  headRepository?: string
  reviewDecision?: string
  mergeState?: string
}
export interface Branch {
  ref: string
  name: string
  current: boolean
  remote: boolean
  upstream: string | null
  /** Fully qualified upstream identity; display names can be ambiguous. */
  upstreamRef: string | null
  ahead: number
  behind: number
  subject: string
  updatedAt: string
  parent: string | null
  /** Parent commits absent from this branch; null when no parent comparison is available. */
  parentBehind: number | null
  pr: PullRequest | null
  oid?: string
  parentTip?: string | null
  parentSource?: 'recorded' | 'pullRequest' | 'inferred' | null
  needsRestack?: boolean
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
  stashes: Stash[]
  rebaseInProgress: boolean
  operation: GitOperation | null
  stackOperation: StackProgress | null
  headOid: string | null
  github: { available: boolean; message: string }
}
export interface RecentRepository {
  path: string
  name: string
}
export type GitOperation = 'rebase' | 'merge' | 'cherryPick' | 'revert' | 'other'
export interface Stash {
  ref: string
  oid: string
  message: string
}
export interface Commit {
  oid: string
  parents: string[]
  subject: string
  author: string
  date: string
}
export interface HistoryPage {
  commits: Commit[]
  hasMore: boolean
}
export interface FileView {
  path: string
  stagedDiff: string
  unstagedDiff: string
  content: string | null
  binary: boolean
  fingerprint: string
  conflicted: boolean
  truncated: boolean
  hunks: FileHunks
}

export type HunkSideName = 'staged' | 'unstaged'
export type DiffHunkLineKind = 'context' | 'add' | 'remove' | 'marker'
export interface DiffHunkLine {
  kind: DiffHunkLineKind
  /** The literal diff text, including its leading marker and any trailing CR. */
  text: string
  /** The preimage line this line occupies, or the one an addition follows. */
  oldLine: number | null
  /** The postimage line this line occupies, or the one a removal precedes. */
  newLine: number | null
}
export interface DiffHunk {
  /** Stable for as long as this hunk stays at this position with this content. */
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffHunkLine[]
}
export interface HunkSide {
  hunks: DiffHunk[]
  /** Why this side cannot be patched hunk by hunk, or null when it can. */
  unavailable: string | null
}
export interface FileHunks {
  staged: HunkSide
  unstaged: HunkSide
}
export interface PushPreview {
  branch: string
  remote: string
  remoteUrl: string
  destination: string
  localOid: string
  remoteOid: string | null
}
export type StackKind = 'restack' | 'publish' | 'merge'
export interface StackStep {
  branch: string
  parent: string
  oid: string
  commits: number
  title: string
  pr: PullRequest | null
  note: string
}
export interface StackPreview {
  token: string
  kind: StackKind
  branch: string
  steps: StackStep[]
  warnings: string[]
  blockers: string[]
  mergeMethods: ('merge' | 'squash' | 'rebase')[]
}
export interface StackProgress {
  kind: 'restack'
  originalBranch: string
  currentBranch: string | null
  completed: string[]
  remaining: string[]
  message: string
}
export type StackAction =
  | { type: 'setParent'; branch: string; parent: string }
  | {
      type: 'executeStack'
      token: string
      allowForce: boolean
      draft: boolean
      titles: Record<string, string>
      mergeMethod: 'merge' | 'squash' | 'rebase'
    }
  | { type: 'stackContinue' | 'stackAbort' }
  | { type: 'updatePr'; number: number; title: string; body: string; draft: boolean }
  | { type: 'closePr' | 'reopenPr'; number: number }
export type GitAction =
  | { type: 'switch'; ref: string }
  | { type: 'createBranch'; name: string; parent: string }
  | { type: 'deleteBranch'; ref: string; force: boolean; expectedOid: string }
  | { type: 'stage' | 'unstage'; paths: string[] }
  | {
      type: 'commit'
      message: string
      amend: boolean
      expectedHead: string | null
      expectedHeadRef: string
    }
  | { type: 'fetch' | 'push' | 'rebaseContinue' | 'rebaseAbort' }
  | { type: 'pull'; strategy: 'ff-only' | 'merge' | 'rebase' }
  | { type: 'forcePush'; preview: PushPreview }
  | { type: 'stash'; message: string; includeUntracked: boolean }
  | { type: 'stashPop' | 'stashApply' | 'stashDrop'; ref: string; oid: string }
  | { type: 'rebase'; parent: string }
  | { type: 'createPr'; title: string; body: string; base: string; draft: boolean }
  | { type: 'renameBranch'; ref: string; name: string }
  | { type: 'deleteRemoteBranch'; ref: string; expectedOid: string }
  | { type: 'setUpstream'; ref: string; upstream: string | null }
  | { type: 'merge'; ref: string; expectedHead: string; expectedHeadRef: string }
  | {
      type: 'cherryPick' | 'revert'
      oid: string
      expectedHead: string
      expectedHeadRef: string
      mainline: number | null
    }
  | { type: 'operationContinue' | 'operationSkip' | 'operationAbort' }
  | { type: 'discardFile'; path: string; fingerprint: string }
  | {
      type: 'resolveFile'
      path: string
      fingerprint: string
      strategy: 'ours' | 'theirs' | 'manual'
      content: string
    }
  | {
      type: 'stageHunk' | 'unstageHunk'
      path: string
      hunkId: string
      fingerprint: string
      lineIndexes?: number[]
    }
  | StackAction
export interface ActionResult {
  message: string
  url?: string
}
export interface DesktopAPI {
  recentRepositories(): Promise<RecentRepository[]>
  openRepository(path?: string): Promise<RepositorySnapshot | null>
  refresh(): Promise<RepositorySnapshot>
  runAction(action: GitAction): Promise<ActionResult>
  fileView(path: string): Promise<FileView>
  history(ref: string, skip: number): Promise<HistoryPage>
  commitDiff(oid: string): Promise<{ text: string; truncated: boolean }>
  pushPreview(): Promise<PushPreview>
  stackPreview(kind: StackKind, branch: string): Promise<StackPreview>
  pullRequest(number: number): Promise<PullRequest & { body: string }>
  openExternal(url: string): Promise<void>
}
declare global {
  interface Window {
    desktop: DesktopAPI
  }
}
