import { expect, type Page, test } from '@playwright/test'
import {
  getDoubleCalls,
  getOpenedExternalUrls,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
} from './helpers/gallery'
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

function row(page: Page, title: string) {
  return threadList(page).getByRole('listitem').filter({ hasText: title })
}

/**
 * Selects another GitHub host the way a person does: the Settings dialog, the
 * host field, and the stored value main answers with. Nothing is remounted and
 * nothing is pushed to the window, so the inbox the new host shows can only
 * come from the window asking for it.
 */
async function selectGitHubHost(page: Page, host: string): Promise<void> {
  await page.keyboard.press('Meta+k')
  if (!(await page.getByRole('dialog', { name: 'Command palette' }).isVisible())) {
    await page.keyboard.press('Control+k')
  }
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await palette.getByRole('option', { name: /^Settings/ }).click()
  const dialog = page.getByRole('dialog', { name: /Settings/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'GitHub', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Host' }).fill(host)
  await dialog.getByRole('button', { name: 'Use this host' }).click()
  await expect(dialog.getByText(`GitHub host set to ${host}.`, { exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
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
    // The host is named before anything is typed: it is the host this token is
    // acknowledged for, and it travels with the token rather than being chosen
    // by whatever host happens to be selected when the write is finally made.
    await expect(dialog).toContainText('github.com')
    // Consent is a gate, not a label: nothing can be sent before it is ticked.
    await expect(dialog.getByRole('button', { name: 'Authorize notifications' })).toBeDisabled()
    await dialog.getByLabel('Personal access token').fill('ghp_fixture_never_real')
    await dialog.getByRole('checkbox').check()
    await expect(dialog.getByRole('button', { name: 'Authorize notifications' })).toBeEnabled()

    await dialog.getByRole('button', { name: 'Authorize notifications' }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(threadList(page)).toBeVisible()
    await expect(threadList(page).getByRole('listitem')).toHaveCount(3)
    await expect(row(page, 'Tidy the stack ordering rules')).toBeVisible()
    // The credential is sealed on the inbox and the module is polling again.
    await expect(page.getByRole('button', REFRESH)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove credential' })).toBeVisible()
  })

  test('reading, completing, and unsubscribing each change the row they name', async ({ page }) => {
    await openNotifications(page, 'notifications-ready')
    const first = row(page, 'Tidy the stack ordering rules')
    const second = row(page, 'Mentioned in')

    await expect(first.getByText('Unread')).toBeVisible()
    await first.getByRole('button', { name: 'Mark Tidy the stack ordering rules as read' }).click()
    await expect(first.getByText('Read', { exact: true })).toBeVisible()
    await expect(first.getByText('Unread')).toHaveCount(0)

    await second.getByRole('button', { name: 'Unsubscribe from' }).click()
    await expect(second).toHaveCount(0)
    await expect(threadList(page).getByRole('listitem')).toHaveCount(2)

    // Done is GitHub's own operation on the thread, and it is not unsubscribing:
    // the thread leaves the inbox and the conversation keeps its subscription.
    const third = row(page, 'Checks failed on')
    await third.getByRole('button', { name: 'Mark Checks failed on “Add checkout validation” as done' }).click()
    await expect(third).toHaveCount(0)
    await expect(threadList(page).getByRole('listitem')).toHaveCount(1)

    const calls = await getDoubleCalls(page)
    expect(calls.filter((entry) => entry.call === 'notificationMarkRead')).toEqual([
      { call: 'notificationMarkRead', args: ['101'] },
    ])
    expect(calls.filter((entry) => entry.call === 'notificationSubscription')).toEqual([
      { call: 'notificationSubscription', args: ['102', 'unsubscribe'] },
    ])
    expect(calls.filter((entry) => entry.call === 'notificationDone')).toEqual([
      { call: 'notificationDone', args: ['103'] },
    ])
  })

  // A write whose answer was lost is not a write that did not happen. The inbox
  // says what it can know, leaves the row alone, and does not send it again
  // because a later read did not confirm it.
  test('a refused write is reported on the inbox, leaves the row alone, and is not retried', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-ready')

    await page.evaluate(() => {
      window.fixture.failNext(
        'notificationMarkRead',
        'This inbox changed while the change was in flight. The change was not sent again; what GitHub holds is unknown.',
      )
    })
    await row(page, 'Tidy the stack ordering rules')
      .getByRole('button', { name: 'Mark Tidy the stack ordering rules as read' })
      .click()

    // The inbox itself says what failed: an alert the inbox owns, not one that
    // only appears behind the consent dialog, and it carries the reason the
    // main process gave rather than a guess about what GitHub holds.
    const alert = inbox(page).getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('what GitHub holds is unknown')
    // The heading must not claim an outcome the answer never established.
    await expect(alert).not.toContainText('did not reach GitHub')
    // The row is unchanged, because the write is not known to have happened.
    await expect(row(page, 'Tidy the stack ordering rules').getByText('Unread')).toBeVisible()

    await inbox(page).getByRole('button', { name: 'Dismiss' }).click()
    await expect(inbox(page).getByRole('alert')).toHaveCount(0)

    // Reading again afterwards is a read, never a replay of the refused write.
    await page.getByRole('button', REFRESH).click()
    await settle(page)
    const calls = await getDoubleCalls(page)
    expect(calls.filter((entry) => entry.call === 'notificationMarkRead')).toHaveLength(1)
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

  // Removing a credential cannot change what this computer agreed to or what a
  // policy fixed. A policy-held module stays held with no token, a module that
  // is off stays off, and only an enabled module without a policy becomes the
  // state that offers to authorize one again.
  test('removing a refused credential leaves the module enabled and without one', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-rejected')

    // The credential is sealed here, so it has to stay discardable precisely
    // when the module cannot use it.
    const remove = page.getByRole('button', { name: 'Remove credential' })
    await expect(remove).toBeVisible()
    await expect(inbox(page).getByText(/credential sealed/)).toBeVisible()
    // Polling is not available in this state.
    await expect(page.getByRole('button', REFRESH)).toHaveCount(0)

    await remove.click()
    await expect(page.getByRole('button', { name: 'Authorize notifications' })).toBeVisible()
    await expect(inbox(page).getByText(/no credential/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove credential' })).toHaveCount(0)
    await expect(threadList(page)).toHaveCount(0)
  })

  test('removing a credential under a policy leaves the module held off', async ({ page }) => {
    await openNotifications(page, 'notifications-policy-disabled')

    await page.getByRole('button', { name: 'Remove credential' }).click()

    // Consent is not what is missing, and a policy is not something a token
    // could satisfy: the module stays held, and nothing asks for one.
    await expect(inbox(page).getByText('Held off by policy', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Authorize notifications' })).toHaveCount(0)
    await expect(page.getByRole('button', REFRESH)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove credential' })).toHaveCount(0)
    await expect(inbox(page).getByText(/no credential/)).toBeVisible()
  })

  test('removing the credential of a module this computer turned off leaves it off', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-turned-off')

    await expect(inbox(page).getByText('This module is off', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Remove credential' }).click()

    // Turning the module off keeps its token, and removing that token does not
    // turn the module on.
    await expect(inbox(page).getByText('This module is off', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Authorize notifications' })).toHaveCount(0)
    await expect(page.getByRole('button', REFRESH)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove credential' })).toHaveCount(0)
  })

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

  // A GitHub host can name a reason or a subject this build has no label for,
  // and it can offer a thread with no page to open. Neither fact is about what
  // may be done to the thread: reading it, completing it, and its subscription
  // all address the thread by its own id.
  test('a thread this build cannot name or open still has its own operations', async ({ page }) => {
    await openNotifications(page, 'notifications-no-subject-link')
    const unnamed = row(page, 'Something this build has no name for')
    const commit = row(page, 'Pushed “Record the stack ordering rules”')

    // The row is preserved and labelled as what this build could not name.
    await expect(unnamed).toBeVisible()
    await expect(unnamed).toContainText('Item')
    await expect(unnamed).toContainText('Other')
    // Only the browser link is missing, and it says so.
    await expect(unnamed.getByRole('button', { name: 'Ignore Something this build' })).toBeEnabled()
    await expect(
      unnamed.getByRole('button', { name: 'Unsubscribe from Something this build' }),
    ).toBeEnabled()

    await unnamed
      .getByRole('button', { name: 'Mark Something this build has no name for as read' })
      .click()
    await expect(unnamed.getByText('Read', { exact: true })).toBeVisible()
    await unnamed
      .getByRole('button', { name: 'Mark Something this build has no name for as done' })
      .click()
    await expect(unnamed).toHaveCount(0)
    await expect(threadList(page).getByRole('listitem')).toHaveCount(1)

    // A commit subject is opened on the one-commit page, which is the commit and
    // its comments, and not the history of the branch it landed on.
    await expect(commit).toContainText('Commit')
    await commit.getByRole('button', { name: /^Open / }).click()
    expect(await getOpenedExternalUrls(page)).toEqual([
      'https://github.com/acme/widgets/commit/9f1c2b7d4e5a',
    ])
  })

  // GitHub can accept the whole-inbox change and finish it on its own. Until a
  // read says what it did, the rows are the last list it confirmed, the request
  // is not offered again, and the wait is announced rather than shown as done.
  test('an accepted bulk change is announced as unconfirmed and resolves on the next read', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-mark-all-accepted')

    const notice = inbox(page).getByRole('status')
    await expect(notice).toBeVisible()
    await expect(row(page, 'Tidy the stack ordering rules').getByText('Unread')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mark all read' })).toBeDisabled()

    await page.getByRole('button', REFRESH).click()
    await settle(page)

    // The read is what confirms it, and only then are the rows read.
    await expect(inbox(page).getByRole('status')).toHaveCount(0)
    await expect(row(page, 'Tidy the stack ordering rules').getByText('Unread')).toHaveCount(0)
    await expect(threadList(page).getByRole('listitem').filter({ hasText: 'Unread' })).toHaveCount(0)
  })

  // The Notification Center addresses a GitHub host, not a checkout. Reading it
  // and revoking its credential are both possible before a repository is open.
  test('the inbox is reachable with no repository open', async ({ page }) => {
    await openGallery(page, { scenario: 'notifications-no-repository' })
    await expect(page.getByText('Start with a repository')).toBeVisible()

    await switchDestination(page, 'notifications')

    await expect(threadList(page).getByRole('listitem')).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Remove credential' })).toBeVisible()
    await page.getByRole('button', { name: 'Remove credential' }).click()
    await expect(page.getByRole('button', { name: 'Remove credential' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Authorize notifications' })).toBeVisible()
  })

  // A selected host is the authoritative identity of this module, and the
  // window learns it from the settings it wrote. The previous host's rows, its
  // errors, and a dialog opened for it are that host's private state: a read
  // already on its way, and a publication from a retired center, are both
  // refused rather than adopted. The gallery double has no GitHub sign-in at
  // all here, so nothing about the account or a push takes part in this.
  test('selecting another host replaces the inbox and discards the previous host’s answers', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-ready')
    await expect(threadList(page).getByRole('listitem')).toHaveCount(3)
    await expect(inbox(page).getByText('github.com', { exact: true })).toBeVisible()

    // A read of the host that is selected now is in flight when the host
    // changes, and it answers with the rows that host read.
    await holdDoubleCall(page, 'notifications')
    await page.evaluate(() =>
      window.fixture.serveNotificationHost('ghe.acme.internal', 'notifications-other-host'),
    )
    await selectGitHubHost(page, 'ghe.acme.internal')
    await releaseDoubleCalls(page, 'notifications')
    await settle(page)

    // Only the host now selected has anything to show.
    await expect(inbox(page).getByText('github.com', { exact: true })).toHaveCount(0)
    await expect(inbox(page).getByText('ghe.acme.internal', { exact: true })).toBeVisible()
    await expect(inbox(page).getByText('riley', { exact: false })).toBeVisible()
    await expect(threadList(page).getByRole('listitem')).toHaveCount(2)
    await expect(row(page, 'Review the internal deploy queue')).toBeVisible()
    const rendered = await inbox(page).innerText()
    for (const previous of [
      'Tidy the stack ordering rules',
      'Mentioned in “Release checklist”',
      'Checks failed on “Add checkout validation”',
    ]) {
      expect(rendered).not.toContain(previous)
    }

    // A publication that was already on its way from the retired center is
    // refused too: those rows were read with another host's credential.
    await page.evaluate(() => window.fixture.publishRetiredHostInbox('notifications-ready'))
    await settle(page)
    expect(await inbox(page).innerText()).not.toContain('Tidy the stack ordering rules')
    await expect(row(page, 'Review the internal deploy queue')).toBeVisible()

    // And the control that leaves this app points at the host now selected.
    await row(page, 'Review the internal deploy queue')
      .getByRole('button', { name: /^Open / })
      .click()
    expect(await getOpenedExternalUrls(page)).toEqual([
      'https://ghe.acme.internal/ops/deploys/pull/201',
    ])
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
            : [button.getAttribute('aria-label') ?? button.textContent ?? '', box.left, box.right]
        }),
      ),
    )
    expect(clipped).toEqual([])

    // Reached rather than merely laid out: the row is scrolled into the
    // viewport, its control takes focus, and the keyboard is what changes it.
    const markRead = rows
      .first()
      .getByRole('button', { name: 'Mark Tidy the stack ordering rules as read' })
    await markRead.scrollIntoViewIfNeeded()
    const reached = await markRead.boundingBox()
    expect(reached).not.toBeNull()
    if (reached) {
      expect(reached.y).toBeGreaterThanOrEqual(0)
      expect(reached.y + reached.height).toBeLessThanOrEqual(384)
    }
    await markRead.focus()
    await expect(markRead).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rows.first().getByText('Read', { exact: true })).toBeVisible()
  })
})
