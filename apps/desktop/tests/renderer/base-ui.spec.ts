import { expect, test } from '@playwright/test'
import { getDispatchedActions, openGallery } from './helpers/gallery'

test('a branch picker preserves the empty choice and Escape dismisses only its popup', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'shell-connected' })
  await page.getByRole('button', { name: 'More Git actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Merge into current branch…', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Merge into current branch', exact: true })
  const picker = dialog.getByRole('combobox', { name: 'Branch to merge', exact: true })
  const submit = dialog.getByRole('button', { name: 'Merge into current branch', exact: true })
  await expect(submit).toBeDisabled()
  await picker.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).not.toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(picker).toBeFocused()
  await expect(submit).toBeDisabled()

  await picker.click()
  await page.getByRole('option', { name: 'main', exact: true }).click()
  await expect(submit).toBeEnabled()
  await picker.click()
  await page.getByRole('option', { name: 'Choose a branch', exact: true }).click()
  await expect(submit).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await getDispatchedActions(page)).toEqual([])
})

test('checkbox labels and Space both update controlled state while mixed state stays distinct', async ({
  page,
}) => {
  await openGallery(page, { route: 'controls' })
  const checkbox = page.getByRole('checkbox', { name: 'Include untracked files', exact: true })
  await expect(checkbox).toBeChecked()
  await page.getByText('Include untracked files', { exact: true }).click()
  await expect(checkbox).not.toBeChecked()
  await checkbox.focus()
  await page.keyboard.press('Space')
  await expect(checkbox).toBeChecked()
  await expect(
    page.getByRole('checkbox', { name: 'Mixed selection', exact: true }),
  ).toHaveAttribute('aria-checked', 'mixed')
})

test('a segmented filter cannot deselect its current choice and supports arrow navigation', async ({
  page,
}) => {
  await openGallery(page, { route: 'controls' })
  const group = page.getByRole('group', { name: 'Repository filter', exact: true })
  const all = group.getByRole('button', { name: 'All', exact: true })
  await all.click()
  await expect(all).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowRight')
  const local = group.getByRole('button', { name: 'Local', exact: true })
  await expect(local).toBeFocused()
  await page.keyboard.press('Space')
  await expect(local).toHaveAttribute('aria-pressed', 'true')
  await expect(all).toHaveAttribute('aria-pressed', 'false')
})
