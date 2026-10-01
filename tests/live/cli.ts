import { writeFile } from 'node:fs/promises'
import { describeThrown, LiveRedactor, renderRunSummary } from './diagnostics'
import { LIVE_ENV, LiveConfigurationError, readLiveRunConfig } from './config'
import { observeSchema, prepareSchemaSubject, renderSchema } from './observed-schema'
import { runLiveSuite, type LiveRunReport } from './runner'
import { findScenario, LIVE_SCENARIOS } from './scenarios'
import { GitHubAdmin } from './github-admin'
import {
  readLiveReceipt,
  recoverLiveResources,
  type RecoveryOutcome,
  type RecoverySurface,
} from './provisioning'
import { NODE_TRANSPORT_VARIABLES, retireNodeTransportBypass } from './git-environment'
import { FaultInjectingTransport } from './transport'
import {
  DirectGitHubTransport,
  setGitHubTransport,
  type GitHubTransport,
} from '../../src/main/github-transport'
import { ControlledLiveTarget, GitHubLiveTarget, LiveProvisioningFailure } from './targets'
import type { LiveCleanupReport, LiveTarget, LiveWorkspace } from './contract'

/**
 * The live suite's command line.
 *
 * Every refusal here is deliberate. There is no default target, no default credential,
 * and no default that lets a run proceed against a repository nobody named. A suite that
 * can be started by accident against somebody's account is not a test suite, it is a
 * hazard with a green checkmark, so the run refuses and says which variable is missing.
 *
 * The controlled target is the one a repository can run without anybody's credentials:
 * it stands the same double up on a real TLS socket and points the production transport
 * at it. The `github` target is only ever started with an explicit owner and token.
 */

export interface CliOptions {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** Injected so a test can run the command without standing a host up. */
  readonly startControlled?: () => Promise<LiveTarget>
  readonly startGitHub?: () => Promise<LiveTarget>
}

/** Exit codes a workflow step can act on without parsing anything. */
export const EXIT_OK = 0
export const EXIT_FAILED = 1
/** The run was refused before it started: no target, no credential, no capability. */
export const EXIT_REFUSED = 2

interface ParsedCommand {
  readonly target: 'controlled' | 'github' | null
  readonly only: readonly string[]
  readonly list: boolean
  readonly help: boolean
  readonly writeSchema: boolean
  readonly schemaPath: string | null
  readonly json: boolean
  /** The receipt a recovery run acts on, or null when this is not a recovery run. */
  readonly recover: string | null
  readonly problem: string | null
}

export function parseCommand(argv: readonly string[]): ParsedCommand {
  let target: ParsedCommand['target'] = null
  const only: string[] = []
  let list = false
  let help = false
  let writeSchema = false
  let schemaPath: string | null = null
  let json = false
  let recover: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--controlled':
        target = 'controlled'
        break
      case '--github':
        target = 'github'
        break
      case '--list':
        list = true
        break
      case '--help':
      case '-h':
        help = true
        break
      case '--json':
        json = true
        break
      case '--only':
        index += 1
        if (index >= argv.length) return refused('--only needs at least one scenario id')
        only.push(
          ...String(argv[index])
            .split(',')
            .filter((id) => id !== ''),
        )
        break
      case '--recover':
        index += 1
        if (index >= argv.length) return refused('--recover needs the path of a cleanup receipt')
        recover = String(argv[index])
        break
      case '--write-schema':
        writeSchema = true
        break
      case '--schema-path':
        index += 1
        if (index >= argv.length) return refused('--schema-path needs a file path')
        schemaPath = String(argv[index])
        break
      default:
        return refused(`unknown argument ${String(argument)}`)
    }
  }
  return { target, only, list, help, writeSchema, schemaPath, json, recover, problem: null }
}

function refused(problem: string): ParsedCommand {
  return {
    target: null,
    only: [],
    list: false,
    help: false,
    writeSchema: false,
    schemaPath: null,
    json: false,
    recover: null,
    problem,
  }
}

const USAGE = `git-stacks live GitHub suite

  tsx tests/live/cli.ts --controlled [--only <id,...>] [--json]
  tsx tests/live/cli.ts --github    [--only <id,...>] [--json]

  --recover <receipt> remove what a killed run left behind, from that receipt alone

  --list              print every scenario and what each one needs, then exit
  --write-schema      regenerate the observed-schema fixture from the target, then exit
  --schema-path <p>   where --write-schema writes (default: the committed fixture)
  --only <id,...>     run only these scenarios

A run must name its target. --github additionally requires:
  ${LIVE_ENV.owner}          the account the disposable repository is created under
  ${LIVE_ENV.token}          a token for that account; never inherited from gh
  ${LIVE_ENV.repositoryPrefix}  the prefix of the disposable repository (optional)
  ${LIVE_ENV.runId}          the run id stamped on everything created (optional)
  ${LIVE_ENV.receipt}        where the cleanup receipt is written (optional)
  ${LIVE_ENV.reviewerToken}  a second account that can approve and reply (optional)

--recover is a different command, not a run: it names no target and creates nothing. It
reads the receipt, uses the credentials supplied now, and removes only handles the
receipt already names, after the host has confirmed both the id this run created and the
marker it stamped. It never lists an account to find something that looks similar.

Exit codes: 0 passed, 1 a scenario or cleanup failed, 2 the run was refused.
`

/**
 * Runs the command line and answers with the exit code a workflow step should use.
 *
 * Refusal and failure are different answers. A refusal means nothing was created and
 * nothing should be retried without changing the environment; a failure means the suite
 * ran and something is wrong that a person has to look at.
 */
export async function runCli(options: CliOptions): Promise<number> {
  const command = parseCommand(options.argv)
  if (command.help) {
    options.out(USAGE)
    return EXIT_OK
  }
  if (command.problem !== null) {
    options.err(command.problem)
    options.err(USAGE)
    return EXIT_REFUSED
  }
  if (command.list) {
    options.out(renderCatalogue())
    return EXIT_OK
  }
  if (command.recover !== null) {
    return await runRecovery(command.recover, options)
  }
  if (command.target === null) {
    options.err(
      'A live run must name its target. Pass --controlled for the runtime in this repository, ' +
        'or --github for an authorized disposable repository. There is no default: an unstated ' +
        'target is a fact about the environment that only a person can settle.',
    )
    return EXIT_REFUSED
  }
  for (const id of command.only) {
    if (findScenario(id) === undefined) {
      options.err(`No scenario is registered under ${id}. Run with --list to see the catalogue.`)
      return EXIT_REFUSED
    }
  }

  const redactor = new LiveRedactor(readSecrets(options.env))
  let target: LiveTarget
  try {
    target =
      command.target === 'controlled'
        ? await (options.startControlled ?? defaultControlled)()
        : await (options.startGitHub ?? defaultGitHub)(options.env)
  } catch (error) {
    if (error instanceof LiveConfigurationError) {
      options.err(redactor.text(error.message))
      return EXIT_REFUSED
    }
    // A provisioning failure is not a refusal. It means the run created something and
    // could not finish, and the report it carries is the only thing that says what is
    // still standing. Reporting it as a refusal told an operator that nothing had been
    // created while their account was holding a private repository with this run's
    // marker in its description.
    if (error instanceof LiveProvisioningFailure) {
      options.err(redactor.text(`the target could not be started: ${error.message}`))
      for (const entry of error.report.refused) {
        options.err(redactor.text(`  refused ${entry.handle}: ${entry.reason}`))
      }
      if (error.report.remaining.length > 0) {
        options.err(
          redactor.text(
            `${error.report.remaining.length} resource(s) are still on the host: ${error.report.remaining.join(', ')}`,
          ),
        )
        options.err(redactor.text(`Recover them with:`))
        options.err(redactor.text(`  ${recoveryCommand(error.receipt)}`))
        options.err(
          redactor.text(
            `  which is ${LIVE_ENV.host}=<the host named in that receipt> and ` +
              `${LIVE_ENV.token}=<a token for the account that created them>.`,
          ),
        )
      }
      return EXIT_FAILED
    }
    options.err(redactor.text(`the target could not be started: ${describeThrown(error)}`))
    return EXIT_REFUSED
  }

  // Everything from here on is inside this guard. A run that starts a target and then
  // fails on its way to a verdict has still provisioned a repository on somebody's
  // account, and the only thing standing between a failed run and a leftover is this
  // finally. The cleanup result is reported rather than thrown so a startup failure is
  // not lost behind the cleanup that follows it, and a cleanup that itself fails does
  // not replace the reason the run stopped.
  let exit = EXIT_FAILED
  try {
    if (command.writeSchema) {
      const rendered = await writeObservedSchema(
        target,
        await target.workspace(),
        command.schemaPath,
      )
      options.out(redactor.text(rendered))
      exit = EXIT_OK
    } else {
      const report = await runLiveSuite({
        target,
        redactor,
        only: command.only,
        onResult: (result) => {
          options.out(
            redactor.text(
              `${result.outcome === 'passed' ? 'pass' : 'FAIL'} ${result.id} (${result.durationMs}ms)`,
            ),
          )
          for (const line of result.failure?.exchanges ?? [])
            options.err(redactor.text(`    ${line}`))
        },
      })
      options.out('')
      options.out(redactor.text(report.summary))
      exit = report.passed ? EXIT_OK : EXIT_FAILED
      if (command.json) options.out(redactor.text(JSON.stringify(report, null, 2)))
    }
  } catch (error) {
    options.err(redactor.text(`the run did not finish: ${describeThrown(error)}`))
    exit = EXIT_FAILED
  }

  // The report is emitted after cleanup so the lines below describe what was actually
  // removed rather than what was still there a moment ago.
  const cleanup = await settle(target, redactor)
  if (!cleanup.complete) {
    options.err(
      redactor.text(
        `cleanup left ${cleanup.remaining.length} resource(s) behind; the receipt is at ${target.receipt}`,
      ),
    )
    for (const entry of cleanup.refused) {
      options.err(redactor.text(`  refused ${entry.handle}: ${entry.reason}`))
    }
    exit = EXIT_FAILED
  }
  return exit
}

/**
 * Removes what a killed run left behind, from its receipt and nothing else.
 *
 * The credential is supplied now, not inherited. A run that died cannot have left a
 * process environment behind for this command to read, and a recovery command that
 * accepted whatever happened to be in `gh`'s configuration would be acting as somebody
 * other than the person who asked for it — which is the one mistake this whole
 * mechanism exists to prevent.
 *
 * The receipt has to name the host too, and the host this command is pointed at has to
 * be that one. A receipt written by a run against a different host describes names that
 * mean nothing here, and a recovery run that deleted whatever answered to them would be
 * deleting on this account what the receipt was about elsewhere.
 */
async function runRecovery(receiptPath: string, options: CliOptions): Promise<number> {
  const redactor = new LiveRedactor(readSecrets(options.env))
  let receipt
  try {
    receipt = await readLiveReceipt(receiptPath)
  } catch (error) {
    options.err(redactor.text(describeThrown(error)))
    return EXIT_REFUSED
  }
  const host = String(options.env[LIVE_ENV.host] ?? '').trim()
  if (host === '') {
    options.err(
      redactor.text(
        `A recovery run has to be told which host. Set ${LIVE_ENV.host} to the host the receipt ` +
          `names (${receipt.host}).`,
      ),
    )
    return EXIT_REFUSED
  }
  if (host.toLowerCase() !== receipt.host.toLowerCase()) {
    options.err(
      redactor.text(
        `The receipt at ${receiptPath} is for ${receipt.host}, and this run was pointed at ${host}. ` +
          'Nothing was removed.',
      ),
    )
    return EXIT_REFUSED
  }

  const surfaces = new Map<string, RecoverySurface>()
  const transports: GitHubTransport[] = []
  const primaryToken = String(options.env[LIVE_ENV.token] ?? '').trim()
  const reviewerToken = String(options.env[LIVE_ENV.reviewerToken] ?? '').trim()
  if (primaryToken === '') {
    options.err(
      `A recovery run deletes repositories, so it has to be told a credential. Set ` +
        `${LIVE_ENV.token} to a token for an account this receipt names as the actor that ` +
        'created something. Nothing was removed.',
    )
    return EXIT_REFUSED
  }

  // The accounts this run has to be able to act as are the ones the receipt recorded
  // creating things — not the owner. Those are frequently different people: a run is
  // pointed at an organization, and an organization's repositories are created by a user
  // account acting for it, so demanding that the credential be the organization would
  // refuse the exact run that most needs recovering.
  const actors = new Set<string>()
  for (const entry of receipt.resources) {
    if (typeof entry.actor === 'string' && entry.actor !== '') actors.add(entry.actor.toLowerCase())
  }
  if (actors.size === 0) actors.add(receipt.owner.toLowerCase())

  // Everything from here makes an authenticated request over a socket this process
  // opens, so everything from here is inside the `finally` that takes the process back
  // the way it was found.
  //
  // The retirement happens against the real `process.env`, not against a copy of it.
  // That is the whole substance of it: `DirectGitHubTransport` resolves its base URL
  // and its credential from the environment it is handed, but the socket it then opens
  // is `fetch` in this process, and Node reads `NODE_TLS_REJECT_UNAUTHORIZED` from
  // `process.env` at connection time. Handing the transport a sanitized copy therefore
  // changed which host was derived, and left the certificate decision exactly as
  // unverified as it had been — with an authorization header on the request. This runs
  // before the first transport exists, not after, because a bypass is read when the
  // connection opens: removing it once a credential is already on the wire protects
  // nothing. `retireNodeTransportBypass` captures the prior values rather than assuming
  // them, so an absent variable is restored as absent and a process that had `0` gets
  // `0` back.
  const nodeTransport = retireNodeTransportBypass()
  let outcome: RecoveryOutcome | undefined
  try {
    // No global transport, and none restored afterwards. Everything this command does
    // is handed its surface explicitly, so installing one into the process would put a
    // live credential where the whole application can reach it — and taking it away
    // afterwards would remove whatever was installed before this command ran rather than
    // put that back. A credential that belongs to one deletion never has to be global.
    const primary = pinnedTransport(host, primaryToken)
    transports.push(primary)

    const who = async (transport: GitHubTransport): Promise<string> => {
      try {
        return await new GitHubAdmin(transport, receipt.owner, receipt.marker).viewer()
      } catch (error) {
        // Redacted where it is built, not where it is printed: the detail is a host's own
        // words about a request that carried a credential, and this refusal can travel
        // further than the one print site that would have redacted it.
        throw new RecoveryRefusal(
          redactor.text(
            `The credential supplied could not be asked who it belongs to: ${describeThrown(error)}`,
          ),
        )
      }
    }

    const primaryLogin = await who(primary)
    if (!actors.has(primaryLogin.toLowerCase())) {
      options.err(
        redactor.text(
          `This receipt records ${[...actors].join(', ')} as the account${actors.size === 1 ? '' : 's'} ` +
            `that created what it names, and the credential supplied belongs to ${primaryLogin}. ` +
            'Nothing was removed.',
        ),
      )
      return EXIT_REFUSED
    }
    surfaces.set(primaryLogin, new GitHubAdmin(primary, receipt.owner, receipt.marker))

    if (reviewerToken !== '') {
      const reviewer = new DirectGitHubTransport({
        token: reviewerToken,
        host,
        apiUrl: host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`,
        graphqlUrl:
          host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`,
        env: sanitizedEnv(options.env),
      })
      transports.push(reviewer)
      const login = await who(reviewer)
      // Refused before anything is deleted rather than after: a reviewer credential
      // that turns out to be the primary account was supplied by mistake, and a
      // recovery that deleted under it while believing two accounts had checked is
      // worse than one that declined.
      if (login.toLowerCase() === primaryLogin.toLowerCase()) {
        options.err(
          redactor.text(
            `The reviewer credential also belongs to ${login}, so there is only one account ` +
              'here and not the two a run needs. Nothing was removed.',
          ),
        )
        return EXIT_REFUSED
      }
      surfaces.set(login, new GitHubAdmin(reviewer, receipt.owner, receipt.marker))
    }

    outcome = await recoverLiveResources({
      receipt,
      surfaces,
      primaryLogin,
    })
  } catch (error) {
    if (error instanceof RecoveryRefusal) {
      options.err(redactor.text(`${error.message}. Nothing was removed.`))
      return EXIT_REFUSED
    }
    throw error
  } finally {
    // Restored on the refusal path, on the failure path, and on the path that reports a
    // result — not only where a request happened to succeed. A process left with a
    // certificate bypass it did not start with is a process that will authenticate to
    // whatever it is next asked to talk to.
    nodeTransport.restore()
  }
  options.out(redactor.text(renderRecovery(outcome)))
  return outcome.complete ? EXIT_OK : EXIT_FAILED
}

/** A refusal this command can report as a refusal rather than as a crash. */
class RecoveryRefusal extends Error {}

/**
 * A recovery invocation that would actually work if it were pasted.
 *
 * The parser takes `--recover <path>` and nothing else, so a printed `--host` would be
 * refused by the very command it tells a person to run — and the host and the credential
 * are the two things a recovery cannot go without, so a command line without them is not
 * a recovery at all. They are named as the environment they are rather than as flags they
 * are not, and the path is quoted because a receipt reaches a temporary directory.
 */
function recoveryCommand(receiptPath: string): string {
  const quoted = /^[-A-Za-z0-9_./:@=]+$/.test(receiptPath)
    ? receiptPath
    : `'${receiptPath.replace(/'/g, `'\\''`)}'`
  return `npx tsx tests/live/cli.ts --recover ${quoted}`
}

/** What a recovery run removed, and everything it did not, in a form a person reads. */
function renderRecovery(outcome: RecoveryOutcome): string {
  const lines = [`recovery for run ${outcome.runId}:`]
  for (const handle of outcome.removed) lines.push(`  removed ${handle}`)
  for (const handle of outcome.absent) lines.push(`  already gone ${handle}`)
  for (const entry of outcome.refused) lines.push(`  refused ${entry.handle}: ${entry.reason}`)
  for (const handle of outcome.unknown) {
    lines.push(`  unknown ${handle}: the host could not be asked, so nothing was decided about it`)
  }
  lines.push(
    outcome.complete
      ? 'nothing from this receipt is left standing'
      : 'some of this receipt is still standing; the refusals above say which and why',
  )
  return lines.join('\n')
}

/**
 * The environment a recovery credential is allowed to see.
 *
 * The API base is taken out of it entirely. The application's transport deliberately
 * permits an environment-configured base to be where a supplied credential is sent, so
 * leaving a variable like this one in place would let a machine configured for local
 * development decide which host a recovery credential authenticates against.
 *
 * This is what the transport derives an endpoint and a credential from. It is NOT what
 * governs whether a certificate is checked: the request goes out over `fetch` in this
 * process, and Node reads that switch from `process.env` when it opens the connection.
 * A copy handed to a transport cannot reach it, which is why the process itself is
 * retired before the first request rather than by anything in here. The two are kept
 * separate on purpose — this function must not be read as evidence that the socket
 * verified anything.
 */
function sanitizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  delete clean.GIT_STACKS_GITHUB_API_URL
  delete clean.GH_TOKEN
  delete clean.GITHUB_TOKEN
  delete clean.GIT_STACKS_GITHUB_TOKEN
  // Still removed here, and still for a different reason than the one above: the
  // transport hands this environment to the children it spawns, and a child that
  // inherited an extra authority would trust it.
  for (const name of NODE_TRANSPORT_VARIABLES) delete clean[name]
  return clean
}

/** A credential pinned to the host the receipt names, never to anything in the environment. */
function pinnedTransport(host: string, token: string): GitHubTransport {
  if (token.trim() === '') {
    throw new Error(
      `A recovery run needs ${LIVE_ENV.token}. It cannot inherit a credential from gh or from the ` +
        'environment of a process that no longer exists.',
    )
  }
  return new FaultInjectingTransport(
    new DirectGitHubTransport({
      token,
      host,
      apiUrl: host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`,
      graphqlUrl:
        host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`,
      env: sanitizedEnv(process.env),
    }),
  )
}

/** Cleanup that reports instead of throwing, so the receipt is always printed. */
async function settle(target: LiveTarget, redactor: LiveRedactor): Promise<LiveCleanupReport> {
  try {
    return await target.cleanup()
  } catch (error) {
    return {
      removed: [],
      refused: [{ handle: target.runId, reason: redactor.text(describeThrown(error)) }],
      remaining: [target.marker],
      complete: false,
    }
  }
}

/** Every scenario, its title, and what it needs, so `--only` can be chosen honestly. */
export function renderCatalogue(): string {
  const lines = ['live GitHub scenarios:']
  for (const scenario of LIVE_SCENARIOS) {
    const requires = scenario.requires.length > 0 ? scenario.requires.join(', ') : 'nothing'
    lines.push(`  ${scenario.id}`, `      ${scenario.title}`, `      requires: ${requires}`)
  }
  return lines.join('\n')
}

/**
 * Regenerates the observed-schema fixture from whatever the target actually answers.
 *
 * The document holds paths and types only: no values, no repository name, no identifier.
 * A response body is never committed, because the file is published as a reviewable
 * artifact and a token-shaped value in it would outlive the run that wrote it.
 */
async function writeObservedSchema(
  target: LiveTarget,
  workspace: LiveWorkspace,
  schemaPath: string | null,
): Promise<string> {
  const subject = await prepareSchemaSubject({
    target,
    workspace,
    // The branch the repository really has, as the host reported it. A literal here
    // would quietly mis-document the fixture on any host whose default is named
    // something else.
    defaultBranch: target.defaultBranch,
  })
  const observed = await observeSchema(target.transport(), subject, `${target.kind} runtime`)
  const path = schemaPath ?? committedSchemaPath()
  await writeFile(path, renderSchema(observed), 'utf8')
  // The probe's branches, pull requests, review, and stack live inside the disposable
  // repository this run owns, so the repository's own deletion takes them with it.
  // Deleting them one at a time would leave the same end state through more calls.
  return `wrote the observed schema to ${path}`
}

function committedSchemaPath(): string {
  return new URL('../fixtures/live-github-observed-schema.json', import.meta.url).pathname
}

async function defaultControlled(): Promise<LiveTarget> {
  return ControlledLiveTarget.start()
}

async function defaultGitHub(env: NodeJS.ProcessEnv): Promise<LiveTarget> {
  return GitHubLiveTarget.start(readLiveRunConfig(env))
}

/** The secrets of this run, read the same way for every command. */
function readSecrets(env: NodeJS.ProcessEnv): string[] {
  const secrets = [env[LIVE_ENV.token], env[LIVE_ENV.reviewerToken]]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
  return [...new Set(secrets)]
}

export type { LiveRunReport }
export { renderRunSummary }

// The module is a command, not a library, when it is run directly. Importing it — which
// the behavioural tests do — has no side effects at all.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
}
