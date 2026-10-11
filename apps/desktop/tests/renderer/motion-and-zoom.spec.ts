import { expect, test } from '@playwright/test'
import { getViewFilterInput, openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'
import { DESTINATIONS, switchDestination } from './helpers/destinations'

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

    // Every destination — not just the two the suite used to name — has to
    // survive the 200% reflow without pushing actions off-screen.
    for (const destination of DESTINATIONS) {
      test(`${destination.label} is fully operable at 720x470 reflow`, async ({ page }) => {
        await switchDestination(page, destination.id)
        await settle(page)

        const heading = page.getByRole('heading', { level: 1, name: destination.heading })
        await expect(heading).toBeVisible()

        const hasHorizontalScroll = await page.evaluate(() => {
          return document.documentElement.scrollWidth > window.innerWidth
        })
        expect(hasHorizontalScroll).toBe(false)

        if (destination.id === 'changes') {
          await expect(
            page.getByRole('heading', { level: 2, name: 'Staged', exact: true }),
          ).toBeVisible()
          await expect(
            page.getByRole('heading', { level: 2, name: 'Unstaged', exact: true }),
          ).toBeVisible()
        }

        const box = await heading.boundingBox()
        expect(box).not.toBeNull()
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(720)
        }
      })
    }
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

for (const viewport of [
  { width: 1000, height: 700 },
  { width: 1440, height: 940 },
  { width: 1920, height: 1080 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`integrated destination and populated Review keyboard reachability at ${viewport.width}×${viewport.height} ${theme}`, async ({
      page,
    }) => {
      await openGallery(page, {
        scenario: 'shell-long-content',
        viewport,
        colorScheme: theme,
        reducedMotion: 'reduce',
      })
      const nav = page.getByRole('navigation', { name: 'Workspace destinations' })
      // Branches is initially active: visit Stacks first so returning to Branches
      // is a real keyboard navigation and every heading must receive focus.
      const destinations = [
        ...DESTINATIONS.filter((destination) => destination.id === 'stacks'),
        ...DESTINATIONS.filter((destination) => destination.id !== 'stacks'),
      ]
      for (const destination of destinations) {
        const control = nav.getByRole('button', {
          name: new RegExp(`^${destination.label}(\\s|$)`),
        })
        await control.focus()
        await control.press('Enter')
        const heading = page.getByRole('heading', {
          level: 1,
          name: destination.heading,
          exact: true,
        })
        await expect(heading).toBeVisible()
        await expect(heading).toBeFocused()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        )
        await test.info().attach(`integrated-destination-${destination.id}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        })
      }
      await openGallery(page, {
        scenario: 'review-stacked',
        viewport,
        colorScheme: theme,
        reducedMotion: 'reduce',
      })
      await switchDestination(page, 'review')
      const panes = page.getByRole('group', { name: 'Review contextual panes' })
      // Code starts active; return to it after activating all other populated panes.
      for (const pane of ['Conversation', 'Commits', 'Description & reviewers', 'Checks', 'Code']) {
        const control = panes.getByRole('button', { name: pane, exact: true })
        await control.focus()
        await control.press('Enter')
        await expect(control).toHaveAttribute('aria-pressed', 'true')
        if (pane === 'Code') await expect(page.locator('.review-line').first()).toBeVisible()
        if (pane === 'Conversation')
          await expect(page.getByRole('textbox', { name: 'Review summary' })).toBeVisible()
        if (pane === 'Commits') await expect(page.locator('.review-context')).toBeVisible()
        if (pane === 'Description & reviewers')
          await expect(page.locator('.review-about')).toBeVisible()
        if (pane === 'Checks')
          await expect(
            page.getByRole('button', { name: 'Refresh checks', exact: true }),
          ).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        )
        await test.info().attach(`integrated-review-${pane}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        })
      }
      await test.info().attach('integrated-review-consumer', {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
    })

    test(`all nine Settings sections remain keyboard reachable at ${viewport.width}×${viewport.height} ${theme}`, async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'settings-ready', viewport, colorScheme: theme })
      await page.keyboard.press('Meta+k')
      if (!(await page.getByRole('dialog', { name: 'Command palette' }).isVisible()))
        await page.keyboard.press('Control+k')
      await page
        .getByRole('option', { name: /Settings/ })
        .first()
        .click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
      for (const section of [
        'GitHub CLI',
        'GitHub',
        'Notifications',
        'Git',
        'Appearance',
        'Updates',
        'Shortcuts',
        'Privacy',
        'Diagnostics',
      ]) {
        const control = nav.getByRole('button', { name: section, exact: true })
        await control.focus()
        await control.press('Enter')
        await expect(control).toHaveAttribute('aria-current', 'page')
        await page.keyboard.press('Tab')
        const active = await page.evaluate(() => {
          const element = document.activeElement!
          const rect = element.getBoundingClientRect()
          return {
            inDialog: Boolean(element.closest('[role="dialog"]')),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          }
        })
        expect(active.inDialog).toBe(true)
        expect(active.left).toBeGreaterThanOrEqual(0)
        expect(active.right).toBeLessThanOrEqual(viewport.width)
        expect(active.top).toBeGreaterThanOrEqual(0)
        expect(active.bottom).toBeLessThanOrEqual(viewport.height)
      }
      await test.info().attach('integrated-settings-consumer', {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    })
  }
}
