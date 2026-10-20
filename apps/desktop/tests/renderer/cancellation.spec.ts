import { expect, test } from '@playwright/test'
import { COMMAND_CANCELLATION_ATTEMPT } from '@git-stacks/shared/cancellation'
import { openGallery, holdDoubleCall, getDoubleCalls, releaseDoubleCalls } from './helpers/gallery'
import { openRestackDialog } from './helpers/dialogs'
import { switchDestination } from './helpers/destinations'

test('a main-cancelled inspection remains readable while its renderer query is live', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'shell-connected' })
  await holdDoubleCall(page, 'stackPreview')
  const dialog = await openRestackDialog(page)
  await expect
    .poll(async () => (await getDoubleCalls(page)).some((call) => call.call === 'stackPreview'))
    .toBe(true)
  const cancellations = (await getDoubleCalls(page)).filter((call) => call.call === 'cancel')

  // Main can cancel an inspection without aborting the mounted renderer query.
  await page.evaluate(
    (payload) => window.fixture.rejectNext('stackPreview', payload),
    COMMAND_CANCELLATION_ATTEMPT,
  )
  await releaseDoubleCalls(page, 'stackPreview')
  await expect(
    dialog.getByText(COMMAND_CANCELLATION_ATTEMPT.message, { exact: true }),
  ).toBeVisible()
  await expect(dialog).not.toContainText('[object Object]')
  await expect(dialog.getByRole('button', { name: 'Restack stack', exact: true })).toBeDisabled()
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'cancel')).toEqual(
    cancellations,
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).not.toBeVisible()

  const reopened = await openRestackDialog(page)
  await expect(reopened.getByRole('button', { name: 'Restack stack', exact: true })).toBeEnabled()
})

test('review displays main cancellation rather than a provider failure without aborting its signal', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'review-stacked' })
  await holdDoubleCall(page, 'reviewThreads')
  await switchDestination(page, 'review')
  await expect
    .poll(async () => (await getDoubleCalls(page)).some((call) => call.call === 'reviewThreads'))
    .toBe(true)
  const cancellationCalls = () =>
    getDoubleCalls(page).then((calls) =>
      calls.filter(
        (call) => call.call === 'cancel' || (call.call === 'inspect' && call.args[1] === 'cancel'),
      ),
    )
  const before = await cancellationCalls()
  await page.evaluate(
    (payload) => window.fixture.rejectNext('reviewThreads', payload),
    COMMAND_CANCELLATION_ATTEMPT,
  )
  await releaseDoubleCalls(page, 'reviewThreads')
  await expect(page.locator('.review-view')).toContainText(COMMAND_CANCELLATION_ATTEMPT.message)
  await expect(page.locator('.review-view')).not.toContainText('GitHub did not return review data.')
  expect(await cancellationCalls()).toEqual(before)
})
