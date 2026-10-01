/**
 * The optional GitHub Notifications Center.
 *
 * Everything here is a fact about one account's notification inbox on one
 * GitHub host. Nothing in this module widens the GitHub App credential: the
 * notifications endpoints are served to classic personal access tokens, so the
 * inbox is a second, separately authorized thing with its own sealed
 * credential, its own transport, and its own cache. It is not the pull-request
 * inbox, and no field here is one.
 */

/** The credential kind the notifications endpoints accept. */
export const NOTIFICATION_CREDENTIAL_KIND = 'classic personal access token'

/**
 * The narrowest scope that reads a notification inbox. `repo` also works and is
 * strictly wider, so it is named as the alternative rather than as the choice.
 */
export const NOTIFICATION_CREDENTIAL_SCOPE = 'notifications'

/**
 * What a person is told before they authorize anything. The consent is stated
 * in the surface that asks for the token, and these sentences are the single
 * source of truth for it: the renderer reads them, and the main process refuses
 * a token that arrives without the consent it describes.
 */
export const NOTIFICATION_CONSENT_TITLE = 'GitHub Notifications needs its own credential'

export const NOTIFICATION_CONSENT_POINTS: readonly string[] = [
  'GitHub serves the notifications endpoints to a classic personal access token with the notifications scope. The GitHub App credential this app signs in with cannot read them, so the App’s own permissions are left exactly as they are.',
  'The token is stored only in this computer’s operating-system key store, sealed. Only an opaque reference is written to application state, and the token never reaches the window, a log, a diagnostic report, or a support bundle.',
  'The token is pinned to one GitHub host and one account. Removing it disables the Notification Center and nothing else — sign-in, pull requests, stacks, and reviews keep working on the credential they already use.',
]

/** Why the module is in the state it is in. */
export type NotificationModuleState =
  /** Consent has not been given. The default, and the state every install starts in. */
  | 'disabled'
  /** This computer's policy fixed the module off; the setting cannot be changed here. */
  | 'policy-disabled'
  /** Consent is on, but no credential is stored yet. */
  | 'credential-missing'
  /** This computer has no key store that can hold the credential. */
  | 'storage-unavailable'
  /** A credential is stored for this host and account. */
  | 'ready'
  /** GitHub refused the stored credential. Only this module is affected. */
  | 'rejected'

/** GitHub's own reason a thread is in the inbox, plus any reason a host adds later. */
export type NotificationReason =
  | 'assign'
  | 'author'
  | 'comment'
  | 'ci_activity'
  | 'invitation'
  | 'manual'
  | 'mention'
  | 'review_requested'
  | 'security_alert'
  | 'state_change'
  | 'subscribed'
  | 'team_mention'
  | 'unknown'

/** What the thread is about, as GitHub classifies the subject. */
export type NotificationSubjectKind =
  | 'issue'
  | 'pull_request'
  | 'release'
  | 'discussion'
  | 'commit'
  | 'repository_invitation'
  | 'security_alert'
  | 'workflow'
  | 'unknown'

/** One notification thread, as the inbox renders it. */
export interface NotificationThread {
  /** GitHub's opaque thread id; it is the only identity a write addresses. */
  id: string
  unread: boolean
  reason: NotificationReason
  title: string
  /** The subject's web URL on this host, or null when GitHub sent none. */
  url: string | null
  kind: NotificationSubjectKind
  repository: { owner: string; name: string } | null
  updatedAt: string
}

/**
 * The conditional-read contract this module keeps with GitHub. `lastModified`
 * is the exact `Last-Modified` value GitHub sent, and it is the exact value the
 * next read sends back as `If-Modified-Since`; nothing rewrites or normalizes
 * it, because a reformatted date is not the validator GitHub issued.
 */
export interface NotificationPoll {
  /** When GitHub last confirmed this list, including a 304 that changed nothing. */
  fetchedAt: string | null
  /** The last attempt, confirmed or not. */
  checkedAt: string | null
  /** The earliest time the next automatic read may run. */
  nextPollAt: string | null
  /** The server's own `X-Poll-Interval`, clamped to what this build will honour. */
  pollIntervalSeconds: number
  /** GitHub's exact `Last-Modified` validator for this list, or null before the first read. */
  lastModified: string | null
  /** True when the last successful answer was a 304. */
  unchanged: boolean
}

/** Why the list on screen is not current. */
export type NotificationStaleReason =
  /** Nothing has ever confirmed this list. */
  | 'never-polled'
  /** The host could not be reached; what is on screen is the last thing GitHub said. */
  | 'offline'
  /** GitHub answered with a failure; the cached list stands. */
  | 'failed'
  /** GitHub last confirmed this list longer ago than it asked to be polled. */
  | 'expired'

/**
 * Whether the module can run at all, and on what. It is what every boundary
 * answers with: no token, no sealed value, and no notification body ever
 * appears in it.
 */
export interface NotificationModuleStatus {
  /** The GitHub host this module addresses; a credential belongs to one host. */
  host: string
  state: NotificationModuleState
  /** Whether consent has been given on this computer. */
  enabled: boolean
  /** True when this computer's policy fixed the module off. */
  policyDisabled: boolean
  /** Opaque handle for the sealed credential. Never the credential itself. */
  reference: string | null
  /** The GitHub login the stored credential authenticates as, or null. */
  login: string | null
  store: { available: boolean; name: string | null; reason: string | null }
  message: string | null
}

/** The inbox: the module's status, its threads, and how current they are. */
export interface NotificationInbox extends NotificationModuleStatus {
  threads: NotificationThread[]
  unreadCount: number
  poll: NotificationPoll
  /** True when the threads on screen have not been confirmed within the poll interval. */
  stale: boolean
  staleReason: NotificationStaleReason | null
}

/** How a person reads each thread's GitHub reason. */
export const NOTIFICATION_REASON_LABELS: Record<NotificationReason, string> = {
  assign: 'Assigned',
  author: 'Author',
  comment: 'Comment',
  ci_activity: 'Checks',
  invitation: 'Invitation',
  manual: 'Subscribed manually',
  mention: 'Mentioned',
  review_requested: 'Review requested',
  security_alert: 'Security alert',
  state_change: 'State changed',
  subscribed: 'Subscribed',
  team_mention: 'Team mentioned',
  unknown: 'Other',
}

/** How a person reads each kind of subject. */
export const NOTIFICATION_SUBJECT_LABELS: Record<NotificationSubjectKind, string> = {
  issue: 'Issue',
  pull_request: 'Pull request',
  release: 'Release',
  discussion: 'Discussion',
  commit: 'Commit',
  repository_invitation: 'Repository invitation',
  security_alert: 'Security alert',
  workflow: 'Workflow run',
  unknown: 'Item',
}

/** How a person reads each module state. */
export const NOTIFICATION_STATE_LABELS: Record<NotificationModuleState, string> = {
  disabled: 'Not enabled',
  'policy-disabled': 'Disabled by this computer',
  'credential-missing': 'No credential stored',
  'storage-unavailable': 'No key store available',
  ready: 'Enabled',
  rejected: 'Credential rejected by GitHub',
}

/** How a person reads each staleness reason. */
export const NOTIFICATION_STALE_LABELS: Record<NotificationStaleReason, string> = {
  'never-polled': 'Not yet confirmed by GitHub',
  offline: 'GitHub could not be reached',
  failed: 'The last refresh did not succeed',
  expired: 'Older than the requested poll interval',
}
