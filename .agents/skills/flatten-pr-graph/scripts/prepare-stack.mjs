#!/usr/bin/env node
/**
 * Local cumulative preparation for `flatten-pr-graph/1`.
 *
 * One job: given an authorized order and its immutable snapshots, produce the
 * cumulative prepared heads - each selected pull request's own original head with its
 * predecessor's **new** prepared state integrated into it - and emit the contract's
 * `preparation` document with the evidence behind every decision.
 *
 * Why this is a program and not prose: creating isolated task-owned workspaces,
 * integrating a pinned predecessor head into each successor, retaining every original
 * commit, classifying a conflict by what Git actually staged, and checking ancestry,
 * index state, and dropped contributions against real commits are exactly the
 * operations an agent gets subtly wrong. Deciding what a conflict *should* say stays
 * with the agent: this script reports both sides, the merge base, the staged blobs, and
 * the paths that need a decision, and stops there. It never picks a side.
 *
 * What it will never do: push a ref, write provider metadata, touch the user's
 * checkout, index, stash, or configuration, rewrite a published commit, create a
 * redundant integration commit, or run tests, lint, builds, or installs. There is no
 * code path here that contacts a remote.
 *
 * Input JSON (stdin or `--input <file>`):
 *
 *   {
 *     "contractVersion": "flatten-pr-graph/1",
 *     "repository": "/abs/path/to/task-owned/storage-or-checkout",
 *     "runDirectory": "/abs/path/to/task-owned/run",
 *     "userWorkspace": "/abs/path/to/user/checkout",
 *     "root": { "ref": "refs/heads/main", "oid": "<sha>" },
 *     "selection": [12, 13],
 *     "order": [12, 13],
 *     "heads": { "12": "refs/heads/feat-a", "13": "refs/heads/feat-b" },
 *     "originalHeads": { "12": "<sha>", "13": "<sha>" },
 *     "hardDependencies": [{ "before": 12, "after": 13, "source": "pr-base", "evidence": "..." }],
 *     "resolutions": [
 *       { "number": 13, "path": "src/a.ts", "content": "...", "kind": "content",
 *         "intent": "both PRs extend the same helper", "reason": "kept both additions" }
 *     ],
 *     "justifiedDrops": [{ "number": 13, "path": "docs/old.md", "reason": "..." }],
 *     "resume": false,
 *     "now": "2026-10-01T09:00:00.000Z"
 *   }
 *
 * `resolutions` is the agent's decision, supplied explicitly: a resolution without
 * `intent` and `reason` is refused, and a path with no resolution is reported as
 * unresolved with both sides' evidence instead of a guess. `absent` is a legitimate
 * resolution value for a path that should not exist in the integrated tree.
 *
 * Output JSON on stdout:
 * `{ contractVersion, ok, errors, run, preparation, verification, continuation,
 *    conflicts, userWorkspace }`. `errors` are structured `{ code, detail, evidence }`;
 * `ok:false` means nothing was published and the recoverable local state stays where it
 * is, because that state is the only copy of the conflict decisions.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const CONTRACT_VERSION = 'flatten-pr-graph/1'
const GIT_TIMEOUT_MS = 300_000
const MAX_EVIDENCE_CHARS = 4_000

class InputError extends Error {
  constructor(code, detail, evidence) {
    super(detail)
    this.code = code
    this.detail = detail
    this.evidence = evidence
  }
}

class GitFailure extends Error {
  constructor(args, result) {
    super(`git ${args.join(' ')} exited ${result.status ?? 'unknown'}`)
    this.args = args
    this.stderr = String(result.stderr ?? '')
    this.stdout = String(result.stdout ?? '')
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const ROUTING_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_GRAFT_FILE',
]

function sanitizedEnv() {
  const env = { ...process.env }
  for (const v of ROUTING_ENV_VARS) delete env[v]
  return env
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: sanitizedEnv(),
      // A probe that is allowed to fail must not print Git's complaint into the caller's
      // stream: the caller reads the structured result, not a guessed failure.
      ...(allowFailure ? { stdio: ['ignore', 'pipe', 'pipe'] } : {}),
    })
    return { ok: true, status: 0, stdout: String(stdout), stderr: '' }
  } catch (error) {
    const result = {
      ok: false,
      status: typeof error?.status === 'number' ? error.status : null,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    }
    if (allowFailure) return result
    throw new GitFailure(args, result)
  }
}

/** Runs Git and returns trimmed stdout, or null when Git exits non-zero. */
function gitOut(cwd, args) {
  const result = runGit(cwd, args, { allowFailure: true })
  return result.ok ? result.stdout.trim() : null
}

function requirePositiveInteger(value, where) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InputError(
      'invalid-input',
      `${where} must be a positive integer pull request number`,
      `received ${JSON.stringify(value)}`,
    )
  }
  return value
}

function requireSha(value, where) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new InputError(
      'invalid-input',
      `${where} must be a full 40-character commit id`,
      `received ${JSON.stringify(value)}`,
    )
  }
  return value.toLowerCase()
}

/**
 * Git itself decides whether a ref name is valid. The value is passed as one argv entry
 * and never concatenated into a command, so nothing in it is ever interpreted.
 */
function requireRefName(value, where) {
  const check = runGit(process.cwd(), ['check-ref-format', String(value ?? '')], {
    allowFailure: true,
  })
  if (typeof value !== 'string' || value.length === 0 || !check.ok) {
    throw new InputError(
      'invalid-input',
      `${where} must be a ref name git accepts`,
      `received ${JSON.stringify(value)}`,
    )
  }
  return value
}

function requireDirectory(value, where) {
  if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value)) {
    throw new InputError(
      'invalid-input',
      `${where} must be an existing absolute directory`,
      `received ${JSON.stringify(value)}`,
    )
  }
  return resolve(value)
}

/**
 * Task-owned storage the helper creates itself. An absolute path is required so a
 * relative path can never resolve into somebody else's checkout, and the directory need
 * not exist yet because creating it is the helper's own work.
 */
function requireTaskDirectory(value, where, repository, userWorkspace) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new InputError(
      'invalid-input',
      `${where} must be an absolute path`,
      `received ${JSON.stringify(value)}`,
    )
  }
  const path = resolve(value)
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      throw new InputError(
        'invalid-input',
        `${where} must not be a symbolic link`,
        `path ${path} is a symlink`,
      )
    }
    const real = realpathSync(path)
    if (repository) {
      const realRepo = realpathSync(repository)
      const relRepo = relative(realRepo, real)
      if (relRepo === '' || (!relRepo.startsWith('..') && !isAbsolute(relRepo))) {
        throw new InputError(
          'invalid-input',
          `${where} must not be inside or equal to repository`,
          `${where}=${real}, repository=${realRepo}`,
        )
      }
      const revRepo = relative(real, realRepo)
      if (revRepo === '' || (!revRepo.startsWith('..') && !isAbsolute(revRepo))) {
        throw new InputError(
          'invalid-input',
          `repository must not be inside or equal to ${where}`,
          `repository=${realRepo}, ${where}=${real}`,
        )
      }
    }
    if (userWorkspace) {
      const realUser = realpathSync(userWorkspace)
      const relUser = relative(realUser, real)
      if (relUser === '' || (!relUser.startsWith('..') && !isAbsolute(relUser))) {
        throw new InputError(
          'invalid-input',
          `${where} must not be inside or equal to userWorkspace`,
          `${where}=${real}, userWorkspace=${realUser}`,
        )
      }
      const revUser = relative(real, realUser)
      if (revUser === '' || (!revUser.startsWith('..') && !isAbsolute(revUser))) {
        throw new InputError(
          'invalid-input',
          `userWorkspace must not be inside or equal to ${where}`,
          `userWorkspace=${realUser}, ${where}=${real}`,
        )
      }
    }
    const storageLink = join(path, 'storage.git')
    if (existsSync(storageLink) && lstatSync(storageLink).isSymbolicLink()) {
      throw new InputError(
        'invalid-input',
        'storage.git in task run directory must not be a symbolic link',
        `symlink at ${storageLink}`,
      )
    }
  }
  mkdirSync(path, { recursive: true })
  return path
}

function digest(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}

function userWorktreeDigest(repo) {
  const parts = [gitOut(repo, ['diff', '--binary']) ?? '']
  const untracked = lines(gitOut(repo, ['ls-files', '--others', '--exclude-standard']) ?? '')
  for (const relativePath of untracked) {
    const full = join(repo, relativePath)
    try {
      parts.push(relativePath, readFileSync(full, 'utf8'))
    } catch {
      // unreadable
    }
  }
  return parts.join('\u0000')
}

/**
 * The user's checkout, read and never written. The helper inspects it to report what the
 * run found - a dirty, staged, untracked, detached, or mid-operation workspace is a fact
 * the result carries, not something to normalize - and every Git call below runs in a
 * task-owned directory.
 */
export function readUserFingerprint(userWorkspace) {
  if (!userWorkspace) return null
  const path = requireDirectory(userWorkspace, 'userWorkspace')
  const status = lines(
    gitOut(path, ['status', '--porcelain=v1', '--untracked-files=all']) ?? '',
  ).join('\n')
  const headRef = gitOut(path, ['symbolic-ref', '--quiet', 'HEAD']) ?? 'DETACHED'
  const headOid = gitOut(path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const operations = [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'rebase-merge',
    'rebase-apply',
  ].filter((marker) => existsSync(join(path, '.git', marker)))
  const stash = gitOut(path, ['stash', 'list', '--format=%H']) ?? ''
  const indexDigest = digest(gitOut(path, ['diff', '--cached', '--binary']) ?? '')
  const worktreeDigest = digest(userWorktreeDigest(path))
  const stashOids = lines(stash).join('\n')
  const stashCount = lines(stash).length
  const configDigest = digest(lines(gitOut(path, ['config', '--local', '--list']) ?? '').join('\n'))
  const identity = `${gitOut(path, ['config', '--local', 'user.name']) ?? ''} <${
    gitOut(path, ['config', '--local', 'user.email']) ?? ''
  }>`
  return {
    present: true,
    path,
    headRef,
    headOid: headOid ?? null,
    status,
    dirtyPaths: lines(status).map((entry) => entry.slice(3)),
    stagedPaths: lines(status)
      .filter((entry) => entry[0] !== ' ' && entry[0] !== '?')
      .map((entry) => entry.slice(3)),
    untrackedPaths: lines(status)
      .filter((entry) => entry.startsWith('??'))
      .map((entry) => entry.slice(3)),
    indexDigest,
    worktreeDigest,
    stashOids,
    stashCount,
    configDigest,
    identity,
    operationsInProgress: operations,
    shallow: gitOut(path, ['rev-parse', '--is-shallow-repository']) === 'true',
  }
}

function verifyPlan(raw) {
  const repository = requireDirectory(raw.repository, 'repository')
  const userWorkspace = raw.userWorkspace
    ? requireDirectory(raw.userWorkspace, 'userWorkspace')
    : null
  const runDirectory = requireTaskDirectory(
    raw.runDirectory,
    'runDirectory',
    repository,
    userWorkspace,
  )
  const root = {
    ref: requireRefName(raw.root?.ref, 'root.ref'),
    oid: requireSha(raw.root?.oid, 'root.oid'),
  }
  const selection = (Array.isArray(raw.selection) ? raw.selection : []).map((number, index) =>
    requirePositiveInteger(number, `selection[${index}]`),
  )
  const order = (Array.isArray(raw.order) ? raw.order : []).map((number, index) =>
    requirePositiveInteger(number, `order[${index}]`),
  )
  if (selection.length === 0) {
    throw new InputError(
      'invalid-input',
      'a missing selection is a missing input, never a wildcard',
      'selection was empty',
    )
  }
  if (new Set(order).size !== order.length || order.length !== selection.length) {
    throw new InputError(
      'invalid-input',
      'the order must place every selected identity exactly once',
      `selection ${JSON.stringify(selection)}, order ${JSON.stringify(order)}`,
    )
  }
  for (const number of selection) {
    if (!order.includes(number)) {
      throw new InputError(
        'invalid-input',
        `selected pull request #${number} is missing from the order`,
        `order ${JSON.stringify(order)}`,
      )
    }
  }
  const hardDependencies = (Array.isArray(raw.hardDependencies) ? raw.hardDependencies : []).map(
    (entry, index) => ({
      before: requirePositiveInteger(entry?.before, `hardDependencies[${index}].before`),
      after: requirePositiveInteger(entry?.after, `hardDependencies[${index}].after`),
      source: typeof entry?.source === 'string' ? entry.source : 'unknown',
      evidence: typeof entry?.evidence === 'string' ? entry.evidence : '',
    }),
  )
  for (const edge of hardDependencies) {
    if (!order.includes(edge.before) || !order.includes(edge.after)) continue
    if (order.indexOf(edge.before) > order.indexOf(edge.after)) {
      throw new InputError(
        'invalid-input',
        `the order places #${edge.after} before its hard prerequisite #${edge.before}`,
        `${edge.source}: ${edge.evidence}`,
      )
    }
  }
  const heads = {}
  const originalHeads = {}
  for (const number of order) {
    heads[number] = requireRefName(
      raw.heads?.[String(number)] ?? raw.heads?.[number],
      `heads[${number}]`,
    )
    originalHeads[number] = requireSha(
      raw.originalHeads?.[String(number)] ?? raw.originalHeads?.[number],
      `originalHeads[${number}]`,
    )
  }
  const resolutions = (Array.isArray(raw.resolutions) ? raw.resolutions : []).map(
    (entry, index) => ({
      number: requirePositiveInteger(entry?.number, `resolutions[${index}].number`),
      path: typeof entry?.path === 'string' && entry.path.length > 0 ? entry.path : null,
      content: typeof entry?.content === 'string' ? entry.content : null,
      absent: entry?.absent === true,
      kind: typeof entry?.kind === 'string' ? entry.kind : 'content',
      intent: typeof entry?.intent === 'string' ? entry.intent : '',
      reason: typeof entry?.reason === 'string' ? entry.reason : '',
    }),
  )
  const justifiedDrops = (Array.isArray(raw.justifiedDrops) ? raw.justifiedDrops : []).map(
    (entry, index) => ({
      number: requirePositiveInteger(entry?.number, `justifiedDrops[${index}].number`),
      path: typeof entry?.path === 'string' ? entry.path : '',
      reason: typeof entry?.reason === 'string' ? entry.reason : '',
    }),
  )
  return {
    repository,
    runDirectory,
    userWorkspace: raw.userWorkspace ? requireDirectory(raw.userWorkspace, 'userWorkspace') : null,
    root,
    selection,
    order,
    heads,
    originalHeads,
    hardDependencies,
    resolutions,
    justifiedDrops,
    resume: raw.resume === true,
    now: typeof raw.now === 'string' ? raw.now : new Date().toISOString(),
  }
}

/** Lockfiles and generated output: paths whose content a merge must not invent. */
const LOCKFILE_PATTERN =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|Gemfile\.lock|composer\.lock|flake\.lock|mix\.lock)$/
const GENERATED_PATTERN =
  /(^|\/)(dist|build|target|out|coverage|node_modules)\/|(^|\/).*\.(generated|gen|min\.js|min\.css|pb\.go|pb\.cc|pb\.swift|tmpl\.go|tmpl\.ts)$/

function classifyPath(path) {
  if (LOCKFILE_PATTERN.test(path)) return 'lockfile'
  if (GENERATED_PATTERN.test(path)) return 'generated'
  return null
}

const STRUCTURAL_KINDS = new Set([
  'add-add',
  'delete-modify',
  'modify-delete',
  'rename-conflict',
  'file-directory',
  'submodule',
  'binary',
  'symlink',
])

function seedStorage(input) {
  const storage = join(input.runDirectory, 'storage.git')
  const works = join(input.runDirectory, 'workspaces')
  mkdirSync(storage, { recursive: true })
  mkdirSync(works, { recursive: true })
  if (gitOut(storage, ['rev-parse', '--git-dir']) === null) {
    runGit(input.runDirectory, [
      'init',
      '--bare',
      '--quiet',
      `--initial-branch=${input.root.ref.split('/').pop()}`,
      storage,
    ])
  }
  for (const [number, headRef] of Object.entries(input.heads)) {
    const sourceOid = gitOut(input.repository, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${headRef}^{commit}`,
    ])
    if (!sourceOid) {
      throw new InputError(
        'stale-snapshot',
        `selected head ref ${headRef} of #${number} does not exist in the source repository`,
        `source repository: ${input.repository}`,
      )
    }
  }
  const sourceRootOid = gitOut(input.repository, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${input.root.ref}^{commit}`,
  ])
  if (!sourceRootOid) {
    throw new InputError(
      'stale-snapshot',
      `root ref ${input.root.ref} does not exist in the source repository`,
      `source repository: ${input.repository}`,
    )
  }

  // One read-only copy of every published head. Nothing is pushed into the user's
  // repository from here, and the root is captured at the pinned commit id.
  const refspecs = Array.from(new Set([input.root.ref, ...Object.values(input.heads)])).map(
    (ref) => `+${ref}:${ref}`,
  )
  const fetch = runGit(
    input.runDirectory,
    ['--git-dir', storage, 'fetch', '--quiet', input.repository, ...refspecs],
    { allowFailure: true },
  )
  if (!fetch.ok) {
    throw new InputError(
      'invalid-input',
      'the repository could not be fetched into task-owned storage',
      fetch.stderr.trim().slice(0, 400),
    )
  }
  return { storage, works }
}

function storageOid(storage, ref) {
  return gitOut(storage, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
}

/**
 * `git merge-base --is-ancestor` answers through its exit status, not its output: exit
 * zero means the ancestry holds, and a missing object means "cannot be decided" rather
 * than "not an ancestor". Both are evidence the run uses; neither is a yes by default.
 */
function isAncestor(storage, ancestor, descendant) {
  return runGit(storage, ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  }).ok
}

function verifySnapshot(input, storage) {
  const errors = []
  const sourceLs = runGit(input.runDirectory, ['ls-remote', '--heads', input.repository], {
    allowFailure: true,
  })
  const sourceRefs = {}
  if (sourceLs.ok) {
    for (const line of lines(sourceLs.stdout)) {
      const [oid, ref] = line.split(/\s+/)
      if (ref && oid) sourceRefs[ref] = oid
    }
  }
  if (sourceLs.ok && !sourceRefs[input.root.ref]) {
    errors.push({
      code: 'stale-snapshot',
      detail: `the root ref ${input.root.ref} is absent from the source repository`,
      evidence: `source repository holds ${Object.keys(sourceRefs).length} branches`,
    })
  }
  const rootOid = storageOid(storage, input.root.ref)
  if (rootOid !== input.root.oid) {
    errors.push({
      code: 'stale-snapshot',
      detail: `the root ${input.root.ref} moved since the plan was authorized`,
      evidence: `pinned ${input.root.oid}, storage holds ${rootOid ?? 'nothing'}`,
    })
  }
  const observedHeads = {}
  for (const number of input.order) {
    const ref = input.heads[number]
    if (sourceLs.ok && !sourceRefs[ref]) {
      errors.push({
        code: 'stale-snapshot',
        detail: `the head branch ${ref} of #${number} is absent from the source repository`,
        evidence: `pinned ${input.originalHeads[number]}`,
      })
      continue
    }
    const observed = storageOid(storage, ref)
    observedHeads[number] = observed
    if (observed === null) {
      errors.push({
        code: 'stale-snapshot',
        detail: `the head branch ${ref} of #${number} is not present in storage`,
        evidence: `pinned ${input.originalHeads[number]}`,
      })
      continue
    }
    if (observed !== input.originalHeads[number]) {
      errors.push({
        code: 'stale-snapshot',
        detail: `the head branch ${ref} of #${number} moved since the plan was authorized`,
        evidence: `pinned ${input.originalHeads[number]}, storage holds ${observed}`,
      })
    }
  }
  return { errors, observedHeads }
}

/**
 * An unfinished run over the same identity is a recoverable state, not a fresh start.
 * Overlapping runs would leave two journals claiming the same prepared heads.
 */
function readJournal(input) {
  const path = join(input.runDirectory, 'journal.json')
  if (!existsSync(path)) return { path, journal: null }
  try {
    return { path, journal: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    throw new InputError(
      'unfinished-run',
      'the journal in the task-owned run directory could not be read',
      `${path}: ${String(error?.message ?? error)}`,
    )
  }
}

function sameIdentity(journal, input) {
  const recorded = journal?.selection ?? []
  const rootRef = journal?.root?.ref
  const rootOid = journal?.root?.oid
  if (
    recorded.length !== input.selection.length ||
    !recorded.every((number) => input.selection.includes(number)) ||
    rootRef !== input.root.ref ||
    rootOid !== input.root.oid
  ) {
    return false
  }
  if (journal.order && JSON.stringify(journal.order) !== JSON.stringify(input.order)) {
    return false
  }
  if (journal.repository && journal.repository !== input.repository) {
    return false
  }
  if (journal.heads) {
    for (const number of input.order) {
      if (journal.heads[number] !== input.heads[number]) return false
    }
  }
  if (journal.originalHeads) {
    for (const number of input.order) {
      if (journal.originalHeads[number] !== input.originalHeads[number]) return false
    }
  }
  return true
}

function writeJournal(path, journal) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`)
}

/** A prepared head is recoverable only while its original commits are still reachable. */
function cloneWorkspace(storage, number, originalOid, resume = false) {
  const workspace = join(storage, '..', 'workspaces', `pr-${number}`)
  if (existsSync(workspace)) {
    if (!resume) {
      throw new InputError(
        'unfinished-run',
        `the workspace for #${number} already exists from an unfinished run`,
        `${workspace} was not recreated; inspect it and pass resume`,
      )
    }
    return workspace
  }
  runGit(storage, ['clone', '--quiet', '--no-hardlinks', storage, workspace])
  runGit(workspace, ['checkout', '--quiet', '-B', `prepared/${number}`, originalOid])
  return workspace
}

function stagedEntries(workspace) {
  // `git ls-files -u -z` writes `<mode> SP <oid> SP <stage> TAB <path> NUL`. A path may
  // contain any byte except NUL, so the record is split on the first tab and the path is
  // taken whole - never by whitespace, which would cut a legal file name in half.
  const listing = gitOut(workspace, ['ls-files', '-u', '-z']) ?? ''
  const entries = new Map()
  for (const record of listing.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, oid, stage] = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)
    const current = entries.get(path) ?? { path, stages: {} }
    current.stages[Number(stage)] = { mode, oid }
    entries.set(path, current)
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function isBlobBinary(workspace, oid) {
  if (!oid) return false
  const check = runGit(
    workspace,
    ['diff', '--numstat', 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', oid],
    {
      allowFailure: true,
    },
  )
  if (check.ok && /^-\t/.test(check.stdout)) return true
  return false
}

function sideDiff(workspace, fromOid, toOid) {
  if (!fromOid && !toOid) return null
  if (!fromOid || !toOid) {
    const oid = toOid || fromOid
    const isBin = isBlobBinary(workspace, oid)
    return {
      binary: isBin,
      text: isBin ? null : fromOid ? 'deleted' : 'added',
    }
  }
  const result = runGit(workspace, ['diff', '--no-color', '--no-ext-diff', fromOid, toOid], {
    allowFailure: true,
  })
  if (!result.ok) return null
  const numstat = runGit(workspace, ['diff', '--numstat', fromOid, toOid], {
    allowFailure: true,
  })
  const binary =
    /^-\t/.test(numstat.stdout) ||
    isBlobBinary(workspace, fromOid) ||
    isBlobBinary(workspace, toOid)
  return {
    binary,
    text: binary ? null : result.stdout.slice(0, MAX_EVIDENCE_CHARS),
  }
}

function identifyRenames(entries) {
  // A conflicted path whose base blob reappears as another conflicted path's side blob is
  // part of a rename conflict: the content was not lost, it moved.
  const byBlob = new Map()
  for (const entry of entries) {
    for (const stage of Object.values(entry.stages)) {
      const key = stage.mode === '160000' ? `submodule:${stage.oid}` : stage.oid
      if (!byBlob.has(key)) byBlob.set(key, [])
      byBlob.get(key).push({ path: entry.path, stage })
    }
  }
  const renamed = new Set()
  for (const entry of entries) {
    const base = entry.stages[1]
    if (!base) continue
    const key = base.mode === '160000' ? `submodule:${base.oid}` : base.oid
    const matches = (byBlob.get(key) ?? []).filter((candidate) => candidate.path !== entry.path)
    if (matches.length > 0) {
      renamed.add(entry.path)
      for (const match of matches) renamed.add(match.path)
    }
  }
  return renamed
}

function classifyConflict(workspace, entries, renamed) {
  const merged = entries.map((entry) => {
    const base = entry.stages[1]
    const ours = entry.stages[2]
    const theirs = entry.stages[3]
    const mode = (stage) => stage?.mode ?? null
    let kind
    if (!base && ours && theirs) kind = 'add-add'
    else if (base && ours && !theirs) kind = 'delete-modify'
    else if (base && !ours && theirs) kind = 'modify-delete'
    else if (ours && theirs && (mode(ours) === '160000' || mode(theirs) === '160000'))
      kind = 'submodule'
    else if (mode(base) === '120000' || mode(ours) === '120000' || mode(theirs) === '120000')
      kind = 'symlink'
    else kind = 'content'
    const derived = classifyPath(entry.path)
    const binary = Boolean(
      sideDiff(workspace, base?.oid, ours?.oid)?.binary ||
      sideDiff(workspace, base?.oid, theirs?.oid)?.binary,
    )
    if (binary) kind = 'binary'
    if (renamed.has(entry.path)) kind = 'rename-conflict'
    return {
      path: entry.path,
      kind,
      derivedPathKind: derived,
      structural: STRUCTURAL_KINDS.has(kind),
      stages: {
        base: base ?? null,
        ours: ours ?? null,
        theirs: theirs ?? null,
      },
      oursDiff: sideDiff(workspace, base?.oid, ours?.oid),
      theirsDiff: sideDiff(workspace, base?.oid, theirs?.oid),
    }
  })
  // One path cannot be a file on one side and a directory prefix on the other without the
  // merge leaving both unresolved, so the pair is reported as a file/directory conflict.
  const directories = new Set(merged.map((entry) => entry.path.split('/').slice(0, -1).join('/')))
  const fileDirectory = new Set()
  for (const entry of merged) {
    if (directories.has(entry.path) && entry.path.length > 0) fileDirectory.add(entry.path)
  }
  for (const entry of merged) {
    if (!fileDirectory.has(entry.path)) {
      const nested = merged.filter((other) => other.path.startsWith(`${entry.path}/`))
      if (nested.length > 0) {
        entry.kind = 'file-directory'
        entry.structural = true
        fileDirectory.add(entry.path)
      }
    }
  }
  return merged.map((entry) => ({
    ...entry,
    kind: fileDirectory.has(entry.path) ? 'file-directory' : entry.kind,
    structural: fileDirectory.has(entry.path) ? true : entry.structural,
  }))
}

function applyResolution(workspace, resolution) {
  const target = join(workspace, resolution.path)
  if (resolution.absent) {
    runGit(workspace, ['--literal-pathspecs', 'rm', '--quiet', '--', resolution.path])
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    unlinkSync(target)
  }
  writeFileSync(target, resolution.content)
  runGit(workspace, ['--literal-pathspecs', 'add', '--', resolution.path])
}

function operationsInProgress(workspace) {
  const gitDir = join(workspace, '.git')
  return ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'].filter(
    (marker) => existsSync(join(gitDir, marker)),
  )
}

function conflictMarkers(workspace, commit) {
  const result = runGit(workspace, ['grep', '-I', '-l', '-e', '<<<<<<<', commit, '--'], {
    allowFailure: true,
  })
  return result.ok ? lines(result.stdout) : []
}

function changedPaths(storage, fromOid, toOid) {
  const result = runGit(storage, ['diff', '--name-only', `${fromOid}`, `${toOid}`], {
    allowFailure: true,
  })
  return result.ok ? lines(result.stdout) : []
}

function contributedPaths(storage, baseOid, originalOid) {
  const mergeBase = gitOut(storage, ['merge-base', baseOid, originalOid])
  if (!mergeBase) return []
  return changedPaths(storage, mergeBase, originalOid)
}

function reachableCommits(storage, tip, excluding) {
  const result = runGit(storage, ['rev-list', tip, `^${excluding}`], { allowFailure: true })
  return result.ok ? lines(result.stdout) : []
}

function identityOf(workspace, commit) {
  const author = gitOut(workspace, ['show', '-s', '--format=%an <%ae>', commit])
  const committer = gitOut(workspace, ['show', '-s', '--format=%cn <%ce>', commit])
  return { author: author ?? '', committer: committer ?? '' }
}

/**
 * Puts a prepared head where later steps can reach it: the task-owned bare storage, under
 * a task-owned ref. The integration commit exists only in the workspace, so the objects
 * are copied in first; a ref that already holds the object is simply pointed at it. This
 * is a local copy into task-owned storage - no remote, no branch on the user's remote.
 */
function recordPreparedHead(storage, workspace, number, oid) {
  const ref = `refs/heads/prepared/${number}`
  const held = gitOut(storage, ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`])
  if (held !== oid) {
    const pushed = runGit(workspace, ['push', '--quiet', storage, `HEAD:${ref}`], {
      allowFailure: true,
    })
    if (!pushed.ok) {
      throw new InputError(
        'invalid-input',
        'a prepared head could not be copied into task-owned storage',
        pushed.stderr.trim().slice(0, 400),
      )
    }
    return
  }
  runGit(storage, ['--git-dir', storage, 'update-ref', ref, oid])
}

/**
 * The message an integration commit carries: what was integrated, from where, into what.
 * It names real object ids so the attribution is readable from `git log` alone.
 */
function integrationMessage(predecessor, number, input) {
  return predecessor
    ? `Integrate #${predecessor.number} prepared state ${predecessor.preparedHead.slice(0, 12)} into #${number}`
    : `Integrate the pinned root ${input.root.oid.slice(0, 12)} into #${number}`
}

/**
 * Prepares one position. Returns either the prepared branch facts, or a blocker with the
 * recoverable workspace left exactly where the conflict is.
 */
function preparePosition(options) {
  const { input, storage, position, number, predecessor, preparedRefs, resolutionIndex } = options
  const originalOid = input.originalHeads[number]
  const workspace = cloneWorkspace(storage, number, originalOid, input.resume)
  const baseOid = predecessor ? predecessor.preparedHead : input.root.oid
  const conflicts = []
  const decisions = []
  const errors = []

  if (predecessor && isAncestor(storage, originalOid, predecessor.preparedHead)) {
    // The accumulated state already contains this contribution. Reporting it as a
    // redundant contribution keeps its chain position without inventing content.
    const preparedHead = predecessor.preparedHead
    runGit(storage, [
      '--git-dir',
      storage,
      'update-ref',
      `refs/heads/prepared/${number}`,
      preparedHead,
    ])
    return {
      branch: {
        number,
        originalHead: originalOid,
        preparedHead,
        basedOn: predecessor.preparedHead,
        retainedOriginalCommits: [originalOid],
        historyPolicy: 'preserve-original-commits',
      },
      outcome: 'already-contained',
      redundant: true,
      workspace,
      conflicts,
      decisions,
      errors,
      predecessor: predecessor?.number ?? null,
    }
  }

  if (isAncestor(storage, baseOid, originalOid)) {
    // A fast-forward contributes nothing new, so it creates no commit at all.
    runGit(storage, [
      '--git-dir',
      storage,
      'update-ref',
      `refs/heads/prepared/${number}`,
      originalOid,
    ])
    return {
      branch: {
        number,
        originalHead: originalOid,
        preparedHead: originalOid,
        basedOn: baseOid,
        retainedOriginalCommits: [originalOid],
        historyPolicy: 'preserve-original-commits',
      },
      outcome: 'fast-forward',
      redundant: false,
      workspace,
      conflicts,
      decisions,
      errors,
      predecessor: predecessor?.number ?? null,
    }
  }

  const alreadyInMerge = operationsInProgress(workspace).includes('MERGE_HEAD')
  const merge = alreadyInMerge
    ? {
        ok: false,
        status: 1,
        stdout: '',
        stderr: 'reusing conflicted workspace from unfinished run',
      }
    : runGit(workspace, ['merge', '--no-ff', '--no-commit', '--no-edit', baseOid], {
        allowFailure: true,
      })
  let preparedHead
  let outcome = 'integrated'
  if (!merge.ok) {
    const entries = stagedEntries(workspace)
    const renamed = identifyRenames(entries)
    const classified = classifyConflict(workspace, entries, renamed)
    const mergeBase = gitOut(storage, ['merge-base', originalOid, baseOid])
    for (const conflict of classified) {
      const supplied = resolutionIndex.get(`${number}:${conflict.path}`)
      const evidence = {
        number,
        ...conflict,
        mergeBase,
        predecessor: predecessor?.number ?? null,
        ours: { head: originalOid, role: 'selected-pull-request' },
        theirs: { head: baseOid, role: 'integrated-prepared-state' },
        decision: supplied
          ? {
              kind: supplied.kind,
              intent: supplied.intent,
              reason: supplied.reason,
              resolvedAbsent: supplied.absent,
            }
          : null,
        needsDecision: !supplied,
      }
      conflicts.push(evidence)
      if (supplied) {
        decisions.push({
          number,
          path: conflict.path,
          kind: supplied.kind,
          intent: supplied.intent,
          reason: supplied.reason,
          conflictKind: conflict.kind,
        })
      } else {
        errors.push({
          code: STRUCTURAL_KINDS.has(conflict.kind)
            ? 'unsupported-conflict'
            : 'unresolved-conflict',
          detail: `#${number} leaves ${conflict.path} unresolved as a ${conflict.kind} conflict`,
          evidence:
            conflict.derivedPathKind === 'generated' || conflict.derivedPathKind === 'lockfile'
              ? `merge base ${mergeBase}; the path is ${conflict.derivedPathKind} output, whose content this helper will not regenerate or install`
              : `merge base ${mergeBase}; base=${conflict.stages.base?.oid ?? 'none'} ours=${conflict.stages.ours?.oid ?? 'none'} theirs=${conflict.stages.theirs?.oid ?? 'none'}`,
        })
      }
    }
    const suppliedResolutions = classified.flatMap((conflict) => {
      const supplied = resolutionIndex.get(`${number}:${conflict.path}`)
      return supplied ? [{ conflict, supplied }] : []
    })
    for (const { conflict, supplied } of suppliedResolutions) {
      // A path whose content this helper must not invent is refused even when a caller
      // supplies a resolution: hand-written lockfile, generated, binary, or submodule
      // content is a guess wearing a resolution's clothes.
      const invenient =
        conflict.derivedPathKind === 'generated' ||
        conflict.derivedPathKind === 'lockfile' ||
        conflict.kind === 'binary' ||
        conflict.kind === 'submodule' ||
        conflict.kind === 'symlink'
      if (invenient) {
        errors.push({
          code: 'unsupported-conflict',
          detail: `#${number} ${conflict.path} cannot be resolved by supplying content`,
          evidence: `the path is ${conflict.derivedPathKind ?? conflict.kind}; its content is produced by its owning tool, and this helper neither regenerates nor invents it`,
        })
        continue
      }
      if (!supplied.intent || !supplied.reason) {
        errors.push({
          code: 'invalid-input',
          detail: `a resolution for #${number} ${supplied.path} carries no stated intent or reason`,
          evidence: 'a decision without evidence is a guess, and this helper records neither',
        })
        continue
      }
      applyResolution(workspace, supplied)
    }
    const remaining = lines(gitOut(workspace, ['diff', '--name-only', '--diff-filter=U']) ?? '')
    if (remaining.length > 0) {
      return {
        branch: null,
        outcome: 'blocked',
        workspace,
        conflicts,
        decisions,
        errors:
          errors.length > 0
            ? errors
            : [
                {
                  code: 'unresolved-conflict',
                  detail: `#${number} still holds unmerged entries after the supplied resolutions`,
                  evidence: remaining.join(', '),
                },
              ],
        predecessor: predecessor?.number ?? null,
      }
    }
    if (errors.length > 0) {
      return {
        branch: null,
        outcome: 'blocked',
        workspace,
        conflicts,
        decisions,
        errors,
        predecessor: predecessor?.number ?? null,
      }
    }
    const message = integrationMessage(predecessor, number, input)
    const commit = commitWithControls(workspace, message)
    if (!commit.ok) {
      return {
        branch: null,
        outcome: 'blocked',
        workspace,
        conflicts,
        decisions,
        errors: [
          ...errors,
          {
            code: 'conflicting-environment-control',
            detail: `the integration commit for #${number} was refused by a mandatory control`,
            evidence: commit.stderr.trim().slice(0, 400),
          },
        ],
        predecessor: predecessor?.number ?? null,
      }
    }
    outcome = 'integrated-with-resolution'
    preparedHead = commit.oid
  } else {
    const message = integrationMessage(predecessor, number, input)
    const commit = commitWithControls(workspace, message)
    if (!commit.ok) {
      return {
        branch: null,
        outcome: 'blocked',
        workspace,
        conflicts,
        decisions,
        errors: [
          ...errors,
          {
            code: 'conflicting-environment-control',
            detail: `the integration commit for #${number} was refused by a mandatory control`,
            evidence: commit.stderr.trim().slice(0, 400),
          },
        ],
        predecessor: predecessor?.number ?? null,
      }
    }
    preparedHead = commit.oid
  }

  recordPreparedHead(storage, workspace, number, preparedHead)
  void preparedRefs

  const retained = reachableCommits(storage, originalOid, baseOid)
  const verification = []
  if (!isAncestor(storage, originalOid, preparedHead)) {
    errors.push({
      code: 'lost-original-commit',
      detail: `the original head of #${number} is not reachable from its prepared head`,
      evidence: `original ${originalOid}, prepared ${preparedHead}`,
    })
  }
  if (predecessor && !isAncestor(storage, predecessor.preparedHead, preparedHead)) {
    errors.push({
      code: 'invalid-input',
      detail: `#${number} does not contain the prepared state of #${predecessor.number}`,
      evidence: `prepared ${preparedHead} does not descend from ${predecessor.preparedHead}`,
    })
  }
  const expectedPaths = contributedPaths(storage, baseOid, originalOid)
  const preparedPaths = changedPaths(storage, baseOid, preparedHead)
  const dropped = expectedPaths.filter((path) => {
    if (path === '' || preparedPaths.includes(path)) return false
    const origBlob = gitOut(storage, ['rev-parse', '--verify', '--quiet', `${originalOid}:${path}`])
    const prepBlob = gitOut(storage, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${preparedHead}:${path}`,
    ])
    if (origBlob && origBlob === prepBlob) return false
    return true
  })
  const unjustified = dropped.filter(
    (path) =>
      !input.justifiedDrops.some(
        (drop) => drop.number === number && drop.path === path && drop.reason.length > 0,
      ),
  )
  if (unjustified.length > 0) {
    errors.push({
      code: 'lost-contribution',
      detail: `#${number} lost ${unjustified.length} contributed path(s) in the prepared tree`,
      evidence: `contributed ${expectedPaths.join(', ') || 'none'}; prepared ${preparedPaths.join(', ') || 'none'}; unjustified loss ${unjustified.join(', ')}`,
    })
  }
  verification.push({
    invariant: 'preservation.original-commits',
    observed: `${retained.length} original commit(s) retained, original reachable from ${preparedHead}: ${isAncestor(storage, originalOid, preparedHead)}`,
    result: isAncestor(storage, originalOid, preparedHead) ? 'pass' : 'fail',
  })
  verification.push({
    invariant: 'preservation.cumulative',
    observed: predecessor
      ? `#${predecessor.number} prepared ${predecessor.preparedHead} is an ancestor: ${isAncestor(storage, predecessor.preparedHead, preparedHead)}`
      : 'first position, no predecessor to integrate',
    result: predecessor
      ? isAncestor(storage, predecessor.preparedHead, preparedHead)
        ? 'pass'
        : 'fail'
      : 'pass',
  })
  verification.push({
    invariant: 'retained-intent',
    observed: `contributed ${expectedPaths.join(', ') || 'none'}; prepared ${preparedPaths.join(', ') || 'none'}; dropped ${dropped.join(', ') || 'none'}`,
    result: unjustified.length === 0 ? 'pass' : 'fail',
  })

  return {
    branch: {
      number,
      originalHead: originalOid,
      preparedHead,
      basedOn: baseOid,
      retainedOriginalCommits: retained.length > 0 ? retained : [originalOid],
      historyPolicy: 'preserve-original-commits',
    },
    outcome,
    redundant: false,
    workspace,
    conflicts,
    decisions,
    errors,
    verification,
    rootContained: predecessor ? true : isAncestor(storage, input.root.oid, preparedHead),
    expectedPaths,
    preparedPaths,
    identity: identityOf(workspace, preparedHead),
    predecessor: predecessor?.number ?? null,
  }
}

/**
 * A commit that respects whatever the environment enforces. No `--no-verify`, no
 * `-c user.signingkey=`, no temporary config: a control that refuses the commit is
 * reported as a blocker, because the alternative is a run that disabled a mandatory
 * control and then claimed it had not.
 */
function commitWithControls(workspace, message) {
  const result = runGit(workspace, ['commit', '--quiet', '-m', message], { allowFailure: true })
  if (!result.ok) return { ok: false, stderr: result.stderr }
  return { ok: true, oid: gitOut(workspace, ['rev-parse', 'HEAD']) }
}

/**
 * Controls the source repository enforces, read from it rather than assumed.
 *
 * Cloning copies objects and refs, not local configuration or hooks, so a signing,
 * hook, filter, or driver policy the source enforces can quietly stop applying to the
 * integration commit. This helper reports what it found and what task storage will not
 * inherit; it never weakens any of it, and it never runs an install, a driver, a
 * submodule fetch, or a lifecycle command to make the work easier.
 */
function inspectControls(repository) {
  const controls = []
  const config = runGit(
    repository,
    [
      'config',
      '--local',
      '--get-regexp',
      '^(commit\\.gpgsign|tag\\.gpgsign|gpg\\.format|user\\.signingkey|core\\.hooksPath|core\\.fsmonitor|diff\\.external|merge\\.tool|core\\.autocrlf|core\\.eol|credential\\.helper)$',
    ],
    {
      allowFailure: true,
    },
  )
  if (config.ok) {
    for (const line of lines(config.stdout)) {
      const space = line.indexOf(' ')
      const key = line.slice(0, space)
      const value = line.slice(space + 1)
      const isSigning = key.toLowerCase() === 'commit.gpgsign' && value.toLowerCase() === 'true'
      const isHooks = key.toLowerCase() === 'core.hookspath'
      const blocking = isSigning || isHooks
      controls.push({
        control: key,
        value,
        inTaskStorage: 'not-copied',
        blocking,
        effect: isSigning
          ? 'the source requires signed commits; task storage does not inherit signing configuration, so preparation stops before creating unverified commits'
          : isHooks
            ? 'the source configures a mandatory core.hooksPath; task storage does not inherit hooks, so preparation stops before bypassing controls'
            : 'reported, never overridden',
      })
    }
  }
  const drivers = runGit(
    repository,
    [
      'config',
      '--local',
      '--get-regexp',
      '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$',
    ],
    {
      allowFailure: true,
    },
  )
  const globalDrivers = runGit(
    repository,
    [
      'config',
      '--get-regexp',
      '^merge\\..*\\.driver$',
    ],
    {
      allowFailure: true,
    },
  )
  const driverLines = new Set([
    ...(drivers.ok ? lines(drivers.stdout) : []),
    ...(globalDrivers.ok ? lines(globalDrivers.stdout) : []),
  ])
  for (const line of driverLines) {
    const space = line.indexOf(' ')
    const key = line.slice(0, space)
    const value = line.slice(space + 1)
    controls.push({
      control: key,
      value,
      inTaskStorage: 'not-copied',
      blocking: true,
      effect:
        'a custom clean/smudge filter or merge driver in the source repository cannot be executed safely: preparation stops before running untrusted or bypassed drivers',
    })
  }
  const hooksConfig = gitOut(repository, ['config', '--get', 'core.hooksPath'])
  const hooksDir = hooksConfig
    ? isAbsolute(hooksConfig)
      ? hooksConfig
      : resolve(repository, hooksConfig)
    : existsSync(join(repository, '.git', 'hooks'))
      ? join(repository, '.git', 'hooks')
      : join(repository, 'hooks')
  const hooks = existsSync(hooksDir)
    ? readdirSync(hooksDir)
        .filter((name) => !name.endsWith('.sample'))
        .filter((name) => {
          try {
            return statSync(join(hooksDir, name)).isFile()
          } catch {
            return false
          }
        })
    : []
  for (const hook of hooks) {
    let isExec = false
    try {
      isExec = (statSync(join(hooksDir, hook)).mode & 0o111) !== 0
    } catch {
      isExec = false
    }
    controls.push({
      control: `hooks/${hook}`,
      value: 'present in the source repository',
      inTaskStorage: 'not-copied',
      blocking: isExec,
      effect: isExec
        ? 'an executable policy hook in the source repository is not inherited into task storage: preparation stops before bypassing mandatory hooks'
        : 'the source hook is not executable, left inactive',
    })
  }
  return controls
}

/**
 * Prepares the whole selection in dependency order.
 *
 * Emits the contract's `preparation` document plus the recovery facts a blocked run needs:
 * which positions are prepared, which are not, and where the journal and the task-owned
 * backup refs live.
 */
function prepareStackInner(raw) {
  const errors = []
  let input
  try {
    input = verifyPlan(raw)
  } catch (error) {
    const failure =
      error instanceof InputError
        ? error
        : new InputError('invalid-input', String(error?.message ?? error), 'input was rejected')
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: [failure],
      run: null,
      preparation: null,
      verification: [],
      continuation: { prepared: [], remaining: [], resumeFrom: null },
      conflicts: [],
    }
  }

  const userBefore = readUserFingerprint(input.userWorkspace)
  const controls = inspectControls(input.repository)
  const blockingControls = controls.filter((c) => c.blocking)
  if (blockingControls.length > 0) {
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: blockingControls.map((c) => ({
        code: 'conflicting-environment-control',
        detail: `mandatory control ${c.control} cannot be enforced or safely run in task workspaces`,
        evidence: c.effect,
      })),
      run: null,
      preparation: null,
      verification: [],
      continuation: { prepared: [], remaining: input.order, resumeFrom: null },
      conflicts: [],
      controls,
      userWorkspace: userBefore,
    }
  }

  const runId = `prepare-${input.root.oid.slice(0, 12)}-${input.order.join('-')}`
  const { journal: existing, path: journalPath } = readJournal(input)
  if (existing && !sameIdentity(existing, input)) {
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: [
        {
          code: 'unfinished-run',
          detail: 'the run directory holds a journal for a different selection or root',
          evidence: `recorded selection ${JSON.stringify(existing.selection ?? [])} root ${JSON.stringify(existing.root ?? {})}`,
        },
      ],
      run: { runId, runDirectory: input.runDirectory, journalPath, workspaces: [], backupRefs: [] },
      preparation: null,
      verification: [],
      continuation: { prepared: [], remaining: input.order, resumeFrom: null },
      conflicts: [],
    }
  }
  // The journal-state gate runs once task-owned storage exists, so a completed run can be
  // verified against real refs instead of being refused on the strength of a file alone.

  let storage
  let works
  try {
    ;({ storage, works } = seedStorage(input))
  } catch (error) {
    const failure =
      error instanceof InputError
        ? error
        : new InputError(
            'invalid-input',
            String(error?.message ?? error),
            'task-owned storage could not be created',
          )
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: [failure],
      run: null,
      preparation: null,
      verification: [],
      continuation: { prepared: [], remaining: input.order, resumeFrom: null },
      conflicts: [],
    }
  }

  const snapshot = verifySnapshot(input, storage)
  errors.push(...snapshot.errors)
  if (errors.length > 0) {
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors,
      run: { runId, runDirectory: input.runDirectory, journalPath, workspaces: [], backupRefs: [] },
      preparation: null,
      verification: [],
      continuation: { prepared: [], remaining: input.order, resumeFrom: null },
      conflicts: [],
    }
  }

  const resolutionIndex = new Map()
  for (const resolution of input.resolutions) {
    if (!resolution.path) {
      errors.push({
        code: 'invalid-input',
        detail: `a resolution for #${resolution.number} names no path`,
        evidence: JSON.stringify(resolution),
      })
      continue
    }
    if (resolution.content === null && !resolution.absent) {
      errors.push({
        code: 'invalid-input',
        detail: `the resolution for #${resolution.number} ${resolution.path} carries neither content nor an explicit absence`,
        evidence: 'this helper will not choose a side of a conflict',
      })
      continue
    }
    resolutionIndex.set(`${resolution.number}:${resolution.path}`, resolution)
  }
  if (errors.length > 0) {
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors,
      run: { runId, runDirectory: input.runDirectory, journalPath, workspaces: [], backupRefs: [] },
      preparation: null,
      verification: [],
      continuation: { prepared: [], remaining: input.order, resumeFrom: null },
      conflicts: [],
    }
  }

  if (existing && !input.resume) {
    if (existing.state !== 'prepared') {
      return {
        contractVersion: CONTRACT_VERSION,
        ok: false,
        errors: [
          {
            code: 'unfinished-run',
            detail: 'an unfinished run over the same selection already owns this run directory',
            evidence: `journal state ${existing.state ?? 'unknown'}; pass resume to continue it`,
          },
        ],
        run: {
          runId,
          runDirectory: input.runDirectory,
          journalPath,
          storage,
          workspaces: existing.workspaces ?? [],
          backupRefs: existing.backupRefs ?? [],
        },
        preparation: existing.preparation ?? null,
        verification: existing.verification ?? [],
        continuation: existing.continuation ?? {
          prepared: [],
          remaining: input.order,
          resumeFrom: null,
        },
        conflicts: existing.conflicts ?? [],
        decisions: existing.decisions ?? [],
        userWorkspace: readUserFingerprint(input.userWorkspace),
      }
    }
    // Repeating a completed preparation is safe and does no work: the recorded prepared
    // heads are re-verified against real refs, and nothing is rewritten.
    const repeat = verifyRecordedPreparation(storage, existing, input)
    return {
      contractVersion: CONTRACT_VERSION,
      ok: repeat.problems.length === 0,
      errors: repeat.problems,
      run: {
        runId,
        runDirectory: input.runDirectory,
        journalPath,
        storage,
        workspaces: existing.workspaces ?? [],
        backupRefs: existing.backupRefs ?? [],
      },
      preparation: existing.preparation ?? null,
      verification: repeat.verification,
      continuation: existing.continuation ?? {
        prepared: input.order,
        remaining: [],
        resumeFrom: null,
      },
      conflicts: existing.conflicts ?? [],
      decisions: existing.decisions ?? [],
      repeated: true,
      userWorkspace: readUserFingerprint(input.userWorkspace),
    }
  }

  const resumedPrepared = new Map()
  if (existing && input.resume) {
    for (const [index, branch] of (existing.preparation?.branches ?? []).entries()) {
      const oid = storageOid(storage, `refs/heads/prepared/${branch.number}`)
      const matches =
        oid !== null &&
        oid === branch.preparedHead &&
        branch.originalHead === input.originalHeads[branch.number] &&
        isAncestor(storage, branch.originalHead, oid) &&
        (index === 0
          ? isAncestor(storage, input.root.oid, oid) && branch.basedOn === input.root.oid
          : branch.basedOn === (existing.preparation.branches[index - 1]?.preparedHead ?? ''))
      if (matches) resumedPrepared.set(branch.number, branch)
    }
  }

  const journal = {
    contractVersion: CONTRACT_VERSION,
    runId,
    state: 'preparing',
    startedAt: existing?.startedAt ?? input.now,
    updatedAt: input.now,
    repository: input.repository,
    selection: input.selection,
    root: input.root,
    order: input.order,
    heads: input.heads,
    originalHeads: input.originalHeads,
    preparedHeads: {},
    decisions: existing?.decisions ?? [],
    verification: [],
    continuation: { prepared: [], remaining: [...input.order], resumeFrom: null },
    workspaces: [],
    backupRefs: [],
    secrets: 'none; this journal records object ids, paths, and decisions only',
    controls,
    userWorkspaceBaseline: userBefore,
  }
  writeJournal(journalPath, journal)

  const preparedBranches = []
  const conflicts = []
  const decisions = []
  const verification = []
  const workspaces = []
  const preparedNumbers = []
  let predecessor = null

  for (const [index, number] of input.order.entries()) {
    const resumed = resumedPrepared.get(number)
    if (resumed) {
      preparedBranches.push(resumed)
      preparedNumbers.push(number)
      journal.preparedHeads[number] = resumed.preparedHead
      predecessor = { number, preparedHead: resumed.preparedHead }
      journal.continuation.prepared = [...preparedNumbers]
      journal.continuation.remaining = input.order.slice(index + 1)
      journal.continuation.resumeFrom = input.order[index + 1] ?? null
      writeJournal(journalPath, journal)
      continue
    }

    let position
    try {
      position = preparePosition({
        input,
        storage,
        position: index,
        number,
        predecessor,
        preparedRefs: null,
        resolutionIndex,
      })
    } catch (error) {
      const failure =
        error instanceof InputError
          ? { code: error.code, detail: error.detail, evidence: error.evidence }
          : {
              code: 'invalid-input',
              detail: String(error?.message ?? error),
              evidence: `preparing #${number} in ${works}`,
            }
      errors.push(failure)
      conflicts.push(...(position?.conflicts ?? []))
      workspaces.push(position?.workspace ?? join(works, `pr-${number}`))
      break
    }

    workspaces.push(position.workspace)
    conflicts.push(...position.conflicts)
    decisions.push(...position.decisions)
    verification.push(...(position.verification ?? []))
    journal.workspaces = workspaces
    journal.backupRefs = [...journal.backupRefs, `refs/heads/prepared/${number}`]
    journal.decisions = [...journal.decisions, ...position.decisions]
    journal.verification = verification
    journal.conflicts = conflicts

    if (!position.branch) {
      errors.push(...position.errors)
      journal.state = 'blocked'
      journal.continuation.prepared = [...preparedNumbers]
      journal.continuation.remaining = input.order.slice(index)
      journal.continuation.resumeFrom = number
      journal.updatedAt = input.now
      writeJournal(journalPath, journal)
      break
    }

    preparedBranches.push(position.branch)
    preparedNumbers.push(number)
    journal.preparedHeads[number] = position.branch.preparedHead
    errors.push(...position.errors)
    journal.continuation.prepared = [...preparedNumbers]
    journal.continuation.remaining = input.order.slice(index + 1)
    journal.continuation.resumeFrom = input.order[index + 1] ?? null
    journal.updatedAt = input.now
    writeJournal(journalPath, journal)
    if (position.rootContained === false) {
      verification.push({
        invariant: 'root.contained-in-prepared',
        observed: `#${number} does not descend from the pinned root ${input.root.oid}`,
        result: 'fail',
      })
      errors.push({
        code: 'stale-snapshot',
        detail: `#${number} was branched before the pinned root commit and was not rebased onto it`,
        evidence: `root ${input.root.oid}, prepared ${position.branch.preparedHead}`,
      })
    }
    predecessor = { number, preparedHead: position.branch.preparedHead }
  }

  const remaining = input.order.filter((number) => !preparedNumbers.includes(number))
  // The blocked position's workspace is inspected too: a recoverable conflict is real
  // state on disk, and reporting it from Git's own index is what makes it recoverable.
  const inspected = journal.continuation.resumeFrom
    ? [...preparedNumbers, journal.continuation.resumeFrom]
    : [...preparedNumbers]
  const integrity = integrityState(works, inspected)

  const preparation =
    preparedBranches.length > 0
      ? {
          contractVersion: CONTRACT_VERSION,
          workspaceKind: 'task-owned-isolated',
          branches: preparedBranches,
          lostOriginalCommits: preparedBranches
            .filter((branch) => !isAncestor(storage, branch.originalHead, branch.preparedHead))
            .map((branch) => branch.originalHead),
          cumulativeIntegration: preparedBranches
            .filter((branch, index) => index > 0)
            .map((branch, index) => {
              const predecessorBranch = preparedBranches[index]
              return {
                number: branch.number,
                integratedPreparedStateOf: predecessorBranch.number,
                evidence: `git merge-base --is-ancestor ${branch.basedOn} ${branch.preparedHead} is true`,
              }
            }),
          conflicts: conflicts.map((conflict) => ({
            number: conflict.number,
            path: conflict.path,
            resolution: conflict.decision ? 'both-sides-with-stated-intent' : 'clean-merge',
          })),
          unresolved: conflicts
            .filter((conflict) => conflict.needsDecision)
            .map((conflict) => conflict.path),
          indexState: integrity,
        }
      : null

  if (integrity.conflictMarkersInTree.length > 0) {
    errors.push({
      code: 'unresolved-conflict',
      detail: 'prepared tree still holds conflict markers',
      evidence: integrity.conflictMarkersInTree.join(', '),
    })
  }
  if (integrity.unmergedEntries.length > 0) {
    errors.push({
      code: 'unresolved-conflict',
      detail: 'prepared workspace still holds unmerged entries',
      evidence: integrity.unmergedEntries.join(', '),
    })
  }
  if (integrity.operationsInProgress.length > 0) {
    errors.push({
      code: 'unresolved-conflict',
      detail: 'prepared workspace still has an operation in progress',
      evidence: integrity.operationsInProgress.join(', '),
    })
  }

  const userAfter = readUserFingerprint(input.userWorkspace)
  if (userBefore && userAfter) {
    const changed =
      userAfter.headOid !== userBefore.headOid ||
      userAfter.status !== userBefore.status ||
      userAfter.indexDigest !== userBefore.indexDigest ||
      userAfter.worktreeDigest !== userBefore.worktreeDigest ||
      userAfter.stashOids !== userBefore.stashOids ||
      userAfter.stashCount !== userBefore.stashCount ||
      userAfter.configDigest !== userBefore.configDigest ||
      userAfter.identity !== userBefore.identity
    if (changed) {
      errors.push({
        code: 'conflicting-environment-control',
        detail: "the user's checkout, index, stash, or configuration changed during preparation",
        evidence: `status before=${userBefore.status}, after=${userAfter.status}`,
      })
    }
  }

  const status =
    errors.length === 0 && remaining.length === 0
      ? 'prepared'
      : preparedBranches.length > 0
        ? 'partial'
        : 'blocked'
  journal.state = status
  journal.preparation = preparation
  journal.updatedAt = input.now
  writeJournal(journalPath, journal)

  return {
    contractVersion: CONTRACT_VERSION,
    ok: errors.length === 0 && remaining.length === 0,
    status,
    errors,
    run: {
      runId,
      runDirectory: input.runDirectory,
      storage,
      journalPath,
      workspaces,
      backupRefs: journal.backupRefs,
      note: 'task-owned storage and workspaces only; nothing was pushed and no provider was contacted',
    },
    preparation,
    verification: verification.concat([
      {
        invariant: 'integrity.clean',
        observed: `unmerged=${integrity.unmergedEntries.join(',') || 'none'} operations=${integrity.operationsInProgress.join(',') || 'none'} markers=${integrity.conflictMarkersInTree.join(',') || 'none'}`,
        result:
          integrity.unmergedEntries.length === 0 &&
          integrity.operationsInProgress.length === 0 &&
          integrity.conflictMarkersInTree.length === 0
            ? 'pass'
            : 'fail',
      },
    ]),
    continuation: journal.continuation,
    conflicts,
    decisions,
    controls: journal.controls ?? [],
    userWorkspace: userAfter,
  }
}

/**
 * Prepares the selection, and reports the enforced controls it found either way.
 *
 * The controls are read from the source repository rather than assumed, and they are
 * reported on every outcome - including a refusal - because "I did not disable the hook"
 * and "there was a hook" are different claims and only one of them is provable here.
 */
export function prepareStack(raw) {
  const result = prepareStackInner(raw)
  let controls = []
  try {
    controls = inspectControls(requireDirectory(raw?.repository, 'repository'))
  } catch {
    controls = []
  }
  // Every outcome carries the same keys. A caller reading `conflicts` after a refusal
  // must not have to guess whether the key is absent because nothing conflicted or
  // because the run stopped earlier.
  const status =
    result.ok === true
      ? 'prepared'
      : result.preparation?.branches.length > 0
        ? 'partial'
        : 'blocked'
  return {
    errors: [],
    run: null,
    preparation: null,
    verification: [],
    continuation: { prepared: [], remaining: [], resumeFrom: null },
    conflicts: [],
    decisions: [],
    userWorkspace: null,
    ...result,
    status,
    controls,
  }
}

/**
 * Re-verifies a completed preparation instead of repeating it.
 *
 * A repeated request is answered from the recorded prepared heads and real ancestry: the
 * backup ref still holds what the journal claims, every original commit is still
 * reachable from it, and each successor still descends from its predecessor's prepared
 * state. Anything else is a stale local state to report, never to overwrite.
 */
function verifyRecordedPreparation(storage, journal, input) {
  const problems = []
  const verification = []
  const branches = journal.preparation?.branches ?? []
  for (const [index, branch] of branches.entries()) {
    const oid = storageOid(storage, `refs/heads/prepared/${branch.number}`)
    const retained = oid !== null && isAncestor(storage, branch.originalHead, oid)
    if (oid !== branch.preparedHead) {
      problems.push({
        code: 'stale-snapshot',
        detail: `the task-owned backup ref for #${branch.number} no longer holds the prepared head`,
        evidence: `journal recorded ${branch.preparedHead}, storage holds ${oid ?? 'nothing'}`,
      })
    }
    if (branch.originalHead !== input.originalHeads[branch.number]) {
      problems.push({
        code: 'stale-snapshot',
        detail: `the recorded original head for #${branch.number} does not match the plan`,
        evidence: `journal recorded ${branch.originalHead}, plan has ${input.originalHeads[branch.number]}`,
      })
    }
    if (!retained) {
      problems.push({
        code: 'lost-original-commit',
        detail: `the original head of #${branch.number} is not reachable from its prepared head`,
        evidence: `original ${branch.originalHead}, prepared ${oid ?? 'absent'}`,
      })
    }
    const predecessor = branches[index - 1]
    if (index === 0) {
      const rootReachable = oid !== null && isAncestor(storage, input.root.oid, oid)
      if (!rootReachable || branch.basedOn !== input.root.oid) {
        problems.push({
          code: 'stale-snapshot',
          detail: `#${branch.number} does not contain or is not based on the pinned root commit ${input.root.oid}`,
          evidence: `root ${input.root.oid}, prepared ${oid ?? 'absent'}, basedOn ${branch.basedOn}`,
        })
      }
    } else if (predecessor) {
      if (
        !(oid !== null && isAncestor(storage, predecessor.preparedHead, oid)) ||
        branch.basedOn !== predecessor.preparedHead
      ) {
        problems.push({
          code: 'invalid-input',
          detail: `#${branch.number} no longer contains or is based on the prepared state of #${predecessor.number}`,
          evidence: `${predecessor.preparedHead} is not an ancestor of ${oid ?? 'absent'} or basedOn mismatch`,
        })
      }
    }
    verification.push({
      invariant: 'preservation.original-commits',
      observed: `#${branch.number} ${branch.originalHead} reachable from ${branch.preparedHead}: ${retained}`,
      result: retained ? 'pass' : 'fail',
    })
    verification.push({
      invariant: 'repeat-safe',
      observed: `#${branch.number} reuses the recorded prepared head; no workspace was rewritten`,
      result: oid === branch.preparedHead ? 'pass' : 'fail',
    })
  }
  const covered = branches.map((branch) => branch.number)
  const missing = input.order.filter((number) => !covered.includes(number))
  if (missing.length > 0) {
    problems.push({
      code: 'stale-snapshot',
      detail: `the recorded preparation does not cover ${missing.map((n) => `#${n}`).join(', ')}`,
      evidence: `journal recorded ${covered.map((n) => `#${n}`).join(', ') || 'nothing'}`,
    })
  }
  return { problems, verification }
}

function integrityState(workspaces, preparedNumbers) {
  const unmerged = []
  const operations = []
  const markers = []
  for (const number of preparedNumbers) {
    const workspace = join(workspaces, `pr-${number}`)
    if (!existsSync(workspace)) continue
    for (const path of lines(gitOut(workspace, ['diff', '--name-only', '--diff-filter=U']) ?? '')) {
      unmerged.push(`${number}:${path}`)
    }
    for (const marker of operationsInProgress(workspace)) operations.push(`${number}:${marker}`)
    const head = gitOut(workspace, ['rev-parse', 'HEAD'])
    if (head) {
      for (const path of conflictMarkers(workspace, head)) markers.push(`${number}:${path}`)
    }
  }
  return {
    unmergedEntries: unmerged,
    operationsInProgress: operations,
    conflictMarkersInTree: markers,
  }
}

function readInput(argv) {
  const index = argv.indexOf('--input')
  if (index !== -1) {
    const file = argv[index + 1]
    if (typeof file !== 'string' || file.length === 0) {
      throw new InputError(
        'invalid-input',
        '--input needs a file path',
        `argv ${JSON.stringify(argv)}`,
      )
    }
    return readFileSync(file, 'utf8')
  }
  try {
    return readFileSync(0, 'utf8')
  } catch {
    throw new InputError(
      'invalid-input',
      'no preparation document was supplied',
      'pass --input <file> or pipe the JSON document on stdin',
    )
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(
      [
        'prepare-stack.mjs [--input <file>]',
        '',
        'Prepares the cumulative stack in task-owned workspaces and writes',
        '{ contractVersion, ok, errors, run, preparation, verification, continuation,',
        '  conflicts, userWorkspace } to stdout. It pushes nothing and contacts no provider.',
        'Exit 0 prepares the whole selection, 2 refuses the input, 3 reports a blocker.',
        '',
      ].join('\n'),
    )
    return 0
  }
  let result
  try {
    result = prepareStack(JSON.parse(readInput(argv)))
  } catch (error) {
    const failure =
      error instanceof InputError
        ? error
        : new InputError(
            'invalid-input',
            String(error?.message ?? error),
            'input could not be read',
          )
    result = {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: [failure],
      run: null,
      preparation: null,
      verification: [],
      continuation: { prepared: [], remaining: [], resumeFrom: null },
      conflicts: [],
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 2
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.ok ? 0 : 3
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
