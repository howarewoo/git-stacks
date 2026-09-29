import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import { UpdateSummary } from '../src/renderer/src/components/update-summary'
import { absentFromRelease } from '../scripts/release-update-common'
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
