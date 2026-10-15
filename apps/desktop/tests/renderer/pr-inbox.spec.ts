import { expect, test, type Locator, type Page } from '@playwright/test'
import { assertNoAxeViolations } from './helpers/axe'
import { switchDestination } from './helpers/destinations'
import { scenarios } from './fixtures/scenarios'
import type { GitHubCliStatus } from '@git-stacks/shared/types'
import {
  answerNextDoubleCall,
  changeScenario,
  failNextDoubleCall,
  getDoubleCalls,
  holdDoubleCall,
  openGallery,
  publishCliStatus,
  releaseDoubleCalls,
  serveCliStatus,
  settle,
  STANDARD_VIEWPORTS,
  switchGalleryRoute,
  unholdDoubleCall,
} from './helpers/gallery'

/** The account the newly named host authenticates as, as the CLI reports it. */
const HOST_B: GitHubCliStatus = {
  state: 'authenticated',
  host: 'ghe.example.com',
  login: 'octo',
  version: '2.62.0',
  identity: 'cli:ghe.example.com:octo:1',
  message: null,
}

function rows(page: Page): Locator {
  return page.locator('.wb-attention-row')
}

/** A focused fact/control must be reachable through every clipping ancestor. */
async function assertReachableInboxElement(element: Locator): Promise<void> {
  await element.scrollIntoViewIfNeeded()
  const bounds = await element.evaluate((target) => {
    const rect = target.getBoundingClientRect()
    const visible = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const box = parent.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        visible.left = Math.max(visible.left, box.left + parent.clientLeft)
        visible.right = Math.min(visible.right, box.left + parent.clientLeft + parent.clientWidth)
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        visible.top = Math.max(visible.top, box.top + parent.clientTop)
        visible.bottom = Math.min(visible.bottom, box.top + parent.clientTop + parent.clientHeight)
      }
    }
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      visible,
    }
  })
  expect(bounds.rect.left).toBeGreaterThanOrEqual(bounds.visible.left - 1)
  expect(bounds.rect.right).toBeLessThanOrEqual(bounds.visible.right + 1)
  expect(bounds.rect.top).toBeGreaterThanOrEqual(bounds.visible.top - 1)
  expect(bounds.rect.bottom).toBeLessThanOrEqual(bounds.visible.bottom + 1)
}

test.describe('Needs attention queue', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-queue' })
    await switchDestination(page, 'attention')
  })

  test('the attention groups report the counts the attention model decides', async ({ page }) => {
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: 'Review requested and new published heads 1',
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { level: 2, name: 'Needs response or changes 1' }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Failed checks 1' })).toBeVisible()

    await expect(rows(page)).toHaveCount(3)
    const reviewRequested = rows(page).filter({ hasText: 'Add a GitHub-derived PR Inbox' })
    await expect(reviewRequested).toContainText('Direct review requested from you')

    const needsResponse = rows(page).filter({
      hasText: 'Keep the Inbox rows an earlier account read off the screen',
    })
    await expect(needsResponse).toContainText('Review or comment needs your response')

    const failingChecks = rows(page).filter({
      hasText: 'Charge every native-stack page to the refresh budget',
    })
    await expect(failingChecks).toContainText('Published-head checks failing')

    await expect(page.getByRole('status')).toContainText(
      '3 distinct observed items; reasons are not added to the item count.',
    )
    expect((await getDoubleCalls(page)).filter((entry) => entry.call === 'runAction')).toEqual([])
  })

  test('a row opens that row’s own selected Review, and dispatches no Git action', async ({
    page,
  }) => {
    await rows(page).filter({ hasText: 'Add a GitHub-derived PR Inbox' }).click()
    await expect(page.locator('.review-headline')).toContainText(
      '#81 Add a GitHub-derived PR Inbox across registered repositories',
    )
    await expect(
      page.getByRole('main', { name: 'review', exact: true }).getByText('checks passing').first(),
    ).toBeVisible()
    await expect(page.getByText('Pull request #81 is not in this fixture snapshot')).toHaveCount(0)
    await expect(page.getByText('Choose a qualified pull request.')).toHaveCount(0)

    const calls = await getDoubleCalls(page)
    expect(calls.filter((entry) => entry.call === 'runAction')).toHaveLength(0)
  })

  test('a row from another registered repository opens that repository and its Review', async ({
    page,
  }) => {
    await expect(rows(page)).toHaveCount(3)
    await rows(page).filter({ hasText: 'Charge every native-stack page' }).click()

    const opened = (await getDoubleCalls(page)).filter((entry) => entry.call === 'openRepository')
    expect(opened).toHaveLength(0)

    await expect(page.locator('.review-headline')).toContainText(
      '#77 Charge every native-stack page to the refresh budget',
    )
    await expect(
      page.getByRole('main', { name: 'review', exact: true }).getByText('checks failing').first(),
    ).toBeVisible()
    await expect(page.getByText('Pull request #77 is not in this fixture snapshot')).toHaveCount(0)
    await expect(page.getByText('Choose a qualified pull request.')).toHaveCount(0)

    await expect(
      page.getByRole('button', { name: /^howarewoo\/design-system-specimens ·/u }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('the search chord reaches the queue, with a repository open and without one', async ({
    page,
  }) => {
    await page.getByRole('heading', { level: 1, name: 'Needs attention' }).click()
    await page.keyboard.press('/')
    const search = page.getByRole('textbox', { name: 'Search needs attention' })
    await expect(search).toBeFocused()
    await search.pressSequentially('specimens')
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('Charge every native-stack page')

    await openGallery(page, { scenario: 'pr-inbox-no-repository' })
    await switchDestination(page, 'attention')
    await page.getByRole('heading', { level: 1, name: 'Needs attention' }).click()
    await page.keyboard.press('/')
    const queueSearch = page.getByRole('textbox', { name: 'Search needs attention' })
    await expect(queueSearch).toBeFocused()
    await queueSearch.pressSequentially('Add a GitHub-derived')
    await expect(rows(page)).toHaveCount(1)
  })

  test('search is keyboard-entered, and an empty result is stated against the queue', async ({
    page,
  }) => {
    const search = page.getByRole('textbox', { name: 'Search needs attention' })
    await search.click()
    await search.pressSequentially('response')
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText(
      'Keep the Inbox rows an earlier account read off the screen',
    )

    await search.pressSequentially(' zzz')
    await expect(rows(page)).toHaveCount(0)
    await expect(
      page.getByText(
        'No matching observed items. Incomplete sources may contain work not listed here.',
      ),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(rows(page)).toHaveCount(3)
  })

  test('filtering by repository narrows the displayed attention rows', async ({ page }) => {
    const repoSelect = page.getByRole('combobox', { name: 'Attention repository' })
    await repoSelect.click()
    await page.getByRole('option', { name: 'github.com/howarewoo/design-system-specimens' }).click()
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('Charge every native-stack page')

    await repoSelect.click()
    await page.getByRole('option', { name: 'github.com/howarewoo/git-stacks' }).click()
    await expect(rows(page)).toHaveCount(2)

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(rows(page)).toHaveCount(3)
  })

  test('a saved filter is stored, listed, applied, and removed through the queue', async ({
    page,
  }) => {
    const name = page.getByRole('textbox', { name: 'Attention filter name' })
    const save = page.getByRole('button', { name: 'Save filter', exact: true })
    const deleteButton = page.getByRole('button', { name: 'Delete saved filter', exact: true })

    await expect(save).toBeDisabled()
    await expect(deleteButton).toBeDisabled()

    await name.click()
    await name.pressSequentially('Awaiting Ada')
    await expect(save).toBeEnabled()

    await holdDoubleCall(page, 'savePullRequestInboxFilters')
    await save.click()
    await expect(name).toBeDisabled()
    await expect(save).toBeDisabled()
    await releaseDoubleCalls(page, 'savePullRequestInboxFilters')
    await settle(page)

    await expect(name).toHaveValue('')
    await expect(deleteButton).toBeEnabled()

    const savedSelect = page.getByRole('combobox', { name: 'Saved attention filter' })
    await savedSelect.click()
    await expect(page.getByRole('option', { name: 'Awaiting Ada' })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await savedSelect.click()
    await page.getByRole('option', { name: 'Awaiting Ada' }).click()
    await expect(deleteButton).toBeEnabled()

    await deleteButton.click()
    await settle(page)
    await expect(deleteButton).toBeDisabled()
    await savedSelect.click()
    await expect(page.getByRole('option', { name: 'Awaiting Ada' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('a refused saved-filter write releases the submitting state without claiming a saved filter', async ({
    page,
  }) => {
    const save = page.getByRole('button', { name: 'Save filter', exact: true })
    const name = page.getByRole('textbox', { name: 'Attention filter name' })
    await name.fill('Refused save')
    await holdDoubleCall(page, 'savePullRequestInboxFilters')
    await save.click()
    await expect(name).toBeDisabled()
    await expect(save).toBeDisabled()
    await page.evaluate(() =>
      window.fixture.failNext('savePullRequestInboxFilters', 'Saved-filter write refused'),
    )
    await releaseDoubleCalls(page, 'savePullRequestInboxFilters')
    await settle(page)

    await expect(page.getByRole('alert')).toContainText('Saved-filter write refused')
    await expect(name).toBeEnabled()
    await expect(save).toBeEnabled()

    const savedSelect = page.getByRole('combobox', { name: 'Saved attention filter' })
    await savedSelect.click()
    await expect(page.getByRole('option', { name: 'Refused save' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    expect(
      (await getDoubleCalls(page)).filter((entry) => entry.call === 'savePullRequestInboxFilters'),
    ).toHaveLength(1)
  })

  test('the saved-filter controls stay locked while the stored list is still being read', async ({
    page,
  }) => {
    const name = page.getByRole('textbox', { name: 'Attention filter name' })
    const save = page.getByRole('button', { name: 'Save filter', exact: true })
    await name.click()
    await name.pressSequentially('Awaiting Ada')
    await save.click()
    await settle(page)

    await switchGalleryRoute(page, 'index')
    await holdDoubleCall(page, 'pullRequestInboxFilters')
    await switchGalleryRoute(page, 'app')
    await switchDestination(page, 'attention')

    const remountedName = page.getByRole('textbox', { name: 'Attention filter name' })
    const remountedSave = page.getByRole('button', { name: 'Save filter', exact: true })
    const remountedDelete = page.getByRole('button', { name: 'Delete saved filter', exact: true })

    await expect(remountedName).toBeDisabled()
    await expect(remountedSave).toBeDisabled()
    await expect(remountedDelete).toBeDisabled()

    expect(await releaseDoubleCalls(page, 'pullRequestInboxFilters')).toBe(1)
    await settle(page)

    await expect(remountedName).toBeEnabled()
    const savedSelect = page.getByRole('combobox', { name: 'Saved attention filter' })
    await savedSelect.click()
    await expect(page.getByRole('option', { name: 'Awaiting Ada' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('a replacement the store refuses keeps the filter it was going to replace', async ({
    page,
  }) => {
    const name = page.getByRole('textbox', { name: 'Attention filter name' })
    const save = page.getByRole('button', { name: 'Save filter', exact: true })
    await name.click()
    await name.pressSequentially('Awaiting Ada')
    await save.click()
    await settle(page)

    const search = page.getByRole('textbox', { name: 'Search needs attention' })
    await search.click()
    await search.pressSequentially('a'.repeat(201))

    await name.click()
    await name.pressSequentially('Awaiting Ada')
    await save.click()
    await settle(page)

    await expect(page.getByRole('alert')).toBeVisible()

    const savedSelect = page.getByRole('combobox', { name: 'Saved attention filter' })
    await savedSelect.click()
    await expect(page.getByRole('option', { name: 'Awaiting Ada' })).toHaveCount(1)
    await page.getByRole('option', { name: 'Awaiting Ada' }).click()

    await expect(search).toHaveValue('')
    await expect(rows(page)).toHaveCount(3)
  })

  test('a refused refresh keeps the confirmed rows behind the reason', async ({ page }) => {
    await failNextDoubleCall(page, 'pullRequestInbox', 'the queue read was refused')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('the queue read was refused')
    await expect(rows(page)).toHaveCount(3)
  })

  test('a retired read shows an empty queue and blames neither the account nor the network', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'pr-inbox-retired' })
    await switchDestination(page, 'attention')
    await expect(rows(page)).toHaveCount(0)

    await expect(page.getByRole('status')).toContainText('ended before it confirmed')
    await expect(
      page.getByText(
        'No matching observed items. Incomplete sources may contain work not listed here.',
      ),
    ).toBeVisible()

    await expect(page.getByText('Sign in')).toHaveCount(0)
    await expect(page.getByText('unreachable')).toHaveCount(0)
    await expect(page.getByText('never been read')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  })

  test('leaving the destination abandons the refresh it started, and the late answer paints nothing', async ({
    page,
  }) => {
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
    await holdDoubleCall(page, 'pullRequestInbox')
    await failNextDoubleCall(page, 'pullRequestInbox', 'the abandoned read failed')
    await refresh.click()
    await expect(refresh).toBeDisabled()

    await switchDestination(page, 'branches')
    await switchDestination(page, 'attention')
    await expect(refresh).toBeDisabled()

    const started = (await getDoubleCalls(page)).filter(
      (entry) => entry.call === 'pullRequestInbox',
    )
    expect(started.length).toBeGreaterThanOrEqual(2)
    expect(await releaseDoubleCalls(page, 'pullRequestInbox')).toBeGreaterThanOrEqual(1)
    await settle(page)

    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  })

  test('a read that loses its check and review fields says unknown, without a reload', async ({
    page,
  }) => {
    await expect(rows(page).filter({ hasText: 'Charge every native-stack page' })).toContainText(
      'Published-head checks failing',
    )

    await changeScenario(page, 'pr-inbox-partial')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await settle(page)

    const degraded = rows(page).filter({ hasText: 'Charge every native-stack page' })
    await expect(degraded).not.toContainText('Published-head checks failing')
    await expect(page.getByRole('status')).toContainText('Some repositories could not be read')

    const reported = rows(page).filter({ hasText: 'Add a GitHub-derived PR Inbox' })
    await expect(reported).toContainText('Direct review requested from you')
  })

  test('the queue surface has no axe violations', async ({ page }) => {
    await assertNoAxeViolations(page, 'Needs attention destination', { allRules: true })
  })
})

test.describe('Needs attention states', () => {
  test('a confirmed read that holds nothing reads as empty, not unconfirmed', async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-empty' })
    await switchDestination(page, 'attention')
    await expect(rows(page)).toHaveCount(0)
    await expect(
      page.getByText(
        'No matching observed items. Incomplete sources may contain work not listed here.',
      ),
    ).toBeVisible()
    await expect(page.getByText('The queue is unconfirmed')).toHaveCount(0)
  })

  test('a degraded repository is named and never counted as fully read', async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-partial' })
    await switchDestination(page, 'attention')
    await expect(page.getByRole('status')).toContainText('Some repositories could not be read')
    await expect(rows(page)).toHaveCount(3)
  })

  test('an unreachable GitHub keeps the confirmed rows behind the reason', async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-unavailable' })
    await switchDestination(page, 'attention')
    await expect(page.getByRole('status')).toContainText('GitHub could not be reached')
    await expect(rows(page)).toHaveCount(3)
  })

  test('the queue stays operable at the 200% reflow', async ({ page }) => {
    await openGallery(page, {
      scenario: 'pr-inbox-queue',
      viewport: STANDARD_VIEWPORTS.zoom200,
    })
    await switchDestination(page, 'attention')
    await settle(page)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false)
    for (const control of [
      page.getByRole('textbox', { name: 'Search needs attention' }),
      page.getByRole('combobox', { name: 'Attention repository' }),
      page.getByRole('textbox', { name: 'Attention filter name' }),
      page.getByRole('button', { name: 'Save filter', exact: true }),
      page.getByRole('button', { name: 'Clear filters', exact: true }),
    ]) {
      await expect(control).toBeVisible()
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(720)
      }
    }
  })

  test('a queue nothing has ever confirmed reads as being read, not as unconfirmed', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'pr-inbox-first-read' })
    await holdDoubleCall(page, 'pullRequestInbox')
    await switchDestination(page, 'attention')
    await expect(page.getByText('Reading source-backed attention…')).toBeVisible()
    await expect(page.getByText('The queue is unconfirmed')).toHaveCount(0)

    await releaseDoubleCalls(page, 'pullRequestInbox')
    await settle(page)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
  })

  test('the rows on screen are the ones the read reported, and the read can be repeated', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'pr-inbox-queue' })
    await switchDestination(page, 'attention')
    await expect(rows(page)).toHaveCount(3)

    await switchDestination(page, 'pullRequests')
    await switchDestination(page, 'attention')
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  })
})

test.describe('Needs attention to Review, in one window', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-queue' })
    await switchDestination(page, 'attention')
  })

  test('one walk through the queue reads both pull requests without touching Git', async ({
    page,
  }) => {
    await rows(page).filter({ hasText: 'Add a GitHub-derived PR Inbox' }).click()
    await expect(page.locator('.review-headline')).toContainText(
      '#81 Add a GitHub-derived PR Inbox across registered repositories',
    )
    await expect(
      page.getByRole('main', { name: 'review', exact: true }).getByText('checks passing').first(),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Return to origin', exact: true }).click()
    await expect(rows(page)).toHaveCount(3)

    await rows(page).filter({ hasText: 'Charge every native-stack page' }).click()
    await expect(page.locator('.review-headline')).toContainText(
      '#77 Charge every native-stack page to the refresh budget',
    )
    await expect(
      page.getByRole('main', { name: 'review', exact: true }).getByText('checks failing').first(),
    ).toBeVisible()

    await expect(
      page.getByRole('button', { name: /^howarewoo\/design-system-specimens ·/u }),
    ).toHaveAttribute('aria-pressed', 'true')

    const reads = (await getDoubleCalls(page)).filter(
      (entry) => entry.call === 'reviewFiles' || entry.call === 'reviewCommits',
    )
    expect(reads.filter((entry) => entry.args[0] === 81).length).toBeGreaterThan(0)
    expect(reads.filter((entry) => entry.args[0] === 77).length).toBeGreaterThan(0)
    expect((await getDoubleCalls(page)).filter((entry) => entry.call === 'runAction')).toHaveLength(
      0,
    )

    await page.getByRole('button', { name: 'Return to origin', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await settle(page)
    await expect(rows(page)).toHaveCount(3)
  })
})

test.describe('Needs attention transitions', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-queue' })
    await switchDestination(page, 'attention')
    await expect(rows(page)).toHaveCount(3)
  })

  test('a retired Inbox read removes personal reasons but keeps independent repository checks', async ({
    page,
  }) => {
    const search = page.getByRole('textbox', { name: 'Search needs attention' })
    await search.click()
    await search.pressSequentially('native-stack')
    await expect(rows(page)).toHaveCount(1)

    await answerNextDoubleCall(page, 'pullRequestInbox', scenarios['pr-inbox-retired']?.inbox)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await settle(page)

    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('Published-head checks failing')
    await expect(rows(page).first()).not.toContainText('Direct review requested from you')
    await expect(search).toHaveValue('native-stack')
    await expect(page.getByRole('status')).toContainText('ended before it confirmed')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a read that ended after a newer one answered cannot take its rows with it', async ({
    page,
  }) => {
    await holdDoubleCall(page, 'pullRequestInbox')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await switchDestination(page, 'branches')
    await switchDestination(page, 'attention')

    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'newest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(3)

    await answerNextDoubleCall(page, 'pullRequestInbox', scenarios['pr-inbox-retired']?.inbox)

    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'oldest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(3)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a superseded read failing while a newer read is pending paints no error and leaves the queue pending', async ({
    page,
  }) => {
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
    await holdDoubleCall(page, 'pullRequestInbox')
    await failNextDoubleCall(page, 'pullRequestInbox', 'superseded read network failure')
    await refresh.click()
    await switchDestination(page, 'branches')
    await switchDestination(page, 'attention')

    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'oldest')).toBe(1)
    await settle(page)

    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(3)
    await expect(refresh).toBeDisabled()

    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'oldest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(3)
    await expect(refresh).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a read that names no account stops listing viewer-relative work, and says why', async ({
    page,
  }) => {
    await changeScenario(page, 'pr-inbox-membership-unknown')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await settle(page)

    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('Charge every native-stack page')
  })
})

test.describe('Needs attention identity', () => {
  test('a host change retires personal reads without hiding independent repository checks', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'pr-inbox-host-switch' })
    await switchDestination(page, 'attention')

    const search = page.getByRole('textbox', { name: 'Search needs attention' })
    await search.click()
    await search.pressSequentially('native-stack')
    await expect(rows(page)).toHaveCount(1)

    const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
    await holdDoubleCall(page, 'pullRequestInbox')
    await refresh.click()
    await expect(refresh).toBeDisabled()

    await search.blur()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    await dialog
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'GitHub', exact: true })
      .click()
    await dialog.getByRole('textbox', { name: 'Host' }).fill('ghe.example.com')
    await serveCliStatus(page, HOST_B)
    await dialog.getByRole('button', { name: 'Use this host' }).click()
    await expect(dialog.getByText('GitHub host set to ghe.example.com.')).toBeVisible()
    await page.keyboard.press('Escape')
    await settle(page)

    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).not.toContainText('Direct review requested from you')
    await expect(search).toHaveValue('native-stack')
    await expect(page.getByRole('alert')).toHaveCount(0)

    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'oldest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).not.toContainText('Direct review requested from you')
    await expect(page.getByRole('alert')).toHaveCount(0)

    expect(await releaseDoubleCalls(page, 'githubCliStatus', 'oldest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).not.toContainText('Direct review requested from you')
    await expect(page.getByRole('alert')).toHaveCount(0)

    await unholdDoubleCall(page, 'pullRequestInbox')
    await releaseDoubleCalls(page, 'pullRequestInbox')
    await publishCliStatus(page, HOST_B)
    await settle(page)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await settle(page)
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('Published-head checks failing')
    await expect(rows(page).first()).not.toContainText('Direct review requested from you')
    await expect(rows(page).first()).not.toContainText('on ghe.example.com')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test.describe('structured Needs attention views', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-structured' })
    await switchDestination(page, 'attention')
  })

  test('an existing mixed-case repository filter keeps its matching provider work', async ({
    page,
  }) => {
    await switchGalleryRoute(page, 'index')
    await answerNextDoubleCall(page, 'pullRequestInboxFilters', [
      {
        id: 'mixed-case',
        name: 'Mixed case repository',
        group: 'review-requested',
        search: '',
        criteria: { repositories: ['HOWAREWOO/git-stacks'], authors: ['grace'] },
        sort: 'size-desc',
      },
    ])
    await switchGalleryRoute(page, 'app')
    await switchDestination(page, 'attention')
    await page.getByRole('combobox', { name: 'Saved attention filter' }).click()
    await page.getByRole('option', { name: 'Mixed case repository', exact: true }).click()
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('#81 Add a GitHub-derived PR Inbox')
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expect(rows(page)).toHaveCount(3)
  })

  test('same-number cross-repository rows preserve read-only Review navigation', async ({
    page,
  }) => {
    await rows(page).filter({ hasText: 'Keep repository identity stable' }).click()
    await expect(page.locator('.review-headline')).toContainText(
      '#81 Keep repository identity stable',
    )
    const calls = await getDoubleCalls(page)
    expect(calls.filter((entry) => entry.call === 'openRepository')).toHaveLength(0)
    await expect(
      page.getByRole('button', { name: /^howarewoo\/design-system-specimens ·/u }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(calls.filter((entry) => entry.call === 'runAction')).toHaveLength(0)
  })

  for (const viewport of [
    { width: 1000, height: 700 },
    { width: 1440, height: 940 },
    { width: 720, height: 470 },
  ]) {
    test(`long-title structured queue is accessible at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport)
      await expect(rows(page)).toHaveCount(3)
      await assertNoAxeViolations(page, `structured Attention ${viewport.width}x${viewport.height}`)
      const longRow = rows(page).filter({ hasText: 'Keep repository identity stable' })
      await expect(longRow).toBeVisible()
      await assertReachableInboxElement(
        page.getByRole('textbox', { name: 'Search needs attention' }),
      )
      await assertReachableInboxElement(
        page.getByRole('combobox', { name: 'Attention repository' }),
      )
      await assertReachableInboxElement(
        page.getByRole('textbox', { name: 'Attention filter name' }),
      )
      await assertReachableInboxElement(
        page.getByRole('button', { name: 'Clear filters', exact: true }),
      )
    })
  }
})
