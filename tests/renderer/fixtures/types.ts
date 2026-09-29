import type {
  FileView,
  GitAction,
  HistoryPage,
  LinkedIssue,
  PushPreview,
  RecentRepository,
  RepositorySnapshot,
  StackKind,
  StackPreview,
  SurgeryPreview,
} from '../../../src/shared/types'

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
  | 'pullRequest'
  | 'openExternal'
  | 'gitRuntimeStatus'
  | 'setSystemGit'
  | 'cancel'
  | 'searchIssues'
  | 'pullRequestIssueLinks'
  | 'previewIssueLink'

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
  /** Calls that start pending; `release()` settles them. */
  readonly pending?: readonly FixtureCall[]
  /** Calls that always reject. Per-action errors belong in `actionFailures`. */
  readonly failures?: Readonly<Partial<Record<FixtureCall, string>>>
  /** Per-path file view overrides, keyed by working-tree path. */
  readonly fileViews?: Readonly<Record<string, FileView>>
  readonly history?: HistoryPage
  readonly commitDiff?: { text: string; truncated: boolean }
  readonly pushPreview?: PushPreview
  readonly stackPreviews?: Readonly<Partial<Record<StackKind, StackPreview>>>
  /** The surgery preview a scenario answers; insert between two layers by default. */
  readonly surgeryPreview?: SurgeryPreview
  /** Git action types that always reject; every other action resolves with a status message. */
  readonly actionFailures?: Readonly<Partial<Record<GitAction['type'], string>>>
  /** Linked issues per pull request number, covering both contextual and closing relations. */
  readonly issueLinks?: Readonly<Record<number, readonly LinkedIssue[]>>
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
  /** Installs another scenario and remounts the mounted tree in place. */
  setScenario(name: string): void
  /** Keeps every later call of `call` pending until it is released. */
  hold(call: FixtureCall): void
  /** Settles pending calls and returns how many were settled; omit `call` to release all. */
  release(call?: FixtureCall): number
  /** Rejects the next call of `call` once, then restores normal behavior. */
  failNext(call: FixtureCall, message?: string): void
  /**
   * Clicks the production Open repository control once, the first action a user takes, so a
   * scenario that has a repository starts connected. No-op when it has none.
   */
  connect(): void
  /** Clears logs, holds, and one-shot failures while keeping the mounted scenario. */
  reset(): void
}

declare global {
  interface Window {
    /** Present only inside the development/test fixture gallery. */
    fixture: FixtureControl
  }
}
