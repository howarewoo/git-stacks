import { expect, test } from '@playwright/test'
import { openGallery, settle } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import type { RepositorySnapshot } from '@git-stacks/shared/types'

test.describe('Observed repository updates', () => {
  test('a commit made outside the window lands without a manual refresh', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-connected' })
    await switchDestination(page, 'branches')
    await expect(page.locator('.bw-lane-row').first()).toBeVisible()
    const branches = page.locator('.bw-lane-row')
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
            oid: 'f'.repeat(40),
            parent: null,
            pr: null,
          },
        ],
      }
      window.fixture.pushSnapshot(next)
    })
    await settle(page)

    const external = page.getByRole('button', { name: 'feature/external', exact: true })
    await expect(external).toBeVisible()
    const after = await branches.allInnerTexts()
    expect(after).not.toEqual(before)
    await external.click()
    const inspector = page.getByRole('complementary', { name: 'Selected branch details' })
    await expect(inspector).toContainText('fffffff')
  })
})
