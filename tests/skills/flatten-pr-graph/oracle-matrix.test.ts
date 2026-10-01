import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverFixtureModules, type FixtureModule } from './support/fixture'
import { executeFixture, FIXTURE_DIRECTORY, type FixtureExecution } from './support/harness'

/**
 * The matrix run. Every fixture is executed against real Git and the fake provider,
 * and the oracle decides the outcome. The test asserts the witnessed status and the
 * absence or presence of violations; it never asks the fixture what it thinks happened.
 */

async function withFixture<T>(
  module: FixtureModule,
  body: (execution: FixtureExecution) => Promise<T> | T,
): Promise<T> {
  const execution = await executeFixture(module)
  try {
    return await body(execution)
  } finally {
    await execution.world.cleanup()
  }
}

function describeViolations(execution: FixtureExecution): string {
  return execution.verdict.violations
    .map(
      (violation) => `${violation.invariant}: ${violation.detail} (observed ${violation.observed})`,
    )
    .join('\n')
}

test('every matrix fixture is discovered, executed, and judged against real state', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const matrix = fixtures.filter((fixture) => fixture.spec.kind === 'matrix')
  assert.ok(matrix.length >= 17, `expected the full initial matrix, found ${matrix.length}`)
  for (const module of matrix) {
    await withFixture(module, (execution) => {
      assert.equal(
        execution.verdict.witnessedStatus,
        module.spec.expect.status,
        `${module.spec.id}: witnessed ${execution.verdict.witnessedStatus}\n${describeViolations(execution)}`,
      )
      assert.equal(
        execution.verdict.ok,
        module.spec.expect.honestResult,
        `${module.spec.id} violations:\n${describeViolations(execution)}`,
      )
      assert.ok(
        execution.verdict.unautomated.length > 0,
        `${module.spec.id} must leave the semantic dimension unautomated`,
      )
    })
  }
})

test('the oracle derives status from state even when the claim asserts success', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const blocked = fixtures.find((fixture) => fixture.spec.id === 'active-auto-merge-blocks')
  assert.ok(blocked, 'the auto-merge fixture must exist')
  await withFixture(blocked, (execution) => {
    const claim = execution.claim as { status: string }
    assert.equal(claim.status, 'blocked')
    assert.equal(execution.verdict.witnessedStatus, 'blocked')
    assert.ok(
      execution.verdict.blockers.some((blocker) => blocker.code === 'active-landing-arrangement'),
      'the landing arrangement must be detected from provider state alone',
    )
    assert.ok(
      execution.provider.actions.every(
        (action) => action.kind !== 'push-selected-head' && action.kind !== 'update-pr-base',
      ),
      'a blocked run must not write anything',
    )
  })
})

test('a preview leaves every existing ref and the user checkout untouched', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const preview = fixtures.find((fixture) => fixture.spec.id === 'preview-leaves-state-untouched')
  assert.ok(preview, 'the preview fixture must exist')
  await withFixture(preview, (execution) => {
    assert.deepEqual(execution.world.remoteRefs(), execution.baseline.refsBefore)
    assert.deepEqual(execution.world.userFingerprint(), execution.baseline.userBefore)
    assert.equal(execution.verdict.witnessedStatus, 'planned')
    assert.equal(execution.verdict.ok, true, describeViolations(execution))
  })
})

test('a dirty user checkout survives a published run', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const dirty = fixtures.find((fixture) => fixture.spec.id === 'dirty-user-checkout')
  assert.ok(dirty, 'the dirty-checkout fixture must exist')
  await withFixture(dirty, (execution) => {
    assert.ok(execution.baseline.userBefore.status.includes('README.md'))
    assert.deepEqual(execution.world.userFingerprint(), execution.baseline.userBefore)
  })
})

test('the blocked selection never becomes "every open pull request"', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const noInput = fixtures.find((fixture) => fixture.spec.id === 'no-input')
  assert.ok(noInput, 'the no-input fixture must exist')
  await withFixture(noInput, (execution) => {
    const claim = execution.claim as { snapshot: { selection: { resolved: unknown[] } } }
    assert.deepEqual(claim.snapshot.selection.resolved, [])
    assert.equal(execution.verdict.witnessedStatus, 'blocked')
    assert.equal(execution.verdict.ok, true, describeViolations(execution))
  })
})

test('a partial publication records recovery and never claims a full chain', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const partial = fixtures.find((fixture) => fixture.spec.id === 'partial-pr-base-publication')
  assert.ok(partial, 'the partial-publication fixture must exist')
  await withFixture(partial, (execution) => {
    const claim = execution.claim as {
      status: string
      recovery: { acknowledgedChanges: string[]; unconfirmedAttempts: string[] }
    }
    assert.equal(claim.status, 'partial')
    assert.ok(claim.recovery.acknowledgedChanges.length > 0)
    assert.ok(claim.recovery.unconfirmedAttempts.length > 0)
    assert.equal(execution.verdict.witnessedStatus, 'partial')
    assert.equal(execution.verdict.ok, true, describeViolations(execution))
  })
})
