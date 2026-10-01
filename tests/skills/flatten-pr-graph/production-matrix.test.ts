/**
 * The production matrix: issue #87 and issue #88, exercised against the shipped helpers.
 *
 * Every row here drives `prepareStack`, `publishStack`, or the measurement probe over a real
 * disposable bare remote and reads the outcome back out of Git, the provider double, and the
 * user's checkout. Nothing is mocked at the boundary under test, and nothing here reads a
 * helper's own claim about itself as proof: an expectation is frozen before the run, and the
 * case fails when the observed state does not match it.
 *
 * The cases live in `production.fixture.ts`. This file is the runner: one fresh world per
 * case, so no case can observe another's state, and no case leaves anything behind.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import {
  productionCases,
  type ProductionCase,
  type ProductionExpectation,
  type ProductionOutcome,
} from './production/production.fixture'
import { Production } from './support/production'
import { edgeViolations, schemaViolations, type PinnedEdge } from './support/production-verdict'
import { loadContractSchema } from './support/harness'
import { createWorld, type World } from './support/real-git'

const worlds: World[] = []

after(async () => {
  for (const world of worlds.splice(0)) await world.cleanup()
})

function report(
  testCase: ProductionCase,
  expected: ProductionExpectation,
  observed: ProductionOutcome,
): void {
  assert.equal(
    observed.status,
    expected.status,
    `${testCase.id}: status\nobserved errors: ${JSON.stringify(observed.details, null, 2)}`,
  )
  for (const code of expected.codes ?? []) {
    assert.ok(
      observed.codes.includes(code),
      `${testCase.id}: expected code ${code}, observed ${JSON.stringify(observed.codes)}`,
    )
  }
  if (expected.codesAny) {
    assert.ok(
      expected.codesAny.some((code: string) => observed.codes.includes(code)),
      `${testCase.id}: expected one of ${JSON.stringify(expected.codesAny)}, observed ${JSON.stringify(observed.codes)}`,
    )
  }
  for (const mention of expected.mentions ?? []) {
    const haystack = observed.details.join(' | ')
    assert.ok(
      haystack.includes(mention),
      `${testCase.id}: expected the report to name ${JSON.stringify(mention)}, observed ${haystack}`,
    )
  }
}

const schema = await loadContractSchema()

/**
 * The independent verdict: the documents the helper actually produced, checked against
 * the contract schema, and the hard dependency edges the authorized snapshot implied,
 * checked against the remote as it actually is. Neither reads a field the helper reported
 * about itself as proof.
 */
function independent(
  testCase: ProductionCase,
  world: World,
  observed: ProductionOutcome,
  pinned: PinnedEdge[],
): void {
  const schemaFailures = schemaViolations(schema, testCase.area, {
    preparation: observed.preparation,
    publication: observed.publication,
  })
  assert.deepEqual(
    schemaFailures.map((failure) => `${failure.detail}: ${failure.observed}`),
    [],
    `${testCase.id}: the produced document does not satisfy the contract schema`,
  )
  const edges = edgeViolations(world, pinned)
  assert.deepEqual(
    edges.map((edge) => `${edge.invariant}: ${edge.detail} (${edge.observed})`),
    [],
    `${testCase.id}: a hard dependency edge the authorized snapshot implied no longer holds`,
  )
}

function register(productionCase: ProductionCase): void {
  const label = `${productionCase.area}: ${productionCase.id}`
  test(label, async () => {
    const world = await createWorld(`production-${productionCase.area}-${productionCase.id}`)
    worlds.push(world)
    const production = new Production(world)
    const observed = await productionCase.run(production)
    report(productionCase, productionCase.expect, observed)
    independent(productionCase, world, observed, production.pinned())
  })
}

describe('flatten-pr-graph production matrix', () => {
  for (const productionCase of productionCases) register(productionCase)
})
