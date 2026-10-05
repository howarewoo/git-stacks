/**
 * Shared plumbing for the scripts that publish a signed update feed.
 *
 * Everything a manifest must satisfy is taken from the app's own modules rather
 * than restated here: the pinned release location comes from
 * `resolveUpdateFeed`, the shape from `parseUpdateManifest`, and the size
 * ceilings from the shared constants. A copy of those rules in a release script
 * is a second convention that can drift from the one the app enforces, so this
 * file reads them instead.
 *
 * A channel's fixed asset names are what a client fetches, which also makes
 * them what a publication interrupted part way through leaves half-replaced.
 * So every fact concluded here about a channel is read from every place that
 * fact is durably written, and no fact is concluded from an absence this file
 * cannot account for.
 */
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, verify, KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveUpdateFeed, type UpdateFeed } from '../src/main/update/feed'
import { isRecord } from '../src/shared/guards'
import {
  parseSignatureEnvelope,
  parseUpdateManifest,
  UPDATE_ARCHITECTURES,
  UPDATE_CHANNELS,
  UPDATE_PLATFORMS,
  type UpdateArchitecture,
  type UpdateChannel,
  type UpdateManifest,
  type UpdatePlatform,
} from '../src/shared/update'
import { type TrustedUpdateKey } from '../src/main/update/keys'
import { verifyDetachedSignature } from '../src/main/update/signature'

/**
 * A release script stops the release. It never continues with a guess.
 *
 * A typed constant rather than a function declaration, so that the check after
 * a `fail` is one the compiler narrows: every decision this file makes about
 * what a channel has published rests on there being no way past a stop.
 */
export const fail: (message: string) => never = (message) => {
  console.error(`release-update: ${message}`)
  process.exit(1)
}

function isChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly string[]).includes(value)
}

export function requireChannel(value: string): UpdateChannel {
  if (!isChannel(value)) fail(`${value} is not an update channel (${UPDATE_CHANNELS.join(', ')}).`)
  return value
}

export function requirePlatform(value: unknown): UpdatePlatform {
  if (typeof value !== 'string' || !(UPDATE_PLATFORMS as readonly string[]).includes(value)) {
    fail(`${String(value)} is not a platform this app builds an installer for.`)
  }
  return value as UpdatePlatform
}

export function requireArchitecture(value: unknown): UpdateArchitecture {
  if (typeof value !== 'string' || !(UPDATE_ARCHITECTURES as readonly string[]).includes(value)) {
    fail(`${String(value)} is not an architecture this app builds for.`)
  }
  return value as UpdateArchitecture
}

/** The file a packaged build reads its release keys from. */
export const INJECTED_KEY_SET_PATH = 'resources/update-trusted-keys.json'

/**
 * Every public key this repository has declared may sign a channel manifest.
 *
 * A build only ever carries the keys it needs now, so a key stops being one of
 * them when the rotation retires it — and a channel's history is full of
 * manifests that key signed. This file is the durable record of those keys, so
 * a release can still authenticate what it published last month without
 * shipping a dead key to every user. It holds public keys only, which is what a
 * packaged build already carries in its own bundle, and a key is committed here
 * before it signs anything: a release refuses to publish with a key this file
 * does not declare.
 */
export const HISTORY_KEY_SET_PATH = 'resources/update-history-keys.json'

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * The release keys a build was packaged with, read from the same file the
 * build reads, with the same rules `src/main/update/keys.ts` applies.
 *
 * The committed key set is empty by design — a build with no release key
 * trusts nothing and fetches nothing — so in a release run this file is what
 * the release's own key injection step wrote. Reading it here rather than
 * through `trustedUpdateKeys` keeps the release scripts honest about which key
 * they are about to trust, and lets them fail when nothing was injected.
 */
export function readInjectedKeys(path: string = INJECTED_KEY_SET_PATH): TrustedUpdateKey[] {
  return readKeySet(
    path,
    `${path} is missing, so this build carries no release key and no manifest it signs could be verified.`,
  )
}

/**
 * The public keys this repository has declared may sign a channel manifest.
 *
 * A repository that has not committed the file has declared no key, which is
 * the state the file itself starts in: the set is empty, and the release that
 * would need it is the one that stops.
 */
export function readHistoryKeys(path: string = HISTORY_KEY_SET_PATH): TrustedUpdateKey[] {
  if (existsSync(path) === false) return []
  return readKeySet(path, `${path} is not a key history this repository can be reviewed for.`)
}

/**
 * Every key this release may authenticate a published manifest with: the ones
 * this build was packaged with, and the ones the repository has declared
 * before. A build carries a key only while it is current, so without the
 * declared history a rotation's own retirement would make every manifest the
 * retired key signed unreadable — and the release that retired it would have no
 * way left to read what it was replacing. Two entries claiming one name with
 * different bytes are refused rather than resolved: a key set nobody can read
 * in one order is a key set nobody can reason about in any.
 */
function keysForPublishedHistory(): TrustedUpdateKey[] {
  const byKeyId = new Map<string, TrustedUpdateKey>()
  for (const key of [...readInjectedKeys(), ...readHistoryKeys()]) {
    const seen = byKeyId.get(key.keyId)
    if (seen === undefined) {
      byKeyId.set(key.keyId, key)
      continue
    }
    if (seen.publicKey !== key.publicKey) {
      fail(
        `${key.keyId} is declared twice with different public keys (${INJECTED_KEY_SET_PATH} and ${HISTORY_KEY_SET_PATH}), so no release can tell which of them a signature is from. One name is one key.`,
      )
    }
  }
  return [...byKeyId.values()]
}

function readKeySet(path: string, missing: string): TrustedUpdateKey[] {
  if (existsSync(path) === false) fail(missing)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed) || parsed.schema !== 1 || !Array.isArray(parsed.keys)) {
    fail(`${path} is not a key set this app can read.`)
  }
  const keys: TrustedUpdateKey[] = []
  for (const entry of parsed.keys) {
    if (
      !isRecord(entry) ||
      typeof entry.keyId !== 'string' ||
      !KEY_ID.test(entry.keyId) ||
      typeof entry.publicKey !== 'string' ||
      !BASE64.test(entry.publicKey) ||
      typeof entry.validFrom !== 'string' ||
      Number.isNaN(Date.parse(entry.validFrom)) ||
      !(
        entry.validUntil === null ||
        (typeof entry.validUntil === 'string' && !Number.isNaN(Date.parse(entry.validUntil)))
      )
    ) {
      fail(
        `${path} holds a key entry the app would ignore, which would leave a release no build could verify.`,
      )
    }
    keys.push({
      keyId: entry.keyId,
      publicKey: entry.publicKey,
      validFrom: entry.validFrom,
      validUntil: entry.validUntil === null ? null : String(entry.validUntil),
    })
  }
  return keys
}

/** The key set a release is signing with, or a stop before anything is signed. */
export function requireInjectedKey(): TrustedUpdateKey[] {
  const keys = readInjectedKeys()
  if (keys.length === 0) {
    fail(
      `${INJECTED_KEY_SET_PATH} holds no release key, so a build of this app would refuse every manifest this release could sign. Run the key injection step (scripts/release-trusted-keys.ts inject) with UPDATE_SIGNING_KEY and UPDATE_SIGNING_PUBLIC_KEY before packaging and signing.`,
    )
  }
  return keys
}

/**
 * The public half of a release key, as the bytes a key set stores it in.
 *
 * Every script that answers "is this the key the release signed with?" asks it
 * the same way, and an answer derived any other way would not be the answer the
 * key set was compared against.
 */
export function publicKeyBytesOf(key: Parameters<typeof createPublicKey>[0]): Buffer {
  const publicKey = key instanceof KeyObject && key.type === 'public' ? key : createPublicKey(key)
  return publicKey.export({ format: 'der', type: 'spki' })
}

/**
 * The private key a release signs with. Update manifests are signed with
 * Ed25519, and a secret holding any other kind of key is refused here rather
 * than producing a signature no build would verify.
 */
export function requireEd25519SigningKey(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') {
    fail(
      `the UPDATE_SIGNING_KEY repository secret holds a ${key.asymmetricKeyType} key; update manifests are signed with Ed25519.`,
    )
  }
  return key
}

/** The app's pinned release location for a channel, asked of the app itself. */
export function releaseLocation(channel: UpdateChannel): UpdateFeed {
  const feed = resolveUpdateFeed(channel, {}, true)
  if (!feed.ok) fail(`the app's own feed resolver refused ${channel}: ${feed.failure.message}`)
  return feed.value
}

/**
 * The moving release tag a channel's feed lives on, read back out of the feed
 * the app resolves. It is never written out by hand here, so a rename in
 * `src/main/update/feed.ts` moves the release with it.
 */
export function channelTagOf(channel: UpdateChannel): string {
  const feed = releaseLocation(channel)
  const prefix = new URL(feed.manifestUrl).pathname.replace(/[^/]+$/, '')
  const tag = prefix.slice(0, -1).split('/').pop()
  if (!tag) fail(`the ${channel} feed resolved to a path with no release tag in it.`)
  return tag
}

export function manifestFileName(channel: UpdateChannel): string {
  return new URL(releaseLocation(channel).manifestUrl).pathname.split('/').pop() ?? ''
}

export function signatureFileName(channel: UpdateChannel): string {
  return `${manifestFileName(channel)}.sig`
}

/**
 * A published asset name has to survive two checks the app makes: it must be a
 * plain file name, and the URL naming it must end in exactly that name. An
 * installer electron-builder writes as `Git Stacks-0.1.0-arm64.dmg` fails both
 * (a space is percent-encoded in a URL), so the channel release publishes each
 * build under a normalised name and the manifest names that one.
 */
export function assetNameFor(fileName: string): string {
  const normalized = fileName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(normalized)) {
    fail(`${fileName} has no publishable asset name (${normalized || 'empty'}).`)
  }
  return normalized
}

export function sizeOf(path: string): number {
  return statSync(path).size
}

export function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export interface PublishedManifest {
  sequence: number
  version: string
  /**
   * The installer names and digests the published manifest binds. A release
   * that republished one of these names with different bytes would break the
   * manifest clients are being offered right now, so the bytes behind a live
   * name are compared before they are replaced.
   */
  artifacts: readonly { fileName: string; sha256: string }[]
}

/**
 * How a published release is read: one named asset, and every name it carries.
 *
 * The bytes are the whole contract: everything this module concludes about a
 * channel's history is concluded from what a reader hands back, and `null` from
 * `read` means only that the release does not carry that name. Anything a
 * reader cannot deliver is thrown, and the release is stopped above rather
 * than reasoned about, so a reader that cannot tell the difference between
 * "absent" and "unreadable" cannot start a sequence over one it does not know.
 */
export interface ReleaseReader {
  read(name: string): Buffer | null
  list(): string[]
}

/**
 * A spent sequence, banked under a name of its own.
 *
 * The two assets a channel is read from carry fixed names, so a publication
 * that is interrupted while replacing them can leave the manifest, its
 * signature, or both missing. Every sequence a channel has issued is therefore
 * written once under a name derived from that sequence and never replaced, and
 * the history a release builds on is read from those names as well as from the
 * live pair. The live pair is what clients are offered, so it still wins
 * whenever it is the newest thing on the tag a trusted key signed.
 */
export function historyFileName(channel: UpdateChannel, sequence: number): string {
  return `history-${channel}-${String(sequence).padStart(12, '0')}.json`
}

export function historySignatureFileName(channel: UpdateChannel, sequence: number): string {
  return `${historyFileName(channel, sequence)}.sig`
}

/** The sequence a banked asset name carries, or null for any other name. */
function bankedSequenceOf(channel: UpdateChannel, name: string): number | null {
  const match = /^history-([a-z]+)-([0-9]{12})\.json$/u.exec(name)
  if (!match || match[1] !== channel) return null
  const sequence = Number(match[2])
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null
}

/**
 * Reads the history a channel has already published, through the GitHub API by
 * way of `gh`.
 *
 * Every publish only ever raises the sequence, so the highest sequence a
 * trusted key signed anywhere on the moving tag is the history this release has
 * to build on. It is read from the live pair of assets and from every sequence
 * banked under a name of its own, because the live pair is what a half-finished
 * publication replaces: a run interrupted between the two fixed-name uploads
 * can leave the manifest missing, the signature missing, or the two describing
 * different releases. Reading only those two names would see an empty channel
 * and mint sequence 1 over a history installations have already spent, which
 * every one of them is right to refuse for good.
 *
 * Only bytes a trusted key signed are read. An unsigned asset on the channel is
 * not evidence of anything: believing it would let a rewritten feed push the
 * next signed sequence below what installations have already seen, or hold a
 * release as an unauthorised downgrade. So an unreadable live pair is not
 * history either — but a banked copy of the same sequence that does verify is,
 * and that is what a failed publication leaves behind. With nothing banked to
 * read, an unreadable channel stops the release rather than being reasoned
 * about, and a channel that has published nothing at all is the one case that
 * is genuinely empty.
 *
 * `reader` is the only part that talks to anything. The default reads a
 * published release with `gh` into a directory of its own and is what every
 * release run uses; a caller with the bytes already in hand (a test) passes
 * them in, and gets the same decisions made about them.
 */
export function publishedManifest(
  channel: UpdateChannel,
  repo: string,
  reader?: ReleaseReader,
): PublishedManifest | null {
  const fileName = manifestFileName(channel)
  const signatureName = signatureFileName(channel)
  const tag = channelTagOf(channel)
  const directory = mkdtempSync(join(tmpdir(), 'git-stacks-published-feed-'))
  const release = reader ?? openReleaseReader(channel, repo, directory)
  const read = (name: string): Buffer | null => {
    try {
      return release.read(name)
    } catch (error) {
      fail(
        `the ${channel} feed on ${tag} could not be read, so the sequence this channel has already issued is unknown and no manifest can be minted safely. This release publishes nothing. The reader said: ${readFailure(error)}`,
      )
    }
  }
  try {
    let names: string[]
    try {
      names = release.list()
    } catch (error) {
      fail(
        `the assets the ${channel} feed on ${tag} publishes could not be listed, so the sequences this channel has already issued are unknown and no manifest can be minted safely. This release publishes nothing. The reader said: ${readFailure(error)}`,
      )
    }
    const live = readPublishedPair(read, fileName, signatureName, channel, tag)
    const histories: PublishedManifest[] = live.facts === null ? [] : [live.facts]
    for (const sequence of bankedSequences(names, channel)) {
      const banked = readPublishedPair(
        read,
        historyFileName(channel, sequence),
        historySignatureFileName(channel, sequence),
        channel,
        tag,
      )
      if (banked.facts === null) {
        fail(
          `the ${channel} feed on ${tag} banks ${historyFileName(channel, sequence)} and its signature, and what is there cannot be read: ${banked.reason} A banked sequence is never rewritten or removed, so this channel's history is a question for a person rather than something this release may route around.`,
        )
      }
      histories.push(banked.facts)
    }
    if (histories.length === 0) {
      if (live.reason !== null) fail(live.reason)
      console.log(`release-update: ${channel} has no published ${fileName} yet.`)
      return null
    }
    const newest = histories.reduce((left, right) =>
      right.sequence > left.sequence ? right : left,
    )
    if (newest.sequence === (live.facts?.sequence ?? -1)) {
      console.log(
        `release-update: ${channel} currently publishes version ${newest.version} at sequence ${newest.sequence}.`,
      )
    } else {
      console.log(
        `release-update: the ${channel} feed on ${tag} does not currently publish sequence ${newest.sequence} — ${
          live.facts === null
            ? `it publishes no ${fileName} and signature that can be read (${live.reason})`
            : `the live ${fileName} and its signature prove an older manifest, at sequence ${live.facts.sequence}`
        }. The sequence this release issues is read from the signed history banked at ${historyFileName(channel, newest.sequence)}, and this release republishes the live pair.`,
      )
    }
    return newest
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** The sequences a release carries a complete banked pair for, oldest first. */
function bankedSequences(names: readonly string[], channel: UpdateChannel): number[] {
  const complete = new Set<number>()
  for (const name of names) {
    const sequence = bankedSequenceOf(channel, name)
    if (sequence !== null && names.includes(historySignatureFileName(channel, sequence))) {
      complete.add(sequence)
    }
  }
  return [...complete].sort((left, right) => left - right)
}

/**
 * The sequence and version one signed, published manifest recorded, with the
 * installer names and digests it binds.
 */
function publishedFacts(manifest: UpdateManifest): PublishedManifest {
  return {
    sequence: manifest.sequence,
    version: manifest.version,
    artifacts: manifest.artifacts.map((artifact) => ({
      fileName: artifact.fileName,
      sha256: artifact.sha256,
    })),
  }
}

/**
 * One published manifest and the signature beside it, as two answers: the
 * facts its signed bytes record, or the reason they cannot be read. The
 * distinction is the whole point: a caller that cannot tell "not published"
 * from "published but unreadable" would restart a sequence over a history it
 * has not read, which is a replay every installed build is right to refuse.
 */
interface PublishedPair {
  facts: PublishedManifest | null
  reason: string | null
}

const NOT_PUBLISHED: PublishedPair = { facts: null, reason: null }

function unreadable(reason: string): PublishedPair {
  return { facts: null, reason }
}

function readPublishedPair(
  read: (name: string) => Buffer | null,
  fileName: string,
  signatureName: string,
  channel: UpdateChannel,
  tag: string,
): PublishedPair {
  const bytes = read(fileName)
  const detached = read(signatureName)
  if (bytes === null && detached === null) return NOT_PUBLISHED
  if (bytes === null) {
    return unreadable(
      `the ${channel} feed on ${tag} publishes a signature with no manifest beside it. Repair the channel by hand before releasing; this run will not mint a sequence over an unknown history.`,
    )
  }
  if (detached === null) {
    return unreadable(
      `the ${channel} feed on ${tag} publishes ${fileName} with no signature beside it, so its sequence and version cannot be believed. A release that cannot read its own history does not publish.`,
    )
  }
  return verifyPublishedManifest(bytes, detached, channel, tag)
}

/**
 * Re-reads a published pair and proves it, or the release stops. This is the
 * last gate a publication passes through: what is on the release afterwards is
 * what this run meant to publish, or the release carries bytes nothing can
 * authenticate.
 */
export function provePublishedAssets(
  read: (name: string) => Buffer | null,
  fileName: string,
  signatureName: string,
  channel: UpdateChannel,
  tag: string,
): PublishedManifest {
  const pair = readPublishedPair(read, fileName, signatureName, channel, tag)
  if (pair.reason !== null) fail(pair.reason)
  if (pair.facts === null) {
    fail(
      `the ${channel} feed on ${tag} publishes neither ${fileName} nor its signature after this release uploaded both, so the channel carries nothing clients can read. The signed copy banked under this sequence is intact, so re-run the release to republish it.`,
    )
  }
  return pair.facts
}

/**
 * A manifest and detached signature that this release may publish: the
 * signature names a key the packaged builds carry, that key is inside its own
 * validity window, it signed these exact bytes, and the manifest is one the app
 * parses for this channel.
 */
interface ProvenManifest {
  manifest: UpdateManifest
  /** The key that signed it, out of the set the packaged builds carry. */
  key: TrustedUpdateKey
  /** Every key those builds carry, so a caller can name the overlap. */
  trusted: TrustedUpdateKey[]
}

/**
 * Proves a manifest and the detached signature beside it on disk, the way the
 * app will read both: the envelope is parsed, the key it names is looked up in
 * the set this release packaged into the app, and the signature is checked over
 * the manifest's exact bytes. One implementation, because a publication that
 * proved its own bytes by a second set of rules would be proving the rules
 * rather than the release.
 */
export function proveManifestBytes(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  channel: UpdateChannel,
  manifestPath: string,
): ProvenManifest {
  const envelope = parseSignatureEnvelope(signatureBytes)
  if (!envelope.ok) {
    fail(
      `the signature envelope is one the app refuses (${envelope.failure.reason}): ${envelope.failure.message}`,
    )
  }
  const trusted = requireInjectedKey()
  const key = trusted.find((entry) => entry.keyId === envelope.value.keyId)
  if (!key) {
    fail(
      `the manifest is signed by ${envelope.value.keyId}, which is not a key this release packaged into the app (${trusted.map((entry) => entry.keyId).join(', ')}). Nothing is published.`,
    )
  }
  if (!verifyDetachedSignature(key, manifestBytes, envelope.value.signature, Date.now())) {
    fail(`${manifestPath} is not signed by the release key ${key.keyId}. Nothing is published.`)
  }
  const manifest = parseUpdateManifest(manifestBytes)
  if (!manifest.ok) {
    fail(
      `the manifest is one the app refuses (${manifest.failure.reason}): ${manifest.failure.message}`,
    )
  }
  if (manifest.value.channel !== channel) {
    fail(
      `the manifest publishes the ${manifest.value.channel} channel and is being published as ${channel}.`,
    )
  }
  return { manifest: manifest.value, key, trusted }
}

/**
 * A published release, read with `gh` through the paths this module asks it
 * for. The caller owns `directory`, which is where the bytes this reader hands
 * back are staged.
 */
export function openReleaseReader(
  channel: UpdateChannel,
  repo: string,
  directory: string,
): ReleaseReader {
  return {
    read: (name: string): Buffer | null => downloadReleaseAsset(name, channel, repo, directory),
    list: (): string[] => listReleaseAssets(channel, repo),
  }
}

/**
 * Every asset name a published release carries.
 *
 * A release that does not exist yet is the one absence that means anything here:
 * there is no tag, so there is nothing on it, and a channel that has never been
 * published starts at sequence 1. Every other failure is thrown, so a rate
 * limit or a dead network cannot be read as a channel with no history.
 */
function listReleaseAssets(channel: UpdateChannel, repo: string): string[] {
  const tag = channelTagOf(channel)
  let listed: string
  try {
    listed = execFileSync(
      'gh',
      ['release', 'view', tag, '--repo', repo, '--json', 'assets', '--jq', '.assets[].name'],
      { stdio: 'pipe', encoding: 'utf8' },
    )
  } catch (error) {
    if (absentFromRelease(error, tag, tag)) {
      console.log(`release-update: ${tag} has no release yet.`)
      return []
    }
    throw error
  }
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Publishes one file to a release, with `gh`.
 *
 * `gh` is named as it is on PATH on purpose: this runs in a release job, where
 * it is the tool that authenticated the API call, and a different `gh` found
 * through a different search is a different tool. A failure is thrown rather
 * than swallowed, because an upload this cannot confirm is an upload that may
 * or may not have happened — the caller decides what that means for the
 * release, and the bytes already published are not rolled back here.
 */
export function uploadReleaseAsset(
  tag: string,
  repo: string,
  path: string,
  clobber: boolean,
): void {
  const args = ['release', 'upload', tag, path, '--repo', repo]
  if (clobber) args.push('--clobber')
  execFileSync('gh', args, { stdio: 'pipe' })
}

/**
 * One asset off a published release, with `gh`, into a directory this call
 * owns.
 *
 * `gh` is named as it is on PATH on purpose: this runs in a release job, where
 * it is the tool that authenticated the API call, and a different `gh` found
 * through a different search is a different tool. What is refused here is a
 * release that does not carry the name: an unreadable one is thrown, so it stops
 * the release where the decision is made.
 */
function downloadReleaseAsset(
  name: string,
  channel: UpdateChannel,
  repo: string,
  directory: string,
): Buffer | null {
  const tag = channelTagOf(channel)
  try {
    execFileSync(
      'gh',
      [
        'release',
        'download',
        tag,
        '--repo',
        repo,
        '--pattern',
        name,
        '--dir',
        directory,
        '--clobber',
      ],
      { stdio: 'pipe' },
    )
  } catch (error) {
    if (absentFromRelease(error, name, tag)) return null
    throw error
  }
  return readFileSync(join(directory, name))
}

/**
 * Proves a published manifest is the one a trusted release key signed, before
 * any of it is used. A key whose own validity window has passed is still
 * honoured for history it signed while it was valid: a key is retired by
 * rotating forward, not by making the releases it already made unreadable.
 *
 * This answers rather than stops, because the caller has to be able to look
 * past a pair it cannot believe: a channel whose live assets are unreadable
 * is a channel whose banked history still has to be read, while the same pair
 * read back after a publication has to be fatal.
 */
function verifyPublishedManifest(
  bytes: Buffer,
  detached: Buffer,
  channel: UpdateChannel,
  tag: string,
): PublishedPair {
  let envelope: unknown
  try {
    envelope = JSON.parse(detached.toString('utf8'))
  } catch {
    return unreadable(
      `the ${channel} signature on ${tag} is not JSON, so the manifest beside it cannot be believed.`,
    )
  }
  if (
    !isRecord(envelope) ||
    typeof envelope.signature !== 'string' ||
    typeof envelope.keyId !== 'string'
  ) {
    return unreadable(
      `the ${channel} signature on ${tag} names no key, so the manifest beside it cannot be believed.`,
    )
  }
  const key = Buffer.from(envelope.signature, 'base64').toString('base64')
  const trusted = keysForPublishedHistory()
  const named = trusted.find((candidate) => candidate.keyId === envelope.keyId)
  if (!named) {
    return unreadable(
      `the ${channel} feed on ${tag} was signed by ${envelope.keyId}, which this release does not trust: it is neither a key this build was packaged with nor one ${HISTORY_KEY_SET_PATH} declares. Trusting it would let a rewritten feed move the channel's sequence backwards.`,
    )
  }
  const publicKey = createPublicKey({
    key: Buffer.from(named.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
  if (!verify(null, bytes, publicKey, Buffer.from(key, 'base64'))) {
    return unreadable(
      `the ${channel} manifest on ${tag} does not match the signature beside it, so the history this release would build on is not the history that was published.`,
    )
  }
  if (Date.parse(named.validFrom) > Date.now()) {
    return unreadable(
      `${named.keyId} is not trusted until ${named.validFrom}, so it cannot have signed what ${tag} publishes.`,
    )
  }
  // The bytes are authenticated, and the manifest is then read the way the app
  // reads one: the same parser, the same rules. A validly signed manifest for
  // another channel is still a real document that has no business describing
  // this channel's history — a beta manifest copied beside the stable one would
  // otherwise move the stable sequence and leave every stable install holding a
  // release it can never accept again. A manifest that has since expired is
  // still the truth about what this channel issued: expiry says a feed should
  // be refreshed, not that the sequence it used never happened.
  const parsed = parseUpdateManifest(bytes)
  if (!parsed.ok) {
    return unreadable(
      `the ${channel} feed on ${tag} publishes a manifest signed by ${named.keyId} that the app itself would refuse (${parsed.failure.reason}), so this release will not mint a sequence over a history it cannot read: ${parsed.failure.message}`,
    )
  }
  if (parsed.value.channel !== channel) {
    return unreadable(
      `the ${channel} feed on ${tag} publishes a ${parsed.value.channel} manifest. A manifest signed for one channel is not evidence about another; repair this channel by hand before releasing.`,
    )
  }
  console.log(`release-update: ${tag} publishes a ${channel} manifest signed by ${named.keyId}.`)
  return { facts: publishedFacts(parsed.value), reason: null }
}

export function absentFromRelease(error: unknown, fileName: string, tag: string): boolean {
  const said = readFailure(error)
  return (
    /release not found/iu.test(said) ||
    new RegExp(`no release assets? (?:found )?matching|failed to find release asset`, 'iu').test(
      said,
    ) ||
    new RegExp(`(?:no|not) .*(?:asset|file).*(?:${escapeRegExp(fileName)})`, 'iu').test(said) ||
    (new RegExp(`404|not found`, 'iu').test(said) && said.includes(tag))
  )
}

/** What a failing process said, however it failed. */
function readFailure(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const failure = error as { stderr?: unknown; message?: unknown; stdout?: unknown }
    return [failure.stderr, failure.stdout, failure.message]
      .map((part) =>
        typeof part === 'string' ? part : Buffer.isBuffer(part) ? part.toString('utf8') : '',
      )
      .join(' ')
      .trim()
  }
  return String(error)
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Parses `--name value`, `--name=value` and bare `--name` flags. */
export function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) fail(`${token} is not a --flag.`)
    const equals = token.indexOf('=')
    if (equals !== -1) {
      flags.set(token.slice(2, equals), token.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(token.slice(2), 'true')
      continue
    }
    flags.set(token.slice(2), next)
    index += 1
  }
  return flags
}

export function flag(flags: Map<string, string>, name: string, fallback?: string): string {
  const value = flags.get(name)
  if (value === undefined) {
    if (fallback !== undefined) return fallback
    return fail(`--${name} is required.`)
  }
  return value
}
