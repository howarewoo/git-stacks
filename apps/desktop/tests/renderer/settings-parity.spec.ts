import { expect, test } from '@playwright/test'
import { getDoubleCalls, holdDoubleCall, openGallery, releaseDoubleCalls } from './helpers/gallery'

async function openSettings(
  page: Parameters<typeof openGallery>[0],
  scenario: 'settings-ready' | 'settings-managed',
) {
  await openGallery(page, { scenario })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  return page.getByRole('dialog', { name: 'Settings', exact: true })
}

test('support bundle requires a preview and exports the captured preview identity', async ({
  page,
}) => {
  const dialog = await openSettings(page, 'settings-ready')
  await dialog.getByRole('button', { name: 'Privacy', exact: true }).click()
  const create = dialog.getByRole('button', { name: 'Create support bundle', exact: true })
  await expect(create).toBeDisabled()
  await holdDoubleCall(page, 'supportBundlePreview')
  await dialog.getByRole('button', { name: 'Preview bundle', exact: true }).click()
  const preview = dialog.getByRole('button', { name: 'Preview bundle', exact: true })
  await expect(preview).toHaveAttribute('aria-busy', 'true')
  await expect(preview.locator('[data-slot="button-spinner"]')).toHaveCount(1)
  await expect(create).not.toHaveAttribute('aria-busy', 'true')
  await releaseDoubleCalls(page, 'supportBundlePreview')
  await expect(create).toBeEnabled()
  await expect(dialog).toContainText('The Git executable path is withheld.')
  await create.click()
  const calls = await getDoubleCalls(page)
  expect(
    calls.filter((call) => call.call === 'exportSupportBundle').map((call) => call.args),
  ).toEqual([['bundle-redacted']])
})

test('managed privacy and update controls remain locked without dispatching a write', async ({
  page,
}) => {
  const dialog = await openSettings(page, 'settings-managed')
  await dialog.getByRole('button', { name: 'Privacy', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Include local paths' })).toBeDisabled()
  await expect(dialog).toContainText('Local paths may not leave this computer')
  await dialog.getByRole('button', { name: 'Updates', exact: true }).click()
  await expect(dialog).toContainText('Fixed to the stable channel')
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'updateSettings')).toEqual([])
})
