#!/usr/bin/env -S npx tsx
/**
 * Puts the project's release update key into the build that is about to be
 * packaged, and proves the two halves belong together first.
 *
 * The committed key set is empty on purpose: a build with no release key
 * compiled in reports its updates as "not configured" and fetches nothing,
 * which is the honest state of a repository that has not been given a release
 * key. A release is the moment the key becomes real, so this script reads the
 * public half from the UPDATE_SIGNING_PUBLIC_KEY repository secret, proves it
 * against the private half in UPDATE_SIGNING_KEY by signing a fixed challenge
 * and verifying it, and only then writes resources/update-trusted-keys.json for
 * `npm run dist` to compile in.
 *
 * The private half is read, used, and never written, printed, or logged. A
 * mismatch between the two secrets stops the release rather than shipping a
 * build whose own updater could never trust the manifests published beside it.
 *
 *   UPDATE_SIGNING_KEY=… UPDATE_SIGNING_PUBLIC_KEY=… npx tsx scripts/release-trusted-keys.ts inject
 *   UPDATE_SIGNING_PUBLIC_KEY=… npx tsx scripts/release-trusted-keys.ts check-injected
 *
 * `check-injected` is the other half of the release: it reads the key set back
 * the way a packaged build reads it and refuses a build that would ship with
 * nothing, or with a key that is not the one this release is signing with.
 *
 * Optional: UPDATE_SIGNING_KEY_ID (defaults to a name derived from the key
 * itself, so there is no second value to keep in step), UPDATE_SIGNING_KEY_VALID_FROM
 * and UPDATE_SIGNING_KEY_VALID_UNTIL (ISO-8601; the window an installed build
 * will verify a manifest in). `--out <path>` writes the key set somewhere other
 * than the file the build reads, for the publishing job to compare against.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fail, flag, parseFlags, readInjectedKeys } from './release-update-common'

/** A fixed string, so this proves a key pair rather than proving some key. */
const CHALLENGE = Buffer.from('git-stacks/release-update-key-pair/v1', 'utf8')
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/
const DEFAULT_VALID_FROM = '1970-01-01T00:00:00.000Z'

function secret(name: string, what: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    fail(
      `the ${name} repository secret is empty or missing, so ${what} cannot be done. This release stops here rather than shipping a build or a manifest nobody can verify.`,
    )
  }
  return value
}

/** The public half, read as a PEM SubjectPublicKeyInfo or as base64 DER. */
function publicKeyFromSecret(): Buffer {
  const secret = process.env.UPDATE_SIGNING_PUBLIC_KEY?.trim()
  if (!secret) {
    fail(
      'the UPDATE_SIGNING_PUBLIC_KEY repository secret is empty or missing, so this build would ship with no release update key and could never trust a manifest. This release stops here.',
    )
  }
  try {
    return createPublicKey(secret).export({ format: 'der', type: 'spki' })
  } catch {
    // Not PEM. It may be the base64 DER the app's key registry stores.
  }
  const der = Buffer.from(secret, 'base64')
  if (der.length === 0 || der.toString('base64').replace(/=+$/, '') !== secret.replace(/=+$/, '')) {
    fail(
      'the UPDATE_SIGNING_PUBLIC_KEY repository secret is neither a PEM public key nor base64 DER.',
    )
  }
  try {
    return createPublicKey({ key: der, format: 'der', type: 'spki' }).export({
      format: 'der',
      type: 'spki',
    })
  } catch {
    return fail('the UPDATE_SIGNING_PUBLIC_KEY repository secret is not a readable public key.')
  }
}

const flags = parseFlags(process.argv.slice(3))
const out = flag(flags, 'out', 'resources/update-trusted-keys.json')

/**
 * What a build of this release would actually trust. An empty set is the state
 * of the repository as committed, and it is a refused build, not a warning:
 * such a build reports its updates as not configured and can never verify a
 * manifest, so publishing beside it would ship installers no client of this
 * release could update from.
 */
function requireShippableKeySet(path: string): string {
  const keys = readInjectedKeys(path)
  if (keys.length === 0) {
    fail(
      `${path} names no key, so a build of this release would never verify a manifest. Injection did not run, or it wrote nothing this app can read.`,
    )
  }
  return keys
}

if (process.argv[2] === 'check-injected') {
  const shipped = requireShippableKeySet(out)
  const expected = publicKeyFromSecret()
  const named = process.env.UPDATE_SIGNING_KEY_ID?.trim()
  const matches = shipped.filter(
    (key) =>
      Buffer.from(key.publicKey, 'base64').equals(expected) &&
      (named === undefined || key.keyId === named),
  )
  if (matches.length !== 1) {
    fail(
      named === undefined
        ? `${out} does not carry the release key this job is signing with, so a build of it would refuse every manifest this release publishes.`
        : `${out} does not carry ${named}, the key this release signs with.`,
    )
  }
  const [key] = matches
  const trustedNow = Date.parse(key.validFrom) <= Date.now()
  if (!trustedNow) {
    fail(
      `${out} only trusts ${key.keyId} from ${key.validFrom}, so no build of this release could verify a manifest yet.`,
    )
  }
  if (key.validUntil !== null && Date.parse(key.validUntil) <= Date.now()) {
    fail(
      `${out} stopped trusting ${key.keyId} at ${key.validUntil}, which has passed. A release cannot ship a key its own builds will refuse.`,
    )
  }
  console.log(
    `release-update: ${out} carries ${key.keyId}, trusted from ${key.validFrom}${key.validUntil ? ` until ${key.validUntil}` : ' with no end date'}, and it is the key this release signs with.`,
  )
  process.exit(0)
}

if (process.argv[2] !== 'inject') {
  fail(
    'usage: release-trusted-keys.ts inject [--out <path>] | check-injected [--out <path>]. `inject` runs before `npm run dist` so the packaged build carries the key it will verify releases with; `check-injected` refuses a build that would ship without it.',
  )
}

const privateKey = createPrivateKey(secret('UPDATE_SIGNING_KEY', 'proving the release key pair'))
if (privateKey.asymmetricKeyType !== 'ed25519') {
  fail(
    `the UPDATE_SIGNING_KEY repository secret holds a ${privateKey.asymmetricKeyType} key; update manifests are signed with Ed25519.`,
  )
}
const declared = publicKeyFromSecret()
const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
if (!declared.equals(derived)) {
  fail(
    'UPDATE_SIGNING_PUBLIC_KEY is not the public half of UPDATE_SIGNING_KEY, so the build would be packaged with a key it can never verify a manifest with. Nothing is written; check that both secrets come from the same keypair.',
  )
}
// The pair check above compared bytes; this one proves the private half really
// signs what the public half verifies, which is the property the app relies on.
const challenge = sign(null, CHALLENGE, privateKey)
if (!verify(null, CHALLENGE, createPublicKey(privateKey), challenge)) {
  fail('the release keypair does not sign and verify its own challenge. Nothing is written.')
}

const keyId =
  process.env.UPDATE_SIGNING_KEY_ID?.trim() ||
  `release-${createHash('sha256').update(derived).digest('hex').slice(0, 16)}`
if (!KEY_ID.test(keyId)) fail(`${keyId} is not a key name this app can read.`)
const validFrom = process.env.UPDATE_SIGNING_KEY_VALID_FROM?.trim() || DEFAULT_VALID_FROM
if (Number.isNaN(Date.parse(validFrom)))
  fail(`UPDATE_SIGNING_KEY_VALID_FROM ${validFrom} is not a time.`)
const validUntil = process.env.UPDATE_SIGNING_KEY_VALID_UNTIL?.trim() || null
if (validUntil !== null && Number.isNaN(Date.parse(validUntil))) {
  fail(`UPDATE_SIGNING_KEY_VALID_UNTIL ${validUntil} is not a time.`)
}

const registry = {
  schema: 1,
  keys: [
    {
      keyId,
      publicKey: derived.toString('base64'),
      validFrom: new Date(Date.parse(validFrom)).toISOString(),
      validUntil: validUntil === null ? null : new Date(Date.parse(validUntil)).toISOString(),
    },
  ],
}
if (Date.parse(registry.keys[0].validFrom) > Date.now()) {
  fail(
    `${out} would trust ${keyId} from a time in the future, so no build of it could verify a manifest yet.`,
  )
}
writeFileSync(out, `${JSON.stringify(registry, null, 2)}\n`)

// Read the file back the way a packaged build reads it, so a key set this app
// would ignore never reaches a build.
const written = requireShippableKeySet(out)
if (written.length !== 1 || written[0].keyId !== keyId) {
  fail(
    `${out} was written but the app would not read ${keyId} out of it, so no build of this release could verify a manifest.`,
  )
}
console.log(
  `release-update: wrote ${out} with ${keyId}, trusted from ${registry.keys[0].validFrom}${validUntil ? ` until ${registry.keys[0].validUntil}` : ' with no end date'}. The key pair signed and verified its own challenge.`,
)
