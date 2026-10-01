import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { GitHubTransportError } from '../src/main/github-transport'
import type { GitHubFixtureState } from './fixtures/github-harness'
import { parseCommand, runCli, EXIT_OK, EXIT_REFUSED } from './live/cli'
import { LIVE_ENV, LiveConfigurationError, readLiveRunConfig } from './live/config'
import { failureReport, LiveRedactor, sanitizeLog } from './live/diagnostics'
import { breakingDrift, compareSchemas, SCHEMA_PROBES } from './live/observed-schema'
import { readCommittedSchema } from './live/schema-fixture'
import { ControlledLiveTarget, resolveRealGit } from './live/targets'

/**
 * What the live suite is allowed to be trusted about, outside a scenario run.
 *
 * The scenarios themselves are exercised by `npx tsx tests/live/cli.ts
 * --controlled`. What that run cannot prove about itself is what happens when it
 * is misconfigured, when a fault is staged at the adapter boundary, and when
 * cleanup is asked to remove something it cannot prove it owns. Those are the
 * properties here, and each one is observed against the controlled host's own
 * state rather than against a stand-in for it.
 */

/** A controlled run, with the host's paths kept before cleanup restores the environment. */
interface ControlledRun {
  readonly target: ControlledLiveTarget
  readonly statePath: string
  readonly barePath: string
}

/** The one removal path cleanup itself uses, so a refused run can still be torn down by its owner. */
interface Removable {
  removeRepository(fullName: string): Promise<boolean>
}

async function startControlled(): Promise<ControlledRun> {
  const target = await ControlledLiveTarget.start()
  const statePath = process.env.GIT_STACKS_FIXTURE_STATE
  const barePath = process.env.GIT_STACKS_FIXTURE_BARE
  assert.ok(statePath && barePath, 'the controlled host publishes where it keeps its state')
  return { target, statePath, barePath }
}

/**
 * Removes everything the run created and stops what it started, whatever the
 * test's own assertions did. A cleanup that refused on purpose leaves the host
 * up, and a host that is still up is this test's to shut down.
 */
async function finish(run: ControlledRun): Promise<void> {
  const report = await run.target.cleanup()
  if (!report.complete) {
    await (run.target as unknown as Removable).removeRepository(run.target.repository())
  }
}

/** What the host is holding right now, read the way the host reads it. */
function hostState(run: ControlledRun): GitHubFixtureState {
  return JSON.parse(readFileSync(run.statePath, 'utf8')) as GitHubFixtureState
}

/** The refs the host is serving Git from, which is the only way a branch is really gone. */
function branchRefs(run: ControlledRun): string {
  return execFileSync(
    resolveRealGit(),
    ['--git-dir', run.barePath, 'for-each-ref', '--format=%(refname)'],
    { encoding: 'utf8' },
  )
}

/** A disposable branch the run owns, so a pull request can be opened against the trunk. */
async function openBranch(run: ControlledRun, branch: string): Promise<void> {
  const fullName = run.target.repository()
  const trunk = hostState(run).repository.defaultBranch
  // The commit is resolved through the host rather than read out of the clone:
  // the head the host names is the one a pull request would really attach to.
  const sha = await run.target.admin.headSha(fullName, trunk)
  assert.notEqual(sha, '')
  assert.notEqual(await run.target.admin.createBranch(fullName, branch, sha), '')
}

function openPullRequest(
  run: ControlledRun,
  branch: string,
): Promise<{ number: number; headSha: string }> {
  return run.target.admin.createPullRequest({
    fullName: run.target.repository(),
    head: branch,
    base: hostState(run).repository.defaultBranch,
    title: `probe ${branch}`,
    body: 'opened by the live suite regression checks',
  })
}

test('a live run with no authorized owner and token is refused before anything is created', async () => {
  const out: string[] = []
  const err: string[] = []
  // `gh` credentials are in the environment on a developer machine. A run that
  // spent them would be spending a credential nobody gave it for this.
  const code = await runCli({
    argv: ['--github'],
    env: { GH_TOKEN: `ghp_${'a'.repeat(36)}`, GITHUB_TOKEN: 'ambient-token' },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  assert.equal(code, EXIT_REFUSED)
  const refusal = err.join('\n')
  assert.match(refusal, new RegExp(LIVE_ENV.owner))
  assert.match(refusal, new RegExp(LIVE_ENV.token))
  assert.equal(out.join('\n'), '', 'a refused run reported something other than the refusal')
})

test('the configuration names every variable it is missing and refuses an owner GitHub would not accept', () => {
  assert.throws(
    () => readLiveRunConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof LiveConfigurationError)
      assert.deepEqual(error.missing, [LIVE_ENV.owner, LIVE_ENV.token])
      return true
    },
  )
  for (const owner of ['', '   ', 'acme/widgets', '-acme', 'acme widgets', 'a'.repeat(40)]) {
    assert.throws(
      () => readLiveRunConfig({ [LIVE_ENV.owner]: owner, [LIVE_ENV.token]: 'configured' }),
      LiveConfigurationError,
      `owner ${JSON.stringify(owner)} would name a repository that is not this run's`,
    )
  }
  // Both credentials are redacted by value, so the reviewer token is covered by
  // the same guarantee as the one the run spends on its own writes.
  const configured = readLiveRunConfig({
    [LIVE_ENV.owner]: 'acme',
    [LIVE_ENV.token]: 'primary-token',
    [LIVE_ENV.reviewerToken]: 'reviewer-token',
  })
  assert.deepEqual([...configured.secrets].sort(), ['primary-token', 'reviewer-token'])
})

test('the command refuses an unnamed target, an unknown scenario, and an unknown argument', async () => {
  const refused = async (argv: string[]): Promise<string> => {
    const err: string[] = []
    const code = await runCli({
      argv,
      env: {},
      out: () => undefined,
      err: (line) => err.push(line),
    })
    assert.equal(code, EXIT_REFUSED)
    return err.join('\n')
  }
  assert.match(await refused([]), /--controlled/)
  // Both of these are answered before a target is started, so a mistyped
  // dispatch cannot provision a repository and then complain about the id.
  assert.match(await refused(['--controlled', '--only', 'no-such-scenario']), /--list/)
  assert.notEqual(parseCommand(['--github', '--force']).problem, null)
  assert.equal(parseCommand(['--github', '--only', 'races/merge-outside-the-app']).problem, null)
})

test('the catalogue is answerable without a target, so a run can be chosen honestly', async () => {
  const out: string[] = []
  assert.equal(
    await runCli({
      argv: ['--list'],
      env: {},
      out: (line) => out.push(line),
      err: () => undefined,
    }),
    EXIT_OK,
  )
  const catalogue = out.join('\n')
  assert.match(catalogue, /stacks\//)
  assert.match(catalogue, /reviews\//)
  assert.match(catalogue, /requires:/)
})

test('a credential reaches no published text, in any position, whatever its shape', () => {
  const literal = 'live-run-credential-4f1c'
  const redactor = new LiveRedactor([literal, `${literal}-extended`])
  const redacted = redactor.text(
    [
      `remote https://x-access-token:${literal}@github.com/acme/widgets.git was refused`,
      `password=${literal}-extended`,
      // A published token shape the run was never configured with: the shape is
      // what has to catch it, because the literal list cannot know it.
      `Authorization: Bearer ghp_${'b'.repeat(36)}`,
      'refusing at /Users/somebody/Desktop/git-stacks/tests/live/cli.ts',
    ].join('\n'),
  )
  assert.equal(redacted.includes(literal), false, 'the configured credential survives verbatim')
  assert.equal(redacted.includes('ghp_'), false, 'a token of a published shape survives verbatim')
  assert.match(redacted, /\[REDACTED_CREDENTIAL\]@github\.com\/acme\/widgets\.git/)
  assert.match(redacted, /\[withheld: path\]/)
})

test('a credential in a remote URL is removed even when the run was never configured with it', () => {
  const redactor = new LiveRedactor([])
  const text = redactor.text(
    'fatal: could not read from https://someone:else-entirely@github.com/a/b.git',
  )
  assert.equal(text.includes('else-entirely'), false)
  assert.match(text, /\[REDACTED_CREDENTIAL\]@github\.com\/a\/b\.git/)
})

test('a secret that contains another secret is removed whole, not as a recognizable fragment', () => {
  const redactor = new LiveRedactor(['abcd', 'abcdefgh-1234'])
  const text = redactor.text('authorization for abcdefgh-1234 rejected')
  assert.equal(text.includes('abcd'), false)
  assert.equal(text.includes('efgh'), false)
  assert.match(text, /\[REDACTED_SECRET\]/)
})

test('a failure report keeps the status that identifies a bug and drops everything a body carries', () => {
  const redactor = new LiveRedactor(['live-run-credential-4f1c'])
  const report = failureReport({
    scenario: 'races/retarget-between-preview-and-submit',
    error: new Error(
      'the push to https://x-access-token:live-run-credential-4f1c@github.com/acme/widgets.git ' +
        'was refused; the repository now contains confidential-source.txt',
    ),
    redactor,
    exchanges: [
      { method: 'POST', path: 'repos/acme/widgets/pulls', status: 409 },
      { method: 'PATCH', path: 'repos/acme/widgets/pulls/7', status: 422 },
    ],
  })
  assert.match(report.message, /\[REDACTED_CREDENTIAL\]@github\.com\/acme\/widgets\.git/)
  // A 409 and a 422 are different bugs; the request body and any repository
  // contents in the message are not published.
  assert.deepEqual(report.exchanges, [
    'POST repos/acme/widgets/pulls -> 409',
    'PATCH repos/acme/widgets/pulls/7 -> 422',
  ])
})

test('a scenario log is bounded, so a long run cannot publish an unbounded artifact', () => {
  const redactor = new LiveRedactor(['live-run-credential-4f1c'])
  const lines = sanitizeLog(
    redactor,
    Array.from({ length: 250 }, (_, index) =>
      index === 249 ? 'still authenticating with live-run-credential-4f1c' : `line ${index}`,
    ),
  )
  assert.equal(lines.length, 200)
  assert.equal(lines[199], 'line 199')
})

test('a refused write never reaches the host, and the fault is spent once', async (t) => {
  const run = await startControlled()
  t.after(() => finish(run))
  await openBranch(run, 'refused-write')
  const before = hostState(run).prs.length

  run.target
    .faults()
    .refuseOnce(
      { method: 'POST', pathIncludes: '/pulls' },
      { status: 403, kind: 'forbidden', message: 'Resource not accessible by integration' },
    )
  await assert.rejects(
    () => openPullRequest(run, 'refused-write'),
    (error: unknown) =>
      error instanceof GitHubTransportError && error.status === 403 && error.kind === 'forbidden',
    'the caller was not told the host refused it',
  )
  assert.equal(hostState(run).prs.length, before, 'a refused mutation was applied anyway')

  // The staged fault covers exactly one request: the next attempt is the
  // caller's own decision, not a second one the injector made.
  const pull = await openPullRequest(run, 'refused-write')
  assert.equal(hostState(run).prs.length, before + 1)
  assert.ok(pull.number > 0)
})

test('a lost response lands on the host once and is never retried behind the caller', async (t) => {
  const run = await startControlled()
  t.after(() => finish(run))
  await openBranch(run, 'lost-response')
  const before = hostState(run).prs.length

  run.target.faults().loseOnce({ method: 'POST', pathIncludes: '/pulls' })
  await assert.rejects(
    () => openPullRequest(run, 'lost-response'),
    (error: unknown) => error instanceof GitHubTransportError && error.kind === 'network',
    'the caller can tell whether the host applied the request',
  )
  // The host holds exactly the one pull request this call could have created:
  // a retry behind the caller would be a second one, which is the whole defect.
  assert.equal(
    hostState(run).prs.length,
    before + 1,
    'the host applied the lost request something other than exactly once',
  )
  assert.deepEqual(
    hostState(run)
      .prs.map((pr) => pr.title)
      .filter((title) => title.includes('lost-response')),
    ['probe lost-response'],
    'one call created a second pull request',
  )
})

test('a fault one scenario never spent cannot fire in the next one', async (t) => {
  const run = await startControlled()
  t.after(() => finish(run))
  await openBranch(run, 'cleared-fault')
  run.target
    .faults()
    .refuseOnce(
      { method: 'POST', pathIncludes: '/pulls' },
      { status: 429, kind: 'rate-limited', message: 'API rate limit exceeded' },
    )
  // The runner clears faults between scenarios, so a rule staged for a scenario
  // that ended early is gone rather than armed against the next one.
  run.target.faults().clearFaults()
  const pull = await openPullRequest(run, 'cleared-fault')
  assert.ok(pull.number > 0, 'a staged fault outlived the scenario that staged it')
})

test('a capability probe that cannot answer leaves no pull request or branch behind', async (t) => {
  const run = await startControlled()
  t.after(() => finish(run))
  // The review-thread probe is a real GraphQL question about a real pull
  // request, so it can be refused the way a host without the surface refuses it.
  run.target.faults().refuseOnce(
    { method: 'POST', pathIncludes: 'graphql:ReviewThreads' },
    {
      status: 403,
      kind: 'forbidden',
      message: 'Resource not accessible by personal access token',
    },
  )
  const capabilities = await run.target.probeCapabilities()
  assert.equal(capabilities.reviewThreads, false, 'the refused probe did not take effect')

  const state = hostState(run)
  // The probe pull request is closed rather than deleted, so what matters is
  // that no open probe pull request is left standing on the host.
  assert.equal(
    hostState(run).prs.some((pr) => pr.head === 'git-stacks-live-e2e-probe' && pr.state === 'OPEN'),
    false,
    'the probe pull request is still open on the host',
  )
  assert.equal(
    branchRefs(run).includes('refs/heads/git-stacks-live-e2e-probe'),
    false,
    'the probe branch is still served by the host',
  )
})

test('cleanup refuses to delete a repository that no longer carries this run marker', async (t) => {
  const run = await startControlled()
  // A refusal leaves the host up, and a host that is still up is this test's to
  // shut down: the refusal is about the marker, not about who cleans up.
  t.after(() => finish(run))
  // Somebody edited the description while the run was working. Ownership can no
  // longer be proven, so the repository is somebody's now.
  const edited = hostState(run)
  edited.repository.description = 'edited by somebody else'
  writeFileSync(run.statePath, JSON.stringify(edited), 'utf8')

  const report = await run.target.cleanup()
  assert.equal(report.complete, false)
  assert.deepEqual(report.remaining, [run.target.repository()])
  const refusal = report.refused.find((entry) => entry.handle === run.target.repository())
  assert.match(refusal?.reason ?? '', /ownership marker/)

  // The repository really is still there: nothing was deleted from disk.
  assert.equal(existsSync(run.barePath), true, 'the run deleted a repository it could not prove')

  // The published receipt carries no credential and never claims the
  // repository is gone: it is the file the workflow uploads either way.
  const raw = readFileSync(run.target.receipt, 'utf8')
  assert.equal(raw.includes('fixture-token'), false, 'the receipt carries a credential')
  const receipt = JSON.parse(raw) as {
    marker: string
    resources: Array<{ handle: string; marker: string; deletedAt?: string }>
  }
  assert.equal(receipt.marker, run.target.marker)
  const recorded = receipt.resources.filter((entry) => entry.handle === run.target.repository())
  assert.equal(recorded.length, 1, 'the receipt does not name the repository')
  assert.equal(recorded[0].marker, run.target.marker)
  assert.equal(
    recorded[0].deletedAt,
    undefined,
    'the receipt claims a deletion that did not happen',
  )
})

test('cleanup answers the runner and the command with the same result, and removes once', async () => {
  const run = await startControlled()
  const first = await run.target.cleanup()
  assert.equal(first.complete, true)
  assert.deepEqual(first.removed, [run.target.repository()])
  assert.equal(existsSync(run.barePath), false, "the run's repository is still on disk")

  // The runner, the schema writer, and the command's own guard each insist on
  // cleanup without knowing whether another already did it.
  const second = await run.target.cleanup()
  assert.deepEqual(second, first, 'a second cleanup reported something different')
  assert.equal(existsSync(run.barePath), false, 'a second cleanup recreated the repository')
})

test('the committed schema fixture records shapes only, and a field the parsers need going missing is breaking drift', () => {
  const committed = readCommittedSchema()
  for (const [id, fields] of Object.entries(committed.probes)) {
    for (const field of fields) {
      assert.deepEqual(
        Object.keys(field).sort(),
        ['path', 'type'],
        `${id} records something other than a path and a type`,
      )
    }
  }
  assert.deepEqual(compareSchemas(committed, committed), [], 'the fixture disagrees with itself')

  const probe = SCHEMA_PROBES.find((entry) => entry.dependsOn.length > 0)
  assert.ok(probe, 'no probe records a field the application depends on')
  const path = probe.dependsOn[0]
  const thinned = {
    ...committed,
    probes: {
      ...committed.probes,
      [probe.id]: (committed.probes[probe.id] ?? []).filter((field) => field.path !== path),
    },
  }
  const drift = breakingDrift(compareSchemas(committed, thinned))
  assert.ok(
    drift.some(
      (entry) => entry.probe === probe.id && entry.path === path && entry.kind === 'missing',
    ),
    'a host that stopped answering a depended-on field is not breaking drift',
  )
})

const WORKFLOW = readFileSync(
  new URL('../.github/workflows/live-github-e2e.yml', import.meta.url),
  'utf8',
)

test('the live workflow can only be dispatched by hand, on the default branch, with read-only permissions', () => {
  assert.match(WORKFLOW, /^ {2}workflow_dispatch:$/mu)
  // Every automatic trigger is a way for a branch somebody else controls to
  // spend the disposable account's credential.
  for (const trigger of ['pull_request_target', 'pull_request', 'schedule', 'push', 'inputs:']) {
    assert.equal(
      new RegExp(`^ {2}${trigger}`, 'mu').test(WORKFLOW),
      false,
      `the live workflow acquired a ${trigger.replace(':', '')} trigger`,
    )
  }
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/mu)
  assert.equal(
    /^ {2,}[a-z-]+: write$/mu.test(WORKFLOW),
    false,
    'the workflow acquired a write scope',
  )
  assert.match(
    WORKFLOW,
    /^concurrency:\n {2}group: live-github-e2e\n {2}cancel-in-progress: false$/mu,
  )
})

test('the live workflow checks out the trusted tree, with no credential left in the checkout', () => {
  const checkouts = WORKFLOW.split('uses: actions/checkout@').slice(1)
  assert.ok(checkouts.length >= 1, 'the workflow checks out nothing')
  for (const step of checkouts) {
    const body = step.split('\n').slice(0, 8).join('\n')
    // A pinned action, the default branch named rather than whatever ref the
    // dispatch happened from, and no token left in the checkout's config.
    assert.match(step.split(' ')[0], /^[0-9a-f]{40}$/u)
    assert.match(body, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
    assert.match(body, /persist-credentials: false/)
  }
  // No run-controlled value reaches a command except the default branch, the
  // disposable account's own configuration, and this run's number.
  const allowed =
    /^github\.event\.repository\.default_branch$|^github\.run_[a-z]+$|^(?:secrets|vars)\.GIT_STACKS_LIVE_/u
  for (const match of WORKFLOW.matchAll(
    /\$\{\{ (github\.[a-z_.]+|vars\.[A-Z_]+|secrets\.[A-Z_]+) \}\}/gu,
  )) {
    assert.match(match[1], allowed, `${match[1]} puts a value into a command this workflow runs`)
  }
})

test('the live workflow spends only the disposable account credentials, and refuses without them', () => {
  const referenced = new Set(
    [...WORKFLOW.matchAll(/\$\{\{ (?:secrets|vars)\.([A-Z_]+) \}\}/gu)].map((match) => match[1]),
  )
  assert.deepEqual(
    [...referenced].sort(),
    [
      'GIT_STACKS_LIVE_GITHUB_OWNER',
      'GIT_STACKS_LIVE_GITHUB_REVIEWER_TOKEN',
      'GIT_STACKS_LIVE_GITHUB_TOKEN',
    ],
    'the workflow reads a credential or setting outside the disposable account configuration',
  )
  // Naming the environment does not configure its protection, so the gate is
  // what makes an unconfigured repository refuse before it creates anything.
  assert.match(WORKFLOW, /^ {4}environment: live-github-e2e$/mu)
  assert.match(WORKFLOW, /Refuse to run without an authorized disposable account/)
  assert.ok(
    WORKFLOW.includes('if [ -z "${!name:-}" ]'),
    'the gate does not test each configured value for being unset',
  )
  assert.match(WORKFLOW, /refusing to run/u)
  // The credential reaches the suite and nothing else, and the receipt is the
  // only file published, whatever the run's outcome.
  const live = WORKFLOW.split('environment: live-github-e2e')[1] ?? ''
  assert.match(live, /npx tsx tests\/live\/cli\.ts --github/)
  assert.equal(WORKFLOW.split('uses: actions/upload-artifact@').length - 1, 1)
  assert.match(WORKFLOW, /^ {8}if: always\(\)$/mu)
  assert.match(live, /path: live-github-e2e-receipt\.json/u)
})
