#!/usr/bin/env node
/**
 * Evidence-backed dependency discovery for `flatten-pr-graph/1`.
 *
 * One job: given the already-resolved identities of a selection and a task-owned
 * repository holding their heads, derive the hard dependency edges that real evidence
 * supports, and report what could not be established.
 *
 * Why this is a program rather than prose: strict ancestry over real commits, the
 * distinction between "not an ancestor" and "cannot be decided", the equal-head case
 * that must not produce two reciprocal edges, and cycle detection are exactly the
 * operations an agent gets subtly wrong. Deciding whether an ambiguous declared
 * prerequisite is real stays with the agent; this script reports the evidence and the
 * uncertainty, and never invents an edge.
 *
 * Input JSON (stdin or `--input <file>`):
 *
 *   {
 *     "contractVersion": "flatten-pr-graph/1",
 *     "root": "refs/heads/main",
 *     "repository": "/abs/path/to/task-owned-clone",
 *     "selected": [
 *       { "number": 12, "headRef": "refs/heads/feat-a", "baseRef": "refs/heads/main" },
 *       { "number": 13, "headRef": "refs/heads/feat-b", "baseRef": "refs/heads/feat-a" }
 *     ],
 *     "declaredPrerequisites": [
 *       { "before": 12, "after": 13, "evidence": "PR #13 body names 'Requires #12'" }
 *     ],
 *     "verifiedPrerequisites": []
 *   }
 *
 * `declaredPrerequisites` are unverified claims found in task data. They are reported as
 * `unverified`, never as edges: a mention in a title, body, or branch name is not a
 * dependency. `verifiedPrerequisites` are prerequisites a human or an authoritative
 * source has already confirmed; each still has to agree with observed ancestry, and a
 * contradiction is reported as a contradiction rather than resolved by dropping it.
 *
 * Output JSON on stdout: `{ contractVersion, ok, graph, evidence, undecidable, errors }`
 * where `graph.edges` holds only evidence-backed edges, `graph.undecidable` holds the
 * pairs ancestry could not decide, and `errors` holds structured failures.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const CONTRACT_VERSION = 'flatten-pr-graph/1'
const GIT_TIMEOUT_MS = 120_000

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

function git(cwd, args) {
  try {
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      status: typeof error?.status === 'number' ? error.status : null,
      stderr: String(error?.stderr ?? error?.message ?? ''),
    }
  }
}

/**
 * A ref name or commit SHA is passed to Git as one argv entry: never concatenated into
 * a command, never expanded by a shell, never treated as anything but a name.
 *
 * Git itself decides validity. A real repository can carry a branch name with `+` or
 * non-ASCII characters, and an alphabet this script invented would refuse real input;
 * `git check-ref-format`, reached through an argument array, is both the authority and
 * the reason nothing in the name is ever interpreted.
 */
function assertRefName(repository, value, where) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\n]/.test(value)) {
    throw new InputError(
      'invalid-input',
      `${where} must be a ref name or a commit SHA`,
      `received ${JSON.stringify(value)}`,
    )
  }
  const isOid = /^[0-9a-f]{40,64}$/i.test(value)
  const check = isOid
    ? git(repository, ['cat-file', '-e', `${value}^{commit}`])
    : git(repository, ['check-ref-format', value])
  if (!check.ok) {
    throw new InputError(
      'invalid-input',
      `${where} must be a valid fully qualified ref name or a commit SHA present in storage`,
      `git ${isOid ? 'cat-file -e' : 'check-ref-format'} rejected ${JSON.stringify(value)}`,
    )
  }
  return value
}

/** The commit a ref points at right now, so every later comparison is immutable. */
function commitOf(repository, ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: repository,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }).trim()
  } catch {
    return null
  }
}

function assertIdentity(value, where) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InputError(
      'invalid-input',
      `${where} must be a positive integer pull request number`,
      `received ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * `git merge-base --is-ancestor` distinguishes three outcomes that a naive boolean
 * collapses into one: exit 0 yes, exit 1 no, anything else "could not be decided"
 * (a missing object, an unrelated history, or a shallow boundary).
 */
function ancestry(repository, ancestorRef, descendantRef) {
  const present = git(repository, ['rev-parse', '--verify', '--quiet', `${ancestorRef}^{commit}`])
  if (!present.ok) {
    return {
      decision: 'undecidable',
      reason: `${ancestorRef} is not present in task-owned storage`,
    }
  }
  const target = git(repository, ['rev-parse', '--verify', '--quiet', `${descendantRef}^{commit}`])
  if (!target.ok) {
    return {
      decision: 'undecidable',
      reason: `${descendantRef} is not present in task-owned storage`,
    }
  }
  const base = git(repository, ['merge-base', ancestorRef, descendantRef])
  if (!base.ok) {
    return {
      decision: 'undecidable',
      reason: `no merge base between ${ancestorRef} and ${descendantRef}: the histories are unrelated or incomplete`,
    }
  }
  const run = git(repository, ['merge-base', '--is-ancestor', ancestorRef, descendantRef])
  if (run.ok) return { decision: 'yes' }
  if (run.status === 1) return { decision: 'no' }
  return {
    decision: 'undecidable',
    reason: `git merge-base --is-ancestor failed with status ${run.status}: ${run.stderr.trim().slice(0, 200)}`,
  }
}

export function discoverDependencies(raw) {
  if (!isPlainObject(raw)) {
    throw new InputError(
      'invalid-input',
      'the discovery document must be a JSON object',
      'not an object',
    )
  }
  if (raw.contractVersion !== CONTRACT_VERSION) {
    throw new InputError(
      'invalid-input',
      'unsupported contract version',
      `received ${JSON.stringify(raw.contractVersion)}, expected ${CONTRACT_VERSION}`,
    )
  }
  const repository = raw.repository
  if (typeof repository !== 'string' || !isAbsolute(repository)) {
    throw new InputError(
      'invalid-input',
      'repository must be an absolute path to task-owned storage',
      `received ${JSON.stringify(repository)}`,
    )
  }
  if (!git(repository, ['rev-parse', '--git-dir']).ok) {
    throw new InputError(
      'invalid-input',
      'repository is not a Git repository, so no ancestry can be established',
      `git rev-parse failed in ${repository}`,
    )
  }
  // The root is an input, never a default. Guessing `refs/heads/main` here would make
  // every edge below depend on a repository convention nobody in this run verified.
  if (raw.root === undefined || raw.root === null) {
    throw new InputError(
      'invalid-input',
      'root is required: discover the verified default branch and pass it in, never assume it here',
      'received no root',
    )
  }
  const root = assertRefName(repository, raw.root, 'root')

  const entries = (Array.isArray(raw.selected) ? raw.selected : []).map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new InputError('invalid-input', `selected[${index}] must be an object`, 'not an object')
    }
    const record = {
      number: assertIdentity(entry.number, `selected[${index}].number`),
      headRef: assertRefName(repository, entry.headRef, `selected[${index}].headRef`),
      baseRef: assertRefName(repository, entry.baseRef ?? root, `selected[${index}].baseRef`),
    }
    // Pin each ref to the commit it names right now. Every comparison below runs on
    // those immutable SHAs, so a ref that moves mid-run cannot quietly change the
    // answer: the graph describes this snapshot, and a later move is a stale snapshot.
    record.headOid = commitOf(repository, record.headRef)
    record.baseOid = commitOf(repository, record.baseRef)
    return record
  })
  if (entries.length === 0) {
    throw new InputError(
      'missing-selection',
      'the selection is empty, and a missing selection never means every open pull request',
      'selected: []',
    )
  }
  const numbers = new Set()
  for (const entry of entries) {
    if (numbers.has(entry.number)) {
      throw new InputError(
        'invalid-selection',
        'the selection contains one identity more than once',
        `#${entry.number}`,
      )
    }
    numbers.add(entry.number)
  }
  const byNumber = new Map(entries.map((entry) => [entry.number, entry]))

  const edges = []
  const evidence = []
  const undecidable = []
  const errors = []

  // One declared base that is another selected head is a real edge: the repository
  // says this pull request is built on that one.
  for (const entry of entries) {
    for (const other of entries) {
      if (other.number === entry.number) continue
      if (entry.baseRef === other.headRef) {
        edges.push({
          before: other.number,
          after: entry.number,
          source: 'pr-base',
          evidence: `#${entry.number} declares base ${entry.baseRef}, which is the head of #${other.number}`,
        })
      }
    }
  }

  // Two selected identities can share a head in two quite different ways, and they need
  // opposite handling:
  //
  //  - the *same branch*: one branch would have to sit in two positions of the chain at
  //    once. That is unsupported input, not something to order.
  //  - two *different branches* at the same commit: neither contains the other, so
  //    there is no edge in either direction. The contribution is redundant, and a human
  //    decides whether one of them is the real one. It is reported, never dropped.
  const equalHeads = []
  const redundantHeads = []
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const first = entries[left]
      const second = entries[right]
      if (first.headRef === second.headRef) {
        equalHeads.push({
          numbers: [first.number, second.number],
          headRef: first.headRef,
          headOid: first.headOid,
          state: 'unsupported-shared-branch',
        })
        errors.push({
          code: 'unsupported-input',
          detail: `pull requests #${first.number} and #${second.number} name one head branch, which cannot hold two positions in a chain`,
          evidence: `both heads are ${first.headRef}`,
        })
        continue
      }
      if (first.headOid !== null && first.headOid === second.headOid) {
        redundantHeads.push({
          numbers: [first.number, second.number],
          headRefs: [first.headRef, second.headRef],
          headOid: first.headOid,
          state: 'redundant-contribution',
        })
      }
    }
  }
  const sharedBranch = new Set(
    equalHeads.flatMap((pair) => pair.numbers.map((number) => `${number}:${pair.headRef}`)),
  )
  // Numbers whose heads already resolved to one commit. Ancestry between them is not
  // strict in either direction, so it must not become an edge.
  const equalCommit = new Set()
  for (const pair of redundantHeads) {
    for (const number of pair.numbers) equalCommit.add(`${number}:${pair.headOid}`)
  }

  // Strict ancestry between two selected heads is the other real edge, and it is
  // decided on the pinned SHAs rather than on ref names that could move underneath it.
  for (const entry of entries) {
    for (const other of entries) {
      if (other.number === entry.number) continue
      if (sharedBranch.has(`${other.number}:${other.headRef}`)) continue
      const relation = equalCommit.has(`${other.number}:${other.headOid}`)
        ? {
            decision: 'equal',
            reason: 'both heads resolve to one commit, so neither contains the other',
          }
        : ancestry(repository, other.headOid, entry.headOid)
      evidence.push({
        pair: [other.number, entry.number],
        relation: relation.decision,
        detail:
          relation.reason ??
          (relation.decision === 'yes'
            ? `${short(other.headOid)} is contained in ${short(entry.headOid)}`
            : `${short(other.headOid)} is not contained in ${short(entry.headOid)}`),
      })
      if (relation.decision === 'undecidable') {
        undecidable.push({ pair: [other.number, entry.number], why: relation.reason })
        continue
      }
      if (relation.decision === 'yes') {
        const already = edges.some(
          (edge) =>
            (edge.before === other.number && edge.after === entry.number) ||
            (edge.before === entry.number && edge.after === other.number),
        )
        if (!already) {
          edges.push({
            before: other.number,
            after: entry.number,
            source: 'ancestry',
            evidence: `${short(other.headOid)} is a strict ancestor of ${short(entry.headOid)}`,
          })
        }
      }
    }
  }

  function short(oid) {
    return oid === null ? 'a missing head' : `${oid.slice(0, 8)} (${oid})`
  }

  // A verified prerequisite is an explicit human or authoritative-source fact, so it is
  // an edge in its own right. A functional dependency between two independent commits
  // is perfectly real and does NOT require the before-head to already be contained in
  // the after-head. What does contradict it is observed ancestry in the opposite
  // direction: the dependent already contains its alleged prerequisite, so ordering them
  // the claimed way would put a head that is already inside the other one before it.
  const unverified = []
  for (const [index, claim] of (Array.isArray(raw.declaredPrerequisites)
    ? raw.declaredPrerequisites
    : []
  ).entries()) {
    unverified.push({
      before: assertIdentity(claim?.before, `declaredPrerequisites[${index}].before`),
      after: assertIdentity(claim?.after, `declaredPrerequisites[${index}].after`),
      state: 'unverified',
      evidence: typeof claim?.evidence === 'string' ? claim.evidence : 'no evidence recorded',
    })
  }
  for (const [index, claim] of (Array.isArray(raw.verifiedPrerequisites)
    ? raw.verifiedPrerequisites
    : []
  ).entries()) {
    const before = assertIdentity(claim?.before, `verifiedPrerequisites[${index}].before`)
    const after = assertIdentity(claim?.after, `verifiedPrerequisites[${index}].after`)
    for (const number of [before, after]) {
      if (!numbers.has(number)) {
        errors.push({
          code: 'unknown-identity',
          detail: `a verified prerequisite names an identity outside the selection`,
          evidence: `#${number} is not among the selected identities`,
        })
      }
    }
    if (!numbers.has(before) || !numbers.has(after)) continue
    const claimed = typeof claim?.evidence === 'string' ? claim.evidence : 'verified prerequisite'
    const forward = ancestry(repository, byNumber.get(before).headOid, byNumber.get(after).headOid)
    const reverse = ancestry(repository, byNumber.get(after).headOid, byNumber.get(before).headOid)
    if (reverse.decision === 'yes') {
      errors.push({
        code: 'contradictory-graph',
        detail: `the verified prerequisite #${before} -> #${after} is contradicted by observed ancestry`,
        evidence: `the dependent #${after} already contains #${before}: ${short(byNumber.get(before).headOid)} is an ancestor of ${short(byNumber.get(after).headOid)}`,
      })
      continue
    }
    if (forward.decision === 'undecidable' || reverse.decision === 'undecidable') {
      undecidable.push({
        pair: [before, after],
        why: 'ancestry could not decide this verified prerequisite, so it is recorded as unverified rather than resolved by assumption',
      })
      unverified.push({ before, after, state: 'unverified', evidence: claimed })
      continue
    }
    if (edges.some((edge) => edge.before === before && edge.after === after)) continue
    edges.push({ before, after, source: 'verified-prerequisite', evidence: claimed })
  }

  const cycle = findCycle(
    entries.map((entry) => entry.number),
    edges,
  )
  if (cycle) {
    errors.push({
      code: 'contradictory-graph',
      detail: 'the evidenced dependencies contain a cycle',
      evidence: cycle.map((number) => `#${number}`).join(' -> '),
    })
  }

  const unselectedDependents = (
    Array.isArray(raw.unselectedDependents) ? raw.unselectedDependents : []
  ).map((entry, index) => ({
    number: assertIdentity(entry?.number, `unselectedDependents[${index}].number`),
    dependsOn: assertIdentity(entry?.dependsOn, `unselectedDependents[${index}].dependsOn`),
    basis: entry?.basis === 'declared-base' ? 'declared-base' : 'strict-ancestry',
    reportedOnly: true,
  }))

  return {
    contractVersion: CONTRACT_VERSION,
    ok: errors.length === 0,
    root,
    graph: {
      identities: entries.map((entry) => ({
        number: entry.number,
        headRef: entry.headRef,
        headOid: entry.headOid,
        baseRef: entry.baseRef,
        baseOid: entry.baseOid,
      })),
      selected: entries.map((entry) => entry.number),
      edges: edges.sort((left, right) => left.before - right.before || left.after - right.after),
      undecidable,
      unverified,
      unselectedDependents,
      equalHeads,
      redundantHeads,
    },
    evidence,
    errors,
  }
}

/** Any cycle in the evidenced edges, or null. The edges are reported, not pruned. */
function findCycle(numbers, edges) {
  const successors = new Map(numbers.map((number) => [number, []]))
  for (const edge of edges) {
    if (!successors.has(edge.before) || !successors.has(edge.after)) continue
    successors.get(edge.before).push(edge.after)
  }
  const state = new Map(numbers.map((number) => [number, 0]))
  const path = []
  let found = null
  const visit = (number) => {
    state.set(number, 1)
    path.push(number)
    for (const next of successors.get(number)) {
      if (found) return
      if (state.get(next) === 1) {
        found = [...path.slice(path.indexOf(next)), next]
        return
      }
      if (state.get(next) === 0) visit(next)
    }
    path.pop()
    state.set(number, 2)
  }
  for (const number of numbers) {
    if (state.get(number) === 0) visit(number)
    if (found) break
  }
  return found
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
      'no discovery document was supplied',
      'pass --input <file> or pipe the JSON document on stdin',
    )
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(
      [
        'discover-dependencies.mjs [--input <file>]',
        '',
        'Derives evidence-backed dependency edges for a selection from a task-owned',
        'repository and writes { contractVersion, ok, graph, evidence, errors } to stdout.',
        'Exit 0 discovers, 2 refuses the input, 3 reports contradictory evidence.',
        '',
      ].join('\n'),
    )
    return 0
  }
  let result
  try {
    result = discoverDependencies(JSON.parse(readInput(argv)))
  } catch (error) {
    const failure =
      error instanceof InputError
        ? error
        : new InputError(
            'invalid-input',
            String(error?.message ?? error),
            'input could not be read',
          )
    result = { contractVersion: CONTRACT_VERSION, ok: false, errors: [failure] }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 2
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.ok ? 0 : 3
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
