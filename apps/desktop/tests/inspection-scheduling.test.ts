import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { CommandCancelled } from '../src/main/git-core'
import { RepositoryOperations } from '../src/main/repository-operations'
import { RepositoryScheduler } from '../src/main/repository-scheduler'
import { RequestRegistry } from '../src/main/request-registry'

type Handler = (...args: unknown[]) => Promise<unknown>

// Execute the production handlers without booting Electron. This tests scheduling,
// not sender validation or native Git; those boundaries have separate smoke checks.
async function handlers(
  fileRead: (root: string, signal: AbortSignal) => Promise<unknown>,
  action: () => Promise<unknown>,
) {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  function section(startMarker: string, endMarker: string) {
    const start = source.indexOf(startMarker)
    assert.notEqual(start, -1, `Missing production section: ${startMarker}`)
    const end = source.indexOf(endMarker, start)
    assert.notEqual(end, -1, `Missing production section end: ${startMarker}`)
    return source.slice(start, end + endMarker.length)
  }
  const declarations = ['repository()', 'readRepository<T>('].map((name) =>
    section(`function ${name}`, '\n}'),
  )
  const registrations = [
    section("  ipcMain.handle(\n    'inspection:request',", '\n  )'),
    section("  ipcMain.handle('repository:file',", '\n  })'),
    section("  ipcMain.handle('repository:action',", '\n  })'),
  ]
  const scheduler = new RepositoryScheduler(1)
  const operations = new RepositoryOperations()
  await operations.switchRepository('/primary', async () => {})
  const repositories = [
    {
      identity: { id: 'shared-git-authority' },
      registeredPaths: ['/primary'],
      worktrees: [{ id: 'linked', path: '/linked', kind: 'linked', gitDirectory: '/admin/linked' }],
      refs: [],
      pullRequests: [],
    },
    {
      identity: { id: 'other-authority' },
      registeredPaths: ['/other'],
      worktrees: [
        { id: 'other-tree', path: '/other', kind: 'primary', gitDirectory: '/other/.git' },
      ],
      refs: [],
      pullRequests: [],
    },
  ]
  const inspectionHandlers = new Map<string, Handler>()
  const output: Record<string, Handler> = {}
  const script = stripTypeScriptTypes([...declarations, ...registrations].join('\n'))
  runInNewContext(script, {
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        output[channel] = handler
      },
    },
    inspectionHandlers,
    inspectionAuthority: new AsyncLocalStorage(),
    inspectionReads: new RepositoryScheduler(1),
    scheduler,
    operations,
    readKeys: new RequestRegistry(),
    activeRepository: '/primary',
    hostGeneration: 0,
    progressOwner: null,
    inGitRuntime: (operation: () => Promise<unknown>) => operation(),
    inventory: { current: () => ({ repositories }) },
    recents: [{ path: '/primary' }, { path: '/other' }],
    INSPECTION_CHANNELS: { fileView: 'repository:file' },
    isRecord: (value: unknown) => typeof value === 'object' && value !== null,
    requireString: (value: unknown) => {
      assert.equal(typeof value, 'string')
      return value
    },
    // Adoption uses the background scheduler even inside a captured read.
    adoptionPaths: (
      _inventory: unknown,
      ids: string[],
      lane: RepositoryScheduler,
      signal: AbortSignal,
    ) => lane.read(ids[0] === 'linked' ? '/primary' : '/other', async () => ids, signal),
    discoverWorktrees: async (root: string) =>
      repositories.find((repo) => repo.worktrees.some((tree) => tree.path === root)),
    getConfigValue: async () => null,
    getOriginUrl: async () => null,
    getFileView: (root: string, _path: string, signal: AbortSignal) => fileRead(root, signal),
    settingsFile: () => '/settings',
    readSettingsFile: async () => ({ settings: { git: {} } }),
    runAction: action,
    sync: { recordMutationFailure: () => {} },
    CommandCancelled,
    AbortSignal,
    Error,
    realpath: async (path: string) => path,
    operationCaptures: new Map(),
  })
  inspectionHandlers.set('repository:file', output['repository:file'])
  return {
    inspect: (other = false) =>
      output['inspection:request'](
        {},
        {
          repositoryId: other ? 'other-authority' : 'shared-git-authority',
          worktreeId: other ? 'other-tree' : 'linked',
        },
        'fileView',
        ['file.txt'],
      ),
    mutate: () => output['repository:action']({}, { type: 'stage' }),
  }
}

test('a Git action retires and awaits linked-worktree inspection cleanup before entering', async () => {
  const entered = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  let mutated = false
  const api = await handlers(
    async (_root, signal) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      entered.resolve()
      await aborted.promise
      await cleanup.promise
      throw new CommandCancelled()
    },
    async () => {
      mutated = true
    },
  )
  const inspection = api.inspect()
  const rejected = assert.rejects(inspection, CommandCancelled)
  await entered.promise
  const mutation = api.mutate()
  await aborted.promise
  assert.equal(mutated, false, 'a cancelled inspection still owns its lane during cleanup')
  cleanup.resolve()
  await rejected
  await mutation
  assert.equal(mutated, true)
})

test('new affected inspections wait through a Git action while unrelated repositories remain readable', async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const reads: string[] = []
  const api = await handlers(
    async (root) => {
      reads.push(root)
      return root
    },
    async () => {
      entered.resolve()
      await finish.promise
    },
  )
  const mutation = api.mutate()
  await entered.promise
  const affected = api.inspect()
  assert.equal(await api.inspect(true), '/other')
  assert.deepEqual(reads, ['/other'])
  finish.resolve()
  await mutation
  assert.equal(await affected, '/linked')
  assert.deepEqual(reads, ['/other', '/linked'])
})
