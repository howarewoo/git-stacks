import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Agent as HttpsAgent, request as HttpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHubHarness } from '../fixtures/github-harness'
import { startControlledGitHubHost } from '../fixtures/live-github-tls'
import { describeThrown, LiveRedactor, renderRunSummary } from './diagnostics'
import { LIVE_ENV, LiveConfigurationError, ownershipMarker, readLiveRunConfig } from './config'
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
  GitHubTransportError,
  setGitHubTransport,
  type GitHubTransport,
} from '../../src/main/github-transport'
import {
  authorizeGitFor,
  ControlledLiveTarget,
  GitHubLiveTarget,
  LiveProvisioningFailure,
  newRunSuffix,
} from './targets'
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
  /**
   * The explicit trust bundle a controlled recovery host uses.
   *
   * This is trust material, not a connection. It says which certificates are acceptable;
   * it says nothing about how the request is made, who pools the socket, or whether an
   * earlier one can be reused. The recovery path always opens its own connection and
   * always closes it — see `createVerifiedRecoveryConnection`.
   *
   * A host whose certificate chains to a public root needs nothing here, which is the
   * ordinary case for an operator recovering a real repository. A host serving a
   * certificate this machine legitimately holds the authority for is the case this
   * exists for, so such a recovery can be exercised against a real TLS host instead of
   * only described.
   */
  readonly recoveryTrust?: { readonly ca?: string }
}

/** A connection a recovery run owns for the length of the recovery, and closes itself. */
interface OwnedRecoveryConnection {
  readonly fetch: typeof globalThis.fetch
  readonly close: () => Promise<void>
}

/**
 * A recovery run's own connection to its host, and the only kind it will use.
 *
 * The reason this exists rather than reusing `fetch` is precisely the reason the
 * recovery path retires the process's certificate switches. `fetch` in this process is
 * one global pool: sockets it opened earlier — while a bypass was in force, or against a
 * different authority — stay in it, and a request that reuses one inherits that
 * connection's trust decision. A recovery credential is the most dangerous thing this
 * suite sends anywhere, so it is sent over a connection that shares nothing: its own
 * agent, no keep-alive, and therefore a new TLS handshake for every request, verified
 * each time.
 *
 * Verification is required. An explicit `ca` replaces Node's default trust
 * bundle; without one, Node uses its normal roots. Closing destroys this run's
 * own agent rather than sharing sockets with the process's global pool.
 */
function createVerifiedRecoveryConnection(trust: { ca?: string }): OwnedRecoveryConnection {
  const agent = new HttpsAgent({
    // No reuse. Every request negotiates its own certificate, so no socket opened before
    // this recovery — or by anything else in this process — can carry a credential on a
    // decision this run did not make.
    keepAlive: false,
    maxSockets: 1,
    ...(trust.ca === undefined ? {} : { ca: trust.ca }),
  })
  return {
    // Async because the body has to be in hand before a socket is opened: a streaming
    // body cannot be handed to a Node request that expects bytes, and the only callers
    // here send a JSON document, so buffering is exact rather than an approximation.
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (url.protocol !== 'https:') {
        throw new Error(`a recovery run only speaks TLS, and this one is ${url.protocol}`)
      }
      const body = request.body === null ? null : Buffer.from(await request.arrayBuffer())
      return new Promise<Response>((resolve, reject) => {
        const outbound = HttpsRequest(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port === '' ? 443 : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: request.method,
            agent,
            headers: Object.fromEntries(request.headers.entries()),
            rejectUnauthorized: true,
            // SNI is the hostname, and only when it is a name: an address is verified
            // against the certificate's own subject alternative names instead, and
            // naming an address here is refused by the TLS layer rather than ignored.
            ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
            ...(trust.ca === undefined ? {} : { ca: trust.ca }),
          },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () => {
              const status = response.statusCode ?? 502
              const received = Buffer.concat(chunks)
              // 204 and 304 are defined to carry no body, and `Response` refuses to be
              // constructed with one rather than dropping it — so a deletion, which is
              // the one request this connection exists to make, would fail in the
              // transport that was built to carry it. Passed as `null`, never as an empty
              // buffer, because an empty buffer is a body and these statuses allow none.
              const nullBody = status === 204 || status === 205 || status === 304
              resolve(
                new Response(nullBody ? null : received, {
                  status,
                  statusText: response.statusMessage ?? '',
                  headers: response.headers as Record<string, string>,
                }),
              )
            })
          },
        )
        outbound.on('error', reject)
        request.signal.addEventListener('abort', () => outbound.destroy(request.signal.reason))
        if (body !== null) outbound.write(body)
        outbound.end()
      })
    },
    // `destroy` takes no callback on this runtime; the promise is resolved by hand once
    // the sockets are gone.
    close: () =>
      new Promise<void>((done) => {
        agent.destroy()
        done()
      }),
  }
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
  // The connection this recovery makes every request over. It is opened here, before
  // any transport exists, and closed in the `finally` below on every path — the
  // refusal, the failure, and the one that reports a result.
  //
  // It is its own rather than this process's `fetch` because that is one global pool.
  // A socket sitting in it was opened under whatever trust decision was in force then —
  // possibly a bypass, possibly a different authority — and reusing one carries that
  // decision into a request that now carries a deletion credential. A recovery has no
  // pooled connection to inherit, so it makes none: its own agent, no keep-alive, a new
  // handshake per request. The process's own switches are still retired above, because
  // they are read from `process.env` when any connection opens and the agent alone is
  // not what they govern.
  const connection = createVerifiedRecoveryConnection(options.recoveryTrust ?? {})
  let outcome: RecoveryOutcome | undefined
  try {
    // No global transport, and none restored afterwards. Everything this command does
    // is handed its surface explicitly, so installing one into the process would put a
    // live credential where the whole application can reach it — and taking it away
    // afterwards would remove whatever was installed before this command ran rather than
    // put that back. A credential that belongs to one deletion never has to be global.
    const primary = pinnedTransport(host, primaryToken, connection.fetch)
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
    // The identity check above is on the folded login, so the key the surface is stored
    // under is folded too. A receipt recording `Alice` and a host answering `alice` are
    // one account, and storing the surface under the host's spelling while every entry is
    // dispatched on the receipt's is how a run holding exactly the right credential
    // refuses every resource that account owns.
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
    surfaces.set(
      primaryLogin.toLowerCase(),
      new GitHubAdmin(primary, receipt.owner, receipt.marker),
    )

    if (reviewerToken !== '') {
      const reviewer = new DirectGitHubTransport({
        token: reviewerToken,
        host,
        apiUrl: host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`,
        graphqlUrl:
          host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`,
        env: sanitizedEnv(options.env),
        // The same connection as the primary's, and for the same reason: a second one
        // would be a second trust decision about the same host, made separately from
        // the first, and the reviewer credential would be the one that proved nothing.
        fetch: connection.fetch,
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
      surfaces.set(login.toLowerCase(), new GitHubAdmin(reviewer, receipt.owner, receipt.marker))
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
    // The connection is destroyed before anything else, and on every path out of here:
    // the refusal, the failure, and the one that reports what it removed. An agent with
    // no keep-alive holds no idle socket, but destroying it is what releases anything a
    // request in flight left behind, and doing it before the process switches are put
    // back means no connection of this run's is still able to open while a bypass is
    // being retired.
    await connection.close().catch(() => undefined)
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

/**
 * Installs named variables into the process environment, and answers how to put it back.
 *
 * The fixture's API double is a plain module loaded by the host, so it reads its state
 * from `process.env` at request time rather than from anything a caller hands down. A key
 * that was absent before is deleted again on restore rather than set to `undefined`, so a
 * reader testing `'key' in process.env` gets the same answer it would have had.
 */
function installOwnedKeys(
  target: NodeJS.ProcessEnv,
  owned: Readonly<NodeJS.ProcessEnv>,
): () => void {
  const prior = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(owned)) {
    if (value === undefined) continue
    prior.set(key, target[key])
    target[key] = value
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete target[key]
      else target[key] = value
    }
  }
}

/**
 * A credential pinned to the host the receipt names, never to anything in the environment.
 *
 * `connect` is the connection the request goes out over, and it is part of what this
 * function decides rather than something the transport looks up: the recovery path hands
 * its surface a verified boundary explicitly rather than sharing the process's, so a
 * credential for this host cannot travel over a connection some other part of the
 * process opened and left in a pool.
 */
function pinnedTransport(
  host: string,
  token: string,
  connect: typeof globalThis.fetch,
): GitHubTransport {
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
      fetch: connect,
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

/**
 * Whether the host still has a repository at this name, answered by the host or not at
 * all.
 *
 * There are exactly two answers this can give, and the difference between them is the
 * whole point of the check. A 404 from a request this connection authenticated is the
 * host saying the name holds nothing. Anything else that rejects — a 500, a timeout, a
 * certificate this connection will not accept, a credential the host refused — is the
 * host not having answered, which is not the same statement and must not be reported as
 * one.
 *
 * Collapsing them is how a broken recovery gets certified. The read is the only thing
 * standing between "the command said it removed the repository" and "the repository is
 * gone", and a read that fails for any reason whatsoever is precisely what a recovery
 * that did not work looks like from the outside — so it throws, and the harness fails
 * rather than passing.
 */
async function readWhetherRepositoryRemains(
  admin: GitHubAdmin,
  fullName: string,
): Promise<boolean> {
  try {
    await admin.readRepository(fullName)
    return true
  } catch (error) {
    if (
      error instanceof GitHubTransportError &&
      (error.status === 404 || error.kind === 'not-found')
    ) {
      return false
    }
    throw new Error(
      `the host could not be asked whether it still holds ${fullName}, so whether the ` +
        `recovery removed it is unknown rather than proven: ${describeThrown(error)}`,
    )
  }
}

/**
 * A recovery run against a real TLS host, end to end, for whoever needs to see one work.
 *
 * This stands the controlled host, gives it a repository carrying this run's marker,
 * writes the receipt a killed run would have left behind, and then runs the actual
 * `--recover` command over it — the same parser, the same refusal paths, the same
 * production transport — and hands it only the authority this host's certificate
 * chains to.
 *
 * The connection is not handed over. The recovery opens its own, over its own agent,
 * with a fresh verified handshake per request and a shutdown it owns, which is the same
 * path an operator recovering a real repository takes. Only the authority is supplied,
 * because only the authority is something a host can legitimately tell a caller it
 * trusts — so what this exercises is the default mechanism rather than a route that
 * exists only for this test. A request that went anywhere else, or over a connection
 * that trusted anything, would fail rather than be believed.
 *
 * The result answers the two questions that matter separately: what the command
 * returned, and whether the repository is still standing afterwards. The second is read
 * back over its own verified connection before the host is closed, so "it reported
 * success" and "it removed what it named" cannot be confused.
 *
 * The read only answers when the host answers. A 404 is the host saying the repository
 * is gone; a read that fails for any other reason is this harness failing, and it throws
 * rather than reporting the repository as removed — an unanswerable question is not an
 * affirmative one, and a harness that cannot tell the difference certifies recoveries
 * that did not work.
 */
export async function runRecoveryAgainstControlledHost(input: {
  readonly receiptPath?: string
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}): Promise<{
  readonly code: number
  readonly repository: string
  readonly stillPresent: boolean
}> {
  const runId = `controlled-recovery-${newRunSuffix()}`
  const marker = ownershipMarker(runId)
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-live-recovery-'))
  const failures: unknown[] = []
  try {
    const harness = await createGitHubHarness({
      barePath: 'projects/acme/widgets.git',
      root,
      preserveRoot: true,
    })
    const server = await startControlledGitHubHost({
      projectsRoot: harness.projectsRoot,
      git: harness.env.GIT_STACKS_REAL_GIT as string,
      authorizeGit: (fullName, authorization) => authorizeGitFor(harness, fullName, authorization),
    })
    // The controlled host's API is a plain module, so it reads this fixture through the
    // *process* environment at request time rather than through anything handed down.
    // Installed for every request this function makes — the read that builds the receipt,
    // the recovery, and the read-back — rather than around the recovery alone, because the
    // first of those three is the one that fails without it.
    //
    // Only the keys this harness owns are installed. Its `env` is a full snapshot of the
    // process, and publishing that would put every ambient verification switch back for
    // as long as the host is up. Prior values are captured and restored rather than
    // deleted, so a process that already had one of these keys keeps it afterwards.
    const restoreFixtureEnv = installOwnedKeys(process.env, harness.ownedEnvironment)
    try {
      const state = await harness.readState()
      // The subject is a repository this host created and registered, not the harness's
      // own primary. The primary is served from a bare the fixture predates and is never
      // in the host's registry, so the host refuses to delete it — which would make this
      // a test of a refusal, not of the recovery. A created repository is deletable
      // through the same documented route a real one is, so what the recovery does to it
      // is what a recovery does.
      const fullName = `${state.repository.owner}/recovery-subject`
      await harness.createRepository({
        fullName,
        description: `Live suite recovery subject\n\n${marker}\n`,
        topics: ['git-stacks-live-e2e', `run-${runId}`],
        // Granted to the login that will act, which is not the owner segment: a role is
        // held by an account, and a grant recorded against a name that is not one leaves
        // the repository invisible to the very credential meant to delete it — a 404,
        // which is also what a host answers for a repository that does not exist.
        permissions: { [state.currentUser]: 'admin' },
      })
      // The connection this function owns is closed on every path out of this block,
      // including the one where the recovery itself throws, because an unclosed agent
      // keeps its sockets and a leaked handle is invisible until the process is killed.
      const certificate = await readFile(server.certificatePath, 'utf8')
      const connection = createVerifiedRecoveryConnection({ ca: certificate })
      try {
        const admin = new GitHubAdmin(
          new DirectGitHubTransport({
            token: harness.primaryToken,
            host: server.host,
            apiUrl: server.url,
            graphqlUrl: `${server.url}/graphql`,
            env: sanitizedEnv(process.env),
            fetch: connection.fetch,
          }),
          fullName,
          marker,
        )
        // The identity the receipt records is the host's own. A killed run records what
        // the host told it, and a field this suite invented for the fixture would prove
        // nothing about the match a real receipt relies on.
        const identity = await admin.readRepository(fullName)
        if (typeof identity.id !== 'number') {
          throw new Error(
            `the controlled host did not name an id for ${fullName}, so no receipt can ` +
              'be written that a recovery could check the repository against',
          )
        }
        const receiptPath = input.receiptPath ?? join(root, 'live-github-e2e-receipt.json')
        await writeFile(
          receiptPath,
          JSON.stringify(
            {
              // The version a recovery refuses to act without, and the moment the receipt
              // was written. A receipt missing either is not one this suite's own reader
              // would accept, so writing one here without them would exercise a refusal
              // rather than the recovery.
              version: 2,
              runId,
              marker,
              host: server.host,
              owner: state.currentUser,
              writtenAt: new Date().toISOString(),
              resources: [
                {
                  kind: 'repository',
                  handle: fullName,
                  marker,
                  createdAt: new Date().toISOString(),
                  actor: state.currentUser,
                  remoteId: identity.id,
                },
              ],
            },
            null,
            2,
          ),
          'utf8',
        )
        // The connection is not handed over: the recovery opens its own, exactly as it
        // does against a public host, and the only thing this host contributes is the
        // authority its certificate chains to. So what is exercised here is the real
        // path — a fresh handshake per request, verified, closed by the run — rather than
        // a route that exists only for this test.
        const code = await runCli({
          argv: ['--recover', receiptPath],
          env: {
            ...process.env,
            [LIVE_ENV.host]: server.host,
            [LIVE_ENV.token]: harness.primaryToken,
          },
          out: input.out,
          err: input.err,
          recoveryTrust: { ca: certificate },
        })
        // Read back over the same verified connection, so what this reports is the host's
        // own answer rather than anything the receipt already claimed.
        const stillPresent = await readWhetherRepositoryRemains(admin, fullName)
        return { code, repository: fullName, stillPresent }
      } finally {
        await connection.close().catch((cause: unknown) => {
          failures.push(cause)
        })
      }
    } finally {
      // Put back before the host is shut down rather than after, and independently of
      // whether either close below throws: these keys describe a fixture that is going
      // away, and a process still holding them would have every later request point at a
      // directory that no longer answers. Synchronous, so it cannot be skipped by an
      // earlier failure the way an awaited close can be.
      restoreFixtureEnv()
      await server.close().catch((cause: unknown) => {
        failures.push(cause)
      })
      await harness.close().catch((cause: unknown) => {
        failures.push(cause)
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch((cause: unknown) => {
      failures.push(cause)
    })
    if (failures.length > 0) {
      throw new Error(
        `the controlled recovery host was not fully released: ${failures
          .map((cause) => describeThrown(cause))
          .join('; ')}`,
      )
    }
  }
}

export type { LiveRunReport }
export { renderRunSummary }

// The module is a command, not a library, when it is run directly. Importing it — which
// the behavioural tests do — has no side effects at all.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  void runCli({
    argv: process.argv.slice(2),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).then((code) => {
    process.exitCode = code
  })
}
