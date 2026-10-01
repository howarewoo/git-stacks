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
import {
  actionViolations,
  checkStateViolations,
  edgeViolations,
  schemaViolations,
  statusViolations,
  type PinnedEdge,
} from './support/production-verdict'
import { FakeGitHub, type ProviderState } from './support/fake-github'
import type { ProviderAction } from './support/production'

/** What the evidence said before the case ran anything. */
interface ProductionBaseline {
  pinned: PinnedEdge[]
  refs: Record<string, string>
}
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
  baseline: ProductionBaseline,
): void {
  const pinned = baseline.pinned
  const schemaFailures = schemaViolations(schema, testCase.area, {
    preparation: observed.preparation,
    publication: observed.publication,
  })
  assert.deepEqual(
    schemaFailures.map((failure) => `${failure.detail}: ${failure.observed}`),
    [],
    `${testCase.id}: the produced document does not satisfy the contract schema`,
  )
  const edges = edgeViolations(world, baseline)
  assert.deepEqual(
    edges.map((edge) => `${edge.invariant}: ${edge.detail} (${edge.observed})`),
    [],
    `${testCase.id}: a hard dependency edge the authorized snapshot implied no longer holds`,
  )

  if (!observed.confirmed) return

  // Every write the document says the server confirmed, checked against the provider's own
  // action log and the remote. This is the low-level action oracle: it is not a result
  // document check, and it does not pretend the raw helpers produce one.
  const refs = world.remoteRefs()
  const actions = actionViolations(observed.confirmed, {
    actions: (observed.providerActions ?? []) as ProviderAction[],
    refs,
    trace: observed.nativeTrace ?? [],
  })
  assert.deepEqual(
    actions.map((action) => `${action.invariant}: ${action.detail} (${action.observed})`),
    [],
    `${testCase.id}: the run confirms a write the server or the remote does not record`,
  )

  if (observed.preparedHeads) {
    const status = statusViolations(
      { status: observed.status },
      { preparedHeads: observed.preparedHeads, branches: productionBranches(pinned) },
      refs,
    )
    assert.deepEqual(
      status.map((entry) => `${entry.invariant}: ${entry.detail} (${entry.observed})`),
      [],
      `${testCase.id}: the reported status is one the remote contradicts`,
    )
  }

  // No check state, merge queue, ruleset, or branch protection may be read at all. A run
  // that looked and then ignored the answer has still crossed the line.
  const checker = new FakeGitHub({
    owner: 'fixture',
    name: 'stacks',
    defaultBranch: 'main',
    perPage: 30,
    pullRequests: [],
    deniedWrites: [],
    autoMergeEnabledOn: [],
    checkStates: {},
  } as ProviderState)
  for (const action of observed.providerActions ?? []) {
    checker.recordAction(action.kind as never, action.target, action.outcome as never)
  }
  assert.deepEqual(
    checkStateViolations(checker).map((entry) => `${entry.detail} (${entry.observed})`),
    [],
    `${testCase.id}: the run read a check state`,
  )
}

/** The branch each pinned pull request publishes, keyed by its number. */
function productionBranches(pinned: PinnedEdge[]): Record<number, string> {
  return Object.fromEntries(pinned.map((pr) => [pr.number, pr.head]))
}

function register(productionCase: ProductionCase): void {
  const label = `${productionCase.area}: ${productionCase.id}`
  test(label, async () => {
    const world = await createWorld(`production-${productionCase.area}-${productionCase.id}`)
    worlds.push(world)
    const production = new Production(world)
    // Frozen before the case runs anything. The edges this run has to keep are the ones
    // the pre-run evidence implied; reading them off the remote after the run would let the
    // run's own new ancestry define its baseline, and an edge it destroyed would disappear
    // from the comparison along with the evidence that it was destroyed.
    const baseline: ProductionBaseline = {
      pinned: production.pinned(),
      refs: world.remoteRefs(),
    }
    const observed = await productionCase.run(production)
    report(productionCase, productionCase.expect, observed)
    independent(
      productionCase,
      world,
      {
        ...observed,
        // Read out of the provider double and the process shim by the driver, so neither
        // depends on the case remembering to hand them over.
        providerActions: observed.providerActions ?? production.observedActions(),
        nativeTrace: production.nativeTrace(),
      },
      baseline,
    )
  })
}

describe('flatten-pr-graph production matrix', () => {
  for (const productionCase of productionCases) register(productionCase)
})
