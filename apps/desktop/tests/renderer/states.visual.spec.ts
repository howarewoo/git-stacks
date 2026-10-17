import { expect, test } from '@playwright/test'
import type { ScenarioName } from './fixtures/manifest'
import { openGallery } from './helpers/gallery'

const cases: { scenario: ScenarioName }[] = [
  { scenario: 'shell-no-repository' },
  { scenario: 'shell-long-content' },
  { scenario: 'ancestry-deep' },
  { scenario: 'history-error' },
  { scenario: 'workflow-conflict-recovery' },
]

for (const { scenario } of cases) {
  test(`${scenario} state @visual`, async ({ page }) => {
    await openGallery(page, { scenario })
    if (scenario === 'history-error') {
      await page.getByRole('button', { name: 'main', exact: true }).click()
      await page.getByRole('button', { name: 'Inspect branch history', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Selected committed history' })).toBeVisible()
    } else if (scenario === 'workflow-conflict-recovery') {
      await page.getByRole('button', { name: 'feature/checkout', exact: true }).click()
      await page.getByRole('tab', { name: /^Changes/ }).click()
      await expect(page.getByRole('tabpanel')).toBeVisible()
    }
    await expect(page).toHaveScreenshot(`${scenario}.png`)
  })
}
