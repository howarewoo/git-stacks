import { expect, test, type Page } from '@playwright/test'
import { openGallery, publishCliStatus, releaseDoubleCalls, settle } from './helpers/gallery'
import { openManagePullRequestDialog, selectBranchInList } from './helpers/dialogs'
import { switchDestination } from './helpers/destinations'

/**
 * The merge dialog, driven as a person drives it: open the merge preview, send the
 * merge, and read what GitHub reports afterwards.
 *
 * A run that GitHub is still running speaks through the progress channel and then
 * returns. What the dialog shows from then on has to be the read-back, because a read
 * is newer than the progress that run pushed. Keeping the run's own progress on screen
 * after it returned would leave a finished run looking like it is still running, which
 * is exactly what the read is there to correct.
 */
test.describe('Merge reads after a run', () => {
  test('a finished run is replaced by what GitHub reports', async ({ page }) => {
    await openGallery(page, { scenario: 'pull-requests-lifecycle' })
    await openManagePullRequestDialog(page, 'feature/lifecycle-open')
    await page.getByRole('button', { name: 'Preview merge', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Merge pull request' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await settle(page)
    await dialog.getByRole('button', { name: 'Refresh what GitHub reports' }).click()

    // Before the run: what GitHub reports for earlier requests, with one pull request
    // still running a request.
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toBeVisible()
    await expect(dialog.getByText('Merged on GitHub as 4444444444')).toBeVisible()

    // Held open, so the state the run itself publishes is observed rather than raced past.
    await page.evaluate(() => window.fixture.hold('runAction'))
    await dialog.getByRole('button', { name: 'Merge pull request', exact: true }).last().click()
    const runningMessage = dialog.getByRole('region', { name: /^Merge result/ })
    await expect(runningMessage).toBeVisible()
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toHaveCount(0)

    await releaseDoubleCalls(page, 'runAction')
    await expect(runningMessage).toBeVisible()
    await expect(dialog.getByText('GitHub could not be read:', { exact: false })).toBeVisible()
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toHaveCount(0)
    await expect(dialog.getByText('Completed', { exact: true })).toHaveCount(0)

    // A later read is still what GitHub reports, and the control that asks for it is
    // reachable the whole time.
    await dialog.getByRole('button', { name: 'Refresh what GitHub reports' }).click()
    await expect(runningMessage).toHaveCount(0)
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toBeVisible()
    await expect(dialog.getByText('Merged on GitHub as 4444444444')).toBeVisible()
  })

  test('an idle merge dialog reads the replacement account without submitting another merge', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-authenticated' })
    await openManagePullRequestDialog(page)
    await page.getByRole('button', { name: 'Preview merge', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Merge pull request' })
    await expect(dialog.getByText('has not reported a result yet').first()).toBeVisible()
    await dialog.getByRole('button', { name: 'Refresh what GitHub reports' }).click()
    await publishCliStatus(page, {
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement',
      version: '2.62.0',
      identity: 'cli:github.com:replacement:1',
      message: null,
    })
    // This authority's first journal read fails. Retired account facts cannot
    // stand in for a successful replacement-account read; retry is explicit.
    await expect(dialog.getByRole('alert')).toContainText('GitHub is unreachable')
    await dialog.getByRole('button', { name: 'Refresh what GitHub reports' }).click()
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toBeVisible()
    await expect(dialog.getByText('Merged on GitHub as 4444444444')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Refresh what GitHub reports' })).toBeEnabled()
    expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  })

  test('a refused merge stays failed on reopen, with the reason GitHub gave', async ({ page }) => {
    await openGallery(page, { scenario: 'pull-requests-merge-refused' })
    await openManagePullRequestDialog(page, 'feature/lifecycle-open')
    await page.getByRole('button', { name: 'Preview merge', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Merge pull request' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await settle(page)
    // A terminal `failed` result never changes, so a reopened dialog has to present the
    // refusal as the failure it is, still carrying GitHub's own reason. `InlineAlert` only
    // carries `role="alert"` for an error tone, so this also proves the refusal is presented
    // as an error rather than as the success a fallback would have produced.
    const refusal = dialog
      .getByRole('region', { name: /^What GitHub reports now/ })
      .getByRole('alert')
    await expect(refusal).toContainText('Required review is missing')
    await expect(dialog.getByText('failed', { exact: true })).toBeVisible()

    // A later read must not erase the refusal, even when that read fails.
    await dialog.getByRole('button', { name: 'Refresh what GitHub reports' }).click()
    await expect(refusal).toContainText('Required review is missing')
  })
})

test('a merge that landed one captured target stays partial when a later target fails', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'github-cli-authenticated' })
  await openManagePullRequestDialog(page)
  await page.getByRole('button', { name: 'Preview merge', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Merge pull request' })
  await expect(dialog.getByText('has not reported a result yet').first()).toBeVisible()
  await page.evaluate(() => window.fixture.hold('runAction'))
  await dialog.getByRole('button', { name: 'Merge pull request', exact: true }).last().click()
  await page.evaluate(() => {
    window.fixture.pushMergeProgress({
      scope: window.fixture.operationScope(),
      source: 'action',
      progress: {
        action: 'default',
        status: 'failed',
        message: 'First target merged; the second target was refused.',
        layers: [
          {
            branch: 'feature/checkout',
            pullRequest: 40,
            status: 'merged',
            detail: 'Merged on GitHub as 4444444444',
            mergedOid: '4444444444444444444444444444444444444444',
            queue: null,
            requestUuid: 'landed-target',
          },
          {
            branch: 'feature/checkout-tests',
            pullRequest: 41,
            status: 'failed',
            detail: 'Required review is missing',
            mergedOid: null,
            queue: null,
            requestUuid: 'refused-target',
          },
        ],
      },
    })
    window.fixture.failNext('mergeStatus', 'Readback unavailable')
  })
  await releaseDoubleCalls(page, 'runAction')
  await expect(dialog.getByText('Partially completed', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Not applied', { exact: true })).toHaveCount(0)
  await expect(dialog).toContainText('Merged on GitHub as 4444444444')
  await expect(dialog).toContainText('Required review is missing')
  expect(await page.evaluate(() => window.fixture.actions)).toHaveLength(1)
})

async function openCapturedRecovery(page: Page) {
  await selectBranchInList(page, 'feature/checkout')
  await page.getByRole('button', { name: 'Operations and recovery', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Repository-qualified operations and recovery',
    exact: true,
  })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Capture selected directory for recovery' }).click()
  const recovery = dialog.getByRole('region', { name: 'Remote operation recovery' })
  await expect(recovery).toBeVisible()
  return { dialog, recovery }
}

test('recovery reads only an explicitly captured directory and browsing never replays a mutation', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'github-cli-authenticated' })
  const { dialog, recovery } = await openCapturedRecovery(page)
  await expect(recovery).toContainText('has not reported a result yet')
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await page.evaluate(() => {
    window.fixture.pushMergeProgress({
      scope: window.fixture.operationScope(),
      source: 'action',
      progress: {
        action: 'default',
        status: 'failed',
        message: 'Captured outcomes arrived while recovery was closed',
        layers: [
          {
            branch: 'feature/checkout-tests',
            pullRequest: 41,
            status: 'merged',
            detail: 'Confirmed by the captured producer',
            mergedOid: '4444444444444444444444444444444444444444',
            queue: null,
            requestUuid: 'closed-recovery',
          },
        ],
      },
    })
  })
  for (const destination of ['activity', 'attention', 'pullRequests', 'branches'] as const) {
    await switchDestination(page, destination)
    expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  }
  await selectBranchInList(page, 'feature/checkout')
  await page.getByRole('button', { name: 'Operations and recovery', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(recovery).toBeVisible()
  await expect(recovery).toContainText('Captured outcomes arrived while recovery was closed')
  await page.evaluate(() =>
    window.fixture.failNext('mergeStatus', 'Journal is temporarily unavailable'),
  )
  await recovery.getByRole('button', { name: 'Refresh merge outcomes', exact: true }).click()
  await expect(recovery).toContainText('Recovery read unavailable')
  await expect(recovery).toContainText('Confirmed by the captured producer')
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
})

test('a retired producer cannot replace outcomes for the explicitly captured directory', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'github-cli-authenticated' })
  const { recovery } = await openCapturedRecovery(page)
  await page.evaluate(() => {
    const scope = window.fixture.operationScope()
    const progress = {
      action: 'default' as const,
      status: 'running' as const,
      message: 'Current captured merge',
      layers: [
        {
          branch: 'feature/checkout-tests',
          pullRequest: 41,
          status: 'pending' as const,
          detail: 'Current authority owns this request',
          mergedOid: null,
          queue: null,
          requestUuid: 'current',
        },
      ],
    }
    window.fixture.pushMergeProgress({ scope, source: 'action', progress })
    const retired = { ...scope, authority: `${scope.authority}-retired` }
    window.fixture.pushMergeProgress({
      scope: retired,
      source: 'action',
      progress: { ...progress, message: 'Retired merge must not appear' },
    })
    window.fixture.pushMergeProgress({ scope: retired, source: 'action', progress: null })
  })
  await expect(recovery).toContainText('Current captured merge')
  await expect(recovery).not.toContainText('Retired merge must not appear')
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
})

test('a recovery journal read failure stays visible without retrying a mutation', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'github-cli-authenticated' })
  await selectBranchInList(page, 'feature/checkout')
  await page.evaluate(() => {
    window.fixture.failNext('mergeStatus', 'Initial recovery unavailable')
  })
  await page.getByRole('button', { name: 'Operations and recovery', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Repository-qualified operations and recovery' })
  await dialog.getByRole('button', { name: 'Capture selected directory for recovery' }).click()
  await expect(dialog).toContainText('Recovery read unavailable')
  await expect(dialog.getByText('Completed', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
})
test('captured publication survives a failed journal read without replay', async ({ page }) => {
  await openGallery(page, { scenario: 'github-cli-authenticated' })
  await page.evaluate(() => window.fixture.hold('submitStackProgress'))
  const { dialog, recovery } = await openCapturedRecovery(page)
  await page.evaluate(() => {
    window.fixture.pushPublication({
      scope: window.fixture.operationScope(),
      source: 'action',
      progress: {
        operationId: 'captured-shell-publication',
        status: 'failed',
        message: 'Captured remote update was refused',
        resumeAt: 0,
        allowForce: true,
        layers: [
          {
            branch: 'feature/checkout-tests',
            base: 'main',
            oid: 'a'.repeat(40),
            baseOid: 'b'.repeat(40),
            remoteOid: 'c'.repeat(40),
            push: 'force',
            create: false,
            pullRequest: 41,
            title: 'Captured title',
            body: 'Captured body',
            draft: true,
            updateBase: false,
            force: true,
            createIntent: false,
          },
        ],
        steps: [
          {
            kind: 'push',
            branch: 'feature/checkout-tests',
            label: 'Captured push feature/checkout-tests',
            status: 'failed',
            pullRequest: null,
            detail: '',
            failure: {
              summary: 'Remote refused update',
              recovery: 'Read before retrying',
              retryable: true,
            },
          },
        ],
      },
    })
  })
  await expect(recovery).toContainText('Captured remote update was refused')
  await page.evaluate(() => {
    window.fixture.failNext('submitStackProgress', 'Recovery transport unavailable')
    window.fixture.release('submitStackProgress')
  })
  await expect(recovery).toContainText('Captured remote update was refused')
  await recovery.getByRole('button', { name: 'Review publication recovery' }).click()
  const publication = page.getByRole('dialog', { name: 'Publish stack', exact: true })
  await expect(publication).toContainText('Captured push feature/checkout-tests')
  await expect(publication).toContainText('Original operation authority was not recorded')
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  await expect(dialog).toBeVisible()
})
