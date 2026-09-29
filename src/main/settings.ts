import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_SETTINGS,
  MAX_FETCH_INTERVAL_SECONDS,
  MAX_TOOL_NAME_LENGTH,
  SETTINGS_VERSION,
  type AppSettings,
  type SettingsIssue,
  type SettingsLock,
  type SettingsPatch,
  type SettingsSnapshot,
} from '../shared/settings'
import { sanitizeShortcutBindings } from '../shared/shortcuts'
import { isRecord } from './git-core'

/**
 * A tool name reaches a process launcher, so it is restricted to the characters
 * a program name is actually made of. A value carrying a space, a quote, a
 * newline, or a path separator is refused rather than split or quoted, so no
 * stored setting can turn into more than one argument.
 */
const TOOL_NAME = /^[A-Za-z0-9._-]+$/

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
function toolName(value: unknown): { value: string | null; issue?: string } {
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
      issue: 'must be one program name: letters, digits, dot, dash, or underscore',
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

const BOOLEANS: Record<string, true> = { true: true, false: true }

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
      oneOf(git.useSystemGit, BOOLEANS, DEFAULT_SETTINGS.git.useSystemGit),
    ] as const,
    'git.editor': [git.editor, toolName(git.editor)] as const,
    'git.mergeTool': [git.mergeTool, toolName(git.mergeTool)] as const,
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
      oneOf(appearance.reduceMotion, BOOLEANS, DEFAULT_SETTINGS.appearance.reduceMotion),
    ] as const,
    'privacy.includeLocalPaths': [
      privacy.includeLocalPaths,
      oneOf(privacy.includeLocalPaths, BOOLEANS, DEFAULT_SETTINGS.privacy.includeLocalPaths),
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
  if (value === undefined || value === null) return { policy: { locks }, issues }
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
 * A validated patch: the same field rules as a whole file, applied over the
 * current settings. A rejected field is reported and left at its current value
 * rather than silently reverted, so a bad edit never discards a good setting.
 */
export function applyPatch(
  current: AppSettings,
  patch: SettingsPatch,
): { settings: AppSettings; issues: SettingsIssue[] } {
  const merged: Record<string, unknown> = {
    git: { ...current.git, ...(isRecord(patch.git) ? patch.git : {}) },
    appearance: { ...current.appearance, ...(isRecord(patch.appearance) ? patch.appearance : {}) },
    privacy: { ...current.privacy, ...(isRecord(patch.privacy) ? patch.privacy : {}) },
    shortcuts: patch.shortcuts ?? current.shortcuts,
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
export function lockedKeys(
  settings: AppSettings,
  locks: readonly SettingsLock[],
  patch: SettingsPatch,
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
    if (!groupPatch || field === undefined || groupPatch[field] === undefined) continue
    const current = (
      settings[group as 'git' | 'appearance' | 'privacy'] as unknown as Record<string, unknown>
    )[field]
    if (groupPatch[field] !== current) refused.push(lock)
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
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify({ ...settings, version: SETTINGS_VERSION }, null, 2), {
    mode: 0o600,
  })
  await rename(temporary, file)
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
  const refused = lockedKeys(current.settings, locks, patch)
  if (refused.length > 0) {
    const names = refused.map((lock) => lock.key).join(', ')
    throw new Error(
      `${names} ${refused.length === 1 ? 'is' : 'are'} fixed by the settings policy on this computer and cannot be changed here.`,
    )
  }
  const { settings, issues } = applyPatch(current.settings, patch)
  await writeSettingsFile(file, settings)
  return {
    settings,
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
 */
export async function resetSettings(
  file: string,
  locks: readonly SettingsLock[],
): Promise<SettingsSnapshot> {
  const defaults = structuredClone(DEFAULT_SETTINGS)
  await writeSettingsFile(file, defaults)
  return { settings: defaults, locks: [...locks], issues: [], recovered: false, file }
}
