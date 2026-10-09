import { expect, test, type Page } from '@playwright/test'
import { LIST_PAGE_SIZE } from '../../src/shared/performance'
import { switchDestination } from './helpers/destinations'
import { openDeleteLocalBranchDialog, selectBranchInList } from './helpers/dialogs'
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
    for (const name of ['main', 'feature/checkout', 'unknown-tip']) {
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

  test('child warning resolves captured parent refs and excludes remote or unrelated children', async ({
    page,
  }) => {
    const parents = await openSelection(page)
    await page.evaluate(async (parents) => {
      const snapshot = await window.desktop.refresh()
      const remoteParent = {
        ...parents[0],
        name: `origin/${parents[0].name}`,
        ref: `refs/remotes/origin/${parents[0].name}`,
        remote: true,
      }
      const children = [
        { name: 'short-parent', parent: parents[0].name, remote: false },
        { name: 'qualified-parent', parent: remoteParent.name, remote: false },
        { name: 'other-selected-parent', parent: parents[1].name, remote: false },
        { name: 'unselected-parent', parent: parents[2].name, remote: false },
        { name: 'missing-parent', parent: 'unavailable-parent', remote: false },
        { name: 'remote-child', parent: parents[0].name, remote: true },
      ]
      window.fixture.pushSnapshot({
        ...snapshot,
        branches: [
          ...snapshot.branches.map((branch) =>
            branch.ref === parents[0].ref
              ? { ...branch, upstream: remoteParent.name, upstreamRef: remoteParent.ref }
              : branch,
          ),
          remoteParent,
          ...children.map(({ name, parent, remote }) => ({
            ...parents[0],
            name: remote ? `origin/${name}` : name,
            ref: remote ? `refs/remotes/origin/${name}` : `refs/heads/${name}`,
            remote,
            parent,
          })),
        ],
      })
    }, parents)
    await settle(page)
    await selectBranch(page, parents[0].name).check()
    await selectBranch(page, parents[1].name).check()
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete local branches?', exact: true })
    await expect(dialog.locator('.workflow-note')).toContainText(/\b3 local child branches\b/)
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
      async ([current, missing, remaining]) => {
        const snapshot = await window.desktop.refresh()
        window.fixture.pushSnapshot({
          ...snapshot,
          currentBranch: current.name,
          branches: snapshot.branches
            .filter((branch) => branch.ref !== missing.ref)
            .map((branch) =>
              branch.ref === current.ref
                ? { ...current, current: true }
                : branch.ref === remaining.ref
                  ? remaining
                  : { ...branch, current: false },
            ),
        })
      },
      [branches[0], branches[1], branches[2]],
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

async function openRemoteBranches(page: Page) {
  await openGallery(page, { scenario: 'shell-connected' })
  const branches = await page.evaluate(async () => {
    const snapshot = await window.desktop.refresh()
    const template = snapshot.branches.find((branch) => !branch.current && !branch.remote)!
    const remote = (name: string, oid: string) => ({
      ...template,
      name: `origin/${name}`,
      ref: `refs/remotes/origin/${name}`,
      oid,
      current: false,
      remote: true,
      parent: null,
      parentTip: null,
      parentSource: null,
      pr: null,
      upstream: null,
      upstreamRef: null,
    })
    const branches = [remote('cleanup-one', '1'.repeat(40)), remote('cleanup-two', '2'.repeat(40))]
    window.fixture.pushSnapshot({
      ...snapshot,
      branches: [
        ...snapshot.branches.filter((branch) => !branch.remote),
        remote('main', '3'.repeat(40)),
        remote('HEAD', '3'.repeat(40)),
        remote('unknown-tip', ''),
        ...branches,
      ],
    })
    return branches
  })
  await settle(page)
  await switchDestination(page, 'branches')
  return branches
}

async function selectRemoteFilter(page: Page) {
  await page
    .getByRole('group', { name: 'Branch filters' })
    .getByRole('button', { name: 'Remote', exact: true })
    .click()
}

test.describe('Remote branch deletion', () => {
  test('remote-only rows in All select directly and keep remote scope across All/Remote filters', async ({
    page,
  }) => {
    const branches = await openRemoteBranches(page)
    await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.getByRole('button', { name: 'Select branches', exact: true }).click()
    await selectBranch(page, branches[0].name).check()
    await expect(selectBranch(page, 'feature/checkout-tests')).toBeDisabled()
    await page.getByRole('checkbox', { name: 'Select all visible', exact: true }).check()
    for (const branch of branches) await expect(selectBranch(page, branch.name)).toBeChecked()
    await selectRemoteFilter(page)
    await page.getByRole('button', { name: 'All', exact: true }).click()
    for (const branch of branches) await expect(selectBranch(page, branch.name)).toBeChecked()
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete remote branches?', exact: true })
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Delete 2 remote branches', exact: true }).click()
    await settle(page)
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'deleteRemoteBranches',
        branches: branches.map((branch) => ({ ref: branch.ref, expectedOid: branch.oid })),
      },
    ])
  })

  test('select all in a remote-only All search chooses remote deletion without changing filters', async ({
    page,
  }) => {
    const branches = await openRemoteBranches(page)
    await getViewFilterInput(page).fill('origin/cleanup')
    await page.getByRole('button', { name: 'Select branches', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Select all visible', exact: true }).check()
    for (const branch of branches) await expect(selectBranch(page, branch.name)).toBeChecked()
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete remote branches?', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await getViewFilterInput(page).fill('')
    await expect(selectBranch(page, branches[0].name)).toBeEnabled()
    await expect(selectBranch(page, 'feature/checkout-tests')).toBeEnabled()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('remote scope selects only eligible rows and clears local selections', async ({ page }) => {
    const branches = await openRemoteBranches(page)
    await page.getByRole('button', { name: 'Select branches', exact: true }).click()
    await selectBranch(page, 'feature/checkout-tests').check()
    await selectRemoteFilter(page)
    await expect(
      page.getByRole('button', { name: 'Delete selected (0)', exact: true }),
    ).toBeDisabled()
    for (const name of ['origin/main', 'origin/HEAD', 'origin/unknown-tip']) {
      await expect(selectBranch(page, name)).toBeDisabled()
    }
    await page.getByRole('checkbox', { name: 'Select all visible', exact: true }).check()
    for (const branch of branches) await expect(selectBranch(page, branch.name)).toBeChecked()
    await expect(
      page.getByRole('button', { name: 'Delete selected (2)', exact: true }),
    ).toBeEnabled()
    await page
      .getByRole('group', { name: 'Branch filters' })
      .getByRole('button', { name: 'Local', exact: true })
      .click()
    await expect(selectBranch(page, 'feature/checkout-tests')).not.toBeChecked()
    expect(await getDispatchedActions(page)).toEqual([])
  })

  test('batch confirmation captures tips, cancels safely and submits without typed consent', async ({
    page,
  }) => {
    const branches = await openRemoteBranches(page)
    await selectRemoteFilter(page)
    await page.getByRole('button', { name: 'Select branches', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Select all visible', exact: true }).check()
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete remote branches?', exact: true })
    for (const branch of branches) {
      await expect(dialog.getByText(branch.ref, { exact: true })).toBeVisible()
      await expect(dialog.getByText(branch.oid, { exact: true })).toBeVisible()
    }
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await expect(
      dialog.getByRole('checkbox', { name: 'Delete even if not merged', exact: true }),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await getDispatchedActions(page)).toEqual([])
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    await page.evaluate(async () => {
      const snapshot = await window.desktop.refresh()
      window.fixture.pushSnapshot({
        ...snapshot,
        branches: snapshot.branches.map((branch) => ({ ...branch, oid: 'f'.repeat(40) })),
      })
    })
    await dialog.getByRole('button', { name: 'Delete 2 remote branches', exact: true }).click()
    await settle(page)
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'deleteRemoteBranches',
        branches: branches.map((branch) => ({ ref: branch.ref, expectedOid: branch.oid })),
      },
    ])
  })

  test('remote deletion failure stays inline with the captured targets', async ({ page }) => {
    const branches = await openRemoteBranches(page)
    await selectRemoteFilter(page)
    await page.getByRole('button', { name: 'Select branches', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Select all visible', exact: true }).check()
    await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete remote branches?', exact: true })
    await failNextDoubleCall(page, 'runAction', 'Remote tip changed; no branches were deleted')
    await dialog.getByRole('button', { name: 'Delete 2 remote branches', exact: true }).click()
    await settle(page)
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText('Remote tip changed; no branches were deleted', { exact: true }),
    ).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Delete 2 remote branches', exact: true }),
    ).toBeEnabled()
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'deleteRemoteBranches',
        branches: branches.map((branch) => ({ ref: branch.ref, expectedOid: branch.oid })),
      },
    ])
  })

  test('inspector opens the shared single remote confirmation without a name field', async ({
    page,
  }) => {
    const [branch] = await openRemoteBranches(page)
    await selectRemoteFilter(page)
    await selectBranchInList(page, branch.name)
    await page
      .locator('.details-pane')
      .getByRole('button', { name: 'Delete remote branch…', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Delete remote branch?', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await expect(
      dialog.getByRole('checkbox', { name: 'Delete even if not merged', exact: true }),
    ).toHaveCount(0)
    expect(await getDispatchedActions(page)).toEqual([])
    await dialog.getByRole('button', { name: 'Delete remote branch', exact: true }).click()
    await settle(page)
    expect(await getDispatchedActions(page)).toEqual([
      {
        type: 'deleteRemoteBranch',
        ref: branch.ref,
        expectedOid: branch.oid,
      },
    ])
  })
  test('palette hands off remote deletion to confirmation without dispatching on the first Enter', async ({
    page,
  }) => {
    const [branch] = await openRemoteBranches(page)
    await selectRemoteFilter(page)
    await selectBranchInList(page, branch.name)
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    if (!(await palette.isVisible())) await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()
    await palette.getByRole('combobox').fill('delete remote branch')
    await page.keyboard.press('Enter')
    await expect(palette).toBeVisible()
    expect(await getDispatchedActions(page)).toEqual([])
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Delete remote branch?', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    expect(await getDispatchedActions(page)).toEqual([])
    await dialog.getByRole('button', { name: 'Delete remote branch', exact: true }).click()
    await settle(page)
    expect(await getDispatchedActions(page)).toEqual([
      { type: 'deleteRemoteBranch', ref: branch.ref, expectedOid: branch.oid },
    ])
  })
})
