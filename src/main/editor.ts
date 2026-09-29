import { spawn } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promises as fs } from 'node:fs'
import { SUPPORTED_EDITORS } from '../shared/settings'

export interface EditorInvocation {
  command: string
  args: string[]
  reason: string
}

/**
 * Resolves the program and invocation arguments to launch. A configured name
 * wins if allowlisted. Otherwise a platform-specific text editor adapter is
 * used (e.g. macOS 'open -t' to force opening in the default text editor and
 * avoid executing executable scripts).
 */
export function resolveEditorInvocation(configured: string | null, targetPath: string): {
  invocation: EditorInvocation | null
  reason: string
} {
  if (configured) {
    if ((SUPPORTED_EDITORS as readonly string[]).includes(configured)) {
      return {
        invocation: { command: configured, args: [targetPath], reason: 'the editor configured in Settings' },
        reason: 'the editor configured in Settings',
      }
    }
    return { invocation: null, reason: `${configured} is not a supported editor` }
  }
  if (process.platform === 'darwin') {
    return {
      invocation: { command: 'open', args: ['-t', targetPath], reason: 'the default text editor on macOS' },
      reason: 'this platform’s default text editor',
    }
  }
  if (process.platform === 'win32') {
    return {
      invocation: { command: 'notepad', args: [targetPath], reason: 'Notepad' },
      reason: 'this platform’s default text editor',
    }
  }
  return {
    invocation: { command: 'gedit', args: [targetPath], reason: 'default text editor' },
    reason: 'this platform’s default text editor',
  }
}

export function resolveEditorCommand(configured: string | null): {
  command: string | null
  reason: string
} {
  const resolved = resolveEditorInvocation(configured, '')
  return {
    command: resolved.invocation?.command ?? null,
    reason: resolved.reason,
  }
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

  const { invocation, reason } = resolveEditorInvocation(configured, target.absolute)
  if (!invocation) return { opened: false, reason }

  const located = await locateTool(invocation.command, null)
  if (!located.available) {
    return { opened: false, reason: `${invocation.command} is not installed on this computer.` }
  }

  const started = await new Promise<{ ok: true } | { ok: false; message: string }>((settle) => {
    let child
    try {
      child = spawn(invocation.command, invocation.args, {
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
    return { opened: false, reason: `Could not start ${invocation.command}: ${started.message}` }
  }
  return { opened: true, reason: `Opened with ${invocation.command} (${reason}).` }
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
