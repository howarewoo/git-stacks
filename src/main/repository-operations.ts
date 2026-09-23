export class RepositoryOperations {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  read<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation)
  }

  write<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) {
      return Promise.reject(
        new Error('Another repository operation is still running. Wait for it to finish.'),
      )
    }
    return this.enqueue(operation)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pending += 1
    const result = this.tail.then(operation).finally(() => {
      this.pending -= 1
    })
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
