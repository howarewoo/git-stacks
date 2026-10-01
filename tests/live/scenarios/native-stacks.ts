import { getSnapshot, runAction } from '../../../src/main/git'
import {
  addPullRequestsToStack,
  createPullRequestStack,
  detectNativeStacksCapability,
  getPullRequestStack,
  isNativeStackError,
  listPullRequestStacks,
  unstackPullRequestStack,
  validateNativeStackChain,
} from '../../../src/main/native-stacks'
import { getSubmitStackProgress, previewStack } from '../../../src/main/stacks'
import { getGitHubData } from '../../../src/main/github'
import { getOriginUrl, parseRemote } from '../../../src/main/git-core'
import { threeLayerStack, twoLayerStack, unpublishedStack } from '../layers'
import { assert, publishChoices, type LiveScenario, type LiveScenarioContext } from '../scenario'
import type { PullRequest, StackPreview } from '../../../src/shared/types'

const ownerAndRepo = (repository: string): { owner: string; repo: string } => {
  const [owner, repo] = repository.split('/')
  return { owner, repo }
}

/**
 * The exact set of pull requests the host reports as members, which is the only
 * statement about a stack that both a live host and a controlled runtime can make
 * without either of them agreeing with the client.
 */
async function stackMembers(ctx: LiveScenarioContext, stackNumber: number): Promise<number[]> {
  const { owner, repo } = ownerAndRepo(ctx.repository)
  const stack = await getPullRequestStack(owner, repo, stackNumber, {
    host: ctx.host,
    transport: ctx.transport,
  })
  return stack.pullRequests.map((member) => member.number).sort((left, right) => left - right)
}

/**
 * The open pull requests the host currently reports for a head branch, read by the
 * production reader and identified by what it parsed.
 *
 * A recovery case has to know which pull requests exist without knowing which
 * numbers to ask for: the whole point is that the host assigned them. Reading the
 * repository's own conversation through the application is what turns that into an
 * answer rather than a guess.
 */
async function openPullRequestsFor(ctx: LiveScenarioContext, branch: string): Promise<number[]> {
  const remote = await getOriginUrl(ctx.workspace.path)
  assert(remote !== null, 'the clone has no origin remote to read the conversation from')
  const data = await getGitHubData(ctx.workspace.path, remote)
  assert(data.available, `the application could not read this repository: ${data.message}`)
  return data.pullRequests
    .filter((entry) => entry.head === branch)
    .map((entry) => entry.number)
    .sort((left, right) => left - right)
}

/**
 * The publish preview for branches that have no pull request yet.
 *
 * This is the state a person's own first push leaves behind, and the only one in
 * which the production submit path creates pull requests at all. A recovery case
 * has to go through it: a create sent from a scenario's own call carries no intent
 * for the journal to recover, so the production recovery is never exercised.
 */
async function unpublishedPreview(
  ctx: LiveScenarioContext,
  branch: string,
): Promise<StackPreview> {
  const snapshot = await getSnapshot(ctx.workspace.path)
  const preview = await previewStack(ctx.workspace.path, snapshot, 'publish', branch)
  assert(preview.publish !== null, `the publish preview for ${branch} carried no plan`)
  const creating = preview.publish.layers.filter((layer) => layer.create)
  assert(
    creating.length === preview.publish.layers.length,
    `the preview planned to create ${creating.length} of ${preview.publish.layers.length} pull requests`,
  )
  return preview
}

/** Dispatch the captured preview, and the failure it raised if it raised one. */
async function submitPreview(ctx: LiveScenarioContext, preview: StackPreview): Promise<unknown> {
  return runAction(ctx.workspace.path, {
    type: 'submitStack',
    token: preview.token,
    allowForce: false,
    layers: publishChoices(preview),
  }).then(
    () => null,
    (error: unknown) => error,
  )
}

/** The stacks that hold any of these pull requests, by number. */
async function stacksHolding(ctx: LiveScenarioContext, numbers: readonly number[]): Promise<number[]> {
  const { owner, repo } = ownerAndRepo(ctx.repository)
  const listed = await listPullRequestStacks(owner, repo, {
    host: ctx.host,
    transport: ctx.transport,
  })
  return listed
    .filter((stack) => stack.pullRequests.some((member) => numbers.includes(member.number)))
    .map((stack) => stack.number)
    .sort((left, right) => left - right)
}

/**
 * The real pull request of a subject this run does not own, read the way the
 * application reads one.
 *
 * `getGitHubData` is pointed at the repository the pull request really lives in,
 * through an origin derived from the host this run talks to and that repository's
 * own name. The pull request is then picked out of what the production reader
 * parsed, so the head repository in the result is the one the host reported rather
 * than a name this scenario chose, and no part of the response is assembled here.
 */
async function readForeignPullRequest(
  ctx: LiveScenarioContext,
  subject: { fullName: string; number: number; url: string | null },
): Promise<PullRequest> {
  const remote = `${ctx.host.webOrigin}/${subject.fullName}.git`
  const parsed = parseRemote(remote)
  assert(
    parsed !== null && parsed.fullName.toLowerCase() === subject.fullName.toLowerCase(),
    `the origin derived for ${subject.fullName} is not that repository: ${String(parsed?.fullName ?? 'unparseable')}`,
  )
  assert(
    parsed.host === ctx.host.host,
    `the origin for ${subject.fullName} points at ${parsed.host}, not the host this run talks to`,
  )
  const data = await getGitHubData(ctx.workspace.path, remote)
  assert(
    data.available,
    `the application could not read ${subject.fullName}: ${data.message}`,
  )
  const found = data.pullRequests.find((entry) => entry.number === subject.number)
  assert(
    found !== undefined,
    `the host does not report open pull request #${subject.number} in ${subject.fullName}`,
  )
  assert(
    (found.headRepository ?? '').length > 0,
    `the host reports no head repository for ${subject.fullName}#${subject.number}`,
  )
  assert(
    (found.headRepository ?? '').toLowerCase() !== ctx.repository.toLowerCase(),
    `#${subject.number} reads with head repository ${String(found.headRepository)}, which is this repository itself, so it is not a foreign subject`,
  )
  return found
}

export const nativeStackScenarios: readonly LiveScenario[] = [
  {
    id: 'stacks/capability-is-probed',
    title: 'the native stack surface is detected rather than assumed',
    requires: ['nativeStacks'],
    async run(ctx) {
      const { owner, repo } = ownerAndRepo(ctx.repository)
      const capability = await detectNativeStacksCapability(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
      })
      assert(
        capability.available && capability.state === 'valid',
        `the stacks surface reported ${capability.state}: ${capability.message}`,
      )
    },
  },
  {
    id: 'stacks/create-extend-unstack',
    title: 'a three-layer stack is created, extended, and dissolved through the native API',
    requires: ['nativeStacks'],
    async run(ctx) {
      const { owner, repo } = ownerAndRepo(ctx.repository)
      const [one, two, three] = await threeLayerStack(ctx, 'create-extend')

      const created = await createPullRequestStack(owner, repo, [one.number, two.number], {
        host: ctx.host,
        transport: ctx.transport,
        defaultBranch: ctx.target.defaultBranch,
      })
      assert(
        created.pullRequests.length === 2,
        `the created stack holds ${created.pullRequests.length} layers, not 2`,
      )
      ctx.log(`created stack #${created.number} with ${created.pullRequests.length} layers`)

      const extended = await addPullRequestsToStack(owner, repo, created.number, [three.number], {
        host: ctx.host,
        transport: ctx.transport,
      })
      assert(
        extended.pullRequests.length === 3,
        `after extending, the stack holds ${extended.pullRequests.length} layers, not 3`,
      )
      const members = await stackMembers(ctx, created.number)
      const expected = [one.number, two.number, three.number].sort((left, right) => left - right)
      assert(
        members.join(',') === expected.join(','),
        `the host reports members ${members.join(',')}, not the three layers just pushed`,
      )

      const dissolved = await unstackPullRequestStack(owner, repo, created.number, {
        host: ctx.host,
        transport: ctx.transport,
      })
      assert(
        dissolved.dissolved,
        'unstacking a whole stack should dissolve it, not leave a remainder',
      )
      const remaining = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
      })
      assert(
        !remaining.some((stack) => stack.number === created.number),
        `stack #${created.number} is still listed after it was dissolved`,
      )
      ctx.log(`dissolved stack #${created.number}`)
    },
  },
  {
    id: 'stacks/lost-pull-request-create-recovers-without-duplicate',
    title: 'a publish whose pull-request answer was lost recovers the one the host created',
    requires: ['nativeStacks'],
    async run(ctx) {
      const [one, two] = await unpublishedStack(ctx, 'lost-pr')
      const preview = await unpublishedPreview(ctx, two.branch)

      // The request really is sent and the host really does apply it; only the
      // answer is discarded, which is the state a person is in when a pull request
      // may or may not have been opened.
      ctx.faults.loseOnce({ method: 'POST', pathIncludes: `repos/${ctx.repository}/pulls` })
      const failure = await submitPreview(ctx, preview)
      assert(failure !== null, 'the lost create reported success rather than an unknown outcome')
      ctx.log(`the submit failed with the answer lost: ${String(failure)}`)

      const progress = await getSubmitStackProgress(ctx.workspace.path)
      assert(
        progress !== null && progress.status !== 'completed',
        'the publish journal was cleared after a create whose answer was lost',
      )

      const first = await openPullRequestsFor(ctx, one.branch)
      assert(
        first.length === 1,
        `the host applied the lost create but holds ${first.length} pull requests for ${one.branch}, not 1`,
      )
      const second = await openPullRequestsFor(ctx, two.branch)
      assert(
        second.length === 0,
        `the submission stopped before ${two.branch} was ever sent, yet it has ${second.length} pull requests`,
      )

      await runAction(ctx.workspace.path, { type: 'submitStackRetry' })

      // Recovery adopts the identity the host already holds. Anything else here is
      // the duplicate this scenario exists for: a second pull request for either
      // layer, or a second chain over them.
      const recovered = await openPullRequestsFor(ctx, one.branch)
      assert(
        recovered.length === 1 && recovered[0] === first[0],
        `${one.branch} went from ${first.join(',')} to ${recovered.join(',')} across the recovery`,
      )
      const opened = await openPullRequestsFor(ctx, two.branch)
      assert(
        opened.length === 1,
        `${two.branch} ended the recovery with ${opened.length} open pull requests, not 1`,
      )
      const holding = await stacksHolding(ctx, [first[0], opened[0]])
      assert(
        holding.length === 1,
        `${holding.length} stacks hold the recovered chain, not 1: ${holding.join(', ')}`,
      )
      const members = await stackMembers(ctx, holding[0])
      assert(
        members.join(',') === [first[0], opened[0]].sort((left, right) => left - right).join(','),
        `stack #${holding[0]} holds ${members.join(',')} rather than the recovered pair`,
      )
      ctx.log(`recovered #${first[0]} instead of opening a second one, and registered it once`)
    },
  },
  {
    id: 'stacks/lost-stack-create-recovers-without-duplicate',
    title: 'a publish whose stack answer was lost recovers the registration the host made',
    requires: ['nativeStacks'],
    async run(ctx) {
      const [one, two] = await unpublishedStack(ctx, 'lost-stack')
      const preview = await unpublishedPreview(ctx, two.branch)

      ctx.faults.loseOnce({ method: 'POST', pathIncludes: `repos/${ctx.repository}/stacks` })
      const failure = await submitPreview(ctx, preview)
      assert(failure !== null, 'the lost stack create reported success')
      ctx.log(`the submit failed with the registration answer lost: ${String(failure)}`)

      const published = (
        await Promise.all([one, two].map((layer) => openPullRequestsFor(ctx, layer.branch)))
      ).flat()
      assert(
        published.length === 2,
        `the publication opened ${published.length} pull requests before the lost registration, not 2`,
      )

      const landed = await stacksHolding(ctx, published)
      assert(
        landed.length === 1,
        `the host applied the lost registration but ${landed.length} stacks hold the chain, not 1`,
      )
      const landedMembers = await stackMembers(ctx, landed[0])
      assert(
        landedMembers.join(',') === [...published].sort((left, right) => left - right).join(','),
        `the landed stack holds ${landedMembers.join(',')} rather than the published pair`,
      )

      await runAction(ctx.workspace.path, { type: 'submitStackRetry' })

      const after = (
        await Promise.all([one, two].map((layer) => openPullRequestsFor(ctx, layer.branch)))
      ).flat()
      assert(
        after.join(',') === [...published].sort((left, right) => left - right).join(','),
        `the recovery changed the published pull requests from ${published.join(',')} to ${after.join(',')}`,
      )
      const recovered = await stacksHolding(ctx, published)
      assert(
        recovered.length === 1 && recovered[0] === landed[0],
        `after the recovery, ${recovered.join(', ') || 'nothing'} holds the chain rather than the one registration the host already had`,
      )
      ctx.log(`adopted stack #${landed[0]} instead of registering a second one`)
    },
  },
  {
    id: 'stacks/invalid-chain-is-refused',
    title: 'a chain whose layers do not sit on each other is refused and creates nothing',
    requires: ['nativeStacks'],
    async run(ctx) {
      const { owner, repo } = ownerAndRepo(ctx.repository)
      const [one, , three] = await threeLayerStack(ctx, 'invalid-chain')

      const before = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
      })
      const error = await createPullRequestStack(owner, repo, [one.number, three.number], {
        host: ctx.host,
        transport: ctx.transport,
        defaultBranch: ctx.target.defaultBranch,
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      assert(error !== null, 'a chain with a gap was accepted')
      assert(
        isNativeStackError(error) && error.status === 'invalid-chain',
        `the refusal was ${String(error)}, not an invalid-chain NativeStackError`,
      )
      const after = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
      })
      assert(
        after.length === before.length,
        `the host went from ${before.length} to ${after.length} stacks; a refused create still wrote one`,
      )
    },
  },
  {
    id: 'stacks/fork-head-is-refused',
    title: 'a real pull request opened from a fork cannot join the chain',
    requires: ['nativeStacks'],
    async run(ctx) {
      const { owner, repo } = ownerAndRepo(ctx.repository)
      const [one] = await twoLayerStack(ctx, 'fork-head')
      const subject = await ctx.target.foreignPullRequest('fork')
      ctx.log(`the run opened #${subject.number} from the fork ${subject.fullName}`)

      // The fork's pull request lives on this repository, so the production stack
      // entry point can be asked to register it beside a real layer. Everything it
      // knows about that pull request is read from the host by the same parser the
      // application uses; nothing about the fork is asserted by this scenario.
      const before = await stacksHolding(ctx, [one.number])
      const error = await createPullRequestStack(owner, repo, [one.number, subject.number], {
        host: ctx.host,
        transport: ctx.transport,
        defaultBranch: ctx.target.defaultBranch,
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      assert(error !== null, 'a chain holding a real fork head was accepted')
      assert(
        isNativeStackError(error) && error.status === 'cross-fork-head',
        `the refusal was ${String(error)}, not a cross-fork-head NativeStackError`,
      )
      const after = await stacksHolding(ctx, [one.number])
      assert(
        after.join(',') === before.join(','),
        `the refused fork registration left ${after.join(',')} holding the layer, not ${before.join(',') || 'nothing'}`,
      )
      ctx.log(`fork head refused: ${error instanceof Error ? error.message : String(error)}`)
    },
  },
  {
    id: 'stacks/pull-request-from-another-repository-is-refused',
    title: 'a real pull request in another repository cannot join this repository’s chain',
    requires: ['nativeStacks'],
    async run(ctx) {
      const subject = await ctx.target.foreignPullRequest('repository')
      const foreign = await readForeignPullRequest(ctx, subject)
      ctx.log(`read #${foreign.number} from ${subject.fullName} as a foreign subject`)

      // This pull request belongs to another repository, so it cannot be named in
      // this repository's stack request at all. What can be asked is whether the
      // guard that stack entry point uses refuses a chain holding a pull request
      // the production reader parsed out of that repository's own conversation.
      const result = validateNativeStackChain([foreign], {
        targetRepository: ctx.repository,
        defaultBranch: ctx.target.defaultBranch,
      })
      assert(!result.valid, 'a chain holding a real cross-repository head was accepted')
      assert(
        result.status === 'cross-fork-head',
        `a head in ${subject.fullName} was refused as ${result.status}, not cross-fork-head`,
      )
      ctx.log(`cross-repository head refused: ${result.message ?? result.status}`)
    },
  },
]