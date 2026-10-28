import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
} from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { safeStorageProtector } from './secret-storage'
import { createApplicationBackend } from './application'

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

const backend = createApplicationBackend({
  packaged: app.isPackaged,
  version: app.getVersion(),
  userDataPath: app.getPath('userData'),
  downloadsPath: app.getPath('downloads'),
  executablePath: app.getPath('exe'),
  resourcesRoot: app.isPackaged ? process.resourcesPath : resolve(bundleDir, '../../resources'),
  systemVersion: process.getSystemVersion(),
  electronVersion: process.versions.electron,
  secretProtector: safeStorageProtector,
  powerMonitor,
  renderer: () => (window && !window.isDestroyed() ? window.webContents : null),
  handle<Args extends unknown[]>(channel: string, listener: (...args: Args) => unknown) {
    ipcMain.handle(channel, (event, ...args) => {
      // Authenticate outside the backend's failure/cancellation handling.
      validateSender(event)
      return listener(...(args as Args))
    })
  },
  chooseDirectory: (options) => dialog.showOpenDialog(window!, options),
  saveSupportBundle: (options) => dialog.showSaveDialog(window!, options),
  openExternal: (url) => shell.openExternal(url),
  showItemInFolder: (path) => shell.showItemInFolder(path),
  relaunch: () => {
    app.relaunch()
    app.quit()
  },
  quit: () => app.quit(),
})

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

/**
 * A request from somewhere the app does not recognise. It is refused before
 * any work starts and is named as its own kind, so the failure log does not
 * fill with a page that is not this window probing every channel.
 */
class UntrustedRequestError extends Error {}
function validateSender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new UntrustedRequestError('Untrusted application request.')
  }
  const url = new URL(event.senderFrame.url)
  const origin = url.protocol === 'app:' ? `${url.protocol}//${url.host}` : url.origin
  if (origin !== trustedOrigin) throw new UntrustedRequestError('Untrusted application origin.')
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
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // A dropped folder is a path the preload resolves, not a navigation, and
      // an in-place reload of a file URL would leave the app origin entirely.
      navigateOnDragDrop: false,
      webviewTag: false,
      enableBlinkFeatures: '',
      spellcheck: false,
    },
  })
  // Nothing in this app opens a second window or embeds a document. Both are
  // refused rather than handed to the renderer, so a link or a payload cannot
  // create a page that main's sender check was never written for.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.on('closed', () => {
    window = null
    // Nothing watches or polls for a window that no longer exists.
    backend.windowClosed()
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
    // Every window this app creates is the app itself. A second one, a
    // permission request from anything that did not ask through main, or a
    // device the renderer never declared is refused here rather than left to
    // each surface.
    app.on('web-contents-created', (_event, contents) => {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('will-navigate', (event) => event.preventDefault())
      contents.on('will-attach-webview', (event) => event.preventDefault())
    })
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            `default-src 'self'; script-src 'self'${devUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${devUrl ? ` ws://${new URL(devUrl).host}` : ''}; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'; frame-ancestors 'none'`,
          ],
          'X-Content-Type-Options': ['nosniff'],
          'Referrer-Policy': ['no-referrer'],
        },
      })
    })
    const rendererRoot = resolve(bundleDir, '../renderer')
    protocol.handle('app', (request) => {
      const url = new URL(request.url)
      // Only the bundled renderer is served, only over the one host this app
      // registers, and only when the decoded path stays inside it: a traversal,
      // an encoded separator, or another host is a 404 rather than a file.
      const path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
      if (
        url.host !== 'git-stacks' ||
        !path.startsWith(`${rendererRoot}${sep}`) ||
        url.pathname.includes('%2f') ||
        url.pathname.includes('%5c')
      ) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(path).href)
    })
    await backend.start()
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
