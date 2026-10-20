import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMMAND_CANCELLATION_WIRE,
  isCommandCancellationWire,
} from '@git-stacks/shared/cancellation'

// The shipped preload's invoke decoder narrows with this exact token before any
// `DesktopAPI` promise exists; the page-world crossing itself is the packaged
// smoke's cancellation scenario.
test('the internal cancellation wire is an exact one-field token a genuine result cannot collide with', () => {
  assert.deepEqual(structuredClone(COMMAND_CANCELLATION_WIRE), { commandCancellation: true })
  assert.equal(isCommandCancellationWire(COMMAND_CANCELLATION_WIRE), true)
  // A genuine result that merely carries a like-named field is never the token:
  // narrowing is exact so an answering operation can never be decoded as cancelled.
  for (const underestimate of [
    null,
    undefined,
    'cancelled',
    0,
    true,
    { commandCancellation: 'yes' },
    { commandCancellation: true, repositoryPath: '/somewhere' },
    { cancelled: true },
  ]) {
    assert.equal(isCommandCancellationWire(underestimate), false)
  }
})
