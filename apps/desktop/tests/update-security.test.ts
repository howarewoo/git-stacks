import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
} from '@git-stacks/shared/update'
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

test('where the trusted keys come from, and where they cannot come from', async () => {
  // The key set built into a binary is a parameter here, so each rule can be
  // stated against the key sets it is about. A test that read this repository's
  // own file would be asserting what the checkout holds — which is empty in a
  // working tree and is the release key inside a release job — and would pass or
  // fail with the checkout rather than with the rule.
  const { trustedUpdateKeys } = await import('../src/main/update/keys')
  const development = {
    GIT_STACKS_UPDATE_KEY_ID: 'fixture-key',
    GIT_STACKS_UPDATE_PUBLIC_KEY: 'MCowBQYDK2VwAyEA',
  }
  const released = [
    {
      keyId: 'release-2026',
      publicKey: 'MCowBQYDK2VwAyEA',
      validFrom: '2020-01-01T00:00:00.000Z',
      validUntil: null,
    },
  ]

  // Nothing built in and nothing configured: there is no key to trust, and
  // saying so is the answer rather than a weaker key from somewhere else.
  const bare = trustedUpdateKeys({}, false, [])
  assert.deepEqual(bare.trust, 'none')
  assert.deepEqual(bare.keys, [])

  // A development build may be configured from its environment, and reports
  // exactly that much trust rather than the trust a release carries.
  const configured = trustedUpdateKeys(development, false, [])
  assert.equal(configured.trust, 'development')
  assert.deepEqual(
    configured.keys.map((key) => key.keyId),
    ['fixture-key'],
  )

  // The same environment, once packaged: an installed app takes its keys from
  // its own bundle and nowhere else, because whoever starts a process decides
  // that process's environment.
  assert.deepEqual(trustedUpdateKeys(development, true, []), { keys: [], trust: 'none' })

  // A built-in key set is the whole answer, and an environment key is not added
  // to it or preferred over it.
  const release = trustedUpdateKeys(development, false, released)
  assert.equal(release.trust, 'release')
  assert.deepEqual(
    release.keys.map((key) => key.keyId),
    ['release-2026'],
  )
  assert.equal(
    release.keys.some((key) => key.keyId === 'fixture-key'),
    false,
    'an environment key never joins a built-in key set',
  )
  // And a packaged build trusts the key set it was built with, unchanged.
  assert.deepEqual(trustedUpdateKeys(development, true, released), {
    keys: released,
    trust: 'release',
  })
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

const X64 = 0x01000007
const ARM64 = 0x0100000c
const X86_32 = 7
// The subtype is a different field from the type, and these are the values real
// binaries carry: arm64 and arm64e are subtype 0 and 2, x86_64 is subtype 3. A
// fixture that wrote the type into both bytes would pass a reader reading the
// wrong one, which is exactly the bug these tests exist to catch.
const X64_SUBTYPE = 3
const ARM64_SUBTYPE = 0
const ARM64E_SUBTYPE = 2

/**
 * A thin Mach-O header, as it appears inside a file: the type at byte 4 and the
 * subtype at byte 8, which are the values a real binary has.
 */
function thinHeader(
  cpuType: number,
  sixtyFour = true,
  littleEndian = true,
  cpuSubtype = cpuType === X64 ? X64_SUBTYPE : cpuType === X86_32 ? 3 : ARM64_SUBTYPE,
): Buffer {
  const buffer = Buffer.alloc(4096)
  const write = (value: number, at: number) => {
    if (littleEndian) buffer.writeUInt32LE(value, at)
    else buffer.writeUInt32BE(value, at)
  }
  write(sixtyFour ? 0xfeedfacf : 0xfeedface, 0)
  write(cpuType, 4)
  write(cpuSubtype, 8)
  return buffer
}

/**
 * A universal binary with the given slices at their real offsets, and a table
 * that says so. `forge` replaces one table entry, so a test can point the table
 * at something it does not describe.
 */
function universalBinary(
  slices: { cpuType: number; sixtyFour?: boolean }[],
  options: {
    fat64?: boolean
    littleEndianTable?: boolean
    forge?: (entry: Buffer, index: number) => void
  } = {},
): Buffer {
  const sixtyFour = options.fat64 === true
  const entrySize = sixtyFour ? 32 : 20
  const headerBytes = 8 + slices.length * entrySize
  const align = 4096
  const offsets: number[] = []
  let cursor = Math.ceil(headerBytes / align) * align
  for (const slice of slices) {
    offsets.push(cursor)
    cursor += align
  }
  const file = Buffer.alloc(cursor)
  const writeTable = (value: number, at: number, width: 4 | 8) => {
    if (options.littleEndianTable === true) {
      if (width === 4) file.writeUInt32LE(value, at)
      else file.writeBigUInt64LE(BigInt(value), at)
    } else {
      if (width === 4) file.writeUInt32BE(value, at)
      else file.writeBigUInt64BE(BigInt(value), at)
    }
  }
  writeTable(sixtyFour ? 0xcafebabf : 0xcafebabe, 0, 4)
  writeTable(slices.length, 4, 4)
  slices.forEach((slice, index) => {
    const at = 8 + index * entrySize
    writeTable(slice.cpuType, at, 4)
    writeTable(0, at + 4, 4)
    if (sixtyFour) {
      writeTable(offsets[index] ?? 0, at + 8, 8)
      writeTable(align, at + 16, 8)
    } else {
      writeTable(offsets[index] ?? 0, at + 8, 4)
      writeTable(align, at + 12, 4)
    }
    thinHeader(slice.cpuType, slice.sixtyFour ?? true).copy(file, offsets[index] ?? 0)
    options.forge?.(file.subarray(at, at + entrySize), index)
  })
  return file
}

test('a Mach-O file is read without a developer tool, and only what it really carries', async (t) => {
  // `lipo` is not installed on a machine that has never had Xcode on it, and an
  // update that needs it is an update that cannot be installed. What is read
  // here instead is the file's own headers, and each case below is a way a file
  // could claim an architecture it does not have.
  const { readMachArchitectures } = await import('../src/main/update/install')
  const directory = mkdtempSync(join(tmpdir(), 'git-stacks-macho-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = (name: string, bytes: Buffer) => {
    const path = join(directory, name)
    writeFileSync(path, bytes)
    return path
  }

  // A single-architecture 64-bit build, in both byte orders, and the two ways a
  // person writes its name.
  // The two fixtures below are the layout a real binary has: the CPU type at
  // byte 4, the CPU subtype at byte 8, and those bytes differ. An arm64 binary
  // carries subtype 0 and an x86_64 one subtype 3, so a reader that took the
  // architecture from the subtype would answer "no architecture" for both and
  // refuse a correctly signed update on the machine it was built for.
  assert.deepEqual(readMachArchitectures(file('arm64', thinHeader(ARM64))), ['arm64'])
  assert.deepEqual(readMachArchitectures(file('x64', thinHeader(X64))), ['x64'])
  assert.deepEqual(
    readMachArchitectures(file('arm64e', thinHeader(ARM64, true, true, ARM64E_SUBTYPE))),
    ['arm64'],
    'an arm64e slice is arm64 whatever its subtype says',
  )
  assert.deepEqual(
    readMachArchitectures(file('swapped', thinHeader(X64, true, false))),
    ['x64'],
    'a big-endian header is read in the order it declares',
  )
  assert.deepEqual(
    readMachArchitectures(file('arm64e-plain', thinHeader(ARM64, true, true, ARM64E_SUBTYPE))),
    ['arm64'],
  )

  // A 32-bit build is not a 64-bit machine's build, whichever family it is.
  assert.deepEqual(readMachArchitectures(file('i386', thinHeader(X86_32, false))), [])
  assert.deepEqual(
    readMachArchitectures(file('i386-named-64', thinHeader(X86_32, false))),
    [],
    'a 32-bit header claiming the 64-bit magic is refused',
  )
  assert.deepEqual(
    readMachArchitectures(file('arm64-magic-32-cpu', thinHeader(X86_32, true))),
    [],
    'a 64-bit magic without the 64-bit ABI bit is refused',
  )

  // Universal builds: both table widths, both table byte orders, and the same
  // slices either way round.
  assert.deepEqual(
    readMachArchitectures(file('fat', universalBinary([{ cpuType: ARM64 }, { cpuType: X64 }]))),
    ['arm64', 'x64'],
  )
  assert.deepEqual(
    readMachArchitectures(
      file('fat64', universalBinary([{ cpuType: ARM64 }, { cpuType: X64 }], { fat64: true })),
    ),
    ['arm64', 'x64'],
  )
  assert.deepEqual(
    readMachArchitectures(
      file(
        'fat-le',
        universalBinary([{ cpuType: X64 }, { cpuType: ARM64 }], { littleEndianTable: true }),
      ),
    ),
    ['arm64', 'x64'],
  )
  assert.deepEqual(
    readMachArchitectures(
      file(
        'fat-32bit-slice',
        universalBinary([{ cpuType: ARM64 }, { cpuType: X86_32, sixtyFour: false }]),
      ),
    ),
    ['arm64'],
    'a 32-bit slice does not make a 64-bit build',
  )

  // The table says where a slice is; the header there has to agree.
  assert.deepEqual(
    readMachArchitectures(
      file(
        'forged-cpu',
        universalBinary([{ cpuType: ARM64 }], {
          forge: (entry) => entry.writeUInt32BE(X64, 0),
        }),
      ),
    ),
    [],
    'a table entry naming one architecture over a slice of another is refused',
  )
  assert.deepEqual(
    readMachArchitectures(
      file(
        'forged-width',
        universalBinary([{ cpuType: ARM64 }], {
          forge: (entry) => {
            entry.writeUInt32BE(X86_32, 0)
            entry.writeUInt32BE(0, 4)
          },
        }),
      ),
    ),
    [],
    'a table entry claiming a 32-bit slice over a 64-bit one is refused',
  )
  // Offsets and sizes are bounds, not suggestions.
  assert.deepEqual(
    readMachArchitectures(
      file(
        'offset-past-end',
        universalBinary([{ cpuType: ARM64 }], {
          forge: (entry) => entry.writeUInt32BE(1 << 20, 8),
        }),
      ),
    ),
    [],
    'a slice pointing past the end of the file is refused',
  )
  assert.deepEqual(
    readMachArchitectures(
      file(
        'size-past-end',
        universalBinary([{ cpuType: ARM64 }], {
          forge: (entry) => entry.writeUInt32BE(1 << 20, 12),
        }),
      ),
    ),
    [],
    'a slice claiming to be larger than the file is refused',
  )
  assert.deepEqual(
    readMachArchitectures(
      file(
        'offset-into-table',
        universalBinary([{ cpuType: ARM64 }], {
          forge: (entry) => entry.writeUInt32BE(0, 8),
        }),
      ),
    ),
    [],
    'a slice pointing into the table is refused',
  )

  // A table that claims more slices than a table can hold, and a file that
  // stops in the middle of one.
  const many = Buffer.from(universalBinary([{ cpuType: ARM64 }]))
  many.writeUInt32BE(1 << 20, 4)
  assert.deepEqual(readMachArchitectures(file('too-many', many)), [])
  const truncated = universalBinary([{ cpuType: ARM64 }, { cpuType: X64 }]).subarray(0, 4200)
  assert.deepEqual(readMachArchitectures(file('truncated', truncated)), [])
  const halfHeader = thinHeader(ARM64).subarray(0, 4)
  assert.deepEqual(readMachArchitectures(file('four-bytes', halfHeader)), [])
  assert.deepEqual(readMachArchitectures(file('empty', Buffer.alloc(0))), [])
  assert.deepEqual(readMachArchitectures(file('text', Buffer.from('#!/bin/sh\nexit 0\n'))), [])
  assert.deepEqual(readMachArchitectures(join(directory, 'not-here')), [])
})

test('the architecture check compares one name on both sides', async () => {
  const { canonicalArchitecture, machArchitectures } = await import('../src/main/update/install')
  assert.equal(canonicalArchitecture('x86_64'), 'x64')
  assert.equal(canonicalArchitecture('x64'), 'x64')
  assert.equal(canonicalArchitecture('aarch64'), 'arm64')
  assert.equal(canonicalArchitecture('arm64'), 'arm64')
  // An architecture neither side recognises is still compared, not dropped.
  assert.equal(canonicalArchitecture('sparc'), 'sparc')
  assert.deepEqual(machArchitectures('x86_64'), ['x64', 'x86_64'])
})

test('the Windows PowerShell is named by the system directory, or not at all', async () => {
  const { windowsPowerShellPath } = await import('../src/main/update/install')
  // The one value Windows itself reports is the only thing trusted to name the
  // interpreter: a `powershell.exe` in the directory the app was started in would
  // otherwise be run, and believed about a signature, before anything had been
  // checked.
  assert.equal(
    windowsPowerShellPath('C:\\Windows'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  for (const refused of [
    undefined,
    '',
    'Windows',
    'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\..\\..\\Program Files',
  ]) {
    assert.throws(
      () => windowsPowerShellPath(refused),
      /system directory|absolute Windows path|system path/u,
      `refuses ${JSON.stringify(refused)}`,
    )
  }
})
