import { expect, test } from '@playwright/test'
import { getDispatchedActions, openGallery, releaseDoubleCalls, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { openRestackDialog, openStashDialog } from './helpers/dialogs'

test.describe('Async loading and workflow recovery', () => {
  test.describe('History states', () => {
    test('history-loading shows loading indicator until released', async ({ page }) => {
      await openGallery(page, { scenario: 'history-loading' })
      await switchDestination(page, 'history')

      const loadingMsg = page.getByText('Loading commits…')
      await expect(loadingMsg).toBeVisible()

      // Settle the pending history call
      await releaseDoubleCalls(page, 'history')
      await settle(page)

      await expect(loadingMsg).not.toBeVisible()
      // Commits should now be rendered
      await expect(page.locator('.history-row').first()).toBeVisible()
    })

    test('a failed refresh during a pending diff leaves History retryable', async ({ page }) => {
      await openGallery(page, { scenario: 'history-loading' })
      await page.evaluate(() => window.fixture.hold('commitDiff'))
      await switchDestination(page, 'history')
      await releaseDoubleCalls(page, 'history')
      await expect(page.getByText('Reading commit diff…')).toBeVisible()

      await page.evaluate(() => {
        const refresh = window.desktop.refresh
        window.desktop.refresh = async () => ({
          ...(await refresh()),
          headOid: 'f'.repeat(40),
        })
        window.fixture.failNext('history', 'The selected ref disappeared.')
      })
      await page.getByRole('button', { name: 'Refresh repository', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText('The selected ref disappeared.')
      const reload = page.getByRole('button', { name: 'Reload history', exact: true })
      await expect(reload).toBeEnabled()
      await expect(page.getByLabel('History branch', { exact: true })).toBeEnabled()

      await releaseDoubleCalls(page, 'commitDiff')
      await reload.click()
      await expect(page.locator('.history-row').first()).toBeVisible()
      await expect(page.getByText('Reading commit diff…')).not.toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(reload).toBeEnabled()
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
    })

    test('a failed stash retains the dialog and entered message', async ({ page }) => {
      await openGallery(page, { scenario: 'workflow-action-error' })
      const dialog = await openStashDialog(page)
      const messageInput = dialog.getByRole('textbox', { name: 'Message (optional)', exact: true })
      await messageInput.fill('WIP survives a failed stash')

      const submitBtn = dialog.getByRole('button', {
        name: 'Stash working changes',
        exact: true,
      })
      await submitBtn.click()
      await settle(page)

      const failure = dialog.getByRole('alert')
      await expect(failure).toBeVisible()

      await expect(dialog).toBeVisible()
      await expect(messageInput).toHaveValue('WIP survives a failed stash')
    })

    test('workflow-conflict-recovery directs user to resolve conflicts in working changes', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'workflow-conflict-recovery' })

      const banner = page.getByRole('region', { name: 'Git operation status' })
      await expect(banner).toBeVisible()

      const viewChangesBtn = banner.getByRole('button', { name: 'View changes', exact: true })
      await viewChangesBtn.click()
      await settle(page)

      await expect(page.getByRole('heading', { level: 1, name: 'Working changes' })).toBeVisible()
    })
  })
})
