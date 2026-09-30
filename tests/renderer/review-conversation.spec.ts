import { expect, test } from '@playwright/test'
import { openGallery, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import type { Page } from '@playwright/test'

/**
 * The review conversation, proven against the real component tree.
 *
 * These are the decisions a reviewer would notice being wrong: a comment posted
 * to a line they did not name, a pending sentence lost by navigating away, two
 * comments sent as two reviews instead of one, and a decision offered that
 * GitHub will refuse.
 */

const RANGE_FIRST = 'Comment on src/main/review.ts line 1 on the head'
const RANGE_LAST = 'Comment on src/main/review.ts line 4 on the head'
const RANGE_SECOND = 'Comment on src/main/review.ts line 2 on the head'

/** Clicks the first line, then shift-clicks the second so the selection is a range. */
async function selectRange(page: Page): Promise<void> {
  await page.getByRole('button', { name: RANGE_FIRST }).click()
  await page.getByRole('button', { name: RANGE_LAST }).click({ modifiers: ['Shift'] })
  await expect(page.locator('.review-conversation')).toContainText('src/main/review.ts:1–4')
}

async function addPendingComment(page: Page, label: string, body: string): Promise<void> {
  await page.getByRole('button', { name: 'Add pending comment' }).click()
  await page.getByRole('textbox', { name: label }).fill(body)
}

/** Every `reviewSubmit` payload the page handed the bridge, in order. */
interface Submission {
  event: string
  body: string
  drafts: { id: string; line: number; side: string; start: number | null; body: string }[]
}

async function submissions(page: Page): Promise<Submission[]> {
  return page.evaluate(
    () => (window as unknown as { __reviewSubmissions?: Submission[] }).__reviewSubmissions ?? [],
  )
}

test.beforeEach(async ({ page }) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await page.evaluate(() => {
    const desktop = window.desktop
    const sent: unknown[] = []
    ;(window as unknown as { __reviewSubmissions: unknown[] }).__reviewSubmissions = sent
    const submit = desktop.reviewSubmit?.bind(desktop)
    if (submit) {
      desktop.reviewSubmit = async (number, submission) => {
        sent.push({
          event: submission.event,
          body: submission.body,
          drafts: submission.drafts.map((draft) => ({
            id: draft.id,
            line: draft.ref.line,
            side: draft.ref.side,
            start: draft.startRef ? draft.startRef.line : null,
            body: draft.body,
          })),
        })
        return submit(number, submission)
      }
    }
  })
  await switchDestination(page, 'review')
  await settle(page)
})

test.describe('Leaving a review', () => {
  test('a comment is written on the lines the reviewer chose, and a range keeps both ends', async ({
    page,
  }) => {
    await selectRange(page)
    await addPendingComment(
      page,
      'Comment on src/main/review.ts:1–4 (head)',
      'Keep these four together.',
    )
    // The event radios share the word "Comment" with the line gutters, so they
    // are picked from the submit group rather than by name alone.
    await page.locator('.review-submit-event').getByText('Comment', { exact: true }).click()
    await page.getByRole('button', { name: /Submit 1 comment as one review/ }).click()
    await settle(page)

    // One request, carrying both ends of the range: the first line as the range
    // start and the last as the line GitHub is asked to attach the comment to.
    expect(await submissions(page)).toEqual([
      {
        event: 'COMMENT',
        body: '',
        drafts: [
          {
            id: expect.any(String),
            line: 4,
            side: 'head',
            start: 1,
            body: 'Keep these four together.',
          },
        ],
      },
    ])
  })

  test('several pending comments become one review rather than one request each', async ({
    page,
  }) => {
    await page.getByRole('button', { name: RANGE_SECOND }).click()
    await addPendingComment(
      page,
      'Comment on src/main/review.ts:2 (head)',
      'This rename is the point.',
    )
    await page
      .getByRole('button', { name: 'Comment on src/main/review.ts line 3 on the head' })
      .click()
    await addPendingComment(page, 'Comment on src/main/review.ts:3 (head)', 'And this one.')
    await page.getByRole('textbox', { name: 'Review summary' }).fill('Two nits.')

    await expect(
      page.getByRole('button', { name: 'Submit 2 comments as one review' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Submit 2 comments as one review' }).click()
    await settle(page)

    const sent = await submissions(page)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.drafts.map((draft) => draft.body)).toEqual([
      'This rename is the point.',
      'And this one.',
    ])
    expect(sent[0]?.body).toBe('Two nits.')
    await expect(page.locator('.review-draft')).toHaveCount(0)
  })

  test('a recovery that adopted some drafts keeps the ones GitHub never took', async ({ page }) => {
    await page.getByRole('button', { name: RANGE_SECOND }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:2 (head)', 'Already on GitHub.')
    await page
      .getByRole('button', { name: 'Comment on src/main/review.ts line 3 on the head' })
      .click()
    await addPendingComment(page, 'Comment on src/main/review.ts:3 (head)', 'Never sent.')
    await page.getByRole('textbox', { name: 'Review summary' }).fill('Two nits.')

    // The backend reconciles a lost attempt against GitHub and reports which of
    // the drafts that outcome already delivered, by the ids the view gave them.
    // Only those may be dropped: clearing the whole list would throw away a
    // comment the reviewer is still owed, which is the one thing a recovery must
    // not do.
    await page.evaluate(() => {
      const bridge = window.desktop
      const original = bridge.reviewSubmit
      if (!original) throw new Error('the review submit bridge is not installed')
      bridge.reviewSubmit = async (number, submission) => {
        const result = await original(number, submission)
        return { ...result, delivered: [submission.drafts[0]?.id] }
      }
    })
    await page.getByRole('button', { name: 'Submit 2 comments as one review' }).click()
    await settle(page)

    const remaining = page.locator('.review-draft')
    await expect(remaining).toHaveCount(1)
    await expect(remaining).toContainText('Never sent.')
  })

  test('the same words on the same line, written again after sending, are a new comment', async ({
    page,
  }) => {
    const words = 'Rename this before it lands.'
    await page.getByRole('button', { name: RANGE_SECOND }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:2 (head)', words)
    await page.getByRole('button', { name: 'Submit 1 comment as one review' }).click()
    await settle(page)
    await expect(page.locator('.review-draft')).toHaveCount(0)

    // Leaving the workspace and coming back is what a reviewer does between
    // reading and deciding, and it is where an identity is easiest to lose: the
    // count that names the next comment lives with the drafts, and nothing is
    // on screen to rebuild it from.
    await switchDestination(page, 'history')
    await switchDestination(page, 'review')
    await settle(page)

    // The reviewer comes back to the same line and writes the same sentence
    // again, this time to approve. Read by its anchor alone this is the comment
    // that was just sent, and clearing it as already delivered would leave the
    // approval unwritten and the workspace claiming the words are on GitHub.
    await page.getByRole('button', { name: RANGE_SECOND }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:2 (head)', words)
    await page.getByRole('textbox', { name: 'Review summary' }).fill('Fine now.')
    await page.getByRole('radio', { name: 'Approve' }).check()
    await page.getByRole('button', { name: 'Submit 1 comment as one review' }).click()
    await settle(page)

    const sent = await submissions(page)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.event).toBe('APPROVE')
    expect(sent[1]?.body).toBe('Fine now.')
    expect(sent[1]?.drafts.map((draft) => draft.body)).toEqual([words])
    // The two comments share a line, a side and every word, and are still two
    // comments. A name derived from where the comment sits would have given them
    // one identity, and the app would then have folded the second into the
    // first as though it had already been sent.
    expect(sent[1]?.drafts[0]?.id).not.toBe(sent[0]?.drafts[0]?.id)
  })

  test('two windows composing the same comment on one line each send their own', async ({
    page,
    context,
  }) => {
    // A second tab is a second window of the app: the same pull request, the
    // same diff, the same reviewer, and the same journal behind both. What is
    // written in one of them is not in the other's screen until it is read
    // again, which is why the two comments below share everything a payload
    // can be matched on — line, words, revision, account — except the identity
    // each was composed under.
    const other = await context.newPage()
    try {
      await openGallery(other, { scenario: 'review-stacked' })
      await other.evaluate(() => {
        const desktop = window.desktop
        const sent: unknown[] = []
        ;(window as unknown as { __reviewSubmissions: unknown[] }).__reviewSubmissions = sent
        const submit = desktop.reviewSubmit?.bind(desktop)
        if (submit) {
          desktop.reviewSubmit = async (number, submission) => {
            sent.push({
              event: submission.event,
              body: submission.body,
              drafts: submission.drafts.map((draft) => ({
                id: draft.id,
                line: draft.ref.line,
                side: draft.ref.side,
                start: draft.startRef ? draft.startRef.line : null,
                body: draft.body,
              })),
            })
            return submit(number, submission)
          }
        }
      })
      await switchDestination(other, 'review')
      await settle(other)

      const words = 'Rename this before it lands.'
      const compose = async (target: Page): Promise<void> => {
        await target.getByRole('button', { name: RANGE_SECOND }).click()
        await addPendingComment(target, 'Comment on src/main/review.ts:2 (head)', words)
      }
      await compose(page)
      await compose(other)

      // The first window sends it as a comment; the second is approving.
      await page.getByRole('button', { name: 'Submit 1 comment as one review' }).click()
      await settle(page)
      await other.getByRole('radio', { name: 'Approve' }).check()
      await other.getByRole('button', { name: 'Submit 1 comment as one review' }).click()
      await settle(other)

      const first = await submissions(page)
      const second = await submissions(other)
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(first[0]?.event).toBe('COMMENT')
      expect(second[0]?.event).toBe('APPROVE')
      expect(first[0]?.drafts[0]?.body).toBe(words)
      expect(second[0]?.drafts[0]?.body).toBe(words)
      // The same line, the same side, the same sentence, in two windows that
      // read the same journal — and still two comments. A name counted from
      // what the journal last held would have given both windows one name, and
      // the approval the second window made would have been reported as
      // delivered by the first window's comment.
      expect(second[0]?.drafts[0]?.id).not.toBe(first[0]?.drafts[0]?.id)
    } finally {
      await other.close()
    }
  })

  test('a pending comment survives leaving the workspace and comes back unsent', async ({
    page,
  }) => {
    await page.getByRole('button', { name: RANGE_FIRST }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:1 (head)', 'Unfinished thought.')
    await expect(page.locator('.review-draft')).toHaveCount(1)

    await switchDestination(page, 'history')
    await switchDestination(page, 'review')
    await settle(page)

    // The words came back, and nothing was sent: leaving a workspace is not a
    // decision to publish what was written in it.
    await expect(
      page.getByRole('textbox', { name: 'Comment on src/main/review.ts:1 (head)' }),
    ).toHaveValue('Unfinished thought.')
    await expect(page.locator('.review-draft')).toHaveCount(1)
    expect(await submissions(page)).toEqual([])
  })

  test('a journal read that answers after the reviewer starts writing does not replace their words', async ({
    page,
  }) => {
    // The journal read is asynchronous and the diff it waits for is not: lines
    // can be selected and commented on as soon as the files are on screen, which
    // can be before the read of what was left last time comes back. The read
    // describes the drafts as they were when it began, so answering it after an
    // edit would replace words just typed with that older snapshot — and put the
    // snapshot back on disk at the next edit.
    //
    // The read is held on a promise that returns whatever the journal held the
    // moment the read started, which is what the main process would have read,
    // rather than whatever it holds by the time the test lets it answer.
    await switchDestination(page, 'history')
    await page.evaluate(() => {
      const bridge = window.desktop
      const read = bridge.reviewDrafts?.bind(bridge)
      if (!read) throw new Error('the review draft bridge is not installed')
      let open: (() => void) | undefined
      const held = new Promise<void>((resolve) => {
        open = resolve
      })
      ;(window as unknown as { __answerDraftRead?: () => void }).__answerDraftRead = () => open?.()
      bridge.reviewDrafts = async (number) => {
        const whenTheReadBegan = await read(number)
        await held
        return whenTheReadBegan
      }
    })
    await switchDestination(page, 'review')
    // The review is usable with the journal read still out: the diff is what is
    // on screen, and a line can be picked before the journal has answered.
    await page.getByRole('button', { name: RANGE_FIRST }).click()
    await expect(page.getByRole('button', { name: 'Add pending comment' })).toBeVisible()
    await addPendingComment(
      page,
      'Comment on src/main/review.ts:1 (head)',
      'Typed while the read was out.',
    )
    await expect(page.locator('.review-draft')).toHaveCount(1)

    // Only now does the read the reviewer could not wait for answer, holding a
    // journal that does not mention what was just written.
    await page.evaluate(() => {
      const answer = (window as unknown as { __answerDraftRead?: () => void }).__answerDraftRead
      if (!answer) throw new Error('the held journal read was never installed')
      answer()
    })
    await settle(page)

    await expect(
      page.getByRole('textbox', { name: 'Comment on src/main/review.ts:1 (head)' }),
    ).toHaveValue('Typed while the read was out.')
    await expect(page.locator('.review-draft')).toHaveCount(1)

    // And the next edit carries the words on screen, not the snapshot the read
    // was holding — that is what would put the older state back on disk.
    await page.getByRole('button', { name: RANGE_SECOND }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:2 (head)', 'And this one.')
    const journal = await page.evaluate(() =>
      window.fixture.calls
        .filter((entry) => entry.call === 'reviewSetDrafts')
        .map((entry) =>
          (entry.args[0] as { drafts: { body: string }[] }).drafts.map((d) => d.body),
        ),
    )
    expect(journal.at(-1)).toEqual(['Typed while the read was out.', 'And this one.'])
  })

  test('a pending comment looks nothing like one already on GitHub', async ({ page }) => {
    await page.getByRole('button', { name: RANGE_FIRST }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:1 (head)', 'Not sent yet.')

    const draft = page.locator('.review-draft')
    const thread = page.locator('.review-thread').first()
    await expect(page.locator('.review-drafts-caption')).toContainText('pending, not sent')
    await expect(thread).not.toContainText('pending, not sent')
    // One is a locally composed card, the other a conversation somebody is in.
    expect(await draft.evaluate((el) => getComputedStyle(el).borderLeftStyle)).toBe('dashed')
    expect(await thread.evaluate((el) => getComputedStyle(el).borderLeftStyle)).toBe('solid')
  })
})

test.describe('Anchors that no longer name their line', () => {
  test('a stale draft is kept, marked, and not submitted with the rest', async ({ page }) => {
    await page.evaluate(() => {
      window.desktop.reviewResolveDrafts = async (_number, drafts) =>
        drafts.map((draft) => ({
          id: draft.id,
          match: 'unresolved' as const,
          side: null,
          line: null,
          startLine: null,
          reason: 'src/main/review.ts no longer holds that line on the head; a push moved it.',
        }))
    })
    await page.getByRole('button', { name: RANGE_FIRST }).click()
    await addPendingComment(
      page,
      'Comment on src/main/review.ts:1 (head)',
      'Written before the push.',
    )
    await switchDestination(page, 'history')
    await switchDestination(page, 'review')
    await settle(page)

    const draft = page.locator('.review-draft')
    await expect(draft).toContainText('outdated')
    await expect(draft).toContainText('a push moved it')
    // The words are the reviewer's; a push is not a reason to lose them.
    await expect(draft.getByRole('textbox')).toHaveValue('Written before the push.')
    // The whole review is held rather than quietly trimmed. The count still
    // names the draft the reviewer wrote, because it is their review being
    // held — but the button is dead and says why, so a stale comment can never
    // be left behind by a submit that succeeds without it.
    const submit = page.getByRole('button', { name: 'Submit 1 comment as one review' })
    await expect(submit).toBeVisible()
    await expect(submit).toBeDisabled()
    await expect(page.locator('.review-submit-reason')).toContainText(
      'no longer names a line in this diff, so the whole review is held',
    )
    // And nothing was posted anywhere, because the draft no longer names a line.
    expect(await submissions(page)).toEqual([])
  })
})

test.describe('Viewer permissions', () => {
  test('a viewer with no write access is told why, before anything is offered', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'review-read-only' })
    await switchDestination(page, 'review')
    await settle(page)

    const submit = page.locator('.review-submit')
    await expect(submit).toContainText('You do not have write access to this repository.')
    await expect(submit.getByRole('button', { name: /Submit/ })).toBeDisabled()
  })

  test('a viewer is not offered approval of a pull request they opened', async ({ page }) => {
    await openGallery(page, { scenario: 'review-own-pull-request' })
    await switchDestination(page, 'review')
    await settle(page)

    await page.getByRole('radio', { name: 'Approve' }).check()
    await expect(page.locator('.review-submit')).toContainText(
      'You opened this pull request, and GitHub does not let you approve it.',
    )
    // Commenting and requesting changes are still allowed; only the one GitHub
    // refuses is taken away.
    await expect(page.getByRole('radio', { name: 'Comment' })).toBeEnabled()
    await expect(page.getByRole('radio', { name: 'Request changes' })).toBeEnabled()
  })
})

test.describe('Threads', () => {
  test('a reply names its thread and its body, and the conversation is re-read afterwards', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const desktop = window.desktop
      const reply = desktop.reviewReply?.bind(desktop)
      if (reply) {
        desktop.reviewReply = async (number, threadId, body) => {
          const sent = ((
            window as unknown as {
              __replies?: { number: number; threadId: string; body: string }[]
            }
          ).__replies ??= [])
          sent.push({ number, threadId, body })
          return reply(number, threadId, body)
        }
      }
    })

    await page.locator('.review-thread').first().getByRole('button', { name: 'Reply' }).click()
    await page
      .getByRole('textbox', { name: 'Reply to src/main/review.ts:2 (head)' })
      .fill('Agreed.')
    await page.getByRole('button', { name: 'Send reply' }).click()
    await settle(page)

    const replies = await page.evaluate(
      () =>
        (window as unknown as { __replies?: { number: number; threadId: string; body: string }[] })
          .__replies ?? [],
    )
    expect(replies).toEqual([{ number: 42, threadId: 'T_thr_1', body: 'Agreed.' }])
    // The reply left the composer, and the thread is read again so the panel
    // reflects GitHub rather than what the local mutation believed.
    await expect(
      page.getByRole('textbox', { name: 'Reply to src/main/review.ts:2 (head)' }),
    ).toHaveCount(0)
    expect(
      await page.evaluate(
        () => window.fixture.calls.filter((entry) => entry.call === 'reviewThreads').length,
      ),
    ).toBeGreaterThan(1)
  })

  test('resolved and outdated threads are shown as such, and resolving is reversible', async ({
    page,
  }) => {
    const first = page.locator('.review-thread').first()
    await expect(first).toContainText('open')
    await first.getByRole('button', { name: 'Resolve', exact: true }).click()
    await settle(page)

    const second = page.locator('.review-thread').nth(1)
    // A thread GitHub reports as resolved and outdated says so rather than
    // quietly disappearing from the review.
    await expect(second).toContainText('resolved')
    await expect(second).toContainText('outdated')
    await expect(second.getByRole('button', { name: 'Reopen' })).toBeVisible()
  })
})
