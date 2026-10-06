import { expect, test } from '@playwright/test'
import {
  getDoubleCalls,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'

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
