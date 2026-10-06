import type { UpdateStatus } from '../../../src/shared/update'
import { REVIEW_STACK_METADATA_LIMIT } from '../../../src/shared/performance'
import type {
  ActionResult,
  ConflictFile,
  DesktopAPI,
  GitAction,
  GitHubCliStatus,
  GitHubRepositorySummary,
  GitRuntimeInfo,
  GitRuntimeStatus,
  HistoryPage,
  MergeProgress,
  MergeStatus,
  PushPreview,
  RemoteFreshness,
  RepositorySnapshot,
  SyncActivity,
  StackKind,
  StackPreview,
  SurgeryPreview,
} from '../../../src/shared/types'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsSnapshot,
} from '../../../src/shared/settings'
import {
  conflictLabels,
  conflictRegions,
  parseConflictSegments,
} from '../../../src/shared/conflict'
import type { ReviewHistoryDiff } from '../../../src/shared/review-snapshots'
import {
  parsePullRequestInboxFilterDraft,
  parsePullRequestInboxSavedFilters,
  type PullRequestInboxFilterDraft,
  type PullRequestInboxSavedFilter,
} from '../../../src/shared/pr-inbox'
import type { ReviewHeadline, ReviewViewedRecord } from '../../../src/shared/review'
import {
  fileViewFixtures,
  historyCommits,
  longDiffText,
} from '../../../src/renderer/src/design-system/data-fixtures'
import {
  insertSurgeryPreview,
  leasePreview,
  mergePreview,
  mergeStatus,
  mergeStatusQueueSentence,
  publishPreview,
  restackPreview,
  syncPreview,
} from '../../fixtures/workflow-scenarios'
import {
  reviewCommits,
  reviewFileSet,
  reviewPermissions,
  reviewRail,
  reviewThreadSet,
  stackMember,
  textFile,
} from './review'
import type { ReviewFile, ReviewLine, ReviewSide } from '../../../src/shared/review'
import type {
  ReviewDraftRecord,
  ReviewDraftResolution,
  ReviewEvent,
} from '../../../src/shared/review-threads'
import { checksReportFor, notificationInbox, scenarios } from './scenarios'
import { updateStatusFixture } from './update-status'
import { diagnosticsReportFixture } from './diagnostics'
import { DEFAULT_SCENARIO, type ScenarioName } from './manifest'
import type { PullRequestChecksReport } from '../../../src/shared/pull-request-checks'
import type { FixtureCall, FixtureCallRecord, FixtureControl, FixtureScenario } from './types'
import { canonicalHostName, GITHUB_DEFAULT_HOST } from '../../../src/shared/host'
import type { NotificationInbox, NotificationModuleState } from '../../../src/shared/notifications'

/** The review state GitHub reports back for each submitted event. */
const REVIEW_SUBMIT_STATES: Record<ReviewEvent, string> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
}

/** Production labels of the controls that open a repository from the onboarding pane. */
const OPEN_REPOSITORY_LABELS = ['Open local repository', 'Open repository']

/** Commits per `history()` page; the fixture list is three commits long. */
const HISTORY_PAGE_SIZE = 2

const stackPreviewsByKind: Record<StackKind, StackPreview> = {
  restack: restackPreview,
  publish: publishPreview,
  merge: mergePreview,
  sync: syncPreview,
}

function unresolved(id: string, reason: string): ReviewDraftResolution {
  return { id, match: 'unresolved', side: null, line: null, startLine: null, reason }
}

/** The line a draft's address names, or null when the file set no longer has it. */
function lineAt(
  files: ReviewFile[],
  path: string,
  side: ReviewSide,
  number: number,
): ReviewLine | null {
  const file = files.find((entry) => entry.path === path)
  if (!file || file.diff.kind !== 'text') return null
  for (const hunk of file.diff.hunks) {
    for (const line of hunk.lines) {
      if (line.side !== side) continue
      if ((side === 'base' ? line.oldLine : line.newLine) === number) return line
    }
  }
  return null
}

const bundledRuntime: GitRuntimeInfo = {
  source: 'bundled',
  executable: '/Applications/Git Stacks.app/Contents/Resources/git/bin/git',
  platform: 'darwin',
  version: '2.51.0',
  versionOutput: 'git version 2.51.0',
  minimumVersion: '2.40.0',
  meetsMinimum: true,
  useSystemGit: false,
  packaged: true,
  capabilities: { referenceTransactions: true, rebaseUpdateRefs: true },
  bundled: {
    gitVersion: '2.51.0',
    sha256: 'b'.repeat(64),
    source: 'https://github.com/git/git/releases/download/v2.51.0/git-v2.51.0.tar.xz',
  },
  preservedEnvironment: ['GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR'],
  preservedConfiguration: [],
}

const runtimeStatus = (useSystemGit: boolean): GitRuntimeStatus => ({
  runtime: { ...bundledRuntime, useSystemGit, source: useSystemGit ? 'system' : 'bundled' },
  error: null,
  minimumVersion: bundledRuntime.minimumVersion,
  useSystemGit,
})

/** Deterministic status message per action, so success notices are screenshot-stable. */
function actionMessage(action: GitAction): string {
  switch (action.type) {
    case 'switch':
      return `Switched to ${action.ref}`
    case 'createBranch':
      return `Created ${action.name} from ${action.parent}`
    case 'deleteBranch':
      return `Deleted ${action.ref}`
    case 'stage':
      return `Staged ${action.paths.length} path${action.paths.length === 1 ? '' : 's'}`
    case 'unstage':
      return `Unstaged ${action.paths.length} path${action.paths.length === 1 ? '' : 's'}`
    case 'commit':
      return action.amend ? 'Amended the last commit' : 'Committed the staged changes'
    case 'fetch':
      return 'Fetched remote updates'
    case 'push':
      return 'Pushed the current branch'
    case 'rebaseContinue':
      return 'Continued the operation'
    case 'rebaseAbort':
      return 'Aborted the operation and restored the previous state'
    case 'pull':
      return `Pulled with the ${action.strategy} strategy`
    case 'forcePush':
      return `Force pushed ${action.preview.branch} to ${action.preview.destination}`
    case 'stash':
      return 'Stashed the working changes'
    case 'stashPop':
      return `Popped ${action.ref}`
    case 'stashApply':
      return `Applied ${action.ref}`
    case 'stashDrop':
      return `Dropped ${action.ref}`
    case 'rebase':
      return `Rebased onto ${action.parent}`
    case 'createPr':
      return `Opened a${action.draft ? ' draft' : ''} pull request into ${action.base}`
    case 'renameBranch':
      return `Renamed ${action.ref} to ${action.name}`
    case 'deleteRemoteBranch':
      return `Deleted ${action.ref} from its remote`
    case 'setUpstream':
      return action.upstream ? `Tracking ${action.upstream}` : 'Stopped tracking the remote branch'
    case 'merge':
      return `Merged ${action.ref}`
    case 'cherryPick':
      return `Cherry-picked ${action.oid.slice(0, 10)}`
    case 'revert':
      return `Reverted ${action.oid.slice(0, 10)}`
    case 'operationContinue':
      return 'Continued the operation'
    case 'operationSkip':
      return 'Skipped the current commit'
    case 'operationAbort':
      return 'Aborted the operation and restored the previous state'
    case 'discardFile':
      return `Discarded unstaged changes in ${action.path}`
    case 'resolveConflict':
      return `Resolved and staged ${action.path}`
    case 'stageHunk':
      return `Staged the selected hunk in ${action.path}`
    case 'unstageHunk':
      return `Unstaged the selected hunk in ${action.path}`
    case 'conflictMergeTool':
      return `Opened the merge tool for ${action.path}`
    case 'setParent':
      return `Recorded ${action.branch} on ${action.parent}`
    case 'executeStack':
      return `Ran the ${action.mergeMethod} ${action.token} stack operation`
    case 'submitStack':
      return 'Submitted the stack'
    case 'submitStackRetry':
      return 'Resumed the stack submission'
    case 'submitStackDismiss':
      return 'Dismissed the stack submission'
    case 'stackContinue':
      return 'Continued the stack restack'
    case 'stackAbort':
      return 'Aborted the stack restack and restored the saved branch tips'
    case 'updatePr':
      return `Updated pull request #${action.number}`
    case 'closePr':
      return `Closed pull request #${action.number}`
    case 'reopenPr':
      return `Reopened pull request #${action.number}`
    case 'createNativeStack':
      return `Stacked pull requests ${action.pullRequests.map((n) => `#${n}`).join(', ')}`
    case 'addPullRequestsToNativeStack':
      return `Added pull requests ${action.pullRequests.map((n) => `#${n}`).join(', ')} to stack #${action.stackNumber}`
    case 'unstackNativeStack':
      return `Removed pull requests from stack #${action.stackNumber}`
    case 'reconcileRepair':
      return `Applied ${action.ids.length} reconciliation repairs`
    case 'linkIssue':
      return `Linked issue #${action.issueNumber} to pull request #${action.prNumber}`
    case 'unlinkIssue':
      return `Removed issue #${action.issueNumber} from pull request #${action.prNumber}`
    case 'executeSurgery':
      return `Ran the reviewed surgery ${action.token}`
  }
}

interface WaitingCall {
  call: FixtureCall
  settle: () => void
}

/**
 * Installs the typed fixture double on `window.desktop` and the control surface on
 * `window.fixture`. The returned control stays valid across `setScenario`, because the
 * double reads the mounted scenario through a closure instead of rebuilding itself.
 */
export function installFixtureControl(options: {
  scenario: string
  onScenarioChange: (name: string) => void
}): FixtureControl {
  const actions: GitAction[] = []
  const externalUrls: string[] = []
  /** Pending drafts per pull request, held for the life of the page as the real journal is. */
  const heldDrafts = new Map<number, ReviewDraftRecord>()
  const calls: FixtureCallRecord[] = []
  const holds = new Set<FixtureCall>()
  const oneShotFailures = new Map<FixtureCall, string>()
  const oneShotAnswers = new Map<FixtureCall, unknown>()
  const dropListeners = new Set<(paths: string[]) => void>()
  const released = new Set<FixtureCall>()
  const waiting: WaitingCall[] = []
  let startsPending = new Set<FixtureCall>()
  let mergeStatusReads = 0
  const mergeListeners = new Set<(progress: MergeProgress | null) => void>()
  const publishMergeProgress = (progress: MergeProgress | null): void => {
    for (const listener of mergeListeners) listener(progress)
  }
  /** Saved filters, as the main process keeps them: whole-list writes, identities preserved. */
  let inboxFilters: PullRequestInboxSavedFilter[] = []

  const scenarioFor = (name: string): FixtureScenario =>
    scenarios[name as ScenarioName] ?? scenarios[DEFAULT_SCENARIO]

  let scenario = scenarioFor(options.scenario)
  startsPending = new Set(scenario.pending ?? [])

  /** One destination path as a copied terminal command writes it. */
  function mockCloneDestination(parentDirectory: string, directoryName: string): string {
    return mockShellWord(`${parentDirectory.replace(/[/\\]+$/u, '')}/${directoryName}`)
  }

  /** Quoting a command argument only when it is not already a plain word. */
  function mockShellWord(value: string): string {
    return /^[A-Za-z0-9._\-/:]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`
  }
  const record = (call: FixtureCall, args: readonly unknown[]): void => {
    calls.push({ call, args })
  }

  function answer<T>(call: FixtureCall, produce: () => T, extraFailure?: string): Promise<T> {
    const permanent = extraFailure ?? scenario.failures?.[call]
    const held = holds.has(call) || (startsPending.has(call) && !released.has(call))
    const settle = (): Promise<T> => {
      const scripted = oneShotAnswers.get(call)
      if (scripted !== undefined) {
        oneShotAnswers.delete(call)
        return Promise.resolve(scripted as T)
      }
      const queued = oneShotFailures.get(call)
      if (queued !== undefined) {
        oneShotFailures.delete(call)
        return Promise.reject(new Error(queued))
      }
      if (permanent !== undefined) return Promise.reject(new Error(permanent))
      try {
        return Promise.resolve(produce())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    if (!held) return settle()
    return new Promise<T>((resolve, reject) => {
      waiting.push({
        call,
        settle: () => {
          settle().then(resolve, reject)
        },
      })
    })
  }

  /**
   * What a Notification Center call answers is what the center held when the
   * call was admitted, not what the double holds when the answer is released.
   * That is the boundary this double exists to exercise: a read of the host
   * that was selected then can land after the window has moved to another one,
   * and it still carries the rows that host read.
   */
  const admittedAnswer = <T>(call: FixtureCall, produce: () => T): Promise<T> => {
    let settled: () => T
    try {
      const admitted = produce()
      settled = () => admitted
    } catch (error) {
      settled = () => {
        throw error
      }
    }
    return answer(call, settled)
  }

  /**
   * The settings this double is running with. The host in them is the
   * authoritative one: the Notification Center is pinned to whatever host the
   * installation selects, and the window is expected to notice that from these
   * settings rather than from whatever a reply happens to name. Everything else
   * here is the value the gallery has always behaved as, so adding this double
   * changes which host the module is about and nothing else.
   */
  const notificationSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    github: { host: scenario.notifications?.host ?? GITHUB_DEFAULT_HOST },
    git: { ...DEFAULT_SETTINGS.git, defaultPullStrategy: 'ff-only' },
    migrated: { legacyShortcutStorage: true },
  }
  const policyLockedNotifications = scenario.notifications?.policyDisabled === true
  const settingsSnapshot = (): SettingsSnapshot => ({
    settings: structuredClone(notificationSettings),
    locks: policyLockedNotifications
      ? [
          {
            key: 'notifications.enabled',
            reason: 'Notifications are held off by policy on this computer.',
          },
        ]
      : [],
    issues: [],
    recovered: false,
    file: '/fixture/settings.json',
  })
  const updateListeners = new Set<(status: UpdateStatus) => void>()
  /**
   * The snapshot repository reads are answered from. Seeded from the scenario,
   * replaced by a successful open, and reset to the newly selected scenario's
   * own snapshot when the scenario changes, because that is the world the
   * double is answering for now.
   *
   * This is not what the window is displaying. `setScenario` installs another
   * scenario's answers without remounting anything, so the App keeps the
   * repository it already opened until it opens or refreshes one itself.
   */
  let active: RepositorySnapshot | null = scenario.snapshot

  const disabledNotifications = (): NotificationInbox => ({
    host: notificationSettings.github.host,
    state: notificationSettings.notifications.enabled ? 'credential-missing' : 'disabled',
    enabled: notificationSettings.notifications.enabled,
    policyDisabled: false,
    reference: null,
    login: null,
    store: { available: true, name: 'Keychain', reason: null },
    message: null,
    threads: [],
    unreadCount: 0,
    poll: {
      fetchedAt: null,
      checkedAt: null,
      nextPollAt: null,
      pollIntervalSeconds: 60,
      lastModified: null,
      unchanged: false,
    },
    stale: false,
    staleReason: null,
    markAllReadPending: false,
  })
  /**
   * What each host this double knows about serves. The center main publishes is
   * the one for the host the installation has selected, and its files belong to
   * that host alone, so the state lives per host rather than in one slot the
   * next host overwrites.
   */
  const hostInboxes = new Map<string, NotificationInbox>()
  if (scenario.notifications) hostInboxes.set(scenario.notifications.host, scenario.notifications)
  let notificationListener: ((inbox: NotificationInbox) => void) | null = null
  const currentNotifications = (): NotificationInbox =>
    hostInboxes.get(notificationSettings.github.host) ?? disabledNotifications()
  const publish = (host: string, inbox: NotificationInbox): NotificationInbox => {
    hostInboxes.set(host, inbox)
    return inbox
  }

  /**
   * The GitHub CLI session this double currently reports, moved the way the
   * main process moves it: a settings change points the installation at another
   * host, and a sign-in, switch, or logout in a terminal replaces the session
   * behind the host it is pointed at. `null` means the scenario's own
   * declaration still answers, which is the state a scenario starts in.
   */
  let servedCliStatus: GitHubCliStatus | null = null
  /** The one window listening for the session to change outside it. */
  let cliStatusListener: ((status: GitHubCliStatus) => void) | null = null

  /**
   * The GitHub answer this double may give a repository read, which belongs to
   * the credential that read it and to nothing else.
   *
   * Main answers a repository read with whatever the credential behind this
   * installation can actually reach, and a credential that was replaced leaves
   * nothing confirmed to reuse: the identity change retires the confirmed
   * payload, so the next read is a fresh one that either answers as the account
   * now in effect or reports that GitHub could not be read. This double holds
   * one static snapshot, so it has to answer the same way or it would hand a
   * window the previous account's private pull requests as the new account's —
   * which is not a thing the real process can do, and which would make every
   * assertion about authority after a replacement prove nothing.
   *
   * A scenario that declares no CLI status has no credential to be bound to, so
   * its snapshot is answered as it always was.
   */
  const answeredForServedCredential = (snapshot: RepositorySnapshot): RepositorySnapshot => {
    const declared = scenario.identity?.cli ?? scenario.githubCliStatus ?? null
    if (declared === null) return snapshot
    const served = servedCliStatus ?? declared
    if (served.host === declared.host && served.identity === declared.identity) return snapshot
    return {
      ...snapshot,
      pullRequests: [],
      issues: [],
      nativeStacks: [],
      nativeStackPreviewAvailable: undefined,
      nativeStackMessage: undefined,
      github: {
        available: false,
        message: 'GitHub could not be read',
      },
      // What a branch carries from a pull request is GitHub's account of where
      // the branch came from, not a local relationship, so it goes with the
      // credential that read it. Everything local about the branch stays.
      branches: snapshot.branches.map((branch) => ({
        ...branch,
        pr: null,
        ...(branch.parentSource === 'pullRequest' ? { parentSource: null, parentTip: null } : {}),
      })),
    }
  }
  /**
   * A write is addressed to the host that was selected when it was admitted, so
   * that is the inbox it changes and the inbox its answer carries — even when
   * the answer is held until after the window has moved on. The change itself
   * lands only if the call is not refused, because a refused write did not
   * happen: that is what makes a refused write observable at all.
   */
  const mutate = (
    call: FixtureCall,
    change: (inbox: NotificationInbox) => NotificationInbox,
  ): Promise<NotificationInbox> => {
    const host = notificationSettings.github.host
    const admitted = hostInboxes.get(host) ?? disabledNotifications()
    return answer(call, () => {
      const next = publish(host, change(admitted))
      notificationListener?.(next)
      return next
    })
  }
  /**
   * What the module's state settles to, using the precedence the main process
   * resolves with: a policy that holds the module off outranks consent, consent
   * outranks a stored credential, and a credential exists only once it has been
   * sealed. Removing a credential therefore cannot hand a module this computer
   * never agreed to — or one a policy holds off — the state where it offers to
   * authorize one.
   */
  const settle = (
    before: NotificationInbox,
    after: Partial<NotificationInbox>,
  ): NotificationInbox => {
    const enabled = after.enabled ?? before.enabled
    const policyDisabled = after.policyDisabled ?? before.policyDisabled
    const reference = after.reference !== undefined ? after.reference : before.reference
    const hasCredential = typeof reference === 'string'
    const state: NotificationModuleState = policyDisabled
      ? 'policy-disabled'
      : !enabled
        ? 'disabled'
        : hasCredential
          ? before.state === 'rejected'
            ? 'rejected'
            : 'ready'
          : 'credential-missing'
    const message =
      state === 'policy-disabled'
        ? 'GitHub Notifications is disabled by the settings policy on this computer. Pull requests, stacks, and reviews keep working.'
        : state === 'disabled'
          ? 'GitHub Notifications is off. It is optional and uses its own credential; nothing else in this app changes when it is off.'
          : state === 'rejected'
            ? 'GitHub rejected the stored notification token. Replace it to read this inbox; nothing else in this app changed.'
            : hasCredential
              ? null
              : 'Store a GitHub notification token to read this inbox. Sign-in, pull requests, and reviews are unaffected.'
    return { ...before, ...after, reference, state, message }
  }
  const desktop: DesktopAPI = {
    recentRepositories: () => {
      record('recentRepositories', [])
      return answer('recentRepositories', () => [...scenario.recentRepositories])
    },
    openRepository: (path) => {
      record('openRepository', path === undefined ? [] : [path])
      const requested = path === undefined ? undefined : scenario.snapshotsByPath?.[path]
      const opened = requested ?? scenario.snapshot
      if (!opened) throw new Error('No repository is open in this fixture.')
      // What this read answers is settled when it is admitted, under the
      // credential that admitted it: a read that answers late after the session
      // was replaced still answers as the account it was made for. Only the
      // answer is held — opening the repository is what actually happens, and it
      // happens when the answer lands.
      const admitted = answeredForServedCredential(opened)
      return answer('openRepository', () => {
        // Opened is the repository that is now on screen, so every read after it
        // is answered from it. Returning the snapshot is not the same thing: the
        // selected pull request's headline, files, and threads are looked up in
        // whichever snapshot is active, and leaving the previous one active is
        // how a row for a second repository reaches a Review workspace that says
        // the pull request is not there.
        active = opened
        return admitted
      })
    },
    refresh: () => {
      record('refresh', [])
      if (!active) throw new Error('No repository is open in this fixture.')
      const admitted = answeredForServedCredential(active)
      return answer('refresh', () => admitted)
    },
    // The settings the double is running with, including the host the
    // Notification Center is pinned to. It answers with the stored value, not
    // with the one that was asked for, exactly as the main process does.
    settings: () => {
      record('notificationSettings', [])
      return admittedAnswer('notificationSettings', () => settingsSnapshot())
    },
    updateSettings: (patch) => {
      // Keep notification-only writes independently holdable for authority-race tests.
      // Record ordinary settings writes with their complete patch.
      const groups = Object.keys(patch)
      const call: FixtureCall =
        groups.length !== 1
          ? 'updateSettings'
          : groups[0] === 'notifications' && patch.notifications?.enabled !== undefined
            ? 'notificationSettingsEnable'
            : groups[0] === 'github' && patch.github?.host !== undefined
              ? 'notificationSettingsHost'
              : 'updateSettings'
      record(call, [patch])
      // The write lands when it is made and only the answer is ever delayed.
      // That is what keeps a held write honest: it is applied to the host that
      // was selected when it was made, never to whichever host the window has
      // been pointed at by the time it is released.
      const host = notificationSettings.github.host
      if (patch.notifications?.enabled !== undefined) {
        // Turning the module on settles the inbox it was holding, and that is
        // pushed to the window rather than left for it to ask about.
        notificationSettings.notifications = {
          ...notificationSettings.notifications,
          ...patch.notifications,
        }
        const settled = settle(hostInboxes.get(host) ?? { ...disabledNotifications(), host }, {
          enabled: patch.notifications.enabled,
        })
        notificationListener?.(settled)
        publish(host, settled)
      }
      // Match the whole-settings merge. Host changes do not publish another host's inbox.
      notificationSettings.github = { ...notificationSettings.github, ...patch.github }
      notificationSettings.git = { ...notificationSettings.git, ...patch.git }
      notificationSettings.appearance = { ...notificationSettings.appearance, ...patch.appearance }
      notificationSettings.privacy = { ...notificationSettings.privacy, ...patch.privacy }
      notificationSettings.updates = { ...notificationSettings.updates, ...patch.updates }
      notificationSettings.shortcuts = { ...notificationSettings.shortcuts, ...patch.shortcuts }
      // The stored value is the one main wrote when it was asked, so a release
      // that lands after a host change still answers with the host this write
      // was made for rather than with whatever is stored now.
      const stored = settingsSnapshot()
      return answer(call, () => stored)
    },
    // The required GitHub CLI's status: which host is being read for, whether
    // that host is signed in, as which account, and which version is installed.
    // It is optional in the product, so the method exists only where a scenario
    // declared a status: every other scenario leaves it off, which is what a
    // main process without this bridge looks like, and answering it unasked
    // would move the GitHub status footer of scenarios that never staged a CLI.
    // The answer is taken when the read is admitted, so a read held across a
    // host change delivers the status of the host it was asked about — never
    // one rebuilt for the host selected afterwards, which would be an answer
    // nobody asked for.
    get githubCliStatus(): (() => Promise<GitHubCliStatus>) | undefined {
      // What this double reports is the session it currently serves, which a
      // test can have moved: the scenario's own declaration until something
      // serves the status this installation now answers with.
      const declared = servedCliStatus ?? scenario.identity?.cli ?? scenario.githubCliStatus
      if (!declared) return undefined
      if (scenario.identity) {
        return () => {
          record('githubCliStatus', [])
          return answer('githubCliStatus', () => declared)
        }
      }
      return () => {
        record('githubCliStatus', [])
        return admittedAnswer('githubCliStatus', () => declared)
      }
    },
    // The CLI session changes outside this window — a sign-in, a switch, a
    // logout, a revocation — so the main process publishes the new status
    // rather than waiting to be asked. The bridge is installed wherever the
    // window asked for a status at all: a build without the optional read has
    // nothing to change either.
    onGitHubCliStatus: (listener) => {
      cliStatusListener = listener
      return () => {
        if (cliStatusListener === listener) cliStatusListener = null
      }
    },
    // The optional Notification Center answers on its own calls, with its own
    // state: the fixture never borrows the pull request inbox for it.
    notifications: () => {
      record('notifications', [])
      return admittedAnswer('notifications', () => currentNotifications())
    },
    notificationsStatus: () => {
      record('notifications', [])
      return admittedAnswer('notifications', () => {
        const {
          threads: _threads,
          unreadCount: _count,
          poll: _poll,
          stale: _stale,
          staleReason: _reason,
          ...status
        } = currentNotifications()
        return status
      })
    },
    onNotifications: (listener) => {
      notificationListener = listener
      return () => {
        notificationListener = null
      }
    },
    refreshNotifications: () => {
      record('notificationRefresh', [])
      // A read is where a bulk change GitHub accepted earlier is confirmed by
      // what it actually did, so a pending one is resolved here rather than
      // being invented as a completed change at the moment it was accepted.
      return admittedAnswer('notificationRefresh', () => {
        const inbox = currentNotifications()
        if (!inbox.markAllReadPending) return inbox
        return publish(notificationSettings.github.host, {
          ...inbox,
          threads: inbox.threads.map((thread) => ({ ...thread, unread: false })),
          unreadCount: 0,
          markAllReadPending: false,
        })
      })
    },
    cancelNotifications: () => {
      record('notificationCancel', [])
      return Promise.resolve()
    },
    saveNotificationCredential: (
      token: string,
      consent: boolean,
      host: string,
    ): Promise<NotificationInbox> => {
      // Sealing a credential is a call of its own rather than one more inbox
      // read, because it is the write the App is waiting on before it asks for
      // the inbox again. A test that holds the read after a successful
      // authorization has to hold exactly that read: holding one kind for both
      // would stop the authorization at the save and prove nothing about the
      // read that follows it.
      // The value crosses the bridge once and is never read back, so the log
      // records that a credential arrived rather than keeping it in page memory.
      record('notificationSave', [token.trim().length > 0, consent, host])
      return mutate('notificationSave', (before) => {
        // The host the dialog named is the host the token is identified against,
        // and a token typed for one host is refused for another exactly as the
        // main process refuses it.
        if (host !== notificationSettings.github.host) {
          throw new Error(
            'This token was typed for a different GitHub host, so it was not stored and not sent anywhere.',
          )
        }
        const served =
          (scenario.notificationsBoxes && scenario.notificationsBoxes[host]) ?? notificationInbox()
        const canonicalHost = canonicalHostName(host)
        const isDefault = canonicalHost === 'github.com'
        const webOrigin = isDefault ? 'https://github.com' : `https://${canonicalHost}`
        // An enterprise host's inbox names whichever account this scenario says
        // the CLI reports for it; the token is authorized for the host and
        // account it names, never for the account another host serves.
        const login = isDefault
          ? served.login
          : (scenario.githubCliStatus?.login ?? served.login ?? 'enterprise-user')
        const threads = served.threads.map((t) => ({
          ...t,
          url: isDefault ? t.url : t.url ? t.url.replace('https://github.com', webOrigin) : null,
        }))
        return settle(before, {
          host: canonicalHost,
          enabled: true,
          reference: served.reference ?? `notification-ref-${canonicalHost}`,
          login,
          threads,
          unreadCount: threads.filter((t) => t.unread).length,
          poll: served.poll,
          stale: false,
          staleReason: null,
          markAllReadPending: false,
        })
      })
    },
    removeNotificationCredential: () => {
      record('notificationRemove', [])
      return mutate('notificationRemove', (before) => {
        // The credential and the list read with it are gone. Consent and policy
        // are not: turning the module off keeps its token, and a policy that
        // holds it off keeps holding it with no token to use.
        return settle(before, {
          reference: null,
          login: null,
          threads: [],
          unreadCount: 0,
          markAllReadPending: false,
        })
      })
    },
    markNotificationRead: (threadId: string | 'all') => {
      record('notificationMarkRead', [threadId])
      return mutate('notificationMarkRead', (inbox) => {
        if (threadId === 'all') {
          // The bulk change is one GitHub accepts and finishes on its own, so
          // what comes back says it was accepted and not that it is done. The
          // rows stay as GitHub last confirmed them until a later read says
          // otherwise.
          return { ...inbox, markAllReadPending: true }
        }
        const threads = inbox.threads.map((thread) =>
          thread.id === threadId ? { ...thread, unread: false } : thread,
        )
        return { ...inbox, threads, unreadCount: threads.filter((t) => t.unread).length }
      })
    },
    markNotificationDone: (threadId: string): Promise<NotificationInbox> => {
      record('notificationDone', [threadId])
      return mutate('notificationDone', (inbox) => {
        // GitHub's Done is the thread itself, not its subscription: the
        // conversation stays subscribed to and the thread leaves the inbox.
        const threads = inbox.threads.filter((thread) => thread.id !== threadId)
        return { ...inbox, threads, unreadCount: threads.filter((t) => t.unread).length }
      })
    },
    setNotificationSubscription: (threadId: string, action: string) => {
      record('notificationSubscription', [threadId, action])
      return mutate('notificationSubscription', (inbox) => {
        const threads =
          action === 'ignore'
            ? inbox.threads.map((thread) =>
                thread.id === threadId ? { ...thread, unread: false } : thread,
              )
            : inbox.threads.filter((thread) => thread.id !== threadId)
        return { ...inbox, threads, unreadCount: threads.filter((t) => t.unread).length }
      })
    },
    runAction: (action) => {
      record('runAction', [action])
      actions.push(action)
      // A merge reports through the progress channel the way the main process does, and it
      // reports while the run is still going: the request is accepted, GitHub is still
      // running it, and the run returns before the result exists. What GitHub reports
      // afterwards comes from a read, not from this.
      if (action.type === 'executeStack' && action.mergeMethod) {
        const layer = mergePreview.merge?.layers[0]
        if (layer) {
          publishMergeProgress({
            action: 'default',
            status: 'running',
            message: `GitHub has not reported a result for pull request #${layer.pullRequest} yet`,
            layers: [
              {
                branch: layer.branch,
                pullRequest: layer.pullRequest,
                status: 'pending',
                detail: 'GitHub has not reported a result yet; refresh to read this request',
                mergedOid: null,
                queue: null,
                requestUuid: 'fixture-request-1',
              },
            ],
          })
        }
      }
      return answer<ActionResult>(
        'runAction',
        () => ({ message: actionMessage(action) }),
        scenario.actionFailures?.[action.type],
      )
    },
    fileView: (path) => {
      record('fileView', [path])
      return answer('fileView', () => {
        const override = scenario.fileViews?.[path]
        if (override) return override
        const known = Object.values(fileViewFixtures).find((view) => view.path === path)
        return { ...(known ?? fileViewFixtures.bothSides), path }
      })
    },
    conflictView: (path) => {
      record('conflictView', [path])
      return answer<ConflictFile>('conflictView', () => {
        const view = fileViewFixtures.conflicted
        if (
          path !== view.path ||
          view.content === null ||
          !active?.files.some((file) => file.path === path && file.conflicted)
        ) {
          throw new Error(`No conflict fixture exists for ${path}.`)
        }
        return {
          path,
          kind: 'content',
          stages: [1, 2, 3],
          stagePreviewTruncated: [],
          binary: false,
          labels: conflictLabels({
            operation: active.operation,
            currentBranch: active.currentBranch,
            incomingSubject: null,
            incomingRef: null,
            stash: null,
            stashAvailable: false,
          }),
          base: 'export const value = 0\n',
          current: 'export const value = 1\n',
          incoming: 'export const value = 2\n',
          worktree: view.content,
          worktreePresent: true,
          regions: conflictRegions(parseConflictSegments(view.content)),
          moves: [],
          truncated: false,
          fingerprint: view.fingerprint,
          mergeTool: { available: false, tool: null, reason: 'No merge tool configured.' },
        }
      })
    },
    history: (ref, skip) => {
      record('history', [ref, skip])
      return answer<HistoryPage>('history', () => {
        if (scenario.history) return scenario.history
        const commits = historyCommits.slice(skip, skip + HISTORY_PAGE_SIZE)
        return { commits, hasMore: skip + commits.length < historyCommits.length }
      })
    },
    commitDiff: (oid) => {
      record('commitDiff', [oid])
      return answer(
        'commitDiff',
        () => scenario.commitDiff ?? { text: longDiffText, truncated: false },
      )
    },
    pushPreview: () => {
      record('pushPreview', [])
      return answer<PushPreview>('pushPreview', () => scenario.pushPreview ?? leasePreview)
    },
    stackPreview: (kind, branch) => {
      record('stackPreview', [kind, branch])
      return answer<StackPreview>('stackPreview', () => {
        const preview = scenario.stackPreviews?.[kind] ?? stackPreviewsByKind[kind]
        return preview.kind === kind ? preview : { ...preview, kind }
      })
    },
    surgeryPreview: (request) => {
      record('surgeryPreview', [request])
      return answer<SurgeryPreview>('surgeryPreview', () => {
        const preview = scenario.surgeryPreview ?? insertSurgeryPreview
        return preview.kind === request.kind ? preview : { ...preview, kind: request.kind }
      })
    },
    mergeStatus: () => {
      record('mergeStatus', [])
      return answer<MergeStatus>('mergeStatus', () => {
        const base = scenario.mergeStatus ?? mergeStatus
        // The queue lands the group between reads, so a refresh visibly replaces the queued
        // layer with what GitHub now reports for it; a later read fails, standing in for a
        // transport error that must not erase the last result GitHub reported.
        const read = mergeStatusReads++
        if (read === 2) throw new Error('GitHub is unreachable')
        if (read === 0) return base
        return {
          ...base,
          layers: base.layers.map((layer) =>
            layer.status === 'enqueued'
              ? {
                  ...layer,
                  status: 'merged' as const,
                  detail: 'Merged on GitHub as 4444444444',
                  mergedOid: '4444444444444444444444444444444444444444',
                  queue: { ...layer.queue!, outcome: 'merged' as const },
                }
              : layer,
          ),
          message: base.message.replace(mergeStatusQueueSentence, 'Pull request #40 merged.'),
        }
      })
    },
    pullRequest: (number) => {
      record('pullRequest', [number])
      return answer('pullRequest', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        if (!found) throw new Error(`Pull request #${number} is not in this fixture snapshot.`)
        return {
          ...found,
          body: `${found.title}\n\nDeterministic fixture body for pull request #${number}.`,
        }
      })
    },
    onMergeProgress: (listener) => {
      mergeListeners.add(listener)
      return () => {
        mergeListeners.delete(listener)
      }
    },
    reviewHeadline: (number) => {
      record('reviewHeadline', [number])
      return admittedAnswer('reviewHeadline', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        if (!found) throw new Error(`Pull request #${number} is not in this fixture snapshot.`)
        // A pull request carries only its own position; the layer list comes
        // from every pull request in the snapshot that names the same stack.
        const membership =
          found.stack && !scenario.reviewStackUnavailable
            ? (active?.pullRequests
                .filter((pr) => pr.stack?.stackNumber === found.stack?.stackNumber)
                .map((pr) => ({
                  ...stackMember(pr.stack?.position ?? 1, pr.number, found.stack?.size ?? 1),
                  head: pr.head,
                  headSha: pr.headOid,
                  base: pr.base,
                  state: pr.state,
                  draft: pr.draft,
                })) ?? null)
            : scenario.reviewStackUnavailable
              ? null
              : []
        const value: ReviewHeadline = {
          pullRequest: {
            ...found,
            body: `${found.title}\n\nDeterministic fixture body for pull request #${number}.`,
          },
          rail: {
            ...reviewRail(found, membership),
            message: scenario.reviewStackUnavailable
              ? 'GitHub did not return stack membership for this pull request.'
              : membership && membership.length > REVIEW_STACK_METADATA_LIMIT
                ? `Layer metadata is bounded to ${REVIEW_STACK_METADATA_LIMIT} members, including the viewed layer; submitted membership is unchanged.`
                : found.stack
                  ? ''
                  : 'This pull request is not part of a native stack.',
            facts: active?.pullRequests
              .filter((pr) => pr.stack?.stackNumber === found.stack?.stackNumber)
              .filter(
                (pr, index) =>
                  index <
                    (found.stack &&
                    membership &&
                    membership.length > REVIEW_STACK_METADATA_LIMIT &&
                    found.stack.position > REVIEW_STACK_METADATA_LIMIT
                      ? REVIEW_STACK_METADATA_LIMIT - 1
                      : REVIEW_STACK_METADATA_LIMIT) || pr.number === found.number,
              )
              .map((pr) => ({
                number: pr.number,
                state:
                  scenario.reviewStackFactsState ??
                  (pr.reviewDecision ? ('available' as const) : ('partial' as const)),
                title: pr.title,
                lifecycle: pr.state,
                draft: pr.draft,
                checks: scenario.reviewStackFactsState ? ('unknown' as const) : pr.checks,
                review: scenario.reviewStackFactsState
                  ? ('unknown' as const)
                  : pr.reviewDecision === 'APPROVED'
                    ? ('approved' as const)
                    : pr.reviewDecision === 'REVIEW_REQUIRED'
                      ? ('required' as const)
                      : pr.reviewDecision === 'CHANGES_REQUESTED'
                        ? ('changes-requested' as const)
                        : ('unknown' as const),
                message: scenario.reviewStackFactsState
                  ? `Layer metadata ${scenario.reviewStackFactsState}; readiness is unknown.`
                  : pr.reviewDecision
                    ? ''
                    : 'Review decision unavailable from GitHub.',
              })),
          },
          reviewers: {
            state: found.reviewDecision ? 'available' : 'unavailable',
            requested:
              found.reviewDecision === 'REVIEW_REQUIRED'
                ? [{ kind: 'user', name: 'fixture-reviewer' }]
                : [],
            reviews:
              found.reviewDecision === 'APPROVED'
                ? [{ login: 'fixture-reviewer', state: 'APPROVED', headOid: found.headOid ?? null }]
                : [],
            message: found.reviewDecision
              ? ''
              : 'Reviewer metadata is unavailable in this fixture.',
          },
        }
        return value
      })
    },
    reviewFiles: (number) => {
      record('reviewFiles', [number])
      return answer('reviewFiles', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        if (!found) throw new Error(`Pull request #${number} is not in this fixture snapshot.`)
        return reviewFileSet(number, scenario.reviewHeadOid ?? found.headOid ?? `head-${number}`)
      })
    },
    reviewCommits: (number) => {
      record('reviewCommits', [number])
      return answer('reviewCommits', () => reviewCommits(number))
    },
    reviewViewed: () => {
      record('reviewViewed', [])
      return answer('reviewViewed', () => null)
    },
    reviewSetViewed: (record_) => {
      record('reviewSetViewed', [record_])
      return answer('reviewSetViewed', () => record_ as ReviewViewedRecord)
    },
    reviewThreads: (number) => {
      record('reviewThreads', [number])
      return answer('reviewThreads', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const headOid = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        return {
          threads: reviewThreadSet(number, headOid),
          permissions: reviewPermissions(number, scenario.reviewPermissions),
        }
      })
    },
    reviewDrafts: (number) => {
      record('reviewDrafts', [number])
      // The real journal outlives the workspace, so the double keeps drafts for
      // the life of the page: leaving the review workspace and coming back has
      // to show the pending comments again, which is the behaviour being proven.
      return answer('reviewDrafts', () => heldDrafts.get(number) ?? null)
    },
    reviewSetDrafts: (draftRecord) => {
      record('reviewSetDrafts', [draftRecord])
      heldDrafts.set(draftRecord.number, draftRecord)
      return answer('reviewSetDrafts', () => draftRecord as ReviewDraftRecord)
    },
    reviewSubmit: (number, submission) => {
      record('reviewSubmit', [number, submission])
      return answer('reviewSubmit', () => ({
        id: `review-${number}`,
        state: REVIEW_SUBMIT_STATES[submission.event],
        url: `https://github.com/acme/widgets/pull/${number}#pullrequestreview-1`,
      }))
    },
    reviewReply: (number, threadId) => {
      record('reviewReply', [number, threadId])
      return answer('reviewReply', () => ({
        id: `reply-${threadId}`,
        state: 'COMMENTED',
        url: `https://github.com/acme/widgets/pull/${number}#discussion_r9`,
      }))
    },
    reviewSetResolved: (number, threadId, resolved) => {
      record('reviewSetResolved', [number, threadId, resolved])
      return answer('reviewSetResolved', () => ({
        id: threadId,
        state: resolved ? 'RESOLVED' : 'UNRESOLVED',
        url: null,
      }))
    },
    reviewHistory: (number) => {
      record('reviewHistory', [number])
      return answer('reviewHistory', () => {
        if (scenario.reviewHistory) {
          return typeof scenario.reviewHistory === 'function'
            ? scenario.reviewHistory(number)
            : scenario.reviewHistory
        }
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const currentHead = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        const historicalHead = '1111222233334444555566667777888899990000'
        return {
          number,
          current: {
            headOid: currentHead,
            baseOid: 'b'.repeat(40),
            baseRef: 'main',
          },
          latest: {
            headOid: currentHead,
            baseOid: 'b'.repeat(40),
            baseRef: 'main',
            firstSeenAt: '2026-09-24T10:00:00.000Z',
            lastSeenAt: '2026-09-25T12:00:00.000Z',
            observations: 2,
            reviewed: false,
            reviewedAt: null,
            reviewId: null,
          },
          reviewed: {
            headOid: historicalHead,
            baseOid: 'b'.repeat(40),
            baseRef: 'main',
            firstSeenAt: '2026-09-22T08:00:00.000Z',
            lastSeenAt: '2026-09-23T09:00:00.000Z',
            observations: 3,
            reviewed: true,
            reviewedAt: '2026-09-23T09:00:00.000Z',
            reviewId: 'PRR_reviewed_1',
          },
          snapshots: [
            {
              headOid: historicalHead,
              baseOid: 'b'.repeat(40),
              baseRef: 'main',
              firstSeenAt: '2026-09-22T08:00:00.000Z',
              lastSeenAt: '2026-09-23T09:00:00.000Z',
              observations: 3,
              reviewed: true,
              reviewedAt: '2026-09-23T09:00:00.000Z',
              reviewId: 'PRR_reviewed_1',
            },
            {
              headOid: currentHead,
              baseOid: 'b'.repeat(40),
              baseRef: 'main',
              firstSeenAt: '2026-09-24T10:00:00.000Z',
              lastSeenAt: '2026-09-25T12:00:00.000Z',
              observations: 2,
              reviewed: false,
              reviewedAt: null,
              reviewId: null,
            },
          ],
          gap: null,
        }
      })
    },
    reviewHistoryDiff: (number, fromOid) => {
      record('reviewHistoryDiff', [number, fromOid])
      return answer('reviewHistoryDiff', () => {
        if (scenario.reviewHistoryDiff) {
          return typeof scenario.reviewHistoryDiff === 'function'
            ? scenario.reviewHistoryDiff(number, fromOid)
            : scenario.reviewHistoryDiff
        }
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const currentHead = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        const fromSnapshot = {
          headOid: fromOid,
          baseOid: 'b'.repeat(40),
          baseRef: 'main',
          firstSeenAt: '2026-09-22T08:00:00.000Z',
          lastSeenAt: '2026-09-23T09:00:00.000Z',
          observations: 1,
          reviewed: true,
          reviewedAt: '2026-09-23T09:00:00.000Z',
          reviewId: 'PRR_reviewed_1',
        }
        if (fromOid.startsWith('missing') || fromOid === 'deadbeef'.padEnd(40, '0')) {
          const diff: ReviewHistoryDiff = {
            number,
            state: 'unavailable',
            reason: `Historical commit ${fromOid.slice(0, 7)} is no longer in this repository (it may have been garbage-collected after a force-push).`,
            from: fromSnapshot,
            to: { headOid: currentHead, baseOid: 'b'.repeat(40), baseRef: 'main' },
            mergeBaseOid: null,
            files: [],
            additions: 0,
            deletions: 0,
            truncated: false,
          }
          return diff
        }
        const diff: ReviewHistoryDiff = {
          number,
          state: 'files',
          reason: '',
          from: fromSnapshot,
          to: { headOid: currentHead, baseOid: 'b'.repeat(40), baseRef: 'main' },
          mergeBaseOid: 'b'.repeat(40),
          files: [
            textFile('src/main/review.ts', '@@ -2,2 +2,2 @@', [
              ['-  return stagedDiff()', 2, null],
              ['+  return transportDiff()', null, 2],
            ]),
          ],
          additions: 1,
          deletions: 1,
          truncated: false,
        }
        return diff
      })
    },
    reviewClearHistory: (number) => {
      record('reviewClearHistory', [number])
      return answer('reviewClearHistory', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const currentHead = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        return {
          number,
          current: { headOid: currentHead, baseOid: 'b'.repeat(40), baseRef: 'main' },
          latest: {
            headOid: currentHead,
            baseOid: 'b'.repeat(40),
            baseRef: 'main',
            firstSeenAt: '2026-09-25T12:00:00.000Z',
            lastSeenAt: '2026-09-25T12:00:00.000Z',
            observations: 1,
            reviewed: false,
            reviewedAt: null,
            reviewId: null,
          },
          reviewed: null,
          snapshots: [
            {
              headOid: currentHead,
              baseOid: 'b'.repeat(40),
              baseRef: 'main',
              firstSeenAt: '2026-09-25T12:00:00.000Z',
              lastSeenAt: '2026-09-25T12:00:00.000Z',
              observations: 1,
              reviewed: false,
              reviewedAt: null,
              reviewId: null,
            },
          ],
          gap: null,
        }
      })
    },
    reviewResolveDrafts: (number, drafts) => {
      record('reviewResolveDrafts', [number, drafts])
      return answer('reviewResolveDrafts', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const headOid = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        const files = reviewFileSet(number, headOid)
        // The main process re-resolves each anchor against a freshly read file
        // set; the double answers for the set it already serves, so a draft the
        // reviewer just wrote is exact and a draft naming a line the fixture does
        // not have is unresolved with a reason. A range is never re-anchored
        // across a side, exactly as the real resolver refuses.
        return drafts.map((draft) => {
          const line = lineAt(files.files, draft.ref.path, draft.ref.side, draft.ref.line)
          const start = draft.startRef ?? null
          const startLine = start ? lineAt(files.files, start.path, start.side, start.line) : null
          if (start && (start.side !== draft.ref.side || start.line > draft.ref.line)) {
            return unresolved(
              draft.id,
              'The two ends of this comment are not one range on the same side of the diff.',
            )
          }
          if (!line) {
            return unresolved(
              draft.id,
              `${draft.ref.path} no longer holds line ${draft.ref.line} on the ${draft.ref.side}.`,
            )
          }
          if (start && !startLine) {
            return unresolved(
              draft.id,
              `${start.path} no longer holds the first line of this comment.`,
            )
          }
          return {
            id: draft.id,
            match: 'exact' as const,
            side: draft.ref.side,
            line: draft.ref.side === 'base' ? line.oldLine : line.newLine,
            startLine:
              startLine && draft.startRef?.side === 'base'
                ? startLine.oldLine
                : (startLine?.newLine ?? null),
            reason: '',
          }
        })
      })
    },
    openExternal: (url) => {
      record('openExternal', [url])
      externalUrls.push(url)
      return answer('openExternal', () => undefined)
    },
    pullRequestChecks: (number, options) => {
      record('pullRequestChecks', [number, options])
      return answer<PullRequestChecksReport>('pullRequestChecks', () => {
        const report = checksReportFor(scenario, number, active)
        if (!report) throw new Error(`Pull request #${number} is not in this scenario.`)
        return report
      })
    },
    rerunPullRequestCheck: (number, runId) => {
      record('rerunPullRequestCheck', [number, runId])
      return answer<PullRequestChecksReport>('rerunPullRequestCheck', () => {
        const report = checksReportFor(scenario, number, active)
        if (!report) throw new Error(`Pull request #${number} is not in this scenario.`)
        if (!report.checks.some((check) => check.workflowRunId === runId)) {
          throw new Error('That workflow run no longer belongs to this pull request head.')
        }
        return {
          ...report,
          freshness: 'live',
          staleReason: null,
          message: `Rerun requested for workflow run ${runId}.`,
          checkedAt: report.checkedAt ?? report.fetchedAt,
        }
      })
    },
    gitRuntimeStatus: () => {
      record('gitRuntimeStatus', [])
      return answer('gitRuntimeStatus', () => runtimeStatus(false))
    },
    setSystemGit: (enabled) => {
      record('setSystemGit', [enabled])
      return answer('setSystemGit', () => runtimeStatus(enabled))
    },
    cancel: (requestId) => {
      record('cancel', [requestId])
      return answer('cancel', () => undefined)
    },
    searchIssues: (query) => {
      record('searchIssues', [query])
      return answer('searchIssues', () => {
        const terms = query.toLowerCase().replace(/^#+/u, '')
        const issues = (active?.issues ?? []).filter((iss) => {
          if (String(iss.number) === terms || `#${iss.number}` === terms) return true
          return iss.title.toLowerCase().includes(terms)
        })
        return { issues, message: '' }
      })
    },
    pullRequestIssueLinks: (prNumber) => {
      record('pullRequestIssueLinks', [prNumber])
      return answer('pullRequestIssueLinks', () => ({
        prNumber,
        links: [...(scenario.issueLinks?.[prNumber] ?? [])],
      }))
    },
    previewIssueLink: (prNumber, issueNumber, relation, action) => {
      record('previewIssueLink', [prNumber, issueNumber, relation, action])
      return answer('previewIssueLink', () => {
        const found = active?.pullRequests.find((pr) => pr.number === prNumber)
        const closing = (scenario.issueLinks?.[prNumber] ?? []).find(
          (link) => link.relation === 'closing',
        )
        const existingClause = closing ? `\n\nCloses #${closing.number}\n` : '\n'
        const currentBody = found
          ? `${found.title}\n\nDeterministic fixture body for pull request #${prNumber}.${existingClause}`
          : ''
        const closingSyntax = `Closes #${issueNumber}`
        const newBody =
          action === 'link'
            ? `${currentBody.trimEnd()}\n\n${closingSyntax}\n`
            : closing
              ? currentBody.replace(`\n\nCloses #${closing.number}\n`, '\n')
              : currentBody
        return {
          prNumber,
          issueNumber,
          relation,
          action,
          currentBody,
          newBody,
          changed: newBody !== currentBody,
          ...(relation === 'closing' ? { closingSyntax } : {}),
        }
      })
    },

    gitEnvironment: (requestId) => {
      record('gitEnvironment', [requestId])
      return answer('gitEnvironment', () => ({
        ok: true as const,
        value: {
          identity: { name: 'Ada Lovelace', email: 'ada@example.invalid' },
          defaultBranch: 'main',
          httpsCredentials: { configured: true, helper: 'osxkeychain' },
          ssh: { available: true, version: '9.8p1' },
        },
      }))
    },
    searchRepositories: (request) => {
      record('searchRepositories', [request])
      // What an account can reach is that account's own, and it is answered from
      // the credential this read was admitted under rather than from the one in
      // effect when the answer is released: a search asked for by the replaced
      // account answers late with the replaced account's repositories, and
      // rebuilding it from the replacement is the one thing this fence exists to
      // catch. The list is derived here, at admission, and only the delivery of
      // the answer is held.
      const admittedCli = servedCliStatus ?? scenario.identity?.cli ?? scenario.githubCliStatus
      const produce = () => {
        const query = request.query?.trim() ?? ''
        if (query === 'sso-error') {
          return {
            ok: false as const,
            failure: {
              reason: 'sso-denied' as const,
              message: 'This organization requires single sign-on.',
            },
          }
        }
        // A search reads GitHub as the CLI account for this host, so a scenario
        // that staged a status this host cannot use cannot answer with results
        // the CLI could not have produced. A scenario that staged none is a
        // window whose main process never reported one, which keeps serving.
        const cli = admittedCli
        if (cli && cli.state !== 'authenticated') {
          return {
            ok: false as const,
            failure:
              cli.state === 'missing-cli'
                ? {
                    reason: 'unavailable' as const,
                    message: 'The GitHub CLI could not be run on this computer.',
                  }
                : {
                    reason: 'signed-out' as const,
                    message: `The GitHub CLI has no account signed in for ${cli.host}.`,
                  },
          }
        }
        const items: GitHubRepositorySummary[] =
          query === 'empty-repo'
            ? [
                {
                  name: 'empty-repo',
                  fullName: 'acme/empty-repo',
                  owner: 'acme',
                  description: 'An empty repository with no commits yet',
                  private: false,
                  fork: false,
                  archived: false,
                  empty: true,
                  language: null,
                  defaultBranch: 'main',
                  pushedAt: null,
                  url: 'https://github.com/acme/empty-repo',
                  httpsUrl: 'https://github.com/acme/empty-repo.git',
                  sshUrl: 'git@github.com:acme/empty-repo.git',
                  canPush: true,
                  host: 'github.com',
                },
              ]
            : [
                {
                  name: 'git-stacks',
                  fullName: 'howarewoo/git-stacks',
                  owner: 'howarewoo',
                  description: 'Stacked Git pull requests on GitHub',
                  private: false,
                  fork: false,
                  archived: false,
                  empty: false,
                  language: 'TypeScript',
                  defaultBranch: 'main',
                  pushedAt: '2026-09-29T00:00:00Z',
                  url: 'https://github.com/howarewoo/git-stacks',
                  httpsUrl: 'https://github.com/howarewoo/git-stacks.git',
                  sshUrl: 'git@github.com:howarewoo/git-stacks.git',
                  canPush: true,
                  host: 'github.com',
                },
                {
                  name: 'widgets',
                  fullName: 'acme/widgets',
                  owner: 'acme',
                  description: 'Sample widget repository',
                  private: true,
                  fork: false,
                  archived: false,
                  empty: false,
                  language: 'TypeScript',
                  defaultBranch: 'main',
                  pushedAt: '2026-09-28T00:00:00Z',
                  url: 'https://github.com/acme/widgets',
                  httpsUrl: 'https://github.com/acme/widgets.git',
                  sshUrl: 'git@github.com:acme/widgets.git',
                  canPush: true,
                  host: 'github.com',
                },
              ]
        // What an account can reach is that account's own, and the private
        // repository it may clone is named after it: an answer that arrives
        // for a replaced account has to be recognizable as somebody else's.
        const account = cli?.login ?? 'octo'
        items.push({
          name: `${account}-private`,
          fullName: `acme/${account}-private`,
          owner: 'acme',
          description: `Private to ${account}`,
          private: true,
          fork: false,
          archived: false,
          empty: false,
          language: 'TypeScript',
          defaultBranch: 'main',
          pushedAt: '2026-09-29T00:00:00Z',
          url: `https://${cli?.host ?? 'github.com'}/acme/${account}-private`,
          httpsUrl: `https://${cli?.host ?? 'github.com'}/acme/${account}-private.git`,
          sshUrl: `git@${cli?.host ?? 'github.com'}:acme/${account}-private.git`,
          canPush: true,
          host: cli?.host ?? 'github.com',
        })
        return {
          ok: true as const,
          value: {
            repositories: items,
            query,
            totalCount: items.length,
            truncated: false,
          },
        }
      }
      return admittedAnswer('searchRepositories', produce)
    },
    previewCloneCommand: (request) => {
      record('previewCloneCommand', [request])
      const url =
        request.protocol === 'ssh' ? request.repository.sshUrl : request.repository.httpsUrl
      // The two commands the main process composes for this request: the same
      // depth flag, the same quoting rule, and the same host-qualified target
      // off github.com. The renderer only shows what it is handed, so a double
      // that answered with a differently-shaped string would be proving a copy
      // of the command rather than the command the request asks for.
      const destination = mockCloneDestination(request.parentDirectory, request.directoryName)
      const depth = request.shallow ? ' --depth 1' : ''
      const ghTarget = request.repository.host === 'github.com' ? request.repository.fullName : url
      const ghFlags = request.shallow ? ' -- --depth 1' : ''
      return answer('previewCloneCommand', () => ({
        ok: true as const,
        value: {
          gitCommand: `git clone${depth} ${mockShellWord(url)} ${destination}`,
          ghCommand: `gh repo clone ${mockShellWord(ghTarget)} ${destination}${ghFlags}`,
        },
      }))
    },
    chooseDestinationDirectory: (current) => {
      record('chooseDestinationDirectory', [current])
      return answer('chooseDestinationDirectory', () => '/mock/workspaces')
    },
    cloneRepository: (request) => {
      record('cloneRepository', [request])
      return answer('cloneRepository', () => {
        if (request.directoryName === 'collision') {
          return {
            ok: false as const,
            failure: {
              reason: 'destination-exists' as const,
              message: 'collision already exists in that folder. Choose another name.',
            },
          }
        }
        return {
          ok: true as const,
          value: {
            path: `${request.parentDirectory}/${request.directoryName}`,
            name: request.directoryName,
            empty: request.repository.empty,
            gitCommand: `git clone https://github.com/${request.repository.fullName}.git "${request.parentDirectory}/${request.directoryName}"`,
            ghCommand: `gh repo clone ${request.repository.fullName} "${request.parentDirectory}/${request.directoryName}"`,
          },
        }
      })
    },
    addRepository: (path) => {
      record('addRepository', [path])
      return answer('addRepository', () => scenario.snapshot)
    },
    onRepositoryDropped: (listener) => {
      dropListeners.add(listener)
      return () => dropListeners.delete(listener)
    },
    updateStatus: () => {
      record('updateStatus', [])
      return answer('updateStatus', () => updateStatusFixture.idle)
    },
    checkForUpdates: () => {
      record('checkForUpdates', [])
      return answer('checkForUpdates', () => updateStatusFixture.available)
    },
    downloadUpdate: () => {
      record('downloadUpdate', [])
      return answer('downloadUpdate', () => updateStatusFixture.downloaded)
    },
    installUpdate: () => {
      record('installUpdate', [])
      return answer('installUpdate', () => updateStatusFixture.downloaded)
    },
    cancelUpdate: () => {
      record('cancelUpdate', [])
      return answer('cancelUpdate', () => updateStatusFixture.cancelled)
    },
    // The capability report main builds from its own fixed allowlist. The
    // gallery answers with the same shape, including the adapter lines for the
    // optional GitHub CLI, so the Diagnostics section renders what a real
    // report carries rather than a shortened stand-in.
    diagnostics: () => {
      record('diagnostics', [])
      return answer('diagnostics', () => structuredClone(diagnosticsReportFixture))
    },
    onUpdateStatus: (listener) => {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },
    pullRequestInbox: (request) => {
      record('pullRequestInbox', request ? [request] : [])
      // The queue a host reads is that host's own, and it is that host's from the
      // moment the read is admitted rather than from the moment it is released: a
      // read that answers late, after the window has moved to another host, still
      // carries the rows the host it asked about read. Reading the served status
      // inside a released producer would rebuild a held read as the replacement
      // account's answer, which is the one thing this boundary exists to catch.
      const served = servedCliStatus ?? scenario.identity?.cli ?? scenario.githubCliStatus ?? null
      const admitted = !scenario.inbox
        ? null
        : served && served.host !== 'github.com'
          ? {
              ...scenario.inbox,
              items: scenario.inbox.items.map((item) => ({
                ...item,
                host: served.host,
                title: `${item.title} on ${served.host}`,
              })),
            }
          : scenario.inbox
      return answer('pullRequestInbox', () => {
        if (!admitted) throw new Error('This fixture has no PR Inbox read behind it.')
        return admitted
      })
    },
    pullRequestInboxFilters: () => {
      record('pullRequestInboxFilters', [])
      return answer('pullRequestInboxFilters', () => [...inboxFilters])
    },
    savePullRequestInboxFilters: (drafts) => {
      record('savePullRequestInboxFilters', [drafts])
      return answer('savePullRequestInboxFilters', () => {
        // The main process owns the file and the identities in it: a draft that
        // names a filter it already stored keeps that filter's id, and every
        // other one is minted here. The window only ever sees what came back.
        //
        // Every draft is validated before anything is replaced, and an invalid
        // one refuses the whole write. Dropping just that draft would delete a
        // filter the person believes is still there, because the view removes
        // the old version from the submitted list before appending its
        // replacement: the stored filter would vanish with no error at all.
        const known = new Set(inboxFilters.map((filter) => filter.id))
        const used = new Set<string>()
        const next: PullRequestInboxSavedFilter[] = []
        for (const draft of drafts) {
          const parsed = parsePullRequestInboxFilterDraft(draft)
          if (!parsed) throw new Error('A saved filter needs a name, a group, and a valid search.')
          const id =
            parsed.id && known.has(parsed.id) && !used.has(parsed.id)
              ? parsed.id
              : crypto.randomUUID()
          if (used.has(id)) continue
          used.add(id)
          next.push({
            id,
            name: parsed.name,
            group: parsed.group,
            search: parsed.search,
            repository: parsed.repository,
          })
        }
        inboxFilters = parsePullRequestInboxSavedFilters(next)
        return [...inboxFilters]
      })
    },
  }

  /**
   * The settings file and the GitHub CLI status behind it, for a scenario that
   * declares them.
   *
   * Both surfaces are installed only where they were asked for. A window with
   * no settings has no host to compare its queue against, so nothing retires
   * that queue at mount — and giving every scenario both would retire it on
   * mount for a reason those fixtures are not built to show, which would hide
   * the difference instead of demonstrating it.
   */
  // Read only from inside the surfaces below, which exist only where a scenario
  // declared an identity. The fallback stands in for a window that declared
  // none, where nothing here is ever called.
  let settings: AppSettings = scenario.identity?.settings ?? DEFAULT_SETTINGS
  const identity = scenario.identity
  if (identity) {
    const settingsSnapshot = (): SettingsSnapshot => ({
      settings: { ...settings },
      locks: [],
      issues: [],
      recovered: false,
      file: '/tmp/git-stacks-fixture-settings.json',
    })
    desktop.settings = () => {
      record('settings', [])
      return answer('settings', settingsSnapshot)
    }
    desktop.updateSettings = (patch) => {
      record('updateSettings', [patch])
      return answer('updateSettings', () => {
        // Whole-file writes, exactly as Main keeps them: an omitted group keeps
        // its stored value, and a group that was offered is folded into the one
        // already stored, so the window only ever sees what came back.
        settings = {
          ...settings,
          github: { ...settings.github, ...patch.github },
          git: { ...settings.git, ...patch.git },
          appearance: { ...settings.appearance, ...patch.appearance },
          privacy: { ...settings.privacy, ...patch.privacy },
          updates: { ...settings.updates, ...patch.updates },
          shortcuts: { ...settings.shortcuts, ...patch.shortcuts },
        }
        return settingsSnapshot()
      })
    }
  }

  const control: FixtureControl = {
    get scenario() {
      return scenario.name
    },
    actions,
    externalUrls,
    calls,
    get pending(): FixtureCall[] {
      const kinds = new Set<FixtureCall>(holds)
      for (const call of startsPending) {
        if (!released.has(call)) kinds.add(call)
      }
      // A call the scenario being left started pending is still outstanding
      // once that scenario's list is gone, so it stays visible here until it
      // actually settles. Hiding it would report a busy window as idle.
      for (const item of waiting) kinds.add(item.call)
      return [...kinds]
    },
    setScenario(name) {
      scenario = scenarioFor(name)
      // This double is installed once and outlives any number of scenario
      // changes. Only the answers change here: the mounted window keeps the
      // repository it opened, its destination, and its reads in flight, so
      // what it displays is deliberately not reset along with them.
      active = scenario.snapshot
      startsPending = new Set(scenario.pending ?? [])
      hostInboxes.clear()
      if (scenario.notifications)
        hostInboxes.set(scenario.notifications.host, scenario.notifications)
      notificationSettings.github = { host: scenario.notifications?.host ?? GITHUB_DEFAULT_HOST }
      servedCliStatus = null
      released.clear()
      options.onScenarioChange(scenario.name)
    },
    serveNotificationHost(host, name) {
      // The stored files that belong to a host the installation has just been
      // pointed at. Installing them publishes nothing: the window learns the
      // host from the settings it wrote and has to ask for the inbox itself.
      const served = scenarioFor(name).notifications
      // It is this host's own inbox, not another host's rows filed under this
      // one: a window that asked for this host and was handed another host's
      // rows would be refused, which is the right outcome for the wrong reason.
      if (served) hostInboxes.set(host, served.host === host ? served : { ...served, host })
    },
    publishRetiredHostInbox(name) {
      // A publication that was already on its way when the host changed. The
      // center it came from has been retired, and the window it reaches is
      // holding another host's inbox, which is what has to stay on screen.
      const retired = scenarioFor(name).notifications
      if (retired) notificationListener?.(retired)
    },
    serveCliStatus(status) {
      // What this installation answers the CLI status with from now on, without
      // publishing anything. A window pointed at a host it has just selected
      // has to ask for that host's own status, and the answer it gets is this
      // one: the fixture cannot rebuild a scenario's status for a host that
      // scenario never declared, and inventing a session for it would prove
      // nothing about the host switch.
      servedCliStatus = status
    },
    publishCliStatus(status) {
      // The session changed outside the window, which is what the main process
      // does when `gh` signs in, switches account, or logs out. The stored
      // session becomes the new one, so a read asked for afterwards answers as
      // the replacement rather than as the session it replaced, and the window
      // is told about it without having asked.
      servedCliStatus = status
      cliStatusListener?.(status)
    },
    hold(call) {
      holds.add(call)
    },
    unhold(call) {
      holds.delete(call)
    },
    release(call, occurrence?: 'oldest' | 'newest') {
      // Retained waiters are release-all targets even when their kind is no
      // longer in this scenario's pending list. Their promises are outstanding,
      // so leaving them out would strand whatever the window is waiting on and
      // make a held boot or open look like it can never finish.
      const targets = call
        ? [call]
        : [...new Set([...holds, ...startsPending, ...waiting.map((item) => item.call)])]
      let settled = 0
      for (const target of targets) {
        // Oldest first, which is the order the calls were started in. A release
        // has to be able to say which of several pending calls answers first:
        // `failNext` is consumed by the first of them to settle, so settling
        // newest-first would silently hand a one-shot failure to the read the
        // test just started instead of the one it abandoned.
        const due = waiting.filter((item) => item.call === target)
        const chosen =
          occurrence === 'newest' ? due.slice(-1) : occurrence === 'oldest' ? due.slice(0, 1) : due
        waiting.splice(0, waiting.length, ...waiting.filter((item) => !chosen.includes(item)))
        for (const entry of chosen) {
          entry.settle()
          settled += 1
        }
        if (occurrence === undefined || waiting.every((item) => item.call !== target)) {
          released.add(target)
          holds.delete(target)
        }
      }
      return settled
    },
    failNext(call, message) {
      oneShotFailures.set(call, message ?? `Git Stacks fixture: ${call} failed`)
    },
    answerNext(call, value) {
      oneShotAnswers.set(call, value)
    },
    connect() {
      if (!scenario.snapshot) return
      const openControl = [...document.querySelectorAll('button')].find((button) =>
        OPEN_REPOSITORY_LABELS.some((label) => button.textContent?.includes(label)),
      )
      openControl?.click()
    },
    reset() {
      actions.length = 0
      externalUrls.length = 0
      calls.length = 0
      holds.clear()
      oneShotFailures.clear()
      oneShotAnswers.clear()
      released.clear()
      waiting.length = 0
    },
    pushFreshness(value) {
      push('repository:remote-status', value)
    },
    pushSnapshot(value) {
      push('repository:background-snapshot', value)
    },
    dropRepository(paths) {
      for (const listener of dropListeners) listener(paths)
    },
  }

  // The main process's live-sync surface: the App subscribes to the pushes its
  // watcher and refresh timers make, reports window activity, and can be asked
  // for the current freshness. The control drives all of it, so a test walks the
  // same path a real background refresh does.
  const subscribers = new Map<string, (value: never) => void>()
  let freshness: RemoteFreshness | null = scenario.snapshot?.remote ?? null
  const push = (channel: string, value: unknown): void => {
    if (channel === 'repository:remote-status') freshness = value as RemoteFreshness
    subscribers.get(channel)?.(value as never)
  }
  const live = desktop as DesktopAPI & {
    reportActivity: (activity: SyncActivity) => Promise<void>
    remoteStatus: () => Promise<RemoteFreshness>
    dismissPendingMutation: (id: string) => Promise<void>
  }
  live.reportActivity = async () => {}
  // The main process always has a state for the open repository; before one is
  // attached it reports the state the snapshot carried.
  live.remoteStatus = async () =>
    freshness ?? {
      state: 'stale',
      fetchedAt: null,
      checkedAt: null,
      detail: null,
      rateLimitReset: null,
      pendingMutations: [],
    }
  live.dismissPendingMutation = async (id: string) => {
    if (!freshness) return
    freshness = {
      ...freshness,
      pendingMutations: freshness.pendingMutations.filter((entry) => entry.id !== id),
    }
  }
  const channelToMethod: Record<string, string> = {
    'repository:background-snapshot': 'onBackgroundSnapshot',
    'repository:background-issues': 'onBackgroundIssues',
    'repository:remote-status': 'onRemoteStatus',
  }
  for (const [channel, method] of Object.entries(channelToMethod)) {
    void ((live as unknown as Record<string, unknown>)[method] = (
      listener: (value: never) => void,
    ): (() => void) => {
      subscribers.set(channel, listener)
      return () => {
        if (subscribers.get(channel) === listener) subscribers.delete(channel)
      }
    })
  }

  window.desktop = desktop
  window.fixture = control
  return control
}
