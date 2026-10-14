import { expect, test } from '@playwright/test'
import { openGallery, settle } from './helpers/gallery'
import { sourceProvenance } from './helpers/provenance'

for (const scenario of [
  'shell-no-repository',
  'shell-loading',
  'shell-offline',
  'shell-long-content',
  'cutover-5000',
  'cutover-inspection',
] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`@visual actual ${scenario} ${theme}`, async ({ page }, info) => {
      await openGallery(page, {
        scenario,
        colorScheme: theme,
        viewport: { width: 1180, height: 820 },
      })
      if (scenario === 'cutover-5000') {
        await page
          .getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
          .fill('graph/change-5000')
      } else if (scenario === 'cutover-inspection') {
        await page.getByRole('button', { name: 'feat/repository-history', exact: true }).click()
        await page.getByRole('tab', { name: /^Changes/ }).click()
      }
      await settle(page)
      expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
      await info.attach('actual-state', {
        body: await page.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      })
      await info.attach('capture-context', {
        body: JSON.stringify(
          {
            source: await sourceProvenance(),
            scenario,
            theme,
            viewport: { width: 1180, height: 820 },
            consumer: 'Production App',
            accepted: false,
            acceptance:
              'USER-DEFERRED visual/native/AT/provider acceptance; immutable historical baselines unchanged',
            calls: await page.evaluate(() => window.fixture.calls),
          },
          null,
          2,
        ),
        contentType: 'application/json',
      })
    })
  }
}
