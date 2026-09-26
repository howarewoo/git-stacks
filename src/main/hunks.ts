import { createHash } from 'node:crypto'

import type { DiffHunk, DiffHunkLine, HunkSideName } from '../shared/types'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u
const MARKER: DiffHunkLine['kind'] = 'marker'

export type HunkBlockKind =
  | 'content'
  | 'rename'
  | 'copy'
  | 'new-file'
  | 'deleted-file'
  | 'mode-only'
  | 'binary'
  | 'unreadable'
  | 'empty'

export interface HunkBlock {
  /** The `diff --git` block header verbatim, so a patch keeps Git's own identity. */
  header: string[]
  hunks: DiffHunk[]
  oldPath: string | null
  newPath: string | null
  kind: HunkBlockKind
}

export interface HunkFileIdentity {
  path: string
  originalPath: string | null
}

export interface HunkFacts {
  binary: boolean
  truncated: boolean
  conflicted: boolean
  untracked: boolean
  /** The index carries a rename for this file, so the staged side moves both paths at once. */
  renamed: boolean
  changed: boolean
}

function splitLines(text: string): string[] {
  const lines = text ? text.split('\n') : []
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Git ends a `---`/`+++` path at the first tab, which is how it separates a path
 * containing spaces from the timestamp column.
 */
function diffPath(value: string): string | null {
  const tab = value.indexOf('\t')
  const raw = (tab === -1 ? value : value.slice(0, tab)).trimEnd()
  if (raw === '/dev/null') return null
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2)
  return raw
}

/**
 * A hunk id is derived from the file identity and the exact hunk text, so it stays
 * the same while the hunk is unchanged and differs once the hunk moves or edits.
 */
export function hunkId(
  identity: HunkFileIdentity,
  header: string,
  lines: readonly DiffHunkLine[],
): string {
  const hash = createHash('sha256')
  hash.update(`${identity.path}\u0000${identity.originalPath ?? ''}\u0000${header}\u0000`)
  for (const line of lines) hash.update(`${line.kind}\u0001${line.text}\u0001`)
  return hash.digest('hex').slice(0, 16)
}

function parseHunkBody(
  identity: HunkFileIdentity,
  headerLine: string,
  body: string[],
): DiffHunk | null {
  const match = HUNK_HEADER.exec(headerLine)
  if (!match) return null
  const oldStart = Number(match[1])
  const newStart = Number(match[3])
  const lines: DiffHunkLine[] = []
  // The counters hold the last line already consumed, so the first line of the hunk
  // sits exactly at the start the header names.
  let oldBefore = oldStart - 1
  let newBefore = newStart - 1
  for (const text of body) {
    if (
      text === '\\ No newline at end of file' &&
      lines.length > 0 &&
      lines[lines.length - 1].kind !== MARKER
    ) {
      lines.push({ kind: MARKER, text, oldLine: null, newLine: null })
    } else if (text.startsWith('+')) {
      lines.push({ kind: 'add', text, oldLine: null, newLine: newBefore + 1 })
      newBefore += 1
    } else if (text.startsWith('-')) {
      lines.push({ kind: 'remove', text, oldLine: oldBefore + 1, newLine: null })
      oldBefore += 1
    } else if (text.startsWith(' ') || text === '') {
      lines.push({ kind: 'context', text, oldLine: oldBefore + 1, newLine: newBefore + 1 })
      oldBefore += 1
      newBefore += 1
    } else {
      return null
    }
  }
  const oldLines = oldBefore - oldStart + 1
  const newLines = newBefore - newStart + 1
  if (oldLines !== Number(match[2] ?? 1) || newLines !== Number(match[4] ?? 1)) return null
  return {
    id: hunkId(identity, headerLine, lines),
    header: headerLine,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines,
  }
}

/**
 * A mode, rename or copy change is a property of the whole file, so it is read from
 * the block header before any hunk. A diff that carries hunk headers this parser
 * cannot verify is `unreadable` rather than a change that happens to have no hunks.
 */
function blockKind(
  header: string[],
  oldPath: string | null,
  newPath: string | null,
  hunks: DiffHunk[],
  hunkHeaders: number,
): HunkBlockKind {
  if (headerSays(header, 'rename from ') || headerSays(header, 'rename to ')) return 'rename'
  if (headerSays(header, 'copy from ') || headerSays(header, 'copy to ')) return 'copy'
  if (
    headerSays(header, 'GIT binary patch') ||
    headerSays(header, 'Binary files ') ||
    headerSays(header, 'Files ')
  ) {
    return 'binary'
  }
  if (headerSays(header, 'new file mode')) return 'new-file'
  if (headerSays(header, 'deleted file mode')) return 'deleted-file'
  if (hunkHeaders !== hunks.length) return 'unreadable'
  if (hunks.length > 0) return 'content'
  if (headerSays(header, 'old mode') || headerSays(header, 'new mode')) return 'mode-only'
  if (!oldPath && newPath) return 'new-file'
  if (oldPath && !newPath) return 'deleted-file'
  if (oldPath || newPath) return 'mode-only'
  return 'empty'
}

function headerSays(header: string[], prefix: string): boolean {
  return header.some((line) => line.startsWith(prefix))
}

/**
 * A block can change no text at all, which leaves Git nothing but a `diff --git`
 * line to identify it by. A block with no hunks can only shape a refusal message,
 * so matching that line against the requested path is enough.
 */
function gitLineNamesPath(header: string[], identity: HunkFileIdentity): boolean {
  const line = header.find((entry) => entry.startsWith('diff --git '))
  if (!line) return false
  return line.includes(` a/${identity.path}`) || line.includes(` b/${identity.path}`)
}

/**
 * Parses the file block of a path-limited unified diff. A block whose paths do not
 * belong to the requested file is ignored, and an unparsable block yields no hunks,
 * so a patch is never built from text this module did not understand.
 */
export function parseHunkBlock(diff: string, identity: HunkFileIdentity): HunkBlock {
  const blocks: string[][] = []
  for (const line of splitLines(diff)) {
    if (line.startsWith('diff --git ')) blocks.push([line])
    else if (blocks.length > 0) blocks[blocks.length - 1].push(line)
  }
  let matched: HunkBlock | null = null
  for (const block of blocks) {
    const header: string[] = []
    const bodies: { header: string; body: string[] }[] = []
    let oldPath: string | null = null
    let newPath: string | null = null
    for (const line of block) {
      if (bodies.length === 0 && !line.startsWith('@@ ')) {
        header.push(line)
        if (line.startsWith('--- ')) oldPath = diffPath(line.slice(4))
        if (line.startsWith('+++ ')) newPath = diffPath(line.slice(4))
        continue
      }
      if (line.startsWith('@@ ')) bodies.push({ header: line, body: [] })
      else bodies[bodies.length - 1]?.body.push(line)
    }
    const belongs =
      newPath === identity.path ||
      oldPath === identity.path ||
      (identity.originalPath !== null && oldPath === identity.originalPath) ||
      (oldPath === null && newPath === null && gitLineNamesPath(header, identity))
    if (!belongs) continue
    const hunks: DiffHunk[] = []
    for (const entry of bodies) {
      const hunk = parseHunkBody(identity, entry.header, entry.body)
      if (hunk) hunks.push(hunk)
    }
    if (matched) return { header: [], hunks: [], oldPath: null, newPath: null, kind: 'empty' }
    matched = {
      header,
      hunks,
      oldPath,
      newPath,
      kind: blockKind(header, oldPath, newPath, hunks, bodies.length),
    }
  }
  return matched ?? { header: [], hunks: [], oldPath: null, newPath: null, kind: 'empty' }
}

/**
 * Explains why a side cannot be patched hunk by hunk, or `null` when it can. The
 * view and the action share this, so the refusal a user reads is the refusal that
 * stops the write.
 */
export function hunkSideUnavailable(
  side: HunkSideName,
  block: HunkBlock,
  facts: HunkFacts,
): string | null {
  if (facts.conflicted) return 'Resolve this conflict before applying individual hunks.'
  if (facts.renamed) {
    return 'A rename is staged or unstaged as a whole file so both paths stay consistent.'
  }
  if (facts.untracked) {
    return 'An untracked file is staged as a whole file; there is no index hunk to apply yet.'
  }
  if (facts.binary) return 'This file is binary, so it cannot be patched hunk by hunk.'
  if (facts.truncated) {
    return 'This diff is too large to apply safely. Stage or unstage the whole file instead.'
  }
  if (block.kind === 'rename') {
    return 'A rename is staged or unstaged as a whole file so both paths stay consistent.'
  }
  if (block.kind === 'copy') {
    return 'A copy is staged or unstaged as a whole file so both paths stay consistent.'
  }
  if (block.kind === 'new-file') {
    return side === 'staged'
      ? 'A newly added file is unstaged as a whole file; patching part of it would leave it half-added.'
      : 'A newly added file has no working-tree hunks until it is unstaged as a whole file.'
  }
  if (block.kind === 'deleted-file') {
    return 'A file deletion is staged or unstaged as a whole file; Git cannot remove part of one.'
  }
  if (block.kind === 'mode-only') {
    return 'This change is a mode or link change with no text hunks; stage the whole file instead.'
  }
  if (block.kind === 'empty') {
    return facts.changed
      ? 'This side of the file has no text hunks; stage or unstage the whole file instead.'
      : side === 'staged'
        ? 'Nothing is staged in this file yet.'
        : 'The working tree matches the index for this file.'
  }
  if (block.kind === 'unreadable') {
    return 'This diff could not be read safely; stage or unstage the whole file instead.'
  }
  return null
}

/**
 * Line numbers for a split hunk. The preimage is anchored on the first line the
 * window keeps on the old side, and the postimage on the first line it keeps on
 * the new side, so Git verifies the window against the index even when the window
 * opens with an addition.
 */
function windowHeader(lines: readonly DiffHunkLine[], from: number, to: number): string {
  let oldStart = -1
  let newStart = -1
  let oldCount = 0
  let newCount = 0
  for (let index = from; index <= to; index += 1) {
    const line = lines[index]
    if (line.kind === 'context' || line.kind === 'remove') {
      if (oldStart === -1) oldStart = line.oldLine ?? 0
      oldCount += 1
    }
    if (line.kind === 'context' || line.kind === 'add') {
      if (newStart === -1) newStart = line.newLine ?? 0
      newCount += 1
    }
  }
  // A window that keeps nothing on one side still records where it sits.
  const old = oldStart === -1 ? (lines[from].oldLine ?? 0) : oldStart
  const next = newStart === -1 ? (lines[from].newLine ?? 0) : newStart
  return `@@ -${old},${oldCount} +${next},${newCount} @@`
}

/**
 * Builds the patch for one hunk. Without a line selection Git's own hunk text is
 * passed through unchanged; with one, the selection becomes sub-hunks that carry
 * recomputed line numbers plus the context and no-newline markers they need.
 */
export function buildHunkPatch(block: HunkBlock, hunk: DiffHunk, lineIndexes?: number[]): string {
  const lines = hunk.lines
  // A text hunk and chmod can share a diff block. Applying Git's mode headers
  // would stage the chmod too, so keep only the content-bearing file header.
  const header = block.header.filter(
    (line) => !line.startsWith('old mode ') && !line.startsWith('new mode '),
  )
  const verbatim = () => `${[...header, hunk.header, ...lines.map((l) => l.text)].join('\n')}\n`
  if (!lineIndexes || lineIndexes.length === 0) return verbatim()

  const selected = new Set(lineIndexes)
  const changeIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.kind === 'add' || entry.line.kind === 'remove')
    .map((entry) => entry.index)
  if (changeIndexes.length > 0 && changeIndexes.every((index) => selected.has(index))) {
    return verbatim()
  }

  // A run spans the selected changes that no unselected change separates; context
  // between them is shared, and a gap in the selected changes starts a new hunk.
  const runs: { from: number; to: number }[] = []
  for (const index of changeIndexes) {
    if (!selected.has(index)) continue
    const last = runs[runs.length - 1]
    const separated = last
      ? lines
          .slice(last.to + 1, index)
          .some((line) => line.kind === 'add' || line.kind === 'remove')
      : true
    if (last && !separated) last.to = index
    else runs.push({ from: index, to: index })
  }
  if (runs.length === 0) throw new Error('Select at least one changed line before applying a hunk')

  const body: string[] = []
  for (const run of runs) {
    // Anchor each run with the adjacent context lines, then keep the
    // no-newline marker of every line the run includes.
    const from = run.from > 0 && lines[run.from - 1].kind === 'context' ? run.from - 1 : run.from
    let to = run.to
    while (to + 1 < lines.length && lines[to + 1].kind === 'context') to += 1
    while (to + 1 < lines.length && lines[to + 1].kind === MARKER) to += 1
    body.push(windowHeader(lines, from, to))
    for (let index = from; index <= to; index += 1) body.push(lines[index].text)
  }
  return `${[...header, ...body].join('\n')}\n`
}
