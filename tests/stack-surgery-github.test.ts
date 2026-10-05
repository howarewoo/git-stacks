import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createGitHubHarness } from './fixtures/github-harness'
import type { GitHubFixtureState, GitHubHarness } from './fixtures/github-harness'
import type { SurgeryPreview, SurgeryRequest } from '../src/shared/types'

// Git Stacks captures Node's spawn API when its own modules load, so the modules
// under test are imported after the harness is installed rather than statically.
const { getSnapshot, runAction } = await import('../src/main/git')
const { getStackProgress, previewStack, previewSurgery, runSurgery } =
  await import('../src/main/stacks')
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
      /was moved to main after this surgery retargeted it to one/u,
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

test('an uncertain stack registration is never posted twice while its outcome is unknown', async () => {
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

    // The request the journal recorded is still in flight on GitHub, so the
    // membership it would hold is not listed yet.
    const pending = await harness.readState()
    pending.stacks = pending.stacks?.filter((stack) => !stack.open)
    await harness.writeState(pending)

    await assert.rejects(runAction(harness.repo, { type: 'stackContinue' }))
    const after = await harness.readState()
    assert.equal(
      requestCount(after, 'POST', '/stacks', '/stacks'),
      1,
      'the uncertain registration is not sent again',
    )
    assert.deepEqual(openStacks(after), [], 'no stack is registered behind the refusal')
    assert.ok(
      (await getStackProgress(harness.repo)) !== null,
      'the journal is retained so the run can be continued once GitHub is read again',
    )
  })
})

test('a registration whose read-back failed is adopted, and the checkpoint is re-proved', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    // The create lands; neither its own response nor the read-back that proves it
    // reaches this run.
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
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    await runAction(harness.repo, { type: 'stackContinue' })
    const after = await harness.readState()
    assert.equal(requestCount(after, 'POST', '/stacks', '/stacks'), 1)
    assert.deepEqual(
      openStacks(after).map((stack) => stackOrder(after, stack.number)),
      [expectedMembership(layers)],
    )
    assert.equal(await getStackProgress(harness.repo), null)
  })
})

test('a completed registration that changed after the run refuses the next resumption', async () => {
  await withPublishedStack(async (harness) => {
    await publishedFourLayerStack(harness)
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
    // The layer this surgery removes is rewritten behind its back, so the run
    // finishes every reviewed remote step and then stops on the local deletion
    // instead of clearing its journal.
    harness.hookGitPush({
      branch: 'three',
      armed: true,
      after() {
        git(harness, ['update-ref', 'refs/heads/two', git(harness, ['rev-parse', 'main'])])
      },
    })

    const plan = await preview(harness, { kind: 'remove', branch: 'two' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, true))
    await assert.rejects(runAction(harness.repo, { type: 'stackContinue' }))
    assert.equal(
      git(harness, ['rev-parse', 'refs/heads/two']),
      git(harness, ['rev-parse', 'main']),
      'the layer whose ref moved behind Git Stacks is not deleted',
    )
    const registered = await harness.readState()
    assert.equal(
      registered.prs.find((entry) => entry.head === 'two')?.state,
      'CLOSED',
      'the reviewed close really did reach GitHub',
    )
    assert.ok((await getStackProgress(harness.repo)) !== null, 'the journal is retained')

    // Somebody reorders the registered stack after this run proved it.
    const drifted = await harness.readState()
    const open = openStacks(drifted)[0]!
    open.pull_requests = open.pull_requests.slice().reverse()
    await harness.writeState(drifted)

    await assert.rejects(runAction(harness.repo, { type: 'stackContinue' }))
    const after = await harness.readState()
    assert.deepEqual(
      stackOrder(after, open.number),
      open.pull_requests.map((member) => member.number),
      "somebody else's order is not overwritten",
    )
    assert.ok((await getStackProgress(harness.repo)) !== null, 'the journal is still retained')
  })
})

test('a completed registration that closed before resumption keeps the recovery journal', async () => {
  await withPublishedStack(async (harness) => {
    await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    harness.hookGitPush({
      branch: 'three',
      armed: true,
      after() {
        git(harness, ['update-ref', 'refs/heads/two', git(harness, ['rev-parse', 'main'])])
      },
    })

    const plan = await preview(harness, { kind: 'remove', branch: 'two' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, true))
    const registered = await harness.readState()
    const current = openStacks(registered)[0]!
    current.open = false
    await harness.writeState(registered)

    await assert.rejects(
      runAction(harness.repo, { type: 'stackContinue' }),
      /closed instead of holding the registered order/,
    )
    assert.ok(await getStackProgress(harness.repo), 'the journal remains for recovery')
  })
})

test('a completed retarget somebody moved back stops the run instead of repeating it', async () => {
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

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))
    const landed = await harness.readState()
    assert.equal(prFor(landed, 'three').base, 'one', 'the first retarget landed')

    // Somebody put the first pull request back on the base it had before this
    // surgery, after the surgery moved it.
    const reverted = await harness.readState()
    prFor(reverted, 'three').base = 'two'
    await harness.writeState(reverted)

    await assert.rejects(runAction(harness.repo, { type: 'stackContinue' }))
    const after = await harness.readState()
    assert.equal(prFor(after, 'three').base, 'two', "somebody else's edit is not overwritten")
    assert.equal(
      requestCount(after, 'POST', '/stacks', '/stacks'),
      0,
      'nothing after the stale step is attempted',
    )
    assert.ok((await getStackProgress(harness.repo)) !== null, 'the journal is retained')
  })
})

test('a stack detail that disagrees with the listing is unresolved, never completed', async () => {
  await withPublishedStack(async (harness) => {
    await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    // GitHub's detail read loses the stack while its listing still has it open.
    state.missingStackDetails = [1]
    await harness.writeState(state)

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    await assert.rejects(runAction(harness.repo, { type: 'stackContinue' }))
    const after = await harness.readState()
    assert.equal(
      requestCount(after, 'POST', '/stacks/1/unstack'),
      0,
      'a stack this run cannot resolve is not unstacked',
    )
    assert.deepEqual(stackOrder(after, 1), [1, 2, 3, 4], 'the membership is untouched')
    assert.ok((await getStackProgress(harness.repo)) !== null, 'the journal is retained')
  })
})

test('a registration whose read-back 404s keeps its intent instead of posting again', async () => {
  await withPublishedStack(async (harness) => {
    await publishedFourLayerStack(harness)
    git(harness, ['switch', 'two'])
    const state = await harness.readState()
    // The create lands, and the read-back that has to prove it answers 404.
    state.lostResponses = [
      {
        method: 'GET',
        pathIncludes: '/stacks/1',
        pathEndsWith: '/stacks/1',
        // The read-back of the registration is the third read of that stack: the
        // preview, the unstack verification, and the proof of the create.
        after: 2,
        status: 404,
        message: 'Not Found',
      },
    ]
    await harness.writeState(state)

    const plan = await preview(harness, { kind: 'move', branch: 'two', target: 'three' })
    assert.deepEqual(plan.blockers, [])
    await assert.rejects(runSurgery(harness.repo, plan.token, true, false))

    // The registration this run already asked for is not listed yet.
    const pending = await harness.readState()
    assert.equal(requestCount(pending, 'POST', '/stacks', '/stacks'), 1)
    pending.stacks = pending.stacks?.filter((stack) => !stack.open)
    await harness.writeState(pending)

    await assert.rejects(runAction(harness.repo, { type: 'stackContinue' }))
    const after = await harness.readState()
    assert.equal(
      requestCount(after, 'POST', '/stacks', '/stacks'),
      1,
      'the registration is not sent again',
    )
    assert.deepEqual(openStacks(after), [], 'no stack is registered behind the refusal')
    assert.ok((await getStackProgress(harness.repo)) !== null, 'the journal is retained')
  })
})

function prByNumber(state: GitHubFixtureState, number: number) {
  const pr = state.prs.find((entry) => entry.number === number)
  assert.ok(pr, `the fixture has no pull request #${number}`)
  return pr
}

/**
 * The published four-layer stack after GitHub landed its bottom pull requests
 * the way this app lands a stacked pull request: one merge request for the top
 * of the contiguous downstack, the merged-head metadata Git Stacks records for
 * every layer that landed, and the pull requests and native stack membership
 * the host reports afterwards. Every merged fact a surgery below has to refuse
 * is a fact this run produced.
 */
async function publishedStackWithMergedDownstack(
  harness: GitHubHarness,
  mergedThrough: Layer,
): Promise<Record<Layer, { tip: string; number: number }>> {
  const layers = await publishedFourLayerStack(harness)
  const state = await harness.readState()
  for (const pr of state.prs) {
    if (pr.state !== 'OPEN') continue
    pr.checks = 'passing'
    pr.reviewDecision = 'APPROVED'
    pr.mergeState = 'CLEAN'
  }
  await harness.writeState(state)
  git(harness, ['switch', mergedThrough])

  const plan = await previewStack(
    harness.repo,
    await getSnapshot(harness.repo),
    'merge',
    mergedThrough,
  )
  assert.deepEqual(plan.blockers, [], 'the contiguous downstack is offered as one merge')
  assert.deepEqual(
    plan.merge?.layers.map((layer) => layer.branch),
    LAYERS.slice(0, LAYERS.indexOf(mergedThrough) + 1),
    'the merge lands the layers below the one this run selected',
  )
  await runAction(harness.repo, {
    type: 'executeStack',
    token: plan.token,
    allowForce: false,
    mergeMethod: 'squash',
    mergeAction: 'direct_merge',
  })

  const merged = await harness.readState()
  const stack = (merged.stacks ?? []).find((entry) => entry.number === 1)
  assert.ok(stack, 'the native stack the merge landed into is still reported')
  for (const member of stack.pull_requests) {
    const pr = prByNumber(merged, member.number)
    if (pr.state !== 'MERGED') continue
    // GitHub keeps a merged pull request in the stack that held it, and reports
    // it as a closed member carrying the time it merged.
    member.state = 'closed'
    member.merged_at = pr.mergedAt
  }
  await harness.writeState(merged)
  for (const layer of LAYERS.slice(0, LAYERS.indexOf(mergedThrough) + 1)) {
    assert.equal(prFor(merged, layer).state, 'MERGED', `${layer} merged in this run`)
  }
  assert.equal(
    config(harness, `branch.${mergedThrough}.gitStacksMergedHeadPr`),
    String(layers[mergedThrough].number),
    'the merged head is recorded, which is the fact a surgery reads as merged',
  )
  return layers
}

/**
 * Everything a refused surgery has to leave alone: the local branches and the
 * metadata that places them, the remote its leases are read from, what the host
 * reports for each pull request and for native stack membership, how many
 * requests were written rather than read, and the recovery journal the run
 * would otherwise have written.
 */
async function untouchedFacts(harness: GitHubHarness) {
  const state = await harness.readState()
  return {
    branches: git(harness, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']),
    remoteBranches: bareGit(harness, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads/',
    ]),
    recoveryRefs: git(harness, ['for-each-ref', 'refs/git-stacks/']),
    branchMetadata: git(harness, ['config', '--local', '--list'])
      .split('\n')
      .filter((line) => line.startsWith('branch.'))
      .sort(),
    checkout: [
      git(harness, ['symbolic-ref', '--short', 'HEAD']).trim(),
      git(harness, ['rev-parse', 'HEAD']).trim(),
    ],
    pullRequests: state.prs.map((pr) => [pr.number, pr.base, pr.state, pr.headOid]),
    stacks: (state.stacks ?? []).map((stack) => [
      stack.number,
      stack.open,
      stack.pull_requests.map((member) => [member.number, member.state, member.merged_at]),
    ]),
    // GraphQL reads are POSTs, so only the REST writes a surgery would make count.
    writes: state.requests.filter(
      (entry) => entry.argv[1] !== 'GET' && !entry.argv[0].endsWith('graphql'),
    ).length,
  }
}

/**
 * The facts about layers whose pull request already merged: where each points
 * locally and on the remote, the branch metadata that places it, and what its
 * pull request reports. An operation that does not retarget a merged pull
 * request has to leave every one of them as it found it.
 */
async function mergedLayerFacts(harness: GitHubHarness, merged: readonly Layer[]) {
  const state = await harness.readState()
  const metadata = git(harness, ['config', '--local', '--list']).split('\n')
  return {
    branches: Object.fromEntries(
      merged.map((layer) => [
        layer,
        git(harness, ['for-each-ref', '--format=%(objectname)', `refs/heads/${layer}`]).trim(),
      ]),
    ),
    remoteBranches: Object.fromEntries(
      merged.map((layer) => [
        layer,
        bareGit(harness, ['for-each-ref', '--format=%(objectname)', `refs/heads/${layer}`]).trim(),
      ]),
    ),
    metadata: merged.map((layer) => [
      layer,
      metadata.filter((line) => line.startsWith(`branch.${layer}.`)).sort(),
    ]),
    pullRequests: merged.map((layer) => {
      const pr = prFor(state, layer)
      return [layer, pr.number, pr.base, pr.state, pr.headOid]
    }),
  }
}

/**
 * A refusal has to be about the pull request GitHub already merged. The reason
 * is checked by identity rather than by the sentence that states it, and by
 * what the refused run leaves behind: no ref, no branch metadata, no remote
 * branch, no pull request base, no stack membership, no write to the host and
 * no journal for a recovery that was never started.
 */
async function refusedSurgery(
  harness: GitHubHarness,
  layers: Record<Layer, { number: number }>,
  request: SurgeryRequest,
  merged: readonly Layer[],
): Promise<SurgeryPreview> {
  const before = await untouchedFacts(harness)
  const plan = await preview(harness, request)
  assert.ok(plan.blockers.length > 0, 'the surgery is refused instead of offered for review')
  for (const layer of merged) {
    const number = layers[layer].number
    assert.ok(
      plan.blockers.some((blocker) => blocker.includes(`#${number}`)),
      `the refusal is about merged pull request #${number}: ${JSON.stringify(plan.blockers)}`,
    )
  }
  await assert.rejects(runSurgery(harness.repo, plan.token, true, false))
  assert.deepEqual(
    await untouchedFacts(harness),
    before,
    'the refused surgery changed nothing it would have had to be reviewed for',
  )
  assert.equal(
    await getStackProgress(harness.repo),
    null,
    'no recovery journal is left behind by a run that never started',
  )
  return plan
}

test('a published layer whose pull request merged is not moved', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedStackWithMergedDownstack(harness, 'two')

    const plan = await refusedSurgery(
      harness,
      layers,
      { kind: 'move', branch: 'two', target: 'one' },
      ['two'],
    )
    assert.deepEqual(plan.layers, [], 'no branch is offered for rewriting behind the refusal')
    assert.deepEqual(plan.retargets, [], 'no pull request is offered for retargeting')
  })
})

test('a published layer whose pull request merged is not removed', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedStackWithMergedDownstack(harness, 'two')

    const plan = await refusedSurgery(harness, layers, { kind: 'remove', branch: 'two' }, ['two'])
    assert.deepEqual(plan.layers, [], 'the layer is not offered for deletion either')
    assert.deepEqual(
      plan.closes,
      [],
      'a merged pull request is not offered for closing as part of a removal',
    )
  })
})

test('inserting a layer under a merged pull request is refused', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedStackWithMergedDownstack(harness, 'two')

    const plan = await refusedSurgery(
      harness,
      layers,
      { kind: 'insert', branch: 'one', name: 'pilot' },
      ['two'],
    )
    const refused = plan.layers
      .filter((layer) => layer.blockers.length > 0)
      .map((layer) => layer.branch)
    assert.ok(
      refused.includes('two'),
      `the merged layer is the one GitHub will not retarget: ${JSON.stringify(refused)}`,
    )
  })
})

test('reordering a stack across a merged pull request is refused', async () => {
  await withPublishedStack(async (harness) => {
    const layers = await publishedStackWithMergedDownstack(harness, 'two')

    const plan = await refusedSurgery(
      harness,
      layers,
      { kind: 'move', branch: 'four', target: 'one' },
      ['two'],
    )
    const refused = plan.layers
      .filter((layer) => layer.blockers.length > 0)
      .map((layer) => layer.branch)
    assert.ok(
      refused.includes('two'),
      `moving four below the merged layer would retarget it: ${JSON.stringify(refused)}`,
    )
    assert.ok(
      plan.layers.some((layer) => layer.branch === 'four'),
      'the layer that was actually moved is still reviewed, so the refusal is the merged one',
    )
  })
})

test('inserting above a merged pull request moves the open layers and leaves the merged ones alone', async () => {
  await withPublishedStack(async (harness) => {
    const merged = ['one', 'two'] as const
    const layers = await publishedStackWithMergedDownstack(harness, 'two')
    const before = await mergedLayerFacts(harness, merged)

    // The new layer lands between the merged layer and the first open one, so
    // nothing GitHub already merged is retargeted.
    const plan = await preview(harness, { kind: 'insert', branch: 'two', name: 'pilot' })
    assert.deepEqual(plan.blockers, [])
    await runSurgery(harness.repo, plan.token, true, false)

    const state = await harness.readState()
    assert.deepEqual(
      await mergedLayerFacts(harness, merged),
      before,
      'the merged layers keep their tips, their metadata and their pull requests',
    )
    const stack = (state.stacks ?? []).find((entry) => entry.number === 1)
    assert.deepEqual(
      stack?.pull_requests.map((member) => member.number),
      merged.map((layer) => layers[layer].number),
      'the merged pull requests stay in the stack GitHub does not unstack them from',
    )
    assert.equal(prFor(state, 'three').base, 'pilot', 'the open layer above the insert moved')
    assert.equal(config(harness, 'branch.three.parent'), 'pilot')
    assert.equal(
      bareGit(harness, ['rev-parse', 'refs/heads/pilot']),
      layers.two.tip,
      'the inserted branch is published at the tip it was created from',
    )
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', 'pilot', 'three']),
      '',
      'the replayed open layer descends from the branch published for it',
    )
    assert.equal(await getStackProgress(harness.repo), null)
  })
})
