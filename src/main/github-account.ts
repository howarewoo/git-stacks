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
  GITHUB_CREDENTIAL_ORIGIN,
  onGitHubFailure,
  resolveGitHubToken,
  setGitHubCredentialSource,
  type GitHubCredential,
  type GitHubCredentialFailure,
  type GitHubCredentialSource,
} from './github-transport'
import type { GitHubAccountState, GitHubAccountStatus, GitHubAppPermission } from '../shared/types'

/** The account signs in to github.com; a GitHub Enterprise host has no registration yet. */
export const GITHUB_ACCOUNT_HOST = 'github.com'

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

export interface GitHubAccountOptions {
  vault: CredentialVault
  /** Application state: the opaque reference and its non-secret facts. */
  stateFile: string
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
  fetch?: typeof globalThis.fetch,
): Promise<string | null> {
  const pinned: GitHubCredentialSource = {
    host: GITHUB_ACCOUNT_HOST,
    available: () => true,
    current: async () => ({ token: accessToken, session, origin: 'account' as const }),
  }
  const transport = new DirectGitHubTransport({
    apiUrl: GITHUB_CREDENTIAL_ORIGIN,
    credential: pinned,
    env: {},
    ...(fetch ? { fetch } : {}),
  })
  const response = await transport.rest<{ login?: unknown }>({ path: 'user' })
  return typeof response.data?.login === 'string' ? response.data.login : null
}

export class GitHubAccount implements GitHubCredentialSource {
  /** The host this credential was issued for; it is never sent anywhere else. */
  readonly host = GITHUB_ACCOUNT_HOST

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
  /**
   * Every change to stored state runs through here, one at a time, so an
   * adoption and a sign-out can never interleave: whichever starts second
   * observes the first one's completed result and nothing stale is renamed
   * over the file.
   */
  private commits: Promise<unknown> = Promise.resolve()

  constructor(options: GitHubAccountOptions) {
    this.options = options
    this.env = options.env ?? process.env
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
    this.state = githubAppClientId(this.env) ? 'signed-out' : 'not-configured'
    this.message =
      this.state === 'not-configured'
        ? 'This build has no GitHub App client id configured, so it cannot sign in.'
        : null
    setGitHubCredentialSource(this)
    onGitHubFailure((error, credential) => this.reportFailure(error, credential))
  }

  private get clientId(): string | null {
    return githubAppClientId(this.env)
  }

  /**
   * Whether a usable credential is held. This is derived from the state itself
   * rather than mirrored into a flag, so restoring, adopting, discarding, and
   * signing out cannot leave it out of step with what is actually usable.
   */
  available(): boolean {
    return this.live !== null && this.options.vault.store().kind === 'system'
  }

  /** Runs stored-state mutations one at a time, in the order they were asked for. */
  private commit<T>(work: () => Promise<T>): Promise<T> {
    const result = this.commits.then(work, work)
    this.commits = result.then(
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
      host: GITHUB_ACCOUNT_HOST,
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
    if (this.state !== state || this.message !== message) {
      this.state = state
      this.message = message
      this.options.onChange?.(this.status())
    }
    return this.status()
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

  /** Reads the sealed credential at startup. Local Git never depends on this. */
  async restore(): Promise<GitHubAccountStatus> {
    const store = this.options.vault.store()
    if (store.kind !== 'system') {
      return this.setState('storage-unavailable', store.reason)
    }
    const account = await readAccount(this.options.stateFile)
    if (!account) return this.setState(this.baseline())
    this.account = account
    try {
      const live = this.parse(await this.options.vault.open(account.reference), account.session)
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
   * and no rollback can need the old one back.
   */
  private adopt(session: GitHubAppSession, fence: () => boolean): Promise<LiveCredential | null> {
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
        GITHUB_ACCOUNT_HOST,
        JSON.stringify(live),
        issuedAt,
      )
      // Nothing has been given up yet, so abandoning the staged credential is
      // enough to leave the store and application state as they were.
      const abandon = async () => {
        await this.options.vault.remove(reference)
        if (previousAccount) await writeAccount(this.options.stateFile, previousAccount)
        else await rm(this.options.stateFile, { force: true })
      }
      if (!fence()) {
        await abandon()
        return null
      }
      const account: StoredAccount = {
        reference,
        host: GITHUB_ACCOUNT_HOST,
        login: previousAccount?.login ?? null,
        createdAt: issuedAt,
        expiresAt: live.expiresAt,
        refreshExpiresAt: live.refreshExpiresAt,
        session: live.session,
      }
      await this.options.beforeStateWrite?.()
      await writeAccount(this.options.stateFile, account)
      if (!fence()) {
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
      // The credential this one replaces is retired only after the replacement
      // is published, so no rollback can ever need it back and a cancel that
      // arrives here has nothing to undo.
      if (previousAccount && previousAccount.reference !== reference) {
        await this.options.vault.remove(previousAccount.reference)
      }
      return live
    })
  }

  private async discard(state: GitHubAccountState, message: string): Promise<void> {
    this.generation += 1
    const reference = this.account?.reference ?? null
    this.forget()
    await this.commit(async () => {
      if (reference) await this.options.vault.remove(reference)
      await rm(this.options.stateFile, { force: true })
    })
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
   * null when sign-in is required; the transport never sees anything else.
   */
  async current(): Promise<GitHubCredential | null> {
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
        fetch: this.options.fetch,
        signal,
      })
      // A sign-out or a replacement that landed meanwhile owns the state now;
      // this response belongs to a session that no longer exists.
      if (this.live === null || this.live.session !== session) return null
      const committed = await this.adopt(refreshed, () => this.live?.session === session)
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
        fetch: this.options.fetch,
        signal: controller.signal,
        intervalSeconds: challenge.interval,
        expiresAt: this.now() + challenge.expiresIn * 1000,
        sleep: this.sleep,
        now: this.now,
      })
      if (controller.signal.aborted) return
      const committed = await this.adopt(session, current)
      if (committed === null) return
      this.pending = null
      this.challenge = null
      // A sign-out may have landed while the credential this replaced was being
      // retired. The token is gone, so it is not spent on an identity lookup.
      if (this.live?.session !== committed.session) return
      const identified = await this.identify(committed.accessToken, committed.session, current)
      if (!current()) return
      this.setState(identified.state, identified.message)
    } catch (error) {
      if (controller.signal.aborted) return
      this.pending = null
      this.challenge = null
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
      )
      if (!current()) return { state: 'signed-in', message: null }
      if (login) {
        await this.commit(async () => {
          if (!current() || !this.account) return
          if (login === this.account.login) return
          this.account = { ...this.account, login }
          await this.options.beforeStateWrite?.()
          await writeAccount(this.options.stateFile, this.account)
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

  /** Removes the credential this application owns. Git repositories are untouched. */
  async signOut(): Promise<GitHubAccountStatus> {
    this.generation += 1
    this.pending?.abort()
    this.pending = null
    this.challenge = null
    // The credential stops being usable at once, so nothing can be handed out
    // from the moment the user asks for it.
    this.forget()
    const epoch = this.epoch
    await this.commit(async () => {
      await this.options.vault.clear()
      await rm(this.options.stateFile, { force: true })
    })
    // Clearing memory again states the invariant rather than repairing it:
    // whatever ran while the queue drained must leave no credential behind. A
    // sign-in the user started after this one is the exception — it is now the
    // account, and it survives.
    if (this.epoch === epoch) this.forget()
    return this.setState(this.baseline())
  }
}
