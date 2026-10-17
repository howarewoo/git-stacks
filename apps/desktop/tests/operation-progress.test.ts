import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MergeLayerResult, MergeProgress } from '@git-stacks/shared/types'
import type { OperationProgress } from '@git-stacks/shared/operation-scope'
import {
  mergeProgressAfterRead,
  readOperationProgress,
} from '../src/renderer/src/lib/operation-progress'

const scope = {
  repositoryPath: '/captured/repository',
  remoteUrl: 'https://github.com/acme/widgets.git',
  authority: 'captured-A',
}
function layer(number: number, status: MergeLayerResult['status']): MergeLayerResult {
  return {
    branch: `branch-${number}`,
    pullRequest: number,
    status,
    detail: status,
    mergedOid: null,
    queue: null,
    requestUuid: null,
  }
}
function captured(layers: MergeLayerResult[]): OperationProgress<MergeProgress> {
  return {
    scope,
    source: 'action',
    progress: { action: 'default', status: 'failed', layers, message: 'Captured action stopped' },
  }
}

test('merge read joins only captured identities and retains a never-journalled failed target', () => {
  const result = mergeProgressAfterRead(
    captured([layer(1, 'pending'), layer(2, 'not-requested')]),
    {
      scope,
      source: 'journal-read',
      progress: {
        layers: [layer(1, 'merged'), layer(99, 'failed')],
        message: 'Repository history',
      },
    },
  )
  assert.deepEqual(
    result?.progress?.layers.map((row) => [row.pullRequest, row.status]),
    [
      [1, 'merged'],
      [2, 'not-requested'],
    ],
  )
  assert.equal(result?.progress?.status, 'running')
  assert.match(result?.progress?.message ?? '', /1 of 2 captured/)
})

test('an omitted captured failure does not disappear when the read returns no journal', () => {
  const result = mergeProgressAfterRead(captured([layer(1, 'failed')]), {
    scope,
    source: 'journal-read',
    progress: null,
  })
  assert.equal(result?.progress?.layers[0]?.status, 'failed')
  assert.equal(result?.progress?.status, 'failed')
  assert.equal(result?.source, 'journal-read')
})

test('a fully confirmed captured run ignores unrelated historical failures', () => {
  const result = mergeProgressAfterRead(captured([layer(1, 'pending')]), {
    scope,
    source: 'journal-read',
    progress: { layers: [layer(1, 'merged'), layer(99, 'failed')], message: 'Older failure' },
  })
  assert.equal(result?.progress?.status, 'succeeded')
  assert.equal(result?.progress?.layers.length, 1)
})

test('late read and null outcomes retain actual origin and reject a replacement authority', async () => {
  await assert.rejects(
    readOperationProgress(
      async () => ({ scope, source: 'action', progress: null }),
      { ...scope, authority: 'replacement-B' },
      new AbortController().signal,
    ),
    /retired/,
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    readOperationProgress(
      async () => ({ scope, source: 'journal-read', progress: null }),
      scope,
      controller.signal,
    ),
    /retired/,
  )
  const value = await readOperationProgress(
    async () => ({ scope, source: 'journal-read', progress: null }),
    scope,
    new AbortController().signal,
  )
  assert.deepEqual(value, { scope, source: 'journal-read', progress: null })
})
