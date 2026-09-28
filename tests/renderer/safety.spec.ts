import { expect, test } from '@playwright/test'
import {
  getDispatchedActions,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
} from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import {
  openDeleteLocalBranchDialog,
  openForcePushDialog,
  openNewBranchDialog,
  openRestackDialog,
  openStashDialog,
  selectBranchInList,
} from './helpers/dialogs'

test.describe('Safety and mutation dispatch invariants', () => {
  test.describe('Cancellation produces no mutation', () => {
    test('cancelling "Delete local branch?" dialog dispatches no GitAction', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const dialog = await openDeleteLocalBranchDialog(page, 'feature/checkout-tests')

      const cancelBtn = dialog.getByRole('button', { name: 'Cancel', exact: true })
      await cancelBtn.click()
      await expect(dialog).not.toBeVisible()

      const actions = await getDispatchedActions(page)
      expect(actions).toEqual([])
    })

    test('Escape preserves a dirty stash form; Cancel closes without mutation', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'files-staged' })
      const dialog = await openStashDialog(page)

      const messageInput = dialog.getByRole('textbox', { name: 'Message (optional)', exact: true })
      await messageInput.fill('WIP not saved')

      // Pressing Escape on dirty form must retain dialog and display unsaved warning
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      await expect(messageInput).toHaveValue('WIP not saved')

      // Explicit Cancel closes the dialog without dispatch
      const cancelBtn = dialog.getByRole('button', { name: 'Cancel', exact: true })
      await cancelBtn.click()
      await expect(dialog).not.toBeVisible()

      const actions = await getDispatchedActions(page)
      expect(actions).toEqual([])
    })
  })

  test.describe('Busy state prevents duplicate dispatch', () => {
    test('holding runAction prevents duplicate toolbar action dispatch', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      // Hold runAction so the in-flight promise does not settle immediately.
      await holdDoubleCall(page, 'runAction')

      const fetchBtn = page.getByRole('button', { name: 'Fetch', exact: true })
      await fetchBtn.click()

      // The toolbar locks the whole action surface while an action is in flight.
      await expect(fetchBtn).toBeDisabled()

      await releaseDoubleCalls(page, 'runAction')
      await settle(page)

      const actions = await getDispatchedActions(page)
      expect(
        actions.filter((action) => action.type === 'fetch'),
        'Exactly one Fetch must reach the backend for one activation',
      ).toHaveLength(1)
    })

    test('holding runAction prevents duplicate dialog form submission', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const dialog = await openNewBranchDialog(page)

      const nameInput = dialog.getByRole('textbox', { name: 'Branch name', exact: true })
      await nameInput.fill('feature/single-flight')

      await holdDoubleCall(page, 'runAction')

      const submitBtn = dialog.getByRole('button', { name: 'Create branch', exact: true })
      await submitBtn.click()
      await expect(submitBtn).toBeDisabled()

      // Submit the form again while the first request is still in flight. The form's own
      // submit handler carries no busy check, so only the app's single-flight lock can stop it.
      await dialog.locator('form').dispatchEvent('submit')

      await releaseDoubleCalls(page, 'runAction')
      await settle(page)

      const actions = await getDispatchedActions(page)
      expect(
        actions.filter((action) => action.type === 'createBranch'),
        'Exactly one createBranch must reach the backend for two submit attempts',
      ).toHaveLength(1)
    })
  })

  test.describe('Typed confirmations gate destructive submission', () => {
    test('delete branch force requires typing exact target branch name', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const dialog = await openDeleteLocalBranchDialog(page, 'feature/checkout-tests')

      const forceCheckbox = dialog.getByLabel('Delete even if not merged')
      await forceCheckbox.check()

      const submitBtn = dialog.getByRole('button', { name: 'Delete branch', exact: true })
      const confirmInput = dialog.getByLabel('Type the branch name to confirm')
      await expect(confirmInput).toBeVisible()

      // Typing wrong branch name keeps submit disabled
      await confirmInput.fill('other-branch')
      await expect(submitBtn).toBeDisabled()

      // Typing exact branch name enables submit
      await confirmInput.fill('feature/checkout-tests')
      await expect(submitBtn).toBeEnabled()

      await submitBtn.click()
      await settle(page)

      const actions = await getDispatchedActions(page)
      expect(actions.filter((action) => action.type === 'deleteBranch')).toEqual([
        {
          type: 'deleteBranch',
          ref: 'refs/heads/feature/checkout-tests',
          force: true,
          expectedOid: '45ea707145ea707145ea707145ea707145ea7071',
        },
      ])
    })

    test('force push with lease requires typing exact target branch name', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const dialog = await openForcePushDialog(page)

      const submitBtn = dialog.getByRole('button', {
        name: 'Force push with lease',
        exact: true,
      })
      // The confirmation target is the branch the backend preview names, not a free-text label.
      const confirmInput = dialog.getByRole('textbox', {
        name: 'Type feature/checkout to confirm',
        exact: true,
      })

      await confirmInput.fill('wrong-target')
      await expect(submitBtn).toBeDisabled()

      await confirmInput.fill('feature/checkout')
      await expect(submitBtn).toBeEnabled()

      await submitBtn.click()
      await settle(page)

      // The dispatched lease is the preview the dialog displayed, unmodified.
      const actions = await getDispatchedActions(page)
      expect(actions.filter((action) => action.type === 'forcePush')).toEqual([
        {
          type: 'forcePush',
          preview: {
            branch: 'feature/checkout',
            remote: 'origin',
            remoteUrl: 'git@github.com:howarewoo/git-stacks-fixture.git',
            destination: 'refs/heads/feature/checkout',
            localOid: '2222222222222222222222222222222222222222',
            remoteOid: 'aaaa000000000000000000000000000000000000',
          },
        },
      ])
    })
  })

  test.describe('Selection is not checkout or staging', () => {
    test('clicking branch row changes inspector selection without dispatching switch or checkout', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })

      await selectBranchInList(page, 'main')

      // Details pane must display the selected branch details
      const inspector = page.getByRole('complementary', { name: 'Selected branch details' })
      await expect(
        inspector.getByRole('heading', { level: 2, name: 'main', exact: true }),
      ).toBeVisible()

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
      await expect(page.getByRole('dialog')).toBeVisible()

      const actions = await getDispatchedActions(page)
      expect(actions).toEqual([])
    })

    test('clicking commit row in history view selects commit without dispatching cherry-pick or revert', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      await switchDestination(page, 'history')

      await page
        .getByRole('button', { name: /Migrate changes, diff, history, PR, and stash surfaces/ })
        .click()

      const inspector = page.getByRole('region', { name: 'Selected commit' })
      await expect(inspector).toBeVisible()

      const actions = await getDispatchedActions(page)
      expect(actions).toEqual([])
    })
  })

  test.describe('Filtered bulk actions preserve scope', () => {
    test('"Stage shown" stages only the unstaged file that matches the search', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'files-long-content' })
      await switchDestination(page, 'changes')

      // Two unstaged files are present; the search narrows the list to one of them.
      await page
        .getByRole('textbox', { name: 'Search branches, files, and pull requests' })
        .fill('bulk-generated-surface')
      await settle(page)

      await expect(page.locator('.file-row')).toHaveCount(1)

      await page.getByRole('button', { name: 'Stage shown', exact: true }).click()
      await settle(page)

      const actions = await getDispatchedActions(page)
      expect(actions.filter((action) => action.type === 'stage')).toEqual([
        {
          type: 'stage',
          paths: ['src/renderer/src/components/bulk-generated-surface.tsx'],
        },
      ])
    })

    test('"Unstage shown" unstages only the staged file that matches the search', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'files-staged' })
      await switchDestination(page, 'changes')

      await page
        .getByRole('textbox', { name: 'Search branches, files, and pull requests' })
        .fill('data-views.tsx')
      await settle(page)

      await expect(page.locator('.file-row')).toHaveCount(1)

      await page.getByRole('button', { name: 'Unstage shown', exact: true }).click()
      await settle(page)

      const actions = await getDispatchedActions(page)
      expect(actions.filter((action) => action.type === 'unstage')).toEqual([
        {
          type: 'unstage',
          paths: ['src/renderer/src/components/data-views.tsx'],
        },
      ])
    })
  })

  test.describe('Unchanged preview, OID, and fingerprint dispatch', () => {
    test('conflict resolution dispatches the fingerprint the dialog displayed', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'files-conflicts' })
      await switchDestination(page, 'changes')

      // A conflicted file is listed in both columns; open it from the staged column.
      await page
        .getByRole('region', { name: 'Staged', exact: true })
        .getByRole('button', {
          name: 'Resolve src/renderer/src/components/conflicted.tsx',
          exact: true,
        })
        .click()

      const fileInspector = page.getByRole('region', {
        name: 'Inspect src/renderer/src/components/conflicted.tsx',
        exact: true,
      })
      await expect(fileInspector).toBeVisible()

      await fileInspector
        .getByRole('button', { name: 'Open conflict resolver', exact: true })
        .click()
      const dialog = page.getByRole('dialog', { name: 'Resolve conflict', exact: true })
      await expect(dialog).toBeVisible()
      await dialog
        .getByRole('button', { name: 'Accept Incoming side for every conflict', exact: true })
        .click()
      expect(await getDispatchedActions(page)).toEqual([])

      await dialog.getByRole('button', { name: 'Mark resolved and stage', exact: true }).click()
      await settle(page)

      const actions = await getDispatchedActions(page)
      expect(actions.filter((action) => action.type === 'resolveConflict')).toEqual([
        {
          type: 'resolveConflict',
          path: 'src/renderer/src/components/conflicted.tsx',
          fingerprint: 'fingerprint-conflict',
          resolution: { kind: 'content', content: 'export const value = 2\n' },
        },
      ])
    })

    test('stack execution dispatches the preview token unchanged', async ({ page }) => {
      await openGallery(page, { scenario: 'workflow-preview-ready' })
      const dialog = await openRestackDialog(page)

      const submitBtn = dialog.getByRole('button', { name: 'Restack stack', exact: true })
      await expect(submitBtn).toBeEnabled()
      await submitBtn.click()
      await settle(page)

      const actions = await getDispatchedActions(page)
      expect(actions.filter((action) => action.type === 'executeStack')).toEqual([
        {
          type: 'executeStack',
          token: 'preview-restack-1',
          allowForce: false,
          draft: true,
          titles: {
            'feature/checkout': 'Add checkout validation',
            'feature/checkout-tests': 'Cover checkout validation',
          },
          mergeMethod: 'squash',
        },
      ])
    })

    test('stash pop dispatches the OID displayed on the row, not the index', async ({ page }) => {
      await openGallery(page, { scenario: 'stash-index-shift' })
      await switchDestination(page, 'stashes')

      // The same stash OIDs sit at different indices in this scenario, so a ref-only
      // dispatch would be silently wrong. Take the OID the row actually shows.
      const stashItem = page.getByRole('listitem').filter({ hasText: 'stash@{1}' })
      await expect(stashItem).toBeVisible()
      expect(await stashItem.locator('code').innerText()).toBe('a1b2c3d4')

      await stashItem.getByRole('button', { name: 'Pop stash@{1}', exact: true }).click()
      await settle(page)

      const actions = await getDispatchedActions(page)
      expect(actions.filter((action) => action.type === 'stashPop')).toEqual([
        {
          type: 'stashPop',
          ref: 'stash@{1}',
          oid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
        },
      ])
    })

    test('committing staged changes preserves snapshot headOid and headRef', async ({ page }) => {
      await openGallery(page, { scenario: 'files-staged' })
      await switchDestination(page, 'changes')

      const messageInput = page.getByRole('textbox', { name: 'Commit message' })
      await messageInput.fill('feat: verify dispatch invariants')

      const commitBtn = page.getByRole('button', { name: 'Commit', exact: true })
      await commitBtn.click()
      await settle(page)

      // The commit carries the head the dialog was opened against, so a concurrent
      // checkout cannot make the commit land on the wrong tip.
      const actions = await getDispatchedActions(page)
      expect(actions.filter((action) => action.type === 'commit')).toEqual([
        {
          type: 'commit',
          message: 'feat: verify dispatch invariants',
          amend: false,
          expectedHead: 'a4f152d9a4f152d9a4f152d9a4f152d9a4f152d9',
          expectedHeadRef: 'refs/heads/feature/checkout',
        },
      ])
    })
  })
})
