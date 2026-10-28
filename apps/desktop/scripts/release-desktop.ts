import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, parseVersion } from '@git-stacks/shared/update'
import { isRecord } from '@git-stacks/shared/guards'
import {
  assetNameFor,
  flag,
  parseFlags,
  publishedManifest,
  sha256Of,
} from './release-update-common'

const RESERVATION_KIND = 'git-stacks-automatic-beta'
const PAYLOAD = 'signed-release-payload.tar'
const PREVIEW_PAYLOAD = 'unsigned-preview-payload.tar'
const PREVIEW_MARKER = '<!-- git-stacks-unsigned-preview -->'
const SHA = /^[0-9a-f]{40}$/
const CORE = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)'
const VERSION = new RegExp(`^${CORE}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$`)
const BETA = new RegExp(`^${CORE}-beta\\.([1-9][0-9]*)$`)

export interface Reservation {
  schema: 1
  kind: typeof RESERVATION_KIND
  sourceSha: string
  version: string
}

export interface ReleaseIdentity {
  sourceSha: string
  version: string
  tag: string
  channel: 'beta' | 'stable'
  automatic: boolean
  unsignedPreview: boolean
}

export interface Release {
  id: number
  tag_name: string
  body: string | null
  draft: boolean
  prerelease: boolean
}

export interface Tag {
  name: string
  sourceSha: string
  reservation: Reservation | null
}

function requireVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!VERSION.test(version) || !parsed || !parsed.core.every(Number.isSafeInteger)) {
    throw new Error(`${version} is not a canonical release version.`)
  }
  return version
}

export function readReservation(
  message: string,
  tag: string,
  sourceSha: string,
): Reservation | null {
  // Ordinary annotated tags are version history, not reservations we own.
  if (!message.includes(RESERVATION_KIND)) return null
  const value: unknown = JSON.parse(message)
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    value.kind !== RESERVATION_KIND ||
    typeof value.version !== 'string' ||
    !BETA.test(value.version) ||
    value.sourceSha !== sourceSha ||
    !SHA.test(sourceSha) ||
    tag !== `v${value.version}`
  ) {
    throw new Error(`Conflicting automatic beta reservation at ${tag}.`)
  }
  return { schema: 1, kind: RESERVATION_KIND, sourceSha, version: requireVersion(value.version) }
}

/** All tags (including failed reservations), drafts and verified feeds spend versions. */
export function nextBetaVersion(established: string, versions: readonly string[]): string {
  requireVersion(established)
  const history = [established, ...versions].filter((version) => VERSION.test(version))
  for (const version of history) requireVersion(version)
  const stable = history
    .filter((version) => !version.includes('-'))
    .sort(compareVersions)
    .at(-1)
  if (!stable) throw new Error('No established stable core is available for the beta series.')
  const core = parseVersion(stable)!.core
  core[2] += 1
  let candidateCore = core.join('.')
  for (const version of history) {
    const parsed = parseVersion(version)!
    if (compareVersions(parsed.core.join('.'), candidateCore) > 0) {
      candidateCore = parsed.core.join('.')
    }
  }
  const highest = Math.max(
    0,
    ...history.map((version) => {
      const match = BETA.exec(version)
      return match && version.startsWith(`${candidateCore}-beta.`) ? Number(match[4]) : 0
    }),
  )
  if (!Number.isSafeInteger(highest + 1)) throw new Error('Beta counter exhausted.')
  let version = `${candidateCore}-beta.${highest + 1}`
  if (history.some((prior) => compareVersions(prior, version) >= 0)) {
    const next = parseVersion(candidateCore)!.core
    next[2] += 1
    version = `${next.join('.')}-beta.1`
  }
  return requireVersion(version)
}

export function chooseBeta(options: {
  sourceSha: string
  established: string
  tags: readonly Tag[]
  versions: readonly string[]
  isAncestor: (before: string, after: string) => boolean
}): ReleaseIdentity {
  const { sourceSha, tags, isAncestor } = options
  if (!SHA.test(sourceSha)) throw new Error('An automatic release requires an exact source SHA.')
  const reservations = tags.flatMap((tag) => (tag.reservation ? [tag.reservation] : []))
  const owned = reservations.filter((entry) => entry.sourceSha === sourceSha)
  if (owned.length > 1) throw new Error('Multiple beta reservations own the same source SHA.')
  for (const entry of reservations) {
    if (!isAncestor(entry.sourceSha, sourceSha)) {
      throw new Error(
        `Stale or divergent source ${sourceSha}: reservation v${entry.version} is not its ancestor. Re-run in ancestry order; do not overwrite tags.`,
      )
    }
  }
  const version =
    owned[0]?.version ??
    nextBetaVersion(options.established, [
      ...options.versions,
      ...tags.map((tag) => tag.name.replace(/^v/, '')),
    ])
  return {
    sourceSha,
    version,
    tag: `v${version}`,
    channel: 'beta',
    automatic: true,
    unsignedPreview: false,
  }
}

export function requireReleaseOwner(identity: ReleaseIdentity, release: Release): void {
  const markers = (release.body ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`<!-- ${RESERVATION_KIND}:`))
  if (
    release.tag_name !== identity.tag ||
    release.prerelease !== (identity.channel === 'beta') ||
    (release.body ?? '').includes(PREVIEW_MARKER) !== identity.unsignedPreview ||
    (identity.automatic && (markers.length !== 1 || markers[0] !== reservationMarker(identity)))
  ) {
    throw new Error(`Release ${identity.tag} is not owned by this source/channel identity.`)
  }
}

function reservationMarker(identity: ReleaseIdentity): string {
  return `<!-- ${RESERVATION_KIND}:${JSON.stringify({ schema: 1, sourceSha: identity.sourceSha, version: identity.version })} -->`
}

export function automaticReleaseBody(identity: ReleaseIdentity, notes: string): string {
  const description = identity.unsignedPreview
    ? `${PREVIEW_MARKER}\n\nUnsigned macOS preview ${identity.version}.\n\nNot Developer ID signed or notarized. macOS may block opening this app. Automatic updates are not configured; install future previews manually.`
    : `Automatic signed beta ${identity.version}.`
  return `${reservationMarker(identity)}\n\n${description}\n\nSource commit: ${identity.sourceSha}\n\n${notes}`
}

/** Compare before upload; a lost response is recovered by reading, never by clobbering. */
export function publishImmutable(
  name: string,
  bytes: Buffer,
  read: (name: string) => Buffer | null,
  upload: () => void,
): void {
  const before = read(name)
  if (before !== null) {
    if (!before.equals(bytes))
      throw new Error(`${name} already exists with different immutable bytes.`)
    return
  }
  upload()
  const after = read(name)
  if (after === null || !after.equals(bytes))
    throw new Error(`${name} upload could not be confirmed.`)
}

/** Versions are build inputs only; no commit or lockfile rewrite is made. */
export function stampWorkspace(root: string, version: string): void {
  requireVersion(version)
  const paths = [
    'package.json',
    ...['apps', 'packages'].flatMap((directory) =>
      readdirSync(join(root, directory), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${directory}/${entry.name}/package.json`),
    ),
  ]
  for (const path of paths) {
    const absolute = join(root, path)
    const pkg = JSON.parse(readFileSync(absolute, 'utf8'))
    if (typeof pkg.version !== 'string') throw new Error(`${path} has no workspace version.`)
    pkg.version = version
    writeFileSync(absolute, `${JSON.stringify(pkg, null, 2)}\n`)
  }
}

function gh(args: string[], input?: unknown): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  })
}

function api<T>(path: string, method = 'GET', input?: unknown): T {
  return JSON.parse(
    gh(['api', path, '--method', method, ...(input === undefined ? [] : ['--input', '-'])], input),
  ) as T
}

function pages<T>(path: string): T[] {
  const result: T[] = []
  for (let page = 1; ; page += 1) {
    const values = api<T[]>(`${path}?per_page=100&page=${page}`)
    if (!Array.isArray(values)) throw new Error(`Expected a complete list at ${path}.`)
    result.push(...values)
    if (values.length < 100) return result
  }
}

function ancestor(repo: string, before: string, after: string): boolean {
  if (before === after) return true
  const result = api<{ status: string }>(`repos/${repo}/compare/${before}...${after}`)
  return result.status === 'ahead' || result.status === 'identical'
}

function tagIdentity(repo: string, tag: string): Tag {
  let object = api<{ object: { sha: string; type: string } }>(
    `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
  ).object
  let message = ''
  let depth = 0
  while (object.type === 'tag') {
    if (++depth > 8) throw new Error(`Tag ${tag} has excessive indirection.`)
    const annotated = api<{ message: string; object: { sha: string; type: string } }>(
      `repos/${repo}/git/tags/${object.sha}`,
    )
    if (depth === 1) message = annotated.message
    object = annotated.object
  }
  if (object.type !== 'commit' || !SHA.test(object.sha))
    throw new Error(`${tag} is not a source commit.`)
  return {
    name: tag,
    sourceSha: object.sha,
    reservation: readReservation(message, tag, object.sha),
  }
}

function assertLineage(
  repo: string,
  identity: ReleaseIdentity,
  tags: readonly { name: string }[],
): void {
  if (identity.automatic) {
    const main = api<{ commit: { sha: string } }>(`repos/${repo}/branches/main`).commit.sha
    if (!ancestor(repo, identity.sourceSha, main))
      throw new Error('Source is no longer on main (force push); release refused.')
  }
  const feed = `updates-${identity.channel}`
  if (tags.some((tag) => tag.name === feed)) {
    const current = tagIdentity(repo, feed).sourceSha
    if (!ancestor(repo, current, identity.sourceSha))
      throw new Error(
        `${feed} is not an ancestor of the release source; refusing a backwards feed.`,
      )
  }
}

function output(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (key !== 'notes') console.log(`${key}=${value}`)
    if (process.env.GITHUB_OUTPUT) {
      const delimiter = `release_${randomUUID()}`
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<${delimiter}\n${value}\n${delimiter}\n`)
    }
  }
}

export function releaseNotesParameters(
  tag: string,
  sourceSha: string,
  releases: readonly { tag_name: string; draft: boolean; published_at: string | null }[],
): Record<string, string> {
  let previous: string | undefined
  let latestPublication = -Infinity
  for (const release of releases) {
    if (
      release.draft ||
      release.published_at === null ||
      release.tag_name === tag ||
      release.tag_name === 'updates-stable' ||
      release.tag_name === 'updates-beta'
    )
      continue
    const publication = Date.parse(release.published_at)
    if (publication > latestPublication) {
      latestPublication = publication
      previous = release.tag_name
    }
  }
  return {
    tag_name: tag,
    target_commitish: sourceSha,
    ...(previous ? { previous_tag_name: previous } : {}),
  }
}

function prepare(
  repo: string,
  sourceSha: string,
  automatic: boolean,
  channel: 'beta' | 'stable',
): void {
  if (!SHA.test(sourceSha)) throw new Error('Invalid source SHA.')
  const committed = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (committed !== sourceSha) throw new Error('Checkout is not the requested source SHA.')
  const established = JSON.parse(readFileSync('package.json', 'utf8')).version as string
  const tags = pages<{ name: string }>(`repos/${repo}/tags`)
  const releases = pages<Release & { published_at: string | null }>(`repos/${repo}/releases`)
  let identity: ReleaseIdentity
  if (automatic) {
    if (
      process.env.GITHUB_EVENT_NAME !== 'push' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_SHA !== sourceSha ||
      channel !== 'beta'
    ) {
      throw new Error('Only a CI-gated main push may reserve an automatic beta.')
    }
    const versions: string[] = []
    for (const value of ['stable', 'beta'] as const) {
      publishedManifest(value, repo, undefined, (history) => versions.push(history.version))
    }
    identity = chooseBeta({
      sourceSha,
      established,
      tags: tags
        .filter((tag) => BETA.test(tag.name.replace(/^v/, '')))
        .map((tag) => tagIdentity(repo, tag.name)),
      versions: [
        ...versions,
        ...tags.map((tag) => tag.name.replace(/^v/, '')),
        ...releases.map((release) => release.tag_name.replace(/^v/, '')),
      ],
      isAncestor: (before, after) => ancestor(repo, before, after),
    })
    identity.unsignedPreview = process.env.UNSIGNED_PREVIEW === 'true'
    assertLineage(repo, identity, tags)
    if (!tags.some((tag) => tag.name === identity.tag)) {
      const reservation: Reservation = {
        schema: 1,
        kind: RESERVATION_KIND,
        sourceSha,
        version: identity.version,
      }
      const annotated = api<{ sha: string }>(`repos/${repo}/git/tags`, 'POST', {
        tag: identity.tag,
        message: JSON.stringify(reservation),
        object: sourceSha,
        type: 'commit',
      })
      api(`repos/${repo}/git/refs`, 'POST', {
        ref: `refs/tags/${identity.tag}`,
        sha: annotated.sha,
      })
    }
    const confirmed = tagIdentity(repo, identity.tag)
    if (confirmed.reservation?.sourceSha !== sourceSha)
      throw new Error('Reservation ownership could not be confirmed.')
  } else {
    const version = requireVersion(process.env.RELEASE_VERSION ?? '')
    const tag = process.env.RELEASE_TAG ?? ''
    if (tag !== `v${version}` || established !== version)
      throw new Error('Manual release tag must equal the committed desktop version.')
    if (channel === 'stable' && version.includes('-'))
      throw new Error('A stable release requires a stable version.')
    identity = { sourceSha, version, tag, channel, automatic: false, unsignedPreview: false }
    if (tagIdentity(repo, tag).sourceSha !== sourceSha)
      throw new Error('Manual release tag source changed.')
    assertLineage(repo, identity, tags)
  }
  let release: Release | undefined = releases.find((entry) => entry.tag_name === identity.tag)
  if (!release) {
    if (!automatic) throw new Error('Manual publication requires the existing GitHub release.')
    const generated = api<{ body: string }>(
      `repos/${repo}/releases/generate-notes`,
      'POST',
      releaseNotesParameters(identity.tag, sourceSha, releases),
    )
    if (typeof generated.body !== 'string')
      throw new Error('Generated release notes could not be read.')
    release = api<Release>(`repos/${repo}/releases`, 'POST', {
      tag_name: identity.tag,
      target_commitish: sourceSha,
      name: `Git Stacks ${identity.version}${identity.unsignedPreview ? ' (unsigned macOS preview)' : ''}`,
      body: automaticReleaseBody(identity, generated.body),
      draft: true,
      prerelease: true,
      make_latest: 'false',
    })
  }
  requireReleaseOwner(identity, release)
  const assets = pages<{ name: string }>(`repos/${repo}/releases/${release.id}/assets`)
  const payload = identity.unsignedPreview ? PREVIEW_PAYLOAD : PAYLOAD
  const reuse = assets.some((asset) => asset.name === payload)
  if (!reuse && assets.length !== 0)
    throw new Error(
      'Release has assets without its verified recovery payload; recover original run artifacts rather than rebuild or overwrite them.',
    )
  output({
    source: sourceSha,
    version: identity.version,
    tag: identity.tag,
    channel,
    automatic: String(automatic),
    reuse: String(reuse),
    notes: (release.body ?? `Git Stacks ${identity.version} (${channel}).`)
      .replace(reservationMarker(identity), '')
      .trim()
      .slice(0, 4000),
  })
}

function environmentIdentity(): ReleaseIdentity {
  const sourceSha = process.env.SOURCE_SHA ?? ''
  const version = requireVersion(process.env.RELEASE_VERSION ?? '')
  const channel = process.env.CHANNEL
  if (!SHA.test(sourceSha) || (channel !== 'beta' && channel !== 'stable'))
    throw new Error('Missing explicit release identity.')
  const identity = {
    sourceSha,
    version,
    tag: `v${version}`,
    channel,
    automatic: process.env.AUTOMATIC === 'true',
    unsignedPreview: process.env.UNSIGNED_PREVIEW === 'true',
  } as ReleaseIdentity
  if (
    process.env.RELEASE_TAG !== identity.tag ||
    (identity.automatic && (channel !== 'beta' || !BETA.test(version))) ||
    (identity.unsignedPreview && !identity.automatic)
  )
    throw new Error('Conflicting release identity.')
  return identity
}

function check(repo: string, identity: ReleaseIdentity): Release {
  const tag = tagIdentity(repo, identity.tag)
  if (
    tag.sourceSha !== identity.sourceSha ||
    (identity.automatic && tag.reservation?.sourceSha !== identity.sourceSha)
  )
    throw new Error('Release tag ownership changed.')
  const release = pages<Release>(`repos/${repo}/releases`).find(
    (entry) => entry.tag_name === identity.tag,
  )
  if (!release) throw new Error('Reserved release is missing.')
  requireReleaseOwner(identity, release)
  assertLineage(repo, identity, pages<{ name: string }>(`repos/${repo}/tags`))
  return release
}

function upload(repo: string, identity: ReleaseIdentity, files: string[]): void {
  const release = check(repo, identity)
  const assets = pages<{ id: number; name: string }>(`repos/${repo}/releases/${release.id}/assets`)
  for (const path of files) {
    const name = assetNameFor(basename(path))
    publishImmutable(
      name,
      readFileSync(path),
      (assetName) => {
        const asset = assets.find((entry) => entry.name === assetName)
        if (!asset) return null
        return execFileSync(
          'gh',
          [
            'api',
            `repos/${repo}/releases/assets/${asset.id}`,
            '-H',
            'Accept: application/octet-stream',
          ],
          { maxBuffer: 1024 * 1024 * 1024 },
        )
      },
      () => {
        const staging = mkdtempSync(join(tmpdir(), 'git-stacks-release-upload-'))
        try {
          const staged = join(staging, name)
          copyFileSync(path, staged)
          gh(['release', 'upload', identity.tag, staged, '--repo', repo])
        } finally {
          rmSync(staging, { recursive: true, force: true })
        }
        const refreshed = pages<{ id: number; name: string }>(
          `repos/${repo}/releases/${release.id}/assets`,
        )
        assets.splice(0, assets.length, ...refreshed)
      },
    )
    console.log(`release-desktop: verified immutable ${name} (${sha256Of(path)}).`)
  }
}

function main(): void {
  const command = process.argv[2]
  const flags = parseFlags(command === 'upload' ? [] : process.argv.slice(3))
  if (command === 'stamp') {
    stampWorkspace(resolve(flag(flags, 'root', '../..')), flag(flags, 'version'))
    return
  }
  const repo = flag(flags, 'repo', process.env.REPOSITORY ?? '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('Expected owner/repository.')
  if (command === 'prepare') {
    const channel = process.env.CHANNEL
    if (channel !== 'beta' && channel !== 'stable')
      throw new Error('Expected an explicit release channel.')
    prepare(repo, process.env.SOURCE_SHA ?? '', process.env.AUTOMATIC === 'true', channel)
    return
  }
  const identity = environmentIdentity()
  if (command === 'upload') upload(repo, identity, process.argv.slice(3))
  else if (command === 'recovery') {
    const release = check(repo, identity)
    const assets = pages<{ name: string }>(`repos/${repo}/releases/${release.id}/assets`)
    const payload = identity.unsignedPreview ? PREVIEW_PAYLOAD : PAYLOAD
    output({ reuse: String(assets.some((asset) => asset.name === payload)) })
  } else if (command === 'check') check(repo, identity)
  else if (command === 'publish-release') {
    const release = check(repo, identity)
    if (identity.automatic && release.draft)
      api(`repos/${repo}/releases/${release.id}`, 'PATCH', {
        tag_name: identity.tag,
        target_commitish: identity.sourceSha,
        draft: false,
        prerelease: true,
        make_latest: 'false',
      })
    const after = check(repo, identity)
    if (after.draft) throw new Error('Versioned release publication could not be confirmed.')
  } else if (command === 'move-feed') {
    if (identity.unsignedPreview)
      throw new Error('Unsigned previews cannot publish an update feed.')
    check(repo, identity)
    const tag = `updates-${identity.channel}`
    const tags = pages<{ name: string }>(`repos/${repo}/tags`)
    if (tags.some((entry) => entry.name === tag))
      api(`repos/${repo}/git/refs/tags/${tag}`, 'PATCH', { sha: identity.sourceSha, force: false })
    else api(`repos/${repo}/git/refs`, 'POST', { ref: `refs/tags/${tag}`, sha: identity.sourceSha })
    const releases = pages<Release>(`repos/${repo}/releases`)
    if (!releases.some((entry) => entry.tag_name === tag)) {
      api(`repos/${repo}/releases`, 'POST', {
        tag_name: tag,
        target_commitish: identity.sourceSha,
        name: `Git Stacks ${identity.channel} update feed`,
        body: `Moving signed ${identity.channel} update feed.`,
        prerelease: identity.channel === 'beta',
        make_latest: 'false',
      })
    }
    if (tagIdentity(repo, tag).sourceSha !== identity.sourceSha)
      throw new Error('Feed tag movement could not be confirmed.')
  } else
    throw new Error(
      'Expected prepare, stamp, recovery, check, upload, publish-release or move-feed.',
    )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
