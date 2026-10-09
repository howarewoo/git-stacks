import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LiveWorkspace } from './contract'
import type { Layer, LiveScenarioContext } from './scenario'
import { assert } from './scenario'

/**
 * A branch, a commit, a push, and a pull request, built the way a person builds
 * one: through the real `git` in the real clone, over the real remote.
 *
 * Every scenario that needs a stack starts here, so the layers a merge race
 * happens against are the same layers a review, a check, and a stack creation
 * see. Nothing is written into the fixture state behind the application's back.
 */

/** A branch, a commit, and a push: the three steps a layer is made of. */
export async function pushCommit(
  workspace: LiveWorkspace,
  input: { branch: string; parent: string; file: string; contents: string; message: string },
): Promise<string> {
  workspace.git(['checkout', '-B', input.branch, workspace.git(['rev-parse', input.parent])])
  const absolute = join(workspace.path, input.file)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, input.contents, 'utf8')
  workspace.git(['add', '--', input.file])
  workspace.git(['commit', '-m', input.message])
  return workspace.push(input.branch)
}

export async function pushLayer(
  ctx: LiveScenarioContext,
  input: {
    branch: string
    parent: string
    base: string
    file: string
    contents: string
    message: string
    title?: string
  },
): Promise<Layer> {
  const { admin, repository } = ctx
  const headSha = await pushCommit(ctx.workspace, input)
  // The base this layer sits on, recorded the way the application records it when it
  // manages a branch. The host's own statement is the pull request, which the double
  // and a real host both honour; what the clone cannot say on its own is where the
  // branch came from, and a preview that cannot see that plans the wrong thing.
  ctx.workspace.git(['config', `branch.${input.branch}.parent`, input.base])
  const pull = await admin.createPullRequest({
    fullName: repository,
    head: input.branch,
    base: input.base,
    title: input.title ?? `${input.branch}: live e2e layer`,
    body: `Opened by the live GitHub suite for run ${ctx.runId}.`,
  })
  assert(
    pull.number > 0,
    `GitHub did not open a pull request for ${input.branch} onto ${input.base}`,
  )
  ctx.log(`layer ${input.branch} -> #${pull.number} on ${input.base} at ${headSha.slice(0, 8)}`)
  return { branch: input.branch, number: pull.number, headSha }
}

/** A three-layer chain, bottom to top, each opened against the one below it. */
export async function threeLayerStack(
  ctx: LiveScenarioContext,
  prefix: string,
): Promise<[Layer, Layer, Layer]> {
  const trunk = ctx.target.defaultBranch
  const first = await pushLayer(ctx, {
    branch: `${prefix}-one`,
    parent: `origin/${trunk}`,
    base: trunk,
    file: `${prefix}-one.txt`,
    contents: `${prefix} one\n`,
    message: `${prefix}: first layer`,
  })
  const second = await pushLayer(ctx, {
    branch: `${prefix}-two`,
    parent: first.branch,
    base: first.branch,
    file: `${prefix}-two.txt`,
    contents: `${prefix} two\n`,
    message: `${prefix}: second layer`,
  })
  const third = await pushLayer(ctx, {
    branch: `${prefix}-three`,
    parent: second.branch,
    base: second.branch,
    file: `${prefix}-three.txt`,
    contents: `${prefix} three\n`,
    message: `${prefix}: third layer`,
  })
  return [first, second, third]
}

/** A two-layer chain, the smallest shape the stack and merge scenarios need. */
export async function twoLayerStack(
  ctx: LiveScenarioContext,
  prefix: string,
): Promise<[Layer, Layer]> {
  const trunk = ctx.target.defaultBranch
  const first = await pushLayer(ctx, {
    branch: `${prefix}-one`,
    parent: `origin/${trunk}`,
    base: trunk,
    file: `${prefix}-one.txt`,
    contents: `${prefix} one\n`,
    message: `${prefix}: first layer`,
  })
  const second = await pushLayer(ctx, {
    branch: `${prefix}-two`,
    parent: first.branch,
    base: first.branch,
    file: `${prefix}-two.txt`,
    contents: `${prefix} two\n`,
    message: `${prefix}: second layer`,
  })
  return [first, second]
}

/**
 * A two-layer chain whose branches are pushed but never opened as pull requests.
 *
 * The publish preview treats a branch with no pull request as work the submission
 * has to create, which is the state a person's own first push leaves behind. A
 * recovery case needs exactly that: the create request has to come from the
 * production submit path for its journal to hold an intent to recover from.
 *
 * Each branch records the one it sits on, which is what the application reads when
 * it manages a branch itself. Without a pull request the host holds no statement
 * about the chain and Git infers one only against the trunk, so an unrecorded pair
 * of stacked branches reads as two unrelated branches and the preview plans a single
 * layer — the case a recovery scenario would then prove nothing about.
 */
export async function unpublishedStack(
  ctx: LiveScenarioContext,
  prefix: string,
): Promise<[Layer, Layer]> {
  const trunk = ctx.target.defaultBranch
  const one: Layer = {
    branch: `${prefix}-one`,
    number: 0,
    headSha: await pushCommit(ctx.workspace, {
      branch: `${prefix}-one`,
      parent: `origin/${trunk}`,
      file: `${prefix}-one.txt`,
      contents: `${prefix} one\n`,
      message: `${prefix}: first layer`,
    }),
  }
  ctx.workspace.git(['config', `branch.${one.branch}.parent`, trunk])
  const two: Layer = {
    branch: `${prefix}-two`,
    number: 0,
    headSha: await pushCommit(ctx.workspace, {
      branch: `${prefix}-two`,
      parent: one.branch,
      file: `${prefix}-two.txt`,
      contents: `${prefix} two\n`,
      message: `${prefix}: second layer`,
    }),
  }
  ctx.workspace.git(['config', `branch.${two.branch}.parent`, one.branch])
  return [one, two]
}
