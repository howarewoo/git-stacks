import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { MAX_BUFFER } from './git-core'
import { isRecord } from '../shared/guards'
import { canonicalHostName } from '../shared/host'
import type { GitHubCliState, GitHubCliStatus } from '../shared/types'
import {
  GitHubTransportError,
  hostScopedEnvironment,
  type GitHubTransport,
} from './github-transport'
import { githubHostContext, hostTransport, type GitHubHostContext } from './github-host'

const execFile = promisify(execFileCallback)

/**
 * The only `gh` command this app runs to describe itself: a local version query
 * that reaches no host, reads no keyring, and asks the CLI who it is signed in
 * as. Which account the CLI holds is read separately, from the CLI's own account
 * answer and one bounded request, because a version on disk proves nothing about
 * who can make a request.
 */
export const GH_VERSION_ARGS = ['--version'] as const

/** One probe may print this much and no more; anything longer is not read. */
const MAX_PROBE_BYTES = 8 * 1024
/** Every CLI answer and authenticated proof this app reads is bounded. */
const READ_TIMEOUT_MS = 8_000

/**
 * How many complete reads one status read may spend before it reports that the
 * host was not established. A credential replaced under every one of them is a
 * CLI being rewritten continuously; no number of children pins that, and the
 * status that follows says so rather than describing a credential that has
 * already been replaced.
 */
const MAX_PROOFS_PER_READ = 3

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

/**
 * Whether the CLI is installed here. Installed is kept apart from usable on
 * purpose: a binary on disk says nothing about who can authenticate, and an
 * installed CLI that would not print a version is a fact about this computer
 * rather than a fact about the host.
 */
export type GitHubCliInstall = 'present' | 'missing' | 'unreadable'

/** What one installed-version probe established about this machine. */
export interface GitHubCliVersionProbe {
  install: GitHubCliInstall
  /** The version the CLI named; null unless it named one this build reads. */
  version: string | null
}

/**
 * One bounded `gh --version`, run the way every other child of this process is:
 * no shell, a byte cap, a deadline, and an environment addressed to no GitHub
 * host, so no credential of any host rides a command that only prints a number.
 *
 * An executable that is not there at all is told apart from one that is there
 * and did not answer, because a machine without the CLI is something a person
 * can fix and the two are not the same problem. Only the distinction is read: the
 * reason, and any path to the binary, are this machine's and stay out of it.
 */
export async function probeGitHubCliVersion(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<GitHubCliVersionProbe> {
  try {
    const { stdout } = await execFile('gh', [...GH_VERSION_ARGS], {
      env: hostScopedEnvironment(env, null),
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_PROBE_BYTES,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    })
    const parsed = parseGhVersion(stdout.trim())
    return {
      install: 'present',
      version: parsed.status === 'confirmed' ? parsed.value : null,
    }
  } catch (error) {
    return { install: missingExecutable(error) ? 'missing' : 'unreadable', version: null }
  }
}

/** Whether a child could not be started because there is no such executable. */
function missingExecutable(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The CLI's own answer about one host, before any request is made.
 *
 * `gh auth status` is asked about the active account for one host and inspected
 * rather than believed by exit code: the command exits zero while reporting an
 * authentication problem, so the answer is the JSON it printed. `--show-token` is
 * never passed and no token field is read however the CLI shapes its output.
 */
interface CliAccountAnswer {
  state: Extract<
    GitHubCliState,
    'authenticated' | 'signed-out' | 'rejected' | 'offline' | 'unavailable'
  >
  login: string | null
}

/**
 * What this app asks the CLI about the accounts it holds.
 *
 * A fixed argument list: a caller names no subcommand and no flag. The host is
 * the only variable, and it is the canonical name this app already resolved.
 */
export function ghAuthStatusArgs(host: string): string[] {
  return ['auth', 'status', '--active', '--hostname', host, '--json', 'hosts']
}

/** A login as the CLI reported it: one printable line, nothing else. */
function sanitizedLogin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const login = value.trim()
  // GitHub's own bound, and the three shapes a real account name has here: the
  // ordinary one, the Enterprise Managed User form that appends the
  // organization's shortcode after an underscore, and the App bot form that
  // appends `[bot]` in brackets. That last one is a real account on github.com —
  // it is what an installation token authenticates as — and rejecting it would
  // refuse a credential the provider itself vends. Anything else is not an
  // account, and is never published, however it reached here.
  if (login.length === 0 || login.length > 39) return null
  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:_[A-Za-z0-9]{3,8})?|\[[A-Za-z0-9-_.]+\]bot)$/u.test(
    login,
  )
    ? login
    : null
}

/**
 * The CLI's answer, read as the CLI writes it: a map of host to the accounts it
 * holds for that host, each with whether it is the active one and what state it
 * is in.
 *
 * A host the CLI holds no account for is signed out — including when the command
 * exits zero with an empty map. An account the CLI does not consider active is
 * not the one its requests would authenticate as, so it is never reported as the
 * signed-in one. An answer this build does not recognise is unavailable rather
 * than a guess, and no token field is read out of it however it is shaped.
 */
function accountAnswer(output: string, host: string): CliAccountAnswer {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return { state: 'unavailable', login: null }
  }
  if (!isRecord(parsed) || !isRecord(parsed.hosts)) return { state: 'unavailable', login: null }
  const wanted = canonicalHostName(host)
  let entries: unknown
  for (const [name, value] of Object.entries(parsed.hosts)) {
    if (canonicalHostName(name) === wanted) entries = value
  }
  // The CLI answered and named no account for this host, whatever its exit code.
  if (entries === undefined) return { state: 'signed-out', login: null }
  if (!Array.isArray(entries)) return { state: 'unavailable', login: null }
  if (entries.length === 0) return { state: 'signed-out', login: null }

  let refused = false
  for (const entry of entries) {
    if (!isRecord(entry)) return { state: 'unavailable', login: null }
    const state = typeof entry.state === 'string' ? entry.state : null
    if (state === null || state === undefined) return { state: 'unavailable', login: null }
    if (state !== 'success' && state !== 'error' && state !== 'timeout') {
      return { state: 'unavailable', login: null }
    }
    // An entry is only about the host that was asked about when it says so: a
    // record naming another host is not this host's session, whatever else it
    // claims.
    if (canonicalHostName(typeof entry.host === 'string' ? entry.host : '') !== wanted) {
      return { state: 'unavailable', login: null }
    }
    if (state === 'timeout') return { state: 'offline', login: null }
    if (state === 'error') {
      refused = true
      continue
    }
    if (entry.active !== true) continue
    const login = sanitizedLogin(entry.login)
    return login === null
      ? { state: 'unavailable', login: null }
      : { state: 'authenticated', login }
  }
  // The CLI holds accounts for this host and every one of them failed, or none of
  // them is active: nothing usable, and the distinction matters to a reader.
  return refused ? { state: 'rejected', login: null } : { state: 'signed-out', login: null }
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
  const stdout = (error as { stdout?: unknown }).stdout
  return typeof stdout === 'string' ? stdout : null
}

/** What a read that was abandoned reports: it established nothing at all. */
const ABANDONED: GitHubCliReadResult = {
  state: 'unavailable',
  login: null,
  version: null,
  authority: null,
}

export interface GitHubCliReadResult {
  state: GitHubCliState
  login: string | null
  version: string | null
  /** The credential identity this read observed; null when it established none. */
  authority: string | null
}

/**
 * What a read proves its credential through: the transport boundary it pins on
 * both sides of the request, and the request's own report of which credential it
 * carried. Named so a caller supplying its own proves the same three things
 * production does, and cannot quietly supply less.
 */
export type GitHubCliProvingTransport = Pick<
  GitHubTransport,
  'credentialAuthority' | 'destinationHost'
> &
  Required<Pick<GitHubTransport, 'graphqlWithAuthority'>>

export interface GitHubCliReadOptions {
  env?: NodeJS.ProcessEnv
  /**
   * The transport that proves the credential; it defaults to this host's own.
   * It is also what re-establishes which credential is current, so a service
   * given one checks the replacement against the same boundary it proved on —
   * and what says which credential the proof request itself carried, which the
   * two pins either side of it cannot say on their own.
   */
  transport?: GitHubCliProvingTransport
  timeoutMs?: number
  /** Abandons this read, and the request that proves it, when it is over. */
  signal?: AbortSignal
}

/**
 * What one read established for a host: whether the CLI is installed here, the
 * account it says is active for this host, and — when it claims one — what an
 * authenticated request made with that credential actually does.
 *
 * Nothing is taken on trust below the CLI's own answer. An account it named is a
 * claim, so one bounded authenticated request either confirms it or reports the
 * refusal, an offline host, or an account that is not authorized for it. An
 * installed version is never read as authentication, an exit code is never read
 * as an account, and a credential this process was given for the host is never
 * read as one either: it authenticates through the same proof.
 */
export async function readGitHubCli(
  context: GitHubHostContext,
  options: GitHubCliReadOptions = {},
): Promise<GitHubCliReadResult> {
  const env = options.env ?? process.env
  const host = canonicalHostName(context.host)
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS
  if (options.signal?.aborted) return ABANDONED
  const install = await probeGitHubCliVersion(env, options.signal)
  // With no CLI on PATH there is no session to read and no request to prove, so
  // the read stops here rather than attempting one.
  if (install.install === 'missing') {
    return { state: 'missing-cli', login: null, version: null, authority: null }
  }
  const version = install.version

  // A read that was abandoned while the version probe ran stops here rather than
  // starting a second child for a host this app has already left.
  if (options.signal?.aborted) return ABANDONED
  // The account these requests will carry belongs to the destination they reach,
  // which is not always the name of the host that was selected: a public host an
  // operator has pointed at a provider of their own is served by that provider's
  // account. Asking the CLI about the selected name instead would report the
  // public host's session — signed out, or signed in as somebody else — for
  // requests this app never makes, and would scope the child to a credential
  // those requests do not carry. The status still belongs to the selected host;
  // only the question put to the CLI follows the destination.
  const transport = options.transport ?? hostTransport(context, env)
  const destination = transport.destinationHost
  let answer: CliAccountAnswer
  try {
    const { stdout } = await execFile('gh', ghAuthStatusArgs(destination), {
      env: hostScopedEnvironment(env, destination),
      timeout: timeoutMs,
      maxBuffer: MAX_PROBE_BYTES,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    answer = accountAnswer(stdout, destination)
  } catch (error) {
    const stdout = commandStdout(error)
    if (options.signal?.aborted) return ABANDONED
    // The exit code settled nothing, so the JSON is the answer. A refusal that
    // printed one is classified like any other; one that printed nothing is a
    // question this build cannot answer.
    answer =
      stdout === null ? { state: 'unavailable', login: null } : accountAnswer(stdout, destination)
  }
  if (options.signal?.aborted) return ABANDONED
  if (answer.state !== 'authenticated') {
    return { state: answer.state, login: null, version, authority: null }
  }

  // The account exists, so one bounded authenticated request establishes who it
  // is, whether the credential is still accepted, and whether the host answers.
  //
  // It asks the way the CLI itself asks: the current user is read as GraphQL's
  // `viewer { login }`, which is what `gh auth status` resolves a login through.
  // That matters because a REST `/user` endpoint is not universal — an
  // installation token authenticates as a bot account without one — so requiring
  // it would refuse credentials the provider vends and the CLI accepts.
  // The credential this answer is fenced on, pinned on both sides of the request.
  // Resolving one can start a child, so each resolution takes the same deadline
  // and cancellation as the request it belongs to.
  const identity = { timeoutMs, ...(options.signal ? { signal: options.signal } : {}) }
  try {
    const pinned = await transport.credentialAuthority(identity).catch(() => null)
    if (pinned === null) {
      return { state: 'unavailable', login: null, version, authority: null }
    }
    // A transport that cannot report which credential its own request carried
    // cannot prove one: the pins either side of it would be the whole of the
    // proof, and a credential replaced and put back between them answers as
    // somebody else's account. That is not established, and says so.
    if (transport.graphqlWithAuthority === undefined) {
      return { state: 'unavailable', login: null, version, authority: null }
    }
    const observed = await transport.graphqlWithAuthority<{ viewer?: { login?: unknown } }>(
      'query UserCurrent { viewer { login } }',
      {},
      identity,
    )
    // A 200 is not an identity. The account published here is the one the
    // authenticated request itself reported, and a request that answered without
    // naming one has established nothing: an unread answer is not a lesser
    // account, it is no account, and the CLI's own claim is not read over it.
    const proven = sanitizedLogin(observed.data?.viewer?.login)
    // The account answered for must still be the account asked, on both sides of
    // the request and by the request itself. The middle leg is the one a
    // credential that changed and changed back would slip past: those two pins
    // would agree with each other while the request between them was
    // authenticated as another account entirely, and that request's answer is
    // the one about to be published.
    const settled = await transport.credentialAuthority(identity).catch(() => null)
    if (
      proven === null ||
      settled === null ||
      settled !== pinned ||
      observed.authority !== pinned
    ) {
      return { state: 'unavailable', login: null, version, authority: null }
    }
    return { state: 'authenticated', login: proven, version, authority: pinned }
  } catch (error) {
    if (options.signal?.aborted) return ABANDONED
    const kind = error instanceof GitHubTransportError ? error.kind : 'unknown'
    // A refusal names the credential that was refused. It says nothing about a
    // credential that has since replaced it, so the authority the failed request
    // carried is what the caller revalidates this answer against.
    const failed =
      error instanceof GitHubTransportError && typeof error.authority === 'string'
        ? error.authority
        : null
    return {
      state:
        kind === 'unauthorized'
          ? 'rejected'
          : kind === 'forbidden'
            ? 'permission-denied'
            : kind === 'network' || kind === 'timeout'
              ? 'offline'
              : 'unavailable',
      login: null,
      version,
      authority: failed,
    }
  }
}

export interface GitHubCliStatusOptions extends GitHubCliReadOptions {
  onChange?: (status: GitHubCliStatus) => void
}

/**
 * The status of the GitHub CLI for one host.
 *
 * Every read is a real read: the installed CLI, the account it says is active,
 * and — when it claims one — one authenticated request that proves it. Nothing
 * here installs a tool, starts a login, switches an account, or ends a session.
 * Concurrent callers share the read already in flight, so a window and a refresh
 * cannot disagree by reading at different moments, and each of those reads makes
 * its own proof: a credential replaced in the CLI is established by the next read
 * rather than answered for from an earlier one.
 */
export class GitHubCliStatusService {
  private readonly host: string
  private readonly options: GitHubCliStatusOptions
  private readonly context: GitHubHostContext
  private status: GitHubCliStatus
  private reading: Promise<GitHubCliStatus> | null = null
  /** The credential the last proof established, and the generation it belongs to. */
  private authority: string | null = null
  private generation = 0
  private retired = false
  /** What abandons the reads and proof requests a retired service still owns. */
  private readonly controller = new AbortController()

  constructor(host: string, options: GitHubCliStatusOptions = {}) {
    const canonical = canonicalHostName(host)
    this.host = canonical
    this.options = options
    this.context = githubHostContext(canonical)
    this.status = {
      state: 'checking',
      host: canonical,
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

  /**
   * Stops this service publishing anything else. A read still in flight answers
   * its caller, but the answer describes a host or a credential this app has
   * already left, so it is never published or recorded as current, and the
   * request that would have proved it is abandoned rather than left running.
   */
  retire(): void {
    this.retired = true
    this.reading = null
    this.controller.abort()
  }

  async read(): Promise<GitHubCliStatus> {
    this.reading ??= this.run().finally(() => {
      this.reading = null
    })
    return this.reading
  }

  /**
   * Whether the credential this read proved is still the one the host resolves.
   * The check is the transport's own credential boundary, which resolves what a
   * request made now would carry without making one, so it is both private and
   * bounded by the read's own deadline.
   *
   * The resolution is cancellable and carries that deadline, so retirement ends
   * it rather than leaving a `gh auth token` child running for a host this app
   * has already left, and a credential replaced while it was in flight cannot be
   * reported as current by an answer that arrives after the replacement.
   */
  private async provesCurrent(authority: string): Promise<boolean> {
    if (this.retired || this.controller.signal.aborted) return false
    const transport =
      this.options.transport ??
      // The same resolution every other request for this host uses, so a proof is
      // made against the destination the app is actually pointed at — including a
      // public host an operator has pointed elsewhere, whose credential is the one
      // those requests carry. Proving github.com while the app talks to another
      // destination would establish an account that answers nothing this app asks.
      hostTransport(this.context, this.options.env ?? process.env)
    try {
      // Asked with no request: this is the transport's own bounded resolution of
      // the credential it would pin a request to now, not a request of its own.
      const current = await transport.credentialAuthority({
        signal: this.controller.signal,
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      })
      // The host can be left while that resolution is in flight, and an answer
      // about a host this service has left is not a current credential.
      if (this.retired || this.controller.signal.aborted) return false
      return current === authority
    } catch {
      // A credential this build cannot resolve now is not evidence that the one
      // it proved is still current, so the answer stays unpublished.
      return false
    }
  }

  private async run(): Promise<GitHubCliStatus> {
    // A credential replaced under this read is read again rather than published,
    // because the replacement is the credential this host holds now. The number
    // of attempts is bounded: a CLI whose credential is being rewritten
    // continuously cannot be established by an unbounded number of children,
    // and an honest "not established" beats a description of a credential that no
    // longer exists. Each attempt is a complete read, so concurrent callers
    // still share one read in flight.
    for (let attempt = 0; attempt < MAX_PROOFS_PER_READ; attempt += 1) {
      const result = await readGitHubCli(this.context, {
        ...this.options,
        signal: this.controller.signal,
      })
      if (this.retired) {
        // The answer describes a host or a credential this service has left, and
        // it is not the one that is current for anything else: it is neither
        // recorded nor published, and a proof for a credential that has since been
        // replaced never revokes the replacement.
        return this.status
      }
      // A credential replaced in the CLI while this read was proving it leaves an
      // answer about a credential that no longer exists — whether that answer is a
      // success or a refusal. The proof is asked once more, privately, which is
      // the same boundary the request was pinned to. An answer whose credential
      // has been replaced under it says nothing about the replacement, so it is
      // discarded rather than published: this read goes back and establishes what
      // the host actually holds now, instead of leaving the replaced credential
      // described, or reporting the replacement as one this read refused.
      if (result.authority !== null && !(await this.provesCurrent(result.authority))) continue
      return this.publish(result)
    }
    // Every attempt found the credential replaced under it. This host holds a
    // credential, but not one any of those attempts could pin a request to, so
    // the credential this service last described is retired here and the status
    // says the host was not established — rather than continuing to answer with
    // an identity that private revalidation has already disproved.
    return this.publishUnsettled()
  }

  /**
   * Records and publishes one read that named the credential it proved, which is
   * the only case in which an identity may be established or kept.
   */
  private publish(result: GitHubCliReadResult): GitHubCliStatus {
    const established = result.state === 'authenticated' && result.authority !== null
    // A credential actually replaced — a different account, a different token
    // behind the same account, a host change — is a new identity, and switching
    // back later is a further replacement rather than a return to the old rows.
    // Nothing that identifies a credential is kept beyond the one just observed.
    if (established && result.authority !== this.authority) {
      this.generation += 1
      this.authority = result.authority
    }
    return this.record({
      state: result.state,
      login: result.login,
      version: result.version,
      identity: established ? `ghcli-${this.generation}` : null,
    })
  }

  /**
   * The status a host gets when no attempt could pin a request to the credential
   * it holds.
   *
   * That settles nothing about the credential this service was last trusted
   * with, so it retires it: an identity that private revalidation has disproved
   * cannot go on fencing rows that were read under it, and saying so is what
   * makes the window drop them. A service that never established an identity has
   * nothing to retire and publishes nothing — a read that established no
   * credential is not an event about the host.
   */
  private publishUnsettled(): GitHubCliStatus {
    if (this.authority === null) return this.status
    this.authority = null
    return this.record({
      state: 'unavailable',
      login: null,
      version: null,
      identity: null,
      message:
        `The GitHub CLI's credential for ${this.host} was replaced while it was being read, ` +
        'so no account was established. Refresh this status to read the credential this computer holds now.',
    })
  }

  /**
   * Publishes one status, and tells the window only when it actually differs: a
   * repeated read of an unchanged credential is not an event.
   */
  private record(observed: {
    state: GitHubCliState
    login: string | null
    version: string | null
    identity: string | null
    message?: string | null
  }): GitHubCliStatus {
    const status: GitHubCliStatus = {
      state: observed.state,
      host: this.host,
      login: observed.login,
      version: observed.version,
      identity: observed.identity,
      message: observed.message ?? guidance(observed.state, this.host),
    }
    const changed =
      status.state !== this.status.state ||
      status.login !== this.status.login ||
      status.version !== this.status.version ||
      status.identity !== this.status.identity ||
      status.message !== this.status.message
    this.status = status
    if (changed && !this.retired) this.options.onChange?.(status)
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

/**
 * Retires the services of hosts that are no longer selected. Each is stopped
 * before the map is emptied, so a read still running for a host that was left
 * cannot publish a status under the one selected now.
 */
export function forgetGitHubCliServices(): void {
  for (const service of services.values()) service.retire()
  services.clear()
}
