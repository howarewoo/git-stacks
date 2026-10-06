import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import {
  getConflictView,
  getFileView,
  getSnapshot,
  runAction,
  runConflictMergeTool,
} from '../src/main/git'
import { runGit } from '../src/main/git-core'
import {
  compareGitVersions,
  configureGitRuntime,
  gitRuntimeStatus,
  platformKey,
  readGitRuntimePreference,
  requireGitCapability,
  resolveGitRuntime,
  withGitRuntime,
} from '../src/main/git-runtime'
import { updateSettings } from '../src/main/settings'
import type { SettingsLock } from '../src/shared/settings'
import type { GitAction } from '../src/shared/types'
const require = createRequire(import.meta.url)
const refreshWindowsInventory = require('../scripts/refresh-win-git-runtime.cjs') as (context: {
  appOutDir: string
  arch: number
  electronPlatformName: string
}) => Promise<void>
const { Arch } = require('builder-util') as { Arch: Record<string, number> }

const packageData: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
if (
  !packageData ||
  typeof packageData !== 'object' ||
  !('version' in packageData) ||
  typeof packageData.version !== 'string'
) {
  throw new Error('package.json must specify the app version')
}
const APP_VERSION = packageData.version
const platform = platformKey(process.platform, process.arch)
const realGit =
  process.platform === 'win32'
    ? 'git'
    : execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const systemVersionOutput = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
const systemVersion = /(\d+\.\d+\.\d+)/u.exec(systemVersionOutput)?.[1] ?? ''
const releaseResources = resolve('resources')
const releaseExecutable = join(
  releaseResources,
  'git',
  platform,
  process.platform === 'win32' ? 'cmd' : 'bin',
  process.platform === 'win32' ? 'git.exe' : 'git',
)

const temporaryRoots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

after(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true })
})

interface BundledFixture {
  resourcesRoot: string
  executable: string
  manifestPath: string
}

/**
 * A release-shaped runtime directory: `git/<platform>/bin/git` plus the manifest that
 * records the digest the signed release ships.
 */
async function provisionRuntime(
  options: {
    version?: string
    reportedVersion?: string
    appVersion?: string
    digest?: string
    recordPlatform?: boolean
  } = {},
): Promise<BundledFixture> {
  const resourcesRoot = await temporaryRoot('git-stacks-runtime-')
  const bin = join(resourcesRoot, 'git', platform, 'bin')
  await mkdir(bin, { recursive: true })
  const executable = join(bin, process.platform === 'win32' ? 'git.exe' : 'git')
  const reportedVersion = options.reportedVersion ?? options.version ?? systemVersion
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${reportedVersion}"; exit 0; fi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  )
  await chmod(executable, 0o755)
  const manifestPath = join(resourcesRoot, 'git', 'runtime-manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify({
      appVersion: options.appVersion ?? APP_VERSION,
      platforms:
        options.recordPlatform === false
          ? {}
          : {
              [platform]: {
                gitVersion: options.version ?? systemVersion,
                sha256:
                  options.digest ??
                  createHash('sha256')
                    .update(await readFile(executable))
                    .digest('hex'),
                source: 'https://git-scm.com/downloads (release fixture)',
                files: {
                  [`bin/${process.platform === 'win32' ? 'git.exe' : 'git'}`]: createHash('sha256')
                    .update(await readFile(executable))
                    .digest('hex'),
                },
              },
            },
    }),
  )
  return { resourcesRoot, executable, manifestPath }
}

async function repository(prefix = 'git-stacks-runtime-repo-') {
  const root = await temporaryRoot(prefix)
  const repo = join(root, 'workspace')
  await mkdir(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Git Stacks test')
  git('config', 'user.email', 'test@example.invalid')
  return { root, repo, git }
}

function headOid(repo: string): string | null {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : null
}

const commitAction = (repo: string, message: string, branch = 'main'): GitAction => ({
  type: 'commit',
  message,
  amend: false,
  expectedHead: headOid(repo),
  expectedHeadRef: `refs/heads/${branch}`,
})

test('the resolver records the runtime version, capabilities, and preserved behaviour', async () => {
  configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  const runtime = await resolveGitRuntime()
  assert.equal(runtime.source, 'system')
  assert.equal(runtime.executable, 'git')
  assert.equal(runtime.version, systemVersion)
  assert.equal(runtime.versionOutput, systemVersionOutput)
  assert.equal(runtime.minimumVersion, '2.29.0')
  assert.equal(runtime.meetsMinimum, true)
  assert.equal(runtime.capabilities.referenceTransactions, true)
  assert.equal(
    runtime.capabilities.rebaseUpdateRefs,
    compareGitVersions(systemVersion, '2.38.0') >= 0,
  )
  assert.equal(runtime.preservedConfiguration.includes('credential.helper'), true)
  assert.equal(runtime.preservedConfiguration.includes('core.hooksPath'), true)
  assert.equal(runtime.preservedConfiguration.includes('user.signingkey'), true)
  assert.equal(runtime.preservedEnvironment.includes('GIT_SSH_COMMAND'), true)
  assert.equal(runtime.preservedEnvironment.includes('SSH_AUTH_SOCK'), true)
})

test('the bundled runtime replaces PATH Git and the system override reverses it', async () => {
  const bundled = { resourcesRoot: releaseResources, executable: releaseExecutable }
  const { repo, git } = await repository()
  try {
    configureGitRuntime({
      appVersion: APP_VERSION,
      packaged: true,
      resourcesRoot: bundled.resourcesRoot,
      useSystemGit: false,
    })
    const bundledRuntime = await resolveGitRuntime()
    assert.equal(bundledRuntime.source, 'bundled')
    assert.equal(bundledRuntime.executable, bundled.executable)
    assert.equal(bundledRuntime.bundled?.gitVersion, '2.53.0')
    assert.match(await runGit(repo, ['--version']), /git version/u)
    const helperRoot =
      process.platform === 'win32' ? (process.arch === 'arm64' ? 'clangarm64' : 'mingw64') : ''
    assert.equal(
      (await runGit(repo, ['--exec-path'])).trim().replace(/\\/gu, '/').toLowerCase(),
      join(releaseResources, 'git', platform, helperRoot, 'libexec', 'git-core')
        .replace(/\\/gu, '/')
        .toLowerCase(),
    )
    assert.match(await runGit(repo, ['lfs', 'version']), /^git-lfs\//u)

    const inheritedExecPath = process.env.GIT_EXEC_PATH
    try {
      process.env.GIT_EXEC_PATH = join(repo, 'wrong-helpers')
      assert.equal(
        (await runGit(repo, ['--exec-path'])).trim().replace(/\\/gu, '/').toLowerCase(),
        join(releaseResources, 'git', platform, helperRoot, 'libexec', 'git-core')
          .replace(/\\/gu, '/')
          .toLowerCase(),
      )
      assert.match(await runGit(repo, ['lfs', 'version']), /^git-lfs\//u)
    } finally {
      if (inheritedExecPath === undefined) delete process.env.GIT_EXEC_PATH
      else process.env.GIT_EXEC_PATH = inheritedExecPath
    }

    configureGitRuntime({ useSystemGit: true })
    const systemRuntime = await resolveGitRuntime()
    assert.equal(systemRuntime.source, 'system')
    assert.equal(systemRuntime.executable, 'git')
    assert.equal(systemRuntime.useSystemGit, true)
    assert.equal(systemRuntime.bundled, null)
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main')

    configureGitRuntime({ useSystemGit: false })
    assert.equal((await resolveGitRuntime()).source, 'bundled')
  } finally {
    configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  }
})

test('repository opening, streamed diffs, conflict previews, and mergetool work without PATH Git', {
  skip: process.platform === 'win32',
}, async () => {
  const { root, repo, git } = await repository()
  const tool = join(root, 'merge-tool.sh')
  await writeFile(tool, '#!/bin/sh\nprintf "resolved by tool\\n" > "$1"\n', { mode: 0o755 })
  git('config', 'mergetool.git-stacks-test.trustExitCode', 'true')
  git('config', 'mergetool.git-stacks-test.cmd', `/bin/sh "${tool}" "$MERGED"`)
  git('config', 'merge.tool', 'git-stacks-test')
  await writeFile(join(repo, 'shared.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'Base')
  git('checkout', '-b', 'topic')
  await writeFile(join(repo, 'shared.txt'), 'topic\n')
  git('add', '.')
  git('commit', '-m', 'Topic edit')
  git('checkout', 'main')
  await writeFile(join(repo, 'shared.txt'), 'main\n')
  git('add', '.')
  git('commit', '-m', 'Main edit')
  const merged = spawnSync(realGit, ['-C', repo, 'merge', 'topic'], { encoding: 'utf8' })
  assert.notEqual(merged.status, 0)

  const previousPath = process.env.PATH
  const previousExecPath = process.env.GIT_EXEC_PATH
  try {
    process.env.PATH = ''
    process.env.GIT_EXEC_PATH = join(root, 'wrong-helpers')
    configureGitRuntime({
      appVersion: APP_VERSION,
      packaged: true,
      resourcesRoot: releaseResources,
      useSystemGit: false,
    })
    const snapshot = await getSnapshot(repo)
    assert.equal(snapshot.capabilities.gitVersion, (await resolveGitRuntime()).versionOutput)
    const file = await getFileView(repo, 'shared.txt')
    assert.match(file.unstagedDiff, /shared\.txt/u)
    const conflict = await getConflictView(repo, 'shared.txt')
    assert.equal(conflict.base, 'base\n')
    assert.equal(conflict.current, 'main\n')
    assert.equal(conflict.incoming, 'topic\n')
    await runConflictMergeTool(repo, 'shared.txt', conflict.fingerprint)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'resolved by tool\n')
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousExecPath === undefined) delete process.env.GIT_EXEC_PATH
    else process.env.GIT_EXEC_PATH = previousExecPath
    configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  }
})

test('a packaged build refuses PATH Git until the system override is explicit', async () => {
  const empty = await temporaryRoot('git-stacks-empty-')
  configureGitRuntime({
    appVersion: APP_VERSION,
    packaged: true,
    resourcesRoot: empty,
    useSystemGit: false,
  })
  try {
    await assert.rejects(resolveGitRuntime(), /bundled Git runtime for .* is missing/u)
    await assert.rejects(
      requireGitCapability('referenceTransactions', 'merge a branch'),
      /bundled Git runtime for .* is missing/u,
    )

    configureGitRuntime({ useSystemGit: true })
    assert.equal((await resolveGitRuntime()).source, 'system')

    configureGitRuntime({ useSystemGit: false })
    await assert.rejects(resolveGitRuntime(), /bundled Git runtime for .* is missing/u)
  } finally {
    configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  }
})

test('a runtime that does not match its release digest, build, or platform is rejected', {
  skip: process.platform === 'win32',
}, async () => {
  configureGitRuntime({ appVersion: APP_VERSION, packaged: true, useSystemGit: false })
  try {
    const tampered = await provisionRuntime({ digest: '0'.repeat(64) })
    configureGitRuntime({ resourcesRoot: tampered.resourcesRoot })
    await assert.rejects(resolveGitRuntime(), /does not match its release digest/u)
    const marker = join(tampered.resourcesRoot, 'executed')
    await writeFile(
      tampered.executable,
      `#!/bin/sh\nprintf ran > \"${marker}\"\necho git version ${systemVersion}\n`,
      { mode: 0o755 },
    )
    configureGitRuntime({
      resourcesRoot: tampered.resourcesRoot,
      env: { ...process.env, GIT_STACKS_BUNDLED_GIT: realGit },
    })
    await assert.rejects(resolveGitRuntime(), /does not match its release digest/u)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
    configureGitRuntime({
      resourcesRoot: releaseResources,
      env: { ...process.env, GIT_STACKS_BUNDLED_GIT: tampered.executable },
    })
    assert.equal((await resolveGitRuntime()).executable, releaseExecutable)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
    await rm(tampered.manifestPath)
    configureGitRuntime({ resourcesRoot: tampered.resourcesRoot })
    await assert.rejects(resolveGitRuntime(), /manifest records app version none/u)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })

    const otherBuild = await provisionRuntime({ appVersion: '9.9.9' })
    configureGitRuntime({ resourcesRoot: otherBuild.resourcesRoot, env: process.env })
    await assert.rejects(resolveGitRuntime(), /does not match this build/u)

    const unrecorded = await provisionRuntime({ recordPlatform: false })
    configureGitRuntime({ resourcesRoot: unrecorded.resourcesRoot })
    await assert.rejects(resolveGitRuntime(), /records no Git runtime for/u)

    const otherVersion = await provisionRuntime({
      reportedVersion: systemVersion,
      version: '2.30.0',
    })
    configureGitRuntime({ resourcesRoot: otherVersion.resourcesRoot })
    await assert.rejects(resolveGitRuntime(), /reports .* but the release manifest records/u)

    const cachedFixture = await provisionRuntime()
    configureGitRuntime({ resourcesRoot: cachedFixture.resourcesRoot })
    assert.equal((await resolveGitRuntime()).source, 'bundled')
    const cachedMarker = join(cachedFixture.resourcesRoot, 'cached-executed')
    await writeFile(
      cachedFixture.executable,
      `#!/bin/sh\nprintf ran > \"${cachedMarker}\"\necho git version ${systemVersion}\n`,
      { mode: 0o755 },
    )
    await assert.rejects(resolveGitRuntime(), /does not match its release digest/u)
    await assert.rejects(readFile(cachedMarker), { code: 'ENOENT' })
  } finally {
    configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  }
})
test('cached validation rejects an altered or removed helper in a disposable copied distribution before execution even when bin/git is intact', {
  skip: process.platform === 'win32',
}, async () => {
  const tmp = await temporaryRoot('git-stacks-helper-tamper-')
  execFileSync('cp', ['-R', '-P', join(releaseResources, 'git'), tmp])
  configureGitRuntime({
    appVersion: APP_VERSION,
    packaged: true,
    resourcesRoot: tmp,
    useSystemGit: false,
  })
  try {
    const initial = await resolveGitRuntime()
    assert.equal(initial.source, 'bundled')

    const helperRelative = join('libexec', 'git-core', 'git-remote-https')
    const helperPath = join(tmp, 'git', platform, helperRelative)
    const marker = join(tmp, 'helper-marker')

    // Replace helper with executable script while bin/git remains untouched
    await writeFile(helperPath, `#!/bin/sh\nprintf executed > "${marker}"\nexit 1\n`, {
      mode: 0o755,
    })

    await assert.rejects(
      resolveGitRuntime(),
      /The bundled Git runtime files do not match the signed release inventory/u,
    )
    await assert.rejects(readFile(marker), { code: 'ENOENT' })

    // Remove helper while bin/git remains untouched
    await rm(helperPath)
    await assert.rejects(
      resolveGitRuntime(),
      /The bundled Git runtime files do not match the signed release inventory/u,
    )
  } finally {
    configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  }
})
test('a cached packaged runtime refuses a removed, malformed, or replaced release manifest before a Git operation', {
  skip: process.platform === 'win32',
}, async () => {
  const resources = await temporaryRoot('git-stacks-manifest-tamper-')
  execFileSync('cp', ['-R', '-P', join(releaseResources, 'git'), resources])
  const manifestPath = join(resources, 'git', 'runtime-manifest.json')
  const original = await readFile(manifestPath, 'utf8')
  const { repo } = await repository()
  const initialHead = headOid(repo)
  const replacements = [
    null,
    '{invalid json',
    JSON.stringify({ ...JSON.parse(original), appVersion: '9.9.9' }),
    JSON.stringify({
      ...JSON.parse(original),
      platforms: {
        [platform]: { ...JSON.parse(original).platforms[platform], source: 'replaced source' },
      },
    }),
  ]
  try {
    for (const replacement of replacements) {
      await writeFile(manifestPath, original)
      configureGitRuntime({
        appVersion: APP_VERSION,
        packaged: true,
        resourcesRoot: resources,
        useSystemGit: false,
        env: process.env,
      })
      assert.equal((await resolveGitRuntime()).source, 'bundled')
      if (replacement === null) await rm(manifestPath)
      else await writeFile(manifestPath, replacement)
      await assert.rejects(runGit(repo, ['status', '--porcelain']), /runtime manifest/u)
      await assert.rejects(runGit(repo, ['status', '--porcelain']), /runtime manifest/u)
      assert.equal(headOid(repo), initialHead)
    }
    configureGitRuntime({ useSystemGit: true })
    assert.equal((await resolveGitRuntime()).source, 'system')
    configureGitRuntime({ useSystemGit: false })
    await assert.rejects(runGit(repo, ['status', '--porcelain']), /runtime manifest/u)
    await writeFile(manifestPath, original)
    assert.equal((await resolveGitRuntime()).source, 'bundled')

    const semanticResources = await temporaryRoot('git-stacks-manifest-bytes-')
    execFileSync('cp', ['-R', '-P', join(releaseResources, 'git'), semanticResources])
    const semanticManifest = join(semanticResources, 'git', 'runtime-manifest.json')
    const equivalent = JSON.parse(original) as { platforms: Record<string, { source: string }> }
    equivalent.platforms[platform].source = 'upstream \uFFFD'
    const valid = Buffer.from(JSON.stringify(equivalent))
    const offset = valid.indexOf(Buffer.from('\uFFFD'))
    assert.notEqual(offset, -1)
    await writeFile(semanticManifest, valid)
    configureGitRuntime({
      appVersion: APP_VERSION,
      packaged: true,
      resourcesRoot: semanticResources,
      useSystemGit: false,
      env: process.env,
    })
    assert.equal((await resolveGitRuntime()).source, 'bundled')
    const invalid = Buffer.concat([
      valid.subarray(0, offset),
      Buffer.from([0xff]),
      valid.subarray(offset + Buffer.byteLength('\uFFFD')),
    ])
    assert.equal(invalid.toString('utf8'), valid.toString('utf8'))
    await writeFile(semanticManifest, invalid)
    await assert.rejects(runGit(repo, ['status', '--porcelain']), /runtime manifest/u)
    await assert.rejects(runGit(repo, ['status', '--porcelain']), /runtime manifest/u)
    assert.equal(headOid(repo), initialHead)
  } finally {
    configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  }
})

test('Windows afterPack records signed EXE bytes without changing archive provenance or other payload files', async () => {
  const appOutDir = await temporaryRoot('git-stacks-signed-win-')
  const gitRoot = join(appOutDir, 'resources', 'git')
  const root = join(gitRoot, 'win32-x64')
  const executable = join(root, 'cmd', 'git.exe')
  const helper = join(root, 'mingw64', 'libexec', 'git-core', 'git-remote-https.exe')
  const data = join(root, 'etc', 'gitconfig')
  await mkdir(join(root, 'cmd'), { recursive: true })
  await mkdir(join(root, 'mingw64', 'libexec', 'git-core'), { recursive: true })
  await mkdir(join(root, 'etc'), { recursive: true })
  await writeFile(executable, 'original git executable')
  await writeFile(helper, 'original helper executable')
  await writeFile(data, 'user config template')
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const source = 'pinned archive and upstream SHA-256'
  const manifestPath = join(gitRoot, 'runtime-manifest.json')
  const manifest = {
    appVersion: APP_VERSION,
    platforms: {
      'win32-x64': {
        gitVersion: '2.53.0',
        sha256: digest('original git executable'),
        source,
        files: {
          'cmd/git.exe': digest('original git executable'),
          'mingw64/libexec/git-core/git-remote-https.exe': digest('original helper executable'),
          'etc/gitconfig': digest('user config template'),
        },
      },
    },
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(executable, 'signed git executable')
  await writeFile(helper, 'signed helper executable')
  await refreshWindowsInventory({ appOutDir, arch: Arch.x64, electronPlatformName: 'win32' })
  const actual = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest
  assert.equal(actual.appVersion, APP_VERSION)
  assert.equal(actual.platforms['win32-x64'].source, source)
  assert.equal(actual.platforms['win32-x64'].sha256, digest('signed git executable'))
  assert.deepEqual(actual.platforms['win32-x64'].files, {
    'cmd/git.exe': digest('signed git executable'),
    'mingw64/libexec/git-core/git-remote-https.exe': digest('signed helper executable'),
    'etc/gitconfig': digest('user config template'),
  })
  await writeFile(data, 'unexpected config change')
  await assert.rejects(
    refreshWindowsInventory({ appOutDir, arch: Arch.x64, electronPlatformName: 'win32' }),
    /Unexpected Git runtime change/u,
  )
})

test('an in-flight operation retains its checked runtime and capabilities across multi-command execution despite global configuration changes', async () => {
  configureGitRuntime({
    appVersion: APP_VERSION,
    packaged: true,
    resourcesRoot: releaseResources,
    useSystemGit: false,
  })
  try {
    const initial = await resolveGitRuntime()
    assert.equal(initial.source, 'bundled')

    let duringOperationSource: string | null = null
    let secondCheckSource: string | null = null

    await withGitRuntime(initial, async () => {
      const first = await resolveGitRuntime()
      duringOperationSource = first.source

      // Global preference changes mid-operation
      configureGitRuntime({ useSystemGit: true })

      const second = await resolveGitRuntime()
      secondCheckSource = second.source
    })

    const outside = await resolveGitRuntime()

    assert.equal(duringOperationSource, 'bundled')
    assert.equal(secondCheckSource, 'bundled')
    assert.equal(outside.source, 'system')
  } finally {
    configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  }
})

test('core workflows complete against the bundled runtime and the system Git', async () => {
  const bundled = { resourcesRoot: releaseResources, executable: releaseExecutable }
  const observed: string[] = []
  for (const source of ['bundled', 'system'] as const) {
    configureGitRuntime({
      appVersion: APP_VERSION,
      packaged: true,
      resourcesRoot: bundled.resourcesRoot,
      useSystemGit: source === 'system',
    })
    const { repo } = await repository()
    const runtime = await resolveGitRuntime()
    assert.equal(runtime.source, source)
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    await runAction(repo, { type: 'stage', paths: ['shared.txt'] })
    await runAction(repo, commitAction(repo, 'Add shared file'))
    await runAction(repo, { type: 'createBranch', name: 'feature', parent: 'main' })
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await runAction(repo, { type: 'stage', paths: ['feature.txt'] })
    await runAction(repo, commitAction(repo, 'Add feature file', 'feature'))
    await runAction(repo, { type: 'rebase', parent: 'main' })
    await runAction(repo, { type: 'switch', ref: 'refs/heads/main' })
    observed.push(
      [runtime.executable, (await runGit(repo, ['log', '--format=%s'])).replace(/\n/gu, ',')].join(
        '|',
      ),
    )
  }
  assert.equal(new Set(observed.map((entry) => entry.split('|')[1])).size, 1)
  assert.equal(observed[0]?.startsWith(bundled.executable), true)
  assert.equal(observed[1]?.startsWith('git|'), true)
  configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
})

test('guarded ref transactions report the required Git version before running', {
  skip: process.platform === 'win32',
}, async () => {
  const old = await provisionRuntime({ version: '2.20.1', reportedVersion: '2.20.1' })
  const { repo, git } = await repository()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    configureGitRuntime({
      appVersion: APP_VERSION,
      packaged: true,
      resourcesRoot: old.resourcesRoot,
      useSystemGit: false,
    })
    const runtime = await resolveGitRuntime()
    assert.equal(runtime.version, '2.20.1')
    assert.equal(runtime.meetsMinimum, false)
    assert.equal(runtime.capabilities.referenceTransactions, false)

    await assert.rejects(
      requireGitCapability('referenceTransactions', 'merge a branch'),
      /Cannot merge a branch: bundled Git 2\.20\.1 .* is older than the required Git 2\.29\.0/u,
    )
    await writeFile(join(repo, 'other.txt'), 'other\n')
    await runAction(repo, { type: 'stage', paths: ['other.txt'] })
    await assert.rejects(
      runAction(repo, commitAction(repo, 'Add other file')),
      /is older than the required Git 2\.29\.0/u,
    )
    assert.equal(git('log', '--format=%s', '-1'), 'Initial commit')
  } finally {
    configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
  }
})

function shellQuotedPath(file: string): string {
  return `'${file.replaceAll('\\', '/').replaceAll("'", `'"'"'`)}'`
}

function testOnRuntimes(name: string, scenario: () => Promise<void>) {
  for (const useSystemGit of [false, true]) {
    test(`${name} (${useSystemGit ? 'system' : 'bundled'} Git)`, async () => {
      configureGitRuntime({
        appVersion: APP_VERSION,
        packaged: true,
        resourcesRoot: releaseResources,
        useSystemGit,
        env: process.env,
      })
      try {
        await scenario()
      } finally {
        configureGitRuntime({ resourcesRoot: null, packaged: false, useSystemGit: false })
      }
    })
  }
}

testOnRuntimes('a repository hook runs and receives the preserved Git environment', async () => {
  const { repo, git } = await repository()
  const hooks = join(repo, 'user-hooks')
  await mkdir(hooks, { recursive: true })
  const marker = join(repo, 'hook-ran.txt')
  await writeFile(
    join(hooks, 'pre-commit'),
    `#!/bin/sh\nprintf 'pre-commit|%s|%s' "$GIT_SSH_COMMAND" "$SSH_AUTH_SOCK" > ${shellQuotedPath(marker)}\n`,
    { mode: 0o755 },
  )
  await chmod(join(hooks, 'pre-commit'), 0o755)
  git('config', 'core.hooksPath', hooks)
  process.env.GIT_SSH_COMMAND = 'ssh -i /keys/deploy'
  process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    await runAction(repo, { type: 'stage', paths: ['shared.txt'] })
    await runAction(repo, commitAction(repo, 'Add shared file'))
    assert.equal(await readFile(marker, 'utf8'), 'pre-commit|ssh -i /keys/deploy|/tmp/agent.sock')
    assert.equal(
      (await runGit(repo, ['config', '--path', '--get', 'core.hooksPath']))
        .trim()
        .replace(/\\/gu, '/')
        .toLowerCase(),
      hooks.replace(/\\/gu, '/').toLowerCase(),
    )
  } finally {
    delete process.env.GIT_SSH_COMMAND
    delete process.env.SSH_AUTH_SOCK
  }
})

testOnRuntimes('commit signing is neither forced nor silently bypassed', async () => {
  const { repo, git } = await repository()
  await writeFile(join(repo, 'shared.txt'), 'base\n')
  git('add', '.')
  await runAction(repo, commitAction(repo, 'Unsigned commit'))
  assert.equal(git('log', '--format=%s', '-1'), 'Unsigned commit')

  git('config', 'commit.gpgsign', 'true')
  git('config', 'user.signingkey', '0000000000000000000000000000000000000000')
  git('config', 'gpg.program', 'git-stacks-missing-signer')
  await writeFile(join(repo, 'signed.txt'), 'signed\n')
  await runAction(repo, { type: 'stage', paths: ['signed.txt'] })
  await assert.rejects(runAction(repo, commitAction(repo, 'Signed commit')))
  assert.equal(git('log', '--format=%s', '-1'), 'Unsigned commit')

  git('config', 'commit.gpgsign', 'false')
  await runAction(repo, commitAction(repo, 'Signed commit'))
  assert.equal(git('log', '--format=%s', '-1'), 'Signed commit')
})

testOnRuntimes(
  'a configured credential helper supplies credentials to a remote operation',
  async () => {
    const authorizations: (string | undefined)[] = []
    const server: Server = createServer((request, response) => {
      authorizations.push(request.headers.authorization)
      response.writeHead(401, { 'www-authenticate': 'Basic realm="git"' })
      response.end('unauthorized')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const { repo, git } = await repository()
    const marker = join(repo, 'helper-ran.txt')
    git('remote', 'add', 'origin', `http://127.0.0.1:${port}/workspace.git`)
    git(
      'config',
      'credential.helper',
      `!f() { echo ran >> ${shellQuotedPath(marker)}; echo "username=git-stacks"; echo "password=s3cret-token"; }; f`,
    )
    // A machine-wide credential helper would answer first, so this case runs against no
    // inherited configuration; the repository's own helper is the only source of secrets.
    const isolated = join(await temporaryRoot('git-stacks-credential-'), 'gitconfig')
    await writeFile(isolated, '')
    process.env.GIT_CONFIG_GLOBAL = isolated
    process.env.GIT_CONFIG_SYSTEM = isolated
    process.env.GIT_TERMINAL_PROMPT = '0'
    try {
      await assert.rejects(runAction(repo, { type: 'fetch' }))
      assert.match(await readFile(marker, 'utf8'), /^ran$/mu)
      assert.equal(authorizations.length, 2)
      assert.equal(authorizations[0], undefined)
      assert.equal(
        authorizations[1],
        `Basic ${Buffer.from('git-stacks:s3cret-token').toString('base64')}`,
      )
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL
      delete process.env.GIT_CONFIG_SYSTEM
      delete process.env.GIT_TERMINAL_PROMPT
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)

testOnRuntimes('a clean and smudge filter configured like Git LFS still runs', async () => {
  const { repo, git } = await repository()
  const filters = join(repo, "lfs filters' path")
  await mkdir(filters, { recursive: true })
  const cleanMarker = join(filters, 'clean.log')
  const smudgeMarker = join(filters, 'smudge.log')
  const clean = join(filters, 'clean')
  const smudge = join(filters, 'smudge')
  await writeFile(clean, `#!/bin/sh\necho "$1" >> ${shellQuotedPath(cleanMarker)}\ncat\n`, {
    mode: 0o755,
  })
  await writeFile(smudge, `#!/bin/sh\necho "$1" >> ${shellQuotedPath(smudgeMarker)}\ncat\n`, {
    mode: 0o755,
  })
  await chmod(clean, 0o755)
  await chmod(smudge, 0o755)
  git('config', 'filter.lfs.clean', `${shellQuotedPath(clean)} %f`)
  git('config', 'filter.lfs.smudge', `${shellQuotedPath(smudge)} %f`)
  git('config', 'filter.lfs.required', 'true')
  await writeFile(join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  await writeFile(join(repo, 'model.bin'), 'version https://git-lfs.github.com/spec/v1\n')
  // A machine-wide Git LFS installation configures filter.lfs.process, which would
  // replace the repository's own filter driver, so this case runs against no global config.
  const globalConfig = join(await temporaryRoot('git-stacks-global-'), 'gitconfig')
  await writeFile(globalConfig, '')
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  try {
    await runAction(repo, { type: 'stage', paths: ['model.bin'] })
    assert.match(await readFile(cleanMarker, 'utf8'), /model\.bin/u)
    await rm(join(repo, 'model.bin'))
    await runGit(repo, ['checkout', '--', 'model.bin'])
    assert.match(await readFile(smudgeMarker, 'utf8'), /model\.bin/u)
    assert.equal(
      (await runGit(repo, ['config', '--get', 'filter.lfs.clean'])).trim(),
      `${shellQuotedPath(clean)} %f`,
    )
  } finally {
    delete process.env.GIT_CONFIG_GLOBAL
    await rm(filters, { recursive: true, force: true })
  }
})

const NO_LOCKS: SettingsLock[] = []

test('the system Git override is stored as a reversible preference', async () => {
  const settings = join(await temporaryRoot('git-stacks-settings-'), 'settings.json')
  // With no stored preference the bundled runtime is the answer.
  assert.equal(await readGitRuntimePreference(settings), false)
  await updateSettings(settings, { git: { useSystemGit: true } }, NO_LOCKS)
  assert.equal(await readGitRuntimePreference(settings), true)
  // A stored value that is not a boolean must never resolve to "use system
  // Git": the default is the only safe reading of a value that means nothing.
  await writeFile(settings, JSON.stringify({ git: { useSystemGit: 'yes' } }))
  assert.equal(await readGitRuntimePreference(settings), false)
  // The string "false" is truthy to every consumer, so it must not be read as
  // a preference to use system Git.
  await writeFile(settings, JSON.stringify({ git: { useSystemGit: 'false' } }))
  assert.equal(await readGitRuntimePreference(settings), false)
  await updateSettings(settings, { git: { useSystemGit: false } }, NO_LOCKS)
  assert.equal(await readGitRuntimePreference(settings), false)
})

test('diagnostics retain the system override when its executable cannot start', async () => {
  const settings = join(await temporaryRoot('git-stacks-settings-'), 'settings.json')
  await updateSettings(settings, { git: { useSystemGit: true } }, NO_LOCKS)
  configureGitRuntime({
    packaged: true,
    resourcesRoot: releaseResources,
    useSystemGit: true,
    env: { PATH: '/nonexistent' },
  })
  try {
    const status = await gitRuntimeStatus(settings)
    assert.equal(status.runtime, null)
    assert.equal(status.useSystemGit, true)
    assert.match(status.error ?? '', /Git could not be started/u)
    configureGitRuntime({ useSystemGit: false, env: process.env, appVersion: APP_VERSION })
    const restored = await gitRuntimeStatus(settings)
    assert.equal(restored.runtime?.source, 'bundled')
  } finally {
    configureGitRuntime({
      packaged: false,
      resourcesRoot: null,
      useSystemGit: false,
      env: process.env,
    })
  }
})
