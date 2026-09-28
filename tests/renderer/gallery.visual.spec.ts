import { expect, test } from '@playwright/test'
import { openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'

test.describe('Design system gallery specimens visual regression @visual', () => {
  test.use({ viewport: STANDARD_VIEWPORTS.standard })

  test('captures Foundations specimen (#/design-system-specimen)', async ({ page }) => {
    await openGallery(page, {
      scenario: 'shell-connected',
      route: 'foundations',
    })
    await settle(page)
    await expect(page).toHaveScreenshot('specimen-foundations.png', { fullPage: true })
  })
})
