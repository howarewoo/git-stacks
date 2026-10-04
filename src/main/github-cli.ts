import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { MAX_BUFFER } from './git-core'
import { isRecord } from '../shared/guards'
import { canonicalHostName } from '../shared/host'
import type { GitHubCliState, GitHubCliStatus } from '../shared/types'
import {
  GitHubTransportError,
  githubTransportForHost,
  hostScopedEnvironment,
  resolveGitHubToken,
  type GitHubTransport,
} from './github-transport'
import { githubHostContext, type GitHubHostContext } from './github-host'

const execFile = promisify(execFileCallback)

/**
 * The only `gh` command this app runs to describe itself: a local version query
 * that reaches no host, reads no keyring, and asks the CLI who it is signed in
 * as. The authenticated account is read separately, from the CLI's own account
 * answer and one bounded request, because a version on disk proves nothing about
 * who can make a request.
 */
export const GH_VERSION_ARGS = ['--version'] as const

/** One probe may print this much and no more; anything longer is not read. */
const MAX_PROBE_BYTES = 8 * 1024
/** Every CLI answer and authenticated proof this app reads is bounded. */
const READ_TIMEOUT_MS = 8_000
/**
 * How long an authenticated proof stays usable. It is one real request per
 * window, and a credential replaced in the CLI is established by the next window
 * rather than by nothing at all.
 */
const PROOF_TTL_MS = 10_000

/**
 * Safe projection of GitHub CLI version output. Strictly the semantic version
 * the CLI named, so a build date, a commit, an install path, or anything else
 * the binary chose to print cannot reach a status, a diagnostic report, or a
 * support bundle. Output this does not recognise is reported as unrecognised
 * rather than partially believed.
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

/** Whether the installed CLI answered a version query on this machine. */
export interface GitHubCliVersionProbe {
  /**
   * Whether `gh --version` ran and answered. `false` covers both an absent CLI
   * and one that could not be started, because this module cannot tell those
   * apart without reading an error it deliberately never reports.
   */
  ran: boolean
  /** The version the CLI named, or null when it named none this build reads. */
  version: string | null
}

/**
 * One bounded `gh --version`, run the way every other child of this process is:
 * no shell, a byte cap, a deadline, and an environment addressed to no GitHub
 * host, so no credential of any host rides a command that only prints a number.
 */
export async function probeGitHubCliVersion(env: NodeJS.ProcessEnv): Promise<GitHubCliVersionProbe> {
  try {
    const { stdout } = await execFile('gh', [...GH_VERSION_ARGS], {
      env: hostScopedEnvironment(env, null),
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_PROBE_BYTES,
      windowsHide: true,
    })
    const parsed = parseGhVersion(stdout.trim())
    return { ran: true, version: parsed.status === 'confirmed' ? parsed.value : null }
  } catch {
    // The reason is the CLI's to word and a path to its binary is this
    // machine's, so neither is read: the report says the query did not answer
    // and nothing about why.
    return { ran: false, version: null }
  }
}

/**
 * The CLI's own answer about one host, before any request is made.
 *
 * `gh auth status` is asked for JSON and inspected rather than believed by exit
 * code: it exits zero while reporting an authentication problem, and exits
 * nonzero when nobody is signed in at all. `--show-token` is never passed, and no
 * token field is read however the CLI chooses to shape its output.
 */
interface CliAccountAnswer {
  state: 'authenticated' | 'signed-out' | 'unavailable'
  login: string | null
}

/** The host entry the CLI reports, or null when it named none for this host. */
function accountAnswer(output: string, host: string): CliAccountAnswer | null {
  const parsed: unknown = JSON.parse(output)
  if (!isRecord(parsed) || !isRecord(parsed.hosts)) return null
  const wanted = canonicalHostName(host)
  for (const [name, entry] of Object.entries(parsed.hosts)) {
    if (canonicalHostName(name) !== wanted || !isRecord(entry)) continue
    // An entry the CLI does not consider active is not the account its requests
    // will authenticate as, so it is never reported as the signed-in one.
    if (entry.active === false) return { state: 'signed-out', login: null }
    const user = typeof entry.user === 'string' ? entry.user.trim() : ''
    return user === ''
      ? { state: 'signed-out', login: null }
      : { state: 'authenticated', login: user }
  }
  return null
}

/** Why the status is what it is, in this build's own words and never the CLI's. */
function guidance(state: GitHubCliState, host: string): string | null {
  switch (state) {
    case 'missing-cli':
      return `The GitHub CLI (gh) is not installed on this computer, so ${host} collaboration is unavailable. Install gh, then refresh this status. Local Git keeps working either way.`
    case 'signed-out':
      return `The GitHub CLI has no active account for ${host}. Sign in from a terminal with: gh auth login --hostname ${host} — then refresh this status. Accounts, sessions, and sign-out belong to the GitHub CLI; Git Stacks cannot start, switch, or end one.`
    case 'rejected':
      return `The GitHub CLI's credential for ${host} was refused. Re-authenticate it from a terminal with: gh auth login --hostname ${host} — then refresh this status. Git Stacks does not replace or revoke it.`
    case 'permission-denied':
      return `The account the GitHub CLI uses is not authorized for ${host}. Grant that account access, including organization SSO authorization, from a terminal, then refresh this status.`
    case 'offline':
      return `${host} did not answer. Local Git and the GitHub CLI's stored session are untouched; refresh this status when the host is reachable.`
    case 'unavailable':
      return `The GitHub CLI could not be read on this computer, so ${host} authentication could not be established. Repair or reinstall gh, then refresh this status.`
    case 'checking':
    case 'authenticated':
      return null
  }
}

/** The child's own stdout, which is classified and never copied anywhere. */
function commandStdout(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('stdout' in error)) return null
  const stdout = error.stdout
  return typeof stdout === 'string' ? stdout : null
}

export interface GitHubCliReadResult {
  state: GitHubCliState
  login: string | null
  version: string | null
  /** The credential identity this read observed; null when it established none. */
  authority: string | null
}

export interface GitHubCliReadOptions {
  env?: NodeJS.ProcessEnv
  /** The transport that proves the credential; it defaults to this host's own. */
  transport?: Pick<GitHubTransport, 'rest'>
  timeoutMs?: number
  /**
   * An authenticated proof already established for this host and account. It is
   * offered in place of a second request inside the proof window; the version and
   * the CLI's own account answer are read every time regardless.
   */
  recentProof?: { key: string; result: GitHubCliReadResult } | null
}

/**
 * What one read established for a host: the installed CLI, the account it holds,
 * and — when it holds one — what an authenticated request made with that
 * credential actually does. A version on disk is never read as authentication,
 * and an exit code is never read as an account.
 */
export async function readGitHubCli(
  context: GitHubHostContext,
  options: GitHubCliReadOptions = {},
): Promise<GitHubCliReadResult> {
  const env = options.env ?? process.env
  const host = context.host
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS
  const version = (await probeGitHubCliVersion(env)).version
  // With no CLI on PATH there is no session to read and no request to prove, so
  // the read stops here rather than attempting one.
  if (version === null) return { state: 'missing-cli', login: null, version: null, authority: null }

  let answer: CliAccountAnswer
  try {
    const { stdout } = await execFile('gh', ['auth', 'status', '--hostname', host, '--json'], {
      env: hostScopedEnvironment(env, host),
      timeout: timeoutMs,
      maxBuffer: MAX_PROBE_BYTES,
      windowsHide: true,
    })
    // The exit code settled nothing, so the JSON is the answer, and a shape this
    // build does not read is "unavailable" rather than a guess.
    answer = accountAnswer(stdout, host) ?? { state: 'unavailable', login: null }
  } catch (error) {
    const stdout = commandStdout(error)
    answer =
      stdout === null
        ? { state: 'unavailable', login: null }
        : (accountAnswer(stdout, host) ?? { state: 'signed-out', login: null })
  }
  // A credential this process was given for the host authenticates the CLI's
  // requests even when the CLI holds no stored session to report, so an empty
  // answer is not an absent credential in that case.
  if (answer.state === 'signed-out' && resolveGitHubToken(env, host) !== null) {
    return { state: 'authenticated', login: null, version, authority: null }
  }
  if (answer.state !== 'authenticated') {
    return { state: answer.state, login: null, version, authority: null }
  }

  const key = `${host}\u0000${answer.login}`
  const reusable = options.recentProof
  if (reusable !== null && reusable !== undefined && reusable.key === key) {
    return { ...reusable.result, version }
  }

  // The account exists, so one bounded authenticated request establishes who it
  // is, whether the credential is still accepted, and whether the host answers.
  const transport =
    options.transport ?? githubTransportForHost(host, context.apiBase, env, context.graphqlUrl)
  try {
    const response = await transport.rest<{ login?: unknown }>({ path: 'user', timeoutMs })
    const proven = typeof response.data?.login === 'string' ? response.data.login : null
    return {
      state: 'authenticated',
      login: proven ?? answer.login,
      version,
      authority: response.authority ?? null,
    }
  } catch (error) {
    const kind = error instanceof GitHubTransportError ? error.kind : 'unknown'
    return {
      state:
        kind === 'unauthorized'
          ? 'rejected'
          : kind === 'forbidden'
            ? 'permission-denied'
            : kind === 'network' || kind === 'timeout'
              ? 'offline'
              : kind === 'not-configured'
                ? 'missing-cli'
                : 'unavailable',
      login: null,
      version,
      authority: null,
    }
  }
}

/**
 * Opaque identities, one per credential actually established. The key names the
 * host, the account, and the credential's own digest; the value is a counter, so
 * nothing that identifies a credential is ever handed out. An equivalent refresh
 * finds the same key, and therefore the same identity.
 */
const identities = new Map<string, string>()
let identityGeneration = 0

function identityFor(host: string, login: string | null, authority: string): string {
  const key = `${host}\u0000${login ?? ''}\u0000${authority}`
  const existing = identities.get(key)
  if (existing) return existing
  identityGeneration += 1
  const identity = `ghcli-${identityGeneration}`
  identities.set(key, identity)
  return identity
}

export interface GitHubCliStatusOptions extends GitHubCliReadOptions {
  onChange?: (status: GitHubCliStatus) => void
  now?: () => number
}

/**
 * The status of the GitHub CLI for one host.
 *
 * Every read is a real read: the installed version, the CLI's own account answer
 * for this host, and — when an account exists — one authenticated request that
 * proves it. Nothing here installs a tool, starts a login, switches an account,
 * or ends a session. Concurrent callers share the read already in flight, so a
 * window and a refresh cannot disagree by reading at different moments.
 */
export class GitHubCliStatusService {
  private readonly context: GitHubHostContext
  private readonly options: GitHubCliStatusOptions
  private status: GitHubCliStatus
  private reading: Promise<GitHubCliStatus> | null = null
  private proof: { key: string; at: number; result: GitHubCliReadResult } | null = null

  constructor(host: string, options: GitHubCliStatusOptions = {}) {
    this.context = githubHostContext(host)
    this.options = options
    this.status = {
      state: 'checking',
      host: this.context.host,
      login: null,
      version: null,
      identity: null,
      message: 'Checking the GitHub CLI on this computer.',
    }
  }

  /** The last status this service established; `checking` before the first read. */
  current(): GitHubCliStatus {
    return this.status
  }

  async read(): Promise<GitHubCliStatus> {
    this.reading ??= this.run().finally(() => {
      this.reading = null
    })
    return this.reading
  }

  private async run(): Promise<GitHubCliStatus> {
    const now = (this.options.now ?? Date.now)()
    const previous = this.proof
    const reusable =
      previous !== null && now - previous.at < PROOF_TTL_MS ? previous : null
    const result = await readGitHubCli(this.context, {
      ...this.options,
      recentProof: reusable,
    })
    this.proof =
      result.state === 'authenticated' && result.authority !== null
        ? { key: `${this.context.host}\u0000${result.login ?? ''}`, at: now, result }
        : null
    const established = result.state === 'authenticated' && result.authority !== null
    const status: GitHubCliStatus = {
      state: result.state,
      host: this.context.host,
      login: result.login,
      version: result.version,
      // An identity is a credential this app actually established. A read that
      // established none — signed out, offline, unreadable — leaves the last one
      // alone rather than inventing a replacement for it.
      identity: established
        ? identityFor(this.context.host, result.login, result.authority ?? '')
        : result.state === 'signed-out'
          ? null
          : this.status.identity,
      message: guidance(result.state, this.context.host),
    }
    const changed =
      status.state !== this.status.state ||
      status.login !== this.status.login ||
      status.version !== this.status.version ||
      status.identity !== this.status.identity ||
      status.message !== this.status.message
    this.status = status
    if (changed) this.options.onChange?.(status)
    return status
  }
}

const services = new Map<string, GitHubCliStatusService>()

/**
 * The status service for one host, so a refresh and a window that asks at the
 * same moment read the CLI once and are answered the same way.
 */
export function gitHubCliStatusService(
  host: string,
  options: GitHubCliStatusOptions = {},
): GitHubCliStatusService {
  const key = canonicalHostName(host)
  const existing = services.get(key)
  if (existing) return existing
  const created = new GitHubCliStatusService(key, options)
  services.set(key, created)
  return created
}

/** Retires the services of hosts that are no longer selected. */
export function forgetGitHubCliServices(): void {
  services.clear()
}