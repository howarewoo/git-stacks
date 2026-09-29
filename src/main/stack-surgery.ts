import type {
  SurgeryLayer,
  SurgeryPlanPreview,
  SurgeryRequest,
  SyncPushKind,
} from '../shared/types'
import type { SyncRemoteRelation } from './sync-stack'

export type { SurgeryRequest } from '../shared/types'

/** A layer the surgery leaves alone still has a plan state while the range is walked. */
type PlanAction = SurgeryLayer['action'] | 'keep'

/**
 * Everything one layer contributes to a surgery, captured from real Git and
 * from the pull request GitHub reported. A layer is never described by a
 * relationship the capture did not prove: the boundary, the merge count, the
 * remote relation and the pull request head are all read before the preview
 * exists, and a value that cannot be proven is a blocker rather than a guess.
 */
export interface SurgeryLayerFacts {
  branch: string
  /** The parent this layer hangs from, already skipping merged layers. */
  parent: string
  /** The parent recorded in branch metadata, which the surgery changes. */
  recordedParent: string | null
  /** The boundary recorded in branch metadata, restored when a surgery is aborted. */
  recordedParentTip: string | null
  /** The immutable replay boundary: the parent tip this layer's commits were built on. */
  boundary: string
  boundarySource: 'recorded' | 'merge-base'
  /** The local tip captured when the preview was taken. */
  oid: string
  /** The remote tip captured when the preview was taken, and the lease a force push names. */
  remoteOid: string | null
  remoteRelation: SyncRemoteRelation
  commits: number
  mergeCommits: number
  pullRequest: number | null
  pullRequestBase: string | null
  pullRequestState: 'OPEN' | 'CLOSED' | 'MERGED' | null
  /** The layer's own pull request already merged, so GitHub will not retarget it. */
  merged: boolean
  /** The head commit GitHub records for the pull request when the preview was taken. */
  headOid: string | null
  /** The head repository of the pull request, when it has one. */
  headRepository: string | null
  blockers: string[]
}

/** The native stack that currently holds the submitted layers of this stack. */
export interface SurgeryStackFacts {
  number: number
  base: string
  /** Member pull request numbers, bottom-to-top as GitHub orders them. */
  members: number[]
}

export interface SurgeryCapture {
  /** The remote the surgery reads leases from, and the push URL it publishes to. */
  remote: string | null
  pushUrl: string | null
  trunk: string
  trunkOid: string
  stack: SurgeryStackFacts | null
  /** Whether this repository can use the native stacks API at all. */
  stackCapability: 'available' | 'unavailable'
  /** Every local branch name, so an inserted name is checked against the repository. */
  localBranches: readonly string[]
  /** Every layer of the stack bottom-to-top, merged layers included. */
  layers: SurgeryLayerFacts[]
}

/** One layer the run rewrites, replayed bottom-to-top through the stack journal. */
export interface SurgeryPlanLayer {
  branch: string
  action: SurgeryLayer['action']
  fromParent: string
  toParent: string
  /** The parent ref the replay targets; a replayed parent is resolved from the journal. */
  parentRef: string
  /** The parent tip captured when the preview was taken. */
  parentOid: string
  oldTip: string
  boundary: string
  boundarySource: 'recorded' | 'merge-base'
  commits: number
  push: SyncPushKind
  remoteOid: string | null
  /** The journal replays this layer; a pure retarget keeps the same commits. */
  replay: boolean
}

/** One pull request change the reviewed surgery makes, in the order it runs. */
export interface SurgeryPullRequestPlan {
  branch: string
  number: number
  action: 'retarget' | 'close'
  /** The head ref GitHub recorded when the preview was taken. */
  headRef: string
  /** The head commit GitHub recorded when the preview was taken. */
  headOid: string | null
  /** The base GitHub recorded when the preview was taken. */
  fromBase: string
  toBase: string
}

export interface SurgeryPlan {
  request: SurgeryRequest
  trunk: string
  /** The stack bottom-to-top after the surgery. */
  order: string[]
  /** The branch this surgery creates, at the tip its parent carried in the preview. */
  inserted: { branch: string; parent: string; oid: string } | null
  /** The branch this surgery deletes, with the metadata an abort restores. */
  removed: {
    branch: string
    oid: string
    recordedParent: string | null
    recordedParentTip: string | null
  } | null
  /** The pull request changes the run makes, bottom-to-top, before the stack step. */
  pullRequests: SurgeryPullRequestPlan[]
  /** The native stack mutation the run makes, or null when membership is untouched. */
  stackStep: {
    stackNumber: number
    action: 'unstack' | 'unstack-and-create'
    /** The membership this stack held when the preview was taken, bottom-to-top. */
    membersBefore: number[]
    members: number[]
  } | null
  layers: SurgeryPlanLayer[]
  preview: SurgeryPlanPreview
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function sameOrder(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Turns the captured stack into the reviewed surgery offer: the order the stack
 * ends up in, every branch rewrite, push, pull request change and native stack
 * mutation it costs, and the reasons a layer cannot be moved at all. Nothing
 * here reads or writes the repository; the caller re-reads every captured fact
 * before the first ref moves.
 */
export function planSurgery(capture: SurgeryCapture, request: SurgeryRequest): SurgeryPlan {
  const facts = new Map(capture.layers.map((layer) => [layer.branch, layer]))
  const chain = capture.layers.map((layer) => layer.branch)
  const blockers: string[] = []
  const warnings: string[] = []
  let removedBranch: string | null = null
  let inserted: { branch: string; parent: string; oid: string } | null = null
  /** The parents this surgery changes; any other layer keeps its recorded parent. */
  const changes = new Map<string, string>()
  const parentAfter = (branch: string): string =>
    changes.get(branch) ?? facts.get(branch)?.parent ?? capture.trunk
  const childAfter = (name: string, exclude?: string): string | null =>
    chain.find(
      (branch) => branch !== exclude && branch !== removedBranch && parentAfter(branch) === name,
    ) ?? null
  let anchorIndex = 0

  if (request.kind === 'insert') {
    const anchor = request.branch
    const anchorFacts = anchor === capture.trunk ? null : facts.get(anchor)
    if (anchor !== capture.trunk && !anchorFacts) {
      blockers.push(`Branch ${anchor} is not a layer of this stack`)
    } else {
      const parentTip = anchorFacts?.oid ?? capture.trunkOid
      if (capture.localBranches.includes(request.name)) {
        blockers.push(`Branch ${request.name} already exists in this repository`)
      } else if (request.name === anchor) {
        blockers.push('The inserted branch needs a different name than its parent')
      } else {
        inserted = { branch: request.name, parent: anchor, oid: parentTip }
        changes.set(request.name, anchor)
        const child = childAfter(anchor)
        if (child) changes.set(child, request.name)
        anchorIndex = chain.indexOf(anchor) + 1
        warnings.push(
          `${request.name} is created at ${parentTip.slice(0, 12)} with no commits of its own; add commits to it before Submit Stack publishes it.`,
        )
      }
    }
  } else if (request.kind === 'move') {
    const subject = facts.get(request.branch)
    const target = request.target
    if (!subject) {
      blockers.push(`Branch ${request.branch} is not a layer of this stack`)
    } else if (subject.merged) {
      blockers.push(
        `Pull request #${subject.pullRequest ?? '?'} for ${subject.branch} already merged; Sync Stack drops a merged layer instead of moving it`,
      )
    } else if (target === request.branch) {
      blockers.push('A layer cannot be moved under itself')
    } else if (target !== capture.trunk && !facts.has(target)) {
      blockers.push(`Branch ${target} is not a layer of this stack`)
    } else {
      const layerAbove = chain.find((branch) => parentAfter(branch) === subject.branch) ?? null
      if (layerAbove === target) {
        // Moving a layer up past the one above it is a swap, not a reparent onto a
        // lower layer: the layer above keeps its own subtree and drops onto this
        // layer's parent, and the moved layer lands on top of what it passed. Both
        // replays are recorded, so the cascade rebuilds the chain in order.
        changes.set(layerAbove, subject.parent ?? capture.trunk)
        changes.set(subject.branch, chain[chain.length - 1] as string)
        anchorIndex = chain.indexOf(subject.branch)
      } else {
        // The target must not sit inside the layer's own subtree, or the result is
        // a cycle rather than the ordered chain GitHub stacks require.
        const subtree: string[] = [subject.branch]
        let grew = true
        while (grew) {
          grew = false
          for (const branch of chain) {
            if (subtree.includes(branch)) continue
            if (subtree.includes(facts.get(branch)?.parent ?? capture.trunk)) {
              subtree.push(branch)
              grew = true
            }
          }
        }
        if (target !== capture.trunk && subtree.includes(target)) {
          blockers.push(
            `${target} is already inside ${subject.branch}; moving it there would not be an ordered stack`,
          )
        } else if (target === subject.parent) {
          blockers.push(`${subject.branch} already sits directly on ${target}; nothing would move`)
        } else {
          // The moved layer takes the target's place and everything above it follows,
          // so the layers it passes keep their own order above the moved subtree.
          // That is the only result that stays one chain: a layer cannot sit below
          // its own child.
          const subjectIndex = chain.indexOf(subject.branch)
          const targetIndex = target === capture.trunk ? -1 : chain.indexOf(target)
          const above = chain.slice(subjectIndex)
          const passed = chain.slice(targetIndex + 1, subjectIndex)
          changes.set(subject.branch, target)
          if (passed.length > 0) changes.set(passed[0], above[above.length - 1] as string)
          anchorIndex = Math.min(subjectIndex, targetIndex + 1)
        }
      }
    }
  } else {
    const subject = facts.get(request.branch)
    if (!subject) {
      blockers.push(`Branch ${request.branch} is not a layer of this stack`)
    } else if (subject.merged) {
      blockers.push(
        `Pull request #${subject.pullRequest ?? '?'} for ${subject.branch} already merged; its pull request cannot leave the stack`,
      )
    } else {
      removedBranch = subject.branch
      // The layer above the removed one lands on the removed layer's own parent,
      // which is the only base that keeps the chain ordered.
      const child = childAfter(subject.branch, subject.branch)
      if (child) changes.set(child, subject.parent)
      anchorIndex = chain.indexOf(subject.branch) + 1
    }
  }

  const expected = new Set(chain.filter((branch) => branch !== removedBranch))
  if (inserted) expected.add(inserted.branch)
  const order: string[] = []
  for (let cursor = capture.trunk; ;) {
    const next = [...expected].find(
      (branch) => !order.includes(branch) && parentAfter(branch) === cursor,
    )
    if (next === undefined) break
    if (order.includes(next)) {
      blockers.push(`The surgery would loop back to ${next}; no branch was changed`)
      break
    }
    order.push(next)
    cursor = next
  }
  if (blockers.length === 0 && order.length !== expected.size) {
    blockers.push(
      'The surgery would leave branches outside one ordered chain; Git Stacks only edits linear stacks',
    )
  }

  const affected = new Set(
    chain.filter((branch) => chain.indexOf(branch) >= anchorIndex && branch !== removedBranch),
  )
  if (inserted) affected.add(inserted.branch)

  const layers: SurgeryPlanLayer[] = []
  const previewLayers: SurgeryLayer[] = []
  const forcePushes: string[] = []
  const retargets: SurgeryPlanPreview['retargets'] = []
  const closes: number[] = []
  const pullRequests: SurgeryPullRequestPlan[] = []
  const replayed = new Set<string>()
  /** Remote branches this run has to publish before a pull request can point at them. */
  const creates: string[] = []

  for (const branch of order) {
    if (!affected.has(branch)) continue
    const layerFacts = facts.get(branch)
    const parent = parentAfter(branch)
    const targetTip = facts.get(parent)?.oid ?? capture.trunkOid
    if (!layerFacts) {
      // The only layer without captured facts is the branch this surgery creates.
      // A submitted layer hanging from it needs that branch on the remote before
      // its pull request can be retargeted, so the insert publishes it as a new
      // remote branch and the preview names that creation as part of the review.
      const submittedChild = order.find((other) => {
        const otherFacts = facts.get(other)
        return (
          parentAfter(other) === branch &&
          otherFacts !== undefined &&
          otherFacts.pullRequest !== null &&
          otherFacts.pullRequestState === 'OPEN'
        )
      })
      let publish = false
      if (submittedChild) {
        if (!capture.pushUrl) {
          blockers.push(
            `Retargeting pull request #${facts.get(submittedChild)?.pullRequest} onto the new ${branch} needs a GitHub origin: GitHub refuses a pull request whose base branch does not exist on the remote`,
          )
        } else {
          publish = true
          creates.push(branch)
          warnings.push(
            `${branch} is published as a new branch on ${capture.pushUrl} before the pull request above it is retargeted onto it, and that push refuses to replace a branch that already exists there.`,
          )
        }
      }
      layers.push({
        branch,
        action: 'insert',
        fromParent: parent,
        toParent: parent,
        parentRef: `refs/heads/${parent}`,
        parentOid: targetTip,
        oldTip: targetTip,
        boundary: targetTip,
        boundarySource: 'recorded',
        commits: 0,
        push: publish ? 'create' : 'none',
        remoteOid: null,
        replay: false,
      })
      previewLayers.push({
        branch,
        action: 'insert',
        fromParent: null,
        toParent: parent,
        oid: null,
        remoteOid: null,
        commits: 0,
        push: publish ? 'create' : 'none',
        pullRequest: null,
        pullRequestBase: null,
        pullRequestAction: 'none',
        note: publish
          ? `Created at ${targetTip.slice(0, 12)} with no commits of its own, then published as a new remote branch`
          : `Created at ${targetTip.slice(0, 12)} with no commits of its own`,
        blockers: [],
      })
      continue
    }

    const parentChanged = parent !== layerFacts.parent
    const parentReplayed = replayed.has(parent)
    // A layer whose recorded boundary is already the parent's tip only needs
    // its parent metadata corrected; replaying it would move no commit.
    const noCommitReplay = parentChanged && !parentReplayed && layerFacts.boundary === targetTip
    const staleBoundary = layerFacts.boundary !== targetTip
    const replay = (parentChanged || parentReplayed || staleBoundary) && !noCommitReplay
    if (!replay && !parentChanged) continue
    const action: SurgeryLayer['action'] = replay ? 'rewrite' : 'retarget'
    if (replay) replayed.add(branch)

    const layerBlockers = [...layerFacts.blockers]
    if (layerFacts.merged && parentChanged) {
      layerBlockers.push(
        `Pull request #${layerFacts.pullRequest ?? '?'} for ${branch} already merged; GitHub will not retarget it, so the layers around it cannot be reordered`,
      )
    }
    if (replay && layerFacts.mergeCommits > 0) {
      layerBlockers.push(
        `Branch ${branch} contains ${layerFacts.mergeCommits} merge commit${layerFacts.mergeCommits === 1 ? '' : 's'}; replaying it is blocked to preserve merge topology.`,
      )
    }
    if (replay && layerFacts.remoteRelation === 'diverged') {
      layerBlockers.push(
        `origin/${branch} has commits the local branch neither has nor contains, so somebody rewrote it after this preview was taken; fetch and review it before moving the layer`,
      )
    }
    if (replay && layerFacts.boundarySource === 'merge-base') {
      // A fork point inferred from a merge base is a guess. Replaying from it
      // could drop a commit, so a layer without a recorded boundary is refused
      // rather than moved.
      layerBlockers.push(
        `Branch ${branch} has no recorded parent boundary, so the commits to replay cannot be proven; record one with Restack before moving the layer`,
      )
    }
    if (replay && layerFacts.remoteRelation === 'ahead') {
      layerBlockers.push(
        `origin/${branch} is ahead of the local branch; integrate those commits before moving the layer so no published commit is dropped`,
      )
    }

    // A replay rewrites the tip, so an existing remote branch can only be
    // replaced under its exact lease. Surgery never creates a remote branch.
    const push: SyncPushKind =
      layerFacts.remoteOid === null
        ? 'none'
        : replay
          ? 'force'
          : layerFacts.remoteOid === layerFacts.oid
            ? 'none'
            : 'fast-forward'
    if (push === 'force') forcePushes.push(branch)

    let pullRequestAction: SurgeryLayer['pullRequestAction'] = 'none'
    if (layerFacts.pullRequest !== null && layerFacts.pullRequestState === 'OPEN') {
      const number = layerFacts.pullRequest
      if (
        layerFacts.headOid &&
        layerFacts.headOid !== layerFacts.oid &&
        layerFacts.headOid !== layerFacts.remoteOid
      ) {
        layerBlockers.push(
          `GitHub records pull request #${number} at ${layerFacts.headOid.slice(0, 12)}, which is neither the local tip nor the fetched remote tip; it was rebased or pushed outside Git Stacks, so the replay boundary cannot be proven`,
        )
      }
      if (
        layerFacts.pullRequestBase !== layerFacts.parent &&
        layerFacts.pullRequestBase !== parent
      ) {
        layerBlockers.push(
          `Pull request #${number} targets ${layerFacts.pullRequestBase ?? 'an unknown base'}, which is neither the recorded parent ${layerFacts.parent} nor the new parent ${parent}`,
        )
      }
      if (layerFacts.pullRequestBase !== parent) {
        pullRequestAction = 'retarget'
        pullRequests.push({
          branch,
          number,
          action: 'retarget',
          headRef: branch,
          headOid: layerFacts.remoteOid,
          fromBase: layerFacts.pullRequestBase ?? layerFacts.parent,
          toBase: parent,
        })
        retargets.push({
          number,
          branch,
          from: layerFacts.pullRequestBase ?? layerFacts.parent,
          to: parent,
        })
      }
    }

    const noteParts: string[] = []
    if (replay) {
      noteParts.push(
        `Replay ${layerFacts.commits} commit${layerFacts.commits === 1 ? '' : 's'} from ${layerFacts.boundary.slice(0, 12)} onto ${targetTip.slice(0, 12)}`,
      )
    } else {
      noteParts.push(`Parent changes to ${parent}; no commit is replayed`)
    }
    if (push === 'force') {
      noteParts.push(
        `push replaces origin/${branch} ${(layerFacts.remoteOid ?? '').slice(0, 12)} under an exact lease`,
      )
    } else if (push === 'fast-forward') {
      noteParts.push(`fast-forward origin/${branch} to ${layerFacts.oid.slice(0, 12)}`)
    } else {
      noteParts.push('remote branch already matches')
    }
    if (pullRequestAction === 'retarget') {
      noteParts.push(`pull request #${layerFacts.pullRequest} retargeted to ${parent}`)
    }

    layers.push({
      branch,
      action,
      fromParent: layerFacts.parent,
      toParent: parent,
      parentRef: `refs/heads/${parent}`,
      parentOid: targetTip,
      oldTip: layerFacts.oid,
      boundary: layerFacts.boundary,
      boundarySource: layerFacts.boundarySource,
      commits: layerFacts.commits,
      push,
      remoteOid: layerFacts.remoteOid,
      replay,
    })
    previewLayers.push({
      branch,
      action,
      fromParent: layerFacts.parent,
      toParent: parent,
      oid: layerFacts.oid,
      remoteOid: layerFacts.remoteOid,
      commits: layerFacts.commits,
      push,
      pullRequest: layerFacts.pullRequest,
      pullRequestBase: layerFacts.pullRequestBase,
      pullRequestAction,
      note: noteParts.join('; '),
      blockers: unique(layerBlockers),
    })
    blockers.push(...layerBlockers)
  }

  if (removedBranch) {
    const layerFacts = facts.get(removedBranch)
    if (layerFacts?.pullRequest != null && layerFacts.pullRequestState === 'OPEN') {
      closes.push(layerFacts.pullRequest)
      pullRequests.push({
        branch: layerFacts.branch,
        number: layerFacts.pullRequest,
        action: 'close',
        headRef: layerFacts.branch,
        headOid: layerFacts.remoteOid,
        fromBase: layerFacts.pullRequestBase ?? layerFacts.parent,
        toBase: layerFacts.pullRequestBase ?? layerFacts.parent,
      })
    }
    if (layerFacts) {
      const child = childAfter(removedBranch)
      const note = [
        `Local branch deleted and ${child ? `${child} replays onto ${layerFacts.parent}` : 'no layer above it changes'}`,
        layerFacts.commits > 0
          ? `${layerFacts.commits} commit${layerFacts.commits === 1 ? '' : 's'} stay reachable from its recovery ref until the surgery finishes`
          : '',
        layerFacts.pullRequestState === 'OPEN'
          ? `pull request #${layerFacts.pullRequest} closed`
          : '',
        layerFacts.remoteOid !== null
          ? `origin/${removedBranch} is left in place; delete it separately if the layer is gone`
          : '',
      ]
        .filter(Boolean)
        .join('; ')
      previewLayers.unshift({
        branch: removedBranch,
        action: 'remove',
        fromParent: layerFacts.parent,
        toParent: layerFacts.parent,
        oid: layerFacts.oid,
        remoteOid: layerFacts.remoteOid,
        commits: layerFacts.commits,
        push: 'none',
        pullRequest: layerFacts.pullRequest,
        pullRequestBase: layerFacts.pullRequestBase,
        pullRequestAction: layerFacts.pullRequestState === 'OPEN' ? 'close' : 'none',
        note,
        blockers: [],
      })
    }
  }

  const nativeStack = planNativeStack(capture, order, facts, parentAfter, blockers, warnings)
  if (closes.length > 0) {
    warnings.push(
      `Closing pull request ${closes.map((number) => `#${number}`).join(', ')} needs the explicit approval this preview asks for; reopen it to keep the layer.`,
    )
  }
  if (forcePushes.length > 0) {
    warnings.push(
      `Pushing ${forcePushes.join(', ')} replaces published history under the exact remote tips named above.`,
    )
  }

  const removedFacts = removedBranch ? facts.get(removedBranch) : undefined
  return {
    request,
    trunk: capture.trunk,
    order,
    inserted,
    removed: removedFacts
      ? {
          branch: removedFacts.branch,
          oid: removedFacts.oid,
          recordedParent: removedFacts.recordedParent,
          recordedParentTip: removedFacts.recordedParentTip,
        }
      : null,
    layers,
    pullRequests,
    stackStep:
      nativeStack && nativeStack.action !== 'none'
        ? {
            stackNumber: nativeStack.number as number,
            action: nativeStack.action,
            membersBefore: capture.stack?.members ?? [],
            members: nativeStack.action === 'unstack-and-create' ? nativeStack.members : [],
          }
        : null,
    preview: {
      kind: request.kind,
      branch: request.branch,
      trunk: capture.trunk,
      order,
      layers: previewLayers,
      forcePushes: unique(forcePushes),
      creates: unique(creates),
      retargets,
      closes,
      nativeStack,
      blockers: unique(blockers),
      warnings: unique(warnings),
    },
  }
}

function numberOf(facts: SurgeryLayerFacts): number | null {
  return facts.pullRequest
}

/**
 * The native stack mutation this composition needs. GitHub exposes no
 * single-member removal and no reorder, so a changed order is unstacked and
 * registered again, and a chain with a hole in it can only be unstacked.
 */
function planNativeStack(
  capture: SurgeryCapture,
  order: string[],
  facts: Map<string, SurgeryLayerFacts>,
  parentAfter: (branch: string) => string,
  blockers: string[],
  warnings: string[],
): SurgeryPlanPreview['nativeStack'] {
  const stack = capture.stack
  if (!stack) return null
  const submitted = order
    .map((branch) => facts.get(branch))
    .filter((layer): layer is SurgeryLayerFacts => layer !== undefined)
    .filter((layer) => layer.pullRequest !== null && layer.pullRequestState === 'OPEN')
  const members = submitted.map((layer) => layer.pullRequest as number)
  // The chain is checked before the order is: an unchanged membership whose bases
  // no longer form one chain is a stack GitHub cannot keep, because a layer this
  // surgery inserted between two of its members has no pull request of its own.
  let chainValid = members.length > 0
  let previous: string | null = null
  for (const layer of submitted) {
    const base = parentAfter(layer.branch)
    if (previous === null ? base !== stack.base : base !== previous) chainValid = false
    previous = layer.branch
  }
  const merged = capture.layers
    .filter((layer) => layer.pullRequest !== null && layer.merged)
    .map((layer) => layer.pullRequest as number)
  if (merged.length > 0) {
    warnings.push(
      `Pull request ${merged.map((number) => `#${number}`).join(', ')} already merged and stays in stack #${stack.number}; GitHub does not unstack a merged pull request.`,
    )
  }
  if (!chainValid) {
    warnings.push(
      'The remaining pull requests do not form one chain from the stack base, so the stack can only be unstacked. Submit Stack registers it again once every layer has its own pull request.',
    )
    return { number: stack.number, action: 'unstack', members: [] }
  }
  if (sameOrder(stack.members, members)) return { number: stack.number, action: 'none', members }
  if (capture.stackCapability !== 'available') {
    blockers.push(
      'This repository cannot use native pull request stacks, so the changed order cannot be registered; unstack the stack on GitHub first',
    )
    return { number: stack.number, action: 'none', members }
  }
  return { number: stack.number, action: 'unstack-and-create', members }
}
