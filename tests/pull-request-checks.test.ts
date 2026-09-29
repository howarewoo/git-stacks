import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createGitHubHarness,
  type GitHubFixtureState,
  type GitHubHarness,
} from './fixtures/github-harness'

// Git Stacks captures Node's spawn API when its own modules load, and the GitHub
// harness answers `git` and `gh` on that API, so Git Stacks is loaded here.
// Nothing may reach `node:child_process` through an ESM import before the harness
// module body runs: the builtin facade keeps the export it first sees, so a
// static import above would hand Git Stacks the unpatched `execFile`.
const { execFileSync } = await import('node:child_process')
const { createGitHubApiDouble } = await import('./fixtures/github-api-double')
const { DirectGitHubTransport, GitHubTransportError, setGitHubTransport } =
  await import('../src/main/github-transport')
const { clearPullRequestChecksCache, getPullRequestChecks, rerunPullRequestCheck } =
  await import('../src/main/pull-request-checks')
const { classifyCheckRun, classifyCommitStatus, safeGitHubUrl, summariseCheckRollupState } =
  await import('../src/shared/pull-request-checks')

const PR_NUMBER = 501
/** A head this pull request does not have, used to prove runs are bound to the head. */
const OTHER_HEAD_SHA = 'b'.repeat(40)

function git(harness: GitHubHarness, args: string[]): string {
  return execFileSync(harness.env.GIT_STACKS_REAL_GIT || 'git', ['-C', harness.repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...harness.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function bareGit(harness: GitHubHarness, args: string[]): string {
  return execFileSync(
    harness.env.GIT_STACKS_REAL_GIT || 'git',
    ['--git-dir', harness.bare, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...harness.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()
}

/**
 * A repository with one open pull request, and the checks the case wants reported for
 * its real head commit. The head is returned rather than hard-coded so the checks are
 * attached to the commit GitHub would actually answer for. Branch protection is
 * opt-in: leaving it `null` is how a repository without admin read on branch
 * protection answers.
 */
async function setup(
  harness: GitHubHarness,
  checks: (headSha: string) => GitHubFixtureState['checks'],
): Promise<string> {
  git(harness, ['checkout', '-b', 'feature/checks'])
  git(harness, ['commit', '--allow-empty', '-m', 'checks work'])
  const oid = git(harness, ['rev-parse', 'feature/checks'])
  git(harness, ['push', harness.bare, 'feature/checks:refs/heads/feature/checks'])
  const state = await harness.readState()
  state.prs = [
    {
      number: PR_NUMBER,
      title: 'Checks work',
      body: '',
      base: 'main',
      head: 'feature/checks',
      headRepository: 'acme/widgets',
      draft: false,
      state: 'OPEN',
      checks: 'none',
      reviewDecision: null,
      mergeState: 'CLEAN',
      url: `https://github.com/acme/widgets/pull/${PR_NUMBER}`,
      headOid: oid,
      mergeOid: null,
      mergedAt: null,
    },
  ]
  state.checks = {
    actionsEnabled: true,
    viewerPermissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    ...checks(oid),
  }
  state.nextNumber = PR_NUMBER + 1
  await harness.writeState(state)
  return oid
}

async function withHarness(run: (harness: GitHubHarness) => Promise<void>): Promise<void> {
  const harness = await createGitHubHarness()
  const original = { ...process.env }
  setGitHubTransport(
    new DirectGitHubTransport({ token: 'fixture-token', fetch: createGitHubApiDouble() }),
  )
  try {
    for (const [key, value] of Object.entries(harness.env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await run(harness)
  } finally {
    setGitHubTransport(null)
    clearPullRequestChecksCache()
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key]
    }
    Object.assign(process.env, original)
    await harness.close()
  }
}

test('a required failure and an optional failure stay distinguishable in one report', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      requiredStatusChecks: { branch: 'main', contexts: ['build'] },
      checkRuns: [
        {
          id: 1,
          headSha: headSha,
          name: 'build',
          status: 'completed',
          conclusion: 'failure',
          appSlug: 'github-actions',
          title: 'build failed',
          detailsUrl: 'https://github.com/acme/widgets/runs/1',
          startedAt: '2026-02-04T09:00:00.000Z',
          completedAt: '2026-02-04T09:01:00.000Z',
        },
        {
          id: 2,
          headSha: headSha,
          name: 'lint',
          status: 'completed',
          conclusion: 'failure',
          appSlug: 'super-linter',
          title: 'two problems',
        },
      ],
    }))

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })

    const build = report.checks.find((check) => check.name === 'build')
    const lint = report.checks.find((check) => check.name === 'lint')
    assert.equal(build?.requirement, 'required')
    assert.equal(build?.state, 'failure')
    assert.equal(build?.source, 'check-run')
    assert.equal(lint?.requirement, 'informational')
    assert.equal(lint?.state, 'failure')
    // The reporting app is what tells a third-party check from a GitHub one.
    assert.equal(lint?.app, 'super-linter')
    assert.equal(build?.app, 'github-actions')
    assert.equal(report.rollup.requirementKnown, true)
    assert.equal(report.rollup.requiredFailing, 1)
    assert.equal(report.rollup.failing, 2)
    assert.equal(report.summary, 'failing')
    assert.equal(report.freshness, 'live')
    assert.equal(report.permissions.canRerun, true)
    assert.equal(report.rateLimit.remaining, 4998)
  })
})

test('a required context GitHub has not reported yet is shown as waiting, not absent', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      requiredStatusChecks: { branch: 'main', contexts: ['build', 'audit'] },
      checkRuns: [
        { id: 1, headSha: headSha, name: 'build', status: 'completed', conclusion: 'success' },
      ],
    }))

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })

    const expected = report.checks.find((check) => check.source === 'expected')
    assert.equal(expected?.name, 'audit')
    assert.equal(expected?.state, 'waiting')
    assert.equal(expected?.requirement, 'required')
    assert.equal(expected?.expected, true)
    // A required check that has not reported keeps the whole head pending.
    assert.equal(report.rollup.requiredPending, 1)
    assert.equal(report.summary, 'pending')
  })
})

test('unreadable branch protection leaves every requirement unknown instead of optional', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      requiredStatusChecks: null,
      checkRuns: [
        { id: 1, headSha: headSha, name: 'build', status: 'completed', conclusion: 'failure' },
      ],
    }))

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })

    assert.equal(report.rollup.requirementKnown, false)
    assert.equal(report.checks[0]?.requirement, 'unknown')
    // No readable rule means no "expected" rows are invented either.
    assert.equal(
      report.checks.some((check) => check.source === 'expected'),
      false,
    )
  })
})

test('an Actions run GitHub also reported as a check run is one check, not two', async () => {
  await withHarness(async (harness) => {
    const runUrl = 'https://github.com/acme/widgets/actions/runs/9001'
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        {
          id: 7,
          headSha: headSha,
          name: 'CI',
          status: 'in_progress',
          conclusion: null,
          appSlug: 'github-actions',
          detailsUrl: `${runUrl}/job/123`,
        },
      ],
      workflowRuns: [
        {
          id: 9001,
          headSha: headSha,
          name: 'CI',
          status: 'in_progress',
          conclusion: null,
          runNumber: 12,
          htmlUrl: runUrl,
        },
      ],
    }))

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })

    assert.equal(report.checks.length, 1)
    assert.equal(report.checks[0]?.source, 'check-run')
    // The suite identity joins the Actions job to its workflow despite different URLs.
    assert.equal(report.checks[0]?.workflowRunId, 9001)
    assert.equal(report.summary, 'pending')
  })
})

test('same-SHA workflows require PR association and third-party URLs cannot acquire rerun identity', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        {
          id: 80,
          headSha,
          name: 'Third party',
          appSlug: 'external-ci',
          appId: 700,
          checkSuiteId: 44,
          status: 'completed',
          conclusion: 'success',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/9800',
        },
      ],
      workflowRuns: [
        {
          id: 9800,
          headSha,
          name: 'Selected PR',
          checkSuiteId: 44,
          pullRequests: [PR_NUMBER],
          status: 'completed',
          conclusion: 'failure',
        },
        {
          id: 9801,
          headSha,
          name: 'Other PR',
          checkSuiteId: 45,
          pullRequests: [PR_NUMBER + 1],
          status: 'completed',
          conclusion: 'failure',
        },
        {
          id: 9802,
          headSha,
          name: 'Push CI',
          checkSuiteId: 46,
          pullRequests: [],
          event: 'push',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    }))
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      force: true,
    })
    assert.equal(report.checks.find((entry) => entry.name === 'Third party')?.workflowRunId, null)
    assert.equal(report.checks.find((entry) => entry.name === 'Selected PR')?.workflowRunId, 9800)
    assert.equal(
      report.checks.some((entry) => entry.name === 'Other PR'),
      false,
    )
    const push = report.checks.find((entry) => entry.name === 'Push CI')
    assert.equal(push?.workflowRunId, null)
    assert.match(push?.summary ?? '', /no pull request association/)
    for (const id of [9801, 9802]) {
      await assert.rejects(
        rerunPullRequestCheck(harness.repo, PR_NUMBER, id, { headSha: head }),
        /no longer belongs/,
      )
    }
    assert.deepEqual((await harness.readState()).checks?.reruns ?? [], [])
  })
})

test('effective required workflow rules leave requirements unknown', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      requiredStatusChecks: { branch: 'main', contexts: [] },
      branchRules: { branch: 'main', workflows: true },
      checkRuns: [
        { id: 1, headSha, name: 'Required workflow', status: 'completed', conclusion: 'success' },
      ],
    }))
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(
      report.checks.find((entry) => entry.name === 'Required workflow')?.requirement,
      'unknown',
    )
  })
})

test('an Actions run with no check run of its own is still listed as a workflow run', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      workflowRuns: [
        {
          id: 9002,
          headSha: headSha,
          name: 'Release',
          status: 'completed',
          conclusion: 'failure',
          runNumber: 4,
          htmlUrl: 'https://github.com/acme/widgets/actions/runs/9002',
        },
      ],
    }))

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })

    assert.equal(report.checks.length, 1)
    assert.equal(report.checks[0]?.source, 'workflow-run')
    assert.equal(report.checks[0]?.state, 'failure')
    assert.equal(report.checks[0]?.workflowRunId, 9002)
    assert.equal(report.checks[0]?.detailsUrl, 'https://github.com/acme/widgets/actions/runs/9002')
  })
})

test('legacy commit statuses are read through their own vocabulary, and unsafe links are dropped', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      commitStatuses: [
        {
          headSha: headSha,
          context: 'vercel/preview',
          state: 'pending',
          description: 'Building',
        },
        {
          headSha: headSha,
          context: 'external/audit',
          state: 'error',
          description: 'Scanner failed',
          targetUrl: 'https://scanner.example.com/report/1',
        },
      ],
    }))

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })

    const preview = report.checks.find((check) => check.name === 'vercel/preview')
    const audit = report.checks.find((check) => check.name === 'external/audit')
    assert.equal(preview?.source, 'commit-status')
    assert.equal(preview?.state, 'queued')
    assert.equal(audit?.state, 'failure')
    assert.equal(audit?.summary, 'Scanner failed')
    // A third-party host is never handed to the external-open bridge.
    assert.equal(audit?.detailsUrl, null)
    assert.equal(report.summary, 'failing')
  })
})

test('a second read inside the minimum interval serves the remembered report as cached', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        { id: 1, headSha: headSha, name: 'build', status: 'completed', conclusion: 'success' },
      ],
    }))

    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    const before = (await harness.readState()).requests.length
    const second = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    const after = (await harness.readState()).requests.length

    assert.equal(first.freshness, 'live')
    assert.equal(second.freshness, 'cached')
    assert.equal(second.staleReason, null)
    assert.deepEqual(second.checks, first.checks)
    assert.equal(after, before, 'a cached report must not re-read GitHub')
  })
})

test('a refresh GitHub refuses keeps the last good report, marks it stale, and backs off', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        { id: 1, headSha: headSha, name: 'build', status: 'completed', conclusion: 'failure' },
      ],
    }))
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(first.freshness, 'live')

    // The next read is refused by GitHub, so the report cannot be replaced.
    const state = await harness.readState()
    state.lostResponses = [
      { method: 'GET', pathIncludes: '/check-runs', status: 403, message: 'Forbidden' },
    ]
    await harness.writeState(state)
    const failed = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })

    assert.equal(failed.available, true)
    assert.equal(failed.freshness, 'stale')
    assert.match(failed.staleReason ?? '', /refused the read/)
    // The checks behind the stale label are the last ones GitHub did report.
    assert.deepEqual(failed.checks, first.checks)
    assert.equal(failed.rollup.failing, 1)
    assert.ok(failed.nextAttemptAt, 'a backed-off report states when the next read may happen')

    const backedOff = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(backedOff.freshness, 'stale')
    // Forcing a refresh does not shorten the backoff GitHub asked for.
    assert.equal(backedOff.checkedAt, failed.checkedAt)
    assert.equal(backedOff.checkedAt, first.fetchedAt)
  })
})

test('a rate-limited refresh names the rate limit and the remaining budget', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        { id: 1, headSha: headSha, name: 'build', status: 'completed', conclusion: 'success' },
      ],
    }))
    await getPullRequestChecks(harness.repo, PR_NUMBER, { headSha: head, base: 'main' })

    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'GET',
        pathIncludes: '/check-runs',
        status: 403,
        message: 'API rate limit exceeded for 203.0.113.7.',
      },
    ]
    await harness.writeState(state)
    const limited = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })

    assert.equal(limited.freshness, 'stale')
    assert.match(limited.staleReason ?? '', /rate limit was reached/)
    assert.equal(limited.rateLimit.remaining, 4998)
  })
})

test('an unchanged head re-read conditionally and is reported as confirmed, not re-fetched', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      conditional: true,
      checkRuns: [
        { id: 1, headSha: headSha, name: 'build', status: 'completed', conclusion: 'success' },
      ],
    }))

    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    const conditional = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })

    assert.equal(first.freshness, 'live')
    assert.equal(conditional.freshness, 'not-modified')
    // GitHub confirmed the remembered content in this call, so it is not stale.
    assert.equal(conditional.staleReason, null)
    assert.deepEqual(conditional.checks, first.checks)
    const conditionalRequests = (await harness.readState()).requests.filter((entry) =>
      entry.argv[0]?.includes('check-runs'),
    )
    assert.equal(conditionalRequests.length, 2)
  })
})

test('a moved head discards the remembered report instead of showing the previous head checks', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        { id: 1, headSha: headSha, name: 'build', status: 'completed', conclusion: 'failure' },
      ],
    }))
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(first.rollup.failing, 1)

    git(harness, ['commit', '--allow-empty', '-m', 'more checks work'])
    const moved = git(harness, ['rev-parse', 'feature/checks'])
    git(harness, ['push', harness.bare, 'feature/checks:refs/heads/feature/checks'])
    assert.notEqual(moved, head)
    const state = await harness.readState()
    state.checks = { ...state.checks, checkRuns: [] }
    await harness.writeState(state)

    const second = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: moved,
      base: 'main',
    })
    assert.equal(second.headSha, moved)
    assert.equal(second.freshness, 'live')
    assert.equal(second.checks.length, 0)
    assert.equal(second.summary, 'none')
  })
})

test('an unreadable remote origin is refused before any GitHub read', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, () => ({}))
    // An origin that names no host at all. A host name is a candidate GitHub
    // host, so the refusal belongs to an origin there is no host to read from.
    git(harness, ['remote', 'set-url', 'origin', '/srv/git/widgets.git'])
    const before = (await harness.readState()).requests.length
    await assert.rejects(
      getPullRequestChecks(harness.repo, PR_NUMBER, { headSha: head, base: 'main' }),
    )
    assert.equal(
      (await harness.readState()).requests.length,
      before,
      'nothing is read from a repository with no host to read it from',
    )
  })
})

test('a viewer without a write role is offered no rerun, and the run is never posted', async () => {
  await withHarness(async (harness) => {
    const runUrl = 'https://github.com/acme/widgets/actions/runs/9100'
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        {
          id: 1,
          headSha: headSha,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          appSlug: 'github-actions',
          detailsUrl: runUrl,
        },
      ],
      workflowRuns: [
        {
          id: 9100,
          headSha: headSha,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: runUrl,
        },
      ],
    }))
    const state = await harness.readState()
    state.checks = {
      ...state.checks,
      viewerPermissions: { admin: false, maintain: false, push: false, triage: true, pull: true },
    }
    await harness.writeState(state)

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(report.permissions.canRerun, false)
    assert.match(report.permissions.reason, /role/)

    await assert.rejects(
      rerunPullRequestCheck(harness.repo, PR_NUMBER, 9100, { headSha: head }),
      /role on this repository/,
    )
    const after = await harness.readState()
    assert.deepEqual(after.checks?.reruns ?? [], [])
  })
})

test('a repository with Actions disabled offers no rerun', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      workflowRuns: [
        {
          id: 9200,
          headSha: headSha,
          name: 'CI',
          status: 'queued',
          conclusion: null,
          htmlUrl: 'https://github.com/acme/widgets/actions/runs/9200',
        },
      ],
    }))
    const state = await harness.readState()
    state.checks = { ...state.checks, actionsEnabled: false }
    await harness.writeState(state)

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(report.permissions.actionsEnabled, false)
    assert.equal(report.permissions.canRerun, false)
    assert.match(report.permissions.reason, /disabled/i)
  })
})

test('rerunning a permitted workflow run re-reads the head and reports the run again', async () => {
  await withHarness(async (harness) => {
    const runUrl = 'https://github.com/acme/widgets/actions/runs/9300'
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        {
          id: 1,
          headSha: headSha,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          appSlug: 'github-actions',
          detailsUrl: runUrl,
        },
      ],
      workflowRuns: [
        {
          id: 9300,
          headSha: headSha,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: runUrl,
        },
      ],
    }))

    const report = await rerunPullRequestCheck(harness.repo, PR_NUMBER, 9300, {
      headSha: head,
    })

    assert.equal(report.freshness, 'live')
    assert.equal(report.checks[0]?.workflowRunId, 9300)
    const state = await harness.readState()
    assert.deepEqual(state.checks?.reruns, [9300])
  })
})

test('rerunning a run that belongs to another head is refused without a mutation', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      workflowRuns: [
        {
          id: 9400,
          headSha: OTHER_HEAD_SHA,
          name: 'Other branch CI',
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: 'https://github.com/acme/widgets/actions/runs/9400',
        },
      ],
    }))

    await assert.rejects(
      rerunPullRequestCheck(harness.repo, PR_NUMBER, 9400, { headSha: head }),
      /no longer belongs to this pull request head/,
    )
    const state = await harness.readState()
    assert.deepEqual(state.checks?.reruns ?? [], [])
  })
})

test('a rerun the repository refuses is reported as a refusal, not a silent no-op', async () => {
  await withHarness(async (harness) => {
    const runUrl = 'https://github.com/acme/widgets/actions/runs/9500'
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        {
          id: 1,
          headSha: headSha,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          appSlug: 'github-actions',
          detailsUrl: runUrl,
        },
      ],
      workflowRuns: [
        {
          id: 9500,
          headSha: headSha,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: runUrl,
        },
      ],
      rerunForbidden: true,
    }))

    await assert.rejects(
      rerunPullRequestCheck(harness.repo, PR_NUMBER, 9500, { headSha: head }),
      /refused the read/,
    )
  })
})

test('the row badge and the drill-down read the same state vocabulary', () => {
  // GitHub's own aggregate vocabulary, including the values that are neither a
  // success nor a failure this build recognises.
  assert.equal(summariseCheckRollupState('SUCCESS'), 'passing')
  assert.equal(summariseCheckRollupState('FAILURE'), 'failing')
  assert.equal(summariseCheckRollupState('ERROR'), 'failing')
  assert.equal(summariseCheckRollupState('PENDING'), 'pending')
  assert.equal(summariseCheckRollupState('EXPECTED'), 'pending')
  assert.equal(summariseCheckRollupState('SOMETHING_NEW'), 'pending')
  assert.equal(summariseCheckRollupState(undefined), 'pending')
})

test('every GitHub state maps to the state the drill-down shows', () => {
  assert.equal(classifyCheckRun('queued', null), 'queued')
  assert.equal(classifyCheckRun('in_progress', null), 'in-progress')
  assert.equal(classifyCheckRun('waiting', null), 'waiting')
  assert.equal(classifyCheckRun('requested', null), 'queued')
  assert.equal(classifyCheckRun('completed', 'success'), 'success')
  assert.equal(classifyCheckRun('completed', 'action_required'), 'action-required')
  assert.equal(classifyCheckRun('completed', 'cancelled'), 'cancelled')
  assert.equal(classifyCheckRun('completed', 'skipped'), 'skipped')
  assert.equal(classifyCheckRun('completed', 'neutral'), 'neutral')
  assert.equal(classifyCheckRun('completed', 'timed_out'), 'failure')
  assert.equal(classifyCheckRun('completed', 'stale'), 'failure')
  // An unrecognised pair is unknown, never a pass.
  assert.equal(classifyCheckRun('completed', 'brand_new'), 'unknown')
  assert.equal(classifyCheckRun('brand_new', null), 'unknown')
  assert.equal(classifyCommitStatus('success'), 'success')
  assert.equal(classifyCommitStatus('pending'), 'queued')
  assert.equal(classifyCommitStatus('error'), 'failure')
  assert.equal(classifyCommitStatus('expected'), 'waiting')
  assert.equal(classifyCommitStatus('brand_new'), 'unknown')
})

test('only plain github.com details links are ever offered', () => {
  assert.equal(
    safeGitHubUrl('https://github.com/acme/widgets/runs/1'),
    'https://github.com/acme/widgets/runs/1',
  )
  assert.equal(safeGitHubUrl('http://github.com/acme/widgets/runs/1'), null)
  assert.equal(safeGitHubUrl('https://github.com.evil.example/runs/1'), null)
  assert.equal(safeGitHubUrl('https://user:token@github.com/runs/1'), null)
  assert.equal(safeGitHubUrl('https://github.com:8443/runs/1'), null)
  assert.equal(safeGitHubUrl('javascript:alert(1)'), null)
  assert.equal(safeGitHubUrl(''), null)
  assert.equal(safeGitHubUrl(undefined), null)
})

test('the read follows the pull request head when the caller does not supply one', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        { id: 1, headSha: headSha, name: 'build', status: 'completed', conclusion: 'success' },
      ],
    }))
    // The head GitHub reports for the pull request is the commit the checks are on.
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/feature/checks']), head)

    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, { base: 'main' })
    assert.equal(report.headSha, head)
    assert.equal(report.freshness, 'live')
    assert.deepEqual(
      report.checks.map((check) => check.name),
      ['build'],
    )
  })
})

test('a rerun is refused with no request posted when the head moved after the report was read', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        {
          id: 1,
          headSha,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          appSlug: 'github-actions',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/9500',
        },
      ],
      workflowRuns: [
        {
          id: 9500,
          headSha,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: 'https://github.com/acme/widgets/actions/runs/9500',
        },
      ],
    }))
    // The renderer read this head, then the branch moved before the button was pressed.
    git(harness, ['commit', '--allow-empty', '-m', 'moved under the button'])
    const moved = git(harness, ['rev-parse', 'feature/checks'])
    git(harness, ['push', harness.bare, 'feature/checks:refs/heads/feature/checks'])
    assert.notEqual(moved, head)

    await assert.rejects(
      rerunPullRequestCheck(harness.repo, PR_NUMBER, 9500, { headSha: head }),
      /moved to a new head commit/,
    )
    const state = await harness.readState()
    assert.deepEqual(state.checks?.reruns ?? [], [])
  })
})

test('a pull request that cannot be re-read is served stale and offers no rerun', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [{ id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success' }],
    }))
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(first.freshness, 'live')

    // Identity is proved by reading the pull request, so refusing that read has to
    // reach the report: otherwise a read GitHub could not confirm looks current.
    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'GET',
        pathIncludes: `/pulls/${PR_NUMBER}`,
        status: 403,
        message: 'Forbidden',
      },
    ]
    await harness.writeState(state)

    const second = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      force: true,
    })
    assert.equal(second.headSha, head)
    assert.equal(second.freshness, 'stale')
    assert.match(second.staleReason ?? '', /could not be re-read/)
    assert.equal(second.permissions.canRerun, false)
    assert.equal(second.checks.length, 1)
  })
})

test('an unreadable rulesets read leaves every requirement unknown rather than optional', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      // Branch protection is readable and requires nothing this head reported, so only
      // the ruleset read can tell a required check from an optional one here.
      requiredStatusChecks: { branch: 'main', contexts: [] },
      branchRules: { branch: 'main', forbidden: true },
      checkRuns: [{ id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success' }],
    }))
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(report.rollup.requirementKnown, false)
    assert.equal(report.checks[0]?.requirement, 'unknown')
  })
})

test('a ruleset-required check no readable API reported is still shown as required', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      requiredStatusChecks: { branch: 'main', contexts: [] },
      branchRules: { branch: 'main', required: [{ context: 'audit' }] },
      checkRuns: [{ id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success' }],
    }))
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(report.rollup.requirementKnown, true)
    const expected = report.checks.find((check) => check.name === 'audit')
    assert.equal(expected?.requirement, 'required')
    assert.equal(expected?.state, 'waiting')
    assert.equal(report.rollup.requiredTotal, 1)
  })
})

test('a required context bound to one app is not satisfied by another app check of the same name', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      // Branch protection binds the required context to one app, id 1.
      requiredStatusChecks: { branch: 'main', contexts: ['build'], appIds: { build: 1 } },
      branchRules: { branch: 'main', required: [] },
      checkRuns: [
        {
          id: 1,
          headSha,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          appSlug: 'someone-elses-bot',
          appId: 99,
        },
      ],
    }))
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    // The required context is bound to app 1 and this check reports as app 99, so it is
    // not the required one: it stays informational and the context is still outstanding.
    const reported = report.checks.find((check) => check.name === 'build')
    assert.equal(reported?.requirement, 'informational')
    assert.equal(
      report.checks.some((check) => check.expected && check.requirement === 'required'),
      true,
    )
  })
})

test('check runs past the first page are read rather than silently dropped', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => {
      // More than one page at the read's page size, so a single-page read would omit some.
      const runs = Array.from({ length: 101 }, (_unused, index) => ({
        id: 1000 + index,
        headSha,
        name: `check ${index}`,
        status: 'completed',
        conclusion: 'success',
      }))
      return { checkRuns: runs }
    })
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(report.checks.length, 101)
    assert.equal(report.truncated, false)
  })
})

test('a report the page bound cut short says so instead of claiming to be the whole list', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => {
      // Ten full pages is the bound; an eleventh full page means more exists.
      const runs = Array.from({ length: 1000 + 1 }, (_unused, index) => ({
        id: 2000 + index,
        headSha,
        name: `check ${index}`,
        status: 'completed',
        conclusion: 'success',
      }))
      return { checkRuns: runs }
    })
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(report.checks.length, 1000)
    assert.equal(report.truncated, true)
  })
})

test('a change on a later page is read even when the first page validator is unchanged', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => {
      const firstPage = Array.from({ length: 100 }, (_unused, index) => ({
        id: 3000 + index,
        headSha,
        name: `check ${index}`,
        status: 'completed',
        conclusion: 'success',
      }))
      return { conditional: true, checkRuns: firstPage }
    })
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(first.freshness, 'live')
    assert.equal(first.checks.length, 100)

    // Only the second page changes. A reader that treated the first page's 304 as proof
    // about the whole collection would keep reporting a head with no failure.
    const state = await harness.readState()
    state.checks = {
      ...state.checks,
      checkRuns: [
        ...(state.checks?.checkRuns ?? []),
        {
          id: 4000,
          headSha: head,
          name: 'check on page two',
          status: 'completed',
          conclusion: 'failure',
        },
      ],
    }
    await harness.writeState(state)

    const second = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(second.freshness, 'live')
    assert.equal(second.checks.length, 101)
    const found = second.checks.find((check) => check.name === 'check on page two')
    assert.equal(found?.state, 'failure')
    assert.equal(second.rollup.failing, 1)
  })
})

test('two rules requiring one context from two apps are two requirements, not one', async () => {
  await withHarness(async (harness) => {
    // GitHub enforces every applicable rule and the most restrictive wins, so a
    // repository rule and an organisation rule that both require `build` each have to
    // be satisfied.
    const onlyFirst = await setup(harness, (headSha) => ({
      requiredStatusChecks: { branch: 'main', contexts: ['build'], appIds: { build: 1 } },
      branchRules: { branch: 'main', required: [{ context: 'build', integrationId: 2 }] },
      checkRuns: [
        {
          id: 1,
          headSha,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          appSlug: 'repo-bot',
          appId: 1,
        },
      ],
    }))
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: onlyFirst,
      base: 'main',
    })
    const reported = first.checks.find((check) => check.source === 'check-run')
    assert.equal(reported?.requirement, 'required')
    // App 1's report satisfies its own rule and nothing else, so the second rule is
    // still outstanding and is reported as its own waiting check.
    const outstanding = first.checks.filter((check) => check.source === 'expected')
    assert.equal(outstanding.length, 1)
    assert.equal(outstanding[0]?.name, 'build')
    assert.equal(outstanding[0]?.appId, 2)
    assert.equal(outstanding[0]?.state, 'waiting')
    assert.equal(first.rollup.requiredTotal, 2)
    assert.equal(first.rollup.requiredPending, 1)
    assert.equal(first.rollup.requiredFailing, 0)

    // With both apps reporting, no requirement is outstanding.
    const state = await harness.readState()
    state.checks = {
      ...state.checks,
      checkRuns: [
        ...(state.checks?.checkRuns ?? []),
        {
          id: 2,
          headSha: onlyFirst,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          appSlug: 'org-bot',
          appId: 2,
        },
      ],
    }
    await harness.writeState(state)
    const second = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: onlyFirst,
      base: 'main',
      force: true,
    })
    assert.equal(
      second.checks.some((check) => check.source === 'expected'),
      false,
    )
    assert.equal(second.rollup.requiredTotal, 2)
    assert.equal(second.rollup.requiredPending, 0)
    assert.equal(second.rollup.requiredFailing, 0)
  })
})

test('an unbound requirement does not loosen a bound one', async () => {
  await withHarness(async (harness) => {
    // One rule requires `build` from any app, another requires `lint` bound to app 2.
    // The unbound rule must not let an app 1 lint check stand in for the bound one.
    const head = await setup(harness, (headSha) => ({
      // An admin viewer, so a 404 from branch protection is an answer: this branch
      // carries none, and only the effective rules below require anything.
      viewerPermissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      branchRules: {
        branch: 'main',
        required: [
          { context: 'build', integrationId: null },
          { context: 'lint', integrationId: 2 },
        ],
      },
      checkRuns: [
        { id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success', appId: 9 },
        {
          id: 2,
          headSha,
          name: 'lint',
          status: 'completed',
          conclusion: 'failure',
          appSlug: 'other-bot',
          appId: 1,
        },
      ],
    }))
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    const build = report.checks.find((check) => check.name === 'build')
    assert.equal(build?.requirement, 'required')
    // The app 1 lint check is not the required app 2 lint, so it is informational and
    // the required app 2 lint is still outstanding.
    const lint = report.checks.find(
      (check) => check.source === 'check-run' && check.name === 'lint',
    )
    assert.equal(lint?.requirement, 'informational')
    const outstanding = report.checks.filter((check) => check.source === 'expected')
    assert.deepEqual(
      outstanding.map((check) => [check.name, check.appId]),
      [['lint', 2]],
    )
  })
})

test('a branch protection 404 only answers for a viewer who may read protection', async () => {
  await withHarness(async (harness) => {
    // GitHub answers 404 both for an unprotected branch and for one whose protection
    // the viewer may not read. A non-admin cannot tell those apart, so the required set
    // must stay unknown rather than present the readable ruleset as the whole answer.
    const head = await setup(harness, (headSha) => ({
      viewerPermissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
      branchRules: { branch: 'main', required: [{ context: 'build', integrationId: 2 }] },
      checkRuns: [
        { id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success', appId: 2 },
      ],
    }))
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(report.rollup.requirementKnown, false)
    assert.equal(
      report.checks.every((check) => check.requirement === 'unknown'),
      true,
    )
    assert.equal(
      report.checks.some((check) => check.source === 'expected'),
      false,
    )
  })
})

test('a refresh re-reads which head the pull request has, not the head the caller was given', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [
        {
          id: 1,
          headSha,
          name: 'build',
          status: 'completed',
          conclusion: 'failure',
          appSlug: 'github-actions',
          appId: 15368,
        },
      ],
    }))
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(first.freshness, 'live')
    assert.equal(first.headSha, head)

    // The pull request advances on GitHub while the renderer still shows the old head,
    // which is exactly what the renderer sends with every refresh.
    git(harness, ['checkout', 'feature/checks'])
    git(harness, ['commit', '--allow-empty', '-m', 'advance the pull request'])
    git(harness, ['push', harness.bare, 'feature/checks:refs/heads/feature/checks'])
    const nextHead = git(harness, ['rev-parse', 'feature/checks'])
    const state = await harness.readState()
    state.checks = {
      ...state.checks,
      checkRuns: [
        {
          id: 2,
          headSha: nextHead,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          appSlug: 'github-actions',
          appId: 15368,
        },
      ],
    }
    await harness.writeState(state)

    const refreshed = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(refreshed.headSha, nextHead)
    assert.equal(refreshed.freshness, 'live')
    assert.deepEqual(
      refreshed.checks.map((check) => check.state),
      ['success'],
    )
    // The previous head's failing check is gone rather than still shown as current.
    assert.equal(
      refreshed.checks.some((check) => check.state === 'failure'),
      false,
    )
  })
})

test('a bounded list that GitHub confirms page by page stays reported as cut short', async () => {
  await withHarness(async (harness) => {
    // Eleven full pages of check runs: more than the ten-page bound this read follows.
    const head = await setup(harness, (headSha) => ({
      conditional: true,
      checkRuns: Array.from({ length: 1_100 }, (_unused, index) => ({
        id: 5_000 + index,
        headSha,
        name: `check ${index}`,
        status: 'completed',
        conclusion: 'success',
      })),
    }))
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(first.truncated, true)
    assert.equal(first.checks.length, 1_000)

    // Nothing changed, so every page answers 304 - including the full tenth page, which
    // is still where the read stopped.
    const confirmed = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(confirmed.freshness, 'not-modified')
    assert.equal(confirmed.truncated, true)
  })
})

test('a page that regrows is read rather than dropped behind a stale validator', async () => {
  await withHarness(async (harness) => {
    const firstPage = (headSha: string) =>
      Array.from({ length: 100 }, (_unused, index) => ({
        id: 6_000 + index,
        headSha,
        name: `first page ${index}`,
        status: 'completed' as const,
        conclusion: 'success' as const,
      }))
    const secondPage = (headSha: string) => [
      {
        id: 7_000,
        headSha,
        name: 'second page check',
        status: 'completed' as const,
        conclusion: 'failure' as const,
      },
    ]
    const head = await setup(harness, (headSha) => ({
      conditional: true,
      checkRuns: [...firstPage(headSha), ...secondPage(headSha)],
    }))
    const full = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(full.checks.length, 101)

    // The collection shrinks to one page, so the second page's body is gone.
    const shrunk = await harness.readState()
    shrunk.checks = { ...shrunk.checks, checkRuns: firstPage(head) }
    await harness.writeState(shrunk)
    const one = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(one.checks.length, 100)

    // It regrows with exactly the page that was there before, so its old validator would
    // match again if the cache still carried it.
    const regrown = await harness.readState()
    regrown.checks = { ...regrown.checks, checkRuns: [...firstPage(head), ...secondPage(head)] }
    await harness.writeState(regrown)
    const two = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(two.checks.length, 101)
    assert.equal(two.truncated, false)
    assert.equal(
      two.checks.some((check) => check.name === 'second page check' && check.state === 'failure'),
      true,
    )
  })
})

test('an unreadable required-check policy is reported as unknown even with no checks at all', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, () => ({
      // Neither policy read is answerable: branch protection 404s for a viewer who may
      // not read it, and the effective rules are refused outright.
      viewerPermissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
      requiredStatusChecks: null,
      branchRules: { branch: 'main', forbidden: true },
      checkRuns: [],
    }))
    const report = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(report.checks.length, 0)
    assert.equal(report.summary, 'none')
    // Nothing reported, so no row could carry the policy: the rollup still has to say the
    // required set was never read rather than "0 required of 0 checks".
    assert.equal(report.rollup.requirementKnown, false)
    assert.equal(report.rollup.requiredTotal, 0)
  })
})

test('a rate-limited read waits for GitHub’s deadline, even when nothing was ever read', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [{ id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success' }],
    }))
    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'GET',
        pathIncludes: '/check-runs',
        status: 403,
        message: 'API rate limit exceeded for 203.0.113.7.',
      },
    ]
    await harness.writeState(state)

    const before = Date.now()
    const failed = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(failed.available, false)
    // The local backoff alone would be two seconds; GitHub's own reset is the deadline.
    const deadline = Date.parse(failed.nextAttemptAt ?? '')
    assert.ok(deadline - before >= 60_000, `next attempt at ${failed.nextAttemptAt}`)

    // A forced refresh inside that window must not ask GitHub again.
    const requestsBefore = (await harness.readState()).requests.length
    const again = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(again.available, false)
    assert.equal(again.nextAttemptAt, failed.nextAttemptAt)
    assert.match(again.message, /rate limit was reached/)
    assert.equal((await harness.readState()).requests.length, requestsBefore)
  })
})

test('a refresh the caller abandons stops instead of finishing work nobody is waiting for', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      conditional: true,
      checkRuns: [{ id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success' }],
    }))
    const controller = new AbortController()
    controller.abort()
    const abandoned = getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
      signal: controller.signal,
    })
    await assert.rejects(
      abandoned,
      (error: unknown) => error instanceof GitHubTransportError && error.kind === 'cancelled',
    )

    // The abandoned read left nothing behind: the next refresh reads for real.
    const after = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(after.freshness, 'live')
    assert.equal(after.headSha, head)
  })
})

test('a rate-limited identity read stops the call and leaves the deadline behind', async () => {
  await withHarness(async (harness) => {
    // No report has ever been read, so the pull request itself is the first request.
    const head = await setup(harness, (headSha) => ({
      checkRuns: [{ id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success' }],
    }))
    const state = await harness.readState()
    state.lostResponses = [
      {
        method: 'GET',
        pathIncludes: `/pulls/${PR_NUMBER}`,
        status: 429,
        message: 'You have exceeded a secondary rate limit.',
      },
    ]
    await harness.writeState(state)

    const before = Date.now()
    const refused = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(refused.available, false)
    assert.equal(refused.checks.length, 0)
    const deadline = Date.parse(refused.nextAttemptAt ?? '')
    assert.ok(deadline - before >= 60_000, `next attempt at ${refused.nextAttemptAt}`)

    // The call stops at the refusal: nothing is asked about the commit's checks.
    const askedAboutChecks = (await harness.readState()).requests.some((entry) =>
      entry.argv.some((part) => String(part).includes('/check-runs')),
    )
    assert.equal(askedAboutChecks, false)

    // And the next refresh inside the deadline is served from it, not from GitHub.
    const requestsBefore = (await harness.readState()).requests.length
    const again = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(again.available, false)
    assert.equal(again.nextAttemptAt, refused.nextAttemptAt)
    assert.equal((await harness.readState()).requests.length, requestsBefore)
  })
})

test('a rate-limited identity read serves the last report stale and asks nothing else', async () => {
  await withHarness(async (harness) => {
    const head = await setup(harness, (headSha) => ({
      checkRuns: [{ id: 1, headSha, name: 'build', status: 'completed', conclusion: 'success' }],
    }))
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(first.freshness, 'live')

    const state = await harness.readState()
    const requestsAtRefusal = state.requests.length
    state.lostResponses = [
      {
        method: 'GET',
        pathIncludes: `/pulls/${PR_NUMBER}`,
        status: 429,
        message: 'You have exceeded a secondary rate limit.',
      },
    ]
    await harness.writeState(state)

    const before = Date.now()
    const refused = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(refused.freshness, 'stale')
    assert.deepEqual(
      refused.checks.map((check) => check.name),
      ['build'],
    )
    assert.match(refused.staleReason ?? '', /could not be re-read from GitHub/)
    // A head nobody confirmed cannot authorise a rerun.
    assert.equal(refused.permissions.canRerun, false)
    assert.match(refused.permissions.reason, /could not be re-read/)
    const deadline = Date.parse(refused.nextAttemptAt ?? '')
    assert.ok(deadline - before >= 60_000, `next attempt at ${refused.nextAttemptAt}`)

    // The refusal is the only thing asked after it: no check runs, no commit status, no
    // workflow runs, even though the report could have kept going.
    const after = await harness.readState()
    const asked = after.requests.slice(requestsAtRefusal).map((entry) => entry.argv.join(' '))
    assert.equal(asked.length, 1)
    assert.match(asked[0] ?? '', new RegExp(`/pulls/${PR_NUMBER} GET$`))
    const requestsBefore = after.requests.length
    const again = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(again.freshness, 'stale')
    assert.equal(again.nextAttemptAt, refused.nextAttemptAt)
    assert.equal((await harness.readState()).requests.length, requestsBefore)
  })
})

test('a complete list that ends before the page bound is not called truncated', async () => {
  await withHarness(async (harness) => {
    // 901 entries fill nine pages and leave one on the tenth, so every entry was read
    // even though the read walked to the tenth page.
    const head = await setup(harness, (headSha) => ({
      conditional: true,
      checkRuns: Array.from({ length: 901 }, (_unused, index) => ({
        id: 8_000 + index,
        headSha,
        name: `check ${index}`,
        status: 'completed',
        conclusion: 'success',
      })),
    }))
    const first = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
    })
    assert.equal(first.checks.length, 901)
    assert.equal(first.truncated, false)

    // Nothing changed, so the tenth page answers 304 as well. Its cached body is one
    // entry short of a full page, which is still the whole list.
    const confirmed = await getPullRequestChecks(harness.repo, PR_NUMBER, {
      headSha: head,
      base: 'main',
      force: true,
    })
    assert.equal(confirmed.freshness, 'not-modified')
    assert.equal(confirmed.checks.length, 901)
    assert.equal(confirmed.truncated, false)
  })
})
