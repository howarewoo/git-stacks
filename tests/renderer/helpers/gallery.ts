import { expect, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SCENARIO, type GalleryRouteId, type ScenarioName } from '../fixtures/manifest'
import type { FixtureCall, FixtureCallRecord } from '../fixtures/types'
import { galleryUrl } from '../fixtures/urls'
import type { GitAction } from '../../../src/shared/types'

/**
 * Fixed instant pinned for all gallery tests so relative timestamps
 * (e.g. "3h ago", "Mar 5") are completely deterministic across runs.
 */
export const FROZEN_FIXTURE_TIME = new Date('2026-09-25T12:00:00.000Z')

export const STANDARD_VIEWPORTS = {
  compact: { width: 1000, height: 700 },
  standard: { width: 1440, height: 940 },
  wide: { width: 1920, height: 1080 },
  /**
   * Browser 200% zoom on a standard 1440×940 window halves CSS pixel space
   * to 720×470. This matches how Chromium reflows and exercises the breakpoint.
   */
  zoom200: { width: 720, height: 470 },
} as const

export type StandardViewportName = keyof typeof STANDARD_VIEWPORTS

/**
 * The in-view filter field. Its accessible name is the product's contract, so
 * it is resolved here once instead of being re-spelled by every suite.
 */
export function getViewFilterInput(page: Page): Locator {
  return page.getByRole('textbox', {
    name: 'Filter current view branches, files, and pull requests',
  })
}

export interface OpenGalleryOptions {
  scenario?: ScenarioName | string
  route?: GalleryRouteId
  viewport?: { width: number; height: number }
  colorScheme?: 'light' | 'dark'
  reducedMotion?: 'reduce' | 'no-preference'
}

/**
 * Ensures web fonts are fully rasterized and double RAF has flushed layout.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve())
      })
    })
  })
}

/**
 * Navigates to a gallery scenario/route under pinned time and media settings.
 */
export async function openGallery(page: Page, options: OpenGalleryOptions = {}): Promise<void> {
  const {
    scenario = DEFAULT_SCENARIO,
    route = 'app',
    viewport = STANDARD_VIEWPORTS.standard,
    colorScheme = 'light',
    reducedMotion = 'reduce',
  } = options
  // Network guard: abort non-loopback requests so tests never hit external networks
  await page.route('**/*', (route) => {
    try {
      const url = new URL(route.request().url())
      if (
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.protocol === 'data:' ||
        url.protocol === 'blob:'
      ) {
        return route.continue()
      }
    } catch {
      return route.continue()
    }
    return route.abort('blockedbyclient')
  })

  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme, reducedMotion })

  if (page.clock) {
    await page.clock.setFixedTime(FROZEN_FIXTURE_TIME)
  }

  const targetUrl = galleryUrl(scenario, route)
  await page.goto(targetUrl)
  await expect(page.locator('#root')).toBeVisible({ timeout: 15_000 })

  // The fixture gallery automatically calls connect() on mount to open
  // the repository for active repository scenarios.
  if (route === 'app' && scenario !== 'shell-no-repository' && scenario !== 'shell-loading') {
    await expect(page.getByRole('toolbar', { name: 'Repository actions' })).toBeVisible({
      timeout: 15_000,
    })
  }
  await settle(page)
}

/**
 * Returns the append-only list of GitActions dispatched through `desktop.runAction`.
 */
export async function getDispatchedActions(page: Page): Promise<GitAction[]> {
  return page.evaluate(() => {
    if (!window.fixture) throw new Error('window.fixture is not installed')
    return [...window.fixture.actions]
  })
}

/**
 * Returns the append-only list of external URLs opened via `desktop.openExternal`.
 */
export async function getOpenedExternalUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    if (!window.fixture) throw new Error('window.fixture is not installed')
    return [...window.fixture.externalUrls]
  })
}

/**
 * Returns the complete double call log (reads and writes).
 */
export async function getDoubleCalls(page: Page): Promise<FixtureCallRecord[]> {
  return page.evaluate(() => {
    if (!window.fixture) throw new Error('window.fixture is not installed')
    return [...window.fixture.calls]
  })
}

/**
 * Puts a specific double method on hold so future calls remain pending.
 */
export async function holdDoubleCall(page: Page, call: FixtureCall): Promise<void> {
  await page.evaluate((targetCall) => {
    window.fixture.hold(targetCall)
  }, call)
}

/**
 * Releases held calls of a given method (or all calls if omitted).
 */
export async function releaseDoubleCalls(page: Page, call?: FixtureCall): Promise<number> {
  return page.evaluate((targetCall) => {
    return window.fixture.release(targetCall)
  }, call)
}

/**
 * Sets up a single-shot rejection for the next call to `call`.
 */
export async function failNextDoubleCall(
  page: Page,
  call: FixtureCall,
  message?: string,
): Promise<void> {
  await page.evaluate(
    ({ targetCall, msg }) => {
      window.fixture.failNext(targetCall, msg)
    },
    { targetCall: call, msg: message },
  )
}

/**
 * Clears logs and holds on the active scenario double.
 */
export async function resetDouble(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.fixture?.reset()
  })
}
