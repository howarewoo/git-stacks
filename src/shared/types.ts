import type { SnapshotLimits } from './performance'
import type { RepositoryCapabilities } from './capabilities'
import type { ReviewCommitSet, ReviewFileSet, ReviewHeadline, ReviewViewedRecord } from './review'
import type { ReviewHistory, ReviewHistoryDiff } from './review-snapshots'
import type { PullRequestChecksReport } from './pull-request-checks'
import type {
  ReviewDraft,
  ReviewDraftRecord,
  ReviewDraftResolution,
  ReviewMutationResult,
  ReviewSubmission,
  ReviewThreadRead,
} from './review-threads'

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

/** How GitHub is asked to land a pull request, per the asynchronous merge API. */
export type MergeAction = 'default' | 'direct_merge' | 'merge_queue'

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/**
 * The last merge request and subsequent pull-request state observed by Git Stacks.
 * A terminal `enqueued` result does not track later queue membership. An open pull
 * request can still be queued or have been ejected, so membership is `unconfirmed`
 * unless a later read confirms that the pull request merged or closed.
 */
export type MergeQueueOutcome = 'pending' | 'unconfirmed' | 'merged' | 'dropped'

/**
 * What GitHub reported for one accepted asynchronous merge request. A request is not a
 * queue: `enqueued` is the only outcome that proves a base ref has one.
 */
export type MergeRequestOutcome = 'pending' | 'merged' | 'enqueued' | 'failed'

export interface MergeQueueState {
  /** True once GitHub accepted an enqueue for this base ref, which is the only proof of a queue. */
  configured: boolean
  /**
   * `pending` means GitHub accepted the asynchronous request and has not reported a terminal
   * result for it yet; its UUID is kept so the result can be read again without a new request.
   */
  outcome: MergeQueueOutcome | null
  requestedAt: string | null
}

/** One pull request that a single merge action will land, bottom-to-top. */
export interface MergeLayerPreview {
  branch: string
  pullRequest: number
  base: string
  headOid: string
  /**
   * True when GitHub lands this layer as part of the selected pull request's own
   * request, which is how a GitHub-native stack merge covers its downstack.
   */
  includedInRequest: boolean
}

export interface MergePreview {
  branch: string
  /** Bottom-to-top; the last layer is the pull request the person selected. */
  layers: MergeLayerPreview[]
  /** True when one request for the selected pull request lands every layer. */
  native: boolean
  /** Actions this repository and base ref accept. */
  actions: MergeAction[]
}
export interface RepositoryIssue {
  number: number
  title: string
  url: string
  state?: 'OPEN' | 'CLOSED'
}

export type IssueLinkRelation = 'contextual' | 'closing'

export interface LinkedIssue {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED'
  relation: IssueLinkRelation
}

export interface PullRequestIssueLinks {
  prNumber: number
  links: LinkedIssue[]
  message?: string
}

export interface IssueLinkPreview {
  prNumber: number
  issueNumber: number
  relation: IssueLinkRelation
  action: 'link' | 'unlink'
  currentBody: string
  newBody: string
  changed: boolean
  closingSyntax?: string
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
  /** Index mode 160000: the path is a submodule gitlink, not a file Git Stacks rewrites. */
  submodule?: boolean
  /** Sparse checkout left the path out of the working set, so it is not materialized. */
  sparseExcluded?: boolean
}
export interface RepositorySnapshot {
  path: string
  name: string
  currentBranch: string | null
  defaultBranch: string
  remoteUrl: string | null
  branches: Branch[]
  pullRequests: PullRequest[]
  issues?: RepositoryIssue[]
  issuesMessage?: string
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
  /** What an extreme repository forced this snapshot to leave out. */
  limits: SnapshotLimits
  capabilities: RepositoryCapabilities
  /** GitHub-authoritative comparison of submitted stacks with the local graph. */
  reconciliation?: ReconciliationReport
  /**
   * GitHub freshness for the pull-request, stack, and issue data in this
   * snapshot. Optional so hand-built fixtures stay valid; the main process
   * always sets it, and its absence reads as unknown rather than fresh.
   */
  remote?: RemoteFreshness
  /**
   * Set when the GitHub data in this snapshot is the last confirmed payload
   * rather than a live read, with the reason and the time it was confirmed.
   */
  githubStale?: { reason: string; fetchedAt: string } | null
  /**
   * The typed reason the GitHub read could not answer, whenever it could not.
   * Background refresh backs off on this; a fallback to the last confirmed
   * payload never turns a failure into a success.
   */
  githubFailure?: { kind: string; detail: string } | null
}

/** A GitHub mutation whose outcome the app refuses to guess after a lost network. */
export type RemoteMutationKind =
  'merge' | 'review-submit' | 'force-push' | 'delete' | 'retarget' | 'create-pr' | 'publish'

/**
 * A high-impact GitHub mutation that did not complete. It is listed for the
 * person who asked for it and never re-sent: a reconnect only ever resumes
 * reads, because replaying a merge or a forced push could rewrite remote
 * history nobody has seen since.
 */
export interface PendingRemoteMutation {
  id: string
  kind: RemoteMutationKind
  label: string
  reason: string
  failedAt: string
}

export type RemoteFreshnessState =
  'fresh' | 'refreshing' | 'stale' | 'offline' | 'rate-limited' | 'unauthorized'

/** How far the GitHub data in a snapshot can be trusted, and when it was checked. */
export interface RemoteFreshness {
  state: RemoteFreshnessState
  /** When GitHub last confirmed this data, including a 304 that changed nothing. */
  fetchedAt: string | null
  /** The last refresh attempt, successful or not. */
  checkedAt: string | null
  detail: string | null
  /** When GitHub says rate-limited requests resume. */
  rateLimitReset: string | null
  pendingMutations: PendingRemoteMutation[]
}

export interface SyncActivity {
  focused: boolean
  visible: boolean
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
  /** Set when the path is a submodule gitlink: only the recorded commit is shown. */
  submodule?: boolean
  /** Present when the working-tree file is a Git LFS pointer rather than the object. */
  lfs?: LfsPointer | null
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
/** A Git LFS pointer file carries the object identity instead of the object. */
export interface LfsPointer {
  oid: string
  size: number
}
/** What Git itself recorded as happening: a revert undoes a commit. */
export type ConflictOperation =
  'rebase' | 'merge' | 'cherryPick' | 'revert' | 'stashApply' | 'unknown'
export type ConflictKind = 'content' | 'addAdd' | 'modifyDelete' | 'deleteModify' | 'rename'
export type ConflictChoice = 'current' | 'incoming' | 'both' | 'delete'
/** A path one side of the operation moved, as Git's own diff reported it. */
export interface ConflictMove {
  from: string
  to: string
  side: 'current' | 'incoming'
}
export interface ConflictLabels {
  operation: ConflictOperation
  title: string
  base: string
  current: string
  incoming: string
  explanation: string
}
export interface ConflictRegion {
  index: number
  startLine: number
  current: string
  incoming: string
}
export interface ConflictFile {
  path: string
  kind: ConflictKind
  /** Index stages Git left for this path: 1 base, 2 current, 3 incoming. */
  stages: number[]
  /** Stage numbers whose text is a bounded preview rather than the complete blob. */
  stagePreviewTruncated: number[]
  binary: boolean
  labels: ConflictLabels
  base: string | null
  current: string | null
  incoming: string | null
  worktree: string | null
  worktreePresent: boolean
  regions: ConflictRegion[]
  moves: ConflictMove[]
  truncated: boolean
  /** Worktree and index identity this view was read under. */
  fingerprint: string
  mergeTool: { available: boolean; tool: string | null; reason: string }
}
export type ConflictResolution =
  | { kind: 'content'; content: string }
  | { kind: 'choice'; choice: ConflictChoice }
  | { kind: 'worktree' }
export interface PushPreview {
  branch: string
  remote: string
  remoteUrl: string
  destination: string
  localOid: string
  remoteOid: string | null
}
export type StackKind = 'restack' | 'publish' | 'merge' | 'sync'
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
  mergeMethods: MergeMethod[]
  /** Present only for a merge preview: the pull requests one action will land. */
  merge: MergePreview | null
  /** Present only for a publish preview: the resumable submission plan. */
  publish: PublishPreview | null
  /** Present only for a sync preview: the trunk and per-layer classification. */
  sync: SyncPreview | null
}

/**
 * How one stack layer stands against the parent it will be replayed onto and
 * against the branch the same layer published on the remote. The order is the
 * precedence a preview reports it in: a layer that cannot be synced is never
 * described as anything else.
 */
export type SyncLayerState =
  'merged' | 'retargeted' | 'needs-force' | 'needs-rebase' | 'needs-push' | 'up-to-date' | 'blocked'

/** What syncing a layer does to the remote branch of the same name. */
export type SyncPushKind = 'none' | 'create' | 'fast-forward' | 'force'

export interface SyncLayer {
  branch: string
  /** The parent this layer is replayed onto, already skipping merged layers. */
  base: string
  baseOid: string
  state: SyncLayerState
  /** The local tip captured when the preview was taken. */
  oid: string
  /** The remote tip captured when the preview was taken, and the lease a force push names. */
  remoteOid: string | null
  commits: number
  pullRequest: number | null
  /** The base GitHub recorded for the pull request when the preview was taken. */
  pullRequestBase: string | null
  /** The merged lower pull request that moves this layer onto a different base. */
  retargetedFrom: string | null
  rebase: boolean
  push: SyncPushKind
  note: string
  blockers: string[]
}

/** The branch the whole stack hangs from, and how far it has moved on the remote. */
export interface SyncTrunk {
  branch: string
  remote: string
  localOid: string | null
  remoteOid: string | null
  /** Commits the local trunk holds that the fetched remote tip does not. */
  ahead: number
  /** Commits the fetched remote tip holds that the local trunk does not. */
  behind: number
  /** True when neither tip contains the other, so the remote trunk was rewritten. */
  diverged: boolean
  blockers: string[]
}

export interface SyncPreview {
  branch: string
  trunk: SyncTrunk
  /** Every layer of the stack in bottom-to-top order, including merged ones. */
  layers: SyncLayer[]
  /** Layers whose replay replaces published remote history and needs a lease approval. */
  forcePushes: string[]
  blockers: string[]
  warnings: string[]
}

/** The structural edit a stack surgery makes to one linear stack. */
export type SurgeryKind = 'insert' | 'move' | 'remove'

/** What a surgery does to one branch of the stack. */
export type SurgeryLayerAction = 'insert' | 'rewrite' | 'retarget' | 'remove'

/**
 * One branch a surgery touches. Every field is captured from real Git or from
 * the pull request GitHub reported when the preview was taken, so the review
 * names the exact rewrite, push and pull request change the run will attempt.
 */
export interface SurgeryLayer {
  branch: string
  action: SurgeryLayerAction
  /** The parent before the surgery, and the parent this layer lands on after it. */
  fromParent: string | null
  toParent: string
  /** The local tip captured when the preview was taken; null for a new branch. */
  oid: string | null
  /** The remote tip captured when the preview was taken, and the lease a force push names. */
  remoteOid: string | null
  /** Commits replayed onto the new parent. */
  commits: number
  push: SyncPushKind
  pullRequest: number | null
  /** The base GitHub recorded for the pull request when the preview was taken. */
  pullRequestBase: string | null
  pullRequestAction: 'none' | 'retarget' | 'close'
  note: string
  blockers: string[]
}

/**
 * The native stack mutation a surgery needs. GitHub exposes no single-member
 * removal and no reorder, so a changed composition is unstacked and, when the
 * remaining pull requests still form a chain, registered again in the new
 * order.
 */
export type NativeStackSurgery = 'none' | 'unstack' | 'unstack-and-create'

/** What a surgery does, before the preview is bound to a runnable token. */
export interface SurgeryPlanPreview {
  kind: SurgeryKind
  /** The branch the surgery is anchored on: the new parent, the moved layer, or the removed one. */
  branch: string
  trunk: string
  /** The stack bottom-to-top after the surgery. */
  order: string[]
  layers: SurgeryLayer[]
  forcePushes: string[]
  /**
   * Remote branches this surgery publishes for the first time. GitHub refuses to
   * retarget a pull request onto a branch that does not exist, so a layer that has
   * to become somebody's base is created on the remote before the retargets run,
   * and the push refuses to replace a branch somebody else created.
   */
  creates: string[]
  /** Pull requests whose base changes, bottom-to-top. */
  retargets: { number: number; branch: string; from: string; to: string }[]
  /** Pull requests the surgery closes because their layer leaves the stack. */
  closes: number[]
  nativeStack: { number: number | null; action: NativeStackSurgery; members: number[] } | null
  blockers: string[]
  warnings: string[]
}

/** A reviewed surgery bound to the exact facts the run re-reads before it writes. */
export interface SurgeryPreview extends SurgeryPlanPreview {
  token: string
  expiresAt: number
}

/** The exact surgery a preview was built for, re-read before anything is rewritten. */
export type SurgeryRequest =
  | { kind: 'insert'; branch: string; name: string }
  | { kind: 'move'; branch: string; target: string }
  | { kind: 'remove'; branch: string }

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
  kind: 'restack' | 'sync'
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
      mergeMethod: MergeMethod
      /** Required for a merge: direct or merge-queue delivery for the reviewed layers. */
      mergeAction?: MergeAction
    }
  | SubmitStackAction
  | { type: 'stackContinue' | 'stackAbort' }
  | {
      type: 'executeSurgery'
      token: string
      allowForce: boolean
      /** Consent to close the pull request of a submitted layer the surgery removes. */
      closePullRequests: boolean
    }
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
  | {
      type: 'linkIssue'
      prNumber: number
      issueNumber: number
      relation: IssueLinkRelation
      expectedBody?: string
    }
  | {
      type: 'unlinkIssue'
      prNumber: number
      issueNumber: number
      relation: IssueLinkRelation
      expectedBody?: string
    }

export type GitAction =
  | { type: 'switch'; ref: string; carry?: boolean }
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
      type: 'resolveConflict'
      path: string
      fingerprint: string
      resolution: ConflictResolution
    }
  | {
      type: 'stageHunk' | 'unstageHunk'
      path: string
      hunkId: string
      fingerprint: string
      lineIndexes?: number[]
    }
  | { type: 'conflictMergeTool'; path: string; fingerprint: string }
  | StackAction

export type MergeLayerStatus =
  'merged' | 'enqueued' | 'failed' | 'pending' | 'not-requested' | 'not-merged'

export interface MergeLayerResult {
  branch: string
  pullRequest: number
  status: MergeLayerStatus
  detail: string
  /** The merge commit GitHub reports, once the pull request is merged. */
  mergedOid: string | null
  queue: MergeQueueState | null
  /**
   * The UUID GitHub returned for an accepted asynchronous merge request that has not reported
   * a terminal result, so the result can be read again without submitting another request.
   */
  requestUuid: string | null
}

/** What one merge action did to every pull request it was reviewed against. */
export interface MergeResult {
  action: MergeAction
  method: MergeMethod
  native: boolean
  layers: MergeLayerResult[]
  /** Observed base of the pull requests left above the merge, after GitHub's own retargeting. */
  remaining: { pullRequest: number; branch: string; base: string; state: string }[]
}

/** A running merge, pushed while it waits on GitHub's background result. */
export interface MergeProgress {
  action: MergeAction
  status: 'running' | 'queued' | 'succeeded' | 'failed'
  layers: MergeLayerResult[]
  message: string
}

/**
 * What a read-only refresh reports about merge requests Git Stacks made earlier. Nothing here
 * submits anything: it is what the journal remembers, read back from GitHub.
 */
export interface MergeStatus {
  layers: MergeLayerResult[]
  message: string
}
export interface ActionResult {
  message: string
  url?: string
  /** Present only for a merge: the per-pull-request outcome, including queue state. */
  merge?: MergeResult
}

/**
 * A repository the signed-in credential can reach, exactly as GitHub reports it.
 * Nothing here is a credential: discovery reads the API, and the clone uses
 * ordinary Git with the account's own Git credentials.
 */
export interface GitHubRepositorySummary {
  fullName: string
  name: string
  owner: string
  description: string | null
  private: boolean
  fork: boolean
  archived: boolean
  /** GitHub has no commits yet, so the first branch starts from nothing. */
  empty: boolean
  language: string | null
  defaultBranch: string
  pushedAt: string | null
  url: string
  httpsUrl: string
  sshUrl: string
  canPush: boolean
}

/**
 * Every onboarding refusal is named rather than left as Git's own text, so an
 * organization single sign-on denial, a missing credential, and a destination
 * that already holds someone's files each say what happened and what to do.
 */
export type OnboardingFailureReason =
  | 'signed-out'
  | 'sso-denied'
  | 'rate-limited'
  | 'unavailable'
  | 'cancelled'
  | 'not-found'
  | 'authentication'
  | 'ssh'
  | 'network'
  | 'destination-exists'
  | 'invalid-destination'
  | 'failed'

export interface OnboardingFailure {
  reason: OnboardingFailureReason
  message: string
}

/**
 * Every onboarding call answers with a named outcome rather than a thrown
 * string, so the onboarding surface can tell an organization denial from a
 * cancelled clone from a destination someone already has files in.
 */
export type OnboardingResult<T> = { ok: true; value: T } | { ok: false; failure: OnboardingFailure }

export interface RepositoryDiscovery {
  repositories: GitHubRepositorySummary[]
  /** The query that produced this list, echoed so a slow page can be labelled. */
  query: string
  /** The total number of matches reported by the search, which can exceed the 1,000-result cap. */
  totalCount?: number
  /** True when the search had more matches than the 1,000-result cap or the page limit. */
  truncated?: boolean
  /** True when GitHub answered partial results because the query timed out. */
  incompleteResults?: boolean
}

export interface RepositoryDiscoveryRequest {
  /** An empty query lists everything the credential can reach. */
  query?: string
  /** Cancels the in-flight search when the same id is cancelled. */
  requestId?: string
}

export type CloneProtocol = 'https' | 'ssh'

export interface RepositoryCloneRequest {
  repository: GitHubRepositorySummary
  protocol: CloneProtocol
  /** An existing absolute directory the repository folder is created inside. */
  parentDirectory: string
  /** The single folder name created inside `parentDirectory`. */
  directoryName: string
  shallow: boolean
  /** Cancels the in-flight clone when the same id is cancelled. */
  requestId?: string
}

export interface RepositoryCloneResult {
  path: string
  name: string
  /** GitHub had no commits; the working tree is an empty repository. */
  empty: boolean
  /** The exact `git clone` invocation, for copying into a terminal. */
  gitCommand: string
  /** The equivalent `gh repo clone` invocation. */
  ghCommand: string
}

/** The exact terminal commands a clone would run, shown before anything is written. */
export interface CloneCommandPreview {
  gitCommand: string
  ghCommand: string
}

/**
 * What this machine can already do with Git: the identity commits are authored
 * with, the branch Git names first, whether an HTTPS credential helper is
 * configured, and whether an SSH client Git can drive is on PATH. Git Stacks
 * reads this and changes none of it.
 */
export interface GitEnvironmentStatus {
  identity: { name: string | null; email: string | null }
  /** `init.defaultBranch` as configured; null means Git's own built-in applies. */
  defaultBranch: string | null
  httpsCredentials: { configured: boolean; helper: string | null }
  ssh: { available: boolean; version: string | null }
}
/**
 * Where the GitHub account stands. Every field is a status: an opaque reference
 * to the sealed credential, never the credential itself, so nothing here can be
 * replayed against the API.
 */
export type GitHubAccountState =
  | 'not-configured'
  | 'signed-out'
  | 'signing-in'
  | 'signed-in'
  | 'expired'
  | 'revoked'
  | 'permission-denied'
  | 'offline'
  | 'storage-unavailable'

export interface GitHubAppPermission {
  permission: string
  access: 'read' | 'write'
  /** The enabled feature that needs this permission, or null when several share it. */
  feature: string | null
}

export interface GitHubSignInChallenge {
  userCode: string
  verificationUri: string
  expiresAt: number
}

export interface GitHubAccountStatus {
  state: GitHubAccountState
  /** Opaque handle for the sealed credential held by the operating system. */
  reference: string | null
  host: string
  login: string | null
  /** The fine-grained permissions the registered app requests; never a runtime scope. */
  permissions: GitHubAppPermission[]
  expiresAt: number | null
  refreshExpiresAt: number | null
  store: { available: boolean; name: string | null; reason: string | null }
  /**
   * A device sign-in is in progress. This is reported separately from `state`
   * because the flow belongs to no credential: it survives a renewal of the
   * account that is still signed in, so the code and its cancel control stay on
   * screen until the flow itself ends.
   */
  signingIn: boolean
  challenge: GitHubSignInChallenge | null
  message: string | null
  /** A credential supplied by the environment is in use instead of the app's own. */
  externalCredential: boolean
}

export interface DesktopAPI {
  recentRepositories(): Promise<RecentRepository[]>
  openRepository(path?: string): Promise<RepositorySnapshot | null>
  /** Adds an existing local repository by absolute path, for a folder dialog or a dropped folder. */
  addRepository?(path: string): Promise<RepositorySnapshot | null>
  /** Accessible repositories for the signed-in account; paginated and cancellable. */
  searchRepositories?(
    request: RepositoryDiscoveryRequest,
  ): Promise<OnboardingResult<RepositoryDiscovery>>
  /** Git identity, default branch, HTTPS credential helper, and SSH client availability. */
  gitEnvironment?(requestId?: string): Promise<OnboardingResult<GitEnvironmentStatus>>
  /** Clones with ordinary Git, then registers the finished repository. */
  cloneRepository?(
    request: RepositoryCloneRequest,
  ): Promise<OnboardingResult<RepositoryCloneResult>>
  /** The terminal commands a clone would run, without running anything. */
  previewCloneCommand?(
    request: RepositoryCloneRequest,
  ): Promise<OnboardingResult<CloneCommandPreview>>
  /** Opens the platform folder picker for a clone destination; null when cancelled. */
  chooseDestinationDirectory?(current?: string): Promise<string | null>
  /**
   * Subscribes to folders dropped onto the window, resolved to absolute paths in
   * the preload. Returns the unsubscribe.
   */
  onRepositoryDropped?(listener: (paths: string[]) => void): () => void
  refresh(): Promise<RepositorySnapshot>
  runAction(action: GitAction): Promise<ActionResult>
  fileView(path: string): Promise<FileView>
  conflictView(path: string): Promise<ConflictFile>
  history(ref: string, skip: number, requestId?: string): Promise<HistoryPage>
  commitDiff(oid: string, requestId?: string): Promise<{ text: string; truncated: boolean }>
  pushPreview(): Promise<PushPreview>
  stackPreview(kind: StackKind, branch: string): Promise<StackPreview>
  /** The reviewed insert, move, or remove surgery for one stack. */
  surgeryPreview(request: SurgeryRequest): Promise<SurgeryPreview>
  /** Resumable Submit Stack progress left on disk, or null when nothing is pending. */
  submitStackProgress?: () => Promise<PublishProgress | null>
  /**
   * Subscribes to progress pushed by a running submission, and returns the unsubscribe. The
   * dialog uses this rather than polling, because a read queues behind the action that is
   * producing the steps.
   */
  onSubmitStackProgress?: (listener: (progress: PublishProgress | null) => void) => () => void
  /**
   * Subscribes to the running merge's own progress. A merge waits on GitHub's background
   * result, so the dialog cannot poll for it: the read queues behind the action itself.
   */
  onMergeProgress?: (listener: (progress: MergeProgress | null) => void) => () => void
  /**
   * Read-only: what GitHub now reports for merge requests made earlier, including requests it
   * is still running and pull requests it dropped from a merge queue. It submits nothing.
   */
  mergeStatus?: () => Promise<MergeStatus | null>
  reconciliationPreview?: (stackKey: string) => Promise<ReconciliationPreview>
  pullRequest(number: number): Promise<PullRequest & { body: string }>
  /** The review workspace headline: one pull request plus the stack layers around it. */
  reviewHeadline?(number: number, requestId?: string): Promise<ReviewHeadline>
  /** Every file of one pull request, read from GitHub rather than the working tree. */
  reviewFiles?(number: number, requestId?: string): Promise<ReviewFileSet>
  reviewCommits?(number: number, requestId?: string): Promise<ReviewCommitSet>
  /** Locally recorded viewed files, bound to the head they were read at. */
  reviewViewed?(number: number): Promise<ReviewViewedRecord | null>
  reviewSetViewed?(record: ReviewViewedRecord): Promise<ReviewViewedRecord>
  /** Threads and the viewer's permissions for one pull request, read from GitHub. */
  reviewThreads?(number: number, requestId?: string): Promise<ReviewThreadRead>
  /** Locally recorded pending comments, journalled beside the repository. */
  reviewDrafts?(number: number): Promise<ReviewDraftRecord | null>
  reviewSetDrafts?(record: ReviewDraftRecord): Promise<ReviewDraftRecord>
  /**
   * Where each pending draft's lines sit at the comparison on screen now. The
   * view marks a stale draft before anybody presses submit; the main process
   * revalidates again at the write boundary, so this is a warning, not the gate.
   */
  reviewResolveDrafts?(
    number: number,
    drafts: ReviewDraft[],
  ): Promise<ReviewDraftResolution[]>
  /**
   * Writes every pending comment as one review. The anchors are revalidated in
   * the main process, so a draft that no longer names its line refuses the whole
   * submission rather than being posted elsewhere, and the comparison travels
   * with it so a pull request that moved since is refused rather than
   * re-anchored onto a revision the reviewer never read.
   */
  reviewSubmit?(number: number, submission: ReviewSubmission): Promise<ReviewMutationResult>
  reviewReply?(number: number, threadId: string, body: string): Promise<ReviewMutationResult>
  reviewSetResolved?(number: number, threadId: string, resolved: boolean): Promise<ReviewMutationResult>
  reviewHistory?(number: number, requestId?: string): Promise<ReviewHistory>
  reviewHistoryDiff?(
    number: number,
    fromOid: string,
    requestId?: string,
  ): Promise<ReviewHistoryDiff>
  reviewClearHistory?(number: number): Promise<ReviewHistory>
  /** The detailed checks behind one pull request, with its own freshness and permissions. */
  pullRequestChecks?: (
    number: number,
    options?: { headSha?: string | null; base?: string | null; force?: boolean },
  ) => Promise<PullRequestChecksReport>
  /** Reruns one Actions workflow run behind a pull request's checks. */
  rerunPullRequestCheck?: (number: number, runId: number) => Promise<PullRequestChecksReport>
  listNativeStacks?: () => Promise<NativeStack[]>
  createNativeStack?: (pullRequests: number[]) => Promise<NativeStack>
  addPullRequestsToNativeStack?: (
    stackNumber: number,
    pullRequests: number[],
  ) => Promise<NativeStack>
  unstackNativeStack?: (
    stackNumber: number,
  ) => Promise<{ dissolved: boolean; stack: NativeStack | null }>
  searchIssues?: (
    query: string,
    requestId?: string,
  ) => Promise<{ issues: RepositoryIssue[]; message: string }>
  pullRequestIssueLinks?: (prNumber: number) => Promise<PullRequestIssueLinks>
  previewIssueLink?: (
    prNumber: number,
    issueNumber: number,
    relation: IssueLinkRelation,
    action: 'link' | 'unlink',
  ) => Promise<IssueLinkPreview>
  /** GitHub freshness for the open repository; never performs a read. */
  remoteStatus?(): Promise<RemoteFreshness>
  /** Tells the main process whether the window is focused and visible. */
  reportActivity?(activity: SyncActivity): Promise<void>
  /** Snapshots pushed by the background watcher and refresh timers. */
  onBackgroundSnapshot?(listener: (snapshot: RepositorySnapshot) => void): () => void
  /** Open issues pushed by the low-frequency inbox refresh. */
  onBackgroundIssues?(listener: (issues: RepositoryIssue[]) => void): () => void
  /** Freshness transitions, including offline and rate-limit suspension. */
  onRemoteStatus?(listener: (freshness: RemoteFreshness) => void): () => void
  /** Retires a listed high-impact mutation the person has taken over. */
  dismissPendingMutation?(id: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** Cancel an in-flight read by the request id the caller supplied. */
  cancel(requestId: string): Promise<void>
  gitRuntimeStatus(): Promise<GitRuntimeStatus>
  setSystemGit(enabled: boolean): Promise<GitRuntimeStatus>
  /** Status only: the account's state, permissions, and an opaque credential reference. */
  githubAccountStatus?(): Promise<GitHubAccountStatus>
  /** Starts GitHub App device sign-in and returns the one-time code to enter in a browser. */
  startGitHubSignIn?(): Promise<GitHubAccountStatus>
  /** Ends a pending sign-in without affecting an already stored credential. */
  cancelGitHubSignIn?(): Promise<GitHubAccountStatus>
  /** Removes the credential this application owns. Local repositories are untouched. */
  signOutOfGitHub?(): Promise<GitHubAccountStatus>
  /**
   * Subscribes to account changes pushed by a running sign-in, and returns the
   * unsubscribe. The renderer reads status rather than polling a long sign-in.
   */
  onGitHubAccount?: (listener: (status: GitHubAccountStatus) => void) => () => void
}

export type GitCapability = 'referenceTransactions' | 'rebaseUpdateRefs'

export interface BundledRuntimeInfo {
  gitVersion: string
  sha256: string
  source: string
  files?: Record<string, string>
}

export interface GitRuntimeInfo {
  source: 'bundled' | 'system'
  executable: string
  platform: string
  version: string
  versionOutput: string
  minimumVersion: string
  meetsMinimum: boolean
  useSystemGit: boolean
  packaged: boolean
  capabilities: Record<GitCapability, boolean>
  bundled: BundledRuntimeInfo | null
  preservedEnvironment: readonly string[]
  preservedConfiguration: readonly string[]
}

export interface GitRuntimeStatus {
  runtime: GitRuntimeInfo | null
  error: string | null
  minimumVersion: string
  useSystemGit: boolean
}
declare global {
  interface Window {
    desktop: DesktopAPI
  }
}
