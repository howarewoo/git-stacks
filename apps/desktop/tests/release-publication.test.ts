import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { admitOwnedProviderCliRoot } from './fixtures/owned-provider-cli'
import {
  assetNameFor,
  historyFileName,
  historySignatureFileName,
  releaseLocation,
} from '../scripts/release-update-common'
import { trustedUpdateKeys, type TrustedUpdateKey } from '../src/main/update/keys'
import { isRecord } from '@git-stacks/shared/guards'
import { verifyDetachedSignature } from '../src/main/update/signature'
import {
  evaluateUpdateManifest,
  parseSignatureEnvelope,
  parseUpdateManifest,
} from '@git-stacks/shared/update'

/**
 * The channel feed's publication protocol, and the overlap a key rotation needs,
 * driven through the real release scripts.
 *
 * Nothing here is a mock of this project's code: every step below is one of the
 * scripts the release workflow runs — key injection, manifest minting, signing,
 * verification, publication — as a child process, in a working directory of the
 * run's own, with real Ed25519 keys generated for that run and a real signed
 * manifest. The one thing replaced is GitHub, by a `gh` on the search path that
 * serves a directory as the moving release and fails on command. The interruption
 * points are therefore the real ones: a `gh release upload --clobber` that
 * deletes the asset it is about to replace and then fails, exactly as a cancelled
 * runner leaves it.
 */
const ROOT = new URL('..', import.meta.url).pathname
const TSX = createRequire(import.meta.url).resolve('tsx/cli')
const REPO = 'howarewoo/git-stacks'
const CHANNEL = 'stable'
const TAG = 'updates-stable'
const MANIFEST = 'update-stable.json'
const SIGNATURE = 'update-stable.json.sig'

/** The release matrix: every build a published manifest has to name. */
const BUILDS = [
  {
    platform: 'darwin',
    arch: 'arm64',
    file: (version: string) => `Git Stacks-${version}-arm64.dmg`,
  },
  { platform: 'darwin', arch: 'x64', file: (version: string) => `Git Stacks-${version}.dmg` },
  { platform: 'win32', arch: 'x64', file: (version: string) => `Git Stacks Setup ${version}.exe` },
  { platform: 'linux', arch: 'x64', file: (version: string) => `Git Stacks-${version}.AppImage` },
] as const

/**
 * The `gh` this run publishes through.
 *
 * It serves a directory as the moving release and speaks only the three calls
 * the release scripts make. `--clobber` is modelled the way `gh` implements it,
 * which is the whole point of the interruption tests: the existing asset is
 * deleted and only then is the new one uploaded, so a run that dies between the
 * two leaves the name missing. `FIXTURE_GH_FAIL_UPLOAD` fails a named upload
 * after that delete, and nothing else in the run is allowed to fail.
 */
const GH_STAND_IN = [
  `#!${process.execPath}`,
  'const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } = require("node:fs")',
  'const { basename, join } = require("node:path")',
  '// argv[0] is node and argv[1] this file, so `gh release <verb> <tag>` lands here.',
  'const verb = process.argv[3]',
  'const tag = process.argv[4]',
  'const args = process.argv.slice(5)',
  'const dir = join(process.env.FIXTURE_RELEASE_DIR, tag)',
  'const option = (name) => args.indexOf(name) === -1 ? null : args[args.indexOf(name) + 1]',
  'const operands = args.filter((arg, at) =>',
  '  !arg.startsWith("--") && !(at > 0 && args[at - 1] === "--repo"),',
  ')',
  'const doomed = (process.env.FIXTURE_GH_FAIL_UPLOAD || "").split(",")',
  'if (verb === "view") {',
  '  if (!existsSync(dir)) { process.stderr.write("release not found\\n"); process.exit(1) }',
  '  process.stdout.write(readdirSync(dir).join("\\n"))',
  '} else if (verb === "download") {',
  '  const name = option("--pattern")',
  '  if (!existsSync(join(dir, name))) {',
  '    process.stderr.write("release not found\\n")',
  '    process.exit(1)',
  '  }',
  '  copyFileSync(join(dir, name), join(option("--dir"), name))',
  '} else if (verb === "upload") {',
  '  // The workflow creates the moving release before this runs, so the release exists by then.',
  '  mkdirSync(dir, { recursive: true })',
  '  for (const file of operands) {',
  '    const target = join(dir, basename(file))',
  '    if (args.includes("--clobber")) rmSync(target, { force: true })',
  '    if (doomed.includes(basename(file))) {',
  '      process.stderr.write("failed to upload: the runner was cancelled\\n")',
  '      process.exit(1)',
  '    }',
  '    copyFileSync(file, target)',
  '  }',
  '} else {',
  '  process.stderr.write(`unexpected gh ${verb}\\n`)',
  '  process.exit(1)',
  '}',
].join('\n')

interface EphemeralKey {
  keyId: string
  /** The secret a release job signs with, as a PKCS#8 PEM. */
  secret: string
  /** The entry the app's key registry holds. */
  registry: TrustedUpdateKey
  privateKey: KeyObject
}

function ephemeralKey(keyId: string, validUntil: string | null = null): EphemeralKey {
  const pair = generateKeyPairSync('ed25519')
  return {
    keyId,
    secret: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    registry: {
      keyId,
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      validFrom: '2020-01-01T00:00:00.000Z',
      validUntil,
    },
    privateKey: pair.privateKey,
  }
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

interface Workspace {
  root: string
  /** The directory the stand-in `gh` serves as the moving release. */
  releaseDir: string
  env: NodeJS.ProcessEnv
  run: (script: string, args: string[], env?: NodeJS.ProcessEnv) => { code: number; out: string }
}

/**
 * A release job: a checkout of this project's scripts, a key set this run
 * injected, and a `gh` that reaches nothing but this run's own directory. The
 * search path is the fixture alone, so a real `gh` on this machine cannot be
 * found and no call can leave it.
 */
function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'git-stacks-publish-'))
  const tools = join(root, 'tools')
  const releaseDir = join(root, 'release')
  mkdirSync(tools, { recursive: true })
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(tools, 'gh'), GH_STAND_IN, { mode: 0o755 })
  // Admitted by name, so the boundary answers for this stand-in and refuses a
  // real `gh` on this machine.
  admitOwnedProviderCliRoot(tools)
  // The repository's published key history starts empty, as the committed file
  // does; a release declares its keys here before they sign anything.
  writeFileSync(
    join(root, 'resources', 'update-history-keys.json'),
    `${JSON.stringify({ schema: 1, keys: [] }, null, 2)}\n`,
  )
  const env: NodeJS.ProcessEnv = {
    PATH: tools,
    FIXTURE_RELEASE_DIR: releaseDir,
  }
  return {
    root,
    releaseDir,
    env,
    run: (script, args, extra = {}) => {
      const result = spawnSync(process.execPath, [TSX, join(ROOT, 'scripts', script), ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...env, ...extra },
      })
      return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
    },
  }
}

/** The key set this run's builds carry, written by the real injection step. */
function injectKeys(space: Workspace, env: Record<string, string>): { code: number; out: string } {
  return space.run('release-trusted-keys.ts', ['inject'], env)
}

/** A public key this repository has declared may sign a channel manifest. */
function declarePublished(space: Workspace, ...keys: EphemeralKey[]): void {
  const path = join(space.root, 'resources', 'update-history-keys.json')
  const declared: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(declared) || declared.schema !== 1 || !Array.isArray(declared.keys)) {
    throw new Error(`${path} is not a key history this test can extend.`)
  }
  const entries = declared.keys
  for (const key of keys) {
    const already = entries.some((entry) => isRecord(entry) && entry.keyId === key.keyId)
    if (!already) entries.push(key.registry)
  }
  writeFileSync(path, `${JSON.stringify(declared, null, 2)}\n`)
}

/** The installers this version packages, and the descriptors naming them. */
function stageInstallers(space: Workspace, version: string, body = 'an installer'): void {
  for (const directory of ['signed-release', 'descriptors']) {
    rmSync(join(space.root, directory), { recursive: true, force: true })
    mkdirSync(join(space.root, directory), { recursive: true })
  }
  for (const build of BUILDS) {
    const fileName = build.file(version)
    writeFileSync(join(space.root, 'signed-release', fileName), `${body} for ${build.platform}`)
    writeFileSync(
      join(space.root, 'descriptors', `${build.platform}-${build.arch}.json`),
      `${JSON.stringify(
        {
          platform: build.platform,
          arch: build.arch,
          files: [{ fileName, assetName: assetNameFor(fileName) }],
        },
        null,
        2,
      )}\n`,
    )
  }
}

interface ReleaseRun {
  code: number
  out: string
  /** The output of each step, in the order the workflow runs them. */
  steps: string[]
}
/**
 * One release, end to end: inject, check, mint, sign, verify, publish — the
 * six steps the package and publishing jobs run, in the order the workflow
 * runs them, stopping where the workflow stops.
 */
function release(
  space: Workspace,
  options: {
    version: string
    key: EphemeralKey
    extra?: Record<string, string>
    failUploads?: string[]
  },
): ReleaseRun {
  const env: NodeJS.ProcessEnv = {
    UPDATE_SIGNING_KEY: options.key.secret,
    UPDATE_SIGNING_PUBLIC_KEY: options.key.registry.publicKey,
    UPDATE_SIGNING_KEY_ID: options.key.keyId,
    ...options.extra,
  }
  if (options.failUploads) env.FIXTURE_GH_FAIL_UPLOAD = options.failUploads.join(',')
  stageInstallers(space, options.version)
  const script: [string, string[]][] = [
    ['release-trusted-keys.ts', ['inject']],
    ['release-trusted-keys.ts', ['check-injected']],
    [
      'release-update-manifest.ts',
      [
        'build',
        '--channel',
        CHANNEL,
        '--version',
        options.version,
        '--descriptors',
        'descriptors',
        '--artifact-dir',
        'signed-release',
        '--out-dir',
        'channel-feed',
        '--stage-dir',
        'channel-assets',
        '--repo',
        REPO,
        '--notes',
        `Git Stacks ${options.version}.`,
      ],
    ],

    ['release-update-sign.ts', ['--channel', CHANNEL, '--manifest', `channel-feed/${MANIFEST}`]],
    [
      'release-update-verify.ts',
      [
        '--channel',
        CHANNEL,
        '--manifest',
        `channel-feed/${MANIFEST}`,
        '--artifact-dir',
        'channel-assets',
      ],
    ],
    [
      'release-update-publish.ts',
      [
        '--channel',
        CHANNEL,
        '--repo',
        REPO,
        '--feed',
        'channel-feed',
        '--installers',
        'channel-assets',
      ],
    ],
  ]
  const steps: string[] = []
  for (const [name, args] of script) {
    const run = space.run(name, args, env)
    steps.push(run.out)
    if (run.code !== 0) return { code: run.code, out: steps.join('\n'), steps }
  }
  return { code: 0, out: steps.join('\n'), steps }
}

function assetOn(space: Workspace, name: string): Buffer | null {
  const path = join(space.releaseDir, TAG, name)
  return existsSync(path) ? readFileSync(path) : null
}

/** The key an envelope names, read the way the app reads it. */
function signedBy(signatureBytes: Buffer): string | null {
  const envelope = parseSignatureEnvelope(signatureBytes)
  return envelope.ok ? envelope.value.keyId : null
}

/** What an installed build makes of a published manifest, using the app's own rules. */
function installedBuildAccepts(
  trusted: readonly TrustedUpdateKey[],
  manifestBytes: Buffer,
  signatureBytes: Buffer,
): { ok: boolean; reason?: string; version?: string } {
  const set = trustedUpdateKeys({}, true, [...trusted])
  const envelope = parseSignatureEnvelope(signatureBytes)
  if (!envelope.ok) return { ok: false, reason: envelope.failure.reason }
  const key = set.keys.find((entry) => entry.keyId === envelope.value.keyId)
  if (!key) return { ok: false, reason: 'no-trusted-key' }
  if (!verifyDetachedSignature(key, manifestBytes, envelope.value.signature, Date.now())) {
    return { ok: false, reason: 'bad-signature' }
  }
  const manifest = parseUpdateManifest(manifestBytes)
  if (!manifest.ok) return { ok: false, reason: manifest.failure.reason }
  const feed = releaseLocation(CHANNEL as never)
  const offer = evaluateUpdateManifest(manifest.value, {
    channel: CHANNEL as never,
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '0.0.0',
    seenSequence: 0,
    now: Date.now(),
    allowedOrigin: feed.origin,
    allowedPathPrefix: feed.pathPrefix,
  })
  return offer.ok
    ? { ok: true, version: manifest.value.version }
    : { ok: false, reason: offer.failure.reason }
}

for (const format of ['pem', 'base64'] as const) {
  test(`release key injection accepts ${format} signing and rotation public keys`, () => {
    const space = workspace()
    const signing = ephemeralKey('release-signing')
    const introduced = ephemeralKey('release-introduced', hoursFromNow(24))
    declarePublished(space, signing, introduced)
    const publicKey = (key: EphemeralKey): string =>
      format === 'pem'
        ? createPublicKey(key.privateKey).export({ format: 'pem', type: 'spki' }).toString()
        : key.registry.publicKey
    const env = {
      UPDATE_SIGNING_KEY: signing.secret,
      UPDATE_SIGNING_KEY_ID: signing.keyId,
      UPDATE_SIGNING_PUBLIC_KEY: publicKey(signing),
      UPDATE_SIGNING_KEY_VALID_FROM: signing.registry.validFrom,
      UPDATE_SIGNING_ADDITIONAL_KEY_ID: introduced.keyId,
      UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: publicKey(introduced),
      UPDATE_SIGNING_ADDITIONAL_VALID_FROM: introduced.registry.validFrom,
      UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL: introduced.registry.validUntil ?? '',
    }
    try {
      const injected = injectKeys(space, env)
      assert.equal(injected.code, 0, injected.out)
      const checked = space.run('release-trusted-keys.ts', ['check-injected'], env)
      assert.equal(checked.code, 0, checked.out)
      const registry = readFileSync(
        join(space.root, 'resources', 'update-trusted-keys.json'),
        'utf8',
      )
      assert.deepEqual(JSON.parse(registry), {
        schema: 1,
        keys: [signing.registry, introduced.registry],
      })
    } finally {
      rmSync(space.root, { recursive: true, force: true })
    }
  })
}

test('release verification refuses a manifest that expires while an earlier installer is hashed', () => {
  const space = workspace()
  const key = ephemeralKey('release-expiry')
  declarePublished(space, key)
  try {
    const published = release(space, { version: '0.1.0', key })
    assert.equal(published.code, 0, published.out)
    const manifestPath = join(space.root, 'channel-feed', MANIFEST)
    const parsed = parseUpdateManifest(readFileSync(manifestPath))
    if (!parsed.ok) throw new Error(parsed.failure.message)
    const now = Date.now()
    const expiresAt = now + 1000
    const manifest = {
      ...parsed.value,
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const env = { UPDATE_SIGNING_KEY: key.secret }
    const signed = space.run(
      'release-update-sign.ts',
      ['--channel', CHANNEL, '--manifest', manifestPath],
      env,
    )
    assert.equal(signed.code, 0, signed.out)
    const hook = join(space.root, 'clock.cjs')
    const firstInstaller = join(space.root, 'channel-assets', manifest.artifacts[0].fileName)
    writeFileSync(
      hook,
      `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
let now = ${now}
Date.now = () => now
const read = fs.readFileSync
fs.readFileSync = function(path, ...args) {
  const bytes = read.call(this, path, ...args)
  if (path === ${JSON.stringify(firstInstaller)} && process.env.ADVANCE_CLOCK === '1') now = ${expiresAt}
  return bytes
}
syncBuiltinESMExports()
`,
    )
    const args = [
      '--channel',
      CHANNEL,
      '--manifest',
      manifestPath,
      '--artifact-dir',
      join(space.root, 'channel-assets'),
    ]
    const baseline = space.run('release-update-verify.ts', args, {
      ...env,
      NODE_OPTIONS: `--require ${hook}`,
    })
    assert.equal(baseline.code, 0, baseline.out)
    const expired = space.run('release-update-verify.ts', args, {
      ...env,
      NODE_OPTIONS: `--require ${hook}`,
      ADVANCE_CLOCK: '1',
    })
    assert.equal(expired.code, 1, expired.out)
    assert.match(expired.out, /\(expired\)/u)
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

test('a publication banks its sequence, replaces the live pair, and reads both back', {
  skip: process.platform === 'win32' ? 'the publishing job runs on ubuntu' : false,
}, () => {
  const space = workspace()
  const key = ephemeralKey('release-a')
  declarePublished(space, key)
  try {
    assert.equal(
      injectKeys(space, {
        UPDATE_SIGNING_KEY: key.secret,
        UPDATE_SIGNING_PUBLIC_KEY: key.registry.publicKey,
        UPDATE_SIGNING_KEY_ID: key.keyId,
      }).code,
      0,
    )
    const first = release(space, { version: '0.1.0', key })
    assert.equal(first.code, 0, `the release published: ${first.out}`)
    assert.match(first.out, /issuing stable sequence 1/u)
    assert.match(first.out, /banking stable sequence 1 as history-stable-000000000001\.json/u)
    const live = assetOn(space, MANIFEST)
    const detached = assetOn(space, SIGNATURE)
    assert.notEqual(live, null, 'the live manifest is published')
    assert.notEqual(detached, null, 'the live signature is published')
    assert.deepEqual(installedBuildAccepts([key.registry], live as Buffer, detached as Buffer), {
      ok: true,
      version: '0.1.0',
    })
    // The banked copy is the same bytes under a name of its own, and it is
    // what the next release reads its sequence from.
    assert.deepEqual(assetOn(space, historyFileName(CHANNEL as never, 1)), live)
    assert.deepEqual(assetOn(space, historySignatureFileName(CHANNEL as never, 1)), detached)
    const second = release(space, { version: '0.1.1', key })
    assert.equal(second.code, 0, `the next release published: ${second.out}`)
    assert.match(second.out, /issuing stable sequence 2/u)
    assert.deepEqual(
      installedBuildAccepts(
        [key.registry],
        assetOn(space, MANIFEST) as Buffer,
        assetOn(space, SIGNATURE) as Buffer,
      ),
      { ok: true, version: '0.1.1' },
    )
    // Sequence 1 is still there, unchanged: history is appended to, never
    // rewritten by a later publication.
    assert.deepEqual(assetOn(space, historyFileName(CHANNEL as never, 1)), live)
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

test('a publication interrupted while replacing the live manifest leaves the previous release readable', {
  skip: process.platform === 'win32' ? 'the publishing job runs on ubuntu' : false,
}, () => {
  const space = workspace()
  const key = ephemeralKey('release-a')
  declarePublished(space, key)
  try {
    injectKeys(space, {
      UPDATE_SIGNING_KEY: key.secret,
      UPDATE_SIGNING_PUBLIC_KEY: key.registry.publicKey,
      UPDATE_SIGNING_KEY_ID: key.keyId,
    })
    assert.equal(release(space, { version: '0.1.0', key }).code, 0)
    const published = assetOn(space, MANIFEST)
    const publishedSignature = assetOn(space, SIGNATURE)

    // The interruption: the live manifest's asset is deleted and the upload
    // that would replace it never completes.
    const interrupted = release(space, {
      version: '0.1.1',
      key,
      failUploads: [MANIFEST],
    })
    assert.equal(interrupted.code, 1, 'the interrupted publication stops')
    assert.match(interrupted.out, /uploading update-stable\.json to updates-stable failed/u)
    assert.equal(assetOn(space, MANIFEST), null, 'the fixed name is gone, mid-publication')

    // The previous release is still readable from its banked copy, and it is
    // still the release clients would have been offered before this run.
    assert.deepEqual(
      installedBuildAccepts(
        [key.registry],
        assetOn(space, historyFileName(CHANNEL as never, 1)) as Buffer,
        assetOn(space, historySignatureFileName(CHANNEL as never, 1)) as Buffer,
      ),
      { ok: true, version: '0.1.0' },
      'the banked history is the release clients already trust',
    )
    assert.deepEqual(assetOn(space, historyFileName(CHANNEL as never, 1)), published)
    assert.deepEqual(
      assetOn(space, historySignatureFileName(CHANNEL as never, 1)),
      publishedSignature,
    )

    // The retry reads that history, so it cannot reuse the sequence the
    // interrupted run spent, and it puts the live pair back.
    const retry = release(space, { version: '0.1.1', key })
    assert.equal(retry.code, 0, `the retry published: ${retry.out}`)
    assert.match(retry.out, /issuing stable sequence 3/u)
    assert.match(retry.out, /does not currently publish sequence 2/u)
    assert.deepEqual(
      installedBuildAccepts(
        [key.registry],
        assetOn(space, MANIFEST) as Buffer,
        assetOn(space, SIGNATURE) as Buffer,
      ),
      { ok: true, version: '0.1.1' },
    )
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

test('a channel whose two live assets are both missing is not an empty channel', {
  skip: process.platform === 'win32' ? 'the publishing job runs on ubuntu' : false,
}, () => {
  const space = workspace()
  const key = ephemeralKey('release-a')
  declarePublished(space, key)
  try {
    injectKeys(space, {
      UPDATE_SIGNING_KEY: key.secret,
      UPDATE_SIGNING_PUBLIC_KEY: key.registry.publicKey,
      UPDATE_SIGNING_KEY_ID: key.keyId,
    })
    assert.equal(release(space, { version: '0.1.0', key }).code, 0)
    rmSync(join(space.releaseDir, TAG, MANIFEST), { force: true })
    rmSync(join(space.releaseDir, TAG, SIGNATURE), { force: true })

    const next = release(space, { version: '0.1.1', key })
    assert.equal(next.code, 0, `the next release published over the gap: ${next.out}`)
    assert.match(
      next.out,
      /issuing stable sequence 2/u,
      'a sequence already issued is never issued again, however the live pair is left',
    )
    assert.deepEqual(
      installedBuildAccepts(
        [key.registry],
        assetOn(space, MANIFEST) as Buffer,
        assetOn(space, SIGNATURE) as Buffer,
      ),
      { ok: true, version: '0.1.1' },
    )
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

test('a bank interrupted between its two assets is completed, not treated as history', {
  skip: process.platform === 'win32' ? 'the publishing job runs on ubuntu' : false,
}, () => {
  const space = workspace()
  const key = ephemeralKey('release-a')
  declarePublished(space, key)
  try {
    injectKeys(space, {
      UPDATE_SIGNING_KEY: key.secret,
      UPDATE_SIGNING_PUBLIC_KEY: key.registry.publicKey,
      UPDATE_SIGNING_KEY_ID: key.keyId,
    })
    assert.equal(release(space, { version: '0.1.0', key }).code, 0)
    // The residue a cancelled bank leaves: a manifest with no signature beside
    // it, holding bytes no key signed for that name.
    const residue = join(space.releaseDir, TAG, historyFileName(CHANNEL as never, 2))
    copyFileSync(join(space.releaseDir, TAG, historyFileName(CHANNEL as never, 1)), residue)
    writeFileSync(residue, `${readFileSync(residue, 'utf8')}\n`)

    const next = release(space, { version: '0.1.1', key })
    assert.equal(next.code, 0, `the residue did not strand the channel: ${next.out}`)
    assert.match(next.out, /issuing stable sequence 2/u, 'a half-written bank is not history')
    const banked = assetOn(space, historyFileName(CHANNEL as never, 2))
    assert.deepEqual(
      installedBuildAccepts(
        [key.registry],
        banked as Buffer,
        assetOn(space, historySignatureFileName(CHANNEL as never, 2)) as Buffer,
      ),
      { ok: true, version: '0.1.1' },
      'what is banked at a sequence is the release that issued it',
    )
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

test('re-running one publication does not rewrite the sequence it banked', {
  skip: process.platform === 'win32' ? 'the publishing job runs on ubuntu' : false,
}, () => {
  const space = workspace()
  const key = ephemeralKey('release-a')
  declarePublished(space, key)
  try {
    injectKeys(space, {
      UPDATE_SIGNING_KEY: key.secret,
      UPDATE_SIGNING_PUBLIC_KEY: key.registry.publicKey,
      UPDATE_SIGNING_KEY_ID: key.keyId,
    })
    assert.equal(release(space, { version: '0.1.0', key }).code, 0)
    const installerName = assetNameFor(BUILDS[0].file('0.1.0'))
    const installer = assetOn(space, installerName)
    assert.notEqual(installer, null)
    const again = space.run(
      'release-update-publish.ts',
      [
        '--channel',
        CHANNEL,
        '--repo',
        REPO,
        '--feed',
        'channel-feed',
        '--installers',
        'channel-assets',
      ],
      {
        UPDATE_SIGNING_KEY: key.secret,
        UPDATE_SIGNING_PUBLIC_KEY: key.registry.publicKey,
        FIXTURE_GH_FAIL_UPLOAD: installerName,
      },
    )
    assert.equal(again.code, 0, `the publication is safe to repeat: ${again.out}`)
    assert.match(again.out, /is already on updates-stable with these exact bytes/u)
    assert.deepEqual(assetOn(space, installerName), installer, 'the live installer is not replaced')
    assert.match(
      again.out,
      /sequence 1 is already banked on updates-stable with these exact bytes/u,
    )
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

test('an installer published under a name the live manifest binds to other bytes is refused', {
  skip: process.platform === 'win32' ? 'the publishing job runs on ubuntu' : false,
}, () => {
  const space = workspace()
  const key = ephemeralKey('release-a')
  declarePublished(space, key)
  try {
    injectKeys(space, {
      UPDATE_SIGNING_KEY: key.secret,
      UPDATE_SIGNING_PUBLIC_KEY: key.registry.publicKey,
      UPDATE_SIGNING_KEY_ID: key.keyId,
    })
    assert.equal(release(space, { version: '0.1.0', key }).code, 0)
    // The same version, rebuilt: identical installer names, different bytes.
    // The manifest is a new sequence, but the asset names it publishes are the
    // names clients are already fetching.
    stageInstallers(space, '0.1.0', 'a different installer')
    const env = {
      UPDATE_SIGNING_KEY: key.secret,
      UPDATE_SIGNING_PUBLIC_KEY: key.registry.publicKey,
    }
    for (const [script, args] of [
      [
        'release-update-manifest.ts',
        [
          'build',
          '--channel',
          CHANNEL,
          '--version',
          '0.1.0',
          '--descriptors',
          'descriptors',
          '--artifact-dir',
          'signed-release',
          '--out-dir',
          'channel-feed',
          '--stage-dir',
          'channel-assets',
          '--repo',
          REPO,
          '--sequence',
          '9',
        ],
      ],
      ['release-update-sign.ts', ['--channel', CHANNEL, '--manifest', `channel-feed/${MANIFEST}`]],
      [
        'release-update-verify.ts',
        [
          '--channel',
          CHANNEL,
          '--manifest',
          `channel-feed/${MANIFEST}`,
          '--artifact-dir',
          'channel-assets',
        ],
      ],
    ] as [string, string[]][]) {
      assert.equal(space.run(script, args, env).code, 0)
    }
    const published = space.run(
      'release-update-publish.ts',
      [
        '--channel',
        CHANNEL,
        '--repo',
        REPO,
        '--feed',
        'channel-feed',
        '--installers',
        'channel-assets',
      ],
      env,
    )
    assert.equal(published.code, 1)
    assert.match(
      published.out,
      /is published under a name the live stable manifest already binds to different bytes/u,
    )
    assert.deepEqual(
      installedBuildAccepts(
        [key.registry],
        assetOn(space, MANIFEST) as Buffer,
        assetOn(space, SIGNATURE) as Buffer,
      ),
      { ok: true, version: '0.1.0' },
    )
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

/**
 * A rotation, in the order a rotation has to happen in: a build is given the
 * new key while the manifest beside it is still signed with the old one, and
 * only the release after that one signs with the new key.
 *
 * The three releases below are run through the real scripts, and each manifest
 * is then offered to the build an earlier release packaged — which is the only
 * trust set an installed app has, because the key is compiled into it.
 */
test('a key is introduced in one release and signs in the next, and the builds in between accept both', {
  skip:
    process.platform === 'win32'
      ? 'the release job that injects keys runs on every platform'
      : false,
}, () => {
  const space = workspace()
  const old = ephemeralKey('release-old')
  const fresh = ephemeralKey('release-new')
  declarePublished(space, old, fresh)
  const retired = hoursFromNow(24 * 45)
  try {
    // Before the rotation: one key, and every installed build trusts it.
    const beforeRotation = injectKeys(space, {
      UPDATE_SIGNING_KEY: old.secret,
      UPDATE_SIGNING_PUBLIC_KEY: old.registry.publicKey,
      UPDATE_SIGNING_KEY_ID: old.keyId,
    })
    assert.equal(beforeRotation.code, 0, beforeRotation.out)
    assert.equal(release(space, { version: '0.1.0', key: old }).code, 0)
    const installedTrust = JSON.parse(
      readFileSync(join(space.root, 'resources', 'update-trusted-keys.json'), 'utf8'),
    ).keys as TrustedUpdateKey[]
    assert.deepEqual(
      installedTrust.map((entry) => entry.keyId),
      [old.keyId],
    )

    // Release two: the new key rides along, the manifest is still signed with
    // the old one, and the builds it packages verify it.
    const bridge = release(space, {
      version: '0.1.1',
      key: old,
      extra: {
        UPDATE_SIGNING_ADDITIONAL_KEY_ID: fresh.keyId,
        UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: fresh.registry.publicKey,
        UPDATE_SIGNING_ADDITIONAL_VALID_FROM: '2020-01-01T00:00:00.000Z',
        UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL: hoursFromNow(24 * 400),
      },
    })
    assert.equal(bridge.code, 0, `the bridge release published: ${bridge.out}`)
    assert.match(bridge.out, /it also carries release-new/u)
    const bridgeTrust = JSON.parse(
      readFileSync(join(space.root, 'resources', 'update-trusted-keys.json'), 'utf8'),
    ).keys as TrustedUpdateKey[]
    assert.deepEqual(
      bridgeTrust.map((entry) => entry.keyId),
      [old.keyId, fresh.keyId],
      'the build this release packages trusts both keys',
    )
    const bridgeManifest = readFileSync(join(space.root, 'channel-feed', MANIFEST))
    const bridgeSignature = readFileSync(join(space.root, 'channel-feed', SIGNATURE))
    assert.equal(
      signedBy(bridgeSignature),
      old.keyId,
      'the bridge manifest is signed with the key every installed build already trusts',
    )
    assert.deepEqual(
      installedBuildAccepts(installedTrust, bridgeManifest, bridgeSignature),
      { ok: true, version: '0.1.1' },
      'a build packaged before the rotation installs the release that introduces it',
    )

    // Release three: the new key signs, and the build that carried both
    // accepts it. The old key is still trusted, until the window says otherwise.
    const switched = release(space, {
      version: '0.1.2',
      key: fresh,
      extra: {
        UPDATE_SIGNING_ADDITIONAL_KEY_ID: old.keyId,
        UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: old.registry.publicKey,
        UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL: retired,
      },
    })
    assert.equal(switched.code, 0, `the switching release published: ${switched.out}`)
    assert.match(switched.out, /it also carries release-old/u)
    const switchedManifest = readFileSync(join(space.root, 'channel-feed', MANIFEST))
    const switchedSignature = readFileSync(join(space.root, 'channel-feed', SIGNATURE))
    assert.equal(signedBy(switchedSignature), fresh.keyId)
    assert.deepEqual(
      installedBuildAccepts(bridgeTrust, switchedManifest, switchedSignature),
      { ok: true, version: '0.1.2' },
      'the bridge build installs the release signed with the key it was given',
    )

    // And the release that retires the old key: a build that trusts only the
    // new one no longer accepts what the old one signed, which is the whole
    // point of the window the overlap names.
    const retirement = release(space, { version: '0.1.3', key: fresh })
    assert.equal(retirement.code, 0, retirement.out)
    const onlyNew: TrustedUpdateKey[] = [fresh.registry]
    assert.deepEqual(
      installedBuildAccepts(onlyNew, bridgeManifest, bridgeSignature),
      { ok: false, reason: 'no-trusted-key' },
      'a build that has dropped the old key cannot verify what the old key signed',
    )
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

test('a rotation that is only half declared is refused', () => {
  const space = workspace()
  const old = ephemeralKey('release-old')
  const fresh = ephemeralKey('release-new')
  declarePublished(space, old, fresh)
  try {
    const halfDeclared: Record<string, string>[] = [
      { UPDATE_SIGNING_ADDITIONAL_KEY_ID: fresh.keyId },
      { UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: fresh.registry.publicKey },
      {
        UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: fresh.registry.publicKey,
        UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL: hoursFromNow(48),
      },
    ]
    for (const declared of halfDeclared) {
      const run = injectKeys(space, {
        UPDATE_SIGNING_KEY: old.secret,
        UPDATE_SIGNING_PUBLIC_KEY: old.registry.publicKey,
        UPDATE_SIGNING_KEY_ID: old.keyId,
        ...declared,
      })
      assert.equal(
        run.code,
        1,
        `${JSON.stringify(Object.keys(declared))} must not inject a key set`,
      )
      assert.match(run.out, /all four values or none/u)
    }
    // A key that is already over, and a key this release is signing with, are
    // both rotations that would reach no build.
    const rejected: Record<string, string>[] = [
      {
        UPDATE_SIGNING_ADDITIONAL_KEY_ID: fresh.keyId,
        UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: fresh.registry.publicKey,
        UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL: '2020-02-01T00:00:00.000Z',
      },
      {
        UPDATE_SIGNING_ADDITIONAL_KEY_ID: old.keyId,
        UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: old.registry.publicKey,
        UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL: hoursFromNow(48),
      },
      {
        UPDATE_SIGNING_ADDITIONAL_KEY_ID: 'not a key name',
        UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: fresh.registry.publicKey,
        UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL: hoursFromNow(48),
      },
    ]
    for (const declared of rejected) {
      const run = injectKeys(space, {
        UPDATE_SIGNING_KEY: old.secret,
        UPDATE_SIGNING_PUBLIC_KEY: old.registry.publicKey,
        UPDATE_SIGNING_KEY_ID: old.keyId,
        ...declared,
      })
      assert.equal(
        run.code,
        1,
        `${JSON.stringify(Object.keys(declared))} must not inject a key set`,
      )
    }
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})

test('a build is refused when it does not carry the key this release introduces', () => {
  const space = workspace()
  const old = ephemeralKey('release-old')
  const fresh = ephemeralKey('release-new')
  declarePublished(space, old, fresh)
  const env = {
    UPDATE_SIGNING_KEY: old.secret,
    UPDATE_SIGNING_PUBLIC_KEY: old.registry.publicKey,
    UPDATE_SIGNING_KEY_ID: old.keyId,
    UPDATE_SIGNING_ADDITIONAL_KEY_ID: fresh.keyId,
    UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY: fresh.registry.publicKey,
    UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL: hoursFromNow(48),
  }
  try {
    // The build carries only the signing key, because the injection that
    // introduced the second one never ran in this job.
    const shipped = join(space.root, 'single-key-set.json')
    writeFileSync(
      shipped,
      JSON.stringify({
        schema: 1,
        keys: [
          {
            keyId: old.keyId,
            publicKey: old.registry.publicKey,
            validFrom: '2020-01-01T00:00:00.000Z',
            validUntil: null,
          },
        ],
      }),
    )
    const refused = space.run('release-trusted-keys.ts', ['check-injected', '--out', shipped], env)
    assert.equal(refused.code, 1)
    assert.match(refused.out, /does not carry release-new, the key this release introduces/u)
    // The same check passes on a set that carries both.
    assert.equal(injectKeys(space, env).code, 0)
    const carried = space.run('release-trusted-keys.ts', ['check-injected'], env)
    assert.equal(carried.code, 0, carried.out)
    assert.match(carried.out, /this release's manifest is signed with release-old/u)
  } finally {
    rmSync(space.root, { recursive: true, force: true })
  }
})
