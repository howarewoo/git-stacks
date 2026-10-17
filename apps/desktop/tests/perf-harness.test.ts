import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('native benchmark discovers the production renderer despite an inherited development URL', async () => {
  const source = readFileSync(
    new URL('../scripts/perf/desktop-interaction.mjs', import.meta.url),
    'utf8',
  )
  const stop = new Error('discovery observed')
  let launchedEnvironment: Record<string, string> | undefined
  let discoveredOrigin: string | undefined
  // Exercise the launch function without starting Electron or opening a CDP port.
  const measureDesktop = runInNewContext(
    `${source.slice(source.indexOf('export async function measureDesktop')).replace('export ', '')}; measureDesktop`,
    {
      process: { env: { ELECTRON_RENDERER_URL: 'http://localhost:5173' }, platform: 'linux' },
      performance,
      mkdtempSync: () => '/owned-user-data',
      tmpdir: () => '/tmp',
      join,
      freePort: async () => 12345,
      mkdirSync: () => {},
      writeFileSync: () => {},
      rmSync: () => {},
      LANE_ROW_PAGE_SIZE: 64,
      electron: '/electron',
      spawn: (_binary: string, _args: string[], options: { env: Record<string, string> }) => {
        launchedEnvironment = options.env
        return { exitCode: 0, stderr: { setEncoding() {}, on() {} } }
      },
      connect: () => assert.fail('discovery must stop before connection'),
      pageTarget: async (_port: number, _child: unknown, _getError: unknown, origin: string) => {
        discoveredOrigin = origin
        throw stop
      },
    },
  ) as (root: string, fixture: string) => Promise<unknown>
  await assert.rejects(measureDesktop('/app', '/fixture'), (error) => error === stop)
  assert.equal(launchedEnvironment?.ELECTRON_RENDERER_URL, undefined)
  assert.equal(discoveredOrigin, 'app://git-stacks')
})
