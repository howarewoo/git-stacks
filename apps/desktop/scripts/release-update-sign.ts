#!/usr/bin/env -S npx tsx
/**
 * Signs one channel's manifest with the project's release key and writes the
 * detached signature envelope beside it.
 *
 * The private key is read from the UPDATE_SIGNING_KEY repository secret and
 * nowhere else. It is never generated here, never written to disk, and never
 * committed: a key this script made up would verify against nothing the app
 * trusts, and a key the app does not trust cannot update anything. Its public
 * half is matched against the release key set in
 * `resources/update-trusted-keys.json` — the file `scripts/release-trusted-keys.ts
 * inject` wrote before the app was packaged, and the one a build of this release
 * carries inside it — so a signature is only ever produced by a key the shipped
 * builds already accept, and a secret naming a different key stops the release
 * rather than publishing a manifest no build could verify.
 *
 * The signature covers the manifest's exact bytes as they are on disk, including
 * the trailing newline, because those are the bytes the app fetches and hashes.
 *
 *   UPDATE_SIGNING_KEY="$(cat key.pem)" npx tsx scripts/release-update-sign.ts \
 *     --channel stable --manifest channel-feed/update-stable.json
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { keyIsCurrent, type TrustedUpdateKey } from '../src/main/update/keys'
import { verifyDetachedSignature } from '../src/main/update/signature'
import { MAX_UPDATE_SIGNATURE_BYTES, UPDATE_SIGNATURE_SCHEMA } from '@git-stacks/shared/update'
import {
  fail,
  flag,
  manifestFileName,
  parseFlags,
  publicKeyBytesOf,
  requireChannel,
  requireEd25519SigningKey,
  requireInjectedKey,
  signatureFileName,
} from './release-update-common'

/**
 * The key the secret names, proven to be one this build would trust. Both halves
 * are checked here: the signature is useless without the app's public key, and
 * signing with a key the app does not carry would publish an update nobody can
 * install.
 */
function releaseKeyFromSecret(): { key: TrustedUpdateKey; privateKey: KeyObject } {
  const secret = process.env.UPDATE_SIGNING_KEY?.trim()
  if (!secret) {
    fail(
      'the UPDATE_SIGNING_KEY repository secret is empty or missing. Update manifests are signed with that key and cannot be signed with anything else, so this release publishes no manifest. Add the secret and run the release again.',
    )
  }
  let privateKey
  try {
    privateKey = createPrivateKey(secret)
  } catch {
    fail(
      'the UPDATE_SIGNING_KEY repository secret is not a readable private key (expected a PEM PKCS#8 Ed25519 key).',
    )
  }
  const publicKey = publicKeyBytesOf(requireEd25519SigningKey(privateKey)).toString('base64')
  const keys = requireInjectedKey()
  const key = keys.find((entry) => entry.publicKey === publicKey)
  if (!key) {
    fail(
      `the key in UPDATE_SIGNING_KEY is not the key this release packaged into the app (${keys.map((entry) => entry.keyId).join(', ')}), so every build of it would refuse the manifest this would sign. Nothing is signed.`,
    )
  }
  if (!keyIsCurrent(key, Date.now())) {
    fail(
      `the release key ${key.keyId} is retired (valid until ${key.validUntil}), so it can no longer sign a manifest this app would accept.`,
    )
  }
  return { key, privateKey }
}

const flags = parseFlags(process.argv.slice(2))
const channel = requireChannel(flag(flags, 'channel'))
const manifestPath = flag(flags, 'manifest')
const outPath = flag(flags, 'out', join(dirname(manifestPath), signatureFileName(channel)))
if (manifestPath.endsWith('/')) fail(`--manifest ${manifestPath} names a directory.`)
if (manifestFileName(channel) !== manifestPath.split('/').pop()) {
  fail(`--manifest ${manifestPath} is not the ${channel} manifest (${manifestFileName(channel)}).`)
}

const { key, privateKey } = releaseKeyFromSecret()
const bytes = readFileSync(manifestPath)
const envelope = {
  schema: UPDATE_SIGNATURE_SCHEMA,
  keyId: key.keyId,
  signature: sign(null, bytes, privateKey).toString('base64'),
}
const envelopeBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
if (envelopeBytes.byteLength > MAX_UPDATE_SIGNATURE_BYTES) {
  fail(
    `the signature envelope is ${envelopeBytes.byteLength} bytes, over the ${MAX_UPDATE_SIGNATURE_BYTES} the app will read.`,
  )
}
if (!verifyDetachedSignature(key, bytes, envelope.signature, Date.now())) {
  fail(
    'the signature this script just made does not verify against the committed key. Nothing is written.',
  )
}
writeFileSync(outPath, envelopeBytes)
console.log(
  `release-update: signed ${bytes.byteLength} manifest bytes with ${key.keyId} into ${outPath} (${envelopeBytes.byteLength} bytes).`,
)
