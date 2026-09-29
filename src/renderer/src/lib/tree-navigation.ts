/**
 * One keyboard contract for the workbench's composite row surfaces: the branch
 * tree, the stack rail, and the commit history list.
 *
 * Each surface is a single composite widget — one Tab stop, arrow keys to move
 * focus between rows, Home/End for the ends, and Enter/Space for the explicit
 * row action. The helpers are pure so the contract is unit-testable without a
 * renderer, and so a keystroke a row has already handled is never re-consumed.
 */

export type RovingAction = 'next' | 'previous' | 'first' | 'last'

/** Maps a keystroke to a roving move, or null when the key is not ours. */
export function rovingAction(key: string): RovingAction | null {
  if (key === 'ArrowDown' || key === 'ArrowRight') return 'next'
  if (key === 'ArrowUp' || key === 'ArrowLeft') return 'previous'
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  return null
}

/**
 * The row index a roving move targets, or null when the surface is already at
 * that end and focus must stay put.
 */
export function rovingTarget(action: RovingAction, current: number, count: number): number | null {
  if (count <= 0) return null
  const index = Math.min(Math.max(current, 0), count - 1)
  if (action === 'next') return index >= count - 1 ? null : index + 1
  if (action === 'previous') return index <= 0 ? null : index - 1
  if (action === 'first') return index === 0 ? null : 0
  return index === count - 1 ? null : count - 1
}

/** Roving tabindex: exactly one row of a composite surface stays in the tab order. */
export function rovingTabIndex(index: number, activeIndex: number): 0 | -1 {
  return index === activeIndex ? 0 : -1
}

/** Keeps the active row inside the surface when rows are added, filtered, or paged. */
export function clampRovingIndex(activeIndex: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(activeIndex, 0), count - 1)
}
