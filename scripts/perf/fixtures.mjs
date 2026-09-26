import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Benchmark fixtures are generated locally with the `git` on the machine. No
 * clone, no remote, and no private repository is involved, so a trend run in CI
 * measures the same work on every run and on every contributor's machine.
 */

export const FIXTURE_SIZES = {
  files: 100_000,
  refs: 3_000,
  commits: 5_000,
  pullRequestFiles: 5_000,
}

function git(cwd, args, input) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 1024 * 1024 * 256,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** A working tree of `FIXTURE_SIZES.files` untracked files, for status cost. */
export function buildWorkingTree(root) {
  const repo = join(root, 'working-tree')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  mkdirSync(join(repo, 'src', 'generated'), { recursive: true })
  for (let start = 0; start < FIXTURE_SIZES.files; start += 5_000) {
    const end = Math.min(start + 5_000, FIXTURE_SIZES.files)
    const script = []
    for (let index = start; index < end; index += 1) {
      script.push(`printf 'export const id = 1\\n' > src/generated/module-${index}.ts`)
    }
    execFileSync('sh', [], { cwd: repo, input: `${script.join('\n')}\n` })
  }
  return repo
}

/** Thousands of refs with distinct tips for real parent probes. */
export function buildManyRefs(root) {
  const repo = join(root, 'many-refs')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Git Stacks benchmark'])
  git(repo, ['config', 'user.email', 'benchmark@example.invalid'])
  writeFileSync(join(repo, 'README.md'), 'benchmark fixture\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'Base'])
  const head = git(repo, ['rev-parse', 'HEAD']).trim()
  const commits = []
  for (let index = 0; index < FIXTURE_SIZES.refs; index += 1) {
    const message = `Branch ${index}\n`
    commits.push(
      `commit refs/heads/feature/branch-${index}\n` +
        `committer Benchmark <benchmark@example.invalid> ${1700000000 + index} +0000\n` +
        `data ${Buffer.byteLength(message)}\n${message}from ${head}\n`,
    )
  }
  // Distinct tips force real parent comparisons rather than same-tip shortcuts.
  // Fast-import avoids thousands of fixture-setup process startups.
  git(repo, ['fast-import', '--quiet'], commits.join('\n'))
  for (let index = 0; index < 450; index += 1) {
    git(repo, [
      'config',
      `branch.feature/branch-${index}.parent`,
      index === 0 ? 'main' : 'feature/branch-0',
    ])
  }
  return repo
}

/** A `FIXTURE_SIZES.commits` deep history, for history page cost. */
export function buildLongHistory(root) {
  const repo = join(root, 'long-history')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Git Stacks benchmark'])
  git(repo, ['config', 'user.email', 'benchmark@example.invalid'])
  // `fast-import` builds a linear history in one process without writing
  // quadratic blobs or invoking Git once per commit.
  const marks = []
  for (let index = 0; index < FIXTURE_SIZES.commits; index += 1) {
    const message = `commit ${index}\n`
    marks.push(
      `commit refs/heads/main\nmark :${index + 1}\n` +
        `author Benchmark <benchmark@example.invalid> ${1700000000 + index} +0000\n` +
        `committer Benchmark <benchmark@example.invalid> ${1700000000 + index} +0000\n` +
        `data ${Buffer.byteLength(message)}\n${message}`,
    )
  }
  git(repo, ['fast-import', '--quiet'], `${marks.join('\n')}\n`)
  git(repo, ['reset', '--hard', 'main'])
  return repo
}

/** One commit touching `FIXTURE_SIZES.pullRequestFiles` files, for diff cost. */
export function buildLargePullRequest(root) {
  const repo = join(root, 'large-pull-request')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Git Stacks benchmark'])
  git(repo, ['config', 'user.email', 'benchmark@example.invalid'])
  writeFileSync(join(repo, 'README.md'), 'benchmark fixture\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'Base'])
  const tree = []
  for (let index = 0; index < FIXTURE_SIZES.pullRequestFiles; index += 1) {
    tree.push(`src/pr/module-${index}.ts`)
  }
  const line = 'export const changed = true\n'
  for (let start = 0; start < tree.length; start += 2_000) {
    const slice = tree.slice(start, start + 2_000)
    execFileSync('sh', [], {
      cwd: repo,
      input: `mkdir -p src/pr\n${slice
        .map((file, offset) => `printf '${line}// ${start + offset}\\n' > '${file}'`)
        .join('\n')}\n`,
    })
  }
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', `Touch ${FIXTURE_SIZES.pullRequestFiles} files`])
  return repo
}

export function buildAll(root) {
  mkdirSync(root, { recursive: true })
  return {
    workingTree: buildWorkingTree(root),
    manyRefs: buildManyRefs(root),
    longHistory: buildLongHistory(root),
    largePullRequest: buildLargePullRequest(root),
  }
}
