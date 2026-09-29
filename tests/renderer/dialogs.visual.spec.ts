import { expect, test } from '@playwright/test'
import { openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'
import {
  openDeleteLocalBranchDialog,
  openNewBranchDialog,
  openRestackDialog,
} from './helpers/dialogs'

test.describe('Representative dialogs visual regression @visual', () => {
  test.use({ viewport: STANDARD_VIEWPORTS.standard })

  test('captures "Create a branch" form dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openNewBranchDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-create-branch.png')
  })

  test('captures "Delete local branch?" destructive dialog (initial)', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openDeleteLocalBranchDialog(page, 'feature/checkout-tests')
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-delete-branch-initial.png')
  })

  test('captures "Restack stack" reviewed dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'ancestry-requires-restack' })
    const dialog = await openRestackDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-restack-stack.png')
  })
})

for (const size of ['compact', 'wide'] as const) {
  for (const kind of ['form', 'reviewed', 'destructive'] as const) {
    test(`${kind} dialog at ${size} viewport @visual`, async ({ page }) => {
      await openGallery(page, {
        scenario: 'ancestry-requires-restack',
        viewport: STANDARD_VIEWPORTS[size],
      })
      const dialog =
        kind === 'form'
          ? await openNewBranchDialog(page)
          : kind === 'reviewed'
            ? await openRestackDialog(page)
            : await openDeleteLocalBranchDialog(page, 'feature/checkout-tests')
      await expect(dialog).toBeVisible()
      await expect(page).toHaveScreenshot(`dialog-${kind}-${size}.png`)
    })
  }
}
