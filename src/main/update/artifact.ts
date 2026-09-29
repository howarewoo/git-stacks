import { createHash } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Agent, request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_UPDATE_REDIRECTS, type UpdateManifestArtifact } from '../../shared/update'
import { insideFeed, redirectIsAllowed, type UpdateFeed } from './feed'

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

  const deadline = Date.now() + options.timeoutMs
  // A wall clock, not a socket timer. `setTimeout` on a request measures
  // inactivity, so a peer that sends a byte often enough keeps a connection open
  // indefinitely; this bounds the whole operation — connecting, following
  // redirects, and streaming the body — from the moment it starts.
  const exceeded = 'The update download did not finish in time.'
  const timer = setTimeout(
    () => {
      for (const stream of live) stream?.destroy(new Error(exceeded))
    },
    Math.max(1, deadline - Date.now()),
  )
  timer.unref()
  const live = new Set<{ destroy: (error: Error) => void }>()

  try {
    const opened = await openArtifact(url, 0)
    try {
      await pipeline(opened, meter, createWriteStream(partialPath, { mode: 0o600 }))
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined)
      throw error
    }

    const digest = hash.digest('hex')
    if (received !== artifact.size || digest !== artifact.sha256) {
      await rm(partialPath, { force: true })
      throw new Error(
        received !== artifact.size
          ? 'The downloaded build is not the size the signed manifest allowed.'
          : 'The downloaded build does not match the signed manifest’s digest.',
      )
    }
    await rename(partialPath, finalPath)
    options.onProgress?.(100)
    return { path: finalPath, sha256: digest, size: received, fileName: artifact.fileName }
  } finally {
    // The deadline is cleared only when the whole operation has ended. It used
    // to be cleared as soon as the response headers arrived, which left a peer
    // that answered and then stopped sending with no timer at all: the body
    // could then take as long as it liked. It now spans opening, streaming,
    // proving, and moving the file into place.
    clearTimeout(timer)
  }

  /**
   * One request, following only the redirects this updater is willing to
   * follow. A release asset is served from GitHub's own asset host after a
   * redirect, so that host is named rather than any HTTPS address being
   * accepted; the hop count is bounded, and the whole download shares one
   * deadline however many hops it takes. The fixture certificate authority
   * travels with the feed so a controlled HTTPS server can be used, and it is
   * only ever set by a fixture.
   */
  function openArtifact(target: URL, hops: number): Promise<IncomingMessage> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error('The update download was cancelled before it started.'))
    }
    if (Date.now() >= deadline) {
      return Promise.reject(new Error('The update download ran out of time before it started.'))
    }
    return new Promise<IncomingMessage>((resolveResponse, rejectResponse) => {
      const request = httpsRequest(
        target,
        {
          method: 'GET',
          agent: new Agent(
            feed.ca.length > 0 ? { ca: feed.ca, minVersion: 'TLSv1.2' } : { minVersion: 'TLSv1.2' },
          ),
          headers: { accept: 'application/octet-stream' },
        },
        (answer) => {
          const status = answer.statusCode ?? 0
          const location = answer.headers.location
          if (status >= 300 && status < 400 && typeof location === 'string') {
            answer.resume()
            if (hops >= MAX_UPDATE_REDIRECTS) {
              rejectResponse(new Error('The update download redirected too many times.'))
              return
            }
            let next: URL
            try {
              next = new URL(location, target)
            } catch {
              rejectResponse(
                new Error(
                  'The update download was redirected to an address that could not be read.',
                ),
              )
              return
            }
            if (!redirectIsAllowed(feed, next)) {
              rejectResponse(
                new Error('The update download was redirected outside the release location.'),
              )
              return
            }
            live.delete(answer)
            openArtifact(next, hops + 1).then(resolveResponse, rejectResponse)
            return
          }
          if (status !== 200) {
            answer.resume()
            rejectResponse(new Error(`The update download answered ${status}.`))
            return
          }
          resolveResponse(answer)
        },
      )
      live.add(request)
      const onAbort = (): void => {
        request.destroy(new Error('The update download was cancelled.'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      request.on('close', () => {
        options.signal?.removeEventListener('abort', onAbort)
        live.delete(request)
      })
      request.on('error', rejectResponse)
      request.end()
    })
  }
}

/** Removes a staged artifact, so a cancelled or replaced update leaves nothing. */
export async function discardStagedUpdate(staged: StagedUpdate): Promise<void> {
  await rm(staged.path, { force: true }).catch(() => undefined)
}

/**
 * Copies the already-verified download into owner-private handoff storage, and
 * hands the installer that one path.
 *
 * The file is created exclusively, so an existing destination — a regular file
 * or a link — is refused rather than written through, and the source is opened
 * without following a link. The directory is this app's own state, entered by
 * its owner alone on a POSIX system.
 *
 * What this is, exactly: it reduces accidental interference with the download
 * and refuses a destination something else already holds. It does not bind the
 * earlier digest check to an immutable executable object, and it does not
 * defend against a process running as this same user — a backup or sync agent
 * commonly does. Anyone who wants a stronger claim than that needs the platform
 * to hold the file, not this code.
 */
export async function privateInstallHandoff(
  staged: StagedUpdate,
  parent: string,
): Promise<StagedUpdate> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  // chmod rather than trusting the mode argument: an existing directory keeps
  // whatever mode it had, and this one must not be readable by anyone else.
  await chmod(parent, 0o700)
  const target = join(parent, staged.fileName)
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  )
  // From the moment this call created the file, this attempt owns it: every way
  // out of here that is not success removes it. A destination that was already
  // there was refused by the exclusive create above, so nothing another process
  // or an earlier run left behind is ever deleted by this one.
  try {
    const source = await open(staged.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await pipeline(source.createReadStream(), handle.createWriteStream(), { end: false })
    } finally {
      await source.close()
    }
    await handle.close()
    const { size } = await stat(target)
    if (size !== staged.size) {
      throw new Error('The verified build could not be handed to the installer unchanged.')
    }
    return { ...staged, path: target }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(target, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Reads a staged installer again. The digest proved at download time is
 * proved once more immediately before the installer runs, so a staged file
 * that was replaced on disk after the download cannot be installed.
 */
export async function hashStagedUpdate(staged: StagedUpdate): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(staged.path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}
