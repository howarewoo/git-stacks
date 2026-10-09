import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const script = new URL('../scripts/update-flow-smoke.mjs', import.meta.url).href
const { assertHomeOutsideRepository } = (await import(script)) as {
  assertHomeOutsideRepository(home: string, env: NodeJS.ProcessEnv): void
}

test('the inherited-home guard rejects every repository context that exposes local configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'update-home-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const globalConfig = join(root, 'gitconfig')
  await writeFile(globalConfig, '')
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    return result.stdout.trim()
  }
  const ordinary = join(root, 'ordinary')
  await mkdir(ordinary)
  assert.doesNotThrow(() => assertHomeOutsideRepository(ordinary, env))

  for (const bare of [false, true]) {
    const repository = join(root, bare ? 'bare' : 'worktree')
    await mkdir(repository)
    git(repository, ['init', '--quiet', ...(bare ? ['--bare'] : [])])
    git(repository, ['config', '--local', 'credential.helper', 'fixture-helper'])
    const gitDirectory = bare ? repository : join(repository, '.git')
    const nested = join(gitDirectory, 'nested')
    await mkdir(nested)
    for (const home of [repository, gitDirectory, nested]) {
      assert.equal(git(home, ['config', '--get-all', 'credential.helper']), 'fixture-helper')
      assert.throws(() => assertHomeOutsideRepository(home, env), /inside a Git repository/u)
    }
  }
  assert.throws(
    () => assertHomeOutsideRepository(join(root, 'missing'), env),
    /could not establish/u,
  )
})
