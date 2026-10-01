import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverFixtureModules, type FixtureModule } from './support/fixture'
import {
  createFixtureContext,
  executeFixture,
  FIXTURE_DIRECTORY,
  type FixtureExecution,
} from './support/harness'
import { defineProvider, integrateBranch, seedBranch } from './support/scenario'
import type { FakePullRequest } from './support/fake-github'
import {
  actionSummary,
  allValidOrders,
  loadHelperSource,
  objectiveTotals,
  planSelection,
  runHelper,
  SKILL_SCRIPTS,
  type PlanResult,
} from './support/planning'
import { CHECK_STATE_ACTIONS } from './support/actions'

/**
 * Issue #86's evidence-backed discovery and bounded ordering.
 *
 * Two separate things are proved here. The fixture matrix runs the shipped helpers
 * against real Git and a fake provider and lets the oracle judge the resulting plan,
 * including its hard edges, which come from pre-run evidence rather than from the report.
 * The property tests below then exercise the helpers themselves: exhaustiveness for a
 * declared objective, invariance under input permutation, invariance under check state,
 * and the boundaries where a zero would be a lie.
 */

const ROOT = 'refs/heads/main'

function pullRequest(number: number, head: string, base: string, author: string): FakePullRequest {
  return {
    number,
    title: `Feature ${number}`,
    state: 'OPEN',
    draft: false,
    base,
    head,
    headRepository: 'acme/widgets',
    author,
  }
}

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

test('every planning fixture is executed and judged against pre-run evidence', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const planning = fixtures.filter((fixture) => fixture.spec.id.startsWith('planning-'))
  assert.ok(planning.length >= 19, `expected the full planning matrix, found ${planning.length}`)
  for (const module of planning) {
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
      if (module.spec.expect.blockedCode) {
        assert.ok(
          execution.verdict.blockers.some(
            (blocker) => blocker.code === module.spec.expect.blockedCode,
          ),
          `${module.spec.id} must be blocked with ${module.spec.expect.blockedCode}, observed ${execution.verdict.blockers
            .map((entry) => entry.code)
            .join(', ')}`,
        )
      }
    })
  }
})

test('no planning fixture reads check state', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const planning = fixtures.filter((fixture) => fixture.spec.id.startsWith('planning-'))
  for (const module of planning) {
    await withFixture(module, (execution) => {
      const observed = execution.provider.actions.map((action) => action.kind)
      for (const kind of CHECK_STATE_ACTIONS) {
        assert.ok(
          !observed.includes(kind),
          `${module.spec.id} consulted ${kind}; check state is outside the permitted vocabulary`,
        )
      }
      assert.ok(
        !Object.keys(actionSummary(execution.context)).some((kind) => kind.startsWith('run-')),
        `${module.spec.id} performed a run action`,
      )
    })
  }
})

test('the order helper is exact only when the whole valid-order space was enumerated', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const module = fixtures.find(
    (fixture) => fixture.spec.id === 'planning-independent-pull-requests',
  )
  assert.ok(module, 'the independent-PR fixture must exist')
  await withFixture(module, (execution) => {
    const planning = planSelection(execution.context, { rootRef: ROOT, selection: [12, 13, 14] })
    const objective = planning.plan.plan?.objective
    assert.ok(objective, 'the helper must report an objective')
    assert.equal(
      objective.qualification,
      'exact-for-declared-objective',
      'three independent pull requests admit six orders, so enumeration is exhaustive',
    )
    assert.equal(objective.budget.exhausted, false)
    assert.equal(objective.unknownTreatedAsZero, false)
    assert.equal(
      objective.cumulative.kind,
      'pairwise-only',
      'a pairwise probe is not a cumulative measurement, and the plan must say so',
    )
    assert.equal(objective.cumulative.value, null)
  })
})

test('a bounded search is labelled best-found rather than exact', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const module = fixtures.find(
    (fixture) => fixture.spec.id === 'planning-budget-exhaustion-is-qualified',
  )
  assert.ok(module, 'the budget fixture must exist')
  await withFixture(module, (execution) => {
    const planning = planSelection(execution.context, {
      rootRef: ROOT,
      selection: [12, 13, 14],
      maxEnumeratedOrders: 2,
    })
    const plan = planning.plan.plan
    assert.ok(plan, 'budget exhaustion still yields a valid plan')
    assert.equal(plan.objective.qualification, 'best-found')
    assert.equal(plan.objective.budget.exhausted, true)
    assert.equal(plan.order.length, 3)
  })
})

test('the chosen order is minimal over every valid order for the declared objective', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const module = fixtures.find(
    (fixture) => fixture.spec.id === 'planning-independent-pull-requests',
  )
  assert.ok(module, 'the independent-PR fixture must exist')
  await withFixture(module, (execution) => {
    const planning = planSelection(execution.context, { rootRef: ROOT, selection: [12, 13, 14] })
    const plan = planning.plan.plan
    assert.ok(plan)
    const admissible = allValidOrders([12, 13, 14], planning.discovery.edges)
    assert.equal(admissible.length, 6, 'three independent pull requests admit six orders')
    const inputs = {
      root: ROOT,
      bases: Object.fromEntries(planning.identities.map((entry) => [entry.number, entry.baseRef])),
      heads: Object.fromEntries(planning.identities.map((entry) => [entry.number, entry.headRef])),
      pushes: Object.fromEntries(planning.identities.map((entry) => [entry.number, true])),
      estimates: planning.probes,
    }
    const ranked = admissible
      .map((order) => ({ order, totals: objectiveTotals(order, inputs) }))
      .sort(
        (left, right) =>
          left.totals.work - right.totals.work ||
          left.totals.disruption - right.totals.disruption ||
          left.order.join(',').localeCompare(right.order.join(',')),
      )
    assert.deepEqual(plan.order, ranked[0].order)
    assert.ok(
      ranked.some((candidate) => candidate.totals.work > 0),
      'the fixture only means something if one pair genuinely conflicts and another does not',
    )
  })
})

test('the order helper is a function of the evidence, not of the order arrays arrived in', async () => {
  const evidence = {
    contractVersion: 'flatten-pr-graph/1',
    root: ROOT,
    declaredBases: {
      '12': ROOT,
      '13': 'refs/heads/shared',
      '14': 'refs/heads/shared',
      '15': ROOT,
    },
    headRefs: {
      '12': 'refs/heads/shared',
      '13': 'refs/heads/left',
      '14': 'refs/heads/right',
      '15': 'refs/heads/join',
    },
    hardDependencies: [
      { before: 13, after: 15, source: 'pr-base', evidence: 'declared base' },
      { before: 14, after: 15, source: 'pr-base', evidence: 'declared base' },
    ],
    estimates: [
      { pair: [13, 14], kind: 'pairwise-probe', value: 5, confidence: 'high' },
      { pair: [12, 13], kind: 'pairwise-probe', value: 0, confidence: 'high' },
      { pair: [12, 14], kind: 'pairwise-probe', value: 0, confidence: 'high' },
    ],
    integrationPushes: { '13': true, '14': true, '15': true },
  }
  const forward = runHelper<PlanResult>('plan-order.mjs', {
    ...evidence,
    selected: [12, 13, 14, 15],
  })
  const reversed = runHelper<PlanResult>('plan-order.mjs', {
    ...evidence,
    selected: [15, 14, 13, 12],
  })
  assert.equal(forward.status, 0)
  assert.deepEqual(forward.result, reversed.result)
})

test('every check-state variant produces an identical plan and no check query', async () => {
  const states = ['passing', 'failing', 'pending', 'unavailable'] as const
  const signatures: string[] = []
  for (const state of states) {
    const { context, world } = await createFixtureContext(`check-state-${state}`)
    try {
      defineProvider(context, {
        checkStates: { '12': state, '13': state },
        pullRequests: [
          pullRequest(12, 'feat-a', 'main', 'alice'),
          pullRequest(13, 'feat-b', 'main', 'bob'),
        ],
      })
      await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
      await seedBranch(context, 'seed-b', 'feat-b', { 'shared.txt': 'b\n' }, 'Add B')
      const planning = planSelection(context, { rootRef: ROOT, selection: [12, 13] })
      signatures.push(JSON.stringify({ plan: planning.plan, actions: context.provider.actions }))
    } finally {
      await world.cleanup()
    }
  }
  assert.equal(new Set(signatures).size, 1, 'check state changed the plan or the actions')
})

test('a planner that consults check state is recorded as an out-of-vocabulary action', async () => {
  const { context, world } = await createFixtureContext('check-state-consulted')
  try {
    defineProvider(context, {
      checkStates: { '12': 'failing' },
      pullRequests: [pullRequest(12, 'feat-a', 'main', 'alice')],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    planSelection(context, { rootRef: ROOT, selection: [12], consultCheckState: true })
    assert.ok(
      context.provider.actions.some((action) => action.kind === 'read-check-state'),
      'reading check state must leave a record whatever the provider answers',
    )
  } finally {
    await world.cleanup()
  }
})

test('an unprobeable pair is kept as unknown rather than counted as free', () => {
  const document = {
    contractVersion: 'flatten-pr-graph/1',
    root: ROOT,
    selected: [12, 13, 14],
    declaredBases: { '12': ROOT, '13': ROOT, '14': ROOT },
    headRefs: { '12': 'refs/heads/a', '13': 'refs/heads/b', '14': 'refs/heads/c' },
    hardDependencies: [],
    estimates: [
      { pair: [12, 13], kind: 'pairwise-probe', value: 0, confidence: 'high' },
      { pair: [12, 14], kind: 'pairwise-probe', value: 0, confidence: 'high' },
      { pair: [13, 14], kind: 'unknown', value: null, confidence: 'unknown' },
    ],
    integrationPushes: { '12': true, '13': true, '14': true },
  }
  const planned = runHelper<PlanResult>('plan-order.mjs', document)
  assert.equal(planned.status, 0)
  const order = planned.result.plan?.order ?? []
  assert.equal(order.length, 3)
  assert.ok(
    !(order.indexOf(13) < order.indexOf(14) && order.indexOf(13) + 1 === order.indexOf(14)) &&
      !(order.indexOf(14) < order.indexOf(13) && order.indexOf(14) + 1 === order.indexOf(13)),
    `the chosen order must not put the unprobeable pair adjacent when it can avoid doing so: ${JSON.stringify(order)}`,
  )
  assert.equal(
    planned.result.plan?.objective.componentTotals.unknownEstimates,
    0,
    'avoiding the unknown pair costs nothing in unknowns',
  )

  // When every pair is unprobeable, the plan still orders the identities but says so:
  // a zero work total with two unknowns is not a claim that the work is free.
  const allUnknown = runHelper<PlanResult>('plan-order.mjs', {
    ...document,
    estimates: [
      { pair: [12, 13], kind: 'unknown', value: null, confidence: 'unknown' },
      { pair: [12, 14], kind: 'unknown', value: null, confidence: 'unknown' },
      { pair: [13, 14], kind: 'unknown', value: null, confidence: 'unknown' },
    ],
  })
  const totals = allUnknown.result.plan?.objective.componentTotals
  assert.equal(totals?.unknownEstimates, 2, 'both adjacent pairs of the chosen order are unknown')
  assert.equal(totals?.estimatedConflictResolutionWork, 0)
  assert.equal(allUnknown.result.plan?.objective.unknownTreatedAsZero, false)
})

test('two estimates for one pair are contradictory evidence, not a preference', () => {
  const refused = runHelper<PlanResult>('plan-order.mjs', {
    contractVersion: 'flatten-pr-graph/1',
    root: ROOT,
    selected: [12, 13],
    declaredBases: { '12': ROOT, '13': ROOT },
    headRefs: { '12': 'refs/heads/a', '13': 'refs/heads/b' },
    hardDependencies: [],
    estimates: [
      { pair: [12, 13], kind: 'pairwise-probe', value: 1, confidence: 'high' },
      { pair: [13, 12], kind: 'pairwise-probe', value: 9, confidence: 'low' },
    ],
    integrationPushes: { '13': true },
  })
  assert.equal(refused.status, 3)
  assert.equal(refused.result.ok, false)
  assert.equal(refused.result.errors[0].code, 'contradictory-graph')
})

/**
 * A conflict is work. The estimate must never come back as a clean zero, and a path Git
 * quoted or padded must survive as the opaque bytes Git reported.
 */
test('a conflict is estimated as positive work and a quoted path survives intact', async () => {
  const { context, world } = await createFixtureContext('conflicting-pair')
  try {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    // A path with a space and a tab: Git quotes such names unless asked not to.
    await seedBranch(context, 'seed-a', 'feat-a', { 'we ird\tname.txt': 'from a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'we ird\tname.txt': 'from b\n' }, 'Add B')
    const planning = planSelection(context, { rootRef: ROOT, selection: [12, 13] })
    const estimate = planning.probes.find((probe) => probe.pair[0] === 12)
    assert.ok(estimate, 'the pair must have been probed')
    assert.equal(estimate.structuralConflict, true)
    assert.ok(
      (estimate.value ?? 0) > 0,
      `a conflict is never valued at zero: ${JSON.stringify(estimate)}`,
    )
    assert.deepEqual(
      estimate.conflictingPaths,
      ['we ird\tname.txt'],
      'the conflicting path must survive exactly as Git reported it, tab and all',
    )
  } finally {
    await world.cleanup()
  }
})

test('a delete/modify conflict costs work rather than reading as a clean path list', async () => {
  const { context, world } = await createFixtureContext('structural-conflict')
  try {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    // The file is in the shared base, so one side rewriting it and the other deleting
    // it is a genuine modify/delete conflict rather than a fast-forward.
    await seedBranch(context, 'seed-base', 'shared-base', { 'shared.txt': 'base\n' }, 'Add shared')
    await integrateBranch(context, 'land-base', 'main', 'shared-base')
    await seedBranch(context, 'seed-a', 'feat-a', { 'shared.txt': 'from a\n' }, 'Rewrite shared')
    await seedBranch(context, 'seed-b', 'feat-b', { 'other.txt': 'b\n' }, 'Add B')
    const deleter = await context.scratch('remove-shared')
    deleter.checkout('feat-b')
    world.gitIn(deleter.path, 'rm', '-q', 'shared.txt')
    world.gitIn(deleter.path, 'commit', '-qm', 'Remove shared')
    deleter.push('feat-b')
    const planning = planSelection(context, { rootRef: ROOT, selection: [12, 13] })
    const estimate = planning.probes.find((probe) => probe.pair[0] === 12)
    assert.ok(estimate, 'the pair must have been probed')
    assert.equal(estimate.structuralConflict, true)
    assert.ok((estimate.value ?? 0) > 0, `never zero: ${JSON.stringify(estimate)}`)
  } finally {
    await world.cleanup()
  }
})

test('a cyclic graph is refused with a structured error and no order', () => {
  const refused = runHelper<PlanResult>('plan-order.mjs', {
    contractVersion: 'flatten-pr-graph/1',
    root: ROOT,
    selected: [12, 13],
    declaredBases: { '12': 'refs/heads/a', '13': 'refs/heads/b' },
    headRefs: { '12': 'refs/heads/a', '13': 'refs/heads/b' },
    hardDependencies: [
      { before: 12, after: 13, source: 'pr-base', evidence: 'declared base' },
      { before: 13, after: 12, source: 'pr-base', evidence: 'declared base' },
    ],
    estimates: [],
    integrationPushes: {},
  })
  assert.equal(refused.status, 3)
  assert.equal(refused.result.ok, false)
  assert.equal(refused.result.plan, undefined)
  assert.equal(refused.result.errors[0].code, 'contradictory-graph')
})

/** Untrusted text is data. Nothing in a name or a body is ever interpreted. */
test('helper input is compared, never evaluated', () => {
  const hostile = 'refs/heads/x$(touch /tmp/flatten-pr-graph-pwned)`id`'
  const refused = runHelper<PlanResult>('plan-order.mjs', {
    contractVersion: 'flatten-pr-graph/1',
    root: ROOT,
    selected: [12],
    declaredBases: { '12': hostile },
    headRefs: { '12': hostile },
    hardDependencies: [],
    estimates: [],
    integrationPushes: {},
  })
  assert.equal(refused.status, 2, 'a ref name Git itself rejects is refused, not executed')
  assert.equal(refused.result.errors[0].code, 'invalid-input')
})

/** The root is discovered by the caller and passed in; it is never assumed here. */
test('discovery refuses to assume a root branch', async () => {
  const { context, world } = await createFixtureContext('missing-root')
  try {
    defineProvider(context, { pullRequests: [pullRequest(12, 'feat-a', 'main', 'alice')] })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    const refused = runHelper<{ errors: Array<{ code: string; detail: string }> }>(
      'discover-dependencies.mjs',
      {
        contractVersion: 'flatten-pr-graph/1',
        repository: world.remote,
        selected: [{ number: 12, headRef: 'refs/heads/feat-a', baseRef: ROOT }],
      },
    )
    assert.equal(refused.status, 2)
    assert.equal(refused.result.errors[0].code, 'invalid-input')
    assert.match(refused.result.errors[0].detail, /root is required/)
  } finally {
    await world.cleanup()
  }
})

/** A real repository may carry a branch name with `+` or non-ASCII characters. */
test('a valid non-ASCII or plus-bearing ref name is accepted, not refused', async () => {
  const { context, world } = await createFixtureContext('exotic-ref-names')
  try {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat+wip', 'main', 'alice'),
        pullRequest(13, 'ünïcode', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat+wip', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-unicode', 'ünïcode', { 'b.txt': 'b\n' }, 'Add B')
    const planning = planSelection(context, { rootRef: ROOT, selection: [12, 13] })
    assert.equal(
      planning.discovery.errors.length,
      0,
      `Git's own ref rules decide validity: ${JSON.stringify(planning.discovery.errors)}`,
    )
    assert.ok(planning.plan.plan?.order, 'the exotic heads still plan')
  } finally {
    await world.cleanup()
  }
})

/** Two distinct branches at one commit are redundant, not a dependency in either direction. */
test('equal head OIDs on distinct branches are reported redundant, with no edge', async () => {
  const { context, world } = await createFixtureContext('equal-head-oids')
  try {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'restate-a', 'main', 'alice'),
        pullRequest(13, 'restate-b', 'main', 'alice'),
      ],
    })
    await seedBranch(context, 'seed-a', 'restate-a', { 'shared.txt': 'one\n' }, 'Add shared')
    // A second branch at the very same commit: neither head can contain the other.
    const twin = await context.scratch('twin')
    twin.checkout('restate-a')
    world.gitIn(twin.path, 'branch', 'restate-b')
    twin.push('restate-b')
    const planning = planSelection(context, { rootRef: ROOT, selection: [12, 13] })
    assert.equal(planning.discovery.redundantHeads.length, 1)
    assert.deepEqual(planning.discovery.redundantHeads[0].numbers, [12, 13])
    assert.equal(
      planning.discovery.edges.length,
      0,
      'neither head contains the other, so there is no edge',
    )
  } finally {
    await world.cleanup()
  }
})

/** One branch serving two identities cannot hold two positions in a chain. */
test('one head branch serving two identities is unsupported input', async () => {
  const { context, world } = await createFixtureContext('shared-head-branch')
  try {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'shared', 'main', 'alice'),
        pullRequest(13, 'shared', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-shared', 'shared', { 'a.txt': 'a\n' }, 'Add A')
    const planning = planSelection(context, { rootRef: ROOT, selection: [12, 13] })
    assert.equal(planning.discovery.equalHeads.length, 1)
    assert.equal(planning.discovery.equalHeads[0].state, 'unsupported-shared-branch')
    assert.ok(
      planning.discovery.errors.some((error) => error.code === 'unsupported-input'),
      'one branch cannot take two chain positions',
    )
  } finally {
    await world.cleanup()
  }
})

/**
 * A verified prerequisite is an explicit fact. Two independent commits can still be
 * functionally dependent; only observed ancestry in the opposite direction contradicts it.
 */
test('a verified prerequisite between independent commits is an edge, and only reverse ancestry contradicts it', async () => {
  const { context, world } = await createFixtureContext('verified-prerequisite')
  try {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    const planning = planSelection(context, {
      rootRef: ROOT,
      selection: [12, 13],
      verifiedPrerequisites: [
        { before: 12, after: 13, evidence: 'a release note records the dependency' },
      ],
    })
    assert.ok(
      planning.discovery.edges.some(
        (edge) =>
          edge.before === 12 && edge.after === 13 && edge.source === 'verified-prerequisite',
      ),
      `independent commits can still be functionally dependent: ${JSON.stringify(planning.discovery.edges)}`,
    )
    assert.deepEqual(planning.plan.plan?.order, [12, 13])
  } finally {
    await world.cleanup()
  }
})

test('a verified prerequisite contradicted by reverse ancestry is a reported contradiction', async () => {
  const { context, world } = await createFixtureContext('contradicted-prerequisite')
  try {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    // #13 really does contain #12's head, so a claim that #13 must precede #12 is
    // contradicted by observed ancestry rather than merely unproven.
    await integrateBranch(context, 'contradict', 'feat-b', 'feat-a')
    const planning = planSelection(context, {
      rootRef: ROOT,
      selection: [12, 13],
      verifiedPrerequisites: [
        { before: 13, after: 12, evidence: 'a note claims the reverse order' },
      ],
    })
    assert.ok(
      planning.discovery.errors.some((error) => error.code === 'contradictory-graph'),
      'the dependent already contains its alleged prerequisite',
    )
  } finally {
    await world.cleanup()
  }
})

/** The shipped scripts are what runs, not a copy the test keeps beside itself. */
test('the helpers under test are the shipped skill scripts', async () => {
  const { SKILL_SCRIPTS, loadHelperSource } = await import('./support/planning')
  assert.match(
    loadHelperSource('discover-dependencies.mjs'),
    /export function discoverDependencies/,
  )
  assert.match(loadHelperSource('measure-conflict.mjs'), /export function measureConflicts/)
  assert.match(loadHelperSource('plan-order.mjs'), /export function planOrder/)
  assert.ok(SKILL_SCRIPTS.endsWith('.agents/skills/flatten-pr-graph/scripts'))
})
