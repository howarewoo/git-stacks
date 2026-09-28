import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  getConflictView,
  getFileView,
  getSnapshot,
  resolveRepository,
  runAction,
  runConflictMergeTool,
  runResolveConflict,
} from '../src/main/git'
import {
  composeConflict,
  conflictKind,
  conflictLabels,
  conflictRegions,
  hasConflictMarkers,
  parseConflictSegments,
} from '../src/shared/conflict'
import type { GitOperation } from '../src/shared/types'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-conflict-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  /** A command that must succeed. */
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  /** A command that is expected to fail, such as the operation that conflicts. */
  const gitExpectedFailure = (...args: string[]) =>
    spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout.trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Git Stacks test')
  git('config', 'user.email', 'test@example.invalid')
  return { root, repo, git, gitExpectedFailure }
}

const labelsFor = (operation: GitOperation | null) =>
  conflictLabels({
    operation,
    currentBranch: 'feature',
    incomingSubject: '9f1c2ab Rename and rewrite the manual',
    incomingRef: '9f1c2ab',
    stash: null,
    stashAvailable: false,
  })

const stageOid = (git: (...args: string[]) => string, stage: string, path: string) =>
  git('ls-files', '--unmerged', '--', path)
    .split('\n')
    .map((line) => line.split(/\s+/u))
    .find((parts) => parts[2] === stage)?.[1] ?? ''

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await access(file)
      return
    } catch {
      await delay(25)
    }
  }
  throw new Error(`Timed out waiting for external merge tool: ${file}`)
}

test('a file without conflict markers reports no regions and no marker form', () => {
  const segments = parseConflictSegments('const a = 1\nconst b = 2\n')
  assert.deepEqual(segments, [{ kind: 'text', text: 'const a = 1\nconst b = 2\n' }])
  assert.deepEqual(conflictRegions(segments), [])
  assert.equal(hasConflictMarkers('const a = 1\n'), false)
})

test('a conflict marker left unterminated is preserved as text instead of losing lines', () => {
  const body = '<<<<<<< HEAD\nkept\n=======\narrived\n'
  assert.equal(hasConflictMarkers(body), true)
  const segments = parseConflictSegments(body)
  assert.deepEqual(segments, [{ kind: 'text', text: body }])
  assert.equal(composeConflict(segments, {}), body)
})
test('a complete region followed by an unterminated marker keeps only the later raw block', () => {
  const body =
    'head\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\nmiddle\n<<<<<<< HEAD\nunfinished\n=======\npending\n'
  const segments = parseConflictSegments(body)
  assert.deepEqual(conflictRegions(segments), [
    { index: 0, startLine: 2, current: 'current\n', incoming: 'incoming\n' },
  ])
  assert.equal(
    composeConflict(segments, { 0: 'incoming' }),
    'head\nincoming\nmiddle\n<<<<<<< HEAD\nunfinished\n=======\npending\n',
  )
  assert.equal(hasConflictMarkers(composeConflict(segments, { 0: 'incoming' })), true)
})

test('widened rename conflict markers remain visible and cannot be staged unresolved', () => {
  const body =
    'before\n<<<<<<<< HEAD:current.txt\nours\n========\ntheirs\n>>>>>>>> topic:incoming.txt\n'
  const segments = parseConflictSegments(body)
  assert.deepEqual(conflictRegions(segments), [
    { index: 0, startLine: 2, current: 'ours\n', incoming: 'theirs\n' },
  ])
  assert.equal(hasConflictMarkers(body), true)
  assert.equal(composeConflict(segments, { 0: 'current' }), 'before\nours\n')
  assert.equal(hasConflictMarkers(composeConflict(segments, { 0: 'incoming' })), false)
})

test('a diff3 conflict is reported as one region with the base stage kept out of the choice', () => {
  const body = [
    'header',
    '<<<<<<< HEAD',
    'ours line',
    '||||||| merged common ancestors',
    'base line',
    '=======',
    'theirs line',
    '>>>>>>> topic',
    'footer',
  ].join('\n')
  const segments = parseConflictSegments(body)
  assert.equal(segments.filter((segment) => segment.kind === 'conflict').length, 1)
  assert.equal(
    composeConflict(segments, { 0: 'both' }),
    ['header', 'ours line', 'theirs line', 'footer'].join('\n'),
  )
  assert.deepEqual(conflictRegions(segments), [
    { index: 0, startLine: 2, current: 'ours line\n', incoming: 'theirs line\n' },
  ])
  assert.equal(segments[0].kind === 'text' && segments[0].text, 'header\n')
  assert.equal(segments[2].kind === 'text' && segments[2].text, 'footer')
})

test('composing a file applies every region choice and leaves the rest byte for byte', () => {
  const body = [
    'top',
    '<<<<<<< HEAD',
    'ours-a',
    'ours-b',
    '=======',
    'theirs',
    '>>>>>>> topic',
    'between',
    '<<<<<<< HEAD',
    'ours',
    '=======',
    'theirs',
    '>>>>>>> topic',
    'bottom',
  ].join('\n')
  const segments = parseConflictSegments(body)
  assert.equal(
    composeConflict(segments, { 0: 'current', 1: 'incoming' }),
    ['top', 'ours-a', 'ours-b', 'between', 'theirs', 'bottom'].join('\n'),
  )
  assert.equal(
    composeConflict(segments, { 0: 'both', 1: 'current' }),
    ['top', 'ours-a', 'ours-b', 'theirs', 'between', 'ours', 'bottom'].join('\n'),
  )
  assert.equal(
    composeConflict(segments, { 0: 'delete', 1: 'current' }),
    ['top', 'between', 'ours', 'bottom'].join('\n'),
  )
  assert.equal(
    composeConflict(segments, {
      0: { kind: 'manual', text: 'a hand written region\n' },
      1: 'current',
    }),
    ['top', 'a hand written region', 'between', 'ours', 'bottom'].join('\n'),
  )
  for (const literal of ['current', 'incoming', 'both', 'delete']) {
    assert.equal(
      composeConflict(segments, { 0: { kind: 'manual', text: literal }, 1: 'delete' }),
      `top\n${literal}between\nbottom`,
    )
  }
  assert.equal(
    hasConflictMarkers(composeConflict(segments, { 0: 'current', 1: 'incoming' })),
    false,
  )
})

test('the index stages alone name the structural kind of every conflict', () => {
  assert.equal(conflictKind([1, 2, 3], false), 'content')
  assert.equal(conflictKind([2, 3], false), 'addAdd')
  assert.equal(conflictKind([1, 2], false), 'modifyDelete')
  assert.equal(conflictKind([1, 3], false), 'deleteModify')
  assert.equal(conflictKind([2, 3], true), 'rename')
  assert.equal(conflictKind([1, 3], true), 'rename')
})

test('a rebase names both sides for what they are and never leaves a bare ours or theirs', () => {
  const rebase = labelsFor('rebase')
  assert.equal(rebase.operation, 'rebase')
  assert.equal(rebase.title, 'Rebase conflict')
  assert.equal(rebase.incoming, 'Commit being applied — 9f1c2ab Rename and rewrite the manual')
  assert.match(rebase.explanation, /reverse of a merge/u)
  assert.match(rebase.explanation, /9f1c2ab/u)
  assert.doesNotMatch(rebase.current, /\bours\b|\btheirs\b/u)
  assert.doesNotMatch(rebase.incoming, /\bours\b|\btheirs\b/u)
})

test('cherry-pick, revert, and a merge each name the incoming side for what it is', () => {
  assert.equal(labelsFor('cherryPick').title, 'Cherry-pick conflict')
  assert.match(labelsFor('cherryPick').incoming, /^Commit being applied/u)
  assert.equal(labelsFor('revert').title, 'Revert conflict')
  assert.match(labelsFor('revert').incoming, /^Reverted commit/u)
  assert.match(labelsFor('revert').explanation, /reverse of the reverted commit/u)
  assert.equal(labelsFor('merge').title, 'Merge conflict')
  assert.equal(labelsFor('merge').current, 'Current branch (feature)')
  assert.match(labelsFor('merge').incoming, /^Incoming commit/u)
})

test('a stash apply is only claimed when a stash entry proves the incoming stage', () => {
  const proved = conflictLabels({
    operation: null,
    currentBranch: 'feature',
    incomingSubject: null,
    incomingRef: null,
    stash: { ref: 'stash@{0}', message: 'WIP on feature: manual rewrite' },
    stashAvailable: true,
  })
  assert.equal(proved.operation, 'stashApply')
  assert.match(proved.incoming, /stash@\{0\} \(WIP on feature: manual rewrite\)/u)
  assert.match(proved.explanation, /proved by matching index stage 3/u)

  const unproved = conflictLabels({
    operation: null,
    currentBranch: 'feature',
    incomingSubject: null,
    incomingRef: null,
    stash: null,
    stashAvailable: true,
  })
  assert.equal(unproved.operation, 'unknown')
  assert.equal(unproved.incoming, 'Stage 3 — content being applied')
  assert.match(unproved.explanation, /no stash entry matches it either/u)
})

test('an operation Git records as "other" never borrows another operation’s side names', () => {
  const other = labelsFor('other')
  assert.equal(other.operation, 'unknown')
  assert.match(other.title, /no recorded operation/u)
  assert.doesNotMatch(other.explanation, /Rebase conflict|Merge conflict/u)
})

test('a rebase conflict resolves region by region, then continues on the same rebase', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\nintact\n')
    await writeFile(join(repo, 'other.txt'), 'base\nintact\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\nintact\n')
    await writeFile(join(repo, 'other.txt'), 'topic\nintact\n')
    git('add', '.')
    git('commit', '-m', 'Topic edits both files')
    const topic = git('rev-parse', 'HEAD')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\nintact\n')
    await writeFile(join(repo, 'other.txt'), 'main\nintact\n')
    git('add', '.')
    git('commit', '-m', 'Main edits both files')
    git('checkout', 'topic')
    gitExpectedFailure('rebase', 'main')

    await resolveRepository(repo)
    const conflicted = await getConflictView(repo, 'shared.txt')
    assert.equal(conflicted.path, 'shared.txt')
    assert.equal(conflicted.labels.operation, 'rebase')
    assert.equal(conflicted.kind, 'content')
    assert.deepEqual(conflicted.stages, [1, 2, 3])
    assert.equal(conflicted.base, 'base\nintact\n')
    assert.equal(conflicted.current, 'main\nintact\n')
    assert.equal(conflicted.incoming, 'topic\nintact\n')
    assert.equal(conflicted.worktree?.includes('<<<<<<< HEAD'), true)
    assert.deepEqual(conflicted.moves, [])
    assert.deepEqual(conflicted.regions, [
      { index: 0, startLine: 1, current: 'main\n', incoming: 'topic\n' },
    ])
    assert.equal(conflicted.labels.title, 'Rebase conflict')
    assert.equal(conflicted.mergeTool.available, false)

    const untouched = await getConflictView(repo, 'other.txt')
    assert.deepEqual(
      untouched.regions.map((region) => region.current),
      ['main\n'],
    )
    assert.notEqual(untouched.fingerprint, conflicted.fingerprint)

    const indexPath = join(repo, git('rev-parse', '--git-path', 'index'))
    await chmod(indexPath, 0o660)
    const result = await runResolveConflict(repo, 'shared.txt', conflicted.fingerprint, {
      kind: 'content',
      content: 'merged\nintact\n',
    })
    assert.match(result.message, /shared\.txt/u)
    assert.equal((await stat(indexPath)).mode & 0o777, 0o660)
    assert.equal(
      git('ls-files', '--unmerged', '--', 'other.txt') !== '',
      true,
      'the second file stays conflicted until it is resolved too',
    )
    await runResolveConflict(repo, 'other.txt', untouched.fingerprint, {
      kind: 'content',
      content: 'merged\nintact\n',
    })
    assert.equal(git('ls-files', '--unmerged'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'merged\nintact\n')
    assert.equal(git('ls-files', '--unmerged', '--', 'shared.txt'), '')
    assert.equal(git('diff', '--cached', '--name-only', '--', 'shared.txt'), 'shared.txt')
    const snapshot = await getSnapshot(repo)
    assert.equal(snapshot.rebaseInProgress, true)
    await runAction(repo, { type: 'rebaseContinue' })
    assert.equal(git('branch', '--show-current'), 'topic')
    assert.equal(git('log', '-1', '--format=%s'), 'Topic edits both files')
    assert.equal(git('rev-parse', 'HEAD^'), git('rev-parse', 'main'))
    assert.notEqual(git('rev-parse', 'HEAD'), topic)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'merged\nintact\n')
    assert.equal(await readFile(join(repo, 'other.txt'), 'utf8'), 'merged\nintact\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an add/add conflict stays an addition despite an unrelated deletion and stages both copies', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(
      join(repo, 'readme.md'),
      'An unrelated document with no text in common with the feature.\n',
    )
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'feature.txt'), 'topic\n')
    git('rm', '-q', 'readme.md')
    git('add', '.')
    git('commit', '-m', 'Topic adds a feature file')
    git('checkout', 'main')
    await writeFile(join(repo, 'feature.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main adds the same feature file')
    gitExpectedFailure('merge', 'topic')
    assert.match(git('diff', '--name-status', '-M', 'main^', 'topic'), /D\treadme\.md/u)

    const conflicted = await getConflictView(repo, 'feature.txt')
    assert.equal(conflicted.kind, 'addAdd')
    assert.deepEqual(conflicted.stages, [2, 3])
    assert.equal(conflicted.base, null)
    assert.equal(conflicted.current, 'main\n')
    assert.equal(conflicted.incoming, 'topic\n')
    assert.deepEqual(conflicted.moves, [])
    assert.equal(conflicted.labels.operation, 'merge')

    await runResolveConflict(repo, 'feature.txt', conflicted.fingerprint, {
      kind: 'choice',
      choice: 'both',
    })
    assert.equal(git('ls-files', '--unmerged', '--', 'feature.txt'), '')
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'main\ntopic\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a delete/modify conflict offers the deletion and the surviving file as distinct outcomes', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'docs.txt'), 'shared docs\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'docs.txt'), 'docs from topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic rewrites the docs')
    git('checkout', 'main')
    git('rm', '-q', 'docs.txt')
    git('commit', '-m', 'Main removes the docs')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'docs.txt')
    assert.equal(conflicted.kind, 'deleteModify')
    assert.deepEqual(conflicted.stages, [1, 3])
    assert.equal(conflicted.current, null)
    assert.equal(conflicted.base, 'shared docs\n')
    assert.equal(conflicted.worktree, 'docs from topic\n')
    assert.equal(conflicted.binary, false)
    assert.equal(conflicted.regions.length, 0)

    await writeFile(join(repo, 'docs.txt'), 'externally edited\n')
    await assert.rejects(
      runResolveConflict(repo, 'docs.txt', conflicted.fingerprint, {
        kind: 'choice',
        choice: 'delete',
      }),
      /changed since/u,
    )
    assert.equal(await readFile(join(repo, 'docs.txt'), 'utf8'), 'externally edited\n')
    assert.notEqual(git('ls-files', '--unmerged', '--', 'docs.txt'), '')
    const refreshed = await getConflictView(repo, 'docs.txt')
    await runResolveConflict(repo, 'docs.txt', refreshed.fingerprint, {
      kind: 'choice',
      choice: 'delete',
    })
    assert.equal(git('ls-files', '--unmerged', '--', 'docs.txt'), '')
    assert.equal(git('diff', '--cached', '--name-status', '--', 'docs.txt'), '')
    git('commit', '-m', 'Keep the deletion')
    assert.equal(git('ls-tree', '-r', '--name-only', 'HEAD').includes('docs.txt'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a modify/delete conflict keeps the file the incoming side deleted from view honestly', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'docs.txt'), 'shared docs\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    git('rm', '-q', 'docs.txt')
    git('commit', '-m', 'Topic removes the docs')
    git('checkout', 'main')
    await writeFile(join(repo, 'docs.txt'), 'docs from main\n')
    git('add', '.')
    git('commit', '-m', 'Main rewrites the docs')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'docs.txt')
    assert.equal(conflicted.kind, 'modifyDelete')
    assert.deepEqual(conflicted.stages, [1, 2])
    assert.equal(conflicted.incoming, null)
    assert.equal(conflicted.base, 'shared docs\n')
    assert.equal(conflicted.current, 'docs from main\n')

    await assert.rejects(
      runResolveConflict(repo, 'docs.txt', conflicted.fingerprint, {
        kind: 'choice',
        choice: 'incoming',
      }),
      /accept the deletion/u,
    )
    await runResolveConflict(repo, 'docs.txt', conflicted.fingerprint, {
      kind: 'content',
      content: 'docs kept from main\n',
    })
    assert.equal(await readFile(join(repo, 'docs.txt'), 'utf8'), 'docs kept from main\n')
    assert.equal(git('status', '--porcelain=v1', '--', 'docs.txt'), 'M  docs.txt')
    git('commit', '-m', 'Keep the rewritten docs')
    assert.equal(git('ls-files', '--unmerged'), '')

    git('checkout', '-b', 'second', 'HEAD~2')
    await writeFile(join(repo, 'docs.txt'), 'docs from main again\n')
    git('add', '.')
    git('commit', '-m', 'Main rewrites the docs again')
    gitExpectedFailure('merge', 'topic')
    const deleted = await getConflictView(repo, 'docs.txt')
    assert.equal(deleted.kind, 'modifyDelete')
    await runResolveConflict(repo, 'docs.txt', deleted.fingerprint, {
      kind: 'choice',
      choice: 'delete',
    })
    assert.equal(git('status', '--porcelain=v1', '--', 'docs.txt'), 'D  docs.txt')
    git('commit', '-m', 'Accept the incoming deletion')
    assert.equal(git('ls-tree', '-r', '--name-only', 'HEAD').includes('docs.txt'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a merge where both sides renamed the same file into the same name carries the move evidence', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    const original = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n') + '\n'
    await writeFile(join(repo, 'old.txt'), original)
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    git('mv', 'old.txt', 'new.txt')
    await writeFile(join(repo, 'new.txt'), original.replace('line 19', 'topic'))
    git('add', '-A')
    git('commit', '-m', 'Topic renames the file')
    git('checkout', 'main')
    git('mv', 'old.txt', 'new.txt')
    await writeFile(join(repo, 'new.txt'), original.replace('line 19', 'main'))
    git('add', '-A')
    git('commit', '-m', 'Main renames the file too')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'new.txt')
    assert.equal(conflicted.kind, 'rename')
    assert.deepEqual(conflicted.moves, [
      { from: 'old.txt', to: 'new.txt', side: 'current' },
      { from: 'old.txt', to: 'new.txt', side: 'incoming' },
    ])
    assert.deepEqual(conflicted.stages, [1, 2, 3])
    assert.deepEqual(conflicted.regions, [
      { index: 0, startLine: 20, current: 'main\n', incoming: 'topic\n' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('divergent real renames retain Git-recorded destinations and resolve selected paths', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    const original = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n') + '\n'
    await writeFile(join(repo, 'old.txt'), original)
    git('add', '.')
    git('commit', '-m', 'Original file')
    git('checkout', '-b', 'topic')
    git('mv', 'old.txt', 'incoming.txt')
    await writeFile(join(repo, 'incoming.txt'), original.replace('line 29', 'incoming'))
    git('add', '-A')
    git('commit', '-m', 'Incoming rename')
    git('checkout', 'main')
    git('mv', 'old.txt', 'current.txt')
    await writeFile(join(repo, 'current.txt'), original.replace('line 29', 'current'))
    git('add', '-A')
    git('commit', '-m', 'Current rename')
    assert.match(
      git('diff', '--name-status', '-M', 'main^', 'main'),
      /R\d+\told\.txt\tcurrent\.txt/u,
    )
    assert.match(
      git('diff', '--name-status', '-M', 'topic^', 'topic'),
      /R\d+\told\.txt\tincoming\.txt/u,
    )
    gitExpectedFailure('merge', 'topic')
    const current = await getConflictView(repo, 'current.txt')
    const incoming = await getConflictView(repo, 'incoming.txt')
    assert.deepEqual(current.moves, [{ from: 'old.txt', to: 'current.txt', side: 'current' }])
    assert.deepEqual(incoming.moves, [{ from: 'old.txt', to: 'incoming.txt', side: 'incoming' }])
    assert.equal(current.kind, 'rename')
    assert.equal(incoming.kind, 'rename')
    assert.deepEqual(current.regions, [
      { index: 0, startLine: 30, current: 'current\n', incoming: 'incoming\n' },
    ])
    await assert.rejects(
      runResolveConflict(repo, 'current.txt', current.fingerprint, {
        kind: 'content',
        content: current.worktree!,
      }),
      /Conflict markers are still present/u,
    )
    assert.notEqual(git('ls-files', '--unmerged', '--', 'current.txt'), '')
    await runResolveConflict(repo, 'current.txt', current.fingerprint, {
      kind: 'choice',
      choice: 'current',
    })
    assert.notEqual(git('ls-files', '--unmerged', '--', 'incoming.txt'), '')
    await runResolveConflict(repo, 'incoming.txt', incoming.fingerprint, {
      kind: 'choice',
      choice: 'incoming',
    })
    const source = await getConflictView(repo, 'old.txt')
    assert.equal(source.kind, 'rename')
    assert.deepEqual(source.stages, [1])
    assert.deepEqual(source.moves, [
      { from: 'old.txt', to: 'current.txt', side: 'current' },
      { from: 'old.txt', to: 'incoming.txt', side: 'incoming' },
    ])
    await runResolveConflict(repo, 'old.txt', source.fingerprint, {
      kind: 'choice',
      choice: 'delete',
    })
    assert.equal(git('ls-files', '--unmerged'), '')
    assert.equal(
      await readFile(join(repo, 'current.txt'), 'utf8'),
      original.replace('line 29', 'current'),
    )
    assert.equal(
      await readFile(join(repo, 'incoming.txt'), 'utf8'),
      original.replace('line 29', 'incoming'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Unicode and quoted divergent rename paths keep their recorded moves and selected bytes', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    const original = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n') + '\n'
    const currentPath = 'résumé\t"current".txt'
    const incomingPath = 'renamed\\incoming.txt'
    await writeFile(join(repo, 'old.txt'), original)
    git('add', '.')
    git('commit', '-m', 'Original file')
    git('checkout', '-b', 'topic')
    git('mv', 'old.txt', incomingPath)
    await writeFile(join(repo, incomingPath), original.replace('line 29', 'incoming'))
    git('add', '-A')
    git('commit', '-m', 'Incoming rename')
    git('checkout', 'main')
    git('mv', 'old.txt', currentPath)
    await writeFile(join(repo, currentPath), original.replace('line 29', 'current'))
    git('add', '-A')
    git('commit', '-m', 'Current rename')
    gitExpectedFailure('merge', 'topic')
    const current = await getConflictView(repo, currentPath)
    const incoming = await getConflictView(repo, incomingPath)
    assert.deepEqual(current.moves, [{ from: 'old.txt', to: currentPath, side: 'current' }])
    assert.deepEqual(incoming.moves, [{ from: 'old.txt', to: incomingPath, side: 'incoming' }])
    assert.equal(current.kind, 'rename')
    assert.equal(incoming.kind, 'rename')
    await runResolveConflict(repo, currentPath, current.fingerprint, {
      kind: 'choice',
      choice: 'current',
    })
    await runResolveConflict(repo, incomingPath, incoming.fingerprint, {
      kind: 'choice',
      choice: 'incoming',
    })
    assert.equal(
      await readFile(join(repo, currentPath), 'utf8'),
      original.replace('line 29', 'current'),
    )
    assert.equal(
      await readFile(join(repo, incomingPath), 'utf8'),
      original.replace('line 29', 'incoming'),
    )
    assert.notEqual(git('ls-files', '--unmerged', '--', 'old.txt'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('a path nobody moved is not reported as renamed', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'old.txt'), 'base\n')
    await writeFile(join(repo, 'kept.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    git('mv', 'old.txt', 'new.txt')
    await writeFile(join(repo, 'kept.txt'), 'topic\n')
    git('add', '-A')
    git('commit', '-m', 'Topic renames one file and edits another')
    git('checkout', 'main')
    await writeFile(join(repo, 'kept.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edits the other file')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'kept.txt')
    assert.equal(conflicted.kind, 'content')
    assert.deepEqual(conflicted.moves, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a binary conflict is never resolved from text, and keeping both copies is refused', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'logo.png'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'logo.png'), Buffer.from([9, 0, 9, 9, 9, 9, 9, 9]))
    git('add', '.')
    git('commit', '-m', 'Topic replaces the image')
    git('checkout', 'main')
    await writeFile(join(repo, 'logo.png'), Buffer.from([7, 0, 7, 7, 7, 7, 7, 7]))
    git('add', '.')
    git('commit', '-m', 'Main replaces the image')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'logo.png')
    assert.equal(conflicted.binary, true)
    assert.deepEqual(conflicted.regions, [])
    assert.equal(conflicted.worktree, null)
    assert.equal(conflicted.current, null)
    assert.equal(conflicted.incoming, null)

    await assert.rejects(
      runResolveConflict(repo, 'logo.png', conflicted.fingerprint, {
        kind: 'content',
        content: 'not the image\n',
      }),
      /binary file/u,
    )
    await assert.rejects(
      runResolveConflict(repo, 'logo.png', conflicted.fingerprint, {
        kind: 'choice',
        choice: 'both',
      }),
      /both copies/u,
    )
    assert.equal(git('ls-files', '--unmerged', '--', 'logo.png') !== '', true)

    await runResolveConflict(repo, 'logo.png', conflicted.fingerprint, {
      kind: 'choice',
      choice: 'incoming',
    })
    assert.equal(git('ls-files', '--unmerged', '--', 'logo.png'), '')
    assert.deepEqual(Array.from(await readFile(join(repo, 'logo.png'))), [9, 0, 9, 9, 9, 9, 9, 9])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a file edited after it was opened is refused, and the edit survives untouched', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic edit')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edit')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'shared.txt')
    const edited = '<<<<<<< HEAD\nedited by hand\n=======\ntopic\n>>>>>>> topic\n'
    await writeFile(join(repo, 'shared.txt'), edited)
    await assert.rejects(
      runResolveConflict(repo, 'shared.txt', conflicted.fingerprint, {
        kind: 'content',
        content: 'resolved\n',
      }),
      /changed since/u,
    )
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), edited)
    assert.equal(git('ls-files', '--unmerged', '--', 'shared.txt') !== '', true)

    const refreshed = await getConflictView(repo, 'shared.txt')
    assert.notEqual(refreshed.fingerprint, conflicted.fingerprint)
    assert.equal(refreshed.regions[0].current, 'edited by hand\n')
    await runResolveConflict(repo, 'shared.txt', refreshed.fingerprint, {
      kind: 'content',
      content: 'resolved\n',
    })
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'resolved\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a changed unmerged stage rejects an old view without replacing the worktree', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic edit')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edit')
    gitExpectedFailure('merge', 'topic')
    const old = await getConflictView(repo, 'shared.txt')
    const original = await readFile(join(repo, 'shared.txt'), 'utf8')
    const changedOid = git('rev-parse', 'main:shared.txt')
    execFileSync('git', ['-C', repo, 'update-index', '--index-info'], {
      input: `100644 ${changedOid} 3\tshared.txt\n`,
    })
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), original)
    assert.notEqual(git('ls-files', '--unmerged', '--', 'shared.txt'), '')
    await assert.rejects(
      runResolveConflict(repo, 'shared.txt', old.fingerprint, {
        kind: 'choice',
        choice: 'incoming',
      }),
      /changed since/u,
    )
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), original)
    assert.notEqual(git('ls-files', '--unmerged', '--', 'shared.txt'), '')
    const refreshed = await getConflictView(repo, 'shared.txt')
    assert.equal(refreshed.incoming, 'main\n')
    assert.notEqual(refreshed.fingerprint, old.fingerprint)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('a resolution that still contains conflict markers is refused instead of staged', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic edit')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edit')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'shared.txt')
    await assert.rejects(
      runResolveConflict(repo, 'shared.txt', conflicted.fingerprint, {
        kind: 'content',
        content: 'resolved\n<<<<<<< HEAD\nstill split\n=======\nother side\n>>>>>>> topic\n',
      }),
      /markers are still present/u,
    )
    assert.equal(git('ls-files', '--unmerged', '--', 'shared.txt') !== '', true)
    assert.equal((await readFile(join(repo, 'shared.txt'), 'utf8')).includes('<<<<<<< HEAD'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an already resolved path is refused instead of staged twice', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic edit')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edit')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'shared.txt')
    await runResolveConflict(repo, 'shared.txt', conflicted.fingerprint, {
      kind: 'choice',
      choice: 'incoming',
    })
    await assert.rejects(getConflictView(repo, 'shared.txt'), /no unresolved conflict/u)
    await assert.rejects(
      runResolveConflict(repo, 'shared.txt', conflicted.fingerprint, {
        kind: 'choice',
        choice: 'current',
      }),
      /changed since/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the external merge tool runs without staging, and its result can still be marked resolved', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    const marker = join(root, 'merge-tool-ran')
    const tool = join(root, 'fake-merge-tool.sh')
    await writeFile(tool, `#!/bin/sh\nprintf 'resolved by tool\\n' > "$1"\n: > "${marker}"\n`)
    await chmod(tool, 0o755)
    git('config', 'mergetool.git-stacks-test.trustExitCode', 'true')
    git('config', 'mergetool.git-stacks-test.cmd', `sh "${tool}" "$MERGED"`)
    git('config', 'merge.tool', 'git-stacks-test')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic edit')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edit')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'shared.txt')
    assert.equal(conflicted.mergeTool.available, true)
    assert.equal(conflicted.mergeTool.tool, 'git-stacks-test')

    await runConflictMergeTool(repo, 'shared.txt', conflicted.fingerprint)
    assert.equal(await readFile(marker, 'utf8'), '', 'the configured merge tool ran')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'resolved by tool\n')
    assert.notEqual(
      git('ls-files', '--unmerged', '--', 'shared.txt'),
      '',
      'live index remains conflicted',
    )
    const afterTool = await getConflictView(repo, 'shared.txt')
    assert.equal(afterTool.regions.length, 0, 'a clean tool result is still reviewable')
    assert.notEqual(afterTool.fingerprint, conflicted.fingerprint)
    await assert.rejects(
      runResolveConflict(repo, 'shared.txt', conflicted.fingerprint, {
        kind: 'content',
        content: 'stale\n',
      }),
      /changed since/u,
    )
    await runResolveConflict(repo, 'shared.txt', afterTool.fingerprint, {
      kind: 'content',
      content: afterTool.worktree!,
    })
    assert.equal(git('ls-files', '--unmerged', '--', 'shared.txt'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'resolved by tool\n')
    assert.equal(git('ls-files', '--unmerged', '--', 'shared.txt'), '')
    git('commit', '-m', 'Merge the tool result')
    assert.equal(git('rev-list', '--count', 'HEAD'), '4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an environment-selected merge tool overrides merge.tool in native Git dispatch', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  const previous = process.env.GIT_MERGE_TOOL
  try {
    git('config', 'mergetool.git-stacks-fallback.trustExitCode', 'true')
    git('config', 'mergetool.git-stacks-fallback.cmd', 'printf "wrong tool\\n" > "$MERGED"')
    git('config', 'mergetool.git-stacks-override.trustExitCode', 'true')
    git('config', 'mergetool.git-stacks-override.cmd', 'printf "chosen tool\\n" > "$MERGED"')
    git('config', 'merge.tool', 'git-stacks-fallback')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Base')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'incoming\n')
    git('commit', '-am', 'Incoming')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'current\n')
    git('commit', '-am', 'Current')
    gitExpectedFailure('merge', 'topic')
    process.env.GIT_MERGE_TOOL = 'git-stacks-override'
    const view = await getConflictView(repo, 'shared.txt')
    assert.equal(view.mergeTool.tool, 'git-stacks-override')
    await runConflictMergeTool(repo, 'shared.txt', view.fingerprint)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'chosen tool\n')
    assert.notEqual(git('ls-files', '--unmerged', '--', 'shared.txt'), '')
  } finally {
    if (previous === undefined) delete process.env.GIT_MERGE_TOOL
    else process.env.GIT_MERGE_TOOL = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a repository with no configured merge tool says so instead of guessing one', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic edit')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edit')
    gitExpectedFailure('merge', 'topic')

    const conflicted = await getConflictView(repo, 'shared.txt')
    assert.equal(conflicted.mergeTool.available, false)
    assert.match(conflicted.mergeTool.reason, /merge\.tool/u)
    await assert.rejects(
      runConflictMergeTool(repo, 'shared.txt', conflicted.fingerprint),
      /No merge tool is configured/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('an in-flight merge tool never touches live bytes and refuses a concurrent edit', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    const ready = join(root, 'ready')
    const release = join(root, 'release')
    const tool = join(root, 'wait-for-review.sh')
    await writeFile(
      tool,
      `#!/bin/sh\nprintf 'tool result\\n' > "$1"\n: > "${ready}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done\n`,
    )
    await chmod(tool, 0o755)
    git('config', 'mergetool.git-stacks-wait.trustExitCode', 'true')
    git('config', 'mergetool.git-stacks-wait.cmd', `sh "${tool}" "$MERGED"`)
    git('config', 'merge.tool', 'git-stacks-wait')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    await writeFile(join(repo, 'other.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Base')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    await writeFile(join(repo, 'other.txt'), 'topic\n')
    git('commit', '-am', 'Topic')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    await writeFile(join(repo, 'other.txt'), 'main\n')
    git('commit', '-am', 'Main')
    gitExpectedFailure('merge', 'topic')
    const view = await getConflictView(repo, 'shared.txt')
    const otherStages = git('ls-files', '-u', '--', 'other.txt')
    const initial = await readFile(join(repo, 'shared.txt'))
    const running = runConflictMergeTool(repo, view.path, view.fingerprint)
    try {
      await waitForFile(ready)
      assert.deepEqual(await readFile(join(repo, 'shared.txt')), initial)
      await writeFile(join(repo, 'shared.txt'), 'external edit during tool\n')
    } finally {
      await writeFile(release, '')
    }
    await assert.rejects(running, /changed during the action|changed while/u)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'external edit during tool\n')
    assert.notEqual(git('ls-files', '-u', '--', 'shared.txt'), '')
    assert.equal(git('ls-files', '-u', '--', 'other.txt'), otherStages)
    assert.equal(git('ls-files', '--stage', '--', 'shared.txt').includes('\tshared.txt'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const variant of ['binary', 'oversize'] as const) {
  test(`an external ${variant} result is staged whole, preserving bytes and unrelated entries`, async () => {
    const { root, repo, git, gitExpectedFailure } = await fixture()
    try {
      const filename = variant === 'binary' ? 'image.bin' : 'large.txt'
      const large = 34 * 1024 * 1024 + 17
      const base = variant === 'binary' ? Buffer.from([0, 1, 2]) : Buffer.alloc(large, 65)
      const incoming = variant === 'binary' ? Buffer.from([0, 3, 4]) : Buffer.alloc(large, 66)
      const current = variant === 'binary' ? Buffer.from([0, 5, 6]) : Buffer.alloc(large, 67)
      const resolved =
        variant === 'binary' ? Buffer.from([0, 127, 255, 42]) : Buffer.alloc(large + 9, 68)
      const resultPath = join(root, 'resolved-file')
      await writeFile(resultPath, resolved)
      git('config', 'mergetool.git-stacks-copy.trustExitCode', 'true')
      git('config', 'mergetool.git-stacks-copy.cmd', `cp "${resultPath}" "$MERGED"`)
      git('config', 'merge.tool', 'git-stacks-copy')
      await writeFile(join(repo, filename), base)
      await writeFile(join(repo, 'other.txt'), 'base\n')
      git('add', '.')
      git('commit', '-m', 'Base')
      git('checkout', '-b', 'topic')
      await writeFile(join(repo, filename), incoming)
      await writeFile(join(repo, 'other.txt'), 'topic\n')
      git('commit', '-am', 'Topic')
      git('checkout', 'main')
      await writeFile(join(repo, filename), current)
      await writeFile(join(repo, 'other.txt'), 'main\n')
      git('commit', '-am', 'Main')
      gitExpectedFailure('merge', 'topic')
      const view = await getConflictView(repo, filename)
      assert.equal(view.worktreePresent, true)
      assert.equal(variant === 'binary' ? view.binary : view.truncated, true)
      if (variant === 'oversize') {
        assert.deepEqual(view.stagePreviewTruncated, [1, 2, 3])
        assert.equal(view.current?.length, 2 * 1024 * 1024)
        assert.equal(view.incoming?.length, 2 * 1024 * 1024)
        const inspector = await getFileView(repo, filename)
        assert.equal(inspector.conflicted, true)
        assert.equal(inspector.truncated, true)
        assert.ok(Buffer.byteLength(inspector.stagedDiff) <= 4 * 1024 * 1024)
        assert.ok(Buffer.byteLength(inspector.unstagedDiff) <= 4 * 1024 * 1024)
      }
      const otherStages = git('ls-files', '-u', '--', 'other.txt')
      await runConflictMergeTool(repo, filename, view.fingerprint)
      assert.deepEqual(await readFile(join(repo, filename)), resolved)
      assert.notEqual(git('ls-files', '-u', '--', filename), '')
      const updated = await getConflictView(repo, filename)
      await assert.rejects(
        runResolveConflict(repo, filename, view.fingerprint, { kind: 'worktree' }),
        /changed since/u,
      )
      const lockPath = join(repo, '.git', 'index.lock')
      await writeFile(lockPath, 'another index writer')
      try {
        await assert.rejects(
          runResolveConflict(repo, filename, updated.fingerprint, { kind: 'worktree' }),
          /EEXIST/u,
        )
        assert.deepEqual(await readFile(join(repo, filename)), resolved)
        assert.notEqual(git('ls-files', '-u', '--', filename), '')
      } finally {
        await rm(lockPath)
      }
      await runResolveConflict(repo, filename, updated.fingerprint, { kind: 'worktree' })
      assert.equal(git('ls-files', '-u', '--', filename), '')
      assert.equal(git('ls-files', '-u', '--', 'other.txt'), otherStages)
      assert.deepEqual(await readFile(join(repo, filename)), resolved)
      assert.equal(git('rev-parse', `:${filename}`), git('hash-object', resultPath))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('a stage blob over 32 MiB opens with a bounded preview but accepting a side stages every byte', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    const bytes = 34 * 1024 * 1024 + 11
    const base = Buffer.alloc(bytes, 65)
    const incoming = Buffer.alloc(bytes, 66)
    const current = Buffer.alloc(bytes, 67)
    incoming.set(Buffer.from('incoming end'), bytes - 12)
    incoming[bytes - 1] = 0
    await writeFile(join(repo, 'large.bin'), base)
    git('add', '.')
    git('commit', '-m', 'Base')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'large.bin'), incoming)
    git('commit', '-am', 'Incoming')
    git('checkout', 'main')
    await writeFile(join(repo, 'large.bin'), current)
    git('commit', '-am', 'Current')
    gitExpectedFailure('merge', 'topic')
    const view = await getConflictView(repo, 'large.bin')
    assert.equal(view.truncated, true)
    assert.equal(view.binary, true, 'a NUL beyond the bounded preview is still detected')
    assert.equal(view.incoming, null)
    assert.deepEqual(view.stagePreviewTruncated, [1, 2, 3])
    const inspector = await getFileView(repo, 'large.bin')
    assert.equal(inspector.conflicted, true)
    assert.equal(inspector.binary, true, 'late NUL must not be shown as text in the inspector')
    assert.equal(inspector.content, null)
    await runResolveConflict(repo, 'large.bin', view.fingerprint, {
      kind: 'choice',
      choice: 'incoming',
    })
    assert.deepEqual(await readFile(join(repo, 'large.bin')), incoming)
    assert.equal(git('ls-files', '--unmerged', '--', 'large.bin'), '')
    assert.equal(git('rev-parse', ':large.bin'), git('rev-parse', 'topic:large.bin'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a conflicted cherry-pick resolves and continues through Git', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Base')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic edit')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edit')
    gitExpectedFailure('cherry-pick', 'topic')
    const view = await getConflictView(repo, 'shared.txt')
    assert.equal(view.labels.operation, 'cherryPick')
    assert.equal(view.base, 'base\n')
    assert.equal(view.current, 'main\n')
    assert.equal(view.incoming, 'topic\n')
    await runResolveConflict(repo, 'shared.txt', view.fingerprint, {
      kind: 'content',
      content: 'accepted cherry-pick\n',
    })
    await runAction(repo, { type: 'operationContinue' })
    assert.equal(git('log', '-1', '--format=%s'), 'Topic edit')
    assert.equal(git('ls-files', '--unmerged'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'accepted cherry-pick\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a conflicted revert resolves but Git abort restores the original commit and bytes', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Base')
    await writeFile(join(repo, 'shared.txt'), 'earlier edit\n')
    git('add', '.')
    git('commit', '-m', 'Earlier edit')
    const earlier = git('rev-parse', 'HEAD')
    await writeFile(join(repo, 'shared.txt'), 'latest edit\n')
    git('add', '.')
    git('commit', '-m', 'Latest edit')
    const latest = git('rev-parse', 'HEAD')
    gitExpectedFailure('revert', earlier)
    const view = await getConflictView(repo, 'shared.txt')
    assert.equal(view.labels.operation, 'revert')
    assert.equal(view.current, 'latest edit\n')
    assert.equal(view.incoming, 'base\n')
    await runResolveConflict(repo, 'shared.txt', view.fingerprint, {
      kind: 'content',
      content: 'resolved revert\n',
    })
    await runAction(repo, { type: 'operationAbort' })
    assert.equal(git('rev-parse', 'HEAD'), latest)
    assert.equal(git('ls-files', '--unmerged'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'latest edit\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('aborting a conflicted rebase restores the branch the rebase started on', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'shared.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'Topic edit')
    const topic = git('rev-parse', 'HEAD')
    git('checkout', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main edit')
    const before = git('rev-parse', 'main')
    git('checkout', 'topic')
    gitExpectedFailure('rebase', 'main')

    const conflicted = await getConflictView(repo, 'shared.txt')
    assert.equal(conflicted.labels.operation, 'rebase')
    await runResolveConflict(repo, 'shared.txt', conflicted.fingerprint, {
      kind: 'content',
      content: 'merged\n',
    })
    await runAction(repo, { type: 'operationAbort' })
    assert.equal(git('branch', '--show-current'), 'topic')
    assert.equal(git('rev-parse', 'main'), before)
    assert.equal(git('rev-parse', 'topic'), topic)
    assert.equal(git('ls-files', '--unmerged', '--', 'shared.txt'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'topic\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a stash apply conflict is only named a stash apply because a stash entry proves it', async () => {
  const { root, repo, git, gitExpectedFailure } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    await writeFile(join(repo, 'shared.txt'), 'stashed\n')
    git('stash', 'push', '-m', 'stashed edit')
    await writeFile(join(repo, 'shared.txt'), 'committed\n')
    git('add', '.')
    git('commit', '-m', 'Committed edit')
    gitExpectedFailure('stash', 'apply', 'stash@{0}')

    const conflicted = await getConflictView(repo, 'shared.txt')
    assert.equal(conflicted.labels.operation, 'stashApply')
    assert.match(conflicted.labels.incoming, /stashed edit/u)
    assert.equal(conflicted.kind, 'content')
    assert.equal(conflicted.regions[0].current, 'committed\n')
    assert.equal(conflicted.regions[0].incoming, 'stashed\n')

    git('stash', 'drop')
    assert.equal((await getConflictView(repo, 'shared.txt')).labels.operation, 'unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
