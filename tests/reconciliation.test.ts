import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { getSnapshot } from '../src/main/git'
import { createPullRequestStack } from '../src/main/native-stacks'
import {
  buildReconciliationReport,
  previewReconciliationRepair,
  reconcileStack,
  runReconciliationRepair,
} from '../src/main/reconciliation'
import { runStackAction } from '../src/main/stacks'
import { DirectGitHubTransport, setGitHubTransport } from '../src/main/github-transport'
import type {
  ReconciliationAncestry,
  ReconciliationMemberInput,
  ReconciliationStackInput,
  RepositorySnapshot,
} from '../src/shared/types'
import { createGitHubApiDouble } from './fixtures/github-api-double'
import {
  createGitHubHarness,
  type GitHubFixturePullRequest,
  type GitHubHarness,
} from './fixtures/github-harness'

const oid = (seed: string) => seed.repeat(40).slice(0, 40)

function ancestry(overrides: Partial<ReconciliationAncestry> = {}): ReconciliationAncestry {
  return {
    parentOid: oid('a'),
    mergeBase: oid('a'),
    parentContainsBranch: true,
    branchContainsParent: false,
    recordedParentTipValid: true,
    submittedContainsBranch: true,
    branchContainsSubmitted: false,
    remoteContainsBranch: true,
    branchContainsRemote: true,
    ...overrides,
  }
}

function member(
  branch: string,
  overrides: Partial<ReconciliationMemberInput> = {},
): ReconciliationMemberInput {
  return {
    branch,
    localOid: oid(branch[0]),
    remoteOid: oid(branch[0]),
    recordedParent: null,
    recordedParentTip: null,
    ancestry: ancestry(),
    pullRequest: null,
    adoptTargetOid: null,
    ...overrides,
  }
}

function pullRequest(
  head: string,
  base: string,
  overrides: Partial<NonNullable<ReconciliationMemberInput['pullRequest']>> = {},
) {
  return {
    number: 100 + head.length,
    head,
    base,
    headOid: oid(head[0]),
    state: 'OPEN' as const,
    stackNumber: 7,
    stackPosition: 1,
    stackSize: 2,
    stackBase: 'main',
    ...overrides,
  }
}

function stackInput(overrides: Partial<ReconciliationStackInput> = {}): ReconciliationStackInput {
  return {
    key: 'native:7',
    defaultBranch: 'main',
    submittedOrder: ['step-1', 'step-2'],
    submittedHeadOids: { 'step-1': oid('1'), 'step-2': oid('2') },
    submittedBase: 'main',
    stackNumber: 7,
    stackUrl: 'https://github.com/acme/widgets/stacks/7',
    submittedStatus: 'valid',
    members: [
      member('step-1', {
        recordedParent: 'main',
        pullRequest: pullRequest('step-1', 'main'),
      }),
      member('step-2', {
        recordedParent: 'step-1',
        pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
      }),
    ],
    ...overrides,
  }
}

test('reconcileStack reports matching when every authority agrees', () => {
  const stack = reconcileStack(stackInput())
  assert.equal(stack.state, 'matching')
  assert.equal(stack.blockers.length, 0)
  assert.deepEqual(stack.repairs, [])
  assert.deepEqual(
    stack.members.map((entry) => entry.position),
    [1, 2],
  )
  assert.equal(stack.members[1].expectedParent, 'step-1')
})

test('an unresolved authoritative parent blocks submitted repairs even when the local hint agrees', () => {
  for (const recordedParent of ['release', null]) {
    const stack = reconcileStack(
      stackInput({
        submittedBase: 'release',
        members: [
          member('step-1', {
            recordedParent,
            ancestry: ancestry({
              parentOid: null,
              mergeBase: null,
              parentContainsBranch: null,
              branchContainsParent: null,
            }),
            pullRequest: pullRequest('step-1', 'release', { stackBase: 'release' }),
          }),
          member('step-2', {
            recordedParent: 'step-1',
            pullRequest: pullRequest('step-2', 'step-1', {
              stackBase: 'release',
              stackPosition: 2,
            }),
          }),
        ],
      }),
    )
    assert.equal(stack.state, 'ambiguous')
    assert.match(stack.blockers.join(' '), /Submitted parent release for step-1 is unavailable/)
    assert.deepEqual(stack.repairs, [])
  }
})

test('an unfetched submitted head is an ambiguity blocker, not a matching stack', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          ancestry: ancestry({
            submittedContainsBranch: null,
            branchContainsSubmitted: null,
          }),
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'ambiguous')
  assert.match(stack.blockers.join(' '), /Submitted head .* for step-2 is unavailable locally/)
  assert.deepEqual(stack.repairs, [])
})

test('reconcileStack reports local-only when nothing was ever submitted', () => {
  const stack = reconcileStack(
    stackInput({
      key: 'local:step-1',
      submittedOrder: [],
      submittedHeadOids: {},
      submittedBase: null,
      stackNumber: null,
      stackUrl: null,
      members: [
        member('step-1', { recordedParent: 'main' }),
        member('step-2', { recordedParent: 'step-1' }),
      ],
    }),
  )
  assert.equal(stack.state, 'local-only')
  assert.deepEqual(stack.repairs, [])
})

test('a cyclic local-only ancestry chain blocks rather than claiming a valid local stack', () => {
  const stack = reconcileStack(
    stackInput({
      key: 'local:step-1',
      submittedOrder: [],
      submittedHeadOids: {},
      submittedBase: null,
      stackNumber: null,
      stackUrl: null,
      members: [
        member('step-1', { recordedParent: 'step-2' }),
        member('step-2', { recordedParent: 'step-1' }),
      ],
    }),
  )
  assert.equal(stack.state, 'ambiguous')
  assert.match(stack.blockers.join(' '), /Recorded parents form a cycle/)
  assert.deepEqual(stack.repairs, [])
})

test('reconcileStack reports remote-native when the submitted order is the only record', () => {
  const withoutHints = reconcileStack(
    stackInput({
      members: [
        member('step-1', {
          recordedParent: null,
          pullRequest: pullRequest('step-1', 'main'),
        }),
        member('step-2', {
          recordedParent: null,
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(withoutHints.state, 'remote-native')
  const kinds = withoutHints.repairs.map((repair) => repair.kind)
  assert.deepEqual([...new Set(kinds)], ['adopt-remote-order'])
  const adopt = withoutHints.repairs.find((repair) => repair.branch === 'step-2')
  assert.equal(adopt?.summary, 'Record step-2 under step-1')
  assert.equal(adopt?.requiresConfirmation, false)
})

test('missing local metadata does not mask a deleted submitted branch', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: null, pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          localOid: null,
          remoteOid: oid('2'),
          adoptTargetOid: oid('2'),
          recordedParent: null,
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'missing-branch')
  assert.ok(
    stack.repairs.some(
      (repair) => repair.kind === 'restore-missing-branch' && repair.branch === 'step-2',
    ),
  )
})

test('missing local metadata does not mask an externally retargeted submitted PR', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: null, pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: null,
          pullRequest: pullRequest('step-2', 'release', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'retargeted')
  assert.ok(stack.repairs.some((repair) => repair.kind === 'retarget-pull-request'))
})

test('reconcileStack reports reordered when a local hint contradicts the submitted position', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'main',
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'reordered')
  const member1 = stack.members.find((entry) => entry.branch === 'step-2')
  assert.equal(member1?.state, 'reordered')
  assert.match(member1?.detail ?? '', /bases it on step-1/)
  assert.deepEqual(
    stack.repairs.map((repair) => `${repair.kind}:${repair.branch}`),
    ['adopt-remote-order:step-2'],
  )
})

test('reconcileStack reports retargeted and offers a confirmed pull-request repair', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          pullRequest: pullRequest('step-2', 'release', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'retargeted')
  const retarget = stack.repairs.find((repair) => repair.kind === 'retarget-pull-request')
  assert.ok(retarget)
  assert.equal(retarget.requiresConfirmation, true)
  assert.equal(retarget.evidence?.previousBase, 'release')
  assert.match(retarget.summary, /Retarget #\d+ to step-1/)
})

test('reconcileStack reports merged and re-roots children on the merged member base', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', {
          recordedParent: 'main',
          pullRequest: pullRequest('step-1', 'main', { state: 'MERGED' }),
        }),
        member('step-2', {
          recordedParent: 'step-1',
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'merged')
  const child = stack.members.find((entry) => entry.branch === 'step-2')
  assert.equal(child?.expectedParent, 'main')
  const adopt = stack.repairs.find(
    (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'step-2',
  )
  assert.equal(adopt?.summary, 'Record step-2 under main')
})

test('reconcileStack reports missing-branch and only offers a restorable branch', () => {
  const restorable = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          localOid: null,
          remoteOid: oid('2'),
          adoptTargetOid: oid('2'),
          recordedParent: 'step-1',
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(restorable.state, 'missing-branch')
  const restore = restorable.repairs.find((repair) => repair.kind === 'restore-missing-branch')
  assert.ok(restore)
  assert.equal(restore.requiresConfirmation, false)

  const gone = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          localOid: null,
          remoteOid: null,
          recordedParent: 'step-1',
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(gone.state, 'missing-branch')
  assert.deepEqual(gone.repairs, [])
  assert.match(
    gone.members.find((entry) => entry.branch === 'step-2')?.detail ?? '',
    /neither a local branch nor an origin tracking ref/,
  )
})

test('reconcileStack reports diverged for unrelated history and offers a backed-up move', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          recordedParentTip: oid('f'),
          ancestry: ancestry({
            mergeBase: null,
            parentContainsBranch: false,
            branchContainsParent: false,
            submittedContainsBranch: false,
            branchContainsSubmitted: false,
            recordedParentTipValid: false,
          }),
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
          adoptTargetOid: oid('2'),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'diverged')
  const move = stack.repairs.find((repair) => repair.kind === 'adopt-remote-tip')
  assert.ok(move)
  assert.equal(move.requiresConfirmation, true)
  assert.match(move.detail, /refs\/git-stacks\/reconciliation/)
})

test('reconcileStack reports stale when origin is strictly ahead of the local branch', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          ancestry: ancestry({ remoteContainsBranch: false, branchContainsRemote: true }),
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'stale')
  assert.match(
    stack.members.find((entry) => entry.branch === 'step-2')?.detail ?? '',
    /origin\/step-2 is at .*ahead of the local tip/,
  )
})

test('the submitted head, not an older origin tracking ref, determines local stale state', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          ancestry: ancestry({
            submittedContainsBranch: false,
            branchContainsSubmitted: true,
          }),
          adoptTargetOid: oid('2'),
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'stale')
  assert.match(stack.members[1].detail, /GitHub's submitted head .* is ahead of local step-2/)
  const move = stack.repairs.find((repair) => repair.kind === 'adopt-remote-tip')
  assert.equal(move?.branch, 'step-2')
  assert.equal(move.requiresConfirmation, true)
  assert.equal(move.evidence?.previousOid, oid('s'))
})

test('a locally ahead branch is not mislabeled as an origin-ahead stale branch', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          ancestry: ancestry({ remoteContainsBranch: true, branchContainsRemote: false }),
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'matching')
})

test('reconcileStack reports stale when the authoritative parent moved ahead', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          ancestry: ancestry({
            parentContainsBranch: false,
            branchContainsParent: true,
            mergeBase: oid('1'),
          }),
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'stale')
  assert.match(
    stack.members.find((entry) => entry.branch === 'step-2')?.detail ?? '',
    /commits this branch does not contain/,
  )
})

test('reconcileStack reports stale and offers hint repair when the recorded boundary is gone', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          recordedParentTip: oid('e'),
          ancestry: ancestry({ recordedParentTipValid: false }),
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'stale')
  const clear = stack.repairs.find((repair) => repair.kind === 'clear-stale-hint')
  assert.ok(clear)
  assert.equal(clear.evidence?.previousParent, 'step-1')
  assert.equal(clear.evidence?.previousParentTip, oid('e'))
})

test('reconcileStack reports externally-unstacked for a member GitHub no longer registers', () => {
  const stack = reconcileStack(
    stackInput({
      submittedOrder: ['step-1'],
      submittedHeadOids: { 'step-1': oid('1') },
      members: [
        member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          pullRequest: pullRequest('step-2', 'step-1', { stackNumber: null, stackPosition: null }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'externally-unstacked')
  const detached = stack.members.find((entry) => entry.branch === 'step-2')
  assert.equal(detached?.state, 'externally-unstacked')
  assert.match(detached?.detail ?? '', /belongs to no GitHub stack/)
  const clear = stack.repairs.find((repair) => repair.kind === 'clear-stale-hint')
  assert.equal(clear?.branch, 'step-2')
})

test('a moved stack keeps its valid child hint and repairs a stale parent only in the destination', () => {
  const movedMembers = [
    member('step-1', { recordedParent: 'main', pullRequest: pullRequest('step-1', 'main') }),
    member('step-2', {
      recordedParent: 'step-1',
      pullRequest: pullRequest('step-2', 'main', {
        number: 102,
        stackNumber: 8,
        stackPosition: 1,
      }),
    }),
    member('step-3', {
      recordedParent: 'step-2',
      recordedParentTip: oid('2'),
      pullRequest: pullRequest('step-3', 'step-2', {
        number: 103,
        stackNumber: 8,
        stackPosition: 2,
      }),
    }),
  ]
  const source = reconcileStack(
    stackInput({
      submittedOrder: ['step-1'],
      submittedHeadOids: { 'step-1': oid('1') },
      members: movedMembers,
    }),
  )
  assert.equal(source.state, 'externally-unstacked')
  assert.deepEqual(
    source.repairs.filter((repair) => repair.kind === 'clear-stale-hint'),
    [],
  )

  const destination = reconcileStack(
    stackInput({
      key: 'native:8',
      stackNumber: 8,
      submittedOrder: ['step-2', 'step-3'],
      submittedHeadOids: { 'step-2': oid('2'), 'step-3': oid('3') },
      members: movedMembers.slice(1),
    }),
  )
  assert.deepEqual(
    destination.repairs.map((repair) => `${repair.kind}:${repair.branch}`),
    ['adopt-remote-order:step-2'],
  )
  assert.equal(destination.members.find((entry) => entry.branch === 'step-3')?.state, 'matching')
})

test('reconcileStack blocks on a duplicated submitted head instead of guessing', () => {
  const stack = reconcileStack(stackInput({ submittedOrder: ['step-1', 'step-1', 'step-2'] }))
  assert.equal(stack.state, 'ambiguous')
  assert.match(stack.blockers.join(' '), /submitted step-1 more than once/)
  assert.deepEqual(stack.repairs, [])
})

test('reconcileStack blocks when GitHub reports a broken submitted chain', () => {
  const stack = reconcileStack(stackInput({ submittedStatus: 'invalid-chain' }))
  assert.equal(stack.state, 'ambiguous')
  assert.match(stack.blockers.join(' '), /broken head\/base chain/)
})

test('reconcileStack blocks on a recorded parent cycle', () => {
  const stack = reconcileStack(
    stackInput({
      members: [
        member('step-1', { recordedParent: 'step-2', pullRequest: pullRequest('step-1', 'main') }),
        member('step-2', {
          recordedParent: 'step-1',
          pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
        }),
      ],
    }),
  )
  assert.equal(stack.state, 'ambiguous')
  assert.match(stack.blockers.join(' '), /cycle through step-1/)
})

test('reconcileStack never offers a repair for a state it cannot resolve', () => {
  for (const state of ['matching', 'local-only', 'ambiguous'] as const) {
    const stack = reconcileStack(
      stackInput({
        submittedStatus: state === 'ambiguous' ? 'duplicate-pr' : 'valid',
        submittedOrder: state === 'local-only' ? [] : ['step-1', 'step-2'],
        members:
          state === 'local-only'
            ? [member('step-1', { recordedParent: 'main' })]
            : [
                member('step-1', {
                  recordedParent: 'main',
                  pullRequest: pullRequest('step-1', 'main'),
                }),
                member('step-2', {
                  recordedParent: 'step-1',
                  pullRequest: pullRequest('step-2', 'step-1', { stackPosition: 2 }),
                }),
              ],
      }),
    )
    assert.deepEqual(stack.repairs, [], `state ${state} must not offer repairs`)
  }
})

// ---------------------------------------------------------------------------
// Repository-level reconciliation against real Git and the GitHub double
// ---------------------------------------------------------------------------

function git(harness: GitHubHarness, args: string[]): string {
  return execFileSync(harness.env.GIT_STACKS_REAL_GIT || 'git', ['-C', harness.repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...harness.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function optionalGit(harness: GitHubHarness, args: string[]): string | null {
  try {
    return git(harness, args)
  } catch {
    return null
  }
}

function bareGit(harness: GitHubHarness, args: string[]): string {
  return execFileSync(
    harness.env.GIT_STACKS_REAL_GIT || 'git',
    ['--git-dir', harness.bare, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...harness.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()
}

async function withHarness(run: (harness: GitHubHarness) => Promise<void>): Promise<void> {
  const harness = await createGitHubHarness()
  const original = { ...process.env }
  setGitHubTransport(
    new DirectGitHubTransport({ token: 'fixture-token', fetch: createGitHubApiDouble() }),
  )
  try {
    for (const [key, value] of Object.entries(harness.env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await run(harness)
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key]
    }
    Object.assign(process.env, original)
    await harness.close()
  }
}

function pullRequestFixture(
  number: number,
  head: string,
  base: string,
  overrides: Partial<GitHubFixturePullRequest> = {},
): GitHubFixturePullRequest {
  return {
    number,
    title: `${head} pull request`,
    body: '',
    base,
    head,
    headRepository: 'acme/widgets',
    draft: false,
    state: 'OPEN',
    checks: 'none',
    reviewDecision: null,
    mergeState: 'CLEAN',
    url: `https://github.com/acme/widgets/pull/${number}`,
    headOid: null,
    mergeOid: null,
    mergedAt: null,
    ...overrides,
  }
}

/** Three chained branches, pushed to the bare remote and mirrored locally. */
async function setupStack(harness: GitHubHarness) {
  const heads: string[] = []
  const base = 'main'
  for (const [index, name] of ['feature/step-1', 'feature/step-2', 'feature/step-3'].entries()) {
    git(harness, ['checkout', '-b', name, index === 0 ? base : `feature/step-${index}`])
    git(harness, ['commit', '--allow-empty', '-m', `step ${index + 1}`])
    const sha = git(harness, ['rev-parse', 'HEAD'])
    git(harness, ['push', harness.bare, `${name}:refs/heads/${name}`])
    git(harness, ['update-ref', `refs/remotes/origin/${name}`, sha])
    heads.push(sha)
  }
  const state = await harness.readState()
  state.prs = [
    pullRequestFixture(101, 'feature/step-1', 'main', { headOid: heads[0] }),
    pullRequestFixture(102, 'feature/step-2', 'feature/step-1', { headOid: heads[1] }),
    pullRequestFixture(103, 'feature/step-3', 'feature/step-2', { headOid: heads[2] }),
  ]
  state.nextNumber = 104
  state.stacks = []
  await harness.writeState(state)
  return heads
}

function recordParent(harness: GitHubHarness, branch: string, parent: string, tip: string) {
  git(harness, ['config', '--local', `branch.${branch}.parent`, parent])
  git(harness, ['config', '--local', `branch.${branch}.parentTip`, tip])
}

function recordedParent(harness: GitHubHarness, branch: string): string | null {
  return optionalGit(harness, ['config', '--local', '--get', `branch.${branch}.parent`])
}

function stackFor(snapshot: RepositorySnapshot, key: string) {
  const stack = snapshot.reconciliation?.stacks.find((entry) => entry.key === key)
  assert.ok(stack, `expected reconciliation stack ${key}`)
  return stack
}

test('an unfetched GitHub stack head blocks repairs in a real repository report', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const unavailable = bareGit(harness, [
      'commit-tree',
      `${heads[1]}^{tree}`,
      '-p',
      heads[1],
      '-m',
      'unfetched remote head',
    ])
    bareGit(harness, ['update-ref', 'refs/heads/feature/step-2', unavailable, heads[1]])
    assert.equal(optionalGit(harness, ['cat-file', '-t', unavailable]), null)

    const snapshot = await getSnapshot(harness.repo)
    assert.equal(
      snapshot.nativeStacks?.find((entry) => entry.number === created.number)?.pullRequests[1]
        .headSha,
      unavailable,
    )
    const stack = stackFor(snapshot, `native:${created.number}`)
    assert.equal(stack.state, 'ambiguous')
    assert.match(
      stack.blockers.join(' '),
      /Submitted head .* for feature\/step-2 is unavailable locally/,
    )
    assert.deepEqual(stack.repairs, [])
  })
})

test('submitted order is reconstructed from GitHub after local metadata is deleted', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`

    // No local parent hints at all: GitHub is the only record of the order.
    const first = await getSnapshot(harness.repo)
    const remote = stackFor(first, key)
    assert.equal(remote.state, 'remote-native')
    assert.deepEqual(remote.submittedOrder, ['feature/step-1', 'feature/step-2', 'feature/step-3'])

    const preview = await previewReconciliationRepair(harness.repo, first, key)
    assert.equal(preview.state, 'remote-native')
    assert.deepEqual(preview.submittedOrder, ['feature/step-1', 'feature/step-2', 'feature/step-3'])
    assert.deepEqual(
      preview.repairs.map((repair) => repair.branch),
      ['feature/step-1', 'feature/step-2', 'feature/step-3'],
    )

    const result = await runStackAction(harness.repo, {
      type: 'reconcileRepair',
      token: preview.token,
      ids: preview.repairs.map((repair) => repair.id),
      confirmRewrites: false,
    })
    assert.match(result.message, /Reconciled remote-native order/)
    assert.equal(recordedParent(harness, 'feature/step-2'), 'feature/step-1')
    assert.equal(recordedParent(harness, 'feature/step-3'), 'feature/step-2')
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-2.parentTip']),
      heads[0],
    )
    for (const name of ['feature/step-1', 'feature/step-2', 'feature/step-3']) {
      assert.equal(
        git(harness, ['rev-parse', name]),
        heads[['feature/step-1', 'feature/step-2', 'feature/step-3'].indexOf(name)],
      )
    }

    const after = await getSnapshot(harness.repo)
    assert.equal(stackFor(after, key).state, 'matching')
    assert.equal(after.reconciliation?.evidence?.applied.length, 3)
    assert.equal(after.reconciliation?.evidence?.evidence.length, 3)
  })
})

test('selecting one of several identical repair kinds changes only that branch and retains earlier recovery evidence', async () => {
  await withHarness(async (harness) => {
    await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const second = preview.repairs.find((repair) => repair.branch === 'feature/step-2')
    assert.ok(second)
    await runStackAction(harness.repo, {
      type: 'reconcileRepair',
      token: preview.token,
      ids: [second.id],
      confirmRewrites: false,
    })
    assert.equal(recordedParent(harness, 'feature/step-2'), 'feature/step-1')
    assert.equal(recordedParent(harness, 'feature/step-1'), null)
    assert.equal(recordedParent(harness, 'feature/step-3'), null)

    const next = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const third = next.repairs.find((repair) => repair.branch === 'feature/step-3')
    assert.ok(third)
    await runStackAction(harness.repo, {
      type: 'reconcileRepair',
      token: next.token,
      ids: [third.id],
      confirmRewrites: false,
    })
    const journal = JSON.parse(
      readFileSync(join(harness.repo, '.git', 'git-stacks-reconciled.json'), 'utf8'),
    ) as { records: { id: string; evidence: { branch: string }[] }[] }
    assert.deepEqual(
      journal.records.map((record) => record.evidence[0].branch),
      ['feature/step-3', 'feature/step-2'],
    )
    assert.notEqual(journal.records[0].id, journal.records[1].id)
  })
})

test('an externally retargeted pull request is retargeted back only through a preview', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    const before = await getSnapshot(harness.repo)
    await previewReconciliationRepair(harness.repo, before, key)
    recordParent(harness, 'feature/step-1', 'main', heads[0])
    recordParent(harness, 'feature/step-2', 'feature/step-1', heads[0])
    recordParent(harness, 'feature/step-3', 'feature/step-2', heads[1])

    // Someone edits the base on github.com.
    const state = await harness.readState()
    state.prs[1].base = 'main'
    await harness.writeState(state)

    const retargeted = stackFor(await getSnapshot(harness.repo), key)
    assert.equal(retargeted.state, 'retargeted')
    assert.match(
      retargeted.members.find((entry) => entry.branch === 'feature/step-2')?.detail ?? '',
      /targets main/,
    )

    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const retarget = preview.repairs.find((repair) => repair.kind === 'retarget-pull-request')
    assert.ok(retarget)
    assert.equal(retarget.requiresConfirmation, true)
    assert.equal(retarget.evidence?.previousBase, 'main')

    await assert.rejects(
      runReconciliationRepair(harness.repo, {
        token: preview.token,
        ids: [retarget.id],
        confirmRewrites: false,
      }),
      /Confirm branch and pull-request rewrites/,
    )

    const result = await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: [retarget.id],
      confirmRewrites: true,
    })
    assert.match(result.message, /Retarget #102/)
    const patched = (await harness.readState()).prs[1]
    assert.equal(patched.base, 'feature/step-1')
    assert.equal(stackFor(await getSnapshot(harness.repo), key).state, 'matching')
  })
})

test('a concurrent edit between preview and execute is reported instead of overwritten', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    recordParent(harness, 'feature/step-2', 'main', heads[0])

    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    assert.ok(preview.repairs.some((repair) => repair.kind === 'adopt-remote-order'))

    // Someone edits the submitted base after the preview was captured.
    const state = await harness.readState()
    state.prs[0].base = 'release'
    await harness.writeState(state)

    await assert.rejects(
      runReconciliationRepair(harness.repo, {
        token: preview.token,
        ids: preview.repairs
          .filter((repair) => repair.kind === 'adopt-remote-order')
          .map((repair) => repair.id),
        confirmRewrites: false,
      }),
      /Reconciliation repair is stale/,
    )
    assert.equal(recordedParent(harness, 'feature/step-2'), 'main')
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-2.parentTip']),
      heads[0],
    )
  })
})

test('a parent hint changed during GitHub revalidation is not overwritten by an adopted order', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    recordParent(harness, 'feature/step-2', 'main', heads[0])
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const adopt = preview.repairs.find(
      (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-2',
    )
    assert.ok(adopt)

    const fetchFromFixture = createGitHubApiDouble()
    let injected = false
    setGitHubTransport(
      new DirectGitHubTransport({
        token: 'fixture-token',
        fetch: async (input, init) => {
          if (!injected) {
            injected = true
            recordParent(harness, 'feature/step-2', 'feature/step-3', heads[1])
          }
          return fetchFromFixture(input, init)
        },
      }),
    )
    await assert.rejects(
      runReconciliationRepair(harness.repo, {
        token: preview.token,
        ids: [adopt.id],
        confirmRewrites: false,
      }),
      /Reconciliation repair is stale: feature\/step-2 changed/,
    )
    assert.equal(injected, true)
    assert.equal(recordedParent(harness, 'feature/step-2'), 'feature/step-3')
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-2.parentTip']),
      heads[1],
    )
  })
})

test('a preview token is single use and rejects repairs it never offered', async () => {
  await withHarness(async (harness) => {
    await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    assert.ok(preview.repairs.length > 0)

    await assert.rejects(
      runReconciliationRepair(harness.repo, {
        token: preview.token,
        ids: [preview.repairs[0].id, 'not-an-offered-repair'],
        confirmRewrites: true,
      }),
      /not offered for this stack/,
    )
    await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: preview.repairs.map((repair) => repair.id),
      confirmRewrites: false,
    })
    await assert.rejects(
      runReconciliationRepair(harness.repo, {
        token: preview.token,
        ids: preview.repairs.map((repair) => repair.id),
        confirmRewrites: false,
      }),
      /missing or expired/,
    )
  })
})

test('a deleted local branch is reported and restored without moving any other ref', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    recordParent(harness, 'feature/step-1', 'main', heads[0])
    recordParent(harness, 'feature/step-2', 'feature/step-1', heads[0])
    git(harness, ['update-ref', '-d', 'refs/heads/feature/step-3'])
    git(harness, ['checkout', '--detach', heads[0]])

    const missing = stackFor(await getSnapshot(harness.repo), key)
    assert.equal(missing.state, 'missing-branch')
    assert.equal(
      missing.members.find((entry) => entry.branch === 'feature/step-3')?.state,
      'missing-branch',
    )

    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const restore = preview.repairs.find((repair) => repair.kind === 'restore-missing-branch')
    assert.ok(restore)
    assert.equal(restore.requiresConfirmation, false)

    await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: [restore.id],
      confirmRewrites: false,
    })
    assert.equal(git(harness, ['rev-parse', 'feature/step-3']), heads[2])
    assert.equal(git(harness, ['rev-parse', 'feature/step-1']), heads[0])
  })
})

test('an externally unstacked pull request is detected after GitHub drops the member', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    recordParent(harness, 'feature/step-1', 'main', heads[0])
    recordParent(harness, 'feature/step-2', 'feature/step-1', heads[0])
    recordParent(harness, 'feature/step-3', 'feature/step-2', heads[1])

    const state = await harness.readState()
    state.stacks = (state.stacks ?? []).map((entry) => ({
      ...entry,
      pull_requests: entry.pull_requests.slice(0, 2),
    }))
    await harness.writeState(state)

    const unstacked = stackFor(await getSnapshot(harness.repo), key)
    assert.equal(unstacked.state, 'externally-unstacked')
    const detached = unstacked.members.find((entry) => entry.branch === 'feature/step-3')
    assert.equal(detached?.state, 'externally-unstacked')
    assert.match(detached?.detail ?? '', /#103 is no longer registered/)

    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const clear = preview.repairs.find(
      (repair) => repair.kind === 'clear-stale-hint' && repair.branch === 'feature/step-3',
    )
    assert.ok(clear)
    assert.equal(clear.evidence?.previousParent, 'feature/step-2')

    await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: [clear.id],
      confirmRewrites: false,
    })
    assert.equal(recordedParent(harness, 'feature/step-3'), null)
    const evidence = (await getSnapshot(harness.repo)).reconciliation?.evidence
    assert.equal(evidence?.evidence[0]?.previousParent, 'feature/step-2')
    assert.equal(evidence?.evidence[0]?.previousParentTip, heads[1])
  })
})

test('external unstacking retains every descendant of the submitted branch in the native report', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    recordParent(harness, 'feature/step-1', 'main', heads[0])
    recordParent(harness, 'feature/step-2', 'feature/step-1', heads[0])
    recordParent(harness, 'feature/step-3', 'feature/step-2', heads[1])
    const state = await harness.readState()
    state.stacks = (state.stacks ?? []).map((entry) => ({
      ...entry,
      pull_requests: entry.pull_requests.slice(0, 1),
    }))
    await harness.writeState(state)

    const snapshot = await getSnapshot(harness.repo)
    const unstacked = stackFor(snapshot, key)
    assert.equal(unstacked.state, 'externally-unstacked')
    for (const branch of ['feature/step-2', 'feature/step-3']) {
      const detached = unstacked.members.find((entry) => entry.branch === branch)
      assert.equal(detached?.state, 'externally-unstacked')
      assert.ok(
        unstacked.repairs.some(
          (repair) => repair.branch === branch && repair.kind === 'clear-stale-hint',
        ),
      )
    }
  })
})

test('a merged member keeps its identity even without local pull-request tracking', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    recordParent(harness, 'feature/step-1', 'main', heads[0])
    recordParent(harness, 'feature/step-2', 'feature/step-1', heads[0])
    recordParent(harness, 'feature/step-3', 'feature/step-2', heads[1])

    const state = await harness.readState()
    state.prs[0].state = 'MERGED'
    state.prs[0].mergedAt = new Date().toISOString()
    state.prs = state.prs.slice(1)
    state.stacks = (state.stacks ?? []).map((entry) => ({
      ...entry,
      pull_requests: entry.pull_requests.map((pr) =>
        pr.number === 101
          ? { ...pr, state: 'closed' as const, merged_at: '2026-01-01T00:00:00Z' }
          : pr,
      ),
    }))
    await harness.writeState(state)

    const merged = stackFor(await getSnapshot(harness.repo), key)
    assert.equal(merged.state, 'merged')
    const bottom = merged.members.find((entry) => entry.branch === 'feature/step-1')
    assert.equal(bottom?.pullRequest, 101)
    assert.match(bottom?.detail ?? '', /#101 is merged/)
    const child = merged.members.find((entry) => entry.branch === 'feature/step-2')
    assert.equal(child?.expectedParent, 'main')
    assert.deepEqual(
      merged.repairs.map((repair) => `${repair.kind}:${repair.branch}`),
      ['adopt-remote-order:feature/step-2'],
    )
  })
})

test('adopting a squash-merged parent keeps the merged head out of child replay', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    recordParent(harness, 'feature/step-2', 'feature/step-1', heads[0])
    const previousMain = git(harness, ['rev-parse', 'main'])
    const squash = git(harness, [
      'commit-tree',
      `${previousMain}^{tree}`,
      '-p',
      previousMain,
      '-m',
      'squash first PR into main',
    ])
    git(harness, ['update-ref', 'refs/heads/main', squash, previousMain])
    git(harness, ['update-ref', 'refs/remotes/origin/main', squash, previousMain])
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])
    assert.equal(git(harness, ['merge-base', 'main', 'feature/step-2']), previousMain)
    const state = await harness.readState()
    state.prs[0].state = 'MERGED'
    state.prs[0].mergeOid = squash
    state.prs[0].mergedAt = new Date().toISOString()
    state.stacks = (state.stacks ?? []).map((entry) => ({
      ...entry,
      pull_requests: entry.pull_requests.map((pr) =>
        pr.number === 101
          ? { ...pr, state: 'closed' as const, merged_at: '2026-01-01T00:00:00Z' }
          : pr,
      ),
    }))
    await harness.writeState(state)

    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      `native:${created.number}`,
    )
    const adopt = preview.repairs.find(
      (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-2',
    )
    assert.ok(adopt)
    state.prs[0].mergeOid = previousMain
    await harness.writeState(state)
    await assert.rejects(
      runReconciliationRepair(harness.repo, {
        token: preview.token,
        ids: [adopt.id],
        confirmRewrites: false,
      }),
      /Reconciliation repair is stale: pull request #101 changed/,
    )
    assert.equal(recordedParent(harness, 'feature/step-2'), 'feature/step-1')
    state.prs[0].mergeOid = squash
    await harness.writeState(state)
    await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: [adopt.id],
      confirmRewrites: false,
    })
    assert.equal(recordedParent(harness, 'feature/step-2'), 'main')
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-2.parentTip']),
      heads[0],
    )
    assert.equal(git(harness, ['rev-list', '--count', 'feature/step-1..feature/step-2']), '1')

    // Reconstructing the same native chain without app-local metadata must not
    // replace the now-unknown replay boundary with merge-base(main, B).
    git(harness, ['config', '--local', '--unset-all', 'branch.feature/step-2.parent'])
    git(harness, ['config', '--local', '--unset-all', 'branch.feature/step-2.parentTip'])
    const missingHint = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      `native:${created.number}`,
    )
    assert.equal(
      missingHint.repairs.find(
        (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-2',
      ),
      undefined,
    )
    assert.equal(recordedParent(harness, 'feature/step-2'), null)
  })
})

test('merged parent advancing past its submitted head cannot discard unmerged child ancestry', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    git(harness, ['checkout', 'feature/step-2'])
    writeFileSync(join(harness.repo, 'unmerged-work.txt'), 'unmerged parent work\n')
    git(harness, ['add', 'unmerged-work.txt'])
    git(harness, ['commit', '-m', 'parent advanced after squash submission'])
    const unmergedTip = git(harness, ['rev-parse', 'HEAD'])
    git(harness, ['branch', '-f', 'feature/step-1', unmergedTip])
    git(harness, ['commit', '--allow-empty', '-m', 'child after advanced parent'])
    const childTip = git(harness, ['rev-parse', 'HEAD'])
    git(harness, ['push', harness.bare, 'feature/step-2:refs/heads/feature/step-2'])
    git(harness, ['update-ref', 'refs/remotes/origin/feature/step-2', childTip, heads[1]])
    recordParent(harness, 'feature/step-2', 'feature/step-1', unmergedTip)
    const previousMain = git(harness, ['rev-parse', 'main'])
    const squash = git(harness, [
      'commit-tree',
      `${previousMain}^{tree}`,
      '-p',
      previousMain,
      '-m',
      'squash submitted parent head',
    ])
    git(harness, ['update-ref', 'refs/heads/main', squash, previousMain])
    git(harness, ['update-ref', 'refs/remotes/origin/main', squash, previousMain])
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])
    const state = await harness.readState()
    state.prs[0].state = 'MERGED'
    state.prs[0].mergeOid = squash
    state.prs[0].mergedAt = new Date().toISOString()
    state.prs[1].headOid = childTip
    state.stacks = (state.stacks ?? []).map((entry) => ({
      ...entry,
      pull_requests: entry.pull_requests.map((pr) =>
        pr.number === 101
          ? { ...pr, state: 'closed' as const, merged_at: '2026-01-01T00:00:00Z' }
          : pr,
      ),
    }))
    await harness.writeState(state)

    assert.equal(git(harness, ['show', `${childTip}:unmerged-work.txt`]), 'unmerged parent work')
    assert.equal(optionalGit(harness, ['show', `${squash}:unmerged-work.txt`]), null)
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      `native:${created.number}`,
    )
    assert.equal(
      preview.repairs.find(
        (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-2',
      ),
      undefined,
    )
    assert.equal(recordedParent(harness, 'feature/step-2'), 'feature/step-1')
  })
})

test('multiple squash-merged predecessors require the immediately submitted head as replay boundary', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    recordParent(harness, 'feature/step-3', 'feature/step-1', heads[0])
    const previousMain = git(harness, ['rev-parse', 'main'])
    const mergedA = git(harness, [
      'commit-tree',
      `${previousMain}^{tree}`,
      '-p',
      previousMain,
      '-m',
      'squash A',
    ])
    const mergedB = git(harness, [
      'commit-tree',
      `${previousMain}^{tree}`,
      '-p',
      mergedA,
      '-m',
      'squash B',
    ])
    git(harness, ['update-ref', 'refs/heads/main', mergedB, previousMain])
    git(harness, ['update-ref', 'refs/remotes/origin/main', mergedB, previousMain])
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])
    const state = await harness.readState()
    for (const [index, mergeOid] of [mergedA, mergedB].entries()) {
      state.prs[index].state = 'MERGED'
      state.prs[index].mergeOid = mergeOid
      state.prs[index].mergedAt = new Date().toISOString()
    }
    state.stacks = (state.stacks ?? []).map((entry) => ({
      ...entry,
      pull_requests: entry.pull_requests.map((pr) =>
        pr.number <= 102
          ? { ...pr, state: 'closed' as const, merged_at: '2026-01-01T00:00:00Z' }
          : pr,
      ),
    }))
    await harness.writeState(state)

    const key = `native:${created.number}`
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    assert.equal(
      preview.repairs.find(
        (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-3',
      ),
      undefined,
    )
    recordParent(harness, 'feature/step-3', 'feature/step-2', heads[1])
    const proven = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const adopt = proven.repairs.find(
      (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-3',
    )
    assert.ok(adopt)
    await runReconciliationRepair(harness.repo, {
      token: proven.token,
      ids: [adopt.id],
      confirmRewrites: false,
    })
    assert.equal(recordedParent(harness, 'feature/step-3'), 'main')
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-3.parentTip']),
      heads[1],
    )
    assert.equal(git(harness, ['rev-list', '--count', 'feature/step-2..feature/step-3']), '1')
  })
})

test('a selected order repair cannot create a parent cycle unless its dependent repair is selected', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const main = git(harness, ['rev-parse', 'main'])
    recordParent(harness, 'feature/step-1', 'main', main)
    recordParent(harness, 'feature/step-2', 'feature/step-1', heads[0])
    recordParent(harness, 'feature/step-3', 'feature/step-2', heads[1])
    const state = await harness.readState()
    state.prs[0].base = 'feature/step-2'
    state.prs[1].base = 'main'
    state.prs[2].base = 'feature/step-1'
    await harness.writeState(state)
    const created = await createPullRequestStack('acme', 'widgets', [102, 101, 103])
    const key = `native:${created.number}`
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const first = preview.repairs.find(
      (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-1',
    )
    const second = preview.repairs.find(
      (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-2',
    )
    assert.ok(first)
    assert.ok(second)
    await assert.rejects(
      runReconciliationRepair(harness.repo, {
        token: preview.token,
        ids: [first.id],
        confirmRewrites: false,
      }),
      /Selected repairs would create a local parent cycle/,
    )
    assert.equal(recordedParent(harness, 'feature/step-1'), 'main')
    assert.equal(recordedParent(harness, 'feature/step-2'), 'feature/step-1')
    await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: [first.id, second.id],
      confirmRewrites: false,
    })
    assert.equal(recordedParent(harness, 'feature/step-1'), 'feature/step-2')
    assert.equal(recordedParent(harness, 'feature/step-2'), 'main')
    assert.notEqual(stackFor(await getSnapshot(harness.repo), key).state, 'ambiguous')
  })
})

test('a force-pushed remote branch leaves the local branch behind its submitted head', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const key = `native:${created.number}`
    recordParent(harness, 'feature/step-1', 'main', heads[0])
    recordParent(harness, 'feature/step-2', 'feature/step-1', heads[0])
    recordParent(harness, 'feature/step-3', 'feature/step-2', heads[1])

    // Another machine rewrites the submitted head and force-pushes it.
    const rewritten = bareGit(harness, [
      'commit-tree',
      `${heads[2]}^{tree}`,
      '-p',
      heads[1],
      '-m',
      'rewritten',
    ])
    bareGit(harness, ['update-ref', 'refs/heads/feature/step-3', rewritten, heads[2]])
    git(harness, [
      'fetch',
      harness.bare,
      '+refs/heads/feature/step-3:refs/remotes/origin/feature/step-3',
    ])

    const afterForcePush = stackFor(await getSnapshot(harness.repo), key)
    assert.equal(afterForcePush.state, 'diverged')
    const top = afterForcePush.members.find((entry) => entry.branch === 'feature/step-3')
    assert.equal(top?.state, 'diverged')
    const move = afterForcePush.repairs.find(
      (repair) => repair.kind === 'adopt-remote-tip' && repair.branch === 'feature/step-3',
    )
    assert.ok(move)
    assert.equal(move.requiresConfirmation, true)
    assert.equal(move.evidence?.previousOid, heads[2])
    assert.equal(git(harness, ['rev-parse', 'feature/step-3']), heads[2])
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    await assert.rejects(
      runReconciliationRepair(harness.repo, {
        token: preview.token,
        ids: [move.id],
        confirmRewrites: true,
      }),
      /Switch away from feature\/step-3/,
    )
    assert.equal(git(harness, ['rev-parse', 'feature/step-3']), heads[2])
    assert.equal(git(harness, ['status', '--porcelain']), '')
  })
})

test('one confirmed repair moves a submitted ref and then records its parent without a false stale error', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    const rewritten = bareGit(harness, [
      'commit-tree',
      `${heads[2]}^{tree}`,
      '-p',
      heads[2],
      '-m',
      'remote ahead',
    ])
    bareGit(harness, ['update-ref', 'refs/heads/feature/step-3', rewritten, heads[2]])
    git(harness, [
      'fetch',
      harness.bare,
      '+refs/heads/feature/step-3:refs/remotes/origin/feature/step-3',
    ])
    git(harness, ['checkout', 'main'])
    const state = await harness.readState()
    state.prs[2].headOid = rewritten
    const submitted = state.stacks?.find((stack) => stack.number === created.number)
    assert.ok(submitted)
    const third = submitted.pull_requests.find((pr) => pr.number === 103)
    assert.ok(third)
    third.head.sha = rewritten
    await harness.writeState(state)

    const key = `native:${created.number}`
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const repairs = preview.repairs.filter((repair) => repair.branch === 'feature/step-3')
    assert.deepEqual(
      new Set(repairs.map((repair) => repair.kind)),
      new Set(['adopt-remote-tip', 'adopt-remote-order']),
    )
    const result = await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: repairs.map((repair) => repair.id),
      confirmRewrites: true,
    })
    assert.match(result.message, /Move feature\/step-3 to the submitted head/)
    assert.match(result.message, /Record feature\/step-3 under feature\/step-2/)
    assert.equal(git(harness, ['rev-parse', 'feature/step-3']), rewritten)
    assert.equal(recordedParent(harness, 'feature/step-3'), 'feature/step-2')
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-3.parentTip']),
      heads[1],
    )
    const evidence = (await getSnapshot(harness.repo)).reconciliation?.evidence
    assert.deepEqual(
      evidence?.applied.map((entry) => entry.kind),
      ['adopt-remote-tip', 'adopt-remote-order'],
    )
    assert.equal(evidence?.evidence[0].previousOid, heads[2])
    assert.equal(git(harness, ['rev-parse', evidence!.evidence[0].backupRef!]), heads[2])
  })
})

test('adopting a selected parent tip records the child boundary against its new tip', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    git(harness, ['checkout', 'main'])
    const oldParentTip = git(harness, ['rev-parse', 'main'])
    git(harness, ['update-ref', 'refs/heads/feature/step-1', oldParentTip, heads[0]])
    assert.equal(git(harness, ['merge-base', 'feature/step-1', 'feature/step-2']), oldParentTip)

    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      `native:${created.number}`,
    )
    const moveParent = preview.repairs.find(
      (repair) => repair.kind === 'adopt-remote-tip' && repair.branch === 'feature/step-1',
    )
    const recordChild = preview.repairs.find(
      (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-2',
    )
    assert.ok(moveParent)
    assert.ok(recordChild)
    await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: [moveParent.id, recordChild.id],
      confirmRewrites: true,
    })
    assert.equal(git(harness, ['rev-parse', 'feature/step-1']), heads[0])
    assert.equal(recordedParent(harness, 'feature/step-2'), 'feature/step-1')
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-2.parentTip']),
      heads[0],
    )
    const evidence = (await getSnapshot(harness.repo)).reconciliation?.evidence
    assert.deepEqual(
      evidence?.applied.map((entry) => `${entry.kind}:${entry.branch}`),
      ['adopt-remote-tip:feature/step-1', 'adopt-remote-order:feature/step-2'],
    )
    assert.equal(git(harness, ['rev-parse', evidence!.evidence[0].backupRef!]), oldParentTip)
  })
})

test('restoring a selected parent ref records the child boundary against the restored tip', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    git(harness, ['checkout', 'main'])
    const oldParentTip = git(harness, ['rev-parse', 'main'])
    git(harness, ['update-ref', '-d', 'refs/heads/feature/step-1'])
    git(harness, ['update-ref', 'refs/remotes/origin/feature/step-1', oldParentTip, heads[0]])
    assert.equal(
      git(harness, ['merge-base', 'origin/feature/step-1', 'feature/step-2']),
      oldParentTip,
    )

    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      `native:${created.number}`,
    )
    const restoreParent = preview.repairs.find(
      (repair) => repair.kind === 'restore-missing-branch' && repair.branch === 'feature/step-1',
    )
    const recordChild = preview.repairs.find(
      (repair) => repair.kind === 'adopt-remote-order' && repair.branch === 'feature/step-2',
    )
    assert.ok(restoreParent)
    assert.ok(recordChild)
    await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: [restoreParent.id, recordChild.id],
      confirmRewrites: true,
    })
    assert.equal(git(harness, ['rev-parse', 'feature/step-1']), heads[0])
    assert.equal(recordedParent(harness, 'feature/step-2'), 'feature/step-1')
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-2.parentTip']),
      heads[0],
    )
    const evidence = (await getSnapshot(harness.repo)).reconciliation?.evidence
    assert.deepEqual(
      evidence?.applied.map((entry) => `${entry.kind}:${entry.branch}`),
      ['restore-missing-branch:feature/step-1', 'adopt-remote-order:feature/step-2'],
    )
  })
})

test('a selected ref move can precede clearing its stale parent hint', async () => {
  await withHarness(async (harness) => {
    const heads = await setupStack(harness)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102, 103])
    recordParent(harness, 'feature/step-3', 'feature/step-2', 'f'.repeat(40))
    const rewritten = bareGit(harness, [
      'commit-tree',
      `${heads[2]}^{tree}`,
      '-p',
      heads[1],
      '-m',
      'remote rewrite',
    ])
    bareGit(harness, ['update-ref', 'refs/heads/feature/step-3', rewritten, heads[2]])
    git(harness, [
      'fetch',
      harness.bare,
      '+refs/heads/feature/step-3:refs/remotes/origin/feature/step-3',
    ])
    git(harness, ['checkout', 'main'])
    const state = await harness.readState()
    state.prs[2].headOid = rewritten
    const submitted = state.stacks?.find((stack) => stack.number === created.number)
    assert.ok(submitted)
    const third = submitted.pull_requests.find((pr) => pr.number === 103)
    assert.ok(third)
    third.head.sha = rewritten
    await harness.writeState(state)

    const key = `native:${created.number}`
    const preview = await previewReconciliationRepair(
      harness.repo,
      await getSnapshot(harness.repo),
      key,
    )
    const repairs = preview.repairs.filter((repair) => repair.branch === 'feature/step-3')
    assert.deepEqual(
      new Set(repairs.map((repair) => repair.kind)),
      new Set(['adopt-remote-tip', 'clear-stale-hint']),
    )
    await runReconciliationRepair(harness.repo, {
      token: preview.token,
      ids: repairs.map((repair) => repair.id),
      confirmRewrites: true,
    })
    assert.equal(git(harness, ['rev-parse', 'feature/step-3']), rewritten)
    assert.equal(recordedParent(harness, 'feature/step-3'), null)
    assert.equal(
      optionalGit(harness, ['config', '--local', '--get', 'branch.feature/step-3.parentTip']),
      null,
    )
    const evidence = (await getSnapshot(harness.repo)).reconciliation?.evidence
    assert.deepEqual(
      evidence?.applied.map((entry) => entry.kind),
      ['adopt-remote-tip', 'clear-stale-hint'],
    )
    assert.equal(evidence?.evidence[1].previousParent, 'feature/step-2')
    assert.equal(evidence?.evidence[1].previousOid, rewritten)
    assert.equal(git(harness, ['rev-parse', evidence!.evidence[0].backupRef!]), heads[2])
  })
})

test('a report without submitted membership stays read-only and reports local stacks', async () => {
  await withHarness(async (harness) => {
    git(harness, ['checkout', '-b', 'feature/local-1'])
    git(harness, ['commit', '--allow-empty', '-m', 'local work'])
    recordParent(harness, 'feature/local-1', 'main', git(harness, ['rev-parse', 'main']))
    git(harness, ['checkout', '-b', 'feature/local-2'])
    git(harness, ['commit', '--allow-empty', '-m', 'more local work'])
    recordParent(harness, 'feature/local-2', 'feature/local-1', git(harness, ['rev-parse', 'main']))

    const snapshot = await getSnapshot(harness.repo)
    const report = await buildReconciliationReport(harness.repo, snapshot)
    assert.equal(report.available, true)
    const local = report.stacks.find((entry) => entry.key === 'local:feature/local-1')
    assert.ok(local)
    assert.deepEqual(
      local.members.map((entry) => entry.branch),
      ['feature/local-1', 'feature/local-2'],
    )
    assert.equal(local.state, 'local-only')
    assert.deepEqual(local.repairs, [])
    assert.equal(git(harness, ['rev-parse', 'feature/local-2']).length, 40)
  })
})

test('local-only report includes independent single-branch roots and every sibling', async () => {
  await withHarness(async (harness) => {
    const main = git(harness, ['rev-parse', 'main'])
    for (const branch of ['feature/solo', 'feature/root']) {
      git(harness, ['checkout', '-b', branch, 'main'])
      git(harness, ['commit', '--allow-empty', '-m', branch])
      recordParent(harness, branch, 'main', main)
    }
    for (const branch of ['feature/child-a', 'feature/child-b']) {
      git(harness, ['checkout', '-b', branch, 'feature/root'])
      git(harness, ['commit', '--allow-empty', '-m', branch])
      recordParent(harness, branch, 'feature/root', git(harness, ['rev-parse', 'feature/root']))
    }
    const report = (await getSnapshot(harness.repo)).reconciliation
    assert.ok(report)
    const solo = report.stacks.find((stack) => stack.key === 'local:feature/solo')
    assert.equal(solo?.state, 'local-only')
    assert.deepEqual(
      solo.members.map((entry) => entry.branch),
      ['feature/solo'],
    )
    const root = report.stacks.find((stack) => stack.key === 'local:feature/root')
    assert.equal(root?.state, 'local-only')
    assert.deepEqual(
      new Set(root.members.map((entry) => entry.branch)),
      new Set(['feature/root', 'feature/child-a', 'feature/child-b']),
    )
  })
})
