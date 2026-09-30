import type { CloneProtocol, RepositoryCloneResult } from '../shared/types'
import type { CloneOptions, CloneOutcome } from './clone-repository'
import { cloneCommandText, ghCloneCommandText } from './github-repositories'

/** A clone request whose repository, folder name, and destination all passed validation. */
export interface ValidatedClone {
  url: string
  fullName: string
  /** The host that owns the repository, and therefore the clone. */
  host: string
  parentDirectory: string
  directoryName: string
  protocol: CloneProtocol
  shallow: boolean
}

/**
 * The two things a clone request needs from the rest of the application: the
 * clone itself, and the switch that opens and registers what it produced.
 */
export interface CloneRequestPorts {
  /** Runs the clone, honouring the signal up to its commit point. */
  clone(options: CloneOptions): Promise<CloneOutcome>
  /** Opens the finished clone and makes it the active repository. */
  activate(path: string): Promise<unknown>
}

/**
 * Runs one clone request from a validated request to a registered repository.
 *
 * The promotion inside `clone` is the commit point. Before it, every byte of the
 * clone is in a private staging folder that a cancellation discards. After it,
 * the clone is a finished repository in the folder the person chose, so the
 * switch that registers it runs without the signal: a cancellation that arrives
 * past the commit point completes the switch and reports the clone as finished,
 * rather than reporting a cancelled clone the request then deletes while recents
 * and the active repository still name it. Nothing removes the promoted folder
 * afterwards, which is why the switch needs no ownership token of its own.
 */
export async function runCloneRequest(
  clone: ValidatedClone,
  signal: AbortSignal,
  ports: CloneRequestPorts,
): Promise<RepositoryCloneResult> {
  const outcome = await ports.clone({ ...clone, signal })
  await ports.activate(outcome.path)
  return {
    path: outcome.path,
    name: clone.directoryName,
    empty: outcome.empty,
    gitCommand: cloneCommandText(
      clone.url,
      clone.parentDirectory,
      clone.directoryName,
      clone.shallow,
    ),
    ghCommand: ghCloneCommandText(
      clone.fullName,
      clone.parentDirectory,
      clone.directoryName,
      clone.shallow,
      clone.host === 'github.com' ? undefined : clone.url,
    ),
  }
}
