import { expect, type Locator, type Page } from '@playwright/test'
import { settle } from './gallery'

/** Select a qualified local ref without adopting its directory or changing Git state. */
export async function selectBranchInList(page: Page, branchName: string): Promise<void> {
  const ref = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`
  const name = ref.replace(/^refs\/heads\//, '')
  const trigger = page.getByRole('button', { name, exact: true })
  await expect(trigger, `Branch ref ${ref} must be listed`).toHaveCount(1)
  const identity = await page
    .locator('.bw-lane-row')
    .filter({ has: trigger })
    .getAttribute('data-branch-id')
  expect(JSON.parse(identity!).at(-1)).toBe(ref)
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('complementary', { name: 'Selected branch details' })).toBeVisible()
  await settle(page)
}

/** Capture the row's exact existing worktree before preparing a stack preview. */
export async function openRestackDialog(
  page: Page,
  branchName = 'feature/checkout',
): Promise<Locator> {
  await selectBranchInList(page, branchName)
  const name = branchName.replace(/^refs\/heads\//, '')
  const row = page.locator('.bw-lane-row').filter({
    has: page.getByRole('button', { name, exact: true }),
  })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'More branch and worktree actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Preview restack…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Restack stack', exact: true })
  await expect(dialog).toBeVisible()
  await settle(page)
  return dialog
}

/** Management is reached through full review for the explicitly selected PR association. */
export async function openManagePullRequestDialog(
  page: Page,
  branchName = 'feature/checkout-tests',
): Promise<Locator> {
  await selectBranchInList(page, branchName)
  await page.getByRole('button', { name: 'Review pull request', exact: true }).click()
  const actions = page.locator('.review-actions')
  await actions
    .locator('summary')
    .filter({ hasText: /^PR actions$/ })
    .click()
  await expect(actions).toHaveAttribute('open', '')
  await page.getByRole('button', { name: 'Manage pull request', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await settle(page)
  return dialog
}
