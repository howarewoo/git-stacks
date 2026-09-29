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
  getMergeStatus,
  getSubmitStackProgress,
  onMergeProgress,
  onPublishProgress,
  previewStack,
  previewSurgery,
  validateSurgeryRequest,
} from './stacks'
import { previewReconciliationRepair } from './reconciliation'
import { getPullRequestIssueLinks, previewIssueLink, searchGitHubIssues } from './issue-links'
import {
  originRemote,
  readReviewCommits,
  readReviewFiles,
  readReviewHeadline,
} from './review'
import { readViewedRecord, writeViewedRecord } from './review-viewed'
import { clearReviewHistory, readReviewHistory, readReviewHistoryDiff } from './review-history'
import { readReviewDrafts, writeReviewDrafts } from './review-drafts'
import {
  readReviewPermissions,
  readReviewThreads,
  replyToThread,
  resolveReviewDraftsAt,
  setThreadResolved,
  submitReview,
} from './review-threads'
import { getPullRequestChecks, rerunPullRequestCheck } from './pull-request-checks'
import type { PullRequestChecksOptions } from './pull-request-checks'
import type {
  ReviewDraft,
  ReviewDraftRecord,
  ReviewEvent,
  ReviewSubmission,
} from '../shared/review-threads'
import { REVIEW_EVENTS } from '../shared/review-threads'
import type { ReviewComparison, ReviewLineRef, ReviewViewedRecord } from '../shared/review'
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
import { CredentialVault } from './credentials'
import { safeStorageProtector } from './secret-storage'
import { GitHubAccount } from './github-account'

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
let account: GitHubAccount | null = null

/**
 * The signed-in GitHub account. Its credential is sealed by the operating
 * system and never reaches the renderer: the bridge carries status only.
 */
function githubAccount() {
  account ??= new GitHubAccount({
    vault: new CredentialVault(
      join(app.getPath('userData'), 'credentials.vault.json'),
      safeStorageProtector,
    ),
    stateFile: join(app.getPath('userData'), 'github-account.json'),
    onChange: (status) => window?.webContents.send('github-account', status),
  })
  return account
}

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

function requirePullRequestNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('Choose a pull request to review.')
  }
  return value
}

function requestIdClaim(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

function requireViewedRecord(value: unknown): ReviewViewedRecord {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid viewed-file record.')
  }
  const record = value as Record<string, unknown>
  const paths = record.paths
  if (
    typeof record.number !== 'number' ||
    !Number.isInteger(record.number) ||
    record.number <= 0 ||
    !Array.isArray(paths) ||
    paths.length > 5000 ||
    !paths.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length < 4096) ||
    !isComparisonLike(record.comparison) ||
    typeof record.updatedAt !== 'string'
  ) {
    throw new Error('Invalid viewed-file record.')
  }
  return {
    number: record.number,
    comparison: readComparison(record.comparison),
    paths: [...new Set(paths as string[])],
    updatedAt: record.updatedAt,
  }
}

/**
 * A comparison crossing the bridge is three optional object ids and a branch
 * name. Anything that is not that shape is refused outright rather than coerced,
 * so a record cannot reach the store already missing half of what it claims to
 * be bound to.
 */
function isComparisonLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const comparison = value as Record<string, unknown>
  return (
    (comparison.headOid === null || typeof comparison.headOid === 'string') &&
    (comparison.baseOid === null || typeof comparison.baseOid === 'string') &&
    (comparison.baseRef === null || typeof comparison.baseRef === 'string')
  )
}

function readComparison(value: unknown): ReviewComparison {
  const comparison = value as Record<string, unknown>
  return {
    headOid: typeof comparison.headOid === 'string' ? comparison.headOid : null,
    baseOid: typeof comparison.baseOid === 'string' ? comparison.baseOid : null,
    baseRef: typeof comparison.baseRef === 'string' ? comparison.baseRef : null,
  }
}

// The viewed-file validator already accepts every field of a comparison, so a
// pending-draft record is held to the same shape rather than a second notion of
// what a comparison is.
function requireComparison(value: unknown): ReviewComparison {
  if (!isComparisonLike(value)) {
    throw new Error('Invalid review comparison.')
  }
  return readComparison(value)
}

function requireLineRef(value: unknown): ReviewLineRef {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid review line address.')
  const ref = value as Record<string, unknown>
  if (
    typeof ref.path !== 'string' ||
    ref.path === '' ||
    ref.path.length > 4096 ||
    (ref.side !== 'base' && ref.side !== 'head') ||
    typeof ref.line !== 'number' ||
    !Number.isInteger(ref.line) ||
    ref.line <= 0 ||
    typeof ref.anchor !== 'string' ||
    ref.anchor === '' ||
    typeof ref.context !== 'string'
  ) {
    throw new Error('Invalid review line address.')
  }
  return {
    path: ref.path,
    side: ref.side,
    line: ref.line,
    hunkId: typeof ref.hunkId === 'string' ? ref.hunkId : '',
    anchor: ref.anchor,
    context: ref.context,
  }
}
function requireCommitOid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{4,64}$/i.test(value)) {
    throw new Error('Invalid commit identifier.')
  }
  return value
}


function requireDraft(value: unknown): ReviewDraft {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid review comment draft.')
  const draft = value as Record<string, unknown>
  if (typeof draft.id !== 'string' || draft.id === '' || draft.id.length > 128) {
    throw new Error('Invalid review comment draft.')
  }
  if (typeof draft.body !== 'string' || draft.body.length > 65_536) {
    throw new Error('Invalid review comment draft.')
  }
  if (draft.startRef !== null && draft.startRef !== undefined) {
    return {
      id: draft.id,
      ref: requireLineRef(draft.ref),
      startRef: requireLineRef(draft.startRef),
      body: draft.body,
      createdAt: typeof draft.createdAt === 'string' ? draft.createdAt : '',
    }
  }
  return {
    id: draft.id,
    ref: requireLineRef(draft.ref),
    startRef: null,
    body: draft.body,
    createdAt: typeof draft.createdAt === 'string' ? draft.createdAt : '',
  }
}

function requireDraftRecord(value: unknown): ReviewDraftRecord {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid review draft record.')
  const record = value as Record<string, unknown>
  if (
    typeof record.number !== 'number' ||
    !Number.isInteger(record.number) ||
    record.number <= 0 ||
    !Array.isArray(record.drafts) ||
    record.drafts.length > 200 ||
    typeof record.comparison !== 'object' ||
    record.comparison === null ||
    typeof record.updatedAt !== 'string'
  ) {
    throw new Error('Invalid review draft record.')
  }
  // The repository and the account own the record, and the journal is shared
  // across repositories and accounts, so both are required rather than
  // defaulted. Defaulting them would let a record from elsewhere in the file be
  // claimed by whichever pull request happens to be open.
  if (typeof record.repo !== 'string' || record.repo === '' || record.repo.length > 512) {
    throw new Error('Invalid review draft record.')
  }
  if (typeof record.viewer !== 'string' || record.viewer.length > 128) {
    throw new Error('Invalid review draft record.')
  }
  return {
    number: record.number,
    repo: record.repo,
    viewer: record.viewer,
    // The whole comparison, because a draft's line numbers mean nothing outside
    // the diff they were read from.
    comparison: requireComparison(record.comparison),
    drafts: record.drafts.map(requireDraft),
    updatedAt: record.updatedAt,
  }
}


function requireSubmission(value: unknown): ReviewSubmission {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid review submission.')
  const submission = value as Record<string, unknown>
  const event = submission.event
  if (typeof event !== 'string' || !REVIEW_EVENTS.includes(event as ReviewEvent)) {
    throw new Error('Choose comment, approve, or request changes.')
  }
  if (typeof submission.body !== 'string' || submission.body.length > 65_536) {
    throw new Error('Invalid review submission.')
  }
  if (!Array.isArray(submission.drafts) || submission.drafts.length > 200) {
    throw new Error('Invalid review submission.')
  }
  if (typeof submission.comparison !== 'object' || submission.comparison === null) {
    throw new Error('Invalid review submission.')
  }
  return {
    event: event as ReviewEvent,
    body: submission.body,
    drafts: submission.drafts.map(requireDraft),
    // The comparison the diff was rendered from. Without it the backend cannot
    // tell a review of what the reviewer read from a review of whatever the head
    // has become, so it is required rather than assumed.
    comparison: requireComparison(submission.comparison),
  }
}

function requireThreadId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 256) {
    throw new Error('Choose a comment thread on this pull request.')
  }
  return value
}

function requireCommentBody(value: unknown): string {
  if (typeof value !== 'string' || value.length > 65_536) {
    throw new Error('Invalid comment body.')
  }
  return value
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
  // Read-only: a queue outcome or a still-running request is read from the journal and GitHub,
  // never by asking for another merge.
  ipcMain.handle('repository:merge-status', (event) => {
    validateSender(event)
    return readRepository((root) => getMergeStatus(root))
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

  // The review workspace loads in stages: the headline answers first so the
  // title, lifecycle, and stack position are readable while the file list is
  // still being fetched. Each stage claims its own request id, so moving to
  // another pull request cancels the read that is now obsolete instead of
  // letting it answer for a pull request nobody is looking at.
  ipcMain.handle('repository:review-headline', (event, number: unknown, requestId?: unknown) => {
    validateSender(event)
    return readRepository(
      (root, signal) => readReviewHeadline(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-headline'),
    )
  })
  ipcMain.handle('repository:review-files', (event, number: unknown, requestId?: unknown) => {
    validateSender(event)
    return readRepository(
      (root, signal) => readReviewFiles(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-files'),
    )
  })
  ipcMain.handle('repository:review-commits', (event, number: unknown, requestId?: unknown) => {
    validateSender(event)
    return readRepository(
      (root, signal) => readReviewCommits(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-commits'),
    )
  })
  ipcMain.handle('repository:review-viewed', (event, number: unknown) => {
    validateSender(event)
    return readRepository((root, signal) =>
      readViewedRecord(root, requirePullRequestNumber(number), signal),
    )
  })
  ipcMain.handle('repository:review-set-viewed', (event, value: unknown) => {
    validateSender(event)
    return readRepository((root, signal) =>
      writeViewedRecord(root, requireViewedRecord(value), signal),
    )
  })
  ipcMain.handle('repository:review-threads', (event, number: unknown, requestId?: unknown) => {
    validateSender(event)
    return readRepository(
      (root, signal) => readReviewThreads(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-threads'),
    )
  })
  ipcMain.handle('repository:review-drafts', (event, number: unknown) => {
    validateSender(event)
    return readRepository(async (root, signal) => {
      const remote = await originRemote(root, signal)
      // The journal is shared by every worktree of the repository, so the record
      // is what says whose drafts these are. Reading them without naming the
      // account and the repository would hand one account another's unsent
      // words to submit.
      const permissions = await readReviewPermissions(root, requirePullRequestNumber(number), signal)
      return readReviewDrafts(
        root,
        `${remote.owner}/${remote.name}`,
        permissions.viewer,
        requirePullRequestNumber(number),
        signal,
      )
    })
  })
  ipcMain.handle('repository:review-set-drafts', (event, value: unknown) => {
    validateSender(event)
    return readRepository(async (root, signal) => {
      const incoming = requireDraftRecord(value)
      const remote = await originRemote(root, signal)
      // The repository and the account are stamped here, from the ones Git and
      // GitHub name, rather than taken from the renderer. The renderer does not
      // know either, and a record that adopted a caller-supplied owner would be
      // exactly the record that could be planted under the wrong one.
      const permissions = await readReviewPermissions(root, incoming.number, signal)
      return writeReviewDrafts(
        root,
        { ...incoming, repo: `${remote.owner}/${remote.name}`, viewer: permissions.viewer },
        signal,
      )
    })
  })
  ipcMain.handle('repository:review-submit', (event, number: unknown, value: unknown) => {
    validateSender(event)
    return operations.write(async () => {
      const runtime = await resolveGitRuntime()
      return withGitRuntime(runtime, () =>
        submitReview(repository(), requirePullRequestNumber(number), requireSubmission(value)),
      )
    })
  })
  ipcMain.handle('repository:review-reply', (event, number: unknown, threadId: unknown, body: unknown) => {
    validateSender(event)
    return operations.write(async () => {
      const runtime = await resolveGitRuntime()
      return withGitRuntime(runtime, () =>
        replyToThread(
          repository(),
          requirePullRequestNumber(number),
          requireThreadId(threadId),
          requireCommentBody(body),
        ),
      )
    })
  })
  ipcMain.handle('repository:review-resolve', (event, number: unknown, threadId: unknown, resolved: unknown) => {
    validateSender(event)
    if (typeof resolved !== 'boolean') throw new Error('Choose whether to resolve this thread.')
    return operations.write(async () => {
      const runtime = await resolveGitRuntime()
      return withGitRuntime(runtime, () =>
        setThreadResolved(repository(), requireThreadId(threadId), resolved),
      )
    })
  })
  ipcMain.handle('repository:review-resolve-drafts', (event, number: unknown, value: unknown) => {
    validateSender(event)
    return readRepository((root, signal) =>
      resolveReviewDraftsAt(
        root,
        requirePullRequestNumber(number),
        Array.isArray(value) ? value.map(requireDraft) : [],
        signal,
      ),
    )
  })
  ipcMain.handle('repository:review-history', (event, number: unknown, requestId?: unknown) => {
    validateSender(event)
    return readRepository(
      (root, signal) => readReviewHistory(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-history'),
    )
  })
  ipcMain.handle(
    'repository:review-history-diff',
    (event, number: unknown, fromOid: unknown, requestId?: unknown) => {
      validateSender(event)
      return readRepository(
        (root, signal) =>
          readReviewHistoryDiff(
            root,
            requirePullRequestNumber(number),
            requireCommitOid(fromOid),
            signal,
          ),
        requestIdClaim(requestId, 'review-history-diff'),
      )
    },
  )
  ipcMain.handle('repository:review-clear-history', (event, number: unknown) => {
    validateSender(event)
    return readRepository((root, signal) =>
      clearReviewHistory(root, requirePullRequestNumber(number), signal),
    )
  })

  ipcMain.handle(
    'repository:pull-request-checks',
    (event, number: number, options?: PullRequestChecksOptions) => {
      validateSender(event)
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error('Pull request number must be a positive integer.')
      }
      return readRepository(
        (root, signal) => getPullRequestChecks(root, number, { ...options, signal }),
        `pull-request-checks:${number}`,
      )
    },
  )
  // Rerunning a workflow mutates GitHub, so it is a write: it is refused while any
  // other repository operation is in flight rather than interleaving with one.
  ipcMain.handle('repository:pull-request-check-rerun', (event, number: number, runId: number) => {
    validateSender(event)
    return operations.write(() => rerunPullRequestCheck(repository(), number, runId))
  })

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
  // Account status only. No handler here can return, log, or accept a credential.
  ipcMain.handle('github-account', async (event) => {
    validateSender(event)
    return githubAccount().status()
  })
  ipcMain.handle('github-account:sign-in', async (event) => {
    validateSender(event)
    return operations.write(() => githubAccount().signIn())
  })
  ipcMain.handle('github-account:cancel', async (event) => {
    validateSender(event)
    return operations.write(() => githubAccount().cancelSignIn())
  })
  ipcMain.handle('github-account:sign-out', async (event) => {
    validateSender(event)
    return operations.write(() => githubAccount().signOut())
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
    // A stored credential is restored before any handler can reach GitHub, so a
    // signed-in account works with no `gh` executable installed.
    await githubAccount()
      .restore()
      .catch(() => githubAccount().status())
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
