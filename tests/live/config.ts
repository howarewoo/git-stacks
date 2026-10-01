import { createHash, randomBytes } from 'node:crypto'
import { githubHostContext } from '../../src/main/github-host'

/**
 * The explicit target a live run is pointed at. Nothing here has a default that
 * could reach a repository somebody else owns: a run without an owner, a token,
 * and a run id is refused, because "no target configured" is a fact about the
 * environment that has to be fixed by a person, not something a suite may paper
 * over by skipping.
 */
export interface LiveRunConfig {
  readonly owner: string
  /**
   * The GitHub host every request, every credential and every resource of this run
   * belongs to.
   *
   * It is required rather than defaulted, because it is the one fact a recovery run
   * has to re-establish before it may delete anything: a receipt names a host, and a
   * deletion aimed at a name is aimed at whichever host answers to it at the time.
   */
  readonly host: string
  /**
   * The REST base and GraphQL endpoint this run's credentials are pinned to, derived
   * from the host rather than inherited.
   *
   * The application's transport will otherwise read `GIT_STACKS_GITHUB_API_URL` out
   * of the environment, and it deliberately permits that base to be the origin a
   * supplied token is sent to. On a developer machine, or under a test harness, that
   * variable is often set — and then the first request would carry this run's real
   * disposable-account credential to whatever host the environment named. Naming
   * both endpoints here means the environment cannot widen where a credential goes.
   */
  readonly apiUrl: string
  readonly graphqlUrl: string
  readonly token: string
  /** The second account that can review, when the run was given one. */
  readonly reviewerToken: string | null
  /** Prefix of the disposable repository this run creates and owns. */
  readonly repositoryPrefix: string
  /** Identifies every resource this run creates, and is stamped onto each one. */
  readonly runId: string
  /** Where the cleanup receipt is written, so a failed run is still auditable. */
  readonly receiptPath: string
  /** Secrets that must never reach a log, a report, or an artifact. */
  readonly secrets: readonly string[]
}

export const LIVE_ENV = {
  owner: 'GIT_STACKS_LIVE_GITHUB_OWNER',
  host: 'GIT_STACKS_LIVE_GITHUB_HOST',
  token: 'GIT_STACKS_LIVE_GITHUB_TOKEN',
  reviewerToken: 'GIT_STACKS_LIVE_GITHUB_REVIEWER_TOKEN',
  repositoryPrefix: 'GIT_STACKS_LIVE_GITHUB_REPOSITORY_PREFIX',
  runId: 'GIT_STACKS_LIVE_GITHUB_RUN_ID',
  receipt: 'GIT_STACKS_LIVE_GITHUB_RECEIPT',
} as const

/**
 * Raised when a run is asked for without everything it needs. The message names the
 * variable rather than describing the class of problem, so whoever runs this next
 * knows exactly what to set.
 */
export class LiveConfigurationError extends Error {
  readonly missing: readonly string[]

  constructor(missing: readonly string[]) {
    super(
      `The live GitHub suite needs an authorized target and cannot run without: ${missing.join(', ')}`,
    )
    this.name = 'LiveConfigurationError'
    this.missing = missing
  }
}

/**
 * An owner login, and a host name.
 *
 * The host pattern is deliberately narrow: a name that could carry a scheme, a
 * port, a path or a credential would resolve to an origin nobody meant, and this
 * value decides where a real token is sent.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u

/**
 * Reads the target from the environment, refusing anything ambiguous.
 *
 * A token is never defaulted, never inherited from an ambient `gh` session, and
 * never read from a variable the application itself uses. The suite runs against a
 * disposable repository, and a credential that was not given to it for that
 * purpose is not one it may spend.
 */
export function readLiveRunConfig(env: NodeJS.ProcessEnv = process.env): LiveRunConfig {
  const owner = (env[LIVE_ENV.owner] ?? '').trim()
  const host = (env[LIVE_ENV.host] ?? '').trim().toLowerCase()
  const token = (env[LIVE_ENV.token] ?? '').trim()
  const reviewerToken = (env[LIVE_ENV.reviewerToken] ?? '').trim() || null
  const repositoryPrefix = (env[LIVE_ENV.repositoryPrefix] ?? 'git-stacks-live-e2e').trim()
  const runId = (env[LIVE_ENV.runId] ?? '').trim() || newRunId()
  const receiptPath = (env[LIVE_ENV.receipt] ?? '').trim() || defaultReceiptPath(runId)

  const missing: string[] = []
  if (!OWNER.test(owner)) missing.push(LIVE_ENV.owner)
  if (!HOST.test(host)) missing.push(LIVE_ENV.host)
  if (!token) missing.push(LIVE_ENV.token)
  if (!repositoryPrefix) missing.push(LIVE_ENV.repositoryPrefix)
  if (missing.length > 0) throw new LiveConfigurationError(missing)

  // Both endpoints come from the host, never from the environment. The transport
  // reads its base from `GIT_STACKS_GITHUB_API_URL` when it is not told one, and
  // that variable is set in plenty of places that have nothing to do with this run.
  const context = githubHostContext(host)
  return {
    owner,
    host,
    apiUrl: context.apiBase,
    graphqlUrl: context.graphqlUrl,
    token,
    reviewerToken,
    repositoryPrefix,
    runId,
    receiptPath,
    secrets: reviewerToken ? [token, reviewerToken] : [token],
  }
}

/**
 * A run id that is unique per run and short enough to survive a branch name and a
 * repository name. The digest keeps a runner's own run number out of the name,
 * so two runs of the same workflow number cannot collide on a shared account.
 */
export function newRunId(): string {
  return `r${Date.now().toString(36)}${createHash('sha256')
    .update(randomBytes(8))
    .digest('hex')
    .slice(0, 6)}`
}

/**
 * The marker every resource this run creates carries. Cleanup reads it back before
 * deleting anything, so a run cannot remove a resource it did not make even if a
 * name is reused or a previous run left something behind.
 */
export function ownershipMarker(runId: string): string {
  return `git-stacks-live-e2e:${runId}`
}

function defaultReceiptPath(runId: string): string {
  return `live-github-e2e-receipt-${runId}.json`
}

/** The disposable repository's name. Bounded so a full name fits GitHub's 100 characters. */
export function disposableRepositoryName(prefix: string, runId: string): string {
  return `${prefix}-${runId}`.slice(0, 100)
}
