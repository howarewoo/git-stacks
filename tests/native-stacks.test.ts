import assert from 'node:assert/strict'
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  createGitHubHarness,
  type GitHubFixtureState,
  type GitHubHarness,
} from './fixtures/github-harness'
import type { NativeStack, PublishLayerChoice, PullRequest } from '../src/shared/types'
/** github.com's own context, written out so importing the host module cannot pull
 * `git-core` (and the real `execFile`) in before this file's harness patches it. */
const DOTCOM = {
  host: 'github.com',
  sshHost: 'github.com',
  dotcom: true,
  webOrigin: 'https://github.com',
  apiBase: 'https://api.github.com',
  graphqlUrl: 'https://api.github.com/graphql',
} as const

/** Every native stack call in this file is bound to github.com. */
const HOST = DOTCOM
const HOST_ONLY = { host: DOTCOM }

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
  retireLegacyStackComments,
  unstackPullRequests,
  validateNativeStackChain,
  validatePublishedStackRegistration,
} = await import('../src/main/native-stacks')
const { getSubmitStackProgress, previewStack, runStackAction } = await import('../src/main/stacks')

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

/** Three stacked local branches with no remote branch and no pull request: the zero case. */
async function setupFreshBranches(harness: GitHubHarness): Promise<void> {
  git(harness, ['checkout', '-b', 'feature/step-1'])
  git(harness, ['commit', '--allow-empty', '-m', 'step 1'])
  git(harness, ['checkout', '-b', 'feature/step-2'])
  git(harness, ['commit', '--allow-empty', '-m', 'step 2'])
  git(harness, ['checkout', '-b', 'feature/step-3'])
  git(harness, ['commit', '--allow-empty', '-m', 'step 3'])
  const state = await harness.readState()
  state.prs = []
  state.stacks = []
  state.nextNumber = 101
  await harness.writeState(state)
}

/** The layer choices the resumed submission publishes, one per branch, all ready for review. */
const freshLayers = (): Record<string, PublishLayerChoice> =>
  Object.fromEntries(
    ['feature/step-1', 'feature/step-2', 'feature/step-3'].map((branch) => [
      branch,
      { title: `${branch} PR`, body: '', draft: false, updateBase: false },
    ]),
  )

test('detectNativeStacksCapability returns true when preview endpoint responds', async () => {
  await withHarness(async (harness) => {
    const capability = await detectNativeStacksCapability('acme', 'widgets', HOST_ONLY)
    assert.equal(capability.available, true)

    // Disable preview
    const state = await harness.readState()
    state.stacksPreviewDisabled = true
    await harness.writeState(state)

    const disabledCap = await detectNativeStacksCapability('acme', 'widgets', HOST_ONLY)
    assert.equal(disabledCap.available, false)
    // A host that does not serve the resource degrades to a state the publish
    // path branches on: it is not an error, and it is not a claim about the
    // host either. A host that refused the credential raises instead, which
    // `github-host.test.ts` covers against both a real and a doubled host.
    assert.equal(disabledCap.state, 'preview-unavailable')
  })
})

test('create, list, get, add, and unstack native pull request stacks', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    // 1. Create a native stack with PRs [101, 102]
    const created = await createPullRequestStack('acme', 'widgets', [101, 102], HOST_ONLY)
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
    const fetched = await getPullRequestStack('acme', 'widgets', 1, HOST_ONLY)
    assert.equal(fetched.number, 1)
    assert.equal(fetched.pullRequests.length, 2)

    // 3. List stacks with pagination and filter
    const listed = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].number, 1)

    const filtered = await listPullRequestStacks('acme', 'widgets', { host: HOST, pullRequest: 102 })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].number, 1)

    const emptyFilter = await listPullRequestStacks('acme', 'widgets', { host: HOST, pullRequest: 999 })
    assert.equal(emptyFilter.length, 0)

    // 4. Add PR 103 to the stack
    const extended = await addPullRequestsToStack('acme', 'widgets', 1, [103], HOST_ONLY)
    assert.equal(extended.pullRequests.length, 3)
    assert.equal(extended.pullRequests[2].number, 103)
    assert.equal(extended.pullRequests[2].position, 3)
    assert.equal(extended.pullRequests[2].base, 'feature/step-2')

    // 5. Unstack pull requests
    const unstacked = await unstackPullRequests('acme', 'widgets', 1, HOST_ONLY)
    assert.equal(unstacked.dissolved, true)
    assert.equal(unstacked.stack, null)

    const listAfterUnstack = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
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
      createPullRequestStack('acme', 'widgets', [101, 102], { host: HOST, knownPullRequests: [known] }),
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
      createPullRequestStack('acme', 'widgets', [101, 102], HOST_ONLY),
      (error) => error instanceof NativeStackError && error.status === 'cross-fork-head',
    )
    assert.deepEqual((await harness.readState()).stacks, [])

    state.prs[1].headRepository = 'acme/widgets'
    state.prs[1].state = 'CLOSED'
    await harness.writeState(state)
    await assert.rejects(
      createPullRequestStack('acme', 'widgets', [101, 102], HOST_ONLY),
      (error) => error instanceof NativeStackError && error.status === 'closed',
    )
    assert.deepEqual((await harness.readState()).stacks, [])

    await createPullRequestStack('acme', 'widgets', [101], HOST_ONLY)
    await assert.rejects(
      addPullRequestsToStack('acme', 'widgets', 1, [102], { host: HOST, knownPullRequests: [known] }),
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
      addPullRequestsToStack('acme', 'widgets', 1, [103], HOST_ONLY),
      (error) => error instanceof NativeStackError && error.status === 'closed',
    )

    stacked.stacks![0].open = true
    stacked.stacks![0].pull_requests[0].state = 'closed'
    stacked.stacks![0].pull_requests[0].merged_at = new Date().toISOString()
    await harness.writeState(stacked)
    await assert.rejects(
      addPullRequestsToStack('acme', 'widgets', 1, [103], HOST_ONLY),
      (error) => error instanceof NativeStackError && error.status === 'completed',
    )
  })
})

test('handles 404 not found and 422 validation failure gracefully', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    // 404 on nonexistent stack
    await assert.rejects(
      async () => getPullRequestStack('acme', 'widgets', 9999, HOST_ONLY),
      /Stack #9999 not found|404/u,
    )

    // 422 on invalid PR addition (e.g. duplicate or out of order)
    await createPullRequestStack('acme', 'widgets', [101], HOST_ONLY)
    await assert.rejects(
      async () => addPullRequestsToStack('acme', 'widgets', 1, [101], HOST_ONLY),
      /already in stack|duplicate/u,
    )
  })
})

test('reloads native stack from GitHub after restart without app metadata', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)

    // Create a native stack on origin
    await createPullRequestStack('acme', 'widgets', [101, 102, 103], HOST_ONLY)

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
      type: 'submitStack',
      token: preview.token,
      allowForce: false,
      layers: {
        'feature/step-1': { title: 'Step 1 PR', body: '', draft: false, updateBase: true },
        'feature/step-2': { title: 'Step 2 PR', body: '', draft: false, updateBase: true },
      },
    })
    assert.match(publishRes.message, /Submitted 3 stack layers/u)

    const stacks = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
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
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: {
          'feature/step-1': { title: 'Step 1 PR', body: '', draft: false, updateBase: true },
          'feature/step-2': { title: 'Step 2 PR', body: '', draft: false, updateBase: true },
          'feature/step-3': { title: 'Step 3 PR', body: '', draft: false, updateBase: true },
        },
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
      createPullRequestStack('acme', 'widgets', [101, 102], { host: HOST, knownPullRequests: [captured] }),
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
      createPullRequestStack('acme', 'widgets', [101, 102], { host: HOST, knownPullRequests: [captured] }),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'invalid-chain' &&
        /head moved to/u.test(error.message),
    )
    assert.deepEqual((await harness.readState()).stacks, [])

    // A re-read model matches the current head, so the same publication proceeds.
    const refreshed = await getPullRequest(harness.repo, 101)
    const created = await createPullRequestStack('acme', 'widgets', [101, 102], {
      host: HOST,
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
      type: 'submitStack',
      token: preview.token,
      allowForce: false,
      layers: {
        'feature/step-1': { title: 'Step 1 PR', body: '', draft: false, updateBase: true },
        'feature/step-2': { title: 'Step 2 PR', body: '', draft: false, updateBase: true },
      },
    })
    assert.match(published.message, /Submitted 3 stack layers/u)
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
        type: 'submitStack',
        token: closedPreview.token,
        allowForce: false,
        layers: {
          'feature/step-1': { title: 'Step 1 PR', body: '', draft: false, updateBase: true },
          'feature/step-2': { title: 'Step 2 PR', body: '', draft: false, updateBase: true },
          'feature/step-3': { title: 'Step 3 PR', body: '', draft: false, updateBase: true },
        },
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

/**
 * A submission that approves no base change, so an external retarget stays observable. Tests
 * that genuinely need a layer retargeted pass the branches to approve.
 */
function publishAction(token: string, approveBase: string[] = []) {
  const layer = (branch: string) => ({
    title: `${branch} PR`,
    body: '',
    draft: false,
    updateBase: approveBase.includes(branch),
  })
  return {
    type: 'submitStack' as const,
    token,
    allowForce: false,
    layers: {
      'feature/step-1': layer('feature/step-1'),
      'feature/step-2': layer('feature/step-2'),
      'feature/step-3': layer('feature/step-3'),
    },
  }
}

/**
 * A merge preview is still executed with the plain execute action; only a Submit Stack preview
 * carries the per-layer choices that `publishAction` supplies.
 */
function mergeAction(token: string) {
  return {
    type: 'executeStack' as const,
    token,
    allowForce: false,
    mergeMethod: 'merge' as const,
    mergeAction: 'direct_merge' as const,
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
        drift === 'force-push'
          ? /Pull request #101 (head moved to|is registered in stack #99 at .* rather than)/u
          : /(?:base changed from main to release|now based on release, not main)/u,
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
    const prior = await harness.readState()
    prior.comments['101'] = [
      {
        id: 50,
        body: '<!-- git-stacks:stack-links:v1 -->\nStack navigation:\n- old: #101\n<!-- /git-stacks:stack-links:v1 -->',
        author: prior.currentUser,
      },
    ]
    await harness.writeState(prior)

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
    assert.match(published.message, /Submitted 3 stack layers/u)
    assert.deepEqual(stackWrites, [])
    assert.match((await harness.readState()).comments['101'][0].body, /Stack navigation retired/u)
  })
})

test('registration rejects a selected publication that omits a middle native member', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    await registerOpenStack(harness)
    const stack = (await listPullRequestStacks('acme', 'widgets', HOST_ONLY))[0]
    const selected = await Promise.all(
      [101, 103].map((number) => getPullRequest(harness.repo, number)),
    )
    const result = validatePublishedStackRegistration(stack, selected)
    assert.equal(result.valid, false)
    assert.match(result.message ?? '', /not contiguous/u)
  })
})

test('native stack merge uses merge-async and confirms the completed request', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    await registerOpenStack(harness)
    const state = await harness.readState()
    state.prs[0].checks = 'passing'
    state.prs[0].reviewDecision = 'APPROVED'
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'feature/step-1',
    )
    assert.deepEqual(preview.blockers, [])
    const inner = createGitHubApiDouble()
    const mergeRequests: string[] = []
    setGitHubTransport(
      new DirectGitHubTransport({
        token: 'fixture-token',
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : (input as string))
          if (url.includes('/merge')) mergeRequests.push(`${init?.method ?? 'GET'} ${url}`)
          return inner(input, init)
        }) as typeof globalThis.fetch,
      }),
    )
    const result = await runStackAction(harness.repo, mergeAction(preview.token))
    assert.match(result.message, /Merged pull request #101/u)
    const after = await harness.readState()
    assert.equal(after.prs[0].state, 'MERGED')
    assert.ok(after.prs[0].mergeOid)
    assert.equal(after.asyncMerge, undefined)
    assert.deepEqual(mergeRequests, [
      'PUT https://api.github.com/repos/acme/widgets/pulls/101/merge-async',
      'GET https://api.github.com/repos/acme/widgets/pulls/101/merge-async/fixture-101',
    ])
  })
})

test('retiring legacy comments preserves human text and other authors comments', async () => {
  await withHarness(async (harness) => {
    const marker = '<!-- git-stacks:stack-links:v1 -->'
    const state = await harness.readState()
    state.comments['101'] = [
      {
        id: 50,
        body: `${marker}\nStack navigation:\n- old: #101\n<!-- /git-stacks:stack-links:v1 -->\nHuman note`,
        author: state.currentUser,
      },
      {
        id: 51,
        body: `${marker}\nOther author's navigation\n<!-- /git-stacks:stack-links:v1 -->`,
        author: 'someone-else',
      },
    ]
    await harness.writeState(state)
    await retireLegacyStackComments('acme/widgets', [101], HOST_ONLY)
    const after = await harness.readState()
    assert.equal(
      after.comments['101'][0].body,
      "Stack navigation retired; use GitHub's native stack view.\nHuman note",
    )
    assert.equal(after.comments['101'][1].body, state.comments['101'][1].body)
    await retireLegacyStackComments('acme/widgets', [101], HOST_ONLY)
    assert.equal((await harness.readState()).comments['101'][0].body, after.comments['101'][0].body)
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
          // The canonical readback of the top published pull request is the last request
          // before the append, so the unstack that lands on it must be observed by the
          // registration check that follows.
          const body = url.endsWith('/graphql') ? String(init?.body ?? '') : ''
          if (body.includes('pullRequest(number: $number)') && body.includes('"number":103'))
            topReadback = true
          const response = await inner(input, init)
          if (armed && topReadback && method === 'GET' && url === STACKS_LISTING) {
            armed = false
            await unstackExternally(inner, 99)
          }
          return response
        }) as typeof globalThis.fetch,
      }),
    )

    await assert.rejects(
      runStackAction(
        harness.repo,
        publishAction(preview.token, ['feature/step-1', 'feature/step-2', 'feature/step-3']),
      ),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'invalid-chain' &&
        /no longer registered in native stack #99/u.test(error.message),
    )
    assert.equal(armed, false)
    assert.deepEqual(stackWrites, [])
    // The unstacked registration is gone and the failed publication must not recreate it.
    assert.deepEqual((await harness.readState()).stacks, [])
    assert.equal((await listPullRequestStacks('acme', 'widgets', HOST_ONLY)).length, 0)
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
          // The canonical readback of the top published pull request is the last request
          // before the append.
          const readback = url.endsWith('/graphql') ? String(init?.body ?? '') : ''
          if (
            readback.includes('pullRequest(number: $number)') &&
            readback.includes('"number":103')
          )
            topReadback = true
          const response = await inner(input, init)
          // The already-registered pull request is force-pushed after the stack that holds it
          // was selected, so only the append that follows can observe the moved commit.
          // The already-registered pull request is force-pushed after the stack that holds it
          // was listed, so only the registration check that follows can observe the moved
          // commit.
          if (armed && topReadback && method === 'GET' && url === STACKS_LISTING) {
            armed = false
            await applyExternalDrift(harness, 'force-push')
          }
          return response
        }) as typeof globalThis.fetch,
      }),
    )

    await assert.rejects(
      runStackAction(
        harness.repo,
        publishAction(preview.token, ['feature/step-1', 'feature/step-2', 'feature/step-3']),
      ),
      (error) =>
        error instanceof NativeStackError &&
        error.status === 'invalid-chain' &&
        /Pull request #101 (head moved to|is registered in stack #99 at .* rather than)/u.test(
          error.message,
        ),
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
    assert.match(published.message, /Submitted 3 stack layers/u)
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
    const registered = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
    assert.equal(registered.length, 1)
    const revalidated = await revalidatePublishedStackRegistration(
      'acme',
      'widgets',
      registered[0],
      current,
      HOST_ONLY,
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

    const listed = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
    const matched = listed.find((stack) => stack.number === 99)
    assert.ok(matched)
    const captured = [101, 102, 103].map((number) => getPullRequest(harness.repo, number))
    const published = await Promise.all(captured)

    await assert.rejects(
      revalidatePublishedStackRegistration('acme', 'widgets', matched, published, HOST_ONLY),
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
          type: 'submitStack',
          token: preview.token,
          allowForce: false,
          layers: {
            'feature/step-1': { title: 'Step 1 PR', body: '', draft: false, updateBase: true },
            'feature/step-2': { title: 'Step 2 PR', body: '', draft: false, updateBase: true },
          },
        }),
        testCase.expected,
        testCase.name,
      )
      assert.deepEqual((await harness.readState()).stacks ?? [], [], testCase.name)
    })
  }
})

test('a native stack probe timeout holds the publish instead of planning an ordinary chain', async () => {
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
    // A host that did not answer is not a host without native stacks, so nothing
    // is planned as an ordinary chain and the preview names what is unestablished.
    assert.match(preview.blockers.join('\n'), /could not be established/iu)
    assert.doesNotMatch(preview.warnings.join('\n'), /does not serve native stacks/iu)
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: {
          'feature/step-1': { title: 'Step 1 PR', body: '', draft: false, updateBase: true },
          'feature/step-2': { title: 'Step 2 PR', body: '', draft: false, updateBase: true },
          'feature/step-3': { title: 'Step 3 PR', body: '', draft: false, updateBase: true },
        },
      }),
      /could not be established/iu,
    )
  })
})

test('a submission recovers a pull request whose creation response was lost', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    const state = await harness.readState()
    // GitHub opens the middle pull request and the response never arrives.
    state.lostResponses = [
      { method: 'POST', pathIncludes: '/pulls', status: 502, message: 'Bad gateway' },
    ]
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: freshLayers(),
      }),
    )
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')

    const resumed = await runStackAction(harness.repo, { type: 'submitStackRetry' })
    assert.match(resumed.message, /Submitted \d+ stack layer/iu)
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')

    // Exactly one pull request per submitted branch: the recovered one was adopted, not
    // duplicated, and the lost response cost no second pull request.
    const after = await harness.readState()
    const open = after.prs.filter((pr) => pr.state === 'OPEN')
    assert.equal(new Set(open.map((pr) => pr.head)).size, open.length)
    assert.ok(open.length > 0)
    const stacks = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
    assert.equal(stacks.length, 1)
    assert.equal(stacks[0].pullRequests.length, open.length)
  })
})

test('a submission recovers a native stack whose creation response was lost', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    const state = await harness.readState()
    // GitHub registers the stack and the response never arrives.
    state.lostResponses = [
      { method: 'POST', pathIncludes: 'stacks', status: 502, message: 'Bad gateway' },
    ]
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: freshLayers(),
      }),
    )
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')

    const resumed = await runStackAction(harness.repo, { type: 'submitStackRetry' })
    assert.match(resumed.message, /Submitted \d+ stack layer/iu)
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')

    // The stack GitHub already holds is adopted rather than created a second time.
    const stacks = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
    assert.equal(stacks.length, 1)
    const open = (await harness.readState()).prs.filter((pr) => pr.state === 'OPEN')
    assert.equal(stacks[0].pullRequests.length, open.length)
  })
})

test('a resumed submission refuses to stack a head somebody else moved after the push', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    const state = await harness.readState()
    state.lostResponses = [
      { method: 'POST', pathIncludes: '/pulls', status: 502, message: 'Bad gateway' },
    ]
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: freshLayers(),
      }),
    )
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')

    // A resume skips the push steps that already completed, so the journal is the only record
    // of what was reviewed. Somebody replaces the remote tip and GitHub follows it.
    git(harness, ['checkout', 'main'])
    git(harness, ['checkout', '-B', 'feature/step-2'])
    git(harness, ['commit', '--allow-empty', '-m', 'somebody else'])
    git(harness, ['push', '--force', harness.bare, 'feature/step-2:refs/heads/feature/step-2'])
    const moved = git(harness, ['rev-parse', 'feature/step-2'])

    await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
    const progress = await getSubmitStackProgress(harness.repo)
    assert.equal(progress?.status, 'failed')
    const failed = progress?.steps.find((step) => step.status === 'failed')
    assert.match(failed?.failure?.summary ?? '', new RegExp(moved.slice(0, 8), 'iu'))

    // The submission stopped at the drift instead of registering a chain over somebody
    // else's commit.
    assert.equal((await listPullRequestStacks('acme', 'widgets', HOST_ONLY)).length, 0)
  })
})

test('a resumed ordinary chain is refused once the host serves native stacks', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    const state = await harness.readState()
    // The host refuses the stacks resource, so the preview plans an ordinary
    // chain, and the answer to the first pull request never arrives, so the
    // submission stops with layers still to publish.
    state.stacksPreviewDisabled = true
    state.lostResponses = [
      { method: 'POST', pathIncludes: '/pulls', status: 502, message: 'Bad gateway' },
    ]
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    assert.deepEqual(preview.blockers, [])
    assert.match(preview.warnings.join('\n'), /does not serve native stacked pull requests/iu)
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: freshLayers(),
      }),
    )
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
    const published = (await harness.readState()).prs.length

    // The host starts serving the stacks resource while the submission waits.
    const serving = await harness.readState()
    serving.stacksPreviewDisabled = false
    serving.lostResponses = []
    await harness.writeState(serving)

    await assert.rejects(
      runStackAction(harness.repo, { type: 'submitStackRetry' }),
      /now answers for native stacks/iu,
    )
    // The proof runs before the first mutating step, so the refusal published
    // nothing: the resume is what would have opened the remaining pull requests.
    assert.equal((await harness.readState()).prs.length, published)
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')

    // A host that still refuses it is proved again on every resume, and the
    // submission finishes as the ordinary chain it was reviewed as.
    const refusing = await harness.readState()
    refusing.stacksPreviewDisabled = true
    await harness.writeState(refusing)
    const resumed = await runStackAction(harness.repo, { type: 'submitStackRetry' })
    assert.match(resumed.message, /Submitted \d+ stack layer/iu)
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
    // Nothing was registered as a native stack: the chain was published as the
    // ordinary one it was reviewed as, and the host is asked again for its own
    // answer to prove it.
    const answering = await harness.readState()
    answering.stacksPreviewDisabled = false
    await harness.writeState(answering)
    assert.equal((await listPullRequestStacks('acme', 'widgets', HOST_ONLY)).length, 0)
  })
})

test('a native stack 422 is reported as a rejected chain rather than a retryable fault', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const state = await harness.readState()
    // GitHub refuses the chain write with a validation failure.
    state.stacksFailure = { status: 422, reason: 'Unprocessable Entity', message: 'Invalid chain' }
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: freshLayers(),
      }),
    )
    const progress = await getSubmitStackProgress(harness.repo)
    assert.equal(progress?.status, 'failed')
    const failed = progress?.steps.find((step) => step.status === 'failed')
    assert.equal(failed?.failure?.retryable, false)
    assert.match(failed?.failure?.recovery ?? '', /fresh preview/iu)
  })
})

test('a recovered stack creation is not rejected when the interruption repeats', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    const state = await harness.readState()
    state.lostResponses = [
      { method: 'POST', pathIncludes: 'stacks', status: 502, message: 'Bad gateway' },
    ]
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: freshLayers(),
      }),
    )

    // GitHub created the stack; the response never arrived.
    const stacks = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
    assert.equal(stacks.length, 1)
    assert.equal(stacks[0].pullRequests.length, 1)

    // The recovery journals the stack number, so an interruption before the step is marked
    // complete leaves a submission that already has one. That is the state a person finds
    // after a second crash, and the retry has to finish rather than call its own stack stale.
    const journalPath = path.resolve(
      harness.repo,
      git(harness, ['rev-parse', '--git-common-dir']).trim(),
      'git-stacks-publish.json',
    )
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      stackNumber: number | null
      steps: Array<{ kind: string; status: string }>
    }
    assert.equal(journal.stackNumber, null)
    journal.stackNumber = stacks[0].number
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')

    const resumed = await runStackAction(harness.repo, { type: 'submitStackRetry' })
    assert.match(resumed.message, /Submitted \d+ stack layer/iu)
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
    assert.equal((await listPullRequestStacks('acme', 'widgets', HOST_ONLY)).length, 1)
  })
})

test('a stack is never written over a head that moves after the first proof', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    // A commit that exists but is not on the reviewed branch, so it can be pushed over the
    // branch tip without the local review seeing it first.
    git(harness, ['checkout', '-b', 'somebody-else'])
    git(harness, ['commit', '--allow-empty', '-m', 'somebody else'])
    const foreign = git(harness, ['rev-parse', 'somebody-else'])
    // The commit reaches the remote, so the tip can be moved onto it.
    git(harness, ['push', harness.bare, 'somebody-else:refs/heads/somebody-else'])
    git(harness, ['checkout', 'feature/step-3'])

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    assert.deepEqual(preview.blockers, [])

    // The tip moves during the membership lookup after the API head is read.
    // Creation readback may reject this before the final stack boundary is reached.
    const state = await harness.readState()
    state.driftOnRequest = [
      { pathIncludes: 'stacks?pull_request=', ref: 'refs/heads/feature/step-2', to: foreign },
    ]
    await harness.writeState(state)
    // The write is refused rather than registering a stack over a head nobody reviewed.
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: freshLayers(),
      }),
    )
    assert.equal((await listPullRequestStacks('acme', 'widgets', HOST_ONLY)).length, 0)
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
  })
})

test('a resumed submission reports the force consent the retry will use', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    const state = await harness.readState()
    state.lostResponses = [
      { method: 'POST', pathIncludes: '/pulls', status: 502, message: 'Bad gateway' },
    ]
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    // The person agrees to replace rewritten branches; a dialog reopened afterwards starts
    // with its own empty checkbox, so the consent has to survive in the journal.
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: true,
        layers: freshLayers(),
      }),
    )
    const progress = await getSubmitStackProgress(harness.repo)
    assert.equal(progress?.status, 'failed')
    assert.equal(progress?.allowForce, true)
    assert.deepEqual(
      progress?.layers.map((layer) => [layer.branch, layer.title, layer.draft]),
      [['feature/step-2', 'feature/step-2 PR', false]],
    )
  })
})

test('a recovered stack whose member pull request was closed is not reported as done', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    const state = await harness.readState()
    // The stack write is the step that fails, so every earlier step is already journalled
    // complete and the retry runs the stack step alone.
    state.lostResponses = [
      { method: 'POST', pathIncludes: 'stacks', status: 502, message: 'Bad gateway' },
    ]
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: freshLayers(),
      }),
    )
    const stacks = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
    assert.equal(stacks.length, 1)
    const memberNumber = stacks[0].pullRequests[0].number

    // Somebody closes the member between failure and retry; the stack still names it.
    const after = await harness.readState()
    const member = after.prs.find((pr) => pr.number === memberNumber)
    assert.ok(member)
    member.state = 'CLOSED'
    const listed = (after.stacks ?? []).find((stack) => stack.number === stacks[0].number)
    const listedMember = listed?.pull_requests.find((item) => item.number === memberNumber)
    assert.ok(listedMember)
    listedMember.state = 'closed'
    await harness.writeState(after)

    await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
  })
})

for (const recordedStack of [false, true]) {
  for (const race of ['close', 'drift'] as const) {
    test(`recovery rejects ${race} after a stale listing with stack number ${recordedStack ? 'saved' : 'unsaved'}`, async () => {
      await withHarness(async (harness) => {
        await setupFreshBranches(harness)
        const reviewed = git(harness, ['rev-parse', 'feature/step-2'])
        git(harness, ['checkout', '-b', 'external-writer'])
        git(harness, ['commit', '--allow-empty', '-m', 'External replacement'])
        const foreign = git(harness, ['rev-parse', 'HEAD'])
        git(harness, ['push', harness.bare, 'external-writer'])
        git(harness, ['checkout', 'feature/step-3'])
        const state = await harness.readState()
        state.lostResponses = [
          { method: 'POST', pathIncludes: 'stacks', status: 502, message: 'Bad gateway' },
        ]
        await harness.writeState(state)
        const preview = await previewStack(
          harness.repo,
          await getSnapshot(harness.repo),
          'publish',
          'feature/step-2',
        )
        await assert.rejects(
          runStackAction(harness.repo, {
            type: 'submitStack',
            token: preview.token,
            allowForce: false,
            layers: freshLayers(),
          }),
          /Bad gateway/iu,
        )
        const after = await harness.readState()
        assert.equal(after.stacks?.length, 1)
        const stack = after.stacks![0]
        const number = stack.pull_requests[0].number
        assert.equal(bareGit(harness, ['rev-parse', 'feature/step-2']), reviewed)
        if (recordedStack) {
          const journalPath = path.resolve(
            harness.repo,
            git(harness, ['rev-parse', '--git-common-dir']),
            'git-stacks-publish.json',
          )
          const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
          assert.equal(journal.stackNumber, null)
          journal.stackNumber = stack.number
          writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
        }
        // Arm only after the capability probe. The first paginated recovery listing
        // then returns its snapshot before the close or force-push lands.
        const pathIncludes = 'repos/acme/widgets/stacks?per_page=1'
        if (race === 'close') {
          after.closeOnRequest = [{ pathIncludes, number, after: 0 }]
        } else {
          after.driftOnRequest = [
            { pathIncludes, ref: 'refs/heads/feature/step-2', to: foreign, after: 0 },
          ]
        }
        const inner = createGitHubApiDouble()
        const armedFetch: typeof globalThis.fetch = async (input, init) => {
          const url = String(input)
          const snapshot = await inner(url.endsWith('/stacks') ? `${url}?per_page=1` : input, init)
          // A force-push can precede the listing snapshot too: both GitHub reads
          // then agree on B, but the immutable journal still requires A.
          const response =
            race === 'drift' && url.endsWith('/stacks') ? await inner(input, init) : snapshot
          if (String(input).endsWith('/stacks?per_page=1')) {
            const current = await harness.readState()
            current.requests = []
            current.closeOnRequest = after.closeOnRequest
            current.driftOnRequest = after.driftOnRequest
            await harness.writeState(current)
          }
          return response
        }
        setGitHubTransport(new DirectGitHubTransport({ token: 'fixture-token', fetch: armedFetch }))
        await assert.rejects(
          runStackAction(harness.repo, { type: 'submitStackRetry' }),
          race === 'close'
            ? /(?:closed|completed)/iu
            : /(?:head moved|no longer matches|rather than)/iu,
        )
        const progress = await getSubmitStackProgress(harness.repo)
        assert.equal(progress?.status, 'failed')
        assert.equal(progress?.steps.find((step) => step.status === 'failed')?.kind, 'create-stack')
        const final = await harness.readState()
        assert.equal(final.stacks?.length, 1)
        assert.equal(
          final.prs.find((pr) => pr.number === number)?.state,
          race === 'close' ? 'CLOSED' : 'OPEN',
        )
        assert.equal(
          bareGit(harness, ['rev-parse', 'feature/step-2']),
          race === 'drift' ? foreign : reviewed,
        )
        assert.equal(
          final.requests?.some(
            (request) => request.argv[1] !== 'GET' && request.argv[0] !== 'graphql',
          ),
          false,
        )
      })
    })
  }
}

for (const replacement of ['same', 'closed', 'replaced'] as const) {
  test(`creation retry preserves the recorded PR when it is ${replacement}`, async () => {
    await withHarness(async (harness) => {
      await setupFreshBranches(harness)
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'feature/step-2',
      )
      const inner = createGitHubApiDouble()
      let created = false
      let failReadback = true
      setGitHubTransport(
        new DirectGitHubTransport({
          token: 'fixture-token',
          fetch: async (input, init) => {
            const url = String(input)
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
            if (
              created &&
              failReadback &&
              url.endsWith('/graphql') &&
              body.variables?.number === 101
            ) {
              failReadback = false
              return new Response(JSON.stringify({ message: 'Readback interrupted' }), {
                status: 503,
              })
            }
            const response = await inner(input, init)
            if (url.endsWith('/pulls') && init?.method === 'POST') created = true
            return response
          },
        }),
      )
      await assert.rejects(
        runStackAction(harness.repo, {
          type: 'submitStack',
          token: preview.token,
          allowForce: false,
          layers: freshLayers(),
        }),
        /Readback interrupted/iu,
      )
      assert.equal((await getSubmitStackProgress(harness.repo))?.layers[0].pullRequest, 101)
      const state = await harness.readState()
      const original = state.prs.find((pr) => pr.number === 101)!
      if (replacement !== 'same') original.state = 'CLOSED'
      if (replacement === 'replaced') {
        state.prs.push({
          ...original,
          number: 102,
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/102',
        })
        state.nextNumber = 103
      }
      state.requests = []
      await harness.writeState(state)
      if (replacement === 'same') {
        await runStackAction(harness.repo, { type: 'submitStackRetry' })
        assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
        assert.deepEqual(
          (await harness.readState()).stacks?.[0].pull_requests.map((pr) => pr.number),
          [101],
        )
      } else {
        await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
        assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
        assert.deepEqual((await harness.readState()).stacks, [])
      }
      assert.equal((await getSubmitStackProgress(harness.repo))?.layers[0].pullRequest, 101)
      const final = await harness.readState()
      assert.equal(
        final.requests.some(
          (request) => request.argv[0] === 'repos/acme/widgets/pulls' && request.argv[1] === 'POST',
        ),
        false,
      )
      assert.equal(git(harness, ['config', '--get', 'branch.feature/step-2.gitStacksPr']), '101')
    })
  })
}

for (const currentBase of ['main', 'feature/step-1', 'release']) {
  test(`retarget retry honors captured and intended bases when current base is ${currentBase}`, async () => {
    await withHarness(async (harness) => {
      await setupThreeBranches(harness)
      git(harness, ['config', '--local', 'branch.feature/step-2.parent', 'feature/step-1'])
      git(harness, [
        'config',
        '--local',
        'branch.feature/step-2.parentTip',
        git(harness, ['rev-parse', 'feature/step-1']),
      ])
      const state = await harness.readState()
      state.prs.find((pr) => pr.number === 102)!.base = 'main'
      await harness.writeState(state)
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'feature/step-2',
      )
      assert.deepEqual(preview.blockers, [])
      const inner = createGitHubApiDouble()
      let interrupt = true
      const patchedBases: string[] = []
      setGitHubTransport(
        new DirectGitHubTransport({
          token: 'fixture-token',
          fetch: async (input, init) => {
            if (String(input).endsWith('/pulls/102') && init?.method === 'PATCH') {
              if (interrupt) {
                interrupt = false
                return new Response(JSON.stringify({ message: 'Retarget interrupted' }), {
                  status: 503,
                })
              }
              patchedBases.push(JSON.parse(String(init.body)).base)
            }
            return inner(input, init)
          },
        }),
      )
      await assert.rejects(
        runStackAction(harness.repo, publishAction(preview.token, ['feature/step-2'])),
        /Retarget interrupted/iu,
      )
      const stopped = await getSubmitStackProgress(harness.repo)
      assert.equal(stopped?.steps.find((step) => step.status === 'failed')?.kind, 'retarget-pr')
      const changed = await harness.readState()
      assert.equal(changed.prs.find((pr) => pr.number === 102)?.base, 'main')
      changed.prs.find((pr) => pr.number === 102)!.base = currentBase
      await harness.writeState(changed)
      if (currentBase === 'release') {
        await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
        assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
        assert.equal(
          (await harness.readState()).prs.find((pr) => pr.number === 102)?.base,
          'release',
        )
        assert.deepEqual(patchedBases, [])
      } else {
        await runStackAction(harness.repo, { type: 'submitStackRetry' })
        assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
        assert.equal(
          (await harness.readState()).prs.find((pr) => pr.number === 102)?.base,
          'feature/step-1',
        )
        assert.deepEqual(patchedBases, currentBase === 'main' ? ['feature/step-1'] : [])
      }
    })
  })
}

test('retarget retry rejects a foreign base before pushing the reviewed branch', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    git(harness, ['config', '--local', 'branch.feature/step-2.parent', 'feature/step-1'])
    git(harness, [
      'config',
      '--local',
      'branch.feature/step-2.parentTip',
      git(harness, ['rev-parse', 'feature/step-1']),
    ])
    const state = await harness.readState()
    state.prs.find((pr) => pr.number === 102)!.base = 'main'
    await harness.writeState(state)
    git(harness, ['commit', '--allow-empty', '-m', 'reviewed child update'])
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    const originalRemote = bareGit(harness, ['rev-parse', 'feature/step-2'])
    const hook = path.join(harness.bare, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "Push interrupted" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    await assert.rejects(
      runStackAction(harness.repo, publishAction(preview.token, ['feature/step-2'])),
      /Push interrupted/iu,
    )
    unlinkSync(hook)
    const changed = await harness.readState()
    changed.prs.find((pr) => pr.number === 102)!.base = 'release'
    await harness.writeState(changed)
    await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
    assert.equal(bareGit(harness, ['rev-parse', 'feature/step-2']), originalRemote)
    const progress = await getSubmitStackProgress(harness.repo)
    assert.equal(progress?.steps.find((step) => step.status === 'failed')?.kind, 'push')
  })
})

for (const drift of ['closed', 'remote', 'local'] as const) {
  test(`retry proves completed lower PR before creating next PR after ${drift} drift`, async () => {
    await withHarness(async (harness) => {
      await setupFreshBranches(harness)
      const branches = ['feature/step-1', 'feature/step-2', 'feature/step-3']
      for (const [index, branch] of branches.entries()) {
        const parent = index === 0 ? 'main' : branches[index - 1]
        git(harness, ['config', '--local', `branch.${branch}.parent`, parent])
        git(harness, [
          'config',
          '--local',
          `branch.${branch}.parentTip`,
          git(harness, ['rev-parse', parent]),
        ])
      }
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'feature/step-2',
      )
      assert.deepEqual(
        preview.publish?.layers.map((layer) => layer.branch),
        branches,
      )
      const inner = createGitHubApiDouble()
      let interrupt = true
      let creations = 0
      const writes: string[] = []
      setGitHubTransport(
        new DirectGitHubTransport({
          token: 'fixture-token',
          fetch: async (input, init) => {
            if (
              (init?.method === 'POST' || init?.method === 'PATCH') &&
              !String(input).endsWith('/graphql')
            )
              writes.push(String(input))
            if (interrupt && String(input).endsWith('/pulls') && init?.method === 'POST') {
              creations++
              if (creations === 2) {
                interrupt = false
                return new Response(JSON.stringify({ message: 'Create interrupted' }), {
                  status: 503,
                })
              }
            }
            return inner(input, init)
          },
        }),
      )
      await assert.rejects(
        runStackAction(harness.repo, {
          type: 'submitStack',
          token: preview.token,
          allowForce: false,
          layers: freshLayers(),
        }),
        /Create interrupted/iu,
      )
      const before = await harness.readState()
      assert.equal(before.prs.length, 1)
      if (drift === 'closed') {
        before.prs[0].state = 'CLOSED'
        await harness.writeState(before)
      } else {
        git(harness, ['checkout', 'main'])
        git(harness, ['checkout', '-B', 'feature/step-1'])
        git(harness, ['commit', '--allow-empty', '-m', 'unreviewed lower tip'])
        if (drift === 'remote') {
          git(harness, [
            'push',
            '--force',
            harness.bare,
            'feature/step-1:refs/heads/feature/step-1',
          ])
        }
      }
      writes.length = 0
      await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
      const after = await harness.readState()
      assert.equal(after.prs.length, 1)
      assert.equal(after.stacks?.length, 0)
      assert.deepEqual(writes, [])
      assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
    })
  })
}

test('retry refuses external native registration after a push failed before create intent', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    git(harness, ['commit', '--allow-empty', '-m', 'Unpublished top commit'])
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    assert.deepEqual(preview.blockers, [])
    const hook = path.join(harness.bare, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho \"Push interrupted\" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    await assert.rejects(
      runStackAction(harness.repo, publishAction(preview.token)),
      /Push interrupted/iu,
    )
    unlinkSync(hook)
    assert.equal(
      (await getSubmitStackProgress(harness.repo))?.steps.find((step) => step.status === 'failed')
        ?.kind,
      'push',
    )
    const external = await createPullRequestStack('acme', 'widgets', [101, 102, 103], HOST_ONLY)
    const state = await harness.readState()
    state.requests = []
    await harness.writeState(state)
    await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
    const progress = await getSubmitStackProgress(harness.repo)
    assert.equal(progress?.status, 'failed')
    assert.equal(progress?.steps.find((step) => step.status === 'failed')?.kind, 'create-stack')
    const final = await harness.readState()
    assert.deepEqual(
      final.stacks?.map((stack) => stack.number),
      [external.number],
    )
    assert.equal(
      final.requests.some(
        (request) => request.argv[0].includes('/stacks') && request.argv[1] !== 'GET',
      ),
      false,
    )
  })
})

test('retry refuses external native registration after create validation failed before the request', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    const inner = createGitHubApiDouble()
    let interrupt = true
    setGitHubTransport(
      new DirectGitHubTransport({
        token: 'fixture-token',
        fetch: async (input, init) => {
          if (interrupt && String(input).endsWith('/pulls/101') && init?.method === 'GET') {
            interrupt = false
            return new Response(JSON.stringify({ message: 'Native validation interrupted' }), {
              status: 503,
            })
          }
          return inner(input, init)
        },
      }),
    )
    await assert.rejects(
      runStackAction(harness.repo, publishAction(preview.token)),
      /Native validation interrupted/iu,
    )
    const progress = await getSubmitStackProgress(harness.repo)
    assert.equal(progress?.steps.find((step) => step.status === 'failed')?.kind, 'create-stack')
    const before = await harness.readState()
    assert.equal(
      before.requests.some(
        (request) => request.argv[0] === 'repos/acme/widgets/stacks' && request.argv[1] === 'POST',
      ),
      false,
    )
    const external = await createPullRequestStack('acme', 'widgets', [101, 102, 103], HOST_ONLY)
    await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
    assert.deepEqual(
      (await harness.readState()).stacks?.map((stack) => stack.number),
      [external.number],
    )
  })
})

for (const resource of ['pulls', 'stacks'] as const) {
  for (const status of [403, 422, 408, 502]) {
    test(`creation outcome ${resource} HTTP ${status} preserves only uncertain recovery`, async () => {
      await withHarness(async (harness) => {
        const rejected = status === 403 || status === 422
        if (resource === 'pulls') await setupFreshBranches(harness)
        else await setupThreeBranches(harness)
        const preview = await previewStack(
          harness.repo,
          await getSnapshot(harness.repo),
          'publish',
          'feature/step-2',
        )
        const inner = createGitHubApiDouble()
        let interrupt = true
        let posts = 0
        setGitHubTransport(
          new DirectGitHubTransport({
            token: 'fixture-token',
            fetch: async (input, init) => {
              if (String(input).endsWith(`/${resource}`) && init?.method === 'POST') {
                posts++
                if (interrupt) {
                  interrupt = false
                  if (!rejected) assert.equal((await inner(input, init)).ok, true)
                  return new Response(JSON.stringify({ message: 'Creation interrupted' }), {
                    status,
                  })
                }
              }
              return inner(input, init)
            },
          }),
        )
        await assert.rejects(
          runStackAction(harness.repo, publishAction(preview.token)),
          /Creation interrupted/iu,
        )
        const stopped = await getSubmitStackProgress(harness.repo)
        assert.equal(
          stopped?.steps.find((step) => step.status === 'failed')?.kind,
          resource === 'pulls' ? 'create-pr' : 'create-stack',
        )
        if (rejected) {
          // A different actor performs the same request only after our definitive rejection.
          const external = await inner(`https://api.github.com/repos/acme/widgets/${resource}`, {
            method: 'POST',
            headers: { authorization: 'Bearer fixture-token' },
            body: JSON.stringify(
              resource === 'pulls'
                ? {
                    head: 'feature/step-2',
                    base: 'main',
                    title: 'External PR',
                    body: '',
                    draft: false,
                  }
                : { pull_requests: [101, 102, 103] },
            ),
          })
          assert.equal(external.ok, true)
          await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
          assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
          if (resource === 'pulls') {
            assert.equal((await getSubmitStackProgress(harness.repo))?.layers[0].pullRequest, null)
            assert.deepEqual((await harness.readState()).stacks, [])
          }
        } else {
          await runStackAction(harness.repo, { type: 'submitStackRetry' })
          assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
          assert.deepEqual(
            (await harness.readState()).stacks?.[0].pull_requests.map((pr) => pr.number),
            resource === 'pulls' ? [101] : [101, 102, 103],
          )
        }
        assert.equal(posts, 1, 'neither recovery nor refusing external work repeats the POST')
      })
    })
  }
}

for (const drift of ['remote', 'local', 'head', 'repository'] as const) {
  test(`retarget retry refuses ${drift} drift before any PATCH`, async () => {
    await withHarness(async (harness) => {
      await setupThreeBranches(harness)
      git(harness, ['config', '--local', 'branch.feature/step-2.parent', 'feature/step-1'])
      git(harness, [
        'config',
        '--local',
        'branch.feature/step-2.parentTip',
        git(harness, ['rev-parse', 'feature/step-1']),
      ])
      const state = await harness.readState()
      state.prs.find((pr) => pr.number === 102)!.base = 'main'
      await harness.writeState(state)
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'feature/step-2',
      )
      const inner = createGitHubApiDouble()
      let patches = 0
      setGitHubTransport(
        new DirectGitHubTransport({
          token: 'fixture-token',
          fetch: async (input, init) => {
            if (String(input).endsWith('/pulls/102') && init?.method === 'PATCH') {
              patches++
              if (patches === 1)
                return new Response(JSON.stringify({ message: 'Retarget interrupted' }), {
                  status: 503,
                })
            }
            return inner(input, init)
          },
        }),
      )
      await assert.rejects(
        runStackAction(harness.repo, publishAction(preview.token, ['feature/step-2'])),
        /Retarget interrupted/iu,
      )
      const stopped = await getSubmitStackProgress(harness.repo)
      assert.equal(
        stopped?.steps.find((step) => step.kind === 'push' && step.branch === 'feature/step-2')
          ?.status,
        'completed',
      )
      const changed = await harness.readState()
      const pr = changed.prs.find((pr) => pr.number === 102)!
      if (drift === 'remote') {
        bareGit(harness, [
          'update-ref',
          'refs/heads/feature/step-2',
          git(harness, ['rev-parse', 'feature/step-1']),
        ])
      } else if (drift === 'local') {
        git(harness, [
          'update-ref',
          'refs/heads/feature/step-2',
          git(harness, ['rev-parse', 'feature/step-1']),
        ])
      } else if (drift === 'head') {
        pr.head = 'feature/step-1'
      } else {
        pr.headRepository = 'someone/widgets'
      }
      await harness.writeState(changed)
      await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
      assert.equal(patches, 1, 'drift must be detected before sending another PATCH')
      assert.equal((await harness.readState()).prs.find((pr) => pr.number === 102)?.base, 'main')
      assert.equal(
        (await getSubmitStackProgress(harness.repo))?.steps.find((step) => step.status === 'failed')
          ?.kind,
        'retarget-pr',
      )
    })
  })
}

test('non-retryable native rejection preserves failure until dismissed without more requests', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    const inner = createGitHubApiDouble()
    let reject = true
    let requests = 0
    setGitHubTransport(
      new DirectGitHubTransport({
        token: 'fixture-token',
        fetch: async (input, init) => {
          requests++
          if (reject && String(input).endsWith('/stacks') && init?.method === 'POST') {
            reject = false
            return new Response(JSON.stringify({ message: 'Invalid chain' }), { status: 422 })
          }
          return inner(input, init)
        },
      }),
    )
    await assert.rejects(
      runStackAction(harness.repo, publishAction(preview.token)),
      /Invalid chain/iu,
    )
    const stopped = await getSubmitStackProgress(harness.repo)
    assert.equal(stopped?.steps.find((step) => step.status === 'failed')?.failure?.retryable, false)
    const before = requests
    await assert.rejects(
      runStackAction(harness.repo, { type: 'submitStackRetry' }),
      /dismiss.*fresh preview/iu,
    )
    assert.equal(requests, before)
    assert.deepEqual(await getSubmitStackProgress(harness.repo), stopped)
    await runStackAction(harness.repo, { type: 'submitStackDismiss' })
    assert.equal(await getSubmitStackProgress(harness.repo), null)
    assert.deepEqual(
      (await harness.readState()).prs.map((pr) => pr.number),
      [101, 102, 103],
    )
  })
})

for (const outcome of ['append', 'no-add'] as const) {
  for (const savedOpen of [true, false]) {
    test(`extend retry rejects moved members before ${outcome} when saved stack is ${savedOpen ? 'open' : 'closed'}`, async () => {
      await withHarness(async (harness) => {
        await setupThreeBranches(harness)
        await registerBottomOnlyStack(harness)
        // Keep A valid and listed after its submitted member is moved to B.
        git(harness, ['checkout', '-b', 'unrelated', 'main'])
        git(harness, ['commit', '--allow-empty', '-m', 'Unrelated stack member'])
        git(harness, ['push', harness.bare, 'unrelated:refs/heads/unrelated'])
        git(harness, ['checkout', 'feature/step-3'])
        const preview = await previewStack(
          harness.repo,
          await getSnapshot(harness.repo),
          'publish',
          'feature/step-2',
        )
        assert.deepEqual(preview.blockers, [])
        assert.equal(preview.publish?.stackNumber, 99)
        const inner = createGitHubApiDouble()
        let interrupt = true
        const writes: string[] = []
        setGitHubTransport(
          new DirectGitHubTransport({
            token: 'fixture-token',
            fetch: async (input, init) => {
              if (
                (init?.method ?? 'GET') !== 'GET' &&
                (!String(input).endsWith('/graphql') || /\bmutation\b/u.test(String(init?.body)))
              ) {
                writes.push(`${init?.method} ${String(input)}`)
              }
              if (
                interrupt &&
                String(input).endsWith('/stacks/99/add') &&
                init?.method === 'POST'
              ) {
                interrupt = false
                return new Response(JSON.stringify({ message: 'Append interrupted' }), {
                  status: 503,
                })
              }
              return inner(input, init)
            },
          }),
        )
        await assert.rejects(
          runStackAction(harness.repo, publishAction(preview.token)),
          /Append interrupted/iu,
        )
        assert.equal(
          (await getSubmitStackProgress(harness.repo))?.steps.find(
            (step) => step.status === 'failed',
          )?.kind,
          'extend-stack',
        )
        const state = await harness.readState()
        const saved = state.stacks!.find((stack) => stack.number === 99)!
        const original = state.prs.find((pr) => pr.number === 101)!
        const unrelated = {
          ...original,
          number: 104,
          head: 'unrelated',
          headOid: git(harness, ['rev-parse', 'unrelated']),
          url: 'https://github.com/acme/widgets/pull/104',
        }
        state.prs.push(unrelated)
        const moved = {
          ...saved,
          id: 100_000,
          number: 100,
          node_id: 'STACK_100',
          url: 'https://api.github.com/repos/acme/widgets/stacks/100',
          pull_requests: state.prs
            .filter((pr) =>
              outcome === 'append' ? pr.number === 101 : [101, 102, 103].includes(pr.number),
            )
            .map((pr) => ({
              number: pr.number,
              state: 'open' as const,
              draft: pr.draft,
              merged_at: null,
              head: { ref: pr.head, sha: pr.headOid! },
            })),
        }
        saved.open = savedOpen
        saved.pull_requests = [
          {
            number: unrelated.number,
            state: 'open',
            draft: false,
            merged_at: null,
            head: { ref: unrelated.head, sha: unrelated.headOid },
          },
        ]
        state.stacks = [saved, moved]
        await harness.writeState(state)
        // Both targets are visible; no missing-stack or malformed-chain shortcut is involved.
        const listed = await listPullRequestStacks('acme', 'widgets', HOST_ONLY)
        assert.deepEqual(
          listed.map((stack) => stack.number),
          [99, 100],
        )
        assert.equal(listed.find((stack) => stack.number === 100)?.status, 'valid')
        writes.length = 0
        await assert.rejects(
          runStackAction(harness.repo, { type: 'submitStackRetry' }),
          (error) => error instanceof NativeStackError && error.status === 'invalid-chain',
        )
        assert.deepEqual(writes, [], 'retry must not mutate either native stack or any PR')
        const progress = await getSubmitStackProgress(harness.repo)
        assert.equal(progress?.status, 'failed')
        assert.equal(progress?.steps.find((step) => step.status === 'failed')?.kind, 'extend-stack')
        assert.deepEqual((await harness.readState()).stacks, state.stacks)
      })
    })
  }
}

for (const accepted of [false, true]) {
  for (const closed of [false, true]) {
    test(`extend retry ${closed ? 'rejects closed' : 'retains saved'} target after ${accepted ? 'lost response' : 'rejected append'}`, async () => {
      await withHarness(async (harness) => {
        await setupThreeBranches(harness)
        await registerBottomOnlyStack(harness)
        const preview = await previewStack(
          harness.repo,
          await getSnapshot(harness.repo),
          'publish',
          'feature/step-2',
        )
        const inner = createGitHubApiDouble()
        let interrupt = true
        const writes: string[] = []
        setGitHubTransport(
          new DirectGitHubTransport({
            token: 'fixture-token',
            fetch: async (input, init) => {
              if (init?.method === 'POST' && String(input).includes('/stacks/')) {
                writes.push(String(input))
                if (interrupt) {
                  interrupt = false
                  if (accepted) assert.equal((await inner(input, init)).ok, true)
                  return new Response(JSON.stringify({ message: 'Append interrupted' }), {
                    status: 503,
                  })
                }
              }
              return inner(input, init)
            },
          }),
        )
        await assert.rejects(
          runStackAction(harness.repo, publishAction(preview.token)),
          /Append interrupted/iu,
        )
        const stopped = await harness.readState()
        if (closed) {
          stopped.stacks![0].open = false
          await harness.writeState(stopped)
        }
        writes.length = 0
        if (closed) {
          await assert.rejects(
            runStackAction(harness.repo, { type: 'submitStackRetry' }),
            (error) => error instanceof NativeStackError && error.status === 'invalid-chain',
          )
          assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'failed')
          assert.deepEqual(writes, [])
          assert.deepEqual((await harness.readState()).stacks, stopped.stacks)
          return
        }
        await runStackAction(harness.repo, { type: 'submitStackRetry' })
        assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
        assert.deepEqual(
          writes,
          accepted ? [] : ['https://api.github.com/repos/acme/widgets/stacks/99/add'],
        )
        assert.deepEqual(
          (await harness.readState()).stacks?.map((stack) => ({
            number: stack.number,
            members: stack.pull_requests.map((pr) => pr.number),
          })),
          [{ number: 99, members: [101, 102, 103] }],
        )
      })
    })
  }
}

for (const drift of ['remote', 'local', 'none'] as const) {
  for (const draft of [false, true]) {
    test(`PR creation retry checks ${drift} tip drift before ${draft ? 'draft' : 'ready'} POST`, async () => {
      await withHarness(async (harness) => {
        await setupFreshBranches(harness)
        const preview = await previewStack(
          harness.repo,
          await getSnapshot(harness.repo),
          'publish',
          'feature/step-2',
        )
        assert.deepEqual(preview.blockers, [])
        const inner = createGitHubApiDouble()
        let interrupt = true
        const writes: string[] = []
        setGitHubTransport(
          new DirectGitHubTransport({
            token: 'fixture-token',
            fetch: async (input, init) => {
              if (
                (init?.method ?? 'GET') !== 'GET' &&
                (!String(input).endsWith('/graphql') || /\bmutation\b/u.test(String(init?.body)))
              ) {
                writes.push(`${init?.method} ${String(input)}`)
              }
              if (interrupt && init?.method === 'POST' && String(input).endsWith('/pulls')) {
                interrupt = false
                // The API has not accepted this request: no PR exists to adopt on retry.
                return new Response(JSON.stringify({ message: 'Create unavailable' }), {
                  status: 503,
                })
              }
              return inner(input, init)
            },
          }),
        )
        const action = publishAction(preview.token)
        action.layers['feature/step-2'].draft = draft
        await assert.rejects(runStackAction(harness.repo, action))
        const stopped = await getSubmitStackProgress(harness.repo)
        assert.equal(stopped?.steps.find((step) => step.kind === 'push')?.status, 'completed')
        assert.equal(stopped?.steps.find((step) => step.status === 'failed')?.kind, 'create-pr')
        assert.deepEqual((await harness.readState()).prs, [])
        const reviewed = git(harness, ['rev-parse', 'feature/step-2'])
        const moved = git(harness, ['rev-parse', 'feature/step-1'])
        assert.notEqual(moved, reviewed)
        if (drift === 'remote') {
          bareGit(harness, ['update-ref', 'refs/heads/feature/step-2', moved])
        } else if (drift === 'local') {
          git(harness, ['update-ref', 'refs/heads/feature/step-2', moved])
        }
        writes.length = 0
        if (drift === 'none') {
          await runStackAction(harness.repo, { type: 'submitStackRetry' })
          const after = await harness.readState()
          assert.deepEqual(
            after.prs.map((pr) => ({
              head: pr.head,
              headOid: pr.headOid,
              draft: pr.draft,
            })),
            [{ head: 'feature/step-2', headOid: reviewed, draft }],
          )
          assert.equal(writes.filter((write) => write.endsWith('/pulls')).length, 1)
          assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
          return
        }
        await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
        assert.deepEqual(writes, [], 'drift must be detected before any retry mutation')
        assert.deepEqual((await harness.readState()).prs, [])
        assert.deepEqual((await harness.readState()).stacks, [])
        const failed = await getSubmitStackProgress(harness.repo)
        assert.equal(failed?.status, 'failed')
        assert.equal(failed?.steps.find((step) => step.status === 'failed')?.kind, 'create-pr')
      })
    })
  }
}

test('publication accepts mixed-case GitHub repository identity', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const state = await harness.readState()
    for (const pr of state.prs) pr.headRepository = 'Acme/Widgets'
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    assert.deepEqual(preview.blockers, [])
    await runStackAction(harness.repo, publishAction(preview.token))
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
    assert.deepEqual(
      (await harness.readState()).stacks?.[0].pull_requests.map((pr) => pr.number),
      [101, 102, 103],
    )
  })
})

for (const drift of ['head', 'remote', 'local', 'none'] as const) {
  test(`lost PR adoption proves ${drift} drift before later layers mutate`, async () => {
    await withHarness(async (harness) => {
      await setupFreshBranches(harness)
      const branches = ['feature/step-1', 'feature/step-2', 'feature/step-3']
      for (const [index, branch] of branches.entries()) {
        const parent = index === 0 ? 'main' : branches[index - 1]
        git(harness, ['config', '--local', `branch.${branch}.parent`, parent])
        git(harness, [
          'config',
          '--local',
          `branch.${branch}.parentTip`,
          git(harness, ['rev-parse', parent]),
        ])
      }
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'feature/step-2',
      )
      assert.deepEqual(preview.blockers, [])
      assert.deepEqual(
        preview.publish?.layers.map((layer) => layer.branch),
        branches,
      )
      const reviewed = git(harness, ['rev-parse', branches[0]])
      const moved = git(harness, ['rev-parse', 'main'])
      const inner = createGitHubApiDouble()
      let interrupt = true
      let reportedHead: string | null = null
      const writes: string[] = []
      setGitHubTransport(
        new DirectGitHubTransport({
          token: 'fixture-token',
          fetch: async (input, init) => {
            if (
              (init?.method ?? 'GET') !== 'GET' &&
              (!String(input).endsWith('/graphql') || /\bmutation\b/u.test(String(init?.body)))
            )
              writes.push(`${init?.method} ${String(input)}`)
            const response = await inner(input, init)
            if (interrupt && init?.method === 'POST' && String(input).endsWith('/pulls')) {
              interrupt = false
              assert.equal(response.ok, true)
              return new Response(JSON.stringify({ message: 'Lost accepted creation' }), {
                status: 502,
              })
            }
            if (reportedHead && String(input).endsWith('/graphql')) {
              const payload = await response.json()
              const repository = payload.data?.repository
              const prs = repository?.pullRequests?.nodes ?? [repository?.pullRequest]
              for (const pr of prs) {
                if (pr?.headRefName === branches[0]) pr.headRefOid = reportedHead
              }
              return new Response(JSON.stringify(payload), { status: response.status })
            }
            return response
          },
        }),
      )
      await assert.rejects(runStackAction(harness.repo, publishAction(preview.token)))
      const stopped = await getSubmitStackProgress(harness.repo)
      assert.equal(stopped?.steps.find((step) => step.status === 'failed')?.branch, branches[0])
      assert.equal(stopped?.layers[0].pullRequest, null)
      const state = await harness.readState()
      assert.deepEqual(
        state.prs.map((pr) => pr.head),
        [branches[0]],
      )
      // GitHub casing is cosmetic on both the known-number and lost-response paths.
      state.prs[0].headRepository = 'Acme/Widgets'
      await harness.writeState(state)
      if (drift === 'remote') {
        bareGit(harness, ['update-ref', `refs/heads/${branches[0]}`, moved])
        reportedHead = reviewed // A stale API read must not substitute for remote tip proof.
      } else if (drift === 'local') {
        git(harness, ['update-ref', `refs/heads/${branches[0]}`, moved])
      } else if (drift === 'head') {
        reportedHead = moved // A PR OID mismatch must fail even if both branch tips match.
      }
      const remoteBefore = bareGit(harness, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
      ])
      writes.length = 0
      if (drift === 'none') {
        await runStackAction(harness.repo, { type: 'submitStackRetry' })
        assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
        assert.deepEqual(
          (await harness.readState()).prs.map((pr) => pr.head),
          branches,
        )
        assert.equal(writes.filter((write) => write.endsWith('/pulls')).length, 2)
        return
      }
      await assert.rejects(runStackAction(harness.repo, { type: 'submitStackRetry' }))
      assert.deepEqual(writes, [], 'drift must block before creating any later PR or stack')
      assert.equal(
        bareGit(harness, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
        remoteBefore,
      )
      const failed = await getSubmitStackProgress(harness.repo)
      assert.equal(failed?.status, 'failed')
      assert.equal(failed?.layers[0].pullRequest, null, 'failed proof must not persist adoption')
      assert.equal(failed?.steps.find((step) => step.status === 'failed')?.kind, 'create-pr')
      assert.deepEqual(
        (await harness.readState()).prs.map((pr) => pr.head),
        [branches[0]],
      )
      assert.deepEqual((await harness.readState()).stacks, [])
    })
  })
}

for (const drift of ['remote', 'stale-remote', 'local'] as const) {
  test(`successful PR readback rejects ${drift} drift before later layers mutate`, async () => {
    await withHarness(async (harness) => {
      await setupFreshBranches(harness)
      const branches = ['feature/step-1', 'feature/step-2', 'feature/step-3']
      for (const [index, branch] of branches.entries()) {
        const parent = index === 0 ? 'main' : branches[index - 1]
        git(harness, ['config', '--local', `branch.${branch}.parent`, parent])
        git(harness, [
          'config',
          '--local',
          `branch.${branch}.parentTip`,
          git(harness, ['rev-parse', parent]),
        ])
      }
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'feature/step-2',
      )
      assert.deepEqual(
        preview.publish?.layers.map((layer) => layer.branch),
        branches,
      )
      const reviewed = git(harness, ['rev-parse', branches[0]])
      const moved = git(harness, ['rev-parse', 'main'])
      const inner = createGitHubApiDouble()
      let created = false
      let armed = true
      let remoteAtDrift = ''
      const writes: string[] = []
      setGitHubTransport(
        new DirectGitHubTransport({
          token: 'fixture-token',
          fetch: async (input, init) => {
            if (
              (init?.method ?? 'GET') !== 'GET' &&
              (!String(input).endsWith('/graphql') || /\bmutation\b/u.test(String(init?.body)))
            )
              writes.push(`${init?.method} ${String(input)}`)
            if (armed && created && String(init?.body).includes('pullRequest(number:')) {
              armed = false
              const stale = drift === 'stale-remote' ? await inner(input, init) : null
              if (drift === 'local') {
                git(harness, ['update-ref', `refs/heads/${branches[0]}`, moved])
              } else {
                bareGit(harness, ['update-ref', `refs/heads/${branches[0]}`, moved])
              }
              remoteAtDrift = bareGit(harness, [
                'for-each-ref',
                '--format=%(refname) %(objectname)',
                'refs/heads',
              ])
              writes.length = 0
              return stale ?? inner(input, init)
            }
            const response = await inner(input, init)
            if (init?.method === 'POST' && String(input).endsWith('/pulls')) {
              assert.equal(response.ok, true)
              created = true
            }
            return response
          },
        }),
      )
      await assert.rejects(runStackAction(harness.repo, publishAction(preview.token)))
      assert.equal(armed, false)
      assert.deepEqual(
        writes,
        [],
        'a successful lower POST must not authorize later writes after drift',
      )
      assert.equal(
        bareGit(harness, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
        remoteAtDrift,
      )
      const failed = await getSubmitStackProgress(harness.repo)
      assert.equal(failed?.status, 'failed')
      assert.equal(failed?.steps.find((step) => step.status === 'failed')?.kind, 'create-pr')
      assert.equal(
        failed?.layers[0].pullRequest,
        101,
        'retain the returned identity for safe recovery',
      )
      assert.deepEqual(
        (await harness.readState()).prs.map((pr) => pr.head),
        [branches[0]],
      )
      assert.deepEqual((await harness.readState()).stacks, [])
      // Restoring the reviewed tip must recover the recorded PR, not create it again.
      git(harness, ['update-ref', `refs/heads/${branches[0]}`, reviewed])
      bareGit(harness, ['update-ref', `refs/heads/${branches[0]}`, reviewed])
      await runStackAction(harness.repo, { type: 'submitStackRetry' })
      assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
      assert.deepEqual(
        (await harness.readState()).prs.map((pr) => pr.head),
        branches,
      )
      assert.equal(writes.filter((write: string) => write.endsWith('/pulls')).length, 2)
    })
  })
}

test('idempotent published push restores usable origin tracking', async () => {
  await withHarness(async (harness) => {
    await setupFreshBranches(harness)
    const branch = 'feature/step-2'
    const reviewed = git(harness, ['rev-parse', branch])
    // The remote already accepted this commit, but no local tracking was installed.
    git(harness, ['push', harness.bare, `${branch}:refs/heads/${branch}`])
    git(harness, ['fetch', harness.bare, `refs/heads/${branch}:refs/remotes/origin/${branch}`])
    assert.equal(git(harness, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`]), '')
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      branch,
    )
    assert.deepEqual(preview.blockers, [])
    await runStackAction(harness.repo, publishAction(preview.token))
    assert.equal((await getSubmitStackProgress(harness.repo))?.status, 'completed')
    assert.equal(git(harness, ['config', '--get', `branch.${branch}.remote`]), 'origin')
    assert.equal(
      git(harness, ['config', '--get', `branch.${branch}.merge`]),
      `refs/heads/${branch}`,
    )
    assert.equal(git(harness, ['rev-parse', `${branch}@{upstream}`]), reviewed)
    assert.equal(bareGit(harness, ['rev-parse', `refs/heads/${branch}`]), reviewed)
  })
})

test('a host that still refuses the stacks resource still publishes an ordinary chain', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const state = await harness.readState()
    state.stacksPreviewDisabled = true
    await harness.writeState(state)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    assert.deepEqual(preview.blockers, [])
    assert.match(preview.warnings.join('\n'), /does not serve native stacked pull requests/iu)

    // The resource is still absent when the submission runs, so the proof
    // confirms the absence the preview recorded and the chain goes ahead.
    const result = await runStackAction(harness.repo, {
      type: 'submitStack',
      token: preview.token,
      allowForce: false,
      layers: {
        'feature/step-1': { title: 'Step 1 PR', body: '', draft: false, updateBase: true },
        'feature/step-2': { title: 'Step 2 PR', body: '', draft: false, updateBase: true },
        'feature/step-3': { title: 'Step 3 PR', body: '', draft: false, updateBase: true },
      },
    })
    assert.match(result.message, /Submitted 3 stack layers/iu)
    const after = await harness.readState()
    assert.deepEqual(after.stacks, [], 'no stack was registered for a host that has none')
    assert.deepEqual(
      [...after.prs.map((pr) => pr.base)].sort(),
      ['feature/step-1', 'feature/step-2', 'main'],
      'each pull request is based on the one below it',
    )
  })
})

test('a preview made before a host served stacks is refused before anything is published', async () => {
  await withHarness(async (harness) => {
    await setupThreeBranches(harness)
    const state = await harness.readState()
    state.stacksPreviewDisabled = true
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'feature/step-2',
    )
    assert.deepEqual(preview.blockers, [])

    // The host starts serving the resource between the preview and the run.
    const before = await harness.readState()
    const restored = await harness.readState()
    restored.stacksPreviewDisabled = false
    await harness.writeState(restored)

    await assert.rejects(
      runStackAction(harness.repo, {
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: {
          'feature/step-1': { title: 'Step 1 PR', body: '', draft: false, updateBase: true },
          'feature/step-2': { title: 'Step 2 PR', body: '', draft: false, updateBase: true },
          'feature/step-3': { title: 'Step 3 PR', body: '', draft: false, updateBase: true },
        },
      }),
      /now answers for native stacks/iu,
    )
    const after = await harness.readState()
    assert.deepEqual(
      after.prs.map((pr) => pr.title),
      before.prs.map((pr) => pr.title),
      'the submission opened nothing new',
    )
    assert.deepEqual(after.stacks, [], 'and registered no stack')
  })
})
