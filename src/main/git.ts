import { spawn } from 'node:child_process'

import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import type {
  ActionResult,
  Branch,
  ChangedFile,
  Commit,
  FileView,
  GitAction,
  HistoryPage,
  PullRequest,
  PushPreview,
  RepositorySnapshot,
} from '../shared/types'
import {
  MAX_BRANCH_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PATH_LENGTH,
  branchUpstream,
  commandDetail,
  ensureClean,
  ensureNoBusyOperation,
  ensureNotCheckedOutElsewhere,
  execute,
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
  isExitCode,
  isRecord,
  parseRemote,
  parseTrack,
  refExists,
  requireRefInput,
  requireString,
  resolveParentRef,
  runGit,
  statusPathCandidates,
  stripTrailingNewline,
  tryGit,
  validateBranchName,
} from './git-core'
import type { RefRecord } from './git-core'
import { getGitHubData } from './github'
import {
  getStackProgress,
  isStackAction,
  parentTarget,
  runStackAction,
  validateStackAction,
} from './stacks'

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

function requirePathInput(value: unknown, label: string): string {
  const filePath = requireString(value, label, MAX_PATH_LENGTH)
  if (
    path.isAbsolute(filePath) ||
    filePath
      .split(path.sep === '\\' ? /[\\/]/u : /\//u)
      .some((part) => part === '..' || part === '.')
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
      return { type: 'switch', ref: requireRefInput(value.ref, 'branch ref') }
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
    case 'discardFile':
      return {
        type: 'discardFile',
        path: requirePathInput(value.path, 'path'),
        fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
      }
    case 'resolveFile':
      if (value.strategy !== 'ours' && value.strategy !== 'theirs' && value.strategy !== 'manual') {
        throw new Error('resolve strategy must be ours, theirs, or manual')
      }
      if (
        typeof value.content !== 'string' ||
        Buffer.byteLength(value.content, 'utf8') > MAX_FILE_BYTES ||
        value.content.includes('\0')
      ) {
        throw new Error('content must be a UTF-8 string without NUL bytes')
      }
      return {
        type: 'resolveFile',
        path: requirePathInput(value.path, 'path'),
        fingerprint: requireString(value.fingerprint, 'fingerprint', 1024),
        strategy: value.strategy,
        content: value.content,
      }
    default:
      throw new Error(`Unsupported Git action: ${value.type}`)
  }
}

export async function resolveRepository(inputPath: string): Promise<string> {
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
      await runGit(candidate, ['rev-parse', '--is-bare-repository']),
    ).trim()
  } catch (error) {
    throw new Error(`Not a Git repository: ${commandDetail(error)}`)
  }
  if (isBare === 'true') {
    throw new Error('Bare Git repositories are not supported; choose a working tree')
  }

  let topLevel: string
  try {
    topLevel = stripTrailingNewline(await runGit(candidate, ['rev-parse', '--show-toplevel']))
  } catch (error) {
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

async function currentHeadOid(repoPath: string): Promise<string | null> {
  const value = await tryGit(repoPath, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    'HEAD^{commit}',
  ])
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
      if (name !== 'reference-transaction') {
        await fs.symlink(path.join(previousHooksPath, name), path.join(hooksPath, name))
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
  const hooks = await installReferenceTransactionGuard(repoPath)
  try {
    return await runGit(repoPath, ['-c', `core.hooksPath=${hooks.hooksPath}`, ...args], {
      ...env,
      GIT_STACKS_EXPECTED_HEAD_REF: expected.ref,
      GIT_STACKS_EXPECTED_HEAD_OLD: await expectedHeadOldValue(repoPath, expected.oid),
      GIT_STACKS_EXPECTED_HEAD_ERROR: `Cannot ${operation}: HEAD changed since this action started`,
      GIT_STACKS_PREVIOUS_REFERENCE_TRANSACTION: hooks.previousHook ?? '',
    })
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
    message: `Pushed ${target.branch} to ${target.remote}/${target.destination.slice('refs/heads/'.length)}`,
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
    message: `Force pushed ${target.branch} to ${target.remote}/${target.destination.slice('refs/heads/'.length)}`,
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

interface StashDropJournal {
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

async function optionalStashFile(filePath: string): Promise<Buffer | null> {
  try {
    const info = await fs.lstat(filePath)
    if (!info.isFile()) {
      throw new Error(`Cannot safely recover stash file ${path.basename(filePath)}`)
    }
    return await fs.readFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
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
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.changesRef !== 'boolean' ||
    typeof value.oldRef !== 'string' ||
    typeof value.oldLog !== 'string' ||
    (value.nextRef !== null && typeof value.nextRef !== 'string') ||
    typeof value.nextLog !== 'string' ||
    typeof value.refLock !== 'string' ||
    typeof value.logLock !== 'string' ||
    !validStashLockIdentity(value.refLockIdentity) ||
    !validStashLockIdentity(value.logLockIdentity)
  ) {
    throw new Error('The interrupted stash journal is invalid; refusing recovery')
  }
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

async function recoverStashDrop(commonPath: string): Promise<void> {
  const journalPath = path.join(commonPath, 'git-stacks-stash-drop.json')
  const journal = await readStashDropJournal(journalPath)
  if (!journal) return

  const refPath = path.join(commonPath, 'refs', 'stash')
  const logPath = path.join(commonPath, 'logs', 'refs', 'stash')
  const refLockPath = `${refPath}.lock`
  const logLockPath = `${logPath}.lock`
  const oldRef = decodeStashJournalBytes(journal.oldRef)
  const oldLog = decodeStashJournalBytes(journal.oldLog)
  const nextRef = journal.nextRef === null ? null : decodeStashJournalBytes(journal.nextRef)
  const nextLog = decodeStashJournalBytes(journal.nextLog)
  const refLock = decodeStashJournalBytes(journal.refLock)
  const logLock = decodeStashJournalBytes(journal.logLock)
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
}

async function recoverStashDropForRepository(repoPath: string): Promise<void> {
  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  await recoverStashDrop(path.resolve(repoPath, commonDir))
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

async function dropStashByOid(
  repoPath: string,
  ref: string,
  oid: string,
  apply?: () => Promise<void>,
): Promise<void> {
  const refStorage = await getConfigValue(repoPath, 'extensions.refstorage')
  if (refStorage && refStorage.toLowerCase() !== 'files') {
    throw new Error(`Cannot safely remove stash ${ref} with ${refStorage} reference storage`)
  }

  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  const commonPath = path.resolve(repoPath, commonDir)
  await recoverStashDrop(commonPath)
  const refPath = path.join(commonPath, 'refs', 'stash')
  const logPath = path.join(commonPath, 'logs', 'refs', 'stash')
  const refLockPath = `${refPath}.lock`
  const logLockPath = `${logPath}.lock`
  const journalPath = path.join(commonPath, 'git-stacks-stash-drop.json')
  let refLock: FileHandle | undefined
  let logLock: FileHandle | undefined
  let refLockExists = false
  let logLockExists = false
  let journalPending = false

  try {
    refLock = await fs.open(refLockPath, 'wx')
    refLockExists = true
    logLock = await fs.open(logLockPath, 'wx')
    logLockExists = true

    const [refInfo, logInfo, currentRef, logBuffer, stashes] = await Promise.all([
      fs.lstat(refPath),
      fs.lstat(logPath),
      fs.readFile(refPath),
      fs.readFile(logPath),
      getStashes(repoPath),
    ])
    if (!refInfo.isFile() || !logInfo.isFile()) {
      throw new Error(`Cannot safely remove stash ${ref} from this repository`)
    }
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
      currentRef.toString('utf8').trim().toLowerCase() !== stashes[0].oid.toLowerCase() ||
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
    if (selectedIndex === 0 && newTip === null) {
      const packedRefsPath = path.join(commonPath, 'packed-refs')
      const packedRefs = await fs.readFile(packedRefsPath, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      })
      if (/^[0-9a-f]{40,128} refs\/stash$/imu.test(packedRefs)) {
        throw new Error(`Cannot safely remove the last stash ${ref} from packed references`)
      }
    }
    if (apply) await apply()

    const nextLog = Buffer.from(rows.length > 0 ? `${rows.join('\n')}\n` : '', 'utf8')
    const changesRef = selectedIndex === 0
    const nextRef = changesRef ? (newTip ? Buffer.from(`${newTip}\n`, 'utf8') : null) : currentRef
    const refLockContents =
      changesRef && newTip ? Buffer.from(`${newTip}\n`, 'utf8') : Buffer.alloc(0)
    await logLock.writeFile(nextLog)
    await logLock.sync()
    await refLock.writeFile(refLockContents)
    await refLock.sync()
    const [refLockInfo, logLockInfo] = await Promise.all([
      fs.lstat(refLockPath),
      fs.lstat(logLockPath),
    ])
    const journal: StashDropJournal = {
      version: 1,
      changesRef,
      oldRef: encodeStashJournalBytes(currentRef),
      oldLog: encodeStashJournalBytes(logBuffer),
      nextRef: nextRef === null ? null : encodeStashJournalBytes(nextRef),
      nextLog: encodeStashJournalBytes(nextLog),
      refLock: encodeStashJournalBytes(refLockContents),
      logLock: encodeStashJournalBytes(nextLog),
      refLockIdentity: { dev: String(refLockInfo.dev), ino: String(refLockInfo.ino) },
      logLockIdentity: { dev: String(logLockInfo.dev), ino: String(logLockInfo.ino) },
    }
    await writeStashDropJournal(journalPath, journal)
    journalPending = true

    await fs.rename(logLockPath, logPath)
    logLockExists = false
    await logLock.close()
    logLock = undefined
    if (changesRef && nextRef !== null) {
      await fs.rename(refLockPath, refPath)
      refLockExists = false
    } else {
      if (changesRef) await fs.unlink(refPath)
      await fs.unlink(refLockPath)
      refLockExists = false
    }
    await refLock.close()
    refLock = undefined
    await fs.rm(journalPath)
    journalPending = false
  } catch (error) {
    if (journalPending) {
      throw new Error(
        `Stash removal was interrupted and will be recovered on the next repository refresh: ${commandDetail(error)}`,
      )
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another Git operation is changing the stash; retry after it completes')
    }
    throw error
  } finally {
    if (!journalPending) {
      try {
        if (logLockExists) await fs.rm(logLockPath, { force: true })
      } finally {
        if (refLockExists) await fs.rm(refLockPath, { force: true })
      }
    }
    await logLock?.close().catch(() => {})
    await refLock?.close().catch(() => {})
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

async function runSwitch(repoPath: string, ref: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'switch branches')
  await ensureClean(repoPath, 'switch branches')
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
  const remotes = (await getRemotes(repoPath)).sort((a, b) => b.length - a.length)
  const remote = remotes.find((name) => ref.startsWith(`refs/remotes/${name}/`))
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
async function baseForGh(
  repoPath: string,
  requestedBase: string,
  resolvedBase: string,
): Promise<string> {
  if (await refExists(repoPath, `refs/heads/${requestedBase}`)) {
    return requestedBase
  }
  const remote = (await getRemotes(repoPath))
    .sort((left, right) => right.length - left.length)
    .find((name) => resolvedBase.startsWith(`refs/remotes/${name}/`))
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
  if (!origin || origin.host !== 'github.com' || !headRemote || headRemote.host !== 'github.com') {
    throw new Error('PR creation requires github.com origin and upstream remotes.')
  }
  if (ghBase === remoteBranch && origin.fullName === headRemote.fullName) {
    throw new Error('The pull request base must differ from its head branch.')
  }
  const head =
    origin.fullName.toLowerCase() === headRemote.fullName.toLowerCase()
      ? remoteBranch
      : `${headRemote.owner}:${remoteBranch}`
  const args = [
    'pr',
    'create',
    '--repo',
    `github.com/${origin.fullName}`,
    '--title',
    title,
    '--body',
    body,
    '--base',
    ghBase,
    '--head',
    head,
  ]
  if (draft) {
    args.push('--draft')
  }
  let output: string
  try {
    output = await execute('gh', args, repoPath)
  } catch (error) {
    throw new Error(`Could not create pull request: ${commandDetail(error)}`)
  }
  const url = /(https?:\/\/[^\s]+)/u.exec(output)?.[1]
  return {
    message: `Created pull request from ${currentBranch} to ${ghBase}`,
    ...(url ? { url } : {}),
  }
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIFF_BYTES = 4 * 1024 * 1024
const MAX_HISTORY_SKIP = 1_000_000

function boundedText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return { text: value, truncated: false }
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

async function safeRepositoryPath(repoPath: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(repoPath, relativePath)
  if (candidate === repoPath || !candidate.startsWith(`${repoPath}${path.sep}`)) {
    throw new Error('Path must remain inside the repository')
  }
  const parts = relativePath.split(path.sep === '\\' ? /[\\/]/u : /\//u)
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
): Promise<FileIdentity> {
  const index = await runGit(repoPath, [
    '--literal-pathspecs',
    'ls-files',
    '--stage',
    '-z',
    '--',
    relativePath,
  ])
  const indexFingerprint = createHash('sha256').update(index).digest('hex')
  let stat: Stats | null = null
  let preview: Buffer | null = null
  let binary = false
  let truncated = false
  try {
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
    const currentStat = await fs.lstat(absolutePath)
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

async function fileFingerprint(repoPath: string, relativePath: string): Promise<FileIdentity> {
  const absolute = await safeRepositoryPath(repoPath, relativePath)
  return fileFingerprintAt(repoPath, relativePath, absolute)
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
): Promise<{ text: string; truncated: boolean }> {
  const args = [
    '--literal-pathspecs',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    ...(mode === 'cached' ? ['--cached'] : []),
    '--',
    relativePath,
  ]
  return boundedText(await runGit(repoPath, args), MAX_DIFF_BYTES)
}

export async function getFileView(repoPath: string, requestedPath: string): Promise<FileView> {
  const root = await resolveRepository(repoPath)
  const filePath = requirePathInput(requestedPath, 'path')
  const entry = changedEntry(await getStatus(root), filePath)
  const actualPath = entry.path
  const [stagedDiff, unstagedDiff, identity] = await Promise.all([
    changedDiff(root, 'cached', actualPath),
    changedDiff(root, 'worktree', actualPath),
    fileFingerprint(root, actualPath),
  ])
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
  }
}

async function checkFileFingerprint(
  repoPath: string,
  filePath: string,
  expected: string,
): Promise<{ entry: ChangedFile; identity: FileIdentity }> {
  const entry = changedEntry(await getStatus(repoPath), filePath)
  const identity = await fileFingerprint(repoPath, entry.path)
  if (identity.fingerprint !== expected) {
    throw new Error('The file changed since it was opened; refresh before applying this action')
  }
  return { entry, identity }
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

async function restoreQuarantinedFile(backupPath: string, targetPath: string): Promise<void> {
  const info = await fs.lstat(backupPath)
  if (!info.isFile()) throw new Error('The changed path cannot be restored safely')
  await fs.link(backupPath, targetPath)
  await fs.unlink(backupPath)
}

async function replaceCheckedFile(
  repoPath: string,
  relativePath: string,
  expected: FileIdentity,
  sourcePath: string | null,
  content?: string,
): Promise<void> {
  const targetPath = await safeRepositoryPath(repoPath, relativePath)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await safeRepositoryPath(repoPath, relativePath)
  const stagingDirectory = await fs.mkdtemp(path.join(path.dirname(targetPath), '.git-stacks-'))
  const backupPath = path.join(stagingDirectory, 'original')
  const replacementPath =
    sourcePath !== null || content !== undefined ? path.join(stagingDirectory, 'replacement') : null
  let movedOriginal = false
  let preserveStagingDirectory = false
  try {
    if (sourcePath !== null) {
      const sourceInfo = await fs.stat(sourcePath)
      if (!sourceInfo.isFile()) throw new Error('The replacement path is not a regular file')
      await fs.copyFile(sourcePath, replacementPath!)
      await fs.chmod(replacementPath!, sourceInfo.mode & 0o777)
    } else if (content !== undefined) {
      await fs.writeFile(replacementPath!, content, {
        encoding: 'utf8',
        mode: expected.stat ? expected.stat.mode & 0o777 : 0o666,
      })
      if (expected.stat) {
        await fs.chmod(replacementPath!, expected.stat.mode & 0o777)
      }
    }

    try {
      await fs.rename(targetPath, backupPath)
      movedOriginal = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const current = await fileFingerprintAt(
      repoPath,
      relativePath,
      movedOriginal ? backupPath : targetPath,
    )
    if (!sameFileMutationIdentity(expected, current)) {
      throw new Error('The file changed during the action; refresh before retrying')
    }

    if (replacementPath) {
      try {
        await fs.link(replacementPath, targetPath)
      } catch (error) {
        if (movedOriginal && (error as NodeJS.ErrnoException).code === 'EEXIST') {
          preserveStagingDirectory = true
          throw new Error(
            `A concurrent file appeared during the action; prior contents are preserved at ${path.relative(repoPath, backupPath)}`,
          )
        }
        throw error
      }
      await fs.unlink(replacementPath)
    } else if (movedOriginal) {
      try {
        await fs.lstat(targetPath)
        preserveStagingDirectory = true
        throw new Error(
          `A concurrent file appeared during the action; prior contents are preserved at ${path.relative(repoPath, backupPath)}`,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    if (movedOriginal) {
      await fs.unlink(backupPath)
      movedOriginal = false
    }
  } catch (error) {
    if (movedOriginal && !preserveStagingDirectory) {
      try {
        await restoreQuarantinedFile(backupPath, targetPath)
        movedOriginal = false
      } catch {
        preserveStagingDirectory = true
      }
    }
    if (preserveStagingDirectory) {
      throw new Error(
        `${commandDetail(error)}; prior contents are preserved at ${path.relative(repoPath, backupPath)}`,
      )
    }
    throw error
  } finally {
    if (!preserveStagingDirectory) {
      await fs.rm(stagingDirectory, { recursive: true, force: true })
    }
  }
}

export async function runDiscardFile(
  repoPath: string,
  filePath: string,
  fingerprint: string,
): Promise<ActionResult> {
  const root = await resolveRepository(repoPath)
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

async function hasConflictStage(
  repoPath: string,
  relativePath: string,
  stage: number,
): Promise<boolean> {
  const output = await runGit(repoPath, [
    '--literal-pathspecs',
    'ls-files',
    '-u',
    '-z',
    '--',
    relativePath,
  ])
  return output.split('\0').some((token) => token.split(/\s+/u)[2] === String(stage))
}

export async function runResolveFile(
  repoPath: string,
  filePath: string,
  fingerprint: string,
  strategy: 'ours' | 'theirs' | 'manual',
  content: string,
): Promise<ActionResult> {
  const root = await resolveRepository(repoPath)
  const { entry, identity } = await checkFileFingerprint(root, filePath, fingerprint)
  if (!entry.conflicted) throw new Error('The selected file has no unresolved conflict')
  const actualPath = entry.path
  await safeRepositoryPath(root, actualPath)
  let materializedRoot: string | null = null
  let sourcePath: string | null = null
  try {
    if (strategy === 'manual') {
      await replaceCheckedFile(root, actualPath, identity, null, content)
    } else {
      const stage = strategy === 'ours' ? 2 : 3
      if (await hasConflictStage(root, actualPath, stage)) {
        const materialized = await materializeGitWorktreePath(root, actualPath, [
          '--literal-pathspecs',
          'checkout',
          `--${strategy}`,
          '--',
          actualPath,
        ])
        materializedRoot = materialized.root
        sourcePath = materialized.path
      }
      await replaceCheckedFile(root, actualPath, identity, sourcePath)
    }
  } finally {
    if (materializedRoot) {
      await fs.rm(materializedRoot, { recursive: true, force: true })
    }
  }
  await runGit(root, ['--literal-pathspecs', 'add', '--', actualPath])
  return { message: `Resolved ${actualPath} using ${strategy}` }
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
): Promise<HistoryPage> {
  const root = await resolveRepository(repoPath)
  const requestedRef = requireRefInput(ref, 'history ref')
  const offset = requireHistorySkip(skip)
  const resolved = await tryGit(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${requestedRef}^{commit}`,
  ])
  if (!resolved) {
    const current = await getCurrentBranch(root)
    if (
      requestedRef !== 'HEAD' &&
      requestedRef !== current &&
      requestedRef !== `refs/heads/${current ?? ''}`
    ) {
      throw new Error(`History ref "${requestedRef}" does not exist`)
    }
    return { commits: [], hasMore: false }
  }
  const output = await runGit(root, [
    'log',
    '--no-ext-diff',
    '--skip',
    String(offset),
    '-n',
    '51',
    '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00',
    '--end-of-options',
    requestedRef,
  ])
  const values = output.split('\0')
  const commits: Commit[] = []
  for (let index = 0; index + 4 < values.length; index += 5) {
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
  return { commits: commits.slice(0, 50), hasMore: commits.length > 50 }
}

export async function getCommitDiff(
  repoPath: string,
  oid: string,
): Promise<{ text: string; truncated: boolean }> {
  const root = await resolveRepository(repoPath)
  const commitOid = requireOid(oid, 'commit oid')!
  const resolved = await tryGit(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${commitOid}^{commit}`,
  ])
  if (!resolved) throw new Error(`Commit "${commitOid}" does not exist`)
  const output = await runGit(root, [
    'show',
    '--format=',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--patch',
    '--end-of-options',
    commitOid,
  ])
  return boundedText(output, MAX_DIFF_BYTES)
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
export async function getSnapshot(repoPath: string): Promise<RepositorySnapshot> {
  const root = await resolveRepository(repoPath)
  await recoverStashDropForRepository(root)
  const [refs, currentBranch, files, stashes, originUrl, operationState, stackOperation, headOid] =
    await Promise.all([
      getRefs(root),
      getCurrentBranch(root),
      getStatus(root),
      getStashes(root),
      getOriginUrl(root),
      getOperationState(root),
      getStackProgress(root),
      currentHeadOid(root),
    ])

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
    const upstream = await branchUpstream(root, currentBranch)
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

  const defaultBranch = await getDefaultBranch(root, refs, currentBranch)
  const github = await getGitHubData(root, originUrl)
  const parentConfigs = await Promise.all(
    branches
      .filter((branch) => !branch.remote)
      .map(async (branch) => ({
        name: branch.name,
        parent: await getBranchParent(root, branch.name),
        parentTip: await getConfigValue(root, `branch.${branch.name}.parentTip`),
      })),
  )
  const configParents = new Map(
    parentConfigs.map((entry) => [
      entry.name,
      { parent: entry.parent, parentTip: entry.parentTip },
    ]),
  )
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
    branch.parent = config?.parent ?? pullRequest?.base ?? null
    branch.parentTip = config?.parentTip ?? null
    branch.parentSource = config?.parent ? 'recorded' : pullRequest ? 'pullRequest' : null
  }

  const refsByName = new Map(refs.filter((ref) => !ref.symref).map((ref) => [ref.refname, ref]))
  const defaultRef =
    refsByName.get(`refs/heads/${defaultBranch}`) ??
    refsByName.get(`refs/remotes/origin/${defaultBranch}`)
  if (defaultRef) {
    await Promise.all(
      branches.map(async (branch) => {
        if (branch.parent) return
        const child = refsByName.get(branch.ref)
        const local = !branch.remote
        const originRemote = branch.remote && branch.ref.startsWith('refs/remotes/origin/')
        if (
          !child ||
          (!local && !originRemote) ||
          branch.ref === `refs/heads/${defaultBranch}` ||
          branch.ref === `refs/remotes/origin/${defaultBranch}` ||
          branch.ref === defaultRef.refname
        ) {
          return
        }
        if (
          (await tryGit(root, ['merge-base', child.objectName, defaultRef.objectName])) !== null
        ) {
          branch.parent = defaultBranch
          branch.parentSource = 'inferred'
        }
      }),
    )
  }

  const effectiveDefault = await parentTarget(root, defaultBranch, defaultBranch, false)
  await Promise.all(
    branches.map(async (branch) => {
      if (!branch.parent) return
      const child = refsByName.get(branch.ref)
      const parent =
        (branch.parent === defaultBranch && effectiveDefault
          ? refsByName.get(effectiveDefault.ref)
          : null) ??
        refsByName.get(`refs/heads/${branch.parent}`) ??
        refsByName.get(`refs/remotes/${branch.parent}`) ??
        refsByName.get(`refs/remotes/origin/${branch.parent}`)
      if (!child || !parent || child.refname === parent.refname) {
        branch.needsRestack = Boolean(branch.parentTip && !parent)
        return
      }
      branch.parentBehind = Number(
        await runGit(root, [
          'rev-list',
          '--count',
          `${child.objectName}..${parent.objectName}`,
          '--',
        ]),
      )
      branch.needsRestack =
        (branch.parentBehind ?? 0) > 0 ||
        Boolean(branch.parentTip && branch.parentTip !== parent.objectName)
    }),
  )

  return {
    path: root,
    name: path.basename(root) || root,
    currentBranch,
    defaultBranch,
    remoteUrl: originUrl,
    branches,
    pullRequests: github.pullRequests,
    files,
    stashes,
    rebaseInProgress: operationState.rebase,
    operation: operationState.operation,
    stackOperation,
    headOid,
    github: { available: github.available, message: github.message },
  }
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
    state.operation === 'merge' || state.operation === 'cherryPick' || state.operation === 'revert'
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
    action.type === 'resolveFile' ||
    action.type === 'stackContinue' ||
    action.type === 'stackAbort'
  ) {
    return
  }
  throw new Error('A stack operation is in progress; finish or abort it before other writes')
}
async function runDeleteRemoteBranch(
  repoPath: string,
  ref: string,
  expectedOid: string,
): Promise<ActionResult> {
  const prefix = 'refs/remotes/'
  if (!ref.startsWith(prefix)) {
    throw new Error('Only fetched remote branch refs can be deleted')
  }
  await ensureNoBusyOperation(repoPath, 'delete a remote branch')
  const remotes = (await getRemotes(repoPath)).sort((left, right) => right.length - left.length)
  const remainder = ref.slice(prefix.length)
  const remote = remotes.find((name) => remainder.startsWith(`${name}/`))
  if (!remote) throw new Error('The selected remote branch has no configured remote')
  const branch = remainder.slice(remote.length + 1)
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
  const refs = await getRefs(repoPath)
  const defaultBranch = await getDefaultBranch(repoPath, refs, await getCurrentBranch(repoPath))
  const pushUrl = await getRemotePushUrl(repoPath, remote)
  const remoteHead = await remoteHeadDestination(repoPath, pushUrl)
  if (branch === defaultBranch || remoteHead === `refs/heads/${branch}`) {
    throw new Error('The default or remote HEAD branch cannot be deleted')
  }
  const symbolic = await tryGit(repoPath, ['symbolic-ref', '--quiet', ref])
  if (symbolic) throw new Error('The remote symbolic HEAD cannot be deleted')
  const remoteOid = await getRemoteOid(repoPath, pushUrl, `refs/heads/${branch}`)
  if (!remoteOid || remoteOid.toLowerCase() !== expectedOid.toLowerCase()) {
    throw new Error('The remote branch changed; fetch and refresh before deleting it')
  }
  await runGit(repoPath, [
    '-c',
    'push.followTags=false',
    'push',
    `--force-with-lease=refs/heads/${branch}:${expectedOid}`,
    '--no-mirror',
    '--no-follow-tags',
    '--',
    pushUrl,
    `:refs/heads/${branch}`,
  ])
  return { message: `Deleted remote branch ${remote}/${branch}` }
}

// Hold the absent branch ref locked while its per-branch config is removed.
async function withAbsentRefLock(
  repoPath: string,
  ref: string,
  operation: () => Promise<void>,
): Promise<void> {
  const child = spawn('git', ['update-ref', '--stdin'], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GCM_INTERACTIVE: 'Never',
    },
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
  child.stdin.write(`start\nverify ${ref}\nprepare\n`)

  try {
    await prepareResult
  } catch (error) {
    try {
      child.stdin.end('abort\n')
    } catch {
      // The update-ref process may already have exited.
    }
    await completed
    if (await refExists(repoPath, ref)) return
    throw new Error(
      stderr.trim() || commandDetail(error) || `Could not lock ${ref} for configuration cleanup`,
    )
  }

  try {
    await operation()
  } catch (error) {
    try {
      child.stdin.end('abort\n')
    } catch {
      // The update-ref process may already have exited.
    }
    await completed
    throw error
  }
  child.stdin.end('commit\n')
  const result = await completed
  if (result.code !== 0) {
    throw new Error(stderr.trim() || `Git could not finish cleanup for ${ref}`)
  }
  return
}

async function deleteLocalBranchRef(
  repoPath: string,
  ref: string,
  branchName: string,
  expectedOid: string,
  cleanupConfig: () => Promise<void>,
): Promise<void> {
  const child = spawn('git', ['update-ref', '--stdin'], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GCM_INTERACTIVE: 'Never',
    },
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
  child.stdin.write(`start\ndelete ${ref} ${expectedOid}\nprepare\n`)

  try {
    await prepareResult
  } catch {
    try {
      child.stdin.end('abort\n')
    } catch {
      // The update-ref process may already have exited.
    }
    await completed
    throw new Error('The branch changed since it was selected; refresh before deleting it')
  }
  try {
    await ensureNotCheckedOutElsewhere(repoPath, branchName)
  } catch (error) {
    try {
      child.stdin.end('abort\n')
    } catch {
      // The update-ref process may already have exited.
    }
    await completed
    throw error
  }

  child.stdin.end('commit\n')
  const result = await completed
  if (result.code !== 0) {
    throw new Error(stderr.trim() || `Git could not complete deletion of ${ref}`)
  }
  try {
    await withAbsentRefLock(repoPath, ref, cleanupConfig)
  } catch (error) {
    throw new Error(
      `Deleted branch ${branchName}, but could not remove its configuration: ${commandDetail(error)}`,
    )
  }
}

async function runDeleteBranch(
  repoPath: string,
  ref: string,
  force: boolean,
  expectedOid: string,
): Promise<ActionResult> {
  if (!ref.startsWith('refs/heads/')) {
    throw new Error('Only local branches can be deleted')
  }
  const name = ref.slice('refs/heads/'.length)
  await validateBranchName(repoPath, name)
  await ensureNoBusyOperation(repoPath, 'delete a branch')
  const [refs, currentBranch] = await Promise.all([getRefs(repoPath), getCurrentBranch(repoPath)])
  if (name === currentBranch) {
    throw new Error('Switch to another branch before deleting the current branch')
  }
  if (name === (await getDefaultBranch(repoPath, refs, currentBranch))) {
    throw new Error('The default branch cannot be deleted')
  }
  if (!refs.some((entry) => entry.refname === ref && !entry.symref)) {
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
  await deleteLocalBranchRef(repoPath, ref, name, currentOid, async () => {
    await tryGit(repoPath, ['config', '--remove-section', `branch.${name}`])
  })
  return { message: `Deleted local branch ${name}. Remote branches were not changed.` }
}

export async function runAction(repoPath: string, value: GitAction): Promise<ActionResult> {
  const root = await resolveRepository(repoPath)
  const action = validateAction(value)
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
      return runSwitch(root, action.ref)
    case 'createBranch':
      return runCreateBranch(root, action.name, action.parent)
    case 'deleteBranch':
      return runDeleteBranch(root, action.ref, action.force, action.expectedOid)
    case 'deleteRemoteBranch':
      return runDeleteRemoteBranch(root, action.ref, action.expectedOid)
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
    case 'resolveFile':
      return runResolveFile(root, action.path, action.fingerprint, action.strategy, action.content)
    case 'createPr':
      return runCreatePr(root, action.title, action.body, action.base, action.draft)
  }
}
