import { expect, test } from '@playwright/test'
import { openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'
import { DESTINATIONS, switchDestination } from './helpers/destinations'

test.describe('App destinations visual regression @visual', () => {
  test.describe('Standard desktop viewport (1440x940)', () => {
    test.beforeEach(async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        route: 'app',
        viewport: STANDARD_VIEWPORTS.standard,
      })
    })

    for (const dest of DESTINATIONS) {
      test(`captures ${dest.id} destination standard desktop`, async ({ page }) => {
        if (dest.id !== 'branches') {
          await switchDestination(page, dest.id)
        }
        await settle(page)
        await expect(page).toHaveScreenshot(`destination-${dest.id}-1440x940.png`, {
          fullPage: true,
        })
      })
    }
  })

  test.describe('Compact viewport (1000x700)', () => {
    test.beforeEach(async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        route: 'app',
        viewport: STANDARD_VIEWPORTS.compact,
      })
    })

    for (const dest of DESTINATIONS) {
      test(`captures ${dest.id} destination compact desktop`, async ({ page }) => {
        if (dest.id !== 'branches') {
          await switchDestination(page, dest.id)
        }
        await settle(page)
        await expect(page).toHaveScreenshot(`destination-${dest.id}-1000x700.png`, {
          fullPage: true,
        })
      })
    }
  })

  test.describe('Wide viewport (1920x1080)', () => {
    test.beforeEach(async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        route: 'app',
        viewport: STANDARD_VIEWPORTS.wide,
      })
    })

    for (const dest of DESTINATIONS) {
      test(`captures ${dest.id} destination wide desktop`, async ({ page }) => {
        if (dest.id !== 'branches') {
          await switchDestination(page, dest.id)
        }
        await settle(page)
        await expect(page).toHaveScreenshot(`destination-${dest.id}-1920x1080.png`, {
          fullPage: true,
        })
      })
    }
  })

  test.describe('200% zoom-equivalent reflow (720x470 CSS pixels)', () => {
    test.beforeEach(async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        route: 'app',
        viewport: STANDARD_VIEWPORTS.zoom200,
      })
    })

    for (const dest of DESTINATIONS) {
      test(`captures ${dest.id} destination at zoom-equivalent reflow`, async ({ page }) => {
        if (dest.id !== 'branches') {
          await switchDestination(page, dest.id)
        }
        await settle(page)
        await expect(page).toHaveScreenshot(`destination-${dest.id}-zoom200.png`, {
          fullPage: true,
        })
      })
    }
  })
})
