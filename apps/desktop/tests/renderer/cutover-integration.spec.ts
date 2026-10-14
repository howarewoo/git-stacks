import { expect, test } from '@playwright/test'
import {
  openGallery,
  settle,
  holdDoubleCall,
  releaseDoubleCalls,
  publishCliStatus,
} from './helpers/gallery'
import type { Page } from '@playwright/test'

const writes = [
  'executeOperation',
  'runAction',
  'reviewSubmit',
  'pullRequestAction',
  'rerunPullRequestCheck',
  'adoptWorktrees',
  'openRepository',
]
async function noWrites(page: Page) {
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  expect(
    await page.evaluate(
      (names) => window.fixture.calls.filter((call) => names.includes(call.call)),
      writes,
    ),
  ).toEqual([])
}
async function chooseFile(page: Page, path: RegExp) {
  await page.getByRole('combobox', { name: 'Local file to inspect', exact: true }).click()
  await page.getByRole('option', { name: path }).click()
}

test('actual selected directory separates HEAD-index and index-directory edits, rename and untracked bytes without writing', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'cutover-inspection' })
  await page.getByRole('button', { name: 'feat/repository-history', exact: true }).click()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await chooseFile(page, /src\/dual\.ts$/)
  await expect(page.getByLabel('Staged · HEAD compared with index', { exact: true })).toContainText(
    '-old staged line',
  )
  await expect(
    page.getByLabel('Unstaged · index compared with directory', { exact: true }),
  ).toContainText('+new worktree line')
  await chooseFile(page, /src\/new Ω\.ts$/)
  await expect(page.getByLabel('Untracked directory content', { exact: true })).toContainText(
    'original Unicode bytes Ω',
  )
  await page.getByRole('combobox', { name: 'Local file to inspect', exact: true }).click()
  await expect(
    page.getByRole('option', { name: /src\/old name\.ts → src\/new name\.ts$/ }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  expect(
    await page.getByRole('button', { name: /^(Stage|Unstage|Commit|Stash|Discard)/ }).count(),
  ).toBe(0)
  await noWrites(page)
})

test('a late selected-file read cannot replace a newly selected directory or imply checkout', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'cutover-inspection' })
  await page.getByRole('button', { name: 'feat/repository-history', exact: true }).click()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.evaluate(() => window.fixture.hold('fileView'))
  await chooseFile(page, /src\/dual\.ts$/)
  await page.getByRole('button', { name: 'feat/worktree-registry', exact: true }).click()
  await page.evaluate(() => window.fixture.release('fileView'))
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(
    page.getByText('No local changes were observed in this directory.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel('Staged · HEAD compared with index', { exact: true })).toHaveCount(0)
  await noWrites(page)
})

test('global keyboard search is independent of the local lane filter and does not activate a checkout', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'cutover-250' })
  const local = page.getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
  await local.fill('graph/change-250')
  await page.getByRole('button', { name: 'graph/change-250', exact: true }).focus()
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: 'Global search', exact: true })
  await expect(search).toBeVisible()
  await search
    .getByRole('combobox', { name: 'Global search', exact: true })
    .fill('independent clone 雪')
  await expect(search.getByText(/independent clone 雪/).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(local).toHaveValue('graph/change-250')
  await noWrites(page)
})

test('opening paused external recovery is read-only and does not replay an old checkpoint', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'workflow-operation-recovery' })
  await page.getByRole('button', { name: /^Operations and recovery/ }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Repository-qualified operations and recovery',
    exact: true,
  })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Browsing does not abort, replay or retarget an operation.')
  await settle(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await noWrites(page)
})

test('a held CLI refresh cannot restore an account replaced outside the window', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'GitHub CLI', exact: true })
    .click()
  const status = settings.getByRole('region', { name: 'GitHub CLI', exact: true })
  const original = await page.evaluate(async () => window.desktop.githubCliStatus!())
  await expect(status).toContainText(original.login!)
  await holdDoubleCall(page, 'githubCliStatus')
  await status.getByRole('button', { name: 'Refresh status', exact: true }).click()
  await publishCliStatus(page, {
    state: 'signed-out',
    host: 'github.com',
    login: null,
    version: '2.62.0',
    identity: null,
    message: 'No account is signed in for github.com.',
  })
  await expect(status).toContainText('Not signed in')
  await releaseDoubleCalls(page, 'githubCliStatus')
  await settle(page)
  await expect(status).toContainText('Not signed in')
  await expect(status).not.toContainText(original.login!)
  await noWrites(page)
})

test('generated local diff pages preserve exact 1000-line boundaries and reset for another file', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'cutover-inspection' })
  await page.getByRole('button', { name: 'feat/repository-history', exact: true }).click()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await chooseFile(page, /src\/generated\.ts$/)
  const staged = page.getByLabel('Staged · HEAD compared with index', { exact: true })
  const stagedSection = staged.locator('..')
  const text = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => `+line ${from + index}`).join('\n')
  await expect(staged).toHaveText(text(1, 1000))
  await stagedSection.getByRole('button', { name: 'Next lines', exact: true }).click()
  await expect(staged).toHaveText(text(1001, 2000))
  await stagedSection.getByRole('button', { name: 'Next lines', exact: true }).click()
  await expect(staged).toHaveText(text(2001, 2400))
  await expect(
    stagedSection.getByRole('button', { name: 'Next lines', exact: true }),
  ).toBeDisabled()
  await chooseFile(page, /src\/dual\.ts$/)
  await expect(staged).toContainText('-old staged line')
  await expect(stagedSection.getByRole('button', { name: 'Next lines', exact: true })).toHaveCount(
    0,
  )
  await noWrites(page)
})
