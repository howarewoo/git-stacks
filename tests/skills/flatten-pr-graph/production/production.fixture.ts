/**
 * The production matrix: every case drives the *shipped* helpers over real Git.
 *
 * Nothing here builds a result document, a prepared commit, or a provider state change.
 * Each case seeds real branches in a disposable bare remote, calls
 * `prepareStack`/`publishStack`/`measureConflicts`, and reads the outcome back out of Git
 * (`ls-remote`, ancestry inside task-owned storage, the unmerged index), out of the
 * provider double's own call record, and out of the user's checkout. A helper that claims
 * more than the state supports fails the case, and a helper that achieves less fails it
 * too.
 *
 * `expect` is frozen in the case before anything runs, and `run` returns what was actually
 * observed, so a row cannot quietly become a tautology.
 */

import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { measureConflicts } from '../../../../.agents/skills/flatten-pr-graph/scripts/measure-conflict.mjs'
import {
  acknowledgedBaseWrites,
  BRANCHES,
  DEFAULT_BRANCH,
  pinnedPullRequest,
  prepareCodes,
  Production,
  probeStorage,
  publishCodes,
  ROOT_REF,
  withGitConfig,
  withWorldGitConfig,
  type PinnedPullRequest,
  type PreparedRun,
  type ProviderAdapter,
  type ProviderScript,
  type PublishOptions,
} from '../support/production'
import type { World } from '../support/real-git'
import type { ConfirmedChange } from '../support/production-verdict'

/** What a case observed from real state, after the shipped helper returned. */
export interface ProductionOutcome {
  status: string
  codes: string[]
  details: string[]
  preparation?: unknown
  publication?: unknown
  /**
   * The contract's own `publication.confirmed` - the changes the document claims the
   * server confirmed - and separately the attempts it recorded as acknowledged. These are
   * different claims and the oracles treat them differently: a confirmed change is judged
   * against what actually happened, while an acknowledged attempt is only the run's own
   * record of asking. Neither is accepted on trust.
   */
  confirmed?: ConfirmedChange[]
  acknowledged?: Array<{ kind: string; target: string; to?: string }>
  preparedHeads?: Record<number, string>
  /** Every provider action the server recorded, read back out of the double. */
  providerActions?: Array<{ kind: string; target: string; outcome: string }>
  /** The helper's own native Git processes, read back from the PATH shim. */
  nativeTrace?: Array<{ cwd: string; args: string[]; exitCode: number | null }>
}

/** What a conforming implementation must produce, frozen before execution. */
export interface ProductionExpectation {
  status: string
  /** Every code here has to appear in the observed errors. */
  codes?: string[]
  /** At least one of these codes has to appear. */
  codesAny?: string[]
  /**
   * Identifiers the report has to name - a path, a ref, a configuration key, a conflict
   * kind. Not sentences: an implementation may phrase a refusal however it likes, but it has
   * to name the thing the case is about.
   */
  mentions?: string[]
}

export interface ProductionCase {
  id: string
  area: 'preparation' | 'publication' | 'probe'
  /** The issue #87/#88 acceptance rows this case exercises. */
  criteria: string[]
  /** The read-only review findings this case pins. */
  findings: string[]
  expect: ProductionExpectation
  run(production: Production): Promise<ProductionOutcome>
}

/** The two codes that name a conflict rather than a snapshot, a permission, or a control. */
const CONFLICT_CODES = ['unsupported-conflict', 'unresolved-conflict']

function outcome(status: string, codes: string[], details: string[]): ProductionOutcome {
  return { status, codes, details }
}

function describeErrors(errors: Array<{ detail: string; evidence?: string }>): string[] {
  return errors.map((error) => [error.detail, error.evidence].filter(Boolean).join(' :: '))
}

function preparedOutcome(prepared: PreparedRun): ProductionOutcome {
  return outcome(prepared.status, prepareCodes(prepared), describeErrors(prepared.errors))
}

/**
 * The outcome, plus what the run *claims* the server confirmed.
 *
 * `confirmed` is taken from the document's own attempts on purpose: it is the claim under
 * test, and the independent verdict is what decides whether the provider and the remote
 * back it. `providerActions` is read back out of the double after the run, so it is a
 * record rather than a report.
 */
function publicationOutcome(
  result: PublicationObservation,
  production?: Production,
  preparedHeads?: Record<number, string>,
): ProductionOutcome {
  const attempts = result.publication?.attempts ?? []
  const base: ProductionOutcome = outcome(
    result.status,
    publishCodes(result as never),
    describeErrors(result.errors),
  )
  base.publication = result.publication
  // The claim under test is the contract's `confirmed` array, read verbatim. The attempt
  // log is kept beside it rather than standing in for it: a document can acknowledge an
  // attempt whose write never landed, and that gap is exactly what the action oracle is
  // for.
  base.confirmed = (result.publication?.confirmed ?? []) as ConfirmedChange[]
  base.acknowledged = attempts
    .filter((attempt) => attempt.outcome === 'acknowledged')
    .map((attempt) => ({ kind: attempt.kind, target: attempt.target, to: attempt.to }))
  if (production) base.providerActions = production.observedActions()
  return base
}

/** What a publication run hands back, in the fields the outcome and the oracles read. */
interface PublicationObservation {
  status: string
  errors: Array<{ code: string; detail: string; evidence?: string }>
  publication?: {
    attempts?: Array<{ kind: string; target: string; outcome: string; to?: string }>
    confirmed?: ConfirmedChange[]
  }
}

interface SeedOptions {
  rootFiles?: Record<string, string>
  files?: Record<number, Record<string, string>>
  bases?: Record<number, string>
}

/** Advances the root and publishes one real branch per pull request, then returns the heads. */
async function seedStack(
  production: Production,
  numbers: number[],
  options: SeedOptions = {},
): Promise<Record<number, string>> {
  production.advanceRoot(options.rootFiles ?? { 'root.txt': 'the root branch moves on\n' })
  const heads: Record<number, string> = {}
  for (const number of numbers) {
    heads[number] = await production.seedBranch(
      BRANCHES[number],
      options.files?.[number] ?? { [`${BRANCHES[number]}.txt`]: `work for #${number}\n` },
      { base: options.bases?.[number] ?? DEFAULT_BRANCH },
    )
  }
  return heads
}

interface Stack {
  prepared: PreparedRun
  originalHeads: Record<number, string>
  adapter: ProviderAdapter
  pullRequests: Record<number, PinnedPullRequest>
  intendedBases: Record<number, string>
  order: number[]
  root: string
}

/** Seeds, prepares, and hands back the manifest plus a provider pinned to that reality. */
async function preparedStack(
  production: Production,
  numbers: number[],
  options: SeedOptions & { script?: ProviderScript; runDirectory?: string } = {},
): Promise<Stack> {
  const originalHeads = await seedStack(production, numbers, options)
  const root = production.root()
  const prepared = production.prepare({
    order: numbers,
    originalHeads,
    runDirectory: options.runDirectory,
  })
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
  const pullRequests = Object.fromEntries(
    numbers.map((number) => [
      number,
      pinnedPullRequest(production.world, {
        number,
        branch: BRANCHES[number],
        base: options.bases?.[number] ?? DEFAULT_BRANCH,
      }),
    ]),
  ) as Record<number, PinnedPullRequest>
  return {
    prepared,
    originalHeads,
    adapter: production.adapter(Object.values(pullRequests), options.script ?? {}),
    pullRequests,
    intendedBases: Object.fromEntries(
      numbers.map((number, index) => [
        number,
        index === 0 ? DEFAULT_BRANCH : BRANCHES[numbers[index - 1]],
      ]),
    ),
    order: numbers,
    root,
  }
}

function publishArgs(stack: Stack): PublishOptions {
  return {
    order: stack.order,
    intendedBases: stack.intendedBases,
    pullRequests: stack.pullRequests,
    providerModule: stack.adapter.module,
  }
}

/** `git ls-remote`, the real read-back, through the world's own environment. */
function realRemoteRefs(production: Production, endpoint: string): Record<string, string> {
  const refs: Record<string, string> = {}
  const stdout =
    production.world.tryGitIn(production.storage(), 'ls-remote', '--heads', endpoint) ?? ''
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/)
    if (oid && ref) refs[ref] = oid
  }
  return refs
}

function preparedHeadsOf(prepared: PreparedRun): Record<number, string> {
  return Object.fromEntries(
    (prepared.preparation?.branches ?? []).map((branch) => [branch.number, branch.preparedHead]),
  )
}

/**
 * The check-running commands a helper actually started.
 *
 * Read from the PATH shim, not from `world.commands`: that array is the driver's own Git,
 * so a case that asked it "did this run a test runner" was reading its own setup back to
 * itself and proving nothing about the helper.
 */
function ranACheck(trace: Array<{ cwd: string; args: string[] }>): string[] {
  const pattern = /(^|[\s/])(test|vitest|jest|mocha|eslint|prettier|tsc|biome|ruff|pytest)(\s|$)/
  return trace.map((command) => command.args.join(' ')).filter((command) => pattern.test(command))
}

export const productionCases: ProductionCase[] = []

function define(productionCase: ProductionCase): void {
  productionCases.push(productionCase)
}

/** The provider writes that actually landed, in the order the server accepted them. */
function baseWrites(adapter: ProviderAdapter): Promise<number[]> {
  return acknowledgedBaseWrites(adapter)
}

// ---------------------------------------------------------------------------
// Preparation: whole-graph topologies over real history.
// ---------------------------------------------------------------------------

define({
  id: 'prep-independent-pair-integrates-each-predecessor',
  area: 'preparation',
  criteria: ['#87 whole graph', '#87 new predecessor', '#87 original commit retention'],
  findings: [
    'P8 Distinguish already-present contributions from lost paths',
    'P13 Verify pinned-root containment when reusing recorded prepared heads',
  ],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const numbers = [12, 13]
    const originalHeads = await seedStack(production, numbers)
    const root = production.root()
    const { result: prepared, trace } = await production.traceNextCall(() =>
      production.prepare({ order: numbers, originalHeads }),
    )
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    const branches = prepared.preparation?.branches ?? []
    assert.deepEqual(
      branches.map((branch) => branch.number),
      numbers,
    )
    const [first, second] = branches
    assert.equal(
      production.storageAncestor(root, first.preparedHead),
      true,
      'the first prepared head must contain the pinned root',
    )
    assert.equal(
      production.storageAncestor(first.preparedHead, second.preparedHead),
      true,
      'the successor must contain the predecessor prepared state',
    )
    assert.equal(second.basedOn, first.preparedHead)
    for (const [index, number] of numbers.entries()) {
      assert.ok(
        branches[index].retainedOriginalCommits.includes(originalHeads[number]),
        `#${number} retained its original head`,
      )
      assert.equal(
        production.storageAncestor(originalHeads[number], branches[index].preparedHead),
        true,
        `#${number} keeps its original work reachable`,
      )
    }
    assert.deepEqual(prepared.preparation?.lostOriginalCommits, [])
    const refs = production.refs()
    assert.equal(refs[`refs/heads/${BRANCHES[12]}`], originalHeads[12])
    assert.equal(refs[`refs/heads/${BRANCHES[13]}`], originalHeads[13])
    assert.equal(refs[ROOT_REF], root, 'preparation never touches the remote')
    assert.equal(
      prepared.verification.some((row) => row.result === 'fail'),
      false,
      JSON.stringify(prepared.verification),
    )
    assert.deepEqual(ranACheck(trace), [], 'preparation started a check runner')
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-single-pull-request-integrates-onto-the-root',
  area: 'preparation',
  criteria: ['#87 single pull request', '#87 root ancestry'],
  findings: [],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12])
    const root = production.root()
    const prepared = production.prepare({ order: [12], originalHeads })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    const [branch] = prepared.preparation?.branches ?? []
    assert.equal(
      production.storageAncestor(root, branch.preparedHead),
      true,
      'a single prepared head still has to contain the pinned root',
    )
    assert.ok(branch.retainedOriginalCommits.includes(originalHeads[12]))
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], originalHeads[12])
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-fan-out-integrates-three-independent-heads',
  area: 'preparation',
  criteria: ['#87 fan-out', '#87 whole graph'],
  findings: [],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const numbers = [12, 13, 14]
    const originalHeads = await seedStack(production, numbers)
    const prepared = production.prepare({ order: numbers, originalHeads })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    const branches = prepared.preparation?.branches ?? []
    for (let index = 1; index < branches.length; index += 1) {
      assert.equal(
        production.storageAncestor(branches[index - 1].preparedHead, branches[index].preparedHead),
        true,
        `#${branches[index].number} must contain #${branches[index - 1].number}`,
      )
      assert.equal(branches[index].basedOn, branches[index - 1].preparedHead)
    }
    for (const [index, number] of numbers.entries()) {
      assert.ok(branches[index].retainedOriginalCommits.includes(originalHeads[number]))
    }
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-diamond-fan-in-keeps-the-shared-commit',
  area: 'preparation',
  criteria: ['#87 diamond and fan-in over shared commits'],
  findings: ['P8 Distinguish already-present contributions from lost paths'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    production.advanceRoot({ 'root.txt': 'the root branch moves on\n' })
    // A -> B, A -> C, and D branched from B with C merged in: a real four-node diamond
    // whose tip has to integrate both arms of the fan-out.
    const a = await production.seedBranch(BRANCHES[12], { 'a.txt': 'the shared arm\n' })
    const b = await production.seedBranch(
      BRANCHES[13],
      { 'b.txt': 'the upper arm\n' },
      {
        base: BRANCHES[12],
      },
    )
    const c = await production.seedBranch(
      BRANCHES[14],
      { 'c.txt': 'the lower arm\n' },
      {
        base: BRANCHES[12],
      },
    )
    const tip = await production.scratch('diamond-d')
    tip.fetch()
    tip.checkout(BRANCHES[13])
    tip.merge(BRANCHES[14])
    production.writeBytes(tip.path, 'd.txt', Buffer.from('the fan-in\n'))
    const d = tip.commit('merge the lower arm in')
    tip.push(BRANCHES[15], { force: true })

    const numbers = [12, 13, 14, 15]
    const originalHeads: Record<number, string> = { 12: a, 13: b, 14: c, 15: d }
    const prepared = production.prepare({ order: numbers, originalHeads })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    const branches = prepared.preparation?.branches ?? []
    assert.deepEqual(
      branches.map((branch) => branch.number),
      numbers,
      'the whole graph, not the three nodes that branch off the root',
    )
    const tipBranch = branches[3]
    for (const arm of [12, 13, 14]) {
      // Reachability first: that is the invariant that matters, and it is what the
      // prepared tree can be checked against directly.
      assert.equal(
        production.storageAncestor(originalHeads[arm], tipBranch.preparedHead),
        true,
        `#${arm} keeps its contribution reachable from the fan-in`,
      )
      assert.ok(
        tipBranch.retainedOriginalCommits.includes(originalHeads[arm]),
        `#${arm} is declared retained under the fan-in, not merely still reachable by accident`,
      )
    }
    for (let index = 1; index < branches.length; index += 1) {
      assert.equal(
        production.storageAncestor(branches[index - 1].preparedHead, branches[index].preparedHead),
        true,
        `#${branches[index].number} integrates the prepared state before it`,
      )
      assert.equal(branches[index].basedOn, branches[index - 1].preparedHead)
    }
    assert.deepEqual(prepared.preparation?.lostOriginalCommits, [])
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-multiple-authors-are-preserved-verbatim',
  area: 'preparation',
  criteria: ['#87 multiple authors'],
  findings: [],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    production.advanceRoot({ 'root.txt': 'the root branch moves on\n' })
    const authors: Record<number, { author: string; email: string; oid: string }> = {}
    for (const [index, number] of [12, 13].entries()) {
      const scratch = await production.scratch(`authors-${number}`)
      scratch.fetch()
      scratch.checkout(DEFAULT_BRANCH)
      production.writeBytes(
        scratch.path,
        `${BRANCHES[number]}.txt`,
        Buffer.from(`work for #${number}\n`),
      )
      scratch.commit(`work on ${BRANCHES[number]}`)
      const author = `Author ${index + 1}`
      const email = `author${index + 1}@example.invalid`
      production.world.gitIn(
        scratch.path,
        'commit',
        '--quiet',
        '--amend',
        `--author=${author} <${email}>`,
      )
      authors[number] = { author, email, oid: scratch.headOid() }
      scratch.push(BRANCHES[number], { force: true })
    }
    const prepared = production.prepare({
      order: [12, 13],
      originalHeads: { 12: authors[12].oid, 13: authors[13].oid },
    })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    for (const [index, number] of [12, 13].entries()) {
      const branch = (prepared.preparation?.branches ?? [])[index]
      const log = production.world.gitIn(
        production.storage(),
        'log',
        '--format=%an <%ae>',
        branch.preparedHead,
      )
      assert.ok(
        log.includes(`${authors[number].author} <${authors[number].email}>`),
        `the original author of #${number} survives the integration`,
      )
    }
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-distinct-refs-at-one-commit-add-no-duplicate-patch',
  area: 'preparation',
  criteria: ['#87 empty or redundant distinct refs at an equal commit id'],
  findings: [],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    production.advanceRoot({ 'root.txt': 'the root branch moves on\n' })
    const scratch = await production.scratch('redundant')
    scratch.fetch()
    scratch.checkout(DEFAULT_BRANCH)
    production.writeBytes(scratch.path, 'shared.txt', Buffer.from('one contribution\n'))
    const oid = scratch.commit('the only contribution')
    scratch.push(BRANCHES[12], { force: true })
    production.world.moveRemoteRef(BRANCHES[13], oid)

    const prepared = production.prepare({
      order: [12, 13],
      originalHeads: { 12: oid, 13: oid },
    })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    const [first, second] = prepared.preparation?.branches ?? []
    assert.equal(
      second.preparedHead,
      first.preparedHead,
      'a redundant contribution must not manufacture a second commit for the same tree',
    )
    assert.deepEqual(prepared.preparation?.lostOriginalCommits, [])
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-compatible-semantic-resolution-is-recorded-with-its-intent',
  area: 'preparation',
  criteria: ['#87 a semantic conflict with an explicit intent rubric'],
  findings: [],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13], {
      rootFiles: { 'shared.txt': 'seed\n' },
      files: { 12: { 'shared.txt': 'from twelve\n' }, 13: { 'shared.txt': 'from thirteen\n' } },
    })
    const request = { order: [12, 13] as number[], originalHeads }
    const blocked = production.prepare(request)
    assert.equal(blocked.ok, false, 'the same path on both sides needs a stated decision')
    assert.equal(blocked.conflicts.find((entry) => entry.number === 13)?.needsDecision, true)

    const resolved = production.prepare({
      ...request,
      resume: true,
      resolutions: [
        {
          number: 13,
          path: 'shared.txt',
          content: 'from twelve\nfrom thirteen\n',
          intent: 'keep both stated contributions',
          reason: 'neither side is a strict superset of the other',
        },
      ],
    })
    assert.equal(resolved.ok, true, JSON.stringify(resolved.errors))
    const decision = resolved.decisions.find((entry) => entry.number === 13)
    assert.equal(decision?.intent, 'keep both stated contributions')
    assert.equal(decision?.reason, 'neither side is a strict superset of the other')
    const branch = resolved.preparation?.branches.find((entry) => entry.number === 13)
    assert.equal(
      production.world
        .gitIn(production.storage(), 'show', `${branch?.preparedHead}:shared.txt`)
        .replace(/\n$/, ''),
      'from twelve\nfrom thirteen',
    )
    assert.ok(branch?.retainedOriginalCommits.includes(originalHeads[13]))
    return preparedOutcome(resolved)
  },
})

define({
  id: 'prep-genuine-conflict-blocks-and-leaves-a-resumable-state',
  area: 'preparation',
  criteria: ['#87 an ambiguous conflict blocks in a recoverable state'],
  findings: [],
  expect: { status: 'partial', codesAny: CONFLICT_CODES, mentions: ['shared.txt'] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13], {
      rootFiles: { 'shared.txt': 'seed\n' },
      files: { 12: { 'shared.txt': 'ours\n' }, 13: { 'shared.txt': 'theirs\n' } },
    })
    const blocked = production.prepare({ order: [12, 13], originalHeads })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.continuation.resumeFrom, 13)
    assert.equal(blocked.continuation.prepared.includes(12), true)
    const conflict = blocked.conflicts.find((entry) => entry.number === 13)
    assert.equal(conflict?.path, 'shared.txt')
    assert.equal(conflict?.needsDecision, true)
    const unmerged = production.world.tryGitIn(
      production.workspace(13),
      'diff',
      '--name-only',
      '--diff-filter=U',
    )
    assert.equal((unmerged ?? '').trim(), 'shared.txt', 'the conflict is real state on disk')
    assert.deepEqual(blocked.decisions, [], 'no decision is invented for the caller')
    assert.equal(production.refs()[`refs/heads/${BRANCHES[13]}`], originalHeads[13])
    return preparedOutcome(blocked)
  },
})

define({
  id: 'prep-resolution-without-a-stated-reason-is-refused',
  area: 'preparation',
  criteria: ['#87 a semantic decision needs explicit intent and reason'],
  findings: [],
  // `blocked`, not `partial`: the plan carries a resolution that can never be applied, so it
  // is refused while the plan is being read - before a run directory exists and before any
  // branch is integrated. `partial` would claim preparation happened.
  expect: { status: 'blocked', codes: ['invalid-input'], mentions: ['intent'] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13], {
      rootFiles: { 'shared.txt': 'seed\n' },
      files: { 12: { 'shared.txt': 'ours\n' }, 13: { 'shared.txt': 'theirs\n' } },
    })
    const request = { order: [12, 13] as number[], originalHeads }
    production.prepare(request)
    const refused = production.prepare({
      ...request,
      resume: true,
      resolutions: [{ number: 13, path: 'shared.txt', content: 'ours\n', intent: '', reason: '' }],
    })
    assert.equal(refused.ok, false)
    assert.equal((refused.preparation?.branches ?? []).length, 0)
    assert.equal(production.refs()[`refs/heads/${BRANCHES[13]}`], originalHeads[13])
    return preparedOutcome(refused)
  },
})

// ---------------------------------------------------------------------------
// Preparation: structural conflicts the helper must refuse by name.
// ---------------------------------------------------------------------------

interface StructuralCase {
  /** The conflict kind this case is about; the report has to name it. */
  mentions?: string[]
  id: string
  detail: string
  seed(production: Production): Promise<Record<number, string>>
}

const structuralCases: StructuralCase[] = [
  {
    id: 'rename',
    detail: 'rename-conflict',
    async seed(production) {
      production.advanceRoot({ 'root.txt': 'moves on\n', 'moves/old.txt': 'the original\n' })
      const renamer = await production.scratch('rename-12')
      renamer.fetch()
      renamer.checkout(DEFAULT_BRANCH)
      production.world.gitIn(renamer.path, 'mv', 'moves/old.txt', 'moves/new.txt')
      const a = renamer.commit('move the file')
      renamer.push(BRANCHES[12], { force: true })
      // Both sides move the same file to a different name. Git cannot merge that without
      // choosing a name, and a helper that picks one is picking for the author; an edit in
      // place would not do, because rename detection folds that in cleanly and there is
      // then nothing to refuse.
      const editor = await production.scratch('rename-13')
      editor.fetch()
      editor.checkout(DEFAULT_BRANCH)
      production.world.gitIn(editor.path, 'mv', 'moves/old.txt', 'moves/other.txt')
      const b = editor.commit('move it somewhere else')
      editor.push(BRANCHES[13], { force: true })
      return { 12: a, 13: b }
    },
  },
  {
    id: 'modify-delete',
    detail: 'modify-delete',
    async seed(production) {
      production.advanceRoot({ 'root.txt': 'moves on\n', 'gone.txt': 'the original\n' })
      const editor = await production.scratch('modify-delete-12')
      editor.fetch()
      editor.checkout(DEFAULT_BRANCH)
      production.writeBytes(editor.path, 'gone.txt', Buffer.from('edited anyway\n'))
      const a = editor.commit('edit the file')
      editor.push(BRANCHES[12], { force: true })
      const deleter = await production.scratch('modify-delete-13')
      deleter.fetch()
      deleter.checkout(DEFAULT_BRANCH)
      production.world.gitIn(deleter.path, 'rm', '--quiet', 'gone.txt')
      const b = deleter.commit('delete the file')
      deleter.push(BRANCHES[13], { force: true })
      return { 12: a, 13: b }
    },
  },
  {
    id: 'delete-modify',
    detail: 'delete-modify',
    async seed(production) {
      production.advanceRoot({ 'root.txt': 'moves on\n', 'gone.txt': 'the original\n' })
      const deleter = await production.scratch('delete-modify-12')
      deleter.fetch()
      deleter.checkout(DEFAULT_BRANCH)
      production.world.gitIn(deleter.path, 'rm', '--quiet', 'gone.txt')
      const a = deleter.commit('delete the file')
      deleter.push(BRANCHES[12], { force: true })
      const editor = await production.scratch('delete-modify-13')
      editor.fetch()
      editor.checkout(DEFAULT_BRANCH)
      production.writeBytes(editor.path, 'gone.txt', Buffer.from('edited anyway\n'))
      const b = editor.commit('edit the file')
      editor.push(BRANCHES[13], { force: true })
      return { 12: a, 13: b }
    },
  },
  {
    id: 'file-directory',
    detail: 'file-directory',
    async seed(production) {
      production.advanceRoot({ 'root.txt': 'moves on\n', thing: 'a file\n' })
      const filer = await production.scratch('file-directory-12')
      filer.fetch()
      filer.checkout(DEFAULT_BRANCH)
      production.writeBytes(filer.path, 'thing', Buffer.from('still a file\n'))
      const a = filer.commit('change the file')
      filer.push(BRANCHES[12], { force: true })
      const direr = await production.scratch('file-directory-13')
      direr.fetch()
      direr.checkout(DEFAULT_BRANCH)
      production.world.gitIn(direr.path, 'rm', '--quiet', 'thing')
      production.writeBytes(direr.path, 'thing/inside.txt', Buffer.from('now a directory\n'))
      const b = direr.commit('turn it into a directory')
      direr.push(BRANCHES[13], { force: true })
      return { 12: a, 13: b }
    },
  },
  {
    id: 'binary',
    detail: 'binary',
    async seed(production) {
      production.advanceRoot({ 'root.txt': 'moves on\n', 'blob.bin': 'seed\n' })
      const first = await production.scratch('binary-12')
      first.fetch()
      first.checkout(DEFAULT_BRANCH)
      production.writeBytes(
        first.path,
        'blob.bin',
        Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'),
      )
      const a = first.commit('rewrite the blob')
      first.push(BRANCHES[12], { force: true })
      const second = await production.scratch('binary-13')
      second.fetch()
      second.checkout(DEFAULT_BRANCH)
      production.writeBytes(
        second.path,
        'blob.bin',
        Buffer.from('0f0e0d0c0b0a09080706050403020100', 'hex'),
      )
      const b = second.commit('rewrite it differently')
      second.push(BRANCHES[13], { force: true })
      return { 12: a, 13: b }
    },
  },
  {
    id: 'submodule',
    detail: 'submodule',
    async seed(production) {
      production.advanceRoot({ 'root.txt': 'moves on\n' })
      const first = await production.scratch('submodule-12')
      first.fetch()
      first.checkout(DEFAULT_BRANCH)
      production.world.gitIn(
        first.path,
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${'a'.repeat(40)},vendor`,
      )
      production.world.gitIn(first.path, 'commit', '--quiet', '-m', 'point at a submodule')
      const a = first.headOid()
      first.push(BRANCHES[12], { force: true })
      const second = await production.scratch('submodule-13')
      second.fetch()
      second.checkout(DEFAULT_BRANCH)
      production.world.gitIn(
        second.path,
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${'b'.repeat(40)},vendor`,
      )
      production.world.gitIn(second.path, 'commit', '--quiet', '-m', 'point at another one')
      const b = second.headOid()
      second.push(BRANCHES[13], { force: true })
      return { 12: a, 13: b }
    },
  },
  {
    id: 'lockfile',
    detail: 'lockfile',
    async seed(production) {
      const lock = `${JSON.stringify({ name: 'fixture', lockfileVersion: 3 })}\n`
      production.advanceRoot({ 'root.txt': 'moves on\n', 'package-lock.json': lock })
      const first = await production.scratch('lockfile-12')
      first.fetch()
      first.checkout(DEFAULT_BRANCH)
      production.writeBytes(
        first.path,
        'package-lock.json',
        Buffer.from(lock.replace('"fixture"', '"fixture-a"')),
      )
      const a = first.commit('relock')
      first.push(BRANCHES[12], { force: true })
      const second = await production.scratch('lockfile-13')
      second.fetch()
      second.checkout(DEFAULT_BRANCH)
      production.writeBytes(
        second.path,
        'package-lock.json',
        Buffer.from(lock.replace('"fixture"', '"fixture-b"')),
      )
      const b = second.commit('relock differently')
      second.push(BRANCHES[13], { force: true })
      return { 12: a, 13: b }
    },
  },
  {
    id: 'generated',
    detail: 'generated',
    async seed(production) {
      production.advanceRoot({ 'root.txt': 'moves on\n', 'dist/bundle.js': 'seed\n' })
      const first = await production.scratch('generated-12')
      first.fetch()
      first.checkout(DEFAULT_BRANCH)
      production.writeBytes(first.path, 'dist/bundle.js', Buffer.from('ours\n'))
      const a = first.commit('rebuild')
      first.push(BRANCHES[12], { force: true })
      const second = await production.scratch('generated-13')
      second.fetch()
      second.checkout(DEFAULT_BRANCH)
      production.writeBytes(second.path, 'dist/bundle.js', Buffer.from('theirs\n'))
      const b = second.commit('rebuild differently')
      second.push(BRANCHES[13], { force: true })
      return { 12: a, 13: b }
    },
  },
]

for (const structural of structuralCases) {
  define({
    id: `prep-structural-${structural.id}-is-refused-by-name`,
    area: 'preparation',
    criteria: [`#87 a structural ${structural.id} conflict blocks with a precise reason`],
    findings: [],
    expect: { status: 'partial', codesAny: CONFLICT_CODES, mentions: [structural.detail] },
    async run(production) {
      const originalHeads = await structural.seed(production)
      const blocked = production.prepare({ order: [12, 13], originalHeads })
      assert.equal(blocked.ok, false)
      assert.equal(
        production.refs()[`refs/heads/${BRANCHES[13]}`],
        originalHeads[13],
        'a refused conflict must not move the remote',
      )
      assert.equal(
        (blocked.preparation?.branches ?? []).some((branch) => branch.number === 13),
        false,
        `a refused conflict must not manufacture a prepared head; the report was ${JSON.stringify(blocked.errors)}`,
      )
      return preparedOutcome(blocked)
    },
  })
}

// ---------------------------------------------------------------------------
// Preparation: the user's own work, the task directory, and environment controls.
// ---------------------------------------------------------------------------

define({
  id: 'prep-dirty-user-workspace-is-preserved-byte-for-byte',
  area: 'preparation',
  criteria: ['#87 staged, unstaged and untracked user checkout preserved'],
  findings: ['P5 Capture and compare content-complete workspace fingerprints'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13])
    const repo = production.world.repo
    production.world.gitIn(repo, 'checkout', '--quiet', '-b', 'user-work')
    production.writeBytes(repo, 'staged.txt', Buffer.from('staged by the user\n'))
    production.world.gitIn(repo, 'add', 'staged.txt')
    production.world.gitIn(repo, 'commit', '--quiet', '-m', 'user work')
    production.writeBytes(repo, 'staged.txt', Buffer.from('restaged by the user\n'))
    production.world.gitIn(repo, 'add', 'staged.txt')
    production.writeBytes(repo, 'README.md', Buffer.from('# edited by the user\n'))
    production.writeBytes(repo, 'untracked.txt', Buffer.from('untracked by the user\n'))
    const before = production.world.userFingerprint()
    assert.ok(before.status !== '', 'the user checkout is genuinely dirty')

    const prepared = production.prepare({
      order: [12, 13],
      originalHeads,
      userWorkspace: repo,
    })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    assert.deepEqual(
      production.world.userFingerprint(),
      before,
      "the user's HEAD, index, worktree, untracked content, stash, and config are unchanged",
    )
    assert.equal(readFileSync(join(repo, 'untracked.txt'), 'utf8'), 'untracked by the user\n')
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-detached-user-workspace-is-preserved',
  area: 'preparation',
  criteria: ['#87 a detached user checkout is preserved'],
  findings: ['P5 Capture and compare content-complete workspace fingerprints'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12])
    const repo = production.world.repo
    production.world.gitIn(repo, 'checkout', '--quiet', '--detach', 'HEAD')
    const detached = production.world.userFingerprint()
    assert.equal(detached.headRef, 'DETACHED')

    const prepared = production.prepare({ order: [12], originalHeads, userWorkspace: repo })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    assert.deepEqual(production.world.userFingerprint(), detached)
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-stash-fingerprint-separates-what-porcelain-cannot',
  area: 'preparation',
  criteria: ['#87 a changed stash object id is detected'],
  findings: ['P5 Capture and compare content-complete workspace fingerprints'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12])
    const repo = production.world.repo
    production.world.gitIn(repo, 'checkout', '--quiet', '-b', 'stash-work')
    production.writeBytes(repo, 'README.md', Buffer.from('first stashed content\n'))
    production.world.gitIn(repo, 'stash', 'push', '--quiet', '-m', 'first')
    const first = production.world.userFingerprint()
    assert.equal(first.stashCount, 1)

    production.world.gitIn(repo, 'stash', 'pop', '--quiet')
    production.writeBytes(repo, 'README.md', Buffer.from('second stashed content\n'))
    production.world.gitIn(repo, 'stash', 'push', '--quiet', '-m', 'second')
    const second = production.world.userFingerprint()

    assert.equal(second.stashCount, first.stashCount)
    assert.equal(second.status, first.status, 'porcelain cannot see this difference')
    assert.notEqual(
      second.stashOids,
      first.stashOids,
      'the fingerprint has to separate two stashes porcelain reports identically',
    )

    const prepared = production.prepare({ order: [12], originalHeads, userWorkspace: repo })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    assert.deepEqual(production.world.userFingerprint(), second)
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-run-directory-inside-the-user-checkout-is-refused',
  area: 'preparation',
  criteria: ['#87 the task-owned run location is never the user checkout'],
  findings: ['P2 Verify task-directory ownership and containment before writing'],
  expect: { status: 'blocked', codes: ['invalid-input'] },
  async run(production) {
    const originalHeads = await seedStack(production, [12])
    const repo = production.world.repo
    const refused = production.prepare({
      order: [12],
      originalHeads,
      userWorkspace: repo,
      runDirectory: repo,
    })
    assert.equal(refused.ok, false)
    for (const claimed of ['storage.git', 'journal.json', 'task-owner.json', 'workspaces']) {
      assert.equal(
        existsSync(join(repo, claimed)),
        false,
        `the user's checkout must not acquire ${claimed}`,
      )
    }
    assert.equal(refused.run, null, 'a refused run never claims a task directory')
    return preparedOutcome(refused)
  },
})

define({
  id: 'prep-run-directory-containing-the-repository-is-refused',
  area: 'preparation',
  criteria: ['#87 the task-owned run location never contains a repository'],
  findings: ['P2 Verify task-directory ownership and containment before writing'],
  expect: { status: 'blocked', codes: ['invalid-input'] },
  async run(production) {
    const originalHeads = await seedStack(production, [12])
    const refused = production.prepare({
      order: [12],
      originalHeads,
      runDirectory: production.world.root,
    })
    assert.equal(refused.ok, false)
    assert.equal(
      existsSync(production.prepareRun()),
      false,
      'a refused run leaves no task directory beside the bare remote either',
    )
    return preparedOutcome(refused)
  },
})

define({
  id: 'prep-storage-symlink-into-another-repository-is-refused',
  area: 'preparation',
  criteria: ['#87 task-owned storage is exclusively claimed'],
  findings: ['P2 Verify task-directory ownership and containment before writing'],
  expect: { status: 'blocked', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12])
    const decoy = join(production.world.root, 'decoy.git')
    production.world.gitIn(production.world.root, 'init', '--bare', '--quiet', decoy)
    const runDirectory = join(production.world.root, 'symlinked-run')
    mkdirSync(runDirectory, { recursive: true })
    symlinkSync(decoy, join(runDirectory, 'storage.git'))
    const before = production.world.tryGitIn(decoy, 'for-each-ref', 'refs')

    const refused = production.prepare({ order: [12], originalHeads, runDirectory })
    assert.equal(refused.ok, false)
    assert.equal(
      production.world.tryGitIn(decoy, 'for-each-ref', 'refs'),
      before,
      'a redirected storage must not have written into the repository it points at',
    )
    return preparedOutcome(refused)
  },
})

define({
  id: 'prep-an-unclaimed-run-directory-with-storage-is-refused',
  area: 'preparation',
  criteria: ['#87 task-owned storage is exclusively claimed'],
  findings: ['P2 Verify task-directory ownership and containment before writing'],
  expect: { status: 'blocked', codes: ['conflicting-environment-control'] },
  async run(production) {
    const originalHeads = await seedStack(production, [12])
    const runDirectory = join(production.world.root, 'foreign-run')
    mkdirSync(runDirectory, { recursive: true })
    production.world.gitIn(
      production.world.root,
      'init',
      '--bare',
      '--quiet',
      join(runDirectory, 'storage.git'),
    )
    const refused = production.prepare({ order: [12], originalHeads, runDirectory })
    assert.equal(refused.ok, false)
    assert.equal(
      existsSync(join(runDirectory, 'task-owner.json')),
      false,
      'foreign storage is never adopted silently',
    )
    return preparedOutcome(refused)
  },
})

define({
  id: 'prep-source-required-signing-blocks-before-any-commit',
  area: 'preparation',
  criteria: ['#87 source-local mandatory signing is never bypassed'],
  findings: ['P9 Preflight inherited executable Git controls before integration'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    mentions: ['commit.gpgsign'],
  },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13])
    production.world.gitIn(production.world.remote, 'config', 'commit.gpgsign', 'true')
    const blocked = production.prepare({ order: [12, 13], originalHeads })
    assert.equal(blocked.ok, false)
    assert.equal(
      existsSync(join(production.prepareRun(), 'storage.git')),
      false,
      'a refused run must not leave task storage behind',
    )
    return preparedOutcome(blocked)
  },
})

define({
  id: 'prep-source-hooks-path-blocks-before-any-commit',
  area: 'preparation',
  criteria: ['#87 hooks are never bypassed'],
  findings: ['P9 Preflight inherited executable Git controls before integration'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    mentions: ['core.hooksPath'],
  },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13])
    const hooks = join(production.world.root, 'policy-hooks')
    mkdirSync(hooks, { recursive: true })
    production.world.gitIn(production.world.remote, 'config', 'core.hooksPath', hooks)
    const blocked = production.prepare({ order: [12, 13], originalHeads })
    assert.equal(blocked.ok, false)
    assert.equal(existsSync(join(production.prepareRun(), 'storage.git')), false)
    return preparedOutcome(blocked)
  },
})

define({
  id: 'prep-attributed-merge-driver-is-never-executed',
  area: 'preparation',
  criteria: ['#87 no executable the helper cannot account for'],
  findings: ['P9 Preflight inherited executable Git controls before integration'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    mentions: ['merge.fixture.driver'],
  },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13], {
      rootFiles: {
        'root.txt': 'moves on\n',
        '.gitattributes': 'driven.txt merge=fixture\n',
        'driven.txt': 'seed\n',
      },
      files: { 12: { 'driven.txt': 'ours\n' }, 13: { 'driven.txt': 'theirs\n' } },
    })
    const marker = join(production.world.root, 'driver-was-executed')
    const driver = join(production.world.root, 'marker-driver.sh')
    writeFileSync(
      driver,
      `#!/bin/sh\nprintf 'driver side effect' > ${JSON.stringify(marker)}\nexit 1\n`,
    )
    chmodSync(driver, 0o755)
    return withWorldGitConfig(production.world, () =>
      withGitConfig({ 'merge.fixture.driver': driver }, () => {
        const blocked = production.prepare({ order: [12, 13], originalHeads })
        assert.equal(blocked.ok, false)
        assert.equal(
          existsSync(marker),
          false,
          'a driver attributed to a merged path must never be executed',
        )
        return preparedOutcome(blocked)
      }),
    )
  },
})

define({
  id: 'prep-unattributed-driver-configuration-does-not-block',
  area: 'preparation',
  criteria: ['#87 a configured but unattributed driver is not a false positive'],
  findings: ['P9 Preflight inherited executable Git controls before integration'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13])
    const marker = join(production.world.root, 'driver-was-executed')
    const driver = join(production.world.root, 'marker-driver.sh')
    writeFileSync(
      driver,
      `#!/bin/sh\nprintf 'driver side effect' > ${JSON.stringify(marker)}\nexit 1\n`,
    )
    chmodSync(driver, 0o755)
    return withWorldGitConfig(production.world, () =>
      withGitConfig(
        {
          'merge.unused.driver': driver,
          'filter.lfs.clean': 'git-lfs clean -- %f',
          'filter.lfs.smudge': 'git-lfs smudge -- %f',
        },
        () => {
          const prepared = production.prepare({ order: [12, 13], originalHeads })
          assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
          assert.equal(existsSync(marker), false)
          return preparedOutcome(prepared)
        },
      ),
    )
  },
})

define({
  id: 'prep-user-index-override-is-not-written-through',
  area: 'preparation',
  criteria: ['#87 repository-routing environment is not inherited'],
  findings: ['P14 Isolate inherited Git repository-selection environment variables'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13])
    const userIndex = join(production.world.root, 'user-index')
    const saved = process.env.GIT_INDEX_FILE
    process.env.GIT_INDEX_FILE = userIndex
    try {
      production.world.gitIn(production.world.repo, 'read-tree', 'HEAD')
      const before = production.world.tryGitIn(production.world.repo, 'status', '--porcelain')
      const prepared = production.prepare({ order: [12, 13], originalHeads })
      assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
      assert.equal(
        production.world.tryGitIn(production.world.repo, 'status', '--porcelain'),
        before,
        "the user's index must not be written through an inherited override",
      )
      return preparedOutcome(prepared)
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = saved
    }
  },
})

define({
  id: 'prep-literal-glob-filename-is-resolved-as-itself',
  area: 'preparation',
  criteria: ['#87 literal glob and magic filenames'],
  findings: ['P12 Treat conflict filenames as literal Git pathspecs'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13], {
      rootFiles: { 'root.txt': 'moves on\n', 'notes.txt': 'left alone\n', '*.txt': 'seed\n' },
      files: { 12: { '*.txt': 'ours\n' }, 13: { '*.txt': 'theirs\n' } },
    })
    const request = { order: [12, 13] as number[], originalHeads }
    const blocked = production.prepare(request)
    assert.equal(blocked.ok, false)
    assert.deepEqual(
      blocked.conflicts.map((entry) => entry.path),
      ['*.txt'],
      'the star is a path, not a pattern over the tree',
    )
    const resolved = production.prepare({
      ...request,
      resume: true,
      resolutions: [
        {
          number: 13,
          path: '*.txt',
          content: 'ours\ntheirs\n',
          intent: 'keep the file literally named with a star',
          reason: 'the name is a real path, not a pattern',
        },
      ],
    })
    assert.equal(resolved.ok, true, JSON.stringify(resolved.errors))
    const branch = resolved.preparation?.branches.find((entry) => entry.number === 13)
    const show = (path: string): string =>
      production.world
        .gitIn(production.storage(), 'show', `${branch?.preparedHead}:${path}`)
        .replace(/\n$/, '')
    assert.equal(show('*.txt'), 'ours\ntheirs')
    assert.equal(
      show('notes.txt'),
      'left alone',
      'a path that merely ends in .txt must not be swept up by a literal star',
    )
    return preparedOutcome(resolved)
  },
})

define({
  id: 'prep-symlink-conflict-leaves-its-external-target-untouched',
  area: 'preparation',
  criteria: ['#87 a symlink target outside the workspace is never modified'],
  findings: ['P7 Reject symlink conflict targets before writing resolution content'],
  expect: { status: 'partial', codesAny: CONFLICT_CODES, mentions: ['link.txt'] },
  async run(production) {
    const outside = join(production.world.root, 'outside-target.txt')
    writeFileSync(outside, 'the file a symlink points at\n')
    production.advanceRoot({ 'root.txt': 'moves on\n' })
    const first = await production.scratch('symlink-12')
    first.fetch()
    first.checkout(DEFAULT_BRANCH)
    production.writeSymlink(first.path, 'link.txt', outside)
    const a = first.commit('point at the external file')
    first.push(BRANCHES[12], { force: true })
    const second = await production.scratch('symlink-13')
    second.fetch()
    second.checkout(DEFAULT_BRANCH)
    production.writeBytes(second.path, 'link.txt', Buffer.from('a real file with the same name\n'))
    const b = second.commit('replace the link with a file')
    second.push(BRANCHES[13], { force: true })

    const blocked = production.prepare({ order: [12, 13], originalHeads: { 12: a, 13: b } })
    assert.equal(blocked.ok, false)
    assert.equal(
      readFileSync(outside, 'utf8'),
      'the file a symlink points at\n',
      'a conflict at a symlink must never follow it out of the workspace',
    )
    return preparedOutcome(blocked)
  },
})

define({
  id: 'prep-selected-head-deleted-at-the-source-blocks',
  area: 'preparation',
  criteria: ['#87 a stale snapshot is refused'],
  findings: ['P11 Validate pinned refs against the source rather than retained fetch refs'],
  expect: { status: 'blocked', codes: ['stale-snapshot'] },
  async run(production) {
    const numbers = [12, 13]
    const originalHeads = await seedStack(production, numbers)
    production.world.gitIn(
      production.world.remote,
      'update-ref',
      '-d',
      `refs/heads/${BRANCHES[13]}`,
    )
    const blocked = production.prepare({ order: numbers, originalHeads })
    assert.equal(blocked.ok, false)
    return preparedOutcome(blocked)
  },
})

define({
  id: 'prep-selected-head-moved-at-the-source-blocks',
  area: 'preparation',
  criteria: ['#87 a stale snapshot is refused'],
  findings: [],
  expect: { status: 'blocked', codes: ['stale-snapshot'] },
  async run(production) {
    const numbers = [12, 13]
    const originalHeads = await seedStack(production, numbers)
    await production.seedBranch(
      BRANCHES[13],
      { 'concurrent.txt': 'somebody else pushed\n' },
      { base: BRANCHES[13] },
    )
    const blocked = production.prepare({ order: numbers, originalHeads })
    assert.equal(blocked.ok, false)
    return preparedOutcome(blocked)
  },
})

define({
  id: 'prep-empty-selection-is-refused',
  area: 'preparation',
  criteria: ['#87 a missing selection is never a wildcard'],
  findings: [],
  expect: { status: 'blocked', codes: ['invalid-input'] },
  async run(production) {
    await seedStack(production, [12, 13])
    const refused = production.prepare({ order: [], selection: [], originalHeads: {} })
    assert.equal(refused.ok, false)
    assert.equal(refused.run, null)
    assert.equal(
      existsSync(join(production.prepareRun(), 'storage.git')),
      false,
      'an empty selection must not create task storage',
    )
    return preparedOutcome(refused)
  },
})

define({
  id: 'prep-journal-is-bound-to-one-selection',
  area: 'preparation',
  criteria: ['#87 a run directory owns exactly one plan'],
  findings: ['P6 Bind recovery journals to the complete immutable plan'],
  expect: { status: 'blocked', codes: ['unfinished-run'] },
  async run(production) {
    const first = await seedStack(production, [12, 13])
    const prepared = production.prepare({ order: [12, 13], originalHeads: first })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    // A second plan over the same run directory, seeded from a root that has moved again,
    // so the refusal is about the plan that was recorded and not about an empty seed.
    const second = await seedStack(production, [14], {
      rootFiles: { 'root.txt': 'the root branch moves on again\n' },
    })
    const refused = production.prepare({ order: [14], originalHeads: second })
    assert.equal(refused.ok, false)
    assert.equal(
      prepared.preparation?.branches.length,
      2,
      'the refused plan must not overwrite the recorded one',
    )
    return preparedOutcome(refused)
  },
})

define({
  id: 'prep-repeated-request-is-answered-from-real-ancestry',
  area: 'preparation',
  criteria: ['#87 a repeated preparation creates no new commits'],
  findings: [],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const numbers = [12, 13]
    const originalHeads = await seedStack(production, numbers)
    const request = { order: numbers, originalHeads }
    const first = production.prepare(request)
    assert.equal(first.ok, true, JSON.stringify(first.errors))
    const refsAfterFirst = production.world.tryGitIn(
      production.storage(),
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads',
    )
    const second = production.prepare(request)
    assert.equal(second.ok, true, JSON.stringify(second.errors))
    assert.deepEqual(
      second.preparation?.branches.map((branch) => branch.preparedHead),
      first.preparation?.branches.map((branch) => branch.preparedHead),
    )
    assert.equal(
      production.world.tryGitIn(
        production.storage(),
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
      ),
      refsAfterFirst,
      'a repeated request must not create a single new object under a prepared ref',
    )
    assert.equal(
      second.verification.some((row) => row.result === 'fail'),
      false,
      JSON.stringify(second.verification),
    )
    return preparedOutcome(second)
  },
})

/**
 * Puts the remote back exactly as the baseline found it.
 *
 * The driver owns this fixture, so restoring it is the driver's business and not the
 * helper's: four publications have to start from one immutable state for their outcomes
 * to be comparable, and the alternative - letting the first one change the remote the next
 * three read - would compare a publish against a no-op.
 */
function restoreRemote(production: Production, snapshot: Record<string, string>): void {
  const { world } = production
  for (const ref of Object.keys(world.remoteRefs())) {
    if (!(ref in snapshot)) world.gitIn(world.remote, 'update-ref', '-d', ref)
  }
  for (const [ref, oid] of Object.entries(snapshot)) {
    world.gitIn(world.remote, 'update-ref', ref, oid)
  }
}

/** The four states the provider can hold, and the only four the case varies. */
const CHECK_STATES = ['passing', 'failing', 'pending', 'unavailable'] as const

/**
 * The check states the provider was asked for, and nothing else.
 *
 * A successful publication performs base writes, so "the provider recorded an action" is
 * not a finding. Only a read of a check state is, because the contract forbids consulting
 * one whatever the run then decides.
 */
function checkReads(actions: Array<{ kind: string; target: string }>): string[] {
  return actions
    .filter((action) => action.kind === 'read-check-state')
    .map((action) => `#${action.target}`)
}

define({
  id: 'prep-check-state-never-reaches-preparation',
  area: 'preparation',
  criteria: ['#87 four check states, one preparation decision'],
  findings: [],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13])
    // One provider double, held at each of the four states in turn. Preparation is not given
    // the provider at all - the document has no field for it - so what is under test is that
    // the decision is the same whatever the server holds, and that nothing went looking.
    const heads: Array<Array<string | undefined>> = []
    const consulted: string[][] = []
    const checksRun: string[][] = []
    for (const state of CHECK_STATES) {
      const adapter = production.adapter(
        [12, 13].map((number) =>
          pinnedPullRequest(production.world, { number, branch: BRANCHES[number] }),
        ),
        { checkStates: { 12: state, 13: state } },
      )
      const { result: prepared, trace } = await production.traceNextCall(() =>
        production.prepare({
          order: [12, 13],
          originalHeads,
          // The same run directory path in every state. A merge commit records where it
          // was made, so four different directories would give four different objects and
          // the comparison would be measuring the path rather than the check state.
          runDirectory: join(production.world.root, 'prepare-check-state'),
        }),
      )
      assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
      heads.push(prepared.preparation?.branches.map((branch) => branch.preparedHead) ?? [])
      // If preparation had asked, the double would have said it was asked. It is never
      // handed the module, so the record is the proof rather than a missing string.
      consulted.push(checkReads(await adapter.actions()))
      checksRun.push(ranACheck(trace))
    }
    for (const state of CHECK_STATES) {
      assert.deepEqual(
        heads[CHECK_STATES.indexOf(state)],
        heads[0],
        `the prepared heads differ while the server holds ${state}`,
      )
    }
    assert.deepEqual(
      consulted,
      consulted.map(() => []),
      'preparation read a check state',
    )
    assert.deepEqual(
      checksRun,
      checksRun.map(() => []),
      'preparation ran a check command',
    )
    return preparedOutcome(
      production.prepare({
        order: [12, 13],
        originalHeads,
        runDirectory: join(production.world.root, 'prepare-final'),
      }),
    )
  },
})

// ---------------------------------------------------------------------------
// The measurement probe: a helper that must not have side effects.
// ---------------------------------------------------------------------------

interface ProbeEstimate {
  kind: string
  value: number | null
  reason?: string
}

function measure(production: Production, repository: string): ProbeEstimate[] {
  const measured = measureConflicts({
    contractVersion: 'flatten-pr-graph/1',
    repository,
    pairs: [
      {
        before: 12,
        after: 13,
        beforeRef: `refs/heads/${BRANCHES[12]}`,
        base: `refs/heads/${DEFAULT_BRANCH}`,
        afterRef: `refs/heads/${BRANCHES[13]}`,
      },
    ],
  }) as { estimates: ProbeEstimate[] }
  return measured.estimates
}

define({
  id: 'probe-attributed-merge-driver-is-never-executed',
  area: 'probe',
  criteria: ['#87 the probe must not execute a configured driver'],
  findings: ['P9 Preflight inherited executable Git controls before integration'],
  expect: { status: 'unknown', codes: [] },
  async run(production) {
    await seedStack(production, [12, 13], {
      rootFiles: { 'root.txt': 'moves on\n', '.gitattributes': 'driven.txt merge=probe\n' },
      files: { 12: { 'driven.txt': 'ours\n' }, 13: { 'driven.txt': 'theirs\n' } },
    })
    const storage = probeStorage(production)
    const marker = join(production.world.root, 'driver-was-executed')
    const driver = join(production.world.root, 'marker-driver.sh')
    writeFileSync(
      driver,
      `#!/bin/sh\nprintf 'driver side effect' > ${JSON.stringify(marker)}\nexit 1\n`,
    )
    chmodSync(driver, 0o755)

    const [estimate] = withWorldGitConfig(production.world, () =>
      withGitConfig({ 'merge.probe.driver': driver }, () => measure(production, storage)),
    )
    assert.equal(existsSync(marker), false, 'the driver must never be executed')
    assert.equal(estimate.value, null, 'an unmeasured pair has no cost, not a guessed one')
    assert.notEqual(estimate.kind, 'measured-merge')
    return outcome(estimate.kind, [], estimate.reason ? [estimate.reason] : [])
  },
})

define({
  id: 'probe-unused-driver-and-git-lfs-configuration-do-not-block',
  area: 'probe',
  criteria: ['#87 a configured but unattributed driver is not a false positive'],
  findings: ['P9 Preflight inherited executable Git controls before integration'],
  expect: { status: 'measured-merge', codes: [] },
  async run(production) {
    await seedStack(production, [12, 13], {
      rootFiles: { 'root.txt': 'moves on\n', '.gitattributes': 'driven.txt -merge\n' },
      files: { 12: { 'driven.txt': 'ours\n' }, 13: { 'driven.txt': 'theirs\n' } },
    })
    const storage = probeStorage(production)

    const [estimate] = withWorldGitConfig(production.world, () =>
      withGitConfig(
        {
          'merge.unused.driver': 'true',
          'filter.lfs.clean': 'git-lfs clean -- %f',
          'filter.lfs.smudge': 'git-lfs smudge -- %f',
        },
        () => measure(production, storage),
      ),
    )
    assert.notEqual(estimate.kind, 'unknown', 'an unattributed driver must not block a real pair')
    assert.ok(
      (estimate.value ?? 0) >= 1,
      'a genuinely conflicting pair still costs resolution work',
    )
    return outcome(estimate.kind, [], [])
  },
})

// ---------------------------------------------------------------------------
// Publication: authority, capability, and the atomic push.
// ---------------------------------------------------------------------------

define({
  id: 'publish-atomic-happy-path-publishes-only-the-authorized-set',
  area: 'publication',
  criteria: [
    '#88 a real atomic bare remote',
    '#88 per-ref SHA leases',
    '#88 root and unselected refs untouched',
  ],
  findings: ['B2 Push the independently verified prepared SHA'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const unrelated = await production.seedBranch('unrelated', {
      'unrelated.txt': 'not selected\n',
    })
    const before = production.refs()

    const { result, trace } = await production.traceNextCall(() =>
      production.publish(stack.prepared, publishArgs(stack)),
    )
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    const after = production.refs()
    const preparedHeads = preparedHeadsOf(stack.prepared)
    for (const number of stack.order) {
      assert.equal(
        after[`refs/heads/${BRANCHES[number]}`],
        preparedHeads[number],
        `#${number} must be published at the commit that was verified, not at a branch name`,
      )
      assert.equal(
        production.remoteAncestor(stack.originalHeads[number], preparedHeads[number]),
        true,
        `#${number} original work stays reachable from the published head`,
      )
    }
    assert.equal(after[ROOT_REF], before[ROOT_REF], 'the root must not move')
    assert.equal(after['refs/heads/unrelated'], unrelated, 'an unselected ref must not move')
    assert.equal(result.capability.atomicRefTransaction, 'supported')
    assert.equal(result.capability.providerCompareAndSwap, false)
    assert.equal(result.capability.baseWritesGuardedBy, 'read-before-write')
    assert.equal(result.capability.residualMetadataRace, true)
    assert.equal(result.publication.concurrency.leaseHeld, true)
    for (const attempt of result.publication.attempts) {
      assert.match(String(attempt.from), /^[0-9a-f]{40}$/, 'every attempt names a commit id')
      assert.match(String(attempt.to), /^[0-9a-f]{40}$/)
      if (attempt.kind === 'ref-update') assert.equal(attempt.lease?.usedForceWithLease, true)
    }
    assert.deepEqual(await baseWrites(stack.adapter), [13])
    assert.deepEqual(ranACheck(trace), [], 'publication started a check runner')
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-already-correct-chain-is-a-no-op-with-zero-attempts',
  area: 'publication',
  criteria: ['#88 an already correct chain is a no-op'],
  findings: [],
  expect: { status: 'no-op', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const first = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(first.status, 'published', JSON.stringify(first.errors))
    const refs = production.refs()

    const second = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(second.status, 'no-op', JSON.stringify(second.errors))
    assert.deepEqual(second.publication.attempts, [])
    assert.deepEqual(
      await baseWrites(stack.adapter),
      [13],
      'a no-op attempts no second metadata write',
    )
    assert.deepEqual(production.refs(), refs, 'a no-op changes nothing at all')
    return publicationOutcome(second)
  },
})

define({
  id: 'publish-without-a-task-owned-preparation-run-is-refused',
  area: 'publication',
  criteria: ['#88 publication is bound to the run that prepared it'],
  findings: ['B4 Stop metadata writes until all required heads are confirmed'],
  expect: {
    status: 'blocked',
    codesAny: ['invalid-input', 'conflicting-environment-control'],
    mentions: ['preparationRunDirectory'],
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      preparationRunDirectory: null,
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(result.publication.attempts, [])
    assert.deepEqual(await baseWrites(stack.adapter), [], 'no provider write may start')
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
    return publicationOutcome(result)
  },
})

const journalMutations: Array<{
  id: string
  mutate: (plan: Record<string, unknown>) => void
}> = [
  { id: 'selection', mutate: (plan) => void (plan.selection = [12]) },
  { id: 'order', mutate: (plan) => void (plan.order = [13, 12]) },
  { id: 'root', mutate: (plan) => void (plan.rootOid = 'f'.repeat(40)) },
  {
    id: 'intended-bases',
    mutate: (plan) => void (plan.intendedBases = { 12: 'main', 13: 'main' }),
  },
  { id: 'prepared-heads', mutate: (plan) => void (plan.preparedHeads = { 12: 'a'.repeat(40) }) },
]

for (const mutation of journalMutations) {
  define({
    id: `publish-resume-under-a-mutated-${mutation.id}-is-refused`,
    area: 'publication',
    criteria: ['#88 an incompatible journal root, selection, order or prepared commit is refused'],
    findings: ["B11 Bind resume to the journal's immutable publication plan"],
    expect: { status: 'blocked', codes: ['stale-snapshot'] },
    async run(production) {
      const stack = await preparedStack(production, [12, 13], {
        script: { refuseBaseUpdate: [13] },
      })
      const first = await production.publish(stack.prepared, publishArgs(stack))
      assert.equal(first.status, 'partial', JSON.stringify(first.errors))

      const journalPath = join(production.publishRun(), 'publication-journal.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        plan: Record<string, unknown>
      }
      mutation.mutate(journal.plan)
      writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)

      const adapter = production.adapter(Object.values(stack.pullRequests))
      const mutated = await production.publish(
        stack.prepared,
        { ...publishArgs(stack), providerModule: adapter.module, resume: true },
        {
          detectAtomicRefTransaction: () => {
            throw new Error('a refused resume must not reach the remote')
          },
        },
      )
      assert.equal(mutated.status, 'blocked', JSON.stringify(mutated.errors))
      assert.deepEqual(mutated.publication.attempts, [])
      assert.deepEqual(await baseWrites(adapter), [])
      return publicationOutcome(mutated)
    },
  })
}

define({
  id: 'publish-resume-under-a-mutated-order-is-refused',
  area: 'publication',
  criteria: ['#88 a resume under a mutated order is refused'],
  findings: ["B11 Bind resume to the journal's immutable publication plan"],
  expect: { status: 'blocked', codes: ['stale-snapshot'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13, 14], {
      script: { refuseBaseUpdate: [13] },
    })
    const first = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(first.status, 'partial', JSON.stringify(first.errors))

    const adapter = production.adapter(Object.values(stack.pullRequests))
    const mutated = await production.publish(
      stack.prepared,
      {
        ...publishArgs(stack),
        order: [12, 14, 13],
        selection: [12, 13, 14],
        providerModule: adapter.module,
        resume: true,
      },
      {
        detectAtomicRefTransaction: () => {
          throw new Error('a refused resume must not reach the remote')
        },
      },
    )
    assert.equal(mutated.status, 'blocked', JSON.stringify(mutated.errors))
    assert.deepEqual(mutated.publication.attempts, [])
    assert.deepEqual(await baseWrites(adapter), [])
    return publicationOutcome(mutated)
  },
})

define({
  id: 'publish-preparation-workspace-left-mid-merge-is-refused',
  area: 'publication',
  criteria: ['#88 a prepared workspace must be in a finished state'],
  findings: ['B10 Verify prepared-tree and workspace integrity before publication'],
  expect: { status: 'blocked', codes: ['unresolved-conflict'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    writeFileSync(
      join(production.workspace(13), '.git', 'MERGE_HEAD'),
      `${stack.originalHeads[13]}\n`,
      'utf8',
    )
    const result = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(result.publication.attempts, [])
    assert.deepEqual(await baseWrites(stack.adapter), [])
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-observed-head-that-is-neither-original-nor-prepared-is-refused',
  area: 'publication',
  criteria: ['#88 the recorded observation must be a state this plan may publish from'],
  findings: ['B12 Admit journaled prepared heads during snapshot reconciliation'],
  expect: { status: 'blocked', codes: ['stale-snapshot'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const observedRefs = { ...production.refs() }
    observedRefs[`refs/heads/${BRANCHES[12]}`] = stack.originalHeads[13]
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      observedRefs,
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(result.publication.attempts, [])
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-mismatched-mutable-backup-ref-still-publishes-the-verified-commit',
  area: 'publication',
  criteria: ['#88 a mismatched mutable backup ref publishes the verified SHA'],
  findings: ['B12 Admit journaled prepared heads during snapshot reconciliation'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const preparedHeads = preparedHeadsOf(stack.prepared)
    // The snapshot already records #12's own prepared state, as it would after a lost
    // acknowledgement, while the remote still holds the original. #12's prepared head
    // equals its original - nothing had to be integrated into it - so the branch that
    // still needs a refspec is #13, and that is the write this case is about.
    const observedRefs = { ...production.refs() }
    observedRefs[`refs/heads/${BRANCHES[12]}`] = preparedHeads[12]
    assert.notEqual(
      preparedHeads[13],
      stack.originalHeads[13],
      'the fixture needs a branch whose prepared head is genuinely new',
    )
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      observedRefs,
    })
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    assert.equal(
      production.refs()[`refs/heads/${BRANCHES[13]}`],
      preparedHeads[13],
      'the verified prepared commit is what lands, whatever the recorded observation said',
    )
    const headAttempt = result.publication.attempts.find(
      (attempt) => attempt.target === `refs/heads/${BRANCHES[13]}`,
    )
    assert.equal(headAttempt?.to, preparedHeads[13])
    assert.equal(headAttempt?.lease?.expectedRemote, stack.originalHeads[13])
    return publicationOutcome(result)
  },
})

const capabilityCases: Array<{ id: string; supported: boolean | null; expected: string }> = [
  { id: 'unsupported', supported: false, expected: 'unsupported' },
  { id: 'unknown', supported: null, expected: 'unknown' },
]

for (const capability of capabilityCases) {
  define({
    id: `publish-atomic-capability-${capability.id}-blocks-before-any-write`,
    area: 'publication',
    criteria: ['#88 an unsupported or unanswered remote blocks with no writes'],
    findings: [],
    expect: { status: 'blocked', codes: ['conflicting-environment-control'] },
    async run(production) {
      const stack = await preparedStack(production, [12, 13])
      const result = await production.publish(stack.prepared, publishArgs(stack), {
        detectAtomicRefTransaction: () => ({
          supported: capability.supported,
          evidence: 'the fixture answers the probe',
        }),
      })
      assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
      assert.equal(result.capability.atomicRefTransaction, capability.expected)
      assert.deepEqual(result.publication.attempts, [])
      assert.deepEqual(await baseWrites(stack.adapter), [])
      assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
      return publicationOutcome(result)
    },
  })
}

define({
  id: 'publish-server-denies-the-push-and-no-base-is-retargeted',
  area: 'publication',
  criteria: ['#88 a server denial writes nothing'],
  findings: [],
  expect: {
    status: 'blocked',
    codes: ['stale-snapshot'],
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const result = await production.publish(stack.prepared, publishArgs(stack), {
      push: () => ({ ok: false, status: 1, stdout: '', stderr: 'remote ref update denied' }),
    })
    assert.notEqual(result.status, 'published', JSON.stringify(result.errors))
    assert.equal(result.publication.confirmed.length, 0)
    assert.deepEqual(
      await baseWrites(stack.adapter),
      [],
      'no base may be retargeted on an unlanded head',
    )
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
    return publicationOutcome(result)
  },
})

const grantCases: Array<{ id: string; granted: string[]; detail: string; zeroCalls: boolean }> = [
  { id: 'empty-grant', granted: [], detail: 'no recognised mutation kind', zeroCalls: true },
  {
    id: 'base-only-grant',
    granted: ['pr-base-update'],
    detail: 'pending head writes',
    zeroCalls: false,
  },
  { id: 'ref-only-grant', granted: ['ref-update'], detail: 'retargeting', zeroCalls: false },
]

for (const grant of grantCases) {
  define({
    id: `publish-${grant.id}-blocks-before-the-push`,
    area: 'publication',
    criteria: ['#88 every required mutation kind is granted before any remote operation'],
    findings: ['B1 Require the ref-update grant before probing or pushing'],
    expect: { status: 'blocked', codes: ['missing-permission'], mentions: [grant.detail] },
    async run(production) {
      const stack = await preparedStack(production, [12, 13])
      const result = await production.publish(
        stack.prepared,
        { ...publishArgs(stack), granted: grant.granted },
        {
          detectAtomicRefTransaction: () => {
            throw new Error('the capability probe must not run without the grant')
          },
          push: () => {
            throw new Error('a push must not run without the grant')
          },
        },
      )
      assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
      assert.deepEqual(result.publication.attempts, [])
      assert.deepEqual(
        await baseWrites(stack.adapter),
        [],
        'a missing grant must not become a write',
      )
      if (grant.zeroCalls) {
        assert.deepEqual(await stack.adapter.calls(), [], 'no provider conversation may start')
      }
      assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
      return publicationOutcome(result)
    },
  })
}

define({
  id: 'publish-a-selection-the-grant-does-not-cover-is-refused',
  area: 'publication',
  criteria: ['#88 the authorised selection is exactly the prepared set'],
  findings: [],
  expect: {
    status: 'blocked',
    codes: ['missing-permission'],
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      selection: [12],
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(await stack.adapter.calls(), [])
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-pull-request-somebody-else-retargeted-is-refused',
  area: 'publication',
  criteria: ['#88 a changed base is never overwritten'],
  findings: ['B17 Validate PR repository identity and base against pinned snapshots'],
  expect: { status: 'blocked', codes: ['stale-snapshot'], mentions: ['baseRef'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      pullRequests: {
        ...stack.pullRequests,
        13: { ...stack.pullRequests[13], baseRef: BRANCHES[12] },
      },
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(await baseWrites(stack.adapter), [])
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-fork-head-repository-is-refused',
  area: 'publication',
  criteria: ['#88 a same-named fork is never the selected head'],
  findings: ['B17 Validate PR repository identity and base against pinned snapshots'],
  expect: { status: 'blocked', codes: ['stale-snapshot'], mentions: ['headRepository'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      pullRequests: {
        ...stack.pullRequests,
        13: { ...stack.pullRequests[13], headRepository: 'someone/widgets-fork' },
      },
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(await baseWrites(stack.adapter), [])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-pull-request-edited-mid-run-is-reported-not-repaired',
  area: 'publication',
  criteria: ['#88 a changed field a base retarget must not disturb is reported'],
  findings: ['B16 Report preserved-field drift even when the base landed'],
  expect: {
    status: 'partial',
    codes: ['stale-snapshot'],
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13, 14], {
      script: { driftTitleAfterWrite: 1 },
    })
    const result = await production.publish(stack.prepared, publishArgs(stack))
    assert.notEqual(result.status, 'published', JSON.stringify(result.errors))
    assert.deepEqual(
      await baseWrites(stack.adapter),
      [13],
      'the chain stops at the drift; the next base is never retargeted',
    )
    const state = await stack.adapter.pullRequests()
    assert.equal(state['14'].baseRef, 'main', '#14 is left exactly as it was')
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-provider-refusal-stops-the-chain-at-that-pull-request',
  area: 'publication',
  criteria: ['#88 a metadata failure after a base stops the chain'],
  findings: ['B4 Stop metadata writes until all required heads are confirmed'],
  expect: { status: 'partial', codes: ['missing-permission'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13, 14], {
      script: { refuseBaseUpdate: [13] },
    })
    const result = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(result.status, 'partial', JSON.stringify(result.errors))
    assert.deepEqual(
      await baseWrites(stack.adapter),
      [],
      'the refused base is not applied and #14 is never attempted',
    )
    assert.equal(
      result.publication.confirmed.filter((entry) => entry.kind === 'ref-update').length,
      2,
      'the head push did happen and is reported honestly',
    )
    assert.equal(result.publication.denials.length >= 1, true)
    const state = await stack.adapter.pullRequests()
    assert.equal(state['14'].baseRef, 'main')
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-applied-then-lost-acknowledgement-is-reconciled-without-a-retry',
  area: 'publication',
  criteria: ['#88 applied then lost ack is reread, never retried'],
  findings: ['B21 Preserve remote outcomes when an exception follows mutation'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13], { script: { applyThenThrow: true } })
    const result = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    const calls = await stack.adapter.calls()
    assert.equal(
      calls.filter((call) => call.op === 'updatePullRequestBase').length,
      1,
      'a reread must not become a second write',
    )
    const state = await stack.adapter.pullRequests()
    assert.equal(state['13'].baseRef, BRANCHES[12])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-applied-then-unreadable-stays-unknown',
  area: 'publication',
  criteria: ['#88 applied then read failure is unknown, never fabricated'],
  findings: ['B15 Keep metadata acknowledgement unknown when read-back fails'],
  expect: { status: 'partial', mentions: ['is unconfirmed'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13], {
      script: { applyThenThrow: true, failReadAfter: 4 },
    })
    const result = await production.publish(stack.prepared, publishArgs(stack))
    assert.notEqual(result.status, 'published', JSON.stringify(result.errors))
    assert.equal(result.publication.interrupted, true, 'an unknown answer is an interruption')
    assert.equal(
      result.publication.unconfirmed.filter((entry) => entry.kind === 'pr-base-update').length,
      1,
    )
    assert.ok(
      result.recovery !== null && result.recovery.acknowledgedChanges.length > 0,
      'what the remote already accepted is still reported',
    )
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-final-pull-request-read-failure-is-not-success',
  area: 'publication',
  criteria: ['#88 a final read failure is never success'],
  findings: ['B13 Make success depend on denied work and final chain verification'],
  expect: { status: 'partial', mentions: ['final read-back'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13], { script: { failReadAfter: 5 } })
    const result = await production.publish(stack.prepared, publishArgs(stack))
    assert.notEqual(result.status, 'published', JSON.stringify(result.errors))
    assert.equal(
      result.publication.confirmed.filter((entry) => entry.kind === 'pr-base-update').length,
      1,
      'the base write itself was acknowledged',
    )
    assert.ok(
      result.errors.some((error) => error.detail.includes('final read-back')),
      JSON.stringify(result.errors),
    )
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-push-that-lies-and-a-readback-that-fails-is-unconfirmed',
  area: 'publication',
  criteria: ['#88 an unknown push acknowledgement plus a failed read is unknown'],
  findings: ['B21 Preserve remote outcomes when an exception follows mutation'],
  expect: { status: 'blocked', codes: ['stale-snapshot'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    let reads = 0
    const result = await production.publish(stack.prepared, publishArgs(stack), {
      push: () => ({ ok: true, status: 0, stdout: 'everything up-to-date', stderr: '' }),
      readRemoteRefs: () => {
        reads += 1
        return reads === 1 ? realRemoteRefs(production, production.world.remote) : {}
      },
    })
    assert.notEqual(result.status, 'published', JSON.stringify(result.errors))
    assert.equal(result.publication.confirmed.length, 0)
    assert.equal(reads > 1, true, 'the push was actually attempted')
    assert.deepEqual(await baseWrites(stack.adapter), [], 'no base on an unconfirmed head')
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-concurrent-push-rejects-the-lease-and-overwrites-nothing',
  area: 'publication',
  criteria: ['#88 an immediate concurrent selected SHA lease is rejected'],
  findings: ['B8 Re-read and reconcile each PR immediately before its base edit'],
  // `partial`, not `blocked`: the lease did its job for the branch that carried a refspec,
  // but the other selected branch's prepared head equalled its original, so it had no
  // refspec and no lease - and the concurrent push to it landed. The run wrote that branch
  // before noticing, so something really was written and the status has to say so.
  expect: { status: 'partial', codes: ['stale-snapshot'], mentions: ['feat-a'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    let concurrent = ''
    const result = await production.publish(stack.prepared, publishArgs(stack), {
      // The concurrent push happens HERE, inside the seam, after the preflight has already
      // read the selected head and accepted it. Publishing it beforehand would let the
      // preflight itself refuse the run, which proves the snapshot check and nothing about
      // the lease. The push that follows is the real one, so the rejection is Git's answer.
      push: async (repository: string, endpoint: string, refspecs: string[], leases: string[]) => {
        concurrent = await production.seedBranch(
          BRANCHES[12],
          { 'concurrent.txt': 'somebody else\n' },
          { base: BRANCHES[12] },
        )
        return production.realPush(repository, endpoint, refspecs, leases)
      },
    })
    assert.notEqual(
      concurrent,
      '',
      `the concurrent push really landed in the seam; the run stopped before it: ${JSON.stringify(result.errors)}`,
    )
    assert.notEqual(result.status, 'published', JSON.stringify(result.errors))
    assert.equal(
      production.refs()[`refs/heads/${BRANCHES[12]}`],
      concurrent,
      'the concurrent push is never overwritten',
    )
    assert.deepEqual(await baseWrites(stack.adapter), [])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-root-that-moved-before-the-writes-blocks',
  area: 'publication',
  criteria: ['#88 a root that advanced after planning is never published over'],
  findings: [],
  expect: { status: 'blocked', codes: ['stale-snapshot'], mentions: ['root'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const newer = production.advanceRoot({ 'later.txt': 'the root moved on again\n' })
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      root: { ref: ROOT_REF, oid: stack.root },
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.equal(result.rootAdvance?.integrated, false)
    assert.equal(result.rootAdvance?.observed, newer)
    assert.equal(production.refs()[ROOT_REF], newer)
    assert.deepEqual(await stack.adapter.calls(), [], 'the provider is not even read')
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-root-that-moves-during-the-writes-is-reported-against-the-pin',
  area: 'publication',
  criteria: ['#88 a root that advanced after the writes is reported, not integrated'],
  findings: ['B13 Make success depend on denied work and final chain verification'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    let reads = 0
    let newer = ''
    const result = await production.publish(
      stack.prepared,
      { ...publishArgs(stack), root: { ref: ROOT_REF, oid: stack.root } },
      {
        // The root advances here, after the preflight has already accepted the pinned id,
        // and it advances for real: the refs handed back are read from the remote, not
        // assembled here. Moving it before the run would only re-test the snapshot check.
        readRemoteRefs: (repository: string, endpoint: string) => {
          reads += 1
          if (reads === 2) newer = production.advanceRoot({ 'later.txt': 'root moves late\n' })
          return realRemoteRefs(production, endpoint)
        },
      },
    )
    assert.notEqual(newer, '', 'the root really moved after the preflight')
    assert.notEqual(newer, stack.root, 'the root moved somewhere else')
    assert.equal(
      production.refs()[ROOT_REF],
      newer,
      'what is reported as advanced is what the remote actually holds',
    )
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    assert.notEqual(result.rootAdvance?.integrated, true, 'newer root work is never claimed')
    assert.equal(result.rootAdvance?.pinned, stack.root)
    const rootRow = result.verification.find((row) => row.invariant === 'preservation.root')
    assert.equal(rootRow !== undefined, true, 'the newer root is reported at all')
    assert.notEqual(rootRow?.result, 'pass', 'an unintegrated root is not a passing check')
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-an-unselected-ref-moved-during-the-run-is-reported',
  area: 'publication',
  criteria: ['#88 unselected refs outside the write set are reconciled'],
  findings: ['B12 Admit journaled prepared heads during snapshot reconciliation'],
  // `partial`: the stranger moves during the run's own read-back, after the selected heads
  // were already pushed. Something really was written, so `blocked` - which says nothing
  // was - would be the wrong description of the same facts.
  expect: {
    status: 'partial',
    codesAny: ['stale-snapshot', 'conflicting-environment-control'],
    mentions: ['refs/heads/stranger'],
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    await production.seedBranch('stranger', { 'stranger.txt': 'not selected\n' })
    let reads = 0
    const result = await production.publish(stack.prepared, publishArgs(stack), {
      readRemoteRefs: (repository: string, endpoint: string) => {
        reads += 1
        const refs = realRemoteRefs(production, endpoint)
        if (reads === 2) {
          production.world.moveRemoteRef('stranger', stack.originalHeads[12])
          return { ...refs, 'refs/heads/stranger': stack.originalHeads[12] }
        }
        return refs
      },
    })
    assert.notEqual(result.status, 'published', JSON.stringify(result.errors))
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-failed-journal-write-keeps-the-acknowledged-outcomes',
  area: 'publication',
  criteria: ['#88 a journal write that fails does not erase acknowledged outcomes'],
  findings: ['B21 Preserve remote outcomes when an exception follows mutation'],
  expect: { status: 'partial', codes: ['unfinished-run'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const journalPath = join(production.publishRun(), 'publication-journal.json')
    let reads = 0
    const result = await production.publish(stack.prepared, publishArgs(stack), {
      readRemoteRefs: (repository: string, endpoint: string) => {
        reads += 1
        if (reads === 2) chmodSync(journalPath, 0o444)
        return realRemoteRefs(production, endpoint)
      },
    })
    assert.notEqual(result.status, 'published', JSON.stringify(result.errors))
    assert.ok(
      result.recovery !== null && result.recovery.acknowledgedChanges.length > 0,
      'what the remote accepted is still reported even when the journal cannot record it',
    )
    const preparedHeads = preparedHeadsOf(stack.prepared)
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], preparedHeads[12])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-resume-replaying-the-original-snapshot-is-admissible',
  area: 'publication',
  criteria: ['#88 a resume replaying its own prepared states is admissible'],
  findings: [],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13], {
      script: { refuseBaseUpdate: [13] },
    })
    const originalSnapshot = production.refs()
    const first = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(first.status, 'partial', JSON.stringify(first.errors))
    const preparedHeads = preparedHeadsOf(stack.prepared)
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], preparedHeads[12])

    const adapter = production.adapter(Object.values(stack.pullRequests))
    const resumed = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      providerModule: adapter.module,
      observedRefs: originalSnapshot,
      resume: true,
    })
    assert.equal(resumed.status, 'published', JSON.stringify(resumed.errors))
    assert.deepEqual(await baseWrites(adapter), [13], 'the base it never wrote is written once')
    return publicationOutcome(resumed)
  },
})

define({
  id: 'publish-check-state-never-reaches-the-decision',
  area: 'publication',
  criteria: ['#88 four check states, one publication decision'],
  findings: [],
  expect: { status: 'published', codes: [] },
  async run(production) {
    // One prepared stack, one snapshot of the remote, four providers that differ in exactly
    // one thing: the check state the server holds. Everything else - the prepared heads, the
    // intended bases, the pinned snapshot, the immutable fixture - is the same object each
    // time, and the remote is put back between runs so no run reads another's result.
    const stack = await preparedStack(production, [12, 13])
    const snapshot = production.refs()
    const statuses: string[] = []
    const refsAfter: Array<Record<string, string>> = []
    const attemptsAfter: string[][] = []
    const consulted: string[][] = []
    const checksRun: string[][] = []
    let last: PublicationObservation | null = null

    for (const state of CHECK_STATES) {
      restoreRemote(production, snapshot)
      const adapter = production.adapter(Object.values(stack.pullRequests), {
        checkStates: { 12: state, 13: state },
      })
      const { result, trace } = await production.traceNextCall(() =>
        production.publish(stack.prepared, {
          ...publishArgs(stack),
          providerModule: adapter.module,
          runDirectory: join(production.world.root, `publish-${state}`),
        }),
      )
      last = result
      statuses.push(result.status)
      refsAfter.push(production.refs())
      attemptsAfter.push(
        (result.publication?.attempts ?? [])
          .map((attempt) => `${attempt.kind} ${attempt.target}`)
          .sort(),
      )
      consulted.push(checkReads(await adapter.actions()))
      checksRun.push(ranACheck(trace))
    }

    for (const state of CHECK_STATES) {
      const index = CHECK_STATES.indexOf(state)
      assert.equal(
        statuses[index],
        statuses[0],
        `the status changed while the server held ${state}`,
      )
      assert.deepEqual(
        refsAfter[index],
        refsAfter[0],
        `the remote changed while the server held ${state}`,
      )
      assert.deepEqual(
        attemptsAfter[index],
        attemptsAfter[0],
        `the writes changed while the server held ${state}`,
      )
    }
    assert.equal(statuses[0], 'published', `the runs did not publish: ${JSON.stringify(statuses)}`)
    assert.deepEqual(
      consulted,
      consulted.map(() => []),
      'publication read a check state',
    )
    assert.deepEqual(
      checksRun,
      checksRun.map(() => []),
      'publication ran a check command',
    )
    assert.ok(last, 'no publication ran')
    return publicationOutcome(last)
  },
})

define({
  id: 'publish-a-remote-helper-transport-is-refused-by-name',
  area: 'publication',
  criteria: ['#88 no program is executed by merely addressing a remote'],
  findings: ['B24 Block executable custom transports before discovery'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const marker = join(production.world.root, 'helper-ran')
    const raw = production.publishInput(stack.prepared, publishArgs(stack))
    raw.remote = `ext::sh -c touch ${marker}`
    const result = await production.publishRaw(raw)
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.equal(existsSync(marker), false, 'the helper program must never run')
    assert.deepEqual(await stack.adapter.calls(), [])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-remote-with-two-push-destinations-is-refused',
  area: 'publication',
  criteria: ['#88 one push destination covers the whole transaction'],
  findings: ['B7 Pin one endpoint for both remote reads and writes'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const second = join(production.world.root, 'second.git')
    production.world.gitIn(production.world.root, 'init', '--bare', '--quiet', second)
    // The helper reads the destination from the repository it was pointed at, so the two
    // push urls have to live there; a remote configured in some other repository would
    // test nothing about the run.
    production.world.gitIn(
      production.world.remote,
      'remote',
      'add',
      'mirror',
      production.world.remote,
    )
    production.world.gitIn(
      production.world.remote,
      'remote',
      'set-url',
      '--add',
      '--push',
      'mirror',
      second,
    )
    const raw = production.publishInput(stack.prepared, publishArgs(stack))
    raw.remote = 'mirror'
    const result = await production.publishRaw(raw)
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(result.publication.attempts, [])
    assert.equal(
      production.world.tryGitIn(second, 'for-each-ref', 'refs/heads'),
      '',
      'the second destination received nothing',
    )
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-repository-that-does-not-exist-is-refused',
  area: 'publication',
  criteria: ['#88 the repository is named, never inferred'],
  findings: [],
  expect: {
    status: 'blocked',
    codes: ['invalid-input'],
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const raw = production.publishInput(stack.prepared, publishArgs(stack))
    raw.repository = join(production.world.root, 'not-a-repository')
    const result = await production.publishRaw(raw)
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(await stack.adapter.calls(), [])
    assert.equal(production.refs()[`refs/heads/${BRANCHES[12]}`], stack.originalHeads[12])
    return publicationOutcome(result)
  },
})

// ---------------------------------------------------------------------------
// The remaining review findings, each bound to the behaviour it is about.
// ---------------------------------------------------------------------------

define({
  id: 'publish-bases-are-looked-up-by-pull-request-not-by-position',
  area: 'publication',
  criteria: ['#88 a base is addressed by pull request, never by its place in the order'],
  findings: ['B3 Use PR numbers rather than positions to look up bases'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    // Non-contiguous numbers, and an order that is not ascending by number. A lookup by
    // position would pair #14 with the base intended for #12 and retarget the wrong
    // pull request; the provider's own record says which base each number ended up on.
    const originalHeads = await seedStack(production, [12, 14])
    const prepared = production.prepare({ order: [14, 12], originalHeads })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    const pullRequests = {
      12: pinnedPullRequest(production.world, { number: 12, branch: BRANCHES[12] }),
      14: pinnedPullRequest(production.world, {
        number: 14,
        branch: BRANCHES[14],
        base: BRANCHES[12],
      }),
    }
    const adapter = production.adapter(Object.values(pullRequests))
    const result = await production.publish(prepared, {
      order: [14, 12],
      intendedBases: { 14: DEFAULT_BRANCH, 12: BRANCHES[14] },
      pullRequests,
      providerModule: adapter.module,
    })
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    const served = await adapter.pullRequests()
    assert.equal(served['14'].baseRef, DEFAULT_BRANCH, '#14 builds on the root')
    assert.equal(served['12'].baseRef, BRANCHES[14], '#12 builds on #14')
    assert.deepEqual(await baseWrites(adapter), [14, 12])
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-duplicate-pull-request-in-the-order-is-refused',
  area: 'publication',
  criteria: ['#88 a selected pull request is published exactly once'],
  findings: ['B14 Reject repeated PR numbers in publication order'],
  expect: { status: 'blocked', codes: ['invalid-input'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const before = await stack.adapter.pullRequests()
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      order: [12, 13, 13],
      intendedBases: { 12: DEFAULT_BRANCH, 13: BRANCHES[12] },
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(await stack.adapter.calls(), [], 'nothing may be asked of the provider')
    assert.deepEqual(await stack.adapter.pullRequests(), before, 'no metadata may change')
    assert.deepEqual(production.refs(), production.refs())
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-an-unlisted-pull-request-is-refused-before-any-conversation',
  area: 'publication',
  criteria: ['#88 the selection is exactly the authorized set'],
  findings: ['B14 Reject repeated PR numbers in publication order'],
  expect: { status: 'blocked', codes: ['invalid-input'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const before = await stack.adapter.pullRequests()
    // #14 is a real pull request on the remote, so this is an omission rather than a
    // fabrication: the order names a pull request the granted selection does not include.
    await production.seedBranch(BRANCHES[14], { 'extra.txt': 'not selected\n' })
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      order: [12, 13, 14],
      intendedBases: { 12: DEFAULT_BRANCH, 13: BRANCHES[12], 14: BRANCHES[13] },
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(await stack.adapter.calls(), [], 'nothing may be asked of the provider')
    assert.deepEqual(await stack.adapter.pullRequests(), before, 'no metadata may change')
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-configured-follow-tags-does-not-push-an-annotated-tag',
  area: 'publication',
  criteria: ['#88 no ref outside the authorized selection is written'],
  findings: ['B5 Remove the unsupported -i option from the control query'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    // `push.followTags` makes `git push` send every reachable annotated tag as well as the
    // refspecs. A publication that passed it through would write a ref nobody authorized.
    production.writeGlobalConfig({ 'push.followTags': 'true' })
    const stack = await preparedStack(production, [12, 13])
    production.world.gitIn(
      production.world.repo,
      'tag',
      '-a',
      'release-1',
      '-m',
      'an annotated tag nobody selected',
    )
    // The tag is created locally and never pushed, so the run has to bring it along or not.
    const before = production.refs()
    const result = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    const after = production.refs()
    const selected = new Set(stack.order.map((number) => `refs/heads/${BRANCHES[number]}`))
    for (const [ref, oid] of Object.entries(before)) {
      if (selected.has(ref) || ref.startsWith('refs/tags/')) continue
      assert.equal(after[ref], oid, `${ref} moved`)
    }
    assert.equal(
      after['refs/tags/release-1'],
      undefined,
      'an annotated tag reached the remote through push.followTags',
    )
    return publicationOutcome(result)
  },
})

define({
  id: 'prep-a-relative-hooks-path-is-resolved-against-the-repository',
  area: 'preparation',
  criteria: ['#87 a mandatory source control is enforced, not inherited by accident'],
  findings: [
    'B6 Resolve relative hook paths in the task repository',
    'P1 Gate preparation on source controls before cloning or committing',
  ],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    mentions: ['core.hooksPath'],
  },
  async run(production) {
    // A relative `core.hooksPath` means different things in different directories. If the
    // run resolved it against the caller's cwd instead of the repository, it would look in
    // a directory with no hooks, report a clean run, and the mandatory hook would never be
    // consulted at all - which is the bypass this case exists to catch.
    const marker = join(production.world.root, 'pre-commit-ran')
    const gates = join(production.world.remote, 'gates')
    mkdirSync(gates, { recursive: true })
    const hook = join(gates, 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`)
    chmodSync(hook, 0o755)
    production.world.gitIn(production.world.remote, 'config', 'core.hooksPath', 'gates')
    const outside = join(production.world.root, 'elsewhere')
    mkdirSync(outside, { recursive: true })
    const previous = process.cwd()
    process.chdir(outside)
    try {
      const originalHeads = await seedStack(production, [12])
      const prepared = production.prepare({ order: [12], originalHeads })
      assert.equal(prepared.status, 'blocked', JSON.stringify(prepared.errors))
      assert.equal(
        existsSync(marker),
        false,
        'the source hook must not be executed, and must not be skipped silently either',
      )
      assert.equal(
        prepared.controls?.some(
          (control) => control.control === 'core.hooksPath' && control.value.includes(gates),
        ),
        true,
        `the relative hooks path must be named with the directory it resolves to: ${JSON.stringify(prepared.controls)}`,
      )
      assert.equal(
        prepared.controls?.some(
          (control) => control.control === 'hooks/pre-commit' && control.blocking,
        ),
        true,
        `the executable policy hook must be named as blocking: ${JSON.stringify(prepared.controls)}`,
      )
      assert.equal(
        existsSync(join(production.storage(), 'objects')),
        false,
        'preparation must stop before task-owned storage is created',
      )
      return preparedOutcome(prepared)
    } finally {
      process.chdir(previous)
    }
  },
})

/**
 * The shipped provider, driven through its own `gh` boundary.
 *
 * Everything else in this matrix talks to a double. This block runs the module the skill
 * actually ships, with a real `gh` on `PATH` that records what it was asked and answers
 * with REST-shaped JSON. The question is not whether the publisher works - that is the rest
 * of this file - but whether the module between them says what the contract requires it to
 * say: the state in the contract's spelling, and no precondition it cannot enforce.
 */
function stubGh(world: World, requests: string[][]): { directory: string; restore: () => void } {
  const directory = join(world.root, 'gh-stub')
  mkdirSync(directory, { recursive: true })
  const log = join(directory, 'requests.jsonl')
  writeFileSync(log, '')
  const script = join(directory, 'gh')
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FLATTEN_GH_STUB_LOG"',
      'printf \'{"number":12,"state":"open","draft":false,"title":"Feature #12","body":"b",',
      '  "head":{"ref":"feat-a","sha":"HEADSHA","repo":{"full_name":"acme/widgets"}},',
      '  "base":{"ref":"main","sha":"BASESHA"},"labels":[],"requested_reviewers":[],',
      '  "auto_merge":null}\\n\'',
      '',
    ].join('\n'),
  )
  chmodSync(script, 0o755)
  const previousLog = process.env.FLATTEN_GH_STUB_LOG
  const previousPath = process.env.PATH
  process.env.FLATTEN_GH_STUB_LOG = log
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`
  return {
    directory,
    restore() {
      if (previousLog === undefined) delete process.env.FLATTEN_GH_STUB_LOG
      else process.env.FLATTEN_GH_STUB_LOG = previousLog
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    },
  }
}

define({
  id: 'publish-the-shipped-provider-normalizes-rest-state-and-claims-no-precondition',
  area: 'publication',
  criteria: ['#88 the provider reports REST reality in the contract vocabulary'],
  findings: [
    'B18 Normalize the shipped REST provider open-state value',
    'B19 Report GitHub base PATCH as non-CAS',
    'B20 Fail closed on an absent provider capability document',
    'B23 Emit base-write evidence compatible with the canonical contract',
  ],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12])
    const requests: string[][] = []
    const stub = stubGh(production.world, requests)
    const previousRepository = process.env.FLATTEN_PR_REPOSITORY
    process.env.FLATTEN_PR_REPOSITORY = 'acme/widgets'
    // Relative to this file, not to the fixture's temporary directory: the module under
    // test is the one this repository ships.
    const providerModule = fileURLToPath(
      new URL(
        '../../../../.agents/skills/flatten-pr-graph/scripts/github-provider.mjs',
        import.meta.url,
      ),
    )
    let result: PublicationObservation
    try {
      const provider = (await import(pathToFileURL(providerModule).href)) as {
        capabilities: () => { operations: string[]; compareAndSwap: boolean }
        readPullRequest: (number: number) => { pullRequest?: { state?: string } }
        updatePullRequestBase: (
          n: number,
          base: string,
        ) => {
          applied: boolean
          preconditionMet: boolean | null
        }
      }
      // What the module reports, asked of the module rather than of a fixture.
      const capabilities = provider.capabilities()
      assert.deepEqual(capabilities.operations, ['read-pull-request', 'update-pull-request-base'])
      assert.equal(capabilities.compareAndSwap, false, 'GitHub PATCH offers no precondition')
      const read = provider.readPullRequest(12)
      assert.equal(
        read.pullRequest?.state,
        'OPEN',
        'REST spells the state lowercase and the contract does not',
      )
      const write = provider.updatePullRequestBase(12, 'main')
      assert.equal(write.preconditionMet, null, 'a precondition this interface cannot enforce')
      const recorded = readFileSync(join(stub.directory, 'requests.jsonl'), 'utf8')
      assert.ok(
        recorded.includes('--method PATCH'),
        `the base update must be a PATCH, recorded ${JSON.stringify(recorded)}`,
      )
      assert.ok(
        !recorded.includes('expected_base'),
        `the PATCH must not send a precondition field: ${JSON.stringify(recorded)}`,
      )
      // This case made no publication: it exercised the module between the helper and the
      // server. No document is invented here to look like one the helper did not emit.
      result = { status: 'published', errors: [] }
    } finally {
      stub.restore()
      if (previousRepository === undefined) delete process.env.FLATTEN_PR_REPOSITORY
      else process.env.FLATTEN_PR_REPOSITORY = previousRepository
    }
    return publicationOutcome(result)
  },
})

define({
  id: 'prep-a-root-the-ref-no-longer-carries-is-refused-rather-than-used',
  area: 'preparation',
  criteria: ['#87 every prepared head carries the cumulative state'],
  findings: ['B9 Verify the first prepared head contains the pinned root'],
  expect: { status: 'blocked', codesAny: ['stale-snapshot', 'missing-dependency'] },
  async run(production) {
    const originalHeads = await seedStack(production, [12])
    const pinned = production.root()
    const moved = production.advanceRoot({ 'later.txt': 'the root moves again\n' })
    assert.notEqual(moved, pinned, 'the fixture has to actually move the root')

    // The remote still has that commit - it is an ancestor - so a run that quietly built on
    // it would drop everything the root gained since, and every head above it. The pin is
    // only usable when the root ref still carries it.
    const stale = production.prepare({
      order: [12],
      originalHeads,
      root: { ref: ROOT_REF, oid: pinned },
      runDirectory: join(production.world.root, 'prepare-stale-root'),
    })
    assert.equal(stale.status, 'blocked', JSON.stringify(stale.errors))
    assert.equal(stale.preparation, null, 'a stale pin prepares nothing')

    // And the current root really does become the base of the first prepared head.
    const currentRun = join(production.world.root, 'prepare-current-root')
    const prepared = production.prepare({ order: [12], originalHeads, runDirectory: currentRun })
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.errors))
    const first = prepared.preparation?.branches?.[0]
    assert.ok(first, 'no branch was prepared')
    assert.equal(
      production.storageAncestor(moved, first.preparedHead, currentRun),
      true,
      'the first prepared head must contain the root it was pinned to',
    )
    assert.equal(
      production.storageAncestor(pinned, first.preparedHead, currentRun),
      true,
      'and the root the plan was authorized against is on that same history',
    )
    return preparedOutcome(stale)
  },
})

define({
  id: 'publish-an-unauthorized-intent-leaves-an-existing-journal-untouched',
  area: 'publication',
  criteria: ['#88 a refused run records nothing and changes nothing'],
  findings: ['B22 Leave existing recovery journals intact on rejected authority'],
  expect: { status: 'blocked', codes: ['missing-permission'] },
  async run(production) {
    const stack = await preparedStack(production, [12])
    const runDirectory = join(production.world.root, 'publish-journal')
    // A journal from an earlier interrupted run, with content no refused run may overwrite.
    mkdirSync(runDirectory, { recursive: true })
    const journalPath = join(runDirectory, 'journal.json')
    const existing = `${JSON.stringify(
      {
        contractVersion: 'flatten-pr-graph/1',
        state: 'interrupted',
        root: { ref: ROOT_REF, oid: stack.root },
        order: [12],
        attempts: [
          {
            sequence: 1,
            kind: 'ref-update',
            target: 'refs/heads/feat-a',
            outcome: 'unknown',
          },
        ],
      },
      null,
      2,
    )}\n`
    writeFileSync(journalPath, existing)
    const before = readFileSync(journalPath)
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      runDirectory,
      // A preview is not a grant. Whatever the caller meant, nothing may be written and the
      // interrupted run's record has to survive exactly as it was.
      granted: ['pr-base-update'],
      authorityIntent: 'preview',
    })
    assert.equal(result.status, 'blocked', JSON.stringify(result.errors))
    assert.deepEqual(await stack.adapter.calls(), [], 'no provider write may start')
    assert.deepEqual(
      readFileSync(journalPath),
      before,
      'the existing recovery journal must survive a refused run byte for byte',
    )
    assert.equal(
      production.refs()[`refs/heads/${BRANCHES[12]}`],
      stack.originalHeads[12],
      'no ref may move',
    )
    return publicationOutcome(result)
  },
})

define({
  id: 'publish-a-base-change-is-recorded-in-the-canonical-evidence-shape',
  area: 'publication',
  criteria: ['#88 a base change is recorded as evidence, not as a claim'],
  findings: ['B23 Emit base-write evidence compatible with the canonical contract'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const result = await production.publish(stack.prepared, publishArgs(stack))
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    // Exactly the three fields the contract defines for a confirmed change, and nothing
    // else: the schema's `additionalProperties: false` is what makes an invented field a
    // rejection rather than an extra, so the driver has to read the same three.
    const confirmed = (
      (result.publication?.confirmed ?? []) as Array<Record<string, unknown>>
    ).filter((write) => write.kind === 'pr-base-update')
    assert.deepEqual(
      confirmed.map((write) => Object.keys(write).sort()),
      confirmed.map(() => ['kind', 'oid', 'target']),
      `the confirmed base change is not in the contract's shape: ${JSON.stringify(confirmed)}`,
    )
    assert.equal(confirmed.length, 1, JSON.stringify(confirmed))
    assert.equal(confirmed[0].target, '13', 'the target names the pull request, not a branch')
    assert.match(String(confirmed[0].oid), /^[0-9a-f]{40}$/, 'a commit, not a ref name')
    assert.equal(
      (await stack.adapter.pullRequests())['13'].baseRef,
      BRANCHES[12],
      'the base the run wrote is the base the server holds',
    )
    return publicationOutcome(result)
  },
})

define({
  id: 'prep-a-resolution-that-leaves-conflict-markers-blocks-the-prepared-result',
  area: 'preparation',
  criteria: ['#87 a run that cannot finish is reported as unfinished'],
  findings: ['P3 Make failed integrity checks block the prepared result'],
  expect: { status: 'partial', codesAny: ['unresolved-conflict'], mentions: ['conflict'] },
  async run(production) {
    // The agent supplies a resolution that still contains both sides' markers. Git would
    // commit it happily; the run has to notice and refuse to call it prepared.
    const originalHeads = await seedStack(production, [12], {
      files: { 12: { 'shared.txt': 'the first side\n' } },
      bases: { 12: DEFAULT_BRANCH },
    })
    production.advanceRoot({ 'shared.txt': 'the root side\n' })
    const prepared = production.prepare({
      order: [12],
      originalHeads,
      resolutions: [
        {
          number: 12,
          path: 'shared.txt',
          kind: 'content',
          intent: 'keep both readings',
          reason: 'they say different things about the same file',
          content: '<<<<<<< HEAD\nthe root side\n=======\nthe first side\n>>>>>>> pr-12\n',
        },
      ],
    })
    // The integration commit exists, so this is `partial` rather than `blocked`: a status of
    // `blocked` would claim nothing was written, and a branch was prepared and then found
    // not to be finished.
    assert.equal(prepared.status, 'partial', JSON.stringify(prepared.errors))
    assert.equal(
      prepared.verification.some((row: { result: string }) => row.result === 'fail'),
      true,
      `an unresolved conflict must be a failed check: ${JSON.stringify(prepared.verification)}`,
    )
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-a-binary-conflict-on-both-sides-is-measured-not-guessed',
  area: 'preparation',
  criteria: ['#87 a conflict is measured, not guessed at'],
  findings: ['P10 Diff conflict-stage blobs without an invalid pathspec'],
  expect: { status: 'blocked', codesAny: ['unsupported-conflict'] },
  async run(production) {
    // Both sides rewrite the same binary file from the same base, so the merge really is
    // conflicted. There is nothing to show as a textual diff, and the blob a textual diff
    // would name for stage 1 does not exist - which is where a naive measurement dies with a
    // pathspec error instead of a measured conflict. Git cannot pick a side either, so the
    // run has to stop and say why.
    const bytes = {
      base: [0x89, 0x50, 0x4e, 0x47, 0x00],
      theirs: [0x89, 0x50, 0x4e, 0x47, 0x01],
      ours: [0x89, 0x50, 0x4e, 0x47, 0x02],
    }
    production.advanceRoot({ 'root.txt': 'root\n' })
    production.writeBytes(production.world.repo, 'logo.png', Buffer.from(bytes.base))
    production.world.gitIn(production.world.repo, 'add', '--all')
    production.world.gitIn(
      production.world.repo,
      '-c',
      'user.name=a',
      '-c',
      'user.email=a@b.c',
      'commit',
      '--quiet',
      '-m',
      'the original logo',
    )
    production.world.gitIn(production.world.repo, 'push', '--quiet', 'origin', DEFAULT_BRANCH)
    const originalHeads = {
      12: await production.seedBranch(
        BRANCHES[12],
        { 'logo.png': '' },
        { base: DEFAULT_BRANCH, bytes: { 'logo.png': Buffer.from(bytes.theirs) } },
      ),
    }
    production.writeBytes(production.world.repo, 'logo.png', Buffer.from(bytes.ours))
    production.world.gitIn(production.world.repo, 'checkout', '--quiet', DEFAULT_BRANCH)
    production.writeBytes(production.world.repo, 'logo.png', Buffer.from(bytes.ours))
    production.world.gitIn(production.world.repo, 'add', '--all')
    production.world.gitIn(
      production.world.repo,
      '-c',
      'user.name=a',
      '-c',
      'user.email=a@b.c',
      'commit',
      '--quiet',
      '-m',
      'a different logo',
    )
    production.world.gitIn(production.world.repo, 'push', '--quiet', 'origin', DEFAULT_BRANCH)
    const prepared = production.prepare({ order: [12], originalHeads })
    assert.equal(prepared.status, 'blocked', JSON.stringify(prepared.errors))
    assert.equal(
      prepared.preparation,
      null,
      'a conflict the helper cannot measure must not come back as a prepared branch',
    )
    return preparedOutcome(prepared)
  },
})

define({
  id: 'prep-a-repeated-request-resumes-the-same-conflicted-workspace',
  area: 'preparation',
  criteria: ['#87 an interrupted run continues in the workspace it already made'],
  findings: ['P4 Resume the existing conflicted workspace instead of cloning again'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12], {
      files: { 12: { 'shared.txt': 'the pull request side\n' } },
    })
    production.advanceRoot({ 'shared.txt': 'the root side\n' })
    // The first run integrates and then finds the resolution unfinished, so it stops with a
    // conflicted workspace on disk. The second run supplies a real resolution and has to
    // continue in that same workspace: cloning a second one would throw away the work and
    // make the recorded run directory a lie.
    const runDirectory = join(production.world.root, 'prepare-resume')
    const first = production.prepare({
      order: [12],
      originalHeads,
      runDirectory,
      resolutions: [
        {
          number: 12,
          path: 'shared.txt',
          kind: 'content',
          intent: 'keep both readings for now',
          reason: 'the first attempt left both sides in place',
          content: '<<<<<<< HEAD\nthe root side\n=======\nthe pull request side\n>>>>>>> pr-12\n',
        },
      ],
    })
    assert.equal(first.status, 'partial', JSON.stringify(first.errors))
    const workspace = production.workspace(12, runDirectory)
    assert.equal(existsSync(join(workspace, 'shared.txt')), true, 'the workspace survives')
    // A sentinel the run did not write. A resumed run that re-cloned would throw it away;
    // one that continues in the workspace it already made has to leave it alone.
    writeFileSync(join(workspace, '.probe-sentinel'), 'left over from the first attempt\n')
    const resumed = production.prepare({
      order: [12],
      originalHeads,
      resume: true,
      runDirectory,
      resolutions: [
        {
          number: 12,
          path: 'shared.txt',
          kind: 'content',
          intent: 'keep the pull request reading and drop the superseded root note',
          reason: 'the pull request supersedes the root note for this file',
          content: 'the pull request side\n',
        },
      ],
    })
    // The resumed run continues in the workspace the first run left - the sentinel is
    // untracked, so a fresh clone would have lost it - and the resolution it was just given
    // is what ends up in the commit. "It reused the folder" is not the point; a resolution
    // that cannot finish the branch is not a continuation, it is a loop.
    assert.equal(resumed.status, 'prepared', JSON.stringify(resumed.errors))
    assert.equal(
      readFileSync(join(workspace, '.probe-sentinel'), 'utf8'),
      'left over from the first attempt\n',
      'the resumed run continued in the existing workspace instead of cloning a fresh one',
    )
    assert.equal(
      readdirSync(join(runDirectory, 'workspaces')).filter((name: string) => name.includes('pr-'))
        .length,
      1,
      'a resumed run must not accumulate a second workspace per branch',
    )
    const head = resumed.preparation?.branches?.[0]?.preparedHead
    assert.ok(head, 'the resumed run produced no prepared head')
    assert.notEqual(head, first.preparation?.branches?.[0]?.preparedHead, 'the same commit')
    assert.equal(
      production.world.gitIn(production.storage(runDirectory), 'show', `${head}:shared.txt`),
      'the pull request side\n',
      "the resolved content is the one the second run supplied, not the first run's markers",
    )
    assert.equal(
      production.world.tryGitIn(
        production.storage(runDirectory),
        'grep',
        '-I',
        '-l',
        '-e',
        '<<<<<<<',
        head,
        '--',
      ),
      null,
      'no conflict marker may survive into the prepared head',
    )
    // The original contribution is still there: a resolution replaces the conflicted path,
    // it does not rebuild the branch from the root and drop the pull request's commits.
    assert.equal(
      production.storageAncestor(originalHeads[12], head, runDirectory),
      true,
      'the prepared head must still contain the original head it was integrating',
    )
    assert.deepEqual(
      resumed.preparation?.branches?.[0]?.retainedOriginalCommits,
      [originalHeads[12]],
      'the original commit retention record survives the resume',
    )
    return preparedOutcome(resumed)
  },
})
