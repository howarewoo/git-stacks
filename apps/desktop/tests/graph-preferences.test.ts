import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GraphPreferencesStore, type GraphPreferencesScope } from '../src/main/graph-preferences'
import {
  parseGraphPreferences,
  parseGraphPreferencesPublicScope,
  type GraphPreferences,
} from '@git-stacks/shared/graph-preferences'

const preferences: GraphPreferences = {
  preset: 'my-prs',
  text: '',
  author: '',
  status: 'all',
  collapse: true,
  name: 'My graph',
}
const scope: GraphPreferencesScope = {
  repositoryPath: '/work/owner/repo',
  host: 'github.com',
  repository: 'owner/repo',
  account: 'ada',
  authority: '1',
}
const publicScope = {
  repositoryPath: scope.repositoryPath,
  host: scope.host,
  repository: scope.repository,
  account: scope.account,
}

test('public namespace parsing accepts exactly four nonempty public fields', () => {
  assert.deepEqual(parseGraphPreferencesPublicScope(publicScope), publicScope)
  for (const invalid of [
    null,
    { ...publicScope, authority: 'private' },
    { ...publicScope, identity: 'private' },
    { ...publicScope, repositoryPath: '' },
    { ...publicScope, account: null },
    { host: scope.host, repository: scope.repository, account: scope.account },
  ])
    assert.equal(parseGraphPreferencesPublicScope(invalid), null)
})

test('graph preference boundary accepts exact supported values and rejects authority, facts, and oversized values', () => {
  for (const preset of ['my-prs', 'review-requested', 'current-branch', 'all-open']) {
    for (const status of ['all', 'draft', 'ready', 'checks-failed', 'checks-pending']) {
      assert.ok(parseGraphPreferences({ ...preferences, preset, status }))
    }
  }
  assert.ok(
    parseGraphPreferences({
      ...preferences,
      text: 'x'.repeat(256),
      author: 'x'.repeat(100),
      name: 'x'.repeat(80),
    }),
  )
  for (const invalid of [
    null,
    [],
    {},
    { ...preferences, host: 'evil.example' },
    { ...preferences, account: 'other' },
    { ...preferences, pullRequests: [] },
    { ...preferences, preset: 'mine' },
    { ...preferences, status: 'merged' },
    { ...preferences, text: 'x'.repeat(257) },
    { ...preferences, author: 'x'.repeat(101) },
    { ...preferences, name: 'x'.repeat(81) },
    { ...preferences, collapse: 'true' },
  ]) {
    assert.equal(parseGraphPreferences(invalid), null)
  }
})

test('main store persists across instances, isolates account/repository/host, serializes writes, and resets only current scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-preferences-'))
  let current: GraphPreferencesScope | null = scope
  const authority = async () => current
  try {
    const store = new GraphPreferencesStore(directory, authority)
    assert.deepEqual(await store.read(), { state: 'ready', preferences: null, scope: publicScope })
    const saves = await Promise.all([
      store.save(preferences, publicScope),
      store.save({ ...preferences, text: 'latest' }, publicScope),
    ])
    assert.equal(saves[0].preferences?.text, '')
    assert.equal(saves[1].preferences?.text, 'latest')
    assert.deepEqual(
      saves.map((result) => result.scope),
      [publicScope, publicScope],
    )
    const reopened = new GraphPreferencesStore(directory, authority)
    assert.equal((await reopened.read()).preferences?.text, 'latest')
    for (const other of [
      { account: 'grace' },
      { repository: 'owner/other' },
      { host: 'enterprise.example' },
    ]) {
      current = { ...scope, ...other }
      const expectedScope = { ...publicScope, ...other }
      assert.deepEqual(await store.read(), {
        state: 'ready',
        preferences: null,
        scope: expectedScope,
      })
      assert.deepEqual(await store.save({ ...preferences, name: 'Other' }, expectedScope), {
        state: 'ready',
        preferences: { ...preferences, name: 'Other' },
        scope: expectedScope,
      })
      assert.deepEqual(await store.reset(expectedScope), {
        state: 'ready',
        preferences: null,
        scope: expectedScope,
      })
    }
    current = scope
    assert.equal((await store.read()).preferences?.text, 'latest')
    const file = join(directory, (await readdir(directory))[0])
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1)
    await assert.rejects(
      store.save({ ...preferences, authority: 'forged' }, publicScope),
      /Invalid/,
    )
    assert.equal((await store.read()).preferences?.text, 'latest')
    current = { ...scope, repositoryPath: '/another/checkout', authority: 'another-checkout' }
    assert.deepEqual(await store.read(), {
      state: 'ready',
      preferences: { ...preferences, text: 'latest' },
      scope: { ...publicScope, repositoryPath: '/another/checkout' },
    })
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(Object.keys(persisted).sort(), ['preferences', 'scope', 'version'])
    assert.equal(persisted.scope, JSON.stringify([scope.host, scope.repository, scope.account]))
    current = null
    assert.equal((await store.read()).scope, null)
    assert.equal((await store.read()).state, 'unavailable')
    assert.equal((await store.save(preferences, publicScope)).scope, null)
    assert.equal((await store.save(preferences, publicScope)).state, 'unavailable')
    assert.equal((await store.reset(publicScope)).scope, null)
    assert.equal((await store.reset(publicScope)).state, 'unavailable')
    current = scope
    await store.reset(publicScope)
    assert.deepEqual(await reopened.read(), {
      state: 'ready',
      preferences: null,
      scope: publicScope,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('corrupt, future, oversized, and unreadable storage recovers without silently overwriting; explicit save repairs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-preferences-'))
  try {
    const store = new GraphPreferencesStore(directory, async () => scope)
    await store.save(preferences, publicScope)
    const file = join(directory, (await readdir(directory))[0])
    for (const payload of ['{', JSON.stringify({ version: 2, preferences }), 'x'.repeat(4097)]) {
      await writeFile(file, payload)
      const recovered = await store.read()
      assert.equal(recovered.state, 'recovered')
      assert.deepEqual(recovered.scope, publicScope)
      assert.equal(await readFile(file, 'utf8'), payload)
    }
    await rm(file)
    await mkdir(file)
    assert.equal((await store.read()).state, 'recovered')
    await rm(file, { recursive: true })
    await store.save(preferences, publicScope)
    assert.deepEqual(await store.read(), { state: 'ready', preferences, scope: publicScope })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('authority changes during a request refuse publication and queued persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-preferences-'))
  let calls = 0
  const store = new GraphPreferencesStore(directory, async () =>
    ++calls === 1 ? scope : { ...scope, authority: '2' },
  )
  try {
    assert.equal((await store.save(preferences, publicScope)).state, 'unavailable')
    assert.deepEqual(await readdir(directory), [])
    calls = 0
    assert.equal((await store.read()).state, 'unavailable')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed writes do not poison the queue or claim a persisted preference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-preferences-'))
  const directory = join(root, 'blocked')
  try {
    await writeFile(directory, 'not a directory')
    const store = new GraphPreferencesStore(directory, async () => scope)
    await assert.rejects(store.save(preferences, publicScope))
    assert.equal((await store.read()).state, 'recovered')
    await rm(directory)
    assert.deepEqual(await store.save(preferences, publicScope), {
      state: 'ready',
      preferences,
      scope: publicScope,
    })
    assert.deepEqual(await store.read(), { state: 'ready', preferences, scope: publicScope })
    assert.ok((await readdir(directory)).every((name) => name.endsWith('.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const later of ['save', 'reset'] as const) {
  test(`deferred initial authority capture preserves save/${later} invocation order`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graph-preferences-'))
    let release!: (value: GraphPreferencesScope) => void
    const captured = new Promise<GraphPreferencesScope>((resolve) => {
      release = resolve
    })
    let calls = 0
    const store = new GraphPreferencesStore(directory, () =>
      ++calls === 1 ? captured : Promise.resolve(scope),
    )
    const pending: Promise<unknown>[] = []
    try {
      pending.push(store.save({ ...preferences, text: 'earlier' }, publicScope))
      let changed = false
      const change = (
        later === 'save'
          ? store.save({ ...preferences, text: 'latest' }, publicScope)
          : store.reset(publicScope)
      ).then((result) => {
        changed = true
        return result
      })
      pending.push(change)
      let read = false
      const reading = store.read().then((result) => {
        read = true
        return result
      })
      pending.push(reading)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(changed, false, 'later writes wait for the earlier invoked save')
      assert.equal(read, false, 'reads wait for invoked writes with pending scope capture')
      release(scope)
      await Promise.all(pending)
      const expected = {
        state: 'ready',
        preferences: later === 'save' ? { ...preferences, text: 'latest' } : null,
        scope: publicScope,
      }
      assert.deepEqual(await reading, expected)
      assert.deepEqual(await store.read(), expected)
    } finally {
      release(scope)
      await Promise.allSettled(pending)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('a held initial authority read publishes the actual resolved public scope, not the invoking scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-preferences-'))
  const other = {
    repositoryPath: '/work/other/repo',
    host: 'enterprise.example',
    repository: 'Other/Repo',
    account: 'Grace',
  }
  const resolved: GraphPreferencesScope = { ...other, authority: 'private-B' }
  let release!: (value: GraphPreferencesScope) => void
  const captured = new Promise<GraphPreferencesScope>((resolve) => {
    release = resolve
  })
  let calls = 0
  const store = new GraphPreferencesStore(directory, () =>
    ++calls === 1 ? captured : Promise.resolve(resolved),
  )
  const reading = store.read()
  try {
    release(resolved)
    assert.deepEqual(await reading, { state: 'ready', preferences: null, scope: other })
    assert.notDeepEqual(
      (await reading).scope,
      publicScope,
      'a client holding scope A must reject B',
    )
  } finally {
    release(resolved)
    await Promise.allSettled([reading])
    await rm(directory, { recursive: true, force: true })
  }
})

for (const operation of ['save', 'reset'] as const) {
  test(`held initial ${operation} capture resolving another namespace refuses mutation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graph-preferences-'))
    const other = { ...scope, repositoryPath: '/work/B', account: 'grace', authority: 'B' }
    const otherPublic = {
      ...publicScope,
      repositoryPath: other.repositoryPath,
      account: other.account,
    }
    const seed = new GraphPreferencesStore(directory, async () => other)
    if (operation === 'reset')
      await seed.save({ ...preferences, name: 'B saved view' }, otherPublic)
    let release!: (value: GraphPreferencesScope) => void
    const captured = new Promise<GraphPreferencesScope>((resolve) => {
      release = resolve
    })
    let calls = 0
    const store = new GraphPreferencesStore(directory, () =>
      ++calls === 1 ? captured : Promise.resolve(other),
    )
    const pending =
      operation === 'save' ? store.save(preferences, publicScope) : store.reset(publicScope)
    try {
      release(other)
      const result = await pending
      assert.equal(result.state, 'unavailable')
      assert.equal(result.scope, null)
      if (operation === 'save') {
        assert.deepEqual(await readdir(directory), [], 'rejected save must not create B storage')
      } else {
        assert.deepEqual(
          await seed.read(),
          {
            state: 'ready',
            preferences: { ...preferences, name: 'B saved view' },
            scope: otherPublic,
          },
          'rejected reset must not delete B preferences',
        )
      }
    } finally {
      release(other)
      await Promise.allSettled([pending])
      await rm(directory, { recursive: true, force: true })
    }
  })
}
