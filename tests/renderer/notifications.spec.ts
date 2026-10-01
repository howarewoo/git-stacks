import { expect, type Page, test } from '@playwright/test'
import { getDoubleCalls, openGallery, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import type { ScenarioName } from './fixtures/manifest'

/**
 * The optional Notification Center, driven through the real App and the real
 * components. Every assertion here is about what a person can see and do, plus
 * the exact arguments a state transition was asked for: a passing double that
 * echoed its own input into the view would not be evidence that anything
 * changed, so the rendered result of each action is asserted on its own.
 */

const THREADS = 'GitHub notification threads'
/** The inbox's own toolbar button, distinct from the shell's "Refresh repository". */
const REFRESH = { name: 'Refresh', exact: true } as const

async function openNotifications(page: Page, scenario: ScenarioName): Promise<void> {
  await openGallery(page, { scenario })
  await switchDestination(page, 'notifications')
  await settle(page)
}

function threadList(page: Page) {
  return page.getByRole('list', { name: THREADS })
}

function inbox(page: Page) {
  return page.getByRole('main')
}

test.describe('Notification Center states and transitions', () => {
  test('a module with no credential offers authorization and shows no inbox', async ({ page }) => {
    await openNotifications(page, 'notifications-awaiting-credential')

    await expect(page.getByRole('button', { name: 'Authorize notifications' })).toBeVisible()
    await expect(threadList(page)).toHaveCount(0)
    await expect(page.getByRole('button', REFRESH)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove credential' })).toHaveCount(0)
  })

  test('authorizing turns the module into a live inbox with the threads GitHub serves', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-awaiting-credential')

    await page.getByRole('button', { name: 'Authorize notifications' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Consent is a gate, not a label: nothing can be sent before it is ticked.
    await expect(dialog.getByRole('button', { name: 'Authorize notifications' })).toBeDisabled()
    await dialog.getByLabel('Personal access token').fill('ghp_fixture_never_real')
    await dialog.getByRole('checkbox').check()
    await expect(dialog.getByRole('button', { name: 'Authorize notifications' })).toBeEnabled()

    await dialog.getByRole('button', { name: 'Authorize notifications' }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(threadList(page)).toBeVisible()
    await expect(threadList(page).getByRole('listitem')).toHaveCount(3)
    await expect(
      threadList(page).getByRole('listitem').filter({ hasText: 'Tidy the stack ordering rules' }),
    ).toBeVisible()
    // The credential is sealed on the inbox and the module is polling again.
    await expect(page.getByRole('button', REFRESH)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove credential' })).toBeVisible()
  })

  test('marking a thread read and unsubscribing change the rows they name', async ({ page }) => {
    await openNotifications(page, 'notifications-ready')
    const list = threadList(page)
    const first = list.getByRole('listitem').filter({ hasText: 'Tidy the stack ordering rules' })
    const second = list.getByRole('listitem').filter({ hasText: 'Mentioned in' })

    await expect(first.getByText('Unread')).toBeVisible()
    await first.getByRole('button', { name: 'Mark Tidy the stack ordering rules as read' }).click()
    await expect(first.getByText('Read', { exact: true })).toBeVisible()
    await expect(first.getByText('Unread')).toHaveCount(0)

    await second.getByRole('button', { name: 'Unsubscribe from' }).click()
    await expect(second).toHaveCount(0)
    await expect(list.getByRole('listitem')).toHaveCount(2)

    const calls = await getDoubleCalls(page)
    expect(calls.filter((entry) => entry.call === 'notificationMarkRead')).toEqual([
      { call: 'notificationMarkRead', args: ['101'] },
    ])
    expect(calls.filter((entry) => entry.call === 'notificationSubscription')).toEqual([
      { call: 'notificationSubscription', args: ['102', 'unsubscribe'] },
    ])
  })

  test('a refused write is reported on the inbox, leaves the row alone, and can be dismissed', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-ready')

    await page.evaluate(() => {
      window.fixture.failNext(
        'notificationMarkRead',
        'GitHub returned 500. The thread was not marked read and the outcome is unknown.',
      )
    })
    await threadList(page)
      .getByRole('listitem')
      .filter({ hasText: 'Tidy the stack ordering rules' })
      .getByRole('button', { name: 'Mark Tidy the stack ordering rules as read' })
      .click()

    // The inbox itself says what failed: an alert the inbox owns, not one that
    // only appears behind the consent dialog.
    const alert = inbox(page).getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('GitHub returned 500')
    // The row is unchanged, because the write did not happen.
    await expect(
      threadList(page)
        .getByRole('listitem')
        .filter({ hasText: 'Tidy the stack ordering rules' })
        .getByText('Unread'),
    ).toBeVisible()

    // A new action is what clears it, and the inbox owns that dismissal itself.
    await inbox(page).getByRole('button', { name: 'Dismiss' }).click()
    await expect(inbox(page).getByRole('alert')).toHaveCount(0)
  })

  test('a refused credential is reported inside the dialog, not on the inbox', async ({ page }) => {
    await openNotifications(page, 'notifications-awaiting-credential')

    await page.getByRole('button', { name: 'Authorize notifications' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Personal access token').fill('ghp_fixture_never_real')
    await dialog.getByRole('checkbox').check()
    await page.evaluate(() => {
      window.fixture.failNext('notifications', 'The key store refused to seal that credential.')
    })
    await dialog.getByRole('button', { name: 'Authorize notifications' }).click()

    // The dialog stays open and owns the message; the inbox it covers has none.
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('alert')).toContainText('refused to seal')
    await expect(inbox(page).getByRole('alert')).toHaveCount(0)
  })

  test('a stale inbox says so while the last confirmed list stands', async ({ page }) => {
    await openNotifications(page, 'notifications-stale')

    await expect(threadList(page).getByRole('listitem')).toHaveCount(3)
    await expect(
      inbox(page).getByText('Stale · GitHub could not be reached', { exact: true }),
    ).toBeVisible()
    await expect(inbox(page).getByText('It is not a live answer.', { exact: false })).toBeVisible()
    // Polling is still offered, because a stale answer is the reason to read again.
    await expect(page.getByRole('button', REFRESH)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove credential' })).toBeVisible()
  })

  for (const scenario of ['notifications-rejected', 'notifications-policy-disabled'] as const) {
    test(`${scenario} still offers to remove the credential it holds`, async ({ page }) => {
      await openNotifications(page, scenario)

      // The credential is sealed here, so it has to stay discardable precisely
      // when the module cannot use it.
      const remove = page.getByRole('button', { name: 'Remove credential' })
      await expect(remove).toBeVisible()
      await expect(inbox(page).getByText(/credential sealed/)).toBeVisible()
      // Polling is not available in either of these states.
      await expect(page.getByRole('button', REFRESH)).toHaveCount(0)

      await remove.click()
      await expect(page.getByRole('button', { name: 'Authorize notifications' })).toBeVisible()
      await expect(inbox(page).getByText(/no credential/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Remove credential' })).toHaveCount(0)
      await expect(threadList(page)).toHaveCount(0)
    })
  }

  test('the consent dialog keeps global shortcuts from running through it', async ({ page }) => {
    await openNotifications(page, 'notifications-awaiting-credential')
    await page.getByRole('button', { name: 'Authorize notifications' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const token = dialog.getByLabel('Personal access token')
    await token.focus()
    await page.keyboard.press('Meta+k')
    await page.keyboard.press('Control+k')
    await settle(page)

    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(token).toBeFocused()
  })

  // A window zoomed to 200% gives the page half the CSS viewport, so this is
  // the layout that zoom produces — checked here against the same real
  // components, and against the window's own zoom factor in the desktop run.
  test('the inbox stays operable at the viewport 200% zoom produces', async ({ page }) => {
    await openGallery(page, {
      scenario: 'notifications-ready',
      viewport: { width: 512, height: 384 },
    })
    await switchDestination(page, 'notifications')
    await settle(page)

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false)
    const rows = threadList(page).getByRole('listitem')
    await expect(rows.first()).toBeVisible()
    const clipped = await rows.evaluateAll((elements) =>
      elements.flatMap((row) =>
        [...row.querySelectorAll('button')].flatMap((button) => {
          const box = button.getBoundingClientRect()
          return box.left >= -1 && box.right <= window.innerWidth + 1
            ? []
            : [(button.getAttribute('aria-label') ?? button.textContent ?? ''), box.left, box.right]
        }),
      ),
    )
    expect(clipped).toEqual([])
    // Wrapping, not clipping: the controls are still operable.
    await rows
      .first()
      .getByRole('button', { name: 'Mark Tidy the stack ordering rules as read' })
      .click()
    await expect(rows.first().getByText('Read', { exact: true })).toBeVisible()
  })
})