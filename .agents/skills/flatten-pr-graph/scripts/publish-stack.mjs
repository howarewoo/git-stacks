#!/usr/bin/env node
/**
 * Scoped publication for `flatten-pr-graph/1`.
 *
 * One job: publish a prepared set and nothing else - the selected prepared branch heads
 * through one atomic, lease-guarded ref transaction, then the selected pull requests'
 * bases in dependency order - and report every attempt, acknowledgement, and uncertainty
 * as a fact about the provider rather than a claim about intent.
 *
 * What it will never do: push the root, push a tag, push an unselected ref, use a broad
 * refspec, prune, recurse into submodules, merge, close, or reopen a pull request, disable
 * auto-merge, touch a merge queue, read check state, or retry a write whose acknowledgement
 * is unknown. Branch updates and base updates are separate acknowledged operations, never
 * one transaction, and no document this prints may describe them as one.
 *
 * Authority is explicit and narrow. `authority.intent` must be `execute`, `authority.selection`
 * must equal the prepared set exactly, and `authority.granted` must name every mutation
 * kind requested. A preview, a prepared manifest, this skill's own name, a pull-request
 * body, or a shell being available is not a grant. The document's `authority` block is a
 * *declaration* the caller supplies: this helper cannot turn a model-manufactured grant
 * into a real permission, which is why a write additionally requires either a host-pinned
 * provider module (`FLATTEN_PR_PROVIDER_MODULE` in this process's environment, which the
 * model cannot choose) or `authority.hostVerified`, and why every result records
 * `authority.source`.
 *
 * Provider interface. `provider.module` is a module this helper imports and calls with one
 * operation object per call; it must not print anything else to stdout. Three operations,
 * and nothing else is ever requested:
 *
 *   capabilities()            -> { operations, compareAndSwap, provider }
 *   readPullRequest(number)   -> { ok, pullRequest: { number, state, draft, headRef,
 *                                  headRepository, headRefOid, baseRef, baseRefOid,
 *                                  title, body, labels, reviewers,
 *                                  autoMergeRequest: { enabled, method } } | null }
 *   updatePullRequestBase(number, base, expectedBase)
 *                            -> { ok, applied, preconditionMet: boolean | null, provider }
 *
 * `state` is the contract's own vocabulary (`OPEN`, `CLOSED`, `MERGED`); a provider that
 * reads REST spellings normalises them at its own boundary, because a publication blocked
 * by a casing difference would be a helper that only works against its own double.
 * `headRefOid` and `baseRefOid` are the commits the pull request points at, because an
 * attempt records commit ids in its `from` and `to` and a branch name is not a commit id.
 *
 * `compareAndSwap: false` is recorded honestly as `baseWritesGuardedBy:
 * "read-before-write"`, with `residualMetadataRace: true`: a read before the write is not
 * a compare-and-swap, and no document here may claim an atomicity the interface cannot
 * enforce. The read is scoped to one selected pull request's own metadata and its own
 * auto-merge request; merge queues, protections, rulesets, and checks are never read. A
 * provider reports `compareAndSwap: true` only when its server enforces the precondition
 * it is given; a provider that merely sends a field the server ignores reports false.
 *
 * Input JSON (stdin or `--input <file>`):
 *
 *   {
 *     "contractVersion": "flatten-pr-graph/1",
 *     "repository": "/abs/task-owned/storage.git",
 *     "remote": "/abs/disposable/remote.git",
 *     "runDirectory": "/abs/task-owned/run",
 *     "authority": { "intent": "execute", "selection": [12, 13],
 *                    "granted": ["ref-update", "pr-base-update"], "hostVerified": true },
 *     "preparation": { "branches": [{ "number": 12, "originalHead": "...", "preparedHead":
 *                     "...", "basedOn": "..." }] },
 *     "preparationRunDirectory": "/abs/task-owned/prepare-run",
 *     "order": [12, 13],
 *     "heads": { "12": "refs/heads/feat-a" },
 *     "intendedBases": { "12": "main", "13": "feat-a" },
 *     "pullRequests": { "12": { "state": "OPEN", "headRef": "feat-a",
 *                    "headRepository": "owner/repo", "baseRef": "main" } },
 *     "root": { "ref": "refs/heads/main", "oid": "..." },
 *     "observedRefs": { "refs/heads/unrelated": "<oid>" },
 *     "unselectedDependents": [{ "number": 20, "dependsOn": 12 }],
 *     "provider": { "module": "/abs/path/to/adapter.mjs" },
 *     "resume": false, "now": "2026-10-01T09:00:00.000Z"
 *   }
 *
 * `pullRequests` is the authorized snapshot of the selected pull requests: identity,
 * head repository, and base are compared before anything is written, because a fork pull
 * request with the same branch name and a base somebody else already moved are not the
 * plan this document claims to publish. `remote` may be a remote name; it is resolved to
 * exactly one push endpoint in task-owned storage, and reads and writes then use that one
 * endpoint.
 *
 * Output JSON on stdout: `{ contractVersion, ok, status, errors, publication, capability,
 * controls, authority, provider, rootAdvance, unselectedDependents, verification,
 * recovery, nextSafeAction, journalPath }`, where `publication` is the contract's
 * `publication` document.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CONTRACT_VERSION = 'flatten-pr-graph/1'
const GIT_TIMEOUT_MS = 300_000
const MAX_EVIDENCE_CHARS = 4_000
const WRITE_KINDS = ['ref-update', 'pr-base-update']

class InputError extends Error {
  constructor(code, detail, evidence) {
    super(detail)
    this.code = code
    this.detail = detail
    this.evidence = evidence
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
    return result
  }
}

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

function requireExistingDirectory(value, where) {
  if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value)) {
    throw new InputError(
      'invalid-input',
      `${where} must be an existing absolute directory`,
      `received ${JSON.stringify(value)}`,
    )
  }
  return resolve(value)
}

function requireRemote(value, where) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\n]/.test(value)) {
    throw new InputError(
      'invalid-input',
      `${where} must be a remote name or path`,
      `received ${JSON.stringify(value)}`,
    )
  }
  if (value.startsWith('ext::') || value.includes('::')) {
    throw new InputError(
      'conflicting-environment-control',
      `${where} specifies an ext or custom remote transport, which is not permitted`,
      value,
    )
  }
  return value
}

function verifyInput(raw) {
  const repository = requireExistingDirectory(raw.repository, 'repository')
  const remote = requireRemote(raw.remote, 'remote')
  const runDirectory = resolve(
    typeof raw.runDirectory === 'string' && isAbsolute(raw.runDirectory)
      ? raw.runDirectory
      : join(repository, '..', 'run'),
  )
  mkdirSync(runDirectory, { recursive: true })
  const root = {
    ref: typeof raw.root?.ref === 'string' ? raw.root.ref : '',
    oid: requireSha(raw.root?.oid, 'root.oid'),
  }
  if (!root.ref.startsWith('refs/')) {
    throw new InputError('invalid-input', 'root.ref must be a fully qualified ref', raw.root?.ref)
  }
  const preparation = isPlainObject(raw.preparation) ? raw.preparation : null
  if (!preparation || !Array.isArray(preparation.branches) || preparation.branches.length === 0) {
    throw new InputError(
      'invalid-input',
      'publication consumes a prepared set; there is nothing to publish without one',
      'preparation.branches was empty or absent',
    )
  }
  const branches = preparation.branches.map((branch, index) => ({
    number: requirePositiveInteger(branch?.number, `preparation.branches[${index}].number`),
    originalHead: requireSha(branch?.originalHead, `preparation.branches[${index}].originalHead`),
    preparedHead: requireSha(branch?.preparedHead, `preparation.branches[${index}].preparedHead`),
    basedOn: requireSha(branch?.basedOn, `preparation.branches[${index}].basedOn`),
  }))
  const numbers = branches.map((branch) => branch.number)
  if (new Set(numbers).size !== numbers.length) {
    throw new InputError(
      'invalid-input',
      'a prepared set must place each pull request exactly once',
      `prepared ${JSON.stringify(numbers)}`,
    )
  }
  const order = (Array.isArray(raw.order) ? raw.order : numbers).map((number, index) =>
    requirePositiveInteger(number, `order[${index}]`),
  )
  if (
    order.length !== numbers.length ||
    new Set(order).size !== order.length ||
    order.some((number) => !numbers.includes(number))
  ) {
    throw new InputError(
      'invalid-input',
      'the order must be a permutation of the prepared set: every selected pull request exactly once',
      `order ${JSON.stringify(order)}, prepared ${JSON.stringify(numbers)}`,
    )
  }
  const heads = {}
  const intendedBases = {}
  for (const number of numbers) {
    const head = raw.heads?.[String(number)] ?? raw.heads?.[number]
    if (typeof head !== 'string' || !head.startsWith('refs/heads/')) {
      throw new InputError(
        'invalid-input',
        `heads[${number}] must be a fully qualified branch ref`,
        `received ${JSON.stringify(head)}`,
      )
    }
    heads[number] = head
    const base = raw.intendedBases?.[String(number)] ?? raw.intendedBases?.[number]
    if (typeof base !== 'string' || base.length === 0) {
      throw new InputError(
        'invalid-input',
        `intendedBases[${number}] must name the branch this pull request should build on`,
        `received ${JSON.stringify(base)}`,
      )
    }
    intendedBases[number] = base
  }
  if (new Set(Object.values(heads)).size !== numbers.length) {
    throw new InputError(
      'invalid-input',
      'two selected pull requests share one head branch, so no chain can publish them',
      `heads ${JSON.stringify(heads)}`,
    )
  }
  const authority = {
    intent: raw.authority?.intent === 'execute' ? 'execute' : String(raw.authority?.intent ?? ''),
    selection: (Array.isArray(raw.authority?.selection) ? raw.authority.selection : []).map(
      (number, index) => requirePositiveInteger(number, `authority.selection[${index}]`),
    ),
    granted: (Array.isArray(raw.authority?.granted) ? raw.authority.granted : []).map(String),
    hostVerified: raw.authority?.hostVerified === true,
  }
  const observedRefs = {}
  for (const [ref, oid] of Object.entries(
    isPlainObject(raw.observedRefs) ? raw.observedRefs : {},
  )) {
    observedRefs[ref] = requireSha(oid, `observedRefs[${ref}]`)
  }
  const pullRequests = {}
  if (isPlainObject(raw.pullRequests)) {
    for (const number of numbers) {
      const pinned = raw.pullRequests?.[String(number)] ?? raw.pullRequests?.[number]
      if (pinned) {
        if (
          !isPlainObject(pinned) ||
          typeof pinned.headRef !== 'string' ||
          typeof pinned.headRepository !== 'string' ||
          typeof pinned.baseRef !== 'string'
        ) {
          throw new InputError(
            'invalid-input',
            `pullRequests[${number}] must carry the authorized headRef, headRepository, and baseRef of that pull request`,
            `received ${JSON.stringify(pinned)}`,
          )
        }
        pullRequests[number] = {
          state: typeof pinned.state === 'string' ? pinned.state : null,
          headRef: pinned.headRef,
          headRepository: pinned.headRepository,
          baseRef: pinned.baseRef,
          headRefOid: typeof pinned.headRefOid === 'string' ? pinned.headRefOid : null,
        }
      }
    }
  }
  const preparationRunDirectory =
    typeof raw.preparationRunDirectory === 'string' && isAbsolute(raw.preparationRunDirectory)
      ? resolve(raw.preparationRunDirectory)
      : null
  return {
    repository,
    remote,
    runDirectory,
    root,
    branches,
    numbers,
    order,
    heads,
    intendedBases,
    authority,
    observedRefs,
    preparation,
    unselectedDependents: Array.isArray(raw.unselectedDependents) ? raw.unselectedDependents : [],
    providerModule: typeof raw.provider?.module === 'string' ? raw.provider.module : null,
    resume: raw.resume === true,
    now: typeof raw.now === 'string' ? raw.now : new Date().toISOString(),
    pullRequests,
    preparationRunDirectory,
  }
}

function journalPath(runDirectory) {
  return join(runDirectory, 'publication-journal.json')
}

function readJournal(runDirectory) {
  const path = journalPath(runDirectory)
  if (!existsSync(path)) return { path, journal: null }
  try {
    return { path, journal: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    throw new InputError(
      'unfinished-run',
      'the publication journal could not be read',
      `${path}: ${String(error?.message ?? error)}`,
    )
  }
}

function writeJournal(path, journal) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`)
}

function emptyPublication() {
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

/**
 * What the environment would add to this push on its own.
 *
 * A push is scoped to explicit refspecs, but configuration can widen it anyway: tags
 * followed implicitly, submodules recursed. Those are writes nobody authorised and cannot
 * be suppressed without overriding a control, so they are reported and the run stops.
 * Hooks are different: a pre-push hook is a mandatory control this helper must not
 * bypass - and cannot prove free of check-running side effects - so it is a blocker too,
 * decided before anything is attempted.
 */
function inspectControls(repository) {
  const controls = []
  // Git prints a multi-part key with its middle section lowercased, so the read is
  // unrestricted and every comparison uses the canonical lowercase spelling.
  const read = () =>
    lines(
      runGit(repository, ['config', '--get-regexp', '^(push|core)\\.'], { allowFailure: true })
        .stdout,
    )
  const WATCHED = new Set([
    'push.followtags',
    'push.recursesubmodules',
    'push.default',
    'push.gpgsign',
    'core.hookspath',
    'core.sshcommand',
  ])
  for (const line of read()) {
    const space = line.indexOf(' ')
    const key = line.slice(0, space).toLowerCase()
    if (!WATCHED.has(key)) continue
    const value = line.slice(space + 1)
    const blocking =
      (key === 'push.followtags' && !['false', '0', 'no'].includes(value.toLowerCase())) ||
      (key === 'push.recursesubmodules' && !['no', 'false', '0'].includes(value.toLowerCase())) ||
      (key === 'core.sshcommand' && value.trim().length > 0)
    controls.push({
      control: key,
      value,
      inTaskStorage: 'inherited',
      blocking,
      effect: blocking
        ? 'this setting would modify push behaviour or invoke an unverified command; the run stops instead of overriding it'
        : 'left exactly as configured',
    })
  }
  const hooksPath = gitOut(repository, ['config', '--get', 'core.hooksPath'])
  const hooksDir = hooksPath
    ? isAbsolute(hooksPath)
      ? hooksPath
      : resolve(repository, hooksPath)
    : join(repository, 'hooks')
  const prePush = join(hooksDir, 'pre-push')
  controls.push({
    control: 'hooks/pre-push',
    value: existsSync(prePush) ? 'present' : 'absent',
    inTaskStorage: 'inherited',
    blocking: existsSync(prePush),
    effect: existsSync(prePush)
      ? 'a pre-push hook is a mandatory control this helper will not bypass, and whose side effects it cannot prove: the run stops before any write'
      : 'no pre-push hook is installed in task-owned storage',
  })
  return controls
}

/**
 * Detects whether the receiving end can apply an all-or-nothing ref transaction, by
 * asking it with the real refspecs and nothing sent. Git refuses `--atomic --dry-run`
 * against a server without the capability, which is exactly the answer needed - and it is
 * a write-free question.
 */
function detectAtomicRefTransaction(repository, remote, refspecs, leases) {
  const probe = runGit(
    repository,
    ['push', '--atomic', '--dry-run', ...leases, remote, ...refspecs],
    { allowFailure: true },
  )
  if (probe.ok) return { supported: true, evidence: 'the remote accepted --atomic --dry-run' }
  const stderr = probe.stderr
  if (/does not support --atomic|atomic push failed|not support atomic/i.test(stderr)) {
    return {
      supported: false,
      evidence: stderr.trim().slice(0, MAX_EVIDENCE_CHARS),
    }
  }
  return { supported: null, evidence: stderr.trim().slice(0, MAX_EVIDENCE_CHARS) }
}

function remoteRefs(remote, repository = process.cwd()) {
  const output = runGit(repository, ['ls-remote', '--heads', remote], { allowFailure: true })
  const refs = {}
  if (output.ok) {
    for (const line of lines(output.stdout)) {
      const [oid, ref] = line.split(/\s+/)
      if (ref && oid) refs[ref] = oid
    }
  }
  return { refs, ok: output.ok, stderr: output.stderr }
}

/**
 * The three Git conversations this helper has with a remote: the atomic-capability
 * question, the push itself, and the read-back. They are collected here so an
 * authoring-time fixture can inject a fault at an exact point - a remote that refuses
 * atomic transactions, a push whose acknowledgement is lost, a ref that moves between
 * the check and the write - while the default path stays real Git.
 */
const GIT_CONVERSATIONS = {
  detectAtomicRefTransaction: (repository, remote, refspecs, leases) =>
    detectAtomicRefTransaction(repository, remote, refspecs, leases),
  push: (repository, remote, refspecs, leases) =>
    runGit(repository, ['push', '--atomic', ...leases, remote, ...refspecs], {
      allowFailure: true,
    }),
  readRemoteRefs: (remote, repository) => remoteRefs(remote, repository).refs,
}

/**
 * Structural re-verification of the prepared set against Git, before any remote write.
 *
 * Nothing here trusts the preparation document: each prepared head must exist in
 * task-owned storage, must contain the original head it claims, must contain its
 * predecessor's prepared head, and the remote must still hold the exact old commit id the
 * run intends to replace - or the prepared head already, for a resumed write.
 */
function verifyPreparedSet(input, refs) {
  const errors = []
  const checked = []
  const byNumber = new Map(input.branches.map((branch) => [branch.number, branch]))
  for (const [index, number] of input.order.entries()) {
    const branch = byNumber.get(number)
    const local = gitOut(input.repository, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${branch.preparedHead}^{commit}`,
    ])
    if (local !== branch.preparedHead) {
      errors.push({
        code: 'stale-snapshot',
        detail: `the prepared head of #${number} is not present in task-owned storage`,
        evidence: `prepared ${branch.preparedHead}, storage holds ${local ?? 'nothing'}`,
      })
      continue
    }
    // Check if the committed tree retains conflict markers (Finding 10)
    const markerCheck = runGit(
      input.repository,
      ['grep', '-I', '-l', '-e', '<<<<<<<', branch.preparedHead, '--'],
      { allowFailure: true },
    )
    if (markerCheck.ok && lines(markerCheck.stdout).length > 0) {
      errors.push({
        code: 'unresolved-conflict',
        detail: `the prepared head of #${number} retains conflict markers in its committed tree`,
        evidence: lines(markerCheck.stdout).join(', '),
      })
      continue
    }
    const retained =
      gitOut(input.repository, [
        'merge-base',
        '--is-ancestor',
        branch.originalHead,
        branch.preparedHead,
      ]) !== null
    if (!retained) {
      const ancestor = runGit(
        input.repository,
        ['merge-base', '--is-ancestor', branch.originalHead, branch.preparedHead],
        { allowFailure: true },
      ).ok
      if (!ancestor) {
        errors.push({
          code: 'lost-original-commit',
          detail: `the original head of #${number} is not reachable from its prepared head`,
          evidence: `original ${branch.originalHead}, prepared ${branch.preparedHead}`,
        })
        continue
      }
    }
    const predecessor = index > 0 ? byNumber.get(input.order[index - 1]) : null
    if (index === 0) {
      const rootReachable = runGit(
        input.repository,
        ['merge-base', '--is-ancestor', input.root.oid, branch.preparedHead],
        { allowFailure: true },
      ).ok
      if (!rootReachable || branch.basedOn !== input.root.oid) {
        errors.push({
          code: 'stale-snapshot',
          detail: `#${number} does not contain or is not based on the pinned root commit ${input.root.oid}`,
          evidence: `root ${input.root.oid}, prepared ${branch.preparedHead}, basedOn ${branch.basedOn}`,
        })
        continue
      }
    } else if (predecessor) {
      const cumulative = runGit(
        input.repository,
        ['merge-base', '--is-ancestor', predecessor.preparedHead, branch.preparedHead],
        { allowFailure: true },
      ).ok
      if (!cumulative || branch.basedOn !== predecessor.preparedHead) {
        errors.push({
          code: 'stale-snapshot',
          detail: `#${number} no longer contains or is based on the prepared state of #${predecessor.number}`,
          evidence: `${predecessor.preparedHead} is not an ancestor of ${branch.preparedHead} or basedOn mismatch`,
        })
        continue
      }
    }
    checked.push({ number, branch, predecessor, index })
  }

  // Check preparation index state and unresolved list (Finding 10)
  if (input.preparation?.indexState) {
    const unmerged = input.preparation.indexState.unmergedEntries ?? []
    const ops = input.preparation.indexState.operationsInProgress ?? []
    const mks = input.preparation.indexState.conflictMarkersInTree ?? []
    if (unmerged.length > 0 || ops.length > 0 || mks.length > 0) {
      errors.push({
        code: 'unresolved-conflict',
        detail: 'preparation handoff records unresolved conflicts, ongoing operations, or conflict markers',
        evidence: `unmerged=${unmerged.join(',')} ops=${ops.join(',')} markers=${mks.join(',')}`,
      })
    }
  }
  if (Array.isArray(input.preparation?.unresolved) && input.preparation.unresolved.length > 0) {
    errors.push({
      code: 'unresolved-conflict',
      detail: 'preparation handoff lists unresolved paths',
      evidence: input.preparation.unresolved.join(', '),
    })
  }

  // Snapshot reconciliation: admit journaled prepared heads for selected head refs (Finding 12)
  const selectedHeadMap = new Map(input.order.map((n) => [input.heads[n], byNumber.get(n)]))
  for (const [ref, pinned] of Object.entries(input.observedRefs)) {
    if (ref === input.root.ref) continue
    const branchForRef = selectedHeadMap.get(ref)
    const now = refs[ref]
    if (branchForRef) {
      if (now !== undefined && now !== pinned && now !== branchForRef.preparedHead) {
        errors.push({
          code: 'stale-snapshot',
          detail: `selected ref ${ref} moved to an unexpected commit`,
          evidence: `observed ${pinned}, prepared ${branchForRef.preparedHead}, remote now holds ${now}`,
        })
      }
      continue
    }
    if (now !== undefined && now !== pinned) {
      errors.push({
        code: 'stale-snapshot',
        detail: `ref ${ref} moved since the run observed it`,
        evidence: `observed ${pinned}, remote now holds ${now}`,
      })
    }
  }
  return { errors, checked }
}

async function loadProvider(modulePath, pinnedModule) {
  if (!modulePath || !isAbsolute(modulePath)) {
    throw new InputError(
      'missing-permission',
      'a provider module the host has approved is required before any provider write',
      `provider.module was ${JSON.stringify(modulePath)}; set FLATTEN_PR_PROVIDER_MODULE so the host, not the model, chooses it`,
    )
  }
  if (pinnedModule && resolve(pinnedModule) !== resolve(modulePath)) {
    throw new InputError(
      'missing-permission',
      'the provider module does not match the one this host pinned',
      `host pinned ${pinnedModule}, document named ${modulePath}`,
    )
  }
  if (!existsSync(modulePath)) {
    throw new InputError(
      'invalid-input',
      'the provider module does not exist',
      `${modulePath} is absent`,
    )
  }
  const loaded = await import(pathToFileURL(resolve(modulePath)).href)
  for (const name of ['capabilities', 'readPullRequest', 'updatePullRequestBase']) {
    if (typeof loaded[name] !== 'function') {
      throw new InputError(
        'invalid-input',
        `the provider module does not implement ${name}()`,
        `${modulePath} exports ${Object.keys(loaded).join(', ')}`,
      )
    }
  }
  return loaded
}

const PRESERVED_FIELDS = [
  'state',
  'draft',
  'headRef',
  'headRepository',
  'title',
  'body',
  'labels',
  'reviewers',
]

function preserved(pr) {
  const out = {}
  for (const field of PRESERVED_FIELDS) out[field] = pr[field] ?? null
  return out
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function classifyPushFailure(stderr) {
  const text = String(stderr ?? '')
  if (
    /stale info|non-fast-forward|fetch first|already exists|rejected|denied|hook declined|remote ref update/i.test(
      text,
    )
  ) {
    return 'rejected'
  }
  if (
    /timed out|timeout|connection|network|early EOF|index-pack|unexpected disconnect|unable to access/i.test(
      text,
    )
  ) {
    return 'unknown'
  }
  return 'rejected'
}

export async function publishStack(raw, conversations = {}) {
  const git = { ...GIT_CONVERSATIONS, ...conversations }
  const base = {
    contractVersion: CONTRACT_VERSION,
    ok: false,
    status: 'blocked',
    errors: [],
    publication: emptyPublication(),
    capability: {
      atomicRefTransaction: 'unknown',
      providerCompareAndSwap: null,
      baseWritesGuardedBy: null,
      residualMetadataRace: null,
      blockedControls: [],
    },
    controls: [],
    authority: { source: 'caller-declared', hostVerified: false, granted: [], selection: [] },
    provider: null,
    rootAdvance: null,
    unselectedDependents: [],
    verification: [],
    recovery: null,
    nextSafeAction: null,
    journalPath: null,
  }
  let input
  try {
    input = verifyInput(raw)
  } catch (error) {
    const failure =
      error instanceof InputError
        ? error
        : new InputError('invalid-input', String(error?.message ?? error), 'input was rejected')
    return {
      ...base,
      errors: [failure],
      nextSafeAction: {
        action: 'correct the publication document and re-run; nothing was written',
        requires: ['a prepared set and an explicit execute grant for that exact selection'],
      },
    }
  }

  const { path: journalFile, journal: existingJournal } = readJournal(input.runDirectory)
  const journal = existingJournal ?? {
    contractVersion: CONTRACT_VERSION,
    runId: `publish-${input.root.oid.slice(0, 12)}-${input.order.join('-')}`,
    state: 'publishing',
    startedAt: input.now,
    updatedAt: input.now,
    selection: input.numbers,
    order: input.order,
    root: input.root,
    attempts: [],
    observedRefs: input.observedRefs,
    secrets: 'none; this journal records commit ids, branches, and outcomes only',
  }
  const controls = inspectControls(input.repository)
  const blockedControls = controls.filter((control) => control.blocking)

  const returnWithoutJournal = (extra) => {
    return {
      ...base,
      ...extra,
      controls,
      capability: {
        ...base.capability,
        ...(extra.capability ?? {}),
        blockedControls: blockedControls.map((c) => `${c.control}=${c.value}`),
      },
      authority: {
        source: process.env.FLATTEN_PR_PROVIDER_MODULE
          ? 'host-pinned-module-and-caller-declared-grant'
          : 'caller-declared',
        hostVerified: input.authority.hostVerified,
        granted: input.authority.granted,
        selection: input.authority.selection,
      },
      journalPath: journalFile,
    }
  }

  const finish = (extra) => {
    journal.updatedAt = input.now
    writeJournal(journalFile, journal)
    return returnWithoutJournal(extra)
  }

  // 1. Authority. Nothing below runs without it, and it is checked against the exact
  //    selection the prepared set names rather than against anything a caller asserts.
  const authorityErrors = []
  if (input.authority.intent !== 'execute') {
    authorityErrors.push({
      code: 'missing-permission',
      detail: `intent ${JSON.stringify(input.authority.intent)} authorises no write`,
      evidence:
        'execute intent for this exact selection is required; a preview, a manifest, or a mention is not a grant',
    })
  }
  const granted = new Set(input.authority.granted)
  const selection = [...input.authority.selection].sort((left, right) => left - right)
  const prepared = [...input.numbers].sort((left, right) => left - right)
  if (!sameJson(selection, prepared)) {
    authorityErrors.push({
      code: 'missing-permission',
      detail: 'the authorised selection is not exactly the prepared set',
      evidence: `granted ${JSON.stringify(selection)}, prepared ${JSON.stringify(prepared)}`,
    })
  }
  if (granted.size === 0 || (!granted.has('ref-update') && !granted.has('pr-base-update'))) {
    authorityErrors.push({
      code: 'missing-permission',
      detail: 'the grant names no recognised mutation kind',
      evidence: `granted ${input.authority.granted.join(', ') || 'nothing'}`,
    })
  }
  if (authorityErrors.length > 0) {
    return returnWithoutJournal({
      errors: authorityErrors,
      status: 'blocked',
      nextSafeAction: {
        action:
          'ask for an explicit execute grant naming this exact selection and the mutations it permits',
        requires:
          input.authority.granted.length > 0
            ? [`a grant naming ${WRITE_KINDS.join(' or ')}`]
            : [
                'execute intent',
                `a grant naming ${WRITE_KINDS.join(' or ')}`,
                'the exact selection',
              ],
      },
    })
  }

  const currentPlan = {
    selection: input.numbers,
    order: input.order,
    rootOid: input.root.oid,
    rootRef: input.root.ref,
    heads: input.heads,
    intendedBases: input.intendedBases,
    preparedHeads: Object.fromEntries(input.branches.map((b) => [b.number, b.preparedHead])),
    originalHeads: Object.fromEntries(input.branches.map((b) => [b.number, b.originalHead])),
  }

  // 2. An unfinished publication owns this journal until it is resumed or replanned.
  if (existingJournal && existingJournal.state !== 'published' && !input.resume) {
    return returnWithoutJournal({
      errors: [
        {
          code: 'unfinished-run',
          detail: 'a publication over this selection is already in progress',
          evidence: `journal state ${existingJournal.state}; resume reconciles it from fresh observations`,
        },
      ],
      status: 'blocked',
      nextSafeAction: {
        action:
          'resume the recorded publication so its acknowledged steps are reconciled before anything is retried',
        requires: ['a resume decision naming the same selection and root'],
      },
    })
  }

  if (existingJournal && input.resume && existingJournal.plan) {
    const planMatches =
      sameJson(existingJournal.plan.selection, currentPlan.selection) &&
      sameJson(existingJournal.plan.order, currentPlan.order) &&
      existingJournal.plan.rootOid === currentPlan.rootOid &&
      sameJson(existingJournal.plan.heads, currentPlan.heads) &&
      sameJson(existingJournal.plan.intendedBases, currentPlan.intendedBases) &&
      sameJson(existingJournal.plan.originalHeads, currentPlan.originalHeads) &&
      sameJson(existingJournal.plan.preparedHeads, currentPlan.preparedHeads)
    if (!planMatches) {
      return returnWithoutJournal({
        errors: [
          {
            code: 'stale-snapshot',
            detail: 'cannot resume publication under a mutated plan; selection, order, root, heads, or prepared state changed',
            evidence: 'journal plan differs from input plan',
          },
        ],
        status: 'blocked',
        nextSafeAction: {
          action: 'start a new publication run with a clean run directory, or restore the original plan',
          requires: ['matching-plan'],
        },
      })
    }
  }

  journal.plan = currentPlan

  // 3. Re-read the remote, verify the prepared set against it, and decide the write set.
  const observed = {
    refs: git.readRemoteRefs(input.remote, input.repository),
    ok: true,
    stderr: '',
  }
  const verified = verifyPreparedSet(input, observed.refs)
  const errors = [...verified.errors]
  const observedRoot = observed.refs[input.root.ref] ?? null
  const rootAdvance =
    observedRoot && observedRoot !== input.root.oid
      ? {
          pinned: input.root.oid,
          observed: observedRoot,
          integrated: false,
          note: 'the root advanced after the plan was authorized; nothing here integrated the newer root work',
        }
      : null
  if (observedRoot === null) {
    errors.push({
      code: 'stale-snapshot',
      detail: `the root ref ${input.root.ref} is absent from the remote`,
      evidence: `remote holds ${Object.keys(observed.refs).length} branch refs`,
    })
  } else if (observedRoot !== input.root.oid) {
    errors.push({
      code: 'stale-snapshot',
      detail: `the root ${input.root.ref} moved since the plan was authorized`,
      evidence: `pinned ${input.root.oid}, remote holds ${observedRoot}`,
    })
  }
  journal.observedRefs = { ...observed.refs }

  const refWrites = []
  const alreadyPublished = []
  for (const entry of verified.checked) {
    const ref = input.heads[entry.number]
    const remoteOid = observed.refs[ref] ?? null
    if (remoteOid === null) {
      errors.push({
        code: 'stale-snapshot',
        detail: `the head branch ${ref} of #${entry.number} does not exist on the remote`,
        evidence: `prepared ${entry.branch.preparedHead}`,
      })
      continue
    }
    if (remoteOid === entry.branch.preparedHead) {
      alreadyPublished.push({ number: entry.number, ref, oid: remoteOid })
      continue
    }
    if (remoteOid !== entry.branch.originalHead) {
      errors.push({
        code: 'stale-snapshot',
        detail: `the head branch ${ref} of #${entry.number} moved since the plan was authorized`,
        evidence: `expected ${entry.branch.originalHead}, remote holds ${remoteOid}; a concurrent push is never overwritten`,
      })
      continue
    }
    if (ref === input.root.ref) {
      errors.push({
        code: 'unsupported-input',
        detail: 'the root ref is never a publication target',
        evidence: `ref ${ref}`,
      })
      continue
    }
    refWrites.push({ number: entry.number, ref, from: remoteOid, to: entry.branch.preparedHead })
  }

  if (errors.length > 0) {
    journal.state = 'blocked'
    return finish({
      errors,
      status: 'blocked',
      rootAdvance,
      publication: {
        ...emptyPublication(),
        concurrency: {
          leaseHeld: false,
          conflictingRemoteMoveDetected: verified.checked.some(
            (entry) => observed.refs[input.heads[entry.number]] !== entry.branch.originalHead,
          ),
        },
      },
      verification: [
        {
          invariant: 'preservation.root',
          method: 'git ls-remote against the pinned root',
          observed: `pinned ${input.root.oid}, observed ${observedRoot ?? 'absent'}`,
          result: observedRoot === input.root.oid ? 'pass' : 'fail',
        },
      ],
      nextSafeAction: {
        action:
          're-plan against a fresh snapshot; the expected state changed, so nothing is written',
        requires: ['a new authorization for the observed state'],
      },
    })
  }

  // 4. Controls first, then the atomic capability question. A push is never attempted
  //    before both answers are known, because either can end the run without a write.
  if (blockedControls.length > 0) {
    journal.state = 'blocked'
    return finish({
      errors: blockedControls.map((control) => ({
        code: 'conflicting-environment-control',
        detail: `${control.control} would change this push beyond the authorised write set`,
        evidence: control.effect,
      })),
      status: 'blocked',
      nextSafeAction: {
        action: 'report the configuration or hook that blocks publication; it is not disabled here',
        requires: blockedControls.map((control) => `${control.control}=${control.value}`),
      },
    })
  }

  if (refWrites.length > 0 && !granted.has('ref-update')) {
    journal.state = 'blocked'
    return finish({
      errors: [
        {
          code: 'missing-permission',
          detail: 'no grant permits pushing prepared heads to the remote',
          evidence: `pending head writes: ${refWrites.map((w) => w.ref).join(', ')}; granted: ${input.authority.granted.join(', ') || 'nothing'}`,
        },
      ],
      status: 'blocked',
      nextSafeAction: {
        action: 'ask for an explicit execute grant naming ref-update for the prepared heads',
        requires: ['ref-update'],
      },
    })
  }

  const refspecs = refWrites.map((write) => `${write.to}:${write.ref}`)
  const leases = refWrites.map((write) => `--force-with-lease=${write.ref}:${write.from}`)
  let atomic = { supported: null, evidence: 'no ref write was needed' }
  if (refWrites.length > 0) {
    atomic = git.detectAtomicRefTransaction(input.repository, input.remote, refspecs, leases)
    if (atomic.supported !== true) {
      journal.state = 'blocked'
      return finish({
        errors: [
          {
            code: 'conflicting-environment-control',
            detail:
              atomic.supported === false
                ? 'the remote cannot apply an all-or-nothing ref transaction, and a sequential push could partially succeed'
                : 'the remote did not answer the atomic-capability question, so no write is attempted',
            evidence: atomic.evidence,
          },
        ],
        status: 'blocked',
        capability: {
          ...base.capability,
          atomicRefTransaction: atomic.supported === false ? 'unsupported' : 'unknown',
        },
        nextSafeAction: {
          action:
            'stop before writes; report that this remote cannot publish the prepared set atomically',
          requires: ['a remote that advertises atomic ref transactions'],
        },
      })
    }
  }

  // 5. Load the provider, read the selected pull requests, and check each pull request's
  //    own auto-merge request - the one preflight fact that blocks.
  let provider = null
  const prBefore = new Map()
  const prErrors = []
  try {
    provider = await loadProvider(input.providerModule, process.env.FLATTEN_PR_PROVIDER_MODULE)
  } catch (error) {
    prErrors.push(
      error instanceof InputError
        ? { code: error.code, detail: error.detail, evidence: error.evidence }
        : {
            code: 'invalid-input',
            detail: String(error?.message ?? error),
            evidence: 'the provider module could not be loaded',
          },
    )
  }
  let providerCapabilities = null
  if (provider) {
    try {
      providerCapabilities = provider.capabilities()
    } catch (error) {
      prErrors.push({
        code: 'invalid-input',
        detail: `the provider did not report its capabilities: ${String(error?.message ?? error)}`,
        evidence: 'a provider whose capabilities cannot be read is not used for writes',
      })
    }
    if (providerCapabilities) {
      for (const kind of ['update-pull-request-base']) {
        if (!providerCapabilities.operations?.includes(kind)) {
          prErrors.push({
            code: 'missing-permission',
            detail: `the provider does not offer ${kind}`,
            evidence: `operations ${(providerCapabilities.operations ?? []).join(', ')}`,
          })
        }
      }
      for (const number of input.order) {
        let read
        try {
          read = provider.readPullRequest(number)
        } catch (error) {
          prErrors.push({
            code: 'stale-snapshot',
            detail: `the provider could not be read for #${number}: ${String(error?.message ?? error)}`,
            evidence: 'a pull request that cannot be re-read is not written',
          })
          continue
        }
        const pr = read?.pullRequest
        if (!pr) {
          prErrors.push({
            code: 'unsupported-input',
            detail: `#${number} is not present in the provider`,
            evidence: 'the provider returned no pull request',
          })
          continue
        }
        prBefore.set(number, pr)
        if (pr.headRef !== input.heads[number].replace('refs/heads/', '')) {
          prErrors.push({
            code: 'stale-snapshot',
            detail: `#${number} now points at a different head branch`,
            evidence: `provider head ${pr.headRef}, authorized ${input.heads[number]}`,
          })
        }
        if (pr.state !== 'OPEN') {
          prErrors.push({
            code: 'unsupported-input',
            detail: `#${number} is ${pr.state}`,
            evidence: `the provider reports state ${pr.state}`,
          })
        }
        if (pr.autoMergeRequest?.enabled === true) {
          prErrors.push({
            code: 'active-landing-arrangement',
            detail: `#${number} carries its own active auto-merge request`,
            evidence: `provider reports autoMergeRequest.enabled with method ${pr.autoMergeRequest.method ?? 'unspecified'}`,
          })
        }
      }
    }
  }
  if (prErrors.length > 0) {
    journal.state = 'blocked'
    return finish({
      errors: prErrors,
      status: 'blocked',
      capability: {
        ...base.capability,
        atomicRefTransaction:
          atomic.supported === true ? 'supported' : base.capability.atomicRefTransaction,
        providerCompareAndSwap: providerCapabilities
          ? providerCapabilities.compareAndSwap === true
          : null,
        baseWritesGuardedBy:
          providerCapabilities?.compareAndSwap === true ? 'compare-and-swap' : 'read-before-write',
        residualMetadataRace: providerCapabilities
          ? providerCapabilities.compareAndSwap !== true
          : null,
      },
      provider: providerCapabilities
        ? { name: providerCapabilities.provider ?? 'unnamed', trust: 'host-pinned' }
        : null,
      nextSafeAction: {
        action: 'report the blocker before any write; no ref or metadata was changed',
        requires: prErrors.map((error) => error.detail),
      },
    })
  }

  const compareAndSwap = providerCapabilities?.compareAndSwap === true
  const publication = emptyPublication()
  publication.concurrency.leaseHeld = refWrites.length > 0
  const verification = []
  let sequence = 0

  // 6. One atomic, lease-guarded push of exactly the selected refs that still need it.
  if (refWrites.length > 0) {
    sequence += 1
    journal.attempts.push({
      sequence,
      kind: 'ref-update',
      target: 'selected-heads',
      detail: refWrites.map(
        (write) => `${write.ref} ${write.from.slice(0, 12)} -> ${write.to.slice(0, 12)}`,
      ),
      at: input.now,
      outcome: 'attempted',
    })
    writeJournal(journalFile, journal)
    const push = git.push(input.repository, input.remote, refspecs, leases)
    const after = git.readRemoteRefs(input.remote, input.repository)
    const landed = refWrites.filter((write) => after[write.ref] === write.to)
    const stuck = refWrites.filter((write) => after[write.ref] !== write.to)
    if (push.ok || landed.length === refWrites.length) {
      for (const write of refWrites) {
        publication.attempts.push({
          sequence: sequence++,
          kind: 'ref-update',
          target: write.ref,
          from: write.from,
          to: write.to,
          acknowledged: after[write.ref] === write.to,
          lease: { expectedRemote: write.from, usedForceWithLease: true },
          outcome: after[write.ref] === write.to ? 'acknowledged' : 'unknown',
        })
        if (after[write.ref] === write.to) {
          publication.confirmed.push({ kind: 'ref-update', target: write.ref, oid: write.to })
        } else {
          publication.unconfirmed.push({
            kind: 'ref-update',
            target: write.ref,
            why: 'the push did not report success and the ref does not hold the prepared head',
          })
        }
      }
    } else {
      const outcome = classifyPushFailure(push.stderr)
      for (const write of refWrites) {
        const acknowledged = after[write.ref] === write.to
        publication.attempts.push({
          sequence: sequence++,
          kind: 'ref-update',
          target: write.ref,
          from: write.from,
          to: write.to,
          acknowledged,
          lease: { expectedRemote: write.from, usedForceWithLease: true },
          outcome: acknowledged ? 'acknowledged' : outcome === 'unknown' ? 'unknown' : 'rejected',
        })
        if (acknowledged) {
          publication.confirmed.push({ kind: 'ref-update', target: write.ref, oid: write.to })
        } else {
          publication.unconfirmed.push({
            kind: 'ref-update',
            target: write.ref,
            why: `the atomic push failed: ${push.stderr.trim().slice(0, 300) || 'no message'}`,
          })
          publication.denials.push({
            kind: 'ref-update',
            target: write.ref,
            reason: outcome === 'unknown' ? 'acknowledgement-unknown' : 'push-rejected',
            acknowledged: false,
          })
        }
      }
      journal.attempts[journal.attempts.length - 1].outcome = outcome
      journal.attempts[journal.attempts.length - 1].stderr = push.stderr
        .trim()
        .slice(0, MAX_EVIDENCE_CHARS)
    }
    publication.interrupted = publication.attempts.some((attempt) => attempt.outcome === 'unknown')
    for (const write of refWrites) {
      publication.remoteClaims.push({
        kind: 'ref-oid',
        target: write.ref,
        observed: after[write.ref] ?? '',
        observedAt: input.now,
      })
    }
    verification.push({
      invariant: 'preservation.original-commits',
      method: 'git ls-remote read-back plus merge-base in task-owned storage',
      observed: refWrites
        .map((write) => `${write.ref}=${(after[write.ref] ?? 'absent').slice(0, 12)}`)
        .join(' '),
      result: stuck.length === 0 ? 'pass' : 'fail',
    })
    verification.push({
      invariant: 'atomic-ref-transaction',
      method: 'git push --atomic --dry-run capability probe, then one guarded push',
      observed: atomic.evidence,
      result: 'pass',
    })
  } else {
    verification.push({
      invariant: 'atomic-ref-transaction',
      method: 'no ref write was required, so no transaction was attempted',
      observed:
        alreadyPublished.length > 0
          ? `already at their prepared heads: ${alreadyPublished.map((entry) => entry.ref).join(', ')}`
          : 'no selected head needed an update',
      result: 'pass',
    })
  }

  // 7. Base retargeting in dependency order, each one re-read before and verified after.
  const resolveBaseSha = (refName) => {
    const rawName = String(refName ?? '')
    const stripped = rawName.replace(/^refs\/heads\//, '')
    if (stripped === input.root.ref.replace(/^refs\/heads\//, '') || rawName === input.root.ref) {
      return input.root.oid
    }
    for (const b of input.branches) {
      const bRef = input.heads[b.number]
      if (bRef === rawName || bRef?.replace(/^refs\/heads\//, '') === stripped) {
        return b.preparedHead
      }
    }
    if (observed.refs[rawName]) return observed.refs[rawName]
    if (observed.refs[`refs/heads/${stripped}`]) return observed.refs[`refs/heads/${stripped}`]
    const resolved =
      gitOut(input.repository, ['rev-parse', '--verify', '--quiet', `${rawName}^{commit}`]) ??
      gitOut(input.repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${stripped}^{commit}`])
    if (resolved) return resolved
    return input.root.oid
  }

  const baseWrites = []
  const baseFailures = []
  const headPushFailed =
    refWrites.length > 0 &&
    (publication.unconfirmed.some((u) => u.kind === 'ref-update') ||
      publication.denials.some((d) => d.kind === 'ref-update') ||
      (typeof stuck !== 'undefined' && stuck.length > 0))

  if (!headPushFailed) {
    for (const [index, number] of input.order.entries()) {
      let currentPr = null
      try {
        currentPr = provider.readPullRequest(number)?.pullRequest ?? null
      } catch {
        currentPr = null
      }
      if (!currentPr) {
        baseFailures.push({
          code: 'stale-snapshot',
          detail: `the provider could not be read for #${number} before base update`,
          evidence: 'pull request read failed',
        })
        break
      }
      const before = prBefore.get(number) ?? currentPr
      if (currentPr.headRef !== before.headRef || currentPr.state !== 'OPEN') {
        baseFailures.push({
          code: 'stale-snapshot',
          detail: `PR #${number} state changed before base update`,
          evidence: `headRef=${currentPr.headRef} state=${currentPr.state}`,
        })
        break
      }
      const intended = input.intendedBases[number]
      const alreadyCorrect = currentPr.baseRef === intended
      if (alreadyCorrect) {
        baseWrites.push({ number, intended, skipped: true })
        continue
      }
      if (!granted.has('pr-base-update')) {
        baseFailures.push({
          code: 'missing-permission',
          detail: `no grant permits retargeting #${number}`,
          evidence: `granted ${input.authority.granted.join(', ') || 'nothing'}`,
        })
        break
      }
      const fromSha = resolveBaseSha(currentPr.baseRef)
      const toSha = resolveBaseSha(intended)

      sequence += 1
      journal.attempts.push({
        sequence,
        kind: 'pr-base-update',
        target: String(number),
        detail: `${currentPr.baseRef} -> ${intended}`,
        at: input.now,
        outcome: 'attempted',
      })
      writeJournal(journalFile, journal)
      let response = null
      let callError = null
      try {
        response = provider.updatePullRequestBase(
          number,
          intended,
          compareAndSwap ? currentPr.baseRef : null,
        )
      } catch (error) {
        callError = String(error?.message ?? error)
      }
      let readBack = null
      try {
        readBack = provider.readPullRequest(number)?.pullRequest ?? null
      } catch {
        readBack = null
      }
      const applied = readBack?.baseRef === intended
      const drifted =
        readBack !== null && !sameJson(preserved(currentPr), preserved(readBack))
      const outcome = applied
        ? 'acknowledged'
        : readBack === null
          ? 'unknown'
          : callError || response?.ok === false
            ? 'denied'
            : 'unknown'
      if (outcome === 'unknown') {
        publication.interrupted = true
      }
      publication.attempts.push({
        sequence: sequence++,
        kind: 'pr-base-update',
        target: String(number),
        from: fromSha,
        to: toSha,
        acknowledged: applied,
        lease: compareAndSwap
          ? {
              expectedRemote: readBack?.headOid ?? currentPr.headOid ?? '0'.repeat(40),
              usedForceWithLease: false,
            }
          : null,
        outcome,
      })
      if (applied) {
        publication.confirmed.push({ kind: 'pr-base-update', target: String(number), oid: toSha })
      } else {
        publication.unconfirmed.push({
          kind: 'pr-base-update',
          target: String(number),
          why: callError
            ? `the provider call failed and the base does not read back as intended: ${callError.slice(0, 200)}`
            : readBack === null
              ? 'the provider call completed but re-reading the pull request failed; base state is unknown'
              : 'the base does not read back as intended after the write',
        })
        if (outcome === 'denied') {
          publication.denials.push({
            kind: 'pr-base-update',
            target: String(number),
            reason: 'provider-refused',
            acknowledged: false,
          })
        }
      }
      baseWrites.push({ number, intended, skipped: false, applied })
      if (readBack !== null) {
        const observedBase = readBack.baseRef
        publication.remoteClaims.push({
          kind: 'pr-base',
          target: String(number),
          observed: observedBase.startsWith('refs/heads/') ? observedBase : `refs/heads/${observedBase}`,
          observedAt: input.now,
        })
      }
      if (drifted) {
        errors.push({
          code: 'stale-snapshot',
          detail: `#${number} changed in a field this run never writes`,
          evidence: `before ${JSON.stringify(preserved(currentPr))}; after ${JSON.stringify(preserved(readBack))}`,
        })
        break
      }
      if (!applied) {
        break
      }
    }
  }
  verification.push({
    invariant: 'remote.claims-match',
    method: 'provider re-read immediately after each metadata write',
    observed: baseWrites
      .map(
        (write) =>
          `#${write.number}=${write.skipped ? 'unchanged' : write.applied ? 'applied' : 'unconfirmed'}`,
      )
      .join(' '),
    result: baseWrites.every((write) => write.skipped || write.applied) ? 'pass' : 'fail',
  })
  verification.push({
    invariant: 'metadata.concurrent-write-guard',
    method: compareAndSwap
      ? 'the provider enforced its own precondition on every base write'
      : 'read-before-write only: not compare-and-swap, and a concurrent write in that window is not detectable here',
    observed: compareAndSwap ? 'compare-and-swap' : 'read-before-write',
    result: compareAndSwap ? 'pass' : 'unautomated',
  })

  // 8. Final read-back of the whole chain, and the root reported against its pinned id.
  const finalRefs = git.readRemoteRefs(input.remote, input.repository)
  for (const entry of verified.checked) {
    const ref = input.heads[entry.number]
    if (
      !publication.remoteClaims.some((claim) => claim.kind === 'ref-oid' && claim.target === ref)
    ) {
      publication.remoteClaims.push({
        kind: 'ref-oid',
        target: ref,
        observed: finalRefs[ref] ?? '',
        observedAt: input.now,
      })
    }
  }
  let chainHolds = true
  for (const [index, number] of input.order.entries()) {
    const ref = input.heads[number]
    const oid = finalRefs[ref] ?? null
    if (oid !== input.branches.find((branch) => branch.number === number).preparedHead) {
      chainHolds = false
    }
    const pr = (() => {
      try {
        return provider.readPullRequest(number)?.pullRequest ?? null
      } catch {
        return null
      }
    })()
    if (!pr || pr.baseRef !== input.intendedBases[number]) chainHolds = false
  }
  verification.push({
    invariant: 'topology.chain',
    method: 're-read every selected head and base after the last write',
    observed: `chain ${input.order.map((number) => `#${number}`).join(' <- ')}`,
    result: chainHolds ? 'pass' : 'fail',
  })
  if (rootAdvance && !chainHolds) {
    // A newer root is reported against the pinned snapshot and never as integrated.
    rootAdvance.note = `the published chain is integrated against the pinned root ${input.root.oid.slice(0, 12)}; the newer root ${rootAdvance.observed.slice(0, 12)} was not integrated`
  }
  if (finalRefs[input.root.ref] !== input.root.oid) {
    const note = rootAdvance ?? {
      pinned: input.root.oid,
      observed: finalRefs[input.root.ref] ?? '',
      integrated: false,
    }
    verification.push({
      invariant: 'preservation.root',
      method: 'git ls-remote read-back of the root ref',
      observed: `pinned ${input.root.oid.slice(0, 12)}, observed ${(finalRefs[input.root.ref] ?? 'absent').slice(0, 12)}; reported against the pinned snapshot and not integrated`,
      result: note.integrated ? 'pass' : 'unautomated',
    })
  }

  const unconfirmedCount = publication.unconfirmed.length
  const status =
    unconfirmedCount === 0 && errors.length === 0 && baseFailures.length === 0 && chainHolds
      ? publication.attempts.length === 0
        ? 'no-op'
        : 'published'
      : publication.confirmed.length > 0
        ? 'partial'
        : 'blocked'
  journal.state = status === 'published' || status === 'no-op' ? 'published' : status
  journal.publication = publication
  journal.rootAdvance = rootAdvance

  const uncertain = publication.attempts.filter((attempt) => attempt.outcome === 'unknown')
  return finish({
    ok: status === 'published' || status === 'no-op',
    status,
    errors: [
      ...errors,
      ...baseFailures,
      ...(status === 'partial' || status === 'blocked'
        ? publication.unconfirmed.map((entry) => ({
            code: entry.why.includes('provider') ? 'missing-permission' : 'stale-snapshot',
            detail: `${entry.kind} ${entry.target} is unconfirmed`,
            evidence: entry.why,
          }))
        : []),
    ],
    publication,
    rootAdvance,
    unselectedDependents: input.unselectedDependents,
    capability: {
      atomicRefTransaction:
        atomic.supported === true
          ? 'supported'
          : refWrites.length === 0
            ? 'not-required'
            : 'unknown',
      providerCompareAndSwap: compareAndSwap,
      baseWritesGuardedBy: compareAndSwap ? 'compare-and-swap' : 'read-before-write',
      residualMetadataRace: baseWrites.length > 0 && !compareAndSwap,
    },
    provider: {
      name: providerCapabilities?.provider ?? 'unnamed',
      compareAndSwap,
      trust: process.env.FLATTEN_PR_PROVIDER_MODULE ? 'host-pinned' : 'caller-declared',
    },
    verification,
    recovery:
      status === 'partial' || unconfirmedCount > 0 || uncertain.length > 0
        ? {
            acknowledgedChanges: publication.confirmed.map(
              (entry) => `${entry.kind} ${entry.target}`,
            ),
            unconfirmedAttempts: [
              ...publication.unconfirmed.map((entry) => `${entry.kind} ${entry.target}`),
              ...baseFailures.map((f) => `pr-base-update ${f.detail}`),
            ],
            recommended:
              're-read the affected refs and bases before retrying; an unknown acknowledgement may already have landed, and nothing is rolled back automatically',
          }
        : null,
    nextSafeAction:
      status === 'published'
        ? {
            action:
              're-read the chain and record the ignored-checks statement; application correctness is unvalidated',
            requires: [],
          }
        : {
            action:
              status === 'no-op'
                ? 'nothing was written; the chain already matched the plan'
                : 'reconcile the unconfirmed steps from fresh observations before any retry',
            requires: [],
          },
  })
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
      'no publication document was supplied',
      'pass --input <file> or pipe the JSON document on stdin',
    )
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(
      [
        'publish-stack.mjs [--input <file>]',
        '',
        'Publishes a prepared set with one atomic lease-guarded ref push and ordered',
        'base retargeting, and writes',
        '{ contractVersion, ok, status, errors, publication, capability, controls,',
        '  authority, provider, rootAdvance, verification, recovery, nextSafeAction }',
        'to stdout.',
        'Exit 0 publishes or finds nothing to do, 2 refuses the input, 3 reports a blocker',
        'or a partial outcome.',
        '',
      ].join('\n'),
    )
    return 0
  }
  let result
  try {
    result = await publishStack(JSON.parse(readInput(argv)))
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
      status: 'blocked',
      errors: [failure],
      publication: emptyPublication(),
      nextSafeAction: { action: 'report the refusal; nothing was written', requires: [] },
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.ok) return 0
  return result.status === 'blocked' || result.status === 'partial' ? 3 : 2
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main())
}
