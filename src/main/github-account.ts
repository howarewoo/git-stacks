import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CredentialStoreError, type CredentialVault } from './credentials'
import {
  GitHubAppError,
  githubAppClientId,
  refreshUserAccessToken,
  requestDeviceCode,
  waitForDeviceAuthorization,
  type DeviceChallenge,
  type GitHubAppSession,
} from './github-app'
import {
  DirectGitHubTransport,
  GitHubTransportError,
  onGitHubFailure,
  resolveGitHubToken,
  setGitHubCredentialSource,
  type GitHubCredential,
  type GitHubCredentialFailure,
  type GitHubCredentialSource,
} from './github-transport'
import {
  GITHUB_DOTCOM_HOST,
  githubHostContext,
  remoteHostContext,
  type GitHubHostContext,
} from './github-host'
import type { GitHubAccountState, GitHubAccountStatus, GitHubAppPermission } from '../shared/types'

/** The host this build signs in to when nothing else is configured: github.com. */
export const GITHUB_ACCOUNT_HOST = GITHUB_DOTCOM_HOST

/**
 * The fine-grained permissions the registered GitHub App asks for, each tied to
 * the feature that needs it. User access tokens do not use OAuth scopes, so this
 * set belongs to the app registration rather than to a sign-in request. Nothing
 * here writes issues, notifications, projects, or workflows, and nothing here
 * requests administrative organization access.
 */
export const GITHUB_APP_PERMISSIONS: GitHubAppPermission[] = [
  { permission: 'Contents', access: 'read', feature: 'Pull request commits and check rollups' },
  { permission: 'Issues', access: 'read', feature: 'Open pull request discovery' },
  {
    permission: 'Pull requests',
    access: 'write',
    feature: 'Pull request creation and native stacks',
  },
  { permission: 'Checks', access: 'read', feature: 'Pull request check status' },
  { permission: 'Statuses', access: 'read', feature: 'Commit status rollups' },
]

/** GitHub reports an unapproved organization authorization on the failure message. */
const ORGANIZATION_AUTHORIZATION = /saml|sso|protected by organization/iu
/** A credential this far from its stated expiry is renewed rather than treated as revoked. */
const RENEWAL_GRACE_MS = 60_000

const ORGANIZATION_AUTHORIZATION_MESSAGE =
  'This organization requires single sign-on. Authorize the app for the organization, then sign in again.'

interface LiveCredential {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  refreshExpiresAt: number | null
  /**
   * Identifies this credential across every exchange. It is random rather than
   * sequential, so it reveals nothing about ordering, and it is what lets a
   * response be matched to the credential that actually made the request.
   */
  session: string
}

/** Everything application state keeps: an opaque reference and non-secret facts. */
interface StoredAccount {
  reference: string
  host: string
  login: string | null
  createdAt: number
  expiresAt: number | null
  refreshExpiresAt: number | null
  session: string
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function storedAccount(value: unknown): StoredAccount | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.reference !== 'string' || !record.reference) return null
  if (typeof record.host !== 'string' || !record.host) return null
  return {
    reference: record.reference,
    host: record.host,
    login: typeof record.login === 'string' ? record.login : null,
    createdAt: finiteOrNull(record.createdAt) ?? 0,
    expiresAt: finiteOrNull(record.expiresAt),
    refreshExpiresAt: finiteOrNull(record.refreshExpiresAt),
    session: typeof record.session === 'string' && record.session ? record.session : randomUUID(),
  }
}

async function readAccount(file: string): Promise<StoredAccount | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    return storedAccount(JSON.parse(text))
  } catch {
    return null
  }
}

async function writeAccount(file: string, account: StoredAccount): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(account), { mode: 0o600 })
  await rename(temporary, file)
}

/**
 * The files one installation's signed-in account lives in, and who owns them.
 *
 * A host change replaces the account: the retired one is signed out and the
 * next host's account is created while that sign-out is still running. Both
 * reach the same vault and the same state file, so their work is serialized
 * here and each account's claim is compared against the newest one. An account
 * that has been replaced is not merely out of date — it is no longer allowed to
 * write, restore, refresh, or report over the account that replaced it.
 */
interface AccountOwnership {
  /** Every stored-state mutation, from every account that shares these files. */
 commits: Promise<unknown>
  /** The newest claim handed out; every earlier account has been replaced. */
 claim: number
}

const accountOwnerships = new Map<string, AccountOwnership>()

/**
 * Claims the files named by `stateFile` for a new account, retiring whatever
 * account held them. Keyed by the state file because that is what every account
 * in this process shares: one installation has one signed-in account on disk.
 */
function claimAccountOwnership(stateFile: string): { shared: AccountOwnership; claim: number } {
  const shared = accountOwnerships.get(stateFile) ?? { commits: Promise.resolve(), claim: 0 }
  shared.claim += 1
  accountOwnerships.set(stateFile, shared)
  return { shared, claim: shared.claim }
}

export interface GitHubAccountOptions {
  vault: CredentialVault
  /** Application state: the opaque reference and its non-secret facts. */
  stateFile: string
  /**
   * The GitHub host this account signs in to. github.com stays the default, so
   * nothing changes until a host is named; an enterprise host is used with its
   * own GitHub App client id and its own endpoints, or not at all.
   */
  host?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  /**
   * Resolves the login the given credential authenticates as. The default reads
   * it from the origin the credential is bound to; a replacement must not widen
   * that.
   */
  identify?: (accessToken: string, session: string) => Promise<string | null>
  now?: () => number
  /**
   * Awaited just before the state file is renamed. It is a barrier, not a
   * decision point: the commit runs the same way regardless, and a test uses it
   * to land a cancel or a sign-out inside the window a slower disk would
   * otherwise leave to chance.
   */
  beforeStateWrite?: () => Promise<void>
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  onChange?: (status: GitHubAccountStatus) => void
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  // A signal that is already aborted has no event left to listen for, so the
  // wait ends now rather than after the full interval. A caller that slept
  // through a cancellation would go on to make a request for the host that was
  // retired while it slept.
  if (signal?.aborted) return promise
  const timer = setTimeout(resolve, milliseconds)
  signal?.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      resolve()
    },
    { once: true },
  )
  return promise
}

/**
 * The signed-in GitHub account: it runs the device flow, seals the resulting
 * credential in the operating system's store, refreshes and reports expiry,
 * detects a revoked or policy-blocked credential, and answers the renderer with
 * a status that holds an opaque reference and never the credential itself.
 */
/**
 * The login the given application-owned credential authenticates as. The
 * request is pinned to the origin that credential belongs to and is made
 * through the credential path, so neither an endpoint override nor an ambient
 * environment token can redirect it or stand in for it.
 */
async function identifyWithToken(
  accessToken: string,
  session: string,
  fetch: typeof globalThis.fetch | undefined,
  host: GitHubHostContext,
): Promise<string | null> {
  const pinned: GitHubCredentialSource = {
    host: host.host,
    available: () => true,
    current: async () => ({ token: accessToken, session, origin: 'account' as const }),
  }
  const transport = new DirectGitHubTransport({
    apiUrl: host.apiBase,
    host: host.host,
    credential: pinned,
    env: {},
    ...(fetch ? { fetch } : {}),
  })
  const response = await transport.rest<{ login?: unknown }>({ path: 'user' })
  return typeof response.data?.login === 'string' ? response.data.login : null
}

export class GitHubAccount implements GitHubCredentialSource {
  /** The host this credential was issued for; it is never sent anywhere else. */
  readonly hostContext: GitHubHostContext
  readonly host: string

  private readonly options: GitHubAccountOptions
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private account: StoredAccount | null = null
  private live: LiveCredential | null = null
  private challenge: GitHubAccountStatus['challenge'] = null
  private pending: AbortController | null = null
  private refreshing: Promise<string | null> | null = null
  private expiry: NodeJS.Timeout | null = null
  private state: GitHubAccountState = 'signed-out'
  private message: string | null = null
  /**
   * Incremented whenever the stored credential is invalidated. Any operation that
   * started earlier carries the older value and is refused on completion, so a
   * refresh already in flight can never resurrect a sign-out.
   */
  private generation = 0
  /** The last status handed to the renderer, so only real changes are sent. */
  private published: GitHubAccountStatus | null = null
  /**
   * Counts every published credential. A sign-out reads it before it clears the
   * store so it can tell "nothing ran while I was cleaning" from "a sign-in the
   * user started after me is now the account".
   */
  private epoch = 0
  /**
   * Identity of the device sign-in currently in progress. It is separate from
   * the account generation on purpose: starting or cancelling a replacement flow
   * says nothing about the account that stays signed in, and must not disturb
   * the refresh that maintains it.
   */
  private flow = 0
  private refreshController: AbortController | null = null
  /** The files every account in this process shares, and the newest claim on them. */
  private readonly shared: AccountOwnership
  /** This account's claim, retired by the claim of any account created after it. */
  private readonly claim: number

  constructor(options: GitHubAccountOptions) {
    this.options = options
    this.env = options.env ?? process.env
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
    this.hostContext = githubHostContext(options.host ?? GITHUB_DOTCOM_HOST)
    this.host = this.hostContext.host
    const ownership = claimAccountOwnership(options.stateFile)
    this.shared = ownership.shared
    this.claim = ownership.claim
    this.state = githubAppClientId(this.env, this.host) ? 'signed-out' : 'not-configured'
    this.message =
      this.state === 'not-configured'
        ? `This build has no GitHub App client id configured for ${this.host}, so it cannot sign in.`
        : null
    setGitHubCredentialSource(this)
    onGitHubFailure((error, credential) => this.reportFailure(error, credential))
  }

  private get clientId(): string | null {
    return githubAppClientId(this.env, this.host)
  }

  /**
   * Whether a usable credential is held. This is derived from the state itself
   * rather than mirrored into a flag, so restoring, adopting, discarding, and
   * signing out cannot leave it out of step with what is actually usable.
   */
  available(): boolean {
    return this.live !== null && !this.replaced() && this.options.vault.store().kind === 'system'
  }

  /**
   * Whether a newer account for the same files has taken over. A replaced
   * account answers for itself only: it never writes the shared state, hands
   * out a credential, or reports a status, because the account that replaced it
   * is what the person is looking at now.
   */
  private replaced(): boolean {
    return this.shared.claim !== this.claim
  }

  /**
   * Runs stored-state mutations one at a time, in the order they were asked for,
   * across every account that shares these files — not just this one. Two
   * accounts would otherwise interleave on the same vault and state file, and a
   * sign-out queued by the one being replaced could land after the account that
   * replaced it had already signed in.
 */
  private commit<T>(work: () => Promise<T>): Promise<T> {
    const result = this.shared.commits.then(work, work)
    this.shared.commits = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }


  /** The state to return when nothing is in progress and no credential is active. */
  private baseline(): GitHubAccountState {
    if (this.options.vault.store().kind !== 'system') return 'storage-unavailable'
    if (this.live) return 'signed-in'
    if (this.account) return 'expired'
    return this.clientId ? 'signed-out' : 'not-configured'
  }

  status(): GitHubAccountStatus {
    const store = this.options.vault.store()
    return {
      state: this.state,
      reference: this.account?.reference ?? null,
      host: this.host,
      login: this.account?.login ?? null,
      permissions: GITHUB_APP_PERMISSIONS,
      expiresAt: this.account?.expiresAt ?? null,
      refreshExpiresAt: this.account?.refreshExpiresAt ?? null,
      store: {
        available: store.kind === 'system',
        name: store.kind === 'system' ? store.name : null,
        reason: store.kind === 'system' ? null : store.reason,
      },
      signingIn: this.pending !== null,
      challenge: this.challenge,
      message: this.message,
      externalCredential: resolveGitHubToken(this.env) !== null,
    }
  }

  private setState(state: GitHubAccountState, message: string | null = null): GitHubAccountStatus {
    this.state = state
    this.message = message
    return this.publish()
  }

  /**
   * Sends the status to the renderer whenever anything in it has changed. The
   * account state is not the whole of it: a device flow, its one-time code, the
   * login, the reference and the expiries each move on their own, and a panel
   * that only heard about state transitions would keep showing a sign-in that
   * has already finished.
   */
  private publish(): GitHubAccountStatus {
    const status = this.status()
    // A replaced account still answers for itself, but the panel is showing the
    // account that replaced it, so a status that arrives late must not repaint
    // that panel with a host that is no longer selected.
    if (this.replaced()) return status
    if (this.published === null || JSON.stringify(this.published) !== JSON.stringify(status)) {
      this.published = status
      this.options.onChange?.(status)
    }
    return status
  }

  private failureState(error: GitHubAppError): GitHubAccountState {
    if (error.code === 'not_configured') return 'not-configured'
    if (error.code === 'device_flow_disabled' || error.code === 'incorrect_client_credentials') {
      return 'not-configured'
    }
    if (error.code === 'network') return 'offline'
    if (error.code === 'bad_refresh_token') return 'expired'
    if (error.code === 'cancelled' || error.code === 'access_denied') return this.baseline()
    return this.baseline()
  }

  /**
   * Reads the sealed credential at startup. Local Git never depends on this.
   *
   * The read runs in the shared queue and refuses a replaced account, so a
   * restore that was still reading while the host changed cannot adopt — or
   * report — over the account that replaced it.
   */
  async restore(): Promise<GitHubAccountStatus> {
    return this.commit(async () => {
      if (this.replaced()) return this.status()
      const store = this.options.vault.store()
      if (store.kind !== 'system') {
        return this.setState('storage-unavailable', store.reason)
      }
      const account = await readAccount(this.options.stateFile)
      if (this.replaced()) return this.status()
      if (!account) return this.setState(this.baseline())
      // The saved account belongs to the host that issued it. This installation is
      // pointed somewhere else — the setting changed while the app was closed, or
      // a previous sign-out was interrupted — so nothing saved for that host is
      // adopted, and nothing of this host's is either.
      if (account.host !== this.host) {
        this.account = null
        this.live = null
        return this.setState(this.baseline())
      }
      this.account = account
      try {
        // The vault is told which host the secret must belong to, so a stale
        // reference cannot be decrypted and rebound to the host in use.
        const live = this.parse(
          await this.options.vault.open(account.reference, this.host),
          account.session,
        )
        if (this.replaced()) return this.status()
        this.live = live
        this.scheduleExpiry()
        const expired = live.expiresAt !== null && live.expiresAt <= this.now()
        return this.setState(expired ? 'expired' : 'signed-in', null)
      } catch (error) {
        this.live = null
        return this.setState(
          'expired',
          error instanceof CredentialStoreError
            ? error.message
            : 'The saved GitHub sign-in could not be read. Sign in again.',
        )
      }
    })
  }

  private parse(value: string, session: string): LiveCredential {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new CredentialStoreError('unsealed', 'The saved GitHub sign-in could not be read.')
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new CredentialStoreError('unsealed', 'The saved GitHub sign-in could not be read.')
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.accessToken !== 'string' || !record.accessToken) {
      throw new CredentialStoreError('unsealed', 'The saved GitHub sign-in could not be read.')
    }
    return {
      accessToken: record.accessToken,
      refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : null,
      expiresAt: finiteOrNull(record.expiresAt),
      refreshExpiresAt: finiteOrNull(record.refreshExpiresAt),
      session: typeof record.session === 'string' && record.session ? record.session : session,
    }
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiry ?? undefined)
    this.expiry = null
    const at = this.live?.expiresAt
    if (at === null || at === undefined) return
    const timer = setTimeout(
      () => {
        void this.refresh()
      },
      Math.max(0, at - this.now() + 60_000),
    )
    timer.unref?.()
    this.expiry = timer
  }

  /**
   * Replaces the stored credential. The transaction has one linearization point:
   * the publication of the new credential in memory, which is not separated from
   * the last ownership check by an await. Before it, the staged credential is
   * abandoned and the previous account is left exactly as it was — and nothing
   * at all is left when there was no previous account. After it, the previous
   * credential is retired, because from that moment the replacement is the truth
   * and no rollback can need the old one back. `login` is the identity the
   * caller can already vouch for: a rotation passes the login it holds, and a
   * replacement passes nothing rather than inheriting the identity of the
   * account it displaces.
   */
  private adopt(
    session: GitHubAppSession,
    fence: () => boolean,
    login: string | null,
  ): Promise<LiveCredential | null> {
    return this.commit(async () => {
      const previousAccount = this.account
      const issuedAt = this.now()
      const live: LiveCredential = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresIn === null ? null : issuedAt + session.expiresIn * 1000,
        refreshExpiresAt:
          session.refreshTokenExpiresIn === null
            ? null
            : issuedAt + session.refreshTokenExpiresIn * 1000,
        session: randomUUID(),
      }
      const reference = await this.options.vault.stage(
        this.host,
        JSON.stringify(live),
        issuedAt,
      )
      // Nothing has been given up yet, so removing the staged credential and
      // putting back what these files named is enough to leave the store and
      // application state as they were. Whether the state file is rewritten at
      // all is decided before the credential is removed: the account that
      // replaced this one may have written metadata of its own, and restoring
      // over it would delete the successor's account.
      const abandon = async () => {
        const named = (await readAccount(this.options.stateFile))?.reference ?? null
        await this.options.vault.remove(reference)
        if (named !== reference) return
        if (previousAccount) await writeAccount(this.options.stateFile, previousAccount)
        else await rm(this.options.stateFile, { force: true })
      }
      if (!fence() || this.replaced()) {
        await abandon()
        return null
      }
      const account: StoredAccount = {
        reference,
        host: this.host,
        login,
        createdAt: issuedAt,
        expiresAt: live.expiresAt,
        refreshExpiresAt: live.refreshExpiresAt,
        session: live.session,
      }
      await this.options.beforeStateWrite?.()
      try {
        await writeAccount(this.options.stateFile, account)
      } catch (error) {
        // A failed metadata write never transfers ownership of this credential.
        await this.options.vault.remove(reference)
        throw error
      }
      if (!fence() || this.replaced()) {
        // The metadata now names the staged credential; put back what it named
        // before, so the state on disk never points at a removed reference.
        await abandon()
        return null
      }
      // The commit happens here. Nothing awaits between the check above and the
      // publication below, so a sign-out or a cancel either lands entirely
      // before this point — and the fence refuses it, leaving the previous
      // account intact — or entirely after it, when the replacement is already
      // the truth. No stale token can be published behind an invalidation.
      this.live = live
      this.account = account
      this.epoch += 1
      this.scheduleExpiry()
      this.publish()
      // The credential this one replaces is retired only after the replacement
      // is published, so no rollback can ever need it back and a cancel that
      // arrives here has nothing to undo.
      if (previousAccount && previousAccount.reference !== reference) {
        await this.options.vault.remove(previousAccount.reference)
      }
      return live
    })
  }

  /**
   * Removes the identity the shared files hold for this host, and nothing else.
   *
   * A sign-out and a discard are how a host change retires an account, and the
   * account for the next host may be created while one of them is still queued.
   * Clearing the whole vault and deleting the state file would take the
   * successor's credential and metadata with it, so both are done only for the
   * reference these files name for this host — and only while this account is
   * still the one that owns them.
   */
  private async retireStoredIdentity(): Promise<void> {
    const stored = await readAccount(this.options.stateFile)
    // Someone else's account is named here now: its credential and its metadata
    // both belong to the account that replaced this one.
    if (this.replaced() || (stored !== null && stored.host !== this.host)) return
    if (stored) await this.options.vault.remove(stored.reference)
    else await this.options.vault.clear()
    await rm(this.options.stateFile, { force: true })
  }

  private async discard(state: GitHubAccountState, message: string): Promise<void> {
    this.generation += 1
    this.forget()
    this.publish()
    await this.commit(() => this.retireStoredIdentity())
    this.setState(state, message)
  }

  /**
   * Stops the work that maintains the credential and stops trusting it, without
   * touching disk; the caller removes what was stored.
   */
  private forget(): void {
    this.refreshController?.abort()
    this.refreshController = null
    this.refreshing = null
    clearTimeout(this.expiry ?? undefined)
    this.expiry = null
    this.account = null
    this.live = null
  }

  /**
   * The credential the transport uses. It refreshes an expired one and returns
   * null when sign-in is required; the transport never sees anything else. A
   * replaced account hands out nothing: the account that replaced it holds the
   * credential now, and renewing this one would rotate the successor's.
   */
  async current(): Promise<GitHubCredential | null> {
    if (this.replaced()) return null
    const live = this.live
    if (!live) return null
    if (live.expiresAt === null || live.expiresAt > this.now()) {
      if (this.state === 'offline' || this.state === 'expired') this.setState('signed-in')
      return { token: live.accessToken, session: live.session, origin: 'account' }
    }
    const renewed = await this.refresh()
    return renewed === null
      ? null
      : { token: renewed, session: this.live?.session ?? '', origin: 'account' }
  }

  /** One refresh at a time, so concurrent requests cannot rotate the credential twice. */
  private refresh(): Promise<string | null> {
    if (!this.refreshing) {
      const session = this.live?.session ?? ''
      const controller = new AbortController()
      this.refreshController = controller
      this.refreshing = this.renew(session, controller.signal).finally(() => {
        if (this.refreshController === controller) this.refreshController = null
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  /**
   * Renews the session it started from. Ownership is per session, not per
   * account-generation: a device sign-in that is merely started or cancelled
   * must not invalidate a rotation for the account that is still active, while a
   * rotation whose session has since been replaced or signed out is dropped.
   */
  private async renew(session: string, signal: AbortSignal): Promise<string | null> {
    const live = this.live
    if (live === null || live.session !== session) return null
    if (!live?.refreshToken) {
      this.live = null
      this.setState('expired', 'The saved GitHub sign-in has expired. Sign in again.')
      return null
    }
    if (live.refreshExpiresAt !== null && live.refreshExpiresAt <= this.now()) {
      await this.discard('expired', 'The saved GitHub sign-in has expired. Sign in again.')
      return null
    }
    try {
      const refreshed = await refreshUserAccessToken({
        clientId: this.clientId ?? '',
        refreshToken: live.refreshToken,
        host: this.host,
        fetch: this.options.fetch,
        signal,
      })
      // A sign-out or a replacement that landed meanwhile owns the state now;
      // this response belongs to a session that no longer exists.
      if (this.live === null || this.live.session !== session) return null
      // A rotation is the same user on a new token, so the login it already
      // established is kept; a replacement has to be identified afresh.
      const committed = await this.adopt(
        refreshed,
        () => this.live?.session === session,
        this.account?.login ?? null,
      )
      if (committed === null) return null
      // The commit is published, but a sign-out or a discard may have landed
      // while the credential it replaced was being retired. The token is then
      // already gone and this renewal has nothing left to hand back, so the
      // account's own state is left to whoever invalidated it.
      if (this.live?.session !== committed.session) return null
      this.setState('signed-in')
      return committed.accessToken
    } catch (error) {
      if (this.live === null || this.live.session !== session) return null
      if (error instanceof GitHubAppError) {
        if (error.code === 'network' || error.code === 'cancelled') {
          this.setState('offline', error.message)
          return null
        }
        await this.discard(this.failureState(error), error.message)
        return null
      }
      this.setState('expired', 'The saved GitHub sign-in could not be renewed. Sign in again.')
      return null
    }
  }
  /**
   * A rejection GitHub sends for a credential that should still be valid is a
   * revocation; one that arrives at or past the stated expiry is renewed instead.
   */
  private async reportFailure(
    error: GitHubTransportError,
    credential: GitHubCredentialFailure,
  ): Promise<void> {
    // A response for a credential this account no longer holds says nothing
    // about the one that replaced it, whatever its state.
    if (this.live === null || credential.session !== this.live.session) return
    if (error.kind === 'forbidden') {
      if (ORGANIZATION_AUTHORIZATION.test(error.detail)) {
        this.setState('permission-denied', ORGANIZATION_AUTHORIZATION_MESSAGE)
      }
      return
    }
    const live = this.live
    const renewable = live.expiresAt !== null && live.expiresAt - this.now() <= RENEWAL_GRACE_MS
    if (!renewable) {
      await this.discard('revoked', 'GitHub rejected the saved sign-in. Sign in again.')
      return
    }
    await this.refresh()
  }

  /** Starts device sign-in and polls in the background, so no read queues behind it. */
  async signIn(): Promise<GitHubAccountStatus> {
    const clientId = this.clientId
    if (!clientId) {
      return this.setState(
        'not-configured',
        'This build has no GitHub App client id configured, so it cannot sign in.',
      )
    }
    const store = this.options.vault.store()
    if (store.kind !== 'system') return this.setState('storage-unavailable', store.reason)
    // Starting a replacement leaves the account that is already signed in alone:
    // only the device flow in progress is superseded.
    this.flow += 1
    const flow = this.flow
    const generationAtStart = this.generation
    this.pending?.abort()
    const controller = new AbortController()
    this.pending = controller
    this.setState(this.baseline() === 'signed-in' ? 'signed-in' : 'signing-in')
    let challenge: DeviceChallenge
    try {
      challenge = await requestDeviceCode({
        clientId,
        host: this.host,
        fetch: this.options.fetch,
        signal: controller.signal,
      })
    } catch (error) {
      if (flow !== this.flow) return this.status()
      this.pending = null
      return this.setState(
        this.failureState(error as GitHubAppError),
        error instanceof GitHubAppError ? error.message : 'Sign-in could not be started.',
      )
    }
    // A successful answer can still arrive after this flow was cancelled,
    // superseded, or signed out: an abort stops the request being made, not a
    // response that is already settling. Publishing that code would overwrite
    // the newer flow's challenge while `pending` still points at the newer
    // controller, leaving the code on screen and the Cancel control describing
    // two different sign-ins. The flow number catches a replacement or a
    // cancel, the generation catches a sign-out or a discard, and the aborted
    // signal is the backstop for either.
    if (controller.signal.aborted || flow !== this.flow || this.generation !== generationAtStart) {
      return this.status()
    }
    this.challenge = {
      userCode: challenge.userCode,
      verificationUri: challenge.verificationUri,
      expiresAt: this.now() + challenge.expiresIn * 1000,
    }
    // A replacement does not unsettle the account that is already signed in. The
    // flow in progress is reported by `signingIn`; the state only says
    // "signing in" when there is no account for the panel to describe.
    this.setState(this.baseline() === 'signed-in' ? 'signed-in' : 'signing-in')
    void this.poll(challenge, controller, flow, generationAtStart)
    return this.status()
  }

  private async poll(
    challenge: DeviceChallenge,
    controller: AbortController,
    flow: number,
    generationAtStart: number,
  ): Promise<void> {
    // A replacement is committed only while it is still the sign-in in progress
    // and the account has not been signed out or discarded underneath it.
    const current = () => flow === this.flow && this.generation === generationAtStart
    try {
      const session = await waitForDeviceAuthorization({
        clientId: this.clientId ?? '',
        deviceCode: challenge.deviceCode,
        host: this.host,
        fetch: this.options.fetch,
        signal: controller.signal,
        intervalSeconds: challenge.interval,
        expiresAt: this.now() + challenge.expiresIn * 1000,
        sleep: this.sleep,
        now: this.now,
      })
      if (controller.signal.aborted) return
      // The identity that comes with this token belongs to the credential that
      // was committed, not to the device flow that may since have been
      // abandoned: a cancel after the commit says nothing about who this token
      // is, while a later replacement or a sign-out still ends it.
      const committed = await this.adopt(session, current, null)
      if (committed === null) return
      // A newer sign-in owns the flow fields now, so this poll must not end
      // somebody else's code.
      if (this.pending === controller) {
        this.pending = null
        this.challenge = null
        this.publish()
      }
      if (this.live?.session !== committed.session) return
      const owned = () => this.live?.session === committed.session
      const identified = await this.identify(committed.accessToken, committed.session, owned)
      if (!owned()) return
      this.setState(identified.state, identified.message)
    } catch (error) {
      if (controller.signal.aborted) return
      if (this.pending === controller) {
        this.pending = null
        this.challenge = null
      }
      const code = error instanceof GitHubAppError ? error : null
      this.setState(
        code ? this.failureState(code) : this.baseline(),
        code ? code.message : 'Sign-in could not be completed.',
      )
    }
  }

  /**
   * Reads the signed-in account's login before the state settles, so one pushed
   * status carries the login and any policy block together. The request is bound
   * to the credential just adopted: an environment token or a `gh` session for
   * another user must never supply this account's identity.
   */
  private async identify(
    accessToken: string,
    session: string,
    current: () => boolean,
  ): Promise<{ state: GitHubAccountState; message: string | null }> {
    try {
      const login = await (this.options.identify ?? identifyWithToken)(
        accessToken,
        session,
        this.options.fetch,
        this.hostContext,
      )
      if (!current()) return { state: 'signed-in', message: null }
      if (login) {
        await this.commit(async () => {
          if (!current() || this.replaced() || !this.account) return
          if (login === this.account.login) return
          this.account = { ...this.account, login }
          await this.options.beforeStateWrite?.()
          await writeAccount(this.options.stateFile, this.account)
          // The panel names the account it is showing, so the login it now
          // carries is published even if the caller settles the state later.
          this.publish()
        })
      }
      return { state: 'signed-in', message: null }
    } catch (error) {
      if (error instanceof GitHubTransportError && error.kind === 'forbidden') {
        return { state: 'permission-denied', message: ORGANIZATION_AUTHORIZATION_MESSAGE }
      }
      return { state: 'signed-in', message: null }
    }
  }

  async cancelSignIn(): Promise<GitHubAccountStatus> {
    const wasPending = this.pending !== null
    // Cancelling abandons the device flow only. The account that is already
    // signed in keeps its credential and its ability to renew it; an adoption
    // that has not yet been published rolls itself back, and does so without
    // giving up what was stored before it started.
    this.flow += 1
    this.pending?.abort()
    this.pending = null
    this.challenge = null
    if (!wasPending) return this.status()
    return this.setState(this.baseline())
  }

  /**
   * Removes the credential this application owns. Git repositories are untouched.
   *
   * A host change reaches this while the next host's account is already being
   * created, so the removal is the one the shared files hold for this host: the
   * successor's credential and its metadata are never what a retired account
   * deletes, whichever order the two land in.
   */
  async signOut(): Promise<GitHubAccountStatus> {
    this.generation += 1
    this.pending?.abort()
    this.pending = null
    this.challenge = null
    // The credential stops being usable at once, so nothing can be handed out
    // from the moment the user asks for it.
    this.forget()
    this.publish()
    const epoch = this.epoch
    await this.commit(() => this.retireStoredIdentity())
    // Clearing memory again states the invariant rather than repairing it:
    // whatever ran while the queue drained must leave no credential behind. A
    // sign-in the user started after this one is the exception — it is now the
    // account, and it survives.
    if (this.epoch === epoch) this.forget()
    return this.setState(this.baseline())
  }
}
