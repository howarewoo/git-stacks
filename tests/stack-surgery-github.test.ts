import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createGitHubHarness } from './fixtures/github-harness'
import type { GitHubFixtureState, GitHubHarness } from './fixtures/github-harness'
import type { SurgeryRequest } from '../src/shared/types'

// Git Stacks captures Node's spawn API when its own modules load, so the modules
// under test are imported after the harness is installed rather than statically.
const { getSnapshot, runAction } = await import('../src/main/git')
const { getStackProgress, previewSurgery, runSurgery } = await import('../src/main/stacks')
const { DirectGitHubTransport, setGitHubTransport } = await import('../src/main/github-transport')
const { createGitHubApiDouble } = await import('./fixtures/github-api-double')

const LAYERS = ['one', 'two', 'three', 'four'] as const
type Layer = (typeof LAYERS)[number]

function git(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['-C', harness.repo, ...args])
}

function bareGit(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['--git-dir', harness.bare, ...args])
}

function config(harness: GitHubHarness, key: string): string {
  try {
    return git(harness, ['config', '--get', key]).trim()
  } catch {
    return ''
  }
}

async function withPublishedStack(
  run: (harness: GitHubHarness) => Promise<void>,
  options: { state?: Partial<GitHubFixtureState> } = {},
): Promise<void> {
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
    if (options.state) {
      const state = await harness.readState()
      await harness.writeState({ ...state, ...options.state })
    }
    await run(harness)
  } finally {
    setGitHubTransport(null)
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(original)) {
      if (value !== undefined) process.env[key] = value
    }
    await harness.close()
  }
}

async function commitFile(
  harness: GitHubHarness,
  filePath: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(harness.repo, filePath), contents, 'utf8')
  git(harness, ['add', '--', filePath])
  git(harness, ['commit', '-m', message])
  return git(harness, ['rev-parse', 'HEAD']).trim()
}

/**
 * main -> one -> two -> three -> four, each layer with one commit, each published
 * with a pull request whose base is the layer below it, all four registered in one
 * native stack on the trunk. The branches are real refs in the harness's bare
 * repository, so leases, remote tips and pull request heads are real facts.
 */
async function publishedFourLayerStack(
  harness: GitHubHarness,
): Promise<Record<Layer, { tip: string; number: number }>> {
  const layers: Partial<Record<Layer, { tip: string; number: number }>> = {}
  const state = await harness.readState()
  let parent = 'main'
  for (const layer of LAYERS) {
    await runAction(harness.repo, { type: 'createBranch', name: layer, parent })
    const tip = await commitFile(harness, `${layer}.txt`, `${layer} work\n`, `${layer} commit`)
    // The harness's own Git runner bypasses the fixture's answers, so the setup
    // push names the disposable bare repository the app's pushes land in.
    harness.runGit(['-C', harness.repo, 'push', harness.bare, `${layer}:refs/heads/${layer}`])
    const number = state.nextNumber++
    state.prs.push({
      number,
      title: `${layer} pull request`,
      body: '',
      base: parent,
      head: layer,
      headRepository: `${state.repository.owner}/${state.repository.name}`,
      draft: false,
      state: 'OPEN',
      checks: 'none',
      reviewDecision: null,
      mergeState: 'CLEAN',
      url: `https://github.com/${state.repository.owner}/${state.repository.name}/pull/${number}`,
      headOid: null,
      mergeOid: null,
      mergedAt: null,
    })
    layers[layer] = { tip, number }
    parent = layer
  }
  const stackNumber = 1
  state.stacks = [
    {
      id: 1000,
      number: stackNumber,
      node_id: 'STACK_1',
      url: `https://api.github.com/repos/${state.repository.owner}/${state.repository.name}/stacks/${stackNumber}`,
      base: { ref: 'main' },
      open: true,
      created_at: new Date().toISOString(),
      pull_requests: LAYERS.map((layer) => ({
        number: layers[layer]!.number,
        state: 'open' as const,
        draft: false,
        merged_at: null,
        head: { ref: layer, sha: layers[layer]!.tip },
      })),
    },
  ]
  await harness.writeState(state)
  return layers as Record<Layer, { tip: string; number: number }>
}

async function preview(harness: GitHubHarness, request: SurgeryRequest) {
  const snapshot = await getSnapshot(harness.repo)
  return previewSurgery(harness.repo, snapshot, request)
}

function prFor(state: GitHubFixtureState, branch: string) {
  const pr = state.prs.find((entry) => entry.head === branch)
  assert.ok(pr, `the fixture has no pull request for ${branch}`)
  return pr
}

function openStacks(state: GitHubFixtureState) {
  return (state.stacks ?? []).filter((stack) => stack.open)
}

function stackOrder(state: GitHubFixtureState, stackNumber: number): number[] {
  const stack = (state.stacks ?? []).find((entry) => entry.number === stackNumber)
  assert.ok(stack, `the fixture has no stack #${stackNumber}`)
  return stack.pull_requests.map((member) => member.number)
}

/** The branches the harness's transport layer actually pushed, in order. */
async function pushedBranches(harness: GitHubHarness): Promise<string[]> {
  const log = await readFile(join(harness.root, 'git-transport.jsonl'), 'utf8')
  return log
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { argv: string[] })
    .filter((entry) => entry.argv.includes('push'))
    .flatMap((entry) => entry.argv.filter((token) => token.includes('refs/heads/')))
    .map((refspec) => (refspec.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec))
    .map((ref) => ref.replace('refs/heads/', ''))
}

/**
 * How many requests of one kind the double answered. `pathEndsWith` tells a
 * collection endpoint apart from a member endpoint under the same prefix, so a
 * test can count the creates without counting the unstack.
 */
function requestCount(
  state: GitHubFixtureState,
  method: string,
  pathIncludes: string,
  pathEndsWith?: string,
): number {
  return state.requests.filter(
    (entry) =>
      entry.argv[1] === method &&
      entry.argv[0]?.includes(pathIncludes) &&
      (pathEndsWith === undefined || entry.argv[0]?.endsWith(pathEndsWith)),
  ).length
}

/**
 * main -> one -> three -> four -> two, the order moving two up past the layer
 * above it produces: three drops onto one, four keeps its place above three, and
 * two lands on top of the whole stack.
 */
const REORDER: Record<Layer, Layer | 'main'> = {
  one: 'main',
  three: 'one',
  four: 'three',
  two: 'four',
}

/** The pull request order the new native stack has to hold, bottom-to-top. */
const REORDERED_MEMBERS: Layer[] = ['one', 'three', 'four', 'two']

function assertPublishedOrder(harness: GitHubHarness, state: GitHubFixtureState): void {
  assert.deepEqual(
    REORDERED_MEMBERS.map((layer) => [layer, config(harness, `branch.${layer}.parent`)]),
    [
      ['one', 'main'],
      ['three', 'one'],
      ['four', 'three'],
      ['two', 'four'],
    ],
    'every layer records the parent it now hangs from',
  )
  for (const layer of LAYERS) {
    const parent = REORDER[layer]
    if (parent === 'main') continue
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', parent, layer]),
      '',
      `${parent} is an ancestor of ${layer}`,
    )
  }
  assert.deepEqual(
    REORDERED_MEMBERS.map((layer) => [layer, prFor(state, layer).base]),
    [
      ['one', 'main'],
      ['three', 'one'],
      ['four', 'three'],
      ['two', 'four'],
    ],
    'every pull request targets the layer below it',
  )
  for (const layer of REORDERED_MEMBERS) {
    if (layer === 'one') continue
    assert.equal(
      prFor(state, layer).headOid,
      git(harness, ['rev-parse', `refs/heads/${layer}`]).trim(),
      `pull request for ${layer} reports the tip this run published`,
    )
  }
}

/** The membership one open native stack has to hold after the surgery. */
function expectedMembership(layers: Record<Layer, { number: number }>): number[] {
  return REORDERED_MEMBERS.map((layer) => layers[layer].number)
}

test('moving a layer in a published four-layer stack rewrites ancestry, bases and native order', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    assert.deepEqual(plan.order, REORDERED_MEMBERS)
    assert.deepEqual(
      plan.layers.map((layer) => [layer.branch, layer.action]),
      [
        ['three', 'rewrite'],
        ['four', 'rewrite'],
        ['two', 'rewrite'],
      ],
    )
    assert.deepEqual(plan.forcePushes, ['three', 'four', 'two'])
    assert.deepEqual(
      plan.retargets.map((retarget) => [retarget.number, retarget.from, retarget.to]),
      [
        [layers.three.number, 'two', 'one'],
        [layers.two.number, 'one', 'four'],
      ],
      'only the layers whose pull request base really moves are retargeted',
    )
    assert.equal(plan.nativeStack?.action, 'unstack-and-create')
    assert.equal(plan.nativeStack?.number, 1)

    const result = await runSurgery(harness.repo, plan.token, true, false)
    assert.match(result.message, /Applied the reviewed surgery/)

    const state = await harness.readState()
    assertPublishedOrder(harness, state)
    assert.deepEqual(
      openStacks(state).map((stack) => stackOrder(state, stack.number)),
      [expectedMembership(layers)],
      'exactly one open native stack holds the new order on the trunk',
    )
    assert.equal(openStacks(state)[0]!.base.ref, 'main')
    for (const layer of LAYERS) {
      assert.equal(
        bareGit(harness, ['rev-parse', `refs/heads/${layer}`]),
        git(harness, ['rev-parse', `refs/heads/${layer}`]).trim(),
        `${layer} was published to the remote the run leased`,
      )
    }
    assert.equal(
      await getStackProgress(harness.repo),
      null,
      'a finished surgery leaves no interrupted operation behind',
    )
  })
})

test('a retarget that landed before its response was lost is recognised, not repeated', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'PATCH',
        pathIncludes: `/pulls/${layers.three.number}`,
        status: 502,
        message: 'Bad gateway',
      },
    ]
    await harness.writeState(state)

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    const afterFailure = await harness.readState()
    assert.equal(
      prFor(afterFailure, 'three').base,
      'one',
      'GitHub took the retarget even though the caller never heard it',
    )
    const progress = await getStackProgress(harness.repo)
    assert.deepEqual(progress?.remaining, [], 'the replay finished; only remote work is left')
    assert.ok(
      git(harness, ['for-each-ref', 'refs/git-stacks/']).includes('refs/git-stacks/'),
      'the original tips stay recoverable while the run is unfinished',
    )

    const resumed = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(resumed.message, /targets one/)

    const afterResume = await harness.readState()
    assert.equal(
      requestCount(afterResume, 'PATCH', `/pulls/${layers.three.number}`),
      1,
      'the landed retarget is not written a second time',
    )
    assertPublishedOrder(harness, afterResume)
    assert.deepEqual(
      openStacks(afterResume).map((stack) => stackOrder(afterResume, stack.number)),
      [expectedMembership(layers)],
    )
  })
})

test('a native stack created before its response was lost is adopted, never posted twice', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'POST',
        pathIncludes: '/stacks',
        pathEndsWith: '/stacks',
        status: 502,
        message: 'Bad gateway',
      },
    ]
    await harness.writeState(state)

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    const afterFailure = await harness.readState()
    assert.deepEqual(
      openStacks(afterFailure).map((stack) => stackOrder(afterFailure, stack.number)),
      [expectedMembership(layers)],
      'the stack exists even though the create call failed',
    )

    const resumed = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(resumed.message, /holds the new order/)

    const afterResume = await harness.readState()
    assert.equal(
      requestCount(afterResume, 'POST', '/stacks', '/stacks'),
      1,
      'the resumed run adopts the stack that already holds the reviewed membership',
    )
    assert.deepEqual(
      openStacks(afterResume).map((stack) => stackOrder(afterResume, stack.number)),
      [expectedMembership(layers)],
      'one open stack, holding one order',
    )
  })
})

test('a native stack whose membership changed after the preview is never unstacked', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'PATCH',
        pathIncludes: `/pulls/${layers.three.number}`,
        status: 502,
        message: 'Bad gateway',
      },
    ]
    await harness.writeState(state)

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    // Somebody else dropped the top layer from the stack between the preview and
    // the resumption, so unstacking it now would destroy their membership.
    const drifted = await harness.readState()
    const stack = drifted.stacks!.find((entry) => entry.number === 1)!
    stack.pull_requests = stack.pull_requests.filter(
      (member) => member.number !== layers.four.number,
    )
    await harness.writeState(drifted)

    await assert.rejects(
      runAction(harness.repo, { type: 'stackContinue' }),
      /instead of the reviewed membership/u,
    )
    const after = await harness.readState()
    assert.deepEqual(
      stackOrder(after, 1),
      [layers.one.number, layers.two.number, layers.three.number],
      'the stack somebody else owns is left exactly as it was',
    )
    assert.equal(after.stacks!.find((entry) => entry.number === 1)!.open, true)
  })
})

test('a completed step whose pull request drifted again stops the run before it writes', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    // The first retarget lands, the second one's response is lost, so the run stops
    // with one step complete and the rest pending.
    state.lostResponses = [
      {
        method: 'PATCH',
        pathIncludes: `/pulls/${layers.two.number}`,
        status: 502,
        message: 'Bad gateway',
      },
    ]
    await harness.writeState(state)

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    const completed = await harness.readState()
    assert.equal(prFor(completed, 'three').base, 'one', 'the first retarget landed')
    assert.equal(prFor(completed, 'two').base, 'four', 'the second retarget landed too')

    const drifted = await harness.readState()
    prFor(drifted, 'three').base = 'main'
    await harness.writeState(drifted)

    await assert.rejects(
      runAction(harness.repo, { type: 'stackContinue' }),
      /changed from two to main on GitHub/u,
    )
    const after = await harness.readState()
    assert.equal(prFor(after, 'three').base, 'main', 'the external change is not overwritten')
    assert.equal(
      requestCount(after, 'POST', '/stacks', '/stacks'),
      0,
      'the native stack is not unstacked and recreated from a run that stopped on drift',
    )
    assert.equal(
      requestCount(after, 'POST', '/stacks'),
      0,
      'no native stack is registered from a run that stopped on drift',
    )
  })
})

/**
 * The same four layers, but three rewrites a file two also rewrote, so replaying
 * three onto one conflicts while the layers above it replay cleanly. A paused
 * replay is the window where a resumed run has to remember it still owes the
 * reviewed remote steps.
 */
async function conflictingPublishedStack(
  harness: GitHubHarness,
): Promise<Record<Layer, { tip: string; number: number }>> {
  const layers: Partial<Record<Layer, { tip: string; number: number }>> = {}
  const state = await harness.readState()
  let parent = 'main'
  for (const layer of LAYERS) {
    await runAction(harness.repo, { type: 'createBranch', name: layer, parent })
    const tip =
      layer === 'one'
        ? await commitFile(harness, 'shared.txt', 'a\n', 'One edit')
        : layer === 'two'
          ? await commitFile(harness, 'shared.txt', 'a\nb\n', 'Two edit')
          : layer === 'three'
            ? await commitFile(harness, 'shared.txt', 'a\nB\n', 'Three edit')
            : await commitFile(harness, 'four.txt', 'four\n', 'Four edit')
    harness.runGit(['-C', harness.repo, 'push', harness.bare, `${layer}:refs/heads/${layer}`])
    const number = state.nextNumber++
    state.prs.push({
      number,
      title: `${layer} pull request`,
      body: '',
      base: parent,
      head: layer,
      headRepository: `${state.repository.owner}/${state.repository.name}`,
      draft: false,
      state: 'OPEN',
      checks: 'none',
      reviewDecision: null,
      mergeState: 'CLEAN',
      url: `https://github.com/${state.repository.owner}/${state.repository.name}/pull/${number}`,
      headOid: null,
      mergeOid: null,
      mergedAt: null,
    })
    layers[layer] = { tip, number }
    parent = layer
  }
  const stackNumber = 1
  state.stacks = [
    {
      id: 1000,
      number: stackNumber,
      node_id: 'STACK_1',
      url: `https://api.github.com/repos/${state.repository.owner}/${state.repository.name}/stacks/${stackNumber}`,
      base: { ref: 'main' },
      open: true,
      created_at: new Date().toISOString(),
      pull_requests: LAYERS.map((layer) => ({
        number: layers[layer]!.number,
        state: 'open' as const,
        draft: false,
        merged_at: null,
        head: { ref: layer, sha: layers[layer]!.tip },
      })),
    },
  ]
  await harness.writeState(state)
  return layers as Record<Layer, { tip: string; number: number }>
}

test('inserting a layer above a submitted one publishes it before the retarget', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])

    const plan = await preview(harness, { kind: 'insert', branch: 'two', name: 'pilot' })
    assert.deepEqual(plan.blockers, [])
    assert.deepEqual(plan.order, ['one', 'two', 'pilot', 'three', 'four'])
    assert.deepEqual(plan.creates, ['pilot'])
    assert.deepEqual(
      plan.layers.map((layer) => [layer.branch, layer.action, layer.push]),
      [
        ['pilot', 'insert', 'create'],
        ['three', 'rewrite', 'force'],
        ['four', 'rewrite', 'force'],
      ],
      'the inserted layer is published as a new remote branch because a pull request hangs from it',
    )
    assert.deepEqual(
      plan.retargets.map((retarget) => [retarget.number, retarget.from, retarget.to]),
      [[layers.three.number, 'two', 'pilot']],
    )
    assert.equal(
      plan.nativeStack?.action,
      'unstack',
      'a chain with a layer that has no pull request of its own cannot stay a native stack',
    )

    const result = await runSurgery(harness.repo, plan.token, true, false)
    assert.match(result.message, /Applied the reviewed surgery/)

    const state = await harness.readState()
    assert.equal(
      bareGit(harness, ['rev-parse', 'refs/heads/pilot']),
      layers.two.tip,
      'the new branch exists on the remote at the tip the review named',
    )
    assert.equal(prFor(state, 'three').base, 'pilot')
    assert.equal(prFor(state, 'four').base, 'three')
    assert.equal(
      config(harness, 'branch.three.parent'),
      'pilot',
      'the layer above the inserted branch records it as its parent',
    )
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', 'pilot', 'three']),
      '',
      'the replayed layer descends from the branch that was published for it',
    )
    assert.deepEqual(
      openStacks(state),
      [],
      'the native stack was unstacked rather than left in an order GitHub cannot hold',
    )
    assert.equal(await getStackProgress(harness.repo), null)
  })
})

test('a native stack unstacked before its response was lost is recognised, not repeated', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'POST',
        pathIncludes: '/stacks/1/unstack',
        status: 502,
        message: 'Bad gateway',
      },
    ]
    await harness.writeState(state)

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    const afterFailure = await harness.readState()
    assert.deepEqual(
      openStacks(afterFailure),
      [],
      'GitHub dissolved the stack even though the caller never heard it',
    )

    const resumed = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(resumed.message, /Registered native stack #\d+/)
    const afterResume = await harness.readState()
    assert.equal(
      requestCount(afterResume, 'POST', '/stacks/1/unstack'),
      1,
      'the dissolved stack is not unstacked a second time',
    )
    assert.deepEqual(
      openStacks(afterResume).map((stack) => stackOrder(afterResume, stack.number)),
      [expectedMembership(layers)],
    )
  })
})

test('a force push whose response was lost is recognised on the remote ref, not repeated', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    // The push lands and the caller never hears it: the harness reports the command
    // as failed after Git has already moved the ref.
    harness.hookGitPush({
      branch: 'three',
      armed: true,
      after() {
        throw new Error('connection reset after the ref moved')
      },
    })

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    const landed = await harness.readState()
    const tip = git(harness, ['rev-parse', 'refs/heads/three']).trim()
    assert.equal(
      bareGit(harness, ['rev-parse', 'refs/heads/three']),
      tip,
      'the remote already holds the tip the run replayed',
    )
    assert.equal(
      prFor(landed, 'three').base,
      'two',
      'the run stopped at the push, before any pull request change',
    )

    const resumed = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(resumed.message, /Applied the reviewed surgery/)
    const afterResume = await harness.readState()
    assert.equal(
      (await pushedBranches(harness)).filter((branch) => branch === 'three').length,
      1,
      'the landed push is recognised on the remote ref instead of pushed again under a stale lease',
    )
    assertPublishedOrder(harness, afterResume)
    assert.deepEqual(
      openStacks(afterResume).map((stack) => stackOrder(afterResume, stack.number)),
      [expectedMembership(layers)],
    )
  })
})

test('an interrupted remove keeps a journal that loads, and aborting restores the layer', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'PATCH',
        pathIncludes: `/pulls/${layers.two.number}`,
        status: 502,
        message: 'Bad gateway',
      },
    ]
    await harness.writeState(state)

    const plan = await preview(harness, { kind: 'remove', branch: 'two' })
    assert.deepEqual(plan.blockers, [])
    assert.deepEqual(plan.closes, [layers.two.number])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, true))

    // The close landed, so the run stopped with the journal on disk and the removed
    // layer still in place: the recovery banner has to be able to read all of it.
    const progress = await getStackProgress(harness.repo)
    assert.equal(progress?.kind, 'restack')
    assert.match(progress?.message ?? '', /remote step/u)
    assert.ok(
      git(harness, ['for-each-ref', 'refs/git-stacks/']).includes('refs/git-stacks/'),
      'the recovery refs the abort needs are on disk',
    )

    const aborted = await runAction(harness.repo, { type: 'stackAbort' })
    assert.match(aborted.message, /restored the original branch tips/)
    for (const layer of LAYERS) {
      assert.equal(
        git(harness, ['rev-parse', `refs/heads/${layer}`]).trim(),
        layers[layer].tip,
        `${layer} is back at the tip the surgery previewed`,
      )
    }
    assert.equal(config(harness, 'branch.two.parent'), 'one')
    assert.equal(config(harness, 'branch.three.parent'), 'two')
    assert.equal(await getStackProgress(harness.repo), null)
  })
})

test('a resumed replay still performs the reviewed pull request and stack changes', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await conflictingPublishedStack(harness)
    git(harness, ['switch', 'two'])

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    const paused = await getStackProgress(harness.repo)
    assert.match(paused?.message ?? '', /Restack paused on three/u)
    const afterConflict = await harness.readState()
    assert.equal(
      prFor(afterConflict, 'three').base,
      'two',
      'nothing is written on GitHub while the replay is paused',
    )

    // The person resolves each conflict the way Git asks them to, and every
    // Continue both finishes the replay and owes the reviewed remote steps.
    let resumed: { message: string } | null = null
    for (let attempt = 0; attempt < 5 && !resumed; attempt += 1) {
      resumed = await runAction(harness.repo, { type: 'stackContinue' }).then(
        (result: { message: string }) => result,
        () => {
          git(harness, ['checkout', '--theirs', '--', 'shared.txt'])
          git(harness, ['add', '--', 'shared.txt'])
          return null
        },
      )
    }
    assert.ok(resumed, 'the replay finishes once its conflicts are resolved')
    assert.match(resumed.message, /Applied the reviewed surgery/)
    assert.match(resumed.message, /retargeted to one/u)

    const state = await harness.readState()
    assert.equal(prFor(state, 'three').base, 'one')
    assert.equal(prFor(state, 'two').base, 'four')
    assert.deepEqual(
      openStacks(state).map((stack) => stackOrder(state, stack.number)),
      [expectedMembership(layers)],
      'the native stack the review named is registered after the conflict is resolved',
    )
    assert.equal(await getStackProgress(harness.repo), null)
  })
})
