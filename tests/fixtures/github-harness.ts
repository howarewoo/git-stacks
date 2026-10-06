import { randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  execFileSync as execFileSyncFunction,
  ChildProcess,
  ExecFileOptions,
} from 'node:child_process'

import { repositoryIdentity } from './github-rest'

/** The repository role GitHub decides what an account may do from. */
export type GitHubFixtureRole = 'admin' | 'maintain' | 'push' | 'triage' | 'pull'

/** Whether a role includes writing to the repository, which GitHub decides the same way. */
export const WRITING_ROLES: Record<GitHubFixtureRole, boolean> = {
  admin: true,
  maintain: true,
  push: true,
  triage: false,
  pull: false,
}

/**
 * One account this host knows, and the credential that authenticates it.
 *
 * The token is minted by this run and is only ever compared against the fixture state, so
 * a request signed with a real credential is refused rather than served, and two accounts
 * are two genuinely different identities on the wire rather than one login behind a flag.
 */
export interface GitHubFixtureActor {
  login: string
  token: string
  /** The OAuth scopes the credential carries, which the host reports per request. */
  scopes: string[]
  type: 'User' | 'Organization'
  /** Organizations this account administers, which is what creates a repository for one. */
  organizations?: string[]
}

/** A collaborator invitation, which grants its role only once it is accepted. */
export interface GitHubFixtureInvitation {
  id: number
  repository: string
  login: string
  permission: GitHubFixtureRole
  state: 'pending' | 'accepted'
}

/**
 * The pull request, review and rule set state of exactly one repository.
 *
 * Number spaces, reviews and rules are per repository on GitHub, so a second repository is
 * not another view of the first one's state: it is a separate slice with its own counters,
 * and the same number can name unrelated pull requests in each.
 */
export interface GitHubFixtureRepositoryState {
  prs: GitHubFixturePullRequest[]
  comments: Record<string, GitHubFixtureComment[]>
  stacks?: GitHubFixtureStack[]
  issues?: Array<{
    number: number
    title: string
    url: string
    state: 'OPEN' | 'CLOSED'
    repository?: string
  }>
  reviews?: Record<string, FixtureReview[]>
  reviewThreads?: Record<string, FixtureThread[]>
  nextNumber?: number
  nextCommentId?: number
  nextStackNumber?: number
  nextReviewId?: number
  nextThreadId?: number
  ruleSets?: FixtureRuleSet[]
  nextRuleSetId?: number
  checks?: GitHubFixtureChecks
  /** The legacy queue switch: a merge queue this fixture is serving on its base branch. */
  mergeQueue?: boolean
  mergeQueueRefs?: string[]
  mergeQueueMembers?: Record<string, { position: number; state: string; enqueuedAt: string }>
  mergeQueueFields?:
    | 'refused'
    | 'absent'
    | 'malformed'
    | 'entry'
    | 'state'
    | 'date'
    | 'no-head'
    | 'no-base'
  /**
   * Releases a group the queue has just accepted, so the enqueue answer stays terminal while
   * the membership is gone by the time the run reads it back.
   */
  mergeQueueEjects?: boolean
  asyncMerge?: {
    number: number
    sha: string
    method: string
    action: 'default' | 'direct_merge' | 'merge_queue'
    uuid: string
  }
  asyncMergeResult?: { status: 'merged' | 'enqueued' | 'failed'; message?: string }
  asyncMergeStaysPending?: boolean
  asyncMergeAlreadyQueued?: boolean
}

/**
 * A repository this host serves, and the real bare Git repository behind it.
 *
 * Every repository names its own bare repository, so a fork, or a repository that belongs
 * to somebody else entirely, has its own refs, its own objects and its own pull request
 * numbers. Serving those requests out of the default repository would make a foreign pull
 * request indistinguishable from a local one, which is the boundary the negatives exist to
 * prove.
 */
export interface GitHubFixtureRepository {
  fullName: string
  owner: string
  name: string
  bare: string
  private: boolean
  defaultBranch: string
  /** The repository this one was forked from, when it is a fork. */
  forkOf?: string
  description?: string | null
  topics?: string[]
  /** The role each account holds here. */
  permissions: Record<string, GitHubFixtureRole>
  invitations: GitHubFixtureInvitation[]
  pulls: GitHubFixtureRepositoryState
}

const nodeRequire = createRequire(import.meta.url)
const childProcess = nodeRequire('node:child_process') as {
  execFile: ExecFileBoundary
  execFileSync: typeof execFileSyncFunction
}
const gitTransportFixture = nodeRequire('./git-transport.cjs') as GitTransportFixture
const githubCliFixture = nodeRequire('./github-cli.cjs') as GitHubCliFixture

/** The `git` and `gh` this harness answers, and the real Git they delegate to. */
interface ActiveHarness {
  realGit: string
  barePath: string
  confinedRoot: string | null
  statePath: string
  transportLog: string
  overrides: GitOverride[]
  pushHooks: GitPushHook[]
  /**
   * Clone URLs this run's own host serves, registered once the host is up.
   *
   * A controlled run's scenarios ask for the URL its real TLS host answers on, not the
   * apparent `github.com` spelling, so the transport rule has to be told which URLs are
   * this run's rather than inferring it from the shape of the address.
   */
  ownedRemotes: Set<string>
  /**
   * How this run's host spells a repository's clone URL, once it is known.
   *
   * Set by the controlled target as soon as its host answers. The harness cannot derive
   * it — the authority belongs to the host — but it knows which repositories it creates,
   * so it registers each one here rather than leaving a fork's remote unanswerable.
   */
  cloneUrlFor: ((fullName: string) => string) | null
}

type ExecFileDone = (error: Error | null, stdout: string, stderr: string) => void

interface ExecFileBoundary {
  (
    file: string,
    args?: readonly string[],
    options?: ExecFileOptions,
    callback?: ExecFileDone,
  ): ChildProcess
  /**
   * Node's own promisified form of `execFile`. Git Stacks wraps `execFile` with
   * `promisify` when its modules load, and `promisify` hands back this form, so
   * the harness has to carry it to keep answering the commands Git Stacks makes.
   */
  [promisify.custom]: (
    file: string,
    args: readonly string[],
    options?: ExecFileOptions,
  ) => Promise<{ stdout: string; stderr: string }>
}

/**
 * What a real `execFile` call hands back: the promise Git Stacks awaits, plus
 * the child whose stdin it writes the request body to before awaiting.
 */
interface PromiseWithChild<T> extends Promise<T> {
  child: { stdin: { end(chunk: string): void } }
}

interface CommandError extends Error {
  code: number
  stdout: string
  stderr: string
  killed: boolean
  signal: null
  cmd: string
}

interface GitTransportFixture {
  planGitTransport(request: {
    args: string[]
    barePath: string
    logPath: string
    cwd: string
    /**
     * The clone URLs this run's own host serves. An exact match is answered by the host
     * over its own verified connection; anything else is refused, so the rule cannot be
     * widened into "any `https` address".
     */
    ownedRemotes?: readonly string[]
  }): { ok: true; args: string[] } | { ok: false; refused: string }
}

interface GitHubCliFixture {
  runGitHubCli(request: {
    statePath: string
    barePath: string
    realGit: string
    args: string[]
    cwd: string
    input: string
  }): string
}

export interface GitHubFixtureComment {
  id: number
  body: string
  user?: { login: string }
  author?: string
}

export interface GitHubFixturePullRequest {
  number: number
  title: string
  body: string
  base: string
  head: string
  headRepository: string
  draft: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  checks: 'none' | 'passing' | 'pending' | 'failing'
  reviewDecision: string | null
  mergeState: string | null
  url: string
  headOid: string | null
  mergeOid: string | null
  mergedAt: string | null
  /** The account that opened it, which is what `viewerDidAuthor` is decided from. */
  author?: string
}

export interface GitHubFixtureStack {
  id: number
  number: number
  node_id: string
  url: string
  base: { ref: string }
  open: boolean
  created_at: string
  pull_requests: Array<{
    number: number
    state: 'open' | 'closed'
    draft: boolean
    merged_at: string | null
    head: { ref: string; sha: string }
  }>
}

/**
 * The three vocabularies GitHub reports a pull request's CI in, plus the two reads that
 * decide whether a check is required and whether this account may rerun it. Every field
 * is optional so a case states only the part of the answer it is proving.
 */
export interface GitHubFixtureCheckRun {
  id: number
  headSha: string
  checkSuiteId?: number
  name: string
  status: string
  conclusion: string | null
  appSlug?: string | null
  /** The app's id, which is what a required context is bound to. Defaults to 1. */
  appId?: number
  title?: string | null
  detailsUrl?: string | null
  startedAt?: string | null
  completedAt?: string | null
}

export interface GitHubFixtureCommitStatus {
  headSha: string
  context: string
  state: string
  description?: string | null
  targetUrl?: string | null
}

export interface GitHubFixtureWorkflowRun {
  id: number
  headSha: string
  checkSuiteId?: number
  pullRequests?: number[]
  event?: string
  name: string
  status: string
  conclusion: string | null
  runNumber?: number
  startedAt?: string | null
  updatedAt?: string | null
  htmlUrl?: string | null
}

export interface GitHubFixtureChecks {
  checkRuns?: GitHubFixtureCheckRun[]
  commitStatuses?: GitHubFixtureCommitStatus[]
  workflowRuns?: GitHubFixtureWorkflowRun[]
  /**
   * The contexts branch protection requires on `branch`; null means no rule is readable.
   * `appIds` binds a context to the app that must report it, the way GitHub does when a
   * required check belongs to one integration; a context absent from it is unbound.
   */
  requiredStatusChecks?: {
    branch: string
    contexts: string[]
    appIds?: Record<string, number>
  } | null
  /**
   * The active rules GitHub reports for one exact branch, repository and organisation
   * rulesets already matched. `forbidden` models the read GitHub refuses without
   * administration access, which leaves the required set unknown.
   */
  branchRules?: {
    branch: string
    forbidden?: boolean
    workflows?: boolean
    required?: { context: string; integrationId?: number | null }[]
  }
  actionsEnabled?: boolean
  /** The viewer's repository role, as `GET /repos/{o}/{r}` reports it. */
  viewerPermissions?: {
    admin: boolean
    maintain: boolean
    push: boolean
    triage: boolean
    pull: boolean
  } | null
  /** Refuses every workflow rerun, which is what a read-only viewer is answered with. */
  rerunForbidden?: boolean
  /** Workflow run ids the double was asked to rerun, oldest first. */
  reruns?: number[]
  /** Serve ETags and honour `if-none-match`, so conditional reads can be observed. */
  conditional?: boolean
}
export interface GitHubFixtureState {
  version: 1
  repository: {
    owner: string
    name: string
    defaultBranch: string
    allowMergeCommit: boolean
    allowSquashMerge: boolean
    allowRebaseMerge: boolean
    /**
     * Whether the host answers for this repository to one account only.
     *
     * Absent means public, which is what every state written before a disposable
     * run needed to be private describes. A run that has to prove a second account
     * was really let in sets it, because a public repository answers for everybody
     * and would report a grant as working when nothing was ever enforced.
     */
    private?: boolean
    /**
     * What `GET /repos/{owner}/{name}` reports about the repository's own description and
     * topics. A disposable run stamps its ownership marker here, and cleanup reads it back
     * through the same endpoint before it deletes anything.
     */
    description?: string | null
    topics?: string[]
    /**
     * The grants and invitations this repository holds, when a request has made any.
     * A second account is let in by an invitation it accepts, so the host has to keep
     * what the first request granted: the state that is saved is the only place a later
     * request can read the grant from.
     */
    permissions?: Record<string, GitHubFixtureRole>
    invitations?: GitHubFixtureInvitation[]
  }
  currentUser: string
  nextNumber: number
  nextCommentId: number
  nextStackNumber?: number
  stacksPreviewDisabled?: boolean
  /**
   * Stack numbers whose detail read answers 404 while the listing still includes
   * them: what an inconsistent GitHub looks like to a client that has to decide
   * whether a native stack is really gone.
   */
  missingStackDetails?: number[]
  /** When set, every native-stacks endpoint answers with this error instead of stack data. */
  stacksFailure?: {
    status: number
    reason: string
    message: string
    rateLimitRemaining?: number
  }
  issuesFailure?: {
    status: number
    reason: string
    message: string
  }
  prWriteFailure?: {
    status: number
    reason: string
    message: string
  }
  /**
   * Mutations that succeed on GitHub but whose response never reaches the caller, which is
   * what a dropped connection mid-request looks like to the person waiting. Each entry is
   * consumed once, in order, by the first matching method and path.
   */
  lostResponses?: Array<{
    method: string
    pathIncludes: string
    /**
     * Matches only when the path also ends with this, which is how a collection
     * endpoint is told apart from a member endpoint under the same prefix: a lost
     * `POST /repos/o/r/stacks` is a different event from a lost
     * `POST /repos/o/r/stacks/1/unstack`.
     */
    pathEndsWith?: string
    /**
     * Zero-based occurrence of the matching request, for a path one run reads more
     * than once: the first read that matches is zero.
     */
    after?: number
    status: number
    message: string
    /** Headers the refusal carries, such as the wait a rate limit asks for. */
    headers?: Record<string, string>
  }>
  /**
   * Requests the CLI answers late, which is how a read that was already running
   * when the credential behind this host was replaced lands after the answer that
   * replaced it. Each entry is consumed once, by the first matching request.
   */
  heldResponses?: Array<{
    /** A part of the request argv this answer is limited to, such as its verb. */
    method?: string
    pathIncludes: string
    /** Matches only a request carrying this credential, so the ordering is not a race. */
    credential?: string
    ms: number
    /** The refusal this late answer carries, instead of an ordinary one. */
    refusal?: {
      status: number
      message: string
      retryAfterSeconds?: number
      remaining?: number
    }
  }>
  /**
   * Branch refs moved by somebody else while a request is in flight, applied by the double
   * before it answers the first matching request. This is the window a client cannot close
   * with one read: the value changes between two reads that both looked consistent.
   */
  /**
   * Branch refs moved by somebody else while a request is in flight, applied by the double
   * before it answers the `after`-th matching request. Zero is the first match, so the rule
   * can target a later read rather than the one that opened the step.
   */
  driftOnRequest?: Array<{
    pathIncludes: string
    ref: string
    to: string
    after?: number
  }>
  /**
   * Pull requests closed by somebody else while a request is in flight, so a change that
   * lands after an earlier step is read still shows up in the next one.
   */
  closeOnRequest?: Array<{ pathIncludes: string; number: number; after?: number }>
  prs: GitHubFixturePullRequest[]
  comments: Record<string, GitHubFixtureComment[]>
  stacks?: GitHubFixtureStack[]
  issues?: Array<{
    number: number
    title: string
    url: string
    state: 'OPEN' | 'CLOSED'
    /** Repository that owns the issue; search results expose it so foreign issues are rejected. */
    repository?: string
  }>
  /** A merge-queue request GitHub accepted for a base ref, which is the only proof of a queue. */
  mergeQueue?: boolean
  /** Base refs a merge queue is configured on, which the live suite probes for. */
  mergeQueueRefs?: string[]
  /**
   * The pull requests a merge queue currently holds, keyed by number, with the entry the host
   * reports for each. A pull request that is absent from this map but open on a queued base is
   * a pull request the queue has let go, which is what an ejected request looks like.
   */
  mergeQueueMembers?: Record<string, { position: number; state: string; enqueuedAt: string }>
  /**
   * How this host's schema answers the queue fields: `refused` is a schema without them,
   * `absent` is an answer whose payload omits them, and `malformed` is one that carries
   * values of the wrong shape. All three are reads a client cannot answer membership from.
   * `entry` answers membership truthfully and the entry with values no queue can hold.
   */
  mergeQueueFields?:
    | 'refused'
    | 'absent'
    | 'malformed'
    | 'entry'
    | 'state'
    | 'date'
    | 'no-head'
    | 'no-base'
  /**
   * Releases a group the queue has just accepted, so the enqueue answer stays terminal while
   * the membership is gone by the time the run reads it back.
   */
  mergeQueueEjects?: boolean
  /**
   * The terminal result a pending asynchronous merge reports when its poll is read, so a test
   * can stand in for a queue that accepted, or refused, the group.
   */
  asyncMergeResult?: { status: 'merged' | 'enqueued' | 'failed'; message?: string }
  /**
   * Keeps an accepted request `pending` on every read, standing in for a merge GitHub is still
   * running. Cleared again to let that same request report its result.
   */
  asyncMergeStaysPending?: boolean
  /**
   * Answers a queued merge request with the documented immediate `200` instead of a `202`:
   * the pull request is already in the queue, so the result is terminal and carries no
   * request UUID to poll.
   */
  asyncMergeAlreadyQueued?: boolean
  asyncMerge?: {
    number: number
    sha: string
    method: string
    action: 'default' | 'direct_merge' | 'merge_queue'
    uuid: string
  }
  checks?: GitHubFixtureChecks
  /**
   * Review threads, keyed by pull request number, and the reviews that opened them.
   * The live end-to-end suite needs a real conversation to reply to and resolve; a
   * fixture state without these fields behaves exactly as it did before.
   */
  reviewThreads?: Record<string, FixtureThread[]>
  reviews?: Record<string, FixtureReview[]>
  nextThreadId?: number
  nextReviewId?: number
  /** Branch rulesets, which is how a required check or approval gates a merge here. */
  ruleSets?: FixtureRuleSet[]
  nextRuleSetId?: number
  /**
   * Every account this run minted a credential for. The host resolves the token a request
   * carried to exactly one of these logins and refuses anything else, so two accounts are
   * two real identities on the wire and a real credential never authenticates here. A
   * state without this list is answered by the two accounts the harness has always had.
   */
  actors?: GitHubFixtureActor[]
  /**
   * Every repository this host serves besides the one the harness created first. Each is
   * backed by its own real bare repository, and the harness repository itself appears here
   * when a test gives it a visibility or a permission map.
   */
  repositories?: GitHubFixtureRepository[]
  nextInvitationId?: number
  requests: Array<{ argv: string[]; cwd: string; at: string; body?: Record<string, unknown> }>
}

/** One review comment inside a thread, as the fixture records it. */
export interface FixtureThreadComment {
  id: string
  body: string
  createdAt: string
  url: string
  viewerDidAuthor: boolean
  author: { login: string }
  /**
   * The review that wrote this comment, or null for a reply, which belongs to no review.
   * GitHub reports it as `pull_request_review_id`, and a lost-write reconciliation groups
   * a review's comments by it.
   */
  reviewId: number | null
}

/** One review thread, addressed by path and side the way GitHub addresses a comment. */
export interface FixtureThread {
  id: string
  path: string
  side: string
  diffSide: string
  line: number | null
  startLine: number | null
  startDiffSide: string | null
  subjectType: string
  isResolved: boolean
  isCollapsed: boolean
  isOutdated: boolean
  viewerCanReply: boolean
  viewerCanResolve: boolean
  viewerCanUnresolve: boolean
  comments: FixtureThreadComment[]
}

/** One submitted review, which is what an approval rule counts. */
export interface FixtureReview {
  id: number
  /** The outcome GitHub recorded, which is not the verb the request carried. */
  state: string
  /** The verb the request carried, kept so the two can be told apart. */
  event: string
  body: string
  commit_id: string
  submitted_at: string
  user: { login: string }
  html_url: string
}

/** A branch rule set, reduced to what a merge of this fixture is actually gated by. */
export interface FixtureRuleSet {
  id: number
  name: string
  enforcement: string
  target?: string
  conditions?: Record<string, unknown>
  /** The rules as they were created, because the detail read returns them verbatim. */
  rules?: Array<Record<string, unknown>>
  queue_rules?: Array<Record<string, unknown>>
  _requiredStatusChecks: string[]
  _requiredApprovals: number
  /** Whether the pull request rule also demands every conversation be resolved. */
  _requiresThreadResolution?: boolean
  created_at?: string
  updated_at?: string
}

/**
 * Answers a Git command Git Stacks would otherwise run for real. `match` sees
 * the arguments after any leading `-C <repository>`, and `run` returns what the
 * command would have written to stdout.
 */
export interface GitOverride {
  match(args: readonly string[]): boolean
  run(args: readonly string[]): string
}

/**
 * Mutates the fixture at the moment Git Stacks publishes `branch`. `before` runs
 * once the push is claimed and before real Git sees it, and `after` runs only
 * once that push has succeeded, which is the window Git Stacks has to notice a
 * concurrently deleted branch, closed pull request, or new pull request.
 */
export interface GitPushHook {
  branch: string
  armed: boolean
  before?(): void
  after?(): void
}

export interface GitHubHarness {
  root: string
  repo: string
  bare: string
  statePath: string
  env: NodeJS.ProcessEnv
  /**
   * Only the variables above that this harness sets, without the process it inherited.
   *
   * `env` is a full snapshot, because the commands it starts need the environment they
   * would have had. Publishing it into a process that has just retired ambient
   * verification switches would put every one of them back, so a caller that installs
   * this host into the process environment takes these keys and no others.
   */
  readonly ownedEnvironment: Readonly<NodeJS.ProcessEnv>
  /**
   * The directory whose `<owner>/<name>.git` subdirectories a host serving Git over HTTP
   * resolves a request path against. Every repository this harness creates is created
   * here, so one host serves the clone, a fork and a foreign repository.
   */
  readonly projectsRoot: string
  /**
   * Teaches the harness how this run's host spells a clone URL, so every repository it
   * creates from here on is registered as it is created.
   *
   * One call rather than a registration per repository: the host owns the spelling and
   * the harness owns the names, and neither can derive the other's. Registering by hand
   * would leave a fork made mid-scenario unregistered, which is how a scenario's own
   * remote comes to be refused by the very rule that exists to protect it.
   */
  serveClonesFor(cloneUrl: (fullName: string) => string): void
  /**
   * Adds an account and mints the only credential that authenticates it. The token is
   * generated for this run, is never a real credential, and is the only one that resolves
   * to this login.
   */
  addActor(input: {
    login: string
    scopes?: string[]
    type?: 'User' | 'Organization'
    organizations?: string[]
  }): Promise<GitHubFixtureActor>
  /**
   * Creates a repository this host serves, with its own real bare repository and its own
   * pull request number space. `forkOf` seeds it from that repository's refs, which is
   * what a fork is: the same history under a different owner.
   */
  createRepository(input: {
    fullName: string
    private?: boolean
    forkOf?: string
    permissions?: Record<string, GitHubFixtureRole>
    defaultBranch?: string
    description?: string | null
    topics?: string[]
  }): Promise<GitHubFixtureRepository>
  /**
   * The credential that authenticates the owner of the primary repository, and the second
   * account the review scenarios need. Both tokens are minted for this run and resolve to
   * exactly the login they name.
   */
  readonly primaryToken: string
  readonly reviewer: { readonly login: string; readonly token: string }
  /**
   * Serves a second repository this run owns, with its own real bare repository under the
   * projects root so a clone and a push over Git reach it. `kind: 'fork'` makes it a fork
   * of the primary repository, seeded from its history and recording the parent.
   */
  provisionForeignSubject(request: {
    kind: 'repository' | 'fork'
    owner: string
    name: string
    marker: string
  }): Promise<{ id: number; fullName: string; owner: string; defaultBranch: string }>
  /** Removes a repository this harness created, its bare directory included. */
  deleteRepository(fullName: string): Promise<boolean>
  /** Installs `override`; later overrides are consulted first. */
  overrideGit(override: GitOverride): void
  /** Installs `hook`, which the test keeps a handle on so it can disarm it. */
  hookGitPush(hook: GitPushHook): void
  /** Runs a Git command against real Git, bypassing the fixture's own answers. */
  runGit(args: string[]): string
  readState(): Promise<GitHubFixtureState>
  writeState(state: GitHubFixtureState): Promise<void>
  close(): Promise<void>
}

/**
 * Resolves the one real Git the fixture delegates to, the way the platform does
 * it, by walking `PATH`. `which` is a POSIX program Windows does not have, and a
 * fixed `/usr/bin/git` names nothing on the other platforms, so the scan honours
 * `PATHEXT` and fails loudly when Git is not installed.
 */
function resolveRealGit(): string {
  const searchPath = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const directory of searchPath) {
    for (const extension of extensions) {
      const candidate = join(directory, `git${extension}`)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
  }
  throw new Error('The GitHub harness needs a real git executable on PATH')
}

const realExecFile = childProcess.execFile
const realPromisifiedExecFile = realExecFile[promisify.custom]
const realExecFileSync = childProcess.execFileSync
let active: ActiveHarness | null = null

/**
 * The live run that owns this process's real `git`, if one does.
 *
 * The interception below is installed by importing this module, which every test in
 * this repository does — including the one that runs against an authorized disposable
 * repository on a real host, which creates no harness. Left there, the boundary has
 * nothing to answer the live run's Git with and refuses it, so the whole live target
 * is unrunnable from its first probe: that is a source fact, not an observed failure.
 *
 * Installing the interception only while a harness exists was the other answer, and it
 * is worse. The product captures `promisify(execFile)` when its own modules load, which
 * the tests deliberately do after importing this fixture, so a patch applied at harness
 * creation is applied too late to be seen by the very code it exists to answer.
 *
 * So the refusal stands and the way past it is explicit, narrow, and owned. A live run
 * claims the real `git` for the directory it created and for as long as it holds that
 * claim. Nothing else reaches the real tool: a `git` outside the claimed root is
 * refused, a `gh` is refused outright whether or not anything is claimed, and a `git`
 * with no claim at all is refused as before. That is what keeps a broken interception
 * from leaving for github.com, and it is deliberately not a claim on the real tools of
 * the whole process — a run that asked for that would be asking for every repository
 * on the machine, which is not what it needs.
 */
let liveGit: { root: string } | null = null

/**
 * Whether a repository path lies inside the root this live run created.
 *
 * Canonical filesystem paths account for platform aliases and symlinks. Comparing
 * descendants at a separator boundary excludes look-alike sibling names.
 */
function insideRoot(root: string, candidate: string): boolean {
  const from = realpathSync(root)
  const to = realpathSync(candidate)
  return to === from || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`)
}

/** Resolves supported Git directory selectors against the child's starting directory. */
function targetDirectories(args: readonly string[], options: ExecFileOptions): string[] {
  if (options.cwd !== undefined && typeof options.cwd !== 'string') {
    throw new Error('a non-string git working directory cannot be checked against a claimed root')
  }
  const cwd = realpathSync(options.cwd ?? process.cwd())
  const directories: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('-')) break
    if (token === '-c' || token === '--config-env') {
      if (args[++index] === undefined) throw new Error('a git configuration option needs a value')
      continue
    }
    let directory: string | undefined
    if (token === '-C' || token === '--git-dir') {
      directory = args[++index]
      if (directory === undefined) throw new Error('a git directory selector needs a value')
    } else if (token.startsWith('--git-dir=')) {
      directory = token.slice('--git-dir='.length)
    } else if (token.startsWith('-C') && token.length > 2) {
      directory = token.slice(2)
    } else if (token === '--work-tree' || token.startsWith('--work-tree=') || token === '--bare') {
      throw new Error(
        'an unsupported git directory selector cannot be checked against a claimed root',
      )
    }
    if (directory !== undefined) {
      directories.push(realpathSync(isAbsolute(directory) ? directory : `${cwd}${sep}${directory}`))
    }
  }
  if (directories.length > 1) {
    throw new Error('a git command with multiple directory selectors is refused')
  }
  return [cwd, ...directories]
}

/**
 * Claims the real `git` for one directory, and answers how to give the claim back.
 *
 * Scoped to the root rather than to the process on purpose: this run pushes from the
 * workspace and the foreign clone it created, and needs nothing else. Refused while a
 * harness is answering, because the two are opposites — one run cannot both own a real
 * host and expect every command in it to be answered by a fixture. Releasing the claim a
 * second time is a no-op rather than an error, so a cleanup that runs twice cannot take
 * it away from a run that still holds it.
 */
export function claimLiveGit(root: string): { release: () => void } {
  if (active !== null) {
    throw new Error('a run cannot use a real git while a GitHub harness is answering them')
  }
  if (liveGit !== null) {
    throw new Error('another live run already owns a real git in this process')
  }
  const owner = { root: resolve(root) }
  liveGit = owner
  return {
    release: () => {
      if (liveGit === owner) liveGit = null
    },
  }
}

function commandError(file: string, args: readonly string[], code: number, stderr: string) {
  const cmd = [file, ...args].join(' ')
  const error = new Error(`Command failed: ${cmd}\n${stderr}`) as CommandError
  error.code = code
  error.stdout = ''
  error.stderr = stderr
  error.killed = false
  error.signal = null
  error.cmd = cmd
  return error
}

function withoutRepository(args: readonly string[]): { repository: string | null; args: string[] } {
  if (args[0] === '-C' && typeof args[1] === 'string') {
    return { repository: args[1], args: args.slice(2) }
  }
  return { repository: null, args: [...args] }
}

function claimedPushHook(harness: ActiveHarness, args: readonly string[]): GitPushHook | null {
  if (!args.includes('push')) return null
  return (
    harness.pushHooks.find(
      (hook) => hook.armed && args.some((arg) => arg.endsWith(`:refs/heads/${hook.branch}`)),
    ) || null
  )
}

function runHookStep(
  hook: GitPushHook | null,
  step: 'before' | 'after',
  file: string,
  argv: readonly string[],
): void {
  try {
    hook?.[step]?.()
  } catch (error) {
    throw commandError(file, argv, 1, error instanceof Error ? error.message : String(error))
  }
}

function commandName(file: string): string {
  return basename(file)
    .replace(/\.exe$/iu, '')
    .toLowerCase()
}

async function runGitFixture(
  harness: ActiveHarness,
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const argv = [...args]
  // A confined run supplies the child's default context, never the ambient checkout.
  // Explicit cwd values remain authoritative and must pass confinement below.
  if (harness.confinedRoot !== null && options.cwd === undefined) {
    options = { ...options, cwd: harness.confinedRoot }
  }
  if (harness.confinedRoot !== null) {
    try {
      const root = harness.confinedRoot
      const directories = targetDirectories(argv, options)
      if (!directories.every((directory) => insideRoot(root, directory))) {
        throw new Error('the git command acts outside the controlled run root')
      }
    } catch (error) {
      throw commandError(
        file,
        argv,
        2,
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
  const { args: rest } = withoutRepository(argv)
  const override = harness.overrides.find((entry) => entry.match(rest))
  if (override) return { stdout: override.run(rest), stderr: '' }
  const hook = claimedPushHook(harness, argv)
  runHookStep(hook, 'before', file, argv)
  const plan = gitTransportFixture.planGitTransport({
    args: argv,
    barePath: harness.barePath,
    logPath: harness.transportLog,
    cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
    ownedRemotes: [...harness.ownedRemotes],
  })
  if (!plan.ok) throw commandError(file, argv, 2, `${plan.refused}\n`)
  const command = plan.args
  const result = await realPromisifiedExecFile(harness.realGit, command, options)
  runHookStep(hook, 'after', file, argv)
  return result
}

/**
 * Answers a `gh` request, and answers it only once the caller has finished
 * writing the request body. The `gh` transport runs `child.child.stdin?.end(input)`
 * and only then awaits the call, so the body reaches the fixture through a
 * deferred promise instead of the stdin it would have been written to.
 */
/**
 * Answers one request late, which is how a read that was already running when the
 * credential behind this host was replaced lands after the answer that replaced
 * it. The rule names the credential it holds, so the two reads are ordered by
 * which account is asked rather than by how fast a process happened to start.
 * The wait is the host's, not the test's: this is the only place in the fixture
 * that lets one answer overtake another. A rule may answer with a refusal
 * instead, printed as the envelope a real `gh` prints on an HTTP error and
 * exited non-zero, so a rate limit this run's own host names is read from the
 * child rather than from the state that asked for it.
 */
async function holdResponse(
  harness: ActiveHarness,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ refusal: string } | null> {
  const state = JSON.parse(await readFile(harness.statePath, 'utf8')) as GitHubFixtureState
  const held = (state.heldResponses ?? []).findIndex((rule) => {
    if (!args.join(' ').includes(rule.pathIncludes)) return false
    if (rule.method !== undefined && !args.join(' ').includes(rule.method)) return false
    if (rule.credential === undefined) return true
    const env = options.env ?? {}
    const credential = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null
    return credential === rule.credential
  })
  if (held === -1) return null
  const [rule] = (state.heldResponses ?? []).splice(held, 1)
  const temporary = `${harness.statePath}.${process.pid}.hold.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, harness.statePath)
  await new Promise((resolve) => {
    setTimeout(resolve, rule?.ms ?? 0)
  })
  const refusal = rule?.refusal
  if (!refusal) return null
  return {
    refusal: [
      `HTTP/2 ${refusal.status} ${refusal.status === 429 ? 'Too Many Requests' : 'Error'}`,
      'x-ratelimit-limit: 5000',
      `x-ratelimit-remaining: ${refusal.remaining ?? 0}`,
      `x-ratelimit-reset: ${Math.floor(Date.now() / 1000) + 3600}`,
      ...(refusal.retryAfterSeconds === undefined
        ? []
        : [`retry-after: ${refusal.retryAfterSeconds}`]),
      '',
      JSON.stringify({ message: refusal.message }),
    ].join('\r\n'),
  }
}

function runGhFixture(
  harness: ActiveHarness,
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): PromiseWithChild<{ stdout: string; stderr: string }> {
  let input = ''
  const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    queueMicrotask(() => {
      const answer = async (): Promise<void> => {
        try {
          const heldAnswer = await holdResponse(harness, args, options)
          if (heldAnswer !== null) {
            // A refusal the host named: the child prints the envelope and exits
            // as it would on an HTTP error, so the transport reads the wait from
            // the answer rather than being told about it.
            const refused = commandError(file, args, 1, '')
            refused.stdout = heldAnswer.refusal
            reject(refused)
            return
          }
          resolve({
            stdout: githubCliFixture.runGitHubCli({
              statePath: harness.statePath,
              barePath: harness.barePath,
              realGit: harness.realGit,
              args: [...args],
              cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
              input,
            }),
            stderr: '',
          })
        } catch (error) {
          const code = (error as { code?: unknown }).code
          reject(
            commandError(
              file,
              args,
              typeof code === 'number' ? code : 2,
              `${error instanceof Error ? error.message : String(error)}\n`,
            ),
          )
        }
      }
      void answer()
    })
  })
  return Object.assign(result, {
    child: {
      stdin: {
        end(chunk: string) {
          input += chunk
        },
      },
    },
  })
}

function runFixtureCommand(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const harness = active
  const command = commandName(file)
  if (command === 'git' || command === 'gh') {
    // A `git` or `gh` request that reaches this boundary without a harness to answer it
    // is a request for the real tools. Running it for real is how an interception failure
    // reaches github.com instead of failing, so the fixture refuses it and says why.
    if (!harness) {
      // The one request that is meant to reach the real tool: a live run's own `git`, in
      // the directory that run created. Anything else is refused, including a `gh` —
      // nothing in the live path shells out to one, since the API surface is reached
      // through an explicit transport, and a claim that let `gh` through would be a claim
      // on the installed credential tooling that no caller needs.
      if (command === 'git' && liveGit !== null) {
        if (options.cwd === undefined) options = { ...options, cwd: liveGit.root }
        let directories: string[]
        try {
          directories = targetDirectories(args, options)
        } catch (error) {
          return Promise.reject(
            commandError(
              file,
              args,
              2,
              `${error instanceof Error ? error.message : String(error)}\n`,
            ),
          )
        }
        if (directories.every((directory) => insideRoot(liveGit?.root ?? '', directory))) {
          return realPromisifiedExecFile(file, args, options)
        }
        return Promise.reject(
          commandError(
            file,
            args,
            2,
            `a live run claimed a real git for ${liveGit.root}, and ${directories.join(', ')} is not inside it\n`,
          ),
        )
      }
      return Promise.reject(
        commandError(file, args, 2, `the GitHub fixture has no harness to answer ${command}\n`),
      )
    }
    return command === 'git'
      ? runGitFixture(harness, file, args, options)
      : runGhFixture(harness, file, args, options)
  }
  return realPromisifiedExecFile(file, args, options)
}

childProcess.execFile = Object.assign(
  function execFileWithGitHubFixture(
    file: string,
    args?: readonly string[],
    options?: ExecFileOptions,
    callback?: ExecFileDone,
  ): ChildProcess {
    if (typeof callback === 'function') {
      const command = commandName(file)
      // A `gh` or `git` request that bypasses the promisified boundary would reach the
      // real tools, so it fails here instead of answering from the wrong process. The
      // same refusal applies with no harness at all, because that is the shape an
      // interception failure takes, and it is the case this branch used to fall
      // straight through to the real `execFile`.
      //
      // `gh` is refused outright: nothing in the live path reaches for it, so there is
      // no request on this boundary that ought to be let past. A `git` is let past only
      // inside the directory a live run claimed — measured the same way the promisified
      // boundary measures it, including refusing a command this cannot evaluate rather
      // than guessing at it.
      let passes = command === 'git' && liveGit !== null
      if (passes && options?.cwd === undefined) {
        options = { ...options, cwd: liveGit?.root }
      }
      if (passes) {
        try {
          passes = targetDirectories(args ?? [], options ?? {}).every((directory) =>
            insideRoot(liveGit?.root ?? '', directory),
          )
        } catch {
          passes = false
        }
      }
      if (!passes) {
        throw new Error(
          `The GitHub harness answers ${file} only through the promisified execFile boundary`,
        )
      }
      return realExecFile(file, args, options, callback)
    }
    return realExecFile(file, args, options)
  },
  { [promisify.custom]: runFixtureCommand },
)

// Node snapshots a builtin's named exports into its ESM facade the first time anything
// imports it. A module that imported `execFile` before this patch therefore keeps the real
// one, and every `git` it runs would leave the fixture for github.com. This call copies the
// patched CommonJS exports back onto the facade, so an import that already happened still
// sees the fixture's boundary. It is the supported way to do that, and it has to follow the
// assignment above and precede any restoration.
syncBuiltinESMExports()

async function runRealGit(
  realGit: string,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await realPromisifiedExecFile(realGit, args, {
    cwd,
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return String(result.stdout || '').trim()
}

async function runBareGit(realGit: string, bare: string, args: string[]): Promise<string> {
  return runRealGit(realGit, process.cwd(), ['--git-dir', bare, ...args])
}

/**
 * Creates one bare repository this host serves, and gives it real history.
 *
 * A served repository is a real Git repository rather than a projection of the default
 * one: a fork is seeded by fetching the parent's refs, and a repository nobody forked is
 * given its own baseline commit, so both have a default branch with a commit on it and a
 * pull request against it is a comparison of two real commits. The API double calls this
 * too, because a fork created through `POST /repos/{o}/{n}/forks` has to be as real as one
 * a test asked for directly.
 */
export function createServedBareRepository(input: {
  git: string
  bare: string
  defaultBranch: string
  forkOf?: string
  seed?: boolean
}): void {
  const git = (args: string[], stdin?: string) =>
    realExecFileSync(input.git, ['--git-dir', input.bare, ...args], {
      encoding: 'utf8',
      input: stdin ?? '',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'GitHub Fixture',
        GIT_AUTHOR_EMAIL: 'github-fixture@example.invalid',
        GIT_COMMITTER_NAME: 'GitHub Fixture',
        GIT_COMMITTER_EMAIL: 'github-fixture@example.invalid',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    }).trim()
  realExecFileSync(input.git, ['init', '--bare', input.bare], { encoding: 'utf8' })
  git(['config', 'user.name', 'GitHub Fixture'])
  git(['config', 'user.email', 'github-fixture@example.invalid'])
  if (input.forkOf) {
    // A fork carries the history it was made from, so its objects are the parent's until
    // somebody pushes to it. Fetching the parent's refs is what makes a pull request from
    // a fork a comparison across two repositories rather than a fabricated one.
    git(['fetch', '--no-tags', input.forkOf, '+refs/*:refs/*'])
  } else if (input.seed !== false) {
    const blob = git(['hash-object', '-w', '--stdin'], 'served repository baseline\n')
    const tree = git(['mktree'], `100644 blob ${blob}\tbase.txt\n`)
    const commit = git(['commit-tree', tree, '-m', 'Served repository baseline'])
    git(['update-ref', `refs/heads/${input.defaultBranch}`, commit])
  }
  git(['symbolic-ref', 'HEAD', `refs/heads/${input.defaultBranch}`])
}

/** A credential minted for one account of this run. */
function newActorToken(): string {
  return `fixture-${randomUUID()}`
}

const initialState = (defaultBranch: string): GitHubFixtureState => ({
  version: 1,
  repository: {
    owner: 'acme',
    name: 'widgets',
    // The host's own default, and the only place it is decided. A run reads this back
    // out of what the host reports rather than assuming a name, so a controlled host that
    // is configured for anything other than `main` exercises the same path a real one
    // with that setting would.
    defaultBranch,
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: true,
  },
  currentUser: 'fixture-user',
  nextNumber: 1,
  nextCommentId: 1,
  nextStackNumber: 1,
  prs: [],
  comments: {},
  stacks: [],
  issues: [],
  actors: initialActors('fixture-user'),
  requests: [],
})

/**
 * The two accounts the harness has always had.
 *
 * Their tokens are fixture credentials scoped to this run's state file, never real ones,
 * and they exist so every test written before accounts were registered keeps the same two
 * identities: the owner that pushes, and the reviewer that approves and replies.
 */
const initialActors = (currentUser: string): GitHubFixtureActor[] => [
  {
    login: currentUser,
    token: 'fixture-token',
    scopes: ['repo', 'workflow'],
    type: 'User',
  },
  {
    login: 'reviewer',
    token: 'fixture-reviewer-token',
    scopes: ['repo'],
    type: 'User',
  },
]

export interface GitHubHarnessOptions {
  /**
   * Where the bare repository is created, relative to the harness root. A host that
   * serves Git over HTTP resolves a request path against a projects directory, so a run
   * that needs the bare repository to be reachable as `/<owner>/<name>.git` names that
   * layout here rather than moving the repository afterwards. The default is what every
   * other test in this repository expects.
   */
  readonly barePath?: string
  /**
   * The directory this harness works in, when the caller has already made one.
   *
   * The harness creates its own by default, and that is right for a test that only
   * needs somewhere to put a bare repository. It is not right for a run that has to
   * establish a boundary *before* the first Git command: the harness runs real Git to
   * create and seed that repository, and a caller that installs its Git isolation
   * afterwards has nothing to point the isolation's home directory at, because the
   * directory did not exist yet. Naming it here lets the caller own it, install on it,
   * and remove it whatever happens to this harness.
   *
   * A caller-supplied root is still this harness's to fill in and to remove on close.
   */
  readonly root?: string
  /** The branch this host treats as the repository's default, as a real host's setting. */
  readonly defaultBranch?: string
  /** Whether to keep the root directory when closing the harness. */
  readonly preserveRoot?: boolean
  /** Opts a controlled live run into Git directory confinement; ordinary fixtures remain unrestricted. */
  readonly confineGitToRoot?: boolean
}

export async function createGitHubHarness(
  options: GitHubHarnessOptions = {},
): Promise<GitHubHarness> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'git-stacks-github-harness-')))
  const defaultBranch = options.defaultBranch ?? 'main'
  const repo = join(root, 'repo')
  const bare = join(root, options.barePath ?? 'remote.git')
  const statePath = join(root, 'github-state.json')
  const transportLog = join(root, 'git-transport.jsonl')
  const realGit = resolveRealGit()
  let isClosed = false
  try {
    await mkdir(repo)
    await writeFile(
      statePath,
      `${JSON.stringify(initialState(options.defaultBranch ?? 'main'), null, 2)}\n`,
      'utf8',
    )
    await writeFile(transportLog, '', 'utf8')
    await mkdir(dirname(bare), { recursive: true })
    await runRealGit(realGit, root, ['init', '--bare', bare])
    await runBareGit(realGit, bare, ['config', 'user.name', 'GitHub Fixture'])
    await runBareGit(realGit, bare, ['config', 'user.email', 'github-fixture@example.invalid'])
    await runRealGit(realGit, repo, ['init', '-b', defaultBranch])
    await runRealGit(realGit, repo, ['config', 'user.name', 'Git Stacks GitHub fixture'])
    await runRealGit(realGit, repo, [
      'config',
      'user.email',
      'git-stacks-github-fixture@example.invalid',
    ])
    await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8')
    await runRealGit(realGit, repo, ['add', '--', 'base.txt'])
    await runRealGit(realGit, repo, ['commit', '-m', 'Fixture baseline'])
    await runRealGit(realGit, repo, [
      'push',
      bare,
      `refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`,
    ])
    await runBareGit(realGit, bare, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`])
    await runRealGit(realGit, repo, [
      'remote',
      'add',
      'origin',
      'https://github.com/acme/widgets.git',
    ])
    await runRealGit(realGit, repo, [
      'remote',
      'set-url',
      '--push',
      'origin',
      'https://github.com/acme/widgets.git',
    ])
    await runRealGit(realGit, repo, [
      'fetch',
      bare,
      `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
    ])
    await runRealGit(realGit, repo, [
      'branch',
      '--set-upstream-to',
      `origin/${defaultBranch}`,
      defaultBranch,
    ])
    await runRealGit(realGit, repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      `refs/remotes/origin/${defaultBranch}`,
    ])

    const fixture: ActiveHarness = {
      realGit,
      barePath: bare,
      confinedRoot: options.confineGitToRoot === true ? resolve(root) : null,
      statePath,
      transportLog,
      overrides: [],
      pushHooks: [],
      ownedRemotes: new Set<string>(),
      cloneUrlFor: null,
    }
    active = fixture

    // The API double and the transport log read the fixture through the
    // environment, because they are loaded as plain modules the test process
    // imports rather than as the intercepted `gh` and `git` commands.
    const ownedEnvironment: NodeJS.ProcessEnv = {
      GIT_STACKS_FIXTURE_ROOT: root,
      GIT_STACKS_FIXTURE_STATE: statePath,
      GIT_STACKS_FIXTURE_BARE: bare,
      GIT_STACKS_REAL_GIT: realGit,
      GIT_STACKS_TRANSPORT_LOG: transportLog,
      GH_HOST: 'github.com',
      GH_TOKEN: 'fixture-token',
      GH_REPO: 'acme/widgets',
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...ownedEnvironment }
    // The directory a host serving `/<owner>/<name>.git` resolves against. It is two
    // levels above the primary repository's bare, because the primary already sits
    // inside an owner directory: taking only the parent would put every repository
    // created afterwards one level too deep, where the host is not serving anything,
    // and a Git request for one of them would be answered by the API instead of by a
    // protocol. The double derives the same directory from the path it is given.
    const projectsRoot = join(root, dirname(dirname(options.barePath ?? 'remote/acme/widgets.git')))

    const readFixtureState = async (): Promise<GitHubFixtureState> =>
      JSON.parse(await readFile(statePath, 'utf8')) as GitHubFixtureState
    const writeFixtureState = async (state: GitHubFixtureState): Promise<void> => {
      const temporary = `${statePath}.${process.pid}.write.tmp`
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, statePath)
    }
    const registryOf = (state: GitHubFixtureState): GitHubFixtureRepository[] =>
      (state.repositories ??= [])
    // The two principals every controlled run has, and the credentials that authenticate
    // them: the account that owns the primary repository, and the account that reviews
    // other people's pull requests. These are the accounts this harness has always served,
    // so a run that already drives them keeps its meaning, and they are two identities on
    // the wire rather than one login behind a flag.
    const primaryName = (state: GitHubFixtureState): string =>
      `${state.repository.owner}/${state.repository.name}`
    const principals = initialActors('fixture-user')
    const owner = principals.find((entry) => entry.login === principals[0]?.login)
    if (!owner) throw new Error('the fixture must register an owner account')
    const reviewer = principals[1]
    if (!reviewer) throw new Error('the fixture must register a reviewer account')

    const harness: GitHubHarness = {
      root,
      repo,
      bare,
      statePath,
      projectsRoot,
      env,
      ownedEnvironment,
      serveClonesFor(cloneUrl) {
        fixture.cloneUrlFor = cloneUrl
        // The primary repository predates this harness and is never created through it, so
        // `createRepository` does not register it. Its name is read off the bare the host
        // serves it from — the way the host itself resolves the path — rather than off a
        // configured spelling that could disagree with what is actually on disk.
        const served = relative(projectsRoot, bare).replace(/\.git$/u, '')
        fixture.ownedRemotes.add(cloneUrl(served))
      },
      overrideGit(override) {
        fixture.overrides.unshift(override)
      },
      hookGitPush(hook) {
        fixture.pushHooks.push(hook)
      },
      runGit(args) {
        return realExecFileSync(realGit, args, {
          encoding: 'utf8',
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim()
      },
      primaryToken: owner.token,
      reviewer: { login: reviewer.login, token: reviewer.token },
      async provisionForeignSubject(request) {
        const fullName = `${request.owner}/${request.name}`
        const state = await readFixtureState()
        const served = await harness.createRepository({
          fullName,
          ...(request.kind === 'fork' ? { forkOf: primaryName(state) } : {}),
          description: request.marker,
          // Private, always. A public repository answers for every account that asks,
          // so a push to it would succeed whether or not the account pushing had been
          // given anything — and a controlled run that reported "the reviewer can reach
          // its own fork" on a public fork would be reporting that the host is permissive,
          // not that the run proved anything about credentials.
          private: true,
        })
        return {
          id: repositoryIdentity(served.fullName),
          fullName: served.fullName,
          owner: served.owner,
          defaultBranch: served.defaultBranch,
        }
      },
      readState: readFixtureState,
      writeState: writeFixtureState,
      async addActor(input) {
        const state = await readFixtureState()
        const existing = (state.actors ??= initialActors(state.currentUser)).find(
          (actor) => actor.login === input.login,
        )
        if (existing) return existing
        const actor: GitHubFixtureActor = {
          login: input.login,
          token: newActorToken(),
          scopes: input.scopes ?? ['repo'],
          type: input.type ?? 'User',
          ...(input.organizations ? { organizations: input.organizations } : {}),
        }
        state.actors.push(actor)
        await writeFixtureState(state)
        return actor
      },
      async createRepository(input) {
        const state = await readFixtureState()
        const registry = registryOf(state)
        const existing = registry.find(
          (entry) => entry.fullName.toLowerCase() === input.fullName.toLowerCase(),
        )
        if (existing) return existing
        const separator = input.fullName.indexOf('/')
        if (separator < 1) throw new Error(`a repository needs an owner: ${input.fullName}`)
        const owner = input.fullName.slice(0, separator)
        const name = input.fullName.slice(separator + 1)
        const primaryFullName = `${state.repository.owner}/${state.repository.name}`
        const isPrimary = input.fullName.toLowerCase() === primaryFullName.toLowerCase()
        const defaultBranch = input.defaultBranch ?? state.repository.defaultBranch
        const barePath = isPrimary ? bare : join(projectsRoot, `${input.fullName}.git`)
        // The primary repository is the one entry that is never in the registry: it was
        // created before this harness existed and is served from its own bare, which is
        // the same resolution the API double makes when it is asked about it. Without
        // that fallback a fork of the repository under test cannot be created at all.
        const forkOfBare = input.forkOf
          ? (registry.find((entry) => entry.fullName.toLowerCase() === input.forkOf?.toLowerCase())
              ?.bare ??
            (input.forkOf.toLowerCase() === primaryFullName.toLowerCase() ? bare : undefined))
          : undefined
        if (input.forkOf && !forkOfBare) {
          throw new Error(`a fork needs a served repository to fork: ${input.forkOf}`)
        }
        if (!isPrimary) {
          await mkdir(dirname(barePath), { recursive: true })
          createServedBareRepository({
            git: realGit,
            bare: barePath,
            defaultBranch,
            ...(forkOfBare ? { forkOf: forkOfBare } : {}),
          })
        }
        const repository: GitHubFixtureRepository = {
          fullName: input.fullName,
          owner,
          name,
          bare: barePath,
          private: input.private ?? false,
          defaultBranch,
          ...(input.forkOf ? { forkOf: input.forkOf } : {}),
          description: input.description ?? null,
          topics: input.topics ?? [],
          permissions: input.permissions ?? { [owner]: 'admin' },
          invitations: [],
          pulls: { prs: [], comments: {}, stacks: [], issues: [], nextNumber: 1, nextCommentId: 1 },
        }
        registry.push(repository)
        // A fork or a foreign subject is served from this run's own host, so its clone
        // URL is this run's own too. Registered here, where the repository exists and
        // its name is settled, and as that one exact URL — so nothing else on this host
        // becomes answerable by association with a repository created here.
        if (fixture.cloneUrlFor !== null) {
          fixture.ownedRemotes.add(fixture.cloneUrlFor(input.fullName))
        }
        await writeFixtureState(state)
        return repository
      },
      async deleteRepository(fullName) {
        const state = await readFixtureState()
        const registry = registryOf(state)
        const index = registry.findIndex(
          (entry) => entry.fullName.toLowerCase() === fullName.toLowerCase(),
        )
        if (index === -1) return false
        const [removed] = registry.splice(index, 1)
        await writeFixtureState(state)
        if (removed.bare !== bare) await rm(removed.bare, { recursive: true, force: true })
        return true
      },
      async close() {
        if (isClosed) return
        isClosed = true
        if (active?.statePath === statePath) active = null
        // A retry is not belt and braces: a file the fixture writes while the tree is
        // being removed is reported as ENOTEMPTY unless the removal is allowed to try
        // again, and a run that failed while deleting its own scratch space is not a run
        // whose cleanup result means anything.
        if (options.preserveRoot !== true) {
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        }
      },
    }
    return harness
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
