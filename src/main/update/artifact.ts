import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { UpdateManifestArtifact } from '../../shared/update'
import { insideFeed, type UpdateFeed } from './feed'

/** A staged installer that has been downloaded and checked, but not run. */
export interface StagedUpdate {
  /** Absolute path of the verified file. */
  path: string
  sha256: string
  size: number
  fileName: string
}

export interface DownloadOptions {
  feed: UpdateFeed
  artifact: UpdateManifestArtifact
  /** Directory staged artifacts live in. Never inside a user repository. */
  stagingDirectory: string
  signal?: AbortSignal
  timeoutMs: number
  onProgress?: (percent: number) => void
}

/**
 * Downloads one artifact and proves it is the artifact the signed manifest
 * described.
 *
 * Both checks are taken from the manifest, and the manifest was authenticated
 * before this was called: the byte count and the digest are not values the
 * network gets a say in. The file is written under a temporary name and only
 * moved into place once both match, so nothing downstream can read a partial
 * or substituted download, and a cancelled or failed download leaves nothing
 * behind.
 */
export async function downloadUpdateArtifact(options: DownloadOptions): Promise<StagedUpdate> {
  const { artifact, feed } = options
  const url = new URL(artifact.url)
  if (!insideFeed(feed, url)) {
    throw new Error('The signed update points outside this project’s release location.')
  }
  await mkdir(options.stagingDirectory, { recursive: true })
  const finalPath = join(
    options.stagingDirectory,
    `${artifact.sha256.slice(0, 16)}-${artifact.fileName}`,
  )
  const partialPath = `${finalPath}.part`
  const hash = createHash('sha256')
  let received = 0
  let lastPercent = -1

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      if (received > artifact.size) {
        done(new Error('The download is larger than the signed manifest allows.'))
        return
      }
      hash.update(chunk)
      const percent = Math.floor((received / artifact.size) * 100)
      if (options.onProgress && percent !== lastPercent) {
        lastPercent = percent
        options.onProgress(Math.min(percent, 100))
      }
      done(null, chunk)
    },
  })

  const { promise, resolve: settled, reject: refused } = Promise.withResolvers<void>()
  const request = httpsRequest(
    url,
    { method: 'GET', headers: { accept: 'application/octet-stream' } },
    (response) => {
      const status = response.statusCode ?? 0
      if (status !== 200) {
        response.resume()
        refused(new Error(`The update download answered ${status}.`))
        return
      }
      pipeline(response, meter, createWriteStream(partialPath, { mode: 0o600 })).then(
        settled,
        refused,
      )
    },
  )
  request.setTimeout(options.timeoutMs, () => {
    request.destroy(new Error('The update download did not finish in time.'))
  })
  const onAbort = (): void => {
    request.destroy(new Error('The update download was cancelled.'))
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  request.on('close', () => options.signal?.removeEventListener('abort', onAbort))
  request.on('error', refused)
  request.end()

  try {
    await promise
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined)
    throw error
  }

  const digest = hash.digest('hex')
  if (received !== artifact.size || digest !== artifact.sha256) {
    await rm(partialPath, { force: true })
    throw new Error(
      received !== artifact.size
        ? 'The downloaded build is not the size the signed manifest described.'
        : 'The downloaded build does not match the signed manifest’s digest.',
    )
  }
  await rename(partialPath, finalPath)
  options.onProgress?.(100)
  return { path: finalPath, sha256: digest, size: received, fileName: artifact.fileName }
}

/** Removes a staged artifact, so a cancelled or replaced update leaves nothing. */
export async function discardStagedUpdate(staged: StagedUpdate): Promise<void> {
  await rm(staged.path, { force: true }).catch(() => undefined)
}
