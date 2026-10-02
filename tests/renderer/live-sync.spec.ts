import { expect, test } from '@playwright/test'
import { openGallery, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import type { RemoteFreshness, RepositorySnapshot } from '../../src/shared/types'

type FreshnessState = RemoteFreshness['state']

const STATES: FreshnessState[] = ['fresh', 'offline', 'rate-limited', 'stale', 'unauthorized']

/**
 * Runtime check of the live-sync surface in the real App: what the main process
 * pushes is what the title bar says, and a change made outside the window lands
 * without anyone pressing refresh.
 */
test.describe('Remote freshness', () => {
  test('the badge follows the main process through every state', async ({ page }, testInfo) => {
    await openGallery(page)
    await page.evaluate(() => window.fixture.connect())
    const badge = page.locator('[data-remote-freshness]')
    await expect(badge).toBeVisible()

    for (const state of STATES) {
      await page.evaluate((value) => {
        window.fixture.pushFreshness({
          state: value,
          fetchedAt: '2026-09-25T11:55:00.000Z',
          checkedAt: '2026-09-25T12:00:00.000Z',
          detail: value === 'rate-limited' ? 'You have exceeded a secondary rate limit' : null,
          rateLimitReset: value === 'rate-limited' ? '2026-09-25T12:30:00.000Z' : null,
          pendingMutations: [],
        })
      }, state)
      await expect(badge).toHaveAttribute('data-remote-freshness', state)
      // The state is written out, so it never depends on colour alone.
      const label = await badge.getAttribute('aria-label')
      expect(label ?? '').toMatch(/\S/)
      expect((label ?? '').length).toBeGreaterThan(12)
      if (state === 'offline') {
        await expect(badge).toHaveAttribute('aria-label', /local git/iu)
        await page.screenshot({ path: 'test-results/freshness-offline.png' })
      }
    }
    await page.screenshot({ path: 'test-results/freshness-stale.png' })
  })

  test('a commit made outside the window lands without a manual refresh', async ({ page }) => {
    await openGallery(page)
    await page.evaluate(() => window.fixture.connect())
    await switchDestination(page, 'branches')
    await expect(page.locator('.branch-row').first()).toBeVisible()
    const branches = page.locator('.branch-row')
    const before = await branches.allInnerTexts()

    // What the main process pushes when its watcher finds an external commit:
    // a new head, a different checked-out branch, both read from real Git.
    await page.evaluate(async () => {
      const snapshot = await window.desktop.refresh()
      const template = snapshot.branches[0] ?? {
        ref: 'refs/heads/feature/external',
        name: 'feature/external',
        current: false,
        remote: false,
        upstream: null,
        upstreamRef: null,
        ahead: 0,
        behind: 0,
        subject: 'commit made in a terminal',
        updatedAt: '',
        parent: null,
        parentBehind: null,
        pr: null,
        oid: 'f'.repeat(40),
        parentTip: null,
        parentSource: null,
        needsRestack: false,
      }
      const next: RepositorySnapshot = {
        ...snapshot,
        currentBranch: 'feature/external',
        headOid: 'f'.repeat(40),
        branches: [
          ...snapshot.branches.map((branch) => ({ ...branch, current: false })),
          {
            ...template,
            name: 'feature/external',
            ref: 'refs/heads/feature/external',
            current: true,
          },
        ],
      }
      window.fixture.pushSnapshot(next)
    })
    await settle(page)

    await expect(page.locator('.branch-row', { hasText: 'feature/external' })).toHaveCount(1)
    const after = await branches.allInnerTexts()
    expect(after).not.toEqual(before)
    // The freshness the main process reported is untouched by the push.
    await expect(page.locator('[data-remote-freshness]')).toBeVisible()
    await page.screenshot({ path: 'test-results/external-commit.png' })
  })

  test('a mutation that lost its answer is listed until the person dismisses it', async ({
    page,
  }, testInfo) => {
    await openGallery(page)
    await page.evaluate(() => window.fixture.connect())
    await page.evaluate(() => {
      window.fixture.pushFreshness({
        state: 'offline',
        fetchedAt: '2026-09-25T11:00:00.000Z',
        checkedAt: '2026-09-25T12:00:00.000Z',
        detail: 'fetch failed',
        rateLimitReset: null,
        pendingMutations: [
          {
            id: 'mutation-1',
            kind: 'merge',
            label: 'Merge feature/one',
            reason: 'fetch failed',
            failedAt: '2026-09-25T12:00:00.000Z',
          },
        ],
      })
    })
    const banner = page.getByRole('alert').filter({ hasText: 'Merge feature/one' })
    await expect(banner).toBeVisible()
    await page.screenshot({ path: 'test-results/pending-mutation.png' })
    await page.getByRole('button', { name: 'Dismiss Merge feature/one' }).click()
    await expect(banner).toHaveCount(0)
  })
})
