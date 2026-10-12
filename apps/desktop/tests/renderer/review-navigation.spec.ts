import { expect, test, type Page } from '@playwright/test'
import {
  answerNextDoubleCall,
  getDoubleCalls,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { scenarios } from './fixtures/scenarios'
import { graphIndex } from './fixtures/graph'

async function refreshReviewChoices(page: Page, freshOriginalOwner = false) {
  // Credential retirement removes remote choices; re-entry requires a fresh repository read.
  if (freshOriginalOwner) {
    await page.evaluate(
      (snapshot) => window.fixture.pushSnapshot(snapshot),
      scenarios['review-stacked'].snapshot!,
    )
  }
  await page.getByRole('button', { name: 'Refresh repository', exact: true }).click()
  const selected = page.locator('.review-headline-title').filter({ hasText: '#42' })
  const choice = page.locator('.review-chooser').getByRole('button').filter({ hasText: '#42 ' })
  await expect(selected.or(choice)).toBeVisible()
  if (await choice.isVisible()) await choice.click()
  await expect(page.locator('.review-headline-title')).toContainText('#42')
}

for (const destination of ['pullRequests', 'stacks'] as const) {
  test(`${destination} PR links open readonly Review rather than management`, async ({ page }) => {
    await openGallery(page, { scenario: 'review-stacked' })
    await switchDestination(page, destination)
    if (destination === 'pullRequests') {
      await page.getByPlaceholder('Filter view', { exact: true }).fill('cancellation')
      const link = page.getByRole('button', { name: /^Open pull request #42 / })
      await link.focus()
      await link.press('Enter')
    } else {
      await page
        .locator('[data-graph-outline-row]')
        .filter({ hasText: '#42' })
        .locator('button')
        .first()
        .click()
      const reviewLink = page.getByRole('button', { name: 'Review #42', exact: true })
      await reviewLink.focus()
      await page.keyboard.press('Enter')
    }
    await expect(page.locator('.review-view')).toContainText(
      '#42 Give the review workspace its own cancellation ids',
    )
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Synchronization actions' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open command palette' })).toBeVisible()
    await page
      .getByRole('button', {
        name: destination === 'pullRequests' ? 'Return to Pull requests' : 'Return to Stacks',
        exact: true,
      })
      .click()
    if (destination === 'pullRequests') {
      await expect(page.getByPlaceholder('Filter view', { exact: true })).toHaveValue(
        'cancellation',
      )
      await expect(page.getByRole('button', { name: /^Open pull request #42 / })).toBeFocused()
    } else {
      await expect(page.getByRole('button', { name: 'Review #42', exact: true })).toBeFocused()
    }
    const calls = await getDoubleCalls(page)
    expect(calls.some((call) => call.call === 'reviewHeadline' && call.args[0] === 42)).toBe(true)
    expect(calls.filter((call) => call.call === 'runAction')).toHaveLength(0)
  })
}

test('history clearing explains unavailable owner proof while snapshots are already readable', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await holdDoubleCall(page, 'reviewThreads')
  await switchDestination(page, 'review')
  await page.locator('.review-history-disclosure summary').click()
  const clear = page.getByRole('button', { name: 'Clear snapshot history', exact: true })
  await expect(clear).toBeVisible()
  await expect(clear).toBeDisabled()
  await page
    .getByRole('group', {
      name: 'Wait for the current repository and account to be confirmed before clearing snapshot history.',
      exact: true,
    })
    .hover()
  await expect(page.getByRole('tooltip')).toContainText(
    'Wait for the current repository and account to be confirmed',
  )
  await page.evaluate(() => {
    window.fixture.unhold('reviewThreads')
    window.fixture.failNext('reviewThreads', 'Conversation owner proof failed.')
  })
  await releaseDoubleCalls(page, 'reviewThreads')
  await expect(clear).toBeDisabled()
  await page
    .getByRole('group', {
      name: 'Snapshot history cannot be cleared until the current repository and account are confirmed. Reload the failed conversation read.',
      exact: true,
    })
    .hover()
  await expect(page.getByRole('tooltip')).toContainText('Reload the failed conversation read.')
  expect(
    (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewClearHistory'),
  ).toEqual([])
})

test('qualified held draft reads preserve admission snapshots across edits and account replacement', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await editor.fill('A original captured words.')
  await settle(page)
  const original = await page.evaluate(async () => ({
    cli: await window.desktop.githubCliStatus!(),
    record: await window.desktop.reviewDrafts!(42),
  }))
  await holdDoubleCall(page, 'reviewDrafts')
  const beforeRead = (await getDoubleCalls(page)).filter(
    (call) => call.call === 'reviewDrafts',
  ).length
  const read = page.evaluate(async () => window.desktop.reviewDrafts!(42))
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'reviewDrafts').length,
    )
    .toBeGreaterThan(beforeRead)
  await editor.fill('A newer authored words.')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSetDrafts').at(-1)
          ?.args[0],
    )
    .toMatchObject({ drafts: [{ body: 'A newer authored words.' }] })
  await page.evaluate(() =>
    window.fixture.publishCliStatus({
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement-account',
      version: '2.62.0',
      identity: 'cli:github.com:replacement-account:held-draft',
      message: null,
    }),
  )
  await page.evaluate(
    (snapshot) => window.fixture.pushSnapshot(snapshot),
    scenarios['review-stacked'].snapshot!,
  )
  const beforeSelection = (await getDoubleCalls(page)).filter(
    (call) => call.call === 'reviewDrafts',
  ).length
  await refreshReviewChoices(page)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'reviewDrafts').length,
    )
    .toBeGreaterThan(beforeSelection)
  await releaseDoubleCalls(page, 'reviewDrafts')
  expect(await read).toEqual(original.record)
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await expect(page.locator('.review-conversation')).not.toContainText('A original captured words.')
  await expect(page.locator('.review-conversation')).not.toContainText('A newer authored words.')
  await page.evaluate((status) => window.fixture.publishCliStatus(status), original.cli)
  await refreshReviewChoices(page, true)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(editor).toHaveValue('A newer authored words.')
})

test('history clear rejects stale-owner admission and held authority replacement without rebinding', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  const original = await page.evaluate(async () => ({
    cli: await window.desktop.githubCliStatus!(),
    owner: (await window.desktop.reviewThreads!(42)).owner,
  }))
  await holdDoubleCall(page, 'reviewClearHistory')
  const pending = page.evaluate(async (owner) => {
    try {
      await window.desktop.reviewClearHistory!(42, owner)
      return 'cleared'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, original.owner)
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'reviewClearHistory').length,
    )
    .toBe(1)
  await page.evaluate(() =>
    window.fixture.publishCliStatus({
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement-account',
      version: '2.62.0',
      identity: 'cli:github.com:replacement-account:history',
      message: null,
    }),
  )
  await releaseDoubleCalls(page, 'reviewClearHistory')
  expect(await pending).toBe('The captured review owner changed before provider dispatch.')
  const stale = await page.evaluate(async (owner) => {
    try {
      await window.desktop.reviewClearHistory!(42, owner)
      return 'cleared'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, original.owner)
  expect(stale).toBe('The captured review owner changed before provider dispatch.')
})

test('qualified Review return retains graph filters, selected identity, camera and outline scroll without mutation', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  const outline = page.getByRole('list', { name: 'Matching items and prerequisite context' })
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('Change')
  await outline.evaluate((element) => {
    element.scrollTop = 900
  })
  await expect.poll(() => outline.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const row = page.locator('[data-graph-outline-row]').filter({ hasText: '#181 Change 181' })
  // Search narrows the bounded outline to the actual remote PR, not a synthetic branch.
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('#181')
  await row.locator('button').first().click()
  await page.getByRole('button', { name: 'Zoom graph out' }).click()
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('Change')
  await outline.evaluate((element) => {
    element.scrollTop = 900
  })
  const beforeScroll = await outline.evaluate((element) => element.scrollTop)
  await page.getByRole('button', { name: 'Review #181', exact: true }).click()
  await expect(page.locator('.review-view')).toBeVisible()
  await holdDoubleCall(page, 'prIndex')
  await expect(page.locator('#workspace-view-heading-stacks')).toHaveCount(1)
  await expect(page.locator('#workspace-view-heading-review')).toHaveCount(1)
  const back = page.getByRole('button', { name: 'Return to Stacks', exact: true })
  await back.focus()
  await back.press('Enter')
  await expect(page.getByRole('searchbox', { name: 'Search indexed PRs' })).toHaveValue('Change')
  await expect(page.locator('.graph-camera')).toContainText('90%')
  await expect(page.getByRole('button', { name: 'Review #181', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review #181', exact: true })).toBeFocused()
  await expect.poll(() => outline.evaluate((element) => element.scrollTop)).toBe(beforeScroll)
  const calls = await getDoubleCalls(page)
  expect(
    calls.filter((call) =>
      [
        'runAction',
        'reviewSubmit',
        'reviewReply',
        'reviewSetResolved',
        'rerunPullRequestCheck',
      ].includes(call.call),
    ),
  ).toEqual([])
  await page.evaluate(() => window.fixture.unhold('prIndex'))
  await releaseDoubleCalls(page, 'prIndex')
})

test('return restores dependent paths and selected context even when a background title leaves the filter', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('#40')
  await page
    .locator('[data-graph-outline-row]')
    .filter({ hasText: '#40 Change 40' })
    .locator('button')
    .first()
    .click()
  await page.getByText(/Dependent paths ·/).click()
  await page.getByRole('searchbox', { name: 'Search dependent paths' }).fill('#181')
  await page.getByRole('button', { name: '#181 Change 181', exact: true }).click()
  const nodes = await page.locator('[data-graph-node]').allTextContents()
  await page.getByRole('button', { name: 'Zoom graph out' }).click()
  await page.getByRole('button', { name: 'Review #40', exact: true }).click()
  await page.getByRole('button', { name: 'Return to Stacks', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: 'Search dependent paths' })).toHaveValue('#181')
  expect(await page.locator('[data-graph-node]').allTextContents()).toEqual(nodes)
  await expect(page.locator('.graph-camera')).toContainText('90%')
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('Change 40')
  await page.getByRole('button', { name: 'Review #40', exact: true }).click()
  const index = graphIndex(250)
  await page.evaluate(
    (value) =>
      window.fixture.pushPrIndex({
        ...value,
        pullRequests: value.pullRequests.map((pr) =>
          pr.number === 40 ? { ...pr, title: 'Retitled while Review was open' } : pr,
        ),
      }),
    index,
  )
  await page.getByRole('button', { name: 'Return to Stacks', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: 'Search indexed PRs' })).toHaveValue('Change 40')
  await expect(page.locator('[data-graph-outline-row]').filter({ hasText: '#40' })).toContainText(
    'Selected · outside active filter',
  )
  await expect(page.getByRole('button', { name: 'Review #40', exact: true })).toBeVisible()
  expect((await getDoubleCalls(page)).filter((entry) => entry.call === 'runAction')).toEqual([])
})

test('account replacement retires the return context and display but keeps the original qualified journal for re-entry', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'stacks')
  await page
    .locator('[data-graph-outline-row]')
    .filter({ hasText: '#42' })
    .locator('button')
    .first()
    .click()
  await page.getByRole('button', { name: 'Review #42', exact: true }).click()
  await page
    .getByRole('button', { name: 'Comment on src/main/review.ts line 2 on the head', exact: true })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Comment on src/main/review.ts:2 (head)', exact: true })
    .fill('Original account unfinished text.')
  await settle(page)
  const original = await page.evaluate(async () => ({
    cli: await window.desktop.githubCliStatus!(),
    record: await window.desktop.reviewDrafts!(42),
  }))
  await page.evaluate(() =>
    window.fixture.publishCliStatus({
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement-account',
      version: '2.62.0',
      identity: 'cli:github.com:replacement-account:2',
      message: null,
    }),
  )
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Return to Stacks', exact: true })).toHaveCount(0)
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toBeNull()
  await page.evaluate((status) => window.fixture.publishCliStatus(status), original.cli)
  await refreshReviewChoices(page, true)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Comment on src/main/review.ts:2 (head)', exact: true }),
  ).toHaveValue('Original account unfinished text.')
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toEqual(original.record)
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})

test('a late account rejection preserves only the latest qualified unsent edits for their original owner', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', { name: 'Comment on src/main/review.ts line 2 on the head', exact: true })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const comment = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await comment.fill('Already saved original-account text.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('Already saved original-account text.')
  const original = await page.evaluate(async () => ({
    cli: await window.desktop.githubCliStatus!(),
    record: await window.desktop.reviewDrafts!(42),
  }))
  await holdDoubleCall(page, 'reviewSetDrafts')
  await comment.fill('Earlier queued original-account edit.')
  await expect
    .poll(async () =>
      (await getDoubleCalls(page)).some((entry) => {
        const payload = entry.args[0]
        if (
          entry.call !== 'reviewSetDrafts' ||
          !payload ||
          typeof payload !== 'object' ||
          !('drafts' in payload) ||
          !Array.isArray(payload.drafts)
        )
          return false
        const draft = payload.drafts[0]
        return (
          draft &&
          typeof draft === 'object' &&
          'body' in draft &&
          draft.body === 'Earlier queued original-account edit.'
        )
      }),
    )
    .toBe(true)
  await comment.fill('Latest unsent original-account text.')
  await expect(comment).toHaveValue('Latest unsent original-account text.')
  await page.evaluate(() =>
    window.fixture.publishCliStatus({
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement-account',
      version: '2.62.0',
      identity: 'cli:github.com:replacement-account:2',
      message: null,
    }),
  )
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await releaseDoubleCalls(page, 'reviewSetDrafts')
  await expect(page.getByText('Local review edits are not saved', { exact: true })).toBeVisible()
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toBeNull()
  await expect(page.locator('.review-view')).not.toContainText(
    'Latest unsent original-account text.',
  )
  await page.evaluate((status) => window.fixture.publishCliStatus(status), original.cli)
  await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
    ...scenarios['review-stacked'].snapshot!,
    pullRequests: scenarios['review-stacked'].snapshot!.pullRequests.map((pr) =>
      pr.number === 42 ? { ...pr, headOid: '6'.repeat(40) } : pr,
    ),
  })
  await refreshReviewChoices(page)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(comment).toHaveValue('Latest unsent original-account text.')
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toEqual(original.record)
  await expect(
    page.getByRole('group', { name: 'Submit review', exact: true }).getByRole('button'),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Save local drafts', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('Latest unsent original-account text.')
  expect((await page.evaluate(async () => window.desktop.reviewDrafts!(42)))?.comparison).toEqual(
    original.record?.comparison,
  )
  await expect(
    page.getByRole('group', { name: 'Submit review', exact: true }).getByRole('button'),
  ).toBeDisabled()
  await expect(page.getByText('Local review edits are not saved', { exact: true })).toHaveCount(0)
  await page.evaluate(() =>
    window.fixture.publishCliStatus({
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement-account',
      version: '2.62.0',
      identity: 'cli:github.com:replacement-account:3',
      message: null,
    }),
  )
  await expect(page.locator('.review-draft')).toHaveCount(0)
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toBeNull()
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})

for (const newerSet of ['additional-comment', 'explicit-clear'] as const) {
  test(`a held full-set save cannot overwrite a newer ${newerSet}`, async ({ page }) => {
    await openGallery(page, { scenario: 'review-stacked' })
    await switchDestination(page, 'review')
    await page
      .getByRole('button', {
        name: 'Comment on src/main/review.ts line 2 on the head',
        exact: true,
      })
      .click()
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
    const comment = page.getByRole('textbox', {
      name: 'Comment on src/main/review.ts:2 (head)',
      exact: true,
    })
    await comment.fill('Original saved text.')
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
      )
      .toBe('Original saved text.')
    await holdDoubleCall(page, 'reviewSetDrafts')
    await comment.fill('Latest local words must remain recoverable.')
    await expect
      .poll(async () =>
        (await getDoubleCalls(page)).some((entry) => {
          if (entry.call !== 'reviewSetDrafts') return false
          const payload = entry.args[0]
          return (
            payload !== null &&
            typeof payload === 'object' &&
            'drafts' in payload &&
            Array.isArray(payload.drafts) &&
            payload.drafts.some(
              (draft) =>
                draft !== null &&
                typeof draft === 'object' &&
                'body' in draft &&
                draft.body === 'Latest local words must remain recoverable.',
            )
          )
        }),
      )
      .toBe(true)
    for (let edit = 0; edit < 20; edit += 1)
      await comment.fill(`Superseded paused local revision ${edit}.`)
    await comment.fill('Latest local words must remain recoverable.')
    const paused = await page.evaluate(() => window.fixture.reviewCache().writes)
    expect(paused).toHaveLength(2)
    expect(paused.filter((write) => write.retained)).toHaveLength(1)
    expect(paused.find((write) => write.retained)?.authored).toMatchObject({
      record: { drafts: [{ body: 'Latest local words must remain recoverable.' }] },
    })
    // Stop holding future admissions, without releasing the already-held save.
    // A second actual journal producer accepts its own observed baseline first.
    const accepted = await page.evaluate(async (kind) => {
      window.fixture.unhold('reviewSetDrafts')
      const saved = await window.desktop.reviewDrafts!(42)
      if (!saved?.drafts[0]) throw new Error('The original authored record was not saved.')
      const drafts =
        kind === 'explicit-clear'
          ? []
          : [
              ...saved.drafts,
              {
                ...saved.drafts[0],
                id: 'external-window-comment',
                body: 'Newer independently saved words.',
              },
            ]
      return window.desktop.reviewSetDrafts!(
        {
          ...saved,
          drafts,
          updatedAt: '2999-01-01T00:00:00.000Z',
        },
        saved.updatedAt,
      )
    }, newerSet)
    expect(Date.parse(accepted.updatedAt)).toBeLessThan(Date.parse('2999-01-01T00:00:00.000Z'))
    await releaseDoubleCalls(page, 'reviewSetDrafts')
    await expect(page.getByText('Saved drafts changed', { exact: true })).toBeVisible()
    await expect(comment).toHaveValue('Latest local words must remain recoverable.')
    await expect(
      page.getByRole('group', { name: 'Submit review', exact: true }).getByRole('button'),
    ).toBeDisabled()
    expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toEqual(accepted)
    await expect
      .poll(() =>
        page.evaluate(() => window.fixture.reviewCache().writes.map((write) => write.status)),
      )
      .toEqual(['error'])
    await page
      .getByRole('button', {
        name: 'Discard unsaved edits and use saved drafts',
        exact: true,
      })
      .click()
    await expect(page.locator('.review-draft')).toHaveCount(accepted.drafts.length)
    if (newerSet === 'additional-comment') {
      await expect(comment.first()).toHaveValue('Original saved text.')
      await expect(comment.nth(1)).toHaveValue('Newer independently saved words.')
    }
    expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toEqual(accepted)
    await expect.poll(() => page.evaluate(() => window.fixture.reviewCache().writes.length)).toBe(0)
    expect(
      (await getDoubleCalls(page)).filter((entry) =>
        ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
      ),
    ).toEqual([])
  })
}

for (const availability of ['failed-headline', 'no-selected-pr'] as const) {
  test(`unattributed local recovery remains available with ${availability}`, async ({ page }) => {
    await openGallery(page, { scenario: 'review-stacked' })
    if (availability === 'failed-headline') {
      await page.evaluate(() =>
        window.fixture.failNext('reviewHeadline', 'The live PR is unavailable.'),
      )
    } else {
      await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
        ...scenarios['review-stacked'].snapshot!,
        pullRequests: [],
      })
    }
    await switchDestination(page, 'review')
    if (availability === 'failed-headline') {
      await expect(page.locator('.review-view')).toContainText('The live PR is unavailable.')
    } else {
      await expect(page.locator('.review-view')).toContainText('No pull request selected')
    }
    await page.locator('.review-actions > summary').click()
    await page.getByRole('button', { name: 'Recover unattributed local text', exact: true }).click()
    const recovery = page.getByRole('dialog', {
      name: 'Recover unattributed local text',
      exact: true,
    })
    await expect(recovery).toContainText('No unattributed local records were found.')
    expect(
      (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewDraftRecovery'),
    ).toEqual([expect.objectContaining({ args: [null] })])
    await recovery
      .getByRole('button', { name: 'Close without changing records', exact: true })
      .click()
    await expect(recovery).toHaveCount(0)
    expect(
      (await getDoubleCalls(page)).filter((entry) =>
        [
          'runAction',
          'reviewSetDrafts',
          'reviewSetViewed',
          'reviewSubmit',
          'reviewReply',
          'reviewSetResolved',
        ].includes(entry.call),
      ),
    ).toEqual([])
  })
}

test('a failed conversation refresh keeps qualified authored words editable without enabling provider writes', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await editor.fill('Words saved before the failed permissions refresh.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('Words saved before the failed permissions refresh.')
  const original = await page.evaluate(() => window.desktop.reviewDrafts!(42))
  const admittedBefore = (await getDoubleCalls(page)).filter(
    (entry) => entry.call === 'reviewSetDrafts',
  ).length
  await holdDoubleCall(page, 'reviewSetDrafts')
  await editor.fill('S1 held original-owner words.')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSetDrafts').length,
    )
    .toBe(admittedBefore + 1)
  await page.evaluate(() =>
    window.fixture.failNext('reviewThreads', 'Conversation permissions are unavailable.'),
  )
  await page.getByRole('button', { name: 'Reload review data from GitHub', exact: true }).click()
  await expect(page.locator('.review-conversation')).toContainText(
    'Conversation permissions are unavailable.',
  )
  await expect(editor).toHaveValue('S1 held original-owner words.')
  await expect(editor).toBeEnabled()
  await expect(
    page.getByRole('group', { name: 'Submit review', exact: true }).getByRole('button'),
  ).toBeDisabled()
  await editor.fill('These original-owner words remain editable while offline.')
  await settle(page)
  expect(
    (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSetDrafts'),
  ).toHaveLength(admittedBefore + 1)
  await page.evaluate(() => window.fixture.unhold('reviewSetDrafts'))
  await releaseDoubleCalls(page, 'reviewSetDrafts')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('These original-owner words remain editable while offline.')
  const accepted = await page.evaluate(() => window.desktop.reviewDrafts!(42))
  expect(Date.parse(accepted!.updatedAt)).toBeGreaterThan(Date.parse(original!.updatedAt))
  const saves = (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSetDrafts')
  expect(saves).toHaveLength(admittedBefore + 2)
  expect(saves.at(-1)?.args[1]).not.toBe(original!.updatedAt)
  await switchDestination(page, 'stacks')
  await switchDestination(page, 'review')
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(editor).toHaveValue('These original-owner words remain editable while offline.')
  expect((await page.evaluate(() => window.desktop.reviewDrafts!(42)))?.comparison).toEqual(
    original?.comparison,
  )
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})
test('historical saved draft edits persist their original comparison when live files fail', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await editor.fill('A saved against the original live comparison.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('A saved against the original live comparison.')
  const original = await page.evaluate(() => window.desktop.reviewDrafts!(42))
  await page.locator('.review-history-disclosure summary').click()
  await page.getByRole('button', { name: 'Changes since reviewed', exact: true }).click()
  await page.evaluate(() => window.fixture.failNext('reviewFiles', 'Live files are unavailable.'))
  await page.getByRole('button', { name: 'Reload review data from GitHub', exact: true }).click()
  await expect(page.locator('.review-view')).toContainText('Live files are unavailable.')
  await expect(editor).toBeEnabled()
  await editor.fill('B retained despite unavailable live files.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('B retained despite unavailable live files.')
  const saved = await page.evaluate(() => window.desktop.reviewDrafts!(42))
  expect(saved).toEqual({
    ...original,
    drafts: original!.drafts.map((draft) => ({
      ...draft,
      body: 'B retained despite unavailable live files.',
    })),
    updatedAt: saved!.updatedAt,
  })
  await expect(page.getByRole('button', { name: 'Add pending comment', exact: true })).toHaveCount(
    0,
  )
  await switchDestination(page, 'stacks')
  await switchDestination(page, 'review')
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(editor).toHaveValue('B retained despite unavailable live files.')
  expect(await page.evaluate(() => window.desktop.reviewDrafts!(42))).toEqual(saved)
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})

test('a held initial journal read cannot be dispatched as an observed absence', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  const saved = await page.evaluate(async () => {
    const files = await window.desktop.reviewFiles!(42)
    const file = files.files.find((entry) => entry.path === 'src/main/review.ts')
    if (!file || file.diff.kind !== 'text') throw new Error('The fixture text file is unavailable.')
    const hunk = file.diff.hunks.find((entry) =>
      entry.lines.some(
        (line) => line.side === 'head' && line.newLine !== null && line.newLine !== 2,
      ),
    )
    const line = hunk?.lines.find(
      (entry) => entry.side === 'head' && entry.newLine !== null && entry.newLine !== 2,
    )
    if (!hunk || !line || line.side !== 'head' || line.newLine === null) {
      throw new Error('An existing distinct head anchor is unavailable.')
    }
    const owner = (await window.desktop.reviewThreads!(42)).owner
    return window.desktop.reviewSetDrafts!(
      {
        ...owner,
        number: 42,
        comparison: files.comparison,
        drafts: [
          {
            id: 'existing-before-initial-read',
            ref: {
              path: file.path,
              side: line.side,
              line: line.newLine,
              hunkId: hunk.id,
              anchor: line.anchor,
              context: line.context,
            },
            startRef: null,
            body: 'Previously saved words must be included in the full set.',
            createdAt: '2026-09-23T10:00:00.000Z',
          },
        ],
        updatedAt: '2026-09-23T10:00:00.000Z',
      },
      null,
    )
  })
  await holdDoubleCall(page, 'reviewDrafts')
  await switchDestination(page, 'review')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewDrafts').length,
    )
    .toBeGreaterThan(0)
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Add pending comment', exact: true }),
  ).toBeDisabled()
  expect(
    (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSetDrafts'),
  ).toHaveLength(1)
  await releaseDoubleCalls(page, 'reviewDrafts')
  await expect(page.locator('.review-draft')).toHaveCount(1)
  await expect(page.locator('.review-draft textarea')).toHaveValue(saved.drafts[0].body)
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  await page
    .getByRole('textbox', {
      name: 'Comment on src/main/review.ts:2 (head)',
      exact: true,
    })
    .fill('New words added only after the saved baseline was observed.')
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.desktop.reviewDrafts!(42))?.drafts.map((draft) => draft.body),
      ),
    )
    .toEqual([saved.drafts[0].body, 'New words added only after the saved baseline was observed.'])
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})

test('Review retains pane, file comparison and unsent composition across readonly graph navigation', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', { name: 'Comment on src/main/review.ts line 2 on the head', exact: true })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const draft = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await draft.fill('Keep this unfinished review while inspecting dependencies.')
  await settle(page)
  const record = (await getDoubleCalls(page))
    .filter((call) => call.call === 'reviewSetDrafts')
    .at(-1)?.args[0]
  await switchDestination(page, 'stacks')
  await switchDestination(page, 'review')
  await expect(page.getByRole('button', { name: 'Conversation', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(draft).toHaveValue('Keep this unfinished review while inspecting dependencies.')
  const calls = await getDoubleCalls(page)
  expect(calls.filter((call) => call.call === 'reviewSetDrafts').at(-1)?.args[0]).toEqual(record)
  expect(calls.filter((call) => call.call === 'runAction')).toEqual([])
  expect(calls.filter((call) => call.call === 'reviewSubmit')).toEqual([])
})

test('same-number cross-repository Inbox navigation retires held old Review reads', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'pr-inbox-same-number' })
  await switchDestination(page, 'prInbox')
  await page.getByRole('searchbox', { name: 'Search the queue', exact: true }).fill('#81')
  await holdDoubleCall(page, 'reviewHeadline')
  await page
    .locator('.pr-inbox-item')
    .filter({ hasText: 'Add a GitHub-derived PR Inbox' })
    .getByRole('button')
    .click()
  await settle(page)
  await switchDestination(page, 'prInbox')
  const entry = page
    .locator('.pr-inbox-item')
    .filter({ hasText: 'Charge every native-stack page' })
    .getByRole('button')
  await entry.focus()
  await entry.press('Enter')
  await releaseDoubleCalls(page, 'reviewHeadline', 'newest')
  await settle(page)
  const review = page.locator('.review-view')
  await expect(review).toContainText('#81 Charge every native-stack page to the refresh budget')
  await expect(review).not.toContainText('Add a GitHub-derived PR Inbox')
  await expect(review).toContainText('checks failing')
  await releaseDoubleCalls(page, 'reviewHeadline', 'oldest')
  await settle(page)
  await expect(review).toContainText('#81 Charge every native-stack page to the refresh budget')
  await expect(review).not.toContainText('Add a GitHub-derived PR Inbox')
  await expect(review).toContainText('checks failing')
  await page.getByRole('button', { name: 'Return to PR Inbox', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: 'Search the queue', exact: true })).toHaveValue(
    '#81',
  )
  await expect(entry).toBeFocused()
  const calls = await getDoubleCalls(page)
  expect(
    calls.filter((call) => call.call === 'reviewHeadline' && call.args[0] === 81).length,
  ).toBeGreaterThanOrEqual(2)
  expect(calls.filter((call) => call.call === 'runAction')).toHaveLength(0)
})

for (const entrypoint of ['inspector', 'palette']) {
  test(`${entrypoint} opens the same readonly Review workspace`, async ({ page }) => {
    await openGallery(page, { scenario: 'review-stacked' })
    if (entrypoint === 'inspector') {
      await page.getByRole('button', { name: 'Review changes', exact: true }).click()
    } else {
      await page.getByRole('button', { name: 'Open command palette', exact: true }).click()
      await page.getByRole('combobox').fill('Review PR #42')
      await page.getByRole('option', { name: /^Review PR #42…/ }).click()
    }
    await expect(page.locator('.review-headline')).toContainText(
      '#42 Give the review workspace its own cancellation ids',
    )
    await expect(page.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Return to Branches', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const focused = document.activeElement
          return (
            focused?.id === 'workspace-view-heading-branches' ||
            (focused instanceof HTMLButtonElement &&
              (focused.textContent?.trim() === 'Review changes' ||
                focused.getAttribute('aria-label') === 'Open command palette'))
          )
        }),
      )
      .toBe(true)
    expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toHaveLength(0)
  })
}

test('a retained PR absent from the opened repository settles as unavailable rather than crashing', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'pr-inbox-queue' })
  await switchDestination(page, 'prInbox')
  await page
    .locator('.pr-inbox-item')
    .filter({ hasText: 'Add a GitHub-derived PR Inbox' })
    .getByRole('button')
    .click()
  await expect(page.locator('.review-headline')).toContainText('#81 Add a GitHub-derived PR Inbox')
  await page
    .getByRole('button', {
      name: 'design-system-specimens /Users/ada/Code/design-system-specimens',
      exact: true,
    })
    .click()
  await settle(page)
  await holdDoubleCall(page, 'reviewHeadline')
  await switchDestination(page, 'review')
  const review = page.locator('.review-view')
  await expect(review).toBeVisible()
  await expect(page.locator('.review-headline')).toHaveCount(0)
  await expect(review).not.toContainText('not in this fixture snapshot')
  await releaseDoubleCalls(page, 'reviewHeadline')
  await expect(review).toContainText('Pull request #81 is not in this fixture snapshot.')
  await expect(page.locator('.review-headline')).toHaveCount(0)
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toHaveLength(0)
})

test('full native rail supports nonadjacent readonly selection and preserves the original draft identity', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  const disclosure = page.locator('.review-stack-disclosure')
  await disclosure.locator(':scope > summary').click()
  await page.locator('.review-stack-member').filter({ hasText: '#41' }).click()
  await expect(page.locator('.review-headline')).toContainText('#41 Read pull request files')
  await page
    .getByRole('button', { name: 'Comment on src/main/review.ts line 2 on the head', exact: true })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Comment on src/main/review.ts:2 (head)', exact: true })
    .fill('This belongs to layer forty-one.')
  await settle(page)
  const original = (await getDoubleCalls(page))
    .filter((call) => call.call === 'reviewSetDrafts')
    .at(-1)?.args[0]
  await page.locator('.review-stack-disclosure > summary').click()
  await page.locator('.review-stack-member').filter({ hasText: '#43' }).click()
  await expect(page.locator('.review-headline')).toContainText('#43 Keep the review line anchors')
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await page.locator('.review-stack-disclosure > summary').click()
  await page.locator('.review-stack-member').filter({ hasText: '#41' }).click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Comment on src/main/review.ts:2 (head)', exact: true }),
  ).toHaveValue('This belongs to layer forty-one.')
  const calls = await getDoubleCalls(page)
  expect(calls.filter((call) => call.call === 'runAction')).toEqual([])
  expect(calls.filter((call) => call.call === 'reviewSubmit')).toEqual([])
  expect(calls.filter((call) => call.call === 'reviewSetDrafts').at(-1)?.args[0]).toEqual(original)
})

test('partial native membership remains distinct from metadata and endpoint failure', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stack-partial' })
  await switchDestination(page, 'review')
  await expect(page.locator('.review-stack-disclosure > summary')).toContainText(
    'Partial membership (3 loaded)',
  )
  await page.locator('.review-stack-disclosure > summary').click()
  await expect(page.locator('.review-stack-member')).toHaveCount(3)
  await expect(page.locator('.review-stack-member').filter({ hasText: '#43' })).toContainText(
    'Review unknown',
  )
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
  await openGallery(page, { scenario: 'review-stack-error' })
  await switchDestination(page, 'review')
  await expect(page.locator('.review-rail')).toContainText('did not return stack membership')
  await expect(page.locator('.review-stack-member')).toHaveCount(0)
  await expect(page.locator('.review-unified')).toBeVisible()
})

test('opening a long native rail reveals the selected layer and keeps merged and closed members identifiable', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-long-stack' })
  await switchDestination(page, 'review')
  await page.locator('.review-stack-disclosure > summary').click()
  const selected = page.locator('.review-stack-member[aria-current="page"]')
  await expect(selected).toContainText('#136')
  await expect(selected).toBeInViewport({ ratio: 1 })
  await expect(page.locator('.review-stack-member')).toHaveCount(40)
  await expect(page.locator('.review-stack-member').first()).toContainText('merged')
  await expect(page.locator('.review-stack-member').nth(1)).toContainText('closed')
  await page.keyboard.press('Tab')
  await expect(selected).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(page.locator('.review-stack-member').filter({ hasText: '#135' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(selected).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.locator('.review-stack-member').last()).toBeFocused()
  await expect(page.locator('.review-stack-member').last()).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Home')
  await expect(page.locator('.review-stack-member').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.review-headline')).toContainText('#101 Layer 1')
  await page.locator('.review-stack-disclosure > summary').click()
  await page.keyboard.press('Tab')
  await expect(page.locator('.review-stack-member[aria-current="page"]')).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Space')
  await expect(page.locator('.review-headline')).toContainText('#140 Layer 40')
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
})

test('nonadjacent selection retires held file reads instead of replacing the new layer context', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await holdDoubleCall(page, 'reviewFiles')
  await page.locator('.review-stack-disclosure > summary').click()
  await page.locator('.review-stack-member').filter({ hasText: '#41' }).click()
  await expect(page.locator('.review-headline')).toContainText('#41')
  await page.locator('.review-stack-disclosure > summary').click()
  await page.locator('.review-stack-member').filter({ hasText: '#43' }).click()
  await releaseDoubleCalls(page, 'reviewFiles', 'newest')
  await settle(page)
  await expect(page.locator('.review-headline')).toContainText('#43')
  await expect(page.locator('.review-history-disclosure > summary')).toContainText('4343434')
  await expect(page.locator('.review-unified')).toBeVisible()
  await releaseDoubleCalls(page, 'reviewFiles', 'oldest')
  await settle(page)
  await expect(page.locator('.review-headline')).toContainText('#43')
  await expect(page.locator('.review-history-disclosure > summary')).toContainText('4343434')
  await expect(page.locator('.review-history-disclosure > summary')).not.toContainText('4141414')
  await expect(page.locator('.review-unified')).toBeVisible()
  await expect(page.locator('.review-stack-member[aria-current="page"]')).toHaveCount(1)
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
})

for (const scenario of ['review-stack-stale', 'review-stack-metadata-unavailable'] as const) {
  test(`${scenario} keeps authoritative membership but never claims current passing or approved facts`, async ({
    page,
  }) => {
    await openGallery(page, { scenario })
    await switchDestination(page, 'review')
    await page.locator('.review-stack-disclosure > summary').click()
    await expect(page.locator('.review-stack-member')).toHaveCount(3)
    await expect(page.locator('.review-stack-member').first()).toContainText('Checks unknown')
    await expect(page.locator('.review-stack-member').first()).toContainText('Review unknown')
    await expect(page.locator('.review-stack-member').first()).not.toContainText('Checks passing')
    await expect(page.locator('.review-stack-member').first()).not.toContainText('Review approved')
  })
}

test('relationship disclosure names only actual local and reconciliation blocker sources', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stack-disagreement' })
  await switchDestination(page, 'review')
  await page.locator('.review-stack-disclosure > summary').click()
  await page.getByText('Blockers & relationship sources', { exact: true }).click()
  const evidence = page.locator('.review-stack-evidence')
  await expect(evidence).toContainText('#41: local branch feature/review-41 requires restack')
  await expect(evidence).toContainText('local parent comparison: 2 parent commits behind')
  await expect(evidence).toContainText('#42: local parent comparison')
  await expect(evidence).toContainText('not evidence of a restack requirement')
  await expect(evidence).toContainText('Reconciliation source: reordered')
  await expect(evidence).toContainText('Recorded parent order must be reconciled')
  await expect(evidence).not.toContainText('#43: local branch feature/review-43 requires restack')
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
})

test('nullable partial enrichment retains independent native lifecycle and draft facts', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-long-stack' })
  const headline = await page.evaluate(async () => {
    const read = window.desktop.reviewHeadline
    if (!read) throw new Error('Review headline capability unavailable')
    const value = await read(136)
    return {
      ...value,
      rail: {
        ...value.rail,
        stack: value.rail.stack && {
          ...value.rail.stack,
          pullRequests: value.rail.stack.pullRequests.map((member) =>
            member.number === 102 ? { ...member, draft: true } : member,
          ),
        },
        facts: value.rail.facts?.map((facts) =>
          facts.number === 101 || facts.number === 102
            ? {
                ...facts,
                state: 'partial' as const,
                lifecycle: null,
                draft: null,
                checks: 'unknown' as const,
                review: 'unknown' as const,
              }
            : facts,
        ),
      },
    }
  })
  await answerNextDoubleCall(page, 'reviewHeadline', headline)
  await switchDestination(page, 'review')
  await page.locator('.review-stack-disclosure > summary').click()
  await expect(page.locator('.review-stack-member').first()).toContainText('merged')
  const closedDraft = page.locator('.review-stack-member').nth(1)
  await expect(closedDraft).toContainText('closed')
  await expect(closedDraft).toContainText('Draft')
  await expect(closedDraft).toContainText('Checks unknown')
  await expect(closedDraft).toContainText('Review unknown')
  await expect(closedDraft).toContainText('partial')
})

test('native-only Stacks keeps full readonly submitted membership with wrapping titles', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-long-stack', viewport: { width: 720, height: 470 } })
  const snapshot = scenarios['review-long-stack'].snapshot
  if (!snapshot) throw new Error('Native stack scenario requires a snapshot')
  await page.evaluate(
    (value) => {
      if (!window.fixture) throw new Error('Fixture control unavailable')
      window.fixture.pushSnapshot(value)
    },
    {
      ...snapshot,
      currentBranch: snapshot.defaultBranch,
      branches: snapshot.branches.filter(
        (branch) => !branch.remote && branch.name === snapshot.defaultBranch,
      ),
    },
  )
  await switchDestination(page, 'stacks')
  const disclosure = page.locator('.graph-reconciliation')
  await disclosure.locator(':scope > summary').click()
  const submitted = disclosure.locator('.graph-submitted-order')
  await expect(submitted.locator('li')).toHaveCount(40)
  const selected = submitted.locator('button').filter({ hasText: '#136' })
  await expect(selected).toContainText('Keep the selected late layer reachable')
  expect(
    await selected.evaluate((button) => {
      const container = button.closest('.graph-reconciliation')
      if (!container) throw new Error('Submitted disclosure unavailable')
      return (
        button.getBoundingClientRect().width <= container.clientWidth &&
        container.scrollWidth <= container.clientWidth
      )
    }),
  ).toBe(true)
  await selected.click()
  await expect(page.locator('.review-headline')).toContainText('#136')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
})

test('remapped Review file and native-layer commands respect boundaries, editors, and readonly navigation', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page.getByRole('button', { name: 'Open command palette', exact: true }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  await palette.getByRole('combobox').fill('Keyboard shortcuts')
  await page.keyboard.press('Enter')
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
  await expect(shortcuts).toBeVisible()
  for (const [, label, chord] of [
    ['review.nextFile', 'Next file in review', 'Alt+Shift+N'],
    ['review.previousFile', 'Previous file in review', 'Alt+Shift+P'],
    ['review.nextLayer', 'Next layer in native stack', 'Alt+Shift+L'],
    ['review.previousLayer', 'Previous layer in native stack', 'Alt+Shift+K'],
  ] as const) {
    await shortcuts
      .getByRole('button', { name: `Change shortcut for ${label}`, exact: true })
      .click()
    await page.keyboard.press(chord)
  }
  await page.keyboard.press('Escape')
  await expect(shortcuts).toHaveCount(0)
  const fileRows = page.locator('.review-tree [data-review-row]:not([aria-expanded])')
  await fileRows.first().click()
  const current = page.locator('.review-tree [aria-current="true"]')
  const selectedPath = async () => (await current.getAttribute('aria-label'))?.split(',')[0]
  const first = await selectedPath()
  if (!first) throw new Error('The first actual file must be selected.')
  await page.keyboard.press('Alt+Shift+P')
  await expect.poll(selectedPath).toBe(first)
  await page.keyboard.press('Alt+Shift+N')
  await expect.poll(selectedPath).not.toBe(first)
  await page.keyboard.press('Alt+Shift+P')
  await expect.poll(selectedPath).toBe(first)
  await page.keyboard.press('Alt+Shift+K')
  await expect(page.locator('.review-headline-title')).toContainText('#41')
  await page.keyboard.press('Alt+Shift+K')
  await expect(page.locator('.review-headline-title')).toContainText('#41')
  await page.keyboard.press('Alt+Shift+L')
  await expect(page.locator('.review-headline-title')).toContainText('#42')
  await page.keyboard.press('Alt+Shift+L')
  await expect(page.locator('.review-headline-title')).toContainText('#43')
  await page.keyboard.press('Alt+Shift+L')
  await expect(page.locator('.review-headline-title')).toContainText('#43')
  await page.keyboard.press('Alt+Shift+K')
  await expect(page.locator('.review-headline-title')).toContainText('#42')
  await page.getByRole('button', { name: /^src\/main\/review\.ts, / }).click()
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await editor.fill('A shortcut inside this editor cannot change the layer.')
  await editor.press('Alt+Shift+L')
  await expect(page.locator('.review-headline-title')).toContainText('#42')
  await expect(editor).toBeFocused()
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})

test('a same-login credential replacement cannot reuse the previous private conversation while fresh owner proof is held', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await editor.fill('Qualified saved words before replacing the credential.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('Qualified saved words before replacing the credential.')
  const original = await page.evaluate(async () => ({
    cli: await window.desktop.githubCliStatus!(),
    record: await window.desktop.reviewDrafts!(42),
  }))
  if (original.cli.state !== 'authenticated')
    throw new Error('This fixture must prove an authenticated owner.')
  await holdDoubleCall(page, 'reviewThreads')
  await page.evaluate(
    (status) =>
      window.fixture.publishCliStatus({
        ...status,
        identity: `${status.identity}:replacement-credential`,
      }),
    original.cli,
  )
  await expect(editor).toHaveCount(0)
  await settle(page)
  // A fresh background read under B supplies its own same-number PR, not A's cache.
  await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
    ...scenarios['review-stacked'].snapshot!,
    pullRequests: scenarios['review-stacked'].snapshot!.pullRequests.map((pr) => ({
      ...pr,
      title: `${pr.title} freshly read for replacement credential`,
    })),
  })
  const readsBeforeSelection = (await getDoubleCalls(page)).filter(
    (entry) => entry.call === 'reviewThreads',
  ).length
  await refreshReviewChoices(page)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page.locator('.review-headline-title')).toContainText('#42')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewThreads').length,
    )
    .toBeGreaterThan(readsBeforeSelection)
  await expect(editor).toHaveCount(0)
  await expect(page.locator('.review-thread')).toHaveCount(0)
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await expect(page.locator('.review-conversation')).not.toContainText(
    'Qualified saved words before replacing the credential.',
  )
  await expect(
    page.getByRole('group', { name: 'Submit review', exact: true }).getByRole('button'),
  ).toBeDisabled()
  await page.evaluate(() => {
    window.fixture.unhold('reviewThreads')
    window.fixture.failNext('reviewThreads', 'Replacement owner proof is unavailable.')
  })
  await releaseDoubleCalls(page, 'reviewThreads')
  await expect(page.locator('.review-conversation')).toContainText(
    'Replacement owner proof is unavailable.',
  )
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await expect(page.locator('.review-thread')).toHaveCount(0)
  await page.evaluate((status) => window.fixture.publishCliStatus(status), original.cli)
  await releaseDoubleCalls(page, 'reviewThreads')
  await refreshReviewChoices(page, true)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(editor).toHaveValue('Qualified saved words before replacing the credential.')
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toEqual(original.record)
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})

test('same-login cross-host replacement rejects a held save without adopting private words or viewed marks', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page.getByRole('button', { name: 'Mark file as viewed', exact: true }).click()
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await editor.fill('Original host saved words.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('Original host saved words.')
  const original = await page.evaluate(async () => ({
    cli: await window.desktop.githubCliStatus!(),
    record: await window.desktop.reviewDrafts!(42),
    viewed: await window.desktop.reviewViewed!(42),
  }))
  const source = scenarios['review-stacked'].snapshot
  if (
    !source ||
    !original.viewed?.paths.includes('src/main/review.ts') ||
    original.cli.state !== 'authenticated'
  ) {
    throw new Error('The original authenticated repository must be available.')
  }
  await holdDoubleCall(page, 'reviewSetDrafts')
  await editor.fill('Earlier held edit from the original host.')
  await expect
    .poll(async () =>
      (await getDoubleCalls(page)).some(
        (entry) =>
          entry.call === 'reviewSetDrafts' &&
          JSON.stringify(entry.args[0]).includes('Earlier held edit from the original host.'),
      ),
    )
    .toBe(true)
  await editor.fill('Latest unsent original-host words.')
  await holdDoubleCall(page, 'reviewThreads')
  await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
    ...source,
    remoteUrl: 'https://git.acme.example/acme/widgets.git',
    pullRequests: [],
  })
  await page.evaluate(
    (status) =>
      window.fixture.publishCliStatus({
        ...status,
        host: 'git.acme.example',
        identity: `${status.identity}:replacement-host`,
      }),
    original.cli,
  )
  await expect(editor).toHaveCount(0)
  await expect(page.locator('.review-thread')).toHaveCount(0)
  await releaseDoubleCalls(page, 'reviewSetDrafts')
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toBeNull()
  const otherViewed = await page.evaluate(async () => window.desktop.reviewViewed!(42))
  expect(otherViewed?.paths ?? []).toEqual([])
  await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
    ...source,
    remoteUrl: 'https://git.acme.example/acme/widgets.git',
    pullRequests: source.pullRequests.map((pr) => ({
      ...pr,
      title: `${pr.title} freshly read on the replacement host`,
    })),
  })
  const beforeOwnerRead = (await getDoubleCalls(page)).filter(
    (entry) => entry.call === 'reviewThreads',
  ).length
  await refreshReviewChoices(page)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page.locator('.review-headline-title')).toContainText(
    'freshly read on the replacement host',
  )
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewThreads').length,
    )
    .toBeGreaterThan(beforeOwnerRead)
  await expect(editor).toHaveCount(0)
  await expect(page.locator('.review-thread')).toHaveCount(0)
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await expect(page.locator('.review-conversation')).not.toContainText('Original host saved words.')
  await expect(page.locator('.review-conversation')).not.toContainText(
    'Latest unsent original-host words.',
  )
  await page.evaluate(() => {
    window.fixture.unhold('reviewThreads')
    window.fixture.failNext('reviewThreads', 'Replacement-host owner proof is unavailable.')
  })
  await releaseDoubleCalls(page, 'reviewThreads')
  await expect(page.locator('.review-conversation')).toContainText(
    'Replacement-host owner proof is unavailable.',
  )
  await expect(page.locator('.review-thread')).toHaveCount(0)
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), source)
  await page.evaluate((status) => window.fixture.publishCliStatus(status), original.cli)
  await releaseDoubleCalls(page, 'reviewThreads')
  await refreshReviewChoices(page, true)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(editor).toHaveValue('Latest unsent original-host words.')
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toEqual(original.record)
  expect(await page.evaluate(async () => window.desktop.reviewViewed!(42))).toEqual(original.viewed)
  expect(
    (await getDoubleCalls(page)).filter((entry) =>
      ['runAction', 'reviewSubmit', 'reviewReply', 'reviewSetResolved'].includes(entry.call),
    ),
  ).toEqual([])
})

test('a late provider completion retires only captured A drafts while selected B remains private', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Comment on src/main/review.ts:2 (head)', exact: true })
    .fill('Private A comment dispatched before replacement.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('Private A comment dispatched before replacement.')
  const original = await page.evaluate(() => window.desktop.githubCliStatus!())
  await holdDoubleCall(page, 'reviewSubmit')
  await page.getByRole('button', { name: 'Submit 1 comment as one review', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSubmit').length,
    )
    .toBe(1)
  await holdDoubleCall(page, 'reviewThreads')
  await page.evaluate(
    (status) =>
      window.fixture.publishCliStatus({
        ...status,
        login: 'replacement-account',
        identity: 'cli:github.com:replacement-account:late-provider',
      }),
    original,
  )
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await settle(page)
  await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
    ...scenarios['review-stacked'].snapshot!,
    pullRequests: scenarios['review-stacked'].snapshot!.pullRequests.map((pr) => ({
      ...pr,
      title: `${pr.title} freshly read for replacement account`,
    })),
  })
  const beforeB = (await getDoubleCalls(page)).filter(
    (entry) => entry.call === 'reviewThreads',
  ).length
  await refreshReviewChoices(page)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page.locator('.review-headline-title')).toContainText('#42')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewThreads').length,
    )
    .toBeGreaterThan(beforeB)
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await expect(page.locator('.review-thread')).toHaveCount(0)
  await releaseDoubleCalls(page, 'reviewSubmit')
  await settle(page)
  await expect(page.locator('.review-conversation')).not.toContainText(
    'Private A comment dispatched before replacement.',
  )
  await expect(page.locator('.review-draft')).toHaveCount(0)
  expect(await page.evaluate(() => window.desktop.reviewDrafts!(42))).toBeNull()
  await page.evaluate(() => window.fixture.unhold('reviewThreads'))
  await releaseDoubleCalls(page, 'reviewThreads')
  await page.evaluate((status) => window.fixture.publishCliStatus(status), original)
  await refreshReviewChoices(page, true)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page.locator('.review-draft')).toHaveCount(0)
  expect((await page.evaluate(() => window.desktop.reviewDrafts!(42)))?.drafts).toEqual([])
  expect(
    (await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSubmit'),
  ).toHaveLength(1)
})

test('rapid autosaves retain one latest paused authored successor and reclaim completed snapshots', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  for (let edit = 0; edit < 6; edit += 1) {
    await editor.fill(`Accepted authored revision ${edit}.`)
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
      )
      .toBe(`Accepted authored revision ${edit}.`)
    await expect
      .poll(() =>
        page.evaluate(
          () => window.fixture.reviewCache().writes.filter((write) => write.retained).length,
        ),
      )
      .toBe(0)
  }
  const original = await page.evaluate(async () => ({
    cli: await window.desktop.githubCliStatus!(),
    record: await window.desktop.reviewDrafts!(42),
    authority: window.fixture.reviewCache().reads[0]?.[1],
  }))
  const savesBefore = (await getDoubleCalls(page)).filter(
    (call) => call.call === 'reviewSetDrafts',
  ).length
  await holdDoubleCall(page, 'reviewSetDrafts')
  await editor.fill('Running S1 authored version.')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSetDrafts').length,
    )
    .toBe(savesBefore + 1)
  for (let edit = 0; edit < 20; edit += 1)
    await editor.fill(`Latest paused authored revision ${edit}.`)
  await expect(editor).toHaveValue('Latest paused authored revision 19.')
  const waiting = await page.evaluate(() => window.fixture.reviewCache())
  expect(waiting.writes).toHaveLength(2)
  expect(waiting.writes.filter((write) => write.retained)).toHaveLength(1)
  expect(waiting.writes.find((write) => write.retained)?.authored).toMatchObject({
    record: { drafts: [{ body: 'Latest paused authored revision 19.' }] },
  })
  expect(
    (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSetDrafts'),
  ).toHaveLength(savesBefore + 1)
  await page.evaluate(() =>
    window.fixture.publishCliStatus({
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement-account',
      version: '2.62.0',
      identity: 'cli:github.com:replacement-account:bounded-writes',
      message: null,
    }),
  )
  await page.evaluate(
    (snapshot) => window.fixture.pushSnapshot(snapshot),
    scenarios['review-stacked'].snapshot!,
  )
  await refreshReviewChoices(page)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await expect(page.locator('.review-conversation')).not.toContainText(
    'Latest paused authored revision 19.',
  )
  await releaseDoubleCalls(page, 'reviewSetDrafts')
  await expect
    .poll(() =>
      page.evaluate(() => window.fixture.reviewCache().writes.map((write) => write.status)),
    )
    .toEqual(['error'])
  await expect
    .poll(() =>
      page.evaluate(
        (authority) =>
          window.fixture.reviewCache().reads.filter((key) => key[1] === authority).length,
        original.authority,
      ),
    )
    .toBe(0)
  const rejected = await page.evaluate(() => window.fixture.reviewCache().writes)
  expect(rejected[0]?.authored).toMatchObject({
    record: { drafts: [{ body: 'Latest paused authored revision 19.' }] },
  })
  await holdDoubleCall(page, 'reviewThreads')
  await page.evaluate((status) => window.fixture.publishCliStatus(status), original.cli)
  const proofBefore = (await getDoubleCalls(page)).filter(
    (call) => call.call === 'reviewThreads',
  ).length
  await refreshReviewChoices(page, true)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'reviewThreads').length,
    )
    .toBeGreaterThan(proofBefore)
  await expect(editor).toHaveCount(0)
  await expect(page.locator('.review-draft')).toHaveCount(0)
  await releaseDoubleCalls(page, 'reviewThreads')
  await expect(editor).toHaveValue('Latest paused authored revision 19.')
  expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toEqual(original.record)
  await editor.fill('Explicitly resumed latest authored revision.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('Explicitly resumed latest authored revision.')
  await expect.poll(() => page.evaluate(() => window.fixture.reviewCache().writes.length)).toBe(0)
  expect(
    (await getDoubleCalls(page)).filter((call) =>
      ['reviewSubmit', 'reviewReply', 'reviewSetResolved', 'runAction'].includes(call.call),
    ),
  ).toEqual([])
})

for (const outcome of ['unknown', 'refused'] as const)
  test(`late captured-A ${outcome} delivery retains original words without leaking error or history into selected B`, async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'review-stacked' })
    await switchDestination(page, 'review')
    const original = await page.evaluate(async () => ({
      cli: await window.desktop.githubCliStatus!(),
      history: await window.desktop.reviewHistory!(42),
    }))
    if (!original.history.reviewed || !original.history.latest)
      throw new Error('The original owner needs an actual reviewed-history fixture.')
    const privateHead = 'deadbeef'.repeat(5)
    const privateHistory = {
      ...original.history,
      reviewed: { ...original.history.reviewed, headOid: privateHead },
      snapshots: original.history.snapshots.map((snapshot) =>
        snapshot.reviewed ? { ...snapshot, headOid: privateHead } : snapshot,
      ),
    }
    await answerNextDoubleCall(page, 'reviewHistory', privateHistory)
    await page.getByRole('button', { name: 'Reload review data from GitHub', exact: true }).click()
    await page.locator('.review-history-disclosure summary').click()
    await page.getByLabel('Choose snapshot to compare against current head').click()
    await expect(page.getByRole('option', { name: /^deadbee /u })).toBeVisible()
    await page.keyboard.press('Escape')
    await page
      .getByRole('button', {
        name: 'Comment on src/main/review.ts line 2 on the head',
        exact: true,
      })
      .click()
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
    const editor = page.getByRole('textbox', {
      name: 'Comment on src/main/review.ts:2 (head)',
      exact: true,
    })
    const words = `Private A ${outcome} dispatched authored words.`
    await editor.fill(words)
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
      )
      .toBe(words)
    const saved = await page.evaluate(async () => window.desktop.reviewDrafts!(42))
    await holdDoubleCall(page, 'reviewSubmit')
    await page.getByRole('button', { name: 'Submit 1 comment as one review', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSubmit').length,
      )
      .toBe(1)
    await holdDoubleCall(page, 'reviewThreads')
    await page.evaluate(() =>
      window.fixture.publishCliStatus({
        state: 'authenticated',
        host: 'github.com',
        login: 'replacement-account',
        version: '2.62.0',
        identity: 'cli:github.com:replacement-account:provider-outcome',
        message: null,
      }),
    )
    await page.evaluate((snapshot) => window.fixture.pushSnapshot(snapshot), {
      ...scenarios['review-stacked'].snapshot!,
      pullRequests: scenarios['review-stacked'].snapshot!.pullRequests.map((pr) => ({
        ...pr,
        title: `${pr.title} freshly read for selected B`,
      })),
    })
    const replacementHistory = {
      ...original.history,
      reviewed: null,
      snapshots: [original.history.latest],
    }
    await answerNextDoubleCall(page, 'reviewHistory', replacementHistory)
    const bProofBefore = (await getDoubleCalls(page)).filter(
      (call) => call.call === 'reviewThreads',
    ).length
    await refreshReviewChoices(page)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(page.locator('.review-headline-title')).toContainText(
      'freshly read for selected B',
    )
    await expect
      .poll(
        async () =>
          (await getDoubleCalls(page)).filter((call) => call.call === 'reviewThreads').length,
      )
      .toBeGreaterThan(bProofBefore)
    await expect(page.locator('.review-draft')).toHaveCount(0)
    await expect(page.locator('.review-thread')).toHaveCount(0)
    await expect(page.locator('.review-history-disclosure')).not.toContainText('deadbee')
    const error = `Captured A ${outcome} outcome remains with A.`
    await page.evaluate(
      ({ outcome, error }) =>
        window.fixture.failNext(
          'reviewSubmit',
          error,
          outcome === 'unknown' ? 'ReviewOutcomeUnknownError' : 'Error',
        ),
      { outcome, error },
    )
    await releaseDoubleCalls(page, 'reviewSubmit')
    await expect(page.locator('.review-view')).not.toContainText(words)
    await expect(page.locator('.review-view')).not.toContainText(error)
    await expect(page.locator('.review-history-disclosure')).not.toContainText('deadbee')
    expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toBeNull()
    await page.evaluate(() => window.fixture.unhold('reviewThreads'))
    await releaseDoubleCalls(page, 'reviewThreads')
    await holdDoubleCall(page, 'reviewThreads')
    await page.evaluate((status) => window.fixture.publishCliStatus(status), original.cli)
    const aProofBefore = (await getDoubleCalls(page)).filter(
      (call) => call.call === 'reviewThreads',
    ).length
    await refreshReviewChoices(page, true)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await getDoubleCalls(page)).filter((call) => call.call === 'reviewThreads').length,
      )
      .toBeGreaterThan(aProofBefore)
    await expect(editor).toHaveCount(0)
    await expect(page.locator('.review-draft')).toHaveCount(0)
    await releaseDoubleCalls(page, 'reviewThreads')
    await expect(editor).toHaveValue(words)
    expect(await page.evaluate(async () => window.desktop.reviewDrafts!(42))).toEqual(saved)
    expect(
      (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSubmit'),
    ).toHaveLength(1)
    expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
  })

test('a queued save becomes immutable once dispatched and keeps its original comparison through retargeted reads', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await page
    .getByRole('button', {
      name: 'Comment on src/main/review.ts line 2 on the head',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Add pending comment', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Comment on src/main/review.ts:2 (head)',
    exact: true,
  })
  await editor.fill('Accepted initial original-comparison words.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('Accepted initial original-comparison words.')
  const original = await page.evaluate(async () => ({
    record: await window.desktop.reviewDrafts!(42),
    files: await window.desktop.reviewFiles!(42),
  }))
  const before = (await getDoubleCalls(page)).filter(
    (call) => call.call === 'reviewSetDrafts',
  ).length
  await holdDoubleCall(page, 'reviewSetDrafts')
  await editor.fill('S1 actually dispatched words.')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSetDrafts').length,
    )
    .toBe(before + 1)
  for (let edit = 0; edit < 10; edit += 1) await editor.fill(`S2 latest queued revision ${edit}.`)
  await page.evaluate(() => {
    window.fixture.release('reviewSetDrafts', 'oldest')
    window.fixture.hold('reviewSetDrafts')
  })
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSetDrafts').length,
    )
    .toBe(before + 2)
  const acceptedS1 = await page.evaluate(async () => window.desktop.reviewDrafts!(42))
  expect(acceptedS1?.drafts[0]?.body).toBe('S1 actually dispatched words.')
  const second = (await getDoubleCalls(page))
    .filter((call) => call.call === 'reviewSetDrafts')
    .at(-1)
  expect(second?.args[1]).toBe(acceptedS1?.updatedAt)
  expect(second?.args[0]).toMatchObject({
    comparison: original.record?.comparison,
    drafts: [{ body: 'S2 latest queued revision 9.' }],
  })
  await answerNextDoubleCall(page, 'reviewFiles', {
    ...original.files,
    comparison: { ...original.files.comparison, baseOid: 'e'.repeat(40), baseRef: 'retargeted' },
  })
  await page.getByRole('button', { name: 'Reload review data from GitHub', exact: true }).click()
  await expect(editor).toHaveValue('S2 latest queued revision 9.')
  for (let edit = 0; edit < 20; edit += 1)
    await editor.fill(`S3 latest original-comparison revision ${edit}.`)
  expect(
    (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSetDrafts').at(-1)?.args[0],
  ).toMatchObject({ drafts: [{ body: 'S2 latest queued revision 9.' }] })
  const paused = await page.evaluate(() => window.fixture.reviewCache().writes)
  expect(paused).toHaveLength(2)
  expect(paused.find((write) => write.retained)?.authored).toMatchObject({
    record: {
      comparison: original.record?.comparison,
      drafts: [{ body: 'S3 latest original-comparison revision 19.' }],
    },
  })
  await releaseDoubleCalls(page, 'reviewSetDrafts')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.reviewDrafts!(42))?.drafts[0]?.body),
    )
    .toBe('S3 latest original-comparison revision 19.')
  expect((await page.evaluate(async () => window.desktop.reviewDrafts!(42)))?.comparison).toEqual(
    original.record?.comparison,
  )
  await expect.poll(() => page.evaluate(() => window.fixture.reviewCache().writes.length)).toBe(0)
  const delivered = (await getDoubleCalls(page)).filter((call) => call.call === 'reviewSetDrafts')
  expect(delivered).toHaveLength(before + 3)
  expect(delivered.at(-1)?.args[1]).not.toBe(acceptedS1?.updatedAt)
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'reviewSubmit')).toEqual([])
})
