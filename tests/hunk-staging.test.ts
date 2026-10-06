import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { chmod, mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { getFileView, resolveRepository, runAction } from '../src/main/git'
import { runGitWithInput } from '../src/main/git-core'
import { resolveGitRuntime, withGitRuntime } from '../src/main/git-runtime'
import { hunkSideUnavailable, parseHunkBlock } from '../src/main/hunks'
import {
  HunkDiffView,
  HunkList,
  changedLineIndexes,
  hunkKeyAction,
  selectedLineIndexes,
  toggleExcludedLine,
} from '../src/renderer/src/components/hunk-diff'
import type { HunkListProps, HunkSelection } from '../src/renderer/src/components/hunk-diff'
import {
  ChangesView,
  changeGroups,
  fileStagingState,
} from '../src/renderer/src/components/data-views'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import { changesSnapshots, fileViewFixtures } from '../src/renderer/src/design-system/data-fixtures'
import type { GitAction, HunkSide, HunkSideName } from '../src/shared/types'

function numbered(count: number, edits: Record<number, string> = {}): string {
  return `${Array.from(
    { length: count },
    (_, index) => edits[index + 1] ?? `line ${index + 1}`,
  ).join('\n')}\n`
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-hunk-'))
  const repo = join(root, 'workspace')
  execFileSync('mkdir', ['-p', repo])
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  const text = (...args: string[]) => git(...args).toString()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Git Stacks test')
  git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, 'lines.txt'), numbered(20))
  git('add', '.')
  git('commit', '-m', 'Initial commit')
  const allowsFailure = (...args: string[]) => {
    try {
      git(...args)
    } catch {
      // Git reports the conflict on stderr and exits non-zero.
    }
  }
  return { root, repo, git, text, allowsFailure }
}

async function applyHunk(
  repo: string,
  path: string,
  side: HunkSideName,
  pick: number,
  lineIndexes?: number[],
) {
  const view = await getFileView(repo, path)
  const resolved: HunkSide = side === 'staged' ? view.hunks.staged : view.hunks.unstaged
  const hunk = resolved.hunks[pick]
  assert.ok(hunk, `expected a ${side} hunk at position ${pick}`)
  const result = await runAction(repo, {
    type: side === 'staged' ? 'unstageHunk' : 'stageHunk',
    path,
    hunkId: hunk.id,
    fingerprint: view.fingerprint,
    ...(lineIndexes ? { lineIndexes } : {}),
  })
  return { view, hunk, result }
}

test('stdin-fed Git commands use the selected runtime', async () => {
  const runtime = await resolveGitRuntime()
  await withGitRuntime({ ...runtime, executable: '/nonexistent/git-stacks-test-git' }, async () => {
    await assert.rejects(runGitWithInput(process.cwd(), ['apply', '--cached', '-'], ''), {
      code: 'ENOENT',
    })
  })
})

test('a file keeps staged and unstaged hunks and commits only the staged subset', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    await writeFile(
      join(repo, 'lines.txt'),
      numbered(20, { 2: 'line 2 staged', 18: 'line 18 left alone' }),
    )
    const view = await getFileView(repo, 'lines.txt')
    assert.equal(view.hunks.unstaged.unavailable, null)
    assert.equal(view.hunks.unstaged.hunks.length, 2)

    const { result } = await applyHunk(repo, 'lines.txt', 'unstaged', 0)
    assert.match(result.message, /Staged hunk 1 of 2 in lines\.txt/u)

    const staged = text('diff', '--cached')
    assert.match(staged, /\+line 2 staged/u)
    assert.ok(!staged.includes('line 18 left alone'), 'the other hunk stays unstaged')
    assert.equal(text('status', '--porcelain'), 'MM lines.txt\n')

    const after = await getFileView(repo, 'lines.txt')
    assert.equal(after.hunks.unstaged.hunks.length, 1)
    assert.equal(after.hunks.staged.hunks.length, 1)

    git('commit', '-m', 'Stage the first hunk only')
    const committed = text('show', 'HEAD:lines.txt')
    assert.match(committed, /line 2 staged/u)
    assert.ok(!committed.includes('line 18 left alone'), 'the commit carries only the staged hunk')
    assert.equal(text('status', '--porcelain'), ' M lines.txt\n')
    assert.match(await readFile(join(repo, 'lines.txt'), 'utf8'), /line 18 left alone/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('selected lines inside one merged hunk stage only what was selected', async () => {
  const { root, repo, text } = await fixture()
  try {
    await writeFile(
      join(repo, 'lines.txt'),
      numbered(20, { 5: 'line 5 picked', 7: 'line 7 skipped' }),
    )
    const view = await getFileView(repo, 'lines.txt')
    const hunk = view.hunks.unstaged.hunks[0]
    assert.equal(view.hunks.unstaged.hunks.length, 1, 'nearby edits share one hunk')
    const changed = hunk.lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.kind === 'add' || entry.line.kind === 'remove')
      .map((entry) => entry.index)

    const { result } = await applyHunk(repo, 'lines.txt', 'unstaged', 0, [changed[0], changed[1]])
    assert.match(result.message, /Staged 2 lines in lines\.txt/u)

    const staged = text('diff', '--cached')
    assert.match(staged, /\+line 5 picked/u)
    assert.ok(!staged.includes('line 7 skipped'), 'the unselected line is not staged')
    const worktree = text('diff')
    assert.match(worktree, /\+line 7 skipped/u)
    assert.ok(!/^\+line 5 picked/mu.test(worktree), 'the staged line leaves the worktree diff')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('adjacent replacement subset preserves the excluded neighbor in both directions', async () => {
  const { root, repo, git } = await fixture()
  try {
    const staged = numbered(20, { 2: 'line 2 staged' })
    await writeFile(join(repo, 'lines.txt'), staged)
    git('add', 'lines.txt')
    const working = numbered(20, {
      2: 'line 2 staged',
      18: 'line 18 selected',
      19: 'line 19 excluded',
    })
    await writeFile(join(repo, 'lines.txt'), working)

    const view = await getFileView(repo, 'lines.txt')
    const hunk = view.hunks.unstaged.hunks[0]
    const selected = hunk.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.text === '-line 18' || line.text === '+line 18 selected')
      .map(({ index }) => index)
    assert.equal(selected.length, 2)
    await applyHunk(repo, 'lines.txt', 'unstaged', 0, selected)
    assert.deepEqual(
      execFileSync('git', ['-C', repo, 'show', ':lines.txt']),
      Buffer.from(numbered(20, { 2: 'line 2 staged', 18: 'line 18 selected' })),
    )
    assert.deepEqual(await readFile(join(repo, 'lines.txt')), Buffer.from(working))

    git('add', 'lines.txt')
    const stagedView = await getFileView(repo, 'lines.txt')
    const stagedHunkIndex = stagedView.hunks.staged.hunks.findIndex((entry) =>
      entry.lines.some((line) => line.text === '+line 18 selected'),
    )
    assert.notEqual(stagedHunkIndex, -1)
    const stagedHunk = stagedView.hunks.staged.hunks[stagedHunkIndex]
    const unselected = stagedHunk.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.text === '-line 18' || line.text === '+line 18 selected')
      .map(({ index }) => index)
    await applyHunk(repo, 'lines.txt', 'staged', stagedHunkIndex, unselected)
    assert.deepEqual(
      execFileSync('git', ['-C', repo, 'show', ':lines.txt']),
      Buffer.from(numbered(20, { 2: 'line 2 staged', 19: 'line 19 excluded' })),
    )
    assert.deepEqual(await readFile(join(repo, 'lines.txt')), Buffer.from(working))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('selected lines unstage without removing a neighboring staged edit', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    await writeFile(
      join(repo, 'lines.txt'),
      numbered(20, { 5: 'line 5 unstaged', 7: 'line 7 stays staged' }),
    )
    git('add', 'lines.txt')
    const view = await getFileView(repo, 'lines.txt')
    const hunk = view.hunks.staged.hunks[0]
    const changed = hunk.lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.kind === 'add' || entry.line.kind === 'remove')
      .map((entry) => entry.index)
    await applyHunk(repo, 'lines.txt', 'staged', 0, changed.slice(0, 2))
    assert.doesNotMatch(text('diff', '--cached'), /line 5 unstaged/u)
    assert.match(text('diff', '--cached'), /line 7 stays staged/u)
    assert.match(text('diff'), /line 5 unstaged/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('interior added or removed lines anchor at their exact position when staged or unstaged', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    // 1. Interior addition: base file has alpha/omega. Worktree has alpha/first/middle/last/omega.
    await writeFile(join(repo, 'additions.txt'), 'alpha\nomega\n')
    git('add', 'additions.txt')
    git('commit', '-qm', 'Add additions base')
    await writeFile(join(repo, 'additions.txt'), 'alpha\nfirst\nmiddle\nlast\nomega\n')
    const viewAdd = await getFileView(repo, 'additions.txt')
    const hunkAdd = viewAdd.hunks.unstaged.hunks[0]
    const middleAddIndex = hunkAdd.lines.findIndex((l) => l.kind === 'add' && l.text === '+middle')
    assert.ok(middleAddIndex !== -1)
    await runAction(repo, {
      type: 'stageHunk',
      path: 'additions.txt',
      hunkId: hunkAdd.id,
      fingerprint: viewAdd.fingerprint,
      lineIndexes: [middleAddIndex],
    })
    assert.equal(text('show', ':additions.txt'), 'alpha\nmiddle\nomega\n')

    // 2. Interior deletion: base file has alpha/delA/delB/delC/omega. Worktree has alpha/omega.
    await writeFile(join(repo, 'deletions.txt'), 'alpha\ndelA\ndelB\ndelC\nomega\n')
    git('add', 'deletions.txt')
    git('commit', '-qm', 'Add deletions base')
    await writeFile(join(repo, 'deletions.txt'), 'alpha\nomega\n')
    const viewDel = await getFileView(repo, 'deletions.txt')
    const hunkDel = viewDel.hunks.unstaged.hunks[0]
    const middleDelIndex = hunkDel.lines.findIndex((l) => l.kind === 'remove' && l.text === '-delB')
    assert.ok(middleDelIndex !== -1)
    await runAction(repo, {
      type: 'stageHunk',
      path: 'deletions.txt',
      hunkId: hunkDel.id,
      fingerprint: viewDel.fingerprint,
      lineIndexes: [middleDelIndex],
    })
    // delB is removed from index; delA and delC remain
    assert.equal(text('show', ':deletions.txt'), 'alpha\ndelA\ndelC\nomega\n')

    // 3. Symmetrically unstage an interior deletion
    git('add', 'deletions.txt')
    assert.equal(text('show', ':deletions.txt'), 'alpha\nomega\n')
    const viewStaged = await getFileView(repo, 'deletions.txt')
    const hunkStaged = viewStaged.hunks.staged.hunks[0]
    const unstageDelBIndex = hunkStaged.lines.findIndex(
      (l) => l.kind === 'remove' && l.text === '-delB',
    )
    assert.ok(unstageDelBIndex !== -1)
    await runAction(repo, {
      type: 'unstageHunk',
      path: 'deletions.txt',
      hunkId: hunkStaged.id,
      fingerprint: viewStaged.fingerprint,
      lineIndexes: [unstageDelBIndex],
    })
    // Unstaging delB puts delB back into index between alpha and omega
    assert.equal(text('show', ':deletions.txt'), 'alpha\ndelB\nomega\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repeated text selects the exact coordinate in both index directions', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    const base = 'alpha\nx\ny\nx\nz\nomega\n'
    await writeFile(join(repo, 'remove.txt'), base)
    await writeFile(join(repo, 'insert.txt'), 'alpha\nomega\n')
    git('add', '.')
    git('commit', '-qm', 'Add repeated-line bases')
    await writeFile(join(repo, 'remove.txt'), 'alpha\nomega\n')
    await writeFile(join(repo, 'insert.txt'), base)
    git('add', 'insert.txt')
    for (const [file, side, line] of [
      ['remove.txt', 'unstaged', '-x'],
      ['insert.txt', 'staged', '+x'],
    ] as const) {
      const view = await getFileView(repo, file)
      const changes = view.hunks[side].hunks[0].lines
      const second = changes.findLastIndex((entry) => entry.text === line)
      assert.ok(second >= 0)
      await applyHunk(repo, file, side, 0, [second])
      assert.equal(text('show', `:${file}`), 'alpha\nx\ny\nz\nomega\n')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zero-context selections retain insertion and deletion anchors in both directions', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    git('config', 'diff.context', '0')
    for (const file of ['stage-add', 'unstage-add', 'stage-remove', 'unstage-remove']) {
      const removal = file.endsWith('remove')
      await writeFile(
        join(repo, `${file}.txt`),
        removal ? 'alpha\nfirst\nmiddle\nlast\nomega\n' : 'alpha\nomega\n',
      )
    }
    await writeFile(join(repo, 'start.txt'), 'alpha\nomega\n')
    await writeFile(join(repo, 'crlf-eof.txt'), 'alpha\r\nomega')
    git('add', '.')
    git('commit', '-qm', 'Add zero-context bases')
    for (const file of ['stage-add', 'unstage-add', 'stage-remove', 'unstage-remove']) {
      const removal = file.endsWith('remove')
      await writeFile(
        join(repo, `${file}.txt`),
        removal ? 'alpha\nomega\n' : 'alpha\nfirst\nmiddle\nlast\nomega\n',
      )
      if (file.startsWith('unstage')) git('add', `${file}.txt`)
      const side = file.startsWith('unstage') ? 'staged' : 'unstaged'
      const view = await getFileView(repo, `${file}.txt`)
      const hunk = view.hunks[side].hunks[0]
      assert.ok(hunk)
      assert.match(hunk.header, /,0 /u, 'a zero-count side is present')
      const middle = hunk.lines.findIndex((line) => line.text === `${removal ? '-' : '+'}middle`)
      assert.ok(middle >= 0)
      await applyHunk(repo, `${file}.txt`, side, 0, [middle])
      assert.equal(
        text('show', `:${file}.txt`),
        removal
          ? file.startsWith('unstage')
            ? 'alpha\nmiddle\nomega\n'
            : 'alpha\nfirst\nlast\nomega\n'
          : file.startsWith('unstage')
            ? 'alpha\nfirst\nlast\nomega\n'
            : 'alpha\nmiddle\nomega\n',
      )
    }

    await writeFile(join(repo, 'start.txt'), 'first\nmiddle\nlast\nalpha\nomega\n')
    const start = await getFileView(repo, 'start.txt')
    const startHunk = start.hunks.unstaged.hunks[0]
    assert.match(startHunk.header, /-0,0/u)
    await applyHunk(repo, 'start.txt', 'unstaged', 0, [
      startHunk.lines.findIndex((line) => line.text === '+middle'),
    ])
    assert.equal(text('show', ':start.txt'), 'middle\nalpha\nomega\n')

    await writeFile(join(repo, 'crlf-eof.txt'), 'alpha\r\nfirst\r\nmiddle\r\nlast\r\nomega')
    const crlf = await getFileView(repo, 'crlf-eof.txt')
    await applyHunk(repo, 'crlf-eof.txt', 'unstaged', 0, [
      crlf.hunks.unstaged.hunks[0].lines.findIndex((line) => line.text === '+middle\r'),
    ])
    assert.deepEqual(
      execFileSync('git', ['-C', repo, 'show', ':crlf-eof.txt']),
      Buffer.from('alpha\r\nmiddle\r\nomega'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('quoted file paths preserve hunks and stage and unstage cleanly', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    const quotedPath = '😀"notes.txt'
    await writeFile(join(repo, quotedPath), 'before\n')
    git('add', '.')
    git('commit', '-qm', 'Add quoted file')
    await writeFile(join(repo, quotedPath), 'after\n')

    const view = await getFileView(repo, quotedPath)
    assert.equal(view.hunks.unstaged.unavailable, null)
    assert.equal(view.hunks.unstaged.hunks.length, 1)

    await runAction(repo, {
      type: 'stageHunk',
      path: quotedPath,
      hunkId: view.hunks.unstaged.hunks[0].id,
      fingerprint: view.fingerprint,
    })
    assert.equal(text('show', `:${quotedPath}`), 'after\n')

    const stagedView = await getFileView(repo, quotedPath)
    assert.equal(stagedView.hunks.staged.unavailable, null)
    assert.equal(stagedView.hunks.staged.hunks.length, 1)

    await runAction(repo, {
      type: 'unstageHunk',
      path: quotedPath,
      hunkId: stagedView.hunks.staged.hunks[0].id,
      fingerprint: stagedView.fingerprint,
    })
    assert.equal(text('show', `:${quotedPath}`), 'before\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('atomic index transaction fails closed on concurrent lock or state change without mutating index', async () => {
  const { root, repo, text } = await fixture()
  try {
    await writeFile(join(repo, 'lines.txt'), numbered(20, { 2: 'line 2 staged' }))
    const view = await getFileView(repo, 'lines.txt')
    const hunk = view.hunks.unstaged.hunks[0]
    const initialIndexContent = text('show', ':lines.txt')

    const lockHandle = await open(join(repo, '.git', 'index.lock'), 'wx')
    try {
      await assert.rejects(
        runAction(repo, {
          type: 'stageHunk',
          path: 'lines.txt',
          hunkId: hunk.id,
          fingerprint: view.fingerprint,
        }),
        /Another Git process is modifying the index/u,
      )
    } finally {
      await lockHandle.close()
      await unlink(join(repo, '.git', 'index.lock'))
    }

    assert.equal(
      text('show', ':lines.txt'),
      initialIndexContent,
      'the real index remained completely unmutated',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hunk staging and unstaging preserve the existing index permissions', async () => {
  const { root, repo, text } = await fixture()
  try {
    const indexPath = join(repo, '.git', 'index')
    for (const mode of [0o600, 0o660]) {
      await writeFile(join(repo, 'lines.txt'), numbered(20, { 2: 'line 2 staged' }))
      const unstaged = await getFileView(repo, 'lines.txt')
      await chmod(indexPath, mode)
      await runAction(repo, {
        type: 'stageHunk',
        path: 'lines.txt',
        hunkId: unstaged.hunks.unstaged.hunks[0].id,
        fingerprint: unstaged.fingerprint,
      })
      assert.equal((await stat(indexPath)).mode & 0o777, mode)
      const staged = await getFileView(repo, 'lines.txt')
      await chmod(indexPath, mode)
      await runAction(repo, {
        type: 'unstageHunk',
        path: 'lines.txt',
        hunkId: staged.hunks.staged.hunks[0].id,
        fingerprint: staged.fingerprint,
      })
      assert.equal((await stat(indexPath)).mode & 0o777, mode)
      assert.equal(text('diff', '--cached'), '')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('in-flight other-entry staging is preserved before the lock and refused while it is owned', async () => {
  const { root, repo, git, text } = await fixture()
  const originalOpen = fs.open
  const originalCopy = fs.copyFile
  try {
    await writeFile(join(repo, 'other.txt'), 'before\n')
    await writeFile(join(repo, 'blocked.txt'), 'before\n')
    git('add', 'other.txt', 'blocked.txt')
    git('commit', '-qm', 'Add other tracked files')
    await writeFile(join(repo, 'other.txt'), 'independently staged\n')
    await writeFile(join(repo, 'blocked.txt'), 'still unstaged\n')
    await writeFile(join(repo, 'lines.txt'), numbered(20, { 2: 'selected hunk' }))
    const view = await getFileView(repo, 'lines.txt')
    let raced = false
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith('/index.lock') && args[1] === 'wx') {
        assert.equal(raced, false)
        // Run a real Git writer after hunk resolution but just before lock
        // acquisition. A snapshot made before this boundary loses other.txt.
        git('add', 'other.txt')
        raced = true
      }
      return originalOpen(...args)
    }) as typeof fs.open
    let lockRefused = false
    fs.copyFile = (async (...args: Parameters<typeof fs.copyFile>) => {
      if (String(args[1]).includes('.stage-')) {
        assert.throws(() => git('add', 'blocked.txt'), /index\.lock/u)
        lockRefused = true
      }
      return originalCopy(...args)
    }) as typeof fs.copyFile
    await runAction(repo, {
      type: 'stageHunk',
      path: 'lines.txt',
      hunkId: view.hunks.unstaged.hunks[0].id,
      fingerprint: view.fingerprint,
    })
    assert.equal(raced, true)
    assert.equal(lockRefused, true)
    assert.equal(text('show', ':other.txt'), 'independently staged\n')
    assert.equal(text('show', ':lines.txt'), numbered(20, { 2: 'selected hunk' }))
    assert.match(text('diff', '--cached', '--name-only'), /other\.txt/u)
    assert.match(text('diff', '--cached', '--name-only'), /lines\.txt/u)
    assert.equal(text('show', ':blocked.txt'), 'before\n')
    assert.equal(await readFile(join(repo, 'blocked.txt'), 'utf8'), 'still unstaged\n')
  } finally {
    fs.open = originalOpen
    fs.copyFile = originalCopy
    await rm(root, { recursive: true, force: true })
  }
})

test('unstaging one hunk leaves the other staged hunk in the index', async () => {
  const { root, repo, text } = await fixture()
  try {
    await writeFile(
      join(repo, 'lines.txt'),
      numbered(20, { 2: 'line 2 first', 18: 'line 18 second' }),
    )
    await runAction(repo, { type: 'stage', paths: ['lines.txt'] })
    const staged = await getFileView(repo, 'lines.txt')
    assert.equal(staged.hunks.staged.hunks.length, 2)

    const { result } = await applyHunk(repo, 'lines.txt', 'staged', 0)
    assert.match(result.message, /Unstaged hunk 1 of 2 in lines\.txt/u)

    const cached = text('diff', '--cached')
    assert.ok(!cached.includes('line 2 first'), 'the un-staged hunk left the index')
    assert.match(cached, /\+line 18 second/u)
    assert.equal(text('status', '--porcelain'), 'MM lines.txt\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hunk patch fails closed when the file changed since the view was read', async () => {
  const { root, repo, text } = await fixture()
  try {
    await writeFile(
      join(repo, 'lines.txt'),
      numbered(20, { 2: 'line 2 staged', 18: 'line 18 left alone' }),
    )
    const view = await getFileView(repo, 'lines.txt')
    const hunk = view.hunks.unstaged.hunks[0]
    const concurrent = numbered(20, { 2: 'line 2 staged', 18: 'line 18 rewritten' })
    await writeFile(join(repo, 'lines.txt'), concurrent)

    await assert.rejects(
      runAction(repo, {
        type: 'stageHunk',
        path: 'lines.txt',
        hunkId: hunk.id,
        fingerprint: view.fingerprint,
      }),
      /changed since it was opened/u,
    )
    assert.equal(text('diff', '--cached'), '', 'a stale patch never reaches the index')
    assert.equal(await readFile(join(repo, 'lines.txt'), 'utf8'), concurrent)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hunk patch fails closed when the index changed and never guesses a hunk identity', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    await writeFile(join(repo, 'other.txt'), numbered(20))
    git('add', 'other.txt')
    git('commit', '-qm', 'Add other')
    await writeFile(join(repo, 'lines.txt'), numbered(20, { 2: 'line 2 staged' }))
    await writeFile(join(repo, 'other.txt'), numbered(20, { 2: 'other line 2' }))
    const view = await getFileView(repo, 'lines.txt')
    await runAction(repo, { type: 'stage', paths: ['lines.txt'] })

    await assert.rejects(
      runAction(repo, {
        type: 'stageHunk',
        path: 'lines.txt',
        hunkId: view.hunks.unstaged.hunks[0].id,
        fingerprint: view.fingerprint,
      }),
      /changed since it was opened/u,
    )

    const other = await getFileView(repo, 'other.txt')
    await assert.rejects(
      runAction(repo, {
        type: 'stageHunk',
        path: 'other.txt',
        hunkId: '0123456789abcdef',
        fingerprint: other.fingerprint,
      }),
      /no longer part of the unstaged diff/u,
    )
    assert.match(text('diff', '--cached'), /\+line 2 staged/u)
    assert.match(text('diff'), /\+other line 2/u, 'the refused hunk left the worktree alone')
    assert.ok(
      !text('diff', '--cached').includes('other line 2'),
      'a refused hunk never reaches the index',
    )
    assert.match(await readFile(join(repo, 'lines.txt'), 'utf8'), /line 2 staged/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a rename is refused as a whole file while its working-tree hunks still apply', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    await writeFile(join(repo, 'renamed.txt'), numbered(12))
    await runAction(repo, { type: 'stage', paths: ['renamed.txt'] })
    git('commit', '-m', 'Add renamed')
    await writeFile(join(repo, 'renamed.txt'), numbered(12, { 2: 'line 2 renamed' }))
    await runAction(repo, { type: 'stage', paths: ['renamed.txt'] })
    git('commit', '-m', 'Rename the file')
    execFileSync('git', ['-C', repo, 'mv', 'renamed.txt', 'moved.txt'])

    const staged = await getFileView(repo, 'moved.txt')
    assert.match(
      staged.hunks.staged.unavailable ?? '',
      /rename is staged or unstaged as a whole file/u,
    )
    await assert.rejects(
      runAction(repo, {
        type: 'unstageHunk',
        path: 'moved.txt',
        hunkId: staged.hunks.staged.hunks[0]?.id ?? '0123456789abcdef',
        fingerprint: staged.fingerprint,
      }),
      /rename is staged or unstaged as a whole file/u,
    )
    assert.match(text('status', '--porcelain'), /^R /u)

    await writeFile(
      join(repo, 'moved.txt'),
      numbered(12, { 2: 'line 2 renamed', 10: 'line 10 edited' }),
    )
    const worktree = await getFileView(repo, 'moved.txt')
    assert.equal(worktree.hunks.unstaged.unavailable, null)
    await applyHunk(repo, 'moved.txt', 'unstaged', 0)
    assert.match(text('status', '--porcelain'), /^R /u, 'the staged rename survives hunk staging')
    assert.match(text('diff', '--cached'), /\+line 10 edited/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CRLF, no-newline-at-EOF and Unicode paths apply without changing line endings', async () => {
  const { root, repo } = await fixture()
  try {
    const crlf = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\r\n')}\r\n`
    await writeFile(join(repo, 'crlf.txt'), crlf)
    await writeFile(join(repo, 'ünïcodé ファイル.txt'), numbered(20))
    await writeFile(join(repo, 'eof.txt'), numbered(20).trimEnd())
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, 'commit', '-m', 'Add ending fixtures'])

    await writeFile(join(repo, 'crlf.txt'), crlf.replace('line 2\r\n', 'line 2 edited\r\n'))
    await writeFile(
      join(repo, 'ünïcodé ファイル.txt'),
      numbered(20, { 2: 'line 2 unicode', 18: 'line 18 unicode' }),
    )
    await writeFile(join(repo, 'eof.txt'), 'line 1\nline 2 edited\nline 3')

    await applyHunk(repo, 'crlf.txt', 'unstaged', 0)
    await applyHunk(repo, 'ünïcodé ファイル.txt', 'unstaged', 0)
    await applyHunk(repo, 'eof.txt', 'unstaged', 0)

    const stagedCrlf = execFileSync('git', ['-C', repo, 'show', ':crlf.txt'])
    assert.equal(stagedCrlf.includes(Buffer.from('line 2 edited\r\n')), true)
    assert.equal(stagedCrlf.includes(Buffer.from('line 3\r\n')), true)
    assert.equal(
      stagedCrlf.includes(Buffer.from('line 1\n')),
      false,
      'staging a CRLF hunk leaves untouched line endings alone',
    )
    const stagedUnicode = execFileSync('git', [
      '-C',
      repo,
      'show',
      ':ünïcodé ファイル.txt',
    ]).toString('utf8')
    assert.match(stagedUnicode, /line 2 unicode/u)
    assert.ok(!stagedUnicode.includes('line 18 unicode'))
    const stagedEof = execFileSync('git', ['-C', repo, 'show', ':eof.txt']).toString('utf8')
    assert.ok(stagedEof.endsWith('line 3'), 'no newline is added at the end of the file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an oversized diff refuses hunk staging instead of applying a partial patch', async () => {
  const { root, repo, text } = await fixture()
  try {
    const big = Array.from({ length: 40_000 }, (_, index) => `line ${index + 1} ${'x'.repeat(80)}`)
    await writeFile(join(repo, 'big.txt'), `${big.join('\n')}\n`)
    await runAction(repo, { type: 'stage', paths: ['big.txt'] })
    const before = text('diff', '--cached')
    await writeFile(join(repo, 'big.txt'), `${big.map((line) => `${line} edited`).join('\n')}\n`)

    const view = await getFileView(repo, 'big.txt')
    assert.equal(view.truncated, true)
    assert.match(view.hunks.unstaged.unavailable ?? '', /too large to apply safely/u)
    await assert.rejects(
      runAction(repo, {
        type: 'stageHunk',
        path: 'big.txt',
        hunkId: '0123456789abcdef',
        fingerprint: view.fingerprint,
      }),
      /too large to apply safely/u,
    )
    assert.equal(text('diff', '--cached'), before, 'a truncated diff never reaches the index')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a mode change, a deletion, an untracked file and a copy all state why', async () => {
  const { root, repo } = await fixture()
  try {
    await chmod(join(repo, 'lines.txt'), 0o755)
    const mode = await getFileView(repo, 'lines.txt')
    assert.match(mode.hunks.unstaged.unavailable ?? '', /mode or link change with no text hunks/u)

    await writeFile(join(repo, 'fresh.txt'), 'new file\n')
    const untracked = await getFileView(repo, 'fresh.txt')
    assert.match(
      untracked.hunks.unstaged.unavailable ?? '',
      /untracked file is staged as a whole file/u,
    )

    await rm(join(repo, 'lines.txt'))
    const deleted = await getFileView(repo, 'lines.txt')
    assert.match(
      deleted.hunks.unstaged.unavailable ?? '',
      /deletion is staged or unstaged as a whole file/u,
    )
    await assert.rejects(
      runAction(repo, {
        type: 'stageHunk',
        path: 'lines.txt',
        hunkId: '0123456789abcdef',
        fingerprint: deleted.fingerprint,
      }),
      /deletion is staged or unstaged as a whole file/u,
    )

    const copy = hunkSideUnavailable(
      'staged',
      parseHunkBlock(
        [
          'diff --git a/a.txt b/b.txt',
          'copy from a.txt',
          'copy to b.txt',
          '--- a/a.txt',
          '+++ b/b.txt',
        ].join('\n'),
        { path: 'b.txt', originalPath: null },
      ),
      {
        binary: false,
        truncated: false,
        conflicted: false,
        untracked: false,
        renamed: false,
        changed: true,
      },
    )
    assert.match(copy ?? '', /copy is staged or unstaged as a whole file/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('text hunks never stage or unstage an accompanying mode change', async () => {
  const { root, repo, git, text } = await fixture()
  try {
    await writeFile(join(repo, 'lines.txt'), numbered(20, { 2: 'first edit', 17: 'second edit' }))
    await chmod(join(repo, 'lines.txt'), 0o755)
    const first = await getFileView(repo, 'lines.txt')
    assert.equal(first.hunks.unstaged.unavailable, null)
    assert.equal(first.hunks.unstaged.hunks.length, 2)
    await applyHunk(repo, 'lines.txt', 'unstaged', 0)
    assert.match(text('ls-files', '--stage', '--', 'lines.txt'), /^100644/u)
    assert.match(text('diff', '--cached', '--', 'lines.txt'), /first edit/u)
    assert.doesNotMatch(text('diff', '--cached', '--', 'lines.txt'), /second edit/u)
    assert.match(text('diff', '--summary', '--', 'lines.txt'), /mode change 100644 => 100755/u)

    git('add', '--', 'lines.txt')
    const staged = await getFileView(repo, 'lines.txt')
    assert.equal(staged.hunks.staged.hunks.length, 2)
    await applyHunk(repo, 'lines.txt', 'staged', 0)
    assert.match(text('ls-files', '--stage', '--', 'lines.txt'), /^100755/u)
    assert.doesNotMatch(text('diff', '--cached', '--', 'lines.txt'), /first edit/u)
    assert.match(text('diff', '--cached', '--', 'lines.txt'), /second edit/u)
    assert.match(await readFile(join(repo, 'lines.txt'), 'utf8'), /first edit/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unborn branch stages hunks and refuses per-hunk unstaging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-hunk-unborn-'))
  try {
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    const repo = await resolveRepository(root)
    await writeFile(join(root, 'first.txt'), numbered(20))
    await runAction(repo, { type: 'stage', paths: ['first.txt'] })
    await writeFile(join(root, 'first.txt'), numbered(20, { 2: 'line 2 edited' }))

    const view = await getFileView(repo, 'first.txt')
    assert.equal(view.hunks.unstaged.unavailable, null, 'staging works before the first commit')
    assert.match(
      view.hunks.staged.unavailable ?? '',
      /newly added file is unstaged as a whole file/u,
    )
    await applyHunk(repo, 'first.txt', 'unstaged', 0)
    assert.match(
      execFileSync('git', ['-C', root, 'show', ':first.txt']).toString('utf8'),
      /line 2 edited/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a conflicted file refuses hunk staging until it is resolved', async () => {
  const { root, repo, git, text, allowsFailure } = await fixture()
  try {
    git('checkout', '-q', '-b', 'feature')
    await writeFile(join(repo, 'lines.txt'), numbered(20, { 2: 'feature change' }))
    git('add', '.')
    git('commit', '-qm', 'Feature')
    git('checkout', '-q', 'main')
    await writeFile(join(repo, 'lines.txt'), numbered(20, { 2: 'main change' }))
    git('add', '.')
    git('commit', '-qm', 'Main')
    git('checkout', '-q', 'feature')
    allowsFailure('rebase', 'main')
    assert.match(text('status', '--porcelain'), /^UU/u)

    const view = await getFileView(repo, 'lines.txt')
    assert.match(view.hunks.unstaged.unavailable ?? '', /Resolve this conflict/u)
    await assert.rejects(
      runAction(repo, {
        type: 'stageHunk',
        path: 'lines.txt',
        hunkId: view.hunks.unstaged.hunks[0]?.id ?? '0123456789abcdef',
        fingerprint: view.fingerprint,
      }),
      /Resolve this conflict/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hunk identities and line numbers come from the real diff text', () => {
  const diff = [
    'diff --git a/notes.md b/notes.md',
    'index 1111111..2222222 100644',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -1,3 +1,3 @@ heading',
    ' keep',
    '-remove one',
    '+add one',
    ' keep two',
  ].join('\n')
  const block = parseHunkBlock(diff, { path: 'notes.md', originalPath: null })
  assert.equal(block.kind, 'content')
  assert.equal(block.hunks.length, 1)
  const hunk = block.hunks[0]
  assert.equal(
    hunk.id,
    parseHunkBlock(diff, { path: 'notes.md', originalPath: null }).hunks[0].id,
    'the same hunk keeps its identity',
  )
  assert.notEqual(
    hunk.id,
    parseHunkBlock(diff, { path: 'other.md', originalPath: null }).hunks[0]?.id,
    'a hunk identity is bound to its file',
  )
  assert.deepEqual(
    hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    [
      ['context', 1, 1],
      ['remove', 2, null],
      ['add', null, 2],
      ['context', 3, 3],
    ],
  )
  assert.equal(hunk.oldLines, 3)
  assert.equal(hunk.newLines, 3)
})

test('an unparsable hunk is dropped instead of guessed', () => {
  const block = parseHunkBlock(
    [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,4 +1,4 @@',
      ' keep',
      '-remove one',
    ].join('\n'),
    { path: 'notes.md', originalPath: null },
  )
  assert.deepEqual(block.hunks, [], 'a hunk whose counts disagree is not offered')
  assert.equal(block.kind, 'unreadable')
})

test('one malformed hunk makes the entire file diff unavailable for patching', () => {
  const block = parseHunkBlock(
    [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '@@ -5,2 +5,2 @@',
      '-incomplete',
    ].join('\n'),
    { path: 'notes.md', originalPath: null },
  )
  assert.equal(block.hunks.length, 1)
  assert.equal(block.kind, 'unreadable')
  assert.match(
    hunkSideUnavailable('unstaged', block, {
      binary: false,
      truncated: false,
      conflicted: false,
      untracked: false,
      renamed: false,
      changed: true,
    }) ?? '',
    /could not be read safely/u,
  )
})

function hunks(count: number): HunkSide {
  return {
    hunks: Array.from({ length: count }, (_, index) => ({
      id: `${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}`,
      header: `@@ -${index * 40 + 1},2 +${index * 40 + 1},2 @@`,
      oldStart: index * 40 + 1,
      oldLines: 2,
      newStart: index * 40 + 1,
      newLines: 2,
      lines: [
        { kind: 'context' as const, text: ' keep', oldLine: 1, newLine: 1 },
        { kind: 'remove' as const, text: '-old line', oldLine: 2, newLine: null },
        { kind: 'add' as const, text: '+new line', oldLine: null, newLine: 2 },
      ],
    })),
    unavailable: null,
  }
}

function markup(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(TooltipProvider, null, element))
}

/**
 * Call a component that uses hooks and keep the element tree it returns. The
 * component runs inside a real `renderToStaticMarkup` pass, so the hook
 * dispatcher is active, and the probe hands back the tree so the assertions
 * below can still read props and invoke handlers directly.
 */
function renderTree<P extends object>(
  component: (props: P) => React.ReactElement,
  props: P,
): React.ReactElement {
  let captured: React.ReactElement = React.createElement(component, props)
  function Probe(): React.ReactElement {
    captured = component(props)
    return captured
  }
  markup(React.createElement(Probe))
  return captured
}

function hunkMarkup(side: HunkSide, sideName: HunkSideName = 'unstaged'): string {
  return markup(
    React.createElement(HunkDiffView, {
      side,
      sideName,
      busy: false,
      onApply: () => undefined,
    }),
  )
}

function listProps(overrides: Partial<HunkListProps> = {}): HunkListProps {
  return {
    side: hunks(2),
    sideName: 'unstaged',
    busy: false,
    focused: 0,
    excluded: {},
    hunkRefs: { current: [] },
    onFocus: () => undefined,
    onMove: () => undefined,
    onExclude: () => undefined,
    onApply: () => undefined,
    ...overrides,
  }
}

interface ControlProps {
  'aria-label'?: string
  role?: string
  children?: React.ReactNode
  disabled?: boolean
  onClick?: () => unknown
  onChange?: (event: unknown) => unknown
  onCheckedChange?: (checked: boolean) => unknown
  onKeyDown?: (event: { key: string; preventDefault: () => void }) => void
}

function controlProps(element: React.ReactElement): ControlProps {
  return element.props as ControlProps
}

function findLabeled(node: React.ReactNode, label: string): React.ReactElement | undefined {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue
    const props = controlProps(child)
    if (props['aria-label'] === label) return child
    const match = findLabeled(props.children, label)
    if (match) return match
  }
  return undefined
}

function findLabeledByRole(node: React.ReactNode, role: string): React.ReactElement[] {
  const found: React.ReactElement[] = []
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue
    const props = controlProps(child)
    if (props['role'] === role) found.push(child)
    found.push(...findLabeledByRole(props.children, role))
  }
  return found
}

test('moving keyboard focus between hunks never stages anything', () => {
  const side = hunks(2)
  const [first, second] = side.hunks

  assert.deepEqual(hunkKeyAction('ArrowDown', 0, 2), { type: 'move', index: 1 })
  assert.deepEqual(hunkKeyAction('ArrowUp', 1, 2), { type: 'move', index: 0 })
  assert.deepEqual(hunkKeyAction('Home', 1, 2), { type: 'move', index: 0 })
  assert.deepEqual(hunkKeyAction('End', 0, 2), { type: 'move', index: 1 })
  assert.deepEqual(
    hunkKeyAction('ArrowDown', 1, 2),
    { type: 'move', index: 1 },
    'movement stops at the last hunk',
  )
  assert.deepEqual(
    hunkKeyAction('ArrowUp', 0, 2),
    { type: 'move', index: 0 },
    'movement stops at the first hunk',
  )
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    const action = hunkKeyAction(key, 0, 2)
    assert.equal(action?.type, 'move', `${key} only moves`)
  }
  assert.equal(hunkKeyAction('ArrowLeft', 0, 2), null, 'an unmapped key is left to the browser')

  const hunkSections = [
    ...markup(React.createElement(HunkList, listProps({ side, focused: 0 }))).matchAll(
      /<section\b[^>]*aria-label="Hunk \d+ of \d+[^"]*"[^>]*>/gu,
    ),
  ].map((match) => match[0])
  assert.equal(hunkSections.length, 2, 'both hunks render as labelled groups')
  assert.deepEqual(
    hunkSections
      .filter((section) => /\stabindex="0"(?=[\s/>])/u.test(section))
      .map((section) => /aria-label="(Hunk \d+ of \d+)/u.exec(section)?.[1]),
    ['Hunk 1 of 2'],
    'only the focused hunk is in the tab order',
  )
  assert.deepEqual(
    hunkSections
      .filter((section) => /\stabindex="-1"(?=[\s/>])/u.test(section))
      .map((section) => /aria-label="(Hunk \d+ of \d+)/u.exec(section)?.[1]),
    ['Hunk 2 of 2'],
    'the hunk that is not focused stays out of the tab order',
  )
  assert.match(hunkSections[1]!, /aria-label="Hunk 2 of 2, lines 41–42 become 41–42"/u)
  assert.ok(
    !hunkSections.some((section) => section.includes('file-row-selected')),
    'visual focus is never presented as staging',
  )

  const secondFocused = markup(React.createElement(HunkList, listProps({ side, focused: 1 })))
  assert.deepEqual(
    [...secondFocused.matchAll(/<section\b[^>]*aria-label="(Hunk \d+ of \d+)[^"]*"[^>]*>/gu)]
      .filter((match) => /\stabindex="0"(?=[\s/>])/u.test(match[0]))
      .map((match) => match[1]),
    ['Hunk 2 of 2'],
    'focus moves with the roving tabindex',
  )
  assert.notEqual(first.id, second.id)
})

test('hunk shortcuts ignore nested line controls, modifiers and repeated writes', () => {
  const applied: HunkSelection[] = []
  const moved: number[] = []
  const element = HunkList(
    listProps({
      side: hunks(1),
      onApply: (selection) => applied.push(selection),
      onMove: (index) => moved.push(index),
    }),
  )
  const section = findLabeledByRole(element, 'group')[0]
  assert.ok(section)
  const onKeyDown = controlProps(section).onKeyDown
  assert.ok(onKeyDown)
  let prevented = 0
  const event = (key: string, target: object, extras: Record<string, boolean> = {}) => ({
    key,
    target,
    currentTarget: section,
    preventDefault: () => {
      prevented += 1
    },
    ...extras,
  })
  onKeyDown(event('Enter', {}, {}))
  onKeyDown(event('ArrowDown', {}, {}))
  onKeyDown(event('s', section, { ctrlKey: true }))
  onKeyDown(event('s', section, { repeat: true }))
  assert.deepEqual(applied, [], 'line-toggle keyboard activation cannot bubble into staging')
  assert.deepEqual(moved, [])
  onKeyDown(event('ArrowDown', section))
  assert.deepEqual(moved, [0])
  onKeyDown(event('s', section))
  assert.equal(applied.length, 1)
  assert.equal(prevented, 3)
})

test('a narrowed hunk states what it will stage and keeps the rest included', () => {
  const side = hunks(1)
  const [hunk] = side.hunks
  const whole = markup(React.createElement(HunkList, listProps({ side })))
  assert.match(whole, /Stage hunk/u)
  assert.ok(!whole.includes('changed lines'), 'a whole hunk needs no line count')
  assert.match(whole, /aria-pressed="true"/u, 'every changed line starts out included')

  const narrowedMarkup = markup(
    React.createElement(HunkList, listProps({ side, excluded: { [hunk.id]: [2] } })),
  )
  assert.match(narrowedMarkup, /1 of 2 changed lines/u)
  assert.match(narrowedMarkup, /Stage 1 lines/u, 'the control says what it will stage')
  assert.match(
    narrowedMarkup,
    /aria-pressed="false"[^>]*aria-label="Include line 3 of this hunk"/u,
    'the excluded line offers itself back',
  )
  assert.match(narrowedMarkup, /aria-label="Exclude line 2 of this hunk, file line 2"/u)

  const nothing = markup(
    React.createElement(HunkList, listProps({ side, excluded: { [hunk.id]: [1, 2] } })),
  )
  assert.match(nothing, /<button[^>]*disabled/u, 'a hunk with no line left cannot be staged')
})

test('a line toggle changes the patch that the hunk control applies', () => {
  const [hunk] = hunks(1).hunks
  const changed = changedLineIndexes(hunk)
  assert.deepEqual(changed, [1, 2], 'only added and removed lines can be selected')

  assert.equal(selectedLineIndexes(hunk, undefined), undefined, 'no selection means the whole hunk')
  assert.equal(selectedLineIndexes(hunk, []), undefined)
  assert.deepEqual(selectedLineIndexes(hunk, [2]), [1])

  const dropped = toggleExcludedLine({}, hunk.id, 2)
  assert.deepEqual(dropped, { [hunk.id]: [2] })
  assert.deepEqual(selectedLineIndexes(hunk, dropped[hunk.id]), [1])
  assert.deepEqual(
    selectedLineIndexes(hunk, toggleExcludedLine(dropped, hunk.id, 2)[hunk.id]),
    undefined,
    'toggling the same line back restores the whole hunk',
  )
  assert.deepEqual(
    Object.keys(toggleExcludedLine(dropped, '2222222222222222', 1)),
    [hunk.id, '2222222222222222'],
    'another hunk keeps its own selection',
  )

  const rendered = markup(React.createElement(HunkList, listProps({ side: hunks(1) })))
  assert.match(rendered, /aria-label="Stage hunk 1 of 1"/u, 'the hunk has its own control')
  assert.match(hunkMarkup(hunks(1), 'staged'), /Staged hunks/u, 'a staged side is labelled as such')
  assert.ok(
    !hunkMarkup(hunks(1), 'staged').includes('aria-label="Stage hunk'),
    'the staged side never offers staging',
  )
})

test('a side that cannot be patched says so instead of offering hunks', () => {
  const markup = hunkMarkup({
    hunks: [],
    unavailable: 'This file is binary, so it cannot be patched hunk by hunk.',
  })
  assert.match(markup, /This file is binary, so it cannot be patched hunk by hunk\./u)
  assert.ok(!markup.includes('hunk-line-selectable'), 'no hunk control is offered')
})

test('file staging reads as three states, independent of the file row', async () => {
  const snapshot = changesSnapshots.mixed
  const partial = snapshot.files.find((file) => file.index === 'M' && file.worktree === 'M')
  const staged = snapshot.files.find((file) => file.index === 'M' && file.worktree === ' ')
  const unstaged = snapshot.files.find((file) => file.index === ' ' && file.worktree === 'M')
  const conflicted = snapshot.files.find((file) => file.conflicted)
  assert.ok(partial && staged && unstaged && conflicted, 'the fixture covers every staging state')
  assert.equal(fileStagingState(partial), 'partial')
  assert.equal(fileStagingState(staged), 'staged')
  assert.equal(fileStagingState(unstaged), 'unstaged')

  const actions: GitAction[] = []
  const inspected: (string | null)[] = []
  const view = renderTree(ChangesView, {
    actionError: null,
    busy: false,
    busyAction: null,
    commitAmend: false,
    commitMessage: '',
    groups: changeGroups(snapshot.files, ''),
    inspectedPath: null,
    onCommitAmendChange: () => undefined,
    onCommitMessageChange: () => undefined,
    onInspect: (path: string | null) => inspected.push(path),
    onStash: () => undefined,
    onSubmitCommit: () => undefined,
    onResolveConflict: () => undefined,
    operationActive: false,
    runAction: async (action: GitAction) => {
      actions.push(action)
      return true
    },
    snapshot,
  })
  const rendered = markup(view)
  assert.match(rendered, /data-staging="partial"/u)
  assert.match(rendered, /data-staging="staged"/u)
  assert.match(rendered, /data-staging="unstaged"/u)
  assert.ok(!rendered.includes('file-row-selected'), 'a file row is not a staging state')

  const stagingControl = findLabeled(view, `Unstage ${partial.path}`)
  const inspector = findLabeled(view, `Inspect ${partial.path}`)
  assert.ok(stagingControl && inspector, 'staging and inspection are separate controls')
  assert.notEqual(stagingControl, inspector)
  const onCheckedChange = stagingControl && controlProps(stagingControl).onCheckedChange
  assert.equal(typeof onCheckedChange, 'function')
  await onCheckedChange?.(true)
  controlProps(inspector).onClick?.()
  assert.deepEqual(actions, [{ type: 'unstage', paths: [partial.path] }])
  assert.deepEqual(inspected, [partial.path], 'the row still only inspects')

  const conflictedControl = findLabeled(view, `Stage ${conflicted.path}`)
  assert.equal(
    conflictedControl && controlProps(conflictedControl).disabled,
    true,
    'a conflicted file cannot be staged',
  )
  assert.match(
    rendered,
    new RegExp(`data-staging="${fileStagingState(conflicted)}"`, 'u'),
    'the row states the staging state it would apply to',
  )
  assert.equal(fileViewFixtures.bothSides.hunks.unstaged.hunks.length, 1)
})
