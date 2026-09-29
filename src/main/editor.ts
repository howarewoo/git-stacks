import { spawn } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promises as fs } from 'node:fs'
import { SUPPORTED_EDITORS } from '../shared/settings'

/** The editor used when settings name none. Only what the platform ships. */
const PLATFORM_EDITOR =
  process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open'

/**
 * Resolves the program to launch. A configured name wins; otherwise the
 * platform's own opener is used, and a platform that has none is reported
 * rather than guessed at.
 */
export function resolveEditorCommand(configured: string | null): {
  command: string | null
  reason: string
} {
  if (configured) {
    if ((SUPPORTED_EDITORS as readonly string[]).includes(configured)) {
      return { command: configured, reason: 'the editor configured in Settings' }
    }
    return { command: null, reason: `${configured} is not a supported editor` }
  }
  if (PLATFORM_EDITOR) {
    return { command: PLATFORM_EDITOR, reason: 'this platform’s default application handler' }
  }
  return { command: null, reason: 'no default application handler exists on this platform' }
}

/**
 * Confirms the file is inside the repository before it is handed to a process.
 * A relative path from the renderer is resolved against the repository root and
 * must not climb out of it, so no absolute path and no traversal reaches the
 * launcher.
 */
export async function resolveInsideRepository(
  repositoryRoot: string,
  relativePath: string,
): Promise<{ absolute: string } | { error: string }> {
  if (isAbsolute(relativePath)) {
    return { error: 'The path must be relative to the repository.' }
  }
  let canonicalRepoRoot: string
  try {
    canonicalRepoRoot = await fs.realpath(repositoryRoot)
  } catch {
    return { error: 'The repository directory no longer exists.' }
  }
  const rawAbsolute = resolve(canonicalRepoRoot, relativePath)
  const rawInside = relative(canonicalRepoRoot, rawAbsolute)
  if (rawInside === '' || rawInside.startsWith('..') || isAbsolute(rawInside)) {
    return { error: 'That file is outside the repository.' }
  }
  let canonicalTarget: string
  try {
    canonicalTarget = await fs.realpath(rawAbsolute)
  } catch {
    return { error: 'That file no longer exists.' }
  }
  const inside = relative(canonicalRepoRoot, canonicalTarget)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { error: 'That file is outside the repository.' }
  }
  try {
    const stat = await fs.stat(canonicalTarget)
    if (!stat.isFile()) return { error: 'That path is not a file.' }
  } catch {
    return { error: 'That file no longer exists.' }
  }
  return { absolute: canonicalTarget }
}

export interface OpenResult {
  opened: boolean
  reason: string
}

/**
 * Opens a file in the configured editor. The editor is spawned detached with the
 * absolute path as its only argument and the window hidden: Git Stacks does not
 * wait on it and does not read what it writes.
 */
export async function openInEditor(
  configured: string | null,
  repositoryRoot: string,
  relativePath: string,
): Promise<OpenResult> {
  const target = await resolveInsideRepository(repositoryRoot, relativePath)
  if ('error' in target) return { opened: false, reason: target.error }

  const { command, reason } = resolveEditorCommand(configured)
  if (!command) return { opened: false, reason }

  // A program that is not installed must be reported before anything is
  // launched. Starting a detached child cannot answer this on its own: `spawn`
  // does not fail for a name it cannot find, it emits an error later, so
  // claiming a launch here would report a success that never happened.
  const located = await locateTool(command, null)
  if (!located.available) {
    return { opened: false, reason: `${command} is not installed on this computer.` }
  }

  // Existence is not launchability: an executable script whose shebang names an
  // interpreter this machine lacks passes `locateTool` and still fails to
  // start. The child's own `spawn` event is the only thing that answers
  // "did it actually start", so success waits for it rather than assuming.
  const started = await new Promise<{ ok: true } | { ok: false; message: string }>((settle) => {
    let child
    try {
      child = spawn(command, [target.absolute], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      settle({ ok: false, message: (error as Error).message })
      return
    }
    child.once('spawn', () => settle({ ok: true }))
    child.once('error', (error: Error) => settle({ ok: false, message: error.message }))
  })
  if (!started.ok) {
    return { opened: false, reason: `Could not start ${command}: ${started.message}` }
  }
  return { opened: true, reason: `Opened with ${command} (${reason}).` }
}
/**
 * Whether a configured program exists on this machine. Settings accept any
 * program name, so the surface needs to name a missing one before an action is
 * attempted. The lookup only asks whether the file is executable; it never
 * starts the program, which for an editor would open a window.
 */
export async function locateTool(
  configured: string | null,
  fallback: string | null,
): Promise<{ available: boolean; label: string }> {
  const command = configured ?? fallback
  if (!command) return { available: false, label: 'none configured' }
  if (isAbsolute(command)) {
    return { available: await isExecutable(command), label: command }
  }
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const directory of (process.env.PATH ?? '').split(separator)) {
    if (!directory) continue
    for (const extension of extensions) {
      if (await isExecutable(resolve(directory, `${command}${extension}`))) {
        return { available: true, label: command }
      }
    }
  }
  return { available: false, label: command }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await fs.access(path, fs.constants.X_OK)
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}
