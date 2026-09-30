import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_SETTINGS,
  MAX_FETCH_INTERVAL_SECONDS,
  MAX_TOOL_NAME_LENGTH,
  SETTINGS_VERSION,
  SUPPORTED_EDITORS,
  SUPPORTED_MERGE_TOOLS,
  type AppSettings,
  type SettingsIssue,
  type SettingsMigrations,
  type SettingsLock,
  type SettingsPatch,
  type SettingsSnapshot,
} from '../shared/settings'
import { sanitizeShortcutBindings, type ShortcutId } from '../shared/shortcuts'
import { isRecord } from './git-core'

/**
 * A tool name reaches a process launcher, so it is restricted to the characters
 * a program name is actually made of. A value carrying a space, a quote, a
 * newline, or a path separator is refused rather than split or quoted, so no
 * stored setting can turn into more than one argument.
 */
const TOOL_NAME = /^[A-Za-z0-9._\-+]+$/

/** Every setting key, in the order the Settings surface presents them. */
export const SETTING_KEYS = [
  'git.useSystemGit',
  'git.editor',
  'git.mergeTool',
  'git.defaultPullStrategy',
  'git.defaultMergeMethod',
  'git.fetchIntervalSeconds',
  'appearance.theme',
  'appearance.reduceMotion',
  'privacy.includeLocalPaths',
  'shortcuts',
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]

const PULL_STRATEGIES: Record<string, true> = { 'ff-only': true, merge: true, rebase: true }
const MERGE_METHODS: Record<string, true> = { merge: true, squash: true, rebase: true }
const THEMES: Record<string, true> = { system: true, light: true, dark: true }

/**
 * Locks an administrator's policy places on this computer, keyed by the same
 * names the Settings surface shows. A locked key keeps its stored value: the
 * policy fixes the value rather than replacing it with a default, so a machine
 * that only permits system Git still reports the choice it is actually making.
 */
export type SettingsPolicy = { locks?: Record<string, string> }

/** A tool name, or null for "use the platform default". Empty means unset. */
function toolName(
  value: unknown,
  allowed: readonly string[],
  kind: string,
): { value: string | null; issue?: string } {
  if (value === null || value === undefined) return { value: null }
  if (typeof value !== 'string') return { value: null, issue: 'must be text or empty' }
  const trimmed = value.trim()
  if (!trimmed) return { value: null }
  if (trimmed.length > MAX_TOOL_NAME_LENGTH) {
    return { value: null, issue: `must be at most ${MAX_TOOL_NAME_LENGTH} characters` }
  }
  if (!TOOL_NAME.test(trimmed)) {
    return {
      value: null,
      issue: 'must be one program name: letters, digits, dot, dash, plus, or underscore',
    }
  }
  if (!allowed.includes(trimmed)) {
    return {
      value: null,
      issue: `must be a supported ${kind} (${allowed.slice(0, 5).join(', ')}, ...)`,
    }
  }
  return { value: trimmed }
}

/**
 * One validated enum or boolean field. `allowed` is a static membership table,
 * so the refusal names every value the field accepts rather than a type.
 */
function oneOf<T>(
  value: unknown,
  allowed: Record<string, true>,
  fallback: T,
): { value: T; issue: string | null } {
  if (typeof value === 'string' && allowed[value] === true)
    return { value: value as T, issue: null }
  if (typeof value === 'boolean' && allowed[String(value)] === true) {
    return { value: value as T, issue: null }
  }
  return { value: fallback, issue: `must be ${Object.keys(allowed).join(' or ')}` }
}

/**
 * A boolean field. A boolean is not an enum of two names: the string `"false"`
 * is truthy to every consumer, so accepting it would turn a setting the user
 * believes is off into one that is on. Only a real boolean is accepted, and
 * anything else recovers to the default and is reported.
 */
function booleanField(value: unknown, fallback: boolean): { value: boolean; issue: string | null } {
  if (typeof value === 'boolean') return { value, issue: null }
  if (value === undefined) return { value: fallback, issue: null }
  return { value: fallback, issue: 'must be true or false' }
}

/**
 * Builds settings from an untrusted object. Every field is validated on its own:
 * one bad value falls back to its default and is reported, while the rest of the
 * file still applies. A file that is not an object at all yields pure defaults
 * and is reported as recovered, because nothing in it could be trusted.
 */
export function validateSettings(value: unknown): {
  settings: AppSettings
  issues: SettingsIssue[]
  recovered: boolean
} {
  const issues: SettingsIssue[] = []
  if (!isRecord(value)) {
    return { settings: structuredClone(DEFAULT_SETTINGS), issues: [], recovered: true }
  }

  const git = isRecord(value.git) ? value.git : {}
  const appearance = isRecord(value.appearance) ? value.appearance : {}
  const privacy = isRecord(value.privacy) ? value.privacy : {}

  // A field the file did not supply is absent, not invalid: only a value that is
  // present and wrong is reported, so a sparse file does not report every default.
  const fields = {
    'git.useSystemGit': [
      git.useSystemGit,
      booleanField(git.useSystemGit, DEFAULT_SETTINGS.git.useSystemGit),
    ] as const,
    'git.editor': [git.editor, toolName(git.editor, SUPPORTED_EDITORS, 'editor')] as const,
    'git.mergeTool': [
      git.mergeTool,
      toolName(git.mergeTool, SUPPORTED_MERGE_TOOLS, 'merge tool'),
    ] as const,
    'git.defaultPullStrategy': [
      git.defaultPullStrategy,
      oneOf(git.defaultPullStrategy, PULL_STRATEGIES, DEFAULT_SETTINGS.git.defaultPullStrategy),
    ] as const,
    'git.defaultMergeMethod': [
      git.defaultMergeMethod,
      oneOf(git.defaultMergeMethod, MERGE_METHODS, DEFAULT_SETTINGS.git.defaultMergeMethod),
    ] as const,
    'appearance.theme': [
      appearance.theme,
      oneOf(appearance.theme, THEMES, DEFAULT_SETTINGS.appearance.theme),
    ] as const,
    'appearance.reduceMotion': [
      appearance.reduceMotion,
      booleanField(appearance.reduceMotion, DEFAULT_SETTINGS.appearance.reduceMotion),
    ] as const,
    'privacy.includeLocalPaths': [
      privacy.includeLocalPaths,
      booleanField(privacy.includeLocalPaths, DEFAULT_SETTINGS.privacy.includeLocalPaths),
    ] as const,
  }
  for (const [key, [raw, result]] of Object.entries(fields)) {
    if (raw !== undefined && result.issue) issues.push({ key, message: result.issue })
  }

  const useSystemGit = fields['git.useSystemGit'][1].value
  const pullStrategy = fields['git.defaultPullStrategy'][1].value
  const mergeMethod = fields['git.defaultMergeMethod'][1].value
  const theme = fields['appearance.theme'][1].value
  const reduceMotion = fields['appearance.reduceMotion'][1].value
  const includeLocalPaths = fields['privacy.includeLocalPaths'][1].value

  let fetchInterval = DEFAULT_SETTINGS.git.fetchIntervalSeconds
  if (git.fetchIntervalSeconds !== undefined) {
    const raw = git.fetchIntervalSeconds
    if (
      typeof raw === 'number' &&
      Number.isInteger(raw) &&
      raw >= 0 &&
      raw <= MAX_FETCH_INTERVAL_SECONDS
    ) {
      fetchInterval = raw
    } else {
      issues.push({
        key: 'git.fetchIntervalSeconds',
        message: `must be a whole number of seconds from 0 to ${MAX_FETCH_INTERVAL_SECONDS}`,
      })
    }
  }

  const shortcuts = sanitizeShortcutBindings(value.shortcuts)
  const migratedField = booleanField(
    isRecord(value.migrated) ? value.migrated.legacyShortcutStorage : undefined,
    false,
  )
  const migrated: SettingsMigrations = { legacyShortcutStorage: migratedField.value }
  if (migratedField.issue) {
    issues.push({ key: 'migrated.legacyShortcutStorage', message: migratedField.issue })
  }
  if (value.shortcuts !== undefined && !isRecord(value.shortcuts)) {
    issues.push({ key: 'shortcuts', message: 'must be an object of shortcut chords' })
  }

  return {
    settings: {
      version: SETTINGS_VERSION,
      git: {
        useSystemGit,
        editor: fields['git.editor'][1].value,
        mergeTool: fields['git.mergeTool'][1].value,
        defaultPullStrategy: pullStrategy,
        defaultMergeMethod: mergeMethod,
        fetchIntervalSeconds: fetchInterval,
      },
      appearance: { theme, reduceMotion },
      privacy: { includeLocalPaths },
      shortcuts,
      migrated,
    },
    issues,
    recovered: false,
  }
}

/** Every key a policy may lock, so an unknown one is reported rather than stored. */
export function validatePolicy(value: unknown): {
  policy: Required<SettingsPolicy>
  issues: SettingsIssue[]
} {
  const issues: SettingsIssue[] = []
  const locks: Record<string, string> = {}
  if (!isRecord(value)) {
    return { policy: { locks }, issues: [{ key: 'policy', message: 'must be an object' }] }
  }
  const declared = value.locks
  if (declared === undefined) return { policy: { locks }, issues }
  if (!isRecord(declared)) {
    return { policy: { locks }, issues: [{ key: 'policy.locks', message: 'must be an object' }] }
  }
  for (const [key, reason] of Object.entries(declared)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      issues.push({ key: `policy.locks.${key}`, message: 'is not a known setting' })
      continue
    }
    locks[key] =
      typeof reason === 'string' && reason.trim() ? reason.trim() : 'Set by policy on this computer'
  }
  return { policy: { locks }, issues }
}

/**
 * Whether stored settings still hold the state an import of legacy shortcuts
 * was decided from. Two conditions, both about the bindings themselves: the
 * marker must not already be set, and the stored chords must still be the
 * defaults. A file that has moved on in either way is not a file an import may
 * write over, however the import was requested.
 */
export function qualifiesForLegacyShortcutImport(current: AppSettings): boolean {
  if (current.migrated.legacyShortcutStorage) return false
  const defaults = DEFAULT_SETTINGS.shortcuts
  return (Object.keys(defaults) as ShortcutId[]).every(
    (id) => current.shortcuts[id] === defaults[id],
  )
}

/**
 * A validated patch: the same field rules as a whole file, applied over the
 * current settings. A rejected field is reported and left at its current value
 * rather than silently reverted, so a bad edit never discards a good setting.
 *
 * An import of legacy shortcuts is the one change decided from a state the
 * caller read earlier, so it commits here — against the settings this call was
 * handed — only while that state still qualifies. The import is therefore
 * conditional on the persisted state at write time rather than on the marker
 * alone, which is all a plain shortcut patch could ever check.
 */
export function applyPatch(
  current: AppSettings,
  patch: SettingsPatch,
): { settings: AppSettings; issues: SettingsIssue[] } {
  let shortcuts = patch.shortcuts ?? current.shortcuts
  let legacyShortcutStorage = current.migrated.legacyShortcutStorage
  if (patch.legacyShortcutImport && qualifiesForLegacyShortcutImport(current)) {
    shortcuts = patch.legacyShortcutImport
    legacyShortcutStorage = true
  }
  const merged: Record<string, unknown> = {
    git: { ...current.git, ...(isRecord(patch.git) ? patch.git : {}) },
    appearance: { ...current.appearance, ...(isRecord(patch.appearance) ? patch.appearance : {}) },
    privacy: { ...current.privacy, ...(isRecord(patch.privacy) ? patch.privacy : {}) },
    shortcuts,
    migrated: { legacyShortcutStorage },
  }
  const result = validateSettings(merged)

  // A field the patch tried to set and that failed validation keeps the value
  // it already had. Validating a bad edit and dropping it to the default would
  // silently discard a setting that was working, which is the opposite of what
  // the user meant to do.
  const settings: AppSettings = { ...result.settings, version: SETTINGS_VERSION }
  for (const issue of result.issues) {
    if (!touchedBy(issue.key, patch)) continue
    restore(settings, issue.key, current)
  }
  return { settings, issues: result.issues }
}

/**
 * The patch as it is allowed to be written, decided from the file as it stands
 * at the moment the write happens.
 *
 * An import of legacy shortcuts is the one change decided from a state the
 * caller read earlier, so it is the one change that can arrive after the file
 * has moved on. Two things are checked here, and each covers a way the import
 * would otherwise undo a newer choice. The stored bindings must still be the
 * defaults an untouched file holds, and the calling session must not have
 * written settings already — a reset restores exactly those defaults, so only
 * `writesApplied` separates "nothing has been written yet" from "the user asked
 * for defaults just now". A refused import arrives as `null`, which changes
 * nothing; a patch with no import is returned exactly as it came.
 */
export async function settingsPatchToWrite(
  file: string,
  patch: SettingsPatch,
  writesApplied: number,
): Promise<SettingsPatch> {
  if (!patch.legacyShortcutImport) return patch
  const current = await readSettingsFile(file)
  if (writesApplied > 0 || !qualifiesForLegacyShortcutImport(current.settings)) {
    return { ...patch, legacyShortcutImport: null }
  }
  return patch
}

/** Whether a patch named a key, so a rejected value is the user's edit and not a default. */
function touchedBy(key: string, patch: SettingsPatch): boolean {
  if (key === 'shortcuts') return patch.shortcuts !== undefined
  const separator = key.indexOf('.')
  if (separator < 0) return false
  const group = key.slice(0, separator)
  const field = key.slice(separator + 1)
  if (group === 'git') return isRecord(patch.git) && field in patch.git
  if (group === 'appearance') return isRecord(patch.appearance) && field in patch.appearance
  if (group === 'privacy') return isRecord(patch.privacy) && field in patch.privacy
  return false
}

function restore(settings: AppSettings, key: string, current: AppSettings): void {
  switch (key) {
    case 'git.useSystemGit':
      settings.git.useSystemGit = current.git.useSystemGit
      return
    case 'git.editor':
      settings.git.editor = current.git.editor
      return
    case 'git.mergeTool':
      settings.git.mergeTool = current.git.mergeTool
      return
    case 'git.defaultPullStrategy':
      settings.git.defaultPullStrategy = current.git.defaultPullStrategy
      return
    case 'git.defaultMergeMethod':
      settings.git.defaultMergeMethod = current.git.defaultMergeMethod
      return
    case 'git.fetchIntervalSeconds':
      settings.git.fetchIntervalSeconds = current.git.fetchIntervalSeconds
      return
    case 'appearance.theme':
      settings.appearance.theme = current.appearance.theme
      return
    case 'appearance.reduceMotion':
      settings.appearance.reduceMotion = current.appearance.reduceMotion
      return
    case 'privacy.includeLocalPaths':
      settings.privacy.includeLocalPaths = current.privacy.includeLocalPaths
      return
    case 'shortcuts':
      settings.shortcuts = current.shortcuts
      return
    default:
      return
  }
}

/**
 * The locks a patch would run into. A key is refused only when the patch would
 * actually change it: re-saving the value a lock already fixed is allowed, so
 * an unrelated edit is not blocked by a setting it did not touch.
 */
export function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = stripUndefined(v)
    } else {
      result[k] = v
    }
  }
  return result as T
}

export function lockedKeys(
  settings: AppSettings,
  locks: readonly SettingsLock[],
  patch: SettingsPatch,
  prospective?: AppSettings,
): SettingsLock[] {
  const refused: SettingsLock[] = []
  for (const lock of locks) {
    if (lock.key === 'shortcuts') {
      if (patch.shortcuts !== undefined) refused.push(lock)
      continue
    }
    const [group, field] = lock.key.split('.')
    const groupPatch = isRecord(patch[group as keyof SettingsPatch])
      ? (patch[group as keyof SettingsPatch] as Record<string, unknown>)
      : null
    const curVal = (
      settings[group as 'git' | 'appearance' | 'privacy'] as unknown as Record<string, unknown>
    )?.[field]
    if (groupPatch && field !== undefined && field in groupPatch) {
      if (groupPatch[field] !== curVal) {
        refused.push(lock)
        continue
      }
    }
    if (prospective && group && field) {
      const proVal = (
        prospective[group as 'git' | 'appearance' | 'privacy'] as unknown as Record<string, unknown>
      )?.[field]
      if (proVal !== curVal && !refused.includes(lock)) {
        refused.push(lock)
      }
    }
  }
  return refused
}

/** Reads the settings file, reporting corruption instead of throwing. */
export async function readSettingsFile(file: string): Promise<{
  settings: AppSettings
  issues: SettingsIssue[]
  recovered: boolean
}> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: structuredClone(DEFAULT_SETTINGS), issues: [], recovered: false }
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      settings: structuredClone(DEFAULT_SETTINGS),
      issues: [{ key: 'settings', message: 'the file is not valid JSON; defaults are in use' }],
      recovered: true,
    }
  }

  // An earlier build wrote the one preference it had as a top-level key. Fold
  // that into the validated document so the choice is not lost the first time
  // a newer build reads the file.
  if (isRecord(parsed) && typeof parsed.useSystemGit === 'boolean' && !isRecord(parsed.git)) {
    parsed = { ...parsed, git: { useSystemGit: parsed.useSystemGit } }
  }
  return validateSettings(parsed)
}

/**
 * Writes the settings atomically with owner-only permissions, so a partially
 * written file is never the one the app reads back. No repository is touched:
 * this file lives in application data.
 */
export async function writeSettingsFile(file: string, settings: AppSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  const temporary = `${file}.tmp.${nonce}`
  const body = `${JSON.stringify({ ...settings, version: SETTINGS_VERSION }, null, 2)}\n`
  try {
    await writeFile(temporary, body, { mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function readSettingsSnapshot(
  file: string,
  locks: readonly SettingsLock[],
): Promise<SettingsSnapshot> {
  const { settings, issues, recovered } = await readSettingsFile(file)
  return { settings, locks: [...locks], issues, recovered, file }
}

/**
 * Applies a patch and persists it. Locked keys are refused before anything is
 * written, so a refused change leaves the file exactly as it was.
 */
export async function updateSettings(
  file: string,
  patch: SettingsPatch,
  locks: readonly SettingsLock[],
): Promise<SettingsSnapshot> {
  const current = await readSettingsFile(file)
  const cleanPatch = stripUndefined(patch)
  const { settings: prospective, issues } = applyPatch(current.settings, cleanPatch)
  const refused = lockedKeys(current.settings, locks, patch, prospective)
  if (refused.length > 0) {
    const names = refused.map((lock) => lock.key).join(', ')
    throw new Error(
      `${names} ${refused.length === 1 ? 'is' : 'are'} fixed by the settings policy on this computer and cannot be changed here.`,
    )
  }
  await writeSettingsFile(file, prospective)
  return {
    settings: prospective,
    locks: [...locks],
    issues: [...current.issues, ...issues],
    recovered: current.recovered,
    file,
  }
}

/**
 * Restores every setting to its default. This rewrites the application settings
 * file only: no repository, working tree, ref, or configuration is read or
 * written, so resetting preferences cannot change a checkout.
 *
 * A value a policy fixed keeps the value it has. Reset is a change like any
 * other, so it must not be a way around a lock that refuses the same change
 * field by field.
 */
export async function resetSettings(
  file: string,
  locks: readonly SettingsLock[],
): Promise<SettingsSnapshot> {
  const current = await readSettingsFile(file)
  const settings = structuredClone(DEFAULT_SETTINGS)
  for (const lock of locks) preserveLocked(settings, current.settings, lock.key)
  await writeSettingsFile(file, settings)
  return {
    settings,
    locks: [...locks],
    issues: [...current.issues],
    recovered: current.recovered,
    file,
  }
}

/** Puts back the value a lock fixed, so a reset cannot quietly clear it. */
function preserveLocked(target: AppSettings, current: AppSettings, key: string): void {
  switch (key) {
    case 'git.useSystemGit':
      target.git.useSystemGit = current.git.useSystemGit
      return
    case 'git.editor':
      target.git.editor = current.git.editor
      return
    case 'git.mergeTool':
      target.git.mergeTool = current.git.mergeTool
      return
    case 'git.defaultPullStrategy':
      target.git.defaultPullStrategy = current.git.defaultPullStrategy
      return
    case 'git.defaultMergeMethod':
      target.git.defaultMergeMethod = current.git.defaultMergeMethod
      return
    case 'git.fetchIntervalSeconds':
      target.git.fetchIntervalSeconds = current.git.fetchIntervalSeconds
      return
    case 'appearance.theme':
      target.appearance.theme = current.appearance.theme
      return
    case 'appearance.reduceMotion':
      target.appearance.reduceMotion = current.appearance.reduceMotion
      return
    case 'privacy.includeLocalPaths':
      target.privacy.includeLocalPaths = current.privacy.includeLocalPaths
      return
    case 'shortcuts':
      target.shortcuts = current.shortcuts
      return
    default:
      return
  }
}
