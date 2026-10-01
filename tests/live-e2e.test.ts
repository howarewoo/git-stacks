import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GitHubTransportError } from '../src/main/github-transport'
import type { GitHubFixtureState } from './fixtures/github-harness'
import { parseCommand, runCli, EXIT_OK, EXIT_REFUSED } from './live/cli'
import { LIVE_ENV, LiveConfigurationError, readLiveRunConfig } from './live/config'
import { failureReport, LiveRedactor, sanitizeLog } from './live/diagnostics'
import {
  readLiveReceipt as readLiveReceiptSync,
  ResourceLedger,
  recoverLiveResources,
  type LiveReceipt,
  type RecoveryOutcome,
  type RecoverySurface,
} from './live/provisioning'
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

/** The receipt as it is actually on disk, which is the artifact a workflow publishes. */
async function readReceipt(path: string): Promise<LiveReceipt> {
  return readLiveReceiptSync(path)
}

/**
 * A receipt written by the real ledger into a real directory, and the id the run
 * recorded for the repository it names.
 *
 * The id is fixed rather than generated because recovery's refusal message names it,
 * and a test whose expectation contained a random number would be asserting on
 * arithmetic instead of on the decision.
 */
const RECEIPTED_ID = 7001
const RECEIPT_MARKER = 'git-stacks-live-e2e#marker-1'

async function writeReceipt(
  seed: (ledger: ResourceLedger) => void,
): Promise<{ receipt: LiveReceipt; discard: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'git-stacks-live-recovery-'))
  const path = join(directory, 'receipt.json')
  const ledger = new ResourceLedger({
    runId: 'recovery-fixture',
    marker: RECEIPT_MARKER,
    receiptPath: path,
    host: 'github.com',
    owner: 'acme-runner',
  })
  seed(ledger)
  for (const entry of ledger.list()) ledger.confirm(entry.handle, RECEIPTED_ID)
  await ledger.flush()
  return {
    receipt: await readLiveReceiptSync(path),
    discard: async () => {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/**
 * Recovery, driven against a scripted host.
 *
 * The host is scripted rather than real because the properties under test are about
 * what recovery is willing to delete, and asking a real host to be two repositories at
 * once is not something anybody should build. What is real is the engine, the receipt,
 * and every decision it makes.
 */
async function recover(input: {
  receipt: LiveReceipt
  repositories: Record<string, { id?: number; description: string | null; topics?: string[] }>
  /** The accounts this recovery holds a credential for; the receipt's owner by default. */
  surfaces?: readonly string[]
  failWith?: Error
  /** Every deletion recovery asked for, so a run can be seen to remove only once. */
  onDelete?: (fullName: string) => void
}): Promise<RecoveryOutcome> {
  const surfaces = new Map<string, RecoverySurface>()
  const accounts = input.surfaces ?? [input.receipt.owner]
  for (const login of accounts)
    surfaces.set(login, {
      readRepository: async (fullName) => {
        if (input.failWith !== undefined) throw input.failWith
        const known = input.repositories[fullName]
        if (known === undefined) {
          throw new GitHubTransportError({ kind: 'not-found', status: 404, detail: 'Not Found' })
        }
        return known
      },
      deleteRepository: async (fullName) => {
        input.onDelete?.(fullName)
        return true
      },
      deleteRuleSet: async () => true,
    })
  return recoverLiveResources({
    receipt: input.receipt,
    surfaces,
    primaryLogin: accounts[0] ?? input.receipt.owner,
  })
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
      // The host is required alongside the owner and the token. A run that inherits
      // one has inherited a fact about the environment that decides where a real
      // disposable-account credential is sent, and only a person can settle that.
      assert.deepEqual(error.missing, [LIVE_ENV.owner, LIVE_ENV.host, LIVE_ENV.token])
      return true
    },
  )
  for (const owner of ['', '   ', 'acme/widgets', '-acme', 'acme widgets', 'a'.repeat(40)]) {
    assert.throws(
      () =>
        readLiveRunConfig({
          [LIVE_ENV.owner]: owner,
          [LIVE_ENV.host]: 'github.com',
          [LIVE_ENV.token]: 'configured',
        }),
      LiveConfigurationError,
      `owner ${JSON.stringify(owner)} would name a repository that is not this run's`,
    )
  }
  // Both endpoints are derived from that one host, and neither is taken from the
  // environment when it is not stated: a machine set up for local development would
  // otherwise decide where the run's credential authenticates.
  const enterprise = readLiveRunConfig({
    [LIVE_ENV.owner]: 'acme',
    [LIVE_ENV.host]: 'github.enterprise.example',
    [LIVE_ENV.token]: 'primary-token',
  })
  assert.equal(enterprise.apiUrl, 'https://github.enterprise.example/api/v3')
  assert.equal(enterprise.graphqlUrl, 'https://github.enterprise.example/api/graphql')
  const dotCom = readLiveRunConfig({
    [LIVE_ENV.owner]: 'acme',
    [LIVE_ENV.host]: 'github.com',
    [LIVE_ENV.token]: 'primary-token',
  })
  assert.equal(dotCom.apiUrl, 'https://api.github.com')
  assert.equal(dotCom.graphqlUrl, 'https://api.github.com/graphql')
  // Both credentials are redacted by value, so the reviewer token is covered by
  // the same guarantee as the one the run spends on its own writes.
  const configured = readLiveRunConfig({
    [LIVE_ENV.owner]: 'acme',
    [LIVE_ENV.host]: 'github.com',
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

/**
 * What the run's own bookkeeping has to be true of, checked against a real directory
 * and a real receipt rather than against the code that writes one.
 *
 * These are the three properties the rest of the machinery rests on. A receipt that
 * lists a deleted repository as outstanding makes every published run artifact a lie; a
 * credential that survives cleanup stays in a process that may run something else
 * afterwards; and a recovery run that trusts a name instead of an id deletes whatever
 * somebody else has since put at that name.
 */

test('a receipt left on disk stops listing a repository once it has been removed', async () => {
  const run = await startControlled()
  const receiptPath = run.target.receipt
  try {
    const marker = run.target.marker
    const fullName = run.target.repository()
    assert.ok(!existsSync(receiptPath), 'the target wrote no receipt before it created anything')
    // The creation intent has to be on the disk before anything is created, so a
    // response that never comes back still leaves a handle somebody can go and look for.
    const opened = JSON.parse(readFileSync(receiptPath, 'utf8')) as LiveReceipt
    assert.ok(
      opened.resources.some((entry) => entry.kind === 'repository' && entry.handle === fullName),
      'the receipt does not name the repository this run created',
    )

    const report = await run.target.cleanup()
    assert.equal(report.complete, true, `cleanup refused: ${JSON.stringify(report.refused)}`)

    // The artifact a workflow uploads is this file. If it still listed the repository,
    // every published run would report a resource that no longer exists.
    const published = await readReceipt(receiptPath)
    assert.equal(
      published.resources.some(
        (entry) => entry.handle === fullName && entry.deletedAt === undefined,
      ),
      false,
      'the published receipt still lists a repository the run removed',
    )
    assert.equal(published.marker, marker, 'the receipt lost the ownership marker')
    assert.equal(JSON.stringify(published).includes(marker), true)
  } finally {
    await finish(run)
  }
})

test('a cleanup failure still puts the process back the way the run found it', async () => {
  const run = await startControlled()
  const before = { ...process.env }
  try {
    // A repository whose read cannot prove ownership makes every deletion a refusal,
    // which is the worst cleanup has to survive without leaking anything it installed.
    const ledger = run.target.resources
    ledger.refuse(run.target.repository(), 'forced for the test')
    const report = await run.target.cleanup()
    assert.equal(report.complete, false, 'a repository that was refused should not report complete')
    assert.deepEqual(
      Object.keys(process.env).filter((key) => before[key] !== process.env[key]),
      [],
      'the run left the process environment changed after its cleanup',
    )
  } finally {
    await finish(run)
  }
})

test('recovery refuses a name that now belongs to something else', async () => {
  // A receipt written by a real ledger, because the receipt is the only input recovery
  // has: a hand-written one would not prove the id and the marker are really in it, or
  // that a receipt the run left behind is one recovery can read at all.
  const written = await writeReceipt((ledger) => {
    void ledger.intent({
      kind: 'repository',
      handle: 'acme/widgets',
      marker: RECEIPT_MARKER,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: 'acme-runner',
    })
  })
  const outcome = await recover({
    receipt: written.receipt,
    repositories: {
      // Somebody else's repository at the same name.
      'acme/widgets': { id: 4242, description: "Not this run's.", topics: [] },
    },
  })
  assert.deepEqual(outcome.removed, [], "recovery removed a repository that is not this run's")
  assert.deepEqual(outcome.unknown, [])
  assert.deepEqual(outcome.absent, [])
  assert.deepEqual(outcome.refused, [
    { handle: 'acme/widgets', reason: 'the host has id 4242 there; this run created id 7001' },
  ])
  assert.equal(outcome.complete, false, 'a refused deletion cannot report a complete recovery')
  await written.discard()
})

test("recovery removes what still carries the run's id and marker, and creates nothing", async () => {
  const written = await writeReceipt((ledger) => {
    void ledger.intent({
      kind: 'repository',
      handle: 'acme/widgets',
      marker: RECEIPT_MARKER,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: 'acme-runner',
    })
  })
  const deleted: string[] = []
  const outcome = await recover({
    receipt: written.receipt,
    repositories: {
      'acme/widgets': {
        id: RECEIPTED_ID,
        description: `Disposable target\n\n${RECEIPT_MARKER}\n`,
        topics: [],
      },
    },
    onDelete: (fullName) => deleted.push(fullName),
  })
  assert.deepEqual(outcome.refused, [])
  assert.deepEqual(outcome.unknown, [])
  assert.deepEqual(outcome.absent, [])
  assert.deepEqual(outcome.removed, ['acme/widgets'])
  assert.equal(outcome.complete, true)
  // Exactly one deletion, for the one repository the receipt names. The surface recovery
  // is given has no method that could create anything, so this is also what shows the
  // run does not go looking for repositories whose names resemble the ones it expects.
  assert.deepEqual(deleted, ['acme/widgets'])
  await written.discard()
})

test('recovery reports a host it could not ask as unknown, not as removed or absent', async () => {
  const written = await writeReceipt((ledger) => {
    void ledger.intent({
      kind: 'repository',
      handle: 'acme/widgets',
      marker: RECEIPT_MARKER,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: 'acme-runner',
    })
  })
  const outcome = await recover({
    receipt: written.receipt,
    repositories: {},
    failWith: new GitHubTransportError({ kind: 'network', detail: 'connection dropped' }),
  })
  assert.deepEqual(outcome.removed, [], 'a failed read cannot have removed anything')
  assert.deepEqual(outcome.absent, [], 'a failed read is not the same as an absent repository')
  assert.deepEqual(outcome.unknown, ['acme/widgets'])
  assert.equal(outcome.complete, false, 'a read that failed cannot report a complete recovery')
  await written.discard()
})

test('recovery acts with the credential of the account that owns each resource', async () => {
  const written = await writeReceipt((ledger) => {
    for (const [actor, handle] of [
      ['acme-runner', 'acme-runner/widgets'],
      ['reviewer', 'reviewer/widgets-fork'],
      ['third-party', 'third-party/widgets'],
    ]) {
      void ledger.intent({
        kind: 'repository' as const,
        handle,
        marker: RECEIPT_MARKER,
        createdAt: new Date().toISOString(),
        pending: true,
        actor,
      })
    }
  })
  const outcome = await recover({
    receipt: written.receipt,
    // Only two of the three accounts have a credential in this recovery.
    surfaces: ['acme-runner', 'reviewer'],
    repositories: {
      'acme-runner/widgets': { id: RECEIPTED_ID, description: RECEIPT_MARKER, topics: [] },
      'reviewer/widgets-fork': { id: RECEIPTED_ID, description: RECEIPT_MARKER, topics: [] },
      'third-party/widgets': { id: RECEIPTED_ID, description: RECEIPT_MARKER, topics: [] },
    },
  })
  assert.deepEqual(outcome.removed.sort(), ['acme-runner/widgets', 'reviewer/widgets-fork'])
  assert.deepEqual(outcome.refused, [
    {
      handle: 'third-party/widgets',
      reason: 'no credential in this recovery acts as third-party',
    },
  ])
  await written.discard()
})

test('a controlled target that cannot finish starting leaves nothing listening', async () => {
  // The failure reproduced here is an ordinary one: a controlled target is started
  // with no reachable owner. What made it unordinary was what it left behind — a
  // listening socket and a directory, neither of which anything closed. A listener
  // nobody closes holds the event loop open, so a start that fails like this hangs
  // instead of failing, and this test only ends if the guard released what it opened.
  await assert.rejects(
    ControlledLiveTarget.start(),
    (error: unknown) => error instanceof Error,
    'a controlled target that cannot resolve its owner did not refuse',
  )
  // And a second one right after, because what this guards against is a first target
  // keeping the process alive past its own failure rather than any one refusal.
  await assert.rejects(ControlledLiveTarget.start(), (error: unknown) => error instanceof Error)
})

test("a failure report cannot publish either form of the run's own credential", () => {
  // The two forms a real run actually emits: the token as the API transport sends it,
  // and the base64 `x-access-token:<token>` pair Git presents as an authorization
  // header. Redaction keyed only on the token's literal spelling would republish the
  // second one verbatim, and it is reversible by anyone reading the artifact.
  const token = 'ghp_livee2eZZZnotARealTokenButShapedLikeOne01'
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64')
  const redactor = new LiveRedactor([token])

  const raw = redactor.text(`the request failed with Authorization: token ${token}`)
  assert.equal(raw.includes(token), false, 'the raw token survived redaction')

  const header = redactor.text(`authorization: basic ${encoded}`)
  assert.equal(header.includes(encoded), false, 'the authorization header value survived')
  assert.match(header, /REDACTED_CREDENTIAL/u, 'the redaction is not visible to a reader')
  // Keeping only the scheme is what lets a person tell a credential failure from every
  // other authorization failure without being handed the credential.
  assert.match(header, /basic/u)

  const remote = redactor.text(
    `fatal: could not read from https://x-access-token:${token}@github.com/acme/w.git`,
  )
  assert.equal(remote.includes(token), false, 'a credential in a remote URL survived redaction')
})

test("the run's Git environment is exactly the process's again once it is restored", async () => {
  const before = JSON.stringify(sortedEnv(process.env))
  const run = await startControlled()
  try {
    // Inside the run, nothing ambient may still be reaching Git.
    assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(process.env.GIT_CONFIG_GLOBAL !== undefined, true)
    // Every override this run sets arrives as a counted key/value pair, which is how
    // several of them can be supplied at once without a config file.
    const count = Number(process.env.GIT_CONFIG_COUNT)
    assert.ok(count > 0, 'the run installed no configuration')
    for (let index = 0; index < count; index += 1) {
      assert.equal(typeof process.env[`GIT_CONFIG_KEY_${index}`], 'string')
      assert.equal(typeof process.env[`GIT_CONFIG_VALUE_${index}`], 'string')
    }
  } finally {
    await finish(run)
  }
  assert.equal(
    JSON.stringify(sortedEnv(process.env)),
    before,
    'the process environment was not restored',
  )
})

/** The environment, in a form two snapshots can be compared as. */
function sortedEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
  )
}
