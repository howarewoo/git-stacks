import {
  GitHubTransportError,
  type GitHubTransport,
  type GitHubRestResponse,
} from '../../src/main/github-transport'
import { isRecord } from '../../src/shared/guards'
import type { LiveAdmin, LiveRuleSet } from './contract'
import { markedDescription } from './provisioning'

/** The parts of a repository read the ownership check and capability probes need. */
interface RepositoryProbe {
  description: string | null
  topics?: { names?: string[] }
  permissions?: Record<string, boolean>
  default_branch?: string
}

interface PullRequestProbe {
  number: number
  head: { sha: string; ref: string }
  base: { ref: string }
}

interface RulesetProbe {
  id: number
  name: string
  enforcement?: string
  conditions?: { ref_name?: { include?: string[] } }
  rules?: Array<{ type?: string }>
}

function refName(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`
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

  async viewer(): Promise<string> {
    const { data } = await this.call<{ login?: string }>({ method: 'GET', path: 'user' })
    return typeof data?.login === 'string' ? data.login : ''
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

  async createRepository(input: {
    name: string
    description: string
    marker: string
  }): Promise<void> {
    await this.call({
      method: 'POST',
      path: 'user/repos',
      body: {
        name: input.name,
        description: markedDescription(input.description, input.marker),
        private: true,
        auto_init: false,
        // A queue and a ruleset are configured after the repository exists; asking
        // for them here would hide a refusal behind a failed create.
        has_issues: false,
        has_projects: false,
        has_wiki: false,
        has_discussions: false,
      },
    })
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
  }): Promise<{ number: number; headSha: string }> {
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
    return { number: data.number, headSha: data.head?.sha ?? '' }
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

  async createRuleSet(input: LiveRuleSet): Promise<{ id: number }> {
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
        bypass_actors: (input.mergeActors ?? []).map((actor) => ({
          actor_id: Number(actor),
          bypass_mode: 'always',
        })),
        // A queue belongs to a base ref rather than to every branch, so a ruleset that
        // asks for one names exactly the refs it queues.
        conditions: {
          ref_name: {
            include:
              input.mergeQueueBaseRefs && input.mergeQueueBaseRefs.length > 0
                ? input.mergeQueueBaseRefs
                : ['~ALL'],
            exclude: [],
          },
        },
        rules: [
          ...(input.mergeQueueBaseRefs && input.mergeQueueBaseRefs.length > 0
            ? [
                {
                  type: 'merge_queue',
                  parameters: {
                    queue_type: 'base',
                    merge_method: 'merge',
                    merge_commit_message: 'queued from the live GitHub suite',
                    merge_commit_title: 'queued from the live GitHub suite',
                    min_entries_to_merge: 0,
                    max_entries_to_merge: 5,
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
                      {
                        context: input.requiredStatusCheck,
                        integration_id: null,
                      },
                    ],
                    strict_required_status_checks_policy: false,
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
                    allowed_merge_methods: ['merge', 'squash', 'rebase'],
                  },
                },
              ]
            : []),
          ...(input.mergeActors?.length
            ? [
                {
                  type: 'bypass_pull_request_allowances',
                  parameters: { bypass_mode: 'always', bypass_actors: input.mergeActors },
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

  /** Every rule set the host reports, which is the only place a queue is configured. */
  private async listRuleSets(fullName: string): Promise<RulesetProbe[]> {
    const { data } = await this.call<unknown>({ method: 'GET', path: `repos/${fullName}/rulesets` })
    if (!Array.isArray(data)) return []
    return data.filter(
      (entry): entry is RulesetProbe => isRecord(entry) && typeof entry.id === 'number',
    )
  }

  /**
   * The base refs a merge queue is configured on, read from the rule sets themselves
   * rather than from a flag the run set itself. A queue the run has not configured is
   * the difference between a scenario that proves a queue and one that only proves it
   * can send the request, so this is a read and never an assumption.
   */
  async mergeQueues(fullName: string): Promise<string[]> {
    const fallback = (
      await this.readRepository(fullName).catch(() => ({ default_branch: undefined }))
    ).default_branch
    const bases = new Set<string>()
    for (const rules of await this.listRuleSets(fullName)) {
      const queued = (rules.rules ?? []).some((rule) => rule.type === 'merge_queue')
      if (!queued) continue
      for (const ref of rules.conditions?.ref_name?.include ?? []) {
        if (ref === '~DEFAULT_BRANCH') {
          if (fallback) bases.add(fallback)
          continue
        }
        if (ref === '~ALL') continue
        bases.add(ref)
      }
    }
    return [...bases].sort()
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
   * probe for the permission, so an empty rule set is created and removed again;
   * if either step is refused, the account does not have the scope.
   */
  async canManageRuleSets(fullName: string): Promise<boolean> {
    try {
      const created = await this.createRuleSet({
        name: 'git-stacks-live-e2e capability probe',
        enforcement: 'disabled',
      })
      await this.deleteRuleSet(fullName, created.id)
      return true
    } catch (error) {
      if (error instanceof GitHubTransportError) return false
      throw error
    }
  }
}
