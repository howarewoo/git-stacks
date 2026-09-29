import type {
  Branch,
  Commit,
  MergeAction,
  MergeMethod,
  GitAction,
  PublishLayerChoice,
  PushPreview,
  StackKind,
  StackPreview,
  SurgeryPreview,
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
      /** Direct or merge-queue delivery; `default` follows the repository's own policy. */
      mergeAction: MergeAction
    }
  | {
      kind: 'submit'
      preview: StackPreview
      allowForce: boolean
      layers: Record<string, PublishLayerChoice>
      /** Exact branch name the person typed before remote history may be replaced. */
      confirmation: string
      confirmationTarget: string | null
    }
  | {
      kind: 'surgery'
      preview: SurgeryPreview
      allowForce: boolean
      closePullRequests: boolean
      /** Exact branch name the person typed before remote history may be replaced. */
      confirmation: string
      confirmationTarget: string | null
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
  sync: 'Sync',
}

export function stackActionLabel(operation: StackKind): string {
  return `${stackLabels[operation]}${operation === 'merge' ? '' : ' stack'}`
}

const surgeryLabels: Record<SurgeryPreview['kind'], string> = {
  insert: 'Insert a stack layer',
  move: 'Move a stack layer',
  remove: 'Remove a stack layer',
}

export function surgeryActionLabel(operation: SurgeryPreview['kind']): string {
  return surgeryLabels[operation]
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
    case 'surgery':
      return surgeryActionLabel(input.preview.kind)
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
    case 'stack': {
      if (!input.preview || input.preview.blockers.length > 0) return null
      // A sync that would replace published history cannot be dispatched without the
      // explicit lease approval, and replacing it needs the typed branch name on top.
      const forcePushes = input.preview.sync?.forcePushes ?? []
      if (forcePushes.length > 0 && !input.allowForce) return null
      if (
        input.allowForce &&
        (input.confirmationTarget === null || input.confirmation !== input.confirmationTarget)
      )
        return null
      if (input.preview.kind !== 'merge') {
        return {
          type: 'executeStack',
          token: input.preview.token,
          allowForce: input.allowForce,
          mergeMethod: 'squash',
        }
      }
      const merge = input.preview.merge
      if (!merge || !merge.actions.includes(input.mergeAction)) return null
      // A queued merge runs the repository's own merge settings, so a method is only sent
      // for a direct merge; sending one for a queue merge would be a request GitHub does
      // not document it honours. The builder refuses a direct merge with no supported method
      // independently of the guard, so a bypassed guard cannot dispatch one.
      const direct = input.mergeAction === 'direct_merge'
      const method = input.mergeMethod as MergeMethod
      if (direct && !input.preview.mergeMethods.includes(method)) return null
      return {
        type: 'executeStack',
        token: input.preview.token,
        allowForce: input.allowForce,
        mergeMethod: direct ? method : 'squash',
        mergeAction: input.mergeAction,
      }
    }
    case 'submit': {
      if (!input.preview.publish || input.preview.publish.layers.length === 0) return null
      if (input.preview.blockers.length > 0) return null
      // Replacing remote history needs the exact branch name typed, the same rule the guard
      // applies. The builder refuses independently so a bypassed guard still cannot dispatch
      // a force push nobody confirmed.
      if (input.allowForce && input.confirmation !== input.confirmationTarget) return null
      return {
        type: 'submitStack',
        token: input.preview.token,
        allowForce: input.allowForce,
        layers: input.layers,
      }
    }
    case 'surgery': {
      if (!input.preview || input.preview.blockers.length > 0) return null
      // Replacing published history and closing submitted pull requests are separate
      // decisions, and each one needs its own explicit approval. The builder refuses
      // independently so a bypassed guard still cannot dispatch an unconfirmed rewrite.
      if (input.preview.forcePushes.length > 0 && !input.allowForce) return null
      if (input.preview.closes.length > 0 && !input.closePullRequests) return null
      if (
        input.allowForce &&
        (input.confirmationTarget === null || input.confirmation !== input.confirmationTarget)
      )
        return null
      return {
        type: 'executeSurgery',
        token: input.preview.token,
        allowForce: input.allowForce,
        closePullRequests: input.closePullRequests,
      }
    }
  }
}
