import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  sameOperationScope,
  type OperationProgress,
  type OperationScope,
} from '@git-stacks/shared/operation-scope'
import type { DesktopAPI, MergeProgress, MergeStatus } from '@git-stacks/shared/types'

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

/** Captured operations keep their journal projection independently of the visible surface. */
export function useOperationProgressProjection(
  desktop: DesktopAPI | null,
  scope: OperationScope | null,
) {
  const queryClient = useQueryClient()
  const keys = React.useMemo(
    () =>
      scope
        ? operationProgressKeys(scope)
        : {
            publication: ['operation-publication', null],
            merge: ['operation-merge', null],
            mergeProgress: ['operation-merge-progress', null],
          },
    [scope],
  )
  // Zero-lifetime caches stay observed for the captured owner's lifetime, not the dialog's.
  useQuery({ queryKey: keys.publication, enabled: false })
  useQuery({ queryKey: keys.merge, enabled: false })
  useQuery({ queryKey: keys.mergeProgress, enabled: false })
  React.useEffect(() => {
    if (!scope) return
    const { publication: publicationKey, merge: mergeKey, mergeProgress: mergeProgressKey } = keys
    let active = true
    let publicationRevision = 0
    let mergeRevision = 0
    const unsubscribePublication = desktop?.onSubmitStackProgress?.((event) => {
      if (!active || !sameOperationScope(event.scope, scope)) return
      const revision = ++publicationRevision
      void queryClient.cancelQueries({ queryKey: publicationKey, exact: true }).then(() => {
        if (active && revision === publicationRevision)
          queryClient.setQueryData(publicationKey, event)
      })
    })
    const unsubscribeMerge = desktop?.onMergeProgress?.((event) => {
      if (!active || !sameOperationScope(event.scope, scope)) return
      const revision = ++mergeRevision
      void queryClient.cancelQueries({ queryKey: mergeKey, exact: true }).then(() => {
        if (active && revision === mergeRevision)
          queryClient.setQueryData(mergeProgressKey, event.progress === null ? null : event)
      })
    })
    if (desktop?.submitStackProgress) {
      void queryClient
        .fetchQuery({
          queryKey: publicationKey,
          queryFn: async ({ signal }) => {
            const value = await readOperationProgress(desktop.submitStackProgress!, scope, signal)
            if (!active || signal.aborted) throw new Error('Retired publication read')
            return value
          },
        })
        .catch(() => {})
    }
    if (desktop?.mergeStatus) {
      void queryClient
        .fetchQuery({
          queryKey: mergeKey,
          queryFn: async ({ signal }) => {
            const value = await readOperationProgress(desktop.mergeStatus!, scope, signal)
            if (!active || signal.aborted) throw new Error('Retired merge read')
            queryClient.setQueryData<OperationProgress<MergeProgress> | null>(
              mergeProgressKey,
              (previous) => mergeProgressAfterRead(previous, value),
            )
            return value
          },
        })
        .catch(() => {})
    }
    return () => {
      active = false
      unsubscribePublication?.()
      unsubscribeMerge?.()
      void queryClient.cancelQueries({ queryKey: publicationKey, exact: true })
      void queryClient.cancelQueries({ queryKey: mergeKey, exact: true })
      queryClient.removeQueries({ queryKey: publicationKey, exact: true })
      queryClient.removeQueries({ queryKey: mergeKey, exact: true })
      queryClient.removeQueries({ queryKey: mergeProgressKey, exact: true })
    }
  }, [desktop, queryClient, scope, keys])
}
