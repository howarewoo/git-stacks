import { expect, type Locator, type Page } from '@playwright/test'
import { settle } from './gallery'

/** Select a qualified local ref without adopting its directory or changing Git state. */
export async function selectBranchInList(page: Page, branchName: string): Promise<void> {
  const ref = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`
  const name = ref.replace(/^refs\/heads\//, '')
  const trigger = page
    .getByRole('button', { name, exact: true })
    .and(page.locator('.bw-branch-name'))
  await expect(trigger, `Branch ref ${ref} must be listed`).toHaveCount(1)
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
  const ref = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`
  const row = page.locator('.bw-lane-row').filter({
    has: page.getByRole('button', { name: ref.replace(/^refs\/heads\//, ''), exact: true }),
  })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'More branch and worktree actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Preview restack…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Restack stack', exact: true })
  await expect(dialog).toBeVisible()
  await settle(page)
  return dialog
}

/** Capture the row's exact existing worktree before preparing a merge preview. */
export async function openMergeDialog(
  page: Page,
  branchName = 'feature/checkout-tests',
): Promise<Locator> {
  await selectBranchInList(page, branchName)
  const ref = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`
  const row = page.locator('.bw-lane-row').filter({
    has: page.getByRole('button', { name: ref.replace(/^refs\/heads\//, ''), exact: true }),
  })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'More branch and worktree actions', exact: true }).click()
  await page
    .getByRole('menuitem', { name: 'Preview reviewed downstack merge…', exact: true })
    .click()
  const execution = page.getByRole('dialog', { name: 'Choose explicit execution directory' })
  if (await execution.isVisible()) {
    await execution.getByRole('combobox', { name: 'Explicit execution directory' }).click()
    await page.getByRole('option', { name: '/Users/ada/Code/git-stacks', exact: true }).click()
    await execution.getByRole('button', { name: 'Prepare exact scoped preview' }).click()
  }
  const dialog = page.getByRole('dialog', { name: 'Merge pull request', exact: true })
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
  if (await actions.isVisible()) {
    const open = await actions.getAttribute('open')
    if (open === null) {
      await actions
        .locator('summary')
        .filter({ hasText: /^PR actions$/ })
        .click()
      await expect(actions).toHaveAttribute('open', '')
    }
  }
  await page.getByRole('button', { name: 'Manage pull request', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await settle(page)
  return dialog
}
