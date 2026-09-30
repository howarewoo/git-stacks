import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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

function sealedCredential(value: unknown): SealedCredential | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  if (typeof entry.reference !== 'string' || !entry.reference) return null
  if (typeof entry.host !== 'string' || !entry.host) return null
  if (typeof entry.sealed !== 'string' || !entry.sealed) return null
  if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) return null
  return {
    reference: entry.reference,
    host: entry.host,
    sealed: entry.sealed,
    createdAt: entry.createdAt,
  }
}

function parseFile(text: string, file: string): Map<string, SealedCredential> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CredentialStoreError('unreadable', `The credential store at ${file} is not readable.`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CredentialStoreError('unreadable', `The credential store at ${file} is not readable.`)
  }
  const store = parsed as Record<string, unknown>
  if (store.version !== FILE_VERSION || !Array.isArray(store.entries)) {
    throw new CredentialStoreError('unreadable', `The credential store at ${file} is not readable.`)
  }
  const entries = new Map<string, SealedCredential>()
  for (const item of store.entries) {
    const entry = sealedCredential(item)
    if (!entry) {
      throw new CredentialStoreError(
        'unreadable',
        `The credential store at ${file} is not readable.`,
      )
    }
    entries.set(entry.reference, entry)
  }
  return entries
}

/**
 * Sealed secrets held by the operating system. Only the opaque reference, the
 * host it belongs to, and the OS-sealed bytes are written to disk; callers keep
 * the reference and never the sealed value.
 */
export class CredentialVault {
  private entries: Map<string, SealedCredential> | null = null

  constructor(
    private readonly file: string,
    private readonly protector: SecretProtector,
  ) {}

  /** The OS store that will hold secrets, or why none can be used. */
  store(): SecretStore {
    return this.protector.store()
  }

  private requireStore(): string {
    const store = this.protector.store()
    if (store.kind !== 'system') {
      throw new CredentialStoreError('unavailable', store.reason)
    }
    return store.name
  }

  private async write(entries: Map<string, SealedCredential>): Promise<void> {
    // An emptied store is removed rather than left behind as an empty file.
    if (entries.size === 0) {
      await rm(this.file, { force: true })
      this.entries = entries
      return
    }
    await mkdir(dirname(this.file), { recursive: true })
    const body = JSON.stringify({
      version: FILE_VERSION,
      entries: [...entries.values()].map(({ reference, host, sealed, createdAt }) => ({
        reference,
        host,
        sealed,
        createdAt,
      })),
    })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, body, { mode: 0o600 })
    await rename(temporary, this.file)
    this.entries = entries
  }

  private async read(): Promise<Map<string, SealedCredential>> {
    if (this.entries) return this.entries
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = new Map()
        return this.entries
      }
      throw new CredentialStoreError('unreadable', 'The stored credentials could not be read.')
    }
    this.entries = parseFile(text, this.file)
    return this.entries
  }

  /** Stored references with their OS-sealed values; the only place they are held. */
  async references(): Promise<SealedCredential[]> {
    return [...(await this.read()).values()]
  }

  /**
   * Adds a credential for `host` under a new opaque reference and returns it,
   * leaving any credential already stored for that host in place. A replacement
   * is therefore never destructive: the caller removes the previous reference
   * only once the new one is committed, and a caller that abandons the
   * replacement can remove what it staged and keep what was there before.
   */
  async stage(host: string, secret: string, now: number): Promise<string> {
    this.requireStore()
    const entries = new Map(await this.read())
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
    entries.set(reference, {
      reference,
      host,
      sealed: sealed.toString('base64'),
      createdAt: now,
    })
    await this.write(entries)
    return reference
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
    const entry = (await this.read()).get(reference)
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
    const entries = new Map(await this.read())
    if (!entries.delete(reference)) return
    await this.write(entries)
  }

  /** Removes every credential this application owns. */
  async clear(): Promise<void> {
    await rm(this.file, { force: true })
    this.entries = new Map()
  }
}
