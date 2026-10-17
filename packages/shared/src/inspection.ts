import type { ChangedFile, DesktopAPI } from './types'

/** Qualified local authority; a path or display name is never sufficient. */
export interface InspectionContext {
  repositoryId: string
  worktreeId?: string
  refId?: string
  pullRequestId?: string
  /** Binds a prepared read to a main-minted authority; never authorizes a mutation. */
  operationToken?: string
}

/** Bounded directory status, without dependency/remote/stash/history assembly. */
export interface InspectionWorktreeStatus {
  path: string
  currentBranch: string | null
  headOid: string | null
  files: ChangedFile[]
  filesTruncated: boolean
  observedAt: string
}

/** Fixed named operations; every operation retains its existing main validator. */
export const INSPECTION_CHANNELS = {
  refresh: 'inspection:snapshot',
  worktreeStatus: 'inspection:worktree-status',
  cancel: 'operation:cancel',
  openInEditor: 'editor:open',
  repositoryOperationScope: 'repository:operation-scope',
  submitStackProgress: 'repository:submit-stack-progress',
  mergeStatus: 'repository:merge-status',
  stackPreview: 'repository:stack-preview',
  reviewedMergePreview: 'repository:reviewed-merge-preview',
  surgeryPreview: 'repository:surgery-preview',
  pushPreview: 'repository:push-preview',
  worktreeLifecyclePreview: 'repository:worktree-lifecycle-preview',
  nativeOperationPreview: 'repository:native-operation-preview',
  reconciliationPreview: 'repository:reconciliation-preview',
  fileView: 'repository:file',
  conflictView: 'repository:conflict',
  history: 'repository:history',
  commitDiff: 'repository:commit-diff',
  pullRequest: 'repository:pull-request',
  pullRequestPage: 'repository:pull-request-page',
  pullRequestLayer: 'repository:pull-request-layer',
  pullRequestAction: 'repository:pull-request-action',
  searchIssues: 'repository:search-issues',
  pullRequestIssueLinks: 'repository:pull-request-issue-links',
  previewIssueLink: 'repository:preview-issue-link',
  pullRequestChecks: 'repository:pull-request-checks',
  rerunPullRequestCheck: 'repository:pull-request-check-rerun',
  reviewHeadline: 'repository:review-headline',
  reviewFiles: 'repository:review-files',
  reviewCommits: 'repository:review-commits',
  reviewViewed: 'repository:review-viewed',
  reviewSetViewed: 'repository:review-set-viewed',
  reviewThreads: 'repository:review-threads',
  reviewDrafts: 'repository:review-drafts',
  reviewDraftRecovery: 'repository:review-draft-recovery',
  reviewSetDrafts: 'repository:review-set-drafts',
  reviewResolveDrafts: 'repository:review-resolve-drafts',
  reviewSubmit: 'repository:review-submit',
  reviewReply: 'repository:review-reply',
  reviewSetResolved: 'repository:review-resolve',
  reviewHistory: 'repository:review-history',
  reviewHistoryDiff: 'repository:review-history-diff',
  reviewClearHistory: 'repository:review-clear-history',
} as const
export type InspectionOperation = keyof typeof INSPECTION_CHANNELS
export type InspectionMethod<K extends InspectionOperation> = NonNullable<DesktopAPI[K]>
export type InspectionArgs<K extends InspectionOperation> = Parameters<InspectionMethod<K>>
export type InspectionResult<K extends InspectionOperation> = Awaited<
  ReturnType<InspectionMethod<K>>
>
