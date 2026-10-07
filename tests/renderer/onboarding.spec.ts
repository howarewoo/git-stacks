import { expect, test } from '@playwright/test'
import {
  answerNextDoubleCall,
  holdDoubleCall,
  openGallery,
  releaseDoubleCalls,
  settle,
} from './helpers/gallery'

test.describe('Onboarding and repository discovery', () => {
  test('displays detected Git environment facts and standard Git explanation', async ({ page }) => {
    await openGallery(page, { scenario: 'shell-no-repository' })
    await settle(page)

    // Standard Git explanation is clearly visible
    await expect(
      page.getByText(
        'A repository stays ordinary Git: clone it here, then keep using it in your terminal, your editor, or GitHub Desktop.',
      ),
    ).toBeVisible()

    // Environment detection facts are rendered
    await expect(page.getByText('Ada Lovelace <ada@example.invalid>')).toBeVisible()
    await expect(page.getByText('main', { exact: true })).toBeVisible()
    await expect(page.getByText('Credential helper: osxkeychain')).toBeVisible()
    await expect(page.getByText('ssh client on PATH (OpenSSH 9.8p1)')).toBeVisible()

    // Primary action buttons are available
    await expect(page.getByRole('button', { name: 'Search GitHub', exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Add local repository', exact: true }),
    ).toBeVisible()

    // Visual proof of the onboarding empty state pane
    await page.screenshot({ path: 'test-results/onboarding-pane.png' })
  })

  test('searches accessible repositories, previews commands, and handles clone collisions and cancellation', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-no-repository' })
    await settle(page)

    // Open clone dialog
    await page.getByRole('button', { name: 'Search GitHub', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Clone from GitHub' })
    await expect(dialog).toBeVisible()

    // Default repository list loaded from GitHub
    await expect(dialog.getByText('howarewoo/git-stacks')).toBeVisible()
    await expect(dialog.getByText('acme/widgets')).toBeVisible()

    // Search for an empty repository
    const searchInput = dialog.getByPlaceholder('Name, owner, or description')
    await searchInput.fill('empty-repo')
    await dialog.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(dialog.getByText('acme/empty-repo')).toBeVisible()
    await expect(dialog.getByText('Empty', { exact: true })).toBeVisible()

    // Select the empty repository to view clone details
    await dialog.getByText('acme/empty-repo').click()
    await expect(
      dialog.getByText(
        'This repository has no commits yet. The clone succeeds and your first branch starts from nothing.',
      ),
    ).toBeVisible()
    // Choose destination folder to enable clone and display command preview
    await dialog.getByRole('button', { name: 'Choose folder', exact: true }).click()

    // Verify command preview displays both git and gh commands
    await expect(
      dialog.getByText('git clone https://github.com/acme/empty-repo.git', { exact: false }),
    ).toBeVisible()
    await expect(dialog.getByText('gh repo clone acme/empty-repo', { exact: false })).toBeVisible()

    // Visual proof of the clone dialog with command previews and empty repo guidance
    await page.screenshot({ path: 'test-results/onboarding-clone-flow.png' })

    // Protocol switch updates commands. The SSH target is quoted the way the
    // main process quotes any word a shell would read differently, so the copy
    // here is the command a clone would actually run.
    await dialog.getByRole('button', { name: 'SSH', exact: true }).click()
    await expect(
      dialog.getByText("git clone 'git@github.com:acme/empty-repo.git'", { exact: false }),
    ).toBeVisible()

    // Destination collision handling
    const folderInput = dialog.getByLabel('Folder', { exact: true })
    await folderInput.fill('collision')
    await dialog.getByRole('button', { name: 'Clone repository', exact: true }).click()
    await expect(
      dialog.getByText('collision already exists in that folder. Choose another name.'),
    ).toBeVisible()

    // Search error handling (e.g. SSO denial)
    await searchInput.fill('sso-error')
    await dialog.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(dialog.getByText('This organization requires single sign-on.')).toBeVisible()

    // Close clone dialog
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('a running clone keeps repository selection and dialog dismissal locked', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-no-repository' })
    await page.getByRole('button', { name: 'Search GitHub', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Clone from GitHub' })
    const repository = dialog.getByRole('button').filter({ hasText: 'howarewoo/git-stacks' })
    await repository.click()
    await dialog.getByRole('button', { name: 'Choose folder', exact: true }).click()
    await holdDoubleCall(page, 'cloneRepository')
    await dialog.getByRole('button', { name: 'Clone repository', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Cancel clone', exact: true })).toBeVisible()
    await expect(repository).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel clone', exact: true }).click()
    await answerNextDoubleCall(page, 'cloneRepository', {
      ok: false,
      failure: { reason: 'cancelled', message: 'Clone cancelled.' },
    })
    await releaseDoubleCalls(page, 'cloneRepository')
    await expect(repository).toBeEnabled()
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expect(dialog).toBeHidden()
  })

  test('cancelling a replacement search preserves the last confirmed repository list', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-no-repository' })
    await page.getByRole('button', { name: 'Search GitHub', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Clone from GitHub' })
    await expect(dialog.getByText('howarewoo/git-stacks')).toBeVisible()
    await holdDoubleCall(page, 'searchRepositories')
    await dialog.getByPlaceholder('Name, owner, or description').fill('a replacement search')
    await dialog.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await answerNextDoubleCall(page, 'searchRepositories', {
      ok: false,
      failure: { reason: 'cancelled', message: 'Search cancelled.' },
    })
    await releaseDoubleCalls(page, 'searchRepositories')
    await expect(dialog.getByRole('button', { name: 'Search', exact: true })).toBeEnabled()
    await expect(dialog.getByText('howarewoo/git-stacks')).toBeVisible()
    await expect(dialog.getByText('acme/widgets')).toBeVisible()
    await expect(dialog.getByText('No repositories to show')).toHaveCount(0)
  })

  test('clipboard refusal is visible and copy confirmation belongs to the current command', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      let attempt = 0
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {
            if (attempt++ === 0) throw new DOMException('Clipboard denied', 'NotAllowedError')
          },
        },
      })
    })
    await openGallery(page, { scenario: 'shell-no-repository' })
    await page.getByRole('button', { name: 'Search GitHub', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Clone from GitHub' })
    await dialog.getByRole('button').filter({ hasText: 'howarewoo/git-stacks' }).click()
    await dialog.getByRole('button', { name: 'Choose folder', exact: true }).click()
    const copy = dialog.getByRole('button', { name: 'Copy the git clone command', exact: true })
    await copy.click()
    await expect(
      dialog.getByText('Clipboard unavailable. Select and copy the command.'),
    ).toBeVisible()
    await expect(copy).toHaveText('Copy')
    await copy.click()
    await expect(copy).toHaveText('Copied')
    await expect(
      dialog.getByText('Clipboard unavailable. Select and copy the command.'),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'SSH', exact: true }).click()
    await expect(dialog.locator('.onboarding-command-text').first()).toContainText(
      'git@github.com:',
    )
    await expect(copy).toHaveText('Copy')
  })

  test('adding an existing repository and drag-and-drop triggers repository registration', async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'shell-no-repository' })
    await settle(page)

    // Drag-and-drop folder triggers addRepository via preload event
    await page.evaluate(() => {
      window.fixture.dropRepository?.(['/mock/path/dropped-repo'])
    })

    // Fixture records addRepository call
    const calls = await page.evaluate(() => window.fixture.calls)
    const addCalls = calls.filter((c) => c.call === 'addRepository')
    expect(addCalls.length).toBeGreaterThanOrEqual(1)
  })
})
