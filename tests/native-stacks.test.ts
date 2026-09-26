import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { getSnapshot } from '../src/main/git'
import { getGitHubData, getPullRequest } from '../src/main/github'
import { DirectGitHubTransport, setGitHubTransport } from '../src/main/github-transport'
import {
  addPullRequestsToStack,
  createPullRequestStack,
  NativeStackError,
  detectNativeStacksCapability,
  getPullRequestStack,
  listPullRequestStacks,
  unstackPullRequests,
  validateNativeStackChain,
} from '../src/main/native-stacks'
import { previewStack, runStackAction } from '../src/main/stacks'
import type { PullRequest } from '../src/shared/types'
import { createGitHubApiDouble } from './fixtures/github-api-double'
import { createGitHubHarness, type GitHubHarness } from './fixtures/github-harness'

function git(harness: GitHubHarness, args: string[]): string {
  return execFileSync(harness.env.GIT_STACKS_REAL_GIT || 'git', ['-C', harness.repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...harness.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
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

async function setupThreeBranches(harness: GitHubHarness) {
  git(harness, ['checkout', '-b', 'feature/step-1'])
  git(harness, ['commit', '--allow-empty', '-m', 'step 1'])
  const oid1 = git(harness, ['rev-parse', 'feature/step-1'])
  git(harness, ['push', harness.bare, 'feature/step-1:refs/heads/feature/step-1'])
  git(harness, ['update-ref', 'refs/remotes/origin/feature/step-1', oid1])

  git(harness, ['checkout', '-b', 'feature/step-2'])
  git(harness, ['commit', '--allow-empty', '-m', 'step 2'])
  const oid2 = git(harness, ['rev-parse', 'feature/step-2'])
  git(harness, ['push', harness.bare, 'feature/step-2:refs/heads/feature/step-2'])
  git(harness, ['update-ref', 'refs/remotes/origin/feature/step-2', oid2])

  git(harness, ['checkout', '-b', 'feature/step-3'])
  git(harness, ['commit', '--allow-empty', '-m', 'step 3'])
  const oid3 = git(harness, ['rev-parse', 'feature/step-3'])
  git(harness, ['push', harness.bare, 'feature/step-3:refs/heads/feature/step-3'])
  git(harness, ['update-ref', 'refs/remotes/origin/feature/step-3', oid3])
  const state = await harness.readState()
  state.prs = [
    {
      number: 101,
      title: 'Step 1 PR',
      body: 'Step 1',
      base: 'main',
      head: 'feature/step-1',
      headRepository: 'acme/widgets',
      draft: false,
      state: 'OPEN',
      checks: 'none',
      reviewDecision: null,
      mergeState: 'CLEAN',
      url: 'https://github.com/acme/widgets/pull/101',
      headOid: git(harness, ['rev-parse', 'feature/step-1']),
      mergeOid: null,
      mergedAt: null,
    },
    {
      number: 102,
      title: 'Step 2 PR',
      body: 'Step 2',
      base: 'feature/step-1',
      head: 'feature/step-2',
      headRepository: 'acme/widgets',
      draft: false,
      state: 'OPEN',
      checks: 'none',
      reviewDecision: null,
      mergeState: 'CLEAN',
      url: 'https://github.com/acme/widgets/pull/102',
      headOid: git(harness, ['rev-parse', 'feature/step-2']),
      mergeOid: null,
      mergedAt: null,
    },
    {
      number: 103,
      title: 'Step 3 PR',
      body: 'Step 3',
      base: 'feature/step-2',
      head: 'feature/step-3',
      headRepository: 'acme/widgets',
      draft: false,
      state: 'OPEN',
      checks: 'none',
      reviewDecision: null,
      mergeState: 'CLEAN',
      url: 'https://github.com/acme/widgets/pull/103',
      headOid: git(harness, ['rev-parse', 'feature/step-3']),
      mergeOid: null,
      mergedAt: null,
    },
  ]
  state.nextNumber = 104
  await harness.writeState(state)
}

test('detectNativeStacksCapability returns true when preview endpoint responds', async () => {
  await withHarness(async (harness) => {
    const capability = await detectNativeStacksCapability('acme', 'widgets')
    assert.equal(capability.available, true)

    // Disable preview
    const state = await harness.readState()
    state.stacksPreviewDisabled = true
    await harness.writeState(state)

    const disabledCap = await detectNativeStacksCapability('acme', 'widgets')
    assert.equal(disabledCap.available, false)
    assert.match(disabledCap.message ?? '', /preview API is (?:not available|unavailable)/i)
  })
})

test('create, list, get, add, and unstack native pull request stacks', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    // 1. Create a native stack with PRs [101, 102]
    const created = await createPullRequestStack('acme', 'widgets', [101, 102])
    assert.equal(created.number, 1)
    assert.equal(created.pullRequests.length, 2)
    assert.equal(created.base, 'main')
    assert.equal(created.status, 'valid')
    assert.equal(created.pullRequests[0].number, 101)
    assert.equal(created.pullRequests[0].position, 1)
    assert.equal(created.pullRequests[0].base, 'main')
    assert.equal(created.pullRequests[1].number, 102)
    assert.equal(created.pullRequests[1].position, 2)
    assert.equal(created.pullRequests[1].base, 'feature/step-1')

    // 2. Get the stack by number
    const fetched = await getPullRequestStack('acme', 'widgets', 1)
    assert.equal(fetched.number, 1)
    assert.equal(fetched.pullRequests.length, 2)

    // 3. List stacks with pagination and filter
    const listed = await listPullRequestStacks('acme', 'widgets')
    assert.equal(listed.length, 1)
    assert.equal(listed[0].number, 1)

    const filtered = await listPullRequestStacks('acme', 'widgets', { pullRequest: 102 })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].number, 1)

    const emptyFilter = await listPullRequestStacks('acme', 'widgets', { pullRequest: 999 })
    assert.equal(emptyFilter.length, 0)

    // 4. Add PR 103 to the stack
    const extended = await addPullRequestsToStack('acme', 'widgets', 1, [103])
    assert.equal(extended.pullRequests.length, 3)
    assert.equal(extended.pullRequests[2].number, 103)
    assert.equal(extended.pullRequests[2].position, 3)
    assert.equal(extended.pullRequests[2].base, 'feature/step-2')

    // 5. Unstack pull requests
    const unstacked = await unstackPullRequests('acme', 'widgets', 1)
    assert.equal(unstacked.dissolved, true)
    assert.equal(unstacked.stack, null)

    const listAfterUnstack = await listPullRequestStacks('acme', 'widgets')
    assert.equal(listAfterUnstack.length, 0)
  })
})

test('validates bottom-to-top contiguous chain, rejecting gaps and mismatches', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const state = await harness.readState()
    const prs: PullRequest[] = state.prs.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      head: p.head,
      base: p.base,
      state: p.state,
      draft: p.draft,
      checks: p.checks,
      headOid: p.headOid ?? undefined,
      mergeOid: p.mergeOid ?? undefined,
      reviewDecision: p.reviewDecision ?? undefined,
      mergeState: p.mergeState ?? undefined,
      headRepository: p.headRepository,
    }))

    // Valid chain main -> step-1 -> step-2
    const validResult = validateNativeStackChain([prs[0], prs[1]], 'main')
    assert.equal(validResult.status, 'valid')

    // Discontinuous chain: main -> step-2 (base is step-1, doesn't match main)
    const invalidResult = validateNativeStackChain([prs[1]], 'main')
    assert.equal(invalidResult.status, 'invalid-chain')
    assert.match(invalidResult.message || '', /does not match/i)

    // Inverted chain: step-2 then step-1
    const invertedResult = validateNativeStackChain([prs[1], prs[0]], 'main')
    assert.equal(invertedResult.status, 'invalid-chain')

    // Cross-fork head rejection
    const crossForkPr = { ...prs[1], headRepository: 'other/fork' }
    const crossForkResult = validateNativeStackChain([prs[0], crossForkPr], 'main')
    assert.equal(crossForkResult.status, 'cross-fork-head')

    // Duplicate PR rejection
    const duplicateResult = validateNativeStackChain([prs[0], prs[0]], 'main')
    assert.equal(duplicateResult.status, 'duplicate-pr')
  })
})

test('missing snapshot models are preflighted against canonical PRs before stack writes', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const known = await getPullRequest(harness.repo, 101)
    const state = await harness.readState()
    state.prs[1].base = 'unrelated'
    await harness.writeState(state)

    await assert.rejects(
      createPullRequestStack('acme', 'widgets', [101, 102], { knownPullRequests: [known] }),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'invalid-chain' &&
        error.httpStatus === null,
    )
    assert.deepEqual((await harness.readState()).stacks, [])

    state.prs[1].base = 'feature/step-1'
    state.prs[1].headRepository = 'other/fork'
    await harness.writeState(state)
    await assert.rejects(
      createPullRequestStack('acme', 'widgets', [101, 102]),
      (error) => error instanceof NativeStackError && error.status === 'cross-fork-head',
    )
    assert.deepEqual((await harness.readState()).stacks, [])

    state.prs[1].headRepository = 'acme/widgets'
    state.prs[1].state = 'CLOSED'
    await harness.writeState(state)
    await assert.rejects(
      createPullRequestStack('acme', 'widgets', [101, 102]),
      (error) => error instanceof NativeStackError && error.status === 'closed',
    )
    assert.deepEqual((await harness.readState()).stacks, [])

    await createPullRequestStack('acme', 'widgets', [101])
    await assert.rejects(
      addPullRequestsToStack('acme', 'widgets', 1, [102], { knownPullRequests: [known] }),
      (error) => error instanceof NativeStackError && error.status === 'closed',
    )
    assert.deepEqual(
      (await harness.readState()).stacks?.[0]?.pull_requests.map((pr) => pr.number),
      [101],
    )

    const stacked = await harness.readState()
    stacked.stacks![0].open = false
    await harness.writeState(stacked)
    await assert.rejects(
      addPullRequestsToStack('acme', 'widgets', 1, [103]),
      (error) => error instanceof NativeStackError && error.status === 'closed',
    )

    stacked.stacks![0].open = true
    stacked.stacks![0].pull_requests[0].state = 'closed'
    stacked.stacks![0].pull_requests[0].merged_at = new Date().toISOString()
    await harness.writeState(stacked)
    await assert.rejects(
      addPullRequestsToStack('acme', 'widgets', 1, [103]),
      (error) => error instanceof NativeStackError && error.status === 'completed',
    )
  })
})

test('handles 404 not found and 422 validation failure gracefully', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    // 404 on nonexistent stack
    await assert.rejects(
      async () => getPullRequestStack('acme', 'widgets', 9999),
      /Stack #9999 not found|404/u,
    )

    // 422 on invalid PR addition (e.g. duplicate or out of order)
    await createPullRequestStack('acme', 'widgets', [101])
    await assert.rejects(
      async () => addPullRequestsToStack('acme', 'widgets', 1, [101]),
      /already in stack|duplicate/u,
    )
  })
})

test('reloads native stack from GitHub after restart without app metadata', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    // Create a native stack on origin
    await createPullRequestStack('acme', 'widgets', [101, 102, 103])

    // Notice: NO branch.<name>.parent config is set in local git!
    // Verify local git has no parent config
    let parentConfig = ''
    try {
      parentConfig = git(harness, ['config', '--get', 'branch.feature/step-2.parent'])
    } catch {
      // not set
    }
    assert.equal(parentConfig, '')

    // Read snapshot
    const snapshot = await getSnapshot(harness.repo)
    assert.equal(snapshot.nativeStacks?.length, 1)
    assert.equal(snapshot.nativeStacks?.[0]?.number, 1)
    assert.equal(snapshot.nativeStackPreviewAvailable, true)

    // Branches should derive parent directly from native stack
    const step1 = snapshot.branches.find((b) => b.name === 'feature/step-1')
    assert.ok(step1)
    assert.equal(step1.parent, 'main')
    assert.equal(step1.parentSource, 'stack')
    assert.equal(step1.pr?.stack?.stackNumber, 1)
    assert.equal(step1.pr?.stack?.position, 1)

    const step2 = snapshot.branches.find((b) => b.name === 'feature/step-2')
    assert.ok(step2)
    assert.equal(step2.parent, 'feature/step-1')
    assert.equal(step2.parentSource, 'stack')
    assert.equal(step2.pr?.stack?.stackNumber, 1)
    assert.equal(step2.pr?.stack?.position, 2)

    const step3 = snapshot.branches.find((b) => b.name === 'feature/step-3')
    assert.ok(step3)
    assert.equal(step3.parent, 'feature/step-2')
    assert.equal(step3.parentSource, 'stack')
    assert.equal(step3.pr?.stack?.stackNumber, 1)
    assert.equal(step3.pr?.stack?.position, 3)
  })
})

test('runStackAction supports createNativeStack, addPullRequestsToNativeStack, and unstackNativeStack', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    // Execute createNativeStack action
    const createRes = await runStackAction(harness.repo, {
      type: 'createNativeStack',
      pullRequests: [101, 102],
    })
    assert.match(createRes.message, /Created (?:GitHub )?native stack #1/u)

    // Verify snapshot reflects it
    let snapshot = await getSnapshot(harness.repo)
    assert.equal(snapshot.nativeStacks?.length, 1)
    assert.equal(snapshot.nativeStacks?.[0]?.pullRequests.length, 2)

    // Execute addPullRequestsToNativeStack
    const addRes = await runStackAction(harness.repo, {
      type: 'addPullRequestsToNativeStack',
      stackNumber: 1,
      pullRequests: [103],
    })
    assert.match(addRes.message, /Added 1 pull request to native stack #1/u)

    snapshot = await getSnapshot(harness.repo)
    assert.equal(snapshot.nativeStacks?.[0]?.pullRequests.length, 3)

    // Execute unstackNativeStack
    const unstackRes = await runStackAction(harness.repo, {
      type: 'unstackNativeStack',
      stackNumber: 1,
    })
    assert.match(unstackRes.message, /Dissolved native stack #1/u)

    snapshot = await getSnapshot(harness.repo)
    assert.equal(snapshot.nativeStacks?.length, 0)
  })
})

test('degrades gracefully to chained PRs when native stack preview is unavailable', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    const state = await harness.readState()
    state.stacksPreviewDisabled = true
    await harness.writeState(state)

    const snapshot = await getSnapshot(harness.repo)
    assert.equal(snapshot.nativeStackPreviewAvailable, false)
    assert.equal(snapshot.nativeStacks?.length, 0)

    // Branches fall back to PR base / recorded parent
    const step2 = snapshot.branches.find((b) => b.name === 'feature/step-2')
    assert.ok(step2)
    assert.equal(step2.parent, 'feature/step-1')
    assert.equal(step2.parentSource, 'pullRequest')
  })
})

test('publishStack automatically registers native stack on origin and reflects it in snapshot', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    let snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
    assert.deepEqual(preview.blockers, [])
    const publishRes = await runStackAction(harness.repo, {
      type: 'executeStack',
      token: preview.token,
      allowForce: false,
      draft: false,
      titles: { 'feature/step-1': 'Step 1 PR', 'feature/step-2': 'Step 2 PR' },
      mergeMethod: 'squash',
    })
    assert.match(publishRes.message, /Published 3 stack pull requests/u)

    const stacks = await listPullRequestStacks('acme', 'widgets')
    assert.equal(stacks.length, 1)
    assert.equal(stacks[0].pullRequests.length, 3)
    assert.equal(stacks[0].pullRequests[0].number, 101)
    assert.equal(stacks[0].pullRequests[1].number, 102)
    assert.equal(stacks[0].pullRequests[2].number, 103)

    snapshot = await getSnapshot(harness.repo)
    assert.equal(snapshot.nativeStacks?.length, 1)
    const b2 = snapshot.branches.find((b) => b.name === 'feature/step-2')
    assert.equal(b2?.parentSource, 'stack')
    assert.equal(b2?.pr?.stack?.position, 2)
  })
})

test('publishStack propagates native registration failure when preview capability is enabled', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    const state = await harness.readState()
    state.stacks = [
      {
        id: 99,
        number: 99,
        node_id: 'STACK_99',
        url: 'https://api.github.com/repos/acme/widgets/stacks/99',
        base: { ref: 'main' },
        open: false,
        created_at: new Date().toISOString(),
        pull_requests: [
          {
            number: 101,
            state: 'open',
            draft: false,
            merged_at: null,
            head: { ref: 'feature/step-1', sha: git(harness, ['rev-parse', 'feature/step-1']) },
          },
        ],
      },
    ]
    await harness.writeState(state)

    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
    assert.deepEqual(preview.blockers, [])

    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        draft: false,
        titles: { 'feature/step-1': 'Step 1 PR', 'feature/step-2': 'Step 2 PR' },
        mergeMethod: 'squash',
      }),
      /closed stack|cannot add pull requests/iu,
    )
  })
})
