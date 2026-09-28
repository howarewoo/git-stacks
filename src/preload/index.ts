import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/types'

const desktop: DesktopAPI = {
  recentRepositories: () => ipcRenderer.invoke('repositories:recent'),
  openRepository: (path) => ipcRenderer.invoke('repositories:open', path),
  refresh: () => ipcRenderer.invoke('repository:refresh'),
  runAction: (action) => ipcRenderer.invoke('repository:action', action),
  fileView: (path) => ipcRenderer.invoke('repository:file', path),
  history: (ref, skip) => ipcRenderer.invoke('repository:history', ref, skip),
  commitDiff: (oid) => ipcRenderer.invoke('repository:commit-diff', oid),
  pushPreview: () => ipcRenderer.invoke('repository:push-preview'),
  stackPreview: (kind, branch) => ipcRenderer.invoke('repository:stack-preview', kind, branch),
  submitStackProgress: () => ipcRenderer.invoke('repository:submit-stack-progress'),
  reconciliationPreview: (stackKey) =>
    ipcRenderer.invoke('repository:reconciliation-preview', stackKey),
  pullRequest: (number) => ipcRenderer.invoke('repository:pull-request', number),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
}

contextBridge.exposeInMainWorld('desktop', desktop)
