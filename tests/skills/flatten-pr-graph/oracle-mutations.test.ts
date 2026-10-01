import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeFixture, FIXTURE_DIRECTORY } from './support/harness'
import { discoverFixtureModules } from './support/fixture'

/**
 * Oracle sensitivity. Each mutated fixture reports a success the observed state does
 * not support; the oracle must reject it and name the invariant that failed. A mutation
 * that slips through is an oracle hole, so the assertion is on detection, not on the
 * mutation's own opinion.
 */

async function mutations() {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const found = fixtures.filter((fixture) => fixture.spec.kind === 'mutation')
  assert.ok(found.length >= 7, `expected the full mutation set, found ${found.length}`)
  return found
}

test('every mutation is detected, and by the invariant it claims to break', async () => {
  for (const module of await mutations()) {
    const execution = await executeFixture(module)
    try {
      const expectedInvariant = module.spec.expect.mustDetectInvariant
      const detected = execution.verdict.violations.map((violation) => violation.invariant)
      assert.equal(
        execution.verdict.ok,
        false,
        `${module.spec.id} was accepted but should not have been`,
      )
      assert.ok(
        detected.includes(expectedInvariant),
        `${module.spec.id}: expected ${expectedInvariant}, detected ${JSON.stringify(detected)}`,
      )
      assert.equal(
        execution.verdict.witnessedStatus,
        module.spec.expect.status,
        `${module.spec.id}: witnessed ${execution.verdict.witnessedStatus}`,
      )
    } finally {
      await execution.world.cleanup()
    }
  }
})

test('a success flag never rescues a claim the state contradicts', async () => {
  const all = await mutations()
  const conflicted = all.find(
    (fixture) => fixture.spec.id === 'unresolved-conflict-reported-published',
  )
  const stale = all.find((fixture) => fixture.spec.id === 'stale-publication-claim')
  assert.ok(conflicted && stale)
  for (const module of [conflicted, stale]) {
    const execution = await executeFixture(module)
    try {
      const claim = execution.claim as { status: string }
      assert.equal(claim.status, 'published', `${module.spec.id} must claim success`)
      assert.equal(execution.verdict.ok, false, `${module.spec.id} must not be judged ok`)
      assert.ok(
        execution.verdict.violations.length > 0,
        `${module.spec.id} must record the contradicting evidence`,
      )
    } finally {
      await execution.world.cleanup()
    }
  }
})

test('an unselected ref write is caught even though the provider acknowledged it', async () => {
  const all = await mutations()
  const module = all.find((fixture) => fixture.spec.id === 'unselected-ref-write')
  assert.ok(module)
  const execution = await executeFixture(module)
  try {
    const changed = Object.entries(execution.world.remoteRefs()).filter(
      ([ref, oid]) => execution.baseline.refsBefore[ref] !== oid,
    )
    assert.ok(
      changed.some(([ref]) => ref === 'refs/heads/unrelated'),
      'the mutation must really move the unselected ref',
    )
    assert.ok(
      execution.verdict.violations.some(
        (violation) => violation.invariant === 'preservation.unselected-refs',
      ),
    )
  } finally {
    await execution.world.cleanup()
  }
})

test('a rewritten head is caught because the original commit is unreachable', async () => {
  const all = await mutations()
  const module = all.find((fixture) => fixture.spec.id === 'lost-original-commit')
  assert.ok(module)
  const execution = await executeFixture(module)
  try {
    const violation = execution.verdict.violations.find(
      (entry) => entry.invariant === 'preservation.original-commits',
    )
    assert.ok(violation, 'the lost original commit must be reported')
    assert.ok(
      execution.verdict.blockers.some((blocker) => blocker.code === 'lost-original-commit'),
      'losing an original commit is a blocker, not a note',
    )
  } finally {
    await execution.world.cleanup()
  }
})

test('running the suite during a flattening run is caught from the command record', async () => {
  const all = await mutations()
  const module = all.find((fixture) => fixture.spec.id === 'forbidden-check-execution')
  assert.ok(module)
  const execution = await executeFixture(module)
  try {
    assert.ok(execution.context.claimedCommands.includes('npm test'))
    const violations = execution.verdict.violations.filter(
      (violation) => violation.invariant === 'remote.actions-permitted',
    )
    assert.ok(violations.length >= 2, 'the command and the provider read are separate findings')
    assert.ok(
      violations.some((violation) => violation.observed.includes('npm test')),
      'the executed command must be named in the finding',
    )
  } finally {
    await execution.world.cleanup()
  }
})

test('a conflict left in the index is caught even when the report says published', async () => {
  const all = await mutations()
  const module = all.find((fixture) => fixture.spec.id === 'unresolved-conflict-reported-published')
  assert.ok(module)
  const execution = await executeFixture(module)
  try {
    assert.ok(
      execution.verdict.violations.some((violation) => violation.invariant === 'integrity.clean'),
      'the unresolved conflict must be detected',
    )
    assert.equal(execution.verdict.witnessedStatus, 'partial')
  } finally {
    await execution.world.cleanup()
  }
})
