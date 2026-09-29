import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import { UpdateSummary } from '../src/renderer/src/components/update-summary'
import { absentFromRelease } from '../scripts/release-update-common'
import { parseUpdateManifest } from '../src/shared/update'

const ROOT = new URL('..', import.meta.url).pathname
import type { UpdateStatus } from '../src/shared/update'

/**
 * Release text arrives from the network under a release signature, and a
 * signature proves who wrote it, not that it is safe to run. Everything the
 * updater's notes and failure messages can carry is therefore shown as text.
 */

const HOSTILE = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=1</script>',
  '"><svg onload=alert(1)>',
  'javascript:window.__pwned=1',
  '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
].join(' ')

function statusWith(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    phase: 'available',
    offer: null,
    failure: null,
    progress: null,
    currentVersion: '0.2.0',
    channel: 'stable',
    supported: true,
    trust: 'release',
    readyToInstall: false,
    restartRequired: false,
    ...overrides,
  }
}

/** What the text looks like once it is text, which is what must be rendered. */
const asText = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#x27;')

/**
 * The markup with the escaped release text taken out. Whatever is left is this
 * component's own markup, so a tag there is not something the release note
 * created.
 */
const withoutReleaseText = (markup: string, value: string): string =>
  markup.split(asText(value)).join('')

test('release notes from a signed manifest are shown as text and never as markup', () => {
  // The hostile text arrives the way a real release note would: inside a
  // manifest the app parsed, through the same offer the surface renders.
  const manifest = parseUpdateManifest(
    Buffer.from(
      JSON.stringify({
        schema: 1,
        channel: 'stable',
        version: '0.2.0',
        sequence: 3,
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        notes: HOSTILE,
        rollbackOf: null,
        artifacts: [
          {
            platform: 'darwin',
            arch: 'arm64',
            kind: 'dmg',
            fileName: 'a.dmg',
            url: 'https://github.com/howarewoo/git-stacks/releases/download/updates-stable/a.dmg',
            sha256: 'a'.repeat(64),
            size: 1,
          },
        ],
      }),
    ),
  )
  assert.equal(manifest.ok, true)
  if (!manifest.ok) return
  const artifact = manifest.value.artifacts[0]
  assert.ok(artifact, 'the fixture manifest names a build')

  const markup = renderToStaticMarkup(
    React.createElement(UpdateSummary, {
      channel: 'stable',
      status: statusWith({
        offer: {
          channel: 'stable',
          version: manifest.value.version,
          sequence: manifest.value.sequence,
          notes: manifest.value.notes,
          rollbackOf: null,
          platform: 'darwin',
          arch: 'arm64',
          kind: 'dmg',
          fileName: artifact.fileName,
          size: artifact.size,
          sha256: artifact.sha256,
        },
      }),
    }),
  )

  assert.ok(
    markup.includes(asText(HOSTILE)),
    'the release note is present in the output as escaped text, character for character',
  )
  const remaining = withoutReleaseText(markup, HOSTILE)
  assert.doesNotMatch(remaining, /<img/u, 'no image element was created from release notes')
  assert.doesNotMatch(remaining, /<script/u, 'no script element was created from release notes')
  assert.doesNotMatch(remaining, /<svg onload/u, 'no element was created from release notes')
  assert.doesNotMatch(remaining, /<iframe/u, 'no frame was created from release notes')
  assert.doesNotMatch(remaining, /javascript:/u, 'no link to a script URL was created')
})

test('a refusal message from main is shown with its reason, whatever it contains', () => {
  const markup = renderToStaticMarkup(
    React.createElement(UpdateSummary, {
      channel: 'stable',
      status: statusWith({
        phase: 'failed',
        failure: { reason: 'bad-signature', message: HOSTILE },
      }),
    }),
  )
  assert.ok(markup.includes(asText(HOSTILE)), 'the refusal text is escaped in the output')
  const remaining = withoutReleaseText(markup, HOSTILE)
  assert.doesNotMatch(remaining, /<img|<script|onerror=|onload=/u)
  assert.match(markup, /\(bad-signature\)/u, 'the reason main gave is still shown')
})

test('a channel may only be called unpublished when the reader says so', () => {
  // Starting a channel overwrites the sequence it has already issued. A run
  // that could not read the channel — no network, an expired token, a rate
  // limit — must stop instead, because a sequence of 1 is one installed builds
  // are right to refuse as a replay, and a lower version would replace a higher
  // one with no rollback naming what it replaced.
  const fileName = 'update-stable.json'
  const tag = 'updates-stable'
  for (const said of [
    'release not found',
    'HTTP 404: Not Found (https://api.github.com/repos/…/releases/tags/updates-stable)',
    'no release assets found matching update-stable.json',
  ]) {
    assert.equal(
      absentFromRelease({ stderr: said }, fileName, tag),
      true,
      `a reader that said "${said}" has established there is nothing published`,
    )
  }
  for (const said of [
    '',
    'error connecting to api.github.com: dial tcp: no route to host',
    'HTTP 403: API rate limit exceeded',
    'HTTP 401: Bad credentials',
    'could not find any release matching the tag',
    'unexpected end of JSON input',
  ]) {
    assert.equal(
      absentFromRelease({ stderr: said }, fileName, tag),
      false,
      `"${said}" is a failure to read the channel, not proof that it is empty`,
    )
  }
})

/**
 * The producer reads a channel's history before it mints the next sequence, and
 * the only history it may read is bytes a trusted key signed. These run the real
 * helper in a child process, against a real key and a real signature over real
 * manifest bytes, with `gh` replaced by a script that serves those exact bytes —
 * the point being that a signed, correct, existing history is read, and that
 * every way of being wrong about it stops the release.
 */
function runProducer(options: {
  manifest: unknown
  signature: { keyId: string; signature: string } | null
  keys: unknown
  channel?: string
}): { code: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'git-stacks-producer-'))
  const assets = join(root, 'assets')
  const tools = join(root, 'tools')
  mkdirSync(join(root, 'resources'), { recursive: true })
  mkdirSync(join(root, 'scripts'))
  mkdirSync(assets, { recursive: true })
  mkdirSync(tools, { recursive: true })
  // The module resolves its key set relative to the working directory, so the
  // run gets its own key set in its own tree rather than the repository's.
  symlinkSync(join(ROOT, 'scripts'), join(root, 'scripts-linked'), 'dir')
  writeFileSync(join(root, 'resources', 'update-trusted-keys.json'), JSON.stringify(options.keys))
  writeFileSync(join(assets, 'update-stable.json'), JSON.stringify(options.manifest))
  if (options.signature) {
    writeFileSync(join(assets, 'update-stable.json.sig'), JSON.stringify(options.signature))
  }
  writeFileSync(
    join(tools, 'gh'),
    [
      '#!/bin/sh',
      'dir=; name=',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --dir) dir="$2"; shift 2 ;;',
      '    --pattern) name="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'if [ -f "' + assets + '/$name" ]; then cp "' + assets + '/$name" "$dir/$name"; exit 0; fi',
      'echo "release not found" >&2; exit 1',
    ].join('\n'),
    { mode: 0o755 },
  )
  const run = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--eval',
      'import { publishedManifest } from "./scripts-linked/release-update-common.ts";' +
        'process.stdout.write(JSON.stringify(publishedManifest(process.env.PROBE_CHANNEL, "owner/repo")))',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH ?? ''}`,
        PROBE_CHANNEL: options.channel ?? 'stable',
      },
    },
  )
  rmSync(root, { recursive: true, force: true })
  return { code: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

function releaseKey(keyId = 'producer-2026'): {
  keyId: string
  publicKey: string
  privateKey: KeyObject
} {
  const pair = generateKeyPairSync('ed25519')
  return {
    keyId,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey,
  }
}

function keySet(entries: { keyId: string; publicKey: string }[]): unknown {
  return {
    schema: 1,
    keys: entries.map((entry) => ({
      ...entry,
      validFrom: '2020-01-01T00:00:00.000Z',
      validUntil: null,
    })),
  }
}

function signedManifest(
  channel: string,
  version: string,
  sequence: number,
): Record<string, unknown> {
  return {
    schema: 1,
    channel,
    version,
    sequence,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    notes: 'Producer history.',
    rollbackOf: null,
    artifacts: [
      {
        platform: 'darwin',
        arch: 'arm64',
        kind: 'dmg',
        fileName: 'Git-Stacks.dmg',
        url: 'https://github.com/howarewoo/git-stacks/releases/download/stable/Git-Stacks.dmg',
        sha256: createHash('sha256').update('build').digest('hex'),
        size: 5,
      },
    ],
  }
}

test('the producer reads the sequence and version a trusted key signed on this channel', () => {
  const key = releaseKey()
  const manifest = signedManifest('stable', '1.4.0', 12)
  const bytes = Buffer.from(JSON.stringify(manifest))
  const run = runProducer({
    manifest,
    signature: {
      keyId: key.keyId,
      signature: sign(null, bytes, key.privateKey).toString('base64'),
    },
    keys: keySet([{ keyId: key.keyId, publicKey: key.publicKey }]),
  })
  assert.equal(run.code, 0, `the producer read the history it published: ${run.out}`)
  assert.match(run.out, /currently publishes version 1\.4\.0 at sequence 12/u)
  assert.match(run.out, /"sequence":12/u)
  assert.match(run.out, /"version":"1\.4\.0"/u)
})

test('a signed manifest for another channel is not this channel’s history', () => {
  const key = releaseKey()
  // A beta manifest, validly signed, served as the stable feed: a real document
  // with no business describing this channel, and a sequence this channel never
  // issued. Believing it would hold every stable install on a release it can
  // never accept again.
  const manifest = signedManifest('beta', '1.5.0', 3)
  const bytes = Buffer.from(JSON.stringify(manifest))
  const run = runProducer({
    manifest,
    signature: {
      keyId: key.keyId,
      signature: sign(null, bytes, key.privateKey).toString('base64'),
    },
    keys: keySet([{ keyId: key.keyId, publicKey: key.publicKey }]),
  })
  assert.equal(run.code, 1, 'the release stops rather than minting a sequence over it')
  assert.match(run.out, /publishes a beta manifest/u)
  assert.doesNotMatch(run.out, /currently publishes version/u)
})

test('a manifest this release has no key for is not read, however well formed', () => {
  const other = releaseKey('someone-elses-2026')
  const trusted = releaseKey()
  const manifest = signedManifest('stable', '1.4.0', 12)
  const bytes = Buffer.from(JSON.stringify(manifest))
  const run = runProducer({
    manifest,
    signature: {
      keyId: other.keyId,
      signature: sign(null, bytes, other.privateKey).toString('base64'),
    },
    keys: keySet([{ keyId: trusted.keyId, publicKey: trusted.publicKey }]),
  })
  assert.equal(run.code, 1)
  assert.match(run.out, /which this release does not trust/u)
})

test('a manifest whose bytes were changed after signing is not read', () => {
  const key = releaseKey()
  const signed = Buffer.from(JSON.stringify(signedManifest('stable', '1.4.0', 12)))
  const run = runProducer({
    manifest: { ...signedManifest('stable', '1.4.0', 12), version: '9.9.9' },
    signature: { keyId: key.keyId, signature: sign(null, signed, key.privateKey).toString('base64') },
    keys: keySet([{ keyId: key.keyId, publicKey: key.publicKey }]),
  })
  assert.equal(run.code, 1)
  assert.match(run.out, /does not match the signature beside it/u)
})
