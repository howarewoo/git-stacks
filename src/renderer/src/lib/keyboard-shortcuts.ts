export type ShortcutId =
  | 'palette.open'
  | 'search.focus'
  | 'stack.selectParent'
  | 'stack.selectChild'
  | 'stack.selectTop'
  | 'stack.selectBottom'
  | 'stack.checkout'
  | 'stack.restack'
  | 'stack.sync'
  | 'stack.openPr'
  | 'view.branches'
  | 'view.stacks'
  | 'view.changes'
  | 'view.pullRequests'
  | 'view.stashes'
  | 'view.history'

export interface ShortcutMetadata {
  id: ShortcutId
  label: string
  group: 'General' | 'Stack navigation' | 'Views'
  defaultChord: string
  description: string
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutMetadata[] = [
  {
    id: 'palette.open',
    label: 'Open command palette',
    group: 'General',
    defaultChord: 'Mod+K',
    description: 'Open the palette to search actions, branches, PRs, and repositories.',
  },
  {
    id: 'search.focus',
    label: 'Focus search filter',
    group: 'General',
    defaultChord: '/',
    description: 'Focus the in-view filter field without opening the global palette.',
  },
  {
    id: 'stack.selectParent',
    label: 'Select parent branch',
    group: 'Stack navigation',
    defaultChord: 'Alt+ArrowUp',
    description: 'Move branch selection to the parent without mutating the working tree.',
  },
  {
    id: 'stack.selectChild',
    label: 'Select child branch',
    group: 'Stack navigation',
    defaultChord: 'Alt+ArrowDown',
    description: 'Move branch selection to the first child without mutating the working tree.',
  },
  {
    id: 'stack.selectTop',
    label: 'Select stack top',
    group: 'Stack navigation',
    defaultChord: 'Alt+Shift+ArrowUp',
    description: 'Move branch selection to the top of this stack without switching.',
  },
  {
    id: 'stack.selectBottom',
    label: 'Select stack bottom',
    group: 'Stack navigation',
    defaultChord: 'Alt+Shift+ArrowDown',
    description: 'Move branch selection to the root parent of this stack.',
  },
  {
    id: 'stack.checkout',
    label: 'Check out selected branch',
    group: 'Stack navigation',
    defaultChord: 'Mod+Enter',
    description: 'Switch the working tree to the selected branch through clean-tree safeguards.',
  },
  {
    id: 'stack.restack',
    label: 'Restack stack',
    group: 'Stack navigation',
    defaultChord: 'Mod+Shift+R',
    description: 'Preview rebasing this stack onto updated parents locally.',
  },
  {
    id: 'stack.sync',
    label: 'Sync with remote',
    group: 'Stack navigation',
    defaultChord: 'Mod+Shift+S',
    description: 'Fetch remote updates without altering the working tree.',
  },
  {
    id: 'stack.openPr',
    label: 'Open pull request',
    group: 'Stack navigation',
    defaultChord: 'Mod+Shift+P',
    description: 'Open the pull request for the selected branch or review creating one.',
  },
  {
    id: 'view.branches',
    label: 'Go to Branches',
    group: 'Views',
    defaultChord: 'Mod+1',
    description: 'Switch to the Branches view.',
  },
  {
    id: 'view.stacks',
    label: 'Go to Stacks',
    group: 'Views',
    defaultChord: 'Mod+2',
    description: 'Switch to the Stacks view.',
  },
  {
    id: 'view.history',
    label: 'Go to History',
    group: 'Views',
    defaultChord: 'Mod+3',
    description: 'Switch to the commit history view.',
  },
  {
    id: 'view.changes',
    label: 'Go to Working changes',
    group: 'Views',
    defaultChord: 'Mod+4',
    description: 'Switch to the unstaged and staged changes view.',
  },
  {
    id: 'view.pullRequests',
    label: 'Go to Pull requests',
    group: 'Views',
    defaultChord: 'Mod+5',
    description: 'Switch to the Pull requests list.',
  },
  {
    id: 'view.stashes',
    label: 'Go to Stashes',
    group: 'Views',
    defaultChord: 'Mod+6',
    description: 'Switch to the Stashes view.',
  },
]

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((def) => [def.id, def.defaultChord]),
) as Record<ShortcutId, string>

export interface NormalizedChord {
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
}

export function parseChord(chord: string): NormalizedChord | null {
  const parts = chord
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  let mod = false
  let shift = false
  let alt = false
  let key: string | null = null

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'mod' || lower === 'cmd' || lower === 'ctrl') {
      mod = true
    } else if (lower === 'shift') {
      shift = true
    } else if (lower === 'alt' || lower === 'opt' || lower === 'option') {
      alt = true
    } else {
      if (key !== null) return null
      key = part
    }
  }

  if (!key) return null
  return {
    key: normalizeKeyName(key),
    mod,
    shift,
    alt,
  }
}

function normalizeKeyName(rawKey: string): string {
  const lower = rawKey.toLowerCase()
  if (lower === 'enter' || lower === 'return') return 'Enter'
  if (lower === 'arrowup' || lower === 'up') return 'ArrowUp'
  if (lower === 'arrowdown' || lower === 'down') return 'ArrowDown'
  if (lower === 'arrowleft' || lower === 'left') return 'ArrowLeft'
  if (lower === 'arrowright' || lower === 'right') return 'ArrowRight'
  if (lower === 'escape' || lower === 'esc') return 'Escape'
  if (lower === 'space' || lower === ' ') return 'Space'
  if (lower === 'tab') return 'Tab'
  if (rawKey.length === 1) return lower
  return rawKey
}

export function canonicalChord(chord: string): string | null {
  const parsed = parseChord(chord)
  if (!parsed) return null
  const parts: string[] = []
  if (parsed.mod) parts.push('Mod')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key)
  return parts.join('+')
}

export function formatChord(chord: string, isMac = isMacPlatform()): string {
  const parsed = parseChord(chord)
  if (!parsed) return chord

  const keyLabel = formatKey(parsed.key, isMac)
  if (isMac) {
    let result = ''
    if (parsed.alt) result += '⌥'
    if (parsed.shift) result += '⇧'
    if (parsed.mod) result += '⌘'
    result += keyLabel
    return result
  }

  const parts: string[] = []
  if (parsed.mod) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(keyLabel)
  return parts.join('+')
}

function formatKey(key: string, isMac: boolean): string {
  if (key === 'ArrowUp') return isMac ? '↑' : 'Up'
  if (key === 'ArrowDown') return isMac ? '↓' : 'Down'
  if (key === 'ArrowLeft') return isMac ? '←' : 'Left'
  if (key === 'ArrowRight') return isMac ? '→' : 'Right'
  if (key === 'Enter') return isMac ? '↵' : 'Enter'
  if (key === 'Escape') return 'Esc'
  if (key === 'Space') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}

export interface KeyboardEventLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  target?: EventTarget | null
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.userAgent)
}

export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as { tagName?: string; isContentEditable?: boolean }
  if (element.isContentEditable) return true
  const tag = element.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function chordFromEvent(event: KeyboardEventLike, isMac = isMacPlatform()): string | null {
  const rawKey = event.key
  if (rawKey === 'Control' || rawKey === 'Meta' || rawKey === 'Alt' || rawKey === 'Shift') {
    return null
  }

  const modPressed = isMac ? Boolean(event.metaKey) : Boolean(event.ctrlKey)
  const altPressed = Boolean(event.altKey)
  const shiftPressed = Boolean(event.shiftKey)

  const parts: string[] = []
  if (modPressed) parts.push('Mod')
  if (altPressed) parts.push('Alt')
  if (shiftPressed) parts.push('Shift')
  parts.push(normalizeKeyName(rawKey))

  return canonicalChord(parts.join('+'))
}

export function matchesChord(
  event: KeyboardEventLike,
  chord: string,
  isMac = isMacPlatform(),
): boolean {
  const parsed = parseChord(chord)
  if (!parsed) return false

  const modPressed = isMac ? Boolean(event.metaKey) : Boolean(event.ctrlKey)
  if (parsed.mod !== modPressed) return false
  if (parsed.alt !== Boolean(event.altKey)) return false

  const normalizedEventKey = normalizeKeyName(event.key)

  if (parsed.shift !== Boolean(event.shiftKey)) return false

  return normalizedEventKey.toLowerCase() === parsed.key.toLowerCase()
}

export interface ShortcutCollision {
  idA: ShortcutId
  idB: ShortcutId
  chord: string
}

export function detectShortcutConflicts(
  bindings: Partial<Record<ShortcutId, string>>,
): ShortcutCollision[] {
  const merged: Record<ShortcutId, string> = { ...DEFAULT_SHORTCUTS, ...bindings }
  const canonicalMap = new Map<string, ShortcutId>()
  const collisions: ShortcutCollision[] = []

  for (const def of SHORTCUT_DEFINITIONS) {
    const chord = merged[def.id]
    if (!chord) continue
    const canon = canonicalChord(chord)
    if (!canon) continue

    const existing = canonicalMap.get(canon)
    if (existing && existing !== def.id) {
      collisions.push({ idA: existing, idB: def.id, chord: canon })
    } else {
      canonicalMap.set(canon, def.id)
    }
  }

  return collisions
}

export interface AssignShortcutResult {
  bindings: Record<ShortcutId, string>
  conflict: { conflictingId: ShortcutId; chord: string } | null
}

export function assignShortcut(
  current: Record<ShortcutId, string>,
  id: ShortcutId,
  newChord: string,
): AssignShortcutResult {
  const canon = canonicalChord(newChord)
  if (!canon) {
    throw new Error(`Invalid shortcut chord "${newChord}".`)
  }

  const existingOwner = (Object.entries(current) as [ShortcutId, string][]).find(
    ([otherId, chord]) => otherId !== id && canonicalChord(chord) === canon,
  )

  if (existingOwner) {
    return {
      bindings: current,
      conflict: { conflictingId: existingOwner[0], chord: canon },
    }
  }

  return {
    bindings: {
      ...current,
      [id]: canon,
    },
    conflict: null,
  }
}

export const SHORTCUT_STORAGE_KEY = 'git-stacks.shortcuts.v1'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function loadShortcuts(
  storage: StorageLike | null = getStorage(),
): Record<ShortcutId, string> {
  if (!storage) return { ...DEFAULT_SHORTCUTS }
  try {
    const raw = storage.getItem(SHORTCUT_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SHORTCUTS }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SHORTCUTS }

    const sanitized: Partial<Record<ShortcutId, string>> = {}
    for (const def of SHORTCUT_DEFINITIONS) {
      const val = parsed[def.id]
      if (typeof val === 'string' && canonicalChord(val)) {
        sanitized[def.id] = canonicalChord(val)!
      }
    }
    const withDefaults: Record<ShortcutId, string> = { ...DEFAULT_SHORTCUTS, ...sanitized }
    const conflicts = detectShortcutConflicts(withDefaults)
    if (conflicts.length > 0) {
      for (const c of conflicts) {
        withDefaults[c.idB] = DEFAULT_SHORTCUTS[c.idB]
      }
    }
    return withDefaults
  } catch {
    return { ...DEFAULT_SHORTCUTS }
  }
}

export function saveShortcuts(
  bindings: Record<ShortcutId, string>,
  storage: StorageLike | null = getStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(bindings))
  } catch {
    // Ignore storage quota or disabled storage
  }
}

export function resetShortcuts(
  storage: StorageLike | null = getStorage(),
): Record<ShortcutId, string> {
  if (storage) {
    try {
      storage.removeItem(SHORTCUT_STORAGE_KEY)
    } catch {
      // ignore
    }
  }
  return { ...DEFAULT_SHORTCUTS }
}

function getStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}
