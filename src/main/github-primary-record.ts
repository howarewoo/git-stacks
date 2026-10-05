import { isRecord } from '../shared/guards'
import {
  claimOwnedFile,
  readOwnedFile,
  type CredentialVault,
  type OwnedFileRead,
} from './credentials'

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
  /**
   * The file this vault holds its entries in, named by the caller that created
   * it. It is named rather than asked of the vault because it is checked before
   * anything is removed: a vault whose own file is not a regular file is not one
   * this app should rewrite, and the vault has no reason to expose where it
   * keeps its secrets.
   */
  vaultFile: string

  /**
   * References this build must not delete, named by the caller from state it
   * already holds.
   *
   * A Notifications credential is stored in a vault entry of exactly the shape
   * this build writes, for exactly the same host, so nothing inside the vault
   * distinguishes one from this build's own primary credential. What does is
   * what the Notifications center currently knows it holds: the caller reads
   * that from its own public state and passes it here, so a state file naming a
   * live Notifications reference cannot have it deleted.
   *
   * Only names are passed. Nothing here opens a sealed value, reaches the
   * operating system's store, or reads a secret to make this decision.
   */
  protectedReferences?: readonly string[]
}

export interface RetiredPrimaryRecord {
  /** Whether this build's own record was found and removed. */
  retired: boolean
  /** The host the retired record named; null when nothing of this build's was there. */
  host: string | null
}

/**
 * Every field this build's own record holds, and nothing else.
 *
 * A file that does not match this shape is not a record of ours — it may be a
 * different tool's, a partially written file, or something a person put there —
 * and retiring it could destroy a credential this app never owned. So a record
 * is only retired when every field is present, of the right type, and there is no
 * field this build does not recognise.
 */
const PRIMARY_FIELDS = [
  'reference',
  'host',
  'login',
  'createdAt',
  'expiresAt',
  'refreshExpiresAt',
  'session',
] as const

interface PrimaryStateFile {
  reference: string
  host: string
}

/** Whether this file is one this build wrote, read without opening any secret. */
function primaryStateFile(parsed: unknown): PrimaryStateFile | null {
  if (!isRecord(parsed)) return null
  if (Object.keys(parsed).some((key) => !PRIMARY_FIELDS.includes(key as never))) return null
  if (typeof parsed.reference !== 'string' || !parsed.reference) return null
  if (typeof parsed.host !== 'string' || !parsed.host) return null
  if (parsed.login !== null && typeof parsed.login !== 'string') return null
  if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) return null
  if (parsed.expiresAt !== null && typeof parsed.expiresAt !== 'number') return null
  if (parsed.refreshExpiresAt !== null && typeof parsed.refreshExpiresAt !== 'number') return null
  if (typeof parsed.session !== 'string' || !parsed.session) return null
  return { reference: parsed.reference, host: parsed.host }
}

/**
 * Removes only what can be verified to be this application's own primary record.
 *
 * A record is retired when this build's own state file is there as a regular file
 * with the shape this build wrote, it names a credential reference, the vault
 * holds that reference as an entry this build wrote and sealed for the same host
 * the state file names. Anything less is left exactly as it is: the sealed value
 * is never opened, another module's entries are never touched, the operating
 * system's own store is not reached, and a file this build did not write — or one
 * that is a link rather than a file — is never removed. A CLI credential, a
 * Notifications credential, and any entry nobody can attribute are left alone.
 *
 * The order is the contract: the record is validated, then claimed under a name
 * nothing else can guess and checked again to be the very file that was read, and
 * only then is its credential removed. A record that stopped being ours before
 * the claim is put straight back, and a credential is never removed by a call
 * that goes on to report that nothing was retired.
 */
export async function retirePrimaryGitHubRecord(
  record: PrimaryRecord,
): Promise<RetiredPrimaryRecord> {
  const read = await readPrimaryRecord(record.stateFile)
  if (read === null) return { retired: false, host: null }
  const state = read.state
  // A record naming a reference another module currently holds is not this
  // build's own credential, whatever its file claims. Nothing inside the vault
  // can tell the two apart — a Notifications entry carries this shape and this
  // host — so what the Notifications center currently holds decides, and no
  // credential is ever deleted on a state file's claim alone.
  if (record.protectedReferences?.includes(state.reference)) {
    return { retired: false, host: null }
  }
  // The file the entries are in is checked before any of them is read: a link,
  // or anything that is not a regular file, is not this app's own store, and
  // removing an entry through one would write to whatever it points at.
  if ((await readOwnedFile(record.vaultFile)) === null) return { retired: false, host: null }
  // The record is taken out of circulation before anything it names is touched:
  // the file that will be removed is the one just validated, whatever arrives at
  // the path in the meantime, and a record that is no longer that file is put
  // back where it was found.
  const claim = await claimOwnedFile(record.stateFile)
  if (claim === null) return { retired: false, host: null }
  if (!(await claim.matches(read.file))) {
    await claim.restore()
    return { retired: false, host: null }
  }
  // Everything from here can refuse or fail, and until the credential is really
  // gone this record is the only thing naming it. So each way out puts the
  // record back: a vault that will not parse, one this app cannot prove
  // anything about, and one that refused the removal all leave the record
  // exactly where it was found. Only a removal that actually happened discards
  // it — a cleanup that could not be carried out never reports that it was.
  let removed = false
  try {
    removed = await record.vault.removeOwned(state.reference, state.host)
  } catch {
    await claim.restore()
    return { retired: false, host: null }
  }
  if (!removed) {
    await claim.restore()
    return { retired: false, host: null }
  }
  // The credential is gone, so the record naming it goes with it — through the
  // claim this function owns rather than through the path a replacement could
  // have taken.
  await claim.discard()
  return { retired: true, host: state.host }
}

/**
 * The record this build wrote, if the named path is one.
 *
 * A link is not one: it is something a person or another tool pointed at, and
 * following it would let what is behind it be deleted on the strength of a name.
 * The bytes and the file they came from are returned together so the deletion
 * that follows can be bound to both.
 */
async function readPrimaryRecord(
  file: string,
): Promise<{ state: PrimaryStateFile; file: OwnedFileRead } | null> {
  const read = await readOwnedFile(file)
  if (read === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return null
  }
  const state = primaryStateFile(parsed)
  return state === null ? null : { state, file: read }
}
