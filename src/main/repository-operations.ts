import { CommandCancelled } from './git-core'

export class RepositoryOperations {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  read<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(operation, signal)
  }

  write<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) {
      return Promise.reject(
        new Error('Another repository operation is still running. Wait for it to finish.'),
      )
    }
    return this.enqueue(operation)
  }

  switchRepository<T>(operation: () => Promise<T>): Promise<T> {
    // Unlike a user mutation, a repository switch must wait for the old
    // repository's cancelled reads to release the queue, not reject the switch.
    return this.enqueue(operation)
  }

  private enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.pending += 1
    const result = this.tail
      .then(() => {
        // A read cancelled while it waited in the queue never starts at all.
        if (signal?.aborted) throw new CommandCancelled()
        return operation()
      })
      .finally(() => {
        this.pending -= 1
      })
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
