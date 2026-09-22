import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/types'

const desktop: DesktopAPI = {
  recentRepositories: () => ipcRenderer.invoke('repositories:recent'),
  openRepository: (path) => ipcRenderer.invoke('repositories:open', path),
  refresh: () => ipcRenderer.invoke('repository:refresh'),
  runAction: (action) => ipcRenderer.invoke('repository:action', action),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
}

contextBridge.exposeInMainWorld('desktop', desktop)
