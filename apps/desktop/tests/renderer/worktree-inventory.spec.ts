import { expect, test } from '@playwright/test'
import { openGallery, getDoubleCalls } from './helpers/gallery'
import { inventoryFixture } from './fixtures/inventory'
import { GALLERY_ROUTES } from './fixtures/manifest'

// These tests exercise the actual React/TanStack consumer with deferred DesktopAPI
// replies. Native Electron IPC, directory adoption and Git success need main/smoke proof.
test('qualified associations and independently degraded local counts remain truthful', async ({
  page,
}) => {
  await openGallery(page, { route: 'inventory' })
  await expect(page.getByTestId('inventory-generation')).toHaveText('Publication 1: complete')
  await expect(page.getByTestId('inventory-ref')).toHaveCount(3)
  await expect(page.getByLabel('Qualified refs')).toContainText('local-only: local; No worktree')
  await expect(page.getByLabel('Qualified refs')).toContainText('topic: remote; No worktree')
  await expect(page.getByLabel('Pull requests')).toContainText('PR-only: no local branch')
  await expect(page.getByLabel('Worktrees')).toContainText(
    'unknown; read: failed; Counts unavailable',
  )
  await expect(page.getByLabel('Worktrees')).toContainText(
    'dirty; read: complete; Counts: staged 1',
  )
  await page.evaluate(
    (value) => window.fixture.pushInventory(value),
    inventoryFixture(2, 'partial'),
  )
  await expect(page.getByTestId('inventory-generation')).toHaveText('Publication 2: partial')
  await expect(page.getByLabel('Worktrees')).toContainText('Lower bounds: staged 1')
  await page.evaluate(
    (value) => window.fixture.pushInventory(value),
    inventoryFixture(3, 'offline'),
  )
  await expect(page.getByText('Discovery: complete; refs: complete; remote: offline')).toBeVisible()
  await expect(page.getByTestId('inventory-worktree')).toHaveCount(3)
  await page.evaluate((value) => window.fixture.pushInventory(value), inventoryFixture(4, 'failed'))
  await expect(page.getByTestId('inventory-generation')).toHaveText('Publication 4: failed')
  await expect(page.getByRole('alert')).toContainText('Discovery unavailable')
  expect(
    (await getDoubleCalls(page)).filter(({ call }) =>
      ['runAction', 'adoptWorktrees', 'cloneRepository'].includes(call),
    ),
  ).toEqual([])
})

test('watcher publication wins over a held older reply without cancelling local discovery', async ({
  page,
}) => {
  await openGallery(page, { route: 'inventory' })
  await expect(page.getByTestId('inventory-generation')).toContainText('Publication 1')
  await page.evaluate(() => window.fixture.hold('worktreeInventory'))
  await page.getByRole('button', { name: 'Refresh inventory' }).click()
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter(({ call }) => call === 'worktreeInventory').length,
    )
    .toBe(2)
  await page.evaluate(
    (value) => window.fixture.pushInventory(value),
    inventoryFixture(5, 'partial'),
  )
  await expect(page.getByTestId('inventory-generation')).toHaveText('Publication 5: partial')
  expect((await getDoubleCalls(page)).filter(({ call }) => call === 'cancelInventory')).toEqual([])
  expect(await page.evaluate(() => window.fixture.release('worktreeInventory'))).toBe(1)
  await expect
    .poll(() =>
      page
        .getByRole('button', { name: 'Refresh inventory' })
        .evaluate(() => window.fixture.pending.includes('worktreeInventory')),
    )
    .toBe(false)
  await expect(page.getByTestId('inventory-read-state')).toHaveText('idle')
  await expect(page.getByTestId('inventory-generation')).toHaveText('Publication 5: partial')
})

test('credential retirement cannot restore previous-account metadata through late replies or cached context revisits', async ({
  page,
}) => {
  await openGallery(page, { route: 'inventory' })
  await expect(page.getByLabel('Pull requests')).toContainText('Previous account topic metadata')
  await page.getByRole('button', { name: 'Switch context' }).click()
  await expect(page.getByTestId('inventory-context')).toContainText('repository-b')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter(({ call }) => call === 'worktreeInventory').length,
    )
    .toBe(2)
  await page.evaluate(() => window.fixture.hold('worktreeInventory'))
  await page.getByRole('button', { name: 'Refresh inventory' }).click()
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter(({ call }) => call === 'worktreeInventory').length,
    )
    .toBe(3)
  await page.evaluate(
    (value) => window.fixture.pushInventory(value),
    inventoryFixture(7, 'retired'),
  )
  await expect(page.getByLabel('Pull requests')).toBeEmpty()
  expect(await page.evaluate(() => window.fixture.release('worktreeInventory'))).toBe(1)
  await expect(page.getByTestId('inventory-read-state')).toHaveText('idle')
  await expect(page.getByTestId('inventory-generation')).toContainText('Publication 7')
  await page.getByRole('button', { name: 'Switch context' }).click()
  await expect(page.getByTestId('inventory-context')).toContainText('repository-a')
  await expect(page.getByTestId('inventory-generation')).toContainText('Publication 7')
  await expect(page.getByLabel('Pull requests')).toBeEmpty()
  await expect(page.getByTestId('inventory-read-state')).toHaveText('idle')
  await expect(
    page.getByRole('status', { name: /Confirmed pull request associations for/ }),
  ).toHaveText(['0', '0', '0'])
  await expect(
    page.getByText('Credential generation retired; previous-account metadata removed'),
  ).toBeVisible()
})

test('selected and repository context switches retire view reads, not active operation APIs', async ({
  page,
}) => {
  await openGallery(page, { route: 'inventory' })
  await expect(page.getByTestId('inventory-generation')).toContainText('Publication 1')
  await page.evaluate(() => window.fixture.hold('worktreeInventory'))
  await page.getByRole('button', { name: 'Refresh inventory' }).click()
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter(({ call }) => call === 'worktreeInventory').length,
    )
    .toBe(2)
  await page.getByRole('button', { name: 'Select next worktree' }).click()
  await expect(page.getByTestId('inventory-context')).toContainText('selected: 1')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter(({ call }) => call === 'cancelInventory').length,
    )
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Switch context' }).click()
  await expect(page.getByTestId('inventory-context')).toContainText('repository-b')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter(({ call }) => call === 'worktreeInventory').length,
    )
    .toBe(4)
  const calls = await getDoubleCalls(page)
  const reads = calls.filter(({ call }) => call === 'worktreeInventory')
  const retiredIds = calls
    .filter(({ call }) => call === 'cancelInventory')
    .map(({ args }) => args[0])
  expect(
    retiredIds.every((id) =>
      reads.some(({ args }) => {
        const request = args[0]
        return (
          request !== null &&
          typeof request === 'object' &&
          'requestId' in request &&
          request.requestId === id
        )
      }),
    ),
  ).toBe(true)
  expect(calls.filter(({ call }) => call === 'cancel' || call === 'runAction')).toEqual([])
  await page.evaluate(() => window.fixture.release('worktreeInventory'))
  await expect(page.getByTestId('inventory-generation')).toContainText('Publication 1')
})

test('120 simultaneous worktrees use one aggregate read', async ({ page }) => {
  await openGallery(page, { route: 'inventory' })
  await expect(page.getByTestId('inventory-generation')).toContainText('Publication 1')
  await page.evaluate(
    (value) => window.fixture.pushInventory(value),
    inventoryFixture(8, 'complete', 120),
  )
  await expect(page.getByTestId('inventory-worktree')).toHaveCount(120)
  expect(
    (await getDoubleCalls(page)).filter(({ call }) => call === 'worktreeInventory'),
  ).toHaveLength(1)
})

test('remount after an unobserved credential retirement does not expose cached previous-account facts', async ({
  page,
}) => {
  await openGallery(page, { route: 'inventory' })
  await expect(page.getByText('Previous account topic metadata', { exact: false })).toBeVisible()
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, GALLERY_ROUTES.index)
  await expect(page.getByTestId('inventory-context')).toHaveCount(0)
  await page.evaluate(
    (value) => {
      window.fixture.pushInventory(value)
      window.fixture.hold('worktreeInventory')
    },
    inventoryFixture(9, 'retired'),
  )
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, GALLERY_ROUTES.inventory)
  await expect(page.getByTestId('inventory-context')).toBeVisible()
  await expect(page.getByTestId('inventory-read-state')).toHaveText('fetching')
  await expect(page.getByText('Previous account topic metadata', { exact: false })).toHaveCount(0)
  await page.evaluate(() => window.fixture.release('worktreeInventory'))
  await expect(page.getByTestId('inventory-generation')).toContainText('Publication 9')
  await expect(page.getByLabel('Pull requests')).toBeEmpty()
})
