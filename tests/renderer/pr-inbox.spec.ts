import { expect, test, type Locator, type Page } from '@playwright/test'
import { assertNoAxeViolations } from './helpers/axe'
import { switchDestination } from './helpers/destinations'
import { scenarios } from './fixtures/scenarios'
import {
  answerNextDoubleCall,
  changeScenario,
  failNextDoubleCall,
  getDoubleCalls,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
  switchGalleryRoute,
  STANDARD_VIEWPORTS,
} from './helpers/gallery'

/** The six groups, in the order the queue declares them, with the counts its fixture facts decide. */
const GROUP_COUNTS: readonly (readonly [string, number])[] = [
  ['Review requested', 2],
  ['Needs my response', 1],
  ['My PRs — waiting', 1],
  ['My PRs — approved', 0],
  ['Drafts', 1],
  ['Recently merged', 1],
]

/** The group rail is the queue's own landmark, so specs resolve it the way a reader would. */
function groupRail(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Inbox groups' })
}

function rows(page: Page): Locator {
  return page.locator('.pr-inbox-item')
}

test.describe('PR Inbox queue', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-queue' })
    await switchDestination(page, 'prInbox')
  })

  test('the six groups report the counts the GitHub facts decide', async ({ page }) => {
    const rail = groupRail(page)
    await expect(rail.getByRole('button')).toHaveCount(GROUP_COUNTS.length)
    for (const [label, count] of GROUP_COUNTS) {
      await expect(rail.getByRole('button', { name: `${label} ${count}` })).toBeVisible()
    }
    // The rail counts what a person could go and work, so a pull request no
    // group can hold never appears as queue work.
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).first()).toContainText('Add a GitHub-derived PR Inbox')
    await expect(rows(page).nth(1)).toContainText('Charge every native-stack page')
  })

  test('a row names the author it was given, and admits when there was none', async ({ page }) => {
    // What the search matches has to be what the row says, or a person
    // searching by a colleague's login is looking for something the queue
    // never claimed to hold.
    const named = rows(page).filter({ hasText: 'Add a GitHub-derived PR Inbox' })
    await expect(named).toContainText('opened by grace')
    await expect(named.getByRole('button')).toHaveAttribute('aria-label', /opened by grace/u)

    // A host that reports no author says that rather than naming one, so the
    // fallback has to be reachable from a real row rather than only from a
    // hand-written label.
    await groupRail(page).getByRole('button', { name: 'Recently merged 1' }).click()
    const unnamed = rows(page).filter({ hasText: 'Land the first queue read' })
    await expect(unnamed).toContainText('author not reported')
    await expect(unnamed.getByRole('button')).toHaveAttribute('aria-label', /author not reported/u)
    await expect(unnamed).not.toContainText('opened by')

    // The login is searchable, and searching it finds the rows that name it.
    await groupRail(page).getByRole('button', { name: 'Review requested 2' }).click()
    const search = page.getByRole('searchbox', { name: 'Search the queue' })
    await search.click()
    await search.pressSequentially('grace')
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).filter({ hasText: 'Add a GitHub-derived PR Inbox' })).toBeVisible()
    await expect(rows(page).filter({ hasText: 'Charge every native-stack page' })).toBeVisible()
  })

  test('a row opens that row’s own selected Review, and dispatches no Git action', async ({
    page,
  }) => {
    await rows(page).first().getByRole('button').click()
    // The selected pull request is the one the row named, read from the
    // repository that opened. A Review destination that renders its heading
    // while reporting no pull request selected has not answered the row at all.
    await expect(
      page.getByText('#81 Add a GitHub-derived PR Inbox across registered repositories').first(),
    ).toBeVisible()
    await expect(page.getByText('checks passing').first()).toBeVisible()
    await expect(page.getByText('Pull request #81 is not in this fixture snapshot')).toHaveCount(0)
    await expect(page.getByText('No pull request selected')).toHaveCount(0)
    // Opening a row is navigation, not checkout: nothing is switched or staged.
    const calls = await getDoubleCalls(page)
    expect(calls.filter((entry) => entry.call === 'runAction')).toHaveLength(0)
  })

  test('a row from another registered repository opens that repository and its Review', async ({
    page,
  }) => {
    await expect(rows(page)).toHaveCount(2)
    await rows(page).nth(1).getByRole('button').click()
    const opened = (await getDoubleCalls(page)).filter((entry) => entry.call === 'openRepository')
    expect(opened.map((entry) => entry.args[0])).toContain(
      '/Users/ada/Code/design-system-specimens',
    )
    // The foreign repository's own facts, read after it was adopted: its pull
    // request #77 is selected in it rather than looked up in the workspace that
    // happened to be showing.
    await expect(
      page.getByText('#77 Charge every native-stack page to the refresh budget').first(),
    ).toBeVisible()
    await expect(page.getByText('Pull request #77 is not in this fixture snapshot')).toHaveCount(0)
    await expect(page.getByText('No pull request selected')).toHaveCount(0)
    // The origin the workspace reports is the repository the row named, so the
    // remote this window would use is that one and not a look-alike.
    await expect(
      page.getByText('git@github.com:howarewoo/design-system-specimens.git'),
    ).toBeVisible()
  })

  test('the search chord reaches the queue, with a repository open and without one', async ({
    page,
  }) => {
    // `/` is the chord the window advertises for search, pressed here from a
    // non-editable target. The queue is what it searches, so it lands on the
    // queue's own field and the typed text narrows the rows on screen.
    await page.getByRole('heading', { level: 1, name: 'PR Inbox' }).click()
    await page.keyboard.press('/')
    const search = page.getByRole('searchbox', { name: 'Search the queue' })
    await expect(search).toBeFocused()
    await search.pressSequentially('specimens')
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('Charge every native-stack page')
    // The queue carries no repository toolbar search of its own, so there was no
    // second field for the chord to have reached.
    await openGallery(page, { scenario: 'pr-inbox-no-repository' })
    await switchDestination(page, 'prInbox')
    await page.getByRole('heading', { level: 1, name: 'PR Inbox' }).click()
    await page.keyboard.press('/')
    const queueSearch = page.getByRole('searchbox', { name: 'Search the queue' })
    await expect(queueSearch).toBeFocused()
    await queueSearch.pressSequentially('Add a GitHub-derived')
    await expect(rows(page)).toHaveCount(1)
  })

  test('search is keyboard-entered, and an empty result is stated against the queue', async ({
    page,
  }) => {
    const search = page.getByRole('searchbox', { name: 'Search the queue' })
    await search.click()
    await search.pressSequentially('inbox')
    await expect(rows(page)).toHaveCount(2)

    await search.pressSequentially(' zzz')
    await expect(page.getByRole('heading', { name: 'No matching pull requests' })).toBeVisible()
    // The count is the queue rather than this group: the search hid work that exists.
    await expect(
      page.getByText('6 pull requests in the queue; this group, search, and repository show none'),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(rows(page)).toHaveCount(2)
  })

  test('a saved filter is stored, listed, and removed through the queue', async ({ page }) => {
    const name = page.getByRole('textbox', { name: 'Save this filter' })
    const save = page.getByRole('button', { name: 'Save', exact: true })
    await expect(save).toBeDisabled()
    await name.click()
    await name.pressSequentially('Awaiting Ada')
    await expect(save).toBeEnabled()
    await save.click()

    const chip = groupRail(page).getByRole('button', { name: 'Awaiting Ada', exact: true })
    await expect(chip).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Remove saved filter Awaiting Ada' }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Remove saved filter Awaiting Ada' }).click()
    await expect(chip).toHaveCount(0)
  })

  test('the saved-filter controls stay locked while the stored list is still being read', async ({
    page,
  }) => {
    const name = page.getByRole('textbox', { name: 'Save this filter' })
    const save = page.getByRole('button', { name: 'Save', exact: true })
    await name.click()
    await name.pressSequentially('Awaiting Ada')
    await save.click()
    await expect(
      groupRail(page).getByRole('button', { name: 'Awaiting Ada', exact: true }),
    ).toBeVisible()

    // Every one of these mutations replaces the whole stored list, so a write
    // started before that list has been read would save over filters nobody has
    // seen yet. The read is issued at mount, so the only way to hold it is to
    // remount the App through the gallery index — the same document, so the
    // window, its destination and its state are still the ones under test.
    await switchGalleryRoute(page, 'index')
    await holdDoubleCall(page, 'pullRequestInboxFilters')
    await switchGalleryRoute(page, 'app')
    await switchDestination(page, 'prInbox')

    // Nothing can be written or edited while the stored list is unknown: the
    // name field and Save are refused outright, and the filter that is already
    // stored is not even offered for removal, because the window cannot say it
    // is there.
    await expect(name).toBeDisabled()
    await expect(save).toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Remove saved filter Awaiting Ada' }),
    ).toHaveCount(0)
    await expect(
      groupRail(page).getByRole('button', { name: 'Awaiting Ada', exact: true }),
    ).toHaveCount(0)

    // Enter is the keyboard's way into the same save, and it is guarded the same
    // way: no write is dispatched at all, so the count is what the one real save
    // above already made. What matters is not that nothing appeared on screen
    // but that nothing was sent — a write against a list this window has not
    // read would replace every stored filter with the ones it can currently
    // see, which is none of them.
    await name.press('Enter')
    expect(
      (await getDoubleCalls(page)).filter((entry) => entry.call === 'savePullRequestInboxFilters')
        .length,
    ).toBe(1)

    // The stored list arrives, and every control it governs opens with it.
    expect(await releaseDoubleCalls(page, 'pullRequestInboxFilters')).toBe(1)
    await settle(page)
    const chip = groupRail(page).getByRole('button', { name: 'Awaiting Ada', exact: true })
    await expect(chip).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Remove saved filter Awaiting Ada' }),
    ).toBeEnabled()
    await name.click()
    await name.pressSequentially('Second')
    await expect(save).toBeEnabled()
  })

  test('a replacement the store refuses keeps the filter it was going to replace', async ({
    page,
  }) => {
    const name = page.getByRole('textbox', { name: 'Save this filter' })
    const save = page.getByRole('button', { name: 'Save', exact: true })
    await name.click()
    await name.pressSequentially('Awaiting Ada')
    await save.click()
    const chip = groupRail(page).getByRole('button', { name: 'Awaiting Ada', exact: true })
    await expect(chip).toBeVisible()

    // Saving under the same name replaces the stored filter, and the search
    // travels with it. A search past what the store will keep makes that one
    // draft unusable, which the store answers by refusing the whole write —
    // dropping just that draft would delete the filter the window removed from
    // the list it submitted, and say nothing while doing it.
    const search = page.getByRole('searchbox', { name: 'Search the queue' })
    await search.click()
    await search.pressSequentially('a'.repeat(201))
    // The name field emptied itself when the first filter was stored, so typing
    // the name again really is the same name. This write has to replace the
    // filter that is already there; a draft under some other name would leave
    // the stored one untouched and prove nothing about losing it.
    await name.click()
    await name.pressSequentially('Awaiting Ada')
    await save.click()

    await expect(page.getByRole('alert')).toBeVisible()
    // One entry under that name, still listed and still removable: the refused
    // write neither dropped it nor added a second one beside it.
    await expect(chip).toHaveCount(1)
    await expect(
      page.getByRole('button', { name: 'Remove saved filter Awaiting Ada' }),
    ).toBeVisible()
    // What that entry carries is what it was saved with, not what the refused
    // draft offered. Clicking it applies what is on file, so a filter the failed
    // write had overwritten would come back narrowed to the overlong search
    // instead of answering to its own name alone.
    await chip.click()
    await expect(search).toHaveValue('')
    await expect(rows(page)).toHaveCount(2)
  })

  test('the row list is one composite widget whose arrows stop at the ends', async ({ page }) => {
    const first = rows(page).nth(0).getByRole('button')
    const second = rows(page).nth(1).getByRole('button')
    await first.focus()
    await expect(first).toHaveAttribute('tabindex', '0')
    await expect(second).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('ArrowDown')
    await expect(second).toBeFocused()
    // The last mounted row is the end of the list, not a place to wrap to.
    await page.keyboard.press('ArrowDown')
    await expect(second).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(first).toBeFocused()
  })

  test('a refused refresh keeps the confirmed rows behind the reason', async ({ page }) => {
    await failNextDoubleCall(page, 'pullRequestInbox', 'the queue read was refused')
    await page.getByRole('button', { name: 'Refresh the PR Inbox' }).click()
    await expect(page.getByRole('alert')).toContainText('the queue read was refused')
    // A read that could not answer is never an empty one: the rows stay.
    await expect(rows(page)).toHaveCount(2)
  })

  test('a retired read shows an empty queue and blames neither the account nor the network', async ({
    page,
  }) => {
    // The same destination, with the answer a read that was ended produces: the
    // report holds no rows at all, so anything on screen now would be the
    // destination inventing them.
    await openGallery(page, { scenario: 'pr-inbox-retired' })
    await switchDestination(page, 'prInbox')
    await expect(rows(page)).toHaveCount(0)
    // And the reason says what happened to the read, and nothing about the
    // person: not signed out, not offline, not never read.
    await expect(page.getByRole('heading', { name: 'Queue read retired' })).toBeVisible()
    // The reason is shown beside the heading and announced, so a screen reader
    // hears why the queue is empty rather than only finding it.
    await expect(
      page.getByRole('paragraph').filter({ hasText: 'ended before it confirmed' }),
    ).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Queue read retired' })).toBeVisible()
    await expect(page.getByText('Sign in')).toHaveCount(0)
    await expect(page.getByText('unreachable')).toHaveCount(0)
    await expect(page.getByText('never been read')).toHaveCount(0)
    // A read that ended is neither an error banner nor an empty queue: there is
    // nothing to recover from, and "nothing in here" would be a claim about
    // GitHub's data that this read never obtained.
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /^Nothing in/u })).toHaveCount(0)
    // The queue is readable again, which is the only thing that resolves it.
    await expect(page.getByRole('button', { name: 'Refresh the PR Inbox' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  test('leaving the destination abandons the refresh it started, and the late answer paints nothing', async ({
    page,
  }) => {
    // The refresh is started here, on a destination that is already showing its
    // rows. Selecting the destination again would start nothing, so this is the
    // read the person began, and it is left running.
    const refresh = page.getByRole('button', { name: 'Refresh the PR Inbox' })
    await holdDoubleCall(page, 'pullRequestInbox')
    // The queued failure belongs to whichever read settles first, which is the
    // one this test abandons. Nothing else fails.
    await failNextDoubleCall(page, 'pullRequestInbox', 'the abandoned read failed')
    await refresh.click()
    // Pending, and visibly so: the control that would begin another read is
    // unavailable while this one is still out.
    await expect(refresh).toBeDisabled()
    await switchDestination(page, 'branches')
    // Coming back starts a read of its own while the abandoned one has still
    // answered nothing, and the hold has not been lifted, so both are pending
    // at once. The failure can therefore only land on a destination that is
    // already showing the read that replaced it — which is the only place a
    // read that is not gated puts its error on screen. Releasing the abandoned
    // read earlier would let the destination's next read clear that error
    // first, and the gate would never be exercised at all.
    await switchDestination(page, 'prInbox')
    await expect(refresh).toBeDisabled()
    const started = (await getDoubleCalls(page)).filter(
      (entry) => entry.call === 'pullRequestInbox',
    )
    // The gallery's own first read, the refresh that is abandoned, and the read
    // that replaced it. Fewer would mean the destination never read again, and
    // the assertions below would pass without anything arriving late.
    expect(started.length).toBeGreaterThanOrEqual(3)
    expect(await releaseDoubleCalls(page, 'pullRequestInbox')).toBe(2)
    await settle(page)
    // The abandoned read answered with a failure nobody is waiting for, and
    // the read that replaced it answered with its rows.
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(2)
    // The control recovered, so the destination is usable rather than stuck on
    // the read that was abandoned.
    await expect(refresh).toBeEnabled()
  })

  test('a read that loses its check and review fields says unknown, without a reload', async ({
    page,
  }) => {
    // The same window, the same rows, and a host that stops serving the fields
    // this read needs. Only the answers change underneath, which is the whole
    // point: a queue mounted on degraded facts from the start proves the labels
    // are right, not that the queue can move from one to the other in place.
    await expect(rows(page).filter({ hasText: 'Charge every native-stack page' })).toContainText(
      'checks failing',
    )
    await changeScenario(page, 'pr-inbox-partial')
    await page.getByRole('button', { name: 'Refresh the PR Inbox' }).click()
    await settle(page)

    // The host answered without the review and check fields, so the row says it
    // does not know them. "no checks" would be a claim the host never made, and a
    // row from a repository that did report everything keeps saying what it
    // reported.
    const degraded = rows(page).filter({ hasText: 'Charge every native-stack page' })
    await expect(degraded).toContainText('checks unknown')
    await expect(degraded).toContainText('review state unknown')
    await expect(degraded).not.toContainText('no checks')
    await expect(degraded).not.toContainText('no review decision')
    await expect(degraded.getByRole('button')).toHaveAttribute('aria-label', /review state unknown/)
    const reported = rows(page).filter({ hasText: 'Add a GitHub-derived PR Inbox' })
    await expect(reported).toContainText('checks passing')
    await expect(reported).not.toContainText('unknown')
  })

  test('the queue surface has no axe violations', async ({ page }) => {
    await assertNoAxeViolations(page, 'PR Inbox destination', { allRules: true })
  })
})

test.describe('PR Inbox states', () => {
  test('a confirmed read that holds nothing reads as empty, not unconfirmed', async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-empty' })
    await switchDestination(page, 'prInbox')
    await expect(page.getByRole('heading', { name: 'Nothing in Review requested' })).toBeVisible()
    await expect(page.getByText('The queue is unconfirmed')).toHaveCount(0)
  })

  test('a degraded repository is named and never counted as fully read', async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-partial' })
    await switchDestination(page, 'prInbox')
    await expect(page.getByRole('status')).toContainText('Some repositories could not be read')
    await expect(
      page.getByText(/design-system-specimens \(read without review or check metadata\)/u),
    ).toBeVisible()
    await expect(rows(page)).toHaveCount(2)
  })

  test('an unreachable GitHub keeps the confirmed rows behind the reason', async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-unavailable' })
    await switchDestination(page, 'prInbox')
    await expect(page.getByText('GitHub is unreachable')).toBeVisible()
    await expect(rows(page)).toHaveCount(2)
  })

  test('the queue stays operable at the 200% reflow', async ({ page }) => {
    await openGallery(page, {
      scenario: 'pr-inbox-queue',
      viewport: STANDARD_VIEWPORTS.zoom200,
    })
    await switchDestination(page, 'prInbox')
    await settle(page)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false)
    for (const control of [
      page.getByRole('searchbox', { name: 'Search the queue' }),
      page.getByRole('textbox', { name: 'Save this filter' }),
      page.getByRole('button', { name: 'Save', exact: true }),
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
    await switchDestination(page, 'prInbox')
    await expect(page.getByRole('status')).toHaveText('Reading the pull request queue from GitHub…')
    // Neither of the two answers that would be a claim GitHub never made.
    await expect(page.getByText('The queue is unconfirmed')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /^Nothing in/u })).toHaveCount(0)

    // A read that answered with a refusal has confirmed nothing either, so the
    // queue still owes GitHub an answer. It must not resolve into an empty
    // queue: "nothing in here" is a claim about GitHub's data, not about a read
    // that never got any.
    await releaseDoubleCalls(page, 'pullRequestInbox')
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /^Nothing in/u })).toHaveCount(0)
  })

  test('the rows on screen are the ones the read reported, and the read can be repeated', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'pr-inbox-queue' })
    await switchDestination(page, 'prInbox')
    await expect(rows(page)).toHaveCount(2)
    await expect(page.getByText('Reading the pull request queue from GitHub…')).toHaveCount(0)

    // The destination does not stay busy after its read answered: leaving and
    // coming back has to offer the same refresh, not a disabled control for a
    // read that finished long ago.
    await switchDestination(page, 'pullRequests')
    await switchDestination(page, 'prInbox')
    await expect(page.getByRole('button', { name: 'Refresh the PR Inbox' })).toBeEnabled()
  })
})

test.describe('PR Inbox to Review, in one window', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-queue' })
    await switchDestination(page, 'prInbox')
  })

  test('one walk through the queue reads both pull requests without touching Git', async ({
    page,
  }) => {
    // The first row, in the workspace that is already open.
    await rows(page).first().getByRole('button').click()
    await expect(
      page.getByText('#81 Add a GitHub-derived PR Inbox across registered repositories').first(),
    ).toBeVisible()
    await expect(page.getByText('checks passing').first()).toBeVisible()
    // Its files and its commits are read for that pull request, from that
    // pull request's own head rather than the branch that happens to be checked
    // out in this workspace.
    await expect(page.getByText('src/main/review.ts').first()).toBeVisible()

    // Back to the queue, and into the other registered repository.
    await switchDestination(page, 'prInbox')
    await rows(page).nth(1).getByRole('button').click()
    await expect(
      page.getByText('#77 Charge every native-stack page to the refresh budget').first(),
    ).toBeVisible()
    await expect(page.getByText('checks failing').first()).toBeVisible()
    await expect(page.getByText('src/main/review.ts').first()).toBeVisible()
    // The workspace on screen is that repository's, with its own canonical
    // origin: nothing here resolved the row against the repository that was
    // already open.
    await expect(
      page.getByText('git@github.com:howarewoo/design-system-specimens.git'),
    ).toBeVisible()

    const reads = (await getDoubleCalls(page)).filter(
      (entry) => entry.call === 'reviewFiles' || entry.call === 'reviewCommits',
    )
    expect(reads.filter((entry) => entry.args[0] === 81).length).toBeGreaterThan(0)
    expect(reads.filter((entry) => entry.args[0] === 77).length).toBeGreaterThan(0)
    // Reading a pull request is navigation. Two repositories were opened, two
    // Reviews were read, and not one Git action was dispatched: no branch was
    // checked out, staged, or pushed to make either row readable.
    expect((await getDoubleCalls(page)).filter((entry) => entry.call === 'runAction')).toHaveLength(
      0,
    )

    // And the queue is still there to refresh, in the same window, with the
    // same rows: walking away from it did not end it.
    await switchDestination(page, 'prInbox')
    await page.getByRole('button', { name: 'Refresh the PR Inbox' }).click()
    await settle(page)
    await expect(rows(page)).toHaveCount(2)
  })
})

test.describe('PR Inbox transitions', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, { scenario: 'pr-inbox-queue' })
    await switchDestination(page, 'prInbox')
    await expect(rows(page)).toHaveCount(2)
  })

  test('a read that ends empties the confirmed rows on the destination showing them', async ({
    page,
  }) => {
    // The person narrows the queue first, so a remount would be visible: a
    // destination that came back from scratch would hold an empty search field.
    const search = page.getByRole('searchbox', { name: 'Search the queue' })
    await search.click()
    await search.pressSequentially('native-stack')
    await expect(rows(page)).toHaveCount(1)

    // This refresh is the read that ends before it confirms anything, which is
    // the answer the main process returns for a read whose identity was
    // replaced while it was in flight.
    await answerNextDoubleCall(page, 'pullRequestInbox', scenarios['pr-inbox-retired']?.inbox)
    await page.getByRole('button', { name: 'Refresh the PR Inbox' }).click()
    await settle(page)

    // Nothing an earlier read confirmed is still listed, the reason is the read
    // and not the account, and it is the same destination underneath: the queue
    // the person narrowed is the queue that emptied.
    await expect(rows(page)).toHaveCount(0)
    await expect(search).toHaveValue('native-stack')
    await expect(page.getByRole('heading', { name: 'Queue read retired' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a read that ended after a newer one answered cannot take its rows with it', async ({
    page,
  }) => {
    await holdDoubleCall(page, 'pullRequestInbox')
    // Refresh starts read A, which remains held.
    await page.getByRole('button', { name: 'Refresh the PR Inbox' }).click()
    // Leaving and returning starts read B, which is also held.
    await switchDestination(page, 'branches')
    await switchDestination(page, 'prInbox')

    // Independently complete B (newest) first and assert its confirmed rows
    // are visible and distinguishable before the retired answer is staged or lands.
    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'newest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(2)
    await expect(page.getByRole('heading', { name: 'Queue read retired' })).toHaveCount(0)

    // Stage A's retired answer now, immediately before releasing A (oldest).
    await answerNextDoubleCall(page, 'pullRequestInbox', scenarios['pr-inbox-retired']?.inbox)

    // Then complete A's retired answer (oldest) and verify that B's confirmed rows
    // remain on screen and are not wiped out by the superseded read.
    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'oldest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(2)
    await expect(page.getByRole('heading', { name: 'Queue read retired' })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a superseded read failing while a newer read is pending paints no error and leaves the queue pending', async ({
    page,
  }) => {
    const refresh = page.getByRole('button', { name: 'Refresh the PR Inbox' })
    await holdDoubleCall(page, 'pullRequestInbox')
    // Read A will fail with a typed error.
    await failNextDoubleCall(page, 'pullRequestInbox', 'superseded read network failure')
    await refresh.click()
    // Leaving and returning starts read B, which remains held and pending.
    await switchDestination(page, 'branches')
    await switchDestination(page, 'prInbox')

    // Release only A's failure (oldest) while B remains held.
    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'oldest')).toBe(1)
    await settle(page)

    // A's failure must NOT paint an alert, because it was superseded; B remains
    // pending, so existing rows stay on screen without an alert and the Refresh
    // affordance remains disabled with its spinner active.
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(2)
    await expect(refresh).toBeDisabled()
    await expect(refresh.locator('.animate-spin')).toBeVisible()

    // Finally release B and observe it confirms rows normally and clears busy state.
    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'oldest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(2)
    await expect(refresh).toBeEnabled()
    await expect(refresh.locator('.animate-spin')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a read that names no account stops listing viewer-relative work, and says why', async ({
    page,
  }) => {
    await expect(groupRail(page).getByRole('button', { name: 'My PRs — waiting 1' })).toBeVisible()

    // The same read, the same rows, and this time the host named no account.
    // Nothing remounts: the destination and its reads carry over, and the next
    // read answers from the new world.
    await changeScenario(page, 'pr-inbox-membership-unknown')
    await page.getByRole('button', { name: 'Refresh the PR Inbox' }).click()
    await settle(page)

    // Whose work these are is undecided rather than false, so the three groups
    // that depend on it are left empty instead of being decided against
    // somebody. The rows that do not depend on it are still listed.
    await expect(groupRail(page).getByRole('button', { name: 'My PRs — waiting 0' })).toBeVisible()
    await expect(groupRail(page).getByRole('button', { name: 'Review requested 0' })).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
    await groupRail(page).getByRole('button', { name: 'Drafts 1' }).click()
    await expect(rows(page).first()).toContainText('Sketch the Inbox group rail')

    // And the reason is stated where the other unreadable repositories are
    // named, in the region that announces it, because a queue that quietly
    // stops listing work is indistinguishable from a queue that has none.
    await expect(
      page.getByText(/howarewoo\/git-stacks \(read without knowing whose queue this is\)/u),
    ).toBeVisible()
    await expect(page.getByRole('status')).toContainText('read without knowing whose queue this is')
  })

  test('a world with no repository open does not answer with the one that was', async ({
    page,
  }) => {
    // The foreign row is opened first, so this window is showing a repository
    // the next world will not have.
    await rows(page).nth(1).getByRole('button').click()
    await expect(
      page.getByText('git@github.com:howarewoo/design-system-specimens.git'),
    ).toBeVisible()
    const before = (await getDoubleCalls(page)).filter((entry) => entry.call === 'refresh').length

    await changeScenario(page, 'shell-no-repository')
    await page.getByRole('button', { name: 'Refresh repository' }).click()
    await settle(page)

    // The window asked, and the read failed. Serving the repository of the
    // world that was would keep a workspace on screen that nothing holds any
    // more, and would report it as a read that just succeeded.
    expect((await getDoubleCalls(page)).filter((entry) => entry.call === 'refresh').length).toBe(
      before + 1,
    )
    await expect(page.getByRole('alert')).toBeVisible()
  })
})

test.describe('PR Inbox identity', () => {
  test('naming another host retires this one’s rows, and the account that arrives late cannot bring them back', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'pr-inbox-host-switch' })
    await switchDestination(page, 'prInbox')

    // The person narrows the queue before anything changes, so a remount would
    // be visible: a destination that came back from scratch would hold an
    // empty search field.
    const search = page.getByRole('searchbox', { name: 'Search the queue' })
    await search.click()
    await search.pressSequentially('native-stack')
    await expect(rows(page)).toHaveCount(1)
    // The account read is still outstanding, and the window says so rather
    // than claiming an identity it has not been told about.
    const account = page.getByTitle('GitHub account')
    await expect(account).toHaveText('GitHub: signed out')

    // A refresh for github.com is asked for and admitted before any of this
    // happens; only its answer is held back. That is the case the fence is for:
    // a read that was really made, that really succeeded, and that carries real
    // rows — for a host that is about to stop being this window's host.
    const refresh = page.getByRole('button', { name: 'Refresh the PR Inbox' })
    await holdDoubleCall(page, 'pullRequestInbox')
    await refresh.click()
    // Still spinning: the read is outstanding, not answered and merely ignored.
    await expect(refresh).toBeDisabled()

    // Another host is named through the real Settings control: the palette's
    // Settings entry, then the GitHub section's own field and its own button.
    await search.blur()
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    if (!(await palette.isVisible())) await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()
    // Two palette entries start with "Settings", so the entry that opens the
    // dialog is named by the detail that follows its label rather than by the
    // label alone.
    await palette.getByRole('option', { name: /^Settings… \(/u }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    await dialog
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'GitHub' })
      .click()
    await dialog.getByRole('textbox', { name: 'Host' }).fill('ghe.example.com')
    await dialog.getByRole('button', { name: 'Use this host' }).click()
    await expect(dialog.getByText('GitHub host set to ghe.example.com.')).toBeVisible()
    await page.keyboard.press('Escape')
    await settle(page)

    // The host is half the identity, so the rows read for the previous host go
    // on the change alone — before any account has said anything about it, and
    // without waiting for a read that would name nothing.
    await expect(rows(page)).toHaveCount(0)
    await expect(search).toHaveValue('native-stack')
    await expect(page.getByRole('alert')).toHaveCount(0)

    // The refresh that was admitted for github.com answers now, late, and it
    // succeeded. Publishing it would put a queue on screen that answers to a
    // host this window is no longer reading for, so the answer is taken and
    // the rows stay gone.
    expect(await releaseDoubleCalls(page, 'pullRequestInbox', 'oldest')).toBe(1)
    await settle(page)
    await expect(rows(page)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)

    // github.com's account answers too, late. Adopting it must not resurrect
    // the queue that host read before it was replaced: the window is showing a
    // queue read by nobody, which is the state it belongs in until it reads
    // again.
    expect(await releaseDoubleCalls(page, 'githubAccountStatus')).toBe(1)
    await settle(page)
    await expect(account).toHaveText('GitHub: signed in')
    await expect(rows(page)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)

    // None of that wedged the destination: a read asked for now answers. Which
    // rows it answers with is this double's business — it serves one queue
    // whatever host is named — so this says the window still reads, not whose
    // pull requests it found.
    await refresh.click()
    await settle(page)
    await expect(rows(page)).toHaveCount(1)
  })
})
