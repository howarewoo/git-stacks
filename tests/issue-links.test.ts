import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import {
  extractClosingReferences,
  insertClosingReference,
  isIssueClosedInBody,
  removeClosingReference,
  readLocalContextualIssueLinks,
  addLocalContextualIssueLink,
  removeLocalContextualIssueLink,
  searchGitHubIssues,
  getPullRequestIssueLinks,
  previewIssueLink,
  runLinkIssueAction,
  runUnlinkIssueAction,
} from '../src/main/issue-links'
import {
  createGitHubHarness,
  type GitHubFixturePullRequest,
  type GitHubFixtureState,
  type GitHubHarness,
} from './fixtures/github-harness'
import { createGitHubApiDouble } from './fixtures/github-api-double'
import { DirectGitHubTransport, setGitHubTransport } from '../src/main/github-transport'

function git(harness: GitHubHarness, args: string[]): string {
  return execFileSync('git', ['-C', harness.repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...harness.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function pushBranchToFixture(harness: GitHubHarness, branch: string): string {
  const oid = git(harness, ['rev-parse', branch])
  git(harness, ['push', harness.bare, `${branch}:refs/heads/${branch}`])
  git(harness, ['update-ref', `refs/remotes/origin/${branch}`, oid])
  return oid
}

function makeFixturePr(options: {
  number: number
  title: string
  head: string
  base: string
  body: string
  headOid?: string
  headRepository?: string
  draft?: boolean
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
}): GitHubFixturePullRequest {
  return {
    number: options.number,
    title: options.title,
    body: options.body,
    base: options.base,
    head: options.head,
    headRepository: options.headRepository ?? 'acme/widgets',
    draft: options.draft ?? false,
    state: options.state ?? 'OPEN',
    checks: 'passing',
    reviewDecision: 'APPROVED',
    mergeState: 'CLEAN',
    url: `https://github.com/acme/widgets/pull/${options.number}`,
    headOid: options.headOid ?? '0'.repeat(40),
    mergeOid: null,
    mergedAt: null,
  }
}

async function mutateState(
  harness: GitHubHarness,
  fn: (state: GitHubFixtureState) => void,
): Promise<void> {
  const state = await harness.readState()
  fn(state)
  await harness.writeState(state)
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
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key]
    }
    Object.assign(process.env, original)
    await harness.close()
  }
}

// ---------------------------------------------------------------------------
// Unit tests: Syntax parsing and manipulation
// ---------------------------------------------------------------------------

test('extractClosingReferences finds bare numbers, GH- prefix, URLs, and multiple references', () => {
  const text = `
    Initial user description.
    Fixes #10, #12 and resolves GH-15.
    Closes https://github.com/acme/widgets/issues/20.
    Also closes other/repo#25.
    See #99 for more context.
  `
  const refs = extractClosingReferences(text, 'acme/widgets')
  const numbers = refs.map((r) => r.issueNumber)

  // Should include 10, 12, 15, 20
  // Should NOT include 25 (different repo) or 99 ("See" is not a closing keyword)
  assert.deepEqual(numbers, [10, 12, 15, 20])
})

test('isIssueClosedInBody accurately detects whether an issue is closed in body', () => {
  const body = 'Fixes #42\nResolves #55'
  assert.equal(isIssueClosedInBody(body, 42, 'acme/widgets'), true)
  assert.equal(isIssueClosedInBody(body, 55, 'acme/widgets'), true)
  assert.equal(isIssueClosedInBody(body, 99, 'acme/widgets'), false)
  assert.equal(isIssueClosedInBody('References #42', 42, 'acme/widgets'), false)
})

test('insertClosingReference is idempotent and preserves user-authored body text', () => {
  const userText = '## Overview\nThis PR improves performance.\n\n- item 1\n- item 2'

  // Insert #12 into empty body
  const fromEmpty = insertClosingReference('', 12)
  assert.equal(fromEmpty, 'Closes #12\n')

  // Insert #12 into user text
  const inserted = insertClosingReference(userText, 12)
  assert.equal(inserted, `${userText}\n\nCloses #12\n`)

  // Idempotency: inserting #12 again returns the exact same string without duplicating
  const duplicate = insertClosingReference(inserted, 12)
  assert.equal(duplicate, inserted)

  // Inserting #15 appends to existing
  const insertedSecond = insertClosingReference(inserted, 15)
  assert.equal(insertedSecond, `${userText}\n\nCloses #12\n\nCloses #15\n`)
})

test('removeClosingReference removes only the exact closing syntax and preserves user body', () => {
  const userText = '## Summary\nImportant changes here.\n\nCloses #12\n'
  const removed = removeClosingReference(userText, 12, 'acme/widgets')
  assert.equal(removed, '## Summary\nImportant changes here.\n')

  // Idempotency: removing non-existent reference returns body unchanged
  const noop = removeClosingReference(removed, 12, 'acme/widgets')
  assert.equal(noop, removed)

  // Multi-issue on one line: Closes #10, #12
  const multiLine = 'Features\n\nCloses #10, #12\n'
  const removedOne = removeClosingReference(multiLine, 12, 'acme/widgets')
  assert.equal(removedOne, 'Features\n\nCloses #10\n')
})

// ---------------------------------------------------------------------------
// Unit tests: Local contextual links in Git config
// ---------------------------------------------------------------------------

test('local contextual links are stored and removed idempotently in local git config', async () => {
  await withHarness(async (harness) => {
    // Initially empty
    const initial = await readLocalContextualIssueLinks(harness.repo, 1)
    assert.deepEqual(initial, [])

    // Add issue 42
    const added1 = await addLocalContextualIssueLink(harness.repo, 1, 42)
    assert.equal(added1, true)
    assert.deepEqual(await readLocalContextualIssueLinks(harness.repo, 1), [42])

    // Idempotent: adding 42 again returns false and keeps single entry
    const addedAgain = await addLocalContextualIssueLink(harness.repo, 1, 42)
    assert.equal(addedAgain, false)
    assert.deepEqual(await readLocalContextualIssueLinks(harness.repo, 1), [42])

    // Add issue 55
    await addLocalContextualIssueLink(harness.repo, 1, 55)
    assert.deepEqual(await readLocalContextualIssueLinks(harness.repo, 1), [42, 55])

    // Remove issue 42
    const removed1 = await removeLocalContextualIssueLink(harness.repo, 1, 42)
    assert.equal(removed1, true)
    assert.deepEqual(await readLocalContextualIssueLinks(harness.repo, 1), [55])

    // Idempotent: removing 42 again returns false
    const removedAgain = await removeLocalContextualIssueLink(harness.repo, 1, 42)
    assert.equal(removedAgain, false)
    assert.deepEqual(await readLocalContextualIssueLinks(harness.repo, 1), [55])
  })
})

// ---------------------------------------------------------------------------
// Integration tests: Issue search (open and closed issues, offline fallback)
// ---------------------------------------------------------------------------

test('searchGitHubIssues searches issues by title and number, including closed issues', async () => {
  await withHarness(async (harness) => {
    // Populate fixture with open and closed issues
    await mutateState(harness, (state) => {
      state.issues = [
        {
          number: 10,
          title: 'Fix responsive navigation layout',
          url: 'https://github.com/acme/widgets/issues/10',
          state: 'OPEN',
        },
        {
          number: 12,
          title: 'Improve search keyboard navigation',
          url: 'https://github.com/acme/widgets/issues/12',
          state: 'CLOSED',
        },
        {
          number: 15,
          title: 'Dark mode contrast audit',
          url: 'https://github.com/acme/widgets/issues/15',
          state: 'OPEN',
        },
      ]
    })

    // Search by title keyword "navigation" finds both open and closed issues
    const navResult = await searchGitHubIssues(harness.repo, 'navigation')
    assert.equal(navResult.message, '')
    assert.equal(navResult.issues.length, 2)
    const issue10 = navResult.issues.find((i) => i.number === 10)
    const issue12 = navResult.issues.find((i) => i.number === 12)
    assert.ok(issue10 && issue10.state === 'OPEN')
    assert.ok(issue12 && issue12.state === 'CLOSED')

    // Search by number (both "15" and "#15")
    const numResult1 = await searchGitHubIssues(harness.repo, '15')
    assert.equal(numResult1.issues.length, 1)
    assert.equal(numResult1.issues[0].number, 15)

    const numResult2 = await searchGitHubIssues(harness.repo, '#12')
    assert.equal(numResult2.issues.length, 1)
    assert.equal(numResult2.issues[0].number, 12)
    assert.equal(numResult2.issues[0].state, 'CLOSED')
  })
})

test('searchGitHubIssues degrades cleanly to error message without throwing when transport fails', async () => {
  await withHarness(async (harness) => {
    await mutateState(harness, (state) => {
      state.issuesFailure = {
        status: 503,
        reason: 'Service Unavailable',
        message: 'GitHub is temporarily unavailable',
      }
    })

    const result = await searchGitHubIssues(harness.repo, 'test')
    assert.deepEqual(result.issues, [])
    assert.match(result.message, /GitHub metadata unavailable/i)
  })
})

// ---------------------------------------------------------------------------
// Integration tests: Contextual links vs Closing links
// ---------------------------------------------------------------------------

test('separate contextual and closing issue links display with their titles and states', async () => {
  await withHarness(async (harness) => {
    git(harness, ['checkout', '-b', 'feature-branch'])
    git(harness, ['commit', '--allow-empty', '-m', 'commit for feature'])
    const headSha = pushBranchToFixture(harness, 'feature-branch')

    await mutateState(harness, (state) => {
      state.prs.push(
        makeFixturePr({
          number: 1,
          title: 'Feature PR',
          head: 'feature-branch',
          base: 'main',
          headOid: headSha,
          body: 'Initial PR body.\n\nCloses #10\n',
        }),
      )
      state.issues = [
        {
          number: 10,
          title: 'Closing issue',
          url: 'https://github.com/acme/widgets/issues/10',
          state: 'OPEN',
        },
        {
          number: 20,
          title: 'Related issue (contextual)',
          url: 'https://github.com/acme/widgets/issues/20',
          state: 'CLOSED',
        },
      ]
    })

    // Add local contextual link for issue 20
    await addLocalContextualIssueLink(harness.repo, 1, 20)

    // Read linked issues
    const { links } = await getPullRequestIssueLinks(harness.repo, 1)
    assert.equal(links.length, 2)

    const closingLink = links.find((l) => l.number === 10)
    assert.ok(closingLink)
    assert.equal(closingLink.relation, 'closing')
    assert.equal(closingLink.title, 'Closing issue')
    assert.equal(closingLink.state, 'OPEN')

    const contextualLink = links.find((l) => l.number === 20)
    assert.ok(contextualLink)
    assert.equal(contextualLink.relation, 'contextual')
    assert.equal(contextualLink.title, 'Related issue (contextual)')
    assert.equal(contextualLink.state, 'CLOSED')
  })
})

// ---------------------------------------------------------------------------
// Integration tests: Previews, Idempotency, and Actions
// ---------------------------------------------------------------------------

test('previewIssueLink accurately computes next body and changed flag', async () => {
  await withHarness(async (harness) => {
    git(harness, ['checkout', '-b', 'feat'])
    git(harness, ['commit', '--allow-empty', '-m', 'feat'])
    const headSha = pushBranchToFixture(harness, 'feat')

    await mutateState(harness, (state) => {
      state.prs.push(
        makeFixturePr({
          number: 1,
          title: 'PR 1',
          head: 'feat',
          base: 'main',
          headOid: headSha,
          body: 'User description text',
        }),
      )
    })

    // Preview linking #30
    const previewLink = await previewIssueLink(harness.repo, 1, 30, 'closing', 'link')
    assert.equal(previewLink.changed, true)
    assert.equal(previewLink.newBody, 'User description text\n\nCloses #30\n')

    // Preview unlinking #30 before it is added
    const previewUnlinkBefore = await previewIssueLink(harness.repo, 1, 30, 'closing', 'unlink')
    assert.equal(previewUnlinkBefore.changed, false)
  })
})

test('runLinkIssueAction and runUnlinkIssueAction perform idempotent mutations', async () => {
  await withHarness(async (harness) => {
    git(harness, ['checkout', '-b', 'feat-branch'])
    git(harness, ['commit', '--allow-empty', '-m', 'feat commit'])
    const headSha = pushBranchToFixture(harness, 'feat-branch')

    await mutateState(harness, (state) => {
      state.prs.push(
        makeFixturePr({
          number: 1,
          title: 'PR 1',
          head: 'feat-branch',
          base: 'main',
          headOid: headSha,
          body: 'Original description.\n',
        }),
      )
    })

    // 1. Link closing issue #5
    const linkRes1 = await runLinkIssueAction(harness.repo, {
      prNumber: 1,
      issueNumber: 5,
      relation: 'closing',
      expectedBody: 'Original description.\n',
    })
    assert.match(linkRes1.message, /Linked issue #5/i)

    const state1 = await harness.readState()
    assert.equal(state1.prs[0].body, 'Original description.\n\nCloses #5\n')

    // 2. Idempotency: linking #5 again is a clean no-op
    const linkRes2 = await runLinkIssueAction(harness.repo, {
      prNumber: 1,
      issueNumber: 5,
      relation: 'closing',
      expectedBody: 'Original description.\n\nCloses #5\n',
    })
    assert.match(linkRes2.message, /already contains a closing reference/i)

    // 3. Link contextual issue #7
    const linkContextual1 = await runLinkIssueAction(harness.repo, {
      prNumber: 1,
      issueNumber: 7,
      relation: 'contextual',
    })
    assert.match(linkContextual1.message, /Linked issue #7 as related/i)

    // Body on GitHub remains unchanged by contextual link
    const state2 = await harness.readState()
    assert.equal(state2.prs[0].body, 'Original description.\n\nCloses #5\n')

    // 4. Unlink closing issue #5
    const unlinkRes1 = await runUnlinkIssueAction(harness.repo, {
      prNumber: 1,
      issueNumber: 5,
      relation: 'closing',
      expectedBody: 'Original description.\n\nCloses #5\n',
    })
    assert.match(unlinkRes1.message, /Removed closing reference/i)

    const state3 = await harness.readState()
    assert.equal(state3.prs[0].body, 'Original description.\n')

    // 5. Idempotent unlink
    const unlinkRes2 = await runUnlinkIssueAction(harness.repo, {
      prNumber: 1,
      issueNumber: 5,
      relation: 'closing',
      expectedBody: 'Original description.\n',
    })
    assert.match(unlinkRes2.message, /does not contain a closing reference/i)
  })
})

// ---------------------------------------------------------------------------
// Integration tests: Conflict detection (external PR body modifications)
// ---------------------------------------------------------------------------

test('runLinkIssueAction detects external PR body modification and throws conflict error', async () => {
  await withHarness(async (harness) => {
    git(harness, ['checkout', '-b', 'conflict-branch'])
    git(harness, ['commit', '--allow-empty', '-m', 'conflict commit'])
    const headSha = pushBranchToFixture(harness, 'conflict-branch')

    await mutateState(harness, (state) => {
      state.prs.push(
        makeFixturePr({
          number: 1,
          title: 'Conflict PR',
          head: 'conflict-branch',
          base: 'main',
          headOid: headSha,
          body: 'Body seen by reviewer when dialog opened',
        }),
      )
    })

    // Simulate an external teammate editing the PR description on GitHub concurrently
    await mutateState(harness, (state) => {
      state.prs[0].body = 'External edit by teammate on GitHub web UI'
    })

    // Attempting to link with expectedBody matching the old body must fail and leave GitHub body intact!
    await assert.rejects(
      async () => {
        await runLinkIssueAction(harness.repo, {
          prNumber: 1,
          issueNumber: 10,
          relation: 'closing',
          expectedBody: 'Body seen by reviewer when dialog opened',
        })
      },
      (error: Error) => {
        assert.match(error.message, /External body modification detected/i)
        return true
      },
    )

    // Verify GitHub PR body was NOT overwritten
    const state = await harness.readState()
    assert.equal(state.prs[0].body, 'External edit by teammate on GitHub web UI')
  })
})

// ---------------------------------------------------------------------------
// Integration tests: Forks and Permissions
// ---------------------------------------------------------------------------

test('fork PR targets origin issues and handles permission errors cleanly', async () => {
  await withHarness(async (harness) => {
    git(harness, ['checkout', '-b', 'fork-branch'])
    git(harness, ['commit', '--allow-empty', '-m', 'fork commit'])
    const headSha = pushBranchToFixture(harness, 'fork-branch')

    // PR created from a fork repository
    await mutateState(harness, (state) => {
      state.prs.push(
        makeFixturePr({
          number: 1,
          title: 'Fork PR',
          head: 'fork-branch',
          base: 'main',
          headOid: headSha,
          headRepository: 'forkuser/widgets',
          body: 'Initial fork body\n',
        }),
      )
      state.issues = [
        {
          number: 100,
          title: 'Origin issue for fork PR',
          url: 'https://github.com/acme/widgets/issues/100',
          state: 'OPEN',
        },
      ]
      // Simulate 403 Forbidden write permission error
      state.prWriteFailure = {
        status: 403,
        reason: 'Forbidden',
        message: 'Must have push access to repository to modify pull request',
      }
    })

    // Attempting to link closing issue fails cleanly with permission error
    await assert.rejects(
      async () => {
        await runLinkIssueAction(harness.repo, {
          prNumber: 1,
          issueNumber: 100,
          relation: 'closing',
          expectedBody: 'Initial fork body\n',
        })
      },
      (error: Error) => {
        assert.match(error.message, /push access|forbidden|Could not load|unavailable/i)
        return true
      },
    )

    // Body on GitHub remains unmodified
    const state = await harness.readState()
    assert.equal(state.prs[0].body, 'Initial fork body\n')
  })
})
