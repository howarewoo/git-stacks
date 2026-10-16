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
  original: OperationCapture,
  current: () => boolean,
  accept: (capture: OperationCapture) => void,
): DesktopAPI {
  const context = {
    repositoryId: target.repositoryId,
    worktreeId: target.worktreeId,
    pullRequestId: target.pullRequestId,
  }
  return inspectionAPI(api, context, current, async (operation) => {
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
    if (!current())
      throw new Error(
        'The original provider session retired; authored input cannot be requalified.',
      )
    if (!api.captureOperation) throw new Error('Captured operation authority is unavailable.')
    const value = await api.captureOperation(target)
    if (
      !current() ||
      !sameOperationScope(expected, value.scope) ||
      value.repositoryId !== original.repositoryId ||
      value.worktreeId !== original.worktreeId ||
      value.worktreePath !== original.worktreePath ||
      value.directoryIdentity !== original.directoryIdentity ||
      value.commonDirectory !== original.commonDirectory ||
      value.commonIdentity !== original.commonIdentity ||
      value.gitDirectory !== original.gitDirectory ||
      value.gitDirectoryIdentity !== original.gitDirectoryIdentity
    )
      throw new Error(
        'Original physical directory or provider authority changed; authored input cannot move to a replacement owner.',
      )
    accept(value)
    return { ...context, operationToken: value.token }
  })
}
