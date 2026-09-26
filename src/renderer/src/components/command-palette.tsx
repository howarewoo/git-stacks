import * as React from 'react'
import {
  AlertTriangle,
  Archive,
  CornerDownLeft,
  ExternalLink,
  Files,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  GitPullRequest,
  History,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Badge } from './ui/badge'
import { cn } from '../lib/utils'
import {
  type CommandGroup,
  type PaletteItem,
  rankPaletteItems,
  resolveFocusRestoreTarget,
} from '../lib/command-palette'

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: readonly PaletteItem[]
  onExecute: (item: PaletteItem) => void
  searchFallbackRef?: React.RefObject<HTMLInputElement | null>
}

const GROUP_ORDER: readonly CommandGroup[] = [
  'Stack navigation',
  'Commands',
  'Views',
  'Branches',
  'Pull requests',
  'Recent repositories',
  'Settings',
]

function groupIcon(group: CommandGroup) {
  switch (group) {
    case 'Stack navigation':
      return (
        <Layers className="size-3.5 text-[var(--gs-semantic-action-link)]" aria-hidden="true" />
      )
    case 'Commands':
      return (
        <GitFork className="size-3.5 text-[var(--gs-semantic-text-secondary)]" aria-hidden="true" />
      )
    case 'Views':
      return (
        <Files className="size-3.5 text-[var(--gs-semantic-text-secondary)]" aria-hidden="true" />
      )
    case 'Branches':
      return (
        <GitBranch className="size-3.5 text-[var(--gs-semantic-action-link)]" aria-hidden="true" />
      )
    case 'Pull requests':
      return (
        <GitPullRequest
          className="size-3.5 text-[var(--gs-semantic-feedback-success-text)]"
          aria-hidden="true"
        />
      )
    case 'Recent repositories':
      return (
        <FolderGit2
          className="size-3.5 text-[var(--gs-semantic-text-secondary)]"
          aria-hidden="true"
        />
      )
    case 'Settings':
      return (
        <Settings
          className="size-3.5 text-[var(--gs-semantic-text-secondary)]"
          aria-hidden="true"
        />
      )
  }
}

export interface CommandPaletteContentProps {
  items: readonly PaletteItem[]
  onExecute: (item: PaletteItem) => void
  onClose?: () => void
  /** Reports the armed destructive confirmation so the dialog can hold Escape open. */
  onConfirmingChange?: (itemId: string | null) => void
}

export function CommandPaletteContent({
  items,
  onExecute,
  onClose,
  onConfirmingChange,
}: CommandPaletteContentProps) {
  const [query, setQuery] = React.useState('')
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const filteredItems = React.useMemo(() => {
    return rankPaletteItems(items, query)
  }, [items, query])

  // Reset index when query changes
  React.useEffect(() => {
    setSelectedIndex(0)
    setConfirmingId(null)
  }, [query])

  // Radix dismisses the dialog from a document-level capture listener that runs
  // before this input's own handler, so the armed state is reported upward for
  // `onEscapeKeyDown` to keep a pending confirmation from closing the palette.
  React.useEffect(() => {
    onConfirmingChange?.(confirmingId)
  }, [confirmingId, onConfirmingChange])

  // Group items in standard group order
  const groupedItems = React.useMemo(() => {
    const map = new Map<CommandGroup, Array<{ item: PaletteItem; flatIndex: number }>>()
    filteredItems.forEach((item, flatIndex) => {
      const existing = map.get(item.group)
      if (existing) {
        existing.push({ item, flatIndex })
      } else {
        map.set(item.group, [{ item, flatIndex }])
      }
    })

    const result: Array<{
      group: CommandGroup
      entries: Array<{ item: PaletteItem; flatIndex: number }>
    }> = []
    for (const group of GROUP_ORDER) {
      const entries = map.get(group)
      if (entries && entries.length > 0) {
        result.push({ group, entries })
      }
    }
    // Any other groups
    for (const [group, entries] of map.entries()) {
      if (!GROUP_ORDER.includes(group)) {
        result.push({ group, entries })
      }
    }
    return result
  }, [filteredItems])

  const selectedItem = filteredItems[selectedIndex] ?? null

  // Ensure selected item is scrolled into view
  React.useEffect(() => {
    if (!listRef.current) return
    const activeElement = listRef.current.querySelector<HTMLElement>(
      '[data-palette-selected="true"]',
    )
    if (activeElement) {
      activeElement.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const handleExecute = React.useCallback(
    (item: PaletteItem) => {
      if (item.disabled) return

      if (item.destructive && confirmingId !== item.id) {
        setConfirmingId(item.id)
        return
      }

      onClose?.()
      onExecute(item)
    },
    [confirmingId, onClose, onExecute],
  )

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setConfirmingId(null)
      if (filteredItems.length === 0) return
      setSelectedIndex((prev) => (prev + 1) % filteredItems.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setConfirmingId(null)
      if (filteredItems.length === 0) return
      setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setConfirmingId(null)
      setSelectedIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setConfirmingId(null)
      setSelectedIndex(Math.max(0, filteredItems.length - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (selectedItem) {
        handleExecute(selectedItem)
      }
    } else if (event.key === 'Escape') {
      if (confirmingId) {
        event.preventDefault()
        event.stopPropagation()
        setConfirmingId(null)
      }
    }
  }

  const liveAnnouncement = React.useMemo(() => {
    if (confirmingId && selectedItem) {
      return `Confirmation required: press Enter again to execute destructive action ${selectedItem.label}, or Escape to cancel.`
    }
    if (!selectedItem) {
      return filteredItems.length === 0 ? 'No matching commands found.' : ''
    }
    if (selectedItem.disabled) {
      return `${selectedItem.label} is currently unavailable: ${selectedItem.disabledReason || 'disabled'}.`
    }
    return `${selectedItem.label}, ${selectedItem.group}${selectedItem.shortcutText ? `, shortcut ${selectedItem.shortcutText}` : ''}.`
  }, [confirmingId, filteredItems.length, selectedItem])

  return (
    <div className="flex flex-col">
      <div className="sr-only">
        <h2>Command palette</h2>
        <p>Search commands, stack navigation, branches, pull requests, and settings.</p>
      </div>

      <div className="palette-search-row flex items-center border-b border-[var(--gs-semantic-border-essential)] px-4 py-3">
        <Search
          className="mr-3 size-4 text-[var(--gs-semantic-text-secondary)]"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="palette-listbox"
          aria-activedescendant={selectedItem ? `palette-opt-${selectedItem.id}` : undefined}
          aria-label="Search actions, repositories, branches, PRs, and settings"
          placeholder="Type a command or search entities…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent text-[14px] text-[var(--gs-component-overlay-text)] placeholder:text-[var(--gs-semantic-text-secondary)] outline-none"
          autoFocus
        />
        {confirmingId && (
          <Badge variant="warning" className="ml-2 animate-pulse gap-1">
            <AlertTriangle className="size-3" aria-hidden="true" />
            Press Enter again to confirm
          </Badge>
        )}
      </div>

      {/* Screen-reader status announcement */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      <div
        ref={listRef}
        id="palette-listbox"
        role="listbox"
        aria-label="Command suggestions"
        className="palette-results max-h-[360px] overflow-y-auto p-2"
      >
        {filteredItems.length === 0 ? (
          <div className="p-6 text-center text-[13px] text-[var(--gs-semantic-text-secondary)]">
            No matching commands or entities found for &ldquo;{query}&rdquo;.
          </div>
        ) : (
          groupedItems.map(({ group, entries }) => (
            <div
              key={group}
              role="group"
              aria-label={group}
              className="palette-group mb-2 last:mb-0"
            >
              <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--gs-semantic-text-secondary)]">
                {groupIcon(group)}
                <span>{group}</span>
              </div>
              <div className="palette-group-items space-y-0.5">
                {entries.map(({ item, flatIndex }) => {
                  const isSelected = flatIndex === selectedIndex
                  const isConfirming = confirmingId === item.id
                  return (
                    <div
                      key={item.id}
                      id={`palette-opt-${item.id}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={item.disabled}
                      aria-label={`${item.label}${item.detail ? ` (${item.detail})` : ''}${item.destructive ? ', destructive action requiring confirmation' : ''}${item.disabled ? `, unavailable: ${item.disabledReason}` : ''}${item.shortcutText ? `, shortcut ${item.shortcutText}` : ''}`}
                      data-palette-selected={isSelected}
                      onClick={() => {
                        setSelectedIndex(flatIndex)
                        handleExecute(item)
                      }}
                      onMouseEnter={() => {
                        setSelectedIndex(flatIndex)
                      }}
                      className={cn(
                        'palette-row group flex cursor-pointer items-center justify-between rounded-[var(--gs-semantic-radius-control)] px-3 py-2 text-[13px] transition-colors outline-none select-none',
                        isSelected
                          ? isConfirming
                            ? 'bg-[var(--gs-semantic-feedback-error-surface)] text-[var(--gs-semantic-feedback-error-text)]'
                            : 'bg-[var(--gs-semantic-selection-background)] text-[var(--gs-semantic-selection-text)]'
                          : 'text-[var(--gs-component-overlay-text)] hover:bg-[var(--gs-semantic-surface-inset)]',
                        item.disabled && 'cursor-not-allowed opacity-55 hover:bg-transparent',
                      )}
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{item.label}</span>
                          {item.destructive && (
                            <Badge
                              variant={isConfirming ? 'danger' : 'outline'}
                              className="text-[10px] uppercase tracking-wider"
                            >
                              {isConfirming ? 'Confirm destructive action' : 'Destructive'}
                            </Badge>
                          )}
                          {item.disabled && item.disabledReason && (
                            <span className="truncate text-[11px] text-[var(--gs-semantic-text-secondary)] italic">
                              — {item.disabledReason}
                            </span>
                          )}
                        </div>
                        {item.detail && !item.disabled && (
                          <span className="truncate text-[12px] text-[var(--gs-semantic-text-secondary)]">
                            {item.detail}
                          </span>
                        )}
                      </div>

                      <div className="ml-3 flex shrink-0 items-center gap-2">
                        {item.shortcutText && (
                          <kbd className="rounded border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--gs-semantic-text-secondary)]">
                            {item.shortcutText}
                          </kbd>
                        )}
                        {isSelected && !item.disabled && (
                          <CornerDownLeft className="size-3.5 opacity-70" aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="palette-footer flex items-center justify-between border-t border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] px-4 py-2 text-[11px] text-[var(--gs-semantic-text-secondary)]">
        <div className="flex items-center gap-3">
          <span>
            <kbd className="font-mono">↑↓</kbd> Navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> Select
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> Dismiss
          </span>
        </div>
        <span>{filteredItems.length} results</span>
      </div>
    </div>
  )
}

export function CommandPalette({
  open,
  onOpenChange,
  items,
  onExecute,
  searchFallbackRef,
}: CommandPaletteProps) {
  const openerRef = React.useRef<HTMLElement | null>(null)
  const confirmingRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (open) {
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body) {
        openerRef.current = active
      }
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="palette-dialog fixed left-1/2 top-[12%] z-[var(--gs-component-overlay-z-index)] grid w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 gap-0 overflow-hidden rounded-[var(--gs-semantic-radius-workbench)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-component-overlay-background)] p-0 shadow-[var(--gs-semantic-elevation-large)] outline-none"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = resolveFocusRestoreTarget(openerRef.current, searchFallbackRef?.current)
          target?.focus()
          openerRef.current = null
        }}
        onEscapeKeyDown={(event) => {
          if (confirmingRef.current) event.preventDefault()
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>
            Search commands, stack navigation, branches, pull requests, and settings.
          </DialogDescription>
        </DialogHeader>
        <CommandPaletteContent
          items={items}
          onExecute={onExecute}
          onClose={() => onOpenChange(false)}
          onConfirmingChange={(itemId) => {
            confirmingRef.current = itemId
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
