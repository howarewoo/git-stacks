import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import type {
  ChildProcess,
  ExecFileOptions,
  execFile as ExecFileFunction,
  execFileSync as ExecFileSyncFunction,
} from 'node:child_process'

/** A concurrent Git mutation injected at the moment Git Stacks starts real Git. */
interface GitRaceScenario {
  /** Claims the one Git invocation this race waits for. */
  matches(args: readonly string[]): boolean
  /** Applies the mutation before the claimed invocation runs. */
  inject(): void
}

export interface GitRace {
  end(): void
}

type ExecFileDone = (error: Error | null, stdout: string, stderr: string) => void

interface ExecFileBoundary {
  (
    file: string,
    args?: readonly string[],
    options?: ExecFileOptions,
    callback?: ExecFileDone,
  ): ChildProcess
  /**
   * Node's own promisified form of `execFile`. Git Stacks wraps `execFile` with
   * `promisify` when its modules load, and `promisify` hands back this form, so
   * the shim has to carry it to keep intercepting the calls Git Stacks makes.
   */
  [promisify.custom]: (
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
  ) => Promise<{ stdout: string; stderr: string }>
}

/**
 * Git Stacks runs every Git command through the promisified `execFile` boundary
 * below, so a race is injected by wrapping it: the armed scenario runs real Git,
 * then the original spawn runs with the arguments Git Stacks passed. Nothing has
 * to be launchable from disk, which is what lets macOS, Linux, and Windows run
 * the same race, because `child_process` cannot execute an extensionless script
 * or a `.cmd` file without a shell. Git Stacks' other spawn boundary is the
 * `update-ref --stdin` ref transaction, which no race claims.
 *
 * Git Stacks captures `execFile` when its modules load, and an ESM named import
 * of a builtin keeps the export it saw when that builtin was first linked, so
 * this module installs the shim before the test file loads Git Stacks itself.
 */
const nodeRequire = createRequire(import.meta.url)
const childProcess = nodeRequire('node:child_process') as {
  execFile: ExecFileBoundary
  execFileSync: typeof ExecFileSyncFunction
}
const realExecFile = childProcess.execFile
const realPromisifiedExecFile = realExecFile[promisify.custom]

let armed: { scenario: GitRaceScenario; injected: boolean } | null = null

function isGitCommand(file: string): boolean {
  const name = file.split(/[\\/]/u).pop()
  return name === 'git' || name === 'git.exe'
}

function injectRace(file: string, args: readonly string[]): void {
  const race = armed
  if (!race || race.injected || !isGitCommand(file) || !race.scenario.matches(args)) return
  race.injected = true
  race.scenario.inject()
}

function execFileWithRace(
  file: string,
  args: readonly string[] = [],
  options?: ExecFileOptions,
  callback?: ExecFileDone,
): ChildProcess {
  if (typeof options === 'function') {
    callback = options
    options = undefined
  }
  injectRace(file, args)
  return realExecFile(file, args, options, callback)
}

childProcess.execFile = Object.assign(execFileWithRace, {
  [promisify.custom]: (file: string, args: readonly string[], options: ExecFileOptions) => {
    injectRace(file, args)
    return realPromisifiedExecFile(file, args, options)
  },
})

/** Arms a race that injects at most once, then disarms it. */
export function beginGitRace(scenario: GitRaceScenario): GitRace {
  if (armed) throw new Error('A Git race is already armed.')
  armed = { scenario, injected: false }
  return {
    end() {
      armed = null
    },
  }
}

/** Runs real Git in a repository, outside any armed race, and returns its output. */
export function runRealGit(cwd: string, args: readonly string[]): string {
  return childProcess
    .execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    .trim()
}
