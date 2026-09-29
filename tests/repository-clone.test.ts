import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runRealGit } from './fixtures/git-race-shim'
import {
  CloneError,
  cloneRepository,
  classifyCloneFailure,
  readGitEnvironment,
  sanitizeCredentialHelper,
} from '../src/main/clone-repository'
import { getSnapshot, resolveRepository } from '../src/main/git'
import { summarizeRepository } from '../src/main/github-repositories'

const STAGING = '.git-stacks-clone-'

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'git-stacks-clone-'))
}

/** A bare remote holding `commits` commits, so a clone of it is a real repository. */
async function bareRemote(root: string, name: string, commits = 1): Promise<string> {
  const remote = join(root, `${name}.git`)
  runRealGit(root, ['init', '--bare', '-b', 'main', remote])
  if (commits === 0) return remote
  const seed = join(root, `${name}-seed`)
  runRealGit(root, ['init', '-b', 'main', seed])
  runRealGit(seed, ['config', 'user.name', 'Clone fixture'])
  runRealGit(seed, ['config', 'user.email', 'clone-fixture@example.invalid'])
  for (let index = 1; index <= commits; index += 1) {
    await writeFile(join(seed, `file-${index}.txt`), `revision ${index}\n`)
    runRealGit(seed, ['add', '.'])
    runRealGit(seed, ['commit', '-m', `Seed ${index}`])
  }
  runRealGit(seed, ['remote', 'add', 'origin', remote])
  runRealGit(seed, ['push', 'origin', 'main'])
  return remote
}

async function stagingEntries(parent: string): Promise<string[]> {
  return (await readdir(parent)).filter((entry) => entry.startsWith(STAGING))
}

/**
 * Resolves once the stalled SSH command has announced itself. The clone is
 * cancelled on that signal rather than after a guessed delay, so the assertion
 * runs while Git is provably still transferring.
 */
function waitForFile(directory: string, name: string): Promise<void> {
  const present = stat(join(directory, name)).catch(() => null)
  const announced = Promise.withResolvers<void>()
  let watcher: ReturnType<typeof watch> | null = null
  // A stalled SSH command writes the marker only once Git has started the
  // clone, so the cancel lands while the transfer is provably still running.
  void present.then((found) => {
    if (found) {
      announced.resolve()
      return
    }
    watcher = watch(directory, (_event, filename) => {
      if (filename && !filename.includes(name)) return
      announced.resolve()
      watcher?.close()
    })
  })
  return announced.promise
}

test('clones a bare remote into a new folder and leaves no staging directory', async () => {
  const root = await temporary()
  try {
    const remote = await bareRemote(root, 'widgets')
    const parent = join(root, 'workspaces')
    await mkdir(parent)

    const outcome = await cloneRepository({
      url: remote,
      fullName: 'acme/widgets',
      parentDirectory: parent,
      directoryName: 'widgets',
      shallow: false,
    })

    assert.equal(outcome.path, await realpath(join(parent, 'widgets')))
    assert.equal(outcome.empty, false)
    assert.equal(runRealGit(outcome.path, ['rev-parse', '--verify', 'HEAD']).length, 40)
    assert.deepEqual(await stagingEntries(parent), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a shallow clone records a shallow history at the same destination', async () => {
  const root = await temporary()
  try {
    const remote = await bareRemote(root, 'shallow', 3)
    const parent = join(root, 'workspaces')
    await mkdir(parent)

    const outcome = await cloneRepository({
      url: pathToFileURL(remote).href,
      fullName: 'acme/shallow',
      parentDirectory: parent,
      directoryName: 'shallow',
      shallow: true,
    })

    assert.equal(outcome.empty, false)
    assert.equal(runRealGit(outcome.path, ['rev-list', '--count', 'HEAD']), '1')
    assert.equal((await stat(join(outcome.path, '.git', 'shallow'))).isFile(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty remote clones as an empty repository rather than a failure', async () => {
  const root = await temporary()
  try {
    const remote = await bareRemote(root, 'blank', 0)
    const parent = join(root, 'workspaces')
    await mkdir(parent)

    const outcome = await cloneRepository({
      url: remote,
      fullName: 'acme/blank',
      parentDirectory: parent,
      directoryName: 'blank',
      shallow: false,
    })

    assert.equal(outcome.empty, true)
    assert.equal(runRealGit(outcome.path, ['rev-parse', '--is-inside-work-tree']), 'true')
    assert.deepEqual(await stagingEntries(parent), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a destination that already holds files is refused and left byte-identical', async () => {
  const root = await temporary()
  try {
    const remote = await bareRemote(root, 'widgets')
    const parent = join(root, 'workspaces')
    await mkdir(parent)
    const occupied = join(parent, 'widgets')
    await mkdir(occupied)
    const existing = join(occupied, 'notes.txt')
    await writeFile(existing, 'someone else was here\n')
    const before = createHash('sha256')
      .update(await readFile(existing))
      .digest('hex')

    await assert.rejects(
      cloneRepository({
        url: remote,
        fullName: 'acme/widgets',
        parentDirectory: parent,
        directoryName: 'widgets',
        shallow: false,
      }),
      (error: unknown) => error instanceof CloneError && error.reason === 'destination-exists',
    )

    assert.equal(
      createHash('sha256')
        .update(await readFile(existing))
        .digest('hex'),
      before,
    )
    assert.deepEqual(await readdir(occupied), ['notes.txt'])
    assert.deepEqual(await stagingEntries(parent), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a cancelled clone removes its staging folder and creates no destination', async () => {
  const root = await temporary()
  try {
    const parent = join(root, 'workspaces')
    await mkdir(parent)
    // A stalled SSH command keeps the transfer running until the test cancels it.
    // The marker file is the signal that Git has already started the clone.
    const marker = join(root, 'ssh-started')
    const stall = join(root, 'stall-ssh.sh')
    await writeFile(stall, `#!/bin/sh\ntouch "${marker}"\nsleep 5\n`, 'utf8')
    await chmod(stall, 0o755)
    const previous = process.env.GIT_SSH_COMMAND
    process.env.GIT_SSH_COMMAND = stall

    try {
      const controller = new AbortController()
      const cloning = cloneRepository({
        url: 'git@localhost:acme/widgets.git',
        fullName: 'acme/widgets',
        parentDirectory: parent,
        directoryName: 'widgets',
        shallow: false,
        signal: controller.signal,
      })
      await Promise.race([waitForFile(root, basename(marker)), cloning.catch(() => undefined)])
      controller.abort()
      await assert.rejects(cloning, /cancelled/iu)
    } finally {
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previous
    }

    assert.deepEqual(await readdir(parent), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed clone names its refusal and removes its staging folder', async () => {
  const root = await temporary()
  try {
    const parent = join(root, 'workspaces')
    await mkdir(parent)

    await assert.rejects(
      cloneRepository({
        url: join(root, 'missing.git'),
        fullName: 'acme/missing',
        parentDirectory: parent,
        directoryName: 'missing',
        shallow: false,
      }),
      (error: unknown) => error instanceof CloneError && error.reason === 'not-found',
    )

    assert.deepEqual(await readdir(parent), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a destination outside an existing folder is refused before Git runs', async () => {
  const root = await temporary()
  try {
    await assert.rejects(
      cloneRepository({
        url: join(root, 'anything.git'),
        fullName: 'acme/widgets',
        parentDirectory: join(root, 'no-such-folder'),
        directoryName: 'widgets',
        shallow: false,
      }),
      (error: unknown) => error instanceof CloneError && error.reason === 'invalid-destination',
    )
    await assert.rejects(
      cloneRepository({
        url: join(root, 'anything.git'),
        fullName: 'acme/widgets',
        parentDirectory: root,
        directoryName: '../escape',
        shallow: false,
      }),
      /one folder name/iu,
    )
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Git refusals are named rather than left as stderr prose', () => {
  assert.equal(
    classifyCloneFailure("remote: Repository not found.\nfatal: repository 'x' not found").reason,
    'not-found',
  )
  assert.equal(
    classifyCloneFailure('fatal: Authentication failed for https://github.com/acme/widgets').reason,
    'authentication',
  )
  assert.equal(
    classifyCloneFailure(
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    ).reason,
    'ssh',
  )
  assert.equal(
    classifyCloneFailure('fatal: unable to access: SSL certificate problem').reason,
    'network',
  )
  assert.equal(classifyCloneFailure('fatal: early EOF').reason, 'failed')
  assert.equal(classifyCloneFailure('fatal: early EOF').message, 'fatal: early EOF')
})

test('discovery accepts only github.com clone URLs it can build a command from', () => {
  const base = {
    name: 'widgets',
    owner: { login: 'acme' },
    full_name: 'acme/widgets',
    permissions: { admin: false, push: true, pull: true },
    default_branch: 'main',
    size: 12,
    private: false,
  }
  const summary = summarizeRepository({
    ...base,
    html_url: 'https://github.com/acme/widgets',
    clone_url: 'https://github.com/acme/widgets.git',
    ssh_url: 'git@github.com:acme/widgets.git',
  })
  assert.equal(summary?.httpsUrl, 'https://github.com/acme/widgets.git')
  assert.equal(summary?.sshUrl, 'git@github.com:acme/widgets.git')
  assert.equal(summary?.canPush, true)
  assert.equal(summary?.empty, false)

  // A credential in the URL, or another host, must never reach a clone.
  assert.equal(
    summarizeRepository({
      ...base,
      clone_url: 'https://user:token@github.com/acme/widgets.git',
      html_url: 'https://github.com/acme/widgets',
      ssh_url: 'git@github.com:acme/widgets.git',
    })?.httpsUrl,
    'https://github.com/acme/widgets.git',
  )
  assert.equal(
    summarizeRepository({
      ...base,
      clone_url: 'https://github.example.invalid/acme/widgets.git',
      html_url: 'https://github.com/acme/widgets',
      ssh_url: 'git@github.com:acme/widgets.git',
    })?.httpsUrl,
    'https://github.com/acme/widgets.git',
  )
  // A repository the credential cannot act on is not a clone target.
  assert.equal(summarizeRepository({ ...base, permissions: null }), null)
  assert.equal(summarizeRepository({ ...base, name: '-bad-', full_name: 'acme/-bad-' }), null)
})

test('adding an existing repository reads it without rewriting a byte of its configuration', async () => {
  const root = await temporary()
  try {
    const remote = await bareRemote(root, 'widgets')
    const local = join(root, 'existing')
    runRealGit(root, ['clone', remote, local])
    runRealGit(local, ['config', 'user.name', 'Local Owner'])
    runRealGit(local, ['config', 'branch.main.gitStacksParent', 'origin/main'])
    await writeFile(join(local, 'untracked.txt'), 'left alone\n')
    const configFile = join(local, '.git', 'config')
    const before = createHash('sha256')
      .update(await readFile(configFile))
      .digest('hex')
    const configBefore = runRealGit(local, ['config', '--list', '--local'])
    const headBefore = runRealGit(local, ['rev-parse', 'HEAD'])

    // Exactly what adding an existing repository runs before registering it.
    const path = await resolveRepository(local)
    const snapshot = await getSnapshot(path)

    assert.equal(snapshot.path, await realpath(local))
    assert.equal(
      createHash('sha256')
        .update(await readFile(configFile))
        .digest('hex'),
      before,
    )
    assert.equal(runRealGit(local, ['config', '--list', '--local']), configBefore)
    assert.equal(runRealGit(local, ['rev-parse', 'HEAD']), headBefore)
    assert.deepEqual((await readdir(local)).sort(), ['.git', 'file-1.txt', 'untracked.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a concurrent empty destination folder created after clone begins is preserved and refused as a collision', async () => {
  const root = await temporary()
  try {
    const remote = await bareRemote(root, 'concurrent-target')
    const parent = join(root, 'workspaces')
    await mkdir(parent)
    const destination = join(parent, 'target')

    const started = join(root, 'started')
    const proceed = join(root, 'proceed')
    const wrapper = join(root, 'hook.sh')
    await writeFile(
      wrapper,
      `#!/bin/sh\ntouch "${started}"\nwhile [ ! -f "${proceed}" ]; do sleep 0.02; done\neval "$2"\n`,
      { mode: 0o755 },
    )

    const previous = process.env.GIT_SSH_COMMAND
    process.env.GIT_SSH_COMMAND = wrapper

    try {
      const cloning = cloneRepository({
        url: `git@localhost:${remote}`,
        fullName: 'acme/target',
        parentDirectory: parent,
        directoryName: 'target',
        shallow: false,
      })

      await waitForFile(root, basename(started))
      // While Git clone is running, create the empty destination directory concurrently
      await mkdir(destination)

      // Let Git clone finish in staging
      await writeFile(proceed, 'ok\n')

      await assert.rejects(
        cloning,
        (error: unknown) => error instanceof CloneError && error.reason === 'destination-exists',
      )

      // The concurrently created empty destination was NOT overwritten, deleted, or clobbered
      assert.deepEqual(await readdir(destination), [])
      // The staging folder was discarded
      assert.deepEqual(await stagingEntries(parent), [])
    } finally {
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previous
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelling after the git process completes but before promotion leaves no destination and cleans only own staging', async () => {
  const root = await temporary()
  try {
    const remote = await bareRemote(root, 'cancel-postprocess')
    const parent = join(root, 'workspaces')
    await mkdir(parent)
    const destination = join(parent, 'postprocess')

    const done = join(root, 'git-done')
    const proceed = join(root, 'proceed-done')
    const wrapper = join(root, 'hook-done.sh')
    await writeFile(
      wrapper,
      `#!/bin/sh\neval "$2"\ntouch "${done}"\nwhile [ ! -f "${proceed}" ]; do sleep 0.02; done\n`,
      { mode: 0o755 },
    )

    const previous = process.env.GIT_SSH_COMMAND
    process.env.GIT_SSH_COMMAND = wrapper

    try {
      const controller = new AbortController()
      const cloning = cloneRepository({
        url: `git@localhost:${remote}`,
        fullName: 'acme/postprocess',
        parentDirectory: parent,
        directoryName: 'postprocess',
        shallow: false,
        signal: controller.signal,
      })

      // Wait until the git transfer has finished in staging
      await waitForFile(root, basename(done))
      // Abort before promotion occurs
      controller.abort()
      await writeFile(proceed, 'ok\n')

      await assert.rejects(cloning, /cancelled/iu)
      // Staging was cleaned up
      assert.deepEqual(await stagingEntries(parent), [])
      // Destination was never created
      assert.equal(await stat(destination).catch(() => null), null)
    } finally {
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previous
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readGitEnvironment redacts secret tokens, shell commands, and absolute paths in credential.helper', async () => {
  const root = await temporary()
  try {
    const sentinelToken = 'ghp_SUPER_SECRET_SENTINEL_TOKEN_12345'
    const sentinelPath = join(root, 'custom-credential-helper')
    const configContent = `[credential]\n\thelper = !${sentinelPath} --token=${sentinelToken}\n`
    const configFile = join(root, 'sentinel.gitconfig')
    await writeFile(configFile, configContent, 'utf8')

    const beforeHash = createHash('sha256').update(await readFile(configFile)).digest('hex')

    const prevGlobal = process.env.GIT_CONFIG_GLOBAL
    const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = configFile
    process.env.GIT_CONFIG_NOSYSTEM = '1'

    try {
      const env = await readGitEnvironment()
      assert.equal(env.httpsCredentials.configured, true)
      // Sanitized status must be a safe allowlisted name or 'custom'
      assert.equal(env.httpsCredentials.helper, 'custom')

      const serialized = JSON.stringify(env)
      // Neither the sentinel token nor the sensitive path must appear anywhere in returned data
      assert.equal(serialized.includes(sentinelToken), false)
      assert.equal(serialized.includes(sentinelPath), false)
      assert.equal(serialized.includes('custom-credential-helper'), false)

      // The git configuration file itself remains completely unchanged (read-only)
      const afterHash = createHash('sha256').update(await readFile(configFile)).digest('hex')
      assert.equal(afterHash, beforeHash)
      assert.equal(await readFile(configFile, 'utf8'), configContent)
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal
      if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
      else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sanitizeCredentialHelper projects known helpers and redacts custom commands/paths', () => {
  assert.equal(sanitizeCredentialHelper(null), null)
  assert.equal(sanitizeCredentialHelper(''), null)
  assert.equal(sanitizeCredentialHelper('   '), null)
  assert.equal(sanitizeCredentialHelper('osxkeychain'), 'osxkeychain')
  assert.equal(sanitizeCredentialHelper('manager'), 'manager')
  assert.equal(sanitizeCredentialHelper('manager-core'), 'manager-core')
  assert.equal(sanitizeCredentialHelper('libsecret'), 'libsecret')
  assert.equal(sanitizeCredentialHelper('cache'), 'cache')
  assert.equal(sanitizeCredentialHelper('store'), 'store')
  assert.equal(sanitizeCredentialHelper('wincred'), 'wincred')
  // Path to known helper without arguments resolves to safe name
  assert.equal(sanitizeCredentialHelper('/usr/local/bin/git-credential-osxkeychain'), 'osxkeychain')
  assert.equal(sanitizeCredentialHelper('/opt/homebrew/bin/git-credential-manager'), 'manager')
  // Known helper with flags or tokens resolves to safe name without exposing flags
  assert.equal(sanitizeCredentialHelper('cache --timeout=3600'), 'cache')
  // Shell snippets, commands with secrets, or unknown binaries project to 'custom'
  assert.equal(
    sanitizeCredentialHelper('!f() { echo password=SECRET_TOKEN; }; f'),
    'custom',
  )
  assert.equal(
    sanitizeCredentialHelper('/usr/bin/custom-helper --secret=XYZ'),
    'custom',
  )
  assert.equal(sanitizeCredentialHelper('unknown-binary'), 'custom')
})
