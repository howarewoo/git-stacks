import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { keyIsCurrent, type TrustedUpdateKey } from './keys'

/**
 * Verifies an Ed25519 signature made by a trusted release key.
 *
 * Nothing here decides whether the signed content is acceptable; it answers one
 * question — did this key sign these exact bytes — and the caller only reads a
 * manifest after this returns true. A key outside its validity window is not
 * consulted, so a retired key stops verifying the moment it is retired rather
 * than whenever someone notices.
 */
export function verifyDetachedSignature(
  key: TrustedUpdateKey,
  data: Uint8Array,
  signatureBase64: string,
  at: number = Date.now(),
): boolean {
  if (!keyIsCurrent(key, at)) return false
  let publicKey
  try {
    publicKey = createPublicKey({
      key: Buffer.from(key.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    // A key that cannot be loaded is a key that cannot verify anything. It is
    // reported as a failed verification rather than crashing the check.
    return false
  }
  return verifySignature(null, data, publicKey, Buffer.from(signatureBase64, 'base64'))
}
