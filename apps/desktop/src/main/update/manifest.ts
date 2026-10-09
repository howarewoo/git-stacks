import {
  MAX_UPDATE_MANIFEST_BYTES,
  MAX_UPDATE_SIGNATURE_BYTES,
  UPDATE_FETCH_TIMEOUT_MS,
  evaluateUpdateManifest,
  parseSignatureEnvelope,
  parseUpdateManifest,
  toUpdateOffer,
  type UpdateEnvironment,
  type UpdateManifestArtifact,
  type UpdateOffer,
  type UpdateOutcome,
  updateRefusal,
} from '@git-stacks/shared/update'
import { fetchFeedBytes, resolveUpdateFeed, type UpdateFeed } from './feed'
import { trustedUpdateKeys } from './keys'
import { verifyDetachedSignature } from './signature'

/** An authenticated release and the build this machine would install from it. */
export interface AuthenticatedUpdate {
  feed: UpdateFeed
  offer: UpdateOffer
  artifact: UpdateManifestArtifact
}

export interface LoadOptions {
  /** A packaged build takes its keys and feed location from the bundle alone. */
  packaged?: boolean
  env?: NodeJS.ProcessEnv
  now?: number
  signal?: AbortSignal
}

/**
 * Fetches, authenticates, and vets one release manifest.
 *
 * The order here is the whole point: the signature is checked against the bytes
 * as they arrived, and only what the signature covers is ever parsed. A URL, a
 * file name, or a version from an unsigned manifest is never read, so a
 * tampered feed cannot choose where this app goes next.
 */
export async function loadAuthenticatedUpdate(
  environment: UpdateEnvironment,
  options: LoadOptions = {},
): Promise<UpdateOutcome<AuthenticatedUpdate>> {
  const env = options.env ?? process.env
  const packaged = options.packaged ?? false
  const now = options.now ?? Date.now()
  const feed = resolveUpdateFeed(environment.channel, env, packaged)
  if (!feed.ok) return feed
  const keys = trustedUpdateKeys(env, packaged)
  if (keys.keys.length === 0) {
    return updateRefusal(
      'not-configured',
      'This build carries no release signing key, so no update can be trusted and none is fetched.',
    )
  }

  const transport = {
    feed: feed.value,
    signal: options.signal,
    timeoutMs: UPDATE_FETCH_TIMEOUT_MS,
  }
  let manifestBytes: Buffer
  let signatureBytes: Buffer
  try {
    const [manifest, signature] = await Promise.all([
      fetchFeedBytes(new URL(feed.value.manifestUrl), {
        ...transport,
        maxBytes: MAX_UPDATE_MANIFEST_BYTES,
      }),
      fetchFeedBytes(new URL(feed.value.signatureUrl), {
        ...transport,
        maxBytes: MAX_UPDATE_SIGNATURE_BYTES,
      }),
    ])
    manifestBytes = manifest.body
    signatureBytes = signature.body
  } catch (error) {
    return updateRefusal(
      'unreachable',
      `The update feed could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const envelope = parseSignatureEnvelope(signatureBytes)
  if (!envelope.ok) return envelope
  const key = keys.keys.find((entry) => entry.keyId === envelope.value.keyId)
  if (!key) {
    return updateRefusal(
      'unknown-key',
      `This manifest is signed by ${envelope.value.keyId}, which this build does not trust.`,
    )
  }
  if (!verifyDetachedSignature(key, manifestBytes, envelope.value.signature, now)) {
    return updateRefusal(
      'bad-signature',
      'The update manifest is not signed by a key this build trusts. Nothing was downloaded.',
    )
  }

  const manifest = parseUpdateManifest(manifestBytes)
  if (!manifest.ok) return manifest
  const artifact = evaluateUpdateManifest(manifest.value, {
    ...environment,
    now,
    allowedOrigin: feed.value.origin,
    allowedPathPrefix: feed.value.pathPrefix,
  })
  if (!artifact.ok) return artifact
  return {
    ok: true,
    value: {
      feed: feed.value,
      offer: toUpdateOffer(manifest.value, artifact.value),
      artifact: artifact.value,
    },
  }
}
