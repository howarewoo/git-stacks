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
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  attributedDriverControls as readAttributedDriverControls,
  executableControls as readExecutableControls,
  treePaths as readTreePaths,
} from './git-controls.mjs'

const CONTRACT_VERSION = 'flatten-pr-graph/1'
const GIT_TIMEOUT_MS = 300_000
const MAX_EVIDENCE_CHARS = 4_000
/**
 * Where pinned source refs are copied inside task-owned storage. A namespace of its own
 * keeps them apart from `refs/heads/prepared/*`, so a cached copy from an earlier run can
 * never stand in for a ref the source no longer publishes.
 */
const SNAPSHOT_PREFIX = 'refs/flatten-snapshot/'
/** The file that records which run owns a task directory. */
const OWNERSHIP_FILE = 'task-owner.json'

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

/**
 * Environment variables that decide *which* repository, index, object store, or
 * configuration a Git child process talks to.
 *
 * A task-owned `cwd` is not isolation while these survive: `GIT_INDEX_FILE` would send
 * every `add` to the user's index, `GIT_DIR`/`GIT_WORK_TREE` would redirect the workspace
 * commands into the user's repository, and the `GIT_CONFIG_*`/`GIT_TEMPLATE_DIR` family
 * would move the configuration and the installed hooks a clone inherits. They are removed
 * rather than honoured, so the run sees the machine's real policy - including any signing
 * or hook requirement - instead of a redirect the caller chose. The removed names are
 * reported in `controls` so the removal is visible rather than silent.
 */
/**
 * The variables that choose which repository, index, or object store a Git child talks
 * to. These are removed from every child this run starts, because a task-owned directory
 * has to be real isolation rather than a command that writes the user's index.
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are deliberately absent. They choose which
 * *configuration* Git reads, not which repository, so they are the machine's policy and
 * not this run's routing: a child that dropped them would sign, hook, merge, and filter
 * under a policy the caller does not have. Removing them is also how a configured merge
 * driver or filter silently stopped running while the report claimed nothing executable
 * was in play. A control this run genuinely cannot honour is refused by the admission
 * gate below, with the caller's own environment, rather than removed from under it.
 *
 * `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` and `GIT_CONFIG_COUNT` do inject arbitrary
 * configuration, so they are still removed - and the admission gate reads them first, so a
 * run launched with one of them set is refused for the control it injects rather than
 * quietly committed without it.
 */
const ROUTING_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_GRAFT_FILE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_COUNT',
  'GIT_TEMPLATE_DIR',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
]

/** `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` are a numbered family, not fixed names. */
function isRoutingEnvVar(name) {
  return ROUTING_ENV_VARS.includes(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)
}

function routingOverrides() {
  return Object.keys(process.env).filter(isRoutingEnvVar).sort()
}

function sanitizedEnv() {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (isRoutingEnvVar(name)) delete env[name]
  }
  return env
}

function runGit(cwd, args, { allowFailure = false, env = sanitizedEnv() } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env,
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

/**
 * Exclusive ownership of a task directory, recorded once and checked on every later run.
 *
 * A directory that already holds task storage but no ownership record was created by
 * something else - or by an older run - and writing into it would put a fetch, a workspace,
 * and a journal inside a repository nobody authorised. Storage is claimed before anything
 * is created in it, so the claim is a statement of intent rather than a description.
 */
function claimTaskDirectory(path, repository) {
  const marker = join(path, OWNERSHIP_FILE)
  if (existsSync(marker)) {
    let recorded = null
    try {
      recorded = JSON.parse(readFileSync(marker, 'utf8'))
    } catch {
      recorded = null
    }
    if (!isPlainObject(recorded) || recorded.contractVersion !== CONTRACT_VERSION) {
      throw new InputError(
        'conflicting-environment-control',
        'the task run directory is already in use and its ownership record cannot be read',
        `${marker} does not name a ${CONTRACT_VERSION} run`,
      )
    }
    return recorded
  }
  if (existsSync(join(path, 'storage.git')) || existsSync(join(path, 'workspaces'))) {
    throw new InputError(
      'conflicting-environment-control',
      'the task run directory already holds task-owned storage that this run did not create',
      `${path} contains storage.git or workspaces without an ownership record`,
    )
  }
  const claim = {
    contractVersion: CONTRACT_VERSION,
    repository: repository ?? null,
    claimed: true,
  }
  writeFileSync(marker, `${JSON.stringify(claim, null, 2)}\n`)
  return claim
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
      // The bytes, never a decoded string. Decoding replaces every byte that is not valid
      // UTF-8 with U+FFFD, so two different binary files - or one file whose bytes were
      // rewritten - decode to the same text and the digest reports the user's work as
      // unchanged when it is not. A symlink is content too: its target is read with
      // `readlink`, so retargeting one is drift rather than an empty path.
      const stat = lstatSync(full)
      parts.push(
        relativePath,
        stat.isSymbolicLink()
          ? `link:${readlinkSync(full)}`
          : `file:${hashBytes(readFileSync(full))}`,
      )
    } catch {
      parts.push(relativePath, 'unreadable')
    }
  }
  return parts.join('\u0000')
}

/**
 * The digest of raw content, over the bytes and their length.
 *
 * A hash of the decoded text would not be a hash of the content; this one is over what is
 * on disk, so two different byte sequences cannot collide by decoding to the same string.
 */
function hashBytes(bytes) {
  return `${createHash('sha256').update(bytes).digest('hex')}:${bytes.length}`
}

/**
 * The path Git itself would use for one of its own state files in this repository.
 *
 * `join(path, '.git', marker)` is right only for an ordinary checkout. In a linked
 * worktree `.git` is a file naming a directory elsewhere - `worktrees/<name>` under the
 * common directory - so an operation in progress there has a real `MERGE_HEAD` that this
 * construction never finds, and the run reports a user's unfinished merge as no operation
 * at all. `rev-parse --git-path` answers with the path Git would use, and it is asked of
 * the repository rather than assembled.
 */
function gitStatePath(cwd, marker) {
  const resolved = gitOut(cwd, ['rev-parse', '--git-path', marker])
  if (!resolved) return null
  return isAbsolute(resolved) ? resolved : resolve(cwd, resolved)
}

/**
 * The user's checkout, read and never written. The helper inspects it to report what the
 * run found - a dirty, staged, untracked, detached, or mid-operation workspace is a fact
 * the result carries, not something to normalize - and every Git call below runs in a
 * task-owned directory.
 */
function readUserFingerprint(userWorkspace) {
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
  ]
    .map((marker) => ({ marker, state: gitStatePath(path, marker) }))
    .filter((entry) => entry.state !== null && existsSync(entry.state))
    .map((entry) => entry.marker)
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

/**
 * Whether a tree holds a blob with this id at any path.
 *
 * Used only to decide whether a contributed path was carried to a new name, so it is
 * deliberately content-addressed: it never guesses a rename, it asks whether the exact
 * content this pull request contributed is present in the prepared tree at all.
 */
function blobPresentAtAnyPath(storage, treeish, oid) {
  const listed = runGit(storage, ['ls-tree', '-r', '-z', '--format=%(objectname)', treeish], {
    allowFailure: true,
  })
  if (!listed.ok) return false
  // `-z` separates with NUL, which `lines` does not split on.
  return listed.stdout.split('\u0000').includes(oid)
}

/**
 * Named differences between two fingerprints of the same checkout.
 *
 * Comparing a path list or a stash *count* would call a rewritten file or a replaced stash
 * unchanged, so every field here is content: the staged diff digest, the worktree diff
 * plus untracked contents, the stash object ids themselves, the local configuration, and
 * the identity that would sign a commit. The names are returned so a report says what
 * moved rather than only that something did.
 */
function fingerprintDrift(before, after) {
  if (!before || !after) return []
  const drift = []
  for (const field of [
    'headOid',
    'headRef',
    'status',
    'indexDigest',
    'worktreeDigest',
    'stashOids',
    'stashCount',
    'configDigest',
    'identity',
  ]) {
    if ((before[field] ?? null) !== (after[field] ?? null)) {
      drift.push(
        `${field}: journalled ${JSON.stringify(before[field] ?? null)}, now ${JSON.stringify(after[field] ?? null)}`,
      )
    }
  }
  const beforeOperations = (before.operationsInProgress ?? []).join(',')
  const afterOperations = (after.operationsInProgress ?? []).join(',')
  if (beforeOperations !== afterOperations) {
    drift.push(
      `operationsInProgress: journalled ${beforeOperations || 'none'}, now ${afterOperations || 'none'}`,
    )
  }
  return drift
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
  // A resolution is a decision the agent made and has to account for. One without a stated
  // intent or a stated reason is refused here, while the plan is still being read, rather
  // than after a run directory exists and the branches before it have been integrated: a
  // plan that can never complete should not leave half a preparation behind.
  for (const [index, resolution] of resolutions.entries()) {
    if (resolution.path === null) {
      throw new InputError(
        'invalid-input',
        `resolutions[${index}].path must name a path`,
        'received no path',
      )
    }
    if (resolution.intent.trim() === '' || resolution.reason.trim() === '') {
      throw new InputError(
        'invalid-input',
        `resolutions[${index}] for #${resolution.number} ${resolution.path} carries no stated intent or reason`,
        `intent ${JSON.stringify(resolution.intent)}, reason ${JSON.stringify(resolution.reason)}`,
      )
    }
  }
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

  // Every pinned ref is fetched into its own snapshot namespace rather than into the same
  // names it has at the source. A wildcard fetch into `refs/heads/...` leaves the previous
  // run's destination ref in place when the source ref has since been deleted, so a
  // deleted selected head would still verify against storage it never came from.
  const refspecs = Array.from(new Set([input.root.ref, ...Object.values(input.heads)])).map(
    (ref) => `+${ref}:${SNAPSHOT_PREFIX}${ref}`,
  )
  const fetch = runGit(
    input.runDirectory,
    ['--git-dir', storage, 'fetch', '--quiet', '--prune', input.repository, ...refspecs],
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

/** Where a pinned source ref is copied inside task-owned storage. */
function snapshotRef(ref) {
  return `${SNAPSHOT_PREFIX}${ref}`
}

function snapshotOid(storage, ref) {
  return gitOut(storage, ['rev-parse', '--verify', '--quiet', `${snapshotRef(ref)}^{commit}`])
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

/**
 * The pinned snapshot, checked against the source repository itself.
 *
 * A ref deleted at the source since the plan was authorized must be a blocker, and
 * storage is not allowed to answer for it: a destination ref left over from an earlier
 * fetch is exactly the evidence that would hide the deletion. The source's own
 * `ls-remote` is the only authority for whether a pinned ref still exists, and its commit
 * id is compared with the pinned one so a moved head is caught as well.
 */
function verifySnapshot(input, storage) {
  const errors = []
  const sourceLs = runGit(input.runDirectory, ['ls-remote', '--heads', input.repository], {
    allowFailure: true,
  })
  if (!sourceLs.ok) {
    errors.push({
      code: 'stale-snapshot',
      detail: 'the source repository could not be listed',
      evidence: sourceLs.stderr.trim().slice(0, 400),
    })
    return { errors, observedHeads: {} }
  }
  const sourceRefs = {}
  for (const line of lines(sourceLs.stdout)) {
    const [oid, ref] = line.split(/\s+/)
    if (ref && oid) sourceRefs[ref] = oid
  }
  const observedHeads = {}
  for (const ref of [input.root.ref, ...input.order.map((number) => input.heads[number])]) {
    const number = input.order.find((entry) => input.heads[entry] === ref) ?? null
    const isRoot = ref === input.root.ref
    const pinned = isRoot ? input.root.oid : input.originalHeads[number]
    if (!sourceRefs[ref]) {
      errors.push({
        code: 'stale-snapshot',
        detail: `${isRoot ? 'the root ref' : `the head branch ${ref} of #${number}`} is absent from the source repository`,
        evidence: `pinned ${pinned}; the source holds ${Object.keys(sourceRefs).length} branches`,
      })
      continue
    }
    if (sourceRefs[ref] !== pinned) {
      errors.push({
        code: 'stale-snapshot',
        detail: `${ref} moved since the plan was authorized`,
        evidence: `pinned ${pinned}, source holds ${sourceRefs[ref]}`,
      })
    }
    const fetched = snapshotOid(storage, ref)
    if (fetched !== sourceRefs[ref]) {
      errors.push({
        code: 'stale-snapshot',
        detail: `task-owned storage does not hold what the source published for ${ref}`,
        evidence: `source ${sourceRefs[ref]}, storage ${fetched ?? 'nothing'}`,
      })
    }
    if (number !== null) observedHeads[number] = sourceRefs[ref]
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

/**
 * The journal belongs to one immutable plan, and only that plan.
 *
 * Selection, order, source repository, root, head refs, and every original commit id are
 * part of it: a changed original commit id under an existing journal means the work has
 * moved on, and returning the recorded prepared heads would describe a stack that no
 * longer contains what the caller asked for.
 */
function sameIdentity(journal, input) {
  if (!isPlainObject(journal)) return false
  const recorded = journal.selection ?? []
  if (
    recorded.length !== input.selection.length ||
    !recorded.every((number) => input.selection.includes(number)) ||
    journal.root?.ref !== input.root.ref ||
    journal.root?.oid !== input.root.oid
  ) {
    return false
  }
  if (JSON.stringify(journal.order ?? null) !== JSON.stringify(input.order)) return false
  if ((journal.repository ?? null) !== input.repository) return false
  for (const number of input.order) {
    if ((journal.heads?.[number] ?? null) !== input.heads[number]) return false
    if ((journal.originalHeads?.[number] ?? null) !== input.originalHeads[number]) return false
  }
  return true
}

/**
 * The workspace for one position: created fresh, or the one an interrupted run left.
 *
 * Reusing it is only safe when the recorded evidence still holds - the workspace is
 * really at the original head this run pinned, and any operation it has in progress is the
 * merge this run is about to finish. Anything else means a different plan is sitting in
 * this directory, and deleting it would destroy the only copy of a conflict decision.
 */
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
    const head = gitOut(workspace, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (head !== originalOid) {
      throw new InputError(
        'stale-snapshot',
        `the workspace for #${number} is not at the original head this run pinned`,
        `${workspace} is at ${head ?? 'nothing'}, the plan pins ${originalOid}; it was not recreated and its conflict evidence was not discarded`,
      )
    }
    return workspace
  }
  // Nothing is checked out yet, deliberately. A clone that writes a working tree runs
  // smudge filters over every path and can fire template-installed checkout hooks, and the
  // whole point of the admission check below is that no such thing may happen before this
  // run has decided it is safe. `--no-checkout` leaves an empty tree and no hook runs.
  runGit(storage, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', storage, workspace])
  // Both admissions are decided here, after the clone has installed whatever hooks it
  // inherits and before the first working-tree write: `--no-checkout` deferred one
  // command, not the run.
  const blocked = [
    ...attributedDriverControls(storage, originalOid, treePaths(storage, originalOid), workspace),
    ...workspaceHookControls(workspace),
  ].filter((control) => control.blocking)
  if (blocked.length > 0) {
    throw new InputError(
      'conflicting-environment-control',
      `#${number} cannot be checked out: an executable control would run over this workspace`,
      blocked
        .map((control) => `${control.control} = ${control.value}; ${control.effect}`)
        .join(' | '),
    )
  }
  runGit(workspace, ['checkout', '--quiet', '-B', `prepared/${number}`, originalOid])
  return workspace
}

/**
 * Every path a tree holds, so a checkout is admitted for all of it and not a sample.
 *
 * The read goes through the same `git` adapter the control probes use, so it is taken in
 * the same environment and under the same policy as the command it is gating.
 */
const controlProbe = (cwd, args) => runGit(cwd, args, { allowFailure: true })

function treePaths(storage, oid) {
  return readTreePaths(controlProbe, storage, oid)
}

/**
 * The executable controls the caller's own environment and configuration impose, read
 * before anything is created and before the user's checkout is touched.
 *
 * Both repositories are read, because both are repositories whose commands this run
 * starts. The source is copied from and the user workspace is fingerprinted, and a
 * repository-local `core.fsmonitor`, a local `core.hooksPath`, or an attributed
 * `diff.<name>.textconv` in either one is a program `git status` or `git diff` will
 * execute. The caller's environment is passed through unchanged rather than narrowed
 * first: narrowing would make this read a configuration the helper's own children never
 * see, which is a clean report of a control it had already bypassed.
 */
function inheritedExecutableControls(callerEnv, input) {
  const probe = (cwd, args, env) => runGit(cwd, args, { allowFailure: true, env: env ?? callerEnv })
  // A user workspace that IS the source is one repository, not two. Reading it twice
  // produced the same control twice and named the same repository twice, so the report
  // read as two findings where there is exactly one.
  const repositories = [
    ...new Set(
      [input.repository, input.userWorkspace].filter(
        (repository) => typeof repository === 'string' && repository !== '',
      ),
    ),
  ]
  // Preparation copies pinned refs from a local source path and never opens a transport,
  // so only the always-reachable controls apply here.
  const controls = []
  const seen = new Set()
  for (const repository of repositories) {
    for (const control of readExecutableControls(probe, repository, callerEnv, new Set(['file']))) {
      // Deduplicated on the control and its value together: one control configured twice
      // with different values is two facts, and the same fact read twice is one. The
      // control's `blocking` is carried through untouched, so the report cannot describe a
      // control as non-blocking while an error says the run stopped because of it.
      const key = `${control.control} ${control.value}`
      if (seen.has(key)) continue
      seen.add(key)
      controls.push({
        ...control,
        repository: repository === input.repository ? 'source' : 'user workspace',
        repositoryPath: repository,
      })
    }
  }
  return controls
}

function writeJournal(path, journal) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`)
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

/**
 * Content a workspace holds that no recorded decision accounts for.
 *
 * Porcelain status is the index's own record, so a path that is still unmerged is a
 * decision this run has not been told yet - the documented continuation - while a path
 * that has left the unmerged set has been *staged*, which means somebody resolved it and
 * this run did not. Reporting the difference keeps a resumed run from adopting somebody
 * else's resolution under its own `prepared` status.
 */
function unrecordedWorkspaceChanges(workspace, number, recordedDecisions) {
  const recorded = new Set(
    recordedDecisions.filter((decision) => decision.number === number).map((d) => d.path),
  )
  const unmerged = new Set(
    lines(gitOut(workspace, ['diff', '--name-only', '--diff-filter=U']) ?? ''),
  )
  const stray = []
  for (const entry of lines(
    gitOut(workspace, ['status', '--porcelain=v1', '--untracked-files=no']) ?? '',
  )) {
    const path = entry.slice(3)
    if (path.length === 0) continue
    if (unmerged.has(path) || recorded.has(path)) continue
    stray.push(path)
  }
  return stray
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
    // The mode decides before the shape does. A path that is a gitlink on either side is
    // a submodule reference, not two added files, whether or not a base version existed;
    // and a path that is a tree on one side is a file/directory conflict, which Git leaves
    // as a single unmerged entry under a `~`-suffixed name rather than as a pair. Both are
    // checked first so that neither can be reported as the plain add/add or modify/delete
    // it superficially resembles, and an agent is never invited to resolve them.
    if (mode(base) === '040000' || mode(ours) === '040000' || mode(theirs) === '040000')
      kind = 'file-directory'
    else if (mode(base) === '160000' || mode(ours) === '160000' || mode(theirs) === '160000')
      kind = 'submodule'
    else if (mode(base) === '120000' || mode(ours) === '120000' || mode(theirs) === '120000')
      kind = 'symlink'
    else if (!base && ours && theirs) kind = 'add-add'
    else if (base && ours && !theirs) kind = 'delete-modify'
    else if (base && !ours && theirs) kind = 'modify-delete'
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

  // A file/directory conflict is the one shape Git does not leave as a pair of stages. It
  // parks the directory under a placeholder name - `thing~HEAD`, `thing~<oid>` - and leaves
  // that placeholder itself as a regular-file conflict, so a stage-mode check cannot see it
  // and it would otherwise be reported as the modify/delete it resembles. What identifies
  // it is present in the worktree Git just wrote: the placeholder is a file, and the path it
  // was parked under is a real directory. A file genuinely named `thing~HEAD` does not also
  // put a directory at `thing`, so this cannot misfire on an ordinary name.
  for (const entry of merged) {
    if (entry.kind === 'file-directory') continue
    const parked = entry.path.slice(0, entry.path.lastIndexOf('~'))
    if (parked === '' || parked === entry.path) continue
    try {
      if (!statSync(join(workspace, entry.path)).isFile()) continue
      if (!statSync(join(workspace, parked)).isDirectory()) continue
    } catch {
      continue
    }
    entry.kind = 'file-directory'
    entry.structural = true
    fileDirectory.add(entry.path)
  }
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

  // A conflicted workspace left by an interrupted run is the same merge only if it is
  // merging the same base. Otherwise its unmerged stages, merge base, and any content
  // already staged describe a different integration, and every conflict decision read from
  // them would be a decision about the wrong content.
  const pendingMergeHead = gitOut(workspace, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  const alreadyInMerge = pendingMergeHead !== null
  if (alreadyInMerge && pendingMergeHead !== baseOid) {
    return {
      branch: null,
      outcome: 'blocked',
      workspace,
      conflicts: [],
      decisions,
      errors: [
        {
          code: 'stale-snapshot',
          detail: `the workspace for #${number} is in the middle of a different merge`,
          evidence: `its MERGE_HEAD is ${pendingMergeHead}; this run integrates ${baseOid}; the workspace was left untouched so its staged content is not discarded`,
        },
      ],
      predecessor: predecessor?.number ?? null,
    }
  }

  // Decided before the merge, not after: a driver that keeps one side produces a clean
  // merge that silently drops the other side's content, and there is nothing to detect
  // afterwards. The merge materialises the base's files into the worktree, so the base
  // tree is admitted in full - every path it holds, not only the ones a diff names - and
  // the attributes are read in the workspace where the merge will run.
  const hookControls = workspaceHookControls(workspace)
  const driverControls = alreadyInMerge
    ? []
    : attributedDriverControls(storage, baseOid, treePaths(storage, baseOid), workspace)
  const admissionControls = [...driverControls, ...hookControls]
  const blockingControls = admissionControls.filter((control) => control.blocking)
  if (blockingControls.length > 0) {
    return {
      branch: null,
      outcome: 'blocked',
      workspace,
      conflicts: [],
      decisions,
      errors: blockingControls.map((control) => ({
        code: 'conflicting-environment-control',
        detail: `${control.control} would run over this merge or its commit`,
        evidence: control.effect,
      })),
      predecessor: predecessor?.number ?? null,
      controls: admissionControls,
    }
  }

  // Resuming adopts content only when this run's own journal says it decided that content.
  // A staged resolution nobody recorded - a hand-run `git add`, an editor's save-and-stage,
  // a previous run's decision that was never journalled - would otherwise be committed
  // under this run's `prepared` status and attributed to a decision it never made. A file
  // still in conflict is deliberately not "unrecorded": that is the continuation this
  // document describes, where the decision arrives through `resolutions`.
  if (alreadyInMerge) {
    const stray = unrecordedWorkspaceChanges(workspace, number, options.recordedDecisions ?? [])
    if (stray.length > 0) {
      return {
        branch: null,
        outcome: 'blocked',
        workspace,
        conflicts: [],
        decisions,
        errors: [
          {
            code: 'unfinished-run',
            detail: `the workspace for #${number} holds staged content this run never decided`,
            evidence: `${stray.join(', ')} is staged in ${workspace} but absent from the journal's recorded decisions; it was not committed and not discarded - supply the resolution instead of staging it`,
          },
        ],
        predecessor: predecessor?.number ?? null,
      }
    }
  }

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

  // Every selected original this prepared head actually keeps, not only the commits this
  // branch itself contributed. In a diamond the tip's original history already contains
  // both arms and their shared parent, and a list naming only the tip's own commits
  // understates what was retained - which is the one thing this field exists to say.
  const retained = [
    ...new Set([
      ...reachableCommits(storage, originalOid, baseOid),
      ...input.order
        .map((selected) => input.originalHeads[String(selected)] ?? input.originalHeads[selected])
        .filter(
          (oid) => typeof oid === 'string' && oid !== '' && isAncestor(storage, oid, preparedHead),
        ),
    ]),
  ].sort()
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
    // The contribution can also have been carried to a different path. Git's rename
    // detection folds an edit of `moves/old.txt` into the `moves/new.txt` that replaced
    // it, and the content is then present under the new name while the contributed path is
    // legitimately gone - calling that a loss refuses every correct run that renamed a
    // file somebody else had edited. The test is content, not name: the prepared tree must
    // hold this pull request's version of the contribution at some other path.
    if (origBlob && blobPresentAtAnyPath(storage, preparedHead, origBlob)) return false
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
 * Controls that could change what a merge or a commit actually does, read from the source
 * repository before anything is created.
 *
 * Cloning copies objects and refs, not local configuration or hooks, so a signing, hook,
 * filter, or driver policy the source enforces can quietly stop applying to the
 * integration commit - and a task clone does inherit global and environment
 * configuration, so an inherited `merge.<name>.driver` referenced by a tracked
 * `.gitattributes` runs *in* the merge. Anything that would execute, or whose absence in
 * task storage would silently drop a mandatory requirement, is a blocker decided before
 * the first clone. Nothing here is weakened, and no install, driver, submodule fetch, or
 * lifecycle command is ever run to make the work easier.
 */
function inspectControls(repository) {
  const controls = []
  // The environment routing every Git child would otherwise inherit is reported, not
  // applied: these names were removed from each child's environment so a task-owned cwd
  // is real isolation, and a run launched under an override deserves to see that it was.
  const overrides = routingOverrides()
  if (overrides.length > 0) {
    controls.push({
      control: 'env.routing',
      value: overrides.join(','),
      inTaskStorage: 'removed',
      blocking: false,
      effect:
        'these variables chose which repository, index, object store, configuration, or template directory a Git child would talk to; they were removed from every Git child this run starts, so the machine\u2019s real policy applies',
    })
  }

  // `git config --get-regexp` exits 1 for "no match" and something else for "could not be
  // read". Only the first is an answer; the second means the absence of a control cannot be
  // claimed, so it blocks.
  const readConfig = (args, where) => {
    const result = runGit(repository, ['config', ...args], { allowFailure: true })
    if (result.ok || result.status === 1) return lines(result.stdout)
    controls.push({
      control: `config.read${where}`,
      value: result.stderr.trim().slice(0, 200) || `git config exited ${result.status}`,
      inTaskStorage: 'inherited',
      blocking: true,
      effect: `the ${where} configuration could not be read, so the absence of a control cannot be claimed`,
    })
    return []
  }

  for (const line of readConfig(
    [
      '--get-regexp',
      '^(commit\\.gpgsign|tag\\.gpgsign|gpg\\.format|user\\.signingkey|core\\.hooksPath|core\\.fsmonitor|diff\\.external|merge\\.tool|core\\.autocrlf|core\\.eol|credential\\.helper)$',
    ],
    '(local)',
  )) {
    const space = line.indexOf(' ')
    const key = line.slice(0, space)
    const value = line.slice(space + 1)
    const lowered = key.toLowerCase()
    const isSigning = lowered === 'commit.gpgsign' && value.toLowerCase() === 'true'
    const isHooks = lowered === 'core.hookspath'
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

  // A driver that no tracked `.gitattributes` names for any path is reported and left
  // alone: the environment commonly configures tools such as git-lfs globally, and
  // refusing every run because of them would make the helper unusable rather than safe.
  // Whether one applies to this merge is decided per path, before the merge, by
  // `attributedDriverControls`.
  const driverLines = new Set([
    ...readConfig(
      [
        '--get-regexp',
        '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|diff\\..*\\.command|diff\\.external)$',
      ],
      '(effective)',
    ),
  ])
  for (const line of driverLines) {
    const space = line.indexOf(' ')
    const key = line.slice(0, space)
    const value = line.slice(space + 1)
    controls.push({
      control: key,
      value,
      inTaskStorage: 'inherited',
      blocking: false,
      effect:
        'reported, never overridden; whether it applies to a merged path is decided per path before the merge',
    })
  }

  // Git resolves a relative `core.hooksPath` against the repository, not the caller's
  // directory, so the effective directory is asked of Git rather than assembled here.
  const hooksConfig = gitOut(repository, ['config', '--get', 'core.hooksPath'])
  const resolvedHooks = gitOut(repository, ['rev-parse', '--git-path', 'hooks'])
  const hooksDir = resolvedHooks
    ? isAbsolute(resolvedHooks)
      ? resolvedHooks
      : resolve(repository, resolvedHooks)
    : existsSync(join(repository, '.git', 'hooks'))
      ? join(repository, '.git', 'hooks')
      : join(repository, 'hooks')
  if (!hooksConfig) {
    controls.push({
      control: 'hooks.path',
      value: resolvedHooks ?? hooksDir,
      inTaskStorage: 'resolved',
      blocking: false,
      effect: "no core.hooksPath is configured; Git's default hook directory applies",
    })
  }
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
 * Whether an effective clean/smudge filter, merge driver, or textconv command is
 * attributed to any path a tree about to be written actually holds.
 *
 * The reading itself lives in `git-controls.mjs`, shared with the measurement helper
 * that probes the same way: the configuration Git would use is read in full rather than
 * one key at a time, so a driver configured only in an included file, only in the global
 * config, or only through a `GIT_CONFIG_*` variable in the caller's environment is still
 * a driver this run would execute. Attributes are read with `--source=<oid>` from a tree
 * that has not been written to disk, so no checkout, filter, hook, or driver has run in
 * order to find this out.
 */
function attributedDriverControls(storage, sourceOid, paths, cwd = storage) {
  return readAttributedDriverControls(controlProbe, cwd, [sourceOid], paths, (probeCwd, args) =>
    // The caller's own environment, which is `process.env` because narrowing happens per
    // child process and never by mutating this one. Reading the configuration any other
    // way reports the caller's drivers as unconfigured.
    runGit(probeCwd, args, { allowFailure: true, env: { ...process.env } }),
  )
}

/**
 * The hooks a task workspace would actually run, read from the workspace itself.
 *
 * `git clone --no-checkout` keeps the *first* checkout from running, and it is not
 * enough on its own: the clone still installs whatever `init.templateDir` holds, an
 * inherited `core.hooksPath` can point somewhere else entirely, and every later
 * `checkout`, `merge`, and `commit` in this workspace runs `post-checkout`,
 * `pre-merge-commit`/`merge-commit`, `pre-commit`, `prepare-commit-msg`, `commit-msg`, and
 * `post-commit` without asking. Git is asked which directory it would use, in the
 * repository the command would run in, so a relative `core.hooksPath` resolves the way it
 * resolves at push time rather than against the caller's directory.
 *
 * An installed hook is a mandatory control this helper must not bypass - and whose side
 * effects (a check runner, a formatter, a network call) it cannot prove - so it blocks.
 * Nothing here is disabled or overridden.
 */
function workspaceHookControls(cwd) {
  const controls = []
  const resolved = gitOut(cwd, ['rev-parse', '--git-path', 'hooks'])
  const hooksDir = resolved
    ? isAbsolute(resolved)
      ? resolved
      : resolve(cwd, resolved)
    : join(cwd, '.git', 'hooks')
  controls.push({
    control: 'hooks.path',
    value: hooksDir,
    inTaskStorage: 'resolved',
    blocking: false,
    effect:
      'Git resolves this directory for every hook this workspace would run; it is read from Git rather than assembled here',
  })
  if (!existsSync(hooksDir)) return controls
  let entries = []
  try {
    entries = readdirSync(hooksDir)
  } catch {
    controls.push({
      control: 'hooks.directory',
      value: hooksDir,
      inTaskStorage: 'resolved',
      blocking: true,
      effect:
        'the hook directory this workspace would use could not be listed, so it cannot be claimed that no hook would run',
    })
    return controls
  }
  for (const entry of entries) {
    if (entry.endsWith('.sample')) continue
    const full = join(hooksDir, entry)
    let executable = false
    let isFile = false
    try {
      const stat = lstatSync(full)
      isFile = stat.isFile()
      executable = (stat.mode & 0o111) !== 0
    } catch {
      continue
    }
    if (!isFile || !executable) continue
    controls.push({
      control: `hooks/${entry}`,
      value: 'installed in this task workspace',
      inTaskStorage: 'inherited',
      blocking: true,
      effect:
        'an executable hook is installed where this checkout, merge, and commit would run it; its side effects cannot be proved, so preparation stops instead of bypassing it',
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

  // Control admission comes first, in the caller's own environment, and against BOTH
  // repositories this run touches. `readUserFingerprint` runs `git status` and `git diff`
  // in the user's own checkout, and Git consults `core.fsmonitor`, an index extension, and
  // any `diff.<name>.textconv` the attributes name while answering those. Fingerprinting
  // first would execute the very controls this run is supposed to refuse, and then report
  // the run as prepared after having done it. The user's repository is read only once the
  // controls that govern reading it have been admitted.
  const callerEnv = { ...process.env }
  const inheritedControls = inheritedExecutableControls(callerEnv, input)
  const blockingInherited = inheritedControls.filter((control) => control.blocking)
  if (blockingInherited.length > 0) {
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: blockingInherited.map((control) => ({
        code: 'conflicting-environment-control',
        detail: `the caller's environment or configuration imposes ${control.control}, which this run will not strip and will not run`,
        evidence: `${control.control} = ${control.value} (${control.repository ?? 'caller'}); ${control.effect}`,
      })),
      run: null,
      preparation: null,
      verification: [],
      continuation: { prepared: [], remaining: input.order, resumeFrom: null },
      conflicts: [],
      controls: inheritedControls,
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

  // Claimed only once the controls are known to be safe to run, so a refused run leaves
  // nothing behind in a directory it does not own.
  try {
    claimTaskDirectory(input.runDirectory, input.repository)
  } catch (error) {
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: [
        error instanceof InputError
          ? error
          : new InputError('invalid-input', String(error?.message ?? error), 'task directory'),
      ],
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

  // A resumed run inherits the baseline the first run journalled, not only the state it
  // happens to find. The user's checkout is not this run's to move, and a difference that
  // appeared between the two runs is a fact about their work, not something to fold into
  // this run's preservation claim.
  if (existing && input.resume && userBefore && existing.userWorkspaceBaseline) {
    const drift = fingerprintDrift(existing.userWorkspaceBaseline, userBefore)
    if (drift.length > 0) {
      return {
        contractVersion: CONTRACT_VERSION,
        ok: false,
        errors: [
          {
            code: 'conflicting-environment-control',
            detail:
              "the user's checkout, index, stash, or configuration changed between the journalled run and this resume",
            evidence: drift.join('; '),
          },
        ],
        run: {
          runId,
          runDirectory: input.runDirectory,
          journalPath,
          workspaces: [],
          backupRefs: [],
        },
        preparation: null,
        verification: [],
        continuation: existing.continuation ?? {
          prepared: [],
          remaining: input.order,
          resumeFrom: null,
        },
        conflicts: existing.conflicts ?? [],
        userWorkspace: userBefore,
        controls,
      }
    }
  }
  // Every Git child of this run is started with the routing variables removed, because a
  // task-owned working directory is not isolation while any of them survives. But a removed
  // variable is only free when it carried no policy: `GIT_CONFIG_COUNT=1
  // GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=true` is a mandatory control, and
  // dropping it would make this helper commit under weaker rules than the caller asked for
  // while reporting nothing. So the caller's own environment is read *before* anything is
  // created, with the configuration Git would really use, and an incompatible control stops
  // the run instead of being silently bypassed. Only then is the environment narrowed.
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
        recordedDecisions: journal.decisions,
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
  const userDrift = fingerprintDrift(userBefore, userAfter)
  if (userDrift.length > 0) {
    errors.push({
      code: 'conflicting-environment-control',
      detail: "the user's checkout, index, stash, or configuration changed during preparation",
      evidence: userDrift.join('; '),
    })
  }
  // Only when a workspace was actually named: with nothing to preserve there is no
  // observation to record, and an `unautomated` row here would read as a check that was
  // skipped rather than one that had no subject.
  if (userBefore) {
    verification.push({
      invariant: 'preservation.user-worktree',
      observed:
        userDrift.length === 0
          ? 'HEAD, porcelain status, staged diff, worktree diff, untracked contents, stash object ids, local config, and identity are unchanged'
          : userDrift.join('; '),
      result: userDrift.length === 0 ? 'pass' : 'fail',
    })
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
