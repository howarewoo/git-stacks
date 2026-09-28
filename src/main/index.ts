import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join, resolve, sep, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  getSnapshot,
  resolveRepository,
  runAction,
  getFileView,
  getConflictView,
  getHistory,
  getCommitDiff,
  getPushPreview,
} from './git'
import { previewStack } from './stacks'
import { getPullRequest } from './github'
import type { GitAction, RecentRepository, StackKind } from '../shared/types'
import { RepositoryOperations } from './repository-operations'

const bundleDir = dirname(fileURLToPath(import.meta.url))
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// Finder launches do not inherit a shell PATH; include common Git/gh installation locations.
process.env.PATH = [
  ...new Set([
    ...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':'),
    ...(process.platform === 'win32'
      ? []
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']),
  ]),
]
  .filter(Boolean)
  .join(process.platform === 'win32' ? ';' : ':')

if (!app.isPackaged && process.env.GIT_STACKS_USER_DATA) {
  app.setPath('userData', resolve(process.env.GIT_STACKS_USER_DATA))
}

let window: BrowserWindow | null = null
let activeRepository: string | null = null
let recents: RecentRepository[] = []
const operations = new RepositoryOperations()
const productionOrigin = 'app://git-stacks'
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
if (devUrl) {
  const parsed = new URL(devUrl)
  if (
    parsed.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) {
    throw new Error('The development renderer must run on a local HTTP server.')
  }
}
const trustedOrigin = devUrl ? new URL(devUrl).origin : productionOrigin
const settingsPath = () => join(app.getPath('userData'), 'repositories.json')

function validateSender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error('Untrusted application request.')
  }
  const url = new URL(event.senderFrame.url)
  const origin = url.protocol === 'app:' ? `${url.protocol}//${url.host}` : url.origin
  if (origin !== trustedOrigin) throw new Error('Untrusted application origin.')
}

function repository() {
  if (!activeRepository) throw new Error('Open a local Git repository first.')
  return activeRepository
}

function readRepository<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = repository()
  return operations.read(() => {
    if (root !== activeRepository) {
      throw new Error('The active repository changed. Reopen this view to load its current state.')
    }
    return operation(root)
  })
}

async function remember(path: string) {
  const next = [
    { path, name: basename(path) },
    ...recents.filter((item) => item.path !== path),
  ].slice(0, 12)
  await mkdir(dirname(settingsPath()), { recursive: true })
  await writeFile(`${settingsPath()}.tmp`, JSON.stringify(next), { mode: 0o600 })
  await rename(`${settingsPath()}.tmp`, settingsPath())
  recents = next
}

function installHandlers() {
  ipcMain.handle('repositories:recent', (event) => {
    validateSender(event)
    return recents
  })
  ipcMain.handle('repositories:open', async (event, requestedPath: unknown) => {
    validateSender(event)
    return operations.write(async () => {
      let selected: string
      if (requestedPath !== undefined) {
        if (
          typeof requestedPath !== 'string' ||
          !recents.some((item) => item.path === requestedPath)
        ) {
          throw new Error('Use Open repository to choose a new folder.')
        }
        selected = requestedPath
      } else {
        const result = await dialog.showOpenDialog(window!, {
          title: 'Open Git repository',
          properties: ['openDirectory'],
          buttonLabel: 'Open repository',
        })
        if (result.canceled || !result.filePaths[0]) return null
        selected = result.filePaths[0]
      }
      const path = await resolveRepository(selected)
      const snapshot = await getSnapshot(path)
      await remember(path)
      activeRepository = path
      return snapshot
    })
  })
  ipcMain.handle('repository:refresh', async (event) => {
    validateSender(event)
    return readRepository(getSnapshot)
  })
  ipcMain.handle('repository:action', async (event, action: GitAction) => {
    validateSender(event)
    return operations.write(() => runAction(repository(), action))
  })
  ipcMain.handle('repository:file', (event, filePath: string) => {
    validateSender(event)
    return readRepository((root) => getFileView(root, filePath))
  })
  ipcMain.handle('repository:conflict', (event, filePath: string) => {
    validateSender(event)
    return readRepository((root) => getConflictView(root, filePath))
  })
  ipcMain.handle('repository:history', (event, ref: string, skip: number) => {
    validateSender(event)
    return readRepository((root) => getHistory(root, ref, skip))
  })
  ipcMain.handle('repository:commit-diff', (event, oid: string) => {
    validateSender(event)
    return readRepository((root) => getCommitDiff(root, oid))
  })
  ipcMain.handle('repository:push-preview', (event) => {
    validateSender(event)
    return readRepository(getPushPreview)
  })
  ipcMain.handle('repository:stack-preview', (event, kind: StackKind, branch: string) => {
    validateSender(event)
    return readRepository(async (root) => {
      return previewStack(root, await getSnapshot(root), kind, branch)
    })
  })
  ipcMain.handle('repository:pull-request', (event, number: number) => {
    validateSender(event)
    return readRepository((root) => getPullRequest(root, number))
  })
  ipcMain.handle('external:open', async (event, value: unknown) => {
    validateSender(event)
    if (typeof value !== 'string') throw new Error('Invalid GitHub URL.')
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password
    ) {
      throw new Error('Only HTTPS links on github.com can be opened.')
    }
    await shell.openExternal(url.href)
  })
}

async function createWindow() {
  window = new BrowserWindow({
    title: 'Git Stacks',
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#e8ecf3',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(bundleDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.on('closed', () => {
    window = null
  })
  if (devUrl) await window.loadURL(devUrl)
  else await window.loadURL(`${productionOrigin}/index.html`)
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            `default-src 'self'; script-src 'self'${devUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${devUrl ? ` ws://${new URL(devUrl).host}` : ''}; object-src 'none'; base-uri 'none'; frame-src 'none'`,
          ],
        },
      })
    })
    const rendererRoot = resolve(bundleDir, '../renderer')
    protocol.handle('app', (request) => {
      const url = new URL(request.url)
      const path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
      if (url.host !== 'git-stacks' || !path.startsWith(`${rendererRoot}${sep}`)) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(path).href)
    })
    try {
      const stored: unknown = JSON.parse(await readFile(settingsPath(), 'utf8'))
      if (Array.isArray(stored))
        recents = stored
          .filter(
            (item): item is RecentRepository =>
              item && typeof item.path === 'string' && typeof item.name === 'string',
          )
          .slice(0, 12)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('Could not read recent repositories:', error)
    }
    // Development/smoke runs can use a disposable repository without touching the user's preferences.
    if (!app.isPackaged && process.env.GIT_STACKS_REPO) {
      const path = await resolveRepository(process.env.GIT_STACKS_REPO)
      recents = [{ path, name: basename(path) }, ...recents.filter((item) => item.path !== path)]
    }
    installHandlers()
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        { role: 'fileMenu' },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
          ],
        },
        { role: 'windowMenu' },
      ]),
    )
    await createWindow()
    app.on('activate', () => {
      if (!window) void createWindow()
    })
  })
  .catch((error) => {
    dialog.showErrorBox(
      'Git Stacks could not start',
      error instanceof Error ? error.message : String(error),
    )
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
