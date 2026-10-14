import { expect, test } from '@playwright/test'
import { openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'
import { openRestackDialog } from './helpers/dialogs'

test.describe('Representative dialogs visual regression @visual', () => {
  test.use({ viewport: STANDARD_VIEWPORTS.standard })

  test('captures "Restack stack" reviewed dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'ancestry-requires-restack' })
    const dialog = await openRestackDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-restack-stack.png')
  })
})

for (const size of ['compact', 'wide'] as const) {
  for (const kind of ['reviewed'] as const) {
    test(`${kind} dialog at ${size} viewport @visual`, async ({ page }) => {
      await openGallery(page, {
        scenario: 'ancestry-requires-restack',
        viewport: STANDARD_VIEWPORTS[size],
      })
      const dialog = await openRestackDialog(page)
      await expect(dialog).toBeVisible()
      await expect(page).toHaveScreenshot(`dialog-${kind}-${size}.png`)
    })
  }
}
