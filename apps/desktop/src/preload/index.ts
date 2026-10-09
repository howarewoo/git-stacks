import { contextBridge, ipcRenderer, webUtils } from 'electron'
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

const desktop: DesktopAPI = {
  recentRepositories: () => ipcRenderer.invoke('repositories:recent'),
  openRepository: (path) => ipcRenderer.invoke('repositories:open', path),
  addRepository: (path) => ipcRenderer.invoke('repositories:add', path),
  searchRepositories: (request) => ipcRenderer.invoke('repositories:search', request),
  gitEnvironment: (requestId) => ipcRenderer.invoke('git-environment', requestId),
  cloneRepository: (request) => ipcRenderer.invoke('repositories:clone', request),
  previewCloneCommand: (request) => ipcRenderer.invoke('repositories:clone-preview', request),
  chooseDestinationDirectory: (current) =>
    ipcRenderer.invoke('repositories:choose-destination', current),
  onRepositoryDropped: (listener: (paths: string[]) => void) => {
    dropListeners.add(listener)
    return () => {
      dropListeners.delete(listener)
    }
  },
  refresh: () => ipcRenderer.invoke('repository:refresh'),
  prIndex: (options) => ipcRenderer.invoke('repository:pr-index', options),
  onPrIndex: (listener: (index: PullRequestIndex) => void) =>
    subscribe('repository:pr-index', listener),
  prIndexDetail: (number) => ipcRenderer.invoke('repository:pr-index-detail', number),
  conflictView: (path) => ipcRenderer.invoke('repository:conflict', path),
  runAction: (action) => ipcRenderer.invoke('repository:action', action),
  fileView: (path) => ipcRenderer.invoke('repository:file', path),
  history: (ref, skip, requestId) => ipcRenderer.invoke('repository:history', ref, skip, requestId),
  commitDiff: (oid, requestId) => ipcRenderer.invoke('repository:commit-diff', oid, requestId),
  pushPreview: () => ipcRenderer.invoke('repository:push-preview'),
  stackPreview: (kind, branch) => ipcRenderer.invoke('repository:stack-preview', kind, branch),
  surgeryPreview: (request) => ipcRenderer.invoke('repository:surgery-preview', request),
  submitStackProgress: () => ipcRenderer.invoke('repository:submit-stack-progress'),
  onSubmitStackProgress: (listener: (progress: PublishProgress | null) => void) =>
    subscribe('submit-stack-progress', listener),
  onMergeProgress: (listener: (progress: MergeProgress | null) => void) =>
    subscribe('merge-progress', listener),
  mergeStatus: () => ipcRenderer.invoke('repository:merge-status'),
  reconciliationPreview: (stackKey) =>
    ipcRenderer.invoke('repository:reconciliation-preview', stackKey),
  pullRequest: (number) => ipcRenderer.invoke('repository:pull-request', number),
  searchIssues: (query, requestId) =>
    ipcRenderer.invoke('repository:search-issues', query, requestId),
  pullRequestIssueLinks: (number) =>
    ipcRenderer.invoke('repository:pull-request-issue-links', number),
  previewIssueLink: (prNumber, issueNumber, relation, action) =>
    ipcRenderer.invoke('repository:preview-issue-link', prNumber, issueNumber, relation, action),
  reviewHeadline: (number, requestId) =>
    ipcRenderer.invoke('repository:review-headline', number, requestId),
  reviewFiles: (number, requestId) =>
    ipcRenderer.invoke('repository:review-files', number, requestId),
  reviewCommits: (number, requestId) =>
    ipcRenderer.invoke('repository:review-commits', number, requestId),
  reviewViewed: (number) => ipcRenderer.invoke('repository:review-viewed', number),
  reviewSetViewed: (record) => ipcRenderer.invoke('repository:review-set-viewed', record),
  reviewThreads: (number, requestId) =>
    ipcRenderer.invoke('repository:review-threads', number, requestId),
  reviewDrafts: (number) => ipcRenderer.invoke('repository:review-drafts', number),
  reviewResolveDrafts: (number, drafts) =>
    ipcRenderer.invoke('repository:review-resolve-drafts', number, drafts),
  reviewSetDrafts: (record) => ipcRenderer.invoke('repository:review-set-drafts', record),
  reviewSubmit: (number, submission) =>
    ipcRenderer.invoke('repository:review-submit', number, submission),
  reviewReply: (number, threadId, body) =>
    ipcRenderer.invoke('repository:review-reply', number, threadId, body),
  reviewSetResolved: (number, threadId, resolved) =>
    ipcRenderer.invoke('repository:review-resolve', number, threadId, resolved),
  reviewHistory: (number, requestId) =>
    ipcRenderer.invoke('repository:review-history', number, requestId),
  reviewHistoryDiff: (number, fromOid, requestId) =>
    ipcRenderer.invoke('repository:review-history-diff', number, fromOid, requestId),
  reviewClearHistory: (number) => ipcRenderer.invoke('repository:review-clear-history', number),
  pullRequestChecks: (number, options) =>
    ipcRenderer.invoke('repository:pull-request-checks', number, options),
  rerunPullRequestCheck: (number, runId) =>
    ipcRenderer.invoke('repository:pull-request-check-rerun', number, runId),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  cancel: (requestId) => ipcRenderer.invoke('operation:cancel', requestId),
  gitRuntimeStatus: () => ipcRenderer.invoke('git-runtime'),
  setSystemGit: (enabled) => ipcRenderer.invoke('git-runtime:system-git', enabled),
  remoteStatus: () => ipcRenderer.invoke('repository:status'),
  reportActivity: (activity) => ipcRenderer.invoke('repository:activity', activity),
  onBackgroundSnapshot: (listener: (snapshot: RepositorySnapshot) => void) =>
    subscribe('repository:background-snapshot', listener),
  onBackgroundIssues: (listener: (issues: RepositoryIssue[]) => void) =>
    subscribe('repository:background-issues', listener),
  onRemoteStatus: (listener: (freshness: RemoteFreshness) => void) =>
    subscribe('repository:remote-status', listener),
  dismissPendingMutation: (id) => ipcRenderer.invoke('repository:dismiss-pending-mutation', id),
  // A real read of the installed GitHub CLI and the account it holds. Status
  // only: no credential, no CLI output, and no path to either crosses here, and
  // there is no channel for signing in, switching account, or signing out —
  // those belong to the GitHub CLI itself.
  githubCliStatus: () => ipcRenderer.invoke('github-cli:status'),
  onGitHubCliStatus: (listener: (status: GitHubCliStatus) => void) =>
    subscribe('github-cli:status', listener),
  notificationsStatus: () => ipcRenderer.invoke('notifications:status'),
  notifications: () => ipcRenderer.invoke('notifications:inbox'),
  refreshNotifications: () => ipcRenderer.invoke('notifications:refresh'),
  cancelNotifications: () => ipcRenderer.invoke('notifications:cancel'),
  // The token crosses the bridge exactly once, in the request, together with
  // the host whose consent covers it. Nothing in this file returns it, holds
  // it, or forwards it to a listener.
  saveNotificationCredential: (token, consent, host) =>
    ipcRenderer.invoke('notifications:save-credential', token, consent, host),
  removeNotificationCredential: () => ipcRenderer.invoke('notifications:remove-credential'),
  markNotificationRead: (threadId) => ipcRenderer.invoke('notifications:mark-read', threadId),
  // Its own channel, because GitHub documents marking a thread done as a
  // different request from every other control this inbox offers.
  markNotificationDone: (threadId) => ipcRenderer.invoke('notifications:done', threadId),
  setNotificationSubscription: (threadId, action) =>
    ipcRenderer.invoke('notifications:subscription', threadId, action),
  onNotifications: (listener: (inbox: NotificationInbox) => void) =>
    subscribe('notifications', listener),
  githubHostStatus: () => ipcRenderer.invoke('github:host-status'),
  settings: () => ipcRenderer.invoke('settings'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  supportBundlePreview: () => ipcRenderer.invoke('support-bundle:preview'),
  exportSupportBundle: (previewId: string) =>
    ipcRenderer.invoke('support-bundle:export', previewId),
  openInEditor: (relativePath) => ipcRenderer.invoke('editor:open', relativePath),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  onUpdateStatus: (listener: (status: UpdateStatus) => void) =>
    subscribe('update:status', listener),
  pullRequestInbox: (request) => ipcRenderer.invoke('inbox:pull-requests', request),
  pullRequestInboxFilters: () => ipcRenderer.invoke('inbox:filters'),
  savePullRequestInboxFilters: (filters) => ipcRenderer.invoke('inbox:filters-save', filters),
  graphPreferences: () => ipcRenderer.invoke('graph:preferences'),
  saveGraphPreferences: (preferences, expectedScope) =>
    ipcRenderer.invoke('graph:preferences-save', preferences, expectedScope),
  resetGraphPreferences: (expectedScope) =>
    ipcRenderer.invoke('graph:preferences-reset', expectedScope),
}

contextBridge.exposeInMainWorld('desktop', desktop)
