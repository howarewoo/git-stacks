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
import type { PullRequest } from '../../../src/shared/types'
import { threeLayerStack, twoLayerStack } from '../layers'
import { assert, type LiveScenario, type LiveScenarioContext } from '../scenario'

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
        defaultBranch: 'main',
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
    id: 'stacks/retry-after-lost-response-creates-no-duplicate',
    title: 'a stack create whose answer was lost is not created twice',
    requires: ['nativeStacks'],
    async run(ctx) {
      const { owner, repo } = ownerAndRepo(ctx.repository)
      const [one, two] = await twoLayerStack(ctx, 'lost-create')

      // The request really is sent and the host really does apply it; only the
      // answer is discarded, which is the state a person is in when a merge may
      // or may not have been requested.
      ctx.faults.loseOnce({ method: 'POST', pathIncludes: `repos/${ctx.repository}/stacks` })
      const attempted = await createPullRequestStack(owner, repo, [one.number, two.number], {
        host: ctx.host,
        transport: ctx.transport,
        defaultBranch: 'main',
      }).then(
        (stack) => ({ stack, failed: false }),
        (error: unknown) => ({ stack: null, error, failed: true }),
      )
      assert(attempted.failed, 'a lost response should surface as a failure the caller can retry')
      ctx.log('the first create failed with the answer lost after the host applied it')

      // A retry has to adopt what the host already holds rather than write a
      // second chain over the same layers, which is the duplicate this covers.
      const adopted = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
        pullRequest: two.number,
      })
      const target = adopted[0]
      assert(
        target !== undefined,
        'no stack holds the second layer; the lost create did not land on the host',
      )
      assert(
        target.pullRequests.length === 2,
        `the landed stack holds ${target.pullRequests.length} layers, so a retry would duplicate the chain`,
      )
      const all = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
      })
      const holding = all.filter((stack) =>
        stack.pullRequests.some((member) => member.number === one.number),
      )
      assert(
        holding.length === 1,
        `the bottom layer is in ${holding.length} stacks after the lost create, not 1`,
      )
      ctx.log(`exactly one stack (#${target.number}) holds the chain`)
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
        defaultBranch: 'main',
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
    title: 'a layer whose head lives in a fork cannot join the chain',
    requires: ['nativeStacks'],
    async run(ctx) {
      const [one, two] = await twoLayerStack(ctx, 'fork-head')
      const forkRepository = `${ctx.repository.split('/')[0]}-fork/${ctx.repository.split('/')[1]}`
      const chain: PullRequest[] = [
        {
          number: one.number,
          title: one.branch,
          url: '',
          state: 'OPEN',
          draft: false,
          base: 'main',
          head: one.branch,
          checks: 'none',
          headRepository: forkRepository,
        },
        {
          number: two.number,
          title: two.branch,
          url: '',
          state: 'OPEN',
          draft: false,
          base: one.branch,
          head: two.branch,
          checks: 'none',
          headRepository: ctx.repository,
        },
      ]
      const result = validateNativeStackChain(chain, {
        targetRepository: ctx.repository,
        defaultBranch: 'main',
      })
      assert(!result.valid, 'a chain with a foreign head repository was accepted')
      assert(
        result.status === 'cross-fork-head',
        `a fork head was refused as ${result.status}, not cross-fork-head`,
      )
      ctx.log(`fork head refused: ${result.message ?? result.status}`)
    },
  },
  {
    id: 'stacks/pull-request-from-another-repository-is-refused',
    title: 'a number that names no pull request here cannot be stacked',
    requires: ['nativeStacks'],
    async run(ctx) {
      const { owner, repo } = ownerAndRepo(ctx.repository)
      const [one] = await twoLayerStack(ctx, 'cross-repo')
      const error = await createPullRequestStack(owner, repo, [one.number, 999_999], {
        host: ctx.host,
        transport: ctx.transport,
        defaultBranch: 'main',
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      assert(error !== null, 'a pull request number that names nothing was accepted into a chain')
      assert(
        isNativeStackError(error) && error.status === 'invalid-chain',
        `the cross-repository refusal was ${String(error)}`,
      )
      const listed = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
        pullRequest: one.number,
      })
      assert(
        listed.length === 0,
        `the refused create still put #${one.number} in ${listed.length} stacks`,
      )
    },
  },
]
