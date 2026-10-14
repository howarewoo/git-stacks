import { expect, test } from '@playwright/test'
import { getViewFilterInput, openGallery, settle } from './helpers/gallery'
import { DESTINATIONS, switchDestination } from './helpers/destinations'
import { assertNoAxeViolations } from './helpers/axe'
import { assertControlBorderContrast, measureControlBorders } from './helpers/borders'
import {
  assertContrast,
  measureFocusIndicatorContrast,
  scanElementsContrast,
} from './helpers/contrast'

function recordContrast(measurements: unknown): void {
  test
    .info()
    .annotations.push({ type: 'rendered-contrast', description: JSON.stringify(measurements) })
}

test.describe('Automated accessibility audits and contrast', () => {
  test('asserts zero axe violations (all rules) without an open repository', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-no-repository' })
    await settle(page)
    await assertNoAxeViolations(page, 'Workbench without a repository', { allRules: true })
  })

  for (const destination of DESTINATIONS) {
    test(`asserts zero axe violations (all rules) on ${destination.label}`, async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      await switchDestination(page, destination.id)
      await settle(page)
      await assertNoAxeViolations(page, `${destination.label} surface`, { allRules: true })
    })
  }

  for (const tab of ['Overview', 'Changes', 'Checks', 'Discussion']) {
    test(`asserts zero axe violations (all rules) with inspector ${tab}`, async ({ page }) => {
      await openGallery(page, { scenario: 'pull-requests-checks' })
      await page.locator('.bw-subtitle').filter({ hasText: /#\d+/ }).first().click()
      await page.getByRole('tab', { name: tab, exact: tab !== 'Changes' }).click()
      await settle(page)
      await assertNoAxeViolations(page, `${tab} inspector`, { allRules: true })
    })
  }

  for (const surface of [
    { trigger: 'Settings', title: 'Settings' },
    { trigger: 'Inspect branch history', title: 'Selected committed history' },
    { trigger: 'Notifications', title: 'Optional Notifications' },
  ]) {
    test(`asserts zero axe violations in ${surface.title} dialog`, async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      if (surface.trigger === 'Inspect branch history') {
        await page.getByRole('button', { name: 'main', exact: true }).click()
      }
      await page.getByRole('button', { name: surface.trigger, exact: true }).click()
      await expect(page.getByRole('dialog', { name: surface.title, exact: true })).toBeVisible()
      await settle(page)
      await assertNoAxeViolations(page, `${surface.title} dialog`, {
        includeSelector: '[role="dialog"]',
      })
    })
  }

  test('asserts zero axe violations on Foundations specimen', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected', route: 'foundations' })
    await settle(page)
    await assertNoAxeViolations(page, 'Foundations specimen')
  })

  test('measures workbench navigation, row and inspector text against rendered backgrounds', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await page.getByRole('button', { name: 'feature/checkout', exact: true }).click()
    await settle(page)
    const readings = await scanElementsContrast(page, [
      '.bw-workspace-name strong',
      '.bw-workspace-name small',
      '.bw-nav',
      '.bw-panel-head h1',
      '.bw-panel-head p',
      '.bw-branch-name',
      '.bw-subtitle',
      '.bw-pr-status',
      '.bw-inspector h2',
      '.bw-section h3',
      '.bw-section p',
    ])
    recordContrast(readings)
    assertContrast(readings, 'Workbench text surfaces')
  })

  test('measures local inspection text and code contrast', async ({ page }) => {
    await openGallery(page, { scenario: 'files-staged' })
    await page.getByRole('button', { name: 'feature/checkout', exact: true }).click()
    await page.getByRole('tab', { name: /^Changes/ }).click()
    const files = page.getByRole('combobox', { name: 'Local file to inspect' })
    await files.click()
    await page.getByRole('option').first().click()
    await expect(page.locator('.wb-code').first()).toBeVisible()
    const readings = await scanElementsContrast(page, ['.bw-inspector p', '.wb-code'])
    recordContrast(readings)
    assertContrast(readings, 'Local file inspection')
  })

  for (const control of ['filter', 'settings'] as const) {
    test(`${control} focus indicator contrasts >= 3:1`, async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const locator =
        control === 'filter'
          ? getViewFilterInput(page)
          : page.getByRole('button', { name: 'Settings', exact: true })
      const reading = await measureFocusIndicatorContrast(page, locator)
      recordContrast(reading)
      expect(reading, 'Focus indicator must be measurable').not.toBeNull()
      expect(reading!.ratio).toBeGreaterThanOrEqual(reading!.requiredRatio)
    })
  }

  test('essential filter border contrasts >= 3:1 against its background', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    const readings = await measureControlBorders(page, [
      { label: 'branch filter', locator: getViewFilterInput(page) },
    ])
    recordContrast(readings)
    assertControlBorderContrast(readings)
  })

  test('qualified branch groups name relationship and state without relying on colour', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'ancestry-cycle' })
    const rows = page.locator('.bw-lane-row')
    expect(await rows.count()).toBeGreaterThan(0)
    const names = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label') ?? ''),
    )
    for (const name of names) {
      expect(name).toMatch(/Parent:|Published base|No recorded parent|cycle/i)
      expect(name).toMatch(/worktree|clean|dirty|changes/i)
      expect(name).toMatch(/pull request|PR association|review|approved|requested/i)
    }
    expect(names.some((name) => /cycle/i.test(name))).toBe(true)
  })

  test('filtered branch ancestry remains reachable and names prerequisite context', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await getViewFilterInput(page).fill('checkout-tests')
    await settle(page)
    await expect(
      page.getByRole('button', { name: 'feature/checkout-tests', exact: true }),
    ).toBeVisible()
    const context = page.locator('.bw-lane-row.bw-context')
    expect(await context.count()).toBeGreaterThan(0)
    for (const row of await context.all()) {
      await expect(row).toHaveAttribute('aria-label', /Context: does not match current filter/)
      await expect(row.getByRole('button').first()).toBeVisible()
    }
  })
})
