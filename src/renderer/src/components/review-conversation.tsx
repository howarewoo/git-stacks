import * as React from 'react'
import { useForm, useSelector, type ReactFormExtendedApi } from '@tanstack/react-form'
import { CheckCircle2, CircleDot, MessageSquarePlus, Trash2, TriangleAlert } from 'lucide-react'

import type { ReviewFileSet, ReviewLineRef } from '../../../shared/review'
import type {
  ReviewDraft,
  ReviewDraftRecord,
  ReviewDraftResolution,
  ReviewEvent,
  ReviewPermissions,
  ReviewThread,
  ReviewThreadRead,
} from '../../../shared/review-threads'
import {
  newReviewDraftId,
  REVIEW_EVENT_LABELS,
  REVIEW_EVENTS,
  reviewDraftKey,
  reviewDraftLabel,
  reviewEventBlocked,
  reviewThreadLabel,
  reviewThreadState,
  REVIEW_THREAD_STATE_LABELS,
} from '../../../shared/review-threads'
import type { DesktopAPI } from '../../../shared/types'
import { LIST_PAGE_SIZE } from '../../../shared/performance'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { RadioGroup, RadioGroupItem } from './ui/radio-group'
import { InlineAlert } from './ui/surface'
import { useListWindow } from '../lib/list-window'
import { ListWindowMore } from './list-window'
import { cn } from '../lib/utils'

/**
 * A line range the reviewer has picked to comment on.
 *
 * Selection is the two ends of a range rather than a browser text selection,
 * because GitHub addresses a comment by path, side, and line and a text
 * selection carries none of that. A single line is a range whose ends are equal.
 */
export interface ReviewSelection {
  path: string
  side: 'base' | 'head'
  anchor: number
  head: number
}

/** The line reference for one end of a selection, from the diff the reviewer is reading. */
export function selectionRef(
  files: ReviewFileSet | null,
  selection: ReviewSelection,
  which: 'anchor' | 'head',
): ReviewLineRef | null {
  if (!files) return null
  const wanted = selection[which]
  for (const file of files.files) {
    if (file.path !== selection.path || file.diff.kind !== 'text') continue
    for (const hunk of file.diff.hunks) {
      for (const line of hunk.lines) {
        if (line.side !== selection.side) continue
        const number = line.side === 'base' ? line.oldLine : line.newLine
        if (number !== wanted) continue
        return {
          path: file.path,
          side: line.side,
          line: number,
          hunkId: hunk.id,
          anchor: line.anchor,
          context: line.context,
        }
      }
    }
  }
  return null
}

/** The selection as an ordered range, so a range never runs backwards on the wire. */
function orderedEnds(
  files: ReviewFileSet | null,
  selection: ReviewSelection | null,
): { first: ReviewLineRef; last: ReviewLineRef } | null {
  if (selection === null) return null
  const anchor = selectionRef(files, selection, 'anchor')
  const head = selectionRef(files, selection, 'head')
  if (!anchor || !head) return null
  return selection.anchor <= selection.head
    ? { first: anchor, last: head }
    : { first: head, last: anchor }
}

function readableError(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = value.message
    if (typeof message === 'string' && message !== '') return message
  }
  return 'The review could not be sent to GitHub.'
}

/**
 * Whether a failure left the write in a state that must not simply be retried.
 *
 * The error's own name is what the main process set on the two errors that
 * mean "Git Stacks cannot tell whether this landed". Anything else — a refusal,
 * a stale anchor, a permissions block — is a decision the reviewer can act on
 * and re-send after fixing, so the button comes back.
 */
function isUncertainOutcome(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null || !('name' in cause)) return false
  const name = (cause as { name?: unknown }).name
  return name === 'ReviewOutcomeUnknownError' || name === 'ReviewWriteUncertainError'
}

/**
 * What one submit carries that no draft holds: the decision and its summary.
 * The drafts themselves stay repository-owned records written through
 * `onDraftChange`, so nothing here is a second copy of a reviewer's words.
 */
type ReviewSubmitValues = { event: ReviewEvent; summary: string }

/** A fresh review: a plain comment with no words of its own yet. */
const REVIEW_SUBMIT_DEFAULTS: ReviewSubmitValues = { event: 'COMMENT', summary: '' }

/** The submit form as it reaches the bar that renders its fields. */
type ReviewSubmitForm = ReactFormExtendedApi<
  ReviewSubmitValues,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  unknown
>

export interface ReviewConversationProps {
  desktop: DesktopAPI | undefined
  number: number
  files: ReviewFileSet | null
  read: ReviewThreadRead | null
  readState: 'loading' | 'ready' | 'failed'
  readError: string | null
  drafts: ReviewDraftRecord | null
  resolutions: ReviewDraftResolution[]
  selection: ReviewSelection | null
  onSelect: (selection: ReviewSelection) => void
  onClearSelection: () => void
  onDraftChange: (drafts: ReviewDraft[]) => void
  onReload: () => void
  frozenReason?: string | null
}

export function ReviewConversation({
  desktop,
  number,
  files,
  read,
  readState,
  readError,
  drafts,
  resolutions,
  selection,
  onSelect,
  onClearSelection,
  onDraftChange,
  onReload,
  frozenReason = null,
}: ReviewConversationProps) {
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const draftList = drafts?.drafts ?? []
  const byId = React.useMemo(
    () => new Map(resolutions.map((entry) => [entry.id, entry])),
    [resolutions],
  )
  // Every draft with words is submitted or none is. Filtering the unresolved
  // ones out here would make the backend unable to enforce its whole-review
  // refusal, and the clear on success would then take the unresolved draft with
  // them — the one comment that was never sent would be the one deleted.
  const intended = draftList.filter((draft) => draft.body.trim() !== '')
  const sendable = intended.filter((draft) => byId.get(draft.id)?.match !== 'unresolved')
  const stale = draftList.filter((draft) => byId.get(draft.id)?.match === 'unresolved')
  // A draft that cannot be sent where it was written blocks the whole review, and
  // says so, rather than being quietly left behind by a successful submit.
  const blockedByStale = stale.length > 0
  const rawPermissions: ReviewPermissions | null = read?.permissions ?? null
  const permissions: ReviewPermissions | null = frozenReason
    ? {
        viewer: rawPermissions?.viewer ?? '',
        isAuthor: rawPermissions?.isAuthor ?? false,
        state: rawPermissions?.state ?? 'OPEN',
        permission: rawPermissions?.permission ?? 'WRITE',
        blocked: { COMMENT: frozenReason, APPROVE: frozenReason, REQUEST_CHANGES: frozenReason },
      }
    : rawPermissions
  // An uncertain outcome outlives the message that reported it, so the guard is
  // this component's own state as well as the backend's: while it is set, the
  // button stays dead even though the drafts and the error are still here.
  const [uncertain, setUncertain] = React.useState(false)

  const form: ReviewSubmitForm = useForm({
    defaultValues: REVIEW_SUBMIT_DEFAULTS,
    onSubmit: async ({ value, formApi }): Promise<void> => {
      if (!desktop?.reviewSubmit || intended.length === 0) return
      if (blockedByStale || uncertain || Boolean(frozenReason)) return
      if (!files) {
        setError('The diff has to be loaded before a review can be sent.')
        return
      }
      setError(null)
      setNotice(null)
      try {
        const result = await desktop.reviewSubmit(number, {
          event: value.event,
          body: value.summary,
          // The whole intended review, including anything the backend will refuse.
          // It decides atomicity itself; the view must not decide it by omission.
          drafts: intended,
          // The comparison the diff on screen was read at, so a pull request that
          // moved since is refused rather than re-anchored onto a new revision.
          comparison: files.comparison,
        })
        setUncertain(false)
        // Only the summary that reached GitHub is retired. A refused write keeps
        // the body in the box so it can be corrected and sent again.
        formApi.setFieldValue('summary', '')
        // A recovery adopts what GitHub already holds, and reports which drafts
        // that was. Only those are dropped: the drafts that never went anywhere
        // are still the reviewer's unsent work and stay pending.
        const delivered = new Set(result.delivered ?? [])
        onDraftChange(
          delivered.size === 0 ? [] : draftList.filter((draft) => !delivered.has(draft.id)),
        )
        onReload()
        setNotice(
          `Sent one ${REVIEW_EVENT_LABELS[value.event].toLowerCase()} review with ${intended.length} comment${
            intended.length === 1 ? '' : 's'
          }${result.state ? `; GitHub recorded it as ${result.state}` : ''}.`,
        )
      } catch (cause) {
        setError(readableError(cause))
        // An outcome GitHub never confirmed leaves the write in doubt, so the
        // button stays disabled for this session too. The backend refuses the
        // same write after a reload; this keeps the two consistent meanwhile.
        setUncertain(isUncertainOutcome(cause))
      }
    },
  })
  const sending = useSelector(form.store, (state) => state.isSubmitting)

  // Draft identities are minted where a draft is composed, not derived from
  // where the comment sits and not counted from what the journal last held.
  // The same line carrying the same words is one draft the first time and a
  // different one every time after, and a settled record has to be able to tell
  // those apart — including when the second one is written in another window,
  // which read this same journal and would have counted from it as well. A
  // generated name is unique where it is made, so nothing has to be allocated,
  // persisted, or reclaimed for it to stay unique.

  const addDraft = () => {
    const ends = orderedEnds(files, selection)
    if (!ends) return
    const startRef = ends.first.line === ends.last.line ? null : ends.first
    const range = reviewDraftKey(ends.last, startRef)
    const draft: ReviewDraft = {
      id: newReviewDraftId(),
      ref: ends.last,
      startRef,
      body: '',
      createdAt: new Date().toISOString(),
    }
    // One pending comment per range: a second comment on lines that already have
    // one would submit as two threads the reviewer never meant to write. That is
    // about the range; the identity above is about this composition of it.
    onDraftChange([
      ...draftList.filter((entry) => reviewDraftKey(entry.ref, entry.startRef) !== range),
      draft,
    ])
    onClearSelection()
  }

  return (
    <section className="review-conversation" aria-label="Review conversation">
      <div className="review-tree-header">
        <strong>Review</strong>
        <span className="code-region-meta">
          {draftList.length} pending · {read?.threads.threads.length ?? 0} submitted
        </span>
      </div>

      {frozenReason ? (
        <InlineAlert className="review-conversation-alert" tone="info" role="status">
          {frozenReason}
        </InlineAlert>
      ) : null}

      <SelectionComposer
        selection={selection}
        disabled={sending || Boolean(frozenReason)}
        onAdd={addDraft}
        onClear={onClearSelection}
      />

      <DraftList
        drafts={draftList}
        byId={byId}
        staleCount={stale.length}
        disabled={sending || Boolean(frozenReason)}
        onChangeBody={(id, body) =>
          onDraftChange(draftList.map((draft) => (draft.id === id ? { ...draft, body } : draft)))
        }
        onRemove={(id) => onDraftChange(draftList.filter((draft) => draft.id !== id))}
      />

      <SubmitBar
        form={form}
        permissions={permissions}
        intendedCount={intended.length}
        staleCount={stale.length}
        uncertain={uncertain}
      />

      {error ? (
        <InlineAlert className="review-conversation-alert" tone="warning" role="status">
          {error}
        </InlineAlert>
      ) : null}
      {notice ? (
        <InlineAlert className="review-conversation-alert" tone="info" role="status">
          {notice}
        </InlineAlert>
      ) : null}

      <ThreadList
        desktop={desktop}
        number={number}
        read={read}
        state={readState}
        error={readError}
        onReload={onReload}
        onSelect={onSelect}
      />
    </section>
  )
}

function SelectionComposer({
  selection,
  disabled,
  onAdd,
  onClear,
}: {
  selection: ReviewSelection | null
  disabled: boolean
  onAdd: () => void
  onClear: () => void
}) {
  if (!selection) {
    return (
      <p className="review-conversation-note">
        <MessageSquarePlus aria-hidden="true" className="size-3.5" />
        Choose a line in the diff to comment on it. Choose a second line on the same side to comment
        on a range.
      </p>
    )
  }
  const low = Math.min(selection.anchor, selection.head)
  const high = Math.max(selection.anchor, selection.head)
  const label = `${selection.path}:${low === high ? low : `${low}–${high}`} (${selection.side})`
  return (
    <div className="review-selection" role="group" aria-label="Selected lines">
      <span className="review-selection-label">{label}</span>
      <div className="review-selection-actions">
        <Button disabled={disabled} size="sm" variant="accent" onClick={onAdd}>
          Add pending comment
        </Button>
        <Button disabled={disabled} size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  )
}

function DraftList({
  drafts,
  byId,
  staleCount,
  disabled,
  onChangeBody,
  onRemove,
}: {
  drafts: ReviewDraft[]
  byId: Map<string, ReviewDraftResolution>
  staleCount: number
  disabled: boolean
  onChangeBody: (id: string, body: string) => void
  onRemove: (id: string) => void
}) {
  if (drafts.length === 0) {
    return (
      <p className="review-conversation-note">
        No pending comments. Nothing here has been sent to GitHub.
      </p>
    )
  }
  return (
    <div className="review-drafts" role="group" aria-label="Pending comments not yet sent">
      <p className="review-drafts-caption">
        <Badge variant="outline">pending, not sent</Badge>
        <span>
          Composed locally and submitted together as one review
          {staleCount > 0
            ? `. ${staleCount} cannot be sent until it names a line again.`
            : '. They survive leaving this workspace.'}
        </span>
      </p>
      <ul className="review-draft-list">
        {drafts.map((draft) => {
          const resolution = byId.get(draft.id)
          const isStale = resolution?.match === 'unresolved'
          return (
            <li className={cn('review-draft', isStale && 'review-draft-stale')} key={draft.id}>
              <div className="review-draft-head">
                <code>{reviewDraftLabel(draft)}</code>
                {isStale ? <Badge variant="warning">outdated</Badge> : null}
                {resolution?.match === 'moved' ? <Badge variant="secondary">moved</Badge> : null}
                <Button
                  aria-label={`Discard pending comment on ${reviewDraftLabel(draft)}`}
                  disabled={disabled}
                  size="icon-sm"
                  tooltip="Discard this pending comment"
                  variant="ghost"
                  onClick={() => onRemove(draft.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              {isStale ? (
                <p className="review-draft-reason">
                  {resolution?.reason} It is not sent while it does not name the line it was written
                  about.
                </p>
              ) : null}
              <Textarea
                aria-label={`Comment on ${reviewDraftLabel(draft)}`}
                disabled={disabled}
                onChange={(event) => onChangeBody(draft.id, event.target.value)}
                placeholder="What should the author know about these lines?"
                rows={3}
                value={draft.body}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function SubmitBar({
  form,
  permissions,
  intendedCount,
  staleCount,
  uncertain,
}: {
  form: ReviewSubmitForm
  permissions: ReviewPermissions | null
  intendedCount: number
  staleCount: number
  uncertain: boolean
}) {
  const busy = useSelector(form.store, (state) => state.isSubmitting)
  return (
    <form
      className="review-submit"
      role="group"
      aria-label="Submit review"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault()
        submitEvent.stopPropagation()
        void form.handleSubmit()
      }}
    >
      <form.Field
        name="summary"
        validators={{
          // GitHub explains a review event in words the backend sends, so a
          // request for changes without them is a review nobody can read. The
          // rule reads the sibling field, which is why it listens to it: picking
          // that decision re-checks this box instead of waiting for a keystroke.
          onChange: ({ value, fieldApi }) =>
            fieldApi.form.state.values.event === 'REQUEST_CHANGES' && value.trim() === ''
              ? 'Requesting changes needs a summary saying what must change.'
              : undefined,
          onChangeListenTo: ['event'],
        }}
      >
        {(summary) => (
          <form.Field name="event">
            {(event) => {
              const summaryProblem = summary.state.meta.errors[0] ?? null
              const blocked = reviewEventBlocked(permissions, event.state.value)
              // A stale draft blocks the review rather than being left out of it,
              // and an uncertain write blocks it because sending the same words
              // twice is worse than sending none. Both say why instead of just
              // going dead.
              const disabled =
                busy ||
                intendedCount === 0 ||
                blocked !== null ||
                summaryProblem !== null ||
                staleCount > 0 ||
                uncertain
              const reason =
                blocked ??
                (uncertain
                  ? 'This review was sent but Git Stacks never heard back, and GitHub does not have it, so it is held rather than sent again. Submitting checks GitHub first, so nothing is posted twice.'
                  : (summaryProblem ??
                    (staleCount > 0
                      ? `${staleCount} pending comment${staleCount === 1 ? '' : 's'} no longer names a line in this diff, so the whole review is held. Reopen it or remove ${staleCount === 1 ? 'it' : 'them'} first.`
                      : intendedCount === 0
                        ? 'Write at least one pending comment first.'
                        : `Submit ${intendedCount} comment${intendedCount === 1 ? '' : 's'} as one ${
                            REVIEW_EVENT_LABELS[event.state.value]
                          } review.`)))
              return (
                <>
                  <label className="review-submit-summary">
                    <span>Review summary</span>
                    <Textarea
                      aria-label="Review summary"
                      disabled={busy}
                      name={summary.name}
                      onBlur={summary.handleBlur}
                      onChange={(changeEvent) => summary.handleChange(changeEvent.target.value)}
                      placeholder="Optional for a comment; required when requesting changes."
                      rows={2}
                      value={summary.state.value}
                    />
                  </label>
                  <RadioGroup
                    aria-label="Review decision"
                    className="review-submit-events"
                    onValueChange={(next) => {
                      // The group is string-typed, so the cast is narrowed back
                      // to the three decisions the radio rows actually offer.
                      event.handleChange(next as ReviewEvent)
                    }}
                    value={event.state.value}
                  >
                    {REVIEW_EVENTS.map((candidate) => {
                      const candidateReason = reviewEventBlocked(permissions, candidate)
                      return (
                        <RadioGroupItem
                          className={cn(
                            'review-submit-event',
                            candidateReason && 'review-submit-event-blocked',
                          )}
                          disabled={busy}
                          key={candidate}
                          title={candidateReason ?? REVIEW_EVENT_LABELS[candidate]}
                          value={candidate}
                        >
                          {REVIEW_EVENT_LABELS[candidate]}
                        </RadioGroupItem>
                      )
                    })}
                  </RadioGroup>
                  <Button
                    disabled={disabled}
                    size="sm"
                    tooltip={reason}
                    type="submit"
                    variant="accent"
                  >
                    {busy
                      ? 'Sending…'
                      : `Submit ${intendedCount} comment${intendedCount === 1 ? '' : 's'} as one review`}
                  </Button>
                  <p className="review-submit-reason">{reason}</p>
                </>
              )
            }}
          </form.Field>
        )}
      </form.Field>
    </form>
  )
}

function ThreadList({
  desktop,
  number,
  read,
  state,
  error,
  onReload,
  onSelect,
}: {
  desktop: DesktopAPI | undefined
  number: number
  read: ReviewThreadRead | null
  state: 'loading' | 'ready' | 'failed'
  error: string | null
  onReload: () => void
  onSelect: (selection: ReviewSelection) => void
}) {
  const threads = read?.threads.threads ?? []
  const window_ = useListWindow(threads, LIST_PAGE_SIZE)
  const [replyFor, setReplyFor] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  // Threads whose last write left GitHub's answer unknown. A reply is its own
  // comment, so a repeat is a second comment rather than a harmless repeat, and
  // the words stay in the box while the button is held.
  const [uncertain, setUncertain] = React.useState<ReadonlySet<string>>(new Set())

  const replyForm = useForm({
    defaultValues: { body: '' },
    onSubmitMeta: { threadId: '' },
    onSubmit: async ({ value, formApi, meta }): Promise<void> => {
      const threadId = meta.threadId
      if (!desktop?.reviewReply || uncertain.has(threadId)) return
      setActionError(null)
      try {
        await desktop.reviewReply(number, threadId, value.body)
        // Only what GitHub accepted is cleared: a refused write keeps the words
        // in the box so the same reply can be corrected and sent again.
        formApi.resetField('body')
        setReplyFor(null)
        onReload()
      } catch (cause) {
        setActionError(readableError(cause))
        if (isUncertainOutcome(cause)) {
          setUncertain((current) => new Set([...current, threadId]))
        }
      }
    },
  })
  const replying = useSelector(replyForm.store, (state) => state.isSubmitting)

  const toggleResolved = async (thread: ReviewThread) => {
    if (!desktop?.reviewSetResolved) return
    setBusy(thread.id)
    setActionError(null)
    try {
      await desktop.reviewSetResolved(number, thread.id, !thread.resolved)
      onReload()
    } catch (cause) {
      setActionError(readableError(cause))
    } finally {
      setBusy(null)
    }
  }

  if (state === 'loading') {
    return (
      <p className="section-empty" role="status">
        Loading the conversation from GitHub…
      </p>
    )
  }
  if (state === 'failed' || !read) {
    return (
      <div className="review-conversation-threads">
        <p className="section-empty">
          {error ?? 'The conversation could not be read from GitHub.'}
        </p>
        <Button size="sm" variant="secondary" onClick={onReload}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="review-conversation-threads">
      <div className="review-conversation-threads-head">
        <strong>Submitted</strong>
        {read.threads.truncated ? (
          <span className="code-region-meta">
            showing {threads.length} of {read.threads.totalCount}
          </span>
        ) : null}
      </div>
      {actionError ? (
        <InlineAlert className="review-conversation-alert" tone="warning" role="status">
          {actionError}
        </InlineAlert>
      ) : null}
      {threads.length === 0 ? (
        <p className="section-empty">GitHub holds no review comments on this pull request yet.</p>
      ) : (
        <>
          <ul className="review-thread-list" aria-label="Submitted review threads">
            {window_.visible.map((thread) => (
              <li className="review-thread" key={thread.id}>
                <ThreadHeader thread={thread} onSelect={onSelect} />
                <ul className="review-thread-comments">
                  {thread.comments.map((comment) => (
                    <li key={comment.id}>
                      <span className="review-thread-comment-head">
                        <strong>{comment.author}</strong>
                        {comment.viewerDidAuthor ? <Badge variant="outline">you</Badge> : null}
                        {comment.createdAt ? <small>{comment.createdAt.slice(0, 10)}</small> : null}
                      </span>
                      <p>{comment.body}</p>
                    </li>
                  ))}
                </ul>
                <div className="review-thread-actions">
                  {thread.viewerCanResolve && !thread.resolved ? (
                    <Button
                      disabled={busy === thread.id || (replying && replyFor === thread.id)}
                      size="sm"
                      variant="secondary"
                      onClick={() => void toggleResolved(thread)}
                    >
                      Resolve
                    </Button>
                  ) : null}
                  {thread.viewerCanUnresolve && thread.resolved ? (
                    <Button
                      disabled={busy === thread.id || (replying && replyFor === thread.id)}
                      size="sm"
                      variant="secondary"
                      onClick={() => void toggleResolved(thread)}
                    >
                      Reopen
                    </Button>
                  ) : null}
                  {thread.viewerCanReply ? (
                    <Button
                      disabled={busy === thread.id || (replying && replyFor === thread.id)}
                      size="sm"
                      variant="ghost"
                      onClick={() => setReplyFor(replyFor === thread.id ? null : thread.id)}
                    >
                      Reply
                    </Button>
                  ) : null}
                </div>
                {replyFor === thread.id ? (
                  <form
                    className="review-thread-reply"
                    onSubmit={(submitEvent) => {
                      submitEvent.preventDefault()
                      submitEvent.stopPropagation()
                      void replyForm.handleSubmit({ threadId: thread.id })
                    }}
                  >
                    <replyForm.Field name="body">
                      {(body) => (
                        <>
                          <Textarea
                            aria-label={`Reply to ${reviewThreadLabel(thread)}`}
                            disabled={busy === thread.id || (replying && replyFor === thread.id)}
                            name={body.name}
                            onBlur={body.handleBlur}
                            onChange={(changeEvent) => body.handleChange(changeEvent.target.value)}
                            placeholder="Reply to this thread"
                            rows={3}
                            value={body.state.value}
                          />
                          <Button
                            disabled={
                              replying || body.state.value.trim() === '' || uncertain.has(thread.id)
                            }
                            size="sm"
                            tooltip={
                              uncertain.has(thread.id)
                                ? 'This reply was sent but Git Stacks never heard back, and GitHub does not have it, so it is held rather than sent again. Sending checks the thread first, so nothing is posted twice.'
                                : undefined
                            }
                            type="submit"
                            variant="accent"
                          >
                            {replying ? 'Sending…' : 'Send reply'}
                          </Button>
                        </>
                      )}
                    </replyForm.Field>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <ListWindowMore
            noun="threads"
            pageSize={LIST_PAGE_SIZE}
            previous={window_.hasPrevious}
            remaining={window_.remaining}
            onReveal={window_.reveal}
            onPrevious={window_.retreat}
          />
        </>
      )}
    </div>
  )
}

function ThreadHeader({
  thread,
  onSelect,
}: {
  thread: ReviewThread
  onSelect: (selection: ReviewSelection) => void
}) {
  const state = reviewThreadState(thread)
  return (
    <div className="review-thread-head">
      <code>{reviewThreadLabel(thread)}</code>
      <Badge
        variant={state === 'resolved' ? 'success' : state === 'outdated' ? 'warning' : 'secondary'}
      >
        {state === 'resolved' ? (
          <CheckCircle2 aria-hidden="true" className="size-3" />
        ) : (
          <CircleDot aria-hidden="true" className="size-3" />
        )}
        {REVIEW_THREAD_STATE_LABELS[state]}
      </Badge>
      {/* Resolved and outdated are independent facts about one thread, and a
          push can make an already-resolved thread outdated. The state above
          names one of them, so a thread that is both says so rather than
          letting the reader assume its line is still there. */}
      {state === 'resolved' && thread.outdated ? (
        <Badge variant="warning">
          <TriangleAlert aria-hidden="true" className="size-3" />
          outdated
        </Badge>
      ) : null}
      {thread.fileLevel || thread.line === null || thread.side === null ? null : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const side = thread.side
            const line = thread.line
            if (side === null || line === null) return
            onSelect({
              path: thread.path,
              side,
              anchor: thread.startLine ?? line,
              head: line,
            })
          }}
        >
          Show in diff
        </Button>
      )}
    </div>
  )
}
