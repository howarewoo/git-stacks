import {
  app,
  BrowserWindow,
  dialog,
  ipcMain as electronIpcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
} from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
  retireConfirmedGitHubPayloads,
} from './git'
import { CommandCancelled, getOriginUrl } from './git-core'
import { getGitHubIssues, getPullRequest, getPullRequestIndexPage } from './github'
import { ProgressivePullRequestIndex } from './pr-index'
import { lastGitHubRateLimitFor } from './github-transport'
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
import { originRemote, readReviewCommits, readReviewFiles, readReviewHeadline } from './review'
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
import {
  clearCredentialCheckBackoffs,
  retirePullRequestChecks,
  getPullRequestChecks,
  rerunPullRequestCheck,
} from './pull-request-checks'
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
  GitHubCliStatus,
  MergeProgress,
  PublishProgress,
  RecentRepository,
  RepositorySnapshot,
  StackKind,
  SyncActivity,
} from '../shared/types'
import { RepositoryOperations } from './repository-operations'
import {
  RequestRegistry,
  performBackgroundRead,
  snapshotReadPurpose,
  type ReadPurpose,
} from './request-registry'
import { RepositoryScheduler } from './repository-scheduler'
import {
  DEFAULT_INTERVALS,
  RepositorySyncCoordinator,
  type SyncIntervals,
} from './sync-coordinator'
import { RepositoryWatcher } from './git-watcher'
import {
  configureGitRuntime,
  gitRuntimeStatus,
  readGitRuntimePreference,
  resolveGitRuntime,
  withGitRuntime,
} from './git-runtime'
import { CredentialVault } from './credentials'
import { safeStorageProtector } from './secret-storage'
import { forgetGitHubCliServices, gitHubCliStatusService } from './github-cli'
import { retireLegacyPrimaryRecord } from './notification-protection'
import { NotificationCenter, notificationCredentialStore } from './notifications'
import {
  assertDirectoryName,
  assertFullName,
  classifyTransportFailure,
  cloneCommandText,
  discoverRepositories,
  ghCloneCommandText,
} from './github-repositories'
import { CloneError, cloneRepository, readGitEnvironment } from './clone-repository'
import { runCloneRequest, type ValidatedClone } from './clone-request'
import { configurePromotionHelper } from './promote-repository'
import { canonicalHostName } from '../shared/host'
import { isCancelled as isCommandCancelled } from './git-core'
import type {
  CloneCommandPreview,
  CloneProtocol,
  OnboardingFailure,
  RepositoryCloneResult,
} from '../shared/types'
import {
  readSettingsFile,
  readSettingsSnapshot,
  resetSettings,
  settingsPatchToWrite,
  resetTarget,
  updateSettings,
} from './settings'
import { loadSettingsPolicy } from './settings-service'
import {
  configuredHostContext,
  externalGitHubLink,
  forgetHost,
  GITHUB_DOTCOM_HOST,
  githubHostContext,
  hostTransport,
  probeGitHubHost,
  remoteHostContext,
  type GitHubHostContext,
  validateGitHubHostInput,
} from './github-host'
import { getConfigValue, parseRemote } from './git-core'
import { GitHubTransportError, githubHostCredentialIdentity } from './github-transport'
import { GITHUB_DEFAULT_HOST } from '../shared/settings'
import { detectRefFormat, readGitHubCliSources, runDiagnostics } from './diagnostics'
import { buildBundle, renderBundle, writeOwnerOnlyBundle } from './support-bundle'
import { locateTool, openInEditor } from './editor'
import { recordFailure, recordedFailures } from './failure-log'
import type {
  AppSettings,
  SettingsLock,
  SettingsPatch,
  SettingsSnapshot,
  SettingsTools,
  SupportBundlePreview,
} from '../shared/settings'

import type { GitEnvironmentStatus } from '../shared/types'
import { UpdateService } from './update/service'
import {
  PullRequestInboxService,
  retiredPullRequestInboxReport,
  type PullRequestInboxTarget,
} from './pr-inbox'
import { PullRequestInboxFilters } from './pr-inbox-filters'
import {
  PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS,
  type PullRequestInboxFilterDraft,
} from '../shared/pr-inbox'

const readKeys = new RequestRegistry()
const onboardingKeys = new RequestRegistry()
const inboxKeys = new RequestRegistry()
/**
 * The PR Inbox reads every registered repository at once, so it lives under its
 * own request root rather than any repository's: a repository switch must not
 * end a queue read, and a queue read must not hold a repository's lane.
 */
const INBOX_ROOT = 'pr-inbox'
/** Discovery and clone run before any repository exists, under their own root. */
const ONBOARDING_ROOT = 'onboarding'

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
/**
 * Moves whenever the registered repository list changes, which a read cannot see
 * for itself: `inboxTargets` maps the list before it awaits each origin, so a
 * repository added or dropped while that lookup is in flight leaves the read's
 * own final list looking unchanged. The queue's fence carries this, so the
 * comparison is against the registration that is current rather than the one the
 * read started from.
 */
let inboxRegistrationGeneration = 0

function setRecents(next: RecentRepository[]): void {
  recents = next
  inboxRegistrationGeneration += 1
}
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
  purpose: ReadPurpose = 'local',
): Promise<T> {
  return performBackgroundRead(
    readKeys,
    root,
    signal,
    async (combined) => inGitRuntime(() => operation(root, combined)),
    requestId,
    purpose,
  )
}

// A `reuse` refresh — what every filesystem event asks for — is claimed as the
// local read it is, so replacing the signed-in account cannot end it.
const sync = new RepositorySyncCoordinator({
  readSnapshot: (root, signal, request) =>
    backgroundRead(
      root,
      signal,
      (path, readSignal) => getSnapshot(path, readSignal, undefined, request.github.remote),
      request.requestId,
      snapshotReadPurpose(request.github),
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
      'github',
    ),
  scheduler,
})

const prIndex = new ProgressivePullRequestIndex(
  (origin, cursor, basic, signal) => {
    const root = repository()
    return scheduler.read(
      root,
      (readSignal) =>
        backgroundRead(
          root,
          AbortSignal.any([signal, readSignal]),
          (_path, combined) => getPullRequestIndexPage(origin, cursor, basic, combined),
          'pr-index-page',
          'github',
        ),
      signal,
    )
  },
  hostCredentialAuthority,
  (state) => {
    if (state.repository === activeRepository && window && !window.isDestroyed())
      window.webContents.send('repository:pr-index', state)
  },
  (host) => {
    const report = lastGitHubRateLimitFor(host)
    return (
      report.rateLimit.remaining === null ||
      report.rateLimit.remaining > DEFAULT_INTERVALS.budgetFloor ||
      (report.rateLimit.reset !== null && report.rateLimit.reset.getTime() <= Date.now())
    )
  },
)

sync.onEvent((event) => {
  if (!window || window.isDestroyed()) return
  if (event.kind === 'snapshot' && event.snapshot) {
    if (event.snapshot.path !== activeRepository) return
    if (prIndex.current()) {
      const origin = parseRemote(event.snapshot.remoteUrl)
      const host = remoteHostContext(origin)
      const indexed = prIndex.current()!
      if (
        !origin ||
        !host ||
        indexed.host !== host.host ||
        indexed.fullName.toLowerCase() !== origin.fullName.toLowerCase()
      )
        prIndex.invalidate()
      else if (!event.snapshot.githubStale && event.snapshot.github.available)
        prIndex.adopt(event.snapshot.path, host.host, origin.fullName, event.snapshot.pullRequests)
    }
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
  prIndex.invalidate()
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
const inboxFiltersPath = () => join(app.getPath('userData'), 'pull-request-inbox.json')
const inboxFilters = new PullRequestInboxFilters(inboxFiltersPath())
/**
 * The authenticated identity the queue's rows belong to. It is the identity the
 * GitHub CLI status read established: it names the host, the account, and the
 * credential behind it, because any one of those changing means the rows on
 * screen were read for somebody else.
 */
let inboxIdentity = 'unchecked'
/**
 * The identity a queue read belongs to, in the terms the service fences on.
 *
 * It is the CLI status this process last established AND the credential identity
 * of every host the registered repositories resolve to. The status alone is not
 * an authority: a credential the GitHub CLI resolves for itself replaces a
 * host's credential without any status changing at all, and rows read under the
 * credential that was replaced belong to somebody else. The credential identity
 * is opaque, holds no secret, and is never logged or persisted.
 */
function inboxIdentityNow(): Promise<string> {
  return inboxCredentialHosts().then((hosts) =>
    [inboxIdentity, String(inboxRegistrationGeneration), ...hosts].join('\u0000'),
  )
}

/**
 * Every host a registered repository resolves to, each with the credential it
 * would authenticate with. Resolved from the registered repositories rather
 * than remembered from a read, so a repository added on a host with different
 * credentials is covered too.
 */
function inboxCredentialHosts(): Promise<string[]> {
  return Promise.all(inboxHosts.map((host) => hostCredentialAuthority(host)))
}

/**
 * The credential one host would authenticate with, asked of the transport that
 * will actually make its requests. A host answered by the `gh` CLI is
 * authenticated by whichever profile that CLI holds, and a profile replaced
 * outside this app is visible to nothing else — so asking only the environment
 * would leave rows read for the previous account on screen after a refresh that
 * the new one could not complete.
 */
async function hostCredentialAuthority(hostName: string): Promise<string> {
  const host = configuredHostContext(hostName)
  try {
    return await hostTransport(host).credentialAuthority()
  } catch {
    // An authority that cannot be asked is still fenced rather than skipped: the
    // environment and account identity is less than the transport would know,
    // and less evidence is not none.
    return githubHostCredentialIdentity(host.host)
  }
}

/** Hosts the registered repositories resolve to, refreshed with every snapshot. */
let inboxHosts: readonly string[] = []

const inboxService = new PullRequestInboxService(
  inboxIdentityNow,
  // Resolved again when a read lands, so a repository registered or removed
  // while it was in flight retires the answer instead of publishing a queue
  // that describes a list of repositories that no longer exists.
  inboxTargets,
)
/** Queue reads in flight, so a replaced identity can stop the ones still running. */
const inboxWork = new Set<AbortController>()

/**
 * Drops everything the queue holds for the identity that is being replaced, and
 * stops the reads still running for it. Clearing the retained rows is not enough
 * on its own: a read already in flight resolves with rows read under the old
 * credential, so those are cancelled and refused rather than published.
 */
function retireInboxIdentity(identity: string): void {
  inboxIdentity = identity
  for (const controller of inboxWork) controller.abort()
  inboxWork.clear()
  inboxService.invalidate()
}

/**
 * The identity one CLI status establishes, in the terms the queue fences on. A
 * read that established no credential has none to fence on, and says what it
 * did find instead: being signed out is not the same moment as being signed in
 * as somebody else.
 */
function cliIdentity(status: GitHubCliStatus): string {
  // The host is part of it: one generation on two hosts is two accounts.
  return `${canonicalHostName(status.host)}|${status.identity ?? status.state}`
}

// The stored filter list is read once, on the same promise every list and save
// waits for: an answer produced before that read finished is an empty list that
// reads as "you have none", and a whole-list save taken against it would
// replace the file with whatever the window believed at the time.
const inboxFiltersReady = inboxFilters.settled().catch(() => [])

/**
 * The queue reads the registered repositories, resolved at refresh time rather
 * than captured, so opening or removing a repository changes the next answer
 * without restarting anything. One unreadable origin yields a repository with
 * no GitHub remote rather than failing the whole queue.
 */
function inboxTargets(): Promise<PullRequestInboxTarget[]> {
  // The registration these origins are being resolved for, taken before the
  // first await. A repository added or removed while the lookups are in flight
  // makes this resolution obsolete, and it has no way to see that itself.
  const registration = inboxRegistrationGeneration
  return Promise.all(
    recents.map(async (repository) => ({
      path: repository.path,
      originUrl: await getOriginUrl(repository.path).catch(() => null),
    })),
  ).then((targets) => {
    // An obsolete resolution records nothing. The hosts it resolved are the
    // ones a registration that no longer exists named, and publishing them
    // would fence the reads that followed it on hosts they are not going to
    // ask — retiring a read whose own registrations and credentials never
    // changed, because a slower read for a dropped repository landed after it.
    // The targets are still returned: this read describes the list it was
    // given, and the generation its identity carries is what retires it.
    if (registration !== inboxRegistrationGeneration) return targets
    // The hosts this read will use, recorded from the same resolution that
    // produced the targets. The queue's credential fence is asked about these
    // hosts, so recording them anywhere else could fence on a host this read is
    // not going to ask.
    inboxHosts = [
      ...new Set(
        targets
          .map((target) => {
            const remote = target.originUrl ? parseRemote(target.originUrl) : null
            return remote ? remoteHostContext(remote)?.host : null
          })
          .filter((host): host is string => typeof host === 'string'),
      ),
    ].sort()
    return targets
  })
}

// The stored choice is applied before any repository is attached, so the first
// open already polls on the interval the person chose rather than on the default
// and then correcting itself.
void readSettingsFile(settingsFile())
  .then((file) => sync.applyIntervals(refreshIntervals(file.settings)))
  .catch(() => {
    // An unreadable settings file leaves the coordinator on its defaults; the
    // settings view reports the problem where a person can see it.
  })
/**
 * The one sealed store this application wrote for its own primary GitHub record.
 * The GitHub CLI owns GitHub authentication and the optional Notification Center
 * has its own separately authorized store, so this file exists only to retire
 * what an earlier build kept there.
 */
let applicationStore: CredentialVault | null = null
/**
 * Settings this computer's policy has fixed, resolved at startup and applied
 * to every read and write. A policy file that could not be read contributes a
 * lock on every managed key rather than none, so a broken policy cannot widen
 * what the app does.
 */
let settingsLocks: SettingsLock[] = []
let settingsPolicyError: string | null = null

/**
 * This machine's Git facts as the last successful environment read found them:
 * commit identity, the configured default branch, the HTTPS credential helper,
 * and whether an SSH client is present. The capability report measures from
 * here, so a read that has not happened leaves every line it feeds unavailable
 * rather than filled in from what this build usually finds.
 */
let gitEnvironment: GitEnvironmentStatus | null = null

/**
 * Created once, so a retirement and anything else reading the same file cannot
 * keep two caches of it, each writing back entries the other had already
 * replaced.
 */
function applicationVault(): CredentialVault {
  applicationStore ??= new CredentialVault(
    join(app.getPath('userData'), 'credentials.vault.json'),
    safeStorageProtector,
  )
  return applicationStore
}

/**
 * The update lifecycle. It runs in main because every decision about what to
 * fetch, what to verify, and what to run happens here; the window only asks for
 * a step and shows what happened.
 */
let updateService: UpdateService | null = null

/**
 * The GitHub CLI status for the configured host.
 *
 * A real read of the installed CLI and the account it holds, owned by the CLI
 * and never by this process: nothing here signs in, switches account, or ends a
 * session. The window receives status only — no credential, no CLI output, and
 * no path to either has ever left the main process.
 */
function githubCli() {
  return gitHubCliStatusService(configuredHost().host, {
    onChange: (status) => {
      // The queue's rows belong to the account that read them, so a new identity
      // is established before the window hears about the status that carries it.
      // A credential replaced outside this app — in the CLI itself — changes the
      // identity, and everything read under the old one is dropped with it.
      const identity = cliIdentity(status)
      if (identity !== inboxIdentity) {
        retireInboxIdentity(identity)
        // A credential replaced outside this app changes whose GitHub answers
        // every cached read belongs to, not only the queue's. Everything host-
        // scoped in flight is stopped and its generation retired, what was
        // observed about hosts is forgotten, and the reports keyed by validator
        // are dropped: none of them may answer for a credential that no longer
        // exists. Local Git state and the notification inbox's own host
        // credential are untouched by this.
        for (const controller of hostWork) controller.abort()
        hostWork.clear()
        hostGeneration += 1
        forgetHost()
        // Every GitHub read still running is pinned to the credential that has
        // just been replaced, so none of them may repopulate a cache, a payload,
        // or a row that now belongs to another account. Local Git is untouched:
        // none of these readers can reach it.
        readKeys.cancelGitHub()
        retireConfirmedGitHubPayloads()
        prIndex.invalidate()
        retirePullRequestChecks()
        clearCredentialCheckBackoffs()
      }
      window?.webContents.send('github-cli:status', status)
    },
  })
}

/**
 * The optional GitHub Notifications Center.
 *
 * It is created for the host that is configured and replaced when that host
 * changes, because its credential, its transport, and its list all belong to
 * one host. Each host also keeps its own files: a credential and a cached list
 * are named for the host they were read for, so a host change can neither serve
 * one host's notifications under another's name nor destroy the credential the
 * person stored for the host they are returning to.
 */
let notifications: NotificationCenter | null = null
let notificationHost: string | null = null

/**
 * The file name suffix that keeps one host's stored state out of another's, and
 * the half of the credential file name the retirement gate matches on: the two
 * must keep naming the same file.
 */
function notificationScope(host: string): string {
  return Buffer.from(host, 'utf8').toString('hex')
}

/**
 * Ends the Notification Center for the host that is no longer selected.
 *
 * The boundary closes where the host changes, not at the next notification
 * request: the retired center's timer, its read, and its credential are all
 * addressed to a host this app no longer speaks to. What it stored stays on
 * disk, sealed and named for that host, for whoever selects it again — what it
 * holds in memory, and what it publishes, end here.
 */
function retireNotificationCenter(): void {
  if (notifications === null) return
  notifications.forget()
  notifications = null
  notificationHost = null
}

function notificationCenter(): NotificationCenter {
  const context = configuredHost()
  // A center belongs to one host, so a host that is no longer selected retires
  // the one that was built for it rather than being asked to serve another.
  if (notificationHost !== null && notificationHost !== context.host) retireNotificationCenter()
  const scope = notificationScope(context.host)
  if (notifications === null) {
    let center: NotificationCenter
    center = new NotificationCenter({
      host: context,
      // This module's own sealed file, never the application's: signing out, a
      // host change, or a whole-store cleanup on the account side cannot reach a
      // notification token, and a notification token can never be read as the
      // credential pull requests, stacks, and reviews depend on. One store and one
      // queue per host, kept across centers, so a change this host's files are
      // still making cannot be lost to the one that comes after it.
      store: notificationCredentialStore(
        join(app.getPath('userData'), `github-notifications-vault.${scope}.json`),
        safeStorageProtector,
      ),
      credentialFile: join(app.getPath('userData'), `github-notifications.${scope}.json`),
      cacheFile: join(app.getPath('userData'), `github-notifications-cache.${scope}.json`),
      consent: () => ({
        enabled: currentSettings?.notifications.enabled === true,
        policyDisabled: settingsLocks.some((lock) => lock.key === 'notifications.enabled'),
      }),
      onChange: (inbox) => {
        if (notifications === center) window?.webContents.send('notifications', inbox)
      },
    })
    notifications = center
    notificationHost = context.host
  }
  syncNotificationModule()
  return notifications
}

/**
 * Whether the Notification Center's poll loop may run at all. Consent and this
 * computer's policy are the only two answers, and the module is only created
 * once a surface has actually asked about it.
 */
function notificationsAllowed(): boolean {
  return (
    currentSettings?.notifications.enabled === true &&
    !settingsLocks.some((lock) => lock.key === 'notifications.enabled')
  )
}

/**
 * Arms or stops the poll for the module this process already has, and does
 * nothing when no surface has asked about notifications yet. Policy or consent
 * that turns the module off stops the loop here rather than waiting for the
 * next interval, so a disabled module asks GitHub for nothing.
 */
function syncNotificationModule(): void {
  if (notifications === null) return
  if (notificationsAllowed()) notifications.start()
  else notifications.stop()
}

/**
 * A request from somewhere the app does not recognise. It is refused before
 * any work starts and is named as its own kind, so the failure log does not
 * fill with a page that is not this window probing every channel.
 */
class UntrustedRequestError extends Error {}

/**
 * What the current settings select. The host drives onboarding, discovery, and
 * sign-in, so a host change retires the previous host's account and forgets
 * what was learned about the host that is no longer selected.
 */
let hostGeneration = 0
/** Host-scoped work in flight, so a host change can cancel it. */
const hostWork = new Set<AbortController>()

function applySettings(settings: AppSettings): void {
  const previousHost = currentSettings?.github.host ?? null
  currentSettings = settings
  if (previousHost === settings.github.host) {
    // Consent and policy both live in settings, so a change to either has to
    // reach the module that polls with them now rather than at its next read.
    syncNotificationModule()
    return
  }
  // Everything already in flight was addressed to the host that is no longer
  // selected. It is aborted, and its generation is retired, so a response that
  // arrives afterwards cannot repopulate the previous host's cache or the UI.
  for (const controller of hostWork) controller.abort()
  hostWork.clear()
  hostGeneration += 1
  // The selected host is part of the queue's identity, and a host change can
  // arrive without a CLI status to announce it. The services of every host are
  // dropped with it, so a returning host reads its CLI afresh rather than
  // answering from what was established before it was left.
  retireInboxIdentity(`host:${settings.github.host}`)
  prIndex.invalidate()
  forgetHost(previousHost ?? undefined)
  forgetGitHubCliServices()
  // The notification inbox belongs to the host it was read from, and the window
  // is holding it. The old center is retired here, where the host changed, and
  // the new host's is opened and published at once: its old timer never runs
  // again, and what the window shows is never the previous host's answer.
  const hadNotificationCenter = notifications !== null
  retireNotificationCenter()
  if (hadNotificationCenter) notificationCenter()
}

/**
 * The owner/name of an open repository when that repository's own origin is on
 * this host, and null otherwise.
 */
async function openRepositoryOnHost(
  root: string,
  context: GitHubHostContext,
): Promise<{ owner: string; name: string } | null> {
  try {
    const remote = parseRemote(await getConfigValue(root, 'remote.origin.url'))
    if (!remote || remoteHostContext(remote)?.host !== context.host) return null
    return { owner: remote.owner, name: remote.name }
  } catch {
    return null
  }
}

/**
 * The host and the generation it was selected in, read in one step.
 *
 * A host operation has to take both before it awaits anything: reading the host
 * now and its generation after an await would let a host change in between pair
 * an old host with a new generation, and the fence would then wave through a
 * result that belongs to the host that is no longer selected.
 */
interface SelectedHost {
  context: GitHubHostContext
  generation: number
}

function captureSelectedHost(): SelectedHost {
  return { context: configuredHost(), generation: hostGeneration }
}

/**
 * Runs host-scoped work that belongs to the host selected when it started. A
 * host change aborts it, and a late answer is refused rather than delivered, so
 * nothing addressed to a retired host reaches this host's callers.
 */
async function forSelectedHost<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  selected: SelectedHost = captureSelectedHost(),
): Promise<T> {
  const { generation } = selected
  // Checked before the work starts, not only after it finishes. Work captured
  // against a host that was retired before it began would otherwise run to the
  // end against the old host, publish into the old host's record, and be
  // refused only at the very last moment — after the wrong answer was stored.
  if (generation !== hostGeneration) {
    throw new GitHubTransportError({
      kind: 'cancelled',
      detail: 'the selected GitHub host changed before this request started',
    })
  }
  const controller = new AbortController()
  hostWork.add(controller)
  try {
    const value = await operation(controller.signal)
    if (generation !== hostGeneration) {
      throw new GitHubTransportError({
        kind: 'cancelled',
        detail: 'the selected GitHub host changed before this request finished',
      })
    }
    return value
  } finally {
    hostWork.delete(controller)
  }
}

/**
 * The host the person chose in Settings, resolved on every use. It is the only
 * host onboarding, discovery, and clone commands speak to, and a repository on
 * any other host is read from that repository's own origin instead.
 */
let currentSettings: AppSettings | null = null

function configuredHost(): GitHubHostContext {
  // One resolver for every host question in the main process, so an absent host
  // is always github.com rather than an empty one.
  return configuredHostContext(currentSettings?.github.host)
}

/**
 * The hosts whose links this installation may hand to the operating system.
 *
 * These are the hosts the app already talks to, not the hosts a link names: the
 * configured host, which is github.com unless an enterprise host was chosen,
 * and, when a repository is open, the host that owns its origin. The second one
 * is what keeps a repository cloned from an enterprise host usable while the
 * app is pointed somewhere else: its pull request, issue, and stack links all
 * live on that host, and its API requests already go there.
 */
async function trustedExternalLinkHosts(): Promise<GitHubHostContext[]> {
  const hosts = [configuredHost()]
  if (!activeRepository) return hosts
  try {
    const remote = parseRemote(await getConfigValue(activeRepository, 'remote.origin.url'))
    const owner = remoteHostContext(remote)
    if (owner && owner.host !== hosts[0].host) hosts.push(owner)
  } catch {
    // An origin that cannot be read names no host, so the configured host is
    // the whole of what this install will open.
  }
  return hosts
}

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

/**
 * Runs an operation against the Git this installation is configured to use.
 *
 * Every local Git command resolves the same runtime this way, so work started
 * here uses the chosen Git rather than whatever happens to be on PATH.
 */
async function inGitRuntime<T>(operation: () => Promise<T>): Promise<T> {
  return withGitRuntime(await resolveGitRuntime(), operation)
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
  /** What this read depends on; only a GitHub read dies with a replaced credential. */
  purpose: ReadPurpose = 'local',
): Promise<T> {
  const root = repository()
  const controller = readKeys.claim(root, requestId, purpose)
  const superseded = () =>
    new Error('The active repository changed. Reopen this view to load its current state.')
  return operations
    .read(async () => {
      if (root !== activeRepository) throw superseded()
      return inGitRuntime(() => operation(root, controller.signal))
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
  setRecents(next)
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

/**
 * Opens a local repository and, only once its snapshot reads, registers it as a
 * recent repository. Adding a repository this way never writes to the
 * repository itself: it is read, never rewritten.
 *
 * The signal is honoured up to the last point where nothing has been written.
 * Once `remember` has persisted the recent entry the switch finishes, so the
 * recents and the active repository always describe the same folder; aborting
 * in between would leave a recent entry for a repository that never became
 * active, or a folder nothing names any more.
 */
async function activateRepository(selected: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new CommandCancelled()
  const path = await resolveRepository(selected)
  if (signal?.aborted) throw new CommandCancelled()
  // Retire old reads before waiting for the operation queue; a long-running
  // history/diff must not delay switching to a newly selected repository.
  if (activeRepository) readKeys.cancelRoot(activeRepository)
  stopBackgroundSync()
  return operations.switchRepository(path, async () => {
    if (signal?.aborted) throw new CommandCancelled()
    return inGitRuntime(async () => {
      if (signal?.aborted) throw new CommandCancelled()
      const snapshot = await getSnapshot(path, undefined, undefined, 'reuse')
      if (signal?.aborted) throw new CommandCancelled()
      // Past this point the recent entry is written and the switch completes:
      // recents and the active repository must name the same folder.
      await remember(path)
      activeRepository = path
      startBackgroundSync(path, snapshot)
      // The local workspace opens without waiting for every GitHub page. The
      // existing coordinator owns the subsequent complete remote refresh.
      void sync.refreshNow().catch(() => {
        // The coordinator already reports background failure; a repository switch
        // can also retire this refresh before it obtains a snapshot.
      })
      return snapshot
    })
  })
}

/**
 * Onboarding runs before a repository exists, so its own cancellable requests
 * are tracked apart from the active repository's reads.
 */
function onboardingRequest<T>(requestId: string, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = onboardingKeys.claim(ONBOARDING_ROOT, requestId)
  return operation(controller.signal).finally(() =>
    onboardingKeys.release(ONBOARDING_ROOT, requestId, controller),
  )
}

/**
 * An onboarding call answers with a named outcome rather than a thrown error,
 * so a failure handled this way never reaches the handler registration below.
 * Recording it here is what puts a failed search or clone into the bundle. A
 * cancellation is the answer the user asked for, so it is not a failure.
 */
function onboardingFailure(scope: string, error: unknown): OnboardingFailure {
  const failure: OnboardingFailure =
    error instanceof CloneError
      ? { reason: error.reason, message: error.message }
      : isCommandCancelled(error)
        ? { reason: 'cancelled', message: 'The clone was cancelled.' }
        : classifyTransportFailure(error)
  if (failure.reason !== 'cancelled') recordFailure(scope, failure.message)
  return failure
}

function requireString(value: unknown, name: string, limit = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new CloneError('invalid-destination', `Choose a valid ${name}.`)
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

function cloneProtocol(value: unknown): CloneProtocol {
  return value === 'ssh' ? 'ssh' : 'https'
}

/**
 * Validates a clone request before anything is written. The URL is rebuilt from
 * `owner/name` and the chosen protocol, never taken from the request, so a
 * crafted payload cannot send Git somewhere else.
 */
function validatedClone(request: unknown): ValidatedClone {
  const asked = (request ?? {}) as Record<string, unknown>
  const repository = (asked.repository ?? {}) as Record<string, unknown>
  const fullName = assertFullName(repository.fullName)
  const protocol = cloneProtocol(asked.protocol)
  // A clone is addressed to the host that owns the repository discovery read it
  // from. The URLs are built from that host here rather than taken from the
  // renderer, so a discovered enterprise repository never resolves on github.com
  // and a chosen name never aims the clone at an unvalidated origin.
  const parsedHost = validateGitHubHostInput(repository.host)
  if (!parsedHost.ok || !parsedHost.host) {
    throw new Error('A clone must name the GitHub host that owns the repository.')
  }
  const host = githubHostContext(parsedHost.host)
  return {
    fullName,
    host: host.host,
    url:
      !app.isPackaged &&
      typeof repository.cloneUrl === 'string' &&
      repository.cloneUrl.startsWith('file://')
        ? repository.cloneUrl
        : protocol === 'ssh'
          ? // The SSH remote is written with the host name alone. A web port is
            // not an SSH port, and `git@host:8443:owner/repo.git` names a path
            // that does not exist on that host.
            `git@${host.sshHost}:${fullName}.git`
          : `${host.webOrigin}/${fullName}.git`,
    directoryName: assertDirectoryName(asked.directoryName),
    parentDirectory: requireString(asked.parentDirectory, 'destination folder'),
    protocol,
    shallow: asked.shallow === true,
  }
}

/**
 * Names the tools a stored preference points at and whether this machine has
 * them, so a missing editor or merge tool is reported where the setting is
 * edited instead of at the moment an action fails.
 */
async function withToolAvailability(
  snapshot: SettingsSnapshot,
): Promise<SettingsSnapshot & { tools: SettingsTools }> {
  const [editor, mergeTool] = await Promise.all([
    locateTool(snapshot.settings.git.editor, null),
    locateTool(snapshot.settings.git.mergeTool, null),
  ])
  return {
    ...snapshot,
    // A policy problem is surfaced with the settings it affects, so the reason
    // a control is disabled is on the same screen as the control.
    issues: settingsPolicyError
      ? [...snapshot.issues, { key: 'policy', message: settingsPolicyError }]
      : snapshot.issues,
    tools: { editor, mergeTool },
  }
}

/**
 * The one place a settings write happens, so every entry point — the Settings
 * surface, the older Git runtime dialog, and reset — goes through the same
 * policy check and the same follow-up.
 *
 * The follow-up matters: the Git resolver reads its configuration in memory,
 * so a stored preference that is not applied to it would leave the surface
 * reporting one Git while operations use another until the app restarts.
 */
let settingsQueue: Promise<unknown> = Promise.resolve()
function runSettingsTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsQueue.then(operation, operation)
  settingsQueue = result.then(
    () => {},
    () => {},
  )
  return result
}
let settingsRevision = 0

interface ActiveBundlePreview {
  id: string
  preview: SupportBundlePreview
  renderedBody: string
  bytes: number
  pathCount: number
  consent: boolean
  settingsRevision: number
  timestamp: number
}
let activeBundlePreview: ActiveBundlePreview | null = null

/**
 * The stored background-refresh choice, as the coordinator's own intervals. The
 * coordinator is the single automatic owner of remote reads, so a zero here means
 * no timer is armed at all.
 */
function refreshIntervals(settings: AppSettings): Partial<SyncIntervals> {
  const visibleMs = Math.max(0, Math.round(settings.git.fetchIntervalSeconds)) * 1000
  return visibleMs > 0
    ? { visibleMs, secondaryMs: Math.max(visibleMs, visibleMs * 5) }
    : { visibleMs: 0 }
}

async function changeSettings(
  write: (file: string) => Promise<SettingsSnapshot>,
): Promise<SettingsSnapshot> {
  return runSettingsTransaction(async () => {
    const snapshot = await write(settingsFile())
    settingsRevision++
    // Any change to settings invalidates the cached support bundle preview
    activeBundlePreview = null
    configureGitRuntime({ useSystemGit: snapshot.settings.git.useSystemGit })
    applySettings(snapshot.settings)
    sync.applyIntervals(refreshIntervals(snapshot.settings))
    return snapshot
  })
}

/**
 * A settings change, with the update channel committed through the updater.
 *
 * Everything else is written and then applied. A channel change is different:
 * the file records the channel, and the running process follows one, so the
 * write happens inside the updater's own boundary — the change is taken, the
 * file is written, and only then is the new channel published. An install in
 * flight, or a write that fails, leaves both where they were, and this call
 * reports why rather than returning a channel the app is not on.
 */
async function changeSettingsPatch(patch: SettingsPatch): Promise<SettingsSnapshot> {
  const channel = patch.updates?.channel
  const service = updateService
  // Channel requests enter the updater queue even when they appear unchanged.
  if (channel === undefined || !service) {
    return changeSettings(async (file) =>
      updateSettings(
        file,
        await settingsPatchToWrite(file, patch, settingsRevision),
        settingsLocks,
      ),
    )
  }
  let committed: SettingsSnapshot | null = null
  const status = await service.applyChannel(channel, async () => {
    committed = await changeSettings(async (file) =>
      updateSettings(
        file,
        await settingsPatchToWrite(file, patch, settingsRevision),
        settingsLocks,
      ),
    )
  })
  if (!committed) {
    throw new Error(status.failure?.message ?? 'The update channel was not changed.')
  }
  return committed
}

/** One capability report, built from the same sources the Diagnostics view shows. */
async function currentDiagnostics(settings: AppSettings) {
  // A diagnostics report is the one place a person is told what the host does,
  // so the host is asked here rather than assumed from the build.
  // The same host, the same generation, and the same open repository the host
  // report uses, so both surfaces describe one host the same way and a report
  // that outlives a host change is refused rather than published.
  const selected = captureSelectedHost()
  const repository = activeRepository
    ? await openRepositoryOnHost(activeRepository, selected.context)
    : null
  const cli = await githubCli()
    .read()
    .catch(() => null)
  const githubHost = await forSelectedHost(
    (signal) => probeGitHubHost(selected.context, { repository, signal, ...(cli ? { cli } : {}) }),
    selected,
  ).catch(() => null)
  return runDiagnostics({
    runtime: await gitRuntimeStatus(settingsFile()),
    environment: gitEnvironment,
    host: {
      platform: process.platform,
      release: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
      arch: process.arch,
      electron: process.versions.electron,
    },
    filesystem: await detectRefFormat(activeRepository),
    appVersion: app.getVersion(),
    settings,
    githubHost,
    githubCli: { ...(await readGitHubCliSources()), status: cli },
    notifications: notifications === null ? null : await notifications.status().catch(() => null),
  })
}

/**
 * Every handler is registered through this, so two things hold for all of them
 * rather than for the ones that remembered: a request is refused before it
 * reaches a handler unless it came from this window's own main frame on the
 * trusted origin, and a failure main handled leaves the one record a support
 * bundle can carry — the fixed channel and a safe failure category. The thrown
 * value is re-raised unchanged, so the window still decides what to show.
 *
 * A request from outside the app is refused rather than failed, and a cancelled
 * operation is the answer the user asked for, so neither is recorded.
 */
const ipcMain = {
  handle<Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
  ): void {
    electronIpcMain.handle(channel, (event, ...args: Args) =>
      Promise.resolve()
        .then(() => {
          validateSender(event)
          return listener(event, ...args)
        })
        .catch((error: unknown) => {
          if (!(error instanceof UntrustedRequestError) && !isCommandCancelled(error)) {
            recordFailure(channel, error)
          }
          throw error
        }),
    )
  },
}

function requireUpdateService(): UpdateService {
  if (!updateService) throw new Error('Updates are not available in this session.')
  return updateService
}
function installHandlers() {
  // The clone destination is chosen with the platform folder picker, so the
  // renderer never composes a filesystem path of its own.
  ipcMain.handle('repositories:choose-destination', async (event, current: unknown) => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose where to clone',
      buttonLabel: 'Use this folder',
      defaultPath: typeof current === 'string' && current ? current : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('repositories:recent', (event) => {
    return recents
  })
  ipcMain.handle('repositories:open', async (event, requestedPath: unknown) => {
    if (requestedPath !== undefined) {
      if (
        typeof requestedPath !== 'string' ||
        !recents.some((item) => item.path === requestedPath)
      ) {
        throw new Error('Use Open repository to choose a new folder.')
      }
      return activateRepository(requestedPath)
    }
    const result = await dialog.showOpenDialog(window!, {
      title: 'Open Git repository',
      properties: ['openDirectory'],
      buttonLabel: 'Open repository',
    })
    if (result.canceled || !result.filePaths[0]) return null
    return activateRepository(result.filePaths[0])
  })
  // A folder chosen by dialog or dropped on the window is added by its absolute
  // path. It is read exactly as it is found: nothing inside it is written.
  ipcMain.handle('repositories:add', async (event, requestedPath: unknown) => {
    return activateRepository(requireString(requestedPath, 'folder'))
  })
  ipcMain.handle('git-environment', async (event, requestId: unknown) => {
    try {
      const value = await onboardingRequest(requestIdClaim(requestId, 'onboarding'), (signal) =>
        readGitEnvironment(signal),
      )
      // The capability report measures the HTTPS helper and the SSH client from
      // this read, so the result is kept for it to report from.
      gitEnvironment = value
      return { ok: true as const, value }
    } catch (error) {
      return { ok: false as const, failure: onboardingFailure('git-environment', error) }
    }
  })
  ipcMain.handle('repositories:search', async (event, request: unknown) => {
    const asked = (request ?? {}) as { query?: unknown; requestId?: unknown }
    const query = typeof asked.query === 'string' ? asked.query : ''
    try {
      const host = configuredHost()
      const value = await forSelectedHost((hostSignal) =>
        onboardingRequest(requestIdClaim(asked.requestId, 'onboarding'), (signal) =>
          discoverRepositories({
            host,
            query,
            signal: AbortSignal.any([signal, hostSignal]),
          }),
        ),
      )
      return { ok: true as const, value }
    } catch (error) {
      return { ok: false as const, failure: onboardingFailure('repositories:search', error) }
    }
  })
  // The clone is built in a staging folder and promoted into a destination this
  // process claimed before it is registered, so a cancelled or failed clone
  // leaves nothing behind to open.
  ipcMain.handle('repositories:clone', async (event, request: unknown) => {
    const asked = (request ?? {}) as Record<string, unknown>
    try {
      const clone = validatedClone(asked)
      const value = await onboardingRequest(
        requestIdClaim(asked.requestId, 'onboarding'),
        (signal) =>
          runCloneRequest(clone, signal, {
            clone: cloneRepository,
            activate: (path) => activateRepository(path),
          }),
      )
      return { ok: true as const, value }
    } catch (error) {
      return { ok: false as const, failure: onboardingFailure('repositories:clone', error) }
    }
  })
  // The same commands without running anything, so the clone can be reproduced
  // in a terminal or with `gh repo clone` before a single file is written.
  ipcMain.handle('repositories:clone-preview', async (event, request: unknown) => {
    try {
      const clone = validatedClone(request)
      return {
        ok: true as const,
        value: {
          gitCommand: cloneCommandText(
            clone.url,
            clone.parentDirectory,
            clone.directoryName,
            clone.shallow,
          ),
          ghCommand: ghCloneCommandText(
            clone.fullName,
            clone.parentDirectory,
            clone.directoryName,
            clone.shallow,
            clone.host === GITHUB_DOTCOM_HOST ? undefined : clone.url,
          ),
        } satisfies CloneCommandPreview,
      }
    } catch (error) {
      return { ok: false as const, failure: onboardingFailure('repositories:clone-preview', error) }
    }
  })
  ipcMain.handle('repository:refresh', async (event) => {
    repository()
    // The person's own refresh always reads GitHub; it never reuses a payload.
    return sync.refreshNow()
  })
  ipcMain.handle('repository:pr-index', async (event) => {
    const root = repository()
    const originUrl = await getOriginUrl(root)
    const origin = parseRemote(originUrl)
    const host = remoteHostContext(origin)
    if (!originUrl || !origin || !host)
      throw new Error('A GitHub origin remote is required for PR indexing.')
    return prIndex.load(root, host.host, originUrl)
  })
  ipcMain.handle('repository:pr-index-detail', (event, number: unknown) => {
    const selected = requirePullRequestNumber(number)
    return prIndex.selected(selected, () =>
      readRepository(
        (root, signal) => getPullRequest(root, selected, signal),
        'pr-index-detail',
        'github',
      ),
    )
  })
  ipcMain.handle('repository:status', (event) => {
    return sync.freshness()
  })
  ipcMain.handle('repository:activity', (event, activity: unknown) => {
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
    if (typeof id !== 'string' || !id) throw new Error('A pending mutation id is required.')
    return sync.dismissPendingMutation(id)
  })
  ipcMain.handle('repository:action', async (event, action: GitAction) => {
    const root = repository()
    try {
      // A mutation claims the repository lane: background reads end first, so a
      // stage or a commit never waits on a network that is not answering.
      return await scheduler.mutate(root, () =>
        // Naming the repository is the admission check: a switch can complete
        // while this action waited for the background reads it ends, and an
        // action must never apply to the repository the window already left.
        operations.write(
          () =>
            inGitRuntime(async () => {
              // The merge tool configured in Settings wins over Git's own
              // configuration for the one action that consults it.
              const settings = (await readSettingsFile(settingsFile())).settings
              return runAction(root, action, settings.git.mergeTool)
            }),
          root,
        ),
      )
    } catch (error) {
      // A high-impact remote mutation that lost its answer is listed, never
      // re-sent: reconnecting resumes reads only.
      sync.recordMutationFailure(action, error)
      throw error
    }
  })
  ipcMain.handle('repository:file', (event, filePath: string) => {
    return readRepository((root, signal) => getFileView(root, filePath, signal), `file:${filePath}`)
  })
  ipcMain.handle('repository:conflict', async (event, filePath: string) => {
    // The conflict view reports the tool it would use, so the configured value
    // the merge action honours is the one the resolver shows.
    const settings = (await readSettingsFile(settingsFile())).settings
    return readRepository((root) => getConflictView(root, filePath, settings.git.mergeTool))
  })
  ipcMain.handle('repository:history', (event, ref: string, skip: number, requestId?: string) => {
    return readRepository((root, signal) => getHistory(root, ref, skip, signal), requestId)
  })
  ipcMain.handle('repository:commit-diff', (event, oid: string, requestId?: string) => {
    return readRepository((root, signal) => getCommitDiff(root, oid, signal), requestId)
  })
  ipcMain.handle('repository:push-preview', (event) => {
    return readRepository((root) => getPushPreview(root))
  })
  ipcMain.handle('repository:stack-preview', (event, kind: StackKind, branch: string) => {
    return readRepository(
      async (root, signal) => previewStack(root, await getSnapshot(root, signal), kind, branch),
      'stack-preview',
      'github',
    )
  })
  ipcMain.handle('repository:surgery-preview', (event, request: unknown) => {
    return readRepository(
      async (root, signal) =>
        previewSurgery(root, await getSnapshot(root, signal), validateSurgeryRequest(request)),
      'surgery-preview',
      'github',
    )
  })
  ipcMain.handle('repository:reconciliation-preview', (event, stackKey: string) => {
    return readRepository(
      async (root) => previewReconciliationRepair(root, await getSnapshot(root), stackKey),
      'reconciliation-preview',
      'github',
    )
  })
  ipcMain.handle('repository:submit-stack-progress', (event) => {
    return readRepository((root) => getSubmitStackProgress(root))
  })
  // Read-only: a queue outcome or a still-running request is read from the journal and GitHub,
  // never by asking for another merge.
  ipcMain.handle('repository:merge-status', (event) => {
    return readRepository((root) => getMergeStatus(root), 'merge-status', 'github')
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
    return readRepository(
      (root, signal) => getPullRequest(root, number, signal),
      `pull-request:${number}`,
      'github',
    )
  })
  ipcMain.handle('repository:search-issues', (event, query: unknown, requestId?: unknown) => {
    const q = typeof query === 'string' ? query : ''
    const reqId = typeof requestId === 'string' ? requestId : 'search-issues'
    return readRepository((root, signal) => searchGitHubIssues(root, q, signal), reqId, 'github')
  })
  ipcMain.handle('repository:pull-request-issue-links', (event, number: unknown) => {
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
      throw new Error('Pull request number must be a positive integer')
    }
    return readRepository(
      (root, signal) => getPullRequestIssueLinks(root, number, signal),
      `issue-links:${number}`,
      'github',
    )
  })
  ipcMain.handle(
    'repository:preview-issue-link',
    (event, prNumber: unknown, issueNumber: unknown, relation: unknown, action: unknown) => {
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
        'github',
      )
    },
  )

  // The review workspace loads in stages: the headline answers first so the
  // title, lifecycle, and stack position are readable while the file list is
  // still being fetched. Each stage claims its own request id, so moving to
  // another pull request cancels the read that is now obsolete instead of
  // letting it answer for a pull request nobody is looking at.
  ipcMain.handle('repository:review-headline', (event, number: unknown, requestId?: unknown) => {
    return readRepository(
      (root, signal) => readReviewHeadline(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-headline'),
      'github',
    )
  })
  ipcMain.handle('repository:review-files', (event, number: unknown, requestId?: unknown) => {
    return readRepository(
      (root, signal) => readReviewFiles(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-files'),
      'github',
    )
  })
  ipcMain.handle('repository:review-commits', (event, number: unknown, requestId?: unknown) => {
    return readRepository(
      (root, signal) => readReviewCommits(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-commits'),
      'github',
    )
  })
  ipcMain.handle('repository:review-viewed', (event, number: unknown) => {
    return readRepository(
      (root, signal) => readViewedRecord(root, requirePullRequestNumber(number), signal),
      'review-viewed',
      'github',
    )
  })
  ipcMain.handle('repository:review-set-viewed', (event, value: unknown) => {
    return readRepository(
      (root, signal) => writeViewedRecord(root, requireViewedRecord(value), signal),
      'review-set-viewed',
      'github',
    )
  })
  ipcMain.handle('repository:review-threads', (event, number: unknown, requestId?: unknown) => {
    return readRepository(
      (root, signal) => readReviewThreads(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-threads'),
      'github',
    )
  })
  ipcMain.handle('repository:review-drafts', (event, number: unknown) => {
    return readRepository(
      async (root, signal) => {
        const remote = await originRemote(root, signal)
        // The journal is shared by every worktree of the repository, so the record
        // is what says whose drafts these are. Reading them without naming the
        // account and the repository would hand one account another's unsent
        // words to submit.
        const permissions = await readReviewPermissions(
          root,
          requirePullRequestNumber(number),
          signal,
        )
        return readReviewDrafts(
          root,
          `${remote.owner}/${remote.name}`,
          permissions.viewer,
          requirePullRequestNumber(number),
          signal,
        )
      },
      'review-drafts',
      'github',
    )
  })
  ipcMain.handle('repository:review-set-drafts', (event, value: unknown) => {
    return readRepository(
      async (root, signal) => {
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
      },
      'review-set-drafts',
      'github',
    )
  })
  ipcMain.handle('repository:review-submit', (event, number: unknown, value: unknown) => {
    return operations.write(() =>
      inGitRuntime(() =>
        submitReview(repository(), requirePullRequestNumber(number), requireSubmission(value)),
      ),
    )
  })
  ipcMain.handle(
    'repository:review-reply',
    (event, number: unknown, threadId: unknown, body: unknown) => {
      return operations.write(() =>
        inGitRuntime(() =>
          replyToThread(
            repository(),
            requirePullRequestNumber(number),
            requireThreadId(threadId),
            requireCommentBody(body),
          ),
        ),
      )
    },
  )
  ipcMain.handle(
    'repository:review-resolve',
    (event, number: unknown, threadId: unknown, resolved: unknown) => {
      if (typeof resolved !== 'boolean') throw new Error('Choose whether to resolve this thread.')
      return operations.write(() =>
        inGitRuntime(() => setThreadResolved(repository(), requireThreadId(threadId), resolved)),
      )
    },
  )
  ipcMain.handle('repository:review-resolve-drafts', (event, number: unknown, value: unknown) => {
    return readRepository(
      (root, signal) =>
        resolveReviewDraftsAt(
          root,
          requirePullRequestNumber(number),
          Array.isArray(value) ? value.map(requireDraft) : [],
          signal,
        ),
      'review-resolve-drafts',
      'github',
    )
  })
  ipcMain.handle('repository:review-history', (event, number: unknown, requestId?: unknown) => {
    return readRepository(
      (root, signal) => readReviewHistory(root, requirePullRequestNumber(number), signal),
      requestIdClaim(requestId, 'review-history'),
      'github',
    )
  })
  ipcMain.handle(
    'repository:review-history-diff',
    (event, number: unknown, fromOid: unknown, requestId?: unknown) => {
      return readRepository(
        (root, signal) =>
          readReviewHistoryDiff(
            root,
            requirePullRequestNumber(number),
            requireCommitOid(fromOid),
            signal,
          ),
        requestIdClaim(requestId, 'review-history-diff'),
        'github',
      )
    },
  )
  ipcMain.handle('repository:review-clear-history', (event, number: unknown) => {
    return readRepository(
      (root, signal) => clearReviewHistory(root, requirePullRequestNumber(number), signal),
      'review-clear-history',
      'github',
    )
  })

  ipcMain.handle(
    'repository:pull-request-checks',
    (event, number: number, options?: PullRequestChecksOptions) => {
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error('Pull request number must be a positive integer.')
      }
      return readRepository(
        (root, signal) => getPullRequestChecks(root, number, { ...options, signal }),
        `pull-request-checks:${number}`,
        'github',
      )
    },
  )
  // Rerunning a workflow mutates GitHub, so it is a write: it is refused while any
  // other repository operation is in flight rather than interleaving with one.
  ipcMain.handle('repository:pull-request-check-rerun', (event, number: number, runId: number) => {
    return operations.write(() => rerunPullRequestCheck(repository(), number, runId))
  })

  ipcMain.handle('operation:cancel', (event, requestId: unknown) => {
    if (typeof requestId !== 'string' || !requestId) return
    if (requestId === 'pr-index') prIndex.cancel()
    onboardingKeys.cancel(ONBOARDING_ROOT, requestId)
    // The queue runs across repositories, so it is cancelled whether or not one
    // is open: a window with no repository still has a queue to stop.
    inboxKeys.cancel(INBOX_ROOT, requestId)
    if (!activeRepository) return
    readKeys.cancel(activeRepository, requestId)
  })
  ipcMain.handle('external:open', async (event, value: unknown) => {
    // Trust is decided by the hosts this installation already speaks to, never
    // by the shape of the link. A host that is only spelled like one of them is
    // a different host, and a link to it is refused the same as any other.
    const link = externalGitHubLink(value, await trustedExternalLinkHosts())
    if (!link.ok) throw new Error(link.message)
    await shell.openExternal(link.href)
  })

  // The PR Inbox is a GitHub-derived queue over every registered repository, so
  // it runs before any repository is open and is not scoped to the one that is.
  // Its reads claim their own request ids, which makes a refresh cancellable
  // and makes a later refresh end the one still in flight.
  ipcMain.handle('inbox:pull-requests', async (event, requested: unknown) => {
    const asked = (requested ?? {}) as { requestId?: unknown; mergedWithinDays?: unknown }
    const days = asked.mergedWithinDays
    const mergedWithinDays =
      typeof days === 'number' && Number.isFinite(days) && days > 0
        ? Math.min(365, Math.round(days))
        : undefined
    try {
      return await forSelectedHost((signal) => {
        // The identity is captured with the work, and the read is aborted when
        // it is replaced, so a late page read under the previous account's
        // credential is stopped and refused rather than published.
        const controller = new AbortController()
        inboxWork.add(controller)
        return performBackgroundRead(
          inboxKeys,
          INBOX_ROOT,
          AbortSignal.any([signal, controller.signal]),
          async (combined) => {
            // Origin remotes are read through the same local Git as every other
            // repository read, so the queue sees exactly the origin the window
            // would have opened.
            const targets = await inboxTargets()
            // Fenced after the targets are resolved, so the hosts this read asks
            // are the hosts whose credentials the identity names.
            const identity = await inboxIdentityNow()
            const report = await inGitRuntime(() =>
              inboxService.refresh(targets, {
                ...(mergedWithinDays ? { mergedWithinDays } : {}),
                signal: combined,
              }),
            )
            // Asked after that last await rather than only before it. Reading
            // the identity is asynchronous, so a refresh that was ended, or
            // replaced, while it was being re-read reaches here with an answer
            // that must not be published; and a `gh` profile or a repository
            // registered since must retire it rather than publish it.
            const finalIdentity = await inboxIdentityNow()
            if (combined.aborted || finalIdentity !== identity) throw new CommandCancelled()
            return report
          },
          requestIdClaim(asked.requestId, 'inbox-refresh'),
        ).finally(() => {
          inboxWork.delete(controller)
        })
      })
    } catch (error) {
      // Only a read that was ENDED becomes a retired queue. Every other
      // failure still rejects: a read that could not answer is the window's
      // business, and this must not claim a queue it never confirmed or quietly
      // replace rows that are still the ones GitHub confirmed. The retired
      // report is returned rather than thrown so that the read still passes
      // through the window's own gate, which is what stops a superseded read
      // from painting over a newer one.
      if (!isCommandCancelled(error)) throw error
      return retiredPullRequestInboxReport(
        mergedWithinDays ?? PULL_REQUEST_INBOX_MERGED_WINDOW_DAYS,
      )
    }
  })
  ipcMain.handle('inbox:filters', async (event) => {
    return inboxFiltersReady.then(() => inboxFilters.list())
  })
  ipcMain.handle('inbox:filters-save', async (event, value: unknown) => {
    if (!Array.isArray(value)) throw new Error('Saved filters must be a list.')
    // This write replaces the whole list, so it waits for the stored list to
    // have been read: a save taken against an unread store would drop every
    // saved filter that store holds.
    await inboxFiltersReady
    return inboxFilters.save(value as PullRequestInboxFilterDraft[])
  })
  // The capability matrix for the host this installation is pointed at. It is
  // produced by probing that host, so a host that has never answered reports
  // unknown rather than anything it was not shown to do.
  ipcMain.handle('github:host-status', async (event) => {
    // The host and its generation are taken before the origin is read, so a host
    // change during that read cannot leave this answering with the retired host.
    const selected = captureSelectedHost()
    // The open repository is probed only when it lives on the host being
    // reported, so a capability is never established from a repository that
    // belongs to some other host.
    const repository = activeRepository
      ? await openRepositoryOnHost(activeRepository, selected.context)
      : null
    // The probe belongs to the host selected when it started: a host change
    // aborts it and refuses its answer, so a retired host's late result cannot
    // recreate the record that was just forgotten or overwrite a newer status.
    return forSelectedHost(
      // The CLI status is what established, or refused, this host's
      // authentication; a probe that reported it as unknown would contradict a
      // read this app has already made.
      (signal) =>
        probeGitHubHost(selected.context, { repository, signal, cli: githubCli().current() }),
      selected,
    )
  })
  ipcMain.handle('git-runtime', async (event) => {
    return operations.read(() => gitRuntimeStatus(settingsFile()))
  })
  ipcMain.handle('git-runtime:system-git', async (event, requested: unknown) => {
    if (typeof requested !== 'boolean') throw new Error('Use system Git must be true or false.')
    // This control predates Settings and is still mounted. It goes through the
    // same policy-aware write as the Settings surface so a machine that locked
    // the choice cannot be changed through the older dialog.
    await changeSettings((file) =>
      updateSettings(file, { git: { useSystemGit: requested } }, settingsLocks),
    )
    return gitRuntimeStatus(settingsFile())
  })
  // Settings never take the repository gate: a preference can be corrected
  // while a repository is mid-operation, and locking the user out of Settings
  // to change an unrelated preference is not a safety property.
  ipcMain.handle('settings', async (event) => {
    return runSettingsTransaction(async () => {
      return withToolAvailability(await readSettingsSnapshot(settingsFile(), settingsLocks))
    })
  })
  ipcMain.handle('settings:update', async (event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('Settings changes must be an object of setting groups.')
    }
    return withToolAvailability(await changeSettingsPatch(patch as SettingsPatch))
  })
  ipcMain.handle('settings:reset', async (event) => {
    // Restoring defaults touches this app's own settings and its own update
    // state and nothing else: no repository, ref, or working tree is read or
    // written. A reset carries the update channel with it, so it is decided with
    // the updater rather than written beside it: the reset is written while the
    // change is still undecided, and a reset refused — because an install owns
    // the files — writes nothing at all. A reset that does go through also
    // disposes of the update the previous channel had staged, because that staged
    // file belongs to the channel being left and is this app's own to remove.
    //
    // Which channel a reset lands on is read out of the file the reset is about
    // to rewrite, because a policy that has fixed the channel keeps it rather
    // than resetting it. That read is the first thing this transaction asks for
    // and its admission is the second, in that order. Reading it before asking to
    // be admitted would let a channel change asked for a moment later be admitted
    // first and then be overwritten by this reset, so the later choice would be
    // the one lost; the read is made inside the boundary instead, where the
    // reset is already next in line. Both requests go through the updater's own
    // queue, so the order a person asked in is the order the two are written in.
    const service = updateService
    if (!service) {
      return withToolAvailability(
        await changeSettings((file) => resetSettings(file, settingsLocks)),
      )
    }
    let committed: SettingsSnapshot | null = null
    const status = await service.applyResolvedChannel(
      async () =>
        resetTarget((await readSettingsFile(settingsFile())).settings, settingsLocks).updates
          .channel,
      async () => {
        committed = await changeSettings((file) => resetSettings(file, settingsLocks))
      },
    )
    if (!committed) {
      throw new Error(status.failure?.message ?? 'The settings were not reset.')
    }
    return withToolAvailability(committed)
  })
  // The capability report takes no argument, so the window cannot ask main to
  // run a command of its choosing. Main runs its own fixed allowlist.
  ipcMain.handle('diagnostics', async (event) => {
    const settings = (await readSettingsFile(settingsFile())).settings
    return operations.read(() => currentDiagnostics(settings))
  })
  ipcMain.handle('support-bundle:preview', async (event) => {
    const settings = await runSettingsTransaction(async () => {
      return (await readSettingsFile(settingsFile())).settings
    })
    const report = await operations.read(() => currentDiagnostics(settings))
    const preview = buildBundle(report, settings, recordedFailures())
    const id = `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const renderedBody =
      preview.renderedBody ?? renderBundle(preview, settings.privacy.includeLocalPaths)
    const bytes = preview.bytes ?? Buffer.byteLength(renderedBody)
    const pathCount = settings.privacy.includeLocalPaths ? preview.pathCount : 0

    return runSettingsTransaction(async () => {
      activeBundlePreview = {
        id,
        preview: { ...preview, id },
        renderedBody,
        bytes,
        pathCount,
        consent: settings.privacy.includeLocalPaths,
        settingsRevision,
        timestamp: Date.now(),
      }
      return { ...preview, id, bytes, pathCount }
    })
  })
  ipcMain.handle('support-bundle:export', async (event, requestedPreviewId: unknown) => {
    if (typeof requestedPreviewId !== 'string' || requestedPreviewId.trim().length === 0) {
      throw new Error('A valid support bundle preview ID is required.')
    }
    if (!activeBundlePreview || activeBundlePreview.id !== requestedPreviewId) {
      throw new Error(
        'The support bundle preview has expired or does not match the active preview. Please preview the bundle again before exporting.',
      )
    }
    if (!window) throw new Error('There is no window to export from.')
    const target = await dialog.showSaveDialog(window, {
      title: 'Export support bundle',
      defaultPath: join(app.getPath('downloads'), 'git-stacks-support.txt'),
      filters: [{ name: 'Text', extensions: ['txt'] }],
    })
    if (target.canceled || !target.filePath) return { path: '', bytes: 0, includedPaths: 0 }

    return runSettingsTransaction(async () => {
      const snapshot = activeBundlePreview
      if (!snapshot || snapshot.id !== requestedPreviewId) {
        throw new Error(
          'The support bundle preview has expired or does not match the active preview. Please preview the bundle again before exporting.',
        )
      }
      if (snapshot.settingsRevision !== settingsRevision) {
        throw new Error(
          'Settings changed while preparing export. Please preview the bundle again before exporting.',
        )
      }
      const currentSettings = (await readSettingsFile(settingsFile())).settings
      if (currentSettings.privacy.includeLocalPaths !== snapshot.consent) {
        throw new Error(
          'Privacy consent changed while preparing export. Please preview the bundle again before exporting.',
        )
      }

      await writeOwnerOnlyBundle(target.filePath, snapshot.renderedBody)
      return {
        path: target.filePath,
        bytes: snapshot.bytes,
        includedPaths: snapshot.pathCount,
      }
    })
  })
  // Main resolves the editor from settings and checks the path is inside the
  // repository. The renderer supplies neither a command nor an absolute path.
  ipcMain.handle('editor:open', async (event, relativePath: unknown) => {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new Error('A file path is required.')
    }
    if (!activeRepository) return { opened: false, reason: 'No repository is open.' }
    const settings = (await readSettingsFile(settingsFile())).settings
    return openInEditor(settings.git.editor, activeRepository, relativePath)
  })
  // CLI status only: a real read of the installed CLI and the account it holds.
  // There is no sign-in, account-switch, or sign-out channel — those belong to
  // the GitHub CLI — and no handler here can return, log, or accept a
  // credential. It never takes the repository gate either, so a stalled GitHub
  // endpoint cannot block local Git work.
  ipcMain.handle('github-cli:status', async (event) => {
    // A read that started for a host that is no longer selected is discarded: the
    // answer comes from the host that replaced it, so a late read never describes
    // a host this window has left.
    const selected = captureSelectedHost()
    const status = await githubCli().read()
    if (selected.generation !== hostGeneration) return githubCli().current()
    return status
  })

  // The optional Notification Center. It carries its own separately authorized
  // credential and never touches a repository: a GitHub that will not answer
  // notifications must not block local Git work, and removing its credential
  // must not disturb the GitHub CLI account the rest of the app reads through.
  ipcMain.handle('notifications:status', async (event) => {
    return notificationCenter().status()
  })
  ipcMain.handle('notifications:inbox', async (event) => {
    return notificationCenter().inbox()
  })
  // The refresh takes no arguments at all. The floor it waits for is GitHub's,
  // so nothing the window can send — not a flag, not a count — can outrun it.
  ipcMain.handle('notifications:refresh', async (event) => {
    return notificationCenter().refresh()
  })
  ipcMain.handle('notifications:cancel', (event) => {
    notifications?.cancel()
  })
  // The token arrives once, here, and is sealed with a key protected by the
  // operating system. The reply is a status object, so no handler, log,
  // failure record, or support bundle can carry the secret back out.
  ipcMain.handle(
    'notifications:save-credential',
    async (event, token: unknown, consent: unknown, host: unknown) => {
      const currentHost = configuredHost().host
      if (typeof host !== 'string' || host !== currentHost) {
        throw new Error(
          'This token was typed for a different GitHub host, so it was not stored and not sent anywhere.',
        )
      }
      return notificationCenter().saveCredential(token, consent, host)
    },
  )
  ipcMain.handle('notifications:remove-credential', async (event) => {
    return notificationCenter().removeCredential()
  })
  ipcMain.handle('notifications:mark-read', async (event, threadId: unknown) => {
    return notificationCenter().markRead(threadId)
  })
  ipcMain.handle('notifications:done', async (event, threadId: unknown) => {
    return notificationCenter().markDone(threadId)
  })
  ipcMain.handle(
    'notifications:subscription',
    async (event, threadId: unknown, action: unknown) => {
      return notificationCenter().setSubscription(threadId, action)
    },
  )

  // The update lifecycle. Each handler takes no argument at all: the channel
  // comes from settings main already owns, and the step comes from main's own
  // state machine. Nothing the window can send chooses a URL, a file, or a
  // command.
  ipcMain.handle('update:status', (event) => {
    return requireUpdateService().status()
  })
  ipcMain.handle('update:check', async (event) => {
    return await requireUpdateService().check()
  })
  ipcMain.handle('update:download', async (event) => {
    return await requireUpdateService().download()
  })
  ipcMain.handle('update:install', async (event) => {
    return await requireUpdateService().install()
  })
  ipcMain.handle('update:cancel', (event) => {
    return requireUpdateService().cancel()
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
    try {
      const stored: unknown = JSON.parse(await readFile(settingsPath(), 'utf8'))
      if (Array.isArray(stored))
        setRecents(
          stored
            .filter(
              (item): item is RecentRepository =>
                item && typeof item.path === 'string' && typeof item.name === 'string',
            )
            .slice(0, 12),
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('Could not read recent repositories:', error)
    }
    // Development/smoke runs can use a disposable repository without touching the user's preferences.
    if (!app.isPackaged && process.env.GIT_STACKS_REPO) {
      const path = await resolveRepository(process.env.GIT_STACKS_REPO)
      setRecents([{ path, name: basename(path) }, ...recents.filter((item) => item.path !== path)])
    }
    const resourcesRoot = app.isPackaged
      ? process.resourcesPath
      : resolve(bundleDir, '../../resources')
    // Policy is read before the first settings read, so a locked key is already
    // fixed by the time the window can ask for anything.
    const policy = await loadSettingsPolicy(process.env.GIT_STACKS_SETTINGS_POLICY)
    settingsLocks = policy.locks
    settingsPolicyError = policy.error
    if (policy.error) console.warn(policy.error)
    // The selected host is applied before anything can ask for it, so sign-in,
    // discovery, and clone commands address the host the person chose.
    applySettings((await readSettingsFile(settingsFile())).settings)
    // The updater is started before the window exists, so the first thing the
    // surface can ask about is already the truth: whether this build is signed,
    // which channel it follows, and whether a staged installer is waiting.
    updateService = new UpdateService({
      packaged: app.isPackaged,
      currentVersion: app.getVersion(),
      appPath: app.getPath('exe'),
      userDataPath: app.getPath('userData'),
      platform: process.platform,
      arch: process.arch,
      relaunch: () => {
        app.relaunch()
        app.quit()
      },
      quit: () => {
        // The installer replaces files this app is running from, so Windows
        // gets the app closed and the installer finishes on its own.
        app.quit()
      },
    })
    updateService.onChange((status) => {
      window?.webContents.send('update:status', status)
    })
    await updateService.start(currentSettings?.updates.channel ?? 'stable')
    const preference = await readGitRuntimePreference(settingsFile()).catch(() => false)
    configureGitRuntime({
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      resourcesRoot,
      useSystemGit: preference,
    })
    // The clone promotion helper is bundled beside the Git runtime and resolves
    // from the same resources directory.
    configurePromotionHelper(resourcesRoot)
    // The primary record an earlier build kept for its own GitHub App sign-in is
    // retired here, before any handler can reach GitHub: this build
    // authenticates through the GitHub CLI, so the sealed credential and the
    // state file naming it belong to nothing this app still owns. Only what the
    // record itself names is removed — never the CLI's credential, the operating
    // system store, or another module's entry. That last claim is the gate's: a
    // Notifications credential is a sealed entry of the same shape for the same
    // host, so it is protected by the name its own state publishes, and state
    // that cannot be read protects everything by retiring nothing. A corrupt
    // optional file costs this startup nothing else: it is no reason to refuse
    // the window, or the local Git work behind it.
    await retireLegacyPrimaryRecord(
      {
        vault: applicationVault(),
        vaultFile: join(app.getPath('userData'), 'credentials.vault.json'),
        stateFile: join(app.getPath('userData'), 'github-account.json'),
      },
      app.getPath('userData'),
    ).catch(() => null)
    // The CLI is read once before the window opens, so what the first render
    // shows is established rather than assumed. Nothing here waits on GitHub: a
    // machine with no CLI, or with none signed in, starts regardless.
    void githubCli()
      .read()
      .catch(() => null)
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
