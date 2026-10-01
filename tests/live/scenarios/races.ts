import { getSnapshot, runAction } from '../../../src/main/git'
import { previewStack } from '../../../src/main/stacks'
import {
  createPullRequestStack,
  listPullRequestStacks,
  unstackPullRequestStack,
} from '../../../src/main/native-stacks'
import { isRecord } from '../../../src/shared/guards'
import { twoLayerStack } from '../layers'
import { assert, type LiveScenario, type LiveScenarioContext } from '../scenario'
import type { LiveWorkspace } from '../contract'
import type { PublishLayerChoice, StackPreview } from '../../../src/shared/types'

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

/** The choices a submit would publish, taken from the preview as the view would. */
function choicesOf(preview: StackPreview): Record<string, PublishLayerChoice> {
  const choices: Record<string, PublishLayerChoice> = {}
  for (const layer of preview.publish?.layers ?? []) {
    choices[layer.branch] = {
      title: layer.title,
      body: layer.body,
      draft: layer.draft,
      updateBase: layer.updateBase,
    }
  }
  return choices
}

/** How many pull requests the host currently has open for a head branch. */
async function openPullRequestsFor(ctx: LiveScenarioContext, branch: string): Promise<number[]> {
  const listed = await ctx.transport.rest<Array<Record<string, unknown>>>({
    method: 'GET',
    path: `repos/${ctx.repository}/pulls?state=open&head=${encodeURIComponent(branch)}&per_page=100`,
  })
  return (listed.data ?? [])
    .filter((entry) => isRecord(entry.head) && entry.head.ref === branch)
    .map((entry) => Number(entry.number))
    .sort((left, right) => left - right)
}

/** The base ref the host currently holds for a pull request. */
async function baseOf(ctx: LiveScenarioContext, number: number): Promise<string | null> {
  const pull = await ctx.admin.readPullRequest(ctx.repository, number)
  return isRecord(pull.base) && typeof pull.base.ref === 'string' ? pull.base.ref : null
}

/** The head the host holds for a branch, read from the remote-tracking ref. */
function remoteHead(workspace: LiveWorkspace, branch: string): string {
  return workspace.git(['rev-parse', `refs/remotes/origin/${branch}`])
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
): Promise<{ refused: boolean; detail: string }> {
  const outcome = await runAction(ctx.workspace.path, {
    type: 'submitStack',
    token: preview.token,
    allowForce,
    layers: choicesOf(preview),
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
      // had, and the outside commit is either still the remote head or was
      // replaced under a lease the preview captured rather than a blind force.
      const after = await openPullRequestsFor(ctx, one.branch)
      assert(
        after.length === before.length && before.length > 0,
        `the branch went from ${before.length} to ${after.length} open pull requests across the race`,
      )
      const head = remoteHead(ctx.workspace, one.branch)
      assert(
        head === outsideHead || outcome.refused,
        `the outside commit was replaced with neither a refusal nor a lease consent (${head.slice(0, 8)} vs ${outsideHead.slice(0, 8)})`,
      )
    },
  },
  {
    id: 'races/retarget-between-preview-and-submit',
    title: 'a pull request retargeted outside the app is not silently re-pointed back',
    requires: [],
    async run(ctx) {
      const [one, two] = await twoLayerStack(ctx, 'race-retarget')
      const preview = await publishPreview(ctx, two.branch)
      assert(
        preview.publish?.layers.some((layer) => layer.branch === one.branch),
        `the preview had no layer for ${one.branch}`,
      )

      // Somebody retargets the layer onto the trunk while the person is reading
      // the plan. The preview recorded a base; the host now holds another one.
      await ctx.transport.rest<Record<string, unknown>>({
        method: 'PATCH',
        path: `repos/${ctx.repository}/pulls/${one.number}`,
        body: { base: 'main' },
      })
      assert((await baseOf(ctx, one.number)) === 'main', 'the retarget did not take effect')

      const outcome = await submit(ctx, preview, false)
      const after = await openPullRequestsFor(ctx, one.branch)
      assert(
        after.length <= 1,
        `the race left ${after.length} open pull requests for ${one.branch}`,
      )
      const base = await baseOf(ctx, one.number)
      assert(
        base === 'main' || outcome.refused,
        `the submit moved the retargeted pull request back to ${String(base)} without refusing`,
      )
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
      const [owner, repo] = ctx.repository.split('/') as [string, string]
      const [one, two] = await twoLayerStack(ctx, 'race-unstack')
      const created = await createPullRequestStack(owner, repo, [one.number, two.number], {
        host: ctx.host,
        transport: ctx.transport,
        defaultBranch: 'main',
      })
      const dissolved = await unstackPullRequestStack(owner, repo, created.number, {
        host: ctx.host,
        transport: ctx.transport,
      })
      assert(dissolved.dissolved, `the stack did not dissolve: ${String(dissolved.stack)}`)
      ctx.log(`stack #${created.number} was dissolved outside the app's own write path`)

      // The application's read path is the only thing asserted here: after the
      // external unstack, a fresh read must not still claim the chain exists.
      const listed = await listPullRequestStacks(owner, repo, {
        host: ctx.host,
        transport: ctx.transport,
        pullRequest: one.number,
      })
      assert(
        !listed.some((stack) => stack.number === created.number),
        `stack #${created.number} is still reported after it was dissolved`,
      )
    },
  },
]
