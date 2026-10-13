import type { DesktopAPI } from '@git-stacks/shared/types'
import type { InspectionContext } from '@git-stacks/shared/inspection'
import {
  sameOperationScope,
  type OperationCapture,
  type OperationScope,
} from '@git-stacks/shared/operation-scope'
import { inspectionAPI } from './inspection-api'

/** A preview reload mints fresh local safety facts; only explicit dispatch spends them. */
export function operationInspectionAPI(
  api: DesktopAPI,
  target: InspectionContext,
  expected: OperationScope,
  accept: (capture: OperationCapture) => void,
): DesktopAPI {
  const context = {
    repositoryId: target.repositoryId,
    worktreeId: target.worktreeId,
    pullRequestId: target.pullRequestId,
  }
  return inspectionAPI(api, context, undefined, async (operation) => {
    if (
      ![
        'stackPreview',
        'surgeryPreview',
        'pushPreview',
        'reconciliationPreview',
        'reviewedMergePreview',
      ].includes(operation)
    )
      return context
    if (!api.captureOperation) throw new Error('Captured operation authority is unavailable.')
    const value = await api.captureOperation(target)
    if (!sameOperationScope(expected, value.scope))
      throw new Error(
        'Original provider authority changed; approval cannot move to another account or repository.',
      )
    accept(value)
    return { ...context, operationToken: value.token }
  })
}
