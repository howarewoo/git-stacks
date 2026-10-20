import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { OperationProgress } from '@git-stacks/shared/operation-scope'
import type {
  DesktopAPI,
  GitHubCliStatus,
  MergeProgress,
  PublishProgress,
  RemoteFreshness,
  RepositoryIssue,
  RepositorySnapshot,
} from '@git-stacks/shared/types'
import type { NotificationInbox } from '@git-stacks/shared/notifications'
import type { UpdateStatus } from '@git-stacks/shared/update'
import {
  COMMAND_CANCELLATION_ATTEMPT,
  isCommandCancellationWire,
} from '@git-stacks/shared/cancellation'
import type { PullRequestIndex } from '@git-stacks/shared/pr-index'

/**
 * Dropped folders never cross the bridge as `File` objects. The preload resolves
 * them to absolute paths itself and publishes only strings, so the renderer
 * never holds a file handle it cannot validate.
 */
const dropListeners = new Set<(paths: string[]) => void>()

function reportDrop(event: DragEvent): void {
  // A dropped folder would otherwise navigate the window away from the app.
  event.preventDefault()
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((file) => webUtils.getPathForFile(file))
    .filter((path): path is string => Boolean(path))
  if (!paths.length) return
  for (const listener of dropListeners) listener(paths)
}

window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', reportDrop)

/**
 * Subscribes a renderer listener to a main-process channel and hands back the
 * unsubscribe. The event argument Electron passes is dropped here, so a payload
 * never reaches the renderer with the sender attached to it.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

/**
 * Every command is answered with a typed value or a genuine failure. A
 * cancelled command is the answer the user asked for: main resolves it with the
 * internal cancellation token rather than a rejection, and this decoder turns
 * the token back into a rejection before any `DesktopAPI` promise exists, so
 * callers keep rejection semantics and a genuine token-bearing value is never
 * delivered as a success.
 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((answer) => {
    if (isCommandCancellationWire(answer)) return Promise.reject(COMMAND_CANCELLATION_ATTEMPT)
    return answer as T
  })
}

const desktop: DesktopAPI = {
  recentRepositories: () => invoke('repositories:recent'),
  openRepository: (path) => invoke('repositories:open', path),
  addRepository: (path) => invoke('repositories:add', path),
  worktreeInventory: (request) => invoke('repositories:inventory', request),
  inspect: (context, operation, args, requestId) =>
    invoke('inspection:request', context, operation, args, requestId),
  captureOperation: (context) => invoke('operation:capture', context),
  operationSafety: (token, preview) => invoke('operation:safety', token, preview),
  executeOperation: (token, action) => invoke('operation:execute', token, action),
  operationRecords: () => invoke('operation:records'),
  worktreeLifecyclePreview: (request) => invoke('repository:worktree-lifecycle-preview', request),
  nativeOperationPreview: (request) => invoke('repository:native-operation-preview', request),
  onWorktreeInventory: (listener) => subscribe('repositories:inventory-updated', listener),
  cancelInventory: (requestId) => invoke('repositories:inventory-cancel', requestId),
  adoptWorktrees: (ids, requestId) => invoke('repositories:adopt-worktrees', ids, requestId),
  searchRepositories: (request) => invoke('repositories:search', request),
  gitEnvironment: (requestId) => invoke('git-environment', requestId),
  cloneRepository: (request) => invoke('repositories:clone', request),
  previewCloneCommand: (request) => invoke('repositories:clone-preview', request),
  chooseDestinationDirectory: (current) => invoke('repositories:choose-destination', current),
  onRepositoryDropped: (listener: (paths: string[]) => void) => {
    dropListeners.add(listener)
    return () => {
      dropListeners.delete(listener)
    }
  },
  refresh: () => invoke('repository:refresh'),
  repositoryOperationScope: () => invoke('repository:operation-scope'),
  prIndex: (options) => invoke('repository:pr-index', options),
  onPrIndex: (listener: (index: PullRequestIndex) => void) =>
    subscribe('repository:pr-index', listener),
  prIndexDetail: (number) => invoke('repository:pr-index-detail', number),
  conflictView: (path) => invoke('repository:conflict', path),
  runAction: (action) => invoke('repository:action', action),
  fileView: (path) => invoke('repository:file', path),
  history: (ref, skip, requestId) => invoke('repository:history', ref, skip, requestId),
  commitDiff: (oid, requestId) => invoke('repository:commit-diff', oid, requestId),
  pushPreview: () => invoke('repository:push-preview'),
  stackPreview: (kind, branch) => invoke('repository:stack-preview', kind, branch),
  reviewedMergePreview: (number) => invoke('repository:reviewed-merge-preview', number),
  surgeryPreview: (request) => invoke('repository:surgery-preview', request),
  submitStackProgress: () => invoke('repository:submit-stack-progress'),
  onSubmitStackProgress: (listener: (event: OperationProgress<PublishProgress>) => void) =>
    subscribe('submit-stack-progress', listener),
  onMergeProgress: (listener: (event: OperationProgress<MergeProgress>) => void) =>
    subscribe('merge-progress', listener),
  mergeStatus: () => invoke('repository:merge-status'),
  reconciliationPreview: (stackKey) => invoke('repository:reconciliation-preview', stackKey),
  pullRequest: (number) => invoke('repository:pull-request', number),
  pullRequestPage: (state, cursor) => invoke('repository:pull-request-page', state, cursor),
  pullRequestLayer: (sourceNumber, memberNumber, requestId) =>
    invoke('repository:pull-request-layer', sourceNumber, memberNumber, requestId),
  pullRequestAction: (action, expectedScope) =>
    invoke('repository:pull-request-action', action, expectedScope),
  searchIssues: (query, requestId) => invoke('repository:search-issues', query, requestId),
  pullRequestIssueLinks: (number) => invoke('repository:pull-request-issue-links', number),
  previewIssueLink: (prNumber, issueNumber, relation, action) =>
    invoke('repository:preview-issue-link', prNumber, issueNumber, relation, action),
  reviewHeadline: (number, requestId) => invoke('repository:review-headline', number, requestId),
  reviewFiles: (number, requestId) => invoke('repository:review-files', number, requestId),
  reviewCommits: (number, requestId) => invoke('repository:review-commits', number, requestId),
  reviewViewed: (number) => invoke('repository:review-viewed', number),
  reviewSetViewed: (record, owner) => invoke('repository:review-set-viewed', record, owner),
  reviewThreads: (number, requestId) => invoke('repository:review-threads', number, requestId),
  reviewDrafts: (number) => invoke('repository:review-drafts', number),
  reviewDraftRecovery: (selected) => invoke('repository:review-draft-recovery', selected),
  reviewResolveDrafts: (number, drafts) =>
    invoke('repository:review-resolve-drafts', number, drafts),
  reviewSetDrafts: (record, expectedUpdatedAt) =>
    invoke('repository:review-set-drafts', record, expectedUpdatedAt),
  reviewSubmit: (number, submission) => invoke('repository:review-submit', number, submission),
  reviewReply: (number, threadId, body, owner) =>
    invoke('repository:review-reply', number, threadId, body, owner),
  reviewSetResolved: (number, threadId, resolved, owner) =>
    invoke('repository:review-resolve', number, threadId, resolved, owner),
  reviewHistory: (number, requestId) => invoke('repository:review-history', number, requestId),
  reviewHistoryDiff: (number, fromOid, requestId) =>
    invoke('repository:review-history-diff', number, fromOid, requestId),
  reviewClearHistory: (number, owner) => invoke('repository:review-clear-history', number, owner),
  pullRequestChecks: (number, options) => invoke('repository:pull-request-checks', number, options),
  rerunPullRequestCheck: (number, runId) =>
    invoke('repository:pull-request-check-rerun', number, runId),
  openExternal: (url) => invoke('external:open', url),
  cancel: (requestId) => invoke('operation:cancel', requestId),
  gitRuntimeStatus: () => invoke('git-runtime'),
  setSystemGit: (enabled) => invoke('git-runtime:system-git', enabled),
  remoteStatus: () => invoke('repository:status'),
  reportActivity: (activity) => invoke('repository:activity', activity),
  onBackgroundSnapshot: (listener: (snapshot: RepositorySnapshot) => void) =>
    subscribe('repository:background-snapshot', listener),
  onBackgroundIssues: (listener: (issues: RepositoryIssue[]) => void) =>
    subscribe('repository:background-issues', listener),
  onRemoteStatus: (listener: (freshness: RemoteFreshness) => void) =>
    subscribe('repository:remote-status', listener),
  dismissPendingMutation: (id) => invoke('repository:dismiss-pending-mutation', id),
  // A real read of the installed GitHub CLI and the account it holds. Status
  // only: no credential, no CLI output, and no path to either crosses here, and
  // there is no channel for signing in, switching account, or signing out —
  // those belong to the GitHub CLI itself.
  githubCliStatus: () => invoke('github-cli:status'),
  onGitHubCliStatus: (listener: (status: GitHubCliStatus) => void) =>
    subscribe('github-cli:status', listener),
  notificationsStatus: () => invoke('notifications:status'),
  notifications: () => invoke('notifications:inbox'),
  refreshNotifications: () => invoke('notifications:refresh'),
  cancelNotifications: () => invoke('notifications:cancel'),
  // The token crosses the bridge exactly once, in the request, together with
  // the host whose consent covers it. Nothing in this file returns it, holds
  // it, or forwards it to a listener.
  saveNotificationCredential: (token, consent, host) =>
    invoke('notifications:save-credential', token, consent, host),
  removeNotificationCredential: () => invoke('notifications:remove-credential'),
  markNotificationRead: (threadId) => invoke('notifications:mark-read', threadId),
  // Its own channel, because GitHub documents marking a thread done as a
  // different request from every other control this inbox offers.
  markNotificationDone: (threadId) => invoke('notifications:done', threadId),
  setNotificationSubscription: (threadId, action) =>
    invoke('notifications:subscription', threadId, action),
  onNotifications: (listener: (inbox: NotificationInbox) => void) =>
    subscribe('notifications', listener),
  githubHostStatus: () => invoke('github:host-status'),
  settings: () => invoke('settings'),
  updateSettings: (patch) => invoke('settings:update', patch),
  resetSettings: () => invoke('settings:reset'),
  diagnostics: () => invoke('diagnostics'),
  supportBundlePreview: () => invoke('support-bundle:preview'),
  exportSupportBundle: (previewId: string) => invoke('support-bundle:export', previewId),
  openInEditor: (relativePath) => invoke('editor:open', relativePath),
  updateStatus: () => invoke('update:status'),
  checkForUpdates: () => invoke('update:check'),
  downloadUpdate: () => invoke('update:download'),
  installUpdate: () => invoke('update:install'),
  cancelUpdate: () => invoke('update:cancel'),
  revealDownloadedUpdate: () => invoke('update:reveal-downloaded'),
  onUpdateStatus: (listener: (status: UpdateStatus) => void) =>
    subscribe('update:status', listener),
  reportUpdateReadiness: (report) => invoke('update:report-readiness', report),
  onPrepareUpdateReadiness: (listener: (payload: { nonce: string }) => void) =>
    subscribe('update:prepare-readiness', listener),
  onUpdateAdmissionSettled: (listener: (payload: { admitted: boolean; nonce?: string }) => void) =>
    subscribe('update:admission-settled', listener),
  pullRequestInbox: (request) => invoke('inbox:pull-requests', request),
  pullRequestInboxFilters: () => invoke('inbox:filters'),
  savePullRequestInboxFilters: (filters) => invoke('inbox:filters-save', filters),
}

contextBridge.exposeInMainWorld('desktop', desktop)
