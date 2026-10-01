import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIXTURE_DIRECTORY } from './support/harness'
import { discoverFixtureModules } from './support/fixture'

/**
 * Discovery proof. `npm test` runs `tests/*.test.ts`, which never reaches a nested
 * directory, so the nested fixtures are discovered here from the filesystem and their
 * count is asserted. A runner that listed the files but never executed them would
 * leave this test with nothing to find.
 */

test('nested fixture modules are discovered from disk and are not empty', async () => {
  const { files, fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  assert.ok(files.length >= 2, `expected nested fixture modules, found ${files.length}`)
  assert.ok(
    fixtures.length >= 24,
    `expected the full matrix plus mutations, found ${fixtures.length}`,
  )
  const ids = fixtures.map((fixture) => fixture.spec.id)
  assert.equal(new Set(ids).size, ids.length, 'fixture ids must be unique')
})

test('the initial fixture matrix covers every row issue 84 requires', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const entries = new Set(
    fixtures
      .filter((fixture) => fixture.spec.kind === 'matrix')
      .map((fixture) => fixture.spec.matrixEntry),
  )
  const required = [
    'no input',
    'duplicate identifiers',
    'single PR',
    'independent PRs',
    'already-correct chain',
    'fan-out',
    'diamond/fan-in with shared commits',
    'multiple authors',
    'external prerequisite satisfied',
    'external prerequisite missing',
    'cycles/contradictions',
    'shallow/incomplete history',
    'empty/redundant contribution',
    'unsupported fork',
    'dirty user checkout',
    'changed remote head',
    'partial PR-base publication',
  ]
  const missing = required.filter((entry) => !entries.has(entry))
  assert.deepEqual(missing, [], `matrix rows without a fixture: ${missing.join(', ')}`)
})

test('the mutation set covers every sensitivity the contract claims', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const mutations = fixtures.filter((fixture) => fixture.spec.kind === 'mutation')
  const invariants = mutations.map((fixture) => fixture.spec.expect.mustDetectInvariant).sort()
  assert.deepEqual(invariants, [
    'integrity.clean',
    'preservation.cumulative',
    'preservation.original-commits',
    'preservation.unselected-refs',
    'remote.actions-permitted',
    'remote.claims-match',
    'selection.complete',
    'topology.chain',
    'topology.chain',
    'topology.dependencies',
    'topology.dependencies',
  ])
  assert.ok(
    mutations.every((fixture) => fixture.spec.expect.honestResult === false),
    'every mutated fixture must report success the observed state does not support',
  )
})
