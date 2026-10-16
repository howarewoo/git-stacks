import { expect, test } from '@playwright/test'
import {
  getDispatchedActions,
  getDoubleCalls,
  getViewFilterInput,
  openGallery,
  settle,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { assertFocusRestored, assertModalDialogFocusTrap } from './helpers/keyboard'
test.describe('Keyboard routes and accessibility navigation', () => {
  test('filter and global search shortcuts focus their current surfaces', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const filter = getViewFilterInput(page)
    await page.keyboard.press('/')
    await expect(filter).toBeFocused()
    await filter.blur()
    await page.keyboard.press('ControlOrMeta+k')
    const search = page.getByRole('dialog', { name: 'Global search' })
    await expect(search).toBeVisible()
    await expect(search.getByRole('combobox')).toBeFocused()
    await assertModalDialogFocusTrap(page, search, 'Global search')
    await search.getByRole('combobox').focus()
    await page.keyboard.press('Escape')
    await expect(search).not.toBeVisible()
    await switchDestination(page, 'attention')
    const attentionNavigation = page
      .getByRole('complementary', { name: 'Workspace navigation' })
      .getByRole('button', { name: /^Needs attention/ })
    await attentionNavigation.focus()
    await page.keyboard.press('/')
    await expect(page.getByRole('textbox', { name: 'Search needs attention' })).toBeFocused()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('sidebar destinations are keyboard activatable without a Git mutation', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
    for (const [buttonName, heading] of [
      [/^Pull requests/, 'Pull requests'],
      [/^Needs attention/, 'Needs attention'],
      [/^Activity/, 'Activity'],
      [/^Branches/, 'Branches & worktrees'],
    ] as const) {
      const button = navigation.getByRole('button', { name: buttonName })
      await button.focus()
      await page.keyboard.press('Enter')
      await expect(
        page.getByRole('heading', { level: 1, name: heading, exact: true }),
      ).toBeVisible()
    }
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('branch status filter responds to keyboard activation', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const filter = page.getByRole('group', { name: 'Branch status filter' })
    const unpublished = filter.getByRole('button', { name: /^Unpublished/ })
    await unpublished.focus()
    await page.keyboard.press('Space')
    await expect(unpublished).toHaveAttribute('aria-pressed', 'true')
  })

  test('mounted branch groups have one roving row stop and arrow, Home, End movement', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const rows = page.locator('.bw-lane-row')
    expect(await rows.count()).toBeGreaterThan(2)
    expect(
      await rows.evaluateAll(
        (elements) => elements.filter((element) => element.tabIndex === 0).length,
      ),
    ).toBe(1)
    await rows.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(rows.first()).toBeFocused()
    await page.keyboard.press('End')
    await expect(rows.last()).toBeFocused()
    await page.keyboard.press('Home')
    await expect(rows.first()).toBeFocused()
  })

  test('Enter selects a qualified branch for inspection without checking it out', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const row = page
      .locator('.bw-lane-row')
      .filter({ has: page.getByRole('button', { name: 'feature/checkout-tests', exact: true }) })
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(
      row.getByRole('button', { name: 'feature/checkout-tests', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.getByRole('complementary', { name: 'Selected branch details' }),
    ).toContainText('feature/checkout-tests')
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('paged branch groups keep arrows page-relative and Home/End reach the complete outline', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'branches-deep-chain' })
    const rows = page.locator('.bw-lane-row')
    const initial = await rows.first().getAttribute('data-branch-id')
    await page.getByRole('button', { name: 'feature/deep-0619', exact: true }).click()
    const inspector = page.getByRole('complementary', { name: 'Selected branch details' })
    await expect(inspector).toContainText('feature/deep-0619')
    const inspected = await inspector.textContent()
    await page.getByRole('button', { name: 'Next page', exact: true }).click()
    await settle(page)
    expect(await rows.first().getAttribute('data-branch-id')).not.toBe(initial)
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()
    await rows.first().focus()
    await page.keyboard.press('ArrowUp')
    await expect(rows.last()).toBeFocused()
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled()
    await page.keyboard.press('ArrowDown')
    await expect(rows.first()).toBeFocused()
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeEnabled()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toBeFocused()
    await rows.last().focus()
    await page.keyboard.press('ArrowDown')
    await expect(rows.first()).toBeFocused()
    await page.keyboard.press('End')
    await expect(rows.last()).toBeFocused()
    await expect(rows.last().getByRole('button', { name: 'main', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled()
    await expect(page.locator('.bw-lane-row[tabindex="0"]')).toHaveCount(1)
    expect(await inspector.textContent()).toBe(inspected)
    await page.getByRole('button', { name: 'Previous page', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()
    await rows.first().focus()
    await page.keyboard.press('Home')
    await expect(rows.first()).toBeFocused()
    await expect(rows.first()).toHaveAttribute('data-branch-id', initial!)
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled()
    expect(
      await rows.evaluateAll(
        (elements) => elements.filter((element) => element.tabIndex === 0).length,
      ),
    ).toBe(1)
    expect(await inspector.textContent()).toBe(inspected)
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('branch groups leave modified stack-navigation chords to the global dispatcher', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await page.getByRole('button', { name: 'feature/checkout', exact: true }).click()
    const main = page
      .locator('.bw-lane-row')
      .filter({ has: page.getByRole('button', { name: 'main', exact: true }) })
    await main.focus()
    await page.keyboard.press('Alt+ArrowUp')
    await expect(main).toBeFocused()
    await expect(
      page.getByRole('button', { name: 'feature/checkout-tests', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('inspector tabs are keyboard reachable and select the mounted panels', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await page.getByRole('button', { name: 'feature/checkout', exact: true }).click()
    const overview = page.getByRole('tab', { name: 'Overview', exact: true })
    await overview.focus()
    await page.keyboard.press('ArrowRight')
    const changes = page.getByRole('tab', { name: /^Changes/ })
    await expect(changes).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(changes).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('combobox', { name: 'Local file to inspect' })).toBeVisible()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('branch action menu opens from the keyboard, moves focus and restores its trigger', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await page.getByRole('button', { name: 'feature/checkout', exact: true }).click()
    const trigger = page
      .locator('.bw-lane-row.bw-selected')
      .getByRole('button', { name: 'More branch and worktree actions', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const first = await menu.locator(':focus').textContent()
    await page.keyboard.press('ArrowDown')
    await expect(menu.locator(':focus')).toHaveAttribute('role', 'menuitem')
    expect(await menu.locator(':focus').textContent()).not.toBe(first)
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await assertFocusRestored(page, trigger, 'closing branch actions')
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('Settings traps focus and restores its launch control on Escape', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const trigger = page.getByRole('button', { name: 'Settings', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await assertModalDialogFocusTrap(page, dialog, 'Settings')
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await assertFocusRestored(page, trigger, 'closing Settings')
  })

  test('committed history can be read from the keyboard without a mutation', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await page.getByRole('button', { name: 'main', exact: true }).click()
    const trigger = page.getByRole('button', { name: 'Inspect branch history', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Selected committed history' })
    const commits = dialog.getByRole('button').filter({ hasText: / · [a-f0-9]{10}$/ })
    await expect(commits.first()).toBeVisible()
    await commits.first().focus()
    await page.keyboard.press('Enter')
    const code = dialog.locator('.wb-code')
    await expect(code).toBeVisible()
    await code.focus()
    await expect(code).toBeFocused()
    await assertModalDialogFocusTrap(page, dialog, 'Selected committed history')
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('long local code is keyboard focusable, scrollable and paged', async ({ page }) => {
    await openGallery(page, { scenario: 'files-long-content' })
    await page.getByRole('button', { name: 'feature/checkout', exact: true }).click()
    await page.getByRole('tab', { name: /^Changes/ }).click()
    await page.getByRole('combobox', { name: 'Local file to inspect' }).click()
    await page.getByRole('option', { name: /bulk-generated-surface\.tsx/ }).click()
    const code = page.locator('.wb-code').first()
    await expect(code).toBeVisible()
    await code.focus()
    await expect(code).toBeFocused()
    const before = await code.evaluate((element) => element.scrollTop)
    await page.keyboard.press('PageDown')
    await expect.poll(() => code.evaluate((element) => element.scrollTop)).toBeGreaterThan(before)
    const next = page.getByRole('button', { name: 'Next lines', exact: true }).first()
    await next.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText(/^Page 2 \//).first()).toBeVisible()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('the review file tree moves with arrow keys, and opening a file shows its diff without mutating', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'review-stacked' })
    await switchDestination(page, 'review')
    await settle(page)

    const rows = page.getByRole('group', { name: 'Changed file rows' }).getByRole('button')
    expect(await rows.count()).toBeGreaterThan(4)

    await rows.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(2)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(rows.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(rows.first()).toBeFocused()

    // Enter opens the file the focused row stands for, and its lines are the
    // ones the diff offers to comment on.
    const fileRow = page.getByRole('button', { name: /^src\/main\/review\.ts, /u })
    await fileRow.focus()
    await page.keyboard.press('Enter')
    await settle(page)
    await expect(fileRow).toHaveAttribute('aria-current', 'true')
    await expect(
      page.getByRole('button', { name: 'Comment on src/main/review.ts line 1 on the head' }),
    ).toBeVisible()

    // Reviewing a file is a read. Nothing is checked out to look at it.
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('a review line and its range are chosen from the keyboard, and no review is sent', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'review-stacked' })
    await switchDestination(page, 'review')
    await settle(page)

    await page.getByRole('button', { name: /^src\/main\/review\.ts, /u }).click()
    await settle(page)

    const first = page.getByRole('button', {
      name: 'Comment on src/main/review.ts line 1 on the head',
    })
    await first.focus()
    await expect(first).toBeFocused()
    await page.keyboard.press('Enter')
    await settle(page)
    await expect(page.locator('.review-conversation')).toContainText('src/main/review.ts:1 (head)')

    // The range is extended from the keyboard the way a pointer extends it.
    await page
      .getByRole('button', { name: 'Comment on src/main/review.ts line 4 on the head' })
      .focus()
    await page.keyboard.press('Shift+Enter')
    await settle(page)
    await expect(page.locator('.review-conversation')).toContainText(
      'src/main/review.ts:1–4 (head)',
    )

    // Stepping to the next file is reachable too, and the file it lands on is
    // the one after the file the reviewer was reading.
    await page.getByRole('button', { name: 'Next file' }).focus()
    await page.keyboard.press('Enter')
    await settle(page)
    await expect(
      page.getByRole('button', { name: /^src\/renderer\/src\/App\.tsx, /u }),
    ).toHaveAttribute('aria-current', 'true')

    // Choosing lines to read is not choosing to say something: nothing was sent.
    expect(await getDispatchedActions(page)).toEqual([])
    expect((await getDoubleCalls(page)).filter((entry) => entry.call === 'reviewSubmit')).toEqual(
      [],
    )
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
    await expect(
      page.getByRole('heading', { level: 1, name: 'Branches & worktrees' }),
    ).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Global search' })).toHaveCount(0)
  })
})
