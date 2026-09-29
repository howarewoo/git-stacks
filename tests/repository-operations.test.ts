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

test('writes are rejected, not queued, while reads or other writes are pending', async () => {
  const operations = new RepositoryOperations()
  const finish = gate()
  let changed = false
  const read = operations.read(async () => {
    await finish.promise
    return 'snapshot'
  })
  await assert.rejects(
    operations.write(async () => {
      changed = true
    }),
  )
  finish.release()
  await read
  assert.equal(changed, false)

  const finishWrite = gate()
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
    /Another repository operation is still running/u,
  )

  assert.equal(preferenceChanged, false)
  finish.release()
  await inFlightWrite
  assert.equal(actionCompleted, true)
})
