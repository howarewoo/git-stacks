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
import { CommandCancelled, getOriginUrl } from './git-core'
import { getGitHubIssues, getPullRequest } from './github'
import {
  getSubmitStackProgress,
  onMergeProgress,
  onPublishProgress,
  previewStack,
  previewSurgery,
  validateSurgeryRequest,
} from './stacks'
import { previewReconciliationRepair } from './reconciliation'
import { getPullRequestIssueLinks, previewIssueLink, searchGitHubIssues } from './issue-links'
import type {
  GitAction,
  MergeProgress,
  PublishProgress,
  RecentRepository,
  RepositorySnapshot,
  StackKind,
  SyncActivity,
} from '../shared/types'
import { RepositoryOperations } from './repository-operations'
import { RequestRegistry, performBackgroundRead } from './request-registry'
import { RepositoryScheduler } from './repository-scheduler'
import { RepositorySyncCoordinator } from './sync-coordinator'
import { RepositoryWatcher } from './git-watcher'
import {
  configureGitRuntime,
  gitRuntimeStatus,
  readGitRuntimePreference,
  resolveGitRuntime,
  withGitRuntime,
  writeGitRuntimePreference,
} from './git-runtime'

const readKeys = new RequestRegistry()

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

const scheduler = new RepositoryScheduler()
let watcher: RepositoryWatcher | null = null

/**
 * Background refresh reads run on the scheduler rather than the foreground
 * queue: a snapshot stuck on an unreachable network must never make a stage,
 * commit, or branch switch look busy, and a Git operation must not wait for a
 * refresh to finish.
 */
export function backgroundRead<T>(
  root: string,
  signal: AbortSignal | undefined,
  operation: (root: string, signal: AbortSignal) => Promise<T>,
  requestId: string,
): Promise<T> {
  return performBackgroundRead(
    readKeys,
    root,
    signal,
    async (combined) => {
      const runtime = await resolveGitRuntime()
      return withGitRuntime(runtime, () => operation(root, combined))
    },
    requestId,
  )
}

const sync = new RepositorySyncCoordinator({
  readSnapshot: (root, signal, request) =>
    backgroundRead(
      root,
      signal,
      (path, readSignal) => getSnapshot(path, readSignal, undefined, request.github.remote),
      request.requestId,
    ),
  readIssues: (root, signal) =>
    backgroundRead(
      root,
      signal,
      async (path, readSignal) => {
        const issues = await getGitHubIssues(path, await getOriginUrl(path, readSignal), readSignal)
        if (readSignal.aborted) throw new CommandCancelled()
        // The issues read reports a failure as text; a lost answer must not empty the inbox.
        if (issues.message) throw new Error(issues.message)
        return issues.issues
      },
      'sync-issues',
    ),
  scheduler,
})

sync.onEvent((event) => {
  if (!window || window.isDestroyed()) return
  if (event.kind === 'snapshot' && event.snapshot) {
    if (event.snapshot.path !== activeRepository) return
    const { githubStale, ...snapshot } = event.snapshot
    window.webContents.send('repository:background-snapshot', snapshot)
    return
  }
  if (event.kind === 'issues' && event.issues) {
    window.webContents.send('repository:background-issues', event.issues)
    return
  }
  if (event.kind === 'status' && event.freshness) {
    window.webContents.send('repository:remote-status', event.freshness)
  }
})

function startBackgroundSync(root: string, snapshot: RepositorySnapshot): void {
  watcher?.stop()
  watcher = new RepositoryWatcher(root, () => {
    // A commit, a branch switch, or a ref update made outside this window — and
    // the repository coming back after a move — all land the same way.
    sync.notifyLocalChange()
  })
  void watcher.start()
  sync.attach(root, snapshot)
}

function stopBackgroundSync(): void {
  watcher?.stop()
  watcher = null
  sync.detach()
}
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
const settingsFile = () => join(app.getPath('userData'), 'settings.json')

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

/**
 * Repository reads are serialised so a write never interleaves with a read.
 * Each read also claims a cancellable request id: a read that started before a
 * repository switch is ended rather than allowed to answer for the repository
 * the window is now showing.
 */
function readRepository<T>(
  operation: (root: string, signal: AbortSignal) => Promise<T>,
  requestId = 'read',
): Promise<T> {
  const root = repository()
  const controller = readKeys.claim(root, requestId)
  const superseded = () =>
    new Error('The active repository changed. Reopen this view to load its current state.')
  return operations
    .read(async () => {
      if (root !== activeRepository) throw superseded()
      const runtime = await resolveGitRuntime()
      return withGitRuntime(runtime, () => operation(root, controller.signal))
    }, controller.signal)
    .finally(() => readKeys.release(root, requestId, controller))
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
    // Retire old reads before waiting for the operation queue; a long-running
    // history/diff must not delay switching to a newly selected repository.
    if (activeRepository) readKeys.cancelRoot(activeRepository)
    stopBackgroundSync()
    return operations.switchRepository(path, async () => {
      const runtime = await resolveGitRuntime()
      return withGitRuntime(runtime, async () => {
        const snapshot = await getSnapshot(path)
        await remember(path)
        activeRepository = path
        startBackgroundSync(path, snapshot)
        return snapshot
      })
    })
  })
  ipcMain.handle('repository:refresh', async (event) => {
    validateSender(event)
    repository()
    // The person's own refresh always reads GitHub; it never reuses a payload.
    return sync.refreshNow()
  })
  ipcMain.handle('repository:status', (event) => {
    validateSender(event)
    return sync.freshness()
  })
  ipcMain.handle('repository:activity', (event, activity: unknown) => {
    validateSender(event)
    if (
      typeof activity !== 'object' ||
      activity === null ||
      typeof (activity as SyncActivity).focused !== 'boolean' ||
      typeof (activity as SyncActivity).visible !== 'boolean'
    ) {
      throw new Error('Window activity must report focus and visibility.')
    }
    sync.reportActivity(activity as SyncActivity)
  })
  ipcMain.handle('repository:dismiss-pending-mutation', (event, id: unknown) => {
    validateSender(event)
    if (typeof id !== 'string' || !id) throw new Error('A pending mutation id is required.')
    return sync.dismissPendingMutation(id)
  })
  ipcMain.handle('repository:action', async (event, action: GitAction) => {
    validateSender(event)
    const root = repository()
    try {
      // A mutation claims the repository lane: background reads end first, so a
      // stage or a commit never waits on a network that is not answering.
      return await scheduler.mutate(root, () =>
        // Naming the repository is the admission check: a switch can complete
        // while this action waited for the background reads it ends, and an
        // action must never apply to the repository the window already left.
        operations.write(async () => {
          const runtime = await resolveGitRuntime()
          return withGitRuntime(runtime, () => runAction(root, action))
        }, root),
      )
    } catch (error) {
      // A high-impact remote mutation that lost its answer is listed, never
      // re-sent: reconnecting resumes reads only.
      sync.recordMutationFailure(action, error)
      throw error
    }
  })
  ipcMain.handle('repository:file', (event, filePath: string) => {
    validateSender(event)
    return readRepository((root, signal) => getFileView(root, filePath, signal), `file:${filePath}`)
  })
  ipcMain.handle('repository:conflict', (event, filePath: string) => {
    validateSender(event)
    return readRepository((root) => getConflictView(root, filePath))
  })
  ipcMain.handle('repository:history', (event, ref: string, skip: number, requestId?: string) => {
    validateSender(event)
    return readRepository((root, signal) => getHistory(root, ref, skip, signal), requestId)
  })
  ipcMain.handle('repository:commit-diff', (event, oid: string, requestId?: string) => {
    validateSender(event)
    return readRepository((root, signal) => getCommitDiff(root, oid, signal), requestId)
  })
  ipcMain.handle('repository:push-preview', (event) => {
    validateSender(event)
    return readRepository((root) => getPushPreview(root))
  })
  ipcMain.handle('repository:stack-preview', (event, kind: StackKind, branch: string) => {
    validateSender(event)
    return readRepository(async (root, signal) =>
      previewStack(root, await getSnapshot(root, signal), kind, branch),
    )
  })
  ipcMain.handle('repository:surgery-preview', (event, request: unknown) => {
    validateSender(event)
    return readRepository(async (root, signal) =>
      previewSurgery(root, await getSnapshot(root, signal), validateSurgeryRequest(request)),
    )
  })
  ipcMain.handle('repository:reconciliation-preview', (event, stackKey: string) => {
    validateSender(event)
    return readRepository(async (root) =>
      previewReconciliationRepair(root, await getSnapshot(root), stackKey),
    )
  })
  ipcMain.handle('repository:submit-stack-progress', (event) => {
    validateSender(event)
    return readRepository((root) => getSubmitStackProgress(root))
  })
  // A running submission pushes its own progress. The renderer cannot poll for it: the read
  // queues behind the very action that is producing the steps, so it would only ever observe
  // the finished state.
  onPublishProgress((progress: PublishProgress | null) => {
    window?.webContents.send('submit-stack-progress', progress)
  })
  // A merge runs on GitHub's side, so its result arrives asynchronously. Pushing it is the
  // only way the dialog can follow it: a read would queue behind the merge itself.
  onMergeProgress((progress: MergeProgress | null) => {
    window?.webContents.send('merge-progress', progress)
  })
  ipcMain.handle('repository:pull-request', (event, number: number) => {
    validateSender(event)
    return readRepository(
      (root, signal) => getPullRequest(root, number, signal),
      `pull-request:${number}`,
    )
  })
  ipcMain.handle('repository:search-issues', (event, query: unknown, requestId?: unknown) => {
    validateSender(event)
    const q = typeof query === 'string' ? query : ''
    const reqId = typeof requestId === 'string' ? requestId : 'search-issues'
    return readRepository((root, signal) => searchGitHubIssues(root, q, signal), reqId)
  })
  ipcMain.handle('repository:pull-request-issue-links', (event, number: unknown) => {
    validateSender(event)
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
      throw new Error('Pull request number must be a positive integer')
    }
    return readRepository(
      (root, signal) => getPullRequestIssueLinks(root, number, signal),
      `issue-links:${number}`,
    )
  })
  ipcMain.handle(
    'repository:preview-issue-link',
    (event, prNumber: unknown, issueNumber: unknown, relation: unknown, action: unknown) => {
      validateSender(event)
      if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error('Pull request number must be a positive integer')
      }
      if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error('Issue number must be a positive integer')
      }
      if (relation !== 'contextual' && relation !== 'closing') {
        throw new Error('Invalid issue relation')
      }
      if (action !== 'link' && action !== 'unlink') {
        throw new Error('Invalid issue action')
      }
      return readRepository(
        (root, signal) => previewIssueLink(root, prNumber, issueNumber, relation, action, signal),
        `preview-issue-link:${prNumber}:${issueNumber}`,
      )
    },
  )
  ipcMain.handle('operation:cancel', (event, requestId: unknown) => {
    validateSender(event)
    if (typeof requestId !== 'string' || !requestId || !activeRepository) return
    readKeys.cancel(activeRepository, requestId)
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
  ipcMain.handle('git-runtime', async (event) => {
    validateSender(event)
    return operations.read(() => gitRuntimeStatus(settingsFile()))
  })
  ipcMain.handle('git-runtime:system-git', async (event, requested: unknown) => {
    validateSender(event)
    if (typeof requested !== 'boolean') throw new Error('Use system Git must be true or false.')
    return operations.write(async () => {
      await writeGitRuntimePreference(settingsFile(), { useSystemGit: requested })
      configureGitRuntime({ useSystemGit: requested })
      return gitRuntimeStatus(settingsFile())
    })
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
    // Nothing watches or polls for a window that no longer exists.
    stopBackgroundSync()
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
    const preference = await readGitRuntimePreference(settingsFile()).catch(() => null)
    configureGitRuntime({
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      resourcesRoot: app.isPackaged ? process.resourcesPath : resolve(bundleDir, '../../resources'),
      useSystemGit: preference?.useSystemGit ?? false,
    })
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
