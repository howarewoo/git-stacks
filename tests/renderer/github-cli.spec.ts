import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  getDispatchedActions,
  getDoubleCalls,
  getOpenedExternalUrls,
  holdDoubleCall,
  openGallery,
  publishCliStatus,
  releaseDoubleCalls,
  settle,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import type { GitHubCliStatus } from '../../src/shared/types'

/**
 * The GitHub CLI status is a report, never a control. These checks are about what
 * a person can learn and do here: the distinct state, the host it belongs to, the
 * commands to run in their own terminal, and the fact that this window changes
 * nothing about the CLI session while a local repository stays fully usable.
 *
 * The second half is the harder half. The session behind this window can be
 * replaced while it is open, and everything GitHub answered for the old one —
 * the repository's own pull request, its checks, the review workspace, and the
 * private repositories discovery found — belongs to that session rather than to
 * this window.
 */

function cliStatusButton(page: Page) {
  return page.getByTitle('GitHub CLI status')
}

/**
 * The dialog is named by its own heading, which is what a screen reader
 * announces for it.
 */
function cliStatusDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'GitHub CLI authentication' })
}

/**
 * The badges that name the state at the top of the dialog. The same state and
 * account are repeated as measured facts below them, so an assertion about one
 * has to say which of the two it means.
 */
function cliStatusBadges(page: Page): Locator {
  return cliStatusDialog(page).getByRole('region', { name: 'Status' })
}

/** The measurements themselves: what was read about this computer, one per row. */
function cliStatusFacts(page: Page): Locator {
  return cliStatusDialog(page).getByRole('region', { name: 'GitHub CLI' })
}

/** The account this window opened with, and the session that replaced it. */
const ACCOUNT_A: GitHubCliStatus = {
  state: 'authenticated',
  host: 'github.com',
  login: 'octo',
  version: '2.62.0',
  identity: 'cli:github.com:octo:1',
  message: null,
}

/** The session ends in a terminal: same host, no account, no credential. */
const ACCOUNT_B: GitHubCliStatus = {
  state: 'signed-out',
  host: 'github.com',
  login: null,
  version: '2.62.0',
  identity: null,
  message: 'No GitHub account is signed in for github.com.',
}

/** A second account for the same host, which is a replacement of the first. */
const ACCOUNT_C: GitHubCliStatus = {
  state: 'authenticated',
  host: 'github.com',
  login: 'ada',
  version: '2.62.0',
  identity: 'cli:github.com:ada:1',
  message: null,
}

async function openCliStatusDialog(page: Page, scenario: string) {
  await openGallery(page, { scenario })
  await settle(page)
  await cliStatusButton(page).click()
  await expect(cliStatusDialog(page)).toBeVisible()
  await settle(page)
}

/** The pull request this fixture's repository carries on one of its branches. */
const FIXTURE_PR_TITLE = '#41 Cover checkout validation'

test.describe('Required GitHub CLI status', () => {
  test('a computer without the CLI says so, names no account, and offers install guidance instead of a login', async ({
    page,
  }) => {
    await openCliStatusDialog(page, 'github-cli-missing')

    // The state is a fact about this computer, distinct from being signed out.
    await expect(cliStatusBadges(page).getByText('GitHub CLI not installed')).toBeVisible()
    await expect(cliStatusFacts(page).getByText('Not detected')).toBeVisible()
    await expect(cliStatusDialog(page)).toContainText('https://cli.github.com/')
    await expect(cliStatusDialog(page)).not.toContainText('gh auth login')
    await expect(cliStatusButton(page)).toHaveText('GitHub CLI: not installed')
  })

  test('an installed CLI with no account offers the host-scoped sign-in command and states that this window cannot run it', async ({
    page,
  }) => {
    await openCliStatusDialog(page, 'github-cli-signed-out')

    // The version is reported on its own: an installed CLI is not an account.
    await expect(cliStatusFacts(page).getByText('2.62.0')).toBeVisible()
    await expect(cliStatusFacts(page).getByText('None reported')).toBeVisible()
    await expect(
      cliStatusFacts(page).getByText('gh auth login --hostname github.com --web'),
    ).toBeVisible()
    await expect(cliStatusDialog(page)).toContainText('shown for you to run in a terminal')
    await expect(cliStatusButton(page)).toHaveText('GitHub CLI: signed out')
  })

  test('an authenticated session names the account and the version apart, and the only control is a real re-read', async ({
    page,
  }) => {
    await openCliStatusDialog(page, 'github-cli-authenticated')

    await expect(cliStatusBadges(page).getByText('Signed in to GitHub')).toBeVisible()
    await expect(cliStatusFacts(page).getByText('2.62.0')).toBeVisible()
    await expect(cliStatusFacts(page).getByText('octo', { exact: true })).toBeVisible()
    await expect(cliStatusButton(page)).toHaveText('GitHub CLI: signed in')

    const before = (await getDoubleCalls(page)).filter((call) => call.call === 'githubCliStatus')
    expect(before.length).toBeGreaterThan(0)

    // The session changes outside this window, so the control here reads again
    // and adopts only what it is told now. The read is held while it is asked
    // for, so the wait is a real one rather than a state this test assumes.
    await holdDoubleCall(page, 'githubCliStatus')
    const refresh = cliStatusDialog(page).getByRole('button', { name: 'Refresh status' })
    await refresh.click()
    await expect(cliStatusDialog(page).getByRole('button', { name: 'Refreshing…' })).toBeVisible()
    expect(await releaseDoubleCalls(page, 'githubCliStatus')).toBe(1)
    await settle(page)

    const after = (await getDoubleCalls(page)).filter((call) => call.call === 'githubCliStatus')
    expect(after.length).toBe(before.length + 1)
    // A re-read of the same session leaves it standing: it is the same account
    // and the same credential, so nothing on screen is a stale copy.
    await expect(cliStatusButton(page)).toHaveText('GitHub CLI: signed in')
    await expect(cliStatusFacts(page).getByText('octo', { exact: true })).toBeVisible()
    // Nothing was dispatched to the repository and no URL left this window: the
    // CLI owns the session, and reading its status is not an action.
    expect(await getDispatchedActions(page)).toEqual([])
    expect(await getOpenedExternalUrls(page)).toEqual([])
  })

  test('a session replaced while its own read is still outstanding keeps the replacement', async ({
    page,
  }) => {
    await openCliStatusDialog(page, 'github-cli-authenticated')
    await expect(cliStatusButton(page)).toHaveText('GitHub CLI: signed in')

    // A real re-read is asked for and admitted; only its answer is held back. The
    // window is now waiting on a status that is about to stop being the truth.
    await holdDoubleCall(page, 'githubCliStatus')
    await cliStatusDialog(page).getByRole('button', { name: 'Refresh status' }).click()
    await expect(cliStatusDialog(page).getByRole('button', { name: 'Refreshing…' })).toBeVisible()

    // The session ends in a terminal while that read is outstanding, and the
    // main process publishes it because this window did not cause it.
    await publishCliStatus(page, ACCOUNT_B)
    await expect(cliStatusButton(page)).toHaveText('GitHub CLI: signed out')
    await expect(cliStatusBadges(page).getByText('Not signed in')).toBeVisible()

    // The held read answers now, late, and it succeeds: it carries the account
    // and credential that have just been replaced. It must repaint neither the
    // state nor the account it was asked about.
    expect(await releaseDoubleCalls(page, 'githubCliStatus')).toBe(1)
    await settle(page)
    await expect(cliStatusButton(page)).toHaveText('GitHub CLI: signed out')
    await expect(cliStatusFacts(page).getByText('None reported')).toBeVisible()
    await expect(cliStatusDialog(page)).not.toContainText('octo')
  })

  test('a replaced account takes its pull request, checks, and review with it, and leaves local Git working', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-authenticated' })
    await settle(page)

    // The branch that carries a pull request, so the inspector's checks and the
    // review workspace both have real GitHub data behind them to be retired.
    const branch = page
      .locator('.branch-row')
      .filter({ has: page.getByText('feature/checkout-tests', { exact: true }) })
    await branch.click()
    const checks = page.getByRole('region', { name: 'Checks' })
    await expect(checks.getByText('ci', { exact: true })).toBeVisible()

    await switchDestination(page, 'review')
    // The pull request and the review conversation it carries: files, threads,
    // and somebody else's comment, all read as this account.
    await expect(page.locator('.review-headline').getByText(FIXTURE_PR_TITLE)).toBeVisible()
    await expect(page.getByText('src/main/review.ts', { exact: true }).first()).toBeVisible()
    await expect(
      page.getByText('Should this be re-read when the base moves, or is the head enough?'),
    ).toBeVisible()
    await switchDestination(page, 'branches')
    await expect(checks.getByText('ci', { exact: true })).toBeVisible()

    // A repository read is asked for and admitted before any of this happens, so
    // there is an outstanding operation to retire rather than an idle window.
    await holdDoubleCall(page, 'refresh')
    const refresh = page.getByRole('button', { name: 'Refresh repository' })
    await refresh.click()
    await expect(refresh).toBeDisabled()

    await publishCliStatus(page, ACCOUNT_B)

    // The busy state belongs to the read, not to the window: a result this window
    // has refused must not leave local Git disabled while it waits to settle.
    await expect(refresh).toBeEnabled()
    await expect(page.getByRole('button', { name: 'New branch' })).toBeEnabled()
    // Nothing GitHub answered for the replaced account is left on screen: the
    // pull request this branch carried, and the checks read for it.
    await expect(page.getByText('No pull request for this branch.')).toBeVisible()
    await expect(checks).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Review changes' })).toHaveCount(0)
    await expect(page.getByRole('toolbar', { name: 'Repository actions' })).toBeVisible()
    await expect(branch).toHaveCount(1)

    // Local Git still reads. The read asked for now is the window's own, and the
    // retired one answering afterwards must not report it as finished.
    await refresh.click()
    await expect(refresh).toBeDisabled()
    expect(await releaseDoubleCalls(page, 'refresh', 'oldest')).toBe(1)
    await settle(page)
    await expect(refresh).toBeDisabled()
    expect(await releaseDoubleCalls(page, 'refresh', 'newest')).toBe(1)
    await settle(page)
    await expect(refresh).toBeEnabled()

    // Discovery is that account's to read as well: the onboarding pane is the
    // only place it can be opened from, and this window has a repository open.

    // The session on screen is still the one that replaced it.
    await expect(cliStatusButton(page)).toHaveText('GitHub CLI: signed out')
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('a replaced account takes the private repositories it had discovered with it, and a held search cannot bring them back', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-discovery' })
    await settle(page)
    await page.getByRole('button', { name: 'Search GitHub' }).click()
    const discovery = page.getByRole('dialog', { name: 'Clone from GitHub' })
    await expect(discovery).toBeVisible()

    // A search as the signed-in account answers with repositories that account
    // alone can see, and choosing one composes the exact commands a clone would
    // run. Both are facts about the account, not about GitHub.
    const fields = discovery.getByRole('textbox')
    await fields.first().fill('private')
    const octoPrivate = discovery.getByRole('listitem').filter({ hasText: 'acme/octo-private' })
    await expect(octoPrivate).toBeVisible()
    await octoPrivate.click()
    // The transport and depth the person chose are ordinary local Git.
    await discovery.getByRole('checkbox').check()
    await discovery.getByRole('button', { name: 'Choose folder' }).click()
    await fields.nth(1).fill('widget')
    // The clone section for what it found belongs to that finding.
    await expect(discovery.getByRole('heading', { name: 'Clone acme/octo-private' })).toBeVisible()

    await expect(discovery.getByRole('checkbox')).toBeChecked()
    // A search asked for under this account, and still outstanding when the
    // account is replaced, is the case the fence exists for. It is held first, so
    // the read that answers late is genuinely the old account's own request and
    // not a search the replacement happened to make afterwards.
    await holdDoubleCall(page, 'searchRepositories')
    await fields.first().fill('widgets')
    await fields.first().press('Enter')
    await settle(page)
    // The search this window is waiting on is visible: the Search control is
    // disabled, and a read it cannot yet stop is offered one it can. Nothing
    // about the request itself is asserted here.
    await expect(discovery.getByRole('button', { name: 'Search', exact: true })).toBeDisabled()
    await expect(discovery.getByRole('button', { name: 'Cancel' })).toBeVisible()

    // Another account for the same host takes this window over while that read
    // is still outstanding. The findings, the selection, and the commands
    // composed for them are that account's to see; the words the person typed
    // are ordinary local Git and stay.
    await publishCliStatus(page, ACCOUNT_C)
    await expect(discovery.getByRole('listitem').filter({ hasText: 'octo-private' })).toHaveCount(0)
    await expect(discovery.getByRole('heading', { name: 'Clone acme/octo-private' })).toHaveCount(0)
    await expect(fields.first()).toHaveValue('widgets')

    // The account now in effect is asked for its own repositories, and that read
    // is held with the old one's. It lands first and is adopted: this window can
    // offer what the new account can reach.
    expect(await releaseDoubleCalls(page, 'searchRepositories', 'newest')).toBe(1)
    await settle(page)
    await expect(discovery.getByRole('listitem').filter({ hasText: 'ada-private' })).toBeVisible()
    await expect(discovery.getByRole('listitem').filter({ hasText: 'octo-private' })).toHaveCount(0)

    // The replaced account's search answers now, late, and it succeeds: it names
    // the private repositories the previous account alone could see. It is taken
    // and never repopulates this list, so nothing about the old account comes
    // back after the new one has been shown.
    expect(await releaseDoubleCalls(page, 'searchRepositories', 'oldest')).toBe(1)
    await settle(page)
    await expect(discovery.getByRole('listitem').filter({ hasText: 'ada-private' })).toBeVisible()
    await expect(discovery.getByRole('listitem').filter({ hasText: 'octo-private' })).toHaveCount(0)
    await expect(fields.first()).toHaveValue('widgets')

    // What the person chose is local Git and belongs to them, not to either
    // account: the transport, the depth, and the words they typed carry over to
    // what the new account found, and the clone section names that one. The
    // folder is the repository they just chose, because that is what is about to
    // be cloned — choosing a repository names its folder.
    await discovery.getByRole('listitem').filter({ hasText: 'ada-private' }).click()
    await expect(discovery.getByRole('heading', { name: 'Clone acme/ada-private' })).toBeVisible()
    await expect(discovery.getByRole('checkbox')).toBeChecked()
    await expect(fields.nth(1)).toHaveValue('ada-private')
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('the status can be copied for a terminal, and copying is all this window does with it', async ({
    page,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openCliStatusDialog(page, 'github-cli-signed-out')

    await cliStatusDialog(page).getByRole('button', { name: 'Copy the sign in command' }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'gh auth login --hostname github.com --web',
    )
    // The confirmation is in place and announced, so a person who cannot see the
    // icon change still learns the command reached the clipboard.
    await expect(
      cliStatusDialog(page).getByRole('button', { name: 'Copy the sign in command' }),
    ).toHaveText('Copied')
    await expect(cliStatusDialog(page)).toContainText('Sign in command copied')
    // A copied command is still not a command this window ran.
    expect(await getDispatchedActions(page)).toEqual([])
    expect(await getOpenedExternalUrls(page)).toEqual([])
  })

  test('searching without a CLI names that fact, while local Git is offered without it', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-missing' })
    await settle(page)

    // The local path to a repository is not gated on GitHub at all: this window
    // opens with recent repositories and can add one that is already here.
    await expect(page.getByRole('button', { name: 'Add local repository' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Recent repositories' })).toBeVisible()

    await page.getByRole('button', { name: 'Search GitHub' }).click()
    const dialog = page.getByRole('dialog', { name: 'Clone from GitHub' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Search your repositories' }).fill('widgets')
    await dialog.getByRole('button', { name: 'Search', exact: true }).click()
    await settle(page)

    // The refusal says what is actually missing on this computer, and the way to
    // see the whole status is this window's report rather than a sign-in control
    // of its own.
    await expect(
      dialog.getByText('The GitHub CLI could not be run on this computer.'),
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Open GitHub CLI status' }).click()
    await expect(cliStatusDialog(page)).toBeVisible()
  })

  test('a search with no account for this host names the host it could not authenticate against', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-signed-out' })
    await settle(page)

    await page.getByRole('button', { name: 'Search GitHub' }).click()
    const dialog = page.getByRole('dialog', { name: 'Clone from GitHub' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Search your repositories' }).fill('widgets')
    await dialog.getByRole('button', { name: 'Search', exact: true }).click()
    await settle(page)

    await expect(
      dialog.getByText('The GitHub CLI has no account signed in for github.com.'),
    ).toBeVisible()
    // A search asked for here dispatches nothing local and authenticates nobody:
    // it reports what the CLI can do for this host, which right now is nothing.
    expect(await getDispatchedActions(page)).toEqual([])
    await expect(dialog.getByRole('listitem')).toHaveCount(0)
  })

  test('the notification inbox keeps its own credential and consent, which this CLI status neither offers nor claims', async ({
    page,
  }) => {
    await openCliStatusDialog(page, 'github-cli-signed-out')

    // The status surface reports the CLI session and nothing else: the
    // separately authorized notifications inbox, its token, and its consent all
    // live in Settings > Notifications, and none of them appear here.
    const dialog = cliStatusDialog(page)
    await expect(dialog.getByText(/notification/iu)).toHaveCount(0)
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  })
})
