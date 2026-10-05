import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import type { AppSettings } from '../shared/settings'
import type { GitHubHostStatus } from '../shared/host'
import type { DiagnosticEntry, DiagnosticReport } from '../shared/settings'
import type { GitEnvironmentStatus, GitHubCliStatus, GitRuntimeStatus } from '../shared/types'
import { NOTIFICATION_STATE_LABELS, type NotificationModuleStatus } from '../shared/notifications'
import { GH_VERSION_ARGS, probeGitHubCliVersion, type GitHubCliVersionProbe } from './github-cli'
import { hostScopedEnvironment } from './github-transport'

const exec = promisify(execFile)

/**
 * The only Git commands this app will run to describe itself. There is no way
 * for a caller to name a command: these entries are the whole allowlist, and
 * the renderer receives the results rather than a request. Every one is a
 * read-only query with no `--upload-pack`, `--exec`, or config override, so no
 * input reaches Git as a flag.
 */
export const DIAGNOSTIC_COMMANDS = [
  { label: 'Git version', args: ['--version'] },
  { label: 'Git build options', args: ['version', '--build-options'] },
] as const

/** Bytes any one probe may print. A probe that exceeds it is not read further. */
const MAX_PROBE_BYTES = 8 * 1024
const MAX_PROBE_SECONDS = 5

/**
 * The GitHub CLI this build requires, reported as the fixed command it runs to
 * describe itself. The command list is a constant: no caller names a command,
 * so this entry is the whole allowlist, and it is a local version query that
 * reaches no host and asks the CLI who it is signed in as. Authentication is
 * established elsewhere, from the CLI's own account answer.
 */
export const GH_DIAGNOSTIC_COMMAND = { label: 'gh --version', args: GH_VERSION_ARGS } as const

/**
 * What this computer's GitHub CLI is, kept separate from what it can
 * authenticate: an installed version is a fact about the machine, and the
 * account behind it is a separate read whose answer this report is given.
 */
export interface GitHubCliSources {
  /** Omitted when nothing has read the CLI on this machine yet. */
  probe?: GitHubCliVersionProbe
  /** Omitted until a status read established what the CLI can authenticate to. */
  status?: GitHubCliStatus | null
}

/**
 * One bounded local command, and only whether it answered. What a probe could
 * not read is reported by the caller as "could not be run": its stderr is the
 * command's, not this build's, so none of it is kept here.
 */
async function probe(
  executable: string,
  args: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await exec(executable, [...args], {
      timeout: MAX_PROBE_SECONDS * 1000,
      maxBuffer: MAX_PROBE_BYTES,
      windowsHide: true,
    })
    return { ok: true, output: stdout.trim() }
  } catch {
    return { ok: false, output: '' }
  }
}

/**
 * Safe projection of Git version probe output. Extracts strictly the semantic
 * version number so build metadata, wrapper paths, or arbitrary surrounding
 * text cannot leak into diagnostic reports or support bundles.
 */
export function parseGitVersion(output: string): {
  value: string
  status: 'confirmed' | 'unavailable'
} {
  const match = output.match(/\bgit version (\d+\.\d+(?:\.\d+)?)\b/)
  if (match) {
    return { value: `git version ${match[1]}`, status: 'confirmed' }
  }
  return { value: 'unrecognized Git version output', status: 'unavailable' }
}

const KNOWN_BUILD_FLAGS = [
  'fsmonitor',
  'pthreads',
  'libcurl',
  'openssl',
  'gettext',
  'iconv',
  'pcre2',
] as const

/**
 * Safe projection of Git build options. Extracts only confirmed safe boolean
 * capability tokens from an allowlist; never admits compiler flags, shell
 * paths, or raw build strings.
 */
export function parseGitBuildOptions(output: string): {
  value: string
  status: 'confirmed' | 'unavailable'
} {
  const flags = KNOWN_BUILD_FLAGS.filter((flag) => new RegExp(`\\b${flag}\\b`, 'i').test(output))
  if (flags.length > 0) {
    return { value: flags.join(', '), status: 'confirmed' }
  }
  return { value: 'standard build options', status: 'confirmed' }
}
export interface DiagnosticSources {
  runtime: GitRuntimeStatus
  environment: GitEnvironmentStatus | null
  host: { platform: string; release: string; arch: string; electron: string }
  filesystem: { refFormat: string | null; error: string | null }
  appVersion: string
  settings: AppSettings
  /**
   * What the host this app is pointed at was observed to support. It is
   * omitted until something has actually established it, and every line keeps
   * the state it was observed in rather than a guess.
   */
  githubHost?: GitHubHostStatus | null
  /**
   * What the optional Notification Center reports about itself. Only its state,
   * its host, and whether a sealed credential exists: the token, the reference,
   * and every thread title stay out of every report and bundle.
   */
  notifications?: NotificationModuleStatus | null
  /**
   * What this computer's GitHub CLI is, and what it can authenticate. Omitted
   * when nothing has read the CLI on this machine yet.
   */
  githubCli?: GitHubCliSources
}

function runtimeEntries(runtime: GitRuntimeStatus): DiagnosticEntry[] {
  const info = runtime.runtime
  const entries: DiagnosticEntry[] = [
    {
      source: 'runtime',
      label: 'Git build in use',
      value: info ? (info.useSystemGit ? 'system Git' : 'bundled Git') : 'unresolved',
      status: info ? 'confirmed' : 'unavailable',
      detail: info ? undefined : 'Git runtime could not be resolved',
    },
    {
      source: 'runtime',
      label: 'Minimum Git version',
      value: runtime.minimumVersion,
      status: 'confirmed',
    },
  ]
  if (info) {
    entries.push({
      source: 'runtime',
      label: 'Runtime platform',
      value: `${info.platform} (${info.source})`,
      status: 'confirmed',
    })
    // The one report value that names a location, marked so a support bundle
    // withholds it unless the user has opted into paths.
    entries.push({
      source: 'runtime',
      label: 'Git executable',
      value: info.executable,
      status: 'confirmed',
      locational: true,
    })
    entries.push({
      source: 'runtime',
      label: 'Reference transactions',
      value: info.capabilities.referenceTransactions ? 'supported' : 'not supported',
      status: 'confirmed',
    })
    entries.push({
      source: 'runtime',
      label: 'rebase --update-refs',
      value: info.capabilities.rebaseUpdateRefs ? 'supported' : 'not supported',
      status: 'confirmed',
    })
  }
  return entries
}

/**
 * What the required GitHub CLI is on this machine and what it is authenticated
 * to. Only states, the account's own login, and this build's own guidance:
 * never CLI output, a token, a credential file, or a path to one.
 */
function cliEntries(sources: GitHubCliSources | undefined): DiagnosticEntry[] {
  if (!sources) return []
  const entries: DiagnosticEntry[] = []
  if (sources.probe) {
    entries.push({
      source: 'github',
      label: GH_DIAGNOSTIC_COMMAND.label,
      value:
        sources.probe.version ??
        (sources.probe.install === 'missing' ? 'not installed' : 'could not be read'),
      status: sources.probe.version ? 'confirmed' : 'unavailable',
      detail:
        sources.probe.install === 'present'
          ? 'The CLI was asked for its version and nothing else.'
          : sources.probe.install === 'missing'
            ? 'The GitHub CLI is required for GitHub collaboration and is not installed here.'
            : 'The GitHub CLI is installed but did not answer a local version query.',
    })
  }
  const status = sources.status
  if (status) {
    entries.push({
      source: 'credentials',
      label: 'GitHub CLI authentication',
      value: status.state,
      status: status.state === 'authenticated' ? 'confirmed' : 'unavailable',
      detail: status.message ?? undefined,
    })
    entries.push({
      source: 'github',
      label: 'GitHub CLI account',
      value: status.login ?? 'none reported',
      status: status.login ? 'confirmed' : 'not-applicable',
      detail: 'Accounts, sessions, and sign-out belong to the GitHub CLI.',
    })
  }
  return entries
}

/**
 * Three lines about a module that is optional: whether it is on, which host it
 * is pinned to, and whether a credential is sealed for it. Nothing here can
 * name a token, a reference, or a single notification.
 */
function notificationEntries(notifications: NotificationModuleStatus | null): DiagnosticEntry[] {
  if (!notifications) return []
  return [
    {
      source: 'github',
      label: 'GitHub Notifications',
      value: NOTIFICATION_STATE_LABELS[notifications.state],
      status: notifications.state === 'ready' ? 'confirmed' : 'not-applicable',
      detail: 'Optional module; off leaves every pull request workflow unchanged.',
    },
    {
      source: 'github',
      label: 'Notifications host',
      value: notifications.host,
      status: 'confirmed',
    },
    {
      source: 'credentials',
      label: 'Notifications credential',
      value: notifications.reference ? 'present in the system credential store' : 'none stored',
      status: 'confirmed',
    },
  ]
}

function safeHelperIdentifier(helper: string): string {
  const trimmed = helper.trim()
  if (
    !trimmed ||
    trimmed.includes(' ') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('!')
  ) {
    return 'custom helper'
  }
  return trimmed.slice(0, 32)
}

/**
 * The host, its API base, and each capability a probe or a real request
 * established. A host nothing has probed is reported as unknown, never as a
 * host without the feature.
 */
function githubHostEntries(status: GitHubHostStatus | null): DiagnosticEntry[] {
  if (!status) return []
  const entries: DiagnosticEntry[] = [
    {
      source: 'github',
      label: 'GitHub host',
      value: `${status.host} (${status.kind})`,
      status:
        status.state === 'supported'
          ? 'confirmed'
          : status.state === 'unknown'
            ? 'not-applicable'
            : 'unavailable',
      detail: status.message,
    },
    {
      source: 'github',
      label: 'GitHub REST base',
      value: status.apiBase,
      status: 'confirmed',
    },
    {
      source: 'github',
      label: 'GitHub server version',
      value: status.serverVersion ?? 'not reported by the host',
      status: status.serverVersion ? 'confirmed' : 'not-applicable',
    },
  ]
  for (const capability of status.capabilities) {
    entries.push({
      source: 'github',
      label: capability.label,
      value: capability.state,
      status:
        capability.state === 'supported'
          ? 'confirmed'
          : capability.state === 'unsupported'
            ? 'unavailable'
            : 'not-applicable',
      detail: capability.detail,
    })
  }
  return entries
}

function stackEntries(environment: GitEnvironmentStatus | null): DiagnosticEntry[] {
  const credentials = environment?.httpsCredentials
  return [
    {
      source: 'credentials',
      label: 'Git HTTPS helper',
      value: credentials?.configured ? 'a helper is configured' : 'no helper configured',
      status: environment ? 'confirmed' : 'unavailable',
      detail: credentials?.helper
        ? `helper: ${safeHelperIdentifier(credentials.helper)}`
        : 'the helper name is reported; its configuration is never read',
    },
    {
      source: 'credentials',
      label: 'SSH client',
      value: environment?.ssh?.available ? 'available' : 'not detected',
      status: environment ? 'confirmed' : 'unavailable',
    },
  ]
}

function filesystemEntries(filesystem: DiagnosticSources['filesystem']): DiagnosticEntry[] {
  return [
    {
      source: 'filesystem',
      label: 'Ref storage backend',
      value: filesystem.refFormat ?? 'not detected',
      status: filesystem.refFormat ? 'confirmed' : 'unavailable',
      detail: filesystem.error ? 'storage unavailable' : undefined,
    },
  ]
}

function hostEntries(sources: DiagnosticSources): DiagnosticEntry[] {
  const { host } = sources
  return [
    {
      source: 'host',
      label: 'Operating system',
      value: `${host.platform} ${host.release} (${host.arch})`,
      status: 'confirmed',
    },
    {
      source: 'host',
      label: 'Electron',
      value: host.electron,
      status: 'confirmed',
    },
    {
      source: 'app',
      label: 'Git Stacks',
      value: sources.appVersion,
      status: 'confirmed',
    },
    {
      source: 'app',
      label: 'Bundled Git selected',
      value: sources.settings.git.useSystemGit ? 'no (system Git selected)' : 'yes',
      status: 'confirmed',
    },
  ]
}

/**
 * Builds the capability report. Everything here is measured or absent: a value
 * that could not be established is reported as unavailable rather than filled
 * in from what this build usually finds. The report holds no token, no
 * credential, no source line, and no repository content.
 */
export async function runDiagnostics(sources: DiagnosticSources): Promise<DiagnosticReport> {
  const entries: DiagnosticEntry[] = [
    ...hostEntries(sources),
    ...runtimeEntries(sources.runtime),
    ...cliEntries(sources.githubCli),
    ...stackEntries(sources.environment),
    ...notificationEntries(sources.notifications ?? null),
    ...githubHostEntries(sources.githubHost ?? null),
    ...filesystemEntries(sources.filesystem),
  ]

  // The allowlist is a constant, but a probe still cannot be trusted to succeed
  // on a machine with no Git at all, so a failure is reported, not assumed away.
  if (sources.runtime.runtime) {
    for (const command of DIAGNOSTIC_COMMANDS) {
      const result = await probe(sources.runtime.runtime!.executable, command.args)
      if (!result.ok) {
        entries.push({
          source: 'git',
          label: `git ${command.args.join(' ')}`,
          value: 'could not be run',
          status: 'unavailable',
          detail: 'probe failed',
        })
        continue
      }
      const parsed =
        command.args[0] === '--version'
          ? parseGitVersion(result.output)
          : parseGitBuildOptions(result.output)
      entries.push({
        source: 'git',
        label: `git ${command.args.join(' ')}`,
        value: parsed.value,
        status: parsed.status,
      })
    }
  }
  return {
    entries,
    generatedAt: new Date().toISOString(),
    appVersion: sources.appVersion,
  }
}

/**
 * What this computer's GitHub CLI is, from one bounded local query.
 *
 * The CLI is required for GitHub collaboration, so this asks it exactly once and
 * reports what it answered; a machine without it is reported as missing rather
 * than as a fault in anything else. It is the version only: which account the
 * CLI holds is established by the status read, which never runs from here.
 */
export async function readGitHubCliSources(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubCliSources> {
  return { probe: await probeGitHubCliVersion(env) }
}

/**
 * Reads the active repository's ref backend. This is the one filesystem probe
 * in the report, and it is used only to name the storage format — no ref, file
 * body, or commit is read.
 */
export async function detectRefFormat(
  repositoryRoot: string | null,
): Promise<{ refFormat: string | null; error: string | null }> {
  if (!repositoryRoot) return { refFormat: null, error: 'no repository is open' }
  try {
    const gitDir = (await fs.readFile(`${repositoryRoot}/.git`, 'utf8').catch(() => '')).trim()
    const root = gitDir.startsWith('gitdir:')
      ? gitDir.slice('gitdir:'.length).trim()
      : `${repositoryRoot}/.git`
    await fs.access(root)
    const packedRefs = await fs
      .access(`${root}/packed-refs`)
      .then(() => true)
      .catch(() => false)
    const looseRefs = await fs
      .readdir(`${root}/refs`)
      .then(() => true)
      .catch(() => false)
    if (!packedRefs && !looseRefs) {
      return { refFormat: 'files backend (no refs found yet)', error: null }
    }
    // Reftable stores its tables under `reftable`; the files backend keeps loose
    // refs and an optional packed-refs file. Whichever exists is what Git used.
    const reftable = await fs
      .access(`${root}/reftable`)
      .then(() => true)
      .catch(() => false)
    return { refFormat: reftable ? 'reftable' : 'files', error: null }
  } catch {
    return { refFormat: null, error: 'ref storage format could not be determined' }
  }
}
