import { CommandCancelled } from './git-core'

/**
 * The one queue every Git operation the main process runs against the open
 * repository passes through.
 *
 * Reads and writes share it, so a mutation never interleaves with a read, and
 * two mutations never run at the same time. A write is refused only while
 * another write or a repository switch is pending — the two cases where the
 * work behind it is aimed at a repository that is being changed underneath it.
 * A second mutation was built from a state the first is about to change, and
 * running it afterwards would apply it to a repository nobody reviewed; a
 * switch is the window opening a different repository, and an action asked for
 * against the one being left must not land there.
 *
 * A pending read is no reason to refuse a mutation. This queue guarantees only
 * ordering: a mutation that waited for the reads ahead of it ran after all of
 * them, and no other write or repository switch could interleave with it. What
 * an action then checks is that action's own business, unchanged by the wait.
 * Refusing the mutation instead strands the person: the conflict resolver
 * stages its result while the view reads that describe the conflict are still
 * being answered, and every one of those attempts failed.
 */
export class RepositoryOperations {
  private tail: Promise<void> = Promise.resolve()
  private writing = 0
  private switching = 0

  read<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(operation, signal)
  }

  write<T>(operation: () => Promise<T>): Promise<T> {
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

  switchRepository<T>(operation: () => Promise<T>): Promise<T> {
    // Unlike a user mutation, a repository switch must wait for the old
    // repository's cancelled reads to release the queue, not reject the switch.
    this.switching += 1
    return this.enqueue(operation).finally(() => {
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
