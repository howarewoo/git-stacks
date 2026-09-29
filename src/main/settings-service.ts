import { readFile } from 'node:fs/promises'
import { SETTING_KEYS, validatePolicy, type SettingsPolicy } from './settings'
import type { SettingsLock } from '../shared/settings'

/**
 * The policy file names the settings a person administering this computer has
 * fixed. It is optional and read once at startup.
 *
 * A policy that is present but cannot be understood must not read as "nothing
 * is locked": that would silently widen what this app does on a machine whose
 * administrator intended to narrow it. A policy file that cannot be read
 * blocks every managed setting instead, and the reason travels with every
 * settings read so the surface can say why a control is unavailable.
 */
export interface LoadedPolicy {
  /** Locks the policy file actually states. */
  locks: SettingsLock[]
  /**
   * True when the policy file exists but could not be understood. While this
   * holds, every managed setting refuses a change.
   */
  blocked: boolean
  error: string | null
  path: string | null
}

const FAIL_CLOSED_REASON =
  'The settings policy for this computer could not be read, so every managed setting is held at its current value.'

/** No policy file at all: nothing is locked, and nothing is blocked. */
export const NO_POLICY: LoadedPolicy = { locks: [], blocked: false, error: null, path: null }

export async function loadSettingsPolicy(file: string | undefined): Promise<LoadedPolicy> {
  if (!file) return NO_POLICY

  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return {
      locks: allKeysLocked(FAIL_CLOSED_REASON),
      blocked: true,
      error: `${FAIL_CLOSED_REASON} (${(error as Error).message})`,
      path: file,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      locks: allKeysLocked(FAIL_CLOSED_REASON),
      blocked: true,
      error: `${FAIL_CLOSED_REASON} The file at ${file} is not valid JSON.`,
      path: file,
    }
  }

  const { policy, issues } = validatePolicy(parsed)
  // A policy that names keys this build does not know is partly unusable, so it
  // is held closed rather than applied in part and silently widening the rest.
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.key} ${issue.message}`).join('; ')
    return {
      locks: allKeysLocked(FAIL_CLOSED_REASON),
      blocked: true,
      error: `${FAIL_CLOSED_REASON} ${detail}`,
      path: file,
    }
  }
  return {
    locks: Object.entries(policy.locks).map(([key, reason]) => ({ key, reason })),
    blocked: false,
    error: null,
    path: file,
  }
}

function allKeysLocked(reason: string): SettingsLock[] {
  return SETTING_KEYS.map((key) => ({ key, reason }))
}

export type { SettingsPolicy }
