import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorld, type World } from './support/real-git'
import { prepareStack } from '../../../.agents/skills/flatten-pr-graph/scripts/prepare-stack.mjs'
import { publishStack } from '../../../.agents/skills/flatten-pr-graph/scripts/publish-stack.mjs'

/**
 * Issue #87's cumulative preparation and issue #88's scoped publication.
 *
 * Every assertion here is made against Git's own state - `ls-remote`, ancestry, the
 * unmerged index - rather than against a field the helper reports about itself. A helper
 * that claimed success while the remote disagreed would fail here.
 */

interface PrepareInput {
  runDirectory: string
  order: number[]
  heads: Record<number, string>
  originalHeads: Record<number, string>
  root?: { ref: string; oid: string }
  rootFiles?: Record<string, string>
  userWorkspace?: string | null
  resolutions?: Array<{
    number: number
    path: string
    content: string
    intent: string
    reason: string
  }>
  resume?: boolean
}

interface PreparedRun {
  ok: boolean
  status?: string
  errors: Array<{ code: string; detail: string; evidence: string }>
  conflicts: Array<{ number: number; path: string; kind: string; needsDecision: boolean }>
  decisions: Array<{ number: number; path: string; intent?: string; reason?: string }>
  preparation: null | {
    branches: Array<{
      number: number
      originalHead: string
      preparedHead: string
      basedOn: string
      retainedOriginalCommits: string[]
      historyPolicy: string
    }>
    lostOriginalCommits: string[]
  }
  run: null | { runDirectory: string; journalPath: string; storage?: string }
  continuation: { prepared: number[]; remaining: number[]; resumeFrom: number | null }
  journalPath: string
  repeated?: boolean
  controls?: Array<{ control: string; value: string; blocking: boolean; effect: string }>
  verification: Array<{ invariant: string; observed: string; result: string }>
  userWorkspace?: null | {
    present: boolean
    path: string
    status: string
    worktreeDigest: string
    indexDigest: string
    operationsInProgress: string[]
  }
}

interface PublicationRun {
  ok: boolean
  status: string
  errors: Array<{ code: string; detail: string; evidence: string }>
  publication: {
    attempts: Array<{ kind: string; target: string; acknowledged: boolean; outcome: string }>
    confirmed: Array<{ kind: string; target: string }>
    unconfirmed: Array<{ kind: string; target: string }>
    interrupted: boolean
  }
  capability: Record<string, unknown> & { blockedControls?: string[] }
  rootAdvance: null | { pinned: string; observed: string; integrated: boolean }
  recovery: null | { unconfirmedAttempts: string[] }
  controls: Array<{
    control: string
    value: string
    blocking: boolean
    effect: string
  }>
  verification: Array<{ invariant: string; observed: string; result: string }>
}

/** The publication document, with the fields a test narrows or overrides typed. */
interface PublicationDocument extends Record<string, unknown> {
  authority: { intent: string; selection: number[]; granted: string[]; hostVerified: boolean }
  preparation: PreparedRun['preparation']
  order: number[]
  heads: Record<number, string>
  intendedBases: Record<number, string>
}

const BRANCHES: Record<number, string> = {
  12: 'feat-a',
  13: 'feat-b',
  14: 'feat-c',
  15: 'feat-conflict',
  16: 'feat-lock',
}
function planInput(world: World, input: PrepareInput): Record<string, unknown> {
  return {
    contractVersion: 'flatten-pr-graph/1',
    repository: world.remote,
    runDirectory: input.runDirectory,
    root: input.root ?? { ref: 'refs/heads/main', oid: world.remoteRefs()['refs/heads/main'] },
    selection: input.order,
    order: input.order,
    heads: input.heads,
    originalHeads: input.originalHeads,
    userWorkspace: input.userWorkspace ?? null,
    resolutions: input.resolutions ?? [],
    resume: input.resume ?? false,
    now: '2026-10-01T09:00:00.000Z',
  }
}

const advancedRoots = new WeakSet<World>()

async function runPrepare(world: World, input: PrepareInput): Promise<PreparedRun> {
  // A branch seeded from `main` already contains that commit, so preparation would only
  // ever fast-forward. Moving the root first gives every scenario the real case: a base
  // the pull request branched before.
  if (!input.root && !advancedRoots.has(world)) {
    advancedRoots.add(world)
    await advanceRoot(world, input.rootFiles ?? { 'root.txt': 'root moves on\n' })
  }
  return (await prepareStack(planInput(world, input))) as unknown as PreparedRun
}

async function runPublish(
  world: World,
  document: Record<string, unknown>,
  conversations?: Record<string, unknown>,
): Promise<PublicationRun> {
  const result = await publishStack(
    {
      contractVersion: 'flatten-pr-graph/1',
      repository: join(world.root, 'run', 'storage.git'),
      remote: world.remote,
      now: '2026-10-01T09:05:00.000Z',
      ...document,
    },
    conversations as never,
  )
  return result as unknown as PublicationRun
}

let scratchCounter = 0

async function seedBranch(
  world: World,
  branch: string,
  files: Record<string, string>,
  base = 'main',
): Promise<string> {
  scratchCounter += 1
  const scratch = await world.createScratch(`seed-${branch}-${scratchCounter}`)
  scratch.fetch()
  scratch.checkout(base)
  for (const [path, content] of Object.entries(files)) {
    await scratch.write(path, content)
  }
  const oid = scratch.commit(`work on ${branch}`)
  scratch.push(branch, { force: true })
  return oid
}

/**
 * Moves the default branch on. A branch seeded before this no longer contains the pinned
 * root, so preparation has to produce real integration commits and publication has real
 * work to do.
 */
async function advanceRoot(world: World, files: Record<string, string>): Promise<string> {
  scratchCounter += 1
  const scratch = await world.createScratch(`root-${scratchCounter}`)
  scratch.fetch()
  scratch.checkout('main')
  for (const [path, content] of Object.entries(files)) {
    await scratch.write(path, content)
  }
  const oid = scratch.commit('root moves on')
  scratch.push('main')
  return oid
}

function publicationDocument(
  world: World,
  prepared: PreparedRun,
  numbers: number[],
  overrides: Record<string, unknown> = {},
): PublicationDocument {
  const root = world.remoteRefs()['refs/heads/main']
  return {
    runDirectory: join(world.root, 'publication'),
    authority: {
      intent: 'execute',
      selection: numbers,
      granted: ['ref-update', 'pr-base-update'],
      hostVerified: true,
    },
    preparation: prepared.preparation,
    order: numbers,
    heads: Object.fromEntries(numbers.map((number) => [number, `refs/heads/${BRANCHES[number]}`])),
    intendedBases: Object.fromEntries(
      numbers.map((number, index) => [number, index === 0 ? 'main' : BRANCHES[numbers[index - 1]]]),
    ),
    root: { ref: 'refs/heads/main', oid: root },
    observedRefs: { 'refs/heads/main': root },
    // The manifest alone is a claim; publication reads the task-owned run that produced it,
    // so every publication in this file names the run its preparation wrote.
    preparationRunDirectory: prepared.run?.runDirectory,
    pullRequests: Object.fromEntries(
      numbers.map((number) => [number, pinnedPullRequest(number, BRANCHES[number])]),
    ),
    provider: { module: providerModule(world, {}) },
    ...overrides,
  }
}

/**
 * The authorized snapshot of one pull request, in the shape a publication pins.
 *
 * It is the same value the provider double starts from, so a document that pins it is
 * asserting what was authorized rather than what the run would like to see.
 */
function pinnedPullRequest(number: number, branch: string): Record<string, unknown> {
  return {
    number,
    state: 'OPEN',
    draft: false,
    baseRef: 'main',
    headRef: branch,
    headRepository: 'acme/widgets',
    title: 'Feature',
    body: 'body',
    labels: [],
    reviewers: [],
    autoMergeRequest: { enabled: false, method: null },
  }
}

/** Writes a provider double with the same three operations the contract allows. */
function providerModule(world: World, behaviour: Record<string, string>): string {
  const path = join(world.root, `provider-${Math.random().toString(36).slice(2)}.mjs`)
  const seeded = Object.entries(BRANCHES).map(([number, branch]) => [
    Number(number),
    pinnedPullRequest(Number(number), branch),
  ])
  writeFileSync(
    path,
    `import { appendFileSync } from 'node:fs'
let refusals = 0
const callLog = ${JSON.stringify(join(world.root, 'provider-calls.jsonl'))}
const pullRequests = new Map(${JSON.stringify(seeded)})
export function capabilities() {
  return { operations: ['read-pull-request', 'update-pull-request-base'], compareAndSwap: false, provider: 'double' }
}
export function readPullRequest(number) {
  const pullRequest = pullRequests.get(number)
  return { ok: true, pullRequest: pullRequest ? structuredClone(pullRequest) : null }
}
export function updatePullRequestBase(number, base, expectedBase) {
  ${behaviour.refuseBase ?? ''}
  const pullRequest = pullRequests.get(number)
  if (!pullRequest) return { ok: false, applied: false }
  pullRequest.baseRef = base
  appendFileSync(callLog, JSON.stringify({ number, base }) + '\\n')
  ${behaviour.loseAck ?? ''}
  return { ok: true, applied: true, preconditionMet: expectedBase ? true : null }
}
`,
  )
  return path
}

/** What the provider double was actually asked to write, in the order it was asked. */
function providerCalls(world: World): Array<{ number: number; base: string }> {
  const log = join(world.root, 'provider-calls.jsonl')
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { number: number; base: string })
    : []
}

test('preparation integrates each original head onto its predecessor prepared head', async (t) => {
  const world = await createWorld('prepare-chain')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'b.txt': 'b\n' })

  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 13],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 13: `refs/heads/${BRANCHES[13]}` },
    originalHeads: { 12: a, 13: b },
  })

  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
  const branches = prepared.preparation?.branches ?? []
  assert.deepEqual(
    branches.map((branch) => branch.number),
    [12, 13],
  )
  const storage = join(world.root, 'run', 'storage.git')
  assert.equal(world.isAncestor(storage, a, branches[0].preparedHead), true)
  assert.equal(world.isAncestor(storage, branches[0].preparedHead, branches[1].preparedHead), true)
  assert.equal(branches[1].basedOn, branches[0].preparedHead)
  for (const [index, oid] of [a, b].entries()) {
    assert.ok(
      branches[index].retainedOriginalCommits.includes(oid),
      `#${branches[index].number} retained`,
    )
  }
  assert.deepEqual(prepared.preparation?.lostOriginalCommits, [])
  assert.ok(
    prepared.verification.every((row) => row.result === 'pass'),
    JSON.stringify(prepared.verification),
  )
  // Preparation never writes to a remote: both head refs still hold the originals.
  const refs = world.remoteRefs()
  assert.equal(refs[`refs/heads/${BRANCHES[12]}`], a)
  assert.equal(refs[`refs/heads/${BRANCHES[13]}`], b)
})

test('a repeated preparation request is answered without producing new commits', async (t) => {
  const world = await createWorld('prepare-repeat')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'b.txt': 'b\n' })
  const request: PrepareInput = {
    runDirectory: join(world.root, 'run'),
    order: [12, 13],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 13: `refs/heads/${BRANCHES[13]}` },
    originalHeads: { 12: a, 13: b },
  }
  const first = await runPrepare(world, request)
  const second = await runPrepare(world, request)

  assert.equal(second.ok, true, JSON.stringify(second.errors))
  assert.equal(second.repeated, true)
  assert.deepEqual(
    second.preparation?.branches.map((branch) => branch.preparedHead),
    first.preparation?.branches.map((branch) => branch.preparedHead),
  )
})

test('a conflict blocks preparation with both sides and a resume point', async (t) => {
  const world = await createWorld('prepare-conflict')
  t.after(() => world.cleanup())
  // The root carries the file first, so both pull requests edit it and the merge is a
  // genuine content conflict rather than two branches independently adding one.
  const rootOid = await advanceRoot(world, { 'shared.txt': 'seed\n' })
  const a = await seedBranch(world, BRANCHES[12], { 'shared.txt': 'ours\n' })
  const conflicting = await seedBranch(world, BRANCHES[15], { 'shared.txt': 'theirs\n' })

  const blocked = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 15],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 15: `refs/heads/${BRANCHES[15]}` },
    originalHeads: { 12: a, 15: conflicting },
    root: { ref: 'refs/heads/main', oid: rootOid },
  })

  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 'partial')
  assert.deepEqual(
    blocked.preparation?.branches.map((branch) => branch.number),
    [12],
  )
  const conflict = blocked.conflicts.find((entry) => entry.number === 15)
  assert.ok(conflict, JSON.stringify(blocked.errors))
  assert.equal(conflict.path, 'shared.txt')
  assert.equal(conflict.needsDecision, true)
  assert.equal(blocked.continuation.resumeFrom, 15)
  assert.equal(blocked.continuation.prepared.includes(12), true)
  // A blocked preparation leaves the remote exactly where it was.
  assert.equal(world.remoteRefs()[`refs/heads/${BRANCHES[15]}`], conflicting)
})

test('two branches adding the same path is refused without a stated decision', async (t) => {
  const world = await createWorld('prepare-add-add')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'added-twice.txt': 'ours\n' })
  const conflicting = await seedBranch(world, BRANCHES[15], { 'added-twice.txt': 'theirs\n' })

  const blocked = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 15],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 15: `refs/heads/${BRANCHES[15]}` },
    originalHeads: { 12: a, 15: conflicting },
  })

  assert.equal(blocked.ok, false)
  const conflict = blocked.conflicts.find((entry) => entry.number === 15)
  assert.equal(conflict?.kind, 'add-add')
  assert.equal(blocked.decisions.length, 0)
})

test('a caller-supplied resolution produces a prepared state the next run verifies', async (t) => {
  const world = await createWorld('prepare-resolve')
  t.after(() => world.cleanup())
  const rootOid = await advanceRoot(world, { 'shared.txt': 'seed\n' })
  const a = await seedBranch(world, BRANCHES[12], { 'shared.txt': 'ours\n' })
  const conflicting = await seedBranch(world, BRANCHES[15], { 'shared.txt': 'theirs\n' })
  const runDirectory = join(world.root, 'run')
  const request: PrepareInput = {
    runDirectory,
    order: [12, 15],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 15: `refs/heads/${BRANCHES[15]}` },
    originalHeads: { 12: a, 15: conflicting },
    root: { ref: 'refs/heads/main', oid: rootOid },
  }
  const blocked = await runPrepare(world, request)
  const evidence = blocked.errors.find((error) => error.code === 'unresolved-conflict')
  assert.ok(evidence, JSON.stringify(blocked.errors))

  const resolved = await runPrepare(world, {
    ...request,
    resume: true,
    resolutions: [
      {
        number: 15,
        path: 'shared.txt',
        content: 'seed\nours\ntheirs\n',
        intent: 'keep the root text and the change #15 states',
        reason: 'both sides stated; neither is a strict superset',
      },
    ],
  })
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors))
  assert.ok(resolved.conflicts.some((conflict) => conflict.number === 15))
  const branch = resolved.preparation?.branches.find((entry) => entry.number === 15)
  assert.ok(branch)
  assert.equal(
    world.isAncestor(join(runDirectory, 'storage.git'), conflicting, branch.preparedHead),
    true,
  )
})

test('preparation leaves a dirty, staged, untracked user checkout untouched', async (t) => {
  const world = await createWorld('prepare-user-state')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'b.txt': 'b\n' })
  world.gitIn(world.repo, 'checkout', '-q', 'main')
  world.gitIn(world.repo, 'checkout', '-q', '-b', 'wip')
  writeFileSync(join(world.repo, 'dirty.txt'), 'uncommitted\n')
  writeFileSync(join(world.repo, 'staged.txt'), 'staged\n')
  world.gitIn(world.repo, 'add', 'staged.txt')
  const before = world.userFingerprint()

  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 13],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 13: `refs/heads/${BRANCHES[13]}` },
    originalHeads: { 12: a, 13: b },
  })

  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
  assert.deepEqual(world.userFingerprint(), before)
})

test('a lockfile conflict is refused instead of being resolved by a rule', async (t) => {
  const world = await createWorld('prepare-lockfile')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'package-lock.json': '{"v":1}\n' })
  const conflicting = await seedBranch(world, BRANCHES[16], { 'package-lock.json': '{"v":2}\n' })

  const blocked = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 16],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 16: `refs/heads/${BRANCHES[16]}` },
    originalHeads: { 12: a, 16: conflicting },
    resolutions: [
      {
        number: 16,
        path: 'package-lock.json',
        content: '{"v":3}\n',
        intent: 'invented',
        reason: 'invented',
      },
    ],
  })

  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 'partial')
  assert.ok(
    blocked.errors.some((error) => /lockfile|generated/i.test(`${error.detail} ${error.evidence}`)),
    JSON.stringify(blocked.errors),
  )
})

test('publication pushes the prepared heads atomically and retargets bases in order', async (t) => {
  const world = await createWorld('publish-happy')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'b.txt': 'b\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 13],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 13: `refs/heads/${BRANCHES[13]}` },
    originalHeads: { 12: a, 13: b },
  })
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))

  const published = await runPublish(world, publicationDocument(world, prepared, [12, 13]))

  assert.equal(published.status, 'published', JSON.stringify(published.errors))
  const refs = world.remoteRefs()
  assert.equal(refs[`refs/heads/${BRANCHES[12]}`], prepared.preparation?.branches[0].preparedHead)
  assert.equal(refs[`refs/heads/${BRANCHES[13]}`], prepared.preparation?.branches[1].preparedHead)
  assert.equal(refs['refs/heads/main'], world.remoteRefs()['refs/heads/main'])
  // #12 already builds on the root, so only the second base needs writing; the double
  // records what it was actually asked to write, in the order it was asked.
  assert.deepEqual(providerCalls(world), [{ number: 13, base: BRANCHES[12] }])
  assert.deepEqual(
    published.publication.attempts
      .filter((attempt) => attempt.kind === 'pr-base-update')
      .map((attempt) => attempt.target),
    ['13'],
  )
  assert.ok(published.publication.attempts.every((attempt) => attempt.acknowledged))
  assert.equal(published.capability.atomicRefTransaction, 'supported')
  assert.equal(published.capability.baseWritesGuardedBy, 'read-before-write')
  assert.equal(published.capability.residualMetadataRace, true)
})

test('republishing an already published chain reports a no-op with no attempts', async (t) => {
  const world = await createWorld('publish-noop')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const first = await runPublish(world, publicationDocument(world, prepared, [12]))
  assert.equal(first.status, 'published', JSON.stringify(first.errors))
  const refsAfterFirst = world.remoteRefs()

  const again = await runPublish(
    world,
    publicationDocument(world, prepared, [12], { runDirectory: join(world.root, 'publication-2') }),
  )

  assert.equal(again.status, 'no-op')
  assert.deepEqual(again.publication.attempts, [])
  assert.deepEqual(world.remoteRefs(), refsAfterFirst)
})

test('a preview intent publishes nothing', async (t) => {
  const world = await createWorld('publish-preview')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const before = world.remoteRefs()

  const preview = await runPublish(
    world,
    publicationDocument(world, prepared, [12], {
      authority: { intent: 'preview', selection: [12], granted: [], hostVerified: false },
    }),
  )

  assert.equal(preview.status, 'blocked')
  assert.deepEqual(preview.publication.attempts, [])
  assert.deepEqual(world.remoteRefs(), before)
})

test('a remote without atomic ref transactions is refused before any write', async (t) => {
  const world = await createWorld('publish-atomic')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const before = world.remoteRefs()

  const refused = await runPublish(world, publicationDocument(world, prepared, [12]), {
    detectAtomicRefTransaction: () => ({
      supported: false,
      evidence: 'the remote refuses --atomic',
    }),
    push: () => {
      throw new Error('a write was attempted after the capability answer')
    },
  })

  assert.equal(refused.status, 'blocked')
  assert.equal(refused.publication.attempts.length, 0)
  assert.deepEqual(world.remoteRefs(), before)
})

test('a root that moved after planning stops the run before the capability question', async (t) => {
  const world = await createWorld('publish-root-drift')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const document = publicationDocument(world, prepared, [12])
  const pinnedRoot = (document.root as { oid: string }).oid
  const movedRoot = await seedBranch(world, 'later-root-work', { 'c.txt': 'c\n' })
  world.moveRemoteRef('main', movedRoot)
  const before = world.remoteRefs()

  const drift = await runPublish(world, document, {
    detectAtomicRefTransaction: () => {
      throw new Error('the capability question was asked after the root had moved')
    },
    push: () => {
      throw new Error('a write was attempted after the root had moved')
    },
  })

  assert.equal(drift.status, 'blocked')
  assert.ok(
    drift.errors.some(
      (error) => /root/i.test(error.detail) && error.evidence.includes(pinnedRoot.slice(0, 12)),
    ),
    JSON.stringify(drift.errors),
  )
  assert.deepEqual(world.remoteRefs(), before)
  assert.equal(drift.rootAdvance?.observed, movedRoot)
  assert.equal(drift.rootAdvance?.integrated, false)
})

test('a head branch that moved is never overwritten', async (t) => {
  const world = await createWorld('publish-head-move')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const concurrent = await seedBranch(world, 'feat-a', { 'concurrent.txt': 'theirs\n' })
  const before = world.remoteRefs()

  const blocked = await runPublish(world, publicationDocument(world, prepared, [12]), {
    push: () => {
      throw new Error('a write was attempted although the head had moved')
    },
  })

  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(world.remoteRefs(), before)
  assert.equal(world.remoteRefs()[`refs/heads/${BRANCHES[12]}`], concurrent)
})

test('a move that lands between the check and the push loses to the lease', async (t) => {
  const world = await createWorld('publish-lease-race')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  // A commit somebody else will push, kept off the head branch so the run's own check sees
  // the state it expects until the move lands mid-push.
  const concurrent = await seedBranch(world, 'concurrent-work', { 'concurrent.txt': 'theirs\n' })

  const raced = await runPublish(world, publicationDocument(world, prepared, [12]), {
    push: (repository: string, remote: string, refspecs: string[], leases: string[]) => {
      world.moveRemoteRef(BRANCHES[12], concurrent)
      world.tryGitIn(repository, 'push', '--atomic', ...leases, remote, ...refspecs)
      return {
        ok: false,
        status: 1,
        stdout: '',
        stderr: 'the lease did not match the value the push pinned',
      }
    },
  })

  // The ref write lost its lease, and #12 already had the right base, so nothing landed:
  // the run reports exactly that rather than calling the base write a success.
  assert.equal(raced.status, 'blocked')
  const refAttempt = raced.publication.attempts.find((attempt) => attempt.kind === 'ref-update')
  assert.equal(refAttempt?.acknowledged, false)
  assert.equal(refAttempt?.outcome, 'rejected')
  assert.equal(world.remoteRefs()[`refs/heads/${BRANCHES[12]}`], concurrent)
  assert.deepEqual(
    raced.publication.unconfirmed.map((entry) => entry.kind),
    ['ref-update'],
  )
})

test('a refused second base is reported as partial, and a resume finishes it', async (t) => {
  const world = await createWorld('publish-resume')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'b.txt': 'b\n' })
  const c = await seedBranch(world, BRANCHES[14], { 'c.txt': 'c\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 13, 14],
    heads: {
      12: `refs/heads/${BRANCHES[12]}`,
      13: `refs/heads/${BRANCHES[13]}`,
      14: `refs/heads/${BRANCHES[14]}`,
    },
    originalHeads: { 12: a, 13: b, 14: c },
  })
  // The double refuses the first attempt on #13 and answers afterwards: the module is
  // imported once per process, so the resume sees the same provider state the partial run
  // left behind.
  const refusing = providerModule(world, {
    refuseBase: 'if (number === 14 && refusals++ === 0) return { ok: false, applied: false }',
  })
  const runDirectory = join(world.root, 'publication')
  const document = publicationDocument(world, prepared, [12, 13, 14], {
    provider: { module: refusing },
    runDirectory,
  })

  const partial = await runPublish(world, document)
  assert.equal(partial.status, 'partial', JSON.stringify(partial.errors))
  assert.equal(
    partial.publication.confirmed.filter((entry) => entry.kind === 'pr-base-update').length,
    1,
  )
  assert.equal(
    partial.publication.unconfirmed.filter((entry) => entry.kind === 'pr-base-update').length,
    1,
  )
  assert.ok(partial.recovery)

  const resumed = await runPublish(world, { ...document, resume: true })
  assert.equal(resumed.status, 'published', JSON.stringify(resumed.errors))
  assert.deepEqual(
    resumed.publication.attempts
      .filter((attempt) => attempt.kind === 'pr-base-update')
      .map((attempt) => attempt.target),
    ['14'],
  )
})

test('an acknowledgement lost after the write is reconciled by re-reading, not by retrying', async (t) => {
  const world = await createWorld('publish-lost-ack')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'b.txt': 'b\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 13],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 13: `refs/heads/${BRANCHES[13]}` },
    originalHeads: { 12: a, 13: b },
  })
  const lossy = providerModule(world, {
    loseAck: 'if (number === 13) throw new Error("connection reset after the write")',
  })

  const published = await runPublish(
    world,
    publicationDocument(world, prepared, [12, 13], { provider: { module: lossy } }),
  )

  assert.equal(published.status, 'published', JSON.stringify(published.errors))
  const second = published.publication.attempts.find((attempt) => attempt.target === '13')
  assert.equal(second?.acknowledged, true)
  assert.equal(published.publication.unconfirmed.length, 0)
})

test('a pre-push hook stops publication instead of being bypassed', async (t) => {
  const world = await createWorld('publish-hook')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const storage = join(world.root, 'run', 'storage.git')
  writeFileSync(join(storage, 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const before = world.remoteRefs()

  const blocked = await runPublish(world, publicationDocument(world, prepared, [12]))

  assert.equal(blocked.status, 'blocked')
  assert.ok(
    blocked.capability.blockedControls?.toString().includes('pre-push'),
    JSON.stringify(blocked.capability),
  )
  assert.deepEqual(world.remoteRefs(), before)
})

test('configuration that would push extra refs stops publication', async (t) => {
  const world = await createWorld('publish-followtags')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const storage = join(world.root, 'run', 'storage.git')
  world.gitIn(storage, 'config', 'push.followTags', 'true')
  const before = world.remoteRefs()

  const blocked = await runPublish(world, publicationDocument(world, prepared, [12]))

  assert.equal(blocked.status, 'blocked')
  assert.ok(
    /followtags/i.test(`${blocked.capability.blockedControls?.join(',')}`),
    JSON.stringify(blocked.capability),
  )
  assert.deepEqual(world.remoteRefs(), before)
})

test('an empty grant or base-only grant with pending heads blocks before push calls', async (t) => {
  const world = await createWorld('publish-missing-grant')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const before = world.remoteRefs()

  // 1. Empty grant
  const emptyDoc = publicationDocument(world, prepared, [12])
  emptyDoc.authority.granted = []
  const blockedEmpty = await runPublish(world, emptyDoc)
  assert.equal(blockedEmpty.status, 'blocked')
  assert.ok(blockedEmpty.errors.some((e) => e.code === 'missing-permission'))
  assert.deepEqual(world.remoteRefs(), before)

  // 2. Base-only grant with pending head writes
  const baseOnlyDoc = publicationDocument(world, prepared, [12])
  baseOnlyDoc.authority.granted = ['pr-base-update']
  const blockedBaseOnly = await runPublish(world, baseOnlyDoc)
  assert.equal(blockedBaseOnly.status, 'blocked')
  assert.ok(blockedBaseOnly.errors.some((e) => e.code === 'missing-permission'))
  assert.deepEqual(world.remoteRefs(), before)
})

test('publication pushes write.to even if backup ref was changed to unrelated commit', async (t) => {
  const world = await createWorld('publish-verified-sha')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const storage = join(world.root, 'run', 'storage.git')
  world.gitIn(storage, 'update-ref', 'refs/heads/prepared/12', a)

  const doc = publicationDocument(world, prepared, [12])
  const result = await runPublish(world, doc)
  assert.equal(result.status, 'published')
  assert.equal(
    world.remoteRefs()[`refs/heads/${BRANCHES[12]}`],
    prepared.preparation?.branches[0].preparedHead,
  )
})

test('publication retargets non-contiguous PR numbers correctly by number', async (t) => {
  const world = await createWorld('publish-non-contiguous')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[15], { 'b.txt': 'b\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 15],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 15: `refs/heads/${BRANCHES[15]}` },
    originalHeads: { 12: a, 15: b },
  })
  const doc = publicationDocument(world, prepared, [12, 15])
  doc.intendedBases = { 12: 'main', 15: BRANCHES[12] }
  const result = await runPublish(world, doc)
  assert.equal(result.status, 'published')
  const calls = providerCalls(world)
  // PR 12 was already on main, so it is skipped; PR 15 was retargeted to feat-a
  assert.deepEqual(calls, [{ number: 15, base: BRANCHES[12] }])
})

test('a base write without its grant is refused before the head push, not after it', async (t) => {
  const world = await createWorld('publish-ref-only-grant')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const doc = publicationDocument(world, prepared, [12])
  doc.intendedBases = { 12: 'other-base' }
  doc.authority.granted = ['ref-update']
  const before = world.remoteRefs()

  const result = await runPublish(world, doc)

  // The whole write set is known before the first remote operation, so a missing grant
  // for any part of it stops the run with nothing written - not after the heads landed.
  assert.equal(result.status, 'blocked')
  assert.equal(result.ok, false)
  assert.ok(
    result.errors.some((error) => error.code === 'missing-permission'),
    JSON.stringify(result.errors),
  )
  assert.deepEqual(result.publication.attempts, [])
  assert.deepEqual(world.remoteRefs(), before)
  assert.deepEqual(providerCalls(world), [])
})

test('repeated PR numbers in order are rejected before remote conversations', async (t) => {
  const world = await createWorld('publish-duplicate-order')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const doc = publicationDocument(world, prepared, [12])
  doc.order = [12, 12]

  const result = await runPublish(world, doc)
  assert.equal(result.status, 'blocked')
  assert.ok(result.errors.some((e) => e.code === 'invalid-input'))
})

test('unauthorized invocation leaves existing recovery journal intact', async (t) => {
  const world = await createWorld('publish-preserve-journal')
  t.after(() => world.cleanup())
  const runDir = join(world.root, 'run')
  mkdirSync(runDir, { recursive: true })
  const journalPath = join(runDir, 'publication-journal.json')
  const initialJournal = {
    contractVersion: 'flatten-pr-graph/1',
    state: 'partial',
    attempts: [
      { sequence: 1, kind: 'ref-update', target: 'refs/heads/feat-a', outcome: 'unknown' },
    ],
    confirmed: [],
    unconfirmed: [{ kind: 'ref-update', target: 'refs/heads/feat-a', why: 'unknown' }],
  }
  writeFileSync(journalPath, JSON.stringify(initialJournal))

  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: runDir,
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const doc = publicationDocument(world, prepared, [12])
  doc.authority.intent = 'preview'

  const result = await runPublish(world, doc)
  assert.equal(result.status, 'blocked')

  const readBack = JSON.parse(readFileSync(journalPath, 'utf8'))
  assert.equal(readBack.state, 'partial')
  assert.equal(readBack.attempts[0].outcome, 'unknown')
})

test('a source ref deleted after preparation invalidates the recorded run', async (t) => {
  const world = await createWorld('prepare-deleted-source-ref')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const request: PrepareInput = {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  }
  const first = await runPrepare(world, request)
  assert.equal(first.ok, true, JSON.stringify(first.errors))

  // The task-owned snapshot namespace still holds the deleted ref; only the source knows.
  world.gitIn(world.remote, 'update-ref', '-d', `refs/heads/${BRANCHES[12]}`)
  const repeat = await runPrepare(world, request)

  assert.equal(repeat.ok, false)
  assert.equal(repeat.preparation, null)
  assert.ok(
    repeat.errors.some((error) => error.code === 'stale-snapshot'),
    JSON.stringify(repeat.errors),
  )
})

test('a resume does not adopt a staged resolution the journal never recorded', async (t) => {
  const world = await createWorld('prepare-unrecorded-resolution')
  t.after(() => world.cleanup())
  const rootOid = await advanceRoot(world, { 'shared.txt': 'seed\n' })
  const a = await seedBranch(world, BRANCHES[12], { 'shared.txt': 'ours\n' })
  const conflicting = await seedBranch(world, BRANCHES[15], { 'shared.txt': 'theirs\n' })
  const runDirectory = join(world.root, 'run')
  const request: PrepareInput = {
    runDirectory,
    order: [12, 15],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 15: `refs/heads/${BRANCHES[15]}` },
    originalHeads: { 12: a, 15: conflicting },
    root: { ref: 'refs/heads/main', oid: rootOid },
  }
  const blocked = await runPrepare(world, request)
  assert.equal(blocked.status, 'partial')

  // Somebody resolves the conflict by hand and stages it. The index now records content
  // this run never decided, so continuing would attribute it to a decision nobody made.
  const workspace = join(runDirectory, 'workspaces', 'pr-15')
  writeFileSync(join(workspace, 'shared.txt'), 'seed\nours\ntheirs\n')
  world.gitIn(workspace, 'add', 'shared.txt')
  const staged = world.resolveIn(workspace, 'HEAD')

  const resumed = await runPrepare(world, { ...request, resume: true })

  assert.equal(resumed.ok, false)
  assert.ok(
    resumed.errors.some(
      (error) => error.code === 'unfinished-run' && /never decided/.test(error.detail) === true,
    ),
    JSON.stringify(resumed.errors),
  )
  // Nothing was committed on the strength of the unrecorded content.
  assert.equal(world.resolveIn(workspace, 'HEAD'), staged)
})

test('an executable hook installed in a task workspace stops the resumed merge', async (t) => {
  const world = await createWorld('prepare-workspace-hook')
  t.after(() => world.cleanup())
  const rootOid = await advanceRoot(world, { 'shared.txt': 'seed\n' })
  const a = await seedBranch(world, BRANCHES[12], { 'shared.txt': 'ours\n' })
  const conflicting = await seedBranch(world, BRANCHES[15], { 'shared.txt': 'theirs\n' })
  const runDirectory = join(world.root, 'run')
  const request: PrepareInput = {
    runDirectory,
    order: [12, 15],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 15: `refs/heads/${BRANCHES[15]}` },
    originalHeads: { 12: a, 15: conflicting },
    root: { ref: 'refs/heads/main', oid: rootOid },
  }
  const blocked = await runPrepare(world, request)
  assert.equal(blocked.status, 'partial')

  const workspace = join(runDirectory, 'workspaces', 'pr-15')
  const hooksDir = join(workspace, '.git', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const before = world.resolveIn(workspace, 'HEAD')

  const resumed = await runPrepare(world, {
    ...request,
    resume: true,
    resolutions: [
      {
        number: 15,
        path: 'shared.txt',
        content: 'seed\nours\ntheirs\n',
        intent: 'keep the root text and the change #15 states',
        reason: 'both sides stated; neither is a strict superset',
      },
    ],
  })

  assert.equal(resumed.ok, false)
  assert.ok(
    resumed.errors.some(
      (error) =>
        error.code === 'conflicting-environment-control' && /hooks\/pre-commit/.test(error.detail),
    ),
    JSON.stringify(resumed.errors),
  )
  assert.equal(world.resolveIn(workspace, 'HEAD'), before)
})

test('publication refuses a manifest with no task-owned run behind it', async (t) => {
  const world = await createWorld('publish-no-handoff')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
  const before = world.remoteRefs()
  const document = publicationDocument(world, prepared, [12])
  document.preparationRunDirectory = join(world.root, 'somewhere-else')

  const refused = await runPublish(world, document, {
    readRemoteRefs: () => {
      throw new Error('the remote was listed before the local handoff was checked')
    },
  })

  assert.equal(refused.status, 'blocked')
  assert.deepEqual(refused.publication.attempts, [])
  assert.deepEqual(world.remoteRefs(), before)
  assert.deepEqual(providerCalls(world), [])
})

test('publication refuses a preparation journal written for a different plan', async (t) => {
  const world = await createWorld('publish-mutated-journal')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const runDirectory = join(world.root, 'run')
  const prepared = await runPrepare(world, {
    runDirectory,
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))

  // The journal still says `prepared`, but for a selection this publication is not making.
  const journalFile = join(runDirectory, 'journal.json')
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  journal.selection = [12, 99]
  journal.preparedHeads['99'] = a
  writeFileSync(journalFile, JSON.stringify(journal))
  const before = world.remoteRefs()

  const refused = await runPublish(world, publicationDocument(world, prepared, [12]))

  assert.equal(refused.status, 'blocked')
  assert.ok(
    refused.errors.some((error) => /different selection/.test(error.detail)),
    JSON.stringify(refused.errors),
  )
  assert.deepEqual(refused.publication.attempts, [])
  assert.deepEqual(world.remoteRefs(), before)
})

test('a resume under a different pull-request snapshot is refused', async (t) => {
  const world = await createWorld('publish-resume-mutated-snapshot')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'b.txt': 'b\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 13],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 13: `refs/heads/${BRANCHES[13]}` },
    originalHeads: { 12: a, 13: b },
  })
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
  const runDirectory = join(world.root, 'publication')
  const document = publicationDocument(world, prepared, [12, 13], { runDirectory })

  const refusing = providerModule(world, {
    refuseBase: 'if (number === 13) return { ok: false, applied: false }',
  })
  const partial = await runPublish(world, {
    ...document,
    provider: { module: refusing },
  })
  assert.equal(partial.status, 'partial', JSON.stringify(partial.errors))
  const refsAfterPartial = world.remoteRefs()

  // A resume that quietly re-declares #13 as a draft is a different authorization, and
  // adopting it would let the run write metadata the original grant never covered.
  const mutated = JSON.parse(JSON.stringify(document)) as PublicationDocument
  mutated.provider = { module: refusing }
  ;(mutated.pullRequests as Record<string, Record<string, unknown>>)['13'].draft = true
  const refused = await runPublish(world, { ...mutated, resume: true })

  assert.equal(refused.status, 'blocked')
  assert.deepEqual(refused.publication.attempts, [])
  assert.deepEqual(world.remoteRefs(), refsAfterPartial)
})

test('an unselected ref that moves during publication is reported, not published over', async (t) => {
  const world = await createWorld('publish-unselected-drift')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'b.txt': 'b\n' })
  const unrelated = await seedBranch(world, 'unrelated', { 'u.txt': 'u\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12, 13],
    heads: { 12: `refs/heads/${BRANCHES[12]}`, 13: `refs/heads/${BRANCHES[13]}` },
    originalHeads: { 12: a, 13: b },
  })
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
  const root = world.remoteRefs()['refs/heads/main']
  const document = publicationDocument(world, prepared, [12, 13], {
    observedRefs: {
      'refs/heads/main': root,
      'refs/heads/unrelated': unrelated,
    },
  })

  let reads = 0
  const mover = await seedBranch(world, 'unrelated-next', { 'u2.txt': 'u2\n' })
  const drifted = await runPublish(world, document, {
    readRemoteRefs: (repository: string, endpoint: string) => {
      reads += 1
      const refs: Record<string, string> = {}
      for (const line of world.gitIn(repository, 'ls-remote', '--heads', endpoint).split('\n')) {
        const [oid, ref] = line.trim().split(/\s+/)
        if (oid && ref) refs[ref] = oid
      }
      // Somebody else's push lands after the pre-flight read and before the final one.
      if (reads >= 2) refs['refs/heads/unrelated'] = mover
      return refs
    },
  })

  assert.notEqual(drifted.status, 'published')
  assert.ok(
    drifted.verification.some(
      (row) => row.invariant === 'preservation.unselected-refs' && row.result === 'fail',
    ),
    JSON.stringify(drifted.verification),
  )
  assert.equal(world.remoteRefs()['refs/heads/unrelated'], unrelated)
})

test('a root that moves after the writes is reported against the pinned snapshot', async (t) => {
  const world = await createWorld('publish-post-write-root')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors))
  const pinned = world.remoteRefs()['refs/heads/main']
  const moved = await seedBranch(world, 'root-moved-later', { 'r.txt': 'r\n' })
  let reads = 0

  const published = await runPublish(world, publicationDocument(world, prepared, [12]), {
    readRemoteRefs: (repository: string, endpoint: string) => {
      reads += 1
      const refs: Record<string, string> = {}
      for (const line of world.gitIn(repository, 'ls-remote', '--heads', endpoint).split('\n')) {
        const [oid, ref] = line.trim().split(/\s+/)
        if (oid && ref) refs[ref] = oid
      }
      if (reads >= 2) refs['refs/heads/main'] = moved
      return refs
    },
  })

  assert.equal(published.status, 'published', JSON.stringify(published.errors))
  assert.ok(published.rootAdvance, 'the root advance must be reported')
  assert.equal(published.rootAdvance?.integrated, false)
  assert.equal(published.rootAdvance?.pinned, pinned)
  assert.equal(published.rootAdvance?.observed, moved)
  assert.ok(
    published.verification.some(
      (row) => row.invariant === 'preservation.root' && row.result === 'fail',
    ),
    JSON.stringify(published.verification),
  )
  // The head really did land, and the real root really did not move.
  assert.equal(
    world.remoteRefs()[`refs/heads/${BRANCHES[12]}`],
    prepared.preparation?.branches[0].preparedHead,
  )
  assert.equal(world.remoteRefs()['refs/heads/main'], pinned)
})

/**
 * A real program that records the fact that it ran, so "this control was reported instead
 * of bypassed" is a fact about the filesystem and not a field the helper reported about
 * itself. It is deliberately a recording wrapper and nothing else: it exits zero, so a run
 * that executed it would look successful.
 */
function recordingWrapper(path: string, marker: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\nprintf 'ran %s\\n' "$*" >> ${JSON.stringify(marker)}\nexit 0\n`)
  chmodSync(path, 0o755)
}

test('an ssh wrapper is reported and never run, before the first remote conversation', async (t) => {
  const world = await createWorld('publish-ssh-wrapper')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })

  const marker = join(world.root, 'ssh-ran.txt')
  const wrapper = join(world.root, 'wrapper', 'ssh-check')
  recordingWrapper(wrapper, marker)
  const previous = process.env.GIT_SSH_COMMAND
  process.env.GIT_SSH_COMMAND = wrapper
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = previous
  })

  const blocked = await runPublish(
    world,
    publicationDocument(world, prepared, [12], { remote: 'ssh://example.invalid/stacks.git' }),
  )

  assert.equal(blocked.status, 'blocked')
  const named = blocked.controls
    .filter((control) => control.blocking)
    .map((control) => `${control.control}=${control.value}`)
  assert.ok(
    named.some((entry) => entry.startsWith('GIT_SSH_COMMAND=') && entry.includes(wrapper)),
    `the ssh wrapper must be named as a control, got ${JSON.stringify(named)}; errors ${JSON.stringify(blocked.errors)}`,
  )
  assert.equal(
    existsSync(marker),
    false,
    `the ssh wrapper must not have been executed; status ${blocked.status} errors ${JSON.stringify(blocked.errors)} controls ${JSON.stringify(blocked.controls)}`,
  )
  assert.deepEqual(blocked.publication.attempts, [])
})

test('a custom transport helper is refused before discovery and never executed', async (t) => {
  const world = await createWorld('publish-ext-helper')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })

  // The helper is a real executable on PATH, and the repository genuinely permits the
  // transport, so the only thing stopping it is this helper refusing the URL by name.
  const marker = join(world.root, 'ext-ran.txt')
  const helper = join(world.root, 'bin', 'git-remote-recording')
  recordingWrapper(helper, marker)
  world.gitIn(join(world.root, 'run', 'storage.git'), 'config', 'protocol.ext.allow', 'always')

  const blocked = await runPublish(
    world,
    publicationDocument(world, prepared, [12], {
      remote: `ext::recording ${world.remote}`,
    }),
  )

  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.errors.map((error) => error.detail).join('; '), /remote-helper transport/)
  assert.equal(existsSync(marker), false, 'the ext helper must not have been executed')
  assert.deepEqual(blocked.publication.attempts, [])
})

test('a mandatory control in the caller environment stops preparation before it creates anything', async (t) => {
  const world = await createWorld('prepare-inherited-control')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const runDirectory = join(world.root, 'run')

  // Stripping routing variables is what makes a task directory a task directory, but
  // `GIT_CONFIG_*` carries policy. Dropping a mandatory one would commit under weaker
  // rules than the caller asked for and report nothing, so it has to stop the run instead.
  const previous = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  }
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
  process.env.GIT_CONFIG_VALUE_0 = 'true'
  t.after(() => {
    for (const [name, value] of [
      ['GIT_CONFIG_COUNT', previous.count],
      ['GIT_CONFIG_KEY_0', previous.key],
      ['GIT_CONFIG_VALUE_0', previous.value],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const result = await runPrepare(world, {
    runDirectory,
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.preparation, null)
  assert.ok(
    result.errors.some((error) => error.code === 'conflicting-environment-control'),
    `the inherited signing control must be reported, got ${JSON.stringify(result.errors)}`,
  )
  assert.equal(
    existsSync(join(runDirectory, 'storage.git')),
    false,
    'task-owned storage must not be created under a control this run cannot honour',
  )
  assert.equal(
    existsSync(join(runDirectory, 'workspaces')),
    false,
    'no task workspace may be created under a control this run cannot honour',
  )
})

test('a filesystem monitor is refused before the fingerprint runs git status', async (t) => {
  const world = await createWorld('prepare-fsmonitor')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })

  // A recording monitor that exits 0: a run that executed it would report itself prepared
  // and leave no trace that anything external ran, so only the marker's absence tells the
  // two apart. The repository-local control is set on the SOURCE and on the USER checkout,
  // because the fingerprint is computed in the user's own worktree.
  const marker = join(world.root, 'fsmonitor-ran')
  const monitor = join(world.root, 'monitor.sh')
  mkdirSync(join(world.root, 'bin'), { recursive: true })
  writeFileSync(monitor, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`)
  chmodSync(monitor, 0o755)
  world.gitIn(world.repo, 'config', 'core.fsmonitor', monitor)
  world.gitIn(world.remote, 'config', 'core.fsmonitor', monitor)
  writeFileSync(join(world.repo, 'untracked.txt'), 'the user has work in progress\n')

  const blocked = await runPrepare(world, {
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })

  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.ok, false)
  assert.ok(
    blocked.errors.some((error) => error.code === 'conflicting-environment-control'),
    `the filesystem monitor must be reported, got ${JSON.stringify(blocked.errors)}`,
  )
  assert.equal(existsSync(marker), false, 'the filesystem monitor must never have been executed')
  assert.equal(
    existsSync(join(world.root, 'run', 'storage.git')),
    false,
    'no task-owned storage is created under a control this run cannot honour',
  )
})

test('an operation in progress in a linked worktree is reported', async (t) => {
  const world = await createWorld('prepare-linked-worktree')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'shared.txt': 'ours\n' })
  const b = await seedBranch(world, BRANCHES[13], { 'shared.txt': 'theirs\n' })
  world.gitIn(world.repo, 'fetch', '--quiet', 'origin')

  // A linked worktree: `.git` is a FILE naming a directory under the common directory, so
  // every Git state file lives somewhere `join(path, '.git', ...)` never looks. A real
  // unfinished merge is started there and has to survive the run and be reported.
  const linked = join(world.root, 'linked-worktree')
  world.gitIn(world.repo, 'worktree', 'add', '--quiet', '--detach', linked, b)
  // A genuine conflicting merge, so MERGE_HEAD really exists in the linked worktree.
  // `git merge` exits non-zero on a conflict, which is the point here; the merge itself
  // is real and leaves MERGE_HEAD behind.
  world.tryGitIn(linked, 'merge', '--no-commit', a)
  const mergeHead = world.tryGitIn(linked, 'rev-parse', '--verify', 'MERGE_HEAD')
  assert.ok(mergeHead, 'the fixture must really leave a merge in progress')
  const marker = join(world.root, 'user-touched')
  const prepared = await runPrepare(world, {
    userWorkspace: linked,
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })

  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.errors))
  assert.equal(
    world.tryGitIn(linked, 'rev-parse', '--verify', 'MERGE_HEAD'),
    mergeHead,
    "the user's unfinished merge must survive the run untouched",
  )
  assert.equal(existsSync(marker), false)
  assert.deepEqual(
    prepared.userWorkspace?.operationsInProgress,
    ['MERGE_HEAD'],
    'an operation in progress in a linked worktree is a fact about the user, not an absence',
  )
})

test('two different binary files are not read as the same untracked content', async (t) => {
  const world = await createWorld('prepare-binary-untracked')
  t.after(() => world.cleanup())
  const a = await seedBranch(world, BRANCHES[12], { 'a.txt': 'a\n' })
  const prepared = await runPrepare(world, {
    userWorkspace: world.repo,
    runDirectory: join(world.root, 'run'),
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
  })
  const before = prepared.userWorkspace?.worktreeDigest
  assert.ok(before, 'the worktree digest is part of the report')

  // 0xFF and 0xFE are distinct bytes that both decode to the replacement character, so a
  // digest taken over decoded text reports these two files as identical content.
  writeFileSync(join(world.repo, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]))
  const first = await runPrepare(world, {
    userWorkspace: world.repo,
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
    runDirectory: join(world.root, 'run-2'),
  })
  const afterFirst = first.userWorkspace?.worktreeDigest
  assert.notEqual(afterFirst, before, 'new binary content must change the digest')

  writeFileSync(join(world.repo, 'blob.bin'), Buffer.from([0xfe, 0xff, 0x00, 0x80]))
  const second = await runPrepare(world, {
    userWorkspace: world.repo,
    order: [12],
    heads: { 12: `refs/heads/${BRANCHES[12]}` },
    originalHeads: { 12: a },
    runDirectory: join(world.root, 'run-3'),
  })
  assert.notEqual(
    second.userWorkspace?.worktreeDigest,
    afterFirst,
    'two different byte sequences must not read as the same content',
  )
})
