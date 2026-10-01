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
} from './production.fixture'
import { Production } from './support/production'
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
      expected.codesAny.some((code) => observed.codes.includes(code)),
      `${testCase.id}: expected one of ${JSON.stringify(expected.codesAny)}, observed ${JSON.stringify(observed.codes)}`,
    )
  }
  if (expected.detail !== undefined) {
    const haystack = observed.details.join(' | ')
    assert.ok(
      haystack.includes(expected.detail),
      `${testCase.id}: expected a report containing ${JSON.stringify(expected.detail)}, observed ${haystack}`,
    )
  }
}

function register(productionCase: ProductionCase): void {
  const label = `${productionCase.area}: ${productionCase.id}`
  test(label, async () => {
    const world = await createWorld(`production-${productionCase.area}-${productionCase.id}`)
    worlds.push(world)
    const observed = await new Production(world).run(productionCase.run)
    report(productionCase, productionCase.expect, observed)
  })
}

describe('flatten-pr-graph production matrix', () => {
  for (const productionCase of productionCases) register(productionCase)
})

describe('the production matrix is complete', () => {
  test('every case declares the acceptance rows and findings it pins', () => {
    for (const productionCase of productionCases) {
      assert.ok(productionCase.id.length > 0)
      assert.ok(productionCase.criteria.length > 0, `${productionCase.id} declares no criterion`)
      assert.ok(Array.isArray(productionCase.findings))
      assert.ok(productionCase.expect.status.length > 0, `${productionCase.id} expects no status`)
    }
  })

  test('no case id repeats', () => {
    const ids = productionCases.map((productionCase) => productionCase.id)
    assert.deepEqual(ids, [...new Set(ids)], 'a duplicate id would silently drop a case')
  })

  test('every blocked case names a precise expected outcome rather than "anything goes"', () => {
    for (const productionCase of productionCases) {
      if (productionCase.expect.status === 'prepared' || productionCase.expect.status === 'published') {
        continue
      }
      const reasons = (productionCase.expect.codes ?? []).length + (productionCase.expect.codesAny ?? []).length + (productionCase.expect.detail === undefined ? 0 : 1)
      assert.ok(reasons > 0, `${productionCase.id} blocks without saying why`)
    }
  })

  test('every preparation case states whether it touches the user checkout', () => {
    for (const productionCase of productionCases) {
      if (productionCase.area !== 'preparation') continue
      assert.ok(
        productionCase.criteria.some((criterion) => criterion.startsWith('#87')),
        `${productionCase.id} cites no #87 acceptance row`,
      )
    }
  })
})