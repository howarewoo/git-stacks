import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandCancelled } from '../src/main/git-core'
import { RepositoryScheduler } from '../src/main/repository-scheduler'

test('a held mutation keeps its own answer while a queued read is cancelled before release', async () => {
  const scheduler = new RepositoryScheduler(2)
  const mutationEntered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const mutation = scheduler.mutate('/primary', async () => {
    mutationEntered.resolve()
    await release.promise
    return 'completed-effect'
  })
  await mutationEntered.promise
  const controller = new AbortController()
  const queuedRead = scheduler.read(
    '/primary',
    async () => assert.fail('The cancelled queued read must never run'),
    controller.signal,
  )
  controller.abort()
  release.resolve()
  const readSettled = await queuedRead.catch((error: unknown) => error)
  assert.equal(
    await mutation,
    'completed-effect',
    'Queued read cancellation must not override the held mutation result',
  )
  assert.ok(
    readSettled instanceof CommandCancelled,
    'The cancelled queued read rejects with cancel identity',
  )
  assert.equal(await scheduler.read('/primary', async () => 'later-effect'), 'later-effect')
})
