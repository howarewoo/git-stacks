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
  const first = await pushLayer(ctx, {
    branch: `${prefix}-one`,
    parent: 'origin/main',
    base: 'main',
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
  const first = await pushLayer(ctx, {
    branch: `${prefix}-one`,
    parent: 'origin/main',
    base: 'main',
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
