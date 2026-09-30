import { CommandCancelled } from './git-core'

/**
 * The one queue every Git operation the main process runs against the open
 * repository passes through.
 *
 * Reads and writes share it, so a mutation never interleaves with a read, and
 * two mutations never run at the same time. A write is refused only while
 * another write or a repository switch is pending, and when the repository it
 * was asked for is no longer the one the window shows. The first two cases are
 * work that is queued ahead of it; the third is work that lost its subject: a
 * switch completes while the mutation is still waiting to be admitted, and an
 * action built against the repository being left must not land there once the
 * window is showing another one.
 *
 * A pending read is no reason to refuse a mutation. This queue guarantees only
 * ordering: a mutation that waited for the reads ahead of it ran after all of
 * them, and no other write or repository switch could interleave with it. What
 * an action then checks is that action's own business, unchanged by the wait.
 * Refusing the mutation instead strands the person: the conflict resolver
 * stages its result while the view reads that describe the conflict are still
 * being answered, and every one of those attempts failed.
 */

/** The refusal for an action whose repository the window has already left. */
export function supersededRepositoryError(): Error {
  return new Error('The active repository changed. Run the action again once it opens.')
}

export class RepositoryOperations {
  private tail: Promise<void> = Promise.resolve()
  private writing = 0
  private switching = 0
  /**
   * The repository the window is showing, once a switch has completed. It is
   * what a mutation names when it asks for admission.
   */
  private current: string | null = null

  read<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(operation, signal)
  }

  /**
   * A mutation. `repository` is the repository the action was built against,
   * or omitted for work that belongs to none (the Git runtime preference).
   */
  write<T>(operation: () => Promise<T>, repository?: string): Promise<T> {
    // Admission is synchronous: a switch cannot complete between this check and
    // the enqueue below, so a refused action never reaches Git at all.
    if (repository !== undefined && repository !== this.current) {
      return Promise.reject(supersededRepositoryError())
    }
    if (this.writing > 0) {
      return Promise.reject(
        new Error('Another repository operation is still running. Wait for it to finish.'),
      )
    }
    if (this.switching > 0) {
      return Promise.reject(
        new Error('The active repository is changing. Run the action again once it opens.'),
      )
    }
    this.writing += 1
    return this.enqueue(operation).finally(() => {
      this.writing -= 1
    })
  }

  switchRepository<T>(repository: string, operation: () => Promise<T>): Promise<T> {
    // Unlike a user mutation, a repository switch must wait for the old
    // repository's cancelled reads to release the queue, not reject the switch.
    this.switching += 1
    return this.enqueue(async () => {
      const result = await operation()
      // The window shows this repository only once the switch itself succeeded;
      // a failed switch leaves the previous one open and still writable.
      this.current = repository
      return result
    }).finally(() => {
      this.switching -= 1
    })
  }

  private enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(() => {
      // A read cancelled while it waited in the queue never starts at all.
      if (signal?.aborted) throw new CommandCancelled()
      return operation()
    })
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
