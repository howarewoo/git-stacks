import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  WRITING_ROLES,
  createServedBareRepository,
  type GitHubFixtureActor,
  type GitHubFixtureRepository,
  type GitHubFixtureRole,
  type GitHubFixtureState,
  type GitHubFixtureRepositoryState,
} from './github-harness'
import {
  HttpError,
  hostGit,
  hostGitOrNull,
  repositoryIdentity,
  hostGitSucceeds,
  hostRefSha,
  paginate,
  queryStringOf,
  standingReviewDecisions,
  validateRuleSetCreation,
  withHostRepository,
  type HostRepository,
  type RestResult,
} from './github-rest'
import {
  handleSurfaceGraphql,
  handleSurfaceRest,
  mergeQueueFor,
  ruleSetBranchRules,
  ruleSetRefusal,
} from './github-review-surface'

/**
 * Transport test double: serves the same fixture state the `gh` CLI fixture serves, but as
 * REST/GraphQL HTTP responses, so domain code exercises the direct transport end to end.
 */
export interface GitHubApiDoubleRequest {
  method: string
  path: string
  body: Record<string, unknown>
  headers: Record<string, string>
  /**
   * The account this request authenticated as. The live end-to-end suite signs a
   * second account in to approve and reply, and GitHub decides `viewerDidAuthor`
   * from exactly this, so it travels with the request rather than living in state.
   */
  viewer: string
  /**
   * Where this request was sent. A collection that has more to say names its next page
   * in a `Link` header, and a real host writes that as an absolute URL on the host the
   * caller is already talking to — so a client that follows it has to be handed the
   * origin the request arrived on, not the one GitHub uses on the internet.
   */
  origin: string
}

const statePath = () => {
  const value = process.env.GIT_STACKS_FIXTURE_STATE
  if (!value) throw new Error('GIT_STACKS_FIXTURE_STATE is required by the GitHub API double')
  return value
}

function loadState(): GitHubFixtureState {
  return JSON.parse(readFileSync(statePath(), 'utf8')) as GitHubFixtureState
}

function saveState(state: GitHubFixtureState): void {
  const temporary = `${statePath()}.${process.pid}.api.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, statePath())
}

const realGit = () => process.env.GIT_STACKS_REAL_GIT || '/usr/bin/git'

const primaryFullName = (state: GitHubFixtureState) =>
  `${state.repository.owner}/${state.repository.name}`

function registryOf(state: GitHubFixtureState): GitHubFixtureRepository[] {
  return state.repositories ?? []
}

/**
 * The repository a full name names on this host, or `null` when it names none.
 *
 * The repository the harness created first is described by the top-level state even when
 * no registry entry exists for it, because that is how every state written before a second
 * repository was possible still describes the one it serves. A registered entry for it
 * wins, which is how a test gives that repository a visibility or a permission map.
 */
function repositoryEntry(
  state: GitHubFixtureState,
  fullName: string,
): GitHubFixtureRepository | null {
  const registered = registryOf(state).find(
    (entry) => entry.fullName.toLowerCase() === fullName.toLowerCase(),
  )
  if (registered) return registered
  if (fullName.toLowerCase() !== primaryFullName(state).toLowerCase()) return null
  // The primary repository exists even where this process was not told which bare
  // repository serves it: refusing it here would let a request for a repository this host
  // does have fall through to the network.
  const bare = process.env.GIT_STACKS_FIXTURE_BARE ?? ''
  // The grants and the invitations this repository holds are the ones a request mutates,
  // so they are read and written on the state that gets saved, the same way its pull
  // requests are. A pair of copies taken per request would answer the second account's own
  // read with the repository as it was before it was let in, which is a host that silently
  // forgets every access it ever granted.
  const primary = state.repository
  primary.permissions ??= {}
  primary.invitations ??= []
  return {
    fullName,
    owner: primary.owner,
    name: primary.name,
    bare,
    private: false,
    defaultBranch: primary.defaultBranch,
    description: primary.description ?? null,
    topics: primary.topics ?? [],
    permissions: primary.permissions,
    invitations: primary.invitations,
    pulls: primaryPulls(state),
  }
}

/**
 * The keys a repository answers for: its pull requests, its counters, and the switches
 * that answer for them. They are the same names whether a repository is the top-level
 * state or one entry of the registry.
 */
const REPOSITORY_SLICE_KEYS = [
  'prs',
  'comments',
  'stacks',
  'issues',
  'reviews',
  'reviewThreads',
  'nextNumber',
  'nextCommentId',
  'nextStackNumber',
  'nextReviewId',
  'nextThreadId',
  'ruleSets',
  'nextRuleSetId',
  'checks',
  'mergeQueue',
  'mergeQueueRefs',
  'asyncMerge',
  'asyncMergeResult',
  'asyncMergeStaysPending',
  'asyncMergeAlreadyQueued',
] as const

/**
 * The primary repository's own slice, which is the top-level state itself.
 *
 * The slice reads and writes the state that is saved, rather than a copy of it taken when
 * the request began: a pull request number this repository hands out has to be the number
 * the next request already knows, and a copy would hand out the same one twice.
 */
function primaryPulls(state: GitHubFixtureState): GitHubFixtureRepositoryState {
  const slice = {} as GitHubFixtureRepositoryState
  const source = state as unknown as Record<string, unknown>
  for (const key of REPOSITORY_SLICE_KEYS) {
    Object.defineProperty(slice, key, {
      enumerable: true,
      configurable: true,
      get: () => source[key],
      set: (value: unknown) => {
        source[key] = value
      },
    })
  }
  return slice
}

/**
 * The real bare repository behind one of the repositories this host serves.
 *
 * Every repository is its own Git repository, so a fork's head, a foreign pull request and
 * the base they are compared with are objects Git reads itself. A repository that names no
 * bare repository of its own has no commits, and saying so keeps an unregistered
 * repository from being answered out of somebody else's objects.
 */
function hostFor(repository: GitHubFixtureRepository, state: GitHubFixtureState): HostRepository {
  if (repository.bare) {
    const host: HostRepository = {
      fullName: repository.fullName,
      bare: repository.bare,
    }
    // A fork reads its parent's objects, the way GitHub's fork network does, so the
    // comparison across the fork boundary is still Git's own.
    const parent = repository.forkOf ? repositoryEntry(state, repository.forkOf) : null
    if (parent?.bare) host.alternates = [parent.bare]
    return host
  }
  const bare = process.env.GIT_STACKS_FIXTURE_BARE
  if (!bare) throw new Error('GIT_STACKS_FIXTURE_BARE is required by the GitHub API double')
  return { fullName: repository.fullName, bare }
}

/**
 * The role an account holds on a repository: the owner administers it, a grant names the
 * role, and anybody else has none of them at all.
 */
function roleOf(repository: GitHubFixtureRepository, login: string): GitHubFixtureRole | null {
  if (repository.owner.toLowerCase() === login.toLowerCase()) return 'admin'
  const granted = repository.permissions[login.toLowerCase()]
  if (granted) return granted
  // A repository whose grants the fixture does not model has granted nothing to anybody,
  // and refusing every account that is not its owner would hide a repository that exists.
  // As soon as one grant is registered, or the repository is private, the grants decide.
  if (!repository.private && Object.keys(repository.permissions).length === 0) return 'admin'
  return null
}

/**
 * The state one repository's request is served from.
 *
 * Everything a repository answers for lives in its own slice, and the primary repository's
 * slice is the top-level state. A pull request, a comment and a counter therefore come
 * from the repository the request named, and a number it hands out is the number the next
 * request already has.
 */
function scopeState(
  state: GitHubFixtureState,
  repository: GitHubFixtureRepository,
): GitHubFixtureState {
  const slice = repository.pulls as unknown as Record<string, unknown>
  const scoped = {
    ...state,
    ...slice,
    repository: {
      ...state.repository,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      description: repository.description ?? null,
      topics: repository.topics ?? [],
    },
  } as GitHubFixtureState
  for (const key of REPOSITORY_SLICE_KEYS) {
    Object.defineProperty(scoped, key, {
      enumerable: true,
      configurable: true,
      get: () => slice[key],
      set: (value: unknown) => {
        slice[key] = value
      },
    })
  }
  return scoped
}

/**
 * Clearing one repository-scoped fact, the way every other mutation here reaches the
 * state that gets saved.
 *
 * `delete` cannot do this job: these routes answer from a scoped view whose keys are
 * accessors onto the repository's own slice, and deleting removes the accessor from the
 * view rather than the value behind it. The request then answers from a merge that no
 * longer exists while the state that is saved still holds one enqueued, which is the
 * host disagreeing with itself a moment later. Assigning `undefined` writes through the
 * accessor, and a key whose value is undefined is not serialized at all.
 */
function clearScopedFact(state: GitHubFixtureState, key: string): void {
  ;(state as unknown as Record<string, unknown>)[key] = undefined
}

/**
 * The scoped state one account's request is served from, with that account's real role.
 *
 * A repository the fixture manages permissions for reports the role the account actually
 * holds, because a collaborator who was never granted anything and an administrator are
 * not the same reader. A repository the fixture does not manage keeps whatever role its
 * state names, so every test written before permissions existed keeps its meaning.
 */
function scopedStateFor(
  state: GitHubFixtureState,
  repository: GitHubFixtureRepository,
  viewer: string,
): GitHubFixtureState {
  const scoped = scopeState(state, repository)
  const managed = repository.private || Object.keys(repository.permissions).length > 0
  if (!managed) return scoped
  scoped.checks = { ...scoped.checks, viewerPermissions: roleFlags(roleOf(repository, viewer)) }
  return scoped
}

function currentHead(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
): string | null {
  const head = repositoryEntry(state, pr.headRepository)
  if (!head) {
    pr.headOid = null
    return null
  }
  const oid = withHostRepository(hostFor(head, state), () => hostRefSha(`refs/heads/${pr.head}`))
  pr.headOid = oid
  return oid
}

/**
 * Whether Git can merge this pull request, asked of Git itself.
 *
 * `merge-tree` writes the merge it would perform and reports a conflict instead, so the
 * answer comes from the same objects the branches are made of. A host that answered from
 * the pull request's own flags would admit a merge Git cannot perform and refuse one it
 * can.
 */
function mergeConflict(state: GitHubFixtureState, pr: GitHubFixtureState['prs'][number]): boolean {
  const head = repositoryEntry(state, pr.headRepository)
  const base = repositoryEntry(state, state.repository.owner + '/' + state.repository.name)
  if (!head || !base) return false
  const headOid = currentHead(state, pr)
  const baseOid = withHostRepository(hostFor(base, state), () =>
    hostRefSha(`refs/heads/${pr.base}`),
  )
  if (!headOid || !baseOid) return false
  return !withHostRepository(hostFor(base, state), () =>
    hostGitSucceeds(['merge-tree', '--write-tree', baseOid, headOid]),
  )
}

function checkEntry(pr: GitHubFixtureState['prs'][number]) {
  if (pr.checks === 'passing') return { state: 'SUCCESS' }
  if (pr.checks === 'failing') return { state: 'FAILURE' }
  if (pr.checks === 'pending') return { state: 'PENDING' }
  return null
}

function graphPullRequest(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
  withBody: boolean,
) {
  const merged = pr.state === 'MERGED'
  const value: Record<string, unknown> = {
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRefName: pr.head,
    headRefOid: currentHead(state, pr),
    baseRefName: pr.base,
    isDraft: pr.draft === true,
    state: pr.state,
    reviewDecision: pr.reviewDecision || null,
    mergeStateStatus: pr.mergeState || null,
    headRepository: { nameWithOwner: pr.headRepository },
    mergeCommit: merged && pr.mergeOid ? { oid: pr.mergeOid } : null,
    commits: { nodes: [] },
  }
  const checks = checkEntry(pr)
  if (checks)
    (value.commits as { nodes: unknown[] }).nodes.push({ commit: { statusCheckRollup: checks } })
  if (withBody) value.body = pr.body || ''
  return value
}

function restPullRequest(state: GitHubFixtureState, pr: GitHubFixtureState['prs'][number]) {
  const merged = pr.state === 'MERGED'
  const stack = (state.stacks ?? []).find((s) =>
    s.pull_requests.some((p) => p.number === pr.number),
  )
  let stackObj: Record<string, unknown> | null = null
  if (stack) {
    const position = stack.pull_requests.findIndex((p) => p.number === pr.number) + 1
    stackObj = {
      id: stack.id,
      number: stack.number,
      url: stack.url,
      size: stack.pull_requests.length,
      position,
      base: position === 1 ? stack.base.ref : stack.pull_requests[position - 2].head.ref,
    }
  }
  // The fields a parser reads to decide whether a merge is even possible. `mergeable_state`
  // is derived from the same rules the merge endpoint enforces, so the read and the write
  // cannot disagree about a blocked pull request.
  const blocked = !merged && ruleSetRefusal(state, pr, currentHead(state, pr) ?? '') !== null
  return {
    number: pr.number,
    title: pr.title,
    html_url: pr.url,
    body: pr.body || '',
    state: merged ? 'closed' : pr.state.toLowerCase(),
    draft: pr.draft === true,
    user: actor(pr.author ?? state.currentUser),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    head: { ref: pr.head, sha: currentHead(state, pr), repo: { full_name: pr.headRepository } },
    // Both ends carry a commit. The application pins a paginated read by comparing the
    // comparison before and after it, and a base with no sha is unreadable rather than
    // unchanged, so a double that omitted it would fail every diff read for the wrong
    // reason.
    base: { ref: pr.base, sha: hostRefSha(`refs/heads/${pr.base}`) },
    merged,
    merged_at: pr.mergedAt,
    mergeable: !blocked,
    mergeable_state: merged ? 'unknown' : blocked ? 'blocked' : 'clean',
    merge_commit_sha: pr.mergeOid || null,
    ...(stackObj ? { stack: stackObj } : {}),
  }
}

function formatStack(
  state: GitHubFixtureState,
  stack: NonNullable<GitHubFixtureState['stacks']>[number],
) {
  return {
    id: stack.id,
    number: stack.number,
    node_id: stack.node_id,
    url: stack.url,
    base: { ref: stack.base.ref },
    open: stack.open,
    created_at: stack.created_at,
    pull_requests: stack.pull_requests.map((p) => {
      const pr = state.prs.find((entry) => entry.number === p.number)
      return {
        number: p.number,
        state: p.state,
        draft: p.draft,
        merged_at: p.merged_at,
        head: {
          ref: p.head.ref,
          sha: (pr ? currentHead(state, pr) : null) ?? p.head.sha ?? '',
        },
      }
    }),
  }
}

function actor(login: string) {
  const id = [...login].reduce(
    (hash, character) => (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    5381,
  )
  return { id, login }
}

/** The stable id GitHub reports for an account, derived from the login it signs in with. */
function accountId(login: string): number {
  return actor(login).id
}

/** Whether an account is an organization or a person, which GitHub reports per account. */
function actorType(state: GitHubFixtureState, login: string): 'User' | 'Organization' {
  return (
    (state.actors ?? []).find((entry) => entry.login.toLowerCase() === login.toLowerCase())?.type ??
    'User'
  )
}

/** Whether an account administers an organization, which is what creating for one needs. */
function administersOrganization(state: GitHubFixtureState, login: string, org: string): boolean {
  const entry = (state.actors ?? []).find(
    (candidate) => candidate.login.toLowerCase() === login.toLowerCase(),
  )
  return (
    (entry?.organizations ?? []).some(
      (organization) => organization.toLowerCase() === org.toLowerCase(),
    ) ||
    (entry?.type === 'Organization' && entry.login.toLowerCase() === org.toLowerCase())
  )
}

/** GitHub's own numeric id for a repository, stable for the name it is served under. */
function repositoryId(fullName: string): number {
  return repositoryIdentity(fullName)
}

/** The booleans GitHub reports for a repository role. */
function roleFlags(role: GitHubFixtureRole | null): {
  admin: boolean
  maintain: boolean
  push: boolean
  triage: boolean
  pull: boolean
} | null {
  if (role === null) return null
  const rank: Record<GitHubFixtureRole, number> = {
    admin: 4,
    maintain: 3,
    push: 2,
    triage: 1,
    pull: 0,
  }
  const held = rank[role]
  return {
    admin: held >= rank.admin,
    maintain: held >= rank.maintain,
    push: held >= rank.push,
    triage: held >= rank.triage,
    pull: true,
  }
}

/** The GraphQL name GitHub reports for a repository role. */
function viewerPermissionOf(
  state: GitHubFixtureState,
  repository: GitHubFixtureRepository | null,
  login: string,
): 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ' {
  if (state.checks?.viewerPermissions?.admin === true) return 'ADMIN'
  const role = repository ? roleOf(repository, login) : 'pull'
  if (role === 'admin') return 'ADMIN'
  if (role === 'maintain') return 'MAINTAIN'
  if (role === 'push') return 'WRITE'
  if (role === 'triage') return 'TRIAGE'
  return 'READ'
}

/** The repository as a nested object, the way a fork reports the one it came from. */
function repositorySummary(repository: GitHubFixtureRepository) {
  return {
    id: repositoryId(repository.fullName),
    node_id: `R_${repository.fullName}`,
    name: repository.name,
    full_name: repository.fullName,
    owner: actor(repository.owner),
    private: repository.private,
    fork: Boolean(repository.forkOf),
    default_branch: repository.defaultBranch,
    url: `https://api.github.com/repos/${repository.fullName}`,
    html_url: `https://github.com/${repository.fullName}`,
  }
}

function findPr(state: GitHubFixtureState, number: number) {
  const pr = state.prs.find((entry) => entry.number === number)
  if (!pr) throw new HttpError(404, 'Not Found', `No pull request found for number ${number}`)
  return pr
}

function nextNumber(state: GitHubFixtureState): number {
  const number = Number.isInteger(state.nextNumber) ? state.nextNumber : 1
  state.nextNumber = number + 1
  return number
}

function mergePullRequest(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
  fields: Record<string, unknown>,
): { merged: boolean; message: string; sha: string | null } {
  const requestedSha = fields.sha
  const method = String(fields.merge_method || '')
  const allowed: Record<string, boolean> = {
    merge: state.repository.allowMergeCommit === true,
    squash: state.repository.allowSquashMerge === true,
    rebase: state.repository.allowRebaseMerge === true,
  }
  if (!allowed[method])
    return { merged: false, message: `merge method ${method} is disabled`, sha: null }
  const head = currentHead(state, pr)
  // GitHub's `sha` is the commit the head "must match" for the merge to be allowed, and
  // it is optional: a request that names no sha merges the head the pull request has
  // now. Requiring one would refuse a merge GitHub performs, which is how a scenario
  // that merges outside the app comes to be impossible to stage.
  if (!head || (requestedSha !== undefined && requestedSha !== head))
    return { merged: false, message: 'head SHA no longer matches', sha: null }
  if (pr.state !== 'OPEN') return { merged: false, message: 'pull request is not open', sha: null }
  // A stacked merge lands every pull request of the group on the branch the bottom one
  // targets, which is how GitHub merges a stack; no branch inside the stack moves.
  const baseName = typeof fields.base === 'string' ? fields.base : pr.base
  const baseRef = `refs/heads/${baseName}`
  const base = hostRefSha(baseRef)
  if (!base) return { merged: false, message: `base branch ${baseName} is missing`, sha: null }
  // The head tree lives in the repository the head branch lives in, which for a fork is
  // not the repository the merge commit is created in.
  const headRepository = repositoryEntry(state, pr.headRepository)
  const tree = headRepository
    ? withHostRepository(hostFor(headRepository, state), () =>
        hostGit(['rev-parse', `${head}^{tree}`]),
      )
    : hostGit(['rev-parse', `${head}^{tree}`])
  const parents = method === 'merge' ? ['-p', base, '-p', head] : ['-p', base]
  const mergedOid = hostGit(
    ['commit-tree', tree, ...parents, '-m', `${pr.title} (#${pr.number})`],
    {
      GIT_AUTHOR_NAME: 'GitHub Fixture',
      GIT_AUTHOR_EMAIL: 'github-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'GitHub Fixture',
      GIT_COMMITTER_EMAIL: 'github-fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  )
  hostGit(['update-ref', baseRef, mergedOid, base])
  pr.state = 'MERGED'
  pr.mergedAt = new Date().toISOString()
  pr.mergeOid = mergedOid
  return { merged: true, sha: mergedOid, message: 'Pull Request successfully merged' }
}

/**
 * A stacked pull request's merge includes every open pull request below it in the same stack,
 * which is what the asynchronous merge endpoint documents. The downstack is merged first so
 * the upstack request lands on the same base it was reviewed against.
 */
function mergeStackedPullRequest(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
  sha: string,
  method: string,
) {
  const stack = (state.stacks ?? []).find((s) =>
    s.pull_requests.some((p) => p.number === pr.number),
  )
  if (!stack) return mergePullRequest(state, pr, { sha, merge_method: method })
  const order = stack.pull_requests.map((p) => p.number)
  const position = order.indexOf(pr.number)
  let last: { merged: boolean; message: string; sha: string | null } = {
    merged: false,
    message: 'no downstack pull request was merged',
    sha: null,
  }
  // GitHub merges a stack into the branch its bottom pull request targets, so no branch
  // inside the group is rewritten and the retargeting it does afterwards is observable.
  const bottom = state.prs.find((entry) => entry.number === order[0])
  const stackBase = bottom?.base ?? pr.base
  for (const number of order.slice(0, position + 1)) {
    const member = state.prs.find((entry) => entry.number === number)
    if (!member || member.state !== 'OPEN') continue
    last =
      number === pr.number
        ? mergePullRequest(state, member, { sha, merge_method: method, base: stackBase })
        : mergePullRequest(state, member, {
            sha: currentHead(state, member),
            merge_method: method === 'rebase' ? 'squash' : method,
            base: stackBase,
          })
    if (!last.merged) break
  }
  return last
}

function etagFor(body: unknown): string {
  return `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
}

function checkRunResponse(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  headSha: string,
): RestResult {
  const runs = (state.checks?.checkRuns ?? []).filter((run) => run.headSha === headSha)
  const body = {
    total_count: runs.length,
    check_runs: paginate(runs, queryStringOf(request.path)).map((run) => ({
      id: run.id,
      head_sha: run.headSha,
      node_id: `CR_${run.id}`,
      external_id: null,
      url: `https://api.github.com/repos/acme/widgets/check-runs/${run.id}`,
      html_url: `https://github.com/acme/widgets/runs/${run.id}`,
      details_url: run.detailsUrl ?? null,
      status: run.status,
      conclusion: run.conclusion,
      started_at: run.startedAt ?? null,
      completed_at: run.completedAt ?? null,
      output: { title: run.title ?? null, summary: null, text: null, annotations_count: 0 },
      name: run.name,
      check_suite: { id: run.checkSuiteId ?? 1 },
      app: run.appSlug
        ? {
            id: run.appId ?? (run.appSlug === 'github-actions' ? 15368 : 1),
            slug: run.appSlug,
            name: run.appSlug,
          }
        : null,
      pull_requests: [],
    })),
  }
  return { status: 200, body, ...conditional(state, request, body) }
}

function commitStatusResponse(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  headSha: string,
): RestResult {
  const statuses = (state.checks?.commitStatuses ?? []).filter((entry) => entry.headSha === headSha)
  const body = {
    state: statuses.some((entry) => entry.state === 'failure' || entry.state === 'error')
      ? 'failure'
      : statuses.some((entry) => entry.state === 'pending')
        ? 'pending'
        : 'success',
    statuses: paginate(statuses, queryStringOf(request.path)).map((entry) => ({
      description: entry.description ?? null,
      id: 900_000,
      node_id: 'CS_1',
      state: entry.state,
      context: entry.context,
      target_url: entry.targetUrl ?? null,
      url: `https://api.github.com/repos/acme/widgets/statuses/900000`,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })),
    sha: headSha,
    total_count: statuses.length,
  }
  return { status: 200, body, ...conditional(state, request, body) }
}

function workflowRunsResponse(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  headSha: string | null,
): RestResult {
  const runs = (state.checks?.workflowRuns ?? []).filter(
    (run) => headSha === null || run.headSha === headSha,
  )
  const body = {
    total_count: runs.length,
    workflow_runs: paginate(runs, queryStringOf(request.path)).map((run) => ({
      id: run.id,
      name: run.name,
      node_id: `WR_${run.id}`,
      head_branch: null,
      head_sha: run.headSha,
      path: '.github/workflows/ci.yml',
      run_number: run.runNumber ?? run.id,
      run_attempt: 1,
      event: run.event ?? 'pull_request',
      check_suite_id: run.checkSuiteId ?? 1,
      status: run.status,
      conclusion: run.conclusion,
      workflow_id: 1,
      url: `https://api.github.com/repos/acme/widgets/actions/runs/${run.id}`,
      html_url: run.htmlUrl ?? `https://github.com/acme/widgets/actions/runs/${run.id}`,
      pull_requests: (
        run.pullRequests ??
        state.prs.filter((pr) => pr.headOid === run.headSha).map((pr) => pr.number)
      ).map((number) => ({ number })),
      created_at: '2026-01-01T00:00:00Z',
      updated_at: run.updatedAt ?? '2026-01-01T00:01:00Z',
      run_started_at: run.startedAt ?? '2026-01-01T00:00:00Z',
      jobs_url: `https://api.github.com/repos/acme/widgets/actions/runs/${run.id}/jobs`,
      logs_url: `https://api.github.com/repos/acme/widgets/actions/runs/${run.id}/logs`,
      rerun_url: `https://api.github.com/repos/acme/widgets/actions/runs/${run.id}/rerun`,
    })),
  }
  return { status: 200, body, ...conditional(state, request, body) }
}

function conditional(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  body: unknown,
): { status?: number; body?: unknown; headers?: Record<string, string> } {
  if (!state.checks?.conditional) return {}
  const etag = etagFor(body)
  if (request.headers['if-none-match'] === etag) {
    return { status: 304, body: null, headers: { etag } }
  }
  return { headers: { etag } }
}

/** A canned failure for every native-stacks endpoint, used to prove probe error propagation. */
function stacksFailure(state: GitHubFixtureState): HttpError | null {
  const failure = state.stacksFailure
  if (!failure) return null
  return new HttpError(
    failure.status,
    failure.reason,
    failure.message,
    failure.rateLimitRemaining === undefined
      ? {}
      : { 'x-ratelimit-remaining': String(failure.rateLimitRemaining) },
  )
}

function createPullRequest(
  state: GitHubFixtureState,
  body: Record<string, unknown>,
  viewer: string,
) {
  const head = String(body.head || '')
  const separator = head.indexOf(':')
  const owner = separator >= 0 ? head.slice(0, separator) : state.repository.owner
  const branch = separator >= 0 ? head.slice(separator + 1) : head
  // `head` names the branch and the account it lives under, which for a fork is not the
  // repository this pull request belongs to. Resolving that account to a repository this
  // host actually serves is what keeps a forked or foreign head from being answered out of
  // the base repository's refs.
  const headRepository =
    repositoryEntry(state, `${owner}/${state.repository.name}`) ??
    registryOf(state).find((entry) => entry.owner.toLowerCase() === owner.toLowerCase())
  if (!headRepository) {
    throw new HttpError(422, 'Unprocessable Entity', `head repository ${owner} is unknown`)
  }
  const headHost = hostFor(headRepository, state)
  const headOid = withHostRepository(headHost, () => hostRefSha(`refs/heads/${branch}`))
  if (!headOid) throw new HttpError(422, 'Unprocessable Entity', `head branch ${branch} is missing`)
  const base = String(body.base || '')
  const baseOid = hostRefSha(`refs/heads/${base}`)
  if (!baseOid) throw new HttpError(422, 'Unprocessable Entity', `base branch ${base} is missing`)
  // A pull request is the commits its head has that its base does not. Both refs existing
  // says nothing about that: a branch cut from the base and left alone has both refs and
  // no commits at all, which GitHub refuses with `No commits between base and head`. The
  // count is Git's own, read across the two repositories when the head is a fork.
  const comparison = withHostRepository(headHost, () =>
    hostGitOrNull(['rev-list', '--count', `${baseOid}..${headOid}`]),
  )
  if (comparison === null) {
    throw new HttpError(
      422,
      'Unprocessable Entity',
      `base branch ${base} has no history in common with ${branch}`,
    )
  }
  if (Number(comparison) === 0) {
    throw new HttpError(
      422,
      'Unprocessable Entity',
      `No commits between ${state.repository.owner}:${base} and ${headRepository.owner}:${branch}`,
    )
  }
  if (state.prs.some((pr) => pr.head === branch && pr.state === 'OPEN'))
    throw new HttpError(422, 'Unprocessable Entity', `a pull request for ${branch} already exists`)
  const number = nextNumber(state)
  const pr = {
    number,
    title: String(body.title || ''),
    body: String(body.body || ''),
    base,
    head: branch,
    headRepository: headRepository.fullName,
    draft: body.draft === true,
    state: 'OPEN' as const,
    checks: 'none' as const,
    reviewDecision: null as string | null,
    mergeState: 'CLEAN' as string | null,
    url: `https://github.com/${state.repository.owner}/${state.repository.name}/pull/${number}`,
    headOid,
    mergeOid: null as string | null,
    mergedAt: null as string | null,
    author: viewer,
  }
  state.prs.push(pr)
  if (!state.comments) state.comments = {}
  state.comments[String(number)] = []
  return pr
}

function commentResponse(
  state: GitHubFixtureState,
  comment: { id: number; body: string; user?: { login: string }; author?: string },
) {
  return {
    ...comment,
    user: actor(comment.user?.login || comment.author || state.currentUser),
  }
}

function handleRest(state: GitHubFixtureState, request: GitHubApiDoubleRequest): RestResult {
  const { method, path } = request
  const body = request.body
  const [rawPath, rawQuery] = path.split('?')
  const queryParams = new URLSearchParams(rawQuery ?? '')
  const account = handleAccountRoutes(state, request, rawPath)
  if (account) return account
  // Every `repos/{owner}/{name}` request is served by that repository: its own refs, its
  // own pull request numbers, its own reviews and its own rules. Serving it from the
  // repository the fixture started with would make a fork, and a repository that belongs
  // to somebody else, indistinguishable from the default one.
  const routed = /^repos\/([^/]+)\/([^/]+)(\/|$)/u.exec(rawPath)
  if (routed) {
    const fullName = `${routed[1]}/${routed[2]}`
    const served = repositoryEntry(state, fullName)
    // A repository this host does not serve, and one this account may not see, are the
    // same answer: GitHub does not confirm the existence of a private repository.
    if (!served || roleOf(served, request.viewer) === null) {
      throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
    }
    const repository = fullName
    const prefix = `repos/${repository}`
    return withHostRepository(hostFor(served, state), () =>
      serveRepositoryRoutes(
        scopedStateFor(state, served, request.viewer),
        request,
        repository,
        prefix,
        rawPath,
        rawQuery,
        queryParams,
      ),
    )
  }
  // A path that names no repository is GitHub's 404 rather than a repository with no data.
  throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
}

/**
 * The routes that belong to an account rather than to a repository: who is asking, which
 * repositories it can see, which organizations it administers, and the invitations it has
 * to accept. Creating a repository is here too, because GitHub creates it for the account
 * the request authenticated as rather than for a repository.
 */
function handleAccountRoutes(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  rawPath: string,
): RestResult | null {
  const { method, body } = request
  const viewer = request.viewer
  if (rawPath === 'user') {
    return {
      status: 200,
      body: {
        ...actor(viewer),
        type: actorType(state, viewer),
        url: `https://github.com/${viewer}`,
      },
    }
  }
  if (rawPath === 'user/repos') {
    if (method === 'GET') {
      const visible = [primaryFullName(state), ...registryOf(state).map((entry) => entry.fullName)]
        .map((fullName) => repositoryEntry(state, fullName))
        .filter((entry): entry is GitHubFixtureRepository => entry !== null)
        .filter((entry) => roleOf(entry, viewer) !== null)
        .map((entry) => repositorySummary(entry))
      return { status: 200, body: paginate(visible, queryStringOf(request.path)) }
    }
    if (method !== 'POST')
      throw new HttpError(405, 'Method Not Allowed', 'user repositories are read here')
    return { status: 201, body: createRepositoryFor(state, body, viewer, viewer) }
  }
  const membership = new RegExp(`^user/memberships/orgs/([^/]+)$`, 'u').exec(rawPath)
  if (membership) {
    const org = decodeURIComponent(membership[1])
    if (!administersOrganization(state, viewer, org)) {
      throw new HttpError(404, 'Not Found', `Not Found: ${rawPath}`)
    }
    return {
      status: 200,
      body: { state: 'active', role: 'admin', organization: { login: org } },
    }
  }
  const invitations = new RegExp(`^user/repository_invitations(?:/(\\d+))?$`, 'u').exec(rawPath)
  if (invitations) {
    const pending = allRepositories(state).flatMap((entry) =>
      entry.invitations
        .filter(
          (invitation) =>
            invitation.state === 'pending' &&
            invitation.login.toLowerCase() === viewer.toLowerCase(),
        )
        .map((invitation) => ({
          id: invitation.id,
          repository: { full_name: invitation.repository },
          invitee: actor(viewer),
          permissions: invitation.permission,
          created_at: '2026-01-01T00:00:00Z',
        })),
    )
    if (method === 'GET') return { status: 200, body: pending }
    if (!invitations[1] || method !== 'PATCH')
      throw new HttpError(405, 'Method Not Allowed', 'an invitation is accepted with PATCH')
    const id = Number(invitations[1])
    const target = pending.find((entry) => entry.id === id)
    if (!target) throw new HttpError(404, 'Not Found', `Invitation ${id} not found`)
    const repository = repositoryEntry(
      state,
      String((target.repository as { full_name: string }).full_name),
    )
    const invitation = repository?.invitations.find((entry) => entry.id === id)
    if (!repository || !invitation) {
      throw new HttpError(404, 'Not Found', `Invitation ${id} not found`)
    }
    // Accepting grants the role the invitation named. Until it is accepted the account can
    // still not read the repository, which is the whole point of an invitation.
    const permission =
      body.permissions === undefined ? invitation.permission : String(body.permissions)
    repository.permissions[viewer] = permission as GitHubFixtureRole
    invitation.state = 'accepted'
    return { status: 204, body: null }
  }
  const organization = new RegExp(`^orgs/([^/]+)(/repos)?$`, 'u').exec(rawPath)
  if (organization) {
    const org = decodeURIComponent(organization[1])
    if (actorType(state, org) !== 'Organization') {
      throw new HttpError(404, 'Not Found', `Not Found: ${rawPath}`)
    }
    if (!organization[2]) {
      return {
        status: 200,
        body: {
          ...actor(org),
          type: 'Organization',
          url: `https://github.com/${org}`,
          description: `${org} on the controlled host`,
        },
      }
    }
    if (method !== 'POST')
      throw new HttpError(405, 'Method Not Allowed', 'organization repositories are read here')
    if (!administersOrganization(state, viewer, org)) {
      throw new HttpError(403, 'Forbidden', 'Must have admin rights to Repository.')
    }
    return { status: 201, body: createRepositoryFor(state, body, viewer, org) }
  }
  return null
}

/**
 * The login a credential authenticates as, or `null` when it authenticates nobody.
 *
 * Every account is registered with the one credential that stands for it, so two accounts
 * are two identities on the wire and a credential from anywhere else is not served at all.
 * A state that registers no accounts is answered by the two accounts this fixture has
 * always had, so every test that writes its own state keeps its meaning.
 */
function authenticate(state: GitHubFixtureState, token: string): string | null {
  const registered = state.actors
  if (registered) {
    return registered.find((entry) => entry.token === token)?.login ?? null
  }
  if (token === 'fixture-token') return state.currentUser
  if (token === 'fixture-reviewer-token') return 'reviewer'
  return null
}

/** Every repository this host serves, the fixture's own first. */
function allRepositories(state: GitHubFixtureState): GitHubFixtureRepository[] {
  return [primaryFullName(state), ...registryOf(state).map((entry) => entry.fullName)]
    .map((fullName) => repositoryEntry(state, fullName))
    .filter((entry): entry is GitHubFixtureRepository => entry !== null)
}

/** The directory whose `<owner>/<name>.git` subdirectories this host serves Git from. */
function servedProjectsRoot(): string {
  const bare = process.env.GIT_STACKS_FIXTURE_BARE
  if (!bare) throw new Error('GIT_STACKS_FIXTURE_BARE is required by the GitHub API double')
  return dirname(dirname(bare))
}

/**
 * Creates a repository with its own real bare repository, for `owner`.
 *
 * The caller has already decided who owns it: the account the request authenticated as, or
 * the organization that account administers. Nothing else may create a repository for
 * somebody, which is what keeps a repository's owner the account that can administer it.
 */
function createRepositoryFor(
  state: GitHubFixtureState,
  body: Record<string, unknown>,
  viewer: string,
  owner: string,
): Record<string, unknown> {
  const name = String(body.name ?? '')
  if (name === '') throw new HttpError(422, 'Unprocessable Entity', 'name is required')
  const fullName = `${owner}/${name}`
  if (repositoryEntry(state, fullName)) {
    throw new HttpError(422, 'Unprocessable Entity', `repository ${fullName} already exists`)
  }
  const defaultBranch = typeof body.default_branch === 'string' ? body.default_branch : 'main'
  const bare = join(servedProjectsRoot(), `${fullName}.git`)
  mkdirSync(dirname(bare), { recursive: true })
  createServedBareRepository({ git: realGit(), bare, defaultBranch })
  const repository: GitHubFixtureRepository = {
    fullName,
    owner,
    name,
    bare,
    private: body.private === true,
    defaultBranch,
    description: typeof body.description === 'string' ? body.description : null,
    topics: Array.isArray(body.topics) ? body.topics.map(String) : [],
    permissions: { [owner]: 'admin' },
    invitations: [],
    pulls: {
      prs: [],
      comments: {},
      stacks: [],
      issues: [],
      nextNumber: 1,
      nextCommentId: 1,
    },
  }
  // The account that created it holds its administration, which for an organization
  // repository is the account that administers the organization rather than the
  // organization itself.
  if (viewer.toLowerCase() !== owner.toLowerCase()) repository.permissions[viewer] = 'admin'
  registryOf(state).push(repository)
  return {
    ...repositorySummary(repository),
    description: repository.description,
    topics: repository.topics,
    allow_merge_commit: state.repository.allowMergeCommit === true,
    allow_squash_merge: state.repository.allowSquashMerge === true,
    allow_rebase_merge: state.repository.allowRebaseMerge === true,
    permissions: roleFlags(roleOf(repository, viewer)) ?? undefined,
  }
}
/**
 * The routes of one repository, served from that repository's own state and refs.
 *
 * Every `repos/{owner}/{name}` request arrives here with the repository already resolved,
 * so a route never has to ask which repository it is answering for, and a number, a rule
 * or a ref always belongs to the repository that owns it.
 */
function serveRepositoryRoutes(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  repository: string,
  prefix: string,
  rawPath: string,
  rawQuery: string | undefined,
  queryParams: URLSearchParams,
): RestResult {
  // The review, thread, ruleset, and ref routes belong to the live suite's surface module.
  // A route it does not recognise falls through to the handlers below, so the original
  // double keeps every route it already owned.
  const surface = handleSurfaceRest(state, request, request.viewer)
  if (surface) return surface
  const { method, path } = request
  const body = request.body
  const served = repositoryEntry(state, repository)
  const role = served ? roleOf(served, request.viewer) : null
  const collaborators = new RegExp(
    `^${prefix}/collaborators(?:/([^/]+))?(?:/(permission))?$`,
    'u',
  ).exec(rawPath)
  if (collaborators) {
    // Reading who holds what needs access to the repository, and changing who holds what
    // needs administration of it. GitHub answers the read for a collaborator who was let
    // in with push and refuses the write, so a host that refused both would make a second
    // reviewer unable to prove it can read a repository it has already been given.
    if (!served) throw new HttpError(404, 'Not Found', `Not Found: ${rawPath}`)
    if (method === 'GET' ? role === null : role !== 'admin') {
      throw new HttpError(403, 'Forbidden', 'Must have admin rights to Repository.')
    }
    if (!collaborators[1]) {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', 'collaborators are read')
      return {
        status: 200,
        body: Object.entries(served.permissions).map(([login, permission]) => ({
          login,
          role_name: permission,
          permissions: roleFlags(permission),
        })),
      }
    }
    const login = decodeURIComponent(collaborators[1])
    if (collaborators[2]) {
      if (method !== 'GET')
        throw new HttpError(405, 'Method Not Allowed', 'a permission is read with GET')
      // A grant is looked up the way every other role on this host is looked up, so a
      // login written in either case names the same account.
      const held = served.permissions[login.toLowerCase()]
      if (!held) throw new HttpError(404, 'Not Found', `Not Found: ${rawPath}`)
      return { status: 200, body: { permission: held, role_name: held, user: actor(login) } }
    }
    if (method === 'PUT') {
      const permission = String(body.permission ?? 'push') as GitHubFixtureRole
      if (!(permission in WRITING_ROLES)) {
        throw new HttpError(422, 'Unprocessable Entity', `unknown permission ${permission}`)
      }
      // The account this host answers as administers the repository. A repository whose
      // access came only from the "no grants registered yet" shortcut would lose that
      // administration the instant any grant is written down, which is how letting a
      // second reviewer in silently locked the owner out of their own repository.
      if (Object.keys(served.permissions).length === 0) {
        served.permissions[state.currentUser.toLowerCase()] = 'admin'
      }
      if (served.permissions[login.toLowerCase()]) {
        served.permissions[login.toLowerCase()] = permission
        return { status: 204, body: null }
      }
      // An account that has not accepted holds nothing yet: the invitation exists, and the
      // role is granted when it is accepted. Granting it now would make the acceptance
      // meaningless and a private repository would read to an outsider.
      const id = (state.nextInvitationId ?? 1000) + 1
      state.nextInvitationId = id
      served.invitations.push({ id, repository, login, permission, state: 'pending' })
      return {
        status: 201,
        body: {
          id,
          repository: { full_name: repository },
          invitee: actor(login),
          permissions: permission,
          created_at: '2026-01-01T00:00:00Z',
        },
      }
    }
    if (method === 'DELETE') {
      delete served.permissions[login.toLowerCase()]
      served.invitations = served.invitations.filter(
        (entry) => entry.login.toLowerCase() !== login.toLowerCase(),
      )
      return { status: 204, body: null }
    }
    throw new HttpError(405, 'Method Not Allowed', 'unsupported collaborators method')
  }
  if (rawPath === `${prefix}/invitations`) {
    if (!served || role !== 'admin')
      throw new HttpError(403, 'Forbidden', 'Must have admin rights to Repository.')
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', 'invitations are read')
    return {
      status: 200,
      body: served.invitations
        .filter((entry) => entry.state === 'pending')
        .map((entry) => ({
          id: entry.id,
          repository: { full_name: entry.repository },
          invitee: actor(entry.login),
          permissions: entry.permission,
          created_at: '2026-01-01T00:00:00Z',
        })),
    }
  }
  if (rawPath === `${prefix}/forks`) {
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed', 'forks are created')
    if (!served || role === null) {
      throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
    }
    const owner = typeof body.organization === 'string' ? body.organization : request.viewer
    if (
      typeof body.organization === 'string' &&
      !administersOrganization(state, request.viewer, owner)
    ) {
      throw new HttpError(403, 'Forbidden', 'Must have admin rights to Organization.')
    }
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : served.name
    const fullName = `${owner}/${name}`
    if (owner.toLowerCase() === served.owner.toLowerCase()) {
      throw new HttpError(
        422,
        'Unprocessable Entity',
        `a fork cannot be owned by the account that owns ${repository}`,
      )
    }
    if (repositoryEntry(state, fullName)) {
      throw new HttpError(422, 'Unprocessable Entity', `repository ${fullName} already exists`)
    }
    const bare = join(servedProjectsRoot(), `${fullName}.git`)
    mkdirSync(dirname(bare), { recursive: true })
    // A fork carries the history it was made from: fetching the parent's refs is what makes
    // a pull request from the fork a real comparison of two repositories.
    createServedBareRepository({
      git: realGit(),
      bare,
      defaultBranch: served.defaultBranch,
      forkOf: served.bare,
    })
    const fork: GitHubFixtureRepository = {
      fullName,
      owner,
      name,
      bare,
      private: served.private,
      defaultBranch: served.defaultBranch,
      forkOf: served.fullName,
      description: served.description ?? null,
      topics: [],
      permissions: { [owner]: 'admin' },
      invitations: [],
      pulls: { prs: [], comments: {}, stacks: [], issues: [], nextNumber: 1, nextCommentId: 1 },
    }
    registryOf(state).push(fork)
    return {
      status: 202,
      body: {
        ...repositorySummary(fork),
        parent: repositorySummary(served),
        source: repositorySummary(served),
      },
    }
  }
  if (rawPath === prefix && method === 'DELETE') {
    if (!served || role !== 'admin')
      throw new HttpError(403, 'Forbidden', 'Must have admin rights to Repository.')
    const registry = registryOf(state)
    const index = registry.findIndex(
      (entry) => entry.fullName.toLowerCase() === repository.toLowerCase(),
    )
    if (index !== -1) {
      const [removed] = registry.splice(index, 1)
      rmSync(removed.bare, { recursive: true, force: true })
      return { status: 204, body: null }
    }
    throw new HttpError(403, 'Forbidden', 'the fixture repository cannot be deleted here')
  }

  if (rawPath.startsWith(`${prefix}/stacks`)) {
    if (state.stacksPreviewDisabled) {
      throw new HttpError(404, 'Not Found', 'Not Found: stacks preview unavailable')
    }
    // Reads still work: a chain write GitHub rejects is a submission failure, not a
    // repository that cannot report anything.
    if (method !== 'GET') {
      const failure = stacksFailure(state)
      if (failure) throw failure
    }
    if (rawPath === `${prefix}/stacks`) {
      if (method === 'GET') {
        let stacks = state.stacks ?? []
        if (queryParams.has('pull_request')) {
          const prNum = Number(queryParams.get('pull_request'))
          stacks = stacks.filter((s) => s.pull_requests.some((p) => p.number === prNum))
        }
        const perPage = Number(queryParams.get('per_page')) || 30
        const page = Number(queryParams.get('page')) || 1
        const start = (page - 1) * perPage
        const paginated = stacks.slice(start, start + perPage)
        return { status: 200, body: paginated.map((s) => formatStack(state, s)) }
      }
      if (method === 'POST') {
        const pullRequestsInput = body.pull_requests
        if (!Array.isArray(pullRequestsInput) || pullRequestsInput.length === 0) {
          throw new HttpError(
            422,
            'Unprocessable Entity',
            'pull_requests must be a non-empty array',
          )
        }
        const prs = pullRequestsInput.map((num: unknown) => {
          if (typeof num !== 'number')
            throw new HttpError(422, 'Unprocessable Entity', 'invalid pull request number')
          return findPr(state, num)
        })
        const seen = new Set<number>()
        for (const pr of prs) {
          if (seen.has(pr.number))
            throw new HttpError(422, 'Unprocessable Entity', 'duplicate pull request in stack')
          seen.add(pr.number)
        }
        for (const s of state.stacks ?? []) {
          for (const pr of prs) {
            if (s.pull_requests.some((p) => p.number === pr.number)) {
              throw new HttpError(
                422,
                'Unprocessable Entity',
                `pull request #${pr.number} is already in a stack`,
              )
            }
          }
        }
        for (const pr of prs) {
          if (pr.headRepository.toLowerCase() !== repository.toLowerCase()) {
            throw new HttpError(
              422,
              'Unprocessable Entity',
              `pull request #${pr.number} is from a fork`,
            )
          }
        }
        for (let i = 1; i < prs.length; i++) {
          if (prs[i].base !== prs[i - 1].head) {
            throw new HttpError(
              422,
              'Unprocessable Entity',
              `chain invalid: PR #${prs[i].number} base ${prs[i].base} does not match PR #${prs[i - 1].number} head ${prs[i - 1].head}`,
            )
          }
        }
        const stackNumber = Number.isInteger(state.nextStackNumber) ? state.nextStackNumber!++ : 1
        const newStack = {
          id: stackNumber * 1000,
          number: stackNumber,
          node_id: `STACK_${stackNumber}`,
          url: `https://api.github.com/${prefix}/stacks/${stackNumber}`,
          base: { ref: prs[0].base },
          open: true,
          created_at: new Date().toISOString(),
          pull_requests: prs.map((pr) => ({
            number: pr.number,
            state:
              pr.state === 'MERGED' || pr.state === 'CLOSED'
                ? ('closed' as const)
                : ('open' as const),
            draft: pr.draft === true,
            merged_at: pr.mergedAt,
            head: { ref: pr.head, sha: currentHead(state, pr) ?? '' },
          })),
        }
        state.stacks = state.stacks ?? []
        state.stacks.push(newStack)
        return { status: 201, body: formatStack(state, newStack) }
      }
      throw new HttpError(405, 'Method Not Allowed', `unsupported stacks method ${method}`)
    }
    const stackMatch = new RegExp(`^${prefix}/stacks/(\\d+)$`, 'u').exec(rawPath)
    if (stackMatch) {
      const stackNum = Number(stackMatch[1])
      const stack = (state.stacks ?? []).find((s) => s.number === stackNum)
      if (!stack || (state.missingStackDetails ?? []).includes(stackNum)) {
        throw new HttpError(404, 'Not Found', `Stack #${stackNum} not found`)
      }
      if (method === 'GET') {
        return { status: 200, body: formatStack(state, stack) }
      }
      throw new HttpError(405, 'Method Not Allowed', `unsupported stack method ${method}`)
    }
    const addMatch = new RegExp(`^${prefix}/stacks/(\\d+)/(?:add|pull_requests)$`, 'u').exec(
      rawPath,
    )
    if (addMatch) {
      const stackNum = Number(addMatch[1])
      const stack = (state.stacks ?? []).find((s) => s.number === stackNum)
      if (!stack) throw new HttpError(404, 'Not Found', `Stack #${stackNum} not found`)
      if (method !== 'POST')
        throw new HttpError(405, 'Method Not Allowed', 'add pull requests requires POST')
      const pullRequestsInput = body.pull_requests
      if (!Array.isArray(pullRequestsInput) || pullRequestsInput.length === 0) {
        throw new HttpError(422, 'Unprocessable Entity', 'pull_requests must be a non-empty array')
      }
      const prs = pullRequestsInput.map((num: unknown) => {
        if (typeof num !== 'number')
          throw new HttpError(422, 'Unprocessable Entity', 'invalid pull request number')
        return findPr(state, num)
      })
      for (const pr of prs) {
        if (stack.pull_requests.some((p) => p.number === pr.number)) {
          throw new HttpError(
            422,
            'Unprocessable Entity',
            `pull request #${pr.number} is already in stack #${stackNum}`,
          )
        }
        if (pr.headRepository.toLowerCase() !== repository.toLowerCase()) {
          throw new HttpError(
            422,
            'Unprocessable Entity',
            `pull request #${pr.number} is from a fork`,
          )
        }
      }
      const topPr = stack.pull_requests[stack.pull_requests.length - 1]
      if (topPr && prs[0].base !== topPr.head.ref) {
        throw new HttpError(
          422,
          'Unprocessable Entity',
          `PR #${prs[0].number} base ${prs[0].base} does not match top of stack head ${topPr.head.ref}`,
        )
      }
      for (let i = 1; i < prs.length; i++) {
        if (prs[i].base !== prs[i - 1].head) {
          throw new HttpError(
            422,
            'Unprocessable Entity',
            `chain invalid: PR #${prs[i].number} base ${prs[i].base} does not match PR #${prs[i - 1].number} head ${prs[i - 1].head}`,
          )
        }
      }
      for (const pr of prs) {
        stack.pull_requests.push({
          number: pr.number,
          state: pr.state === 'MERGED' || pr.state === 'CLOSED' ? 'closed' : 'open',
          draft: pr.draft === true,
          merged_at: pr.mergedAt,
          head: { ref: pr.head, sha: currentHead(state, pr) ?? '' },
        })
      }
      return { status: 200, body: formatStack(state, stack) }
    }
    const unstackMatch = new RegExp(`^${prefix}/stacks/(\\d+)/unstack$`, 'u').exec(rawPath)
    if (unstackMatch) {
      const stackNum = Number(unstackMatch[1])
      const stackIdx = (state.stacks ?? []).findIndex((s) => s.number === stackNum)
      if (stackIdx === -1) throw new HttpError(404, 'Not Found', `Stack #${stackNum} not found`)
      if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed', 'unstack requires POST')
      const stack = state.stacks![stackIdx]
      const remaining = stack.pull_requests.filter(
        (p) => p.merged_at != null || p.state === 'closed',
      )
      if (remaining.length === 0) {
        state.stacks!.splice(stackIdx, 1)
        return { status: 204, body: null }
      } else {
        stack.pull_requests = remaining
        return { status: 200, body: formatStack(state, stack) }
      }
    }
    throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
  }
  if (path !== prefix && !path.startsWith(`${prefix}/`))
    throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
  if (rawPath === prefix && method === 'GET') {
    const served = repositoryEntry(state, repository)
    const parent = served?.forkOf ? repositoryEntry(state, served.forkOf) : null
    // A state that names the viewer's role reports that role; otherwise the role is
    // decided from the repository's own permissions, which is what a private repository
    // and an accepted invitation change.
    const role =
      state.checks?.viewerPermissions ?? roleFlags(served ? roleOf(served, request.viewer) : null)
    return {
      status: 200,
      body: {
        full_name: repository,
        id: repositoryId(repository),
        name: state.repository.name,
        owner: {
          login: state.repository.owner,
          id: actor(state.repository.owner).id,
          type: actorType(state, state.repository.owner),
        },
        private: served?.private === true,
        visibility: served?.private === true ? 'private' : 'public',
        // The ownership marker a disposable run stamps on the repository it created
        // lives here, so cleanup reads it back through the endpoint GitHub exposes
        // rather than through anything the run kept to itself.
        description: state.repository.description ?? null,
        // GitHub reports topics as an array of names. An object shaped like
        // `{ names: [...] }` is a shape no repository response has ever had, and a
        // consumer written against it would agree with this host and with nothing else.
        topics: state.repository.topics ?? [],
        default_branch: state.repository.defaultBranch,
        fork: parent !== null,
        ...(parent ? { parent: repositorySummary(parent), source: repositorySummary(parent) } : {}),
        allow_merge_commit: state.repository.allowMergeCommit === true,
        allow_squash_merge: state.repository.allowSquashMerge === true,
        allow_rebase_merge: state.repository.allowRebaseMerge === true,
        // GitHub only reports the viewer's own role, and only when it is authenticated.
        ...(role ? { permissions: role } : {}),
      },
    }
  }
  if (rawPath === `${prefix}/actions/permissions` && method === 'GET') {
    return {
      status: 200,
      body: {
        enabled: state.checks?.actionsEnabled === true,
        allowed_actions: 'all',
        sha_pinning_required: false,
      },
    }
  }
  const rerun = new RegExp(`^${prefix}/actions/runs/(\\d+)/rerun$`, 'u').exec(rawPath)
  if (rerun) {
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed', 'rerun requires POST')
    const runId = Number(rerun[1])
    if (state.checks?.rerunForbidden)
      throw new HttpError(403, 'Forbidden', 'Resource not accessible by integration')
    const known = (state.checks?.workflowRuns ?? []).some((entry) => entry.id === runId)
    if (!known) throw new HttpError(404, 'Not Found', `Workflow run ${runId} not found`)
    state.checks = { ...state.checks, reruns: [...(state.checks?.reruns ?? []), runId] }
    return { status: 201, body: null }
  }
  if (rawPath === `${prefix}/actions/runs` && method === 'GET') {
    return workflowRunsResponse(state, request, queryParams.get('head_sha'))
  }
  const checkRuns = new RegExp(`^${prefix}/commits/([^/]+)/check-runs$`, 'u').exec(rawPath)
  if (checkRuns) {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', 'check runs are read-only')
    return checkRunResponse(state, request, decodeURIComponent(checkRuns[1]))
  }
  const statusCreate = new RegExp(`^${prefix}/statuses/([^/]+)$`, 'u').exec(rawPath)
  if (statusCreate) {
    // The real endpoint a CI system writes to, kept here so the combined-status shape
    // the product reads can be observed with a record in it rather than an empty list.
    if (method !== 'POST')
      throw new HttpError(405, 'Method Not Allowed', 'a commit status is created with POST')
    const headSha = decodeURIComponent(statusCreate[1])
    if (!hostRefSha(headSha))
      throw new HttpError(422, 'Unprocessable Entity', `No commit found for SHA ${headSha}`)
    const context = typeof body.context === 'string' ? body.context : 'default'
    const status = typeof body.state === 'string' ? body.state : 'pending'
    if (!['error', 'failure', 'pending', 'success'].includes(status))
      throw new HttpError(422, 'Unprocessable Entity', `Invalid state ${status}`)
    const kept = (state.checks?.commitStatuses ?? []).filter(
      (entry) => !(entry.headSha === headSha && entry.context === context),
    )
    state.checks = {
      ...state.checks,
      commitStatuses: [
        ...kept,
        {
          headSha,
          context,
          state: status,
          description: typeof body.description === 'string' ? body.description : null,
          targetUrl: typeof body.target_url === 'string' ? body.target_url : null,
        },
      ],
    }
    return {
      status: 201,
      body: {
        id: 900_000,
        node_id: 'CS_1',
        state: status,
        context,
        target_url: typeof body.target_url === 'string' ? body.target_url : null,
        url: `https://api.github.com/repos/acme/widgets/statuses/900000`,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    }
  }
  const commitStatus = new RegExp(`^${prefix}/commits/([^/]+)/status$`, 'u').exec(rawPath)
  if (commitStatus) {
    if (method !== 'GET')
      throw new HttpError(405, 'Method Not Allowed', 'commit status is read-only')
    return commitStatusResponse(state, request, decodeURIComponent(commitStatus[1]))
  }
  const requiredChecks = new RegExp(
    `^${prefix}/branches/([^/]+)/protection/required_status_checks$`,
    'u',
  ).exec(rawPath)
  if (requiredChecks) {
    const rule = state.checks?.requiredStatusChecks
    const branch = decodeURIComponent(requiredChecks[1])
    if (!rule || rule.branch !== branch)
      throw new HttpError(404, 'Not Found', 'Branch not protected')
    return {
      status: 200,
      body: {
        url: `https://api.github.com/repos/${repository}/branches/${branch}/protection/required_status_checks`,
        strict: true,
        contexts: rule.contexts,
        // GitHub reports app_id only for a context bound to one integration.
        checks: rule.contexts.map((context) => ({
          context,
          app_id: rule.appIds?.[context] ?? null,
        })),
        contexts_url: `https://api.github.com/repos/${repository}/branches/${branch}/protection/required_status_checks/contexts`,
      },
    }
  }
  const branchRules = new RegExp(`^${prefix}/rules/branches/([^/]+)$`, 'u').exec(rawPath)
  if (branchRules) {
    // GitHub's effective-rules endpoint: every active rule that applies to this exact
    // branch, from repository and organisation rulesets, already matched. Reading it is
    // how a caller avoids reimplementing GitHub's branch-pattern evaluation.
    const branch = decodeURIComponent(branchRules[1])
    const rules = state.checks?.branchRules
    if (rules?.forbidden) {
      throw new HttpError(403, 'Forbidden', 'Resource not accessible by integration')
    }
    // Rule sets created through the API apply to exactly the same read. Leaving them out
    // would report that no context is required on a branch whose merge the gate refuses
    // for that very context.
    const configured = ruleSetBranchRules(state, branch)
    const legacy: unknown[] = []
    if (rules && rules.branch === branch) {
      if (rules.workflows) {
        legacy.push({
          type: 'workflows',
          parameters: { workflows: [{ path: '.github/workflows/required.yml' }] },
        })
      }
      if ((rules.required ?? []).length > 0) {
        legacy.push({
          type: 'required_status_checks',
          ruleset_id: 9100,
          ruleset_source: 'Repository',
          ruleset_source_type: 'Repository',
          parameters: {
            required_status_checks: (rules.required ?? []).map((entry) => ({
              context: entry.context,
              integration_id: entry.integrationId ?? null,
            })),
          },
        })
      }
    }
    const combined = [...legacy, ...configured]
    if (combined.length === 0) return { status: 200, body: [] }
    return { status: 200, body: paginate(combined, rawQuery) }
  }
  const pull = new RegExp(`^${prefix}/pulls/(\\d+)$`, 'u').exec(path)
  if (pull) {
    const pr = findPr(state, Number(pull[1]))
    if (method === 'GET') return { status: 200, body: restPullRequest(state, pr) }
    if (method === 'PATCH') {
      if (state.prWriteFailure) {
        throw new HttpError(
          state.prWriteFailure.status,
          state.prWriteFailure.reason,
          state.prWriteFailure.message,
        )
      }
      if (body.draft !== undefined)
        throw new HttpError(422, 'Unprocessable Entity', 'draft cannot be updated through REST')
      if (pr.state === 'MERGED' && body.state === 'open')
        throw new HttpError(422, 'Unprocessable Entity', 'Pull request is merged')
      if (typeof body.title === 'string') pr.title = body.title
      if (typeof body.body === 'string') pr.body = body.body
      if (typeof body.base === 'string') pr.base = body.base
      if (typeof body.state === 'string') {
        if (body.state === 'open' && pr.state !== 'MERGED') pr.state = 'OPEN'
        else if (body.state === 'closed' && pr.state !== 'MERGED') pr.state = 'CLOSED'
      }
      return { status: 200, body: restPullRequest(state, pr) }
    }
    throw new HttpError(405, 'Method Not Allowed', `unsupported pull request method ${method}`)
  }
  if (method === 'POST' && path === `${prefix}/pulls`) {
    const pr = createPullRequest(state, body, request.viewer)
    return {
      status: 201,
      body: { ...restPullRequest(state, pr), number: pr.number, html_url: pr.url },
    }
  }
  const merge = new RegExp(`^${prefix}/pulls/(\\d+)/merge$`, 'u').exec(path)
  if (merge) {
    if (method !== 'PUT') throw new HttpError(405, 'Method Not Allowed', 'merge requires PUT')
    if (
      (state.stacks ?? []).some((stack) =>
        stack.pull_requests.some((pr) => pr.number === Number(merge[1])),
      )
    )
      throw new HttpError(405, 'Method Not Allowed', 'stacked pull requests require merge-async')
    // A ruleset the fixture is enforcing is the only thing allowed to refuse a merge
    // here. Without this the rule set scenarios would agree with the client instead of
    // proving the rules were ever applied. The expected head is the head the pull request
    // has now unless the request named one, because GitHub's `sha` is optional and a rule
    // must not turn an omitted sha into a mismatch.
    const merged = findPr(state, Number(merge[1]))
    if (mergeConflict(state, merged))
      throw new HttpError(405, 'Method Not Allowed', 'Pull Request is not mergeable')
    const expectedHead = body.sha === undefined ? currentHead(state, merged) : String(body.sha)
    const refusal = ruleSetRefusal(state, merged, expectedHead ?? '')
    if (refusal !== null)
      throw new HttpError(405, 'Method Not Allowed', `merge blocked by ruleset: ${refusal}`)
    return { status: 200, body: mergePullRequest(state, merged, body) }
  }
  const asyncMerge = new RegExp(`^${prefix}/pulls/(\\d+)/merge-async(?:/([^/]+))?$`, 'u').exec(path)
  if (asyncMerge) {
    const number = Number(asyncMerge[1])
    if (!asyncMerge[2] && method === 'PUT') {
      const pr = findPr(state, number)
      const action = String(body.merge_action || 'default')
      if (action !== 'default' && action !== 'direct_merge' && action !== 'merge_queue')
        throw new HttpError(422, 'Unprocessable Entity', 'merge_action must be a documented value')
      if (pr.state !== 'OPEN' || pr.draft)
        throw new HttpError(400, 'Bad Request', 'Pull request is not ready to be merged')
      // Mergeability is Git's own answer, and GitHub refuses the request before it is ever
      // accepted. A request the host will not run is not a pending merge.
      if (mergeConflict(state, pr))
        throw new HttpError(422, 'Unprocessable Entity', 'Pull Request is not mergeable')
      // Branch protection and repository rules are not run here: GitHub performs only the
      // basic pull request state checks at admission and evaluates the rules while the
      // request runs. Refusing with 405 here would make a rule-blocked pull request look
      // like one GitHub never accepted, and would suppress the 409 that a request already
      // in flight has to answer with.
      if (state.asyncMerge?.number === number) {
        return {
          status: 409,
          body: {
            status: 'pending',
            details: {
              message: 'a merge request is already enqueued for this pull request',
              uuid: state.asyncMerge.uuid,
              merge_method: state.asyncMerge.method || 'squash',
              merge_action: state.asyncMerge.action,
              expected_head_sha: state.asyncMerge.sha,
            },
          },
        }
      }
      // A queue belongs to a base ref: a default merge enqueues only where an active rule
      // set says this branch has one. An explicit request for a queue that does not exist
      // is admitted and then fails, because that is what an accepted request GitHub cannot
      // complete looks like; answering `enqueued` would be inventing the evidence.
      const queued =
        action === 'merge_queue' || (action === 'default' && mergeQueueFor(state, pr.base))
      // The documented `200`: this pull request is already in a merge queue, so the result
      // is terminal and GitHub hands back no request identity to read it through.
      if (queued && state.asyncMergeAlreadyQueued) {
        return {
          status: 200,
          body: {
            status: 'enqueued',
            details: { message: state.asyncMergeResult?.message ?? 'Already in the merge queue' },
          },
        }
      }
      const uuid = `fixture-${number}`
      state.asyncMerge = {
        number,
        // GitHub's `sha` is optional: a request that names none merges the head the pull
        // request has when the request is made, and is cancelled if the head moves before
        // it runs. Recording an empty string instead would cancel every such request.
        sha: body.sha === undefined ? (currentHead(state, pr) ?? '') : String(body.sha),
        method: queued ? '' : String(body.merge_method || ''),
        action: queued ? 'merge_queue' : 'direct_merge',
        uuid,
      }
      return {
        status: 202,
        body: { status: 'pending', details: { uuid, message: 'merge request accepted' } },
      }
    }
    if (asyncMerge[2] && method === 'GET') {
      const pending = state.asyncMerge
      if (!pending || pending.uuid !== asyncMerge[2] || pending.number !== number)
        throw new HttpError(404, 'Not Found', 'Unknown merge request')
      if (state.asyncMergeStaysPending) {
        return {
          status: 200,
          body: {
            status: 'pending',
            details: { uuid: pending.uuid, message: 'merge in progress' },
          },
        }
      }
      const canned = state.asyncMergeResult
      const pr = findPr(state, number)
      if (canned?.status === 'enqueued') {
        clearScopedFact(state, 'asyncMerge')
        return {
          status: 200,
          body: {
            status: 'enqueued',
            details: { message: canned.message ?? 'Added to the merge queue' },
          },
        }
      }
      if (canned?.status === 'failed') {
        clearScopedFact(state, 'asyncMerge')
        return {
          status: 200,
          body: { status: 'failed', details: { message: canned.message ?? 'merge failed' } },
        }
      }
      // This is where the rules are evaluated. A request that was admitted and is then
      // blocked produces a terminal failed result rather than a request that was never
      // accepted, which is what GitHub does and what a client polling for the outcome has
      // to be able to read.
      if (pending.action === 'merge_queue') {
        if (!mergeQueueFor(state, pr.base)) {
          clearScopedFact(state, 'asyncMerge')
          return {
            status: 200,
            body: {
              status: 'failed',
              details: {
                message: `Merge queue is not enabled on ${state.repository.owner}:${pr.base}`,
              },
            },
          }
        }
        // An enqueued result is terminal and means the pull request joined a queue, not
        // that it merged; the queue itself is not simulated further.
        clearScopedFact(state, 'asyncMerge')
        return {
          status: 200,
          body: {
            status: 'enqueued',
            details: { message: canned?.message ?? 'Added to the merge queue' },
          },
        }
      }
      const head = currentHead(state, pr)
      const refusal = ruleSetRefusal(state, pr, head ?? pending.sha)
      if (refusal !== null) {
        clearScopedFact(state, 'asyncMerge')
        return {
          status: 200,
          body: { status: 'failed', details: { message: `merge blocked by ruleset: ${refusal}` } },
        }
      }
      const result = mergeStackedPullRequest(state, pr, pending.sha, pending.method)
      clearScopedFact(state, 'asyncMerge')
      return {
        status: 200,
        body: result.merged
          ? { status: 'merged', details: { message: result.message, sha: result.sha } }
          : { status: 'failed', details: { message: result.message } },
      }
    }
    throw new HttpError(404, 'Not Found', 'Unknown merge request')
  }
  const comments = new RegExp(`^${prefix}/issues/(\\d+)/comments$`, 'u').exec(path)
  if (comments) {
    const key = String(Number(comments[1]))
    if (!Array.isArray(state.comments?.[key])) state.comments = { ...state.comments, [key]: [] }
    const list = state.comments[key]
    if (method === 'GET')
      return { status: 200, body: list.map((entry) => commentResponse(state, entry)) }
    if (method !== 'POST')
      throw new HttpError(405, 'Method Not Allowed', 'unsupported comments method')
    const id = Number.isInteger(state.nextCommentId) ? state.nextCommentId++ : 2
    const comment = { id, body: String(body.body || ''), user: actor(state.currentUser) }
    list.push(comment)
    return { status: 201, body: commentResponse(state, comment) }
  }
  const comment = new RegExp(`^${prefix}/issues/comments/(\\d+)$`, 'u').exec(path)
  if (comment) {
    const id = Number(comment[1])
    const entry = Object.values(state.comments || {})
      .flat()
      .find((candidate) => candidate && candidate.id === id)
    if (!entry) throw new HttpError(404, 'Not Found', `Not Found: comment ${id}`)
    if (method === 'PATCH') entry.body = String(body.body || '')
    if (method !== 'PATCH' && method !== 'GET')
      throw new HttpError(405, 'Method Not Allowed', 'unsupported comment method')
    return { status: 200, body: commentResponse(state, entry) }
  }
  throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
}

function handleGraphql(
  state: GitHubFixtureState,
  body: Record<string, unknown>,
  viewer: string,
): RestResult {
  const query = String(body.query || '')
  const variables = (body.variables ?? {}) as Record<string, unknown>
  // A document that names a repository is served by that repository: its own pull
  // requests, its own threads, and the role this account actually holds there. Answering
  // from the fixture's own repository would make a fork, or a repository this account
  // cannot see, look like a repository it may write to.
  // Only a document that names a repository in full is scoped by this host. A query that
  // carries an owner for some other purpose is none of this route's business.
  const names =
    typeof variables.owner === 'string' && typeof variables.name === 'string'
      ? `${variables.owner}/${variables.name}`
      : null
  const named = names === null ? null : repositoryEntry(state, names)
  if (named && named.fullName.toLowerCase() !== primaryFullName(state).toLowerCase()) {
    if (roleOf(named, viewer) === null) {
      return {
        status: 200,
        body: {
          data: { repository: null },
          errors: [
            {
              type: 'NOT_FOUND',
              message: `Could not resolve to a Repository with the name '${variables.owner}/${variables.name}'.`,
            },
          ],
        },
      }
    }
    return withHostRepository(hostFor(named, state), () =>
      handleGraphql(scopedStateFor(state, named, viewer), body, viewer),
    )
  }
  if (names !== null && named === null) {
    return {
      status: 200,
      body: {
        data: { repository: null },
        errors: [
          {
            type: 'NOT_FOUND',
            message: `Could not resolve to a Repository with the name '${names}'.`,
          },
        ],
      },
    }
  }
  // The review thread, reply, resolve, and permission operations belong to the live
  // suite's surface module; anything it does not recognise falls through below.
  const surface = handleSurfaceGraphql(state, body, viewer)
  if (surface) return surface
  const field = query.includes('convertPullRequestToDraft')
    ? 'convertPullRequestToDraft'
    : query.includes('markPullRequestReadyForReview')
      ? 'markPullRequestReadyForReview'
      : null
  if (field) {
    const match = /^PR_(\d+)$/u.exec(String(variables.pullRequestId || ''))
    if (!match) throw new HttpError(422, 'Unprocessable Entity', 'Invalid pull request ID')
    const pr = findPr(state, Number(match[1]))
    if (pr.state !== 'OPEN')
      throw new HttpError(422, 'Unprocessable Entity', 'Pull request is not open')
    pr.draft = field === 'convertPullRequestToDraft'
    return {
      status: 200,
      body: { data: { [field]: { pullRequest: { id: `PR_${pr.number}`, isDraft: pr.draft } } } },
    }
  }
  if (query.includes('search(query:')) {
    if (state.issuesFailure) {
      throw new HttpError(
        state.issuesFailure.status,
        state.issuesFailure.reason,
        state.issuesFailure.message,
      )
    }
    const rawQuery = String(variables.searchQuery ?? variables.query ?? '')
    const terms = rawQuery
      .replace(/repo:[^\s]+/gu, '')
      .replace(/is:issue/gu, '')
      .trim()
      .toLowerCase()
    const issues = state.issues ?? []
    let matched = issues
    if (terms) {
      matched = issues.filter((iss) => {
        if (String(iss.number) === terms || `#${iss.number}` === terms) return true
        return iss.title.toLowerCase().includes(terms)
      })
    }
    return {
      status: 200,
      body: {
        data: {
          search: {
            issueCount: matched.length,
            nodes: matched.map((iss) => ({
              __typename: 'Issue',
              number: iss.number,
              title: iss.title,
              url: iss.url,
              state: iss.state,
              repository: { nameWithOwner: iss.repository ?? 'acme/widgets' },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }
  }
  if (query.includes('issue(number:')) {
    if (state.issuesFailure) {
      throw new HttpError(
        state.issuesFailure.status,
        state.issuesFailure.reason,
        state.issuesFailure.message,
      )
    }
    const num = Number(variables.number)
    const iss = (state.issues ?? []).find((i) => i.number === num)
    return {
      status: 200,
      body: {
        data: {
          repository: {
            issue: iss
              ? { number: iss.number, title: iss.title, url: iss.url, state: iss.state }
              : null,
          },
        },
      },
    }
  }
  if (query.includes('issues(first:')) {
    if (state.issuesFailure) {
      throw new HttpError(
        state.issuesFailure.status,
        state.issuesFailure.reason,
        state.issuesFailure.message,
      )
    }
    const issues = (state.issues ?? []).filter((iss) => iss.state === 'OPEN')
    return {
      status: 200,
      body: {
        data: {
          repository: {
            issues: {
              nodes: issues.map((iss) => ({ number: iss.number, title: iss.title, url: iss.url })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }
  }
  if (query.includes('pullRequest(number:')) {
    const pr = findPr(state, Number(variables.number))
    return {
      status: 200,
      body: { data: { repository: { pullRequest: graphPullRequest(state, pr, true) } } },
    }
  }
  const after = typeof variables.endCursor === 'string' ? variables.endCursor : null
  const open = state.prs.filter((pr) => pr.state === 'OPEN')
  // One PR per page so a second request with a cursor proves the loop advanced.
  const start = after ? Number(after.replace('cursor:', '')) : 0
  const nodes = open.slice(start, start + 1).map((pr) => graphPullRequest(state, pr, false))
  const next = start + 1
  return {
    status: 200,
    body: {
      data: {
        repository: {
          pullRequests: {
            nodes,
            pageInfo: {
              hasNextPage: next < open.length,
              endCursor: next < open.length ? `cursor:${next}` : null,
            },
          },
        },
      },
    },
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const isNoBody = status === 204 || status === 205 || status === 304
  return new Response(isNoBody ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(isNoBody ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4998',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-ratelimit-resource': 'core',
      ...headers,
    },
  })
}

/** A `fetch` implementation that answers GitHub requests from the harness fixture state. */
export function createGitHubApiDouble(): typeof globalThis.fetch {
  const double = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // A real request in flight is killed when its caller walks away. The double answers
    // immediately, so it has to honour the signal itself or an abandoned read looks
    // exactly like one that finished.
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const url = new URL(typeof input === 'string' ? input : String(input))
    const method = (init?.method || 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init?.headers || {}).forEach((value, key) => {
      headers[key] = value
    })
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        return json(400, { message: 'Problems parsing JSON' })
      }
    }
    const state = loadState()
    // The credential a request carried decides who is asking, so two accounts are two real
    // identities rather than one login behind a flag, and GitHub decides `viewerDidAuthor`
    // from exactly this. Only a credential this run minted resolves; anything else,
    // including a real one, is refused.
    const token = (headers.authorization ?? '').replace(/^Bearer /u, '')
    const viewer = authenticate(state, token)
    if (viewer === null) return json(401, { message: 'Bad credentials' })
    if (!Array.isArray(state.requests)) state.requests = []
    const path = (url.pathname + url.search).replace(/^\//u, '')
    state.requests.push({
      argv: [path, method],
      cwd: process.cwd(),
      at: new Date().toISOString(),
      ...(Object.keys(body).length > 0 ? { body } : {}),
    })
    const request: GitHubApiDoubleRequest = {
      method,
      path,
      body,
      headers,
      viewer,
      origin: url.origin,
    }
    const lost = (state.lostResponses ?? []).findIndex((rule) => {
      if (rule.method !== method || !request.path.includes(rule.pathIncludes)) return false
      if (rule.pathEndsWith !== undefined && !request.path.endsWith(rule.pathEndsWith)) return false
      if (rule.after === undefined) return true
      // A run can read the same path more than once, so a rule names which
      // occurrence it answers: zero is the first request that matches. The count
      // uses the rule's own path match, so a `POST /stacks/1/unstack` never
      // counts as a read of `/stacks/1`.
      const seen = (state.requests ?? []).filter((entry) => {
        const path = entry.argv?.[0] ?? ''
        if (!path.includes(rule.pathIncludes)) return false
        return rule.pathEndsWith === undefined || path.endsWith(rule.pathEndsWith)
      }).length
      return seen - 1 === rule.after
    })
    try {
      const result =
        request.path === 'graphql'
          ? handleGraphql(state, body, request.viewer)
          : handleRest(state, request)
      // Somebody else pushes and closes a pull request after the response above was built but
      // before the caller sees it. The listing the caller is holding is now a stale snapshot,
      // which is the window a single earlier read cannot cover.
      const drift = (state.driftOnRequest ?? []).findIndex((rule) => {
        if (!request.path.includes(rule.pathIncludes)) return false
        const seen = (state.requests ?? []).filter((entry) =>
          entry.argv[0]?.includes(rule.pathIncludes),
        ).length
        return seen - 1 === (rule.after ?? 0)
      })
      if (drift !== -1) {
        const rule = (state.driftOnRequest ?? [])[drift]
        state.driftOnRequest = (state.driftOnRequest ?? []).filter((_, index) => index !== drift)
        saveState(state)
        hostGit(['update-ref', rule.ref, rule.to])
      }
      const closeIndex = (state.closeOnRequest ?? []).findIndex((rule) => {
        if (!request.path.includes(rule.pathIncludes)) return false
        const seen = (state.requests ?? []).filter((entry) =>
          entry.argv[0]?.includes(rule.pathIncludes),
        ).length
        return seen - 1 === (rule.after ?? 0)
      })
      if (closeIndex !== -1) {
        const rule = (state.closeOnRequest ?? [])[closeIndex]
        state.closeOnRequest = (state.closeOnRequest ?? []).filter((_, i) => i !== closeIndex)
        const pr = state.prs.find((candidate) => candidate.number === rule.number)
        if (pr) pr.state = 'CLOSED'
        for (const stack of state.stacks ?? []) {
          const member = stack.pull_requests.find((item) => item.number === rule.number)
          if (member) member.state = 'closed'
        }
        saveState(state)
      }
      saveState(state)
      if (lost !== -1) {
        // GitHub took the change; the caller never hears about it, which is what a dropped
        // connection mid-request looks like to the person waiting.
        const rule = (state.lostResponses ?? [])[lost]
        state.lostResponses = (state.lostResponses ?? []).filter((_, index) => index !== lost)
        saveState(state)
        return json(rule.status, { message: rule.message })
      }
      return json(result.status, result.body, result.headers ?? {})
    } catch (error) {
      saveState(state)
      if (error instanceof HttpError) {
        return json(error.status, { message: error.message }, error.headers)
      }
      throw error
    }
  }) as typeof globalThis.fetch
  return double
}
