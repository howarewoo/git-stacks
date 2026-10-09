import { isRecord } from '@git-stacks/shared/guards'
import type { FixtureRuleSet, FixtureThread, GitHubFixtureState } from './github-harness'
import type { GitHubApiDoubleRequest } from './github-api-double'
import {
  HttpError,
  aggregateReviewDecision,
  hostGit,
  hostGitOrNull,
  hostRefSha,
  nextPageHeaders,
  paginate,
  restPage,
  queryStringOf,
  refConditionMatches,
  ruleSetIdentity,
  standingReviewDecisions,
  validateRuleSetCreation,
  type RestResult,
} from './github-rest'

/**
 * The parts of GitHub the live end-to-end suite needs that the original transport
 * double did not answer: pull request files with real patches, reviews and the
 * threads they open, branch protection expressed as rulesets, and the git ref
 * writes a disposable repository is built from.
 *
 * Everything here is additive. A fixture state without the new fields behaves
 * exactly as it did before, so every existing test keeps its meaning, and a route
 * this module does not recognise returns null so the original handler still owns it.
 *
 * The diffs come from real `git` against the same bare remote the transport double
 * already uses. A review anchored to a fabricated line number would only test the
 * suite's own arithmetic, so the patch has to be the patch the application is going
 * to read.
 */
function pullRequestOf(state: GitHubFixtureState, number: number) {
  const pull = state.prs.find((entry) => entry.number === number)
  if (!pull) throw new HttpError(404, 'Not Found', `No pull request found for number ${number}`)
  return pull
}

function threadsOf(state: GitHubFixtureState, number: number): FixtureThread[] {
  if (!state.reviewThreads) state.reviewThreads = {}
  const key = String(number)
  if (!Array.isArray(state.reviewThreads[key])) state.reviewThreads[key] = []
  return state.reviewThreads[key]
}

function nextId(state: GitHubFixtureState, field: 'nextThreadId' | 'nextReviewId'): number {
  const current = typeof state[field] === 'number' ? (state[field] as number) : 1
  state[field] = current + 1
  return current
}

/**
 * The repository role the GraphQL surface reports for the account asking.
 *
 * A reader with no write access cannot resolve a conversation, and a host that answered
 * `WRITE` to everybody would let a read-only reviewer be treated as somebody who can.
 * A state that names no role keeps the answer this fixture has always given.
 */
function viewerPermissionOf(state: GitHubFixtureState): string {
  const permissions = state.checks?.viewerPermissions
  if (!permissions) return 'WRITE'
  if (permissions.admin) return 'ADMIN'
  if (permissions.maintain) return 'MAINTAIN'
  if (permissions.push) return 'WRITE'
  return permissions.triage ? 'TRIAGE' : 'READ'
}

function actor(login: string): { login: string; id: number; type: string; url: string } {
  return { login, id: 1, type: 'User', url: `https://github.com/${login}` }
}

/** One changed path, as Git itself reports the change against the merge base. */
interface GitFileChange {
  status: 'added' | 'removed' | 'renamed' | 'modified'
  filename: string
  previousFilename: string | null
  additions: number
  deletions: number
  /** The hunk headers and lines GitHub sends as `patch`, or null for a binary change. */
  patch: string | null
}

const CHANGE_STATUS: Record<string, GitFileChange['status']> = {
  A: 'added',
  D: 'removed',
  M: 'modified',
  T: 'modified',
  R: 'renamed',
  C: 'modified',
}

/**
 * What Git says changed between the merge base and the head.
 *
 * The status and the previous filename come from Git's own name-status output rather than
 * from a guess: labelling every entry `modified` reports a file the pull request added as
 * one it changed, and a rename without its previous filename cannot be matched against the
 * path the reviewer saw. The counts are counted from the hunks that are actually sent, so
 * a binary change reports no lines and no patch instead of an invented one.
 */
function gitFileChanges(pr: GitHubFixtureState['prs'][number]): GitFileChange[] {
  const head = hostRefSha(`refs/heads/${pr.head}`)
  const base = hostRefSha(`refs/heads/${pr.base}`)
  if (head === null || base === null) return []
  const mergeBase = hostGitOrNull(['merge-base', base, head])
  if (mergeBase === null) return []
  const names = hostGit(['diff', '--no-color', '--name-status', '-M', '-z', mergeBase, head])
  const fields = names.split('\0').filter((field) => field !== '')
  const changes: GitFileChange[] = []
  for (let index = 0; index < fields.length; ) {
    const status = fields[index][0]
    if (status === 'R' || status === 'C') {
      const previousFilename = fields[index + 1]
      const filename = fields[index + 2]
      index += 3
      changes.push(changeEntry(mergeBase, head, CHANGE_STATUS[status], filename, previousFilename))
      continue
    }
    const filename = fields[index + 1]
    index += 2
    changes.push(changeEntry(mergeBase, head, CHANGE_STATUS[status] ?? 'modified', filename, null))
  }
  return changes
}

function changeEntry(
  mergeBase: string,
  head: string,
  status: GitFileChange['status'],
  filename: string,
  previousFilename: string | null,
): GitFileChange {
  const paths = previousFilename ? ['--', previousFilename, filename] : ['--', filename]
  const raw = hostGit(['diff', '--no-color', '--unified=3', '-M', mergeBase, head, ...paths])
  // Only the hunks belong in the patch GitHub sends: the blob headers and the index line
  // are part of Git's output, not part of the text a reviewer reads.
  const hunks: string[] = []
  let inHunk = false
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      hunks.push(line)
      continue
    }
    if (!inHunk) continue
    hunks.push(line)
  }
  const patch = hunks.join('\n').replace(/\n+$/u, '')
  const lines = patch === '' ? [] : patch.split('\n')
  return {
    status,
    filename,
    previousFilename,
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    patch: patch === '' ? null : patch,
  }
}

/** The `filename`/`patch` entries GitHub returns for a pull request's files. */
function fileEntries(state: GitHubFixtureState, pr: GitHubFixtureState['prs'][number]): unknown[] {
  const head = hostRefSha(`refs/heads/${pr.head}`)
  if (head === null) return []
  return gitFileChanges(pr).map((change) => {
    const filename = change.filename
    return {
      sha: head,
      filename,
      status: change.status,
      ...(change.previousFilename ? { previous_filename: change.previousFilename } : {}),
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      blob_url: `https://github.com/${state.repository.owner}/${state.repository.name}/blob/main/${filename}`,
      raw_url: `https://github.com/${state.repository.owner}/${state.repository.name}/raw/main/${filename}`,
      contents_url: `https://api.github.com/repos/${state.repository.owner}/${state.repository.name}/contents/${filename}`,
      ...(change.patch === null ? {} : { patch: change.patch }),
    }
  })
}

const RECORDED_REVIEW_STATES: Record<string, string> = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  COMMENT: 'COMMENTED',
}

/** Turns one submitted review comment into the thread GitHub opens for it. */
function threadFromComment(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
  comment: Record<string, unknown>,
  body: string,
  viewer: string,
): FixtureThread {
  const line = Number(comment.line ?? 0)
  const start = Number(comment.start_line ?? comment.line ?? 0)
  return {
    id: `PRT_${nextId(state, 'nextThreadId')}`,
    path: String(comment.path ?? ''),
    side: String(comment.side ?? 'RIGHT'),
    diffSide: String(comment.side ?? 'RIGHT'),
    line: Number.isFinite(line) && line > 0 ? line : null,
    startLine: start === line || start <= 0 ? null : start,
    startDiffSide: start === line || start <= 0 ? null : String(comment.start_side ?? 'RIGHT'),
    subjectType: 'LINE',
    isResolved: false,
    isCollapsed: false,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [
      {
        id: `PRTC_${nextId(state, 'nextThreadId')}`,
        body,
        createdAt: '2026-01-01T00:00:00Z',
        url: `https://github.com/${pr.number}`,
        viewerDidAuthor: true,
        author: { login: viewer },
        // The caller stamps the review that opened this thread; the thread does not know it.
        reviewId: null,
      },
    ],
  }
}

const threadNode = (thread: FixtureThread, viewer: string): Record<string, unknown> => ({
  __typename: 'PullRequestReviewThread',
  id: thread.id,
  path: thread.path,
  line: thread.line,
  startLine: thread.startLine,
  diffSide: thread.diffSide,
  startDiffSide: thread.startDiffSide,
  subjectType: thread.subjectType,
  isResolved: thread.isResolved,
  isCollapsed: thread.isCollapsed,
  isOutdated: thread.isOutdated,
  viewerCanReply: thread.viewerCanReply,
  viewerCanResolve: thread.viewerCanResolve,
  viewerCanUnresolve: thread.viewerCanUnresolve,
  comments: {
    totalCount: thread.comments.length,
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: thread.comments.map((comment) => ({
      ...comment,
      viewerDidAuthor: comment.author.login === viewer,
    })),
  },
})

/** The routes this module owns. Returns null for anything it does not recognise. */
export function handleSurfaceRest(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  viewer: string,
): RestResult | null {
  const { method, path, body } = request
  const rawPath = path.split('?')[0]
  const repository = `${state.repository.owner}/${state.repository.name}`
  const prefix = `repos/${repository}`

  // The listing a caller uses to ask how many pull requests a head branch has. The race
  // scenarios count them before and after a concurrent change, and a duplicate is only
  // visible if the count comes from the host rather than from what the client remembers.
  if (rawPath === `${prefix}/pulls`) {
    if (method !== 'GET') return null
    const query = new URLSearchParams(path.split('?')[1] ?? '')
    const wantedState = (query.get('state') ?? 'open').toLowerCase()
    const head = query.get('head')
    const base = query.get('base')
    const headRef = head?.includes(':') === true ? head.slice(head.indexOf(':') + 1) : head
    const matching = state.prs.filter((pr) => {
      if (wantedState === 'open' && pr.state !== 'OPEN') return false
      if (wantedState === 'closed' && pr.state === 'OPEN') return false
      if (headRef !== null && headRef !== '' && pr.head.toLowerCase() !== headRef.toLowerCase())
        return false
      if (base !== null && base !== '' && pr.base.toLowerCase() !== base.toLowerCase()) return false
      return true
    })
    const perPage = Number(query.get('per_page')) || 30
    const index = (Number(query.get('page')) || 1) - 1
    const next = new URLSearchParams(query)
    next.set('per_page', String(perPage))
    next.set('page', String(index + 2))
    return {
      status: 200,
      body: matching.slice(index * perPage, index * perPage + perPage).map((pr) => ({
        number: pr.number,
        state: pr.state === 'MERGED' ? 'closed' : pr.state.toLowerCase(),
        draft: pr.draft === true,
        title: pr.title,
        html_url: pr.url,
        head: {
          ref: pr.head,
          sha: hostRefSha(`refs/heads/${pr.head}`) ?? '',
          repo: { full_name: pr.headRepository },
        },
        base: { ref: pr.base, sha: hostRefSha(`refs/heads/${pr.base}`) },
        user: { login: pr.author ?? state.currentUser },
      })),
      // A real host says in the header that there is more, on every collection it
      // serves. A caller that pages reads that header and stops when it is absent, so a
      // listing without one is a shorter conversation than the host holds: invisible
      // while a run has few pull requests, and a missing answer once it has many.
      ...(index * perPage + perPage < matching.length
        ? {
            headers: {
              link: `<${request.origin}/${prefix}/pulls?${next}>; rel="next"`,
            },
          }
        : {}),
    }
  }

  // Writing a check run is what a ruleset's required check is satisfied with, and GitHub
  // exposes no other way to satisfy one from outside a workflow. The application never
  // writes these, so a disposable run has to.
  const writeCheckRun = new RegExp(`^${prefix}/check-runs$`, 'u').exec(rawPath)
  if (writeCheckRun) {
    if (method !== 'POST') return null
    const headSha = String(body.head_sha ?? '')
    if (hostRefSha(headSha) === null) {
      throw new HttpError(422, 'Unprocessable Entity', `No commit found for SHA ${headSha}`)
    }
    const existing = state.checks?.checkRuns ?? []
    const id = existing.reduce((highest, run) => Math.max(highest, run.id), 0) + 1
    state.checks = {
      ...state.checks,
      checkRuns: [
        ...existing,
        {
          id,
          headSha,
          name: String(body.name ?? 'check'),
          status: String(body.status ?? 'queued'),
          conclusion: typeof body.conclusion === 'string' ? body.conclusion : null,
          // GitHub attributes a check run to the app that wrote it, and a required check is
          // bound to that app, so the run is attributed to the suite's own identity.
          appSlug: 'git-stacks-live-e2e',
          appId: 1,
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: body.status === 'completed' ? '2026-01-01T00:00:01Z' : null,
        },
      ],
    }
    return {
      status: 201,
      body: {
        id,
        node_id: `CR_${id}`,
        name: String(body.name ?? 'check'),
        head_sha: headSha,
        status: String(body.status ?? 'queued'),
        conclusion: typeof body.conclusion === 'string' ? body.conclusion : null,
        app: { id: 1, slug: 'git-stacks-live-e2e', name: 'git-stacks-live-e2e' },
      },
    }
  }
  const files = new RegExp(`^${prefix}/pulls/(\\d+)/files$`, 'u').exec(rawPath)

  // Reading one commit. A capability probe and a schema probe both need the head a
  // check attaches to, and resolving a branch name to a commit is what GitHub does
  // here rather than reporting the name back.
  const commit = new RegExp(`^${prefix}/commits/([^/]+)$`, 'u').exec(rawPath)
  if (commit) {
    if (method !== 'GET') return null
    const wanted = decodeURIComponent(commit[1])
    const sha = hostRefSha(wanted) ?? hostRefSha(`refs/heads/${wanted}`)
    if (sha === null) {
      throw new HttpError(404, 'Not Found', `No commit found for SHA: ${wanted}`)
    }
    return {
      status: 200,
      body: {
        sha,
        node_id: `C_${sha}`,
        url: `https://api.github.com/repos/${repository}/commits/${sha}`,
        html_url: `https://github.com/${repository}/commit/${sha}`,
        commit: {
          message: 'fixture commit',
          author: {
            name: 'GitHub Fixture',
            email: 'github-fixture@example.invalid',
            date: '2026-01-01T00:00:00Z',
          },
        },
      },
    }
  }
  if (files) {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', 'files is read-only')
    return { status: 200, body: fileEntries(state, pullRequestOf(state, Number(files[1]))) }
  }

  const reviews = new RegExp(`^${prefix}/pulls/(\\d+)/reviews$`, 'u').exec(rawPath)
  if (reviews) {
    const number = Number(reviews[1])
    const pr = pullRequestOf(state, number)
    if (!state.reviews) state.reviews = {}
    const key = String(number)
    if (!Array.isArray(state.reviews[key])) state.reviews[key] = []
    const recorded = state.reviews[key]
    if (method === 'GET') {
      // GitHub orders reviews oldest first and pages them. A host that answered every
      // page with the whole collection would repeat the same rows up to the client's bound
      // and then report the read as truncated, so a review that GitHub holds would look
      // like one the read never reached.
      const page = restPage(recorded, queryStringOf(path))
      return {
        status: 200,
        body: page.entries,
        headers: nextPageHeaders(
          request.origin,
          `${prefix}/pulls/${number}/reviews`,
          queryStringOf(path),
          page.nextPage,
        ),
      }
    }
    if (method !== 'POST')
      throw new HttpError(405, 'Method Not Allowed', 'unsupported reviews method')
    if (pr.state !== 'OPEN') {
      throw new HttpError(422, 'Unprocessable Entity', `pull request #${number} is not open`)
    }

    const comments = Array.isArray(body.comments)
      ? (body.comments as Array<Record<string, unknown>>)
      : []
    const files_ = fileEntries(state, pr)
    for (const comment of comments) {
      const path_ = String(comment.path ?? '')
      if (path_ === '') continue
      if (!files_.some((entry) => (entry as Record<string, unknown>).filename === path_)) {
        throw new HttpError(422, 'Unprocessable Entity', `path ${path_} is not part of the diff`)
      }
    }
    const event = String(body.event ?? 'COMMENT')
    if (event === 'APPROVE' && pr.author !== undefined && pr.author === viewer) {
      throw new HttpError(422, 'Unprocessable Entity', 'Can not approve your own pull request')
    }
    // A review is written with the verb the request carries and read back with the
    // outcome GitHub recorded for it: `APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED`.
    // Echoing the verb back is the mistake a reconciliation is built to catch, because
    // nothing would ever recognise a settled review as the one it had sent.
    const review = {
      id: nextId(state, 'nextReviewId'),
      state: RECORDED_REVIEW_STATES[event] ?? 'COMMENTED',
      event,
      body: String(body.body ?? ''),
      commit_id: String(body.commit_id ?? ''),
      submitted_at: '2026-01-01T00:00:00Z',
      user: actor(viewer),
      html_url: `https://github.com/${repository}/pull/${number}`,
    }
    recorded.push(review)
    const threads = threadsOf(state, number)
    for (const comment of comments) {
      const thread = threadFromComment(state, pr, comment, String(comment.body ?? ''), viewer)
      // The review that opened a thread owns its first comment, and GitHub says which
      // review that was. A lost-write reconciliation groups comments by it, so a
      // comment that names no review can never be matched against the attempt that
      // wrote it.
      for (const stored of thread.comments) stored.reviewId = review.id
      threads.push(thread)
    }
    // A comment is not a decision, so it neither approves nor requests changes and it
    // does not clear what a reviewer last decided. The aggregate is derived from every
    // reviewer's most recent non-comment review, which is also what the merge gate counts.
    pr.reviewDecision = aggregateReviewDecision(standingReviewDecisions(recorded))
    return { status: 200, body: review }
  }

  const reviewComments = new RegExp(`^${prefix}/pulls/(\\d+)/comments$`, 'u').exec(rawPath)
  if (reviewComments) {
    if (method !== 'GET')
      throw new HttpError(405, 'Method Not Allowed', 'comments is read-only here')
    const number = Number(reviewComments[1])
    const head = hostRefSha(`refs/heads/${pullRequestOf(state, number).head}`) ?? ''
    const flat = threadsOf(state, number).flatMap((thread) =>
      thread.comments.map((comment) => ({
        id: Number(String(comment.id).replace(/\D+/gu, '')),
        node_id: comment.id,
        body: comment.body,
        path: thread.path,
        line: thread.line,
        start_line: thread.startLine,
        side: thread.side,
        start_side: thread.startDiffSide,
        commit_id: head,
        // Which review wrote this comment. A reply belongs to no review, and GitHub
        // reports that as null rather than leaving the field out.
        pull_request_review_id: comment.reviewId,
        user: comment.author,
        created_at: comment.createdAt,
        html_url: comment.url,
      })),
    )
    const page = restPage(flat, queryStringOf(path))
    return {
      status: 200,
      body: page.entries,
      headers: nextPageHeaders(
        request.origin,
        `${prefix}/pulls/${number}/comments`,
        queryStringOf(path),
        page.nextPage,
      ),
    }
  }

  if (rawPath === `${prefix}/git/refs`) {
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed', 'git refs requires POST')
    const ref = String(body.ref ?? '')
    const sha = String(body.sha ?? '')
    if (!ref.startsWith('refs/heads/')) {
      throw new HttpError(422, 'Unprocessable Entity', 'only branch refs are supported')
    }
    if (hostRefSha(ref) !== null)
      throw new HttpError(422, 'Unprocessable Entity', `${ref} already exists`)
    // GitHub documents `sha` as "the SHA1 value of the commit object", so a branch name
    // is not a value this endpoint accepts. Accepting one would answer 201 for a request
    // the real API refuses, which is how a caller that creates a branch from a ref name
    // instead of a commit is never told it is wrong.
    if (!/^[0-9a-f]{40}$/u.test(sha))
      throw new HttpError(422, 'Unprocessable Entity', `${sha} is not a commit SHA`)
    if (hostRefSha(sha) === null)
      throw new HttpError(422, 'Unprocessable Entity', `${sha} is unknown`)
    hostGit(['update-ref', ref, sha])
    return { status: 201, body: { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } } }
  }

  const refDelete = new RegExp(`^${prefix}/git/refs/heads/(.+)$`, 'u').exec(rawPath)
  if (refDelete) {
    if (method !== 'DELETE')
      throw new HttpError(405, 'Method Not Allowed', 'git refs requires DELETE')
    const ref = `refs/heads/${decodeURIComponent(refDelete[1])}`
    if (hostRefSha(ref) === null) return { status: 204, body: null }
    hostGit(['update-ref', '-d', ref])
    return { status: 204, body: null }
  }

  if (rawPath === `${prefix}/rulesets`) {
    const recorded = (state.ruleSets ??= [])
    if (method === 'GET') {
      // The listing answers identities. `conditions` and `rules` are not required members
      // of a listed rule set, so a reader that decides what a rule set protects from this
      // response has to fetch the detail, which is where GitHub keeps the configuration.
      //
      // The listing is paged the way every other collection here is, and says so in the
      // header. A reader that stops at the first page sees an active rule set on a later
      // page as no rule set at all, which is the difference between a merge queue that is
      // reported and one that is silently missing once a repository holds more than a
      // page of them.
      const page = restPage(
        recorded.map((entry) => ruleSetIdentity(entry, repository)),
        queryStringOf(path),
      )
      return {
        status: 200,
        body: page.entries,
        ...(page.nextPage === null
          ? {}
          : {
              headers: nextPageHeaders(
                request.origin,
                `${prefix}/rulesets`,
                queryStringOf(path),
                page.nextPage,
              ),
            }),
      }
    }
    if (method !== 'POST')
      throw new HttpError(405, 'Method Not Allowed', 'unsupported rulesets method')
    // GitHub refuses a body that is missing a required rule parameter, so a request that
    // names a merge queue without the fields the queue needs never becomes a rule set, and
    // a probe cannot read back a capability it never had.
    validateRuleSetCreation(body)
    const rules = Array.isArray(body.rules) ? (body.rules as Array<Record<string, unknown>>) : []
    const requiredChecks: string[] = []
    let requiredApprovals = 0
    let requiresThreadResolution = false
    const queues: Array<Record<string, unknown>> = []
    for (const rule of rules) {
      const parameters = isRecord(rule.parameters) ? rule.parameters : {}
      if (rule.type === 'required_status_checks') {
        const checks = Array.isArray(parameters.required_status_checks)
          ? parameters.required_status_checks
          : []
        for (const check of checks) {
          if (isRecord(check) && typeof check.context === 'string')
            requiredChecks.push(check.context)
        }
      }
      if (rule.type === 'pull_request') {
        const count = Number(parameters.required_approving_review_count)
        if (Number.isFinite(count)) requiredApprovals = Math.max(requiredApprovals, count)
        if (parameters.required_review_thread_resolution === true) requiresThreadResolution = true
      }
      if (rule.type === 'merge_queue') queues.push(rule)
    }
    // The conditions and the rules are stored the way GitHub returns them, because a queue
    // is only proven by reading it back off the rule set that declares it, and because the
    // effective branch rules are the rule parameters themselves: a stored rule reduced to
    // its type would answer "no context is required here" for a rule set that blocks the
    // merge for exactly one named context.
    const conditions = isRecord(body.conditions) ? body.conditions : {}
    const created: FixtureRuleSet = {
      id: (state.nextRuleSetId ?? 0) + 1,
      name: String(body.name ?? `rule set ${(state.nextRuleSetId ?? 0) + 1}`),
      target: String(body.target ?? 'branch'),
      enforcement: String(body.enforcement ?? 'active'),
      conditions,
      rules: rules.map((rule) => ({
        type: String(rule.type ?? ''),
        parameters: isRecord(rule.parameters) ? rule.parameters : {},
      })),
      queue_rules: queues,
      _requiredStatusChecks: requiredChecks,
      _requiredApprovals: requiredApprovals,
      _requiresThreadResolution: requiresThreadResolution,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    state.nextRuleSetId = created.id
    recorded.push(created)
    return { status: 201, body: ruleSetDetail(created, repository) }
  }

  const ruleSet = new RegExp(`^${prefix}/rulesets/(\\d+)$`, 'u').exec(rawPath)
  if (ruleSet) {
    const recorded = state.ruleSets ?? []
    const index = recorded.findIndex((entry) => entry.id === Number(ruleSet[1]))
    if (index === -1) throw new HttpError(404, 'Not Found', `No rule set ${ruleSet[1]}`)
    if (method === 'DELETE') {
      recorded.splice(index, 1)
      return { status: 204, body: null }
    }
    if (method !== 'GET')
      throw new HttpError(405, 'Method Not Allowed', 'unsupported rule set method')
    return { status: 200, body: ruleSetDetail(recorded[index], repository) }
  }

  return null
}

/** The GraphQL operations the review surface owns. */
export function handleSurfaceGraphql(
  state: GitHubFixtureState,
  body: Record<string, unknown>,
  viewer: string,
): RestResult | null {
  const query = String(body.query ?? '')
  const variables = isRecord(body.variables) ? body.variables : {}

  // A thread's own comment connection, read through its node id. The tail of a long
  // conversation is only reachable this way, and a reconciliation of a lost write reads
  // it to learn which comment ids the thread already holds, so a host that answered
  // nothing here would report every thread as empty.
  if (query.includes('node(id: $threadId)')) {
    const threadId = String(variables.threadId ?? '')
    const entry = Object.values(state.reviewThreads ?? {}).findIndex((list) =>
      list.some((thread) => thread.id === threadId),
    )
    const number = entry === -1 ? null : Object.keys(state.reviewThreads ?? {})[Number(entry)]
    const thread =
      number === null
        ? null
        : (state.reviewThreads?.[number] ?? []).find((candidate) => candidate.id === threadId)
    if (thread === null || thread === undefined) {
      return {
        status: 200,
        body: {
          data: { node: null },
          errors: [
            {
              type: 'NOT_FOUND',
              message: `Could not resolve to a ReviewThread with the id of '${threadId}'.`,
            },
          ],
        },
      }
    }
    return {
      status: 200,
      body: {
        data: {
          node: {
            __typename: 'PullRequestReviewThread',
            id: thread.id,
            comments: {
              totalCount: thread.comments.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: thread.comments.map((comment) => ({
                ...comment,
                viewerDidAuthor: comment.author.login === viewer,
              })),
            },
          },
        },
      },
    }
  }

  if (query.includes('reviewThreads(first:')) {
    const number = Number(variables.number)
    const pr = pullRequestOf(state, number)
    const threads = threadsOf(state, number)
    return {
      status: 200,
      body: {
        data: {
          repository: {
            viewerPermission: viewerPermissionOf(state),
            pullRequest: {
              state: pr.state,
              viewerDidAuthor: pr.author === undefined ? true : pr.author === viewer,
              reviewThreads: {
                totalCount: threads.length,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: threads.map((thread) => threadNode(thread, viewer)),
              },
            },
          },
        },
      },
    }
  }

  if (query.includes('viewerDidAuthor }')) {
    const number = Number(variables.number)
    const pr = pullRequestOf(state, number)
    return {
      status: 200,
      body: {
        data: {
          viewer: { login: viewer },
          repository: {
            viewerPermission: viewerPermissionOf(state),
            pullRequest: {
              state: pr.state,
              viewerDidAuthor: pr.author === undefined ? true : pr.author === viewer,
            },
          },
        },
      },
    }
  }

  const reply = /addPullRequestReviewThreadReply/u.test(query)
  const resolve = /resolveReviewThread\(input/u.test(query)
  const unresolve = /unresolveReviewThread\(input/u.test(query)
  if (!reply && !resolve && !unresolve) return null

  // These three mutations build their `input` inline from the operation's own variables
  // rather than taking one as a variable, so there is no `variables.input` to read. A
  // surface that looked for one would answer every reply, resolve, and reopen with an
  // empty thread id — the shape of a 404 GitHub would only ever send for an id that
  // names no thread.
  const wanted = reply
    ? String(variables.pullRequestReviewThreadId ?? variables.threadId ?? '')
    : String(variables.threadId ?? '')
  const replyBody = String(
    isRecord(variables.input) ? (variables.input.body ?? '') : (variables.body ?? ''),
  )
  for (const threads of Object.values(state.reviewThreads ?? {})) {
    const thread = threads.find((entry) => entry.id === wanted)
    if (!thread) continue
    if (reply) {
      const id = `PRTC_${nextId(state, 'nextThreadId')}`
      thread.comments.push({
        id,
        body: replyBody,
        createdAt: '2026-01-01T00:00:00Z',
        url: `https://github.com/${thread.path}`,
        viewerDidAuthor: true,
        author: { login: viewer },
        // A reply continues a conversation; it is not part of any review.
        reviewId: null,
      })
      thread.viewerCanUnresolve = true
      return {
        status: 200,
        body: { data: { addPullRequestReviewThreadReply: { comment: { id, url: thread.path } } } },
      }
    }
    thread.isResolved = !unresolve
    thread.viewerCanResolve = !thread.isResolved
    thread.viewerCanUnresolve = thread.isResolved
    return {
      status: 200,
      body: {
        data: {
          [unresolve ? 'unresolveReviewThread' : 'resolveReviewThread']: {
            thread: { id: thread.id, isResolved: thread.isResolved },
          },
        },
      },
    }
  }
  throw new HttpError(
    404,
    'Not Found',
    `Could not resolve to a ReviewThread with the id of '${wanted}'.`,
  )
}

/** One rule set, as the endpoints that read configuration back store it. */
function ruleSetDetail(rules: FixtureRuleSet, repository: string) {
  return {
    ...ruleSetIdentity(rules, repository),
    bypass_actors: [],
    current_user_can_bypass: 'never',
    conditions: rules.conditions ?? {},
    rules: rules.rules ?? [],
  }
}

/**
 * The rule sets that are enforced for one base branch.
 *
 * A rule set whose ref-name condition excludes this branch, or includes a different one,
 * does not apply to a pull request that targets it. Evaluating the condition here is what
 * keeps the merge gate, the effective branch-rule read and the queue dispatcher agreeing
 * about which branch a rule protects.
 */
export function applicableRuleSets(state: GitHubFixtureState, base: string): FixtureRuleSet[] {
  const defaultBranch = state.repository.defaultBranch
  return (state.ruleSets ?? []).filter(
    (rules) =>
      rules.enforcement === 'active' &&
      refConditionMatches(rules.conditions, { branch: base, defaultBranch }),
  )
}

/**
 * Whether a merge queue is configured for one base branch, which is what makes a default
 * merge enqueue rather than merge directly. A queue belongs to a base ref, so a rule set
 * that protects another branch says nothing about this one.
 */
export function mergeQueueFor(state: GitHubFixtureState, base: string): boolean {
  const configured = applicableRuleSets(state, base).some(
    (rules) => (rules.queue_rules ?? []).length > 0,
  )
  if (configured) return true
  // The fixture's own switch names a queue on the default branch, or on the refs it lists.
  if (state.mergeQueue !== true) return false
  const refs = state.mergeQueueRefs
  return !refs || refs.length === 0 || refs.includes(base)
}

/**
 * The effective rules `GET /repos/{owner}/{repo}/rules/branches/{branch}` answers with,
 * projected from the rule sets that were created through the API.
 *
 * A rule set stored by this host but never routed into this read would leave the consumer
 * reporting that no context is required while the merge gate refuses the very same merge
 * for that context. The projection is the rule as GitHub reports it, with the rule set it
 * came from.
 */
export function ruleSetBranchRules(state: GitHubFixtureState, branch: string): unknown[] {
  const entries: unknown[] = []
  for (const rules of applicableRuleSets(state, branch)) {
    for (const rule of rules.rules ?? []) {
      if (rule.type === 'required_status_checks') {
        const parameters = isRecord(rule.parameters) ? rule.parameters : {}
        const required = Array.isArray(parameters.required_status_checks)
          ? parameters.required_status_checks
          : []
        entries.push({
          type: 'required_status_checks',
          ruleset_id: rules.id,
          ruleset_source: 'Repository',
          ruleset_source_type: 'Repository',
          parameters: {
            required_status_checks: required
              .filter(isRecord)
              .filter((check) => typeof check.context === 'string')
              .map((check) => ({
                context: check.context,
                integration_id:
                  typeof check.integration_id === 'number' ? check.integration_id : null,
              })),
          },
        })
      }
    }
  }
  return entries
}

/**
 * What the active rules say about merging this pull request, or null when nothing blocks
 * it. The rule set scenarios are only meaningful if the host actually refuses the merges
 * the rules forbid, rather than agreeing with whatever the client hoped would happen.
 *
 * The rules that apply are the ones whose ref-name condition covers this pull request's
 * base, the approvals are counted from each reviewer's current decision rather than from
 * the history of reviews, and a reviewer who has asked for changes blocks the merge until
 * they approve again.
 */
export function ruleSetRefusal(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
  headSha: string,
): string | null {
  const recorded = state.reviews?.[String(pr.number)] ?? []
  const decisions = standingReviewDecisions(recorded)
  for (const rules of applicableRuleSets(state, pr.base)) {
    const head = hostRefSha(`refs/heads/${pr.head}`)
    if (head !== headSha) return 'head SHA no longer matches'
    for (const context of rules._requiredStatusChecks) {
      const run = (state.checks?.checkRuns ?? []).find(
        (entry) => entry.headSha === headSha && entry.name === context,
      )
      if (!run) return `required status check ${context} is expected`
      if (run.status !== 'completed' || run.conclusion !== 'success') {
        return `required status check ${context} is not successful`
      }
    }
    if (rules._requiresThreadResolution === true) {
      const open = threadsOf(state, pr.number).filter((thread) => !thread.isResolved)
      if (open.length > 0) {
        return `all conversations must be resolved: ${open.length} unresolved`
      }
    }
    // An author does not approve their own pull request, so their approval is not one of
    // the reviewers a gate counts. Counting historical rows instead would let the same
    // person satisfy a two-reviewer gate by approving twice.
    const approvals = decisions.filter(
      (decision) =>
        decision.state === 'APPROVED' &&
        decision.login.toLowerCase() !== (pr.author ?? '').toLowerCase(),
    ).length
    if (approvals < rules._requiredApprovals) {
      return `required approving reviews: ${approvals} of ${rules._requiredApprovals}`
    }
    const blocked = decisions.find((decision) => decision.state === 'CHANGES_REQUESTED')
    if (blocked) return `changes requested by ${blocked.login}`
  }
  return null
}
