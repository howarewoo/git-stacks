import { expect, test, type Page } from '@playwright/test'
import { LIST_PAGE_SIZE } from '../../src/shared/performance'
import { switchDestination } from './helpers/destinations'
import { openDeleteLocalBranchDialog } from './helpers/dialogs'
import {
  failNextDoubleCall,
  getDispatchedActions,
  getViewFilterInput,
  openGallery,
  settle,
} from './helpers/gallery'

async function openSelection(page: Page, count = 3) {
  await openGallery(page, { scenario: 'shell-connected' })
  const branches = await page.evaluate(async (size) => {
    const snapshot = await window.desktop.refresh()
    const template = snapshot.branches.find((branch) => !branch.current && !branch.remote)!
    const branches = Array.from({ length: size }, (_, index) => ({
      ...template,
      name: `cleanup/${String(index).padStart(3, '0')}`,
      ref: `refs/heads/cleanup/${String(index).padStart(3, '0')}`,
      oid: (index + 1).toString(16).padStart(40, '0'),
      parent: null,
      parentTip: null,
      parentSource: null,
      pr: null,
    }))
    window.fixture.pushSnapshot({
      ...snapshot,
      branches: [
        ...snapshot.branches.filter(
          (branch) => branch.current || branch.name === snapshot.defaultBranch,
        ),
        {
          ...template,
          name: 'origin/protected',
          ref: 'refs/remotes/origin/protected',
          remote: true,
        },
        { ...template, name: 'unknown-tip', ref: 'refs/heads/unknown-tip', oid: '' },
        ...branches,
      ],
    })
    return branches
  }, count)
  await settle(page)
  await switchDestination(page, 'branches')
  await page.getByRole('button', { name: 'Select branches', exact: true }).click()
  return branches
}

function selectBranch(page: Page, name: string) {
  return page.getByRole('checkbox', { name: `Select ${name}`, exact: true })
}

test.describe('Local branch deletion', () => {
  test('select all includes only eligible mounted rows and clear/done never mutate', async ({
    page,
  }) => {
    const branches = await openSelection(page, LIST_PAGE_SIZE * 3)
    for (const name of ['main', 'feature/checkout', 'origin/protected', 'unknown-tip']) {
      await getViewFilterInput(page).fill(name)
      await expect(selectBranch(page, name)).toBeDisabled()
    }
    await getViewFilterInput(page).fill('')
    const mountedNames = await page
      .getByRole('checkbox', { name: /^Select cleanup\// })
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('aria-label')!.slice('Select '.length)),
      )
    await expect(page.locator('.branch-row')).toHaveCount(LIST_PAGE_SIZE)
    await page.getByRole('checkbox', { name: 'Select all visible', exact: true }).check()
    for (const name of mountedNames) await expect(selectBranch(page, name)).toBeChecked()
    await expect(
      page.getByRole('button', { name: `Delete selected (${mountedNames.length})`, exact: true }),
    ).toBeEnabled()

    await page.getByRole('button', { name: /^Show \d+ more branches/ }).click()
    const nextName = branches.find((branch) => !mountedNames.includes(branch.name))!.name
    const newlyMounted = selectBranch(page, nextName)
    await expect(newlyMounted).not.toBeChecked()
    await newlyMounted.check()
    await getViewFilterInput(page).fill(nextName)
    await expect(newlyMounted).toBeChecked()
    await expect(
      page.getByRole('button', {
        name: `Delete selected (${mountedNames.length + 1})`,
        exact: true,
      }),
    ).toBeEnabled()
    await getViewFilterInput(page).fill('')
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Delete selected (0)', exact: true }),
    ).toBeDisabled()
    await page.getByRole('button', { name: 'Done selecting', exact: true }).click()
    await expect(selectBranch(page, branches[0].name)).toHaveCount(0)
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('confirmation captures selected refs and tips, cancels safely, and forces without typing', async ({
    page,
  }) => {
    const branches = await openSelection(page)
    await selectBranch(page, branches[0].name).check()
    await getViewFilterInput(page).fill(branches[1].name)
    await selectBranch(page, branches[1].name).check()
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete local branches?', exact: true })
    await expect(dialog).toBeVisible()
    for (const branch of branches.slice(0, 2)) {
      await expect(dialog.getByText(branch.ref, { exact: true })).toBeVisible()
      await expect(dialog.getByText(branch.oid, { exact: true })).toBeVisible()
    }
    await expect(dialog.getByText(branches[2].ref, { exact: true })).toHaveCount(0)
    expect(await getDispatchedActions(page)).toEqual([])
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect(await getDispatchedActions(page)).toEqual([])
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    await dialog.getByRole('checkbox', { name: 'Delete even if not merged', exact: true }).check()
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await expect(
      dialog.getByRole('button', { name: 'Delete 2 branches', exact: true }),
    ).toBeEnabled()

    // A watcher can move a tip after the confirmation opens; dispatch must retain
    // the captured target, so the backend can refuse rather than delete the new tip.
    await page.evaluate(async () => {
      const snapshot = await window.desktop.refresh()
      window.fixture.pushSnapshot({
        ...snapshot,
        branches: snapshot.branches.map((branch) => ({ ...branch, oid: 'f'.repeat(40) })),
      })
    })
    await dialog.getByRole('button', { name: 'Delete 2 branches', exact: true }).click()
    await settle(page)
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'deleteBranches',
        branches: branches
          .slice(0, 2)
          .map((branch) => ({ ref: branch.ref, expectedOid: branch.oid })),
        force: true,
      },
    ])
    await expect(
      page.getByRole('button', { name: 'Delete selected (0)', exact: true }),
    ).toBeDisabled()
  })

  test('merged-only failure stays in the confirmation with the same targets', async ({ page }) => {
    const branches = await openSelection(page)
    await selectBranch(page, branches[0].name).check()
    await selectBranch(page, branches[1].name).check()
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete local branches?', exact: true })
    await failNextDoubleCall(page, 'runAction', 'Branch is not merged; no branches were deleted')
    await dialog.getByRole('button', { name: 'Delete 2 branches', exact: true }).click()
    await settle(page)
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText('Branch is not merged; no branches were deleted', { exact: true }),
    ).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Delete 2 branches', exact: true }),
    ).toBeEnabled()
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'deleteBranches',
        branches: branches
          .slice(0, 2)
          .map((branch) => ({ ref: branch.ref, expectedOid: branch.oid })),
        force: false,
      },
    ])
  })

  test('refresh removes missing and newly protected selections without exiting selection mode', async ({
    page,
  }) => {
    const branches = await openSelection(page)
    await selectBranch(page, branches[0].name).check()
    await selectBranch(page, branches[1].name).check()
    await page.evaluate(
      async ([current, remaining]) => {
        const snapshot = await window.desktop.refresh()
        window.fixture.pushSnapshot({
          ...snapshot,
          currentBranch: current.name,
          branches: [
            ...snapshot.branches.map((branch) => ({ ...branch, current: false })),
            { ...current, current: true },
            remaining,
          ],
        })
      },
      [branches[0], branches[2]],
    )
    await settle(page)
    await expect(selectBranch(page, branches[0].name)).not.toBeChecked()
    await expect(selectBranch(page, branches[0].name)).toBeDisabled()
    await expect(selectBranch(page, branches[1].name)).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Delete selected (0)', exact: true }),
    ).toBeDisabled()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('a different repository clears selection rather than carrying deletion targets across it', async ({
    page,
  }) => {
    const branches = await openSelection(page)
    await selectBranch(page, branches[0].name).check()
    await page.evaluate(async () => {
      const snapshot = await window.desktop.refresh()
      window.fixture.answerNext('openRepository', {
        ...snapshot,
        path: `${snapshot.path}-another`,
        name: 'another-repository',
      })
    })
    await page.getByRole('button', { name: 'Open another repository', exact: true }).click()
    await settle(page)
    await page.getByRole('button', { name: 'Select branches', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Delete selected (0)', exact: true }),
    ).toBeDisabled()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('single force deletion retains the single-target contract without a name field', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const dialog = await openDeleteLocalBranchDialog(page, 'feature/checkout-tests')
    await dialog.getByRole('checkbox', { name: 'Delete even if not merged', exact: true }).check()
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    const submit = dialog.getByRole('button', { name: 'Delete branch', exact: true })
    await expect(submit).toBeEnabled()
    expect(await getDispatchedActions(page)).toEqual([])
    await submit.click()
    await settle(page)
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'deleteBranch',
        ref: 'refs/heads/feature/checkout-tests',
        force: true,
        expectedOid: '45ea707145ea707145ea707145ea707145ea7071',
      },
    ])
  })
})
