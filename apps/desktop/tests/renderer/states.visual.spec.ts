import { expect, test } from '@playwright/test'
import type { ScenarioName } from './fixtures/manifest'
import { openGallery } from './helpers/gallery'
import { switchDestination, type DestinationId } from './helpers/destinations'

const cases: { scenario: ScenarioName; destination?: DestinationId }[] = [
  { scenario: 'shell-no-repository' },
  { scenario: 'shell-long-content' },
  { scenario: 'ancestry-deep' },
  { scenario: 'history-error', destination: 'history' },
  { scenario: 'workflow-conflict-recovery', destination: 'changes' },
]

for (const { scenario, destination } of cases) {
  test(`${scenario} state @visual`, async ({ page }) => {
    await openGallery(page, { scenario })
    if (destination) await switchDestination(page, destination)
    await expect(page).toHaveScreenshot(`${scenario}.png`)
  })
}
