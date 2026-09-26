import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { BundledRuntimeInfo, GitCapability, GitRuntimeInfo } from '../shared/types'

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

let configuration: GitRuntimeConfiguration | null = null
let cached: { key: string; record: GitRuntimeRecord } | null = null

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
    }
  }
  return { appVersion: record.appVersion, platforms }
}

async function readManifest(resourcesRoot: string | null): Promise<BundledRuntimeManifest | null> {
  if (!resourcesRoot) return null
  try {
    const stored: unknown = JSON.parse(
      await fs.readFile(join(resourcesRoot, 'git', 'runtime-manifest.json'), 'utf8'),
    )
    return parseManifest(stored)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(
      `The bundled Git runtime manifest could not be read: ${(error as Error).message}`,
    )
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex')
}

async function assertBundledRuntime(
  manifest: BundledRuntimeManifest | null,
  platform: string,
  executable: string,
  version: string,
): Promise<BundledRuntimeInfo> {
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
    return { gitVersion: version, sha256: '', source: 'unverified development runtime' }
  }
  if (entry.gitVersion !== version) {
    throw new Error(
      `The bundled Git runtime reports ${version} but the release manifest records ${entry.gitVersion}.`,
    )
  }
  if (entry.sha256.toLowerCase() !== (await sha256(executable))) {
    throw new Error(
      `The bundled Git runtime at ${executable} does not match its release digest. Reinstall Git Stacks from a signed release.`,
    )
  }
  return entry
}

/** Resolve the one Git executable every Git Stacks operation runs through, and record its facts. */
export async function resolveGitRuntime(): Promise<GitRuntimeRecord> {
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
  if (cached?.key === key) return cached.record

  const platform = platformKey(settings.platform, settings.arch)
  const candidates = settings.useSystemGit
    ? []
    : [
        settings.env.GIT_STACKS_BUNDLED_GIT,
        settings.resourcesRoot
          ? join(
              settings.resourcesRoot,
              'git',
              platform,
              'bin',
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

  let versionOutput = ''
  try {
    const result = await execFileAsync(executable, ['--version'], {
      env: settings.env,
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
    bundled:
      source === 'bundled'
        ? await assertBundledRuntime(
            await readManifest(settings.resourcesRoot),
            platform,
            executable,
            version,
          )
        : null,
    preservedEnvironment: PRESERVED_ENVIRONMENT,
    preservedConfiguration: PRESERVED_CONFIGURATION,
  }
  cached = { key, record }
  return record
}

export async function gitExecutable(): Promise<string> {
  return (await resolveGitRuntime()).executable
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

export async function readGitRuntimePreference(
  settingsFile: string,
): Promise<{ useSystemGit: boolean } | null> {
  try {
    const stored: unknown = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
    const value = (stored as { useSystemGit?: unknown } | null)?.useSystemGit
    return typeof value === 'boolean' ? { useSystemGit: value } : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeGitRuntimePreference(
  settingsFile: string,
  value: { useSystemGit: boolean },
): Promise<void> {
  await fs.mkdir(dirname(settingsFile), { recursive: true })
  const temporaryPath = `${settingsFile}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600 })
  await fs.rename(temporaryPath, settingsFile)
}
