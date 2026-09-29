/**
 * The review workspace's rules, proven without a window.
 *
 * Everything asserted here is a decision the workspace makes rather than a value
 * it copies: how a remote patch becomes lines with stable identity, what the
 * whitespace filter is allowed to hide, where a stacked pull request sits, what
 * the rail offers at the ends of a stack, and when a viewed mark stops counting.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReviewFileEntry, resolveReviewAnchor } from '../src/main/review'
import {
  adjacentReviewFileIndex,
  adjacentStackLayer,
  isWhitespaceOnlyChange,
  looksGenerated,
  reviewChangeBlocks,
  reviewDiffStateLabel,
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
import type { ReviewFileSet, ReviewLineRef } from '../src/shared/review'

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

function fileSet(entry: ReviewFile): ReviewFileSet {
  return {
    number: 7,
    headOid: 'a'.repeat(40),
    files: [entry],
    additions: entry.additions,
    deletions: entry.deletions,
    truncated: false,
  }
}

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

test('a reference into a file the pull request no longer touches says so', () => {
  const before = hunks('@@ -1,2 +1,2 @@\n a\n-b\n+B')[0]
  const resolution = resolveReviewAnchor(
    {
      number: 7,
      headOid: null,
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

test('a file with no text says which of the four states it is in', () => {
  assert.match(reviewDiffStateLabel(file()), /^Text diff/)
  assert.match(
    reviewDiffStateLabel(file({ diff: { kind: 'binary' } })),
    /Binary file.*changed bytes/u,
  )
  assert.match(reviewDiffStateLabel(file({ diff: { kind: 'too-large' } })), /too large/u)
  assert.equal(
    reviewDiffStateLabel(file({ diff: { kind: 'unreadable', reason: 'patch missing' } })),
    'patch missing',
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

test('a viewed mark belongs to one head and is dropped when the head moves', () => {
  const headA = 'a'.repeat(40)
  const headB = 'b'.repeat(40)
  let record = withViewedFile(null, 7, headA, 'src/a.ts', '2026-01-01T00:00:00.000Z')
  record = withViewedFile(record, 7, headA, 'src/b.ts', '2026-01-01T00:00:01.000Z')
  assert.deepEqual(record.paths, ['src/a.ts', 'src/b.ts'])
  assert.equal(record.headOid, headA)

  // New commits change the patch, so a mark made against the old head is no
  // longer a mark on the same content.
  const moved = withViewedFile(record, 7, headB, 'src/c.ts', '2026-01-02T00:00:00.000Z')
  assert.deepEqual(moved.paths, ['src/c.ts'])
  assert.equal(moved.headOid, headB)
  assert.deepEqual(viewedPaths(moved, 7, headB), ['src/c.ts'])
  // A record read against a different head or a different pull request is not
  // evidence about this one.
  assert.deepEqual(viewedPaths(moved, 7, headA), [])
  assert.deepEqual(viewedPaths(moved, 8, headB), [])
})

test('re-marking a file replaces its timestamp instead of duplicating it', () => {
  const head = 'a'.repeat(40)
  let record = withViewedFile(null, 7, head, 'src/a.ts', '2026-01-01T00:00:00.000Z')
  record = withViewedFile(record, 7, head, 'src/a.ts', '2026-01-02T00:00:00.000Z')
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
