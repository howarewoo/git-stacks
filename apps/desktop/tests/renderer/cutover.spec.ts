import { test, expect } from '@playwright/test'
import { cpus, totalmem } from 'node:os'
import {
  LANE_ROW_PAGE_SIZE,
  LANE_WARM_SAMPLE_COUNT,
  LANE_NAVIGATION_CYCLE_COUNT,
  LANE_PROJECTION_LAYOUT_BUDGET_MS,
  LANE_INPUT_PAINT_BUDGET_MS,
  LANE_SCALE_HEAP_BUDGET_BYTES,
  LANE_NAVIGATION_HEAP_BUDGET_BYTES,
} from '@git-stacks/shared/performance'
import { cutoverScale } from './fixtures/cutover'
import { openGallery, settle } from './helpers/gallery'
import { sourceProvenance } from './helpers/provenance'

test('actual lanes retain bottom-up parent/fork geometry and mutation-free filtered page scope', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 1000 })
  await openGallery(page, { scenario: 'cutover-reference' })
  await expect(page.locator('.bw-lane-row')).toHaveCount(19)
  await page.getByRole('button', { name: 'feat/worktree-registry', exact: true }).click()
  await settle(page)
  const rows = await page.locator('.bw-lane-row').evaluateAll((elements) =>
    elements.map((row) => ({
      name: row.querySelector('.bw-branch-name')!.textContent,
      center: row.getBoundingClientRect().y + row.getBoundingClientRect().height / 2,
      label: row.getAttribute('aria-label'),
    })),
  )
  const y = new Map(rows.map((row) => [row.name, row.center]))
  for (const row of rows) {
    const parent = row.label?.match(/Parent: ([^.]+)\./)?.[1]
    if (parent && y.has(parent)) expect(row.center).toBeLessThan(y.get(parent)!)
  }
  await page
    .getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
    .fill('docs/worktree-workflows')
  await expect(page.locator('.bw-lane-row')).toHaveCount(4)
  await expect(page.locator('.bw-context')).toHaveCount(3)
  await page
    .getByRole('checkbox', { name: 'Select visible matching branches; excludes trunk and context' })
    .click()
  await expect(page.locator('.bw-bulk')).toContainText('1 selected')
  await expect(page.locator('.bw-context [role=checkbox]:not([disabled])')).toHaveCount(0)
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  expect(
    await page.evaluate(() =>
      window.fixture.calls.filter((call) =>
        [
          'executeOperation',
          'pullRequestAction',
          'reviewSubmit',
          'rerunPullRequestCheck',
          'openRepository',
          'adoptWorktrees',
        ].includes(call.call),
      ),
    ),
  ).toEqual([])
})

for (const size of [250, 1000, 5000] as const) {
  test(`actual ${size}-object App bounds rows and crosses pages by keyboard without changing selection`, async ({
    page,
  }, info) => {
    await openGallery(page, { scenario: `cutover-${size}` })
    const rows = page.locator('.bw-lane-row')
    await expect(rows).toHaveCount(LANE_ROW_PAGE_SIZE)
    const selectedBefore = await page
      .locator('.bw-selected[data-branch-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-branch-id')))
    await rows.first().focus()
    await page.keyboard.press('End')
    await expect(page.locator('.bw-lane-row:focus')).toContainText('main')
    expect(await rows.count()).toBeLessThanOrEqual(LANE_ROW_PAGE_SIZE)
    await page.keyboard.press('Home')
    await expect(rows.first()).toBeFocused()
    expect(
      await page
        .locator('.bw-selected[data-branch-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-branch-id'))),
    ).toEqual(selectedBefore)
    const filter = page.getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
    await filter.fill(`graph/change-${size}`)
    await expect(
      page.getByRole('button', { name: `graph/change-${size}`, exact: true }),
    ).toBeVisible()
    expect(await rows.count()).toBeLessThanOrEqual(LANE_ROW_PAGE_SIZE)
    const inventory = cutoverScale(size).inventory!
    expect(inventory.repositories[0].worktrees).toHaveLength(120)
    await page.evaluate((inventory) => {
      for (let generation = 2; generation <= 25; generation++) {
        const next = structuredClone(inventory)
        next.generation = generation
        next.repositories[0].worktrees[17].status = generation % 2 ? 'dirty' : 'clean'
        next.repositories[0].worktrees[17].counts = {
          staged: 0,
          unstaged: generation % 2,
          untracked: 0,
          renamed: 0,
          conflicted: 0,
        }
        next.repositories[1].worktrees[0].status = 'dirty'
        next.repositories[1].worktrees[0].counts = {
          staged: 0,
          unstaged: 1,
          untracked: 0,
          renamed: 0,
          conflicted: 0,
        }
        window.fixture.pushInventory(next)
      }
    }, inventory)
    await expect(filter).toHaveValue(`graph/change-${size}`)
    expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
    const calls = await page.evaluate(() => window.fixture.calls)
    expect(
      calls.filter((call) => call.call === 'executeOperation' || call.call === 'openRepository'),
    ).toEqual([])
    await info.attach('actual-scale-consumer', {
      body: JSON.stringify(
        {
          objects: size,
          worktrees: 120,
          mountedRows: await rows.count(),
          calls,
          evidence:
            'Renderer/typed fixture intent only; native and performance acceptance deferred',
        },
        null,
        2,
      ),
      contentType: 'application/json',
    })
  })
}

test('independent repository restoration preserves search and does not borrow a checkout', async ({
  page,
}) => {
  await openGallery(page, { scenario: 'cutover-250' })
  const filter = page.getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
  await expect(page.locator('.bw-lane-row')).toHaveCount(LANE_ROW_PAGE_SIZE)
  await filter.fill('graph/change-250')
  const repositories = page.locator('.bw-repo')
  await repositories.nth(1).click()
  await expect(filter).toHaveValue('')
  await repositories.nth(0).click()
  await expect(filter).toHaveValue('graph/change-250')
  const inventory = cutoverScale(250).inventory!
  await page.evaluate((inventory) => {
    const failed = structuredClone(inventory)
    failed.generation++
    failed.state = 'partial'
    failed.repositories[0].discovery = {
      state: 'failed',
      observedAt: null,
      error: 'External directory temporarily unavailable',
    }
    failed.repositories[0].worktrees = []
    window.fixture.pushInventory(failed)
  }, inventory)
  await expect(filter).toHaveValue('graph/change-250')
  await page.evaluate(
    (inventory) => window.fixture.pushInventory({ ...inventory, generation: 3 }),
    inventory,
  )
  await expect(filter).toHaveValue('graph/change-250')
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
  expect(
    await page.evaluate(() =>
      window.fixture.calls.filter(
        (call) => call.call === 'openRepository' || call.call === 'executeOperation',
      ),
    ),
  ).toEqual([])
})

test('compact repository and route returns retain both scrollports and qualified inspection', async ({
  page,
}) => {
  const scenario = cutoverScale(250)
  await openGallery(page, { scenario: 'cutover-250', viewport: { width: 720, height: 470 } })
  const filter = page.getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
  await filter.fill('graph/change-250')
  const pane = page.getByRole('main', { name: 'Branch workbench', exact: true })
  const inner = pane.locator('.bw-main-scroll')
  await pane.locator('.bw-panel-bottom').scrollIntoViewIfNeeded()
  await inner.evaluate((node) => {
    node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2)
  })
  await settle(page)
  const offsets = () =>
    pane.evaluate((node) => ({
      outer: node.scrollTop,
      inner: node.querySelector('.bw-main-scroll')!.scrollTop,
    }))
  const before = await offsets()
  expect(before.outer).toBeGreaterThan(0)
  expect(before.inner).toBeGreaterThan(0)
  const selected = () =>
    page
      .locator('.bw-selected[data-branch-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-branch-id')))
  const selection = await selected()
  const repository = (path: string) =>
    page
      .getByRole('complementary', { name: 'Workspace navigation' })
      .getByRole('button')
      .and(page.getByTitle(path, { exact: true }))
  const [primary, clone] = scenario.inventory!.repositories
  await repository(clone.registeredPaths[0]).click()
  await expect(repository(clone.registeredPaths[0])).toHaveAttribute('aria-pressed', 'true')
  await expect(filter).toHaveValue('')
  await expect.poll(offsets).toEqual({ outer: 0, inner: 0 })
  await repository(primary.registeredPaths[0]).click()
  await expect(filter).toHaveValue('graph/change-250')
  await expect.poll(offsets).toEqual(before)
  expect(await selected()).toEqual(selection)
  await page
    .getByRole('complementary', { name: 'Workspace navigation' })
    .getByRole('button', { name: /^Activity/ })
    .click()
  await page
    .getByRole('complementary', { name: 'Workspace navigation' })
    .getByRole('button', { name: /^Branches/ })
    .click()
  await expect.poll(offsets).toEqual(before)
  await expect(filter).toHaveValue('graph/change-250')
  expect(await selected()).toEqual(selection)
  await page.reload()
  await settle(page)
  await expect.poll(offsets).toEqual(before)
  await expect(filter).toHaveValue('graph/change-250')
  expect(await selected()).toEqual(selection)
  expect(await page.evaluate(() => window.fixture.actions)).toEqual([])
})

test('filter projection cost is included in the matching layout metric', async ({ page }) => {
  await openGallery(page, { scenario: 'cutover-reference' })
  await settle(page)
  // Advance only the projection clock, avoiding hardware-dependent busy waits.
  await page.evaluate(() => {
    const now = performance.now.bind(performance)
    const lowerCase = String.prototype.toLowerCase
    let cost = 0
    let charged = false
    performance.now = () => {
      charged = false
      return now() + cost
    }
    String.prototype.toLowerCase = function () {
      if (!charged && String(this).includes('docs/worktree-workflows')) {
        cost += 120
        charged = true
      }
      return lowerCase.call(this)
    }
  })
  await page
    .getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
    .fill('docs/worktree-workflows')
  await expect(page.locator('.bw-lane-row')).toHaveCount(4)
  await settle(page)
  const projectionLayoutMs = await page
    .locator('.bw-app')
    .evaluate((root) => Number(root.getAttribute('data-lane-projection-layout-ms')))
  expect(projectionLayoutMs).toBeGreaterThan(LANE_PROJECTION_LAYOUT_BUDGET_MS)
  expect(projectionLayoutMs).toBeLessThan(LANE_INPUT_PAINT_BUDGET_MS)
})

test('@cutover-measure actual consumer warm input/layout and post-GC navigation packet', async ({
  page,
  browserName,
}, info) => {
  test.skip(
    !process.env.CUTOVER_MEASURE,
    'Explicit manual browser measurement run; not Electron budget acceptance',
  )
  test.setTimeout(180_000)
  const provenance = await sourceProvenance()
  await openGallery(page, { scenario: 'cutover-5000' })
  await expect(page.locator('.bw-lane-row')).toHaveCount(LANE_ROW_PAGE_SIZE)
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.collectGarbage')
  const initialHeap = await session.send('Runtime.getHeapUsage')
  const samples: {
    inputPaintMs: number
    layoutMs: number
    mountedRows: number
    mountedLanes: number
  }[] = []
  const filter = page.getByRole('textbox', { name: 'Filter branches by branch, PR, or path' })
  await filter.fill('graph/change-5000')
  await settle(page)
  await filter.fill('')
  await settle(page)
  await page.evaluate(() => {
    document
      .querySelector('input[aria-label="Filter branches by branch, PR, or path"]')!
      .addEventListener('input', () => {
        performance.mark('cutover-input')
        requestAnimationFrame(() =>
          requestAnimationFrame(() => performance.measure('cutover-input-paint', 'cutover-input')),
        )
      })
  })
  for (let sample = 0; sample < LANE_WARM_SAMPLE_COUNT; sample++) {
    await filter.fill(sample % 2 ? '' : 'graph/change-5000')
    await settle(page)
    samples.push(
      await page.evaluate(() => ({
        inputPaintMs: performance.getEntriesByName('cutover-input-paint').at(-1)!.duration,
        layoutMs: Number(
          document
            .querySelector('[data-lane-projection-layout-ms]')!
            .getAttribute('data-lane-projection-layout-ms'),
        ),
        mountedRows: document.querySelectorAll('.bw-lane-row').length,
        mountedLanes: document.querySelectorAll('.bw-node').length,
      })),
    )
  }
  await session.send('HeapProfiler.collectGarbage')
  const scaleHeap = await session.send('Runtime.getHeapUsage')
  for (let cycle = 0; cycle < LANE_NAVIGATION_CYCLE_COUNT; cycle++) {
    await page.locator('.bw-repo').nth(1).click()
    await page.locator('.bw-repo').nth(0).click()
    await page.evaluate((inventory) => window.fixture.pushInventory(inventory), {
      ...cutoverScale(5000).inventory!,
      generation: cycle + 2,
    })
    await settle(page)
  }
  await session.send('HeapProfiler.collectGarbage')
  const navigationHeap = await session.send('Runtime.getHeapUsage')
  const percentile = (values: number[], percentile: number) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * percentile) - 1]
  const packet = {
    version: 1,
    acceptance:
      'Candidate browser observations only; not Electron budget acceptance. Scale allocation is within the already-loaded 5000-object process, not the native 250-object reference comparison.',
    provenance,
    runtime: {
      node: process.version,
      browserName,
      userAgent: await page.evaluate(() => navigator.userAgent),
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    fixture: { seed: 'cutover-5000', objects: 5000, worktrees: 120 },
    methodology: {
      warmSamples: LANE_WARM_SAMPLE_COUNT,
      navigationRefreshCycles: LANE_NAVIGATION_CYCLE_COUNT,
      gc: 'CDP HeapProfiler.collectGarbage',
      inputPaint:
        'actual input event through two animation frames; native matching-commit observer lives in lane-envelope.mjs',
    },
    budgets: {
      inputPaintMs: LANE_INPUT_PAINT_BUDGET_MS,
      projectionLayoutMs: LANE_PROJECTION_LAYOUT_BUDGET_MS,
      scaleHeapBytes: LANE_SCALE_HEAP_BUDGET_BYTES,
      navigationHeapBytes: LANE_NAVIGATION_HEAP_BUDGET_BYTES,
    },
    samples,
    p95: {
      inputPaintMs: percentile(
        samples.map((sample) => sample.inputPaintMs),
        0.95,
      ),
      layoutMs: percentile(
        samples.map((sample) => sample.layoutMs),
        0.95,
      ),
    },
    heap: {
      initial: initialHeap.usedSize,
      scale: scaleHeap.usedSize,
      navigation: navigationHeap.usedSize,
      allocationAfterLoaded5000: scaleHeap.usedSize - initialHeap.usedSize,
      navigationGrowth: navigationHeap.usedSize - scaleHeap.usedSize,
    },
    requests: await page.evaluate(() => window.fixture.calls),
    mutations: await page.evaluate(() => window.fixture.actions),
  }
  expect(packet.mutations).toEqual([])
  expect(
    samples.every(
      (sample) =>
        sample.mountedRows <= LANE_ROW_PAGE_SIZE && sample.mountedLanes <= LANE_ROW_PAGE_SIZE,
    ),
  ).toBe(true)
  await info.attach('cutover-browser-measurements', {
    body: JSON.stringify(packet, null, 2),
    contentType: 'application/json',
  })
  await session.detach()
})
