import { expect, test } from '@playwright/test'
import { getDoubleCalls, holdDoubleCall, openGallery, releaseDoubleCalls } from './helpers/gallery'

test('hydrated settings survive section changes and untouched tool blur does not clear them', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'github-cli-authenticated' })
  await page.evaluate(async () => {
    await window.desktop.updateSettings!({
      github: { host: 'git.company.test' },
      git: { editor: 'zed', mergeTool: 'meld' },
    })
  })
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  if (!(await palette.isVisible())) await page.keyboard.press('Control+k')
  await expect(palette).toBeVisible()
  await palette.getByRole('option', { name: /^Settings/ }).click()

  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'GitHub', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Host', exact: true })).toHaveValue(
    'git.company.test',
  )
  await dialog.getByRole('button', { name: 'Git', exact: true }).click()
  const editor = dialog.getByRole('textbox', { name: 'Editor', exact: true })
  await expect(editor).toHaveValue('zed')
  await expect(dialog.getByRole('textbox', { name: 'Merge tool', exact: true })).toHaveValue('meld')

  const earlierWrites = (await getDoubleCalls(page)).filter(
    (entry) => entry.call === 'updateSettings',
  ).length
  await holdDoubleCall(page, 'updateSettings')
  await editor.focus()
  await dialog.getByRole('button', { name: 'GitHub', exact: true }).click()
  await expect
    .poll(async () =>
      (await getDoubleCalls(page))
        .filter((entry) => entry.call === 'updateSettings')
        .slice(earlierWrites),
    )
    .toEqual([{ call: 'updateSettings', args: [{ git: { editor: 'zed' } }] }])
  await releaseDoubleCalls(page, 'updateSettings')
})
