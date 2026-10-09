import { getSnapshot, runAction } from '../../../src/main/git'
import { previewStack } from '../../../src/main/stacks'
import {
  createPullRequestStack,
  listPullRequestStacks,
  unstackPullRequestStack,
} from '../../../src/main/native-stacks'
import { isRecord } from '@git-stacks/shared/guards'
import { twoLayerStack } from '../layers'
import { assert, publishChoices, type LiveScenario, type LiveScenarioContext } from '../scenario'
import type { StackPreview } from '@git-stacks/shared/types'

/**
 * The publish preview is the app's own statement of what it is about to do, and it
 * captures the remote heads and pull request identities as leases. Taking one and
 * then letting somebody else move the world is exactly the window the races below
 * live in, so every one of them starts here rather than from a private fixture.
 */
async function publishPreview(ctx: LiveScenarioContext, branch: string): Promise<StackPreview> {
  const snapshot = await getSnapshot(ctx.workspace.path)
  const preview = await previewStack(ctx.workspace.path, snapshot, 'publish', branch)
  assert(preview.publish !== null, `the publish preview for ${branch} carried no plan`)
  return preview
}

/** How many pull requests the host currently has open for a head branch. */
async function openPullRequestsFor(ctx: LiveScenarioContext, branch: string): Promise<number[]> {
  const listed = await ctx.transport.paginate<Record<string, unknown>>({
    method: 'GET',
    path: `repos/${ctx.repository}/pulls`,
  })
  return listed
    .filter((entry) => isRecord(entry.head) && entry.head.ref === branch)
    .map((entry) => Number(entry.number))
    .sort((left, right) => left - right)
}

/** The base ref the host currently holds for a pull request. */
async function baseOf(ctx: LiveScenarioContext, number: number): Promise<string | null> {
  const pull = await ctx.admin.readPullRequest(ctx.repository, number)
  return isRecord(pull.base) && typeof pull.base.ref === 'string' ? pull.base.ref : null
}

/**
 * The head the host holds for a branch, asked of the host.
 *
 * A remote-tracking ref is this clone's last idea of the remote, written by whichever
 * fetch ran most recently. Whether an outside actor's commit survived has exactly one
 * authority, and it is the host: a fetch that has not run yet, or that ran before the
 * push landed, would otherwise prove nothing either way.
 */
function remoteHead(ctx: LiveScenarioContext, branch: string): Promise<string> {
  return ctx.admin.headSha(ctx.repository, branch)
}

/** What the external actor did, and the head it left behind. */
async function pushOutsideTheApp(
  ctx: LiveScenarioContext,
  branch: string,
  contents: string,
): Promise<string> {
  const outside = await ctx.workspace.externalClone()
  await outside.gitNetwork(['fetch', 'origin'])
  outside.git(['checkout', '-B', branch, `origin/${branch}`])
  const oid = await outside.commit('outside-the-app.txt', contents, 'An outside push')
  await outside.gitNetwork(['push', '--force', 'origin', `${branch}:${branch}`])
  ctx.log(`outside actor force-pushed ${branch} to ${oid.slice(0, 8)}`)
  return oid
}

/** The submit, and whether it refused. A refusal is a valid outcome; a duplicate is not. */
async function submit(
  ctx: LiveScenarioContext,
  preview: StackPreview,
  allowForce: boolean,
  approved: Record<string, { updateBase?: boolean }> = {},
): Promise<{ refused: boolean; detail: string }> {
  const outcome = await runAction(ctx.workspace.path, {
    type: 'submitStack',
    token: preview.token,
    allowForce,
    layers: publishChoices(preview, approved),
  }).then(
    (result) => ({ detail: result.message, refused: false }),
    (error: unknown) => ({ detail: String(error), refused: true }),
  )
  ctx.log(
    outcome.refused ? `the submit refused: ${outcome.detail}` : `the submit ran: ${outcome.detail}`,
  )
  return outcome
}

export const raceScenarios: readonly LiveScenario[] = [
  {
    id: 'races/force-push-between-preview-and-submit',
    title: 'a ref moved outside the app is not overwritten by a submit that did not consent',
    requires: [],
    async run(ctx) {
      const [one, two] = await twoLayerStack(ctx, 'race-force')
      const preview = await publishPreview(ctx, two.branch)
      const before = await openPullRequestsFor(ctx, one.branch)
      const outsideHead = await pushOutsideTheApp(ctx, one.branch, 'somebody else got here first\n')
      await ctx.workspace.gitNetwork(['fetch', 'origin'])

      const outcome = await submit(ctx, preview, false)

      // Whatever the submit decided, the branch keeps exactly the pull request it
      // had, and the outside commit is still the remote head. Preservation is the
      // invariant, so it is asserted without consulting the outcome at all: a
      // submit that overwrote the ref and then threw must not be able to excuse
      // itself by having thrown.
      const after = await openPullRequestsFor(ctx, one.branch)
      assert(
        after.length === before.length && before.length > 0,
        `the branch went from ${before.length} to ${after.length} open pull requests across the race`,
      )
      const head = await remoteHead(ctx, one.branch)
      assert(
        head === outsideHead,
        `the outside commit ${outsideHead.slice(0, 8)} was replaced with ${head.slice(0, 8)} by a submit that did not consent to replacing it`,
      )
      if (outcome.refused) {
        assert(
          /force|lease|stale|moved|changed/iu.test(outcome.detail),
          `the submit refused, but not about the ref it would have replaced: ${outcome.detail}`,
        )
      }
      ctx.log(`the outside head is still ${head.slice(0, 8)}`)
    },
  },
  {
    id: 'races/retarget-between-preview-and-submit',
    title: 'a pull request retargeted outside the app is not silently re-pointed back',
    requires: [],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const [one, two] = await twoLayerStack(ctx, 'race-retarget')

      // The preview has to capture a base other than the one the layer currently
      // sits on, or the race below moves nothing and the case would pass without
      // ever executing anything. A release branch stands in for that other base:
      // the layer is moved onto it first, so the preview records a base change it
      // is being asked to approve.
      //
      // The preview still intends to write `trunk`, which is the parent this stack
      // records for its bottom layer. The outside actor below therefore retargets to
      // a third ref: moving the pull request to `trunk` would set it to the very base
      // the approved submit is going to write, and the preservation assertion would
      // hold whether or not the submit overwrote the outside retarget at all.
      const side = `${one.branch}-elsewhere`
      await ctx.admin.createBranch(ctx.repository, side, await remoteHead(ctx, trunk))
      const outside = `${one.branch}-moved-outside`
      await ctx.admin.createBranch(ctx.repository, outside, await remoteHead(ctx, trunk))
      await ctx.transport.rest<Record<string, unknown>>({
        method: 'PATCH',
        path: `repos/${ctx.repository}/pulls/${one.number}`,
        body: { base: side },
      })
      const capturedBase = await baseOf(ctx, one.number)
      assert(
        capturedBase === side,
        `the layer was not moved off ${trunk} before the race; it is based on ${String(capturedBase)}`,
      )

      const preview = await publishPreview(ctx, two.branch)
      assert(
        preview.publish?.layers.some((layer) => layer.branch === one.branch),
        `the preview had no layer for ${one.branch}`,
      )
      assert(
        preview.publish?.baseChanges.includes(one.branch),
        `the preview did not record ${one.branch} as based on the wrong ref`,
      )

      // Now the real race: the layer is retargeted outside anything the application
      // wrote, to a ref that is neither the base it is on nor the base this preview is
      // going to write, while the preview still holds what it captured.
      await ctx.transport.rest<Record<string, unknown>>({
        method: 'PATCH',
        path: `repos/${ctx.repository}/pulls/${one.number}`,
        body: { base: outside },
      })
      const outsideBase = await baseOf(ctx, one.number)
      assert(
        outsideBase === outside && outsideBase !== capturedBase,
        `the retarget did not change the base: it went from ${String(capturedBase)} to ${String(outsideBase)}`,
      )
      // The distinction has to hold before the submit runs, and not merely after it.
      // An approved submit whose intended base were the outside base would leave the
      // pull request where it found it whether it honoured the lease or ignored it.
      const intendedBase = preview.publish?.layers.find(
        (layer) => layer.branch === one.branch,
      )?.base
      assert(
        intendedBase === trunk,
        `the captured submit intends to write ${String(intendedBase)} rather than ${trunk}, so this race cannot detect it overwriting the outside base`,
      )
      assert(
        outsideBase !== intendedBase,
        `the outside base ${String(outsideBase)} is the base the captured submit already intends to write`,
      )

      // The base change is approved on screen, so the submit really does try to move
      // the pull request back to what the preview captured. That is the move this
      // scenario exists to refuse.
      const outcome = await submit(ctx, preview, false, { [one.branch]: { updateBase: true } })
      const after = await openPullRequestsFor(ctx, one.branch)
      assert(
        after.length === 1 && after[0] === one.number,
        `the race left ${after.join(', ')} open for ${one.branch}, not exactly #${one.number}`,
      )
      const base = await baseOf(ctx, one.number)
      assert(
        base === outsideBase,
        `the submit moved the externally retargeted pull request to ${String(base)} rather than leaving ${outsideBase} alone${
          outcome.refused ? ` after refusing with: ${outcome.detail}` : ''
        }`,
      )
      ctx.log(`#${one.number} still lands on ${String(base)} after the captured submit`)
    },
  },
  {
    id: 'races/merge-outside-the-app',
    title: 'a layer landed outside the app is not published again',
    requires: ['canMerge'],
    async run(ctx) {
      const [one, two] = await twoLayerStack(ctx, 'race-merge')
      const preview = await publishPreview(ctx, two.branch)
      const before = await openPullRequestsFor(ctx, one.branch)

      // The layer lands on the trunk by somebody else's hand, through the host's
      // own merge endpoint rather than the app's.
      const merged = await ctx.transport.rest<Record<string, unknown>>({
        method: 'PUT',
        path: `repos/${ctx.repository}/pulls/${one.number}/merge`,
        body: { merge_method: 'merge' },
      })
      assert(
        merged.data?.merged === true,
        `the host did not merge #${one.number}: ${String(merged.data?.message)}`,
      )
      ctx.log(`#${one.number} was merged outside the app`)

      await submit(ctx, preview, false)

      // Merging is the outside actor's own doing, so the open count for that head is
      // allowed to fall to zero. What the app must not do is invent a pull request:
      // every number still open was already open before the race, and the merged one
      // is not among them.
      const after = await openPullRequestsFor(ctx, one.branch)
      const invented = after.filter((number) => !before.includes(number))
      assert(
        invented.length === 0,
        `the app opened ${invented.join(', ')} for a layer that had already landed`,
      )
      assert(
        !after.includes(one.number),
        `the app re-opened #${one.number}, which is already merged`,
      )
      const landed = await ctx.admin.readPullRequest(ctx.repository, one.number)
      assert(
        landed.merged === true,
        `the host does not report #${one.number} as merged after the outside merge`,
      )
      ctx.log(`#${one.number} stayed merged; the submit opened nothing new`)
    },
  },
  {
    id: 'races/branch-deleted-outside-the-app',
    title: 'a branch deleted outside the app does not end up with a second pull request',
    requires: [],
    async run(ctx) {
      const [one, two] = await twoLayerStack(ctx, 'race-delete')
      const preview = await publishPreview(ctx, two.branch)
      const before = await openPullRequestsFor(ctx, one.branch)
      const deleted = await ctx.admin.deleteBranch(ctx.repository, one.branch)
      assert(deleted, `the host did not delete ${one.branch}`)
      ctx.log(`${one.branch} was deleted outside the app`)

      await submit(ctx, preview, true)
      const after = await openPullRequestsFor(ctx, one.branch)
      assert(
        after.length === 1,
        `the deleted branch ended up with ${after.length} open pull requests; ${before.length} existed before the deletion`,
      )
    },
  },
  {
    id: 'races/stack-membership-changed-outside-the-app',
    title: 'a stack unstacked outside the app is not re-registered from a stale capture',
    requires: ['nativeStacks'],
    async run(ctx) {
      const [owner, repo] = ctx.repository.split('/')
      const [one, two] = await twoLayerStack(ctx, 'race-unstack')
      const created = await createPullRequestStack(owner, repo, [one.number, two.number], {
        host: ctx.host,
        transport: ctx.transport,
        defaultBranch: ctx.target.defaultBranch,
      })
      const listed = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
        pullRequest: one.number,
      })
      assert(
        listed.some((stack) => stack.number === created.number),
        `stack #${created.number} is not reported as holding #${one.number} before the race`,
      )

      // The preview is taken while the stack exists, so it captures the membership
      // and plans to extend it. Only then does the world move underneath it.
      const preview = await publishPreview(ctx, two.branch)
      assert(
        preview.publish?.stackNumber === created.number,
        `the preview captured stack #${String(preview.publish?.stackNumber)}, not the one that exists`,
      )
      assert(
        preview.publish?.stackAction === 'extend',
        `the preview planned to ${String(preview.publish?.stackAction)} rather than extend`,
      )

      const dissolved = await unstackPullRequestStack(owner, repo, created.number, {
        host: ctx.host,
        transport: ctx.transport,
      })
      assert(dissolved.dissolved, `the stack did not dissolve: ${String(dissolved.stack)}`)
      ctx.log(`stack #${created.number} was dissolved outside the app's own write path`)

      await submit(ctx, preview, true)

      // The external membership is the authority. A submit that re-registered the
      // chain from the membership it captured would leave exactly one stack holding
      // these pull requests, and that stack is the bug this scenario is here for.
      const after = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
      })
      const holding = after.filter((stack) =>
        stack.pullRequests.some((member) => member.number === one.number),
      )
      assert(
        holding.length === 0,
        `after the unstack, ${holding.map((stack) => `#${stack.number}`).join(', ')} still ${
          holding.length === 1 ? 'holds' : 'hold'
        } #${one.number}; the external membership is not authoritative`,
      )
      const pullRequests = await openPullRequestsFor(ctx, one.branch)
      assert(
        pullRequests.length === 1 && pullRequests[0] === one.number,
        `the race left ${pullRequests.join(', ')} open for ${one.branch}, not exactly #${one.number}`,
      )
      ctx.log('the dissolved stack stayed dissolved and no native registration reappeared')
    },
  },
]
