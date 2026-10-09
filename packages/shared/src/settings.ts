import { GITHUB_DEFAULT_HOST } from './host'

export { GITHUB_DEFAULT_HOST } from './host'
import { DEFAULT_SHORTCUTS, type ShortcutId } from './shortcuts'
import type { UpdateChannel } from './update'

export { UPDATE_CHANNELS } from './update'

export const SETTINGS_VERSION = 1
/** Long enough that a closed app still refreshes, short enough to stay useful. */
export const MAX_FETCH_INTERVAL_SECONDS = 3600
/** A program name, not a command line. Kept well under any platform's limit. */
export const MAX_TOOL_NAME_LENGTH = 64

export const PULL_STRATEGIES = ['ff-only', 'merge', 'rebase'] as const
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const
export const THEMES = ['system', 'light', 'dark'] as const

/** Supported editor program identifiers. Arbitrary interpreters are refused. */
export const SUPPORTED_EDITORS = [
  'code',
  'cursor',
  'subl',
  'atom',
  'zed',
  'idea',
  'webstorm',
  'pycharm',
  'bbedit',
  'mate',
  'notepad++',
  'notepad',
] as const

/** Supported merge tools with fixed invocation semantics. */
export const SUPPORTED_MERGE_TOOLS = [
  'kdiff3',
  'meld',
  'opendiff',
  'p4merge',
  'vimdiff',
  'nvimdiff',
  'code',
  'diffmerge',
  'bcompare',
  'emerge',
  'smerge',
  'araxis',
  'winmerge',
] as const

export type SupportedEditor = (typeof SUPPORTED_EDITORS)[number]
export type SupportedMergeTool = (typeof SUPPORTED_MERGE_TOOLS)[number]

export type PullStrategy = (typeof PULL_STRATEGIES)[number]
export type MergeMethod = (typeof MERGE_METHODS)[number]
export type ThemePreference = (typeof THEMES)[number]

/**
 * The `git mergetool --tool=` id each supported program runs as, or null when
 * Git ships no backend for it. The two names are often the same but not
 * always — `bcompare` is the program Git's `bc3` backend launches — and an
 * editor is not a merge tool at all until the machine's own configuration
 * defines a `mergetool.<name>` entry for it. Passing the program name straight
 * through would offer a tool that fails the moment a conflict is resolved.
 */
export const MERGE_TOOL_BACKENDS: Record<SupportedMergeTool, string | null> = {
  kdiff3: 'kdiff3',
  meld: 'meld',
  opendiff: 'opendiff',
  p4merge: 'p4merge',
  vimdiff: 'vimdiff',
  nvimdiff: 'nvimdiff',
  code: null,
  diffmerge: 'diffmerge',
  bcompare: 'bc3',
  emerge: 'emerge',
  smerge: 'smerge',
  araxis: 'araxis',
  winmerge: 'winmerge',
}

export interface GitSettings {
  /**
   * Runs the Git the operating system provides instead of the copy bundled with
   * this app. The bundled copy is the default because it is the version Git
   * Stacks was tested against.
   */
  useSystemGit: boolean
  /** Program to open a file in, or null for the platform default. */
  editor: string | null
  /** Program to resolve a conflict with, or null for whatever Git is configured with. */
  mergeTool: string | null
  /** How the pull/pull-request flow advances a stack by default. */
  defaultPullStrategy: PullStrategy
  /** How a completed pull request is folded into its parent by default. */
  defaultMergeMethod: MergeMethod
  /** Seconds between background refreshes, or 0 to refresh only on request. */
  fetchIntervalSeconds: number
}

export interface GitHubSettings {
  /**
   * The GitHub host this installation works against. It is a host name, not a
   * URL, and it defaults to github.com; an enterprise host is named here and
   * everything — CLI authentication status, discovery, clone URLs, API
   * requests, and the capability matrix — follows it.
   */
  host: string
}

export interface AppearanceSettings {
  theme: ThemePreference
  reduceMotion: boolean
}

export interface PrivacySettings {
  /**
   * Whether a support bundle may name local paths. Off by default: a path
   * reveals a username and a directory layout, which is more than a bug report
   * needs to be useful.
   */
  includeLocalPaths: boolean
}

export interface UpdateSettings {
  /**
   * Which signed release this installation follows. Stable is the default;
   * beta is offered to people who asked for pre-release builds and is never
   * selected for anyone else.
   */
  channel: UpdateChannel
}

export interface NotificationSettings {
  /**
   * Whether this computer has agreed to let Git Stacks read a GitHub
   * Notifications inbox. Off by default: the endpoints are served to a classic
   * personal access token rather than to the credential the GitHub CLI holds,
   * so the consent is separate from CLI authentication and says so before it
   * is given.
   */
  enabled: boolean
}

export interface AppSettings {
  version: number
  git: GitSettings
  github: GitHubSettings
  appearance: AppearanceSettings
  privacy: PrivacySettings
  updates: UpdateSettings
  shortcuts: Record<ShortcutId, string>
  /**
   * Which older storage locations have already been folded into this file. The
   * marker is part of the document so a one-time import cannot run twice, and
   * so it stays done after the old location is cleared.
   */
  migrated: SettingsMigrations
  notifications: NotificationSettings
}

export interface SettingsMigrations {
  /** Shortcuts stored by the build that kept them in web storage. */
  legacyShortcutStorage: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  git: {
    useSystemGit: false,
    editor: null,
    mergeTool: null,
    defaultPullStrategy: 'merge',
    defaultMergeMethod: 'merge',
    fetchIntervalSeconds: 120,
  },
  github: { host: GITHUB_DEFAULT_HOST },
  notifications: { enabled: false },
  appearance: { theme: 'system', reduceMotion: false },
  privacy: { includeLocalPaths: false },
  updates: { channel: 'stable' },
  shortcuts: { ...DEFAULT_SHORTCUTS },
  migrated: { legacyShortcutStorage: false },
}

/** A partial change. An omitted group or field keeps its stored value. */
export interface SettingsPatch {
  github?: Partial<GitHubSettings>
  git?: Partial<GitSettings>
  appearance?: Partial<AppearanceSettings>
  privacy?: Partial<PrivacySettings>
  shortcuts?: Record<string, string>
  notifications?: Partial<NotificationSettings>
  /**
   * Shortcut bindings an earlier build kept outside this file, offered once for
   * import. It is an intent, not an assignment: the import commits only if the
   * state this file holds when the write happens is still the untouched one it
   * was decided from, so a reset or a shortcut edit that landed first is never
   * overwritten by bindings the user has already moved on from. `null` drops an
   * import the caller has decided to abandon.
   */
  legacyShortcutImport?: Record<string, string> | null
  updates?: Partial<UpdateSettings>
}

/** Why a stored value was refused, named by the key the surface shows. */
export interface SettingsIssue {
  key: string
  message: string
}

/** A key this computer's policy fixes, with the reason shown beside it. */
export interface SettingsLock {
  key: string
  reason: string
}

export interface SettingsSnapshot {
  settings: AppSettings
  locks: SettingsLock[]
  issues: SettingsIssue[]
  /** True when the stored file could not be read and defaults are in use. */
  recovered: boolean
  /** The settings file's own path. The renderer never chooses this. */
  file: string
  /** Whether the programs the Git settings name exist on this machine. */
  tools?: SettingsTools
}

/** A program a setting names, and whether this machine has it. */
export interface ToolAvailability {
  available: boolean
  /** The program name looked for, or the text explaining that none is set. */
  label: string
}

export interface SettingsTools {
  editor: ToolAvailability
  mergeTool: ToolAvailability
}

/** One line of the advanced capability report. */
export interface DiagnosticEntry {
  /** The fixed command or internal probe this line came from. */
  source: 'git' | 'runtime' | 'host' | 'github' | 'credentials' | 'filesystem' | 'app'
  label: string
  value: string
  /**
   * What the app actually established. A probe that could not run says so
   * rather than reporting an assumption as a fact.
   */
  status: 'confirmed' | 'unavailable' | 'not-applicable'
  detail?: string
  /**
   * True when this value names a location on this machine. Such a value is
   * withheld from a support bundle unless the user has opted into paths.
   */
  locational?: boolean
}

export interface DiagnosticReport {
  entries: DiagnosticEntry[]
  generatedAt: string
  appVersion: string
}

/** A category the bundle may contain, decided by what the settings allow. */
export interface BundleSection {
  id: string
  title: string
  included: boolean
  /** Why this section is in or out, shown in the preview. */
  reason: string
  content: string
  fields?: { name: string; value: string; locational?: boolean }[]
}

export interface SupportBundlePreview {
  id?: string
  sections: BundleSection[]
  /** Everything a section would contribute that is not redacted, counted. */
  redacted: number
  pathCount: number
  renderedBody?: string
  bytes?: number
  consent?: boolean
}

export interface SupportBundleExport {
  /** Where main wrote the file. Empty when the save was cancelled. */
  path: string
  bytes: number
  includedPaths: number
}
