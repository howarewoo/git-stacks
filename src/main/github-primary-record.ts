import { readFile, rm } from 'node:fs/promises'
import { isRecord } from '../shared/guards'
import type { CredentialVault } from './credentials'
import { canonicalHostName } from '../shared/host'

/**
 * The application-owned primary GitHub record this build no longer keeps.
 *
 * Earlier builds signed in to a GitHub App of their own, sealed that credential
 * in the operating system's store under an opaque reference, and named that
 * reference in a state file beside it. Provider-owned `gh` authentication
 * replaced all of it, so this record is retired rather than left behind: the CLI
 * owns login, storage, refresh, switching, and logout now, and nothing in this
 * app reads or renews a credential it sealed itself.
 */
export interface PrimaryRecord {
  /** The state file this build wrote, naming the credential it owned. */
  stateFile: string
  vault: CredentialVault
}

export interface RetiredPrimaryRecord {
  /** Whether this build's own record was found and removed. */
  retired: boolean
  /** The host the retired record named; null when nothing of this build's was there. */
  host: string | null
}

/**
 * Removes only what can be verified to be this application's own primary record.
 *
 * A record is retired when the state file names a credential reference, the vault
 * holds an entry under exactly that reference, and that entry was sealed for the
 * same host the state file names. Anything less is left alone: the sealed value
 * is never opened, another module's entries are never touched, the operating
 * system's own store is not reached, and a file this build did not write is
 * never deleted. A CLI credential, a Notifications credential, and any entry
 * nobody can attribute are exactly as they were.
 */
export async function retirePrimaryGitHubRecord(
  record: PrimaryRecord,
): Promise<RetiredPrimaryRecord> {
  const state = await readPrimaryRecord(record.stateFile)
  if (state === null) return { retired: false, host: null }
  if (state.reference === null) {
    // Application state this build owns, naming no credential of its own.
    await rm(record.stateFile, { force: true })
    return { retired: true, host: state.host }
  }
  const entries = await record.vault.references()
  const entry = entries.find((candidate) => candidate.reference === state.reference)
  // A reference nothing holds, or one held for a host the state file does not
  // name, is not verifiably this build's to remove.
  if (entry === undefined || canonicalHostName(entry.host) !== canonicalHostName(state.host)) {
    return { retired: false, host: null }
  }
  await record.vault.remove(state.reference)
  await rm(record.stateFile, { force: true })
  return { retired: true, host: state.host }
}

interface PrimaryStateFile {
  reference: string | null
  /** Always a host: a record naming none is not one this build can retire. */
  host: string
}

/** The non-secret facts the retired record's state file holds, if it is one. */
async function readPrimaryRecord(file: string): Promise<PrimaryStateFile | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // No record of one is the normal state for an install that never used the
    // app-owned sign-in, and an unreadable one is left exactly as it is.
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const reference = typeof parsed.reference === 'string' ? parsed.reference : null
  const host = typeof parsed.host === 'string' ? parsed.host : null
  // Without a host this build cannot tell which credential the record could have
  // been naming, so it retires nothing at all.
  if (host === null) return null
  return { reference: reference === '' ? null : reference, host }
}