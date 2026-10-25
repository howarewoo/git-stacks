import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { compareVersions } from '@git-stacks/shared/update'
import {
  automaticReleaseBody,
  chooseBeta,
  nextBetaVersion,
  publishImmutable,
  readReservation,
  requireReleaseOwner,
  type ReleaseIdentity,
  type Tag,
} from '../scripts/release-desktop'
import { publishedManifest } from '../scripts/release-update-common'

const first = 'a'.repeat(40)
const second = 'b'.repeat(40)
const third = 'c'.repeat(40)
const reservation = (version: string, sourceSha = first): Tag => ({
  name: `v${version}`,
  sourceSha,
  reservation: readReservation(
    JSON.stringify({ schema: 1, kind: 'git-stacks-automatic-beta', sourceSha, version }),
    `v${version}`,
    sourceSha,
  ),
})

const identity: ReleaseIdentity = {
  sourceSha: first,
  version: '0.1.1-beta.1',
  tag: 'v0.1.1-beta.1',
  channel: 'beta',
  automatic: true,
}

test('allocation advances numeric beta history, drafts and established stable cores', () => {
  assert.equal(nextBetaVersion('0.1.0', []), '0.1.1-beta.1')
  assert.equal(nextBetaVersion('0.1.0', ['0.1.1-beta.9', '0.1.1-beta.10']), '0.1.1-beta.11')
  assert.equal(nextBetaVersion('0.1.0', ['0.2.0', '0.1.1-beta.50']), '0.2.1-beta.1')
  assert.equal(nextBetaVersion('0.1.0', ['0.3.0-beta.12']), '0.3.0-beta.13')
  assert.equal(nextBetaVersion('0.1.0', ['0.3.0-rc.1']), '0.3.1-beta.1')
  assert.ok(compareVersions('0.1.1-beta.10', '0.1.1-beta.9') > 0)
  assert.ok(compareVersions('0.1.1', '0.1.1-beta.10') > 0)
  assert.throws(
    () => nextBetaVersion('0.1.0', ['0.1.1-beta.9007199254740991']),
    /counter exhausted/,
  )
})

test('reservation survives a failed draft creation and a rerun never spends a second version', () => {
  const original = chooseBeta({
    sourceSha: first,
    established: '0.1.0',
    tags: [],
    versions: [],
    isAncestor: () => true,
  })
  const reserved = reservation(original.version)
  const rerun = chooseBeta({
    sourceSha: first,
    established: '0.1.0',
    tags: [reserved],
    versions: [],
    isAncestor: (before, after) => before === after,
  })
  assert.deepEqual(rerun, original)
  const next = chooseBeta({
    sourceSha: second,
    established: '0.1.0',
    tags: [reserved],
    versions: [],
    isAncestor: () => true,
  })
  assert.equal(next.version, '0.1.1-beta.2', 'a failed reservation leaves a gap, never a reset')
})

test('verified feed history and unowned version tags prevent resetting the counter', () => {
  const next = chooseBeta({
    sourceSha: third,
    established: '0.1.0',
    tags: [{ name: 'v0.1.1-beta.8', sourceSha: first, reservation: null }],
    versions: ['0.1.1-beta.10'],
    isAncestor: () => true,
  })
  assert.equal(next.version, '0.1.1-beta.11')
})

test('stale queue order, force pushes and ambiguous source ownership fail closed', () => {
  assert.throws(
    () =>
      chooseBeta({
        sourceSha: first,
        established: '0.1.0',
        tags: [reservation('0.1.1-beta.2', second)],
        versions: [],
        isAncestor: () => false,
      }),
    /Stale or divergent/,
  )
  assert.throws(
    () =>
      chooseBeta({
        sourceSha: first,
        established: '0.1.0',
        tags: [reservation('0.1.1-beta.1'), reservation('0.1.1-beta.2')],
        versions: [],
        isAncestor: () => true,
      }),
    /Multiple beta reservations/,
  )
  assert.throws(
    () =>
      chooseBeta({
        sourceSha: 'main',
        established: '0.1.0',
        tags: [],
        versions: [],
        isAncestor: () => true,
      }),
    /exact source SHA/,
  )
})

test('tag and release identity cannot be borrowed from a different SHA or channel', () => {
  assert.equal(readReservation('ordinary annotated tag', identity.tag, first), null)
  assert.throws(
    () =>
      readReservation(
        JSON.stringify({
          schema: 1,
          kind: 'git-stacks-automatic-beta',
          sourceSha: second,
          version: identity.version,
        }),
        identity.tag,
        first,
      ),
    /Conflicting/,
  )
  assert.throws(
    () =>
      requireReleaseOwner(identity, {
        id: 1,
        tag_name: identity.tag,
        body: 'some other release',
        draft: true,
        prerelease: true,
      }),
    /not owned/,
  )
  assert.throws(
    () =>
      requireReleaseOwner(identity, {
        id: 1,
        tag_name: identity.tag,
        body: '',
        draft: false,
        prerelease: false,
      }),
    /not owned/,
  )
  assert.throws(
    () =>
      requireReleaseOwner(
        { ...identity, automatic: false, channel: 'stable' },
        { id: 1, tag_name: identity.tag, body: '', draft: false, prerelease: true },
      ),
    /not owned/,
  )
})

test('generated notes and operator edits survive rerun while conflicting reservation markers fail', () => {
  const notes =
    "## What's Changed\n* A real generated change (#42)\n\nFull Changelog: before...after"
  const release = {
    id: 1,
    tag_name: identity.tag,
    body: automaticReleaseBody(identity, notes),
    draft: true,
    prerelease: true,
  }
  assert.ok(release.body.endsWith(notes))
  assert.doesNotThrow(() => requireReleaseOwner(identity, release))
  const edited = { ...release, body: `${release.body}\n\nOperator clarification.`, draft: false }
  assert.doesNotThrow(() => requireReleaseOwner(identity, edited))
  assert.doesNotThrow(() =>
    requireReleaseOwner(identity, {
      ...release,
      body: release.body.replaceAll('\n', '\r\n'),
    }),
  )
  assert.ok(edited.body.endsWith('Operator clarification.'))
  assert.throws(
    () =>
      requireReleaseOwner(identity, {
        ...release,
        body: automaticReleaseBody({ ...identity, sourceSha: second }, notes),
      }),
    /not owned/,
  )
  assert.throws(
    () =>
      requireReleaseOwner(identity, {
        ...release,
        body: `${release.body}\n${automaticReleaseBody({ ...identity, version: '0.1.1-beta.2' }, notes)}`,
      }),
    /not owned/,
  )
  assert.doesNotThrow(() =>
    requireReleaseOwner(
      { ...identity, channel: 'stable', automatic: false },
      {
        id: 2,
        tag_name: identity.tag,
        body: 'Human stable release notes.',
        draft: false,
        prerelease: false,
      },
    ),
  )
})

test('immutable payload publication recovers a lost response and refuses changed signed bytes', () => {
  const assets = new Map<string, Buffer>()
  let writes = 0
  const bytes = Buffer.from('the verified payload')
  const read = (name: string) => assets.get(name) ?? null
  assert.throws(
    () =>
      publishImmutable('payload', bytes, read, () => {
        writes += 1
        assets.set('payload', bytes)
        throw new Error('response lost after upload')
      }),
    /response lost/,
  )
  publishImmutable('payload', bytes, read, () => {
    writes += 1
  })
  assert.equal(writes, 1, 'retry reads and reuses the exact prior payload')
  assert.throws(
    () =>
      publishImmutable('payload', Buffer.from('rebuilt signatures differ'), read, () => {
        writes += 1
      }),
    /different immutable bytes/,
  )
  assert.equal(writes, 1)
  assert.throws(() => publishImmutable('missing', bytes, read, () => {}), /could not be confirmed/)
})

test('workspace stamping propagates one reserved version without editing its lockfile', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-stacks-release-version-'))
  const manifests = [
    'package.json',
    'apps/desktop/package.json',
    'apps/design/package.json',
    'packages/shared/package.json',
    'packages/ui/package.json',
  ]
  try {
    for (const directory of ['apps/desktop', 'apps/design', 'packages/shared', 'packages/ui'])
      mkdirSync(join(root, directory), { recursive: true })
    for (const path of manifests)
      writeFileSync(
        join(root, path),
        JSON.stringify({ name: path, version: '0.1.0', dependencies: { shared: 'workspace:*' } }),
      )
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'frozen lockfile\n')
    const run = spawnSync(
      process.execPath,
      [
        createRequire(import.meta.url).resolve('tsx/cli'),
        fileURLToPath(new URL('../scripts/release-desktop.ts', import.meta.url)),
        'stamp',
        '--root',
        root,
        '--version',
        identity.version,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    for (const path of manifests) {
      const pkg = JSON.parse(readFileSync(join(root, path), 'utf8'))
      assert.equal(pkg.version, identity.version)
      assert.deepEqual(pkg.dependencies, { shared: 'workspace:*' })
    }
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), 'frozen lockfile\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('allocation reads every authenticated bank even when the feed tip is a rollback or interrupted', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-stacks-beta-history-'))
  const previous = process.cwd()
  const pair = generateKeyPairSync('ed25519')
  try {
    mkdirSync(join(root, 'resources'))
    writeFileSync(
      join(root, 'resources/update-trusted-keys.json'),
      JSON.stringify({
        schema: 1,
        keys: [
          {
            keyId: 'fixture',
            publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
            validFrom: '2020-01-01T00:00:00.000Z',
            validUntil: null,
          },
        ],
      }),
    )
    const assets = new Map<string, Buffer>()
    for (const [sequence, version] of [
      [1, '0.1.1-beta.10'],
      [2, '0.1.1-beta.2'],
    ] as const) {
      const name = `history-beta-${String(sequence).padStart(12, '0')}.json`
      const bytes = Buffer.from(
        JSON.stringify({
          schema: 1,
          channel: 'beta',
          version,
          sequence,
          issuedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
          notes: 'Signed local history fixture.',
          rollbackOf: sequence === 2 ? '0.1.1-beta.10' : null,
          artifacts: [
            {
              platform: 'linux',
              arch: 'x64',
              kind: 'AppImage',
              fileName: 'fixture.AppImage',
              url: 'https://github.com/howarewoo/git-stacks/releases/download/updates-beta/fixture.AppImage',
              sha256: 'a'.repeat(64),
              size: 1,
            },
          ],
        }),
      )
      assets.set(name, bytes)
      assets.set(
        `${name}.sig`,
        Buffer.from(
          JSON.stringify({
            keyId: 'fixture',
            signature: sign(null, bytes, pair.privateKey).toString('base64'),
          }),
        ),
      )
    }
    assets.set('update-beta.json', Buffer.from('an interrupted live replacement'))
    const versions: string[] = []
    process.chdir(root)
    const tip = publishedManifest(
      'beta',
      'howarewoo/git-stacks',
      {
        list: () => [...assets.keys()],
        read: (name) => assets.get(name) ?? null,
      },
      (entry) => versions.push(entry.version),
    )
    assert.equal(tip?.sequence, 2)
    assert.equal(tip?.version, '0.1.1-beta.2')
    assert.deepEqual(versions, ['0.1.1-beta.10', '0.1.1-beta.2'])
    assert.equal(nextBetaVersion('0.1.0', versions), '0.1.1-beta.11')
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
})
