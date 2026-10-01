import {
  GitHubTransportError,
  type GitHubTransport,
  type GitHubRestResponse,
} from '../../src/main/github-transport'
import { isRecord } from '../../src/shared/guards'
import type {
  LiveActor,
  LiveAdmin,
  LiveCollaboratorPermission,
  LiveOwnerKind,
  LiveRepositoryIdentity,
  LiveRuleSet,
} from './contract'
import { markedDescription, ownsCreatedResource } from './provisioning'

/** The parts of a repository read the ownership check and capability probes need. */
interface RepositoryProbe {
  id?: number
  description: string | null
  /** GitHub returns topics as an array of strings, not as an object wrapping one. */
  topics?: string[]
  permissions?: Record<string, boolean>
  default_branch?: string
  owner?: { login?: string; type?: string }
}

interface PullRequestProbe {
  number: number
  head: { sha: string; ref: string }
  base: { ref: string }
  /** The address the host itself reports, which is the only one worth publishing. */
  html_url?: string
}

interface RulesetProbe {
  id: number
  name: string
  enforcement?: string
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }
  rules?: Array<{ type?: string }>
}

/** GitHub's own shorthands for "the default branch" and "every branch". */
const DEFAULT_BRANCH_CONDITION = '~DEFAULT_BRANCH'
const ALL_BRANCHES_CONDITION = '~ALL'

/**
 * The identity fields a creation response carries, in the shape both the personal
 * and the organization route answer with.
 */
interface CreatedRepositoryProbe {
  id?: number
  full_name?: string
  default_branch?: string | null
  name?: string
  owner?: { login?: string; type?: string }
}

function refName(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`
}

/**
 * The branch a fully qualified ref names, or the shorthand itself.
 *
 * Queue discovery compares what it read against a base branch, and the two arrive
 * in different spellings: the rule set says `refs/heads/trunk`, the repository says
 * `trunk`. Comparing those as strings decides they are different, and a configured
 * queue is then reported as absent.
 */
function branchOfRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/**
 * The GraphQL probe documents, kept here so a capability question is answered with the
 * same operation the product issues rather than with a bespoke query that could be
 * answered by a different surface than the one the product depends on.
 */
const REVIEW_THREAD_PROBE = `query ReviewThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) {
      state
      viewerDidAuthor
      reviewThreads(first: 1) { totalCount }
    }
  }
}`

/**
 * The administrative surface a disposable target needs and the application has
 * no reason to have: creating and deleting the repository, opening pull requests
 * on branches, writing check runs, and configuring rulesets.
 *
 * It is deliberately a thin caller of the same `GitHubTransport` the application's
 * services use — no second HTTP client, no second error classification, no second
 * rate-limit reader. What it adds is the endpoints for resources the product does
 * not create, and nothing else.
 */
export class GitHubAdmin implements LiveAdmin {
  private readonly transport: GitHubTransport
  private readonly fullName: string
  /**
   * This run's ownership marker. Every named resource this admin creates carries it,
   * because a rule set left behind on somebody else's repository is the one thing
   * cleanup cannot take back.
   */
  private readonly marker: string

  constructor(transport: GitHubTransport, fullName: string, marker: string) {
    this.transport = transport
    this.fullName = fullName
    this.marker = marker
  }

  private async call<T>(request: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    body?: Record<string, unknown>
  }): Promise<GitHubRestResponse<T>> {
    return this.transport.rest<T>({
      method: request.method,
      path: request.path,
      ...(request.body ? { body: request.body } : {}),
    })
  }

  /**
   * The account this transport authenticates as, or a refusal.
   *
   * An empty login is not an answer. A host that answered `/user` with something
   * else, or refused outright, has told this run it does not know who it is — and a
   * suite that carried on from there would create resources on an account it cannot
   * name and then report a capability it cannot attribute to anyone.
   */
  async viewer(): Promise<string> {
    const { data } = await this.call<{ login?: string }>({ method: 'GET', path: 'user' })
    const login = data?.login
    if (typeof login !== 'string' || login.trim() === '') {
      throw new Error('GitHub did not answer which account this credential belongs to')
    }
    return login
  }

  /**
   * Resolves the configured owner against the credential about to spend it, and
   * answers which route may create there.
   *
   * An owner equal to the authenticated login is that account's own space. Anything
   * else is only usable if the credential is an active member of the organization of
   * that name, which GitHub answers and a non-member cannot. A name that is neither
   * is refused here, before a single mutation: discovering it afterwards — by posting
   * to the personal route and then failing to read the configured name — leaves the
   * repository that really was created in nobody's receipt, which is exactly the
   * leftover this suite exists not to leave behind.
   *
   * The organization is the owner and never the actor. A repository created through
   * an organization route is created *by* the user whose credential was spent, and
   * that user is the only account whose credential can delete it again. Answering
   * with the organization here would put a login in every receipt entry and in the
   * recovery actor set that no credential in the run ever authenticates as, so the
   * only command that can clean the run up refuses it — and would refuse the correct
   * credential while accepting the wrong one.
   */
  async resolveOwner(owner: string): Promise<LiveActor> {
    const login = await this.viewer()
    if (login.toLowerCase() === owner.toLowerCase()) {
      return { login, kind: 'user', owner, ownerKind: 'user' }
    }
    const membership = await this.call<{ state?: string }>({
      method: 'GET',
      path: `user/memberships/orgs/${encodeURIComponent(owner)}`,
    }).catch((error: unknown) => {
      if (
        error instanceof GitHubTransportError &&
        (error.status === 404 || error.kind === 'not-found')
      ) {
        return null
      }
      throw error
    })
    if (membership === null || membership.data?.state !== 'active') {
      throw new Error(
        `The configured owner ${owner} is neither this credential's account (${login}) nor an ` +
          'organization it is an active member of. Sending it to the personal creation route ' +
          'would create the repository under a different account than the receipt names, so the ' +
          'run is refused before anything is created.',
      )
    }
    return { login, kind: 'user', owner, ownerKind: 'organization' }
  }

  /** The commit a ref points at, which is what a check run and a merge both attach to. */
  async headSha(fullName: string, ref: string): Promise<string> {
    const { data } = await this.call<{ sha?: string }>({
      method: 'GET',
      path: `repos/${fullName}/commits/${encodeURIComponent(ref)}`,
    })
    return typeof data?.sha === 'string' ? data.sha : ''
  }

  /**
   * One GraphQL document, sent through the same transport as the REST calls, so a
   * capability probe cannot disagree with the application about which account is
   * signed in or about how a failure is classified.
   */
  private async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const data = await this.transport.graphql<Record<string, unknown>>(query, variables)
    return isRecord(data) ? data : null
  }

  /**
   * Creates the disposable repository under the resolved owner, through the route
   * that owner requires, and keeps the identity the host answered with.
   *
   * The personal route and the organization route are different endpoints, and
   * sending an organization's name to the personal one does not fail — it creates
   * the repository under the caller's own account instead. So the route follows the
   * resolved kind, the response is checked against what was asked for, and the
   * marker is read back: a repository the host names differently, or one that does
   * not carry this run's marker, is a refusal rather than something to clean up
   * later on the strength of a name.
   */
  async createRepository(input: {
    owner: string
    name: string
    description: string
    marker: string
    private?: boolean
    /** The branch this repository is to treat as its default, asked for rather than assumed. */
    defaultBranch: string
  }): Promise<LiveRepositoryIdentity> {
    const resolved = await this.resolveOwner(input.owner)
    const { data } = await this.call<CreatedRepositoryProbe>({
      method: 'POST',
      // The route follows the owner, and the owner is not the account spending the
      // credential. Sending an organization's name to the personal route does not
      // fail — it creates the repository under the caller's own account instead,
      // which is a repository this run will not find under the name it recorded.
      path:
        resolved.ownerKind === 'organization'
          ? `orgs/${encodeURIComponent(resolved.owner)}/repos`
          : 'user/repos',
      body: {
        name: input.name,
        description: markedDescription(input.description, input.marker),
        private: input.private !== false,
        auto_init: false,
        // Asked for, rather than guessed at afterwards. A repository created with no
        // initial commit reports whatever the host's own setting is, and on a host whose
        // default is `master` a run that assumed `main` would seed a branch the host did
        // not call the default — and then every merge-queue, ruleset and base-ref check
        // would be asking about a branch the repository does not have. This is the one
        // branch name in the run that is not an assumption.
        default_branch: input.defaultBranch,
        // A queue and a ruleset are configured after the repository exists; asking
        // for them here would hide a refusal behind a failed create.
        has_issues: false,
        has_projects: false,
        has_wiki: false,
        has_discussions: false,
      },
    })
    const identity = this.identityFrom(data, `${resolved.owner}/${input.name}`)
    if (
      !ownsCreatedResource(await this.readRepository(identity.fullName), input.marker, identity.id)
    ) {
      throw new Error(
        `${identity.fullName} does not carry this run's ownership marker, so this run will not delete it`,
      )
    }
    return identity
  }

  /**
   * Forks a repository with this transport's own account.
   *
   * The fork is created through the credential of the account that will own it, so
   * it genuinely belongs to somebody other than the repository it was forked from —
   * which is what makes a fork head foreign in fact rather than in appearance.
   * GitHub's fork route takes an organization and nothing else, so the marker is
   * stamped immediately afterwards and read back: a fork that would not carry it is
   * one this run does not own and will not delete.
   */
  async createFork(input: { parent: string; marker: string }): Promise<LiveRepositoryIdentity> {
    const { data } = await this.call<CreatedRepositoryProbe>({
      method: 'POST',
      path: `repos/${input.parent}/forks`,
      body: {},
    })
    const identity = this.identityFrom(data, null)
    await this.call({
      method: 'PATCH',
      path: `repos/${identity.fullName}`,
      body: {
        description: markedDescription(
          'Disposable fork for the Git Stacks live suite.',
          input.marker,
        ),
      },
    })
    if (
      !ownsCreatedResource(await this.readRepository(identity.fullName), input.marker, identity.id)
    ) {
      throw new Error(
        `${identity.fullName} did not accept this run's ownership marker, so this run will not delete it`,
      )
    }
    return identity
  }

  /**
   * The identity a creation response reported.
   *
   * The id is kept because it is the one thing a name cannot be: a later read of
   * that name may resolve to a different repository, and a deletion aimed at a name
   * is aimed at whatever answers to it at the time. `expected` is what the run
   * believes it created, and a host that names something else is refused rather
   * than accommodated.
   */
  private identityFrom(data: unknown, expected: string | null): LiveRepositoryIdentity {
    if (!isRecord(data) || typeof data.id !== 'number' || typeof data.full_name !== 'string') {
      throw new Error('GitHub did not return the identity of the repository it created')
    }
    const created = data as CreatedRepositoryProbe
    const fullName = created.full_name as string
    if (expected !== null && fullName.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `GitHub created ${fullName} when this run asked for ${expected}; refusing to treat it as owned`,
      )
    }
    return {
      id: created.id as number,
      fullName,
      defaultBranch: typeof created.default_branch === 'string' ? created.default_branch : null,
      owner: created.owner?.login ?? fullName.split('/')[0] ?? '',
      ownerKind: created.owner?.type === 'Organization' ? 'organization' : 'user',
    }
  }

  /**
   * Lets a second account in, and answers whether it still has to accept an invitation.
   *
   * A token does not confer membership: a repository created a moment ago has one
   * member, and a second account holding a valid credential still cannot read a private
   * pull request until it has been let in.
   *
   * One route does both jobs and its status says which happened.
   * `PUT /repos/{owner}/{repo}/collaborators/{username}` answers **201 Created** with a
   * repository invitation when the account is not yet a collaborator and had to be
   * invited, and **204 No Content** with no body when the account was already a
   * collaborator, is already an organization member, or was granted directly. So 204
   * means access exists now and there is nothing to accept, while 201 hands back an
   * invitation whose id the invited account has to accept before it holds anything.
   * Treating both as success-and-move-on is what produces a run that reports a second
   * reviewer and then answers 404 on every read that reviewer makes. There is no
   * separate route for creating one: the invitations endpoints only list, patch and
   * delete invitations that already exist.
   */
  async inviteCollaborator(
    fullName: string,
    login: string,
    permission: LiveCollaboratorPermission,
  ): Promise<number | null> {
    const { status, data } = await this.call<{ id?: number }>({
      method: 'PUT',
      path: `repos/${fullName}/collaborators/${encodeURIComponent(login)}`,
      body: { permission },
    })
    if (status === 204) return null
    if (status !== 201) {
      throw new Error(
        `GitHub answered ${status} when asked to let ${login} into ${fullName}, which is neither ` +
          'an invitation nor a grant',
      )
    }
    if (!isRecord(data) || typeof data.id !== 'number') {
      throw new Error(
        `GitHub invited ${login} to ${fullName} without naming the invitation, so there is nothing ` +
          'for that account to accept',
      )
    }
    return data.id
  }

  /** The invitations waiting for this credential, which only it can see. */
  async pendingInvitations(): Promise<Array<{ id: number; repository: { full_name?: string } }>> {
    const { data } = await this.call<unknown>({
      method: 'GET',
      path: 'user/repository_invitations',
    })
    if (!Array.isArray(data)) return []
    return data.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.id !== 'number' || !isRecord(entry.repository)) {
        return []
      }
      const fullName = entry.repository.full_name
      return [
        {
          id: entry.id,
          repository: { ...(typeof fullName === 'string' ? { full_name: fullName } : {}) },
        },
      ]
    })
  }

  /**
   * Accepts an invitation as the account it was addressed to.
   *
   * `PATCH /user/repository_invitations/{invitation_id}` takes the id in the path and
   * nothing else, and it is the invited credential's own acceptance, never the
   * inviter's.
   */
  async acceptInvitation(id: number): Promise<void> {
    await this.call({
      method: 'PATCH',
      path: `user/repository_invitations/${id}`,
    })
  }

  /**
   * The permission an account actually holds, read from the host's own answer.
   *
   * This is what turns a second credential into a capability. An invitation sent and
   * never accepted, or accepted for some other repository, is answered here as the
   * absence it is — so nothing downstream can treat a token as if it were access.
   */
  async collaboratorPermission(fullName: string, login: string): Promise<string | null> {
    const { data } = await this.call<{ permission?: string }>({
      method: 'GET',
      path: `repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`,
    })
    return typeof data?.permission === 'string' && data.permission.trim() !== ''
      ? data.permission
      : null
  }

  async deleteRepository(fullName: string): Promise<boolean> {
    try {
      const { status } = await this.call({ method: 'DELETE', path: `repos/${fullName}` })
      return status === 204
    } catch (error) {
      if (
        error instanceof GitHubTransportError &&
        (error.status === 404 || error.kind === 'not-found')
      ) {
        return true
      }
      throw error
    }
  }

  async readRepository(fullName: string): Promise<RepositoryProbe> {
    const { data } = await this.call<RepositoryProbe>({ method: 'GET', path: `repos/${fullName}` })
    // A repository read that answers with something else is not a repository read,
    // and calling that an empty repository would hide the difference.
    return isRecord(data) ? (data as RepositoryProbe) : { description: null }
  }

  async createBranch(fullName: string, branch: string, from: string): Promise<string> {
    const { data } = await this.call<{ object?: { sha?: string } }>({
      method: 'POST',
      path: `repos/${fullName}/git/refs`,
      body: { ref: refName(branch), sha: from },
    })
    return typeof data?.object?.sha === 'string' ? data.object.sha : ''
  }

  /**
   * Deletes a branch, and reports whether the host still had it.
   *
   * GitHub's documented route is `/git/refs/heads/<name>`, so the `refs/` prefix is
   * dropped and the slashes stay slashes. Percent-encoding the whole ref asks for
   * `refs%2Fheads%2F...`, which is not that route: the host answers 404 for a ref
   * that is still standing, and a 404 is exactly what this treats as "already gone".
   * Encoding it that way therefore reports a deletion that never happened.
   */
  async deleteBranch(fullName: string, branch: string): Promise<boolean> {
    try {
      const { status } = await this.call({
        method: 'DELETE',
        path: `repos/${fullName}/git/refs/${refName(branch).replace(/^refs\//u, '')}`,
      })
      return status === 204
    } catch (error) {
      if (
        error instanceof GitHubTransportError &&
        (error.status === 404 || error.kind === 'not-found')
      ) {
        return true
      }
      throw error
    }
  }

  async createPullRequest(input: {
    fullName: string
    head: string
    base: string
    title: string
    body: string
    draft?: boolean
  }): Promise<{ number: number; headSha: string; url: string | null }> {
    const { data } = await this.call<PullRequestProbe>({
      method: 'POST',
      path: `repos/${input.fullName}/pulls`,
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft === true,
      },
    })
    if (!isRecord(data) || typeof data.number !== 'number') {
      throw new Error(`GitHub did not return a pull request for ${input.fullName}`)
    }
    return {
      number: data.number,
      headSha: data.head?.sha ?? '',
      // The address is whatever the host said, or nothing at all. Composing one from
      // the host and the number would make it the only value in a run that could not
      // be wrong, and therefore the one a report would be least able to stand behind.
      url: typeof data.html_url === 'string' ? data.html_url : null,
    }
  }

  async readPullRequest(fullName: string, number: number): Promise<Record<string, unknown>> {
    const { data } = await this.call<Record<string, unknown>>({
      method: 'GET',
      path: `repos/${fullName}/pulls/${number}`,
    })
    return isRecord(data) ? data : {}
  }

  async closePullRequest(fullName: string, number: number): Promise<void> {
    await this.call({
      method: 'PATCH',
      path: `repos/${fullName}/pulls/${number}`,
      body: { state: 'closed' },
    })
  }

  async createCheckRun(input: {
    fullName: string
    headSha: string
    name: string
    status: 'queued' | 'in_progress' | 'completed'
    conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled'
  }): Promise<number> {
    const { data } = await this.call<{ id?: number }>({
      method: 'POST',
      path: `repos/${input.fullName}/check-runs`,
      body: {
        name: input.name,
        head_sha: input.headSha,
        status: input.status,
        ...(input.conclusion ? { conclusion: input.conclusion } : {}),
      },
    })
    if (!isRecord(data) || typeof data.id !== 'number') {
      throw new Error(`GitHub did not return a check run for ${input.fullName}`)
    }
    return data.id
  }

  /**
   * Creates a branch rule set, in the shape GitHub's ruleset contract documents.
   *
   * Three things here are not stylistic. The ref condition is required and fully
   * qualified, because a rule set with no condition governs the whole repository —
   * which is how a required check ends up refusing the topic branch push that was
   * supposed to satisfy it, before the scenario has asserted anything. The merge
   * queue's parameters are the documented required set with the documented enum,
   * because an incomplete queue rule is rejected by the host for the account that is
   * perfectly allowed to configure one. And the review-thread-resolution policy is
   * stated explicitly as `false`, because the permutation under test is about
   * approvals: leaving it unstated would either be an invalid request or, read the
   * other way, quietly add a conversation-resolution requirement nobody asked for.
   *
   * No bypass actor is invented. A run has no real app, team or organization admin
   * id to name, so it creates the rule fully enforced and says so.
   */
  async createRuleSet(input: LiveRuleSet): Promise<{ id: number }> {
    if (input.baseRefs.length === 0) {
      throw new Error(
        `The rule set ${input.name} names no refs; a rule set with no ref condition governs ` +
          'every branch on the repository, which is not what any of these permutations mean',
      )
    }
    const include = input.baseRefs.map((ref) => refName(ref))
    if (include.includes(ALL_BRANCHES_CONDITION)) {
      throw new Error(
        `The rule set ${input.name} would apply to ${ALL_BRANCHES_CONDITION}; name the refs it protects instead`,
      )
    }
    const { data } = await this.call<RulesetProbe>({
      method: 'POST',
      path: `repos/${this.fullName}/rulesets`,
      body: {
        // A rule set is the only resource here that outlives nothing else, so its name
        // carries this run's marker: a rule set left standing on somebody's repository
        // is the one thing a later run cannot take back.
        name: `${input.name} (${this.marker})`,
        // `active` on a branch target is what makes the rule apply to a pull
        // request before it is merged, which is the only window these scenarios
        // can observe.
        target: 'branch',
        enforcement: input.enforcement,
        bypass_actors: (input.bypassActors ?? []).map((actor) => ({
          actor_id: actor.actorId,
          actor_type: actor.actorType,
          bypass_mode: actor.bypassMode,
        })),
        conditions: { ref_name: { include, exclude: [] } },
        rules: [
          ...(input.mergeQueue === true
            ? [
                {
                  type: 'merge_queue',
                  parameters: {
                    queue_type: 'base',
                    merge_method: 'MERGE',
                    merge_commit_message: 'queued from the live GitHub suite',
                    merge_commit_title: 'queued from the live GitHub suite',
                    min_entries_to_merge: 0,
                    max_entries_to_merge: 5,
                    // The three fields GitHub's contract requires and this request
                    // used to omit. Without them the rule is invalid for every
                    // account, including one allowed to configure queues, so a probe
                    // sending it learns nothing about the account.
                    min_entries_to_merge_wait_minutes: 0,
                    max_entries_to_build: 5,
                    check_response_timeout_minutes: 5,
                    grouping_strategy: 'ALLGREEN',
                  },
                },
              ]
            : []),
          ...(input.requiredStatusCheck
            ? [
                {
                  type: 'required_status_checks',
                  parameters: {
                    required_status_checks: [
                      { context: input.requiredStatusCheck, integration_id: null },
                    ],
                    strict_required_status_checks_policy: false,
                    // The check gates merges onto the refs this rule set names; it is
                    // not a reason to refuse creating the branch that will carry the
                    // check, which is how the rule would block its own subject.
                    do_not_enforce_on_create: false,
                  },
                },
              ]
            : []),
          ...(input.requiredApprovals !== undefined
            ? [
                {
                  type: 'pull_request',
                  parameters: {
                    required_approving_review_count: input.requiredApprovals,
                    dismiss_stale_reviews_on_push: false,
                    require_code_owner_review: false,
                    require_last_push_approval: false,
                    // Required by the ruleset contract, and false on purpose: the
                    // permutation is about approvals, not about conversation threads.
                    required_review_thread_resolution: false,
                    allowed_merge_methods: ['merge', 'squash', 'rebase'],
                  },
                },
              ]
            : []),
        ],
      },
    })
    if (!isRecord(data) || typeof data.id !== 'number') {
      throw new Error('GitHub did not return a rule set')
    }
    return { id: data.id }
  }

  async deleteRuleSet(fullName: string, id: number): Promise<boolean> {
    try {
      const { status } = await this.call({
        method: 'DELETE',
        path: `repos/${fullName}/rulesets/${id}`,
      })
      return status === 204
    } catch (error) {
      if (
        error instanceof GitHubTransportError &&
        (error.status === 404 || error.kind === 'not-found')
      ) {
        return true
      }
      throw error
    }
  }

  /**
   * The rule sets the host lists, as summaries.
   *
   * The list response is a summary and nothing more: GitHub does not promise that
   * each entry carries `rules` or `conditions`, and one that does not is not a rule
   * set with no rules, it is a rule set this run has not read yet. So the listing is
   * used for identities only, and every one of those is hydrated through the detail
   * route before anything is concluded from it.
   */
  private async listRuleSetIds(fullName: string): Promise<number[]> {
    const listed = await this.transport.paginate<unknown>({
      method: 'GET',
      path: `repos/${fullName}/rulesets`,
    })
    return listed
      .filter((entry): entry is { id: number } => isRecord(entry) && typeof entry.id === 'number')
      .map((entry) => entry.id)
  }

  /** One rule set with its conditions and rules, as the detail route reports them. */
  private async readRuleSet(fullName: string, id: number): Promise<RulesetProbe | null> {
    const response = await this.call<unknown>({
      method: 'GET',
      path: `repos/${fullName}/rulesets/${id}`,
    }).catch((error: unknown) => {
      // A rule set deleted between the listing and the read is not a queue that was
      // never configured; it is one that is gone, which is the same answer.
      if (
        error instanceof GitHubTransportError &&
        (error.status === 404 || error.kind === 'not-found')
      ) {
        return null
      }
      throw error
    })
    if (response === null) return null
    const data = response.data
    if (!isRecord(data) || typeof data.id !== 'number') return null
    return {
      id: data.id,
      name: typeof data.name === 'string' ? data.name : String(data.id),
      ...(typeof data.enforcement === 'string' ? { enforcement: data.enforcement } : {}),
      conditions: isRecord(data.conditions)
        ? (data.conditions as RulesetProbe['conditions'])
        : undefined,
      rules: Array.isArray(data.rules) ? (data.rules as RulesetProbe['rules']) : [],
    }
  }

  /**
   * The branches a merge queue is configured on, read from the rule sets themselves
   * rather than from a flag this run set. A queue it has not configured is the
   * difference between a scenario that proves a queue and one that only proves it
   * can send the request, so this is always a read.
   *
   * Two normalizations make the answer comparable to the base branch the rest of the
   * suite uses. Refs come back fully qualified, or as GitHub's `~DEFAULT_BRANCH`
   * shorthand, and the repository names its default branch; comparing those spellings
   * as strings would call a configured queue absent. And `~ALL` is not a branch — it
   * is every branch, which is a repository-wide queue rather than one on a base the
   * scenarios can name, so it is reported as such rather than folded into the list.
   */
  async mergeQueues(fullName: string): Promise<string[]> {
    const defaultBranch = (
      await this.readRepository(fullName).catch((): RepositoryProbe => ({ description: null }))
    ).default_branch
    const bases = new Set<string>()
    for (const id of await this.listRuleSetIds(fullName)) {
      const ruleset = await this.readRuleSet(fullName, id)
      if (ruleset === null) continue
      if (!(ruleset.rules ?? []).some((rule) => rule.type === 'merge_queue')) continue
      for (const ref of ruleset.conditions?.ref_name?.include ?? []) {
        if (ref === DEFAULT_BRANCH_CONDITION) {
          if (defaultBranch) bases.add(defaultBranch)
          continue
        }
        bases.add(branchOfRef(ref))
      }
    }
    return [...bases].filter((branch) => branch !== ALL_BRANCHES_CONDITION).sort()
  }

  /**
   * Whether the review-thread GraphQL surface answers for one real pull request. The
   * probe reads `viewerPermission` and the thread count in one document, because a
   * host that answers one of them can still refuse the other, and a review scenario
   * needs both.
   */
  async supportsReviewThreads(fullName: string, number: number): Promise<boolean> {
    const separator = fullName.indexOf('/')
    if (separator === -1) return false
    const data = await this.graphql(REVIEW_THREAD_PROBE, {
      owner: fullName.slice(0, separator),
      name: fullName.slice(separator + 1),
      number,
    }).catch(() => null)
    if (!isRecord(data) || !isRecord(data.repository)) return false
    const pullRequest = data.repository.pullRequest
    if (!isRecord(pullRequest)) return false
    // The permission lives on the repository and the threads on the pull request, which
    // is where the product reads both. A probe that asked for them somewhere else would
    // prove a host answers a question nobody asks.
    return (
      typeof data.repository.viewerPermission === 'string' && isRecord(pullRequest.reviewThreads)
    )
  }

  /** The role the authenticated account holds, which the merge rules depend on. */
  async viewerPermission(fullName: string, number: number): Promise<string> {
    if (await this.supportsReviewThreads(fullName, number)) {
      const data = await this.graphql(REVIEW_THREAD_PROBE, {
        owner: fullName.slice(0, fullName.indexOf('/')),
        name: fullName.slice(fullName.indexOf('/') + 1),
        number,
      })
      if (isRecord(data) && isRecord(data.repository)) {
        const permission = data.repository.viewerPermission
        if (typeof permission === 'string') return permission
      }
    }
    const repository = await this.readRepository(fullName)
    const roles = repository.permissions ?? {}
    if (roles.admin === true) return 'ADMIN'
    if (roles.maintain === true) return 'MAINTAIN'
    if (roles.push === true) return 'WRITE'
    return 'READ'
  }

  /**
   * Whether this account may write check runs here. The repository's own
   * permission fields do not carry the `checks` scope, so the only honest answer
   * is the one the host gives to an actual write. The probe attaches to the
   * default branch's head, which is inside the repository this run already owns
   * and is deleted with it.
   */
  async canWriteChecks(fullName: string): Promise<boolean> {
    const repository = await this.readRepository(fullName)
    const sha = await this.headSha(fullName, repository.default_branch ?? 'HEAD')
    if (sha === '') return false
    try {
      await this.createCheckRun({
        fullName,
        headSha: sha,
        name: 'git-stacks-live-e2e capability probe',
        status: 'completed',
        conclusion: 'neutral',
      })
      return true
    } catch (error) {
      if (error instanceof GitHubTransportError) return false
      throw error
    }
  }

  /**
   * Whether this account may configure rulesets here. GitHub exposes no read-only
   * probe for the permission, so an empty rule set is created on the named default
   * branch and removed again; if either step is refused, the account does not have the
   * scope. The branch is named rather than left open, because a rule set with no ref
   * condition governs the whole repository and would leave a standing rule behind on
   * every branch of it.
   */
  async canManageRuleSets(fullName: string, defaultBranch: string): Promise<boolean> {
    try {
      const created = await this.createRuleSet({
        name: 'git-stacks-live-e2e capability probe',
        enforcement: 'disabled',
        baseRefs: [`refs/heads/${defaultBranch}`],
      })
      await this.deleteRuleSet(fullName, created.id)
      return true
    } catch (error) {
      if (error instanceof GitHubTransportError) return false
      throw error
    }
  }
}
