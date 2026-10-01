import {
  GitHubTransportError,
  setGitHubTransport,
  type GitHubErrorKind,
} from '../../../src/main/github-transport'
import { originRemote, readReviewFilesFrom } from '../../../src/main/review'
import { submitReview } from '../../../src/main/review-threads'
import { pollAsyncMerge, startAsyncMerge } from '../../../src/main/merge-async'
import { classifyRemoteFailure } from '../../../src/main/sync-coordinator'
import { RemoteMutationLedger, unknownRemoteOutcome } from '../../../src/main/remote-mutations'
import { LiveRedactor } from '../diagnostics'
import {
  breakingDrift,
  compareSchemas,
  observeSchema,
  prepareSchemaSubject,
  renderDrift,
} from '../observed-schema'
import { readCommittedSchema } from '../schema-fixture'
import { pushLayer } from '../layers'
import { anchorsFrom, assert, type LiveScenario, type LiveScenarioContext } from '../scenario'

const noSleep = async (): Promise<void> => {}

/**
 * A merge, carried through to a terminal answer.
 *
 * Reading only the start is not a verdict: GitHub answers `202 pending` and finishes the
 * work afterwards, so a scenario that stopped there would call every gated merge a
 * failure and every ungated one a no-op. The request is polled to the end, and the
 * refusal is reported with the kind GitHub classified it as, because "blocked" and
 * "could not ask" are different bugs.
 */
async function attemptMerge(
  ctx: LiveScenarioContext,
  number: number,
  headSha: string,
): Promise<{ landed: boolean; kind: GitHubErrorKind | null; detail: string }> {
  const started = await startAsyncMerge({
    fullName: ctx.repository,
    number,
    sha: headSha,
    mergeMethod: 'merge',
    mergeAction: 'direct_merge',
    host: ctx.host,
  }).then(
    (start) => ({ start, error: null }),
    (error: unknown) => ({ start: null, error }),
  )
  if (started.error !== null) {
    const kind = started.error instanceof GitHubTransportError ? started.error.kind : null
    return { landed: false, kind, detail: String(started.error) }
  }
  const uuid = started.start?.result.uuid ?? null
  if (uuid === null) {
    const status = started.start?.result.status ?? 'unknown'
    return {
      landed: false,
      kind: null,
      detail: `the host accepted with no request to read: ${status}`,
    }
  }
  const settled = await pollAsyncMerge(
    { fullName: ctx.repository, number, uuid, host: ctx.host },
    { maxAttempts: 8, intervalMs: 25, sleep: noSleep },
  )
  return {
    landed: settled.status === 'merged',
    kind: null,
    detail: `${settled.status}: ${settled.message ?? 'no message'}`,
  }
}

const mergeableLayer = (ctx: LiveScenarioContext, prefix: string) =>
  pushLayer(ctx, {
    branch: `${prefix}-layer`,
    parent: 'origin/main',
    base: 'main',
    file: `${prefix}.txt`,
    contents: `${prefix}\n`,
    message: `${prefix}: a layer to gate`,
  })

/** Records the rule set so cleanup removes it even if the scenario throws. */
function trackRuleSet(ctx: LiveScenarioContext, id: number): { full: string; release: () => void } {
  const full = `${ctx.repository}/rulesets/${id}`
  ctx.target.resources.record({
    kind: 'rule-set',
    handle: full,
    marker: ctx.marker,
    createdAt: new Date().toISOString(),
  })
  return { full, release: () => ctx.target.resources.release(full) }
}

export const ruleScenarios: readonly LiveScenario[] = [
  {
    id: 'rules/required-check-blocks-the-merge',
    title: 'a required check gates the merge, and passing it opens the gate',
    requires: ['ruleSets', 'checks', 'asyncMerge', 'canMerge'],
    async run(ctx) {
      const required = 'git-stacks-live-e2e/required'
      const created = await ctx.admin.createRuleSet({
        name: 'git-stacks-live-e2e required check',
        enforcement: 'active',
        requiredStatusCheck: required,
      })
      const tracked = trackRuleSet(ctx, created.id)
      try {
        const layer = await mergeableLayer(ctx, 'rules-check')
        const blocked = await attemptMerge(ctx, layer.number, layer.headSha)
        assert(!blocked.landed, `the merge landed with ${required} unsatisfied: ${blocked.detail}`)
        ctx.log(`refused as expected: ${blocked.detail}`)

        await ctx.admin.createCheckRun({
          fullName: ctx.repository,
          headSha: layer.headSha,
          name: required,
          status: 'completed',
          conclusion: 'success',
        })
        const allowed = await attemptMerge(ctx, layer.number, layer.headSha)
        assert(
          allowed.landed,
          `the merge was still refused after ${required} passed: ${allowed.detail}`,
        )
        ctx.log('landed once the required check was satisfied')
      } finally {
        await ctx.admin.deleteRuleSet(ctx.repository, created.id)
        tracked.release()
      }
    },
  },
  {
    id: 'rules/required-approval-blocks-the-author',
    title: 'a required approval is refused for the author and allowed after a reviewer approves',
    requires: ['ruleSets', 'reviewThreads', 'secondReviewer', 'asyncMerge', 'canMerge'],
    async run(ctx) {
      const created = await ctx.admin.createRuleSet({
        name: 'git-stacks-live-e2e required approval',
        enforcement: 'active',
        requiredApprovals: 1,
      })
      const tracked = trackRuleSet(ctx, created.id)
      try {
        const layer = await mergeableLayer(ctx, 'rules-approval')
        const blocked = await attemptMerge(ctx, layer.number, layer.headSha)
        assert(
          !blocked.landed,
          `the author's own merge landed with one approval required: ${blocked.detail}`,
        )
        ctx.log(`refused without an approval: ${blocked.detail}`)

        const reviewer = ctx.target.reviewer
        assert(reviewer !== null, 'no second account was supplied for this run')
        // The application holds one signed-in account at a time, so the run signs
        // the reviewer in for the duration of their write and restores the author
        // afterwards. The approval is then the reviewer's, not the author's.
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

        const allowed = await attemptMerge(ctx, layer.number, layer.headSha)
        assert(allowed.landed, `the merge was refused after an approval: ${allowed.detail}`)
        ctx.log(`approved by ${reviewer.login} and landed`)
      } finally {
        await ctx.admin.deleteRuleSet(ctx.repository, created.id)
        tracked.release()
      }
    },
  },
]

export const faultScenarios: readonly LiveScenario[] = [
  {
    id: 'fault/dropped-connection-holds-the-merge-for-the-person',
    title: 'a merge whose answer was lost is held for the person and never resent',
    requires: ['asyncMerge', 'canMerge'],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'fault-lost')
      const mergeAction = {
        type: 'merge' as const,
        ref: `refs/heads/${layer.branch}`,
        expectedHead: layer.headSha,
        expectedHeadRef: `refs/heads/${layer.branch}`,
      }

      // The request really reaches the host and the host really applies it; only the
      // answer is discarded. That is the state a person is in when a merge may or may
      // not have been asked for, and it is the only way to reach it without a host that
      // lies about having merged something.
      ctx.faults.loseOnce({ method: 'PUT', pathIncludes: 'merge-async' })
      const lost = await startAsyncMerge({
        fullName: ctx.repository,
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
        host: ctx.host,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      assert(lost !== null, 'the lost merge reported success rather than an unknown outcome')

      const ledger = new RemoteMutationLedger()
      const entry = ledger.recordFailure(mergeAction, lost)
      assert(entry !== null, 'a dropped connection left nothing for the person to resolve')
      assert(
        entry.kind === 'merge' && entry.label.includes(layer.branch),
        `the ledger recorded ${JSON.stringify(entry)} instead of this layer's merge`,
      )
      assert(ledger.pending().length === 1, 'the pending mutation was not held')
      assert(ledger.dismiss(entry.id), 'the person could not dismiss the entry themselves')
      assert(ledger.pending().length === 0, 'dismissing left the entry behind')

      // A refusal GitHub itself reported never reached the mutation, so it must not
      // become something a person has to clear before working again.
      const refused = new GitHubTransportError({
        kind: 'unprocessable',
        status: 422,
        detail: 'Validation Failed',
      })
      assert(unknownRemoteOutcome(refused) === null, 'a 422 was treated as possibly applied')
      assert(
        ledger.recordFailure(mergeAction, refused) === null,
        'a 422 was recorded as an unknown outcome',
      )
      ctx.log('only the unanswerable failure was held, and it named the layer it belongs to')
    },
  },
  {
    id: 'fault/rate-limited-write-never-reaches-the-host',
    title: 'a write refused by a spent rate limit is not sent and not retried into a duplicate',
    requires: ['asyncMerge', 'canMerge'],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'fault-rate')
      // Only the merge request itself is counted. Polling a merge answers over the same
      // path, so a count that included those reads would compare two different things.
      const mergeRequests = (): Array<{ method: string; path: string; status: number | string }> =>
        ctx.faults
          .recentExchanges(1_000)
          .filter((entry) => entry.method === 'PUT' && entry.path.includes('merge-async'))
      const before = mergeRequests().length

      ctx.faults.refuseOnce(
        { method: 'PUT', pathIncludes: 'merge-async' },
        { status: 403, kind: 'rate-limited', message: 'API rate limit exceeded' },
      )
      const refused = await attemptMerge(ctx, layer.number, layer.headSha)
      assert(!refused.landed, 'a rate-limited write reported a landed merge')
      assert(
        refused.kind === 'rate-limited',
        `the refusal classified as ${String(refused.kind)} rather than rate-limited`,
      )
      ctx.faults.clearFaults()

      // The host refused before the request was sent, so it holds nothing: the retry
      // after the reset is the first request GitHub ever sees for this pull request.
      const attempted = mergeRequests().slice(before)
      assert(
        attempted.length === 1 && attempted[0].status === 403,
        `${attempted.length} merge requests were recorded before the retry, and the one that was ` +
          `answered ${String(attempted[0]?.status)}: a spent limit has to be refused before it is sent`,
      )
      const landed = await attemptMerge(ctx, layer.number, layer.headSha)
      assert(landed.landed, `the merge after the reset did not land: ${landed.detail}`)
      assert(
        mergeRequests().length === before + 2,
        `the run recorded ${mergeRequests().length - before} merge requests, not the one refused and ` +
          'the one sent after the reset',
      )
      ctx.log(`one merge request reached the host, and it landed: ${landed.detail}`)
    },
  },
  {
    id: 'fault/rejected-credential-is-reported-as-unauthorized',
    title: 'a rejected credential surfaces as unauthorized and writes nothing',
    requires: [],
    async run(ctx) {
      const layer = await mergeableLayer(ctx, 'fault-token')
      ctx.faults.refuseOnce(
        { method: 'PUT', pathIncludes: 'merge-async' },
        { status: 401, kind: 'unauthorized', message: 'Bad credentials' },
      )
      const attempt = await startAsyncMerge({
        fullName: ctx.repository,
        number: layer.number,
        sha: layer.headSha,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
        host: ctx.host,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      ctx.faults.clearFaults()
      assert(attempt !== null, 'a rejected credential still produced a merge answer')
      assert(
        attempt instanceof GitHubTransportError && attempt.kind === 'unauthorized',
        `a rejected credential surfaced as ${String(attempt)}`,
      )
      assert(
        unknownRemoteOutcome(attempt) === null,
        'a rejected credential was treated as possibly applied, so it would be retried',
      )
      const pull = await ctx.admin.readPullRequest(ctx.repository, layer.number)
      assert(
        pull.merged !== true,
        'the merge landed even though the credential was rejected before it was sent',
      )
      ctx.log('the refusal was classified, nothing was written, and nothing was retried')
    },
  },
  {
    id: 'fault/secondary-rate-limit-parks-secondary-polling',
    title: 'a secondary limit parks the inbox refresh without stopping the visible one',
    requires: [],
    async run(ctx) {
      const secondary = classifyRemoteFailure('You have exceeded a secondary rate limit', {
        kind: 'secondary-rate-limit',
        remaining: 4_000,
        reset: null,
      })
      assert(
        secondary.state === 'rate-limited' && secondary.secondaryOnly,
        `a secondary limit was classified as ${secondary.state}/${String(secondary.secondaryOnly)}`,
      )
      assert(secondary.resumeAt === null, 'a secondary limit was given a reset time to wait for')

      const primary = classifyRemoteFailure('API rate limit exceeded for user', {
        kind: 'rate-limited',
        remaining: 0,
        reset: new Date(Date.now() + 60_000),
      })
      assert(
        primary.state === 'rate-limited' && !primary.secondaryOnly && primary.resumeAt !== null,
        'a spent primary limit did not park polling until its reset',
      )

      const credential = classifyRemoteFailure('Bad credentials', {
        kind: 'unauthorized',
        remaining: null,
        reset: null,
      })
      assert(
        credential.state !== 'rate-limited',
        `an expired credential was treated as a rate limit (${credential.state})`,
      )
      ctx.log('a secondary limit and a spent limit park differently')
    },
  },
  {
    id: 'diagnostics/failure-reports-withhold-secrets-and-paths',
    title: 'a failure report cannot carry the run’s own secret or a local path',
    requires: [],
    async run(ctx) {
      const token = 'live-e2e-fine-grained-secret-value'
      const redactor = new LiveRedactor([token])
      const report = redactor.text(
        `request failed with Authorization: Bearer ${token} from /Users/someone/secret-place and ` +
          `remote.origin.url=https://x-access-token:${token}@github.example/acme/widgets.git`,
      )
      assert(!report.includes(token), 'the run’s own secret survived redaction')
      assert(!report.includes('x-access-token'), 'a credential in a remote URL survived redaction')
      assert(!report.includes('/Users/someone'), 'a local path survived redaction')
      assert(
        report.includes('[REDACTED_SECRET]') && report.includes('[withheld: path]'),
        `the report says nothing about what was removed: ${report}`,
      )

      const published = redactor.text('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
      assert(!published.includes('ghp_'), 'a published GitHub token shape survived redaction')
      ctx.log('secrets, credentials, and paths are all withheld')
    },
  },
  {
    id: 'schema/observed-responses-match-the-committed-fixture',
    title: 'what the host answers still matches the committed mock contract',
    requires: ['nativeStacks', 'reviewThreads'],
    async run(ctx) {
      const observed = await observeSchema(
        ctx.transport,
        await prepareSchemaSubject({
          target: ctx.target,
          workspace: ctx.workspace,
          defaultBranch: 'main',
        }),
        `${ctx.target.kind} runtime`,
      )
      const drift = compareSchemas(readCommittedSchema(), observed)
      const breaking = breakingDrift(drift)
      assert(
        breaking.length === 0,
        `the committed mock contract no longer matches what the host answers:\n${renderDrift(breaking, new LiveRedactor([]))}`,
      )
      ctx.log(
        drift.length === 0
          ? 'the host answers exactly the committed shape'
          : `${drift.length} additive field(s) appeared; regenerate the fixture to capture them`,
      )
    },
  },
]
