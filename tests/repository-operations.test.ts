import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandCancelled } from '../src/main/git-core'
import { RepositoryOperations } from '../src/main/repository-operations'
import { RepositoryScheduler } from '../src/main/repository-scheduler'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('concurrent preview reads wait for a write and see only the completed state', async () => {
  const operations = new RepositoryOperations()
  const started = gate()
  const finish = gate()
  let state = 'before'
  const write = operations.write(async () => {
    state = 'partial'
    started.release()
    await finish.promise
    state = 'committed'
  })
  await started.promise
  const first = operations.read(async () => state)
  const second = operations.read(async () => state)
  finish.release()
  assert.deepEqual(await Promise.all([first, second]), ['committed', 'committed'])
  await write
})

test('failed reads do not prevent queued previews or later writes', async () => {
  const operations = new RepositoryOperations()
  const failure = new Error('GitHub temporarily unavailable')
  const first = operations.read(async () => {
    throw failure
  })
  const rejected = assert.rejects(first, (error) => error === failure)
  const next = operations.read(async () => ({ head: 'reviewed', mergeable: true }))
  await rejected
  assert.deepEqual(await next, { head: 'reviewed', mergeable: true })
  let state = 'unmerged'
  await operations.write(async () => {
    state = 'merged'
  })
  assert.equal(await operations.read(async () => state), 'merged')
})

test('a write waits for the reads already running instead of being refused', async () => {
  const operations = new RepositoryOperations()
  const finishRead = gate()
  const order: string[] = []
  const read = operations.read(async () => {
    order.push('read start')
    await finishRead.promise
    order.push('read end')
    return 'conflicted'
  })
  const write = operations.write(async () => {
    order.push('write')
  })
  finishRead.release()
  assert.equal(await read, 'conflicted')
  await write
  // The mutation ran after the read it was submitted during, never inside it.
  assert.deepEqual(order, ['read start', 'read end', 'write'])
  // A read asked for after the write was submitted still sees its result.
  assert.equal(await operations.read(async () => order.at(-1)), 'write')
})

test('a second write is refused while a write is pending and never runs', async () => {
  const operations = new RepositoryOperations()
  const finishWrite = gate()
  let changed = false
  const write = operations.write(async () => {
    await finishWrite.promise
  })
  await assert.rejects(
    operations.write(async () => {
      changed = true
    }),
  )
  finishWrite.release()
  await write
  assert.equal(changed, false)
})

test('a pending repository switch refuses mutations and still answers the reads behind it', async () => {
  const operations = new RepositoryOperations()
  const finishSwitch = gate()
  let selected: string | null = null
  const switching = operations.switchRepository('second', async () => {
    await finishSwitch.promise
    selected = 'second'
  })

  let mutated = false
  await assert.rejects(
    operations.write(async () => {
      mutated = true
    }),
  )
  // A read asked for during the switch still waits its turn rather than failing:
  // it revalidates the repository it belongs to before it answers.
  const reading = operations.read(async () => selected)
  finishSwitch.release()
  await switching
  assert.equal(selected, 'second')
  assert.equal(mutated, false)
  assert.equal(await reading, 'second')

  // The repository that is open now accepts the action again.
  await operations.write(async () => {
    mutated = true
  }, 'second')
  assert.equal(mutated, true)
})

test('an action admitted after a switch completed is refused instead of reaching the repository it left', async () => {
  const operations = new RepositoryOperations()
  await operations.switchRepository('/repositories/second', async () => 'second')

  // The queue is free when the action asks for admission: the switch it raced
  // with finished while it was still waiting to be admitted, so nothing but the
  // repository identity can refuse it.
  let mutated: string | null = null
  await assert.rejects(
    operations.write(async () => {
      mutated = 'first'
    }, '/repositories/first'),
  )
  assert.equal(mutated, null)

  // An action aimed at the repository the window shows now runs as usual.
  await operations.write(async () => {
    mutated = 'second'
  }, '/repositories/second')
  assert.equal(mutated, 'second')
})

test('a failed switch leaves the previous repository open and writable', async () => {
  const operations = new RepositoryOperations()
  await operations.switchRepository('/repositories/first', async () => 'first')
  await assert.rejects(
    operations.switchRepository('/repositories/broken', async () => {
      throw new Error('not a repository')
    }),
  )
  let mutated: string | null = null
  await operations.write(async () => {
    mutated = 'first'
  }, '/repositories/first')
  assert.equal(mutated, 'first')
})

test('an action that waited for a stalled background read is refused after the switch it raced', async () => {
  const operations = new RepositoryOperations()
  const scheduler = new RepositoryScheduler()
  const first = '/repositories/first'
  await operations.switchRepository(first, async () => 'first')

  // A background read stuck on a network is why the action cannot be admitted
  // yet, and ending it is what lets the mutation into the repository lane.
  const inFlight = Promise.withResolvers<never>()
  const stalled = scheduler.read(first, (signal) => {
    signal.addEventListener(
      'abort',
      () => {
        inFlight.reject(new CommandCancelled())
      },
      { once: true },
    )
    return inFlight.promise
  })
  const rejected = assert.rejects(stalled, (error: unknown) => error instanceof CommandCancelled)
  await new Promise((resolve) => setImmediate(resolve))

  let mutated: string | null = null
  const action = scheduler.mutate(first, () =>
    operations.write(async () => {
      mutated = 'first'
    }, first),
  )
  // The switch is queued on the operation lane, which the stalled read never
  // held, so it completes while the action is still waiting to be admitted.
  await operations.switchRepository('/repositories/second', async () => 'second')
  await assert.rejects(action)
  await rejected
  assert.equal(mutated, null, 'the action must not reach the repository the window left')
})

test('runtime preference changes are serialized through repository operations and cannot disrupt an in-flight write', async () => {
  const operations = new RepositoryOperations()
  const started = gate()
  const finish = gate()
  let actionCompleted = false

  const inFlightWrite = operations.write(async () => {
    started.release()
    await finish.promise
    actionCompleted = true
  })

  await started.promise

  let preferenceChanged = false
  await assert.rejects(
    operations.write(async () => {
      preferenceChanged = true
    }),
  )

  assert.equal(preferenceChanged, false)
  finish.release()
  await inFlightWrite
  assert.equal(actionCompleted, true)
})
