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
import { scenarios } from './fixtures/scenarios'

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
  scenario: 'review-stacked' | 'review-long-stack' = 'review-stacked',
) {
  await openGallery(page, { scenario, viewport })
  const number = scenario === 'review-long-stack' ? 136 : 42
  const pullRequest = await page.evaluate(async (number) => {
    const read = window.desktop.reviewHeadline
    if (!read) throw new Error('Review headline fixture capability is unavailable.')
    return (await read(number)).pullRequest
  }, number)
  await answerNextDoubleCall(page, 'reviewFiles', {
    ...reviewFileSet(number, pullRequest.headOid ?? head, pullRequest.base),
    files: [longFile],
  })
  await switchDestination(page, 'review')
  await settle(page)
}

test('viewed and unviewed records survive same-head return but not a moved head or repository', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  const row = page.locator('[data-review-row]').filter({ hasText: 'review.ts' }).first()
  await expect(page.getByRole('button', { name: /^Mark file as (?:un)?viewed$/ })).toBeEnabled()
  await row.click()
  await expect(
    page.getByRole('button', { name: 'Mark file as unviewed', exact: true }),
  ).toBeEnabled()
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.reviewViewed!(42)))?.paths)
    .toContain('src/main/review.ts')
  const original = await page.evaluate(() => window.desktop.reviewViewed!(42))
  await page.getByRole('button', { name: 'Mark file as unviewed', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.reviewViewed!(42)))?.paths)
    .not.toContain('src/main/review.ts')
  expect((await page.evaluate(() => window.desktop.reviewViewed!(42)))?.comparison).toEqual(
    original?.comparison,
  )
  await page.getByRole('button', { name: 'Mark file as viewed', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.reviewViewed!(42)))?.paths)
    .toContain('src/main/review.ts')
  await switchDestination(page, 'branches')
  await switchDestination(page, 'review')
  await expect(
    page.getByRole('button', { name: 'Mark file as unviewed', exact: true }),
  ).toBeVisible()
  const headline = await page.evaluate(() => window.desktop.reviewHeadline!(42))
  await answerNextDoubleCall(
    page,
    'reviewFiles',
    reviewFileSet(42, '6'.repeat(40), headline.pullRequest.base),
  )
  await page.getByRole('button', { name: 'Reload review data from GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mark file as viewed', exact: true })).toBeVisible()
  await expect(row).not.toHaveAttribute('aria-label', /, viewed$/)
  expect((await page.evaluate(() => window.desktop.reviewViewed!(42)))?.comparison).toEqual(
    original?.comparison,
  )
  const snapshot = scenarios['review-stacked'].snapshot
  if (!snapshot) throw new Error('Review scenario requires a repository snapshot.')
  await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
    ...snapshot,
    path: `${snapshot.path}-other`,
    remoteUrl: 'https://github.com/other/widgets.git',
    pullRequests: snapshot.pullRequests.map((pr) => ({
      ...pr,
      url: `https://github.com/other/widgets/pull/${pr.number}`,
      headRepository: 'other/widgets',
    })),
  })
  await settle(page)
  expect(await page.evaluate(() => window.desktop.reviewViewed!(42))).toBeNull()
  // A replacement repository has a different qualified PR identity. Re-enter
  // through its current association rather than retaining the previous owner.
  await switchDestination(page, 'branches')
  await page
    .getByRole('complementary', { name: 'Workspace navigation' })
    .getByRole('button', { name: `other/widgets · ${snapshot.path}-other`, exact: true })
    .click()
  await page.getByRole('button', { name: snapshot.currentBranch!, exact: true }).click()
  await switchDestination(page, 'review')
  await expect(page.locator('.review-headline')).toContainText('#42')
  await expect(page.getByRole('button', { name: 'Mark file as viewed', exact: true })).toBeVisible()
  await expect(row).not.toHaveAttribute('aria-label', /, viewed$/)
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})

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

for (const size of [
  { width: 1440, height: 940, rows: 15 },
  { width: 1000, height: 700, rows: 8 },
]) {
  for (const mode of ['Unified', 'Split']) {
    test(`collapsed long native rail preserves ${size.rows} fully intersecting ${mode} code rows at ${size.width}×${size.height}`, async ({
      page,
    }) => {
      await openLongReview(page, size, 'review-long-stack')
      await expect(page.locator('.review-stack-disclosure')).not.toHaveAttribute('open')
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
    })
  }
}

test('a queued repository preparation retains reading and composition while comparison safety remains immediate', async ({
  page,
}) => {
  await openLongReview(page, { width: 1000, height: 700 })
  await page
    .getByRole('button', { name: 'Comment on src/long-review.ts line 12 on the head', exact: true })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/long-review.ts:12 (head)',
    exact: true,
  })
  await editor.fill('Keep this sentence while the displayed comparison becomes stale.')
  await page.getByRole('textbox', { name: 'Review summary' }).fill('Keep the decision summary too.')
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await page
    .locator('.review-actions summary')
    .filter({ hasText: /^PR actions$/ })
    .click()
  const region = page.locator('.review-unified')
  await region.evaluate((element) => {
    element.scrollTop = 200
  })
  const scroll = await region.evaluate((element) => element.scrollTop)
  // Preparing a qualified operation adopts its directory asynchronously.
  // Inspection remains usable while that captured repository open is pending.
  await holdDoubleCall(page, 'openRepository')
  await page.getByRole('button', { name: 'Manage pull request', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.fixture.pending.includes('openRepository')))
    .toBe(true)
  await answerNextDoubleCall(page, 'reviewFiles', {
    ...reviewFileSet(42, 'new-head-observed-while-busy'),
    files: [
      textFile('src/replacement.ts', '@@ -0,0 +1,1 @@', [['+a replacement comparison', null, 1]], {
        status: 'added',
      }),
    ],
  })
  await page.getByRole('button', { name: 'Reload review data from GitHub', exact: true }).click()
  await expect(page.locator('.review-view')).toContainText(
    /head or base changed since this displayed comparison/,
  )
  await expect(
    page.getByRole('button', {
      name: 'Comment on src/long-review.ts line 12 on the head',
      exact: true,
    }),
  ).toHaveCount(1)
  await expect(
    page.getByRole('button', {
      name: 'Comment on src/replacement.ts line 1 on the head',
      exact: true,
    }),
  ).toHaveCount(0)
  expect(await region.evaluate((element) => element.scrollTop)).toBe(scroll)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(editor).toHaveValue(
    'Keep this sentence while the displayed comparison becomes stale.',
  )
  await expect(page.getByRole('textbox', { name: 'Review summary' })).toHaveValue(
    'Keep the decision summary too.',
  )
  await expect(
    page.locator('.review-submit').getByRole('button', { name: /Submit/ }),
  ).toBeDisabled()
  expect((await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSubmit')).toEqual([])
  await page.evaluate(() => window.fixture.unhold('openRepository'))
  await releaseDoubleCalls(page, 'openRepository')
})

test('a refreshed comparison never launders a saved comment onto the new head', async ({
  page,
}) => {
  await openLongReview(page, { width: 1000, height: 700 })
  await page
    .getByRole('button', { name: 'Comment on src/long-review.ts line 12 on the head', exact: true })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/long-review.ts:12 (head)',
    exact: true,
  })
  await editor.fill('This sentence was composed against the original head.')
  await expect
    .poll(
      async () => (await page.evaluate(() => window.desktop.reviewDrafts!(42)))?.drafts[0]?.body,
    )
    .toBe('This sentence was composed against the original head.')
  const original = await page.evaluate(() => window.desktop.reviewDrafts!(42))
  if (!original?.comparison.baseRef) throw new Error('The original fixture base was not observed.')
  await answerNextDoubleCall(page, 'reviewFiles', {
    ...reviewFileSet(42, '6'.repeat(40), original.comparison.baseRef),
    files: [longFile],
  })
  await page.getByRole('button', { name: 'Reload review data from GitHub', exact: true }).click()
  await expect(page.locator('.review-view')).toContainText(
    'Your unsent comments retain an earlier head or base comparison',
  )
  await expect(editor).toHaveValue('This sentence was composed against the original head.')
  await editor.fill('Edited locally without adopting the replacement comparison.')
  await expect
    .poll(
      async () => (await page.evaluate(() => window.desktop.reviewDrafts!(42)))?.drafts[0]?.body,
    )
    .toBe('Edited locally without adopting the replacement comparison.')
  await expect(
    page.locator('.review-submit').getByRole('button', { name: /Submit/ }),
  ).toBeDisabled()
  expect((await page.evaluate(() => window.desktop.reviewDrafts!(42)))?.comparison).toEqual(
    original?.comparison,
  )
  expect((await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSubmit')).toEqual([])
})

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
  const context = await page.evaluate(async () => ({
    headline: await window.desktop.reviewHeadline!(42),
    commits: await window.desktop.reviewCommits!(42),
  }))
  for (const pane of ['Commits', 'Description & reviewers', 'Checks', 'Code']) {
    await page.getByRole('button', { name: pane, exact: true }).click()
    if (pane === 'Commits') {
      await expect(page.locator('.review-context')).toContainText(
        context.commits.commits[0].message,
      )
    } else if (pane === 'Description & reviewers') {
      await expect(page.locator('.review-about')).toContainText(context.headline.pullRequest.body!)
    } else if (pane === 'Checks') {
      await expect(page.getByRole('button', { name: 'Refresh checks', exact: true })).toBeVisible()
    } else {
      await expect(
        page.getByRole('button', {
          name: 'Comment on src/long-review.ts line 12 on the head',
          exact: true,
        }),
      ).toBeVisible()
    }
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
  await expect(page.getByRole('button', { name: /^Mark file as (?:un)?viewed$/ })).toBeEnabled()
  await page.locator('[data-review-row]').filter({ hasText: 'review.ts' }).first().click()
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.reviewViewed!(42)))?.paths)
    .toContain('src/main/review.ts')
  const currentViewed = await page.evaluate(() => window.desktop.reviewViewed!(42))
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
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await page.getByRole('button', { name: 'Next file', exact: true }).click()
  await page.locator('[data-review-row]').filter({ hasText: 'review.ts' }).click()
  expect(await page.evaluate(() => window.desktop.reviewViewed!(42))).toEqual(currentViewed)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
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
    const rerun = page.getByRole('button', { name: /^Rerun /u }).first()
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

test('held historical hunks keep their actual endpoint label and a visible Code warning after the head moves', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  const original = await page.evaluate(async () => {
    const history = await window.desktop.reviewHistory!(42)
    if (!history.reviewed) throw new Error('The earlier reviewed endpoint was not observed.')
    return window.desktop.reviewHistoryDiff!(42, history.reviewed.headOid)
  })
  if (original.state !== 'files') throw new Error('The original endpoint diff is unavailable.')
  await page.locator('.review-history-disclosure > summary').click()
  await page.getByRole('button', { name: 'Changes since reviewed', exact: true }).click()
  await expect(page.locator('.review-history-comparing')).toContainText(
    original.to.headOid!.slice(0, 7),
  )
  await holdDoubleCall(page, 'reviewHistoryDiff')
  await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
    ...scenarios['review-stacked'].snapshot!,
    pullRequests: scenarios['review-stacked'].snapshot!.pullRequests.map((pr) =>
      pr.number === 42 ? { ...pr, headOid: '6'.repeat(40) } : pr,
    ),
  })
  await page.getByRole('button', { name: 'Reload review data from GitHub', exact: true }).click()
  await expect(page.locator('.review-history-comparing')).toContainText(
    original.to.headOid!.slice(0, 7),
  )
  await expect(page.locator('.review-history-comparing')).not.toContainText('6666666')
  await expect(page.locator('.review-history-disclosure > summary')).toContainText(
    original.to.headOid!.slice(0, 7),
  )
  const warning = page.locator('.review-comparison-alert').filter({
    hasText: 'These displayed hunks still compare against',
  })
  await expect(warning).toBeVisible()
  await expect(warning).toContainText('6666666')
  await expect(warning).toContainText(original.to.headOid!.slice(0, 7))
  await expect(page.locator('.review-body')).toHaveAttribute('data-pane', 'code')
  await expect(page.locator('.review-diff')).toContainText('return transportDiff()')
  await releaseDoubleCalls(page, 'reviewHistoryDiff')
  await expect(page.locator('.review-history-comparing')).toContainText('6666666')
  await expect(warning).toHaveCount(0)
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})
