import { randomUUID } from 'node:crypto'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import type {
  ActionResult,
  NativeStack,
  PullRequest,
  ReconciledStack,
  ReconciliationAncestry,
  ReconciliationEvidence,
  ReconciliationMember,
  ReconciliationMemberInput,
  ReconciliationPreview,
  ReconciliationPullRequest,
  ReconciliationRepair,
  ReconciliationRepairKind,
  ReconciliationRepairRecord,
  ReconciliationReport,
  ReconciliationStackInput,
  ReconciliationState,
  RepositorySnapshot,
} from '../shared/types'
import {
  commandCode,
  ensureNoBusyOperation,
  ensureNotCheckedOutElsewhere,
  getBranchParent,
  getConfigValue,
  getCurrentBranch,
  getOriginUrl,
  isRecord,
  refExists,
  requireRefInput,
  resolveParentRef,
  runGit,
  stripTrailingNewline,
  tryGit,
  validateBranchName,
} from './git-core'
import { canonicalRemoteName, getGitHubData, getPullRequest, pullRequestRepository } from './github'
import { githubTransport } from './github-transport'

const PLAN_TTL_MS = 5 * 60_000
const JOURNAL_LIMIT = 10
const BACKUP_ROOT = 'refs/git-stacks/reconciliation'
const STALE_PREFIX = 'Reconciliation repair is stale:'

const stateLabels: Record<ReconciliationState, string> = {
  'local-only': 'Local only',
  'remote-native': 'Remote-native order',
  matching: 'Matching',
  stale: 'Stale',
  diverged: 'Diverged',
  reordered: 'Reordered',
  'missing-branch': 'Missing branch',
  retargeted: 'Retargeted',
  merged: 'Merged member',
  'externally-unstacked': 'Externally unstacked',
  ambiguous: 'Ambiguous',
}

export function reconciliationStateLabel(state: ReconciliationState): string {
  return stateLabels[state]
}

function shortOid(value: string | null): string {
  return value ? value.slice(0, 12) : 'unknown'
}

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

/**
 * Collapses the submitted chain around merged members: a branch stacked on a
 * merged pull request must eventually re-root on what that member was stacked
 * on, never on the merged branch itself.
 */
function submittedParentMap(
  order: readonly string[],
  base: string,
  merged: ReadonlySet<string>,
): Map<string, string> {
  const raw = new Map<string, string>()
  for (let index = 0; index < order.length; index++) {
    raw.set(order[index], index === 0 ? base : order[index - 1])
  }
  const resolved = new Map<string, string>()
  for (const head of order) {
    const seen = new Set<string>([head])
    let parent = raw.get(head) ?? base
    while (merged.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      parent = raw.get(parent) ?? base
    }
    resolved.set(head, parent)
  }
  return resolved
}

interface EvaluatedMember {
  member: ReconciliationMember
  submitted: boolean
  expectedParent: string | null
  expectedBase: string | null
  unstacked: boolean
  parentResolvable: boolean
}

/**
 * A recorded parent chain that loops inside one stack cannot be ordered
 * against the submitted chain without guessing, so it is reported as a
 * blocker instead.
 */
function hasRecordedParentCycle(
  members: Map<string, ReconciliationMemberInput>,
  head: string,
  inStack: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>([head])
  let cursor = members.get(head)?.recordedParent ?? null
  while (cursor && inStack.has(cursor)) {
    if (seen.has(cursor)) return true
    seen.add(cursor)
    cursor = members.get(cursor)?.recordedParent ?? null
  }
  return false
}

function connectedToStack(
  members: Map<string, ReconciliationMemberInput>,
  present: readonly string[],
): Set<string> {
  const connected = new Set<string>(present)
  let grew = true
  while (grew) {
    grew = false
    for (const member of members.values()) {
      if (connected.has(member.branch)) continue
      const isChild = member.recordedParent !== null && connected.has(member.recordedParent)
      let isParent = false
      for (const name of connected) {
        if (members.get(name)?.recordedParent === member.branch) {
          isParent = true
          break
        }
      }
      if (isChild || isParent) {
        connected.add(member.branch)
        grew = true
      }
    }
  }
  return connected
}

function memberState(
  input: ReconciliationMemberInput,
  expected: string | null,
  expectedBase: string | null,
  submitted: boolean,
  unstacked: boolean,
): { state: ReconciliationState; detail: string } {
  if (input.localOid === null) {
    return {
      state: 'missing-branch',
      detail: input.remoteOid
        ? `Submitted member has no local branch; origin/${input.branch} is at ${shortOid(input.remoteOid)}`
        : 'Submitted member has neither a local branch nor an origin tracking ref',
    }
  }
  const ancestry = input.ancestry
  const pullRequest = input.pullRequest
  if (unstacked) {
    return {
      state: 'externally-unstacked',
      detail: pullRequest
        ? `#${pullRequest.number} is no longer registered in this stack${
            pullRequest.stackNumber === null
              ? ' and belongs to no GitHub stack'
              : ` and now belongs to stack #${pullRequest.stackNumber}`
          }`
        : 'No longer part of the submitted stack',
    }
  }
  if (submitted && pullRequest?.state === 'MERGED') {
    return {
      state: 'merged',
      detail: `#${pullRequest.number} is merged; the local chain still names it as a parent`,
    }
  }
  if (submitted && pullRequest && expectedBase && pullRequest.base !== expectedBase) {
    return {
      state: 'retargeted',
      detail: `#${pullRequest.number} targets ${pullRequest.base}; the submitted chain bases it on ${expectedBase}`,
    }
  }
  if (submitted && expected && input.recordedParent !== null && input.recordedParent !== expected) {
    return {
      state: 'reordered',
      detail: `Local hint parents this branch on ${input.recordedParent}; the submitted chain bases it on ${expected}`,
    }
  }
  if (ancestry.parentContainsBranch === false && ancestry.branchContainsParent === false) {
    return {
      state: 'diverged',
      detail: ancestry.mergeBase
        ? `No shared history with ${expected ?? 'the submitted base'}: merge-base is ${shortOid(ancestry.mergeBase)}`
        : `No common ancestor with ${expected ?? 'the submitted base'}`,
    }
  }
  if (ancestry.submittedContainsBranch === false && ancestry.branchContainsSubmitted === false) {
    return {
      state: 'diverged',
      detail: `Local tip ${shortOid(input.localOid)} is neither an ancestor nor a descendant of the submitted head ${shortOid(ancestry.parentOid)}`,
    }
  }
  if (
    submitted &&
    ancestry.submittedContainsBranch === false &&
    ancestry.branchContainsSubmitted === true
  ) {
    return {
      state: 'stale',
      detail: `GitHub's submitted head ${shortOid(pullRequest?.headOid ?? null)} is ahead of local ${input.branch}`,
    }
  }
  if (ancestry.recordedParentTipValid === false) {
    return {
      state: 'stale',
      detail: `Recorded parent boundary ${shortOid(input.recordedParentTip)} is no longer part of this branch's history`,
    }
  }
  if (ancestry.parentContainsBranch === false) {
    return {
      state: 'stale',
      detail: `${expected ?? 'The submitted base'} has commits this branch does not contain`,
    }
  }
  if (ancestry.branchContainsRemote === true && ancestry.remoteContainsBranch === false) {
    return {
      state: 'stale',
      detail: `origin/${input.branch} is at ${shortOid(input.remoteOid)}, ahead of the local tip`,
    }
  }
  if (submitted && expected && input.recordedParent === null) {
    return {
      state: 'remote-native',
      detail: `No local parent hint; GitHub bases this branch on ${expected}`,
    }
  }
  if (!submitted && !input.recordedParent) {
    return {
      state: 'matching',
      detail: 'No submitted membership and no local parent hint; this branch is tracked on its own',
    }
  }
  return { state: 'matching', detail: 'Local graph, hints, and submitted chain agree' }
}

function repairsFor(
  state: ReconciliationState,
  evaluated: readonly EvaluatedMember[],
  stack: { number: number | null; submittedOrder: readonly string[] },
  members: Map<string, ReconciliationMemberInput>,
): ReconciliationRepair[] {
  if (state === 'ambiguous' || state === 'matching' || state === 'local-only') return []
  const repairs: Omit<ReconciliationRepair, 'id'>[] = []
  const adopted = new Set<string>()
  for (const entry of evaluated) {
    if (!entry.submitted || !entry.expectedParent) continue
    if (entry.member.recordedParent === entry.expectedParent) continue
    adopted.add(entry.member.branch)
    repairs.push({
      kind: 'adopt-remote-order',
      branch: entry.member.branch,
      pullRequest: entry.member.pullRequest,
      summary: `Record ${entry.member.branch} under ${entry.expectedParent}`,
      detail: `GitHub position ${entry.member.position} of ${stack.submittedOrder.length} bases this branch on ${
        entry.expectedBase ?? entry.expectedParent
      }; the local hint says ${entry.member.recordedParent ?? 'nothing'}. No commit is rewritten.`,
      requiresConfirmation: false,
      evidence: null,
    })
  }
  for (const entry of evaluated) {
    const member = members.get(entry.member.branch)
    if (!member?.recordedParent) continue
    if (adopted.has(entry.member.branch)) continue
    const detached = entry.member.state === 'externally-unstacked'
    // A branch now registered in another native stack belongs to that stack's
    // repair plan. Its local children may still have valid hints there.
    if (detached && member.pullRequest?.stackNumber != null) continue
    const unresolvableParent = entry.submitted && !entry.parentResolvable
    const invalidBoundary = member.ancestry.recordedParentTipValid === false
    if (!detached && !unresolvableParent && !invalidBoundary) continue
    const evidence: ReconciliationEvidence = {
      branch: entry.member.branch,
      backupRef: null,
      previousOid: entry.member.localOid,
      previousParent: member.recordedParent,
      previousParentTip: member.recordedParentTip,
      previousBase: member.pullRequest?.base ?? null,
    }
    repairs.push({
      kind: 'clear-stale-hint',
      branch: entry.member.branch,
      pullRequest: entry.member.pullRequest,
      summary: `Drop the stale parent hint for ${entry.member.branch}`,
      detail: detached
        ? `GitHub no longer places this branch under ${member.recordedParent} in this stack. The previous hint is kept in the repair record.`
        : invalidBoundary
          ? `The recorded boundary ${shortOid(member.recordedParentTip)} is not part of this branch any more. The previous hint is kept in the repair record.`
          : `The recorded parent ${member.recordedParent} does not resolve in this repository. The previous hint is kept in the repair record.`,
      requiresConfirmation: false,
      evidence,
    })
  }
  for (const entry of evaluated) {
    if (entry.member.state !== 'missing-branch') continue
    const member = members.get(entry.member.branch)
    if (!member?.adoptTargetOid || member.adoptTargetOid !== entry.member.submittedHeadOid) continue
    repairs.push({
      kind: 'restore-missing-branch',
      branch: entry.member.branch,
      pullRequest: entry.member.pullRequest,
      summary: `Recreate local branch ${entry.member.branch}`,
      detail: `Restores refs/heads/${entry.member.branch} at the submitted head ${shortOid(member.adoptTargetOid)}. No existing ref is moved.`,
      requiresConfirmation: false,
      evidence: null,
    })
  }
  for (const entry of evaluated) {
    const member = members.get(entry.member.branch)
    const behindSubmitted =
      entry.submitted &&
      member?.ancestry.submittedContainsBranch === false &&
      member.ancestry.branchContainsSubmitted === true
    if (entry.member.state !== 'diverged' && !(entry.member.state === 'stale' && behindSubmitted))
      continue
    if (!member?.adoptTargetOid || !member.localOid) continue
    repairs.push({
      kind: 'adopt-remote-tip',
      branch: entry.member.branch,
      pullRequest: entry.member.pullRequest,
      summary: `Move ${entry.member.branch} to the submitted head`,
      detail: `Resets refs/heads/${entry.member.branch} from ${shortOid(member.localOid)} to ${shortOid(
        member.adoptTargetOid,
      )}. The current tip is kept at ${BACKUP_ROOT} before the move.`,
      requiresConfirmation: true,
      evidence: {
        branch: entry.member.branch,
        backupRef: null,
        previousOid: member.localOid,
        previousParent: member.recordedParent,
        previousParentTip: member.recordedParentTip,
        previousBase: member.pullRequest?.base ?? null,
      },
    })
  }
  for (const entry of evaluated) {
    if (entry.member.state !== 'retargeted' || !entry.member.pullRequest) continue
    const member = members.get(entry.member.branch)
    repairs.push({
      kind: 'retarget-pull-request',
      branch: entry.member.branch,
      pullRequest: entry.member.pullRequest,
      summary: `Retarget #${entry.member.pullRequest} to ${entry.expectedBase ?? 'the submitted base'}`,
      detail: `GitHub bases this member on ${
        member?.pullRequest?.base ?? 'another branch'
      }; the submitted chain positions it on ${entry.expectedBase}.`,
      requiresConfirmation: true,
      evidence: {
        branch: entry.member.branch,
        backupRef: null,
        previousOid: member?.localOid ?? null,
        previousParent: member?.recordedParent ?? null,
        previousParentTip: member?.recordedParentTip ?? null,
        previousBase: member?.pullRequest?.base ?? null,
      },
    })
  }
  return repairs.map((repair) => ({
    ...repair,
    id: JSON.stringify([repair.kind, repair.branch, repair.pullRequest]),
  }))
}

function summaryFor(state: ReconciliationState, stack: ReconciliationStackInput): string {
  const size = stack.submittedOrder.length
  const where =
    stack.stackNumber === null ? 'this local stack' : `GitHub stack #${stack.stackNumber}`
  switch (state) {
    case 'local-only':
      return `No submitted pull requests; ${where} exists only in local parent metadata.`
    case 'remote-native':
      return `${where} carries ${size} submitted member${size === 1 ? '' : 's'} with missing local parent hints; the submitted order is the authoritative record.`
    case 'matching':
      return `${where} matches the local graph, the parent hints, and real ancestry.`
    case 'stale':
      return `${where} is ahead of or behind the local branches; nothing is rewritten until you restack.`
    case 'diverged':
      return `${where} shares no ancestry with part of the local graph.`
    case 'reordered':
      return `${where} submits a different order than the local parent hints.`
    case 'missing-branch':
      return `${where} names a branch this repository does not have.`
    case 'retargeted':
      return `${where} has a pull request whose base was edited outside Git Stacks.`
    case 'merged':
      return `${where} contains a merged pull request while the local chain still names it.`
    case 'externally-unstacked':
      return `A local branch in ${where} was unstacked or moved to another stack on GitHub.`
    case 'ambiguous':
      return `${where} cannot be reconciled without a decision; Git Stacks will not guess.`
  }
}

/**
 * The reconciliation state machine. GitHub's submitted membership is
 * authoritative for order; local hints and real ancestry are compared against
 * it. The result is read-only: it names repairs, it never performs them.
 */
export function reconcileStack(input: ReconciliationStackInput): ReconciledStack {
  const blockers: string[] = []
  const base = input.submittedBase ?? input.defaultBranch
  const order = input.submittedOrder.filter(
    (head) => head.length > 0 && head !== input.defaultBranch,
  )
  const duplicated = [...new Set(order.filter((head, index) => order.indexOf(head) !== index))]
  if (duplicated.length) {
    blockers.push(`GitHub submitted ${duplicated.join(', ')} more than once in this stack`)
  }
  if (input.submittedStatus === 'duplicate-pr') {
    blockers.push('GitHub reports a duplicate pull request in this stack')
  }
  if (input.submittedStatus === 'invalid-chain') {
    blockers.push(
      'GitHub reports a broken head/base chain, so the submitted order cannot be trusted',
    )
  }
  if (input.submittedStatus === 'cross-fork-head') {
    blockers.push('GitHub reports a fork head that does not map to a local branch')
  }

  const members = new Map(input.members.map((member) => [member.branch, member]))
  const merged = new Set<string>()
  for (const head of order) {
    if (members.get(head)?.pullRequest?.state === 'MERGED') merged.add(head)
  }
  const expectedParents = submittedParentMap(order, base, merged)
  const expectedBases = new Map<string, string>()
  for (let index = 0; index < order.length; index++) {
    expectedBases.set(order[index], index === 0 ? base : order[index - 1])
  }
  for (const member of input.members) {
    const submitted = expectedParents.has(member.branch)
    const parent = submitted ? (expectedParents.get(member.branch) ?? null) : member.recordedParent
    if (parent && member.ancestry.parentOid === null) {
      blockers.push(
        `${submitted ? 'Submitted' : 'Recorded'} parent ${parent} for ${member.branch} is unavailable; fetch or restore it before reconciling this stack`,
      )
    }
    if (
      submitted &&
      member.localOid &&
      input.submittedHeadOids[member.branch] &&
      member.ancestry.submittedContainsBranch === null &&
      member.ancestry.branchContainsSubmitted === null
    ) {
      blockers.push(
        `Submitted head ${input.submittedHeadOids[member.branch]} for ${member.branch} is unavailable locally; fetch it before reconciling this stack`,
      )
    }
  }

  const cycleMembers = new Set(input.members.map((member) => member.branch))
  for (const head of cycleMembers) {
    if (!hasRecordedParentCycle(members, head, cycleMembers)) continue
    blockers.push(`Recorded parents form a cycle through ${head} inside this stack`)
    break
  }

  const present = order.filter((head) => members.has(head))
  const connected = connectedToStack(members, present)

  const evaluated: EvaluatedMember[] = []
  const position = new Map(order.map((head, index) => [head, index + 1]))
  // Submitted members keep GitHub's order; every other local branch in the
  // group is appended in name order so the report is deterministic.
  const ordered = [
    ...present,
    ...input.members
      .map((member) => member.branch)
      .filter((name) => !present.includes(name))
      .sort(),
  ]

  for (const branch of [...new Set(ordered)]) {
    const member = members.get(branch)
    if (!member) continue
    const isSubmitted = position.has(branch)
    const expected = isSubmitted ? (expectedParents.get(branch) ?? null) : member.recordedParent
    const unstacked =
      !isSubmitted &&
      connected.has(branch) &&
      member.pullRequest !== null &&
      member.pullRequest.stackNumber !== input.stackNumber
    const verdict = memberState(
      member,
      expected,
      expectedBases.get(branch) ?? null,
      isSubmitted,
      unstacked,
    )
    evaluated.push({
      member: {
        branch,
        position: position.get(branch) ?? 0,
        submittedHeadOid: input.submittedHeadOids[branch] ?? null,
        localOid: member.localOid,
        remoteOid: member.remoteOid,
        recordedParent: member.recordedParent,
        recordedParentTip: member.recordedParentTip,
        expectedParent: expected,
        pullRequest: member.pullRequest?.number ?? null,
        state: verdict.state,
        detail: verdict.detail,
      },
      submitted: isSubmitted,
      expectedParent: expected,
      expectedBase: expectedBases.get(branch) ?? null,
      unstacked,
      parentResolvable: member.ancestry.parentOid !== null,
    })
  }

  const memberStates = new Set(evaluated.map((entry) => entry.member.state))
  // Every submitted head's local hint is compared with its authoritative
  // position, so a permuted local chain always shows up as at least one
  // reordered member; no separate order comparison is needed.

  const hasPullRequest = input.members.some((member) => member.pullRequest !== null)

  let state: ReconciliationState = 'matching'
  if (blockers.length) state = 'ambiguous'
  else if (order.length === 0 && !hasPullRequest) state = 'local-only'
  else if (memberStates.has('missing-branch')) state = 'missing-branch'
  else if (evaluated.some((entry) => entry.unstacked)) state = 'externally-unstacked'
  else if (memberStates.has('merged')) state = 'merged'
  else if (memberStates.has('retargeted')) state = 'retargeted'
  else if (memberStates.has('reordered')) state = 'reordered'
  else if (memberStates.has('diverged')) state = 'diverged'
  else if (memberStates.has('stale')) state = 'stale'
  else if (memberStates.has('remote-native')) state = 'remote-native'
  return {
    key: input.key,
    base,
    stackNumber: input.stackNumber,
    stackUrl: input.stackUrl,
    state,
    summary: summaryFor(state, input),
    submittedOrder: order,
    members: evaluated.map((entry) => entry.member),
    repairs:
      state === 'ambiguous'
        ? []
        : repairsFor(
            state,
            evaluated,
            { number: input.stackNumber, submittedOrder: order },
            members,
          ),
    blockers,
  }
}

// ---------------------------------------------------------------------------
// Git facts
// ---------------------------------------------------------------------------

async function resolveOid(repoPath: string, revision: string): Promise<string | null> {
  const output = await tryGit(repoPath, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revision}^{commit}`,
  ])
  return output ? stripTrailingNewline(output) : null
}

interface Containment {
  mergeBase: string | null
  firstContainsSecond: boolean | null
  secondContainsFirst: boolean | null
}

/**
 * One `merge-base` answers all three containment questions: the merge base
 * being either side means that side is the ancestor. Unrelated histories return
 * no base, which the state machine surfaces as ambiguity rather than a guess.
 */
async function containment(
  repoPath: string,
  first: string | null,
  second: string | null,
): Promise<Containment> {
  if (!first || !second) {
    return { mergeBase: null, firstContainsSecond: null, secondContainsFirst: null }
  }
  if (first === second) {
    return { mergeBase: first, firstContainsSecond: true, secondContainsFirst: true }
  }
  const base = await tryGit(repoPath, ['merge-base', first, second])
  if (!base) return { mergeBase: null, firstContainsSecond: false, secondContainsFirst: false }
  const mergeBase = stripTrailingNewline(base)
  return {
    mergeBase,
    firstContainsSecond: mergeBase === first,
    secondContainsFirst: mergeBase === second,
  }
}

function toReconciliationPullRequest(
  pullRequest: PullRequest | null,
): ReconciliationPullRequest | null {
  if (!pullRequest) return null
  return {
    number: pullRequest.number,
    head: pullRequest.head,
    base: pullRequest.base,
    headOid: pullRequest.headOid ?? null,
    state: pullRequest.state,
    stackNumber: pullRequest.stack?.stackNumber ?? null,
    stackPosition: pullRequest.stack?.position ?? null,
    stackSize: pullRequest.stack?.size ?? null,
    stackBase: pullRequest.stack?.base ?? null,
  }
}

interface MemberFacts {
  localOid: string | null
  remoteOid: string | null
  recordedParent: string | null
  recordedParentTip: string | null
  ancestry: ReconciliationAncestry
  adoptTargetOid: string | null
}

async function collectMemberFacts(
  repoPath: string,
  branch: string,
  expectedParent: string | null,
  submittedOid: string | null,
  remoteOid: string | null,
): Promise<MemberFacts> {
  const localOid = await resolveOid(repoPath, `refs/heads/${branch}`)
  const recordedParent = await getBranchParent(repoPath, branch)
  const recordedParentTip = await getConfigValue(repoPath, `branch.${branch}.parentTip`)
  let parentRef: string | null = null
  if (expectedParent) {
    try {
      parentRef = await resolveParentRef(repoPath, expectedParent)
    } catch (error) {
      const missing = `Parent branch "${expectedParent}" does not exist locally or on a fetched remote`
      const invalid = `Invalid branch name "${expectedParent}":`
      if (
        !(error instanceof Error) ||
        (error.message !== missing && !error.message.startsWith(invalid))
      ) {
        throw error
      }
    }
  }
  const parentOid = parentRef ? await resolveOid(repoPath, parentRef) : null
  const submittedTarget = submittedOid ? await resolveOid(repoPath, submittedOid) : null
  const [parentLink, submittedLink, remoteLink] = await Promise.all([
    containment(repoPath, parentOid, localOid),
    containment(repoPath, submittedTarget, localOid),
    containment(repoPath, remoteOid, localOid),
  ])
  let recordedParentTipValid: boolean | null = null
  if (recordedParentTip && localOid) {
    const link = await containment(
      repoPath,
      await resolveOid(repoPath, recordedParentTip),
      localOid,
    )
    recordedParentTipValid = link.mergeBase ? link.firstContainsSecond : false
  }
  const remoteTarget = !submittedOid && remoteOid ? await resolveOid(repoPath, remoteOid) : null
  const adoptTargetOid = submittedTarget ?? remoteTarget
  return {
    localOid,
    remoteOid,
    recordedParent,
    recordedParentTip,
    ancestry: {
      parentOid,
      mergeBase: parentLink.mergeBase,
      parentContainsBranch: parentLink.firstContainsSecond,
      branchContainsParent: parentLink.secondContainsFirst,
      recordedParentTipValid,
      submittedContainsBranch: submittedLink.firstContainsSecond,
      branchContainsSubmitted: submittedLink.secondContainsFirst,
      remoteContainsBranch: remoteLink.firstContainsSecond,
      branchContainsRemote: remoteLink.secondContainsFirst,
    },
    adoptTargetOid,
  }
}

function nativeStackHeadShas(stack: NativeStack): Record<string, string | null> {
  const shas: Record<string, string | null> = {}
  for (const member of stack.pullRequests) shas[member.head] = member.headSha ?? null
  return shas
}

/**
 * Groups local branches and GitHub's submitted stacks into comparable units and
 * gathers the real ancestry facts for each. Read-only: nothing here writes.
 */
async function collectStackInputs(
  repoPath: string,
  snapshot: RepositorySnapshot,
): Promise<{ inputs: ReconciliationStackInput[]; blockers: string[] }> {
  const blockers: string[] = []
  const defaultBranch = snapshot.defaultBranch
  const originUrl = snapshot.remoteUrl
  const originFullName = canonicalRemoteName(originUrl)
  const localBranches = snapshot.branches.filter(
    (branch) => !branch.remote && branch.name !== defaultBranch,
  )
  const remoteOids = new Map<string, string>()
  for (const branch of snapshot.branches) {
    if (!branch.remote || !branch.ref.startsWith('refs/remotes/origin/')) continue
    remoteOids.set(branch.name.slice('origin/'.length), branch.oid ?? '')
  }
  const pullRequests = new Map<string, PullRequest>()
  for (const pullRequest of snapshot.pullRequests) {
    if (originFullName && pullRequestRepository(pullRequest) !== originFullName) continue
    if (!pullRequests.has(pullRequest.head)) pullRequests.set(pullRequest.head, pullRequest)
  }
  const hints = new Map<string, { parent: string | null; tip: string | null }>()
  await Promise.all(
    localBranches.map(async (branch) => {
      const [parent, tip] = await Promise.all([
        getBranchParent(repoPath, branch.name),
        getConfigValue(repoPath, `branch.${branch.name}.parentTip`),
      ])
      hints.set(branch.name, { parent, tip })
    }),
  )
  const localNames = new Set(localBranches.map((branch) => branch.name))
  const children = new Map<string, string[]>()
  for (const [branch, hint] of hints) {
    if (!hint.parent) continue
    const siblings = children.get(hint.parent)
    if (siblings) siblings.push(branch)
    else children.set(hint.parent, [branch])
  }
  const nativeStacks = (snapshot.nativeStacks ?? []).filter((stack) => stack.open)
  if (nativeStacks.length === 0 && hints.size === 0 && pullRequests.size === 0) {
    return { inputs: [], blockers }
  }

  const claimed = new Set<string>()
  const inputs: ReconciliationStackInput[] = []
  for (const stack of nativeStacks) {
    const order = stack.pullRequests
      .map((member) => member.head)
      .filter((head) => head.length > 0 && head !== defaultBranch)
    const shas = nativeStackHeadShas(stack)
    const stackPullRequests = new Map(
      stack.pullRequests
        .filter((member) => member.head.length > 0)
        .map((member) => [member.head, member]),
    )
    const memberBase = (head: string): string => {
      const index = stack.pullRequests.findIndex((member) => member.head === head)
      if (index <= 0) return stack.base || defaultBranch
      return stack.pullRequests[index - 1].head
    }
    // A local branch belongs to this stack when GitHub still registers its pull
    // request, when it is a submitted head, or when a recorded parent chain
    // links it to one of those heads.
    const groupNames = new Set<string>(order)
    for (const branch of localBranches) {
      const pullRequest = pullRequests.get(branch.name)
      if (pullRequest?.stack?.stackNumber === stack.number) groupNames.add(branch.name)
    }
    const queue = [...groupNames]
    for (let index = 0; index < queue.length; index++) {
      const name = queue[index]
      const parent = hints.get(name)?.parent
      if (parent && localNames.has(parent) && !groupNames.has(parent)) {
        groupNames.add(parent)
        queue.push(parent)
      }
      const descendants = children.get(name)
      if (!descendants) continue
      for (const child of descendants) {
        if (groupNames.has(child)) continue
        groupNames.add(child)
        queue.push(child)
      }
    }
    for (const name of groupNames) claimed.add(name)
    const merged = new Set(order.filter((head) => stackPullRequests.get(head)?.state === 'MERGED'))
    const base = stack.base
    const mergedHeads = new Set(
      stack.pullRequests.filter((member) => member.state === 'MERGED').map((member) => member.head),
    )
    const parentMap = submittedParentMap(
      order,
      base || defaultBranch,
      new Set([...merged, ...mergedHeads]),
    )
    const members: ReconciliationMemberInput[] = []
    for (const name of [...groupNames].sort()) {
      const hint = hints.get(name) ?? { parent: null, tip: null }
      const submittedOid = shas[name] ?? null
      const expectedParent = parentMap.get(name) ?? hint.parent
      const facts = await collectMemberFacts(
        repoPath,
        name,
        expectedParent,
        submittedOid,
        remoteOids.get(name) ?? null,
      )
      // A submitted member that the open-pull-request query no longer returns
      // (a closed or merged one) still carries its identity in the stack
      // payload, so the state machine never has to infer it from local hints.
      const stackMember = stackPullRequests.get(name)
      const pullRequest =
        pullRequests.get(name) ??
        (stackMember
          ? {
              number: stackMember.number,
              title: '',
              url: stack.url,
              head: name,
              base: memberBase(name),
              state: stackMember.state,
              draft: stackMember.draft,
              checks: 'none' as const,
            }
          : null)
      members.push({
        branch: name,
        localOid: facts.localOid,
        remoteOid: facts.remoteOid,
        recordedParent: hint.parent,
        recordedParentTip: hint.tip,
        ancestry: facts.ancestry,
        pullRequest: toReconciliationPullRequest(pullRequest),
        adoptTargetOid: facts.adoptTargetOid,
      })
    }
    inputs.push({
      key: `native:${stack.number}`,
      defaultBranch,
      submittedOrder: order,
      submittedHeadOids: shas,
      submittedBase: stack.base || defaultBranch,
      stackNumber: stack.number,
      stackUrl: stack.url || null,
      submittedStatus: stack.status,
      members,
    })
  }

  // Remaining local branches form purely local stacks from recorded parents.
  const byParent = new Map<string, string[]>()
  const localCandidates: string[] = []
  for (const branch of localBranches) {
    if (claimed.has(branch.name)) continue
    const parent = hints.get(branch.name)?.parent
    if (!parent) continue
    localCandidates.push(branch.name)
    const siblings = byParent.get(parent)
    if (siblings) siblings.push(branch.name)
    else byParent.set(parent, [branch.name])
  }
  for (const siblings of byParent.values()) siblings.sort()
  const visited = new Set<string>()
  for (const seed of localCandidates.sort()) {
    if (visited.has(seed)) continue
    let root = seed
    const seen = new Set<string>([seed])
    while (true) {
      const parent = hints.get(root)?.parent
      if (!parent || !localNames.has(parent) || claimed.has(parent) || seen.has(parent)) break
      root = parent
      seen.add(parent)
    }
    const chain: string[] = []
    const queue = [root]
    for (let index = 0; index < queue.length; index++) {
      const name = queue[index]
      if (visited.has(name)) continue
      visited.add(name)
      chain.push(name)
      for (const child of byParent.get(name) ?? []) {
        if (!visited.has(child)) queue.push(child)
      }
    }
    const members: ReconciliationMemberInput[] = []
    for (const name of chain) {
      const hint = hints.get(name) ?? { parent: null, tip: null }
      const facts = await collectMemberFacts(
        repoPath,
        name,
        hint.parent,
        null,
        remoteOids.get(name) ?? null,
      )
      members.push({
        branch: name,
        localOid: facts.localOid,
        remoteOid: facts.remoteOid,
        recordedParent: hint.parent,
        recordedParentTip: hint.tip,
        ancestry: facts.ancestry,
        pullRequest: toReconciliationPullRequest(pullRequests.get(name) ?? null),
        adoptTargetOid: facts.adoptTargetOid,
      })
    }
    if (!members.length) continue
    inputs.push({
      key: `local:${chain[0]}`,
      defaultBranch,
      submittedOrder: [],
      submittedHeadOids: {},
      submittedBase: null,
      stackNumber: null,
      stackUrl: null,
      submittedStatus: 'valid',
      members,
    })
  }
  return { inputs, blockers }
}

// ---------------------------------------------------------------------------
// Recovery evidence
// ---------------------------------------------------------------------------

interface ReconciliationJournal {
  version: 1
  records: ReconciliationRepairRecord[]
}

async function evidencePath(repoPath: string): Promise<string> {
  const common = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  return path.resolve(repoPath, common, 'git-stacks-reconciled.json')
}

function parseRecord(value: unknown): ReconciliationRepairRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.at !== 'string') return null
  if (!Array.isArray(value.applied) || !Array.isArray(value.evidence)) return null
  return value as unknown as ReconciliationRepairRecord
}

async function readEvidence(repoPath: string): Promise<ReconciliationRepairRecord[]> {
  try {
    const raw = await fs.readFile(await evidencePath(repoPath), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) return []
    return parsed.records
      .map(parseRecord)
      .filter((record): record is ReconciliationRepairRecord => !!record)
  } catch {
    return []
  }
}

async function writeEvidence(repoPath: string, record: ReconciliationRepairRecord): Promise<void> {
  const file = await evidencePath(repoPath)
  const journal: ReconciliationJournal = {
    version: 1,
    records: [
      record,
      ...(await readEvidence(repoPath)).filter((entry) => entry.id !== record.id),
    ].slice(0, JOURNAL_LIMIT),
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, file)
}

/**
 * Builds the read-only reconciliation report that rides on every snapshot.
 * Nothing here writes to Git, GitHub, or local configuration.
 */
export async function buildReconciliationReport(
  repoPath: string,
  snapshot: RepositorySnapshot,
): Promise<ReconciliationReport> {
  const evidence = (await readEvidence(repoPath))[0] ?? null
  const collected = await collectStackInputs(repoPath, snapshot)
  const stacks = collected.inputs.map(reconcileStack)
  if (!snapshot.github.available) {
    return {
      available: false,
      message: snapshot.github.message,
      stacks,
      blockers: collected.blockers,
      evidence,
    }
  }
  if (snapshot.nativeStackPreviewAvailable === false) {
    return {
      available: false,
      message:
        snapshot.nativeStackMessage ??
        'GitHub native stacked pull requests preview API is unavailable; submitted order cannot be confirmed.',
      stacks,
      blockers: collected.blockers,
      evidence,
    }
  }
  const drifting = stacks.filter(
    (stack) => stack.state !== 'matching' && stack.state !== 'local-only',
  )
  return {
    available: true,
    message:
      drifting.length === 0
        ? 'Submitted stack membership matches the local graph.'
        : `${drifting.length} stack${drifting.length === 1 ? '' : 's'} need${drifting.length === 1 ? 's' : ''} reconciliation.`,
    stacks,
    blockers: collected.blockers,
    evidence,
  }
}

// ---------------------------------------------------------------------------
// Previewed repairs
// ---------------------------------------------------------------------------

interface CapturedBranch {
  localOid: string | null
  remoteOid: string | null
  parent: string | null
  parentTip: string | null
}

interface CapturedPullRequest {
  head: string
  base: string
  headOid: string | null
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeOid: string | null
  stackNumber: number | null
}

interface CapturedStack {
  number: number
  open: boolean
  base: string
  status: NativeStack['status']
  members: NativeStack['pullRequests']
}

/** The concrete write one previewed repair will perform, captured up front. */
interface RepairOperation {
  id: string
  kind: ReconciliationRepairKind
  branch: string | null
  pullRequest: number | null
  /** adopt-remote-order: the authoritative parent and boundary to record. */
  parent: string | null
  parentTip: string | null
  /** adopt-remote-tip and restore-missing-branch: the ref value to write. */
  targetOid: string | null
  /** retarget-pull-request: the base the submitted chain requires. */
  base: string | null
  /** Preserve a verified merged predecessor's immutable replay boundary. */
  mergedCommitOid: string | null
  mergedParentPullRequest: number | null
  previous: ReconciliationEvidence | null
}

interface ReconciliationPlan {
  token: string
  repoPath: string
  expiresAt: number
  stackKey: string
  state: ReconciliationState
  originUrl: string | null
  currentBranch: string | null
  headOid: string | null
  repairs: ReconciliationRepair[]
  operations: RepairOperation[]
  branches: Map<string, CapturedBranch>
  pullRequests: Map<number, CapturedPullRequest>
  stack: CapturedStack | null
  stackUrl: string | null
}

/**
 * Repairs run in this order so ref creation and ref moves settle before the
 * local hints that describe them, and a remote pull-request edit happens last.
 */
const APPLY_ORDER: readonly ReconciliationRepairKind[] = [
  'restore-missing-branch',
  'adopt-remote-tip',
  'adopt-remote-order',
  'clear-stale-hint',
  'retarget-pull-request',
]

const plans = new Map<string, ReconciliationPlan>()

function prunePlans(): void {
  const now = Date.now()
  for (const [token, plan] of plans) if (plan.expiresAt <= now) plans.delete(token)
}

async function captureBranchState(repoPath: string, branch: string): Promise<CapturedBranch> {
  const [localOid, parent, parentTip] = await Promise.all([
    resolveOid(repoPath, `refs/heads/${branch}`),
    getBranchParent(repoPath, branch),
    getConfigValue(repoPath, `branch.${branch}.parentTip`),
  ])
  return {
    localOid,
    remoteOid: await resolveOid(repoPath, `refs/remotes/origin/${branch}`),
    parent,
    parentTip,
  }
}

function capturePullRequest(pullRequest: PullRequest): CapturedPullRequest {
  return {
    head: pullRequest.head,
    base: pullRequest.base,
    headOid: pullRequest.headOid ?? null,
    state: pullRequest.state,
    mergeOid: pullRequest.mergeOid ?? null,
    stackNumber: pullRequest.stack?.stackNumber ?? null,
  }
}

/**
 * Turns a display repair into the exact write it will perform, resolving the
 * parent boundary and target commit now so the token is only usable against
 * these facts. A repair that cannot be resolved is dropped, not offered.
 */
async function captureOperation(
  repoPath: string,
  stack: ReconciledStack,
  repair: ReconciliationRepair,
): Promise<RepairOperation | null> {
  const member = repair.branch
    ? (stack.members.find((entry) => entry.branch === repair.branch) ?? null)
    : null
  const operation: RepairOperation = {
    id: repair.id,
    kind: repair.kind,
    branch: repair.branch,
    pullRequest: repair.pullRequest,
    parent: null,
    parentTip: null,
    targetOid: null,
    base: null,
    mergedCommitOid: null,
    mergedParentPullRequest: null,
    previous: repair.evidence,
  }
  if (repair.kind === 'clear-stale-hint') return operation
  if (repair.kind === 'retarget-pull-request') {
    const position = stack.submittedOrder.indexOf(repair.branch ?? '')
    if (position < 0) return null
    return {
      ...operation,
      base: position === 0 ? stack.base : stack.submittedOrder[position - 1],
    }
  }
  if (repair.kind === 'adopt-remote-order') {
    const parent = member?.expectedParent ?? null
    if (!member || !parent || !member.localOid || !repair.branch) return null
    const parentOid = await resolveOid(repoPath, await resolveParentRef(repoPath, parent))
    if (!parentOid) return null
    const boundary = await tryGit(repoPath, ['merge-base', parentOid, member.localOid])
    if (!boundary) return null
    const position = stack.submittedOrder.indexOf(member.branch)
    const submittedPredecessor = position > 0 ? stack.submittedOrder[position - 1] : null
    // Collapsing a merged PR changes the effective parent even when B has no
    // app-local hint. The submitted predecessor still requires a proven replay boundary.
    const skippedPredecessor = submittedPredecessor !== null && submittedPredecessor !== parent
    const mergedParent = skippedPredecessor
      ? stack.members.find((entry) => entry.branch === submittedPredecessor)
      : stack.members.find(
          (entry) => entry.branch === member.recordedParent && entry.state === 'merged',
        )
    if (skippedPredecessor && !mergedParent) return null
    let replayBoundary = stripTrailingNewline(boundary)
    let mergedCommitOid: string | null = null
    if (mergedParent) {
      const mergedPr = mergedParent.pullRequest
        ? await getPullRequest(repoPath, mergedParent.pullRequest)
        : null
      const recorded = member.recordedParentTip
      // A later recorded tip can contain work excluded from the squash merge.
      // Only the submitted head is proven safe to exclude from child replay.
      if (
        mergedPr?.state !== 'MERGED' ||
        !mergedPr.mergeOid ||
        !mergedParent.submittedHeadOid ||
        !recorded ||
        (await containment(repoPath, mergedPr.mergeOid, parentOid)).mergeBase !==
          mergedPr.mergeOid ||
        recorded !== mergedParent.submittedHeadOid ||
        (await containment(repoPath, recorded, member.localOid)).mergeBase !== recorded
      ) {
        return null
      }
      replayBoundary = recorded
      mergedCommitOid = mergedPr.mergeOid
    }
    return {
      ...operation,
      parent,
      parentTip: replayBoundary,
      mergedCommitOid,
      mergedParentPullRequest: mergedParent?.pullRequest ?? null,
      previous: {
        branch: repair.branch,
        backupRef: null,
        previousOid: member.localOid,
        previousParent: member.recordedParent,
        previousParentTip: member.recordedParentTip,
        previousBase: null,
      },
    }
  }
  if (!repair.branch) return null
  if (repair.kind === 'restore-missing-branch') {
    if (await refExists(repoPath, `refs/heads/${repair.branch}`)) return null
    const submittedOid = member?.submittedHeadOid ?? null
    if (!submittedOid || !(await resolveOid(repoPath, submittedOid))) return null
    return {
      ...operation,
      targetOid: submittedOid,
      previous: {
        branch: repair.branch,
        backupRef: null,
        previousOid: null,
        previousParent: null,
        previousParentTip: null,
        previousBase: repair.evidence?.previousBase ?? null,
      },
    }
  }
  const localOid = member?.localOid ?? null
  const target = member?.submittedHeadOid ?? member?.remoteOid ?? null
  if (!localOid || !target || target === localOid) return null
  if (!(await resolveOid(repoPath, target))) return null
  return {
    ...operation,
    targetOid: target,
    previous: {
      branch: repair.branch,
      backupRef: null,
      previousOid: localOid,
      previousParent: member?.recordedParent ?? null,
      previousParentTip: member?.recordedParentTip ?? null,
      previousBase: repair.evidence?.previousBase ?? null,
    },
  }
}

/**
 * Reads the current reconciliation for one stack and captures the exact branch,
 * configuration, and pull-request identity a repair would rely on. The token is
 * only usable against these facts.
 */
export async function previewReconciliationRepair(
  repoPath: string,
  snapshot: RepositorySnapshot,
  stackKeyInput: unknown,
): Promise<ReconciliationPreview> {
  const stackKey = requireRefInput(stackKeyInput, 'stack key')
  prunePlans()
  const report = await buildReconciliationReport(repoPath, snapshot)
  if (!report.available) {
    throw new Error(`Submitted stack reconciliation is unavailable: ${report.message}`)
  }
  const stack = report.stacks.find((entry) => entry.key === stackKey)
  if (!stack) throw new Error('That stack is no longer part of the reconciliation report')
  const operations: RepairOperation[] = []
  for (const repair of stack.repairs) {
    const operation = await captureOperation(repoPath, stack, repair)
    if (operation) operations.push(operation)
  }
  const offered = stack.repairs.filter((repair) =>
    operations.some((operation) => operation.id === repair.id),
  )
  const nativeStack = (snapshot.nativeStacks ?? []).find(
    (entry) => `native:${entry.number}` === stackKey,
  )
  const branches = new Map<string, CapturedBranch>()
  for (const member of stack.members) {
    branches.set(member.branch, await captureBranchState(repoPath, member.branch))
  }
  const watchedPullRequests = new Set(
    nativeStack?.pullRequests.map((member) => member.number) ?? [],
  )
  for (const repair of offered) {
    if (repair.pullRequest !== null) watchedPullRequests.add(repair.pullRequest)
  }
  const pullRequests = new Map<number, CapturedPullRequest>()
  for (const number of watchedPullRequests) {
    const pullRequest = snapshot.pullRequests.find((entry) => entry.number === number)
    if (pullRequest) pullRequests.set(number, capturePullRequest(pullRequest))
  }
  const [currentBranch, headOid] = await Promise.all([
    getCurrentBranch(repoPath),
    resolveOid(repoPath, 'HEAD'),
  ])
  const plan: ReconciliationPlan = {
    token: randomUUID(),
    repoPath,
    expiresAt: Date.now() + PLAN_TTL_MS,
    stackKey,
    state: stack.state,
    originUrl: snapshot.remoteUrl,
    currentBranch,
    headOid,
    repairs: offered,
    operations,
    branches,
    pullRequests,
    stack: nativeStack
      ? {
          number: nativeStack.number,
          open: nativeStack.open,
          base: nativeStack.base,
          status: nativeStack.status,
          members: nativeStack.pullRequests.map((member) => ({ ...member })),
        }
      : null,
    stackUrl: stack.stackUrl,
  }
  plans.set(plan.token, plan)
  return {
    token: plan.token,
    stackKey,
    state: stack.state,
    summary: stack.summary,
    base: stack.base,
    submittedOrder: stack.submittedOrder,
    repairs: offered,
    blockers: stack.blockers,
    warnings: offered
      .filter((repair) => repair.requiresConfirmation)
      .map((repair) => repair.summary),
    capturedAt: new Date().toISOString(),
  }
}

async function revalidatePlan(repoPath: string, plan: ReconciliationPlan): Promise<void> {
  if ((await getOriginUrl(repoPath)) !== plan.originUrl) {
    throw new Error(`${STALE_PREFIX} the origin remote changed`)
  }
  if ((await getCurrentBranch(repoPath)) !== plan.currentBranch) {
    throw new Error(`${STALE_PREFIX} the checked-out branch changed`)
  }
  if ((await resolveOid(repoPath, 'HEAD')) !== plan.headOid) {
    throw new Error(`${STALE_PREFIX} HEAD moved`)
  }
  for (const [branch, captured] of plan.branches) {
    const current = await captureBranchState(repoPath, branch)
    if (
      current.localOid !== captured.localOid ||
      current.remoteOid !== captured.remoteOid ||
      current.parent !== captured.parent ||
      current.parentTip !== captured.parentTip
    ) {
      throw new Error(`${STALE_PREFIX} ${branch} changed since the preview was captured`)
    }
  }
  for (const operation of plan.operations) {
    if (!operation.mergedCommitOid || !operation.mergedParentPullRequest) continue
    const merged = await getPullRequest(repoPath, operation.mergedParentPullRequest)
    if (merged.state !== 'MERGED' || merged.mergeOid !== operation.mergedCommitOid) {
      throw new Error(
        `${STALE_PREFIX} pull request #${operation.mergedParentPullRequest} changed since the preview was captured`,
      )
    }
  }
  if (!plan.pullRequests.size && !plan.stack) return
  const data = await getGitHubData(repoPath, plan.originUrl)
  if (!data.available) {
    throw new Error(`${STALE_PREFIX} GitHub is no longer reachable (${data.message})`)
  }
  for (const [number, captured] of plan.pullRequests) {
    const current = data.pullRequests.find((entry) => entry.number === number)
    if (!current) throw new Error(`${STALE_PREFIX} pull request #${number} is no longer listed`)
    const identity = capturePullRequest(current)
    if (
      identity.head !== captured.head ||
      identity.base !== captured.base ||
      identity.headOid !== captured.headOid ||
      identity.state !== captured.state ||
      identity.mergeOid !== captured.mergeOid ||
      identity.stackNumber !== captured.stackNumber
    ) {
      throw new Error(
        `${STALE_PREFIX} pull request #${number} changed since the preview was captured`,
      )
    }
  }
  if (plan.stack) {
    const current = (data.nativeStacks ?? []).find((entry) => entry.number === plan.stack!.number)
    if (!current) {
      throw new Error(`${STALE_PREFIX} stack #${plan.stack.number} is no longer registered`)
    }
    const capturedMembers = plan.stack.members
    if (
      current.open !== plan.stack.open ||
      current.base !== plan.stack.base ||
      current.status !== plan.stack.status ||
      current.pullRequests.length !== capturedMembers.length ||
      current.pullRequests.some((member, index) => {
        const captured = capturedMembers[index]
        return (
          member.number !== captured.number ||
          member.head !== captured.head ||
          member.headSha !== captured.headSha ||
          member.base !== captured.base ||
          member.state !== captured.state ||
          member.draft !== captured.draft
        )
      })
    ) {
      throw new Error(`${STALE_PREFIX} stack #${plan.stack.number} changed on GitHub`)
    }
  }
}

async function setBranchMetadata(
  repoPath: string,
  branch: string,
  parent: string,
  parentTip: string,
): Promise<void> {
  await runGit(repoPath, ['config', '--local', `branch.${branch}.parent`, parent])
  await runGit(repoPath, ['config', '--local', `branch.${branch}.parentTip`, parentTip])
}

async function unsetConfig(repoPath: string, key: string): Promise<void> {
  try {
    await runGit(repoPath, ['config', '--local', '--unset-all', key])
  } catch (error) {
    // git exits 5 when the key was never set; an absent hint is already clear.
    if (commandCode(error) !== 5) throw error
  }
}

async function clearBranchMetadata(repoPath: string, branch: string): Promise<void> {
  await unsetConfig(repoPath, `branch.${branch}.parent`)
  await unsetConfig(repoPath, `branch.${branch}.parentTip`)
}

function backupRefFor(id: string, branch: string): string {
  return `${BACKUP_ROOT}/${id}/${Buffer.from(branch, 'utf8').toString('hex')}`
}

function planRepair(plan: ReconciliationPlan, operation: RepairOperation): ReconciliationRepair {
  const repair = plan.repairs.find((entry) => entry.id === operation.id)
  if (!repair) throw new Error('Captured reconciliation repair is no longer offered')
  return repair
}

/**
 * Performs one captured repair. The previous parent hint, boundary, tip, and
 * pull-request base are appended to the repair record and flushed to disk
 * before the first write, so a cleared hint or a moved branch always leaves
 * recovery evidence behind.
 */
async function applyOperation(
  repoPath: string,
  operation: RepairOperation,
  record: ReconciliationRepairRecord,
  id: string,
  originFullName: string | null,
  movedTips: ReadonlyMap<string, string>,
): Promise<boolean> {
  if (operation.kind === 'retarget-pull-request') {
    if (operation.pullRequest === null || !originFullName || !operation.base) return false
    record.evidence.push({
      branch: operation.branch ?? '',
      backupRef: null,
      previousOid: null,
      previousParent: operation.previous?.previousParent ?? null,
      previousParentTip: operation.previous?.previousParentTip ?? null,
      previousBase: operation.previous?.previousBase ?? null,
    })
    await writeEvidence(repoPath, record)
    await githubTransport().rest({
      method: 'PATCH',
      path: `repos/${originFullName}/pulls/${operation.pullRequest}`,
      body: { base: operation.base },
    })
    return true
  }
  const branch = operation.branch
  if (!branch) return false
  await validateBranchName(repoPath, branch)
  if (operation.kind === 'restore-missing-branch') {
    if (!operation.targetOid) return false
    if (await refExists(repoPath, `refs/heads/${branch}`)) return false
    record.evidence.push({
      branch,
      backupRef: null,
      previousOid: null,
      previousParent: null,
      previousParentTip: null,
      previousBase: operation.previous?.previousBase ?? null,
    })
    await writeEvidence(repoPath, record)
    await runGit(repoPath, [
      'update-ref',
      `refs/heads/${branch}`,
      operation.targetOid,
      '0'.repeat(40),
    ])
    return true
  }
  if (operation.kind === 'adopt-remote-tip') {
    const previousOid = operation.previous?.previousOid ?? null
    if (!operation.targetOid || !previousOid) return false
    if ((await resolveOid(repoPath, `refs/heads/${branch}`)) !== previousOid) return false
    if ((await getCurrentBranch(repoPath)) === branch) {
      throw new Error(
        `Switch away from ${branch} before moving its tip; the checked-out worktree cannot be updated by this repair`,
      )
    }
    await ensureNotCheckedOutElsewhere(repoPath, branch)
    const backupRef = backupRefFor(id, branch)
    await runGit(repoPath, ['update-ref', backupRef, previousOid])
    record.evidence.push({ ...operation.previous!, backupRef })
    await writeEvidence(repoPath, record)
    await runGit(repoPath, ['update-ref', `refs/heads/${branch}`, operation.targetOid, previousOid])
    return true
  }
  const [parent, parentTip] = await Promise.all([
    getBranchParent(repoPath, branch),
    getConfigValue(repoPath, `branch.${branch}.parentTip`),
  ])
  const currentOid = await resolveOid(repoPath, `refs/heads/${branch}`)
  if (
    !operation.previous ||
    parent !== operation.previous.previousParent ||
    parentTip !== operation.previous.previousParentTip ||
    currentOid !== (movedTips.get(branch) ?? operation.previous.previousOid)
  ) {
    throw new Error(`${STALE_PREFIX} ${branch} changed since the preview was captured`)
  }
  if (operation.kind === 'adopt-remote-order') {
    if (!operation.parent || !operation.parentTip) return false
    await validateBranchName(repoPath, operation.parent)
    let nextParentTip = operation.parentTip
    if (operation.mergedCommitOid) {
      const parentOid = await resolveOid(
        repoPath,
        await resolveParentRef(repoPath, operation.parent),
      )
      if (
        !parentOid ||
        !currentOid ||
        (await containment(repoPath, operation.mergedCommitOid, parentOid)).mergeBase !==
          operation.mergedCommitOid ||
        (await containment(repoPath, operation.parentTip, currentOid)).mergeBase !==
          operation.parentTip
      ) {
        throw new Error(
          `Cannot record ${branch} under ${operation.parent}: merged predecessor or safe replay boundary changed`,
        )
      }
    } else if (movedTips.has(branch) || movedTips.has(operation.parent)) {
      const parentOid = await resolveOid(
        repoPath,
        await resolveParentRef(repoPath, operation.parent),
      )
      const boundary =
        parentOid && currentOid
          ? await tryGit(repoPath, ['merge-base', parentOid, currentOid])
          : null
      if (!boundary) {
        throw new Error(`Cannot record ${branch} under ${operation.parent}: no common ancestor`)
      }
      nextParentTip = stripTrailingNewline(boundary)
    }
    record.evidence.push({
      branch,
      backupRef: null,
      previousOid: currentOid,
      previousParent: parent,
      previousParentTip: parentTip,
      previousBase: operation.previous?.previousBase ?? null,
    })
    await writeEvidence(repoPath, record)
    await setBranchMetadata(repoPath, branch, operation.parent, nextParentTip)
    return true
  }
  if (parent === null && parentTip === null) return false
  record.evidence.push({
    branch,
    backupRef: null,
    previousOid: currentOid,
    previousParent: parent,
    previousParentTip: parentTip,
    previousBase: operation.previous?.previousBase ?? null,
  })
  await writeEvidence(repoPath, record)
  await clearBranchMetadata(repoPath, branch)
  return true
}

/**
 * Applies the selected repairs from a captured preview. Every mutation
 * revalidates the captured branch, configuration, and pull-request identity
 * first, so a concurrent edit between preview and execute is reported instead
 * of silently overwritten.
 */

/**
 * The same repository reached through a symlinked path must compare equal, so
 * a preview stays usable when the caller resolves the path differently.
 */
function canonicalPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/** A selected subset can be cyclic even when every offered repair is safe alone. */
function assertSelectedParentGraphAcyclic(
  plan: ReconciliationPlan,
  operations: readonly RepairOperation[],
): void {
  if (
    !operations.some(
      (operation) =>
        operation.branch &&
        (operation.kind === 'adopt-remote-order' || operation.kind === 'clear-stale-hint'),
    )
  ) {
    return
  }
  const parents = new Map<string, string | null>()
  for (const [branch, captured] of plan.branches) parents.set(branch, captured.parent)
  for (const operation of operations) {
    if (!operation.branch) continue
    if (operation.kind === 'adopt-remote-order') {
      parents.set(operation.branch, operation.parent)
    } else if (operation.kind === 'clear-stale-hint') {
      parents.set(operation.branch, null)
    }
  }
  for (const operation of operations) {
    if (
      !operation.branch ||
      (operation.kind !== 'adopt-remote-order' && operation.kind !== 'clear-stale-hint')
    ) {
      continue
    }
    const visited = new Set<string>()
    let branch: string | null = operation.branch
    while (branch && parents.has(branch)) {
      if (visited.has(branch)) {
        throw new Error(
          `Selected repairs would create a local parent cycle through ${branch}; select the dependent order repairs together`,
        )
      }
      visited.add(branch)
      branch = parents.get(branch) ?? null
    }
  }
}

export async function runReconciliationRepair(
  repoPath: string,
  action: { token: string; ids: string[]; confirmRewrites: boolean },
): Promise<ActionResult> {
  prunePlans()
  const plan = plans.get(action.token)
  if (!plan || plan.expiresAt <= Date.now()) {
    throw new Error('Reconciliation preview token is missing or expired; refresh the preview')
  }
  if (canonicalPath(plan.repoPath) !== canonicalPath(repoPath)) {
    throw new Error('Reconciliation preview belongs to a different repository')
  }
  if (plan.state === 'ambiguous') {
    throw new Error('Resolve the reported ambiguity before repairing this stack')
  }
  const selected = [...new Set(action.ids)]
  if (!selected.every((id) => plan.operations.some((entry) => entry.id === id))) {
    throw new Error('That repair is not offered for this stack in the current preview')
  }
  const operations = plan.operations.filter((operation) => selected.includes(operation.id))
  if (!operations.length) {
    throw new Error('Select at least one repair offered by the current preview')
  }
  if (
    operations.some((operation) => planRepair(plan, operation).requiresConfirmation) &&
    !action.confirmRewrites
  ) {
    throw new Error('Confirm branch and pull-request rewrites before running this repair')
  }
  await ensureNoBusyOperation(repoPath, 'reconcile a submitted stack')
  await revalidatePlan(repoPath, plan)
  assertSelectedParentGraphAcyclic(plan, operations)
  const checkedOut = await getCurrentBranch(repoPath)
  const rewritingCheckout = operations.find(
    (operation) => operation.kind === 'adopt-remote-tip' && operation.branch === checkedOut,
  )
  if (rewritingCheckout) {
    throw new Error(
      `Switch away from ${checkedOut} before moving its tip; the checked-out worktree cannot be updated by this repair`,
    )
  }
  // The plan is only spent once its captured identity still holds, so a rejected
  // attempt that changed nothing can be corrected and retried.
  plans.delete(action.token)

  const id = randomUUID()
  const record: ReconciliationRepairRecord = {
    id,
    at: new Date().toISOString(),
    stackKey: plan.stackKey,
    state: plan.state,
    applied: [],
    evidence: [],
  }
  await writeEvidence(repoPath, record)
  const originFullName = canonicalRemoteName(plan.originUrl)
  const summaries: string[] = []
  const movedTips = new Map<string, string>()
  for (const kind of APPLY_ORDER) {
    for (const operation of operations.filter((entry) => entry.kind === kind)) {
      const changed = await applyOperation(
        repoPath,
        operation,
        record,
        id,
        originFullName,
        movedTips,
      )
      if (!changed) continue
      if (
        (operation.kind === 'adopt-remote-tip' || operation.kind === 'restore-missing-branch') &&
        operation.branch &&
        operation.targetOid
      ) {
        movedTips.set(operation.branch, operation.targetOid)
      }
      record.applied.push({
        kind: operation.kind,
        branch: operation.branch,
        pullRequest: operation.pullRequest,
      })
      await writeEvidence(repoPath, record)
      summaries.push(planRepair(plan, operation).summary)
    }
  }
  const skipped = operations.length - record.applied.length
  return {
    message: `Reconciled ${stateLabels[plan.state].toLowerCase()} stack ${plan.stackKey}: ${
      summaries.join('; ') || 'nothing left to change'
    }${
      skipped
        ? `; ${skipped} repair${skipped === 1 ? '' : 's'} already applied or no longer possible`
        : ''
    }. Previous state is recorded in git-stacks-reconciled.json.`,
    ...(plan.stackUrl ? { url: plan.stackUrl } : {}),
  }
}
