import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileHandle } from 'node:fs/promises'
import type {
  ActionResult,
  Branch,
  NativeStack,
  MergeAction,
  MergeLayerPreview,
  MergeLayerResult,
  MergeMethod,
  MergePreview,
  MergeProgress,
  MergeQueueState,
  MergeRequestOutcome,
  MergeResult,
  MergeStatus,
  PublishLayer,
  PublishLayerChoice,
  PublishPreview,
  PublishProgress,
  PublishStackAction,
  PublishStep,
  PublishStepFailure,
  PublishStepKind,
  PullRequest,
  RepositorySnapshot,
  StackAction,
  StackKind,
  StackPreview,
  StackProgress,
  StackStep,
  SurgeryPreview,
  SubmitStackAction,
} from '../shared/types'
import {
  CommandCancelled,
  MAX_MESSAGE_LENGTH,
  branchUpstream,
  commandCode,
  commandDetail,
  ensureClean,
  ensureNoBusyOperation,
  ensureNotCheckedOutElsewhere,
  getBranchParent,
  getConfigValue,
  getCurrentBranch,
  getDefaultBranch,
  getOperationState,
  getOriginUrl,
  getRefs,
  getRemotePushUrl,
  getStatus,
  parseRemote,
  refExists,
  requireRefInput,
  requireString,
  resolveParentRef,
  runGit,
  stripTrailingNewline,
  tryGit,
  validateBranchName,
} from './git-core'
import { isRecord } from '../shared/guards'
import {
  addPullRequestsToNativeStackAction,
  addPullRequestsToStack,
  createNativeStackAction,
  createPullRequestStack,
  detectNativeStacksCapability,
  getPullRequestStack,
  listPullRequestStacks,
  NativeStackError,
  revalidatePublishedStackRegistration,
  retireLegacyStackComments,
  unstackNativeStackAction,
} from './native-stacks'
import { canonicalRemoteName, getGitHubData, getPullRequest, pullRequestRepository } from './github'
import {
  type GitHubHostContext,
  hostTransport,
  remoteHostContext,
  type NativeStackCapabilityReason,
} from './github-host'
import { GitHubTransportError } from './github-transport'
import type { GitHubResult } from './github'
import { runReconciliationRepair } from './reconciliation'
import {
  buildSyncPreview,
  runSyncStack,
  syncPushLayers,
  syncRebaseLayers,
  type SyncCapture,
  type SyncLayerFacts,
  type SyncRemoteRelation,
} from './sync-stack'
import { runLinkIssueAction, runUnlinkIssueAction } from './issue-links'
import {
  planSurgery,
  type SurgeryCapture,
  type SurgeryLayerFacts,
  type SurgeryPlan,
  type SurgeryPullRequestPlan,
  type SurgeryRequest,
} from './stack-surgery'
import {
  pollAsyncMerge,
  readMergeObservations,
  readMergeRequest,
  recordMergeObservation,
  startAsyncMerge,
  mergeQueueState,
  queueConfiguredFor,
  type AsyncMergeResult,
  type MergeQueueObservation,
} from './merge-async'

const PLAN_TTL_MS = 5 * 60_000
const JOURNAL_VERSION = 1

interface BranchRecord {
  name: string
  oid: string
  parent: string | null
  parentTip: string | null
  invalidParentTip: boolean
  parentSource: 'recorded' | 'pullRequest' | 'stack' | 'inferred' | null
  pr: PullRequest | null
  mergedHeadPr: string | null
  mergedHeadOid: string | null
  mergedCommitOid: string | null
}

interface PlanEntry {
  branch: string
  parent: string
  parentRef: string
  parentOid: string
  oldParent: string | null
  oldTip: string
  boundary: string
  oldParentTip: string | null
  parentTipSource: 'recorded' | 'merge-base' | 'parent-tip'
  needsRestack: boolean
  pr: PullRequest | null
  remoteOid: string | null
  upstream: string | null
  retargetedFrom: string | null
  note: string
}

interface StackPlan {
  token: string
  repoPath: string
  expiresAt: number
  kind: StackKind
  branch: string
  /** The branch the whole stack hangs from: the native stack base, or the repository default. */
  trunk: string
  defaultBranch: string
  originUrl: string | null
  pushUrl: string | null
  originFullName: string | null
  originalBranch: string | null
  originalHead: string | null
  entries: PlanEntry[]
  capturedParents: Record<string, string | null>
  capturedParentTips: Record<string, string | null>
  capturedParentOids: Record<string, string | null>
  capturedTips: Record<string, string>
  capturedRemoteOids: Record<string, string | null>
  /** The pull request identity every connected layer had when the preview was taken. */
  capturedPrs: Record<string, CapturedPullRequest | null>
  /** Native stack membership, so a publish preview also detects an unstacked layer. */
  capturedStacks: CapturedStack[]
  /**
   * Whether the host serving this repository was observed to expose the native
   * stacks resource for it. False means the stack is local to this machine and
   * the pull requests publish as an ordinary chain; nothing claims otherwise.
   */
  nativeStacksAvailable: boolean
  /**
   * What the native stacks probe established for this repository. Only
   * `endpoint-missing` is a confirmed absence; every other reason leaves the
   * capability unestablished, and no step, label, or message is derived from it.
   */
  nativeStacksReason: NativeStackCapabilityReason | 'not-applicable'
  capturedMergedHeads: Record<
    string,
    { pr: string | null; oid: string | null; commit: string | null }
  >
  warnings: string[]
  blockers: string[]
  mergeMethods: MergeMethod[]
  /** Present only for a sync preview: the facts the per-layer classification rests on. */
  sync: SyncCapture | null
  /** A surgery re-reads pull requests and native stacks like a publish plan does. */
  revalidateRemote?: boolean
  /**
   * Present only for a merge: the pull requests one reviewed action will land, bottom-to-top,
   * with the head each one was reviewed at. A GitHub-native stack lands all of them from a
   * single request for the selected pull request; a locally chained stack needs one
   * request per layer.
   */
  merge: MergePreview | null
  /** The native stack this merge belongs to, revalidated at the mutation boundary. */
  mergeStackNumber: number | null
}

interface JournalEntry {
  branch: string
  oldTip: string
  newTip: string | null
  oldParent: string | null
  oldParentTip: string | null
  newParent: string
  newParentRef: string
  newParentOid: string
  newParentTip: string | null
  boundary: string
  backupRef: string
  headReflogCount: number | null
  status: 'pending' | 'rebasing' | 'metadata' | 'completed' | 'restored'
}

interface SyncPushEntry {
  branch: string
  expectedRemoteOid: string | null
  force: boolean
  status?: 'pending' | 'completed'
  publishedOid?: string | null
}

interface SyncPushConfig {
  originUrl?: string
  pushUrl: string
  allowForce: boolean
  branches: SyncPushEntry[]
}

interface StackJournal {
  version: 1
  id: string
  /** Restack and sync share one journal; the label is what the recovery banner shows. */
  kind: 'restack' | 'sync'
  repoPath: string
  originalBranch: string | null
  originalHead: string | null
  currentBranch: string | null
  entries: JournalEntry[]
  status: 'running' | 'conflict' | 'uncertain' | 'aborting'
  message: string
  syncPushes?: SyncPushConfig
  created?: CreatedBranch[]
  removed?: RemovedBranch[]
  surgery?: SurgeryConfig
}

/** A branch a surgery creates, tracked so an abort removes the ref it made. */
interface CreatedBranch {
  branch: string
  oid: string
  parent: string
  parentTip: string
}

/** A branch a surgery removes, tracked so an abort restores the ref it deleted. */
interface RemovedBranch {
  branch: string
  oldTip: string
  oldParent: string | null
  oldParentTip: string | null
  backupRef: string
  status: 'pending' | 'completed' | 'restored'
}

/** One pull request change a reviewed surgery makes, journalled before it is sent. */
interface SurgeryPullRequestStep {
  branch: string
  number: number
  action: 'retarget' | 'close'
  /** The head ref and commit GitHub held when the preview was taken. */
  headRef: string
  capturedHeadOid: string | null
  /** The base GitHub recorded when the preview was taken. */
  fromBase: string
  toBase: string
  status: 'pending' | 'completed'
}

/**
 * The native stack mutation a reviewed surgery makes. GitHub can only unstack
 * a whole stack, so a changed composition is unstacked and registered again in
 * the reviewed order, and each half is journalled so an interrupted run resumes
 * at the first step that did not happen.
 */
interface SurgeryStackStep {
  stackNumber: number
  action: 'unstack' | 'unstack-and-create'
  /** The membership this stack held when the preview was taken, bottom-to-top. */
  membersBefore: number[]
  /** The members the recreated stack must hold, bottom-to-top. */
  members: number[]
  trunk: string
  unstackStatus: 'pending' | 'completed'
  createStatus: 'pending' | 'completed' | 'skipped'
  createRequested: boolean
  stackNumberAfter: number | null
}

interface SurgeryConfig {
  /** The GitHub repository the published half acts on, or null for a local-only surgery. */
  fullName: string | null
  originUrl?: string
  pushUrl: string | null
  trunk: string
  pullRequests: SurgeryPullRequestStep[]
  stack: SurgeryStackStep | null
}

/** The native stack membership captured when a publish preview was taken. */
interface CapturedStack {
  number: number
  open: boolean
  base: string
  status: NativeStack['status']
  members: NativeStack['pullRequests']
}

/** The pull request identity a sync plan re-reads before it touches a descendant. */
interface CapturedPullRequest {
  number: number
  state: PullRequest['state']
  base: string
  headOid: string | null
}

/** The captured local tip and remote tip a push step may still act on. */
interface PublishBranchFacts {
  branch: string
  oid: string
  remoteOid: string | null
  /** The existing PR base reviewed before approving a retarget, never refreshed on retry. */
  pullRequestBase?: string | null
}

/**
 * A Submit Stack run, persisted after every step so an interrupted publication
 * resumes at the first unfinished step instead of duplicating pushed branches
 * and pull requests.
 */
interface PublishOperation {
  version: 1
  id: string
  repoPath: string
  originUrl: string
  fullName: string
  pushUrl: string
  defaultBranch: string
  createdAt: string
  allowForce: boolean
  layers: PublishLayer[]
  branches: PublishBranchFacts[]
  steps: PublishStep[]
  stackNumber: number | null
  /**
   * The stack creation this operation issued. Persisted before the API call so a retry can
   * tell its own half-finished creation apart from a stack somebody else created.
   */
  stackCreateRequested?: boolean
  /**
   * The exact members native stack `stackNumber` held when the preview was taken, with the
   * head they carried then. These are the immutable baseline every later re-read is proved
   * against, so a push this submission made on purpose is the only thing that may differ.
   */
  capturedMembers: CapturedStackMember[]
  stackAction: PublishStackAction
  /**
   * Whether the host was observed to serve the native stacks resource when this
   * operation was created, and what the probe established when it was not. A
   * resume reads it to tell an ordinary chain from a native one, which the
   * journal could not otherwise know: an ordinary chain and a submission that
   * creates its first stack look the same in the steps they leave behind.
   *
   * Optional, because a journal written before this field existed has no
   * answer to give; its shape still says which of the two it is.
   */
  nativeStacksAvailable?: boolean
  nativeStacksReason?: NativeStackCapabilityReason | 'not-applicable'
  status: 'running' | 'failed' | 'completed'
  message: string
}

interface CapturedStackMember {
  number: number
  headSha: string | undefined
  head: string
  base: string
  state: string
}

const PUBLISH_VERSION = 1

const plans = new Map<string, StackPlan>()

function stackActionError(message: string): never {
  throw new Error(message)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function validateTitleMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) stackActionError('titles must be an object')
  const result: Record<string, string> = {}
  for (const [key, title] of Object.entries(value)) {
    requireRefInput(key, 'title branch')
    result[key] = requireString(title, `title for ${key}`)
  }
  return result
}

export function validateStackAction(value: unknown): StackAction {
  if (!isRecord(value) || typeof value.type !== 'string') {
    stackActionError('Invalid stack action')
  }
  switch (value.type) {
    case 'setParent':
      if (!hasOnlyKeys(value, ['type', 'branch', 'parent']))
        stackActionError('Invalid setParent action')
      return {
        type: 'setParent',
        branch: requireRefInput(value.branch, 'branch'),
        parent: requireRefInput(value.parent, 'parent'),
      }
    case 'executeStack':
      if (
        !hasOnlyKeys(value, ['type', 'token', 'allowForce', 'mergeMethod', 'mergeAction']) ||
        typeof value.allowForce !== 'boolean'
      ) {
        stackActionError('Invalid executeStack action')
      }
      if (
        value.mergeMethod !== 'merge' &&
        value.mergeMethod !== 'squash' &&
        value.mergeMethod !== 'rebase'
      ) {
        stackActionError('Invalid merge method')
      }
      // Only a merge reads this, so an absent action is valid here: restack and publish carry
      // no merge intent. `mergeStack` refuses a merge that arrives without one.
      if (
        value.mergeAction !== undefined &&
        value.mergeAction !== 'default' &&
        value.mergeAction !== 'direct_merge' &&
        value.mergeAction !== 'merge_queue'
      ) {
        stackActionError('Invalid merge action')
      }
      return {
        type: 'executeStack',
        token: requireString(value.token, 'stack preview token', 512),
        allowForce: value.allowForce,
        mergeMethod: value.mergeMethod,
        mergeAction: value.mergeAction,
      }
    case 'stackContinue':
    case 'stackAbort':
      if (!hasOnlyKeys(value, ['type'])) stackActionError(`Invalid ${value.type} action`)
      return { type: value.type }
    case 'updatePr':
      if (!hasOnlyKeys(value, ['type', 'number', 'title', 'body', 'draft'])) {
        stackActionError('Invalid updatePr action')
      }
      if (
        typeof value.number !== 'number' ||
        !Number.isInteger(value.number) ||
        value.number <= 0
      ) {
        stackActionError('Pull request number must be a positive integer')
      }
      if (typeof value.draft !== 'boolean') stackActionError('draft must be a boolean')
      if (
        typeof value.body !== 'string' ||
        value.body.length > MAX_MESSAGE_LENGTH ||
        value.body.includes('\0')
      ) {
        stackActionError('pull request body must be a string without NUL bytes')
      }
      return {
        type: 'updatePr',
        number: value.number,
        title: requireString(value.title, 'pull request title'),
        body: value.body,
        draft: value.draft,
      }
    case 'closePr':
    case 'reopenPr':
      if (!hasOnlyKeys(value, ['type', 'number'])) stackActionError(`Invalid ${value.type} action`)
      if (
        typeof value.number !== 'number' ||
        !Number.isInteger(value.number) ||
        value.number <= 0
      ) {
        stackActionError('Pull request number must be a positive integer')
      }
      return { type: value.type, number: value.number }
    case 'linkIssue':
    case 'unlinkIssue':
      if (!hasOnlyKeys(value, ['type', 'prNumber', 'issueNumber', 'relation', 'expectedBody'])) {
        stackActionError(`Invalid ${value.type} action`)
      }
      if (
        typeof value.prNumber !== 'number' ||
        !Number.isInteger(value.prNumber) ||
        value.prNumber <= 0
      ) {
        stackActionError('Pull request number must be a positive integer')
      }
      if (
        typeof value.issueNumber !== 'number' ||
        !Number.isInteger(value.issueNumber) ||
        value.issueNumber <= 0
      ) {
        stackActionError('Issue number must be a positive integer')
      }
      if (value.relation !== 'contextual' && value.relation !== 'closing') {
        stackActionError('relation must be contextual or closing')
      }
      if (
        value.expectedBody !== undefined &&
        (typeof value.expectedBody !== 'string' ||
          value.expectedBody.length > MAX_MESSAGE_LENGTH ||
          value.expectedBody.includes('\0'))
      ) {
        stackActionError('expectedBody must be a valid string without NUL bytes')
      }
      return {
        type: value.type,
        prNumber: value.prNumber,
        issueNumber: value.issueNumber,
        relation: value.relation,
        expectedBody: value.expectedBody,
      }
    case 'createNativeStack':
      if (!hasOnlyKeys(value, ['type', 'pullRequests']) || !Array.isArray(value.pullRequests)) {
        stackActionError('Invalid createNativeStack action')
      }
      for (const pr of value.pullRequests) {
        if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) {
          stackActionError('Pull request numbers must be positive integers')
        }
      }
      return { type: 'createNativeStack', pullRequests: value.pullRequests as number[] }
    case 'submitStack': {
      if (
        !hasOnlyKeys(value, ['type', 'token', 'allowForce', 'layers']) ||
        typeof value.allowForce !== 'boolean'
      ) {
        stackActionError('Invalid submitStack action')
      }
      if (!isRecord(value.layers)) stackActionError('layers must be an object')
      const layers: Record<string, PublishLayerChoice> = {}
      for (const [branch, choice] of Object.entries(value.layers)) {
        if (
          !isRecord(choice) ||
          !hasOnlyKeys(choice, ['title', 'body', 'draft', 'updateBase']) ||
          typeof choice.draft !== 'boolean' ||
          typeof choice.updateBase !== 'boolean' ||
          typeof choice.body !== 'string' ||
          choice.body.length > MAX_MESSAGE_LENGTH ||
          choice.body.includes('\0')
        ) {
          stackActionError(`Invalid layer choice for ${branch}`)
        }
        layers[requireRefInput(branch, 'layer branch')] = {
          title: requireString(choice.title, `title for ${branch}`),
          body: choice.body,
          draft: choice.draft,
          updateBase: choice.updateBase,
        }
      }
      return {
        type: 'submitStack',
        token: requireString(value.token, 'stack preview token', 512),
        allowForce: value.allowForce,
        layers,
      }
    }
    case 'submitStackRetry':
    case 'submitStackDismiss':
      if (!hasOnlyKeys(value, ['type'])) stackActionError(`Invalid ${value.type} action`)
      return { type: value.type }
    case 'addPullRequestsToNativeStack':
      if (
        !hasOnlyKeys(value, ['type', 'stackNumber', 'pullRequests']) ||
        typeof value.stackNumber !== 'number' ||
        !Number.isInteger(value.stackNumber) ||
        value.stackNumber <= 0 ||
        !Array.isArray(value.pullRequests)
      ) {
        stackActionError('Invalid addPullRequestsToNativeStack action')
      }
      for (const pr of value.pullRequests) {
        if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) {
          stackActionError('Pull request numbers must be positive integers')
        }
      }
      return {
        type: 'addPullRequestsToNativeStack',
        stackNumber: value.stackNumber,
        pullRequests: value.pullRequests as number[],
      }
    case 'unstackNativeStack':
      if (
        !hasOnlyKeys(value, ['type', 'stackNumber']) ||
        typeof value.stackNumber !== 'number' ||
        !Number.isInteger(value.stackNumber) ||
        value.stackNumber <= 0
      ) {
        stackActionError('Invalid unstackNativeStack action')
      }
      return { type: 'unstackNativeStack', stackNumber: value.stackNumber }
    case 'reconcileRepair': {
      if (
        !hasOnlyKeys(value, ['type', 'token', 'ids', 'confirmRewrites']) ||
        typeof value.confirmRewrites !== 'boolean' ||
        !Array.isArray(value.ids)
      ) {
        stackActionError('Invalid reconcileRepair action')
      }
      const ids = value.ids.map((id) => requireString(id, 'reconciliation repair ID', 2048))
      return {
        type: 'reconcileRepair',
        token: requireString(value.token, 'reconciliation preview token', 512),
        ids,
        confirmRewrites: value.confirmRewrites,
      }
    }
    default:
      stackActionError(`Unsupported stack action: ${String(value.type)}`)
  }
}

export function isStackAction(value: unknown): value is StackAction {
  try {
    validateStackAction(value)
    return true
  } catch {
    return false
  }
}

async function repositoryPath(repoPath: string, signal?: AbortSignal): Promise<string> {
  const workTree = await tryGit(repoPath, ['rev-parse', '--show-toplevel'], signal)
  if (workTree) return path.resolve(stripTrailingNewline(workTree))
  // A bare repository has no worktree, so the journal lives in the Git directory.
  return path.resolve(
    stripTrailingNewline(
      await runGit(repoPath, ['rev-parse', '--absolute-git-dir'], undefined, signal),
    ),
  )
}

async function gitDirectory(repoPath: string, signal?: AbortSignal): Promise<string> {
  const output = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-dir'], undefined, signal),
  )
  return path.resolve(repoPath, output)
}

async function journalPath(repoPath: string, signal?: AbortSignal): Promise<string> {
  return path.join(await gitDirectory(repoPath, signal), 'git-stacks-stack.json')
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
}

async function readJournal(repoPath: string, signal?: AbortSignal): Promise<StackJournal | null> {
  let value: string
  try {
    const target = await journalPath(repoPath, signal)
    if ((await fs.stat(target)).size > 8 * 1024 * 1024)
      throw new Error('Stack journal is too large')
    value = await fs.readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('The Git Stacks operation journal is corrupt; refusing to rewrite branches')
  }
  const invalid = () =>
    new Error('The Git Stacks operation journal is invalid; refusing to rewrite branches')
  if (
    !isRecord(parsed) ||
    parsed.version !== JOURNAL_VERSION ||
    typeof parsed.id !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(parsed.id) ||
    parsed.repoPath !== repoPath ||
    !isOid(parsed.originalHead) ||
    (parsed.originalBranch !== null && typeof parsed.originalBranch !== 'string') ||
    (parsed.currentBranch !== null && typeof parsed.currentBranch !== 'string') ||
    typeof parsed.message !== 'string' ||
    !['running', 'conflict', 'uncertain', 'aborting'].includes(String(parsed.status)) ||
    !Array.isArray(parsed.entries) ||
    // A surgery that only takes a layer out has nothing to replay, and the
    // branch to restore is exactly the work its journal records.
    (parsed.entries.length === 0 &&
      !(Array.isArray(parsed.created) && parsed.created.length > 0) &&
      !(Array.isArray(parsed.removed) && parsed.removed.length > 0)) ||
    parsed.entries.length > 2048
  )
    throw invalid()
  const names = new Set<string>()
  const branches = new Set<string>()
  for (const entry of parsed.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.branch !== 'string' ||
      branches.has(entry.branch) ||
      typeof entry.newParent !== 'string' ||
      !isOid(entry.oldTip) ||
      !isOid(entry.boundary) ||
      !isOid(entry.newParentOid) ||
      (entry.newTip !== null && !isOid(entry.newTip)) ||
      (entry.newParentTip !== null && !isOid(entry.newParentTip)) ||
      (entry.oldParentTip !== null && !isOid(entry.oldParentTip)) ||
      (entry.oldParent !== null && typeof entry.oldParent !== 'string') ||
      !['pending', 'rebasing', 'metadata', 'completed', 'restored'].includes(
        String(entry.status),
      ) ||
      ![`refs/heads/${entry.newParent}`, `refs/remotes/origin/${entry.newParent}`].includes(
        String(entry.newParentRef),
      ) ||
      entry.backupRef !== backupRefFor(parsed.id, entry.branch) ||
      (entry.headReflogCount !== null &&
        entry.headReflogCount !== undefined &&
        (typeof entry.headReflogCount !== 'number' ||
          !Number.isSafeInteger(entry.headReflogCount) ||
          entry.headReflogCount < 0)) ||
      (['metadata', 'completed'].includes(String(entry.status)) &&
        (!isOid(entry.newTip) || !isOid(entry.newParentTip)))
    )
      throw invalid()
    entry.headReflogCount = typeof entry.headReflogCount === 'number' ? entry.headReflogCount : null
    branches.add(entry.branch)
    names.add(entry.branch)
    names.add(entry.newParent)
    if (entry.oldParent !== null) names.add(entry.oldParent)
  }
  // A surgery records the branch it creates and the branch it deletes, so an
  // abort can undo both. These refs are written from the journal, so a corrupt
  // record is refused rather than trusted.
  if (parsed.created !== undefined) {
    if (!Array.isArray(parsed.created)) throw invalid()
    for (const created of parsed.created) {
      if (
        !isRecord(created) ||
        typeof created.branch !== 'string' ||
        !isOid(created.oid) ||
        typeof created.parent !== 'string' ||
        !isOid(created.parentTip)
      )
        throw invalid()
      names.add(created.branch)
      names.add(created.parent)
    }
  }
  if (parsed.removed !== undefined) {
    if (!Array.isArray(parsed.removed)) throw invalid()
    for (const removed of parsed.removed) {
      if (
        !isRecord(removed) ||
        typeof removed.branch !== 'string' ||
        branches.has(removed.branch) ||
        !isOid(removed.oldTip) ||
        (removed.oldParent !== null && typeof removed.oldParent !== 'string') ||
        (removed.oldParentTip !== null && !isOid(removed.oldParentTip)) ||
        !['pending', 'completed', 'restored'].includes(String(removed.status)) ||
        removed.backupRef !== backupRefFor(parsed.id, removed.branch)
      )
        throw invalid()
      branches.add(removed.branch)
      names.add(removed.branch)
      if (removed.oldParent !== null) names.add(removed.oldParent)
    }
  }
  if (parsed.surgery !== undefined) {
    const surgery = parsed.surgery
    if (
      !isRecord(surgery) ||
      // A local-only surgery records no repository: its published half is empty,
      // which is what keeps it out of the GitHub mutation path entirely.
      (surgery.fullName !== null && typeof surgery.fullName !== 'string') ||
      (surgery.pushUrl !== null && typeof surgery.pushUrl !== 'string') ||
      typeof surgery.trunk !== 'string' ||
      !Array.isArray(surgery.pullRequests)
    )
      throw invalid()
    for (const step of surgery.pullRequests) {
      if (
        !isRecord(step) ||
        typeof step.branch !== 'string' ||
        typeof step.headRef !== 'string' ||
        (step.capturedHeadOid !== null && !isOid(step.capturedHeadOid)) ||
        typeof step.number !== 'number' ||
        !Number.isInteger(step.number) ||
        step.number <= 0 ||
        !['retarget', 'close'].includes(String(step.action)) ||
        typeof step.fromBase !== 'string' ||
        typeof step.toBase !== 'string' ||
        !['pending', 'completed'].includes(String(step.status))
      )
        throw invalid()
      names.add(step.branch)
    }
    const stack = surgery.stack
    if (stack !== null) {
      if (
        !isRecord(stack) ||
        typeof stack.stackNumber !== 'number' ||
        !Number.isInteger(stack.stackNumber) ||
        stack.stackNumber <= 0 ||
        !['unstack', 'unstack-and-create'].includes(String(stack.action)) ||
        !Array.isArray(stack.membersBefore) ||
        stack.membersBefore.some((member: unknown) => typeof member !== 'number') ||
        !Array.isArray(stack.members) ||
        stack.members.some((member: unknown) => typeof member !== 'number') ||
        typeof stack.trunk !== 'string' ||
        !['pending', 'completed'].includes(String(stack.unstackStatus)) ||
        !['pending', 'completed', 'skipped'].includes(String(stack.createStatus)) ||
        typeof stack.createRequested !== 'boolean' ||
        (stack.stackNumberAfter !== null && typeof stack.stackNumberAfter !== 'number')
      )
        throw invalid()
    }
  }
  if (parsed.originalBranch !== null) names.add(parsed.originalBranch)
  // A journal written before sync existed restacks; the label is display-only.
  parsed.kind = parsed.kind === 'sync' ? 'sync' : 'restack'
  if (parsed.currentBranch !== null) names.add(parsed.currentBranch)
  for (const name of names) await validateBranchName(repoPath, name)
  return parsed as unknown as StackJournal
}

async function writeJournal(repoPath: string, journal: StackJournal): Promise<void> {
  const target = await journalPath(repoPath)
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temporary, JSON.stringify(journal), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, target)
}

async function removeJournal(repoPath: string): Promise<void> {
  try {
    await fs.unlink(await journalPath(repoPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function resolveCommit(
  repoPath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const output = await tryGit(
    repoPath,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    signal,
  )
  return output ? stripTrailingNewline(output) : null
}

async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runGit(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant], undefined, signal)
    return true
  } catch (error) {
    if (commandCode(error) === 1) return false
    throw error
  }
}

async function commitCount(repoPath: string, boundary: string, tip: string): Promise<number> {
  const output = await runGit(repoPath, ['rev-list', '--count', `${boundary}..${tip}`, '--'])
  const count = Number(stripTrailingNewline(output))
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Git returned an invalid commit count')
  return count
}
async function mergeCommitCount(repoPath: string, boundary: string, tip: string): Promise<number> {
  const output = await runGit(repoPath, [
    'rev-list',
    '--merges',
    '--count',
    `${boundary}..${tip}`,
    '--',
  ])
  const count = Number(stripTrailingNewline(output))
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Git returned an invalid merge commit count')
  return count
}
async function commitParents(repoPath: string, oid: string): Promise<string[]> {
  const output = await runGit(repoPath, [
    'rev-list',
    '--parents',
    '-n',
    '1',
    '--end-of-options',
    oid,
  ])
  const tokens = stripTrailingNewline(output).trim().split(/\s+/u)
  return tokens.slice(1).filter(Boolean)
}

interface MergedPrRecord {
  branch: string
  pr: number
  headOid: string
  mergeOid: string | null
  mergedAt: number
}

async function mergedPrJournalPath(repoPath: string): Promise<string> {
  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  return path.resolve(repoPath, commonDir, 'git-stacks-merged-heads.json')
}

async function readMergedPrJournal(repoPath: string): Promise<Map<string, MergedPrRecord>> {
  const journalPath = await mergedPrJournalPath(repoPath)
  const map = new Map<string, MergedPrRecord>()
  try {
    const raw = await fs.readFile(journalPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (isRecord(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (
          isRecord(value) &&
          typeof value.branch === 'string' &&
          typeof value.pr === 'number' &&
          typeof value.headOid === 'string'
        ) {
          map.set(key, {
            branch: value.branch,
            pr: value.pr,
            headOid: value.headOid,
            mergeOid: typeof value.mergeOid === 'string' ? value.mergeOid : null,
            mergedAt: typeof value.mergedAt === 'number' ? value.mergedAt : Date.now(),
          })
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Ignore unreadable or missing journal
    }
  }
  return map
}

async function writeMergedPrRecord(repoPath: string, record: MergedPrRecord): Promise<void> {
  const journalPath = await mergedPrJournalPath(repoPath)
  await fs.mkdir(path.dirname(journalPath), { recursive: true })
  const map = await readMergedPrJournal(repoPath)
  map.set(String(record.pr), record)
  map.set(record.branch, record)
  const obj: Record<string, MergedPrRecord> = {}
  for (const [k, v] of map.entries()) {
    obj[k] = v
  }
  const temporaryPath = `${journalPath}.${randomUUID()}.tmp`
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(obj, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporaryPath, journalPath)
}

async function isProvenMergeHead(
  repoPath: string,
  prNumber: number,
  candidateHeadOid: string,
  mergeOid: string,
  journal: Map<string, MergedPrRecord>,
): Promise<boolean> {
  const journalRecord = journal.get(String(prNumber))
  if (journalRecord && journalRecord.pr === prNumber) {
    if (journalRecord.headOid !== candidateHeadOid) {
      return false
    }
    return !journalRecord.mergeOid || !mergeOid || journalRecord.mergeOid === mergeOid
  }
  if (mergeOid) {
    try {
      const parents = await commitParents(repoPath, mergeOid)
      if (parents.length >= 2) {
        const prParent = parents[1]
        if (candidateHeadOid === prParent) {
          return true
        }
      }
    } catch {
      // Ignore
    }
  }
  return false
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

function isPidRunning(pid: number): boolean {
  if (!isValidPid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function localFilesRefStoragePath(value: string): string {
  const uri = new URL(value)
  if (
    uri.protocol !== 'files:' ||
    uri.host ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash ||
    !uri.pathname.startsWith('/')
  ) {
    throw new Error('The configured files ref-storage URI cannot be locked safely')
  }
  let decodedPath: string
  try {
    decodedPath = fileURLToPath(uri.href.replace(/^files:/u, 'file:'))
  } catch {
    throw new Error('The configured files ref-storage URI cannot be locked safely')
  }
  if (decodedPath.includes('\0')) {
    throw new Error('The configured files ref-storage URI cannot be locked safely')
  }
  return decodedPath
}

function gitPathOnDisk(repoPath: string, value: string, refRoot: string | null): string {
  if (value.startsWith('files:')) return localFilesRefStoragePath(value)
  if (value.startsWith('file:')) return fileURLToPath(new URL(value))
  return path.resolve(refRoot ?? repoPath, value)
}

function isValidTransactionId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    /^[0-9a-fA-F-]{8,64}$/.test(id) &&
    !id.includes('.') &&
    !id.includes('/') &&
    !id.includes('\\')
  )
}

function safeJournalPath(locksDir: string, transactionId: unknown): string | null {
  if (!isValidTransactionId(transactionId)) return null
  const normalizedLocksDir = path.resolve(locksDir)
  const resolved = path.resolve(normalizedLocksDir, `${transactionId}.json`)
  if (path.dirname(resolved) !== normalizedLocksDir) return null
  return resolved
}

async function sameExistingPath(left: string, right: string): Promise<boolean> {
  try {
    const [leftRealPath, rightRealPath] = await Promise.all([fs.realpath(left), fs.realpath(right)])
    return leftRealPath === rightRealPath
  } catch {
    return false
  }
}

async function isSafeBranchLockPath(
  repoPath: string,
  candidatePath: unknown,
  branch: unknown,
): Promise<boolean> {
  if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) return false
  if (!candidatePath.endsWith('.lock')) return false
  if (typeof branch !== 'string' || !branch.trim()) return false

  try {
    await runGit(repoPath, ['check-ref-format', '--branch', branch])
    const refPathValue = stripTrailingNewline(
      await runGit(repoPath, ['rev-parse', '--git-path', `refs/heads/${branch}`]),
    )
    if (!refPathValue) return false

    let refRoot: string | null = null
    const refStorage = await getConfigValue(repoPath, 'extensions.refstorage')
    if (refStorage && refStorage.toLowerCase() !== 'files') {
      try {
        refRoot = localFilesRefStoragePath(refStorage)
      } catch {
        return false
      }
    }
    const expectedLockPath = `${gitPathOnDisk(repoPath, refPathValue, refRoot)}.lock`
    return path.resolve(candidatePath) === path.resolve(expectedLockPath)
  } catch {
    return false
  }
}

type UnlinkIdentityResult = 'unlinked' | 'replaced' | 'failed'

async function unlinkIfSameIdentity(
  lockPath: string,
  expectedStat: { dev: number; ino: number },
): Promise<UnlinkIdentityResult> {
  let currentHandle: FileHandle | null = null
  try {
    try {
      currentHandle = await fs.open(lockPath, 'r')
      const [pathStat, openedStat] = await Promise.all([fs.lstat(lockPath), currentHandle.stat()])
      if (
        pathStat.dev !== expectedStat.dev ||
        pathStat.ino !== expectedStat.ino ||
        openedStat.dev !== expectedStat.dev ||
        openedStat.ino !== expectedStat.ino
      ) {
        return 'replaced'
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'unlinked'
      }
      return 'failed'
    }

    const claimPath = `${lockPath}.${randomUUID()}.stale-claim`
    try {
      await fs.rename(lockPath, claimPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'unlinked'
      }
      return 'failed'
    }

    try {
      const [claimStat, heldStat] = await Promise.all([fs.lstat(claimPath), currentHandle.stat()])
      if (
        claimStat.dev !== heldStat.dev ||
        claimStat.ino !== heldStat.ino ||
        heldStat.dev !== expectedStat.dev ||
        heldStat.ino !== expectedStat.ino
      ) {
        try {
          await fs.rename(claimPath, lockPath)
        } catch {
          // Preserve the claimed file if another process recreated the canonical path.
        }
        return 'replaced'
      }

      await fs.unlink(claimPath)
      return 'unlinked'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'unlinked'
      }
      try {
        await fs.rename(claimPath, lockPath)
      } catch {
        // Preserve the claimed file if it cannot be restored.
      }
      return 'failed'
    }
  } finally {
    await currentHandle?.close().catch(() => {})
  }
}

interface BranchLockInfo {
  pid: number
  branch: string
  lockPath: string
  createdAt: number
  transactionId: string
}

async function tryRecoverStaleBranchLock(
  repoPath: string,
  lockPath: string,
  branch: string,
): Promise<boolean> {
  let commonDir = ''
  try {
    commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  } catch {
    return false
  }
  const resolvedCommonDir = path.resolve(repoPath, commonDir)
  if (!(await isSafeBranchLockPath(repoPath, lockPath, branch))) {
    return false
  }

  const locksDir = path.resolve(resolvedCommonDir, 'git-stacks-branch-locks')
  let lockHandle: FileHandle | null = null
  let lockStat: { dev: number; ino: number } | null = null
  let content = ''
  try {
    lockHandle = await fs.open(lockPath, 'r')
    const stat = await lockHandle.stat()
    lockStat = { dev: stat.dev, ino: stat.ino }
    content = await lockHandle.readFile({ encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  } finally {
    await lockHandle?.close().catch(() => {})
  }

  let parsed: Record<string, unknown> | null = null
  try {
    const rawParsed = JSON.parse(content)
    if (isRecord(rawParsed)) {
      parsed = rawParsed
    }
  } catch {
    parsed = null
  }
  if (
    parsed &&
    isValidPid(parsed.pid) &&
    isValidTransactionId(parsed.transactionId) &&
    parsed.branch === branch &&
    typeof parsed.lockPath === 'string' &&
    !isPidRunning(parsed.pid)
  ) {
    if (!(await sameExistingPath(parsed.lockPath, lockPath))) return false

    const journalPath = safeJournalPath(locksDir, parsed.transactionId)
    if (!journalPath) return false

    let journal: Record<string, unknown>
    try {
      const rawJournal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
      if (!isRecord(rawJournal)) return false
      journal = rawJournal
    } catch {
      return false
    }
    if (
      journal.transactionId !== parsed.transactionId ||
      typeof journal.lockPath !== 'string' ||
      !(await sameExistingPath(journal.lockPath, lockPath)) ||
      journal.branch !== branch ||
      journal.pid !== parsed.pid ||
      !isValidPid(journal.pid) ||
      isPidRunning(journal.pid)
    ) {
      return false
    }

    const unlinkResult = await unlinkIfSameIdentity(lockPath, lockStat!)
    if (unlinkResult !== 'unlinked') {
      return false
    }
    await fs.unlink(journalPath).catch(() => {})
    return true
  }
  // A partial or malformed lock has no reliable transaction ownership. Keep it
  // for manual recovery instead of deleting a lock that may belong to a new
  // publisher which is still writing its metadata.
  return false
}

export async function recoverStaleBranchLocks(repoPath: string): Promise<void> {
  let commonDirRaw: string
  try {
    commonDirRaw = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  } catch {
    return
  }
  const commonDir = path.resolve(repoPath, commonDirRaw)
  const locksDir = path.resolve(commonDir, 'git-stacks-branch-locks')

  let entries: string[]
  try {
    entries = await fs.readdir(locksDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Ignore
    }
    return
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const journalPath = path.join(locksDir, entry)
    try {
      const raw = await fs.readFile(journalPath, 'utf8')
      const journalJson = JSON.parse(raw)
      if (!isRecord(journalJson)) continue
      const pid = journalJson.pid
      if (!isValidPid(pid) || isPidRunning(pid)) {
        continue
      }

      if (!isValidTransactionId(journalJson.transactionId)) continue

      const safe = await isSafeBranchLockPath(repoPath, journalJson.lockPath, journalJson.branch)
      if (!safe) {
        // Keep rejected journals as evidence; their lock paths are not proven safe to touch.
        continue
      }

      const lockPath = journalJson.lockPath as string
      let lockHandle: FileHandle | null = null
      let lockStat: { dev: number; ino: number } | null = null
      let lockRaw: string | null = null
      try {
        lockHandle = await fs.open(lockPath, 'r')
        const stat = await lockHandle.stat()
        lockStat = { dev: stat.dev, ino: stat.ino }
        lockRaw = await lockHandle.readFile({ encoding: 'utf8' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Lock file does not exist, journal is stale
          await fs.unlink(journalPath).catch(() => {})
          continue
        }
        // Unreadable or permission error: keep journal evidence
        continue
      } finally {
        await lockHandle?.close().catch(() => {})
      }

      let lockParsed: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(lockRaw)
        if (isRecord(parsed)) {
          lockParsed = parsed
        }
      } catch {
        lockParsed = null
      }

      if (lockParsed) {
        const isSameDeadLock =
          isValidTransactionId(journalJson.transactionId) &&
          lockParsed.transactionId === journalJson.transactionId &&
          lockParsed.pid === journalJson.pid &&
          lockParsed.branch === journalJson.branch &&
          typeof lockParsed.lockPath === 'string' &&
          (await sameExistingPath(lockParsed.lockPath, lockPath))

        if (isSameDeadLock) {
          const result = await unlinkIfSameIdentity(lockPath, lockStat!)
          if (result === 'unlinked') {
            await fs.unlink(journalPath).catch(() => {})
          }
          // If 'failed', keep journal evidence
        } else if (
          isValidPid(lockParsed.pid) &&
          isPidRunning(lockParsed.pid) &&
          lockParsed.transactionId === journalJson.transactionId &&
          lockParsed.branch === journalJson.branch &&
          typeof lockParsed.lockPath === 'string' &&
          (await sameExistingPath(lockParsed.lockPath, lockPath))
        ) {
          // A live publisher owns the same transaction; remove only its stale journal.
          await fs.unlink(journalPath).catch(() => {})
        }
      }
    } catch {
      // Ignore unreadable entry
    }
  }
}

interface ParentTarget {
  ref: string
  oid: string
}

export async function parentTarget(
  repoPath: string,
  parent: string,
  defaultBranch: string,
  preferRemoteDefault: boolean,
  signal?: AbortSignal,
): Promise<ParentTarget | null> {
  if (parent === defaultBranch) {
    const localRef = `refs/heads/${defaultBranch}`
    const remoteRef = `refs/remotes/origin/${defaultBranch}`
    const localOid = await resolveCommit(repoPath, localRef, signal)
    const remoteOidValue = await resolveCommit(repoPath, remoteRef, signal)
    if (
      remoteOidValue &&
      (preferRemoteDefault ||
        !localOid ||
        (await isAncestor(repoPath, localOid, remoteOidValue, signal)))
    ) {
      return { ref: remoteRef, oid: remoteOidValue }
    }
    if (localOid) return { ref: localRef, oid: localOid }
    return null
  }
  const localRef = `refs/heads/${parent}`
  const localOid = await resolveCommit(repoPath, localRef, signal)
  if (localOid) return { ref: localRef, oid: localOid }
  const resolved = await resolveParentRef(repoPath, parent)
  const oid = await resolveCommit(repoPath, resolved, signal)
  return oid ? { ref: resolved, oid } : null
}

async function actualMergeBase(
  repoPath: string,
  left: string,
  right: string,
): Promise<string | null> {
  const output = await tryGit(repoPath, ['merge-base', left, right])
  return output ? stripTrailingNewline(output) : null
}

async function setConfig(repoPath: string, key: string, value: string): Promise<void> {
  await runGit(repoPath, ['config', '--local', key, value])
}

async function unsetConfig(repoPath: string, key: string): Promise<void> {
  try {
    await runGit(repoPath, ['config', '--local', '--unset', key])
  } catch (error) {
    if (commandCode(error) !== 5 && commandCode(error) !== 1) throw error
  }
}

async function localBranchNames(repoPath: string): Promise<string[]> {
  const refs = await getRefs(repoPath)
  return refs
    .filter((ref) => ref.refname.startsWith('refs/heads/') && !ref.symref)
    .map((ref) => ref.refname.slice('refs/heads/'.length))
}

async function remoteOid(repoPath: string, remote: string, branch: string): Promise<string | null> {
  const output = await runGit(repoPath, ['ls-remote', '--heads', remote, `refs/heads/${branch}`])
  const first = output.trim().split(/\s+/u)[0]
  return /^[0-9a-f]{40,64}$/iu.test(first) ? first : null
}

function branchSnapshot(snapshot: RepositorySnapshot, name: string): Branch | null {
  return snapshot.branches.find((entry) => !entry.remote && entry.name === name) ?? null
}

function localPrForBranch(
  snapshot: RepositorySnapshot,
  name: string,
  originFullName: string | null,
): PullRequest | null {
  const candidate = branchSnapshot(snapshot, name)?.pr
  if (!candidate || candidate.head !== name) return null
  if (!originFullName || pullRequestRepository(candidate) !== originFullName) return null
  return candidate
}

async function branchRecords(
  repoPath: string,
  snapshot: RepositorySnapshot,
  defaultBranch: string,
  originFullName: string | null,
  canonicalPrs: Map<string, PullRequest>,
): Promise<Map<string, BranchRecord>> {
  const refs = await getRefs(repoPath)
  const local = refs.filter((ref) => ref.refname.startsWith('refs/heads/') && !ref.symref)
  const records = new Map<string, BranchRecord>()
  const mergedJournal = await readMergedPrJournal(repoPath)
  for (const ref of local) {
    const name = ref.refname.slice('refs/heads/'.length)
    const oid = ref.objectName
    const configuredParent = await getBranchParent(repoPath, name)
    const snapshotBranch = branchSnapshot(snapshot, name)
    const inferredParent = snapshotBranch?.parent ?? null
    const parent =
      configuredParent ?? (inferredParent && inferredParent !== name ? inferredParent : null)
    const configuredTip = await getConfigValue(repoPath, `branch.${name}.parentTip`)
    const configuredTipOid = configuredTip ? await resolveCommit(repoPath, configuredTip) : null
    const invalidParentTip = Boolean(
      configuredTip &&
      (!isOid(configuredTip) ||
        !configuredTipOid ||
        !(await isAncestor(repoPath, configuredTipOid, oid))),
    )
    const validTip = invalidParentTip ? null : configuredTip
    const source: BranchRecord['parentSource'] = configuredParent
      ? 'recorded'
      : snapshotBranch?.parentSource === 'recorded'
        ? 'inferred'
        : (snapshotBranch?.parentSource ?? null)
    const configuredMergedHeadPr = await getConfigValue(
      repoPath,
      `branch.${name}.gitStacksMergedHeadPr`,
    )
    const configuredMergedHeadOid = await getConfigValue(
      repoPath,
      `branch.${name}.gitStacksMergedHeadOid`,
    )
    const configuredMergedCommitOid = await getConfigValue(
      repoPath,
      `branch.${name}.gitStacksMergedCommitOid`,
    )
    const pr = canonicalPrs.get(name) ?? localPrForBranch(snapshot, name, originFullName)
    const journalEntry =
      mergedJournal.get(name) ?? (pr ? mergedJournal.get(String(pr.number)) : null)
    const mergedHeadPr = configuredMergedHeadPr ?? (journalEntry ? String(journalEntry.pr) : null)
    let mergedHeadOid = configuredMergedHeadOid ?? journalEntry?.headOid ?? null
    let mergedCommitOid =
      configuredMergedCommitOid ?? journalEntry?.mergeOid ?? pr?.mergeOid ?? null
    if (!mergedHeadOid && mergedCommitOid) {
      try {
        const parents = await commitParents(repoPath, mergedCommitOid)
        if (parents.length >= 2 && isOid(parents[1])) {
          mergedHeadOid = parents[1]
        }
      } catch {
        // Ignore
      }
    }
    records.set(name, {
      name,
      oid,
      parent: name === defaultBranch ? null : (parent ?? defaultBranch),
      parentTip: validTip,
      invalidParentTip,
      parentSource: source,
      pr,
      mergedHeadPr,
      mergedHeadOid,
      mergedCommitOid,
    })
  }
  return records
}

function mergedParent(
  records: Map<string, BranchRecord>,
  name: string,
  defaultBranch: string,
): boolean {
  const parent = records.get(name)
  return parent?.pr?.state === 'MERGED' && name !== defaultBranch
}

function effectiveParent(
  records: Map<string, BranchRecord>,
  name: string,
  defaultBranch: string,
  visiting = new Set<string>(),
): string | null {
  if (visiting.has(name)) return null
  visiting.add(name)
  const record = records.get(name)
  if (!record || !record.parent) return defaultBranch
  if (!mergedParent(records, record.parent, defaultBranch)) return record.parent
  return effectiveParent(records, record.parent, defaultBranch, visiting) ?? defaultBranch
}

/**
 * The layers that hang from the trunk. A surgery anchored on the trunk itself has
 * no upward walk to seed it, and the trunk can carry more than one stack, so every
 * branch whose recorded parent chain reaches the trunk is in scope.
 */
function trunkStackNames(records: Map<string, BranchRecord>, trunk: string): string[] {
  const names: string[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const record of records.values()) {
      if (record.name === trunk || names.includes(record.name)) continue
      if (record.parent && (record.parent === trunk || names.includes(record.parent))) {
        names.push(record.name)
        grew = true
      }
    }
  }
  return names
}

function connectedBranchNames(
  records: Map<string, BranchRecord>,
  selected: string,
  defaultBranch: string,
): { names: string[]; blockers: string[] } {
  const blockers: string[] = []
  const names = new Set<string>()
  let current: string | null = selected
  const seen = new Set<string>()
  while (current && current !== defaultBranch) {
    if (seen.has(current)) {
      blockers.push(`Stack parent cycle detected at ${current}`)
      break
    }
    seen.add(current)
    const record = records.get(current)
    if (!record) {
      blockers.push(`Branch ${current} is not a local branch`)
      break
    }
    names.add(current)
    const parent = record.parent
    if (!parent) {
      blockers.push(`Branch ${current} has no parent`)
      break
    }
    if (parent !== defaultBranch && !records.has(parent)) {
      blockers.push(`Branch ${current} declares missing parent ${parent}`)
      break
    }
    current = parent
  }
  if (!records.has(selected)) blockers.push(`Branch ${selected} is not a local branch`)
  let changed = true
  while (changed) {
    changed = false
    for (const record of records.values()) {
      if (record.name === defaultBranch || names.has(record.name)) continue
      if (record.parent && names.has(record.parent)) {
        names.add(record.name)
        changed = true
      }
    }
  }
  return { names: [...names], blockers }
}

/**
 * The base branch of the native stack this branch belongs to. GitHub owns stack
 * membership, so a submitted stack hangs from the base it was registered
 * against; a branch nobody submitted has no native stack and hangs from the
 * repository default branch.
 */
function nativeStackTrunk(
  data: GitHubResult | null,
  selectedBranch: string,
  snapshot: RepositorySnapshot,
  defaultBranch: string,
): string | null {
  if (!data?.available) return null
  const parents = new Map(
    snapshot.branches
      .filter((branch) => !branch.remote)
      .map((branch) => [branch.name, branch.parent]),
  )
  const chain = new Set<string>()
  let current: string | null | undefined = selectedBranch
  while (current && !chain.has(current)) {
    chain.add(current)
    current = parents.get(current)
  }
  const submitted = new Set(
    data.pullRequests.filter((pr) => chain.has(pr.head)).map((pr) => pr.number),
  )
  for (const stack of data.nativeStacks ?? []) {
    if (stack.open && stack.pullRequests.some((member) => submitted.has(member.number))) {
      return stack.base
    }
  }
  return null
}

/** How the fetched remote tip of a branch compares with the local tip it was previewed against. */
async function remoteRelation(
  repoPath: string,
  remote: string | null,
  local: string,
): Promise<SyncRemoteRelation> {
  if (!remote) return 'absent'
  if (remote === local) return 'equal'
  if (await isAncestor(repoPath, remote, local)) return 'behind'
  if (await isAncestor(repoPath, local, remote)) return 'ahead'
  return 'diverged'
}

/**
 * The trunk a sync hangs from and how far it has moved since the local copy. A
 * rewritten trunk is reported rather than repaired: the sync replays the layers
 * onto the fetched remote tip and never rewrites the trunk itself.
 */
async function captureSyncTrunk(
  repoPath: string,
  trunk: string,
  pushUrl: string | null,
  layers: SyncLayerFacts[],
  fetchFailure: string | null,
): Promise<SyncCapture> {
  const blockers: string[] = fetchFailure ? [fetchFailure] : []
  const localOid = await resolveCommit(repoPath, `refs/heads/${trunk}`)
  const remoteOidValue = await resolveCommit(repoPath, `refs/remotes/origin/${trunk}`)
  if (!localOid) blockers.push(`Local ${trunk} does not exist`)
  if (!remoteOidValue)
    blockers.push(
      `No fetched origin/${trunk} to sync against; the fetch did not produce a remote trunk tip`,
    )
  if (!pushUrl) blockers.push('Syncing compares remote branches through the origin push URL')
  const ahead =
    localOid && remoteOidValue ? await commitCount(repoPath, remoteOidValue, localOid) : 0
  const behind =
    localOid && remoteOidValue ? await commitCount(repoPath, localOid, remoteOidValue) : 0
  if (ahead > 0) {
    blockers.push(
      `Local ${trunk} has ${ahead} commit${ahead === 1 ? '' : 's'} not on origin/${trunk}; publish or reconcile the trunk before syncing so stack branches retain those commits`,
    )
  }
  const diverged = Boolean(
    localOid &&
    remoteOidValue &&
    localOid !== remoteOidValue &&
    !(await isAncestor(repoPath, localOid, remoteOidValue)) &&
    !(await isAncestor(repoPath, remoteOidValue, localOid)),
  )
  return {
    remote: 'origin',
    trunk: {
      branch: trunk,
      localOid,
      remoteOid: remoteOidValue,
      ahead,
      behind,
      diverged,
      blockers,
    },
    layers,
  }
}

async function capturePlan(
  repoPath: string,
  snapshot: RepositorySnapshot,
  kind: StackKind,
  selectedBranch: string,
): Promise<{ plan: StackPlan; preview: StackPreview }> {
  const root = await repositoryPath(repoPath)
  // A sync reads the remote first: the trunk it replays onto and every lease it
  // may later spend are the tips this fetch produced.
  let fetchFailure: string | null = null
  if (kind === 'sync') {
    try {
      await ensureNoBusyOperation(root, 'sync the stack')
      await runGit(root, ['fetch', '--all', '--prune'])
    } catch (error) {
      fetchFailure = `Could not fetch and prune the remotes: ${commandDetail(error)}`
    }
  }
  const refs = await getRefs(root)
  const currentBranch = await getCurrentBranch(root)
  const currentHead = await resolveCommit(root, 'HEAD')
  const defaultBranch =
    snapshot.defaultBranch || (await getDefaultBranch(root, refs, currentBranch))
  const originUrl = await getOriginUrl(root)
  const originFullName = canonicalRemoteName(originUrl)
  const githubData = kind === 'restack' ? null : await getGitHubData(root, originUrl)
  const canonicalPrs = new Map<string, PullRequest>()
  if (githubData?.available) {
    for (const pr of githubData.pullRequests) {
      if (!canonicalPrs.has(pr.head)) {
        const canonical = await exactPrForBranch(pr.head, githubData)
        if (canonical) canonicalPrs.set(pr.head, canonical)
      }
    }
  }
  // The stack hangs from the branch GitHub registered it against when it is a
  // native stack, and from the repository default branch otherwise.
  // A sync and a merge both walk down to the trunk, so both read the branch
  // GitHub registered the native stack against. A release-line trunk is not the
  // repository default branch, and treating it as a missing layer would block a
  // stack that is registered correctly.
  const registeredTrunk =
    kind === 'sync' || kind === 'merge'
      ? nativeStackTrunk(githubData, selectedBranch, snapshot, defaultBranch)
      : null
  const trunk = registeredTrunk ?? defaultBranch
  const records = await branchRecords(root, snapshot, trunk, originFullName, canonicalPrs)
  const mergedJournal = await readMergedPrJournal(root)
  const connected = connectedBranchNames(records, selectedBranch, trunk)
  const blockers = [...connected.blockers]
  if (fetchFailure) blockers.push(fetchFailure)
  let mergeMethods: ('merge' | 'squash' | 'rebase')[] = []
  let pushUrl: string | null = null
  if (kind === 'publish' || kind === 'sync') {
    try {
      pushUrl = await getRemotePushUrl(root, 'origin')
      const pushRemote = parseRemote(pushUrl)
      const pushHost = remoteHostContext(pushRemote)
      const fetchHost = remoteHostContext(parseRemote(originUrl))
      if (!pushHost || (fetchHost && pushHost.host !== fetchHost.host)) {
        blockers.push(
          `${kind === 'sync' ? 'Syncing' : 'Publishing'} requires an origin push URL on the same GitHub host as the fetch URL`,
        )
      } else if (
        originFullName &&
        pushRemote!.fullName.toLowerCase() !== originFullName.toLowerCase()
      ) {
        blockers.push('Origin fetch and push URLs target different GitHub repositories')
      }
    } catch (error) {
      blockers.push(`Could not read the origin push URL: ${commandDetail(error)}`)
    }
  }
  if (kind === 'merge' && originFullName) {
    const allowed = await repositoryMergeMethods(originFullName, await repositoryHost(root))
    if (!allowed) blockers.push('Repository merge-method policy is unavailable; merge is blocked')
    else mergeMethods = allowed
  }
  const warnings: string[] = []
  if (kind !== 'restack' && githubData && !githubData.nativeStackPreviewAvailable) {
    // Only a resource the host refused is evidence that it has none. Every other
    // reason is a question this build could not answer, and it holds the publish
    // rather than planning an ordinary chain on the assumption of an answer.
    if (githubData.nativeStackPreviewReason === 'endpoint-missing') {
      warnings.push(
        githubData.nativeStackMessage ??
          'This host does not serve native stacks; pull requests publish as an ordinary chain',
      )
    } else {
      blockers.push(
        `Native stacked pull requests could not be established for this repository: ${githubData.nativeStackMessage ?? 'this host was not established either way'}. Nothing is published on an assumption; establish the capability and review this preview again.`,
      )
    }
  }
  if (kind !== 'restack') {
    if (!githubData || !githubData.available)
      blockers.push(githubData?.message ?? 'GitHub metadata is unavailable')
    if (!originFullName)
      blockers.push(
        kind === 'sync'
          ? 'Syncing requires a GitHub origin remote'
          : 'Publishing requires a GitHub origin remote',
      )
  }
  const operation = await getOperationState(root)
  if (operation.busy) blockers.push('A Git operation is already in progress')
  const files = await getStatus(root)
  if (files.length > 0) blockers.push('Commit or stash uncommitted changes before restacking')
  const selectedRecord = records.get(selectedBranch)
  if (!selectedRecord) blockers.push(`Branch ${selectedBranch} is not a local branch`)
  if (selectedBranch === trunk)
    blockers.push(`The stack trunk ${trunk} cannot itself be restacked, synced, or merged`)

  const names = connected.names
  const parentMap: Record<string, string | null> = {}
  const parentTipMap: Record<string, string | null> = {}
  const parentOidMap: Record<string, string | null> = {}
  const tips: Record<string, string> = {}
  const remoteOids: Record<string, string | null> = {}
  const prs: Record<string, CapturedPullRequest | null> = {}
  const capturedMergedHeads: Record<
    string,
    { pr: string | null; oid: string | null; commit: string | null }
  > = {}
  for (const [name, record] of records) {
    capturedMergedHeads[name] = {
      pr: record.mergedHeadPr,
      oid: record.mergedHeadOid,
      commit: record.mergedCommitOid,
    }
  }
  const entries: PlanEntry[] = []
  const skippedMerged = new Set<string>()
  const syncLayers: SyncLayerFacts[] = []
  const layerBlockers = new Map<string, string[]>()
  const blockLayer = (name: string, message: string) => {
    blockers.push(message)
    layerBlockers.set(name, [...(layerBlockers.get(name) ?? []), message])
  }
  for (const name of names) {
    const record = records.get(name)
    if (!record) continue
    const declaredParent = record.parent
    const configuredParent = record.parentSource === 'recorded' ? declaredParent : null
    parentMap[name] = configuredParent
    parentTipMap[name] = record.parentTip
    tips[name] = record.oid
    if (record.invalidParentTip) {
      blockers.push(`Branch ${name} has an invalid recorded parent boundary`)
      continue
    }
    const upstream = await branchUpstream(root, name)
    remoteOids[name] =
      (kind === 'publish' || kind === 'sync') && pushUrl
        ? await remoteOid(root, pushUrl, name)
        : null
    prs[name] = record.pr
      ? {
          number: record.pr.number,
          state: record.pr.state,
          base: record.pr.base,
          headOid: record.pr.headOid ?? null,
        }
      : null
    if (record.pr?.state === 'MERGED') {
      skippedMerged.add(name)
      if (kind === 'merge' && name === selectedBranch) {
        blockers.push(`Branch ${name} already has a merged pull request`)
      }
      if (kind === 'sync') {
        const base = effectiveParent(records, name, trunk) ?? trunk
        const baseTarget = await parentTarget(root, base, trunk, false)
        syncLayers.push({
          branch: name,
          base,
          baseOid: baseTarget?.oid ?? record.oid,
          recordedParent: declaredParent,
          retargetedFrom: null,
          oid: record.oid,
          remoteOid: remoteOids[name],
          remoteRelation: await remoteRelation(root, remoteOids[name], record.oid),
          commits: 0,
          rebase: false,
          merged: true,
          pullRequest: prs[name],
          blockers: [],
          note: `Pull request #${record.pr?.number ?? '?'} merged; ${name} is left untouched`,
        })
      }
      continue
    }
    const parent = effectiveParent(records, name, trunk)
    if (!parent || parent === name) {
      blockers.push(`Branch ${name} has an invalid parent`)
      continue
    }
    const oldParent = declaredParent
    const oldConfiguredParent = configuredParent
    const oldParentRecord = oldParent ? records.get(oldParent) : null
    let boundary = record.parentTip
    let parentTipSource: PlanEntry['parentTipSource'] = 'parent-tip'
    if (!boundary) {
      const oldParentOid =
        oldParentRecord?.oid ??
        (oldParent === trunk
          ? ((await resolveCommit(root, `refs/heads/${trunk}`)) ??
            (await resolveCommit(root, `refs/remotes/origin/${trunk}`)))
          : null)
      if (!oldParentOid) {
        blockers.push(`Cannot determine the original parent boundary for ${name}`)
        continue
      }
      boundary = await actualMergeBase(root, oldParentOid, record.oid)
      parentTipSource = 'merge-base'
      if (!boundary) {
        blockers.push(`No common ancestor exists for ${name} and ${oldParent ?? trunk}`)
        continue
      }
    }
    const retargetedFrom = oldParent && oldParent !== parent ? oldParent : null
    // Sync replays onto the fetched tip; captureSyncTrunk blocks unpublished
    // local trunk commits before that replay can discard their ancestry.
    const preferRemoteTrunk = kind !== 'restack' || Boolean(retargetedFrom && parent === trunk)
    const localTrunkOid = parent === trunk ? await resolveCommit(root, `refs/heads/${trunk}`) : null
    const remoteTrunkOid =
      parent === trunk ? await resolveCommit(root, `refs/remotes/origin/${trunk}`) : null
    const trunkDiverged = Boolean(
      localTrunkOid &&
      remoteTrunkOid &&
      localTrunkOid !== remoteTrunkOid &&
      !(await isAncestor(root, localTrunkOid, remoteTrunkOid)) &&
      !(await isAncestor(root, remoteTrunkOid, localTrunkOid)),
    )
    if (trunkDiverged && !preferRemoteTrunk) {
      blockers.push(
        `Trunk ${trunk} has divergent local and origin tips; refresh or reconcile it before restacking ${name}`,
      )
      continue
    }
    const target = await parentTarget(root, parent, trunk, preferRemoteTrunk)
    if (!target) {
      blockers.push(`Parent ${parent} for ${name} does not resolve locally`)
      continue
    }
    parentOidMap[name] = target.oid
    const effectiveParentOid = target.oid
    if (retargetedFrom && oldParentRecord?.pr?.state === 'MERGED') {
      const mergedPr = oldParentRecord.pr
      const mergeOid = mergedPr.mergeOid
      if (
        !mergeOid ||
        !(await resolveCommit(root, mergeOid)) ||
        !(await isAncestor(root, mergeOid, effectiveParentOid))
      ) {
        blockers.push(
          `Merged parent ${retargetedFrom} has no validated merge commit reachable from ${parent}; fetch origin and inspect the rewritten base before retrying`,
        )
      }
      let recordedMergeHead =
        oldParentRecord.mergedHeadPr === String(mergedPr.number) &&
        oldParentRecord.mergedCommitOid === mergedPr.mergeOid &&
        oldParentRecord.mergedHeadOid &&
        isOid(oldParentRecord.mergedHeadOid)
          ? await resolveCommit(root, oldParentRecord.mergedHeadOid)
          : null
      if (!recordedMergeHead) {
        const journalRecord =
          mergedJournal.get(String(mergedPr.number)) ?? mergedJournal.get(retargetedFrom)
        if (
          journalRecord &&
          journalRecord.pr === mergedPr.number &&
          journalRecord.headOid &&
          isOid(journalRecord.headOid) &&
          (!journalRecord.mergeOid || journalRecord.mergeOid === mergedPr.mergeOid)
        ) {
          recordedMergeHead = await resolveCommit(root, journalRecord.headOid)
        }
      }
      if (!recordedMergeHead && mergedPr.mergeOid) {
        try {
          const parents = await commitParents(root, mergedPr.mergeOid)
          if (parents.length >= 2 && isOid(parents[1])) {
            recordedMergeHead = await resolveCommit(root, parents[1])
          }
        } catch {
          // Ignore
        }
      }
      const boundaryIncludedInParent = await isAncestor(root, boundary, effectiveParentOid)
      const unsafeBoundaryMessage = `Merged parent ${retargetedFrom} has no validated merge-time head for ${name} that can be used as a safe replay boundary; syncing is blocked to preserve commits`
      if (!recordedMergeHead) {
        blockLayer(name, unsafeBoundaryMessage)
      } else {
        const isChildTip = recordedMergeHead === record.oid
        const commitsToChild = await commitCount(root, recordedMergeHead, record.oid)
        const isProven =
          !isChildTip &&
          commitsToChild > 0 &&
          (await isProvenMergeHead(
            root,
            mergedPr.number,
            recordedMergeHead,
            mergeOid ?? '',
            mergedJournal,
          ))
        if (!isProven) {
          blockLayer(name, unsafeBoundaryMessage)
        } else if (await isAncestor(root, recordedMergeHead, record.oid)) {
          const mergeHeadIncludedInBoundary = await isAncestor(root, recordedMergeHead, boundary)
          if (!mergeHeadIncludedInBoundary || !boundaryIncludedInParent) {
            // Replay from the immutable head captured when the PR was merged.
            // The live source ref may have advanced since GitHub closed the PR.
            boundary = recordedMergeHead
          }
        } else if (!boundaryIncludedInParent) {
          blockLayer(name, unsafeBoundaryMessage)
        }
      }
    }
    const commits = await commitCount(root, boundary, record.oid)
    const mergeCount = await mergeCommitCount(root, boundary, record.oid)
    if (kind !== 'publish' && kind !== 'merge' && mergeCount > 0) {
      blockLayer(
        name,
        `Branch ${name} contains ${mergeCount} merge commit${mergeCount === 1 ? '' : 's'}; replaying it is blocked to preserve merge topology. Resolve it manually before retrying.`,
      )
    }
    const needsRestack =
      parent !== oldParent ||
      Boolean(record.parentTip && record.parentTip !== effectiveParentOid) ||
      !(await isAncestor(root, effectiveParentOid, record.oid))
    if (kind === 'publish' && needsRestack) {
      blockers.push(
        `Branch ${name} needs an explicit Restack before Publish; Publish never rewrites local refs`,
      )
    }
    if (
      kind === 'publish' &&
      parent === trunk &&
      localTrunkOid &&
      remoteTrunkOid &&
      record.parentTip === localTrunkOid &&
      !(await isAncestor(root, localTrunkOid, remoteTrunkOid))
    ) {
      blockers.push(
        `Publish or reconcile ${trunk} with origin/${trunk} first; this stack contains unpublished trunk commits`,
      )
    }
    if (retargetedFrom) {
      warnings.push(
        `Merged parent ${retargetedFrom} will be replaced by ${parent}; ${commits} child commits remain after the recorded boundary`,
      )
    }
    const noteParts = [
      kind === 'restack' || kind === 'sync'
        ? `Replay onto ${target.ref.replace(/^refs\/(?:heads|remotes)\//u, '')} @ ${target.oid.slice(0, 12)}`
        : kind === 'publish'
          ? `Push reviewed tip ${record.oid.slice(0, 12)}; PR base ${parent}`
          : `Merge only PR #${record.pr?.number ?? '?'} into ${parent}`,
    ]
    if (parentTipSource === 'merge-base') {
      noteParts.push(`using merge-base ${boundary.slice(0, 12)} (${commits} commits)`)
      warnings.push(
        `Branch ${name} has no recorded parent boundary. Review the merge-base and ${commits} preserved commits before restacking.`,
      )
    }
    entries.push({
      branch: name,
      parent,
      parentRef: target.ref,
      parentOid: target.oid,
      oldParent: oldConfiguredParent,
      oldTip: record.oid,
      boundary,
      oldParentTip: record.parentTip,
      parentTipSource,
      needsRestack,
      pr: record.pr,
      remoteOid: remoteOids[name],
      upstream,
      retargetedFrom,
      note: noteParts.join('; '),
    })
    if (kind === 'sync') {
      syncLayers.push({
        branch: name,
        base: parent,
        baseOid: effectiveParentOid,
        recordedParent: oldParent,
        retargetedFrom,
        oid: record.oid,
        remoteOid: remoteOids[name],
        remoteRelation: await remoteRelation(root, remoteOids[name], record.oid),
        commits,
        rebase: needsRestack,
        merged: false,
        pullRequest: prs[name],
        blockers: layerBlockers.get(name) ?? [],
        note: noteParts.join('; '),
      })
    }
  }
  const depth = (name: string, seen = new Set<string>()): number => {
    if (seen.has(name)) return 0
    seen.add(name)
    const record = records.get(name)
    if (!record || !record.parent || record.parent === trunk) return 0
    return 1 + depth(record.parent, seen)
  }
  entries.sort(
    (left, right) =>
      depth(left.branch) - depth(right.branch) || left.branch.localeCompare(right.branch),
  )
  const restackedAncestors = new Set<string>()
  for (const entry of entries) {
    if (entry.needsRestack || restackedAncestors.has(entry.parent)) {
      entry.needsRestack = true
      restackedAncestors.add(entry.branch)
    }
  }
  let merge: MergePreview | null = null
  let mergeStackNumber: number | null = null
  let queueConfigured = false
  if (kind === 'merge') {
    const selectedEntry = entries.find((entry) => entry.branch === selectedBranch)
    if (!selectedEntry) {
      blockers.push(`No unmerged stack entry exists for ${selectedBranch}`)
    } else if (!selectedEntry.pr) {
      blockers.push(`Branch ${selectedBranch} has no canonical pull request`)
    } else {
      const chain = contiguousMergeChain(entries, selectedEntry, trunk)
      blockers.push(...chain.blockers)
      for (const entry of chain.layers) {
        const pr = entry.pr
        if (!pr || !pr.headOid) continue
        blockers.push(...mergeLayerBlockers(pr, entry.parent, entry.oldTip))
        const gates = directMergeGates(pr)
        if (gates.length > 0) {
          warnings.push(
            `${gates.join('; ')}. A direct merge needs that resolved now; a merge-queue merge is evaluated by GitHub after the queue runs its checks.`,
          )
        }
      }
      if (chain.layers.length > 0) {
        // An accepted enqueue is evidence that this base ref has a merge queue.
        queueConfigured = queueConfiguredFor(
          await readMergeObservations(root),
          selectedEntry.pr.base,
        )
        merge = mergePreviewFor(
          chain.layers,
          selectedEntry.pr,
          snapshot.nativeStacks ?? [],
          queueConfigured,
          blockers,
          warnings,
        )
        mergeStackNumber = merge?.native ? (selectedEntry.pr.stack?.stackNumber ?? null) : null
        if (merge?.native && mergeStackNumber === null) {
          blockers.push('The selected pull request reports stack membership without a stack number')
        }
      }
    }
  }
  if (kind === 'publish' || kind === 'sync') {
    for (const entry of entries) {
      if (entry.upstream && entry.upstream !== `origin/${entry.branch}`) {
        blockers.push(
          `Branch ${entry.branch} has a non-origin or renamed upstream (${entry.upstream})`,
        )
      }
      if (entry.remoteOid && entry.remoteOid !== entry.oldTip) {
        warnings.push(
          `Publishing ${entry.branch} may require a force-with-lease from ${entry.remoteOid.slice(0, 12)}`,
        )
      }
    }
  }
  syncLayers.sort(
    (left, right) =>
      depth(left.branch) - depth(right.branch) || left.branch.localeCompare(right.branch),
  )
  for (const layer of syncLayers) {
    if (
      !layer.merged &&
      (restackedAncestors.has(layer.branch) ||
        restackedAncestors.has(layer.base) ||
        Boolean(layer.retargetedFrom))
    ) {
      layer.rebase = true
      restackedAncestors.add(layer.branch)
    }
  }
  const syncCapture: SyncCapture | null =
    kind === 'sync' ? await captureSyncTrunk(root, trunk, pushUrl, syncLayers, fetchFailure) : null
  if (entries.length === 0 && kind !== 'merge' && kind !== 'sync') {
    blockers.push(
      'No unmerged branches remain in this stack; select a remaining branch to continue',
    )
  }
  /**
   * One merge action lands a contiguous run of pull requests, so each layer says how it
   * relates to the pull request the person selected. A GitHub-native stack lands all of them
   * from one request; a locally chained stack has nothing linking them, so each layer merges
   * from its own request and the order is what makes the stack mergeable.
   */
  function mergeLayerNote(entry: PlanEntry, merge: MergePreview): string {
    const selected = merge.layers[merge.layers.length - 1]
    const number = entry.pr?.number ?? 0
    if (number === selected.pullRequest) {
      return merge.native
        ? `Merge #${number} into ${entry.parent}; GitHub lands every pull request below it in this same operation`
        : `Merge #${number} into ${entry.parent} last, after the pull requests below it`
    }
    return merge.native
      ? `Lands in this same operation as #${selected.pullRequest}, into ${entry.parent}`
      : `Merges into ${entry.parent} first, from its own request`
  }

  // A merge review is about the pull requests one action will land, not about every branch in
  // the connected graph, so the reviewed steps are the merge's own layers, bottom-to-top.
  const reviewEntries = merge
    ? merge.layers
        .map((layer) => entries.find((entry) => entry.pr?.number === layer.pullRequest))
        .filter((entry): entry is PlanEntry => Boolean(entry))
    : entries
  const steps: StackStep[] = reviewEntries.map((entry) => ({
    branch: entry.branch,
    parent: entry.parent,
    oid: entry.oldTip,
    commits: 0,
    title: entry.pr?.title ?? entry.branch,
    pr: entry.pr,
    note: merge ? mergeLayerNote(entry, merge) : entry.note,
  }))
  for (const [index, entry] of reviewEntries.entries()) {
    steps[index] = {
      ...steps[index],
      commits: await commitCount(root, entry.boundary, entry.oldTip),
    }
  }
  if (skippedMerged.size > 0)
    warnings.push(
      `Merged stack branches are left untouched: ${[...skippedMerged].sort().join(', ')}`,
    )
  const token = randomUUID()
  const plan: StackPlan = {
    token,
    repoPath: root,
    expiresAt: Date.now() + PLAN_TTL_MS,
    kind,
    branch: selectedBranch,
    trunk,
    defaultBranch,
    originUrl,
    pushUrl,
    originFullName,
    originalBranch: currentBranch,
    originalHead: currentHead,
    entries,
    capturedParents: parentMap,
    capturedParentTips: parentTipMap,
    capturedParentOids: parentOidMap,
    capturedTips: tips,
    capturedRemoteOids: remoteOids,
    capturedMergedHeads,
    capturedPrs: prs,
    nativeStacksAvailable: githubData?.nativeStackPreviewAvailable === true,
    nativeStacksReason: githubData?.nativeStackPreviewReason ?? 'not-applicable',
    capturedStacks: (snapshot.nativeStacks ?? []).map((stack) => ({
      number: stack.number,
      open: stack.open,
      base: stack.base,
      status: stack.status,
      members: stack.pullRequests.map((member) => ({ ...member })),
    })),
    warnings,
    blockers,
    mergeMethods,
    sync: syncCapture,
    merge,
    mergeStackNumber,
  }
  const syncPreview = syncCapture ? buildSyncPreview(syncCapture, selectedBranch) : null
  if (syncPreview)
    blockers.push(...syncPreview.blockers.filter((reason) => !blockers.includes(reason)))
  plans.set(token, plan)
  return {
    plan,
    preview: {
      token,
      kind,
      branch: selectedBranch,
      steps,
      warnings,
      blockers,
      mergeMethods: plan.mergeMethods,
      merge,
      publish: kind === 'publish' ? await publishPreview(plan) : null,
      sync: syncPreview,
    },
  }
}

function prunePlans(): void {
  const now = Date.now()
  for (const [token, plan] of plans) if (plan.expiresAt <= now) plans.delete(token)
}

export async function previewStack(
  repoPath: string,
  snapshot: RepositorySnapshot,
  kind: StackKind,
  branch: string,
): Promise<StackPreview> {
  if (kind !== 'restack' && kind !== 'publish' && kind !== 'merge' && kind !== 'sync')
    throw new Error('Invalid stack preview kind')
  requireRefInput(branch, 'branch')
  prunePlans()
  const result = await capturePlan(repoPath, snapshot, kind, branch)
  return result.preview
}

function shortOid(value: string | null): string {
  return value ? value.slice(0, 12) : 'none'
}

/**
 * The bottom-to-top offer a person reviews: one layer per branch with the pull
 * request identity, the base it must land on, and whether the push replaces
 * remote history. No choice is applied here; `buildPublishOperation` does that
 * once the reviewed values are dispatched.
 */
async function publishPreview(plan: StackPlan): Promise<PublishPreview> {
  const registered = new Map<number, number>()
  for (const stack of plan.capturedStacks) {
    for (const member of stack.members) {
      if (!registered.has(member.number)) registered.set(member.number, stack.number)
    }
  }
  const layers: PublishLayer[] = []
  const baseChanges: string[] = []
  let stackNumber: number | null = null
  for (const entry of plan.entries) {
    const pr = entry.pr
    const open = pr?.state === 'OPEN' ? pr : null
    const title = open?.title ?? entry.branch
    const retarget = Boolean(open && open.base !== entry.parent)
    if (open && registered.has(open.number)) stackNumber ??= registered.get(open.number) ?? null
    // A layer whose pull request does not exist yet can still already belong to a native
    // stack through a sibling layer's pull request head, and a submission must not silently
    // create a second stack for branches GitHub already groups.
    if (stackNumber === null) {
      for (const stack of plan.capturedStacks) {
        const owns = stack.members.some((member) => member.head === entry.branch)
        if (owns) {
          stackNumber = stack.number
          break
        }
      }
    }
    if (retarget) baseChanges.push(entry.branch)
    layers.push({
      branch: entry.branch,
      base: entry.parent,
      title,
      body: `${title}\n\nGit Stacks branch: ${entry.branch}\nBase: ${entry.parent}`,
      draft: true,
      updateBase: false,
      create: !open,
      createIntent: false,
      // A push only needs a lease when the remote tip is not already an ancestor of the
      // local tip. A branch that merely moved forward publishes as an ordinary fast-forward
      // and must not demand force consent.
      force:
        entry.remoteOid !== null &&
        !(await isAncestor(plan.repoPath, entry.remoteOid, entry.oldTip)),
      pullRequest: open?.number ?? null,
    })
  }
  // A host that does not serve native stacks never gets a registration step:
  // the pull requests still chain onto each other, and the stack stays local.
  const stackAction: PublishStackAction =
    layers.length === 0 ||
    !plan.nativeStacksAvailable ||
    // An unestablished probe is not a licence to plan native membership: the
    // only absence this build acts on is a resource the host refused.
    plan.nativeStacksReason !== 'available'
      ? 'none'
      : stackNumber
        ? 'extend'
        : 'create'
  return {
    branch: plan.branch,
    layers,
    steps: publishSteps(layers, stackAction, stackNumber),
    stackNumber,
    stackAction,
    baseChanges,
    capturedAt: new Date().toISOString(),
  }
}

function publishStep(
  kind: PublishStep['kind'],
  branch: string | null,
  label: string,
  detail: string,
  pullRequest: number | null,
): PublishStep {
  return { kind, branch, label, status: 'pending', pullRequest, detail, failure: null }
}

function publishSteps(
  layers: PublishLayer[],
  stackAction: PublishStackAction,
  stackNumber: number | null,
): PublishStep[] {
  const steps: PublishStep[] = []
  for (const layer of layers) {
    steps.push(
      publishStep(
        'push',
        layer.branch,
        `Push ${layer.branch}`,
        layer.force
          ? 'Replace the captured remote tip with an exact lease'
          : 'Add the reviewed tip',
        null,
      ),
    )
    if (layer.create) {
      steps.push(
        publishStep(
          'create-pr',
          layer.branch,
          `Create pull request for ${layer.branch} based on ${layer.base}`,
          layer.draft ? 'Opened as a draft' : 'Opened ready for review',
          null,
        ),
      )
    } else if (layer.updateBase && layer.pullRequest !== null) {
      steps.push(
        publishStep(
          'retarget-pr',
          layer.branch,
          `Rebase pull request #${layer.pullRequest} onto ${layer.base}`,
          'Only this base changes; the title, body and review stay as written',
          layer.pullRequest,
        ),
      )
    }
  }
  if (stackAction !== 'none') {
    steps.push(
      publishStep(
        stackAction === 'create' ? 'create-stack' : 'extend-stack',
        null,
        stackAction === 'create'
          ? `Register the native stack on ${stackNumber === null ? 'the default branch' : `stack #${stackNumber}`}`
          : `Extend native stack #${stackNumber} with the new pull requests`,
        `${layers.length} pull request${layers.length === 1 ? '' : 's'}, bottom to top`,
        null,
      ),
    )
  }
  return steps
}

async function publishPath(repoPath: string): Promise<string> {
  return path.join(await gitDirectory(repoPath), 'git-stacks-publish.json')
}

function validPublishStep(value: unknown): value is PublishStep {
  return (
    isRecord(value) &&
    ['push', 'create-pr', 'retarget-pr', 'create-stack', 'extend-stack'].includes(
      String(value.kind),
    ) &&
    (value.branch === null || typeof value.branch === 'string') &&
    typeof value.label === 'string' &&
    ['pending', 'running', 'completed', 'failed'].includes(String(value.status)) &&
    (value.pullRequest === null ||
      (typeof value.pullRequest === 'number' && Number.isInteger(value.pullRequest))) &&
    typeof value.detail === 'string' &&
    (value.failure === null || isRecord(value.failure))
  )
}

async function readPublishOperation(repoPath: string): Promise<PublishOperation | null> {
  let value: string
  try {
    const target = await publishPath(repoPath)
    if ((await fs.stat(target)).size > 1024 * 1024)
      throw new Error('Submit Stack progress is too large')
    value = await fs.readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('The Git Stacks submit progress is corrupt; refusing to continue a submission')
  }
  const invalid = () =>
    new Error('The Git Stacks submit progress is invalid; refusing to continue a submission')
  if (
    !isRecord(parsed) ||
    parsed.version !== PUBLISH_VERSION ||
    typeof parsed.id !== 'string' ||
    /^[0-9a-f-]{36}$/u.test(parsed.id) === false ||
    parsed.repoPath !== repoPath ||
    typeof parsed.originUrl !== 'string' ||
    typeof parsed.fullName !== 'string' ||
    typeof parsed.pushUrl !== 'string' ||
    typeof parsed.defaultBranch !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.allowForce !== 'boolean' ||
    typeof parsed.message !== 'string' ||
    (parsed.stackNumber !== null && !Number.isInteger(parsed.stackNumber)) ||
    (parsed.stackCreateRequested !== undefined &&
      typeof parsed.stackCreateRequested !== 'boolean') ||
    !['create', 'extend', 'none'].includes(String(parsed.stackAction)) ||
    (parsed.nativeStacksAvailable !== undefined &&
      typeof parsed.nativeStacksAvailable !== 'boolean') ||
    (parsed.nativeStacksReason !== undefined && typeof parsed.nativeStacksReason !== 'string') ||
    !['running', 'failed', 'completed'].includes(String(parsed.status)) ||
    !Array.isArray(parsed.layers) ||
    parsed.layers.length === 0 ||
    parsed.layers.length > 2048 ||
    !Array.isArray(parsed.branches) ||
    parsed.branches.length !== parsed.layers.length ||
    !parsed.branches.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.branch === 'string' &&
        isOid(fact.oid) &&
        (fact.remoteOid === null || isOid(fact.remoteOid)) &&
        (fact.pullRequestBase === undefined ||
          fact.pullRequestBase === null ||
          typeof fact.pullRequestBase === 'string'),
    ) ||
    !parsed.layers.every(
      (layer) =>
        isRecord(layer) &&
        typeof layer.branch === 'string' &&
        typeof layer.base === 'string' &&
        typeof layer.title === 'string' &&
        typeof layer.body === 'string' &&
        typeof layer.draft === 'boolean' &&
        typeof layer.updateBase === 'boolean' &&
        typeof layer.create === 'boolean' &&
        typeof layer.force === 'boolean' &&
        (layer.pullRequest === null || Number.isInteger(layer.pullRequest)),
    ) ||
    !Array.isArray(parsed.steps) ||
    parsed.steps.length === 0 ||
    !parsed.steps.every(validPublishStep)
  )
    throw invalid()
  const operation = parsed as unknown as PublishOperation
  for (const fact of operation.branches) await validateBranchName(repoPath, fact.branch)
  for (const layer of operation.layers) await validateBranchName(repoPath, layer.branch)
  for (const step of operation.steps) {
    if (step.branch) await validateBranchName(repoPath, step.branch)
  }
  return operation
}

type PublishProgressListener = (progress: PublishProgress | null) => void

const publishProgressListeners = new Set<PublishProgressListener>()

/**
 * Subscribes to submission progress. The journal write is the only place a step can change, so
 * it publishes there: a running multi-step submission reports itself without the renderer
 * polling a read that would queue behind the action that is producing it.
 */
export function onPublishProgress(listener: PublishProgressListener): () => void {
  publishProgressListeners.add(listener)
  return () => {
    publishProgressListeners.delete(listener)
  }
}

export async function readPublishProgress(repoPath: string): Promise<PublishProgress | null> {
  const operation = await readPublishOperation(await repositoryPath(repoPath))
  return operation ? publishProgressOf(operation) : null
}

async function writePublishOperation(repoPath: string, operation: PublishOperation): Promise<void> {
  const target = await publishPath(repoPath)
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temporary, JSON.stringify(operation), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, target)
  for (const listener of publishProgressListeners) listener(publishProgressOf(operation))
}

async function removePublishOperation(repoPath: string): Promise<void> {
  for (const listener of publishProgressListeners) listener(null)
  try {
    await fs.unlink(await publishPath(repoPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function publishProgressOf(operation: PublishOperation): PublishProgress {
  const resumeAt = operation.steps.findIndex((step) => step.status !== 'completed')
  return {
    operationId: operation.id,
    status: operation.status,
    steps: operation.steps.map((step) => ({ ...step })),
    message: operation.message,
    resumeAt: resumeAt === -1 ? null : resumeAt,
    layers: operation.layers.map((layer) => ({ ...layer })),
    allowForce: operation.allowForce,
  }
}

/**
 * The pull requests the previewed native stack already held, so the submission can prove
 * that stack still owns them before it appends anything to it.
 */
function capturedStackMembers(plan: StackPlan, stackNumber: number | null): CapturedStackMember[] {
  if (stackNumber === null) return []
  const stack = plan.capturedStacks.find((entry) => entry.number === stackNumber)
  if (!stack) return []
  return stack.members.map((member) => ({
    number: member.number,
    headSha: member.headSha,
    head: member.head,
    base: member.base,
    state: member.state,
  }))
}

async function buildPublishOperation(
  repoPath: string,
  plan: StackPlan,
  action: Extract<SubmitStackAction, { type: 'submitStack' }>,
): Promise<PublishOperation> {
  const offer = await publishPreview(plan)
  const layers = offer.layers.map((layer) => {
    const choice = action.layers[layer.branch]
    return choice ? { ...layer, ...choice } : layer
  })
  const blockers: string[] = []
  for (const layer of layers) {
    if (layer.create && !layer.title.trim()) {
      blockers.push(`Layer ${layer.branch} needs a pull request title before it can be submitted`)
    }
    if (!layer.create && !layer.updateBase && offer.baseChanges.includes(layer.branch)) {
      blockers.push(
        `Pull request for ${layer.branch} is not based on ${layer.base}; approve the base change to submit it`,
      )
    }
    if (layer.force && !action.allowForce) {
      blockers.push(`Publishing ${layer.branch} requires explicit force-with-lease permission`)
    }
  }
  if (blockers.length > 0) throw new Error(blockers.join('; '))
  return {
    version: PUBLISH_VERSION,
    id: randomUUID(),
    repoPath,
    originUrl: plan.originUrl ?? '',
    fullName: plan.originFullName ?? '',
    pushUrl: plan.pushUrl ?? '',
    defaultBranch: plan.defaultBranch,
    createdAt: new Date().toISOString(),
    allowForce: action.allowForce,
    layers,
    branches: plan.entries.map((entry) => ({
      branch: entry.branch,
      oid: entry.oldTip,
      remoteOid: entry.remoteOid,
      pullRequestBase: entry.pr?.state === 'OPEN' ? entry.pr.base : null,
    })),
    steps: publishSteps(layers, offer.stackAction, offer.stackNumber),
    stackNumber: offer.stackNumber,
    capturedMembers: capturedStackMembers(plan, offer.stackNumber),
    stackAction: offer.stackAction,
    nativeStacksAvailable: plan.nativeStacksAvailable,
    nativeStacksReason: plan.nativeStacksReason,
    stackCreateRequested: false,
    status: 'running',
    message: 'Submitting the stack',
  }
}

function definitivelyRejectedCreation(error: unknown): boolean {
  // Only the create request itself can reject a registration, so only the errors
  // that request produces count. An error of ambiguous provenance keeps the
  // recorded intent instead of clearing it, because a cleared intent lets a
  // resume register the same membership a second time.
  if (error instanceof NativeStackError) {
    // The wrappers the create request translates its own 404 and 422 into. The
    // same class carries the local chain check, which runs before the intent is
    // recorded, so it can never reach this with a recorded create.
    return (
      (error.status === 'preview-unavailable' || error.status === 'invalid-chain') &&
      error.httpStatus !== null &&
      error.httpStatus >= 400 &&
      error.httpStatus < 500
    )
  }
  if (error instanceof GitHubTransportError) {
    // Timeouts and server/transport failures can hide an accepted mutation.
    const status = error.status
    return status !== null && status >= 400 && status < 500 && status !== 408
  }
  return false
}

/**
 * A GitHub 422 on a stack write is a rejected chain, not a transient fault: the
 * person has to change a pull request on GitHub, so retrying the same operation
 * would fail identically.
 */
function publishFailure(step: PublishStep, error: unknown): PublishStepFailure {
  const summary = error instanceof Error ? error.message : String(error)
  const status = error instanceof GitHubTransportError ? error.status : null
  const kind = error instanceof GitHubTransportError ? error.kind : null
  const stackStep = step.kind === 'create-stack' || step.kind === 'extend-stack'
  // The native stack writes translate a GitHub 422 into a typed NativeStackError that keeps
  // the HTTP status, so a rejected chain is recognised from either error surface. A progress
  // record that calls it retryable would send the person back into the same rejection.
  const nativeStatus = error instanceof NativeStackError ? error.httpStatus : null
  const rejectedChain = stackStep && (status === 422 || nativeStatus === 422)
  if (rejectedChain) {
    return {
      summary,
      recovery:
        'Fix the pull request bases or readiness on GitHub, then dismiss this submission and take a fresh preview.',
      retryable: false,
    }
  }
  const recovery =
    kind === 'unauthorized' || kind === 'forbidden'
      ? 'Check the GitHub credentials for this repository, then retry this step.'
      : kind === 'rate-limited' || kind === 'secondary-rate-limit'
        ? 'Wait for the GitHub rate limit to reset, then retry this step.'
        : step.kind === 'push'
          ? 'Fetch the remote, confirm nobody pushed to this branch, then retry this step.'
          : stackStep
            ? 'Check that every pull request is still open and stacked, then retry this step.'
            : 'Open the pull request on GitHub to check its base and state, then retry this step.'
  return { summary, recovery, retryable: true }
}

/**
 * Proves a reading of the published pull requests against the immutable journal. The journal
 * is the only record of what was reviewed, so it is the truth here: comparing a reading
 * against itself would accept any head that landed after the proof ran.
 */
function proveJournalledHeads(
  operation: PublishOperation,
  published: readonly PublishLayer[],
  reading: readonly PullRequest[],
): void {
  for (const layer of published) {
    const intended = operation.branches.find((facts) => facts.branch === layer.branch)
    if (!intended) continue
    const pr = reading.find((candidate) => candidate.number === layer.pullRequest)
    if (!pr) {
      throw new NativeStackError(
        'invalid-chain',
        `Pull request #${layer.pullRequest} could not be read before the stack was written`,
      )
    }
    if (pr.headOid !== intended.oid) {
      throw new NativeStackError(
        'invalid-chain',
        `Pull request #${layer.pullRequest} head moved to ${pr.headOid ?? 'none'} since it was published at ${intended.oid}`,
      )
    }
  }
}

async function provePublishedHead(
  repoPath: string,
  operation: PublishOperation,
  layer: PublishLayer,
  pr: PullRequest,
  expectedNumber = layer.pullRequest,
): Promise<void> {
  const intended = factsOf(operation, layer.branch)
  if (
    pr.number !== expectedNumber ||
    pr.head !== layer.branch ||
    pr.headRepository?.toLowerCase() !== operation.fullName.toLowerCase() ||
    pr.state !== 'OPEN'
  ) {
    throw new NativeStackError(
      'invalid-chain',
      `Pull request #${expectedNumber} no longer matches the published branch and repository or is no longer open`,
    )
  }
  if (pr.headOid !== intended.oid) {
    throw new NativeStackError(
      'invalid-chain',
      `Pull request #${expectedNumber} head moved to ${pr.headOid ?? 'none'} since it was published at ${intended.oid}`,
    )
  }
  const local = await resolveCommit(repoPath, `refs/heads/${layer.branch}`)
  if (local !== intended.oid) {
    throw new Error(`Stack preview is stale: local ${layer.branch} changed`)
  }
  const remote = await remoteOid(repoPath, operation.pushUrl, layer.branch)
  if (remote !== intended.oid) {
    throw new Error(`Stack preview is stale: remote ${layer.branch} changed`)
  }
}

/**
 * Proves each published pull request still carries the commit this operation published, and
 * that the branch still carries it locally and on the remote. This is the check that keeps a
 * resumed submission honest: completed push steps are skipped, so without it an external
 * force-push would be silently stacked as if it were the reviewed commit.
 */
async function provePublishedHeads(
  repoPath: string,
  operation: PublishOperation,
  published: readonly PublishLayer[],
): Promise<void> {
  for (const layer of published) {
    const pr = await getPullRequest(repoPath, layer.pullRequest as number)
    if (pr.base !== layer.base) {
      throw new Error(
        `Pull request #${layer.pullRequest} for ${layer.branch} is now based on ${pr.base}, not ${layer.base}`,
      )
    }
    await provePublishedHead(repoPath, operation, layer, pr)
  }
}

/**
 * True when `stack` holds exactly the pull requests this operation created, in the same
 * order, each still on the head and base the operation published. Anything else is somebody
 * else's membership change.
 */
function isOwnCreatedStack(
  stack: NativeStack,
  numbers: readonly number[],
  published: readonly PublishLayer[],
): boolean {
  if (stack.pullRequests.length !== numbers.length) return false
  return numbers.every((number, index) => {
    const member = stack.pullRequests[index]
    if (!member || member.number !== number) return false
    const layer = published[index]
    return Boolean(layer) && member.head === layer?.branch && member.base === layer?.base
  })
}

function layerOf(operation: PublishOperation, branch: string): PublishLayer {
  const layer = operation.layers.find((candidate) => candidate.branch === branch)
  if (!layer) throw new Error(`Submit progress no longer describes branch ${branch}`)
  return layer
}

function factsOf(operation: PublishOperation, branch: string): PublishBranchFacts {
  const facts = operation.branches.find((candidate) => candidate.branch === branch)
  if (!facts) throw new Error(`Submit progress no longer describes branch ${branch}`)
  return facts
}

async function revalidatePlan(repoPath: string, plan: StackPlan): Promise<void> {
  const origin = await getOriginUrl(repoPath)
  if (origin !== plan.originUrl)
    throw new Error('Stack preview is stale: the origin remote changed')
  const currentBranch = await getCurrentBranch(repoPath)
  const currentHead = await resolveCommit(repoPath, 'HEAD')
  if (currentBranch !== plan.originalBranch || currentHead !== plan.originalHead) {
    throw new Error('Stack preview is stale: the original checkout or HEAD changed')
  }
  if (plan.pushUrl) {
    const pushUrl = await getRemotePushUrl(repoPath, 'origin')
    const pushRemote = parseRemote(pushUrl)
    const originRemote = parseRemote(origin)
    if (
      pushUrl !== plan.pushUrl ||
      !pushRemote ||
      !originRemote ||
      remoteHostContext(pushRemote)?.host !== remoteHostContext(originRemote)?.host ||
      pushRemote.fullName.toLowerCase() !== originRemote.fullName.toLowerCase()
    ) {
      throw new Error('Stack preview is stale: the origin push URL changed')
    }
  }
  for (const [branch, expectedTip] of Object.entries(plan.capturedTips)) {
    const currentTip = await resolveCommit(repoPath, `refs/heads/${branch}`)
    if (currentTip !== expectedTip)
      throw new Error(`Stack preview is stale: branch ${branch} changed`)
  }
  const revalidateMergedJournal = await readMergedPrJournal(repoPath)
  for (const [branch, expected] of Object.entries(plan.capturedMergedHeads)) {
    const [configPr, configOid, configCommit] = await Promise.all([
      getConfigValue(repoPath, `branch.${branch}.gitStacksMergedHeadPr`),
      getConfigValue(repoPath, `branch.${branch}.gitStacksMergedHeadOid`),
      getConfigValue(repoPath, `branch.${branch}.gitStacksMergedCommitOid`),
    ])
    const journalEntry =
      revalidateMergedJournal.get(branch) ??
      (expected.pr ? revalidateMergedJournal.get(expected.pr) : null)
    const pr = configPr ?? (journalEntry ? String(journalEntry.pr) : null)
    const oid = configOid ?? journalEntry?.headOid ?? null
    const commit = configCommit ?? journalEntry?.mergeOid ?? null
    if (pr !== expected.pr || oid !== expected.oid || commit !== expected.commit) {
      throw new Error(`Stack preview is stale: merged pull request boundary for ${branch} changed`)
    }
  }
  for (const entry of plan.entries) {
    const parent = await getBranchParent(repoPath, entry.branch)
    if ((plan.capturedParents[entry.branch] ?? null) !== parent) {
      throw new Error(`Stack preview is stale: parent metadata for ${entry.branch} changed`)
    }
    const parentTip = await getConfigValue(repoPath, `branch.${entry.branch}.parentTip`)
    if ((plan.capturedParentTips[entry.branch] ?? null) !== parentTip) {
      throw new Error(`Stack preview is stale: parent boundary for ${entry.branch} changed`)
    }
    const parentOid = plan.capturedParentOids[entry.branch]
    if (parentOid) {
      const currentParentOid = await resolveCommit(repoPath, entry.parentRef)
      if (currentParentOid !== parentOid) {
        throw new Error(`Stack preview is stale: parent ${entry.parent} changed`)
      }
    }
    if (plan.pushUrl) {
      const currentRemote = await remoteOid(repoPath, plan.pushUrl, entry.branch)
      if (currentRemote !== entry.remoteOid)
        throw new Error(`Stack preview is stale: remote ${entry.branch} changed`)
    }
    if ((await branchUpstream(repoPath, entry.branch)) !== entry.upstream) {
      throw new Error(`Stack preview is stale: upstream for ${entry.branch} changed`)
    }
  }
  if (plan.sync && plan.pushUrl) {
    const liveRemoteTrunk = await remoteOid(repoPath, plan.pushUrl, plan.sync.trunk.branch)
    if (liveRemoteTrunk !== plan.sync.trunk.remoteOid) {
      throw new Error(
        `Stack preview is stale: trunk ${plan.sync.trunk.branch} moved on ${plan.sync.remote} after this preview was taken`,
      )
    }
  }
  // A publish writes native stack membership and a sync replays onto it, so an
  // unstack, a reorder, a changed head, or a landed merge invalidates the
  // preview the same way a moved local tip does.
  if (plan.kind === 'restack' && !plan.revalidateRemote) return
  const hasCapturedPrs = Object.values(plan.capturedPrs).some(Boolean)
  const hasCapturedStacks = plan.capturedStacks.length > 0
  if (!hasCapturedPrs && !hasCapturedStacks) return
  const data = await getGitHubData(repoPath, plan.originUrl)
  if (!data.available) {
    throw new Error(`Stack preview is stale: GitHub is no longer reachable (${data.message})`)
  }
  // A sync re-reads every layer's pull request before it replays a descendant,
  // so a merge, a retarget, or a push somebody else made lands as a refusal
  // rather than as a replay onto a base that no longer describes the stack.
  // A merge is the one action whose own answer is a landing, so a pull request
  // that is no longer open is not by itself staleness: a lower layer GitHub
  // already merged is read back and reported as the partial outcome it caused.
  // What still refuses the merge is the pull request that is no longer readable,
  // or whose reviewed head or base somebody else moved.
  for (const [branch, captured] of Object.entries(plan.capturedPrs)) {
    if (!captured) continue
    const current = data.pullRequests.find((pr) => pr.number === captured.number)
    if (!current) {
      throw new Error(
        `Stack preview is stale: pull request #${captured.number} for ${branch} is no longer readable`,
      )
    }
    const landed = plan.kind === 'merge' && captured.state === 'OPEN' && current.state !== 'OPEN'
    if (landed) continue
    if (
      current.state !== captured.state ||
      current.base !== captured.base ||
      current.headOid !== captured.headOid
    ) {
      throw new Error(
        `Stack preview is stale: pull request #${captured.number} for ${branch} changed on GitHub after this preview was taken`,
      )
    }
  }
  for (const captured of plan.capturedStacks) {
    const current = (data.nativeStacks ?? []).find((stack) => stack.number === captured.number)
    if (
      !current ||
      current.open !== captured.open ||
      current.base !== captured.base ||
      current.status !== captured.status ||
      current.pullRequests.length !== captured.members.length ||
      current.pullRequests.some((member, index) => {
        const was = captured.members[index]
        return (
          member.number !== was.number ||
          member.head !== was.head ||
          member.headSha !== was.headSha ||
          member.base !== was.base ||
          member.state !== was.state ||
          member.draft !== was.draft
        )
      })
    ) {
      throw new Error(`Stack preview is stale: native stack #${captured.number} changed on GitHub`)
    }
  }
}

async function restoreCheckout(
  repoPath: string,
  branch: string | null,
  head: string | null,
): Promise<void> {
  if (branch) {
    const exists = await refExists(repoPath, `refs/heads/${branch}`)
    if (exists) {
      await runGit(repoPath, ['switch', '--', branch])
      return
    }
  }
  if (head) await runGit(repoPath, ['switch', '--detach', head])
}

async function backupEntries(repoPath: string, journal: StackJournal): Promise<void> {
  for (const entry of journal.entries) {
    const existing = await resolveCommit(repoPath, entry.backupRef)
    if (existing) {
      if (existing !== entry.oldTip)
        throw new Error(`Backup ref for ${entry.branch} does not match its recorded tip`)
      continue
    }
    await runGit(repoPath, ['update-ref', entry.backupRef, entry.oldTip, ''])
  }
  // A surgery removes a branch instead of replaying it, so its original tip
  // needs the same recovery ref before the ref is deleted.
  for (const removed of journal.removed ?? []) {
    const existing = await resolveCommit(repoPath, removed.backupRef)
    if (existing) {
      if (existing !== removed.oldTip)
        throw new Error(`Recovery ref for ${removed.branch} does not match its recorded tip`)
      continue
    }
    await runGit(repoPath, ['update-ref', removed.backupRef, removed.oldTip, ''])
  }
}

async function deleteBackups(repoPath: string, journal: StackJournal): Promise<void> {
  for (const entry of journal.entries) {
    if (await resolveCommit(repoPath, entry.backupRef)) {
      await runGit(repoPath, ['update-ref', '-d', entry.backupRef, entry.oldTip])
    }
  }
  for (const removed of journal.removed ?? []) {
    if (await resolveCommit(repoPath, removed.backupRef)) {
      await runGit(repoPath, ['update-ref', '-d', removed.backupRef, removed.oldTip])
    }
  }
}

async function updateParentMetadata(
  repoPath: string,
  branch: string,
  parent: string,
  parentTip: string,
): Promise<void> {
  await setConfig(repoPath, `branch.${branch}.parent`, parent)
  await setConfig(repoPath, `branch.${branch}.parentTip`, parentTip)
}

async function restoreParentMetadata(repoPath: string, entry: JournalEntry): Promise<void> {
  if (entry.oldParent) await setConfig(repoPath, `branch.${entry.branch}.parent`, entry.oldParent)
  else await unsetConfig(repoPath, `branch.${entry.branch}.parent`)
  if (entry.oldParentTip)
    await setConfig(repoPath, `branch.${entry.branch}.parentTip`, entry.oldParentTip)
  else await unsetConfig(repoPath, `branch.${entry.branch}.parentTip`)
}

function backupRefFor(id: string, branch: string): string {
  return `refs/git-stacks/backups/${id}/${Buffer.from(branch, 'utf8').toString('hex')}`
}

async function verifyEntryMetadata(
  repoPath: string,
  entry: JournalEntry,
  rollback = false,
): Promise<void> {
  const [parent, tip] = await Promise.all([
    getBranchParent(repoPath, entry.branch),
    getConfigValue(repoPath, `branch.${entry.branch}.parentTip`),
  ])
  const before = parent === entry.oldParent && tip === entry.oldParentTip
  const after =
    entry.newParentTip !== null && parent === entry.newParent && tip === entry.newParentTip
  const forwardPartial = parent === entry.newParent && tip === entry.oldParentTip
  const rollbackPartial = parent === entry.oldParent && tip === entry.newParentTip
  const valid =
    entry.status === 'completed'
      ? after || (rollback && (before || rollbackPartial))
      : entry.status === 'metadata'
        ? before || after || forwardPartial || (rollback && rollbackPartial)
        : before
  if (!valid) throw new Error(`Parent metadata for ${entry.branch} changed outside Git Stacks`)
}

async function verifyCompletedEntries(repoPath: string, journal: StackJournal): Promise<void> {
  for (const entry of journal.entries) {
    if (entry.status !== 'completed') continue
    if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.newTip) {
      throw new Error(`Completed branch ${entry.branch} changed outside Git Stacks`)
    }
    await verifyEntryMetadata(repoPath, entry)
  }
}

interface ActiveRebaseState {
  head: string
  original: string
  onto: string
}

async function activeRebaseState(repoPath: string): Promise<ActiveRebaseState | null> {
  const directory = await gitDirectory(repoPath)
  for (const backend of ['rebase-merge', 'rebase-apply']) {
    try {
      const [head, original, onto] = await Promise.all(
        ['head-name', 'orig-head', 'onto'].map((name) =>
          fs.readFile(path.join(directory, backend, name), 'utf8'),
        ),
      )
      return { head: head.trim(), original: original.trim(), onto: onto.trim() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return null
}

function expectedRebaseOnto(journal: StackJournal, entry: JournalEntry): string {
  const parent = journal.entries.find(
    (candidate) => candidate.branch === entry.newParent && candidate.status === 'completed',
  )
  return entry.newParentTip ?? parent?.newTip ?? entry.newParentOid
}

function replayReflogAction(journal: StackJournal, entry: JournalEntry): string {
  return `git-stacks-rebase:${journal.id}:${entry.boundary}:${expectedRebaseOnto(journal, entry)}`
}

async function requiredHeadReflogCount(repoPath: string): Promise<number> {
  const logAllRefUpdates = await tryGit(repoPath, [
    'config',
    '--bool',
    '--get',
    'core.logAllRefUpdates',
  ])
  if (stripTrailingNewline(logAllRefUpdates ?? '') === 'false') {
    throw new Error('Restack recovery requires HEAD reflog recording to remain enabled')
  }
  const output = await tryGit(repoPath, ['reflog', 'show', 'HEAD', '--format=%H'])
  const count = output?.split('\n').filter((line) => line.length > 0).length ?? 0
  if (count === 0) throw new Error('Restack recovery requires an available HEAD reflog baseline')
  return count
}

type ParsedReflogEntry = { oid: string; message: string }

function recoveryProofError(entry: JournalEntry): Error {
  return new Error(
    `Cannot prove the saved rebase for ${entry.branch} matches its recorded boundary and destination; refusing recovery`,
  )
}

async function recordedHeadReflogDelta(
  repoPath: string,
  entry: JournalEntry,
): Promise<ParsedReflogEntry[]> {
  if (entry.headReflogCount === null) throw recoveryProofError(entry)
  const headOutput = await tryGit(repoPath, ['reflog', 'show', 'HEAD', '--format=%H %gs'])
  if (headOutput === null) throw recoveryProofError(entry)
  const headLines = headOutput.split('\n').filter((line) => line.length > 0)
  const deltaLength = headLines.length - entry.headReflogCount
  if (deltaLength < 1) throw recoveryProofError(entry)
  const delta = headLines.slice(0, deltaLength).map(parseReflogEntry).reverse()
  if (delta.some((line) => line === null)) throw recoveryProofError(entry)
  return delta as ParsedReflogEntry[]
}

async function assertRecordedReplayStart(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
): Promise<{ action: string; delta: ParsedReflogEntry[] }> {
  const action = replayReflogAction(journal, entry)
  const expectedOnto = expectedRebaseOnto(journal, entry)
  const delta = await recordedHeadReflogDelta(repoPath, entry)
  const start = delta[0]
  if (
    !start ||
    start.oid !== expectedOnto ||
    start.message !== `${action} (start): checkout ${expectedOnto}`
  )
    throw recoveryProofError(entry)
  return { action, delta }
}

function inactiveRebaseError(): Error {
  return new Error('The saved stack rebase is not active; inspect its backup refs before recovery')
}

async function assertActiveRebase(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
): Promise<void> {
  const state = await activeRebaseState(repoPath)
  if (!state) throw inactiveRebaseError()
  const expectedOnto = expectedRebaseOnto(journal, entry)
  if (
    state.head !== `refs/heads/${entry.branch}` ||
    state.original !== entry.oldTip ||
    state.onto !== expectedOnto
  ) {
    throw new Error(
      'The active rebase does not match the saved stack operation; refusing to change it',
    )
  }
  const { action, delta } = await assertRecordedReplayStart(repoPath, journal, entry)
  assertActiveReplayHistory(entry, action, delta)
  entry.newParentTip = expectedOnto
}

function isRecordedReplayStep(action: string, message: string): boolean {
  return message.startsWith(`${action} (pick): `) || message.startsWith(`${action} (continue): `)
}

function assertActiveReplayHistory(
  entry: JournalEntry,
  action: string,
  delta: ParsedReflogEntry[],
): void {
  for (let index = 1; index < delta.length; index += 1) {
    const line = delta[index]
    if (!line || !isRecordedReplayStep(action, line.message)) throw recoveryProofError(entry)
  }
}

function parseReflogEntry(line: string): ParsedReflogEntry | null {
  const separator = line.indexOf(' ')
  if (separator <= 0) return null
  return { oid: line.slice(0, separator), message: line.slice(separator + 1) }
}

// Prove that the ref entries appended since the journaled launch form exactly
// one rebase of this journal's replay: a single start checked out at the
// recorded onto, followed only by that rebase's pick/continue steps and its
// finish back on this branch. Anything else (an external abort, a second
// rebase, a substituted boundary) cannot be adopted, so the backup ref stays.
async function assertRecordedReplay(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
  expectedOnto: string,
  tip: string,
): Promise<void> {
  const { action, delta } = await assertRecordedReplayStart(repoPath, journal, entry)
  if (delta.length < 2) throw recoveryProofError(entry)
  let finish: ParsedReflogEntry | null = null
  for (let index = 1; index < delta.length; index += 1) {
    const line = delta[index]
    if (!line) throw recoveryProofError(entry)
    if (line.message === `${action} (finish): returning to refs/heads/${entry.branch}`) {
      finish = line
      break
    }
    if (!isRecordedReplayStep(action, line.message)) throw recoveryProofError(entry)
  }
  if (!finish || finish.oid !== tip || expectedRebaseOnto(journal, entry) !== expectedOnto)
    throw recoveryProofError(entry)
}

async function reconcileCompletedRebase(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
  tip: string | null,
): Promise<void> {
  const operation = await getOperationState(repoPath)
  if (operation.busy) throw new Error('Another Git operation is still in progress')
  if (!tip || tip === entry.oldTip) throw inactiveRebaseError()
  const backup = await resolveCommit(repoPath, entry.backupRef)
  if (backup !== entry.oldTip)
    throw new Error(`Backup ref for ${entry.branch} does not match its recorded tip`)
  const expectedOnto = expectedRebaseOnto(journal, entry)
  const output = await tryGit(repoPath, [
    'reflog',
    'show',
    `refs/heads/${entry.branch}`,
    '--format=%H %gs',
    '--max-count=2',
  ])
  const lines = (output ?? '').split('\n').filter((line) => line.length > 0)
  const newest = parseReflogEntry(lines[0] ?? '')
  const previous = parseReflogEntry(lines[1] ?? '')
  const prefix = `${replayReflogAction(journal, entry)} (finish): refs/heads/${entry.branch} onto `

  const proven =
    newest !== null &&
    previous !== null &&
    newest.oid === tip &&
    previous.oid === entry.oldTip &&
    newest.message.startsWith(prefix) &&
    isOid(newest.message.slice(prefix.length)) &&
    newest.message.slice(prefix.length) === expectedOnto
  if (!proven)
    throw new Error(`Branch ${entry.branch} changed outside Git Stacks; refusing to adopt its tip`)
  await assertRecordedReplay(repoPath, journal, entry, expectedOnto, tip)
  entry.newParentTip = expectedOnto
  entry.newTip = tip
  entry.status = 'metadata'
  await writeJournal(repoPath, journal)
}

async function completeEntry(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
): Promise<void> {
  if (entry.status === 'rebasing') {
    const [tip, branch] = await Promise.all([
      resolveCommit(repoPath, `refs/heads/${entry.branch}`),
      getCurrentBranch(repoPath),
    ])
    if (!tip || branch !== entry.branch)
      throw new Error(`Restack did not finish on attached branch ${entry.branch}`)
    entry.newTip = tip
    entry.status = 'metadata'
    await writeJournal(repoPath, journal)
  }
  if (entry.status !== 'metadata' || !entry.newTip || !entry.newParentTip)
    throw new Error('Incomplete stack completion checkpoint')
  if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.newTip) {
    throw new Error(`Branch ${entry.branch} changed before its metadata could be completed`)
  }
  await verifyEntryMetadata(repoPath, entry)
  await updateParentMetadata(repoPath, entry.branch, entry.newParent, entry.newParentTip)
  entry.status = 'completed'
  journal.status = 'running'
  journal.currentBranch = entry.branch
  journal.message = `Restacked ${entry.branch}`
  await writeJournal(repoPath, journal)
}

/**
 * Creates the branch a reviewed insert adds. The journal already names it, so
 * an interrupted run can recognise the ref as its own work and an abort can
 * delete exactly the branch this operation made.
 */
async function createJournalBranches(repoPath: string, journal: StackJournal): Promise<void> {
  for (const created of journal.created ?? []) {
    await ensureNotCheckedOutElsewhere(repoPath, created.branch)
    const tip = await resolveCommit(repoPath, `refs/heads/${created.branch}`)
    if (tip !== null) {
      if (tip !== created.oid)
        throw new Error(`Branch ${created.branch} appeared with another tip; no branch was created`)
      continue
    }
    await runGit(repoPath, ['update-ref', `refs/heads/${created.branch}`, created.oid, ''])
    await updateParentMetadata(repoPath, created.branch, created.parent, created.parentTip)
  }
}

/**
 * Deletes the branch a reviewed remove took out, after its commits are proven
 * recoverable from the recovery ref this journal created.
 */
async function removeJournalBranches(repoPath: string, journal: StackJournal): Promise<string> {
  const removed = journal.removed ?? []
  if (removed.length === 0) return ''
  const deleted: string[] = []
  for (const item of removed) {
    if (item.status !== 'pending') {
      deleted.push(item.branch)
      continue
    }
    if ((await resolveCommit(repoPath, `refs/heads/${item.branch}`)) !== item.oldTip) {
      throw new Error(`Refusing to delete ${item.branch}: its tip changed outside Git Stacks`)
    }
    if ((await resolveCommit(repoPath, item.backupRef)) !== item.oldTip) {
      throw new Error(`Refusing to delete ${item.branch}: its recovery ref is not its recorded tip`)
    }
    if ((await getCurrentBranch(repoPath)) === item.branch) {
      const restore =
        journal.originalBranch && journal.originalBranch !== item.branch
          ? journal.originalBranch
          : null
      if (restore && (await refExists(repoPath, `refs/heads/${restore}`))) {
        await runGit(repoPath, ['switch', '--', restore])
      } else {
        await runGit(repoPath, ['switch', '--detach', item.oldTip])
      }
    }
    await runGit(repoPath, ['update-ref', '-d', `refs/heads/${item.branch}`, item.oldTip])
    await tryGit(repoPath, ['config', '--remove-section', `branch.${item.branch}`])
    item.status = 'completed'
    deleted.push(item.branch)
  }
  await writeJournal(repoPath, journal)
  return `Deleted local branch ${deleted.join(', ')}`
}

async function restackJournal(
  repoPath: string,
  journal: StackJournal,
  /**
   * Runs after the replay and the lease-guarded pushes, while the recovery refs
   * still exist. A restack and a sync pass nothing; a surgery uses it for the
   * pull request and native stack changes its preview named, so a remote step
   * that fails leaves the original branch tips recoverable.
   */
  afterRemote?: (journal: StackJournal) => Promise<string>,
): Promise<ActionResult> {
  if (journal.status === 'aborting')
    throw new Error('Stack rollback has started; use Abort to finish it')
  await ensureNoBusyOperation(repoPath, 'resume the stack')
  await ensureClean(repoPath, 'resume the stack')
  await verifyCompletedEntries(repoPath, journal)
  await backupEntries(repoPath, journal)
  await writeJournal(repoPath, journal)
  for (const entry of journal.entries) {
    if (entry.status === 'completed') continue
    if (entry.status === 'metadata') {
      await completeEntry(repoPath, journal, entry)
      continue
    }
    if (entry.status !== 'pending')
      throw new Error(`Inspect the interrupted ${entry.branch} step before continuing`)
    if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.oldTip) {
      throw new Error(
        `Branch ${entry.branch} changed before its stack step; no replay was attempted`,
      )
    }
    await verifyEntryMetadata(repoPath, entry)
    await ensureNotCheckedOutElsewhere(repoPath, entry.branch)
    await ensureClean(repoPath, 'restack the next branch')
    const parent = journal.entries.find(
      (candidate) => candidate.branch === entry.newParent && candidate.status === 'completed',
    )
    const parentRef = parent ? `refs/heads/${entry.newParent}` : entry.newParentRef
    const parentOid = parent?.newTip ?? entry.newParentOid
    if ((await resolveCommit(repoPath, parentRef)) !== parentOid) {
      throw new Error(`Parent ${entry.newParent} changed after preview; no replay was attempted`)
    }
    if (!(await isAncestor(repoPath, entry.boundary, entry.oldTip))) {
      throw new Error(`The recorded rebase boundary for ${entry.branch} is no longer an ancestor`)
    }
    entry.newParentRef = parentRef
    entry.newParentTip = parentOid
    entry.status = 'rebasing'
    journal.currentBranch = entry.branch
    journal.status = 'running'
    journal.message = `Restacking ${entry.branch} onto ${entry.newParent}`
    try {
      await runGit(repoPath, ['switch', '--', entry.branch])
      if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.oldTip) {
        throw new Error(`Branch ${entry.branch} changed after preview; no replay was attempted`)
      }
      entry.headReflogCount = await requiredHeadReflogCount(repoPath)
      await writeJournal(repoPath, journal)
      if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.oldTip) {
        entry.status = 'pending'
        entry.headReflogCount = null
        throw new Error(`Branch ${entry.branch} changed after preview; no replay was attempted`)
      }
      await runGit(
        repoPath,
        [
          '-c',
          'rebase.updateRefs=false',
          '-c',
          'rebase.autoStash=false',
          'rebase',
          '--onto',
          parentOid,
          entry.boundary,
          entry.branch,
        ],
        {
          GIT_EDITOR: 'true',
          GIT_REFLOG_ACTION: replayReflogAction(journal, entry),
        },
      )
    } catch (error) {
      const operation = await getOperationState(repoPath)
      let restoreDetail = ''
      if (entry.headReflogCount === null) {
        entry.status = 'pending'
        if (!operation.rebase) {
          try {
            await restoreCheckout(repoPath, journal.originalBranch, journal.originalHead)
            journal.currentBranch = journal.originalBranch
          } catch (restoreError) {
            restoreDetail = `; checkout restore failed: ${commandDetail(restoreError)}`
          }
        }
      }
      journal.status = operation.rebase ? 'conflict' : 'uncertain'
      journal.message = `${operation.rebase ? 'Restack paused' : 'Restack stopped'} on ${entry.branch}: ${commandDetail(error)}${restoreDetail}`
      await writeJournal(repoPath, journal)
      throw new Error(journal.message)
    }
    await completeEntry(repoPath, journal, entry)
  }
  let pushMessage = ''
  if (journal.syncPushes) {
    const origin = await currentOrigin(repoPath, true)
    if (
      !origin.pushUrl ||
      origin.pushUrl !== journal.syncPushes.pushUrl ||
      (journal.syncPushes.originUrl && origin.url !== journal.syncPushes.originUrl)
    ) {
      throw new Error(
        journal.surgery
          ? 'Surgery progress is stale: the origin remote changed'
          : 'Sync progress is stale: the origin remote changed',
      )
    }
    const { pushUrl, allowForce, branches } = journal.syncPushes
    const pushed: string[] = []
    for (const item of branches) {
      const oid = await resolveCommit(repoPath, `refs/heads/${item.branch}`)
      if (!oid) throw new Error(`Branch ${item.branch} no longer exists after the replay`)
      if (item.status === 'completed') {
        const currentRemote = await remoteOid(repoPath, pushUrl, item.branch)
        if (item.publishedOid && currentRemote !== item.publishedOid) {
          throw new Error(
            `Stack preview is stale: remote ${item.branch} changed after it was synced`,
          )
        }
        pushed.push(item.branch)
        continue
      }
      if (oid === item.expectedRemoteOid) {
        item.status = 'completed'
        item.publishedOid = oid
        await writeJournal(repoPath, journal)
        continue
      }
      // A push whose response was lost left the remote at the tip this run
      // published. Recognising that is what keeps a resumed run from re-pushing
      // under a lease that can no longer hold.
      if ((await remoteOid(repoPath, pushUrl, item.branch)) === oid) {
        item.status = 'completed'
        item.publishedOid = oid
        await writeJournal(repoPath, journal)
        continue
      }
      await pushBranch(repoPath, item.branch, oid, item.expectedRemoteOid, allowForce, pushUrl)
      item.status = 'completed'
      item.publishedOid = oid
      await writeJournal(repoPath, journal)
      pushed.push(item.branch)
    }
    if (pushed.length > 0) {
      pushMessage = ` Pushed ${pushed.join(', ')}`
    }
  }
  const remoteMessages: string[] = []
  if (afterRemote) {
    let message: string
    try {
      message = await afterRemote(journal)
    } catch (error) {
      // The remote half is resumable: its steps re-read GitHub and recognise the
      // writes that landed, so the journal stays on disk with its original tips.
      journal.status = 'uncertain'
      journal.message = `${journal.surgery ? 'Surgery' : 'Stack'} stopped on a remote step: ${commandDetail(error)}`
      await writeJournal(repoPath, journal)
      throw error
    }
    if (message) remoteMessages.push(message)
  }
  // The branch a surgery removed is deleted only after every remote step it
  // previewed has happened, so a failed remote step still has its commits.
  const removed = await removeJournalBranches(repoPath, journal)
  if (removed) remoteMessages.push(removed)
  await restoreCheckout(repoPath, journal.originalBranch, journal.originalHead)
  await deleteBackups(repoPath, journal)
  await removeJournal(repoPath)
  const layers = journal.entries.length
  const count = `${layers} stack branch${layers === 1 ? '' : 'es'}`
  const parts = [
    journal.surgery
      ? `Applied the reviewed surgery to ${count}${pushMessage}`
      : journal.kind === 'sync'
        ? `Synced ${count}${pushMessage}`
        : `Restacked ${count}${pushMessage}`,
    ...remoteMessages,
  ]
  return { message: parts.join('. ') }
}

function journalEntryFor(id: string, entry: PlanEntry): JournalEntry {
  return {
    branch: entry.branch,
    oldTip: entry.oldTip,
    newTip: null,
    oldParent: entry.oldParent,
    oldParentTip: entry.oldParentTip,
    newParent: entry.parent,
    newParentRef: entry.parentRef,
    newParentOid: entry.parentOid,
    newParentTip: null,
    boundary: entry.boundary,
    backupRef: backupRefFor(id, entry.branch),
    headReflogCount: null,
    status: 'pending',
  }
}

/**
 * Runs the bottom-to-top replay for the reviewed layers. Restack passes every
 * planned layer; a sync passes only the layers its classification marked for
 * replay. Both share one journal, one set of recovery refs, and one reflog proof
 * model, so a conflict stops in the same recoverible place either way.
 */
async function runRestackCascade(
  repoPath: string,
  plan: StackPlan,
  entries: PlanEntry[],
  syncPushes?: SyncPushConfig,
): Promise<ActionResult> {
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '))
  if (entries.length === 0) {
    return { message: 'No remaining unmerged stack branches require restacking' }
  }
  await ensureNoBusyOperation(repoPath, 'restack the stack')
  await ensureClean(repoPath, 'restack the stack')
  await revalidatePlan(repoPath, plan)
  const id = randomUUID()
  const journal: StackJournal = {
    version: JOURNAL_VERSION,
    kind: plan.kind === 'sync' ? 'sync' : 'restack',
    id,
    repoPath,
    originalBranch: plan.originalBranch,
    originalHead: plan.originalHead,
    currentBranch: plan.originalBranch,
    entries: entries.map((entry) => journalEntryFor(id, entry)),
    status: 'running',
    message: plan.kind === 'sync' ? 'Preparing stack sync' : 'Preparing stack restack',
    syncPushes,
  }
  // A resumed surgery still owes its pull request and native stack changes, so the
  // same remote phase runs again and skips the steps its journal already completed.
  return restackJournal(
    repoPath,
    journal,
    journal.surgery ? (pending) => runSurgeryRemote(repoPath, pending) : undefined,
  )
}

/**
 * Runs a reviewed Sync Stack: the classified layers are replayed bottom-to-top
 * through the restack journal, then the previewed branches are pushed under the
 * remote tips this plan captured. A push that would replace published history
 * needs the explicit lease approval the preview asked for, and the guarded push
 * re-checks the captured tip at its own mutation boundary.
 */
async function runPlanSync(
  repoPath: string,
  plan: StackPlan,
  allowForce: boolean,
): Promise<ActionResult> {
  const capture = plan.sync
  const pushUrl = plan.pushUrl
  if (!capture || !pushUrl) throw new Error('This preview does not describe a stack sync')
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '))
  const preview = buildSyncPreview(capture, plan.branch)
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
  await ensureNoBusyOperation(repoPath, 'sync the stack')
  await ensureClean(repoPath, 'sync the stack')
  await revalidatePlan(repoPath, plan)
  const syncPushes: SyncPushConfig = {
    originUrl: plan.originUrl ?? (await getOriginUrl(repoPath)) ?? undefined,
    pushUrl,
    allowForce,
    branches: pushes.map((layer) => ({
      branch: layer.branch,
      expectedRemoteOid: plan.capturedRemoteOids[layer.branch] ?? null,
      force: layer.push === 'force',
      status: 'pending',
    })),
  }
  const replayed = new Set(rebases.map((layer) => layer.branch))
  const entries = plan.entries.filter((entry) => replayed.has(entry.branch))
  if (entries.length > 0) {
    return runRestackCascade(repoPath, plan, entries, syncPushes)
  }
  const pushed: string[] = []
  for (const item of syncPushes.branches) {
    const oid = await resolveCommit(repoPath, `refs/heads/${item.branch}`)
    if (!oid) throw new Error(`Branch ${item.branch} no longer exists`)
    if (oid === item.expectedRemoteOid) continue
    await pushBranch(repoPath, item.branch, oid, item.expectedRemoteOid, allowForce, pushUrl)
    pushed.push(item.branch)
  }
  return {
    message:
      pushed.length > 0
        ? `Pushed ${pushed.join(', ')}`
        : `Stack is already in sync with ${preview.trunk.remote}`,
  }
}

interface SurgeryRecord {
  token: string
  expiresAt: number
  plan: SurgeryPlan
  stackPlan: StackPlan
}

const surgeryPlans = new Map<string, SurgeryRecord>()

export function validateSurgeryRequest(value: unknown): SurgeryRequest {
  if (
    !isRecord(value) ||
    (value.kind !== 'insert' && value.kind !== 'move' && value.kind !== 'remove')
  ) {
    throw new Error('Surgery request must name one of insert, move, or remove')
  }
  const kind = value.kind
  const branch = requireRefInput(value.branch, 'branch')
  if (kind === 'move') {
    if (value.target === value.branch) throw new Error('A layer cannot be moved below itself')
    return { kind, branch, target: requireRefInput(value.target, 'target') }
  }
  if (kind === 'insert') return { kind, branch, name: requireRefInput(value.name, 'name') }
  return { kind, branch }
}

function branchDepth(records: Map<string, BranchRecord>, name: string, limit = 64): number {
  let depth = 0
  let current: string | undefined = name
  while (depth < limit) {
    const record: BranchRecord | undefined = current ? records.get(current) : undefined
    if (!record || record.parent === null) break
    current = record.parent
    depth += 1
  }
  return depth
}

/**
 * Reads every fact the surgery preview promises to hold, and the one stack plan
 * that proves them again immediately before the first ref moves. A remote this
 * repository cannot address by name leaves the remote facts empty, which the
 * planner reports as a blocker rather than guessing.
 */
async function captureSurgery(
  root: string,
  snapshot: RepositorySnapshot,
  request: SurgeryRequest,
): Promise<{ plan: SurgeryPlan; stackPlan: StackPlan }> {
  const blockers: string[] = []
  const warnings: string[] = []
  const anchor = request.branch
  await validateBranchName(root, anchor)
  if (request.kind === 'insert') await validateBranchName(root, request.name)
  if (request.kind === 'move') await validateBranchName(root, request.target)
  const operation = await getOperationState(root)
  if (operation.busy) blockers.push('A Git operation is already in progress')
  if ((await getStatus(root)).length > 0) {
    blockers.push('Commit or stash uncommitted changes before changing a stack')
  }
  const currentBranch = await getCurrentBranch(root)
  const currentHead = await resolveCommit(root, 'HEAD')
  let fetchFailure: string | null = null
  try {
    await runGit(root, ['fetch', '--all', '--prune'])
  } catch (error) {
    fetchFailure = `Could not fetch and prune the remotes: ${commandDetail(error)}`
    blockers.push(fetchFailure)
  }
  const refs = await getRefs(root)
  const defaultBranch =
    snapshot.defaultBranch || (await getDefaultBranch(root, refs, currentBranch))
  const originUrl = await getOriginUrl(root)
  const originFullName = canonicalRemoteName(originUrl)
  let pushUrl: string | null = null
  if (!originUrl) {
    // No origin means nothing is published, which is not a reason to refuse a local
    // surgery: the layers below are rewritten from Git alone.
    warnings.push(
      'This repository has no origin remote, so nothing can be pushed or retargeted; the plan below covers the local rewrites only.',
    )
  } else
    try {
      const candidate = await getRemotePushUrl(root, 'origin')
      const remote = parseRemote(candidate)
      if (!remote || remote.host !== 'github.com') {
        if (candidate) {
          // A stack with nothing published is still reparentable locally; the run
          // refuses the surgery outright when a rewrite would need a GitHub push.
          warnings.push(
            'This origin is not a github.com repository, so nothing can be pushed or retargeted; the plan below covers the local rewrites only.',
          )
        }
      } else if (originFullName && remote.fullName.toLowerCase() !== originFullName.toLowerCase()) {
        blockers.push('The origin fetch and push URLs address different GitHub repositories')
      } else {
        pushUrl = candidate
      }
    } catch (error) {
      blockers.push(`Could not read the origin push URL: ${commandDetail(error)}`)
    }
  const githubData = originFullName ? await getGitHubData(root, originUrl) : null
  // A stack with no submitted layer needs no GitHub at all: its rewrites are local
  // and the planner proves each one from Git. A submitted layer does need it, because
  // its pull request base is part of what the surgery changes.
  if (githubData && !githubData.available) {
    warnings.push(githubData.message)
  }
  if (originFullName && !pushUrl) {
    warnings.push(
      'The published side of this surgery cannot be recorded or retried without a github.com origin push URL; the plan below shows what it would do.',
    )
  }
  const trunk = nativeStackTrunk(githubData, anchor, snapshot, defaultBranch) ?? defaultBranch
  const trunkOid = await resolveCommit(root, `refs/heads/${trunk}`)
  if (!trunkOid)
    throw new Error(`Trunk ${trunk} has no local ref; fetch it before changing a stack`)
  const canonicalPrs = new Map<string, PullRequest>()
  if (githubData?.available) {
    for (const pr of githubData.pullRequests) {
      if (pr.headRepository) canonicalPrs.set(`${pr.number}`, pr)
    }
  }
  const records = await branchRecords(root, snapshot, trunk, originFullName, canonicalPrs)
  const connected =
    anchor === trunk
      ? { names: trunkStackNames(records, trunk), blockers: [] }
      : connectedBranchNames(records, anchor, trunk)
  blockers.push(...connected.blockers)
  const depth = (name: string): number => branchDepth(records, name)
  const chain = [...connected.names]
    .filter((name) => name !== trunk)
    .sort((a, b) => depth(a) - depth(b))
  const layers: SurgeryLayerFacts[] = []
  for (const branch of chain) {
    const record = records.get(branch) as BranchRecord
    const declared = record.parent ?? trunk
    const recordedParent = await getBranchParent(root, branch)
    const recordedParentTip = await getConfigValue(root, `branch.${branch}.parentTip`)
    const parentOid = declared === trunk ? trunkOid : records.get(declared)?.oid
    const layerBlockers: string[] = []
    if (record.invalidParentTip) {
      layerBlockers.push(`Branch ${branch} records a parent tip that is not a commit`)
    }
    let boundary = record.parentTip
    let boundarySource: 'recorded' | 'merge-base' = 'recorded'
    if (!boundary && parentOid) {
      boundary = (await actualMergeBase(root, parentOid, record.oid)) ?? null
      boundarySource = 'merge-base'
    }
    if (!boundary) {
      layerBlockers.push(`The original parent boundary of ${branch} cannot be determined`)
    } else if (!(await isAncestor(root, boundary, record.oid))) {
      layerBlockers.push(
        `The recorded parent boundary of ${branch} is no longer an ancestor of its tip`,
      )
    }
    if (record.parentSource === 'inferred' || !recordedParent) {
      warnings.push(
        `${branch} has no recorded parent tip; its replay boundary is inferred from the merge base and reviewed above`,
      )
    }
    const pr = record.pr
    if (pr?.headRepository && originFullName && pr.headRepository !== originFullName) {
      layerBlockers.push(
        `Pull request #${pr.number} is published from ${pr.headRepository}; surgery only replays branches of ${originFullName}`,
      )
    }
    let layerRemote: string | null = null
    if (pushUrl) {
      try {
        layerRemote = await remoteOid(root, pushUrl, branch)
      } catch (error) {
        // An unreadable remote tip cannot back a lease, so the layer is blocked
        // rather than planned as if the branch were unpublished.
        layerBlockers.push(`The remote tip of ${branch} could not be read: ${commandDetail(error)}`)
      }
    }
    layers.push({
      branch,
      parent: declared,
      recordedParent,
      recordedParentTip,
      oid: record.oid,
      boundary: boundary ?? '',
      boundarySource,
      commits: boundary ? await commitCount(root, boundary, record.oid) : 0,
      mergeCommits: boundary ? await mergeCommitCount(root, boundary, record.oid) : 0,
      remoteOid: layerRemote,
      remoteRelation: await remoteRelation(root, layerRemote, record.oid),
      pullRequest: pr ? pr.number : null,
      pullRequestBase: pr ? pr.base : null,
      pullRequestState: pr ? pr.state : null,
      headOid: pr ? (pr.headOid ?? null) : null,
      headRepository: pr ? (pr.headRepository ?? null) : null,
      merged: record.mergedHeadPr !== null,
      blockers: layerBlockers,
    })
  }
  const submitted = new Set(
    layers.map((layer) => layer.pullRequest).filter((number): number is number => number !== null),
  )
  const nativeStack = (githubData?.nativeStacks ?? []).find(
    (stack) => stack.open && stack.pullRequests.some((member) => submitted.has(member.number)),
  )
  const plan = planSurgery(
    {
      remote: originFullName,
      pushUrl,
      trunk,
      trunkOid,
      stack: nativeStack
        ? {
            number: nativeStack.number,
            base: nativeStack.base,
            members: nativeStack.pullRequests.map((member) => member.number),
          }
        : null,
      stackCapability: githubData?.available === true ? 'available' : 'unavailable',
      localBranches: [...records.keys()],
      layers,
    },
    request,
  )
  const stackPlan: StackPlan = {
    token: randomUUID(),
    repoPath: root,
    expiresAt: Date.now() + PLAN_TTL_MS,
    kind: 'restack',
    branch: anchor,
    trunk,
    defaultBranch,
    originUrl,
    pushUrl,
    originFullName,
    originalBranch: currentBranch,
    originalHead: currentHead,
    entries: await Promise.all(
      plan.layers
        .filter((layer) => layer.action !== 'insert')
        .map(async (layer) => {
          const facts = layers.find(
            (layerFacts) => layerFacts.branch === layer.branch,
          ) as SurgeryLayerFacts
          const record = records.get(layer.branch) as BranchRecord
          return {
            branch: layer.branch,
            parent: layer.toParent,
            parentRef: `refs/heads/${layer.toParent}`,
            // A parent this surgery creates carries the anchor tip, which is the
            // exact point its first child is replayed onto.
            parentOid:
              plan.inserted && layer.toParent === plan.inserted.branch
                ? plan.inserted.oid
                : (records.get(layer.toParent)?.oid ?? trunkOid),
            oldParent: facts.recordedParent,
            oldTip: layer.oldTip,
            boundary: layer.boundary,
            oldParentTip: facts.recordedParentTip,
            parentTipSource: layer.boundarySource,
            needsRestack: true,
            pr: record.pr,
            remoteOid: layer.remoteOid,
            upstream: await branchUpstream(root, layer.branch),
            retargetedFrom: null,
            note: '',
          }
        }),
    ),
    capturedParents: Object.fromEntries(
      layers.map((layer) => [layer.branch, layer.recordedParent]),
    ),
    capturedParentTips: Object.fromEntries(
      layers.map((layer) => [layer.branch, layer.recordedParentTip]),
    ),
    // The revalidation reads the tip of the parent this surgery will replay onto. A
    // parent this operation creates itself has no captured tip to compare, so its
    // entry is left uncompared and the cascade proves it from the journal instead.
    capturedParentOids: Object.fromEntries(
      plan.layers
        .filter((layer) => layer.action !== 'insert')
        .map((layer) => [
          layer.branch,
          plan.inserted && layer.toParent === plan.inserted.branch
            ? null
            : (records.get(layer.toParent)?.oid ?? trunkOid),
        ]),
    ),
    capturedTips: Object.fromEntries([
      ...chain.map((branch) => [branch, (records.get(branch) as BranchRecord).oid] as const),
      [trunk, trunkOid] as const,
    ]),
    capturedRemoteOids: Object.fromEntries(layers.map((layer) => [layer.branch, layer.remoteOid])),
    capturedPrs: Object.fromEntries(
      layers.map((layer) => {
        const record = records.get(layer.branch) as BranchRecord
        return [
          layer.branch,
          record.pr
            ? {
                number: record.pr.number,
                state: record.pr.state,
                base: record.pr.base,
                headOid: record.pr.headOid ?? null,
              }
            : null,
        ]
      }),
    ),
    capturedStacks: (githubData?.nativeStacks ?? [])
      .filter((stack) => stack.pullRequests.some((member) => submitted.has(member.number)))
      .map((stack) => ({
        number: stack.number,
        open: stack.open,
        base: stack.base,
        status: stack.status,
        members: stack.pullRequests.map((member) => ({ ...member })),
      })),
    capturedMergedHeads: Object.fromEntries(
      layers.map((layer) => {
        const record = records.get(layer.branch) as BranchRecord
        return [
          layer.branch,
          { pr: record.mergedHeadPr, oid: record.mergedHeadOid, commit: record.mergedCommitOid },
        ]
      }),
    ),
    // The capture reads Git and GitHub before the planner runs, and what it learned
    // about the remote belongs in the same list the person reviews.
    warnings: [...new Set([...plan.preview.warnings, ...warnings])],
    blockers: [...new Set([...plan.preview.blockers, ...blockers])],
    mergeMethods: [],
    sync: null,
    nativeStacksAvailable: githubData?.nativeStackPreviewAvailable === true,
    nativeStacksReason: githubData?.nativeStackPreviewReason ?? 'not-applicable',
    // A restack moves no pull request; it only proves the local shape GitHub
    // will read, and a surgery never merges, so either way there is no merge
    // preview to revalidate.
    revalidateRemote: true,
    merge: null,
    mergeStackNumber: null,
  }
  if (fetchFailure) stackPlan.blockers = [fetchFailure, ...stackPlan.blockers]
  return { plan, stackPlan }
}

export async function previewSurgery(
  repoPath: string,
  snapshot: RepositorySnapshot,
  request: SurgeryRequest,
): Promise<SurgeryPreview> {
  const root = await repositoryPath(repoPath)
  const { plan, stackPlan } = await captureSurgery(root, snapshot, request)
  const { preview } = plan
  surgeryPlans.set(stackPlan.token, {
    token: stackPlan.token,
    expiresAt: stackPlan.expiresAt,
    plan,
    stackPlan,
  })
  return {
    token: stackPlan.token,
    expiresAt: stackPlan.expiresAt,
    kind: preview.kind,
    branch: preview.branch,
    trunk: preview.trunk,
    order: preview.order,
    layers: preview.layers,
    forcePushes: preview.forcePushes,
    creates: preview.creates,
    retargets: preview.retargets,
    closes: preview.closes,
    nativeStack: preview.nativeStack,
    warnings: [...new Set([...preview.warnings, ...stackPlan.warnings])],
    blockers: [...new Set([...preview.blockers, ...stackPlan.blockers])],
  }
}

function takeSurgeryPlan(token: string): SurgeryRecord {
  const record = surgeryPlans.get(token)
  surgeryPlans.delete(token)
  if (!record) throw new Error('This surgery preview has expired; review the stack again')
  if (record.expiresAt < Date.now())
    throw new Error('This surgery preview has expired; review the stack again')
  return record
}

function surgeryPullRequestStep(step: SurgeryPullRequestPlan): SurgeryPullRequestStep {
  return {
    branch: step.branch,
    number: step.number,
    action: step.action,
    headRef: step.headRef,
    capturedHeadOid: step.headOid,
    fromBase: step.fromBase,
    toBase: step.toBase,
    status: 'pending',
  }
}

/**
 * Runs the remote half of a surgery: the pull request retargets, the pull
 * requests the reviewed approval asked to close, and the native stack
 * membership the new order needs. Every step re-reads GitHub before it writes,
 * marks itself complete only after a read-back, and is skipped when the
 * previewed change is already true, so a resumed run neither repeats a
 * completed step nor trusts a lost response.
 */
/**
 * The tip this surgery published for a branch, from the journal rather than from
 * GitHub: a push that landed before its response was lost records the published
 * commit, and a replayed branch records the tip the replay produced. A branch the
 * surgery never moved keeps the commit the preview captured.
 */
function expectedPullRequestHead(
  journal: StackJournal,
  step: SurgeryPullRequestStep,
): string | null {
  const pushed = journal.syncPushes?.branches.find((branch) => branch.branch === step.branch)
  if (pushed?.publishedOid) return pushed.publishedOid
  const entry = journal.entries.find((candidate) => candidate.branch === step.branch)
  if (entry?.newTip) return entry.newTip
  return step.capturedHeadOid
}

/**
 * The pull request identity this surgery may act on: the same pull request, the
 * same head ref, and the head commit this run published. Anything else moved it.
 */
function assertPullRequestIdentity(
  step: SurgeryPullRequestStep,
  current: PullRequest,
  head: string | null,
): void {
  if (current.number !== step.number) {
    throw new Error(`Surgery stopped: pull request #${step.number} is no longer that pull request`)
  }
  if (current.head !== step.headRef) {
    throw new Error(
      `Pull request #${step.number} now comes from ${current.head} instead of ${step.headRef}`,
    )
  }
  const observed = current.headOid ?? null
  if (head && observed !== head) {
    throw new Error(
      `Pull request #${step.number} head moved to ${(observed ?? 'an unknown commit').slice(0, 12)} after this surgery published ${head.slice(0, 12)}`,
    )
  }
}

/**
 * Runs the remote half of a surgery: the pull request retargets, the pull
 * requests the reviewed approval asked to close, and the native stack
 * membership the new order needs.
 *
 * Every step reads the desired state first, in full, before it writes anything.
 * A step whose write already landed is recognised from that read and marked
 * complete, so a lost response resumes instead of repeating the mutation, and a
 * step whose state is neither the reviewed pre-state nor the reviewed result is
 * refused rather than overwritten. The native stack is unstacked only while it
 * still holds exactly the membership the preview captured, and the recreated
 * stack is looked up before it is created, so a create whose response was lost
 * is adopted instead of posted twice.
 */
async function runSurgeryRemote(root: string, journal: StackJournal): Promise<string> {
  const surgery = journal.surgery
  // A local-only surgery has no published half: nothing to retarget, close, or register.
  if (!surgery || !surgery.fullName) return ''
  const [owner, name] = surgery.fullName.split('/')
  // Every remote step of one surgery speaks to the host that owns its
  // repository, resolved once so a run cannot straddle two hosts.
  const host = await repositoryHost(root)
  const parts: string[] = []
  for (const step of surgery.pullRequests) {
    const current = await getPullRequest(root, step.number)
    assertPullRequestIdentity(step, current, expectedPullRequestHead(journal, step))
    if (step.action === 'retarget') {
      if (current.state !== 'OPEN') {
        if (step.status === 'completed') {
          throw new Error(
            `Pull request #${step.number} was closed after this surgery retargeted it to ${step.toBase}`,
          )
        }
        throw new Error(`Surgery stopped on pull request #${step.number}: it is no longer open`)
      }
      // The reviewed result first: a retarget whose response was lost is already done.
      if (current.base === step.toBase) {
        if (step.status !== 'completed') {
          step.status = 'completed'
          await writeJournal(root, journal)
        }
        parts.push(`Pull request #${step.number} targets ${step.toBase}`)
        continue
      }
      if (step.status === 'completed') {
        // The step already landed, so any other base is somebody's own edit after
        // this surgery. Re-applying the reviewed base would overwrite it.
        throw new Error(
          `Pull request #${step.number} was moved to ${current.base} after this surgery retargeted it to ${step.toBase}`,
        )
      }
      if (current.base !== step.fromBase) {
        throw new Error(
          `Pull request #${step.number} changed from ${step.fromBase} to ${current.base} on GitHub`,
        )
      }
      await patchPullRequest(surgery.fullName, step.number, { base: step.toBase }, host)
      const readBack = await getPullRequest(root, step.number)
      assertPullRequestIdentity(step, readBack, expectedPullRequestHead(journal, step))
      if (readBack.state !== 'OPEN' || readBack.base !== step.toBase) {
        throw new Error(`Pull request #${step.number} did not move to ${step.toBase}`)
      }
      parts.push(`Pull request #${step.number} retargeted to ${step.toBase}`)
    } else {
      if (current.state === 'CLOSED') {
        if (step.status !== 'completed') {
          step.status = 'completed'
          await writeJournal(root, journal)
        }
        parts.push(`Pull request #${step.number} is closed`)
        continue
      }
      if (current.state === 'MERGED') {
        throw new Error(`Pull request #${step.number} merged while this surgery was running`)
      }
      if (step.status === 'completed') {
        throw new Error(`Pull request #${step.number} was reopened after this surgery closed it`)
      }
      await patchPullRequest(surgery.fullName, step.number, { state: 'closed' }, host)
      const readBack = await getPullRequest(root, step.number)
      assertPullRequestIdentity(step, readBack, expectedPullRequestHead(journal, step))
      if (readBack.state !== 'CLOSED') {
        throw new Error(`Pull request #${step.number} did not close`)
      }
      parts.push(`Closed pull request #${step.number}`)
    }
    step.status = 'completed'
    await writeJournal(root, journal)
  }
  const stack = surgery.stack
  if (!stack) return parts.length > 0 ? parts.join('. ') : ''
  if (stack.unstackStatus !== 'completed') {
    const observed = await readNativeStackMembers(owner, name, stack.stackNumber, host)
    if (observed === null && (await nativeStackStillListed(owner, name, stack.stackNumber, host))) {
      // GitHub answered the detail read and the listing differently, so this run
      // cannot tell whether the stack is gone. The journal stays: an unstack it
      // cannot prove must never be recorded as done.
      throw new Error(
        `GitHub reports native stack #${stack.stackNumber} as not found and as an open stack at the same time; resolve it on GitHub before continuing`,
      )
    }
    const dissolved = observed === null
    if (dissolved || observed.length === 0) {
      // An unstack whose response was lost left the stack empty or dissolved:
      // nothing to repeat. A 404 only counts as dissolved while the repository
      // still answers stack reads, so an unavailable stacks API stops the run
      // instead of quietly claiming the membership is gone.
      parts.push(`Native stack #${stack.stackNumber} is unstacked`)
    } else {
      if (
        observed.length !== stack.membersBefore.length ||
        observed.some((member, index) => member !== stack.membersBefore[index])
      ) {
        throw new Error(
          `Native stack #${stack.stackNumber} now holds ${observed.join(', ')} instead of the reviewed membership ${stack.membersBefore.join(', ')}`,
        )
      }
      await unstackNativeStackAction(root, surgery.fullName, stack.stackNumber)
      // GitHub either empties the stack or dissolves it, and only a merged pull
      // request survives an unstack, so the proof is that no stack still holds an
      // open member of the membership this run unstacked.
      const stacks = await listPullRequestStacks(owner, name, { host })
      const holding = stacks.find((candidate) =>
        candidate.pullRequests.some(
          (member) => stack.membersBefore.includes(member.number) && member.state !== 'MERGED',
        ),
      )
      if (holding) {
        throw new Error(
          `Native stack #${holding.number} still holds ${holding.pullRequests
            .map((member) => `#${member.number}`)
            .join(', ')} after the unstack`,
        )
      }
      parts.push(`Unstacked native stack #${stack.stackNumber}`)
    }
    stack.unstackStatus = 'completed'
    await writeJournal(root, journal)
  }
  if (stack.action === 'unstack-and-create') {
    if (stack.createStatus === 'completed') {
      // A checkpoint is a claim about GitHub, so it is re-proved on every
      // resumption rather than trusted because it was written once.
      if (stack.stackNumberAfter === null) {
        throw new Error('The journal records a completed stack registration without a stack number')
      }
      const verified = await getPullRequestStack(owner, name, stack.stackNumberAfter, { host })
      assertRegisteredStack(stack, surgery.trunk, verified, stack.stackNumberAfter)
      parts.push(`Native stack #${stack.stackNumberAfter} holds the new order`)
    } else {
      // A create whose response was lost already registered the stack. Looking it
      // up first is what keeps a resumed run from posting the same membership twice.
      const existing = await findNativeStack(owner, name, surgery.trunk, stack.members, host)
      if (existing.conflict) {
        throw new Error(
          `Another native stack now holds ${existing.conflict
            .map((number) => `#${number}`)
            .join(', ')}; this surgery registered ${stack.members.join(', ')}`,
        )
      }
      if (existing.stack) {
        assertRegisteredStack(stack, surgery.trunk, existing.stack, existing.stack.number)
        stack.stackNumberAfter = existing.stack.number
        stack.createStatus = 'completed'
        await writeJournal(root, journal)
        parts.push(`Native stack #${existing.stack.number} holds the new order`)
      } else if (stack.createRequested) {
        // The first create may still be completing on GitHub, or it may have been
        // lost entirely. Posting again risks a second stack holding the same pull
        // requests, so the run stops and keeps its journal until it can be told.
        throw new Error(
          `Native stack registration for ${stack.members
            .map((number) => `#${number}`)
            .join(
              ', ',
            )} was requested and GitHub does not list it yet, so it is not sent again; the first request may still be completing. Check GitHub, then continue.`,
        )
      } else {
        const capability = await detectNativeStacksCapability(owner, name, { host })
        if (!capability.available) {
          throw new Error(
            `GitHub cannot create native stacks for ${surgery.fullName}: ${capability.message}`,
          )
        }
        let requested = false
        let created: Awaited<ReturnType<typeof createPullRequestStack>>
        try {
          created = await createPullRequestStack(owner, name, stack.members, {
            host,
            defaultBranch: surgery.trunk,
            knownPullRequests: await Promise.all(
              stack.members.map((member) => getPullRequest(root, member)),
            ),
            beforeCreate: async () => {
              stack.createRequested = true
              await writeJournal(root, journal)
              requested = true
            },
          })
        } catch (error) {
          // Only GitHub's own answer to the create can say the request was
          // refused. A later failure says nothing about whether the create
          // landed, and clearing the intent on one would let a resume register
          // the same membership a second time.
          if (requested && definitivelyRejectedCreation(error)) {
            stack.createRequested = false
            await writeJournal(root, journal)
          }
          throw error
        }
        // The checkpoint follows the proof, never the other way round: a journal
        // that claims a registration nobody verified is worse than no journal.
        const readBack = await getPullRequestStack(owner, name, created.number, { host })
        assertRegisteredStack(stack, surgery.trunk, readBack, created.number)
        stack.createStatus = 'completed'
        stack.stackNumberAfter = created.number
        await writeJournal(root, journal)
        parts.push(`Registered native stack #${created.number} for the new order`)
      }
    }
  }
  return parts.length > 0 ? parts.join('. ') : ''
}

/**
 * Proves that a native stack really holds the membership this surgery registered,
 * on the trunk it was registered against. Every path that records or trusts that
 * registration goes through here.
 */
function assertRegisteredStack(
  stack: { members: number[] },
  trunk: string,
  observed: NativeStack,
  stackNumber: number,
): void {
  if (!observed.open) {
    throw new Error(
      `Native stack #${stackNumber} is closed instead of holding the registered order`,
    )
  }
  const held = observed.pullRequests.map((member) => member.number)
  if (observed.base !== trunk) {
    throw new Error(
      `Native stack #${stackNumber} is based on ${observed.base} instead of the registered ${trunk}`,
    )
  }
  if (held.join(',') !== stack.members.join(',')) {
    throw new Error(
      `Native stack #${stackNumber} holds ${held.join(', ')} instead of the reviewed order ${stack.members.join(', ')}`,
    )
  }
}

/**
 * Whether the repository still lists this native stack as open. It answers the one
 * question a 404 cannot: an unstack that dissolved the stack is gone, while a
 * stacks API this run cannot read is not.
 */
async function nativeStackStillListed(
  owner: string,
  repo: string,
  stackNumber: number,
  host: GitHubHostContext,
): Promise<boolean> {
  const stacks = await listPullRequestStacks(owner, repo, { host })
  return stacks.some((stack) => stack.number === stackNumber && stack.open)
}

/**
 * The members a native stack holds right now, or null once GitHub no longer has
 * that stack at all. A stack whose unstack response was lost is dissolved, and a
 * resumed run has to recognise that instead of failing on the 404.
 */
async function readNativeStackMembers(
  owner: string,
  repo: string,
  stackNumber: number,
  host: GitHubHostContext,
): Promise<number[] | null> {
  try {
    const stack = await getPullRequestStack(owner, repo, stackNumber, { host })
    return stack.pullRequests.map((member) => member.number)
  } catch (error) {
    if (error instanceof NativeStackError && error.httpStatus === 404) return null
    throw error
  }
}

/**
 * The open native stack that already holds exactly this membership, or the
 * members of a different stack that claims part of it. Anything else means this
 * surgery's create has not happened yet and may run.
 */
async function findNativeStack(
  owner: string,
  repo: string,
  trunk: string,
  members: readonly number[],
  host: GitHubHostContext,
): Promise<{ stack: NativeStack | null; conflict: number[] | null }> {
  const stacks = await listPullRequestStacks(owner, repo, { host })
  let conflict: number[] | null = null
  for (const stack of stacks) {
    // A closed stack holds nothing: only an open one can be this surgery's result.
    if (!stack.open) continue
    const observed = stack.pullRequests.map((member) => member.number)
    if (
      stack.base === trunk &&
      observed.length === members.length &&
      observed.every((number, index) => number === members[index])
    ) {
      return { stack, conflict: null }
    }
    if (observed.some((member) => members.includes(member))) {
      conflict = observed.filter((member) => members.includes(member))
    }
  }
  return { stack: null, conflict }
}

/**
 * Runs a reviewed surgery. Every fact the preview promised is re-read first,
 * the journal is written before the first ref moves, and the replay, the
 * lease-guarded pushes, the pull request changes and the native stack mutation
 * all share the restack journal, so an interrupted run keeps the original tips
 * recoverable and stops where it can be resumed or aborted.
 */
export async function runSurgery(
  repoPath: string,
  token: string,
  allowForce: boolean,
  closePullRequests: boolean,
): Promise<ActionResult> {
  const record = takeSurgeryPlan(token)
  const { plan, stackPlan } = record
  const preview = plan.preview
  if (stackPlan.blockers.length > 0) throw new Error(stackPlan.blockers.join('; '))
  if (preview.forcePushes.length > 0 && !allowForce) {
    throw new Error(
      'This surgery replaces published branch history; confirm the force push to continue',
    )
  }
  if (preview.closes.length > 0 && !closePullRequests) {
    throw new Error('This surgery closes submitted pull requests; confirm closing them to continue')
  }
  const root = await repositoryPath(repoPath)
  await ensureNoBusyOperation(root, 'change the stack')
  await ensureClean(root, 'change the stack')
  await revalidatePlan(root, stackPlan)
  const pushedLayers = plan.layers.filter((layer) => layer.push !== 'none')
  if (pushedLayers.length > 0 && !stackPlan.pushUrl) {
    throw new Error(
      pushedLayers.some((layer) => layer.push === 'force')
        ? 'A github.com origin push URL is required to replace a published branch'
        : `A github.com origin push URL is required to publish ${pushedLayers
            .map((layer) => layer.branch)
            .join(', ')} on the remote`,
    )
  }
  const id = randomUUID()
  const removed = plan.removed
  const restoreTo =
    removed && stackPlan.originalBranch === removed.branch
      ? (removed.recordedParent ?? plan.trunk)
      : stackPlan.originalBranch
  const inserted = plan.inserted
  const created: CreatedBranch[] | undefined = inserted
    ? [
        {
          branch: inserted.branch,
          oid: inserted.oid,
          parent: inserted.parent,
          parentTip:
            stackPlan.capturedTips[inserted.parent] ??
            stackPlan.capturedTips[plan.trunk] ??
            inserted.oid,
        },
      ]
    : undefined
  const journal: StackJournal = {
    version: JOURNAL_VERSION,
    kind: 'restack',
    id,
    repoPath: root,
    originalBranch: restoreTo,
    originalHead: stackPlan.originalHead,
    currentBranch: stackPlan.originalBranch,
    entries: stackPlan.entries.map((entry) => journalEntryFor(id, entry)),
    status: 'running',
    message: `Preparing ${preview.kind} of ${preview.branch}`,
    syncPushes: stackPlan.pushUrl
      ? {
          originUrl: stackPlan.originUrl ?? undefined,
          pushUrl: stackPlan.pushUrl,
          allowForce,
          branches: pushedLayers.map((layer) => ({
            branch: layer.branch,
            expectedRemoteOid: layer.remoteOid,
            force: layer.push === 'force',
            status: 'pending' as const,
            publishedOid: null,
          })),
        }
      : undefined,
    created,
    removed: removed
      ? [
          {
            branch: removed.branch,
            oldTip: removed.oid,
            oldParent: removed.recordedParent,
            oldParentTip: removed.recordedParentTip,
            backupRef: backupRefFor(id, removed.branch),
            status: 'pending' as const,
          },
        ]
      : undefined,
    // Recorded for every surgery, published or not: the journal is what a resumed
    // run reads to know this was a reviewed surgery and not an ordinary restack.
    surgery: {
      fullName: stackPlan.originFullName,
      originUrl: stackPlan.originUrl ?? undefined,
      pushUrl: stackPlan.pushUrl,
      trunk: plan.trunk,
      pullRequests: plan.pullRequests.map(surgeryPullRequestStep),
      stack: plan.stackStep
        ? {
            stackNumber: plan.stackStep.stackNumber,
            action: plan.stackStep.action,
            membersBefore: plan.stackStep.membersBefore,
            members: plan.stackStep.members,
            trunk: plan.trunk,
            unstackStatus: 'pending' as const,
            createStatus: 'pending' as const,
            createRequested: false,
            stackNumberAfter: null,
          }
        : null,
    },
  }
  await writeJournal(root, journal)
  if (journal.created) await createJournalBranches(root, journal)
  return restackJournal(root, journal, (pending) => runSurgeryRemote(root, pending))
}

async function stackContinue(repoPath: string): Promise<ActionResult> {
  const journal = await readJournal(repoPath)
  if (!journal) throw new Error('No interrupted Git Stacks operation is available')
  if (journal.status === 'aborting')
    throw new Error('Stack rollback has started; use Abort to finish it')
  if (journal.syncPushes) {
    const origin = await currentOrigin(repoPath, true)
    if (
      !origin.pushUrl ||
      origin.pushUrl !== journal.syncPushes.pushUrl ||
      (journal.syncPushes.originUrl && origin.url !== journal.syncPushes.originUrl)
    ) {
      throw new Error(
        journal.surgery
          ? 'Surgery progress is stale: the origin remote changed'
          : 'Sync progress is stale: the origin remote changed',
      )
    }
  }
  const surgeryRemote = journal.surgery
    ? (pending: StackJournal): Promise<string> => runSurgeryRemote(repoPath, pending)
    : undefined
  const active = journal.entries.find((entry) => entry.status === 'rebasing')
  if (!active) return restackJournal(repoPath, journal, surgeryRemote)
  await verifyCompletedEntries(repoPath, journal)
  await verifyEntryMetadata(repoPath, active)
  if (!(await activeRebaseState(repoPath))) {
    const tip = await resolveCommit(repoPath, `refs/heads/${active.branch}`)
    await reconcileCompletedRebase(repoPath, journal, active, tip)
    await completeEntry(repoPath, journal, active)
    return restackJournal(repoPath, journal, surgeryRemote)
  }
  await assertActiveRebase(repoPath, journal, active)
  if ((await resolveCommit(repoPath, `refs/heads/${active.branch}`)) !== active.oldTip) {
    throw new Error(
      `Branch ${active.branch} changed while the stack was paused; refusing to continue`,
    )
  }
  if ((await resolveCommit(repoPath, active.newParentRef)) !== active.newParentTip) {
    throw new Error(`Parent ${active.newParent} changed while the stack was paused`)
  }
  await requiredHeadReflogCount(repoPath)
  try {
    await runGit(
      repoPath,
      ['-c', 'rebase.updateRefs=false', '-c', 'rebase.autoStash=false', 'rebase', '--continue'],
      {
        GIT_EDITOR: 'true',
        GIT_REFLOG_ACTION: replayReflogAction(journal, active),
      },
    )
  } catch (error) {
    journal.status = (await getOperationState(repoPath)).rebase ? 'conflict' : 'uncertain'
    journal.message = `Restack remains paused on ${active.branch}: ${commandDetail(error)}`
    await writeJournal(repoPath, journal)
    throw new Error(journal.message)
  }
  await completeEntry(repoPath, journal, active)
  return restackJournal(repoPath, journal, surgeryRemote)
}

async function stackAbort(repoPath: string): Promise<ActionResult> {
  const journal = await readJournal(repoPath)
  if (!journal) throw new Error('No interrupted Git Stacks operation is available')
  const state = await getOperationState(repoPath)
  const active = journal.entries.find((entry) => entry.status === 'rebasing')
  if (state.rebase) {
    if (!active) throw new Error('An unrelated rebase is active; refusing to abort it')
    await assertActiveRebase(repoPath, journal, active)
  } else if (state.busy) {
    throw new Error('Another Git operation is still in progress')
  } else {
    await ensureClean(repoPath, 'abort the stack')
    if (active) {
      const tip = await resolveCommit(repoPath, `refs/heads/${active.branch}`)
      if (tip && tip !== active.oldTip) {
        await reconcileCompletedRebase(repoPath, journal, active, tip)
      }
    }
  }
  for (const entry of journal.entries) {
    const tip = await resolveCommit(repoPath, `refs/heads/${entry.branch}`)
    if (tip !== entry.oldTip && (!entry.newTip || tip !== entry.newTip)) {
      throw new Error(`Refusing to restore ${entry.branch}: its tip changed outside Git Stacks`)
    }
    await verifyEntryMetadata(repoPath, entry, journal.status === 'aborting')
    await ensureNotCheckedOutElsewhere(repoPath, entry.branch)
  }
  journal.status = 'aborting'
  journal.message = 'Aborting stack restack and restoring saved branch tips'
  await writeJournal(repoPath, journal)
  if (state.rebase) await runGit(repoPath, ['rebase', '--abort'])
  await ensureClean(repoPath, 'restore saved stack branches')
  const createdNames = (journal.created ?? []).map((created) => created.branch)
  const currentBranch = await getCurrentBranch(repoPath)
  if (
    currentBranch &&
    (journal.entries.some((entry) => entry.branch === currentBranch) ||
      createdNames.includes(currentBranch))
  ) {
    await runGit(repoPath, ['switch', '--detach', 'HEAD'])
  }
  for (const entry of [...journal.entries].reverse()) {
    if (entry.status === 'restored') continue
    const tip = await resolveCommit(repoPath, `refs/heads/${entry.branch}`)
    if (tip !== entry.oldTip) {
      if (!entry.newTip || tip !== entry.newTip)
        throw new Error(`Branch ${entry.branch} changed during rollback`)
      await runGit(repoPath, [
        'update-ref',
        `refs/heads/${entry.branch}`,
        entry.oldTip,
        entry.newTip,
      ])
    }
    await verifyEntryMetadata(repoPath, entry, true)
    await restoreParentMetadata(repoPath, entry)
    entry.status = 'restored'
    await writeJournal(repoPath, journal)
  }
  for (const created of journal.created ?? []) {
    const tip = await resolveCommit(repoPath, `refs/heads/${created.branch}`)
    if (tip === null) continue
    if (tip !== created.oid)
      throw new Error(`Refusing to delete ${created.branch}: it changed outside Git Stacks`)
    await runGit(repoPath, ['update-ref', '-d', `refs/heads/${created.branch}`, created.oid])
    await tryGit(repoPath, ['config', '--remove-section', `branch.${created.branch}`])
  }
  for (const removed of journal.removed ?? []) {
    if (removed.status === 'restored') continue
    const present = await resolveCommit(repoPath, `refs/heads/${removed.branch}`)
    if (present !== null && present !== removed.oldTip) {
      throw new Error(`Refusing to restore ${removed.branch}: the branch exists again`)
    }
    // The branch this surgery removed is deliberately left in place until every
    // replay and remote step has finished, so an abort that arrives earlier finds
    // it at the tip it started from. That is the restored state already, and an
    // abort interrupted between restoring the ref and recording it lands here too.
    if (present === removed.oldTip) {
      await restoreRemovedMetadata(repoPath, removed)
      removed.status = 'restored'
      await writeJournal(repoPath, journal)
      continue
    }
    const backup = await resolveCommit(repoPath, removed.backupRef)
    if (backup !== removed.oldTip)
      throw new Error(`Refusing to restore ${removed.branch}: its recovery ref was lost`)
    await ensureNotCheckedOutElsewhere(repoPath, removed.branch)
    await runGit(repoPath, ['update-ref', `refs/heads/${removed.branch}`, backup, ''])
    await restoreRemovedMetadata(repoPath, removed)
    removed.status = 'restored'
    await writeJournal(repoPath, journal)
  }
  await restoreCheckout(repoPath, journal.originalBranch, journal.originalHead)
  await deleteBackups(repoPath, journal)
  await removeJournal(repoPath)
  // Abort restores this repository and nothing else. What already reached GitHub
  // stands, so the recovery report names it rather than implying it was undone.
  const applied = appliedRemoteState(journal)
  return {
    message:
      'Aborted the stack restack and restored the original branch tips' +
      (applied.length > 0
        ? `. GitHub keeps the changes already applied: ${applied.join('. ')}`
        : ''),
  }
}

/**
 * The GitHub changes a run had already made when it was aborted. Git Stacks has no
 * supported way to take a retarget, a close, or a native stack membership back, so
 * the truth about them outlives the journal: this is what the recovery report says
 * stands on GitHub.
 */
function appliedRemoteState(journal: StackJournal): string[] {
  const surgery = journal.surgery
  if (!surgery) return []
  const applied: string[] = []
  for (const step of surgery.pullRequests) {
    if (step.status !== 'completed') continue
    applied.push(
      step.action === 'retarget'
        ? `pull request #${step.number} targets ${step.toBase}`
        : `pull request #${step.number} is closed`,
    )
  }
  const stack = surgery.stack
  if (stack?.unstackStatus === 'completed') {
    applied.push(
      stack.createStatus === 'completed' && stack.stackNumberAfter !== null
        ? `native stack #${stack.stackNumber} was unstacked and #${stack.stackNumberAfter} holds the new order`
        : `native stack #${stack.stackNumber} was unstacked`,
    )
  }
  return applied
}

/** Puts the parent metadata a removed branch carried before the surgery took it. */
async function restoreRemovedMetadata(
  repoPath: string,
  removed: { branch: string; oldParent: string | null; oldParentTip: string | null },
): Promise<void> {
  if (removed.oldParent)
    await setConfig(repoPath, `branch.${removed.branch}.parent`, removed.oldParent)
  else await unsetConfig(repoPath, `branch.${removed.branch}.parent`)
  if (removed.oldParentTip)
    await setConfig(repoPath, `branch.${removed.branch}.parentTip`, removed.oldParentTip)
  else await unsetConfig(repoPath, `branch.${removed.branch}.parentTip`)
}

async function currentOrigin(
  repoPath: string,
  includePushUrl = false,
): Promise<{
  url: string
  fullName: string
  pushUrl: string | null
  /** The host that owns this repository; every request for it goes there. */
  host: GitHubHostContext
}> {
  const url = await getOriginUrl(repoPath)
  const remote = parseRemote(url)
  const host = remoteHostContext(remote)
  if (!url || !remote || !host) {
    throw new Error(
      `A GitHub origin remote is required; this repository's origin is on ${remote ? remote.host : 'no host'}`,
    )
  }
  let pushUrl: string | null = null
  if (includePushUrl) pushUrl = await getRemotePushUrl(repoPath, 'origin')
  return { url, fullName: remote.fullName, pushUrl, host }
}

/**
 * The host that owns the repository being operated on. Every GitHub request a
 * stack operation makes is addressed to this host, so a repository on another
 * GitHub host is never answered by github.com and the reverse never happens.
 */
async function repositoryHost(repoPath: string): Promise<GitHubHostContext> {
  const remote = parseRemote(await getOriginUrl(repoPath))
  const host = remoteHostContext(remote)
  if (!host) {
    throw new NativeStackError(
      'preview-unavailable',
      `This operation requires a GitHub origin remote; the origin is on ${remote ? remote.host : 'no host'}`,
    )
  }
  return host
}

async function repositoryMergeMethods(
  fullName: string,
  host: GitHubHostContext,
): Promise<('merge' | 'squash' | 'rebase')[] | null> {
  try {
    const { data } = await hostTransport(host).rest<Record<string, unknown>>({
      path: `repos/${fullName}`,
    })
    if (!isRecord(data)) return null
    const methods: ('merge' | 'squash' | 'rebase')[] = []
    if (data.allow_merge_commit === true) methods.push('merge')
    if (data.allow_squash_merge === true) methods.push('squash')
    if (data.allow_rebase_merge === true) methods.push('rebase')
    return methods
  } catch {
    return null
  }
}

async function setPullRequestNumber(
  repoPath: string,
  branch: string,
  number: number,
): Promise<void> {
  await setConfig(repoPath, `branch.${branch}.gitStacksPr`, String(number))
  await unsetConfig(repoPath, `branch.${branch}.gitStacksMergedHeadPr`)
  await unsetConfig(repoPath, `branch.${branch}.gitStacksMergedHeadOid`)
  await unsetConfig(repoPath, `branch.${branch}.gitStacksMergedCommitOid`)
}

async function canonicalPullRequests(
  repoPath: string,
): Promise<{ data: GitHubResult; fullName: string }> {
  const origin = await currentOrigin(repoPath)
  const data = await getGitHubData(repoPath, origin.url)
  if (!data.available) throw new Error(data.message)
  return { data, fullName: origin.fullName }
}

/** What GitHub itself checks when a merge request is submitted. */
function mergeLayerBlockers(pr: PullRequest, base: string, head: string): string[] {
  const blockers: string[] = []
  if (pr.state !== 'OPEN') blockers.push(`Pull request #${pr.number} is not open`)
  if (pr.base !== base) blockers.push(`Pull request #${pr.number} is not based on ${base}`)
  if (!pr.headOid || pr.headOid !== head)
    blockers.push(`Pull request #${pr.number} head does not match the reviewed local tip`)
  if (pr.draft) blockers.push(`Pull request #${pr.number} is still a draft`)
  return blockers
}

/**
 * What only a direct merge has to satisfy before the request is sent. GitHub evaluates
 * branch protection and repository rules when the merge actually runs, so these are
 * reported as a failure of that run rather than a reason to refuse the request now; a
 * merge-queue merge is where those rules are meant to be evaluated.
 */
function directMergeGates(pr: PullRequest): string[] {
  const gates: string[] = []
  if (pr.checks === 'pending' || pr.checks === 'failing')
    gates.push(`Pull request #${pr.number} checks are ${pr.checks}`)
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.reviewDecision === 'REVIEW_REQUIRED') {
    gates.push(`Pull request #${pr.number} still requires review approval`)
  }
  if (pr.mergeState?.toUpperCase() !== 'CLEAN')
    gates.push(`Pull request #${pr.number} is not mergeable (${pr.mergeState || 'unknown'})`)
  return gates
}

/**
 * The contiguous unmerged portion of the stack at and below `selected`: every layer whose
 * base is the branch beneath it, down to `trunk`. Merging the top pull request of
 * a stack lands the layers below it, so they are all part of the review. A layer with no
 * canonical open pull request ends the walk and is reported rather than merged across.
 * `trunk` is the branch the stack actually hangs from — a native stack registered
 * against a release line hangs from that line, not from the repository default.
 */
function contiguousMergeChain(
  entries: PlanEntry[],
  selected: PlanEntry,
  trunk: string,
): { layers: PlanEntry[]; blockers: string[] } {
  const byBranch = new Map(entries.map((entry) => [entry.branch, entry]))
  const blockers: string[] = []
  const layers: PlanEntry[] = [selected]
  let current = selected
  while (current.parent !== trunk) {
    const parent = byBranch.get(current.parent)
    if (!parent) {
      blockers.push(
        `Branch ${current.parent} is between ${current.branch} and ${trunk} but is not an unmerged stack layer`,
      )
      break
    }
    if (!parent.pr) {
      blockers.push(
        `Branch ${parent.branch} has no canonical pull request, so the stack below ${selected.branch} cannot merge as one operation`,
      )
      break
    }
    if (parent.pr.state !== 'OPEN') {
      blockers.push(
        `Pull request #${parent.pr.number} is not open and breaks the stack below ${selected.branch}`,
      )
      break
    }
    layers.unshift(parent)
    current = parent
  }
  return { layers, blockers }
}

/**
 * Re-read submitted stack membership at the mutation boundary, in both directions. GitHub
 * decides which pull requests a request for a stacked pull request lands, so what it reports
 * now has to match what the review covered: a pull request inserted below the selection would
 * otherwise land unreviewed, a removed one would leave the reviewed downstack unmerged, and a
 * locally chained pull request attached to a native stack would silently switch to stack
 * semantics and land whatever joined it.
 */
function revalidateMergeMembership(merge: MergePreview, data: GitHubResult): void {
  const selected = merge.layers[merge.layers.length - 1]
  const membershipOf = (number: number) =>
    data.pullRequests.find((pr) => pr.number === number)?.stack ?? null
  if (!merge.native) {
    for (const layer of merge.layers) {
      const membership = membershipOf(layer.pullRequest)
      if (!membership) continue
      throw new Error(
        `Pull request #${layer.pullRequest} now belongs to native stack #${membership.stackNumber}, so GitHub would land its unreviewed downstack with it; reload the preview before merging`,
      )
    }
    return
  }
  const membership = membershipOf(selected.pullRequest)
  const stack = data.nativeStacks?.find((candidate) => candidate.number === membership?.stackNumber)
  const reviewed = merge.layers.map((layer) => layer.pullRequest)
  const downstack = stack
    ? stack.pullRequests
        .filter((member) => member.position <= (membership?.position ?? 0))
        .filter((member) => member.state === 'OPEN')
        .map((member) => member.number)
    : []
  const changed = (what: string): never => {
    throw new Error(
      `Native stack #${membership?.stackNumber ?? '?'} ${what}; reload the preview before merging`,
    )
  }
  if (!membership) changed(`no longer holds pull request #${selected.pullRequest}`)
  if (!stack) changed('is no longer available')
  if (stack && !stack.open) changed('is now closed')
  if (stack && stack.base !== merge.layers[0].base) {
    changed(`merges into ${stack.base}, not ${merge.layers[0].base}`)
  }
  if (downstack.join(',') !== reviewed.join(',')) {
    changed(
      `now lands pull requests ${downstack.map((n) => `#${n}`).join(', ')}, not the reviewed ${reviewed.map((n) => `#${n}`).join(', ')}`,
    )
  }
}

/**
 * Record one accepted request against every pull request it covers, so its result is readable
 * again after a refresh, a reopened dialog, or a restart.
 *
 * A terminal result is recorded even when GitHub returned no UUID: the documented `200` for a
 * pull request that is already merged or already queued answers with the result alone, and
 * that result and the base ref it was accepted for are the only evidence the queue exists.
 */
async function recordMergeRequest(
  repoPath: string,
  input: {
    /** Null when GitHub reported a terminal result without an identity to read it through. */
    request: { pullRequest: number; uuid: string } | null
    layers: MergeLayerPreview[]
    action: MergeAction
    method: MergeMethod | null
    outcome: MergeRequestOutcome
    enqueuedAt: number | null
    message: string | null
    requestedAt: number
  },
): Promise<void> {
  for (const layer of input.layers) {
    await recordMergeObservation(repoPath, {
      pullRequest: layer.pullRequest,
      branch: layer.branch,
      base: layer.base,
      headOid: layer.headOid,
      action: input.action,
      method: input.method,
      request: input.request,
      enqueuedAt: input.enqueuedAt,
      requestedAt: input.requestedAt,
      outcome: input.outcome,
      message: input.message,
      // A new request is new evidence: whatever a previous request's read confirmed does not
      // describe this one.
      confirmed: null,
    })
  }
}

/**
 * Build the reviewed merge for a contiguous chain, and refuse one GitHub would not land the
 * same way. A submitted native stack is merged by GitHub as a single request for its top
 * pull request, so its own membership has to be exactly the reviewed layers; a locally
 * chained stack is merged one request per layer instead.
 */
function mergePreviewFor(
  layers: PlanEntry[],
  selected: PullRequest,
  nativeStacks: NativeStack[],
  queueConfigured: boolean,
  blockers: string[],
  warnings: string[],
): MergePreview | null {
  const membership = selected.stack ?? null
  const actions: MergeAction[] = queueConfigured
    ? ['default', 'merge_queue', 'direct_merge']
    : ['default', 'direct_merge']
  if (!queueConfigured) {
    warnings.push(
      `No merge queue has answered for ${selected.base} in this repository yet, so this preview offers a direct merge or the repository default. Choosing the merge queue still works: GitHub reports whether it accepted it.`,
    )
  }
  const layerNumbers = layers.map((entry) => entry.pr?.number ?? 0)
  if (!membership) {
    for (const entry of layers) {
      if (entry.pr?.stack) {
        blockers.push(
          `Pull request #${entry.pr.number} belongs to native stack #${entry.pr.stack.stackNumber}, but the selected pull request does not; publish the stack before merging`,
        )
        return null
      }
    }
    return {
      branch: selected.head,
      layers: layers.map((entry) => ({
        branch: entry.branch,
        pullRequest: entry.pr?.number ?? 0,
        base: entry.parent,
        headOid: entry.pr?.headOid ?? '',
        // Nothing submitted links these pull requests, so each one is merged from its own
        // request, bottom-to-top. Only the selected pull request is its own request.
        includedInRequest: entry.branch === selected.head,
      })),
      native: false,
      actions,
    }
  }
  const stack = nativeStacks.find((candidate) => candidate.number === membership.stackNumber)
  if (!stack) {
    blockers.push(
      `Native stack #${membership.stackNumber} is not available; reload the stack preview before merging`,
    )
    return null
  }
  if (!stack.open) {
    blockers.push(
      `Native stack #${stack.number} is closed; reload the stack preview before merging`,
    )
    return null
  }
  const downstack = stack.pullRequests
    .filter((member) => member.position <= membership.position && member.state === 'OPEN')
    .map((member) => member.number)
  const missing = downstack.filter((number) => !layerNumbers.includes(number))
  if (missing.length > 0) {
    blockers.push(
      `Native stack #${stack.number} also lands pull request ${missing.map((n) => `#${n}`).join(', ')}, which is not a reviewed local layer; publish or reconcile the stack first`,
    )
    return null
  }
  const extra = layerNumbers.filter((number) => !downstack.includes(number))
  if (extra.length > 0) {
    blockers.push(
      `Pull request ${extra.map((n) => `#${n}`).join(', ')} sits below the selected pull request but is not part of native stack #${stack.number}; publish the stack before merging`,
    )
    return null
  }
  if (stack.base !== layers[0].parent) {
    blockers.push(
      `Native stack #${stack.number} merges into ${stack.base}, but the reviewed layers merge into ${layers[0].parent}`,
    )
    return null
  }
  return {
    branch: selected.head,
    layers: layers.map((entry) => ({
      branch: entry.branch,
      pullRequest: entry.pr?.number ?? 0,
      base: entry.parent,
      headOid: entry.pr?.headOid ?? '',
      // One request for the selected pull request lands every downstack layer of a
      // submitted stack, so each layer below it is part of that request's outcome.
      includedInRequest: true,
    })),
    native: true,
    actions,
  }
}

async function exactPrForBranch(branch: string, data: GitHubResult): Promise<PullRequest | null> {
  const matches = data.pullRequests.filter(
    (pr, index) => pr.head === branch && data.sameRepository(index),
  )
  const open = matches.filter((pr) => pr.state === 'OPEN')
  if (open.length > 1)
    throw new Error(`Multiple canonical pull requests target local branch ${branch}`)
  if (open.length === 1) return open[0]
  if (matches.length > 1)
    throw new Error(
      `Multiple historical pull requests target local branch ${branch}; select the recorded PR explicitly`,
    )
  return matches[0] ?? null
}

function matchesCapturedPullRequest(entry: PlanEntry, currentPr: PullRequest | null): boolean {
  if (!entry.pr) return currentPr === null
  if (!currentPr || currentPr.state !== 'OPEN') return false
  return (
    currentPr.number === entry.pr.number &&
    currentPr.head === entry.pr.head &&
    currentPr.headOid === entry.pr.headOid &&
    currentPr.base === entry.pr.base
  )
}

async function withLocalBranchRefLock<T>(
  repoPath: string,
  branch: string,
  action: () => Promise<T>,
): Promise<T> {
  const refStorage = await getConfigValue(repoPath, 'extensions.refstorage')
  let refRoot: string | null = null
  if (refStorage && refStorage.toLowerCase() !== 'files') {
    try {
      refRoot = localFilesRefStoragePath(refStorage)
    } catch {
      throw new Error(`Cannot safely publish ${branch} with ref storage ${refStorage}`)
    }
  }
  const refPathValue = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-path', `refs/heads/${branch}`]),
  )
  if (!refPathValue) throw new Error(`Cannot locate the local ref for ${branch}`)
  const lockPath = `${gitPathOnDisk(repoPath, refPathValue, refRoot)}.lock`
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  const locksDir = path.resolve(repoPath, commonDir, 'git-stacks-branch-locks')
  await fs.mkdir(locksDir, { recursive: true })

  const transactionId = randomUUID()
  const lockJournalPath = path.join(locksDir, `${transactionId}.json`)
  const lockInfo: BranchLockInfo = {
    pid: process.pid,
    branch,
    lockPath,
    createdAt: Date.now(),
    transactionId,
  }
  const tempJournal = `${lockJournalPath}.${randomUUID()}.tmp`
  const journalHandle = await fs.open(tempJournal, 'wx', 0o600)
  try {
    await journalHandle.writeFile(JSON.stringify(lockInfo), 'utf8')
    await journalHandle.sync()
  } finally {
    await journalHandle.close()
  }
  await fs.rename(tempJournal, lockJournalPath)

  let lock: FileHandle | null = null
  try {
    lock = await fs.open(lockPath, 'wx', 0o666)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const recovered = await tryRecoverStaleBranchLock(repoPath, lockPath, branch)
      if (recovered) {
        try {
          lock = await fs.open(lockPath, 'wx', 0o666)
        } catch (err) {
          await fs.unlink(lockJournalPath).catch(() => {})
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Cannot publish ${branch}: its local branch ref is being updated`)
          }
          throw err
        }
      } else {
        await fs.unlink(lockJournalPath).catch(() => {})
        throw new Error(`Cannot publish ${branch}: its local branch ref is being updated`)
      }
    } else {
      await fs.unlink(lockJournalPath).catch(() => {})
      throw error
    }
  }

  try {
    await lock!.writeFile(JSON.stringify(lockInfo), 'utf8')
    await lock!.sync()
    const lockIdentity = await lock!.stat()
    try {
      return await action()
    } finally {
      try {
        const current = await fs.lstat(lockPath)
        if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
          await fs.unlink(lockPath)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  } finally {
    await fs.unlink(lockJournalPath).catch(() => {})
    await lock?.close().catch(() => {})
  }
}

export async function pushBranch(
  repoPath: string,
  branch: string,
  oid: string,
  capturedRemoteOid: string | null,
  allowForce: boolean,
  pushUrl: string,
): Promise<string> {
  return withLocalBranchRefLock(repoPath, branch, async () => {
    const upstream = await branchUpstream(repoPath, branch)
    if (upstream && upstream !== `origin/${branch}`) {
      throw new Error(`Branch ${branch} has a non-origin or renamed upstream (${upstream})`)
    }
    const local = await resolveCommit(repoPath, `refs/heads/${branch}`)
    if (!local) throw new Error(`Branch ${branch} no longer exists`)
    if (local !== oid) throw new Error(`Stack preview is stale: local ${branch} changed`)
    const remote = await remoteOid(repoPath, pushUrl, branch)
    if (remote !== capturedRemoteOid)
      throw new Error(`Stack preview is stale: remote ${branch} changed`)
    if (remote === local) {
      await setConfig(repoPath, `branch.${branch}.remote`, 'origin')
      await setConfig(repoPath, `branch.${branch}.merge`, `refs/heads/${branch}`)
      return local
    }
    const nonFastForward = remote !== null && !(await isAncestor(repoPath, remote, local))
    if (nonFastForward && !allowForce) {
      throw new Error(`Publishing ${branch} requires explicit force-with-lease permission`)
    }
    if (nonFastForward) {
      if (!capturedRemoteOid) throw new Error(`Remote ${branch} changed; force lease refused`)
      await runGit(repoPath, [
        '-c',
        'push.followTags=false',
        'push',
        '--no-mirror',
        `--force-with-lease=refs/heads/${branch}:${capturedRemoteOid}`,
        'origin',
        `${oid}:refs/heads/${branch}`,
      ])
    } else {
      await runGit(repoPath, [
        '-c',
        'push.followTags=false',
        'push',
        '--no-force',
        '--no-mirror',
        'origin',
        `${oid}:refs/heads/${branch}`,
      ])
    }
    await setConfig(repoPath, `branch.${branch}.remote`, 'origin')
    await setConfig(repoPath, `branch.${branch}.merge`, `refs/heads/${branch}`)
    return local
  })
}

/** Return the assigned identity without treating a rejected POST as evidence of ownership. */
async function createPullRequest(
  fullName: string,
  layer: PublishLayer,
  host: GitHubHostContext,
): Promise<number> {
  const { data } = await hostTransport(host).rest<Record<string, unknown>>({
    method: 'POST',
    path: `repos/${fullName}/pulls`,
    body: {
      title: layer.title,
      head: layer.branch,
      base: layer.base,
      body: layer.body,
      draft: layer.draft,
    },
  })
  if (isRecord(data) && typeof data.number === 'number' && Number.isInteger(data.number)) {
    return data.number
  }
  throw new Error(
    `Creating the pull request for ${layer.branch} returned no number; retry this step`,
  )
}

export async function patchPullRequest(
  fullName: string,
  number: number,
  body: Record<string, unknown>,
  host: GitHubHostContext,
): Promise<void> {
  await hostTransport(host).rest({
    method: 'PATCH',
    path: `repos/${fullName}/pulls/${number}`,
    body,
  })
}

async function changePullRequestDraft(
  fullName: string,
  number: number,
  draft: boolean,
  host: GitHubHostContext,
): Promise<void> {
  const [owner, name] = fullName.split('/')
  const transport = hostTransport(host)
  const lookup = await transport.graphql<unknown>(
    'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }',
    { owner, name, number },
  )
  const repository = isRecord(lookup) ? lookup.repository : null
  const pullRequest = isRecord(repository) ? repository.pullRequest : null
  if (!isRecord(pullRequest) || typeof pullRequest.id !== 'string')
    throw new Error(`Could not identify pull request #${number} for readiness update`)
  const field = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview'
  const result = await transport.graphql<unknown>(
    `mutation($pullRequestId: ID!) { ${field}(input: {pullRequestId: $pullRequestId}) { pullRequest { id isDraft } } }`,
    { pullRequestId: pullRequest.id },
  )
  const payload = isRecord(result) ? result[field] : null
  const updated = isRecord(payload) ? payload.pullRequest : null
  if (!isRecord(updated) || updated.id !== pullRequest.id || updated.isDraft !== draft)
    throw new Error(`Pull request #${number} did not change readiness`)
}

/**
 * Runs one publish step. Every step verifies the live state it is about to
 * change and treats the intended end state as its success condition, so a step
 * that already ran — by an earlier attempt, or by hand on GitHub — completes
 * without a second write.
 */
async function runPublishStep(
  repoPath: string,
  operation: PublishOperation,
  step: PublishStep,
): Promise<string> {
  if (step.kind === 'push') {
    const facts = factsOf(operation, step.branch as string)

    const tracked = operation.layers.find((layer) => layer.branch === facts.branch)
    if (tracked) {
      const current = await exactPrForBranch(
        facts.branch,
        (await canonicalPullRequests(repoPath)).data,
      )
      if ((current?.number ?? null) !== tracked.pullRequest) {
        throw new Error(
          `Pull request for ${facts.branch} changed during publication; inspect the published branches before retrying`,
        )
      }
      // Until retargeting, either the reviewed original base or the approved target is valid.
      if (
        current &&
        (current.state !== 'OPEN' ||
          (current.base !== tracked.base &&
            (!tracked.updateBase || current.base !== facts.pullRequestBase)))
      ) {
        throw new Error(
          `Pull request for ${facts.branch} changed during publication; inspect the published branches before retrying`,
        )
      }
    }
    const local = await resolveCommit(repoPath, `refs/heads/${facts.branch}`)
    if (local !== facts.oid) {
      throw new Error(`Stack preview is stale: local ${facts.branch} changed`)
    }
    const remote = await remoteOid(repoPath, operation.pushUrl, facts.branch)
    if (remote === facts.oid) {
      // Finish local tracking even if the remote push succeeded before an interruption.
      // Reuse the locked no-push path so upstream conflicts and tip races still reject.
      await pushBranch(
        repoPath,
        facts.branch,
        facts.oid,
        facts.oid,
        operation.allowForce,
        operation.pushUrl,
      )
      return `Already published at ${shortOid(facts.oid)}`
    }
    if (remote !== facts.remoteOid) {
      throw new Error(`Stack preview is stale: remote ${facts.branch} changed`)
    }
    await pushBranch(
      repoPath,
      facts.branch,
      facts.oid,
      facts.remoteOid,
      operation.allowForce,
      operation.pushUrl,
    )
    // A racing close, retarget, or new pull request can land while this branch is pushed, so
    // the pull request is read back before the next layer depends on it.
    if (tracked) {
      const current = await exactPrForBranch(
        facts.branch,
        (await canonicalPullRequests(repoPath)).data,
      )
      if (
        (current?.number ?? null) !== tracked.pullRequest ||
        (current !== null &&
          (current.state !== 'OPEN' ||
            (current.base !== tracked.base &&
              (!tracked.updateBase || current.base !== facts.pullRequestBase))))
      ) {
        throw new Error(
          `Pull request for ${facts.branch} changed during publication; inspect the published branches before retrying`,
        )
      }
    }
    return facts.remoteOid === null
      ? `Created ${facts.branch} on the remote at ${shortOid(facts.oid)}`
      : `Replaced ${facts.branch} on the remote with a lease on ${shortOid(facts.remoteOid)}`
  }

  if (step.kind === 'create-pr') {
    const layer = layerOf(operation, step.branch as string)
    const existing = await exactPrForBranch(
      layer.branch,
      await canonicalPullRequests(repoPath).then((result) => result.data),
    )
    if (layer.pullRequest !== null && existing?.number !== layer.pullRequest) {
      throw new NativeStackError(
        'invalid-chain',
        `Recorded pull request #${layer.pullRequest} for ${layer.branch} is no longer the current pull request; take a fresh preview`,
      )
    }
    if (existing && layer.pullRequest === null && !layer.createIntent) {
      throw new Error(
        `Pull request for ${layer.branch} changed during publication; inspect the published branches before retrying`,
      )
    }
    if (existing) {
      if (existing.state !== 'OPEN' || existing.base !== layer.base) {
        throw new Error(
          `Pull request for ${layer.branch} changed during publication; inspect the published branches before retrying`,
        )
      }
      // An accepted creation is not permission to continue from a moved head. Prove
      // the journalled commit and both tips before recording adoption or running later layers.
      await provePublishedHead(
        repoPath,
        operation,
        layer,
        existing,
        layer.pullRequest ?? existing.number,
      )
      if (layer.pullRequest === null) {
        // GitHub accepted this operation's own creation and the response was lost.
        step.detail = `Recovered pull request #${existing.number} from a lost response`
      }
      layer.pullRequest = existing.number
      step.pullRequest = existing.number
      await writePublishOperation(repoPath, operation)
      await setPullRequestNumber(repoPath, layer.branch, existing.number)
      return `Adopted existing pull request #${existing.number}`
    }
    // Creation uses a branch name, not an OID. A retry skips completed pushes, so
    // prove that name still points to the reviewed commit before issuing a new request.
    const facts = factsOf(operation, layer.branch)
    const local = await resolveCommit(repoPath, `refs/heads/${facts.branch}`)
    if (local !== facts.oid) {
      throw new Error(`Stack preview is stale: local ${facts.branch} changed`)
    }
    const remote = await remoteOid(repoPath, operation.pushUrl, facts.branch)
    if (remote !== facts.oid) {
      throw new Error(`Stack preview is stale: remote ${facts.branch} changed`)
    }
    // The intent is journalled before the request leaves, so a lost response or an
    // interruption between the POST and this assignment still lets a retry recognise the
    // pull request it asked GitHub to create instead of calling it somebody else's.
    if (!layer.createIntent) {
      layer.createIntent = true
      await writePublishOperation(repoPath, operation)
    }
    let number: number
    try {
      number = await createPullRequest(operation.fullName, layer, await repositoryHost(repoPath))
    } catch (error) {
      if (definitivelyRejectedCreation(error)) {
        layer.createIntent = false
        await writePublishOperation(repoPath, operation)
      }
      throw error
    }
    layer.pullRequest = number
    step.pullRequest = number
    await writePublishOperation(repoPath, operation)
    await setPullRequestNumber(repoPath, layer.branch, number)
    const readBack = await getPullRequest(repoPath, number)
    if (
      readBack.state !== 'OPEN' ||
      readBack.base !== layer.base ||
      readBack.head !== layer.branch
    ) {
      throw new Error(
        `Pull request #${number} does not point at ${layer.branch} based on ${layer.base}`,
      )
    }
    await provePublishedHead(repoPath, operation, layer, readBack)
    return `Opened pull request #${number}${layer.draft ? ' as a draft' : ''}`
  }

  if (step.kind === 'retarget-pr') {
    const layer = layerOf(operation, step.branch as string)
    const number = layer.pullRequest
    if (number === null) throw new Error(`No pull request is recorded for ${layer.branch}`)
    const before = await getPullRequest(repoPath, number)
    if (before.state !== 'OPEN') {
      throw new Error(`Pull request #${number} is no longer open`)
    }
    if (before.base === layer.base)
      return `Pull request #${number} is already based on ${layer.base}`
    const capturedBase = factsOf(operation, layer.branch).pullRequestBase
    if (before.base !== capturedBase) {
      throw new NativeStackError(
        'invalid-chain',
        `Pull request #${number} base changed from ${capturedBase ?? 'an unknown base'} to ${before.base}; take a fresh preview`,
      )
    }
    await provePublishedHead(repoPath, operation, layer, before)
    await patchPullRequest(
      operation.fullName,
      number,
      { base: layer.base },
      await repositoryHost(repoPath),
    )
    const after = await getPullRequest(repoPath, number)
    if (after.base !== layer.base) {
      throw new Error(`Pull request #${number} did not accept base ${layer.base}`)
    }
    return `Rebased pull request #${number} onto ${layer.base}`
  }

  const [owner, name] = operation.fullName.split('/')
  const host = await repositoryHost(repoPath)
  const capability = await detectNativeStacksCapability(owner, name, { host })
  if (!capability.available) {
    // The host does not serve native stacks. Every pull request was already
    // pushed and, where needed, retargeted onto the layer below it, so the
    // chain is ordinary GitHub work that this submission has completed. Nothing
    // here registers a stack or claims GitHub grouped these pull requests.
    return `Published ordinary chained pull requests; ${host.host} does not serve native stacks`
  }
  const published = operation.layers.filter((layer) => layer.pullRequest !== null)
  if (published.length === 0) throw new Error('No published pull request is available to stack')
  // A resumed submission skips the push steps it already completed, so the journal is the only
  // record of what was reviewed. Every published pull request is proved against the tip this
  // operation intended to publish, which is what rejects an external force-push that landed
  // after those steps finished.
  await provePublishedHeads(repoPath, operation, published)
  const numbers = published.map((layer) => layer.pullRequest as number)
  const stacks = await listPullRequestStacks(owner, name, { host })
  // Extensions remain bound to the reviewed stack. Overlap can identify our own lost
  // create response only when no stack number has been saved yet.
  const matched = stacks.find((stack) =>
    operation.stackNumber !== null
      ? stack.number === operation.stackNumber
      : stack.pullRequests.some((member) => numbers.includes(member.number)),
  )
  // The preview captured exactly which native stack these pull requests belonged to, so a
  // stack created, unstack, or re-stack that lands while the layers are pushed invalidates
  // the submission instead of silently binding it to whichever stack now owns a member.
  if (operation.stackNumber !== null) {
    const captured = matched
    // A member that left the stack it was previewed in is a registration loss, whether the
    // stack was unstacked outright or the member was moved somewhere else.
    const registered = new Set(captured?.pullRequests.map((member) => member.number))
    for (const member of operation.capturedMembers) {
      if (numbers.includes(member.number) && !registered.has(member.number)) {
        throw new NativeStackError(
          'invalid-chain',
          `Pull request #${member.number} is no longer registered in native stack #${operation.stackNumber}`,
        )
      }
    }
    if (!captured || !captured.open) {
      throw new NativeStackError(
        'invalid-chain',
        `Stack preview is stale: native stack #${operation.stackNumber} was closed or removed`,
      )
    }
    // A recovery that journalled its stack number can be interrupted again before the step is
    // marked complete. The recorded stack is then this operation's own creation, and treating
    // it as a matched stack below would call it a stale preview forever. The step is already
    // done, so it stays done, but only once the native registration is proved: an open stack
    // whose members are the same open pull requests this operation published, not a closed
    // stack or one holding a pull request somebody closed in between.
    if (
      operation.stackCreateRequested === true &&
      step.kind === 'create-stack' &&
      isOwnCreatedStack(captured, numbers, published)
    ) {
      await proveRecoveredRegistration(repoPath, operation, published, captured)
      return `Recovered native stack #${captured.number} from a lost response`
    }
  } else if (matched) {
    // GitHub may have created this stack and lost the response, or the process may have stopped
    // before the completed step was marked complete. A stack that holds exactly this operation's
    // pull requests, in order, is its own work and is adopted rather than called stale.
    if (!operation.stackCreateRequested || !isOwnCreatedStack(matched, numbers, published)) {
      throw new Error(
        `Stack preview is stale: these pull requests now belong to native stack #${matched.number}`,
      )
    }
    await proveRecoveredRegistration(repoPath, operation, published, matched)
    operation.stackNumber = matched.number
    await writePublishOperation(repoPath, operation)
    return `Recovered native stack #${matched.number} from a lost response`
  }
  // The legacy comment metadata is only retired once the native stack really holds these pull
  // requests, so every successful registration path below retires it before returning.
  const retireLegacyComments = (): Promise<void> =>
    retireLegacyStackComments(
      operation.fullName,
      matched ? matched.pullRequests.map((member) => member.number).concat(numbers) : numbers,
      { host },
    )
  const known = await Promise.all(
    published.map((layer) => getPullRequest(repoPath, layer.pullRequest as number)),
  )
  if (matched) {
    if (step.kind !== 'extend-stack') {
      throw new Error(
        `Stack preview is stale: these pull requests now belong to native stack #${matched.number}`,
      )
    }
    const registered = new Set(matched.pullRequests.map((member) => member.number))
    const toAdd = numbers.filter((number) => !registered.has(number))
    // The already-registered pull requests were read back before the stack listing, so a
    // force-push, retarget, or unstack landing while the target is chosen cannot extend
    // the stack from a base that no longer exists.
    const registration = await revalidatePublishedStackRegistration(
      owner,
      name,
      matched,
      known.filter((pr) => registered.has(pr.number)),
      { host },
    )
    if (!registration.valid) {
      // The typed status is carried through so callers branch on the failure, not its wording.
      throw new NativeStackError(
        registration.status,
        registration.message ?? 'Published pull requests are not registered',
      )
    }
    // The registration check re-reads the members concurrently, so a force-push, retarget, or
    // unstack that lands part-way through that batch leaves at least one stale reading behind.
    // Every already-registered member is therefore read once more, one at a time and only after
    // every call that could expose drift, and compared to the head the stack still records.
    // This runs even when there is nothing to append, because a drifted member invalidates the
    // submission either way.
    const baseline = new Map(operation.capturedMembers.map((member) => [member.number, member]))
    for (const member of matched.pullRequests) {
      if (!numbers.includes(member.number)) continue
      const captured = baseline.get(member.number)
      // A member this submission pushed is expected to have moved; every other member must
      // still carry the exact head the preview recorded.
      const fresh = await getPullRequest(repoPath, member.number)
      if (fresh.state !== 'OPEN') {
        throw new NativeStackError(
          'invalid-chain',
          `Pull request #${member.number} is no longer open`,
        )
      }
      // A layer this submission approved for a base change legitimately differs from what the
      // stack still records until its retarget step runs; any other base difference is drift.
      const layer = operation.layers.find((item) => item.pullRequest === member.number)
      if (layer && !layer.updateBase && fresh.base !== member.base) {
        throw new NativeStackError(
          'invalid-chain',
          `Pull request #${member.number} base changed from ${member.base} to ${fresh.base}`,
        )
      }
      // A branch this submission pushed on purpose has legitimately moved; only a member this
      // submission did not touch has to still carry the head the preview recorded.
      const pushedByThisSubmission = operation.branches.some(
        (facts) => facts.branch === layer?.branch && facts.remoteOid !== facts.oid,
      )
      if (
        !pushedByThisSubmission &&
        captured?.headSha &&
        fresh.headOid &&
        captured.headSha !== fresh.headOid
      ) {
        throw new NativeStackError(
          'invalid-chain',
          `Pull request #${member.number} head moved to ${fresh.headOid} since it was captured; refresh the stack preview`,
        )
      }
    }
    // The heads are proved again here, against the journal rather than against the most
    // recent reading, because the most recent reading is exactly what may have moved. This
    // runs before the no-add return too: an already-registered stack is still this
    // submission's result, so a member moved after the first proof still invalidates it.
    const atBoundary = await Promise.all(
      published.map((layer) => getPullRequest(repoPath, layer.pullRequest as number)),
    )
    proveJournalledHeads(operation, published, atBoundary)
    if (toAdd.length === 0) {
      await retireLegacyComments()
      return `Stack #${matched.number} already holds all ${numbers.length} pull requests`
    }
    await addPullRequestsToStack(owner, name, matched.number, toAdd, {
      host,
      existingStack: matched,
      knownPullRequests: atBoundary,
    })
    await retireLegacyComments()
    return `Extended stack #${matched.number} with pull requests ${toAdd.join(', ')}`
  }
  if (step.kind !== 'create-stack') {
    throw new Error('Stack preview is stale: the native stack it extended is no longer registered')
  }
  // Same boundary proof as the extend path: the journal is the truth, not the most recent read.
  const atBoundary = await Promise.all(
    published.map((layer) => getPullRequest(repoPath, layer.pullRequest as number)),
  )
  proveJournalledHeads(operation, published, atBoundary)
  let requested = false
  try {
    await createPullRequestStack(owner, name, numbers, {
      host,
      knownPullRequests: atBoundary,
      defaultBranch: operation.defaultBranch,
      beforeCreate: async () => {
        operation.stackCreateRequested = true
        await writePublishOperation(repoPath, operation)
        requested = true
      },
    })
  } catch (error) {
    if (requested && definitivelyRejectedCreation(error)) {
      operation.stackCreateRequested = false
      await writePublishOperation(repoPath, operation)
    }
    throw error
  }
  await retireLegacyComments()
  return `Registered native stack for pull requests ${numbers.join(', ')}`
}

/**
 * Proves a recovered stack is still this submission's usable result before it is called
 * done. The stack listing is a snapshot, so three things are checked against the journal and
 * against a fresh read rather than against the listing: the pull requests are still open,
 * they still carry the commits and branches this operation published, and the stack still
 * registers them. A listing that said open and a pull request that closed behind it, or a
 * head that moved after the first proof, both pass every comparison inside the listing and
 * fail here.
 */
async function proveRecoveredRegistration(
  repoPath: string,
  operation: PublishOperation,
  published: readonly PublishLayer[],
  stack: NativeStack,
): Promise<void> {
  const members = await Promise.all(
    stack.pullRequests.map((member) => getPullRequest(repoPath, member.number)),
  )
  for (const pr of members) {
    if (pr.state !== 'OPEN') {
      throw new NativeStackError(
        pr.state === 'MERGED' ? 'completed' : 'closed',
        `Pull request #${pr.number} is ${pr.state.toLowerCase()}, so the recovered stack is not usable`,
      )
    }
  }
  // The journal is the only immutable record of what was reviewed, so it is what the fresh
  // reading is compared against rather than the listing this same step just took.
  for (const layer of published) {
    const pr = members.find((candidate) => candidate.number === layer.pullRequest)
    const intended = operation.branches.find((facts) => facts.branch === layer.branch)
    if (
      !pr ||
      !intended ||
      pr.headRepository?.toLowerCase() !== operation.fullName.toLowerCase() ||
      pr.head !== layer.branch ||
      pr.base !== layer.base ||
      pr.headOid !== intended.oid
    ) {
      throw new NativeStackError(
        'invalid-chain',
        `Pull request #${layer.pullRequest} no longer matches what this submission published; refresh the stack preview`,
      )
    }
  }
  const [owner, name] = operation.fullName.split('/')
  const currentStack = await getPullRequestStack(owner, name, stack.number, {
    host: await repositoryHost(repoPath),
  })
  if (
    !isOwnCreatedStack(
      currentStack,
      published.map((layer) => layer.pullRequest as number),
      published,
    )
  ) {
    throw new NativeStackError('invalid-chain', 'Recovered native stack membership changed')
  }
  const registration = await revalidatePublishedStackRegistration(
    owner,
    name,
    currentStack,
    members,
    { host: await repositoryHost(repoPath) },
  )
  if (!registration.valid) {
    throw new NativeStackError(
      registration.status,
      registration.message ?? 'Recovered native stack is not a valid registration',
    )
  }
  await provePublishedHeads(repoPath, operation, published)
}

/**
 * Walks the ordered steps and persists after every transition, so an interrupted
 * submission resumes at the first unfinished step instead of pushing a branch or
 * opening a pull request twice.
 */
async function runPublishSteps(
  repoPath: string,
  operation: PublishOperation,
): Promise<ActionResult> {
  operation.status = 'running'
  await writePublishOperation(repoPath, operation)
  for (const step of operation.steps) {
    if (step.status === 'completed') continue
    step.status = 'running'
    step.failure = null
    await writePublishOperation(repoPath, operation)
    try {
      // A completed lower layer is not rerun on Resume. Prove its published identity and
      // tips before any later step can mutate another branch or pull request.
      for (const layer of operation.layers) {
        if (layer.pullRequest === null || layer.branch === step.branch) continue
        if (
          !operation.steps.some(
            (prior) =>
              prior.branch === layer.branch &&
              prior.kind === 'push' &&
              prior.status === 'completed',
          )
        )
          continue
        const pr = await getPullRequest(repoPath, layer.pullRequest)
        if (pr.base !== layer.base) {
          throw new Error(`Pull request #${layer.pullRequest} for ${layer.branch} changed base`)
        }
        await provePublishedHead(repoPath, operation, layer, pr)
      }
      step.detail = await runPublishStep(repoPath, operation, step)
      step.status = 'completed'
      step.failure = null
    } catch (error) {
      step.status = 'failed'
      step.failure = publishFailure(step, error)
      operation.status = 'failed'
      operation.message = step.failure.summary
      await writePublishOperation(repoPath, operation)
      // A typed failure keeps its class and status so callers can branch on it; its message
      // already carries the recovery text for the reader.
      if (error instanceof NativeStackError) throw error
      throw new Error(`${step.failure.summary} ${step.failure.recovery}`)
    }
    await writePublishOperation(repoPath, operation)
  }
  const pullRequests = operation.layers.filter((layer) => layer.pullRequest !== null).length
  operation.status = 'completed'
  operation.message = `Submitted ${operation.layers.length} stack layer${
    operation.layers.length === 1 ? '' : 's'
  } with ${pullRequests} pull request${pullRequests === 1 ? '' : 's'}`
  await writePublishOperation(repoPath, operation)
  return { message: operation.message }
}

/** Whether the host answered that it does not serve the native stacks resource. */
function confirmedNoNativeStacks(reason: NativeStackCapabilityReason | 'not-applicable'): boolean {
  return reason === 'endpoint-missing' || reason === 'not-applicable'
}

/**
 * Whether this failure is the host refusing the stacks resource itself.
 *
 * The read path turns that refusal into its own unavailability error, so the
 * status it carries is what decides — and only that status. Every other
 * unavailability, whatever its cause, is this build's own answer not having
 * arrived, and is raised rather than read as confirmation.
 */
function stacksResourceAbsent(error: unknown): boolean {
  if (error instanceof NativeStackError) return error.httpStatus === 404
  return (
    error instanceof GitHubTransportError &&
    (error.status === 404 || error.kind === 'not-found' || error.kind === 'unsupported')
  )
}

/**
 * Proves the native stack the preview recorded still exists and still holds exactly the
 * pull requests it listed, before a single branch is pushed. A stack closed, unstacked, or
 * re-stacked between the preview and the submission invalidates it: the reviewed object
 * set no longer matches what GitHub would be mutated with.
 */
async function proveCapturedStackMembership(
  plan: StackPlan,
  operation: PublishOperation,
): Promise<void> {
  const numbers = operation.layers
    .map((layer) => layer.pullRequest)
    .filter((number): number is number => number !== null)
  const [owner, name] = operation.fullName.split('/')
  let stacks: NativeStack[]
  try {
    stacks = await listPullRequestStacks(owner, name, {
      host: await repositoryHost(plan.repoPath),
    })
  } catch (error) {
    // A preview made against a host that refused the resource is still current
    // when that host refuses it again, so an ordinary chain proceeds. Every
    // other failure is this build's own answer not having arrived, and it is
    // raised rather than read as confirmation.
    if (confirmedNoNativeStacks(plan.nativeStacksReason) && stacksResourceAbsent(error)) return
    throw error
  }
  if (operation.stackNumber === null) {
    // The listing just answered, so the host serves native stacked pull requests
    // for this repository now. A preview that planned an ordinary chain was made
    // before anything established that, and executing it would publish pull
    // requests this host expects to be registered in a stack.
    if (!plan.nativeStacksAvailable) {
      throw new Error(
        `Stack preview is stale: this host now answers for native stacks on this repository, so the preview must be reviewed again`,
      )
    }
    const owned = stacks.find((stack) =>
      stack.pullRequests.some((member) => numbers.includes(member.number)),
    )
    if (owned) {
      throw new Error(
        `Stack preview is stale: these pull requests now belong to native stack #${owned.number}`,
      )
    }
    return
  }
  const captured = plan.capturedStacks.find((stack) => stack.number === operation.stackNumber)
  if (!captured) {
    throw new Error(
      `Stack preview is stale: native stack #${operation.stackNumber} is no longer available`,
    )
  }
  const live = stacks.find((stack) => stack.number === operation.stackNumber)
  if (!live) {
    throw new Error(
      `Stack preview is stale: native stack #${operation.stackNumber} was closed or removed`,
    )
  }
  if (!live.open) {
    throw new Error(
      `Stack preview is stale: native stack #${live.number} is a closed stack #${live.number}`,
    )
  }
  // Only the members the preview already recorded have to still be there. The layers this
  // submission appends are expected to be absent.
  const members = new Set(live.pullRequests.map((member) => member.number))
  for (const member of captured.members) {
    if (!numbers.includes(member.number)) continue
    if (!members.has(member.number)) {
      throw new Error(
        `Stack preview is stale: pull request #${member.number} left native stack #${live.number}`,
      )
    }
  }
}

/**
 * Whether this submission was planned as an ordinary chain, because the host
 * refused the native stacks resource.
 *
 * The journal records the answer for an operation this build created. One
 * written before the answer was recorded has no stack to extend and none to
 * create, which is exactly the shape an ordinary chain leaves behind, so it is
 * proved as one rather than assumed to be a native submission.
 */
function plannedAsOrdinaryChain(operation: PublishOperation): boolean {
  if (typeof operation.nativeStacksAvailable === 'boolean') {
    return !operation.nativeStacksAvailable
  }
  return operation.stackNumber === null && operation.stackAction === 'none'
}

/**
 * Confirms the host still refuses the native stacks resource before a resume
 * publishes anything else. A refusal is the only answer that lets an ordinary
 * chain continue; a listing that answers means the host serves native stacks
 * now, and the preview has to be taken and reviewed again. Any other failure is
 * this build's own answer not having arrived, and is raised rather than read as
 * confirmation — the same rule the first submission's proof follows.
 */
async function reproveOrdinaryChain(root: string, operation: PublishOperation): Promise<void> {
  if (!plannedAsOrdinaryChain(operation)) return
  const [owner, name] = operation.fullName.split('/')
  try {
    await listPullRequestStacks(owner, name, { host: await repositoryHost(root) })
  } catch (error) {
    if (stacksResourceAbsent(error)) return
    throw error
  }
  throw new Error(
    `Stack preview is stale: this host now answers for native stacks on this repository, so the preview must be reviewed again`,
  )
}

async function runSubmitStack(
  repoPath: string,
  plan: StackPlan,
  action: Extract<SubmitStackAction, { type: 'submitStack' }>,
): Promise<ActionResult> {
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '))
  const origin = await currentOrigin(repoPath, true)
  if (origin.url !== plan.originUrl || origin.pushUrl !== plan.pushUrl) {
    throw new Error('Stack preview is stale: origin fetch or push URL changed')
  }
  if (!plan.pushUrl || !plan.originFullName) {
    throw new Error('A single origin push URL on the repository GitHub host is required')
  }
  await ensureNoBusyOperation(repoPath, 'submit the stack')
  await ensureClean(repoPath, 'submit the stack')
  await revalidatePlan(repoPath, plan)
  const unfinished = await readPublishOperation(plan.repoPath)
  if (unfinished && unfinished.status !== 'completed') {
    throw new Error(
      'Finish or dismiss the Submit Stack operation already in progress before starting another',
    )
  }
  if (unfinished) await removePublishOperation(plan.repoPath)
  const preflight = await canonicalPullRequests(repoPath)
  for (const entry of plan.entries) {
    const currentPr = await exactPrForBranch(entry.branch, preflight.data)
    if (!matchesCapturedPullRequest(entry, currentPr)) {
      throw new Error(`Stack preview is stale: pull request for ${entry.branch} changed`)
    }
  }
  const operation = await buildPublishOperation(plan.repoPath, plan, action)
  // The proof runs for every repository this build recognises as a GitHub one,
  // including a host that refused the stacks resource when the preview was made:
  // a host that started serving it since then must be caught before anything is
  // published. A repository whose origin is not a GitHub host has nothing to
  // prove, and its publish is already blocked for that reason.
  if (plan.nativeStacksReason !== 'not-applicable') {
    await proveCapturedStackMembership(plan, operation)
  }
  await writePublishOperation(plan.repoPath, operation)
  return runPublishSteps(plan.repoPath, operation)
}

async function retrySubmitStack(repoPath: string): Promise<ActionResult> {
  const root = await repositoryPath(repoPath)
  const operation = await readPublishOperation(root)
  if (!operation) throw new Error('There is no Submit Stack operation to resume')
  if (operation.status === 'completed') {
    throw new Error('That Submit Stack operation already finished every step')
  }
  const blocked = operation.steps.find(
    (step) => step.status !== 'completed' && step.failure?.retryable === false,
  )
  if (blocked) {
    throw new Error(
      `${blocked.failure!.summary} This submission cannot be resumed; dismiss it and take a fresh preview. ${blocked.failure!.recovery}`,
    )
  }
  const origin = await currentOrigin(root, true)
  if (origin.url !== operation.originUrl || origin.pushUrl !== operation.pushUrl) {
    throw new Error('Submit progress is stale: the origin remote changed')
  }
  await ensureNoBusyOperation(root, 'resume the stack submission')
  await ensureClean(root, 'resume the stack submission')
  // The proof the first submission made is made again here, before the resume
  // can push a branch or open a pull request. A host that refused the stacks
  // resource when the preview was taken may serve it now, and an ordinary chain
  // resumed on such a host would publish pull requests it expects to be
  // registered in a stack, from a preview nobody reviewed against that.
  if (operation.steps.some((step) => step.status !== 'completed')) {
    await reproveOrdinaryChain(root, operation)
  }
  // A step that stopped mid-write is retried from its beginning; every step treats
  // its intended end state as success, so no push or pull request is applied twice.
  for (const step of operation.steps) {
    if (step.status === 'failed' || step.status === 'running') {
      step.status = 'pending'
      step.failure = null
    }
  }
  return runPublishSteps(root, operation)
}

export async function getSubmitStackProgress(repoPath: string): Promise<PublishProgress | null> {
  const root = await repositoryPath(repoPath)
  const operation = await readPublishOperation(root)
  return operation ? publishProgressOf(operation) : null
}

async function dismissSubmitStack(repoPath: string): Promise<ActionResult> {
  const root = await repositoryPath(repoPath)
  const operation = await readPublishOperation(root)
  if (!operation) return { message: 'There is no Submit Stack operation to dismiss' }
  await removePublishOperation(root)
  return {
    message: `Dismissed the submission of ${operation.layers.length} layer${
      operation.layers.length === 1 ? '' : 's'
    }; published branches and pull requests stay on GitHub`,
  }
}

type MergeProgressListener = (progress: MergeProgress | null) => void

const mergeProgressListeners = new Set<MergeProgressListener>()

/**
 * Subscribes to the running merge's progress. A merge waits on GitHub's background result
 * for as long as the stack takes, and the renderer cannot poll for it: the read would queue
 * behind the very action that is producing the state.
 */
export function onMergeProgress(listener: MergeProgressListener): () => void {
  mergeProgressListeners.add(listener)
  return () => {
    mergeProgressListeners.delete(listener)
  }
}

function publishMergeProgress(progress: MergeProgress | null): void {
  for (const listener of mergeProgressListeners) listener(progress)
}

/**
 * Read back what GitHub now reports for merge requests this client made earlier. Nothing is
 * submitted: an accepted request that never reported a terminal result is read through its
 * own UUID, and a queued pull request is read from the pull request itself, which is the only
 * later signal GitHub publishes. This is what a refresh and a reopened dialog show, so a
 * queue outcome survives without asking for another merge.
 */
export async function getMergeStatus(repoPath: string): Promise<MergeStatus | null> {
  const root = await repositoryPath(repoPath)
  const observations = await readMergeObservations(root)
  if (observations.size === 0) return null
  const originUrl = await getOriginUrl(root)
  const fullName = canonicalRemoteName(originUrl)
  if (!fullName) return null
  // A resumed request is read from the host that accepted it, not from whichever
  // host a hostless transport would default to.
  const host = await repositoryHost(root)
  const journalled = [...observations.values()].sort(
    (left, right) => left.pullRequest - right.pullRequest,
  )
  // One request covers every layer it carried, so its result is read once, from the endpoint
  // that owns it, and applied to all of them.
  const requests = new Map<
    string,
    { request: { pullRequest: number; uuid: string }; layers: number[] }
  >()
  for (const observation of journalled) {
    if (!observation.request || observation.outcome !== 'pending') continue
    const key = `${observation.request.pullRequest}:${observation.request.uuid}`
    const group = requests.get(key) ?? { request: observation.request, layers: [] }
    group.layers.push(observation.pullRequest)
    requests.set(key, group)
  }
  const reported = new Map<string, AsyncMergeResult>()
  for (const [key, group] of requests) {
    const result = await readMergeRequest({ fullName, request: group.request, host })
    if (result) reported.set(key, result)
  }
  const layers: MergeLayerResult[] = []
  for (const observation of journalled) {
    const key = observation.request
      ? `${observation.request.pullRequest}:${observation.request.uuid}`
      : null
    const result = key ? reported.get(key) : undefined
    const live = await getPullRequest(root, observation.pullRequest).catch(() => null)
    // One effective observation: what the request now says, the enqueue evidence that
    // carries, and the pull request's own state as this read observed it. It is both what is
    // persisted and what is reported, so a result and the state derived from it cannot
    // disagree, and a read that cannot reach GitHub keeps what an earlier read confirmed.
    const enqueuedAt =
      result?.status === 'enqueued' ? observation.requestedAt : observation.enqueuedAt
    const confirmed: MergeQueueObservation['confirmed'] =
      live?.state === 'MERGED'
        ? 'merged'
        : live?.state === 'CLOSED'
          ? 'dropped'
          : observation.confirmed
    const effective: MergeQueueObservation = {
      ...observation,
      outcome: result ? result.status : observation.outcome,
      enqueuedAt,
      confirmed,
      message: result ? (result.message ?? observation.message) : observation.message,
    }
    if (
      (result && result.status !== 'pending') ||
      effective.enqueuedAt !== observation.enqueuedAt ||
      effective.confirmed !== observation.confirmed
    ) {
      await recordMergeObservation(root, effective)
    }
    const queue = mergeQueueState(
      effective.enqueuedAt === null ? undefined : effective,
      live?.state ?? '',
    )
    layers.push({
      branch: observation.branch,
      pullRequest: observation.pullRequest,
      status:
        live?.state === 'MERGED' ||
        effective.confirmed === 'merged' ||
        effective.outcome === 'merged'
          ? 'merged'
          : queue?.outcome === 'dropped'
            ? 'not-merged'
            : effective.outcome === 'enqueued'
              ? 'enqueued'
              : effective.outcome === 'failed'
                ? 'failed'
                : 'pending',
      detail: mergeStatusDetail(effective, queue, result?.mergeOid ?? live?.mergeOid ?? null, live),
      mergedOid: result?.mergeOid ?? live?.mergeOid ?? null,
      queue,
      requestUuid: observation.request?.uuid ?? null,
    })
  }
  return { layers, message: mergeStatusMessage(layers) }
}

function mergeStatusDetail(
  observation: MergeQueueObservation,
  queue: MergeQueueState | null,
  mergeOid: string | null,
  live: { state: string } | null,
): string {
  const requested = new Date(observation.requestedAt).toISOString()
  const merged = mergeOid ? `Merged on GitHub as ${mergeOid.slice(0, 10)}` : 'Merged on GitHub'
  let detail: string
  if (queue?.outcome === 'merged') detail = merged
  else if (queue?.outcome === 'dropped') {
    detail = 'The pull request was closed without merging, so the queue dropped it'
  } else if (queue?.outcome === 'unconfirmed') {
    detail =
      live === null
        ? `GitHub accepted this enqueue at ${requested}; current queue membership is unconfirmed`
        : `GitHub accepted this enqueue at ${requested}; this pull request is still open, which does not say whether the queue still holds it`
  } else if (observation.outcome === 'failed') {
    detail = observation.message ?? 'GitHub reported that the merge request failed'
  } else if (observation.outcome === 'merged') detail = merged
  else detail = `The merge request GitHub accepted at ${requested} has not reported a result yet`
  // This refresh could not reach the pull request. What is reported is the last state a read
  // confirmed, labelled as not re-read, because a read that failed is not evidence that
  // anything changed.
  return live === null ? `${detail} GitHub could not be read to confirm it just now.` : detail
}

function mergeStatusMessage(layers: MergeLayerResult[]): string {
  const parts: string[] = []
  const running = layers.filter((entry) => entry.status === 'pending')
  if (running.length > 0) {
    parts.push(
      `GitHub is still running the merge request for pull request${running.length === 1 ? '' : 's'} ${running.map((entry) => `#${entry.pullRequest}`).join(', ')}.`,
    )
  }
  const queued = layers.filter((entry) => entry.status === 'enqueued')
  if (queued.length > 0) {
    const numbers = queued.map((entry) => `#${entry.pullRequest}`).join(', ')
    parts.push(
      `Pull request${queued.length === 1 ? '' : 's'} ${numbers} joined the merge queue; current queue membership is unconfirmed.`,
    )
  }
  const failed = layers.filter((entry) => entry.status === 'failed')
  if (failed.length > 0) {
    parts.push(
      `GitHub refused the merge request for pull request${failed.length === 1 ? '' : 's'} ${failed.map((entry) => `#${entry.pullRequest}`).join(', ')}.`,
    )
  }
  const merged = layers.filter((entry) => entry.status === 'merged')
  if (merged.length > 0) {
    parts.push(
      `Pull request${merged.length === 1 ? '' : 's'} ${merged.map((entry) => `#${entry.pullRequest}`).join(', ')} merged.`,
    )
  }
  if (parts.length === 0) {
    parts.push('GitHub reports no further change for these merge requests.')
  }
  return parts.join(' ')
}

/** A merge commit GitHub created, as observed rather than assumed from the request. */
interface ConfirmedMerge {
  layer: MergeLayerPreview
  mergeOid: string | null
}

/**
 * The merge commit a direct or queued merge left on the stack trunk, recovered from the
 * fetched history when GitHub did not report one. A squash commit has a single parent, so
 * only a real merge commit is identifiable here.
 */
async function findMergeCommit(
  repoPath: string,
  ref: string,
  headOid: string,
): Promise<string | null> {
  try {
    const logOutput = await runGit(repoPath, ['log', '-n', '20', '--merges', '--format=%H %P', ref])
    for (const line of logOutput.split('\n')) {
      const tokens = line.trim().split(/\s+/u)
      if (tokens.length < 3) continue
      if (tokens[2] === headOid || (await isAncestor(repoPath, headOid, tokens[2]))) {
        return tokens[0]
      }
    }
  } catch {
    // Best effort recovery; a missing merge commit never blocks the recorded merge.
  }
  return null
}

function mergeResultMessage(
  results: MergeLayerResult[],
  confirmed: ConfirmedMerge[],
  remaining: MergeResult['remaining'],
  note: string | null,
): string {
  const numbers = confirmed.map((entry) => `#${entry.layer.pullRequest}`)
  const parts: string[] = []
  if (numbers.length > 0) {
    parts.push(
      `Merged pull request${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')} on GitHub.`,
    )
  }
  const queued = results.find((entry) => entry.status === 'enqueued')
  if (queued) {
    parts.push(
      `Pull request #${queued.pullRequest} joined the merge queue, which merges it later. That result is final for the request, so refresh to read the queue state.`,
    )
  }
  const running = results.find((entry) => entry.status === 'pending' && entry.requestUuid)
  if (running) {
    parts.push(
      `GitHub is still running the merge request for pull request #${running.pullRequest}; refresh to read its result.`,
    )
  }
  const failed = results.find((entry) => entry.status === 'failed')
  if (failed) {
    parts.push(`GitHub refused to merge pull request #${failed.pullRequest}: ${failed.detail}`)
  }
  if (note) parts.push(note)
  const notMerged = results.filter((entry) => entry.status === 'not-merged')
  if (notMerged.length > 0 && numbers.length > 0) {
    parts.push(
      `Pull request${notMerged.length === 1 ? '' : 's'} ${notMerged
        .map((entry) => `#${entry.pullRequest}`)
        .join(', ')} did not merge.`,
    )
  }
  const skipped = results.filter((entry) => entry.status === 'not-requested')
  if (skipped.length > 0) {
    parts.push(
      `Pull request${skipped.length === 1 ? '' : 's'} ${skipped
        .map((entry) => `#${entry.pullRequest}`)
        .join(', ')} was not requested in this run.`,
    )
  }
  if (remaining.length > 0) {
    parts.push(
      `Above the merge, GitHub now bases ${remaining
        .map((entry) => `#${entry.pullRequest} on ${entry.base}`)
        .join(', ')}; restack and publish those branches to update their pull requests.`,
    )
  }
  if (parts.length === 0) parts.push(`No pull request of this stack was merged.`)
  parts.push('No local branch was changed.')
  return parts.join(' ')
}

/**
 * GitHub already holds a request this review cannot adopt, so nothing was submitted and the
 * run stops instead of reporting a merge that was never asked for.
 */
class HeldMergeRequestError extends Error {}

async function mergeStack(
  repoPath: string,
  plan: StackPlan,
  action: Extract<StackAction, { type: 'executeStack' }>,
): Promise<ActionResult> {
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '))
  const merge = plan.merge
  if (!merge || merge.layers.length === 0) {
    throw new Error('This stack has no pull request that can be merged')
  }
  const origin = await currentOrigin(repoPath)
  if (
    origin.url !== plan.originUrl ||
    origin.fullName.toLowerCase() !== plan.originFullName?.toLowerCase()
  ) {
    throw new Error('Stack preview is stale: origin changed')
  }
  await ensureNoBusyOperation(repoPath, 'merge the pull request')
  await ensureClean(repoPath, 'merge the pull request')
  await revalidatePlan(repoPath, plan)
  if (!plan.originFullName) throw new Error('A github.com origin remote is required')
  const host = await repositoryHost(repoPath)
  const requestedAction: MergeAction | undefined = action.mergeAction
  if (
    requestedAction !== 'default' &&
    requestedAction !== 'direct_merge' &&
    requestedAction !== 'merge_queue'
  ) {
    throw new Error('Choose how GitHub should land this stack: directly or through its merge queue')
  }
  const mergeAction: MergeAction = requestedAction
  if (!merge.actions.includes(mergeAction)) {
    throw new Error(
      `Merge action ${mergeAction} is not available for this repository; choose ${merge.actions.join(' or ')}`,
    )
  }
  if (mergeAction === 'direct_merge') {
    const allowedMethods = await repositoryMergeMethods(plan.originFullName, host)
    if (
      !plan.mergeMethods.includes(action.mergeMethod) ||
      !allowedMethods ||
      !allowedMethods.includes(action.mergeMethod)
    ) {
      throw new Error(`Merge method ${action.mergeMethod} is not allowed by the repository`)
    }
  }
  const data = await getGitHubData(repoPath, plan.originUrl)
  if (!data.available) throw new Error(data.message)
  for (const layer of merge.layers) {
    const canonical = await exactPrForBranch(layer.branch, data)
    if (!canonical || canonical.number !== layer.pullRequest) {
      throw new Error(
        `Pull request #${layer.pullRequest} is no longer the canonical pull request for ${layer.branch}`,
      )
    }
    if (canonical.headOid !== layer.headOid) {
      throw new Error(
        `Pull request #${layer.pullRequest} head changed since the preview; no merge was requested`,
      )
    }
  }
  revalidateMergeMembership(merge, data)
  const selected = merge.layers[merge.layers.length - 1]
  const results: MergeLayerResult[] = merge.layers.map((layer) => ({
    branch: layer.branch,
    pullRequest: layer.pullRequest,
    status: 'pending',
    detail: layer.includedInRequest
      ? 'Awaiting the merge request for this pull request'
      : 'Below the selected pull request, merged from its own request',
    mergedOid: null,
    queue: null,
    requestUuid: null,
  }))
  const resultFor = (pullRequest: number): MergeLayerResult | undefined =>
    results.find((entry) => entry.pullRequest === pullRequest)
  // A submitted stack is landed by one request for the selected pull request, downstack
  // included. A locally chained stack has nothing linking its pull requests, so each layer
  // is merged from its own request, bottom-to-top.
  const requests = merge.native ? [selected] : merge.layers
  let attempted = false
  let landed = 0
  let note: string | null = null
  const observed: AsyncMergeResult[] = []
  publishMergeProgress({
    action: mergeAction,
    status: 'running',
    layers: results,
    message: `Merging ${merge.layers.length} pull request${merge.layers.length === 1 ? '' : 's'} on GitHub`,
  })
  for (const layer of requests) {
    const result = resultFor(layer.pullRequest)
    if (!result) continue
    try {
      const current = await getPullRequest(repoPath, layer.pullRequest)
      if (current.state !== 'OPEN' || current.head !== layer.branch) {
        throw new Error(
          `Pull request #${layer.pullRequest} is ${current.state.toLowerCase()} on ${current.head} since the preview`,
        )
      }
      if (current.headOid !== layer.headOid) {
        throw new Error(
          `Pull request #${layer.pullRequest} head changed since the preview; no merge was requested for it`,
        )
      }
      if (current.base !== layer.base) {
        if (!(current.base === plan.defaultBranch && landed > 0)) {
          throw new Error(
            `Pull request #${layer.pullRequest} is based on ${current.base} instead of ${layer.base}; publish the stack so its pull requests share one base, then merge again`,
          )
        }
        // GitHub retargeted the pull request onto the branch it merged into; that is
        // observed here rather than assumed from the preview.
        result.detail = `GitHub retargeted this pull request to ${current.base}`
      }
      if (mergeAction === 'direct_merge') {
        const gates = directMergeGates(current)
        if (gates.length > 0) throw new Error(gates.join('; '))
      }
      await setPullRequestNumber(repoPath, layer.branch, layer.pullRequest)
      attempted = true
      const start = await startAsyncMerge({
        fullName: plan.originFullName,
        number: layer.pullRequest,
        sha: layer.headOid,
        mergeMethod: action.mergeMethod,
        mergeAction: mergeAction,
        // The request, its polling, and a later resume are one conversation with
        // the host the pull request was read from.
        host,
      })
      let outcome = start.result
      if (start.kind === 'conflict') {
        // GitHub already holds a merge request for this pull request. Adopting it is the
        // only safe answer, and only when it is the reviewed head with the reviewed action.
        if (outcome.expectedHeadSha && outcome.expectedHeadSha !== layer.headOid) {
          throw new HeldMergeRequestError(
            `GitHub already has a merge request for pull request #${layer.pullRequest} on head ${outcome.expectedHeadSha.slice(0, 12)}; wait for it or reload the preview`,
          )
        }
        if (outcome.mergeAction && outcome.mergeAction !== mergeAction) {
          throw new HeldMergeRequestError(
            `GitHub already has a ${outcome.mergeAction} merge request for pull request #${layer.pullRequest}; wait for it or choose ${outcome.mergeAction}`,
          )
        }
        // A direct merge's method is part of the request's identity, so an existing request
        // that lands the commits differently is not the reviewed operation and is not adopted.
        if (
          mergeAction === 'direct_merge' &&
          outcome.mergeMethod &&
          outcome.mergeMethod !== action.mergeMethod
        ) {
          throw new HeldMergeRequestError(
            `GitHub already has a ${outcome.mergeMethod} merge request for pull request #${layer.pullRequest}; wait for it or choose ${outcome.mergeMethod}`,
          )
        }
        note = `GitHub already had a merge request for pull request #${layer.pullRequest}, so no second request was sent.`
      }
      // A request only carries the pull requests it actually includes. One request for a
      // native stack includes its downstack; a request for a locally chained layer includes
      // only itself, because every other layer needs its own request.
      const carried = merge.native
        ? results.filter((entry) =>
            merge.layers.some(
              (item) => item.pullRequest === entry.pullRequest && item.includedInRequest,
            ),
          )
        : [result]
      const carriedLayers = merge.layers.filter((item) =>
        carried.some((entry) => entry.pullRequest === item.pullRequest),
      )
      const method = mergeAction === 'direct_merge' ? action.mergeMethod : null
      // The accepted request is journalled before the first read of its result, so a transport
      // error, a crash, or a restart while GitHub is still running it leaves the request
      // readable instead of losing the only identity that can report it. A request GitHub
      // reports as still running without that identity is nothing a later read can advance,
      // so it is described by this run's own result rather than journalled as pending.
      const requestedAt = Date.now()
      const request = outcome.uuid ? { pullRequest: layer.pullRequest, uuid: outcome.uuid } : null
      if (request) {
        await recordMergeRequest(repoPath, {
          request,
          layers: carriedLayers,
          action: mergeAction,
          method,
          outcome: 'pending',
          enqueuedAt: null,
          message: null,
          requestedAt,
        })
        for (const entry of carried) {
          entry.status = 'pending'
          entry.requestUuid = request.uuid
          entry.detail =
            entry.pullRequest === layer.pullRequest
              ? 'GitHub has not reported a result yet; refresh to read this request'
              : `Included in the request for #${layer.pullRequest}, still running`
        }
      }
      if (outcome.status === 'pending' && outcome.uuid) {
        outcome = await pollAsyncMerge(
          {
            fullName: plan.originFullName,
            number: layer.pullRequest,
            uuid: outcome.uuid,
            host,
          },
          {
            onUpdate: (update) => {
              result.detail = update.message ?? `GitHub reports ${update.status}`
              publishMergeProgress({
                action: mergeAction,
                status: 'running',
                layers: results,
                message: `Pull request #${layer.pullRequest}: ${result.detail}`,
              })
            },
          },
        )
      }
      observed.push(outcome)
      if (outcome.status === 'merged') {
        // Recorded with or without a request identity: the documented `200` answers a pull
        // request that is already merged with the merge commit and no UUID, and that result
        // is the whole record of it.
        await recordMergeRequest(repoPath, {
          request,
          layers: carriedLayers,
          action: mergeAction,
          method,
          outcome: 'merged',
          enqueuedAt: null,
          message: outcome.message,
          requestedAt,
        })
        for (const entry of carried) {
          entry.status = 'merged'
          entry.detail =
            entry.pullRequest === layer.pullRequest
              ? (outcome.message ?? 'Merged on GitHub')
              : `Landed by the same GitHub operation as #${layer.pullRequest}`
        }
        landed++
        continue
      }
      if (outcome.status === 'enqueued') {
        // The queue accepted the group, which is the evidence a base ref has one, and that
        // result is final: what the queue does later is read from the pull requests. An
        // immediate `200` for a pull request that is already queued carries no UUID, and is
        // recorded all the same: it is still an accepted enqueue for this base ref, and it is
        // not polled, because there is no identity to poll.
        await recordMergeRequest(repoPath, {
          request,
          layers: carriedLayers,
          action: mergeAction,
          method,
          outcome: 'enqueued',
          enqueuedAt: requestedAt,
          message: outcome.message,
          requestedAt,
        })
        for (const entry of carried) {
          entry.status = 'enqueued'
          entry.detail =
            entry.pullRequest === layer.pullRequest
              ? (outcome.message ?? 'Added to the merge queue')
              : `Added to the merge queue by the request for #${layer.pullRequest}`
        }
        break
      }
      if (outcome.status === 'failed') {
        // The refusal is kept, so a reopen reports why instead of showing a request that is
        // still running.
        await recordMergeRequest(repoPath, {
          request,
          layers: carriedLayers,
          action: mergeAction,
          method,
          outcome: 'failed',
          enqueuedAt: null,
          message: outcome.message,
          requestedAt,
        })
        result.status = 'failed'
        result.detail = outcome.message ?? 'GitHub refused the merge'
        // GitHub may still have landed part of the group it accepted, so the downstack a
        // native request carried is read back below rather than reported as unmerged.
        for (const entry of carried) {
          if (entry === result) continue
          entry.status = 'merged'
          entry.detail = `Confirmed against the request for #${layer.pullRequest}, which failed`
        }
        break
      }
      // The request was journalled before it was read, so a merge GitHub is still running ends
      // the run in that state: its outcome is read on a refresh, not guessed at here.
      result.detail = request
        ? 'GitHub has not reported a result yet; refresh to read this request'
        : 'GitHub accepted the merge request but reported no result to read'
      if (request) {
        note = `GitHub is still running the merge request for pull request #${layer.pullRequest}; its result is read on refresh.`
      }
      break
    } catch (error) {
      if (error instanceof HeldMergeRequestError || !attempted) throw error
      result.status = 'failed'
      result.detail = commandDetail(error)
      break
    }
  }
  // GitHub's own record is the proof that a pull request landed: the head the review read
  // from legitimately advances when the pull request above it merges into that branch, so
  // the head is not re-read here. The reviewed head was already checked against GitHub at the
  // mutation boundary and sent as the request's `sha`, which cancels a moved head.
  const confirmed: ConfirmedMerge[] = []
  for (const layer of merge.layers) {
    const result = resultFor(layer.pullRequest)
    if (!result || result.status !== 'merged') continue
    const readBack = await getPullRequest(repoPath, layer.pullRequest)
    if (readBack.state !== 'MERGED') {
      result.status = 'not-merged'
      result.detail = `GitHub reports pull request #${layer.pullRequest} as ${readBack.state.toLowerCase()}, not merged`
      continue
    }
    const outcome = observed.find((entry) => entry.expectedHeadSha === layer.headOid)
    const mergeOid = readBack.mergeOid ?? outcome?.mergeOid ?? null
    confirmed.push({ layer, mergeOid })
    result.mergedOid = mergeOid
    result.detail = mergeOid ? `Merged on GitHub as ${mergeOid.slice(0, 10)}` : 'Merged on GitHub'
  }
  for (const result of results) {
    // A layer whose request GitHub is still running keeps its UUID, so its outcome is read
    // rather than guessed at. A layer this run never asked for is reported as such.
    if (result.status === 'pending' && result.requestUuid) {
      result.detail = 'GitHub has not reported a result yet; refresh to read this request'
      continue
    }
    if (result.status === 'pending') {
      result.status = 'not-requested'
      result.detail = 'Not requested in this run'
    }
  }
  const observations = await readMergeObservations(repoPath)
  for (const result of results) {
    const observation = observations.get(result.pullRequest)
    const live = await getPullRequest(repoPath, result.pullRequest).catch(() => null)
    result.queue = mergeQueueState(
      observation && observation.enqueuedAt !== null ? observation : undefined,
      live?.state ?? '',
    )
  }
  let fetchMessage = ''
  try {
    if ((await getOriginUrl(repoPath)) !== plan.originUrl) {
      throw new Error('Origin changed after the merge')
    }
    for (const branch of [plan.trunk, ...confirmed.map((entry) => entry.layer.branch)]) {
      await runGit(repoPath, [
        'fetch',
        'origin',
        `refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ])
    }
  } catch (error) {
    fetchMessage = ` Refreshing origin tracking refs failed: ${commandDetail(error)}`
  }
  for (const entry of confirmed) {
    const mergeOid =
      entry.mergeOid ??
      (await findMergeCommit(repoPath, `refs/remotes/origin/${plan.trunk}`, entry.layer.headOid))
    await writeMergedPrRecord(repoPath, {
      branch: entry.layer.branch,
      pr: entry.layer.pullRequest,
      headOid: entry.layer.headOid,
      mergeOid,
      mergedAt: Date.now(),
    })
    await setConfig(
      repoPath,
      `branch.${entry.layer.branch}.gitStacksMergedHeadPr`,
      String(entry.layer.pullRequest),
    )
    await setConfig(
      repoPath,
      `branch.${entry.layer.branch}.gitStacksMergedHeadOid`,
      entry.layer.headOid,
    )
    if (mergeOid) {
      await setConfig(repoPath, `branch.${entry.layer.branch}.gitStacksMergedCommitOid`, mergeOid)
    }
  }
  const remaining: MergeResult['remaining'] = []
  const after = await getGitHubData(repoPath, plan.originUrl)
  if (after.available) {
    const mergedBranches = new Set(confirmed.map((entry) => entry.layer.branch))
    for (const entry of plan.entries) {
      if (mergedBranches.has(entry.branch)) continue
      for (const [index, pr] of after.pullRequests.entries()) {
        if (pr.head !== entry.branch || !after.sameRepository(index)) continue
        remaining.push({
          pullRequest: pr.number,
          branch: entry.branch,
          base: pr.base,
          state: pr.state,
        })
      }
    }
  }
  const message = mergeResultMessage(results, confirmed, remaining, note) + fetchMessage
  const queued = results.some((entry) => entry.status === 'enqueued')
  const failed = results.some((entry) => entry.status === 'failed')
  // A request GitHub is still running is not a finished merge: the run ends in that state
  // because the outcome is read from the kept UUID rather than declared here.
  const running = results.some((entry) => entry.status === 'pending' && entry.requestUuid)
  publishMergeProgress({
    action: mergeAction,
    status: failed ? 'failed' : running ? 'running' : queued ? 'queued' : 'succeeded',
    layers: results,
    message,
  })
  return {
    message,
    merge: {
      action: mergeAction,
      method: action.mergeMethod,
      native: merge.native,
      layers: results,
      remaining,
    },
  }
}

async function updatePullRequest(
  repoPath: string,
  number: number,
  title: string,
  body: string,
  draft: boolean,
): Promise<ActionResult> {
  const origin = await currentOrigin(repoPath)
  const current = await getPullRequest(repoPath, number)
  if (current.state === 'MERGED') throw new Error(`Pull request #${number} is already merged`)
  await patchPullRequest(origin.fullName, number, { title, body }, origin.host)
  if (current.draft !== draft) {
    await changePullRequestDraft(origin.fullName, number, draft, origin.host)
  }
  const readBack = await getPullRequest(repoPath, number)
  if (readBack.title !== title || readBack.body !== body || readBack.draft !== draft) {
    throw new Error(`Pull request #${number} did not match the requested update`)
  }
  return { message: `Updated pull request #${number}` }
}

async function changePullRequestState(
  repoPath: string,
  number: number,
  state: 'open' | 'closed',
): Promise<ActionResult> {
  const origin = await currentOrigin(repoPath)
  const current = await getPullRequest(repoPath, number)
  if (state === 'open' && current.state === 'MERGED')
    throw new Error(`Pull request #${number} cannot be reopened after merge`)
  await patchPullRequest(origin.fullName, number, { state }, origin.host)
  const readBack = await getPullRequest(repoPath, number)
  const expected = state === 'open' ? 'OPEN' : 'CLOSED'
  if (readBack.state !== expected)
    throw new Error(`Pull request #${number} did not become ${expected.toLowerCase()}`)
  return { message: `${state === 'open' ? 'Reopened' : 'Closed'} pull request #${number}` }
}

async function setParentAction(
  repoPath: string,
  branch: string,
  parent: string,
): Promise<ActionResult> {
  const root = await repositoryPath(repoPath)
  await validateBranchName(root, branch)
  await validateBranchName(root, parent)
  await ensureNoBusyOperation(root, 'change a stack parent')
  const refs = await getRefs(root)
  const currentBranch = await getCurrentBranch(root)
  const defaultBranch = await getDefaultBranch(root, refs, currentBranch)
  if (branch === defaultBranch) throw new Error('The default branch cannot have a stack parent')
  const branchTip = await resolveCommit(root, `refs/heads/${branch}`)
  if (!branchTip) throw new Error(`Local branch ${branch} does not exist`)
  const parentRef = await resolveParentRef(root, parent)
  if (parent === branch || parentRef === `refs/heads/${branch}`)
    throw new Error('A branch cannot be its own parent')
  const originUrl = await getOriginUrl(root)
  const originFullName = canonicalRemoteName(originUrl)
  const baseByBranch = new Map<string, string>()
  if (originFullName) {
    const githubData = await getGitHubData(root, originUrl)
    if (githubData.available) {
      githubData.pullRequests.forEach((pr, index) => {
        if (githubData.sameRepository(index) && pr.base && !baseByBranch.has(pr.head)) {
          baseByBranch.set(pr.head, pr.base)
        }
      })
    }
  }
  const names = await localBranchNames(root)
  const parentMap = new Map<string, string>()
  for (const name of names) {
    const configured = await getBranchParent(root, name)
    if (configured) parentMap.set(name, configured)
    else if (name !== defaultBranch) parentMap.set(name, baseByBranch.get(name) ?? defaultBranch)
  }
  parentMap.set(branch, parent)
  let cursor: string | null = branch
  const seen = new Set<string>()
  while (cursor && cursor !== defaultBranch) {
    if (seen.has(cursor)) throw new Error('Changing this parent would create a stack cycle')
    seen.add(cursor)
    const next = parentMap.get(cursor)
    if (!next) throw new Error(`Parent metadata for ${cursor} is missing`)
    if (next !== defaultBranch && !names.includes(next))
      throw new Error(`Parent ${next} does not exist locally`)
    cursor = next
  }
  await ensureNotCheckedOutElsewhere(root, branch)
  const configuredParent = await getBranchParent(root, branch)
  const oldParent = configuredParent ?? baseByBranch.get(branch) ?? defaultBranch
  const configuredBoundary = await getConfigValue(root, `branch.${branch}.parentTip`)
  let boundary: string | null = null
  let source = 'existing parent boundary'
  if (configuredBoundary) {
    const configuredOid = await resolveCommit(root, configuredBoundary)
    if (!configuredOid || !(await isAncestor(root, configuredOid, branchTip))) {
      throw new Error(
        `Recorded parent boundary for ${branch} is invalid; refuse to infer a replacement`,
      )
    }
    boundary = configuredBoundary
  }
  if (!boundary) {
    const oldParentRef = await resolveParentRef(root, oldParent)
    const oldParentTip = await resolveCommit(root, oldParentRef)
    if (!oldParentTip) throw new Error(`Cannot resolve the old parent ${oldParent}`)
    boundary = await actualMergeBase(root, oldParentTip, branchTip)
    source = `merge-base with ${oldParent}`
    if (!boundary)
      throw new Error(`Cannot determine a safe rebase boundary from old parent ${oldParent}`)
  }
  const count = await commitCount(root, boundary, branchTip)
  await setConfig(root, `branch.${branch}.parent`, parent)
  await setConfig(root, `branch.${branch}.parentTip`, boundary)
  return { message: `Adopted ${branch} under ${parent}; preserved ${count} commits from ${source}` }
}

export async function getStackProgress(
  repoPath: string,
  signal?: AbortSignal,
): Promise<StackProgress | null> {
  const root = await repositoryPath(repoPath, signal)
  const journal = await readJournal(root, signal)
  if (signal?.aborted) throw new CommandCancelled()
  if (!journal) return null
  const completed = journal.entries
    .filter((entry) => entry.status === 'completed')
    .map((entry) => entry.branch)
  const remaining = journal.entries
    .filter((entry) => entry.status !== 'completed')
    .map((entry) => entry.branch)
  return {
    kind: journal.kind,
    originalBranch: journal.originalBranch ?? '',
    currentBranch: journal.currentBranch,
    completed,
    remaining,
    message: journal.message,
  }
}

export async function runStackAction(
  repoPath: string,
  actionValue: StackAction,
): Promise<ActionResult> {
  const root = await repositoryPath(repoPath)
  const action = validateStackAction(actionValue)
  if (
    action.type !== 'stackContinue' &&
    action.type !== 'stackAbort' &&
    (await readJournal(root))
  ) {
    throw new Error('Finish or abort the current stack operation before starting another action')
  }
  switch (action.type) {
    case 'setParent':
      return setParentAction(root, action.branch, action.parent)
    case 'stackContinue':
      return stackContinue(root)
    case 'stackAbort':
      return stackAbort(root)
    case 'executeSurgery':
      return runSurgery(root, action.token, action.allowForce, action.closePullRequests)
    case 'updatePr':
      return updatePullRequest(root, action.number, action.title, action.body, action.draft)
    case 'closePr':
      return changePullRequestState(root, action.number, 'closed')
    case 'reopenPr':
      return changePullRequestState(root, action.number, 'open')
    case 'linkIssue':
      return runLinkIssueAction(root, action)
    case 'unlinkIssue':
      return runUnlinkIssueAction(root, action)
    case 'executeStack': {
      prunePlans()
      const plan = plans.get(action.token)
      if (!plan || plan.expiresAt <= Date.now())
        throw new Error('Stack preview token is missing or expired; refresh the preview')
      if (plan.repoPath !== root) throw new Error('Stack preview belongs to a different repository')
      plans.delete(action.token)
      if (plan.kind === 'restack') return runRestackCascade(root, plan, plan.entries)
      if (plan.kind === 'sync') return runPlanSync(root, plan, action.allowForce)
      if (plan.kind === 'publish') {
        throw new Error(
          'Submit Stack replaced this preview action; take a fresh Submit Stack preview',
        )
      }
      return mergeStack(root, plan, action)
    }
    case 'submitStack': {
      prunePlans()
      const plan = plans.get(action.token)
      if (!plan || plan.expiresAt <= Date.now())
        throw new Error('Stack preview token is missing or expired; refresh the preview')
      if (plan.repoPath !== root) throw new Error('Stack preview belongs to a different repository')
      if (plan.kind !== 'publish')
        throw new Error('That preview does not describe a stack submission')
      plans.delete(action.token)
      return runSubmitStack(root, plan, action)
    }
    case 'submitStackRetry':
      return retrySubmitStack(root)
    case 'submitStackDismiss':
      return dismissSubmitStack(root)
    case 'createNativeStack': {
      const origin = await currentOrigin(root)
      const data = await getGitHubData(root, origin.url)
      const defaultBranch = await getDefaultBranch(
        root,
        await getRefs(root),
        await getCurrentBranch(root),
      )
      return createNativeStackAction(
        root,
        origin.fullName,
        action.pullRequests,
        data.pullRequests,
        defaultBranch,
      )
    }
    case 'addPullRequestsToNativeStack': {
      const origin = await currentOrigin(root)
      const data = await getGitHubData(root, origin.url)
      return addPullRequestsToNativeStackAction(
        root,
        origin.fullName,
        action.stackNumber,
        action.pullRequests,
        data.pullRequests,
      )
    }
    case 'unstackNativeStack': {
      const origin = await currentOrigin(root)
      return unstackNativeStackAction(root, origin.fullName, action.stackNumber)
    }
    case 'reconcileRepair':
      return runReconciliationRepair(root, {
        token: action.token,
        ids: action.ids,
        confirmRewrites: action.confirmRewrites,
      })
  }
}
