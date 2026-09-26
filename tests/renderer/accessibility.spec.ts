import { expect, test } from '@playwright/test'
import { openGallery, settle } from './helpers/gallery'
import { DESTINATIONS, switchDestination } from './helpers/destinations'
import {
  openDeleteLocalBranchDialog,
  openForcePushDialog,
  openNewBranchDialog,
  openStashDialog,
  selectBranchInList,
} from './helpers/dialogs'
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
  test.describe('Axe audits on real application surfaces', () => {
    test('asserts zero axe violations (all axe rules) on shell onboarding pane', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-no-repository' })
      await settle(page)
      await assertNoAxeViolations(page, 'Shell onboarding pane', { allRules: true })
    })

    test.describe('Axe audit across all six destinations', () => {
      test.beforeEach(async ({ page }) => {
        await openGallery(page, { scenario: 'shell-connected' })
      })

      for (const dest of DESTINATIONS) {
        test(`asserts zero axe violations (all axe rules) on ${dest.label} (${dest.id})`, async ({
          page,
        }) => {
          await switchDestination(page, dest.id)
          await settle(page)
          await assertNoAxeViolations(page, `${dest.label} destination`, { allRules: true })
        })
      }
    })
  })

  test.describe('Axe audit on representative real dialogs (WCAG 2.1/2.2 AA tags, dialog subtree)', () => {
    test('asserts zero axe violations in "Create a branch" dialog', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const dialog = await openNewBranchDialog(page)

      await assertNoAxeViolations(page, 'Create a branch dialog', {
        includeSelector: '[role="dialog"]',
      })

      await dialog.getByRole('button', { name: 'Cancel' }).click()
    })

    test('asserts zero axe violations in "Delete local branch?" dialog', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const dialog = await openDeleteLocalBranchDialog(page, 'feature/checkout-tests')

      await assertNoAxeViolations(page, 'Delete local branch dialog', {
        includeSelector: '[role="dialog"]',
      })
      const measurements = await scanElementsContrast(page, [
        '.workflow-dialog p',
        '.workflow-dialog p strong',
      ])
      recordContrast(measurements)
      assertContrast(measurements, 'Destructive dialog description and target')

      await dialog.getByRole('button', { name: 'Cancel' }).click()
    })

    test('asserts zero axe violations in "Stash working changes" dialog', async ({ page }) => {
      await openGallery(page, { scenario: 'files-staged' })
      const dialog = await openStashDialog(page)

      await assertNoAxeViolations(page, 'Stash working changes dialog', {
        includeSelector: '[role="dialog"]',
      })

      await dialog.getByRole('button', { name: 'Cancel' }).click()
    })

    test('asserts zero axe violations in "Force push with lease" dialog', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const dialog = await openForcePushDialog(page)

      await assertNoAxeViolations(page, 'Force push with lease dialog', {
        includeSelector: '[role="dialog"]',
      })
      const measurements = await scanElementsContrast(page, ['.workflow-dialog p'])
      recordContrast(measurements)
      assertContrast(measurements, 'Force-push dialog description')

      await dialog.getByRole('button', { name: 'Cancel' }).click()
    })
  })

  test.describe('Axe audit on component gallery specimen routes (WCAG 2.1/2.2 AA tags)', () => {
    test('asserts zero axe violations on Foundations specimen', async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        route: 'foundations',
      })
      await settle(page)
      await assertNoAxeViolations(page, 'Foundations specimen')
    })

    test('asserts zero axe violations on Shell specimen', async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        route: 'shell',
      })
      await settle(page)
      await assertNoAxeViolations(page, 'Shell specimen')
    })

    test('asserts zero axe violations on Data surfaces specimen', async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        route: 'data',
      })
      await settle(page)
      await assertNoAxeViolations(page, 'Data surfaces specimen')
    })

    test('asserts zero axe violations on Dialogs specimen', async ({ page }) => {
      await openGallery(page, {
        scenario: 'shell-connected',
        route: 'dialog',
      })
      await settle(page)
      await assertNoAxeViolations(page, 'Dialogs specimen')
    })
  })

  test.describe('Text contrast against real adjacent rendered backgrounds', () => {
    test('measures key text elements on branches destination', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      await settle(page)

      const selectorsToMeasure = [
        '.titlebar-brand strong',
        '.repo-name',
        '.nav-item-label',
        '.list-title-group h1',
        '.list-subtitle',
        '.branch-copy strong',
        '.branch-subject',
        '.branch-updated',
        '.branch-row-selected .branch-copy strong',
        '.branch-row-selected .branch-subject',
        '.branch-row-selected .branch-updated',
      ]

      const measurements = await scanElementsContrast(page, selectorsToMeasure)
      recordContrast(measurements)
      assertContrast(measurements, 'Branches destination key text surfaces')
    })

    test('measures key text elements on working changes destination', async ({ page }) => {
      await openGallery(page, { scenario: 'files-staged' })
      await switchDestination(page, 'changes')
      await settle(page)

      const selectorsToMeasure = [
        '.list-title-group h1',
        '.change-section-header h2',
        '.file-copy',
        '.commit-panel-heading h2',
      ]

      const measurements = await scanElementsContrast(page, selectorsToMeasure)
      recordContrast(measurements)
      assertContrast(measurements, 'Working changes text surfaces')
    })

    test('measures diff and status text contrast on real rendered backgrounds', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'files-conflicts' })
      await switchDestination(page, 'changes')
      await settle(page)

      const selectorsToMeasure = ['.file-status', '.file-path-current', '.file-inspect']

      const measurements = await scanElementsContrast(page, selectorsToMeasure)
      recordContrast(measurements)
      assertContrast(measurements, 'Diff and file status text surfaces')

      await switchDestination(page, 'history')
      await expect(page.locator('.code-diff')).toBeVisible()
      const diffMeasurements = await scanElementsContrast(page, ['.diff-add', '.diff-remove'])
      recordContrast(diffMeasurements)
      assertContrast(diffMeasurements, 'Added and removed diff lines')
    })

    test('measures key text elements inside dialog', async ({ page }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      const dialog = await openNewBranchDialog(page)

      const selectorsToMeasure = [
        '.workflow-dialog h2',
        '.workflow-dialog p',
        '.workflow-dialog label',
      ]

      const measurements = await scanElementsContrast(page, selectorsToMeasure)
      recordContrast(measurements)
      assertContrast(measurements, 'Create a branch dialog text surfaces')

      await dialog.getByRole('button', { name: 'Cancel' }).click()
    })
  })

  test.describe('Non-text control border and focus ring contrast (>= 3.0:1)', () => {
    test('focus ring on toolbar button contrasts >= 3:1 against adjacent background', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })

      const fetchBtn = page.getByRole('button', { name: 'Fetch', exact: true })
      const measurement = await measureFocusIndicatorContrast(page, fetchBtn)
      recordContrast(measurement)

      expect(measurement, 'Fetch focus ring must be measurable').not.toBeNull()
      expect(
        measurement!.ratio,
        `Focus ring ${measurement!.ringColor} on ${measurement!.adjacentBackground} must be >= ${measurement!.requiredRatio}:1`,
      ).toBeGreaterThanOrEqual(measurement!.requiredRatio)
    })

    test('focus ring on search input contrasts >= 3:1 against adjacent background', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })

      const searchInput = page.getByRole('textbox', {
        name: 'Search branches, files, and pull requests',
      })
      const measurement = await measureFocusIndicatorContrast(page, searchInput)
      recordContrast(measurement)

      expect(measurement, 'Search field focus ring must be measurable').not.toBeNull()
      expect(
        measurement!.ratio,
        `Focus ring ${measurement!.ringColor} on ${measurement!.adjacentBackground} must be >= ${measurement!.requiredRatio}:1`,
      ).toBeGreaterThanOrEqual(measurement!.requiredRatio)
    })

    test('essential control borders contrast >= 3:1 against adjacent backgrounds (WCAG 1.4.11)', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })
      await settle(page)

      // The border is on the control itself, not on its wrapper: `.toolbar-search` only
      // positions the icon and the shortcut hint.
      const readings = await measureControlBorders(page, [
        {
          label: 'repository search field',
          locator: page.getByRole('textbox', {
            name: 'Search branches, files, and pull requests',
            exact: true,
          }),
        },
        {
          label: 'Fetch secondary toolbar button',
          locator: page.getByRole('button', { name: 'Fetch', exact: true }),
        },
      ])
      recordContrast(readings)
      assertControlBorderContrast(readings)
    })

    test('dialog control borders contrast >= 3:1 against adjacent backgrounds (WCAG 1.4.11)', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'files-staged' })
      const dialog = await openStashDialog(page)

      const readings = await measureControlBorders(page, [
        {
          label: 'stash message field',
          locator: dialog.getByRole('textbox', { name: 'Message (optional)', exact: true }),
        },
        { label: 'include untracked checkbox', locator: dialog.getByRole('checkbox') },
      ])
      recordContrast(readings)
      assertControlBorderContrast(readings)

      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    })
  })

  test.describe('Disabled-action explanations and hints', () => {
    test('default branch delete action displays explanation why it is disabled', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })

      // Select default branch "main"
      await selectBranchInList(page, 'main')

      const inspector = page.locator('.details-pane')
      const deleteBtn = inspector.getByRole('button', { name: 'Delete local branch', exact: true })
      await expect(deleteBtn).toBeDisabled()

      // The adjacent action-hint explains why the default branch cannot be deleted
      await expect(
        inspector.getByText('The default branch cannot be deleted.', { exact: true }),
      ).toBeVisible()
    })

    test('current branch delete action displays explanation why it is disabled', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'shell-connected' })

      // Select current branch "feature/checkout"
      await selectBranchInList(page, 'feature/checkout')

      const inspector = page.locator('.details-pane')
      const deleteBtn = inspector.getByRole('button', { name: 'Delete local branch', exact: true })
      await expect(deleteBtn).toBeDisabled()

      // The adjacent action-hint explains why the current branch cannot be deleted
      await expect(
        inspector.getByText('Switch to another branch before deleting this one.', { exact: true }),
      ).toBeVisible()
    })

    test('GitHub unavailable banner in pull requests destination explains why', async ({
      page,
    }) => {
      await openGallery(page, { scenario: 'pull-requests-unavailable' })
      await switchDestination(page, 'pullRequests')
      await settle(page)

      const ghBanner = page.locator('.gh-banner')
      await expect(ghBanner).toBeVisible()
      await expect(ghBanner).toContainText('GitHub data unavailable')
      await expect(ghBanner).toContainText(
        'GitHub metadata unavailable: the gh CLI is not installed',
      )
    })
  })
})
