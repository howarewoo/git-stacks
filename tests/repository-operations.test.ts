import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RepositoryOperations } from '../src/main/repository-operations'

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
  const switching = operations.switchRepository(async () => {
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
  })
  assert.equal(mutated, true)
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
