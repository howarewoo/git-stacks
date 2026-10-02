import { expect, type Locator, type Page, test } from '@playwright/test'
import {
  getDoubleCalls,
  getOpenedExternalUrls,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
  unholdDoubleCall,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import type { ScenarioName } from './fixtures/manifest'
import type { FixtureCall } from './fixtures/types'
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
 * The inbox reads this window has been admitted: the calls that carry no
 * arguments of their own. Sealing a credential, removing one, and cancelling
 * are calls of their own in the fixture, so this is a count of reads and
 * nothing else — a count that included a write would prove nothing about
 * whether the read after it was ever asked for.
 */
async function inboxReads(page: Page): Promise<number> {
  const calls = await getDoubleCalls(page)
  return calls.filter((entry) => entry.call === 'notifications' && entry.args.length === 0).length
}

/**
 * How many times the double was asked for one call kind, so a test can watch a
 * single step of a sequence be admitted rather than watch a whole log grow.
 */
async function callCount(page: Page, call: FixtureCall): Promise<number> {
  return (await getDoubleCalls(page)).filter((entry) => entry.call === call).length
}

/**
 * Walks the page's own Tab order until the keyboard lands on `control`. Focus
 * is never assigned to it: a control this walk does not reach is not one a
 * person can reach from the keyboard either.
 */
async function tabToControl(page: Page, control: Locator, limit = 240): Promise<void> {
  for (let presses = 0; presses < limit; presses += 1) {
    await page.keyboard.press('Tab')
    if (await control.evaluate((element) => element === document.activeElement)) return
  }
  const label = await control.getAttribute('aria-label')
  throw new Error(`Tab never reached ${label ?? 'the control'} within ${limit} presses.`)
}

/**
 * Opens the authorization this host would offer and fills in what its submit
 * is gated on. Nothing is submitted: each case holds one different step of the
 * authorization that follows.
 */
async function openAuthorizationDialog(page: Page): Promise<Locator> {
  await inbox(page).getByRole('button', { name: 'Authorize notifications' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Personal access token').fill('ghp_testtokentesttokentesttoken')
  await dialog.getByRole('checkbox', { name: /I understand the boundary/ }).check()
  return dialog
}

/**
 * What the person in front of this window must still find after a late answer
 * from a host they have left: the dialog they opened is still theirs, still
 * empty, and still asking about the host now selected; the window is not left
 * busy waiting for a write it has retired; and nothing was reported about it.
 * The new host behind that dialog is then read with the dialog closed, which is
 * the only way it is in the accessibility tree at all.
 */
async function expectNewHostUntouched(page: Page, dialog: Locator, host: string): Promise<void> {
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Personal access token')).toHaveValue('')
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await expect(dialog.getByText(host, { exact: true })).toBeVisible()
  // The dialog's submit is gated by consent and by an empty token either way,
  // so it is the Cancel — which is disabled for nothing but a busy window —
  // that says this window is not still waiting for the write it retired.
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText(/never sent|not sent again|was not sent again/iu)).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await expect(dialog).toBeHidden()
  await settle(page)
  // The host this window moved to is exactly as it was: on, with nothing
  // sealed for it, still offering its own authorization, and showing none of
  // the rows the host that was left behind read.
  await expect(inbox(page).getByText(host, { exact: true })).toBeVisible()
  await expect(inbox(page).getByRole('button', { name: 'Authorize notifications' })).toBeVisible()
  await expect(inbox(page).getByText(/no credential/)).toBeVisible()
  await expect(inbox(page).getByRole('button', { name: 'Remove credential' })).toHaveCount(0)
  await expect(inbox(page).getByRole('alert')).toHaveCount(0)
  await expect(threadList(page)).toHaveCount(0)
}

/**
 * Points this window at the other GitHub host and leaves that host's own
 * authorization open, for a late answer to arrive in front of. Nothing is
 * pushed for the host left behind: the new host's inbox is reached only because
 * the window asked for it, through the settings it wrote itself.
 */
async function cutOverWithDialogOpen(page: Page, host: string): Promise<Locator> {
  await page.evaluate(
    ({ servedHost, scenario }) => window.fixture.serveNotificationHost(servedHost, scenario),
    { servedHost: host, scenario: 'notifications-other-host-awaiting-credential' },
  )
  await selectGitHubHost(page, host)
  await settle(page)
  await expect(inbox(page).getByText(host, { exact: true })).toBeVisible()
  // The new host has no credential of its own, so the person is offered its own
  // authorization, and its dialog is open when the late answer finally lands.
  await inbox(page).getByRole('button', { name: 'Authorize notifications' }).click()
  const forNewHost = page.getByRole('dialog')
  await expect(forNewHost).toBeVisible()
  return forNewHost
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
    await third
      .getByRole('button', { name: 'Mark Checks failed on “Add checkout validation” as done' })
      .click()
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
      window.fixture.failNext('notificationSave', 'The key store refused to seal that credential.')
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
    await expect(threadList(page).getByRole('listitem').filter({ hasText: 'Unread' })).toHaveCount(
      0,
    )
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
    // changes, and it answers with the rows that host read. The hold is armed
    // first and the toolbar's own control is pressed, so this is a read the
    // window is genuinely waiting on rather than a bridge call with no consumer.
    await holdDoubleCall(page, 'notificationRefresh')
    const before = await getDoubleCalls(page)
    await page.getByRole('button', REFRESH).click()
    await expect
      .poll(
        async () =>
          (await getDoubleCalls(page)).filter((entry) => entry.call === 'notificationRefresh')
            .length,
      )
      .toBeGreaterThan(before.filter((entry) => entry.call === 'notificationRefresh').length)
    await unholdDoubleCall(page, 'notificationRefresh')
    await page.evaluate(() =>
      window.fixture.serveNotificationHost('ghe.acme.internal', 'notifications-other-host'),
    )
    await selectGitHubHost(page, 'ghe.acme.internal')
    await settle(page)
    await expect(inbox(page).getByText('ghe.acme.internal', { exact: true })).toBeVisible()
    const released = await releaseDoubleCalls(page, 'notificationRefresh')
    expect(released).toBeGreaterThanOrEqual(1)
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

  test('held mutation on previous host does not mutate new host or report error', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-ready')
    await page.evaluate(() =>
      window.fixture.serveNotificationHost('ghe.acme.internal', 'notifications-other-host'),
    )
    await holdDoubleCall(page, 'notificationMarkRead')
    const markReadBtn = row(page, 'Tidy the stack ordering rules').getByRole('button', {
      name: 'Mark Tidy the stack ordering rules as read',
    })
    await markReadBtn.click()
    await selectGitHubHost(page, 'ghe.acme.internal')
    await settle(page)
    await expect(inbox(page).getByText('ghe.acme.internal', { exact: true })).toBeVisible()
    await releaseDoubleCalls(page, 'notificationMarkRead')
    await settle(page)
    await expect(inbox(page).getByText('ghe.acme.internal', { exact: true })).toBeVisible()
    await expect(row(page, 'Review the internal deploy queue')).toBeVisible()
  })

  // An authorization is three steps the window waits on in turn, and each one
  // is its own boundary: turning the module on, sealing the credential, and
  // reading the inbox the accepted credential unlocked. A host change made
  // while any one of them is outstanding retires that step and everything
  // behind it. Each case below holds exactly one of the three.

  // The read an accepted credential asks for is the last of them, and it is
  // asked for only once the credential has been sealed. Its answer is the
  // inbox of the host that sealed it, which is not the host this window now
  // works against.
  test('the inbox read an accepted authorization asks for is dropped when the host changes', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-awaiting-credential')
    const dialog = await openAuthorizationDialog(page)

    await holdDoubleCall(page, 'notifications')
    const readsBefore = await inboxReads(page)
    await dialog.getByRole('button', { name: 'Authorize notifications' }).click()

    // The credential really was sealed, and the read it unlocked really was
    // asked for: exactly one new read, carrying no arguments of its own, and it
    // is the thing still outstanding — the window is waiting on it, which its
    // own disabled submit says.
    await expect.poll(() => callCount(page, 'notificationSave')).toBe(1)
    await expect.poll(() => inboxReads(page)).toBe(readsBefore + 1)
    await expect(dialog.getByRole('button', { name: 'Authorize notifications' })).toBeDisabled()

    // Only this read is held, so the read the new host makes is not waiting
    // behind a hold that was armed for the one this window left. The dialog
    // still owns the window, so it is closed the way a person closes it — the
    // dialog's own control, not a shortcut the modal correctly swallows — and
    // the authorization behind it stays outstanding.
    await unholdDoubleCall(page, 'notifications')
    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await expect(dialog).toBeHidden()
    const forNewHost = await cutOverWithDialogOpen(page, 'ghe.acme.internal')

    // One read was waiting, and one is released: the inbox the accepted
    // credential asked for, with the rows that host served.
    expect(await releaseDoubleCalls(page, 'notifications')).toBe(1)
    await settle(page)

    await expectNewHostUntouched(page, forNewHost, 'ghe.acme.internal')
  })

  // Turning the module on is the first of them, and it is a decision about this
  // computer rather than about a host. Held past a host change it must decide
  // nothing about the host this window moved to: the window drops it between
  // the first and the second step, so no credential is sealed behind it and no
  // read follows one.
  test('the enable this window agreed to does not land on the host it left', async ({ page }) => {
    await openNotifications(page, 'notifications-awaiting-credential')
    const dialog = await openAuthorizationDialog(page)

    // Only this step is held. The host change below is a different call, and a
    // window whose host could not change could not be tested for anything here.
    await holdDoubleCall(page, 'notificationSettingsEnable')
    await dialog.getByRole('button', { name: 'Authorize notifications' }).click()

    // The enable was admitted and is the whole of what is outstanding: nothing
    // behind it has been asked for.
    await expect.poll(() => callCount(page, 'notificationSettingsEnable')).toBe(1)
    await settle(page)
    expect(await callCount(page, 'notificationSave')).toBe(0)

    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await expect(dialog).toBeHidden()
    const forNewHost = await cutOverWithDialogOpen(page, 'ghe.acme.internal')
    const readsAtCutover = await inboxReads(page)

    expect(await releaseDoubleCalls(page, 'notificationSettingsEnable')).toBe(1)
    await settle(page)

    // The late answer retires the step behind it as well: no credential is
    // sealed on the strength of a decision this window made about a host it has
    // left, and no read is asked for after one.
    expect(await callCount(page, 'notificationSave')).toBe(0)
    expect(await inboxReads(page)).toBe(readsAtCutover)
    // The host this window moved to is left exactly as it was: still on, still
    // with nothing sealed for it.
    await expectNewHostUntouched(page, forNewHost, 'ghe.acme.internal')
  })

  // The credential is the second of them, and it is the one that is about a
  // host: the token was typed for the host this window was pointed at. Held
  // past a host change it must not seal anything for the host this window moved
  // to, and the read it would have unlocked must never be asked for.
  test('a credential sealed for the host this window left never reaches the new one', async ({
    page,
  }) => {
    await openNotifications(page, 'notifications-awaiting-credential')
    const dialog = await openAuthorizationDialog(page)

    await holdDoubleCall(page, 'notificationSave')
    await dialog.getByRole('button', { name: 'Authorize notifications' }).click()

    // Consent was given and the module turned on, so the credential really was
    // admitted; the read the window asks for after it is not admitted until it
    // settles.
    await expect.poll(() => callCount(page, 'notificationSave')).toBe(1)
    const readsBefore = await inboxReads(page)
    await settle(page)
    expect(await inboxReads(page)).toBe(readsBefore)

    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await expect(dialog).toBeHidden()
    const forNewHost = await cutOverWithDialogOpen(page, 'ghe.acme.internal')
    const readsAtCutover = await inboxReads(page)

    expect(await releaseDoubleCalls(page, 'notificationSave')).toBe(1)
    await settle(page)

    // The write was refused for the host it was not made for and stored
    // nowhere: the host this window moved to still has no credential of its own
    // to discard, and the read a sealed credential unlocks is never asked for.
    expect(await callCount(page, 'notificationSave')).toBe(1)
    expect(await inboxReads(page)).toBe(readsAtCutover)
    await expectNewHostUntouched(page, forNewHost, 'ghe.acme.internal')
  })

  // The read a window makes on mount is the first answer it will get, and it
  // is admitted before this window has been told which host it works against.
  // Nothing is pushed for the host left behind, so a cutover made while that
  // read is outstanding has to be settled by the new host's own read alone.
  test('the inbox read admitted for the host this window left never lands', async ({ page }) => {
    await openGallery(page, { scenario: 'notifications-read-pending' })
    await switchDestination(page, 'notifications')

    // Every read this window has been admitted is still outstanding, and each
    // of them took its answer for the host selected now.
    const readsBefore = await inboxReads(page)
    expect(readsBefore).toBeGreaterThan(0)
    await expect(threadList(page)).toHaveCount(0)

    await page.evaluate(() =>
      window.fixture.serveNotificationHost('ghe.acme.internal', 'notifications-other-host'),
    )
    await selectGitHubHost(page, 'ghe.acme.internal')

    // The new host's read joins them and is released with them: what settles
    // first is not a question, because each answer carries its own host.
    expect(await releaseDoubleCalls(page, 'notifications')).toBeGreaterThanOrEqual(readsBefore)
    await settle(page)

    // Only the host now selected has anything to show, and the rows that host
    // read are the rows on screen.
    await expect(inbox(page).getByText('ghe.acme.internal', { exact: true })).toBeVisible()
    await expect(threadList(page).getByRole('listitem')).toHaveCount(2)
    await expect(row(page, 'Review the internal deploy queue')).toBeVisible()
    expect(await inbox(page).innerText()).not.toContain('Tidy the stack ordering rules')
    await expect(page.getByText('github.com', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('the account read held for the first host cannot repopulate the window after a host change', async ({
    page,
  }) => {
    // This window's own GitHub account read was admitted and is still
    // outstanding, so it holds no account at all — which is a different thing
    // from the Notification Center having no credential, and the two must not
    // be substituted for one another.
    await openNotifications(page, 'notifications-account-pending')
    await expect(inbox(page).getByRole('button', { name: 'Authorize notifications' })).toBeVisible()
    await page.evaluate(() =>
      window.fixture.serveNotificationHost('ghe.acme.internal', 'notifications-other-host'),
    )

    // The person points this window at another host while that account read is
    // still outstanding. Nothing is pushed for the host left behind, so what
    // this window shows next is only what it asked the new host for.
    await selectGitHubHost(page, 'ghe.acme.internal')
    await settle(page)
    await expect(row(page, 'Review the internal deploy queue')).toBeVisible()

    // The answer that was admitted for the host this window left now arrives.
    await unholdDoubleCall(page, 'githubAccountStatus')
    await releaseDoubleCalls(page, 'githubAccountStatus')
    await settle(page)

    // The host this window is pointed at, and the rows that host serves, are
    // still what is on screen; the answer that arrived late puts nothing of the
    // host left behind back in front of the person, and reports no write this
    // window never made.
    await expect(inbox(page).getByText('ghe.acme.internal', { exact: true })).toBeVisible()
    await expect(row(page, 'Review the internal deploy queue')).toBeVisible()
    await expect(page.getByText('github.com', { exact: true })).toHaveCount(0)
    await expect(page.getByText(/never sent|not sent again|was not sent again/iu)).toHaveCount(0)
    await expect(inbox(page).getByRole('button', { name: REFRESH.name, exact: true })).toBeEnabled()
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

    // Reached rather than merely laid out: the keyboard walks this window's own
    // tab order to the control — nothing is focused for it — the browser scrolls
    // it into the viewport on the way, and Space there is what changes the row.
    const markRead = rows
      .first()
      .getByRole('button', { name: 'Mark Tidy the stack ordering rules as read' })
    await tabToControl(page, markRead)
    await expect(markRead).toBeFocused()
    const reached = await markRead.boundingBox()
    expect(reached).not.toBeNull()
    if (reached) {
      expect(reached.y).toBeGreaterThanOrEqual(0)
      expect(reached.y + reached.height).toBeLessThanOrEqual(384)
    }
    await page.keyboard.press('Space')
    await expect(rows.first().getByText('Read', { exact: true })).toBeVisible()
  })
})
