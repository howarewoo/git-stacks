import { execFileSync } from 'node:child_process'
import { isRecord } from '../../src/shared/guards'
import type { FixtureThread, GitHubFixtureState } from './github-harness'
import type { GitHubApiDoubleRequest } from './github-api-double'
import { HttpError, type RestResult } from './github-rest'

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
function barePath(): string {
  const value = process.env.GIT_STACKS_FIXTURE_BARE
  if (!value) throw new Error('GIT_STACKS_FIXTURE_BARE is required by the GitHub review surface')
  return value
}

function realGit(): string {
  return process.env.GIT_STACKS_REAL_GIT || '/usr/bin/git'
}

function bareGit(args: string[]): string {
  return execFileSync(realGit(), ['--git-dir', barePath(), ...args], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * A ref that does not exist is a `null`, not a failure. `git rev-parse` exits non-zero
 * for a ref it cannot resolve, and that is GitHub's own 404 rather than a broken fixture.
 */
function refSha(ref: string): string | null {
  try {
    return bareGit(['rev-parse', '--verify', '--end-of-options', ref]) || null
  } catch {
    return null
  }
}

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

function actor(login: string): { login: string; id: number; type: string; url: string } {
  return { login, id: 1, type: 'User', url: `https://github.com/${login}` }
}

/**
 * GitHub's diff for a pull request: head against the merge base of head and base.
 * A ref that does not exist has no diff, and saying so is what keeps a missing
 * branch from being reported as a pull request with no changes.
 */
function patchFor(pr: GitHubFixtureState['prs'][number]): string {
  const head = refSha(`refs/heads/${pr.head}`)
  const base = refSha(`refs/heads/${pr.base}`)
  if (head === null || base === null) return ''
  const mergeBase = bareGit(['merge-base', base, head])
  if (mergeBase === '') return ''
  // Two-tree `git diff` has no preamble: its first line is the first file's own
  // `diff --git` header, which the API does send. Dropping a line here would silently
  // lose the first file of every diff.
  return bareGit(['diff', '--no-color', '--unified=3', mergeBase, head]).replace(/\n$/u, '')
}

/** The `filename`/`patch` entries GitHub returns for a pull request's files. */
function fileEntries(state: GitHubFixtureState, pr: GitHubFixtureState['prs'][number]): unknown[] {
  const patch = patchFor(pr)
  if (!patch) return []
  const entries: Array<Record<string, unknown>> = []
  let filename: string | null = null
  let body: string[] = []
  const head = refSha(`refs/heads/${pr.head}`) ?? ''
  const flush = () => {
    if (filename === null) return
    const text = body.join('\n')
    const lines = text.split('\n')
    const additions = lines.filter((line) => line.startsWith('+')).length
    const deletions = lines.filter((line) => line.startsWith('-')).length
    entries.push({
      sha: head,
      filename,
      status: 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.com/${state.repository.owner}/${state.repository.name}/blob/main/${filename}`,
      raw_url: `https://github.com/${state.repository.owner}/${state.repository.name}/raw/main/${filename}`,
      contents_url: `https://api.github.com/repos/${state.repository.owner}/${state.repository.name}/contents/${filename}`,
      patch: text,
    })
    filename = null
    body = []
  }
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      filename = /^diff --git a\/.+? b\/(.+)$/u.exec(line)?.[1] ?? ''
      continue
    }
    // A hunk header belongs in the patch; the rest of the git preamble does not.
    if (line.startsWith('@@')) body.push(line)
    else if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ '))
      continue
    else body.push(line)
  }
  flush()
  return entries
}

/**
 * The outcome GitHub records for each review verb.
 *
 * The two are not the same word: a request asks to `APPROVE` and the review is then read
 * back as `APPROVED`. Every reconciliation in the application matches on the recorded
 * outcome, so a host that echoed the verb would make a settled review unrecognisable.
 */
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
          sha: refSha(`refs/heads/${pr.head}`) ?? '',
          repo: { full_name: pr.headRepository },
        },
        base: { ref: pr.base, sha: refSha(`refs/heads/${pr.base}`) },
        user: { login: pr.author ?? state.currentUser },
      })),
    }
  }

  // Writing a check run is what a ruleset's required check is satisfied with, and GitHub
  // exposes no other way to satisfy one from outside a workflow. The application never
  // writes these, so a disposable run has to.
  const writeCheckRun = new RegExp(`^${prefix}/check-runs$`, 'u').exec(rawPath)
  if (writeCheckRun) {
    if (method !== 'POST') return null
    const headSha = String(body.head_sha ?? '')
    if (refSha(headSha) === null) {
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
    const sha = refSha(wanted) ?? refSha(`refs/heads/${wanted}`)
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
    if (method === 'GET') return { status: 200, body: recorded }
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
    pr.reviewDecision =
      event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : null
    return { status: 200, body: review }
  }

  const reviewComments = new RegExp(`^${prefix}/pulls/(\\d+)/comments$`, 'u').exec(rawPath)
  if (reviewComments) {
    if (method !== 'GET')
      throw new HttpError(405, 'Method Not Allowed', 'comments is read-only here')
    const number = Number(reviewComments[1])
    const head = refSha(`refs/heads/${pullRequestOf(state, number).head}`) ?? ''
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
    return { status: 200, body: flat }
  }

  if (rawPath === `${prefix}/git/refs`) {
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed', 'git refs requires POST')
    const ref = String(body.ref ?? '')
    const sha = String(body.sha ?? '')
    if (!ref.startsWith('refs/heads/')) {
      throw new HttpError(422, 'Unprocessable Entity', 'only branch refs are supported')
    }
    if (refSha(ref) !== null)
      throw new HttpError(422, 'Unprocessable Entity', `${ref} already exists`)
    if (refSha(sha) === null) throw new HttpError(422, 'Unprocessable Entity', `${sha} is unknown`)
    bareGit(['update-ref', ref, sha])
    return { status: 201, body: { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } } }
  }

  const refDelete = new RegExp(`^${prefix}/git/refs/heads/(.+)$`, 'u').exec(rawPath)
  if (refDelete) {
    if (method !== 'DELETE')
      throw new HttpError(405, 'Method Not Allowed', 'git refs requires DELETE')
    const ref = `refs/heads/${decodeURIComponent(refDelete[1])}`
    if (refSha(ref) === null) return { status: 204, body: null }
    bareGit(['update-ref', '-d', ref])
    return { status: 204, body: null }
  }

  if (rawPath === `${prefix}/rulesets`) {
    const recorded = (state.ruleSets ??= [])
    if (method === 'GET') return { status: 200, body: recorded }
    if (method !== 'POST')
      throw new HttpError(405, 'Method Not Allowed', 'unsupported rulesets method')
    const rules = Array.isArray(body.rules) ? (body.rules as Array<Record<string, unknown>>) : []
    const requiredChecks: string[] = []
    let requiredApprovals = 0
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
      }
      if (rule.type === 'merge_queue') queues.push(rule)
    }
    // The conditions and the rules are echoed back the way GitHub returns them, because a
    // queue is only proven by reading it back off the rule set that declares it. A double
    // that stored a flag instead would agree with whatever the client hoped for.
    const conditions = isRecord(body.conditions) ? body.conditions : {}
    const created = {
      id: (state.nextRuleSetId ?? 0) + 1,
      name: String(body.name ?? `rule set ${(state.nextRuleSetId ?? 0) + 1}`),
      target: String(body.target ?? 'branch'),
      enforcement: String(body.enforcement ?? 'active'),
      conditions,
      rules,
      queue_rules: queues,
      _requiredStatusChecks: requiredChecks,
      _requiredApprovals: requiredApprovals,
    }
    state.nextRuleSetId = created.id
    recorded.push(created)
    return { status: 201, body: created }
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
    return { status: 200, body: recorded[index] }
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
            viewerPermission: 'WRITE',
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
            viewerPermission: 'WRITE',
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

/**
 * What the active rules say about merging this pull request, or null when nothing
 * blocks it. The ruleset scenarios are only meaningful if the runtime actually
 * refuses the merges the rules forbid, rather than agreeing with whatever the
 * client hoped would happen.
 */
export function ruleSetRefusal(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
  headSha: string,
): string | null {
  for (const rules of state.ruleSets ?? []) {
    if (rules.enforcement !== 'active') continue
    const head = refSha(`refs/heads/${pr.head}`)
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
    if (rules._requiredApprovals > 0) {
      const recorded = state.reviews?.[String(pr.number)] ?? []
      // The recorded outcome is `APPROVED`, not the verb the request carried, so the
      // rule counts the same word the reviews read reports. A gate that counted the
      // verb would refuse every merge on a repository where approvals exist.
      const approvals = recorded.filter(
        (review) => review.state === RECORDED_REVIEW_STATES.APPROVE,
      ).length
      if (approvals < rules._requiredApprovals) {
        return `required approving reviews: ${approvals} of ${rules._requiredApprovals}`
      }
    }
  }
  return null
}
