import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import { UpdateSummary } from '../src/renderer/src/components/update-summary'
import { parseUpdateManifest } from '../src/shared/update'
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

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

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

test('the update surface states the key it trusts, not one it infers', () => {
  for (const [trust, expected] of [
    ['none', /No signing key in this build/u],
    ['development', /Development key/u],
    ['release', /Release signing key compiled into this build/u],
  ] as const) {
    const markup = renderToStaticMarkup(
      React.createElement(UpdateSummary, {
        channel: 'stable',
        status: statusWith({ trust }),
      }),
    )
    assert.match(markup, expected, `a build trusting ${trust} says so`)
  }
})

test('the renderer bridge offers no shell, filesystem, or network escape hatch', async () => {
  // The bridge is the renderer's whole reach into the system. Every name it
  // publishes is named here, so a new escape hatch cannot be added quietly.
  const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const exposed = [...preload.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gmu)].map((match) => match[1])
  assert.ok(exposed.length > 20, `the bridge exposes ${exposed.length} methods`)
  for (const forbidden of [
    'shell',
    'exec',
    'execFile',
    'spawn',
    'readFile',
    'writeFile',
    'readdir',
    'fetch',
    'request',
    'http',
    'ipcRenderer',
    'require',
    'openPath',
    'showOpenDialog',
  ]) {
    assert.equal(exposed.includes(forbidden), false, `the bridge must not publish ${forbidden}`)
  }
  for (const required of [
    'recentRepositories',
    'openRepository',
    'settings',
    'updateSettings',
    'checkForUpdates',
    'downloadUpdate',
    'installUpdate',
    'cancelUpdate',
    'updateStatus',
    'onUpdateStatus',
  ]) {
    assert.equal(exposed.includes(required), true, `the bridge must publish ${required}`)
  }
  assert.equal(
    /require\(|process\.binding|nodeIntegration/u.test(preload),
    false,
    'the preload reaches no Node API of its own',
  )
  assert.ok(
    !/contextBridge\.exposeInMainWorld\(\s*['"][^'"]+['"]/.test(preload.replace(/desktop/gu, '')),
    'the preload exposes one named surface',
  )
  assert.ok(repositoryRoot.length > 0)
})

test('a release workflow that could publish unsigned output is refused by its own checks', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-desktop.yml', import.meta.url),
    'utf8',
  )
  // These are the fail-closed lines: without them a missing secret would let
  // packaging continue and produce an artifact nobody can trust.
  for (const required of [
    /test -n "\$UPDATE_SIGNING_KEY"/u,
    /test -n "\$UPDATE_SIGNING_PUBLIC_KEY"/u,
    /test -n "\$CSC_LINK"/u,
    /test -n "\$APPLE_ID"/u,
    /release-trusted-keys\.ts inject/u,
    /release-update-sign\.ts/u,
    /release-update-verify\.ts/u,
    /Get-AuthenticodeSignature/u,
    /codesign --verify/u,
    /stapler validate/u,
  ]) {
    assert.match(workflow, required, 'the release workflow must keep this fail-closed check')
  }
  assert.doesNotMatch(
    workflow,
    /^\s{2}(?:workflow_dispatch|repository_dispatch|schedule):/mu,
    'nothing may trigger a release besides a published release',
  )
  for (const use of workflow.matchAll(/uses:\s*(\S+)/gu)) {
    const reference = use[1] ?? ''
    assert.match(
      reference,
      /@[0-9a-f]{40}(?:\s|$)/u,
      `${reference} must be pinned to a commit, not a moving tag`,
    )
  }
})

test('no private key material is committed anywhere in the tree', async () => {
  for (const path of [
    'resources/update-trusted-keys.json',
    'package.json',
    '.github/workflows/release-desktop.yml',
  ]) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.doesNotMatch(
      text,
      /-----BEGIN (?:.* )?PRIVATE KEY-----/u,
      `${path} must not carry a private key`,
    )
  }
  const registry = JSON.parse(
    await readFile(new URL('../resources/update-trusted-keys.json', import.meta.url), 'utf8'),
  ) as { schema: number; keys: unknown[] }
  assert.equal(registry.schema, 1)
  assert.deepEqual(
    registry.keys,
    [],
    'the committed key set is empty; a real key is injected at release time',
  )
})
