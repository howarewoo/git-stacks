import { expect, test } from '@playwright/test'
import { openGallery } from './helpers/gallery'
import { DESTINATIONS, destinationScenario, switchDestination } from './helpers/destinations'
import { assertNoAxeViolations } from './helpers/axe'

// Browser automation does not certify native keyboard, VoiceOver/NVDA or window chrome.
for (const theme of ['light', 'dark'] as const) {
  for (const destination of DESTINATIONS) {
    test(`actual ${destination.id} accessibility in ${theme}`, async ({ page }) => {
      await openGallery(page, { scenario: destinationScenario(destination.id), colorScheme: theme })
      await switchDestination(page, destination.id)
      await assertNoAxeViolations(page, `actual ${destination.id} ${theme}`)
      expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
    })
  }
  test(`actual narrow inspection sheet contains and restores focus in ${theme}`, async ({
    page,
  }) => {
    await openGallery(page, {
      scenario: 'cutover-reference',
      colorScheme: theme,
      viewport: { width: 1000, height: 700 },
    })
    const branch = page.getByRole('button', { name: 'feat/worktree-registry', exact: true })
    await branch.click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await assertNoAxeViolations(page, `actual inspection sheet ${theme}`)
    await page.keyboard.press('Tab')
    expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(branch).toBeFocused()
    expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  })
}
