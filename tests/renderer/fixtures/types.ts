import type {
  FileView,
  GitAction,
  HistoryPage,
  LinkedIssue,
  MergeStatus,
  PushPreview,
  RecentRepository,
  RemoteFreshness,
  RepositorySnapshot,
  StackKind,
  StackPreview,
  SurgeryPreview,
} from '../../../src/shared/types'
import type { ReviewEvent } from '../../../src/shared/review-threads'
import type { ReviewHistory, ReviewHistoryDiff } from '../../../src/shared/review-snapshots'

import type { PullRequestChecksReport } from '../../../src/shared/pull-request-checks'
import type { PullRequestInboxReport } from '../../../src/shared/pr-inbox'
import type { AppSettings } from '../../../src/shared/settings'
import type { GitHubCliStatus } from '../../../src/shared/types'
import type { NotificationInbox } from '../../../src/shared/notifications'

/** Every promise-returning `DesktopAPI` method the fixture double can intercept. */
export type FixtureCall =
  | 'recentRepositories'
  | 'openRepository'
  | 'refresh'
  | 'runAction'
  | 'fileView'
  | 'conflictView'
  | 'history'
  | 'commitDiff'
  | 'pushPreview'
  | 'stackPreview'
  | 'surgeryPreview'
  | 'mergeStatus'
  | 'pullRequest'
  | 'reviewHeadline'
  | 'reviewFiles'
  | 'reviewCommits'
  | 'reviewViewed'
  | 'reviewSetViewed'
  | 'reviewThreads'
  | 'reviewDrafts'
  | 'reviewSetDrafts'
  | 'reviewResolveDrafts'
  | 'reviewSubmit'
  | 'reviewReply'
  | 'reviewSetResolved'
  | 'reviewHistory'
  | 'reviewHistoryDiff'
  | 'reviewClearHistory'
  | 'pullRequestChecks'
  | 'rerunPullRequestCheck'
  | 'openExternal'
  | 'gitRuntimeStatus'
  | 'setSystemGit'
  | 'cancel'
  | 'searchIssues'
  | 'pullRequestIssueLinks'
  | 'previewIssueLink'
  | 'gitEnvironment'
  | 'searchRepositories'
  | 'previewCloneCommand'
  | 'chooseDestinationDirectory'
  | 'cloneRepository'
  | 'addRepository'
  | 'updateStatus'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'installUpdate'
  | 'cancelUpdate'
  | 'pullRequestInbox'
  | 'pullRequestInboxFilters'
  | 'savePullRequestInboxFilters'
  | 'settings'
  | 'updateSettings'
  | 'githubCliStatus'
  | 'notifications'
  | 'notificationSave'
  | 'notificationRemove'
  | 'notificationCancel'
  | 'notificationMarkRead'
  | 'notificationSubscription'
  | 'notificationRefresh'
  | 'notificationDone'
  | 'notificationSettings'
  | 'notificationSettingsHost'
  | 'notificationSettingsEnable'
  | 'diagnostics'

/** One entry of the ordered {@link FixtureControl.calls} log. */
export interface FixtureCallRecord {
  readonly call: FixtureCall
  readonly args: readonly unknown[]
}

/**
 * Deterministic data plus behavior for one gallery scenario. Snapshot data reuses the
 * repository fixtures in `tests/fixtures/workflow-scenarios.ts` and
 * `src/renderer/src/design-system/data-fixtures.ts`; nothing here invents new shapes.
 */
export interface FixtureScenario {
  /** Scenario id used by `?scenario=<name>`. */
  readonly name: string
  /** One line describing the state the scenario renders. */
  readonly summary: string
  /** `null` renders the production no-repository onboarding instead of a workspace. */
  readonly snapshot: RepositorySnapshot | null
  readonly recentRepositories: readonly RecentRepository[]
  /**
   * The snapshot each registered repository opens as, keyed by its path. A
   * queue row names a repository path, and opening that row has to open that
   * repository: answering every path with one snapshot would make a row for a
   * second repository open the first one's workspace.
   */
  readonly snapshotsByPath?: Readonly<Record<string, RepositorySnapshot>>
  /**
   * The settings file this window reads and the GitHub CLI status behind it.
   *
   * Both surfaces are installed only where a scenario declares them. A window
   * with neither has no host to compare its queue against, so nothing retires
   * that queue at mount — and giving every scenario both would retire it on
   * mount for a reason those fixtures are not built to show.
   */
  readonly identity?: {
    settings: AppSettings
    /** Main always answers with a status; a CLI that is installed and signed out reports that. */
    cli: GitHubCliStatus
  }
  /** Calls that start pending; `release()` settles them. */
  readonly pending?: readonly FixtureCall[]
  /** Calls that always reject. Per-action errors belong in `actionFailures`. */
  readonly failures?: Readonly<Partial<Record<FixtureCall, string>>>
  /** Per-path file view overrides, keyed by working-tree path. */
  readonly fileViews?: Readonly<Record<string, FileView>>
  readonly history?: HistoryPage
  readonly commitDiff?: { text: string; truncated: boolean }
  /**
   * The head the review file read reports, when it is not the pull request's own
   * headOid. A force-push between the headline read and the file read leaves the
   * two claims disagreeing, and the workspace has to say which one it is showing.
   */
  readonly reviewHeadOid?: string
  /**
   * The viewer's review permissions, when the scenario is not a reviewer with
   * full write access. A scenario that blocks one event, or that makes the
   * viewer the author of the pull request, has to show that gate rather than
   * only the permissive default.
   */
  readonly reviewPermissions?: { isAuthor?: boolean; blocked?: ReviewEvent }
  readonly pushPreview?: PushPreview
  readonly reviewHistory?: ReviewHistory | ((number: number) => ReviewHistory)
  readonly reviewHistoryDiff?:
    | ReviewHistoryDiff
    | ((number: number, fromOid: string) => ReviewHistoryDiff)
  readonly stackPreviews?: Readonly<Partial<Record<StackKind, StackPreview>>>
  /** The surgery preview a scenario answers; insert between two layers by default. */
  readonly surgeryPreview?: SurgeryPreview
  /** What the read-only merge-status read reports; nothing is submitted. */
  readonly mergeStatus?: MergeStatus
  /** Git action types that always reject; every other action resolves with a status message. */
  readonly actionFailures?: Readonly<Partial<Record<GitAction['type'], string>>>
  /** Linked issues per pull request number, covering both contextual and closing relations. */
  readonly issueLinks?: Readonly<Record<number, readonly LinkedIssue[]>>
  /**
   * Detailed checks per pull request number, keyed by `PullRequest.number`. A scenario
   * that omits a number makes the read reject, the way a repository GitHub cannot
   * describe would.
   */
  readonly pullRequestChecks?: Readonly<Record<number, PullRequestChecksReport>>
  /**
   * The queue the Inbox destination reads. A scenario without one has no
   * integration behind the destination, so the read refuses the way an
   * unconfigured GitHub does rather than answering an invented queue.
   */
  readonly inbox?: PullRequestInboxReport
  /**
   * The Notification Center's own inbox. It is separate from the pull request
   * inbox, so a scenario states it on its own rather than deriving it.
   */
  readonly notifications?: NotificationInbox
  /**
   * Per-host inboxes, keyed by the canonical GitHub host name. An enterprise
   * host's authorized inbox is its own, and a scenario that authorizes one must
   * be able to say what that host serves rather than reusing the default inbox.
   */
  readonly notificationsBoxes?: Readonly<Record<string, NotificationInbox>>
  /**
   * The status this installation's required GitHub CLI reports, for a scenario
   * that states one. It is also what installs the optional `githubCliStatus`
   * bridge: leaving it off is not a signed-out CLI but no method at all, which
   * is what every scenario that never staged a CLI session already behaved as.
   * Only a scenario whose own state depends on that read states one, because a
   * fixture answering a read nothing asked for would move the GitHub status
   * footer of every other scenario to a session no one staged.
   */
  readonly githubCliStatus?: GitHubCliStatus
}

/** Typed gallery control surface. Every field is plain serializable data. */
export interface FixtureControl {
  /** Currently mounted scenario id. */
  readonly scenario: string
  /** Append-only log of every `runAction` payload, verbatim. */
  readonly actions: GitAction[]
  /** Append-only log of every `openExternal` URL. */
  readonly externalUrls: string[]
  /** Append-only log of every double call, reads included. */
  readonly calls: FixtureCallRecord[]
  /** Call kinds currently held pending by `hold`. */
  readonly pending: FixtureCall[]
  /**
   * Installs another scenario's answers into the doubles already installed, without
   * remounting anything: the mounted tree keeps its state, its destination, and
   * its in-flight reads; reads that follow answer from the newly selected
   * scenario's own repository (or refuse when it has none), while the repository
   * already displayed remains on screen until the application opens another one.
   */
  setScenario(name: string): void
  /** Keeps every later call of `call` pending until it is released. */
  hold(call: FixtureCall): void
  /** Stops holding future calls of `call` without releasing already-held ones. */
  unhold(call: FixtureCall): void
  /**
   * Settles pending calls oldest first, which is the order they were started
   * in, and returns how many were settled; omit `call` to release all. Pass
   * `occurrence` ('oldest' or 'newest') to settle only one specific pending
   * call. A one-shot `failNext` is consumed by the first call this settles, so
   * this order decides which of several pending reads is the one that fails.
   */
  release(call?: FixtureCall, occurrence?: 'oldest' | 'newest'): number
  /** Rejects the next call of `call` once, then restores normal behavior. */
  failNext(call: FixtureCall, message?: string): void
  /**
   * Answers the next call of `call` with `value` once, then restores normal
   * behavior. The value is the answer the producer itself would return, so a
   * spec can put a read that ended, or one that was replaced, on the wire
   * without inventing a different shape for it. It is consumed by the first
   * call `release` settles, exactly as `failNext` is.
   */
  answerNext(call: FixtureCall, value: unknown): void
  /**
   * Clicks the production Open repository control once, the first action a user takes, so a
   * scenario that has a repository starts connected. No-op when it has none.
   */
  connect(): void
  /** Clears logs, holds, and one-shot failures while keeping the mounted scenario. */
  reset(): void
  /**
   * Pushes a freshness state exactly as the main process does when a read
   * answers, fails, or hits a rate limit.
   */
  pushFreshness(value: RemoteFreshness): void
  /** Pushes a background snapshot, as a filesystem watcher's refresh does. */
  pushSnapshot(value: RepositorySnapshot): void
  /** Simulates dropping folders onto the window, dispatching to preload listeners. */
  dropRepository?(paths: string[]): void
  /**
   * Installs the named scenario's inbox as what the named host serves, the way
   * the main process restores the files that belong to a host it has just been
   * pointed at, and it is that host's own inbox rather than another host's
   * filed under this one: a window that asked for this host and was handed
   * another host's rows would be refused for the right reason and for the
   * wrong one at once.
   * It publishes nothing: the window reaches the new host's inbox by asking for
   * it, and a push that happened to carry it would prove nothing.
   */
  serveNotificationHost(host: string, name: string): void
  /**
   * Publishes the named scenario's inbox as a late arrival from a center that
   * has already been retired. The window is holding the new host's inbox and
   * must refuse rows belonging to a host it is no longer pointed at.
   */
  publishRetiredHostInbox(name: string): void
  /**
   * Installs the status this installation answers the GitHub CLI status with
   * from now on, without publishing it. A window pointed at a host it has just
   * been switched to reads that host for itself, so a switch test has to say
   * what the new host's own answer is rather than leave the double answering
   * with the previous host's session.
   */
  serveCliStatus(status: GitHubCliStatus): void
  /**
   * Replaces the session and publishes it, as the main process does when the
   * CLI signs in, switches account, or logs out in a terminal: the window is
   * told about a change it did not ask for, and a read it had already started
   * for the previous session can still answer afterwards.
   */
  publishCliStatus(status: GitHubCliStatus): void
}

declare global {
  interface Window {
    /** Present only inside the development/test fixture gallery. */
    fixture: FixtureControl
  }
}
