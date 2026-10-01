import {
  clearPullRequestChecksCache,
  getPullRequestChecks,
  rerunPullRequestCheck,
} from '../../../src/main/pull-request-checks'
import {
  pollAsyncMerge,
  queueConfiguredFor,
  readAsyncMerge,
  readMergeObservations,
  recordMergeObservation,
  startAsyncMerge,
} from '../../../src/main/merge-async'
import { pushLayer } from '../layers'
import { assert, type LiveScenario } from '../scenario'

/** One mergeable layer with its own head, which is what a check attaches to. */
const mergeableLayer = (ctx: Parameters<LiveScenario['run']>[0], prefix: string) =>
  pushLayer(ctx, {
    branch: `${prefix}-layer`,
    parent: 'origin/main',
    base: 'main',
    file: `${prefix}.txt`,
    contents: `${prefix}\n`,
    message: `${prefix}: a layer to check and merge`,
  })

const noSleep = async (): Promise<void> => {}

export const checkScenarios: readonly LiveScenario[] = [
  {
    id: 'checks/rollup-reflects-the-host',
    title: 'check runs, statuses, and workflow runs are rolled up the way the host reports them',
    requires: ['checks'],
    async run(ctx) {
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
        base: 'main',
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
      const layer = await mergeableLayer(ctx, 'checks-rerun')
      await ctx.admin.createCheckRun({
        fullName: ctx.repository,
        headSha: layer.headSha,
        name: 'git-stacks-live-e2e/rerun',
        status: 'completed',
        conclusion: 'failure',
      })
      clearPullRequestChecksCache()
      const error = await rerunPullRequestCheck(ctx.workspace.path, layer.number, 999_999, {
        headSha: layer.headSha,
        base: 'main',
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      assert(error !== null, 'a workflow run that does not exist was rerun')
      assert(
        error instanceof Error &&
          /no longer belongs|re-read|permission|permitted/iu.test(error.message),
        `the refusal did not name the reason: ${String(error)}`,
      )
    },
  },
  {
    id: 'checks/spent-rate-limit-backs-off-instead-of-retrying',
    title: 'a rate-limited checks read backs off and says so rather than spinning',
    requires: ['checks'],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'checks-backoff')
      clearPullRequestChecksCache()
      ctx.faults.refuseOnce(
        { method: 'GET', pathIncludes: `repos/${ctx.repository}/commits` },
        { status: 403, kind: 'rate-limited', message: 'API rate limit exceeded' },
      )
      const first = await getPullRequestChecks(ctx.workspace.path, layer.number, {
        headSha: layer.headSha,
        base: 'main',
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
        base: 'main',
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
      const started = await startAsyncMerge({
        fullName: ctx.repository,
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
        host: ctx.host,
      })
      assert(started.kind === 'result', 'the merge request was not accepted')
      const uuid = started.result.uuid
      assert(uuid !== null, 'an accepted merge request came back without the UUID to poll')

      const settled = await pollAsyncMerge(
        { fullName: ctx.repository, number: layer.number, uuid, host: ctx.host },
        { maxAttempts: 12, intervalMs: 50, sleep: noSleep },
      )
      assert(
        settled.status !== 'pending',
        `the merge never reported a terminal result: ${settled.message}`,
      )
      assert(
        settled.status === 'merged',
        `the merge reported ${settled.status}: ${settled.message ?? ''}`,
      )
      const after = await ctx.admin.readPullRequest(ctx.repository, layer.number)
      assert(
        after.merged === true || after.state === 'closed',
        `the host does not show #${layer.number} as landed: state ${String(after.state)}`,
      )
      ctx.log(`#${layer.number} merged as ${String(settled.mergeOid)}`)
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
        (start) => ({ start, failed: false }),
        (error: unknown) => ({ error, failed: true }),
      )
      assert(first.failed, 'the lost merge should surface as a failure the caller must handle')

      // The retry is the interesting part: the host already holds a request, so it
      // answers 409 with that request's own identity. Adopting it is the only safe
      // answer, and issuing a second request would race a merge nobody reviewed.
      const second = await startAsyncMerge({
        fullName: ctx.repository,
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
        host: ctx.host,
      })
      assert(
        second.kind === 'conflict',
        `the retry answered ${second.kind} instead of adopting the request the host already holds`,
      )
      const uuid = second.result.uuid
      assert(uuid !== null, 'the adopted conflict carried no UUID to read')
      const settled = await readAsyncMerge({
        fullName: ctx.repository,
        number: layer.number,
        uuid,
        host: ctx.host,
      })
      assert(
        settled.status !== 'pending',
        `the adopted request never reported a terminal result: ${settled.message}`,
      )
      ctx.log(`adopted the existing request ${String(uuid).slice(0, 8)} (${settled.status})`)
    },
  },
  {
    id: 'merge/queue-enqueue-is-proven-by-the-accept',
    title: 'a merge queue is proven by the accept, not by configuration',
    requires: ['mergeQueue', 'canMerge'],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'merge-queue')
      const started = await startAsyncMerge({
        fullName: ctx.repository,
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: null,
        mergeAction: 'merge_queue',
        host: ctx.host,
      })
      assert(started.kind === 'result', 'the queue refused the enqueue outright')
      assert(
        started.result.status === 'enqueued' || started.result.status === 'pending',
        `the enqueue reported ${started.result.status}: ${started.result.message ?? ''}`,
      )
      const uuid = started.result.uuid
      assert(uuid !== null, 'an accepted enqueue came back without a UUID')

      await recordMergeObservation(ctx.workspace.path, {
        pullRequest: layer.number,
        branch: layer.branch,
        base: 'main',
        headOid: layer.headSha,
        action: 'merge_queue',
        method: null,
        request: { pullRequest: layer.number, uuid },
        enqueuedAt: Date.now(),
        requestedAt: Date.now(),
        outcome: started.result.status === 'enqueued' ? 'enqueued' : 'pending',
        message: started.result.message,
        confirmed: null,
      })
      const observations = await readMergeObservations(ctx.workspace.path)
      assert(
        queueConfiguredFor(observations, 'main'),
        'an accepted enqueue did not register a queue for the base ref',
      )
      assert(
        !queueConfiguredFor(observations, 'release/9.9'),
        'a queue was reported for a base ref nothing was ever enqueued on',
      )
      ctx.log(`enqueued #${layer.number} on main`)
    },
  },
]
