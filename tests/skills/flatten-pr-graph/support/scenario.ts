/**
 * Scenario helpers shared by the flatten-pr-graph fixtures.
 *
 * These helpers manufacture repository and provider state. They are fixture
 * scaffolding: they implement none of the integration or ordering policy in the
 * contract, they only produce the states the oracle inspects.
 */

import { CONTRACT_VERSION } from './contract-types'
import type {
  BlockedCode,
  Plan,
  PlanWrite,
  Preparation,
  Publication,
  Snapshot,
} from './contract-types'
import type { FixtureContext } from './fixture'
import type { ScratchWorkspace } from './real-git'
import type { FakePullRequest } from './fake-github'

const DENIED_WRITE_KINDS = new Set(['update-pr-base', 'push-selected-head'])

export interface ProviderScript {
  pullRequests: FakePullRequest[]
  perPage?: number
  deniedWrites?: string[]
  autoMergeEnabledOn?: number[]
}

const DEFAULT_OWNER = 'acme'
const DEFAULT_NAME = 'widgets'
const DEFAULT_BRANCH = 'main'

export function defineProvider(context: FixtureContext, script: ProviderScript): void {
  context.provider.configure({
    owner: DEFAULT_OWNER,
    name: DEFAULT_NAME,
    defaultBranch: DEFAULT_BRANCH,
    perPage: script.perPage ?? 2,
    deniedWrites: script.deniedWrites ?? [],
    autoMergeEnabledOn: script.autoMergeEnabledOn ?? [],
    pullRequests: script.pullRequests,
  })
}

/** Creates a branch with real commits and publishes it to the bare remote. */
export async function seedBranch(
  context: FixtureContext,
  scratchName: string,
  branch: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  const scratch = await context.scratch(scratchName)
  scratch.checkoutNew(branch)
  for (const [path, content] of Object.entries(files)) {
    await scratch.write(path, content)
  }
  const oid = scratch.commit(message)
  scratch.push(branch)
  return oid
}

/**
 * Merges `other` into `branch` inside a task-owned workspace and pushes the result
 * with a real force-with-lease. This is how a fixture manufactures a conforming
 * cumulative state; the contract's integration policy belongs to `#87`.
 */
export async function integrateBranch(
  context: FixtureContext,
  scratchName: string,
  branch: string,
  other: string,
): Promise<{ oid: string; before: string }> {
  const before = remoteOid(context, branch)
  const scratch = await context.scratch(scratchName)
  scratch.checkout(branch)
  scratch.fetch()
  scratch.merge(other)
  const oid = scratch.headOid()
  scratch.push(branch, { leaseFrom: before })
  return { oid, before }
}

/**
 * Merges `other` into `branch` and leaves the conflict in the index, which is what a
 * blocked run looks like from the outside.
 */
/**
 * Preparation without publication: merge in the task's own workspace and stop. The remote
 * ref does not move, so nothing on the provider side has happened yet.
 */
export async function prepareBranch(
  context: FixtureContext,
  name: string,
  branch: string,
  integrates: string,
): Promise<{ path: string; oid: string }> {
  const scratch = await context.scratch(name)
  scratch.checkout(branch)
  scratch.fetch()
  scratch.merge(integrates)
  return { path: scratch.path, oid: scratch.headOid() }
}

export async function mergeLeavingConflict(
  context: FixtureContext,
  scratchName: string,
  branch: string,
  other: string,
): Promise<ScratchWorkspace> {
  const scratch = await context.scratch(scratchName)
  scratch.checkout(branch)
  scratch.fetch()
  scratch.mergeExpectingConflict(other)
  return scratch
}

export function remoteOid(context: FixtureContext, branch: string): string {
  return refOid(context, branch)
}

function branchRefName(branch: string | null): string {
  if (!branch) return ''
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`
}

function refOid(context: FixtureContext, branch: string): string {
  if (!branch) return '0'.repeat(40)
  const ref = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`
  return context.world.remoteRefs()[ref] ?? '0'.repeat(40)
}

export function planFrom(
  snapshot: Snapshot,
  chain: number[],
  proposedWrites: PlanWrite[],
  overrides: Partial<Plan> = {},
): Plan {
  const identities = new Map(snapshot.selection.resolved.map((entry) => [entry.number, entry]))
  return {
    contractVersion: CONTRACT_VERSION,
    intent: snapshot.intent,
    order: chain.map((number, index) => {
      const identity = identities.get(number)
      const predecessor = index === 0 ? undefined : identities.get(chain[index - 1])
      const toBase = predecessor
        ? predecessor.headRef.replace('refs/heads/', '')
        : snapshot.root.ref.replace('refs/heads/', '')
      const fromBase = identity ? identity.baseRef.replace('refs/heads/', '') : toBase
      return {
        position: index + 1,
        number,
        fromBase,
        toBase,
        change: fromBase === toBase ? 'none' : 'base-change',
      }
    }),
    hardDependencies: [],
    ambiguities: [],
    objective: {
      declared: [
        'estimated-conflict-resolution-work',
        'unnecessary-history-disruption',
        'stable-tie-break',
      ],
      estimates: [],
      qualification: 'heuristic',
      budget: { probes: 0, exhausted: false },
      unknownTreatedAsZero: false,
    },
    proposedWrites,
    prohibitedActivitiesNotPerformed: [],
    ...overrides,
  }
}

/** Replays the provider's own action record into a publication document. */
/**
 * The blocked codes an honest report must carry when the provider denied a write. The
 * fixture reads them from the action log rather than asserting them by hand.
 */
export function deniedWriteReasons(
  context: FixtureContext,
): Array<{ code: BlockedCode; detail: string; evidence: string }> {
  return context.provider.actions
    .filter((action) => action.outcome === 'denied' && DENIED_WRITE_KINDS.has(action.kind))
    .map((action) => ({
      code: 'missing-permission' as const,
      detail: `the provider denied ${action.kind} for ${action.target}`,
      evidence: `action ${action.sequence} (${action.kind} ${action.target}) is recorded as denied`,
    }))
}

export function publicationFrom(
  context: FixtureContext,
  options: { bases: Record<number, string>; heads?: Record<string, string>; observedAt: string },
): Publication {
  const attempts = context.provider.actions
    .filter((action) => action.kind === 'update-pr-base' || action.kind === 'push-selected-head')
    .map((action, index) => {
      const acknowledged = action.outcome === 'acknowledged'
      const isRef = action.kind === 'push-selected-head'
      const number = Number(action.target)
      const branch = isRef ? action.target : ''
      const currentBase = isRef ? '' : (context.provider.baseOf(number) ?? '')
      const previousBase = isRef ? '' : (options.bases[number] ?? currentBase)
      const from = isRef
        ? (options.heads?.[branch] ?? remoteOid(context, branch))
        : refOid(context, previousBase)
      const to = isRef ? remoteOid(context, branch) : refOid(context, currentBase || previousBase)
      const kind: Publication['attempts'][number]['kind'] = isRef ? 'ref-update' : 'pr-base-update'
      return {
        sequence: index + 1,
        kind,
        target: isRef ? `refs/heads/${branch}` : action.target,
        from,
        to,
        acknowledged,
        lease: kind === 'ref-update' ? { expectedRemote: from, usedForceWithLease: true } : null,
        outcome: acknowledged ? ('acknowledged' as const) : ('denied' as const),
      }
    })
  const confirmed = attempts
    .filter((attempt) => attempt.acknowledged)
    .map((attempt) => ({ kind: attempt.kind, target: attempt.target, oid: attempt.to }))
  const unconfirmed = attempts
    .filter((attempt) => !attempt.acknowledged)
    .map((attempt) => ({
      kind: attempt.kind,
      target: attempt.target,
      why: 'the provider refused the write',
    }))
  return {
    contractVersion: CONTRACT_VERSION,
    attempts,
    confirmed,
    unconfirmed,
    denials: unconfirmed.map((entry) => ({
      kind: entry.kind,
      target: entry.target,
      reason: 'permission-denied',
      acknowledged: false,
    })),
    remoteClaims: [],
    interrupted: false,
    concurrency: { leaseHeld: true, conflictingRemoteMoveDetected: false },
  }
}

export function withRemoteClaims(
  publication: Publication,
  context: FixtureContext,
  observedAt: string,
): Publication {
  const claims = context.provider.actions
    .filter((action) => action.kind === 'update-pr-base')
    .map((action): Publication['remoteClaims'][number] => ({
      kind: 'pr-base',
      target: action.target,
      observed: branchRefName(context.provider.baseOf(Number(action.target))),
      observedAt,
    }))
  for (const [ref, oid] of Object.entries(context.world.remoteRefs()).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    claims.push({ kind: 'ref-oid', target: ref, observed: oid, observedAt })
  }
  return { ...publication, remoteClaims: claims }
}

export interface PreparedBranchFact {
  number: number
  originalHead: string
  preparedHead: string
  basedOn: string
  retainedOriginalCommits: string[]
}

export function preparationFrom(
  branches: PreparedBranchFact[],
  options: {
    cumulative?: Preparation['cumulativeIntegration']
    conflicts?: Preparation['conflicts']
    lost?: string[]
    unresolved?: string[]
    indexState?: Preparation['indexState']
  } = {},
): Preparation {
  return {
    contractVersion: CONTRACT_VERSION,
    workspaceKind: 'task-owned-isolated',
    branches: branches.map((branch) => ({ ...branch, historyPolicy: 'preserve-original-commits' })),
    lostOriginalCommits: options.lost ?? [],
    cumulativeIntegration: options.cumulative ?? [],
    conflicts: options.conflicts ?? [],
    unresolved: options.unresolved ?? [],
    indexState: options.indexState ?? {
      unmergedEntries: [],
      operationsInProgress: [],
      conflictMarkersInTree: [],
    },
  }
}
