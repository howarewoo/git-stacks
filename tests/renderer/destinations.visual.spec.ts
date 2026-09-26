import { expect, test } from '@playwright/test'
import { openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'
import { DESTINATIONS, switchDestination } from './helpers/destinations'

for (const size of ['compact', 'standard', 'wide'] as const) {
  const viewport = STANDARD_VIEWPORTS[size]
  test.describe(`${size} desktop destinations @visual`, () => {
    for (const destination of DESTINATIONS) {
      test(`captures ${destination.id}`, async ({ page }) => {
        await openGallery(page, { scenario: 'shell-connected', viewport })
        if (destination.id !== 'branches') await switchDestination(page, destination.id)
        await settle(page)
        await expect(page).toHaveScreenshot(
          `destination-${destination.id}-${viewport.width}x${viewport.height}.png`,
          { fullPage: true },
        )
      })
    }
  })
}
