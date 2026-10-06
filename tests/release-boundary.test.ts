import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitOwnedProviderCliRoot } from './fixtures/owned-provider-cli'
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
 * the only history it may read is bytes a trusted key signed.
 *
 * These run the real helper in a child process against a real key and a real
 * signature over real manifest bytes, in a working directory of the run's own so
 * the key set it reads is the one written for it. The bytes a channel publishes
 * are handed to the helper directly, which is the only part of the read that
 * talks to anything: the point being that a signed, correct, existing history is
 * read, and that every way of being wrong about it stops the release. The
 * helper's own `gh` reader is exercised separately, on the platform that
 * publishes.
 */
function runProducer(options: {
  manifest: unknown
  signature: { keyId: string; signature: string } | null
  keys: unknown
  channel?: string
  /** Asset names the reader cannot deliver, as a release run's reader would. */
  unreadable?: string[]
}): { code: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'git-stacks-producer-'))
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(root, 'resources', 'update-trusted-keys.json'), JSON.stringify(options.keys))
  const assets: Record<string, string> = {}
  if (options.manifest !== null) {
    assets['update-stable.json'] = Buffer.from(JSON.stringify(options.manifest)).toString('base64')
  }
  if (options.signature) {
    assets['update-stable.json.sig'] = Buffer.from(JSON.stringify(options.signature)).toString(
      'base64',
    )
  }
  const run = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--eval',
      [
        'import { pathToFileURL } from "node:url"',
        // The eval runs as CommonJS, so the import is a promise rather than a
        // top-level await, and a refusal ends the process the way a release
        // script's own `fail` does: the message on stderr, the code 1.
        'import(pathToFileURL(process.env.PROBE_MODULE).href).then((helper) => {',
        '  const assets = JSON.parse(process.env.PROBE_ASSETS)',
        '  const unreadable = new Set(JSON.parse(process.env.PROBE_UNREADABLE))',
        '  const history = helper.publishedManifest(process.env.PROBE_CHANNEL, "owner/repo", {',
        '    read: (name) => {',
        '      if (unreadable.has(name)) throw new Error("error connecting to api.github.com: no route to host")',
        '      const value = assets[name]',
        '      return value === undefined ? null : Buffer.from(value, "base64")',
        '    },',
        '    list: () => Object.keys(assets),',
        '  })',
        '  process.stdout.write(JSON.stringify(history))',
        '}).catch((error) => {',
        '  console.error(`release-update: ${error instanceof Error ? error.message : String(error)}`)',
        '  process.exit(1)',
        '})',
      ].join('\n'),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROBE_MODULE: fileURLToPath(
          new URL('../scripts/release-update-common.ts', import.meta.url),
        ),
        PROBE_ASSETS: JSON.stringify(assets),
        PROBE_UNREADABLE: JSON.stringify(options.unreadable ?? []),
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
    signature: {
      keyId: key.keyId,
      signature: sign(null, signed, key.privateKey).toString('base64'),
    },
    keys: keySet([{ keyId: key.keyId, publicKey: key.publicKey }]),
  })
  assert.equal(run.code, 1)
  assert.match(run.out, /does not match the signature beside it/u)
})

test('a channel with nothing published yet is read as no history', () => {
  const run = runProducer({ manifest: null, signature: null, keys: keySet([]) })
  assert.equal(run.code, 0, `a brand new channel is not a failure: ${run.out}`)
  assert.match(run.out, /has no published update-stable\.json yet/u)
  assert.match(run.out, /null/u)
})

test('a channel this release cannot read stops the release', () => {
  // The failure that matters most here is the one that looks like an empty
  // channel. A reader that could not answer is not an answer, and a sequence
  // minted over it would be minted over a history nobody has read.
  const key = releaseKey()
  const run = runProducer({
    manifest: signedManifest('stable', '1.4.0', 12),
    signature: {
      keyId: key.keyId,
      signature: sign(null, Buffer.from('{}'), key.privateKey).toString('base64'),
    },
    keys: keySet([{ keyId: key.keyId, publicKey: key.publicKey }]),
    unreadable: ['update-stable.json'],
  })
  assert.equal(run.code, 1, 'the release publishes nothing rather than start the count over')
  assert.match(run.out, /could not be read/u)
  assert.match(run.out, /no route to host/u)
  assert.doesNotMatch(run.out, /has no published/u)
})

test('a signature with no manifest beside it is not an empty channel', () => {
  const key = releaseKey()
  const run = runProducer({
    manifest: null,
    signature: {
      keyId: key.keyId,
      signature: sign(null, Buffer.from('{}'), key.privateKey).toString('base64'),
    },
    keys: keySet([{ keyId: key.keyId, publicKey: key.publicKey }]),
  })
  assert.equal(run.code, 1)
  assert.match(run.out, /publishes a signature with no manifest beside it/u)
})

test('a manifest with no signature beside it is not this channel’s history', () => {
  const run = runProducer({
    manifest: signedManifest('stable', '1.4.0', 12),
    signature: null,
    keys: keySet([]),
  })
  assert.equal(run.code, 1)
  assert.match(run.out, /with no signature beside it/u)
})

test('the producer’s own reader asks gh for the channel’s manifest', {
  // The default reader shells out to `gh`, which is a release job's tool, and
  // the job that publishes runs on ubuntu-24.04. It is exercised here with a
  // stand-in rather than the network, and the stand-in is the only program the
  // child can find: the search path is the fixture directory alone, so a fixture
  // that is missing, or present but not executable, is a command that fails and
  // a release that stops — never a real `gh` on this machine, and never the
  // network. The stand-in is a Node script with an absolute interpreter, so it
  // depends on no shell and on nothing else being found by name either.
  skip:
    process.platform === 'win32' ? 'the reader is proven on the platform that publishes' : false,
}, () => {
  const key = releaseKey()
  const manifest = signedManifest('stable', '1.4.0', 12)
  const bytes = Buffer.from(JSON.stringify(manifest))
  const root = mkdtempSync(join(tmpdir(), 'git-stacks-gh-'))
  const assets = join(root, 'assets')
  const tools = join(root, 'tools')
  mkdirSync(join(root, 'resources'), { recursive: true })
  mkdirSync(assets, { recursive: true })
  mkdirSync(tools, { recursive: true })
  writeFileSync(
    join(root, 'resources', 'update-trusted-keys.json'),
    JSON.stringify(keySet([{ keyId: key.keyId, publicKey: key.publicKey }])),
  )
  writeFileSync(join(assets, 'update-stable.json'), bytes)
  writeFileSync(
    join(assets, 'update-stable.json.sig'),
    JSON.stringify({
      keyId: key.keyId,
      signature: sign(null, bytes, key.privateKey).toString('base64'),
    }),
  )
  writeFileSync(
    join(tools, 'gh'),
    [
      `#!${process.execPath}`,
      'const { copyFileSync, readdirSync, existsSync } = require("node:fs")',
      'const { join } = require("node:path")',
      'const flags = process.argv.slice(2)',
      'let dir = null',
      'let name = null',
      'for (let at = 0; at < flags.length; at += 1) {',
      '  if (flags[at] === "--dir") { dir = flags[at + 1]; at += 1 }',
      '  if (flags[at] === "--pattern") { name = flags[at + 1]; at += 1 }',
      '}',
      'if (flags[0] === "release" && flags[1] === "view") {',
      '  if (existsSync(process.env.PROBE_ASSETS_DIR)) process.stdout.write(readdirSync(process.env.PROBE_ASSETS_DIR).join("\\n"))',
      '  else { process.stderr.write("release not found\\n"); process.exit(1) }',
      '} else {',
      '  const source = join(process.env.PROBE_ASSETS_DIR, name)',
      '  try {',
      '    copyFileSync(source, join(dir, name))',
      '  } catch {',
      '    process.stderr.write("release not found\\n")',
      '    process.exit(1)',
      '  }',
      '}',
    ].join('\n'),
    { mode: 0o755 },
  )
  admitOwnedProviderCliRoot(tools)
  const run = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--eval',
      [
        'import { pathToFileURL } from "node:url"',
        'import(pathToFileURL(process.env.PROBE_MODULE).href).then((helper) => {',
        '  process.stdout.write(JSON.stringify(helper.publishedManifest("stable", "owner/repo")))',
        '}).catch((error) => {',
        '  console.error(`release-update: ${error instanceof Error ? error.message : String(error)}`)',
        '  process.exit(1)',
        '})',
      ].join('\n'),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: tools,
        PROBE_ASSETS_DIR: assets,
        PROBE_MODULE: fileURLToPath(
          new URL('../scripts/release-update-common.ts', import.meta.url),
        ),
      },
    },
  )
  rmSync(root, { recursive: true, force: true })
  assert.equal(
    run.status,
    0,
    `the reader read what the release publishes: ${run.stdout}${run.stderr}`,
  )
  assert.match(`${run.stdout}`, /"sequence":12/u)
  assert.match(`${run.stdout}`, /"version":"1\.4\.0"/u)
})
