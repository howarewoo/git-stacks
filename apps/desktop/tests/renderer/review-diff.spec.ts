import { expect, type Locator, type Page, test } from '@playwright/test'
import { answerNextDoubleCall, getDoubleCalls, openGallery, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { reviewFileSet, textFile } from './fixtures/review'
import type { ReviewFile } from '@git-stacks/shared/review'
import { LIST_PAGE_SIZE } from '@git-stacks/shared/performance'

const NUMBER = 42
const HEAD_OID = '4242424242424242424242424242424242424242'
const GENERATED_LINES = 1200

// The hunk header counts toward the mounted row budget.
const TOTAL_ROWS = GENERATED_LINES + 1

const deletedFile = textFile(
  'src/legacy/feature-gate.ts',
  '@@ -12,4 +0,0 @@',
  [
    ['-export const legacyGate = true', 12, null],
    ['-export function gate(name: string): string {', 13, null],
    ['-  return `gate:${name}`', 14, null],
    ['-}', 15, null],
  ],
  { status: 'removed', sha: null },
)

const generatedFile = textFile(
  'src/generated/manifest.ts',
  '@@ -0,0 +1,1200 @@',
  Array.from(
    { length: GENERATED_LINES },
    (_, index) =>
      [`+manifest row ${index + 1}`, null, index + 1] as [string, number | null, number | null],
  ),
  { status: 'added' },
)

async function openReview(page: Page, file: ReviewFile): Promise<void> {
  await openGallery(page, { scenario: 'review-stacked' })
  // Keep the scenario's comparison: the conversation read answers for this head.
  const base = reviewFileSet(NUMBER, HEAD_OID)
  await answerNextDoubleCall(page, 'reviewFiles', {
    ...base,
    files: [...base.files, file],
    additions: base.additions + file.additions,
    deletions: base.deletions + file.deletions,
  })
  await switchDestination(page, 'review')
  await settle(page)
}

async function expectGeneratedWindow(
  diff: Locator,
  first: number,
  last: number,
  hunkCount: number,
): Promise<void> {
  const numbers = Array.from({ length: last - first + 1 }, (_, index) => first + index)
  const gutters = diff.locator('.review-line-gutter')
  await expect(gutters).toHaveText(numbers.map(String))
  await expect(diff.locator('.diff-hunk')).toHaveCount(hunkCount)
  await expect(diff).toHaveAttribute(
    'aria-label',
    new RegExp(`, ${numbers.length + hunkCount} of ${TOTAL_ROWS} rows shown$`, 'u'),
  )
  expect(
    await gutters.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')),
    ),
  ).toEqual(
    numbers.map((number) => `Comment on src/generated/manifest.ts line ${number} on the head`),
  )
}

test.describe('The review diff surface', () => {
  test('a deleted file is shown on the base, and the comment written on it is too', async ({
    page,
  }) => {
    await openReview(page, deletedFile)

    const row = page.getByRole('button', { name: /^src\/legacy\/feature-gate\.ts, /u })
    await row.click()
    await settle(page)
    await expect(row).toHaveAttribute('aria-current', 'true')

    const diff = page.getByRole('region', { name: /rows shown/u })
    await expect(diff).toBeVisible()
    await expect(diff.locator('.review-line-gutter')).toHaveText(['12', '13', '14', '15'])
    await expect(
      diff.getByRole('button', { name: /^Comment on src\/legacy\/feature-gate\.ts/u }),
    ).toHaveCount(4)
    await expect(
      diff.getByRole('button', { name: /feature-gate\.ts line \d+ on the head/u }),
    ).toHaveCount(0)

    // The draft must retain the base address selected in the gutter.
    await page
      .getByRole('button', { name: 'Comment on src/legacy/feature-gate.ts line 14 on the base' })
      .click()
    await expect(page.locator('.review-conversation')).toContainText(
      'src/legacy/feature-gate.ts:14 (base)',
    )
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await page.getByRole('button', { name: 'Add pending comment' }).click()
    await page
      .getByRole('textbox', { name: 'Comment on src/legacy/feature-gate.ts:14 (base)' })
      .fill('What replaced this gate?')
    await settle(page)

    const journalled = (await getDoubleCalls(page)).filter(
      (entry) => entry.call === 'reviewSetDrafts',
    )
    expect(journalled.at(-1)?.args[0]).toMatchObject({
      drafts: [
        {
          body: 'What replaced this gate?',
          ref: { path: 'src/legacy/feature-gate.ts', line: 14, side: 'base' },
        },
      ],
    })
  })

  test('a huge diff stays bounded, and revealing more keeps every mounted row on the line it names', async ({
    page,
  }) => {
    await openReview(page, generatedFile)

    await page.getByRole('button', { name: /^src\/generated\/manifest\.ts, /u }).click()
    await settle(page)

    const diff = page.getByRole('region', { name: /rows shown/u })
    await expect(diff).toBeVisible()
    await expectGeneratedWindow(diff, 1, LIST_PAGE_SIZE - 1, 1)

    await page.getByRole('button', { name: /more diff rows/u }).click()
    await expectGeneratedWindow(diff, 1, LIST_PAGE_SIZE * 2 - 1, 1)

    // The third reveal slides the two-page window past the hunk header.
    await page.getByRole('button', { name: /more diff rows/u }).click()
    await expectGeneratedWindow(diff, LIST_PAGE_SIZE, LIST_PAGE_SIZE * 3 - 1, 0)

    // A line revealed by the sliding window must still select its own address.
    await page
      .getByRole('button', {
        name: `Comment on src/generated/manifest.ts line ${LIST_PAGE_SIZE} on the head`,
      })
      .click()
    await expect(page.locator('.review-conversation')).toContainText(
      `src/generated/manifest.ts:${LIST_PAGE_SIZE} (head)`,
    )

    await page.getByRole('button', { name: /previous diff rows/u }).click()
    await expectGeneratedWindow(diff, 1, LIST_PAGE_SIZE * 2 - 1, 1)
  })
})
