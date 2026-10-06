import { createHash } from 'node:crypto'
import { REVIEW_STACK_METADATA_LIMIT } from '../shared/performance'

import type {
  ReviewAnchorResolution,
  ReviewCommit,
  ReviewCommitSet,
  ReviewFile,
  ReviewFileSet,
  ReviewHeadline,
  ReviewHunk,
  ReviewComparison,
  ReviewLine,
  ReviewLineRef,
  ReviewSide,
  ReviewStackRail,
  ReviewStackMemberFacts,
  ReviewReviewerSummary,
} from '../shared/review'
import {
  isWhitespaceOnlyChange,
  looksGenerated,
  reviewChangeBlocks,
  reviewLineContent,
  sameReviewComparison,
} from '../shared/review'
import type { DiffHunk, DiffHunkLine, NativeStack } from '../shared/types'
import { getConfigValue, parseRemote, type ParsedRemote } from './git-core'
import { isRecord } from '../shared/guards'
import { hostTransport, remoteHostContext } from './github-host'
import { GitHubTransportError, type GitHubTransport } from './github-transport'
import { getPullRequest } from './github'
import { listPullRequestStacks } from './native-stacks'
import { parseHunkBlock } from './hunks'

/**
 * GitHub refuses to page a pull request's file list past this many entries, so
 * a read that stops here is reported as incomplete rather than as "all files".
 */
const REVIEW_FILE_PAGE_LIMIT = 3000

const REVIEW_PAGE_SIZE = 100

const HUNK_HEADER = /^@@ /u

function errorDetail(error: unknown): string {
  if (error instanceof GitHubTransportError) return error.detail
  if (error instanceof Error && error.message) return error.message

  return 'The request failed.'
}

function isCancelledRead(error: unknown): boolean {
  if (error instanceof GitHubTransportError) return error.kind === 'cancelled'
  return false
}

/**
 * The repository's origin, when it is a GitHub host this build can speak to. Which
 * host that is matters as much as which repository: a review is read, submitted and
 * re-read on that one host, so the host travels with the remote rather than being
 * assumed to be the public one.
 */
export async function originRemote(repoPath: string, signal?: AbortSignal): Promise<ParsedRemote> {
  const remote = parseRemote(await getConfigValue(repoPath, 'remote.origin.url', signal))
  if (!remote || !remoteHostContext(remote)) {
    throw new Error('Pull request review requires a GitHub origin remote.')
  }
  return remote
}

/**
 * The transport for the host a remote names, for every review read and write
 * that remote drives: permissions, conversations, submission, replies,
 * resolution, and history. A review is one host's business end to end, so a
 * consumer that asked the public host instead would read — or publish — against
 * a same-named repository on the wrong server.
 */
export function reviewTransport(remote: ParsedRemote): GitHubTransport {
  const host = remoteHostContext(remote)
  if (!host) throw new Error('Pull request review requires a GitHub origin remote.')
  return hostTransport(host)
}

function statusOf(value: unknown): ReviewFile['status'] {
  switch (value) {
    case 'added':
    case 'removed':
    case 'renamed':
    case 'copied':
    case 'modified':
    case 'changed':
    case 'unchanged':
      return value
    default:
      return 'changed'
  }
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * Quotes a path the way Git quotes one inside a `diff --git` line, so a path with
 * a space, a tab, or a non-ASCII character is still read back as itself. Paths
 * made only of characters Git never quotes are left alone, which keeps the
 * synthesized header byte-identical to what a local diff would have produced.
 */
function gitHeaderToken(path: string): string {
  if (/^[\w.\-/]+$/u.test(path)) return path
  let quoted = '"'
  for (const ch of path) {
    if (ch === '"') quoted += '\\"'
    else if (ch === '\\') quoted += '\\\\'
    else if (ch === '\t') quoted += '\\t'
    else if (ch === '\n') quoted += '\\n'
    else if (ch === '\r') quoted += '\\r'
    else if (ch < ' ') quoted += `\\${ch.codePointAt(0)!.toString(8).padStart(3, '0')}`
    else quoted += ch
  }
  return `${quoted}"`
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * A line's content identity: its file plus its text with the diff marker removed.
 *
 * The line number is deliberately absent. A force-push that inserts a line above
 * renumbers everything below it, and a hunk that grows at the top renumbers its
 * own body, so a number cannot tell a reviewer that the line they read is still
 * the line they are commenting on. The text can, as long as the text did not
 * change.
 */
function lineAnchor(path: string, text: string): string {
  return shortHash(`${path}\u0000${reviewLineContent(text)}`)
}

/**
 * The anchor plus two neighbouring lines of the same hunk on each side.
 * Context distinguishes exact from moved only for a unique same-side anchor;
 * it never disambiguates duplicate line text.
 */
function lineContext(anchor: string, lines: readonly DiffHunkLine[], index: number) {
  const neighbours: string[] = []
  for (let offset = -2; offset <= 2; offset += 1) {
    if (offset === 0) continue
    const at = index + offset
    if (at < 0 || at >= lines.length) continue
    neighbours.push(`${offset > 0 ? '+' : '-'}${offset}:${reviewLineContent(lines[at].text)}`)
  }
  return shortHash(`${anchor}\u0000${neighbours.join('\u0001')}`)
}

/** Every line of a hunk has an address; only changed lines have a counterpart to compare with. */
function reviewHunkLines(path: string, hunk: DiffHunk): ReviewLine[] {
  const lines = hunk.lines
  const anchors = lines.map((line) => lineAnchor(path, line.text))
  const whitespaceOnly = new Set<number>()
  for (const block of reviewChangeBlocks(lines)) {
    if (block.kind !== 'change') continue
    for (let step = 0; step < Math.min(block.removes.length, block.adds.length); step += 1) {
      const remove = block.removes[step]
      const add = block.adds[step]
      if (isWhitespaceOnlyChange(lines[remove].text, lines[add].text)) {
        whitespaceOnly.add(remove)
        whitespaceOnly.add(add)
      }
    }
  }
  return lines.map((line, index) => ({
    kind: line.kind,
    text: line.text,
    oldLine: line.oldLine,
    newLine: line.newLine,
    // A removed line is addressed on the base, an added line on the head, and a
    // context line — which carries the same number on both sides — on the head.
    // A marker line has no address at all.
    side: reviewSideFor(line),
    anchor: anchors[index],
    context: lineContext(anchors[index], lines, index),
    whitespaceOnly: whitespaceOnly.has(index),
  }))
}

function reviewSideFor(line: DiffHunkLine): ReviewLine['side'] {
  if (line.kind === 'marker') return null
  if (line.kind === 'remove') return 'base'
  if (line.kind === 'add') return 'head'
  return 'head'
}

export function toReviewHunk(path: string, hunk: DiffHunk): ReviewHunk {
  return {
    id: hunk.id,
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: reviewHunkLines(path, hunk),
  }
}

function countHunkHeaders(patch: string): number {
  return patch.split('\n').filter((line) => HUNK_HEADER.test(line)).length
}

/**
 * Turns one entry of the pull request files resource into a review file.
 *
 * Missing patches with zero line counts can be metadata-only or binary changes.
 * Preserve that uncertainty; only a verified patch is rendered as text.
 */
export function parseReviewFileEntry(value: unknown): ReviewFile | null {
  if (!isRecord(value) || typeof value.filename !== 'string' || value.filename === '') return null
  const path = value.filename
  const previousPath = typeof value.previous_filename === 'string' ? value.previous_filename : null
  const additions = countOf(value.additions)
  const deletions = countOf(value.deletions)
  const patch = typeof value.patch === 'string' ? value.patch : null
  const file: ReviewFile = {
    path,
    previousPath,
    status: statusOf(value.status),
    additions,
    deletions,
    changes: countOf(value.changes),
    sha: typeof value.sha === 'string' ? value.sha : null,
    generated: looksGenerated(path),
    diff: { kind: 'unreadable', reason: 'GitHub returned an unreadable file entry.' },
  }
  if (patch === null || patch.trim() === '') {
    file.diff = additions === 0 && deletions === 0 ? { kind: 'no-text' } : { kind: 'too-large' }
    return file
  }
  const identity = { path, originalPath: previousPath }
  const oldToken = gitHeaderToken(`a/${previousPath ?? path}`)
  const block = parseHunkBlock(
    `diff --git ${oldToken} ${gitHeaderToken(`b/${path}`)}\n${patch}\n`,
    identity,
  )
  const declared = countHunkHeaders(patch)
  if (declared === 0) {
    file.diff = {
      kind: 'unreadable',
      reason: 'GitHub returned a patch for this file with no hunk header to anchor it to.',
    }
    return file
  }
  if (block.hunks.length !== declared) {
    const refused = declared - block.hunks.length
    file.diff = {
      kind: 'unreadable',
      reason: `GitHub returned a partial patch: ${refused} of ${declared} hunks could not be verified, so the rest of this file is not shown.`,
    }
    return file
  }
  file.diff = { kind: 'text', hunks: block.hunks.map((hunk) => toReviewHunk(path, hunk)) }
  return file
}

function stackRail(stacks: NativeStack[], number: number): ReviewStackRail {
  const stack = stacks.find((entry) =>
    entry.pullRequests.some((member) => member.number === number),
  )
  if (!stack) {
    return {
      state: 'not-stacked',
      stack: null,
      previous: null,
      next: null,
      message: 'This pull request is not part of a native GitHub stack.',
    }
  }
  const selected = stack.pullRequests.find((member) => member.number === number)!
  return {
    state: 'member',
    stack,
    previous:
      stack.pullRequests.find((member) => member.position === selected.position - 1) ?? null,
    next: stack.pullRequests.find((member) => member.position === selected.position + 1) ?? null,
    message:
      stack.pullRequests.length < stack.size
        ? 'Native membership is partial; omitted positions are not stack boundaries.'
        : '',
  }
}

async function readReviewerSummary(
  remote: ParsedRemote,
  number: number,
  headOid: string | undefined,
  signal?: AbortSignal,
): Promise<ReviewReviewerSummary> {
  try {
    const result = await reviewTransport(remote).graphql<unknown>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            headRefOid
            reviewRequests(first: 100) {
              pageInfo { hasNextPage }
              nodes { requestedReviewer {
                ... on User { login }
                ... on Team { slug }
              } }
            }
            latestReviews(first: 100) {
              pageInfo { hasNextPage }
              nodes { author { login } state commit { oid } }
            }
          }
        }
      }`,
      { owner: remote.owner, name: remote.name, number },
      { signal },
    )
    if (signal?.aborted) throw new Error('Review read cancelled')
    const repository = isRecord(result) ? result.repository : null
    const node = isRecord(repository) ? repository.pullRequest : null
    if (!isRecord(node) || !headOid || node.headRefOid !== headOid) {
      throw new Error('Reviewer metadata does not match the selected pull request head.')
    }
    const requests = node.reviewRequests
    const latest = node.latestReviews
    if (
      !isRecord(requests) ||
      !Array.isArray(requests.nodes) ||
      !isRecord(latest) ||
      !Array.isArray(latest.nodes) ||
      !isRecord(requests.pageInfo) ||
      typeof requests.pageInfo.hasNextPage !== 'boolean' ||
      !isRecord(latest.pageInfo) ||
      typeof latest.pageInfo.hasNextPage !== 'boolean'
    )
      throw new Error('GitHub did not return complete reviewer metadata.')
    let partial = requests.pageInfo.hasNextPage || latest.pageInfo.hasNextPage
    const requested: ReviewReviewerSummary['requested'] = []
    const reviews: ReviewReviewerSummary['reviews'] = []
    for (const entry of requests.nodes) {
      const reviewer = isRecord(entry) ? entry.requestedReviewer : null
      if (isRecord(reviewer) && typeof reviewer.login === 'string' && reviewer.login) {
        requested.push({ kind: 'user', name: reviewer.login })
      } else if (isRecord(reviewer) && typeof reviewer.slug === 'string' && reviewer.slug) {
        requested.push({ kind: 'team', name: reviewer.slug })
      } else partial = true
    }
    for (const entry of latest.nodes) {
      const author = isRecord(entry) ? entry.author : null
      if (
        !isRecord(entry) ||
        !isRecord(author) ||
        typeof author.login !== 'string' ||
        !author.login ||
        typeof entry.state !== 'string' ||
        !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(
          entry.state,
        )
      ) {
        partial = true
        continue
      }
      const commit = isRecord(entry.commit) ? entry.commit : null
      reviews.push({
        login: author.login,
        state: entry.state as ReviewReviewerSummary['reviews'][number]['state'],
        headOid: commit && typeof commit.oid === 'string' ? commit.oid : null,
      })
    }
    return {
      state: partial ? 'partial' : 'available',
      requested,
      reviews,
      message: partial
        ? 'Reviewer metadata is incomplete; only the first 100 requests and latest reviews are shown.'
        : '',
    }
  } catch (error) {
    if (signal?.aborted || isCancelledRead(error)) throw error
    return {
      state: 'unavailable',
      requested: [],
      reviews: [],
      message: `Reviewer metadata unavailable: ${errorDetail(error)}`,
    }
  }
}

/**
 * One bounded batch, not a read per layer. Membership remains authoritative even
 * when this optional summary is refused or the stack exceeds the summary budget.
 */
async function readStackFacts(
  remote: ParsedRemote,
  rail: ReviewStackRail,
  number: number,
  selectedHead: string | undefined,
  signal?: AbortSignal,
): Promise<ReviewStackRail> {
  if (!rail.stack) return rail
  const budget = REVIEW_STACK_METADATA_LIMIT
  const ordered = rail.stack.pullRequests
    .filter((member) => Number.isSafeInteger(member.number) && member.number > 0)
    .sort((a, b) => a.position - b.position)
  const selected = ordered.find((member) => member.number === number)
  const members = ordered.slice(0, budget)
  if (selected && !members.includes(selected)) members[members.length - 1] = selected
  if (members.length === 0)
    return {
      ...rail,
      message: 'Native membership contains no accessible PR identities; metadata was not read.',
    }
  const unknown = (
    member: NativeStack['pullRequests'][number],
    message: string,
  ): ReviewStackMemberFacts => ({
    number: member.number,
    state: 'unavailable',
    title: null,
    lifecycle: null,
    draft: null,
    checks: 'unknown',
    review: 'unknown',
    message,
  })
  try {
    const fields = members
      .map(
        (member, index) => `layer${index}: pullRequest(number: ${member.number}) {
      title headRefOid state isDraft reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }`,
      )
      .join('\n')
    const result = await reviewTransport(remote).graphql<unknown>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner: remote.owner, name: remote.name },
      { signal },
    )
    if (signal?.aborted)
      throw new GitHubTransportError({ kind: 'cancelled', detail: 'Review read cancelled' })
    const repository = isRecord(result) && isRecord(result.repository) ? result.repository : null
    const facts = members.map((member, index): ReviewStackMemberFacts => {
      const node = repository?.[`layer${index}`]
      if (!isRecord(node)) return unknown(member, 'Layer metadata unavailable from GitHub.')
      const expectedHead = member.number === number ? selectedHead : member.headSha
      const nativeHead = member.headSha
      if (
        typeof node.headRefOid === 'string' &&
        node.headRefOid &&
        ((expectedHead && node.headRefOid !== expectedHead) ||
          (nativeHead && node.headRefOid !== nativeHead))
      ) {
        return {
          ...unknown(member, 'Layer metadata head differs from authoritative membership.'),
          state: 'stale',
        }
      }
      const title = typeof node.title === 'string' && node.title ? node.title : null
      const lifecycle =
        node.state === 'OPEN' || node.state === 'CLOSED' || node.state === 'MERGED'
          ? node.state
          : null
      const draft = typeof node.isDraft === 'boolean' ? node.isDraft : null
      let checks: ReviewStackMemberFacts['checks'] = 'unknown'
      let review: ReviewStackMemberFacts['review'] = 'unknown'
      if (expectedHead && node.headRefOid === expectedHead) {
        const commits = isRecord(node.commits) ? node.commits : null
        const entries = commits && Array.isArray(commits.nodes) ? commits.nodes : null
        const entry = entries?.length === 1 && isRecord(entries[0]) ? entries[0] : null
        const commit = entry && isRecord(entry.commit) ? entry.commit : null
        const rollup = commit?.statusCheckRollup
        if (rollup === null) checks = 'none'
        else if (isRecord(rollup)) {
          if (rollup.state === 'SUCCESS') checks = 'passing'
          else if (rollup.state === 'FAILURE' || rollup.state === 'ERROR') checks = 'failing'
          else if (rollup.state === 'PENDING' || rollup.state === 'EXPECTED') checks = 'pending'
        }
        if (node.reviewDecision === null) review = 'none'
        else if (node.reviewDecision === 'APPROVED') review = 'approved'
        else if (node.reviewDecision === 'CHANGES_REQUESTED') review = 'changes-requested'
        else if (node.reviewDecision === 'REVIEW_REQUIRED') review = 'required'
      }
      const partial =
        !title || !lifecycle || draft === null || checks === 'unknown' || review === 'unknown'
      return {
        number: member.number,
        state: partial ? 'partial' : 'available',
        title,
        lifecycle,
        draft,
        checks,
        review,
        message: partial ? 'Missing or unpinned layer facts remain unknown.' : '',
      }
    })
    return {
      ...rail,
      facts,
      message:
        members.length < ordered.length
          ? `Layer metadata is bounded to ${budget} members, including the viewed layer; submitted membership is unchanged.`
          : rail.message,
    }
  } catch (error) {
    if (signal?.aborted || isCancelledRead(error)) throw error
    return {
      ...rail,
      facts: members.map((member) =>
        unknown(member, `Layer metadata unavailable: ${errorDetail(error)}`),
      ),
    }
  }
}

/**
 * The headline read: pull request metadata plus the native stack it belongs to.
 *
 * The stack list is a second read rather than a reuse of the membership already
 * attached to the pull request, because a person reviewing a stacked pull
 * request needs the layers on both sides, not only a position. When that read
 * fails the headline still loads: the position the first read proved is kept,
 * and the reason the layers could not be listed is stated rather than swallowed.
 */
export async function readReviewHeadline(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewHeadline> {
  const pullRequest = await getPullRequest(repoPath, number, signal)
  const remote = await originRemote(repoPath, signal)
  const host = remoteHostContext(remote)
  if (!host) {
    throw new Error(
      `Review needs a GitHub origin remote; this repository's origin is on ${remote.host}.`,
    )
  }
  const reviewers = await readReviewerSummary(remote, number, pullRequest.headOid, signal)
  try {
    const stacks = await listPullRequestStacks(remote.owner, remote.name, {
      host,
      pullRequest: number,
      signal,
    })
    let membership = stackRail(stacks, number)
    if (membership.state === 'not-stacked' && pullRequest.stack) {
      membership = {
        ...membership,
        state: 'unavailable',
        message: `Stack #${pullRequest.stack.stackNumber} membership was reported for this PR, but its ordered members were not returned.`,
      }
    }
    const rail = await readStackFacts(remote, membership, number, pullRequest.headOid, signal)
    return { pullRequest, rail, reviewers }
  } catch (error) {
    if (isCancelledRead(error)) throw error
    const position = pullRequest.stack
      ? `Position ${pullRequest.stack.position} of ${pullRequest.stack.size} is known, but the layers around it could not be listed`
      : 'The native stack layers could not be listed'
    return {
      pullRequest,
      reviewers,
      rail: {
        state: 'unavailable',
        stack: null,
        previous: null,
        next: null,
        message: `${position}: ${errorDetail(error)}`,
      },
    }
  }
}

/**
 * The comparison a pull request's files are read against.
 *
 * The head alone is not enough. GitHub computes the file list and the diff
 * between the merge base of the base and head and the head, so a push to the
 * *base* branch moves the diff just as a force-push to the head does, with the
 * head object unchanged, and a retarget changes what the files are measured
 * against without either object moving. All three are therefore part of the
 * identity, and a set read while any of them moved describes a comparison that
 * never existed.
 */
export async function readReviewIdentity(
  remote: ParsedRemote,
  number: number,
  signal?: AbortSignal,
): Promise<{ comparison: ReviewComparison; totalCommits: number | null }> {
  const response = await reviewTransport(remote).rest<unknown>({
    method: 'GET',
    path: `repos/${remote.owner}/${remote.name}/pulls/${number}`,
    signal,
  })
  const data = isRecord(response.data) ? response.data : null
  const head = data && isRecord(data.head) ? data.head : null
  const base = data && isRecord(data.base) ? data.base : null
  return {
    comparison: {
      headOid: head && typeof head.sha === 'string' ? head.sha : null,
      baseOid: base && typeof base.sha === 'string' ? base.sha : null,
      baseRef: base && typeof base.ref === 'string' ? base.ref : null,
    },
    totalCommits:
      typeof data?.commits === 'number' && Number.isSafeInteger(data.commits) && data.commits >= 0
        ? data.commits
        : null,
  }
}

/**
 * Raised when the comparison moved while a paginated read was in flight.
 *
 * The pages already fetched are a mixture of two comparisons, and labelling them
 * with either object's object id would assert a revision the diff never came
 * from. Viewed-file marks and any comment written later would inherit that false
 * claim, so the read fails instead and the reader reloads against one revision.
 */
export class ReviewRevisionMovedError extends Error {
  constructor(number: number) {
    super(
      `Pull request #${number} changed while it was being read, so the pages do not belong to one revision. Reload to read it again.`,
    )
    this.name = 'ReviewRevisionMovedError'
  }
}

/**
 * Runs a paginated read pinned to one comparison.
 *
 * The comparison is read before the pages and again after them, so a force-push
 * to the head, a push to the base branch, and a retarget all fail closed. A read
 * that cannot learn the comparison (GitHub omitted an object, or the transport
 * could not reach it) is not treated as stable: a revision that cannot be pinned
 * must not be presented as though it were.
 *
 * The comparison returned is the one read *after* the pages were confirmed
 * stable, so a caller that records against it records against the comparison its
 * data actually came from rather than the one it hoped for.
 */
async function readPinnedPages<T>(
  remote: ParsedRemote,
  number: number,
  path: string,
  signal: AbortSignal | undefined,
  read: (entries: unknown[]) => T,
): Promise<{ comparison: ReviewComparison; totalCommits: number | null; value: T }> {
  const before = await readReviewIdentity(remote, number, signal)
  const raw = await reviewTransport(remote).paginate<unknown>({ method: 'GET', path, signal })
  const after = await readReviewIdentity(remote, number, signal)
  if (!sameReviewComparison(before.comparison, after.comparison))
    throw new ReviewRevisionMovedError(number)
  return { comparison: after.comparison, totalCommits: after.totalCommits, value: read(raw) }
}

/**
 * Every file of a pull request, read from GitHub rather than from the working
 * tree: reviewing a pull request must not require its branch to be checked out.
 */
export async function readReviewFiles(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewFileSet> {
  return readReviewFilesFrom(await originRemote(repoPath, signal), number, signal)
}

/**
 * The same read against an already-resolved origin.
 *
 * A review write resolves the origin once and then needs the diff twice: once
 * to show, and once more at the write boundary to revalidate what is about to be
 * posted. Both go through this one pinned read, so the diff a draft is judged
 * against is produced by the same code path as the diff on screen.
 */
export async function readReviewFilesFrom(
  remote: ParsedRemote,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewFileSet> {
  const { comparison, value: files } = await readPinnedPages<ReviewFile[]>(
    remote,
    number,
    `repos/${remote.owner}/${remote.name}/pulls/${number}/files?per_page=${REVIEW_PAGE_SIZE}`,
    signal,
    (raw) => {
      const files: ReviewFile[] = []
      for (const entry of raw) {
        const file = parseReviewFileEntry(entry)
        if (file) files.push(file)
      }
      return files
    },
  )
  return {
    number,
    comparison,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    truncated: files.length >= REVIEW_FILE_PAGE_LIMIT,
  }
}

/** GitHub caps this endpoint at 250 commits, even when more pages are requested. */
export async function readReviewCommits(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewCommitSet> {
  const remote = await originRemote(repoPath, signal)
  const { value: entries, totalCommits } = await readPinnedPages<unknown[]>(
    remote,
    number,
    `repos/${remote.owner}/${remote.name}/pulls/${number}/commits?per_page=${REVIEW_PAGE_SIZE}`,
    signal,
    (raw) => raw,
  )
  const commits: ReviewCommit[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.sha !== 'string' || entry.sha === '') continue
    const commit = isRecord(entry.commit) ? entry.commit : null
    const gitAuthor = commit && isRecord(commit.author) ? commit.author : null
    const gitCommitter = commit && isRecord(commit.committer) ? commit.committer : null
    const login =
      isRecord(entry.author) && typeof entry.author.login === 'string' ? entry.author.login : ''
    const message = commit && typeof commit.message === 'string' ? commit.message : ''
    const authoredAt =
      gitAuthor && typeof gitAuthor.date === 'string'
        ? gitAuthor.date
        : gitCommitter && typeof gitCommitter.date === 'string'
          ? gitCommitter.date
          : ''
    commits.push({
      oid: entry.sha,
      shortOid: entry.sha.slice(0, 7),
      message: message.split('\n')[0] ?? '',
      author:
        (gitAuthor && typeof gitAuthor.name === 'string' && gitAuthor.name) || login || 'Unknown',
      authoredAt,
    })
  }
  return {
    commits,
    total: totalCommits,
    truncated: totalCommits === null ? entries.length >= 250 : commits.length < totalCommits,
  }
}

/**
 * Re-resolves a stored line reference against a file set that was read at some
 * other commit. This is the check a review mutation has to make at its own
 * boundary: a comment may only be written where it can still be shown to name the
 * line the author was looking at.
 *
 * Exact means the line and its neighbourhood are both intact. Moved means the
 * line's own text is still present exactly once, somewhere else. Anything else —
 * edited text, a duplicated line, a file the pull request no longer touches — is
 * unresolved, and the caller is expected to say so rather than guess.
 */
export function resolveReviewAnchor(
  files: ReviewFileSet,
  ref: ReviewLineRef,
): ReviewAnchorResolution {
  const file = files.files.find((entry) => entry.path === ref.path)
  if (!file) {
    return {
      match: 'unresolved',
      ref: null,
      reason: `Pull request no longer changes ${ref.path}.`,
    }
  }
  if (file.diff.kind !== 'text') {
    return {
      match: 'unresolved',
      ref: null,
      reason: `The diff for ${ref.path} is not available as text, so the line cannot be verified.`,
    }
  }
  // A line is only ever identified against the side it is addressed on. A
  // removed line and an added line that happen to carry the same text are two
  // different facts about the pull request: matching across the side would let a
  // comment on a deletion re-anchor itself onto the line that replaced it and
  // read as if the reviewer had commented on the replacement. Cross-side text is
  // reported as the change it is, never resolved.
  const sameSide: Array<{ ref: ReviewLineRef; exact: boolean }> = []
  const otherSide: Array<ReviewLineRef> = []
  for (const hunk of file.diff.hunks) {
    for (const line of hunk.lines) {
      if (line.anchor !== ref.anchor || line.side === null) continue
      const number = line.side === 'base' ? line.oldLine : line.newLine
      if (number === null) continue
      const candidate: ReviewLineRef = {
        path: file.path,
        side: line.side,
        line: number,
        hunkId: hunk.id,
        anchor: line.anchor,
        context: line.context,
      }
      if (line.side !== ref.side) {
        otherSide.push(candidate)
        continue
      }
      sameSide.push({ exact: line.context === ref.context, ref: candidate })
    }
  }
  if (sameSide.length === 1) {
    if (sameSide[0].exact) return { match: 'exact', ref: sameSide[0].ref, reason: '' }
    return {
      match: 'moved',
      ref: sameSide[0].ref,
      reason: `The line moved from ${ref.side} line ${ref.line} to line ${sameSide[0].ref.line}.`,
    }
  }
  if (sameSide.length > 1) {
    return {
      match: 'unresolved',
      ref: null,
      reason: `${ref.path} now holds ${sameSide.length} identical lines, so the commented one cannot be named.`,
    }
  }
  if (otherSide.length > 0) {
    const sideName = (side: ReviewSide) => (side === 'base' ? 'the base' : 'the head')
    return {
      match: 'unresolved',
      ref: null,
      reason: `${ref.path} no longer holds this line on ${sideName(ref.side)}; the same text now appears on ${sideName(otherSide[0].side)}, which is a different line.`,
    }
  }
  return {
    match: 'unresolved',
    ref: null,
    reason: `The text this comment named is no longer in the diff for ${ref.path}.`,
  }
}
