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
const { DirectGitHubTransport, setGitHubTransport } = await import('../src/main/github-transport')
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
          detailsUrl: runUrl,
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
    // The run id is what a rerun needs, and it is joined through the details link.
    assert.equal(report.checks[0]?.workflowRunId, 9001)
    assert.equal(report.summary, 'pending')
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
    git(harness, ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git'])
    await assert.rejects(
      getPullRequestChecks(harness.repo, PR_NUMBER, { headSha: head, base: 'main' }),
      /github\.com origin remote/,
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
      rulesets: { forbidden: true },
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
      rulesets: { contexts: [{ context: 'audit', branch: 'main' }] },
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
      rulesets: { contexts: [] },
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
