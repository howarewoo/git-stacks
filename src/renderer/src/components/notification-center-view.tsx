import * as React from 'react'
import {
  Bell,
  BellOff,
  CheckCheck,
  CircleCheck,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { EmptyState } from './ui/surface'
import { InlineAlert } from './ui/surface'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { WORKSPACE_VIEW_HEADING_ID } from './workspace-navigation'
import {
  NOTIFICATION_CONSENT_POINTS,
  NOTIFICATION_CREDENTIAL_SCOPE,
  NOTIFICATION_CREDENTIAL_KIND,
  NOTIFICATION_REASON_LABELS,
  NOTIFICATION_STALE_LABELS,
  NOTIFICATION_STATE_LABELS,
  NOTIFICATION_SUBJECT_LABELS,
  type NotificationInbox,
  type NotificationModuleState,
  type NotificationThread,
} from '../../../shared/notifications'

type Tone = 'info' | 'success' | 'warning' | 'error'

const STATE_TONES: Record<NotificationModuleState, Tone> = {
  disabled: 'info',
  'policy-disabled': 'warning',
  'credential-missing': 'warning',
  'storage-unavailable': 'error',
  ready: 'success',
  rejected: 'error',
}

const BADGE_TONES: Record<Tone, 'info' | 'success' | 'warning' | 'danger'> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'danger',
}

/** What the poll has to say about the list on screen, in the order it matters. */
function pollSubtitle(inbox: NotificationInbox): string {
  if (inbox.state !== 'ready') return NOTIFICATION_STATE_LABELS[inbox.state]
  if (inbox.stale && inbox.staleReason)
    return `Stale · ${NOTIFICATION_STALE_LABELS[inbox.staleReason]}`
  return `${inbox.threads.length} threads · ${inbox.unreadCount} unread`
}

/**
 * One thread, and only the controls GitHub actually offers for it: reading it,
 * marking it done, opening it on the host, ignoring it, and unsubscribing from
 * it.
 *
 * Those controls are decided separately, because GitHub offers them
 * separately. `Done` and the subscription controls address the thread by its
 * own id, so they exist whether or not this build can open the subject in a
 * browser; only `Open` depends on there being a subject page, and its absence
 * says this build has no link rather than that the thread has no operations.
 */
function NotificationRow({
  busy,
  onMarkDone,
  onMarkRead,
  onOpen,
  onSubscribe,
  thread,
}: {
  busy: boolean
  onMarkDone: (threadId: string) => void
  onMarkRead: (threadId: string) => void
  onOpen: (thread: NotificationThread) => void
  onSubscribe: (thread: NotificationThread, action: 'ignore' | 'unsubscribe') => void
  thread: NotificationThread
}) {
  const openable = thread.url !== null
  return (
    <div className="capability-row notification-thread-row" role="listitem">
      <span className="capability-copy">
        <strong>
          {thread.unread ? '● ' : ''}
          {thread.title}
        </strong>
        <small>
          {NOTIFICATION_SUBJECT_LABELS[thread.kind]}
          {thread.repository ? ` · ${thread.repository.owner}/${thread.repository.name}` : ''}
          {` · ${NOTIFICATION_REASON_LABELS[thread.reason]}`}
        </small>
      </span>
      <Badge variant={thread.unread ? 'accent' : 'outline'}>
        {thread.unread ? 'Unread' : 'Read'}
      </Badge>
      <Button
        aria-label={`Mark ${thread.title} as read`}
        disabled={busy || !thread.unread}
        onClick={() => onMarkRead(thread.id)}
        size="sm"
        tooltip="Mark this thread read on GitHub. Sent once; a failed write is never replayed."
        variant="ghost"
      >
        <CheckCheck className="size-3.5" />
        Mark read
      </Button>
      <Button
        aria-label={`Mark ${thread.title} as done`}
        disabled={busy}
        onClick={() => onMarkDone(thread.id)}
        size="sm"
        tooltip="Mark this thread done on GitHub, which clears it from the inbox. It is not unsubscribing: the conversation's subscription is untouched."
        variant="ghost"
      >
        <CircleCheck className="size-3.5" />
        Done
      </Button>
      <Button
        aria-label={`Open ${thread.title} on GitHub`}
        disabled={busy || !openable}
        onClick={() => onOpen(thread)}
        size="sm"
        tooltip={
          openable
            ? 'Opens the subject on GitHub in your browser. This window never loads it.'
            : 'This host offered no page for this subject, so there is nothing to open. Reading it, marking it done, and its subscription are still available.'
        }
        variant="ghost"
      >
        <ExternalLink className="size-3.5" />
        Open
      </Button>
      <Button
        aria-label={`Ignore ${thread.title}`}
        disabled={busy}
        onClick={() => onSubscribe(thread, 'ignore')}
        size="sm"
        tooltip="Ignore this thread on GitHub. You stop receiving it; it is not deleted."
        variant="ghost"
      >
        <BellOff className="size-3.5" />
        Ignore
      </Button>
      <Button
        aria-label={`Unsubscribe from ${thread.title}`}
        disabled={busy}
        onClick={() => onSubscribe(thread, 'unsubscribe')}
        size="sm"
        tooltip="Unsubscribe from this thread on GitHub. The thread itself stays."
        variant="ghost"
      >
        <Bell className="size-3.5" />
        Unsubscribe
      </Button>
    </div>
  )
}

/**
 * The consent step. It names the credential boundary in full before anything is
 * typed, and the token field is a password input that is cleared the moment the
 * dialog closes — the value crosses the bridge once and is never read back.
 *
 * The host it displays is submitted with the token, because that is the host
 * the person acknowledged on screen. A token entered against one host must
 * never be identified against another, and the only place that fact is known is
 * here, where the host was named and the acknowledgement was given.
 */
export function NotificationCredentialDialog({
  busy,
  error,
  host,
  login,
  onOpenChange,
  onSubmit,
  open,
}: {
  busy: boolean
  error: string | null
  host: string
  login: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (token: string, accepted: boolean, host: string) => void
  open: boolean
}) {
  const [token, setToken] = React.useState('')
  const [accepted, setAccepted] = React.useState(false)
  React.useEffect(() => {
    if (!open) {
      setToken('')
      setAccepted(false)
    }
  }, [open])
  const canSubmit = accepted && token.trim().length > 0 && !busy
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workflow-dialog" aria-label="GitHub Notifications credential">
        <DialogHeader>
          <DialogTitle>GitHub Notifications needs its own credential</DialogTitle>
          <DialogDescription>
            This is separate from the GitHub App sign-in, and it does not change it.
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-form">
          <ul className="m-0 grid list-none gap-2 p-0">
            {NOTIFICATION_CONSENT_POINTS.map((point) => (
              <li
                className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]"
                key={point}
              >
                {point}
              </li>
            ))}
          </ul>
          <dl className="m-0 grid gap-1 text-[length:var(--gs-semantic-type-metadata-size)]">
            <div className="flex gap-2">
              <dt className="text-[var(--gs-semantic-text-secondary)]">Credential</dt>
              <dd className="m-0">{NOTIFICATION_CREDENTIAL_KIND}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--gs-semantic-text-secondary)]">Scope</dt>
              <dd className="m-0">{NOTIFICATION_CREDENTIAL_SCOPE}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--gs-semantic-text-secondary)]">Host</dt>
              <dd className="m-0">{host}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--gs-semantic-text-secondary)]">Account</dt>
              <dd className="m-0">{login ?? 'The account this token belongs to'}</dd>
            </div>
          </dl>
          <div className="grid gap-1">
            <label
              className="text-[length:var(--gs-semantic-type-label-size)]"
              htmlFor="notification-token"
            >
              Personal access token
            </label>
            <Input
              id="notification-token"
              autoComplete="off"
              controlSize="compact"
              onChange={(event) => setToken(event.target.value)}
              placeholder="ghp_…"
              spellCheck={false}
              type="password"
              value={token}
            />
          </div>
          <Checkbox
            checked={accepted}
            description="It is stored separately from the GitHub App sign-in and is removed on its own, without affecting pull requests, stacks, or reviews."
            label="I understand the boundary this credential adds."
            onChange={(event) => setAccepted(event.target.checked)}
          />
          {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!canSubmit}
              loading={busy}
              onClick={() => {
                const value = token.trim()
                onSubmit(value, accepted, host)
                setToken('')
              }}
            >
              Authorize notifications
            </Button>
            <Button disabled={busy} onClick={() => onOpenChange(false)} variant="secondary">
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The optional GitHub Notifications Center.
 *
 * It is a different thing from the pull request inbox and says so: the heading
 * names GitHub, the rows are GitHub's own threads with GitHub's reasons, and the
 * state line always carries the host the credential is pinned to. Nothing here
 * touches the pull request queue, and the module can be off, held off by policy,
 * or stripped of its credential while every pull request workflow keeps working.
 */
export function NotificationCenterView({
  busy,
  error,
  inbox,
  onDismissError,
  onMarkAllRead,
  onMarkDone,
  onMarkRead,
  onOpenCredential,
  onOpenThread,
  onRefresh,
  onRemoveCredential,
  onSubscribe,
}: {
  busy: boolean
  /** What a refused write left on the inbox itself, independent of the dialog. */
  error: string | null
  inbox: NotificationInbox | null
  onDismissError: () => void
  onMarkAllRead: () => void
  onMarkDone: (threadId: string) => void
  onMarkRead: (threadId: string) => void
  onOpenCredential: () => void
  onOpenThread: (thread: NotificationThread) => void
  onRefresh: () => void
  onRemoveCredential: () => void
  onSubscribe: (thread: NotificationThread, action: 'ignore' | 'unsubscribe') => void
}) {
  const status = inbox
  const state = status?.state ?? 'disabled'
  /** Consent has not been given, so this computer has not asked for a token. */
  const off = status !== null && state === 'disabled'
  /** A policy on this computer fixed the module off, whatever consent says. */
  const held = status !== null && state === 'policy-disabled'
  /**
   * The states a token of this module's own would move forward. Authorization is
   * offered only after this computer has agreed to the module: a person turns it
   * on in Settings, which says what the credential adds, and only then is a
   * token asked for. A stored token GitHub later refused is answered the same
   * way, because replacing it is the only way forward from there.
   */
  const needsCredential =
    status !== null && (state === 'credential-missing' || state === 'rejected')
  const canAuthorize = needsCredential && status.store.available !== false
  const tone = STATE_TONES[state]
  const polls = status !== null && state === 'ready'
  /**
   * A credential this module sealed away is discardable whatever the module's
   * own state is. A token GitHub refuses, or one kept while a policy holds the
   * module off, is exactly the credential a person most needs to be able to
   * remove, and removing it needs no GitHub to answer. So the control follows
   * the stored reference rather than whether polling is currently allowed.
   */
  const hasStoredCredential = status !== null && typeof status.reference === 'string'
  /**
   * GitHub can accept a bulk mark-read and finish it asynchronously, so the
   * threads on screen are still the last list it confirmed. The request is
   * never sent again while that is true, and the wait is announced rather than
   * shown as a completed change.
   */
  const awaitingConfirmation = polls && status.markAllReadPending === true

  return (
    <div className="diagnostics-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1 id={WORKSPACE_VIEW_HEADING_ID} tabIndex={-1}>
            GitHub Notifications
          </h1>
          <span className="list-subtitle">
            {status ? pollSubtitle(status) : 'Reading the module state…'}
            {polls
              ? ` · GitHub asks for at most one read every ${status.poll.pollIntervalSeconds}s`
              : ''}
            {polls && status.poll.nextPollAt
              ? ` · next read ${new Date(status.poll.nextPollAt).toLocaleTimeString()}`
              : ''}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {polls ? (
            <>
              <Button
                disabled={busy}
                onClick={onRefresh}
                size="sm"
                tooltip={`Ask GitHub for this inbox. GitHub asked to be polled no more than once every ${status.poll.pollIntervalSeconds}s, so a request before that returns the list it last confirmed.`}
                variant="accent"
              >
                {busy ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                Refresh
              </Button>
              <Button
                disabled={busy || status.unreadCount === 0 || awaitingConfirmation}
                onClick={onMarkAllRead}
                size="sm"
                tooltip={
                  awaitingConfirmation
                    ? 'GitHub accepted this change and has not confirmed it yet. It is never sent a second time; the next read shows what it actually did.'
                    : 'Mark every unread thread read on GitHub.'
                }
                variant="secondary"
              >
                Mark all read
              </Button>
            </>
          ) : null}
          {hasStoredCredential ? (
            <Button
              disabled={busy}
              onClick={onRemoveCredential}
              size="sm"
              tooltip="Remove this module's credential. Sign-in, pull requests, stacks, and reviews are untouched."
              variant="secondary"
            >
              <Trash2 className="size-3.5" />
              Remove credential
            </Button>
          ) : null}
        </div>
      </div>
      <div className="capability-scroll">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={BADGE_TONES[tone]}>{NOTIFICATION_STATE_LABELS[state]}</Badge>
          {status ? <Badge variant="outline">{status.host}</Badge> : null}
          {status && (hasStoredCredential || !off) ? (
            <Badge variant="outline">
              {status.login ?? 'unverified account'} ·{' '}
              {status.reference ? 'credential sealed' : 'no credential'}
            </Badge>
          ) : null}
          {status?.store.available === false ? <Badge variant="danger">No key store</Badge> : null}
        </div>
        {status?.message ? <InlineAlert tone={tone}>{status.message}</InlineAlert> : null}
        {error ? (
          <InlineAlert role="alert" title="That change was not confirmed" tone="error">
            <p className="m-0">{error}</p>
            <p className="m-0 mt-1">
              This app cannot tell from the answer alone whether GitHub applied it, so it says so
              rather than guessing. The change is not sent again; a refresh shows what GitHub holds.
            </p>
            <div className="mt-2">
              <Button onClick={onDismissError} size="sm" variant="secondary">
                Dismiss
              </Button>
            </div>
          </InlineAlert>
        ) : null}
        {held ? (
          <InlineAlert tone={tone} title="Held off by policy">
            A policy on this computer holds the Notification Center off. Every pull request, stack,
            and review workflow is unaffected.
          </InlineAlert>
        ) : null}
        {off ? (
          <InlineAlert tone={tone} title="This module is off">
            GitHub serves its notifications endpoints to a classic personal access token, not to a
            GitHub App credential. Turn it on in Settings › Notifications, which says what it adds
            before you turn it on; a token is only asked for after that, and the rest of the app
            keeps the permissions it already has either way.
          </InlineAlert>
        ) : null}
        {needsCredential ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!canAuthorize}
              onClick={onOpenCredential}
              tooltip="Explains the credential boundary in full before any token is entered."
            >
              {state === 'rejected' ? 'Replace the token' : 'Authorize notifications'}
            </Button>
          </div>
        ) : null}
        {polls && status.stale && status.staleReason ? (
          <InlineAlert
            tone="warning"
            title={`Stale · ${NOTIFICATION_STALE_LABELS[status.staleReason]}`}
          >
            What is on screen is the last thing GitHub confirmed
            {status.poll.fetchedAt ? ` (${new Date(status.poll.fetchedAt).toLocaleString()})` : ''}.
            It is not a live answer.
          </InlineAlert>
        ) : null}
        {awaitingConfirmation ? (
          <InlineAlert
            role="status"
            title="GitHub accepted this and is still finishing it"
            tone="info"
          >
            GitHub takes the whole-inbox change asynchronously, so it has not confirmed it yet.
            The rows below are still the last list GitHub confirmed, this request is not sent
            again, and the next read shows what it actually did.
          </InlineAlert>
        ) : null}
        {polls && status.threads.length > 0 ? (
          <div className="capability-list" role="list" aria-label="GitHub notification threads">
            {status.threads.map((thread) => (
              <NotificationRow
                busy={busy}
                key={thread.id}
                onMarkDone={onMarkDone}
                onMarkRead={onMarkRead}
                onOpen={onOpenThread}
                onSubscribe={onSubscribe}
                thread={thread}
              />
            ))}
          </div>
        ) : null}
        {polls && status.threads.length === 0 ? (
          <EmptyState className="compact-empty">
            <Bell className="empty-icon" />
            <h2>No notifications</h2>
            <p>
              {status.poll.fetchedAt
                ? 'GitHub has nothing waiting for you in this inbox.'
                : 'Nothing has been read yet. Refresh to ask GitHub for the first time.'}
            </p>
          </EmptyState>
        ) : null}
      </div>
    </div>
  )
}
