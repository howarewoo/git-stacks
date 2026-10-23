import { cpus, totalmem } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  STARTUP_BUDGET_MS,
  LANE_ROW_PAGE_SIZE,
  LANE_RELATIONSHIP_PAGE_SIZE,
  LANE_WARM_SAMPLE_COUNT,
  LANE_NAVIGATION_CYCLE_COUNT,
  LANE_PROJECTION_LAYOUT_BUDGET_MS,
  LANE_INPUT_PAINT_BUDGET_MS,
  LANE_SCALE_HEAP_BUDGET_BYTES,
  LANE_NAVIGATION_HEAP_BUDGET_BYTES,
} from '@git-stacks/shared/performance'
import { buildLaneFixture } from './fixtures.mjs'
import { measureDesktop } from './desktop-interaction.mjs'
import { sourceProvenance } from '../../tests/renderer/helpers/provenance.ts'

/** Actual owned production processes; no fixture API, provider write or sandbox bypass. */
export async function runLaneEnvelope(repoRoot, workspace, out) {
  const fixtures = []
  let baseline250Heap
  const source = await sourceProvenance(repoRoot)
  for (const objects of [250, 1000, 5000]) {
    const fixture = buildLaneFixture(workspace, objects)
    const branchCount = objects + 3
    const result = await measureDesktop(repoRoot, fixture, {
      branchCount,
      target: `feature/lane-${objects - 1}`,
      rowLimit: LANE_ROW_PAGE_SIZE,
      observe: async ({ client, evaluate, until, click, readCounts }) => {
        const search = 'input[aria-label="Filter branches by branch, PR, or path"]'
        await client.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        })
        const samples = []
        const countsBefore = await readCounts()
        await client.send('HeapProfiler.collectGarbage')
        const initial = (await client.send('Runtime.getHeapUsage')).usedSize
        for (let sample = 0; sample < LANE_WARM_SAMPLE_COUNT; sample++) {
          const value = sample % 2 ? `feature/lane-${objects - 1}` : ''
          const matches = value ? 1 : branchCount
          await evaluate(
            client,
            `globalThis.__lanePaint = new Promise((resolve, reject) => {
            const field = document.querySelector(${JSON.stringify(search)});
            const timeout = setTimeout(() => reject(new Error('Actual lane paint did not settle')), 30000);
            field.addEventListener('input', () => {
              const start = performance.now();
              const observer = new MutationObserver(settled);
              function settled() {
                if (field.value !== ${JSON.stringify(value)} || !document.querySelector('.bw-main .bw-panel-bottom')?.textContent.startsWith('${matches} matches ·')) return;
                observer.disconnect();
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  clearTimeout(timeout);
                  resolve({
                    inputPaintMs: performance.now() - start,
                    projectionLayoutMs: Number(document.querySelector('[data-lane-projection-layout-ms]').dataset.laneProjectionLayoutMs),
                    mountedRows: document.querySelectorAll('.bw-lane-row').length,
                    mountedLanes: document.querySelectorAll('.bw-node').length,
                    mountedRelationships: document.querySelectorAll('.bw-relationship').length
                  });
                }));
              }
              observer.observe(document.body, { subtree: true, childList: true, characterData: true });
              settled();
            }, { once: true, capture: true });
          }); true`,
          )
          await click(client, search)
          await client.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            modifiers: process.platform === 'darwin' ? 4 : 2,
            // CDP's synthetic chord alone does not perform Electron's native edit command.
            commands: ['selectAll'],
          })
          await client.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            modifiers: process.platform === 'darwin' ? 4 : 2,
          })
          if (value) await client.send('Input.insertText', { text: value })
          else {
            await client.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Backspace',
              code: 'Backspace',
              windowsVirtualKeyCode: 8,
            })
            await client.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Backspace',
              code: 'Backspace',
              windowsVirtualKeyCode: 8,
            })
          }
          samples.push(await evaluate(client, 'globalThis.__lanePaint', true))
        }
        await client.send('HeapProfiler.collectGarbage')
        const scale = (await client.send('Runtime.getHeapUsage')).usedSize
        for (let cycle = 0; cycle < LANE_NAVIGATION_CYCLE_COUNT; cycle++) {
          await evaluate(
            client,
            `window.desktop.worktreeInventory({ requestId: 'lane-envelope-${cycle}' })`,
            true,
          )
          await evaluate(
            client,
            `(() => {
            const activity = [...document.querySelectorAll('.bw-sidebar button')].find(button => button.textContent.trim() === 'Activity');
            if (!activity) throw new Error('Actual Activity entry unavailable');
            activity.click(); return true;
          })()`,
          )
          await until(
            client,
            `[...document.querySelectorAll('h1')].some(heading => heading.textContent === 'Activity')`,
          )
          await click(client, '.bw-repo')
          await evaluate(
            client,
            `(() => {
            const branches = document.querySelector('.bw-nav');
            if (!branches) throw new Error('Actual Branches entry unavailable');
            branches.click(); return true;
          })()`,
          )
          await until(client, `document.querySelector(${JSON.stringify(search)}) !== null`)
          await evaluate(
            client,
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
            true,
          )
        }
        await client.send('HeapProfiler.collectGarbage')
        const navigation = (await client.send('Runtime.getHeapUsage')).usedSize
        const countsAfter = await readCounts()
        const p95 = (key) =>
          samples.map((sample) => sample[key]).sort((a, b) => a - b)[
            Math.ceil(samples.length * 0.95) - 1
          ]
        return {
          samples,
          p95: { inputPaintMs: p95('inputPaintMs'), projectionLayoutMs: p95('projectionLayoutMs') },
          heap: { initial, scale, navigation, navigationGrowthBytes: navigation - scale },
          requests: {
            before: countsBefore,
            after: countsAfter,
            definition:
              'Actual trusted incoming IPC attempts and validated inspection-operation names; refusals included, arguments/credentials excluded',
          },
          renderer: await evaluate(
            client,
            `({ userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, theme: document.documentElement.dataset.gsTheme ?? null, density: document.querySelector('[aria-label="Display density"]')?.textContent ?? null, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches })`,
          ),
        }
      },
    })
    baseline250Heap ??= result.lane.heap.scale
    result.lane.heap.scaleGrowthBytes = result.lane.heap.scale - baseline250Heap
    const limits = {
      startupMs: STARTUP_BUDGET_MS,
      inputPaintMs: LANE_INPUT_PAINT_BUDGET_MS,
      projectionLayoutMs: LANE_PROJECTION_LAYOUT_BUDGET_MS,
      scaleGrowthBytes: LANE_SCALE_HEAP_BUDGET_BYTES,
      navigationGrowthBytes: LANE_NAVIGATION_HEAP_BUDGET_BYTES,
    }
    const measured = {
      startupMs: result.startupMs,
      ...result.lane.p95,
      scaleGrowthBytes: result.lane.heap.scaleGrowthBytes,
      navigationGrowthBytes: result.lane.heap.navigationGrowthBytes,
    }
    const overBudget = Object.keys(limits).filter(
      (key) => !Number.isFinite(measured[key]) || measured[key] > limits[key],
    )
    if (
      result.lane.samples.some(
        (sample) =>
          sample.mountedRows > LANE_ROW_PAGE_SIZE ||
          sample.mountedLanes > LANE_ROW_PAGE_SIZE ||
          sample.mountedRelationships > LANE_RELATIONSHIP_PAGE_SIZE,
      )
    )
      overBudget.push('mounted-window')
    fixtures.push({
      objects,
      simultaneousWorktrees: 120,
      fixture,
      startupMs: result.startupMs,
      firstInteractionMs: result.interactionMs,
      ...result.lane,
      limits,
      overBudget,
    })
  }
  const report = {
    version: 1,
    source,
    methodology:
      'Actual sandboxed production Electron; trusted input through matching committed DOM and two frames; projection plus DOM relationship layout; explicit post-GC heap; fresh-process scale growth versus identically warmed 250-object fixture; 30 navigation/read refresh cycles within each process',
    instrumentation:
      'Owned credential-free fixture process only; fixed-name main IPC counters through ephemeral loopback Node inspector, renderer through loopback CDP; sandbox unchanged; no production renderer/test API added',
    baseline250Heap,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    generatedAt: new Date().toISOString(),
    warmSamples: LANE_WARM_SAMPLE_COUNT,
    navigationRefreshCycles: LANE_NAVIGATION_CYCLE_COUNT,
    fixtures,
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'lane-envelope.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (fixtures.some((fixture) => fixture.overBudget.length))
    throw new Error('Native lane envelope exceeded unchanged budgets; inspect lane-envelope.json')
  return report
}
