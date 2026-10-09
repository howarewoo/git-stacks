/**
 * The review workspace's rules, proven without a window.
 *
 * Everything asserted here is a decision the workspace makes rather than a value
 * it copies: how a remote patch becomes lines with stable identity, what the
 * whitespace filter is allowed to hide, where a stacked pull request sits, what
 * the rail offers at the ends of a stack, and when a viewed mark stops counting.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  GitHubTransportError,
  setGitHubTransport,
  statusKind,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type GitHubTransport,
  type GitHubGraphqlOptions,
} from '../src/main/github-transport'
import { GITHUB_DEFAULT_HOST } from '@git-stacks/shared/host'
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
import {
  readReviewDrafts,
  readUncertainWrites,
  recordUncertainWrite,
  writeReviewDrafts,
  retireSettledWrites,
} from '../src/main/review-drafts'
import {
  newReviewDraftId,
  reviewDraftsAt,
  reviewThreadState,
  type ReviewThread,
  type ReviewDraft,
  type ReviewDraftRecord,
  type ReviewUncertainWrite,
  type UncertainComment,
} from '@git-stacks/shared/review-threads'
import {
  parseReviewFileEntry,
  readReviewCommits,
  readReviewFiles,
  resolveReviewAnchor,
  ReviewRevisionMovedError,
  readReviewHeadline,
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
} from '@git-stacks/shared/review'
import type { PullRequestStackMember } from '@git-stacks/shared/types'
import type { ReviewComparison, ReviewFileSet, ReviewLineRef } from '@git-stacks/shared/review'

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

test('a deleted file is addressed on the base, so a comment on it names the line it removed', () => {
  const body = [
    '@@ -12,5 +0,0 @@',
    '-export const legacyGate = true',
    '-',
    '-export function gate(name: string): string {',
    '-  return `gate:${name}`',
    '-}',
  ]
  const entry = apiFile({
    filename: 'src/legacy/feature-gate.ts',
    status: 'removed',
    additions: 0,
    deletions: 5,
    changes: 5,
    sha: null,
    patch: body.join('\n'),
  })
  const removed = parseReviewFileEntry(entry)
  assert.ok(removed && removed.diff.kind === 'text', 'a removed patch is still reviewable')
  assert.equal(removed.status, 'removed')
  assert.equal(removed.sha, null, 'a removed file has no postimage blob to address')

  const [hunk_] = removed.diff.hunks
  assert.equal(hunk_.oldStart, 12)
  assert.equal(hunk_.newStart, 0)
  assert.equal(hunk_.newLines, 0, 'nothing of a deleted file survives on the head')
  // Every removed line is addressed by the number it had on the base. Nothing in
  // a deleted file has a head-side number at all, so a comment written on it
  // cannot end up attached to a line the pull request never produced.
  assert.deepEqual(
    hunk_.lines.map((line) => [line.side, line.oldLine, line.newLine]),
    [
      ['base', 12, null],
      ['base', 13, null],
      ['base', 14, null],
      ['base', 15, null],
      ['base', 16, null],
    ],
  )
  assert.equal(new Set(hunk_.lines.map((line) => line.anchor)).size, 5)

  // Both layouts put that number where the reviewer reads it: down the single
  // gutter of a unified diff, and on the left of a split one.
  assert.deepEqual(
    reviewUnifiedRows(removed.diff.hunks, { hideWhitespace: false })
      .filter((row) => row.kind === 'line')
      .map((row) => [row.number, row.line.side]),
    [
      [12, 'base'],
      [13, 'base'],
      [14, 'base'],
      [15, 'base'],
      [16, 'base'],
    ],
  )
  assert.deepEqual(
    reviewSplitRows(removed.diff.hunks, { hideWhitespace: false }).map((row) =>
      row.kind === 'split' ? [row.left?.number, row.right] : null,
    ),
    [null, [12, null], [13, null], [14, null], [15, null], [16, null]],
  )

  // It stays a file in the tree, marked as the deletion it is.
  const inTree = reviewFileRows([removed]).flatMap((row) => (row.kind === 'file' ? [row] : []))
  assert.deepEqual(
    inTree.map((row) => [row.path, row.file.status, reviewStatusLetter(row.file.status)]),
    [['src/legacy/feature-gate.ts', 'removed', 'D']],
  )

  // The comment a reviewer leaves on a deleted line still names that line after
  // the rest of the branch moves on: the same deletion, further down the file.
  const ref = refFor(hunk_, 2, { path: 'src/legacy/feature-gate.ts' })
  assert.equal(ref.side, 'base')
  assert.equal(ref.line, 14)
  const shifted = parseReviewFileEntry({
    ...entry,
    patch: ['@@ -40,5 +0,0 @@', ...body.slice(1)].join('\n'),
  })
  assert.ok(shifted && shifted.diff.kind === 'text')
  const resolution = resolveReviewAnchor(fileSet(shifted), ref)
  assert.equal(resolution.match, 'exact')
  assert.equal(resolution.ref?.side, 'base')
  assert.equal(resolution.ref?.line, 42, 'the comment follows the text to its new address')
})

test('a huge diff keeps every line addressable, on the first page and on a revealed one', () => {
  const perHunk = 400
  const patch: string[] = []
  for (let block = 0; block < 3; block += 1) {
    patch.push(`@@ -0,0 +${block * perHunk + 1},${perHunk} @@`)
    for (let line = 0; line < perHunk; line += 1) {
      patch.push(`+generated row ${block * perHunk + line + 1}`)
    }
  }
  const generated = parseReviewFileEntry(
    apiFile({ filename: 'src/generated/manifest.ts', patch: patch.join('\n') }),
  )
  assert.ok(generated && generated.diff.kind === 'text')
  assert.deepEqual(
    generated.diff.hunks.map((hunk_) => [hunk_.newStart, hunk_.newLines]),
    [
      [1, perHunk],
      [401, perHunk],
      [801, perHunk],
    ],
  )

  const rows = reviewUnifiedRows(generated.diff.hunks, { hideWhitespace: false })
  assert.equal(rows.length, 3 + 3 * perHunk, 'a hunk header is a row of its own')
  assert.deepEqual(
    rows.filter((row) => row.kind === 'hunk').map((row) => row.header),
    generated.diff.hunks.map((hunk_) => hunk_.header),
    'each hunk header opens the block it belongs to, in order',
  )
  const lines = rows.filter((row) => row.kind === 'line')
  assert.deepEqual(
    lines.map((row) => row.number),
    Array.from({ length: 3 * perHunk }, (_, index) => index + 1),
    'every generated line carries the head number it lands on, in order',
  )
  assert.equal(
    new Set(lines.map((row) => row.line.anchor)).size,
    3 * perHunk,
    'no two lines of a huge diff answer to the same anchor',
  )

  // A comment written on a line far past the first mounted page still resolves
  // to that line: the anchor belongs to the diff, not to where the row sits.
  const deep = generated.diff.hunks[1]
  const ref = refFor(deep, 49, { path: 'src/generated/manifest.ts' })
  assert.equal(ref.line, 450)
  assert.equal(ref.hunkId, deep.id)
  const resolution = resolveReviewAnchor(fileSet(generated), ref)
  assert.equal(resolution.match, 'exact')
  assert.equal(resolution.ref?.side, 'head')
  assert.equal(resolution.ref?.line, 450)
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
  const reply = <T>(data: T): GitHubRestResponse<T> => ({
    status: 200,
    rateLimit: rateLimit(),
    data,
  })
  return {
    calls,
    transport: {
      kind: 'direct',
      // The workspace origin is github.com and this double is installed as that
      // host's transport, so it answers for the public host.
      destinationHost: GITHUB_DEFAULT_HOST,
      async credentialAuthority(): Promise<string> {
        return 'review-test-credential'
      },
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

/**
 * A workspace whose origin points at the repository the scripted transport
 * answers for. The origin is named because the uncertain-write journal is
 * shared by every repository using one Git common directory, so which
 * repository a record belongs to is part of what it is.
 */
async function reviewWorkspace(
  origin = 'https://github.com/acme/widgets.git',
): Promise<{ repo: string; dispose: () => Promise<void> }> {
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
  git('remote', 'add', 'origin', origin)
  return { repo, dispose: () => rm(root, { recursive: true, force: true }) }
}

test('headline reviewer reads distinguish complete, bounded, refused, and moved-head data', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  t.after(() => setGitHubTransport(null))
  const headOid = 'a'.repeat(40)
  const connection = (nodes: unknown[], hasNextPage = false) => ({
    nodes,
    pageInfo: { hasNextPage },
  })
  const reviewers = {
    headRefOid: headOid,
    reviewRequests: connection([
      { requestedReviewer: { login: 'ada' } },
      { requestedReviewer: { slug: 'maintainers' } },
    ]),
    latestReviews: connection([
      { author: { login: 'grace' }, state: 'APPROVED', commit: { oid: 'b'.repeat(40) } },
    ]),
  }
  for (const scenario of [
    { node: reviewers, expected: 'available' },
    { node: { ...reviewers, reviewRequests: connection([], true) }, expected: 'partial' },
    {
      node: { ...reviewers, latestReviews: connection([{ author: null, state: 'APPROVED' }]) },
      expected: 'partial',
    },
    {
      node: {
        ...reviewers,
        latestReviews: connection([{ author: { login: 'grace' }, state: ['APPROVED'] }]),
      },
      expected: 'partial',
    },
    { node: { ...reviewers, headRefOid: 'c'.repeat(40) }, expected: 'unavailable' },
    { node: null, expected: 'unavailable' },
  ] as const) {
    const { transport } = scriptedTransport([{ head: headOid, base: 'b'.repeat(40) }], [])
    transport.paginate = async <T>() => [] as T[]
    transport.graphql = async <T>(query: string, variables: Record<string, unknown>) => {
      assert.equal(variables.owner, 'acme')
      assert.equal(variables.name, 'widgets')
      assert.equal(variables.number, 7)
      if (query.includes('latestReviews')) {
        assert.match(query, /reviewRequests\(first: 100\)/u)
        assert.match(query, /latestReviews\(first: 100\)/u)
        if (!scenario.node) throw new Error('Cannot query field latestReviews')
        return { repository: { pullRequest: scenario.node } } as T
      }
      return {
        repository: {
          pullRequest: {
            number: 7,
            title: 'Review me',
            url: 'https://github.com/acme/widgets/pull/7',
            headRefName: 'feature',
            headRefOid: headOid,
            baseRefName: 'main',
            isDraft: false,
            state: 'OPEN',
            body: 'Existing description',
          },
        },
      } as T
    }
    setGitHubTransport(transport)
    const headline = await readReviewHeadline(workspace.repo, 7)
    assert.equal(headline.pullRequest.body, 'Existing description')
    assert.equal(headline.reviewers.state, scenario.expected)
    if (scenario.expected === 'available') {
      assert.deepEqual(headline.reviewers.requested, [
        { kind: 'user', name: 'ada' },
        { kind: 'team', name: 'maintainers' },
      ])
      assert.equal(headline.reviewers.reviews[0].headOid, 'b'.repeat(40))
      assert.equal(headline.reviewers.message, '')
    } else assert.ok(headline.reviewers.message)
    if (scenario.expected === 'unavailable') {
      assert.deepEqual(headline.reviewers.requested, [])
      assert.deepEqual(headline.reviewers.reviews, [])
    }
  }
})

test('headline stack facts use one bounded cancellable batch and reject malformed or stale readiness', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  t.after(() => setGitHubTransport(null))
  const head = 'a'.repeat(40)
  const controller = new AbortController()
  const { transport } = scriptedTransport([{ head, base: 'b'.repeat(40) }], [])
  const rest = transport.rest.bind(transport)
  let omitPrecedingMember = false
  transport.rest = async <T>(request: GitHubRestRequest) => {
    if (!request.path?.includes('/stacks')) return rest<T>(request)
    return {
      status: 200,
      rateLimit: rateLimit(),
      data: [
        {
          id: 1,
          number: 42,
          open: true,
          base: { ref: 'main' },
          pull_requests: Array.from({ length: 40 }, (_, index) =>
            omitPrecedingMember && index === 38
              ? null
              : {
                  number: index + 1,
                  state: 'open',
                  draft: false,
                  head: { ref: `layer-${index + 1}`, sha: head },
                },
          ),
        },
      ] as T,
    }
  }
  let batches = 0
  transport.graphql = async <T>(
    query: string,
    _variables: Record<string, unknown>,
    options?: GitHubGraphqlOptions,
  ) => {
    if (query.includes('layer0:')) {
      batches += 1
      assert.equal(options?.signal, controller.signal)
      assert.equal((query.match(/: pullRequest\(/gu) ?? []).length, 32)
      assert.match(query, /pullRequest\(number: 40\)/u)
      assert.doesNotMatch(query, /pullRequest\(number: 33\)/u)
      return {
        repository: {
          layer0: {
            title: 'Confirmed absence',
            headRefOid: head,
            state: 'MERGED',
            isDraft: false,
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
          layer1: {
            title: 'Malformed nested facts',
            headRefOid: head,
            state: 'FUTURE',
            isDraft: 'false',
            reviewDecision: ['APPROVED'],
            commits: { nodes: [{ commit: { statusCheckRollup: { state: ['SUCCESS'] } } }] },
          },
          layer2: {
            title: 'Wrong head',
            headRefOid: 'c'.repeat(40),
            state: 'OPEN',
            isDraft: false,
            reviewDecision: 'APPROVED',
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
          },
        },
      } as T
    }
    if (query.includes('latestReviews'))
      return {
        repository: {
          pullRequest: {
            headRefOid: head,
            reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
            latestReviews: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      } as T
    return {
      repository: {
        pullRequest: {
          number: 40,
          title: 'Selected final layer',
          url: 'https://github.com/acme/widgets/pull/40',
          headRefName: 'layer-40',
          headRefOid: head,
          baseRefName: 'layer-39',
          isDraft: false,
          state: 'OPEN',
          body: '',
        },
      },
    } as T
  }
  setGitHubTransport(transport)
  const headline = await readReviewHeadline(workspace.repo, 40, controller.signal)
  assert.equal(batches, 1)
  assert.equal(headline.rail.stack?.pullRequests.length, 40)
  assert.equal(headline.rail.previous?.number, 39)
  assert.equal(headline.rail.next, null)
  assert.match(headline.rail.message, /bounded to 32/u)
  assert.deepEqual(headline.rail.facts?.[0], {
    number: 1,
    state: 'available',
    title: 'Confirmed absence',
    lifecycle: 'MERGED',
    draft: false,
    checks: 'none',
    review: 'none',
    message: '',
  })
  assert.equal(headline.rail.facts?.[1].state, 'partial')
  assert.equal(headline.rail.facts?.[1].lifecycle, null)
  assert.equal(headline.rail.facts?.[1].draft, null)
  assert.equal(headline.rail.facts?.[1].checks, 'unknown')
  assert.equal(headline.rail.facts?.[1].review, 'unknown')
  assert.equal(headline.rail.facts?.[2].state, 'stale')
  assert.equal(headline.rail.facts?.[2].checks, 'unknown')
  assert.equal(headline.rail.facts?.[2].review, 'unknown')
  assert.equal(headline.rail.facts?.at(-1)?.number, 40)
  assert.equal(headline.rail.facts?.at(-1)?.state, 'unavailable')

  omitPrecedingMember = true
  const partial = await readReviewHeadline(workspace.repo, 40, controller.signal)
  assert.equal(partial.rail.stack?.size, 40)
  assert.equal(partial.rail.stack?.pullRequests.length, 39)
  assert.equal(partial.rail.previous, null, 'an omitted position is not an adjacent layer')
  assert.equal(partial.rail.next, null)
})

test('headline metadata cancellation and selected native head disagreement preserve read authority', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  t.after(() => setGitHubTransport(null))
  for (const scenario of ['cancelled', 'native-head-moved', 'canonical-head-moved'] as const) {
    await t.test(scenario, async () => {
      const head = 'b'.repeat(40)
      const nativeHead = scenario === 'native-head-moved' ? 'a'.repeat(40) : head
      const metadataHead = scenario === 'canonical-head-moved' ? 'a'.repeat(40) : head
      const controller = new AbortController()
      const { transport } = scriptedTransport([{ head, base: 'c'.repeat(40) }], [])
      const rest = transport.rest.bind(transport)
      transport.rest = async <T>(request: GitHubRestRequest) => {
        if (!request.path?.includes('/stacks')) return rest<T>(request)
        return {
          status: 200,
          rateLimit: rateLimit(),
          data: [
            {
              id: 1,
              number: 42,
              open: true,
              base: { ref: 'main' },
              pull_requests: [
                { number: 1, state: 'open', draft: false, head: { ref: 'layer-1' } },
                {
                  number: 2,
                  state: 'open',
                  draft: false,
                  head: { ref: 'layer-2', sha: nativeHead },
                },
              ],
            },
          ] as T,
        }
      }
      transport.graphql = async <T>(
        query: string,
        _variables: Record<string, unknown>,
        options?: GitHubGraphqlOptions,
      ) => {
        if (query.includes('layer0:')) {
          assert.equal(options?.signal, controller.signal)
          if (scenario === 'cancelled') controller.abort()
          const facts = (headRefOid: string) => ({
            title: 'Layer',
            headRefOid,
            state: 'OPEN',
            isDraft: false,
            reviewDecision: 'APPROVED',
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
          })
          return { repository: { layer0: facts(head), layer1: facts(metadataHead) } } as T
        }
        if (query.includes('latestReviews'))
          return {
            repository: {
              pullRequest: {
                headRefOid: head,
                reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
                latestReviews: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          } as T
        return {
          repository: {
            pullRequest: {
              number: 2,
              title: 'Selected layer',
              url: 'https://github.com/acme/widgets/pull/2',
              headRefName: 'layer-2',
              headRefOid: head,
              baseRefName: 'layer-1',
              isDraft: false,
              state: 'OPEN',
              body: '',
            },
          },
        } as T
      }
      setGitHubTransport(transport)
      if (scenario === 'cancelled') {
        await assert.rejects(
          readReviewHeadline(workspace.repo, 2, controller.signal),
          (error: unknown) => error instanceof GitHubTransportError && error.kind === 'cancelled',
        )
      } else {
        const headline = await readReviewHeadline(workspace.repo, 2, controller.signal)
        assert.equal(headline.rail.facts?.[0].state, 'partial')
        assert.equal(headline.rail.facts?.[0].checks, 'unknown')
        assert.equal(headline.rail.facts?.[0].review, 'unknown')
        assert.equal(headline.rail.facts?.[1].state, 'stale')
        assert.equal(headline.rail.facts?.[1].checks, 'unknown')
        assert.equal(headline.rail.facts?.[1].review, 'unknown')
      }
    })
  }
})

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
 * A review as the REST list endpoint reports it, with the inline comments it
 * carries. `side` and `start_side` are GitHub's own `LEFT`/`RIGHT` here, which
 * is the whole reason a settlement reads this endpoint rather than GraphQL.
 */
interface HeldReview {
  [key: string]: unknown
  id: number
  state: string
  body: string
  commit_id: string | null
  user: { login: string }
  html_url?: string
  comments?: Array<{
    path: string
    line: number
    side: string
    body: string
    start_line?: number | null
    start_side?: string | null
  }>
}

/** The decision GitHub records a submitted review as. */
const STATE_FOR_EVENT: Record<string, string> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
}

/**
 * One page of a REST list, honouring the `per_page` and `page` the code asked
 * for. GitHub returns these oldest first, and a page shorter than `per_page` is
 * the last one — which is what tells a paged read it has seen everything.
 */
function restPage(
  path: string,
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const query = new URLSearchParams(path.split('?')[1] ?? '')
  const perPage = Number(query.get('per_page') ?? '30')
  const page = Number(query.get('page') ?? '1')
  const size = Number.isFinite(perPage) && perPage > 0 ? perPage : 30
  const index = Number.isFinite(page) && page > 0 ? page : 1
  return rows.slice((index - 1) * size, index * size)
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
  /**
   * The reviews GitHub already holds, in the shape its REST list endpoint
   * returns them, with the inline comments each one carries.
   *
   * Reviews this app posts are not written here: the double applies the request
   * and serves what it applied, exactly as GitHub does. A landed review is
   * therefore a consequence of a request that was made and answered, not a
   * fixture a test asserts alongside it — which is the only way a test can catch
   * a write that claimed success while sending something other than what it
   * recorded.
   */
  heldReviews?: HeldReview[]
  /**
   * Reviews to publish when the pull request's history is walked for the given
   * time. The settlement reads that history twice, so this is how a review from
   * somebody else is placed after the boundary was read and before the settled
   * writes are matched.
   */
  afterReviewWalk?: (walk: number, appliedWrites: number) => HeldReview[] | null
  /**
   * Rewrites what the server stored, after it applied the request.
   *
   * The one thing a test cannot build out of a request is a record GitHub holds
   * that is *not* what the request said — a review recorded under a different
   * decision, or a comment whose text is not the one that was sent. That is a
   * property of the server, not of the request, so it is modelled here rather
   * than faked by hand-writing a review the request never produced.
   */
  landedAs?: (review: HeldReview, comments: Array<Record<string, unknown>>) => void
  /**
   * Reviews that appear on the pull request after this one is applied, given the
   * applied review so ids can be placed above it. A settlement that only reads
   * a recent page has to walk past all of them to reach the one it is looking
   * for, which is the only way that read is actually tested.
   */
  reviewsAfterApply?: (applied: HeldReview) => Array<Omit<HeldReview, 'id'>>
  /**
   * Whether a submitted review is stored at all. The default is yes, because a
   * request that left usually was applied; setting it to false models the one
   * case a lost response cannot rule out — the request arrived and was dropped.
   */
  keepsReview?: boolean
  /**
   * A comment another account leaves in the thread once a reply is attempted,
   * so a test can put somebody else's identical words inside the attempt's own
   * window, where a boundary check alone would not catch them.
   */
  collaboratorReply?: ThreadComment
}

function graphOperation(query: string): string {
  // A thread's own comments are a connection inside the thread, read through
  // an inline fragment on the node rather than through a named field.
  if (query.includes('on PullRequestReviewThread')) return 'threadComments'
  // A mutation is recognised by the field it writes, because these mutations
  // are sent without a name and the double answers by what they change.
  for (const name of [
    'addPullRequestReviewThreadReply',
    'unresolveReviewThread',
    'resolveReviewThread',
  ]) {
    if (query.includes(name)) return name
  }
  // Otherwise the operation's own name, matched as a word: the reviews read
  // selects the field `reviews`, and matching that loosely would answer it with
  // the threads response. A document sent without a name is told apart by the
  // connection it selects.
  const named = /\b(?:query|mutation)\s+(\w+)/.exec(query)
  if (named) return named[1]
  return 'permissions'
}

/**
 * The fields GitHub's schema actually has on the two types these queries name.
 *
 * GitHub has no `Repository.viewer` — the account is `Query.viewer` — and a
 * document asking for a field the type does not have fails whole with
 * `undefinedField` before the operation runs. The double answers this way so a
 * query that names a field one level too deep is refused here exactly as it
 * would be refused in production, instead of being handed a plausible answer.
 */
/**
 * The fields GitHub's schema has on the types these queries name, and the type
 * each returns.
 *
 * GitHub has no `Repository.viewer` — the account is `Query.viewer` — and a
 * document asking for a field the type does not have fails whole with
 * `undefinedField` before the operation runs. The double answers this way so a
 * query that names a field one level too deep is refused here exactly as it
 * would be refused in production, instead of being handed a plausible answer
 * for a document that cannot execute.
 */
const GRAPHQL_SCHEMA: Record<
  string,
  { fields: readonly string[]; returns?: Record<string, string> }
> = {
  Query: {
    fields: [
      'viewer',
      'repository',
      'node',
      'addPullRequestReviewThreadReply',
      'resolveReviewThread',
      'unresolveReviewThread',
    ],
    // The type a field's own selection is made on. This is what the schema says
    // the field returns, and it is the whole point: `repository` returns a
    // Repository, so a field named on that Repository is checked against
    // Repository rather than against the root.
    returns: {
      viewer: 'User',
      repository: 'Repository',
      node: 'Node',
      addPullRequestReviewThreadReply: 'AddPullRequestReviewThreadPayload',
      resolveReviewThread: 'ResolveReviewThreadPayload',
      unresolveReviewThread: 'UnresolveReviewThreadPayload',
    },
  },
  // A mutation's own root is a different type, and its payload is what the
  // selection names, so a document is walked from the root the operation uses.
  Mutation: {
    fields: ['addPullRequestReviewThreadReply', 'resolveReviewThread', 'unresolveReviewThread'],
  },
  Repository: {
    fields: ['viewerPermission', 'name', 'owner', 'pullRequest', 'url', 'id'],
    // There is no `viewer` here, and that absence is the point.
    returns: { pullRequest: 'PullRequest' },
  },
  PullRequest: {
    fields: ['state', 'viewerDidAuthor', 'reviewThreads', 'number', 'title'],
    returns: { reviewThreads: 'PullRequestReviewThreadConnection' },
  },
  PullRequestReviewThread: {
    fields: ['comments', 'id', 'isResolved', 'isOutdated'],
    returns: { comments: 'PullRequestReviewCommentConnection' },
  },
  // A user or the signed-in viewer. `login` is on both, so the account field is
  // what distinguishes the one that is wrong at the repository level.
  User: { fields: ['login', 'id'] },
  // GitHub's real shape, verified against the live schema. There is deliberately
  // no `side` and no `startSide` here: `PullRequestReviewComment` has neither, and
  // a double that answered for them would hand back a plausible value for a
  // document GitHub refuses to execute at all — which is how a query that can
  // never succeed past a first submission ends up looking tested.
  PullRequestReviewComment: {
    fields: [
      'id',
      'url',
      'body',
      'viewerDidAuthor',
      'createdAt',
      'path',
      'line',
      'startLine',
      'author',
    ],
    returns: { author: 'User' },
  },
  PageInfo: { fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  AddPullRequestReviewThreadReplyPayload: {
    fields: ['comment'],
    returns: { comment: 'PullRequestReviewComment' },
  },
  ResolveReviewThreadPayload: {
    fields: ['thread'],
    returns: { thread: 'PullRequestReviewThread' },
  },
  UnresolveReviewThreadPayload: {
    fields: ['thread'],
    returns: { thread: 'PullRequestReviewThread' },
  },
  // Connections carry a scalar `totalCount`, the page info, and the rows.
  PullRequestReviewThreadConnection: {
    fields: ['totalCount', 'pageInfo', 'nodes'],
    returns: { nodes: 'PullRequestReviewThread' },
  },
  PullRequestReviewCommentConnection: {
    fields: ['totalCount', 'pageInfo', 'nodes'],
    returns: { nodes: 'PullRequestReviewComment' },
  },
  Commit: { fields: ['oid', 'messageHeadline'] },
  Node: { fields: ['id'], returns: { comments: 'PullRequestReviewCommentConnection' } },
}

/** One field of a selection, with the type it is selected from. */
interface GraphQLSelection {
  field: string
  type: string
}

/**
 * The fields a document selects on `type`, following the schema's own return
 * types so a selection one level too deep is checked against the type it is
 * actually made on. A fragment or an alias this does not model is simply not
 * walked, which makes the check narrower than GitHub's and never stricter.
 */
function operationRoot(document: string): 'Query' | 'Mutation' {
  return /\bmutation\b/.test(document.slice(0, document.indexOf('{'))) ? 'Mutation' : 'Query'
}

function selectionsOn(document: string, type: string, from = 0): GraphQLSelection[] {
  const open = document.indexOf('{', from)
  if (open === -1) return []
  const found: GraphQLSelection[] = []
  let depth = 0
  let end = -1
  for (let index = open; index < document.length; index += 1) {
    if (document[index] === '{') depth += 1
    else if (document[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) return []
  const body = document.slice(open + 1, end)
  let index = 0
  while (index < body.length) {
    const rest = body.slice(index)
    const match = /^\s*(\w+)\s*(?:\([^)]*\))?\s*\{/.exec(rest)
    if (!match) break
    const field = match[1]
    found.push({ field, type })
    // What a field returns is what its own selection is made on, so this is
    // where a selection one level too deep is caught rather than tolerated.
    const child = GRAPHQL_SCHEMA[type]?.returns?.[field]
    if (child && GRAPHQL_SCHEMA[child]) {
      const childFrom = open + 1 + index + match[0].length - 1
      found.push(...selectionsOn(document, child, childFrom))
    }
    // Step past this selection's own braces so siblings are not re-walked.
    let inner = 0
    let cursor = index + match[0].length - 1
    for (; cursor < body.length; cursor += 1) {
      if (body[cursor] === '{') inner += 1
      else if (body[cursor] === '}') {
        inner -= 1
        if (inner === 0) break
      }
    }
    index = cursor + 1
  }
  return found
}

function threadDouble(options: DoubleOptions = {}): {
  transport: GitHubTransport
  writes: Write[]
  /** Every GraphQL document the code under test sent, in order. */
  queries: string[]
  /** Rewrites what GitHub holds about a review, the way the web UI can. */
  editReview: (id: number, change: (review: HeldReview) => void) => void
  /** Moves the head commit the pull request reports, the way a push does. */
  setHead: (oid: string) => void
  /** Moves the base commit, the way retargeting the pull request does. */
  setBase: (oid: string) => void
} {
  const writes: Write[] = []
  const queries: string[] = []
  let head = options.head ?? 'a'.repeat(40)
  let base = options.base ?? 'b'.repeat(40)
  const permission = options.permission ?? 'WRITE'
  const isAuthor = options.isAuthor === true
  const state = options.state ?? 'OPEN'
  const viewer = options.viewer ?? 'ada'
  // The reviews GitHub holds, as a server that applies what it is sent. A
  // review this app posts is created here from the request body, so what a test
  // reads back is exactly what the code chose to send — not a fixture written
  // to agree with it.
  const reviews: HeldReview[] = (options.heldReviews ?? []).map((review) => ({ ...review }))
  let reviewWalks = 0
  let reviewWalksWritten = 0
  const reviewCommentsOnGitHub: Array<Record<string, unknown>> = []
  // A review GitHub already holds has its comments in the comments listing, on
  // the same model the create-review path pushes to. Seeding them here is what
  // lets a reconciliation find a review that existed before the attempt — and so
  // lets a test prove that it is refused rather than adopted.
  for (const review of reviews) {
    for (const comment of review.comments ?? []) {
      reviewCommentsOnGitHub.push({
        id: reviewCommentsOnGitHub.length + 1,
        pull_request_review_id: review.id,
        path: comment.path,
        line: comment.line,
        side: comment.side,
        start_line: comment.start_line ?? null,
        start_side: comment.start_side ?? null,
        body: comment.body,
        user: { login: review.user.login },
      })
    }
  }
  /** Changes what GitHub holds about a review after the fact, as the web UI can. */
  const editReview = (id: number, change: (review: HeldReview) => void): void => {
    const found = reviews.find((review) => review.id === id)
    if (found) change(found)
  }
  const threads = options.threads ?? []
  // The comparison identity, in the shape the pull request resource returns:
  // a base branch has both an object and a name, and the name is part of it.
  // Read through a getter so moving the head moves the pull request's own
  // account of it, which is what a push does.
  const identity = {
    get head() {
      return { sha: head }
    },
    get base() {
      return { sha: base, ref: options.baseRef ?? 'main' }
    },
  }
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
    editReview,
    setHead: (oid: string) => {
      head = oid
    },
    setBase: (oid: string) => {
      base = oid
    },
    transport: {
      kind: 'direct',
      destinationHost: GITHUB_DEFAULT_HOST,
      async credentialAuthority(): Promise<string> {
        return 'review-conversation-test-credential'
      },
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
          // The request left, so GitHub now holds what it was sent. That is
          // modelled even for a lost response, because a lost response is
          // precisely the case where the write was applied without the app
          // hearing about it — and it is applied from the body the code actually
          // sent, so a test cannot assert a landed review the request never
          // carried.
          const sent = request.body as {
            commit_id?: string
            body?: string
            event?: string
            comments?: unknown[]
          }
          if (path.endsWith('/pulls/7/reviews') && typeof sent?.event === 'string') {
            const id = reviews.reduce((max, review) => Math.max(max, review.id), 100) + 1
            const comments = (sent.comments ?? []).filter(
              (comment): comment is Record<string, unknown> =>
                typeof comment === 'object' && comment !== null,
            )
            reviews.push({
              id,
              state: STATE_FOR_EVENT[sent.event] ?? 'COMMENTED',
              body: typeof sent.body === 'string' ? sent.body : '',
              commit_id: typeof sent.commit_id === 'string' ? sent.commit_id : null,
              user: { login: viewer },
              html_url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`,
            })
            for (const comment of comments) {
              reviewCommentsOnGitHub.push({
                id: reviewCommentsOnGitHub.length + 1,
                pull_request_review_id: id,
                path: comment.path,
                line: comment.line,
                side: comment.side,
                start_line: comment.start_line ?? null,
                start_side: comment.start_side ?? null,
                commit_id: typeof sent.commit_id === 'string' ? sent.commit_id : null,
                body: comment.body,
                user: { login: viewer },
              })
            }
            const applied = reviews[reviews.length - 1] as HeldReview
            const appliedComments = reviewCommentsOnGitHub.filter(
              (comment) => comment.pull_request_review_id === applied.id,
            )
            if (options.landedAs) {
              options.landedAs(applied, appliedComments)
            } else if (options.keepsReview === false) {
              // The request arrived and was dropped, so GitHub holds nothing of
              // *it*. Only the review this request created goes: the reviews the
              // pull request already held are its history, and erasing them would
              // hide the very thing a reconciliation has to weigh — a review that
              // existed before the attempt.
              const dropped = reviews.indexOf(applied)
              if (dropped >= 0) reviews.splice(dropped, 1)
              for (let i = reviewCommentsOnGitHub.length - 1; i >= 0; i -= 1) {
                if (reviewCommentsOnGitHub[i]?.pull_request_review_id === applied.id) {
                  reviewCommentsOnGitHub.splice(i, 1)
                }
              }
            }
            reviewWalksWritten += 1
            if (options.reviewsAfterApply) {
              let next = applied.id
              for (const later of options.reviewsAfterApply(applied)) {
                next += 1
                reviews.push({ ...later, id: next } as HeldReview)
              }
            }
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
            const created = applied
            return {
              status: 201,
              rateLimit: rateLimit(),
              data: {
                id: created.id,
                state: created.state,
                html_url: created.html_url,
              },
            } as GitHubRestResponse<T>
          }
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
          return { status: 201, rateLimit: rateLimit(), data: {} } as GitHubRestResponse<T>
        }
        // The two reads a settlement needs. Both paginate the way GitHub does,
        // so a review or a comment beyond the first page is reachable rather
        // than quietly absent.
        //
        // A review that lands between them is the race the settlement is built
        // against: the first read fixes what existed when the attempt was made
        // and the second sees what exists now, so anything above the first
        // read's reach is somebody else's work by definition. `afterReviewWalk`
        // puts one exactly there.
        if (path.includes('/pulls/7/reviews')) {
          if (options.afterReviewWalk) {
            const later = options.afterReviewWalk(reviewWalks, reviewWalksWritten)
            reviewWalks += 1
            if (later) {
              let next = reviews.reduce((max, review) => Math.max(max, review.id), 100)
              for (const review of later) {
                next += 1
                reviews.push({ ...review, id: next } as HeldReview)
              }
            }
          }
          return {
            status: 200,
            rateLimit: rateLimit(),
            data: restPage(path, reviews),
          } as GitHubRestResponse<T>
        }
        if (path.includes('/pulls/7/comments')) {
          return {
            status: 200,
            rateLimit: rateLimit(),
            data: restPage(path, reviewCommentsOnGitHub),
          } as GitHubRestResponse<T>
        }
        if (path.includes('/files')) {
          return {
            status: 200,
            rateLimit: rateLimit(),
            data: options.files ?? [],
          } as GitHubRestResponse<T>
        }
        if (path.endsWith('/pulls/7')) {
          return { status: 200, rateLimit: rateLimit(), data: identity } as GitHubRestResponse<T>
        }
        return {
          status: 404,
          rateLimit: rateLimit(),
          data: { message: 'Not Found' },
        } as GitHubRestResponse<T>
      },
      async paginate<T>(request: GitHubRestRequest): Promise<T[]> {
        return ((request.path ?? '').includes('/files') ? (options.files ?? []) : []) as T[]
      },
      async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        // A field the schema does not have is refused before the operation runs,
        // the way GitHub refuses it. A double that answered anyway would hand
        // back a plausible value for a document that cannot execute at all.
        for (const selection of selectionsOn(query, operationRoot(query))) {
          if (!GRAPHQL_SCHEMA[selection.type]?.fields.includes(selection.field)) {
            const error = new Error(
              `Cannot query field "${selection.field}" on type "${selection.type}".`,
            ) as Error & { type?: string }
            error.type = 'undefinedField'
            throw error
          }
        }
        const operation = graphOperation(query)
        queries.push(query)
        // Somebody else saying the same words in the thread once the reply has
        // gone out, whether or not the response comes back. A reconciliation
        // must not take that for this account's own reply landing.
        if (operation === 'addPullRequestReviewThreadReply' && options.collaboratorReply) {
          const id = typeof variables.threadId === 'string' ? variables.threadId : null
          const page = id ? commentPages.get(id) : null
          if (page) {
            page[0] = {
              ...page[0],
              total: page[0].total + 1,
              nodes: [...page[0].nodes, commentNode(options.collaboratorReply)],
            }
          }
        }
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
            addPullRequestReviewThreadReply: {
              comment: { id: 'IC_1', url: 'https://github.com/c/1' },
            },
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
            [operation]: {
              thread: { id: threadId, isResolved: operation === 'resolveReviewThread' },
            },
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
        if (operation === 'ReviewThreads') {
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
      draft({
        id: 'd1',
        ref: refFor(hunk, hunk.lines.indexOf(added[0])),
        body: 'this needs a name',
      }),
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

test('confirmed delivery retires only its original owner drafts without a renderer callback', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const sent = draft({ id: 'sent', ref: refFor(hunk, 1), body: 'Send this.' })
  const unsent = draft({ ...sent, id: 'unsent', body: 'Still editing.' })
  const record: ReviewDraftRecord = {
    number: 7,
    ...JOURNAL_OWNER,
    comparison: comparison(),
    drafts: [sent, unsent],
    updatedAt: '2026-09-23T10:00:00Z',
  }
  const owners = [
    JOURNAL_OWNER,
    { ...JOURNAL_OWNER, viewer: 'grace' },
    { ...JOURNAL_OWNER, repo: 'acme/other' },
  ]
  for (const owner of owners) await writeReviewDrafts(workspace.repo, { ...record, ...owner })
  const { transport, writes } = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [sent],
  }
  const result = await submitReview(workspace.repo, 7, submission)
  assert.deepEqual(result.delivered, [sent.id])
  for (const owner of owners) {
    const reopened = await readReviewDrafts(workspace.repo, owner.repo, owner.viewer, 7)
    assert.deepEqual(reopened?.drafts, owner === JOURNAL_OWNER ? [unsent] : [sent, unsent])
  }
  // A stale window recovering the same delivered draft must also retire it,
  // without posting again or deleting unrelated unsent work.
  await writeReviewDrafts(workspace.repo, record)
  await submitReview(workspace.repo, 7, submission)
  assert.equal(writes.length, 1)
  const reopened = await readReviewDrafts(
    workspace.repo,
    JOURNAL_OWNER.repo,
    JOURNAL_OWNER.viewer,
    7,
  )
  assert.deepEqual(reopened?.drafts, [unsent])
})

test('a failed delivered-draft cleanup keeps settled evidence and recovers without another POST', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const sent = draft({ id: 'sent', ref: refFor(textHunk(entry, 0), 1), body: 'Send this.' })
  await writeReviewDrafts(workspace.repo, {
    number: 7,
    ...JOURNAL_OWNER,
    comparison: comparison(),
    drafts: [sent],
    updatedAt: '2026-09-23T10:00:00Z',
  })
  const lock = join(workspace.repo, '.git', 'git-stacks-review-drafts.json.lock')
  const { transport, writes } = threadDouble({ files: [apiFile({ patch })] })
  const rest = transport.rest.bind(transport)
  transport.rest = async <T>(request: GitHubRestRequest) => {
    const result = await rest<T>(request)
    if (request.method === 'POST') await writeFile(lock, 'held by something else\n')
    return result
  }
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [sent],
  }
  await assert.rejects(() => submitReview(workspace.repo, 7, submission))
  const evidence = await readUncertainWrites(
    workspace.repo,
    JOURNAL_OWNER.repo,
    7,
    JOURNAL_OWNER.viewer,
  )
  assert.equal(evidence[0]?.settled?.state, 'COMMENTED')
  assert.deepEqual(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7))?.drafts,
    [sent],
  )
  await rm(lock)
  const recovered = await submitReview(workspace.repo, 7, submission)
  assert.deepEqual(recovered.delivered, [sent.id])
  assert.equal(writes.length, 1)
  assert.equal(
    await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7),
    null,
  )
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
  const removed = refFor(
    hunk,
    hunk.lines.findIndex((line) => line.side === 'base'),
  )

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
  const removed = refFor(
    hunk,
    hunk.lines.findIndex((line) => line.side === 'base'),
  )
  // The same comment still resolves against the head it was written for.
  assert.equal(
    resolveReviewDrafts(fileSet(written), [draft({ id: 'd1', ref: removed, body: 'why' })])[0]
      .match,
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
  const original = refFor(
    hunk,
    hunk.lines.findIndex((line) => line.side === 'head'),
  )
  // A line inserted above shifts the commented line down by one without
  // changing it, which is the case re-anchoring exists for.
  const shiftedPatch = '@@ -1,3 +1,4 @@\n+inserted\n keep\n-old\n+new\n tail'
  const resolutions = resolveReviewDrafts(
    fileSet(file({ diff: { kind: 'text', hunks: hunks(shiftedPatch) } })),
    [draft({ id: 'd1', ref: original, body: 'why warn here' })],
  )
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
  const baseLine = refFor(
    hunk,
    hunk.lines.findIndex((line) => line.side === 'base'),
  )
  const headLine = refFor(
    hunk,
    hunk.lines.findIndex((line) => line.side === 'head'),
  )
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
      threadNode({
        id: 'PRRT_2',
        line: 30,
        startLine: 28,
        startSide: 'RIGHT',
        resolved: true,
        comments: [],
      }),
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
        {
          after: commentCursor('PRRT_2', 1),
          nodes: [{ id: 'c2', author: 'grace', body: 'one more' }],
        },
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
    destinationHost: GITHUB_DEFAULT_HOST,
    async credentialAuthority(): Promise<string> {
      return 'review-apply-test-credential'
    },
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
        return {
          status: 200,
          rateLimit: rateLimit(),
          data: [apiFile({ patch })],
        } as GitHubRestResponse<T>
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
    // The request left and GitHub kept nothing: the outcome stays unknown.
    keepsReview: false,
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

test('a lost review is settled by asking GitHub what it holds, not by the summary', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const review = (body: string, text = 'needs a name') => ({
    event: 'COMMENT' as const,
    body,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: text })],
  })

  // GitHub accepted the review and the response was lost. The double builds the
  // landed review from the body the code actually sent, so this can only be
  // settled if what was sent is what the record says was attempted. The summary
  // is component-local state, so reopening the workspace or editing a sentence
  // must not change what the attempt was — and the record, not the composer, is
  // what a reconciliation compares against.
  const landed = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(landed.transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, review('')), {
    name: 'ReviewOutcomeUnknownError',
  })
  const second = await submitReview(workspace.repo, 7, review('a different summary'))

  assert.equal(second.state, 'COMMENTED')
  assert.equal(landed.writes.length, 1, 'the review GitHub holds is not sent again')
})

test('an older review of the same commit is not adopted for a later attempt', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
  }
  // The reviewer wrote the same comment on the same line before, and GitHub
  // took it. This attempt is the second one and its review never arrived, so
  // adopting the first review would report a success this attempt never had and
  // clear a draft the reviewer is still owed.
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    heldReviews: [
      {
        id: 90,
        state: 'COMMENTED',
        body: '',
        commit_id: comparison().headOid,
        user: { login: 'ada' },
        comments: [{ path: 'src/app.ts', line: 1, side: 'RIGHT', body: 'needs a name' }],
      },
    ],
    // GitHub holds the earlier review and nothing else: this attempt's own
    // review never arrived, and the earlier one must not stand in for it.
    keepsReview: false,
  })

  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1, 'the earlier review is not mistaken for this attempt')
})

test('a review of the same commit with a different decision is not adopted', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)

  // GitHub accepted the request and recorded a different decision for it. The
  // attempt was a plain comment; an approval is not the thing that was sent, so
  // it cannot stand in for it.
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
  }
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    landedAs: (review) => {
      review.state = 'APPROVED'
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1, 'an approval is not adopted for a comment review')
})

test('a review carrying different comments is not adopted for this attempt', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  // GitHub accepted the request and stored a comment that is not the one that
  // was sent. Same author, same commit, same decision, same empty summary — and
  // different words. The comments are the review; a matching summary says
  // nothing about whether this attempt's words reached GitHub.
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
  }
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    landedAs: (_review, comments) => {
      const first = comments[0]
      if (first) first.body = 'an entirely different remark'
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1, 'a review of other comments is not this attempt')
})

test("a collaborator's identical review is not adopted for this account", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  // Byte for byte what this account was trying to write, except that somebody
  // else wrote it. A collaborator's review is not this reviewer's write.
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
  }
  // GitHub applied the request and recorded it against another account, which
  // is what a review submitted on somebody else's behalf looks like. A
  // collaborator's review is not this reviewer's write.
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    landedAs: (review, comments) => {
      review.user = { login: 'grace' }
      for (const comment of comments) comment.user = { login: 'grace' }
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1, "somebody else's review is not this account's write")
})

test('the same unresolved comments stay guarded when the decision changes', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const drafts = [draft({ id: 'd1', ref: at, body: 'needs a name' })]

  // The comment review landed and lost its response. Approving instead is a
  // different event, but it is the same comment on the same line, and posting
  // it again would be the same comment twice.
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    // The request left and GitHub kept nothing: the outcome stays unknown.
    keepsReview: false,
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(
    () =>
      submitReview(workspace.repo, 7, {
        event: 'COMMENT',
        body: '',
        comparison: comparison(),
        drafts,
      }),
    { name: 'ReviewOutcomeUnknownError' },
  )
  await assert.rejects(
    () =>
      submitReview(workspace.repo, 7, {
        event: 'APPROVE',
        body: '',
        comparison: comparison(),
        drafts,
      }),
    { name: 'ReviewWriteUncertainError' },
  )
  assert.equal(writes.length, 1, 'the same comment is not posted under a new decision')
})

test('an unresolved comment stays guarded when a second draft joins the batch', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const first = draft({ id: 'd1', ref: at, body: 'needs a name' })
  const second = draft({ id: 'd2', ref: at, body: 'and a second thought' })

  // A larger batch is a different attempt id, but the first comment is the same
  // unresolved comment, so it is still guarded.
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    // The request left and GitHub kept nothing: the outcome stays unknown.
    keepsReview: false,
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(
    () =>
      submitReview(workspace.repo, 7, {
        event: 'COMMENT',
        body: '',
        comparison: comparison(),
        drafts: [first],
      }),
    { name: 'ReviewOutcomeUnknownError' },
  )
  await assert.rejects(
    () =>
      submitReview(workspace.repo, 7, {
        event: 'COMMENT',
        body: '',
        comparison: comparison(),
        drafts: [first, second],
      }),
    { name: 'ReviewWriteUncertainError' },
  )
  assert.equal(writes.length, 1, 'the unresolved comment is not posted again in a larger batch')
})

test('a lost review GitHub does not hold still refuses the second send', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
  }

  // GitHub never received this one. The local record only says the app never
  // heard back, which is also true of a request that never arrived, so absence
  // is not proof and the second send is refused rather than guessed at.
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    // The request left and GitHub kept nothing, which is the one outcome the
    // lost response cannot rule out.
    keepsReview: false,
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  await assert.rejects(
    () => submitReview(workspace.repo, 7, { ...submission, body: 'a different summary' }),
    { name: 'ReviewWriteUncertainError' },
  )
  assert.equal(writes.length, 1, 'nothing is sent while the outcome is unsettled')
})

test("another account's review of another revision does not retire the record", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
  }

  // Someone else's review of a different revision is not this write, so
  // matching on it would retire the guard and permit the duplicate. The
  // comments are identical to this account's, so only the account and the
  // revision can tell them apart.
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    landedAs: (review, comments) => {
      review.user = { login: 'grace' }
      review.commit_id = 'other'
      for (const comment of comments) comment.user = { login: 'grace' }
    },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1)
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
    // The request left and GitHub kept nothing: the outcome stays unknown.
    keepsReview: false,
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

test("another account's attempt does not delete this one's guard", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  // The same words, the same line, the same revision, so both accounts compute
  // the same attempt id. The journal has to tell them apart by owner.
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'the same words either account might write' })],
  }

  // Ada sends and never hears back. Grace then sends the same thing and also
  // never hears back, so there are now two records to keep apart.
  for (const viewer of ['ada', 'grace']) {
    const attempt = threadDouble({
      files: [apiFile({ patch })],
      viewer,
      failReviewOnce: { status: 502, message: 'Bad Gateway' },
    })
    setGitHubTransport(attempt.transport)
    await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
      name: 'ReviewOutcomeUnknownError',
    })
  }

  // Ada's own guard survived Grace's write. If it had been replaced, this
  // second attempt would be sent and could duplicate what GitHub already holds.
  for (const viewer of ['ada', 'grace']) {
    const still = threadDouble({ files: [apiFile({ patch })], viewer })
    setGitHubTransport(still.transport)
    await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
      name: 'ReviewWriteUncertainError',
    })
    assert.equal(still.writes.length, 0, `${viewer}'s guard is still in force`)
  }
  t.after(() => setGitHubTransport(null))
})

test('a lost review is found however many reviews came after it', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
  }
  // An attempt outlives any recent window: the review it made is now buried
  // under more reviews than one page holds, and the pages hold 100. Reading only
  // the newest page would report "not found" and hold a write GitHub had already
  // settled, with no way out of the hold.
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    // Reviews that arrived after this one, so the landed review is only reachable
    // by walking past a whole page of them.
    reviewsAfterApply: (review) =>
      Array.from({ length: 150 }, (_, index) => ({
        state: 'COMMENTED',
        body: `unrelated ${index}`,
        commit_id: review.commit_id,
        user: { login: 'grace' },
      })),
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  const second = await submitReview(workspace.repo, 7, submission)

  assert.equal(second.state, 'COMMENTED')
  assert.equal(writes.length, 1, 'the review is found by paging back, not by giving up')
})

test('a review carrying more comments than one page holds is still settled', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // GitHub accepts up to 200 inline comments in one review, and the review
  // comment page holds 100. A submission of that size whose response is lost has
  // to be reconcilable, or a write this app is able to make is one it can never
  // find out about.
  const count = 150
  const lines = Array.from({ length: count }, (_, index) => `+added ${index}`).join('\n')
  const patch = `@@ -0,0 +1,${count} @@\n${lines}`
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const drafts = hunk.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.side === 'head' && line.newLine !== null)
    .map(({ line, index }, position) =>
      draft({
        id: `d${position}`,
        ref: refFor(hunk, index),
        body: `remark ${position}`,
      }),
    )
  assert.equal(drafts.length, count)
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts,
  }
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  const second = await submitReview(workspace.repo, 7, submission)

  assert.equal(second.state, 'COMMENTED')
  assert.equal(writes.length, 1, 'every page of the review was read, so nothing was posted again')
})

test('a recovery that adopts some comments posts only the ones GitHub never took', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,3 +1,3 @@\n keep\n-removed\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const removed = hunk.lines.findIndex((line) => line.side === 'base' && line.oldLine !== null)
  const addedRef = refFor(hunk, added)
  const removedRef = refFor(hunk, removed)
  // A comment on an added line, and one on the line it replaced. The second is
  // the interesting one: it is written on the base, which is GitHub's LEFT, and
  // a settlement that recorded it as a head comment could never match it again.
  const first = draft({ id: 'd1', ref: addedRef, body: 'already on GitHub' })
  const secondDraft = draft({ id: 'd2', ref: removedRef, body: 'never sent' })
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const one = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [first],
  }
  // The first attempt carried one comment, and GitHub took it.
  await assert.rejects(() => submitReview(workspace.repo, 7, one), {
    name: 'ReviewOutcomeUnknownError',
  })
  // The reviewer then composed a second comment before retrying, so the payload
  // now names one comment GitHub holds and one it has never seen.
  const both = { ...one, drafts: [first, secondDraft] }
  const recovered = await submitReview(workspace.repo, 7, both)

  assert.equal(writes.length, 2, 'the recovery is one further request')
  const sent = writes.flatMap((write) => reviewComments(write))
  assert.equal(
    sent.filter((comment) => comment.body === 'already on GitHub').length,
    1,
    'the adopted comment is never posted a second time',
  )
  assert.equal(
    sent.filter((comment) => comment.body === 'never sent').length,
    1,
    'and the new comment is posted exactly once',
  )
  // A comment written on the base is GitHub's LEFT on the way out, and a
  // settlement has to see it as such to recognise its own attempt.
  assert.equal(sent.find((comment) => comment.body === 'never sent')?.side, 'LEFT')
  // Both are confirmed to the view: the adopted one so it stops offering it, and
  // the posted one so it is not offered again either.
  assert.deepEqual([...(recovered.delivered ?? [])].sort(), ['d1', 'd2'])
})

test('a settled comment is not posted again after the view drops it late', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const one = draft({ id: 'd1', ref: at, body: 'first' })
  const { transport, writes, editReview } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [one],
  }
  // GitHub took it and the response was lost.
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  // The view was never told, because the app died before it could be. The draft
  // is still in the payload, and the recovery settles it from what GitHub holds
  // — reporting the comment as delivered so the view can drop it.
  const recovered = await submitReview(workspace.repo, 7, submission)
  assert.deepEqual(
    recovered.delivered,
    ['d1'],
    'the delivered comment is named so the view drops it',
  )
  assert.equal(writes.length, 1, 'nothing was posted again')

  // The reviewer then edits the review's summary on the web, which is
  // ordinary and which GitHub records. GitHub can no longer answer the question
  // this attempt asked — the review it holds is no longer the review that was
  // attempted — so the record of what was recognised is the only thing left that
  // knows the comment is already there. A guard that forgot the moment it
  // settled would hold this submission for good, with no way for the reviewer to
  // clear the draft.
  editReview(Number(recovered.id), (review) => {
    review.body = 'edited on the web afterwards'
  })
  const again = await submitReview(workspace.repo, 7, submission)
  assert.deepEqual(
    again.delivered,
    ['d1'],
    'the evidence that GitHub holds this comment outlives GitHub being able to re-derive it',
  )
  assert.equal(writes.length, 1, 'and it is still not posted a second time')

  // A later submission that no longer carries the comment is the view's
  // acknowledgement, and it is what retires the record. Nothing about the
  // journal grows without bound while the reviewer keeps working.
  const nothing = await submitReview(workspace.repo, 7, { ...submission, drafts: [] }).catch(
    (error: Error) => error,
  )
  assert.ok(nothing instanceof Error, 'an empty submission is refused on its own terms')
  assert.equal(writes.length, 1, 'a submission that drops the comment sends nothing')
})

test('a review that existed before the attempt is not adopted from an older page', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const one = draft({ id: 'd1', ref: at, body: 'needs a name' })

  // The list of reviews is chronological, so page one is the *oldest* hundred.
  // This pull request has more than that, and the review that would otherwise be
  // adopted — matching this attempt exactly — sits past the first page. A
  // boundary read from page one alone would be far below it, so an attempt that
  // never reached GitHub would be answered with somebody else's old review.
  const old: HeldReview[] = []
  for (let id = 1; id <= 100; id += 1) {
    old.push({
      id,
      state: 'COMMENTED',
      body: `older review ${id}`,
      commit_id: comparison().headOid,
      user: { login: 'ada' },
    })
  }
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    heldReviews: [
      ...old,
      {
        // Past page one, and an exact match for what this attempt was going to
        // write. It is not this attempt's review.
        id: 500,
        state: 'COMMENTED',
        body: '',
        commit_id: comparison().headOid,
        user: { login: 'ada' },
        comments: [{ path: 'src/app.ts', line: 1, side: 'RIGHT', body: 'needs a name' }],
      },
    ],
    keepsReview: false,
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [one],
  }
  // The first attempt never lands, so the record is journalled as uncertain and
  // the one request that was made and failed is what left the app.
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  const sentBefore = writes.length
  // The retry asks GitHub again. The old review matches this attempt in every
  // field the reconciliation compares — same author, same head, same decision,
  // same summary, same comment — and is not this write. It must be refused.
  const held = await submitReview(workspace.repo, 7, submission).catch((error: Error) => error)
  assert.ok(
    held instanceof Error && held.name === 'ReviewWriteUncertainError',
    'a review from before the attempt is not proof that it arrived',
  )
  assert.equal(
    writes.length,
    sentBefore,
    'and nothing was sent, so the comment is not reported as delivered',
  )
})

test('a settled review for an older head is not a delivery on the new one', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  // The same line, the same words, the same decision. The only thing that
  // differs is the commit the review was written against.
  const one = draft({ id: 'd1', ref: at, body: 'looks right' })
  const first = comparison()
  const second = comparison({ headOid: 'c'.repeat(40) })
  const moved = 'c'.repeat(40)
  const { transport, writes, setHead } = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const on = (head: typeof first) => ({
    event: 'APPROVE' as const,
    body: 'approved',
    comparison: head,
    drafts: [one],
  })
  const approved = await submitReview(workspace.repo, 7, on(first))
  assert.equal(approved.state, 'APPROVED')
  assert.equal(writes.length, 1)

  // A push moves the head, and the reviewer reloads and approves again — the
  // line and the wording are untouched, so the payload looks exactly like the
  // one the settled record already covers. That is a new review of a new commit.
  // The old record must not answer for it: adopting it would clear the draft,
  // send no review, and report an approval of H2 that GitHub never received.
  setHead(moved)
  const again = await submitReview(workspace.repo, 7, on(second))
  assert.equal(writes.length, 2, 'a new revision gets its own review')
  assert.deepEqual(again.delivered, ['d1'], 'and the draft is posted, not treated as already sent')
  assert.equal(
    again.state,
    'APPROVED',
    'the decision asked for on the new head is the one recorded',
  )
})

test('a review that never landed on an older head does not hold the new one', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const one = draft({ id: 'd1', ref: at, body: 'still to say' })
  const first = comparison()
  const second = comparison({ headOid: 'c'.repeat(40) })
  const moved = 'c'.repeat(40)
  const { transport, writes, setHead } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    keepsReview: false,
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const on = (head: typeof first) => ({
    event: 'COMMENT' as const,
    body: '',
    comparison: head,
    drafts: [one],
  })
  // The review of H1 is requested and never arrives, so an uncertain record for
  // H1 stays in the journal. It is still uncertain: nothing has said otherwise.
  await assert.rejects(() => submitReview(workspace.repo, 7, on(first)), {
    name: 'ReviewOutcomeUnknownError',
  })
  // A push moves the head, and the reviewer comes back to review it. The record
  // for H1 is a question about H1, and GitHub holds no answer to it — which is
  // why an uncertain record holds. It cannot be a question about H2, and a
  // reviewer must not be locked out of a new revision by an old one they may
  // never be able to resolve. H2 is sent on its own terms.
  setHead(moved)
  const fresh = await submitReview(workspace.repo, 7, on(second))
  assert.equal(writes.length, 2, 'the new revision is not held by an unanswered old one')
  assert.deepEqual(
    fresh.delivered,
    ['d1'],
    'and its comment is sent, not reported as already there',
  )
})

test('more reviews than the walk reads make the boundary null, not low', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const one = draft({ id: 'd1', ref: at, body: 'needs a name' })
  // Past every page the boundary read will walk, so the newest review cannot be
  // named. A boundary that stops short is not a low boundary to be corrected
  // later — it is a wrong one, and it is wrong in the direction that adopts
  // somebody else's review as this write.
  const many: HeldReview[] = []
  for (let id = 1; id <= 2001; id += 1) {
    many.push({
      id,
      state: 'COMMENTED',
      body: `older review ${id}`,
      commit_id: comparison().headOid,
      user: { login: 'ada' },
    })
  }
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    heldReviews: many,
    keepsReview: false,
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [one],
  }
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  const sentBefore = writes.length
  const held = await submitReview(workspace.repo, 7, submission).catch((error: Error) => error)
  assert.ok(
    held instanceof Error && held.name === 'ReviewWriteUncertainError',
    'a boundary that could not be read to the end holds rather than adopts',
  )
  assert.equal(writes.length, sentBefore, 'and sends nothing')
})

test('an unbounded history is not searched, even for an exact match inside it', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const one = draft({ id: 'd1', ref: at, body: 'needs a name' })
  // More reviews than the walk reads, and one of them — within the pages that
  // were read — is an exact match for the write about to be attempted. With no
  // boundary to rule it out, that review could equally be somebody's from before
  // the attempt, so searching for it is the one thing that must not happen: the
  // attempt never reached GitHub, and matching it here would report a success
  // that did not occur and clear the reviewer's unsent comment.
  const many: HeldReview[] = []
  for (let id = 1; id <= 2001; id += 1) {
    many.push({
      id,
      state: 'COMMENTED',
      body: id === 1500 ? '' : `older review ${id}`,
      commit_id: comparison().headOid,
      user: { login: 'ada' },
      comments:
        id === 1500
          ? [{ path: 'src/app.ts', line: 1, side: 'RIGHT', body: 'needs a name' }]
          : undefined,
    })
  }
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
    heldReviews: many,
    keepsReview: false,
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [one],
  }
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  const sentBefore = writes.length
  const held = await submitReview(workspace.repo, 7, submission).catch((error: Error) => error)
  assert.ok(
    held instanceof Error && held.name === 'ReviewWriteUncertainError',
    'history that could not be bounded is not searched for a match',
  )
  assert.equal(writes.length, sentBefore, 'and nothing is sent or reported delivered')
})

test('a draft written again after the first was sent is new work, not a recovery', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const body = 'needs a name'
  // A third reviewer posts the same words on the same line while the second
  // attempt is between its two settlement reads, so the review is newer than
  // the boundary and identical in every way a head-stamped review can be. It
  // is still not this draft: it was written before the reviewer came back, and
  // the record proves which one that was.
  const theirs: HeldReview = {
    id: 0,
    state: 'COMMENTED',
    body: 'also needs a name',
    commit_id: comparison().headOid,
    user: { login: 'grace' },
    comments: [{ path: 'src/app.ts', line: 1, side: 'RIGHT', body }],
  }
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    // Every read after the second review was posted belongs to the second
    // attempt's settlement, whose boundary was read before it went out. So this
    // lands on that settled read, and the boundary it will be judged against
    // does not contain it.
    afterReviewWalk: (_walk, appliedWrites) => (appliedWrites === 2 ? [theirs] : null),
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const record = (drafts: ReviewDraft[]): ReviewDraftRecord => ({
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts,
    updatedAt: '2026-09-23T10:00:00Z',
  })
  // The reviewer writes the comment, sends it as a plain comment, and GitHub
  // takes it. The view is told, and drops the draft — the acknowledgement.
  const first = draft({ id: newReviewDraftId(), ref: at, body })
  await writeReviewDrafts(workspace.repo, record([first]))
  const sent = await submitReview(workspace.repo, 7, {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [first],
  })
  assert.equal(sent.state, 'COMMENTED')
  assert.deepEqual(sent.delivered, [first.id])
  assert.equal(writes.length, 1)

  // Now they come back and write the same words on the same line, and approve
  // this time. It reads exactly like the comment that was just sent — same
  // anchor, same body, same comparison — and it is a different piece of work.
  // Treating the settled record as its recovery would clear this draft, send
  // no approval at all, and report one GitHub never received.
  const second = draft({ id: newReviewDraftId(), ref: at, body })
  await writeReviewDrafts(workspace.repo, record([second]))
  const approved = await submitReview(workspace.repo, 7, {
    event: 'APPROVE' as const,
    body: 'approved',
    comparison: comparison(),
    drafts: [second],
  })
  assert.equal(writes.length, 2, 'the new composition is sent as its own review')
  assert.equal(approved.state, 'APPROVED', 'and the decision asked for is the one recorded')
  assert.deepEqual(approved.delivered, [second.id], 'naming the draft it sent')
  const posted = writes[1]?.body as { event: string; comments: Array<{ body: string }> }
  assert.equal(posted.event, 'APPROVE', 'the request that left the app is the approval')
  assert.equal(posted.comments.length, 1)
  assert.equal(posted.comments[0]?.body, body)
})

test('a draft on a long path keeps a bridge-sized identity through save and submit', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const path = `src/${'long-directory/'.repeat(12)}review.ts`
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ path, diff: { kind: 'text', hunks: hunks(patch, path) } })
  const hunk = textHunk(entry, 0)
  const at = refFor(hunk, 1, { path })
  const first = draft({ id: newReviewDraftId(), ref: at, body: 'Keep this line.' })
  const second = draft({ id: newReviewDraftId(), ref: at, body: 'Keep this line.' })
  assert.ok(path.length > 128)
  assert.ok(first.id.length <= 128, 'the bridge accepts the generated identity')
  assert.notEqual(first.id, second.id, 'another composition has its own identity')

  const { transport, writes } = threadDouble({ files: [apiFile({ filename: path, patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))
  await writeReviewDrafts(workspace.repo, {
    number: 7,
    ...JOURNAL_OWNER,
    comparison: comparison(),
    drafts: [first],
    updatedAt: '2026-09-23T10:00:00Z',
  })
  const stored = await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7)
  assert.equal(stored?.drafts[0]?.id, first.id)
  const sent = await submitReview(workspace.repo, 7, {
    event: 'COMMENT',
    body: '',
    comparison: comparison(),
    drafts: stored!.drafts,
  })
  assert.deepEqual(sent.delivered, [first.id])
  assert.equal(writes.length, 1)
  assert.equal((writes[0]?.body as { comments: Array<{ path: string }> }).comments[0]?.path, path)
})

test('two windows that opened the same journal each send their own identical comment', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    // The first window's review lands and its response is lost, which is the
    // state the second window has to survive: GitHub holds a comment this
    // account wrote, and no window was ever told so.
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const owned = {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    updatedAt: '2026-09-23T10:00:00Z',
  }
  const body = 'needs a name'
  // Both windows open the repository and read the journal, which is empty. Two
  // windows then compose the same sentence on the same line of the same head:
  // same anchor, same words, same revision, same account. Nothing in a payload
  // can tell those two comments apart except the identity each was composed
  // under, which is why it is minted where the draft is composed rather than
  // counted from what the journal last held — a count read from the same empty
  // journal by both windows hands both of them the same name.
  assert.equal(
    await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7),
    null,
    'precondition: neither window has anything journalled',
  )
  const first = draft({ id: newReviewDraftId(), ref: at, body })
  const second = draft({ id: newReviewDraftId(), ref: at, body })
  assert.notEqual(second.id, first.id, 'two compositions on one line are two identities')

  // The first window sends it as a plain comment. GitHub applies the review and
  // the response never arrives.
  await writeReviewDrafts(workspace.repo, { ...owned, drafts: [first] })
  await assert.rejects(
    () =>
      submitReview(workspace.repo, 7, {
        event: 'COMMENT' as const,
        body: '',
        comparison: comparison(),
        drafts: [first],
      }),
    { name: 'ReviewOutcomeUnknownError' },
  )
  assert.equal(writes.length, 1, 'and the comment is on GitHub, unacknowledged')

  // The second window writes the same sentence again and approves this time.
  // Its comment is not the first window's recovery: it was never sent, so
  // adopting the settled record for it would clear words GitHub does not have
  // and report an approval nobody made.
  await writeReviewDrafts(workspace.repo, {
    ...owned,
    drafts: [second],
    updatedAt: '2026-09-23T10:05:00Z',
  })
  const approved = await submitReview(workspace.repo, 7, {
    event: 'APPROVE' as const,
    body: 'approved',
    comparison: comparison(),
    drafts: [second],
  })
  assert.equal(writes.length, 2, 'the second window sends a review of its own')
  assert.equal(approved.state, 'APPROVED', 'and the decision it asked for is the one recorded')
  assert.deepEqual(
    approved.delivered,
    [second.id],
    'the answer names the comment it carried, not the one the record holds',
  )
  const posted = writes[1]?.body as { event: string; comments: Array<{ body: string }> }
  assert.equal(posted.event, 'APPROVE', 'the request that left the app is the approval')
  assert.equal(posted.comments.length, 1)
  assert.equal(posted.comments[0]?.body, body)
})

test('a journal written before identities were generated still reads and still submits', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const { transport } = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  // A record as an older build wrote it: the identity is the range and a small
  // whole number, and the record carries a counter this build has no use for.
  // It is unsent work somebody is still looking at, so it is read as written
  // rather than refused or renumbered.
  const legacyId = 'src/app.ts:head:1-head:1#1'
  await writeFile(
    join(workspace.repo, '.git', 'git-stacks-review-drafts.json'),
    `${JSON.stringify(
      {
        version: 1,
        records: [
          {
            number: 7,
            repo: JOURNAL_OWNER.repo,
            viewer: JOURNAL_OWNER.viewer,
            comparison: comparison(),
            drafts: [
              {
                id: legacyId,
                ref: at,
                startRef: null,
                body: 'written by an older build',
                createdAt: '2026-09-23T10:00:00Z',
              },
            ],
            updatedAt: '2026-09-23T10:00:00Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
  )

  const read = await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7)
  const stored = read?.drafts[0]
  assert.equal(read?.drafts.length, 1, "the pending words are still the reviewer's")
  assert.equal(stored?.id, legacyId, 'and they keep the identity they were written with')
  assert.equal(stored?.body, 'written by an older build')

  const sent = await submitReview(workspace.repo, 7, {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [stored!],
  })
  assert.equal(sent.state, 'COMMENTED', 'and a stored identity still submits as itself')
  assert.deepEqual(sent.delivered, [legacyId])

  // A name minted now cannot be one of those, however the old record counted:
  // there is no count left to continue.
  assert.notEqual(newReviewDraftId(), legacyId)
})

test('a comment edited after it was composed is sent again, not dropped as sent', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  // The same draft, at the same line, said one way and left unacknowledged.
  const one = draft({ id: 'src/app.ts:head:1-head:1#1', ref: at, body: 'wording' })
  await assert.rejects(
    () =>
      submitReview(workspace.repo, 7, {
        event: 'COMMENT' as const,
        body: '',
        comparison: comparison(),
        drafts: [one],
      }),
    { name: 'ReviewOutcomeUnknownError' },
  )
  assert.equal(writes.length, 1)

  // The reviewer rewords it before resubmitting. It is the same draft — the
  // identity was not reminted by an edit — but it says something GitHub does
  // not hold, and the words they typed are the ones they mean to publish.
  const reworded = draft({ id: one.id, ref: at, body: 'wording, and a question' })
  const sent = await submitReview(workspace.repo, 7, {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [reworded],
  })

  assert.equal(writes.length, 2, 'the reworded comment is posted')
  const posted = writes[1]?.body as { comments: Array<{ body: string }> }
  assert.equal(
    posted.comments[0]?.body,
    'wording, and a question',
    'carrying the words as they now stand, not the ones GitHub already has',
  )
  assert.deepEqual(sent.delivered, [one.id], 'and the draft is reported, so the view drops it')
})

test('a review that landed covers only the comments it actually posted', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    // GitHub takes the review and the response is lost, so the draft is never
    // acknowledged and the next submission has to reconcile it.
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  // Two comments go out together. The first is `A`, the second `B`.
  const a = draft({ id: 'src/app.ts:head:1-head:1#1', ref: at, body: 'first' })
  const b = draft({ id: 'src/app.ts:head:1-head:1#2', ref: at, body: 'second' })
  await assert.rejects(
    () =>
      submitReview(workspace.repo, 7, {
        event: 'COMMENT' as const,
        body: 'two nits',
        comparison: comparison(),
        drafts: [a, b],
      }),
    { name: 'ReviewOutcomeUnknownError' },
  )
  assert.equal(writes.length, 1, 'one review carried both comments')

  // The reviewer comes back. `A` is still the draft they composed, and it did
  // land. `B` was cleared with the first submission and they have written the
  // same words on the same line again, so it is a new comment that says exactly
  // what the old one said — and this time they mean to approve.
  const b2 = draft({ id: 'src/app.ts:head:1-head:1#3', ref: at, body: 'second' })
  const settled = await submitReview(workspace.repo, 7, {
    event: 'APPROVE' as const,
    body: 'fine now',
    comparison: comparison(),
    drafts: [a, b2],
  })

  // The view is told the identity of every comment that is now on GitHub: the
  // one that was already there, and the one this submission just posted. The
  // name that is not in it is the old `B`, which the landed review posted under
  // its own identity and which is nobody's draft now.
  assert.deepEqual(
    settled.delivered,
    [a.id, b2.id],
    'the comment that landed and the one just posted, each under its own identity',
  )
  assert.equal(writes.length, 2, 'and the new comment is posted as its own review')
  const posted = writes[1]?.body as { event: string; comments: Array<{ body: string }> }
  assert.equal(posted.event, 'APPROVE', 'the decision asked for now is the one GitHub records')
  assert.deepEqual(
    posted.comments.map((comment) => comment.body),
    ['second'],
    'carrying the comment that was not on GitHub, and not the one that was',
  )
})

test('a draft that never left still recovers after the app is reopened', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    // The review is created and then the response is lost, which is the one
    // failure a retry cannot make safely: the review is on GitHub already, and
    // posting again would duplicate every word of it.
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  // The same draft, journalled and then submitted: GitHub takes the review and
  // the response is lost. The draft was never acknowledged, so it is still the
  // reviewer's pending work — the same one, with the same identity, and the
  // recovery has to recognise it rather than post it a second time.
  const one = draft({ id: 'src/app.ts:head:1-head:1#1', ref: at, body: 'needs a name' })
  await writeReviewDrafts(workspace.repo, {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [one],
    updatedAt: '2026-09-23T10:00:00Z',
  })
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [one],
  }
  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  // Reopened, the draft is still pending and still carries the identity it was
  // written with.
  const reopened = await readReviewDrafts(
    workspace.repo,
    JOURNAL_OWNER.repo,
    JOURNAL_OWNER.viewer,
    7,
  )
  assert.equal(reopened?.drafts.length, 1, 'the draft survived the crash')
  assert.equal(reopened?.drafts[0]?.id, one.id, 'with the identity it was composed under')
  const recovered = await submitReview(workspace.repo, 7, submission)
  assert.deepEqual(
    recovered.delivered,
    [one.id],
    'the pending draft is reported as already on GitHub, not posted again',
  )
  assert.equal(writes.length, 1, 'and nothing new left the app')
})

test('a review GitHub accepted is not posted again after the view never hears', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const one = draft({ id: 'd1', ref: at, body: 'first' })
  const { transport, writes, editReview } = threadDouble({
    files: [apiFile({ patch })],
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [one],
  }
  // GitHub answered 201 and the review is on the pull request. The app is killed
  // here, before the view is told, so the draft is still in its payload and the
  // user still sees it as unsent.
  const accepted = await submitReview(workspace.repo, 7, submission)
  assert.equal(accepted.state, 'COMMENTED')
  assert.deepEqual(accepted.delivered, ['d1'])

  // GitHub's copy of the review is then edited on the web, so it no longer
  // matches the attempt that produced it. The only remaining evidence that the
  // comment is already there is the record of the write this app made — which is
  // why a settled write is kept rather than tidied away on the way out.
  editReview(Number(accepted.id), (review) => {
    review.body = 'edited on the web afterwards'
  })
  const again = await submitReview(workspace.repo, 7, submission)
  assert.deepEqual(
    again.delivered,
    ['d1'],
    'the review GitHub already holds is not written a second time',
  )
  assert.equal(writes.length, 1, 'and nothing new left the app')
})

test('a comment posted on the base side is recorded and matched as the base', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const patch = '@@ -1,3 +1,3 @@\n keep\n-removed\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const removed = hunk.lines.findIndex((line) => line.side === 'base' && line.oldLine !== null)
  const at = refFor(hunk, removed)
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'why is this going?' })],
  }
  const { transport, writes } = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => submitReview(workspace.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })
  // GitHub stored the comment as LEFT. A settlement that read that as a head
  // comment would not recognise its own attempt and would hold this forever.
  const second = await submitReview(workspace.repo, 7, submission)
  assert.equal(second.state, 'COMMENTED')
  assert.equal(writes.length, 1, 'a deletion comment is recognised as a deletion comment')
})

test('an uncertain record of another repository does not block this pull request', async (t) => {
  // One Git common directory with two origins, which is the case the journal
  // has to survive: the file is shared by both, so a pull request number is
  // only meaningful together with the repository it is a number in.
  const acme = await reviewWorkspace()
  t.after(acme.dispose)
  const linked = join(acme.repo, '..', 'linked')
  await writeFile(join(acme.repo, 'README.md'), 'acme\n')
  execFileSync('git', ['-C', acme.repo, 'add', 'README.md'], { encoding: 'utf8' })
  execFileSync('git', ['-C', acme.repo, 'commit', '-m', 'initial'], { encoding: 'utf8' })
  execFileSync('git', ['-C', acme.repo, 'worktree', 'add', '--detach', linked], {
    encoding: 'utf8',
  })
  // A linked worktree shares the repository's config, so the second origin is
  // per-worktree; setting it globally would change the first one's origin too.
  execFileSync('git', ['-C', linked, 'config', 'extensions.worktreeConfig', 'true'], {
    encoding: 'utf8',
  })
  execFileSync(
    'git',
    [
      '-C',
      linked,
      'config',
      '--worktree',
      'remote.origin.url',
      'https://github.com/other/place.git',
    ],
    { encoding: 'utf8' },
  )

  const patch = '@@ -1,2 +1,3 @@\n keep\n+added\n tail'
  const entry = file({ diff: { kind: 'text', hunks: hunks(patch) } })
  const hunk = textHunk(entry, 0)
  const added = hunk.lines.findIndex((line) => line.side === 'head' && line.newLine !== null)
  const at = refFor(hunk, added)
  const submission = {
    event: 'COMMENT' as const,
    body: '',
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: at, body: 'needs a name' })],
  }

  const first = threadDouble({
    files: [apiFile({ patch })],
    failReviewOnce: { status: 502, message: 'Bad Gateway' },
  })
  setGitHubTransport(first.transport)
  await assert.rejects(() => submitReview(acme.repo, 7, submission), {
    name: 'ReviewOutcomeUnknownError',
  })

  // The same pull request number and the same words against the other origin
  // are a different review, and are not blocked by the first one's record.
  const second = threadDouble({ files: [apiFile({ patch })] })
  setGitHubTransport(second.transport)
  t.after(() => setGitHubTransport(null))
  const result = await submitReview(linked, 7, submission)

  assert.equal(result.state, 'COMMENTED')
  assert.equal(second.writes.length, 1)
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

test("somebody else's identical words are not adopted as this account's reply", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // A collaborator has already written "Thanks" in this thread, so the body the
  // reviewer is about to send already appears in the conversation.
  const { transport, writes } = threadDouble({
    threads: [
      threadNode({
        id: 'PRRT_1',
        line: 12,
        comments: [{ id: 'C_0', author: 'grace', body: 'Thanks' }],
      }),
    ],
    fail: { addPullRequestReviewThreadReply: { status: 502, message: 'Bad Gateway' } },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => replyToThread(workspace.repo, 7, 'PRRT_1', 'Thanks'), {
    name: 'ReviewOutcomeUnknownError',
  })
  // Grace's comment is not this account's reply, and it predates the attempt in
  // any case, so the guard stands rather than reporting a success that never was.
  await assert.rejects(() => replyToThread(workspace.repo, 7, 'PRRT_1', 'Thanks'), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1, 'the reply was attempted once and never again')
})

test("a collaborator's identical reply inside the attempt window is not this account's", async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // The thread is empty, so the attempt's boundary contains nothing. After the
  // reply goes out, somebody else writes the same words — which is the only
  // thing in the thread that matches them, and it is not this account's reply.
  const { transport, writes } = threadDouble({
    threads: [threadNode({ id: 'PRRT_1', line: 12 })],
    collaboratorReply: { id: 'C_1', author: 'grace', body: 'Thanks' },
    fail: { addPullRequestReviewThreadReply: { status: 502, message: 'Bad Gateway' } },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => replyToThread(workspace.repo, 7, 'PRRT_1', 'Thanks'), {
    name: 'ReviewOutcomeUnknownError',
  })
  await assert.rejects(() => replyToThread(workspace.repo, 7, 'PRRT_1', 'Thanks'), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1, "somebody else's words are not this account's reply")
})

test('an older reply of this account is not adopted for a later attempt', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // This account said the same words earlier in the thread, before the attempt
  // that was lost. Adopting the old one would report a success the later
  // attempt never had and clear the composer for a reply nobody can see.
  const { transport, writes } = threadDouble({
    threads: [
      threadNode({
        id: 'PRRT_1',
        line: 12,
        comments: [{ id: 'C_0', author: 'ada', body: 'Thanks' }],
      }),
    ],
    fail: { addPullRequestReviewThreadReply: { status: 502, message: 'Bad Gateway' } },
  })
  setGitHubTransport(transport)
  t.after(() => setGitHubTransport(null))

  await assert.rejects(() => replyToThread(workspace.repo, 7, 'PRRT_1', 'Thanks'), {
    name: 'ReviewOutcomeUnknownError',
  })
  await assert.rejects(() => replyToThread(workspace.repo, 7, 'PRRT_1', 'Thanks'), {
    name: 'ReviewWriteUncertainError',
  })
  assert.equal(writes.length, 1)
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
  const reopened = await readReviewDrafts(
    workspace.repo,
    JOURNAL_OWNER.repo,
    JOURNAL_OWNER.viewer,
    7,
  )

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
  const entry = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') },
  })
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
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7))?.drafts[0]
      .body,
    'on seven',
  )
  assert.equal(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 8))?.drafts[0]
      .body,
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
  const entry = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') },
  })
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
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7))?.drafts[0]
      .body,
    'mine',
    'the account that wrote them still finds them',
  )
})

test('writing an empty list is what retires a sent review, so it is not offered again', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const entry = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') },
  })
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
  const entry = file({
    diff: { kind: 'text', hunks: hunks('@@ -1,2 +1,3 @@\n keep\n+added\n tail') },
  })
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

/** A draft anchor on one line of the example file, for journal-only assertions. */
function draftRef(line: number): ReviewLineRef {
  return {
    path: 'src/app.ts',
    line,
    side: 'head',
    hunkId: 'h1',
    anchor: 'anchor',
    context: 'context',
  }
}

// The draft journal lives in the Git common directory, so two windows of the app,
// two worktrees, or two machines sharing one repository all read and write one
// file. These tests use real child processes rather than concurrent promises
// here, because the guarantee being pinned cannot be produced inside a single
// process at all: an in-process queue would serialize two callers in one window
// and pass, while the second window the bug is about is a separate OS process
// that never sees the queue.
//
// LOCK_HOLDER_SCRIPT is a child that holds the journal's lock file the way a real
// writer does — created with its own live pid, released on request — so a write in
// another process has a genuine cross-process holder to contend with.
const LOCK_HOLDER_SCRIPT = `
import { rmSync, writeFileSync } from 'node:fs'
const journal = process.argv.at(-1)
writeFileSync(journal + '.lock', JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\\n')
process.stdout.write('locked\\n')
await new Promise((resolve) => process.stdin.once('data', resolve))
rmSync(journal + '.lock', { force: true })
process.stdout.write('released\\n')
`

/** A child process that writes one pull request's drafts in its own worktree. */
const DRAFT_WRITER_SCRIPT = `
const [modulePath, repo, number, body] = process.argv.slice(2)
const { writeReviewDrafts } = await import(modulePath)
await writeReviewDrafts(repo, {
  number: Number(number),
  repo: 'acme/widgets',
  viewer: 'ada',
  comparison: { headOid: 'a'.repeat(40), baseOid: 'b'.repeat(40), baseRef: 'main' },
  drafts: [
    {
      id: 'd1',
      ref: { path: 'src/app.ts', line: 3, side: 'head', anchor: 'a', context: 'c' },
      startRef: null,
      body,
      createdAt: '2026-09-23T10:00:00Z',
    },
  ],
  updatedAt: '2026-09-23T10:00:00Z',
})
process.stdout.write('written\\n')
`

/**
 * Waits for the lock a child process takes to exist and carry its owner, so the
 * wait is not a guess. The name appears before the holder has written itself
 * into it, and a lock read in that instant names no owner at all.
 */
async function waitForLock(journal: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(`${journal}.lock`) && (await readFile(`${journal}.lock`, 'utf8')).length > 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the lock holder never took the journal lock')
}

/** Writes a child script beside the repository it will be pointed at. */
function scriptPath(at: string, source: string): string {
  writeFileSync(at, source)
  return at
}

/** Runs `script` as its own OS process, with the repository source on its path. */
function journalChild(
  script: string,
  repo: string,
  args: readonly string[],
): { exited: Promise<void>; release: () => void; kill: () => void } {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const child = execFile(
    process.execPath,
    [
      '--import',
      fileURLToPath(import.meta.resolve('tsx')),
      scriptPath(join(repo, `journal-child-${randomUUID()}.mjs`), script),
      fileURLToPath(new URL('../src/main/review-drafts.ts', import.meta.url)),
      ...args,
    ],
    { encoding: 'utf8' },
    (error) => (error ? reject(error) : resolve()),
  )
  return {
    exited: promise,
    // Ending the stream rather than only writing to it: a child's stdin held
    // open by the parent is a live socket, and it would keep this process alive
    // long after the child itself has gone.
    release: () => {
      child.stdin?.end('release\n')
    },
    kill: () => child.kill('SIGKILL'),
  }
}

test('a journal update waits for the lock another process holds instead of publishing over it', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const journal = join(workspace.repo, '.git', 'git-stacks-review-drafts.json')
  await writeReviewDrafts(workspace.repo, {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: draftRef(3), body: 'before' })],
    updatedAt: '2026-09-23T10:00:00Z',
  })

  const holder = journalChild(LOCK_HOLDER_SCRIPT, workspace.repo, [journal])
  t.after(() => holder.kill())
  await waitForLock(journal)
  const pending = writeReviewDrafts(workspace.repo, {
    number: 8,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: draftRef(4), body: 'after' })],
    updatedAt: '2026-09-23T10:05:00Z',
  })

  // The holder is a live process, so its lock is not stale and must not be
  // broken. An unlocked journal would finish this write while the holder still
  // had it, and the record it published would then be exactly what the holder
  // overwrites when it releases.
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(
    await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 8),
    null,
    'a second process does not write the journal while another process holds it',
  )
  holder.release()

  await pending
  await holder.exited
  assert.equal(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7))?.drafts[0]
      ?.body,
    'before',
    'the record already on disk survives the wait',
  )
  assert.equal(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 8))?.drafts[0]
      ?.body,
    'after',
    'the blocked write lands once the lock is free',
  )
})

test('drafts written from another worktree and another process are both kept', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // A linked worktree resolves the same Git common directory, so this is the
  // second workspace of one repository finding the first one's journal.
  const linked = join(workspace.repo, '..', 'linked')
  execFileSync('git', ['-C', workspace.repo, 'worktree', 'add', '-b', 'other', linked], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => rm(linked, { recursive: true, force: true }))

  const fromLinked = journalChild(DRAFT_WRITER_SCRIPT, workspace.repo, [linked, '8', 'on eight'])
  const fromMain = journalChild(DRAFT_WRITER_SCRIPT, workspace.repo, [
    workspace.repo,
    '7',
    'on seven',
  ])
  t.after(() => {
    fromLinked.kill()
    fromMain.kill()
  })
  await Promise.all([fromLinked.exited, fromMain.exited])

  assert.equal(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7))?.drafts[0]
      ?.body,
    'on seven',
    'the main worktree keeps its own record',
  )
  assert.equal(
    (await readReviewDrafts(linked, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 8))?.drafts[0]?.body,
    'on eight',
    'the other worktree keeps the record it wrote, whichever process published last',
  )
})

test('a lock left behind by a killed window is refused, not taken from whoever holds it', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const journal = join(workspace.repo, '.git', 'git-stacks-review-drafts.json')
  await writeReviewDrafts(workspace.repo, {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: draftRef(3), body: 'before' })],
    updatedAt: '2026-09-23T10:00:00Z',
  })
  // A pid that cannot be running: the lock names a window that was killed, so
  // the lock outlived it.
  const abandoned = `${JSON.stringify({ pid: 0x7fffffff, at: '2026-09-23T10:00:00Z' })}\n`
  await writeFile(`${journal}.lock`, abandoned)

  await assert.rejects(
    () =>
      writeReviewDrafts(workspace.repo, {
        number: 8,
        repo: JOURNAL_OWNER.repo,
        viewer: JOURNAL_OWNER.viewer,
        comparison: comparison(),
        drafts: [draft({ id: 'd1', ref: draftRef(4), body: 'after' })],
        updatedAt: '2026-09-23T10:05:00Z',
      }),
    (error: Error) => {
      // The refusal has to be actionable: the reader is a person looking at an
      // error, and the one thing no process on disk can know is whether they
      // still have a window open.
      assert.ok(error.message.includes(journal), 'the refusal names the lock file')
      assert.match(error.message, /no longer running/)
      assert.match(error.message, /Close every Git Stacks window/)
      assert.match(error.message, /Nothing was written/)
      return true
    },
  )

  // Refusing is the whole behaviour: the lock is left exactly as it was found,
  // because a lock taken from a holder that might be alive is how a live window
  // ends up writing beside another one. And nothing was written on the way out.
  assert.equal(
    await readFile(`${journal}.lock`, 'utf8'),
    abandoned,
    'the abandoned lock is left in place rather than taken over',
  )
  // Reading needs no lock, so what was already journalled is still readable
  // while the lock stands — the refusal is about writing, not about access.
  assert.equal(
    (await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 7))?.drafts[0]
      ?.body,
    'before',
    'a refused write leaves the record that was already journalled alone',
  )
  assert.ok(
    (await readFile(journal, 'utf8')).includes('before'),
    'the record that was already journalled is still on disk, unchanged',
  )
})

test('a lock this build cannot read is refused rather than guessed at', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const journal = join(workspace.repo, '.git', 'git-stacks-review-drafts.json')
  // Not a lock this build wrote, so its owner is unknown — and an unknown owner
  // is a holder that might be alive.
  await writeFile(`${journal}.lock`, 'held by something else\n')

  await assert.rejects(
    () =>
      writeReviewDrafts(workspace.repo, {
        number: 7,
        repo: JOURNAL_OWNER.repo,
        viewer: JOURNAL_OWNER.viewer,
        comparison: comparison(),
        drafts: [draft({ id: 'd1', ref: draftRef(3), body: 'never sent' })],
        updatedAt: '2026-09-23T10:00:00Z',
      }),
    /whose owner cannot be identified/,
  )
  assert.equal(await readFile(`${journal}.lock`, 'utf8'), 'held by something else\n')
})

test('a lock that cannot be read at all refuses at once rather than spinning on it', {
  timeout: 10_000,
}, async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const journal = join(workspace.repo, '.git', 'git-stacks-review-drafts.json')
  await writeReviewDrafts(workspace.repo, {
    number: 7,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comparison: comparison(),
    drafts: [draft({ id: 'd1', ref: draftRef(3), body: 'before' })],
    updatedAt: '2026-09-23T10:00:00Z',
  })
  // The lock is there, and it is not something that can be read: a directory
  // where the protocol puts a file. A writer that treats "I could not read it"
  // as "it is not there" retries for ever against a lock that never goes away,
  // holding a window on a save that will never complete and saying nothing
  // about why. The one failure worth retrying is the lock being absent, which
  // means the holder let go.
  await mkdir(`${journal}.lock`)

  await assert.rejects(
    () =>
      writeReviewDrafts(workspace.repo, {
        number: 8,
        repo: JOURNAL_OWNER.repo,
        viewer: JOURNAL_OWNER.viewer,
        comparison: comparison(),
        drafts: [draft({ id: 'd2', ref: draftRef(4), body: 'after' })],
        updatedAt: '2026-09-23T10:05:00Z',
      }),
    (error: Error) => {
      // The refusal is bounded by the test's own timeout: a writer that retries
      // an unreadable lock never answers at all, and this is the assertion that
      // it answers.
      assert.ok(error.message.includes(`${journal}.lock`), 'the refusal names the lock file')
      assert.match(error.message, /a directory rather than a lock file/)
      assert.match(error.message, /Nothing was written/)
      assert.match(error.message, /Close every Git Stacks window/)
      return true
    },
  )

  // Nothing was taken, nothing was written, and what was already journalled is
  // exactly as it was.
  assert.ok(
    (await readFile(journal, 'utf8')).includes('before'),
    'the record already on disk is untouched',
  )
  assert.equal(
    await readReviewDrafts(workspace.repo, JOURNAL_OWNER.repo, JOURNAL_OWNER.viewer, 8),
    null,
    'and the refused save left no record of its own',
  )
})

/** An unresolved attempt exactly as a lost review response would record it. */
function uncertain(id: string, number: number): ReviewUncertainWrite {
  const comments: UncertainComment[] = [
    {
      draftId: `${id}#1`,
      path: 'src/app.ts',
      side: 'head',
      line: 3,
      startLine: null,
      startSide: null,
      body: id,
    },
  ]
  return {
    id,
    number,
    kind: 'review',
    summary: 'two nits',
    threadId: null,
    headOid: 'a'.repeat(40),
    comparison: comparison(),
    draftIds: [`${id}#1`],
    event: 'COMMENT',
    at: `2026-09-23T10:00:${String(number % 60).padStart(2, '0')}Z`,
    repo: JOURNAL_OWNER.repo,
    viewer: JOURNAL_OWNER.viewer,
    comments,
    boundary: { kind: 'complete', latestReviewId: null },
    threadCommentIds: [],
    settled: null,
  }
}

test('more than fifty unresolved writes are all retained, because each is the only guard', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  // Each record is the sole proof that one request went out. If it landed and the
  // record is gone, reopening that draft and retrying posts a second review
  // instead of reconciling the first — so nothing may be evicted to keep the
  // list short, however many accumulate.
  const total = 60
  for (let index = 0; index < total; index += 1) {
    await recordUncertainWrite(workspace.repo, uncertain(`attempt-${index}`, 7))
  }

  const writes = await readUncertainWrites(
    workspace.repo,
    JOURNAL_OWNER.repo,
    7,
    JOURNAL_OWNER.viewer,
  )

  assert.equal(
    writes.length,
    total,
    'every unresolved guard survives, including the ones past any former ceiling',
  )
  for (let index = 0; index < total; index += 1) {
    assert.ok(
      writes.some((entry) => entry.id === `attempt-${index}`),
      `the guard for attempt-${index} is still on disk`,
    )
  }
})

test('a settled write is still forgotten when its payload no longer carries it', async (t) => {
  const workspace = await reviewWorkspace()
  t.after(workspace.dispose)
  const write = uncertain('attempt-1', 7)
  await recordUncertainWrite(workspace.repo, write)
  await recordUncertainWrite(workspace.repo, {
    ...write,
    settled: { reviewId: '99', state: 'COMMENTED', url: null, at: '2026-09-23T10:01:00Z' },
  })
  assert.equal(
    (await readUncertainWrites(workspace.repo, JOURNAL_OWNER.repo, 7, JOURNAL_OWNER.viewer)).length,
    1,
    'precondition: the settled attempt is on disk as delivery evidence',
  )

  await retireSettledWrites(
    workspace.repo,
    JOURNAL_OWNER.repo,
    7,
    JOURNAL_OWNER.viewer,
    comparison(),
    [],
  )

  assert.deepEqual(
    await readUncertainWrites(workspace.repo, JOURNAL_OWNER.repo, 7, JOURNAL_OWNER.viewer),
    [],
    'an unanswered payload is what retires the evidence, and only that',
  )
})
