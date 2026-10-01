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
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** What a case observed from real state, after the shipped helper returned. */
export interface ProductionOutcome {
  status: string
  codes: string[]
  details: string[]
}

/** What a conforming implementation must produce, frozen before execution. */
export interface ProductionExpectation {
  status: string
  /** Every code here has to appear in the observed errors. */
  codes?: string[]
  /** At least one of these codes has to appear. */
  codesAny?: string[]
  /** A substring one reported detail must contain. */
  detail?: string
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

function publicationOutcome(result: {
  status: string
  errors: Array<{ code: string; detail: string; evidence?: string }>
}): ProductionOutcome {
  return outcome(result.status, publishCodes(result as never), describeErrors(result.errors))
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
  options: SeedOptions & { script?: ProviderScript } = {},
): Promise<Stack> {
  const originalHeads = await seedStack(production, numbers, options)
  const root = production.root()
  const prepared = production.prepare({ order: numbers, originalHeads })
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

/** Every Git command this run attempted, so "no check was run" is a fact and not a claim. */
function ranACommand(production: Production, program: RegExp): boolean {
  return production.world.commands.some((record) => program.test(record.args.join(' ')))
}

const A_CHECK = /(^|[\s/])(test|vitest|jest|mocha|eslint|prettier|tsc|biome|ruff|pytest)(\s|$)/

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
  findings: ['P1 lost original commit', 'P6 compatible contributions treated as loss'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const numbers = [12, 13]
    const originalHeads = await seedStack(production, numbers)
    const root = production.root()
    const prepared = production.prepare({ order: numbers, originalHeads })
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
    assert.equal(ranACommand(production, A_CHECK), false)
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
  findings: ['P6'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const numbers = [12, 13, 14]
    const originalHeads = await seedStack(production, numbers, {
      bases: { 13: BRANCHES[12], 14: BRANCHES[12] },
    })
    const prepared = production.prepare({ order: numbers, originalHeads })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    const branches = prepared.preparation?.branches ?? []
    for (const branch of branches.slice(1)) {
      assert.ok(
        branch.retainedOriginalCommits.includes(originalHeads[12]),
        'the shared ancestor stays reachable under every successor',
      )
      assert.equal(
        production.storageAncestor(branches[0].preparedHead, branch.preparedHead),
        true,
        'each successor integrates the shared prepared state',
      )
      assert.equal(
        production.storageAncestor(originalHeads[12], branch.preparedHead),
        true,
        `#${branch.number} keeps the shared contribution`,
      )
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
    assert.equal(
      blocked.conflicts.find((entry) => entry.number === 13)?.needsDecision,
      true,
    )

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
  expect: { status: 'partial', codesAny: CONFLICT_CODES, detail: 'shared.txt' },
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
  expect: { status: 'partial', codes: ['invalid-input'], detail: 'intent' },
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
      const editor = await production.scratch('rename-13')
      editor.fetch()
      editor.checkout(DEFAULT_BRANCH)
      production.writeBytes(editor.path, 'moves/old.txt', Buffer.from('edited in place\n'))
      const b = editor.commit('edit where it was')
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
      production.advanceRoot({ 'root.txt': 'moves on\n', 'thing': 'a file\n' })
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
    expect: { status: 'partial', codesAny: CONFLICT_CODES, detail: structural.detail },
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
        'a refused conflict must not manufacture a prepared head',
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
  findings: ['P2 user workspace mutated'],
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
  findings: ['P2'],
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
  findings: ['P3 a replaced stash at the same count'],
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
  findings: ['P4 an overlapping run directory'],
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
  findings: ['P4 an overlapping run directory'],
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
  findings: ['P4 a storage symlink redirect'],
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
  findings: ['P4 adopting storage this run did not create'],
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
  findings: ['P9 a mandatory control bypassed'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    detail: 'commit.gpgsign',
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
  findings: ['P9'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    detail: 'core.hooksPath',
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
  findings: ['P11 an attributed merge driver executed'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    detail: 'merge.fixture.driver',
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
  findings: ['P11 refusing every configured driver'],
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
  findings: ['P8 an inherited index redirect'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13])
    const userIndex = join(production.world.root, 'user-index')
    const saved = process.env.GIT_INDEX_FILE
    process.env.GIT_INDEX_FILE = userIndex
    try {
      production.world.gitIn(production.world.repo, 'read-tree', 'HEAD')
      const before = production.world.tryGitIn(
        production.world.repo,
        'status',
        '--porcelain',
      )
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
  findings: ['P12 literal path expansion'],
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
  findings: ['P13 a symlink followed out of the workspace'],
  expect: { status: 'partial', codesAny: CONFLICT_CODES, detail: 'link.txt' },
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
    production.writeBytes(
      second.path,
      'link.txt',
      Buffer.from('a real file with the same name\n'),
    )
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
  findings: ['P7 a deleted source ref hidden by storage'],
  expect: { status: 'blocked', codes: ['stale-snapshot'], detail: 'absent from the source' },
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
  expect: { status: 'blocked', codes: ['stale-snapshot'], detail: 'moved since the plan' },
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
  expect: { status: 'blocked', codes: ['invalid-input'], detail: 'never a wildcard' },
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
  findings: ['P5 a journal overwritten by a different plan'],
  expect: { status: 'blocked', codes: ['unfinished-run'], detail: 'different selection' },
  async run(production) {
    const first = await seedStack(production, [12, 13])
    const prepared = production.prepare({ order: [12, 13], originalHeads: first })
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
    const second = await seedStack(production, [14])
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

define({
  id: 'prep-check-state-never-reaches-preparation',
  area: 'preparation',
  criteria: ['#87 four check states, one preparation decision'],
  findings: ['P10 a check state consulted or reported'],
  expect: { status: 'prepared', codes: [] },
  async run(production) {
    const originalHeads = await seedStack(production, [12, 13])
    const first = production.prepare({ order: [12, 13], originalHeads })
    assert.equal(first.ok, true, JSON.stringify(first.errors))
    const second = production.prepare({ order: [12, 13], originalHeads })
    assert.deepEqual(
      second.preparation?.branches.map((branch) => branch.preparedHead),
      first.preparation?.branches.map((branch) => branch.preparedHead),
      'preparation has no check-state input, so it cannot have one',
    )
    assert.equal(ranACommand(production, A_CHECK), false, 'preparation must not run a check')
    assert.equal(
      JSON.stringify(second).toLowerCase().includes('check state'),
      false,
      'no check state may appear anywhere in the preparation result',
    )
    return preparedOutcome(second)
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
  findings: ['P11 an attributed merge driver executed by git merge-tree'],
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
  findings: ['P11 refusing every configured driver'],
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
    assert.ok((estimate.value ?? 0) >= 1, 'a genuinely conflicting pair still costs resolution work')
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
  findings: ['B1 a branch name in a SHA field', 'B7 a base write retried after a failure'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const unrelated = await production.seedBranch('unrelated', { 'unrelated.txt': 'not selected\n' })
    const before = production.refs()

    const result = await production.publish(stack.prepared, publishArgs(stack))
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
    assert.equal(ranACommand(production, A_CHECK), false)
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
  findings: ['B4 preparation integrity skipped when no run directory was named'],
  expect: {
    status: 'blocked',
    codesAny: ['invalid-input', 'conflicting-environment-control'],
    detail: 'preparationRunDirectory',
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
  { id: 'intended-bases', mutate: (plan) => void (plan.intendedBases = { 12: 'main', 13: 'main' }) },
  { id: 'prepared-heads', mutate: (plan) => void (plan.preparedHeads = { 12: 'a'.repeat(40) }) },
]

for (const mutation of journalMutations) {
  define({
    id: `publish-resume-under-a-mutated-${mutation.id}-is-refused`,
    area: 'publication',
    criteria: ['#88 an incompatible journal root, selection, order or prepared commit is refused'],
    findings: ['B3 a resume adopted a mutated plan'],
    expect: { status: 'blocked', codes: ['stale-snapshot'], detail: 'mutated plan' },
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
  findings: ['B3 a resume adopted a mutated plan'],
  expect: { status: 'blocked', codes: ['stale-snapshot'], detail: 'mutated plan' },
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
  findings: ['B2 a conflicted workspace published over'],
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
  findings: ['B10 a lease taken against the observed value instead of the verified one'],
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
  findings: ['B10'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const preparedHeads = preparedHeadsOf(stack.prepared)
    // The snapshot already records this run's own prepared state, as it would after a lost
    // acknowledgement, while the remote still holds the originals.
    const observedRefs = { ...production.refs() }
    observedRefs[`refs/heads/${BRANCHES[12]}`] = preparedHeads[12]
    const result = await production.publish(stack.prepared, {
      ...publishArgs(stack),
      observedRefs,
    })
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    assert.equal(
      production.refs()[`refs/heads/${BRANCHES[12]}`],
      preparedHeads[12],
      'the verified prepared commit is what lands, whatever the recorded observation said',
    )
    const headAttempt = result.publication.attempts.find(
      (attempt) => attempt.target === `refs/heads/${BRANCHES[12]}`,
    )
    assert.equal(headAttempt?.to, preparedHeads[12])
    assert.equal(headAttempt?.lease?.expectedRemote, stack.originalHeads[12])
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
    detail: 'have not all been confirmed',
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
  { id: 'base-only-grant', granted: ['pr-base-update'], detail: 'pending head writes', zeroCalls: false },
  { id: 'ref-only-grant', granted: ['ref-update'], detail: 'retargeting', zeroCalls: false },
]

for (const grant of grantCases) {
  define({
    id: `publish-${grant.id}-blocks-before-the-push`,
    area: 'publication',
    criteria: ['#88 every required mutation kind is granted before any remote operation'],
    findings: ['B1 a ref-update grant not required for pending heads'],
    expect: { status: 'blocked', codes: ['missing-permission'], detail: grant.detail },
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
      assert.deepEqual(await baseWrites(stack.adapter), [], 'a missing grant must not become a write')
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
    detail: 'not exactly the prepared set',
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
  findings: ['B5 a base overwritten after a concurrent move'],
  expect: { status: 'blocked', codes: ['stale-snapshot'], detail: 'baseRef' },
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
  findings: ['B5 a fork adopted'],
  expect: { status: 'blocked', codes: ['stale-snapshot'], detail: 'headRepository' },
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
  findings: ['B5 unrelated state destroyed'],
  expect: {
    status: 'partial',
    codes: ['stale-snapshot'],
    detail: 'field this run never writes',
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
  findings: ['B7 the chain continued past a failed base'],
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
  findings: ['B6 a lost acknowledgement turned into a duplicate write'],
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
  findings: ['B6 an unread answer reported as success'],
  expect: { status: 'partial', detail: 'is unconfirmed' },
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
  findings: ['B9 unread state reported as published'],
  expect: { status: 'partial', detail: 'final read-back' },
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
  findings: ['B6 a successful-looking push believed on its exit status'],
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
  findings: ['B8 a lease checked before the concurrent push'],
  expect: { status: 'blocked', codes: ['stale-snapshot'] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const concurrent = await production.seedBranch(
      BRANCHES[12],
      { 'concurrent.txt': 'somebody else\n' },
      { base: BRANCHES[12] },
    )
    const result = await production.publish(stack.prepared, publishArgs(stack), {
      // Somebody else lands a push between the preflight read and the write. The push that
      // follows is the real one, so the lease rejection is Git's own answer.
      push: (repository: string, endpoint: string, refspecs: string[], leases: string[]) => {
        production.world.moveRemoteRef(BRANCHES[12], concurrent)
        return production.realPush(repository, endpoint, refspecs, leases)
      },
    })
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
  expect: { status: 'blocked', codes: ['stale-snapshot'], detail: 'root' },
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
  findings: ['B9 a root advance reported as integrated'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const newer = await production.seedBranch(DEFAULT_BRANCH, { 'later.txt': 'root moves late\n' })
    let reads = 0
    const result = await production.publish(
      stack.prepared,
      { ...publishArgs(stack), root: { ref: ROOT_REF, oid: stack.root } },
      {
        readRemoteRefs: (repository: string, endpoint: string) => {
          reads += 1
          const refs = realRemoteRefs(production, endpoint)
          if (reads === 2) {
            production.world.moveRemoteRef(DEFAULT_BRANCH, newer)
            return { ...refs, [ROOT_REF]: newer }
          }
          return refs
        },
      },
    )
    assert.equal(result.status, 'published', JSON.stringify(result.errors))
    assert.notEqual(result.rootAdvance?.integrated, true, 'newer root work is never claimed')
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
  findings: ['B8 a ref that moved during the run was never re-read'],
  expect: {
    status: 'blocked',
    codesAny: ['stale-snapshot', 'conflicting-environment-control'],
    detail: 'refs/heads/stranger',
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
  findings: ['B6 acknowledged writes reported as "nothing was written"'],
  expect: { status: 'partial', codes: ['unfinished-run'], detail: 'journal' },
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
  findings: ['P10 a check state consulted or reported'],
  expect: { status: 'published', codes: [] },
  async run(production) {
    const control = await preparedStack(production, [12, 13])
    const controlResult = await production.publish(control.prepared, publishArgs(control))
    assert.equal(controlResult.status, 'published', JSON.stringify(controlResult.errors))

    const labelled = await preparedStack(production, [12, 13])
    for (const number of [12, 13]) {
      labelled.pullRequests[number] = {
        ...labelled.pullRequests[number],
        labels: ['ci/failing'],
        title: `Feature #${number} (failing checks)`,
      }
    }
    const labelledAdapter = production.adapter(Object.values(labelled.pullRequests))
    const labelledResult = await production.publish(labelled.prepared, {
      ...publishArgs(labelled),
      providerModule: labelledAdapter.module,
    })
    assert.equal(labelledResult.status, 'published', JSON.stringify(labelledResult.errors))
    assert.deepEqual(
      labelledResult.publication.attempts.map((attempt) => attempt.target).sort(),
      controlResult.publication.attempts.map((attempt) => attempt.target).sort(),
      'a check state is not an input to this decision',
    )
    assert.equal(
      JSON.stringify(labelledResult).toLowerCase().includes('check state'),
      false,
      'no check state may appear anywhere in the publication result',
    )
    assert.equal(ranACommand(production, A_CHECK), false, 'publication must not run a check')
    return publicationOutcome(labelledResult)
  },
})

define({
  id: 'publish-a-remote-helper-transport-is-refused-by-name',
  area: 'publication',
  criteria: ['#88 no program is executed by merely addressing a remote'],
  findings: ['B11 a remote helper executed'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    detail: 'remote-helper',
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
  findings: ['B11 a fan-out push treated as one transaction'],
  expect: {
    status: 'blocked',
    codes: ['conflicting-environment-control'],
    detail: 'more than one push destination',
  },
  async run(production) {
    const stack = await preparedStack(production, [12, 13])
    const second = join(production.world.root, 'second.git')
    production.world.gitIn(production.world.root, 'init', '--bare', '--quiet', second)
    production.world.gitIn(production.storage(), 'remote', 'add', 'mirror', production.world.remote)
    production.world.gitIn(
      production.storage(),
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
  findings: ['B11 an origin guessed from configuration'],
  expect: {
    status: 'blocked',
    codes: ['invalid-input'],
    detail: 'existing absolute directory',
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
