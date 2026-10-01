/**
 * The dependency-discovery and ordering fixture matrix.
 *
 * Every entry is one row of issue #86's required coverage. Each seeds real Git and
 * fake-provider state, then runs the skill's own helper scripts against it and reports
 * the contract document a conforming planner would produce. The oracle judges that
 * document independently; a fixture never declares its own verdict.
 *
 * All of these are `intent: 'preview'`: planning is read-only, so every one of them must
 * leave refs, the provider, and the user's checkout alone.
 */

import { CONTRACT_VERSION } from '../support/contract-types'
import type {
  BlockedCode,
  Plan,
  PlanWrite,
  ResultDocument,
  Snapshot,
} from '../support/contract-types'
import { captureSnapshot, notPerformed, resultDocument } from '../support/documents'
import { RUBRIC_PATH, type FixtureContext, type FixtureModule } from '../support/fixture'
import { PERMITTED_ACTIONS } from '../support/actions'
import {
  defineProvider,
  integrateBranch,
  planFrom,
  remoteOid,
  seedBranch,
} from '../support/scenario'
import { planSelection, reconcileHeads, type PlanningRun } from '../support/planning'
import type { FakePullRequest } from '../support/fake-github'

const AT = '2026-10-01T09:00:00.000Z'
const READ_ONLY = PERMITTED_ACTIONS.filter(
  (action) => action !== 'update-pr-base' && action !== 'push-selected-head',
)

/** Blocked codes the result schema accepts; a helper error outside them is evidence. */
const KNOWN_BLOCKED_CODES: ReadonlySet<string> = new Set<BlockedCode>([
  'missing-selection',
  'unsupported-input',
  'missing-permission',
  'missing-external-prerequisite',
  'missing-history',
  'contradictory-graph',
  'ambiguous-ownership',
  'stale-snapshot',
  'active-landing-arrangement',
  'unresolved-conflict',
  'conflicting-environment-control',
  'lost-original-commit',
])

function pullRequest(
  number: number,
  head: string,
  base: string,
  author: string,
  overrides: Partial<{
    draft: boolean
    state: 'OPEN' | 'CLOSED' | 'MERGED'
    headRepository: string
  }> = {},
): FakePullRequest {
  return {
    number,
    title: `Feature ${number}`,
    state: overrides.state ?? 'OPEN',
    draft: overrides.draft ?? false,
    base,
    head,
    headRepository: overrides.headRepository ?? 'acme/widgets',
    author,
  }
}

interface PlannedOptions {
  selection: string[]
  planning: PlanningRun
  /** Snapshot facts the run established that the default builder cannot observe. */
  snapshotFacts?: {
    externalPrerequisites?: Snapshot['externalPrerequisites']
    unselectedDependents?: Snapshot['unselectedDependents']
    capabilityLimitations?: Snapshot['capabilityLimitations']
    reconcile?: Array<{ ref: string; observed: string }>
  }
  /** An edge set the run reports; the oracle compares it against the pre-run evidence. */
  hardDependencies?: Plan['hardDependencies']
  ambiguities?: Plan['ambiguities']
  blockedReasons?: NonNullable<ResultDocument['blockedReasons']>
  uncertainty?: NonNullable<ResultDocument['uncertainty']>
  nextSafeAction?: ResultDocument['nextSafeAction']
}

/**
 * The document a planning run reports: a snapshot, a plan, and everything it could not
 * establish. A helper error whose code the schema accepts becomes a blocked reason; any
 * other helper error is reported as an ambiguity rather than invented into one.
 */
function planned(context: FixtureContext, options: PlannedOptions): ResultDocument {
  const { planning } = options
  const snapshot = captureSnapshot(context, {
    intent: 'preview',
    capturedAt: AT,
    selection: options.selection,
    unselectedDependents:
      options.snapshotFacts?.unselectedDependents ??
      planning.discovery.unselectedDependents.map((entry) => ({
        number: entry.number,
        dependsOn: entry.dependsOn,
        basis: entry.basis,
        reportedOnly: true as const,
      })),
    capabilityLimitations:
      options.snapshotFacts?.capabilityLimitations ??
      (planning.enumeration.limitation ? [planning.enumeration.limitation] : []),
    ...(options.snapshotFacts?.externalPrerequisites
      ? { externalPrerequisites: options.snapshotFacts.externalPrerequisites }
      : {}),
    ...(options.snapshotFacts?.reconcile ? { reconcile: options.snapshotFacts.reconcile } : {}),
  })

  const helperErrors = [...planning.discovery.errors, ...planning.plan.errors]
  const blockedReasons = [
    ...(options.blockedReasons ?? []),
    ...helperErrors
      .filter((error) => KNOWN_BLOCKED_CODES.has(error.code))
      .map((error) => ({
        code: error.code as BlockedCode,
        detail: error.detail,
        evidence: error.evidence,
      })),
  ]
  const reportedAmbiguities = [
    ...(options.ambiguities ?? []),
    ...helperErrors
      .filter((error) => !KNOWN_BLOCKED_CODES.has(error.code))
      .map((error) => ({ item: error.code, why: `${error.detail} (${error.evidence})` })),
  ]

  const order = planning.plan.plan
  const writes: PlanWrite[] = (order?.chain ?? []).map((step) =>
    step.change === 'none'
      ? {
          kind: 'ref-update',
          target: step.toBase,
          change: 'none',
          reason: `#${step.number} already sits on its predecessor's head`,
        }
      : {
          kind: 'pr-base-update',
          target: String(step.number),
          change: 'base-change',
          reason: `retarget #${step.number} from ${step.fromBase} onto ${step.toBase}`,
        },
  )
  const objective: Plan['objective'] =
    order?.objective ??
    ({
      declared: [
        'estimated-conflict-resolution-work',
        'unnecessary-history-disruption',
        'stable-tie-break',
      ],
      estimates: [],
      componentTotals: {
        estimatedConflictResolutionWork: 0,
        historyDisruption: 0,
        unknownEstimates: planning.probes.filter((probe) => probe.kind === 'unknown').length,
      },
      cumulative: {
        kind: 'pairwise-only',
        value: null,
        why: 'discovery found no plan, so no order cost is known',
      },
      qualification: 'heuristic',
      budget: {
        probes: 0,
        exhausted: false,
        ordersEnumerated: 0,
        orderEvaluations: 0,
        orderEvaluationLimit: 20_000,
        search: 'stable-topological-baseline',
      },
      unknownTreatedAsZero: false,
    } satisfies Plan['objective'])

  return resultDocument({
    status: blockedReasons.length > 0 || !order ? 'blocked' : 'planned',
    intent: 'preview',
    snapshot,
    plan: planFrom(snapshot, order?.order ?? [], writes, {
      prohibitedActivitiesNotPerformed: notPerformed(),
      hardDependencies: options.hardDependencies ?? order?.hardDependencies ?? [],
      ambiguities: reportedAmbiguities,
      objective,
      capabilityLimitations: planning.enumeration.limitation
        ? [planning.enumeration.limitation]
        : [],
    }),
    ...(blockedReasons.length > 0 ? { blockedReasons } : {}),
    uncertainty: options.uncertainty ?? [
      {
        item: 'cumulative conflict cost of the chosen order',
        why: 'pairwise probes estimate one merge each; the prepared cumulative stack is measured later',
      },
      {
        item: 'semantic correctness of every resolution',
        why: 'only the human rubric judges this',
      },
    ],
    nextSafeAction:
      options.nextSafeAction ??
      (blockedReasons.length > 0
        ? { action: 'report the blocker and stop', requires: [] }
        : {
            action: 'await explicit execution intent before any write',
            requires: ['an execute request'],
          }),
  })
}

const chainRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-linear-chain',
    title: 'A declared chain is discovered from real bases, not from listing order',
    matrixEntry: 'chains',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'expand-selection', 'push-root'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      // #13 is listed first, so listing order and the dependency order disagree.
      pullRequests: [
        pullRequest(13, 'feat-b', 'feat-a', 'bob'),
        pullRequest(12, 'feat-a', 'main', 'alice'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await integrateBranch(context, 'integrate-b', 'feat-b', 'feat-a')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13] }),
    })
  },
}

const independentRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-independent-pull-requests',
    title: 'Independent pull requests get a stable, probe-informed order',
    matrixEntry: 'independent PRs',
    kind: 'matrix',
    selection: ['12', '13', '14'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'expand-selection'],
      chain: [13, 12, 14],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.chain',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
        pullRequest(14, 'feat-c', 'main', 'alice'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    // #13 and #14 both rewrite shared.txt, so that pair conflicts and the others do not.
    await seedBranch(context, 'seed-b', 'feat-b', { 'shared.txt': 'from b\n' }, 'Add B')
    await seedBranch(context, 'seed-c', 'feat-c', { 'shared.txt': 'from c\n' }, 'Add C')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13', '14'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13, 14] }),
    })
  },
}

const fanOutRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-fan-out',
    title: 'Fan-out edges all precede their dependent',
    matrixEntry: 'fan-out',
    kind: 'matrix',
    selection: ['12', '13', '14'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12, 13, 14],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'feat-a', 'bob'),
        pullRequest(14, 'feat-c', 'feat-a', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-c', 'feat-c', { 'c.txt': 'c\n' }, 'Add C')
    await integrateBranch(context, 'integrate-b', 'feat-b', 'feat-a')
    await integrateBranch(context, 'integrate-c', 'feat-c', 'feat-a')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13', '14'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13, 14] }),
    })
  },
}

const diamondRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-diamond-fan-in',
    title: 'A diamond keeps both incoming edges and the shared ancestor first',
    matrixEntry: 'fan-in/diamonds with shared commits',
    kind: 'matrix',
    selection: ['12', '13', '14', '15'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12, 13, 14, 15],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'shared', 'main', 'alice'),
        pullRequest(13, 'left', 'shared', 'bob'),
        pullRequest(14, 'right', 'shared', 'carol'),
        pullRequest(15, 'join', 'main', 'dave'),
      ],
    })
    await seedBranch(context, 'seed-shared', 'shared', { 'shared.txt': 'base\n' }, 'Add shared')
    await seedBranch(context, 'seed-left', 'left', { 'left.txt': 'left\n' }, 'Add left')
    await seedBranch(context, 'seed-right', 'right', { 'right.txt': 'right\n' }, 'Add right')
    await seedBranch(context, 'seed-join', 'join', { 'join.txt': 'join\n' }, 'Add join')
    await integrateBranch(context, 'integrate-left', 'left', 'shared')
    await integrateBranch(context, 'integrate-right', 'right', 'shared')
    // The join contains both sides, so both edges are real strict ancestry.
    await integrateBranch(context, 'integrate-join-left', 'join', 'left')
    await integrateBranch(context, 'integrate-join-right', 'join', 'right')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13', '14', '15'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13, 14, 15] }),
      uncertainty: [
        {
          item: 'which diamond branch should sit immediately before the join',
          why: 'both are valid under the declared objective; the stable tie-break decides, and that is a preference rather than a requirement',
        },
        {
          item: 'cumulative conflict cost of the chosen order',
          why: 'pairwise probes estimate one merge each; the prepared cumulative stack is measured later',
        },
      ],
    })
  },
}

const sharedCommitsRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-shared-commits',
    title: 'Heads sharing history below their divergence are not dependent on each other',
    matrixEntry: 'shared commits',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'alice'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    // Both descend from main through the same commit; neither contains the other.
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13] }),
    })
  },
}

const sharedBranchRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-one-shared-head-branch',
    title: 'One head branch serving two identities is unsupported, not ordered',
    matrixEntry: 'equal heads',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'expand-selection'],
      chain: [],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'unsupported-input',
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'shared', 'main', 'alice'),
        pullRequest(13, 'shared', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-shared', 'shared', { 'shared.txt': 'one\n' }, 'Shared work')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13] }),
      uncertainty: [
        {
          item: 'two selected pull requests share one head branch',
          why: 'one branch cannot hold two chain positions, so no edge is fabricated in either direction and nothing is dropped',
        },
      ],
      nextSafeAction: {
        action: 'report the shared head branch and ask which pull request owns it',
        requires: ['two distinct head branches'],
      },
    })
  },
}

const redundantHeadsRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-equal-head-commits',
    title: 'Two branches at one commit are redundant, never a dependency',
    matrixEntry: 'equal heads',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'drop-selection'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'restate-a', 'main', 'alice'),
        pullRequest(13, 'restate-b', 'main', 'alice'),
      ],
    })
    await seedBranch(context, 'seed-a', 'restate-a', { 'shared.txt': 'one\n' }, 'Add shared')
    // A second branch pointing at the very same commit: neither head contains the other.
    const twin = await context.scratch('twin')
    twin.checkout('restate-a')
    context.world.gitIn(twin.path, 'branch', 'restate-b')
    twin.push('restate-b')
  },
  async run(context) {
    const planning = planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13] })
    return planned(context, {
      selection: ['12', '13'],
      planning,
      uncertainty: [
        ...(planning.discovery.redundantHeads.length > 0
          ? [
              {
                item: `#${planning.discovery.redundantHeads[0].numbers[1]} may restate #${
                  planning.discovery.redundantHeads[0].numbers[0]
                }`,
                why: 'both branches point at one commit, so a human decides which contribution is real; nothing is dropped',
              },
            ]
          : []),
        ...((planning.plan.plan?.objective.componentTotals.unknownEstimates ?? 0) > 0
          ? [
              {
                item: 'the conflict cost between these two branches',
                why: 'they share a commit, so the probe cannot separate their contributions',
              },
            ]
          : []),
      ],
    })
  },
}

const multipleAuthorsRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-multiple-authors',
    title: 'Author identity never becomes an edge',
    matrixEntry: 'multiple authors',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      // #13 builds on #12 and shares its author; the edge exists because of the base.
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'feat-a', 'alice'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await integrateBranch(context, 'integrate-b', 'feat-b', 'feat-a')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13] }),
    })
  },
}

const mixedEdgesRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-mixed-evidence-sources',
    title: 'Base, ancestry, and verified-prerequisite edges coexist in one graph',
    matrixEntry: 'mixed explicit/base/ancestry edges',
    kind: 'matrix',
    selection: ['12', '13', '14'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12, 13, 14],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        // Declared base edge 12 -> 13.
        pullRequest(13, 'feat-b', 'feat-a', 'bob'),
        // Strict-ancestry edge 13 -> 14, with no declared base relationship.
        pullRequest(14, 'feat-c', 'main', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-c', 'feat-c', { 'c.txt': 'c\n' }, 'Add C')
    await integrateBranch(context, 'integrate-b', 'feat-b', 'feat-a')
    await integrateBranch(context, 'integrate-c', 'feat-c', 'feat-b')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13', '14'],
      planning: planSelection(context, {
        rootRef: 'refs/heads/main',
        selection: [12, 13, 14],
        // A mention in a body is not a dependency: it arrives as an unverified
        // prerequisite the helper reports rather than acting on.
        declaredPrerequisites: [
          { before: 12, after: 14, evidence: '#14 body mentions #12 in passing' },
        ],
      }),
      ambiguities: [
        {
          item: 'whether #12 is a genuine prerequisite of #14',
          why: 'only a mention supports it, and a mention is not evidence',
        },
      ],
    })
  },
}

const cycleRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-cycle-contradiction',
    title: 'A cycle is reported as evidence, never resolved by dropping an edge',
    matrixEntry: 'cycles',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'drop-selection'],
      chain: [],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'contradictory-graph',
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'feat-b', 'alice'),
        pullRequest(13, 'feat-b', 'feat-a', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    // Each is the other's declared base, so no order can respect both.
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13] }),
      nextSafeAction: {
        action: 'report the cyclic base relationship and ask which declared base is wrong',
        requires: ['a human decision about the declared bases'],
      },
    })
  },
}

const externalSatisfiedRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-external-prerequisite-satisfied',
    title: 'An external prerequisite satisfied by recorded landing is reported with its proof',
    matrixEntry: 'external satisfied parents',
    kind: 'matrix',
    selection: ['12'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12],
      preserved: { root: true, unselectedRefs: ['refs/heads/platform'], userWorkspace: true },
      mustDetectInvariant: 'topology.chain',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, { pullRequests: [pullRequest(12, 'feat-a', 'platform', 'alice')] })
    await seedBranch(
      context,
      'seed-platform',
      'platform',
      { 'platform.txt': 'base\n' },
      'Platform work',
    )
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    // platform really landed, so satisfaction rests on observed ancestry, not on
    // anything resembling the patch text.
    await integrateBranch(context, 'land-platform', 'main', 'platform')
  },
  async run(context) {
    return planned(context, {
      selection: ['12'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12] }),
      snapshotFacts: {
        externalPrerequisites: [
          {
            ref: 'refs/heads/platform',
            state: 'satisfied',
            satisfiedBy: 'recorded-landing',
            evidence: `platform is an ancestor of main at ${remoteOid(context, 'platform').slice(0, 8)}, so it genuinely landed`,
          },
        ],
      },
    })
  },
}

const externalMissingRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-external-prerequisite-missing',
    title: 'An unresolvable external prerequisite is a visible blocker',
    matrixEntry: 'missing/external satisfied parents',
    kind: 'matrix',
    selection: ['12'],
    expect: {
      status: 'blocked',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'expand-selection'],
      chain: [],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'missing-external-prerequisite',
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      // The declared base is a branch nobody ever published.
      pullRequests: [pullRequest(12, 'feat-a', 'never-landed', 'alice')],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
  },
  async run(context) {
    return planned(context, {
      selection: ['12'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12] }),
      snapshotFacts: {
        externalPrerequisites: [
          {
            ref: 'refs/heads/never-landed',
            state: 'unsatisfied',
            satisfiedBy: 'none',
            evidence: 'no ref refs/heads/never-landed exists in the verified repository',
          },
        ],
      },
      blockedReasons: [
        {
          code: 'missing-external-prerequisite',
          detail: 'the declared base of #12 does not exist, so its parent cannot be satisfied',
          evidence: 'no ref refs/heads/never-landed among the observed refs',
        },
      ],
      nextSafeAction: {
        action: 'report the missing parent branch and ask how it should be satisfied',
        requires: ['a published parent for refs/heads/never-landed'],
      },
    })
  },
}

const shallowHistoryRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-shallow-history',
    title: 'Shallow history makes ancestry undecidable instead of negative',
    matrixEntry: 'shallow history',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'missing-history',
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'feat-a', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await integrateBranch(context, 'integrate-b', 'feat-b', 'feat-a')
    await context.world.makeShallowUserCheckout()
  },
  async run(context) {
    const history = context.world.historyFacts()
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, {
        rootRef: 'refs/heads/main',
        selection: [12, 13],
        repository: context.world.repo,
      }),
      blockedReasons: [
        {
          code: 'missing-history',
          detail: 'the fetched history is shallow, so ancestry cannot be established',
          evidence: `shallow=${history.shallow}, grafted=${history.grafted}`,
        },
      ],
      nextSafeAction: {
        action: 'report that history is incomplete and stop before planning an order',
        requires: ['a complete fetch of the refs in scope'],
      },
    })
  },
}

const paginationRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-incomplete-enumeration',
    title: 'A short page walk reports its own incompleteness',
    matrixEntry: 'pagination',
    kind: 'matrix',
    selection: ['12'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'selection.no-expansion',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      // Five pull requests at two per page is three pages; the run reads only the first.
      perPage: 2,
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(30, 'other-a', 'main', 'bob'),
        pullRequest(31, 'other-b', 'main', 'bob'),
        pullRequest(32, 'other-c', 'main', 'carol'),
        pullRequest(33, 'other-d', 'main', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
  },
  async run(context) {
    const planning = planSelection(context, {
      rootRef: 'refs/heads/main',
      selection: [12],
      maxPages: 1,
    })
    return planned(context, {
      selection: ['12'],
      planning,
      uncertainty: [
        {
          item: 'the full set of unselected dependents',
          why: planning.enumeration.limitation?.limitation ?? 'the listing was not fully read',
        },
      ],
    })
  },
}

const unsupportedForkRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-unsupported-fork-head',
    title: 'A fork head is unsupported input, not a reason to substitute another repository',
    matrixEntry: 'unsupported forks',
    kind: 'matrix',
    selection: ['12'],
    expect: {
      status: 'blocked',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'expand-selection', 'clone-recreate-pr'],
      chain: [],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'unsupported-input',
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice', { headRepository: 'contributor/widgets' }),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
  },
  async run(context) {
    return planned(context, {
      selection: ['12'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12] }),
      blockedReasons: [
        {
          code: 'unsupported-input',
          detail:
            '#12 has a head in another repository, which is outside the initial support envelope',
          evidence: 'head repository contributor/widgets, verified repository acme/widgets',
        },
      ],
      nextSafeAction: {
        action: 'report the unsupported fork head and stop',
        requires: ['a same-repository head'],
      },
    })
  },
}

const staleSnapshotRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-stale-snapshot',
    title: 'A provider SHA task-owned storage cannot hold is a stale snapshot, not an agreement',
    matrixEntry: 'stale snapshots',
    kind: 'matrix',
    selection: ['12'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'remote.claims-match',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, { pullRequests: [pullRequest(12, 'feat-a', 'main', 'alice')] })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
  },
  async run(context) {
    const planning = planSelection(context, { rootRef: 'refs/heads/main', selection: [12] })
    const observed = 'f'.repeat(40)
    const identity = planning.identities[0]
    return planned(context, {
      selection: ['12'],
      planning,
      snapshotFacts: {
        // The provider reports a head SHA the task's own storage cannot hold, so the
        // reconciliation records a disagreement instead of smoothing it into agreement.
        reconcile: [{ ref: identity.headRef, observed }],
      },
      uncertainty: [
        {
          item: 'whether the observed head SHA is still the one planning reasoned about',
          why: `the provider reported ${observed.slice(0, 8)} while task-owned storage holds ${identity.headOid.slice(0, 8)}`,
        },
      ],
      nextSafeAction: {
        action: 'take one fresh coherent snapshot before any execution intent is honoured',
        requires: ['a re-read of the head SHA from the provider'],
      },
    })
  },
}

const checkIndependenceRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-check-state-independence',
    title: 'Every check-state variant produces an identical plan and no check query',
    matrixEntry: 'check-state variants',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'await-checks', 'rerun-checks'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'remote.actions-permitted',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    // The states differ deliberately; the plan and the action log must not.
    defineProvider(context, {
      checkStates: { '12': 'failing', '13': 'pending' },
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13] }),
    })
  },
}

const unknownProbeRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-unavailable-probe-is-unknown',
    title: 'An unprobeable pair is counted as unknown, never as a zero-cost edge',
    matrixEntry: 'probe errors are not zero cost',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, {
        rootRef: 'refs/heads/main',
        selection: [12, 13],
        // Both directions unavailable, which is what an unprobeable pair looks like.
        estimates: [
          {
            pair: [12, 13],
            kind: 'unknown',
            value: null,
            confidence: 'unknown',
            reason: 'the pair could not be probed in this run',
          },
        ],
      }),
      uncertainty: [
        {
          item: 'the conflict cost of integrating #12 into #13',
          why: 'the probe could not run, so the estimate is unknown rather than zero',
        },
      ],
    })
  },
}

const boundedBudgetRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-budget-exhaustion-is-qualified',
    title: 'A bounded search is labelled best-found, never exact',
    matrixEntry: 'budget exhaustion',
    kind: 'matrix',
    selection: ['12', '13', '14'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks'],
      chain: [12, 13, 14],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
        pullRequest(14, 'feat-c', 'main', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'shared.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-c', 'feat-c', { 'shared.txt': 'c\n' }, 'Add C')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13', '14'],
      // Two evaluations cannot cover all six orders, so the result must be qualified.
      planning: planSelection(context, {
        rootRef: 'refs/heads/main',
        selection: [12, 13, 14],
        maxEnumeratedOrders: 2,
      }),
    })
  },
}

const redundantRow: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'planning-redundant-contribution-surfaced',
    title: 'A redundant pull request is surfaced, never silently dropped',
    matrixEntry: 'empty/redundant contributions',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'drop-selection'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'selection.complete',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-same', 'main', 'alice'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-same', 'feat-same', { 'a.txt': 'a\n' }, 'Restate A')
  },
  async run(context) {
    return planned(context, {
      selection: ['12', '13'],
      planning: planSelection(context, { rootRef: 'refs/heads/main', selection: [12, 13] }),
      uncertainty: [
        {
          item: '#13 may be redundant with #12',
          why: 'both branches carry the same content; the run reports this and asks a human, never drops it',
        },
      ],
    })
  },
}

export const fixtures: FixtureModule[] = [
  chainRow,
  independentRow,
  fanOutRow,
  diamondRow,
  sharedCommitsRow,
  sharedBranchRow,
  redundantHeadsRow,
  multipleAuthorsRow,
  mixedEdgesRow,
  cycleRow,
  externalSatisfiedRow,
  externalMissingRow,
  shallowHistoryRow,
  paginationRow,
  unsupportedForkRow,
  staleSnapshotRow,
  checkIndependenceRow,
  unknownProbeRow,
  boundedBudgetRow,
  redundantRow,
]
