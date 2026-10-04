import { expect, type Locator, type Page, test } from '@playwright/test'
import { answerNextDoubleCall, getDoubleCalls, openGallery, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { reviewFileSet, textFile } from './fixtures/review'
import type { ReviewFile, ReviewFileSet } from '../../src/shared/review'
import { LIST_PAGE_SIZE } from '../../src/shared/performance'

/**
 * What the diff surface shows a reviewer, proven against the real component tree.
 *
 * Two files break the assumptions the ordinary cases make. A deleted file has
 * nothing on the head, so every addressable line in it belongs to the base. A
 * generated file is longer than the window mounts, so what a reader sees depends
 * on how much of it has been revealed — and a row that only appears after the
 * window slides still has to name the line it is showing.
 */

const NUMBER = 42
const HEAD_OID = '4242424242424242424242424242424242424242'
const GENERATED_LINES = 1200

/**
 * Rows the whole file needs: one per generated line, plus the hunk header that
 * opens them. The fixture runs past three pages of the shared budget, so a
 * reveal can be watched sliding rather than only growing.
 */
const TOTAL_ROWS = GENERATED_LINES + 1

/**
 * The fixture pull request's own file set with `extra` beside it. The comparison
 * is left as the scenario reports it, because the conversation read is answered
 * for that head and a mismatch would be reported instead of shown.
 */
function withFiles(extra: readonly ReviewFile[]): ReviewFileSet {
  const base = reviewFileSet(NUMBER, HEAD_OID)
  const files = [...base.files, ...extra]
  return {
    ...base,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}

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

async function openReview(page: Page, extra: readonly ReviewFile[]): Promise<void> {
  await openGallery(page, { scenario: 'review-stacked' })
  await answerNextDoubleCall(page, 'reviewFiles', withFiles(extra))
  await switchDestination(page, 'review')
  await settle(page)
}

/**
 * The line numbers the mounted rows address, read off the gutter each one offers
 * to comment on. A row that only looks like the right line is caught here: the
 * number the reader can act on is the number the surface prints.
 */
async function mountedLines(region: Locator): Promise<string[]> {
  return region
    .locator('.review-line-gutter')
    .evaluateAll((elements) => elements.map((element) => element.textContent ?? ''))
}

/** The first and last line number the mounted rows offer to comment on. */
async function mountedEnds(region: Locator): Promise<[string, string]> {
  const labels = await mountedLines(region)
  return [labels[0], labels.at(-1) ?? '']
}

test.describe('The review diff surface', () => {
  test('a deleted file is shown on the base, and the comment written on it is too', async ({
    page,
  }) => {
    await openReview(page, [deletedFile])

    const row = page.getByRole('button', { name: /^src\/legacy\/feature-gate\.ts, /u })
    await row.click()
    await settle(page)
    await expect(row).toHaveAttribute('aria-current', 'true')

    // Nothing of a deleted file survives on the head, so every gutter names the
    // base line it is showing and there is no head-side gutter to name instead.
    const diff = page.getByRole('region', { name: /rows shown/u })
    await expect(diff).toBeVisible()
    expect(await mountedLines(diff)).toEqual(['12', '13', '14', '15'])
    expect(
      await page
        .getByRole('button', { name: /^Comment on src\/legacy\/feature-gate\.ts/u })
        .count(),
    ).toBe(4)
    expect(
      await page.getByRole('button', { name: /feature-gate\.ts line \d+ on the head/u }).count(),
    ).toBe(0)

    // Choosing a line of a deletion chooses the base line, and the sentence the
    // reviewer types is journalled against that same base address.
    await page
      .getByRole('button', { name: 'Comment on src/legacy/feature-gate.ts line 14 on the base' })
      .click()
    await expect(page.locator('.review-conversation')).toContainText(
      'src/legacy/feature-gate.ts:14 (base)',
    )
    await page.getByRole('button', { name: 'Add pending comment' }).click()
    await page
      .getByRole('textbox', { name: 'Comment on src/legacy/feature-gate.ts:14 (base)' })
      .fill('What replaced this gate?')
    await settle(page)

    const journalled = (await getDoubleCalls(page)).filter(
      (entry) => entry.call === 'reviewSetDrafts',
    )
    expect(journalled.length).toBeGreaterThan(0)
    const record = journalled.at(-1)?.args[0] as {
      drafts: Array<{ body: string; ref: { path: string; line: number; side: string } }>
    }
    expect(record.drafts).toHaveLength(1)
    expect(record.drafts[0].body).toBe('What replaced this gate?')
    expect(record.drafts[0].ref).toMatchObject({
      path: 'src/legacy/feature-gate.ts',
      line: 14,
      side: 'base',
    })
  })

  test('a huge diff stays bounded, and revealing more keeps every mounted row on the line it names', async ({
    page,
  }) => {
    await openReview(page, [generatedFile])

    await page.getByRole('button', { name: /^src\/generated\/manifest\.ts, /u }).click()
    await settle(page)

    // The surface is measured through the rows it shows and the share of the
    // file it admits to, never through the size of a page: the budget belongs to
    // the project, so these expectations hold if the budget moves.
    const diff = page.getByRole('region', { name: /rows shown/u })
    await expect(diff).toBeVisible()
    const shown = async (): Promise<{ mounted: number; total: number }> => {
      const counts = /(\d+) of (\d+)/u.exec((await diff.getAttribute('aria-label')) ?? '')
      return { mounted: Number(counts?.[1]), total: Number(counts?.[2]) }
    }

    // One page is mounted, and it is the start of the file.
    expect(await shown()).toEqual({ mounted: LIST_PAGE_SIZE, total: TOTAL_ROWS })
    expect(await mountedEnds(diff)).toEqual(['1', String(LIST_PAGE_SIZE - 1)])
    expect(await mountedLines(diff)).toHaveLength(LIST_PAGE_SIZE - 1)
    expect(await diff.locator('.diff-hunk').count()).toBe(1)

    // Revealing once more extends the same window, still from the top.
    await page.getByRole('button', { name: /more diff rows/u }).click()
    await settle(page)
    expect(await shown()).toEqual({ mounted: LIST_PAGE_SIZE * 2, total: TOTAL_ROWS })
    expect(await mountedEnds(diff)).toEqual(['1', String(LIST_PAGE_SIZE * 2 - 1)])

    // Revealing again slides the window instead of growing it: the hunk header
    // it opened with is left behind, and what is mounted is the next stretch of
    // the file, numbered as the file numbers it.
    await page.getByRole('button', { name: /more diff rows/u }).click()
    await settle(page)
    expect(await shown()).toEqual({ mounted: LIST_PAGE_SIZE * 2, total: TOTAL_ROWS })
    expect(await mountedEnds(diff)).toEqual([
      String(LIST_PAGE_SIZE),
      String(LIST_PAGE_SIZE * 3 - 1),
    ])
    expect(await mountedLines(diff)).toHaveLength(LIST_PAGE_SIZE * 2)
    expect(await diff.locator('.diff-hunk').count()).toBe(0)

    // Every mounted line of an added file is offered on the head, by the number
    // the file numbers it.
    const sides = await diff
      .locator('.review-line-gutter')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('aria-label') ?? ''),
      )
    expect(sides.every((label) => label.endsWith(' on the head'))).toBe(true)
    expect(sides[0]).toBe(`Comment on src/generated/manifest.ts line ${LIST_PAGE_SIZE} on the head`)

    // A row that only exists once the window has slid still offers the line it
    // is showing, and choosing it comments on that line of that file.
    await page
      .getByRole('button', {
        name: `Comment on src/generated/manifest.ts line ${LIST_PAGE_SIZE} on the head`,
      })
      .click()
    await expect(page.locator('.review-conversation')).toContainText(
      `src/generated/manifest.ts:${LIST_PAGE_SIZE} (head)`,
    )

    // Walking back returns the window to the stretch it came from.
    await page.getByRole('button', { name: /previous diff rows/u }).click()
    await settle(page)
    expect(await shown()).toEqual({ mounted: LIST_PAGE_SIZE * 2, total: TOTAL_ROWS })
    expect(await mountedEnds(diff)).toEqual(['1', String(LIST_PAGE_SIZE * 2 - 1)])
  })
})
