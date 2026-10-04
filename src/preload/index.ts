import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  DesktopAPI,
  GitHubCliStatus,
  MergeProgress,
  PublishProgress,
  RemoteFreshness,
  RepositoryIssue,
  RepositorySnapshot,
} from '../shared/types'
import type { NotificationInbox } from '../shared/notifications'
import type { UpdateStatus } from '../shared/update'

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
  conflictView: (path) => ipcRenderer.invoke('repository:conflict', path),
  runAction: (action) => ipcRenderer.invoke('repository:action', action),
  fileView: (path) => ipcRenderer.invoke('repository:file', path),
  history: (ref, skip, requestId) => ipcRenderer.invoke('repository:history', ref, skip, requestId),
  commitDiff: (oid, requestId) => ipcRenderer.invoke('repository:commit-diff', oid, requestId),
  pushPreview: () => ipcRenderer.invoke('repository:push-preview'),
  stackPreview: (kind, branch) => ipcRenderer.invoke('repository:stack-preview', kind, branch),
  surgeryPreview: (request) => ipcRenderer.invoke('repository:surgery-preview', request),
  submitStackProgress: () => ipcRenderer.invoke('repository:submit-stack-progress'),
  onSubmitStackProgress: (listener: (progress: PublishProgress | null) => void) => {
    const handler = (_event: unknown, progress: PublishProgress | null): void => listener(progress)
    ipcRenderer.on('submit-stack-progress', handler)
    return () => {
      ipcRenderer.removeListener('submit-stack-progress', handler)
    }
  },
  onMergeProgress: (listener: (progress: MergeProgress | null) => void) => {
    const handler = (_event: unknown, progress: MergeProgress | null): void => listener(progress)
    ipcRenderer.on('merge-progress', handler)
    return () => {
      ipcRenderer.removeListener('merge-progress', handler)
    }
  },
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
  onBackgroundSnapshot: (listener) => {
    const handler = (_event: unknown, snapshot: RepositorySnapshot): void => listener(snapshot)
    ipcRenderer.on('repository:background-snapshot', handler)
    return () => {
      ipcRenderer.removeListener('repository:background-snapshot', handler)
    }
  },
  onBackgroundIssues: (listener) => {
    const handler = (_event: unknown, issues: RepositoryIssue[]): void => listener(issues)
    ipcRenderer.on('repository:background-issues', handler)
    return () => {
      ipcRenderer.removeListener('repository:background-issues', handler)
    }
  },
  onRemoteStatus: (listener) => {
    const handler = (_event: unknown, freshness: RemoteFreshness): void => listener(freshness)
    ipcRenderer.on('repository:remote-status', handler)
    return () => {
      ipcRenderer.removeListener('repository:remote-status', handler)
    }
  },
  dismissPendingMutation: (id) => ipcRenderer.invoke('repository:dismiss-pending-mutation', id),
  // A real read of the installed GitHub CLI and the account it holds. Status
  // only: no credential, no CLI output, and no path to either crosses here, and
  // there is no channel for signing in, switching account, or signing out —
  // those belong to the GitHub CLI itself.
  githubCliStatus: () => ipcRenderer.invoke('github-cli:status'),
  onGitHubCliStatus: (listener: (status: GitHubCliStatus) => void) => {
    const handler = (_event: unknown, status: GitHubCliStatus): void => listener(status)
    ipcRenderer.on('github-cli:status', handler)
    return () => {
      ipcRenderer.removeListener('github-cli:status', handler)
    }
  },
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
  onNotifications: (listener: (inbox: NotificationInbox) => void) => {
    const handler = (_event: unknown, inbox: NotificationInbox): void => listener(inbox)
    ipcRenderer.on('notifications', handler)
    return () => {
      ipcRenderer.removeListener('notifications', handler)
    }
  },
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
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => {
    const handler = (_event: unknown, status: UpdateStatus): void => listener(status)
    ipcRenderer.on('update:status', handler)
    return () => {
      ipcRenderer.removeListener('update:status', handler)
    }
  },
  pullRequestInbox: (request) => ipcRenderer.invoke('inbox:pull-requests', request),
  pullRequestInboxFilters: () => ipcRenderer.invoke('inbox:filters'),
  savePullRequestInboxFilters: (filters) => ipcRenderer.invoke('inbox:filters-save', filters),
}

contextBridge.exposeInMainWorld('desktop', desktop)
