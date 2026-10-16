import { expect, test } from '@playwright/test'
import { getDispatchedActions, openGallery, releaseDoubleCalls, settle } from './helpers/gallery'
import { openRestackDialog } from './helpers/dialogs'

test.describe('Async loading and workflow recovery', () => {
  test.describe('History states', () => {
    test('history-loading shows loading indicator until released', async ({ page }) => {
      await openGallery(page, { scenario: 'history-loading' })
      await page.getByRole('button', { name: 'main', exact: true }).click()
      await page.getByRole('button', { name: 'Inspect branch history', exact: true }).click()

      const dialog = page.getByRole('dialog', { name: 'Selected committed history' })
      const loadingMsg = dialog.getByRole('status')
      await expect(loadingMsg).toBeVisible()

      // Settle the pending history call
      await releaseDoubleCalls(page, 'history')
      await settle(page)

      await expect(loadingMsg).not.toBeVisible()
      // Commits should now be rendered
      await expect(
        dialog
          .getByRole('button')
          .filter({ hasText: / · [a-f0-9]{10}$/ })
          .first(),
      ).toBeVisible()
    })

    test('a failed committed history read can be retried by reopening the selected context', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      await page.getByRole('button', { name: 'main', exact: true }).click()
      await page.evaluate(() => window.fixture.failNext('history', 'The selected ref disappeared.'))
      const trigger = page.getByRole('button', { name: 'Inspect branch history', exact: true })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: 'Selected committed history' })
      await expect(dialog.getByRole('alert')).toHaveText('The selected ref disappeared.')
      await page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
      await trigger.click()
      await expect(
        dialog
          .getByRole('button')
          .filter({ hasText: / · [a-f0-9]{10}$/ })
          .first(),
      ).toBeVisible()
      await expect(dialog.getByRole('alert')).toHaveCount(0)
      expect(await getDispatchedActions(page)).toEqual([])
    })

    test('closing a pending commit diff leaves the next history context usable', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      await page.getByRole('button', { name: 'main', exact: true }).click()
      await page.evaluate(() => window.fixture.hold('commitDiff'))
      const trigger = page.getByRole('button', { name: 'Inspect branch history', exact: true })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: 'Selected committed history' })
      const commits = dialog.getByRole('button').filter({ hasText: / · [a-f0-9]{10}$/ })
      await commits.first().click()
      await expect(dialog.getByRole('status')).toHaveText('Reading selected context…')
      await page.keyboard.press('Escape')
      await releaseDoubleCalls(page, 'commitDiff')
      await page.evaluate(() => window.fixture.unhold('commitDiff'))
      await trigger.click()
      await expect(commits.first()).toBeVisible()
      await commits.first().click()
      await expect(dialog.locator('.wb-code')).toBeVisible()
      await expect(dialog.getByRole('status')).toHaveCount(0)
      expect(await getDispatchedActions(page)).toEqual([])
    })
  })

  test.describe('Workflow and recovery states', () => {
    test('blocked previews cannot dispatch a stack operation', async ({ page }) => {
      await openGallery(page, { scenario: 'workflow-preview-blocked' })
      const dialog = await openRestackDialog(page)

      await expect(dialog.getByRole('alert')).toBeVisible()

      // Submit button is disabled
      const submitBtn = dialog.getByRole('button', { name: 'Restack stack', exact: true })
      await expect(submitBtn).toBeDisabled()
      await dialog.locator('form').dispatchEvent('submit')
      await settle(page)
      expect(await getDispatchedActions(page)).toEqual([])
    })

    test('workflow-preview-stale surfaces the rejection and requires an explicit preview reload', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'workflow-preview-stale' })
      const dialog = await openRestackDialog(page)

      const submitBtn = dialog.getByRole('button', { name: 'Restack stack', exact: true })
      await submitBtn.click()
      await settle(page)

      const failure = dialog.getByRole('alert')
      await expect(failure).toBeVisible()
      await expect(dialog).toBeVisible()
      await expect(submitBtn).toBeDisabled()
      await dialog.locator('form').dispatchEvent('submit')
      await settle(page)
      expect(await getDispatchedActions(page)).toHaveLength(1)

      // Recovery is explicit: the preview is only re-read when the user asks for it.
      const reloadBtn = dialog.getByRole('button', { name: 'Reload preview', exact: true })
      await expect(reloadBtn).toBeVisible()
      await reloadBtn.click()
      await settle(page)

      await expect(dialog.getByRole('alert')).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: 'Reload preview', exact: true })).toHaveCount(
        0,
      )
      await expect(submitBtn).toBeEnabled()
      await submitBtn.click()
      await settle(page)
      const actions = await getDispatchedActions(page)
      expect(actions).toHaveLength(2)
      expect(actions[1].type).toBe('executeStack')
      if (actions[0].type !== 'executeStack' || actions[1].type !== 'executeStack')
        throw new Error('Expected captured restack actions')
      expect(actions[1].token).not.toBe(actions[0].token)
    })
  })
})
