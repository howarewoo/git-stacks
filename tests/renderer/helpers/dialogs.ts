import { expect, type Locator, type Page } from '@playwright/test'
import { settle } from './gallery'

/**
 * Opens the 'Create a branch' dialog from the main toolbar.
 */
export async function openNewBranchDialog(page: Page): Promise<Locator> {
  const trigger = page.getByRole('button', { name: 'New branch', exact: true }).first()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Create a branch' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await settle(page)
  return dialog
}

/**
 * Selects a branch by its exact name from the branch list.
 */
export async function selectBranchInList(page: Page, branchName: string): Promise<void> {
  const branchRow = page
    .locator('.branch-row')
    .filter({ has: page.locator(`.branch-name-line strong:text-is("${branchName}")`) })
  await expect(branchRow, `Branch row for ${branchName} must be listed`).toHaveCount(1)
  // The row itself is the treeitem; clicking its name is the selection gesture.
  await branchRow.locator('.branch-name-line strong').click()
  const inspector = page.locator('.details-pane')
  await expect(
    inspector.getByRole('heading', { level: 2, name: branchName, exact: true }),
  ).toBeVisible({
    timeout: 10_000,
  })
  await settle(page)
}

/**
 * Opens the 'Delete local branch?' dialog from the details pane.
 */
export async function openDeleteLocalBranchDialog(
  page: Page,
  branchName: string = 'feature/checkout-tests',
): Promise<Locator> {
  await selectBranchInList(page, branchName)
  const inspector = page.locator('.details-pane')
  const deleteBtn = inspector.getByRole('button', { name: 'Delete local branch', exact: true })
  await deleteBtn.click()
  const dialog = page.getByRole('dialog', { name: 'Delete local branch?' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await settle(page)
  return dialog
}

/**
 * Opens the toolbar 'More Git actions' dropdown menu.
 */
export async function openMoreGitActionsMenu(page: Page): Promise<Locator> {
  const menuTrigger = page.getByRole('button', { name: 'More Git actions', exact: true })
  await menuTrigger.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible({ timeout: 10_000 })
  await settle(page)
  return menu
}

/**
 * Opens the 'Stash working changes' dialog via More Git actions menu.
 */
export async function openStashDialog(page: Page): Promise<Locator> {
  await openMoreGitActionsMenu(page)
  const stashItem = page.getByRole('menuitem', { name: 'Stash changes…', exact: true })
  await stashItem.click()
  const dialog = page.getByRole('dialog', { name: 'Stash working changes' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await settle(page)
  return dialog
}

/**
 * Opens the 'Force push with lease' dialog via More Git actions menu.
 */
export async function openForcePushDialog(page: Page): Promise<Locator> {
  await openMoreGitActionsMenu(page)
  const item = page.getByRole('menuitem', { name: 'Force push with lease…', exact: true })
  await item.click()
  const dialog = page.getByRole('dialog', { name: 'Force push with lease' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await settle(page)
  return dialog
}

/**
 * Opens the 'Restack stack' dialog from the details pane.
 */
export async function openRestackDialog(page: Page): Promise<Locator> {
  const inspector = page.getByRole('complementary', { name: 'Selected branch details' })
  const restackBtn = inspector.getByRole('button', { name: 'Restack stack…', exact: true })
  await restackBtn.click()
  const dialog = page.getByRole('dialog', { name: 'Restack stack' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await settle(page)
  return dialog
}
