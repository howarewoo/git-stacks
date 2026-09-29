import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import type {
  BundledRuntimeInfo,
  GitCapability,
  GitRuntimeInfo,
  GitRuntimeStatus,
} from '../shared/types'

import { readSettingsFile } from './settings'
const execFileAsync = promisify(execFileCallback)

/** Oldest Git the guarded ref transactions can run on (`rev-parse --show-object-format`). */
export const MINIMUM_GIT_VERSION = '2.29.0'

/** Git releases that introduced the capabilities Git Stacks depends on. */
export const GIT_CAPABILITY_VERSIONS = {
  referenceTransactions: '2.27.0',
  rebaseUpdateRefs: '2.38.0',
} as const

/** Environment handed to Git unchanged so user SSH, LFS, proxy, and askpass setup keeps working. */
export const PRESERVED_ENVIRONMENT = [
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'GIT_PROXY_COMMAND',
  'GIT_LFS_SKIP_SMUDGE',
  'GIT_LFS_SKIP_DOWNLOAD',
] as const

/** User configuration the runtime never overrides, so hooks, signing, and credential helpers still run. */
export const PRESERVED_CONFIGURATION = [
  'core.hooksPath',
  'core.sshCommand',
  'credential.helper',
  'commit.gpgsign',
  'tag.gpgsign',
  'user.signingkey',
  'gpg.format',
  'filter.lfs.clean',
  'filter.lfs.smudge',
] as const

export type GitRuntimeRecord = GitRuntimeInfo

export interface BundledRuntimeManifest {
  appVersion: string
  platforms: Record<string, BundledRuntimeInfo>
}

export interface GitRuntimeConfiguration {
  useSystemGit: boolean
  packaged: boolean
  resourcesRoot: string | null
  appVersion: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
}

interface FileFingerprint {
  mtimeMs: number
  size: number
  ino: number
  mode: number
}

interface BundledVerification {
  info: BundledRuntimeInfo
  fingerprints: Record<string, FileFingerprint>
  dirMtimes: Record<string, number>
}
interface ManifestRead {
  manifest: BundledRuntimeManifest | null
  digest: string | null
}

const runtimeScope = new AsyncLocalStorage<GitRuntimeRecord>()

export function withGitRuntime<T>(runtime: GitRuntimeRecord, fn: () => Promise<T>): Promise<T> {
  return runtimeScope.run(runtime, fn)
}

let configuration: GitRuntimeConfiguration | null = null
let cached: {
  key: string
  record: GitRuntimeRecord
  fingerprints?: Record<string, FileFingerprint>
  manifestDigest?: string
  dirMtimes?: Record<string, number>
} | null = null
let trustedManifest: {
  resourcesRoot: string | null
  appVersion: string
  platform: string
  digest: string
} | null = null
/** Point the resolver at this build's resources directory and record the system-Git override. */
export function configureGitRuntime(
  next: Partial<GitRuntimeConfiguration>,
): GitRuntimeConfiguration {
  configuration = {
    useSystemGit: false,
    packaged: false,
    resourcesRoot: null,
    appVersion: '',
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    ...configuration,
    ...next,
  }
  cached = null
  return configuration
}

export function platformKey(platform: NodeJS.Platform | string, arch: string): string {
  return `${platform}-${arch}`
}

/** Compare dotted numeric versions; negative, zero, or positive. */
export function compareGitVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number(part) || 0)
  const rightParts = right.split('.').map((part) => Number(part) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function parseVersion(versionOutput: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/u.exec(versionOutput)
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? 0)}` : null
}

function parseManifest(value: unknown): BundledRuntimeManifest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.appVersion !== 'string') return null
  if (typeof record.platforms !== 'object' || record.platforms === null) return null
  const platforms: Record<string, BundledRuntimeInfo> = {}
  for (const [key, entry] of Object.entries(record.platforms as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) return null
    const fields = entry as Record<string, unknown>
    if (
      typeof fields.gitVersion !== 'string' ||
      typeof fields.sha256 !== 'string' ||
      typeof fields.source !== 'string'
    ) {
      return null
    }
    platforms[key] = {
      gitVersion: fields.gitVersion,
      sha256: fields.sha256,
      source: fields.source,
      files:
        typeof fields.files === 'object' && fields.files !== null
          ? (fields.files as Record<string, string>)
          : undefined,
    }
  }
  return { appVersion: record.appVersion, platforms }
}

async function readManifest(resourcesRoot: string | null): Promise<ManifestRead> {
  if (!resourcesRoot) return { manifest: null, digest: null }
  try {
    const contents = await fs.readFile(join(resourcesRoot, 'git', 'runtime-manifest.json'))
    const stored: unknown = JSON.parse(contents.toString('utf8'))
    return {
      manifest: parseManifest(stored),
      digest: createHash('sha256').update(contents).digest('hex'),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { manifest: null, digest: null }
    throw new Error(
      `The bundled Git runtime manifest could not be read: ${(error as Error).message}`,
    )
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}
async function runtimeFiles(
  directory: string,
  prefix = '',
): Promise<{
  files: Record<string, string>
  fingerprints: Record<string, FileFingerprint>
  dirMtimes: Record<string, number>
}> {
  const files: Record<string, string> = {}
  const fingerprints: Record<string, FileFingerprint> = {}
  const dirMtimes: Record<string, number> = {}

  async function walk(dir: string, currentPrefix: string) {
    const dirStat = await fs.stat(dir)
    dirMtimes[currentPrefix || '.'] = dirStat.mtimeMs
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const name = currentPrefix ? `${currentPrefix}/${item.name}` : item.name
      const path = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(path, name)
      } else if (item.isSymbolicLink()) {
        const lstat = await fs.lstat(path)
        files[name] = `link:${await fs.readlink(path)}`
        fingerprints[name] = {
          mtimeMs: lstat.mtimeMs,
          size: lstat.size,
          ino: lstat.ino,
          mode: lstat.mode,
        }
      } else if (item.isFile()) {
        const lstat = await fs.lstat(path)
        files[name] = await sha256(path)
        fingerprints[name] = {
          mtimeMs: lstat.mtimeMs,
          size: lstat.size,
          ino: lstat.ino,
          mode: lstat.mode,
        }
      } else {
        throw new Error(`Unexpected bundled Git runtime entry: ${name}`)
      }
    }
  }

  await walk(directory, prefix)
  return { files, fingerprints, dirMtimes }
}

async function assertBundledRuntime(
  manifest: BundledRuntimeManifest | null,
  platform: string,
  executable: string,
): Promise<BundledVerification> {
  if (configuration?.packaged && manifest?.appVersion !== configuration.appVersion) {
    throw new Error(
      `The bundled Git runtime manifest records app version ${manifest?.appVersion ?? 'none'} and does not match this build. Git Stacks only runs the Git runtime that ships with its own release.`,
    )
  }
  const entry = manifest?.platforms[platform] ?? null
  if (!entry) {
    if (configuration?.packaged) {
      throw new Error(
        `This build records no Git runtime for ${platform}. Git Stacks only runs a Git runtime that ships inside a signed release.`,
      )
    }
    return {
      info: { gitVersion: '', sha256: '', source: 'unverified development runtime' },
      fingerprints: {},
      dirMtimes: {},
    }
  }
  if (
    !/^[a-f0-9]{64}$/iu.test(entry.sha256) ||
    entry.sha256.toLowerCase() !== (await sha256(executable))
  ) {
    throw new Error(
      `The bundled Git runtime at ${executable} does not match its release digest. Reinstall Git Stacks from a signed release.`,
    )
  }
  let fingerprints: Record<string, FileFingerprint> = {}
  let dirMtimes: Record<string, number> = {}
  if (configuration?.packaged) {
    if (!entry.files || Object.values(entry.files).some((hash) => typeof hash !== 'string')) {
      throw new Error('The bundled Git runtime has no complete release inventory.')
    }
    const actual = await runtimeFiles(dirname(dirname(executable)))
    if (
      Object.keys(actual.files).length !== Object.keys(entry.files).length ||
      Object.entries(actual.files).some(([name, hash]) => entry.files?.[name] !== hash)
    ) {
      throw new Error('The bundled Git runtime files do not match the signed release inventory.')
    }
    fingerprints = actual.fingerprints
    dirMtimes = actual.dirMtimes
  }
  return { info: entry, fingerprints, dirMtimes }
}
/** Relocate managed Git's helpers without replacing user credentials, hooks, or Git config. */
export function gitCommandEnvironment(
  runtime: Pick<GitRuntimeInfo, 'source' | 'executable' | 'platform'>,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (runtime.source !== 'bundled') return environment
  const root = dirname(dirname(runtime.executable))
  const windows = runtime.platform.startsWith('win32-')
  const env = { ...environment }
  env.GIT_EXEC_PATH = join(
    root,
    windows ? (runtime.platform.endsWith('-arm64') ? 'clangarm64' : 'mingw64') : '',
    'libexec',
    'git-core',
  )
  if (windows) {
    const prefix = runtime.platform.endsWith('-arm64') ? 'clangarm64' : 'mingw64'
    env.PATH = [join(root, prefix, 'bin'), join(root, 'usr', 'bin'), env.PATH]
      .filter(Boolean)
      .join(';')
  } else {
    if (env.GIT_CONFIG_SYSTEM === undefined) env.GIT_CONFIG_SYSTEM = join(root, 'etc', 'gitconfig')
    if (env.GIT_TEMPLATE_DIR === undefined)
      env.GIT_TEMPLATE_DIR = join(root, 'share', 'git-core', 'templates')
    if (runtime.platform.startsWith('linux-')) {
      env.PREFIX = root
      if (env.GIT_SSL_CAINFO === undefined) env.GIT_SSL_CAINFO = join(root, 'ssl', 'cacert.pem')
    }
  }
  return env
}

/** Resolve the one Git executable every Git Stacks operation runs through, and record its facts. */
export async function resolveGitRuntime(): Promise<GitRuntimeRecord> {
  const scoped = runtimeScope.getStore()
  if (scoped) return scoped

  configuration ??= configureGitRuntime({})
  const settings = configuration
  const key = JSON.stringify([
    settings.useSystemGit,
    settings.packaged,
    settings.resourcesRoot,
    settings.appVersion,
    settings.env.GIT_STACKS_BUNDLED_GIT ?? '',
    settings.env.PATH ?? '',
    settings.platform,
    settings.arch,
  ])
  if (cached?.key === key) {
    const { record, fingerprints, dirMtimes } = cached
    if (record.packaged && record.bundled) {
      try {
        const current = await readManifest(settings.resourcesRoot)
        if (current.manifest?.appVersion !== settings.appVersion) {
          throw new Error(
            `The bundled Git runtime manifest records app version ${current.manifest?.appVersion ?? 'none'} and does not match this build. Git Stacks only runs the Git runtime that ships with its own release.`,
          )
        }
        if (
          !current.manifest.platforms[record.platform] ||
          current.digest !== cached.manifestDigest
        ) {
          throw new Error(
            'The bundled Git runtime manifest does not match the signed release inventory.',
          )
        }
      } catch (error) {
        cached = null
        throw error
      }
    }
    if (record.packaged && record.bundled) {
      const root = dirname(dirname(record.executable))
      const execStat = await fs.lstat(record.executable).catch(() => null)
      if (!execStat) {
        cached = null
        throw new Error(
          `The bundled Git runtime at ${record.executable} does not match its release digest. Reinstall Git Stacks from a signed release.`,
        )
      }
      const execRel = relative(root, record.executable).replace(/\\/gu, '/')
      const execFp = fingerprints?.[execRel]
      if (
        !execFp ||
        execFp.mtimeMs !== execStat.mtimeMs ||
        execFp.size !== execStat.size ||
        execFp.ino !== execStat.ino ||
        execFp.mode !== execStat.mode
      ) {
        const hash = await sha256(record.executable)
        if (hash !== record.bundled.sha256) {
          cached = null
          throw new Error(
            `The bundled Git runtime at ${record.executable} does not match its release digest. Reinstall Git Stacks from a signed release.`,
          )
        }
        if (fingerprints) {
          fingerprints[execRel] = {
            mtimeMs: execStat.mtimeMs,
            size: execStat.size,
            ino: execStat.ino,
            mode: execStat.mode,
          }
        }
      }

      if (record.bundled.files) {
        if (dirMtimes) {
          for (const [dirRel, expectedMtime] of Object.entries(dirMtimes)) {
            const dirStat = await fs.stat(join(root, dirRel)).catch(() => null)
            if (!dirStat || dirStat.mtimeMs !== expectedMtime) {
              const actual = await runtimeFiles(root).catch(() => null)
              if (
                !actual ||
                Object.keys(actual.files).length !== Object.keys(record.bundled.files).length ||
                Object.entries(actual.files).some(
                  ([name, hash]) => record.bundled?.files?.[name] !== hash,
                )
              ) {
                cached = null
                throw new Error(
                  'The bundled Git runtime files do not match the signed release inventory.',
                )
              }
              for (const [d, m] of Object.entries(actual.dirMtimes)) dirMtimes[d] = m
              for (const [f, fp] of Object.entries(actual.fingerprints)) {
                if (fingerprints) fingerprints[f] = fp
              }
            }
          }
        }

        for (const [relPath, expected] of Object.entries(record.bundled.files)) {
          if (relPath === execRel) continue
          const absPath = join(root, relPath)
          const stat = await fs.lstat(absPath).catch(() => null)
          if (!stat) {
            cached = null
            throw new Error(
              'The bundled Git runtime files do not match the signed release inventory.',
            )
          }
          const fp = fingerprints?.[relPath]
          if (
            !fp ||
            fp.mtimeMs !== stat.mtimeMs ||
            fp.size !== stat.size ||
            fp.ino !== stat.ino ||
            fp.mode !== stat.mode
          ) {
            if (expected.startsWith('link:')) {
              const target = await fs.readlink(absPath).catch(() => null)
              if (`link:${target}` !== expected) {
                cached = null
                throw new Error(
                  'The bundled Git runtime files do not match the signed release inventory.',
                )
              }
            } else {
              const fileHash = await sha256(absPath)
              if (fileHash !== expected) {
                cached = null
                throw new Error(
                  'The bundled Git runtime files do not match the signed release inventory.',
                )
              }
            }
            if (fingerprints) {
              fingerprints[relPath] = {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                ino: stat.ino,
                mode: stat.mode,
              }
            }
          }
        }
      }
    }
    return record
  }

  const platform = platformKey(settings.platform, settings.arch)
  const candidates = settings.useSystemGit
    ? []
    : [
        !settings.packaged ? settings.env.GIT_STACKS_BUNDLED_GIT : null,
        settings.resourcesRoot
          ? join(
              settings.resourcesRoot,
              'git',
              platform,
              settings.platform === 'win32' ? 'cmd' : 'bin',
              settings.platform === 'win32' ? 'git.exe' : 'git',
            )
          : null,
      ].filter((candidate): candidate is string => Boolean(candidate))

  let executable = 'git'
  let source: GitRuntimeInfo['source'] = 'system'
  for (const candidate of candidates) {
    const info = await fs.stat(candidate).catch(() => null)
    if (info?.isFile()) {
      executable = candidate
      source = 'bundled'
      break
    }
  }
  if (source === 'system' && settings.packaged && !settings.useSystemGit) {
    throw new Error(
      `The bundled Git runtime for ${platform} is missing from this build. Turn on Use system Git in Git runtime diagnostics to run a Git installed on this computer.`,
    )
  }
  const manifestRead = source === 'bundled' ? await readManifest(settings.resourcesRoot) : null
  if (
    source === 'bundled' &&
    settings.packaged &&
    trustedManifest?.resourcesRoot === settings.resourcesRoot &&
    trustedManifest.appVersion === settings.appVersion &&
    trustedManifest.platform === platform &&
    manifestRead?.digest !== trustedManifest.digest
  ) {
    throw new Error('The bundled Git runtime manifest does not match the signed release inventory.')
  }
  const verification =
    source === 'bundled'
      ? await assertBundledRuntime(manifestRead?.manifest ?? null, platform, executable)
      : null
  const bundled = verification?.info ?? null

  let versionOutput = ''
  try {
    const result = await execFileAsync(executable, ['--version'], {
      env: gitCommandEnvironment({ source, executable, platform }, settings.env),
      timeout: 20_000,
      windowsHide: true,
      encoding: 'utf8',
    })
    versionOutput = String(result.stdout).trim()
  } catch (error) {
    throw new Error(
      `Git could not be started from ${executable} (${source} Git): ${(error as Error).message}`,
    )
  }
  const version = parseVersion(versionOutput)
  if (!version) {
    throw new Error(`Could not read a version from "${versionOutput}" reported by ${executable}.`)
  }
  if (bundled && bundled.gitVersion && bundled.gitVersion !== version) {
    throw new Error(
      `The bundled Git runtime reports ${version} but the release manifest records ${bundled.gitVersion}.`,
    )
  }

  const record: GitRuntimeRecord = {
    source,
    executable,
    platform,
    version,
    versionOutput,
    minimumVersion: MINIMUM_GIT_VERSION,
    meetsMinimum: compareGitVersions(version, MINIMUM_GIT_VERSION) >= 0,
    useSystemGit: settings.useSystemGit,
    packaged: settings.packaged,
    capabilities: {
      referenceTransactions:
        compareGitVersions(version, GIT_CAPABILITY_VERSIONS.referenceTransactions) >= 0,
      rebaseUpdateRefs: compareGitVersions(version, GIT_CAPABILITY_VERSIONS.rebaseUpdateRefs) >= 0,
    },
    bundled,
    preservedEnvironment: PRESERVED_ENVIRONMENT,
    preservedConfiguration: PRESERVED_CONFIGURATION,
  }
  if (settings.packaged && manifestRead?.digest) {
    trustedManifest = {
      resourcesRoot: settings.resourcesRoot,
      appVersion: settings.appVersion,
      platform,
      digest: manifestRead.digest,
    }
  }
  cached = {
    key,
    record,
    fingerprints: verification?.fingerprints,
    dirMtimes: verification?.dirMtimes,
    manifestDigest: manifestRead?.digest ?? undefined,
  }
  return record
}

/** Fail an operation with an explicit message when the resolved runtime cannot provide what it needs. */
export async function requireGitCapability(
  capability: GitCapability,
  operation: string,
): Promise<GitRuntimeRecord> {
  const record = await resolveGitRuntime()
  const remedy =
    'Update Git, or turn off Use system Git in Git runtime diagnostics to return to the bundled runtime.'
  if (!record.meetsMinimum) {
    throw new Error(
      `Cannot ${operation}: ${record.source} Git ${record.version} at ${record.executable} is older than the required Git ${record.minimumVersion}. ${remedy}`,
    )
  }
  if (!record.capabilities[capability]) {
    throw new Error(
      `Cannot ${operation}: ${record.source} Git ${record.version} at ${record.executable} does not provide ${capability} (Git ${GIT_CAPABILITY_VERSIONS[capability]} or newer). ${remedy}`,
    )
  }
  return record
}

/**
 * Whether the settings document asks for the system Git. This is one field of
 * the unified settings file, so it is validated and policy-locked the same way
 * as every other setting; there is no second file and no second write path.
 */
export async function readGitRuntimePreference(settingsFile: string): Promise<boolean> {
  const { settings } = await readSettingsFile(settingsFile)
  return settings.git.useSystemGit
}

/** Diagnostics retain the configured preference even if its selected executable cannot start. */
export async function gitRuntimeStatus(settingsFile: string): Promise<GitRuntimeStatus> {
  try {
    const runtime = await resolveGitRuntime()
    return {
      runtime,
      useSystemGit: runtime.useSystemGit,
      error: null,
      minimumVersion: MINIMUM_GIT_VERSION,
    }
  } catch (error) {
    return {
      runtime: null,
      useSystemGit: await readGitRuntimePreference(settingsFile),
      error: error instanceof Error ? error.message : String(error),
      minimumVersion: MINIMUM_GIT_VERSION,
    }
  }
}
