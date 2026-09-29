import * as React from 'react'
import { AlertCircle, Check, RotateCcw, Settings } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import {
  SHORTCUT_DEFINITIONS,
  assignShortcut,
  chordFromEvent,
  defaultShortcutBindings,
  formatChord,
  isMacPlatform,
  type ShortcutId,
} from '../../../shared/shortcuts'

export interface ShortcutEditorProps {
  bindings: Record<ShortcutId, string>
  onBindingsChange: (bindings: Record<ShortcutId, string>) => void
  /** Set when a policy fixed the shortcuts, so the editor is read-only. */
  disabledReason?: string
}

export interface ShortcutSettingsProps extends ShortcutEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The shortcut editor itself, with no dialog of its own.
 *
 * It is a body rather than a modal so it can be mounted inline: a second modal
 * inside the Settings dialog traps focus behind its own overlay, leaving the
 * parent unreachable and the editor impossible to close.
 */
export function ShortcutEditor({
  bindings,
  onBindingsChange,
  disabledReason,
}: ShortcutEditorProps) {
  const [recordingId, setRecordingId] = React.useState<ShortcutId | null>(null)
  const [conflictMessage, setConflictMessage] = React.useState<string | null>(null)
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null)
  const isMac = isMacPlatform()

  React.useEffect(() => {
    if (!open) {
      setRecordingId(null)
      setConflictMessage(null)
      setSuccessMessage(null)
    }
  }, [open])

  React.useEffect(() => {
    if (!recordingId) return

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecordingId(null)
        setConflictMessage(null)
        return
      }
      if (isMac ? event.ctrlKey : event.metaKey) {
        setConflictMessage(
          `This shortcut cannot use ${isMac ? 'Control' : 'Command/Meta'}; use ${isMac ? 'Command' : 'Control'} as the primary modifier instead.`,
        )
        setSuccessMessage(null)
        return
      }

      const chord = chordFromEvent(event, isMac)
      if (!chord) return

      if (disabledReason) {
        setRecordingId(null)
        return
      }

      const result = assignShortcut(bindings, recordingId, chord)
      if (result.reserved) {
        setConflictMessage(
          `Conflict: ${formatChord(result.reserved.chord, isMac)} is reserved by the command palette for ${result.reserved.role}. Choose a different shortcut.`,
        )
        setSuccessMessage(null)
      } else if (result.conflict) {
        const conflictingDef = SHORTCUT_DEFINITIONS.find(
          (d) => d.id === result.conflict?.conflictingId,
        )
        const name = conflictingDef ? conflictingDef.label : result.conflict.conflictingId
        setConflictMessage(
          `Conflict: ${formatChord(chord, isMac)} is already assigned to "${name}". Choose a different shortcut.`,
        )
        setSuccessMessage(null)
      } else {
        onBindingsChange(result.bindings)
        const def = SHORTCUT_DEFINITIONS.find((d) => d.id === recordingId)
        setSuccessMessage(
          `Updated shortcut for "${def?.label ?? recordingId}" to ${formatChord(chord, isMac)}.`,
        )
        setConflictMessage(null)
        setRecordingId(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [bindings, isMac, onBindingsChange, recordingId])

  const handleResetAll = () => {
    if (disabledReason) return
    const fresh = defaultShortcutBindings()
    onBindingsChange(fresh)
    setConflictMessage(null)
    setSuccessMessage('Reset all keyboard shortcuts to their default bindings.')
    setRecordingId(null)
  }

  const groups = React.useMemo(() => {
    const map = new Map<string, (typeof SHORTCUT_DEFINITIONS)[number][]>()
    for (const def of SHORTCUT_DEFINITIONS) {
      const list = map.get(def.group) ?? []
      list.push(def)
      map.set(def.group, list)
    }
    return Array.from(map.entries())
  }, [])

  return (
    <div className="shortcut-settings-editor space-y-4">
      {disabledReason ? (
        <div
          className="rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] p-3 text-[13px] text-[var(--gs-semantic-text-secondary)]"
          role="status"
        >
          {disabledReason}
        </div>
      ) : null}

      {conflictMessage && (
          <div
            className="flex items-center gap-2 rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-semantic-feedback-error-text)] bg-[var(--gs-semantic-feedback-error-surface)] p-3 text-[13px] text-[var(--gs-semantic-feedback-error-text)]"
            role="alert"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{conflictMessage}</span>
          </div>
        )}

        {successMessage && (
          <div
            className="flex items-center gap-2 rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-semantic-feedback-success-text)] bg-[var(--gs-semantic-feedback-success-surface)] p-3 text-[13px] text-[var(--gs-semantic-feedback-success-text)]"
            role="status"
          >
            <Check className="size-4 shrink-0" aria-hidden="true" />
            <span>{successMessage}</span>
          </div>
        )}

        <div className="max-h-[380px] space-y-4 overflow-y-auto pr-1">
          {groups.map(([groupName, defs]) => (
            <div key={groupName} className="space-y-1.5">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--gs-semantic-text-secondary)]">
                {groupName}
              </h2>
              <div className="divide-y divide-[var(--gs-semantic-border-essential)] rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-content)]">
                {defs.map((def) => {
                  const chord = bindings[def.id] ?? def.defaultChord
                  const isRecording = recordingId === def.id
                  return (
                    <div
                      key={def.id}
                      className="flex items-center justify-between px-3 py-2 text-[13px]"
                    >
                      <div className="min-w-0 flex-1 pr-3">
                        <div className="font-medium text-[var(--gs-component-overlay-text)]">
                          {def.label}
                        </div>
                        <div className="text-[12px] text-[var(--gs-semantic-text-secondary)]">
                          {def.description}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {isRecording ? (
                          <Badge variant="warning" className="animate-pulse">
                            Press new keys… (Esc cancels)
                          </Badge>
                        ) : (
                          <kbd className="rounded border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] px-2 py-0.5 font-mono text-[12px] text-[var(--gs-semantic-text-secondary)]">
                            {formatChord(chord, isMac)}
                          </kbd>
                        )}
                        <Button
                          size="sm"
                          variant={isRecording ? 'accent' : 'secondary'}
                          disabled={Boolean(disabledReason)}
                          onClick={() => {
                            if (isRecording) {
                              setRecordingId(null)
                            } else {
                              setRecordingId(def.id)
                              setConflictMessage(null)
                              setSuccessMessage(null)
                            }
                          }}
                          aria-label={`Change shortcut for ${def.label}`}
                        >
                          {isRecording ? 'Cancel' : 'Change'}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end border-t border-[var(--gs-semantic-border-essential)] pt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleResetAll}
            disabled={Boolean(disabledReason)}
            tooltip="Restore all shortcuts to factory defaults"
          >
            <RotateCcw className="size-3.5 mr-1" aria-hidden="true" />
            Reset all to defaults
          </Button>
        </div>
    </div>
  )
}

/**
 * The standalone shortcut dialog, still opened by its own command. It wraps the
 * editor so there is exactly one implementation of the behaviour and one place
 * that decides what a change does.
 */
export function ShortcutSettings({
  open,
  onOpenChange,
  bindings,
  onBindingsChange,
  disabledReason,
}: ShortcutSettingsProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="shortcut-settings-dialog max-w-xl"
        aria-describedby="shortcut-settings-desc"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Settings
              className="size-5 text-[var(--gs-semantic-text-secondary)]"
              aria-hidden="true"
            />
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </div>
          <DialogDescription id="shortcut-settings-desc">
            Customize shortcuts for command palette, navigation, and view switching. Collisions are
            detected before assignment.
          </DialogDescription>
        </DialogHeader>
        <ShortcutEditor
          bindings={bindings}
          onBindingsChange={onBindingsChange}
          disabledReason={disabledReason}
        />
      </DialogContent>
    </Dialog>
  )
}
