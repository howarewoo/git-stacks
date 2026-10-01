import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isRecord } from '../shared/guards'
import { CredentialStoreError, CredentialVault, type SecretProtector } from './credentials'
import type { CachedGitHubResponse, GitHubResponseCache } from './github-response-cache'
import {
  DirectGitHubTransport,
  GitHubTransportError,
  type GitHubRestRequest,
  type GitHubRestResponse,
} from './github-transport'
import { githubHostContext, type GitHubHostContext } from './github-host'
import {
  NOTIFICATION_REASON_LABELS,
  NOTIFICATION_SUBJECT_LABELS,
  type NotificationInbox,
  type NotificationModuleState,
  type NotificationModuleStatus,
  type NotificationPoll,
  type NotificationReason,
  type NotificationStaleReason,
  type NotificationSubjectKind,
  type NotificationThread,
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
const NOT_SENT_MESSAGE =
  'This change was not sent: this inbox changed before the request left. Nothing was changed at GitHub.'
const SEND_IN_FLIGHT_MESSAGE =
  'Another change to this inbox is already on its way to GitHub. Wait for it to finish before sending another.'
const NOT_STORED_MESSAGE =
  'This token was not stored: this inbox changed before it was saved, so nothing was written to the credential store.'
const BOUNDARY_LOST_MESSAGE =
  'This inbox changed while the change was in flight. The change was not sent again; what GitHub holds is unknown.'

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

/**
 * The kinds and reasons a stored row may name, taken from the shared contract
 * rather than from the wire maps this build decodes with.
 *
 * The wire maps answer "what does GitHub call this"; a stored row holds what
 * this build calls it, and the two are not the same set: a name this build does
 * not recognise is stored as `unknown`, which is a valid row with a label of its
 * own rather than a corrupt one. Checking stored rows against the wire maps
 * would drop exactly those rows on the next run, and the validator kept beside
 * them would go on replaying the incomplete list.
 */
const STORED_KINDS: readonly string[] = Object.keys(NOTIFICATION_SUBJECT_LABELS)
const STORED_REASONS: readonly string[] = Object.keys(NOTIFICATION_REASON_LABELS)

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

/**
 * The persisted list, so a restart can still make a conditional read.
 *
 * The list itself is only ever the last confirmed one, so nothing here can
 * claim a change GitHub never confirmed. The last two fields are what a failed
 * attempt taught this build, and they are kept because the instruction to wait
 * outlives the process that learned it: a host that asked not to be polled for
 * ten minutes is still saying so after a restart, and a host that named a
 * longer interval on the page that then failed keeps that interval whether this
 * install is asked again in a minute or in a week.
 */
interface StoredCache {
  version: number
  host: string
  login: string | null
  lastModified: string | null
  fetchedAt: string | null
  /** The last attempt of any kind, so a run that only ever failed is honest. */
  checkedAt: string | null
  pollIntervalSeconds: number
  threads: NotificationThread[]
  /** Consecutive failures behind the retry deadline below; zero when none. */
  failures: number
  /**
   * The earliest time the next request may run, when that is a failed
   * attempt's floor rather than the interval of a confirmed read. It is the
   * same deadline the run that learned it honoured, not a guess at one.
   */
  retryFloorAt: string | null
  /**
   * Thread IDs covered by an accepted bulk mark-as-read awaiting later poll
   * confirmation. Stored so a restart does not lose the pending state.
   */
  pendingRead: string[] | null
}

/**
 * The stored list before its rows are checked. A file is data this build did
 * not write in this run, so its threads are read as unknown values and each one
 * has to earn its place — which is exactly the check a normalized row would
 * fail if its kind or its link were taken on trust.
 */
interface StoredCacheFile extends Omit<StoredCache, 'threads'> {
  threads: unknown[]
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
function notificationThread(value: unknown, host: GitHubHostContext): NotificationThread | null {
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
    url: notificationSubjectUrl(text(subject.url), host),
    kind: type !== null && Object.hasOwn(SUBJECT_BY_TYPE, type) ? SUBJECT_BY_TYPE[type] : 'unknown',
    repository: owner && name ? { owner, name } : null,
    updatedAt: timestamp(value.updated_at) ?? new Date(0).toISOString(),
  }
}

/**
 * The browser page for a notification subject.
 *
 * GitHub puts an API URL — `https://api.github.com/repos/acme/widgets/issues/123`,
 * or an enterprise host's own `/api/v3/repos/...` — into the field a person
 * opens, and an API path is not a page: on the public host it is an origin no
 * external link is allowed to leave, and on an enterprise host it would open the
 * `/api/v3` endpoint instead of the issue or pull request. The repository path
 * is moved onto this host's own web origin, so the link this module exposes is
 * always one on the host the inbox was read for, and is accepted by the same
 * external-link gate as every other link in this app.
 *
 * Only the API routes whose web page this build can actually name are rewritten.
 * An API path is not a web route spelled the same way: GitHub's web URLs for
 * anything else are the API route and the page at once only by coincidence, and
 * where they differ the coincidental path is not a page at all — there is no
 * `/acme/widgets/check-suites/104`. An unrecognised route is therefore no link,
 * which costs a person one unopenable control rather than giving them a subject
 * link that opens something this module invented.
 *
 * The subject is trusted only when this host's own API named it. A URL from
 * another origin is not this host's to interpret — not the public API, not a
 * look-alike — and a subject that is not a repository has no page here: both get
 * no link at all rather than one guessed at.
 */
export function notificationSubjectUrl(
  value: string | null,
  host: GitHubHostContext,
): string | null {
  if (!value) return null
  let subject: URL
  let api: URL
  try {
    subject = new URL(value)
    api = new URL(host.apiBase)
  } catch {
    return null
  }
  if (subject.origin !== api.origin) return null
  const base = api.pathname.replace(/\/$/u, '')
  const path =
    base !== '' && subject.pathname.startsWith(`${base}/`)
      ? subject.pathname.slice(base.length)
      : subject.pathname
  const repository = /^\/repos\/([^/]+)\/([^/]+)(\/[^?#]*)?$/u.exec(path)
  if (!repository) return null
  const repository$ = `${host.webOrigin}/${repository[1]}/${repository[2]}`
  const rest = repository[3] ?? ''
  if (rest === '') return repository$
  // An issue is the one route whose web path is its API path.
  if (/^\/issues\/[^/?#]+$/u.test(rest)) return `${repository$}${rest}`
  // GitHub pluralises the other two in its API and does not in its web routes:
  // `/repos/acme/widgets/pulls/7` is the page `/acme/widgets/pull/7`, and
  // `/repos/acme/widgets/commits/<sha>` is the page of that one commit and its
  // comments, `/acme/widgets/commit/<sha>` — not the commit history of the
  // repository, which is what leaving the plural in place would open.
  if (/^\/pulls\/[^/?#]+$/u.test(rest)) {
    return `${repository$}/pull${rest.slice('/pulls'.length)}`
  }
  if (/^\/commits\/[^/?#]+$/u.test(rest)) {
    return `${repository$}/commit${rest.slice('/commits'.length)}`
  }
  return null
}

/**
 * The subject page a stored row may still claim.
 *
 * A fresh row's link was built here from a URL the host's own API sent, so a
 * stored one is read as the page it already is rather than decoded again. It is
 * not trusted blindly either: the list is a file, and the external-link gate
 * this app opens every link through trusts public github.com whatever this
 * installation has selected, so a row naming another origin's page would be
 * opened where the equivalent fresh row would never have been offered a link at
 * all. Only a credential-free HTTPS URL on this host's own web origin survives;
 * anything else becomes no link.
 */
function storedSubjectUrl(value: unknown, host: GitHubHostContext): string | null {
  const url = text(value)
  if (url === null) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
  return parsed.origin === host.webOrigin ? url : null
}

/**
 * One thread as this build stored it.
 *
 * The stored list is this build's own normalised schema, not GitHub's wire
 * shape, so it is read as what was written: title, kind, repository, and link
 * are already decided, and re-deciding them from a payload that was never sent
 * would turn every restored row into an untitled thread with nowhere to open.
 * The two things a stored row is not allowed to assert on its own are checked
 * anyway: a kind or reason outside the contract is a corrupt record, and a link
 * is only kept while it still names a page on the host this list was read for.
 * A row that no longer matches is dropped rather than half-restored.
 */
function storedThread(value: unknown, host: GitHubHostContext): NotificationThread | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  const title = text(value.title)
  const kind = text(value.kind)
  const updatedAt = timestamp(value.updatedAt)
  if (!id || !title || !kind || !updatedAt || typeof value.unread !== 'boolean') return null
  const repository = isRecord(value.repository) ? value.repository : null
  const owner = repository ? text(repository.owner) : null
  const name = repository ? text(repository.name) : null
  const reason = text(value.reason)
  if (!STORED_KINDS.includes(kind) || !STORED_REASONS.includes(reason ?? '')) return null
  return {
    id,
    unread: value.unread,
    reason: reason as NotificationReason,
    title,
    url: storedSubjectUrl(value.url, host),
    kind: kind as NotificationSubjectKind,
    repository: owner && name ? { owner, name } : null,
    updatedAt,
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

/**
 * One host's sealed notification credentials, and the queue that changes them.
 *
 * The store is this module's own file, never the application's: the App sign-in
 * clears its own whole store when it has no identity left, and that must never
 * be able to reach a notification token — while a notification token must
 * never be able to stand in for the credential pull requests, stacks, and
 * reviews are read through. The queue is what makes that isolation hold under
 * concurrency: the store keeps its entries in memory and rewrites the whole
 * file, so a change staged by a center that is being retired and a change
 * committed by the center that replaced it have to take turns, or one of them
 * writes back entries the other had already replaced.
 */
export interface NotificationCredentialStore {
  readonly vault: CredentialVault
  /** Runs `change` once everything already queued on this file has finished. */
  serialize: <T>(change: () => Promise<T>) => Promise<T>
}

class HostCredentialStore implements NotificationCredentialStore {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(readonly vault: CredentialVault) {}

  serialize<T>(change: () => Promise<T>): Promise<T> {
    // A change that fails still counts as having had its turn: the next one
    // runs, rather than inheriting a rejection it did not cause.
    const settled = this.tail.then(change, change)
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    )
    return settled
  }
}

const credentialStores = new Map<string, HostCredentialStore>()

/**
 * The sealed store for one host's notification credentials.
 *
 * Keyed by the file, not by the center: a host that is selected again finds the
 * store and the queue its predecessor left, so a stage that was still running
 * when the app moved to another host cannot contend the same entries with the
 * center that comes back to it.
 */
export function notificationCredentialStore(
  file: string,
  protector: SecretProtector,
): NotificationCredentialStore {
  const existing = credentialStores.get(file)
  if (existing) return existing
  const created = new HostCredentialStore(new CredentialVault(file, protector))
  credentialStores.set(file, created)
  return created
}

export interface NotificationCenterOptions {
  /**
   * This module's own sealed store for the host it addresses, and the queue
   * over it. It is never the application's store.
   */
  store: NotificationCredentialStore
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

/** What one read learned from the host, whether it finished or failed part way. */
interface ReadOutcome {
  /** The interval page one asked for, or null when page one never answered. */
  pollIntervalSeconds: number | null
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
  /**
   * The threads a bulk mark-as-read GitHub has accepted but not confirmed.
   *
   * `202` means the work is still running at GitHub, so the last confirmed list
   * is still what this module knows, and the operation is reported as pending
   * rather than committed. The threads are the ones the request actually
   * covered, tracked by identity: a notification that arrived after the request
   * is not part of what that request was asked to do and must not keep it
   * pending forever.
   */
  private pendingBulkRead: string[] | null = null
  /**
   * Whether this center has been retired by the app that owns it. A retired
   * center is finished for good: it does not read its files again, cannot take
   * ownership of anything back, and publishes nothing.
   */
  private retired = false
  /** The one restoration in flight, shared by every caller that asked for it. */
  private restoring: Promise<void> | null = null
  /**
   * Counts the center lifetimes this object has lived through. `forget()` ends
   * one, and work that captured the older number is refused from then on.
   */
  private lifetime = 0
  private state: NotificationModuleState = 'disabled'
  private message: string | null = null
  private rejected = false
  private inFlight: AbortController | null = null
  /** The one mutation this module has reserved the right to send. */
  private write: AbortController | null = null
  /** The credential currently being identified, staged, and committed. */
  private authorization: AbortController | null = null
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
  private fence(): number {
    this.generation += 1
    // Every kind of pending work ends here, not just the read: a write that is
    // still waiting for the key store must not leave after the credential it
    // was waiting under, and a credential still being identified must not
    // become the stored one after consent was withdrawn or the host changed.
    this.inFlight?.abort()
    this.inFlight = null
    this.write?.abort()
    this.write = null
    this.authorization?.abort()
    this.authorization = null
    return this.generation
  }

  /** Whether consent and policy still permit anything to reach GitHub. */
  private allowed(): boolean {
    const { enabled, policyDisabled } = this.options.consent()
    return enabled && !policyDisabled
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
      // This module's budget is its own: an exhausted notification token must
      // not park the pull requests, stacks, and reviews that read through the
      // application's own credential.
      reportRateLimit: false,
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

  /**
   * The record that names the sealed credential, or null when there is none.
   *
   * Reading it is not adopting it. The caller decides, on the queue that owns
   * this file and inside this center's lifetime, whether what is on disk is
   * still this module's to open.
   */
  private async readCredentialRecord(): Promise<StoredNotificationCredential | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.credentialFile, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== CREDENTIAL_FILE_VERSION) return null
      const reference = text(parsed.reference)
      const host = text(parsed.host)
      if (!reference || !host) return null
      return {
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
      return null
    }
  }

  /** The stored list exactly as the file holds it, before any row is checked. */
  private async readCacheRecord(): Promise<StoredCacheFile | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.cacheFile, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== CACHE_VERSION) return null
      const interval = parsed.pollIntervalSeconds
      const failures = parsed.failures
      return {
        version: CACHE_VERSION,
        host: text(parsed.host) ?? '',
        login: text(parsed.login),
        lastModified: text(parsed.lastModified),
        fetchedAt: timestamp(parsed.fetchedAt),
        checkedAt: timestamp(parsed.checkedAt),
        pollIntervalSeconds: pollIntervalSeconds(
          typeof interval === 'number' ? String(interval) : null,
        ),
        threads: Array.isArray(parsed.threads) ? parsed.threads : [],
        failures:
          typeof failures === 'number' && Number.isFinite(failures) && failures > 0
            ? Math.floor(failures)
            : 0,
        retryFloorAt: timestamp(parsed.retryFloorAt),
        pendingRead: Array.isArray(parsed.pendingRead)
          ? parsed.pendingRead.filter(
              (item): item is string => typeof item === 'string' && item.length > 0,
            )
          : null,
      }
    } catch {
      // An absent or unreadable cache is a cold start, not a failure.
      return null
    }
  }

  /** Applies one stored list, if it belongs to this host and to this account. */
  private loadCache(login: string | null, record: StoredCacheFile): void {
    // A list belongs to the host and the account it was read for. One naming
    // another of either is not shown: it would answer this account's inbox
    // with another account's notifications.
    if (record.host !== this.host.host || record.login !== login) return
    const restored = record.threads
      .map((row) => storedThread(row, this.host))
      .filter((thread): thread is NotificationThread => thread !== null)
    this.threads = restored
    const answeredAt = record.fetchedAt === null ? null : Date.parse(record.fetchedAt)
    // A stored list was confirmed by GitHub when it was read, so the interval
    // it named still applies to this run. A restart that ignored it would be
    // the request the interval exists to prevent.
    const confirmed = answeredAt === null ? null : answeredAt + record.pollIntervalSeconds * 1000
    // What a failed attempt was told outlives the run that was told it: a
    // deadline that has already passed is no longer an instruction, and a
    // restart must not turn a host's refusal to be asked sooner into an
    // immediate request.
    const floor = record.retryFloorAt === null ? null : Date.parse(record.retryFloorAt)
    this.memory = {
      ...this.memory,
      fetchedAt: record.fetchedAt,
      checkedAt: record.checkedAt,
      lastAnsweredAt: answeredAt,
      pollIntervalSeconds: record.pollIntervalSeconds,
      lastModified: record.lastModified,
      consecutiveFailures: record.failures,
      nextPollAt:
        floor !== null && floor > this.now() ? Math.max(confirmed ?? 0, floor) : confirmed,
    }
    this.pendingBulkRead = record.pendingRead ?? null
    // The stored validator is what makes this run's first read conditional
    // rather than a full download of a list GitHub already sent. A list that
    // lost a row is no longer the list that validator describes, so the
    // validator goes with the row rather than replaying the loss forever.
    if (restored.length === record.threads.length) {
      this.validator.remember(this.memory.lastModified, this.threads)
    } else {
      this.validator.discard()
    }
  }

  /** Writes the record that names a sealed reference, atomically. */
  private async writeCredentialFile(value: StoredNotificationCredential): Promise<void> {
    await mkdir(dirname(this.options.credentialFile), { recursive: true })
    const temporary = temporaryPathFor(this.options.credentialFile)
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: CREDENTIAL_FILE_VERSION, ...value }, null, 2)}\n`,
        { mode: 0o600 },
      )
      await rename(temporary, this.options.credentialFile)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Runs one durable change to this module's files on the queue that owns them,
   * and only while the boundary that asked for it still holds.
   *
   * The queue is what keeps a late write from landing on top of a newer one, and
   * the generation is what keeps a write whose credential, consent, or host has
   * been replaced from writing at all. A retired center owns nothing: its
   * changes are refused whatever generation they were started in.
   */
  private async commit(generation: number, change: () => Promise<void>): Promise<boolean> {
    let applied = false
    await this.options.store.serialize(async () => {
      if (this.retired || generation !== this.generation) return
      await change()
      applied = true
    })
    return applied
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

  /**
   * Writes the list, its validator, and its poll clock as the boundary allows.
   *
   * The list written is always the last confirmed one, so a failure cannot
   * invent a state GitHub never confirmed; what a failure may persist is the
   * deadline it was given, because that instruction outlives the attempt.
   */
  private async saveCache(generation: number = this.generation): Promise<boolean> {
    const credential = this.credentialForThisHost()
    const floor = this.memory.nextPollAt
    const record: StoredCache = {
      version: CACHE_VERSION,
      host: this.host.host,
      login: credential?.login ?? null,
      lastModified: this.memory.lastModified,
      fetchedAt: this.memory.fetchedAt,
      checkedAt: this.memory.checkedAt,
      pollIntervalSeconds: this.memory.pollIntervalSeconds,
      threads: this.threads,
      failures: this.memory.consecutiveFailures,
      retryFloorAt:
        this.memory.consecutiveFailures > 0 && floor !== null
          ? new Date(floor).toISOString()
          : null,
      pendingRead: this.pendingBulkRead,
    }
    return this.commit(generation, () => this.writeCache(record))
  }

  private async dropCache(generation: number = this.generation): Promise<void> {
    this.threads = []
    this.memory = emptyPollMemory()
    this.validator.clear()
    // The removal is queued like every other change to this file, so a list that
    // was being written when the credential it belongs to went away cannot land
    // afterwards and leave the next run reading it.
    await this.commit(generation, async () => {
      await rm(this.options.cacheFile, { force: true })
    })
  }

  /**
   * Deletes the sealed secret, the record naming it, and the list read with it,
   * taking only what this removal still owns.
   *
   * A credential that was replaced while this deletion waited its turn has
   * already put its own record and its own account's list on disk, and deleting
   * those would leave the successor reporting a token that no longer opens. So
   * each file is removed only while it still names what this change was
   * removing.
   */
  private async removeOwnedFiles(credential: StoredNotificationCredential | null): Promise<void> {
    await this.options.store.serialize(async () => {
      if (credential) await this.options.store.vault.remove(credential.reference)
      const named = await this.readCredentialRecord()
      if (named !== null && named.reference !== credential?.reference) {
        return
      }
      await rm(this.options.credentialFile, { force: true })
      const stored = await this.readCacheRecord()
      if (stored === null || stored.login === (credential?.login ?? null)) {
        await rm(this.options.cacheFile, { force: true })
      }
    })
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
      return await this.options.store.vault.open(credential.reference, this.host.host)
    } catch (error) {
      if (error instanceof CredentialStoreError && error.failure === 'wrong-host') {
        this.message = WRONG_HOST_MESSAGE
        return ''
      }
      throw error
    }
  }

  private storeStatus(): { available: boolean; name: string | null; reason: string | null } {
    const store = this.options.store.vault.store()
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
   * Whether the last confirmed answer still stands, and why it does not.
   *
   * This is a fact about the last read, not about how many rows it returned: an
   * inbox GitHub confirmed as empty is an answer like any other, and it goes
   * stale on the same clock and for the same reasons as a full one. An
   * unanswered question is never reported as a fresh one, and a list confirmed
   * longer ago than the interval it named is stale because its own freshness
   * has lapsed.
   */
  private staleReason(): NotificationStaleReason | null {
    const { fetchedAt, lastAnsweredAt, lastFailure } = this.memory
    if (lastFailure !== null) {
      return lastFailure.kind === 'network' || lastFailure.kind === 'timeout' ? 'offline' : 'failed'
    }
    if (fetchedAt === null) return 'never-polled'
    if (lastAnsweredAt === null) return 'expired'
    return this.now() - lastAnsweredAt > this.memory.pollIntervalSeconds * 1000 ? 'expired' : null
  }

  private snapshot(): NotificationInbox {
    // Freshness belongs to what was last confirmed, not to how many rows that
    // answer held: an empty inbox nobody can confirm any more is not a current
    // answer either. A module that is not polling has no answer on screen to be
    // stale or current.
    const stale = this.state === 'ready' ? this.staleReason() : null
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
      markAllReadPending: this.pendingBulkRead !== null,
      stale: stale !== null,
      staleReason: stale,
    }
  }

  /**
   * Loads whatever is already known, without asking GitHub anything. The stored
   * list belongs to this host and this account alone, so a file naming another
   * of either is not read into memory at all.
   *
   * There is one restoration per center, and every caller waits on that same
   * one: two callers reading these files at once could otherwise adopt the same
   * record into two different sets of state, and a read that was waiting on the
   * files would come back into a center that had already been retired and take
   * its host's private list with it.
   */
  private async restore(): Promise<void> {
    if (this.retired) return
    this.restoring ??= this.restoreStored()
    await this.restoring
    this.settle()
  }

  private async restoreStored(): Promise<void> {
    const lifetime = this.lifetime
    const record = await this.readCredentialRecord()
    if (!this.holds(lifetime)) return
    this.credential = record
    this.credentialLoaded = true

    if (this.cacheLoaded) return
    const cached = await this.readCacheRecord()
    if (!this.holds(lifetime)) return
    this.cacheLoaded = true
    if (cached !== null) {
      this.loadCache(this.credentialForThisHost()?.login ?? null, cached)
    }
    this.settle()
    // A center that was started before its credential existed is armed for the
    // wait a missing credential means. Restoring is what makes it ready, so the
    // timer has to be told the interval the restored list was read under.
    this.armTimer()
  }

  /** Whether work that captured this lifetime may still touch this center. */
  private holds(lifetime: number): boolean {
    return !this.retired && lifetime === this.lifetime
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
  private async read(
    token: string,
    signal: AbortSignal,
    outcome: ReadOutcome,
  ): Promise<NotificationRead> {
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
          // Recorded whether or not the walk finishes: a page two that fails
          // cannot un-teach this build the interval page one just asked for.
          outcome.pollIntervalSeconds = interval
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
            publish: false,
          })
        }
        for (const entry of response.data) {
          const thread = notificationThread(entry, this.host)
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
            publish: false,
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
        publish: false,
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
    // Recorded outside the read so a walk that fails after page one still leaves
    // behind what page one taught this build about the host's interval.
    const outcome: ReadOutcome = { pollIntervalSeconds: null }
    try {
      const token = await this.token()
      // A credential replaced, removed, or forgotten while the key store was
      // answering leaves this read with nothing to say and nothing to write.
      if (!token || this.stale(generation, controller)) return this.snapshot()
      const read = await this.read(token, controller.signal, outcome)
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
      // An accepted bulk mark-as-read is settled here, by a list GitHub has
      // confirmed rather than by the request that asked for it: each thread the
      // request covered is confirmed once it comes back read or gone. A 304 is
      // not that confirmation — it says nothing about what the work did — so an
      // unchanged list leaves the operation pending for the next full answer.
      if (read.unchanged === false) this.confirmBulkRead()
      // The whole list and its validator are published together, so a 304 that
      // arrives next replays the list that was read, not the page the transport
      // happened to record on its own.
      this.validator.remember(this.memory.lastModified, this.threads)
      if (this.rejected) {
        this.rejected = false
        this.settle()
      }
      await this.saveCache(generation)
      // A read the host floor allowed has moved the poll clock, so the timer
      // that was armed for the old deadline is armed again for this one.
      this.armTimer()
    } catch (error) {
      if (this.stale(generation, controller)) return this.snapshot()
      const failure =
        error instanceof GitHubTransportError
          ? error
          : new GitHubTransportError({
              kind: 'unknown',
              detail: 'The notification read did not complete.',
              publish: false,
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
      // What page one taught this build about the host's interval survives the
      // failure that followed it, and only ever grows: a longer interval is
      // still the host's instruction, whatever happened on page two.
      if (outcome.pollIntervalSeconds !== null) {
        this.memory.pollIntervalSeconds = Math.max(
          this.memory.pollIntervalSeconds,
          outcome.pollIntervalSeconds,
        )
      }
      this.memory.nextPollAt = this.failureFloor(failedAt, failure)
      // What this failure was told survives it: the interval page one named
      // keeps holding this host off, and the deadline GitHub gave is written
      // beside the last confirmed list so a restart, or a return to this host,
      // does not turn a refusal into permission to ask again immediately.
      await this.saveCache(generation)
      this.armTimer()
    } finally {
      if (this.inFlight === controller) this.inFlight = null
      options.signal?.removeEventListener('abort', forward)
    }
    if (generation !== this.generation) return this.snapshot()
    return this.publish()
  }

  /**
   * Settles an accepted bulk mark-as-read against a list GitHub confirmed.
   *
   * The threads being tracked are the ones the request actually covered, so a
   * notification that arrived after it cannot keep the operation pending
   * forever, and the inbox on screen stays exactly what GitHub last confirmed:
   * this decides what is outstanding, never what a thread is.
   */
  private confirmBulkRead(): void {
    const pending = this.pendingBulkRead
    if (pending === null) return
    const unread = new Set(this.threads.filter((thread) => thread.unread).map((row) => row.id))
    const outstanding = pending.filter((id) => unread.has(id))
    this.pendingBulkRead = outstanding.length === 0 ? null : outstanding
  }

  /** Whether work started under an earlier boundary may still touch anything. */
  private stale(generation: number, controller: AbortController): boolean {
    return generation !== this.generation || controller.signal.aborted
  }

  /**
   * When the next automatic read may run after a failure.
   *
   * The local backoff and the interval the host named are both floors, and so is
   * what the failed answer itself asked for: a 429 with a `Retry-After`, or the
   * reset time in a rate-limit header, is this host saying when it will answer
   * again. The longest of the three wins, so neither this build's ceiling on its
   * own backoff nor its own impatience can bring a read forward of what GitHub
   * asked for — and the floor applies to the timer and to a person asking alike,
   * because both of them read `nextPollAt`.
   */
  private failureFloor(failedAt: number, failure: GitHubTransportError): number {
    return Math.max(
      nextPollAt(failedAt, this.memory.pollIntervalSeconds, this.memory.consecutiveFailures),
      this.serverFloor(failedAt, failure) ?? 0,
    )
  }

  /**
   * When the host said it would answer again, or null when it said nothing.
   *
   * A `Retry-After` on a refusal and the reset time in a rate-limit header are
   * the host naming its own deadline, and it applies to every request this
   * module makes afterwards, not only to the one that was refused. It is kept
   * here and nowhere else: the transport this module uses reports neither its
   * failures nor its budget to the credential the rest of the app reads with.
   */
  private serverFloor(at: number, failure: GitHubTransportError): number | null {
    const floors: number[] = []
    if (failure.rateLimit.retryAfterSeconds !== null) {
      floors.push(at + Math.max(0, failure.rateLimit.retryAfterSeconds) * 1000)
    }
    if (failure.rateLimit.reset !== null) floors.push(failure.rateLimit.reset.getTime())
    return floors.length === 0 ? null : Math.max(...floors)
  }

  /**
   * Seals a token for this host and account.
   *
   * The token is written once, here, and is never returned, logged, or reported.
   * A replacement stages its credential beside the one already stored and retires
   * that one only after the new reference is committed, so an abandoned
   * replacement leaves the previous credential in place — and leaves nothing
   * sealed behind it either. Every step asks whether the boundary that started
   * this is still the current one: consent withdrawn, the host changed, or the
   * credential replaced while the key store was answering all mean this token is
   * not stored, not published, and not left in the store.
   */
  async saveCredential(
    secret: unknown,
    consent: unknown,
    host: unknown = this.host.host,
  ): Promise<NotificationModuleStatus> {
    if (this.retired) throw new Error(NOT_STORED_MESSAGE)
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
    if (typeof host !== 'string' || host !== this.host.host) {
      throw new Error(
        'This token was typed for a different GitHub host, so it was not stored and not sent anywhere.',
      )
    }
    if (typeof secret !== 'string' || !secret.trim()) {
      throw new Error('Paste a GitHub notification token.')
    }
    const token = secret.trim()
    if (/\s/u.test(token)) {
      throw new Error('A GitHub token contains no spaces. Check the value you pasted.')
    }
    const store = this.options.store.vault.store()
    if (store.kind !== 'system') throw new Error(store.reason)

    // A save that is already under way belongs to a credential this one
    // replaces: it is fenced here rather than allowed to race this transaction
    // into the same file.
    const generation = this.fence()
    const controller = new AbortController()
    this.authorization = controller
    try {
      // Identity is read through this module's own transport, so an ambient
      // environment token can neither stand in for nor redirect this one.
      let login: string
      try {
        login = await this.identify(token, controller.signal)
      } catch (error) {
        // A boundary that moved while the host was answering ends this save.
        // That is not a refusal of the token the person pasted, and nothing is
        // stored either way.
        if (this.stale(generation, controller)) throw new Error(NOT_STORED_MESSAGE)
        throw error
      }
      if (this.stale(generation, controller)) throw new Error(NOT_STORED_MESSAGE)
      const previous = this.credentialForThisHost()
      // Sealing and committing are one change to one file and take their turn on
      // its queue, so a stage another center left running for this host either
      // commits before this one or finds itself stale and retires itself.
      const reference = await this.options.store.serialize(async () => {
        if (this.stale(generation, controller)) return null
        return this.options.store.vault.stage(this.host.host, token, this.now())
      })
      if (reference === null) throw new Error(NOT_STORED_MESSAGE)
      const stored: StoredNotificationCredential = {
        reference,
        host: this.host.host,
        login,
        createdAt: new Date(this.now()).toISOString(),
      }
      // Recheck ownership after the durable write: if the boundary moved
      // during the write, abandon only our staged reference and roll back the
      // file only if it still names our staged reference.
      let adopted: string | null = null
      try {
        adopted = await this.options.store.serialize(async () => {
          if (this.stale(generation, controller)) return null
          await this.writeCredentialFile(stored)
          if (!this.stale(generation, controller)) return reference
          const named = await this.readCredentialRecord()
          await this.options.store.vault.remove(reference)
          if (named?.reference === reference) {
            if (previous) await this.writeCredentialFile(previous)
            else await rm(this.options.credentialFile, { force: true })
          }
          return null
        })
      } finally {
        if (adopted === null) {
          await this.retire(reference)
        }
      }
      if (adopted === null) throw new Error(NOT_STORED_MESSAGE)

      // Credential adoption, generation advancement, and synchronous invalidation
      // of the previous account's in-memory threads/validator happen in ONE step
      // with no intervening await, so no mixed-account snapshot can ever be exposed.
      this.authorization = null
      this.credential = stored
      this.credentialLoaded = true
      this.fence()
      const accountChanged = (previous?.login ?? null) !== login
      if (accountChanged) {
        this.threads = []
        this.memory = emptyPollMemory()
        this.validator.clear()
        this.pendingBulkRead = null
      } else {
        this.validator.clear()
      }
      this.rejected = false
      this.settle()

      // Retire ONLY the captured superseded reference, never all other references
      // in the vault (which could belong to concurrent staged or successor saves).
      if (previous && previous.reference !== reference) {
        await this.retire(previous.reference)
      }
      if (accountChanged) {
        await this.dropCache()
      }

      // The first read of a newly stored credential runs at once: nothing has
      // asked this list for an interval yet, so there is no floor to wait for.
      await this.refresh().catch(() => null)
      this.armTimer()
      return this.publish()
    } finally {
      if (this.authorization === controller) this.authorization = null
    }
  }

  /**
   * Removes one sealed reference on this file's queue, so a retirement cannot
   * interleave with a stage that is committing the same file.
   */
  private async retire(reference: string): Promise<void> {
    await this.options.store
      .serialize(() => this.options.store.vault.remove(reference))
      .catch(() => {})
  }

  /** The login the given credential authenticates as, on this host only. */
  private async identify(token: string, signal: AbortSignal): Promise<string> {
    const response = await new DirectGitHubTransport({
      apiUrl: this.host.apiBase,
      host: this.host.host,
      env: {},
      reportFailures: false,
      reportRateLimit: false,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      token,
    }).rest<{ login?: unknown }>({ path: 'user', signal })
    const login = text(response.data?.login)
    if (!login) {
      throw new Error('GitHub did not report which account this token belongs to.')
    }
    return login
  }

  /**
   * Removes this module's credential. Nothing else is touched: the App sign-in,
   * its sealed credential, and every pull request, stack, and review read keep
   * working on what they already had, in a store this module never shared with
   * them in the first place.
   */
  async removeCredential(): Promise<NotificationModuleStatus> {
    await this.restore()
    const credential = this.credentialForThisHost()
    const generation = this.fence()
    // Synchronously invalidate credential and private state before any await:
    this.credential = null
    this.credentialLoaded = true
    this.threads = []
    this.memory = emptyPollMemory()
    this.validator.clear()
    this.pendingBulkRead = null
    this.rejected = false
    this.settle()
    this.publish()

    // Serialize owned deletion on the shared queue; delete files only if they
    // still name the removed credential (so a successor's files are protected):
    await this.removeOwnedFiles(credential)

    if (generation !== this.generation) return this.moduleStatus()
    this.settle()
    this.publish()
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
    const response = await this.writeOnce({
      // GitHub documents the inbox-wide operation as `PUT /notifications`; only
      // one thread is marked with `PATCH`. The bulk request is a different
      // operation, not the same one repeated.
      method: threadId === 'all' ? 'PUT' : 'PATCH',
      path:
        threadId === 'all'
          ? 'notifications'
          : `notifications/threads/${encodeURIComponent(threadId)}`,
      body: { read: true },
    })
    // GitHub has the change. Whether it still belongs to the list on screen is a
    // separate question, and a boundary that moved while it was sent says no.
    if (generation !== this.generation) return this.snapshot()
    if (threadId === 'all' && response.status === 202) {
      // 202 is accepted rather than completed: keep the pending target identity
      // internally and confirm observable completion on a later allowed poll.
      this.pendingBulkRead = this.threads.map((thread) => thread.id)
      await this.saveCache().catch(() => null)
      return this.publish()
    }
    this.threads = this.threads.map((thread) =>
      threadId === 'all' || thread.id === threadId ? { ...thread, unread: false } : thread,
    )
    if (threadId === 'all') {
      this.pendingBulkRead = null
    }
    await this.rememberWritten()
    // The write to disk is one await too: a boundary that moved while it was
    // being written says the list on screen is no longer this module's to push.
    return generation === this.generation ? this.publish() : this.snapshot()
  }

  /**
   * Marks one thread as done, removing it from the notification inbox.
   *
   * Documented as `DELETE /notifications/threads/{thread_id}` with status 204.
   * Unlike unsubscribe, Done removes the thread as an inbox item without
   * changing subscription preference.
   */
  async markDone(threadId: unknown): Promise<NotificationInbox> {
    await this.restore()
    if (typeof threadId !== 'string' || !threadId) {
      throw new Error('A notification thread id is required.')
    }
    if (this.state !== 'ready') return this.snapshot()
    const generation = this.generation
    await this.writeOnce({
      method: 'DELETE',
      path: `notifications/threads/${encodeURIComponent(threadId)}`,
    })
    if (generation !== this.generation) return this.snapshot()
    this.threads = this.threads.filter((held) => held.id !== threadId)
    if (this.pendingBulkRead) {
      this.pendingBulkRead = this.pendingBulkRead.filter((id) => id !== threadId)
    }
    await this.rememberWritten()
    return generation === this.generation ? this.publish() : this.snapshot()
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
    if (this.pendingBulkRead && action === 'unsubscribe') {
      this.pendingBulkRead = this.pendingBulkRead.filter((id) => id !== threadId)
    }
    await this.rememberWritten()
    // The write to disk is one await too: a boundary that moved while it was
    // being written says the list on screen is no longer this module's to push.
    return generation === this.generation ? this.publish() : this.snapshot()
  }

  /**
   * What the module shows after a write it knows GitHub applied.
   *
   * The change is written to the stored list and to the validator's replay
   * together, because the next conditional read answers from that replay: a
   * thread marked read or unsubscribed here would otherwise come back unread or
   * reappear on the first 304, and survive the restart that reads the same file.
   */
  private async rememberWritten(): Promise<void> {
    // The list GitHub holds has moved, but the interval it asked for has not.
    // Preserve any outstanding server retry/rate-limit deadline.
    const normalDeadline =
      this.memory.lastAnsweredAt === null
        ? null
        : this.memory.lastAnsweredAt + this.memory.pollIntervalSeconds * 1000
    this.memory.nextPollAt =
      this.memory.nextPollAt !== null && this.memory.nextPollAt > (normalDeadline ?? 0)
        ? this.memory.nextPollAt
        : normalDeadline
    this.validator.remember(this.memory.lastModified, this.threads)
    await this.saveCache().catch(() => null)
    this.armTimer()
  }

  /**
   * One mutation, sent once, with the failure named rather than retried.
   *
   * The right to send is reserved before the key store is asked for a token, so
   * two changes cannot leave together and a change cannot outlive the credential
   * it was made against. A boundary that moved — a replacement, a removal, the
   * module being turned off — means the change is not sent at all, and an answer
   * that arrives after one changes nothing: not the list, not the stored file,
   * and not which credential this module believes GitHub refused.
   */
  private async writeOnce(request: GitHubRestRequest): Promise<GitHubRestResponse<unknown>> {
    if (this.write !== null) throw new Error(SEND_IN_FLIGHT_MESSAGE)
    const generation = this.generation
    const controller = new AbortController()
    this.write = controller
    const holds = (): boolean => !this.stale(generation, controller) && this.allowed()
    try {
      const token = await this.token()
      if (!token) throw new Error('This inbox has no credential to write with.')
      if (!holds()) throw new Error(NOT_SENT_MESSAGE)
      let response: GitHubRestResponse<unknown>
      try {
        response = await this.transport(token).rest({
          ...request,
          cache: false,
          signal: controller.signal,
        })
      } catch (error) {
        const failure =
          error instanceof GitHubTransportError
            ? error
            : new GitHubTransportError({
                kind: 'unknown',
                detail: 'The change did not complete.',
                publish: false,
              })
        if (!holds()) throw new Error(BOUNDARY_LOST_MESSAGE)
        if (failure.kind === 'unauthorized' || failure.kind === 'forbidden') {
          this.rejected = true
          this.settle()
        }
        // Consume mutation Retry-After/reset metadata into local rate-limit deadline
        const floor = this.serverFloor(this.now(), failure)
        if (floor !== null) {
          this.memory.nextPollAt = Math.max(this.memory.nextPollAt ?? 0, floor)
          this.armTimer()
        }
        throw new Error(
          `${failure.detail} The change was not sent again; refresh to see what GitHub holds.`,
        )
      }
      if (!holds()) throw new Error(BOUNDARY_LOST_MESSAGE)
      // Invalidate/cancel reads predating this acknowledged mutation
      if (this.inFlight) {
        this.inFlight.abort()
        this.inFlight = null
      }
      return response
    } finally {
      if (this.write === controller) this.write = null
    }
  }

  /** The snapshot as it now stands, pushed to whatever is watching the module. */
  private publish(): NotificationInbox {
    const inbox = this.snapshot()
    if (!this.retired) this.options.onChange?.(inbox)
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
    this.retired = true
    this.lifetime += 1
    this.credentialLoaded = false
    this.cacheLoaded = false
    this.credential = null
    this.rejected = false
    this.message = null
    this.threads = []
    this.memory = emptyPollMemory()
    this.validator.clear()
    this.pendingBulkRead = null
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
    this.publish()
    this.schedule()
  }

  /**
   * Stops asking for anything, and says so at once. A module turned off has no
   * list to show, and the window is told that now rather than at a read that is
   * no longer coming.
   *
   * Turning it off is also the boundary it stops holding open: a read, a write,
   * or a credential still being identified finds itself stale, and consent that
   * was withdrawn mid-flight cannot be undone by work that had already started.
   */
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.fence()
    this.settle()
    this.publish()
  }

  private armTimer(): void {
    if (this.stopped) return
    this.schedule()
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
    if (policyDisabled || !enabled) return MAX_BACKOFF_SECONDS * 1000
    if (this.state !== 'ready') return MIN_POLL_SECONDS * 1000
    const remaining = this.memory.nextPollAt === null ? 0 : this.memory.nextPollAt - this.now()
    return Math.min(MAX_TIMER_MS, Math.max(1000, remaining))
  }
}
