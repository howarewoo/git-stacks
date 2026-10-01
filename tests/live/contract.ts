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

/** Whether an owner is a person or an organization, as GitHub reports it. */
export type LiveOwnerKind = 'user' | 'organization'

/**
 * One authenticated account, resolved from the credential before anything is
 * created.
 *
 * A login that reads back empty is not an account. A suite that treated one as a
 * second reviewer would hand a private pull request to a credential it cannot
 * identify, and a suite that created a repository without one would not know
 * which account it had just spent. So the identity is resolved, or the run is
 * refused before the first mutation.
 *
 * The account that spends the credential and the account the repository belongs
 * to are two different answers, and collapsing them is what makes a run
 * unrecoverable. An organization's repositories are created by a user acting for
 * it: the `POST` that creates one is made as that user, the receipt has to name
 * that user because that is the only credential that can delete what was
 * created, and a second reviewer has to be a different account from the user
 * rather than from the organization. So `login` is always the authenticated
 * account, and `owner` is where this credential is allowed to create — used for
 * the creation route and nothing else.
 */
export interface LiveActor {
  readonly login: string
  readonly kind: LiveOwnerKind
  readonly owner: string
  readonly ownerKind: LiveOwnerKind
}

/**
 * A repository as the host itself reported it after creating it.
 *
 * The id is retained rather than re-derived from a name. A name can be spelled
 * for something that already existed, and an id cannot, so cleanup and recovery
 * act on the one object the host says this request created.
 */
export interface LiveRepositoryIdentity {
  readonly id: number
  readonly fullName: string
  readonly defaultBranch: string | null
  readonly owner: string
  readonly ownerKind: LiveOwnerKind
}

/** The permission a collaborator may be granted on a disposable repository. */
export type LiveCollaboratorPermission = 'push' | 'maintain' | 'triage' | 'pull'

/**
 * A pull request that lives somewhere other than the disposable repository.
 *
 * Both halves are real. A cross-repository negative that names an invented
 * repository, or a number that merely happens to be unused here, proves only
 * that the number is unused; foreignness is the thing under test, and the
 * refusal the suite wants to observe is the one a real foreign pull request
 * earns.
 */
export interface LiveForeignPullRequest {
  /** The repository the pull request really lives in, as the host reports it. */
  readonly fullName: string
  /** The number the host assigned, which is the one a read has to be pointed at. */
  readonly number: number
  /**
   * The address the host itself reported for this pull request, or null when it
   * reported none.
   *
   * It is never composed from the host and the number. A URL this suite built
   * itself would be the one thing in the result that could not fail, and a
   * scenario that published it as evidence would be publishing its own arithmetic.
   */
  readonly url: string | null
}

/** Which kind of foreign subject a scenario needs. */
export type LiveForeignKind = 'fork' | 'repository'

/**
 * One entry of a rule set's `bypass_actors`.
 *
 * The three fields are all required by GitHub's ruleset contract, and all three are
 * names this suite cannot invent: an actor id means nothing without its type, and
 * neither an app id nor a team id can be guessed. A run that cannot supply a real one
 * supplies none, and the rule set is created with the rule fully enforced.
 */
export interface LiveBypassActor {
  readonly actorId: number
  readonly actorType:
    'Integration' | 'Team' | 'OrganizationAdmin' | 'EnterpriseAdmin' | 'RepositoryRole'
  readonly bypassMode: 'always' | 'pull_request'
}

export interface LiveTarget {
  readonly kind: 'controlled' | 'github'
  /** The id stamped on every resource this run creates, and matched on at cleanup. */
  readonly runId: string
  /** Where this run's cleanup receipt is written, so a failed run is still auditable. */
  readonly receipt: string
  /** The ownership marker stamped on every resource this run creates. */
  readonly marker: string
  readonly host: GitHubHostContext
  /**
   * The branch this repository was actually provisioned on, as the host reports
   * it.
   *
   * Every layer base, pull request base, native-chain expectation, queue ref and
   * schema-probe parent reads this rather than assuming `main`. An account whose
   * repositories default to `trunk` would otherwise produce a suite that cannot
   * run at all, and a controlled run that always says `main` hides it.
   */
  readonly defaultBranch: string
  /** The account this run spends its own credential as, resolved before any mutation. */
  readonly primary: LiveActor
  /** The production transport bound to that host, faults and all. */
  transport(): GitHubTransport
  /** The production transport, with the fault injector exposed. */
  faults(): FaultInjectingHandle
  /** The disposable repository every scenario works in, as `owner/name`. */
  repository(): string
  /** A local clone whose `origin` is the disposable repository. */
  workspace(): Promise<LiveWorkspace>
  /**
   * A real pull request in a repository other than this one, created and
   * journaled by this run so cleanup and recovery act on the right account's
   * resource.
   */
  foreignPullRequest(kind: LiveForeignKind): Promise<LiveForeignPullRequest>
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

/**
 * A second account that has been let into the disposable repository and can be
 * shown to hold access to it.
 *
 * Constructing one is not enough. A token does not confer membership in a
 * repository created a moment ago, so the access is granted, accepted, and read
 * back from the host before this object exists.
 */
export interface LiveReviewer {
  readonly login: string
  /** The permission the host reports this account holding on the repository. */
  readonly permission: string
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
  'collaborator',
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
  /**
   * Set while the request that creates this resource is in flight, or when its
   * answer was lost. A pending entry is not a claim that the resource exists;
   * recovery reads the host before it believes either way, and never re-sends the
   * creation.
   */
  readonly pending?: boolean
  /** The id the host returned for the resource it created, when it returned one. */
  readonly remoteId?: number
  /**
   * The account whose credential created this resource. A fork belongs to the
   * reviewer's account and can only be removed with the reviewer's credential, so
   * a recovery run has to know which of the run's accounts owns what.
   */
  readonly actor?: string
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
  /**
   * Journals a resource this run is about to create, durably, before the request
   * that creates it is sent. The returned promise is awaited by the caller: the
   * whole point of the intent is that it survives a lost response.
   */
  intent(resource: LiveResource): Promise<void>
  /**
   * Records the id the host returned for a pending creation, so a later recovery
   * can act on that exact object rather than on a name.
   */
  confirm(handle: string, remoteId?: number): void
  /** Marks a resource confirmed deleted. */
  release(handle: string, at?: Date): void
  /** Marks a resource cleanup must not delete. */
  refuse(handle: string, reason: string): void
}

/** The admin surface a disposable target needs and the application has no use for. */
export interface LiveAdmin {
  /**
   * Resolves the configured owner against the credential about to spend it, and
   * answers which route may create there.
   *
   * The two answers are kept apart: `login` is the account `/user` named, and
   * `owner` is the configured name this credential may create under. An owner that
   * is neither the authenticated account nor an organization this credential may
   * create in is refused before a single mutation is sent, rather than discovered
   * when a read of the configured name comes back empty.
   */
  resolveOwner(owner: string): Promise<LiveActor>
  /**
   * Creates the disposable repository this run owns, under the resolved owner.
   *
   * The route is chosen by the owner's kind, not by a name: the personal route
   * lands under whichever account the token belongs to, which is not the account
   * an organization owner would be named by. The identity the host returns is
   * retained rather than assumed.
   */
  createRepository(input: {
    owner: string
    name: string
    description: string
    marker: string
    private?: boolean
  }): Promise<LiveRepositoryIdentity>
  /**
   * Forks `parent` with this transport's own account, so the fork belongs to a
   * different account than the repository it was forked from — which is what
   * makes a fork head genuinely foreign rather than a name that looks like one.
   */
  createFork(input: { parent: string; marker: string }): Promise<LiveRepositoryIdentity>
  /** Removes a repository, and reports whether the host still had it. */
  deleteRepository(fullName: string): Promise<boolean>
  readRepository(fullName: string): Promise<{
    id?: number
    description: string | null
    topics?: string[]
    permissions?: Record<string, boolean>
    default_branch?: string
    owner?: { login?: string; type?: string }
  }>
  /**
   * Grants a collaborator access, and answers the invitation id when the host
   * created one.
   *
   * A repository this run owns has no members but the accounts it named, so the
   * second account has to be let in before it can read or approve a private pull
   * request at all.
   */
  inviteCollaborator(
    fullName: string,
    login: string,
    permission: LiveCollaboratorPermission,
  ): Promise<number | null>
  /** The repository invitations waiting for this transport's own account. */
  pendingInvitations(): Promise<Array<{ id: number; repository: { full_name?: string } }>>
  /** Accepts one invitation, as the account it was addressed to. */
  acceptInvitation(id: number): Promise<void>
  /**
   * The permission an account actually holds on a repository, read back from the
   * host, or null when the account is not a collaborator there.
   */
  collaboratorPermission(fullName: string, login: string): Promise<string | null>
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
    /**
     * What the host answered with: the number it assigned, the head it holds, and the
     * address it reports for the pull request, or null when it reports none. The
     * address is never composed here, because a URL this suite built could not fail.
     */
  }): Promise<{ number: number; headSha: string; url: string | null }>
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
  /**
   * Whether this transport may configure rulesets here. GitHub exposes no read-only
   * probe for the permission, so an empty rule set is created on the named default
   * branch and removed again; if either step is refused, the account does not have the
   * scope. The branch is named rather than defaulted, because a rule set that guards
   * every branch on the repository is a different resource from one that guards the
   * trunk, and would not prove what the probe claims.
   */
  canManageRuleSets(fullName: string, defaultBranch: string): Promise<boolean>
  /** The branch names this repository has a merge queue on. */
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

/**
 * The ruleset permutations the suite exercises.
 *
 * Every permutation names the refs it protects. A rule set with no ref condition
 * applies to the whole repository, which is how a required check ends up blocking
 * the very branch push that was supposed to satisfy it — a setup failure that then
 * reads as a scenario failure, and that a controlled host whose Git does not
 * enforce rules happily lets through.
 */
export interface LiveRuleSet {
  name: string
  /** `active` so the rule applies before a pull request is merged. */
  enforcement: 'active' | 'disabled'
  /**
   * The refs this rule set applies to, as `refs/heads/<branch>` or GitHub's
   * `~DEFAULT_BRANCH` shorthand. Required, and never defaulted to `~ALL`.
   */
  baseRefs: readonly string[]
  /**
   * Whether this rule set configures a merge queue on those refs. A queue is a
   * rule set rule rather than a repository setting, so a target that reports a
   * queue has to have written this.
   */
  mergeQueue?: boolean
  /** A required status check a merge cannot happen without. */
  requiredStatusCheck?: string
  /** How many approving reviews a merge needs. */
  requiredApprovals?: number
  /**
   * Accounts allowed to merge without the rest of this rule set applying, in the
   * shape GitHub's `bypass_actors` documents: the actor's id, what kind of actor it
   * is, and how far the bypass goes. Nothing is inferred here — a run with no app id,
   * team id or organization admin id to name simply passes none, and the rule set is
   * then created with no bypass at all, which is the honest default.
   */
  readonly bypassActors?: readonly LiveBypassActor[]
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
  /** A second account that can review was supplied, and can reach this repository. */
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
