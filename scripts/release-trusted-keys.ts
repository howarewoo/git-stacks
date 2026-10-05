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
 *
 * A rotation is a shipped change, not a switch, and it takes three releases:
 * the key that is leaving is the one that signs, the key that is arriving
 * rides along in the same build, and only the release after that one signs
 * with the arriving key. So a build may be told to trust one more key than it
 * signs with — the overlap — through UPDATE_SIGNING_ADDITIONAL_KEY_ID,
 * UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY, UPDATE_SIGNING_ADDITIONAL_VALID_FROM
 * and UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL. Declaring any of them declares
 * all of them: a half-declared overlap is the one state this refuses, because
 * it is indistinguishable from no rotation at all, and the release that meant
 * to introduce a key would ship without it.
 *
 * The manifest this release publishes is signed with UPDATE_SIGNING_KEY, which
 * is never the additional key. That is the order a rotation depends on: an
 * installed app only trusts the key inside its own bundle, so a key has to
 * reach a build in one release before it can sign the next one. Introducing
 * and signing with the same key is what a manifest signed by a key no
 * installed client carries looks like, and it is why these are two values
 * rather than one.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  fail,
  flag,
  HISTORY_KEY_SET_PATH,
  INJECTED_KEY_SET_PATH,
  parseFlags,
  publicKeyBytesOf,
  readHistoryKeys,
  readInjectedKeys,
  requireEd25519SigningKey,
} from './release-update-common'

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

/**
 * One public half, read as a PEM SubjectPublicKeyInfo or as base64 DER.
 *
 * `missing` says what an absent secret costs, because it is not the same thing
 * for both keys a build can carry: no release key at all is a build that can
 * never verify a manifest, and a missing additional key is a rotation that
 * ships a build which never learns the key it was meant to introduce.
 */
function publicKeyFrom(value: string | undefined, name: string, missing: string): Buffer {
  const secret = value?.trim()
  if (!secret) {
    fail(
      `the ${name} repository secret is empty or missing, so ${missing} This release stops here.`,
    )
  }
  try {
    return publicKeyBytesOf(createPublicKey(secret))
  } catch {
    // Not PEM. It may be the base64 DER the app's key registry stores.
  }
  const der = Buffer.from(secret, 'base64')
  if (der.length === 0 || der.toString('base64').replace(/=+$/, '') !== secret.replace(/=+$/, '')) {
    fail(`the ${name} repository secret is neither a PEM public key nor base64 DER.`)
  }
  try {
    return publicKeyBytesOf({ key: der, format: 'der', type: 'spki' })
  } catch {
    return fail(`the ${name} repository secret is not a readable public key.`)
  }
}

function releasePublicKey(): Buffer {
  return publicKeyFrom(
    process.env.UPDATE_SIGNING_PUBLIC_KEY,
    'UPDATE_SIGNING_PUBLIC_KEY',
    'this build would ship with no release update key and could never trust a manifest.',
  )
}

/**
 * The key a rotation is introducing, if this release is introducing one.
 *
 * All four values or none: a build that trusted the new key only in some of the
 * places that describe it is a build nobody can reason about afterwards, and it
 * is exactly what a half-finished rotation looks like. Refusing here is what
 * makes a partial rotation impossible to publish rather than merely unlikely.
 */
function additionalTrustedKey(): {
  keyId: string
  publicKey: Buffer
  validFrom: string
  validUntil: string
} | null {
  const declared = [
    'UPDATE_SIGNING_ADDITIONAL_KEY_ID',
    'UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY',
    'UPDATE_SIGNING_ADDITIONAL_VALID_FROM',
    'UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL',
  ].filter((name) => (process.env[name] ?? '').trim() !== '')
  if (declared.length === 0) return null
  const absent = [
    'UPDATE_SIGNING_ADDITIONAL_KEY_ID',
    'UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY',
    'UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL',
  ].filter((name) => !declared.includes(name))
  if (absent.length > 0) {
    fail(
      `a rotation was declared with ${declared.join(', ')} but not with ${absent.join(', ')}, so this build would carry a key set nobody can read. A rotation is all four values or none: without the key id the app cannot look the key up, and without an end date a key nobody retires would be trusted by every build that ever shipped it.`,
    )
  }
  const keyId = process.env.UPDATE_SIGNING_ADDITIONAL_KEY_ID?.trim() ?? ''
  if (!KEY_ID.test(keyId)) fail(`${keyId} is not a key name this app can read.`)
  const publicKey = publicKeyFrom(
    process.env.UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY,
    'UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY',
    'the rotation this release is introducing would reach no build, and the release after this one would sign with a key no installed app trusts.',
  )
  if (
    createPublicKey({ key: publicKey, format: 'der', type: 'spki' }).asymmetricKeyType !== 'ed25519'
  ) {
    fail(
      'UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY is not an Ed25519 public key; update manifests are signed with Ed25519.',
    )
  }
  const validFrom = instantOf('UPDATE_SIGNING_ADDITIONAL_VALID_FROM', DEFAULT_VALID_FROM)
  const validUntil = instantOf('UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL', '')
  if (Date.parse(validFrom) > Date.now()) {
    fail(
      `${keyId} would only be trusted from ${validFrom}, so the builds this release packages cannot verify anything with it yet, and the release meant to introduce it would carry a key it has no use for.`,
    )
  }
  if (Date.parse(validUntil) <= Date.parse(validFrom)) {
    fail(
      `${keyId} is trusted from ${validFrom} until ${validUntil}, a window that has already closed, so no build would ever consult it.`,
    )
  }
  if (Date.parse(validUntil) <= Date.now()) {
    fail(
      `${keyId} stopped being trusted at ${validUntil}, which has passed, so every build carrying it would hold a key the app never consults. Give the overlap a window that has not closed, or drop the rotation from this release.`,
    )
  }
  return { keyId, publicKey, validFrom, validUntil }
}

/** An ISO-8601 instant, or a stop: a key set the app cannot order is not read. */
function instantOf(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback
  if (Number.isNaN(Date.parse(value))) fail(`${name} ${value} is not a time.`)
  return new Date(Date.parse(value)).toISOString()
}

const command = process.argv[2]
const flags = parseFlags(process.argv.slice(3))
const out = flag(flags, 'out', INJECTED_KEY_SET_PATH)

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

if (command === 'check-injected') {
  const shipped = requireShippableKeySet(out)
  const expected = releasePublicKey()
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
  // A rotation is only carried by a build that has both halves of it: the key
  // this release signs with, and the key it is introducing for the release
  // after. A build missing the second one is not a bridge release, it is the
  // release before the rotation, and the next one would then sign with a key no
  // installed app trusts.
  const introduced = additionalTrustedKey()
  const carried =
    introduced === null
      ? []
      : shipped.filter(
          (entry) =>
            entry.keyId === introduced.keyId &&
            Buffer.from(entry.publicKey, 'base64').equals(introduced.publicKey),
        )
  if (introduced !== null && carried.length !== 1) {
    fail(
      `${out} does not carry ${introduced.keyId}, the key this release introduces for the next one, so a build of this release would refuse every manifest signed with it. This release signs with ${key.keyId}, so nothing is lost by shipping without the rotation — but a release that declares one has to carry it.`,
    )
  }
  console.log(
    `release-update: ${out} carries ${key.keyId}, trusted from ${key.validFrom}${key.validUntil ? ` until ${key.validUntil}` : ' with no end date'}, and it is the key this release signs with.`,
  )
  if (introduced !== null) {
    console.log(
      `release-update: it also carries ${introduced.keyId}, trusted from ${introduced.validFrom} until ${introduced.validUntil}. A build is given a key before that key signs anything, so this release's manifest is signed with ${key.keyId} and the next one may be signed with ${introduced.keyId}.`,
    )
  }

  // A key that this build carries and the repository does not declare is a
  // release that cannot be read back later. The moment a rotation retires it,
  // no build carries it any more, and the manifests it signed become
  // unauthenticatable — which stops the release that retired it, with the
  // channel unable to publish anything at all. So the declaration is made
  // before the key signs, in a change anyone can read: the public half of a key
  // a packaged build already carries is not a secret.
  const declared = readHistoryKeys()
  for (const key of shipped) {
    const published = declared.find((entry) => entry.keyId === key.keyId)
    if (published === undefined) {
      fail(
        `${out} carries ${key.keyId}, which ${HISTORY_KEY_SET_PATH} does not declare. Add its public key there and open a release for it: once this key is retired no build will carry it, and the manifests it signed could not be authenticated again, which would stop the channel. The key belongs in that file before it signs anything, in the same change that introduces it.`,
      )
    }
    if (published.publicKey !== key.publicKey) {
      fail(
        `${HISTORY_KEY_SET_PATH} declares ${key.keyId} with a different public key than ${out} carries, so a signature naming that name could mean either key and neither can be believed. One name is one key.`,
      )
    }
  }
  process.exit(0)
}

if (command !== 'inject') {
  fail(
    'usage: release-trusted-keys.ts inject [--out <path>] | check-injected [--out <path>]. `inject` runs before `npm run dist` so the packaged build carries the key it will verify releases with; `check-injected` refuses a build that would ship without it.',
  )
}

const privateKey = requireEd25519SigningKey(
  createPrivateKey(secret('UPDATE_SIGNING_KEY', 'proving the release key pair')),
)
const declared = releasePublicKey()
const derived = publicKeyBytesOf(privateKey)
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
const validFrom = instantOf('UPDATE_SIGNING_KEY_VALID_FROM', DEFAULT_VALID_FROM)
const validUntil = process.env.UPDATE_SIGNING_KEY_VALID_UNTIL?.trim()
  ? instantOf('UPDATE_SIGNING_KEY_VALID_UNTIL', '')
  : null

// The key this release is introducing, if it is introducing one. It is
// validated against the signing key here as well as in its own right: a build
// that carried the same key twice under one name, or under two names the app
// would look up ambiguously, is a rotation nobody can read afterwards.
const introduced = additionalTrustedKey()
if (introduced !== null) {
  if (introduced.keyId === keyId) {
    fail(
      `${keyId} is both the key this release signs with and the key it introduces, so this release is not a bridge release at all: an installed app would only be able to verify it after it had already been published. Introduce the key in a release that signs with the one before it.`,
    )
  }
  if (introduced.publicKey.equals(derived)) {
    fail(
      `the key introduced as ${introduced.keyId} is the key this release signs with, under a second name. A build reads a key by name, so this would ship two names for one key and no new key at all.`,
    )
  }
}

const registry = {
  schema: 1,
  keys: [
    {
      keyId,
      publicKey: derived.toString('base64'),
      validFrom,
      validUntil,
    },
    ...(introduced === null
      ? []
      : [
          {
            keyId: introduced.keyId,
            publicKey: introduced.publicKey.toString('base64'),
            validFrom: introduced.validFrom,
            validUntil: introduced.validUntil,
          },
        ]),
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
const readable = written.filter((key) => key.keyId === keyId)
if (readable.length !== 1) {
  fail(
    `${out} was written but the app would not read ${keyId} out of it, so no build of this release could verify a manifest.`,
  )
}
if (
  introduced !== null &&
  !written.some(
    (key) =>
      key.keyId === introduced.keyId &&
      Buffer.from(key.publicKey, 'base64').equals(introduced.publicKey),
  )
) {
  fail(
    `${out} was written but the app would not read ${introduced.keyId} out of it, so the rotation this release introduces would reach no build and the release after this one would sign with a key no installed app trusts.`,
  )
}
console.log(
  `release-update: wrote ${out} with ${keyId}, trusted from ${registry.keys[0].validFrom}${registry.keys[0].validUntil ? ` until ${registry.keys[0].validUntil}` : ' with no end date'}. The key pair signed and verified its own challenge.`,
)
if (introduced !== null) {
  console.log(
    `release-update: it also carries ${introduced.keyId}, trusted from ${introduced.validFrom} until ${introduced.validUntil}. This release signs with ${keyId}; the next one may sign with ${introduced.keyId}, because a build that is already installed is what will verify it.`,
  )
}
