import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isRecord } from '../shared/guards'
import { CredentialStoreError, type CredentialVault } from './credentials'
import type { CachedGitHubResponse, GitHubResponseCache } from './github-response-cache'
import {
  DirectGitHubTransport,
  GitHubTransportError,
  type GitHubRestRequest,
} from './github-transport'
import { githubHostContext, type GitHubHostContext } from './github-host'
import type {
  NotificationInbox,
  NotificationModuleState,
  NotificationModuleStatus,
  NotificationPoll,
  NotificationReason,
  NotificationStaleReason,
  NotificationSubjectKind,
  NotificationThread,
} from '../shared/notifications'

/**
 * The optional GitHub Notifications Center.
 *
 * This module is deliberately separate from everything the GitHub App sign-in
 * reaches. It owns its own sealed credential, its own transport pinned to one
 * host, and its own conditional cache, so nothing here can revoke the App
 * session, change the transport the rest of the app uses, or serve one host's
 * or one account's notification data to another.
 */

/** GitHub's own floor for this endpoint, honoured whatever a header asks for. */
export const MIN_POLL_SECONDS = 60
/**
 * The ceiling on this build's own failure backoff, not on what GitHub asks for.
 * A server that names a longer interval is waited out in full: shortening it
 * would poll a host sooner than it permitted, which is the one thing the
 * `X-Poll-Interval` header is for.
 */
export const MAX_BACKOFF_SECONDS = 3600
/** A page walk that never ends is a refusal, not a longer list. */
const MAX_PAGES = 20
/** GitHub's own documented cap on a single notification page. */
const PAGE_SIZE = 50
/** The longest a single timer may wait before it has to be re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1

const CACHE_VERSION = 1
const CREDENTIAL_FILE_VERSION = 1

const CREDENTIAL_MISSING =
  'Store a GitHub notification token to read this inbox. Sign-in, pull requests, and reviews are unaffected.'
const DISABLED_MESSAGE =
  'GitHub Notifications is off. It is optional and uses its own credential; nothing else in this app changes when it is off.'
const POLICY_MESSAGE =
  'GitHub Notifications is disabled by the settings policy on this computer. Pull requests, stacks, and reviews keep working.'
const WRONG_HOST_MESSAGE =
  'The stored notification token belongs to a different GitHub host and was not opened.'
const REJECTED_MESSAGE =
  'GitHub rejected the stored notification token. Replace it to read this inbox; nothing else in this app changed.'

/** GitHub's notification reasons, as this build names them. */
const REASON_BY_NAME: Record<string, NotificationReason> = {
  assign: 'assign',
  author: 'author',
  comment: 'comment',
  ci_activity: 'ci_activity',
  invitation: 'invitation',
  manual: 'manual',
  mention: 'mention',
  review_requested: 'review_requested',
  security_alert: 'security_alert',
  state_change: 'state_change',
  subscribed: 'subscribed',
  team_mention: 'team_mention',
}

/** The subject types GitHub sends, as this build names them. */
const SUBJECT_BY_TYPE: Record<string, NotificationSubjectKind> = {
  Issue: 'issue',
  PullRequest: 'pull_request',
  Release: 'release',
  Discussion: 'discussion',
  Commit: 'commit',
  RepositoryInvitation: 'repository_invitation',
  SecurityAlert: 'security_alert',
  WorkflowRun: 'workflow',
}

/** One stored notification credential: an opaque reference and non-secret facts. */
interface StoredNotificationCredential {
  reference: string
  host: string
  login: string | null
  createdAt: string
}

/** What the last read of the inbox left behind. */
interface PollMemory {
  fetchedAt: string | null
  checkedAt: string | null
  /**
   * When GitHub last answered, as a timestamp. A 304 moves it forward like any
   * other answer: the list was confirmed, and a confirmation is what expires.
   */
  lastAnsweredAt: number | null
  /** The earliest time the next automatic read may run. */
  nextPollAt: number | null
  pollIntervalSeconds: number
  /** GitHub's exact `Last-Modified` validator for this list, or null before the first read. */
  lastModified: string | null
  /** True when the last answer was a 304. */
  unchanged: boolean
  consecutiveFailures: number
  lastFailure: GitHubTransportError | null
}

/** The poll memory of an inbox nothing has been read from yet. */
function emptyPollMemory(): PollMemory {
  return {
    fetchedAt: null,
    checkedAt: null,
    lastAnsweredAt: null,
    nextPollAt: null,
    pollIntervalSeconds: MIN_POLL_SECONDS,
    lastModified: null,
    unchanged: false,
    consecutiveFailures: 0,
    lastFailure: null,
  }
}

/** The persisted list, so a restart can still make a conditional read. */
interface StoredCache {
  version: number
  host: string
  login: string | null
  lastModified: string | null
  fetchedAt: string | null
  pollIntervalSeconds: number
  threads: NotificationThread[]
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function timestamp(value: unknown): string | null {
  const raw = text(value)
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null
}

/**
 * The poll interval GitHub asked for, taken exactly as it asked and never
 * shortened. A header that is absent, unparseable, or below GitHub's own floor
 * buys the floor; a header longer than any local ceiling is honoured in full,
 * because waiting less than the host asked for is the failure this rule exists
 * to prevent.
 */
export function pollIntervalSeconds(header: string | null): number {
  const asked = Number(header)
  if (header === null || !Number.isFinite(asked)) return MIN_POLL_SECONDS
  return Math.max(MIN_POLL_SECONDS, Math.floor(asked))
}

/**
 * When the next automatic read may run. Every consecutive failure doubles the
 * wait from the server's own interval, up to a fixed ceiling, so an outage backs
 * off rather than hammering a host that is unwell. The interval itself is never
 * shortened: a host that asked to be left alone is left alone.
 */
export function nextPollAt(from: number, intervalSeconds: number, failures: number): number {
  const backoff = Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * 2 ** Math.max(0, failures - 1))
  return from + Math.max(intervalSeconds, backoff) * 1000
}

/**
 * The conditional store for the notification list.
 *
 * It keeps the `Last-Modified` validator and nothing else: the notifications
 * endpoints are documented around `If-Modified-Since`, and an `ETag` sent
 * alongside it can answer 304 for a validator the list was never read with.
 * The transport records the page it read; the module then replaces it with the
 * whole list it assembled, so a 304 replays the complete inbox rather than page
 * one of it. A walk that stops part way discards the validator instead, so no
 * 304 can ever replay a page beside a list it did not come from.
 */
class NotificationValidatorCache implements GitHubResponseCache {
  private entry: CachedGitHubResponse | null = null

  get(_key: string): CachedGitHubResponse | null {
    return this.entry
  }

  set(_key: string, incoming: CachedGitHubResponse): void {
    this.entry = {
      etag: null,
      lastModified: incoming.lastModified,
      body: this.entry?.body ?? null,
      storedAt: incoming.storedAt,
    }
  }

  delete(_key: string): void {
    this.entry = null
  }

  clear(): void {
    this.entry = null
  }

  size(): number {
    return this.entry === null ? 0 : 1
  }

  /** The complete list a 304 replays, which is never a single page of it. */
  replay(): NotificationThread[] {
    const body = this.entry?.body
    return Array.isArray(body) ? (body as NotificationThread[]) : []
  }

  /**
   * Throws the validator away. A walk that did not finish leaves a validator
   * for page one beside a list that is not page one, and the next 304 would
   * replay that mismatch as though GitHub had confirmed it.
   */
  discard(): void {
    this.entry = null
  }

  /**
   * Stores the validator and the whole list together, so the next conditional
   * read is answered with both or with neither.
   */
  remember(lastModified: string | null, threads: NotificationThread[]): void {
    if (!lastModified) {
      this.entry = null
      return
    }
    this.entry = {
      etag: null,
      lastModified,
      body: threads as unknown as CachedGitHubResponse['body'],
      storedAt: new Date(),
    }
  }
}

/**
 * One notification thread from GitHub's list.
 *
 * An entry naming no id is not a thread: every supported write addresses one by
 * that id, so a row built without one could be read but never acted on. It is
 * dropped rather than rendered as a control that does nothing.
 */
function notificationThread(value: unknown): NotificationThread | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  if (!id) return null
  const subject = isRecord(value.subject) ? value.subject : {}
  const repository = isRecord(value.repository) ? value.repository : null
  const owner = repository && isRecord(repository.owner) ? text(repository.owner.login) : null
  const name = repository ? text(repository.name) : null
  const reason = text(value.reason)
  const type = text(subject.type)
  return {
    id,
    unread: value.unread === true,
    // GitHub's own vocabulary, and only its own: a name this build does not
    // know reads as "other" rather than borrowing an inherited key.
    reason:
      reason !== null && Object.hasOwn(REASON_BY_NAME, reason) ? REASON_BY_NAME[reason] : 'unknown',
    title: text(subject.title) ?? 'Untitled notification',
    url: text(subject.url),
    kind: type !== null && Object.hasOwn(SUBJECT_BY_TYPE, type) ? SUBJECT_BY_TYPE[type] : 'unknown',
    repository: owner && name ? { owner, name } : null,
    updatedAt: timestamp(value.updated_at) ?? new Date(0).toISOString(),
  }
}

/** The `rel="next"` page GitHub linked, when it linked one. */
function nextPageLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/u.exec(part.trim())
    if (match && match[2] === 'next') return match[1]
  }
  return null
}

/** A temporary name no concurrent write to the same file can choose. */
function temporaryPathFor(file: string): string {
  return `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
}
/** The first page of the list, which is also the conditional one. */
function firstPageRequest(signal?: AbortSignal): GitHubRestRequest {
  // `all=true` is what makes an unread state worth rendering: the default list
  // carries unread threads only, so a read state could never be shown.
  return {
    path: `notifications?per_page=${PAGE_SIZE}&all=true`,
    cache: true,
    ...(signal ? { signal } : {}),
  }
}

export interface NotificationCenterOptions {
  vault: CredentialVault
  /** Where the opaque reference, its host, and its login are kept. */
  credentialFile: string
  /** Where the last confirmed list and its validator are kept. */
  cacheFile: string
  /** The GitHub host this module addresses. A credential belongs to one host. */
  host?: GitHubHostContext
  /** Consent as this computer's settings and policy currently decide it. */
  consent: () => { enabled: boolean; policyDisabled: boolean }
  /** Pushed whenever the inbox the window should be showing has changed. */
  onChange?: (inbox: NotificationInbox) => void
  fetch?: typeof globalThis.fetch
  now?: () => number
}

/** What one confirmed read established, applied only if its boundary held. */
interface NotificationRead {
  threads: NotificationThread[]
  unchanged: boolean
  /** GitHub's validator, verbatim, or null when it sent none. */
  lastModified: string | null
  /** The interval GitHub asked for, or null when page one named none. */
  pollIntervalSeconds: number | null
}

/**
 * One installation's Notification Center: its credential, its transport, its
 * cache, and the conditional poll that keeps them current.
 */
export class NotificationCenter {
  private readonly options: NotificationCenterOptions
  private readonly now: () => number
  private readonly host: GitHubHostContext
  private readonly validator = new NotificationValidatorCache()
  private credential: StoredNotificationCredential | null = null
  private credentialLoaded = false
  /** Whether the stored list for this host and account has been read already. */
  private cacheLoaded = false
  private threads: NotificationThread[] = []
  private memory: PollMemory = emptyPollMemory()
  private state: NotificationModuleState = 'disabled'
  private message: string | null = null
  private rejected = false
  private inFlight: AbortController | null = null
  private timer: NodeJS.Timeout | undefined
  private stopped = true

  /**
   * Counts the boundaries a pending read or write may not cross.
   *
   * Every change of credential, account, or host moves it on, and work that was
   * already in flight checks it before it reaches the network, the stored list,
   * or the window. A read that began under one credential therefore cannot
   * publish, or write to disk as though it belonged to, the next one.
   */
  private generation = 0

  /**
   * Ends everything in flight and opens a new boundary. Anything already
   * running finds its generation stale and writes nothing.
   */
  private fence(): void {
    this.generation += 1
    this.inFlight?.abort()
    this.inFlight = null
  }

  /**
   * A transport that belongs to this module alone: no ambient token, no process
   * install, and a credential that is this module's own. Its rejections are not
   * reported to the account listener, so a token GitHub refuses disables this
   * inbox and cannot revoke the App sign-in.
   */

  constructor(options: NotificationCenterOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.host = options.host ?? githubHostContext('github.com')
  }

  private transport(token: string) {
    return new DirectGitHubTransport({
      apiUrl: this.host.apiBase,
      host: this.host.host,
      env: {},
      cache: this.validator,
      reportFailures: false,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      credential: {
        host: this.host.host,
        available: () => true,
        current: async () => ({
          token,
          session: this.credential?.reference ?? '',
          origin: 'account' as const,
        }),
      },
    })
  }

  private async loadCredential(): Promise<void> {
    if (this.credentialLoaded) return
    this.credentialLoaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.credentialFile, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== CREDENTIAL_FILE_VERSION) return
      const reference = text(parsed.reference)
      const host = text(parsed.host)
      if (!reference || !host) return
      this.credential = {
        reference,
        host,
        login: text(parsed.login),
        createdAt: text(parsed.createdAt) ?? new Date(0).toISOString(),
      }
    } catch {
      // No stored credential is the normal state for an install that never
      // enabled the module, and an unreadable one reads the same way: the
      // sealed store still holds what it holds, but nothing claims a reference
      // to it.
    }
  }
  private async writeCredential(value: StoredNotificationCredential | null): Promise<void> {
    if (value === null) {
      await rm(this.options.credentialFile, { force: true })
    } else {
      await mkdir(dirname(this.options.credentialFile), { recursive: true })
      const temporary = temporaryPathFor(this.options.credentialFile)
      await writeFile(
        temporary,
        `${JSON.stringify({ version: CREDENTIAL_FILE_VERSION, ...value }, null, 2)}\n`,
        { mode: 0o600 },
      )
      await rename(temporary, this.options.credentialFile)
    }
    this.credential = value
    this.credentialLoaded = true
  }

  private async loadCache(login: string | null): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.cacheFile, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== CACHE_VERSION) return
      // A list belongs to the host and the account it was read for. One naming
      // another of either is not shown: it would answer this account's inbox
      // with another account's notifications.
      if (text(parsed.host) !== this.host.host) return
      if (text(parsed.login) !== login) return
      this.threads = Array.isArray(parsed.threads)
        ? parsed.threads
            .map(notificationThread)
            .filter((thread): thread is NotificationThread => thread !== null)
        : []
      const stored =
        typeof parsed.pollIntervalSeconds === 'number' ? parsed.pollIntervalSeconds : null
      const fetchedAt = timestamp(parsed.fetchedAt)
      const answeredAt = fetchedAt === null ? null : Date.parse(fetchedAt)
      const interval = pollIntervalSeconds(stored === null ? null : String(stored))
      this.memory = {
        ...this.memory,
        fetchedAt,
        lastAnsweredAt: answeredAt,
        pollIntervalSeconds: interval,
        lastModified: text(parsed.lastModified),
        // A stored list was confirmed by GitHub when it was read, so the
        // interval it named still applies to this run. A restart that ignored
        // it would be the request the interval exists to prevent.
        nextPollAt: answeredAt === null ? null : answeredAt + interval * 1000,
      }
      // The stored validator is what makes this run's first read conditional
      // rather than a full download of a list GitHub already sent.
      this.validator.remember(this.memory.lastModified, this.threads)
    } catch {
      // An absent or unreadable cache is a cold start, not a failure.
    }
  }

  /**
   * Writes the stored list atomically, with a name no concurrent write can
   * pick, so two callers cannot read each other's half-written file back.
   */
  private async writeCache(record: StoredCache): Promise<void> {
    await mkdir(dirname(this.options.cacheFile), { recursive: true })
    const temporary = temporaryPathFor(this.options.cacheFile)
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.options.cacheFile)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  private async saveCache(): Promise<void> {
    const credential = this.credentialForThisHost()
    const record: StoredCache = {
      version: CACHE_VERSION,
      host: this.host.host,
      login: credential?.login ?? null,
      lastModified: this.memory.lastModified,
      fetchedAt: this.memory.fetchedAt,
      pollIntervalSeconds: this.memory.pollIntervalSeconds,
      threads: this.threads,
    }
    await this.writeCache(record)
  }

  private async dropCache(): Promise<void> {
    this.threads = []
    this.memory = emptyPollMemory()
    this.validator.clear()
    await rm(this.options.cacheFile, { force: true }).catch(() => {})
  }

  /** The credential this host may use, or null when none belongs to it. */
  private credentialForThisHost(): StoredNotificationCredential | null {
    const credential = this.credential
    return credential && credential.host === this.host.host ? credential : null
  }

  /**
   * Opens the sealed token. The vault refuses a credential saved for another
   * host before it is even decrypted, so a host change between save and read
   * cannot hand one host's token to another.
   */
  private async token(): Promise<string> {
    const credential = this.credentialForThisHost()
    if (!credential) return ''
    try {
      return await this.options.vault.open(credential.reference, this.host.host)
    } catch (error) {
      if (error instanceof CredentialStoreError && error.failure === 'wrong-host') {
        this.message = WRONG_HOST_MESSAGE
        return ''
      }
      throw error
    }
  }

  private storeStatus(): { available: boolean; name: string | null; reason: string | null } {
    const store = this.options.vault.store()
    return store.kind === 'system'
      ? { available: true, name: store.name, reason: null }
      : { available: false, name: null, reason: store.reason }
  }

  /** Recomputes what the module can do, from consent, policy, and what is stored. */
  private settle(): void {
    const { enabled, policyDisabled } = this.options.consent()
    const store = this.storeStatus()
    if (policyDisabled) {
      this.state = 'policy-disabled'
      this.message = POLICY_MESSAGE
    } else if (!enabled) {
      this.state = 'disabled'
      this.message = DISABLED_MESSAGE
    } else if (!store.available) {
      this.state = 'storage-unavailable'
      this.message = store.reason
    } else if (!this.credentialForThisHost()) {
      // A credential stored for another host is not this host's to open, so the
      // module says which host it belongs to instead of reporting none at all.
      this.state = 'credential-missing'
      this.message = this.credential === null ? CREDENTIAL_MISSING : WRONG_HOST_MESSAGE
    } else if (this.rejected) {
      this.state = 'rejected'
      this.message = REJECTED_MESSAGE
    } else {
      this.state = 'ready'
      this.message = null
    }
  }

  private moduleStatus(): NotificationModuleStatus {
    const { enabled, policyDisabled } = this.options.consent()
    const credential = this.credentialForThisHost()
    return {
      host: this.host.host,
      state: this.state,
      enabled,
      policyDisabled,
      reference: credential?.reference ?? null,
      login: credential?.login ?? null,
      store: this.storeStatus(),
      message: this.message,
    }
  }

  /**
   * Whether what is on screen is out of date, and why. An unanswered question is
   * never reported as a fresh one: a list nobody has confirmed reads as stale
   * until GitHub says otherwise, and a list confirmed longer ago than the
   * interval it named reads as stale because its own freshness has lapsed.
   */
  private staleReason(): NotificationStaleReason | null {
    if (this.threads.length === 0) return null
    const { fetchedAt, lastAnsweredAt, lastFailure } = this.memory
    if (lastFailure !== null) {
      return lastFailure.kind === 'network' || lastFailure.kind === 'timeout' ? 'offline' : 'failed'
    }
    if (fetchedAt === null) return 'never-polled'
    if (lastAnsweredAt === null) return 'expired'
    return this.now() - lastAnsweredAt > this.memory.pollIntervalSeconds * 1000 ? 'expired' : null
  }

  private snapshot(): NotificationInbox {
    const stale = this.staleReason()
    const poll: NotificationPoll = {
      fetchedAt: this.memory.fetchedAt,
      checkedAt: this.memory.checkedAt,
      nextPollAt:
        this.memory.nextPollAt === null ? null : new Date(this.memory.nextPollAt).toISOString(),
      pollIntervalSeconds: this.memory.pollIntervalSeconds,
      lastModified: this.memory.lastModified,
      unchanged: this.memory.unchanged,
    }
    // A module that is off, held by policy, or left without its credential is
    // not polling and not acting, so it reports no list: what it stored stays
    // sealed on disk, and is not the surface another account is answered from.
    const threads = this.state === 'ready' ? this.threads : []
    return {
      ...this.moduleStatus(),
      threads,
      unreadCount: threads.filter((thread) => thread.unread).length,
      poll,
      stale: threads.length > 0 && stale !== null,
      staleReason: stale,
    }
  }

  /**
   * Loads whatever is already known, without asking GitHub anything. The stored
   * list belongs to this host and this account alone, so a file naming another
   * of either is not read into memory at all.
   */
  private async restore(): Promise<void> {
    await this.loadCredential()
    if (!this.cacheLoaded) {
      this.cacheLoaded = true
      await this.loadCache(this.credentialForThisHost()?.login ?? null)
    }
    this.settle()
  }

  /** Everything the module reports about itself, with no thread body in it. */
  async status(): Promise<NotificationModuleStatus> {
    await this.restore()
    return this.moduleStatus()
  }

  /** The inbox as it stands, from the last confirmed read or the stored cache. */
  async inbox(): Promise<NotificationInbox> {
    await this.restore()
    return this.snapshot()
  }

  /**
   * One conditional read of the whole list.
   *
   * Page one carries the validator: GitHub answers it with 304 when nothing has
   * changed, and that answer is about the whole list, so the pages after it are
   * not requested at all. A full answer is followed page by page on the API
   * origin this host owns, and the combined list replaces the single page the
   * transport recorded, so the next 304 replays all of it. A walk that stops
   * part way discards the validator rather than leaving page one stored beside a
   * list it did not come from.
   */
  private async read(token: string, signal: AbortSignal): Promise<NotificationRead> {
    const transport = this.transport(token)
    const apiBase = new URL(this.host.apiBase)
    const origin = apiBase.origin
    // The transport addresses paths under the API base, so a linked page is
    // asked for by what it adds to that base, not by the whole pathname.
    const base = apiBase.pathname.replace(/\/$/u, '')
    const combined: NotificationThread[] = []
    let request = firstPageRequest(signal)
    let lastModified: string | null = null
    // The interval is decided by page one but kept local until the caller knows
    // this read still belongs to the credential that started it: a read that
    // lost its boundary must not move the poll clock of the next one.
    let interval: number | null = null
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await transport.rest<unknown[]>(request)
        if (page === 0) {
          // The exact `Last-Modified` GitHub issued, kept verbatim: it is the
          // validator the next read sends back, and a reformatted date is not
          // the one GitHub issued.
          lastModified = response.headers?.get('last-modified') ?? null
          interval = pollIntervalSeconds(response.headers?.get('x-poll-interval') ?? null)
          if (response.notModified === true) {
            if (lastModified !== null) this.memory.lastModified = lastModified
            return {
              threads: this.validator.replay(),
              unchanged: true,
              lastModified,
              pollIntervalSeconds: interval,
            }
          }
        }
        if (!Array.isArray(response.data)) {
          throw new GitHubTransportError({
            kind: 'invalid-response',
            status: response.status,
            detail: 'GitHub returned an unexpected notification list',
          })
        }
        for (const entry of response.data) {
          const thread = notificationThread(entry)
          // A page boundary can repeat a thread when the list moves under the
          // walk. Identity is the thread id, so the first copy is the one kept.
          if (thread && !combined.some((held) => held.id === thread.id)) combined.push(thread)
        }
        const link = nextPageLink(response.headers?.get('link') ?? null)
        if (link === null) {
          return {
            threads: combined,
            unchanged: false,
            lastModified,
            pollIntervalSeconds: interval,
          }
        }
        const resolved = new URL(link, `${this.host.apiBase}/`)
        if (resolved.origin !== origin) {
          throw new GitHubTransportError({
            kind: 'invalid-response',
            detail: 'GitHub pointed the notification list at another origin',
          })
        }
        const path = resolved.pathname.startsWith(`${base}/`)
          ? resolved.pathname.slice(base.length + 1)
          : resolved.pathname.replace(/^\//u, '')
        request = { path: `${path}${resolved.search}`, signal }
      }
      throw new GitHubTransportError({
        kind: 'invalid-response',
        detail: `GitHub returned more than ${MAX_PAGES} notification pages`,
      })
    } catch (error) {
      // The transport recorded the page it did read. Without the rest of the
      // walk that page is not the list, and replaying it as one would be a
      // claim GitHub never made.
      this.validator.discard()
      throw error
    }
  }

  /**
   * Reads the inbox, honouring the poll interval GitHub asked for.
   *
   * No read runs before that interval has passed, including one a person asked
   * for: the floor is the host's own instruction, and a manual refresh that
   * outran it would be the same request the interval exists to prevent. A read
   * that is refused by the floor returns what is already known and changes
   * nothing. A failure backs the next attempt off from the same interval and
   * leaves the cached list standing, marked stale with the reason it is stale.
   */
  async refresh(options: { signal?: AbortSignal } = {}): Promise<NotificationInbox> {
    await this.restore()
    if (this.state !== 'ready') return this.snapshot()
    if (this.memory.nextPollAt !== null && this.now() < this.memory.nextPollAt) {
      return this.snapshot()
    }
    // The read is reserved here, before the credential is opened: opening it
    // waits on the key store, and two callers that both passed a null check on
    // the way there would race each other to publish a list.
    if (this.inFlight !== null) return this.snapshot()
    const generation = this.generation
    const controller = new AbortController()
    this.inFlight = controller
    const forward = () => controller.abort()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', forward, { once: true })
    }
    try {
      const token = await this.token()
      // A credential replaced, removed, or forgotten while the key store was
      // answering leaves this read with nothing to say and nothing to write.
      if (!token || this.stale(generation, controller)) return this.snapshot()
      const read = await this.read(token, controller.signal)
      if (this.stale(generation, controller)) return this.snapshot()
      const answeredAt = this.now()
      this.threads = read.threads
      if (read.pollIntervalSeconds !== null) {
        this.memory.pollIntervalSeconds = read.pollIntervalSeconds
      }
      if (read.lastModified !== null) this.memory.lastModified = read.lastModified
      this.memory.fetchedAt = new Date(answeredAt).toISOString()
      this.memory.checkedAt = this.memory.fetchedAt
      // A 304 confirms the list exactly as a full answer does, so it moves the
      // same clocks; only the flag records which of the two GitHub sent.
      this.memory.lastAnsweredAt = answeredAt
      this.memory.unchanged = read.unchanged
      this.memory.consecutiveFailures = 0
      this.memory.lastFailure = null
      this.memory.nextPollAt = answeredAt + this.memory.pollIntervalSeconds * 1000
      // The whole list and its validator are published together, so a 304 that
      // arrives next replays the list that was read, not the page the transport
      // happened to record on its own.
      this.validator.remember(this.memory.lastModified, this.threads)
      if (this.rejected) {
        this.rejected = false
        this.settle()
      }
      await this.saveCache()
    } catch (error) {
      if (this.stale(generation, controller)) return this.snapshot()
      const failure =
        error instanceof GitHubTransportError
          ? error
          : new GitHubTransportError({
              kind: 'unknown',
              detail: 'The notification read did not complete.',
            })
      const failedAt = this.now()
      this.memory.checkedAt = new Date(failedAt).toISOString()
      this.memory.lastFailure = failure
      // This credential's rejection is this module's own. The App sign-in is a
      // different credential and is not refreshed, retired, or reported on here.
      if (failure.kind === 'unauthorized' || failure.kind === 'forbidden') {
        this.rejected = true
        this.settle()
      } else if (failure.kind !== 'network' && failure.kind !== 'timeout') {
        this.message = failure.detail
      }
      this.memory.consecutiveFailures += 1
      this.memory.nextPollAt = nextPollAt(
        failedAt,
        this.memory.pollIntervalSeconds,
        this.memory.consecutiveFailures,
      )
    } finally {
      if (this.inFlight === controller) this.inFlight = null
      options.signal?.removeEventListener('abort', forward)
    }
    if (generation !== this.generation) return this.snapshot()
    const inbox = this.snapshot()
    this.options.onChange?.(inbox)
    return inbox
  }

  /** Whether work started under an earlier boundary may still touch anything. */
  private stale(generation: number, controller: AbortController): boolean {
    return generation !== this.generation || controller.signal.aborted
  }

  /**
   * Seals a token for this host and account.
   *
   * The token is written once, here, and is never returned, logged, or reported.
   * A replacement stages its credential beside the one already stored and drops
   * that one only after the new reference is committed, so an abandoned
   * replacement leaves the previous credential in place.
   */
  async saveCredential(secret: unknown, consent: unknown): Promise<NotificationModuleStatus> {
    await this.restore()
    const { enabled, policyDisabled } = this.options.consent()
    if (policyDisabled) throw new Error(POLICY_MESSAGE)
    if (!enabled) {
      throw new Error('Enable GitHub Notifications before storing a credential for it.')
    }
    // The consent is the boundary. A token that arrives without the person
    // having been told what it costs is refused, not stored.
    if (consent !== true) {
      throw new Error('The notification credential boundary must be accepted first.')
    }
    if (typeof secret !== 'string' || !secret.trim()) {
      throw new Error('Paste a GitHub notification token.')
    }
    const token = secret.trim()
    if (/\s/u.test(token)) {
      throw new Error('A GitHub token contains no spaces. Check the value you pasted.')
    }
    const store = this.options.vault.store()
    if (store.kind !== 'system') throw new Error(store.reason)

    // Identity is read through this module's own transport, so an ambient
    // environment token can neither stand in for nor redirect this one.
    const login = await this.identify(token)
    const previous = this.credentialForThisHost()
    const reference = await this.options.vault.stage(this.host.host, token, this.now())
    try {
      await this.writeCredential({
        reference,
        host: this.host.host,
        login,
        createdAt: new Date(this.now()).toISOString(),
      })
    } catch (error) {
      await this.options.vault.remove(reference).catch(() => {})
      throw error
    }
    // The credential about to be used is not the one any read in flight was
    // started with, so those reads end here instead of landing on this
    // account's list under a credential they were not sent with.
    this.fence()
    // A first credential, or one belonging to another account, invalidates the
    // list read for the previous one rather than showing it under a new name.
    if ((previous?.login ?? null) !== login) await this.dropCache()
    else this.validator.clear()
    this.rejected = false
    this.settle()
    // The first read of a newly stored credential runs at once: nothing has
    // asked this list for an interval yet, so there is no floor to wait for.
    await this.refresh().catch(() => null)
    const inbox = this.snapshot()
    this.options.onChange?.(inbox)
    return this.moduleStatus()
  }

  /** The login the given credential authenticates as, on this host only. */
  private async identify(token: string): Promise<string> {
    const response = await new DirectGitHubTransport({
      apiUrl: this.host.apiBase,
      host: this.host.host,
      env: {},
      reportFailures: false,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      token,
    }).rest<{ login?: unknown }>({ path: 'user' })
    const login = text(response.data?.login)
    if (!login) {
      throw new Error('GitHub did not report which account this token belongs to.')
    }
    return login
  }

  /**
   * Removes this module's credential. Nothing else is touched: the App sign-in,
   * its sealed credential, and every pull request, stack, and review read keep
   * working on what they already had.
   */
  async removeCredential(): Promise<NotificationModuleStatus> {
    await this.restore()
    // Removing the credential ends the boundary it was holding open: a read
    // still running under it publishes nothing and writes nothing.
    this.fence()
    const credential = this.credentialForThisHost()
    if (credential) await this.options.vault.remove(credential.reference)
    await this.writeCredential(null)
    await this.dropCache()
    this.rejected = false
    this.settle()
    this.options.onChange?.(this.snapshot())
    return this.moduleStatus()
  }

  /**
   * Marks one thread, or every thread, as read.
   *
   * The write is sent once. An uncertain answer is not resent — a second attempt
   * could repeat a change GitHub already applied — so a failure leaves the inbox
   * exactly as it was and says what it could not do.
   */
  async markRead(threadId: unknown): Promise<NotificationInbox> {
    await this.restore()
    if (threadId !== 'all' && (typeof threadId !== 'string' || !threadId)) {
      throw new Error('A notification thread id is required.')
    }
    if (this.state !== 'ready') return this.snapshot()
    const generation = this.generation
    await this.writeOnce({
      method: 'PATCH',
      path:
        threadId === 'all'
          ? 'notifications'
          : `notifications/threads/${encodeURIComponent(threadId)}`,
      body: { read: true },
    })
    // GitHub has the change. Whether it still belongs to the list on screen is a
    // separate question, and a boundary that moved while it was sent says no.
    if (generation !== this.generation) return this.snapshot()
    this.threads = this.threads.map((thread) =>
      threadId === 'all' || thread.id === threadId ? { ...thread, unread: false } : thread,
    )
    this.memory.nextPollAt =
      this.memory.lastAnsweredAt === null
        ? null
        : this.memory.lastAnsweredAt + this.memory.pollIntervalSeconds * 1000
    await this.saveCache().catch(() => null)
    return this.publish()
  }

  /**
   * The subscription controls GitHub offers for a thread: ignore it, or
   * unsubscribe from it. There is no re-subscribe, because the endpoint that
   * removes a subscription removes the thread, so none is offered here.
   */
  async setSubscription(threadId: unknown, action: unknown): Promise<NotificationInbox> {
    await this.restore()
    if (typeof threadId !== 'string' || !threadId) {
      throw new Error('A notification thread id is required.')
    }
    if (action !== 'ignore' && action !== 'unsubscribe') {
      throw new Error('A notification thread can be ignored or unsubscribed.')
    }
    if (this.state !== 'ready') return this.snapshot()
    const generation = this.generation
    const subscription = `notifications/threads/${encodeURIComponent(threadId)}/subscription`
    await this.writeOnce(
      action === 'ignore'
        ? { method: 'PUT', path: subscription, body: { ignored: true } }
        : { method: 'DELETE', path: subscription },
    )
    // GitHub acknowledged the change. A boundary that moved while it was in
    // flight means the list on screen is no longer the one it was made against.
    if (generation !== this.generation) return this.snapshot()
    // Ignoring marks a thread read and leaves it here; unsubscribing is what
    // takes it out. What the account's inbox holds afterwards is re-established
    // by the next read.
    this.threads =
      action === 'ignore'
        ? this.threads.map((thread) =>
            thread.id === threadId ? { ...thread, unread: false } : thread,
          )
        : this.threads.filter((held) => held.id !== threadId)
    // The list GitHub holds has moved, but the interval it asked for has not.
    this.memory.nextPollAt =
      this.memory.lastAnsweredAt === null
        ? null
        : this.memory.lastAnsweredAt + this.memory.pollIntervalSeconds * 1000
    await this.saveCache().catch(() => null)
    return this.publish()
  }

  /** One mutation, sent once, with the failure named rather than retried. */
  private async writeOnce(request: GitHubRestRequest): Promise<void> {
    const token = await this.token()
    if (!token) throw new Error('This inbox has no credential to write with.')
    try {
      await this.transport(token).rest({ ...request, cache: false })
    } catch (error) {
      const failure =
        error instanceof GitHubTransportError
          ? error
          : new GitHubTransportError({ kind: 'unknown', detail: 'The change did not complete.' })
      if (failure.kind === 'unauthorized' || failure.kind === 'forbidden') {
        this.rejected = true
        this.settle()
      }
      throw new Error(
        `${failure.detail} The change was not sent again; refresh to see what GitHub holds.`,
      )
    }
  }

  /** The snapshot as it now stands, pushed to whatever is watching the module. */
  private publish(): NotificationInbox {
    const inbox = this.snapshot()
    this.options.onChange?.(inbox)
    return inbox
  }

  /**
   * Ends the read in flight, if any. A cancelled read writes nothing: it
   * cannot publish a list, move the poll floor, or clear a failure.
   */
  cancel(): void {
    this.inFlight?.abort()
  }

  /**
   * Forgets everything this module knows, without touching what it stored.
   *
   * The list, its validator, and the poll clock are memory, and memory is what
   * would otherwise carry one host's inbox onto another's surface. The sealed
   * credential and the stored list both name the host they belong to and stay
   * on disk for whoever selects that host again; the list is unreadable to any
   * other host because it is checked against it before it is shown.
   */
  forget(): void {
    this.stop()
    this.fence()
    this.credentialLoaded = false
    this.cacheLoaded = false
    this.credential = null
    this.rejected = false
    this.message = null
    this.threads = []
    this.memory = emptyPollMemory()
    this.validator.clear()
    this.settle()
  }

  /**
   * Arms the next automatic read at the time the last answer asked for, and
   * keeps it armed while consent, policy, and a usable credential all hold.
   *
   * Arming republishes the state, because the change that armed it came from
   * somewhere else: a window looking at this module has to learn that it is now
   * waiting for a credential, rather than at whatever answer it last received.
   */
  start(): void {
    this.stopped = false
    this.settle()
    this.options.onChange?.(this.snapshot())
    if (this.timer !== undefined) return
    this.schedule()
  }

  /**
   * Stops asking for anything, and says so at once. A module turned off has no
   * list to show, and the window is told that now rather than at a read that is
   * no longer coming.
   */
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.cancel()
    this.settle()
    this.options.onChange?.(this.snapshot())
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh()
        .catch(() => null)
        .finally(() => {
          if (!this.stopped) this.schedule()
        })
    }, this.delayMs())
    // A poll timer must never be the reason the app cannot exit.
    this.timer.unref?.()
  }

  /**
   * How long until the next automatic read. A host that asked for a long
   * interval is waited out in full — the wait is only ever cut short by a timer
   * limit, never by this build preferring to ask sooner — and an interval that
   * outruns one timer is re-armed rather than truncated.
   */
  private delayMs(): number {
    const { enabled, policyDisabled } = this.options.consent()
    if (policyDisabled || !enabled || this.state !== 'ready') return MAX_BACKOFF_SECONDS * 1000
    const remaining = this.memory.nextPollAt === null ? 0 : this.memory.nextPollAt - this.now()
    return Math.min(MAX_TIMER_MS, Math.max(1000, remaining))
  }
}
