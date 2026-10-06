import { expect, test } from '@playwright/test'
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

for (const destination of ['pullRequests', 'stacks'] as const) {
  test(`${destination} PR links open readonly Review rather than management`, async ({ page }) => {
    await openGallery(page, { scenario: 'review-stacked' })
    await switchDestination(page, destination)
    const link =
      destination === 'pullRequests'
        ? page.getByRole('button', { name: /^Open pull request #42 / })
        : page.getByRole('button', {
            name: '#42 Give the review workspace its own cancellation ids',
            exact: true,
          })
    await link.focus()
    await link.press('Enter')
    await expect(page.locator('.review-view')).toContainText(
      '#42 Give the review workspace its own cancellation ids',
    )
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Synchronization actions' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open command palette' })).toBeVisible()
    const calls = await getDoubleCalls(page)
    expect(calls.some((call) => call.call === 'reviewHeadline' && call.args[0] === 42)).toBe(true)
    expect(calls.filter((call) => call.call === 'runAction')).toHaveLength(0)
  })
}

test('same-number cross-repository Inbox navigation retires held old Review reads', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'pr-inbox-same-number' })
  await switchDestination(page, 'prInbox')
  await holdDoubleCall(page, 'reviewHeadline')
  await page
    .locator('.pr-inbox-item')
    .filter({ hasText: 'Add a GitHub-derived PR Inbox' })
    .getByRole('button')
    .click()
  await settle(page)
  await switchDestination(page, 'prInbox')
  await page
    .locator('.pr-inbox-item')
    .filter({ hasText: 'Charge every native-stack page' })
    .getByRole('button')
    .click()
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
  await expect(page.getByText('Build a stack from a branch', { exact: true })).toBeVisible()
  await page.locator('.stack-submitted-order > summary').click()
  await expect(page.locator('.stack-submitted-order li')).toHaveCount(40)
  const selected = page.locator('.stack-submitted-order button').filter({ hasText: '#136' })
  expect(
    await selected.evaluate((button) => {
      const disclosure = button.closest('.stack-submitted-order')
      if (!disclosure) throw new Error('Submitted disclosure unavailable')
      return (
        button.getBoundingClientRect().width <= disclosure.clientWidth &&
        disclosure.scrollWidth <= disclosure.clientWidth
      )
    }),
  ).toBe(true)
  await selected.click()
  await expect(page.locator('.review-headline')).toContainText('#136')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toEqual([])
})
