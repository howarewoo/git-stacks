/**
 * Mutated fixtures: the sensitivity proof.
 *
 * Each entry takes a conforming scenario and breaks exactly one thing, then reports a
 * success the observed state does not support. Every entry must be caught by the
 * oracle, and by the invariant it names. A mutation the oracle misses is a hole in the
 * oracle, not a passing fixture.
 */

import { PERMITTED_ACTIONS } from '../support/actions'
import { CONTRACT_VERSION } from '../support/contract-types'
import type { PlanWrite, ResultDocument } from '../support/contract-types'
import { captureSnapshot, notPerformed, resultDocument } from '../support/documents'
import { RUBRIC_PATH, type FixtureContext, type FixtureModule } from '../support/fixture'
import {
  defineProvider,
  integrateBranch,
  planFrom,
  preparationFrom,
  publicationFrom,
  remoteOid,
  seedBranch,
  withRemoteClaims,
} from '../support/scenario'

const AT = '2026-10-01T09:00:00.000Z'
const WRITTEN_AT = '2026-10-01T09:05:00.000Z'
const WITH_BASES = [...PERMITTED_ACTIONS]

function pullRequest(number: number, head: string, base: string, author: string) {
  return {
    number,
    title: `Feature ${number}`,
    state: 'OPEN' as const,
    draft: false,
    base,
    head,
    headRepository: 'acme/widgets',
    author,
  }
}

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

/** The seeded two-branch scenario every mutation starts from. */
async function seedTwoPrs(context: FixtureContext): Promise<void> {
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
}

function publishedAssemble(options: {
  context: FixtureContext
  snapshot: ResultDocument['snapshot']
  chain: number[]
  writes: PlanWrite[]
  headsBefore?: Record<string, string>
  /** Reported hard dependencies. Omitted entirely models a plan that dropped an edge. */
  dependencies?: NonNullable<Parameters<typeof planFrom>[3]>['hardDependencies']
}): ResultDocument {
  const bases: Record<number, string> = {}
  for (const number of options.chain) {
    const base = options.context.provider.baseOf(number)
    if (base) bases[number] = base
  }
  return resultDocument({
    status: 'published',
    intent: 'execute',
    snapshot: options.snapshot,
    plan: planFrom(options.snapshot, options.chain, options.writes, {
      prohibitedActivitiesNotPerformed: notPerformed(),
      ...(options.dependencies ? { hardDependencies: options.dependencies } : {}),
    }),
    preparation: preparationFrom(
      options.chain.map((number) => {
        const identity = options.snapshot.selection.resolved.find(
          (entry) => entry.number === number,
        )
        return {
          number,
          originalHead: identity?.headOid ?? '',
          preparedHead: identity?.headOid ?? '',
          basedOn: remoteOid(options.context, 'main'),
          retainedOriginalCommits: identity ? [identity.headOid] : [],
        }
      }),
    ),
    publication: withRemoteClaims(
      publicationFrom(options.context, {
        bases,
        heads: options.headsBefore,
        observedAt: WRITTEN_AT,
      }),
      options.context,
      WRITTEN_AT,
    ),
    nextSafeAction: { action: 're-read the published bases', requires: [] },
  })
}

const wrongBase: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'wrong-base',
    title: 'A published base that does not match the reported chain',
    matrixEntry: 'mutated: wrong base',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'topology.chain',
      honestResult: false,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedTwoPrs(context)
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const { oid } = await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    // The report claims #13 sits on feat-a; the provider actually put it on unrelated.
    context.provider.updatePullRequestBase(13, 'unrelated')
    const claim = publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
    })
    void oid
    return claim
  },
}

const lostOriginalCommit: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'lost-original-commit',
    title: 'A rewritten head that no longer contains the original commit',
    matrixEntry: 'mutated: lost original commit',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'partial',
      permittedActions: WITH_BASES,
      forbiddenActions: ['push-root', 'merge-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'preservation.original-commits',
      honestResult: false,
      lostOriginalCommits: ['feat-b'],
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedTwoPrs(context)
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    // The head is rewritten from the root tip, so the original commit of #13 is gone.
    const replacement = await context.scratch('rewrite')
    replacement.checkout('main')
    await replacement.write('b.txt', 'replacement content\n')
    replacement.commit('Rewrite feat-b without the original commit')
    replacement.push('feat-b', { force: true })
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    // The report still claims the original commit was retained.
    return publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': snapshot.selection.resolved[1].headOid },
    })
  },
}

const omittedPr: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'omitted-pr',
    title: 'A selected pull request silently left out of the chain',
    matrixEntry: 'mutated: omitted PR',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['drop-selection', 'run-checks'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'selection.complete',
      honestResult: false,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedTwoPrs(context)
  },
  async run(context) {
    const snapshot = captureSnapshot(context, {
      intent: 'execute',
      capturedAt: AT,
      selection: ['12'],
    })
    await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    // #13 was selected and worked on, yet the report lists only #12.
    const claim = publishedAssemble({
      context,
      snapshot,
      chain: [12],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
    })
    claim.snapshot.selection.requested = ['12']
    return claim
  },
}

const unselectedRefWrite: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'unselected-ref-write',
    title: 'A write to a ref outside the authorized set',
    matrixEntry: 'mutated: unselected-ref write',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'partial',
      permittedActions: WITH_BASES,
      forbiddenActions: ['write-unselected-ref', 'push-root', 'delete-branch'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'preservation.unselected-refs',
      honestResult: false,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedTwoPrs(context)
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const { oid } = await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    // An unselected branch is rewritten on the way past.
    const intruder = await context.scratch('intruder')
    intruder.checkout('unrelated')
    await intruder.write('u.txt', 'rewritten by the run\n')
    const movedUnrelated = intruder.commit('Rewrite an unselected branch')
    intruder.push('unrelated')
    context.provider.recordAction('write-unselected-ref', 'unrelated')
    void movedUnrelated
    return publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
    })
  },
}

const falsePublicationClaim: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'stale-publication-claim',
    title: 'A success claim whose remote observations were never true',
    matrixEntry: 'mutated: stale/false publication claim',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'remote.claims-match',
      honestResult: false,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedTwoPrs(context)
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const { oid } = await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    const claim = publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
    })
    // Nothing re-reads the provider: the claims are asserted, not observed.
    for (const remoteClaim of claim.publication?.remoteClaims ?? []) {
      if (remoteClaim.kind === 'pr-base') remoteClaim.observed = 'refs/heads/feat-a'
      if (remoteClaim.kind === 'ref-oid' && remoteClaim.target === 'refs/heads/feat-b') {
        remoteClaim.observed = originalB
      }
    }
    void oid
    return claim
  },
}

const unresolvedConflictMutation: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'unresolved-conflict-reported-published',
    title: 'A conflict left in the index while the report claims publication',
    matrixEntry: 'mutated: unresolved conflict',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'partial',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'await-checks', 'drop-selection'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'integrity.clean',
      honestResult: false,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
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
    defineProvider(context, {
      pullRequests: [
        pullRequest(12, 'feat-a', 'main', 'alice'),
        pullRequest(13, 'feat-b', 'main', 'bob'),
      ],
    })
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    // The integration conflicts and the run leaves the conflict in place.
    const scratch = await context.scratch('run')
    scratch.checkout('feat-b')
    scratch.fetch()
    scratch.mergeExpectingConflict('feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b', 'denied')
    context.provider.updatePullRequestBase(13, 'feat-a')
    const claim = publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
    })
    return claim
  },
}

const forbiddenCheckExecution: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'forbidden-check-execution',
    title: 'A run that executes the test suite while flattening',
    matrixEntry: 'mutated: forbidden check execution',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'await-checks', 'rerun-checks', 'weaken-protection'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'remote.actions-permitted',
      honestResult: false,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedTwoPrs(context)
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    const { oid } = await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    // The run also runs the suite and polls for checks, and then reports success.
    context.recordCommand('npm test')
    context.recordCommand('gh pr checks 13 --watch')
    context.provider.recordAction('run-checks', '13')
    context.provider.recordAction('await-checks', '13')
    void oid
    return publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
    })
  },
}

/** Two branches where #13 already contains #12, so #12 -> #13 is an observed hard edge. */
async function seedIntegratedPair(context: FixtureContext): Promise<void> {
  await seedTwoPrs(context)
  await integrateBranch(context, 'seed-integrate', 'feat-b', 'feat-a')
}

const omittedEdge: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'omitted-hard-edge',
    title: 'A plan that never declares a hard dependency the pre-run evidence proves',
    matrixEntry: 'mutated: omitted hard dependency edge',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: false,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedIntegratedPair(context)
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    return publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
      // dependencies omitted on purpose: the edge exists whether or not it is declared.
    })
  },
}

const wrongOrder: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'wrong-order',
    title: 'A declared hard edge ordered after the pull request that depends on it',
    matrixEntry: 'mutated: dependency ordered backwards',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'topology.dependencies',
      honestResult: false,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedIntegratedPair(context)
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    context.provider.recordAction('push-selected-head', 'feat-b')
    context.provider.updatePullRequestBase(13, 'feat-a')
    return publishedAssemble({
      context,
      snapshot,
      // The report puts the dependent first while declaring the edge.
      chain: [13, 12],
      writes: [headWrite('feat-b'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-b': originalB },
      dependencies: [
        {
          before: 12,
          after: 13,
          source: 'pr-base',
          evidence: '#13 is retargeted onto the head of #12',
        },
      ],
    })
  },
}

const oldPredecessor: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'old-predecessor',
    title: 'A successor pinned to a predecessor head that no longer carries the prepared state',
    matrixEntry: 'mutated: stale predecessor state',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'preservation.cumulative',
      honestResult: false,
    },
    humanReview: { required: true, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedTwoPrs(context)
    // #13 was prepared against the state #12 had at seed time.
    await integrateBranch(context, 'seed-integrate', 'feat-b', 'feat-a')
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    // #12 moves on; #13 still carries the earlier state of #12.
    const revised = await context.scratch('revise-a')
    revised.checkout('feat-a')
    await revised.write('a.txt', 'a revised\n')
    revised.commit('Revise A')
    revised.push('feat-a')
    context.provider.recordAction('push-selected-head', 'feat-a')
    context.provider.updatePullRequestBase(13, 'feat-a')
    return publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [headWrite('feat-a'), baseWrite(13, 'main', 'feat-a')],
      headsBefore: { 'feat-a': snapshot.selection.resolved[0].headOid, 'feat-b': originalB },
      dependencies: [
        {
          before: 12,
          after: 13,
          source: 'pr-base',
          evidence: '#13 is retargeted onto the head of #12',
        },
      ],
    })
  },
}

const firstBaseWrong: FixtureModule = {
  spec: {
    contractVersion: CONTRACT_VERSION,
    id: 'first-base-wrong',
    title: 'The first chain position is not pinned to the root',
    matrixEntry: 'mutated: first chain position off the root',
    kind: 'mutation',
    selection: ['12', '13'],
    expect: {
      status: 'published',
      permittedActions: WITH_BASES,
      forbiddenActions: ['run-checks', 'merge-pr'],
      chain: [12, 13],
      preserved: { root: true, unselectedRefs: ['refs/heads/unrelated'], userWorkspace: true },
      mustDetectInvariant: 'topology.chain',
      honestResult: false,
    },
    humanReview: { required: false, rubric: RUBRIC_PATH },
  },
  async setup(context) {
    await seedTwoPrs(context)
  },
  async run(context) {
    const selection = ['12', '13']
    const snapshot = captureSnapshot(context, { intent: 'execute', capturedAt: AT, selection })
    const originalB = snapshot.selection.resolved[1].headOid
    await integrateBranch(context, 'run', 'feat-b', 'feat-a')
    context.provider.recordAction('push-selected-head', 'feat-b')
    // The chain claims to start at the root; the first PR is actually based elsewhere.
    context.provider.updatePullRequestBase(12, 'unrelated')
    context.provider.updatePullRequestBase(13, 'feat-a')
    return publishedAssemble({
      context,
      snapshot,
      chain: [12, 13],
      writes: [
        headWrite('feat-b'),
        baseWrite(12, 'main', 'unrelated'),
        baseWrite(13, 'main', 'feat-a'),
      ],
      headsBefore: { 'feat-b': originalB },
      dependencies: [
        {
          before: 12,
          after: 13,
          source: 'pr-base',
          evidence: '#13 is retargeted onto the head of #12',
        },
      ],
    })
  },
}

export const fixtures: FixtureModule[] = [
  wrongBase,
  lostOriginalCommit,
  omittedPr,
  unselectedRefWrite,
  falsePublicationClaim,
  unresolvedConflictMutation,
  forbiddenCheckExecution,
  omittedEdge,
  wrongOrder,
  oldPredecessor,
  firstBaseWrong,
]
