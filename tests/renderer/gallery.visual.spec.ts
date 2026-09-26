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

  test('captures Shell specimen (#/design-system-shell-specimen)', async ({ page }) => {
    await openGallery(page, {
      scenario: 'shell-connected',
      route: 'shell',
    })
    await settle(page)
    await expect(page).toHaveScreenshot('specimen-shell.png', { fullPage: true })
  })

  test('captures Data surfaces specimen (#/design-system-data-specimen)', async ({ page }) => {
    await openGallery(page, {
      scenario: 'shell-connected',
      route: 'data',
    })
    await settle(page)
    await expect(page).toHaveScreenshot('specimen-data-surfaces.png', { fullPage: true })
  })

  test('captures Dialog specimen (#/design-system-dialog-specimen)', async ({ page }) => {
    await openGallery(page, {
      scenario: 'shell-connected',
      route: 'dialog',
    })
    await settle(page)
    await expect(page).toHaveScreenshot('specimen-dialogs.png', { fullPage: true })
  })
})
