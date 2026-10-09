import type { DiffHunkLineKind, NativeStack, PullRequest, PullRequestStackMember } from './types'

/**
 * Which side of a pull request diff a line belongs to. `base` is the preimage the
 * pull request removes from, `head` is the postimage it proposes. GitHub's own
 * review-comment API calls these LEFT and RIGHT.
 */
export type ReviewSide = 'base' | 'head'

/** GitHub's own vocabulary for what a pull request did to one file. */
export type ReviewFileStatus =
  | 'added'
  | 'removed'
  | 'renamed'
  | 'copied'
  | 'modified'
  | 'changed'
  | 'unchanged'

/**
 * Why a file has no reviewable text.
 *
 * The pull-request files resource returns a per-file `patch` and simply omits it
 * when it declines to inline text, without saying why. The states below name what
 * Git Stacks can actually prove rather than inventing a reason:
 *
 *  - `text` — a patch arrived and the shared diff parser accepted every hunk.
 *  - `binary` — content independently identified as binary.
 *  - `no-text` — no patch and no changed text lines; this does not distinguish
 *    a rename, mode-only change, empty file, or binary content.
 *  - `too-large` — the entry counts added or removed lines yet still returned no
 *    patch, so GitHub had text it chose not to inline.
 *  - `unreadable` — a patch arrived and the shared diff parser refused part of
 *    it. Nothing here is rendered as if it had been understood.
 */
export type ReviewFileDiff =
  | { kind: 'text'; hunks: ReviewHunk[] }
  | { kind: 'binary' }
  | { kind: 'no-text' }
  | { kind: 'too-large' }
  | { kind: 'unreadable'; reason: string }

export interface ReviewLine {
  kind: DiffHunkLineKind
  /** The literal diff text including its leading marker and any trailing CR. */
  text: string
  oldLine: number | null
  newLine: number | null
  /**
   * The side this line is addressed on. A context line carries the same text and
   * the same number on both sides, so it is addressed on the head; a removed line
   * is addressed on the base; a marker line has no side at all.
   */
  side: ReviewSide | null
  /**
   * Content identity: the file path plus this line's text with its marker
   * removed. It does not depend on the line number, the hunk header, the
   * unified/split layout, or whether whitespace changes are hidden, so the same
   * line keeps its anchor after it moves.
   */
  anchor: string
  /**
   * `anchor` plus up to two neighbouring lines on each side within the hunk.
   * Context distinguishes exact from moved only when the same-side anchor is unique.
   */
  context: string
  /** True when this changed line differs from its counterpart only in spaces and tabs. */
  whitespaceOnly: boolean
}

export interface ReviewHunk {
  /**
   * The same identity the local staging surface uses, so one scheme covers a
   * remote review and a local stage rather than inventing a second one.
   */
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ReviewLine[]
}

export interface ReviewFile {
  /** GitHub's postimage path: the path a comment on this file is anchored to. */
  path: string
  /** The preimage path of a rename or copy; null when the file did not move. */
  previousPath: string | null
  status: ReviewFileStatus
  additions: number
  deletions: number
  changes: number
  /** GitHub's blob id for the postimage, or null when the file was removed. */
  sha: string | null
  /**
   * A local path heuristic. It is offered as a reading aid and never presented as
   * something GitHub reported.
   */
  generated: boolean
  diff: ReviewFileDiff
}

/** How one file's changes are laid out. */
export type ReviewDiffMode = 'unified' | 'split'

/**
 * The comparison a pull request's files are read against.
 *
 * The head alone does not identify a diff. GitHub computes the file list and the
 * patch between the merge base of the base and head and the head, so a push to
 * the base branch changes the diff with the head object untouched, and
 * retargeting the pull request to another base changes what the files are
 * measured against. A line number is an address only within one of these, so
 * every position a review remembers — a viewed mark, a draft, a comment — is
 * bound to the whole comparison and not to any one object in it.
 */
export interface ReviewComparison {
  /** The head commit. A line number is only an address at this commit. */
  headOid: string | null
  /** The tip of the base branch, which is half of what the diff is taken between. */
  baseOid: string | null
  /** The base branch's name. A retarget changes it even when both objects are the same. */
  baseRef: string | null
}

/**
 * Which part of a comparison moved.
 *
 * A caller says what happened rather than that something did: a base branch
 * rename leaves the diff provably identical, and reporting that the same way as
 * a force-push would train a reviewer to ignore the message that matters.
 */
export type ReviewComparisonDrift = 'none' | 'head' | 'base' | 'base-name' | 'unreadable'

export function reviewComparisonDrift(
  before: ReviewComparison,
  after: ReviewComparison,
): ReviewComparisonDrift {
  if (before.headOid === null || after.headOid === null) return 'unreadable'
  if (before.baseOid === null || after.baseOid === null) return 'unreadable'
  if (before.headOid !== after.headOid) return 'head'
  if (before.baseOid !== after.baseOid) return 'base'
  if (before.baseRef !== after.baseRef) return 'base-name'
  return 'none'
}

/** Two comparisons are the same only when every object and every name agrees. */
export function sameReviewComparison(a: ReviewComparison, b: ReviewComparison): boolean {
  return reviewComparisonDrift(a, b) === 'none'
}

export interface ReviewFileSet {
  number: number
  /**
   * The comparison this file set was read at, confirmed stable across the
   * paginated read. It is the comparison the displayed diff actually came from,
   * which is not always the one the headline reported.
   */
  comparison: ReviewComparison
  files: ReviewFile[]
  additions: number
  deletions: number
  /** GitHub refuses to page past a fixed number of files; say so instead of implying completeness. */
  truncated: boolean
}

export interface ReviewCommit {
  oid: string
  shortOid: string
  message: string
  author: string
  authoredAt: string
}

export interface ReviewCommitSet {
  commits: ReviewCommit[]
  /** GitHub's count at the confirmed comparison, or null when not provided. */
  total: number | null
  truncated: boolean
}

/**
 * The durable identity of one line in a pull request diff.
 *
 * GitHub addresses a review comment by `path`, a `line`, and a `side`. A line
 * number is an address, not an identity: a force-push that inserts one line above
 * moves every line below it, and a moved hunk renumbers everything it contains.
 * A reference therefore carries both forms, and only the content form may be
 * re-resolved against a newer head.
 */
export interface ReviewLineRef {
  path: string
  side: ReviewSide
  /** The line number within that side of the file, valid at the head it was read from. */
  line: number
  /** The containing hunk's identity, from the shared `hunkId` scheme. */
  hunkId: string
  /** Content identity; survives movement. */
  anchor: string
  /** Content identity plus neighbourhood; disambiguates repeated lines. */
  context: string
}

export type ReviewAnchorMatch = 'exact' | 'moved' | 'unresolved'

/** The outcome of re-resolving a stored reference against a freshly read file set. */
export interface ReviewAnchorResolution {
  match: ReviewAnchorMatch
  /** Present whenever the line was found; carries the position it now occupies. */
  ref: ReviewLineRef | null
  /** Why an unresolved reference could not be re-anchored, in words a reviewer can act on. */
  reason: string
}

/** Bounded readonly facts, independently unknown when the host omitted them. */
export interface ReviewStackMemberFacts {
  number: number
  state: 'available' | 'partial' | 'stale' | 'unavailable'
  title: string | null
  lifecycle: 'OPEN' | 'CLOSED' | 'MERGED' | null
  draft: boolean | null
  checks: 'passing' | 'failing' | 'pending' | 'none' | 'unknown'
  review: 'approved' | 'changes-requested' | 'required' | 'none' | 'unknown'
  message: string
}

/**
 * Which layers of the pull request's native stack sit directly above and below it.
 * `null` on either side is a real boundary of the stack, not missing data.
 */
export interface ReviewStackRail {
  state: 'member' | 'not-stacked' | 'unavailable'
  stack: NativeStack | null
  previous: PullRequestStackMember | null
  next: PullRequestStackMember | null
  /** Empty only when the rail is complete; otherwise the reason it is not. */
  message: string
  /** Missing entries were outside the metadata budget, not absent from the stack. */
  facts?: ReviewStackMemberFacts[]
}

export interface ReviewReviewerSummary {
  state: 'available' | 'partial' | 'unavailable'
  requested: Array<{ kind: 'user' | 'team'; name: string }>
  reviews: Array<{
    login: string
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
    headOid: string | null
  }>
  /** Explains missing or bounded data; empty only when both lists are complete. */
  message: string
}

export interface ReviewHeadline {
  pullRequest: PullRequest & { body: string }
  rail: ReviewStackRail
  reviewers: ReviewReviewerSummary
}

/**
 * Which files of one pull request a person has opened, recorded locally and bound
 * to the comparison it was recorded at. A moved comparison makes the record stale
 * rather than wrong: the marks are dropped instead of claimed for a diff nobody
 * looked at. Binding to the head alone would let them survive a base retarget,
 * where the files are now entirely different changes.
 */
export interface ReviewViewedRecord {
  number: number
  comparison: ReviewComparison
  paths: string[]
  updatedAt: string
}

export const REVIEW_VIEWED_MAX_RECORDS = 50

export type ReviewChangeBlock =
  | { kind: 'change'; removes: number[]; adds: number[] }
  | { kind: 'single'; index: number }

/**
 * Groups a hunk's lines into context runs and changed runs.
 *
 * A changed run is the unit both the whitespace filter and the split layout need:
 * Git emits a run of `-` lines next to the run of `+` lines that replaced them,
 * and pairing them by position inside the run is what makes "the same line with
 * different indentation" a whitespace change rather than a rewrite. Indexes are
 * positions in `lines`, and a run whose two sides do not line up keeps the
 * unmatched lines on their own rather than pairing them with nothing.
 */
export function reviewChangeBlocks(
  lines: readonly { kind: DiffHunkLineKind }[],
): ReviewChangeBlock[] {
  const blocks: ReviewChangeBlock[] = []
  let run: number[] = []
  const flush = () => {
    if (run.length === 0) return
    const removes = run.filter((index) => lines[index].kind === 'remove')
    const adds = run.filter((index) => lines[index].kind === 'add')
    if (removes.length > 0 && adds.length > 0) {
      blocks.push({ kind: 'change', removes, adds })
    } else {
      // A run of only removals or only additions has no counterpart to pair
      // with, so each line keeps its own block rather than the run pretending
      // one side is missing text. One block for the whole run would drop every
      // line after the first: a newly added file is a single pure run, and the
      // split layout iterates blocks, so it would show one line of a hundred.
      for (const index of run) blocks.push({ kind: 'single', index })
    }
    run = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const kind = lines[index].kind
    if (kind === 'add' || kind === 'remove') {
      run.push(index)
      continue
    }
    flush()
    blocks.push({ kind: 'single', index })
  }
  flush()
  return blocks
}

/** The line's content with its diff marker removed, so a role change is not a text change. */
export function reviewLineContent(text: string): string {
  return text.length === 0 ? text : text.slice(1)
}

/**
 * Whether a changed line and its counterpart are the same once every space and
 * tab is removed. This is the comparison Git's own `--ignore-all-space` makes,
 * and it is what the pull-request files resource's `patch` can support: the API
 * has no whitespace option for a pull request diff, so hiding whitespace changes
 * is a presentation decision over text GitHub already sent, not a second fetch.
 *
 * Line endings are deliberately kept: a CRLF conversion is a change a reviewer
 * needs to see, not incidental whitespace.
 */
export function isWhitespaceOnlyChange(a: string, b: string): boolean {
  // The markers are compared only after they are removed: a removed line and an
  // added line always differ in their first character, so comparing the raw text
  // would make every pair a real change.
  const contentA = reviewLineContent(a)
  const contentB = reviewLineContent(b)
  if (contentA === contentB) return false
  return withoutHorizontalWhitespace(contentA) === withoutHorizontalWhitespace(contentB)
}

function withoutHorizontalWhitespace(text: string): string {
  let out = ''
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\u000b' || ch === '\f') continue
    out += ch
  }
  return out
}

export interface ReviewRowOptions {
  hideWhitespace: boolean
}

/** One rendered line of a unified diff, carrying the identity a comment would anchor to. */
export type ReviewUnifiedRow =
  | { kind: 'hunk'; hunkId: string; header: string; hidden: number }
  | {
      kind: 'line'
      hunkId: string
      line: ReviewLine
      /** The line number on `line.side`, or null for a marker line. */
      number: number | null
    }

export interface ReviewSplitCell {
  line: ReviewLine
  number: number
}

export type ReviewSplitRow =
  | { kind: 'hunk'; hunkId: string; header: string; hidden: number }
  | { kind: 'split'; hunkId: string; left: ReviewSplitCell | null; right: ReviewSplitCell | null }

/**
 * Flattens a file's hunks into unified rows. Whitespace-only changes are dropped
 * as a pair, and the header keeps Git's own text so the hidden count can be
 * reported against something the reader can verify.
 */
export function reviewUnifiedRows(
  hunks: readonly ReviewHunk[],
  options: ReviewRowOptions,
): ReviewUnifiedRow[] {
  const rows: ReviewUnifiedRow[] = []
  for (const hunk of hunks) {
    let hidden = 0
    // Collected per hunk so the header can be placed directly in front of the
    // lines it introduces. Prepending to the whole file instead would put the
    // last hunk's header above the first hunk's lines, and the second hunk would
    // have no separator introducing it at all.
    const hunkRows: ReviewUnifiedRow[] = []
    for (const line of hunk.lines) {
      if (options.hideWhitespace && line.whitespaceOnly) {
        hidden += 1
        continue
      }
      hunkRows.push({ kind: 'line', hunkId: hunk.id, line, number: sideNumber(line) })
    }
    if (hidden > 0 || hunk.lines.length > 0) {
      rows.push({ kind: 'hunk', hunkId: hunk.id, header: hunk.header, hidden })
      for (const row of hunkRows) rows.push(row)
    }
  }
  return rows
}

function sideNumber(line: ReviewLine): number | null {
  if (line.side === 'base') return line.oldLine
  if (line.side === 'head') return line.newLine
  return null
}

/**
 * Lays the same hunks out side by side. Changed runs pair by position, so a run
 * with more removals than additions leaves the extra removals on their own rows
 * rather than shifting content against the wrong line.
 */
export function reviewSplitRows(
  hunks: readonly ReviewHunk[],
  options: ReviewRowOptions,
): ReviewSplitRow[] {
  const rows: ReviewSplitRow[] = []
  for (const hunk of hunks) {
    let hidden = 0
    const hunkRows: ReviewSplitRow[] = []
    for (const block of reviewChangeBlocks(hunk.lines)) {
      if (block.kind === 'single') {
        const line = hunk.lines[block.index]
        if (line.side === 'base') {
          if (options.hideWhitespace && line.whitespaceOnly) {
            hidden += 1
            continue
          }
          hunkRows.push({
            kind: 'split',
            hunkId: hunk.id,
            left: { line, number: line.oldLine ?? 0 },
            right: null,
          })
        } else if (line.side === 'head') {
          if (options.hideWhitespace && line.whitespaceOnly) {
            hidden += 1
            continue
          }
          hunkRows.push({
            kind: 'split',
            hunkId: hunk.id,
            left: null,
            right: { line, number: line.newLine ?? 0 },
          })
        } else {
          hunkRows.push({ kind: 'split', hunkId: hunk.id, left: null, right: null })
        }
        continue
      }
      const pairs = Math.max(block.removes.length, block.adds.length)
      for (let step = 0; step < pairs; step += 1) {
        const removeIndex = block.removes[step]
        const addIndex = block.adds[step]
        const remove = removeIndex === undefined ? null : hunk.lines[removeIndex]
        const add = addIndex === undefined ? null : hunk.lines[addIndex]
        if (options.hideWhitespace && (remove?.whitespaceOnly || add?.whitespaceOnly)) {
          hidden += 1
          continue
        }
        hunkRows.push({
          kind: 'split',
          hunkId: hunk.id,
          left: remove ? { line: remove, number: remove.oldLine ?? 0 } : null,
          right: add ? { line: add, number: add.newLine ?? 0 } : null,
        })
      }
    }
    if (hunk.lines.length > 0) {
      rows.push({ kind: 'hunk', hunkId: hunk.id, header: hunk.header, hidden })
      for (const row of hunkRows) rows.push(row)
    }
  }
  return rows
}

const GENERATED_SEGMENTS: Record<string, true> = {
  dist: true,
  build: true,
  out: true,
  coverage: true,
  node_modules: true,
  vendor: true,
  target: true,
  generated: true,
  __generated__: true,
  __snapshots__: true,
}

const GENERATED_BASENAMES: Record<string, true> = {
  'package-lock.json': true,
  'npm-shrinkwrap.json': true,
  'yarn.lock': true,
  'pnpm-lock.yaml': true,
  'bun.lockb': true,
  'poetry.lock': true,
  'cargo.lock': true,
  'go.sum': true,
  'composer.lock': true,
  'gemfile.lock': true,
  'flake.lock': true,
  'pubspec.lock': true,
}

const GENERATED_PATTERNS: readonly RegExp[] = [
  /\.min\.(?:js|css)$/iu,
  /\.generated\.[a-z0-9]+$/iu,
  /\.pb\.go$/iu,
  /\.pb\.cc$/iu,
  /\.pb\.h$/iu,
  /_pb2(?:_grpc)?\.py$/iu,
  /\.g\.dart$/iu,
  /\.snap$/iu,
  /\.designer\.cs$/iu,
]

/**
 * A conservative, local guess at whether a path holds machine-written output.
 *
 * GitHub does not report this, so the answer is a reading aid shown as such, and
 * it never changes what is rendered: a generated file with a patch still gets a
 * patch.
 */
export function looksGenerated(path: string): boolean {
  const segments = path.split('/')
  const basename = segments[segments.length - 1] ?? ''
  if (GENERATED_BASENAMES[basename] === true) return true
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(basename))) return true
  return segments.slice(0, -1).some((segment) => GENERATED_SEGMENTS[segment] === true)
}

const STATUS_LETTERS: Record<ReviewFileStatus, string> = {
  added: 'A',
  removed: 'D',
  renamed: 'R',
  copied: 'C',
  modified: 'M',
  changed: 'M',
  unchanged: '·',
}

export const REVIEW_STATUS_LABELS: Record<ReviewFileStatus, string> = {
  added: 'Added',
  removed: 'Removed',
  renamed: 'Renamed',
  copied: 'Copied',
  modified: 'Modified',
  changed: 'Modified',
  unchanged: 'Unchanged',
}

export function reviewStatusLetter(status: ReviewFileStatus): string {
  return STATUS_LETTERS[status]
}

export type ReviewFileRow =
  | {
      kind: 'directory'
      id: string
      path: string
      name: string
      depth: number
      additions: number
      deletions: number
      fileCount: number
    }
  | {
      kind: 'file'
      id: string
      path: string
      name: string
      depth: number
      file: ReviewFile
      /** Set when this file has been opened at the head the marks were recorded for. */
      viewed: boolean
    }

/**
 * Builds the file tree: directories in path order with their files beneath them,
 * Search happens before this, on the file list, so a match on the preimage path
 * of a rename still finds the file it became.
 */
export function reviewFileRows(files: readonly ReviewFile[]): ReviewFileRow[] {
  const root: ReviewDirectory = { path: '', name: '', depth: 0, directories: new Map(), files: [] }
  for (const file of files) {
    const segments = file.path.split('/')
    let group = root
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const path = segments.slice(0, depth + 1).join('/')
      let next = group.directories.get(path)
      if (!next) {
        next = {
          path,
          name: segments[depth],
          depth: depth + 1,
          directories: new Map(),
          files: [],
        }
        group.directories.set(path, next)
      }
      group = next
    }
    group.files.push(file)
  }

  const rows: ReviewFileRow[] = []
  const walk = (group: ReviewDirectory) => {
    for (const directory of [...group.directories.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      const totals = directoryTotals(directory)
      rows.push({
        kind: 'directory',
        id: `dir:${directory.path}`,
        path: directory.path,
        name: directory.name,
        depth: directory.depth,
        additions: totals.additions,
        deletions: totals.deletions,
        fileCount: totals.count,
      })
      walk(directory)
    }
    for (const file of [...group.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({
        kind: 'file',
        id: `file:${file.path}`,
        path: file.path,
        name: file.path.split('/').pop() ?? file.path,
        depth: group.depth,
        file,
        viewed: false,
      })
    }
  }
  walk(root)
  return rows
}

interface ReviewDirectory {
  path: string
  name: string
  depth: number
  directories: Map<string, ReviewDirectory>
  files: ReviewFile[]
}

function directoryTotals(directory: ReviewDirectory): {
  additions: number
  deletions: number
  count: number
} {
  let additions = 0
  let deletions = 0
  let count = 0
  for (const file of directory.files) {
    additions += file.additions
    deletions += file.deletions
    count += 1
  }
  for (const child of directory.directories.values()) {
    const totals = directoryTotals(child)
    additions += totals.additions
    deletions += totals.deletions
    count += totals.count
  }
  return { additions, deletions, count }
}

/**
 * Hides the rows under a collapsed directory and marks which files have been
 * opened. Collapsing and the viewed mark are view concerns, so they are applied
 * to the tree rather than baked into it.
 */
export function visibleReviewFileRows(
  rows: readonly ReviewFileRow[],
  collapsed: ReadonlySet<string>,
  viewed: ReadonlySet<string>,
): ReviewFileRow[] {
  const hidden: string[] = []
  return rows.reduce<ReviewFileRow[]>((kept, row) => {
    while (hidden.length > 0 && !row.path.startsWith(`${hidden[hidden.length - 1]}/`)) {
      hidden.pop()
    }
    if (hidden.length > 0) return kept
    if (row.kind === 'directory') {
      if (collapsed.has(row.path)) hidden.push(row.path)
      kept.push(row)
      return kept
    }
    kept.push({ ...row, viewed: viewed.has(row.path) })
    return kept
  }, [])
}

/**
 * The next or previous file in review order, or null at the ends of the list.
 * Order is the tree order, so "next file" continues where the tree left off
 * instead of jumping between directories.
 */
export function adjacentReviewFileIndex(
  paths: readonly string[],
  current: string,
  direction: 1 | -1,
): string | null {
  const index = paths.indexOf(current)
  if (index === -1) return null
  const next = index + direction
  if (next < 0 || next >= paths.length) return null
  return paths[next]
}

/**
 * The native stack layer directly above or below `number`. The top and bottom of
 * a stack are boundaries, not missing data, so a person at either end gets null
 * rather than a wrap-around.
 */
export function adjacentStackLayer(
  members: readonly PullRequestStackMember[],
  number: number,
  direction: 1 | -1,
): PullRequestStackMember | null {
  const ordered = [...members].sort((a, b) => a.position - b.position)
  const index = ordered.findIndex((member) => member.number === number)
  if (index === -1) return null
  const next = index + direction
  if (next < 0 || next >= ordered.length) return null
  return ordered[next]
}

/**
 * Records a file as viewed. The record is bound to the comparison it was made at,
 * so a force-push or a base retarget drops the marks rather than carrying them
 * onto a diff nobody looked at.
 */
export function withViewedFile(
  record: ReviewViewedRecord | null,
  number: number,
  comparison: ReviewComparison,
  path: string,
  now: string,
): ReviewViewedRecord {
  const current =
    record && record.number === number && sameReviewComparison(record.comparison, comparison)
      ? record
      : { number, comparison, paths: [], updatedAt: now }
  return {
    number,
    comparison,
    paths: current.paths.includes(path) ? current.paths : [...current.paths, path],
    updatedAt: now,
  }
}

/**
 * The marks recorded for one pull request at one comparison, or none at any
 * other. A `null` comparison means the file set has not been read yet, so there
 * is no revision the marks could be about and none are reported.
 */
export function viewedPaths(
  record: ReviewViewedRecord | null,
  number: number,
  comparison: ReviewComparison | null,
): string[] {
  if (!record || record.number !== number || comparison === null) return []
  if (!sameReviewComparison(record.comparison, comparison)) return []
  return record.paths
}

export interface ReviewFileSummary {
  additions: number
  deletions: number
  changed: number
  text: number
  binary: number
  unavailable: number
}

/** Counts what a file set contains, so the header can say more than "loaded". */
export function summarizeReviewFiles(files: readonly ReviewFile[]): ReviewFileSummary {
  const summary: ReviewFileSummary = {
    additions: 0,
    deletions: 0,
    changed: 0,
    text: 0,
    binary: 0,
    unavailable: 0,
  }
  for (const file of files) {
    summary.additions += file.additions
    summary.deletions += file.deletions
    if (file.changes > 0) summary.changed += 1
    if (file.diff.kind === 'text') summary.text += 1
    else if (file.diff.kind === 'binary') summary.binary += 1
    else summary.unavailable += 1
  }
  return summary
}

/** The one-line reason a file has no text, in words that name what GitHub did. */
export function reviewDiffStateLabel(file: ReviewFile): string {
  switch (file.diff.kind) {
    case 'text':
      return 'Text diff'
    case 'binary':
      return 'Binary file — GitHub counts changed bytes, not text lines'
    case 'no-text':
      return file.status === 'renamed'
        ? 'Renamed file — GitHub supplied no text diff'
        : 'No text diff — this can be a metadata-only or binary change'
    case 'too-large':
      return 'Diff too large for GitHub to inline — open the file on GitHub'
    case 'unreadable':
      return file.diff.reason
  }
}
