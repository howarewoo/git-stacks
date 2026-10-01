import { getSnapshot } from '../../../src/main/git'
import { originRemote, readReviewFilesFrom } from '../../../src/main/review'
import {
  readReviewThreads,
  replyToThread,
  ReviewComparisonMovedError,
  ReviewOutcomeUnknownError,
  setThreadResolved,
  submitReview,
} from '../../../src/main/review-threads'
import { setGitHubTransport, type GitHubTransport } from '../../../src/main/github-transport'
import type { ReviewThread } from '../../../src/shared/review-threads'
import { pushCommit, pushLayer } from '../layers'
import { anchorsFrom, assert, rangeAnchorFrom, type LiveScenario } from '../scenario'
import type { ReviewDraft } from '../../../src/shared/review-threads'

/** The changed file every review scenario anchors on. */
const REVIEW_FILE = 'review-surface.txt'

const REVIEW_BODY = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'].join(
  '\n',
)

/** One layer with a diff wide enough to anchor a single line and a range on. */
async function reviewLayer(ctx: Parameters<LiveScenario['run']>[0], prefix: string) {
  return pushLayer(ctx, {
    branch: `${prefix}-layer`,
    parent: `origin/${ctx.target.defaultBranch}`,
    base: ctx.target.defaultBranch,
    file: REVIEW_FILE,
    contents: `${REVIEW_BODY}\nindia\njuliett\n`,
    message: `${prefix}: a reviewable change`,
  })
}

/**
 * The first thread the host reports for this pull request, or a failure naming why not.
 *
 * A thread read as a second account is not the same read: `viewerDidAuthor` is decided
 * by who is asking, so the account is signed in for the read and restored afterwards,
 * which is the only way to prove a comment belongs to the account that wrote it.
 */
async function firstThread(
  ctx: Parameters<LiveScenario['run']>[0],
  number: number,
  as?: GitHubTransport,
): Promise<ReviewThread> {
  const author = ctx.transport
  if (as !== undefined) setGitHubTransport(as)
  try {
    const read = await readReviewThreads(ctx.workspace.path, number)
    const thread = read.threads.threads[0]
    assert(
      thread !== undefined,
      `the host reported no review thread for #${number} after a review was submitted`,
    )
    return thread
  } finally {
    if (as !== undefined) setGitHubTransport(author)
  }
}

export const reviewScenarios: readonly LiveScenario[] = [
  {
    id: 'reviews/single-line-comment',
    title: 'a single-line comment lands on the line the reviewer chose',
    requires: ['reviewThreads'],
    async run(ctx) {
      const layer = await reviewLayer(ctx, 'review-single')
      const remote = await originRemote(ctx.workspace.path)
      const files = await readReviewFilesFrom(remote, layer.number)
      const draft = anchorsFrom(files, REVIEW_FILE)[0]
      ctx.log(`anchored ${REVIEW_FILE}:${draft.ref.line} from the read diff`)

      const result = await submitReview(ctx.workspace.path, layer.number, {
        event: 'COMMENT',
        body: 'One line, chosen from the diff that was actually shown.',
        drafts: [draft],
        comparison: files.comparison,
      })
      // The recorded outcome, not the verb the request carried: a host that echoed
      // `COMMENT` back would leave every reconciliation unable to recognise a settled
      // review as the one it had sent.
      assert(
        result.state === 'COMMENTED',
        `the host recorded the review as ${result.state} rather than COMMENTED`,
      )

      const thread = await firstThread(ctx, layer.number)
      assert(thread.path === REVIEW_FILE, `the thread is on ${thread.path}, not ${REVIEW_FILE}`)
      assert(
        thread.line === draft.ref.line,
        `the thread is on line ${thread.line}, not the reviewed line ${draft.ref.line}`,
      )
      assert(thread.startLine === null, 'a single-line comment came back as a range')
      assert(thread.comments.length === 1, `the thread holds ${thread.comments.length} comments`)
    },
  },
  {
    id: 'reviews/multi-line-range',
    title: 'a multi-line range keeps both of its ends',
    requires: ['reviewThreads'],
    async run(ctx) {
      const layer = await reviewLayer(ctx, 'review-range')
      const remote = await originRemote(ctx.workspace.path)
      const files = await readReviewFilesFrom(remote, layer.number)
      const { start, end } = rangeAnchorFrom(files, REVIEW_FILE)
      const ranged: ReviewDraft = { ...start, startRef: start.ref, ref: end.ref, body: 'A range.' }
      ctx.log(`ranged ${REVIEW_FILE}:${start.ref.line}-${end.ref.line}`)

      await submitReview(ctx.workspace.path, layer.number, {
        event: 'COMMENT',
        body: 'A range over two added lines.',
        drafts: [ranged],
        comparison: files.comparison,
      })

      const thread = await firstThread(ctx, layer.number)
      assert(
        thread.startLine === start.ref.line && thread.line === end.ref.line,
        `the range came back as ${String(thread.startLine)}-${String(thread.line)}, not ${start.ref.line}-${end.ref.line}`,
      )
    },
  },
  {
    id: 'reviews/reply-threads-one-conversation',
    title: 'a reply joins the thread instead of starting a second one',
    requires: ['reviewThreads'],
    async run(ctx) {
      const layer = await reviewLayer(ctx, 'review-reply')
      const remote = await originRemote(ctx.workspace.path)
      const files = await readReviewFilesFrom(remote, layer.number)
      await submitReview(ctx.workspace.path, layer.number, {
        event: 'COMMENT',
        body: 'Please look at this line.',
        drafts: anchorsFrom(files, REVIEW_FILE).slice(0, 1),
        comparison: files.comparison,
      })
      const thread = await firstThread(ctx, layer.number)

      const reply = await replyToThread(
        ctx.workspace.path,
        layer.number,
        thread.id,
        'Answering the question in the thread.',
      )
      assert(reply.state === 'created', `the reply reported ${reply.state}`)

      const after = await readReviewThreads(ctx.workspace.path, layer.number)
      assert(
        after.threads.totalCount === 1,
        `a reply opened a second thread; the host reports ${after.threads.totalCount}`,
      )
      const answered = after.threads.threads.find((entry) => entry.id === thread.id)
      assert(answered !== undefined, 'the original thread disappeared after the reply')
      assert(
        answered.comments.length === 2,
        `the thread holds ${answered.comments.length} comments after one reply, not 2`,
      )
    },
  },
  {
    id: 'reviews/a-lost-review-write-is-reconciled-from-a-later-page',
    title:
      'a review whose answer was lost is reconciled out of a page the read has to follow to reach',
    requires: ['reviewThreads'],
    async run(ctx) {
      const layer = await reviewLayer(ctx, 'review-lost-multipage')
      const files = await readReviewFilesFrom(await originRemote(ctx.workspace.path), layer.number)

      // GitHub pages the review list, and production asks for a hundred at a time. Enough
      // earlier reviews that the review this case loses is not on the first page it is sent
      // for: a reader that never follows the host's next link finds nothing and reports the
      // write as undelivered, leaving the comment to be sent a second time on the next
      // attempt. These are real reviews on the host, written through the documented
      // endpoint, and none of them carries a comment.
      const page = 100
      for (let at = 0; at < page; at += 1) {
        const written = await ctx.transport.rest<{ id?: number }>({
          method: 'POST',
          path: `repos/${ctx.repository}/pulls/${layer.number}/reviews`,
          body: {
            body: `A review that only makes the history longer. ${at}`,
            event: 'COMMENT',
            commit_id: layer.headSha,
          },
        })
        assert(
          typeof written.data.id === 'number',
          `the host accepted filler review ${at} without giving it an id`,
        )
      }

      const summary = 'A comment sent once, whatever the network or the page count does.'
      const drafts = anchorsFrom(files, REVIEW_FILE).slice(0, 1)
      const send = (): Promise<unknown> =>
        submitReview(ctx.workspace.path, layer.number, {
          event: 'COMMENT',
          body: summary,
          drafts,
          comparison: files.comparison,
        }).then(
          () => null,
          (error: unknown) => error,
        )

      // The mutation really reaches the host and the host really applies it; only the
      // answer is discarded.
      ctx.faults.loseOnce({
        method: 'POST',
        pathIncludes: `repos/${ctx.repository}/pulls/${layer.number}/reviews`,
      })
      const first = await send()
      assert(
        first === null || first instanceof ReviewOutcomeUnknownError,
        `the lost review surfaced as ${String(first)}, which is neither a delivery nor an unknown outcome`,
      )

      // The retry is what walks the history. It has to reach past the page the earlier
      // reviews filled to find this one.
      const second = await send()
      assert(
        first === null || second === null,
        `the retry after an unknown outcome failed: ${String(second)}`,
      )

      // What the host holds is the whole claim: the review, who wrote it, what it recorded
      // as its decision, and the one comment inside it. The read follows the same pages the
      // host pages this list into, because the review being looked for is deliberately not
      // on the first of them — a read that stopped at page one would report nothing here
      // however well the reconciliation itself worked.
      const mine: { id?: number; user?: unknown; state?: unknown; body?: unknown }[] = []
      for (let at = 1; ; at += 1) {
        const held = await ctx.transport.rest<
          { id?: number; user?: unknown; state?: unknown; body?: unknown }[]
        >({
          method: 'GET',
          path: `repos/${ctx.repository}/pulls/${layer.number}/reviews?per_page=${page}&page=${at}`,
        })
        const rows = Array.isArray(held.data) ? held.data : []
        mine.push(...rows.filter((review) => review.body === summary))
        if (rows.length < page) break
      }
      assert(
        mine.length === 1,
        `the host holds ${mine.length} reviews with the sent summary across ${page}-sized pages, not 1`,
      )
      const recorded = mine[0] as { id: number; state?: unknown; user?: { login?: unknown } }
      assert(
        typeof recorded.id === 'number' && recorded.id > page,
        `the reconciled review is #${String(recorded.id)}, which is not past the ${page} reviews before it`,
      )
      assert(
        recorded.state === 'COMMENTED',
        `the review the host recorded says ${String(recorded.state)} rather than COMMENTED`,
      )
      assert(
        recorded.user?.login === ctx.target.primary.login,
        `the reconciled review is attributed to ${String(recorded.user?.login)} rather than to this account`,
      )

      const comments = await ctx.transport.rest<{ id?: unknown; body?: unknown }[]>({
        method: 'GET',
        path: `repos/${ctx.repository}/pulls/${layer.number}/comments`,
      })
      const carried = (Array.isArray(comments.data) ? comments.data : []).filter(
        (comment) => comment.body === drafts[0]?.body,
      )
      assert(
        carried.length === 1,
        `the host holds ${carried.length} copies of the reconciled review's comment, not 1`,
      )
      ctx.log(
        `review #${recorded.id} was reconciled from the page after ${page} earlier reviews, with one comment and no duplicate`,
      )
    },
  },
  {
    id: 'reviews/reply-after-lost-response-is-not-duplicated',
    title: 'a reply whose answer was lost is reconciled, never written twice',
    requires: ['reviewThreads'],
    async run(ctx) {
      const layer = await reviewLayer(ctx, 'review-lost-reply')
      const remote = await originRemote(ctx.workspace.path)
      const files = await readReviewFilesFrom(remote, layer.number)
      await submitReview(ctx.workspace.path, layer.number, {
        event: 'COMMENT',
        body: 'A thread to answer.',
        drafts: anchorsFrom(files, REVIEW_FILE).slice(0, 1),
        comparison: files.comparison,
      })
      const thread = await firstThread(ctx, layer.number)
      const body = 'This reply is sent once, whatever the network does.'

      // The same words, sent again. The journal is what stops this, and the only
      // thing worth asserting is what the host ends up holding. Each send answers
      // with the failure it raised, or null when it went through.
      const sendReply = (text: string) =>
        replyToThread(ctx.workspace.path, layer.number, thread.id, text).then(
          () => null,
          (error: unknown) => error,
        )

      // The mutation really reaches the host and the host really applies it; only the
      // answer is discarded. The product then either reconciles the reply from the
      // thread it can read back, or reports an unknown outcome and leaves the journal
      // to do that on the next attempt. A silent success that left two copies on the
      // host is the only answer this fails.
      ctx.faults.loseOnce({ method: 'POST', pathIncludes: 'ReplyToReviewThread' })
      const attempted = await sendReply(body)
      assert(
        attempted === null || attempted instanceof ReviewOutcomeUnknownError,
        `the lost reply surfaced as ${String(attempted)}, which is neither a reconciliation nor an unknown outcome`,
      )
      const settled = attempted === null ? null : await sendReply(body)
      assert(
        attempted === null || settled === null,
        `the retry after an unknown outcome failed: ${String(settled)}`,
      )

      const after = await readReviewThreads(ctx.workspace.path, layer.number)
      const answered = after.threads.threads.find((entry) => entry.id === thread.id)
      assert(answered !== undefined, 'the original thread disappeared')
      const copies = answered.comments.filter((comment) => comment.body === body)
      assert(
        copies.length === 1,
        `the host holds ${copies.length} copies of the retried reply, not 1`,
      )
      ctx.log('one copy of the retried reply is on the host')
    },
  },
  {
    id: 'reviews/resolve-and-unresolve',
    title: 'a thread is resolved and reopened, and the host reports each state',
    requires: ['reviewThreads'],
    async run(ctx) {
      const layer = await reviewLayer(ctx, 'review-resolve')
      const remote = await originRemote(ctx.workspace.path)
      const files = await readReviewFilesFrom(remote, layer.number)
      await submitReview(ctx.workspace.path, layer.number, {
        event: 'COMMENT',
        body: 'To be resolved.',
        drafts: anchorsFrom(files, REVIEW_FILE).slice(0, 1),
        comparison: files.comparison,
      })
      const thread = await firstThread(ctx, layer.number)
      assert(!thread.resolved, 'a freshly created thread is already resolved')
      assert(thread.viewerCanResolve, 'this account may not resolve the thread it just wrote')

      const resolved = await setThreadResolved(ctx.workspace.path, thread.id, true)
      assert(resolved.state === 'resolved', `resolving reported ${resolved.state}`)
      const afterResolve = await firstThread(ctx, layer.number)
      assert(afterResolve.resolved, 'the thread did not read back as resolved')

      const reopened = await setThreadResolved(ctx.workspace.path, thread.id, false)
      assert(reopened.state === 'unresolved', `reopening reported ${reopened.state}`)
      const afterReopen = await firstThread(ctx, layer.number)
      assert(!afterReopen.resolved, 'the thread did not read back as unresolved')
    },
  },
  {
    id: 'reviews/comparison-moved-refuses-the-submission',
    title: 'a review written against a moved comparison is refused, not posted',
    requires: ['reviewThreads'],
    async run(ctx) {
      const layer = await reviewLayer(ctx, 'review-moved')
      const remote = await originRemote(ctx.workspace.path)
      const files = await readReviewFilesFrom(remote, layer.number)
      const drafts = anchorsFrom(files, REVIEW_FILE).slice(0, 1)

      // Somebody else pushes to the branch between the read and the submit, which
      // is the exact window the comparison check exists for.
      await pushCommit(ctx.workspace, {
        branch: layer.branch,
        parent: layer.branch,
        file: 'moved-after-read.txt',
        contents: 'pushed after the diff was read\n',
        message: 'review-moved: an outside push',
      })

      const error = await submitReview(ctx.workspace.path, layer.number, {
        event: 'COMMENT',
        body: 'Written against the comparison that was on screen.',
        drafts,
        comparison: files.comparison,
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      assert(
        error instanceof ReviewComparisonMovedError,
        `a review against a moved comparison was accepted or refused as ${String(error)}`,
      )
      const after = await readReviewThreads(ctx.workspace.path, layer.number)
      assert(
        after.threads.totalCount === 0,
        `the refused submission still posted ${after.threads.totalCount} threads`,
      )
      ctx.log('the submission was refused and nothing was posted')
    },
  },
  {
    id: 'reviews/second-account-approves',
    title: 'a second account can approve what the author cannot',
    requires: ['reviewThreads', 'secondReviewer'],
    async run(ctx) {
      const layer = await reviewLayer(ctx, 'review-approve')
      const reviewer = ctx.target.reviewer
      assert(reviewer !== null, 'no second account was supplied for this run')

      // The application holds one signed-in account at a time, so each approval is
      // written with that account installed and the author restored around it. Which
      // account is signed in is exactly what these two requests are about.
      const author = ctx.transport
      const files = await readReviewFilesFrom(await originRemote(ctx.workspace.path), layer.number)
      const drafts = anchorsFrom(files, REVIEW_FILE).slice(0, 1)
      const approveAs = async (transport: GitHubTransport, summary: string): Promise<unknown> => {
        setGitHubTransport(transport)
        try {
          return await submitReview(ctx.workspace.path, layer.number, {
            event: 'APPROVE',
            body: summary,
            drafts,
            comparison: files.comparison,
          }).then(
            () => null,
            (error: unknown) => error,
          )
        } finally {
          setGitHubTransport(author)
        }
      }

      const approved = await approveAs(reviewer.transport(), 'Approved by the second account.')
      // The same request from the account that opened the pull request is the other
      // half of what this scenario claims, so it is asked for rather than assumed.
      const selfApproved = await approveAs(author, 'Approved by the account that opened it.')
      assert(approved === null, `the second account could not approve: ${String(approved)}`)
      assert(selfApproved !== null, 'the author approved its own pull request')

      // The decision is a GraphQL field, so it is read the way the application reads
      // it rather than off a REST body that never carried one.
      const snapshot = await getSnapshot(ctx.workspace.path)
      const decided = snapshot.pullRequests.find((entry) => entry.number === layer.number)
      assert(
        decided?.reviewDecision === 'APPROVED',
        `the host records the review decision as ${String(decided?.reviewDecision)}`,
      )
      const asAuthor = await firstThread(ctx, layer.number)
      assert(
        asAuthor.comments.length === 1,
        `the approval left a thread holding ${asAuthor.comments.length} comments, not 1`,
      )
      assert(
        asAuthor.comments.every((comment) => comment.viewerDidAuthor === false),
        "a comment the second account wrote reads back as the author's own",
      )
      const asReviewer = await firstThread(ctx, layer.number, reviewer.transport())
      assert(
        asReviewer.comments.every((comment) => comment.viewerDidAuthor === true),
        'the approving account does not read back as the author of its own approval',
      )
      ctx.log(`#${layer.number} approved by ${reviewer.login}`)
    },
  },
]
