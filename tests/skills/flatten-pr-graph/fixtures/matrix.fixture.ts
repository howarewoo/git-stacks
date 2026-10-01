/**
 * The initial flatten-pr-graph fixture matrix.
 *
 * Every entry corresponds to one row of issue #84's required matrix. Each fixture
 * seeds real Git and fake-provider state, then produces the result document a
 * conforming run would report. The oracle decides independently whether that document
 * is honest; a fixture never declares its own verdict.
 */

import { captureSnapshot, notPerformed, resultDocument } from '../support/documents'
import { PERMITTED_ACTIONS } from '../support/actions'
import { RUBRIC_PATH, type FixtureContext, type FixtureModule } from '../support/fixture'
import {
  defineProvider,
  deniedWriteReasons,
  integrateBranch,
  mergeLeavingConflict,
  planFrom,
  prepareBranch,
  preparationFrom,
  publicationFrom,
  remoteOid,
  seedBranch,
  withRemoteClaims,
} from '../support/scenario'
import { CONTRACT_VERSION } from '../support/contract-types'
import type {
  Plan,
  PlanWrite,
  Preparation,
  ResultDocument,
  Snapshot,
} from '../support/contract-types'

const AT = '2026-10-01T09:00:00.000Z'
const WRITTEN_AT = '2026-10-01T09:05:00.000Z'

const READ_ONLY = PERMITTED_ACTIONS.filter(
  (action) => action !== 'update-pr-base' && action !== 'push-selected-head',
)
const WITH_BASES = [...PERMITTED_ACTIONS]
const WITHOUT_BASE_WRITES = PERMITTED_ACTIONS.filter((action) => action !== 'update-pr-base')
const NOTHING = [READ_ONLY, WITH_BASES, WITHOUT_BASE_WRITES]

function baseWrite(number: number, from: string, to: string): PlanWrite {
  return {
    kind: 'pr-base-update',
    target: String(number),
    change: 'base-change',
    reason: `retarget #${number} from ${from} onto ${to}`,
  }
}

function headWrite(branch: string): PlanWrite {
  return {
    kind: 'ref-update',
    target: `refs/heads/${branch}`,
    change: 'head-update',
    reason: `integrate the prepared predecessor state into ${branch}`,
  }
}

/** The document a run assembles once its writes are done. */
function assemble(options: {
  context: FixtureContext
  status: 'published' | 'partial'
  selection: string[]
  chain: number[]
  snapshot: Snapshot
  writes: PlanWrite[]
  preparation: Preparation
  headsBefore?: Record<string, string>
  dependencies?: Plan['hardDependencies']
  recovery?: ResultDocument['recovery']
  nextSafeAction?: ResultDocument['nextSafeAction']
}): ResultDocument {
  const blockedReasons = deniedWriteReasons(options.context)
  const bases: Record<number, string> = {}
  for (const number of options.chain) {
    const base = options.context.provider.baseOf(number)
    if (base) bases[number] = base
  }
  const publication = withRemoteClaims(
    publicationFrom(options.context, {
      bases,
      heads: options.headsBefore,
      observedAt: WRITTEN_AT,
    }),
    options.context,
    WRITTEN_AT,
  )
  return resultDocument({
    status: options.status,
    intent: 'execute',
    snapshot: options.snapshot,
    plan: planFrom(options.snapshot, options.chain, options.writes, {
      prohibitedActivitiesNotPerformed: notPerformed(),
      hardDependencies: options.dependencies ?? [],
    }),
    preparation: options.preparation,
    publication,
    ...(blockedReasons.length > 0 ? { blockedReasons } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
    nextSafeAction: options.nextSafeAction ?? {
      action: 're-read the published bases before any follow-up',
      requires: [],
    },
    verification: [
      {
        invariant: 'remote.claims-match',
        method: 'provider re-read after the last write',
        observed: 'claims recorded at the observed values',
        result: 'pass',
      },
    ],
  })
}

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
) {
  return {
    number,
    title: `Feature ${number}`,
    state: overrides.state ?? ('OPEN' as const),
    draft: overrides.draft ?? false,
    base,
    head,
    headRepository: overrides.headRepository ?? 'acme/widgets',
    author,
  }
}

const noInput: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'no-input',
    title: 'No selection never means every open pull request',
    matrixEntry: 'no input',
    kind: 'matrix',
    selection: [],
    expect: {
      status: 'blocked',
      permittedActions: READ_ONLY,
      forbiddenActions: ['expand-selection', 'clone-recreate-pr', 'merge-pr', 'close-pr'],
      chain: [],
      preserved: { root: true, unselectedRefs: ['refs/heads/feat-a'], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'missing-selection',
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, { pullRequests: [pullRequest(12, 'feat-a', 'main', 'alice')] })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
  },
  async run(context) {
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection: [] })
    return resultDocument({
      status: 'blocked',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [], [], { prohibitedActivitiesNotPerformed: notPerformed() }),
      blockedReasons: [
        {
          code: 'missing-selection',
          detail: 'the request names no pull request',
          evidence: `the repository has ${context.provider.listPullRequests(1).length} open pull requests, none of which were selected`,
        },
      ],
      nextSafeAction: {
        action: 'ask for the explicit selection',
        requires: ['a pull request selection'],
      },
    })
  },
}

const duplicateIdentifiers: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'duplicate-identifiers',
    title: 'Numbers, hashes, and URLs collapse to one canonical identity',
    matrixEntry: 'duplicate identifiers',
    kind: 'matrix',
    selection: ['12', '#12', 'https://github.com/acme/widgets/pull/12'],
    expect: {
      status: 'no-op',
      permittedActions: READ_ONLY,
      forbiddenActions: ['expand-selection', 'clone-recreate-pr', 'run-checks'],
      chain: [12],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'selection.complete',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, { pullRequests: [pullRequest(12, 'feat-a', 'main', 'alice')] })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
  },
  async run(context) {
    const selection = ['12', '#12', 'https://github.com/acme/widgets/pull/12']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    return resultDocument({
      status: 'no-op',
      intent: 'execute',
      snapshot,
      plan: planFrom(
        snapshot,
        [12],
        [
          {
            kind: 'ref-update',
            target: 'refs/heads/feat-a',
            change: 'none',
            reason: 'already on the root',
          },
        ],
        { prohibitedActivitiesNotPerformed: notPerformed() },
      ),
      publication: {
        contractVersion: CONTRACT_VERSION,
        attempts: [],
        confirmed: [],
        unconfirmed: [],
        denials: [],
        remoteClaims: [
          { kind: 'pr-base', target: '12', observed: 'refs/heads/main', observedAt: WRITTEN_AT },
        ],
        interrupted: false,
        concurrency: { leaseHeld: false, conflictingRemoteMoveDetected: false },
      },
      uncertainty: [
        {
          item: 'whether #12 is still wanted',
          why: 'a redundant pull request is reported, never closed by the run',
        },
      ],
      nextSafeAction: { action: 'stop and report the verified chain', requires: [] },
    })
  },
}

const singlePullRequest: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'single-pull-request',
    title: 'One selected pull request is a valid selection',
    matrixEntry: 'single PR',
    kind: 'matrix',
    selection: ['12'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['merge-pr', 'close-pr', 'run-checks', 'push-root'],
      chain: [12],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'remote.claims-match',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'unrelated', 'alice'),
        pullRequest(20, 'unrelated', 'main', 'bob'),
      ],
    })
    await seedBranch(
      context,
      'seed-root',
      'unrelated',
      { 'base.txt': 'base\n' },
      'Unrelated root work',
    )
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
  },
  async run(context) {
    const snapshot = captureSnapshot(context, {
      intent: 'execute',
      capturedAt: AT,
      selection: ['12'],
    })
    context.provider.updatePullRequestBase(12, 'main')
    return assemble({
      context,
      status: 'published',
      selection: ['12'],
      chain: [12],
      snapshot,
      writes: [baseWrite(12, 'unrelated', 'main')],
      preparation: preparationFrom([
        {
          number: 12,
          originalHead: snapshot.selection.resolved[0].headOid,
          preparedHead: snapshot.selection.resolved[0].headOid,
          basedOn: remoteOid(context, 'main'),
          retainedOriginalCommits: [snapshot.selection.resolved[0].headOid],
        },
      ]),
    })
  },
}

const independentPullRequests: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'independent-pull-requests',
    title: 'Two independent pull requests on disjoint files become one chain',
    matrixEntry: 'independent PRs',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr', 'close-pr', 'delete-branch', 'push-root'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'preservation.cumulative',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'alice'),
        pullRequest(20, 'unrelated', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-u', 'unrelated', { 'u.txt': 'u\n' }, 'Unrelated work')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const headsBefore = { 'feat-b': originalB }
    const { oid } = await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    return assemble({
      context,
      status: 'published',
      selection,
      chain: [12, 13],
      snapshot,
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore,
      dependencies: [
        {
          before: 12,
          after: 13,
          source: 'ancestry',
          evidence: '#13 head now contains the prepared state of #12',
        },
      ],
      preparation: preparationFrom(
        [
          {
            number: 12,
            originalHead: snapshot.selection.resolved[0].headOid,
            preparedHead: snapshot.selection.resolved[0].headOid,
            basedOn: remoteOid(context, 'main'),
            retainedOriginalCommits: [snapshot.selection.resolved[0].headOid],
          },
          {
            number: 13,
            originalHead: originalB,
            preparedHead: oid,
            basedOn: snapshot.selection.resolved[0].headOid,
            retainedOriginalCommits: [originalB],
          },
        ],
        {
          cumulative: [
            {
              number: 13,
              integratedPreparedStateOf: 12,
              evidence: 'prepared head of #12 is an ancestor of the prepared head of #13',
            },
          ],
        },
      ),
    })
  },
}

const alreadyCorrectChain: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'already-correct-chain',
    title: 'A valid existing chain is a verified no-op',
    matrixEntry: 'already-correct chain',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'no-op',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'merge-pr', 'close-pr', 'write-outside-scratch'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'feat-a', 'alice'),
        pullRequest(20, 'unrelated', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    // The chain already exists: #13's head already contains #12's prepared state.
    await integrateBranch(context, 'seed-integrate', 'feat-b', 'feat-a')
    await seedBranch(context, 'seed-u', 'unrelated', { 'u.txt': 'u\n' }, 'Unrelated work')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    return resultDocument({
      status: 'no-op',
      intent: 'execute',
      snapshot,
      plan: planFrom(
        snapshot,
        [12, 13],
        [
          {
            kind: 'ref-update',
            target: 'refs/heads/feat-a',
            change: 'none',
            reason: 'already on the root',
          },
          { kind: 'pr-base-update', target: '13', change: 'none', reason: 'already on feat-a' },
        ],
        {
          prohibitedActivitiesNotPerformed: notPerformed(),
          // #13 already declares #12 as its base: an observed hard edge the plan records.
          hardDependencies: [
            {
              before: 12,
              after: 13,
              source: 'pr-base',
              evidence: '#13 is based on the head of #12',
            },
          ],
        },
      ),
      publication: {
        contractVersion: CONTRACT_VERSION,
        attempts: [],
        confirmed: [],
        unconfirmed: [],
        denials: [],
        remoteClaims: [
          { kind: 'pr-base', target: '13', observed: 'refs/heads/feat-a', observedAt: WRITTEN_AT },
        ],
        interrupted: false,
        concurrency: { leaseHeld: false, conflictingRemoteMoveDetected: false },
      },
      nextSafeAction: { action: 'stop; the chain is already correct', requires: [] },
    })
  },
}

const fanOut: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'fan-out',
    title: 'Three pull requests fan out of one root and become one chain',
    matrixEntry: 'fan-out',
    kind: 'matrix',
    selection: ['12', '13', '14'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr', 'close-pr', 'push-root'],
      chain: [12, 13, 14],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'topology.chain',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
        pullRequest(14, 'feat-c', 'main', 'carol'),
        pullRequest(20, 'unrelated', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-c', 'feat-c', { 'c.txt': 'c\n' }, 'Add C')
    await seedBranch(context, 'seed-u', 'unrelated', { 'u.txt': 'u\n' }, 'Unrelated work')
  },
  async run(context) {
    const selection = ['12', '13', '14']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const originalC = snapshot.selection.resolved[2].headOid
    const integratedB = await integrateBranch(context, 'run-b', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    const integratedC = await integrateBranch(context, 'run-c', 'feat-c', 'feat-b')
    context.provider.recordAction('push-selected-head', 'feat-c')
    context.provider.updatePullRequestBase(14, 'feat-b')
    return assemble({
      context,
      status: 'published',
      selection,
      chain: [12, 13, 14],
      snapshot,
      writes: [
        headWrite('feat-b'),
        baseWrite(13, 'main', 'feat-a'),
        headWrite('feat-c'),
        baseWrite(14, 'main', 'feat-b'),
      ],
      headsBefore: { 'feat-b': originalB, 'feat-c': originalC },
      dependencies: [
        {
          before: 12,
          after: 13,
          source: 'ancestry',
          evidence: '#13 integrates the prepared state of #12',
        },
        {
          before: 13,
          after: 14,
          source: 'pr-base',
          evidence: '#14 is retargeted onto the head of #13',
        },
      ],
      preparation: preparationFrom(
        [
          {
            number: 12,
            originalHead: snapshot.selection.resolved[0].headOid,
            preparedHead: snapshot.selection.resolved[0].headOid,
            basedOn: remoteOid(context, 'main'),
            retainedOriginalCommits: [snapshot.selection.resolved[0].headOid],
          },
          {
            number: 13,
            originalHead: originalB,
            preparedHead: integratedB.oid,
            basedOn: snapshot.selection.resolved[0].headOid,
            retainedOriginalCommits: [originalB],
          },
          {
            number: 14,
            originalHead: originalC,
            preparedHead: integratedC.oid,
            basedOn: integratedB.oid,
            retainedOriginalCommits: [originalC],
          },
        ],
        {
          cumulative: [
            {
              number: 13,
              integratedPreparedStateOf: 12,
              evidence: '#12 prepared head is an ancestor of #13',
            },
            {
              number: 14,
              integratedPreparedStateOf: 13,
              evidence: '#13 prepared head is an ancestor of #14',
            },
          ],
        },
      ),
    })
  },
}

const diamondFanIn: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'diamond-fan-in',
    title: 'A head that integrates two predecessors becomes the last position and keeps both edges',
    matrixEntry: 'diamond/fan-in with shared commits',
    kind: 'matrix',
    selection: ['12', '13', '14'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['expand-selection', 'drop-selection', 'run-checks'],
      chain: [12, 13, 14],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'topology.chain',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
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
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    const seedC = await context.scratch('seed-c')
    seedC.checkoutNew('feat-c')
    await seedC.write('c.txt', 'c\n')
    seedC.commit('Add C')
    seedC.push('feat-c')
    const integratedA = await integrateBranch(context, 'seed-c-a', 'feat-c', 'feat-a')
    const integratedB = await integrateBranch(context, 'seed-c-b', 'feat-c', 'feat-b')
    void integratedA
    void integratedB
  },
  async run(context) {
    const selection = ['12', '13', '14']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const originalA = snapshot.selection.resolved[0].headOid
    // #14 already integrates both predecessors, so it is linearized *after* them and both
    // dependency edges survive into the published chain.
    await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    // #14 must carry #13's prepared state too, or the chain is not cumulative.
    await integrateBranch(context, 'run-c', 'feat-c', 'feat-b')
    context.provider.recordAction('push-selected-head', 'feat-c')
    context.provider.updatePullRequestBase(13, 'feat-a')
    context.provider.updatePullRequestBase(14, 'feat-b')
    return assemble({
      context,
      status: 'published',
      selection,
      chain: [12, 13, 14],
      snapshot,
      writes: [
        headWrite('feat-b'),
        headWrite('feat-c'),
        baseWrite(13, 'main', 'feat-a'),
        baseWrite(14, 'main', 'feat-b'),
      ],
      preparation: preparationFrom([
        {
          number: 12,
          originalHead: originalA,
          preparedHead: originalA,
          basedOn: remoteOid(context, 'main'),
          retainedOriginalCommits: [originalA],
        },
        {
          number: 13,
          originalHead: originalB,
          preparedHead: remoteOid(context, 'feat-b'),
          basedOn: remoteOid(context, 'feat-a'),
          retainedOriginalCommits: [originalB],
        },
        {
          number: 14,
          originalHead: snapshot.selection.resolved[2].headOid,
          preparedHead: remoteOid(context, 'feat-c'),
          basedOn: remoteOid(context, 'feat-b'),
          retainedOriginalCommits: [snapshot.selection.resolved[2].headOid],
        },
      ]),
      headsBefore: { 'feat-b': originalB },
      dependencies: [
        {
          before: 12,
          after: 14,
          source: 'ancestry',
          evidence: 'real ancestry: the head of #12 is an ancestor of the head of #14',
        },
        {
          before: 13,
          after: 14,
          source: 'ancestry',
          evidence: 'real ancestry: the head of #13 is an ancestor of the head of #14',
        },
      ],
    })
  },
}

const preparedWithoutPublication: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'prepared-without-publication',
    title: 'Preparation finished and stopped before any provider write',
    matrixEntry: 'prepared, nothing published',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'prepared',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'merge-pr', 'close-pr', 'push-root'],
      chain: [],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
        pullRequest(20, 'unrelated', 'main', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-u', 'unrelated', { 'u.txt': 'u\n' }, 'Unrelated work')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalA = snapshot.selection.resolved[0].headOid
    const originalB = snapshot.selection.resolved[1].headOid
    // Real preparation in the task's own workspace, then a deliberate stop: the remote ref
    // never moves, so the supported status is `prepared`, not `no-op`.
    const prepared = await prepareBranch(context, 'run', 'feat-b', 'feat-a')
    void prepared
    return resultDocument({
      status: 'prepared',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [12, 13], [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')], {
        prohibitedActivitiesNotPerformed: notPerformed(),
        hardDependencies: [
          {
            before: 12,
            after: 13,
            source: 'pr-base',
            evidence: '#13 is retargeted onto the head of #12',
          },
        ],
      }),
      preparation: preparationFrom([
        {
          number: 12,
          originalHead: originalA,
          preparedHead: originalA,
          basedOn: remoteOid(context, 'main'),
          retainedOriginalCommits: [originalA],
        },
        {
          number: 13,
          originalHead: originalB,
          preparedHead: remoteOid(context, 'feat-b'),
          basedOn: remoteOid(context, 'feat-a'),
          retainedOriginalCommits: [originalB],
        },
      ]),
      nextSafeAction: {
        action: 'publish the two recorded writes when the operator approves',
        requires: ['operator approval of the prepared chain'],
      },
    })
  },
}

const multipleAuthors: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'multiple-authors',
    title: 'Pull requests by different authors chain without any team database',
    matrixEntry: 'multiple authors',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr', 'close-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'preservation.original-commits',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
        pullRequest(20, 'unrelated', 'main', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-u', 'unrelated', { 'u.txt': 'u\n' }, 'Unrelated work')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const { oid } = await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    return assemble({
      context,
      status: 'published',
      selection,
      chain: [12, 13],
      snapshot,
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
      preparation: preparationFrom([
        {
          number: 12,
          originalHead: snapshot.selection.resolved[0].headOid,
          preparedHead: snapshot.selection.resolved[0].headOid,
          basedOn: remoteOid(context, 'main'),
          retainedOriginalCommits: [snapshot.selection.resolved[0].headOid],
        },
        {
          number: 13,
          originalHead: originalB,
          preparedHead: oid,
          basedOn: snapshot.selection.resolved[0].headOid,
          retainedOriginalCommits: [originalB],
        },
      ]),
    })
  },
}

const externalPrerequisiteSatisfied: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'external-prerequisite-satisfied',
    title: 'A pull request based on an existing release branch chains normally',
    matrixEntry: 'external prerequisite satisfied',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr', 'push-root'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/release/1.x'], userWorkspace: true },
      mustDetectInvariant: 'topology.chain',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'release/1.x', 'bob'),
      ],
    })
    const seed = await context.scratch('seed-root')
    seed.checkoutNew('release/1.x')
    await seed.write('release.txt', '1.x\n')
    seed.commit('Start 1.x')
    seed.push('release/1.x')
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const { oid } = await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    return assemble({
      context,
      status: 'published',
      selection,
      chain: [12, 13],
      snapshot,
      writes: [headWrite('feat-b'), baseWrite(13, 'release/1.x', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
      preparation: preparationFrom([
        {
          number: 12,
          originalHead: snapshot.selection.resolved[0].headOid,
          preparedHead: snapshot.selection.resolved[0].headOid,
          basedOn: remoteOid(context, 'main'),
          retainedOriginalCommits: [snapshot.selection.resolved[0].headOid],
        },
        {
          number: 13,
          originalHead: originalB,
          preparedHead: oid,
          basedOn: snapshot.selection.resolved[0].headOid,
          retainedOriginalCommits: [originalB],
        },
      ]),
    })
  },
}

const externalPrerequisiteMissing: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'external-prerequisite-missing',
    title: 'A base branch that does not exist blocks the run before any write',
    matrixEntry: 'external prerequisite missing',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'clone-recreate-pr', 'drop-selection'],
      chain: [],
      preserved: { root: true, unselectedRefs: ['refs/heads/feat-a'], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'missing-external-prerequisite',
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'release/9.x', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    return resultDocument({
      status: 'blocked',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [], [], { prohibitedActivitiesNotPerformed: notPerformed() }),
      blockedReasons: [
        {
          code: 'missing-external-prerequisite',
          detail: 'the base branch release/9.x of #13 does not exist in the repository',
          evidence: `observed refs: ${Object.keys(context.world.remoteRefs()).sort().join(', ')}`,
        },
      ],
      nextSafeAction: {
        action: 'report the missing prerequisite; create it out of band',
        requires: [],
      },
    })
  },
}

const cycleContradiction: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'cycle-contradiction',
    title: "Two pull requests that are each other's base contradict the graph",
    matrixEntry: 'cycles/contradictions',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'expand-selection', 'clone-recreate-pr'],
      chain: [],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'contradictory-graph',
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
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
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    return resultDocument({
      status: 'blocked',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [], [], { prohibitedActivitiesNotPerformed: notPerformed() }),
      blockedReasons: [
        {
          code: 'contradictory-graph',
          detail: "#12 and #13 are each other's base, so no linear chain can satisfy both",
          evidence: '#12 base feat-b is the head of #13, and #13 base feat-a is the head of #12',
        },
      ],
      nextSafeAction: { action: 'ask which base is correct', requires: ['a human decision'] },
    })
  },
}

const shallowHistory: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'shallow-incomplete-history',
    title: 'A shallow checkout cannot establish ancestry and blocks',
    matrixEntry: 'shallow/incomplete history',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'drop-selection', 'expand-selection'],
      chain: [],
      preserved: { root: true, unselectedRefs: ['refs/heads/feat-a'], userWorkspace: true },
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
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await context.world.makeShallowUserCheckout()
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const history = context.world.historyFacts()
    return resultDocument({
      status: 'blocked',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [], [], { prohibitedActivitiesNotPerformed: notPerformed() }),
      blockedReasons: [
        {
          code: 'missing-history',
          detail: 'the available checkout is shallow, so ancestry cannot be established',
          evidence: `shallow=${history.shallow}, grafted=${history.grafted}`,
        },
      ],
      nextSafeAction: { action: 'fetch full history, then re-run', requires: ['complete history'] },
    })
  },
}

const emptyContribution: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'empty-redundant-contribution',
    title: 'A pull request whose work is already in the root is reported, not dropped',
    matrixEntry: 'empty/redundant contribution',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'no-op',
      permittedActions: READ_ONLY,
      forbiddenActions: ['close-pr', 'delete-branch', 'write-unselected-ref', 'merge-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'feat-a', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    // `feat-b` points at exactly its base: the pull request adds nothing.
    context.world.moveRemoteRef('feat-b', remoteOid(context, 'feat-a'))
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    return resultDocument({
      status: 'no-op',
      intent: 'execute',
      snapshot,
      plan: planFrom(
        snapshot,
        [12, 13],
        [
          {
            kind: 'ref-update',
            target: 'refs/heads/feat-a',
            change: 'none',
            reason: 'already on the root',
          },
          { kind: 'pr-base-update', target: '13', change: 'none', reason: 'already on feat-a' },
        ],
        {
          prohibitedActivitiesNotPerformed: notPerformed(),
          // #13 already declares #12 as its base: an observed hard edge the plan records.
          hardDependencies: [
            {
              before: 12,
              after: 13,
              source: 'pr-base',
              evidence: '#13 is based on the head of #12',
            },
          ],
        },
      ),
      publication: {
        contractVersion: CONTRACT_VERSION,
        attempts: [],
        confirmed: [],
        unconfirmed: [],
        denials: [],
        remoteClaims: [
          { kind: 'pr-base', target: '13', observed: 'refs/heads/feat-a', observedAt: WRITTEN_AT },
        ],
        interrupted: false,
        concurrency: { leaseHeld: false, conflictingRemoteMoveDetected: false },
      },
      uncertainty: [
        {
          item: 'whether the empty contribution of #13 is intentional',
          why: 'the run reports it and never closes, deletes, or commits an empty branch',
        },
      ],
      nextSafeAction: { action: 'stop and let a human decide about #13', requires: [] },
    })
  },
}

const unsupportedFork: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'unsupported-fork',
    title: 'A fork head is explicitly unsupported, not cloned into a replacement',
    matrixEntry: 'unsupported fork',
    kind: 'matrix',
    selection: ['12'],
    expect: {
      status: 'blocked',
      permittedActions: READ_ONLY,
      forbiddenActions: ['clone-recreate-pr', 'write-unselected-ref', 'expand-selection'],
      chain: [],
      preserved: { root: true, unselectedRefs: ['refs/heads/feat-a'], userWorkspace: true },
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
    const snapshot = captureSnapshot(context, {
      intent: 'execute',
      capturedAt: AT,
      selection: ['12'],
    })
    return resultDocument({
      status: 'blocked',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [], [], { prohibitedActivitiesNotPerformed: notPerformed() }),
      blockedReasons: [
        {
          code: 'unsupported-input',
          detail:
            'the head of #12 lives in contributor/widgets, which is outside the verified repository',
          evidence: 'provider reports head repository contributor/widgets',
        },
      ],
      nextSafeAction: { action: 'report the fork as unsupported', requires: [] },
    })
  },
}

const dirtyUserCheckout: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'dirty-user-checkout',
    title: 'A dirty user checkout is preserved while the chain is published',
    matrixEntry: 'dirty user checkout',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['edit-user-checkout', 'edit-user-config', 'run-checks'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'preservation.user-worktree',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
        pullRequest(20, 'unrelated', 'main', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-u', 'unrelated', { 'u.txt': 'u\n' }, 'Unrelated work')
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(context.world.repo, 'README.md'), 'unsaved local work\n')
    await writeFile(join(context.world.repo, 'private.txt'), 'untracked local work\n')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const { oid } = await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    return assemble({
      context,
      status: 'published',
      selection,
      chain: [12, 13],
      snapshot,
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
      preparation: preparationFrom([
        {
          number: 12,
          originalHead: snapshot.selection.resolved[0].headOid,
          preparedHead: snapshot.selection.resolved[0].headOid,
          basedOn: remoteOid(context, 'main'),
          retainedOriginalCommits: [snapshot.selection.resolved[0].headOid],
        },
        {
          number: 13,
          originalHead: originalB,
          preparedHead: oid,
          basedOn: snapshot.selection.resolved[0].headOid,
          retainedOriginalCommits: [originalB],
        },
      ]),
    })
  },
}

const changedRemoteHead: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'changed-remote-head',
    title: 'A selected head that moved after the snapshot stops the run',
    matrixEntry: 'changed remote head',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      permittedActions: READ_ONLY,
      forbiddenActions: ['run-checks', 'await-checks', 'drop-selection'],
      chain: [],
      preserved: { root: true, unselectedRefs: ['refs/heads/feat-b'], userWorkspace: true },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'stale-snapshot',
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
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    // Somebody else pushes to the selected head between snapshot and use.
    const seed = await context.scratch('concurrent')
    seed.checkout('feat-a')
    await seed.write('extra.txt', 'pushed by somebody else\n')
    const moved = seed.commit('Concurrent push to feat-a')
    seed.push('feat-a')
    return resultDocument({
      status: 'blocked',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [], [], { prohibitedActivitiesNotPerformed: notPerformed() }),
      blockedReasons: [
        {
          code: 'stale-snapshot',
          detail:
            'the head of #12 moved after the snapshot, so every later step would act on stale evidence',
          evidence: `refs/heads/feat-a is now ${moved.slice(0, 8)}, snapshot recorded ${snapshot.selection.resolved[0].headOid.slice(0, 8)}`,
        },
      ],
      nextSafeAction: {
        action: 're-read the selection and ask whether to include the new commit',
        requires: ['a fresh snapshot'],
      },
    })
  },
}

const partialPublication: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'partial-pr-base-publication',
    title: 'One base change lands and the next is denied: partial with a recovery record',
    matrixEntry: 'partial PR-base publication',
    kind: 'matrix',
    selection: ['12', '13', '14'],
    expect: {
      status: 'partial',
      permittedActions: WITH_BASES,
      forbiddenActions: ['merge-pr', 'close-pr', 'run-checks', 'disable-auto-merge'],
      chain: [12, 13, 14],
      preserved: { root: true, unselectedRefs: [], userWorkspace: true },
      mustDetectInvariant: 'remote.claims-match',
      honestResult: true,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      deniedWrites: ['update-pr-base:14'],
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
        pullRequest(14, 'feat-c', 'main', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-c', 'feat-c', { 'c.txt': 'c\n' }, 'Add C')
  },
  async run(context) {
    const selection = ['12', '13', '14']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    context.provider.updatePullRequestBase(13, 'feat-a')
    context.provider.updatePullRequestBase(14, 'feat-b')
    return assemble({
      context,
      status: 'partial',
      selection,
      chain: [12, 13, 14],
      snapshot,
      writes: [baseWrite(13, 'main', 'feat-a'), baseWrite(14, 'main', 'feat-b')],
      preparation: preparationFrom([
        {
          number: 12,
          originalHead: snapshot.selection.resolved[0].headOid,
          preparedHead: snapshot.selection.resolved[0].headOid,
          basedOn: remoteOid(context, 'main'),
          retainedOriginalCommits: [snapshot.selection.resolved[0].headOid],
        },
      ]),
      recovery: {
        acknowledgedChanges: ['the base of #13 is now feat-a'],
        unconfirmedAttempts: ['the base update of #14 was denied and did not land'],
        recommended: 're-read both bases before retrying #14; never retry blind',
      },
      nextSafeAction: {
        action: 're-read the two bases, then ask for write permission on #14',
        requires: ['pull request base update permission on #14'],
      },
    })
  },
}

const previewLeavesStateUntouched: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'preview-leaves-state-untouched',
    title: 'Preview gathers evidence in task-owned scratch and changes nothing else',
    matrixEntry: 'preview versus execution',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'planned',
      intent: 'preview',
      permittedActions: PERMITTED_ACTIONS.filter(
        (action) => action !== 'update-pr-base' && action !== 'push-selected-head',
      ),
      forbiddenActions: ['write-unselected-ref', 'edit-user-checkout', 'run-checks'],
      chain: [12, 13],
      preserved: {
        root: true,
        unselectedRefs: ['refs/heads/feat-a', 'refs/heads/feat-b', 'refs/heads/unrelated'],
        userWorkspace: true,
      },
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
        pullRequest(20, 'unrelated', 'main', 'carol'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
    await seedBranch(context, 'seed-u', 'unrelated', { 'u.txt': 'u\n' }, 'Unrelated work')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'preview', capturedAt: AT, selection })
    const scratch = await context.scratch('preview')
    scratch.checkout('feat-b')
    scratch.fetch()
    context.provider.writeTaskOwnedScratch('preview/feat-b')
    return resultDocument({
      status: 'planned',
      intent: 'preview',
      snapshot,
      plan: planFrom(snapshot, [12, 13], [baseWrite(13, 'main', 'feat-a')], {
        prohibitedActivitiesNotPerformed: notPerformed(),
      }),
      uncertainty: [
        {
          item: 'whether the integration would conflict',
          why: 'preview integrates in task-owned scratch only',
        },
      ],
      nextSafeAction: {
        action: 'ask for explicit execution before any ref or base change',
        requires: ['an explicit execute request'],
      },
    })
  },
}

const unresolvedConflict: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'unresolved-conflict-blocks',
    title: 'A conflict the run cannot resolve honestly blocks instead of guessing',
    matrixEntry: 'conflict without stated intent',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      permittedActions: PERMITTED_ACTIONS.filter(
        (action) => action !== 'update-pr-base' && action !== 'push-selected-head',
      ),
      forbiddenActions: ['run-checks', 'await-checks', 'drop-selection'],
      chain: [],
      preserved: {
        root: true,
        unselectedRefs: ['refs/heads/feat-a', 'refs/heads/feat-b'],
        userWorkspace: true,
      },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'unresolved-conflict',
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    const shared = await context.scratch('seed-shared')
    shared.checkoutNew('feat-a')
    await shared.write('shared.txt', 'first intent\n')
    shared.commit('Write shared first intent')
    shared.push('feat-a')
    const other = await context.scratch('seed-shared-b')
    other.checkoutNew('feat-b')
    await other.write('shared.txt', 'second intent\n')
    other.commit('Write shared second intent')
    other.push('feat-b')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const scratch = await mergeLeavingConflict(context, 'run', 'feat-b', 'feat-a')
    return resultDocument({
      status: 'blocked',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [], [], { prohibitedActivitiesNotPerformed: notPerformed() }),
      blockedReasons: [
        {
          code: 'unresolved-conflict',
          detail:
            'shared.txt has two different intents and no stated product decision to resolve them',
          evidence: `unmerged entries: ${scratch.unmergedPaths().join(', ')}`,
        },
      ],
      nextSafeAction: {
        action: 'ask a human which intent survives',
        requires: ['a stated intent'],
      },
    })
  },
}

const activeAutoMerge: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'active-auto-merge-blocks',
    title: 'An enabled auto-merge stops the run before the first push',
    matrixEntry: 'active landing arrangement',
    kind: 'matrix',
    selection: ['12', '13'],
    expect: {
      status: 'blocked',
      permittedActions: READ_ONLY,
      forbiddenActions: [
        'disable-auto-merge',
        'write-unselected-ref',
        'join-merge-queue',
        'merge-pr',
      ],
      chain: [],
      preserved: {
        root: true,
        unselectedRefs: ['refs/heads/feat-a', 'refs/heads/feat-b'],
        userWorkspace: true,
      },
      mustDetectInvariant: 'status.legality',
      honestResult: true,
      blockedCode: 'active-landing-arrangement',
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    defineProvider(context, {
      autoMergeEnabledOn: [13],
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
    await seedBranch(context, 'seed-a', 'feat-a', { 'a.txt': 'a\n' }, 'Add A')
    await seedBranch(context, 'seed-b', 'feat-b', { 'b.txt': 'b\n' }, 'Add B')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const landing = context.provider.readLandingArrangement()
    return resultDocument({
      status: 'blocked',
      intent: 'execute',
      snapshot,
      plan: planFrom(snapshot, [], [], { prohibitedActivitiesNotPerformed: notPerformed() }),
      blockedReasons: [
        {
          code: 'active-landing-arrangement',
          detail:
            'auto-merge is enabled on #13; a head push could merge and close it before its base is retargeted',
          evidence: `landing preflight: ${JSON.stringify(landing)}`,
        },
      ],
      nextSafeAction: {
        action:
          'a human decides whether to cancel auto-merge on #13, then re-runs the same selection',
        requires: ['human decision', 'an explicit re-run request'],
      },
    })
  },
}

export const fixtures: FixtureModule[] = [
  noInput,
  duplicateIdentifiers,
  singlePullRequest,
  independentPullRequests,
  alreadyCorrectChain,
  fanOut,
  diamondFanIn,
  multipleAuthors,
  externalPrerequisiteSatisfied,
  externalPrerequisiteMissing,
  cycleContradiction,
  shallowHistory,
  emptyContribution,
  unsupportedFork,
  dirtyUserCheckout,
  changedRemoteHead,
  partialPublication,
  previewLeavesStateUntouched,
  unresolvedConflict,
  activeAutoMerge,
  preparedWithoutPublication,
]
