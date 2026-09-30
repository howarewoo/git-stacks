#!/usr/bin/env -S npx tsx
/**
 * Publishes one channel's signed update feed, in an order a release can be
 * interrupted in without losing anything.
 *
 * The two assets a client fetches — `update-<channel>.json` and the signature
 * beside it — carry fixed names, so they are the one place on the moving release
 * where a publication overwrites what was there before. An upload that is
 * interrupted between them leaves a manifest with no signature, a signature with
 * no manifest, or the two describing different releases, and a reader that
 * treated that as an empty channel would mint sequence 1 over a history every
 * installed build has already spent. So the order here is:
 *
 *   1. bank this sequence — the manifest and its signature, written once under
 *      names derived from that sequence and never replaced;
 *   2. publish the installers this manifest names, each under a name that
 *      carries the version it was built from;
 *   3. move the two fixed names onto this release;
 *   4. read both back off the release and prove the signature over the bytes
 *      that are actually there.
 *
 * Nothing is deleted, and step 1 happens before anything is replaced: a run that
 * dies at any point leaves the previous release readable from its banked copy,
 * and the next run mints the next sequence and republishes the fixed names over
 * them. That is the whole point of the order — not that the upload is atomic,
 * which it is not, but that nothing a client needs is only ever reachable after
 * it exists somewhere immutable.
 *
 * An installer name the live manifest already binds to different bytes is
 * refused rather than replaced: a name is a URL an installation has already
 * fetched, and swapping the bytes behind it would break the manifest clients
 * are being offered right now.
 *
 *   npx tsx scripts/release-update-publish.ts --channel stable \
 *     --repo howarewoo/git-stacks --feed channel-feed --installers channel-assets
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  channelTagOf,
  fail,
  flag,
  historyFileName,
  historySignatureFileName,
  manifestFileName,
  openReleaseReader,
  parseFlags,
  proveManifestBytes,
  provePublishedAssets,
  publishedManifest,
  releaseLocation,
  requireChannel,
  signatureFileName,
  uploadReleaseAsset,
  type ReleaseReader,
} from './release-update-common'

const flags = parseFlags(process.argv.slice(2))
const channel = requireChannel(flag(flags, 'channel'))
const repo = flag(flags, 'repo')
const feedDir = flag(flags, 'feed')
const installerDir = flag(flags, 'installers')
const tag = channelTagOf(channel)
const fileName = manifestFileName(channel)
const signatureName = signatureFileName(channel)
const manifestPath = join(feedDir, fileName)
const signaturePath = join(feedDir, signatureName)
for (const path of [manifestPath, signaturePath]) {
  if (statSync(path, { throwIfNoEntry: false }) === undefined) {
    fail(
      `${path} is not on disk, so this release has nothing to publish. Sign and verify the manifest before publishing it.`,
    )
  }
}

const installers = readdirSync(installerDir).sort()
if (installers.length === 0)
  fail(`${installerDir} stages no installer, so this release publishes an empty feed.`)

/** A read of the release, and the directory it stages what it downloads into. */
const directory = mkdtempSync(join(tmpdir(), 'git-stacks-publish-'))
const release: ReleaseReader = openReleaseReader(channel, repo, directory)
const read = (name: string): Buffer | null => {
  try {
    return release.read(name)
  } catch (error) {
    fail(
      `the ${channel} feed on ${tag} could not be read, so this release cannot tell what it would replace. Nothing was published. The reader said: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
const upload = (path: string, clobber: boolean, what: string): void => {
  try {
    uploadReleaseAsset(tag, repo, path, clobber)
  } catch (error) {
    fail(
      `uploading ${what} to ${tag} failed, so this run stops here. Anything already uploaded stays: the sequence it banked is spent, and the next release reads that history and issues the sequence after it. The reader said: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  console.log(`release-update: ${basename(path)} is on ${tag}.`)
}

try {
  // The bytes go on a public release, so they are proved here rather than
  // assumed from the step that minted them: a signature a packaged build does
  // not carry is a manifest no client of this release could install.
  const { manifest, key } = proveManifestBytes(
    readFileSync(manifestPath),
    readFileSync(signaturePath),
    channel,
    manifestPath,
  )
  const sequence = manifest.sequence
  const published = publishedManifest(channel, repo, release)
  for (const artifact of manifest.artifacts) {
    const live = published?.artifacts.find((entry) => entry.fileName === artifact.fileName)
    if (live && live.sha256 !== artifact.sha256) {
      fail(
        `${artifact.fileName} is published under a name the live ${channel} manifest already binds to different bytes, so replacing it would break the release clients are being offered now. Publish this build under a name of its own.`,
      )
    }
  }
  const missing = manifest.artifacts
    .map((artifact) => artifact.fileName)
    .filter((name) => !installers.includes(name))
  if (missing.length > 0) {
    fail(`${installerDir} stages none of ${missing.join(', ')}, which this manifest names.`)
  }

  // Step 1. The sequence is banked under names of its own before anything is
  // replaced, so an interruption from here on cannot take a client's history
  // with it. A pair already banked here with these exact bytes is this same
  // publication, re-run, and is left alone; a different pair is a sequence
  // already spent, which no release may rewrite. Anything less than a pair — a
  // manifest with no signature beside it, or the reverse — is the residue of an
  // interrupted bank, which nothing ever authenticated, so writing both names
  // completes it rather than replacing history.
  const bankDir = mkdtempSync(join(tmpdir(), 'git-stacks-bank-'))
  const banked = [manifestPath, signaturePath].map((path, at) => {
    const name =
      at === 0 ? historyFileName(channel, sequence) : historySignatureFileName(channel, sequence)
    const staged = join(bankDir, name)
    copyFileSync(path, staged)
    return { name, path: staged }
  })
  const bankedManifest = read(banked[0].name)
  const bankedSignature = read(banked[1].name)
  if (bankedManifest !== null && bankedSignature !== null) {
    if (
      !bankedManifest.equals(readFileSync(banked[0].path)) ||
      !bankedSignature.equals(readFileSync(banked[1].path))
    ) {
      fail(
        `${banked[0].name} is already banked on ${tag} with different bytes, so ${channel} sequence ${sequence} was issued to a publication that did not complete. A sequence is spent once used, and no release may republish it. Mint the next sequence instead (--sequence), after checking what the banked manifest says.`,
      )
    }
    console.log(
      `release-update: ${channel} sequence ${sequence} is already banked on ${tag} with these exact bytes.`,
    )
  } else {
    console.log(
      `release-update: banking ${channel} sequence ${sequence} as ${banked[0].name} and its signature.`,
    )
    for (const entry of banked) upload(entry.path, true, entry.name)
  }
  rmSync(bankDir, { recursive: true, force: true })

  // Step 2. The installers the manifest names, each under the name the manifest
  // published it as. Those names carry the version they were built from, so a
  // name that is already on the release is this same version being republished.
  for (const name of installers) {
    upload(join(installerDir, name), true, name)
  }

  // Step 3. The two names a client fetches, moved onto this release. The
  // installers are in place first, then the manifest that names them, then the
  // signature that proves it — the feed is only ever complete once all of it is.
  upload(manifestPath, true, fileName)
  upload(signaturePath, true, signatureName)

  // Step 4. What is on the release, read back and proved. An upload this script
  // cannot confirm is an upload that may or may not have happened, and the only
  // honest answer to that is to read the bytes a client will fetch and verify
  // them with the key this release injected.
  const after = provePublishedAssets(read, fileName, signatureName, channel, tag)
  if (after.sequence !== sequence) {
    fail(
      `${tag} publishes ${channel} sequence ${after.sequence} after this release uploaded sequence ${sequence}. The banked history is intact, so re-run the release to put this manifest back on the channel.`,
    )
  }
  const feed = releaseLocation(channel)
  console.log(
    `release-update: published ${channel} ${manifest.version} sequence ${sequence}, signed with ${key.keyId}, at ${feed.origin}${feed.pathPrefix}.`,
  )
  console.log(
    `release-update: sequence ${sequence} is banked at ${banked[0].name} and is not rewritten; the live pair is replaced on every publication.`,
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
