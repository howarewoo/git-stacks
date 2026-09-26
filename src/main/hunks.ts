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
 * Unquotes a C-style quoted path that Git outputs when a path contains quotes,
 * tabs, newlines, spaces with certain flags, or non-ASCII bytes.
 */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    return raw
  }
  const inner = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1]
      if (next === '"') {
        bytes.push(34)
        i++
      } else if (next === '\\') {
        bytes.push(92)
        i++
      } else if (next === 'n') {
        bytes.push(10)
        i++
      } else if (next === 't') {
        bytes.push(9)
        i++
      } else if (next === 'r') {
        bytes.push(13)
        i++
      } else if (next === 'a') {
        bytes.push(7)
        i++
      } else if (next === 'b') {
        bytes.push(8)
        i++
      } else if (next === 'f') {
        bytes.push(12)
        i++
      } else if (next === 'v') {
        bytes.push(11)
        i++
      } else if (/[0-7]/.test(next)) {
        let octalStr = next
        i++
        if (i + 1 < inner.length && /[0-7]/.test(inner[i + 1])) {
          octalStr += inner[++i]
          if (i + 1 < inner.length && /[0-7]/.test(inner[i + 1])) {
            octalStr += inner[++i]
          }
        }
        bytes.push(parseInt(octalStr, 8))
      } else {
        bytes.push(next.charCodeAt(0))
        i++
      }
    } else {
      const codePoint = inner.codePointAt(i)!
      const buf = Buffer.from(String.fromCodePoint(codePoint), 'utf8')
      for (const b of buf) bytes.push(b)
      if (codePoint > 0xffff) i++
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Git ends a `---`/`+++` path at the first tab, which is how it separates a path
 * containing spaces from the timestamp column. Quoted paths keep their closing quote
 * and are unquoted back to the original filename.
 */
function diffPath(value: string): string | null {
  let raw = value
  if (raw.startsWith('"')) {
    let endQuote = -1
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] === '\\') i++
      else if (raw[i] === '"') {
        endQuote = i
        break
      }
    }
    if (endQuote !== -1) {
      raw = raw.slice(0, endQuote + 1)
    }
    raw = unquoteGitPath(raw)
  } else {
    const tab = raw.indexOf('\t')
    if (tab !== -1) raw = raw.slice(0, tab)
  }
  if (raw === '/dev/null') return null
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2)
  return raw
}

function parseGitDiffHeaderPaths(line: string): { oldPath: string | null; newPath: string | null } {
  if (!line.startsWith('diff --git ')) return { oldPath: null, newPath: null }
  const rest = line.slice('diff --git '.length)
  let first: string
  let second: string
  if (rest.startsWith('"')) {
    let endQuote = -1
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '\\') i++
      else if (rest[i] === '"') {
        endQuote = i
        break
      }
    }
    if (endQuote !== -1) {
      first = rest.slice(0, endQuote + 1)
      second = rest.slice(endQuote + 1).trimStart()
    } else {
      return { oldPath: null, newPath: null }
    }
  } else {
    const bIndex = rest.search(/\s+(?:b\/|"b\/)/)
    if (bIndex !== -1) {
      first = rest.slice(0, bIndex)
      second = rest.slice(bIndex).trimStart()
    } else {
      const parts = rest.split(' ')
      first = parts[0]
      second = parts.slice(1).join(' ')
    }
  }
  return { oldPath: diffPath(first), newPath: diffPath(second) }
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
  const { oldPath, newPath } = parseGitDiffHeaderPaths(line)
  return (
    newPath === identity.path ||
    oldPath === identity.path ||
    (identity.originalPath !== null && oldPath === identity.originalPath)
  )
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
 * Builds one hunk patch. Without a line selection Git's hunk passes through
 * unchanged; with one, unselected preimage lines become context and
 * unselected postimage lines disappear.
 */
export function buildHunkPatch(
  block: HunkBlock,
  hunk: DiffHunk,
  side: HunkSideName,
  lineIndexes?: number[],
): string {
  const lines = hunk.lines
  // A text hunk and chmod can share a diff block. Applying Git's mode headers
  // would stage the chmod too, so keep only the content-bearing file header.
  const header = block.header.filter(
    (line) => !line.startsWith('old mode ') && !line.startsWith('new mode '),
  )
  const verbatim = () => `${[...header, hunk.header, ...lines.map((l) => l.text)].join('\n')}\n`
  if (lineIndexes === undefined) return verbatim()
  if (lineIndexes.length === 0) {
    throw new Error('Select at least one changed line before applying a hunk')
  }

  const selected = new Set(lineIndexes)
  const changes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.kind === 'add' || line.kind === 'remove')
  if (changes.every(({ index }) => selected.has(index))) return verbatim()

  // The index is the old side when staging and the new side when reversing a
  // staged diff. An unselected line already present there becomes context;
  // an unselected line absent there disappears from the patch altogether.
  // Keeping one complete hunk makes repeated content and zero-count anchors
  // independent of Git's fuzzy matching or split-window coordinate offsets.
  const preimageKind = side === 'staged' ? 'add' : 'remove'
  const body: string[] = []
  let oldCount = 0
  let newCount = 0
  let previousIncluded = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.kind === MARKER) {
      if (previousIncluded) body.push(line.text)
      continue
    }
    const included = line.kind === 'context' || selected.has(index) || line.kind === preimageKind
    previousIncluded = included
    if (!included) continue
    const text =
      line.kind !== 'context' && !selected.has(index) ? ` ${line.text.slice(1)}` : line.text
    body.push(text)
    if (text[0] !== '+') oldCount++
    if (text[0] !== '-') newCount++
  }

  const preimageStart = side === 'staged' ? hunk.newStart : hunk.oldStart
  const oldStart = side === 'staged' ? preimageStart + (newCount === 0 ? 1 : 0) : preimageStart
  const newStart = side === 'staged' ? preimageStart : preimageStart + (oldCount === 0 ? 1 : 0)
  return `${[...header, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body].join('\n')}\n`
}
