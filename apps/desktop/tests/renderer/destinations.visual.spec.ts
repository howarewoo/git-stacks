import { expect, test } from '@playwright/test'
import { openGallery } from './helpers/gallery'
import { DESTINATIONS, destinationScenario, switchDestination } from './helpers/destinations'
import { sourceProvenance } from './helpers/provenance'

const viewports = [
  { width: 1000, height: 700 },
  { width: 1180, height: 820 },
  { width: 1440, height: 940 },
  { width: 1536, height: 1000 },
  { width: 1920, height: 1080 },
]

for (const viewport of viewports) {
  for (const theme of ['light', 'dark'] as const) {
    for (const destination of DESTINATIONS) {
      test(`@visual actual ${destination.id} ${viewport.width}x${viewport.height} ${theme}`, async ({
        page,
      }, info) => {
        await openGallery(page, {
          scenario: destinationScenario(destination.id),
          viewport,
          colorScheme: theme,
        })
        await switchDestination(page, destination.id)
        const mutations = await page.evaluate(() => window.fixture.actions)
        expect(mutations).toEqual([])
        await info.attach('actual-consumer', {
          body: await page.screenshot({ animations: 'disabled' }),
          contentType: 'image/png',
        })
        await info.attach('capture-context', {
          body: JSON.stringify(
            {
              source: await sourceProvenance(),
              consumer: 'Production App via typed test-only inventory/inspection transport',
              viewport,
              theme,
              reducedMotion: 'reduce',
              density: 'compact',
              destination: destination.id,
              mutations,
              calls: await page.evaluate(() => window.fixture.calls),
              accepted: false,
              acceptance:
                'USER-DEFERRED visual/native/AT/provider acceptance; historical macOS baselines unchanged',
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
