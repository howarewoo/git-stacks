import { expect, type Locator, type Page } from '@playwright/test'
import { settle } from './gallery'
import { DEFAULT_SCENARIO, type ScenarioName } from '../fixtures/manifest'

export const DESTINATIONS = [
  { id: 'branches', label: 'Branches', heading: 'Branches' },
  { id: 'stacks', label: 'Stacks', heading: 'Stacks' },
  { id: 'history', label: 'History', heading: 'History' },
  { id: 'changes', label: 'Working changes', heading: 'Working changes' },
  { id: 'pullRequests', label: 'Pull requests', heading: 'Pull requests' },
  {
    id: 'prInbox',
    label: 'PR Inbox',
    heading: 'PR Inbox',
    // Captured from the scenario that owns the queue. Every other destination
    // is captured from the generic connected repository, which holds pull
    // request #41 and none of the rows the Inbox shows: a capture there would
    // show a queue whose rows open a workspace that does not contain them.
    scenario: 'pr-inbox-queue',
  },
  { id: 'review', label: 'Review', heading: 'Review' },
  { id: 'stashes', label: 'Stashes', heading: 'Stashes' },
  { id: 'diagnostics', label: 'Diagnostics', heading: 'Diagnostics' },
] as const

export type DestinationId = (typeof DESTINATIONS)[number]['id']

/**
 * The scenario one destination's captures are taken from.
 *
 * Named per destination rather than shared by every capture, so each one is
 * taken from a fixture that can actually show it: the Inbox's rows open
 * repositories that the generic connected fixture does not hold.
 */
export function destinationScenario(id: DestinationId): ScenarioName {
  const destination = DESTINATIONS.find((entry) => entry.id === id)
  return destination && 'scenario' in destination ? destination.scenario : DEFAULT_SCENARIO
}

/**
 * Returns the navigation button Locator for the given workspace destination.
 */
export function getDestinationNavItem(page: Page, id: DestinationId): Locator {
  const dest = DESTINATIONS.find((d) => d.id === id)
  if (!dest) {
    throw new Error(`Unknown destination id: ${id}`)
  }
  // The nav item label is followed by an optional count span, so match by prefix regex.
  return page
    .getByRole('navigation', { name: 'Workspace destinations' })
    .getByRole('button', { name: new RegExp(`^${dest.label}(\\s|$)`) })
}

/**
 * Navigates to one of the actual App destinations via user click,
 * asserts the destination h1 heading is visible, and waits for layout to settle.
 */
export async function switchDestination(page: Page, id: DestinationId): Promise<void> {
  const dest = DESTINATIONS.find((d) => d.id === id)
  if (!dest) {
    throw new Error(`Unknown destination id: ${id}`)
  }
  const navItem = getDestinationNavItem(page, id)
  await navItem.click()
  await expect(page.getByRole('heading', { level: 1, name: dest.heading })).toBeVisible({
    timeout: 10_000,
  })
  await settle(page)
}
