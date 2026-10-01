#!/usr/bin/env node
/**
 * Pairwise integration-probe measurement for `flatten-pr-graph/1`.
 *
 * One job: for a set of ordered pairs of pull requests, run a real read-only Git
 * three-way merge probe in a task-owned repository and report how much conflict work
 * each pair would cost.
 *
 * Why this is a program rather than prose: a conflict count has to come from a real
 * merge of real objects, and the distinction between "this pair merges cleanly" and
 * "this pair could not be probed at all" is exactly the distinction an agent collapses
 * into a zero. A structural conflict is never reported as a clean path list.
 *
 * Input JSON (stdin or `--input <file>`):
 *
 *   {
 *     "contractVersion": "flatten-pr-graph/1",
 *     "repository": "/abs/path/to/task-owned-clone",
 *     "pairs": [ { "before": 12, "after": 13, "base": "refs/heads/main" } ]
 *   }
 *
 * The `before` and `after` values are opaque identities the caller already mapped to
 * ref names; this script never resolves a pull request number, a ref name, or PR text
 * to anything executable. Arguments are passed as an array, never through a shell.
 *
 * Output JSON on stdout: one `estimate` per pair, in the order requested, each with
 * `kind` (`pairwise-probe`, `measured-merge`, or `unknown`), `value`, `confidence`,
 * `conflictingPaths`, and `structuralConflict`. An unprobeable pair reports
 * `kind: "unknown"` with `value: null` and a reason - never `0`.
 *
 * The probe is read-only: `git merge-tree` writes no worktree, no index, no ref, and no
 * merge state. It creates loose objects in the repository it was pointed at, so it must
 * be given task-owned storage.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { attributedDriverControls, treePaths } from './git-controls.mjs'

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
    return {
      ok: true,
      stdout: execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      }),
    }
  } catch (error) {
    return {
      ok: false,
      status: typeof error?.status === 'number' ? error.status : null,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    }
  }
}

/**
 * A ref name or commit SHA is passed to Git as one argv entry. It is never concatenated
 * into a command, never expanded by a shell, and never treated as anything but a name.
 *
 * Validity is decided by Git itself, not by an alphabet this script invented: a real
 * repository can carry non-ASCII branch names and `+`, and rejecting those would be a
 * false refusal rather than a safety property. `git check-ref-format` is the authority
 * and is reached through an argument array, so nothing in the name is ever interpreted.
 */
function assertRefName(repository, value, where) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\n]/.test(value)) {
    throw new InputError(
      'invalid-input',
      `${where} must be a ref name or a commit SHA`,
      `received ${JSON.stringify(value)}`,
    )
  }
  const commit = /^[0-9a-f]{40,64}$/i.test(value)
  const check = commit
    ? git(repository, ['cat-file', '-e', `${value}^{commit}`])
    : git(repository, ['check-ref-format', value])
  if (!check.ok) {
    throw new InputError(
      'invalid-input',
      `${where} must be a valid fully qualified ref name or a commit SHA present in storage`,
      `git ${commit ? 'cat-file -e' : 'check-ref-format'} rejected ${JSON.stringify(value)}`,
    )
  }
  return value
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

const CONFLICT_SECTION_SEPARATOR = '\0'

/**
 * `git merge-tree --write-tree -z` frames its output with NUL separators, so a path
 * containing a tab, a space, a newline, or a non-ASCII character survives intact and is
 * never quoted, trimmed, or filtered. The layout is:
 *
   <resulting tree OID> NUL <conflicted path> NUL ... NUL NUL <info sections>

 * The empty field that follows the path list is what ends it; the sections after it are
 * the human-readable explanation and are read separately for reporting only.
 */
function conflictFields(stdout) {
  const fields = stdout.split(CONFLICT_SECTION_SEPARATOR)
  const treeOid = fields[0] ?? ''
  const paths = []
  for (let index = 1; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === '') break
    paths.push(field)
  }
  const rest = fields.slice(indexOfEmpty(fields)).join(CONFLICT_SECTION_SEPARATOR)
  return { treeOid, paths, report: rest }
}

function indexOfEmpty(fields) {
  for (let index = 1; index < fields.length; index += 1) {
    if (fields[index] === '') return index
  }
  return fields.length
}

/** Every conflict-resolution step is at least this much work, even with no named path. */
const STRUCTURAL_CONFLICT_FLOOR = 1

/** Whether task-owned storage actually holds a commit for this ref. */
function hasCommit(repository, ref) {
  return git(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok
}

function shallowRepository(repository) {
  return git(repository, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true'
}

/**
 * `git merge-tree --write-tree` is a real three-way merge between two commits, run
 * entirely in the object database: no checkout, no index, no ref, no merge state, and
 * nothing left in progress afterwards. It does write the merge result's tree objects
 * into the repository it is pointed at, so it must be given task-owned storage.
 * A clean merge exits 0; a real content conflict exits 1 and names the conflicted
 * paths; any other failure means the probe could not run, which is an unknown, not a
 * clean result.
 *
 * It is not, however, free of the repository's configuration. A three-way merge runs the
 * merge driver a tracked `.gitattributes` entry assigns to a conflicting path, so a pair
 * whose `.gitattributes` names `merge=<name>` executes `merge.<name>.driver` - a program
 * named by configuration the task-owned storage inherited rather than one it holds, and
 * one whose side effects this probe cannot predict or undo. A driver that keeps one side
 * of the conflict returns a clean tree with the other side's content dropped, and a
 * high-confidence `0` for a pair that actually conflicts.
 *
 * So the configuration is read before the merge, not after it: a driver that is
 * configured *and* attributed to a path either side of this pair holds is reported, and
 * the pair is left unmeasured. Nothing is disabled and no configuration is overridden -
 * turning the driver off would measure a merge Git never performed. An unreadable
 * configuration or an unreadable set of attributes is the same answer, because "this
 * pair merges cleanly" is a claim those reads would have to support.
 *
 * Hooks are not consulted here, and that is a fact rather than an omission:
 * `git merge-tree` runs no hook, so a hook control would name a command this probe never
 * invokes.
 */
function probePair(repository, beforeRef, afterRef) {
  const pairPaths = [
    ...new Set([...treePaths(git, repository, beforeRef), ...treePaths(git, repository, afterRef)]),
  ]
  const controls = attributedDriverControls(git, repository, [beforeRef, afterRef], pairPaths)
  if (controls.length > 0) {
    return {
      kind: 'unknown',
      value: null,
      confidence: 'unknown',
      conflictingPaths: [],
      controls,
      reason: `the pair was not measured: ${controls
        .map((control) => `${control.control} = ${control.value}`)
        .join('; ')}`,
    }
  }
  const run = git(repository, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    beforeRef,
    afterRef,
  ])
  if (run.ok) {
    return { kind: 'pairwise-probe', value: 0, confidence: 'high', conflictingPaths: [] }
  }
  if (run.status === 1) {
    // Exit 1 is itself proof of a conflict, whatever the path list looks like. A pair
    // that conflicts with no named path still costs at least one resolution step, so
    // its value is a documented positive floor rather than a zero that would read as a
    // clean merge.
    const { treeOid, paths, report } = conflictFields(run.stdout)
    return {
      kind: 'measured-merge',
      value: Math.max(paths.length, STRUCTURAL_CONFLICT_FLOOR),
      confidence: 'high',
      conflictingPaths: paths,
      structuralConflict: true,
      resultTree: treeOid || null,
      report: report
        .split('\n')
        .filter((line) => line.includes('CONFLICT'))
        .slice(0, 20),
    }
  }
  return {
    kind: 'unknown',
    value: null,
    confidence: 'unknown',
    conflictingPaths: [],
    reason: `git merge-tree failed with status ${run.status}: ${(run.stderr || run.stdout).trim().slice(0, 400)}`,
  }
}

export function measureConflicts(raw) {
  if (!isPlainObject(raw)) {
    throw new InputError(
      'invalid-input',
      'the probe document must be a JSON object',
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
  const inside = git(repository, ['rev-parse', '--git-dir'])
  if (!inside.ok) {
    throw new InputError(
      'invalid-input',
      'repository is not a Git repository, so no probe can run',
      `git rev-parse failed in ${repository}`,
    )
  }
  const shallow = shallowRepository(repository)
  const pairs = Array.isArray(raw.pairs) ? raw.pairs : []

  const estimates = pairs.map((pair, index) => {
    if (!isPlainObject(pair)) {
      throw new InputError('invalid-input', `pairs[${index}] must be an object`, 'not an object')
    }
    const before = assertIdentity(pair.before, `pairs[${index}].before`)
    const after = assertIdentity(pair.after, `pairs[${index}].after`)
    const beforeRef = assertRefName(repository, pair.beforeRef, `pairs[${index}].beforeRef`)
    const afterRef = assertRefName(repository, pair.afterRef, `pairs[${index}].afterRef`)

    if (!hasCommit(repository, beforeRef)) {
      return {
        pair: [before, after],
        kind: 'unknown',
        value: null,
        confidence: 'unknown',
        conflictingPaths: [],
        reason: `${beforeRef} is not present in task-owned storage, so the pair could not be probed`,
      }
    }
    if (!hasCommit(repository, afterRef)) {
      return {
        pair: [before, after],
        kind: 'unknown',
        value: null,
        confidence: 'unknown',
        conflictingPaths: [],
        reason: `${afterRef} is not present in task-owned storage, so the pair could not be probed`,
      }
    }
    if (shallow) {
      return {
        pair: [before, after],
        kind: 'unknown',
        value: null,
        confidence: 'unknown',
        conflictingPaths: [],
        reason:
          'the repository is shallow, so a merge base may be outside the fetched history and the pair could not be probed',
      }
    }

    const probe = probePair(repository, beforeRef, afterRef)
    return {
      pair: [before, after],
      beforeRef,
      afterRef,
      ...probe,
    }
  })

  return {
    contractVersion: CONTRACT_VERSION,
    ok: true,
    repository,
    shallow,
    estimates,
    unknownEstimates: estimates.filter((estimate) => estimate.kind === 'unknown').length,
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
      'no probe document was supplied',
      'pass --input <file> or pipe the JSON document on stdin',
    )
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(
      [
        'measure-conflict.mjs [--input <file>]',
        '',
        'Runs read-only Git merge probes for ordered pairs of pull requests in a',
        'task-owned repository and writes { contractVersion, ok, estimates } to stdout.',
        'An unprobeable pair is reported as kind "unknown" with value null.',
        '',
      ].join('\n'),
    )
    return 0
  }
  let result
  try {
    result = measureConflicts(JSON.parse(readInput(argv)))
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
  return 0
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
