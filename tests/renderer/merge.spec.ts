import { expect, test } from '@playwright/test'
import { openGallery, releaseDoubleCalls, settle } from './helpers/gallery'

/**
 * The merge dialog, driven as a person drives it: open the merge preview, send the
 * merge, and read what GitHub reports afterwards.
 *
 * A run that GitHub is still running speaks through the progress channel and then
 * returns. What the dialog shows from then on has to be the read-back, because a read
 * is newer than the progress that run pushed. Keeping the run's own progress on screen
 * after it returned would leave a finished run looking like it is still running, which
 * is exactly what the read is there to correct.
 */
test.describe('Merge reads after a run', () => {
  test('a finished run is replaced by what GitHub reports', async ({ page }) => {
    await openGallery(page, { scenario: 'pull-requests-lifecycle' })
    await page.getByRole('button', { name: 'Preview PR merge', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Merge pull request' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await settle(page)

    // Before the run: what GitHub reports for earlier requests, with one pull request
    // still running a request.
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toBeVisible()
    await expect(dialog.getByText('has not reported a result yet').first()).toBeVisible()

    // Held open, so the state the run itself publishes is observed rather than raced past.
    await page.evaluate(() => window.fixture.hold('runAction'))
    await dialog.getByRole('button', { name: 'Merge pull request', exact: true }).last().click()
    const runningMessage = dialog.getByRole('region', { name: /^Merge result/ })
    await expect(runningMessage).toBeVisible()
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toHaveCount(0)

    await releaseDoubleCalls(page, 'runAction')
    await expect(runningMessage).toHaveCount(0)
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toBeVisible()
    await expect(dialog.getByText('Merged on GitHub as 4444444444')).toBeVisible()

    // A later read is still what GitHub reports, and the control that asks for it is
    // reachable the whole time.
    await dialog.getByRole('button', { name: 'Refresh what GitHub reports' }).click()
    await expect(dialog.getByText('Merged on GitHub as 4444444444')).toBeVisible()
  })
})
