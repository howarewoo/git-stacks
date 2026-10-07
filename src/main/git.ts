import { spawn } from 'node:child_process'

import * as path from 'node:path'
import { constants as fsConstants, promises as fs } from 'node:fs'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type {
  ActionResult,
  Branch,
  ChangedFile,
  ConflictChoice,
  ConflictFile,
  ConflictMove,
  ConflictResolution,
  GitOperation,
  Commit,
  DiffHunk,
  FileView,
  GitAction,
  HistoryPage,
  HunkSide,
  HunkSideName,
  PullRequest,
  PushPreview,
  RepositorySnapshot,
  RepositoryIssue,
  Stash,
} from '../shared/types'
import {
  GIT_CONCURRENCY,
  MAX_DIFF_BYTES,
  MAX_FILE_BYTES,
  MAX_HISTORY_BYTES,
  SNAPSHOT_BRANCH_BUDGET,
  type SnapshotLimits,
} from '../shared/performance'
import {
  CommandCancelled,
  MAX_BRANCH_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PATH_LENGTH,
  branchUpstream,
  commandDetail,
  commandEnvironment,
  ensureClean,
  ensureNoBusyOperation,
  ensureNotCheckedOutElsewhere,
  getBranchConfigs,
  getBranchParent,
  getConfigValue,
  getCurrentBranch,
  getDefaultBranch,
  getOperationState,
  getOriginUrl,
  getRemotePushUrl,
  getRefs,
  getRemotes,
  getStashes,
  getStatus,
  isCancelled,
  isExitCode,
  listStatus,
  mapWithConcurrency,
  parseRemote,
  parseTrack,
  refExists,
  requireRefInput,
  requireString,
  readDirectParents,
  resolveParentRef,
  runGit,
  runGitCapped,
  runGitWithInput,
  statusPathCandidates,
  stripTrailingNewline,
  tryGit,
  validateBranchName,
} from './git-core'
import { isRecord } from '../shared/guards'
import type { RefRecord } from './git-core'
import { buildHunkPatch, hunkSideUnavailable, parseHunkBlock } from './hunks'
import {
  gitCommandEnvironment,
  requireGitCapability,
  resolveGitRuntime,
  withGitRuntime,
  type GitRuntimeRecord,
} from './git-runtime'
import {
  getHeadGitlinks,
  getIndexEntries,
  getRepositoryCapabilities,
  getRepositoryShapeFacts,
  detectGitLfs,
  parseLfsPointer,
} from './capabilities'
import type { IndexPathEntry } from './capabilities'
import {
  LFS_PUSH_NOTE,
  actionBlockReason,
  sparsePathReason,
  submodulePathReason,
} from '../shared/capabilities'
import {
  conflictKind,
  conflictLabels,
  conflictRegions,
  hasConflictMarkers,
  parseConflictSegments,
} from '../shared/conflict'
import {
  MERGE_TOOL_BACKENDS,
  SUPPORTED_MERGE_TOOLS,
  type SupportedMergeTool,
} from '../shared/settings'
import {
  getGitHubData,
  getGitHubIssues,
  unavailableGitHubResult,
  type GitHubResult,
} from './github'
import { hostTransport, remoteHostContext } from './github-host'
import {
  getStackProgress,
  isStackAction,
  parentTarget,
  recoverStaleBranchLocks,
  runStackAction,
  validateStackAction,
} from './stacks'
import { buildReconciliationReport } from './reconciliation'

function requireOid(value: unknown, label: string, allowNull = false): string | null {
  if (allowNull && value === null) {
    return null
  }
  const oid = requireString(value, label, 128)
  if (!/^[0-9a-f]{4,128}$/iu.test(oid)) {
    throw new Error(`${label} must be a hexadecimal Git object id`)
  }
  return oid
}
function requireHeadRef(value: unknown, label: string): string {
  if (value === 'HEAD') return value
  const ref = requireString(value, label, MAX_BRANCH_LENGTH + 'refs/heads/'.length)
  const prefix = 'refs/heads/'
  if (!ref.startsWith(prefix)) {
    throw new Error(`${label} must be HEAD or a local branch ref`)
  }
  requireRefInput(ref.slice(prefix.length), label)
  return ref
}

function repositoryPathParts(value: string): string[] {
  return value.split(path.sep === '\\' ? /[\\/]/u : /\//u)
}

function requirePathInput(value: unknown, label: string): string {
  const filePath = requireString(value, label, MAX_PATH_LENGTH)
  if (
    path.isAbsolute(filePath) ||
    repositoryPathParts(filePath).some((part) => part === '..' || part === '.')
  ) {
    throw new Error(`${label} is not a safe repository-relative path`)
  }
  return filePath
}
function requireStashRef(value: unknown): string {
  const ref = requireString(value, 'stash ref', 256)
  if (!/^stash@\{\d+\}$/u.test(ref)) {
    throw new Error('Invalid stash reference')
  }
  return ref
}

function validatePushPreview(value: unknown): PushPreview {
  if (!isRecord(value)) throw new Error('forcePush requires a push preview')
  const branch = requireRefInput(value.branch, 'preview.branch')
  const remote = requireRefInput(value.remote, 'preview.remote')
  const destination = requireString(value.destination, 'preview.destination', MAX_BRANCH_LENGTH)
  if (!destination.startsWith('refs/heads/') || destination === 'refs/heads/') {
    throw new Error('preview.destination must be a remote branch ref')
  }
  return {
    branch,
    remote,
    remoteUrl: requireString(value.remoteUrl, 'preview.remoteUrl', 4096),
    destination,
    localOid: requireOid(value.localOid, 'preview.localOid')!,
    remoteOid: requireOid(value.remoteOid, 'preview.remoteOid', true),
  }
}

function validateAction(value: unknown): GitAction {
  if (isStackAction(value)) {
    return validateStackAction(value)
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Invalid Git action payload')
  }

  switch (value.type) {
    case 'switch':
      if (value.carry !== undefined && typeof value.carry !== 'boolean')
        throw new Error('carry must be a boolean')
      return {
        type: 'switch',
        ref: requireRefInput(value.ref, 'branch ref'),
        carry: value.carry === true,
      }
    case 'createBranch':
      return {
        type: 'createBranch',
        name: requireRefInput(value.name, 'branch name'),
        parent: requireRefInput(value.parent, 'parent branch'),
      }
    case 'deleteBranch':
      if (typeof value.force !== 'boolean') throw new Error('force must be a boolean')
      return {
        type: 'deleteBranch',
        ref: requireRefInput(value.ref, 'branch ref'),
        force: value.force,
        expectedOid: requireOid(value.expectedOid, 'expectedOid')!,
      }
    case 'deleteBranches': {
      if (typeof value.force !== 'boolean') throw new Error('force must be a boolean')
      if (!Array.isArray(value.branches) || value.branches.length === 0) {
        throw new Error('deleteBranches requires one or more branches')
      }
      const branches = value.branches.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`branches[${index}] must be a branch target`)
        const ref = requireRefInput(entry.ref, `branches[${index}].ref`)
        if (!ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
          throw new Error('Only local branches can be deleted')
        }
        return {
          ref,
          expectedOid: requireOid(entry.expectedOid, `branches[${index}].expectedOid`)!,
        }
      })
      if (new Set(branches.map(({ ref }) => ref)).size !== branches.length) {
        throw new Error('branches must not contain duplicate refs')
      }
      return { type: 'deleteBranches', branches, force: value.force }
    }
    case 'stage':
    case 'unstage': {
      if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > 1000) {
        throw new Error(`${value.type} requires one or more paths`)
      }
      const paths = value.paths.map((entry, index) => requirePathInput(entry, `paths[${index}]`))
      if (new Set(paths).size !== paths.length) throw new Error('paths must not contain duplicates')
      return { type: value.type, paths }
    }
    case 'commit': {
      if (typeof value.amend !== 'boolean') throw new Error('amend must be a boolean')
      const expectedHead = requireOid(value.expectedHead, 'expectedHead', true)
      return {
        type: 'commit',
        message: requireString(value.message, 'commit message'),
        amend: value.amend,
        expectedHead,
        expectedHeadRef: requireHeadRef(value.expectedHeadRef, 'expectedHeadRef'),
      }
    }
    case 'fetch':
    case 'push':
    case 'rebaseContinue':
    case 'rebaseAbort':
    case 'operationContinue':
    case 'operationSkip':
    case 'operationAbort':
      return { type: value.type }
    case 'pull': {
      if (
        value.strategy !== 'ff-only' &&
        value.strategy !== 'merge' &&
        value.strategy !== 'rebase'
      ) {
        throw new Error('pull strategy must be ff-only, merge, or rebase')
      }
      return { type: 'pull', strategy: value.strategy }
    }
    case 'forcePush':
      return {
        type: 'forcePush',
        preview: validatePushPreview(value.preview),
      }
    case 'stash':
      if (typeof value.includeUntracked !== 'boolean') {
        throw new Error('includeUntracked must be a boolean')
      }
      if (
        typeof value.message !== 'string' ||
        value.message.length > MAX_MESSAGE_LENGTH ||
        value.message.includes('\0')
      ) {
        throw new Error('stash message must be a string without NUL bytes')
      }
      return {
        type: 'stash',
        message: value.message,
        includeUntracked: value.includeUntracked,
      }
    case 'stashPop':
    case 'stashApply':
    case 'stashDrop':
      return {
        type: value.type,
        ref: requireStashRef(value.ref),
        oid: requireOid(value.oid, 'stash oid')!,
      }
    case 'rebase':
      return { type: 'rebase', parent: requireRefInput(value.parent, 'parent branch') }
    case 'createPr':
      if (typeof value.draft !== 'boolean') throw new Error('draft must be a boolean')
      if (
        typeof value.body !== 'string' ||
        value.body.length > MAX_MESSAGE_LENGTH ||
        value.body.includes('\0')
      ) {
        throw new Error('pull request body must be a string without NUL bytes')
      }
      return {
        type: 'createPr',
        title: requireString(value.title, 'pull request title'),
        body: value.body,
        base: requireRefInput(value.base, 'pull request base'),
        draft: value.draft,
      }
    case 'renameBranch':
      return {
        type: 'renameBranch',
        ref: requireRefInput(value.ref, 'branch ref'),
        name: requireRefInput(value.name, 'branch name'),
      }
    case 'setUpstream':
      if (value.upstream !== null && typeof value.upstream !== 'string') {
        throw new Error('upstream must be a string or null')
      }
      return {
        type: 'setUpstream',
        ref: requireRefInput(value.ref, 'branch ref'),
        upstream: value.upstream === null ? null : requireRefInput(value.upstream, 'upstream ref'),
      }
    case 'merge':
      return {
        type: 'merge',
        ref: requireRefInput(value.ref, 'merge ref'),
        expectedHead: requireOid(value.expectedHead, 'expectedHead')!,
        expectedHeadRef: requireHeadRef(value.expectedHeadRef, 'expectedHeadRef'),
      }
    case 'cherryPick':
    case 'revert': {
      if (
        value.mainline !== null &&
        (typeof value.mainline !== 'number' ||
          !Number.isInteger(value.mainline) ||
          value.mainline < 1)
      ) {
        throw new Error('mainline must be a positive integer or null')
      }
      return {
        type: value.type,
        oid: requireOid(value.oid, 'commit oid')!,
        expectedHead: requireOid(value.expectedHead, 'expectedHead')!,
        expectedHeadRef: requireHeadRef(value.expectedHeadRef, 'expectedHeadRef'),
        mainline: value.mainline,
      }
    }
    case 'deleteRemoteBranch':
      return {
        type: 'deleteRemoteBranch',
        ref: requireRefInput(value.ref, 'remote branch ref'),
        expectedOid: requireOid(value.expectedOid, 'expectedOid')!,
      }
    case 'deleteRemoteBranches': {
      if (!Array.isArray(value.branches) || value.branches.length === 0) {
        throw new Error('deleteRemoteBranches requires one or more branches')
      }
      const branches = value.branches.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`branches[${index}] must be a branch target`)
        return {
          ref: requireRefInput(entry.ref, `branches[${index}].ref`),
          expectedOid: requireOid(entry.expectedOid, `branches[${index}].expectedOid`)!,
        }
      })
      if (new Set(branches.map(({ ref }) => ref)).size !== branches.length) {
        throw new Error('branches must not contain duplicate refs')
      }
      return { type: 'deleteRemoteBranches', branches }
    }
    case 'discardFile':
      return {
        type: 'discardFile',
        path: requirePathInput(value.path, 'path'),
        fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
      }
    case 'resolveConflict': {
      if (!isRecord(value.resolution) || typeof value.resolution.kind !== 'string') {
        throw new Error('resolveConflict requires a resolution')
      }
      if (value.resolution.kind === 'choice') {
        if (
          value.resolution.choice !== 'current' &&
          value.resolution.choice !== 'incoming' &&
          value.resolution.choice !== 'both' &&
          value.resolution.choice !== 'delete'
        ) {
          throw new Error('resolution choice must be current, incoming, both, or delete')
        }
        return {
          type: 'resolveConflict',
          path: requirePathInput(value.path, 'path'),
          fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
          resolution: { kind: 'choice', choice: value.resolution.choice },
        }
      }
      if (value.resolution.kind === 'worktree') {
        return {
          type: 'resolveConflict',
          path: requirePathInput(value.path, 'path'),
          fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
          resolution: { kind: 'worktree' },
        }
      }
      if (value.resolution.kind !== 'content') {
        throw new Error('resolution kind must be content, choice, or worktree')
      }
      if (
        typeof value.resolution.content !== 'string' ||
        Buffer.byteLength(value.resolution.content, 'utf8') > MAX_FILE_BYTES ||
        value.resolution.content.includes('\0')
      ) {
        throw new Error('content must be a UTF-8 string without NUL bytes')
      }
      return {
        type: 'resolveConflict',
        path: requirePathInput(value.path, 'path'),
        fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
        resolution: { kind: 'content', content: value.resolution.content },
      }
    }
    case 'conflictMergeTool':
      return {
        type: 'conflictMergeTool',
        path: requirePathInput(value.path, 'path'),
        fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
      }
    case 'stageHunk':
    case 'unstageHunk': {
      const hunkId = requireString(value.hunkId, 'hunkId', 64)
      if (!/^[0-9a-f]{16}$/u.test(hunkId)) {
        throw new Error('hunkId must be a hunk identity from the current file view')
      }
      if (value.lineIndexes !== undefined) {
        if (
          !Array.isArray(value.lineIndexes) ||
          value.lineIndexes.length === 0 ||
          value.lineIndexes.length > 10_000
        ) {
          throw new Error('lineIndexes must list the changed lines to apply')
        }
        const indexes = value.lineIndexes.map((entry) => {
          if (
            !Number.isInteger(entry) ||
            (entry as number) < 0 ||
            (entry as number) > MAX_DIFF_LINES
          ) {
            throw new Error('lineIndexes must be non-negative line positions')
          }
          return entry as number
        })
        if (new Set(indexes).size !== indexes.length) {
          throw new Error('lineIndexes must not contain duplicates')
        }
        return {
          type: value.type,
          path: requirePathInput(value.path, 'path'),
          hunkId,
          fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
          lineIndexes: indexes,
        }
      }
      return {
        type: value.type,
        path: requirePathInput(value.path, 'path'),
        hunkId,
        fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
      }
    }
    default:
      throw new Error(`Unsupported Git action: ${value.type}`)
  }
}

export async function resolveRepository(inputPath: string, signal?: AbortSignal): Promise<string> {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.includes('\0')) {
    throw new Error('Repository path must be a non-empty path')
  }

  let candidate: string
  try {
    candidate = await fs.realpath(inputPath)
  } catch {
    throw new Error(`Repository path does not exist: ${inputPath}`)
  }

  let isBare: string
  try {
    isBare = stripTrailingNewline(
      await runGit(candidate, ['rev-parse', '--is-bare-repository'], undefined, signal),
    ).trim()
  } catch (error) {
    if (isCancelled(error)) throw error
    throw new Error(`Not a Git repository: ${commandDetail(error)}`)
  }
  if (isBare === 'true') {
    // A bare repository is opened read-only; the capability matrix disables worktree actions.
    try {
      return await fs.realpath(
        stripTrailingNewline(await runGit(candidate, ['rev-parse', '--absolute-git-dir'])),
      )
    } catch {
      return candidate
    }
  }

  let topLevel: string
  try {
    topLevel = stripTrailingNewline(
      await runGit(candidate, ['rev-parse', '--show-toplevel'], undefined, signal),
    )
  } catch (error) {
    if (isCancelled(error)) throw error
    throw new Error(`Not a Git repository: ${commandDetail(error)}`)
  }
  if (!topLevel) {
    throw new Error('Not a Git repository: Git returned no working tree root')
  }

  try {
    return await fs.realpath(topLevel)
  } catch {
    throw new Error(`Git working tree root does not exist: ${topLevel}`)
  }
}

async function runStage(
  repoPath: string,
  action: 'stage' | 'unstage',
  requestedPaths: string[],
): Promise<ActionResult> {
  const files = await getStatus(repoPath)
  // Staging a path that sparse checkout left unmaterialized would record a deletion.
  const index = await getIndexEntries(repoPath, requestedPaths)
  for (const requested of requestedPaths) {
    if (index.get(requested)?.sparseExcluded) throw new Error(sparsePathReason(requested))
  }
  const paths = statusPathCandidates(files, requestedPaths, action)
  if (paths.length === 0) {
    throw new Error('No changed paths were selected')
  }
  if (action === 'stage') {
    await runGit(repoPath, ['--literal-pathspecs', 'add', '--', ...paths])
    return { message: `Staged ${paths.length} path${paths.length === 1 ? '' : 's'}` }
  }
  if (await tryGit(repoPath, ['rev-parse', '--verify', 'HEAD'])) {
    await runGit(repoPath, ['--literal-pathspecs', 'restore', '--staged', '--', ...paths])
  } else {
    await runGit(repoPath, ['--literal-pathspecs', 'rm', '--cached', '--force', '--', ...paths])
  }
  return { message: `Unstaged ${paths.length} path${paths.length === 1 ? '' : 's'}` }
}

async function currentHeadOid(repoPath: string, signal?: AbortSignal): Promise<string | null> {
  const value = await tryGit(
    repoPath,
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    signal,
  )
  return value ? stripTrailingNewline(value) : null
}

async function currentHeadRef(repoPath: string): Promise<string> {
  const ref = await tryGit(repoPath, ['symbolic-ref', '--quiet', 'HEAD'])
  return ref ? stripTrailingNewline(ref) : 'HEAD'
}

interface ExpectedHeadContext {
  oid: string | null
  ref: string
}

interface CapturedOperationHead extends ExpectedHeadContext {
  oid: string
  operation: 'merge' | 'cherryPick' | 'revert'
}

async function assertExpectedHead(
  repoPath: string,
  expectedHead: string | null,
  operation: string,
  expectedHeadRef?: string,
): Promise<void> {
  const [actual, actualRef] = await Promise.all([
    currentHeadOid(repoPath),
    currentHeadRef(repoPath),
  ])
  if (actual !== expectedHead || (expectedHeadRef !== undefined && actualRef !== expectedHeadRef)) {
    throw new Error(
      `Cannot ${operation}: HEAD changed (expected ${expectedHead ?? 'unborn'} at ${expectedHeadRef ?? 'any ref'}, found ${actual ?? 'unborn'} at ${actualRef})`,
    )
  }
}

async function installReferenceTransactionGuard(
  repoPath: string,
): Promise<{ hooksPath: string; previousHook: string | null }> {
  const configuredHooksPath = await tryGit(repoPath, [
    'config',
    '--path',
    '--get',
    'core.hooksPath',
  ])
  const previousHooksPath =
    configuredHooksPath !== null
      ? path.resolve(repoPath, stripTrailingNewline(configuredHooksPath))
      : path.resolve(
          repoPath,
          stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-path', 'hooks'])),
        )
  const hooksPath = await fs.mkdtemp(path.join(tmpdir(), 'git-stacks-head-guard-'))
  try {
    let names: string[] = []
    try {
      names = await fs.readdir(previousHooksPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    for (const name of names) {
      if (name === 'reference-transaction') continue
      const previousPath = path.join(previousHooksPath, name)
      try {
        const info = await fs.stat(previousPath)
        if (!info.isFile() && !info.isDirectory()) continue
        const copiedPath = path.join(hooksPath, name)
        if (info.isDirectory()) {
          await fs.cp(previousPath, copiedPath, { recursive: true, dereference: true })
        } else {
          await fs.copyFile(previousPath, copiedPath)
        }
        await fs.chmod(copiedPath, info.mode & 0o777)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      }
    }

    const previousHookPath = path.join(previousHooksPath, 'reference-transaction')
    let previousHook: string | null = null
    try {
      const info = await fs.stat(previousHookPath)
      if (info.isFile() && (info.mode & 0o111) !== 0) previousHook = previousHookPath
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }

    const hookPath = path.join(hooksPath, 'reference-transaction')
    await fs.writeFile(
      hookPath,
      `#!/bin/sh
input=
if [ "$1" = "prepared" ]; then
  input=$(mktemp "\${TMPDIR:-/tmp}/git-stacks-reference-transaction.XXXXXX") || exit 1
  if ! cat > "$input"; then
    rm -f "$input"
    exit 1
  fi
  matched=false
  mismatch=false
  unexpected=false
  while IFS=' ' read -r old new ref; do
    if [ "$ref" = "$GIT_STACKS_EXPECTED_HEAD_REF" ]; then
      matched=true
      if [ "$old" != "$GIT_STACKS_EXPECTED_HEAD_OLD" ]; then mismatch=true; fi
    elif [ "\${ref#refs/heads/}" != "$ref" ] || { [ "$ref" = "HEAD" ] && [ "$GIT_STACKS_EXPECTED_HEAD_REF" != "HEAD" ]; }; then
      unexpected=true
    fi
  done < "$input"
  if [ "$mismatch" = true ] || [ "$unexpected" = true ]; then
    echo "$GIT_STACKS_EXPECTED_HEAD_ERROR" >&2
    rm -f "$input"
    exit 1
  fi
  if [ "$matched" = true ]; then
    : > "$GIT_STACKS_EXPECTED_HEAD_VERIFIED" || exit 1
  fi
fi
if [ -x "$GIT_STACKS_PREVIOUS_REFERENCE_TRANSACTION" ]; then
  if [ -n "$input" ]; then
    "$GIT_STACKS_PREVIOUS_REFERENCE_TRANSACTION" "$@" < "$input"
  else
    "$GIT_STACKS_PREVIOUS_REFERENCE_TRANSACTION" "$@"
  fi
  result=$?
else
  result=0
fi
if [ -n "$input" ]; then rm -f "$input"; fi
exit "$result"
`,
      { encoding: 'utf8', mode: 0o700 },
    )
    await fs.chmod(hookPath, 0o700)
    return { hooksPath, previousHook }
  } catch (error) {
    await fs.rm(hooksPath, { recursive: true, force: true })
    throw error
  }
}

async function expectedHeadOldValue(repoPath: string, head: string | null): Promise<string> {
  if (head) return head.toLowerCase()
  const format = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--show-object-format']))
  if (format !== 'sha1' && format !== 'sha256') {
    throw new Error(`Unsupported Git object format: ${format}`)
  }
  return '0'.repeat(format === 'sha1' ? 40 : 64)
}

async function runGitWithExpectedHead(
  repoPath: string,
  args: string[],
  expected: ExpectedHeadContext,
  operation: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  await requireGitCapability('referenceTransactions', operation)
  const hooks = await installReferenceTransactionGuard(repoPath)
  const verifiedPath = path.join(hooks.hooksPath, 'expected-head-verified')
  try {
    const output = await runGit(repoPath, ['-c', `core.hooksPath=${hooks.hooksPath}`, ...args], {
      ...env,
      GIT_STACKS_EXPECTED_HEAD_REF: expected.ref,
      GIT_STACKS_EXPECTED_HEAD_OLD: await expectedHeadOldValue(repoPath, expected.oid),
      GIT_STACKS_EXPECTED_HEAD_ERROR: `Cannot ${operation}: HEAD changed since this action started`,
      GIT_STACKS_EXPECTED_HEAD_VERIFIED: verifiedPath,
      GIT_STACKS_PREVIOUS_REFERENCE_TRANSACTION: hooks.previousHook ?? '',
    })
    let headRefUpdated = false
    try {
      await fs.stat(verifiedPath)
      headRefUpdated = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!headRefUpdated) await assertExpectedHead(repoPath, expected.oid, operation, expected.ref)
    return output
  } finally {
    await fs.rm(hooks.hooksPath, { recursive: true, force: true })
  }
}

async function expectedOperationHeadPath(repoPath: string): Promise<string> {
  const value = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-path', 'git-stacks-expected-operation-head.json']),
  )
  return path.resolve(repoPath, value)
}

async function persistOperationHead(
  repoPath: string,
  expected: CapturedOperationHead,
): Promise<void> {
  const filePath = await expectedOperationHeadPath(repoPath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(expected), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

async function readOperationHead(repoPath: string): Promise<CapturedOperationHead | null> {
  const filePath = await expectedOperationHeadPath(repoPath)
  let raw: string
  try {
    const info = await fs.lstat(filePath)
    if (!info.isFile() || info.size > 4096) {
      throw new Error('The saved operation HEAD state is invalid; abort the Git operation')
    }
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('The saved operation HEAD state is unreadable; abort the Git operation')
  }
  if (
    !isRecord(value) ||
    (value.operation !== 'merge' &&
      value.operation !== 'cherryPick' &&
      value.operation !== 'revert') ||
    typeof value.oid !== 'string' ||
    !/^[0-9a-f]{40,64}$/iu.test(value.oid) ||
    typeof value.ref !== 'string' ||
    (value.ref !== 'HEAD' && !value.ref.startsWith('refs/heads/'))
  ) {
    throw new Error('The saved operation HEAD state is invalid; abort the Git operation')
  }
  return {
    operation: value.operation,
    oid: value.oid,
    ref: value.ref,
  }
}

async function clearOperationHead(repoPath: string): Promise<void> {
  await fs.rm(await expectedOperationHeadPath(repoPath), { force: true })
}

async function runCapturedOperation(
  repoPath: string,
  operation: CapturedOperationHead['operation'],
  args: string[],
  expected: CapturedOperationHead,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await persistOperationHead(repoPath, expected)
  try {
    await runGitWithExpectedHead(repoPath, args, expected, operation, env)
  } catch (error) {
    if ((await getOperationState(repoPath)).operation !== operation) {
      await clearOperationHead(repoPath)
    }
    throw error
  }
  if ((await getOperationState(repoPath)).operation !== operation) {
    await clearOperationHead(repoPath)
  }
}

async function runCommit(
  repoPath: string,
  message: string,
  amend: boolean,
  expectedHead: string | null,
  expectedHeadRef: string,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'commit')
  await assertExpectedHead(repoPath, expectedHead, 'commit', expectedHeadRef)
  const expected = { oid: expectedHead, ref: expectedHeadRef }
  const files = await getStatus(repoPath)
  if (files.some((file) => file.conflicted)) {
    throw new Error('Cannot commit while conflicts are unresolved')
  }
  if (amend) {
    const currentBranch = await getCurrentBranch(repoPath)
    const refs = await getRefs(repoPath)
    const defaultBranch = await getDefaultBranch(repoPath, refs, currentBranch)
    if (currentBranch === defaultBranch) {
      throw new Error('Amending the default branch is not allowed')
    }
    await runGitWithExpectedHead(
      repoPath,
      ['commit', '--amend', '--message', message],
      expected,
      'commit',
    )
    return { message: 'Amended the current commit' }
  }
  if (!files.some((file) => file.index !== ' ' && file.index !== '?')) {
    throw new Error('Nothing is staged to commit')
  }
  await runGitWithExpectedHead(repoPath, ['commit', '--message', message], expected, 'commit')
  return { message: 'Committed staged changes' }
}

async function runFetch(repoPath: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'fetch')
  const remotes = await getRemotes(repoPath)
  if (remotes.length === 0) {
    throw new Error('Cannot fetch: repository has no configured remotes')
  }
  await runGit(repoPath, ['fetch', '--all', '--prune'])
  return { message: 'Fetched all remotes' }
}

async function runPull(
  repoPath: string,
  strategy: 'ff-only' | 'merge' | 'rebase',
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'pull')
  await ensureClean(repoPath, 'pull')
  const currentBranch = await getCurrentBranch(repoPath)
  if (!currentBranch) throw new Error('Cannot pull while HEAD is detached')
  const upstream = await branchUpstream(repoPath, currentBranch)
  if (!upstream || upstream.startsWith('./') || upstream === '.') {
    throw new Error(
      `Branch "${currentBranch}" has no remote upstream; configure one before pulling`,
    )
  }
  const pullArgs =
    strategy === 'ff-only'
      ? ['pull', '--ff-only']
      : strategy === 'merge'
        ? ['pull', '--no-rebase', '--no-edit']
        : ['-c', 'rebase.updateRefs=false', '-c', 'rebase.autoStash=false', 'pull', '--rebase']
  await runGit(repoPath, pullArgs, strategy === 'merge' ? { GIT_EDITOR: 'true' } : undefined)
  return { message: `Pulled ${upstream} with ${strategy} strategy` }
}

interface PushTarget {
  branch: string
  remote: string
  destination: string
  explicit: boolean
}

async function getPushTarget(repoPath: string, requireExplicit: boolean): Promise<PushTarget> {
  const branch = await getCurrentBranch(repoPath)
  if (!branch) throw new Error('Cannot push while HEAD is detached')
  const remotes = await getRemotes(repoPath)
  if (remotes.length === 0) throw new Error('Cannot push: repository has no configured remotes')
  const configuredRemote = await getConfigValue(repoPath, `branch.${branch}.remote`)
  const configuredDestination = await getConfigValue(repoPath, `branch.${branch}.merge`)
  if (configuredRemote || configuredDestination) {
    if (
      !configuredRemote ||
      !remotes.includes(configuredRemote) ||
      !configuredDestination?.startsWith('refs/heads/')
    ) {
      throw new Error('Push requires a configured remote branch, not another local branch.')
    }
    return {
      branch,
      remote: configuredRemote,
      destination: configuredDestination,
      explicit: true,
    }
  }
  if (requireExplicit || !remotes.includes('origin')) {
    throw new Error(
      requireExplicit
        ? `Branch "${branch}" has no explicit remote target for force push`
        : `Branch "${branch}" has no upstream and this repository has no origin remote`,
    )
  }
  return {
    branch,
    remote: 'origin',
    destination: `refs/heads/${branch}`,
    explicit: false,
  }
}

/** The Git LFS client owns any object upload triggered by Git's push hooks. */
async function lfsPushSuffix(repoPath: string): Promise<string> {
  return (await detectGitLfs(repoPath)) ? ` ${LFS_PUSH_NOTE}` : ''
}

async function runPush(repoPath: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'push')
  const target = await getPushTarget(repoPath, false)
  const args = [
    '-c',
    'push.followTags=false',
    'push',
    '--no-force',
    '--no-mirror',
    ...(target.explicit ? [] : ['--set-upstream']),
    '--',
    target.remote,
    `refs/heads/${target.branch}:${target.destination}`,
  ]
  await runGit(repoPath, args)
  return {
    message: `Pushed ${target.branch} to ${target.remote}/${target.destination.slice('refs/heads/'.length)}${await lfsPushSuffix(repoPath)}`,
  }
}

async function getRemoteOid(
  repoPath: string,
  pushUrl: string,
  destination: string,
): Promise<string | null> {
  const output = await runGit(repoPath, ['ls-remote', '--heads', '--', pushUrl, destination])
  const value = output.trim().split(/\s+/u)[0]
  return value && /^[0-9a-f]{4,128}$/iu.test(value) ? value : null
}

async function remoteHeadDestination(repoPath: string, pushUrl: string): Promise<string | null> {
  const output = await tryGit(repoPath, ['ls-remote', '--symref', '--', pushUrl, 'HEAD'])
  if (!output) return null
  const match = output.match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD$/mu)
  return match?.[1] ?? null
}

async function runForcePush(repoPath: string, preview: PushPreview): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'force push')
  const target = await getPushTarget(repoPath, true)
  if (
    target.branch !== preview.branch ||
    target.remote !== preview.remote ||
    target.destination !== preview.destination
  ) {
    throw new Error(
      'Cannot force push: the configured push target changed; refresh before retrying',
    )
  }
  const pushUrl = await getRemotePushUrl(repoPath, target.remote)
  if (pushUrl !== preview.remoteUrl) {
    throw new Error('Cannot force push: the remote push URL changed; refresh before retrying')
  }
  const refs = await getRefs(repoPath)
  const defaultBranch = await getDefaultBranch(repoPath, refs, target.branch)
  const remoteHead = await remoteHeadDestination(repoPath, pushUrl)
  if (preview.destination === `refs/heads/${defaultBranch}` || preview.destination === remoteHead) {
    throw new Error('Force pushing the default or remote HEAD branch is not allowed')
  }
  await assertExpectedHead(repoPath, preview.localOid, 'force push')
  const actualRemoteOid = await getRemoteOid(repoPath, pushUrl, target.destination)
  if (actualRemoteOid !== preview.remoteOid) {
    throw new Error(
      `Cannot force push: remote changed (expected ${preview.remoteOid ?? 'absent'}, found ${actualRemoteOid ?? 'absent'})`,
    )
  }
  await runGit(repoPath, [
    '-c',
    'push.followTags=false',
    'push',
    `--force-with-lease=${target.destination}:${preview.remoteOid ?? ''}`,
    '--no-mirror',
    '--',
    pushUrl,
    `${preview.localOid}:${target.destination}`,
  ])
  return {
    message: `Force pushed ${target.branch} to ${target.remote}/${target.destination.slice('refs/heads/'.length)}${await lfsPushSuffix(repoPath)}`,
  }
}

async function runStash(
  repoPath: string,
  message: string,
  includeUntracked: boolean,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'stash')
  const files = await getStatus(repoPath)
  if (files.length === 0) throw new Error('Nothing to stash')
  const args = [
    'stash',
    'push',
    ...(includeUntracked ? ['--include-untracked'] : []),
    ...(message ? [`--message=${message}`] : []),
  ]
  await runGit(repoPath, args)
  return {
    message: includeUntracked
      ? 'Stashed changes, including untracked files'
      : 'Stashed tracked changes',
  }
}

interface StashDropJournalV1 {
  version: 1
  changesRef: boolean
  oldRef: string
  oldLog: string
  nextRef: string | null
  nextLog: string
  refLock: string
  logLock: string
  refLockIdentity: { dev: string; ino: string }
  logLockIdentity: { dev: string; ino: string }
}

interface StashDropJournalV2 {
  version: 2
  changesRef: boolean
  changesLooseRef: boolean
  changesPackedRefs: boolean
  oldRefExists: boolean
  oldRef: string
  oldPacked: string | null
  oldLog: string
  nextRef: string | null
  nextPacked: string | null
  nextLog: string
  refLock: string
  packedLock: string
  logLock: string
  refLockIdentity: { dev: string; ino: string }
  packedLockIdentity: { dev: string; ino: string }
  logLockIdentity: { dev: string; ino: string }
}

interface StashDropJournalV3Acquiring {
  version: 3
  phase: 'acquiring'
  transactionId: string
  ownerPid: number
  refLockIdentity: { dev: string; ino: string } | null
  packedLockIdentity: { dev: string; ino: string } | null
  logLockIdentity: { dev: string; ino: string } | null
}

type StashDropJournalV3Prepared = Omit<StashDropJournalV2, 'version'> & {
  version: 3
  phase: 'prepared'
  transactionId: string
  ownerPid: number
}

type StashDropJournalV3 = StashDropJournalV3Acquiring | StashDropJournalV3Prepared

type StashDropJournal = StashDropJournalV1 | StashDropJournalV2 | StashDropJournalV3

function encodeStashJournalBytes(value: Buffer): string {
  return value.toString('base64')
}

function decodeStashJournalBytes(value: unknown): Buffer {
  if (typeof value !== 'string') {
    throw new Error('The interrupted stash journal is invalid; refusing recovery')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) {
    throw new Error('The interrupted stash journal is invalid; refusing recovery')
  }
  return bytes
}

function validStashLockIdentity(value: unknown): value is { dev: string; ino: string } {
  return (
    isRecord(value) &&
    typeof value.dev === 'string' &&
    typeof value.ino === 'string' &&
    /^\d+$/u.test(value.dev) &&
    /^\d+$/u.test(value.ino)
  )
}

function validOptionalStashLockIdentity(
  value: unknown,
): value is { dev: string; ino: string } | null {
  return value === null || validStashLockIdentity(value)
}

function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function parseStashDropJournalV2(value: Record<string, unknown>): StashDropJournalV2 | null {
  if (
    value.version !== 2 ||
    typeof value.changesRef !== 'boolean' ||
    typeof value.changesLooseRef !== 'boolean' ||
    typeof value.changesPackedRefs !== 'boolean' ||
    value.changesRef !== (value.changesLooseRef || value.changesPackedRefs) ||
    typeof value.oldRefExists !== 'boolean' ||
    typeof value.oldRef !== 'string' ||
    (value.oldPacked !== null && typeof value.oldPacked !== 'string') ||
    typeof value.oldLog !== 'string' ||
    (value.nextRef !== null && typeof value.nextRef !== 'string') ||
    (value.nextPacked !== null && typeof value.nextPacked !== 'string') ||
    typeof value.nextLog !== 'string' ||
    typeof value.refLock !== 'string' ||
    typeof value.packedLock !== 'string' ||
    typeof value.logLock !== 'string' ||
    !validStashLockIdentity(value.refLockIdentity) ||
    !validStashLockIdentity(value.packedLockIdentity) ||
    !validStashLockIdentity(value.logLockIdentity)
  ) {
    return null
  }
  return {
    version: 2,
    changesRef: value.changesRef,
    changesLooseRef: value.changesLooseRef,
    changesPackedRefs: value.changesPackedRefs,
    oldRefExists: value.oldRefExists,
    oldRef: value.oldRef,
    oldPacked: value.oldPacked,
    oldLog: value.oldLog,
    nextRef: value.nextRef,
    nextPacked: value.nextPacked,
    nextLog: value.nextLog,
    refLock: value.refLock,
    packedLock: value.packedLock,
    logLock: value.logLock,
    refLockIdentity: value.refLockIdentity,
    packedLockIdentity: value.packedLockIdentity,
    logLockIdentity: value.logLockIdentity,
  }
}

interface StashFileSnapshot {
  contents: Buffer
  mode: number
}

async function optionalStashFileState(filePath: string): Promise<StashFileSnapshot | null> {
  try {
    const info = await fs.lstat(filePath)
    if (!info.isFile()) {
      throw new Error(`Cannot safely recover stash file ${path.basename(filePath)}`)
    }
    return {
      contents: await fs.readFile(filePath),
      mode: info.mode & 0o7777,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function optionalStashFileMode(filePath: string): Promise<number | null> {
  try {
    const info = await fs.lstat(filePath)
    if (!info.isFile()) {
      throw new Error(`Cannot safely recover stash file ${path.basename(filePath)}`)
    }
    return info.mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function optionalStashFile(filePath: string): Promise<Buffer | null> {
  return (await optionalStashFileState(filePath))?.contents ?? null
}

async function prepareStashLock(
  lockPath: string,
  transactionId: string,
  existingMode: number | null,
  sharedMode: number | null,
): Promise<{ temporaryPath: string; identity: { dev: string; ino: string } }> {
  const temporaryPath = `${lockPath}.${transactionId}.tmp`
  const mode = existingMode ?? sharedMode ?? 0o666
  const handle = await fs.open(temporaryPath, 'wx', mode)
  try {
    const preserveMode = existingMode ?? sharedMode
    if (preserveMode !== null) await handle.chmod(preserveMode)
    await handle.sync()
    const info = await handle.stat()
    await handle.close()
    return {
      temporaryPath,
      identity: { dev: String(info.dev), ino: String(info.ino) },
    }
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

async function publishStashLock(
  lockPath: string,
  temporaryPath: string,
  identity: { dev: string; ino: string },
): Promise<FileHandle> {
  await fs.link(temporaryPath, lockPath)
  const info = await fs.lstat(lockPath)
  if (!info.isFile() || String(info.dev) !== identity.dev || String(info.ino) !== identity.ino) {
    throw new Error(`Cannot safely acquire stash lock ${path.basename(lockPath)}`)
  }
  await fs.unlink(temporaryPath)
  return fs.open(lockPath, 'r+')
}

async function setStashLockMode(
  handle: FileHandle,
  existingMode: number | null,
  sharedMode: number | null,
): Promise<void> {
  const mode = existingMode ?? sharedMode
  if (mode !== null) await handle.chmod(mode)
}

function sameStashFile(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right
  return left.equals(right)
}

async function verifyStashRecoveryLock(
  filePath: string,
  expected: Buffer,
  identity: { dev: string; ino: string },
): Promise<boolean> {
  const contents = await optionalStashFile(filePath)
  if (contents === null) return false
  const info = await fs.lstat(filePath)
  if (
    !contents.equals(expected) ||
    String(info.dev) !== identity.dev ||
    String(info.ino) !== identity.ino
  ) {
    throw new Error(
      `Cannot safely recover an interrupted stash update while ${path.basename(filePath)} is owned by another Git operation`,
    )
  }
  return true
}

async function readStashDropJournal(journalPath: string): Promise<StashDropJournal | null> {
  let raw: string
  try {
    const info = await fs.lstat(journalPath)
    if (!info.isFile() || info.size > 256 * 1024 * 1024) {
      throw new Error('The interrupted stash journal is invalid; refusing recovery')
    }
    raw = await fs.readFile(journalPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('The interrupted stash journal is unreadable; refusing recovery')
  }
  if (!isRecord(value)) {
    throw new Error('The interrupted stash journal is invalid; refusing recovery')
  }
  if (
    value.version === 1 &&
    typeof value.changesRef === 'boolean' &&
    typeof value.oldRef === 'string' &&
    typeof value.oldLog === 'string' &&
    (value.nextRef === null || typeof value.nextRef === 'string') &&
    typeof value.nextLog === 'string' &&
    typeof value.refLock === 'string' &&
    typeof value.logLock === 'string' &&
    validStashLockIdentity(value.refLockIdentity) &&
    validStashLockIdentity(value.logLockIdentity)
  ) {
    return {
      version: 1,
      changesRef: value.changesRef,
      oldRef: value.oldRef,
      oldLog: value.oldLog,
      nextRef: value.nextRef,
      nextLog: value.nextLog,
      refLock: value.refLock,
      logLock: value.logLock,
      refLockIdentity: value.refLockIdentity,
      logLockIdentity: value.logLockIdentity,
    }
  }
  const validV3Metadata =
    typeof value.transactionId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.transactionId,
    ) &&
    typeof value.ownerPid === 'number' &&
    Number.isSafeInteger(value.ownerPid) &&
    value.ownerPid >= 0
  if (
    value.version === 3 &&
    value.phase === 'acquiring' &&
    validV3Metadata &&
    validOptionalStashLockIdentity(value.refLockIdentity) &&
    validOptionalStashLockIdentity(value.packedLockIdentity) &&
    validOptionalStashLockIdentity(value.logLockIdentity)
  ) {
    return {
      version: 3,
      phase: 'acquiring',
      transactionId: value.transactionId as string,
      ownerPid: value.ownerPid as number,
      refLockIdentity: value.refLockIdentity,
      packedLockIdentity: value.packedLockIdentity,
      logLockIdentity: value.logLockIdentity,
    }
  }
  if (value.version === 2) {
    const parsed = parseStashDropJournalV2(value)
    if (parsed) return parsed
  }
  if (value.version === 3 && value.phase === 'prepared' && validV3Metadata) {
    const transaction = parseStashDropJournalV2({ ...value, version: 2 })
    if (transaction) {
      return {
        ...transaction,
        version: 3,
        phase: 'prepared',
        transactionId: value.transactionId as string,
        ownerPid: value.ownerPid as number,
      }
    }
  }
  throw new Error('The interrupted stash journal is invalid; refusing recovery')
}

async function writeStashDropJournal(
  journalPath: string,
  journal: StashDropJournal,
): Promise<void> {
  const temporaryPath = `${journalPath}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(journal), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporaryPath, journalPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

async function createStashDropIntent(
  journalPath: string,
  journal: StashDropJournalV3Acquiring,
): Promise<void> {
  const temporaryPath = `${journalPath}.${journal.transactionId}.tmp`
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal), 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
  await handle.close()
  try {
    await fs.link(temporaryPath, journalPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
  await fs.rm(temporaryPath, { force: true }).catch(() => {})
}

async function removeStashAcquisitionFile(
  filePath: string,
  identity: { dev: string; ino: string } | null,
  removeUnidentified: boolean,
): Promise<void> {
  let info: Stats
  try {
    info = await fs.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!info.isFile()) return
  if (identity && (String(info.dev) !== identity.dev || String(info.ino) !== identity.ino)) {
    return
  }
  if (!identity && !removeUnidentified) return
  await fs.unlink(filePath)
}

async function removeStashDropAcquisition(
  paths: StashDropPaths,
  journal: StashDropJournalV3Acquiring,
): Promise<void> {
  for (const [lockPath, identity] of [
    [paths.refLockPath, journal.refLockIdentity],
    [paths.packedRefsLockPath, journal.packedLockIdentity],
    [paths.logLockPath, journal.logLockIdentity],
  ] as const) {
    await removeStashAcquisitionFile(lockPath, identity, false)
    await removeStashAcquisitionFile(`${lockPath}.${journal.transactionId}.tmp`, identity, true)
  }
  await fs.rm(`${paths.journalPath}.${journal.transactionId}.tmp`, { force: true })
}

interface StashDropPaths {
  refPath: string
  refLockPath: string
  logPath: string
  logLockPath: string
  packedRefsPath: string
  packedRefsLockPath: string
  journalPath: string
}

function localFilesUriPath(value: string): string {
  let uri: URL
  try {
    uri = new URL(value)
  } catch {
    throw new Error('Invalid local files reference-storage URI')
  }
  if (
    uri.protocol !== 'files:' ||
    uri.host ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash ||
    !uri.pathname.startsWith('/')
  ) {
    throw new Error('Invalid local files reference-storage URI')
  }
  let decodedPath: string
  try {
    // Git's `files:` scheme carries a file URL path, including a Windows drive.
    // path.resolve('/', '/C:/...') would turn C: into a directory on Windows.
    decodedPath = fileURLToPath(uri.href.replace(/^files:/u, 'file:'))
  } catch {
    throw new Error('Invalid local files reference-storage URI')
  }
  if (decodedPath.includes('\0')) {
    throw new Error('Invalid local files reference-storage URI')
  }
  return decodedPath
}

function assertFilesRefStorage(refStorage: string | null, ref: string): string | null {
  if (!refStorage || refStorage.toLowerCase() === 'files') return null
  try {
    return localFilesUriPath(refStorage)
  } catch {
    throw new Error(`Cannot safely remove stash ${ref} with ${refStorage} reference storage`)
  }
}

function sharedStashFileMode(value: string | null): number | null {
  const normalized = value?.toLowerCase()
  if (!normalized || ['false', 'no', 'off', 'umask'].includes(normalized)) return null
  if (['true', 'yes', 'on', 'group'].includes(normalized)) return 0o664
  if (['all', 'world'].includes(normalized)) return 0o666
  const digits = normalized.startsWith('0o') ? normalized.slice(2) : normalized
  if (/^0?[0-7]{3,4}$/u.test(digits)) return Number.parseInt(digits, 8) & 0o7777
  return null
}

async function repositoryGitPath(
  repoPath: string,
  gitPath: string,
  refRoot: string | null,
): Promise<string> {
  const resolvedPath = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-path', gitPath]),
  )
  if (!resolvedPath) throw new Error(`Git did not resolve the path for ${gitPath}`)
  if (resolvedPath.startsWith('files:')) return localFilesUriPath(resolvedPath)
  return path.resolve(
    path.isAbsolute(resolvedPath) ? path.sep : (refRoot ?? repoPath),
    resolvedPath,
  )
}

async function stashDropPaths(
  repoPath: string,
  commonPath: string,
  refRoot: string | null,
): Promise<StashDropPaths> {
  const [refPath, refLockPath, logPath, logLockPath, packedRefsPath, packedRefsLockPath] =
    await Promise.all([
      repositoryGitPath(repoPath, 'refs/stash', refRoot),
      repositoryGitPath(repoPath, 'refs/stash.lock', refRoot),
      repositoryGitPath(repoPath, 'logs/refs/stash', refRoot),
      repositoryGitPath(repoPath, 'logs/refs/stash.lock', refRoot),
      repositoryGitPath(repoPath, 'packed-refs', refRoot),
      repositoryGitPath(repoPath, 'packed-refs.lock', refRoot),
    ])
  return {
    refPath,
    refLockPath,
    logPath,
    logLockPath,
    packedRefsPath,
    packedRefsLockPath,
    journalPath: path.join(commonPath, 'git-stacks-stash-drop.json'),
  }
}

async function recoverStashDrop(repoPath: string, commonPath: string): Promise<void> {
  const journalPath = path.join(commonPath, 'git-stacks-stash-drop.json')
  let journal = await readStashDropJournal(journalPath)
  if (!journal) return

  const refStorage = await getConfigValue(repoPath, 'extensions.refstorage')
  const refRoot = assertFilesRefStorage(refStorage, 'refs/stash')
  const paths = await stashDropPaths(repoPath, commonPath, refRoot)
  if (journal.version === 3) {
    if (isProcessRunning(journal.ownerPid)) {
      throw new Error('Another stash update is in progress; retry after it completes')
    }
    if (journal.phase === 'acquiring') {
      await removeStashDropAcquisition(paths, journal)
      await fs.rm(journalPath, { force: true })
      return
    }
    journal = { ...journal, version: 2 }
  }
  const { refPath, refLockPath, logPath, logLockPath, packedRefsPath, packedRefsLockPath } = paths
  const oldLog = decodeStashJournalBytes(journal.oldLog)
  const nextLog = decodeStashJournalBytes(journal.nextLog)
  const logLock = decodeStashJournalBytes(journal.logLock)

  if (journal.version === 1) {
    const oldRef = decodeStashJournalBytes(journal.oldRef)
    const nextRef = journal.nextRef === null ? null : decodeStashJournalBytes(journal.nextRef)
    const refLock = decodeStashJournalBytes(journal.refLock)
    const targetRef = journal.changesRef ? nextRef : oldRef
    const [currentRef, currentLog] = await Promise.all([
      optionalStashFile(refPath),
      optionalStashFile(logPath),
    ])
    const refIsOld = sameStashFile(currentRef, oldRef)
    const refIsNew = sameStashFile(currentRef, targetRef)
    const logIsOld = sameStashFile(currentLog, oldLog)
    const logIsNew = sameStashFile(currentLog, nextLog)
    if (!refIsOld && !refIsNew) {
      throw new Error('Stash references changed during recovery; refusing to overwrite them')
    }
    if (!logIsOld && !logIsNew) {
      throw new Error('The stash reflog changed during recovery; refusing to overwrite it')
    }
    if (journal.changesRef && refIsNew && !refIsOld && logIsOld) {
      throw new Error('Stash files are in an unexpected transaction state; refusing recovery')
    }

    const hasRefLock = await verifyStashRecoveryLock(refLockPath, refLock, journal.refLockIdentity)
    const hasLogLock = await verifyStashRecoveryLock(logLockPath, logLock, journal.logLockIdentity)
    if (logIsOld && !hasLogLock) {
      throw new Error('The stash reflog lock is missing; refusing to finish recovery')
    }
    if (journal.changesRef && refIsOld && !hasRefLock) {
      throw new Error('The stash reference lock is missing; refusing to finish recovery')
    }

    if (logIsOld) {
      await fs.rename(logLockPath, logPath)
    } else if (hasLogLock) {
      await fs.unlink(logLockPath)
    }
    if (journal.changesRef && refIsOld) {
      if (nextRef === null) {
        await fs.unlink(refPath)
        if (hasRefLock) await fs.unlink(refLockPath)
      } else {
        await fs.rename(refLockPath, refPath)
      }
    } else if (hasRefLock) {
      await fs.unlink(refLockPath)
    }
    await fs.rm(journalPath)
    return
  }

  const oldRef = journal.oldRefExists ? decodeStashJournalBytes(journal.oldRef) : null
  const oldPacked = journal.oldPacked === null ? null : decodeStashJournalBytes(journal.oldPacked)
  const nextRef = journal.nextRef === null ? null : decodeStashJournalBytes(journal.nextRef)
  const nextPacked =
    journal.nextPacked === null ? null : decodeStashJournalBytes(journal.nextPacked)
  const refLock = decodeStashJournalBytes(journal.refLock)
  const packedLock = decodeStashJournalBytes(journal.packedLock)
  const looseTarget = journal.changesLooseRef ? nextRef : oldRef
  const packedTarget = journal.changesPackedRefs ? nextPacked : oldPacked
  const [currentRef, currentPacked, currentLog] = await Promise.all([
    optionalStashFile(refPath),
    optionalStashFile(packedRefsPath),
    optionalStashFile(logPath),
  ])
  const refIsOld = sameStashFile(currentRef, oldRef)
  const refIsNew = sameStashFile(currentRef, looseTarget)
  const packedIsOld = sameStashFile(currentPacked, oldPacked)
  const packedIsNew = sameStashFile(currentPacked, packedTarget)
  const logIsOld = sameStashFile(currentLog, oldLog)
  const logIsNew = sameStashFile(currentLog, nextLog)
  if (!refIsOld && !refIsNew) {
    throw new Error('Stash references changed during recovery; refusing to overwrite them')
  }
  if (!packedIsOld && !packedIsNew) {
    throw new Error('Packed references changed during stash recovery; refusing to overwrite them')
  }
  if (!logIsOld && !logIsNew) {
    throw new Error('The stash reflog changed during recovery; refusing to overwrite it')
  }
  if (
    journal.changesRef &&
    ((refIsNew && !refIsOld) || (packedIsNew && !packedIsOld)) &&
    logIsOld
  ) {
    throw new Error('Stash files are in an unexpected transaction state; refusing recovery')
  }

  const [hasRefLock, hasPackedLock, hasLogLock] = await Promise.all([
    verifyStashRecoveryLock(refLockPath, refLock, journal.refLockIdentity),
    verifyStashRecoveryLock(packedRefsLockPath, packedLock, journal.packedLockIdentity),
    verifyStashRecoveryLock(logLockPath, logLock, journal.logLockIdentity),
  ])
  if (logIsOld && !hasLogLock) {
    throw new Error('The stash reflog lock is missing; refusing to finish recovery')
  }
  if (journal.changesLooseRef && refIsOld && !hasRefLock) {
    throw new Error('The stash reference lock is missing; refusing to finish recovery')
  }
  if (journal.changesPackedRefs && packedIsOld && !hasPackedLock) {
    throw new Error('The packed references lock is missing; refusing to finish recovery')
  }

  if (logIsOld) {
    await fs.rename(logLockPath, logPath)
  } else if (hasLogLock) {
    await fs.unlink(logLockPath)
  }
  if (journal.changesPackedRefs && packedIsOld) {
    if (nextPacked === null) {
      if (oldPacked !== null) await fs.unlink(packedRefsPath)
      if (hasPackedLock) await fs.unlink(packedRefsLockPath)
    } else {
      await fs.rename(packedRefsLockPath, packedRefsPath)
    }
  } else if (hasPackedLock) {
    await fs.unlink(packedRefsLockPath)
  }
  if (journal.changesLooseRef && refIsOld) {
    if (nextRef === null) {
      if (oldRef !== null) await fs.unlink(refPath)
      if (hasRefLock) await fs.unlink(refLockPath)
    } else {
      await fs.rename(refLockPath, refPath)
    }
  } else if (hasRefLock) {
    await fs.unlink(refLockPath)
  }
  await fs.rm(journalPath)
}

async function recoverStashDropForRepository(repoPath: string): Promise<void> {
  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  await recoverStashDrop(repoPath, path.resolve(repoPath, commonDir))
}

async function getStashesWithRecovery(repoPath: string) {
  await recoverStashDropForRepository(repoPath)
  return getStashes(repoPath)
}

async function assertStashIdentity(repoPath: string, ref: string, oid: string): Promise<void> {
  const stash = (await getStashesWithRecovery(repoPath)).find((entry) => entry.ref === ref)
  if (!stash) throw new Error(`Stash ${ref} does not exist`)
  if (stash.oid !== oid) {
    throw new Error(`Stash ${ref} changed; refresh before applying or dropping it`)
  }
}

function packedStashState(contents: Buffer | null): {
  oid: string | null
  withoutStash: Buffer | null
} {
  if (contents === null) return { oid: null, withoutStash: null }
  const text = contents.toString('utf8')
  const rows = text.split('\n')
  const entries = rows
    .map((row, index) => ({ row, index, match: row.match(/^([0-9a-f]{40,128}) refs\/stash$/iu) }))
    .filter(({ row }) => row.endsWith(' refs/stash'))
  if (entries.length > 1 || entries.some(({ match }) => !match)) {
    throw new Error('Cannot safely identify packed refs/stash')
  }
  const entry = entries[0]
  if (!entry?.match) return { oid: null, withoutStash: contents }
  const removePeeled = /^\^[0-9a-f]{40,128}$/iu.test(rows[entry.index + 1] ?? '')
  rows.splice(entry.index, removePeeled ? 2 : 1)
  return {
    oid: entry.match[1],
    withoutStash: Buffer.from(rows.join('\n'), 'utf8'),
  }
}

async function dropStashByOid(
  repoPath: string,
  ref: string,
  oid: string,
  apply?: () => Promise<void>,
): Promise<void> {
  const refStorage = await getConfigValue(repoPath, 'extensions.refstorage')
  const refRoot = assertFilesRefStorage(refStorage, ref)

  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  const commonPath = path.resolve(repoPath, commonDir)
  await recoverStashDrop(repoPath, commonPath)
  const paths = await stashDropPaths(repoPath, commonPath, refRoot)
  const sharedMode = sharedStashFileMode(await getConfigValue(repoPath, 'core.sharedrepository'))
  const transactionId = randomUUID()
  let acquiringJournal: StashDropJournalV3Acquiring = {
    version: 3,
    phase: 'acquiring',
    transactionId,
    ownerPid: process.pid,
    refLockIdentity: null,
    packedLockIdentity: null,
    logLockIdentity: null,
  }
  let intentCreated = false
  let refLock: FileHandle | undefined
  let packedLock: FileHandle | undefined
  let logLock: FileHandle | undefined
  let preparedJournal: StashDropJournalV3Prepared | null = null
  let journalPending = false

  try {
    const [refMode, packedRefsMode, logMode] = await Promise.all([
      optionalStashFileMode(paths.refPath),
      optionalStashFileMode(paths.packedRefsPath),
      optionalStashFileMode(paths.logPath),
    ])
    await createStashDropIntent(paths.journalPath, acquiringJournal)
    intentCreated = true
    const refPrepared = await prepareStashLock(
      paths.refLockPath,
      transactionId,
      refMode,
      sharedMode,
    )
    const packedPrepared = await prepareStashLock(
      paths.packedRefsLockPath,
      transactionId,
      packedRefsMode,
      sharedMode,
    )
    const logPrepared = await prepareStashLock(
      paths.logLockPath,
      transactionId,
      logMode,
      sharedMode,
    )
    acquiringJournal = {
      ...acquiringJournal,
      refLockIdentity: refPrepared.identity,
      packedLockIdentity: packedPrepared.identity,
      logLockIdentity: logPrepared.identity,
    }
    await writeStashDropJournal(paths.journalPath, acquiringJournal)
    refLock = await publishStashLock(
      paths.refLockPath,
      refPrepared.temporaryPath,
      refPrepared.identity,
    )
    packedLock = await publishStashLock(
      paths.packedRefsLockPath,
      packedPrepared.temporaryPath,
      packedPrepared.identity,
    )
    logLock = await publishStashLock(
      paths.logLockPath,
      logPrepared.temporaryPath,
      logPrepared.identity,
    )

    const [refState, packedRefsState, logState, stashes] = await Promise.all([
      optionalStashFileState(paths.refPath),
      optionalStashFileState(paths.packedRefsPath),
      optionalStashFileState(paths.logPath),
      getStashes(repoPath),
    ])
    if (!logState) throw new Error(`Cannot safely remove stash ${ref} from this repository`)
    await Promise.all([
      setStashLockMode(refLock, refState?.mode ?? sharedMode, sharedMode),
      setStashLockMode(packedLock, packedRefsState?.mode ?? sharedMode, sharedMode),
      setStashLockMode(logLock, logState.mode, sharedMode),
    ])

    const currentRef = refState?.contents ?? null
    const packedRefs = packedRefsState?.contents ?? null
    const packedStash = packedStashState(packedRefs)
    const looseRefText = currentRef?.toString('utf8').trim() ?? null
    if (looseRefText !== null && !/^[0-9a-f]{40,128}$/iu.test(looseRefText)) {
      throw new Error(`Cannot safely identify stash ${ref}; refresh before retrying`)
    }
    const currentRefOid = looseRefText ?? packedStash.oid
    const logBuffer = logState.contents
    const log = logBuffer.toString('utf8')
    const matches = stashes
      .map((stash, index) => ({ stash, index }))
      .filter(({ stash }) => stash.oid.toLowerCase() === oid.toLowerCase())
    if (matches.length !== 1) {
      throw new Error(`Stash ${ref} changed or is ambiguous; refresh before retrying`)
    }
    const selectedIndex = matches[0].index
    if (
      !stashes[0] ||
      currentRefOid?.toLowerCase() !== stashes[0].oid.toLowerCase() ||
      (log && !log.endsWith('\n'))
    ) {
      throw new Error(`Stash ${ref} changed; refresh before retrying`)
    }

    const rows = log ? log.slice(0, -1).split('\n') : []
    const records = rows.map((row) => {
      const match = row.match(/^([0-9a-f]{40,128}) ([0-9a-f]{40,128}) (.*)$/iu)
      if (!match) throw new Error(`Cannot safely identify stash ${ref}; refresh before retrying`)
      return { oldOid: match[1], newOid: match[2], rest: match[3] }
    })
    if (
      records.length !== stashes.length ||
      records.some(
        (record, index) =>
          record.newOid.toLowerCase() !== stashes[stashes.length - index - 1].oid.toLowerCase(),
      )
    ) {
      throw new Error(`Cannot safely identify stash ${ref}; refresh before retrying`)
    }

    // `stash list` is newest-first; reflog records on disk are oldest-first.
    const logIndex = records.length - selectedIndex - 1
    const selected = records[logIndex]!
    if (logIndex < records.length - 1) {
      const newer = records[logIndex + 1]!
      const olderOid = logIndex > 0 ? records[logIndex - 1]!.newOid : selected.oldOid
      rows[logIndex + 1] = `${olderOid} ${newer.newOid} ${newer.rest}`
    }
    rows.splice(logIndex, 1)

    const newTip = selectedIndex === 0 ? (records[logIndex - 1]?.newOid ?? null) : null
    if (apply) await apply()

    const nextLog = Buffer.from(rows.length > 0 ? `${rows.join('\n')}\n` : '', 'utf8')
    const changesLooseRef = selectedIndex === 0 && (currentRef !== null || newTip !== null)
    const changesPackedRefs = selectedIndex === 0 && packedStash.oid !== null
    const changesRef = changesLooseRef || changesPackedRefs
    const nextRef = changesLooseRef
      ? newTip
        ? Buffer.from(`${newTip}\n`, 'utf8')
        : null
      : currentRef
    const nextPackedRefs = changesPackedRefs ? packedStash.withoutStash : packedRefs
    const refLockContents = changesLooseRef && nextRef !== null ? nextRef : Buffer.alloc(0)
    const packedLockContents =
      changesPackedRefs && nextPackedRefs !== null ? nextPackedRefs : Buffer.alloc(0)
    await logLock.writeFile(nextLog)
    await logLock.sync()
    await refLock.writeFile(refLockContents)
    await refLock.sync()
    await packedLock.writeFile(packedLockContents)
    await packedLock.sync()
    const [refLockInfo, packedLockInfo, logLockInfo] = await Promise.all([
      fs.lstat(paths.refLockPath),
      fs.lstat(paths.packedRefsLockPath),
      fs.lstat(paths.logLockPath),
    ])
    const journal: StashDropJournalV3Prepared = {
      version: 3,
      phase: 'prepared',
      transactionId,
      ownerPid: process.pid,
      changesRef,
      changesLooseRef,
      changesPackedRefs,
      oldRefExists: currentRef !== null,
      oldRef: encodeStashJournalBytes(currentRef ?? Buffer.alloc(0)),
      oldPacked: packedRefs === null ? null : encodeStashJournalBytes(packedRefs),
      oldLog: encodeStashJournalBytes(logBuffer),
      nextRef: nextRef === null ? null : encodeStashJournalBytes(nextRef),
      nextPacked: nextPackedRefs === null ? null : encodeStashJournalBytes(nextPackedRefs),
      nextLog: encodeStashJournalBytes(nextLog),
      refLock: encodeStashJournalBytes(refLockContents),
      packedLock: encodeStashJournalBytes(packedLockContents),
      logLock: encodeStashJournalBytes(nextLog),
      refLockIdentity: { dev: String(refLockInfo.dev), ino: String(refLockInfo.ino) },
      packedLockIdentity: { dev: String(packedLockInfo.dev), ino: String(packedLockInfo.ino) },
      logLockIdentity: { dev: String(logLockInfo.dev), ino: String(logLockInfo.ino) },
    }
    preparedJournal = journal
    await writeStashDropJournal(paths.journalPath, journal)
    journalPending = true

    await fs.rename(paths.logLockPath, paths.logPath)
    await logLock.close()
    logLock = undefined
    if (changesPackedRefs && nextPackedRefs !== null) {
      await fs.rename(paths.packedRefsLockPath, paths.packedRefsPath)
    } else {
      await fs.unlink(paths.packedRefsLockPath)
    }
    if (changesLooseRef && nextRef !== null) {
      await fs.rename(paths.refLockPath, paths.refPath)
    } else {
      if (changesLooseRef && currentRef !== null) await fs.unlink(paths.refPath)
      await fs.unlink(paths.refLockPath)
    }
    await packedLock.close()
    packedLock = undefined
    await refLock.close()
    refLock = undefined
    await fs.rm(paths.journalPath)
    journalPending = false
    intentCreated = false
  } catch (error) {
    if (journalPending) {
      await logLock?.close().catch(() => {})
      logLock = undefined
      await packedLock?.close().catch(() => {})
      packedLock = undefined
      await refLock?.close().catch(() => {})
      refLock = undefined
      if (preparedJournal) {
        await writeStashDropJournal(paths.journalPath, {
          ...preparedJournal,
          ownerPid: 0,
        }).catch(() => {})
      }
      throw new Error(
        `Stash removal was interrupted and will be recovered on the next repository refresh: ${commandDetail(error)}`,
      )
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another Git operation is changing the stash; retry after it completes')
    }
    throw error
  } finally {
    await logLock?.close().catch(() => {})
    await packedLock?.close().catch(() => {})
    await refLock?.close().catch(() => {})
    if (!journalPending) {
      if (intentCreated) {
        await removeStashDropAcquisition(paths, acquiringJournal)
        await fs.rm(paths.journalPath, { force: true })
      } else {
        await fs.rm(`${paths.journalPath}.${transactionId}.tmp`, { force: true })
      }
    }
  }
}

async function runStashAction(
  repoPath: string,
  action: 'stashPop' | 'stashApply' | 'stashDrop',
  ref: string,
  oid: string,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, `${action} a stash`)
  await assertStashIdentity(repoPath, ref, oid)
  if (action === 'stashApply') {
    await runGit(repoPath, ['stash', 'apply', '--index', oid])
  } else if (action === 'stashPop') {
    await dropStashByOid(repoPath, ref, oid, async () => {
      await runGit(repoPath, ['stash', 'apply', '--index', oid])
    })
  } else {
    await dropStashByOid(repoPath, ref, oid)
  }
  return {
    message: `${action === 'stashPop' ? 'Applied and removed' : action === 'stashApply' ? 'Applied' : 'Dropped'} ${ref}`,
  }
}

async function runSwitch(repoPath: string, ref: string, carry = false): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'switch branches')
  if (!carry) await ensureClean(repoPath, 'switch branches')
  if (
    (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) ||
    !(await refExists(repoPath, ref))
  ) {
    throw new Error('Select an existing local or remote branch reference.')
  }
  if (ref.startsWith('refs/heads/')) {
    const name = ref.slice('refs/heads/'.length)
    await validateBranchName(repoPath, name)
    await ensureNotCheckedOutElsewhere(repoPath, name)
    await runGit(repoPath, [
      'switch',
      '--no-overwrite-ignore',
      '--no-recurse-submodules',
      '--',
      name,
    ])
    return { message: `Switched to ${name}` }
  }
  const remote = await remoteForRefPath(repoPath, ref)
  if (!remote) throw new Error('The selected branch has no configured remote.')
  const localName = ref.slice(`refs/remotes/${remote}/`.length)
  if (localName === 'HEAD') throw new Error('Select a branch instead of the remote symbolic HEAD.')
  await validateBranchName(repoPath, localName)
  await ensureNotCheckedOutElsewhere(repoPath, localName)
  if (await refExists(repoPath, `refs/heads/${localName}`)) {
    const upstream = await branchUpstream(repoPath, localName)
    if (upstream !== `${remote}/${localName}`) {
      throw new Error(
        `Local branch "${localName}" already exists but does not track this remote branch. Select the local branch explicitly.`,
      )
    }
    await runGit(repoPath, [
      'switch',
      '--no-overwrite-ignore',
      '--no-recurse-submodules',
      '--',
      localName,
    ])
  } else {
    await runGit(repoPath, [
      'switch',
      '--no-overwrite-ignore',
      '--no-recurse-submodules',
      '--track',
      ref,
    ])
  }
  return { message: `Switched to ${localName} tracking ${remote}/${localName}` }
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
    await runGit(repoPath, ['config', '--local', '--unset', key])
  } catch (error) {
    if (!isExitCode(error, 1) && !isExitCode(error, 5)) throw error
  }
}

async function persistPendingRebase(repoPath: string, branch: string): Promise<void> {
  const parent = await getConfigValue(repoPath, `branch.${branch}.parentPending`)
  const parentTip = await getConfigValue(repoPath, `branch.${branch}.parentTipPending`)
  if (parent && parentTip) {
    await setBranchMetadata(repoPath, branch, parent, parentTip)
  }
  await unsetConfig(repoPath, `branch.${branch}.parentPending`)
  await unsetConfig(repoPath, `branch.${branch}.parentTipPending`)
}
async function rebaseBranch(repoPath: string): Promise<string | null> {
  const current = await getCurrentBranch(repoPath)
  if (current) return current
  for (const statePath of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    const output = await tryGit(repoPath, ['rev-parse', '--git-path', statePath])
    if (!output) continue
    const candidate = path.isAbsolute(stripTrailingNewline(output))
      ? stripTrailingNewline(output)
      : path.resolve(repoPath, stripTrailingNewline(output))
    try {
      const value = stripTrailingNewline(await fs.readFile(candidate, 'utf8'))
      const branch = value.replace(/^refs\/heads\//u, '')
      if (branch) return branch
    } catch {
      // The state directory may disappear as a continuation completes.
    }
  }
  return null
}

async function runCreateBranch(
  repoPath: string,
  name: string,
  parent: string,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'create a branch')
  await ensureClean(repoPath, 'create a branch')
  await validateBranchName(repoPath, name)
  await validateBranchName(repoPath, parent)
  if (await refExists(repoPath, `refs/heads/${name}`)) {
    throw new Error(`Local branch "${name}" already exists`)
  }
  const parentRef = `refs/heads/${parent}`
  if (!(await refExists(repoPath, parentRef))) {
    throw new Error(`Parent branch "${parent}" does not exist locally`)
  }
  const parentTip = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--verify', '--end-of-options', `${parentRef}^{commit}`]),
  )
  await ensureNotCheckedOutElsewhere(repoPath, name)
  await runGit(repoPath, [
    'switch',
    '--no-overwrite-ignore',
    '--no-recurse-submodules',
    '--create',
    name,
    parentTip,
  ])
  try {
    await setBranchMetadata(repoPath, name, parent, parentTip)
  } catch (error) {
    throw new Error(
      `Created branch "${name}", but could not persist its parent configuration: ${commandDetail(error)}`,
    )
  }
  return { message: `Created and switched to ${name} from ${parent}` }
}

async function runRebase(repoPath: string, parent: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'start a rebase')
  await ensureClean(repoPath, 'start a rebase')
  const currentBranch = await getCurrentBranch(repoPath)
  if (!currentBranch) throw new Error('Cannot rebase while HEAD is detached')
  const parentRef = await resolveParentRef(repoPath, parent)
  if (parentRef === currentBranch || parentRef === `refs/heads/${currentBranch}`) {
    throw new Error('Cannot rebase a branch onto itself')
  }
  await ensureNotCheckedOutElsewhere(repoPath, currentBranch)
  const parentTip = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--verify', '--end-of-options', `${parentRef}^{commit}`]),
  )
  await runGit(repoPath, ['config', '--local', `branch.${currentBranch}.parentPending`, parent])
  await runGit(repoPath, [
    'config',
    '--local',
    `branch.${currentBranch}.parentTipPending`,
    parentTip,
  ])
  await runGit(repoPath, [
    '-c',
    'rebase.updateRefs=false',
    '-c',
    'rebase.autoStash=false',
    'rebase',
    parentTip,
  ])
  await persistPendingRebase(repoPath, currentBranch)
  return { message: `Rebased ${currentBranch} onto ${parent}` }
}

async function runRebaseContinue(repoPath: string): Promise<ActionResult> {
  const state = await getOperationState(repoPath)
  if (!state.rebase) throw new Error('No rebase is in progress')
  const branch = await rebaseBranch(repoPath)
  await runGit(repoPath, ['rebase', '--continue'], {
    ...process.env,
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  })
  if (branch && !(await getOperationState(repoPath)).rebase) {
    await persistPendingRebase(repoPath, branch)
  }
  return { message: 'Continued the rebase' }
}

async function runRebaseAbort(repoPath: string): Promise<ActionResult> {
  const state = await getOperationState(repoPath)
  if (!state.rebase) throw new Error('No rebase is in progress')
  const branch = await rebaseBranch(repoPath)
  await runGit(repoPath, ['rebase', '--abort'])
  if (branch) {
    await unsetConfig(repoPath, `branch.${branch}.parentPending`)
    await unsetConfig(repoPath, `branch.${branch}.parentTipPending`)
  }
  return { message: 'Aborted the rebase' }
}
/**
 * The configured remote a `refs/remotes/<remote>/…` path belongs to. The
 * longest matching name wins, so a remote named `origin` never shadows one
 * named `origin-enterprise`.
 */
async function remoteForRefPath(repoPath: string, ref: string): Promise<string | null> {
  const prefix = 'refs/remotes/'
  if (!ref.startsWith(prefix)) return null
  const branchPath = ref.slice(prefix.length)
  let matched: string | null = null
  for (const name of await getRemotes(repoPath)) {
    if (branchPath.startsWith(`${name}/`) && (matched === null || name.length > matched.length)) {
      matched = name
    }
  }
  return matched
}

async function baseForGh(
  repoPath: string,
  requestedBase: string,
  resolvedBase: string,
): Promise<string> {
  if (await refExists(repoPath, `refs/heads/${requestedBase}`)) {
    return requestedBase
  }
  const remote = await remoteForRefPath(repoPath, resolvedBase)
  if (!remote) throw new Error('The PR base does not resolve to a branch.')
  return resolvedBase.slice(`refs/remotes/${remote}/`.length)
}

async function runCreatePr(
  repoPath: string,
  title: string,
  body: string,
  base: string,
  draft: boolean,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'create a pull request')
  const currentBranch = await getCurrentBranch(repoPath)
  if (!currentBranch) {
    throw new Error('Cannot create a pull request while HEAD is detached')
  }
  const configuredRemote = await getConfigValue(repoPath, `branch.${currentBranch}.remote`)
  const configuredMerge = await getConfigValue(repoPath, `branch.${currentBranch}.merge`)
  const remotes = await getRemotes(repoPath)
  if (
    !configuredRemote ||
    !remotes.includes(configuredRemote) ||
    !configuredMerge?.startsWith('refs/heads/') ||
    configuredMerge === 'refs/heads/'
  ) {
    throw new Error(
      `Branch "${currentBranch}" must be pushed to a remote before creating a pull request`,
    )
  }
  const remote = configuredRemote
  const remoteBranch = configuredMerge.slice('refs/heads/'.length)
  const upstream = `${remote}/${remoteBranch}`
  try {
    const remoteHead = await runGit(repoPath, ['ls-remote', '--heads', remote, configuredMerge])
    if (!remoteHead.trim()) {
      throw new Error('remote branch was not found')
    }
  } catch (error) {
    throw new Error(
      `Cannot create a pull request until ${upstream} is pushed: ${commandDetail(error)}`,
    )
  }
  const checkedBase = await resolveParentRef(repoPath, base)
  const ghBase = await baseForGh(repoPath, base, checkedBase)
  const origin = parseRemote(await getOriginUrl(repoPath))
  const headRemote = parseRemote(await runGit(repoPath, ['remote', 'get-url', remote]))
  const host = remoteHostContext(origin)
  const headHost = remoteHostContext(headRemote)
  if (!origin || !host || !headRemote || !headHost || headHost.host !== host.host) {
    throw new Error(
      `PR creation requires origin and upstream remotes on one GitHub host; this repository spans ${host?.host ?? 'no host'} and ${headRemote ? headRemote.host : 'no host'}.`,
    )
  }
  if (ghBase === remoteBranch && origin.fullName === headRemote.fullName) {
    throw new Error('The pull request base must differ from its head branch.')
  }
  const head =
    origin.fullName.toLowerCase() === headRemote.fullName.toLowerCase()
      ? remoteBranch
      : `${headRemote.owner}:${remoteBranch}`
  let created: Record<string, unknown>
  try {
    const response = await hostTransport(host).rest<Record<string, unknown>>({
      method: 'POST',
      path: `repos/${origin.fullName}/pulls`,
      body: { title, head, base: ghBase, body, draft },
    })
    created = response.data
  } catch (error) {
    throw new Error(`Could not create pull request: ${commandDetail(error)}`)
  }
  const url = isRecord(created) && typeof created.html_url === 'string' ? created.html_url : null
  return {
    message: `Created pull request from ${currentBranch} to ${ghBase}`,
    ...(url ? { url } : {}),
  }
}

const MAX_HISTORY_SKIP = 1_000_000
const MAX_DIFF_LINES = 4 * 1024 * 1024

async function safeRepositoryPath(repoPath: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(repoPath, relativePath)
  if (candidate === repoPath || !candidate.startsWith(`${repoPath}${path.sep}`)) {
    throw new Error('Path must remain inside the repository')
  }
  const parts = repositoryPathParts(relativePath)
  if (parts.includes('.git')) throw new Error('Git metadata paths are not accessible')
  let cursor = repoPath
  for (const part of parts) {
    if (!part) continue
    cursor = path.join(cursor, part)
    try {
      const info = await fs.lstat(cursor)
      if (info.isSymbolicLink()) {
        throw new Error('Symlink paths are not supported for file actions')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return candidate
}

interface RepositoryDirectoryIdentity {
  relativePath: string
  dev: string
  ino: string
}

async function assertRepositoryParentDirectories(
  repoPath: string,
  relativePath: string,
  directories: RepositoryDirectoryIdentity[],
): Promise<string> {
  const targetPath = await safeRepositoryPath(repoPath, relativePath)
  for (const directory of directories) {
    const directoryPath = directory.relativePath
      ? path.resolve(repoPath, directory.relativePath)
      : repoPath
    const info = await fs.lstat(directoryPath)
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      String(info.dev) !== directory.dev ||
      String(info.ino) !== directory.ino
    ) {
      throw new Error('A parent directory changed during the file action; refresh and retry')
    }
  }
  return targetPath
}

async function ensureRepositoryParentDirectories(
  repoPath: string,
  relativePath: string,
  createMissing = true,
): Promise<{ targetPath: string; directories: RepositoryDirectoryIdentity[] }> {
  const targetPath = await safeRepositoryPath(repoPath, relativePath)
  const relativeParent = path.relative(repoPath, path.dirname(targetPath))
  const parentParts = relativeParent ? relativeParent.split(path.sep) : []
  const directories: RepositoryDirectoryIdentity[] = []
  let current = repoPath

  const rootInfo = await fs.lstat(repoPath)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('The repository root is not a safe directory')
  }
  directories.push({ relativePath: '', dev: String(rootInfo.dev), ino: String(rootInfo.ino) })

  for (const part of parentParts) {
    await assertRepositoryParentDirectories(repoPath, relativePath, directories)
    current = path.join(current, part)
    if (createMissing) {
      try {
        await fs.mkdir(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const info = await fs.lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('A parent directory is not a safe repository directory')
    }
    await assertRepositoryParentDirectories(repoPath, relativePath, directories)
    directories.push({
      relativePath: path.relative(repoPath, current),
      dev: String(info.dev),
      ino: String(info.ino),
    })
  }
  await assertRepositoryParentDirectories(repoPath, relativePath, directories)
  return { targetPath, directories }
}

function changedEntry(files: ChangedFile[], requestedPath: string): ChangedFile {
  const entry = files.find(
    (file) => file.path === requestedPath || file.originalPath === requestedPath,
  )
  if (!entry) throw new Error(`Path is not currently changed: ${requestedPath}`)
  return entry
}

interface FileIdentity {
  fingerprint: string
  indexFingerprint: string
  contentFingerprint: string
  preview: Buffer | null
  stat: Stats | null
  binary: boolean
  truncated: boolean
}

async function fileFingerprintAt(
  repoPath: string,
  relativePath: string,
  absolutePath: string,
  signal?: AbortSignal,
): Promise<FileIdentity> {
  if (signal?.aborted) throw new CommandCancelled()
  const index = await runGit(
    repoPath,
    ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relativePath],
    undefined,
    signal,
  )
  const indexFingerprint = createHash('sha256').update(index).digest('hex')
  let stat: Stats | null = null
  let preview: Buffer | null = null
  let binary = false
  let truncated = false
  try {
    if (signal?.aborted) throw new CommandCancelled()
    stat = await fs.lstat(absolutePath)
    if (!stat.isFile()) throw new Error('Changed path is not a regular file')
    const hash = createHash('sha256')
    const contentHash = createHash('sha256')
    hash.update(index)
    hash.update(
      JSON.stringify({
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      }),
    )
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const handle = await fs.open(absolutePath, 'r')
    const chunks: Buffer[] = []
    let retained = 0
    let totalBytes = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    try {
      while (true) {
        if (signal?.aborted) throw new CommandCancelled()
        const result = await handle.read(buffer, 0, buffer.length, null)
        if (result.bytesRead === 0) break
        const chunk = buffer.subarray(0, result.bytesRead)
        totalBytes += chunk.length
        hash.update(chunk)
        contentHash.update(chunk)
        if (chunk.includes(0)) binary = true
        try {
          decoder.decode(chunk, { stream: true })
        } catch {
          binary = true
        }
        if (retained < MAX_FILE_BYTES) {
          const take = Math.min(MAX_FILE_BYTES - retained, chunk.length)
          chunks.push(Buffer.from(chunk.subarray(0, take)))
          retained += take
        }
        if (totalBytes > MAX_FILE_BYTES) truncated = true
      }
      if (signal?.aborted) throw new CommandCancelled()
      try {
        decoder.decode()
      } catch {
        binary = true
      }
      const openedStat = await handle.stat()
      if (
        openedStat.dev !== stat.dev ||
        openedStat.ino !== stat.ino ||
        openedStat.size !== stat.size ||
        openedStat.mtimeMs !== stat.mtimeMs ||
        openedStat.ctimeMs !== stat.ctimeMs
      ) {
        throw new Error('The file changed while it was being read; refresh and retry')
      }
    } finally {
      await handle.close()
    }
    if (signal?.aborted) throw new CommandCancelled()
    const currentStat = await fs.lstat(absolutePath)
    if (signal?.aborted) throw new CommandCancelled()
    if (currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) {
      throw new Error('The file changed while it was being read; refresh and retry')
    }
    preview = Buffer.concat(chunks)
    return {
      fingerprint: hash.digest('hex'),
      indexFingerprint,
      contentFingerprint: contentHash.digest('hex'),
      preview,
      stat,
      binary,
      truncated,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (signal?.aborted) throw new CommandCancelled()
  const contentFingerprint = createHash('sha256').update('missing').digest('hex')
  const hash = createHash('sha256')
  hash.update(index)
  hash.update('missing')
  return {
    fingerprint: hash.digest('hex'),
    indexFingerprint,
    contentFingerprint,
    preview: null,
    stat: null,
    binary: false,
    truncated: false,
  }
}

async function fileFingerprint(
  repoPath: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<FileIdentity> {
  if (signal?.aborted) throw new CommandCancelled()
  const absolute = await safeRepositoryPath(repoPath, relativePath)
  if (signal?.aborted) throw new CommandCancelled()
  return fileFingerprintAt(repoPath, relativePath, absolute, signal)
}

function sameFileMutationIdentity(expected: FileIdentity, actual: FileIdentity): boolean {
  if (
    expected.indexFingerprint !== actual.indexFingerprint ||
    expected.contentFingerprint !== actual.contentFingerprint
  ) {
    return false
  }
  if (!expected.stat || !actual.stat) return expected.stat === actual.stat
  return (
    expected.stat.dev === actual.stat.dev &&
    expected.stat.ino === actual.stat.ino &&
    expected.stat.mode === actual.stat.mode &&
    expected.stat.size === actual.stat.size &&
    expected.stat.mtimeMs === actual.stat.mtimeMs
  )
}
async function changedDiff(
  repoPath: string,
  mode: 'cached' | 'worktree',
  relativePath: string,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const args = [
    '-c',
    'core.quotePath=false',
    '--literal-pathspecs',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    ...(mode === 'cached' ? ['--cached'] : []),
    '--',
    relativePath,
  ]
  // Cap the stream itself rather than buffering an arbitrarily large diff, and
  // abandon it when the caller navigates away from the file.
  return runGitCapped(repoPath, args, {
    maxBytes: MAX_DIFF_BYTES,
    signal,
    env: { GIT_OPTIONAL_LOCKS: '0' },
  })
}

/**
 * Resolves one side of a file's diff into hunks Git can apply, or the reason it
 * cannot. The same resolution backs the inspector view and the action, so a
 * refusal the user reads is the refusal that stops the write.
 */
function resolveHunkSide(
  entry: ChangedFile,
  identity: FileIdentity,
  side: HunkSideName,
  diff: { text: string; truncated: boolean },
): HunkSide {
  const block = parseHunkBlock(diff.text, {
    path: entry.path,
    originalPath: entry.originalPath ?? null,
  })
  const worktreeChanged = entry.worktree !== ' ' && entry.worktree !== ''
  const unavailable = hunkSideUnavailable(side, block, {
    binary: identity.binary,
    truncated: diff.truncated,
    conflicted: entry.conflicted,
    untracked: entry.index === '?' || entry.worktree === '?',
    renamed: side === 'staged' && entry.originalPath !== undefined,
    changed: side === 'staged' ? diff.text.length > 0 : worktreeChanged,
  })
  return { hunks: block.hunks, unavailable }
}

export async function getFileView(
  repoPath: string,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<FileView> {
  const root = await resolveRepository(repoPath, signal)
  const filePath = requirePathInput(requestedPath, 'path')
  // Sparse-excluded paths never reach the status list, so check the index first.
  const indexEntry = (await getIndexEntries(root, [filePath])).get(filePath)
  if (indexEntry?.sparseExcluded) throw new Error(sparsePathReason(filePath))
  const entry = changedEntry(await getStatus(root, signal), filePath)
  const actualPath = entry.path
  // One cancelled file view must not leave a sibling diff or the gitlink lookup
  // running, so every read is awaited before the rejection escapes. The
  // fingerprint is deliberately not in this batch: a gitlink is a directory, so
  // it has no readable file to scan.
  const reads = [
    changedDiff(root, 'cached', actualPath, signal),
    changedDiff(root, 'worktree', actualPath, signal),
    getHeadGitlinks(root, [actualPath]),
  ] as const
  const [stagedDiff, unstagedDiff, gitlinks] = await Promise.all(reads).catch(
    async (error: unknown) => {
      await Promise.allSettled(reads)
      throw error
    },
  )
  const headGitlink = gitlinks.get(actualPath)
  if (indexEntry?.submodule || headGitlink) {
    // A gitlink has no readable file: show the recorded-commit diff and nothing else.
    return {
      path: filePath,
      stagedDiff: stagedDiff.text,
      unstagedDiff: unstagedDiff.text,
      content: null,
      binary: false,
      fingerprint: indexEntry?.fingerprint ?? headGitlink!,
      conflicted: entry.conflicted,
      truncated: stagedDiff.truncated || unstagedDiff.truncated,
      submodule: true,
      lfs: null,
      hunks: {
        staged: { hunks: [], unavailable: submodulePathReason(filePath) },
        unstaged: { hunks: [], unavailable: submodulePathReason(filePath) },
      },
    }
  }
  const identity = await fileFingerprint(root, actualPath, signal)
  const contentResult = identity.preview
    ? {
        text: identity.binary ? '' : identity.preview.toString('utf8'),
        truncated: identity.truncated,
      }
    : { text: '', truncated: false }
  const untracked = entry.index === '?' || entry.worktree === '?'
  return {
    path: filePath,
    stagedDiff: stagedDiff.text,
    unstagedDiff: untracked && !identity.binary ? contentResult.text : unstagedDiff.text,
    content: identity.binary || !identity.preview ? null : contentResult.text,
    binary: identity.binary,
    fingerprint: identity.fingerprint,
    conflicted: entry.conflicted,
    truncated: stagedDiff.truncated || unstagedDiff.truncated || contentResult.truncated,
    hunks: {
      staged: resolveHunkSide(entry, identity, 'staged', stagedDiff),
      unstaged: resolveHunkSide(entry, identity, 'unstaged', unstagedDiff),
    },
    lfs: identity.preview ? parseLfsPointer(contentResult.text) : null,
  }
}

/**
 * Sparse-excluded and submodule paths are refused before any worktree or index
 * write: one is not a change, and the other is a commit this app does not own.
 */
async function checkFileFingerprint(
  repoPath: string,
  filePath: string,
  expected: string,
): Promise<{ entry: ChangedFile; identity: FileIdentity }> {
  const entry = changedEntry(await getStatus(repoPath), filePath)
  const index = await getIndexEntries(repoPath, [entry.path])
  const headGitlink = (await getHeadGitlinks(repoPath, [entry.path])).has(entry.path)
  const blocked = pathActionBlockReason(index.get(entry.path), entry.path, headGitlink)
  if (blocked) throw new Error(blocked)
  const identity = await fileFingerprint(repoPath, entry.path)
  if (identity.fingerprint !== expected) {
    throw new Error('The file changed since it was opened; refresh before applying this action')
  }
  return { entry, identity }
}

function pathActionBlockReason(
  entry: IndexPathEntry | undefined,
  filePath: string,
  headGitlink: boolean,
): string | null {
  if (entry?.sparseExcluded) return sparsePathReason(filePath)
  if (entry?.submodule || headGitlink) return submodulePathReason(filePath)
  return null
}

async function materializeGitWorktreePath(
  repoPath: string,
  relativePath: string,
  args: string[],
): Promise<{ root: string; path: string | null }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'git-stacks-worktree-'))
  const worktree = path.join(root, 'worktree')
  const destination = path.join(worktree, relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  try {
    await runGit(repoPath, args, { GIT_WORK_TREE: worktree })
    try {
      const info = await fs.lstat(destination)
      if (!info.isFile()) throw new Error('Git produced a non-file path during file resolution')
      return { root, path: destination }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { root, path: null }
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}

async function restoreQuarantinedFile(
  backupPath: string,
  targetPath: string,
  assertLocations: () => Promise<unknown>,
): Promise<void> {
  await assertLocations()
  const info = await fs.lstat(backupPath)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('The changed path cannot be restored safely')
  }
  await assertLocations()
  await fs.link(backupPath, targetPath)
  await assertLocations()
  await fs.unlink(backupPath)
}
interface FileActionIdentity {
  dev: string
  ino: string
}

type FileActionPhase = 'prepared' | 'quarantined' | 'committed'

interface FileActionJournal {
  version: 1
  transactionId: string
  ownerPid: number
  phase: FileActionPhase
  repoPath: string
  relativePath: string
  stagingName: string
  stagingIdentity: FileActionIdentity
  parentDirectories: RepositoryDirectoryIdentity[]
  originalIdentity: FileActionIdentity | null
  replacementIdentity: FileActionIdentity | null
}

const FILE_ACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function fileActionIdentity(info: Stats): FileActionIdentity {
  return { dev: String(info.dev), ino: String(info.ino) }
}

function isFileActionIdentity(value: unknown): value is FileActionIdentity {
  return (
    isRecord(value) &&
    typeof value.dev === 'string' &&
    /^\d+$/u.test(value.dev) &&
    typeof value.ino === 'string' &&
    /^\d+$/u.test(value.ino)
  )
}

function sameFileActionIdentity(
  left: FileActionIdentity | null,
  right: FileActionIdentity | null,
): boolean {
  return left?.dev === right?.dev && left?.ino === right?.ino
}

async function optionalFileActionIdentity(filePath: string): Promise<FileActionIdentity | null> {
  let info: Stats
  try {
    info = await fs.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('The changed path is not a regular file; refusing file recovery')
  }
  return fileActionIdentity(info)
}

function parseFileActionJournal(value: unknown): FileActionJournal {
  if (!isRecord(value)) throw new Error('The interrupted file action journal is invalid')
  const validParentDirectories =
    Array.isArray(value.parentDirectories) &&
    value.parentDirectories.length > 0 &&
    value.parentDirectories.length <= 256 &&
    value.parentDirectories.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.relativePath === 'string' &&
        !path.isAbsolute(entry.relativePath) &&
        (entry.relativePath === '' ||
          !repositoryPathParts(entry.relativePath).some(
            (part) => !part || part === '.' || part === '..',
          )) &&
        typeof entry.dev === 'string' &&
        /^\d+$/u.test(entry.dev) &&
        typeof entry.ino === 'string' &&
        /^\d+$/u.test(entry.ino),
    )
  const validRelativePath =
    typeof value.relativePath === 'string' &&
    value.relativePath.length > 0 &&
    !path.isAbsolute(value.relativePath) &&
    !repositoryPathParts(value.relativePath).some((part) => !part || part === '.' || part === '..')
  if (
    value.version !== 1 ||
    typeof value.transactionId !== 'string' ||
    !FILE_ACTION_ID_PATTERN.test(value.transactionId) ||
    typeof value.ownerPid !== 'number' ||
    !Number.isSafeInteger(value.ownerPid) ||
    value.ownerPid < 0 ||
    !['prepared', 'quarantined', 'committed'].includes(value.phase as string) ||
    typeof value.repoPath !== 'string' ||
    !path.isAbsolute(value.repoPath) ||
    !validRelativePath ||
    value.stagingName !== `.git-stacks-${value.transactionId}` ||
    !isFileActionIdentity(value.stagingIdentity) ||
    !validParentDirectories ||
    !(value.originalIdentity === null || isFileActionIdentity(value.originalIdentity)) ||
    !(value.replacementIdentity === null || isFileActionIdentity(value.replacementIdentity))
  ) {
    throw new Error('The interrupted file action journal is invalid')
  }
  return {
    version: 1,
    transactionId: value.transactionId,
    ownerPid: value.ownerPid,
    phase: value.phase as FileActionPhase,
    repoPath: value.repoPath,
    relativePath: value.relativePath as string,
    stagingName: value.stagingName,
    stagingIdentity: value.stagingIdentity,
    parentDirectories: value.parentDirectories as RepositoryDirectoryIdentity[],
    originalIdentity: value.originalIdentity,
    replacementIdentity: value.replacementIdentity,
  }
}

async function fileActionJournalDirectory(
  repoPath: string,
  create: boolean,
): Promise<string | null> {
  const gitDirectory = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-dir']))
  if (!gitDirectory) throw new Error('Git did not resolve its metadata directory')
  const canonicalGitDirectory = await fs.realpath(path.resolve(repoPath, gitDirectory))
  const gitDirectoryInfo = await fs.stat(canonicalGitDirectory)
  if (!gitDirectoryInfo.isDirectory()) throw new Error('Git metadata path is not a directory')
  const directory = path.join(canonicalGitDirectory, 'git-stacks-file-actions')
  if (create) {
    try {
      await fs.mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  try {
    const info = await fs.lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('The file action journal directory is not safe')
    }
    return directory
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeFileActionJournal(
  directory: string,
  journal: FileActionJournal,
  exclusive = false,
): Promise<string> {
  const journalPath = path.join(directory, `${journal.transactionId}.json`)
  const temporaryPath = path.join(directory, `${journal.transactionId}.${randomUUID()}.tmp`)
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal), 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
  await handle.close()
  try {
    if (exclusive) await fs.link(temporaryPath, journalPath)
    else await fs.rename(temporaryPath, journalPath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
  return journalPath
}

async function readFileActionJournal(journalPath: string): Promise<FileActionJournal> {
  let info: Stats
  try {
    info = await fs.lstat(journalPath)
  } catch (error) {
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
    throw new Error('The interrupted file action journal is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(await fs.readFile(journalPath, 'utf8'))
  } catch {
    throw new Error('The interrupted file action journal is unreadable')
  }
  return parseFileActionJournal(value)
}

async function assertFileActionParents(
  repoPath: string,
  journal: FileActionJournal,
): Promise<string> {
  if (journal.repoPath !== repoPath) {
    throw new Error('The interrupted file action belongs to a different working tree')
  }
  const current = await ensureRepositoryParentDirectories(repoPath, journal.relativePath, false)
  if (
    current.directories.length !== journal.parentDirectories.length ||
    current.directories.some((directory, index) => {
      const recorded = journal.parentDirectories[index]
      return (
        directory.relativePath !== recorded.relativePath ||
        directory.dev !== recorded.dev ||
        directory.ino !== recorded.ino
      )
    })
  ) {
    throw new Error('A parent directory changed before file recovery; refusing to follow it')
  }
  return current.targetPath
}

async function assertFileActionLocations(
  repoPath: string,
  journal: FileActionJournal,
  stagingDirectory: string,
): Promise<{ targetPath: string; backupPath: string; replacementPath: string }> {
  const targetPath = await assertFileActionParents(repoPath, journal)
  const stagingInfo = await fs.lstat(stagingDirectory)
  if (
    stagingInfo.isSymbolicLink() ||
    !stagingInfo.isDirectory() ||
    !sameFileActionIdentity(fileActionIdentity(stagingInfo), journal.stagingIdentity)
  ) {
    throw new Error('The file action staging directory changed; refusing recovery')
  }
  return {
    targetPath,
    backupPath: path.join(stagingDirectory, 'original'),
    replacementPath: path.join(stagingDirectory, 'replacement'),
  }
}

async function removeFileActionStaging(
  repoPath: string,
  journal: FileActionJournal,
  stagingDirectory: string,
): Promise<void> {
  const checkLocations = async () => assertFileActionLocations(repoPath, journal, stagingDirectory)
  await assertFileActionParents(repoPath, journal)
  let stagingInfo: Stats
  try {
    stagingInfo = await fs.lstat(stagingDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (
    stagingInfo.isSymbolicLink() ||
    !stagingInfo.isDirectory() ||
    !sameFileActionIdentity(fileActionIdentity(stagingInfo), journal.stagingIdentity)
  ) {
    throw new Error('The file action staging directory changed; refusing recovery')
  }
  for (const [name, expected] of [
    ['original', journal.originalIdentity],
    ['replacement', journal.replacementIdentity],
  ] as const) {
    const filePath = path.join(stagingDirectory, name)
    await checkLocations()
    const actual = await optionalFileActionIdentity(filePath)
    if (actual === null) continue
    if (!expected || !sameFileActionIdentity(actual, expected)) {
      throw new Error(
        `Unexpected file in ${path.relative(repoPath, stagingDirectory)}; preserving it`,
      )
    }
    await checkLocations()
    const beforeUnlink = await optionalFileActionIdentity(filePath)
    if (!sameFileActionIdentity(beforeUnlink, expected)) {
      throw new Error('A staged file changed during cleanup; preserving it')
    }
    await fs.unlink(filePath)
  }
  await checkLocations()
  if ((await fs.readdir(stagingDirectory)).length > 0) {
    throw new Error(`Unexpected files remain in ${path.relative(repoPath, stagingDirectory)}`)
  }
  await checkLocations()
  await fs.rmdir(stagingDirectory)
}

async function removeFileActionJournal(
  directory: string,
  journalPath: string,
  transactionId: string,
): Promise<void> {
  let current: FileActionJournal
  try {
    current = await readFileActionJournal(journalPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (current.transactionId !== transactionId) {
    throw new Error('The file action journal changed during recovery')
  }
  const info = await fs.lstat(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('The file action journal directory changed during recovery')
  }
  await fs.unlink(journalPath)
}

async function recoverFileActionJournal(
  repoPath: string,
  directory: string,
  journalPath: string,
  journal: FileActionJournal,
): Promise<void> {
  if (journal.repoPath !== repoPath) {
    throw new Error('The interrupted file action belongs to a different working tree')
  }
  if (isProcessRunning(journal.ownerPid)) {
    throw new Error('Another file update is in progress; retry after it completes')
  }
  const targetPath = await assertFileActionParents(repoPath, journal)
  const stagingDirectory = path.join(path.dirname(targetPath), journal.stagingName)
  const backupPath = path.join(stagingDirectory, 'original')
  const replacementPath = path.join(stagingDirectory, 'replacement')
  const journalIdentity = journal.transactionId
  const journalLocations = async () =>
    assertFileActionLocations(repoPath, journal, stagingDirectory)
  let stagingExists = true
  try {
    const info = await fs.lstat(stagingDirectory)
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !sameFileActionIdentity(fileActionIdentity(info), journal.stagingIdentity)
    ) {
      throw new Error('The file action staging directory changed; refusing recovery')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    stagingExists = false
  }
  const targetIdentity = await optionalFileActionIdentity(targetPath)
  if (!stagingExists) {
    const committedDeletion =
      journal.phase === 'committed' &&
      journal.replacementIdentity === null &&
      targetIdentity === null
    const targetIsOriginal =
      journal.originalIdentity !== null &&
      sameFileActionIdentity(targetIdentity, journal.originalIdentity)
    const targetIsReplacement =
      journal.replacementIdentity !== null &&
      sameFileActionIdentity(targetIdentity, journal.replacementIdentity)
    if (
      journal.originalIdentity &&
      !targetIsOriginal &&
      !targetIsReplacement &&
      !committedDeletion
    ) {
      throw new Error('The quarantined original is missing; refusing file recovery')
    }
    await removeFileActionJournal(directory, journalPath, journalIdentity)
    return
  }

  await journalLocations()
  const [backupIdentity, replacementIdentity] = await Promise.all([
    optionalFileActionIdentity(backupPath),
    optionalFileActionIdentity(replacementPath),
  ])
  if (
    journal.replacementIdentity &&
    sameFileActionIdentity(targetIdentity, journal.replacementIdentity)
  ) {
    if (
      replacementIdentity &&
      !sameFileActionIdentity(replacementIdentity, journal.replacementIdentity)
    ) {
      throw new Error('The staged replacement changed; refusing file recovery')
    }
    if (backupIdentity && !sameFileActionIdentity(backupIdentity, journal.originalIdentity)) {
      throw new Error('The quarantined original changed; preserving it for manual recovery')
    }
    if (backupIdentity) {
      await journalLocations()
      await fs.unlink(backupPath)
    }
    await removeFileActionStaging(repoPath, journal, stagingDirectory)
    await removeFileActionJournal(directory, journalPath, journalIdentity)
    return
  }
  if (
    journal.originalIdentity &&
    sameFileActionIdentity(targetIdentity, journal.originalIdentity)
  ) {
    if (backupIdentity && !sameFileActionIdentity(backupIdentity, journal.originalIdentity)) {
      throw new Error('The quarantined original changed; preserving it for manual recovery')
    }
    if (backupIdentity) {
      await journalLocations()
      await fs.unlink(backupPath)
    }
    await removeFileActionStaging(repoPath, journal, stagingDirectory)
    await removeFileActionJournal(directory, journalPath, journalIdentity)
    return
  }
  if (targetIdentity === null) {
    if (journal.phase === 'committed' && journal.replacementIdentity === null) {
      if (backupIdentity && !sameFileActionIdentity(backupIdentity, journal.originalIdentity)) {
        throw new Error('The quarantined original changed; preserving it for manual recovery')
      }
      if (backupIdentity) {
        await journalLocations()
        await fs.unlink(backupPath)
      }
      await removeFileActionStaging(repoPath, journal, stagingDirectory)
      await removeFileActionJournal(directory, journalPath, journalIdentity)
      return
    }
    if (
      journal.originalIdentity &&
      sameFileActionIdentity(backupIdentity, journal.originalIdentity)
    ) {
      await restoreQuarantinedFile(backupPath, targetPath, journalLocations)
      await removeFileActionStaging(repoPath, journal, stagingDirectory)
      await removeFileActionJournal(directory, journalPath, journalIdentity)
      return
    }
    if (journal.originalIdentity === null && backupIdentity === null) {
      await removeFileActionStaging(repoPath, journal, stagingDirectory)
      await removeFileActionJournal(directory, journalPath, journalIdentity)
      return
    }
    throw new Error('The quarantined original is missing; refusing file recovery')
  }
  if (journal.originalIdentity === null && backupIdentity === null) {
    await removeFileActionStaging(repoPath, journal, stagingDirectory)
    await removeFileActionJournal(directory, journalPath, journalIdentity)
    return
  }
  throw new Error(
    `A concurrent file prevents recovery; prior contents remain at ${path.relative(repoPath, backupPath)}`,
  )
}

async function recoverFileActionJournals(repoPath: string): Promise<void> {
  const directory = await fileActionJournalDirectory(repoPath, false)
  if (!directory) return
  const names = await fs.readdir(directory)
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const journalPath = path.join(directory, name)
    const journal = await readFileActionJournal(journalPath)
    if (name !== `${journal.transactionId}.json`) {
      throw new Error('The interrupted file action journal name is invalid')
    }
    await recoverFileActionJournal(repoPath, directory, journalPath, journal)
  }
}

async function replaceCheckedFile(
  repoPath: string,
  relativePath: string,
  expected: FileIdentity,
  sourcePath: string | null,
  content?: string,
): Promise<void> {
  const { targetPath, directories } = await ensureRepositoryParentDirectories(
    repoPath,
    relativePath,
  )
  const transactionId = randomUUID()
  const stagingName = `.git-stacks-${transactionId}`
  const stagingDirectory = path.join(path.dirname(targetPath), stagingName)
  const backupPath = path.join(stagingDirectory, 'original')
  const replacementPath =
    sourcePath !== null || content !== undefined ? path.join(stagingDirectory, 'replacement') : null
  let stagingIdentity: FileActionIdentity | null = null
  let journalDirectory: string | null = null
  let journalPath: string | null = null
  let journal: FileActionJournal | null = null
  let journalCreated = false
  let movedOriginal = false
  let preserveStagingDirectory = false
  let commitRecorded = false

  const assertParents = () => assertRepositoryParentDirectories(repoPath, relativePath, directories)
  const assertLocations = async () => {
    await assertParents()
    const info = await fs.lstat(stagingDirectory)
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !stagingIdentity ||
      !sameFileActionIdentity(fileActionIdentity(info), stagingIdentity)
    ) {
      throw new Error('The file action staging directory changed; refusing to continue')
    }
  }

  try {
    await assertParents()
    await fs.mkdir(stagingDirectory, { mode: 0o700 })
    const stagingInfo = await fs.lstat(stagingDirectory)
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) {
      throw new Error('Could not create a safe file action staging directory')
    }
    stagingIdentity = fileActionIdentity(stagingInfo)
    await assertLocations()

    if (sourcePath !== null) {
      const sourceInfo = await fs.stat(sourcePath)
      if (!sourceInfo.isFile()) throw new Error('The replacement path is not a regular file')
      await assertLocations()
      await fs.copyFile(sourcePath, replacementPath!, fsConstants.COPYFILE_EXCL)
      await assertLocations()
      await fs.chmod(replacementPath!, sourceInfo.mode & 0o777)
    } else if (content !== undefined) {
      await assertLocations()
      await fs.writeFile(replacementPath!, content, {
        encoding: 'utf8',
        mode: expected.stat ? expected.stat.mode & 0o777 : 0o666,
        flag: 'wx',
      })
      if (expected.stat) {
        await assertLocations()
        await fs.chmod(replacementPath!, expected.stat.mode & 0o777)
      }
    }

    const originalIdentity = await optionalFileActionIdentity(targetPath)
    const replacementIdentity = replacementPath
      ? await optionalFileActionIdentity(replacementPath)
      : null
    if (replacementPath && !replacementIdentity) {
      throw new Error('The replacement file was not created')
    }
    const resolvedJournalDirectory = await fileActionJournalDirectory(repoPath, true)
    if (!resolvedJournalDirectory)
      throw new Error('Could not create the file action journal directory')
    journalDirectory = resolvedJournalDirectory
    journal = {
      version: 1,
      transactionId,
      ownerPid: process.pid,
      phase: 'prepared',
      repoPath,
      relativePath,
      stagingName,
      stagingIdentity,
      parentDirectories: directories,
      originalIdentity,
      replacementIdentity,
    }
    journalPath = path.join(resolvedJournalDirectory, `${transactionId}.json`)
    await writeFileActionJournal(resolvedJournalDirectory, journal, true)
    journalCreated = true

    await assertLocations()
    const beforeRename = await optionalFileActionIdentity(targetPath)
    if (!sameFileActionIdentity(beforeRename, originalIdentity)) {
      throw new Error('The file changed during the action; refresh before retrying')
    }
    if (originalIdentity) {
      await assertLocations()
      try {
        await fs.rename(targetPath, backupPath)
        movedOriginal = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (movedOriginal) {
      journal = { ...journal, phase: 'quarantined' }
      await writeFileActionJournal(resolvedJournalDirectory, journal)
    }

    await assertLocations()
    const current = await fileFingerprintAt(
      repoPath,
      relativePath,
      movedOriginal ? backupPath : targetPath,
    )
    if (!sameFileMutationIdentity(expected, current)) {
      throw new Error('The file changed during the action; refresh before retrying')
    }

    if (replacementPath) {
      await assertLocations()
      const stagedReplacement = await optionalFileActionIdentity(replacementPath)
      if (!sameFileActionIdentity(stagedReplacement, replacementIdentity)) {
        throw new Error('The staged replacement changed during the action')
      }
      if ((await optionalFileActionIdentity(targetPath)) !== null) {
        preserveStagingDirectory = movedOriginal
        throw new Error('A concurrent file appeared during the action')
      }
      try {
        await fs.link(replacementPath, targetPath)
      } catch (error) {
        if (movedOriginal && (error as NodeJS.ErrnoException).code === 'EEXIST') {
          preserveStagingDirectory = true
          throw new Error('A concurrent file appeared during the action')
        }
        throw error
      }
    } else if (movedOriginal && (await optionalFileActionIdentity(targetPath)) !== null) {
      preserveStagingDirectory = true
      throw new Error('A concurrent file appeared during the action')
    }

    journal = { ...journal, phase: 'committed' }
    await writeFileActionJournal(resolvedJournalDirectory, journal)
    commitRecorded = true
    if (movedOriginal) {
      await assertLocations()
      const currentBackup = await optionalFileActionIdentity(backupPath)
      if (!sameFileActionIdentity(currentBackup, originalIdentity)) {
        throw new Error('The quarantined original changed during the action')
      }
      await assertLocations()
      await fs.unlink(backupPath)
      movedOriginal = false
    }
    await removeFileActionStaging(repoPath, journal, stagingDirectory)
    journal = { ...journal, ownerPid: 0 }
    await writeFileActionJournal(resolvedJournalDirectory, journal)
    await removeFileActionJournal(resolvedJournalDirectory, journalPath, transactionId)
    journalCreated = false
  } catch (error) {
    if (!journalCreated && journalPath) {
      try {
        const persisted = await readFileActionJournal(journalPath)
        if (persisted.transactionId === transactionId) {
          journal = persisted
          journalCreated = true
        }
      } catch {}
    }
    if (journalCreated && journal && journalDirectory && journalPath) {
      if (!commitRecorded) {
        try {
          commitRecorded = (await readFileActionJournal(journalPath)).phase === 'committed'
        } catch {}
      }
      if (commitRecorded) {
        const recoverable = { ...journal, phase: 'committed' as const, ownerPid: 0 }
        await writeFileActionJournal(journalDirectory, recoverable).catch(() => {})
        try {
          await recoverFileActionJournal(repoPath, journalDirectory, journalPath, recoverable)
          return
        } catch (recoveryError) {
          throw new Error(
            `${commandDetail(error)}; committed file cleanup needs recovery: ${commandDetail(recoveryError)}`,
          )
        }
      }

      let targetIdentity: FileActionIdentity | null = null
      let backupIdentity: FileActionIdentity | null = null
      try {
        await assertLocations()
        targetIdentity = await optionalFileActionIdentity(targetPath)
        backupIdentity = await optionalFileActionIdentity(backupPath)
      } catch {
        preserveStagingDirectory = true
      }
      if (
        !preserveStagingDirectory &&
        journal.replacementIdentity &&
        sameFileActionIdentity(targetIdentity, journal.replacementIdentity)
      ) {
        try {
          await assertLocations()
          await fs.unlink(targetPath)
          targetIdentity = null
        } catch {
          preserveStagingDirectory = true
        }
      }
      if (!preserveStagingDirectory && journal.originalIdentity) {
        if (backupIdentity && sameFileActionIdentity(backupIdentity, journal.originalIdentity)) {
          if (targetIdentity === null) {
            try {
              await restoreQuarantinedFile(backupPath, targetPath, assertLocations)
              movedOriginal = false
            } catch {
              preserveStagingDirectory = true
            }
          } else if (sameFileActionIdentity(targetIdentity, journal.originalIdentity)) {
            try {
              await assertLocations()
              await fs.unlink(backupPath)
              movedOriginal = false
            } catch {
              preserveStagingDirectory = true
            }
          } else {
            preserveStagingDirectory = true
          }
        } else if (
          movedOriginal &&
          !sameFileActionIdentity(targetIdentity, journal.originalIdentity)
        ) {
          preserveStagingDirectory = true
        }
      } else if (
        !preserveStagingDirectory &&
        !journal.originalIdentity &&
        backupIdentity !== null
      ) {
        preserveStagingDirectory = true
      }
      if (!preserveStagingDirectory) {
        try {
          await removeFileActionStaging(repoPath, journal, stagingDirectory)
          await removeFileActionJournal(journalDirectory, journalPath, transactionId)
          journalCreated = false
        } catch {
          preserveStagingDirectory = true
        }
      }
      if (preserveStagingDirectory) {
        await writeFileActionJournal(journalDirectory, {
          ...journal,
          ownerPid: 0,
        }).catch(() => {})
        throw new Error(
          `${commandDetail(error)}; prior contents are preserved at ${path.relative(repoPath, backupPath)}`,
        )
      }
    } else if (stagingIdentity) {
      try {
        await assertParents()
        const info = await fs.lstat(stagingDirectory)
        if (
          !info.isSymbolicLink() &&
          info.isDirectory() &&
          sameFileActionIdentity(fileActionIdentity(info), stagingIdentity)
        ) {
          await fs.rm(stagingDirectory, { recursive: true, force: true })
        }
      } catch {}
    }
    throw error
  }
}

export async function runDiscardFile(
  repoPath: string,
  filePath: string,
  fingerprint: string,
): Promise<ActionResult> {
  const root = await resolveRepository(repoPath)
  await recoverFileActionJournals(root)
  const { entry, identity } = await checkFileFingerprint(root, filePath, fingerprint)
  if (entry.conflicted) throw new Error('Resolve conflicted files instead of discarding them')
  if (entry.index === '?' || entry.worktree === '?') {
    await replaceCheckedFile(root, entry.path, identity, null)
    return { message: `Removed untracked file ${entry.path}` }
  }
  const materialized = await materializeGitWorktreePath(root, entry.path, [
    '--literal-pathspecs',
    'restore',
    '--worktree',
    '--',
    entry.path,
  ])
  try {
    await replaceCheckedFile(root, entry.path, identity, materialized.path)
  } finally {
    await fs.rm(materialized.root, { recursive: true, force: true })
  }
  return { message: `Discarded unstaged changes in ${entry.path}` }
}

interface ConflictStageEntry {
  stage: number
  oid: string
}
/** Index stage number (1 base, 2 current, 3 incoming) to the content Git holds. */
interface ConflictSides {
  [stage: number]: { text: string | null; binary: boolean; truncated: boolean }
}

/** Keep the exact staged index bytes with the entries used to render a conflict. */
async function conflictIndex(
  root: string,
  relativePath: string,
): Promise<{ stages: ConflictStageEntry[]; fingerprint: string }> {
  const output = await runGit(root, [
    '--literal-pathspecs',
    'ls-files',
    '-u',
    '-z',
    '--',
    relativePath,
  ])
  const stages: ConflictStageEntry[] = []
  for (const token of output.split('\0')) {
    if (!token) continue
    const separator = token.indexOf('\t')
    if (separator < 0) throw new Error('Git returned an unmerged entry without a path')
    const [mode, oid, stage] = token.slice(0, separator).split(/\s+/u)
    if (!/^1[0-9]{5}$/u.test(mode) || !/^[0-9a-f]{40,64}$/u.test(oid) || !/^[123]$/u.test(stage)) {
      throw new Error('Git returned a malformed unmerged index entry')
    }
    stages.push({ stage: Number(stage), oid })
  }
  return { stages, fingerprint: createHash('sha256').update(output).digest('hex') }
}

/** Read every byte to classify a stage, but retain only a bounded text preview. */
async function readConflictBlob(
  root: string,
  oid: string,
): Promise<{ text: string | null; binary: boolean; truncated: boolean }> {
  const runtime = await resolveGitRuntime()
  // ES2022's Promise typings do not expose withResolvers; Git streams settle
  // this promise from child-process events.
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, ['cat-file', 'blob', oid], {
      cwd: root,
      env: gitCommandEnvironment(runtime, commandEnvironment()),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const chunks: Buffer[] = []
    let retained = 0
    let totalBytes = 0
    let binary = false
    let failure = ''
    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (chunk.includes(0)) binary = true
      if (!binary) {
        try {
          decoder.decode(chunk, { stream: true })
        } catch {
          binary = true
        }
      }
      if (retained < MAX_FILE_BYTES) {
        const take = Math.min(MAX_FILE_BYTES - retained, chunk.length)
        chunks.push(Buffer.from(chunk.subarray(0, take)))
        retained += take
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      failure = (failure + chunk).slice(-4096)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(failure.trim() || `git cat-file failed for ${oid}`))
        return
      }
      if (!binary) {
        try {
          decoder.decode()
        } catch {
          binary = true
        }
      }
      const truncated = totalBytes > MAX_FILE_BYTES
      const preview = Buffer.concat(chunks)
      resolve({
        text: binary
          ? null
          : new TextDecoder('utf-8', { fatal: true }).decode(preview, { stream: truncated }),
        binary,
        truncated,
      })
    })
  })
}

/**
 * A revision read from Git. Command output keeps the trailing newline, and a
 * revision argument carrying one is not a revision, so it is dropped here once
 * instead of at every use.
 */
async function gitRevision(root: string, args: string[]): Promise<string | null> {
  const output = await tryGit(root, args)
  return output ? stripTrailingNewline(output) : null
}

function commitSummary(root: string, ref: string): Promise<string | null> {
  return tryGit(root, ['show', '-s', '--format=%h %s', '--end-of-options', ref])
}

interface ConflictContext {
  operation: GitOperation | null
  incomingRef: string | null
  incomingSubject: string | null
  /** What each side changed against this base, for rename evidence. */
  sides: { side: 'current' | 'incoming'; base: string; target: string }[]
  stash: { ref: string; message: string } | null
  stashAvailable: boolean
}

/**
 * What Git itself recorded for the operation in progress. A stash apply leaves
 * no state file, so its side is only claimed when stage 3 is found in a stash
 * entry; otherwise the resolver says the operation is unknown instead of
 * guessing from the worktree.
 */
async function conflictContext(
  root: string,
  relativePath: string,
  stages: ConflictStageEntry[],
): Promise<ConflictContext> {
  const state = await getOperationState(root)
  const incomingRef =
    (state.rebase
      ? await gitRevision(root, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          'REBASE_HEAD^{commit}',
        ])
      : null) ??
    (state.operation === 'merge'
      ? await gitRevision(root, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          'MERGE_HEAD^{commit}',
        ])
      : null) ??
    (state.operation === 'cherryPick'
      ? await gitRevision(root, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          'CHERRY_PICK_HEAD^{commit}',
        ])
      : null) ??
    (state.operation === 'revert'
      ? await gitRevision(root, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          'REVERT_HEAD^{commit}',
        ])
      : null)
  const incomingSubject = incomingRef ? await commitSummary(root, incomingRef) : null
  const sides: ConflictContext['sides'] = []
  if (incomingRef) {
    if (state.operation === 'merge') {
      const base = await gitRevision(root, ['merge-base', 'HEAD', incomingRef])
      if (base) {
        sides.push({ side: 'current', base, target: 'HEAD' })
        sides.push({ side: 'incoming', base, target: incomingRef })
      }
    } else {
      sides.push({ side: 'incoming', base: `${incomingRef}^`, target: incomingRef })
    }
  }
  const incomingStage = stages.find((stage) => stage.stage === 3)
  const stashes = (await getStashes(root)).map((entry) => ({
    ref: entry.ref,
    message: entry.message.replace(/^[^:]*:\s*/u, ''),
    oid: entry.oid,
  }))
  let stash: ConflictContext['stash'] = null
  if (!state.operation && incomingStage) {
    for (const entry of stashes) {
      const listing = await tryGit(root, [
        '--literal-pathspecs',
        'ls-tree',
        '-z',
        '--end-of-options',
        entry.oid,
        '--',
        relativePath,
      ])
      const matched = listing
        ?.split('\0')
        .some((token) => token.split('\t')[0]?.split(/\s+/u)[2] === incomingStage.oid)
      if (matched) {
        stash = { ref: entry.ref, message: entry.message }
        break
      }
    }
  }
  return {
    operation: state.operation,
    incomingRef,
    incomingSubject: incomingSubject ? stripTrailingNewline(incomingSubject) : null,
    sides,
    stash,
    stashAvailable: stashes.length > 0,
  }
}

/** Report only renames that Git's similarity detection actually identified. */
async function conflictMoves(
  root: string,
  relativePath: string,
  context: ConflictContext,
): Promise<ConflictMove[]> {
  const moves: ConflictMove[] = []
  for (const side of context.sides) {
    const listing = await tryGit(root, [
      'diff',
      '--name-status',
      '-z',
      '-M',
      '--no-ext-diff',
      '--end-of-options',
      side.base,
      side.target,
    ])
    if (!listing) continue
    const fields = listing.split('\0')
    for (let index = 0; index < fields.length - 1; ) {
      const status = fields[index++]
      const from = fields[index++]
      if (status.startsWith('R')) {
        const to = fields[index++]
        if (from === relativePath || to === relativePath) {
          moves.push({ from, to, side: side.side })
        }
      }
    }
  }
  return moves
}

/** The tool `git mergetool --tool=` names, the name to show, and why. */
interface ResolvedMergeTool {
  /** The Git tool id, or null when no tool on this machine can run. */
  id: string | null
  /** The name the user chose, or Git's own tool name. */
  label: string
  /** What the surface says about the tool, available or not. */
  reason: string
}

/**
 * The merge tool to run for one file, resolved from the program name the
 * Settings surface stores.
 *
 * `git mergetool --tool=` takes a Git tool id, and a program name is not always
 * one: Git's `bc3` backend is what launches `bcompare`, and Git ships no backend
 * at all for an editor. An editor is only usable as a merge tool once the
 * machine's own configuration defines `mergetool.<name>.cmd` for it, so that
 * command — not the mere presence of the executable — is what makes such a tool
 * available here. A name with no applicable backend is reported as unavailable
 * with its reason, so the surface never offers a tool that fails the moment a
 * conflict is resolved.
 *
 * A tool Git itself named (`merge.tool`, `GIT_MERGE_TOOL`) is already an id and
 * is passed through as one.
 */
async function resolveMergeTool(
  root: string,
  configured: string | null | undefined,
): Promise<ResolvedMergeTool> {
  if (!configured) {
    const fromGit = process.env.GIT_MERGE_TOOL || (await getConfigValue(root, 'merge.tool'))
    if (!fromGit) {
      return {
        id: null,
        label: '',
        reason:
          'No merge tool is configured. Choose one in Settings, or set merge.tool or GIT_MERGE_TOOL in Git.',
      }
    }
    return {
      id: fromGit,
      label: fromGit,
      reason: `Runs the merge tool ${fromGit} Git is configured with on this file.`,
    }
  }
  const backend = MERGE_TOOL_BACKENDS[configured as SupportedMergeTool]
  if (backend) {
    return {
      id: backend,
      label: configured,
      reason: `Runs ${configured} on this file as Git's ${backend} merge tool.`,
    }
  }
  if (!(SUPPORTED_MERGE_TOOLS as readonly string[]).includes(configured)) {
    return {
      id: null,
      label: configured,
      reason: `${configured} is not a supported merge tool.`,
    }
  }
  // A custom tool is defined by `mergetool.<name>.cmd`. `mergetool.<name>.path`
  // only replaces the executable of a tool Git already knows how to invoke, so
  // a name with a path and no command is not a tool Git can run: `mergetool`
  // stops at "mergetool.<name>.cmd not set". The command is what is checked.
  const custom = await getConfigValue(root, `mergetool.${configured}.cmd`)
  if (!custom) {
    return {
      id: null,
      label: configured,
      reason: `Git has no ${configured} merge tool. Add mergetool.${configured}.cmd to your Git configuration, or choose a tool Git ships.`,
    }
  }
  return {
    id: configured,
    label: configured,
    reason: `Runs the merge tool ${configured} your Git configuration defines.`,
  }
}

/**
 * `toolOverride` is the merge tool the Settings surface configured. It takes
 * precedence over the environment and over Git's own configuration, because it
 * is the answer the user gave in this app.
 */
export async function getConflictView(
  repoPath: string,
  requestedPath: string,
  toolOverride?: string | null,
): Promise<ConflictFile> {
  const root = await resolveRepository(repoPath)
  await recoverFileActionJournals(root)
  const entry = changedEntry(await getStatus(root), requirePathInput(requestedPath, 'path'))
  if (!entry.conflicted) throw new Error('The selected file has no unresolved conflict')
  const relativePath = entry.path
  await safeRepositoryPath(root, relativePath)
  const captured = await conflictIndex(root, relativePath)
  const stages = captured.stages
  if (!stages.length) throw new Error('The selected file has no unresolved conflict')
  const context = await conflictContext(root, relativePath, stages)
  const [identity, currentBranch, moves] = await Promise.all([
    fileFingerprint(root, relativePath),
    getCurrentBranch(root),
    conflictMoves(root, relativePath, context),
  ])
  const sides: ConflictSides = {}
  await Promise.all(
    stages.map(async (stage) => {
      sides[stage.stage] = await readConflictBlob(root, stage.oid)
    }),
  )
  if (captured.fingerprint !== identity.indexFingerprint) {
    throw new Error('The index changed while the conflict was being read; refresh and retry')
  }
  const worktree = identity.binary || !identity.preview ? null : identity.preview.toString('utf8')
  const segments = worktree && !identity.truncated ? parseConflictSegments(worktree) : []
  const stageNumbers = stages.map((stage) => stage.stage)
  const tool = await resolveMergeTool(root, toolOverride)
  const binary = identity.binary || Object.values(sides).some((side) => side.binary)
  const stagePreviewTruncated = stages
    .filter((stage) => sides[stage.stage].truncated)
    .map((stage) => stage.stage)
  return {
    path: relativePath,
    kind: conflictKind(stageNumbers, moves.length > 0),
    stages: stageNumbers,
    binary,
    labels: conflictLabels({
      operation: context.operation,
      currentBranch,
      incomingSubject: context.incomingSubject,
      incomingRef: context.incomingRef,
      stash: context.stash,
      stashAvailable: context.stashAvailable,
    }),
    base: sides[1]?.text ?? null,
    current: sides[2]?.text ?? null,
    incoming: sides[3]?.text ?? null,
    worktree,
    worktreePresent: identity.stat !== null,
    regions: conflictRegions(segments),
    moves,
    truncated: identity.truncated || stagePreviewTruncated.length > 0,
    stagePreviewTruncated,
    fingerprint: identity.fingerprint,
    mergeTool: tool.id
      ? { available: true, tool: tool.label, reason: tool.reason }
      : { available: false, tool: null, reason: tool.reason },
  }
}

/**
 * Put the chosen side, both sides, or nothing in the worktree. Ordinary side
 * selection goes through Git's index so file modes and binary content survive.
 * For divergent renames Git may instead put a synthesized, marker-bearing
 * merge result in both index stages; recover the actual selected side from
 * its recorded rename destination in the corresponding commit.
 * Nothing is staged here.
 */
async function writeConflictChoice(
  root: string,
  relativePath: string,
  choice: ConflictChoice,
  sides: ConflictSides,
  identity: FileIdentity,
  stages: ConflictStageEntry[],
): Promise<void> {
  if (choice === 'delete') {
    await replaceCheckedFile(root, relativePath, identity, null)
    return
  }
  if (choice === 'both') {
    const current = sides[2]?.text
    const incoming = sides[3]?.text
    if (current === null || current === undefined || incoming === null || incoming === undefined) {
      throw new Error('Keeping both copies needs a version of the file on each side')
    }
    if (hasConflictMarkers(current) || hasConflictMarkers(incoming)) {
      throw new Error('A chosen side still contains conflict markers; resolve its regions first')
    }
    await replaceCheckedFile(root, relativePath, identity, null, current + incoming)
    return
  }
  const selected = sides[choice === 'current' ? 2 : 3]
  if (!selected) {
    throw new Error('That side of the conflict has no content; accept the deletion instead')
  }
  let sourcePath = relativePath
  let renamedSource = false
  let args = [
    '--literal-pathspecs',
    'checkout',
    choice === 'current' ? '--ours' : '--theirs',
    '--',
    relativePath,
  ]
  if (selected.text !== null && hasConflictMarkers(selected.text)) {
    const context = await conflictContext(root, relativePath, stages)
    const destination = (await conflictMoves(root, relativePath, context)).find(
      (move) => move.to === relativePath,
    )
    const move =
      destination &&
      (await conflictMoves(root, destination.from, context)).find((item) => item.side === choice)
    const revision = context.sides.find((side) => side.side === choice)?.target
    if (!move || !revision) {
      throw new Error('A chosen side still contains conflict markers; resolve its regions first')
    }
    sourcePath = requirePathInput(move.to, 'path')
    args = ['--literal-pathspecs', 'restore', '--source', revision, '--worktree', '--', sourcePath]
    renamedSource = true
  }
  const materialized = await materializeGitWorktreePath(root, sourcePath, args)
  try {
    if (!materialized.path) throw new Error('The selected side could not be restored')
    if (renamedSource) {
      const original = await fileFingerprintAt(root, sourcePath, materialized.path)
      if (
        original.preview &&
        !original.binary &&
        !original.truncated &&
        hasConflictMarkers(original.preview.toString('utf8'))
      ) {
        throw new Error('A chosen side still contains conflict markers; resolve its regions first')
      }
    }

    await replaceCheckedFile(root, relativePath, identity, materialized.path)
  } finally {
    await fs.rm(materialized.root, { recursive: true, force: true })
  }
}

/** Stage only the checked path through a private index. The live index is
 * replaced under its lock only if no entry or selected worktree byte changed.
 */
async function stageCheckedConflict(
  root: string,
  relativePath: string,
  expected: FileIdentity,
): Promise<void> {
  const indexPath = await repositoryGitPath(root, 'index', null)
  const indexMode = (await fs.stat(indexPath)).mode & 0o7777
  const original = await fs.readFile(indexPath)
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'git-stacks-stage-'))
  const privateIndex = path.join(temporary, 'index')
  const lockPath = `${indexPath}.lock`
  let lock: FileHandle | null = null
  let ownsLock = false
  try {
    await fs.writeFile(privateIndex, original)
    if ((await fileFingerprint(root, relativePath)).fingerprint !== expected.fingerprint) {
      throw new Error('The file changed before staging; refresh and retry')
    }
    await runGit(root, ['--literal-pathspecs', 'add', '-A', '--', relativePath], {
      GIT_INDEX_FILE: privateIndex,
    })
    const unresolved = await runGit(
      root,
      ['--literal-pathspecs', 'ls-files', '-u', '--', relativePath],
      { GIT_INDEX_FILE: privateIndex },
    )
    if (unresolved) throw new Error('Git still reports this path as unmerged')
    lock = await fs.open(lockPath, 'wx')
    ownsLock = true
    await lock.chmod(indexMode)
    if (
      !(await fs.readFile(indexPath)).equals(original) ||
      (await fileFingerprint(root, relativePath)).fingerprint !== expected.fingerprint
    ) {
      throw new Error('The file or index changed before staging; refresh and retry')
    }
    await lock.writeFile(await fs.readFile(privateIndex))
    await lock.sync()
    await lock.close()
    lock = null
    await fs.rename(lockPath, indexPath)
    ownsLock = false
  } finally {
    if (lock) await lock.close()
    if (ownsLock) await fs.rm(lockPath, { force: true })
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

/**
 * Mark one conflicted path resolved. The worktree and index identity the
 * decision was made under is revalidated first, so an edit made elsewhere while
 * the resolver was open is refused instead of overwritten.
 */
export async function runResolveConflict(
  repoPath: string,
  filePath: string,
  fingerprint: string,
  resolution: ConflictResolution,
): Promise<ActionResult> {
  const root = await resolveRepository(repoPath)
  await recoverFileActionJournals(root)
  const { entry, identity } = await checkFileFingerprint(root, filePath, fingerprint)
  if (!entry.conflicted) throw new Error('The selected file has no unresolved conflict')
  const relativePath = entry.path
  await safeRepositoryPath(root, relativePath)
  if (resolution.kind === 'worktree') {
    if (!identity.stat) throw new Error('No worktree file exists to mark resolved')
    if (
      !identity.binary &&
      !identity.truncated &&
      identity.preview &&
      hasConflictMarkers(identity.preview.toString('utf8'))
    ) {
      throw new Error('Conflict markers are still present; resolve every region before staging')
    }
  } else if (resolution.kind === 'content') {
    if (identity.binary) {
      throw new Error(
        'This conflict is a binary file, so it cannot be resolved by editing text. ' +
          'Accept one side, open the external merge tool, or resolve it outside Git Stacks.',
      )
    }
    if (hasConflictMarkers(resolution.content)) {
      throw new Error('Conflict markers are still present; resolve every region before staging')
    }
    await replaceCheckedFile(root, relativePath, identity, null, resolution.content)
  } else {
    const captured = await conflictIndex(root, relativePath)
    if (captured.fingerprint !== identity.indexFingerprint) {
      throw new Error(
        'The index changed since the conflict was opened; refresh before applying this action',
      )
    }
    const selectedStage = resolution.choice === 'current' ? 2 : 3
    const sides: ConflictSides = {}
    if (resolution.choice !== 'delete') {
      await Promise.all(
        captured.stages
          .filter((stage) =>
            resolution.choice === 'both' ? stage.stage !== 1 : stage.stage === selectedStage,
          )
          .map(async (stage) => {
            sides[stage.stage] = await readConflictBlob(root, stage.oid)
          }),
      )
    }
    if (
      resolution.choice === 'both' &&
      [sides[2], sides[3]].some((side) => side?.binary || side?.truncated)
    ) {
      throw new Error('Keeping both copies requires complete text versions of both sides')
    }
    await writeConflictChoice(
      root,
      relativePath,
      resolution.choice,
      sides,
      identity,
      captured.stages,
    )
  }
  await safeRepositoryPath(root, relativePath)
  const stagedIdentity =
    resolution.kind === 'worktree' ? identity : await fileFingerprint(root, relativePath)
  if (stagedIdentity.indexFingerprint !== identity.indexFingerprint) {
    throw new Error('The index changed during resolution; refresh and retry')
  }
  await stageCheckedConflict(root, relativePath, stagedIdentity)
  return { message: `Resolved and staged ${relativePath}` }
}

/**
 * `git mergetool` for one path, with its stdin closed. Git controls invocation
 * and failure; the tool selected for this view is passed explicitly so an
 * environment override cannot silently run the configured fallback instead.
 */
async function runMergeTool(
  gitDirectory: string,
  relativePath: string,
  indexPath: string,
  worktree: string,
  tool: string,
): Promise<string> {
  const runtime = await resolveGitRuntime()
  return new Promise((resolve, reject) => {
    const child = spawn(
      runtime.executable,
      ['mergetool', '--no-prompt', '--no-gui', `--tool=${tool}`, '--', relativePath],
      {
        cwd: worktree,
        env: gitCommandEnvironment(
          runtime,
          commandEnvironment({
            GIT_DIR: gitDirectory,
            GIT_INDEX_FILE: indexPath,
            GIT_WORK_TREE: worktree,
          }),
        ),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      },
    )
    let output = ''
    let failure = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      output += chunk
      failure += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(output)
      else {
        reject(
          new Error(
            (failure || output).trim() ||
              `git mergetool exited with status ${code} for ${relativePath}`,
          ),
        )
      }
    })
  })
}

/**
 * Git runs the external tool in a private worktree and index. Only a result
 * bound to the originally captured live identity is installed in the live
 * worktree; the live index stays unmerged until an explicit checked stage.
 */
export async function runConflictMergeTool(
  repoPath: string,
  filePath: string,
  fingerprint: string,
  /** The merge tool the Settings surface configured; it wins over Git's own. */
  toolOverride?: string | null,
): Promise<ActionResult> {
  const root = await resolveRepository(repoPath)
  await recoverFileActionJournals(root)
  const { entry, identity } = await checkFileFingerprint(root, filePath, fingerprint)
  if (!entry.conflicted) throw new Error('The selected file has no unresolved conflict')
  const relativePath = entry.path
  await safeRepositoryPath(root, relativePath)
  const tool = await resolveMergeTool(root, toolOverride)
  if (!tool.id) throw new Error(tool.reason)
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'git-stacks-mergetool-'))
  try {
    const indexPath = path.join(temporary, 'index')
    const worktree = path.join(temporary, 'worktree')
    const isolatedPath = path.join(worktree, relativePath)
    await fs.mkdir(path.dirname(isolatedPath), { recursive: true })
    await fs.copyFile(await repositoryGitPath(root, 'index', null), indexPath)
    if (identity.stat) {
      await fs.copyFile(await safeRepositoryPath(root, relativePath), isolatedPath)
      await fs.chmod(isolatedPath, identity.stat.mode & 0o777)
    }
    if ((await fileFingerprint(root, relativePath)).fingerprint !== identity.fingerprint) {
      throw new Error('The file changed while preparing the merge tool; refresh and retry')
    }
    await runMergeTool(
      stripTrailingNewline(await runGit(root, ['rev-parse', '--absolute-git-dir'])),
      relativePath,
      indexPath,
      worktree,
      tool.id,
    )
    let result: string | null = isolatedPath
    try {
      const info = await fs.lstat(isolatedPath)
      if (!info.isFile()) throw new Error('The merge tool produced a non-file result')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      result = null
    }
    if (!result) {
      throw new Error(
        'The merge tool removed this file; use Accept the deletion to stage its removal',
      )
    }
    await replaceCheckedFile(root, relativePath, identity, result)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
  const after = await fileFingerprint(root, relativePath)
  const markers =
    after.preview && !after.binary && !after.truncated
      ? hasConflictMarkers(after.preview.toString('utf8'))
      : false
  return {
    message: markers
      ? `${tool.label} left unresolved markers in ${relativePath}. Nothing was staged.`
      : `${tool.label} finished with ${relativePath}. Review the result, then mark it resolved to stage it.`,
  }
}

/**
 * Applies one hunk, or a subset of its changed lines, to the index only. The
 * working tree is never written: `git apply --cached` rebuilds the index entry
 * from the preimage it verifies, so unstaged edits elsewhere in the file, in this
 * file's other hunks, and in other files are left exactly as they are.
 */
export async function runStageHunk(
  repoPath: string,
  action: 'stageHunk' | 'unstageHunk',
  filePath: string,
  hunkId: string,
  fingerprint: string,
  lineIndexes?: number[],
): Promise<ActionResult> {
  const root = await resolveRepository(repoPath)
  await recoverFileActionJournals(root)
  const { entry, identity } = await checkFileFingerprint(root, filePath, fingerprint)
  const side: HunkSideName = action === 'unstageHunk' ? 'staged' : 'unstaged'
  const diff = await changedDiff(root, side === 'staged' ? 'cached' : 'worktree', entry.path)
  const resolved = resolveHunkSide(entry, identity, side, diff)
  if (resolved.unavailable) throw new Error(resolved.unavailable)
  const block = parseHunkBlock(diff.text, {
    path: entry.path,
    originalPath: entry.originalPath ?? null,
  })
  const index = resolved.hunks.findIndex((candidate) => candidate.id === hunkId)
  const hunk = resolved.hunks[index]
  if (!hunk) {
    throw new Error(
      `That hunk is no longer part of the ${side} diff of ${entry.path}; refresh the file and try again`,
    )
  }
  const selected = validateHunkSelection(hunk, lineIndexes)
  const patch = buildHunkPatch(block, hunk, side, selected)
  await safeRepositoryPath(root, entry.path)
  // Building the patch takes time; do not apply it against a file or index that
  // changed since the diff and hunk identity were resolved.
  await checkFileFingerprint(root, filePath, fingerprint)
  const initialHead = (await tryGit(root, ['rev-parse', 'HEAD']))?.trim() ?? ''
  const relativeIndex = (await runGit(root, ['rev-parse', '--git-path', 'index'])).trim()
  const realIndexPath = path.resolve(root, relativeIndex)
  const lockPath = `${realIndexPath}.lock`
  const tempIndexPath = `${realIndexPath}.stage-${randomUUID()}`

  let lockHandle: FileHandle | null = null
  let lockAcquired = false
  try {
    try {
      lockHandle = await fs.open(lockPath, 'wx', 0o666)
      lockAcquired = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Another Git process is modifying the index; retry after it completes')
      }
      throw error
    }

    // A Git writer can change ANY entry while this action resolves the diff.
    // Take the complete snapshot only after owning Git's index lock, otherwise
    // publishing the temporary index could discard a different file's staging.
    const indexExists = await fs
      .access(realIndexPath, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false)
    const indexMode = indexExists ? (await fs.stat(realIndexPath)).mode & 0o777 : null
    if (indexExists) {
      await fs.copyFile(realIndexPath, tempIndexPath)
    }

    try {
      await runGitWithInput(
        root,
        [
          '--literal-pathspecs',
          'apply',
          '--cached',
          '--unidiff-zero',
          '--whitespace=nowarn',
          ...(side === 'staged' ? ['--reverse'] : []),
          '-',
        ],
        patch,
        { GIT_INDEX_FILE: tempIndexPath },
      )
    } catch (error) {
      throw new Error(
        `Git refused the hunk patch for ${entry.path}: ${commandDetail(error)}. Nothing was changed.`,
      )
    }

    const tempStage = await runGit(
      root,
      ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', entry.path],
      { GIT_INDEX_FILE: tempIndexPath },
    )
    const tempIndexFingerprint = createHash('sha256').update(tempStage).digest('hex')
    if (tempIndexFingerprint === identity.indexFingerprint) {
      throw new Error('The patch did not change the index; refresh and try again')
    }

    const currentHead = (await tryGit(root, ['rev-parse', 'HEAD']))?.trim() ?? ''
    if (currentHead !== initialHead) {
      throw new Error('The repository HEAD changed while staging; refresh and review the file')
    }
    const currentIdentity = await fileFingerprint(root, entry.path)
    if (currentIdentity.contentFingerprint !== identity.contentFingerprint) {
      throw new Error(
        'The working tree changed while the patch was applied; refresh and review the file',
      )
    }
    if (currentIdentity.indexFingerprint !== identity.indexFingerprint) {
      throw new Error('The index changed while the patch was applied; refresh and review the file')
    }

    if (indexMode !== null) await fs.chmod(tempIndexPath, indexMode)
    await lockHandle.close()
    lockHandle = null
    await fs.rename(tempIndexPath, realIndexPath)
  } finally {
    if (lockHandle) {
      await lockHandle.close().catch(() => {})
    }
    if (lockAcquired) {
      await fs.unlink(lockPath).catch(() => {})
    }
    await fs.rm(tempIndexPath, { force: true }).catch(() => {})
  }
  const position = index + 1
  const count = selected
    ? selected.length
    : hunk.lines.filter((l) => l.kind === 'add' || l.kind === 'remove').length
  const scope = selected
    ? `${count} line${count === 1 ? '' : 's'}`
    : `hunk ${position} of ${resolved.hunks.length}`
  return {
    message: `${side === 'staged' ? 'Unstaged' : 'Staged'} ${scope} in ${entry.path}`,
  }
}

function validateHunkSelection(
  hunk: DiffHunk,
  lineIndexes: number[] | undefined,
): number[] | undefined {
  if (!lineIndexes) return undefined
  for (const index of lineIndexes) {
    const line = hunk.lines[index]
    if (!line || (line.kind !== 'add' && line.kind !== 'remove')) {
      throw new Error('Only changed lines of the selected hunk can be applied')
    }
  }
  return [...lineIndexes].sort((left, right) => left - right)
}

function requireHistorySkip(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_HISTORY_SKIP) {
    throw new Error(`history skip must be an integer from 0 to ${MAX_HISTORY_SKIP}`)
  }
  return value as number
}

export async function getHistory(
  repoPath: string,
  ref: string,
  skip: number,
  signal?: AbortSignal,
): Promise<HistoryPage> {
  const root = await resolveRepository(repoPath, signal)
  const requestedRef = requireRefInput(ref, 'history ref')
  const offset = requireHistorySkip(skip)
  const resolved = await tryGit(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${requestedRef}^{commit}`],
    signal,
  )
  if (!resolved) {
    const current = await getCurrentBranch(root, signal)
    if (
      requestedRef !== 'HEAD' &&
      requestedRef !== current &&
      requestedRef !== `refs/heads/${current ?? ''}`
    ) {
      throw new Error(`History ref "${requestedRef}" does not exist`)
    }
    return { commits: [], hasMore: false }
  }
  const { text: output, truncated } = await runGitCapped(
    root,
    [
      'log',
      '--no-ext-diff',
      '--skip',
      String(offset),
      '-n',
      '51',
      '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00',
      '--end-of-options',
      requestedRef,
    ],
    { maxBytes: MAX_HISTORY_BYTES, boundary: '\0', signal },
  )
  const values = output.split('\0')
  const commits: Commit[] = []
  // A NUL terminates a field, not a commit: a capped author field must not
  // become a fabricated row whose missing date shifts subsequent skip values.
  for (let index = 0; index + 5 < values.length; index += 5) {
    const oid = stripTrailingNewline(values[index])
    if (!oid) continue
    const parents = stripTrailingNewline(values[index + 1])
      .split(/\s+/u)
      .filter(Boolean)
    commits.push({
      oid,
      parents,
      subject: stripTrailingNewline(values[index + 2]),
      author: stripTrailingNewline(values[index + 3]),
      date: stripTrailingNewline(values[index + 4]),
    })
  }
  if (truncated && commits.length === 0) {
    throw new Error('History entry exceeds the 1 MiB preview limit.')
  }
  return { commits: commits.slice(0, 50), hasMore: truncated || commits.length > 50 }
}

export async function getCommitDiff(
  repoPath: string,
  oid: string,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const root = await resolveRepository(repoPath, signal)
  const commitOid = requireOid(oid, 'commit oid')!
  const resolved = await tryGit(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${commitOid}^{commit}`],
    signal,
  )
  if (!resolved) throw new Error(`Commit "${commitOid}" does not exist`)
  return runGitCapped(
    root,
    [
      'show',
      '--format=',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--patch',
      '--end-of-options',
      commitOid,
    ],
    { maxBytes: MAX_DIFF_BYTES, signal },
  )
}

export async function getPushPreview(repoPath: string): Promise<PushPreview> {
  const root = await resolveRepository(repoPath)
  const target = await getPushTarget(root, true)
  const localOid = await currentHeadOid(root)
  if (!localOid) throw new Error('Cannot preview a push from an unborn branch')
  const remoteUrl = await getRemotePushUrl(root, target.remote)
  return {
    branch: target.branch,
    remote: target.remote,
    remoteUrl,
    destination: target.destination,
    localOid,
    remoteOid: await getRemoteOid(root, remoteUrl, target.destination),
  }
}
function branchFromRef(ref: RefRecord, currentBranch: string | null, remote: boolean): Branch {
  const prefix = remote ? 'refs/remotes/' : 'refs/heads/'
  const name = ref.refname.slice(prefix.length)
  const track = parseTrack(ref.track)
  return {
    ref: ref.refname,
    name,
    current: !remote && name === currentBranch,
    remote,
    upstream: ref.upstream.replace(/^refs\/(?:remotes|heads)\//u, '') || null,
    upstreamRef: ref.upstream || null,
    ahead: track.ahead,
    behind: track.behind,
    subject: ref.subject,
    updatedAt: ref.updatedAt,
    parent: null,
    parentBehind: null,
    pr: null,
    oid: ref.objectName,
    parentTip: null,
    parentSource: null,
    needsRestack: false,
  }
}

/**
 * True when the parent edges a snapshot has already read prove that `parent`
 * is an ancestor of `child`. Such a base is behind by nothing the branch does
 * not already contain, so its behind count is exactly zero. The walk follows
 * only commits that were read and stops at the first one whose parents are
 * unknown, so an unproved pair still gets its own `rev-list` count.
 */
function knownAncestor(
  child: string,
  parent: string,
  directParents: Map<string, string[]>,
): boolean {
  const seen = new Set([child])
  const frontier = [child]
  for (let head = 0; head < frontier.length; head += 1) {
    const parents = directParents.get(frontier[head])
    if (!parents) continue
    for (const candidate of parents) {
      if (candidate === parent) return true
      if (seen.has(candidate)) continue
      seen.add(candidate)
      frontier.push(candidate)
    }
  }
  return false
}
/**
 * How a snapshot obtains its GitHub half. `live` always asks GitHub, `reuse`
 * renders this repository's last confirmed payload without a request, and
 * `on-failure` asks GitHub but keeps that payload when the answer is lost.
 */
export type SnapshotGitHubRemote = 'live' | 'reuse' | 'on-failure'

interface ConfirmedGitHubPayload {
  originUrl: string | null
  data: GitHubResult
  issues: { issues: RepositoryIssue[]; message: string }
  fetchedAt: string
  /**
   * Where this read sat among the reads that asked GitHub. Overlapping reads
   * answer out of order, so the payload a newer read confirmed must survive an
   * older one that only finishes later.
   */
  read: number
  /** The credential generation this payload was confirmed under. */
  generation: number
}

// The order reads reach GitHub in, as a single counter: no per-repository
// bookkeeping survives a payload, and a number is only ever compared against
// the sequence the held payload was confirmed with.
let confirmedReadOrder = 0

const MAX_CONFIRMED_PAYLOADS = 8
const confirmedPayloads = new Map<string, ConfirmedGitHubPayload>()

/**
 * The generation of the credential these confirmed payloads belong to. A
 * credential replaced behind this app's back is a different generation, and
 * every payload a read confirmed under the old one describes pull requests and
 * issues that are not this account's to serve.
 */
let confirmedPayloadGeneration = 0

/**
 * Retires every confirmed GitHub payload, and refuses any read that is already
 * in flight from confirming another under the credential being replaced. Called
 * when the CLI's credential is actually replaced, and nothing else: local Git
 * state is not involved, and the next read repopulates what is dropped here.
 */
export function retireConfirmedGitHubPayloads(): void {
  confirmedPayloadGeneration += 1
  confirmedPayloads.clear()
}

/**
 * Keeps a payload a read confirmed, unless that read belongs to a credential
 * that has since been replaced.
 *
 * `generation` is the generation the read *started* in, not the one current
 * when it finished: stamping the current generation here would file a payload
 * read under the previous credential as this credential's, which is exactly the
 * rows the retirement dropped.
 */
function rememberConfirmedPayload(
  root: string,
  payload: ConfirmedGitHubPayload,
  generation: number,
): void {
  // A read that finished under a credential this process has left describes pull
  // requests and issues that are not this account's to serve, so it confirms
  // nothing and is not kept.
  if (generation !== confirmedPayloadGeneration) return
  // A read that started earlier may answer after a newer one already confirmed
  // this repository: it must not republish its older answer through the next
  // read that does not ask GitHub.
  const held = confirmedPayloads.get(root)
  if (held && held.read > payload.read) return
  confirmedPayloads.delete(root)
  confirmedPayloads.set(root, payload)
  while (confirmedPayloads.size > MAX_CONFIRMED_PAYLOADS) {
    const oldest = confirmedPayloads.keys().next()
    if (oldest.done) break
    confirmedPayloads.delete(oldest.value)
  }
}

/** The last GitHub payload this repository confirmed, if any. */
export function confirmedGitHubPayload(
  root: string,
  originUrl?: string | null,
): ConfirmedGitHubPayload | null {
  const cached = confirmedPayloads.get(root) ?? null
  if (!cached) return null
  // A payload a replaced credential confirmed is not an answer for this one.
  if (cached.generation !== confirmedPayloadGeneration) {
    confirmedPayloads.delete(root)
    return null
  }
  if (originUrl !== undefined && cached.originUrl !== originUrl) {
    confirmedPayloads.delete(root)
    return null
  }
  return cached
}
export async function getSnapshot(
  repoPath: string,
  signal?: AbortSignal,
  // Overridable so a test can exercise the budget with a handful of branches
  // instead of materialising SNAPSHOT_BRANCH_BUDGET of them.
  branchBudget = SNAPSHOT_BRANCH_BUDGET,
  remote: SnapshotGitHubRemote = 'live',
  // Internal: this read is the bounded second attempt of one that asked GitHub
  // nothing and found its confirmed answer had been retired, so it consults no
  // confirmed payload at all and is assembled from the local work alone.
  localOnly = false,
): Promise<RepositorySnapshot> {
  // Claimed on entry, not at the GitHub read: local Git work differs per read,
  // so arrival at the request is not the order the reads began in.
  const read = (confirmedReadOrder += 1)
  // Claimed on entry for the same reason: the credential this read may confirm
  // under is the one that was current when it started, so a credential replaced
  // while it runs retires its answer instead of adopting it.
  const generation = confirmedPayloadGeneration

  const root = await resolveRepository(repoPath, signal)
  await recoverStashDropForRepository(root)
  await recoverFileActionJournals(root)
  await recoverStaleBranchLocks(root)
  const capabilities = await getRepositoryCapabilities(root)
  // A bare repository has no index to compare against a worktree.
  const noWorkingTree = { files: [] as ChangedFile[], truncated: false }
  const reads = [
    getRefs(root, signal),
    getCurrentBranch(root, signal),
    capabilities.bare ? Promise.resolve(noWorkingTree) : listStatus(root, signal),
    capabilities.bare ? Promise.resolve([] as Stash[]) : getStashes(root, signal),
    getOriginUrl(root, signal),
    getOperationState(root, signal),
    getStackProgress(root, signal),
    currentHeadOid(root, signal),
    getBranchConfigs(root, signal),
  ] as const
  const [
    refs,
    currentBranch,
    workingTree,
    stashes,
    originUrl,
    operationState,
    stackOperation,
    headOid,
    configParents,
  ] = await Promise.all(reads).catch(async (error: unknown) => {
    await Promise.allSettled(reads)
    throw error
  })
  const files = workingTree.files
  const limits: SnapshotLimits = {
    branchesAnalyzed: 0,
    branchesSkipped: 0,
    filesListed: files.length,
    filesTruncated: workingTree.truncated,
  }
  // Budget per-branch Git work while reporting each branch only once, even
  // when it needs both parent inference and a behind-count.
  let remaining = branchBudget
  const analyzed = new Set<Branch>()
  const skipped = new Set<Branch>()
  const takeBudget = (candidates: Branch[]): Branch[] => {
    const allowed: Branch[] = []
    for (const branch of candidates) {
      if (analyzed.has(branch)) {
        allowed.push(branch)
      } else if (remaining > 0) {
        remaining -= 1
        analyzed.add(branch)
        allowed.push(branch)
      } else {
        skipped.add(branch)
      }
    }
    return allowed
  }

  // The index and the HEAD tree are independent reads, so they run together
  // rather than one after the other. A rejected read must not leave its sibling
  // running, so every read is awaited before the rejection escapes.
  const classification = [
    getIndexEntries(
      root,
      files.flatMap((file) => (file.originalPath ? [file.path, file.originalPath] : [file.path])),
    ),
    getHeadGitlinks(
      root,
      files.map((file) => file.path),
    ),
  ] as const
  const [indexEntries, headGitlinks] = await Promise.all(classification).catch(
    async (error: unknown) => {
      await Promise.allSettled(classification)
      throw error
    },
  )
  for (const file of files) {
    const entry = indexEntries.get(file.path)
    if (entry?.submodule || headGitlinks.has(file.path)) file.submodule = true
    if (entry?.sparseExcluded) file.sparseExcluded = true
  }

  const localRefs = refs.filter((ref) => ref.refname.startsWith('refs/heads/') && !ref.symref)
  const remoteRefs = refs.filter((ref) => ref.refname.startsWith('refs/remotes/') && !ref.symref)
  const branches: Branch[] = [
    ...localRefs.map((ref) => branchFromRef(ref, currentBranch, false)),
    ...remoteRefs.map((ref) => branchFromRef(ref, currentBranch, true)),
  ]
  if (
    currentBranch &&
    !branches.some((branch) => !branch.remote && branch.name === currentBranch)
  ) {
    const upstream = await branchUpstream(root, currentBranch, signal)
    branches.unshift({
      ref: `refs/heads/${currentBranch}`,
      name: currentBranch,
      current: true,
      remote: false,
      upstream,
      upstreamRef: null,
      ahead: 0,
      behind: 0,
      subject: '',
      updatedAt: '',
      parent: null,
      parentBehind: null,
      pr: null,
      oid: headOid ?? undefined,
      parentTip: null,
      parentSource: null,
      needsRestack: false,
    })
  }

  const defaultBranch = await getDefaultBranch(root, refs, currentBranch, signal)
  // Read through the accessor rather than off the map: that is where a payload
  // confirmed under a credential this process has left is refused, so a reuse
  // or on-failure refresh cannot render another account's pull requests and
  // issues from a snapshot read that started before the replacement.
  //
  // A read that is already the bounded local-only retry asks for nothing. It took
  // this path because the answer it had was read under an account that has since
  // been replaced, so it consults no confirmed payload at all: there is no
  // snapshot to fall back to and no second thing to lose. Everything it reports —
  // the branches, the parent each one stacks on, how far it is behind it, whether
  // it needs a restack, the stashes, the files — is read from the local work
  // itself, which is what the person asked of it and the only thing this app can
  // show without an account. That also means it cannot be overtaken the same way
  // again: there is nothing here for a second replacement to take away.
  const confirmed = localOnly ? null : confirmedGitHubPayload(root, originUrl)
  // The generation this payload was confirmed under, read beside it and not at
  // the read's entry: this read may have outlived one credential already, and the
  // question at the end is whether the account behind *this* payload is still the
  // one in force — not whether the read itself began under it.
  const confirmedGeneration = confirmedPayloadGeneration
  const confirmedAt = new Date().toISOString()
  // A background refresh of local Git must not spend a GitHub request, and a
  // refresh whose GitHub answer was lost must keep the last confirmed payload
  // rather than emptying the pull-request and stack workspace.
  // A local refresh ('reuse') must never hit the network, even when no confirmed
  // payload exists yet: it preserves local independence and spends zero GitHub quota.
  const live =
    remote === 'reuse'
      ? null
      : await Promise.all([
          getGitHubData(root, originUrl, signal),
          getGitHubIssues(root, originUrl, signal),
        ])
  const answered = live !== null && live[0].available
  // The inbox is a second read with its own outcome. A pull-request answer
  // says nothing about it: an issue read that failed carries its reason in its
  // message, and an empty list is then unknown, not "there are no issues".
  const issuesAnswered = live !== null && live[1].message === ''
  if (answered) {
    // A failed issue read never becomes the confirmed inbox, so the last
    // confirmed one survives a refresh that could not reach the issues. The
    // generation is this read's own: a credential replaced while it ran means
    // these answers describe pull requests and issues that are not this
    // account's, so nothing about them is kept.
    rememberConfirmedPayload(
      root,
      {
        originUrl,
        data: live[0],
        issues: issuesAnswered ? live[1] : (confirmed?.issues ?? live[1]),
        fetchedAt: confirmedAt,
        read,
        generation,
      },
      generation,
    )
  }
  // A live read is authoritative by definition: a caller that asked for one
  // (a mutation preview, a publication) must never be handed an older payload
  // wearing a fresh label. Only the background modes may fall back.
  const mayFallBack = remote !== 'live'
  const fallbackData = confirmed
    ? confirmed.data
    : unavailableGitHubResult('GitHub data has not been confirmed yet')
  const fallbackIssues = confirmed
    ? confirmed.issues
    : { issues: [] as RepositoryIssue[], message: '' }
  const github = answered
    ? live![0]
    : mayFallBack
      ? fallbackData
      : live
        ? live[0]
        : unavailableGitHubResult('GitHub could not be read')
  // Without a confirmed inbox, keep the issues last confirmed and say why this
  // read could not refresh them, rather than passing off an empty list as one.
  const issueData =
    live === null || !issuesAnswered
      ? mayFallBack && confirmed
        ? { issues: fallbackIssues.issues, message: live?.[1].message ?? '' }
        : live
          ? live[1]
          : fallbackIssues
      : live[1]
  const githubFailure = live === null ? null : (live[0].failure ?? null)
  const githubStale: RepositorySnapshot['githubStale'] = answered
    ? null
    : {
        reason:
          mayFallBack && confirmed
            ? remote === 'reuse'
              ? 'A GitHub refresh is not due yet; showing the last confirmed state'
              : 'GitHub could not be read; showing the last confirmed state'
            : github.message,
        fetchedAt: confirmed?.fetchedAt ?? confirmedAt,
      }
  const localPullRequests = new Map<string, PullRequest>()
  github.pullRequests.forEach((pullRequest, index) => {
    if (github.sameRepository(index) && !localPullRequests.has(pullRequest.head)) {
      localPullRequests.set(pullRequest.head, pullRequest)
    }
  })
  for (const branch of branches) {
    if (branch.remote && !branch.ref.startsWith('refs/remotes/origin/')) continue
    const name = branch.remote ? branch.name.slice('origin/'.length) : branch.name
    const pullRequest = localPullRequests.get(name) ?? null
    const config = configParents.get(name)
    branch.pr = pullRequest
    branch.recordedParent = config?.parent ?? null
    if (config?.parent) {
      branch.parent = config.parent
      branch.parentTip = config.parentTip ?? null
      branch.parentSource =
        pullRequest?.stack && pullRequest.stack.base === config.parent ? 'stack' : 'recorded'
    } else if (pullRequest?.stack) {
      branch.parent = pullRequest.stack.base
      branch.parentTip = config?.parentTip ?? null
      branch.parentSource = 'stack'
    } else {
      branch.parent = pullRequest?.base ?? null
      branch.parentTip = config?.parentTip ?? null
      branch.parentSource = pullRequest ? 'pullRequest' : null
    }
  }

  const refsByName = new Map(refs.filter((ref) => !ref.symref).map((ref) => [ref.refname, ref]))
  const directParents = new Map<string, string[]>()
  const defaultRef =
    refsByName.get(`refs/heads/${defaultBranch}`) ??
    refsByName.get(`refs/remotes/origin/${defaultBranch}`)
  /** Parents of every divergent tip the batched probe below could read. */
  if (defaultRef) {
    const defaultRefs = new Set([
      `refs/heads/${defaultBranch}`,
      `refs/remotes/origin/${defaultBranch}`,
      defaultRef.refname,
    ])
    const analyzable = takeBudget(
      branches
        .filter((branch) => {
          if (branch.parent) return false
          if (!refsByName.get(branch.ref)) return false
          const originRemote = branch.ref.startsWith('refs/remotes/origin/')
          if (branch.remote && !originRemote) return false
          return !defaultRefs.has(branch.ref)
        })
        .sort((left, right) => Number(right.current) - Number(left.current)),
    )
    // Inspect the tips in batches: a branch one commit above the default is
    // already known to descend from it. Avoid forking merge-base once per
    // branch for the common case, while retaining that probe for deeper DAGs.
    const divergent = [
      ...new Set(
        analyzable
          .map((branch) => (refsByName.get(branch.ref) as RefRecord).objectName)
          .filter((oid) => oid !== defaultRef.objectName),
      ),
    ]
    for (const [oid, parents] of await readDirectParents(root, divergent, signal)) {
      directParents.set(oid, parents)
    }
    await mapWithConcurrency(analyzable, GIT_CONCURRENCY, async (branch) => {
      const child = refsByName.get(branch.ref) as RefRecord
      if (child.objectName === defaultRef.objectName) {
        branch.parent = defaultBranch
        branch.parentSource = 'inferred'
        return
      }
      if (directParents.get(child.objectName)?.includes(defaultRef.objectName) === true) {
        branch.parent = defaultBranch
        branch.parentSource = 'inferred'
        return
      }
      try {
        await runGitCapped(root, ['merge-base', child.objectName, defaultRef.objectName], {
          maxBytes: 4096,
          signal,
        })
        branch.parent = defaultBranch
        branch.parentSource = 'inferred'
      } catch (error) {
        if (
          !isCancelled(error) &&
          !isExitCode(error, 1) &&
          !isExitCode(error, 2) &&
          !isExitCode(error, 128)
        ) {
          throw error
        }
        if (isCancelled(error)) throw error
      }
    })
  }
  if (signal?.aborted) throw new CommandCancelled()

  const effectiveDefault = await parentTarget(root, defaultBranch, defaultBranch, false, signal)
  const parentOf = (branch: Branch): RefRecord | undefined =>
    branch.parent
      ? ((branch.parent === defaultBranch && effectiveDefault
          ? refsByName.get(effectiveDefault.ref)
          : null) ??
        refsByName.get(`refs/heads/${branch.parent}`) ??
        refsByName.get(`refs/remotes/${branch.parent}`) ??
        refsByName.get(`refs/remotes/origin/${branch.parent}`))
      : undefined
  const comparable = branches.filter((branch) => {
    const child = refsByName.get(branch.ref)
    const parent = parentOf(branch)
    if (!child || !parent) return false
    if (child.refname === parent.refname) {
      branch.needsRestack = Boolean(branch.parentTip)
      return false
    }
    return true
  })
  for (const branch of branches) {
    if (branch.parent && !parentOf(branch)) branch.needsRestack = Boolean(branch.parentTip)
  }
  const behind = takeBudget(comparable)
  // Every behind count compares a branch tip against its base. The batched
  // parent edges this snapshot already read settle most of them outright, so
  // read the few remaining tips once and answer from that evidence instead of
  // forking one `rev-list` per branch.
  const compared = new Set<string>()
  for (const branch of behind) {
    const child = refsByName.get(branch.ref)
    const parent = parentOf(branch)
    if (child) compared.add(child.objectName)
    if (parent) compared.add(parent.objectName)
  }
  for (const [oid, parents] of await readDirectParents(
    root,
    [...compared].filter((oid) => !directParents.has(oid)),
    signal,
  )) {
    directParents.set(oid, parents)
  }
  await mapWithConcurrency(behind, GIT_CONCURRENCY, async (branch) => {
    const child = refsByName.get(branch.ref) as RefRecord
    const parent = parentOf(branch) as RefRecord
    const recordedTipMoved = Boolean(branch.parentTip && branch.parentTip !== parent.objectName)
    if (
      child.objectName === parent.objectName ||
      knownAncestor(child.objectName, parent.objectName, directParents)
    ) {
      // The base contributes nothing this branch does not already contain, so
      // the count Git would report is exactly zero.
      branch.parentBehind = 0
      branch.needsRestack = recordedTipMoved
      return
    }
    const { text } = await runGitCapped(
      root,
      ['rev-list', '--count', `${child.objectName}..${parent.objectName}`, '--'],
      { maxBytes: 1024, signal },
    )
    branch.parentBehind = Number(text)
    branch.needsRestack = Number(text) > 0 || recordedTipMoved
  })
  if (signal?.aborted) throw new CommandCancelled()
  const measured = new Set(behind)
  for (const branch of comparable) {
    if (measured.has(branch)) continue
    const parent = parentOf(branch) as RefRecord
    // Behind remains unknown outside the budget; a recorded tip is only
    // evidence of drift when it differs from the resolved parent object.
    branch.needsRestack = Boolean(branch.parentTip && branch.parentTip !== parent.objectName)
  }

  limits.branchesAnalyzed = analyzed.size
  limits.branchesSkipped = skipped.size

  const snapshot: RepositorySnapshot = {
    path: root,
    name: path.basename(root) || root,
    currentBranch,
    defaultBranch,
    remoteUrl: originUrl,
    branches,
    pullRequests: github.pullRequests,
    issues: issueData.issues,
    issuesMessage: issueData.message,
    files,
    stashes,
    rebaseInProgress: operationState.rebase,
    operation: operationState.operation,
    stackOperation,
    headOid,
    github: { available: github.available, message: github.message },
    nativeStacks: github.nativeStacks ?? [],
    nativeStackPreviewAvailable: github.nativeStackPreviewAvailable ?? false,
    nativeStackMessage: github.nativeStackMessage,
    limits,
    capabilities,
    githubStale,
    githubFailure,
  }
  // This snapshot was assembled under the credential the read started with, and it
  // is about to be handed to whoever publishes snapshots. A credential replaced
  // while the last reconciliation was running retires the answers read under it,
  // and dropping the cache cannot recall a snapshot that is already on its way to
  // the window, so a read that did ask GitHub is refused here rather than
  // delivered. A read that never asked GitHub carries no such answer of its own,
  // so a local refresh after a local commit still completes even if the signed-in
  // account changed while it ran — it simply goes on to answer that refresh by
  // asking nothing at all, which is what the check below it arranges.
  // Origins that cannot reach the GitHub transport carry no credential-bound
  // answer, so initial CLI authentication must not cancel their local Git read.
  const staleCredential = () =>
    live !== null &&
    generation !== confirmedPayloadGeneration &&
    remoteHostContext(parseRemote(originUrl)) !== null
  if (staleCredential() || signal?.aborted) throw new CommandCancelled()
  // Read-only: the report compares submitted membership with the local graph
  // and never rewrites a branch, a local hint, or a pull-request base.
  snapshot.reconciliation = await buildReconciliationReport(root, snapshot, configParents)
  if (signal?.aborted) throw new CommandCancelled()
  if (staleCredential()) throw new CommandCancelled()
  // The account behind a confirmed payload can also be replaced while that last
  // local report was being built. Retirement drops the payload, and a payload
  // already read into this snapshot cannot be recalled: the accessor refused a
  // payload confirmed by a replaced account when it was taken, not after the
  // account behind it was replaced. A read that asked GitHub nothing holds no
  // answer of its own, so it finishes as the local read it was — re-read with
  // the payload gone — rather than handing over another account's pull requests,
  // issues, branches or reconciliation. The local Git work is all it returns and
  // all the person asked of it, so the work is not thrown away; a re-read that
  // is overtaken the same way is cancelled instead of repeated.
  if (
    !localOnly &&
    live === null &&
    confirmed !== null &&
    confirmedGeneration !== confirmedPayloadGeneration
  ) {
    // The payload this read would hand over was confirmed by an account that has
    // since been replaced, and an answer already taken cannot be recalled by
    // dropping the cache: the accessor refuses a stale payload when it is read,
    // not one this read took a moment earlier. Nothing here was asked of GitHub,
    // so this read is answered again by asking nothing at all — the local work,
    // assembled once, with the replaced account's answers never consulted. A
    // commit that succeeded is not undone by an account changing while it was
    // measured, and the retry reads it for itself exactly once.
    return getSnapshot(repoPath, signal, branchBudget, 'reuse', true)
  }
  return snapshot
}
async function runRenameBranch(
  repoPath: string,
  ref: string,
  newName: string,
): Promise<ActionResult> {
  if (!ref.startsWith('refs/heads/')) throw new Error('Only local branches can be renamed')
  const oldName = ref.slice('refs/heads/'.length)
  await ensureNoBusyOperation(repoPath, 'rename a branch')
  await validateBranchName(repoPath, oldName)
  await validateBranchName(repoPath, newName)
  const [refs, currentBranch] = await Promise.all([getRefs(repoPath), getCurrentBranch(repoPath)])
  const defaultBranch = await getDefaultBranch(repoPath, refs, currentBranch)
  if (oldName === defaultBranch || newName === defaultBranch) {
    throw new Error('The default branch cannot be renamed')
  }
  if (!refs.some((entry) => entry.refname === ref && !entry.symref)) {
    throw new Error(`Local branch "${oldName}" does not exist`)
  }
  if (await refExists(repoPath, `refs/heads/${newName}`)) {
    throw new Error(`Local branch "${newName}" already exists`)
  }
  await ensureNotCheckedOutElsewhere(repoPath, oldName)
  const children = refs
    .filter((entry) => entry.refname.startsWith('refs/heads/') && entry.refname !== ref)
    .map((entry) => entry.refname.slice('refs/heads/'.length))
  await runGit(repoPath, ['branch', '-m', '--', oldName, newName])
  for (const child of children) {
    const parent = await getBranchParent(repoPath, child)
    if (parent === oldName || parent === `refs/heads/${oldName}`) {
      await runGit(repoPath, ['config', '--local', `branch.${child}.parent`, newName])
    }
  }
  return { message: `Renamed local branch ${oldName} to ${newName}` }
}

async function runSetUpstream(
  repoPath: string,
  ref: string,
  upstream: string | null,
): Promise<ActionResult> {
  if (!ref.startsWith('refs/heads/')) throw new Error('Only local branches may have an upstream')
  const branch = ref.slice('refs/heads/'.length)
  await ensureNoBusyOperation(repoPath, 'change branch upstream')
  await validateBranchName(repoPath, branch)
  if (!(await refExists(repoPath, ref))) throw new Error(`Local branch "${branch}" does not exist`)
  if (upstream === null) {
    await runGit(repoPath, ['branch', '--unset-upstream', '--', branch])
    return { message: `Removed upstream from ${branch}` }
  }
  const remotes = await getRemotes(repoPath)
  const short = upstream.startsWith('refs/remotes/')
    ? upstream.slice('refs/remotes/'.length)
    : upstream
  const separator = short.indexOf('/')
  if (separator <= 0 || separator === short.length - 1) {
    throw new Error('Upstream must name an existing remote branch')
  }
  const remote = short.slice(0, separator)
  const remoteBranch = short.slice(separator + 1)
  if (!remotes.includes(remote) || !(await refExists(repoPath, `refs/remotes/${short}`))) {
    throw new Error(`Upstream "${upstream}" does not exist as a fetched remote branch`)
  }
  await runGit(repoPath, ['branch', `--set-upstream-to=${short}`, '--', branch])
  return { message: `Set ${branch} to track ${short}` }
}

async function resolveCommitRef(repoPath: string, value: string, label: string): Promise<string> {
  const ref = requireRefInput(value, label)
  const oid = await tryGit(repoPath, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ])
  if (!oid) throw new Error(`${label} does not resolve to a commit`)
  return stripTrailingNewline(oid)
}

async function commitParentCount(repoPath: string, oid: string): Promise<number> {
  const output = await runGit(repoPath, [
    'rev-list',
    '--parents',
    '-n',
    '1',
    '--end-of-options',
    oid,
  ])
  return stripTrailingNewline(output).split(/\s+/u).length - 1
}

async function runMerge(
  repoPath: string,
  ref: string,
  expectedHead: string,
  expectedHeadRef: string,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'merge')
  await ensureClean(repoPath, 'merge')
  await assertExpectedHead(repoPath, expectedHead, 'merge', expectedHeadRef)
  const oid = await resolveCommitRef(repoPath, ref, 'merge ref')
  await runCapturedOperation(
    repoPath,
    'merge',
    ['merge', '--no-edit', '--', oid],
    { operation: 'merge', oid: expectedHead, ref: expectedHeadRef },
    { GIT_EDITOR: 'true' },
  )
  return { message: `Merged ${ref}` }
}

async function runCherryPickOrRevert(
  repoPath: string,
  kind: 'cherryPick' | 'revert',
  value: string,
  expectedHead: string,
  expectedHeadRef: string,
  mainline: number | null,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, kind === 'cherryPick' ? 'cherry-pick' : 'revert')
  await ensureClean(repoPath, kind === 'cherryPick' ? 'cherry-pick' : 'revert')
  await assertExpectedHead(repoPath, expectedHead, kind, expectedHeadRef)
  const oid = await resolveCommitRef(repoPath, value, 'commit oid')
  const parentCount = await commitParentCount(repoPath, oid)
  if (parentCount > 1 && mainline === null) {
    throw new Error(`${kind} of a merge commit requires an explicit mainline parent`)
  }
  if (mainline !== null && mainline > parentCount) {
    throw new Error(`mainline ${mainline} is not a parent of the selected commit`)
  }
  const command = kind === 'cherryPick' ? 'cherry-pick' : 'revert'
  await runCapturedOperation(
    repoPath,
    kind,
    [command, ...(mainline === null ? [] : ['-m', String(mainline)]), '--', oid],
    { operation: kind, oid: expectedHead, ref: expectedHeadRef },
    { GIT_EDITOR: 'true' },
  )
  return { message: `${kind === 'cherryPick' ? 'Cherry-picked' : 'Reverted'} ${value}` }
}

async function runOperation(
  repoPath: string,
  kind: 'continue' | 'skip' | 'abort',
): Promise<ActionResult> {
  const state = await getOperationState(repoPath)
  if (!state.operation) throw new Error('No Git operation is in progress')
  if (kind === 'skip' && state.operation === 'merge') {
    throw new Error('Merge operations cannot be skipped')
  }
  const command =
    state.operation === 'rebase'
      ? ['rebase', `--${kind}`]
      : state.operation === 'merge'
        ? ['merge', `--${kind}`]
        : state.operation === 'cherryPick'
          ? ['cherry-pick', `--${kind}`]
          : state.operation === 'revert'
            ? ['revert', `--${kind}`]
            : null
  const branch = state.operation === 'rebase' ? await rebaseBranch(repoPath) : null
  if (!command) throw new Error(`Cannot ${kind} the current Git operation`)
  const captured =
    kind !== 'abort' &&
    (state.operation === 'merge' ||
      state.operation === 'cherryPick' ||
      state.operation === 'revert')
      ? await readOperationHead(repoPath)
      : null
  if (kind !== 'abort' && captured && captured.operation !== state.operation) {
    throw new Error(
      'The saved expected HEAD belongs to a different Git operation; abort this operation',
    )
  }
  const env = {
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  }
  if (kind !== 'abort' && captured) {
    await assertExpectedHead(repoPath, captured.oid, `${kind} ${state.operation}`, captured.ref)
    await runGitWithExpectedHead(repoPath, command, captured, `${kind} ${state.operation}`, env)
  } else {
    await runGit(repoPath, command, env)
  }
  if (state.operation === 'rebase' && branch && !(await getOperationState(repoPath)).rebase) {
    if (kind === 'abort') {
      await unsetConfig(repoPath, `branch.${branch}.parentPending`)
      await unsetConfig(repoPath, `branch.${branch}.parentTipPending`)
    } else {
      await persistPendingRebase(repoPath, branch)
    }
  }
  if (
    state.operation !== 'rebase' &&
    (kind === 'abort' || (await getOperationState(repoPath)).operation !== state.operation)
  ) {
    await clearOperationHead(repoPath)
  }
  return {
    message:
      kind === 'continue'
        ? `Continued ${state.operation} operation`
        : kind === 'skip'
          ? `Skipped ${state.operation} operation`
          : `Aborted ${state.operation} operation`,
  }
}

async function ensureStackWriteAllowed(repoPath: string, action: GitAction): Promise<void> {
  const progress = await getStackProgress(repoPath)
  if (!progress) return
  if (
    action.type === 'stage' ||
    action.type === 'unstage' ||
    action.type === 'stageHunk' ||
    action.type === 'unstageHunk' ||
    action.type === 'resolveConflict' ||
    action.type === 'conflictMergeTool' ||
    action.type === 'stackContinue' ||
    action.type === 'stackAbort'
  ) {
    return
  }
  throw new Error('A stack operation is in progress; finish or abort it before other writes')
}
async function runDeleteRemoteBranches(
  repoPath: string,
  branches: { ref: string; expectedOid: string }[],
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'delete remote branches')
  const targets: { remote: string; branch: string; expectedOid: string }[] = []
  for (const { ref, expectedOid } of branches) {
    if (!ref.startsWith('refs/remotes/')) {
      throw new Error('Only fetched remote branch refs can be deleted')
    }
    const remote = await remoteForRefPath(repoPath, ref)
    if (!remote) throw new Error('The selected remote branch has no configured remote')
    const branch = ref.slice('refs/remotes/'.length + remote.length + 1)
    if (!branch || branch === 'HEAD') {
      throw new Error('The remote symbolic HEAD cannot be deleted')
    }
    await validateBranchName(repoPath, branch)
    if (!(await refExists(repoPath, ref))) {
      throw new Error(`Remote branch "${ref}" no longer exists locally`)
    }
    const localOid = stripTrailingNewline(
      await runGit(repoPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]),
    )
    if (localOid.toLowerCase() !== expectedOid.toLowerCase()) {
      throw new Error('The remote branch changed locally; refresh before deleting it')
    }
    const symbolic = await tryGit(repoPath, ['symbolic-ref', '--quiet', ref])
    if (symbolic) throw new Error('The remote symbolic HEAD cannot be deleted')
    targets.push({ remote, branch, expectedOid })
  }
  const remote = targets[0].remote
  if (targets.some((target) => target.remote !== remote)) {
    throw new Error('Remote branches must belong to the same configured remote')
  }
  const refs = await getRefs(repoPath)
  const defaultBranch = await getDefaultBranch(repoPath, refs, await getCurrentBranch(repoPath))
  const pushUrl = await getRemotePushUrl(repoPath, remote)
  const remoteHead = await remoteHeadDestination(repoPath, pushUrl)
  for (const { branch, expectedOid } of targets) {
    if (branch === defaultBranch || remoteHead === `refs/heads/${branch}`) {
      throw new Error('The default or remote HEAD branch cannot be deleted')
    }
    const remoteOid = await getRemoteOid(repoPath, pushUrl, `refs/heads/${branch}`)
    if (!remoteOid || remoteOid.toLowerCase() !== expectedOid.toLowerCase()) {
      throw new Error('The remote branch changed; fetch and refresh before deleting it')
    }
  }
  await runGit(repoPath, [
    '-c',
    'push.followTags=false',
    'push',
    ...(targets.length > 1 ? ['--atomic'] : []),
    ...targets.map(
      ({ branch, expectedOid }) => `--force-with-lease=refs/heads/${branch}:${expectedOid}`,
    ),
    '--no-mirror',
    '--no-follow-tags',
    '--',
    pushUrl,
    ...targets.map(({ branch }) => `:refs/heads/${branch}`),
  ])
  return {
    message:
      targets.length === 1
        ? `Deleted remote branch ${remote}/${targets[0].branch}`
        : `Deleted ${targets.length} remote branches`,
  }
}

/**
 * Runs one `update-ref --stdin` transaction: the given commands are prepared
 * first, `body` runs while Git holds the ref lock, and the transaction commits
 * only when the body resolves. A refused prepare or a failed body aborts the
 * transaction and waits for Git to exit before anything is reported, so a ref is
 * never left half written.
 *
 * `refusal` says what a refused prepare means for this caller; it answers `null`
 * when the caller has nothing left to do about it.
 */
async function withRefTransaction(
  runtime: GitRuntimeRecord,
  repoPath: string,
  commands: string,
  body: () => Promise<void>,
  refusal: (stderr: string, error: unknown) => Promise<string | null>,
  unfinished: string,
): Promise<void> {
  const child = spawn(runtime.executable, ['update-ref', '--stdin'], {
    cwd: repoPath,
    env: gitCommandEnvironment(runtime, commandEnvironment()),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let pendingOutput = ''
  let stdout = ''
  let stderr = ''
  let prepared = false
  let resolvePrepared!: () => void
  let rejectPrepared!: (error: Error) => void
  const prepareResult = new Promise<void>((resolve, reject) => {
    resolvePrepared = resolve
    rejectPrepared = reject
  })
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }))
    },
  )
  const abort = async (): Promise<void> => {
    try {
      child.stdin.end('abort\n')
    } catch {
      // The update-ref process may already have exited.
    }
    await completed
  }
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    pendingOutput += chunk.toString()
    const lines = pendingOutput.split(/\r?\n/u)
    pendingOutput = lines.pop() ?? ''
    for (const line of lines) {
      if (line === 'prepare: ok') {
        prepared = true
        resolvePrepared()
      } else if (line.startsWith('prepare: ')) {
        rejectPrepared(new Error(line))
      }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.on('error', (error) => rejectPrepared(error))
  child.on('close', (code, signal) => {
    if (!prepared) {
      rejectPrepared(
        new Error(
          stderr.trim() || stdout.trim() || `Git exited with ${signal ?? code ?? 'unknown'}`,
        ),
      )
    }
  })
  child.stdin.on('error', (error) => {
    if (!prepared) rejectPrepared(error)
  })
  child.stdin.write(`start\n${commands}\nprepare\n`)

  try {
    await prepareResult
  } catch (error) {
    await abort()
    const message = await refusal(stderr.trim(), error)
    if (message !== null) throw new Error(message)
    return
  }
  try {
    await body()
  } catch (error) {
    await abort()
    throw error
  }
  child.stdin.end('commit\n')
  const result = await completed
  if (result.code !== 0) {
    throw new Error(stderr.trim() || unfinished)
  }
}

// Hold the absent branch ref locked while its per-branch config is removed.
async function withAbsentRefLock(
  repoPath: string,
  ref: string,
  operation: () => Promise<void>,
): Promise<void> {
  const runtime = await resolveGitRuntime()
  await withRefTransaction(
    runtime,
    repoPath,
    `verify ${ref}`,
    operation,
    async (stderr, error) =>
      // The ref only has to be absent to clean up after it, so a ref somebody
      // else has since restored leaves nothing for this lock to remove.
      (await refExists(repoPath, ref))
        ? null
        : stderr || commandDetail(error) || `Could not lock ${ref} for configuration cleanup`,
    `Git could not finish cleanup for ${ref}`,
  )
}

async function deleteLocalBranchRefs(
  repoPath: string,
  branches: { ref: string; name: string; expectedOid: string }[],
): Promise<void> {
  const runtime = await requireGitCapability('referenceTransactions', 'delete local branches')
  await withRefTransaction(
    runtime,
    repoPath,
    branches.map(({ ref, expectedOid }) => `delete ${ref} ${expectedOid}`).join('\n'),
    async () => {
      for (const { name } of branches) await ensureNotCheckedOutElsewhere(repoPath, name)
    },
    async () => 'The branch changed since it was selected; refresh before deleting it',
    'Git could not complete deletion of the selected branches',
  )
  const failures: string[] = []
  for (const { ref, name } of branches) {
    try {
      await withAbsentRefLock(repoPath, ref, async () => {
        const pattern = `^branch\\.${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.`
        if (await tryGit(repoPath, ['config', '--get-regexp', pattern])) {
          await runGit(repoPath, ['config', '--remove-section', `branch.${name}`])
        }
      })
    } catch (error) {
      failures.push(`${name}: ${commandDetail(error)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Deleted the selected branches, but could not remove configuration: ${failures.join('; ')}`,
    )
  }
}

async function preflightDeleteBranch(
  repoPath: string,
  ref: string,
  force: boolean,
  expectedOid: string,
  context: {
    refs: Set<string>
    currentBranch: string | null
    defaultBranch: string | null
  },
): Promise<{ ref: string; name: string; expectedOid: string }> {
  if (!ref.startsWith('refs/heads/')) {
    throw new Error('Only local branches can be deleted')
  }
  const name = ref.slice('refs/heads/'.length)
  await validateBranchName(repoPath, name)
  if (name === context.currentBranch) {
    throw new Error('Switch to another branch before deleting the current branch')
  }
  if (name === context.defaultBranch) {
    throw new Error('The default branch cannot be deleted')
  }
  if (!context.refs.has(ref)) {
    throw new Error(`Local branch "${name}" no longer exists`)
  }
  const currentOid = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]),
  )
  if (currentOid.toLowerCase() !== expectedOid.toLowerCase()) {
    throw new Error('The branch changed since it was selected; refresh before deleting it')
  }
  await ensureNotCheckedOutElsewhere(repoPath, name)
  if (!force) {
    const upstreamOutput = await tryGit(repoPath, [
      'rev-parse',
      '--symbolic-full-name',
      `${name}@{upstream}`,
    ])
    const upstreamRef = upstreamOutput ? stripTrailingNewline(upstreamOutput) : 'HEAD'
    const upstreamOid = stripTrailingNewline(
      await runGit(repoPath, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${upstreamRef}^{commit}`,
      ]),
    )
    const mergedInto = await tryGit(repoPath, [
      'merge-base',
      '--is-ancestor',
      currentOid,
      upstreamOid,
    ])
    if (mergedInto === null) {
      throw new Error(`Branch "${name}" is not fully merged`)
    }
  }
  return { ref, name, expectedOid: currentOid }
}

async function runDeleteBranches(
  repoPath: string,
  targets: { ref: string; expectedOid: string }[],
  force: boolean,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'delete a branch')
  const [refs, currentBranch] = await Promise.all([getRefs(repoPath), getCurrentBranch(repoPath)])
  const context = {
    refs: new Set(refs.filter((entry) => !entry.symref).map((entry) => entry.refname)),
    currentBranch,
    defaultBranch: await getDefaultBranch(repoPath, refs, currentBranch),
  }
  const branches = []
  for (const target of targets) {
    branches.push(
      await preflightDeleteBranch(repoPath, target.ref, force, target.expectedOid, context),
    )
  }
  await deleteLocalBranchRefs(repoPath, branches)
  return {
    message:
      branches.length === 1
        ? `Deleted local branch ${branches[0]!.name}. Remote branches were not changed.`
        : `Deleted ${branches.length} local branches. Remote branches were not changed.`,
  }
}

export async function runAction(
  repoPath: string,
  value: GitAction,
  /** The merge tool configured in Settings, which wins over Git's own. */
  mergeToolOverride?: string | null,
): Promise<ActionResult> {
  const runtime = await resolveGitRuntime()
  return withGitRuntime(runtime, async () => {
    const root = await resolveRepository(repoPath)
    const action = validateAction(value)
    const blocked = actionBlockReason(await getRepositoryShapeFacts(root), action.type)
    if (blocked) throw new Error(blocked)
    if (isStackAction(action)) {
      return runStackAction(root, action)
    }
    await ensureStackWriteAllowed(root, action)
    switch (action.type) {
      case 'stage':
      case 'unstage':
        return runStage(root, action.type, action.paths)
      case 'commit':
        return runCommit(
          root,
          action.message,
          action.amend,
          action.expectedHead,
          action.expectedHeadRef,
        )
      case 'forcePush':
        return runForcePush(root, action.preview)
      case 'fetch':
        return runFetch(root)
      case 'pull':
        return runPull(root, action.strategy)
      case 'push':
        return runPush(root)
      case 'stash':
        return runStash(root, action.message, action.includeUntracked)
      case 'stashPop':
      case 'stashApply':
      case 'stashDrop':
        return runStashAction(root, action.type, action.ref, action.oid)
      case 'switch':
        return runSwitch(root, action.ref, action.carry)
      case 'createBranch':
        return runCreateBranch(root, action.name, action.parent)
      case 'deleteBranch':
        return runDeleteBranches(
          root,
          [{ ref: action.ref, expectedOid: action.expectedOid }],
          action.force,
        )
      case 'deleteBranches':
        return runDeleteBranches(root, action.branches, action.force)
      case 'deleteRemoteBranch':
        return runDeleteRemoteBranches(root, [{ ref: action.ref, expectedOid: action.expectedOid }])
      case 'deleteRemoteBranches':
        return runDeleteRemoteBranches(root, action.branches)
      case 'renameBranch':
        return runRenameBranch(root, action.ref, action.name)
      case 'setUpstream':
        return runSetUpstream(root, action.ref, action.upstream)
      case 'rebase':
        return runRebase(root, action.parent)
      case 'rebaseContinue':
        return runRebaseContinue(root)
      case 'rebaseAbort':
        return runRebaseAbort(root)
      case 'merge':
        return runMerge(root, action.ref, action.expectedHead, action.expectedHeadRef)
      case 'cherryPick':
      case 'revert':
        return runCherryPickOrRevert(
          root,
          action.type,
          action.oid,
          action.expectedHead,
          action.expectedHeadRef,
          action.mainline,
        )
      case 'operationContinue':
        return runOperation(root, 'continue')
      case 'operationSkip':
        return runOperation(root, 'skip')
      case 'operationAbort':
        return runOperation(root, 'abort')
      case 'discardFile':
        return runDiscardFile(root, action.path, action.fingerprint)
      case 'resolveConflict':
        return runResolveConflict(root, action.path, action.fingerprint, action.resolution)
      case 'conflictMergeTool':
        return runConflictMergeTool(root, action.path, action.fingerprint, mergeToolOverride)
      case 'stageHunk':
      case 'unstageHunk':
        return runStageHunk(
          root,
          action.type,
          action.path,
          action.hunkId,
          action.fingerprint,
          action.lineIndexes,
        )
      case 'createPr':
        return runCreatePr(root, action.title, action.body, action.base, action.draft)
    }
  })
}
