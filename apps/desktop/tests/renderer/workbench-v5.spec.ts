import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1000 })
  await page.goto('/?scenario=shell-connected#/workbench-v5')
  await expect(page.getByRole('heading', { name: 'Branches & worktrees' })).toBeVisible()
})

test('qualified chain/fork selection changes inspection without dispatch', async ({ page }) => {
  const refs = await page.locator('.bw-branch-name').allTextContents()
  for (const [child, parent] of [
    ['docs/worktree-workflows', 'feat/worktree-switcher'],
    ['feat/worktree-switcher', 'feat/worktree-registry'],
    ['feat/stack-order', 'feat/worktree-registry'],
    ['experiment/diff-layout', 'feat/worktree-registry'],
    ['feat/worktree-registry', 'main'],
  ]) {
    expect(refs).toContain(child)
    expect(refs).toContain(parent)
    expect(refs.indexOf(child)).toBeLessThan(refs.indexOf(parent))
  }
  await page.getByRole('button', { name: 'feat/worktree-switcher', exact: true }).click()
  await expect(page.locator('.bw-inspector h2')).toHaveText('Keep context when switching worktrees')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.bw-facts > div').nth(1).locator('strong')).toHaveText('3')
  await page.getByRole('button', { name: 'Review pull request', exact: false }).click()
  await expect(page.getByRole('dialog')).toContainText('No Git, filesystem or GitHub operation ran')
  await expect(page.getByRole('dialog')).toContainText('refs/heads/feat/worktree-switcher')
  await expect(page.getByRole('dialog')).toContainText('fixture-admin-w2:1')
})

test('filter keeps actual ancestors and excludes context from page selection', async ({ page }) => {
  await page
    .getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
    .fill('docs/worktree-workflows')
  await expect(page.locator('.bw-lane-row')).toHaveCount(4)
  await expect(page.locator('.bw-context')).toHaveCount(3)
  await page
    .getByRole('checkbox', { name: 'Select visible matching branches; excludes trunk and context' })
    .click()
  await expect(page.locator('.bw-bulk')).toContainText('1 selected')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.bw-context [role=checkbox]:not([disabled])')).toHaveCount(0)
})

test('repository switching restores filter and qualified selected context', async ({ page }) => {
  const filter = page.getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
  await filter.fill('registry')
  await page.getByRole('button', { name: /^howarewoo\/toolkit ·/ }).click()
  await expect(filter).toHaveValue('')
  await expect(page.locator('.bw-inspector h2')).toHaveText('Carry request context across services')
  await page.getByRole('button', { name: /^howarewoo\/git-stacks ·/ }).click()
  await expect(filter).toHaveValue('registry')
  await expect(page.locator('.bw-inspector h2')).toHaveText('Discover and track linked worktrees')
})

test('degraded local and provider facts remain unknown rather than clean or passing', async ({
  page,
}) => {
  await page.goto('/?scenario=shell-connected&workbench=degraded#/workbench-v5')
  await expect(page.locator('.bw-data-notice')).toContainText('GitHub offline')
  await expect(page.locator('.bw-inspector')).toContainText('Worktree and GitHub data unavailable')
  const unavailableCounts = page.locator('.bw-facts > div').filter({
    has: page.getByText(/^(uncommitted files|unpushed commits)$/),
  })
  await expect(unavailableCounts).toHaveCount(2)
  for (const count of await unavailableCounts.locator('strong').all()) {
    await expect(count).not.toHaveText(/^\d+$/)
  }
  await expect(page.locator('.bw-inspector .bw-readiness').first()).toContainText('Unavailable')
  await expect(page.locator('.bw-directory')).not.toContainText('Clean')
  await expect(page.getByRole('button', { name: /All branches.*Unknown/ })).toBeVisible()
  await page.getByRole('button', { name: 'docs/worktree-workflows', exact: true }).click()
  await expect(page.locator('.bw-inspector')).toContainText('PR metadata unknown')
  await expect(page.locator('.bw-lane-row.bw-selected .bw-pr-status')).toContainText(
    'PR association unknown',
  )
})

test('narrow inspector uses shared focus-managed sheet and Escape only dismisses inspection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await page.reload()
  await expect(page.locator('.bw-inspector')).toHaveCount(0)
  await page.getByRole('button', { name: 'feat/worktree-switcher', exact: true }).click()
  const inspector = page.getByRole('dialog', { name: 'Selected branch details' })
  await expect(inspector).toContainText('Keep context when switching worktrees')
  await page.keyboard.press('Escape')
  await expect(inspector).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'feat/worktree-switcher', exact: true }),
  ).toBeFocused()
})

test('filtered outline has ordinary Tab entry and moves focus without retargeting inspection', async ({
  page,
}) => {
  const filter = page.getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
  await filter.fill('fix/parallel-refresh')
  const rows = page.locator('.bw-lane-row')
  await expect(rows).toHaveCount(3)
  await expect(page.locator('.bw-lane-row.bw-selected')).toHaveAttribute(
    'aria-label',
    /Context: does not match current filter/,
  )
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.keyboard.press('Tab')
    if (await rows.first().evaluate((row) => row === document.activeElement)) break
  }
  await expect(rows.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  await expect(page.locator('.bw-inspector .bw-ref')).toHaveText('feat/worktree-registry')
  await page.keyboard.press('Home')
  await expect(rows.first()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('button', { name: 'feat/worktree-registry', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  await expect(page.locator('.bw-inspector .bw-ref')).toHaveText('feat/worktree-registry')
  await page.keyboard.press('End')
  await expect(rows.last()).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('.bw-inspector .bw-ref')).toHaveText('fix/parallel-refresh')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('icon-only repository rail keeps full names and switches qualified context', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 700 })
  await page.reload()
  for (const name of ['howarewoo/git-stacks', 'howarewoo/toolkit', 'howarewoo/web-platform']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${name} ·`) })).toBeVisible()
  }
  await page.getByRole('button', { name: /^howarewoo\/toolkit ·/ }).click()
  await expect(page.getByRole('button', { name: /^howarewoo\/toolkit ·/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: /^howarewoo\/git-stacks ·/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
