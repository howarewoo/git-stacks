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
  drafts: { line: number; side: string; start: number | null; body: string }[]
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
    await addPendingComment(page, 'Comment on src/main/review.ts:1–4 (head)', 'Keep these four together.')
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
        drafts: [{ line: 4, side: 'head', start: 1, body: 'Keep these four together.' }],
      },
    ])
  })

  test('several pending comments become one review rather than one request each', async ({ page }) => {
    await page.getByRole('button', { name: RANGE_SECOND }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:2 (head)', 'This rename is the point.')
    await page.getByRole('button', { name: 'Comment on src/main/review.ts line 3 on the head' }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:3 (head)', 'And this one.')
    await page.getByRole('textbox', { name: 'Review summary' }).fill('Two nits.')

    await expect(page.getByRole('button', { name: 'Submit 2 comments as one review' })).toBeVisible()
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

  test('a pending comment survives leaving the workspace and comes back unsent', async ({ page }) => {
    await page.getByRole('button', { name: RANGE_FIRST }).click()
    await addPendingComment(page, 'Comment on src/main/review.ts:1 (head)', 'Unfinished thought.')
    await expect(page.locator('.review-draft')).toHaveCount(1)

    await switchDestination(page, 'history')
    await switchDestination(page, 'review')
    await settle(page)

    // The words came back, and nothing was sent: leaving a workspace is not a
    // decision to publish what was written in it.
    await expect(page.getByRole('textbox', { name: 'Comment on src/main/review.ts:1 (head)' })).toHaveValue(
      'Unfinished thought.',
    )
    await expect(page.locator('.review-draft')).toHaveCount(1)
    expect(await submissions(page)).toEqual([])
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
    await addPendingComment(page, 'Comment on src/main/review.ts:1 (head)', 'Written before the push.')
    await switchDestination(page, 'history')
    await switchDestination(page, 'review')
    await settle(page)

    const draft = page.locator('.review-draft')
    await expect(draft).toContainText('outdated')
    await expect(draft).toContainText('a push moved it')
    // The words are the reviewer's; a push is not a reason to lose them.
    await expect(draft.getByRole('textbox')).toHaveValue('Written before the push.')
    // And nothing was posted anywhere, because the draft no longer names a line.
    await expect(page.getByRole('button', { name: 'Submit 0 comments as one review' })).toBeVisible()
    expect(await submissions(page)).toEqual([])
  })
})

test.describe('Viewer permissions', () => {
  test('a viewer with no write access is told why, before anything is offered', async ({ page }) => {
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
          const sent =
            (window as unknown as { __replies?: { number: number; threadId: string; body: string }[] })
              .__replies ??= []
          sent.push({ number, threadId, body })
          return reply(number, threadId, body)
        }
      }
    })

    await page.locator('.review-thread').first().getByRole('button', { name: 'Reply' }).click()
    await page.getByRole('textbox', { name: 'Reply to src/main/review.ts:2 (head)' }).fill('Agreed.')
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
    await expect(page.getByRole('textbox', { name: 'Reply to src/main/review.ts:2 (head)' })).toHaveCount(0)
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
