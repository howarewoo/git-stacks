import { Button } from './ui/button'

/**
 * The single reveal affordance for every repository-sized list. Nothing in the
 * app mounts an unbounded branch, file, pull request, stash, or commit list
 * without one of these below it.
 */
export function ListWindowMore({
  pageSize,
  remaining,
  noun,
  onReveal,
}: {
  pageSize: number
  remaining: number
  noun: string
  onReveal: () => void
}) {
  if (remaining <= 0) return null
  return (
    <Button className="list-window-more" size="sm" variant="ghost" onClick={onReveal}>
      Show {pageSize} more {noun} ({remaining} remaining)
    </Button>
  )
}
