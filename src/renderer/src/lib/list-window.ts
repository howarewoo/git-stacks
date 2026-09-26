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
  const start = Math.max(0, (currentPages - 2) * pageSize)
  const sliced = React.useMemo(
    () => windowSlice(items, currentPages === 1 ? pageSize : pageSize * 2, start),
    [items, pageSize, currentPages, start],
  )
  const reveal = React.useCallback(() => setPages((value) => value + 1), [])
  const retreat = React.useCallback(() => setPages((value) => Math.max(1, value - 1)), [])
  return {
    ...sliced,
    total: items.length,
    start,
    hasPrevious: currentPages > 1,
    shown: start + sliced.visible.length,
    reveal,
    retreat,
  }
}
