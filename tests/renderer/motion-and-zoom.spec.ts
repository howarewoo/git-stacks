import { expect, test } from '@playwright/test'
import { openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'

test.describe('Responsive pane adaptation, compact reflow, and reduced motion', () => {
  test.describe('Pane adaptation across window sizes', () => {
    test('1000x700 keeps all primary controls reachable without horizontal page scroll', async ({
      page,
    }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        viewport: STANDARD_VIEWPORTS.compact,
      })
      await settle(page)

      // Verify no unintended horizontal scrollbar at 1000px width
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(hasHorizontalScroll).toBe(false)

      // Navigation, toolbar, and main content remain visible and operable
      await expect(page.getByRole('navigation', { name: 'Workspace destinations' })).toBeVisible()
      await expect(page.getByRole('toolbar', { name: 'Repository actions' })).toBeVisible()
      await expect(page.getByRole('heading', { level: 1, name: 'Branches' })).toBeVisible()
    })

    test('1440x940 standard layout provides fully accessible 3-pane workbench', async ({
      page,
    }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        viewport: STANDARD_VIEWPORTS.standard,
      })
      await settle(page)

      const sidebar = page.locator('.sidebar')
      const mainPane = page.locator('.main-pane')
      const detailsPane = page.locator('.details-pane')

      await expect(sidebar).toBeVisible()
      await expect(mainPane).toBeVisible()
      await expect(detailsPane).toBeVisible()

      // Document does not overflow horizontally
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(hasHorizontalScroll).toBe(false)
    })

    test('1920x1080 wide desktop keeps all destinations and details reachable', async ({
      page,
    }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        viewport: STANDARD_VIEWPORTS.wide,
      })
      await settle(page)

      await expect(page.getByRole('navigation', { name: 'Workspace destinations' })).toBeVisible()
      await expect(page.locator('.main-pane')).toBeVisible()
      await expect(page.locator('.details-pane')).toBeVisible()

      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(hasHorizontalScroll).toBe(false)
    })
  })

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
      expect(navCount).toBe(6)

      for (let i = 0; i < navCount; i++) {
        const button = navButtons.nth(i)
        const box = await button.boundingBox()
        expect(box).not.toBeNull()
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(720)
        }
      }

      const searchInput = page.getByRole('textbox', {
        name: 'Search branches, files, and pull requests',
      })
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

      const searchInput = page.getByRole('textbox', {
        name: 'Search branches, files, and pull requests',
      })
      await searchInput.fill('feature')
      await expect(searchInput).toHaveValue('feature')
    })

    test('animations are active when reduced-motion is no-preference', async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-loading',
        reducedMotion: 'no-preference',
      })

      const spinner = page.locator('.sidebar-loading .animate-spin')
      await expect(spinner).toBeVisible()

      const animationName = await spinner.evaluate((el) => {
        return window.getComputedStyle(el).animationName
      })
      expect(animationName).toContain('spin')
    })
  })
})
