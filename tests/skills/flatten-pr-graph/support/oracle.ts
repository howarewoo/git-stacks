/**
 * The flatten-pr-graph verification oracle.
 *
 * The oracle decides what happened by reading state: the real bare repository, the
 * fake provider's pull-request metadata and action record, the recorded Git command
 * list, the user's working checkout, and any task-owned scratch workspace. It never
 * reads a run's `status`, `success`, or report. A result document is treated as a set
 * of claims to be checked, and a claim that does not match observation is the finding.
 */

import {
  FORBIDDEN_ACTIONS,
  FORBIDDEN_COMMAND_PATTERNS,
  isPermitted,
  type Invariant,
} from './actions'
import { viewClaim } from './claim-view'
import type { BlockedCode, FixtureExpectation, Status } from './contract-types'
import type { FixtureContext, ObservedBaseline } from './fixture'
import { validateAgainstPointer, formatErrors, type LoadedSchema } from './json-schema'
import type { ScratchWorkspace } from './real-git'

export interface Violation {
  invariant: Invariant
  detail: string
  observed: string
  expected: string
}

export interface Blocker {
  code: BlockedCode
  detail: string
  evidence: string
}

export interface OracleVerdict {
  /** The status the observed state supports, derived without reading the claim. */
  witnessedStatus: Status
  ok: boolean
  violations: Violation[]
  blockers: Blocker[]
  /** Semantic questions no oracle answers; they stay with the human rubric. */
  unautomated: string[]
}

const ZERO_OID = '0'.repeat(40)

/** The provider names branches; Git names their refs. */
function branchRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`
}

const WRITE_ACTIONS = new Set(['update-pr-base', 'push-selected-head'])

/**
 * A confirmed write is a claim about the provider; the provider's own action record is
 * the only evidence that can back it. The publication document and the action log speak
 * different vocabularies, so the comparison is explicit rather than positional.
 */
function acknowledges(
  action: { kind: string; target: string; outcome: string },
  confirmed: { kind: string; target: string },
): boolean {
  if (action.outcome !== 'acknowledged') return false
  const branch = confirmed.target.replace(/^refs\/heads\//, '')
  const sameTarget = action.target === branch || action.target === confirmed.target
  if (!sameTarget) return false
  if (confirmed.kind === 'pr-base-update') return action.kind === 'update-pr-base'
  if (confirmed.kind === 'ref-update') return action.kind === 'push-selected-head'
  return false
}

const SEMANTIC_RUBRIC_ITEMS = [
  'S1 both sides intended changes survive',
  'S2 resolved content matches what the pull request asked for',
  'S3 no unrelated bug fix or review feedback crept in',
  'S4 no unclear product intent was guessed',
  'S5 no justified original commit was dropped or folded',
  'S6 the result claims no more than the evidence supports',
]

export interface OracleInput {
  context: FixtureContext
  baseline: ObservedBaseline
  claim: unknown
  expected: FixtureExpectation
  selected: number[]
  intent: 'preview' | 'execute'
  scratches: ScratchWorkspace[]
  schema: LoadedSchema
}

/**
 * The hard dependency edges implied by the pre-run evidence: a declared base that is a
 * selected head, or strict ancestry between two selected heads. Derived here, never read
 * from the report under test.
 */
export function observedHardEdges(
  context: FixtureContext,
  /**
   * The remote as it stood before the run, when the caller froze it.
   *
   * Reading the live remote here makes the baseline a function of what the run did: the
   * ancestry a run publishes would define the edges it is then judged against, and an edge
   * it destroyed would vanish from the comparison rather than fail it. Ancestry itself is
   * a property of the objects, which a run cannot rewrite, so only the ref-to-oid view has
   * to come from the caller.
   */
  preRunRefs?: Record<string, string>,
): Array<{ from: number; to: number; basis: 'declared-base' | 'strict-ancestry' }> {
  const provider = context.provider
  const refs = preRunRefs ?? context.world.remoteRefs()
  const edges: Array<{ from: number; to: number; basis: 'declared-base' | 'strict-ancestry' }> = []
  for (const target of provider.allPullRequests()) {
    for (const source of provider.allPullRequests()) {
      if (source.number === target.number) continue
      const sourceHead = refs[branchRef(source.head)]
      const targetHead = refs[branchRef(target.head)]
      if (target.base === source.head) {
        edges.push({ from: source.number, to: target.number, basis: 'declared-base' })
        continue
      }
      // Git reports a commit as its own ancestor, so two heads at one commit would
      // otherwise produce a reciprocal edge in each direction. Strict ancestry means a
      // different, earlier commit: equal heads are redundant, not dependent.
      if (
        sourceHead &&
        targetHead &&
        sourceHead !== targetHead &&
        context.world.isRemoteAncestor(sourceHead, targetHead)
      ) {
        edges.push({ from: source.number, to: target.number, basis: 'strict-ancestry' })
      }
    }
  }
  return edges
}

function unique(values: number[]): number[] {
  return [...new Set(values)]
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function shortOid(oid: string): string {
  return oid.slice(0, 8)
}

function detectBlockers(input: OracleInput, refs: Record<string, string>): Blocker[] {
  const { context, baseline, selected, scratches } = input
  const { world, provider } = context
  const blockers: Blocker[] = []
  const repositoryName = `${provider.repository.owner}/${provider.repository.name}`

  if (selected.length === 0) {
    blockers.push({
      code: 'missing-selection',
      detail:
        'the request names no pull request, and a missing selection never means all open pull requests',
      evidence: 'the explicit selection resolved to zero identities',
    })
  }

  for (const number of selected) {
    const pr = provider.pullRequest(number)
    if (!pr) {
      blockers.push({
        code: 'unsupported-input',
        detail: `pull request #${number} is not present in the verified repository`,
        evidence: `provider lists ${provider
          .allPullRequests()
          .map((entry) => `#${entry.number}`)
          .join(', ')}`,
      })
      continue
    }
    if (pr.state !== 'OPEN') {
      blockers.push({
        code: 'unsupported-input',
        detail: `pull request #${number} is ${pr.state}`,
        evidence: `provider state for #${number} is ${pr.state}`,
      })
    }
    if (pr.headRepository !== repositoryName) {
      blockers.push({
        code: 'unsupported-input',
        detail: `pull request #${number} has a head in another repository`,
        evidence: `head repository ${pr.headRepository}, verified repository ${repositoryName}`,
      })
    }
    if (!refs[branchRef(pr.head)]) {
      blockers.push({
        code: 'missing-external-prerequisite',
        detail: `the head branch of pull request #${number} does not exist in the repository`,
        evidence: `no ref ${branchRef(pr.head)} among ${Object.keys(refs).length} observed refs`,
      })
    }
    if (pr.base !== provider.repository.defaultBranch && !refs[`refs/heads/${pr.base}`]) {
      blockers.push({
        code: 'missing-external-prerequisite',
        detail: `the base branch ${pr.base} of pull request #${number} does not exist in the repository`,
        evidence: `no ref refs/heads/${pr.base} among the observed refs`,
      })
    }
    if (provider.hasAutoMerge(number)) {
      blockers.push({
        code: 'active-landing-arrangement',
        detail: `pull request #${number} carries its own active auto-merge request`,
        evidence: `the provider reports an auto-merge request on #${number}`,
      })
    }
  }

  const heads = selected.flatMap((number) => {
    const pr = provider.pullRequest(number)
    return pr ? [{ number, head: pr.head }] : []
  })
  for (const left of heads) {
    for (const right of heads) {
      if (left.number < right.number && left.head === right.head) {
        blockers.push({
          code: 'unsupported-input',
          detail: `pull requests #${left.number} and #${right.number} share one head branch`,
          evidence: `both heads are ${left.head}`,
        })
      }
    }
  }

  for (const left of heads) {
    for (const right of heads) {
      if (left.number >= right.number) continue
      const leftPr = provider.pullRequest(left.number)
      const rightPr = provider.pullRequest(right.number)
      if (leftPr && rightPr && leftPr.base === rightPr.head && rightPr.base === leftPr.head) {
        blockers.push({
          code: 'contradictory-graph',
          detail: `pull requests #${left.number} and #${right.number} are each other's base`,
          evidence: `#${left.number} base ${leftPr.base} is #${right.number} head ${rightPr.head}`,
        })
      }
    }
  }

  const history = world.historyFacts()
  if (history.shallow || history.grafted > 0) {
    blockers.push({
      code: 'missing-history',
      detail: 'the checkout history is incomplete, so ancestry cannot be established',
      evidence: `shallow=${history.shallow}, grafted=${history.grafted}`,
    })
  }

  const denied = context.provider.actions.filter((action) => action.outcome === 'denied')
  for (const action of denied) {
    if (WRITE_ACTIONS.has(action.kind)) {
      blockers.push({
        code: 'missing-permission',
        detail: `the provider denied ${action.kind} for ${action.target}`,
        evidence: `action ${action.sequence} (${action.kind} ${action.target}) is recorded as denied`,
      })
    }
  }

  for (const scratch of scratches) {
    const unmerged = scratch.unmergedPaths()
    const operations = scratch.operationsInProgress()
    const markers = scratch.conflictMarkerPaths()
    if (unmerged.length > 0 || operations.length > 0 || markers.length > 0) {
      blockers.push({
        code: 'unresolved-conflict',
        detail: 'a prepared workspace still holds an unresolved conflict',
        evidence: `${scratch.path}: unmerged=${unmerged.join(',') || 'none'} operations=${operations.join(',') || 'none'} markers=${markers.join(',') || 'none'}`,
      })
    }
  }

  return blockers
}

function detectLostCommits(input: OracleInput, refs: Record<string, string>): string[] {
  const { context, baseline, selected } = input
  const lost: string[] = []
  for (const number of selected) {
    const pr = context.provider.pullRequest(number)
    if (!pr) continue
    const original = baseline.refsBefore[branchRef(pr.head)]
    const current = refs[branchRef(pr.head)]
    if (!original || !current) continue
    if (!context.world.isRemoteAncestor(original, current)) {
      lost.push(`${branchRef(pr.head)} ${shortOid(original)}`)
    }
  }
  return lost
}

/**
 * A ref that moved since the snapshot invalidates the snapshot. A selected head that
 * moved is only explained by the run's own acknowledged push; without one, somebody
 * else moved it and every later step would be acting on stale evidence.
 */
function detectStaleSnapshot(input: OracleInput, refs: Record<string, string>): string[] {
  const { context } = input
  const view = viewClaim(input.claim)
  const pushed = new Set(
    context.provider.actions
      .filter((action) => action.kind === 'push-selected-head' && action.outcome === 'acknowledged')
      .map((action) => `refs/heads/${action.target}`),
  )
  const stale: string[] = []
  for (const [ref, captured] of Object.entries(view.snapshotRefOids)) {
    const now = refs[ref]
    if (now === undefined || now === captured) continue
    if (pushed.has(ref)) continue
    stale.push(`${ref} was captured as ${shortOid(captured)} but is now ${shortOid(now)}`)
  }
  return stale
}

export function judge(input: OracleInput): OracleVerdict {
  const { context, baseline, claim, expected, selected, intent, scratches, schema } = input
  const { world, provider } = context
  const violations: Violation[] = []
  const refs = world.remoteRefs()
  const view = viewClaim(claim)
  const rootRef = `refs/heads/${provider.repository.defaultBranch}`
  const selectedHeads = new Set(
    selected.flatMap((number) => {
      const pr = provider.pullRequest(number)
      return pr ? [branchRef(pr.head)] : []
    }),
  )

  const schemaErrors = validateAgainstPointer(schema, '#', claim)
  if (schemaErrors.length > 0) {
    violations.push({
      invariant: 'status.legality',
      detail: 'the result document is rejected by the contract schema',
      observed: formatErrors(schemaErrors).slice(0, 400),
      expected: 'a document satisfying contract.schema.json#/$defs/result',
    })
  }

  const blockers = detectBlockers(input, refs)
  const lostCommits = detectLostCommits(input, refs)
  for (const lost of lostCommits) {
    violations.push({
      invariant: 'preservation.original-commits',
      detail: 'an original head commit is no longer reachable from its published head',
      observed: `lost ${lost}`,
      expected: 'every original head commit stays reachable under the history-preserving policy',
    })
    blockers.push({
      code: 'lost-original-commit',
      detail: 'an original commit was lost from a selected head',
      evidence: lost,
    })
  }
  const staleSnapshot = detectStaleSnapshot(input, refs)
  if (staleSnapshot.length > 0) {
    blockers.push({
      code: 'stale-snapshot',
      detail: 'the captured snapshot disagrees with the observed refs',
      evidence: staleSnapshot.join('; '),
    })
  }

  const attemptedWrites = provider.actions.filter((action) => WRITE_ACTIONS.has(action.kind))
  const confirmedWrites = attemptedWrites.filter((action) => action.outcome === 'acknowledged')
  // Real preparation, observed in the task's own workspaces: a scratch the run created or
  // moved, sitting on a selected head. This is independent of anything the report says.
  const preparedEvidence = scratches.filter((scratch) => {
    const before = baseline.scratchStateBefore[scratch.path]
    const branch = scratch.currentBranch()
    if (!selectedHeads.has(branchRef(branch))) return false
    return before === undefined || before.branch !== branch || before.oid !== scratch.headOid()
  })
  const preparedWithoutMetadata = preparedEvidence.length > 0 && !view.preparationPresent
  let witnessedStatus: Status
  if (blockers.length > 0) {
    witnessedStatus = confirmedWrites.length > 0 ? 'partial' : 'blocked'
  } else if (intent === 'preview') {
    witnessedStatus = 'planned'
  } else if (attemptedWrites.length === 0) {
    witnessedStatus =
      preparedEvidence.length === 0 ? 'no-op' : preparedWithoutMetadata ? 'partial' : 'prepared'
  } else {
    witnessedStatus = preparedWithoutMetadata ? 'partial' : 'published'
  }

  if (view.status !== witnessedStatus) {
    violations.push({
      invariant: 'status.legality',
      detail: 'the reported status does not match what the observed state supports',
      observed: `reported ${view.status ?? 'no status'}, observed ${witnessedStatus}`,
      expected: witnessedStatus,
    })
  }

  const selectedSet = unique(selected).sort((left, right) => left - right)
  const resolved = unique(view.resolvedNumbers).sort((left, right) => left - right)
  if (!sameNumbers(resolved, selectedSet)) {
    violations.push({
      invariant: resolved.every((number) => selectedSet.includes(number))
        ? 'selection.complete'
        : 'selection.no-expansion',
      detail: 'the resolved selection does not equal the explicitly selected identities',
      observed: `resolved ${JSON.stringify(resolved)}, selected ${JSON.stringify(selectedSet)}`,
      expected: `every selected identity exactly once: ${JSON.stringify(selectedSet)}`,
    })
  }

  if (intent === 'preview' && attemptedWrites.length > 0) {
    violations.push({
      invariant: 'preservation.unselected-refs',
      detail: 'a preview attempted a provider write',
      observed: attemptedWrites.map((action) => `${action.kind} ${action.target}`).join(', '),
      expected: 'no provider write during preview',
    })
  }

  if (selected.length === 0 && view.blockedCodes.includes('missing-selection') === false) {
    violations.push({
      invariant: 'selection.complete',
      detail: 'an empty selection was not reported as a missing selection',
      observed: `blocked codes ${JSON.stringify(view.blockedCodes)}`,
      expected: 'missing-selection',
    })
  }

  const expectedChain = expected.chain
  const observedChain = expectedChain.flatMap((number) => {
    const base = provider.baseOf(number)
    return base ? [base] : []
  })
  if (
    blockers.length === 0 &&
    expectedChain.length > 0 &&
    !sameNumbers(view.order, expectedChain)
  ) {
    violations.push({
      invariant: 'topology.chain',
      detail: 'the reported chain order does not match the fixture chain',
      observed: `order ${JSON.stringify(view.order)}, bases ${JSON.stringify(observedChain)}`,
      expected: JSON.stringify(expectedChain),
    })
  }

  const chainFromProvider = expectedChain.every((number, index) => {
    const pr = provider.pullRequest(number)
    if (!pr) return false
    // The first position is pinned to the root; every later position names its
    // predecessor's head. A first PR sitting on anything else is not a chain.
    if (index === 0) return pr.base === provider.repository.defaultBranch
    const predecessor = provider.pullRequest(expectedChain[index - 1])
    return predecessor ? pr.base === predecessor.head : false
  })
  if (
    intent === 'execute' &&
    blockers.length === 0 &&
    expectedChain.length > 1 &&
    !chainFromProvider
  ) {
    violations.push({
      invariant: 'topology.chain',
      detail: 'the observed pull-request bases do not form root <- PR1 <- ... <- PRn',
      observed: expectedChain
        .map((number) => `#${number} -> ${provider.baseOf(number)}`)
        .join('; '),
      expected: 'each base equals the previous head',
    })
  }

  const positions = new Map(view.order.map((number, index) => [number, index]))
  // Every result that carries a chain owes the dependency evidence the pre-run state
  // already proved. A plan that omits an observed edge has failed exactly as a
  // published chain that ignores one has; "it only planned" is not an exemption.
  const claimsAnOrder = view.order.length > 0
  for (const edge of claimsAnOrder ? baseline.hardEdges : []) {
    if (!selected.includes(edge.from) || !selected.includes(edge.to)) continue
    const declared = view.dependencies.some(
      ([before, after]) => before === edge.from && after === edge.to,
    )
    if (!declared) {
      violations.push({
        invariant: 'topology.dependencies',
        detail: 'a hard dependency observed before the run is missing from the plan',
        observed: `#${edge.from} -> #${edge.to} by ${edge.basis}`,
        expected: 'every observed hard edge appears in plan.dependencies',
      })
    }
  }
  for (const [before, after] of view.dependencies) {
    const beforePosition = positions.get(before)
    const afterPosition = positions.get(after)
    if (beforePosition === undefined || afterPosition === undefined) {
      violations.push({
        invariant: 'topology.dependencies',
        detail: 'a hard dependency names a pull request the order does not contain',
        observed: `#${before} -> #${after}`,
        expected: 'both identities appear in the order',
      })
      continue
    }
    if (beforePosition > afterPosition) {
      violations.push({
        invariant: 'topology.dependencies',
        detail: 'a hard dependency is ordered after its dependent',
        observed: `#${before} at ${beforePosition + 1} precedes #${after} at ${afterPosition + 1}`,
        expected: `#${before} before #${after}`,
      })
    }
  }

  // A dependency the pre-run evidence does not support is not a dependency, unless the
  // run itself made it true. An execute run integrates each successor into its
  // predecessor's prepared state, so that ancestry is established by the run and can
  // be observed in the resulting refs; a planning run has no such excuse, and neither
  // has a verified prerequisite, which is an explicit human fact Git cannot prove.
  for (const [before, after, source] of view.dependencySources) {
    const supported = baseline.hardEdges.some((edge) => edge.from === before && edge.to === after)
    if (supported || source === 'verified-prerequisite') continue
    const beforePr = provider.pullRequest(before)
    const afterPr = provider.pullRequest(after)
    const beforeHead = beforePr ? refs[branchRef(beforePr.head)] : undefined
    const afterHead = afterPr ? refs[branchRef(afterPr.head)] : undefined
    const establishedByRun =
      intent === 'execute' &&
      Boolean(beforeHead) &&
      Boolean(afterHead) &&
      beforeHead !== afterHead &&
      world.isRemoteAncestor(beforeHead as string, afterHead as string)
    if (establishedByRun) continue
    // A base relationship the plan is about to create is a claim about the write, not
    // about the pre-run world. It counts when the plan says so structurally: the
    // successor immediately follows the predecessor in the reported order and the plan
    // proposes exactly that base change. Whether the write then happened is judged by
    // the publication and integrity invariants, not here.
    const immediatelyFollows =
      view.order[view.order.indexOf(after) - 1] === before && view.order.indexOf(after) > 0
    const proposesTheRetarget = view.proposedWrites.some(
      (write) =>
        write.kind === 'pr-base-update' &&
        write.target === String(after) &&
        write.change === 'base-change',
    )
    if (immediatelyFollows && proposesTheRetarget) continue
    violations.push({
      invariant: 'topology.dependencies',
      detail: 'a declared dependency names an edge no observed state supports',
      observed: `#${before} -> #${after} declared as ${source ?? 'no source'}`,
      expected:
        'an original base relationship, strict ancestry, a verified explicit prerequisite, or an integration this run actually performed',
    })
  }

  const beforeRoot = baseline.refsBefore[rootRef]
  if (beforeRoot && refs[rootRef] !== beforeRoot) {
    violations.push({
      invariant: 'preservation.root',
      detail: 'the root ref changed',
      observed: `${rootRef} is ${shortOid(refs[rootRef] ?? ZERO_OID)}, was ${shortOid(beforeRoot)}`,
      expected: `${shortOid(beforeRoot)}`,
    })
  }

  // Union of what existed and what exists now, so an unauthorized new ref is as visible
  // as a moved one.
  for (const ref of new Set([...Object.keys(baseline.refsBefore), ...Object.keys(refs)])) {
    if (selectedHeads.has(ref) || ref === rootRef) continue
    const before = baseline.refsBefore[ref]
    const now = refs[ref]
    if (now !== before) {
      violations.push({
        invariant: 'preservation.unselected-refs',
        detail: 'a ref outside the authorized write set moved or appeared',
        observed: `${ref} ${shortOid(before ?? ZERO_OID)} -> ${shortOid(now ?? ZERO_OID)}`,
        expected: `${shortOid(before ?? ZERO_OID)}`,
      })
    }
  }

  for (
    let index = 1;
    intent === 'execute' && blockers.length === 0 && index < expectedChain.length;
    index += 1
  ) {
    const predecessor = provider.pullRequest(expectedChain[index - 1])
    const successor = provider.pullRequest(expectedChain[index])
    if (!predecessor || !successor) continue
    const predecessorHead = refs[branchRef(predecessor.head)]
    const successorHead = refs[branchRef(successor.head)]
    if (!predecessorHead || !successorHead) continue
    if (!world.isRemoteAncestor(predecessorHead, successorHead)) {
      violations.push({
        invariant: 'preservation.cumulative',
        detail: `pull request #${successor.number} does not incorporate the prepared state of #${predecessor.number}`,
        observed: `${shortOid(predecessorHead)} is not an ancestor of ${shortOid(successorHead)}`,
        expected: 'the successor integrates the predecessor state',
      })
    }
  }

  const userNow = world.userFingerprint()
  if (expected.preserved.userWorkspace) {
    const changed =
      userNow.headOid !== baseline.userBefore.headOid ||
      userNow.status !== baseline.userBefore.status ||
      userNow.indexDigest !== baseline.userBefore.indexDigest ||
      userNow.worktreeDigest !== baseline.userBefore.worktreeDigest ||
      userNow.stashOids !== baseline.userBefore.stashOids ||
      userNow.stashCount !== baseline.userBefore.stashCount ||
      userNow.configDigest !== baseline.userBefore.configDigest ||
      userNow.identity !== baseline.userBefore.identity
    if (changed) {
      violations.push({
        invariant: 'preservation.user-worktree',
        detail: "the user's checkout, index, stash, or configuration changed",
        observed: JSON.stringify(userNow),
        expected: JSON.stringify(baseline.userBefore),
      })
    }
  }

  // A run that stops and reports may leave its scratch exactly as it found the conflict;
  // only a report that claims success is contradicted by an unfinished workspace.
  for (const scratch of view.status === 'published' ? scratches : []) {
    const unmerged = scratch.unmergedPaths()
    const operations = scratch.operationsInProgress()
    const markers = scratch.conflictMarkerPaths()
    if (unmerged.length > 0 || operations.length > 0 || markers.length > 0) {
      violations.push({
        invariant: 'integrity.clean',
        detail: 'a prepared workspace is not in a clean, finished state',
        observed: `${scratch.path}: unmerged=${unmerged.join(',') || 'none'} operations=${operations.join(',') || 'none'} markers=${markers.join(',') || 'none'}`,
        expected: 'no unmerged entry, no operation in progress, no conflict marker',
      })
    }
  }

  for (const claim of view.remoteClaims) {
    const base = provider.baseOf(Number(claim.target))
    const observed =
      claim.kind === 'pr-base' ? (base ? branchRef(base) : undefined) : refs[claim.target]
    const observedText =
      typeof claim.observed === 'string' ? claim.observed : String(claim.observed)
    if (observed === undefined || observedText !== observed) {
      violations.push({
        invariant: 'remote.claims-match',
        detail: 'a claimed remote observation does not match a re-read',
        observed: `claimed ${claim.kind} ${claim.target} = ${observedText}`,
        expected: `observed ${observed ?? 'absent'}`,
      })
    }
  }

  for (const confirmed of view.confirmed) {
    if (!provider.actions.some((action) => acknowledges(action, confirmed))) {
      violations.push({
        invariant: 'remote.claims-match',
        detail: 'a confirmed write has no acknowledged action behind it',
        observed: `${confirmed.kind} ${confirmed.target}`,
        expected: 'an acknowledged provider action',
      })
    }
  }

  for (const action of provider.actions) {
    if (FORBIDDEN_ACTIONS.includes(action.kind as (typeof FORBIDDEN_ACTIONS)[number])) {
      violations.push({
        invariant: 'remote.actions-permitted',
        detail: 'a prohibited action reached the provider',
        observed: `${action.kind} ${action.target} (${action.outcome})`,
        expected: 'no prohibited action',
      })
      continue
    }
    if (!isPermitted(action.kind)) {
      violations.push({
        invariant: 'remote.actions-permitted',
        detail: 'an action outside the permitted vocabulary reached the provider',
        observed: `${action.kind} ${action.target}`,
        expected: expected.permittedActions.join(', '),
      })
      continue
    }
    if (WRITE_ACTIONS.has(action.kind) && !expected.permittedActions.includes(action.kind)) {
      violations.push({
        invariant: 'remote.actions-permitted',
        detail: 'a write happened that this fixture does not permit',
        observed: `${action.kind} ${action.target}`,
        expected: expected.permittedActions.join(', '),
      })
    }
  }

  for (const command of context.claimedCommands) {
    const forbidden = FORBIDDEN_COMMAND_PATTERNS.find((pattern) => command.includes(pattern))
    if (forbidden) {
      violations.push({
        invariant: 'remote.actions-permitted',
        detail: 'the run executed a check-running command',
        observed: command,
        expected: 'no test, lint, build, or check command during a flattening run',
      })
    }
  }

  for (const code of [...new Set(blockers.map((blocker) => blocker.code))]) {
    if (view.status === 'blocked' || view.status === 'partial' || view.status === 'no-op') {
      if (!view.blockedCodes.includes(code)) {
        violations.push({
          invariant: 'status.legality',
          detail: 'an observed blocker is missing from the reported reasons',
          observed: `observed ${code}, reported ${JSON.stringify(view.blockedCodes)}`,
          expected: `blockedReasons contains ${code}`,
        })
      }
    }
  }

  if (!view.unautomatedReview) {
    violations.push({
      invariant: 'status.legality',
      detail: 'the semantic dimension is not marked unautomated',
      observed: JSON.stringify(claim && typeof claim === 'object' ? 'present' : 'absent'),
      expected: 'semanticReview.automated false with humanReviewRequired true',
    })
  }

  return {
    witnessedStatus,
    ok: violations.length === 0,
    violations,
    blockers,
    unautomated: SEMANTIC_RUBRIC_ITEMS,
  }
}
