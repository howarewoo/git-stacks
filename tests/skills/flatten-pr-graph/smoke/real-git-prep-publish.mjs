#!/usr/bin/env node
/**
 * Exercises the shipped preparation and publication helpers against real Git repositories,
 * a real bare remote, and real merges.
 *
 * Proves the end-to-end local preparation -> atomic publication -> remote read-back path
 * executes cleanly using only real Git commands and the deterministic helpers.
 *
 * Usage: node tests/skills/flatten-pr-graph/smoke/real-git-prep-publish.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '../../../..')
const SKILL_SCRIPTS = join(REPOSITORY_ROOT, '.agents/skills/flatten-pr-graph/scripts')
const CONTRACT = 'flatten-pr-graph/1'

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.email=probe@example.com', '-c', 'user.name=Probe', ...args],
    { cwd, encoding: 'utf8' },
  ).trim()
}

/** Runs a shipped helper exactly as the skill tells an agent to: structured stdin in, JSON out. */
function helper(script, input) {
  const started = Date.now()
  try {
    const stdout = execFileSync('node', [join(SKILL_SCRIPTS, script)], {
      input: JSON.stringify({ contractVersion: CONTRACT, ...input }),
      encoding: 'utf8',
      cwd: REPOSITORY_ROOT,
    })
    const parsed = JSON.parse(stdout.trim())
    return { ...parsed, durationMs: Date.now() - started }
  } catch (error) {
    throw new Error(
      `helper ${script} failed: stdout=${error.stdout} stderr=${error.stderr} msg=${error.message}`,
    )
  }
}
function seedEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'flatten-prep-publish-smoke-'))
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  const runDir = join(root, 'task-run')

  // 1. Bare remote
  git(root, 'init', '--bare', '--quiet', '--initial-branch', 'main', remote)

  // 2. Working repository cloned from or pointing to remote
  git(root, 'init', '--quiet', '--initial-branch', 'main', repo)
  git(repo, 'remote', 'add', 'origin', remote)

  const commit = (path, content, message) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', message)
  }

  commit('README.md', '# demo repo\n', 'initial root commit')
  const rootSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'push', '--quiet', 'origin', 'main')

  // PR 12 branch
  git(repo, 'checkout', '--quiet', '-b', 'feat-a')
  commit('src/a.ts', 'export const a = 1\n', 'add a')
  const aSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'push', '--quiet', 'origin', 'feat-a')

  // PR 13 branch
  git(repo, 'checkout', '--quiet', 'main')
  git(repo, 'checkout', '--quiet', '-b', 'feat-b')
  commit('src/b.ts', 'export const b = 2\n', 'add b')
  const bSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'push', '--quiet', 'origin', 'feat-b')

  // Return to clean main
  git(repo, 'checkout', '--quiet', 'main')

  // Provider double backed by file so state persists across child processes
  const prsPath = join(root, 'prs.json')
  writeFileSync(
    prsPath,
    JSON.stringify(
      [
        [12, 'feat-a'],
        [13, 'feat-b'],
      ].map(([number, headRef]) => [
        number,
        {
          number,
          state: 'OPEN',
          draft: false,
          baseRef: 'main',
          headRef,
          headRepository: 'test/repo',
          title: `PR ${headRef}`,
          body: 'smoke fixture',
          labels: [],
          reviewers: [],
          autoMergeRequest: { enabled: false, method: null },
        },
      ]),
    ),
  )
  const pullRequests = JSON.parse(readFileSync(prsPath, 'utf8'))
    .map(([number, pr]) => [String(number), pr])
    .reduce((acc, [number, pr]) => Object.assign(acc, { [number]: pr }), {})
  const providerPath = join(root, 'provider.mjs')
  writeFileSync(
    providerPath,
    `import { readFileSync, writeFileSync } from 'node:fs'
const file = ${JSON.stringify(prsPath)}
function load() { return new Map(JSON.parse(readFileSync(file, 'utf8'))) }
function save(map) { writeFileSync(file, JSON.stringify([...map.entries()])) }
export function capabilities() {
  return { operations: ['read-pull-request', 'update-pull-request-base'], compareAndSwap: false, provider: 'smoke-double' }
}
export function readPullRequest(number) {
  const pr = load().get(number)
  return { ok: true, pullRequest: pr ? { ...pr } : null }
}
export function updatePullRequestBase(number, base, expectedBase) {
  const map = load()
  const pr = map.get(number)
  if (!pr) return { ok: false, applied: false }
  pr.baseRef = base
  save(map)
  return { ok: true, applied: true, preconditionMet: true }
}
`,
  )

  return { root, repo, remote, runDir, rootSha, aSha, bSha, providerPath, pullRequests, prsPath }
}

function main() {
  const observations = []
  const failures = []
  const env = seedEnvironment()

  try {
    // 1. Preparation
    const prepInput = {
      repository: env.repo,
      runDirectory: env.runDir,
      selection: [12, 13],
      order: [12, 13],
      root: { ref: 'refs/heads/main', oid: env.rootSha },
      heads: {
        12: 'refs/heads/feat-a',
        13: 'refs/heads/feat-b',
      },
      originalHeads: {
        12: env.aSha,
        13: env.bSha,
      },
      userWorkspace: env.repo,
    }

    const prepResult = helper('prepare-stack.mjs', prepInput)
    observations.push({
      step: 'prepare-stack',
      status: prepResult.status,
      ok: prepResult.ok,
      branches: prepResult.preparation?.branches?.length ?? 0,
      durationMs: prepResult.durationMs,
    })

    if (prepResult.status !== 'prepared') {
      failures.push(`preparation did not produce status 'prepared': ${prepResult.status}`)
    }
    if (!prepResult.preparation?.branches || prepResult.preparation.branches.length !== 2) {
      failures.push('preparation did not produce 2 prepared branches')
    }

    const prepBranch12 = prepResult.preparation?.branches?.[0]
    const prepBranch13 = prepResult.preparation?.branches?.[1]

    // 2. Publication
    const pubInput = {
      repository: join(env.runDir, 'storage.git'),
      remote: env.remote,
      runDirectory: join(env.runDir, 'publish'),
      preparationRunDirectory: env.runDir,
      order: [12, 13],
      selection: [12, 13],
      root: { ref: 'refs/heads/main', oid: env.rootSha },
      heads: {
        12: 'refs/heads/feat-a',
        13: 'refs/heads/feat-b',
      },
      intendedBases: {
        12: 'main',
        13: 'feat-a',
      },
      preparation: prepResult.preparation,
      pullRequests: env.pullRequests,
      authority: {
        intent: 'execute',
        selection: [12, 13],
        granted: ['ref-update', 'pr-base-update'],
        hostVerified: true,
      },
      provider: { module: env.providerPath },
    }

    const pubResult = helper('publish-stack.mjs', pubInput)
    observations.push({
      step: 'publish-stack',
      status: pubResult.status,
      ok: pubResult.ok,
      atomic: pubResult.capability?.atomicRefTransaction,
      attempts: pubResult.publication?.attempts?.length ?? 0,
      durationMs: pubResult.durationMs,
    })

    if (pubResult.status !== 'published') {
      failures.push(
        `publication did not produce status 'published': ${pubResult.status} errors: ${JSON.stringify(pubResult.errors)}`,
      )
    }

    // 3. Readback from remote bare repository
    const remoteA = git(env.remote, 'rev-parse', 'refs/heads/feat-a')
    const remoteB = git(env.remote, 'rev-parse', 'refs/heads/feat-b')
    observations.push({
      step: 'remote-readback',
      featA: remoteA === prepBranch12?.preparedHead ? 'matches-prepared' : 'mismatch',
      featB: remoteB === prepBranch13?.preparedHead ? 'matches-prepared' : 'mismatch',
    })

    if (remoteA !== prepBranch12?.preparedHead) {
      failures.push(
        `remote feat-a does not match prepared head: remote ${remoteA}, prepared ${prepBranch12?.preparedHead}`,
      )
    }
    if (remoteB !== prepBranch13?.preparedHead) {
      failures.push(
        `remote feat-b does not match prepared head: remote ${remoteB}, prepared ${prepBranch13?.preparedHead}`,
      )
    }

    // 4. Republish is safe no-op
    const repubResult = helper('publish-stack.mjs', {
      ...pubInput,
      runDirectory: join(env.runDir, 'republish'),
    })
    observations.push({
      step: 'republish-noop',
      status: repubResult.status,
      refUpdatesAttempted:
        repubResult.publication?.attempts?.filter((a) => a.kind === 'ref-update').length ?? 0,
      durationMs: repubResult.durationMs,
    })

    if (repubResult.status !== 'no-op') {
      failures.push(`republication did not report status 'no-op': ${repubResult.status}`)
    }

    // 5. Independent read-back of the provider's own state. The helper's claim about a
    //    base it wrote is not evidence; the file the double persists is.
    const afterBase = new Map(JSON.parse(readFileSync(env.prsPath, 'utf8')))
    observations.push({
      step: 'provider-readback',
      bases: [...afterBase.entries()].map(([number, pr]) => `${number}=${pr.baseRef}`).join(' '),
    })
    if (afterBase.get(13)?.baseRef !== 'feat-a') {
      failures.push(`#13 does not build on feat-a: ${afterBase.get(13)?.baseRef}`)
    }

    // 6. Resume boundary: the same plan against the run directory that already published
    //    is not a new attempt, and must not write again.
    const resumed = helper('publish-stack.mjs', { ...pubInput, resume: true })
    const resumedRefUpdates =
      resumed.publication?.attempts?.filter((attempt) => attempt.kind === 'ref-update').length ?? 0
    observations.push({
      step: 'resume-boundary',
      status: resumed.status,
      refUpdatesAttempted: resumedRefUpdates,
      durationMs: resumed.durationMs,
    })
    if (resumedRefUpdates > 0) {
      failures.push('a resume of a completed publication attempted another ref update')
    }
  } catch (error) {
    failures.push(`the smoke run threw: ${error.stack ?? error.message}`)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }

  process.stdout.write(`${JSON.stringify({ observations, failures }, null, 2)}\n`)
  return failures.length === 0 ? 0 : 1
}

process.exit(main())
