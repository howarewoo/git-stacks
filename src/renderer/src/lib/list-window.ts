import * as React from 'react'
import { LIST_PAGE_SIZE } from '../../../shared/performance'

/**
 * Bounded rendering for repository-sized lists. A repository can report
 * thousands of branches, changed files, pull requests, or commits; only the
 * first page is mounted and the reader reveals the rest, so opening a large
 * repository costs the same DOM as an empty one.
 */
export interface ListWindow<T> {
  visible: T[]
  total: number
  shown: number
  hasMore: boolean
  remaining: number
  reveal: () => void
}

export function windowSlice<T>(items: readonly T[], limit: number) {
  const visible = items.slice(0, limit)
  return {
    visible,
    hasMore: items.length > visible.length,
    remaining: items.length - visible.length,
  }
}

export function useListWindow<T>(items: readonly T[], pageSize = LIST_PAGE_SIZE): ListWindow<T> {
  const [pages, setPages] = React.useState(1)
  const source = React.useRef(items)
  if (source.current !== items) {
    source.current = items
    if (pages !== 1) setPages(1)
  }
  const sliced = React.useMemo(() => windowSlice(items, pages * pageSize), [items, pages, pageSize])
  const reveal = React.useCallback(() => setPages((value) => value + 1), [])
  return { ...sliced, total: items.length, shown: sliced.visible.length, reveal }
}
