import type { GitHubHostContext } from '../../src/main/github-host'
import type { GitHubErrorKind, GitHubTransport } from '../../src/main/github-transport'

/**
 * The contract every live GitHub target satisfies, whether it is the controlled
 * runtime this repository runs in CI or an authorized disposable repository on
 * github.com.
 *
 * The scenarios never construct a GitHub client. They receive the production
 * transport, a real local clone, and an admin surface for the resources the app
 * itself never creates, and everything they assert on is something the app's own
 * read path returns. A target that cannot supply one of these is not a weaker
 * target, it is an unusable one, and the runner says so instead of skipping.
 */
export interface LiveTarget {
  readonly kind: 'controlled' | 'github'
  /** The id stamped on every resource this run creates, and matched on at cleanup. */
  readonly runId: string
  /** Where this run's cleanup receipt is written, so a failed run is still auditable. */
  readonly receipt: string
  /** The ownership marker stamped on every resource this run creates. */
  readonly marker: string
  readonly host: GitHubHostContext
  /** The production transport bound to that host, faults and all. */
  transport(): GitHubTransport
  /** The production transport, with the fault injector exposed. */
  faults(): FaultInjectingHandle
  /** The disposable repository every scenario works in, as `owner/name`. */
  repository(): string
  /** A local clone whose `origin` is the disposable repository. */
  workspace(): Promise<LiveWorkspace>
  /** Resources this run owns, and the proof it may delete them. */
  readonly resources: LiveResources
  /** The admin surface the app has no equivalent of. */
  readonly admin: LiveAdmin
  /** What this target can actually be asked to do. */
  probeCapabilities(): Promise<LiveCapabilities>
  /** A second account that can review, when the target was given one. */
  readonly reviewer: LiveReviewer | null
  /** Removes every resource this run created. Safe to call more than once. */
  cleanup(): Promise<LiveCleanupReport>
}

/** The part of the fault injector a scenario is allowed to drive. */
export interface FaultInjectingHandle {
  loseOnce(match: { method?: string; pathIncludes: string }): void
  refuseOnce(
    match: { method?: string; pathIncludes: string },
    outcome: { status: number; kind: GitHubErrorKind; message: string },
  ): void
  recentExchanges(count?: number): Array<{ method: string; path: string; status: number | string }>
  clearFaults(): void
}

/** A real local clone, driven by the real `git` the application resolves. */
export interface LiveWorkspace {
  /** Absolute path of the clone the application services are pointed at. */
  readonly path: string
  /** A Git command that stays inside the clone. Anything that reaches the remote is not this. */
  git(args: readonly string[]): string
  /**
   * A Git command that may reach the remote, and so has to yield the event loop.
   *
   * A controlled run serves both its Git and its API from this process, so a Git
   * command that blocks this one is waiting for a server that cannot answer until the
   * command returns. Every fetch, push, and clone therefore goes through here, and
   * `git` is for the commands that never leave the machine.
   */
  gitNetwork(args: readonly string[]): Promise<string>
  /** Writes, commits, and returns the new head. */
  commit(path: string, contents: string, message: string): Promise<string>
  /** Pushes a branch to `origin` and returns the head the remote now holds. */
  push(branch: string): Promise<string>
  /**
   * A second clone of the same remote, created outside the application.
   *
   * The race scenarios need an actor the application cannot see: one that moves a
   * ref between a preview and its execution without going through any code the
   * app runs. A separate clone on the same machine, using the target's own
   * credentials, is that actor, and it is the only honest way to stage a race
   * against a real host without asking the host to misbehave.
   */
  externalClone(): Promise<LiveWorkspace>
}

/** The second account, when the run was given one. */
export interface LiveReviewer {
  readonly login: string
  /** Its own production transport, so its writes are its own. */
  transport(): GitHubTransport
}

/**
 * Resource kinds a run may own. Cleanup is a function of this list, so a kind
 * that is not here cannot be deleted by a run that did not create it.
 */
export const LIVE_RESOURCE_KINDS = [
  'repository',
  'branch',
  'pull-request',
  'rule-set',
  'check-run',
  'workflow-run',
] as const

export type LiveResourceKind = (typeof LIVE_RESOURCE_KINDS)[number]

/**
 * One resource this run created, with the marker that proves the run owns it.
 *
 * The marker is written into the resource's own description and read back before
 * deletion. A resource whose marker does not match is reported as refused rather
 * than deleted: a run that guessed wrong about ownership must not be able to
 * remove a repository somebody else is using.
 */
export interface LiveResource {
  readonly kind: LiveResourceKind
  /** `owner/name`, `owner/name#number`, or `owner/name/rulesets/1`, per kind. */
  readonly handle: string
  /** The marker this run stamped on the resource when it created it. */
  readonly marker: string
  readonly createdAt: string
  /** Set once the resource is confirmed gone. */
  deletedAt?: string
  /** Why cleanup did not remove it, in words an operator can act on. */
  refused?: string
}

export interface LiveResources {
  /** Every resource this run created, oldest first, whether or not it is gone. */
  list(): readonly LiveResource[]
  /** Records a resource this run just created. */
  record(resource: LiveResource): void
  /** Marks a resource confirmed deleted. */
  release(handle: string, at?: Date): void
  /** Marks a resource cleanup must not delete. */
  refuse(handle: string, reason: string): void
}

/** The admin surface a disposable target needs and the application has no use for. */
export interface LiveAdmin {
  /** Creates the disposable repository this run owns. */
  createRepository(input: { name: string; description: string; marker: string }): Promise<void>
  /** Removes a repository, and reports whether the host still had it. */
  deleteRepository(fullName: string): Promise<boolean>
  /** Reads a repository, which is how ownership and permissions are re-proved. */
  readRepository(fullName: string): Promise<{
    description: string | null
    topics?: { names?: string[] }
    permissions?: Record<string, boolean>
    default_branch?: string
  }>
  /**
   * The commit a ref points at, resolved through the host rather than read out of the
   * clone. A check run and a merge both attach to a commit the host named, and one taken
   * from a local ref would be exactly the stale value those two exist to reject.
   */
  headSha(fullName: string, ref: string): Promise<string>
  /** Creates a branch from an existing ref, and returns the commit it points at. */
  createBranch(fullName: string, branch: string, from: string): Promise<string>
  /** Deletes a branch. */
  deleteBranch(fullName: string, branch: string): Promise<boolean>
  /** Opens a pull request, the way a person pushing a branch would. */
  createPullRequest(input: {
    fullName: string
    head: string
    base: string
    title: string
    body: string
    draft?: boolean
  }): Promise<{ number: number; headSha: string }>
  /** Reads a pull request, so a scenario can prove what the host now holds. */
  readPullRequest(fullName: string, number: number): Promise<Record<string, unknown>>
  /** Closes a pull request, which is how an external merge is partly staged. */
  closePullRequest(fullName: string, number: number): Promise<void>
  /** Writes the check runs a ruleset can require. */
  createCheckRun(input: {
    fullName: string
    headSha: string
    name: string
    status: 'queued' | 'in_progress' | 'completed'
    conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled'
  }): Promise<number>
  /** Creates a branch ruleset, used by the required-check and approval scenarios. */
  createRuleSet(input: LiveRuleSet): Promise<{ id: number }>
  deleteRuleSet(fullName: string, id: number): Promise<boolean>
  /** The login this transport authenticates as. */
  viewer(): Promise<string>
  /** Whether this transport may write check runs in the repository. */
  canWriteChecks(fullName: string): Promise<boolean>
  /** Whether this transport may create and delete rulesets. */
  canManageRuleSets(fullName: string): Promise<boolean>
  /** The base refs this repository has a merge queue on. */
  mergeQueues(fullName: string): Promise<string[]>
  /**
   * Whether the review-thread GraphQL surface answers for a real pull request here.
   * The pull request is named because the surface is per-pull-request: a host that
   * answers for one can refuse another, and only a real one can be asked.
   */
  supportsReviewThreads(fullName: string, number: number): Promise<boolean>
  /** The permission the authenticated account holds on the repository. */
  viewerPermission(fullName: string, number: number): Promise<string>
}

/** The ruleset permutations the suite exercises. */
export interface LiveRuleSet {
  name: string
  /** `active` so the rule applies before a pull request is merged. */
  enforcement: 'active' | 'disabled'
  /** A required status check a merge cannot happen without. */
  requiredStatusCheck?: string
  /** How many approving reviews a merge needs. */
  requiredApprovals?: number
  /** Restricts merges to listed actors, standing in for an app-only rule. */
  mergeActors?: number[]
  /**
   * Base refs to configure a merge queue on. A queue is a ruleset rule rather than a
   * repository setting, so a target that reports a queue has to have written this.
   */
  mergeQueueBaseRefs?: string[]
}

export interface LiveCapabilities {
  /** The native stacked-pull-request REST surface answers for this repository. */
  nativeStacks: boolean
  /** The asynchronous merge endpoint answers. */
  asyncMerge: boolean
  /** This run may write check runs. */
  checks: boolean
  /** GraphQL review threads, replies, and resolution answer for this repository. */
  reviewThreads: boolean
  /** This run may create and delete rulesets. */
  ruleSets: boolean
  /** A base ref on this repository has a merge queue. */
  mergeQueue: boolean
  /** A second account that can review was supplied. */
  secondReviewer: boolean
  /** The account may merge pull requests, which approval rules depend on. */
  canMerge: boolean
  /** What was actually observed, so a refusal can be explained rather than guessed. */
  readonly notes: readonly string[]
}

/** The capability names scenarios declare, and what each one is worth. */
export const LIVE_CAPABILITIES = [
  'nativeStacks',
  'asyncMerge',
  'checks',
  'reviewThreads',
  'ruleSets',
  'mergeQueue',
  'secondReviewer',
  'canMerge',
] as const

export type LiveCapability = (typeof LIVE_CAPABILITIES)[number]

export interface LiveCleanupReport {
  /** Resources confirmed gone. */
  removed: string[]
  /** Resources the run refused to delete, and why. */
  refused: Array<{ handle: string; reason: string }>
  /** Resources that were still there afterwards. */
  remaining: string[]
  /** True only when nothing this run created is left behind. */
  complete: boolean
}

/** One scenario's result. A failure carries a sanitized report and never a secret. */
export interface LiveScenarioResult {
  readonly id: string
  readonly title: string
  readonly outcome: 'passed' | 'failed'
  readonly durationMs: number
  /** Sanitized. Safe to publish as a workflow artifact. */
  readonly failure?: LiveFailureReport
  /** Scenarios' own progress lines, sanitized. */
  readonly log: readonly string[]
}

export interface LiveFailureReport {
  readonly scenario: string
  readonly message: string
  /** The sanitized stack, with local paths and secrets withheld. */
  readonly stack?: string
  /** The capability or environment fact that made this scenario unrunnable. */
  readonly blockedBy?: string
  /** Redacted request/response pairs that led here, most recent last. */
  readonly exchanges: readonly string[]
}
