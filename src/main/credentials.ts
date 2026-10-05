import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * The operating-system store that will hold a sealed secret, or why none can be
 * used. `basic_text` is deliberately absent: it is the Linux fallback Electron
 * selects when no keyring is reachable, and it obfuscates rather than encrypts.
 */
export type SecretStore =
  | { readonly kind: 'system'; readonly name: string }
  | {
      readonly kind: 'unavailable'
      readonly reason: string
    }

export interface SecretProtector {
  /** The OS store that will hold sealed secrets, or why none can be used. */
  store(): SecretStore
  /** Seals a secret with the OS key. Throws when the key is unavailable. */
  seal(plain: string): Buffer
  /** Opens a sealed secret with the OS key. Throws when the key cannot open it. */
  open(sealed: Buffer): string
}

export type CredentialFailure = 'unreadable' | 'unavailable' | 'unsealed' | 'wrong-host'

/**
 * A credential store failure never carries the secret or the platform's own
 * diagnostics, so nothing sealed or plaintext can reach an error string.
 */
export class CredentialStoreError extends Error {
  constructor(
    readonly failure: CredentialFailure,
    message: string,
  ) {
    super(message)
    this.name = 'CredentialStoreError'
  }
}

/** One stored credential. The sealed value is opaque to everything but the protector. */
export interface SealedCredential {
  /** Opaque handle; the only credential material that ever leaves this module. */
  reference: string
  host: string
  sealed: string
  createdAt: number
}

const FILE_VERSION = 1

/** Every field an entry this build writes carries, and nothing else. */
const ENTRY_FIELDS = ['reference', 'host', 'sealed', 'createdAt'] as const

/** The file a descriptor is holding, as the operating system numbers it. */
export interface OwnedFileIdentity {
  dev: number
  ino: number
}

/** One owned regular file, read through the descriptor that is now holding it. */
export interface OwnedFileRead {
  /** The file these bytes came from, so a replacement can be told from it. */
  identity: OwnedFileIdentity
  text: string
}

/**
 * A file this process has taken exclusive ownership of by moving it aside under
 * a name nothing else can guess.
 *
 * The move is a rename, so it is atomic: the file that lands under the new name
 * is whatever was at the path at that instant, and there is no window in which a
 * different file could take its place. That is what makes it usable as a claim —
 * the file that is later removed is the one this process checked, rather than
 * whatever happens to be at the path by the time a check is finished with it.
 */
export interface OwnedFileClaim {
  /**
   * Whether the claimed file is still the one these bytes were read from: the
   * same file, with the same contents. Contents are compared as well as identity
   * because a file edited in place keeps its identity while ceasing to be the
   * record that was read.
   */
  matches(validated: OwnedFileRead): Promise<boolean>
  /** Puts the file back where it was, for a claim this process does not own. */
  restore(): Promise<void>
  /** Removes the claimed file, once it is known to be the one that was checked. */
  discard(): Promise<void>
}

/**
 * Opens an owned file without following links and reads it.
 *
 * The descriptor, not the path, is what is checked and then read, so a store that
 * became a link after this app last wrote it is answered as nothing there is:
 * reading through it would let whatever is behind it be sealed into, or removed
 * from, as if it were this app's own file. `null` is a path with no owned regular
 * file behind it; `'failed'` is a file this process could not read at all, which
 * is a fault to report rather than an absence to act on.
 */
async function openOwnedFile(file: string): Promise<OwnedFileRead | null | 'failed'> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Nothing at the path, or a path that is a link: there is nothing of this
    // app's own behind either of them.
    return code === 'ENOENT' || code === 'ELOOP' ? null : 'failed'
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return null
    return {
      identity: { dev: stats.dev, ino: stats.ino },
      text: await handle.readFile('utf8'),
    }
  } catch {
    return 'failed'
  } finally {
    await handle.close()
  }
}

/** Reads an owned file, treating anything unreadable as none of this app's own. */
export async function readOwnedFile(file: string): Promise<OwnedFileRead | null> {
  const read = await openOwnedFile(file)
  return read === 'failed' ? null : read
}

/**
 * Moves an owned file aside under a name nothing else can guess and claims it.
 *
 * Returns null when there was nothing at the path to claim. The claim is not a
 * decision: the caller still has to say whether the file it moved is the one it
 * validated, and put it back when it is not.
 */
export async function claimOwnedFile(file: string): Promise<OwnedFileClaim | null> {
  const claimed = join(dirname(file), `.${basename(file)}.${randomUUID()}.claim`)
  try {
    // Atomic: whatever is at the path is the file that moves.
    await rename(file, claimed)
  } catch {
    return null
  }
  return {
    matches: async (validated) => {
      const current = await openOwnedFile(claimed)
      return (
        current !== null &&
        current !== 'failed' &&
        current.identity.dev === validated.identity.dev &&
        current.identity.ino === validated.identity.ino &&
        current.text === validated.text
      )
    },
    restore: async () => {
      // Not renamed over whatever took the path: that file is another writer's
      // work and is left exactly as it is. When the path is still free the
      // claimed file goes back with link, which refuses rather than replacing.
      try {
        await link(claimed, file)
        await rm(claimed, { force: true })
        return
      } catch {
        // The path is occupied, or the link could not be made. The file that is
        // there now is not this process's to replace, and the claimed file is
        // this process's own, so it is kept rather than discarded: a store this
        // app had sealed credentials in is not thrown away by a cleanup that
        // could not put it back.
      }
    },
    discard: async () => {
      await rm(claimed, { force: true })
    },
  }
}

/** One entry as this build reads it, beside the document it was read from. */
interface VaultEntry {
  /**
   * The entry exactly as the document holds it, so a rewrite that changes one
   * entry changes nothing else about the ones it leaves alone.
   */
  readonly raw: Record<string, unknown>
  readonly reference: string
  readonly host: string
  readonly sealed: string
  readonly createdAt: number
}

/** The store as a document: its entries, and every key this build does not read. */
interface VaultDocument {
  entries: VaultEntry[]
  /** Top-level keys beside `version` and `entries`, preserved as they were read. */
  extras: Record<string, unknown>
}

/** Whether this build wrote this entry, rather than merely being able to read it. */
function isOwnEntry(entry: VaultEntry): boolean {
  return Object.keys(entry.raw).every((field) => ENTRY_FIELDS.includes(field as never))
}

function vaultEntry(value: unknown): VaultEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.reference !== 'string' || !raw.reference) return null
  if (typeof raw.host !== 'string' || !raw.host) return null
  if (typeof raw.sealed !== 'string' || !raw.sealed) return null
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null
  return {
    raw,
    reference: raw.reference,
    host: raw.host,
    sealed: raw.sealed,
    createdAt: raw.createdAt,
  }
}

function unreadable(file: string): CredentialStoreError {
  return new CredentialStoreError('unreadable', `The credential store at ${file} is not readable.`)
}

function parseFile(text: string, file: string): VaultDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unreadable(file)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw unreadable(file)
  const store = parsed as Record<string, unknown>
  if (store.version !== FILE_VERSION || !Array.isArray(store.entries)) throw unreadable(file)
  const entries: VaultEntry[] = []
  const seen = new Set<string>()
  for (const item of store.entries) {
    const entry = vaultEntry(item)
    if (!entry) throw unreadable(file)
    // Two entries under one reference leave nothing to say which of them a
    // reference names, so nothing here may act on either of them.
    if (seen.has(entry.reference)) throw unreadable(file)
    seen.add(entry.reference)
    entries.push(entry)
  }
  // A field is carried into a prototype-less object because a name taken from a
  // parsed file is not this build's to interpret: assigning `__proto__` on an
  // ordinary object would set that object's prototype instead of keeping the field,
  // silently dropping a field another writer stored and leaving a foreign object
  // standing in for the one that was read.
  const extras: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(store)) {
    if (key !== 'version' && key !== 'entries') extras[key] = value
  }
  return { entries, extras }
}

function serialise(document: VaultDocument): string {
  return JSON.stringify({
    version: FILE_VERSION,
    entries: document.entries.map((entry) => entry.raw),
    ...document.extras,
  })
}

/**
 * Sealed secrets held by the operating system. Only the opaque reference, the
 * host it belongs to, and the OS-sealed bytes are written to disk; callers keep
 * the reference and never the sealed value.
 *
 * Nothing this module holds between calls stands in for the file: every read
 * opens the file that is there now, and every change is bound to the file and
 * contents it read. A store that has been replaced, malformed or pointed
 * somewhere else is therefore left exactly as it is rather than rewritten from
 * what this process remembers.
 */
export class CredentialVault {
  /**
   * This file's own queue for read-modify-write changes.
   *
   * Every entry is rewritten wholesale, so two mutations that read the file at
   * the same time would lose one of the two entries. Sealing and unsealing can
   * block on the operating system's key store, so the queue belongs to the vault
   * and not to a caller: a caller that awaited its own step here would keep
   * everything else that has to change this file waiting on a key store call.
   */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly protector: SecretProtector,
  ) {}

  /** Runs one change to this file after every change already queued on it. */
  private change<T>(apply: () => Promise<T>): Promise<T> {
    const settled = this.tail.then(apply, apply)
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    )
    return settled
  }

  /** The OS store that will hold secrets, or why none can be used. */
  store(): SecretStore {
    return this.protector.store()
  }

  private requireStore(): void {
    const store = this.protector.store()
    if (store.kind !== 'system') {
      throw new CredentialStoreError('unavailable', store.reason)
    }
  }

  /**
   * The file that is there now, opened without following links and parsed from
   * the descriptor that is holding it, beside that descriptor's identity so a
   * change can be bound to the exact file it read.
   */
  private async load(): Promise<{ document: VaultDocument; read: OwnedFileRead } | null> {
    const read = await openOwnedFile(this.file)
    if (read === 'failed') {
      throw new CredentialStoreError('unreadable', 'The stored credentials could not be read.')
    }
    if (read === null) return null
    return { document: parseFile(read.text, this.file), read }
  }

  /**
   * Writes `document` over this file, and only if this file is still the one
   * `validated` was read from.
   *
   * The replacement is written to a name nothing else can guess, created
   * exclusively so an existing file — a link, or a hard link to somebody's data —
   * is never written through, and filled through its own descriptor. The file it
   * replaces is claimed first and put back untouched when it is not the one that
   * was read, so a store that was replaced in the meantime is never overwritten.
   *
   * Installing it is exclusive too: the new store is linked into place rather
   * than renamed over whatever is at the path, so a file another writer created
   * while this change held the claim — entries this change never saw — is left
   * as it is instead of being destroyed.
   *
   * Returns whether the store was committed. A refused change left the file as it
   * was and did nothing, so its caller can say so rather than act on a store that
   * was never written.
   */
  private async write(document: VaultDocument, validated: OwnedFileRead | null): Promise<boolean> {
    const claim = validated === null ? null : await claimOwnedFile(this.file)
    if (validated !== null && (claim === null || !(await claim.matches(validated)))) {
      await claim?.restore()
      // The file changed under this change, and whoever changed it has the
      // newer store. Overwriting it would destroy their entries.
      return false
    }
    try {
      // A store this build emptied of everything is removed rather than left behind
      // as an empty file. A store that still carries anything another writer put in
      // it is not empty, whatever became of the entries: this build never wrote that
      // field and cannot know what it means, so removing the file would destroy
      // another writer's record along with this build's credential.
      if (document.entries.length === 0 && Object.keys(document.extras).length === 0) {
        await claim?.discard()
        return true
      }
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`)
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      )
      try {
        await handle.writeFile(serialise(document), 'utf8')
      } finally {
        await handle.close()
      }
      try {
        // Linked, not renamed over: link refuses rather than replacing a file
        // that took the path while this change held the claim.
        await link(temporary, this.file)
      } catch {
        // Only this run's own temporary file is removed with it; whatever the
        // path holds now was never written by this change.
        await rm(temporary, { force: true })
        await claim?.restore()
        // Something else owns this path and holds entries this change never saw,
        // or the write could not be made at all. Either way this change did not
        // commit, and the caller is told so.
        if ((await openOwnedFile(this.file)) !== null) return false
        throw new CredentialStoreError('unreadable', 'The stored credentials could not be written.')
      }
      await rm(temporary, { force: true })
      // The claim is a file this process owns under its own name, and what it
      // held is now the store at the path, so the claim itself goes.
      await claim?.discard()
      return true
    } catch (error) {
      // Whatever this change did not replace belongs at its own path again.
      await claim?.restore()
      throw error
    }
  }

  /**
   * Stored references with their OS-sealed values; the only place they are held.
   * They are the entries in the file that is there now; nothing is remembered
   * between calls.
   *
   * Queued on the same line as every change to this file, so a read can never
   * observe the gap a write opens when it claims the file aside: a change in
   * progress would otherwise read as no entries at all, and a reader would
   * decide a stored credential is gone while it is being replaced.
   */
  async references(): Promise<SealedCredential[]> {
    return (await this.change(() => this.load()))?.document.entries ?? []
  }

  /**
   * Adds a credential for `host` under a new opaque reference and returns it,
   * leaving any credential already stored for that host in place. A replacement
   * is therefore never destructive: the caller removes the previous reference
   * only once the new one is committed, and a caller that abandons the
   * replacement can remove what it staged and keep what was there before.
   */
  async stage(host: string, secret: string, now: number): Promise<string> {
    return this.change(async () => {
      this.requireStore()
      const loaded = await this.load()
      const entries = loaded === null ? [] : [...loaded.document.entries]
      const reference = randomUUID()
      let sealed: Buffer
      try {
        sealed = this.protector.seal(secret)
      } catch {
        throw new CredentialStoreError(
          'unavailable',
          'The operating-system key store rejected the credential.',
        )
      }
      const raw = { reference, host, sealed: sealed.toString('base64'), createdAt: now }
      // The entry is the record this build writes, read back field for field,
      // so the two cannot fall out of step with each other.
      entries.push({ raw, ...raw })
      const committed = await this.write(
        { entries, extras: loaded?.document.extras ?? {} },
        loaded?.read ?? null,
      )
      // A reference that was never written names nothing: handing it back would
      // have this app act on a credential the store does not hold.
      if (!committed) {
        throw new CredentialStoreError(
          'unreadable',
          'The stored credentials changed while this one was being saved, so it was not saved.',
        )
      }
      return reference
    })
  }

  /**
   * Opens a sealed secret. `expectedHost` is the GitHub host the saved secret
   * was issued by; a secret saved for any other host is refused before it is
   * decrypted, so a host change between save and restore cannot hand one host's
   * credential to another. Throws when the OS key cannot open it, and never
   * returns partial data.
   */
  async open(reference: string, expectedHost?: string | null): Promise<string> {
    this.requireStore()
    const entry = (await this.references()).find((candidate) => candidate.reference === reference)
    if (!entry) return ''
    if (expectedHost !== undefined && entry.host !== expectedHost) {
      throw new CredentialStoreError(
        'wrong-host',
        'The saved credential belongs to a different GitHub host and was not opened.',
      )
    }
    try {
      return this.protector.open(Buffer.from(entry.sealed, 'base64'))
    } catch {
      throw new CredentialStoreError(
        'unsealed',
        'The operating-system key store could not open the saved credential.',
      )
    }
  }

  async remove(reference: string): Promise<void> {
    await this.change(async () => {
      const loaded = await this.load()
      if (loaded === null) return
      const entries = loaded.document.entries.filter((entry) => entry.reference !== reference)
      if (entries.length === loaded.document.entries.length) return
      await this.write({ entries, extras: loaded.document.extras }, loaded.read)
    })
  }

  /**
   * Removes one entry, and only one this app can prove is its own.
   *
   * The entry is removed from the file that is there now, never from what this
   * process read earlier, and only when that file is one this build wrote, holds
   * exactly one entry under `reference`, that entry carries only the fields this
   * build writes, and it was sealed for `host`. Everything else is left exactly
   * as it is and reported as not removed: a file that is a link or malformed, a
   * store replaced since this call began, an entry whose shape another tool
   * wrote, or an entry that belongs to another host — because an entry another
   * module or another build owns is never this app's to delete.
   *
   * Returns whether it removed one entry.
   */
  async removeOwned(reference: string, host: string): Promise<boolean> {
    return this.change(async () => {
      // A store this build cannot read is one it can prove nothing about: the
      // file is left exactly as it is and the answer is that nothing was
      // removed, rather than a failure this question does not ask for.
      const loaded = await this.load().catch((error: unknown) => {
        if (error instanceof CredentialStoreError && error.failure === 'unreadable') return null
        throw error
      })
      if (loaded === null) return false
      const owned = loaded.document.entries.filter((entry) => entry.reference === reference)
      if (owned.length !== 1) return false
      if (!isOwnEntry(owned[0]) || owned[0].host !== host) return false
      const committed = await this.write(
        {
          entries: loaded.document.entries.filter((entry) => entry.reference !== reference),
          extras: loaded.document.extras,
        },
        loaded.read,
      )
      // Only a removal that actually happened is reported as one. Reporting it
      // after a store that took the entry over was refused would have this app
      // discard the record of a credential that is still stored.
      return committed
    })
  }

  /** Removes every credential this application owns. */
  async clear(): Promise<void> {
    await this.change(async () => {
      const loaded = await this.load()
      if (loaded === null) return
      await this.write({ entries: [], extras: {} }, loaded.read)
    })
  }
}
