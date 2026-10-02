import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { GitHubTransportError } from '../src/main/github-transport'
import type { GitHubFixtureState } from './fixtures/github-harness'
import { ControlledLiveTarget, resolveRealGit } from './live/targets'

test('foreign topics descend from their repository default commit, including forks', async () => {
  const target = await ControlledLiveTarget.start({ defaultBranch: 'trunk' })
  try {
    for (const kind of ['fork', 'repository'] as const) {
      const subject = await target.foreignPullRequest(kind)
      const { data: pull } = await target.transport().rest<{
        head: { sha: string; repo: { full_name: string } }
        base: { sha: string; ref: string }
      }>({ method: 'GET', path: `repos/${subject.fullName}/pulls/${subject.number}` })
      assert.equal(pull.base.ref, 'trunk')
      const state = JSON.parse(
        readFileSync(process.env.GIT_STACKS_FIXTURE_STATE!, 'utf8'),
      ) as GitHubFixtureState
      const headRepository = state.repositories?.find(
        (entry) => entry.fullName === pull.head.repo.full_name,
      )
      assert.ok(headRepository)
      assert.notEqual(headRepository.fullName, target.repository())
      const git = (args: string[]) =>
        execFileSync(resolveRealGit(), ['--git-dir', headRepository.bare, ...args], {
          encoding: 'utf8',
        }).trim()
      assert.equal(git(['rev-parse', `${pull.head.sha}^`]), pull.base.sha)
      assert.equal(git(['merge-base', pull.base.sha, pull.head.sha]), pull.base.sha)
      assert.equal(git(['rev-list', '--count', `${pull.base.sha}..${pull.head.sha}`]), '1')
      assert.equal(
        git(['diff', '--name-only', pull.base.sha, pull.head.sha]),
        'git-stacks-live-e2e-foreign.txt',
      )
    }
  } finally {
    assert.equal((await target.cleanup()).complete, true)
  }
})

test('the API double refuses unrelated histories and heads with no new commits', async () => {
  const target = await ControlledLiveTarget.start({ defaultBranch: 'trunk' })
  try {
    const workspace = await target.workspace()
    const base = workspace.git(['rev-parse', 'trunk'])
    await target.admin.createBranch(target.repository(), 'unchanged', base)
    workspace.git(['checkout', '--orphan', 'unrelated'])
    workspace.git(['commit', '--allow-empty', '-m', 'Unrelated root'])
    await workspace.push('unrelated')
    assert.equal(workspace.git(['rev-list', '--count', `${base}..HEAD`]), '1')
    for (const [head, message] of [
      ['unrelated', /no history in common/u],
      ['unchanged', /No commits between/u],
    ] as const) {
      await assert.rejects(
        target.admin.createPullRequest({
          fullName: target.repository(),
          head,
          base: 'trunk',
          title: 'Invalid comparison',
          body: '',
        }),
        (error: unknown) => {
          assert.ok(error instanceof GitHubTransportError)
          assert.equal(error.status, 422)
          assert.match(error.message, message)
          return true
        },
      )
    }
    const state = JSON.parse(
      readFileSync(process.env.GIT_STACKS_FIXTURE_STATE!, 'utf8'),
    ) as GitHubFixtureState
    assert.equal(state.prs.length, 0)
    assert.equal(state.nextNumber, 1)
  } finally {
    assert.equal((await target.cleanup()).complete, true)
  }
})
