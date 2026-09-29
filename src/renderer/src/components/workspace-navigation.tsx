import * as React from 'react'
import {
  Archive,
  Files,
  GitBranch,
  GitPullRequest,
  History,
  Layers,
  MessageSquareDiff,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../lib/utils'

export type WorkspaceView =
  | 'branches'
  | 'stacks'
  | 'history'
  | 'changes'
  | 'pullRequests'
  | 'review'
  | 'stashes'
  | 'diagnostics'

type WorkspaceDestination = {
  id: WorkspaceView
  label: string
  icon: LucideIcon
}

const workspaceDestinations: readonly WorkspaceDestination[] = [
  { id: 'branches', label: 'Branches', icon: GitBranch },
  { id: 'stacks', label: 'Stacks', icon: Layers },
  { id: 'history', label: 'History', icon: History },
  { id: 'changes', label: 'Working changes', icon: Files },
  { id: 'pullRequests', label: 'Pull requests', icon: GitPullRequest },
  { id: 'review', label: 'Review', icon: MessageSquareDiff },
  { id: 'stashes', label: 'Stashes', icon: Archive },
  { id: 'diagnostics', label: 'Diagnostics', icon: SlidersHorizontal },
]

export function WorkspaceNavigation({
  activeView,
  branchCount,
  changeCount,
  pullRequestCount,
  stashCount,
  attentionCount,
  onSelect,
}: {
  activeView: WorkspaceView
  branchCount: number
  changeCount: number
  pullRequestCount: number
  stashCount: number
  attentionCount: number
  onSelect: (view: WorkspaceView) => void
}) {
  const countFor = (view: WorkspaceView) => {
    if (view === 'branches') return branchCount
    if (view === 'changes') return changeCount || undefined
    if (view === 'pullRequests') return pullRequestCount
    if (view === 'stashes') return stashCount
    if (view === 'diagnostics') return attentionCount || undefined
    return undefined
  }

  return (
    <nav className="workspace-nav" aria-label="Workspace destinations">
      {workspaceDestinations.map(({ id, label, icon: Icon }) => {
        const active = activeView === id
        const count = countFor(id)
        return (
          <button
            aria-current={active ? 'page' : undefined}
            className={cn('nav-item', active && 'nav-item-active')}
            key={id}
            onClick={() => onSelect(id)}
            type="button"
          >
            <Icon aria-hidden="true" className="size-4" />
            <span className="nav-item-label">{label}</span>
            {count !== undefined ? (
              <span
                className={cn('nav-count', id === 'changes' && count > 0 && 'nav-count-accent')}
              >
                {count}
              </span>
            ) : null}
            {active ? <span className="nav-current-marker" aria-hidden="true" /> : null}
          </button>
        )
      })}
    </nav>
  )
}
