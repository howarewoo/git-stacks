import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitHubTransportError, setGitHubTransport } from '../../../src/main/github-transport'
import { getSnapshot, runAction } from '../../../src/main/git'
import { getOriginUrl } from '../../../src/main/git-core'
import { getGitHubIssues } from '../../../src/main/github'
import { originRemote, readReviewFilesFrom } from '../../../src/main/review'
import {
  clearPullRequestChecksCache,
  getPullRequestChecks,
} from '../../../src/main/pull-request-checks'
import { pollAsyncMerge } from '../../../src/main/merge-async'
import { submitReview } from '../../../src/main/review-threads'
import type { ReviewFile } from '../../../src/shared/review'
import { previewStack } from '../../../src/main/stacks'
import { RepositoryScheduler } from '../../../src/main/repository-scheduler'
import { RepositorySyncCoordinator, type SyncEvent } from '../../../src/main/sync-coordinator'
import { LiveRedactor } from '../diagnostics'
import {
  SCHEMA_PROBES,
  breakingDrift,
  compareSchemas,
  observeSchema,
  prepareSchemaSubject,
  renderDrift,
  type ObservedField,
  type ObservedSchema,
} from '../observed-schema'
import { readCommittedSchema } from '../schema-fixture'
import { pushLayer } from '../layers'
import { mergeThroughProduction, mergeableLayer, requestMerge } from './merge-support'
import {
  anchorsFrom,
  assert,
  publishChoices,
  type LiveScenario,
  type LiveScenarioContext,
} from '../scenario'

/**
 * The remote head, read from the remote.
 *
 * A local tracking ref is a note the workspace left for itself: it moves when a
 * fetch runs, so it can agree with an overwrite that already happened or disagree
 * with one that did not. `ls-remote` asks the remote itself, which is the only
 * question worth asking when the claim is that a push changed nothing.
 */
async function remoteHeadOf(ctx: LiveScenarioContext, branch: string): Promise<string | null> {
  const listed = await ctx.workspace.gitNetwork(['ls-remote', '--heads', 'origin', branch])
  const line = listed
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (line === undefined) return null
  return line.split(/\s+/u)[0] ?? null
}

/** Wait for one event the coordinator publishes, or give up after a real wait. */
function nextEvent(
  events: SyncEvent[],
  take: (event: SyncEvent) => boolean,
  withinMs: number,
): Promise<SyncEvent | null> {
  const { promise, resolve } = Promise.withResolvers<SyncEvent | null>()
  const started = Date.now()
  const tick = (): void => {
    const found = events.find(take)
    if (found !== undefined || Date.now() - started >= withinMs) resolve(found ?? null)
    else setTimeout(tick, 25)
  }
  tick()
  return promise
}

/**
 * A repository held open by the real background refresh, reading through the same
 * production readers the window uses.
 */
function openCoordinator(ctx: LiveScenarioContext): {
  coordinator: RepositorySyncCoordinator
  events: SyncEvent[]
} {
  const events: SyncEvent[] = []
  const coordinator = new RepositorySyncCoordinator(
    {
      readSnapshot: (_root, signal, request) =>
        getSnapshot(ctx.workspace.path, signal, undefined, request.github.remote),
      readIssues: async (_root, signal) => {
        const issues = await getGitHubIssues(
          ctx.workspace.path,
          await getOriginUrl(ctx.workspace.path, signal),
          signal,
        )
        if (issues.message) throw new Error(issues.message)
        return issues.issues
      },
      scheduler: new RepositoryScheduler(),
    },
    // Short enough that the background poll actually comes due inside the scenario, and
    // the local settle short with it. The failure backoff is left at its production value:
    // it is what decides how long the coordinator stays parked after a limit, and
    // shortening it here would shorten the very wait this case measures.
    { visibleMs: 100, secondaryMs: 100, localSettleMs: 50 },
  )
  coordinator.onEvent((event) => events.push(event))
  return { coordinator, events }
}

/**
 * The recorded host answer with one parser-depended field altered, which is the
 * only change to a remote this tool can see: a field a consumer reads stops
 * answering, or answers with another type.
 *
 * The committed document is what the host answered, which the matching case above
 * proves against a live read. Staging the alteration on it keeps these two cases
 * about the drift consumer rather than about a second reading of the same host.
 */
function withAlteredField(
  schema: ObservedSchema,
  probeId: string,
  alter: (field: ObservedField) => ObservedField | null,
): ObservedSchema {
  const declaration = SCHEMA_PROBES.find((entry) => entry.id === probeId)
  assert(declaration !== undefined, `no probe is named ${probeId}`)
  const dependency = declaration.dependsOn[0]
  assert(
    dependency !== undefined,
    `the ${probeId} probe declares no field for a parser to depend on`,
  )
  const fields = schema.probes[probeId] ?? []
  const index = fields.findIndex((field) => field.path === dependency)
  assert(
    index >= 0,
    `the ${probeId} probe depends on ${dependency}, which its own observation does not carry`,
  )
  const altered = alter(fields[index] as ObservedField)
  return {
    ...schema,
    probes: {
      ...schema.probes,
      [probeId]:
        altered === null
          ? fields.filter((_, at) => at !== index)
          : fields.map((field, at) => (at === index ? altered : field)),
    },
  }
}

/** The other type a field could answer with, so the alteration is a real change. */
const otherType = (type: string): string => (type === 'array' ? 'string' : 'array')

const mergedOnHost = async (
  ctx: LiveScenarioContext,
  number: number,
): Promise<{ merged: boolean; sha: string | null }> => {
  const read = await ctx.transport.rest<{ merged: boolean; merge_commit_sha: string | null }>({
    method: 'GET',
    path: `repos/${ctx.repository}/pulls/${number}`,
  })
  return { merged: read.data.merged === true, sha: read.data.merge_commit_sha ?? null }
}

/** Records the rule set so cleanup removes it even if the scenario throws. */
function trackRuleSet(ctx: LiveScenarioContext, id: number): string {
  const full = `${ctx.repository}/rulesets/${id}`
  ctx.target.resources.record({
    kind: 'rule-set',
    handle: full,
    marker: ctx.marker,
    createdAt: new Date().toISOString(),
  })
  return full
}

/**
 * One merge-async request sent exactly as GitHub documents the endpoint, then read back
 * through the production poll.
 *
 * `sha` is documented as optional: a request that names none merges the head the pull
 * request has, and is cancelled if that head moves before the request runs. The
 * application's own request always names a head, so the documented request that omits
 * it has to be made here or it is never exercised at all — and a fixture that answered
 * it with an error would leave production believing the host refuses a request GitHub
 * performs. The result is read with `pollAsyncMerge`, so what the case asserts about the
 * outcome is what the product itself would have read.
 */
async function mergeAsDocumented(
  ctx: LiveScenarioContext,
  number: number,
  sha: string | null,
): Promise<{ status: string; message: string }> {
  const accepted = await ctx.transport.rest<{ details?: { uuid?: string } }>({
    method: 'PUT',
    path: `repos/${ctx.repository}/pulls/${number}/merge-async`,
    body: { merge_action: 'direct_merge', merge_method: 'merge', ...(sha === null ? {} : { sha }) },
  })
  const uuid = accepted.data.details?.uuid
  if (accepted.status !== 202 || typeof uuid !== 'string') {
    return { status: `http-${accepted.status}`, message: 'the host did not accept the request' }
  }
  const settled = await pollAsyncMerge(
    { fullName: ctx.repository, number, uuid, host: ctx.host },
    { maxAttempts: 30, intervalMs: 1_000 },
  )
  return { status: settled.status, message: settled.message ?? '' }
}

export const ruleAndFaultScenarios: readonly LiveScenario[] = [
  {
    id: 'rules/an-active-required-check-refuses-until-it-passes',
    title: 'an active required check refuses the merge until it passes, and then lets it land',
    requires: ['ruleSets', 'checks', 'asyncMerge', 'canMerge'],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const required = 'git-stacks-live-e2e/required'
      // Scoped to the provisioned base, because a rule set that is active but protects a
      // different ref is enforced nowhere, and the case would then be proving nothing
      // about required checks at all.
      const created = await ctx.admin.createRuleSet({
        name: 'git-stacks-live-e2e required check',
        enforcement: 'active',
        baseRefs: [`refs/heads/${trunk}`],
        requiredStatusCheck: required,
      })
      const tracked = trackRuleSet(ctx, created.id)
      try {
        const layer = await mergeableLayer(ctx, 'rules-check')

        // The effective branch rules the product reads have to name the configured
        // context. A host that stored the rule without its parameters reports no required
        // check here while refusing the very merge for one, and the window would tell the
        // person their merge is ready.
        clearPullRequestChecksCache()
        const outstanding = await getPullRequestChecks(ctx.workspace.path, layer.number, {
          headSha: layer.headSha,
          base: trunk,
          force: true,
        })
        assert(outstanding.available, `the checks read was unavailable: ${outstanding.message}`)
        const expected = outstanding.checks.find((check) => check.name === required)
        assert(
          expected !== undefined,
          `an active rule set requiring ${required} is not in the required set: ${outstanding.checks.map((check) => `${check.name}=${check.state}/${check.requirement}`).join(', ')}`,
        )
        assert(
          expected.requirement === 'required' && expected.expected === true,
          `${required} is reported as ${expected.requirement} and expected=${String(expected.expected)} rather than a required check that has not reported`,
        )

        const blocked = await requestMerge(ctx, {
          number: layer.number,
          sha: layer.headSha,
          mergeMethod: 'merge',
          mergeAction: 'direct_merge',
        })
        assert(
          blocked.settled !== null && blocked.settled.status === 'failed',
          `the merge with ${required} unsatisfied ended as ${blocked.settled?.status ?? 'nothing'} rather than a definite refusal: ${blocked.detail}`,
        )
        const refused = await mergedOnHost(ctx, layer.number)
        assert(!refused.merged, `#${layer.number} is merged although ${required} never reported`)

        await ctx.admin.createCheckRun({
          fullName: ctx.repository,
          headSha: layer.headSha,
          name: required,
          status: 'completed',
          conclusion: 'success',
        })
        clearPullRequestChecksCache()
        const resolved = await getPullRequestChecks(ctx.workspace.path, layer.number, {
          headSha: layer.headSha,
          base: trunk,
          force: true,
        })
        const reported = resolved.checks.find((check) => check.name === required)
        assert(
          reported?.state === 'success' && reported.expected === false,
          `${required} reads as ${String(reported?.state)} and expected=${String(reported?.expected)} after it passed`,
        )

        // The head lease, under the same satisfied rule. A request that names no head is
        // the documented request that merges the head the pull request has, and a request
        // that names a head which has moved is cancelled. Both have to hold while the
        // rule is active, because the rule is what makes the head worth leasing.
        const stale = '0'.repeat(40)
        const staleAttempt = await mergeAsDocumented(ctx, layer.number, stale)
        assert(
          staleAttempt.status === 'failed',
          `a request naming the stale head ${stale.slice(0, 8)} ended as ${staleAttempt.status}: ${staleAttempt.message}`,
        )
        assert(
          !(await mergedOnHost(ctx, layer.number)).merged,
          `#${layer.number} merged against a head that was never pushed`,
        )

        // And the production merge, which is what the person in the window actually runs.
        const landed = await mergeThroughProduction(ctx, layer.branch, 'direct_merge')
        ctx.log(`the production merge landed once ${required} passed: ${landed.message}`)
        const pull = await mergedOnHost(ctx, layer.number)
        assert(pull.merged, `#${layer.number} is not merged on the host after ${required} passed`)
      } finally {
        await ctx.admin.deleteRuleSet(ctx.repository, created.id)
        ctx.target.resources.release(tracked)
      }
    },
  },
  {
    id: 'rules/an-active-required-approval-refuses-until-a-reviewer-approves',
    title: 'an active required approval refuses the author merge until a second account approves',
    requires: ['ruleSets', 'reviewThreads', 'secondReviewer', 'asyncMerge', 'canMerge'],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const created = await ctx.admin.createRuleSet({
        name: 'git-stacks-live-e2e required approval',
        enforcement: 'active',
        baseRefs: [`refs/heads/${trunk}`],
        requiredApprovals: 1,
      })
      const tracked = trackRuleSet(ctx, created.id)
      try {
        const layer = await mergeableLayer(ctx, 'rules-approval')
        const blocked = await requestMerge(ctx, {
          number: layer.number,
          sha: layer.headSha,
          mergeMethod: 'merge',
          mergeAction: 'direct_merge',
        })
        assert(
          blocked.settled !== null && blocked.settled.status === 'failed',
          `the author's own merge with one approval required ended as ${blocked.settled?.status ?? 'nothing'}: ${blocked.detail}`,
        )

        const reviewer = ctx.target.reviewer
        assert(reviewer !== null, 'no second account was supplied for this run')
        // The application holds one signed-in account at a time, so the run signs the
        // reviewer in for the duration of their write and restores the author afterwards.
        // The approval is then the reviewer's, and not the author's own.
        const author = ctx.transport
        setGitHubTransport(reviewer.transport())
        let approval: unknown = null
        try {
          const files = await readReviewFilesFrom(
            await originRemote(ctx.workspace.path),
            layer.number,
          )
          const file = files.files[0]
          assert(file !== undefined, 'the diff had no file to anchor an approval to')
          await submitReview(ctx.workspace.path, layer.number, {
            event: 'APPROVE',
            body: 'Approved by the second account.',
            drafts: anchorsFrom(files, file.path).slice(0, 1),
            comparison: files.comparison,
          })
        } catch (error) {
          approval = error
        } finally {
          setGitHubTransport(author)
        }
        assert(approval === null, `the second account could not approve: ${String(approval)}`)

        const landed = await mergeThroughProduction(ctx, layer.branch, 'direct_merge')
        ctx.log(`approved by ${reviewer.login} and the production merge landed: ${landed.message}`)
        const pull = await mergedOnHost(ctx, layer.number)
        assert(pull.merged, `#${layer.number} is not merged on the host after the approval`)
      } finally {
        await ctx.admin.deleteRuleSet(ctx.repository, created.id)
        ctx.target.resources.release(tracked)
      }
    },
  },
  {
    id: 'faults/force-push-preserves-the-remote',
    title: 'a force-push refusal still leaves the outside commit on the remote',
    requires: [],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const branch = 'force-preserve-layer'
      const layer = await pushLayer(ctx, {
        branch,
        parent: `origin/${trunk}`,
        base: trunk,
        file: 'force-preserve.txt',
        contents: 'force-preserve\n',
        message: 'force-preserve: a layer with a head of its own',
      })

      // Somebody outside the application, in their own clone, with their own
      // credentials, moves the head the application thinks it published.
      const outside = await ctx.workspace.externalClone()
      outside.gitNetwork(['fetch', 'origin'])
      outside.git(['checkout', '-B', branch, `origin/${trunk}`])

      const outsideHead = await outside.commit(
        'force-preserve.txt',
        'the outside commit\n',
        'force-preserve: an outside commit',
      )
      await outside.gitNetwork(['push', '--force', 'origin', branch])
      const before = await remoteHeadOf(ctx, branch)
      assert(
        before === outsideHead,
        `the outside push left the remote at ${String(before)} rather than ${outsideHead}`,
      )
      ctx.log(`the outside actor's commit ${outsideHead} is on the remote`)

      // The application's own refresh fetches before it reads, so a person whose branch
      // moved outside the app has that commit in their clone by the time they look at
      // a preview. Fetching here is that step: a preview against a clone that has never
      // seen the commit the remote holds is a state no person can be in, and it would
      // say more about the clone than about the refusal under test.
      await ctx.workspace.gitNetwork(['fetch', 'origin', branch])

      const snapshot = await getSnapshot(ctx.workspace.path)
      const preview = await previewStack(ctx.workspace.path, snapshot, 'publish', branch)
      const outcome = await runAction(ctx.workspace.path, {
        // The preview was taken from the publish surface, so it is executed by the action
        // that surface produces. Handing a publish preview to Execute Stack is refused
        // before any publish or force logic runs, and that unrelated refusal would let a
        // Submit Stack that never checked its force consent look exactly like one that did.
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: publishChoices(preview),
      }).then(
        (result) => ({ refused: false, detail: result.message }),
        (error: unknown) => ({ refused: true, detail: String(error) }),
      )
      ctx.log(
        `the application answered: ${outcome.refused ? 'refused' : 'accepted'}, ${outcome.detail}`,
      )
      assert(
        outcome.refused,
        `a submit that did not consent to replacing the ref published it anyway: ${outcome.detail}`,
      )
      assert(
        /force/iu.test(outcome.detail),
        `the submit refused, but not about the force it would have had to consent to: ${outcome.detail}`,
      )
      // The refusal is beside the point, and it is not the only thing being asserted. The
      // outside commit is still the remote's head whether the application refused,
      // gave up, or reported success, and only the remote can say so.
      const after = await remoteHeadOf(ctx, branch)
      assert(
        after === outsideHead,
        `the remote head is ${String(after)}, not the outside commit ${outsideHead} the run started from`,
      )
      ctx.log(`the remote still holds ${outsideHead}`)
    },
  },
  {
    id: 'faults/rejected-credential-writes-nothing',
    title: 'a rejected credential surfaces as unauthorized and writes nothing',
    requires: ['asyncMerge'],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'fault-token')
      ctx.faults.refuseOnce(
        {
          method: 'PUT',
          pathIncludes: `repos/${ctx.repository}/pulls/${layer.number}/merge-async`,
        },
        { status: 401, kind: 'unauthorized', message: 'Bad credentials' },
      )
      const outcome = await requestMerge(ctx, {
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
      })
      assert(
        outcome.kind === 'unauthorized',
        `the rejected credential surfaced as ${outcome.detail}, not as unauthorized`,
      )
      assert(outcome.accepted === null, 'a refused credential still produced a merge request')
      const pull = await mergedOnHost(ctx, layer.number)
      assert(!pull.merged, `#${layer.number} is merged although the credential was rejected`)
      ctx.log(`the rejected credential surfaced as ${outcome.detail} and wrote nothing`)
    },
  },
  {
    id: 'merge/async-merge-settles-with-a-terminal-answer',
    title: 'an accepted asynchronous merge is read through to the answer the host gives',
    requires: ['asyncMerge'],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'async-settles')
      const started = Date.now()
      const outcome = await requestMerge(ctx, {
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
      })
      assert(
        outcome.settled !== null,
        `the merge was refused rather than started: ${outcome.detail}`,
      )
      const settled = outcome.settled
      const elapsed = Date.now() - started
      assert(
        settled.status === 'merged' || settled.status === 'failed',
        `after ${Math.round(elapsed / 1000)}s of real polling the merge is still ${settled.status}: ${settled.message ?? 'no message'}`,
      )
      // A host that answered `pending` is doing work afterwards. Reading it back in
      // the same breath is what turns a running merge into a reported pending one,
      // so the wait has to have been a wait.
      if (outcome.accepted?.result.status === 'pending') {
        assert(
          elapsed >= 1_000,
          `the host answered ${settled.status} within ${elapsed}ms of accepting a pending merge`,
        )
      }
      if (settled.status !== 'merged') {
        ctx.log(`the host refused to land this merge: ${settled.message ?? settled.status}`)
        return
      }
      const pull = await mergedOnHost(ctx, layer.number)
      assert(
        pull.merged,
        `#${layer.number} is not merged on the host after the merge settled as merged`,
      )
      ctx.log(`the merge landed ${String(pull.sha ?? '')} after ${Math.round(elapsed / 1000)}s`)
    },
  },
  {
    id: 'merge/mergeable-pull-request-refused-by-the-host-is-not-a-pending-merge',
    title: 'a pull request the host will not land ends in a definite answer, not a pending one',
    requires: ['asyncMerge'],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const layer = await mergeableLayer(ctx, 'merge-refused')
      // Somebody moves the trunk on under the layer. The pull request stays open and
      // its work now conflicts, which is the state the host refuses to land. The clone
      // is brought to what the host holds before that happens: an earlier merge in this
      // run lands the trunk on the host's side while the clone keeps the old tip, and a
      // commit made from there is rejected for a reason that has nothing to do with the
      // refusal under test.
      await ctx.workspace.gitNetwork(['fetch', 'origin', trunk])
      await ctx.workspace.gitNetwork(['checkout', trunk])
      ctx.workspace.git(['reset', '--hard', `origin/${trunk}`])
      // The move touches the file the layer added, with different contents, because that
      // is what makes the two histories conflict. A trunk commit in another file merges
      // cleanly, and a host that lands a clean merge is not refusing anything.
      await ctx.workspace.commit(
        'merge-refused.txt',
        'the trunk moved on\n',
        'merge-refused: the trunk moved on',
      )
      await ctx.workspace.gitNetwork(['push', 'origin', trunk])

      const outcome = await requestMerge(ctx, {
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
      })
      const refused =
        outcome.error instanceof GitHubTransportError &&
        (outcome.error.status === 409 || outcome.error.status === 422)
      assert(refused, `the host neither landed nor refused this merge: ${outcome.detail}`)
      assert(
        outcome.settled === null || outcome.settled.status === 'failed',
        `the merge is ${outcome.settled?.status ?? 'unknown'} rather than a definite answer`,
      )
      const pull = await mergedOnHost(ctx, layer.number)
      assert(
        !pull.merged,
        `#${layer.number} is merged on the host although the request was refused`,
      )
      ctx.log(
        `the host answered ${String((outcome.error as GitHubTransportError).status)} and left #${layer.number} unmerged`,
      )
    },
  },
  {
    id: 'merge/lost-response-adopts-the-request-the-host-already-holds',
    title: 'a merge whose answer was lost adopts the request the host already made',
    requires: ['asyncMerge'],
    async run(ctx) {
      // Its own branch name: one run shares one clone, and a second scenario pushing a
      // branch the first already published is rejected for a reason that has nothing to
      // do with the behaviour under test.
      const layer = await mergeableLayer(ctx, 'merge-lost-held')
      const request = {
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
      } as const
      // The request really is sent and the host really does make it; only the answer
      // is discarded, which is the state a person is in when a merge may or may not
      // have been started.
      ctx.faults.loseOnce({
        method: 'PUT',
        pathIncludes: `repos/${ctx.repository}/pulls/${layer.number}/merge-async`,
      })
      const lost = await requestMerge(ctx, request)
      assert(
        lost.accepted === null,
        `the lost answer was reported as ${lost.detail} rather than an unknown outcome`,
      )
      ctx.log(`the first request's answer was lost: ${lost.detail}`)

      const second = await requestMerge(ctx, request)
      assert(
        second.accepted !== null,
        `the host took a second merge request for #${layer.number} rather than reporting the one it already held: ${second.detail}`,
      )
      // GitHub documents two answers to the retry, and both are a success. A host still
      // holding the request answers `409` with that request's own identity, and adopting
      // it is the only safe move. A host that finished before the retry arrived answers
      // with the completed `200` and no identity at all, which production already reads.
      // Insisting on the conflict fails a legitimate recovery and hides a completed merge
      // behind a refusal the caller has to be able to act on.
      const recovered = second.accepted.result
      if (second.accepted.kind === 'conflict') {
        assert(
          recovered.expectedHeadSha === null || recovered.expectedHeadSha === layer.headSha,
          `the adopted request is for ${String(recovered.expectedHeadSha)}, not the head this run reviewed`,
        )
        assert(
          recovered.uuid !== null,
          'the conflict that carries the request to adopt named no request to read',
        )
        ctx.log(`adopted the request the host already held, ${recovered.uuid.slice(0, 8)}`)
      } else {
        assert(
          recovered.status === 'merged',
          `the retry answered ${recovered.status} for a request the host had already completed: ${recovered.message ?? ''}`,
        )
        assert(
          recovered.expectedHeadSha === null || recovered.expectedHeadSha === layer.headSha,
          `the completed result is for ${String(recovered.expectedHeadSha)}, not the head this run reviewed`,
        )
        ctx.log(`the host had already completed the request: ${recovered.status}`)
      }
      // The poll's own request id is deliberately not asserted against the recovered one.
      // A host that has finished the merge answers with the outcome and no id, which is
      // the contract production code already reads; asking for the echo would assert a
      // field the host does not promise. That the merge settled, and that the host
      // really made it, are the assertions either side of this one.
      assert(
        second.settled !== null && second.settled.status === 'merged',
        `the recovered request settled as ${second.settled?.status ?? 'nothing'}: ${second.settled?.message ?? ''}`,
      )
      const pull = await mergedOnHost(ctx, layer.number)
      const recoveredOid = second.settled?.mergeOid ?? null
      assert(
        pull.merged && recoveredOid !== null && pull.sha === recoveredOid,
        `#${layer.number} is merged at ${String(pull.sha)} on the host while the recovery reported ${String(recoveredOid)}`,
      )
    },
  },
  {
    id: 'schema/committed-matches',
    title: 'the committed contract matches what the host answered',
    requires: [],
    async run(ctx) {
      const target = await ctx.target
      const subject = await prepareSchemaSubject({
        target,
        workspace: ctx.workspace,
        defaultBranch: ctx.target.defaultBranch,
      })
      const observed = await observeSchema(ctx.transport, subject, `${target.kind} live host`)
      const drift = compareSchemas(readCommittedSchema(), observed)
      const breaking = breakingDrift(drift)
      assert(
        breaking.length === 0,
        `the committed contract no longer matches what the host answers:\n${renderDrift(breaking, new LiveRedactor([]))}`,
      )
      ctx.log(
        drift.length === 0
          ? 'the host answers exactly the committed shape'
          : `${drift.length} additions no parser reads`,
      )
    },
  },
  {
    id: 'schema/a-parser-depended-field-going-missing-is-reported',
    title:
      'a field a parser reads stopping answering is drift, and the rest of the probe still reads',
    requires: [],
    async run(ctx) {
      const committed = readCommittedSchema()
      const probe = SCHEMA_PROBES.find((entry) => entry.dependsOn.length > 0)
      assert(probe !== undefined, 'no probe declares a field a parser depends on')
      const answered = committed
      const altered = withAlteredField(answered, probe.id, () => null)
      const breaking = breakingDrift(compareSchemas(committed, altered))
      const missing = breaking.filter((entry) => entry.kind === 'missing')
      assert(
        missing.length > 0,
        `a missing field the ${probe.id} parser reads was not reported as drift:\n${renderDrift(breaking, new LiveRedactor([]))}`,
      )
      assert(
        missing.every((entry) => entry.path.length > 0 && entry.detail.length > 0),
        'the drift report does not say which field went missing',
      )
      const remaining = (altered.probes[probe.id] ?? []).length
      const answeredWith = (answered.probes[probe.id] ?? []).length
      assert(
        remaining === answeredWith - 1,
        `the ${probe.id} probe answered with ${remaining} fields after one disappeared`,
      )
      ctx.log(`a missing ${String(missing[0]?.path)} on ${probe.id} is reported as breaking drift`)
    },
  },
  {
    id: 'schema/a-parser-depended-field-changing-type-is-reported',
    title: 'a field a parser reads answering with another type is drift',
    requires: [],
    async run(ctx) {
      const committed = readCommittedSchema()
      const probe = SCHEMA_PROBES.find((entry) => entry.dependsOn.length > 0)
      assert(probe !== undefined, 'no probe declares a field a parser depends on')
      const altered = withAlteredField(committed, probe.id, (field) => ({
        ...field,
        type: otherType(field.type),
      }))
      const breaking = breakingDrift(compareSchemas(committed, altered))
      const changed = breaking.filter((entry) => entry.kind === 'type-changed')
      assert(
        changed.length > 0,
        `a changed type on a field the ${probe.id} parser reads was not reported:\n${renderDrift(breaking, new LiveRedactor([]))}`,
      )
      assert(
        changed.every((entry) => entry.path.length > 0),
        'the drift report does not say which field changed type',
      )
      ctx.log(`${String(changed[0]?.path)} on ${probe.id} changed type and was reported`)
    },
  },
  {
    id: 'fields/hosted-file-status-comes-from-the-host',
    title: 'the review file list names the added, removed, and renamed files the host reports',
    requires: [],
    async run(ctx) {
      const prefix = 'hosted-files'
      // Everything this case asserts about a file is a fact about the branch on the
      // host, so all of it has to be committed and pushed. A worktree that was never
      // pushed describes nothing the reviewer's window can read, and reading the local
      // status instead would prove the local status surface works.
      const layer = await pushLayer(ctx, {
        branch: `${prefix}-layer`,
        parent: `origin/${ctx.target.defaultBranch}`,
        base: ctx.target.defaultBranch,
        file: `${prefix}.txt`,
        contents: `${prefix}\n`,
        message: `${prefix}: a layer whose hosted files are read`,
      })
      ctx.workspace.git(['checkout', layer.branch])
      await ctx.workspace.commit(`${prefix}-doomed.txt`, 'doomed\n', `${prefix}: a file to remove`)
      ctx.workspace.git(['mv', '--', `${prefix}.txt`, `${prefix}-renamed.txt`])
      ctx.workspace.git(['rm', '-q', '--', `${prefix}-doomed.txt`])
      await ctx.workspace.commit(`${prefix}-added.txt`, 'added\n', `${prefix}: the final change`)
      await ctx.workspace.push(layer.branch)

      const files = await readReviewFilesFrom(await originRemote(ctx.workspace.path), layer.number)
      const byPath: Record<string, ReviewFile> = {}
      for (const file of files.files) byPath[file.path] = file
      const named = Object.keys(byPath).join(', ')
      const added = byPath[`${prefix}-added.txt`]
      assert(added !== undefined, `the host reported no added file: ${named}`)
      assert(
        added.status === 'added',
        `the file the pull request adds is reported as ${added.status} rather than added`,
      )
      const removed = byPath[`${prefix}-doomed.txt`]
      assert(removed !== undefined, `the host reported no removed file: ${named}`)
      assert(
        removed.status === 'removed',
        `the file the pull request deletes is reported as ${removed.status} rather than removed`,
      )
      const renamed = byPath[`${prefix}-renamed.txt`]
      assert(renamed !== undefined, `the host reported no renamed file: ${named}`)
      assert(
        renamed.previousPath === `${prefix}.txt`,
        `the rename reports its original as ${String(renamed.previousPath)}`,
      )
      ctx.log(
        `the host named ${files.files.length} changed files, including the rename from ${String(renamed.previousPath)}`,
      )
    },
  },
  {
    id: 'sync/a-secondary-limit-parks-the-inbox-and-not-the-local-state',
    title: 'a secondary rate limit parks background polling while local work keeps refreshing',
    requires: [],
    async run(ctx) {
      const { coordinator, events } = openCoordinator(ctx)
      // The file local work leaves behind, removed on every exit. The scenarios after
      // this one share the clone, and an untracked file is a change the next restack has
      // to be told about: a failure of the next scenario rather than a fact about this one.
      const localProbe = join(ctx.workspace.path, 'secondary-limit-local.txt')
      const requests = (): number => ctx.faults.recentExchanges(10_000).length
      /** A real wait, so "nothing was requested" is an observation rather than a race. */
      const settle = async (ms: number): Promise<void> => {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, ms)
        await promise
      }
      try {
        coordinator.attach(ctx.workspace.path, await getSnapshot(ctx.workspace.path))
        await coordinator.refreshNow()
        assert(
          coordinator.freshness().state === 'fresh',
          `the healthy refresh reported ${coordinator.freshness().state}: ${String(coordinator.freshness().detail)}`,
        )
        ctx.faults.clearFaults()

        // The background tier is the one a limit is allowed to park, so the coordinator
        // has to be in it, and its poll has to actually come due. Both are proved with the
        // same configuration used later to show the parking, because "no requests" only
        // means something next to a run in which the same timer does make them.
        coordinator.reportActivity({ focused: false, visible: false })
        coordinator.applyIntervals({ visibleMs: 100, secondaryMs: 100, localSettleMs: 50 })
        const healthyBefore = requests()
        await settle(1_500)
        assert(
          requests() > healthyBefore,
          'a due background poll made no request at all, so a parked poll would prove nothing',
        )
        const healthy = requests() - healthyBefore

        // Nothing but a filesystem event may publish a snapshot from here, so the event
        // that answers the local write is one published after the file was written. The
        // failed visible refresh below appends its own snapshot before it records the
        // failure, and accepting that one would be accepting a snapshot from before the
        // file existed.
        coordinator.applyIntervals({ visibleMs: 0 })
        events.length = 0
        await writeFile(localProbe, 'local work\n', 'utf8')
        coordinator.notifyLocalChange()
        const local = await nextEvent(
          events,
          (event) => event.kind === 'snapshot' && event.snapshot !== undefined,
          10_000,
        )
        assert(local !== null, 'local work stopped refreshing')
        assert(
          local.snapshot?.files.some((file) => file.path === 'secondary-limit-local.txt') === true,
          `the snapshot published after the local write does not carry it: ${(local.snapshot?.files ?? []).map((file) => file.path).join(', ')}`,
        )

        // The host's own answer to a request the run makes, sent through the
        // transport the application is using, not an error written into the case.
        ctx.faults.refuseOnce(
          // The application's pull request and inbox reads are GraphQL operations, not
          // REST routes, so a fault aimed at a REST path is answered by nothing at all
          // and the scenario would be reporting a healthy refresh.
          { method: 'POST', pathIncludes: 'graphql:' },
          {
            status: 403,
            kind: 'rate-limited',
            message: 'You have exceeded a secondary rate limit and have been temporarily blocked',
          },
        )
        await coordinator.refreshNow().then(
          () => null,
          (error: unknown) => error,
        )
        const limited = coordinator.freshness()
        assert(
          limited.state === 'rate-limited',
          `a secondary limit left the repository ${limited.state}: ${String(limited.detail)}`,
        )
        assert(
          limited.detail !== null && /secondary rate limit/iu.test(limited.detail),
          `the reported reason does not name the limit the host gave: ${String(limited.detail)}`,
        )
        const emptied = events.filter(
          (event) => event.kind === 'issues' && (event.issues?.length ?? 0) === 0,
        )
        assert(emptied.length === 0, 'a rate-limited read published an empty inbox')

        // The same due background poll, under the limit. The coordinator is left parked
        // for the production backoff, so waiting long enough for several of these
        // intervals to come and go is waiting long enough to see that none of them
        // reached GitHub.
        coordinator.applyIntervals({ visibleMs: 100, secondaryMs: 100, localSettleMs: 50 })
        const limitedBefore = requests()
        await settle(1_500)
        const parked = requests() - limitedBefore
        assert(
          parked === 0,
          `${parked} requests reached GitHub while the secondary limit was in force, against ${healthy} in the same window without it`,
        )

        ctx.faults.clearFaults()
        await coordinator.refreshNow()
        assert(
          coordinator.freshness().state === 'fresh',
          `the refresh after the limit lifted still reported ${coordinator.freshness().state}`,
        )
        ctx.log(
          `parked ${healthy} background polls a window at the limit, kept local refresh running, and recovered`,
        )
      } finally {
        coordinator.detach()
        await rm(localProbe, { force: true })
      }
    },
  },
]
