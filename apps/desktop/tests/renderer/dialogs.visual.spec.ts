import { expect, test } from '@playwright/test'
import { openGallery, settle } from './helpers/gallery'
import { sourceProvenance } from './helpers/provenance'

const cases = [
  { name: 'discovery', button: 'Discover worktrees', dialog: 'Discovered existing worktrees' },
  {
    name: 'recovery',
    button: 'Operations and recovery',
    dialog: 'Repository-qualified operations and recovery',
  },
  { name: 'native', menu: 'Inspect native stack management…', dialog: 'Native stack management' },
  { name: 'create-worktree', menu: 'Create worktree…', dialog: 'Create worktree' },
  {
    name: 'source-discrepancies',
    menu: 'Inspect source discrepancies and repairs…',
    dialog: 'Source discrepancies and explicit repairs',
  },
] as const

for (const viewport of [
  { width: 1000, height: 700 },
  { width: 1180, height: 820 },
  { width: 1440, height: 940 },
  { width: 1536, height: 1000 },
  { width: 1920, height: 1080 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const item of cases) {
      test(`@visual actual ${item.name} ${viewport.width}x${viewport.height} ${theme}`, async ({
        page,
      }, info) => {
        await openGallery(page, { scenario: 'cutover-reference', viewport, colorScheme: theme })
        if ('menu' in item) {
          await page.getByRole('button', { name: 'feat/worktree-registry', exact: true }).click()
          await page
            .getByRole('button', { name: 'Selected branch and worktree actions', exact: true })
            .click()
          await page.getByRole('menuitem', { name: item.menu, exact: true }).click()
        } else {
          await page.getByRole('button', { name: new RegExp(`^${item.button}(\\s|$)`) }).click()
        }
        const dialog = page.getByRole('dialog', { name: item.dialog, exact: true })
        await expect(dialog).toBeVisible()
        await settle(page)
        expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
        await info.attach('actual-management-dialog', {
          body: await page.screenshot({ animations: 'disabled' }),
          contentType: 'image/png',
        })
        await info.attach('capture-context', {
          body: JSON.stringify(
            {
              source: await sourceProvenance(),
              viewport,
              theme,
              selection: 'feat/worktree-registry',
              consumer: 'Production App and actual scoped dialog',
              dialog: item.dialog,
              calls: await page.evaluate(() => window.fixture.calls),
              accepted: false,
              acceptance:
                'USER-DEFERRED native/visual/provider/AT acceptance; no confirmation or mutation was dispatched',
            },
            null,
            2,
          ),
          contentType: 'application/json',
        })
      })
    }
  }
}
