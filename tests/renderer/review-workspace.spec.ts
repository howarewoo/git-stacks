import { expect, test } from '@playwright/test'
import {
  answerNextDoubleCall,
  failNextDoubleCall,
  getDoubleCalls,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { reviewFileSet, textFile } from './fixtures/review'

const head = '4242424242424242424242424242424242424242'
const longFile = textFile(
  'src/long-review.ts',
  '@@ -0,0 +1,100 @@',
  Array.from(
    { length: 100 },
    (_, index) =>
      [`+complete code row ${index + 1}`, null, index + 1] as [
        string,
        number | null,
        number | null,
      ],
  ),
  { status: 'added' },
)

async function openLongReview(
  page: Parameters<typeof openGallery>[0],
  viewport: { width: number; height: number },
) {
  await openGallery(page, { scenario: 'review-stacked', viewport })
  await answerNextDoubleCall(page, 'reviewFiles', { ...reviewFileSet(42, head), files: [longFile] })
  await switchDestination(page, 'review')
  await settle(page)
}

for (const size of [
  { width: 1440, height: 940, rows: 15 },
  { width: 1000, height: 700, rows: 8 },
]) {
  for (const mode of ['Unified', 'Split']) {
    test(`${mode} shows ${size.rows} complete code rows at ${size.width}×${size.height}`, async ({
      page,
    }) => {
      await openLongReview(page, size)
      await page.getByRole('button', { name: mode, exact: true }).click()
      const count = await page
        .locator(mode === 'Unified' ? '.review-unified' : '.review-split')
        .evaluate((region) => {
          const bounds = region.getBoundingClientRect()
          let top = Math.max(0, bounds.top)
          let bottom = Math.min(window.innerHeight, bounds.bottom)
          for (let ancestor = region.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(ancestor).overflowY)) {
              const box = ancestor.getBoundingClientRect()
              top = Math.max(top, box.top + ancestor.clientTop)
              bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight)
            }
          }
          return [...region.querySelectorAll('.review-line, .review-split-row')].filter((row) => {
            const rect = row.getBoundingClientRect()
            return rect.height > 0 && rect.top >= top && rect.bottom <= bottom
          }).length
        })
      expect(count).toBeGreaterThanOrEqual(size.rows)
      expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
    })
  }
}

test('context switches preserve code scroll, selected line, whitespace mode and unsent text', async ({
  page,
}) => {
  await openLongReview(page, { width: 1000, height: 700 })
  await page.getByRole('checkbox', { name: 'Hide whitespace' }).check()
  const region = page.locator('.review-unified')
  await region.evaluate((element) => {
    element.scrollTop = 200
  })
  const top = await region.evaluate((element) => element.scrollTop)
  await page
    .getByRole('button', { name: 'Comment on src/long-review.ts line 12 on the head', exact: true })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Comment on src/long-review.ts:12 (head)', exact: true })
    .fill('Keep this draft while reading context.')
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await page
    .getByRole('button', { name: 'Comment on src/long-review.ts line 12 on the head', exact: true })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('textbox', { name: 'Review summary' }).fill('Summary survives too.')
  await page
    .locator('.review-thread')
    .first()
    .getByRole('button', { name: 'Reply', exact: true })
    .click()
  await page
    .getByRole('textbox', { name: 'Reply to src/main/review.ts:2 (head)', exact: true })
    .fill('Unsent reply survives context.')
  for (const pane of ['Commits', 'Description & reviewers', 'Checks', 'Code']) {
    await page.getByRole('button', { name: pane, exact: true }).click()
  }
  await expect(page.getByRole('checkbox', { name: 'Hide whitespace' })).toBeChecked()
  expect(await region.evaluate((element) => element.scrollTop)).toBe(top)
  await expect(page.locator('.review-line-selected')).toHaveCount(1)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Comment on src/long-review.ts:12 (head)', exact: true }),
  ).toHaveValue('Keep this draft while reading context.')
  await expect(page.getByRole('textbox', { name: 'Review summary' })).toHaveValue(
    'Summary survives too.',
  )
  await expect(
    page.getByRole('textbox', { name: 'Reply to src/main/review.ts:2 (head)', exact: true }),
  ).toHaveValue('Unsent reply survives context.')
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
})

for (const viewport of [
  { width: 720, height: 470 },
  { width: 960, height: 540 },
]) {
  test(`zoom keeps navigation and context locally scrollable at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await openLongReview(page, viewport)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      viewport.height,
    )
    const view = page.locator('.review-view')
    await view.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(page.locator('.review-unified')).toBeVisible()
    for (const mode of ['Unified', 'Split']) {
      await page.getByRole('button', { name: mode, exact: true }).click()
      const lastRow = page
        .locator(
          mode === 'Unified' ? '.review-unified .review-line' : '.review-split .review-split-row',
        )
        .last()
      await lastRow.scrollIntoViewIfNeeded()
      await expect(
        lastRow.getByRole('button', {
          name: 'Comment on src/long-review.ts line 100 on the head',
          exact: true,
        }),
      ).toBeInViewport({ ratio: 1 })
      const clipping = await lastRow.evaluate((row) => {
        const bounds = row.getBoundingClientRect()
        let top = 0
        let bottom = window.innerHeight
        for (let ancestor = row.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(ancestor).overflowY)) {
            const box = ancestor.getBoundingClientRect()
            top = Math.max(top, box.top + ancestor.clientTop)
            bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight)
          }
        }
        return { rowTop: bounds.top, rowBottom: bounds.bottom, top, bottom }
      })
      expect(clipping.rowTop).toBeGreaterThanOrEqual(clipping.top)
      expect(clipping.rowBottom).toBeLessThanOrEqual(clipping.bottom)
      expect(
        await page
          .locator(mode === 'Unified' ? '.review-unified' : '.review-split')
          .evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(0)
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
        viewport.height,
      )
    }
    for (const pane of ['Commits', 'Conversation', 'Description & reviewers', 'Checks', 'Code']) {
      await page.getByRole('button', { name: pane, exact: true }).click()
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
        viewport.height,
      )
      if (pane !== 'Code') {
        await expect(page.locator('.review-context')).toBeVisible()
        expect(
          await page.locator('.review-context').evaluate((element) => element.clientHeight),
        ).toBeGreaterThanOrEqual(230)
      }
    }
  })
}

test('description remains text and refused checks stay unknown without affecting code', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await page.evaluate(() => {
    const original = window.desktop.reviewHeadline!.bind(window.desktop)
    window.desktop.reviewHeadline = async (...args) => {
      const headline = await original(...args)
      return {
        ...headline,
        pullRequest: {
          ...headline.pullRequest,
          body: '<script>window.unsafeDescription = true</script> readable text',
        },
      }
    }
    window.desktop.pullRequestChecks = async () => {
      throw new Error('Fixture checks refused for this authority')
    }
  })
  await switchDestination(page, 'review')
  await page.getByRole('button', { name: 'Description & reviewers', exact: true }).click()
  await expect(page.locator('.review-description')).toContainText('<script>')
  expect(await page.evaluate(() => 'unsafeDescription' in window)).toBe(false)
  await page.getByRole('button', { name: 'Checks', exact: true }).click()
  await expect(page.locator('.review-context')).toContainText('Fixture checks refused')
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await expect(page.locator('.review-unified')).toBeVisible()
})

test('historical comparison and submission freeze survive contextual pane switches', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page.locator('.review-history-disclosure summary').click()
  await page.getByRole('button', { name: 'Changes since reviewed', exact: true }).click()
  await page.locator('.review-history-disclosure summary').click()
  await expect(page.locator('.review-history-warning')).toContainText(
    'Comments and reviews are disabled',
  )
  const endpoint = await page.locator('.review-history-disclosure summary').innerText()
  for (const pane of ['Commits', 'Description & reviewers', 'Code', 'Conversation']) {
    await page.getByRole('button', { name: pane, exact: true }).click()
    await expect(page.locator('.review-history-disclosure summary')).toHaveText(endpoint)
  }
  await expect(page.getByRole('button', { name: /Submit .* as one review/ })).toBeDisabled()
  expect(
    (await getDoubleCalls(page)).filter(
      (call) => call.call === 'reviewSubmit' || call.call === 'runAction',
    ),
  ).toEqual([])
})

test('minimum viewport keeps Code visible through both endpoints of a comment range', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked', viewport: { width: 1000, height: 700 } })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', { name: 'Comment on src/main/review.ts line 1 on the head', exact: true })
    .click()
  await expect(page.locator('.review-unified')).toBeVisible()
  await page
    .getByRole('button', { name: 'Comment on src/main/review.ts line 4 on the head', exact: true })
    .click({ modifiers: ['Shift'] })
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page.locator('.review-selection')).toContainText('src/main/review.ts:1–4')
  expect(
    (await getDoubleCalls(page)).filter(
      (call) => call.call === 'runAction' || call.call === 'reviewSubmit',
    ),
  ).toEqual([])
})

test('readiness and reviewer absence remain qualified when the displayed head advanced', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await page.evaluate(() => {
    const read = window.desktop.reviewHeadline!.bind(window.desktop)
    window.desktop.reviewHeadline = async (...args) => {
      const result = await read(...args)
      return {
        ...result,
        pullRequest: { ...result.pullRequest, mergeState: 'CLEAN', reviewDecision: 'APPROVED' },
        reviewers: { state: 'available', requested: [], reviews: [], message: '' },
      }
    }
  })
  await answerNextDoubleCall(page, 'reviewFiles', {
    ...reviewFileSet(42, '9'.repeat(40)),
    files: [longFile],
  })
  await switchDestination(page, 'review')
  await page.getByRole('button', { name: 'Description & reviewers', exact: true }).click()
  await expect(page.locator('.review-about')).toContainText(
    'Current-head readiness and reviewer absence are unknown',
  )
  await expect(page.locator('.review-about')).toContainText(
    'at the headline head; reviewer absence at the displayed head is unknown',
  )
  await expect(page.locator('.review-about')).toContainText('clean')
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await expect(page.locator('.review-unified')).toBeVisible()
})

for (const outcome of ['completed', 'refused']) {
  test(`refresh cannot orphan a pending check rerun that ${outcome}`, async ({ page }) => {
    await openGallery(page, { scenario: 'pull-requests-checks-detail' })
    const report = await page.evaluate(() => window.desktop.pullRequestChecks!(42))
    expect(report.headSha).not.toBeNull()
    const fileSet = reviewFileSet(42, report.headSha!)
    await answerNextDoubleCall(page, 'reviewFiles', {
      ...fileSet,
      comparison: { ...fileSet.comparison, baseRef: report.base },
      files: [longFile],
    })
    await switchDestination(page, 'review')
    await page.getByRole('button', { name: 'Checks', exact: true }).click()
    const rerun = page.getByRole('button', { name: 'Rerun', exact: true }).first()
    await expect(rerun).toBeEnabled()
    await holdDoubleCall(page, 'rerunPullRequestCheck')
    if (outcome === 'refused')
      await failNextDoubleCall(page, 'rerunPullRequestCheck', 'Rerun refused')
    await rerun.click()
    await expect(rerun).toBeDisabled()
    await page.getByRole('button', { name: 'Refresh checks', exact: true }).click()
    await settle(page)
    await expect(rerun).toBeDisabled()
    await releaseDoubleCalls(page, 'rerunPullRequestCheck')
    await expect(rerun).toBeEnabled()
    if (outcome === 'refused')
      await expect(page.locator('.review-context')).toContainText('Rerun refused')
    expect(
      (await getDoubleCalls(page)).filter((call) => call.call === 'rerunPullRequestCheck'),
    ).toHaveLength(1)
  })
}
