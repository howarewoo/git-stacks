/**
 * Re-reads a channel's published manifest and signature from disk and proves
 * them, before either goes on a release an app will fetch.
 *
 * A release must not publish a manifest that does not verify, and a manifest
 * that verifies is not enough on its own: it also has to describe the installer
 * bytes that will actually be served, at the size and digest it names. This
 * script re-hashes every staged artifact, and it does the checking with the
 * app's own `parseUpdateManifest`, `parseSignatureEnvelope` and
 * `verifyDetachedSignature` rather than with a copy of their rules.
 *
 * The signature is checked against the release key this build was packaged
 * with, read from `resources/update-trusted-keys.json` and handed to the app's
 * own `verifyDetachedSignature` directly — the committed key set is empty by
 * design, so a packaged build trusts exactly the key the release injected, and
 * this script proves the release's manifest against that one. When
 * UPDATE_SIGNING_KEY is in the environment it also derives the public half from
 * that secret and requires it to be the same key, so the bytes are proved to
 * have been signed by the key this release holds rather than by some key the
 * build once trusted. One repository secret is the design here rather than a
 * second public-key secret: a second secret is another thing to rotate, and a
 * pair that disagreed would fail the release for a reason nobody could fix
 * from the log.
 *
 *   pnpm exec tsx scripts/release-update-verify.ts --channel stable \
 *     --manifest channel-feed/update-stable.json --artifact-dir channel-assets
 */
import { createPrivateKey } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { evaluateUpdateManifest } from '@git-stacks/shared/update'
import {
  fail,
  flag,
  manifestFileName,
  parseFlags,
  proveManifestBytes,
  publicKeyBytesOf,
  requireChannel,
  releaseLocation,
  sha256Of,
  signatureFileName,
  sizeOf,
} from './release-update-common'

const flags = parseFlags(process.argv.slice(2))
const channel = requireChannel(flag(flags, 'channel'))
const manifestPath = flag(flags, 'manifest')
const signaturePath = flag(
  flags,
  'signature',
  join(dirname(manifestPath), signatureFileName(channel)),
)
const artifactDir = flag(flags, 'artifact-dir')
if (manifestPath.split('/').pop() !== manifestFileName(channel)) {
  fail(`${manifestPath} is not the ${channel} manifest (${manifestFileName(channel)}).`)
}
if (signaturePath.split('/').pop() !== signatureFileName(channel)) {
  fail(`${signaturePath} is not the ${channel} signature (${signatureFileName(channel)}).`)
}

const manifestBytes = readFileSync(manifestPath)
const signatureBytes = readFileSync(signaturePath)

// The app parses the envelope, finds the key it names, and verifies the exact
// bytes it fetched. This is that path, in the same order, and it is the same
// code the publishing script runs before it puts these bytes on a release.
const { manifest, key, trusted } = proveManifestBytes(
  manifestBytes,
  signatureBytes,
  channel,
  manifestPath,
)
if (trusted.length > 1) {
  console.log(
    `release-update: the builds this release packages trust ${trusted.map((entry) => entry.keyId).join(', ')}; this manifest is signed with ${key.keyId}. A key added to a build is added before it signs anything, so an installed app can verify the release that carries it.`,
  )
}
const secret = process.env.UPDATE_SIGNING_KEY?.trim()
if (secret) {
  let publicKey
  try {
    publicKey = publicKeyBytesOf(createPrivateKey(secret))
  } catch {
    fail(
      'UPDATE_SIGNING_KEY is present but is not a readable private key, so this release cannot be checked against the key that was meant to sign it.',
    )
  }
  const derived = publicKey.toString('base64')
  if (derived !== key.publicKey) {
    fail(
      `the committed key ${key.keyId} is not the key in UPDATE_SIGNING_KEY, so the signature was made with a key this release does not hold. Nothing is published.`,
    )
  }
  console.log(`release-update: ${key.keyId} is the public half of UPDATE_SIGNING_KEY.`)
} else {
  console.log(
    'release-update: UPDATE_SIGNING_KEY is not in this job, so the signature was checked against the committed key alone.',
  )
}
const feed = releaseLocation(channel)
for (const artifact of manifest.artifacts) {
  const offer = evaluateUpdateManifest(manifest, {
    channel,
    platform: artifact.platform,
    arch: artifact.arch,
    currentVersion: '0.0.0',
    seenSequence: 0,
    now: Date.now(),
    allowedOrigin: feed.origin,
    allowedPathPrefix: feed.pathPrefix,
  })
  if (!offer.ok) {
    fail(
      `this app would refuse the ${artifact.platform} ${artifact.arch} build in this manifest (${offer.failure.reason}): ${offer.failure.message}`,
    )
  }
  const path = join(artifactDir, artifact.fileName)
  if (statSync(path, { throwIfNoEntry: false }) === undefined) {
    fail(`${path} is named by the manifest but is not staged for publication.`)
  }
  const size = sizeOf(path)
  if (size !== artifact.size) {
    fail(`${path} is ${size} bytes; the manifest says ${artifact.size}.`)
  }
  const sha256 = sha256Of(path)
  if (sha256 !== artifact.sha256) {
    fail(`${path} hashes to ${sha256}; the manifest says ${artifact.sha256}.`)
  }
  console.log(
    `release-update: ${artifact.fileName} — ${artifact.platform} ${artifact.arch} ${artifact.kind}, ${size} bytes, ${sha256.slice(0, 16)}… verified.`,
  )
}
console.log(
  `release-update: ${channel} ${manifest.version} sequence ${manifest.sequence} is signed by ${key.keyId} and every build it names verifies.`,
)
