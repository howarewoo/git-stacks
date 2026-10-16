import { expect, type Page } from '@playwright/test'
import { settle } from './gallery'
import { DEFAULT_SCENARIO, type ScenarioName } from '../fixtures/manifest'
import { scenarios } from '../fixtures/scenarios'

/** Current production surfaces; secondary Notifications remains a modal. */
export const DESTINATIONS = [
  { id: 'branches', label: 'Branches', heading: 'Branches & worktrees' },
  { id: 'pullRequests', label: 'Pull requests', heading: 'Pull requests' },
  { id: 'attention', label: 'Needs attention', heading: 'Needs attention' },
  { id: 'activity', label: 'Activity', heading: 'Activity' },
  { id: 'review', label: 'Review', heading: 'Review', scenario: 'review-stacked' },
] as const

export type DestinationId = (typeof DESTINATIONS)[number]['id'] | 'notifications'

export function destinationScenario(id: DestinationId): ScenarioName {
  const destination = DESTINATIONS.find((entry) => entry.id === id)
  return destination && 'scenario' in destination ? destination.scenario : DEFAULT_SCENARIO
}

/** Navigate through genuine sidebar/PR controls, never install a fixture-only route. */
export async function switchDestination(page: Page, id: DestinationId): Promise<void> {
  const notifications = page.getByRole('dialog', { name: 'Optional Notifications', exact: true })
  if (await notifications.isVisible()) {
    await notifications.getByRole('button', { name: 'Close', exact: true }).click()
  }
  const sidebar = page.locator('.bw-sidebar')
  if (id === 'notifications') {
    await page.getByRole('button', { name: 'Notifications', exact: true }).click()
    await expect(notifications).toBeVisible()
  } else {
    const destination = DESTINATIONS.find((entry) => entry.id === id)!
    await sidebar
      .getByRole('button', {
        name: new RegExp(`^${id === 'review' ? 'Pull requests' : destination.label}(\\s|$)`),
      })
      .click()
    if (id === 'review') {
      const scenario = await page.evaluate(() => window.fixture.scenario)
      const source = scenarios[scenario as ScenarioName]?.snapshot
      const selected = source?.branches.find((branch) => branch.name === source.currentBranch)?.pr
      const number = selected?.number ?? source?.pullRequests[0]?.number
      if (!number) throw new Error(`Scenario ${scenario} has no source-confirmed PR to review.`)
      await page
        .locator('.wb-pr-row')
        .filter({ hasText: new RegExp(`^#${number}\\s`) })
        .click()
      await expect(page.locator('.review-view')).toBeVisible()
    }
    await expect(
      page.getByRole('heading', { level: 1, name: destination.heading, exact: true }),
    ).toBeVisible()
  }
  await settle(page)
}
