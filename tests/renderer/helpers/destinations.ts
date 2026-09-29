import { expect, type Locator, type Page } from '@playwright/test'
import { settle } from './gallery'

export const DESTINATIONS = [
  { id: 'branches', label: 'Branches', heading: 'Branches' },
  { id: 'stacks', label: 'Stacks', heading: 'Stacks' },
  { id: 'history', label: 'History', heading: 'History' },
  { id: 'changes', label: 'Working changes', heading: 'Working changes' },
  { id: 'pullRequests', label: 'Pull requests', heading: 'Pull requests' },
  { id: 'stashes', label: 'Stashes', heading: 'Stashes' },
] as const

export type DestinationId = (typeof DESTINATIONS)[number]['id']

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
 * Navigates to one of the six actual App destinations via user click,
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
