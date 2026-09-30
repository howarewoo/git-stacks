import * as React from 'react'
import { LIST_PAGE_SIZE } from '../../../shared/performance'

/**
 * Expand from one page to two, then slide that two-page window through deep
 * lists. Revealing page 100 does not mount the preceding 98 pages.
 */
export interface ListWindow<T> {
  visible: T[]
  total: number
  start: number
  hasPrevious: boolean
  shown: number
  hasMore: boolean
  remaining: number
  reveal: () => void
  retreat: () => void
  /** Slides the window so `index` of the whole list is mounted, in either direction. */
  revealIndex: (index: number) => void
}

/** The span of the whole list that a window of `pages` revealed pages mounts. */
export function windowBounds(pages: number, pageSize: number): { start: number; end: number } {
  const start = Math.max(0, (pages - 2) * pageSize)
  return { start, end: start + (pages === 1 ? pageSize : pageSize * 2) }
}

/**
 * The first page count whose window mounts `index`. A whole-list Home or End can
 * therefore land on a row the reader has never been shown, instead of stopping
 * at the edge of the mounted window.
 */
export function pageForIndex(index: number, pageSize: number): number {
  if (index < pageSize) return 1
  return Math.floor(index / pageSize) + 1
}

export function windowSlice<T>(items: readonly T[], limit: number, start = 0) {
  const visible = items.slice(start, start + limit)
  return {
    visible,
    hasMore: items.length > start + visible.length,
    remaining: items.length - start - visible.length,
  }
}

export function useListWindow<T>(items: readonly T[], pageSize = LIST_PAGE_SIZE): ListWindow<T> {
  const [pages, setPages] = React.useState(1)
  const source = React.useRef(items)
  if (source.current !== items) {
    source.current = items
    if (pages !== 1) setPages(1)
  }
  const currentPages = source.current === items ? pages : 1
  const bounds = windowBounds(currentPages, pageSize)
  const sliced = React.useMemo(
    () => windowSlice(items, bounds.end - bounds.start, bounds.start),
    [items, bounds.end, bounds.start],
  )
  const reveal = React.useCallback(() => setPages((value) => value + 1), [])
  const retreat = React.useCallback(() => setPages((value) => Math.max(1, value - 1)), [])
  const revealIndex = React.useCallback(
    (index: number) =>
      setPages((value) => {
        const mounted = windowBounds(value, pageSize)
        return index >= mounted.start && index < mounted.end ? value : pageForIndex(index, pageSize)
      }),
    [pageSize],
  )
  return {
    ...sliced,
    total: items.length,
    start: bounds.start,
    hasPrevious: currentPages > 1,
    shown: bounds.start + sliced.visible.length,
    reveal,
    retreat,
    revealIndex,
  }
}
