import { expect, test } from '@playwright/test'
import { getViewFilterInput, openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'

test.describe('Responsive pane adaptation, compact reflow, and reduced motion', () => {
  test.describe('Compact reflow equivalent (720x470)', () => {
    test.beforeEach(async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        viewport: STANDARD_VIEWPORTS.zoom200,
      })
      await settle(page)
    })

    test('primary controls remain within visible viewport bounds without horizontal page scroll', async ({
      page,
    }) => {
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(hasHorizontalScroll).toBe(false)

      const navButtons = page.locator('.workspace-nav button')
      const navCount = await navButtons.count()

      for (let i = 0; i < navCount; i++) {
        const button = navButtons.nth(i)
        const box = await button.boundingBox()
        expect(box).not.toBeNull()
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(720)
        }
      }

      const searchInput = getViewFilterInput(page)
      await expect(searchInput).toBeVisible()
      const searchBox = await searchInput.boundingBox()
      expect(searchBox).not.toBeNull()
      if (searchBox) {
        expect(searchBox.x).toBeGreaterThanOrEqual(0)
        expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(720)
      }
    })

    test('working changes destination is fully operable at 720x470 reflow', async ({ page }) => {
      await switchDestination(page, 'changes')
      await settle(page)

      const changesHeading = page.getByRole('heading', { level: 1, name: 'Working changes' })
      await expect(changesHeading).toBeVisible()

      await expect(
        page.getByRole('heading', { level: 2, name: 'Staged', exact: true }),
      ).toBeVisible()
      await expect(
        page.getByRole('heading', { level: 2, name: 'Unstaged', exact: true }),
      ).toBeVisible()

      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(hasHorizontalScroll).toBe(false)
    })
  })

  test.describe('Reduced motion behavior', () => {
    test('animations and transitions are suppressed when prefers-reduced-motion is reduce', async ({
      page,
    }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        reducedMotion: 'reduce',
      })
      await settle(page)

      const buttonTransition = await page
        .locator('.gs-button')
        .first()
        .evaluate((el) => {
          const style = window.getComputedStyle(el)
          return parseFloat(style.transitionDuration) || 0
        })
      expect(buttonTransition).toBeLessThanOrEqual(0.01)

      const searchInput = getViewFilterInput(page)
      await searchInput.fill('feature')
      await expect(searchInput).toHaveValue('feature')
    })
  })
})
