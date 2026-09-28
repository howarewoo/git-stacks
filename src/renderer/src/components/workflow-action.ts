import type {
  Branch,
  Commit,
  GitAction,
  PublishLayerChoice,
  PushPreview,
  StackKind,
  StackPreview,
} from '../../../shared/types'

/**
 * Builds the exact Git action payload for a reviewed workflow, or `null` when
 * the inputs cannot produce a truthful one. Both live together on purpose: a
 * missing captured OID, an incomplete typed confirmation, or a blocked preview
 * must never reach the dispatcher, so the refusal and the payload are the same
 * decision.
 */

export type WorkflowActionInput =
  | { kind: 'rename'; branch: Branch; name: string }
  | { kind: 'deleteRemote'; branch: Branch; confirmation: string }
  | { kind: 'parent'; branch: Branch; name: string }
  | { kind: 'upstream'; branch: Branch; name: string }
  | { kind: 'pull'; strategy: 'ff-only' | 'merge' | 'rebase' }
  | { kind: 'merge'; ref: string }
  | { kind: 'stash'; message: string; includeUntracked: boolean }
  | { kind: 'forcePush'; push: PushPreview | null; confirmation: string }
  | { kind: 'commitAction'; commit: Commit; mode: 'cherryPick' | 'revert'; mainline: string }
  | { kind: 'confirm'; action: GitAction; label: string }
  | { kind: 'pr'; number: number; title: string; body: string; draft: boolean }
  | {
      kind: 'stack'
      operation: StackKind
      preview: StackPreview
      allowForce: boolean
      /** Exact branch name the person typed before remote history may be replaced. */
      confirmation: string
      confirmationTarget: string | null
      mergeMethod: string
    }
  | {
      kind: 'submit'
      preview: StackPreview
      allowForce: boolean
      layers: Record<string, PublishLayerChoice>
    }

/** The repository state captured when the dialog opened. */
export interface WorkflowActionContext {
  headOid: string | null
  currentBranch: string | null
}

const stackLabels: Record<StackKind, string> = {
  restack: 'Restack',
  publish: 'Publish',
  merge: 'Merge pull request',
}

export function stackActionLabel(operation: StackKind): string {
  return `${stackLabels[operation]}${operation === 'merge' ? '' : ' stack'}`
}

export function workflowActionLabel(input: WorkflowActionInput): string {
  switch (input.kind) {
    case 'rename':
      return 'Rename branch'
    case 'deleteRemote':
      return 'Delete remote branch'
    case 'parent':
      return 'Set stack parent'
    case 'upstream':
      return 'Set upstream'
    case 'pull':
      return 'Pull changes'
    case 'merge':
      return 'Merge branch'
    case 'stash':
      return 'Stash changes'
    case 'forcePush':
      return 'Force push with lease'
    case 'commitAction':
      return input.mode === 'cherryPick' ? 'Cherry-pick commit' : 'Revert commit'
    case 'stack':
      return stackActionLabel(input.operation)
    case 'submit':
      return 'Submit stack'
    case 'pr':
      return 'Update pull request'
    case 'confirm':
      return input.label
  }
}

function expectedHeadRef(currentBranch: string | null): string {
  return currentBranch ? `refs/heads/${currentBranch}` : 'HEAD'
}

export function workflowAction(
  input: WorkflowActionInput,
  context: WorkflowActionContext,
): GitAction | null {
  switch (input.kind) {
    case 'rename':
      return { type: 'renameBranch', ref: input.branch.ref, name: input.name.trim() }
    case 'deleteRemote':
      // Deleting a remote branch is only safe against a captured remote tip.
      if (!input.branch.oid || input.confirmation !== input.branch.name) return null
      return { type: 'deleteRemoteBranch', ref: input.branch.ref, expectedOid: input.branch.oid }
    case 'parent':
      return { type: 'setParent', branch: input.branch.name, parent: input.name }
    case 'upstream':
      return { type: 'setUpstream', ref: input.branch.ref, upstream: input.name || null }
    case 'pull':
      return { type: 'pull', strategy: input.strategy }
    case 'merge':
      if (!context.headOid) return null
      return {
        type: 'merge',
        ref: input.ref,
        expectedHead: context.headOid,
        expectedHeadRef: expectedHeadRef(context.currentBranch),
      }
    case 'stash':
      return {
        type: 'stash',
        message: input.message.trim(),
        includeUntracked: input.includeUntracked,
      }
    case 'forcePush':
      if (!input.push || input.confirmation !== input.push.branch) return null
      return { type: 'forcePush', preview: input.push }
    case 'commitAction':
      if (!context.headOid) return null
      return {
        type: input.mode,
        oid: input.commit.oid,
        expectedHead: context.headOid,
        expectedHeadRef: expectedHeadRef(context.currentBranch),
        mainline: input.mainline ? Number(input.mainline) : null,
      }
    case 'confirm':
      return input.action
    case 'pr':
      return {
        type: 'updatePr',
        number: input.number,
        title: input.title.trim(),
        body: input.body,
        draft: input.draft,
      }
    case 'stack':
      if (!input.preview || input.preview.blockers.length > 0) return null
      // Replacing remote history needs the typed name even when force is allowed.
      if (
        input.allowForce &&
        (input.confirmationTarget === null || input.confirmation !== input.confirmationTarget)
      )
        return null
      return {
        type: 'executeStack',
        token: input.preview.token,
        allowForce: input.allowForce,
        mergeMethod: (input.mergeMethod || 'squash') as 'merge' | 'squash' | 'rebase',
      }
    case 'submit': {
      if (!input.preview.publish || input.preview.publish.layers.length === 0) return null
      if (input.preview.blockers.length > 0) return null
      return {
        type: 'submitStack',
        token: input.preview.token,
        allowForce: input.allowForce,
        layers: input.layers,
      }
    }
  }
}
