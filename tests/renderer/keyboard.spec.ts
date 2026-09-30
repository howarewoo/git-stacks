import { expect, type Locator, test } from '@playwright/test'
import {
  failNextDoubleCall,
  getDispatchedActions,
  getOpenedExternalUrls,
  getViewFilterInput,
  openGallery,
  settle,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { openDeleteLocalBranchDialog, openNewBranchDialog } from './helpers/dialogs'
import { assertFocusRestored, assertModalDialogFocusTrap } from './helpers/keyboard'

/**
 * The names of the rows a paged surface currently has mounted, in order.
 *
 * A mounted window can slide between two assertions, and `nth()` over a row
 * locator silently changes which branch it points at when it does — which is
 * how a roving move that re-based an arrow key onto the whole list could still
 * look correct. Naming the branch a row stands for keeps the assertion on the
 * row the reader is actually standing on.
 */
const mountedRowNames = (rows: Locator) =>
  rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label') ?? ''),
  )

test.describe('Keyboard routes and accessibility navigation', () => {
  test('the search shortcut focuses the in-view filter and the palette shortcut opens the palette', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const searchInput = getViewFilterInput(page)
    await expect(searchInput).not.toBeFocused()

    // `/` is the in-view filter shortcut and is separate from the global palette.
    await page.keyboard.press('/')
    await expect(searchInput).toBeFocused()

    await searchInput.blur()
    await page.keyboard.press('Meta+k')
    if (!(await page.getByRole('dialog', { name: 'Command palette' }).isVisible())) {
      await page.keyboard.press('Control+k')
    }
    // The palette takes focus; the background is hidden from the reader while it is open.
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('combobox')).toBeFocused()
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

  test('a branch row is one treeitem and its pull request link is a separate control', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'pull-requests-checks' })

    const row = page.getByRole('tree', { name: 'Repository branches' }).getByRole('treeitem')
    await expect(row.first()).toBeVisible()

    // Exactly one row of the tree is in the tab order; the rest are reached with
    // arrow keys, so Tab does not walk the whole stack one row at a time.
    const tabStops = await row.evaluateAll((rows) => rows.filter((el) => el.tabIndex === 0).length)
    expect(tabStops).toBe(1)

    // The pull request link is a control of its own, separate from row selection.
    const prLink = page.getByRole('link', { name: /Open pull request #/ }).first()
    await expect(prLink).toBeVisible()
    await prLink.focus()
    await expect(prLink).toBeFocused()

    // Activating it opens the external URL without selecting the branch or mutating.
    await page.keyboard.press('Enter')
    await settle(page)

    const openedUrls = await getOpenedExternalUrls(page)
    expect(openedUrls.length).toBeGreaterThan(0)
    expect(openedUrls[0]).toContain('github.com')
    expect(await getDispatchedActions(page)).toEqual([])
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

  test('a dialog cancelled under an already-raised error keeps focus on the trigger', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    // A newly raised error answers what the user just did, so it takes focus.
    await failNextDoubleCall(page, 'runAction', 'the remote refused the fetch')
    await page.getByRole('button', { name: 'Fetch', exact: true }).click()
    const banner = page.locator('#global-action-error-banner')
    await expect(banner).toContainText('the remote refused the fetch')
    await expect(banner).toBeFocused()

    // The banner is still on screen. Cancelling a dialog must hand focus back to
    // the control that opened it, not to an error the user has already read.
    const trigger = page.getByRole('button', { name: 'New branch', exact: true }).first()
    const dialog = await openNewBranchDialog(page)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await settle(page)
    await expect(banner).toBeVisible()
    await assertFocusRestored(
      page,
      trigger,
      'cancelling Create a branch with an older error raised',
    )
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

  test('branch tree is one Tab stop with arrow, Home, and End movement', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const tree = page.getByRole('tree', { name: 'Repository branches' })
    await expect(tree).toBeVisible()
    const rows = tree.getByRole('treeitem')
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(2)

    // Exactly one row is in the tab order; the rest are reached with arrows.
    const tabbable = await rows.evaluateAll(
      (elements) => elements.filter((element) => element.getAttribute('tabindex') === '0').length,
    )
    expect(tabbable).toBe(1)

    await rows.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(rows.first()).toBeFocused()

    await page.keyboard.press('End')
    await expect(rows.nth(rowCount - 1)).toBeFocused()
    await page.keyboard.press('Home')
    await expect(rows.first()).toBeFocused()
  })

  test('a focused branch row leaves modified chords to the global dispatcher', async ({ page }) => {
    await openGallery(page, { scenario: 'ancestry-requires-restack' })
    await settle(page)

    const tree = page.getByRole('tree', { name: 'Repository branches' })
    const rows = tree.getByRole('treeitem')
    await expect(rows.first()).toBeVisible()
    await rows.first().focus()
    // Alt+ArrowDown is the "select first child" shortcut, not a roving move. It
    // must reach the dispatcher and leave focus on the row it was pressed from.
    await page.keyboard.press('Alt+ArrowDown')
    await settle(page)
    await expect(rows.first()).toBeFocused()

    const inspector = page.locator('.details-pane')
    await expect(
      inspector.getByRole('heading', { level: 2, name: 'feature/checkout-tests', exact: true }),
    ).toBeVisible({ timeout: 10_000 })

    // Mod+Enter is a global chord, and what Mod resolves to differs by platform,
    // so the test does not assume the dispatcher does nothing with it. It asserts
    // the row's side of the contract: the row must leave the event alone.
    const mainRow = tree.getByRole('treeitem', { name: /^main,/ })
    await mainRow.focus()
    await page.keyboard.press('Enter')
    await settle(page)
    await expect(
      inspector.getByRole('heading', { level: 2, name: 'main', exact: true }),
    ).toBeVisible()

    const childRow = tree.getByRole('treeitem', { name: /^feature\/checkout-tests,/ })
    await childRow.focus()
    // Read the chord's own keydown, not the first one. `press('ControlOrMeta+Enter')`
    // dispatches the modifier and the key as separate keydowns, so a one-shot
    // listener settles on the bare modifier and never observes the event this
    // contract is about.
    //
    // Read it at the document, in the bubble phase. That point is after React
    // has dispatched the row's own handler — React delegates at the `#root`
    // container, so its listener runs first — and before the global chord
    // dispatcher, which `App.tsx` registers on `window` and re-registers
    // whenever its effect re-runs. Reading at `window` instead made the result
    // depend on which of the two listeners happened to be registered first,
    // which is why the assertion went red on some runs and green on others.
    // Here the row's own decision is all that is left to observe: a row that
    // claimed the chord called preventDefault, one that left it alone did not.
    const chordConsumed = page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Enter') return
            document.removeEventListener('keydown', onKeyDown)
            resolve(event.defaultPrevented)
          }
          document.addEventListener('keydown', onKeyDown)
        }),
    )
    await page.keyboard.press('ControlOrMeta+Enter')
    await settle(page)
    expect(await chordConsumed).toBe(false)

    // The row did not activate itself either: the selection is still the branch
    // chosen with Enter, not the row the chord was pressed on.
    await expect(
      inspector.getByRole('heading', { level: 2, name: 'feature/checkout-tests', exact: true }),
    ).toHaveCount(0)
  })

  test('branch tree keeps one Tab stop and reaches both list ends from a slid window', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'branches-deep-chain' })
    const tree = page.getByRole('tree', { name: 'Repository branches' })
    await expect(tree.getByRole('treeitem').first()).toBeVisible()

    // Reveal twice more: the first reveal mounts a second page, the second slides
    // the mounted window forward. The tree must still be one Tab stop afterwards.
    const reveal = page.getByRole('button', { name: /more branches/i }).first()
    await reveal.click()
    await settle(page)
    await reveal.click()
    await settle(page)

    const rows = tree.getByRole('treeitem')
    expect(await rows.count()).toBeGreaterThan(200)
    const tabStops = () =>
      rows.evaluateAll(
        (elements) => elements.filter((element) => element.getAttribute('tabindex') === '0').length,
      )
    expect(await tabStops()).toBe(1)

    // The window has really slid: the first and last branches of the whole list
    // are both unmounted, so "the next row" can only be asserted by naming the
    // branch rather than by its position in whatever happens to be mounted.
    const listStart = /^feature\/deep-0619,/
    const base = /^main,/
    await expect(tree.getByRole('treeitem', { name: listStart })).toHaveCount(0)
    await expect(tree.getByRole('treeitem', { name: base })).toHaveCount(0)
    const mounted = await mountedRowNames(rows)

    // Arrow movement is relative to the mounted window: one ArrowDown from its
    // first row lands on that same window's second row, not on the second row
    // of the list the reader has already scrolled away from.
    await rows.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(tree.getByRole('treeitem', { name: mounted[1] })).toBeFocused()

    // The arrow did not re-base the move onto the whole list: the mounted window
    // is the same window, holding the same branches, in the same order.
    expect(await mountedRowNames(rows)).toEqual(mounted)
    await expect(tree.getByRole('treeitem', { name: listStart })).toHaveCount(0)
    await expect(tree.getByRole('treeitem', { name: base })).toHaveCount(0)
    await page.keyboard.press('ArrowUp')
    await expect(tree.getByRole('treeitem', { name: mounted[0] })).toBeFocused()

    // End names the last row of the list rather than the last row of the window,
    // and reveals the page that mounts it.
    await page.keyboard.press('End')
    await expect(tree.getByRole('treeitem', { name: base })).toBeFocused()
    expect(await tabStops()).toBe(1)

    // Home names the first row of the list, which the slid window left behind.
    await page.keyboard.press('Home')
    await expect(tree.getByRole('treeitem', { name: listStart })).toBeFocused()
    expect(await tabStops()).toBe(1)

    // With the window re-based onto the first page, the next arrow names the
    // second branch of the whole list.
    await page.keyboard.press('ArrowDown')
    await expect(tree.getByRole('treeitem', { name: /^feature\/deep-0618,/ })).toBeFocused()

    // Paging back must not strand the surface without a Tab stop.
    const revealAgain = page.getByRole('button', { name: /more branches/i }).first()
    await revealAgain.click()
    await settle(page)
    const back = page.getByRole('button', { name: /previous branches/i }).first()
    await back.click()
    await settle(page)
    expect(await tabStops()).toBe(1)
  })

  test('branch tree rows expose level, sibling position, and state as text', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const tree = page.getByRole('tree', { name: 'Repository branches' })
    const rows = tree.getByRole('treeitem')
    const first = rows.first()
    await expect(first).toHaveAttribute('aria-level', /^\d+$/)
    await expect(first).toHaveAttribute('aria-setsize', /^\d+$/)
    await expect(first).toHaveAttribute('aria-posinset', /^\d+$/)

    // The checked-out branch is named in words, not only marked with the accent
    // colour and the cloud icon.
    const current = tree.getByRole('treeitem', { name: /^.*, current branch/ })
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('aria-selected', 'true')
  })

  test('Enter selects a focused branch row without mutating the working tree', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const tree = page.getByRole('tree', { name: 'Repository branches' })
    const rows = tree.getByRole('treeitem')
    await rows.nth(1).focus()
    await page.keyboard.press('Enter')
    await settle(page)

    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#branch-inspector .details-header h2')).toBeVisible()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('commit history is a list with one Tab stop and arrow movement', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await switchDestination(page, 'history')

    const commits = page.getByRole('list', { name: 'Commits' })
    await expect(commits).toBeVisible()
    const rows = commits.getByRole('button')
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(1)

    const tabbable = await rows.evaluateAll(
      (elements) => elements.filter((element) => element.getAttribute('tabindex') === '0').length,
    )
    expect(tabbable).toBe(1)

    await rows.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toBeFocused()

    await page.keyboard.press('Enter')
    await settle(page)
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true')
  })

  test('stack rail members form a list and move with arrow keys', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await switchDestination(page, 'stacks')

    const rail = page.getByRole('list', { name: 'Stack branches, children above parents' })
    await expect(rail).toBeVisible()
    const members = rail.getByRole('listitem')
    expect(await members.count()).toBeGreaterThan(0)

    const names = rail.locator('.stack-member-name')
    await names.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(names.nth(1)).toBeFocused()
  })

  test('stack rail Home and End reach both ends of a stack longer than one page', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'branches-deep-chain' })
    await switchDestination(page, 'stacks')

    const rail = page.getByRole('list', { name: 'Stack branches, children above parents' })
    await expect(rail).toBeVisible()
    const names = rail.locator('.stack-member-name')
    const first = rail.getByRole('button', { name: /^feature\/deep-0619,/ })
    const last = rail.getByRole('button', { name: /^feature\/deep-0001,/ })
    await expect(first).toBeVisible()
    await expect(last).toHaveCount(0)

    // Two reveals slide the rail's mounted window past the last member.
    const reveal = page.getByRole('button', { name: /more stack branches/i }).first()
    await reveal.click()
    await settle(page)
    await reveal.click()
    await settle(page)
    await expect(last).toHaveCount(0)

    // The window has really slid: the rail's first member is unmounted too, so
    // an arrow assertion has to name the member rather than its position in
    // whatever the window happens to be mounting.
    await expect(first).toHaveCount(0)
    const mounted = await mountedRowNames(names)
    expect(mounted.length).toBeGreaterThan(200)

    // One ArrowDown lands on the second mounted member and leaves the window
    // exactly where it was, instead of sliding back to the top of the rail.
    await names.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(rail.getByRole('button', { name: mounted[1] })).toBeFocused()
    expect(await mountedRowNames(names)).toEqual(mounted)
    await expect(first).toHaveCount(0)
    await page.keyboard.press('ArrowUp')
    await expect(rail.getByRole('button', { name: mounted[0] })).toBeFocused()
    // End still names the last member of the whole rail, not the last member of
    // the window, and reveals the page that mounts it.
    await page.keyboard.press('End')
    await expect(last).toBeFocused()
    await page.keyboard.press('Home')
    await expect(first).toBeFocused()

    expect(
      await names.evaluateAll(
        (elements) => elements.filter((element) => element.getAttribute('tabindex') === '0').length,
      ),
    ).toBe(1)
  })

  test('workspace navigation moves with arrow keys and announces the destination change', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const nav = page.getByRole('navigation', { name: 'Workspace destinations' })
    const branches = nav.getByRole('button', { name: /^Branches/ })
    await branches.focus()
    await page.keyboard.press('ArrowDown')
    const stacks = nav.getByRole('button', { name: /^Stacks/ })
    await expect(stacks).toBeFocused()
    await page.keyboard.press('End')
    await expect(nav.getByRole('button', { name: /^Diagnostics/ })).toBeFocused()
  })

  test('a keyboard destination change moves focus to the new workspace heading', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const diagnostics = page
      .getByRole('navigation', { name: 'Workspace destinations' })
      .getByRole('button', { name: /^Diagnostics/ })
    await diagnostics.focus()
    await page.keyboard.press('Enter')

    const heading = page.locator('#workspace-view-heading')
    await expect(heading).toBeFocused()
    await expect(heading).toHaveText('Diagnostics')
    // The change is also announced politely for readers that track the live region.
    await expect(
      page.locator('[aria-live="polite"]').filter({ hasText: 'Diagnostics workspace' }),
    ).toHaveCount(1)
  })

  test('the search field keeps every typed keystroke, including shortcut characters', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })

    const search = getViewFilterInput(page)
    await search.click()
    // `/`, a digit, and a letter are each bound to a global action elsewhere.
    await page.keyboard.type('7/k')
    await expect(search).toHaveValue('7/k')

    // None of them was captured: no view changed and no palette opened.
    await expect(page.getByRole('heading', { level: 1, name: 'Branches' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
  })
})
