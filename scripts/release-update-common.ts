/**
 * Shared plumbing for the three scripts that publish a signed update feed.
 *
 * Everything a manifest must satisfy is taken from the app's own modules rather
 * than restated here: the pinned release location comes from
 * `resolveUpdateFeed`, the shape from `parseUpdateManifest`, and the size
 * ceilings from the shared constants. A copy of those rules in a release script
 * is a second convention that can drift from the one the app enforces, so this
 * file reads them instead.
 */
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveUpdateFeed, type UpdateFeed } from '../src/main/update/feed'
import { isRecord } from '../src/shared/guards'
import { type TrustedUpdateKey } from '../src/main/update/keys'
import {
  UPDATE_ARCHITECTURES,
  UPDATE_CHANNELS,
  UPDATE_PLATFORMS,
  type UpdateArchitecture,
  type UpdateChannel,
  type UpdatePlatform,
} from '../src/shared/update'

/** A release script stops the release. It never continues with a guess. */
export function fail(message: string): never {
  console.error(`release-update: ${message}`)
  process.exit(1)
}

export function isChannel(value: string): value is UpdateChannel {
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
  if (existsSync(path) === false) {
    fail(
      `${path} is missing, so this build carries no release key and no manifest it signs could be verified.`,
    )
  }
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
}

/**
 * Reads the manifest a channel currently publishes, through the GitHub API by
 * way of `gh`.
 *
 * Every publish only ever raises the sequence, so the manifest now on the moving
 * tag is the highest sequence the channel has ever issued. A manifest that is
 * published but unreadable is a problem for a person to look at, not something
 * to route around: restarting the count at 1 would mint a sequence this channel
 * has already used, which is a replay the app is right to refuse.
 */
export function publishedManifest(channel: UpdateChannel, repo: string): PublishedManifest | null {
  const fileName = manifestFileName(channel)
  const signatureName = signatureFileName(channel)
  const tag = channelTagOf(channel)
  const directory = mkdtempSync(join(tmpdir(), 'git-stacks-published-feed-'))
  const fetch = (name: string): Buffer | null => {
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
      fail(
        `the ${channel} feed on ${tag} could not be read, so the sequence this channel has already issued is unknown and no manifest can be minted safely. This release publishes nothing. The reader said: ${readFailure(error)}`,
      )
    }
    return readFileSync(join(directory, name))
  }
  try {
    const bytes = fetch(fileName)
    if (bytes === null) {
      // Absent, and only absent: anything that failed to be read stopped the
      // release above rather than arriving here.
      if (fetch(signatureName) !== null) {
        fail(
          `the ${channel} feed on ${tag} publishes a signature with no manifest beside it. Repair the channel by hand before releasing; this run will not mint a sequence over an unknown history.`,
        )
      }
      console.log(`release-update: ${channel} has no published ${fileName} yet.`)
      return null
    }
    const detached = fetch(signatureName)
    if (detached === null) {
      fail(
        `the ${channel} feed on ${tag} publishes ${fileName} with no signature beside it, so its sequence and version cannot be believed. A release that cannot read its own history does not publish.`,
      )
    }
    // The history is only read from bytes this release's own key proves. An
    // unsigned asset on the channel is not evidence of anything: believing it
    // would let a rewritten feed push the next signed sequence below what
    // installations have already seen, which no install could ever accept
    // again, or hold a release as an unauthorised downgrade.
    //
    // A manifest that has since expired is still the truth about what this
    // channel issued: expiry says a feed should be refreshed, not that the
    // sequence it used never happened. What matters here is that the signature
    // over these exact bytes verifies against a key this release trusts.
    verifyDetachedSignature(bytes, detached, channel, tag)
    return readPublishedManifest(bytes, channel, tag)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * Proves a published manifest is the one a trusted release key signed, before
 * any of it is used. A key whose own validity window has passed is still
 * honoured for history it signed while it was valid: a key is retired by
 * rotating forward, not by making the releases it already made unreadable.
 */
function verifyDetachedSignature(
  bytes: Buffer,
  detached: Buffer,
  channel: UpdateChannel,
  tag: string,
): void {
  let envelope: unknown
  try {
    envelope = JSON.parse(detached.toString('utf8'))
  } catch {
    fail(
      `the ${channel} signature on ${tag} is not JSON, so the manifest beside it cannot be believed.`,
    )
  }
  if (
    !isRecord(envelope) ||
    typeof envelope.signature !== 'string' ||
    typeof envelope.keyId !== 'string'
  ) {
    fail(
      `the ${channel} signature on ${tag} names no key, so the manifest beside it cannot be believed.`,
    )
  }
  let key: string
  try {
    key = Buffer.from(envelope.signature, 'base64').toString('base64')
  } catch {
    fail(`the ${channel} signature on ${tag} is not a signature this app can read.`)
  }
  const trusted = readInjectedKeys()
  const named = trusted.find((candidate) => candidate.keyId === envelope.keyId)
  if (!named) {
    fail(
      `the ${channel} feed on ${tag} was signed by ${envelope.keyId}, which this release does not trust, so its history is not read. Trusting it would let a rewritten feed move the channel's sequence backwards.`,
    )
  }
  const publicKey = createPublicKey({
    key: Buffer.from(named.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const ok = verify(null, bytes, createPublicKey(publicKey), Buffer.from(key, 'base64'))
  if (!ok) {
    fail(
      `the ${channel} manifest on ${tag} does not match the signature beside it, so the history this release would build on is not the history that was published.`,
    )
  }
  const issuedAt = named.validFrom
  if (Date.parse(issuedAt) > Date.now()) {
    fail(
      `${named.keyId} is not trusted until ${issuedAt}, so it cannot have signed what ${tag} publishes.`,
    )
  }
  console.log(`release-update: ${tag} publishes a manifest signed by ${named.keyId}.`)
}

/** The sequence and version a signed, published manifest recorded. */
function readPublishedManifest(
  bytes: Buffer,
  channel: UpdateChannel,
  tag: string,
): PublishedManifest {
  const fileName = manifestFileName(channel)
  let published: unknown
  try {
    published = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(
      `the ${channel} feed on ${tag} holds a ${fileName} that is not JSON, so the sequence it used cannot be known. Repair or remove that asset by hand before releasing.`,
    )
  }
  if (typeof published !== 'object' || published === null) {
    fail(`the ${channel} feed on ${tag} holds a ${fileName} that is not an object.`)
  }
  const fields = published as Record<string, unknown>
  const sequence = fields.sequence
  const version = fields.version
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
    fail(
      `the ${channel} feed on ${tag} holds a ${fileName} with no usable sequence, so the next one cannot be issued safely. Repair or remove that asset by hand before releasing.`,
    )
  }
  if (typeof version !== 'string') {
    fail(`the ${channel} feed on ${tag} holds a ${fileName} with no version.`)
  }
  console.log(
    `release-update: ${channel} currently publishes version ${version} at sequence ${sequence}.`,
  )
  return { sequence, version }
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
