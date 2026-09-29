import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopAPI,
  MergeProgress,
  PublishProgress,
  RemoteFreshness,
  RepositoryIssue,
  RepositorySnapshot,
} from '../shared/types'

const desktop: DesktopAPI = {
  recentRepositories: () => ipcRenderer.invoke('repositories:recent'),
  openRepository: (path) => ipcRenderer.invoke('repositories:open', path),
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
}

contextBridge.exposeInMainWorld('desktop', desktop)
