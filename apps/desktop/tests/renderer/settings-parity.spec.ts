import { expect, test } from '@playwright/test'
import { getDoubleCalls, openGallery } from './helpers/gallery'

async function openSettings(
  page: Parameters<typeof openGallery>[0],
  scenario: 'settings-ready' | 'settings-managed',
) {
  await openGallery(page, { scenario })
  await page.keyboard.press('Meta+k')
  if (!(await page.getByRole('dialog', { name: 'Command palette' }).isVisible()))
    await page.keyboard.press('Control+k')
  await page
    .getByRole('option', { name: /Settings/ })
    .first()
    .click()
  return page.getByRole('dialog', { name: 'Settings', exact: true })
}

test('support bundle requires a preview and exports the captured preview identity', async ({
  page,
}) => {
  const dialog = await openSettings(page, 'settings-ready')
  await dialog.getByRole('button', { name: 'Privacy', exact: true }).click()
  const create = dialog.getByRole('button', { name: 'Create support bundle', exact: true })
  await expect(create).toBeDisabled()
  await dialog.getByRole('button', { name: 'Preview bundle', exact: true }).click()
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
