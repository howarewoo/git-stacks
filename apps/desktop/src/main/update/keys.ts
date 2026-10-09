import committed from '../../../resources/update-trusted-keys.json'
import { isRecord } from '@git-stacks/shared/guards'

/**
 * One public key that may sign this project's update manifests.
 *
 * The key set is committed to the repository and compiled into the main
 * bundle, so it cannot be changed by anything on the user's machine after
 * installation. A key is added here before the release it signs exists, and the
 * release workflow refuses to publish a manifest no key here can verify.
 */
export interface TrustedUpdateKey {
  keyId: string
  /** Base64 DER of the key's SubjectPublicKeyInfo, as `openssl pkey -pubin -outform DER` writes it. */
  publicKey: string
  /** ISO-8601 UTC. Manifests signed before this instant are refused. */
  validFrom: string
  /** ISO-8601 UTC, or null while the key is still current. */
  validUntil: string | null
}

export interface TrustedKeySet {
  keys: TrustedUpdateKey[]
  /**
   * 'release' is the committed key set. 'development' is a key supplied through
   * the environment, which only an unpackaged build ever honours. 'none' means
   * no manifest can be authenticated and the updater stays switched off.
   */
  trust: 'release' | 'development' | 'none'
}

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
/** The committed file's fields are checked below, not trusted from its literal type. */
const registry: { schema: unknown; keys: unknown } = committed

/**
 * The key set that was built into this binary, read from the file the packager
 * wrote. It is a parameter of `trustedUpdateKeys` so that what a caller claims
 * about trust can be stated without also claiming what the checkout on disk
 * happens to hold.
 */
function readCommittedKeys(): TrustedUpdateKey[] {
  if (registry.schema !== 1 || !Array.isArray(registry.keys)) return []
  const keys: TrustedUpdateKey[] = []
  for (const entry of registry.keys) {
    if (
      !isRecord(entry) ||
      typeof entry.keyId !== 'string' ||
      !KEY_ID.test(entry.keyId) ||
      typeof entry.publicKey !== 'string' ||
      !BASE64.test(entry.publicKey) ||
      typeof entry.validFrom !== 'string' ||
      Number.isNaN(Date.parse(entry.validFrom)) ||
      !(entry.validUntil === null || typeof entry.validUntil === 'string') ||
      keys.some((key) => key.keyId === entry.keyId)
    ) {
      continue
    }
    keys.push({
      keyId: entry.keyId,
      publicKey: entry.publicKey,
      validFrom: entry.validFrom,
      validUntil: entry.validUntil,
    })
  }
  return keys
}

/**
 * The keys this build will verify a manifest with.
 *
 * A packaged build reads only the committed key set: an environment variable
 * cannot add a key to an installed app, because an environment variable is
 * something whoever starts the process decides. An unpackaged build used for
 * development and fixtures may take one key from the environment instead, and
 * reports that it did so, so a surface can say the build is not verifying
 * against a release key.
 */
export function trustedUpdateKeys(
  env: NodeJS.ProcessEnv = process.env,
  packaged = false,
  committed: TrustedUpdateKey[] = readCommittedKeys(),
): TrustedKeySet {
  if (committed.length > 0) return { keys: committed, trust: 'release' }
  if (packaged) return { keys: [], trust: 'none' }
  const keyId = env.GIT_STACKS_UPDATE_KEY_ID
  const publicKey = env.GIT_STACKS_UPDATE_PUBLIC_KEY
  if (!keyId || !publicKey || !KEY_ID.test(keyId) || !BASE64.test(publicKey)) {
    return { keys: [], trust: 'none' }
  }
  return {
    keys: [{ keyId, publicKey, validFrom: '1970-01-01T00:00:00.000Z', validUntil: null }],
    trust: 'development',
  }
}

/** A key is usable only inside the window it was trusted for. */
export function keyIsCurrent(key: TrustedUpdateKey, at: number): boolean {
  const from = Date.parse(key.validFrom)
  const until = key.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(key.validUntil)
  return !Number.isNaN(from) && !Number.isNaN(until) && at >= from && at < until
}
