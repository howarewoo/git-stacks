import * as React from 'react'
import { Minus, Plus } from 'lucide-react'

import type { DiffHunk, DiffHunkLine, HunkSide, HunkSideName } from '../../../shared/types'
import { Button } from './ui/button'
import { InlineAlert } from './ui/surface'
import { cn } from '../lib/utils'

export interface HunkSelection {
  hunkId: string
  lineIndexes?: number[]
}

export function changedLineIndexes(hunk: DiffHunk): number[] {
  return hunk.lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.kind === 'add' || entry.line.kind === 'remove')
    .map((entry) => entry.index)
}

export type HunkKeyAction = { type: 'move'; index: number } | { type: 'apply' }

/**
 * What a key does inside the hunk list. Movement keys can only move: they never
 * resolve to an apply, so holding an arrow key cannot write to the index.
 */
export function hunkKeyAction(key: string, index: number, count: number): HunkKeyAction | null {
  const last = Math.max(count - 1, 0)
  if (key === 'ArrowDown') return { type: 'move', index: Math.min(index + 1, last) }
  if (key === 'ArrowUp') return { type: 'move', index: Math.max(index - 1, 0) }
  if (key === 'Home') return { type: 'move', index: 0 }
  if (key === 'End') return { type: 'move', index: last }
  if (key === 'Enter' || key === 's') return { type: 'apply' }
  return null
}

/** The changed line indexes a patch keeps, or `undefined` when the whole hunk applies. */
export function selectedLineIndexes(
  hunk: DiffHunk,
  dropped: readonly number[] | undefined,
): number[] | undefined {
  if (!dropped || dropped.length === 0) return undefined
  return changedLineIndexes(hunk).filter((index) => !dropped.includes(index))
}

/** The lines a toggle drops or keeps, per hunk, without touching any other hunk. */
export function toggleExcludedLine(
  excluded: Record<string, number[]>,
  hunkId: string,
  lineIndex: number,
): Record<string, number[]> {
  const existing = excluded[hunkId] ?? []
  return {
    ...excluded,
    [hunkId]: existing.includes(lineIndex)
      ? existing.filter((entry) => entry !== lineIndex)
      : [...existing, lineIndex],
  }
}

function hunkRange(hunk: DiffHunk): string {
  const oldEnd = hunk.oldLines === 1 ? hunk.oldStart : hunk.oldStart + hunk.oldLines - 1
  const newEnd = hunk.newLines === 1 ? hunk.newStart : hunk.newStart + hunk.newLines - 1
  return `lines ${hunk.oldStart}–${oldEnd} become ${hunk.newStart}–${newEnd}`
}

/**
 * The hunk surface. Arrow keys move between hunks and the per-line toggles choose
 * what a patch contains; neither moving focus nor toggling a line stages anything.
 * Only the explicit per-hunk control writes to the index.
 */
export function HunkDiffView({
  side,
  sideName,
  busy,
  onApply,
}: {
  side: HunkSide
  sideName: HunkSideName
  busy: boolean
  onApply: (selection: HunkSelection) => void
}) {
  const signature = side.hunks.map((hunk) => hunk.id).join('|')
  const [focused, setFocused] = React.useState(0)
  const [excluded, setExcluded] = React.useState<Record<string, number[]>>({})
  const hunkRefs = React.useRef<(HTMLElement | null)[]>([])
  React.useEffect(() => {
    hunkRefs.current = hunkRefs.current.slice(0, side.hunks.length)
    setExcluded({})
    setFocused(0)
    // A changed hunk set is a new diff: previous line choices no longer describe it.
  }, [signature, side.hunks.length])

  if (side.hunks.length === 0) {
    return (
      <InlineAlert tone="info" className="hunk-unavailable">
        {side.unavailable ?? 'This side has no textual hunks.'}
      </InlineAlert>
    )
  }

  return (
    <HunkList
      side={side}
      sideName={sideName}
      busy={busy}
      focused={focused}
      excluded={excluded}
      hunkRefs={hunkRefs}
      onFocus={setFocused}
      onMove={(index) => {
        setFocused(index)
        hunkRefs.current[index]?.focus()
      }}
      onExclude={(hunkId, lineIndex) =>
        setExcluded((current) => toggleExcludedLine(current, hunkId, lineIndex))
      }
      onApply={onApply}
    />
  )
}

/**
 * The hunk list itself. It holds no state of its own, so what a key, a line toggle
 * and the per-hunk control do is decided here and nowhere else.
 */
export interface HunkListProps {
  side: HunkSide
  sideName: HunkSideName
  busy: boolean
  focused: number
  excluded: Record<string, number[]>
  hunkRefs: React.RefObject<(HTMLElement | null)[]>
  onFocus: (index: number) => void
  onMove: (index: number) => void
  onExclude: (hunkId: string, lineIndex: number) => void
  onApply: (selection: HunkSelection) => void
}

export function HunkList({
  side,
  sideName,
  busy,
  focused,
  excluded,
  hunkRefs,
  onFocus,
  onMove,
  onExclude,
  onApply,
}: HunkListProps) {
  const verb = sideName === 'staged' ? 'Unstage' : 'Stage'
  const apply = (hunk: DiffHunk) => {
    const lineIndexes = selectedLineIndexes(hunk, excluded[hunk.id])
    if (lineIndexes && lineIndexes.length === 0) return
    onApply({
      hunkId: hunk.id,
      ...(lineIndexes ? { lineIndexes } : {}),
    })
  }

  return (
    <div className="code-region">
      <div className="code-region-header">
        <strong>{sideName === 'staged' ? 'Staged hunks' : 'Working-tree hunks'}</strong>
        <span className="code-region-meta">
          {side.hunks.length} hunk{side.hunks.length === 1 ? '' : 's'}
        </span>
      </div>
      {side.unavailable ? (
        <InlineAlert tone="warning" className="hunk-unavailable">
          {side.unavailable}
        </InlineAlert>
      ) : null}
      <p className="hunk-hint">
        Arrow keys move between hunks. Toggling a line only changes the patch that is built; a hunk
        is written to the index only when you choose {verb.toLowerCase()}.
      </p>
      <div className="hunk-list">
        {side.hunks.map((hunk, index) => {
          const dropped = excluded[hunk.id] ?? []
          const lineIndexes = selectedLineIndexes(hunk, dropped)
          const total = changedLineIndexes(hunk).length
          const chosen = lineIndexes ? lineIndexes.length : total
          return (
            <section
              key={hunk.id}
              ref={(node) => {
                hunkRefs.current[index] = node
              }}
              className={cn('hunk', index === focused && 'hunk-focused')}
              tabIndex={index === focused ? 0 : -1}
              role="group"
              aria-label={`Hunk ${index + 1} of ${side.hunks.length}, ${hunkRange(hunk)}`}
              onFocus={() => onFocus(index)}
              onKeyDown={(event) => {
                if (
                  event.target !== event.currentTarget ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey
                ) {
                  return
                }
                const key = hunkKeyAction(event.key, index, side.hunks.length)
                if (!key) return
                event.preventDefault()
                if (key.type === 'move') onMove(key.index)
                else if (!busy && !side.unavailable && !event.repeat) apply(hunk)
              }}
            >
              <header className="hunk-header">
                <span className="hunk-range" title={hunk.header}>
                  {hunkRange(hunk)}
                </span>
                {dropped.length > 0 ? (
                  <span className="hunk-selection">
                    {chosen} of {total} changed lines
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || Boolean(side.unavailable) || chosen === 0}
                  aria-label={`${verb} hunk ${index + 1} of ${side.hunks.length}`}
                  tooltip={
                    dropped.length > 0
                      ? `Apply the ${chosen} selected line${chosen === 1 ? '' : 's'} of this hunk. Other hunks and files are untouched.`
                      : `Apply this whole hunk. Other hunks and files are untouched.`
                  }
                  onClick={() => apply(hunk)}
                >
                  {sideName === 'staged' ? (
                    <Minus className="size-3.5" />
                  ) : (
                    <Plus className="size-3.5" />
                  )}
                  {dropped.length > 0 ? `${verb} ${chosen} lines` : `${verb} hunk`}
                </Button>
              </header>
              <pre className="code-diff hunk-body">
                {hunk.lines.map((line, lineIndex) => (
                  <HunkLine
                    key={lineIndex}
                    line={line}
                    position={lineIndex + 1}
                    selected={!dropped.includes(lineIndex)}
                    onToggle={() => onExclude(hunk.id, lineIndex)}
                    disabled={busy || Boolean(side.unavailable)}
                  />
                ))}
              </pre>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function HunkLine({
  line,
  position,
  selected,
  onToggle,
  disabled,
}: {
  line: DiffHunkLine
  position: number
  selected: boolean
  onToggle: () => void
  disabled: boolean
}) {
  const className = cn(
    line.kind === 'add' && 'diff-add',
    line.kind === 'remove' && 'diff-remove',
    line.kind === 'context' && 'hunk-context',
  )
  if (line.kind !== 'add' && line.kind !== 'remove') {
    return (
      <span className={cn('hunk-line', className, line.kind === 'marker' && 'hunk-marker')}>
        {line.text}
        {'\n'}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={cn('hunk-line hunk-line-selectable', className, !selected && 'hunk-line-excluded')}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={`${selected ? 'Exclude' : 'Include'} line ${position} of this hunk${
        line.oldLine === null ? '' : `, file line ${line.oldLine}`
      }`}
      title={
        selected
          ? 'Exclude this line from the patch. Nothing is written until the hunk is applied.'
          : 'Include this line in the patch. Nothing is written until the hunk is applied.'
      }
      onClick={onToggle}
    >
      <span className="hunk-line-gutter" aria-hidden="true">
        {selected ? '−' : '+'}
      </span>
      {line.text}
      {'\n'}
    </button>
  )
}
