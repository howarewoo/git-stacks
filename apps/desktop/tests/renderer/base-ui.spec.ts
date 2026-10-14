import { expect, test } from '@playwright/test'
import { openGallery } from './helpers/gallery'

test('checkbox labels and Space both update controlled state while mixed state stays distinct', async ({
  page,
}) => {
  await openGallery(page, { route: 'foundations' })
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
  await openGallery(page, { route: 'foundations' })
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
