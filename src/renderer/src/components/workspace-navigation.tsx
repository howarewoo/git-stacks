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
import { claimsRovingKey, rovingAction, rovingTarget } from '../lib/tree-navigation'
import type { ShortcutId } from '../lib/keyboard-shortcuts'

export type WorkspaceView =
  | 'branches'
  | 'stacks'
  | 'history'
  | 'changes'
  | 'pullRequests'
  | 'review'
  | 'stashes'
  | 'diagnostics'

/**
 * Every destination heading carries this id so a keyboard-driven destination
 * change can move focus to the new workspace instead of stranding it on the
 * navigation control the user just pressed.
 */
export const WORKSPACE_VIEW_HEADING_ID = 'workspace-view-heading'

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

/** The spoken name of a destination, used for the workspace-change announcement. */
export function workspaceViewLabel(view: WorkspaceView): string {
  return workspaceDestinations.find((destination) => destination.id === view)?.label ?? view
}

/**
 * One keyboard route per destination, kept beside the destination list so a new
 * destination cannot ship without both a binding and a spoken label.
 */
export const WORKSPACE_VIEW_SHORTCUTS: readonly (readonly [ShortcutId, WorkspaceView])[] = [
  ['view.branches', 'branches'],
  ['view.stacks', 'stacks'],
  ['view.history', 'history'],
  ['view.changes', 'changes'],
  ['view.pullRequests', 'pullRequests'],
  ['view.stashes', 'stashes'],
  ['view.diagnostics', 'diagnostics'],
  ['view.review', 'review'],
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
    <nav
      aria-label="Workspace destinations"
      className="workspace-nav"
      onKeyDown={(event) => {
        // Arrow keys walk the destination group. Every item also stays in the
        // tab order, so the rail is usable without knowing the arrow contract.
        // Only unmodified keys are claimed; a chord belongs to the global
        // shortcut dispatcher.
        if (!claimsRovingKey(event)) return
        const action = rovingAction(event.key)
        if (!action) return
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.nav-item')]
        const index = items.indexOf(event.target as HTMLButtonElement)
        if (index < 0) return
        const target = rovingTarget(action, index, items.length)
        if (target === null) return
        event.preventDefault()
        items[target].focus()
      }}
    >
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
