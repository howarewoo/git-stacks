import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitHubTransportError } from '../../../src/main/github-transport'
import { getSnapshot, runAction } from '../../../src/main/git'
import { getOriginUrl } from '../../../src/main/git-core'
import { getGitHubIssues } from '../../../src/main/github'
import { getStatus } from '../../../src/main/git-core'
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
import { mergeableLayer, requestMerge } from './merge-support'
import { assert, type LiveScenario, type LiveScenarioContext } from '../scenario'

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
    // Long enough that only this scenario's own events move the coordinator: a
    // background timer firing mid-case would be indistinguishable from the answer.
    { visibleMs: 600_000, secondaryMs: 600_000 },
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

export const ruleAndFaultScenarios: readonly LiveScenario[] = [
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

      const snapshot = await getSnapshot(ctx.workspace.path)
      const preview = await previewStack(ctx.workspace.path, snapshot, 'publish', branch)
      const outcome = await runAction(ctx.workspace.path, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'merge',
      }).then(
        (result) => ({ refused: false, detail: result.message }),
        (error: unknown) => ({ refused: true, detail: String(error) }),
      )
      ctx.log(`the application answered: ${outcome.refused ? 'refused' : 'accepted'}, ${outcome.detail}`)

      // The refusal is beside the point, and it is not what is being asserted. The
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
      assert(pull.merged, `#${layer.number} is not merged on the host after the merge settled as merged`)
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
      // its work now conflicts, which is the state the host refuses to land.
      await ctx.workspace.gitNetwork(['checkout', trunk])
      await ctx.workspace.commit(
        `${trunk}-moved.txt`,
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
      assert(
        refused,
        `the host neither landed nor refused this merge: ${outcome.detail}`,
      )
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
      const layer = await mergeableLayer(ctx, 'merge-lost')
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
      assert(
        second.accepted.kind === 'conflict',
        `the host answered the second request as ${second.accepted.result.status} rather than adopting the request it already held`,
      )
      const adopted = second.accepted.result
      assert(
        adopted.expectedHeadSha === null || adopted.expectedHeadSha === layer.headSha,
        `the adopted request is for ${String(adopted.expectedHeadSha)}, not the head this run reviewed`,
      )
      assert(
        second.settled !== null && second.settled.status === 'merged',
        `the adopted request settled as ${second.settled?.status ?? 'nothing'}: ${second.settled?.message ?? ''}`,
      )
      assert(
        second.settled.uuid === adopted.uuid,
        `the poll read request ${String(second.settled.uuid)} rather than the adopted ${String(adopted.uuid)}`,
      )
      const pull = await mergedOnHost(ctx, layer.number)
      assert(
        pull.merged,
        `#${layer.number} is not merged on the host after the adopted request settled as merged`,
      )
      ctx.log(`adopted ${String(adopted.uuid)} instead of starting a second merge`)
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
    title: 'a field a parser reads stopping answering is drift, and the rest of the probe still reads',
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
    id: 'fields/added-removed-and-renamed-files-are-what-git-reports',
    title: 'the status the window shows names the added, removed, and renamed files Git reports',
    requires: [],
    async run(ctx) {
      const prefix = 'status-files'
      const layer = await pushLayer(ctx, {
        branch: `${prefix}-layer`,
        parent: 'origin/main',
        base: 'main',
        file: `${prefix}.txt`,
        contents: `${prefix}\n`,
        message: `${prefix}: a layer whose status is read`,
      })
      await ctx.workspace.gitNetwork(['checkout', layer.branch])
      await writeFile(join(ctx.workspace.path, `${prefix}-doomed.txt`), 'doomed\n', 'utf8')
      ctx.workspace.git(['add', '-A'])
      ctx.workspace.git(['commit', '-m', `${prefix}: a file to remove`])

      // Staged and uncommitted, which is the state the window's status is about.
      ctx.workspace.git(['rm', '-q', '--', `${prefix}-doomed.txt`])
      await writeFile(join(ctx.workspace.path, `${prefix}-added.txt`), 'added\n', 'utf8')
      ctx.workspace.git(['add', '--', `${prefix}-added.txt`])
      ctx.workspace.git(['mv', '--', `${prefix}.txt`, `${prefix}-renamed.txt`])

      const status = await getStatus(ctx.workspace.path)
      const paths = status.map((entry) => entry.path)
      const removed = status.find((entry) => entry.path === `${prefix}-doomed.txt`)
      assert(
        status.some((entry) => entry.path === `${prefix}-added.txt`),
        `an added file is missing from the status: ${paths.join(', ')}`,
      )
      assert(
        removed !== undefined,
        `a removed file is missing from the status: ${paths.join(', ')}`,
      )
      assert(removed.index === 'D', `the removed file is reported as ${removed.index}, not a deletion`)
      const renamed = status.find((entry) => entry.path === `${prefix}-renamed.txt`)
      assert(renamed !== undefined, `a renamed file is missing from the status: ${paths.join(', ')}`)
      assert(
        renamed.originalPath === `${prefix}.txt`,
        `the rename reports its original as ${String(renamed.originalPath)}`,
      )
      assert(
        status.every((entry) => !entry.conflicted),
        'a working tree with no merge in it was reported as conflicted',
      )
      ctx.log(`status names ${status.length} paths, including the deletion and the rename`)
    },
  },
  {
    id: 'sync/a-secondary-limit-parks-the-inbox-and-not-the-local-state',
    title: 'a secondary rate limit parks background polling while local work keeps refreshing',
    requires: [],
    async run(ctx) {
      const { coordinator, events } = openCoordinator(ctx)
      try {
        coordinator.attach(ctx.workspace.path, await getSnapshot(ctx.workspace.path))
        await coordinator.refreshNow()
        assert(
          coordinator.freshness().state === 'fresh',
          `the healthy refresh reported ${coordinator.freshness().state}: ${String(coordinator.freshness().detail)}`,
        )
        events.length = 0

        // The host's own answer to a request the run makes, sent through the
        // transport the application is using, not an error written into the case.
        ctx.faults.refuseOnce(
          { method: 'GET', pathIncludes: '/pulls' },
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

        // Local work reads the worktree, not GitHub, and must not be parked behind a
        // limit that only GitHub imposes.
        await writeFile(join(ctx.workspace.path, 'secondary-limit-local.txt'), 'local work\n', 'utf8')
        coordinator.notifyLocalChange()
        const local = await nextEvent(
          events,
          (event) => event.kind === 'snapshot' && event.snapshot !== undefined,
          10_000,
        )
        assert(
          local !== null,
          'local work stopped refreshing while GitHub was rate limiting',
        )
        ctx.faults.clearFaults()
        await coordinator.refreshNow()
        assert(
          coordinator.freshness().state === 'fresh',
          `the refresh after the limit lifted still reported ${coordinator.freshness().state}`,
        )
        ctx.log('parked background polling at the limit, kept local refresh running, and recovered')
      } finally {
        coordinator.detach()
      }
    },
  },
]