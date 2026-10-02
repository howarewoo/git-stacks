import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'

import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  DirectGitHubTransport,
  GitHubTransportError,
  installedGitHubTransport,
  setGitHubTransport,
} from '../src/main/github-transport'
import {
  claimLiveGit,
  createGitHubHarness,
  type GitHubFixtureState,
} from './fixtures/github-harness'
import { generateCertificate, startControlledGitHubHost } from './fixtures/live-github-tls'
import {
  parseCommand,
  runCli,
  runRecoveryAgainstControlledHost,
  EXIT_OK,
  EXIT_REFUSED,
} from './live/cli'
import { LIVE_ENV, LiveConfigurationError, readLiveRunConfig } from './live/config'
import { failureReport, LiveRedactor, sanitizeLog } from './live/diagnostics'
import { installIsolatedGitEnvironment } from './live/git-environment'
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
import { pushCommit } from './live/layers'
import { ControlledLiveTarget, resolveRealGit } from './live/targets'

const execFileAsync = promisify(execFile)

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
): Promise<{ receipt: LiveReceipt; path: string; discard: () => Promise<void> }> {
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
    path,
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

/**
 * A disposable branch the run owns, carrying a commit of its own.
 *
 * The commit is made in the real clone and pushed over the real remote, because a ref
 * created through the API and pointed at the trunk has nothing to compare: GitHub
 * answers that pull request with `No commits between`, so every refusal, fault and race
 * below would be reading a request the host refuses before it applies anything. The
 * head is what the remote holds afterwards, read back rather than assumed.
 */
async function openBranch(run: ControlledRun, branch: string): Promise<void> {
  const trunk = hostState(run).repository.defaultBranch
  const head = await pushCommit(await run.target.workspace(), {
    branch,
    parent: `origin/${trunk}`,
    file: `${branch}.txt`,
    contents: `${branch}\n`,
    message: `${branch}: a branch the run owns`,
  })
  assert.match(head, /^[0-9a-f]{40}$/u, 'the branch the run pushed has no remote head')
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

test('cleanup reports a changed marker as unresolved and never records it as deleted', async (t) => {
  const run = await startControlled()
  // This checks the report and receipt contract, not remote preservation.
  t.after(() => finish(run))
  // Somebody edited the description while the run was working. Ownership can no
  // longer be proven, so the repository is somebody's now.
  const edited = hostState(run)
  edited.repository.description = 'edited by somebody else'
  writeFileSync(run.statePath, JSON.stringify(edited), 'utf8')

  const report = await run.target.cleanup()
  assert.equal(report.complete, false)
  assert.deepEqual(report.remaining, [run.target.repository()])
  assert.equal(
    report.refused.some((entry) => entry.handle === run.target.repository()),
    true,
  )
  assert.equal(
    report.removed.includes(run.target.repository()),
    false,
    'the run reported a repository it refused to delete as removed',
  )

  // The published receipt carries no credential and never claims the
  // repository is gone: it is the file the workflow uploads either way. Both
  // credentials this run actually authenticates with are checked, so a receipt
  // that leaked either account's would fail.
  const raw = readFileSync(run.target.receipt, 'utf8')
  for (const credential of [run.target.harness.primaryToken, run.target.harness.reviewer.token]) {
    assert.equal(raw.includes(credential), false, 'the receipt carries a credential')
  }
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
  // No comparison of the fixture against itself: a document cannot disagree with itself,
  // so it decides nothing. What is checked below is a host that actually changed.

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
    // The receipt names the repository and the marker cleanup matches on, and it does so
    // on disk before anything is deleted: a response that never comes back, or a process
    // that is killed, still leaves a handle somebody can go and look for.
    const opened = JSON.parse(readFileSync(receiptPath, 'utf8')) as LiveReceipt
    const journal = opened.resources.find((entry) => entry.handle === fullName)
    assert.ok(journal, 'the receipt does not name the repository this run created')
    assert.equal(journal.kind, 'repository')
    assert.equal(journal.marker, run.target.marker, 'the receipt carries no ownership marker')
    assert.equal(
      journal.deletedAt,
      undefined,
      'the receipt claims a deletion that has not happened',
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
  // Taken before the run rather than during it: what has to be true after a cleanup
  // that refused everything is that the process is the one the run was started in, not
  // the one the run was in the middle of. A snapshot from mid-run compares the run's
  // own isolation against its absence afterwards, which reads as a leak even when the
  // process is exactly where it started.
  const before = sortedEnv(process.env)
  const run = await startControlled()
  try {
    // A repository that no longer carries the marker makes every deletion a refusal,
    // which is the worst cleanup has to survive without leaking anything it installed
    // into the process that runs everything else afterwards.
    const edited = hostState(run)
    edited.repository.description = 'edited by somebody else'
    writeFileSync(run.statePath, JSON.stringify(edited), 'utf8')
    assert.notDeepEqual(
      sortedEnv(process.env),
      before,
      'the run changed nothing at all, so a process left unchanged would prove nothing',
    )
    const report = await run.target.cleanup()
    assert.equal(report.complete, false, 'a repository that was refused should not report complete')
    assert.deepEqual(
      sortedEnv(process.env),
      before,
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
  assert.deepEqual(
    outcome.refused.map((entry) => entry.handle),
    ['acme/widgets'],
    'the repository somebody else owns was not left outstanding',
  )
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

test('an organization-owned receipt recovers through the account that created it', async () => {
  // The owner and the actor are different people whenever a run is pointed at an
  // organization, because a user account creates the repository and the organization
  // owns it. Requiring the credential to be the owner would refuse exactly the runs
  // that most need recovering, so what authenticates here is the recorded actor.
  const written = await writeReceipt((ledger) => {
    void ledger.intent({
      kind: 'repository',
      handle: 'acme-org/widgets',
      marker: RECEIPT_MARKER,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: 'alice',
    })
  })
  const deleted: string[] = []
  const outcome = await recover({
    receipt: { ...written.receipt, owner: 'acme-org' },
    repositories: {
      'acme-org/widgets': {
        id: RECEIPTED_ID,
        description: `Disposable target\n\n${RECEIPT_MARKER}\n`,
        topics: [],
      },
    },
    surfaces: ['alice'],
    onDelete: (fullName) => deleted.push(fullName),
  })
  assert.deepEqual(outcome.refused, [])
  assert.deepEqual(outcome.removed, ['acme-org/widgets'])
  assert.equal(outcome.complete, true)
  assert.deepEqual(deleted, ['acme-org/widgets'])
  await written.discard()
})

test('recovery refuses when the only credential is not the account that created it', async () => {
  const written = await writeReceipt((ledger) => {
    void ledger.intent({
      kind: 'repository',
      handle: 'acme-org/widgets',
      marker: RECEIPT_MARKER,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: 'alice',
    })
  })
  const deleted: string[] = []
  const outcome = await recover({
    receipt: { ...written.receipt, owner: 'acme-org' },
    repositories: {
      'acme-org/widgets': {
        id: RECEIPTED_ID,
        description: `Disposable target\n\n${RECEIPT_MARKER}\n`,
        topics: [],
      },
    },
    surfaces: ['mallory'],
    onDelete: (fullName) => deleted.push(fullName),
  })
  assert.deepEqual(deleted, [], 'an account with no right to the resource deleted it anyway')
  assert.equal(outcome.complete, false)
  assert.equal(outcome.refused.length, 1)
  // The refusal names the account it needed rather than the one it was handed, because
  // that is the one a person has to go and find.
  assert.match(outcome.refused[0].reason, /alice/)
  await written.discard()
})

test('a recovery with no credential refuses before it can delete anything', async () => {
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
  const err: string[] = []
  const out: string[] = []
  // The host is the one the receipt names, so this really would reach github.com if the
  // refusal were not first. That is the point: with no credential there is nothing to
  // ask and nothing to install, and the run says so instead of dialling out.
  const code = await runCli({
    argv: ['--recover', written.path],
    env: { [LIVE_ENV.host]: written.receipt.host },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  assert.equal(code, EXIT_REFUSED)
  assert.match(err.join('\n'), new RegExp(LIVE_ENV.token))
  assert.equal(out.join('\n'), '', 'a refused recovery printed a result')
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

test('a recovery completes against a real TLS host and removes what its receipt names', async () => {
  // The only test here that runs the whole command against a host rather than a scripted
  // surface: a real `git`, a real TLS socket, a real certificate, and the production
  // transport, with the recovery opening its own verified connection exactly as it does
  // against a public host. Everything the recovery does — resolving the endpoint from
  // the host its receipt names, authenticating, proving the id and the marker, deleting,
  // and reading back — is the same path in both, so a break in any of them shows up here
  // and nowhere else.
  const out: string[] = []
  const err: string[] = []
  const outcome = await runRecoveryAgainstControlledHost({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  assert.deepEqual(err, [], 'a successful recovery reported a refusal')
  assert.equal(outcome.code, EXIT_OK, `the recovery did not finish: ${out.join(' ')}`)
  assert.match(out.join('\n'), new RegExp(`removed ${outcome.repository.replace('/', '\\/')}`))
  // Read back from the host over the same verified connection rather than trusted from
  // the report: a recovery that printed a removal and left the repository standing is the
  // failure this whole mechanism exists to prevent, and only the host can settle it.
  assert.equal(outcome.stillPresent, false, 'the host still has what the recovery removed')
  // The fixture describes a host this process is about to stop answering to, and it is
  // read by ordinary request handlers rather than by anything the recovery installs.
  assert.deepEqual(
    Object.keys(process.env).filter((key) => key.startsWith('GIT_STACKS_FIXTURE')),
    [],
    "the recovery left this run's fixture pointed at a host that is gone",
  )
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
  assert.deepEqual(
    outcome.refused.map((entry) => entry.handle),
    ['third-party/widgets'],
    'the account this recovery holds no credential for was not left unaccounted for',
  )
  await written.discard()
})

test('a controlled target that cannot finish starting leaves nothing listening', async (t) => {
  // The failure reproduced here is an ordinary one, and it happens where it hurts: a
  // receipt path whose parent is a file cannot be written, so the run fails after the
  // socket is open and the workspace exists, with two local resources it now owns.
  // What made that unordinary was what it left behind — a listening socket and a
  // directory, neither of which anything closed. A listener nobody closes holds the
  // event loop open, so a start that fails like this hangs instead of failing.
  //
  // The directory this run opened is counted inside a temporary directory of this test's
  // own. Every test file in this suite runs in its own process and each one opens a
  // harness, so counting them in the shared temporary directory would be counting other
  // files' runs as well and would fail whenever one of them overlaps this one.
  const directory = await mkdtemp(join(tmpdir(), 'git-stacks-live-start-failure-'))
  const privateTmp = join(directory, 'tmp')
  const previousTmpdir = process.env.TMPDIR
  mkdirSync(privateTmp)
  process.env.TMPDIR = privateTmp
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  })
  const blocker = join(directory, 'receipt-path-is-a-file')
  writeFileSync(blocker, 'not a directory\n')
  // What is left in a directory this test owns, by name. Not a count of entries matching
  // a prefix: a controlled run's root is `git-stacks-live-controlled-`, so counting
  // `git-stacks-github-harness-` here was counting a prefix this run never creates and
  // could not fail. What has to be true is that the failed start left nothing at all.
  const leftBehind = (): string[] => readdirSync(privateTmp)
  const before = leftBehind()

  await assert.rejects(
    ControlledLiveTarget.start({ receiptPath: join(blocker, 'receipt.json') }),
    /receipt-path-is-a-file/u,
    'a controlled target that could not journal its repository did not refuse',
  )
  assert.deepEqual(leftBehind(), before, 'a failed start left a directory it opened behind')

  // And a real run right after, because what this guards against is the process itself:
  // a transport nobody reset would send this run's requests through the failed one, and a
  // socket nobody closed would still be holding the event loop when this file ends.
  const next = await ControlledLiveTarget.start()
  try {
    const head = await next.admin.headSha(next.repository(), await next.defaultBranch)
    assert.notEqual(head, '', 'the run after a failed start could not reach its own host')
  } finally {
    await next.cleanup()
  }
  await rm(directory, { recursive: true, force: true })
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

test('the process boundary holds during the run and closes afterwards', async () => {
  // The recipe the targets actually use, in a child process of its own. A copy of the
  // environment object cannot show this: the defect was that merging that object into
  // `process.env` never removed anything, so the object was correct and the process was
  // not. Only the process can observe the difference.
  //
  // The comparison is against a snapshot the child takes itself, because the ambient
  // environment is not ours to assume: this machine already sets `GIT_CONFIG_COUNT`
  // with a counted pair of its own, so a test that asserted "no GIT_CONFIG_COUNT after
  // restore" would pass on a machine with a clean environment and fail here for
  // correctly putting back what was there.
  const HELPER_URL = new URL('./live/git-environment.ts', import.meta.url).href
  const script = `
    import { mkdtemp } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { installIsolatedGitEnvironment } from '${HELPER_URL}'

    const home = await mkdtemp(join(tmpdir(), 'live-env-'))
    const original = { ...process.env }

    const git = await installIsolatedGitEnvironment({
      home,
      author: { name: 'Live', email: 'live@git-stacks.invalid' },
      credentials: [
        { url: 'https://github.invalid/acme/widgets.git', header: 'AUTHORIZATION: basic c2VjcmV0' },
      ],
    })
    // Exactly what tests/live/targets.ts does.
    git.install()

    const count = Number(process.env.GIT_CONFIG_COUNT)
    const values = []
    for (let index = 0; index < count; index += 1) values.push(process.env['GIT_CONFIG_VALUE_' + index])
    const during = {
      retired: {
        redirect: process.env.GIT_DIR === undefined,
        token: process.env.GITHUB_TOKEN === undefined,
        trace: process.env.GIT_TRACE_CURL === undefined,
      },
      // The run's own counted configuration is what is installed now: its credential
      // header is one of the values, which the ambient pair never was.
      ownsConfig: values.includes('AUTHORIZATION: basic c2VjcmV0'),
      hooksPath: process.env.GIT_CONFIG_KEY_0 === 'core.hooksPath',
    }

    git.restore()

    const after = { exact: JSON.stringify(process.env) === JSON.stringify(original) }
    const leaked = Object.keys(process.env).filter(
      (key) => original[key] === undefined && String(process.env[key]).includes('c2VjcmV0'),
    )
    after.credentialGone = leaked.length === 0
    process.stdout.write(JSON.stringify({ during, after }))
  `
  const directory = await mkdtemp(join(tmpdir(), 'live-boundary-'))
  const file = join(directory, 'boundary.mts')
  writeFileSync(file, script, 'utf8')
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', file], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: process.env.PATH ?? '',
        GIT_DIR: '/somewhere/else/.git',
        GITHUB_TOKEN: 'ambient-token',
        GIT_TRACE_CURL: '1',
      },
    })
    const observed = JSON.parse(output) as {
      during: { retired: Record<string, boolean>; ownsConfig: boolean; hooksPath: boolean }
      after: { exact: boolean; credentialGone: boolean }
    }
    assert.deepEqual(observed.during, {
      retired: { redirect: true, token: true, trace: true },
      ownsConfig: true,
      hooksPath: true,
    })
    assert.equal(observed.after.exact, true, 'the process environment was not exactly restored')
    assert.equal(observed.after.credentialGone, true, "the run's credential outlived the run")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the run's Git children inherit no ambient TLS bypass, trace switch, counted configuration, or token", async (t) => {
  // Four things a developer machine or a CI image can carry without anybody noticing,
  // and what each of them would do to a run: accept a certificate nothing vouches for,
  // narrate the authorization header this run installs to whatever captures a Git
  // command's stderr, put a configuration value in front of every Git the run starts,
  // and hand a run a credential that belongs to somebody else entirely. They are put
  // in the environment before the run, because an environment that never had them
  // proves nothing about the ones that do.
  const ambient: Record<string, string> = {
    GIT_SSL_NO_VERIFY: '1',
    // Node's answer to the same question, which Git's switch cannot reach: this is what
    // the production transport's own `fetch` reads when it opens a connection, and it is
    // read in this process, for every request the run makes including the first
    // authenticated one. A purge naming only the Git variables secures the Git children
    // and leaves that request exactly as unverified as it was.
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    GIT_CURL_VERBOSE: '1',
    GIT_CONFIG_KEY_999: 'http.extraheader',
    GIT_CONFIG_VALUE_999: 'AUTHORIZATION: basic c2VjcmV0',
    GITHUB_TOKEN: 'ambient-token',
  }
  Object.assign(process.env, ambient)
  t.after(() => {
    for (const key of Object.keys(ambient)) delete process.env[key]
  })
  const run = await startControlled()
  t.after(() => finish(run))

  for (const key of Object.keys(ambient)) {
    assert.equal(process.env[key], undefined, `${key} reached the process a run's Git reads`)
  }

  const git = resolveRealGit()
  const origin = (await run.target.workspace()).git(['remote', 'get-url', 'origin'])
  /**
   * This run's own environment with the run's counted configuration taken out, which
   * is what the host looks like to a Git that has not been given the authority the run
   * pins for it.
   */
  const withoutRunConfiguration = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
    const pairs: Array<[string, string]> = []
    const count = Number(env.GIT_CONFIG_COUNT ?? '0')
    for (let i = 0; i < count; i++) {
      const key = env[`GIT_CONFIG_KEY_${i}`] ?? ''
      const value = env[`GIT_CONFIG_VALUE_${i}`] ?? ''
      delete env[`GIT_CONFIG_KEY_${i}`]
      delete env[`GIT_CONFIG_VALUE_${i}`]
      if (key !== 'http.sslCAInfo' && key !== 'http.sslVerify') {
        pairs.push([key, value])
      }
    }
    env.GIT_CONFIG_COUNT = String(pairs.length)
    pairs.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key
      env[`GIT_CONFIG_VALUE_${i}`] = value
    })
    return env
  }
  // The host this run serves is a socket in this process, so a Git command that reaches
  // it cannot be run synchronously here: it would wait for an answer this event loop
  // cannot give until it returned. Each case therefore runs its Git in a child process
  // of its own — the shape a command the application starts actually has — carrying
  // exactly the environment that case is about, and reporting what Git printed.
  const lsRemote = async (env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> => {
    const child = await execFileAsync(
      process.execPath,
      [
        '-e',
        "const { spawnSync } = require('node:child_process');" +
          "const run = spawnSync(process.argv[1], process.argv.slice(2), { env: process.env, encoding: 'utf8' });" +
          'process.stdout.write(JSON.stringify({ code: run.status, stderr: String(run.stderr) }))',
        git,
        'ls-remote',
        origin,
      ],
      { encoding: 'utf8', env },
    )
    return JSON.parse(String(child.stdout)) as { code: number; stderr: string }
  }

  // The host's certificate is one nothing outside this run vouches for, so reaching it
  // is the run pinning an authority and asking for verification; refusing it without
  // that pin is the refusal being verification rather than an unreachable host.
  const pinned = await lsRemote(process.env)
  assert.equal(pinned.code, 0, `the run's own Git could not reach its host: ${pinned.stderr}`)
  const unpinned = await lsRemote(withoutRunConfiguration())
  assert.notEqual(unpinned.code, 0, 'the host answered without the authority this run pinned')
  // And the variable the purge removes is what turns that refusal into an acceptance,
  // which is why leaving it inherited is a hole and not a tidiness question.
  const bypassed = await lsRemote(withoutRunConfiguration({ GIT_SSL_NO_VERIFY: '1' }))
  assert.equal(
    bypassed.code,
    0,
    `this Git refused an untrusted certificate even with verification switched off: ${bypassed.stderr}`,
  )

  // Git narrating its own transport, which is where an authorization header goes.
  assert.equal(
    /http\.c:|== Info:/u.test(pinned.stderr),
    false,
    "the run's Git narrated its own transport",
  )
  const narrated = await lsRemote({ ...process.env, GIT_CURL_VERBOSE: '1' })
  assert.match(narrated.stderr, /http\.c:/u, 'the probe cannot see a trace at all')

  // The header an inherited counted pair would put in front of every command this run
  // starts, and the same header arriving from a pair Git does read, so the first answer
  // is an absence rather than a Git that has none to show.
  const headersIn = (env: NodeJS.ProcessEnv): string => {
    try {
      return execFileSync(git, ['config', '--get-all', 'http.extraheader'], {
        encoding: 'utf8',
        env,
      }).trim()
    } catch (error) {
      // A key the environment does not set is answered with exit 1 and no output, and
      // that absence is the answer this is looking for; any other failure is not.
      const status =
        typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
      assert.equal(
        status,
        1,
        `reading http.extraheader failed for another reason: ${String(error)}`,
      )
      return ''
    }
  }
  assert.equal(headersIn(process.env), '', 'an inherited header survived into the run')
  assert.match(
    headersIn({
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic c2VjcmV0',
    }),
    /c2VjcmV0/u,
    'the probe cannot see a counted header at all',
  )

  // And the run puts the process back exactly as it found these, so the machine that
  // ran the suite is the machine it had before.
  await finish(run)
  for (const [key, value] of Object.entries(ambient)) {
    assert.equal(process.env[key], value, `${key} was not put back the way the run found it`)
  }
})

test('the API transport reaches an unvouched-for certificate only when Node is told not to check', async (t) => {
  // The API side of the same boundary the Git case above covers, against a socket this
  // test owns and a certificate nothing vouches for. The production transport is used
  // exactly as the live target uses it — with no `fetch` of its own, so Node's TLS
  // settings decide — and the credential is a string this test made up, so nothing here
  // can be mistaken for a real account.
  const certificate = generateCertificate()
  t.after(() => rm(certificate.directory, { recursive: true, force: true }))
  const token = 'live-e2e-synthetic-token'
  /**
   * One socket of its own, answering with the login the credential authenticated as.
   * Each case gets a separate one because a pooled connection that already completed a
   * handshake is not asked the question again: reusing one socket would let the second
   * case succeed without ever checking a certificate, which is the opposite of what is
   * being observed here.
   */
  const startHost = async (): Promise<{
    readonly apiUrl: string
    readonly presented: Array<string | undefined>
  }> => {
    const presented: Array<string | undefined> = []
    const server = createServer(
      { key: certificate.key, cert: certificate.cert },
      (request, reply) => {
        presented.push(request.headers.authorization)
        reply.writeHead(200, { 'content-type': 'application/json' })
        reply.end(JSON.stringify({ login: 'live-e2e-synthetic' }))
      },
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the socket has no port')
    return { apiUrl: `https://127.0.0.1:${address.port}`, presented }
  }
  const transport = (apiUrl: string): DirectGitHubTransport =>
    new DirectGitHubTransport({
      token,
      host: new URL(apiUrl).host,
      apiUrl,
      graphqlUrl: `${apiUrl}/graphql`,
    })

  // What an inherited switch does to a request that carries this run's credential: the
  // handshake completes against a certificate no authority vouches for, and the bearer
  // arrives at a host that should never have seen it. This is what makes the retirement
  // load-bearing rather than tidiness — without this case, the refusal below would prove
  // nothing about whether anything was ever at stake.
  const unchecked = await startHost()
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    const accepted = await transport(unchecked.apiUrl).rest<{ login: string }>({
      method: 'GET',
      path: 'user',
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(unchecked.presented, [`Bearer ${token}`])
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  }

  // And the same request once the run's isolation has retired it: a transport with no
  // fetch of its own cannot complete a handshake, and the host is asked nothing at all.
  const verified = await startHost()
  const isolated = await installIsolatedGitEnvironment({
    home: certificate.directory,
    author: { name: 'Git Stacks Live', email: 'live-e2e@example.invalid' },
  })
  isolated.install()
  try {
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined)
    await assert.rejects(
      () => transport(verified.apiUrl).rest({ method: 'GET', path: 'user' }),
      (error: unknown) =>
        error instanceof GitHubTransportError &&
        (error.kind === 'network' || error.kind === 'not-configured'),
      'the transport connected to a certificate nothing vouches for with the switch retired',
    )
    assert.deepEqual(verified.presented, [], 'a refused handshake still reached the host')
  } finally {
    isolated.restore()
  }
})

test('a branch inside a still-standing repository is reported, not called removed', async () => {
  // The parent/child rule, observed from the outside. A branch and a rule set recorded
  // inside a repository this receipt does not name are settled from that repository's own
  // answer — and where the repository is still there, the branch is too. Reporting it as
  // removed is the one thing an operator reading the output cannot act on.
  const surfaces = new Map<string, RecoverySurface>([
    [
      'alice',
      {
        readRepository: async () => ({
          id: 41,
          description: 'git-stacks-live-e2e:rr1:abcd',
          topics: ['git-stacks-live-e2e'],
        }),
        deleteRepository: async () => true,
        deleteRuleSet: async () => true,
      },
    ],
  ])
  const receipt: LiveReceipt = {
    version: 2,
    runId: 'rr1',
    marker: 'git-stacks-live-e2e:rr1:abcd',
    host: 'github.com',
    owner: 'alice',
    writtenAt: '2024-01-01T00:00:00.000Z',
    resources: [
      {
        kind: 'branch',
        handle: 'alice/widgets#feature',
        marker: 'git-stacks-live-e2e:rr1:abcd',
        createdAt: '2024-01-01T00:00:00.000Z',
        actor: 'alice',
      },
      {
        kind: 'rule-set',
        handle: 'alice/widgets/rulesets/9',
        marker: 'git-stacks-live-e2e:rr1:abcd',
        createdAt: '2024-01-01T00:00:00.000Z',
        actor: 'alice',
      },
    ],
  }
  const outcome = await recoverLiveResources({ receipt, surfaces, primaryLogin: 'alice' })
  // The branch is not a thing recovery deletes on its own — it only ever existed inside a
  // repository, and that repository is still standing, so the branch is too. It is
  // reported, not claimed as removed.
  assert.deepEqual(
    outcome.refused.map((entry) => entry.handle),
    ['alice/widgets#feature'],
  )
  // The rule set is the one child recovery does delete individually, and only after
  // proving the repository is this run's, so the host really is asked to remove it.
  assert.deepEqual(outcome.removed, ['alice/widgets/rulesets/9'])
  assert.deepEqual(outcome.unknown, [])
})

test('a receipt naming no repository for a child is refused rather than settled', async () => {
  // The other half of the same rule. A handle the receipt cannot place inside a repository
  // names no repository at all, so there is nothing to prove ownership against and
  // nothing to read back. Deleting on a guess from a prefix is exactly what recovery
  // exists not to do.
  const outcome = await recoverLiveResources({
    receipt: {
      version: 2,
      runId: 'rr2',
      marker: 'git-stacks-live-e2e:rr2:beef',
      host: 'github.com',
      owner: 'alice',
      writtenAt: '2024-01-01T00:00:00.000Z',
      resources: [
        {
          kind: 'rule-set',
          handle: 'rulesets/9',
          marker: 'git-stacks-live-e2e:rr2:beef',
          createdAt: '2024-01-01T00:00:00.000Z',
          actor: 'alice',
        },
      ],
    },
    surfaces: new Map(),
    primaryLogin: 'alice',
  })
  assert.deepEqual(outcome.removed, [])
  assert.deepEqual(
    outcome.refused.map((entry) => entry.handle),
    ['rulesets/9'],
  )
  assert.equal(outcome.complete, false)
})

test('a live run does not take back a transport another owner installed', async (t) => {
  // Two runs in one process, or a run and anything else that installs a transport. The
  // slot replaces rather than stacks, so restoring unconditionally would remove the second
  // owner's transport and report a clean process while it did. The run has to notice that
  // the slot moved on and leave it alone.
  const run = await startControlled()
  const installed = installedGitHubTransport()
  assert.ok(installed, 'a controlled run installed no transport to be taken back')
  const someoneElse = new DirectGitHubTransport({ token: 'not-this-run' })
  setGitHubTransport(someoneElse)
  t.after(() => {
    if (installedGitHubTransport() === someoneElse) setGitHubTransport(null)
  })
  const report = await run.target.cleanup()
  assert.equal(
    installedGitHubTransport(),
    someoneElse,
    'a finished run removed a transport it no longer owned',
  )
  // The run also has to say that it did not put the process back as it found it. What is
  // checked is that a cleanup failure was recorded at all, not how it is worded.
  assert.equal(
    (report.localFailures?.length ?? 0) > 0,
    true,
    'the run reported a clean process after leaving another owner’s transport installed',
  )
})

test('a Git request the backend refuses before reading its body answers once and does not end the process', async (t) => {
  // The real backend, on the real socket, deciding the request from its headers and
  // exiting while this host is still writing a body too large for a pipe. Its own
  // rejection is the answer the client gets; the broken pipe is a fact about the write,
  // not an error that may take the run down with it.
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-live-backend-'))
  const harness = await createGitHubHarness({
    barePath: 'projects/acme/widgets.git',
    root,
    preserveRoot: true,
  })
  const server = await startControlledGitHubHost({
    projectsRoot: harness.projectsRoot,
    git: harness.env.GIT_STACKS_REAL_GIT as string,
  })
  t.after(async () => {
    await server.close()
    await harness.close()
    await rm(root, { recursive: true, force: true })
  })
  const state = await harness.readState()
  const fullName = `${state.repository.owner}/${state.repository.name}`
  const refs = (): string =>
    harness.runGit(['--git-dir', harness.bare, 'for-each-ref', '--format=%(refname)'])

  const before = refs()
  // The pinned fetch carries a string body, which is also what makes this request large
  // enough to outlive the pipe the backend is writing its rejection into.
  const oversized = 'a'.repeat(1 << 20)
  const refused = await server.fetch(new URL(`${server.cloneUrl(fullName)}/git-receive-pack`), {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(Buffer.byteLength(oversized)),
    },
    body: oversized,
  })
  await refused.arrayBuffer()
  assert.equal(refused.status, 415, 'the backend accepted a content type that is not Git’s')
  assert.equal(refs(), before, 'a refused request changed the repository it named')

  // The host is still answering Git after that: one rejection is not a host that has
  // stopped serving, and a process that died here would report neither.
  const followUp = await server.fetch(
    new URL(`${server.cloneUrl(fullName)}/info/refs?service=git-upload-pack`),
    { headers: { accept: '*/*' } },
  )
  await followUp.arrayBuffer()
  assert.equal(followUp.status, 200)
  assert.deepEqual(
    server.served.filter((entry) => entry.path.endsWith('/git-receive-pack')),
    [{ method: 'POST', path: `/${fullName}.git/git-receive-pack`, status: 415 }],
    'the refused request was not answered exactly once',
  )
})

test('controlled and explicit live claims refuse Git outside their owned root', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'git-stacks-live-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const git = resolveRealGit()
  // Explicit synchronous fixture setup, not an intercepted escape used as setup.
  execFileSync(git, ['init', '-b', 'main', outside], { stdio: 'ignore' })
  assert.equal(
    execFileSync(git, ['-C', outside, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    }).trim(),
    'true',
  )
  const check = async (owned: string): Promise<void> => {
    const escape = join(owned, 'outside-link')
    await symlink(outside, escape, 'junction')
    const attempts = [
      { args: ['-C', outside, 'rev-parse', '--is-inside-work-tree'] },
      { args: [`-C${outside}`, 'rev-parse', '--is-inside-work-tree'] },
      { args: ['rev-parse', '--is-inside-work-tree'], cwd: outside },
      { args: [`--git-dir=${join(outside, '.git')}`, 'rev-parse', '--git-dir'] },
      { args: ['-C', owned, '-C', outside, 'status'] },
      { args: ['-C', outside, '-C', owned, 'status'] },
      { args: ['-C', owned, `--git-dir=${join(outside, '.git')}`, 'status'] },
      { args: [`--git-dir=${join(outside, '.git')}`, '-C', owned, 'status'] },
      { args: ['-C', relative(owned, outside), 'status'], cwd: owned },
      { args: ['-C', '.', 'status'], cwd: outside },
      { args: ['-C', owned, 'status'], cwd: outside },
      { args: ['-C', escape, 'rev-parse', '--is-inside-work-tree'] },
      { args: ['rev-parse', '--is-inside-work-tree'], cwd: escape },
      { args: [`--git-dir=${join(escape, '.git')}`, 'rev-parse', '--git-dir'] },
    ]
    for (const attempt of attempts) {
      await assert.rejects(
        execFileAsync(git, attempt.args, {
          cwd: attempt.cwd,
          env: process.env,
        }),
      )
    }
    const result = await execFileAsync(git, ['-C', '.', 'rev-parse', '--is-inside-work-tree'], {
      cwd: owned,
      env: process.env,
    })
    assert.equal(result.stdout.trim(), 'true')
    const canonical = await execFileAsync(
      git,
      ['-C', realpathSync(owned), 'rev-parse', '--is-inside-work-tree'],
      { env: process.env },
    )
    assert.equal(canonical.stdout.trim(), 'true')
  }
  const run = await startControlled()
  try {
    await check((await run.target.workspace()).path)
  } finally {
    await run.target.cleanup()
  }
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-live-claim-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync(git, ['init', '-b', 'main', root], { stdio: 'ignore' })
  const claim = claimLiveGit(root)
  try {
    await check(root)
  } finally {
    claim.release()
  }
})

/** The environment, in a form two snapshots can be compared as. */
function sortedEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
  )
}
