import type {
  ActionResult,
  PullRequest,
  SyncLayer,
  SyncLayerState,
  SyncPreview,
  SyncPushKind,
  SyncTrunk,
} from '../shared/types'

/**
 * How the remote branch of a layer compares with the local tip that was captured
 * when the preview was taken. It is decided from real ancestry in the caller, so
 * this module never guesses a relationship it was not given.
 */
export type SyncRemoteRelation = 'absent' | 'equal' | 'behind' | 'ahead' | 'diverged'

/** The pull request identity a sync plan was built from, re-read at the mutation boundary. */
export interface SyncPullRequestFacts {
  number: number
  state: PullRequest['state']
  base: string
  headOid: string | null
}

/** Everything one stack layer contributes to the sync preview, captured from real Git. */
export interface SyncLayerFacts {
  branch: string
  /** The parent the replay lands on, after merged layers have been dropped. */
  base: string
  baseOid: string
  /** The parent recorded for this layer before merged layers were dropped. */
  recordedParent: string | null
  /** The merged lower layer that moves this one onto a different base. */
  retargetedFrom: string | null
  /** The local tip captured when the preview was taken. */
  oid: string
  /** The remote tip captured when the preview was taken, and the lease a force push names. */
  remoteOid: string | null
  remoteRelation: SyncRemoteRelation
  commits: number
  /** The layer must be replayed because its base or recorded boundary moved. */
  rebase: boolean
  /** The layer's own pull request already merged, so the layer is left untouched. */
  merged: boolean
  pullRequest: SyncPullRequestFacts | null
  /** Reasons this single layer cannot be synced, already worded for the reviewer. */
  blockers: string[]
  note: string
}

export interface SyncCapture {
  /** The remote a sync reads, and the fetch it was taken against. */
  remote: string
  trunk: Omit<SyncTrunk, 'remote'>
  /** Every layer of the stack in bottom-to-top order, including merged ones. */
  layers: SyncLayerFacts[]
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

/**
 * A retargeted layer is the one GitHub moved for us when a lower pull request
 * merged. A layer whose base GitHub still names the merged predecessor has not
 * been retargeted yet, so the sync leaves the base alone and says so; the
 * preview never claims GitHub changed something it did not.
 */
function retargetNote(layer: SyncLayerFacts, pullRequest: SyncPullRequestFacts | null): string {
  if (!pullRequest) return ''
  if (pullRequest.base === layer.base) {
    return `GitHub already retargeted pull request #${pullRequest.number} onto ${layer.base}`
  }
  if (pullRequest.base === layer.recordedParent) {
    return `Pull request #${pullRequest.number} still targets ${pullRequest.base}; publishing it after this sync moves it to ${layer.base}`
  }
  return ''
}

function layerState(facts: SyncLayerFacts, blockers: string[], push: SyncPushKind): SyncLayerState {
  if (blockers.length > 0) return 'blocked'
  if (facts.merged) return 'merged'
  if (push === 'force') return 'needs-force'
  if (facts.retargetedFrom) return 'retargeted'
  if (facts.rebase) return 'needs-rebase'
  if (push !== 'none') return 'needs-push'
  return 'up-to-date'
}

function classifyLayer(facts: SyncLayerFacts): SyncLayer {
  const blockers = [...facts.blockers]
  let push: SyncPushKind = 'none'
  if (!facts.merged) {
    if (facts.remoteRelation === 'diverged') {
      blockers.push(
        `origin/${facts.branch} has commits the local branch neither has nor contains, so somebody rewrote it after this preview was taken; fetch and review it before syncing`,
      )
    } else if (facts.remoteRelation === 'ahead') {
      blockers.push(
        `origin/${facts.branch} is ahead of the local branch; integrate those commits before syncing so no published commit is dropped`,
      )
    } else if (facts.remoteRelation === 'absent') {
      push = 'create'
    } else if (facts.remoteRelation === 'equal') {
      // A replay rewrites the local tip, so the captured remote tip can only be
      // replaced. The lease is the exact commit this preview named.
      push = facts.rebase ? 'force' : 'none'
    } else {
      push = facts.rebase ? 'force' : 'fast-forward'
    }
    const pullRequest = facts.pullRequest
    if (pullRequest && pullRequest.state !== 'MERGED') {
      if (
        pullRequest.headOid !== null &&
        pullRequest.headOid !== facts.oid &&
        pullRequest.headOid !== facts.remoteOid
      ) {
        blockers.push(
          `GitHub records pull request #${pullRequest.number} at ${pullRequest.headOid.slice(0, 12)}, which is neither the local tip nor the fetched remote tip; it was rebased or pushed outside Git Stacks, so the replay boundary cannot be proven`,
        )
      }
      if (pullRequest.base !== facts.base && pullRequest.base !== facts.recordedParent) {
        blockers.push(
          `Pull request #${pullRequest.number} targets ${pullRequest.base}, which is neither the recorded parent ${facts.recordedParent ?? 'none'} nor the synced base ${facts.base}`,
        )
      }
    }
  }
  const state = layerState(facts, blockers, push)
  const note = retargetNote(facts, facts.pullRequest)
  const parts = [facts.note]
  if (push === 'force') {
    parts.push(
      `push replaces origin/${facts.branch} ${(facts.remoteOid ?? '').slice(0, 12)} under an exact lease`,
    )
  } else if (push === 'create') {
    parts.push(`publish origin/${facts.branch} as a new remote branch`)
  } else if (push === 'fast-forward') {
    parts.push(`fast-forward origin/${facts.branch} to ${facts.oid.slice(0, 12)}`)
  } else {
    parts.push('remote branch already matches')
  }
  if (note) parts.push(note)
  return {
    branch: facts.branch,
    base: facts.base,
    baseOid: facts.baseOid,
    state,
    oid: facts.oid,
    remoteOid: facts.remoteOid,
    commits: facts.commits,
    pullRequest: facts.pullRequest?.number ?? null,
    pullRequestBase: facts.pullRequest?.base ?? null,
    retargetedFrom: facts.retargetedFrom,
    rebase: facts.rebase,
    push,
    note: parts.join('; '),
    blockers: unique(blockers),
  }
}

/**
 * Turns the captured stack facts into the reviewed Sync Stack offer: the trunk it
 * hangs from, one classified layer per branch, and the branches whose published
 * history a lease would replace. Nothing here reads or writes the repository.
 */
export function buildSyncPreview(capture: SyncCapture, branch: string): SyncPreview {
  const layers = capture.layers.map(classifyLayer)
  const trunk = capture.trunk
  const warnings: string[] = []
  const trunkWarnings: string[] = []
  if (trunk.blockers.length === 0) {
    if (trunk.diverged) {
      trunkWarnings.push(
        `${trunk.branch} was rewritten on ${capture.remote}: the local tip holds ${trunk.ahead} commit${trunk.ahead === 1 ? '' : 's'} the remote tip does not and is missing ${trunk.behind}. Layers are replayed onto the fetched remote tip and the local ${trunk.branch} is left untouched.`,
      )
    } else if (trunk.ahead > 0) {
      trunkWarnings.push(
        `Local ${trunk.branch} is ${trunk.ahead} commit${trunk.ahead === 1 ? '' : 's'} ahead of ${capture.remote}/${trunk.branch}; syncing replays the layers onto the fetched remote tip and leaves the local ${trunk.branch} alone.`,
      )
    }
    if (trunk.behind === 0 && trunk.ahead === 0 && trunk.remoteOid) {
      trunkWarnings.push(`${trunk.branch} already matches ${capture.remote}/${trunk.branch}.`)
    }
  }
  for (const layer of layers) {
    if (layer.state === 'merged') {
      warnings.push(
        layer.pullRequest === null
          ? `Pull request for ${layer.branch} already merged; ${layer.branch} is left untouched.`
          : `Pull request #${layer.pullRequest} for ${layer.branch} already merged; ${layer.branch} is left untouched.`,
      )
    }
    if (layer.retargetedFrom && layer.pullRequestBase && layer.pullRequestBase !== layer.base) {
      warnings.push(
        `Pull request #${layer.pullRequest ?? '?'} still targets ${layer.pullRequestBase}; publish it after this sync to move it onto ${layer.base}.`,
      )
    }
  }
  const blockers = unique([...trunk.blockers, ...layers.flatMap((layer) => layer.blockers)])
  if (blockers.length === 0 && !layers.some((layer) => layer.state !== 'up-to-date')) {
    warnings.push(`Every layer of this stack already matches ${capture.remote}.`)
  }
  return {
    branch,
    trunk: { ...trunk, remote: capture.remote },
    layers,
    forcePushes: layers.filter((layer) => layer.push === 'force').map((layer) => layer.branch),
    blockers,
    warnings: unique([...trunkWarnings, ...warnings]),
  }
}

/** The layers a reviewed sync would replay, bottom-to-top. */
export function syncRebaseLayers(preview: SyncPreview): SyncPreview['layers'] {
  return preview.layers.filter((layer) => layer.rebase && layer.state !== 'blocked')
}

/** The layers a reviewed sync would push, bottom-to-top. */
export function syncPushLayers(preview: SyncPreview): SyncPreview['layers'] {
  return preview.layers.filter((layer) => layer.push !== 'none' && layer.state !== 'blocked')
}

/** The Git operations a sync needs from the stack engine, injected to keep one journal. */
export interface SyncStackDeps {
  /** Re-checks every capture the reviewed preview rests on. */
  revalidate(): Promise<void>
  /** Bottom-to-top replay with the captured-boundary and recovery-ref safety model. */
  restack(): Promise<ActionResult>
  /** The local tip of a branch after the replay finished. */
  tip(branch: string): Promise<string | null>
  /** Pushes a branch under the remote tip the preview captured. */
  push(branch: string, oid: string, allowForce: boolean): Promise<void>
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Runs a reviewed Sync Stack: the rebase cascade first, then the lease-guarded
 * pushes for exactly the branches the preview named. Every lease was captured
 * before anything moved, and the push re-checks it at its own mutation boundary,
 * so a remote that moved while the cascade ran stops the push instead of
 * replacing somebody else's commits.
 */
export async function runSyncStack(
  preview: SyncPreview,
  allowForce: boolean,
  deps: SyncStackDeps,
): Promise<ActionResult> {
  if (preview.blockers.length > 0) throw new Error(preview.blockers.join('; '))
  const rebases = syncRebaseLayers(preview)
  const pushes = syncPushLayers(preview)
  const forced = pushes.filter((layer) => layer.push === 'force')
  if (forced.length > 0 && !allowForce) {
    throw new Error(
      `Syncing replaces published history on ${forced.map((layer) => layer.branch).join(', ')}; review the preview and approve the exact leases before running it`,
    )
  }
  if (rebases.length === 0 && pushes.length === 0) {
    return { message: `Stack is already in sync with ${preview.trunk.remote}` }
  }
  await deps.revalidate()
  let rebased = 0
  if (rebases.length > 0) {
    await deps.restack()
    rebased = rebases.length
  }
  const pushed: string[] = []
  for (const layer of pushes) {
    const oid = await deps.tip(layer.branch)
    if (!oid) throw new Error(`Branch ${layer.branch} no longer exists after the replay`)
    if (oid === layer.remoteOid) continue
    await deps.push(layer.branch, oid, allowForce)
    pushed.push(layer.branch)
  }
  const parts: string[] = []
  if (rebased > 0) parts.push(`Replayed ${rebased} layer${rebased === 1 ? '' : 's'}`)
  if (pushed.length > 0) parts.push(`Pushed ${pushed.join(', ')}`)
  if (parts.length === 0) parts.push(`Stack is already in sync with ${preview.trunk.remote}`)
  return { message: `${parts.join('. ')}` }
}
