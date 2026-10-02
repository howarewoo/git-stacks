import { expect, type Locator, type Page } from '@playwright/test'
import {
  DEFAULT_SCENARIO,
  GALLERY_ROUTES,
  type GalleryRouteId,
  type ScenarioName,
} from '../fixtures/manifest'
import { scenarios } from '../fixtures/scenarios'
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
 * Scenarios the gallery mounts with nothing open. The queue is one destination
 * among several that works without a repository — it spans every registered
 * repository — so this is a property of those scenarios, not of the queue.
 */
const SCENARIOS_WITHOUT_A_REPOSITORY = new Set(
  Object.entries(scenarios)
    .filter(([, scenario]) => scenario.snapshot === null)
    .map(([name]) => name),
)

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
  if (route === 'app' && !SCENARIOS_WITHOUT_A_REPOSITORY.has(scenario)) {
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
export async function releaseDoubleCalls(
  page: Page,
  call?: FixtureCall,
  occurrence?: 'oldest' | 'newest',
): Promise<number> {
  return page.evaluate(
    ({ targetCall, targetOccurrence }) => {
      return window.fixture.release(targetCall, targetOccurrence)
    },
    { targetCall: call, targetOccurrence: occurrence },
  )
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
 * Changes the gallery route the way a person using the gallery's own index
 * does: same document, new hash, no reload.
 *
 * The fixture double is installed once and outlives every route, so a spec can
 * hold a call while the component tree is unmounted and find that call pending
 * the moment the tree mounts again. A read the App issues at mount — its stored
 * filters, say — is only reachable that way, and a reload would throw away the
 * very in-place transition the hold exists to stage.
 */
export async function switchGalleryRoute(page: Page, route: GalleryRouteId): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, GALLERY_ROUTES[route])
  await expect(page.locator(`html[data-gallery-route="${route}"]`)).toBeAttached()
}

/**
 * Installs another scenario's answers into the doubles the mounted page is
 * already using. Nothing remounts: the window keeps its destination, its state
 * and its in-flight reads, and the repository it is displaying stays on screen
 * until the application opens or refreshes one itself.
 */
export async function changeScenario(page: Page, name: ScenarioName): Promise<void> {
  await page.evaluate((scenarioName) => {
    window.fixture.setScenario(scenarioName)
  }, name)
}

/**
 * Answers the next call of `call` with `value` once, as the producer itself
 * would return it. It is consumed by the first call `release` settles.
 */
export async function answerNextDoubleCall(
  page: Page,
  call: FixtureCall,
  value: unknown,
): Promise<void> {
  await page.evaluate(
    ({ targetCall, answer }) => {
      window.fixture.answerNext(targetCall, answer)
    },
    { targetCall: call, answer: value },
  )
}

/**
 */
export async function resetDouble(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.fixture?.reset()
  })
}
