import type { DesktopAPI } from '@git-stacks/shared/types'
import {
  INSPECTION_CHANNELS,
  type InspectionContext,
  type InspectionOperation,
  type InspectionArgs,
} from '@git-stacks/shared/inspection'
const globalServices: Record<string, true> = {
  openExternal: true,
  onGitHubCliStatus: true,
  onSubmitStackProgress: true,
  onMergeProgress: true,
  operationSafety: true,
}

/** Existing review consumers receive captured methods, never the active checkout's API. */
export function inspectionAPI(
  api: DesktopAPI,
  context: InspectionContext,
  isCurrent?: () => boolean,
  prepare?: (operation: InspectionOperation) => Promise<InspectionContext>,
): DesktopAPI {
  const scoped = { ...api }
  for (const [name, value] of Object.entries(scoped)) {
    if (
      typeof value === 'function' &&
      !Object.hasOwn(globalServices, name) &&
      !Object.hasOwn(INSPECTION_CHANNELS, name)
    )
      Object.defineProperty(scoped, name, {
        value: name.startsWith('on')
          ? undefined
          : () =>
              Promise.reject(
                new Error(
                  `The ${name} operation requires an explicit operational or global context.`,
                ),
              ),
        enumerable: true,
        configurable: true,
        writable: true,
      })
  }
  const requests = new Map<string, Map<string, InspectionContext>>()
  for (const operation of Object.keys(INSPECTION_CHANNELS) as InspectionOperation[]) {
    if (operation === 'cancel') continue
    Object.defineProperty(scoped, operation, {
      value: async (...args: InspectionArgs<typeof operation>) => {
        if (isCurrent && !isCurrent())
          throw new Error('The captured provider session changed; reopen this source explicitly.')
        if (!api.inspect)
          throw new Error('Selected-context inspection is unavailable in this runtime.')
        const requestContext = prepare ? await prepare(operation) : context
        const id = `inspection-${crypto.randomUUID()}`
        const explicitId =
          operation === 'history' ||
          operation === 'reviewHistoryDiff' ||
          operation === 'pullRequestLayer'
            ? args[2]
            : operation === 'commitDiff' ||
                operation === 'branchCommits' ||
                [
                  'reviewHeadline',
                  'reviewFiles',
                  'reviewCommits',
                  'reviewThreads',
                  'reviewHistory',
                ].includes(operation)
              ? args[1]
              : undefined
        const key =
          typeof explicitId === 'string'
            ? explicitId
            : operation === 'fileView'
              ? `file:${args[0]}`
              : operation === 'conflictView'
                ? `conflict:${args[0]}`
                : operation.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
        const pending = requests.get(key) ?? new Map<string, InspectionContext>()
        pending.set(id, requestContext)
        requests.set(key, pending)
        try {
          const result = await api.inspect(requestContext, operation, args, id)
          if (isCurrent && !isCurrent())
            throw new Error('The captured provider session changed; this response was retired.')
          return result
        } finally {
          pending.delete(id)
          if (!pending.size) requests.delete(key)
        }
      },
      enumerable: true,
    })
  }
  scoped.cancel = async (requestId) => {
    if (!api.inspect) return
    for (const [id, requestContext] of requests.get(requestId) ?? [])
      await api.inspect(requestContext, 'cancel', [id])
  }
  scoped.runAction = () =>
    Promise.reject(new Error('Inspection does not authorize a Git mutation.'))
  return scoped
}
