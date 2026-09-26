import { expect, test } from '@playwright/test'
import { openGallery, settle, STANDARD_VIEWPORTS } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import {
  openCreatePrDialog,
  openDeleteLocalBranchDialog,
  openDropStashDialog,
  openForcePushDialog,
  openMergeDialog,
  openNewBranchDialog,
  openPublishDialog,
  openPullDialog,
  openRestackDialog,
  openStashDialog,
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

  test('captures "Delete local branch?" with force checkbox and typed confirmation', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openDeleteLocalBranchDialog(page, 'feature/checkout-tests')
    const forceCheckbox = dialog.getByLabel('Delete even if not merged')
    await forceCheckbox.check()
    await expect(dialog.getByLabel('Type the branch name to confirm')).toBeVisible()
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-delete-branch-forced.png')
  })

  test('captures "Stash working changes" form dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'files-staged' })
    const dialog = await openStashDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-stash-changes.png')
  })

  test('captures "Force push with lease" dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openForcePushDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-force-push.png')
  })

  test('captures "Pull changes" dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openPullDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-pull.png')
  })

  test('captures "Merge into current branch" dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openMergeDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-merge.png')
  })

  test('captures "Create pull request" dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await switchDestination(page, 'pullRequests')
    const dialog = await openCreatePrDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-create-pr.png')
  })

  test('captures "Restack stack" reviewed dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'ancestry-requires-restack' })
    const dialog = await openRestackDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-restack-stack.png')
  })

  test('captures "Publish stack" reviewed dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'ancestry-requires-restack' })
    const dialog = await openPublishDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-publish-stack.png')
  })

  test('captures "Drop this stash?" destructive confirmation dialog', async ({ page }) => {
    await openGallery(page, { scenario: 'stash-stable-oid' })
    await switchDestination(page, 'stashes')
    const dialog = await openDropStashDialog(page)
    await settle(page)
    await expect(dialog).toHaveScreenshot('dialog-drop-stash.png')
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
