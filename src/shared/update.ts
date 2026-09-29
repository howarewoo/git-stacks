/**
 * The update feed's contract, shared by the main process that authenticates it
 * and the renderer that reports it.
 *
 * Nothing here performs I/O or cryptography: the rules for what a signed
 * manifest may say are pure, so they can be stated once and tested without a
 * network. The signature itself is verified in the main process, before any
 * value from a manifest is used for a URL, a file, or an action.
 */
import { isRecord } from './guards'

export const UPDATE_CHANNELS = ['stable', 'beta'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export const UPDATE_PLATFORMS = ['darwin', 'win32', 'linux'] as const
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number]

export const UPDATE_ARCHITECTURES = ['arm64', 'x64'] as const
export type UpdateArchitecture = (typeof UPDATE_ARCHITECTURES)[number]

/** What kind of installer an artifact is, decided by the platform it is for. */
export const UPDATE_ARTIFACT_KINDS = ['dmg', 'nsis', 'AppImage'] as const
export type UpdateArtifactKind = (typeof UPDATE_ARTIFACT_KINDS)[number]

export const UPDATE_MANIFEST_SCHEMA = 1
export const UPDATE_SIGNATURE_SCHEMA = 1
/** A manifest is a few kilobytes. Anything larger is refused unread. */
export const MAX_UPDATE_MANIFEST_BYTES = 256 * 1024
/** A signature is a 64-byte Ed25519 signature plus a short envelope. */
export const MAX_UPDATE_SIGNATURE_BYTES = 4 * 1024
/** A generous ceiling for a desktop installer; larger is refused unread. */
export const MAX_UPDATE_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
/** A manifest stays offerable for this long after it was issued. */
export const UPDATE_MANIFEST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Clock skew tolerated on a manifest's issued/expiry stamps. */
export const UPDATE_CLOCK_SKEW_MS = 15 * 60 * 1000
export const UPDATE_FETCH_TIMEOUT_MS = 20 * 1000
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
/** Redirects are followed only inside the same pinned release location. */
export const MAX_UPDATE_REDIRECTS = 2

/**
 * Where a release's own code is expected to come from. A manifest is signed,
 * so this is defence in depth rather than the trust anchor: it stops a signed
 * manifest from pointing the updater at a third party's server even if one is
 * ever produced.
 */
export const RELEASE_LOCATION_ORIGIN = 'https://github.com'
export const RELEASE_LOCATION_PATH_PREFIX = '/howarewoo/git-stacks/releases/download/'

/**
 * The only hosts a release download may be redirected to. GitHub serves a
 * release asset from its own asset host, and the updater names that host
 * exactly rather than following any HTTPS address: a redirect is not
 * permission to fetch from somewhere else, and the signed digest is what
 * makes the bytes themselves safe.
 */
export const RELEASE_ASSET_HOSTS = ['release-assets.githubusercontent.com'] as const

/**
 * A release manifest as published. Every field is required: a field the app
 * does not understand is a field it cannot check, so an unexpected key is a
 * refusal rather than something to ignore.
 */
export interface UpdateManifest {
  schema: typeof UPDATE_MANIFEST_SCHEMA
  channel: UpdateChannel
  version: string
  /**
   * A per-channel counter that only ever increases. A manifest whose sequence
   * has already been seen is a replay of metadata this installation already
   * considered, and is refused even if every other field matches.
   */
  sequence: number
  /** ISO-8601 UTC. */
  issuedAt: string
  /** ISO-8601 UTC. A manifest past this instant is not offered. */
  expiresAt: string
  /** The release this one supersedes, when it is an authorised rollback. */
  /**
   * The newer release this one is an authorised replacement for. Absent, or
   * null, means this release is not a rollback and must be newer than the
   * running build.
   */
  rollbackOf?: string | null
  notes: string
  artifacts: UpdateManifestArtifact[]
}

/** One installable build for one platform and architecture. */
export interface UpdateManifestArtifact {
  platform: UpdatePlatform
  arch: UpdateArchitecture
  kind: UpdateArtifactKind
  fileName: string
  /** Absolute HTTPS URL on the pinned release location. */
  url: string
  /** Lowercase hex SHA-256 of the artifact bytes. */
  sha256: string
  size: number
}

/** The detached signature published beside a manifest. */
export interface UpdateSignatureEnvelope {
  schema: typeof UPDATE_SIGNATURE_SCHEMA
  keyId: string
  /** Base64 Ed25519 signature over the manifest's exact bytes. */
  signature: string
}

/** Why a manifest was refused, named so the Settings surface can be honest. */
export type UpdateRejection =
  | 'not-configured'
  | 'unreachable'
  | 'oversize'
  | 'bad-signature'
  | 'unknown-key'
  | 'malformed'
  | 'schema'
  | 'channel'
  | 'platform'
  | 'malformed-url'
  | 'expired'
  | 'issued-in-future'
  | 'not-newer'
  | 'replayed'

export interface UpdateRejectionReport {
  reason: UpdateRejection
  message: string
}

export class UpdateRefusal extends Error {
  readonly reason: UpdateRejection

  constructor(reason: UpdateRejection, message: string) {
    super(message)
    this.name = 'UpdateRefusal'
    this.reason = reason
  }
}

export type UpdateOutcome<T> =
  { ok: true; value: T } | { ok: false; failure: UpdateRejectionReport }

/** What the updater is doing, and what it last concluded. */
export type UpdatePhase =
  | 'idle'
  | 'not-configured'
  | 'unsupported'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'failed'
  | 'cancelled'

export interface UpdateOffer {
  channel: UpdateChannel
  version: string
  sequence: number
  notes: string
  /** Set when this release is an authorised rollback of an earlier version. */
  rollbackOf: string | null
  platform: UpdatePlatform
  arch: UpdateArchitecture
  kind: UpdateArtifactKind
  fileName: string
  size: number
  sha256: string
}

export interface UpdateStatus {
  phase: UpdatePhase
  /** The signed release this build offers, once one has been authenticated. */
  offer: UpdateOffer | null
  /** Why the last attempt ended, named for the surface to show. */
  failure: UpdateRejectionReport | null
  /** 0-100 while downloading, otherwise null. */
  progress: number | null
  /** This build's version, for the surface to state rather than assume. */
  currentVersion: string
  /** The channel in use, from Settings. */
  channel: UpdateChannel
  /** True when this platform has an install path at all. */
  supported: boolean
  /**
   * Where the trusted keys came from. 'release' is the pinned key set compiled
   * into this build; 'development' is a key supplied by a test fixture and is
   * only ever honoured by an unpackaged build.
   */
  trust: 'release' | 'development' | 'none'
  /** True once an update is staged and can be installed. */
  readyToInstall: boolean
  /** True once the app has handed the update to the platform installer. */
  restartRequired: boolean
}

/**
 * Whether a parsed document carries only the fields this build knows. An
 * unexpected field is refused rather than ignored: a field this code does not
 * check is a field a forger could use.
 */
function closedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

const HEX_256 = /^[0-9a-f]{64}$/

/**
 * A version this updater can order. Only a plain `major.minor.patch` with an
 * optional `-prerelease` is accepted, so two builds can never be compared with
 * an invented ordering for a shape nobody agreed on.
 */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

interface ParsedVersion {
  core: [number, number, number]
  prerelease: string[]
}

export function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null
  const match = VERSION.exec(value)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/**
 * Orders two versions, most recent first when the result is positive. A
 * prerelease sorts below the release it precedes, which is what keeps a beta
 * build from being offered as newer than the stable build it leads to.
 */
export function compareVersions(left: unknown, right: unknown): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index] - b.core[index]
    if (difference !== 0) return difference
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumber = /^\d+$/.test(left) ? Number(left) : null
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber
      continue
    }
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

function parseArtifact(value: unknown): UpdateManifestArtifact | string {
  if (!isRecord(value)) return 'an artifact entry is not an object'
  if (!closedKeys(value, ['platform', 'arch', 'kind', 'fileName', 'url', 'sha256', 'size'])) {
    return 'an artifact entry carries a field the updater does not understand'
  }
  if (!UPDATE_PLATFORMS.includes(value.platform as UpdatePlatform)) {
    return 'an artifact names a platform this app is not built for'
  }
  if (!UPDATE_ARCHITECTURES.includes(value.arch as UpdateArchitecture)) {
    return 'an artifact names an architecture this app is not built for'
  }
  if (!UPDATE_ARTIFACT_KINDS.includes(value.kind as UpdateArtifactKind)) {
    return 'an artifact names an installer kind this app does not install'
  }
  if (typeof value.fileName !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.fileName)) {
    return 'an artifact file name is not a plain file name'
  }
  if (typeof value.url !== 'string' || value.url.length > 2048) {
    return 'an artifact URL is missing or implausibly long'
  }
  if (typeof value.sha256 !== 'string' || !HEX_256.test(value.sha256)) {
    return 'an artifact digest is not a SHA-256 hex digest'
  }
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) {
    return 'an artifact size is not a whole number of bytes'
  }
  if (value.size > MAX_UPDATE_ARTIFACT_BYTES) {
    return 'an artifact is larger than this updater will download'
  }
  return {
    platform: value.platform as UpdatePlatform,
    arch: value.arch as UpdateArchitecture,
    kind: value.kind as UpdateArtifactKind,
    fileName: value.fileName,
    url: value.url,
    sha256: value.sha256,
    size: value.size,
  }
}

const MANIFEST_KEYS = [
  'schema',
  'channel',
  'version',
  'sequence',
  'issuedAt',
  'expiresAt',
  'rollbackOf',
  'notes',
  'artifacts',
]

/**
 * Turns published bytes into a manifest, or names why they were refused. The
 * shape is closed: an unknown field is refused rather than ignored, because a
 * field this code does not check is a field a forger could use.
 */
export function parseUpdateManifest(bytes: Uint8Array): UpdateOutcome<UpdateManifest> {
  if (bytes.byteLength > MAX_UPDATE_MANIFEST_BYTES) {
    return {
      ok: false,
      failure: { reason: 'oversize', message: 'The update manifest is larger than expected.' },
    }
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update manifest is not valid JSON.' },
    }
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update manifest is not an object.' },
    }
  }
  if (!closedKeys(value, MANIFEST_KEYS)) {
    return {
      ok: false,
      failure: {
        reason: 'schema',
        message: 'The update manifest carries a field this build does not understand.',
      },
    }
  }
  if (value.schema !== UPDATE_MANIFEST_SCHEMA) {
    return {
      ok: false,
      failure: {
        reason: 'schema',
        message: 'The update manifest uses a format this build does not understand.',
      },
    }
  }
  if (!UPDATE_CHANNELS.includes(value.channel as UpdateChannel)) {
    return {
      ok: false,
      failure: { reason: 'channel', message: 'The update manifest names an unknown channel.' },
    }
  }
  if (!parseVersion(value.version)) {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update manifest names no usable version.' },
    }
  }
  if (
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1
  ) {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update manifest carries no release sequence.' },
    }
  }
  if (typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update manifest carries no usable dates.' },
    }
  }
  const issuedAt = Date.parse(value.issuedAt)
  const expiresAt = Date.parse(value.expiresAt)
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update manifest carries no usable dates.' },
    }
  }
  if (expiresAt <= issuedAt) {
    return {
      ok: false,
      failure: {
        reason: 'malformed',
        message: 'The update manifest expires before it was issued.',
      },
    }
  }
  // `null` says outright that this release is not a rollback; any other value
  // has to be a version this build can read.
  if (
    value.rollbackOf !== undefined &&
    value.rollbackOf !== null &&
    !parseVersion(value.rollbackOf)
  ) {
    return {
      ok: false,
      failure: {
        reason: 'malformed',
        message: 'The update manifest names no usable rollback version.',
      },
    }
  }
  if (typeof value.notes !== 'string' || value.notes.length > 4000) {
    return {
      ok: false,
      failure: {
        reason: 'malformed',
        message: 'The update manifest carries no usable release notes.',
      },
    }
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length === 0 ||
    value.artifacts.length > 32
  ) {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update manifest lists no installable builds.' },
    }
  }
  const artifacts: UpdateManifestArtifact[] = []
  const seen = new Set<string>()
  for (const entry of value.artifacts) {
    const artifact = parseArtifact(entry)
    if (typeof artifact === 'string') {
      return { ok: false, failure: { reason: 'malformed', message: artifact } }
    }
    const identity = `${artifact.platform}-${artifact.arch}`
    if (seen.has(identity)) {
      return {
        ok: false,
        failure: {
          reason: 'malformed',
          message: 'The update manifest lists two builds for one platform.',
        },
      }
    }
    seen.add(identity)
    artifacts.push(artifact)
  }
  return {
    ok: true,
    value: {
      schema: UPDATE_MANIFEST_SCHEMA,
      channel: value.channel as UpdateChannel,
      version: String(value.version),
      sequence: value.sequence,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      ...(typeof value.rollbackOf === 'string' ? { rollbackOf: value.rollbackOf } : {}),
      notes: value.notes,
      artifacts,
    },
  }
}

/** Parses the detached signature envelope. Its own shape is closed too. */
export function parseSignatureEnvelope(bytes: Uint8Array): UpdateOutcome<UpdateSignatureEnvelope> {
  if (bytes.byteLength > MAX_UPDATE_SIGNATURE_BYTES) {
    return {
      ok: false,
      failure: { reason: 'oversize', message: 'The update signature is larger than expected.' },
    }
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update signature is not valid JSON.' },
    }
  }
  if (
    !isRecord(value) ||
    !closedKeys(value, ['schema', 'keyId', 'signature']) ||
    value.schema !== UPDATE_SIGNATURE_SCHEMA ||
    typeof value.keyId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(value.keyId) ||
    typeof value.signature !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature)
  ) {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'The update signature is not a usable envelope.' },
    }
  }
  return {
    ok: true,
    value: {
      schema: UPDATE_SIGNATURE_SCHEMA,
      keyId: value.keyId,
      signature: value.signature,
    },
  }
}

/** What this installation is, before the feed's own location rules apply. */
export interface UpdateEnvironment {
  channel: UpdateChannel
  platform: UpdatePlatform
  arch: UpdateArchitecture
  currentVersion: string
  /**
   * The highest release sequence already offered on this channel. A manifest
   * at that sequence is the same release this computer has already seen, so it
   * is offered again rather than refused: an offer that was never taken must
   * not become impossible. Anything below it is refused.
   */
  seenSequence: number
  now?: number
}

export type UpdateExpectations = Omit<UpdateEnvironment, 'now'> & {
  now: number
  /** The location a manifest's artifact URLs must resolve inside. */
  allowedOrigin: string
  allowedPathPrefix: string
}

/**
 * Applies every rule a signed manifest must still satisfy before it becomes an
 * offer. The signature has already been checked by the time this runs; this is
 * the part that decides whether *this* machine should act on it.
 */
export function evaluateUpdateManifest(
  manifest: UpdateManifest,
  expectations: UpdateExpectations,
): UpdateOutcome<UpdateManifestArtifact> {
  if (manifest.channel !== expectations.channel) {
    return {
      ok: false,
      failure: {
        reason: 'channel',
        message: `This manifest publishes the ${manifest.channel} channel, not ${expectations.channel}.`,
      },
    }
  }
  const issuedAt = Date.parse(manifest.issuedAt)
  const expiresAt = Date.parse(manifest.expiresAt)
  if (expiresAt <= expectations.now) {
    return {
      ok: false,
      failure: { reason: 'expired', message: 'This update offer has expired.' },
    }
  }
  if (issuedAt - UPDATE_CLOCK_SKEW_MS > expectations.now) {
    return {
      ok: false,
      failure: { reason: 'issued-in-future', message: 'This update offer is dated in the future.' },
    }
  }
  if (expectations.now - issuedAt > UPDATE_MANIFEST_MAX_AGE_MS + UPDATE_CLOCK_SKEW_MS) {
    return {
      ok: false,
      failure: { reason: 'expired', message: 'This update offer is too old to be trusted.' },
    }
  }
  if (manifest.sequence < expectations.seenSequence) {
    return {
      ok: false,
      failure: {
        reason: 'replayed',
        message:
          'This offer is older than one already considered here. A rollback is a new signed release with a higher sequence.',
      },
    }
  }
  const artifact = manifest.artifacts.find(
    (entry) => entry.platform === expectations.platform && entry.arch === expectations.arch,
  )
  if (!artifact) {
    return {
      ok: false,
      failure: {
        reason: 'platform',
        message: `This release has no build for ${expectations.platform} ${expectations.arch}.`,
      },
    }
  }
  if (compareVersions(manifest.version, expectations.currentVersion) <= 0) {
    // A rollback is allowed to be older, and only when the signed release names
    // the exact build this computer is running as the one it replaces, and is
    // older than that. A manifest that merely happens to be older is a
    // downgrade, and one that names a release this build is not running is not
    // a rollback this build has any business taking.
    const replaces = manifest.rollbackOf
    if (
      replaces === null ||
      compareVersions(replaces, expectations.currentVersion) !== 0 ||
      compareVersions(manifest.version, replaces) >= 0
    ) {
      return {
        ok: false,
        failure: {
          reason: 'not-newer',
          message: `Version ${manifest.version} is not newer than the installed ${expectations.currentVersion}, and no signed release authorises rolling back to it.`,
        },
      }
    }
  }
  let url: URL
  try {
    url = new URL(artifact.url)
  } catch {
    return {
      ok: false,
      failure: { reason: 'malformed-url', message: 'An artifact URL could not be read.' },
    }
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    return {
      ok: false,
      failure: {
        reason: 'malformed-url',
        message: 'An artifact URL is not a plain HTTPS address.',
      },
    }
  }
  if (url.origin !== expectations.allowedOrigin) {
    return {
      ok: false,
      failure: {
        reason: 'malformed-url',
        message: 'An artifact is not published on this project\u2019s release location.',
      },
    }
  }
  if (!url.pathname.startsWith(expectations.allowedPathPrefix)) {
    return {
      ok: false,
      failure: {
        reason: 'malformed-url',
        message: 'An artifact is not published under this project\u2019s release path.',
      },
    }
  }
  if (!url.pathname.endsWith(`/${artifact.fileName}`)) {
    return {
      ok: false,
      failure: {
        reason: 'malformed-url',
        message: 'An artifact URL does not name the file the manifest describes.',
      },
    }
  }
  return { ok: true, value: artifact }
}

/** The offer the Settings surface and the renderer are shown. */
export function toUpdateOffer(
  manifest: UpdateManifest,
  artifact: UpdateManifestArtifact,
): UpdateOffer {
  return {
    channel: manifest.channel,
    version: manifest.version,
    sequence: manifest.sequence,
    notes: manifest.notes,
    rollbackOf: manifest.rollbackOf ?? null,
    platform: artifact.platform,
    arch: artifact.arch,
    kind: artifact.kind,
    fileName: artifact.fileName,
    size: artifact.size,
    sha256: artifact.sha256,
  }
}

/** How a platform's installer is expected to be named, for identity checks. */
export function expectedArtifactKind(platform: UpdatePlatform): UpdateArtifactKind | null {
  if (platform === 'darwin') return 'dmg'
  if (platform === 'win32') return 'nsis'
  return 'AppImage'
}
