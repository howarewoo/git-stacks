import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import test from 'node:test'
import {
  MAX_UPDATE_MANIFEST_BYTES,
  RELEASE_LOCATION_ORIGIN,
  RELEASE_LOCATION_PATH_PREFIX,
  compareVersions,
  evaluateUpdateManifest,
  parseSignatureEnvelope,
  parseUpdateManifest,
  toUpdateOffer,
  type UpdateManifest,
} from '../src/shared/update'
import { verifyDetachedSignature } from '../src/main/update/signature'
import { insideFeed, resolveUpdateFeed } from '../src/main/update/feed'
import { trustedUpdateKeys } from '../src/main/update/keys'

const NOW = Date.parse('2026-09-29T12:00:00.000Z')
const ARTIFACT_BYTES = Buffer.from('a signed installer would go here')

function manifestBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      channel: 'stable',
      version: '0.2.0',
      sequence: 7,
      issuedAt: new Date(NOW - 60_000).toISOString(),
      expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
      notes: 'Signed release fixture.',
      artifacts: [
        {
          platform: 'darwin',
          arch: 'arm64',
          kind: 'dmg',
          fileName: 'Git-Stacks-0.2.0-arm64.dmg',
          url: `${RELEASE_LOCATION_ORIGIN}${RELEASE_LOCATION_PATH_PREFIX}updates-stable/v0.2.0/Git-Stacks-0.2.0-arm64.dmg`,
          sha256: createHash('sha256').update(ARTIFACT_BYTES).digest('hex'),
          size: ARTIFACT_BYTES.length,
        },
      ],
      ...overrides,
    }),
  )
}

function parse(overrides: Record<string, unknown> = {}) {
  const outcome = parseUpdateManifest(manifestBytes(overrides))
  assert.equal(outcome.ok, true, 'the fixture manifest must parse before it is varied')
  if (!outcome.ok) throw new Error('unreachable')
  return outcome.value
}

const RELEASE_PATH = `${RELEASE_LOCATION_PATH_PREFIX}updates-stable/`

function expectations(overrides: Partial<Parameters<typeof evaluateUpdateManifest>[1]> = {}) {
  return {
    channel: 'stable' as const,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    currentVersion: '0.1.0',
    seenSequence: 0,
    now: NOW,
    allowedOrigin: RELEASE_LOCATION_ORIGIN,
    allowedPathPrefix: RELEASE_PATH,
    ...overrides,
  }
}

test('a signed manifest becomes an offer only for the machine it was signed for', () => {
  const manifest = parse()
  const accepted = evaluateUpdateManifest(manifest, expectations())
  assert.equal(accepted.ok, true)
  assert.deepEqual(
    toUpdateOffer(manifest, accepted.ok ? accepted.value : (manifest.artifacts[0] as never)),
    {
      channel: 'stable',
      version: '0.2.0',
      sequence: 7,
      notes: 'Signed release fixture.',
      rollbackOf: null,
      platform: 'darwin',
      arch: 'arm64',
      kind: 'dmg',
      fileName: 'Git-Stacks-0.2.0-arm64.dmg',
      size: ARTIFACT_BYTES.length,
      sha256: createHash('sha256').update(ARTIFACT_BYTES).digest('hex'),
    },
  )
})

test('a manifest for another platform, channel, or architecture is refused by name', () => {
  const manifest = parse()
  for (const [overrides, reason] of [
    [{ platform: 'win32' as const }, 'platform'],
    [{ arch: 'x64' as const }, 'platform'],
    [{ channel: 'beta' as const }, 'channel'],
  ] as const) {
    const outcome = evaluateUpdateManifest(manifest, expectations(overrides))
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.failure.reason, reason)
  }
})

test('a manifest that is not newer than this build is a refusal, never a downgrade', () => {
  const outcome = evaluateUpdateManifest(
    parse({ version: '0.1.0' }),
    expectations({ currentVersion: '0.1.0' }),
  )
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.failure.reason, 'not-newer')
})

test('a signed release that names what it rolls back may be older, and one that does not may not', () => {
  const installed = { currentVersion: '0.3.0' }
  const authorised = evaluateUpdateManifest(
    parse({ version: '0.2.0', rollbackOf: '0.3.0', sequence: 9 }),
    expectations(installed),
  )
  assert.equal(authorised.ok, true)
  if (authorised.ok) {
    assert.equal(
      toUpdateOffer(parse({ version: '0.2.0', rollbackOf: '0.3.0' }), authorised.value).rollbackOf,
      '0.3.0',
    )
  }
  for (const rollbackOf of [null, '0.4.0', '0.2.0']) {
    const outcome = evaluateUpdateManifest(
      parse({ version: '0.2.0', rollbackOf, sequence: 9 }),
      expectations(installed),
    )
    assert.equal(
      outcome.ok,
      false,
      `rollbackOf ${String(rollbackOf)} must not authorise a downgrade`,
    )
    if (!outcome.ok) assert.equal(outcome.failure.reason, 'not-newer')
  }
})

test('a release sequence older than one already seen is refused as a replay', () => {
  const outcome = evaluateUpdateManifest(parse({ sequence: 3 }), expectations({ seenSequence: 4 }))
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.failure.reason, 'replayed')
})

test('an expired or far-future manifest is refused', () => {
  const expired = parse({ expiresAt: new Date(NOW - 1_000).toISOString() })
  const stale = evaluateUpdateManifest(expired, expectations())
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.failure.reason, 'expired')
  const future = evaluateUpdateManifest(
    parse({ issuedAt: new Date(NOW + 86_400_000).toISOString() }),
    expectations(),
  )
  assert.equal(future.ok, false)
  if (!future.ok) assert.equal(future.failure.reason, 'issued-in-future')
})

test('an artifact outside the pinned release location, or with another name, is refused', () => {
  for (const url of [
    'https://evil.example.com/v0.2.0/Git-Stacks-0.2.0-arm64.dmg',
    'http://github.com/howarewoo/git-stacks/releases/download/v0.2.0/Git-Stacks-0.2.0-arm64.dmg',
    `${RELEASE_LOCATION_ORIGIN}/howarewoo/other/releases/download/v0.2.0/Git-Stacks-0.2.0-arm64.dmg`,
    `${RELEASE_LOCATION_ORIGIN}${RELEASE_LOCATION_PATH_PREFIX}v0.2.0/other.dmg`,
    `${RELEASE_LOCATION_ORIGIN}${RELEASE_LOCATION_PATH_PREFIX}v0.2.0/Git-Stacks-0.2.0-arm64.dmg?x=1`,
  ]) {
    const manifest = parse()
    manifest.artifacts[0]!.url = url
    const outcome = evaluateUpdateManifest(manifest, expectations())
    assert.equal(outcome.ok, false, `${url} must be refused`)
    if (!outcome.ok) assert.equal(outcome.failure.reason, 'malformed-url')
  }
})

test('a manifest field this build does not understand is refused rather than ignored', () => {
  const outcome = parseUpdateManifest(manifestBytes({ mirror: 'https://elsewhere.invalid' }))
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.failure.reason, 'schema')
})

test('a manifest too large to be a manifest is refused unread', () => {
  const outcome = parseUpdateManifest(Buffer.alloc(MAX_UPDATE_MANIFEST_BYTES + 1, 0x20))
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.failure.reason, 'oversize')
})

test('a malformed signature envelope is refused before any key is consulted', () => {
  for (const text of ['not json', '{}', '{"schema":1,"keyId":"a","signature":"!!!"}']) {
    const outcome = parseSignatureEnvelope(Buffer.from(text))
    assert.equal(outcome.ok, false, `${text} must be refused`)
  }
})

test('an Ed25519 signature over these exact bytes verifies, and a tampered manifest does not', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const key = {
    keyId: 'fixture-key',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-12-01T00:00:00.000Z',
  }
  const bytes = manifestBytes()
  const signature = signBytes(null, bytes, privateKey).toString('base64')
  assert.equal(verifyDetachedSignature(key, bytes, signature, NOW), true)

  const tampered = Buffer.from(bytes)
  tampered[tampered.length - 3] = tampered[tampered.length - 3] === 0x31 ? 0x32 : 0x31
  assert.notDeepEqual(tampered.toString(), bytes.toString())
  assert.equal(
    verifyDetachedSignature(key, tampered, signature, NOW),
    false,
    'a manifest edited after signing must not verify',
  )
})

test('a signature made by another key, or outside the key’s window, is refused', () => {
  const trusted = generateKeyPairSync('ed25519')
  const other = generateKeyPairSync('ed25519')
  const key = {
    keyId: 'fixture-key',
    publicKey: trusted.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-12-01T00:00:00.000Z',
  }
  const bytes = manifestBytes()
  assert.equal(
    verifyDetachedSignature(
      key,
      bytes,
      signBytes(null, bytes, other.privateKey).toString('base64'),
      NOW,
    ),
    false,
    'another key’s signature must not verify',
  )
  assert.equal(
    verifyDetachedSignature(
      key,
      bytes,
      signBytes(null, bytes, trusted.privateKey).toString('base64'),
      NOW,
    ),
    true,
  )
  assert.equal(
    verifyDetachedSignature(
      key,
      bytes,
      signBytes(null, bytes, trusted.privateKey).toString('base64'),
      Date.parse('2027-01-01T00:00:00.000Z'),
    ),
    false,
    'a retired key must stop verifying',
  )
})

test('a build with no committed key trusts nothing and refuses an environment key once packaged', () => {
  const committed = trustedUpdateKeys({}, false)
  assert.deepEqual(committed.trust, 'none')
  assert.deepEqual(committed.keys, [])
  const development = trustedUpdateKeys(
    {
      GIT_STACKS_UPDATE_KEY_ID: 'fixture-key',
      GIT_STACKS_UPDATE_PUBLIC_KEY: 'MCowBQYDK2VwAyEA',
    },
    false,
  )
  assert.equal(development.trust, 'development')
  assert.equal(development.keys.length, 1)
  const packaged = trustedUpdateKeys(
    {
      GIT_STACKS_UPDATE_KEY_ID: 'fixture-key',
      GIT_STACKS_UPDATE_PUBLIC_KEY: 'MCowBQYDK2VwAyEA',
    },
    true,
  )
  assert.equal(packaged.trust, 'none', 'an installed app must not trust an environment key')
})

test('the feed is the pinned release location, and a packaged build cannot be pointed elsewhere', () => {
  const production = resolveUpdateFeed('stable', {}, true)
  assert.equal(production.ok, true)
  if (!production.ok) return
  assert.equal(production.value.origin, RELEASE_LOCATION_ORIGIN)
  assert.equal(production.value.trust, 'release')
  assert.equal(
    production.value.manifestUrl,
    `${RELEASE_LOCATION_ORIGIN}${RELEASE_LOCATION_PATH_PREFIX}updates-stable/update-stable.json`,
  )
  const repointed = resolveUpdateFeed(
    'stable',
    { GIT_STACKS_UPDATE_FEED_BASE: 'https://elsewhere.invalid/feed' },
    true,
  )
  assert.equal(repointed.ok, true)
  if (repointed.ok) {
    assert.equal(
      repointed.value.origin,
      RELEASE_LOCATION_ORIGIN,
      'a packaged build keeps the compiled-in location whatever the environment says',
    )
  }
  const fixture = resolveUpdateFeed(
    'beta',
    { GIT_STACKS_UPDATE_FEED_BASE: 'https://127.0.0.1:8443/feed' },
    false,
  )
  assert.equal(fixture.ok, true)
  if (!fixture.ok) return
  assert.equal(fixture.value.trust, 'development')
  assert.equal(fixture.value.manifestUrl, 'https://127.0.0.1:8443/feed/update-beta.json')
})

test('only addresses inside the feed are fetchable', () => {
  const feed = resolveUpdateFeed('stable', {}, true)
  assert.equal(feed.ok, true)
  if (!feed.ok) return
  assert.equal(
    insideFeed(feed.value, new URL(feed.value.manifestUrl)),
    true,
    'the manifest this feed points at is inside the feed',
  )
  for (const url of [
    'https://evil.example.com/x.json',
    'http://github.com/howarewoo/git-stacks/releases/download/updates-stable/x.json',
    `${RELEASE_LOCATION_ORIGIN}/howarewoo/git-stacks/releases/download/elsewhere/x.json`,
    'https://user:pass@github.com/howarewoo/git-stacks/releases/download/updates-stable/x.json',
  ]) {
    assert.equal(insideFeed(feed.value, new URL(url)), false, `${url} must not be fetchable`)
  }
})

test('versions order so a pre-release never passes for the release it precedes', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0)
  assert.ok(compareVersions('0.2.0-beta.1', '0.2.0') < 0)
  assert.ok(compareVersions('0.2.0-beta.2', '0.2.0-beta.1') > 0)
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
})

test('a fixture manifest is the one this suite signs and offers', () => {
  // Guards the fixture itself: if the shape changes, every refusal above is
  // testing something other than what it names.
  const manifest: UpdateManifest = parse()
  assert.equal(manifest.artifacts.length, 1)
  assert.equal(manifest.channel, 'stable')
})

test('a macOS architecture is recognised under every name it is called', async () => {
  // The signed manifest says `x64`; lipo reports the Mach-O name `x86_64`. A
  // comparison of the two strings refuses every valid Intel or universal build
  // on an Intel Mac, so both names have to reach the same conclusion.
  const { machArchitectures } = await import('../src/main/update/install')
  assert.deepEqual([...machArchitectures('x64')].sort(), ['x64', 'x86_64'])
  assert.deepEqual([...machArchitectures('x86_64')].sort(), ['x64', 'x86_64'])
  assert.deepEqual([...machArchitectures('arm64')].sort(), ['aarch64', 'arm64'])
  // A universal binary reports both slices, and either satisfies a machine.
  const universal = 'x86_64 arm64'.split(/\s+/u).flatMap(machArchitectures)
  assert.ok(universal.includes('x64'), 'an Intel slice satisfies an x64 update')
  assert.ok(universal.includes('arm64'), 'an Apple Silicon slice satisfies an arm64 update')
  assert.equal(universal.includes('ia32'), false, 'a 32-bit slice satisfies nothing')
})
