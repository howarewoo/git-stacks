export type NativeStackValidationStatus =
  | 'valid'
  | 'invalid-chain'
  | 'cross-fork-head'
  | 'duplicate-pr'
  | 'closed'
  | 'completed'
  | 'preview-unavailable'

export interface PullRequestStackMember {
  number: number
  position: number
  total: number
  head: string
  headSha?: string
  base: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
}

export interface NativeStack {
  id: number
  number: number
  url: string
  base: string
  open: boolean
  createdAt: string
  size: number
  pullRequests: PullRequestStackMember[]
  status: NativeStackValidationStatus
}

export interface PullRequestStackMembership {
  stackNumber: number
  position: number
  size: number
  base: string
  open: boolean
  url: string
}
/**
 * How one submitted stack compares with the local graph, the local parent
 * hints, and real Git ancestry. The order of this union is documentation
 * only; `reconcileStack` decides the state with an explicit precedence.
 */
export type ReconciliationState =
  | 'local-only'
  | 'remote-native'
  | 'matching'
  | 'stale'
  | 'diverged'
  | 'reordered'
  | 'missing-branch'
  | 'retargeted'
  | 'merged'
  | 'externally-unstacked'
  | 'ambiguous'

export type ReconciliationRepairKind =
  | 'adopt-remote-order'
  | 'clear-stale-hint'
  | 'adopt-remote-tip'
  | 'restore-missing-branch'
  | 'retarget-pull-request'

export interface ReconciliationPullRequest {
  number: number
  head: string
  base: string
  headOid: string | null
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  stackNumber: number | null
  stackPosition: number | null
  stackSize: number | null
  stackBase: string | null
}

/**
 * Real Git containment facts. `null` means Git could not answer — for example
 * two unrelated histories — and the reconciliation state machine turns that
 * into an explicit blocker instead of a guess.
 */
export interface ReconciliationAncestry {
  parentOid: string | null
  mergeBase: string | null
  /** The authoritative parent tip is contained in the local branch tip. */
  parentContainsBranch: boolean | null
  /** The local branch tip is contained in the authoritative parent tip. */
  branchContainsParent: boolean | null
  /** The recorded parent boundary is still an ancestor of the local branch tip. */
  recordedParentTipValid: boolean | null
  /** The submitted head commit is contained in the local branch tip. */
  submittedContainsBranch: boolean | null
  /** The local branch tip is contained in the submitted head commit. */
  branchContainsSubmitted: boolean | null
  /** The origin tracking ref is contained in the local branch tip. */
  remoteContainsBranch: boolean | null
  /** The local branch tip is contained in the origin tracking ref. */
  branchContainsRemote: boolean | null
}

export interface ReconciliationMemberInput {
  branch: string
  localOid: string | null
  remoteOid: string | null
  recordedParent: string | null
  recordedParentTip: string | null
  ancestry: ReconciliationAncestry
  pullRequest: ReconciliationPullRequest | null
  /** A commit this repository already has that the branch may be moved to. */
  adoptTargetOid: string | null
}

export interface ReconciliationStackInput {
  key: string
  defaultBranch: string
  /** Authoritative bottom-to-top head refs; empty for a purely local stack. */
  submittedOrder: string[]
  submittedHeadOids: Record<string, string | null>
  submittedBase: string | null
  stackNumber: number | null
  stackUrl: string | null
  /** GitHub's own verdict on the submitted chain. */
  submittedStatus: NativeStackValidationStatus
  /** Canonical PR numbers that no longer identify submitted branch heads. */
  identityConflicts?: string[]
  members: ReconciliationMemberInput[]
}

export interface ReconciliationMember {
  branch: string
  position: number
  submittedHeadOid: string | null
  localOid: string | null
  remoteOid: string | null
  recordedParent: string | null
  recordedParentTip: string | null
  expectedParent: string | null
  pullRequest: number | null
  state: ReconciliationState
  detail: string
}

/** The pre-repair state retained so a person can undo a repair by hand. */
export interface ReconciliationEvidence {
  branch: string
  backupRef: string | null
  previousOid: string | null
  previousParent: string | null
  previousParentTip: string | null
  previousBase: string | null
}

export interface ReconciliationRepair {
  /** Stable identity for this concrete branch or pull-request write. */
  id: string
  kind: ReconciliationRepairKind
  branch: string | null
  pullRequest: number | null
  summary: string
  detail: string
  /** True when the repair can move a branch tip or rewrite a PR base. */
  requiresConfirmation: boolean
  evidence: ReconciliationEvidence | null
}

export interface ReconciledStack {
  key: string
  base: string
  stackNumber: number | null
  stackUrl: string | null
  state: ReconciliationState
  summary: string
  submittedOrder: string[]
  members: ReconciliationMember[]
  repairs: ReconciliationRepair[]
  blockers: string[]
}

export interface ReconciliationRepairRecord {
  id: string
  at: string
  stackKey: string
  state: ReconciliationState
  applied: {
    kind: ReconciliationRepairKind
    branch: string | null
    pullRequest: number | null
  }[]
  evidence: ReconciliationEvidence[]
}

export interface ReconciliationReport {
  available: boolean
  message: string
  stacks: ReconciledStack[]
  blockers: string[]
  evidence: ReconciliationRepairRecord | null
}

export interface ReconciliationPreview {
  token: string
  stackKey: string
  state: ReconciliationState
  summary: string
  base: string
  submittedOrder: string[]
  repairs: ReconciliationRepair[]
  blockers: string[]
  warnings: string[]
  capturedAt: string
}

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
  stack?: PullRequestStackMembership | null
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
  parentSource?: 'recorded' | 'pullRequest' | 'stack' | 'inferred' | null
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
  nativeStacks?: NativeStack[]
  nativeStackPreviewAvailable?: boolean
  nativeStackMessage?: string
  /** GitHub-authoritative comparison of submitted stacks with the local graph. */
  reconciliation?: ReconciliationReport
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
  /** Present only for a publish preview: the resumable submission plan. */
  publish: PublishPreview | null
}

/** One resumable unit of Submit Stack work, in bottom-to-top order. */
export type PublishStepKind = 'push' | 'create-pr' | 'retarget-pr' | 'create-stack' | 'extend-stack'

export type PublishStepStatus = 'pending' | 'running' | 'completed' | 'failed'

/** What a person can do about a step that stopped, without a new preview. */
export interface PublishStepFailure {
  summary: string
  recovery: string
  retryable: boolean
}

export interface PublishStep {
  kind: PublishStepKind
  /** Null for the stack registration step, which spans every layer. */
  branch: string | null
  label: string
  status: PublishStepStatus
  pullRequest: number | null
  detail: string
  failure: PublishStepFailure | null
}

/** The reviewable choice for one layer, fixed before the first push happens. */
export interface PublishLayer {
  branch: string
  base: string
  title: string
  body: string
  draft: boolean
  /** True when the base changes an existing pull request and was explicitly previewed. */
  updateBase: boolean
  /** False when a captured pull request already sits on the correct base. */
  create: boolean
  /** The push replaces remote history and needs the captured-OID lease consent. */
  force: boolean
  pullRequest: number | null
  /**
   * True once this operation has asked GitHub to open the pull request. Journalled before the
   * request leaves, so a lost response is recovered instead of being read as somebody else's
   * pull request.
   */
  createIntent: boolean
}

export type PublishStackAction = 'create' | 'extend' | 'none'

export interface PublishPreview {
  branch: string
  layers: PublishLayer[]
  steps: PublishStep[]
  stackNumber: number | null
  stackAction: PublishStackAction
  /** Layers whose base must change on an existing pull request to be submitted. */
  baseChanges: string[]
  capturedAt: string
}

export interface PublishProgress {
  operationId: string
  status: 'running' | 'failed' | 'completed'
  steps: PublishStep[]
  message: string
  /** Index of the first step a retry resumes at; null once every step completed. */
  resumeAt: number | null
  /**
   * The per-layer choices the saved submission will use, which is what a retry actually
   * publishes. They are shown read-only during recovery: changing them requires dismissing the
   * submission and taking a fresh preview.
   */
  layers: PublishLayer[]
  /**
   * The consent to replace remote history that the saved submission was given. A retry force
   * pushes under exactly this value, so the dialog has to show it rather than an unchecked
   * box that would send the person into a push they never agreed to.
   */
  allowForce: boolean
}

/** The per-layer choices a reviewed submission carries to the main process. */
export interface PublishLayerChoice {
  title: string
  body: string
  draft: boolean
  updateBase: boolean
}
export type SubmitStackAction =
  | {
      type: 'submitStack'
      token: string
      allowForce: boolean
      layers: Record<string, PublishLayerChoice>
    }
  | { type: 'submitStackRetry' }
  | { type: 'submitStackDismiss' }

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
      mergeMethod: 'merge' | 'squash' | 'rebase'
    }
  | SubmitStackAction
  | { type: 'stackContinue' | 'stackAbort' }
  | { type: 'updatePr'; number: number; title: string; body: string; draft: boolean }
  | { type: 'closePr' | 'reopenPr'; number: number }
  | { type: 'createNativeStack'; pullRequests: number[] }
  | { type: 'addPullRequestsToNativeStack'; stackNumber: number; pullRequests: number[] }
  | { type: 'unstackNativeStack'; stackNumber: number }
  | {
      type: 'reconcileRepair'
      token: string
      ids: string[]
      confirmRewrites: boolean
    }

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
  /** Resumable Submit Stack progress left on disk, or null when nothing is pending. */
  submitStackProgress?: () => Promise<PublishProgress | null>
  /**
   * Subscribes to progress pushed by a running submission, and returns the unsubscribe. The
   * dialog uses this rather than polling, because a read queues behind the action that is
   * producing the steps.
   */
  onSubmitStackProgress?: (listener: (progress: PublishProgress | null) => void) => () => void
  reconciliationPreview?: (stackKey: string) => Promise<ReconciliationPreview>
  pullRequest(number: number): Promise<PullRequest & { body: string }>
  listNativeStacks?: () => Promise<NativeStack[]>
  createNativeStack?: (pullRequests: number[]) => Promise<NativeStack>
  addPullRequestsToNativeStack?: (
    stackNumber: number,
    pullRequests: number[],
  ) => Promise<NativeStack>
  unstackNativeStack?: (
    stackNumber: number,
  ) => Promise<{ dissolved: boolean; stack: NativeStack | null }>
  openExternal(url: string): Promise<void>
}
declare global {
  interface Window {
    desktop: DesktopAPI
  }
}
