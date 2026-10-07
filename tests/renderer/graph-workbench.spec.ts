import { test, expect } from '@playwright/test'
import { openGallery, getDoubleCalls, STANDARD_VIEWPORTS } from './helpers/gallery'
import { switchDestination } from './helpers/destinations'
import { graphIndex } from './fixtures/graph'
import { scenarios } from './fixtures/scenarios'

const preferenceScope = {
  repositoryPath: scenarios['graph-250'].snapshot!.path,
  host: graphIndex(250).host!,
  repository: graphIndex(250).fullName!,
  account: graphIndex(250).viewer!,
}

test('bounded production outline, keyboard, wide nested endpoints and remote Review selection', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-5000' })
  await switchDestination(page, 'stacks')
  await expect(page.getByRole('status').filter({ hasText: '5000 indexed PRs' })).toBeVisible()
  const rows = page.locator('[data-graph-outline-row]')
  expect(await rows.count()).toBeLessThanOrEqual(64)
  const first = rows.first().locator('button').first()
  await first.focus()
  await first.press('End')
  expect(await rows.count()).toBeLessThanOrEqual(64)
  await expect(page.locator('[data-outline-position]:focus')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('#40')
  await rows.filter({ hasText: '#40 Change 40' }).locator('button').first().click()
  await page.getByText(/Dependent paths ·/).click()
  await page.getByRole('searchbox', { name: 'Search dependent paths' }).fill('#181')
  await page.getByRole('button', { name: '#181 Change 181', exact: true }).click()
  expect(await page.locator('[data-graph-node]').count()).toBeLessThanOrEqual(32)
  await expect(page.locator('[data-graph-node]').filter({ hasText: '#120' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Zoom graph out' }).click()
  await page.evaluate(() => window.fixture.changeGraphPr(40, 'status'))
  await expect(page.locator('.graph-camera')).toContainText('90%')
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('#201')
  await rows.filter({ hasText: '#201 Change 201' }).locator('button').first().click()
  await expect(
    page.getByRole('complementary', { name: 'Selected PR or ref details' }),
  ).toContainText('No actual local branch established')
  const calls = await getDoubleCalls(page)
  expect(calls.filter((call) => call.call === 'runAction')).toHaveLength(0)
  expect(calls.filter((call) => call.call === 'prIndexDetail').length).toBeLessThanOrEqual(6)
  await page.getByRole('button', { name: 'Review #201', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Review/ }).first()).toBeVisible()
})

test('selected outside filter, local-only and remote-only refs remain truthful', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  const search = page.getByRole('searchbox', { name: 'Search indexed PRs' })
  await search.fill('local-only')
  await page
    .locator('[data-graph-outline-row]')
    .filter({ hasText: 'local-only' })
    .locator('button')
    .first()
    .click()
  await search.fill('remote-only')
  await expect(
    page.locator('[data-graph-outline-row]').filter({ hasText: 'local-only' }),
  ).toContainText('Selected · outside active filter')
  await page
    .locator('[data-graph-outline-row]')
    .filter({ hasText: 'remote-only' })
    .locator('button')
    .first()
    .click()
  await expect(
    page.getByRole('complementary', { name: 'Selected PR or ref details' }),
  ).toContainText('Remote ref · no local checkout established')
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toHaveLength(0)
})

test('external retarget invalidates selected facts without moving selection or camera', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('#181')
  await page
    .locator('[data-graph-outline-row]')
    .filter({ hasText: '#181 Change 181' })
    .locator('button')
    .first()
    .click()
  const inspector = page.getByRole('complementary', { name: 'Selected PR or ref details' })
  await expect(inspector).toContainText('graph/change-120')
  await page.getByRole('button', { name: 'Zoom graph in' }).click()
  await page.evaluate(() => window.fixture.changeGraphPr(181, 'base'))
  await expect(inspector.locator('dd').last()).toHaveText('main')
  await expect(inspector.getByRole('button', { name: 'Review #181' })).toBeVisible()
  await expect(page.locator('.graph-camera')).toContainText('110%')
})

for (const colorScheme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(STANDARD_VIEWPORTS)) {
    test(`production panes remain operable ${colorScheme} ${size}`, async ({ page }) => {
      await openGallery(page, { scenario: 'graph-1000', colorScheme, viewport })
      await switchDestination(page, 'stacks')
      await expect(page.getByRole('navigation', { name: 'Repository PR views' })).toBeVisible()
      await page.getByRole('button', { name: 'Current branch', exact: true }).click()
      await expect(
        page.locator('[data-graph-outline-row]').filter({ hasText: 'refs/heads/graph/change-1' }),
      ).toHaveCount(1)
      const toggle = page.getByRole('button', { name: 'Selected details', exact: true })
      if (!(await page.locator('#graph-inspector').isVisible()) && (await toggle.isVisible()))
        await toggle.click()
      await expect(
        page.getByRole('complementary', { name: 'Selected PR or ref details' }),
      ).toBeVisible()
      expect(await page.locator('[data-graph-outline-row]').count()).toBeLessThanOrEqual(64)
      expect(await page.locator('[data-graph-node]').count()).toBeLessThanOrEqual(32)
    })
  }
}

test('partial and unknown viewer states never claim confirmed absence', async ({ page }) => {
  await openGallery(page, { scenario: 'graph-partial' })
  await switchDestination(page, 'stacks')
  await expect(page.locator('.graph-index-status')).toContainText('incomplete')
  await page.evaluate(
    (index) => window.fixture.pushPrIndex({ ...index, viewer: null }),
    graphIndex(250, 'partial'),
  )
  await page.getByRole('button', { name: 'My PRs', exact: true }).click()
  await expect(page.getByText('Signed-in account unknown.', { exact: false })).toBeVisible()
})

test('actual local selection keeps unknown ancestry visible and enters the preserved parent workflow', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  await page.getByRole('button', { name: 'Current branch', exact: true }).click()
  await page
    .locator('[data-graph-outline-row]')
    .filter({ hasText: 'refs/heads/graph/change-1' })
    .locator('button')
    .first()
    .click()
  await expect(
    page.getByRole('complementary', { name: 'Selected PR or ref details' }),
  ).toContainText('Recorded local parent intent')
  const snapshot = scenarios['graph-250'].snapshot!
  await page.evaluate(
    (source) =>
      window.fixture.pushSnapshot({
        ...source,
        branches: source.branches.map((branch) =>
          branch.current
            ? {
                ...branch,
                parentBehind: null,
                needsRestack: false,
                recordedParent: null,
                parentSource: null,
              }
            : branch,
        ),
      }),
    snapshot,
  )
  const inspector = page.getByRole('complementary', { name: 'Selected PR or ref details' })
  await expect(inspector).toContainText('parent comparison unknown')
  await expect(inspector).toContainText('Parent evidence · provenance unknown')
  await inspector.getByRole('button', { name: 'Set parent…', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toHaveLength(0)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Set stack parent', exact: true })
    .click()
  await expect
    .poll(async () =>
      (await getDoubleCalls(page))
        .filter((call) => call.call === 'runAction')
        .map((call) => call.args[0]),
    )
    .toEqual([{ type: 'setParent', branch: 'graph/change-1', parent: 'main' }])
})

test('existing details toolbar and keyboard palette intent control the actual selected graph inspector', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  const toolbar = page.getByRole('region', { name: 'Repository controls' })
  const hide = toolbar.getByRole('button', { name: 'Hide details pane', exact: true })
  await expect(hide).toHaveAttribute('aria-controls', 'graph-inspector')
  await expect(hide).toHaveAttribute('aria-expanded', 'true')
  await hide.click()
  await expect(page.locator('#graph-inspector')).toBeHidden()
  await expect(
    toolbar.getByRole('button', { name: 'Show details pane', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: 'Open command palette', exact: true }).click()
  const input = page.getByRole('combobox', {
    name: 'Search actions, repositories, branches, PRs, issues, and settings',
  })
  await input.fill('Toggle details pane')
  await input.press('Enter')
  await expect(page.locator('#graph-inspector')).toBeVisible()
  await expect(
    toolbar.getByRole('button', { name: 'Hide details pane', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#branch-inspector')).toHaveCount(0)
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toHaveLength(0)
})

test('toolbar and graph text controls share one exact active criterion, including clear', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  const graphSearch = page.getByRole('searchbox', { name: 'Search indexed PRs' })
  const toolbarSearch = page.getByRole('textbox', {
    name: 'Filter current view branches, files, and pull requests',
  })
  await graphSearch.fill('#101')
  await expect(toolbarSearch).toHaveValue('#101')
  await expect(
    page.locator('[data-graph-outline-row]').filter({ hasText: '#101 Change 101' }),
  ).toHaveCount(1)
  await toolbarSearch.fill('#181')
  await expect(graphSearch).toHaveValue('#181')
  await expect(
    page.locator('[data-graph-outline-row]').filter({ hasText: '#181 Change 181' }),
  ).toHaveCount(1)
  await toolbarSearch.fill('')
  await expect(graphSearch).toHaveValue('')
  await expect(page.locator('.graph-outline header')).toContainText('250')
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toHaveLength(0)
})

test('typed preferences save, restore and reset nonempty authored criteria without rerender loss', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  await page.getByText('Saved view preferences', { exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search indexed PRs' })
  const name = page.getByRole('textbox', { name: 'View name', exact: true })
  const collapse = page.getByRole('checkbox', { name: 'Collapse linear runs' })
  await search.fill('#51')
  await page.getByRole('button', { name: 'My PRs', exact: true }).click()
  await collapse.uncheck()
  await name.fill('Authored chain')
  await page.getByRole('button', { name: 'Save view', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeEnabled()
  const preferences = await page.evaluate(() => window.desktop.graphPreferences!())
  expect(preferences).toEqual({
    state: 'ready',
    scope: preferenceScope,
    preferences: {
      preset: 'my-prs',
      text: '#51',
      author: '',
      status: 'all',
      collapse: false,
      name: 'Authored chain',
    },
  })
  await page.evaluate(() => window.fixture.changeGraphPr(51, 'status'))
  await expect(search).toHaveValue('#51')
  await expect(name).toHaveValue('Authored chain')
  await search.fill('#181')
  await name.fill('Unsaved edit')
  await collapse.check()
  await page.getByRole('button', { name: 'All open PRs', exact: true }).click()
  await page.getByRole('button', { name: 'Restore saved view' }).click()
  await expect(search).toHaveValue('#51')
  await expect(name).toHaveValue('Authored chain')
  await expect(collapse).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'My PRs', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Reset saved view' }).click()
  await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeDisabled()
  expect(await page.evaluate(() => window.desktop.graphPreferences!())).toEqual({
    state: 'ready',
    scope: preferenceScope,
    preferences: null,
  })
})

test('late held preference read cannot erase edits or a newer successful save', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-preferences-held' })
  await switchDestination(page, 'stacks')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'graphPreferences').length,
    )
    .toBeGreaterThan(0)
  await page.getByText('Saved view preferences', { exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search indexed PRs' })
  const name = page.getByRole('textbox', { name: 'View name', exact: true })
  await search.fill('#181')
  await name.fill('New authored view')
  await page.getByRole('checkbox', { name: 'Collapse linear runs' }).uncheck()
  await page.getByRole('button', { name: 'Save view', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeEnabled()
  await page.evaluate(() => window.fixture.release('graphPreferences'))
  await expect(search).toHaveValue('#181')
  await expect(name).toHaveValue('New authored view')
  await search.fill('#40')
  await page.getByRole('button', { name: 'Restore saved view' }).click()
  await expect(search).toHaveValue('#181')
})

for (const boundary of ['host', 'repository', 'account', 'unknown-account'] as const) {
  test(`${boundary} boundary retires controlled search, selected facts and saved view even at the same local path`, async ({
    page,
  }) => {
    await openGallery(page, { scenario: 'graph-preferences' })
    await switchDestination(page, 'stacks')
    await page.getByText('Saved view preferences', { exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'View name', exact: true })).toHaveValue(
      'Authored chain',
    )
    const search = page.getByRole('searchbox', { name: 'Search indexed PRs' })
    await page.getByRole('button', { name: 'All open PRs', exact: true }).click()
    await search.fill('#181')
    await page
      .locator('[data-graph-outline-row]')
      .filter({ hasText: '#181 Change 181' })
      .locator('button')
      .first()
      .click()
    await expect(page.getByRole('button', { name: 'Review #181', exact: true })).toBeVisible()
    await page.evaluate(() => window.fixture.hold('saveGraphPreferences'))
    await page.getByRole('button', { name: 'Save view', exact: true }).click()
    const index = graphIndex(250)
    const foreign = {
      ...index,
      host: boundary === 'host' ? 'enterprise.example' : index.host,
      fullName: boundary === 'repository' ? 'foreign/private' : index.fullName,
      viewer:
        boundary === 'account'
          ? 'other-account'
          : boundary === 'unknown-account'
            ? null
            : index.viewer,
      pullRequests: index.pullRequests.map((pr) => ({ ...pr, title: `Foreign body ${pr.number}` })),
    }
    await page.evaluate(
      ({ value, snapshot }) => {
        window.fixture.pushSnapshot({
          ...snapshot,
          remoteUrl: `https://${value.host}/${value.fullName}.git`,
        })
        window.fixture.pushPrIndex(value)
      },
      { value: foreign, snapshot: scenarios['graph-preferences'].snapshot! },
    )
    await expect(search).toHaveValue('')
    await expect(
      page.getByRole('textbox', { name: 'Filter current view branches, files, and pull requests' }),
    ).toHaveValue('')
    await expect(page.getByRole('textbox', { name: 'View name', exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Review #181', exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('complementary', { name: 'Selected PR or ref details' }),
    ).not.toContainText('Foreign body 181')
    expect(await page.evaluate(() => window.desktop.graphPreferences!())).toEqual({
      state: boundary === 'unknown-account' ? 'unavailable' : 'ready',
      preferences: null,
      scope:
        boundary === 'unknown-account'
          ? null
          : {
              ...preferenceScope,
              host: foreign.host,
              repository: foreign.fullName,
              account: foreign.viewer,
            },
      ...(boundary === 'unknown-account'
        ? {
            message:
              'Saved graph preferences require a known current repository and authenticated account.',
          }
        : {}),
    })
    await page.evaluate(() => window.fixture.release('saveGraphPreferences'))
    await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeDisabled()
    await expect(search).toHaveValue('')
  })
}

test('held preference answers and failures use the existing deterministic controls', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  await page.getByText('Saved view preferences', { exact: true }).click()
  await page.getByRole('textbox', { name: 'View name', exact: true }).fill('Retry view')
  await page.evaluate(() => {
    window.fixture.hold('saveGraphPreferences')
    window.fixture.failNext('saveGraphPreferences', 'Preference disk unavailable')
  })
  await page.getByRole('button', { name: 'Save view', exact: true }).click()
  await page.evaluate(() => window.fixture.release('saveGraphPreferences'))
  await expect(
    page.getByRole('status').filter({ hasText: 'Preference disk unavailable' }),
  ).toBeVisible()
  await page.evaluate((scope) => {
    window.fixture.unhold('saveGraphPreferences')
    window.fixture.answerNext('saveGraphPreferences', {
      state: 'ready',
      scope: { ...scope, repository: 'foreign/private' },
      preferences: {
        preset: 'my-prs',
        text: '#51',
        author: '',
        status: 'all',
        collapse: false,
        name: 'Wrong-scope private view',
      },
    })
  }, preferenceScope)
  await page.getByRole('button', { name: 'Save view', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeDisabled()
  await page.evaluate((scope) => {
    window.fixture.unhold('saveGraphPreferences')
    window.fixture.answerNext('saveGraphPreferences', {
      state: 'ready',
      scope,
      preferences: {
        preset: 'all-open',
        text: '#40',
        author: '',
        status: 'all',
        collapse: true,
        name: 'Scripted view',
      },
    })
  }, preferenceScope)
  await page.getByRole('button', { name: 'Save view', exact: true }).click()
  await page.getByRole('button', { name: 'Restore saved view' }).click()
  await expect(page.getByRole('searchbox', { name: 'Search indexed PRs' })).toHaveValue('#40')
})

test('late initial preference read preserves unsaved authored form edits', async ({ page }) => {
  await openGallery(page, { scenario: 'graph-preferences-held' })
  await switchDestination(page, 'stacks')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'graphPreferences').length,
    )
    .toBeGreaterThan(0)
  await page.getByText('Saved view preferences', { exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('#181')
  await page.getByRole('textbox', { name: 'View name', exact: true }).fill('Unsaved authored view')
  await page.getByRole('checkbox', { name: 'Collapse linear runs' }).uncheck()
  // The typed account is already known: adopting the first index must not admit a second read.
  expect(
    (await getDoubleCalls(page)).filter((call) => call.call === 'graphPreferences'),
  ).toHaveLength(1)
  await page.evaluate((scope) => {
    window.fixture.answerNext('graphPreferences', {
      state: 'ready',
      scope: { ...scope, repository: 'foreign/private' },
      preferences: {
        preset: 'my-prs',
        text: '#51',
        author: '',
        status: 'all',
        collapse: false,
        name: 'Wrong-scope private view',
      },
    })
    window.fixture.release('graphPreferences')
  }, preferenceScope)
  await expect(page.getByRole('searchbox', { name: 'Search indexed PRs' })).toHaveValue('#181')
  await expect(page.getByRole('textbox', { name: 'View name', exact: true })).toHaveValue(
    'Unsaved authored view',
  )
  await expect(page.getByRole('checkbox', { name: 'Collapse linear runs' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeDisabled()
})

test('old account held preference read cannot restore its private view after account replacement', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-preferences-held' })
  await switchDestination(page, 'stacks')
  await expect
    .poll(
      async () =>
        (await getDoubleCalls(page)).filter((call) => call.call === 'graphPreferences').length,
    )
    .toBeGreaterThan(0)
  await page.getByText('Saved view preferences', { exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('#181')
  await page.evaluate(
    ({ index, snapshot }) => {
      window.fixture.unhold('graphPreferences')
      window.fixture.publishCliStatus({
        state: 'authenticated',
        host: 'github.com',
        login: 'replacement-account',
        version: '2.62.0',
        identity: 'cli:github.com:replacement-account:2',
        message: null,
      })
      window.fixture.pushSnapshot({
        ...snapshot,
        remoteUrl: 'https://github.com/foreign/private.git',
      })
      window.fixture.pushPrIndex({
        ...index,
        fullName: 'foreign/private',
        viewer: 'replacement-account',
        pullRequests: index.pullRequests.map((pr) => ({
          ...pr,
          url: pr.url.replace('/fixture/graph-workbench/pull/', '/foreign/private/pull/'),
          headRepository:
            pr.headRepository === 'fixture/graph-workbench' ? 'foreign/private' : pr.headRepository,
        })),
      })
      window.fixture.release('graphPreferences', 'oldest')
    },
    { index: graphIndex(250), snapshot: scenarios['graph-preferences-held'].snapshot! },
  )
  await expect(page.getByRole('searchbox', { name: 'Search indexed PRs' })).toHaveValue('')
  await expect(page.getByRole('textbox', { name: 'View name', exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeDisabled()
  const staleWrites = await page.evaluate(async (scope) => {
    const save = await window.desktop.saveGraphPreferences!(
      {
        preset: 'my-prs',
        text: '#51',
        author: '',
        status: 'all',
        collapse: false,
        name: 'Retired account view',
      },
      scope,
    )
    const reset = await window.desktop.resetGraphPreferences!(scope)
    return { save, reset }
  }, preferenceScope)
  expect(staleWrites.save).toMatchObject({ state: 'unavailable', scope: null, preferences: null })
  expect(staleWrites.reset).toMatchObject({ state: 'unavailable', scope: null, preferences: null })
  expect(await page.evaluate(() => window.desktop.graphPreferences!())).toEqual({
    state: 'ready',
    scope: { ...preferenceScope, repository: 'foreign/private', account: 'replacement-account' },
    preferences: null,
  })
  await page.getByRole('textbox', { name: 'View name', exact: true }).fill('New account view')
  await page.getByRole('button', { name: 'Save view', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeEnabled()
  expect(await page.evaluate(() => window.desktop.graphPreferences!())).toMatchObject({
    state: 'ready',
    scope: { ...preferenceScope, repository: 'foreign/private', account: 'replacement-account' },
    preferences: { name: 'New account view', text: '' },
  })
})

test('held save response updates restore target without replacing edits authored while saving', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  await page.getByText('Saved view preferences', { exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search indexed PRs' })
  const name = page.getByRole('textbox', { name: 'View name', exact: true })
  await search.fill('#40')
  await name.fill('Saved forty')
  await page.evaluate(() => window.fixture.hold('saveGraphPreferences'))
  await page.getByRole('button', { name: 'Save view', exact: true }).click()
  await search.fill('#181')
  await name.fill('Still editing')
  await page.evaluate(() => window.fixture.release('saveGraphPreferences'))
  await expect(page.getByRole('button', { name: 'Restore saved view' })).toBeEnabled()
  await expect(search).toHaveValue('#181')
  await expect(name).toHaveValue('Still editing')
  await page.getByRole('button', { name: 'Restore saved view' }).click()
  await expect(search).toHaveValue('#40')
  await expect(name).toHaveValue('Saved forty')
})

test('current-ref inspector uses live indexed draft, author and base while selected detail is held', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  await page.getByRole('button', { name: 'Current branch', exact: true }).click()
  await page
    .locator('[data-graph-outline-row]')
    .filter({ hasText: 'refs/heads/graph/change-1' })
    .locator('button')
    .first()
    .click()
  const inspector = page.getByRole('complementary', { name: 'Selected PR or ref details' })
  await expect(inspector).toContainText('Selected PR detail loaded')
  await page.getByRole('button', { name: 'Zoom graph in' }).click()
  const index = graphIndex(250)
  await page.evaluate((value) => {
    window.fixture.hold('prIndexDetail')
    window.fixture.pushPrIndex({
      ...value,
      pullRequests: value.pullRequests.map((pr) =>
        pr.number === 1
          ? { ...pr, draft: true, author: 'updated-author', base: 'graph/change-20' }
          : pr,
      ),
    })
  }, index)
  await expect(inspector).toContainText('open · draft')
  await expect(inspector).toContainText('@updated-author')
  await expect(inspector.locator('dd').last()).toHaveText('graph/change-20')
  await expect(page.locator('.graph-camera')).toContainText('110%')
  await expect(inspector.getByRole('button', { name: 'Review #1', exact: true })).toBeVisible()
  await page.evaluate(() => window.fixture.release('prIndexDetail'))
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toHaveLength(0)
})

test('indexed retarget rebinds an unrecorded current ref parent and retires its old prerequisites', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  const snapshot = scenarios['graph-250'].snapshot!
  await page.evaluate(
    (source) =>
      window.fixture.pushSnapshot({
        ...source,
        currentBranch: 'graph/change-2',
        branches: source.branches.map((branch) =>
          branch.name === 'graph/change-2'
            ? {
                ...branch,
                current: true,
                recordedParent: null,
                parentSource: 'pullRequest',
                parent: 'graph/change-1',
                parentBehind: 3,
                parentTip: 'old-parent-tip',
                needsRestack: true,
              }
            : { ...branch, current: false },
        ),
      }),
    snapshot,
  )
  await page.getByRole('button', { name: 'Current branch', exact: true }).click()
  const rows = page.locator('[data-graph-outline-row]')
  await rows.filter({ hasText: 'refs/heads/graph/change-2' }).locator('button').first().click()
  const inspector = page.getByRole('complementary', { name: 'Selected PR or ref details' })
  const evidence = inspector.locator('.graph-evidence li')
  await expect(evidence.filter({ hasText: 'GitHub PR base target' }).locator('code')).toHaveText(
    'graph/change-1',
  )
  await expect(rows.filter({ hasText: 'refs/heads/graph/change-1' })).toHaveCount(1)
  await expect(inspector).toContainText('parent comparison 3 commits behind')
  await page.evaluate(
    (index) =>
      window.fixture.pushPrIndex({
        ...index,
        pullRequests: index.pullRequests.map((pr) =>
          pr.number === 2 ? { ...pr, base: 'main' } : pr,
        ),
      }),
    graphIndex(250),
  )
  await expect(evidence.filter({ hasText: 'GitHub PR base target' }).locator('code')).toHaveText(
    'main',
  )
  await expect(rows.filter({ hasText: 'refs/heads/graph/change-1' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'refs/heads/main' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'refs/heads/graph/change-2' })).toHaveCount(1)
  await expect(inspector).toContainText('parent comparison unknown')
  await expect(inspector).not.toContainText('restack required')
  await expect(inspector.getByRole('button', { name: 'Review #2', exact: true })).toBeVisible()
  expect((await getDoubleCalls(page)).filter((call) => call.call === 'runAction')).toHaveLength(0)
})

test('Refresh index requests a real forced source read and keeps qualified selection and camera', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'graph-250' })
  await switchDestination(page, 'stacks')
  await page.getByRole('searchbox', { name: 'Search indexed PRs' }).fill('#181')
  await page
    .locator('[data-graph-outline-row]')
    .filter({ hasText: '#181 Change 181' })
    .locator('button')
    .first()
    .click()
  const inspector = page.getByRole('complementary', { name: 'Selected PR or ref details' })
  await expect(inspector).toContainText('Selected PR detail loaded')
  await page.getByRole('button', { name: 'Zoom graph out' }).click()
  const index = graphIndex(250)
  await page.evaluate(
    (value) =>
      window.fixture.answerNext('prIndex', {
        ...value,
        pullRequests: value.pullRequests.map((pr) =>
          pr.number === 181 ? { ...pr, draft: true, title: 'Refreshed source 181' } : pr,
        ),
      }),
    index,
  )
  await page.getByRole('button', { name: 'Refresh index', exact: true }).click()
  await expect(inspector).toContainText('Refreshed source 181')
  await expect(inspector).toContainText('open · draft')
  await expect(inspector.getByRole('button', { name: 'Review #181', exact: true })).toBeVisible()
  await expect(page.locator('.graph-camera')).toContainText('90%')
  const calls = await getDoubleCalls(page)
  expect(calls.filter((call) => call.call === 'prIndex').at(-1)?.args).toEqual([{ refresh: true }])
  expect(calls.filter((call) => call.call === 'runAction')).toHaveLength(0)
})
