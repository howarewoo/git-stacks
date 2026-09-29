import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/types'

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
  reconciliationPreview: (stackKey) =>
    ipcRenderer.invoke('repository:reconciliation-preview', stackKey),
  pullRequest: (number) => ipcRenderer.invoke('repository:pull-request', number),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  cancel: (requestId) => ipcRenderer.invoke('operation:cancel', requestId),
  gitRuntimeStatus: () => ipcRenderer.invoke('git-runtime'),
  setSystemGit: (enabled) => ipcRenderer.invoke('git-runtime:system-git', enabled),
}

contextBridge.exposeInMainWorld('desktop', desktop)
