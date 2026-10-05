import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  retirePrimaryGitHubRecord,
  type PrimaryRecord,
  type RetiredPrimaryRecord,
} from './github-primary-record'
import { isRecord } from '../shared/guards'

/**
 * One host's stored Notifications credential file, named the way
 * `NotificationCenter` names it: the host's own name in hex, which is what keeps
 * one host's state out of another's. Every host's file is read, not only a
 * selected one, because a credential kept for a host that is not selected now is
 * still stored — and the cache and vault files beside it are not state of this
 * kind, and name no credential on their own.
 */
const NOTIFICATION_CREDENTIAL_FILE = /^github-notifications\.([0-9a-f]+)\.json$/u

/**
 * The reference names every host's stored Notifications state holds, or null when
 * that could not be established.
 *
 * Read as names only: nothing here opens a sealed value or reaches the operating
 * system's store, so a state file this app does not recognise is still only read
 * for the name it publishes. It is not skipped, though. A file that cannot be
 * read, cannot be parsed, or parses into something that names no reference may
 * hold exactly the name that distinguishes a Notifications credential from this
 * build's own primary one, so it is reported as an unknown answer rather than as
 * no reference at all — an unreadable file is not evidence of an absent
 * credential.
 */
async function notificationCredentialReferences(userData: string): Promise<string[] | null> {
  const scopes = await readdir(userData).catch(() => null)
  if (scopes === null) return null
  const references: string[] = []
  for (const name of scopes) {
    if (!NOTIFICATION_CREDENTIAL_FILE.test(name)) continue
    const text = await readFile(join(userData, name), 'utf8').catch(() => null)
    if (text === null) return null
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    const reference = isRecord(parsed) ? parsed.reference : null
    if (typeof reference !== 'string' || !reference) return null
    references.push(reference)
  }
  return references
}

/**
 * Retires this application's own primary GitHub record, with every credential the
 * Notifications centers currently hold protected by name.
 *
 * The record is retired at startup, before anything can reach GitHub, and the
 * only thing that tells its credential apart from a Notifications credential is
 * the state those centers keep for themselves: both are sealed vault entries of
 * exactly this build's shape, for exactly the same host. So the retirement is
 * gated on reading every host's state, and the gate is fail-closed — state that
 * cannot be read leaves what it names unknown, and an unknown name retires
 * nothing.
 *
 * Unknown protection is nonfatal: an optional feature's corrupt file must not
 * keep local Git work from opening. A later startup can retire the legacy
 * record once protection is established. Nothing is guessed before deletion.
 */
export async function retireLegacyPrimaryRecord(
  // The protected references are deliberately not a parameter: this is what
  // establishes them, so no caller can retire a record by handing it a list that
  // happens not to name a live Notifications credential.
  record: Omit<PrimaryRecord, 'protectedReferences'>,
  userData: string,
): Promise<RetiredPrimaryRecord> {
  const references = await notificationCredentialReferences(userData)
  if (references === null) {
    return { retired: false, host: null }
  }
  return retirePrimaryGitHubRecord({ ...record, protectedReferences: references })
}
