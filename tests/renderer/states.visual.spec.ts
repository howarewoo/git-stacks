import { expect, test } from '@playwright/test'
import type { ScenarioName } from './fixtures/manifest'
import { openGallery } from './helpers/gallery'
import { switchDestination, type DestinationId } from './helpers/destinations'

const cases: { scenario: ScenarioName; destination?: DestinationId }[] = [
  { scenario: 'shell-no-repository' },
  { scenario: 'shell-loading' },
  { scenario: 'shell-long-content' },
  { scenario: 'shell-offline' },
  { scenario: 'ancestry-deep' },
  { scenario: 'ancestry-cycle' },
  { scenario: 'ancestry-missing-parent' },
  { scenario: 'ancestry-remote-consolidated' },
  { scenario: 'ancestry-requires-restack', destination: 'stacks' },
  { scenario: 'files-conflicts', destination: 'changes' },
  { scenario: 'files-long-content', destination: 'changes' },
  { scenario: 'files-renamed', destination: 'changes' },
  { scenario: 'history-loading', destination: 'history' },
  { scenario: 'history-error', destination: 'history' },
  { scenario: 'pull-requests-lifecycle', destination: 'pullRequests' },
  { scenario: 'pull-requests-checks', destination: 'pullRequests' },
  { scenario: 'pull-requests-unavailable', destination: 'pullRequests' },
  { scenario: 'stash-stable-oid', destination: 'stashes' },
  { scenario: 'workflow-partial-restack' },
  { scenario: 'workflow-conflict-recovery', destination: 'changes' },
]

for (const { scenario, destination } of cases) {
  test(`${scenario} state @visual`, async ({ page }) => {
    await openGallery(page, { scenario })
    if (destination) await switchDestination(page, destination)
    await expect(page).toHaveScreenshot(`${scenario}.png`)
  })
}
