import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COMMAND_CANCELLATION_ATTEMPT } from '@git-stacks/shared/cancellation'
import { errorMessage } from '../src/renderer/src/lib/error-message'

test('renderer error messages recognize cloned cancellation data without hiding genuine failures', () => {
  const cancellation = structuredClone(COMMAND_CANCELLATION_ATTEMPT)
  assert.equal(cancellation instanceof Error, false)
  assert.equal(errorMessage(cancellation), 'The request was cancelled.')
  assert.equal(
    errorMessage(cancellation, 'GitHub did not return review data.'),
    'The request was cancelled.',
  )
  assert.equal(errorMessage(new Error('Provider refused')), 'Provider refused')
  assert.equal(errorMessage('Permission denied'), 'Permission denied')
  assert.equal(errorMessage({ cancelled: true }, 'Unknown failure'), 'Unknown failure')
})
