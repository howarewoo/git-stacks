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
    description: 'Open the palette to search actions, branches, PRs, issues, and repositories.',
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
    label: 'Sync stack',
    group: 'Stack navigation',
    defaultChord: 'Mod+Shift+S',
    description:
      'Fetch and prune the remotes, then preview replaying this stack onto its trunk, with per-layer merged, rebase, force-with-lease, and blocked states.',
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
  // "Plus" is the canonical key name; accept a trailing literal + when reading a chord.
  const encoded = chord.endsWith('+') ? `${chord.slice(0, -1)}Plus` : chord
  const parts = encoded.split('+').map((p) => p.trim())
  if (parts.length === 0 || parts.some((part) => !part)) return null

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
  const normalizedKey = normalizeKeyName(key)
  return {
    key: normalizedKey,
    mod,
    shift: shift && !isPrintableSymbol(normalizedKey),
    alt,
  }
}

function isPrintableSymbol(key: string): boolean {
  return key.length === 1 && !/[\p{L}\p{N}]/u.test(key)
}

/**
 * Canonical spellings for the named keys a chord can end with. Dispatch compares
 * key names case-insensitively, so `Home` and `home` are one keystroke there;
 * resolving every alias to a single spelling keeps collision detection, the
 * reserved-opener check, and dispatch describing the same set of chords.
 */
const CANONICAL_KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  plus: '+',
  enter: 'Enter',
  return: 'Enter',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdown: 'PageDown',
  pgdn: 'PageDown',
  insert: 'Insert',
  ins: 'Insert',
  delete: 'Delete',
  del: 'Delete',
  backspace: 'Backspace',
  bksp: 'Backspace',
  capslock: 'CapsLock',
  numlock: 'NumLock',
  scrolllock: 'ScrollLock',
  printscreen: 'PrintScreen',
  contextmenu: 'ContextMenu',
  menu: 'ContextMenu',
  pause: 'Pause',
}

function normalizeKeyName(rawKey: string): string {
  const lower = rawKey.toLowerCase()
  const named = CANONICAL_KEY_NAMES[lower]
  if (named) return named
  if (rawKey.length === 1) return lower
  // Function keys arrive as `F5` from a real keydown and as `f5` from a
  // hand-edited binding; both are the same key.
  const functionKey = /^f(\d{1,2})$/.exec(lower)
  if (functionKey) return `F${functionKey[1]}`
  // Any other named key has one spelling too. Dispatch compares key names
  // case-insensitively, so `Clear` and `clear` are a single keystroke there
  // and must be a single chord here; the lower-case form is the one a real
  // keydown never contradicts. Tables would go stale on the next key the
  // browser adds, so the equivalence is derived instead of enumerated.
  return lower
}

export function canonicalChord(chord: string): string | null {
  const parsed = parseChord(chord)
  if (!parsed) return null
  const parts: string[] = []
  if (parsed.mod) parts.push('Mod')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key === '+' ? 'Plus' : parsed.key)
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
  // Named keys the canonical table does not list keep the initial capital the
  // keyboard itself writes them with.
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/**
 * Serializes a chord for `aria-keyshortcuts`, which expects the DOM
 * `KeyboardEvent.key` modifier names joined with `+` rather than the platform
 * glyphs `formatChord` draws. `Mod` resolves to the primary modifier token of
 * the platform the chord is dispatched on.
 */
export function ariaKeyShortcuts(chord: string, isMac = isMacPlatform()): string {
  const parsed = parseChord(chord)
  if (!parsed) return ''

  const parts: string[] = []
  if (parsed.mod) parts.push(isMac ? 'Meta' : 'Control')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key === '+' ? 'Plus' : ariaKeyName(parsed.key))
  return parts.join('+')
}

function ariaKeyName(key: string): string {
  // Single characters name themselves; a letter is written in upper case, the
  // spelling the ARIA key table uses and the one the drawn label shows. Named
  // keys use the `KeyboardEvent.key` spelling, including any key the table
  // does not enumerate.
  if (key.length === 1) return key.toUpperCase()
  return key.charAt(0).toUpperCase() + key.slice(1)
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

/**
 * True while an IME composition is in flight. Such a keydown belongs to
 * committing or cancelling a candidate rather than to a real keystroke, so it
 * must neither fire a global shortcut nor dismiss a dialog.
 */
export function isComposingKeyEvent(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229
}

export function chordFromEvent(event: KeyboardEventLike, isMac = isMacPlatform()): string | null {
  const rawKey = event.key
  if (rawKey === 'Control' || rawKey === 'Meta' || rawKey === 'Alt' || rawKey === 'Shift') {
    return null
  }

  // Only Mod denotes the platform primary modifier. Never turn the other modifier
  // into an unmodified shortcut (or silently drop it when both are pressed).
  if (isMac ? event.ctrlKey : event.metaKey) return null
  const modPressed = isMac ? Boolean(event.metaKey) : Boolean(event.ctrlKey)
  const altPressed = Boolean(event.altKey)
  const shiftPressed = Boolean(event.shiftKey) && !isPrintableSymbol(normalizeKeyName(rawKey))

  const parts: string[] = []
  if (modPressed) parts.push('Mod')
  if (altPressed) parts.push('Alt')
  if (shiftPressed) parts.push('Shift')
  parts.push(rawKey === '+' ? 'Plus' : normalizeKeyName(rawKey))

  return canonicalChord(parts.join('+'))
}

export function matchesChord(
  event: KeyboardEventLike,
  chord: string,
  isMac = isMacPlatform(),
): boolean {
  const parsed = parseChord(chord)
  if (!parsed) return false
  if (isMac ? event.ctrlKey : event.metaKey) return false

  const modPressed = isMac ? Boolean(event.metaKey) : Boolean(event.ctrlKey)
  if (parsed.mod !== modPressed) return false
  if (parsed.alt !== Boolean(event.altKey)) return false

  const normalizedEventKey = normalizeKeyName(event.key)

  if (parsed.shift !== (Boolean(event.shiftKey) && !isPrintableSymbol(normalizedEventKey)))
    return false

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

/**
 * Keys the open command palette handles itself, mapped to the role each one
 * plays there. The opener is the only global shortcut that stays live while the
 * palette is open, so an unmodified binding on one of these keys would make the
 * palette toggle, navigate, or dismiss itself mid-interaction.
 */
const PALETTE_LOCAL_KEY_ROLES: Record<string, string> = {
  Enter: 'selecting or confirming the highlighted item',
  ArrowUp: 'moving to the previous result',
  ArrowDown: 'moving to the next result',
  Home: 'jumping to the first result',
  End: 'jumping to the last result',
  Escape: 'dismissing the palette',
}

/**
 * Returns the palette role an unmodified chord would take over, or null when
 * the chord is free to bind. Modified chords are not reserved: an event the
 * palette already handled never reaches a global shortcut, so ownership
 * settles their behavior instead.
 */
function reservedPaletteKeyRole(chord: string): string | null {
  const parsed = parseChord(chord)
  if (!parsed || parsed.mod || parsed.alt || parsed.shift) return null
  return PALETTE_LOCAL_KEY_ROLES[parsed.key] ?? null
}

export interface AssignShortcutResult {
  bindings: Record<ShortcutId, string>
  conflict: { conflictingId: ShortcutId; chord: string } | null
  /** Set when the opener was given a key the open palette handles itself. */
  reserved: { chord: string; role: string } | null
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

  if (id === 'palette.open') {
    const role = reservedPaletteKeyRole(canon)
    if (role) return { bindings: current, conflict: null, reserved: { chord: canon, role } }
  }

  const existingOwner = (Object.entries(current) as [ShortcutId, string][]).find(
    ([otherId, chord]) => otherId !== id && canonicalChord(chord) === canon,
  )

  if (existingOwner) {
    return {
      bindings: current,
      conflict: { conflictingId: existingOwner[0], chord: canon },
      reserved: null,
    }
  }

  return {
    bindings: {
      ...current,
      [id]: canon,
    },
    conflict: null,
    reserved: null,
  }
}

export const SHORTCUT_STORAGE_KEY = 'git-stacks.shortcuts.v1'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Resets conflicting bindings to their defaults until no chord has two owners.
 * The action listed first keeps the contested chord; when the default the later
 * action would be reset to is itself taken, the earlier owner is reset instead,
 * so a restored default can never leave a duplicate behind. Defaults are
 * collision-free, so each pass settles at least one binding and the loop ends
 * on a set without duplicates.
 */
function resolveShortcutCollisions(bindings: Record<ShortcutId, string>): void {
  for (let pass = 0; pass < SHORTCUT_DEFINITIONS.length; pass += 1) {
    const conflicts = detectShortcutConflicts(bindings)
    if (conflicts.length === 0) return
    let changed = false
    for (const { idA, idB } of conflicts) {
      const loser = bindings[idB] === DEFAULT_SHORTCUTS[idB] ? idA : idB
      if (bindings[loser] === DEFAULT_SHORTCUTS[loser]) continue
      bindings[loser] = DEFAULT_SHORTCUTS[loser]
      changed = true
    }
    if (!changed) return
  }
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
    // A stored opener on a palette-local key cannot be honored, because the
    // open palette consumes that keystroke itself. Fall back to the default
    // before conflicts are resolved, so a chord that fallback hands out is
    // detected like any other instead of quietly doubling up.
    if (reservedPaletteKeyRole(withDefaults['palette.open'])) {
      withDefaults['palette.open'] = DEFAULT_SHORTCUTS['palette.open']
    }
    resolveShortcutCollisions(withDefaults)
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
