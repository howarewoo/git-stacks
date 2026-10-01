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
 * operation object per call; it must not print anything else to stdout. Every operation
 * may be synchronous or return a promise - the helper awaits all of them, so a promise is
 * the general case and a plain value is simply already resolved. Three operations, and
 * nothing else is ever requested:
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
 * `pullRequests` is not optional. It is the authorized snapshot of the selected pull
 * requests - number, state, draft, headRef, headRepository, baseRef, headRefOid,
 * baseRefOid, title, body, labels, reviewers, autoMergeRequest - and every one of those
 * fields is compared against the freshest read, because a fork pull request with the same
 * branch name, a base somebody else already moved, and a title edited mid-run are all
 * things this document does not claim to publish. A document missing one of the selected
 * entries is refused before any remote conversation. `remote` may be a remote name; it is
 * resolved to exactly one push endpoint in task-owned storage, and reads and writes then
 * use that one endpoint.
 *
 * `preparationRunDirectory` is required, not optional. It names the task-owned run that
 * produced the manifest, and the run reads it: the journal must exist, name this
 * contract, record a *complete* preparation of exactly this selection, order, root, heads,
 * and prepared commits, and still own a workspace per selected pull request with no
 * unmerged entry, operation, or committed conflict marker. An absent run directory used to
 * mean "skip the local integrity checks and publish"; it now means the run does not start.
 *
 * Output JSON on stdout: `{ contractVersion, ok, status, errors, publication, capability,
 * controls, authority, provider, rootAdvance, unselectedDependents, verification,
 * recovery, nextSafeAction, journalPath }`, where `publication` is the contract's
 * `publication` document.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { executableControls } from './git-controls.mjs'

const CONTRACT_VERSION = 'flatten-pr-graph/1'
const GIT_TIMEOUT_MS = 300_000
const MAX_EVIDENCE_CHARS = 4_000
const WRITE_KINDS = ['ref-update', 'pr-base-update']
/**
 * Transports this helper will drive. A remote helper (`ext::`, `git-remote-<name>`) or
 * a wrapper command executes a program before any authorization question is asked, so it
 * is refused by name rather than discovered by running it.
 */
const PERMITTED_PUSH_SCHEMES = new Set(['file', 'ssh', 'https', 'http', 'git'])

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

function runGit(cwd, args, { allowFailure = false, env = sanitizedEnv() } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1034,
      env,
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

/**
 * Which transports this run will actually use, so a control that only one of them can
 * reach is reported against the right one. A bare path and a `file://` URL are Git's own
 * shorthand for local transport and never open an ssh connection or ask for a credential.
 */
function endpointTransports(...endpoints) {
  const transports = new Set()
  for (const endpoint of endpoints) transports.add(transportOf(endpoint))
  return transports
}

/**
 * Which transport a URL will be reached over.
 *
 * Git accepts two shapes with no `://`: a path, and the scp-like `[user@]host:path`. They
 * are not the same thing - the second opens an ssh connection, resolves a host name, and
 * runs whatever `core.sshCommand` or `GIT_SSH_COMMAND` names - and reading the second as a
 * local path is how an ssh checking wrapper gets to run while every control reads it as
 * file transport. The two are told apart the way Git tells them apart: a colon before the
 * first slash, and not a Windows drive letter.
 */
function transportOf(url) {
  if (typeof url !== 'string' || url === '') return 'unknown'
  if (url.includes('::')) return 'ext'
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)
  if (scheme) return scheme[1].toLowerCase()
  const scp = /^([^/]+):([^/].*)$/.exec(url)
  if (scp && !/^[A-Za-z]:/.test(url)) return 'ssh'
  return url.startsWith('/') || url.startsWith('.') || url === '' ? 'file' : 'file'
}

function requireRemote(value, where) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\n]/.test(value)) {
    throw new InputError(
      'invalid-input',
      `${where} must be a remote name or path`,
      `received ${JSON.stringify(value)}`,
    )
  }
  // `ext::` and any other helper transport run an arbitrary program as part of merely
  // addressing the remote, so it is refused before discovery rather than found out
  // during it. A bare name or `/path` is Git's own shorthand for file transport.
  if (value.includes('::')) {
    throw new InputError(
      'conflicting-environment-control',
      `${where} specifies a remote-helper transport, which executes a program this helper will not run`,
      value,
    )
  }
  const transport = transportOf(value)
  if (transport === 'ext' || !PERMITTED_PUSH_SCHEMES.has(transport)) {
    throw new InputError(
      'conflicting-environment-control',
      `${where} uses the unsupported transport ${transport}`,
      value,
    )
  }
  return value
}

/**
 * One push destination, resolved once and used for every read and every write.
 *
 * `remote` may be a configured remote name or a path. A name is resolved through task
 * storage's own configuration, because that is where the push will run: `remote.url`
 * for a plain path or transport, `remote.pushurl` when it is set, and every configured
 * push URL must agree. Several destinations are a blocker - a push that fans out to
 * multiple remotes is not one atomic transaction, and reads run somewhere else again.
 */
function resolvePushEndpoint(repository, remote) {
  const configured = runGit(repository, ['remote', 'get-url', '--all', '--push', remote], {
    allowFailure: true,
  })
  if (!configured.ok) {
    // No configured remote of that name, so the value is addressed directly. Git then
    // treats it as a path or a URL, and a local path has to exist: accepting a name that
    // names nothing defers the failure to the first push, by which point the run has
    // already reported a snapshot mismatch instead of the destination it never had.
    const endpoint = effectiveUrl(repository, remote)
    if (transportOf(endpoint) === 'file' && !existsSync(endpoint)) {
      throw new InputError(
        'conflicting-environment-control',
        `remote ${remote} is neither a configured remote nor a destination that exists`,
        endpoint,
      )
    }
    return { endpoint, evidence: `${remote} is addressed directly` }
  }
  const urls = lines(configured.stdout)
  if (urls.length === 0) {
    throw new InputError(
      'invalid-input',
      `remote ${remote} has no push url`,
      'git remote get-url --all --push returned nothing',
    )
  }
  if (urls.length > 1) {
    throw new InputError(
      'conflicting-environment-control',
      `remote ${remote} has more than one push destination, so no single atomic transaction covers it`,
      urls.join(', '),
    )
  }
  const url = urls[0]
  if (url.includes('::')) {
    throw new InputError(
      'conflicting-environment-control',
      `remote ${remote} resolves to a remote-helper transport, which executes a program this helper will not run`,
      url,
    )
  }
  return { endpoint: effectiveUrl(repository, url), evidence: `one push destination: ${url}` }
}

/**
 * The URL Git will actually use, which is not always the one that was written down.
 *
 * `url.<base>.insteadOf` and `url.<base>.pushInsteadOf` rewrite a remote before any
 * connection is attempted, so a string that looks like a local path can become an ssh URL
 * and a string that looks like ssh can become something else entirely. Classifying the
 * transport of the written form would classify a URL that is never contacted.
 * `git ls-remote --get-url` performs exactly the rewrite Git performs and opens no
 * connection, so this is Git's own answer rather than a reimplementation of its rules.
 */
function effectiveUrl(repository, url) {
  const resolved = runGit(repository, ['ls-remote', '--get-url', url], { allowFailure: true })
  if (!resolved.ok) {
    throw new InputError(
      'conflicting-environment-control',
      `the effective destination for ${url} could not be resolved, so its transport is unknown`,
      (resolved.stderr || resolved.stdout).trim().slice(0, 200) || `git ls-remote --get-url exited ${resolved.status}`,
    )
  }
  return lines(resolved.stdout)[0] ?? url
}

function verifyInput(raw) {
  const repository = requireExistingDirectory(raw.repository, 'repository')
  const remote = requireRemote(raw.remote, 'remote')
  const pushEndpoint = resolvePushEndpoint(repository, remote)
  // The transport that matters is the one of the URL Git will actually use, which a
  // configured `insteadOf` rewrite can change after the written form was checked.
  const resolvedTransport = transportOf(pushEndpoint.endpoint)
  if (resolvedTransport === 'ext' || !PERMITTED_PUSH_SCHEMES.has(resolvedTransport)) {
    throw new InputError(
      'conflicting-environment-control',
      `remote ${remote} resolves to the unsupported transport ${resolvedTransport}`,
      pushEndpoint.endpoint,
    )
  }
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
      if (!pinned) continue
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
      // Every field this run treats as admissible is pinned here, not only the three it
      // compares today: identity, base, auto-merge, and the fields a base retarget must
      // not disturb. A snapshot that cannot be compared cannot protect the write.
      pullRequests[number] = {
        number,
        state: typeof pinned.state === 'string' ? pinned.state : null,
        draft: typeof pinned.draft === 'boolean' ? pinned.draft : null,
        headRef: pinned.headRef,
        headRepository: pinned.headRepository,
        baseRef: pinned.baseRef,
        headRefOid: typeof pinned.headRefOid === 'string' ? pinned.headRefOid : null,
        baseRefOid: typeof pinned.baseRefOid === 'string' ? pinned.baseRefOid : null,
        title: typeof pinned.title === 'string' ? pinned.title : null,
        body: typeof pinned.body === 'string' ? pinned.body : null,
        labels: Array.isArray(pinned.labels) ? pinned.labels.map(String) : null,
        reviewers: Array.isArray(pinned.reviewers) ? pinned.reviewers.map(String) : null,
        autoMergeRequest: isPlainObject(pinned.autoMergeRequest)
          ? {
              enabled: pinned.autoMergeRequest.enabled === true,
              method:
                typeof pinned.autoMergeRequest.method === 'string'
                  ? pinned.autoMergeRequest.method
                  : null,
            }
          : null,
      }
    }
  }
  const missingPinned = numbers.filter((number) => !pullRequests[number])
  if (missingPinned.length > 0) {
    throw new InputError(
      'invalid-input',
      `the authorized snapshot names no pullRequests entry for ${missingPinned.map((n) => `#${n}`).join(', ')}`,
      'a publication that cannot compare the selected pull requests against a pinned snapshot is refused',
    )
  }
  // Required, not optional. The manifest is a claim; the task-owned run directory that
  // produced it is the evidence, and without it there is nothing to inspect for unmerged
  // entries, an operation in progress, or a committed conflict marker. An absent
  // `preparationRunDirectory` used to mean "skip the local integrity checks and publish",
  // which is exactly the claim this helper must never make.
  if (
    typeof raw.preparationRunDirectory !== 'string' ||
    !isAbsolute(raw.preparationRunDirectory) ||
    !existsSync(raw.preparationRunDirectory)
  ) {
    throw new InputError(
      'invalid-input',
      'preparationRunDirectory must name the existing task-owned run directory that produced this manifest',
      `received ${JSON.stringify(raw.preparationRunDirectory)}`,
    )
  }
  const preparationRunDirectory = resolve(raw.preparationRunDirectory)
  return {
    repository,
    remote,
    pushEndpoint,
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
  // unrestricted and every comparison uses the canonical lowercase spelling. A read that
  // fails is not the absence of a control: `git config --get-regexp` exits 1 for "no
  // match" and something else for "could not be read", and only the first is an answer.
  const read = () => {
    const result = runGit(repository, ['config', '--get-regexp', '^(push|core)\\.'], {
      allowFailure: true,
    })
    if (!result.ok && result.status !== 1) {
      controls.push({
        control: 'config.read',
        value: result.stderr.trim().slice(0, 200) || `git config exited ${result.status}`,
        inTaskStorage: 'inherited',
        blocking: true,
        effect:
          'the Git configuration that could widen this push could not be read, so its absence cannot be claimed',
      })
      return []
    }
    return lines(result.stdout)
  }
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
  // Git resolves a relative `core.hooksPath` against the repository, not against the
  // directory the caller happens to be in, and a push from task storage runs its hooks
  // there. Asking Git is the only answer that matches what the push will do.
  const resolvedHooks = gitOut(repository, ['rev-parse', '--git-path', 'hooks'])
  const hooksDir = resolvedHooks
    ? isAbsolute(resolvedHooks)
      ? resolvedHooks
      : resolve(repository, resolvedHooks)
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

function remoteRefs(repository, endpoint) {
  const output = runGit(repository, ['ls-remote', '--heads', endpoint], { allowFailure: true })
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
  readRemoteRefs: (repository, endpoint) => remoteRefs(repository, endpoint).refs,
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
  const isAncestor = (ancestor, descendant) =>
    runGit(input.repository, ['merge-base', '--is-ancestor', ancestor, descendant], {
      allowFailure: true,
    }).ok
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
    // A committed tree can hold conflict markers and still be a valid object, so ancestry
    // checks alone would accept a resolution that was never finished.
    const markerCheck = runGit(
      input.repository,
      ['grep', '-I', '-l', '-e', '<<<<<<<', branch.preparedHead, '--'],
      { allowFailure: true },
    )
    if (lines(markerCheck.stdout).length > 0) {
      errors.push({
        code: 'unresolved-conflict',
        detail: `the prepared head of #${number} retains conflict markers in its committed tree`,
        evidence: lines(markerCheck.stdout).join(', '),
      })
      continue
    }
    if (!isAncestor(branch.originalHead, branch.preparedHead)) {
      errors.push({
        code: 'lost-original-commit',
        detail: `the original head of #${number} is not reachable from its prepared head`,
        evidence: `original ${branch.originalHead}, prepared ${branch.preparedHead}`,
      })
      continue
    }
    // The first position has no predecessor in the order, so its predecessor is the pinned
    // root. Checking only the recorded `basedOn` would accept a head that names the right
    // parent and descends from the wrong history.
    const predecessor = index > 0 ? byNumber.get(input.order[index - 1]) : null
    const expectedBase = predecessor ? predecessor.preparedHead : input.root.oid
    if (branch.basedOn !== expectedBase || !isAncestor(expectedBase, branch.preparedHead)) {
      errors.push({
        code: 'stale-snapshot',
        detail: predecessor
          ? `#${number} no longer contains or is based on the prepared state of #${predecessor.number}`
          : `#${number} does not contain or is not based on the pinned root commit ${input.root.oid}`,
        evidence: `expected base ${expectedBase}, prepared ${branch.preparedHead}, basedOn ${branch.basedOn}`,
      })
      continue
    }
    checked.push({ number, branch, predecessor, index })
  }

  // The handoff's own integrity fields are a claim. The task-owned workspaces that back
  // them are the evidence, and `verifyPreparationHandoff` has already read both this
  // journal and those workspaces before this function ran.
  const indexState = input.preparation?.indexState
  if (isPlainObject(indexState)) {
    const unmerged = indexState.unmergedEntries ?? []
    const ops = indexState.operationsInProgress ?? []
    const markers = indexState.conflictMarkersInTree ?? []
    if (unmerged.length > 0 || ops.length > 0 || markers.length > 0) {
      errors.push({
        code: 'unresolved-conflict',
        detail:
          'the preparation handoff records unresolved index entries, operations, or conflict markers',
        evidence: `unmerged=${unmerged.join(',')} ops=${ops.join(',')} markers=${markers.join(',')}`,
      })
    }
  }
  if (Array.isArray(input.preparation?.unresolved) && input.preparation.unresolved.length > 0) {
    errors.push({
      code: 'unresolved-conflict',
      detail: 'the preparation handoff lists unresolved paths',
      evidence: input.preparation.unresolved.join(', '),
    })
  }
  // Snapshot reconciliation. A selected head may legitimately hold this run's own prepared
  // commit (a lost acknowledgement, or a rerun of an accepted push), so those refs are
  // checked against the journaled original or prepared value instead of equality with the
  // snapshot. Every other ref is compared exactly, and a ref that appeared since the
  // snapshot is as unauthorised as one that moved.
  const selectedHeadMap = new Map(input.order.map((n) => [input.heads[n], byNumber.get(n)]))
  for (const [ref, pinned] of Object.entries(input.observedRefs)) {
    if (ref === input.root.ref) continue
    const branchForRef = selectedHeadMap.get(ref)
    const now = refs[ref]
    if (branchForRef) {
      // A snapshot value for a selected head is admissible only in one of two states: the
      // original commit this plan was authorized against, or this run's own prepared
      // commit, which is what a lost acknowledgement or an accepted rerun leaves behind.
      // Anything else means the caller is asking this run to adopt a change it never
      // authorized, and having read it back is not the same as having authorized it.
      if (pinned !== branchForRef.originalHead && pinned !== branchForRef.preparedHead) {
        errors.push({
          code: 'stale-snapshot',
          detail: `the recorded observation of selected ref ${ref} is not a state this plan may publish from`,
          evidence: `observed ${pinned}, which is neither the original head ${branchForRef.originalHead} nor the prepared head ${branchForRef.preparedHead}`,
        })
        continue
      }
      if (now !== undefined && now !== pinned && now !== branchForRef.preparedHead) {
        errors.push({
          code: 'stale-snapshot',
          detail: `selected ref ${ref} moved to an unexpected commit`,
          evidence: `observed ${pinned}, prepared ${branchForRef.preparedHead}, remote now holds ${now}`,
        })
      }
      continue
    }
    if (now !== pinned) {
      errors.push({
        code: 'stale-snapshot',
        detail: `ref ${ref} moved since the run observed it`,
        evidence: `observed ${pinned ?? 'absent'}, remote now holds ${now ?? 'absent'}`,
      })
    }
  }
  return { errors, checked }
}

/**
 * The preparation run this manifest came from, read before anything is written.
 *
 * A manifest handed over on its own is a claim; the task-owned run directory that produced
 * it is the evidence. This binds the two together: the journal must exist, name this
 * contract, record a *complete* preparation of exactly this plan, and still own a
 * workspace per selected pull request. Anything else is a blocker, because the alternative
 * is publishing a set whose unresolved state nobody has actually looked at.
 */
function verifyPreparationHandoff(input, plan) {
  const errors = []
  const journalFile = join(input.preparationRunDirectory, 'journal.json')
  if (!existsSync(journalFile)) {
    errors.push({
      code: 'stale-snapshot',
      detail: 'the identified preparation run directory holds no preparation journal',
      evidence: `${journalFile} is absent; the manifest's local integrity was never recorded`,
    })
    return { errors }
  }
  let journal = null
  try {
    journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  } catch (error) {
    errors.push({
      code: 'stale-snapshot',
      detail: 'the preparation journal could not be read',
      evidence: `${journalFile}: ${String(error?.message ?? error)}`,
    })
    return { errors }
  }
  if (!isPlainObject(journal) || journal.contractVersion !== CONTRACT_VERSION) {
    errors.push({
      code: 'stale-snapshot',
      detail: 'the preparation journal does not name this contract version',
      evidence: `${journalFile} holds ${JSON.stringify(journal?.contractVersion ?? null)}`,
    })
    return { errors }
  }
  if (journal.state !== 'prepared') {
    errors.push({
      code: 'stale-snapshot',
      detail: `the identified preparation is ${journal.state ?? 'of unknown state'}, not a complete prepared set`,
      evidence: `journal state ${journal.state ?? 'absent'}; prepared ${(journal.preparation?.branches ?? []).length} of ${plan.selection.length} positions`,
    })
  }
  const recorded = [
    ['selection', journal.selection, plan.selection],
    ['order', journal.order, plan.order],
    ['root.ref', journal.root?.ref, plan.rootRef],
    ['root.oid', journal.root?.oid, plan.rootOid],
    ['heads', journal.heads, plan.heads],
    ['originalHeads', journal.originalHeads, plan.originalHeads],
    ['preparedHeads', journal.preparedHeads, plan.preparedHeads],
  ]
  for (const [name, was, is] of recorded) {
    if (sameJson(was ?? null, is ?? null)) continue
    errors.push({
      code: 'stale-snapshot',
      detail: `the preparation journal was written for a different ${name}`,
      evidence: `journal ${JSON.stringify(was ?? null)}, this publication ${JSON.stringify(is ?? null)}`,
    })
  }
  errors.push(...inspectPreparationWorkspaces(input.preparationRunDirectory, plan.selection))
  return { errors }
}

/**
 * The preparation workspaces, read before anything is written. A workspace left mid-merge
 * holds an unmerged index and an operation in progress, and one whose committed tree still
 * carries markers is not a finished integration - neither is discoverable from the
 * manifest alone. An absent workspace directory, or a missing one for a selected pull
 * request, is the same kind of gap: the integrity claim cannot be checked at all.
 */
function inspectPreparationWorkspaces(preparationRunDirectory, numbers) {
  const errors = []
  const workspaces = join(preparationRunDirectory, 'workspaces')
  if (!existsSync(workspaces)) {
    errors.push({
      code: 'stale-snapshot',
      detail: 'the identified preparation run directory holds no task-owned workspaces',
      evidence: `${workspaces} is absent, so no workspace index or operation state can be inspected`,
    })
    return errors
  }
  for (const number of numbers) {
    if (!existsSync(join(workspaces, `pr-${number}`))) {
      errors.push({
        code: 'stale-snapshot',
        detail: `the identified preparation run directory holds no workspace for #${number}`,
        evidence: `${join(workspaces, `pr-${number}`)} is absent`,
      })
    }
  }
  for (const entry of readdirSync(workspaces, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const workspace = join(workspaces, entry.name)
    const unmerged = lines(gitOut(workspace, ['diff', '--name-only', '--diff-filter=U']) ?? '')
    const operations = [
      'MERGE_HEAD',
      'REBASE_HEAD',
      'CHERRY_PICK_HEAD',
      'rebase-merge',
      'rebase-apply',
    ].filter((marker) => existsSync(join(workspace, '.git', marker)))
    if (unmerged.length > 0 || operations.length > 0) {
      errors.push({
        code: 'unresolved-conflict',
        detail: `preparation workspace ${entry.name} is not in a finished state`,
        evidence: `unmerged=${unmerged.join(',') || 'none'} operations=${operations.join(',') || 'none'}`,
      })
    }
  }
  return errors
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

/**
 * Everything a base retarget must leave alone, plus the identity and base the pinned
 * snapshot established. A field absent from the pinned snapshot is not compared: an
 * unpinned field cannot prove divergence, and inventing a default would manufacture one.
 */
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

/**
 * Reads one selected pull request through the provider, recording a structured failure
 * rather than throwing: a pull request that cannot be read is a blocker, not a crash and
 * not a licence to assume its state.
 */
async function readSelectedPullRequest(provider, number, errors) {
  let read
  try {
    read = await provider.readPullRequest(number)
  } catch (error) {
    errors.push({
      code: 'stale-snapshot',
      detail: `the provider could not be read for #${number}: ${String(error?.message ?? error)}`,
      evidence: 'a pull request that cannot be re-read is not written',
    })
    return null
  }
  const pr = isPlainObject(read) ? read.pullRequest : null
  if (!isPlainObject(pr)) {
    errors.push({
      code: 'unsupported-input',
      detail: `#${number} is not present in the provider`,
      evidence: `the provider returned ${JSON.stringify(read)}`,
    })
    return null
  }
  return pr
}

/**
 * Every way an observed pull request differs from the pinned one, named field by field.
 *
 * Comparing all of them is the point: a read of only `headRef` and `state` would happily
 * overwrite a base somebody else moved, or a head repository that is now a fork, because
 * neither is in the subset it looked at.
 */
function compareAdmissible(pinned, observed, options = {}) {
  const divergences = []
  const intendedBase = options.intendedBase ?? null
  const compare = (field, read = (pr) => pr?.[field] ?? null) => {
    const pinnedValue = read(pinned)
    if (pinnedValue === null || pinnedValue === undefined) return
    const observedValue = read(observed)
    // The one admissible difference is this run's own base write. A resumed run re-reads
    // a pull request a previous attempt already retargeted, and treating that as somebody
    // else's concurrent edit would refuse a publication that is actually reconciled.
    if (field === 'baseRef' && intendedBase !== null && observedValue === intendedBase) return
    if (!sameJson(pinnedValue, observedValue)) {
      divergences.push(
        `${field}: authorized ${JSON.stringify(pinnedValue)}, observed ${JSON.stringify(observedValue)}`,
      )
    }
  }
  compare('number', (pr) => (isPlainObject(pr) && Number.isInteger(pr.number) ? pr.number : null))
  compare('state')
  compare('draft')
  compare('headRef')
  compare('headRepository')
  compare('baseRef')
  compare('headRefOid')
  compare('baseRefOid')
  compare('title')
  compare('body')
  compare('labels')
  compare('reviewers')
  compare('autoMergeRequest')
  return divergences
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
  // The journal in the run directory is the only record of an interrupted write, so this
  // run works on its own copy: a request that is refused before any write leaves that
  // record exactly as the interrupted run left it.
  const journal = existingJournal
    ? { ...existingJournal }
    : {
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
  // Read the controls the CALLER's own configuration and environment impose, before the
  // first remote conversation rather than after it. `ls-remote` and a push both resolve
  // an ssh wrapper, a credential helper, a proxy command, or a permitted custom transport
  // on their way to the remote, so a checking wrapper would already have run by the time a
  // later step noticed. Nothing here is unset or overridden: a control that cannot be
  // honoured is a blocker, because the alternative is a run that quietly did the thing the
  // control exists to prevent.
  const callerEnv = { ...process.env }
  const inherited = executableControls(
    (cwd, args, env) => runGit(cwd, args, { allowFailure: true, env: env ?? callerEnv }),
    input.repository,
    callerEnv,
    // Only the destination decides which transports are reachable. The refspecs are ref
    // names inside the destination repository, not URLs, so they add no transport.
    endpointTransports(input.pushEndpoint),
  )
  const controls = [...inherited, ...inspectControls(input.repository)]
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

  /**
   * A journal that cannot be written is itself a fault, but it is not a fault that undoes
   * what the remote already accepted. The recorded outcomes are returned with the failure
   * attached, so an acknowledged write is never reported as "nothing was written".
   */
  const finish = (extra) => {
    journal.updatedAt = input.now
    let journalError = null
    try {
      writeJournal(journalFile, journal)
    } catch (error) {
      journalError = {
        code: 'unfinished-run',
        detail: 'the publication journal could not be written after remote operations',
        evidence: `${journalFile}: ${String(error?.message ?? error)}`,
      }
    }
    if (!journalError) return returnWithoutJournal(extra)
    return returnWithoutJournal({
      ...extra,
      status: extra.status === 'published' || extra.status === 'no-op' ? 'partial' : extra.status,
      ok: false,
      errors: [...(extra.errors ?? []), journalError],
      recovery: {
        acknowledgedChanges: (extra.publication?.confirmed ?? []).map(
          (entry) => `${entry.kind} ${entry.target}`,
        ),
        unconfirmedAttempts: [
          ...(extra.publication?.unconfirmed ?? []).map((entry) => `${entry.kind} ${entry.target}`),
          'the recovery journal itself is missing or stale',
        ],
        recommended:
          're-read the remote before retrying; the acknowledged steps above did happen, and the journal cannot be trusted to record the rest',
      },
    })
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
    // The pull-request snapshot is part of what was authorized, not a fresh reading: a
    // resume that carries a different identity, state, base, title, or draft state is a
    // different plan, not a continuation. The resolved destination is part of it too,
    // because "resume" against another endpoint is a different repository.
    pullRequests: input.pullRequests,
    pushEndpoint: input.pushEndpoint.endpoint,
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
      sameJson(existingJournal.plan.preparedHeads, currentPlan.preparedHeads) &&
      sameJson(existingJournal.plan.pullRequests ?? null, currentPlan.pullRequests) &&
      (existingJournal.plan.pushEndpoint ?? null) === currentPlan.pushEndpoint
    if (!planMatches) {
      return returnWithoutJournal({
        errors: [
          {
            code: 'stale-snapshot',
            detail:
              'cannot resume publication under a mutated plan; selection, order, root, heads, or prepared state changed',
            evidence: 'journal plan differs from input plan',
          },
        ],
        status: 'blocked',
        nextSafeAction: {
          action:
            'start a new publication run with a clean run directory, or restore the original plan',
          requires: ['matching-plan'],
        },
      })
    }
  }

  journal.plan = currentPlan

  // 3. The prepared set's own evidence, checked before the remote is even listed. A
  //    manifest whose task-owned run directory does not vouch for it is not published on
  //    the strength of the manifest alone.
  const handoff = verifyPreparationHandoff(input, currentPlan)
  if (handoff.errors.length > 0) {
    journal.state = 'blocked'
    return finish({
      errors: handoff.errors,
      status: 'blocked',
      nextSafeAction: {
        action:
          'prepare the stack again, or point preparationRunDirectory at the task-owned run that produced this manifest; nothing was written',
        requires: [
          'a complete prepared journal for this exact selection, order, root, heads, and prepared commits',
        ],
      },
    })
  }

  // 4. Re-read the remote, verify the prepared set against it, and decide the write set.
  const observed = {
    refs: await git.readRemoteRefs(input.repository, input.pushEndpoint.endpoint),
    ok: true,
    stderr: '',
  }
  const verified = verifyPreparedSet(input, observed.refs)
  const errors = [...verified.errors]
  const observedRoot = observed.refs[input.root.ref] ?? null
  let rootAdvance =
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

  // 5. Controls first, then the atomic capability question. A push is never attempted
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

  // 6. The provider is loaded and every selected pull request is read *before* any grant is
  //    acted on, because the write set is only knowable once the bases are known. A run
  //    that pushed heads first and discovered a missing base grant afterwards would leave
  //    the remote half-migrated to report it.
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
      providerCapabilities = await provider.capabilities()
    } catch (error) {
      prErrors.push({
        code: 'invalid-input',
        detail: `the provider did not report its capabilities: ${String(error?.message ?? error)}`,
        evidence: 'a provider whose capabilities cannot be read is not used for writes',
      })
    }
    if (!isPlainObject(providerCapabilities)) {
      prErrors.push({
        code: 'invalid-input',
        detail: 'the provider returned no capability document',
        evidence:
          'without it this run cannot tell which operations exist, so no permission check and no pull request read can be trusted',
      })
      providerCapabilities = null
    }
    if (providerCapabilities) {
      if (!Array.isArray(providerCapabilities.operations)) {
        prErrors.push({
          code: 'invalid-input',
          detail: 'the provider capability document lists no operations',
          evidence: `received ${JSON.stringify(providerCapabilities)}`,
        })
      }
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
        const observed = await readSelectedPullRequest(provider, number, prErrors)
        if (!observed) continue
        prBefore.set(number, observed)
        // The pinned snapshot is the authority for identity, base, and every field this
        // run must not disturb. A same-named fork, a retarget somebody else already made,
        // or a state change is a changed plan, never something to adopt.
        const pinned = input.pullRequests[number]
        const divergences = compareAdmissible(pinned, observed, {
          intendedBase: input.intendedBases[number],
        })
        if (divergences.length > 0) {
          prErrors.push({
            code: 'stale-snapshot',
            detail: `#${number} no longer matches the authorized snapshot`,
            evidence: divergences.join('; '),
          })
        }
        if (observed.state !== 'OPEN') {
          prErrors.push({
            code: 'unsupported-input',
            detail: `#${number} is ${observed.state}`,
            evidence: `the provider reports state ${observed.state}`,
          })
        }
        if (observed.autoMergeRequest?.enabled === true) {
          prErrors.push({
            code: 'active-landing-arrangement',
            detail: `#${number} carries its own active auto-merge request`,
            evidence: `provider reports autoMergeRequest.enabled with method ${observed.autoMergeRequest.method ?? 'unspecified'}`,
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
      provider: providerCapabilities
        ? { name: providerCapabilities.provider ?? 'unnamed', trust: 'host-pinned' }
        : null,
      nextSafeAction: {
        action: 'report the blocker before any write; no ref or metadata was changed',
        requires: prErrors.map((error) => error.detail),
      },
    })
  }

  // The complete write set, decided from what was actually observed. Every kind it names
  // must be granted before the first remote operation, not when its turn comes.
  const pendingBases = input.order
    .filter((number) => prBefore.get(number).baseRef !== input.intendedBases[number])
    .map((number) => ({
      number,
      from: prBefore.get(number).baseRef,
      to: input.intendedBases[number],
    }))
  const requiredKinds = []
  if (refWrites.length > 0) requiredKinds.push('ref-update')
  if (pendingBases.length > 0) requiredKinds.push('pr-base-update')
  const missingKinds = requiredKinds.filter((kind) => !granted.has(kind))
  if (missingKinds.length > 0) {
    journal.state = 'blocked'
    return finish({
      errors: missingKinds.map((kind) => ({
        code: 'missing-permission',
        detail:
          kind === 'ref-update'
            ? 'no grant permits pushing the prepared heads to the remote'
            : 'no grant permits retargeting the selected pull request bases',
        evidence:
          kind === 'ref-update'
            ? `pending head writes: ${refWrites.map((w) => w.ref).join(', ')}`
            : `pending base writes: ${pendingBases.map((b) => `#${b.number}`).join(', ')}`,
      })),
      status: 'blocked',
      provider: providerCapabilities
        ? { name: providerCapabilities.provider ?? 'unnamed', trust: 'host-pinned' }
        : null,
      nextSafeAction: {
        action: `ask for an explicit execute grant naming ${missingKinds.join(' and ')}`,
        requires: missingKinds,
      },
    })
  }

  const refspecs = refWrites.map((write) => `${write.to}:${write.ref}`)
  const leases = refWrites.map((write) => `--force-with-lease=${write.ref}:${write.from}`)
  /** Exactly the refs this run is authorized to move; everything else must not move. */
  const selectedRefs = new Set(input.order.map((number) => input.heads[number]))
  let atomic = { supported: null, evidence: 'no ref write was needed' }
  if (refWrites.length > 0) {
    atomic = await git.detectAtomicRefTransaction(
      input.repository,
      input.pushEndpoint.endpoint,
      refspecs,
      leases,
    )
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

  const compareAndSwap = providerCapabilities?.compareAndSwap === true
  const publication = emptyPublication()
  publication.concurrency.leaseHeld = refWrites.length > 0
  const verification = []
  let sequence = 0
  let stuck = []
  // The freshest observation of the remote: the preflight read, replaced wholesale by the
  // post-push read-back once there is one.
  let latestRefs = observed.refs

  // From here on the remote may already have accepted something, so a fault thrown by any
  // later step is reported with the attempts, confirmations, and uncertainties this run
  // actually recorded. Letting it escape would replace those with "nothing was written",
  // which is the one description that is certainly wrong.
  let payload
  try {
    // 7. One atomic, lease-guarded push of exactly the selected refs that still need it.
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
      // Awaited, because these are the two conversations a caller may inject and an
      // injected one is asynchronous. Reading `push.ok` off a pending promise is undefined
      // rather than false, so the run reported a rejection it never received and then
      // failed on the promise's missing `stderr`.
      const push = await git.push(input.repository, input.pushEndpoint.endpoint, refspecs, leases)
      const after = await git.readRemoteRefs(input.repository, input.pushEndpoint.endpoint)
      latestRefs = after
      stuck = refWrites.filter((write) => after[write.ref] !== write.to)
      // The read-back decides, not the push's exit status. A push that reports failure can
      // still have landed - a lost acknowledgement is the normal case - and a push that
      // reports success can still not have: only the remote's own ref says which.
      const failure = push.ok ? 'unknown' : classifyPushFailure(push.stderr)
      for (const write of refWrites) {
        const acknowledged = after[write.ref] === write.to
        const outcome = acknowledged ? 'acknowledged' : failure
        publication.attempts.push({
          sequence: sequence++,
          kind: 'ref-update',
          target: write.ref,
          from: write.from,
          to: write.to,
          acknowledged,
          lease: { expectedRemote: write.from, usedForceWithLease: true },
          outcome,
        })
        if (acknowledged) {
          publication.confirmed.push({ kind: 'ref-update', target: write.ref, oid: write.to })
        } else {
          publication.unconfirmed.push({
            kind: 'ref-update',
            target: write.ref,
            why: push.ok
              ? 'the push reported success but the ref does not hold the prepared head'
              : `the atomic push failed: ${push.stderr.trim().slice(0, 300) || 'no message'}`,
          })
          publication.denials.push({
            kind: 'ref-update',
            target: write.ref,
            reason: outcome === 'unknown' ? 'acknowledgement-unknown' : 'push-rejected',
            acknowledged: false,
          })
        }
        journal.attempts.push({
          sequence,
          kind: 'ref-update',
          target: write.ref,
          at: input.now,
          outcome,
        })
      }
      if (!push.ok) {
        journal.attempts[journal.attempts.length - refWrites.length].outcome = failure
        journal.attempts[journal.attempts.length - refWrites.length].stderr = push.stderr
          .trim()
          .slice(0, MAX_EVIDENCE_CHARS)
      }
      publication.interrupted = publication.attempts.some(
        (attempt) => attempt.outcome === 'unknown',
      )
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

    // 8. Base retargeting in dependency order, each one re-read immediately before its own
    //    write and verified immediately after.

    /**
     * The commit a branch name currently points at, from the freshest evidence available.
     *
     * Returns null when the branch cannot be resolved: an attempt records commit ids, and a
     * guessed root commit id would put a plausible-looking but invented value in a
     * SHA-typed field. An unresolvable base is a blocker, not a fallback.
     */
    const resolveBaseOid = (branchName) => {
      const raw = String(branchName ?? '')
      const ref = raw.startsWith('refs/heads/') ? raw : `refs/heads/${raw}`
      // The freshest read of the remote wins, always. The pinned root and this run's own
      // prepared heads are fallbacks for a branch the remote listing does not carry; they
      // are never used in place of an observation that exists, because an attempt's `from`
      // and `to` are records of what the base actually pointed at.
      if (latestRefs[ref]) return latestRefs[ref]
      if (ref === input.root.ref) return input.root.oid
      for (const branch of input.branches) {
        if (input.heads[branch.number] === ref) return branch.preparedHead
      }
      return (
        gitOut(input.repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) ?? null
      )
    }
    const baseWrites = []
    const baseFailures = []

    // Metadata never starts until every selected head this run intended to publish is
    // observed at its prepared commit. Retargeting a base onto a head that never landed
    // would build a chain on a branch nobody can see.
    // A selected head this run had no reason to write still has to be confirmed. When a
    // prepared head equals the branch's original head there is no refspec for it, so a
    // concurrent push to that branch raises no lease and no failed write - and the chain
    // would otherwise be built on a branch that moved after the prepared heads were made.
    const drifted = input.order
      .map((number) => {
        const ref = input.heads[number]
        const branch = input.branches.find((candidate) => candidate.number === number)
        const expected = branch ? branch.preparedHead : null
        const observedOid = latestRefs[ref]
        return observedOid !== undefined && expected !== null && observedOid !== expected
          ? { ref, expected, observed: observedOid }
          : null
      })
      .filter(Boolean)
    const headsUnreconciled =
      stuck.length > 0 ||
      drifted.length > 0 ||
      publication.unconfirmed.some((entry) => entry.kind === 'ref-update')
    if (headsUnreconciled) {
      baseFailures.push({
        code: 'stale-snapshot',
        detail: 'the selected heads have not all been confirmed at their prepared commits',
        evidence:
          stuck.length > 0
            ? `not at the prepared head: ${stuck.map((write) => write.ref).join(', ')}`
            : drifted.length > 0
              ? `a selected head this run did not need to write has moved: ${drifted
                  .map((entry) => `${entry.ref} is ${String(entry.observed).slice(0, 12)}, prepared at ${String(entry.expected).slice(0, 12)}`)
                  .join(', ')}`
              : 'a head write has an unknown acknowledgement; the remote is re-read before any retry',
      })
    } else {
      for (const number of input.order) {
        const readErrors = []
        const currentPr = await readSelectedPullRequest(provider, number, readErrors)
        if (!currentPr) {
          baseFailures.push({
            code: 'stale-snapshot',
            detail: `the provider could not be read for #${number} immediately before its base update`,
            evidence:
              readErrors.map((error) => error.detail).join('; ') || 'pull request read failed',
          })
          break
        }
        // The pinned snapshot, not the batch preflight, is what this write is authorised
        // against: the head push and every earlier metadata write happened in between.
        const divergences = compareAdmissible(input.pullRequests[number], currentPr, {
          intendedBase: input.intendedBases[number],
        })
        if (divergences.length > 0) {
          baseFailures.push({
            code: 'stale-snapshot',
            detail: `#${number} changed since the authorized snapshot, before its base update`,
            evidence: divergences.join('; '),
          })
          break
        }
        if (currentPr.state !== 'OPEN') {
          baseFailures.push({
            code: 'stale-snapshot',
            detail: `#${number} is ${currentPr.state} immediately before its base update`,
            evidence: `the provider reports state ${currentPr.state}`,
          })
          break
        }
        const intended = input.intendedBases[number]
        if (currentPr.baseRef === intended) {
          baseWrites.push({ number, intended, skipped: true, applied: true })
          continue
        }
        const fromOid = resolveBaseOid(currentPr.baseRef)
        const toOid = resolveBaseOid(intended)
        if (!fromOid || !toOid) {
          baseFailures.push({
            code: 'stale-snapshot',
            detail: `#${number} names a base this run cannot resolve to a commit`,
            evidence: `from ${currentPr.baseRef} -> ${fromOid ?? 'unresolved'}, to ${intended} -> ${toOid ?? 'unresolved'}`,
          })
          break
        }

        sequence += 1
        journal.attempts.push({
          sequence,
          kind: 'pr-base-update',
          target: String(number),
          detail: `${currentPr.baseRef} ${fromOid.slice(0, 12)} -> ${intended} ${toOid.slice(0, 12)}`,
          at: input.now,
          outcome: 'attempted',
        })
        try {
          writeJournal(journalFile, journal)
        } catch (error) {
          baseFailures.push({
            code: 'unfinished-run',
            detail: `the publication journal could not record the attempt for #${number} before its write`,
            evidence: String(error?.message ?? error),
          })
          break
        }
        let response = null
        let callError = null
        try {
          response = await provider.updatePullRequestBase(
            number,
            intended,
            compareAndSwap ? fromOid : null,
          )
        } catch (error) {
          callError = String(error?.message ?? error)
        }
        const afterErrors = []
        const readBack = await readSelectedPullRequest(provider, number, afterErrors)
        const applied = readBack !== null && readBack.baseRef === intended
        // Drift is compared independently of whether the base landed: a write that changed
        // somebody else's state succeeded and still destroyed work this run was told to keep.
        const drifted = readBack !== null && !sameJson(preserved(currentPr), preserved(readBack))
        const refused = readBack !== null && !applied && (callError || response?.ok === false)
        // An exception from the provider does not prove the write did not happen, and a read
        // that fails after a call proves nothing either. Unknown stays unknown.
        const outcome = applied
          ? 'acknowledged'
          : readBack === null
            ? 'unknown'
            : refused
              ? 'denied'
              : 'unknown'
        if (outcome === 'unknown') publication.interrupted = true
        publication.attempts.push({
          sequence: sequence++,
          kind: 'pr-base-update',
          target: String(number),
          from: fromOid,
          to: toOid,
          acknowledged: applied,
          lease: { expectedRemote: fromOid, usedForceWithLease: false },
          outcome,
        })
        if (applied) {
          publication.confirmed.push({ kind: 'pr-base-update', target: String(number), oid: toOid })
        } else {
          publication.unconfirmed.push({
            kind: 'pr-base-update',
            target: String(number),
            why:
              readBack === null
                ? `the provider call ${callError ? `failed (${callError.slice(0, 200)}) ` : 'completed '}and the pull request could not be re-read, so whether the base moved is unknown`
                : refused
                  ? `the provider refused the write: ${(callError ?? 'reported ok:false').slice(0, 200)}`
                  : 'the base does not read back as the intended branch after the write',
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
          publication.remoteClaims.push({
            kind: 'pr-base',
            target: String(number),
            observed: readBack.baseRef.startsWith('refs/heads/')
              ? readBack.baseRef
              : `refs/heads/${readBack.baseRef}`,
            observedAt: input.now,
          })
        }
        if (drifted) {
          baseFailures.push({
            code: 'stale-snapshot',
            detail: `#${number} changed in a field this run never writes`,
            evidence: `before ${JSON.stringify(preserved(currentPr))}; after ${JSON.stringify(preserved(readBack))}`,
          })
          break
        }
        // A base whose outcome is unknown or refused stops the chain: the next pull request's
        // base would name a predecessor whose state is not what this run believed.
        if (!applied) break
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

    // 9. Final read-back of the whole chain, and the root reported against its pinned id.
    const finalRefs = await git.readRemoteRefs(input.repository, input.pushEndpoint.endpoint)
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
    // Success is a claim about the observed chain, not about the writes this run intended.
    // Every selected head must be at its prepared commit, every selected base must name the
    // intended branch, and every pull request must still be readable - an unreadable one
    // cannot be called correct.
    const chainProblems = []
    for (const number of input.order) {
      const ref = input.heads[number]
      const expected = input.branches.find((branch) => branch.number === number).preparedHead
      if ((finalRefs[ref] ?? null) !== expected) {
        chainProblems.push(`${ref} is ${finalRefs[ref] ?? 'absent'}, expected ${expected}`)
      }
      const readErrors = []
      const pr = await readSelectedPullRequest(provider, number, readErrors)
      if (!pr) {
        chainProblems.push(
          `#${number} could not be re-read: ${readErrors[0]?.detail ?? 'no response'}`,
        )
        continue
      }
      if (pr.baseRef !== input.intendedBases[number]) {
        chainProblems.push(
          `#${number} builds on ${pr.baseRef}, expected ${input.intendedBases[number]}`,
        )
      }
    }
    // Every ref the snapshot covered and this run did not authorize is re-read after the
    // last write. A pre-flight comparison proves nothing about a push that landed in
    // between, and an unselected ref that moved during the run is a fact about the
    // repository that a `published` result must not paper over.
    const unselectedDrift = []
    for (const [ref, pinned] of Object.entries(input.observedRefs)) {
      if (ref === input.root.ref || selectedRefs.has(ref)) continue
      const now = finalRefs[ref]
      if (now !== pinned) {
        unselectedDrift.push(`${ref} is ${now ?? 'absent'}, expected ${pinned}`)
      }
    }
    for (const drift of unselectedDrift) {
      errors.push({
        code: 'stale-snapshot',
        detail: 'a ref outside the authorized write set moved while this run was writing',
        evidence: drift,
      })
    }
    verification.push({
      invariant: 'preservation.unselected-refs',
      method: 'git ls-remote read-back of every observed ref outside the authorized write set',
      observed:
        unselectedDrift.length === 0
          ? `${Object.keys(input.observedRefs).length} observed ref(s) outside the write set are unchanged`
          : unselectedDrift.join('; '),
      result: unselectedDrift.length === 0 ? 'pass' : 'fail',
    })
    const chainHolds = chainProblems.length === 0
    verification.push({
      invariant: 'topology.chain',
      method: 're-read every selected head and base after the last write',
      observed: chainHolds
        ? `chain ${input.order.map((number) => `#${number}`).join(' <- ')} verified by re-read`
        : chainProblems.join('; '),
      result: chainHolds ? 'pass' : 'fail',
    })
    // A root that moved between the authorization and the final read is reported against
    // the pinned commit id and recorded as a failure of `preservation.root`. It is never
    // absorbed into a "this chain is current" claim, and the newer root work is never
    // described as integrated - nothing here merged it.
    const finalRoot = finalRefs[input.root.ref] ?? null
    if (finalRoot !== input.root.oid) {
      const advance = rootAdvance ?? {
        pinned: input.root.oid,
        observed: finalRoot ?? '',
        integrated: false,
      }
      advance.observed = finalRoot ?? ''
      advance.note =
        `the published chain is integrated against the pinned root ${input.root.oid.slice(0, 12)}; the root read back as ${(finalRoot ?? 'absent').slice(0, 12)} after the last write and that newer work is not part of this chain`
      verification.push({
        invariant: 'preservation.root',
        method: 'git ls-remote read-back of the root ref after the last write',
        observed: `pinned ${input.root.oid}, observed ${finalRoot ?? 'absent'}; reported against the pinned snapshot and not integrated`,
        result: advance.integrated ? 'pass' : 'fail',
      })
      rootAdvance = advance
    }

    const unconfirmedCount = publication.unconfirmed.length
    // Every required write and every final observation has to hold. A denied base, a base
    // this run skipped for want of permission, and a final chain that did not verify all
    // mean the same thing to a reader: this is not a published stack.
    const failedFinalRead = chainProblems.some((problem) =>
      problem.includes('could not be re-read'),
    )
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
    payload = finish({
      ok: status === 'published' || status === 'no-op',
      status,
      errors: [
        ...errors,
        ...baseFailures,
        ...(failedFinalRead
          ? chainProblems
              .filter((problem) => problem.includes('could not be re-read'))
              .map((problem) => ({
                code: 'stale-snapshot',
                detail: 'the final read-back of a selected pull request failed',
                evidence: problem,
              }))
          : []),
        ...(status === 'partial' || status === 'blocked'
          ? publication.unconfirmed.map((entry) => ({
              code: entry.why.includes('refused') ? 'missing-permission' : 'stale-snapshot',
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
  } catch (error) {
    payload = finish({
      ok: false,
      status: publication.confirmed.length > 0 ? 'partial' : 'blocked',
      errors: [
        {
          code: 'unfinished-run',
          detail: 'publication stopped on an unexpected error after remote operations began',
          evidence: String(error?.message ?? error),
        },
      ],
      publication,
      rootAdvance,
      unselectedDependents: input.unselectedDependents,
      capability: {
        ...base.capability,
        atomicRefTransaction: atomic.supported === true ? 'supported' : 'unknown',
        providerCompareAndSwap: compareAndSwap,
        baseWritesGuardedBy: compareAndSwap ? 'compare-and-swap' : 'read-before-write',
        residualMetadataRace: !compareAndSwap,
      },
      provider: {
        name: providerCapabilities?.provider ?? 'unnamed',
        compareAndSwap,
        trust: process.env.FLATTEN_PR_PROVIDER_MODULE ? 'host-pinned' : 'caller-declared',
      },
      verification,
      recovery: {
        acknowledgedChanges: publication.confirmed.map((entry) => `${entry.kind} ${entry.target}`),
        unconfirmedAttempts: [
          ...publication.unconfirmed.map((entry) => `${entry.kind} ${entry.target}`),
          ...publication.attempts.map(
            (attempt) => `${attempt.kind} ${attempt.target} (${attempt.outcome})`,
          ),
          'the run stopped before this journal could record what happened next',
        ],
        recommended:
          're-read the remote before retrying; the acknowledged steps above did happen, and nothing is rolled back automatically',
      },
      nextSafeAction: {
        action: 'reconcile the recorded steps from fresh observations before any retry',
        requires: [],
      },
    })
  }
  return payload
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
      nextSafeAction: {
        action:
          're-read the remote before concluding anything; this failure happened before the run began recording remote operations, but the remote is not assumed unchanged',
        requires: [],
      },
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.ok) return 0
  return result.status === 'blocked' || result.status === 'partial' ? 3 : 2
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main())
}
