import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandCode, commandDetail, executeCapped } from './git-core'

/** A rename inside one filesystem is a directory entry update, not a copy. */
const PROMOTION_TIMEOUT_MS = 60_000
const PROMOTION_OUTPUT_BYTES = 8 * 1024

/** Exit codes the helper contract defines; see `native/promote-repository.c`. */
const EXIT_USAGE = 2
const EXIT_DESTINATION_EXISTS = 3
const EXIT_UNSUPPORTED = 4
const EXIT_CROSS_DEVICE = 5

/**
 * Why a promotion did not move the clone. Every refusal is reported; none of
 * them falls back to a rename that could replace a destination.
 */
export type PromotionRefusal = 'exists' | 'unsupported' | 'cross-device' | 'unavailable' | 'failed'

export type PromotionResult =
  | { moved: true }
  | { moved: false; refusal: PromotionRefusal; detail: string }

let resourcesRoot: string | null = null

/**
 * Points the promotion at this build's resources directory. The main process
 * configures it next to the Git runtime; without it the helper is resolved
 * beside the source tree, which is where `pnpm test` and `pnpm run dev` find it.
 */
export function configurePromotionHelper(root: string | null): void {
  resourcesRoot = root
}

function helperPath(): string {
  const base = resourcesRoot ?? fileURLToPath(new URL('../../resources', import.meta.url))
  return join(
    base,
    'promote',
    process.platform === 'win32' ? 'promote-repository.exe' : 'promote-repository',
  )
}

/**
 * Moves the finished clone to its destination with one atomic rename that
 * refuses to replace anything already there.
 *
 * The rename itself is a single syscall on the platform — `renamex_np` with
 * `RENAME_EXCL` on Darwin, `renameat2` with `RENAME_NOREPLACE` on Linux, and a
 * `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` on Windows — so the commit
 * point of a clone cannot be separated from the claim of its destination. A
 * kernel or filesystem without that primitive, and a build whose helper is
 * missing, are both reported as refusals: this never degrades into a
 * check-then-rename, which would destroy a directory another program owns.
 */
export async function promoteRepository(
  staging: string,
  destination: string,
): Promise<PromotionResult> {
  const executable = helperPath()
  if (!(await runnable(executable))) {
    return {
      moved: false,
      refusal: 'unavailable',
      detail: `No promotion helper at ${executable}. Rebuild or reinstall Git Stacks.`,
    }
  }
  try {
    await executeCapped(executable, [staging, destination], dirname(destination), {
      maxBytes: PROMOTION_OUTPUT_BYTES,
      timeoutMs: PROMOTION_TIMEOUT_MS,
    })
    return { moved: true }
  } catch (error) {
    const code = commandCode(error)
    if (code === EXIT_DESTINATION_EXISTS) return { moved: false, refusal: 'exists', detail: '' }
    if (code === EXIT_UNSUPPORTED) {
      return { moved: false, refusal: 'unsupported', detail: commandDetail(error) }
    }
    if (code === EXIT_CROSS_DEVICE) {
      return { moved: false, refusal: 'cross-device', detail: commandDetail(error) }
    }
    if (code === 'ENOENT' || code === 'EACCES' || code === EXIT_USAGE) {
      return { moved: false, refusal: 'unavailable', detail: commandDetail(error) }
    }
    return { moved: false, refusal: 'failed', detail: commandDetail(error) }
  }
}

async function runnable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}
