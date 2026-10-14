import { expect, test } from '@playwright/test'
import {
  getDispatchedActions,
  failNextDoubleCall,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { scenarios } from './fixtures/scenarios'
import { restackPreview } from '../fixtures/workflow-scenarios'
import {
  openManagePullRequestDialog,
  openRestackDialog,
  selectBranchInList,
} from './helpers/dialogs'

test.describe('Safety and mutation dispatch invariants', () => {
  test('cancelling a captured restack preview never mutates the registered directory', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openRestackDialog(page)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('a failed captured restack keeps its confirmation and error available', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openRestackDialog(page)
    await failNextDoubleCall(page, 'runAction', 'Captured restack was refused')
    await dialog.getByRole('button', { name: 'Restack stack', exact: true }).click()
    await settle(page)
    await expect(dialog).toBeVisible()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Captured restack was refused' }),
    ).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Restack stack', exact: true })).toBeEnabled()
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'executeStack',
        token: restackPreview.token,
        allowForce: false,
        mergeMethod: 'squash',
      },
    ])
  })

  test('a captured restack sends its displayed preview once while submission is held', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openRestackDialog(page)
    await holdDoubleCall(page, 'runAction')
    const submit = dialog.getByRole('button', { name: 'Restack stack', exact: true })
    await submit.click()
    await expect(submit).toBeDisabled()
    await dialog.locator('form').dispatchEvent('submit')
    await releaseDoubleCalls(page, 'runAction')
    await settle(page)
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'executeStack',
        token: restackPreview.token,
        allowForce: false,
        mergeMethod: 'squash',
      },
    ])
  })

  test.describe('Busy state prevents duplicate dispatch', () => {
    for (const operation of ['link', 'unlink'] as const) {
      test(`closing issue ${operation} keeps its confirmation name during the captured write`, async ({
        page,
      }) => {
        await openGallery(page, { scenario: 'pull-requests-issue-links' })
        if (operation === 'link') {
          // A fresh provider observation makes closing links eligible for this PR;
          // its local stack parent is deliberately not changed to match the base.
          await page.evaluate((repository) => {
            window.fixture.pushSnapshot({
              ...repository,
              pullRequests: repository.pullRequests.map((pr) =>
                pr.number === 41 ? { ...pr, base: repository.defaultBranch } : pr,
              ),
              branches: repository.branches.map((branch) =>
                branch.pr?.number === 41
                  ? { ...branch, pr: { ...branch.pr, base: repository.defaultBranch } }
                  : branch,
              ),
            })
          }, scenarios['pull-requests-issue-links'].snapshot!)
        }
        const dialog = await openManagePullRequestDialog(page)
        if (operation === 'unlink') {
          await dialog
            .getByRole('button', {
              name: 'Remove link to issue #42 from this pull request',
              exact: true,
            })
            .click()
        } else {
          await dialog.getByRole('textbox', { name: 'Search and link issues' }).fill('51')
          await dialog.getByRole('button', { name: 'Search', exact: true }).click()
          await dialog.getByRole('button', { name: 'Close when merged', exact: true }).click()
        }
        const name = operation === 'unlink' ? 'Confirm removal' : 'Confirm close when merged'
        const confirm = dialog.getByRole('button', { name, exact: true })
        await expect(confirm).toBeEnabled()
        await holdDoubleCall(page, 'runAction')
        await confirm.click()
        await expect(confirm).toHaveAccessibleName(name)
        await expect(confirm).toHaveAttribute('aria-busy', 'true')
        await expect(confirm).toBeDisabled()
        await expect(confirm.locator('[data-slot="button-spinner"]')).toHaveCount(1)
        await expect(confirm.locator('.lucide-loader-circle')).toHaveCount(1)
        await releaseDoubleCalls(page, 'runAction')
        await settle(page)
        expect(
          (await getDispatchedActions(page)).filter(
            (action) => action.type === (operation === 'unlink' ? 'unlinkIssue' : 'linkIssue'),
          ),
        ).toHaveLength(1)
      })
    }
  })

  test.describe('Selection is not checkout or staging', () => {
    test('clicking branch row changes inspector selection without dispatching switch or checkout', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })

      await selectBranchInList(page, 'main')

      const inspector = page.getByRole('complementary', { name: 'Selected branch details' })
      await expect(inspector.getByText('refs/heads/main', { exact: true })).toBeVisible()

      // Dispatched actions must be completely empty: selection is read-only
      const actions = await getDispatchedActions(page)
      expect(actions).toEqual([])
    })

    test('opening a pull request from its row dispatches no checkout or mutation', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'pull-requests-lifecycle' })
      await switchDestination(page, 'pullRequests')

      await page.getByRole('button', { name: /#42 Migrate changes/ }).click()
      await expect(page.locator('.review-headline')).toContainText('#42 Migrate changes')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      const actions = await getDispatchedActions(page)
      expect(actions).toEqual([])
    })

    test('clicking commit row in history view selects commit without dispatching cherry-pick or revert', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      await selectBranchInList(page, 'main')
      await page.getByRole('button', { name: 'Inspect branch history', exact: true }).click()

      await page
        .getByRole('button', { name: /Migrate changes, diff, history, PR, and stash surfaces/ })
        .click()

      const committedDiff = page.getByRole('heading', { name: /^Committed diff / })
      await expect(committedDiff).toBeVisible()

      const actions = await getDispatchedActions(page)
      expect(actions).toEqual([])
    })
  })
})
