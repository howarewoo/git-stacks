import { getSnapshot, runAction } from '../../../src/main/git'
import {
  clearPullRequestChecksCache,
  getPullRequestChecks,
  rerunPullRequestCheck,
} from '../../../src/main/pull-request-checks'
import { previewStack } from '../../../src/main/stacks'
import {
  pollAsyncMerge,
  queueConfiguredFor,
  readMergeObservations,
  startAsyncMerge,
} from '../../../src/main/merge-async'
import { mergeableLayer, mergeThroughProduction, requestMerge } from './merge-support'
import { assert, type LiveScenario, type LiveScenarioContext } from '../scenario'

export const checkScenarios: readonly LiveScenario[] = [
  {
    id: 'checks/rollup-reflects-the-host',
    title: 'check runs, statuses, and workflow runs are rolled up the way the host reports them',
    requires: ['checks'],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const layer = await mergeableLayer(ctx, 'checks-rollup')
      await ctx.admin.createCheckRun({
        fullName: ctx.repository,
        headSha: layer.headSha,
        name: 'git-stacks-live-e2e/pass',
        status: 'completed',
        conclusion: 'success',
      })
      await ctx.admin.createCheckRun({
        fullName: ctx.repository,
        headSha: layer.headSha,
        name: 'git-stacks-live-e2e/fail',
        status: 'completed',
        conclusion: 'failure',
      })
      await ctx.admin.createCheckRun({
        fullName: ctx.repository,
        headSha: layer.headSha,
        name: 'git-stacks-live-e2e/pending',
        status: 'in_progress',
      })
      clearPullRequestChecksCache()

      const report = await getPullRequestChecks(ctx.workspace.path, layer.number, {
        headSha: layer.headSha,
        base: trunk,
        force: true,
      })
      assert(report.available, `the checks read was unavailable: ${report.message}`)
      const names = report.checks.map((check) => check.name)
      for (const expected of [
        'git-stacks-live-e2e/pass',
        'git-stacks-live-e2e/fail',
        'git-stacks-live-e2e/pending',
      ]) {
        assert(names.includes(expected), `the report has no check named ${expected}`)
      }
      const failing = report.checks.find((check) => check.name === 'git-stacks-live-e2e/fail')
      assert(
        failing?.state === 'failure',
        `the failing check is ${String(failing?.state)} rather than failure`,
      )
      const pending = report.checks.find((check) => check.name === 'git-stacks-live-e2e/pending')
      assert(pending?.state === 'in-progress', `the in-progress check is ${String(pending?.state)}`)
      assert(
        report.rollup.failing === 1,
        `the rollup counted ${report.rollup.failing} failing checks rather than 1`,
      )
      assert(
        report.rollup.passing === 1,
        `the rollup counted ${report.rollup.passing} passing checks rather than 1`,
      )
      assert(
        report.summary === 'failing',
        `a pull request with a failing check summarised as ${report.summary}`,
      )
      ctx.log(
        `rolled up ${report.checks.length} checks as ${report.summary} ` +
          `(${report.rollup.failing} failing, ${report.rollup.pending} pending)`,
      )
    },
  },
  {
    id: 'checks/rerun-refuses-a-run-it-cannot-prove',
    title: 'a rerun is refused unless the run belongs to this pull request head',
    requires: ['checks'],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const layer = await mergeableLayer(ctx, 'checks-rerun')
      await ctx.admin.createCheckRun({
        fullName: ctx.repository,
        headSha: layer.headSha,
        name: 'git-stacks-live-e2e/rerun',
        status: 'completed',
        conclusion: 'failure',
      })
      clearPullRequestChecksCache()
      const before = ctx.faults.recentExchanges(2_000).length
      const error = await rerunPullRequestCheck(ctx.workspace.path, layer.number, 999_999, {
        headSha: layer.headSha,
        base: trunk,
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      assert(error !== null, 'a workflow run that does not exist was rerun')
      const exchanges = ctx.faults.recentExchanges(2_000).slice(before)
      assert(
        exchanges.some(
          (entry) =>
            entry.method === 'GET' &&
            entry.path === `repos/${ctx.repository}/pulls/${layer.number}` &&
            entry.status === 200,
        ),
        'the rerun did not read the pull request identity from the host',
      )
      assert(
        exchanges.some(
          (entry) =>
            entry.method === 'GET' &&
            entry.path.startsWith(
              `repos/${ctx.repository}/actions/runs?head_sha=${layer.headSha}`,
            ) &&
            entry.status === 200,
        ),
        'the rerun did not re-read workflow runs for the pull request head',
      )
      assert(
        !exchanges.some(
          (entry) =>
            entry.method === 'POST' && entry.path.startsWith(`repos/${ctx.repository}/actions/`),
        ),
        'the refused rerun issued a workflow mutation',
      )
    },
  },
  {
    id: 'checks/spent-rate-limit-backs-off-instead-of-retrying',
    title: 'a rate-limited checks read backs off and says so rather than spinning',
    requires: ['checks'],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const layer = await mergeableLayer(ctx, 'checks-backoff')
      clearPullRequestChecksCache()
      ctx.faults.refuseOnce(
        { method: 'GET', pathIncludes: `repos/${ctx.repository}/commits` },
        { status: 403, kind: 'rate-limited', message: 'API rate limit exceeded' },
      )
      const first = await getPullRequestChecks(ctx.workspace.path, layer.number, {
        headSha: layer.headSha,
        base: trunk,
        force: true,
      })
      assert(!first.available, 'a rate-limited read reported a usable report')
      assert(
        /rate limit/iu.test(first.message),
        `the refusal did not name the rate limit: ${first.message}`,
      )
      const before = ctx.faults.recentExchanges(1_000).length
      const second = await getPullRequestChecks(ctx.workspace.path, layer.number, {
        headSha: layer.headSha,
        base: trunk,
      })
      const after = ctx.faults.recentExchanges(1_000).length
      assert(!second.available, 'the backoff served a report it does not have')
      assert(
        after === before,
        `the backoff still made ${after - before} requests; it is meant to wait for the reset`,
      )
      ctx.log(
        `waited for ${second.nextAttemptAt ? new Date(second.nextAttemptAt).toISOString() : 'an unknown deadline'}`,
      )
    },
  },
]

export const mergeScenarios: readonly LiveScenario[] = [
  {
    id: 'merge/direct-async-merge-lands',
    title: 'a direct asynchronous merge is requested and its result is read back',
    requires: ['asyncMerge', 'canMerge'],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'merge-direct')
      const attempt = await requestMerge(ctx, {
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
      })
      assert(attempt.accepted !== null, `the merge request was refused: ${attempt.detail}`)
      assert(attempt.settled !== null, `the accepted request carried no result: ${attempt.detail}`)
      assert(
        attempt.settled.status !== 'pending',
        `the merge was still running when the bound was reached: ${attempt.settled.message ?? 'no message'}`,
      )
      assert(
        attempt.settled.status === 'merged',
        `the merge reported ${attempt.settled.status}: ${attempt.settled.message ?? ''}`,
      )
      const after = await ctx.admin.readPullRequest(ctx.repository, layer.number)
      assert(
        after.merged === true || after.state === 'closed',
        `the host does not show #${layer.number} as landed: state ${String(after.state)}`,
      )
      ctx.log(`#${layer.number} merged as ${String(attempt.settled.mergeOid)}`)
    },
  },
  {
    id: 'merge/lost-response-adopts-the-request-already-made',
    title: 'a merge whose answer was lost is not requested twice',
    requires: ['asyncMerge', 'canMerge'],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'merge-lost')
      ctx.faults.loseOnce({ method: 'PUT', pathIncludes: 'merge-async' })
      const first = await startAsyncMerge({
        fullName: ctx.repository,
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
        host: ctx.host,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      assert(first !== null, 'the lost merge reported success rather than an unknown outcome')

      // The retry is the interesting part, and GitHub documents two answers to it.
      // A host that is still holding the request answers `409` with that request's
      // own identity, and adopting it is the only safe move. A host that finished
      // before the retry arrived answers `200` with the completed result and no
      // identity at all, which is a success and not a conflict to be recovered from.
      // Either is correct; answering only one of them would be a bug.
      const second = await startAsyncMerge({
        fullName: ctx.repository,
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
        host: ctx.host,
      })
      if (second.kind === 'conflict') {
        const adopted = second.result
        assert(
          adopted.expectedHeadSha === null || adopted.expectedHeadSha === layer.headSha,
          `the host holds a request for head ${String(adopted.expectedHeadSha)} rather than the reviewed ${layer.headSha}`,
        )
        assert(
          adopted.mergeAction === null || adopted.mergeAction === 'direct_merge',
          `the host holds a ${String(adopted.mergeAction)} request rather than a direct merge`,
        )
        assert(
          adopted.mergeMethod === null || adopted.mergeMethod === 'squash',
          `the host holds a ${String(adopted.mergeMethod)} request rather than the reviewed squash`,
        )
        const uuid = adopted.uuid
        assert(uuid !== null, 'the adopted conflict carried no UUID to read')
        const settled = await pollAsyncMerge(
          { fullName: ctx.repository, number: layer.number, uuid, host: ctx.host },
          { maxAttempts: 30, intervalMs: 1_000 },
        )
        assert(
          settled.status !== 'pending',
          `the adopted request never reported a terminal result: ${settled.message ?? 'still running'}`,
        )
        ctx.log(`adopted the existing request ${uuid.slice(0, 8)} (${settled.status})`)
      } else {
        assert(
          second.result.status === 'merged',
          `the retry answered ${second.result.status} for a request the host had already completed: ${second.result.message ?? ''}`,
        )
        ctx.log(`the host had already completed the request: ${second.result.status}`)
      }

      const landed = await ctx.admin.readPullRequest(ctx.repository, layer.number)
      assert(
        landed.merged === true,
        `the host does not report #${layer.number} as merged after the recovered merge`,
      )
    },
  },
  {
    id: 'merge/queue-enqueue-is-proven-by-the-accept',
    title: 'a merge queue is proven by the accept, not by configuration',
    requires: ['mergeQueue', 'canMerge'],
    async run(ctx) {
      const trunk = ctx.target.defaultBranch
      const created = await ctx.admin.createRuleSet({
        name: 'git-stacks-live-e2e merge queue',
        enforcement: 'active',
        baseRefs: [`refs/heads/${trunk}`],
        mergeQueue: true,
      })
      ctx.target.resources.record({
        kind: 'rule-set',
        handle: `${ctx.repository}/rulesets/${created.id}`,
        marker: ctx.marker,
        createdAt: new Date().toISOString(),
      })
      try {
        const layer = await mergeableLayer(ctx, 'merge-queue')
        const observationsBefore = await readMergeObservations(ctx.workspace.path)
        assert(
          !queueConfiguredFor(observationsBefore, trunk),
          `a queue was already recorded for ${trunk} before this scenario asked for one`,
        )

        // The queue is configured on the host and the merge goes through the
        // production path, which is the only thing that writes the journal entry
        // `queueConfiguredFor` reads. Nothing here records an enqueue by hand: if
        // the host answers anything but a terminal enqueue, this fails.
        await mergeThroughProduction(ctx, layer.branch, 'default')

        const observations = await readMergeObservations(ctx.workspace.path)
        const recorded = observations.get(layer.number)
        assert(
          recorded !== undefined && recorded.outcome === 'enqueued',
          `the production merge recorded ${String(recorded?.outcome)} for #${layer.number} rather than an accepted enqueue`,
        )
        assert(
          queueConfiguredFor(observations, trunk),
          `an accepted enqueue did not register a queue for ${trunk}`,
        )
        assert(
          !queueConfiguredFor(observations, 'release/9.9'),
          'a queue was reported for a base ref nothing was ever enqueued on',
        )
        const configured = await ctx.admin.mergeQueues(ctx.repository)
        assert(
          configured.includes(trunk),
          `the host reports merge queues on ${configured.join(', ') || 'nothing'}, not on ${trunk}`,
        )

        // With its own enqueue recorded, the next preview offers the queue as a
        // choice. That is the product discovering the queue through the journal
        // rather than through a flag this scenario set.
        const snapshot = await getSnapshot(ctx.workspace.path)
        const preview = await previewStack(ctx.workspace.path, snapshot, 'merge', layer.branch)
        assert(
          preview.merge !== null,
          `the second merge preview for ${layer.branch} carried no plan`,
        )
        assert(
          preview.merge.actions.includes('merge_queue'),
          `the preview offers ${preview.merge.actions.join(', ')} now that ${trunk} has answered with an enqueue`,
        )
        ctx.log(`enqueued #${layer.number} on ${trunk}; the journal and the host both know`)
      } finally {
        await ctx.admin.deleteRuleSet(ctx.repository, created.id)
        ctx.target.resources.release(`${ctx.repository}/rulesets/${created.id}`)
      }
    },
  },
]
