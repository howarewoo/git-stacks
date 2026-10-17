import type { Branch, RepositorySnapshot } from '@git-stacks/shared/types'

/**
 * What a window may keep on screen after the credential behind GitHub was
 * actually replaced.
 *
 * Everything GitHub answered belongs to the credential that asked: the pull
 * requests on the list, the issues attached to a branch, the native-stack
 * preview, and — the part that is easy to miss — the pull request each branch
 * itself carries. A branch's local facts are its own: what exists, what is
 * checked out, how far ahead or behind it is, what it points at, and the commit
 * it names are all still true and stay. What is dropped is only what that
 * credential read, so the window shows local work without showing another
 * account's GitHub underneath it, and the next refresh repopulates the rest.
 */
export function withoutReplacedCredential(snapshot: RepositorySnapshot): RepositorySnapshot {
  return {
    ...snapshot,
    pullRequests: [],
    issues: [],
    nativeStacks: [],
    nativeStackPreviewAvailable: undefined,
    nativeStackMessage: undefined,
    reconciliation: undefined,
    github: { available: false, message: 'Reading GitHub again as this account.' },
    branches: snapshot.branches.map(withoutReplacedCredentialBranch),
  }
}

/** One branch, dropping remote ancestry as well as the pull request it held. */
export function withoutReplacedCredentialBranch(branch: Branch): Branch {
  const remoteParent = branch.parentSource === 'pullRequest' || branch.parentSource === 'stack'
  if (branch.pr === null && !remoteParent) return branch
  return {
    ...branch,
    pr: null,
    // Native-stack and pull-request ancestry came from the retired authority.
    // Recorded and locally inferred relationships remain valid.
    parent: remoteParent ? null : branch.parent,
    parentBehind: remoteParent ? null : branch.parentBehind,
    parentSource: remoteParent ? null : branch.parentSource,
    parentTip: remoteParent ? null : branch.parentTip,
    needsRestack: remoteParent ? undefined : branch.needsRestack,
  }
}
