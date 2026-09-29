import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createGitHubHarness,
  type GitHubFixtureState,
  type GitHubHarness,
} from './fixtures/github-harness'
import type { NativeStack, PullRequest } from '../src/shared/types'

// Git Stacks captures Node's spawn API when its own modules load, and the GitHub
// harness answers `git` and `gh` on that API, so Git Stacks is loaded here.
// Nothing may reach `node:child_process` through an ESM import before the harness
// module body runs: the builtin facade keeps the export it first sees, so a
// static import above would hand Git Stacks the unpatched `execFile`.
const { execFileSync } = await import('node:child_process')
const { createGitHubApiDouble } = await import('./fixtures/github-api-double')
const { getSnapshot } = await import('../src/main/git')
const { getGitHubData, getPullRequest } = await import('../src/main/github')
const { DirectGitHubTransport, setGitHubTransport } = await import('../src/main/github-transport')
const {
  addPullRequestsToStack,
  createPullRequestStack,
  NativeStackError,
  detectNativeStacksCapability,
  getPullRequestStack,
  listPullRequestStacks,
  revalidatePublishedStackRegistration,
  unstackPullRequests,
  validateNativeStackChain,
  validatePublishedStackRegistration,
} = await import('../src/main/native-stacks')
const { previewStack, runStackAction } = await import('../src/main/stacks')

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

test('stack mutations re-read captured pull requests and reject concurrent drift', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const captured = await getPullRequest(harness.repo, 101)
    assert.equal(captured.base, 'main')

    // The bottom pull request is retargeted after publication captured it.
    const retargeted = await harness.readState()
    retargeted.prs[0].base = 'release'
    await harness.writeState(retargeted)
    await assert.rejects(
      createPullRequestStack('acme', 'widgets', [101, 102], { knownPullRequests: [captured] }),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'invalid-chain' &&
        /base changed from main to release/u.test(error.message),
    )
    assert.deepEqual((await harness.readState()).stacks, [])

    // A force-push to the captured head branch is a concurrency conflict, not a silent success.
    const retarget = await harness.readState()
    retarget.prs[0].base = 'main'
    await harness.writeState(retarget)
    git(harness, ['checkout', 'feature/step-1'])
    git(harness, ['commit', '--allow-empty', '-m', 'concurrent commit'])
    git(harness, ['push', harness.bare, 'feature/step-1:refs/heads/feature/step-1'])
    await assert.rejects(
      createPullRequestStack('acme', 'widgets', [101, 102], { knownPullRequests: [captured] }),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'invalid-chain' &&
        /head moved to/u.test(error.message),
    )
    assert.deepEqual((await harness.readState()).stacks, [])

    // A re-read model matches the current head, so the same publication proceeds.
    const refreshed = await getPullRequest(harness.repo, 101)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102], {
      knownPullRequests: [refreshed],
      defaultBranch: 'main',
    })
    assert.equal(created.pullRequests.length, 2)
  })
})

test('publishStack validates a matched stack that already contains every published pull request', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    await registerOpenStack(harness)

    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
    assert.deepEqual(preview.blockers, [])
    const published = await runStackAction(harness.repo, {
      type: 'executeStack',
      token: preview.token,
      allowForce: false,
      draft: false,
      titles: { 'feature/step-1': 'Step 1 PR', 'feature/step-2': 'Step 2 PR' },
      mergeMethod: 'squash',
    })
    assert.match(published.message, /Published 3 stack pull requests/u)
    assert.equal((await harness.readState()).stacks?.length, 1)
    assert.deepEqual(
      (await harness.readState()).stacks?.[0]?.pull_requests.map((pr) => pr.number),
      [101, 102, 103],
    )

    // The same idempotent publication against a closed stack is an explicit error, not a no-op.
    const closed = await harness.readState()
    closed.stacks![0].open = false
    await harness.writeState(closed)
    const closedSnapshot = await getSnapshot(harness.repo)
    const closedPreview = await previewStack(
      harness.repo,
      closedSnapshot,
      'publish',
      'feature/step-2',
    )
    assert.deepEqual(closedPreview.blockers, [])
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'executeStack',
        token: closedPreview.token,
        allowForce: false,
        draft: false,
        titles: { 'feature/step-1': 'Step 1 PR', 'feature/step-2': 'Step 2 PR' },
        mergeMethod: 'squash',
      }),
      /closed stack #99/u,
    )
  })
})

/** Registers an open native stack that already contains all three published pull requests. */
async function registerOpenStack(harness: GitHubHarness, competingStack?: number): Promise<void> {
  const branches = ['feature/step-1', 'feature/step-2', 'feature/step-3']
  const state = await harness.readState()
  state.stacks = [
    {
      id: 99_000,
      number: 99,
      node_id: 'STACK_99',
      url: 'https://api.github.com/repos/acme/widgets/stacks/99',
      base: { ref: 'main' },
      open: true,
      created_at: new Date().toISOString(),
      pull_requests: branches.map((ref, index) => ({
        number: 101 + index,
        state: 'open' as const,
        draft: false,
        merged_at: null,
        head: { ref, sha: git(harness, ['rev-parse', ref]) },
      })),
    },
  ]
  if (competingStack !== undefined) {
    state.stacks.unshift({
      id: competingStack * 1000,
      number: competingStack,
      node_id: `STACK_${competingStack}`,
      url: `https://api.github.com/repos/acme/widgets/stacks/${competingStack}`,
      base: { ref: 'main' },
      open: true,
      created_at: new Date().toISOString(),
      pull_requests: [101].map((number) => ({
        number,
        state: 'open' as const,
        draft: false,
        merged_at: null,
        head: { ref: 'feature/step-1', sha: git(harness, ['rev-parse', 'feature/step-1']) },
      })),
    })
  }
  await harness.writeState(state)
}

/** Registers an open native stack that already contains only the bottom published pull request. */
async function registerBottomOnlyStack(harness: GitHubHarness, stackNumber = 99): Promise<void> {
  const state = await harness.readState()
  state.stacks = [
    {
      id: stackNumber * 1000,
      number: stackNumber,
      node_id: `STACK_${stackNumber}`,
      url: `https://api.github.com/repos/acme/widgets/stacks/${stackNumber}`,
      base: { ref: 'main' },
      open: true,
      created_at: new Date().toISOString(),
      pull_requests: [
        {
          number: 101,
          state: 'open' as const,
          draft: false,
          merged_at: null,
          head: { ref: 'feature/step-1', sha: git(harness, ['rev-parse', 'feature/step-1']) },
        },
      ],
    },
  ]
  await harness.writeState(state)
}

function publishAction(token: string) {
  return {
    type: 'executeStack' as const,
    token,
    allowForce: false,
    draft: false,
    titles: { 'feature/step-1': 'Step 1 PR', 'feature/step-2': 'Step 2 PR' },
    mergeMethod: 'squash' as const,
  }
}

/** Moves a published pull request behind the app's back, the way another actor would. */
async function applyExternalDrift(
  harness: GitHubHarness,
  drift: 'force-push' | 'retarget',
): Promise<void> {
  if (drift === 'force-push') {
    git(harness, ['checkout', 'feature/step-1'])
    git(harness, ['reset', '--hard', 'HEAD~1'])
    git(harness, ['push', '--force', harness.bare, 'feature/step-1:refs/heads/feature/step-1'])
    return
  }
  const state = await harness.readState()
  state.prs[0].base = 'release'
  await harness.writeState(state)
}

/** Unstacks a native stack behind the app's back through GitHub's own unstack endpoint. */
async function unstackExternally(
  double: typeof globalThis.fetch,
  stackNumber: number,
): Promise<void> {
  const response = await double(
    `https://api.github.com/repos/acme/widgets/stacks/${stackNumber}/unstack`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  assert.equal(response.status, 204)
}

/** The unparameterized native stacks listing that selects the registration target. */
const STACKS_LISTING = 'https://api.github.com/repos/acme/widgets/stacks'

test('publishStack rejects an already-registered stack when a published pull request drifts after its readback', async () => {
  for (const drift of ['force-push', 'retarget'] as const) {
    await withHarness(async (harness) => {
      await setupThreeBranches(harness)
      await registerOpenStack(harness)

      const snapshot = await getSnapshot(harness.repo)
      const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
      assert.deepEqual(preview.blockers, [], drift)

      const inner = createGitHubApiDouble()
      const stackWrites: string[] = []
      let armed = true
      setGitHubTransport(
        new DirectGitHubTransport({
          token: 'fixture-token',
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : (input as string))
            const method = init?.method ?? 'GET'
            if (method !== 'GET') {
              if (/^https:\/\/api\.github\.com\/repos\/acme\/widgets\/stacks/u.test(url))
                stackWrites.push(`${method} ${url}`)
              // The readback of the top published pull request is the last request before the
              // native stack listing and the already-registered no-write path.
              const body = url.endsWith('/graphql') ? String(init?.body ?? '') : ''
              if (
                armed &&
                body.includes('pullRequest(number: $number)') &&
                body.includes('"number":103')
              ) {
                armed = false
                await applyExternalDrift(harness, drift)
              }
            }
            return inner(input, init)
          }) as typeof globalThis.fetch,
        }),
      )

      await assert.rejects(
        runStackAction(harness.repo, publishAction(preview.token)),
        drift === 'force-push' ? /head moved to/u : /base changed from main to release/u,
        drift,
      )
      assert.deepEqual(stackWrites, [], drift)
      assert.deepEqual(
        (await harness.readState()).stacks?.flatMap((stack) =>
          stack.pull_requests.map((pr) => pr.number),
        ),
        [101, 102, 103],
        drift,
      )
    })
  }
})

test('publishStack accepts an unchanged already-registered stack without creating or extending one', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    await registerOpenStack(harness)

    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
    assert.deepEqual(preview.blockers, [])

    const inner = createGitHubApiDouble()
    const stackWrites: string[] = []
    setGitHubTransport(
      new DirectGitHubTransport({
        token: 'fixture-token',
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : (input as string))
          const method = init?.method ?? 'GET'
          if (
            method !== 'GET' &&
            /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/stacks/u.test(url)
          )
            stackWrites.push(`${method} ${url}`)
          return inner(input, init)
        }) as typeof globalThis.fetch,
      }),
    )

    const published = await runStackAction(harness.repo, publishAction(preview.token))
    assert.match(published.message, /Published 3 stack pull requests/u)
    assert.deepEqual(stackWrites, [])
  })
})

test('publishStack rejects an already-registered stack another actor unstacked before the final re-read', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    await registerOpenStack(harness)

    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
    assert.deepEqual(preview.blockers, [])

    const inner = createGitHubApiDouble()
    const stackWrites: string[] = []
    let topReadback = false
    let armed = true
    setGitHubTransport(
      new DirectGitHubTransport({
        token: 'fixture-token',
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : (input as string))
          const method = init?.method ?? 'GET'
          if (
            method !== 'GET' &&
            /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/stacks/u.test(url)
          )
            stackWrites.push(`${method} ${url}`)
          // The readback of the top published pull request is the last request before the native
          // stack step, so the stacks listing that follows it is the one selecting the
          // registration target.
          const body = url.endsWith('/graphql') ? String(init?.body ?? '') : ''
          if (body.includes('pullRequest(number: $number)') && body.includes('"number":103'))
            topReadback = true
          const response = await inner(input, init)
          // The external unstack lands right after that listing, so the canonical re-read that
          // follows observes the same published pull requests with no stack membership at all.
          if (armed && topReadback && method === 'GET' && url === STACKS_LISTING) {
            armed = false
            await unstackExternally(inner, 99)
          }
          return response
        }) as typeof globalThis.fetch,
      }),
    )

    await assert.rejects(
      runStackAction(harness.repo, publishAction(preview.token)),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'invalid-chain' &&
        /no longer registered in native stack #99/u.test(error.message),
    )
    assert.equal(armed, false)
    assert.deepEqual(stackWrites, [])
    // The unstacked registration is gone and the failed publication must not recreate it.
    assert.deepEqual((await harness.readState()).stacks, [])
    assert.equal((await listPullRequestStacks('acme', 'widgets')).length, 0)
  })
})

test('publishStack rejects extending a partially registered stack when an already-registered pull request drifts', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    await registerBottomOnlyStack(harness)

    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
    assert.deepEqual(preview.blockers, [])

    const inner = createGitHubApiDouble()
    const stackWrites: string[] = []
    let topReadback = false
    let armed = true
    setGitHubTransport(
      new DirectGitHubTransport({
        token: 'fixture-token',
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : (input as string))
          const method = init?.method ?? 'GET'
          if (
            method !== 'GET' &&
            /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/stacks/u.test(url)
          )
            stackWrites.push(`${method} ${url}`)
          // The readback of the top published pull request is the last request before the
          // registration target is chosen from the unparameterized stacks listing.
          const body = url.endsWith('/graphql') ? String(init?.body ?? '') : ''
          if (body.includes('pullRequest(number: $number)') && body.includes('"number":103'))
            topReadback = true
          const response = await inner(input, init)
          // The already-registered pull request is force-pushed after the stack that holds it
          // was selected, so only the append that follows can observe the moved commit.
          if (armed && topReadback && method === 'GET' && url === STACKS_LISTING) {
            armed = false
            await applyExternalDrift(harness, 'force-push')
          }
          return response
        }) as typeof globalThis.fetch,
      }),
    )

    await assert.rejects(
      runStackAction(harness.repo, publishAction(preview.token)),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'invalid-chain' &&
        /Pull request #101 head moved to/u.test(error.message),
    )
    assert.equal(armed, false)
    assert.deepEqual(stackWrites, [])
    // The already-registered member is left alone: nothing appended, nothing recreated.
    assert.deepEqual(
      (await harness.readState()).stacks?.flatMap((stack) =>
        stack.pull_requests.map((pr) => pr.number),
      ),
      [101],
    )
  })
})

test('publishStack extends an unchanged partially registered stack with one append', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    await registerBottomOnlyStack(harness)

    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
    assert.deepEqual(preview.blockers, [])

    const inner = createGitHubApiDouble()
    const stackWrites: string[] = []
    setGitHubTransport(
      new DirectGitHubTransport({
        token: 'fixture-token',
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : (input as string))
          const method = init?.method ?? 'GET'
          if (
            method !== 'GET' &&
            /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/stacks/u.test(url)
          )
            stackWrites.push(`${method} ${url}`)
          return inner(input, init)
        }) as typeof globalThis.fetch,
      }),
    )

    const published = await runStackAction(harness.repo, publishAction(preview.token))
    assert.match(published.message, /Published 3 stack pull requests/u)
    // The already-registered pull request keeps stack #99, so only the missing members are added.
    assert.deepEqual(stackWrites, ['POST https://api.github.com/repos/acme/widgets/stacks/99/add'])
    assert.deepEqual(
      (await harness.readState()).stacks?.flatMap((stack) =>
        stack.pull_requests.map((pr) => pr.number),
      ),
      [101, 102, 103],
    )
  })
})

test('an already-registered stack must record the current head commit of every published pull request', async () => {
  const published: PullRequest[] = [
    {
      number: 101,
      title: 'Step 1 PR',
      url: 'https://github.com/acme/widgets/pull/101',
      head: 'feature/step-1',
      base: 'main',
      state: 'OPEN',
      draft: false,
      checks: 'none',
      headOid: 'a'.repeat(40),
    },
    {
      number: 102,
      title: 'Step 2 PR',
      url: 'https://github.com/acme/widgets/pull/102',
      head: 'feature/step-2',
      base: 'feature/step-1',
      state: 'OPEN',
      draft: false,
      checks: 'none',
      headOid: 'b'.repeat(40),
    },
  ]
  const stack: NativeStack = {
    id: 99_000,
    number: 99,
    url: 'https://api.github.com/repos/acme/widgets/stacks/99',
    base: 'main',
    open: true,
    createdAt: '2026-01-01T00:00:00Z',
    size: 2,
    status: 'valid',
    pullRequests: [
      {
        number: 101,
        position: 1,
        total: 2,
        head: 'feature/step-1',
        headSha: 'a'.repeat(40),
        base: 'main',
        state: 'OPEN',
        draft: false,
      },
      {
        number: 102,
        position: 2,
        total: 2,
        head: 'feature/step-2',
        headSha: 'b'.repeat(40),
        base: 'feature/step-1',
        state: 'OPEN',
        draft: false,
      },
    ],
  }

  // The matched stack still records the published commits and bases, so the no-write path holds.
  assert.deepEqual(validatePublishedStackRegistration(stack, published), {
    status: 'valid',
    valid: true,
  })
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    await registerOpenStack(harness)
    const current = await Promise.all(
      [101, 102, 103].map((number) => getPullRequest(harness.repo, number)),
    )
    const registered = await listPullRequestStacks('acme', 'widgets')
    assert.equal(registered.length, 1)
    const revalidated = await revalidatePublishedStackRegistration(
      'acme',
      'widgets',
      registered[0],
      current,
    )
    assert.deepEqual(revalidated, { status: 'valid', valid: true })
  })

  const staleHead = {
    ...stack,
    pullRequests: stack.pullRequests.map((member) =>
      member.number === 102 ? { ...member, headSha: 'c'.repeat(40) } : member,
    ),
  }
  const headResult = validatePublishedStackRegistration(staleHead, published)
  assert.equal(headResult.valid, false)
  assert.match(headResult.message ?? '', /at c{40} rather than b{40}/u)
})

test('revalidating an already-registered publication rejects a pull request GitHub reports in another stack', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    // GitHub answers the bottom pull request with stack #100 membership while the listing that
    // selected the registration target still reported stack #99.
    await registerOpenStack(harness, 100)

    const listed = await listPullRequestStacks('acme', 'widgets')
    const matched = listed.find((stack) => stack.number === 99)
    assert.ok(matched)
    const captured = [101, 102, 103].map((number) => getPullRequest(harness.repo, number))
    const published = await Promise.all(captured)

    await assert.rejects(
      revalidatePublishedStackRegistration('acme', 'widgets', matched, published),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'duplicate-pr' &&
        /already in stack #100/u.test(error.message),
    )
  })
})

test('publishStack propagates native stack probe failures instead of reporting chained success', async () => {
  const cases: Array<{
    name: string
    failure: NonNullable<GitHubFixtureState['stacksFailure']>
    expected: RegExp
  }> = [
    {
      name: 'authentication failure',
      failure: { status: 401, reason: 'Unauthorized', message: 'Bad credentials' },
      expected: /401/u,
    },
    {
      name: 'primary rate limit',
      failure: {
        status: 403,
        reason: 'Forbidden',
        message: 'API rate limit exceeded',
        rateLimitRemaining: 0,
      },
      expected: /rate limit/iu,
    },
    {
      name: 'server error',
      failure: { status: 500, reason: 'Internal Server Error', message: 'boom' },
      expected: /500/u,
    },
  ]
  for (const testCase of cases) {
    await withHarness(async (harness) => {
      await setupThreeBranches(harness)
      const state = await harness.readState()
      state.stacksFailure = testCase.failure
      await harness.writeState(state)

      const snapshot = await getSnapshot(harness.repo)
      const preview = await previewStack(harness.repo, snapshot, 'publish', 'feature/step-2')
      assert.deepEqual(preview.blockers, [], testCase.name)
      await assert.rejects(
        runStackAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          draft: false,
          titles: { 'feature/step-1': 'Step 1 PR', 'feature/step-2': 'Step 2 PR' },
          mergeMethod: 'squash',
        }),
        testCase.expected,
        testCase.name,
      )
      assert.deepEqual((await harness.readState()).stacks ?? [], [], testCase.name)
    })
  }
})

test('publishStack propagates a native stack probe timeout', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const inner = createGitHubApiDouble()
    const hangingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : (input as string))
      if (!url.includes('/stacks')) return inner(input, init)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }) as typeof globalThis.fetch
    setGitHubTransport(
      new DirectGitHubTransport({ token: 'fixture-token', fetch: hangingFetch, timeoutMs: 40 }),
    )

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
      /did not complete within/iu,
    )
  })
})
