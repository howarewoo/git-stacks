import { Button } from './ui/button'

/** One-page navigation for repository-sized lists. */
export function ListWindowMore({
  pageSize,
  remaining,
  previous,
  noun,
  onReveal,
  onPrevious,
}: {
  pageSize: number
  remaining: number
  previous: boolean
  noun: string
  onReveal: () => void
  onPrevious: () => void
}) {
  if (remaining <= 0 && !previous) return null
  return (
    <div className="list-window-controls">
      {previous ? (
        <Button size="sm" variant="ghost" onClick={onPrevious}>
          Show previous {noun}
        </Button>
      ) : null}
      {remaining > 0 ? (
        <Button className="list-window-more" size="sm" variant="ghost" onClick={onReveal}>
          Show {Math.min(pageSize, remaining)} more {noun} ({remaining} remaining)
        </Button>
      ) : null}
    </div>
  )
}
