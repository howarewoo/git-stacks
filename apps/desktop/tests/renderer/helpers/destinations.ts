import { expect, type Page } from '@playwright/test'
import { settle } from './gallery'
import { DEFAULT_SCENARIO, type ScenarioName } from '../fixtures/manifest'
import { scenarios } from '../fixtures/scenarios'

export const DESTINATIONS = [
  { id: 'branches', label: 'Branches', heading: 'Branches & worktrees' },
  { id: 'pullRequests', label: 'Pull requests', heading: 'Pull requests' },
  { id: 'attention', label: 'Needs attention', heading: 'Needs attention', scenario: 'pr-inbox-queue' },
  { id: 'activity', label: 'Activity', heading: 'Activity' },
] as const

export type DestinationId = (typeof DESTINATIONS)[number]['id'] | 'review' | 'notifications'

export function destinationScenario(id: DestinationId): ScenarioName {
  const destination = DESTINATIONS.find((entry) => entry.id === id)
  return destination && 'scenario' in destination ? destination.scenario : DEFAULT_SCENARIO
}

/** Navigate through the production shell, including qualified PR selection for Review. */
export async function switchDestination(page: Page, id: DestinationId): Promise<void> {
  if (id === 'notifications') {
    await page.getByRole('button', { name: 'Notifications', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Optional Notifications', exact: true })).toBeVisible()
  } else if (id === 'review') {
    if (await page.getByRole('heading', { level: 1, name: 'Review', exact: true }).isVisible()) return
    const review = page.getByRole('button', { name: 'Review pull request', exact: true })
    if (!(await review.isVisible())) {
      await switchDestination(page, 'branches')
      const scenario = await page.evaluate(() => window.fixture.scenario) as ScenarioName
      const snapshot = scenarios[scenario]?.snapshot
      if (snapshot?.pullRequests.some((pr) => pr.head === snapshot.currentBranch))
        await page.getByRole('button', { name: snapshot.currentBranch!, exact: true }).click()
      else await page.locator('.bw-subtitle').filter({ hasText: /#\d+/ }).first().click()
    }
    await review.click()
    await expect(page.getByRole('heading', { level: 1, name: 'Review', exact: true })).toBeVisible()
  } else {
    const destination = DESTINATIONS.find((entry) => entry.id === id)!
    await page.getByRole('complementary', { name: 'Workspace navigation', exact: true })
      .getByRole('button', { name: new RegExp(`^${destination.label}(\\s|$)`) }).click()
    await expect(page.getByRole('heading', { level: 1, name: destination.heading, exact: true })).toBeVisible()
  }
  await settle(page)
}
