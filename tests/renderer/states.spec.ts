import { expect, test } from '@playwright/test'
import { getDispatchedActions, openGallery, releaseDoubleCalls, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { openRestackDialog, openStashDialog, selectBranchInList } from './helpers/dialogs'

test.describe('Representative long, loading, error, and recovery states', () => {
  test.describe('Shell states', () => {
    test('shell-no-repository renders onboarding state instead of workspace', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-no-repository' })
      await expect(page.getByRole('heading', { level: 1, name: 'Open a repository' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open local repository' })).toBeVisible()
      // Main workspace pane should not exist when no repository is open
      await expect(page.locator('.sidebar-repository .repo-name')).toHaveText('No repository')
    })

    test('shell-loading displays loading indicator for recent repositories', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-loading' })
      const loadingText = page.locator('.sidebar-loading')
      await expect(loadingText).toBeVisible()
      await expect(loadingText).toContainText('Loading recents')
    })

    test('shell-long-content renders long repository names with title tooltip attributes', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-long-content' })
      const repoPath = page.locator('.sidebar-repository .repo-path')
      await expect(repoPath).toBeVisible()
      // Title attribute must contain the full path for accessibility
      const titleAttr = await repoPath.getAttribute('title')
      expect(titleAttr).toBeTruthy()
      expect(titleAttr!.length).toBeGreaterThan(30)
    })

    test('shell-offline indicates desktop integration status', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-offline' })
      const connectionState = page.locator('.connection-state')
      await expect(connectionState).toBeVisible()
      await expect(connectionState).toContainText(/Desktop connected|Desktop integration/i)
    })
  })

  test.describe('Ancestry and branch structure states', () => {
    test('ancestry-requires-restack displays warning badge and restack advice', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'ancestry-requires-restack' })
      // Badge must appear on the affected branch row
      const restackBadge = page
        .getByRole('group', { name: 'Repository branches' })
        .getByText('Requires restack', { exact: true })
        .first()
      await expect(restackBadge).toBeVisible()

      // Selecting the branch must show the restack advice in details pane
      const inspector = page.getByRole('complementary', { name: 'Selected branch details' })
      await expect(inspector.getByText('Requires restack', { exact: true }).first()).toBeVisible()
      await expect(
        inspector.getByRole('button', { name: 'Restack stack…', exact: true }),
      ).toBeEnabled()
    })

    test('ancestry-cycle identifies cyclic branch ancestry with a cycle badge', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'ancestry-cycle' })
      const cycleBadge = page
        .getByRole('group', { name: 'Repository branches' })
        .getByText('cycle', { exact: true })
        .first()
      await expect(cycleBadge).toBeVisible()
    })

    test('ancestry-missing-parent identifies missing parent branch with badge', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'ancestry-missing-parent' })
      const missingBadge = page
        .getByRole('group', { name: 'Repository branches' })
        .getByText('parent missing', { exact: true })
        .first()
      await expect(missingBadge).toBeVisible()
    })
  })

  test.describe('Working changes states', () => {
    test('files-clean displays clean working tree message and empty state', async ({ page }) => {
      await openGallery(page, { scenario: 'files-clean' })
      await switchDestination(page, 'changes')

      await expect(page.getByText('Your working tree is clean.')).toBeVisible()
      // Stash button should be disabled when there are zero files
      const stashBtn = page.getByRole('button', { name: 'Stash changes', exact: true })
      await expect(stashBtn).toBeDisabled()
    })

    test('files-conflicts shows conflicted files and requires resolution before staging', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'files-conflicts' })
      await switchDestination(page, 'changes')

      const conflictStatus = page.locator('.file-status-conflicted').first()
      await expect(conflictStatus).toBeVisible()
      await expect(conflictStatus).toHaveText('!')

      // Bulk staging should be disabled when there are unresolved conflicts
      const stageAllBtn = page.getByRole('button', { name: 'Stage all', exact: true })
      await expect(stageAllBtn).toBeDisabled()
    })

    test('files-truncated displays truncation badge and notice for large previews', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'files-truncated' })
      await switchDestination(page, 'changes')

      await page
        .getByRole('button', {
          name: 'Inspect src/renderer/src/components/big-file.tsx',
          exact: true,
        })
        .click()

      // The backend-reported truncation surfaces as a badge plus an explicit note.
      await expect(page.getByText('truncated preview', { exact: true })).toBeVisible()
      await expect(page.locator('.code-region-note')).toContainText(
        'This preview is truncated. Inspect the full change in your editor before applying it.',
      )
    })
  })

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

    test('history-error displays error banner with option to reload', async ({ page }) => {
      await openGallery(page, { scenario: 'history-error' })
      await switchDestination(page, 'history')

      const errorAlert = page.locator('.history-message[role="alert"]')
      await expect(errorAlert).toBeVisible()
      await expect(errorAlert).toHaveText(
        'The commit history could not be read from this repository.',
      )

      // Reload history button is accessible
      const reloadBtn = page.getByRole('button', { name: 'Reload history' })
      await expect(reloadBtn).toBeVisible()
    })
  })

  test.describe('Pull request and stash states', () => {
    test('pull-requests-lifecycle displays distinct state badges for open, merged, closed, and draft', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'pull-requests-lifecycle' })
      await switchDestination(page, 'pullRequests')

      const prList = page.locator('.pr-list')
      for (const label of ['open', 'draft', 'closed', 'merged']) {
        await expect(prList.getByText(label, { exact: true }).first()).toBeVisible()
      }
    })

    test('stashes preserve stable OIDs across index changes (stash-stable-oid vs stash-index-shift)', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'stash-stable-oid' })
      await switchDestination(page, 'stashes')

      const firstOidElement = page.locator('.stash-row code').first()
      const stableOid = await firstOidElement.innerText()
      expect(stableOid).toBeTruthy()

      // Now open stash-index-shift
      await openGallery(page, { scenario: 'stash-index-shift' })
      await switchDestination(page, 'stashes')

      // The stable OID must still exist in the shifted list
      const oidsAfterShift = await page.locator('.stash-row code').allInnerTexts()
      expect(oidsAfterShift).toContain(stableOid)
    })
  })

  test.describe('Workflow and recovery states', () => {
    test('workflow-preview-blocked disables submit and lists specific blockers', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'workflow-preview-blocked' })
      const dialog = await openRestackDialog(page)

      // Blocker notice lists the backend-reported blockers verbatim.
      const blockerAlert = dialog
        .getByRole('alert')
        .filter({ hasText: 'Resolve before continuing' })
      await expect(blockerAlert).toContainText(
        'feature/checkout is checked out with unstaged changes.',
      )
      await expect(blockerAlert).toContainText(
        'origin/feature/checkout is ahead of the local branch; restack locally first.',
      )

      // Submit button is disabled
      const submitBtn = dialog.getByRole('button', { name: 'Restack stack', exact: true })
      await expect(submitBtn).toBeDisabled()
    })

    test('workflow-preview-stale surfaces the rejection and requires an explicit preview reload', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'workflow-preview-stale' })
      const dialog = await openRestackDialog(page)

      const submitBtn = dialog.getByRole('button', { name: 'Restack stack', exact: true })
      await submitBtn.click()
      await settle(page)

      // The backend's rejection reason is reported verbatim, and the dialog stays open.
      const failure = dialog.getByRole('alert')
      await expect(failure).toBeVisible()
      await expect(failure).toContainText(
        'The recorded stack boundaries changed while the preview was open. Reload the preview and try again.',
      )
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

    test('workflow-action-error presents the failure in the dialog without closing it or staling the preview', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'workflow-action-error' })
      const dialog = await openStashDialog(page)

      const submitBtn = dialog.getByRole('button', {
        name: 'Stash working changes',
        exact: true,
      })
      await submitBtn.click()
      await settle(page)

      // The failure is announced inside the dialog as an error alert, with the reason verbatim.
      const failure = dialog.getByRole('alert')
      await expect(failure).toBeVisible()
      await expect(failure).toContainText(
        'The working tree changed on disk, so no stash was created.',
      )

      // Dialog stays open so nothing the user typed is lost, and no stale-preview state is faked.
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText('Preview out of date', { exact: true })).toHaveCount(0)
    })

    test('workflow-partial-restack banner allows continuing the paused operation', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'workflow-partial-restack' })

      const banner = page.getByRole('region', { name: 'Git operation status' })
      await expect(banner).toBeVisible()
      await expect(banner).toContainText(/Stack restack in progress/i)

      const continueBtn = banner.getByRole('button', { name: 'Continue', exact: true })
      await expect(continueBtn).toBeEnabled()
    })

    test('workflow-conflict-recovery directs user to resolve conflicts in working changes', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'workflow-conflict-recovery' })

      const banner = page.getByRole('region', { name: 'Git operation status' })
      await expect(banner).toBeVisible()
      await expect(banner).toContainText(/conflicted file/i)

      const viewChangesBtn = banner.getByRole('button', { name: 'View changes', exact: true })
      await viewChangesBtn.click()
      await settle(page)

      await expect(page.getByRole('heading', { level: 1, name: 'Working changes' })).toBeVisible()
    })
  })
})
