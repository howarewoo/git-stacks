import { createHash } from 'node:crypto'

import type {
  ReviewAnchorResolution,
  ReviewCommit,
  ReviewFile,
  ReviewFileSet,
  ReviewHeadline,
  ReviewHunk,
  ReviewLine,
  ReviewLineRef,
  ReviewStackRail,
} from '../shared/review'
import {
  adjacentStackLayer,
  isWhitespaceOnlyChange,
  looksGenerated,
  reviewChangeBlocks,
  reviewLineContent,
} from '../shared/review'
import type { DiffHunk, DiffHunkLine, NativeStack } from '../shared/types'
import { getConfigValue, isRecord, parseRemote, type ParsedRemote } from './git-core'
import { GitHubTransportError, githubTransport } from './github-transport'
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

async function originRemote(repoPath: string, signal?: AbortSignal): Promise<ParsedRemote> {
  const remote = parseRemote(await getConfigValue(repoPath, 'remote.origin.url', signal))
  if (!remote || remote.host !== 'github.com') {
    throw new Error('Pull request review requires a github.com origin remote.')
  }
  return remote
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
 * The anchor plus two neighbouring lines of the same hunk on each side. Two
 * identical lines in one file get identical anchors; the neighbourhood is what
 * separates them, and a line whose surroundings changed still resolves through
 * its anchor alone.
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

function toReviewHunk(path: string, hunk: DiffHunk): ReviewHunk {
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
 * The resource returns a per-file `patch` and omits it, without a reason, when
 * it declines to inline text. The two omissions are separated by what the entry
 * still counts: a file with changed bytes but no added and no removed text line
 * was not counted as text at all, while a file that GitHub counted lines for and
 * still declined to inline is a diff too large to show here. A patch that arrived
 * but did not verify is never rendered as if it had.
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
    file.diff = additions === 0 && deletions === 0 ? { kind: 'binary' } : { kind: 'too-large' }
    return file
  }
  const identity = { path, originalPath: previousPath }
  const oldToken = gitHeaderToken(previousPath ?? path)
  const block = parseHunkBlock(
    `diff --git a/${oldToken} b/${gitHeaderToken(path)}\n${patch}\n`,
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
  return {
    state: 'member',
    stack,
    previous: adjacentStackLayer(stack.pullRequests, number, -1),
    next: adjacentStackLayer(stack.pullRequests, number, 1),
    message: '',
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
  try {
    const stacks = await listPullRequestStacks(remote.owner, remote.name, {
      pullRequest: number,
      signal,
    })
    return { pullRequest, rail: stackRail(stacks, number) }
  } catch (error) {
    if (isCancelledRead(error)) throw error
    const position = pullRequest.stack
      ? `Position ${pullRequest.stack.position} of ${pullRequest.stack.size} is known, but the layers around it could not be listed`
      : 'The native stack layers could not be listed'
    return {
      pullRequest,
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

interface PullRequestHead {
  headSha: string | null
}

/**
 * The head commit a pull request points at right now. Read on its own so a file
 * set always carries the commit it was read at, rather than trusting a value the
 * renderer happened to hold from an earlier headline.
 */
async function readPullRequestHead(
  remote: ParsedRemote,
  number: number,
  signal?: AbortSignal,
): Promise<PullRequestHead> {
  const response = await githubTransport().rest<unknown>({
    method: 'GET',
    path: `repos/${remote.owner}/${remote.name}/pulls/${number}`,
    signal,
  })
  const head = isRecord(response.data) ? response.data.head : null
  const sha = isRecord(head) && typeof head.sha === 'string' ? head.sha : null
  return { headSha: sha }
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
  const remote = await originRemote(repoPath, signal)
  const { headSha } = await readPullRequestHead(remote, number, signal)
  const raw = await githubTransport().paginate<unknown>({
    method: 'GET',
    path: `repos/${remote.owner}/${remote.name}/pulls/${number}/files?per_page=${REVIEW_PAGE_SIZE}`,
    signal,
  })
  const files: ReviewFile[] = []
  for (const entry of raw) {
    const file = parseReviewFileEntry(entry)
    if (file) files.push(file)
  }
  return {
    number,
    headOid: headSha,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    truncated: files.length >= REVIEW_FILE_PAGE_LIMIT,
  }
}

/** The commits a pull request contains, newest last, as GitHub counts them. */
export async function readReviewCommits(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewCommit[]> {
  const remote = await originRemote(repoPath, signal)
  const raw = await githubTransport().paginate<unknown>({
    method: 'GET',
    path: `repos/${remote.owner}/${remote.name}/pulls/${number}/commits?per_page=${REVIEW_PAGE_SIZE}`,
    signal,
  })
  const commits: ReviewCommit[] = []
  for (const entry of raw) {
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
  return commits
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
  const candidates: Array<{ ref: ReviewLineRef; exact: boolean }> = []
  for (const hunk of file.diff.hunks) {
    for (const line of hunk.lines) {
      if (line.anchor !== ref.anchor) continue
      const number = line.side === 'base' ? line.oldLine : line.newLine
      if (line.side === null || number === null) continue
      candidates.push({
        exact: line.context === ref.context,
        ref: {
          path: file.path,
          side: line.side,
          line: number,
          hunkId: hunk.id,
          anchor: line.anchor,
          context: line.context,
        },
      })
    }
  }
  const exact = candidates.filter((candidate) => candidate.exact)
  if (exact.length === 1) return { match: 'exact', ref: exact[0].ref, reason: '' }
  if (exact.length > 1) {
    const sameSide = exact.filter((candidate) => candidate.ref.side === ref.side)
    if (sameSide.length === 1) return { match: 'exact', ref: sameSide[0].ref, reason: '' }
    return {
      match: 'unresolved',
      ref: null,
      reason: `${ref.path} now holds ${exact.length} identical lines, so the commented one cannot be named.`,
    }
  }
  if (candidates.length === 1) {
    return {
      match: 'moved',
      ref: candidates[0].ref,
      reason: `The line moved from ${ref.side === 'base' ? 'base' : 'head'} line ${ref.line} to line ${candidates[0].ref.line}.`,
    }
  }
  if (candidates.length > 1) {
    return {
      match: 'unresolved',
      ref: null,
      reason: `${ref.path} now holds ${candidates.length} identical lines, so the commented one cannot be named.`,
    }
  }
  return {
    match: 'unresolved',
    ref: null,
    reason: `The text this comment named is no longer in the diff for ${ref.path}.`,
  }
}
