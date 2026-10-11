import {
  sameOperationScope,
  type OperationProgress,
  type OperationScope,
} from '@git-stacks/shared/operation-scope'
import type { MergeProgress, MergeStatus } from '@git-stacks/shared/types'

/** Shell and recovery dialogs observe one scoped projection of the durable journal. */
export function operationProgressKeys(scope: OperationScope) {
  const identity = [scope.repositoryPath, scope.remoteUrl, scope.authority] as const
  return {
    publication: ['operation-publication', ...identity],
    merge: ['operation-merge', ...identity],
    mergeProgress: ['operation-merge-progress', ...identity],
  }
}

export async function readOperationProgress<T>(
  read: () => Promise<OperationProgress<T>>,
  scope: OperationScope,
  signal: AbortSignal,
): Promise<OperationProgress<T>> {
  const result = await read()
  if (signal.aborted || !sameOperationScope(result.scope, scope)) {
    throw new Error('This recovery read belongs to a retired repository or account.')
  }
  return result
}

/** Repository history may omit failed/not-requested targets; omission cannot complete a run. */
export function mergeProgressAfterRead(
  previous: OperationProgress<MergeProgress> | null | undefined,
  read: OperationProgress<MergeStatus>,
): OperationProgress<MergeProgress> | null {
  if (!previous?.progress) return null
  const layers = previous.progress.layers.map(
    (layer) =>
      read.progress?.layers.find((observed) => observed.pullRequest === layer.pullRequest) ?? layer,
  )
  const merged = layers.filter((layer) => layer.status === 'merged').length
  return {
    scope: read.scope,
    source: 'journal-read',
    progress: {
      ...previous.progress,
      layers,
      status: layers.some((layer) => layer.status === 'failed')
        ? 'failed'
        : merged === layers.length
          ? 'succeeded'
          : layers.every((layer) => layer.status === 'merged' || layer.status === 'enqueued')
            ? 'queued'
            : 'running',
      message: `${merged} of ${layers.length} captured pull requests are confirmed merged. Other outcomes remain as reported; omitted targets are not assumed complete.`,
    },
  }
}
