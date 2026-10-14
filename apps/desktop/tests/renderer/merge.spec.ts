import { expect, test } from '@playwright/test'
import { openGallery, publishCliStatus, releaseDoubleCalls, settle } from './helpers/gallery'
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
    await page.getByRole('button', { name: 'Preview PR merge', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Merge pull request' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await settle(page)

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
    await page.getByRole('treeitem', { name: /^feature\/checkout-tests,/ }).click()
    await page.getByRole('button', { name: 'Preview PR merge', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Merge pull request' })
    await expect(dialog.getByText('has not reported a result yet').first()).toBeVisible()
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
    await page.getByRole('button', { name: 'Preview PR merge', exact: true }).first().click()
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
  await page.getByRole('treeitem', { name: /^feature\/checkout-tests,/ }).click()
  await page.getByRole('button', { name: 'Preview PR merge', exact: true }).first().click()
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

test.describe('Persistent remote recovery in the actual App', () => {
  test('an unrelated origin-host push does not supersede a pending Settings status read', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-cross-host-operation' })
    await expect(page.getByTitle('GitHub CLI status')).toHaveText('GitHub CLI: signed in')
    await page.evaluate(() => {
      window.fixture.serveCliStatus({
        state: 'signed-out',
        host: 'github.com',
        login: null,
        version: '2.62.0',
        identity: null,
        message: 'Public host signed out',
      })
      window.fixture.hold('githubCliStatus')
    })
    await page.getByTitle('GitHub CLI status').click()
    const statusDialog = page.getByRole('dialog', { name: 'GitHub CLI authentication' })
    await expect(statusDialog).toBeVisible()
    await publishCliStatus(page, {
      state: 'authenticated',
      host: 'ghe.example.com',
      login: 'account2',
      version: '2.62.0',
      identity: 'cli:ghe.example.com:account2:1',
      message: null,
    })
    await releaseDoubleCalls(page, 'githubCliStatus')
    await expect(page.getByTitle('GitHub CLI status')).toHaveText('GitHub CLI: signed out')
    await expect(statusDialog).toContainText('github.com')
    await expect(statusDialog).not.toContainText('account2')
  })

  test('a push while origin scope is unresolved retires the pending scope read', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-cross-host-operation' })
    await expect
      .poll(() =>
        page.evaluate(
          () => window.fixture.calls.filter((call) => call.call === 'mergeStatus').length,
        ),
      )
      .toBeGreaterThan(0)
    const retiredScope = await page.evaluate(() => window.fixture.operationScope())
    const before = await page.evaluate(
      () => window.fixture.calls.filter((call) => call.call === 'repositoryOperationScope').length,
    )
    await page.evaluate(async () => {
      window.fixture.hold('repositoryOperationScope')
      const snapshot = await window.desktop.refresh()
      window.fixture.pushSnapshot({
        ...snapshot,
        remoteUrl: 'https://ghe.example.com/octo/git-stacks.git',
      })
    })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.fixture.calls.filter((call) => call.call === 'repositoryOperationScope').length,
        ),
      )
      .toBeGreaterThan(before)
    await publishCliStatus(page, {
      state: 'authenticated',
      host: 'ghe.example.com',
      login: 'account2',
      version: '2.62.0',
      identity: 'cli:ghe.example.com:account2:1',
      message: null,
    })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.fixture.calls.filter((call) => call.call === 'repositoryOperationScope').length,
        ),
      )
      .toBeGreaterThan(before + 1)
    await page.evaluate(() => window.fixture.release('repositoryOperationScope', 'oldest'))
    await expect(page.getByRole('region', { name: 'Remote operation recovery' })).toHaveCount(0)
    await page.evaluate(() => window.fixture.release('repositoryOperationScope', 'newest'))
    await expect
      .poll(() =>
        page.evaluate(
          () => window.fixture.calls.filter((call) => call.call === 'mergeStatus').length,
        ),
      )
      .toBeGreaterThan(1)
    await page.evaluate((scope) => {
      const current = window.fixture.operationScope()
      const progress = {
        action: 'default' as const,
        status: 'running' as const,
        message: 'Replacement origin scope result',
        layers: [],
      }
      window.fixture.pushMergeProgress({ scope: current, source: 'action', progress })
      window.fixture.pushMergeProgress({
        scope: { ...current, authority: scope.authority },
        source: 'action',
        progress: { ...progress, message: 'Retired scope result' },
      })
      window.fixture.pushMergeProgress({
        scope: { ...current, authority: scope.authority },
        source: 'action',
        progress: null,
      })
    }, retiredScope)
    await expect(page.getByRole('region', { name: 'Remote operation recovery' })).toContainText(
      'Replacement origin scope result',
    )
    await expect(page.getByRole('region', { name: 'Remote operation recovery' })).not.toContainText(
      'Retired scope result',
    )
  })

  test('captured publication survives held and failed reads across workspace destinations without replay', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-authenticated' })
    const readsBefore = await page.evaluate(
      () => window.fixture.calls.filter((call) => call.call === 'submitStackProgress').length,
    )
    await page.evaluate(() => window.fixture.hold('submitStackProgress'))
    await publishCliStatus(page, {
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement',
      version: '2.62.0',
      identity: 'cli:github.com:replacement:2',
      message: null,
    })
    await expect
      .poll(() =>
        page.evaluate(
          () => window.fixture.calls.filter((call) => call.call === 'submitStackProgress').length,
        ),
      )
      .toBeGreaterThan(readsBefore)
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
    const recovery = page.getByRole('region', { name: 'Remote operation recovery' })
    await expect(recovery).toContainText('Captured remote update was refused')
    for (const destination of ['attention', 'review', 'activity', 'branches'] as const) {
      await switchDestination(page, destination)
      await expect(recovery).toContainText('Captured push feature/checkout-tests')
      await expect(
        recovery.getByRole('button', { name: 'Review publication recovery' }),
      ).toBeEnabled()
    }
    await page.evaluate(() => {
      window.fixture.failNext('submitStackProgress', 'Recovery transport unavailable')
      window.fixture.release('submitStackProgress')
    })
    await expect(recovery).toContainText('Captured remote update was refused')
    await recovery.getByRole('button', { name: 'Review publication recovery' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Captured push feature/checkout-tests')
    await expect(dialog).toContainText('Original operation authority was not recorded')
    await expect(
      dialog.getByRole('region', { name: 'feature/checkout-tests → main', exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await switchDestination(page, 'branches')
    await recovery.getByRole('button', { name: 'Review publication recovery' }).click()
    await expect(page.getByRole('dialog')).toContainText('Captured push feature/checkout-tests')
    expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  })

  test('an enterprise-origin account retires operation progress without changing public-host Settings', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-cross-host-operation' })
    await expect(page.getByTitle('GitHub CLI status')).toHaveText('GitHub CLI: signed in')
    await expect
      .poll(() =>
        page.evaluate(
          () => window.fixture.calls.filter((call) => call.call === 'mergeStatus').length,
        ),
      )
      .toBeGreaterThan(0)
    const retiredScope = await page.evaluate(() => window.fixture.operationScope())
    expect(retiredScope.authority).toContain(
      'ghe.example.com|ghe.example.com|authenticated|account1|',
    )
    await publishCliStatus(page, {
      state: 'authenticated',
      host: 'ghe.example.com',
      login: 'account2',
      version: '2.62.0',
      identity: 'cli:ghe.example.com:account2:1',
      message: null,
    })
    await page.evaluate((scope) => {
      window.fixture.pushMergeProgress({
        scope: window.fixture.operationScope(),
        source: 'action',
        progress: {
          action: 'default',
          status: 'running',
          message: 'Current captured merge',
          layers: [
            {
              branch: 'feature/checkout-tests',
              pullRequest: 41,
              status: 'pending',
              detail: 'Current authority owns this request',
              mergedOid: null,
              queue: null,
              requestUuid: 'current',
            },
          ],
        },
      })
      window.fixture.pushMergeProgress({
        scope,
        source: 'action',
        progress: {
          action: 'default',
          status: 'running',
          message: 'Retired merge must not appear',
          layers: [
            {
              branch: 'feature/retired',
              pullRequest: 999,
              status: 'pending',
              detail: 'Retired result',
              mergedOid: null,
              queue: null,
              requestUuid: 'retired',
            },
          ],
        },
      })
      window.fixture.pushMergeProgress({ scope, source: 'action', progress: null })
    }, retiredScope)
    const recovery = page.getByRole('region', { name: 'Remote operation recovery' })
    await expect(recovery).toContainText('Current captured merge')
    await expect(recovery).not.toContainText('Retired merge must not appear')
    await expect(recovery).not.toContainText('Retired result')
    for (const destination of ['attention', 'review', 'activity', 'branches'] as const) {
      await switchDestination(page, destination)
      await expect(recovery).toContainText('Current captured merge')
      await expect(recovery).not.toContainText('Retired result')
    }
    await page.evaluate(() =>
      window.fixture.failNext('mergeStatus', 'Recovery reentry unavailable'),
    )
    await recovery.getByRole('button', { name: 'Review merge outcomes' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Current captured merge')
    await expect(dialog).toContainText('Recovery reentry unavailable')
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toHaveCount(0)
    await expect(page.getByTitle('GitHub CLI status')).toHaveText('GitHub CLI: signed in')
    expect(await page.evaluate(() => window.desktop.githubCliStatus!())).toMatchObject({
      host: 'github.com',
      login: 'octo',
      identity: 'cli:github.com:octo:1',
    })
    expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  })

  test('an initial recovery read failure remains visible inside its open modal', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-authenticated' })
    await page.getByRole('treeitem', { name: /^feature\/checkout-tests,/ }).click()
    await page.getByRole('button', { name: 'Preview PR merge', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Merge pull request' })
    await expect(dialog.getByText('has not reported a result yet').first()).toBeVisible()
    await page.evaluate(() => window.fixture.hold('mergeStatus'))
    await publishCliStatus(page, {
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement',
      version: '2.62.0',
      identity: 'cli:github.com:replacement:initial-failure',
      message: null,
    })
    await page.evaluate(() => {
      window.fixture.failNext('mergeStatus', 'Initial recovery unavailable')
      window.fixture.release('mergeStatus')
    })
    await expect(page.getByRole('region', { name: 'Remote operation recovery' })).toContainText(
      'Recovery read unavailable',
    )
    await expect(dialog.getByRole('alert')).toContainText('Initial recovery unavailable')
    await expect(dialog.getByText('Completed', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  })
  test('a retired producer cannot replace current merge outcomes after authority changes', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'github-cli-authenticated' })
    const retiredScope = await page.evaluate(() => window.fixture.operationScope())
    await publishCliStatus(page, {
      state: 'authenticated',
      host: 'github.com',
      login: 'replacement',
      version: '2.62.0',
      identity: 'cli:github.com:replacement:1',
      message: null,
    })
    await page.evaluate((scope) => {
      window.fixture.pushMergeProgress({
        scope: window.fixture.operationScope(),
        source: 'action',
        progress: {
          action: 'default',
          status: 'running',
          message: 'Current captured merge',
          layers: [
            {
              branch: 'feature/checkout-tests',
              pullRequest: 41,
              status: 'pending',
              detail: 'Current authority owns this request',
              mergedOid: null,
              queue: null,
              requestUuid: 'current',
            },
          ],
        },
      })
      window.fixture.pushMergeProgress({
        scope,
        source: 'action',
        progress: {
          action: 'default',
          status: 'running',
          message: 'Retired merge must not appear',
          layers: [
            {
              branch: 'feature/retired',
              pullRequest: 999,
              status: 'pending',
              detail: 'Retired result',
              mergedOid: null,
              queue: null,
              requestUuid: 'retired',
            },
          ],
        },
      })
      window.fixture.pushMergeProgress({ scope, source: 'action', progress: null })
    }, retiredScope)
    const recovery = page.getByRole('region', { name: 'Remote operation recovery' })
    await expect(recovery).toContainText('Current captured merge')
    await expect(recovery).not.toContainText('Retired merge must not appear')
    await expect(recovery).not.toContainText('Retired result')
    for (const destination of ['attention', 'review', 'activity', 'branches'] as const) {
      await switchDestination(page, destination)
      await expect(recovery).toContainText('Current captured merge')
      await expect(recovery).not.toContainText('Retired result')
    }
    await page.evaluate(() =>
      window.fixture.failNext('mergeStatus', 'Recovery reentry unavailable'),
    )
    await recovery.getByRole('button', { name: 'Review merge outcomes' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Current captured merge')
    await expect(dialog).toContainText('Recovery reentry unavailable')
    await expect(dialog.getByText('WHAT GITHUB REPORTS NOW')).toHaveCount(0)
    expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  })
})
