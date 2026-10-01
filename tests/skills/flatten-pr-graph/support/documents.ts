/**
 * Builders for the documents a fixture's `run` reports.
 *
 * These builders read real state at claim time, so an honest fixture reports what
 * happened. A fixture that needs to lie mutates the returned document afterwards;
 * that is exactly the case the oracle exists to catch.
 */

import { CONTRACT_VERSION } from './contract-types'
import type {
  BlockedCode,
  Intent,
  Plan,
  PrIdentity,
  ResultDocument,
  Snapshot,
  Status,
} from './contract-types'
import { RUBRIC_PATH, type FixtureContext } from './fixture'

const ZERO_OID = '0'.repeat(40)

export interface ResolvedSelection {
  numbers: number[]
  duplicatesCollapsed: Array<{ canonical: number; inputs: string[] }>
}

/** Accepts `12`, `#12`, and canonical pull-request URLs, collapsing duplicates. */
export function resolveSelection(inputs: string[]): ResolvedSelection {
  const inputsByNumber = new Map<number, string[]>()
  const order: number[] = []
  for (const input of inputs) {
    const match = /^(?:#(\d+)|(\d+)|.*\/pull\/(\d+))$/.exec(input.trim())
    const parsed = match ? Number(match[1] ?? match[2] ?? match[3]) : Number.NaN
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`fixture selection input is not a pull request identity: ${input}`)
    }
    if (!inputsByNumber.has(parsed)) {
      inputsByNumber.set(parsed, [])
      order.push(parsed)
    }
    inputsByNumber.get(parsed)?.push(input)
  }
  return {
    numbers: order,
    duplicatesCollapsed: [...inputsByNumber.entries()]
      .filter(([, seen]) => seen.length > 1)
      .map(([canonical, seen]) => ({ canonical, inputs: [...seen] })),
  }
}

export function captureSnapshot(
  context: FixtureContext,
  options: {
    intent: Intent
    capturedAt: string
    selection: string[]
    /** Provider state the snapshot could not establish, recorded rather than assumed. */
    historyFacts?: { shallow: boolean; grafted: number }
    /** Provider-observed SHAs to reconcile against what task-owned storage holds. */
    reconcile?: Array<{ ref: string; observed: string }>
    externalPrerequisites?: Snapshot['externalPrerequisites']
    unselectedDependents?: Snapshot['unselectedDependents']
    capabilityLimitations?: Snapshot['capabilityLimitations']
    rootSource?: Snapshot['root']['source']
  },
): Snapshot {
  const { world, provider } = context
  const refs = world.remoteRefs()
  const resolved = resolveSelection(options.selection)
  const identities: PrIdentity[] = []
  for (const number of resolved.numbers) {
    const pr = provider.pullRequest(number)
    if (!pr) continue
    const headRef = `refs/heads/${pr.head}`
    const headOid = refs[headRef] ?? ZERO_OID
    identities.push({
      number,
      url: `https://github.com/${provider.repository.owner}/${provider.repository.name}/pull/${number}`,
      state: pr.state.toLowerCase() as PrIdentity['state'],
      isDraft: pr.draft,
      headRef,
      headOid,
      headRepository: pr.headRepository,
      baseRef: `refs/heads/${pr.base}`,
      baseOid: refs[`refs/heads/${pr.base}`] ?? ZERO_OID,
    })
  }
  const landing = provider.readLandingArrangement()
  const fingerprint = world.userFingerprint()
  const history = world.historyFacts()
  const rootRef = `refs/heads/${provider.repository.defaultBranch}`
  return {
    contractVersion: CONTRACT_VERSION,
    capturedAt: options.capturedAt,
    intent: options.intent,
    repository: {
      host: 'github.com',
      owner: provider.repository.owner,
      name: provider.repository.name,
      defaultBranch: provider.repository.defaultBranch,
      verified: true,
    },
    root: {
      ref: rootRef,
      oid: refs[rootRef] ?? ZERO_OID,
      source: options.rootSource ?? 'repository-default',
    },
    selection: {
      requested: options.selection,
      resolved: identities,
      duplicatesCollapsed: resolved.duplicatesCollapsed,
    },
    refs: Object.entries(refs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ref, oid]) => ({ ref, oid })),
    userWorkspace: {
      present: true,
      headRef: fingerprint.headRef,
      dirtyPaths: fingerprint.status
        .split('\n')
        .filter(Boolean)
        .map((entry) => entry.slice(3)),
      stashCount: fingerprint.stashCount,
      configDigest: fingerprint.configDigest,
    },
    history: {
      complete: !history.shallow && history.grafted === 0,
      shallow: history.shallow,
      grafted: history.grafted,
      // Task-owned storage holds everything published to the bare remote, so an
      // unrelated history is a property the discovery helper decides, not this builder.
      unrelated: [],
      reconciliation: reconcileRefs(refs, identities, options.reconcile ?? []),
    },
    externalPrerequisites: options.externalPrerequisites ?? [],
    unselectedDependents: options.unselectedDependents ?? [],
    capabilityLimitations: options.capabilityLimitations ?? [],
    landing,
  }
}

/**
 * Reconciles the SHA each provider observation reported against what task-owned
 * storage actually holds. A disagreement is recorded as such; it is never smoothed
 * into agreement.
 */
function reconcileRefs(
  refs: Record<string, string>,
  identities: PrIdentity[],
  overrides: Array<{ ref: string; observed: string }>,
): Snapshot['history']['reconciliation'] {
  const observed = new Map(overrides.map((entry) => [entry.ref, entry.observed]))
  return identities.map((identity) => {
    const provider = observed.get(identity.headRef) ?? identity.headOid
    const fetched = refs[identity.headRef] ?? null
    const state: Snapshot['history']['reconciliation'][number]['state'] =
      fetched === null
        ? 'unreachable'
        : fetched === provider
          ? 'agreed'
          : provider === ZERO_OID
            ? 'storage-ahead'
            : 'provider-ahead'
    return { ref: identity.headRef, observed: provider, fetched, state }
  })
}

const NOT_PERFORMED_EVIDENCE: Record<string, string> = {
  'run-or-await-checks': 'no check endpoint was read and no check command was executed',
  'weaken-checks-or-protections': 'no protection or ruleset was changed',
  'merge-close-or-reopen-pr': 'the provider recorded no merge, close, or reopen',
  'delete-branch': 'no ref was deleted',
  'push-root': 'the root ref was not written',
  'bypass-protection': 'no bypass flag was used',
  'disable-auto-merge': 'no auto-merge setting was disabled',
  'join-or-leave-merge-queue': 'no merge queue was joined, left, or awaited',
  'modify-workflow-or-repo-config': 'no workflow or repository configuration was written',
  'edit-user-checkout-index-stash-or-config':
    "the user's checkout, index, stash, and config are unchanged",
  'drop-clone-or-recreate-pr': 'no pull request was dropped, cloned, or re-created',
  'expand-selection': 'the selection is exactly what was requested',
  'disable-environment-control': 'no environment control was disabled',
}

export function notPerformed(activities: string[] = Object.keys(NOT_PERFORMED_EVIDENCE)) {
  return activities.map((activity) => ({
    activity,
    performed: false,
    evidence: NOT_PERFORMED_EVIDENCE[activity] ?? 'no action of this kind was recorded',
  }))
}

export function basePlan(intent: Intent): Plan {
  return {
    contractVersion: CONTRACT_VERSION,
    intent,
    order: [],
    hardDependencies: [],
    ambiguities: [],
    objective: {
      declared: [
        'estimated-conflict-resolution-work',
        'unnecessary-history-disruption',
        'stable-tie-break',
      ],
      estimates: [],
      componentTotals: {
        estimatedConflictResolutionWork: 0,
        historyDisruption: 0,
        unknownEstimates: 0,
      },
      cumulative: {
        kind: 'pairwise-only',
        value: null,
        why: 'no probe ran, so nothing is known about either the pairwise or the cumulative cost',
      },
      qualification: 'heuristic',
      budget: {
        probes: 0,
        exhausted: false,
        ordersEnumerated: 0,
        orderEvaluations: 0,
        orderEvaluationLimit: 200,
        search: 'stable-topological-baseline',
      },
      unknownTreatedAsZero: false,
    },
    proposedWrites: [],
    capabilityLimitations: [],
    prohibitedActivitiesNotPerformed: notPerformed(),
  }
}

export interface ResultParts {
  status: Status
  intent: Intent
  snapshot: Snapshot
  plan: Plan
  preparation?: ResultDocument['preparation']
  publication?: ResultDocument['publication']
  blockedReasons?: Array<{ code: BlockedCode; detail: string; evidence: string }>
  recovery?: ResultDocument['recovery']
  uncertainty?: Array<{ item: string; why: string }>
  nextSafeAction?: { action: string; requires: string[] }
  verification?: ResultDocument['verification']
  prohibitedActivities?: ResultDocument['prohibitedActivities']
  semanticVerdict?: ResultDocument['semanticReview']['reviewerVerdict']
}

export function resultDocument(parts: ResultParts): ResultDocument {
  return {
    contractVersion: CONTRACT_VERSION,
    status: parts.status,
    intent: parts.intent,
    snapshot: parts.snapshot,
    plan: parts.plan,
    ...(parts.preparation ? { preparation: parts.preparation } : {}),
    ...(parts.publication ? { publication: parts.publication } : {}),
    ...(parts.blockedReasons ? { blockedReasons: parts.blockedReasons } : {}),
    ...(parts.recovery ? { recovery: parts.recovery } : {}),
    ignoredChecks: {
      policy: 'never-run-poll-wait-rerun-repair-or-gate',
      executed: [],
      suppressedOrWeakened: [],
      remoteTriggeredLeftAlone: true,
    },
    prohibitedActivities: parts.prohibitedActivities ?? notPerformed(),
    uncertainty: parts.uncertainty ?? [
      {
        item: 'semantic correctness of every resolution',
        why: 'only the human rubric judges this',
      },
    ],
    nextSafeAction: parts.nextSafeAction ?? { action: 'stop and report', requires: [] },
    semanticReview: {
      automated: false,
      rubric: RUBRIC_PATH,
      humanReviewRequired: true,
      reviewerVerdict: parts.semanticVerdict ?? 'unreviewed',
    },
    verification: parts.verification ?? [
      {
        invariant: 'status.legality',
        method: 'oracle inspection',
        observed: 'see the oracle verdict',
        result: 'pass',
      },
    ],
  }
}

export function emptyPublication(): NonNullable<ResultDocument['publication']> {
  return {
    contractVersion: CONTRACT_VERSION,
    attempts: [],
    confirmed: [],
    unconfirmed: [],
    denials: [],
    remoteClaims: [],
    interrupted: false,
    concurrency: { leaseHeld: false, conflictingRemoteMoveDetected: false },
  }
}
