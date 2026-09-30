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
  setGitHubTransport,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type GitHubTransport,
} from '../src/main/github-transport'
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
  const reply = <T>(data: T): GitHubRestResponse<T> => ({
    status: 200,
    rateLimit: {
      limit: 5000,
      remaining: 5000,
      reset: new Date(0),
      resource: 'core',
      retryAfterSeconds: null,
    },
    data,
  })
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
