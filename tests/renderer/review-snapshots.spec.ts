import { expect, test } from '@playwright/test'
import { openGallery, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'

test.beforeEach(async ({ page }) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await switchDestination(page, 'review')
  await settle(page)
})

test.describe('Review snapshot history and comparison', () => {
  test('the history toolbar is rendered with snapshot selector and changes-since-reviewed button', async ({
    page,
  }) => {
    const toolbar = page.getByRole('toolbar', { name: 'Review update history' })
    await expect(toolbar).toBeVisible()

    const select = toolbar.getByLabel('Choose snapshot to compare against current head')
    await expect(select).toBeVisible()

    const reviewedButton = toolbar.getByRole('button', { name: 'Changes since reviewed' })
    await expect(reviewedButton).toBeVisible()
    await expect(reviewedButton).toBeEnabled()
  })

  test('clicking Changes since reviewed switches to historical comparison and shows comparing badge', async ({
    page,
  }) => {
    const toolbar = page.getByRole('toolbar', { name: 'Review update history' })
    const reviewedButton = toolbar.getByRole('button', { name: 'Changes since reviewed' })

    await reviewedButton.click()
    await settle(page)

    // Comparing badge is visible
    await expect(toolbar.getByText(/Comparing 1111222 →/u)).toBeVisible()

    // Hide unchanged files checkbox is visible and checked
    const hideCheckbox = toolbar.getByLabel('Hide unchanged files')
    await expect(hideCheckbox).toBeVisible()
    await expect(hideCheckbox).toBeChecked()

    // Frozen banner in conversation explains comments are disabled in historical comparison mode
    const conversation = page.locator('.review-conversation')
    await expect(conversation).toContainText(/Comments and reviews are disabled in historical comparison mode/u)

    // Return to current diff button restores normal diff
    const returnButton = toolbar.getByRole('button', { name: 'Return to current diff' })
    await returnButton.click()
    await settle(page)

    await expect(toolbar.getByText(/Comparing/u)).not.toBeVisible()
  })

  test('clearing snapshot history clears local snapshots and resets to current diff', async ({
    page,
  }) => {
    const toolbar = page.getByRole('toolbar', { name: 'Review update history' })
    const clearButton = toolbar.getByRole('button', { name: 'Clear snapshot history' })

    await clearButton.click()
    await settle(page)

    // Changes since reviewed is now disabled because no reviewed snapshot exists
    const reviewedButton = toolbar.getByRole('button', { name: 'Changes since reviewed' })
    await expect(reviewedButton).toBeDisabled()
  })
})
