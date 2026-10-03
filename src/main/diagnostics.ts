import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import type { AppSettings } from '../shared/settings'
import type { GitHubHostStatus } from '../shared/host'
import type { DiagnosticEntry, DiagnosticReport } from '../shared/settings'
import type { GitEnvironmentStatus, GitRuntimeStatus, GitHubAccountStatus } from '../shared/types'
import { NOTIFICATION_STATE_LABELS, type NotificationModuleStatus } from '../shared/notifications'
import {
  githubTransportChoice,
  hostScopedEnvironment,
  type GitHubTransportChoice,
} from './github-transport'

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
 * The only GitHub CLI command this app will run to describe itself, and the
 * only adapter this app will ever run outside Git itself. It is a local version
 * query: no subcommand of it reaches a host, reads a keychain, or asks the CLI
 * who it is signed in as. `gh auth status` and `gh auth token` are not on this
 * list and cannot be added by a caller, because a caller names no command —
 * this entry is the whole allowlist.
 */
export const GH_DIAGNOSTIC_COMMAND = { label: 'gh --version', args: ['--version'] } as const

/**
 * Safe projection of GitHub CLI version output. Strictly the semantic version
 * the CLI named, so a build date, a commit, an install path, or anything else
 * the binary chose to print cannot reach a diagnostic report or a support
 * bundle. Output this does not recognise is reported as unrecognised rather
 * than partially believed.
 */
export function parseGhVersion(output: string): {
  value: string
  status: 'confirmed' | 'unavailable'
} {
  const match = /(?:^|\s)gh version (\d{1,4}\.\d{1,4}\.\d{1,4})(?=$|\s)/u.exec(output)
  if (match) {
    return { value: `gh version ${match[1]}`, status: 'confirmed' }
  }
  return { value: 'unrecognized GitHub CLI version output', status: 'unavailable' }
}

/** What one optional adapter was observed to be, and how it was observed. */
export interface GitHubAdapterProbe {
  /**
   * Whether `gh --version` ran and answered. `false` covers both an absent CLI
   * and one that could not be started, because this report cannot tell those
   * apart without reading an error this module deliberately never inspects.
   */
  ran: boolean
  /** The raw version output, projected by {@link parseGhVersion} before use. */
  output: string
}

/**
 * One bounded `gh --version`, run the way every other child of this process is:
 * no shell, a byte cap, a deadline, and an environment carrying no GitHub
 * credential at all. A version query cannot use one, and handing the CLI an
 * ambient token would put this machine's credential behind a command that only
 * needed to print a number.
 */
async function probeGhAdapter(env: NodeJS.ProcessEnv): Promise<GitHubAdapterProbe> {
  try {
    const { stdout } = await exec('gh', [...GH_DIAGNOSTIC_COMMAND.args], {
      env: hostScopedEnvironment(env, null),
      timeout: MAX_PROBE_SECONDS * 1000,
      maxBuffer: MAX_PROBE_BYTES,
      windowsHide: true,
    })
    return { ran: true, output: stdout.trim() }
  } catch {
    // The reason is the CLI's to word and a path to its binary is this
    // machine's, so neither is read: the report says the query did not answer
    // and nothing about why.
    return { ran: false, output: '' }
  }
}

/**
 * Which adapter this process was configured to prefer, and what the optional
 * CLI answered when it was asked.
 *
 * The preference is reported as the configuration reads it, never as a claim
 * about which adapter a request will actually use: under `auto` that depends on
 * a credential this report does not read, so an unanswered question stays
 * unanswered instead of being resolved by assumption.
 */
export interface GitHubAdapterSources {
  choice: GitHubTransportChoice
  /** Omitted when this process never asked the CLI, and the report says so. */
  probe?: GitHubAdapterProbe
}

const ADAPTER_MODE_LABELS: Record<GitHubTransportChoice, string> = {
  auto: 'Automatic',
  direct: 'Direct GitHub API',
  gh: 'GitHub CLI (gh)',
}

/**
 * What each mode means for the adapter a request goes through. `auto` is not
 * resolved here: it depends on whether this process holds a usable GitHub
 * credential, and reading one to answer a settings question would be the wrong
 * reason to touch a credential.
 */
const ADAPTER_IN_USE: Record<
  GitHubTransportChoice,
  { value: string; status: DiagnosticEntry['status']; detail: string }
> = {
  auto: {
    value: 'not established',
    status: 'not-applicable',
    detail:
      'Automatic mode uses the direct API when this app holds a GitHub credential and the CLI otherwise; this report does not read one.',
  },
  direct: {
    value: 'Direct GitHub API',
    status: 'confirmed',
    detail: 'This configuration sends GitHub requests to the API itself.',
  },
  gh: {
    value: 'GitHub CLI (gh)',
    status: 'confirmed',
    detail: 'This configuration sends GitHub requests through the CLI.',
  },
}

async function probe(
  executable: string,
  args: readonly string[],
): Promise<{ ok: boolean; output: string; error: string | null }> {
  try {
    const { stdout } = await exec(executable, [...args], {
      timeout: MAX_PROBE_SECONDS * 1000,
      maxBuffer: MAX_PROBE_BYTES,
      windowsHide: true,
    })
    return { ok: true, output: stdout.trim(), error: null }
  } catch {
    return {
      ok: false,
      output: '',
      error: 'probe failed',
    }
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
  account: GitHubAccountStatus | null
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
   * The adapter this process is configured to prefer, and what the optional
   * GitHub CLI answered when it was asked. Omitted when this process has no
   * adapter preference to report.
   */
  githubAdapter?: GitHubAdapterSources
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

function accountEntries(account: GitHubAccountStatus | null): DiagnosticEntry[] {
  if (!account) {
    return [
      {
        source: 'credentials',
        label: 'GitHub account',
        value: 'status not available',
        status: 'unavailable',
        detail: 'the account status could not be read',
      },
    ]
  }
  const entries: DiagnosticEntry[] = [
    {
      source: 'credentials',
      label: 'GitHub account',
      value:
        account.state === 'signed-in'
          ? `signed in as ${account.login ?? 'unknown account'}`
          : account.state,
      status: 'confirmed',
    },
    {
      source: 'github',
      label: 'GitHub host',
      value: account.host,
      status: 'confirmed',
    },
    // Only whether a sealed credential exists. The reference itself and the
    // token behind it never reach this report.
    {
      source: 'credentials',
      label: 'Stored credential',
      value: account.reference ? 'present in the system credential store' : 'none stored',
      status: 'confirmed',
    },
    {
      source: 'credentials',
      label: 'Credential store',
      value: account.store.available
        ? (account.store.name ?? 'available')
        : (account.store.reason ?? 'unavailable'),
      status: account.store.available ? 'confirmed' : 'unavailable',
    },
    {
      source: 'credentials',
      label: 'App permissions',
      // Each entry is a { permission, access, feature } object, so it is
      // rendered the way the Account section names it rather than joined.
      value:
        account.permissions.length > 0
          ? account.permissions.map((entry) => `${entry.permission} (${entry.access})`).join(', ')
          : 'none reported',
      status: 'confirmed',
    },
  ]
  if (account.externalCredential) {
    entries.push({
      source: 'credentials',
      label: 'Credential source',
      value: 'supplied by the environment, not by Git Stacks',
      status: 'confirmed',
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

/**
 * Three lines about an adapter this build never requires: the configured mode,
 * whether the CLI is installed here, and — only when it answered — the version
 * it printed.
 *
 * A missing CLI is reported as a fact about this computer and never as a fault
 * in the installation: nothing in this app, and no sign-in, depends on it being
 * present, so there is nothing here for a person to go and fix. The report never
 * names the CLI's own account, host, or credential, and never asks it for one.
 */
function githubAdapterEntries(adapter: GitHubAdapterSources): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [
    {
      source: 'github',
      label: 'GitHub adapter mode',
      value: ADAPTER_MODE_LABELS[adapter.choice],
      status: 'confirmed',
      detail: 'Set with GIT_STACKS_GITHUB_TRANSPORT; unset or unrecognised means automatic.',
    },
    {
      source: 'github',
      label: 'GitHub adapter in use',
      value: ADAPTER_IN_USE[adapter.choice].value,
      status: ADAPTER_IN_USE[adapter.choice].status,
      detail: ADAPTER_IN_USE[adapter.choice].detail,
    },
  ]

  if (adapter.probe === undefined) {
    entries.push({
      source: 'github',
      label: GH_DIAGNOSTIC_COMMAND.label,
      value: 'not asked',
      status: 'not-applicable',
      detail: 'This configuration does not use the GitHub CLI, so this build did not run it.',
    })
    return entries
  }
  if (!adapter.probe.ran) {
    entries.push({
      source: 'github',
      label: GH_DIAGNOSTIC_COMMAND.label,
      value: 'not found, or it could not be run',
      status: 'unavailable',
      detail: 'The GitHub CLI is optional; nothing in this app needs it installed.',
    })
    return entries
  }
  const version = parseGhVersion(adapter.probe.output)
  entries.push({
    source: 'github',
    label: GH_DIAGNOSTIC_COMMAND.label,
    value: version.value,
    status: version.status,
    detail:
      version.status === 'confirmed'
        ? 'The CLI reported a version; it was asked for nothing else.'
        : 'The CLI answered with something this build does not read, so no version is claimed.',
  })
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
    ...accountEntries(sources.account),
    ...stackEntries(sources.environment),
    ...notificationEntries(sources.notifications ?? null),
    ...(sources.githubAdapter ? githubAdapterEntries(sources.githubAdapter) : []),
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
 * The adapter preference this process runs with, and whether the optional
 * GitHub CLI was asked anything.
 *
 * A configuration that resolved to the direct API never runs the CLI: probing a
 * program this build will not use spends this machine's time to learn nothing,
 * and leaves `probe` omitted so the report says the CLI was not asked rather
 * than implying it was missing. Every other configuration asks exactly one
 * fixed, local question of it.
 */
export async function readGitHubAdapterSources(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubAdapterSources> {
  const choice = githubTransportChoice(env)
  return choice === 'direct' ? { choice } : { choice, probe: await probeGhAdapter(env) }
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
