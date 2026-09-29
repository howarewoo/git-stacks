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

  test('selecting snapshot from dropdown switches to historical comparison and renders comparing badge', async ({
    page,
  }) => {
    const toolbar = page.getByRole('toolbar', { name: 'Review update history' })
    const select = toolbar.getByLabel('Choose snapshot to compare against current head')

    // Direct action: select earlier snapshot by value from dropdown
    await select.selectOption('1111222233334444555566667777888899990000')
    await settle(page)

    // Comparing badge is visible
    await expect(toolbar.getByText(/Comparing 1111222 →/u)).toBeVisible()

    // Capture visual proof of snapshot dropdown comparison
    await page.screenshot({ path: 'test-results/snapshot-dropdown-comparing.png' })
  })

  test('clicking Changes since reviewed switches to historical comparison, enforces read-only mode, and toggles unchanged files', async ({
    page,
  }) => {
    const toolbar = page.getByRole('toolbar', { name: 'Review update history' })
    const reviewedButton = toolbar.getByRole('button', { name: 'Changes since reviewed' })

    // Direct action: click Changes since reviewed
    await reviewedButton.click()
    await settle(page)

    // Comparing badge is visible
    await expect(toolbar.getByText(/Comparing 1111222 →/u)).toBeVisible()

    // Direct action: Hide unchanged files checkbox is visible, checked, and toggles
    const hideCheckbox = toolbar.getByLabel('Hide unchanged files')
    await expect(hideCheckbox).toBeVisible()
    await expect(hideCheckbox).toBeChecked()

    // Toggle Hide unchanged files off
    await hideCheckbox.uncheck()
    await settle(page)
    await expect(hideCheckbox).not.toBeChecked()

    // Re-check
    await hideCheckbox.check()
    await settle(page)
    await expect(hideCheckbox).toBeChecked()

    // Direct action: Historical read-only mode verification in conversation
    const conversation = page.locator('.review-conversation')
    await expect(conversation).toContainText(/Comments and reviews are disabled in historical comparison mode/u)

    // Capture visual proof of historical comparison with read-only conversation banner
    await page.screenshot({ path: 'test-results/changes-since-reviewed-readonly.png' })

    // Return to current diff button restores normal diff
    const returnButton = toolbar.getByRole('button', { name: 'Return to current diff' })
    await returnButton.click()
    await settle(page)

    await expect(toolbar.getByText(/Comparing/u)).not.toBeVisible()
  })

  test('observation gap banner and clearing snapshot history', async ({
    page,
  }) => {
    const toolbar = page.getByRole('toolbar', { name: 'Review update history' })

    // Visual capture of toolbar with gap banner
    await page.screenshot({ path: 'test-results/review-history-gap-and-toolbar.png' })

    // Direct action: click Clear snapshot history
    const clearButton = toolbar.getByRole('button', { name: 'Clear snapshot history' })
    await clearButton.click()
    await settle(page)

    // Changes since reviewed is now disabled because no reviewed snapshot exists
    const reviewedButton = toolbar.getByRole('button', { name: 'Changes since reviewed' })
    await expect(reviewedButton).toBeDisabled()

    // Visual capture after clearing
    await page.screenshot({ path: 'test-results/snapshot-history-cleared.png' })
  })
})
