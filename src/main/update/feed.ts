import { Agent, request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import {
  MAX_UPDATE_REDIRECTS,
  RELEASE_LOCATION_ORIGIN,
  RELEASE_LOCATION_PATH_PREFIX,
  type UpdateChannel,
  type UpdateOutcome,
  type UpdateRejectionReport,
} from '../../shared/update'

/** A release moving tag per channel, so the feed URL never has to be rebuilt. */
const CHANNEL_TAG: Record<UpdateChannel, string> = {
  stable: 'updates-stable',
  beta: 'updates-beta',
}

/**
 * Where this channel's manifest lives, and the rules every URL it names must
 * satisfy.
 *
 * The signature is what makes a manifest trustworthy; the pinned location is
 * what stops a signed manifest from pointing this app at somebody else's
 * server. In a packaged build the location is compiled in. An unpackaged build
 * used for development and fixtures may be pointed elsewhere, and reports that
 * it was.
 */
export interface UpdateFeed {
  origin: string
  pathPrefix: string
  manifestUrl: string
  signatureUrl: string
  /** Extra certificate authority material, only ever set by a fixture. */
  ca: string[]
  trust: 'release' | 'development'
}

function refusal(reason: UpdateRejectionReport['reason'], message: string): UpdateOutcome<never> {
  return { ok: false, failure: { reason, message } }
}

/**
 * Resolves the feed for one channel. A build with no pinned key does not fail
 * here: it reports that updates are not configured, and never opens a socket.
 */
export function resolveUpdateFeed(
  channel: UpdateChannel,
  env: NodeJS.ProcessEnv = process.env,
  packaged = false,
): UpdateOutcome<UpdateFeed> {
  const base = packaged ? null : env.GIT_STACKS_UPDATE_FEED_BASE
  if (base) {
    let url: URL
    try {
      url = new URL(base)
    } catch {
      return refusal('malformed-url', 'The configured update feed address is not a URL.')
    }
    const caFile = env.GIT_STACKS_UPDATE_CA_FILE
    let ca: string[] = []
    if (caFile) {
      try {
        ca = [readFileSync(caFile, 'utf8')]
      } catch {
        return refusal('unreachable', 'The configured update feed certificate is unreadable.')
      }
    }
    const prefix = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
    return {
      ok: true,
      value: {
        origin: url.origin,
        pathPrefix: prefix,
        manifestUrl: `${url.origin}${prefix}update-${channel}.json`,
        signatureUrl: `${url.origin}${prefix}update-${channel}.json.sig`,
        ca,
        trust: 'development',
      },
    }
  }
  const prefix = `${RELEASE_LOCATION_PATH_PREFIX}${CHANNEL_TAG[channel]}/`
  return {
    ok: true,
    value: {
      origin: RELEASE_LOCATION_ORIGIN,
      pathPrefix: prefix,
      manifestUrl: `${RELEASE_LOCATION_ORIGIN}${prefix}update-${channel}.json`,
      signatureUrl: `${RELEASE_LOCATION_ORIGIN}${prefix}update-${channel}.json.sig`,
      ca: [],
      trust: 'release',
    },
  }
}

/**
 * A URL is inside the feed when it is HTTPS, on the same origin, and under the
 * same path. Everything else — another scheme, another host, a path that escapes
 * the release directory with `..` — is refused before a request is made.
 */
export function insideFeed(feed: UpdateFeed, candidate: URL): boolean {
  return (
    candidate.protocol === 'https:' &&
    candidate.origin === feed.origin &&
    candidate.pathname.startsWith(feed.pathPrefix) &&
    !candidate.pathname.includes('..') &&
    !candidate.username &&
    !candidate.password
  )
}

export interface FetchOptions {
  feed: UpdateFeed
  signal?: AbortSignal
  timeoutMs: number
  maxBytes: number
}

/**
 * Reads bytes from the feed, refusing anything that would make the updater
 * download more than the manifest or signature it asked for: a redirect off the
 * pinned location, a body larger than the caller's cap, or a response that never
 * finishes.
 */
export function fetchFeedBytes(
  url: URL,
  options: FetchOptions,
  redirectsLeft = MAX_UPDATE_REDIRECTS,
): Promise<{ url: URL; body: Buffer }> {
  if (!insideFeed(options.feed, url)) {
    return Promise.reject(
      new Error('The update feed answered with an address outside the pinned release location.'),
    )
  }
  const { promise, resolve, reject } = Promise.withResolvers<{ url: URL; body: Buffer }>()
    const request = httpsRequest(
      url,
      {
        method: 'GET',
        agent: new Agent(
          options.feed.ca.length > 0
            ? { ca: options.feed.ca, minVersion: 'TLSv1.2' }
            : { minVersion: 'TLSv1.2' },
        ),
        headers: { accept: 'application/octet-stream' },
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (status >= 300 && status < 400 && typeof location === 'string') {
          response.resume()
          if (redirectsLeft <= 0) {
            reject(new Error('The update feed redirected too many times.'))
            return
          }
          let next: URL
          try {
            next = new URL(location, url)
          } catch {
            reject(new Error('The update feed redirected to an address that could not be read.'))
            return
          }
          fetchFeedBytes(next, options, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error(`The update feed answered ${status}.`))
          return
        }
        const declared = Number(response.headers['content-length'] ?? '')
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy()
          reject(new Error('The update feed offered more bytes than this update may be.'))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxBytes) {
            request.destroy()
            reject(new Error('The update feed offered more bytes than this update may be.'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve({ url, body: Buffer.concat(chunks) }))
        response.on('error', reject)
      },
    )
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error('The update feed did not answer in time.'))
    })
    const onAbort = (): void => {
      request.destroy(new Error('The update request was cancelled.'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    request.on('close', () => options.signal?.removeEventListener('abort', onAbort))
    request.on('error', reject)
  request.end()
  return promise
}

