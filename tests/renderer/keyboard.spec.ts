import { expect, test } from '@playwright/test'
import { getDispatchedActions, getOpenedExternalUrls, openGallery, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { openDeleteLocalBranchDialog, openNewBranchDialog } from './helpers/dialogs'
import { assertFocusRestored, assertModalDialogFocusTrap } from './helpers/keyboard'

test.describe('Keyboard routes and accessibility navigation', () => {
  test('global shortcut Cmd+K / Ctrl+K focuses repository search input', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const searchInput = page.getByRole('textbox', {
      name: 'Search branches, files, and pull requests',
    })
    await expect(searchInput).not.toBeFocused()

    // Dispatch Cmd+K (macOS) or Ctrl+K
    await page.keyboard.press('Meta+k')
    if (!(await searchInput.evaluate((el) => el === document.activeElement))) {
      await page.keyboard.press('Control+k')
    }

    await expect(searchInput).toBeFocused()
  })

  test('workspace navigation buttons are keyboard activatable', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const nav = page.getByRole('navigation', { name: 'Workspace destinations' })
    const changesBtn = nav.getByRole('button', { name: /^Working changes/ })

    await changesBtn.focus()
    await expect(changesBtn).toBeFocused()

    await page.keyboard.press('Enter')
    await settle(page)

    // Heading should now show Working changes
    await expect(page.getByRole('heading', { level: 1, name: 'Working changes' })).toBeVisible()
  })

  test('segmented control branch filters respond to keyboard activation', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const filters = page.getByRole('group', { name: 'Branch filters' })
    const remoteBtn = filters.getByRole('button', { name: 'Remote' })

    await remoteBtn.focus()
    await expect(remoteBtn).toBeFocused()
    await page.keyboard.press('Space')
    await settle(page)

    await expect(remoteBtn).toHaveAttribute('aria-pressed', 'true')
  })

  test('branch row selection button and PR link are separate focusable controls', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'pull-requests-checks' })

    // Find the branch row that has a PR link
    const prLink = page.getByRole('link', { name: /Open pull request #/ }).first()
    await expect(prLink).toBeVisible()

    // PR link must be focusable independently from the row selection button
    await prLink.focus()
    await expect(prLink).toBeFocused()

    // Activating PR link opens external URL without switching branch or mutating
    await page.keyboard.press('Enter')
    await settle(page)

    const openedUrls = await getOpenedExternalUrls(page)
    expect(openedUrls.length).toBeGreaterThan(0)
    expect(openedUrls[0]).toContain('github.com')

    // No GitAction should have been dispatched
    const actions = await getDispatchedActions(page)
    expect(actions).toEqual([])
  })

  test('dialog form initial focus lands on first input and tabs through fields', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openNewBranchDialog(page)

    const firstField = dialog.getByRole('textbox', { name: 'Branch name', exact: true })
    await expect(firstField).toBeFocused()

    // Tab moves to Parent branch select
    await page.keyboard.press('Tab')
    const parentField = dialog.getByRole('combobox', { name: 'Parent branch', exact: true })
    await expect(parentField).toBeFocused()

    // Tab moves to Cancel button
    await page.keyboard.press('Tab')
    const cancelBtn = dialog.getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancelBtn).toBeFocused()
  })

  test('dropdown menu opens with keyboard, navigates with arrows, closes with Escape', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const menuTrigger = page.getByRole('button', { name: 'More Git actions', exact: true })
    await menuTrigger.focus()
    await expect(menuTrigger).toBeFocused()

    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(
      menu.getByRole('menuitem', { name: 'Merge into current branch…', exact: true }),
    ).toBeFocused()

    await page.keyboard.press('ArrowDown')
    await expect(
      menu.getByRole('menuitem', { name: 'Force push with lease…', exact: true }),
    ).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Stash changes…', exact: true })).toBeDisabled()
    await expect(
      menu.getByRole('menuitem', { name: 'Browse commit history', exact: true }),
    ).toBeFocused()

    // Escape closes menu and restores focus to the trigger button
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await assertFocusRestored(page, menuTrigger, 'closing More Git actions menu via Escape')
  })

  test('modal dialog contains focus trap and returns focus to trigger on close', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const trigger = page.getByRole('button', { name: 'New branch', exact: true }).first()
    await trigger.focus()
    await expect(trigger).toBeFocused()

    const dialog = await openNewBranchDialog(page)

    // Assert focus trap: Tab and Shift+Tab never escape dialog containment
    await assertModalDialogFocusTrap(page, dialog, 'Create a branch')

    // Close dialog via Escape
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    // Focus must be returned to the trigger button that launched it
    await assertFocusRestored(page, trigger, 'closing Create a branch dialog via Escape')
  })

  test('destructive dialog opens on Cancel button for safety and traps focus', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openDeleteLocalBranchDialog(page, 'feature/checkout-tests')

    // APG modal dialog pattern: destructive dialog initial focus targets Cancel button
    const cancelBtn = dialog.getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancelBtn).toBeFocused()

    await assertModalDialogFocusTrap(page, dialog, 'Delete local branch?')

    await cancelBtn.click()
    await expect(dialog).not.toBeVisible()
  })

  test('2400-line diff region is keyboard focusable and scrolls with the keyboard', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'files-long-content' })
    await switchDestination(page, 'changes')

    await page
      .getByRole('button', {
        name: 'Inspect src/renderer/src/components/bulk-generated-surface.tsx',
        exact: true,
      })
      .click()

    const diffRegion = page.getByRole('region', {
      name: 'Unified diff, 1000 of 2400 lines shown',
      exact: true,
    })
    await expect(diffRegion).toBeVisible()

    await diffRegion.focus()
    await expect(diffRegion).toBeFocused()

    const before = await diffRegion.evaluate((el) => el.scrollTop)
    await page.keyboard.press('PageDown')
    await expect
      .poll(() => diffRegion.evaluate((el) => el.scrollTop), { timeout: 5_000 })
      .toBeGreaterThan(before)
  })

  test('recovery banner controls are keyboard accessible and dispatch continue', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'workflow-partial-restack' })

    const banner = page.getByRole('region', { name: 'Git operation status' })
    await expect(banner).toBeVisible()

    const continueBtn = banner.getByRole('button', { name: 'Continue', exact: true })
    await continueBtn.focus()
    await expect(continueBtn).toBeFocused()

    await page.keyboard.press('Enter')
    await settle(page)

    const actions = await getDispatchedActions(page)
    expect(actions).toContainEqual({ type: 'stackContinue' })
  })
})
