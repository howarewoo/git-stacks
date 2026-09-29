/**
 * The review workspace's rules, proven without a window.
 *
 * Everything asserted here is a decision the workspace makes rather than a value
 * it copies: how a remote patch becomes lines with stable identity, what the
 * whitespace filter is allowed to hide, where a stacked pull request sits, what
 * the rail offers at the ends of a stack, and when a viewed mark stops counting.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  GitHubTransportError,
  setGitHubTransport,
  statusKind,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type GitHubTransport,
} from '../src/main/github-transport'
import {
  ReviewAnchorStaleError,
  ReviewComparisonMovedError,
  ReviewOutcomeUnknownError,
  ReviewWriteUncertainError,
  readReviewPermissions,
  readReviewThreads,
  replyToThread,
  resolveReviewDrafts,
  setThreadResolved,
  submitReview,
} from '../src/main/review-threads'
import { readReviewDrafts, writeReviewDrafts } from '../src/main/review-drafts'
import {
  reviewDraftsAt,
  reviewThreadState,
  type ReviewThread,
  type ReviewDraft,
  type ReviewDraftRecord,
} from '../src/shared/review-threads'
import {
  parseReviewFileEntry,
  readReviewCommits,
  readReviewFiles,
  resolveReviewAnchor,
  ReviewRevisionMovedError,
} from '../src/main/review'
import {
  adjacentReviewFileIndex,
  adjacentStackLayer,
  isWhitespaceOnlyChange,
  looksGenerated,
  reviewChangeBlocks,
  reviewComparisonDrift,
  reviewFileRows,
  reviewSplitRows,
  reviewStatusLetter,
  reviewUnifiedRows,
  summarizeReviewFiles,
  viewedPaths,
  visibleReviewFileRows,
  withViewedFile,
  type ReviewFile,
  type ReviewHunk,
  type ReviewLine,
} from '../src/shared/review'
import type { PullRequestStackMember } from '../src/shared/types'
import type { ReviewComparison, ReviewFileSet, ReviewLineRef } from '../src/shared/review'

/** The shape GitHub's "list pull request files" endpoint returns for one file. */
function apiFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    blob_url: 'https://github.com/acme/widgets/blob/sha/src/app.ts',
    raw_url: 'https://github.com/acme/widgets/raw/sha/src/app.ts',
    contents_url: 'https://api.github.com/repos/acme/widgets/contents/src/app.ts?ref=sha',
    patch: ['@@ -4,3 +4,3 @@ export function f() {', ' a', '-b', '+c', ' d'].join('\n'),
    sha: 'blob-sha',
    ...overrides,
  }
}

function hunks(patch: string, path = 'src/app.ts'): ReviewHunk[] {
  const file = parseReviewFileEntry(apiFile({ patch, filename: path }))
  assert.ok(file && file.diff.kind === 'text', 'expected a parseable text diff')
  return file.diff.hunks
}

function file(overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path: 'src/app.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    sha: 'blob-sha',
    generated: false,
    diff: { kind: 'text', hunks: hunks('@@ -1,1 +1,1 @@\n-a\n+b') },
    ...overrides,
  }
}

/**
 * A line's own address, the way a stored review comment would have captured it
 * at the moment it was written.
 */
function refFor(
  hunk: ReviewHunk,
  index: number,
  overrides: Partial<ReviewLineRef> = {},
): ReviewLineRef {
  const line = hunk.lines[index]
  if (line.side === null) throw new Error('a marker line has no address')
  return {
    path: 'src/app.ts',
    side: line.side,
    line: line.side === 'base' ? (line.oldLine ?? 0) : (line.newLine ?? 0),
    hunkId: hunk.id,
    anchor: line.anchor,
    context: line.context,
    ...overrides,
  }
}

/** One hunk of a file whose diff parsed as text, named so a test can address it. */
function textHunk(entry: ReviewFile, index: number): ReviewHunk {
  const diff = entry.diff
  assert.equal(diff.kind, 'text')
  const hunk = diff.kind === 'text' ? diff.hunks[index] : undefined
  assert.ok(hunk, `expected a parsed hunk at index ${index}`)
  return hunk
}

/** A comparison with three distinct objects, so a change to any one of them is visible. */
function comparison(overrides: Partial<ReviewComparison> = {}): ReviewComparison {
  return { headOid: 'a'.repeat(40), baseOid: 'b'.repeat(40), baseRef: 'main', ...overrides }
}

function fileSet(entry: ReviewFile): ReviewFileSet {
  return {
    number: 7,
    comparison: comparison(),
    files: [entry],
    additions: entry.additions,
    deletions: entry.deletions,
    truncated: false,
  }
}

/** The repository and account the draft journal is keyed by, as the workspace sees them. */
const JOURNAL_OWNER = { repo: 'acme/widgets', viewer: 'ada' }


test('a replaced line is addressed on the side it belongs to, with both numbers', () => {
  const [hunk] = hunks(['@@ -4,3 +4,3 @@ export function f() {', ' a', '-b', '+c', ' d'].join('\n'))
  assert.equal(hunk.oldStart, 4)
  assert.equal(hunk.newStart, 4)
  assert.deepEqual(
    hunk.lines.map((line) => [line.side, line.kind, line.text.trim(), line.oldLine, line.newLine]),
    [
      ['head', 'context', 'a', 4, 4],
      ['base', 'remove', '-b', 5, null],
      ['head', 'add', '+c', null, 5],
      ['head', 'context', 'd', 6, 6],
    ],
  )
})

test('a line keeps its identity when it moves, so a comment anchor survives', () => {
  const before = hunks('@@ -1,4 +1,4 @@\n one\n keep\n two\n three')[0]
  const ref = refFor(before, 1)
  const moved = fileSet(
    file({ diff: { kind: 'text', hunks: hunks('@@ -20,4 +20,4 @@\n one\n keep\n two\n three') } }),
  )
  const resolution = resolveReviewAnchor(moved, ref)
  // Nineteen lines were inserted above, the text is intact, and the reference now
  // names the line the author is looking at.
  assert.equal(resolution.match, 'exact')
  assert.equal(resolution.ref?.line, 21)
  assert.equal(resolution.reason, '')

  const edited = fileSet(
    file({ diff: { kind: 'text', hunks: hunks('@@ -1,1 +1,1 @@\n-one\n+two') } }),
  )
  const missing = resolveReviewAnchor(edited, ref)
  assert.equal(missing.match, 'unresolved')
  assert.equal(missing.ref, null)
  assert.match(missing.reason, /no longer in the diff/u)
})

test('a duplicated line is reported as unnameable rather than guessed at', () => {
  const before = hunks('@@ -1,3 +1,3 @@\n keep\n keep\n keep')[0]
  // The stored neighbourhood no longer matches any of them, so none is exact.
  const ref = refFor(before, 1, { context: 'a-context-that-no-longer-exists' })
  const resolution = resolveReviewAnchor(
    fileSet(file({ diff: { kind: 'text', hunks: hunks('@@ -1,3 +1,3 @@\n keep\n keep\n keep') } })),
    ref,
  )
  assert.equal(resolution.match, 'unresolved')
  assert.match(resolution.reason, /3 identical lines/u)
})

test('a duplicate anchor stays unresolved even when only the clone retains its old context', () => {
  const before = hunks('@@ -1,5 +1,5 @@\n a\n b\n target\n c\n d')[0]
  const after = fileSet(
    file({
      diff: {
        kind: 'text',
        hunks: hunks('@@ -1,8 +1,8 @@\n a\n b\n target\n c\n d\n x\n target\n y'),
      },
    }),
  )
  const resolution = resolveReviewAnchor(after, refFor(before, 2))
  assert.equal(resolution.match, 'unresolved')
  assert.equal(resolution.ref, null)
})

test('remote patches retain spaced and non-ASCII paths, including renamed preimages', () => {
  for (const path of ['src/my file.ts', 'src/naïve.ts', 'src/quote"and\\slash.ts']) {
    const parsed = parseReviewFileEntry(
      apiFile({ filename: path, previous_filename: 'src/old name.ts', status: 'renamed' }),
    )
    assert.equal(parsed?.path, path)
    assert.equal(parsed?.previousPath, 'src/old name.ts')
    assert.ok(parsed?.diff.kind === 'text')
    assert.deepEqual(
      parsed.diff.hunks[0].lines.map((line) => line.text),
      [' a', '-b', '+c', ' d'],
    )
  }
})

test('patchless zero-line changes do not imply binary content', () => {
  for (const status of ['renamed', 'modified', 'added']) {
    const parsed = parseReviewFileEntry(
      apiFile({
        status,
        previous_filename: status === 'renamed' ? 'src/old.ts' : undefined,
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: undefined,
      }),
    )
    assert.equal(parsed?.diff.kind, 'no-text')
    assert.equal(parsed?.status, status)
  }
})

test('a reference into a file the pull request no longer touches says so', () => {
  const before = hunks('@@ -1,2 +1,2 @@\n a\n-b\n+B')[0]
  const resolution = resolveReviewAnchor(
    {
      number: 7,
      comparison: comparison({ headOid: null }),
      files: [file({ path: 'other.ts' })],
      additions: 0,
      deletions: 0,
      truncated: false,
    },
    refFor(before, 1),
  )
  assert.equal(resolution.match, 'unresolved')
  assert.match(resolution.reason, /no longer changes src\/app\.ts/u)
})

test('a line whose neighbourhood changed is reported as moved, and says where it went', () => {
  const before = hunks('@@ -1,2 +1,2 @@\n a\n-b\n+B')[0]
  const ref = refFor(before, 1)
  // Same text, different neighbours: the line still exists once, so it is
  // resolvable, but only its old neighbourhood could have made it exact.
  const after = fileSet(
    file({ diff: { kind: 'text', hunks: hunks('@@ -1,4 +1,4 @@\n x\n y\n-b\n+B\n z') } }),
  )
  const resolution = resolveReviewAnchor(after, ref)
  assert.equal(resolution.match, 'moved')
  assert.equal(resolution.ref?.line, 3)
  assert.match(resolution.reason, /moved from base line 2 to line 3/u)
})

test('the whitespace filter hides only lines that differ by whitespace alone', () => {
  const patch = [
    '@@ -1,4 +1,4 @@',
    ' keep',
    '-const a = 1',
    '+const a =  1',
    '-const b = 2',
    '+const c = 3',
    ' tail',
  ].join('\n')
  const plain = reviewUnifiedRows(hunks(patch), { hideWhitespace: false })
  assert.equal(plain.filter((row) => row.kind === 'line').length, 6)

  const filtered = reviewUnifiedRows(hunks(patch), { hideWhitespace: true })
  // The real edit in the same change block is untouched by the filter.
  const kept = filtered.filter((row) => row.kind === 'line')
  assert.deepEqual(
    kept.map((row) => (row.kind === 'line' ? row.line.text : '')),
    [' keep', '-const b = 2', '+const c = 3', ' tail'],
  )
  const header = filtered.find((row) => row.kind === 'hunk')
  assert.ok(header && header.kind === 'hunk')
  assert.equal(header.hidden, 2)
  // Git's own header text is preserved verbatim; the hidden count is separate
  // data, so a reader can check the count against the header they recognise.
  assert.equal(header.header, '@@ -1,4 +1,4 @@')

  // A whitespace-only test compares the two spellings, so a line that only ever
  // appeared on one side is not treated as changed-by-whitespace.
  assert.equal(isWhitespaceOnlyChange('a  b', 'a b'), true)
  assert.equal(isWhitespaceOnlyChange('a b', 'a c'), false)
  assert.equal(isWhitespaceOnlyChange('a b', 'a b'), false)
})

test('split rows pair a changed run by position and leave the extras on their own', () => {
  const patch = ['@@ -1,4 +1,3 @@', ' a', '-b', '-c', '+x', ' d'].join('\n')
  const rows = reviewSplitRows(hunks(patch), { hideWhitespace: false })
  const paired = rows.filter((row) => row.kind === 'split')
  assert.equal(paired.length, 4)
  assert.deepEqual(
    paired.map((row) =>
      row.kind === 'split' ? [row.left?.line.text ?? null, row.right?.line.text ?? null] : [],
    ),
    [
      [null, ' a'],
      ['-b', '+x'],
      ['-c', null],
      [null, ' d'],
    ],
  )
})

test('a change block groups adjacent changes, and the extras are counted, not lost', () => {
  const parsed = hunks(['@@ -1,3 +1,3 @@', '-a', '+A', ' mid', '-b', '+B'].join('\n'))
  const blocks = reviewChangeBlocks(parsed[0].lines)
  assert.equal(blocks.length, 3)
  // The two changed runs are separated by a context line, so they are two blocks
  // and not one run that happens to be long.
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['change', 'single', 'change'],
  )
})

test('a rename is reported with both paths, and the generated flag is labelled a guess', () => {
  const renamed = parseReviewFileEntry(
    apiFile({
      filename: 'src/main/git.ts',
      previous_filename: 'src/main/git-core.ts',
      status: 'renamed',
      patch: null,
    }),
  )
  assert.equal(renamed?.previousPath, 'src/main/git-core.ts')
  assert.equal(renamed?.status, 'renamed')
  // GitHub sends no patch for a pure rename; the entry still has to appear.
  assert.notEqual(renamed?.diff.kind, 'text')

  const generated = parseReviewFileEntry(apiFile({ filename: 'dist/bundle.js' }))
  assert.equal(generated?.generated, true)
  assert.equal(parseReviewFileEntry(apiFile({ filename: 'src/app.ts' }))?.generated, false)
})

test('an entry GitHub did not send a filename for is dropped, not rendered blank', () => {
  assert.equal(parseReviewFileEntry({ status: 'modified' }), null)
  assert.equal(parseReviewFileEntry(null), null)
  assert.equal(parseReviewFileEntry('nonsense'), null)
})

test('generated output is recognized by its own conventions and nothing else', () => {
  assert.equal(looksGenerated('dist/bundle.js'), true)
  assert.equal(looksGenerated('src/generated/types.pb.go'), true)
  assert.equal(looksGenerated('tests/__snapshots__/app.test.ts.snap'), true)
  assert.equal(looksGenerated('src/app.ts'), false)
  // "dist" only means generated output as a whole path segment, not as any
  // substring of a file name.
  assert.equal(looksGenerated('src/distribution.ts'), false)
  assert.equal(looksGenerated('src/redirect.ts'), false)
})

test('the file tree groups by directory, keeps preimage names, and collapses on request', () => {
  const rows = reviewFileRows([
    file({ path: 'src/renderer/app.tsx' }),
    file({ path: 'src/renderer/store.ts' }),
    file({ path: 'README.md' }),
    file({ path: 'src/main/git.ts', previousPath: 'src/main/git-core.ts', status: 'renamed' }),
  ])
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      'dir:src',
      'dir:src/main',
      'file:src/main/git.ts',
      'dir:src/renderer',
      'file:src/renderer/app.tsx',
      'file:src/renderer/store.ts',
      'file:README.md',
    ],
  )
  const renamed = rows.find((row) => row.kind === 'file' && row.path === 'src/main/git.ts')
  assert.ok(renamed && renamed.kind === 'file')
  assert.equal(renamed.file.previousPath, 'src/main/git-core.ts')
  assert.equal(renamed.name, 'git.ts')
  assert.equal(renamed.depth, 2)

  const shown = visibleReviewFileRows(rows, new Set(['src/renderer']), new Set(['README.md']))
  assert.equal(
    shown.some((row) => row.path === 'src/renderer/app.tsx'),
    false,
  )
  const directory = shown.find((row) => row.kind === 'directory' && row.path === 'src/renderer')
  assert.ok(directory && directory.kind === 'directory')
  // A collapsed parent keeps its count, so the row does not change what it claims.
  assert.equal(directory.fileCount, 2)
  const read = shown.find((row) => row.kind === 'file' && row.path === 'README.md')
  assert.ok(read && read.kind === 'file' && read.viewed)
})

test('file navigation steps in tree order and stops at the ends', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts']
  assert.equal(adjacentReviewFileIndex(paths, 'a.ts', 1), 'b.ts')
  assert.equal(adjacentReviewFileIndex(paths, 'b.ts', -1), 'a.ts')
  assert.equal(adjacentReviewFileIndex(paths, 'c.ts', 1), null)
  assert.equal(adjacentReviewFileIndex(paths, 'a.ts', -1), null)
  // A selection the filter just removed resolves to no neighbour, so a stale
  // selection cannot move a reviewer somewhere they did not choose.
  assert.equal(adjacentReviewFileIndex(paths, 'missing.ts', 1), null)
})

function member(position: number, number: number): PullRequestStackMember {
  return {
    position,
    number,
    total: 3,
    head: `layer-${position}`,
    base: 'main',
    state: 'OPEN',
    draft: false,
  }
}

test('layer navigation sorts by position and treats the ends as boundaries', () => {
  const members: PullRequestStackMember[] = [member(3, 8), member(1, 6), member(2, 7)]
  assert.equal(adjacentStackLayer(members, 7, -1)?.number, 6)
  assert.equal(adjacentStackLayer(members, 7, 1)?.number, 8)
  assert.equal(adjacentStackLayer(members, 6, -1), null)
  assert.equal(adjacentStackLayer(members, 8, 1), null)
  assert.equal(adjacentStackLayer(members, 99, 1), null)
})

test('the file summary counts binary and unreadable files apart from text', () => {
  const summary = summarizeReviewFiles([
    file({ path: 'a.ts' }),
    file({ path: 'b.png', status: 'added', diff: { kind: 'binary' } }),
    file({ path: 'c.ts', diff: { kind: 'too-large' } }),
    file({ path: 'd.ts', status: 'removed' }),
  ])
  assert.deepEqual(summary, {
    additions: 4,
    deletions: 4,
    changed: 4,
    text: 2,
    binary: 1,
    unavailable: 1,
  })
})

test('a viewed mark belongs to one comparison and is dropped when the head moves', () => {
  const at = comparison()
  const afterPush = comparison({ headOid: 'c'.repeat(40) })
  let record = withViewedFile(null, 7, at, 'src/a.ts', '2026-01-01T00:00:00.000Z')
  record = withViewedFile(record, 7, at, 'src/b.ts', '2026-01-01T00:00:01.000Z')
  assert.deepEqual(record.paths, ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(record.comparison, at)

  // New commits change the patch, so a mark made against the old head is no
  // longer a mark on the same content.
  const moved = withViewedFile(record, 7, afterPush, 'src/c.ts', '2026-01-02T00:00:00.000Z')
  assert.deepEqual(moved.paths, ['src/c.ts'])
  assert.deepEqual(moved.comparison, afterPush)
  assert.deepEqual(viewedPaths(moved, 7, afterPush), ['src/c.ts'])
  // A record read against a different comparison or a different pull request is
  // not evidence about this one.
  assert.deepEqual(viewedPaths(moved, 7, at), [])
  assert.deepEqual(viewedPaths(moved, 8, afterPush), [])
})

test('a viewed mark is dropped when the base branch advances under a fixed head', () => {
  // The head never moves, so a head-only check calls this stable. It is not: a
  // push to the base branch moves the merge base, and the file set is now a
  // different set of changes. A mark carried across would claim these files were
  // reviewed when nobody has seen this diff.
  const at = comparison()
  const afterBasePush = comparison({ baseOid: 'd'.repeat(40) })
  const record = withViewedFile(null, 7, at, 'src/a.ts', '2026-01-01T00:00:00.000Z')
  assert.deepEqual(record.paths, ['src/a.ts'])

  assert.deepEqual(viewedPaths(record, 7, afterBasePush), [])
  // And the next mark starts a fresh record rather than appending to the old one.
  const reopened = withViewedFile(record, 7, afterBasePush, 'src/b.ts', '2026-01-02T00:00:00.000Z')
  assert.deepEqual(reopened.paths, ['src/b.ts'])
})

test('a viewed mark is dropped when the pull request is retargeted to another base', () => {
  // Retargeting can leave both object ids untouched, so this is only detectable
  // by the branch name. It is still a different comparison, and it is a routine
  // action a reviewer will meet, so the drift is reported as such rather than as
  // a general staleness.
  const at = comparison({ baseRef: 'main' })
  const retargeted = comparison({ baseRef: 'release' })
  const record = withViewedFile(null, 7, at, 'src/a.ts', '2026-01-01T00:00:00.000Z')

  assert.deepEqual(viewedPaths(record, 7, retargeted), [])
  assert.equal(reviewComparisonDrift(retargeted, at), 'base-name')
  // A rename of the same branch is the same case, and the same cheap drop.
  assert.equal(reviewComparisonDrift(at, comparison({ baseRef: 'trunk' })), 'base-name')
  // Nothing moved: the marks are the marks.
  assert.equal(reviewComparisonDrift(at, comparison()), 'none')
  assert.deepEqual(viewedPaths(record, 7, at), ['src/a.ts'])
})

test('drift says which part of the comparison moved, and an unreadable one is its own case', () => {
  const at = comparison()
  assert.equal(reviewComparisonDrift(at, comparison({ headOid: 'e'.repeat(40) })), 'head')
  assert.equal(reviewComparisonDrift(at, comparison({ baseOid: 'f'.repeat(40) })), 'base')
  assert.equal(reviewComparisonDrift(at, comparison({ baseRef: 'release' })), 'base-name')
  // A comparison that cannot name its objects is not a comparison, so it is
  // reported as unreadable rather than being compared field by field.
  assert.equal(reviewComparisonDrift(at, comparison({ headOid: null })), 'unreadable')
  assert.equal(reviewComparisonDrift(at, comparison({ baseOid: null })), 'unreadable')
  // The head is checked first, because a force-push is the more consequential
  // of the two movements.
  assert.equal(
    reviewComparisonDrift(at, comparison({ headOid: 'e'.repeat(40), baseOid: 'f'.repeat(40) })),
    'head',
  )
})

test('re-marking a file replaces its timestamp instead of duplicating it', () => {
  const at = comparison()
  let record = withViewedFile(null, 7, at, 'src/a.ts', '2026-01-01T00:00:00.000Z')
  record = withViewedFile(record, 7, at, 'src/a.ts', '2026-01-02T00:00:00.000Z')
  assert.deepEqual(record.paths, ['src/a.ts'])
  assert.equal(record.updatedAt, '2026-01-02T00:00:00.000Z')
})

test('status letters name the change so a row is readable without a legend', () => {
  assert.equal(reviewStatusLetter('added'), 'A')
  assert.equal(reviewStatusLetter('removed'), 'D')
  assert.equal(reviewStatusLetter('renamed'), 'R')
  assert.equal(reviewStatusLetter('modified'), 'M')
})

test('a marker line carries no number and no side', () => {
  const parsed = hunks(['@@ -1,1 +1,1 @@', '-a', '+b', '\\ No newline at end of file'].join('\n'))
  const marker: ReviewLine | undefined = parsed[0].lines.find(
    (line) => line.oldLine === null && line.newLine === null,
  )
  assert.ok(marker)
  assert.equal(marker.side, null)
})

/**
 * A transport that answers the pull request identity and the paginated read, and
 * lets a test decide which comparison the pages belong to. `movesBeforePages`
 * is the sequence of identities the pull request reports: each identity read
 * takes the next one, so a test can move the head or the base between the read
 * that pins the revision and the read that confirms it.
 */
function scriptedTransport(
  identities: Array<{
    head: string | null
    base: string | null
    baseRef?: string
    commits?: number
  }>,
  pages: unknown[],
): { transport: GitHubTransport; calls: string[] } {
  const calls: string[] = []
  let identityRead = 0
  const reply = <T>(data: T): GitHubRestResponse<T> => ({ status: 200, rateLimit: rateLimit(), data })
  return {
    calls,
    transport: {
      kind: 'direct',
      async rest<T>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
        const path = request.path ?? ''
        calls.push(path)
        if (path.includes('/files') || path.includes('/commits')) return reply(pages as T)
        const value = identities[Math.min(identityRead, identities.length - 1)]
        identityRead += 1
        return reply({
          head: { sha: value.head },
          base: { sha: value.base, ref: value.baseRef ?? 'main' },
          commits: value.commits,
        } as T)
      },
      async paginate<T>(): Promise<T[]> {
        return pages as T[]
      },
      async graphql<T>(): Promise<T> {
        return {} as T
      },
    },
  }
}

/** A workspace whose origin points at the repository the scripted transport answers for. */
async function reviewWorkspace(): Promise<{ repo: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-review-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Git Stacks test')
  git('config', 'user.email', 'test@example.invalid')
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  return { repo, dispose: () => rm(root, { recursive: true, force: true }) }
}

test('a file set read while nothing moved is returned, tagged with the head it came from', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport, calls } = scriptedTransport(
    [{ head: 'a'.repeat(40), base: 'b'.repeat(40) }],
    [apiFile()],
  )
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const set = await readReviewFiles(workspace.repo, 7)

  // The published comparison is the one read after the pages were confirmed
  // stable, and it carries all three parts, so a later read that publishes a
  // thread set can be compared against this one field by field.
  assert.deepEqual(set.comparison, {
    headOid: 'a'.repeat(40),
    baseOid: 'b'.repeat(40),
    baseRef: 'main',
  })
  assert.equal(set.files.length, 1)
  assert.equal(set.files[0].path, 'src/app.ts')
  // The comparison is pinned by reading the identity before the pages and again
  // after them, so a change during the read cannot slip through unnoticed.
  assert.equal(
    calls.filter((path) => path === 'repos/acme/widgets/pulls/7').length,
    2,
    'expected the identity to be read on both sides of the pages',
  )
})

test('a file set is refused when the head is force-pushed while the pages are read', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // First identity read pins the revision; the second observes the force-push.
  const { transport } = scriptedTransport(
    [
      { head: 'a'.repeat(40), base: 'b'.repeat(40) },
      { head: 'c'.repeat(40), base: 'b'.repeat(40) },
    ],
    [apiFile()],
  )
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(
    () => readReviewFiles(workspace.repo, 7),
    (error: unknown) => {
      assert.ok(error instanceof ReviewRevisionMovedError)
      assert.match(error.message, /changed while it was being read/)
      return true
    },
  )
})

test('a file set is refused when the base branch moves, which changes the diff under a fixed head', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // The head never moves, so a head-only check would call this stable. GitHub
  // diffs the head against the merge base of the two, so this is a different
  // comparison and the pages already fetched belong to neither one.
  const { transport } = scriptedTransport(
    [
      { head: 'a'.repeat(40), base: 'b'.repeat(40) },
      { head: 'a'.repeat(40), base: 'd'.repeat(40) },
    ],
    [apiFile()],
  )
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => readReviewFiles(workspace.repo, 7), ReviewRevisionMovedError)
})

test('a file set is refused rather than returned untagged when the head cannot be read', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // GitHub omitted the head object. A set that cannot name its revision must
  // not be handed on as though it could.
  const { transport } = scriptedTransport([{ head: null, base: 'b'.repeat(40) }], [apiFile()])
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => readReviewFiles(workspace.repo, 7), ReviewRevisionMovedError)
})

test('the commit list is pinned to one comparison too, so a force-push cannot leave it short', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport } = scriptedTransport(
    [
      { head: 'a'.repeat(40), base: 'b'.repeat(40) },
      { head: 'c'.repeat(40), base: 'b'.repeat(40) },
    ],
    [
      {
        sha: 'e'.repeat(40),
        commit: { message: 'One commit', author: { name: 'Dev', date: '2026-09-23' } },
      },
    ],
  )
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => readReviewCommits(workspace.repo, 7), ReviewRevisionMovedError)
})

test('a commit list read while nothing moved is returned in full', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport } = scriptedTransport(
    [{ head: 'a'.repeat(40), base: 'b'.repeat(40) }],
    [
      {
        sha: 'e'.repeat(40),
        commit: { message: 'First commit', author: { name: 'Dev', date: '2026-09-23' } },
      },
      {
        sha: 'f'.repeat(40),
        commit: { message: 'Second commit', author: { name: 'Dev', date: '2026-09-24' } },
      },
    ],
  )
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const commits = await readReviewCommits(workspace.repo, 7)

  assert.deepEqual(
    commits.commits.map((entry) => entry.shortOid),
    ['eeeeeee', 'fffffff'],
  )
})

test('commit-list completeness distinguishes the API cap from an exact total', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  t.after(() => setGitHubTransport(null))
  const pages = Array.from({ length: 250 }, (_, index) => ({
    sha: index.toString(16).padStart(40, '0'),
    commit: { message: `Commit ${index}` },
  }))
  for (const [total, truncated] of [
    [251, true],
    [250, false],
    [undefined, true],
  ] as const) {
    const { transport } = scriptedTransport(
      [{ head: 'a'.repeat(40), base: 'b'.repeat(40), commits: total }],
      pages,
    )
    setGitHubTransport(transport)
    const result = await readReviewCommits(workspace.repo, 7)
    assert.equal(result.truncated, truncated)
    assert.equal(result.total, total ?? null)
    assert.equal(result.commits.length, 250)
  }
})

test('a comment on a removed line is not re-anchored onto identical text on the head side', () => {
  // A reviewer commented on a line the pull request deleted. The author then
  // added a line carrying the same text on the head side. Both carry the same
  // anchor, so an anchor-only match would re-anchor the base-side comment onto
  // the head-side line and read as a comment on the replacement.
  const before = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,2 @@\n-warn\n+other\n keep', 'src/app.ts') },
  })
  const beforeHunk = textHunk(before, 0)
  const ref = refFor(
    beforeHunk,
    beforeHunk.lines.findIndex((line) => line.side === 'base'),
  )
  assert.equal(ref.side, 'base', 'expected the commented line to be a removal')

  // The current diff keeps the text on the head side only.
  const after = file({
    diff: {
      kind: 'text',
      hunks: hunks('@@ -5,3 +5,3 @@\n keep\n-gone\n+warn\n tail', 'src/app.ts'),
    },
  })
  const afterHunk = textHunk(after, 0)
  assert.ok(
    afterHunk.lines.some((line) => line.side === 'head' && line.anchor === ref.anchor),
    'expected the text to still exist on the head side',
  )
  assert.ok(
    !afterHunk.lines.some((line) => line.side === 'base' && line.anchor === ref.anchor),
    'expected the text to be gone from the base side',
  )

  const resolution = resolveReviewAnchor(fileSet(after), ref)

  assert.equal(resolution.match, 'unresolved')
  assert.equal(resolution.ref, null)
  assert.match(resolution.reason, /no longer holds this line on the base/)
  assert.match(resolution.reason, /same text now appears on the head/)
  assert.match(resolution.reason, /which is a different line/)
})

test('a comment on an added line is not re-anchored onto identical text on the base side', () => {
  const before = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,2 @@\n-gone\n+warn\n keep', 'src/app.ts') },
  })
  const beforeHunk = textHunk(before, 0)
  const ref = refFor(
    beforeHunk,
    beforeHunk.lines.findIndex((line) => line.side === 'head'),
  )
  assert.equal(ref.side, 'head', 'expected the commented line to be an addition')

  const after = file({
    diff: {
      kind: 'text',
      hunks: hunks('@@ -5,3 +5,3 @@\n keep\n-warn\n+other\n tail', 'src/app.ts'),
    },
  })

  const resolution = resolveReviewAnchor(fileSet(after), ref)

  assert.equal(resolution.match, 'unresolved')
  assert.equal(resolution.ref, null)
  assert.match(resolution.reason, /no longer holds this line on the head/)
  assert.match(resolution.reason, /same text now appears on the base/)
})

test('a comment resolves to the same side when both sides carry identical text', () => {
  // The same text exists on both sides, but only the head-side line is the one
  // the comment was written about, so that is the line it must resolve to.
  const both = file({
    diff: {
      kind: 'text',
      hunks: hunks('@@ -1,3 +1,3 @@\n keep\n-common\n+common\n tail', 'src/app.ts'),
    },
  })
  const hunk = textHunk(both, 0)
  const headIndex = hunk.lines.findIndex((line) => line.side === 'head')
  assert.ok(headIndex >= 0, 'expected an added line')

  const resolution = resolveReviewAnchor(fileSet(both), refFor(hunk, headIndex))

  assert.equal(resolution.match, 'exact')
  assert.equal(resolution.ref?.side, 'head')
  assert.equal(resolution.ref?.line, hunk.lines[headIndex].newLine)
})

test('a file of pure additions shows every added line in split, not just the first', () => {
  // A newly added file is one pure run with nothing to pair against. It has to
  // arrive as one block per line, or the split layout shows one line of a hundred
  // with nothing to page to and no warning that the rest is missing.
  const total = 100
  const raw = Array.from({ length: total }, (_, index) => [`+added line ${index}`, null, index + 1])
  const rows = reviewSplitRows(
    hunks(`@@ -0,0 +1,${total} @@\n${raw.map(([text]) => text).join('\n')}`, 'src/new.ts'),
    {
      hideWhitespace: false,
    },
  )

  const lines = rows.filter((row) => row.kind === 'split')
  assert.equal(rows.filter((row) => row.kind === 'hunk').length, 1)
  assert.equal(lines.length, total, 'every added line needs its own split row')
  assert.deepEqual(
    lines.map((row) => (row.kind === 'split' ? row.right?.number : null)),
    Array.from({ length: total }, (_, index) => index + 1),
  )
  assert.ok(
    lines.every((row) => row.kind === 'split' && row.left === null && row.right !== null),
    'an added line belongs only on the head side',
  )
})

test('a file of pure deletions shows every removed line in split, on the base side', () => {
  const total = 100
  const raw = Array.from({ length: total }, (_, index) => [
    `-removed line ${index}`,
    index + 1,
    null,
  ])
  const rows = reviewSplitRows(
    hunks(`@@ -1,${total} +0,0 @@\n${raw.map(([text]) => text).join('\n')}`, 'src/gone.ts'),
    {
      hideWhitespace: false,
    },
  )

  const lines = rows.filter((row) => row.kind === 'split')
  assert.equal(lines.length, total, 'every removed line needs its own split row')
  assert.deepEqual(
    lines.map((row) => (row.kind === 'split' ? row.left?.number : null)),
    Array.from({ length: total }, (_, index) => index + 1),
  )
  assert.ok(
    lines.every((row) => row.kind === 'split' && row.right === null),
    'a removed line belongs only on the base side',
  )
})

test('each hunk header introduces its own lines, in order', () => {
  // Two hunks in one file. A header prepended to the whole file would render as
  // header B, header A, lines A, lines B: the second hunk would have nothing
  // introducing it, and its range would sit above the first hunk's lines.
  const twoHunks: ReviewHunk[] = [
    ...hunks('@@ -1,3 +1,3 @@\n alpha\n-beta\n+beta\n gamma', 'src/multi.ts'),
    ...hunks('@@ -40,3 +40,3 @@\n delta\n-epsilon\n+epsilon\n zeta', 'src/multi.ts'),
  ]
  assert.equal(twoHunks.length, 2)

  // Unified shows the removal and the addition as two rows; split pairs them, so
  // each hunk is one header followed by three rows rather than four.
  for (const [name, rows, width] of [
    ['unified', reviewUnifiedRows(twoHunks, { hideWhitespace: false }), 4],
    ['split', reviewSplitRows(twoHunks, { hideWhitespace: false }), 3],
  ] as const) {
    const shape = rows.map((row) => (row.kind === 'hunk' ? `hunk:${row.header}` : 'line'))
    assert.deepEqual(
      shape,
      [
        'hunk:@@ -1,3 +1,3 @@',
        ...Array.from({ length: width }, () => 'line'),
        'hunk:@@ -40,3 +40,3 @@',
        ...Array.from({ length: width }, () => 'line'),
      ],
      `${name}: each header must sit directly in front of its own hunk`,
    )
    // Every line after a header belongs to that hunk, in both layouts.
    for (const [index, row] of rows.entries()) {
      if (row.kind !== 'hunk') continue
      const following = rows.slice(index + 1).findIndex((next) => next.kind === 'hunk')
      const owned = rows.slice(index + 1, following === -1 ? rows.length : index + 1 + following)
      assert.ok(owned.length > 0, `${name}: hunk header at ${index} introduces no lines`)
      assert.ok(
        owned.every((line) => line.hunkId === row.hunkId),
        `${name}: a line after the header belongs to another hunk`,
      )
    }
  }
})

function rateLimit() {
  return {
    limit: 5000,
    remaining: 4999,
    reset: new Date(0),
    resource: 'core',
    retryAfterSeconds: null,
  }
}

/** Which documented operation a GraphQL document is, by the field it selects. */

interface Write {
  operation: string
  path: string
  body: unknown
  threadId: string | null
  text: string
}

/**
 * The inline comments of a recorded create-review request, read by narrowing the
 * body the double kept rather than by asserting a shape onto it.
 */
function reviewComments(write: Write): Array<Record<string, unknown>> {
  const body = write.body
  if (typeof body !== 'object' || body === null || !('comments' in body)) return []
  const comments: unknown = body.comments
  if (!Array.isArray(comments)) return []
  return comments.filter(
    (comment): comment is Record<string, unknown> =>
      typeof comment === 'object' && comment !== null,
  )
}

/**
 * The selection set a GraphQL document starts at or after `from`, with its
 * braces balanced. Enough to ask which fields a selection names without a
 * GraphQL parser, and enough to notice a field selected one level too deep.
 */
function braceBlock(document: string, from: number): string {
  const start = document.indexOf('{', from)
  if (start === -1) return ''
  let depth = 0
  for (let index = start; index < document.length; index += 1) {
    if (document[index] === '{') depth += 1
    else if (document[index] === '}') {
      depth -= 1
      if (depth === 0) return document.slice(start + 1, index)
    }
  }
  return ''
}

interface DoubleOptions {
  head?: string
  base?: string
  baseRef?: string
  files?: Array<Record<string, unknown>>
  threads?: unknown[]
  permission?: string
  isAuthor?: boolean
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  /** The signed-in account, so a test can act as somebody other than the default. */
  viewer?: string
  /** Fails the named GraphQL operation with this status instead of answering. */
  fail?: Record<string, { status: number; message: string }>
  /**
   * Fails the first create-review request the way a dropped connection does:
   * GitHub may already have applied it, and the transport cannot say.
   */
  failReviewOnce?: { status: number; message: string }
  /**
   * The pages after the first of a thread's own comment connection, keyed by
   * the thread and then by the cursor that asks for them.
   */
  commentPages?: Record<string, Array<{ after: string; nodes: ThreadComment[] }>>
}

function graphOperation(query: string): string {
  // A thread's own comments are a connection inside the thread, read through
  // an inline fragment on the node rather than through a named field.
  if (query.includes('on PullRequestReviewThread')) return 'threadComments'
  for (const name of [
    'addPullRequestReviewThreadReply',
    'unresolveReviewThread',
    'resolveReviewThread',
    'reviewThreads',
  ]) {
    if (query.includes(name)) return name
  }
  return 'permissions'
}

function threadDouble(options: DoubleOptions = {}): {
  transport: GitHubTransport
  writes: Write[]
  /** Every GraphQL document the code under test sent, in order. */
  queries: string[]
} {
  const writes: Write[] = []
  const queries: string[] = []
  const head = options.head ?? 'a'.repeat(40)
  const base = options.base ?? 'b'.repeat(40)
  const permission = options.permission ?? 'WRITE'
  const isAuthor = options.isAuthor === true
  const state = options.state ?? 'OPEN'
  const viewer = options.viewer ?? 'ada'
  const threads = options.threads ?? []
  // The comparison identity, in the shape the pull request resource returns:
  // a base branch has both an object and a name, and the name is part of it.
  const identity = { head: { sha: head }, base: { sha: base, ref: options.baseRef ?? 'main' } }
  // The comment pages of every thread, so a thread's own connection can be read
  // again with its own cursor. The first page is the one the outer list already
  // carries, and the later ones are what a long conversation has past it.
  const commentPages = new Map<
    string,
    Array<{ after: string | null; total: number; nodes: Array<Record<string, unknown>> }>
  >()
  for (const node of threads as Array<Record<string, unknown>>) {
    const id = node.id
    const connection = node.comments
    if (typeof id !== 'string' || typeof connection !== 'object' || connection === null) continue
    const page = connection as { totalCount?: unknown; nodes?: unknown }
    if (!Array.isArray(page.nodes)) continue
    commentPages.set(id, [
      {
        after: null,
        total: typeof page.totalCount === 'number' ? page.totalCount : page.nodes.length,
        nodes: page.nodes.map((comment) => commentNode(comment as ThreadComment)),
      },
      ...(options.commentPages?.[id] ?? []).map((later) => ({
        after: later.after,
        total: 0,
        nodes: later.nodes.map((comment) => commentNode(comment)),
      })),
    ])
  }
  let reviewFailed = false
  return {
    writes,
    queries,
    transport: {
      kind: 'direct',
      async rest<T>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
        const path = request.path ?? ''
        if (request.method && request.method !== 'GET') {
          writes.push({
            operation: `${request.method} ${path}`,
            path,
            body: request.body,
            threadId: null,
            text: '',
          })
          if (options.failReviewOnce && !reviewFailed) {
            reviewFailed = true
            throw new GitHubTransportError({
              kind: statusKind(
                options.failReviewOnce.status,
                rateLimit(),
                options.failReviewOnce.message,
              ),
              detail: `GitHub answered ${options.failReviewOnce.status} ${options.failReviewOnce.message}`,
            })
          }
          return {
            status: 201,
            rateLimit: rateLimit(),
            data: {
              id: 4242,
              state: 'COMMENTED',
              html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-4242',
            },
          } as GitHubRestResponse<T>
        }
        if (path.includes('/files')) {
          return { status: 200, rateLimit: rateLimit(), data: options.files ?? [] } as GitHubRestResponse<T>
        }
        if (path.endsWith('/pulls/7')) {
          return { status: 200, rateLimit: rateLimit(), data: identity } as GitHubRestResponse<T>
        }
        return { status: 404, rateLimit: rateLimit(), data: { message: 'Not Found' } } as GitHubRestResponse<T>
      },
      async paginate<T>(request: GitHubRestRequest): Promise<T[]> {
        return ((request.path ?? '').includes('/files') ? (options.files ?? []) : []) as T[]
      },
      async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const operation = graphOperation(query)
        queries.push(query)
        const failure = options.fail?.[operation]
        if (failure) {
          // A failed mutation is still an attempt, and counting it is how a test
          // proves nothing was sent twice.
          writes.push({
            operation,
            path: 'graphql',
            body: variables,
            threadId: typeof variables.threadId === 'string' ? variables.threadId : null,
            text: '',
          })
          const error = new Error(failure.message) as Error & { status?: number }
          error.status = failure.status
          throw error
        }
        if (operation === 'addPullRequestReviewThreadReply') {
          writes.push({
            operation,
            path: 'graphql',
            body: variables,
            threadId: typeof variables.threadId === 'string' ? variables.threadId : null,
            text: '',
          })
          return {
            addPullRequestReviewThreadReply: { comment: { id: 'IC_1', url: 'https://github.com/c/1' } },
          } as T
        }
        if (operation === 'resolveReviewThread' || operation === 'unresolveReviewThread') {
          const threadId = typeof variables.threadId === 'string' ? variables.threadId : null
          writes.push({
            operation,
            path: 'graphql',
            body: variables,
            threadId,
            text: '',
          })
          return {
            [operation]: { thread: { id: threadId, isResolved: operation === 'resolveReviewThread' } },
          } as T
        }
        if (operation === 'threadComments') {
          // The connection inside the thread, paged by its own cursor: either the
          // page the outer list carried or the one this cursor asks for. GitHub's
          // own count is the first page's, because that is where it was sent.
          const threadId = typeof variables.threadId === 'string' ? variables.threadId : ''
          const after = typeof variables.after === 'string' ? variables.after : null
          const pages = commentPages.get(threadId) ?? []
          const page = pages.find((entry) => entry.after === after)
          return {
            node: {
              comments: {
                totalCount: pages[0]?.total ?? 0,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: page?.nodes ?? [],
              },
            },
          } as T
        }
        if (operation === 'reviewThreads') {
          return {
            repository: {
              viewerPermission: permission,
              pullRequest: {
                state,
                viewerDidAuthor: isAuthor,
                viewerCanUpdate: true,
                reviewThreads: {
                  totalCount: threads.length,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: threads,
                },
              },
            },
          } as T
        }
        // The signed-in account is a field of the query root in GitHub's schema,
        // so the double answers it there and nowhere else.
        return {
          viewer: { login: viewer },
          repository: {
            viewerPermission: permission,
            pullRequest: { state, viewerDidAuthor: isAuthor, viewerCanUpdate: true },
          },
        } as T
      },
    },
  }
}

/** One comment of a thread, as a test writes it. */
interface ThreadComment {
  id: string
  author: string
  body: string
  viewerAuthor?: boolean
}

/** The cursor a thread's own comment connection ends on after `pages` of them. */
function commentCursor(threadId: string, pages: number): string {
  return `${threadId}:comments:${pages}`
}

function commentNode(comment: ThreadComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    author: { login: comment.author },
    viewerDidAuthor: comment.viewerAuthor === true,
    createdAt: '2026-09-23T10:00:00Z',
    url: `https://github.com/acme/widgets/pull/7#discussion_${comment.id}`,
  }
}

/** One thread in the shape the GraphQL `reviewThreads` connection returns. */
function threadNode(options: {
  id: string
  line: number
  startLine?: number | null
  side?: 'RIGHT' | 'LEFT'
  startSide?: 'RIGHT' | 'LEFT' | null
  path?: string
  resolved?: boolean
  outdated?: boolean
  comments?: ThreadComment[]
  /**
   * GitHub's own count for the thread's comments. A count above the nodes the
   * first page carries is what tells a reader the conversation continues.
   */
  commentTotal?: number
}): Record<string, unknown> {
  const comments = options.comments ?? [
    { id: `${options.id}-c1`, author: 'ada', body: 'needs a name' },
  ]
  const total = options.commentTotal ?? comments.length
  const continues = total > comments.length
  return {
    id: options.id,
    isResolved: options.resolved === true,
    isOutdated: options.outdated === true,
    path: options.path ?? 'src/app.ts',
    line: options.line,
    startLine: options.startLine ?? null,
    startDiffSide: options.startSide ?? null,
    diffSide: options.side ?? 'RIGHT',
    // The comments of a thread are a connection, not a bare array, and the
    // thread carries it inside the outer connection the same way.
    comments: {
      totalCount: total,
      pageInfo: {
        hasNextPage: continues,
        endCursor: continues ? commentCursor(options.id, 1) : null,
      },
      nodes: comments.map((comment) => commentNode(comment)),
    },
  }
}

function draft(
  overrides: Partial<ReviewDraft> & { id: string; ref: ReviewLineRef; body: string },
): ReviewDraft {
  return { startRef: null, createdAt: '2026-09-23T10:00:00Z', ...overrides }
}

test('several pending comments are written as one review, not one request each', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const entry = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,4 @@\n keep\n+added\n+more\n tail') },
  })
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch: '@@ -1,2 +1,4 @@\n keep\n+added\n+more\n tail' })],
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.filter((line) => line.side === 'head' && line.newLine !== null)

  await submitReview(workspace.repo, 7, {
    event: 'COMMENT',
    body: '',
    // The comparison the diff on screen was read at, which is the one the
    // review must be pinned to.
    comparison: comparison(),
    drafts: [
      draft({ id: 'd1', ref: refFor(hunk, hunk.lines.indexOf(added[0])), body: 'this needs a name' }),
      draft({ id: 'd2', ref: refFor(hunk, hunk.lines.indexOf(added[1])), body: 'so does this' }),
    ],
  })

  const reviews = writes.filter((write) => write.path.endsWith('/pulls/7/reviews'))
  assert.equal(reviews.length, 1, 'expected exactly one create-review request')
  const body = reviews[0].body as { event: string; comments: unknown[]; commit_id: string }
  assert.equal(body.event, 'COMMENT')
  assert.equal(body.comments.length, 2, 'expected both comments inside the one review')
  assert.equal(body.commit_id, 'a'.repeat(40), 'the review names the head it was written against')
})

test('a multi-line draft sends start_line and start_side with the last line as line/side', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,5 @@\n keep\n+one\n+two\n+three\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const { transport, writes } = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.filter((line) => line.side === 'head' && line.newLine !== null)
  const first = refFor(hunk, hunk.lines.indexOf(added[0]))
  const last = refFor(hunk, hunk.lines.indexOf(added[2]))

  await submitReview(workspace.repo, 7, {
    event: 'COMMENT',
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: last, startRef: first, body: 'these belong together' })],
  })

  const review = writes.find((write) => write.path.endsWith('/pulls/7/reviews'))
  const comment = (review?.body as { comments: Array<Record<string, unknown>> }).comments[0]
  // GitHub addresses the last line of a range as `line`/`side` and its first as
  // `start_line`/`start_side`; getting this backwards is a silent misanchor.
  assert.equal(comment.line, last.line)
  assert.equal(comment.side, 'RIGHT')
  assert.equal(comment.start_line, first.line)
  assert.equal(comment.start_side, 'RIGHT')
})

test('a comment on a removed line is sent on the left, where the line it names is', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -5,3 +5,3 @@\n keep\n-warn\n+other\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const { transport, writes } = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))
  const hunk = textHunk(entry, 0)
  const removed = refFor(hunk, hunk.lines.findIndex((line) => line.side === 'base'))

  await submitReview(workspace.repo, 7, {
    event: 'COMMENT',
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: removed, body: 'why warn here' })],
  })

  const review = writes.find((write) => write.path.endsWith('/pulls/7/reviews'))
  const comment = (review?.body as { comments: Array<Record<string, unknown>> }).comments[0]
  assert.equal(comment.side, 'LEFT', "a base-side line is GitHub's LEFT")
  assert.equal(comment.start_line, undefined, 'a single line carries no start')
})

test('a draft whose line a force-push removed submits nothing at all', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const written = file({
    diff: { kind: 'text', hunks: hunks('@@ -5,3 +5,3 @@\n keep\n-warn\n+other\n tail') },
  })
  const hunk = textHunk(written, 0)
  const removed = refFor(hunk, hunk.lines.findIndex((line) => line.side === 'base'))
  // The same comment still resolves against the head it was written for.
  assert.equal(
    resolveReviewDrafts(fileSet(written), [draft({ id: 'd1', ref: removed, body: 'why' })])[0].match,
    'exact',
  )
  // A force-push rewrote the line, so there is nothing left to anchor to.
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch: '@@ -5,3 +5,3 @@\n keep\n-gone\n+other\n rewritten' })],
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const error = await submitReview(workspace.repo, 7, {
    event: 'APPROVE',
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: removed, body: 'why warn here' })],
  }).then(
    () => null,
    (cause: unknown) => cause,
  )

  assert.ok(error instanceof ReviewAnchorStaleError, 'a stale draft refuses the whole review')
  // The refusal is reportable, not just a thrown string: the view has to say
  // which draft and which line could not be resolved.
  const stale = (error as ReviewAnchorStaleError).resolutions
  assert.equal(stale.length, 1)
  assert.equal(stale[0].id, 'd1')
  assert.equal(stale[0].match, 'unresolved')
  assert.equal(stale[0].side, null, 'an unresolved draft names no side to post it on')
  assert.equal(stale[0].line, null)
  assert.equal(
    writes.filter((write) => write.path.endsWith('/pulls/7/reviews')).length,
    0,
    'a stale draft must not be posted on a revision or line it was not written for',
  )
})

test('a draft whose line merely moved is posted at the line it now occupies', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const written = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail') },
  })
  const hunk = textHunk(written, 0)
  const original = refFor(hunk, hunk.lines.findIndex((line) => line.side === 'head'))
  // A line inserted above shifts the commented line down by one without
  // changing it, which is the case re-anchoring exists for.
  const shiftedPatch = '@@ -1,3 +1,4 @@\n+inserted\n keep\n-old\n+new\n tail'
  const resolutions = resolveReviewDrafts(fileSet(file({ diff: { kind: 'text', hunks: hunks(shiftedPatch) } })), [
    draft({ id: 'd1', ref: original, body: 'why warn here' }),
  ])
  assert.equal(resolutions[0].match, 'moved')
  assert.notEqual(resolutions[0].line, original.line, 'the fixture must actually move the line')

  const { transport, writes } = threadDouble({ files: [apiFile({ patch: shiftedPatch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await submitReview(workspace.repo, 7, {
    event: 'COMMENT',
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: original, body: 'why warn here' })],
  })

  const review = writes.find((write) => write.path.endsWith('/pulls/7/reviews'))
  const comment = (review?.body as { comments: Array<Record<string, unknown>> }).comments[0]
  assert.equal(comment.line, resolutions[0].line, 'posted at the line it now occupies')
})

test('a range whose ends land on different sides is refused, and nothing is posted', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -5,3 +5,3 @@\n keep\n-warn\n+other\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const baseLine = refFor(hunk, hunk.lines.findIndex((line) => line.side === 'base'))
  const headLine = refFor(hunk, hunk.lines.findIndex((line) => line.side === 'head'))
  const { transport, writes } = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  // GitHub addresses a range's two ends with separate side fields, so no single
  // pair of line/side values can express a range that crosses sides.
  assert.equal(
    resolveReviewDrafts(fileSet(entry), [
      draft({ id: 'd1', ref: headLine, startRef: baseLine, body: 'this pair' }),
    ])[0].match,
    'unresolved',
  )

  const error = await submitReview(workspace.repo, 7, {
    event: 'COMMENT',
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: headLine, startRef: baseLine, body: 'this pair' })],
  }).then(
    () => null,
    (cause: unknown) => cause,
  )

  assert.ok(error instanceof ReviewAnchorStaleError)
  assert.equal(
    writes.filter((write) => write.path.endsWith('/pulls/7/reviews')).length,
    0,
    'a range GitHub cannot address is not posted on whichever end resolves',
  )
})

test('a review is refused outright when the head moved after the reviewer read the diff', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  // The comment still resolves against the head the transport reports, so
  // revalidating anchors alone would post it onto a revision nobody opened.
  assert.equal(
    resolveReviewDrafts(fileSet(entry), [
      draft({ id: 'd1', ref: refFor(hunk, added), body: 'needs a name' }),
    ])[0].match,
    'exact',
  )
  const { transport, writes } = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const error = await submitReview(workspace.repo, 7, {
    event: 'APPROVE',
    body: '',
    // The head the reviewer was shown, which the force-push has replaced.
    comparison: comparison({ headOid: 'c'.repeat(40) }),
    drafts: [draft({ id: 'd1', ref: refFor(hunk, added), body: 'needs a name' })],
  }).then(
    () => null,
    (cause: unknown) => cause,
  )

  assert.ok(error instanceof ReviewComparisonMovedError, 'a moved comparison refuses the review')
  assert.equal(
    writes.filter((write) => write.path.endsWith('/pulls/7/reviews')).length,
    0,
    'nothing is approved against a revision the reviewer never opened',
  )
  // Both revisions travel with the refusal, so the view can name what to reload.
  const moved = error as ReviewComparisonMovedError
  assert.equal(moved.reviewed.headOid, 'c'.repeat(40))
  assert.equal(moved.current.headOid, 'a'.repeat(40))
})

test('a base branch that moved under an unchanged head is the same refusal', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const { transport, writes } = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  // The head is the one the reviewer read, word for word. GitHub diffs against
  // the merge base of head and base, so a push to the base branch renumbers
  // every line of the same diff, and an APPROVE here would sign off a
  // revision that is not the one on screen.
  const error = await submitReview(workspace.repo, 7, {
    event: 'APPROVE',
    body: '',
    comparison: comparison({ baseOid: 'd'.repeat(40) }),
    drafts: [draft({ id: 'd1', ref: refFor(hunk, added), body: 'needs a name' })],
  }).then(
    () => null,
    (cause: unknown) => cause,
  )

  assert.ok(error instanceof ReviewComparisonMovedError)
  assert.equal(
    writes.filter((write) => write.path.endsWith('/pulls/7/reviews')).length,
    0,
    'a fixed head does not make a moved base safe to approve',
  )
  assert.equal((error as ReviewComparisonMovedError).current.baseOid, 'b'.repeat(40))
})

test('a thread read returns the line, the range, and whether it is resolved or outdated', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport } = threadDouble({
    threads: [
      threadNode({ id: 'PRRT_1', line: 12, comments: [] }),
      threadNode({ id: 'PRRT_2', line: 30, startLine: 28, startSide: 'RIGHT', resolved: true, comments: [] }),
      threadNode({ id: 'PRRT_3', line: 44, outdated: true, comments: [] }),
      threadNode({ id: 'PRRT_4', line: 51, side: 'LEFT', comments: [] }),
    ],
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const read = await readReviewThreads(workspace.repo, 7)
  const threads = read.threads.threads

  assert.equal(threads.length, 4)
  assert.equal(threads[0].line, 12)
  assert.equal(threads[0].startLine, null, 'a single-line thread carries no range')
  assert.equal(threads[0].resolved, false)
  assert.equal(threads[0].outdated, false)
  assert.equal(threads[1].startLine, 28, 'a multi-line thread keeps its first line')
  assert.equal(threads[1].resolved, true)
  assert.equal(threads[2].outdated, true, 'a thread the diff moved past is shown as outdated')
  assert.equal(threads[3].side, 'base', "GitHub's LEFT is the base side")
  assert.deepEqual(
    read.threads.comparison,
    comparison(),
    'the read names the whole comparison it describes',
  )
  assert.equal(read.threads.truncated, false)
})

test("a thread's comments keep the author and which of them is the viewer's own", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport } = threadDouble({
    threads: [
      threadNode({
        id: 'PRRT_1',
        line: 12,
        comments: [
          { id: 'c1', author: 'ada', body: 'first' },
          { id: 'c2', author: 'grace', body: 'second', viewerAuthor: true },
        ],
      }),
    ],
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const read = await readReviewThreads(workspace.repo, 7)
  const comments = read.threads.threads[0].comments

  assert.equal(comments.length, 2)
  assert.equal(comments[0].author, 'ada')
  assert.equal(comments[0].viewerDidAuthor, false)
  assert.equal(comments[1].viewerDidAuthor, true)
})

test("a thread's later comment pages are read, and a short one is marked short", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport } = threadDouble({
    threads: [
      threadNode({
        id: 'PRRT_1',
        line: 12,
        comments: [{ id: 'c1', author: 'ada', body: 'needs a name' }],
        commentTotal: 3,
      }),
      threadNode({
        id: 'PRRT_2',
        line: 20,
        comments: [{ id: 'c1', author: 'ada', body: 'still going' }],
        commentTotal: 5,
      }),
    ],
    commentPages: {
      PRRT_1: [
        {
          after: commentCursor('PRRT_1', 1),
          nodes: [
            { id: 'c2', author: 'grace', body: 'renamed' },
            { id: 'c3', author: 'ada', body: 'thank you' },
          ],
        },
      ],
      PRRT_2: [
        { after: commentCursor('PRRT_2', 1), nodes: [{ id: 'c2', author: 'grace', body: 'one more' }] },
      ],
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const read = await readReviewThreads(workspace.repo, 7)
  const [whole, short] = read.threads.threads

  // A thread's comments are a connection inside the thread, so paging the outer
  // list alone ends the conversation at the first reply and hides the rest.
  assert.deepEqual(
    whole.comments.map((comment) => comment.body),
    ['needs a name', 'renamed', 'thank you'],
    'the replies past the first page belong to the thread',
  )
  assert.equal(whole.commentCount, 3, "GitHub's own count is what the thread reports")
  assert.equal(whole.commentsTruncated, false, 'the whole conversation was read')
  // Fewer comments than GitHub counts is a partial history, and it is marked as
  // one rather than drawn as the whole reply record.
  assert.equal(short.commentCount, 5)
  assert.equal(short.commentsTruncated, true)
})

test('a reader without write permission is told it cannot post, before any write is attempted', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport, writes } = threadDouble({ permission: 'NONE' })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const read = await readReviewThreads(workspace.repo, 7)

  assert.equal(read.permissions.permission, 'NONE')
  assert.ok(read.permissions.blocked.APPROVE, 'an account with no access may not review')
  assert.ok(read.permissions.blocked.COMMENT)
  assert.equal(writes.length, 0, 'a read never mutates')
})

test('the signed-in account is read from the query root, which is where GitHub has it', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport } = threadDouble()
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const permissions = await readReviewPermissions(workspace.repo, 7)

  // The double answers `viewer` at the root and nowhere else, so a reader that
  // asked for it inside `repository` would come back with no account at all.
  assert.equal(permissions.viewer, 'ada')
  assert.equal(permissions.permission, 'WRITE')
})

test('the permissions query cannot be asking for a viewer the repository does not have', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport, queries } = threadDouble()
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await readReviewPermissions(workspace.repo, 7)

  const document = queries.find((query) => query.includes('ReviewPermissions'))
  assert.ok(document, 'the preflight must have asked GitHub what this account may do')
  // GitHub's schema has no Repository.viewer, and a document asking for one
  // fails whole with undefinedField before any review is written, so the place
  // the field is selected is itself the contract.
  assert.match(
    braceBlock(document, 0),
    /\bviewer\s*\{\s*login\s*\}/,
    'the viewer is selected at the root of the document',
  )
  assert.doesNotMatch(
    braceBlock(document, document.indexOf('repository(')),
    /\bviewer\b/,
    'the repository selection must not name a viewer',
  )
})

test('a write whose outcome GitHub never confirms is not replayed into a duplicate', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const attempts: string[] = []
  setGitHubTransport({
    kind: 'direct',
    async rest<T>(request: GitHubRestRequest): Promise<GitHubRestResponse<T>> {
      const path = request.path ?? ''
      if (request.method && request.method !== 'GET') {
        attempts.push(path)
        // The real transport turns a non-2xx into a thrown GitHubTransportError,
        // so the double must as well; a 502 is a status it cannot classify, which
        // is exactly the case where the request may still have been applied.
        throw new GitHubTransportError({
          kind: statusKind(502, rateLimit(), 'Bad Gateway'),
          detail: 'GitHub answered 502 Bad Gateway',
        })
      }
      if (path.endsWith('/files')) {
        return { status: 200, rateLimit: rateLimit(), data: [apiFile({ patch })] } as GitHubRestResponse<T>
      }
      return {
        status: 200,
        rateLimit: rateLimit(),
        // The comparison the reviewer read, with all three parts, so this
        // submission is pinned to something the transport still reports.
        data: { head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), ref: 'main' } },
      } as GitHubRestResponse<T>
    },
    async paginate<T>(request: GitHubRestRequest): Promise<T[]> {
      return ((request.path ?? '').includes('/files') ? [apiFile({ patch })] : []) as T[]
    },
    async graphql<T>(): Promise<T> {
      return {
        viewer: { login: 'ada' },
        repository: {
          viewerPermission: 'WRITE',
          pullRequest: { state: 'OPEN', viewerDidAuthor: false, viewerCanUpdate: true },
        },
      } as T
    },
  })
  t.after(() => setGitHubTransport(null))

  const error = await submitReview(workspace.repo, 7, {
    event: 'COMMENT',
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: refFor(hunk, added), body: 'needs a name' })],
  }).then(
    () => null,
    (cause: unknown) => cause,
  )

  // The error kind is the contract: it tells the caller the request may have
  // been applied, which is what forbids a blind retry.
  assert.ok(
    error instanceof ReviewOutcomeUnknownError,
    'a 502 is an unknown outcome, not a clean rejection',
  )
  assert.equal(attempts.length, 1, 'an unconfirmed write is reported, never silently resent')
})

test('a review GitHub never confirmed is refused the second time, from the record on disk', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: refFor(hunk, added), body: 'needs a name' })],
  }

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  // A second call with nothing in memory but the submission, as if the
  // workspace had been reopened. The message from the first call is gone by
  // then, so only the journalled attempt can stop this.
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1, 'the review was attempted once and never again')
})

test('the uncertain-write guard covers that review only, so changed words still go out', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))
  const at = refFor(hunk, added)

  await assert.rejects(
    () =>
      submitReview(workspace.repo, 7, {
        event: 'COMMENT',
        body: '',
        comparison: comparison(),
        drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
      }),
    { name: 'ReviewOutcomeUnknownError' },
  )
  // The reviewer has plainly abandoned those words, so a guard that refused
  // every review of the pull request would leave them unable to review at all.
  const result = await submitReview(workspace.repo, 7, {
    event: 'COMMENT',
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'renamed the function' })],
  })

  assert.equal(result.state, 'COMMENTED')
  assert.equal(writes.length, 2, 'a different review is a different write, so it is sent')
  assert.equal(reviewComments(writes[1])[0].body, 'renamed the function')
})

test("another account's unresolved write does not hold this one's button shut", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const body = 'the same words either account might write'
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body })],
  }

  // One account sends and never hears back. The record holds the words, and the
  // journal is shared by every worktree of the repository, so the guard has to
  // name the account or the next person to sign in is locked out of a review
  // they never attempted.
  const first = threadDouble({
    files: [apiFile({ patch })],
    viewer: 'ada',
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(first.transport)
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  // The very same call is still refused for the account that made it.
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewWriteUncertainError',
  })

  // A different account on the same repository is not blocked by it.
  const second = threadDouble({ files: [apiFile({ patch })], viewer: 'grace' })
  setGitHubTransport(second.transport)
  t.after(() => setGitHubTransport(null))
  const result = await submitReview(workspace.repo, 7, submission)

  assert.equal(result.state, 'COMMENTED')
  assert.equal(second.writes.length, 1, "another account's review is its own write")
  assert.equal(reviewComments(second.writes[0])[0].body, body)
})

test('a reply is posted through the documented mutation, naming its thread and body', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport, writes } = threadDouble({
    threads: [threadNode({ id: 'PRRT_1', line: 12 })],
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const result = await replyToThread(workspace.repo, 7, 'PRRT_1', 'agreed, renaming')

  assert.equal(writes.length, 1)
  assert.equal(writes[0].operation, 'addPullRequestReviewThreadReply')
  assert.equal(writes[0].threadId, 'PRRT_1')
  assert.equal((writes[0].body as { body: string }).body, 'agreed, renaming')
  assert.equal(result.id, 'IC_1', 'the outcome is reported from what GitHub returned')
})

test('a reply GitHub never confirmed is not sent again to the same thread', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport, writes } = threadDouble({
    threads: [threadNode({ id: 'PRRT_1', line: 12 })],
    fail: { addPullRequestReviewThreadReply: { status: 502, message: 'Bad Gateway' } },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => replyToThread(workspace.repo, 7, 'PRRT_1', 'agreed, renaming'), {
    name: 'ReviewOutcomeUnknownError',
  })
  // The thread is read back to find out whether the reply landed; it did not, so
  // the attempt is journalled and the same words to the same thread are refused.
  await assert.rejects(() => replyToThread(workspace.repo, 7, 'PRRT_1', 'agreed, renaming'), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1, 'the reply was attempted once and never again')
})

test('resolve and unresolve are opposite mutations on the same thread', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport, writes } = threadDouble({ threads: [threadNode({ id: 'PRRT_1', line: 12 })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const resolved = await setThreadResolved(workspace.repo, 'PRRT_1', true)
  const reopened = await setThreadResolved(workspace.repo, 'PRRT_1', false)

  assert.deepEqual(
    writes.map((write) => write.operation),
    // Reopening must use the unresolve mutation, not resolve with false.
    ['resolveReviewThread', 'unresolveReviewThread'],
  )
  assert.deepEqual(
    writes.map((write) => write.threadId),
    ['PRRT_1', 'PRRT_1'],
  )
  assert.equal(resolved.state, 'resolved')
  assert.equal(reopened.state, 'unresolved')
})

test('a resolve GitHub accepts but cannot confirm is reported unknown, not re-sent', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const { transport, writes } = threadDouble({
    threads: [threadNode({ id: 'PRRT_1', line: 12 })],
    fail: { resolveReviewThread: { status: 502, message: 'Bad Gateway' } },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => setThreadResolved(workspace.repo, 'PRRT_1', true), {
    name: 'ReviewOutcomeUnknownError',
  })
  assert.equal(writes.length, 1, 'the resolution is not sent again after an unknown outcome')
})

test('pending comments survive leaving the workspace and are bound to the head they name', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const entry = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') },
  })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const record: ReviewDraftRecord = {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: refFor(hunk, added), body: 'still thinking about this' })],
    updatedAt: '2026-09-23T10:00:00Z',
  }

  await writeReviewDrafts(workspace.repo, record)
  // A second read stands in for leaving for another workspace and coming back.
  const reopened = await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7)

  assert.ok(reopened, 'the drafts must be found again')
  assert.equal(reopened.number, 7)
  assert.deepEqual(
    reopened.comparison,
    comparison(),
    'a draft is bound to the whole comparison its lines were read at',
  )
  assert.equal(reopened.drafts.length, 1)
  assert.equal(reopened.drafts[0].body, 'still thinking about this')
  assert.equal(reopened.drafts[0].ref.line, record.drafts[0].ref.line)
})

test("one pull request's drafts are not another's", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const entry = file({ diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const line = refFor(hunk, added)

  await writeReviewDrafts(workspace.repo, {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: line, body: 'on seven' })],
    updatedAt: '2026-09-23T10:00:00Z',
  })
  await writeReviewDrafts(workspace.repo, {
    number: 8,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: line, body: 'on eight' })],
    updatedAt: '2026-09-23T10:00:00Z',
  })

  assert.equal(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7))?.drafts[0].body,
    'on seven',
  )
  assert.equal(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 8))?.drafts[0].body,
    'on eight',
  )
  assert.equal(
    await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 9),
    null,
  )
})

test('drafts are kept apart by repository and by account, not by pull request number', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const entry = file({ diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const line = refFor(hunk, added)

  await writeReviewDrafts(workspace.repo, {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: line, body: 'mine' })],
    updatedAt: '2026-09-23T10:00:00Z',
  })

  // One journal file is shared by every worktree of the repository, so a record
  // belonging to another repository or another account is on disk and is
  // deliberately not returned: a number alone collides across repositories,
  // and unsent words belong to whoever wrote them.
  assert.equal(
    await readReviewDrafts(workspace.repo, 'acme/sprockets', JOURNAL_OWNER.viewer, 7),
    null,
    'a pull request number is unique only inside one repository',
  )
  assert.equal(
    await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, 'grace', 7),
    null,
    'another account must not be offered this reviewer pending words',
  )
  assert.equal(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7))?.drafts[0].body,
    'mine',
    'the account that wrote them still finds them',
  )
})

test('writing an empty list is what retires a sent review, so it is not offered again', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const entry = file({ diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  await writeReviewDrafts(workspace.repo, {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: refFor(hunk, added), body: 'sent' })],
    updatedAt: '2026-09-23T10:00:00Z',
  })
  assert.ok(
    await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7),
    'precondition: the draft is pending',
  )

  await writeReviewDrafts(workspace.repo, {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [],
    updatedAt: '2026-09-23T10:05:00Z',
  })

  assert.equal(
    await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7),
    null,
    'a sent review leaves nothing behind to submit twice',
  )
})

test('a draft is not offered again once the base branch moves under a fixed head', () => {
  const entry = file({ diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const written = comparison()
  const record: ReviewDraftRecord = {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: written,
    drafts: [draft({ id: 'd1', ref: refFor(hunk, added), body: 'mine' })],
    updatedAt: '2026-09-23T10:00:00Z',
  }

  // The head did not move at all, so a head-only binding would still offer this.
  assert.deepEqual(reviewDraftsAt(record, 7, written).length, 1)
  // GitHub diffs the head against the merge base of head and base, so a push to
  // the base renumbers every line under an unchanged head. The draft's line
  // numbers now describe a diff nobody read.
  const baseMoved = comparison({ baseOid: 'c'.repeat(40) })
  assert.deepEqual(reviewDraftsAt(record, 7, baseMoved), [])
  // A retarget to another branch at the same oids is also a different thing to
  // review, even though the diff bytes are identical.
  assert.deepEqual(reviewDraftsAt(record, 7, comparison({ baseRef: 'release' })), [])
  // Another pull request is never this one.
  assert.deepEqual(reviewDraftsAt(record, 8, written), [])
})

test('a thread that is both resolved and outdated keeps both facts, because a push can do that', () => {
  // GitHub reports these independently: a thread answered and then moved by a
  // later push is resolved and outdated at once. The one-word state cannot say
  // both, and choosing "resolved" alone would let a reviewer read a thread whose
  // line no longer exists as if it still did.
  const base: ReviewThread = {
    id: 'T_1',
    path: 'src/main/review.ts',
    side: 'head',
    line: 2,
    startLine: null,
    startSide: null,
    fileLevel: false,
    resolved: false,
    collapsed: false,
    outdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
  }
  const both: ReviewThread = { ...base, resolved: true, outdated: true }
  assert.equal(reviewThreadState(both), 'resolved')
  // So the component reads `outdated` off the thread itself rather than off the
  // collapsed state, and the flag survives every path that builds a thread.
  assert.equal(both.outdated, true)
  assert.equal(reviewThreadState({ ...base, resolved: false, outdated: true }), 'outdated')
  assert.equal(reviewThreadState({ ...base, resolved: true, outdated: false }), 'resolved')
  assert.equal(reviewThreadState({ ...base, resolved: false, outdated: false }), 'open')
})
