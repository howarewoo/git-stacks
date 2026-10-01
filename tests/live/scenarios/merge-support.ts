import { getSnapshot, runAction } from '../../../src/main/git'
import { GitHubTransportError, type GitHubErrorKind } from '../../../src/main/github-transport'
import { previewStack } from '../../../src/main/stacks'
import { assert } from '../scenario'
import {
  pollAsyncMerge,
  startAsyncMerge,
  type AsyncMergeResult,
  type AsyncMergeStart,
} from '../../../src/main/merge-async'
import { pushLayer } from '../layers'
import type { LiveScenarioContext } from '../scenario'
import type { MergeAction, MergeMethod } from '../../../src/shared/types'

/**
 * How long a live merge is given to reach a terminal answer.
 *
 * GitHub documents the asynchronous merge as background work: a request that is
 * accepted is answered `202 pending` and finished afterwards, sometimes seconds
 * later. Polling with the interval replaced by nothing therefore reads the request
 * back before the host has done anything with it, and every gated merge is then
 * reported as a request that never settled. The bound is real elapsed time, and a
 * run that exhausts it still reports `pending` rather than inventing a verdict.
 */
const TERMINAL_POLL = { maxAttempts: 30, intervalMs: 1_000 } as const

/** One merge request, from the accept to whatever GitHub eventually reported. */
export interface MergeAttempt {
  /** What the request itself was answered with, or null when it was refused. */
  readonly accepted: AsyncMergeStart | null
  /**
   * The last result read from the request, or null when GitHub answered a terminal
   * result outright and left nothing to poll.
   */
  readonly settled: AsyncMergeResult | null
  readonly error: unknown
  readonly kind: GitHubErrorKind | null
  readonly detail: string
}

/**
 * Ask the host to land a pull request and read the request through to its end.
 *
 * The refusal and the result are reported apart on purpose: "GitHub refused this"
 * and "GitHub is still working on this" are different bugs, and a caller that
 * cannot tell them apart will call a correctly gated merge a failure.
 */
export async function requestMerge(
  ctx: LiveScenarioContext,
  input: {
    number: number
    sha: string
    mergeMethod: MergeMethod | null
    mergeAction: MergeAction
  },
): Promise<MergeAttempt> {
  let accepted: AsyncMergeStart | null = null
  try {
    accepted = await startAsyncMerge({
      fullName: ctx.repository,
      number: input.number,
      sha: input.sha,
      mergeMethod: input.mergeMethod,
      mergeAction: input.mergeAction,
      host: ctx.host,
    })
  } catch (error) {
    const kind = error instanceof GitHubTransportError ? error.kind : null
    return { accepted: null, settled: null, error, kind, detail: String(error) }
  }
  const uuid = accepted.result.uuid
  if (accepted.result.status !== 'pending' || uuid === null) {
    return {
      accepted,
      settled: accepted.result,
      error: null,
      kind: null,
      detail: `${accepted.result.status}: ${accepted.result.message ?? 'no message'}`,
    }
  }
  const settled = await pollAsyncMerge(
    { fullName: ctx.repository, number: input.number, uuid, host: ctx.host },
    TERMINAL_POLL,
  )
  return {
    accepted,
    settled,
    error: null,
    kind: null,
    detail: `${settled.status}: ${settled.message ?? 'no message'}`,
  }
}

/** One mergeable layer with its own head, which is what a check or a rule attaches to. */
export function mergeableLayer(ctx: LiveScenarioContext, prefix: string) {
  const trunk = ctx.target.defaultBranch
  return pushLayer(ctx, {
    branch: `${prefix}-layer`,
    parent: `origin/${trunk}`,
    base: trunk,
    file: `${prefix}.txt`,
    contents: `${prefix}\n`,
    message: `${prefix}: a layer to merge`,
  })
}

/**
 * The merge the production path would run, driven the way the view drives it.
 *
 * A terminal result and the journal entry that says so are only evidence about the
 * host when they were written by the merge path itself. Driving the preview and the
 * action the preview belongs to is what makes the observation the application's
 * rather than the scenario's, and the same helper serves every case whose claim is
 * that production did the thing.
 */
export async function mergeThroughProduction(
  ctx: LiveScenarioContext,
  branch: string,
  mergeAction: 'default' | 'direct_merge' | 'merge_queue',
): Promise<{ message: string }> {
  const snapshot = await getSnapshot(ctx.workspace.path)
  const preview = await previewStack(ctx.workspace.path, snapshot, 'merge', branch)
  assert(preview.merge !== null, `the merge preview for ${branch} carried no plan`)
  assert(
    preview.merge.actions.includes(mergeAction),
    `the preview offers ${preview.merge.actions.join(', ')}, not ${mergeAction}`,
  )
  return runAction(ctx.workspace.path, {
    type: 'executeStack',
    token: preview.token,
    allowForce: false,
    mergeAction,
    mergeMethod: 'merge',
  })
}
