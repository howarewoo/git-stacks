/**
 * Deterministic review reads for the fixture gallery.
 *
 * The shapes are the ones `readReviewHeadline`, `readReviewFiles`, and
 * `readReviewCommits` return in the main process, so the gallery renders what
 * the app renders. Anchors and contexts are content-derived here by the same
 * rule the main process uses, so a row identity in a fixture is a real identity.
 */
import {
  isWhitespaceOnlyChange,
  reviewChangeBlocks,
  type ReviewCommitSet,
  type ReviewFile,
  type ReviewFileSet,
  type ReviewHunk,
  type ReviewLine,
  type ReviewStackRail,
} from '../../../src/shared/review'
import type {
  ReviewEvent,
  ReviewPermissions,
  ReviewThreadSet,
} from '../../../src/shared/review-threads'
import type { DiffHunkLineKind, PullRequestStackMember } from '../../../src/shared/types'
import type { NativeStack, PullRequest } from '../../../src/shared/types'

type RawLine = [text: string, oldLine: number | null, newLine: number | null]

function hunk(path: string, header: string, raw: readonly RawLine[]): ReviewHunk {
  const lines: ReviewLine[] = raw.map(([text, oldLine, newLine]) => {
    const kind: DiffHunkLineKind =
      text[0] === '+' ? 'add' : text[0] === '-' ? 'remove' : text[0] === '\\' ? 'marker' : 'context'
    return {
      kind,
      text,
      oldLine,
      newLine,
      side: kind === 'remove' ? 'base' : kind === 'marker' ? null : 'head',
      anchor: `${path}\u0000${text.slice(1)}`,
      context: `${path}\u0000${text.slice(1)}\u0001`,
      whitespaceOnly: false,
    }
  })
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
  lines.forEach((line, index) => {
    line.whitespaceOnly = whitespaceOnly.has(index)
  })
  return {
    id: `fixture-${path}-${header.replace(/[^0-9a-z]/giu, '')}`,
    header,
    oldStart: raw[0]?.[1] ?? 0,
    oldLines: raw.filter(([, oldLine]) => oldLine !== null).length,
    newStart: raw[0]?.[2] ?? 0,
    newLines: raw.filter(([, , newLine]) => newLine !== null).length,
    lines,
  }
}

export function textFile(
  path: string,
  header: string,
  raw: readonly RawLine[],
  overrides: Partial<ReviewFile> = {},
): ReviewFile {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: raw.filter(([text]) => text[0] === '+').length,
    deletions: raw.filter(([text]) => text[0] === '-').length,
    changes: raw.filter(([text]) => text[0] === '+' || text[0] === '-').length,
    sha: `blob-${path}`,
    generated: false,
    diff: { kind: 'text', hunks: [hunk(path, header, raw)] },
    ...overrides,
  }
}

/** One pull request's files: a text patch, a whitespace-only pair, and every no-text state. */
export function reviewFileSet(number: number, headOid: string, baseRef = 'main'): ReviewFileSet {
  const files: ReviewFile[] = [
    textFile('src/main/review.ts', '@@ -1,6 +1,6 @@ export function readPullRequest()', [
      [' export function readPullRequest() {', 1, 1],
      ['-  return workingTreeDiff()', 2, null],
      ['-  return stagedDiff()', 3, null],
      ['+  return pullRequestDiff()', null, 2],
      ['+  return transportDiff()', null, 3],
      [' }', 4, 4],
    ]),
    textFile('src/app.ts', '@@ -8,3 +8,3 @@', [
      [' const spacing = true', 8, 8],
      ['-const width  = 80', 9, null],
      ['+const width = 80', null, 9],
      ['-const height = 60', 10, null],
      ['+const height = 40', null, 10],
      [' export default spacing', 11, 11],
    ]),
    {
      path: 'dist/bundle.js',
      previousPath: null,
      status: 'modified',
      additions: 0,
      deletions: 0,
      changes: 0,
      sha: 'blob-dist',
      generated: true,
      diff: {
        kind: 'text',
        hunks: [
          hunk('dist/bundle.js', '@@ -1,2 +1,2 @@', [
            ['+bundle size 120k', null, 1],
            ['+bundle size 121k', null, 2],
          ]),
        ],
      },
    },
    {
      path: 'assets/logo.png',
      previousPath: null,
      status: 'modified',
      additions: 0,
      deletions: 0,
      changes: 0,
      sha: 'blob-logo',
      generated: false,
      diff: { kind: 'binary' },
    },
    {
      path: 'src/renderer/src/App.tsx',
      previousPath: 'src/renderer/src/Shell.tsx',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      changes: 0,
      sha: null,
      generated: false,
      diff: { kind: 'too-large' },
    },
    textFile(
      'vendor/schema.graphql',
      '@@ -0,0 +1,300 @@',
      Array.from(
        { length: 300 },
        (_, index) => [`+schema line ${index}`, null, index + 1] as RawLine,
      ),
    ),
  ]
  return {
    number,
    comparison: { headOid, baseOid: 'b'.repeat(40), baseRef },
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated: false,
  }
}

export function reviewCommits(number: number): ReviewCommitSet {
  return {
    commits: [
      {
        oid: `commit-${number}-2`.padEnd(40, '0'),
        shortOid: `c${number}2`,
        message: `Read pull request #${number} without checking it out`,
        author: 'ada',
        authoredAt: '2026-09-24T10:00:00Z',
      },
      {
        oid: `commit-${number}-1`.padEnd(40, '0'),
        shortOid: `c${number}1`,
        message: 'Give the review workspace its own cancellation ids',
        author: 'ada',
        authoredAt: '2026-09-23T10:00:00Z',
      },
    ],
    total: 2,
    truncated: false,
  }
}

export function stackMember(
  position: number,
  number: number,
  total: number,
): PullRequestStackMember {
  return {
    position,
    number,
    total,
    head: `feature/review-${number}`,
    base: position === 1 ? 'main' : `feature/review-${number - 1}`,
    state: 'OPEN',
    draft: false,
  }
}

/**
 * The rail the headline carries: this pull request's own stack, or a rail that
 * says the membership could not be read.
 */
export function reviewRail(
  pullRequest: PullRequest,
  membership: readonly PullRequestStackMember[] | null,
): ReviewStackRail {
  if (!membership) {
    return {
      state: 'unavailable',
      stack: null,
      previous: null,
      next: null,
      message: 'GitHub did not return stack membership for this pull request.',
    }
  }
  const ordered = [...membership].sort((a, b) => a.position - b.position)
  const position = ordered.findIndex((member) => member.number === pullRequest.number)
  if (position === -1) {
    return {
      state: 'not-stacked',
      stack: null,
      previous: null,
      next: null,
      message: 'This pull request is not part of a native stack.',
    }
  }
  const stack: NativeStack = {
    id: 1,
    number: 42,
    url: `${pullRequest.url.replace(/\/pull\/\d+$/u, '')}/stacks/42`,
    base: ordered[0].base,
    open: true,
    createdAt: '2026-09-20T10:00:00Z',
    size: ordered.length,
    pullRequests: ordered,
    status: 'valid',
  }
  return {
    state: 'member',
    stack,
    previous: position > 0 ? ordered[position - 1] : null,
    next: position < ordered.length - 1 ? ordered[position + 1] : null,
    message: '',
  }
}

/**
 * The threads and the viewer's permissions for one pull request, in the shape
 * the main process returns.
 *
 * The gallery needs every state the conversation can be in, because the states
 * are the design: a resolved thread, an outdated one, a reply from the viewer, a
 * reviewer who cannot post, and a reviewer who is also the author and therefore
 * cannot approve their own pull request.
 */
export function reviewThreadSet(
  number: number,
  headOid: string,
  options: { resolved?: boolean; outdated?: boolean } = {},
): ReviewThreadSet {
  const comparison = { headOid, baseOid: 'b'.repeat(40), baseRef: 'main' }
  return {
    number,
    comparison,
    totalCount: 2,
    truncated: false,
    threads: [
      {
        id: 'T_thr_1',
        path: 'src/main/review.ts',
        side: 'head',
        line: 2,
        startLine: null,
        startSide: null,
        fileLevel: false,
        resolved: options.resolved ?? false,
        collapsed: false,
        outdated: options.outdated ?? false,
        viewerCanReply: true,
        viewerCanResolve: true,
        viewerCanUnresolve: true,
        commentCount: 2,
        commentsTruncated: false,
        comments: [
          {
            id: 'IC_1',
            author: 'acme-reviewer',
            body: 'Should this be re-read when the base moves, or is the head enough?',
            createdAt: '2026-09-23T09:00:00Z',
            url: 'https://github.com/acme/widgets/pull/7#discussion_r1',
            viewerDidAuthor: false,
          },
          {
            id: 'IC_2',
            author: 'acme-viewer',
            body: 'The base too — the head alone is not enough.',
            createdAt: '2026-09-23T09:12:00Z',
            url: 'https://github.com/acme/widgets/pull/7#discussion_r2',
            viewerDidAuthor: true,
          },
        ],
      },
      {
        id: 'T_thr_2',
        path: 'src/renderer/src/components/review-view.tsx',
        side: 'head',
        line: 12,
        startLine: 10,
        startSide: 'head',
        fileLevel: false,
        resolved: true,
        collapsed: true,
        outdated: true,
        viewerCanReply: true,
        viewerCanResolve: false,
        viewerCanUnresolve: true,
        commentCount: 1,
        commentsTruncated: false,
        comments: [
          {
            id: 'IC_3',
            author: 'acme-reviewer',
            body: 'This block moved in the last push; is it still doing this?',
            createdAt: '2026-09-22T16:30:00Z',
            url: 'https://github.com/acme/widgets/pull/7#discussion_r3',
            viewerDidAuthor: false,
          },
        ],
      },
    ],
  }
}

/** The viewer's permissions, with one event blocked at a time so each gate is visible. */
export function reviewPermissions(
  number: number,
  options: { isAuthor?: boolean; blocked?: ReviewEvent } = {},
): ReviewPermissions {
  const isAuthor = options.isAuthor ?? false
  const blocked: Partial<Record<ReviewEvent, string>> = {}
  if (options.blocked) blocked[options.blocked] = 'You do not have write access to this repository.'
  if (isAuthor) {
    blocked.APPROVE = 'You opened this pull request, and GitHub does not let you approve it.'
  }
  return {
    viewer: 'acme-viewer',
    isAuthor,
    state: 'OPEN',
    permission: options.blocked ? 'READ' : 'WRITE',
    blocked,
  }
}
