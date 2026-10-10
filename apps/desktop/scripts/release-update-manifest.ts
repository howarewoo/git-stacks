/**
 * Builds the update manifest a channel publishes, from the installers this
 * release has just verified.
 *
 * Two commands:
 *
 *   describe  records what one runner produced, so the publishing job knows which
 *            platform and architecture each file is for without guessing from a
 *            file name.
 *   build     writes `update-<channel>.json` for one channel, stages the
 *            installers under the names that manifest will publish them as, and
 *            refuses to write anything the app itself would refuse.
 *
 * A manifest is issued, never edited in place: `build` gives it a sequence one
 * higher than any this channel has published, read back from the channel's own
 * release through the GitHub API, starting at 1 when the channel has published
 * nothing yet. An installation refuses a manifest older than the newest one it
 * has already considered, so reusing a sequence would make this release
 * invisible to everybody who has already seen the last one.
 *
 * A rollback is not a different kind of release, it is a release like any
 * other: pass the older `--version` and `--rollback-of <the version being
 * replaced>`. The sequence still rises, because the app refuses a silent
 * downgrade (a version that is not newer than the running build) and would
 * refuse a rollback that reused a sequence (a replay). `build` refuses a lower
 * version that does not name the version it rolls back, so a downgrade is
 * always an explicit, signed decision.
 *
 *   pnpm exec tsx scripts/release-update-manifest.ts describe \
 *     --platform darwin --arch arm64 --dir signed-release --out descriptors/darwin-arm64.json
 *
 *   pnpm exec tsx scripts/release-update-manifest.ts build \
 *     --channel stable --version 0.1.0 --descriptors descriptors \
 *     --artifact-dir signed-release --out-dir channel-feed --stage-dir channel-assets \
 *     --repo howarewoo/git-stacks [--notes '…'] [--rollback-of 0.0.9] [--sequence 4] \
 *     [--now 2026-01-01T00:00:00.000Z]
 */
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  MAX_UPDATE_MANIFEST_BYTES,
  UPDATE_MANIFEST_MAX_AGE_MS,
  UPDATE_MANIFEST_SCHEMA,
  compareVersions,
  expectedArtifactKind,
  evaluateUpdateManifest,
  parseUpdateManifest,
  parseVersion,
  type UpdateArchitecture,
  type UpdateArtifactKind,
  type UpdateChannel,
  type UpdateManifestArtifact,
  type UpdatePlatform,
} from '@git-stacks/shared/update'
import { isRecord } from '@git-stacks/shared/guards'
import {
  assetNameFor,
  channelTagOf,
  fail,
  flag,
  manifestFileName,
  parseFlags,
  publishedManifest,
  releaseLocation,
  requireArchitecture,
  requireChannel,
  requirePlatform,
  sha256Of,
  sizeOf,
  type PublishedManifest,
} from './release-update-common'

/**
 * The builds every published manifest must name. This is the release matrix:
 * an app that is offered a release with no build for its own platform refuses
 * it, so a manifest that lost one runner's installer must not go out.
 */
const REQUIRED_BUILDS: Record<string, true> = {
  'darwin-arm64': true,
  'darwin-x64': true,
  'win32-x64': true,
  'linux-x64': true,
}

/**
 * What each installer kind is written as. The kinds are the app's, the
 * extensions are electron-builder's, and the two do not line up by name: a
 * Windows `nsis` installer is an `.exe`. A file whose name does not match the
 * kind it is described as is a manifest that would offer the wrong installer.
 */
const KIND_EXTENSIONS: Record<UpdateArtifactKind, string> = {
  dmg: '.dmg',
  nsis: '.exe',
  AppImage: '.AppImage',
}

interface DescriptorFile {
  fileName: string
  assetName: string
}

interface Descriptor {
  platform: UpdatePlatform
  arch: UpdateArchitecture
  files: DescriptorFile[]
}

function describe(flags: Map<string, string>): void {
  const platform = requirePlatform(flag(flags, 'platform'))
  const arch = requireArchitecture(flag(flags, 'arch'))
  const directory = flag(flags, 'dir')
  const out = flag(flags, 'out')
  // The installers this project builds are exactly the ones electron-builder
  // writes for a kind below, so a kind added there is an installer this
  // records without a second extension list to keep in step.
  const files = readdirSync(directory)
    .filter((fileName) => Object.values(KIND_EXTENSIONS).includes(extname(fileName)))
    .sort()
    .map((fileName) => ({ fileName, assetName: assetNameFor(fileName) }))
  if (files.length === 0) fail(`${directory} holds no installer for ${platform} ${arch}.`)
  const descriptor: Descriptor = { platform, arch, files }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(descriptor, null, 2)}\n`)
  console.log(
    `release-update: recorded ${files.map((file) => file.assetName).join(', ')} for ${platform} ${arch}.`,
  )
}

function readDescriptors(directory: string): Descriptor[] {
  const descriptors: Descriptor[] = []
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith('.json')) continue
    const path = join(directory, entry)
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed)) fail(`${path} is not a descriptor object.`)
    const platform = requirePlatform(parsed.platform)
    const arch = requireArchitecture(parsed.arch)
    if (!Array.isArray(parsed.files)) fail(`${path} is not a descriptor this script wrote.`)
    const described: DescriptorFile[] = []
    for (const file of parsed.files) {
      if (
        !isRecord(file) ||
        typeof file.fileName !== 'string' ||
        typeof file.assetName !== 'string'
      ) {
        fail(`${path} has a file entry this script did not write.`)
      }
      described.push({ fileName: file.fileName, assetName: file.assetName })
    }
    descriptors.push({ platform, arch, files: described })
  }
  if (descriptors.length === 0) fail(`${directory} holds no descriptors.`)
  return descriptors
}

/**
 * The sequence this manifest is issued at: one past the highest this channel has
 * published, or one when it has published none. An operator may state a higher
 * floor with `--sequence`, which is how a channel recovers from a feed that was
 * repaired by hand; the floor is still checked against what is published, so it
 * can only ever move the counter up.
 */
function issueSequence(
  channel: UpdateChannel,
  published: PublishedManifest | null,
  stated: string | undefined,
): number {
  const highest = published ? published.sequence : 0
  if (stated === undefined) {
    console.log(`release-update: issuing ${channel} sequence ${highest + 1}.`)
    return highest + 1
  }
  const floor = Number(stated)
  if (!Number.isSafeInteger(floor) || floor < 1) fail(`--sequence ${stated} is not a sequence.`)
  if (floor <= highest) {
    fail(
      `--sequence ${floor} is not above the ${highest} this channel has already published. A sequence is never reused, so the release stops here rather than minting a replay.`,
    )
  }
  console.log(`release-update: issuing ${channel} sequence ${floor} (operator floor).`)
  return floor
}

/**
 * A version lower than the one the channel publishes is a rollback, and the app
 * will not act on a silent downgrade: the manifest has to name the version it
 * replaces. Both halves are checked here, so the signed manifest is never
 * published in a shape only a person could repair.
 */
function checkRollback(
  version: string,
  rollbackOf: string | undefined,
  publishedVersion: string | null,
  channel: UpdateChannel,
): void {
  if (rollbackOf !== undefined && parseVersion(rollbackOf) === null) {
    fail(`--rollback-of ${rollbackOf} is not a version.`)
  }
  if (publishedVersion === null) {
    if (rollbackOf !== undefined) {
      fail(
        `the ${channel} channel has published no manifest, so a release of ${version} cannot be a rollback.`,
      )
    }
    return
  }
  const order = compareVersions(version, publishedVersion)
  if (order >= 0) {
    if (rollbackOf !== undefined) {
      fail(
        `${version} is not older than the ${publishedVersion} this channel publishes, so it is not a rollback.`,
      )
    }
    return
  }
  if (rollbackOf === undefined) {
    fail(
      `${version} is older than the ${publishedVersion} this channel publishes. A downgrade must be an explicit release: pass --rollback-of ${publishedVersion} so the signed manifest says what it is replacing.`,
    )
  }
  if (rollbackOf !== publishedVersion) {
    fail(
      `--rollback-of ${rollbackOf} is not the ${publishedVersion} this channel publishes. A rollback names the version it is replacing.`,
    )
  }
  console.log(
    `release-update: ${version} rolls back the ${publishedVersion} on ${channel} at a higher sequence.`,
  )
}

function build(flags: Map<string, string>): void {
  const channel = requireChannel(flag(flags, 'channel'))
  const version = flag(flags, 'version')
  const descriptors = readDescriptors(flag(flags, 'descriptors'))
  const artifactDir = flag(flags, 'artifact-dir')
  const outDir = flag(flags, 'out-dir')
  const stageDir = flag(flags, 'stage-dir')
  const repo = flag(flags, 'repo')
  const rollbackOf = flags.get('rollback-of')
  const now = Date.parse(flag(flags, 'now', new Date().toISOString()))
  if (Number.isNaN(now)) fail('--now is not a time.')
  if (parseVersion(version) === null) fail(`${version} is not a version this updater can order.`)

  const published = publishedManifest(channel, repo)
  checkRollback(version, rollbackOf, published ? published.version : null, channel)
  const sequence = issueSequence(channel, published, flags.get('sequence'))

  const feed = releaseLocation(channel)
  const artifacts: UpdateManifestArtifact[] = []
  const names = new Set<string>()
  const builds = new Set<string>()
  for (const descriptor of descriptors) {
    const kind = expectedArtifactKind(descriptor.platform)
    if (kind === null) {
      fail(`${descriptor.platform} has no installer kind in the app, so it cannot be published.`)
    }
    builds.add(`${descriptor.platform}-${descriptor.arch}`)
    for (const file of descriptor.files) {
      if (extname(file.assetName).toLowerCase() !== KIND_EXTENSIONS[kind].toLowerCase()) {
        fail(
          `${file.assetName} is described as a ${descriptor.platform} ${kind}, which its file name does not look like.`,
        )
      }
      if (names.has(file.assetName)) {
        fail(
          `two installers both publish as ${file.assetName}; one build would overwrite the other.`,
        )
      }
      names.add(file.assetName)
      const path = join(artifactDir, file.fileName)
      if (statSync(path, { throwIfNoEntry: false }) === undefined) {
        fail(`${path} is named by a descriptor but was not published by this release.`)
      }
      const url = `${feed.origin}${feed.pathPrefix}${file.assetName}`
      artifacts.push({
        platform: descriptor.platform,
        arch: descriptor.arch,
        kind,
        fileName: file.assetName,
        url,
        sha256: sha256Of(path),
        size: sizeOf(path),
      })
    }
  }
  for (const build of Object.keys(REQUIRED_BUILDS)) {
    if (!builds.has(build))
      fail(`this release produced no ${build} build, so no manifest is published.`)
  }
  artifacts.sort((left, right) =>
    `${left.platform}${left.arch}`.localeCompare(`${right.platform}${right.arch}`),
  )

  const notes = flag(flags, 'notes', `Git Stacks ${version} (${channel}).`).slice(0, 4000)
  const issuedAt = new Date(now).toISOString()
  const expiresAt = new Date(now + UPDATE_MANIFEST_MAX_AGE_MS).toISOString()
  const manifest = {
    schema: UPDATE_MANIFEST_SCHEMA,
    channel,
    version,
    sequence,
    issuedAt,
    expiresAt,
    ...(rollbackOf === undefined ? {} : { rollbackOf }),
    notes,
    artifacts,
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // Everything the app would refuse is refused here, before the bytes are on a
  // release for the app to fetch and decline in front of whoever is updating.
  const parsed = parseUpdateManifest(bytes)
  if (!parsed.ok) {
    fail(
      `the manifest this script built is one the app refuses (${parsed.failure.reason}): ${parsed.failure.message}`,
    )
  }
  if (bytes.byteLength > MAX_UPDATE_MANIFEST_BYTES) {
    fail(
      `the manifest is ${bytes.byteLength} bytes, over the ${MAX_UPDATE_MANIFEST_BYTES} the app will read.`,
    )
  }
  for (const artifact of parsed.value.artifacts) {
    const offer = evaluateUpdateManifest(parsed.value, {
      channel,
      platform: artifact.platform,
      arch: artifact.arch,
      currentVersion: '0.0.0',
      seenSequence: 0,
      now,
      allowedOrigin: feed.origin,
      allowedPathPrefix: feed.pathPrefix,
    })
    if (!offer.ok) {
      fail(
        `the app would refuse the ${artifact.platform} ${artifact.arch} build in this manifest (${offer.failure.reason}): ${offer.failure.message}`,
      )
    }
  }

  mkdirSync(outDir, { recursive: true })
  mkdirSync(stageDir, { recursive: true })
  const outPath = join(outDir, manifestFileName(channel))
  writeFileSync(outPath, bytes)
  for (const descriptor of descriptors) {
    for (const file of descriptor.files) {
      const staged = join(stageDir, file.assetName)
      copyFileSync(join(artifactDir, file.fileName), staged)
      if (sha256Of(staged) !== sha256Of(join(artifactDir, file.fileName))) {
        fail(`${file.assetName} changed while it was being staged, so nothing is published.`)
      }
    }
  }
  console.log(
    `release-update: wrote ${outPath} — ${channel} ${version} sequence ${sequence}, ${artifacts.length} builds, ${bytes.byteLength} bytes.`,
  )
  console.log(
    `release-update: published as ${feed.origin}${feed.pathPrefix} on ${channelTagOf(channel)}.`,
  )
  console.log(
    `release-update: this manifest stops being offered at ${expiresAt}; publish another release to refresh it.`,
  )
  console.log(`release-update: installers staged under ${basename(stageDir)}/.`)
}

const command = process.argv[2]
const flags = parseFlags(process.argv.slice(3))
if (command === 'describe') describe(flags)
else if (command === 'build') build(flags)
else
  fail(
    `usage: release-update-manifest.ts <describe|build> [flags]. A rollback is a release of the older version with --rollback-of <the version it replaces>; its sequence still rises.`,
  )
