import assert from 'node:assert/strict'
import test from 'node:test'
import { withoutReplacedCredential } from '../src/renderer/src/credential-identity'
import type { Branch, PullRequest, RepositorySnapshot } from '@git-stacks/shared/types'

/**
 * The window held a snapshot one account read: its pull request list, the issues,
 * the native-stack preview, and — carried on each branch rather than on the list —
 * the pull request that branch is published as, with its checks and its link.
 * Then the credential was actually replaced.
 */

function pullRequest(number: number, head: string): PullRequest {
  return {
    number,
    title: 'Private work in progress',
    author: 'ada',
    state: 'OPEN',
    draft: false,
    head,
    base: 'main',
    url: `https://github.com/acme/widgets/pull/${number}`,
    updatedAt: '2026-03-01T12:00:00Z',
    checks: [{ name: 'ci', state: 'PENDING', link: 'https://github.com/acme/widgets/runs/1' }],
  } as unknown as PullRequest
}

function branch(over: Partial<Branch> = {}): Branch {
  return {
    ref: 'refs/heads/feature/checkout-tests',
    name: 'feature/checkout-tests',
    current: true,
    remote: true,
    upstream: 'origin/feature/checkout-tests',
    upstreamRef: 'refs/remotes/origin/feature/checkout-tests',
    ahead: 2,
    behind: 1,
    subject: 'Add the checkout tests',
    updatedAt: '2026-03-01T12:00:00Z',
    parent: 'refs/heads/main',
    parentBehind: 0,
    pr: pullRequest(41, 'ada:feature/checkout-tests'),
    oid: '1111111111111111111111111111111111111111',
    parentTip: '2222222222222222222222222222222222222222',
    parentSource: 'pullRequest',
    ...over,
  }
}

function snapshot(over: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    path: '/tmp/widgets',
    name: 'widgets',
    currentBranch: 'feature/checkout-tests',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:acme/widgets.git',
    branches: [
      branch(),
      branch({
        ref: 'refs/heads/main',
        name: 'main',
        current: false,
        pr: null,
        parentSource: 'recorded',
        parentTip: '3333333333333333333333333333333333333333',
      }),
    ],
    pullRequests: [pullRequest(41, 'ada:feature/checkout-tests')],
    issues: [{ number: 7, title: 'Private issue', state: 'OPEN' } as never],
    files: [],
    stashes: [],
    rebaseInProgress: false,
    operation: null,
    stackOperation: null,
    headOid: '1111111111111111111111111111111111111111',
    github: { available: true, message: '' },
    nativeStacks: [{ name: 'stack-a' } as never],
    nativeStackPreviewAvailable: true,
    nativeStackMessage: 'preview',
    ...over,
  } as unknown as RepositorySnapshot
}

test('a replaced credential takes every GitHub answer with it, on the list and on each branch', () => {
  const held = snapshot()
  const fenced = withoutReplacedCredential(held)

  // Nothing another account read survives: the count clears, and so does the
  // pull request a branch was published as, which is what put "pull request #41,
  // checks pending" and its GitHub link on screen.
  assert.deepEqual(fenced.pullRequests, [])
  assert.deepEqual(fenced.issues, [])
  assert.deepEqual(fenced.nativeStacks, [])
  assert.equal(fenced.github.available, false)
  assert.equal(fenced.nativeStackPreviewAvailable, undefined)
  const [published, main] = fenced.branches
  assert.equal(published.pr, null, 'the pull request this branch was published as is gone')
  assert.equal(
    JSON.stringify(fenced).includes('41'),
    false,
    'no pull request number from the replaced credential is left anywhere to render',
  )
  assert.equal(
    JSON.stringify(fenced).includes('/pull/41'),
    false,
    'the link to that pull request is gone with it, while the local origin stays',
  )
  assert.equal(fenced.remoteUrl, held.remoteUrl)
  assert.equal(
    published.parentSource,
    null,
    'a parent tip learned from that pull request goes with it',
  )

  // Local Git state is untouched: this window keeps showing the repository, its
  // branches, their commits, and how far they are from their upstreams.
  assert.equal(fenced.path, held.path)
  assert.equal(fenced.name, held.name)
  assert.equal(fenced.headOid, held.headOid)
  assert.equal(fenced.defaultBranch, held.defaultBranch)
  assert.equal(fenced.branches.length, held.branches.length)
  assert.deepEqual(
    fenced.branches.map(({ ref, current, upstream, ahead, behind, subject, oid }) => ({
      ref,
      current,
      upstream,
      ahead,
      behind,
      subject,
      oid,
    })),
    held.branches.map(({ ref, current, upstream, ahead, behind, subject, oid }) => ({
      ref,
      current,
      upstream,
      ahead,
      behind,
      subject,
      oid,
    })),
  )
  // A branch that carried a local parent relationship keeps it.
  assert.equal(main.pr, null)
  assert.equal(main.parentSource, 'recorded')
  assert.equal(main.parentTip, '3333333333333333333333333333333333333333')

  // The checks and the link that came with that pull request went with it: a
  // branch that was published as pull request #41 keeps its local commits and
  // shows nothing about a pull request the new credential has not read.
  const publishedPullRequest = held.branches[0].pr
  assert.equal(publishedPullRequest?.number, 41)
  assert.match(String(publishedPullRequest?.checks?.[0]?.link ?? ''), /github\.com/u)
  assert.equal(fenced.branches[0].pr?.checks, undefined)
})

test('retirement removes reconciliation and all remote-derived ancestry, not local parent hints', () => {
  const held = snapshot({
    reconciliation: {
      available: true,
      message: 'Private submitted stack',
      stacks: [
        {
          key: 'private-stack',
          base: 'main',
          stackNumber: 17,
          stackUrl: 'https://github.com/acme/widgets/stack/17',
          state: 'reordered',
          summary: 'Private submitted order',
          submittedOrder: ['private-parent', 'private-child'],
          members: [],
          repairs: [],
          blockers: [],
        },
      ],
      blockers: [],
      evidence: null,
    },
    branches: [
      branch({ parent: 'private-parent', parentBehind: 3, needsRestack: true }),
      branch({
        pr: null,
        parentSource: 'stack',
        parent: 'private-parent',
        parentBehind: 2,
        needsRestack: true,
      }),
      branch({ parentSource: 'recorded' }),
      branch({ pr: null, parentSource: 'inferred' }),
    ],
  })
  const fenced = withoutReplacedCredential(held)
  assert.equal(fenced.reconciliation, undefined)
  assert.equal(JSON.stringify(fenced).includes('private-'), false)
  for (const remote of fenced.branches.slice(0, 2)) {
    assert.equal(remote.parent, null)
    assert.equal(remote.parentBehind, null)
    assert.equal(remote.parentTip, null)
    assert.equal(remote.parentSource, null)
    assert.equal(remote.needsRestack, undefined)
  }
  for (const index of [2, 3]) {
    const local = fenced.branches[index]
    const before = held.branches[index]
    assert.equal(local.parent, before.parent)
    assert.equal(local.parentTip, before.parentTip)
    assert.equal(local.parentSource, before.parentSource)
    assert.equal(local.parentBehind, before.parentBehind)
    assert.equal(local.pr, null)
  }
})
