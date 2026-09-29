import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI, PublishProgress } from '../shared/types'

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
  submitStackProgress: () => ipcRenderer.invoke('repository:submit-stack-progress'),
  onSubmitStackProgress: (listener: (progress: PublishProgress | null) => void) => {
    const handler = (_event: unknown, progress: PublishProgress | null): void => listener(progress)
    ipcRenderer.on('submit-stack-progress', handler)
    return () => {
      ipcRenderer.removeListener('submit-stack-progress', handler)
    }
  },
  reconciliationPreview: (stackKey) =>
    ipcRenderer.invoke('repository:reconciliation-preview', stackKey),
  pullRequest: (number) => ipcRenderer.invoke('repository:pull-request', number),
  searchIssues: (query, requestId) =>
    ipcRenderer.invoke('repository:search-issues', query, requestId),
  pullRequestIssueLinks: (number) =>
    ipcRenderer.invoke('repository:pull-request-issue-links', number),
  previewIssueLink: (prNumber, issueNumber, relation, action) =>
    ipcRenderer.invoke('repository:preview-issue-link', prNumber, issueNumber, relation, action),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  cancel: (requestId) => ipcRenderer.invoke('operation:cancel', requestId),
  gitRuntimeStatus: () => ipcRenderer.invoke('git-runtime'),
  setSystemGit: (enabled) => ipcRenderer.invoke('git-runtime:system-git', enabled),
}

contextBridge.exposeInMainWorld('desktop', desktop)
