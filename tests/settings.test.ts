import assert from 'node:assert/strict'
import { githubHostContext } from '../src/main/github-host'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { CredentialVault, type SecretProtector } from '../src/main/credentials'
import { retirePrimaryGitHubRecord } from '../src/main/github-primary-record'
import test from 'node:test'
import {
  applyPatch,
  readSettingsFile,
  readSettingsSnapshot,
  resetSettings,
  settingsPatchToWrite,
  resetTarget,
  SETTING_KEYS,
  updateSettings,
  validateSettings,
  writeSettingsFile,
} from '../src/main/settings'
import { UpdateService } from '../src/main/update/service'
import { loadSettingsPolicy, NO_POLICY } from '../src/main/settings-service'
import { buildBundle, renderBundle, writeOwnerOnlyBundle } from '../src/main/support-bundle'
import { recordFailure, recordedFailures } from '../src/main/failure-log'
import {
  locateTool,
  resolveEditorCommand,
  resolveEditorInvocation,
  resolveInsideRepository,
} from '../src/main/editor'
import {
  parseGitBuildOptions,
  parseGitVersion,
  readGitHubCliSources,
  runDiagnostics,
  type DiagnosticSources,
} from '../src/main/diagnostics'
import { parseGhVersion, readGitHubCli } from '../src/main/github-cli'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import type { AppSettings, DiagnosticReport } from '../src/shared/settings'
import { admitOwnedProviderCliRoot } from './fixtures/owned-provider-cli'

async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'git-stacks-settings-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const NO_LOCKS: never[] = []

test('a settings file that is not JSON falls back to defaults and says it recovered', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{ this is not json')
    const { settings, issues, recovered } = await readSettingsFile(file)
    assert.equal(recovered, true)
    assert.deepEqual(settings, DEFAULT_SETTINGS)
    assert.match(issues[0].message, /not valid JSON/)
  })
})

test('a settings file that is valid JSON but not an object recovers to defaults', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '["a", "list", "is", "not", "settings"]')
    const { settings, recovered } = await readSettingsFile(file)
    assert.equal(recovered, true)
    assert.deepEqual(settings, DEFAULT_SETTINGS)
  })
})

test('one corrupt field is refused while the rest of the file still applies', () => {
  const { settings, issues } = validateSettings({
    git: {
      useSystemGit: 'yes please',
      editor: 'code',
      fetchIntervalSeconds: 45,
      // A tool name carrying a path or a space could become more than one
      // argument once it reaches a process launcher, so it is refused.
      mergeTool: 'my tool --flag',
    },
    appearance: { theme: 'solarized' },
  })
  assert.equal(settings.git.useSystemGit, DEFAULT_SETTINGS.git.useSystemGit)
  assert.equal(settings.git.editor, 'code', 'a valid sibling field still applies')
  assert.equal(settings.git.fetchIntervalSeconds, 45)
  assert.equal(settings.git.mergeTool, null)
  assert.equal(settings.appearance.theme, 'system')
  const keys = issues.map((issue) => issue.key).sort()
  assert.deepEqual(keys, ['appearance.theme', 'git.mergeTool', 'git.useSystemGit'])
})

test('a refused edit keeps the value that was working', () => {
  const current = { ...DEFAULT_SETTINGS, git: { ...DEFAULT_SETTINGS.git, editor: 'code' } }
  const { settings, issues } = applyPatch(current, { git: { editor: 'my tool --flag' } })
  assert.equal(settings.git.editor, 'code', 'the working editor survives a rejected edit')
  assert.deepEqual(
    issues.map((issue) => issue.key),
    ['git.editor'],
    'the rejected edit is still reported',
  )
})

test('a refused edit does not disturb the fields it did not name', () => {
  const current = {
    ...DEFAULT_SETTINGS,
    git: { ...DEFAULT_SETTINGS.git, editor: 'code', fetchIntervalSeconds: 45 },
  }
  const { settings } = applyPatch(current, { git: { editor: 'code with space' } })
  assert.equal(settings.git.editor, 'code')
  assert.equal(settings.git.fetchIntervalSeconds, 45)
})

test('a rejected theme is restored without touching its siblings', () => {
  const current = {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'dark' as const },
    git: { ...DEFAULT_SETTINGS.git, editor: 'code' },
  }
  const { settings, issues } = applyPatch(current, { appearance: { theme: 'nonsense' as never } })
  assert.equal(settings.appearance.theme, 'dark', 'the theme in use survives a rejected edit')
  assert.equal(settings.git.editor, 'code', 'a sibling field is untouched')
  assert.deepEqual(
    issues.map((issue) => issue.key),
    ['appearance.theme'],
  )
})

test('an absent field is not reported as corrupt, so a sparse file is not all noise', () => {
  const { issues, settings } = validateSettings({ git: { editor: 'code' } })
  assert.deepEqual(issues, [])
  assert.equal(settings.git.editor, 'code')
  assert.equal(settings.git.mergeTool, DEFAULT_SETTINGS.git.mergeTool)
})

test('a stored shortcut chord that no action can dispatch falls back to the default', () => {
  const { settings } = validateSettings({
    shortcuts: { 'view.branches': 'Home', 'view.stacks': 'home' },
  })
  assert.equal(settings.shortcuts['view.branches'], 'Home')
  assert.equal(
    settings.shortcuts['view.stacks'],
    DEFAULT_SETTINGS.shortcuts['view.stacks'],
    'two actions on one chord settles to a single owner',
  )
})

test('a patch keeps the fields it does not mention', () => {
  const current: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    git: { ...DEFAULT_SETTINGS.git, editor: 'code', fetchIntervalSeconds: 300 },
  }
  const { settings, issues } = applyPatch(current, { appearance: { theme: 'dark' } })
  assert.deepEqual(issues, [])
  assert.equal(settings.appearance.theme, 'dark')
  assert.equal(settings.git.editor, 'code')
  assert.equal(settings.git.fetchIntervalSeconds, 300)
})

test('a setting the policy locks is refused and the file is left exactly as it was', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await updateSettings(file, { git: { editor: 'code' } }, NO_LOCKS)
    const before = await readFile(file, 'utf8')

    await assert.rejects(
      updateSettings(file, { git: { editor: 'vim' } }, [
        { key: 'git.editor', reason: 'Set by the administrator of this computer' },
      ]),
      /git\.editor is fixed by the settings policy/,
    )
    assert.equal(await readFile(file, 'utf8'), before, 'a refused change writes nothing')
  })
})

test('re-saving a locked value is allowed, so an unrelated edit is not blocked', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    // The administrator's value is in place before the lock is applied.
    await updateSettings(file, { git: { editor: 'code' } }, NO_LOCKS)
    const locks = [{ key: 'git.editor', reason: 'Fixed by policy' }]
    // The patch sets the value the lock already fixed, so nothing changes.
    const snapshot = await updateSettings(file, { git: { editor: 'code' } }, locks)
    assert.equal(snapshot.settings.git.editor, 'code')
    // Changing it is still refused.
    await assert.rejects(updateSettings(file, { git: { editor: 'vim' } }, locks), /git\.editor/)
  })
})

test('a policy that cannot be read locks every managed setting instead of none', async () => {
  const policy = await loadSettingsPolicy('/nonexistent/settings-policy.json')
  assert.equal(policy.blocked, true)
  assert.match(policy.error ?? '', /could not be read/)
  const lockedKeys = policy.locks.map((lock) => lock.key).sort()
  assert.deepEqual(lockedKeys, [
    'appearance.reduceMotion',
    'appearance.theme',
    'git.defaultMergeMethod',
    'git.defaultPullStrategy',
    'git.editor',
    'git.fetchIntervalSeconds',
    'git.mergeTool',
    'git.useSystemGit',
    'github.host',
    'notifications.enabled',
    'privacy.includeLocalPaths',
    'shortcuts',
    'updates.channel',
  ])
})

test('a policy that is not JSON locks everything rather than quietly unlocking it', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'policy.json')
    await writeFile(file, 'locks: {')
    const policy = await loadSettingsPolicy(file)
    assert.equal(policy.blocked, true)
    // Every managed key is locked, so the count is the key list rather than a
    // number this test would have to be edited for on every new setting.
    assert.equal(policy.locks.length, SETTING_KEYS.length)
    assert.deepEqual(policy.locks.map((lock) => lock.key).sort(), [...SETTING_KEYS].sort())
  })
})

test('a policy naming a key this build does not know is held closed, not applied in part', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'policy.json')
    await writeFile(
      file,
      JSON.stringify({ locks: { 'git.editor': 'Fixed', 'git.telepathy': 'Nope' } }),
    )
    const policy = await loadSettingsPolicy(file)
    assert.equal(policy.blocked, true)
    // Every managed key is locked, so the count is the key list rather than a
    // number this test would have to be edited for on every new setting.
    assert.equal(policy.locks.length, SETTING_KEYS.length)
    assert.deepEqual(policy.locks.map((lock) => lock.key).sort(), [...SETTING_KEYS].sort())
  })
})

test('no policy file at all locks nothing', () => {
  assert.equal(NO_POLICY.blocked, false)
  assert.deepEqual(NO_POLICY.locks, [])
})

test('a valid policy locks only the keys it names, with the reason it gave', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'policy.json')
    await writeFile(
      file,
      JSON.stringify({ locks: { 'git.useSystemGit': 'Managed machines use system Git' } }),
    )
    const policy = await loadSettingsPolicy(file)
    assert.equal(policy.blocked, false)
    assert.deepEqual(policy.locks, [
      { key: 'git.useSystemGit', reason: 'Managed machines use system Git' },
    ])
  })
})

test('a snapshot reports the locks and issues it read', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ appearance: { theme: 'neon' } }))
    const snapshot = await readSettingsSnapshot(file, [
      { key: 'git.editor', reason: 'Fixed by policy' },
    ])
    assert.deepEqual(snapshot.locks, [{ key: 'git.editor', reason: 'Fixed by policy' }])
    assert.equal(snapshot.issues[0].key, 'appearance.theme')
    assert.equal(snapshot.file, file)
  })
})

test('a tool name is written back only once it has passed validation', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await updateSettings(file, { git: { editor: '  code  ' } }, NO_LOCKS)
    const { settings } = await readSettingsFile(file)
    assert.equal(settings.git.editor, 'code', 'surrounding space is trimmed')
  })
})

test('resetting settings restores defaults and leaves every repository untouched', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await updateSettings(
      file,
      { git: { editor: 'code', mergeTool: 'meld' }, appearance: { theme: 'dark' } },
      NO_LOCKS,
    )

    // A real repository next to the settings file, with state a careless reset
    // would disturb: a dirty worktree, a staged change, and a real ref.
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
    await writeFile(join(repo, 'tracked.txt'), 'first\n')
    await writeFile(join(repo, 'other.txt'), 'second\n')
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'first'])
    await writeFile(join(repo, 'tracked.txt'), 'edited\n')
    await writeFile(join(repo, 'untracked.txt'), 'loose\n')
    execFileSync('git', ['-C', repo, 'add', 'untracked.txt'])

    const statusBefore = execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
      encoding: 'utf8',
    })
    const headBefore = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const configBefore = execFileSync('git', ['-C', repo, 'config', '--list'], {
      encoding: 'utf8',
    })
    const trackedContent = await readFile(join(repo, 'tracked.txt'), 'utf8')

    const snapshot = await resetSettings(file, NO_LOCKS)

    assert.deepEqual(snapshot.settings, DEFAULT_SETTINGS)
    assert.equal(
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }),
      statusBefore,
      'the worktree and index are byte-identical after a reset',
    )
    assert.equal(
      execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      headBefore,
      'no ref moved',
    )
    assert.equal(
      execFileSync('git', ['-C', repo, 'config', '--list'], { encoding: 'utf8' }),
      configBefore,
      'no repository configuration was written',
    )
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), trackedContent)
  })
})

test('a reset keeps a channel the policy fixed, in the file and in the running updater', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const policyFile = join(dir, 'policy.json')
    await writeFile(policyFile, JSON.stringify({ locks: { 'updates.channel': 'beta' } }))
    const policy = await loadSettingsPolicy(policyFile)
    assert.equal(policy.blocked, false)
    // The administrator's channel is what this machine is on before the reset,
    // alongside a preference of the person's own that the reset does undo.
    await updateSettings(
      file,
      { updates: { channel: 'beta' }, appearance: { theme: 'dark' } },
      NO_LOCKS,
    )
    assert.equal((await readSettingsSnapshot(file, policy.locks)).settings.updates.channel, 'beta')

    // The app this reset arrives in is following beta, exactly as it was before.
    const updater = new UpdateService({
      packaged: false,
      currentVersion: '0.1.0',
      appPath: join(dir, 'Git Stacks.exe'),
      userDataPath: dir,
      platform: 'win32',
      arch: 'arm64',
      relaunch: () => undefined,
    })
    await updater.start('beta')
    assert.equal(updater.status().channel, 'beta')

    let committed = 0
    // The channel the reset lands on is resolved from the file it is about to
    // rewrite, inside the updater's own boundary, and the reset is written
    // there. The two answers are one answer, and a policy that fixed the
    // channel is not a way to reset it.
    await updater.applyResolvedChannel(
      async () =>
        resetTarget((await readSettingsFile(file)).settings, policy.locks).updates.channel,
      async () => {
        await resetSettings(file, policy.locks)
        committed += 1
      },
    )
    assert.equal(committed, 1, 'the reset inside the boundary went through')
    // What was written: the fixed channel kept, the person's own preference gone.
    const stored = (await readSettingsSnapshot(file, policy.locks)).settings
    assert.equal(stored.updates.channel, 'beta', 'the channel the policy fixed survived the reset')
    assert.equal(
      stored.appearance.theme,
      DEFAULT_SETTINGS.appearance.theme,
      'a setting the policy says nothing about is still reset',
    )
    // And what this process follows, which is the channel a check will fetch.
    assert.equal(
      updater.status().channel,
      'beta',
      'the running updater did not fall back to the default channel',
    )
  })
})

const REPORT: DiagnosticReport = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  appVersion: '0.1.0',
  entries: [
    {
      source: 'host',
      label: 'Operating system',
      value: 'darwin 24.0 (arm64)',
      status: 'confirmed',
    },
    {
      source: 'runtime',
      label: 'Git executable',
      value: '/opt/tools/git/bin/git',
      status: 'confirmed',
      locational: true,
    },
    { source: 'runtime', label: 'Git version', value: 'git version 2.44.0', status: 'confirmed' },
  ],
}

test('a support bundle withholds a local path until the user opts in', () => {
  const withheld = buildBundle(REPORT, DEFAULT_SETTINGS, [])
  const body = renderBundle(withheld, false)
  assert.equal(body.includes('/opt/tools/git/bin/git'), false)
  assert.match(body, /withheld/)

  const opted = buildBundle(
    REPORT,
    { ...structuredClone(DEFAULT_SETTINGS), privacy: { includeLocalPaths: true } },
    [],
  )
  assert.equal(renderBundle(opted, true).includes('/opt/tools/git/bin/git'), true)
})

test('a support bundle carries no secret even when one reaches a field value', () => {
  // A credential reference is never placed in a report field by the main
  // process, so this asserts the bundle never assembles one from its inputs.
  const preview = buildBundle(REPORT, DEFAULT_SETTINGS, ['auth: signed in as octocat'])
  const body = renderBundle(preview, false)
  assert.equal(body.includes('ghp_'), false)
  assert.equal(body.includes('github_pat_'), false)
  assert.equal(body.includes('BEGIN'), false)
})

test('a support bundle states the exclusions it guarantees', () => {
  const body = renderBundle(buildBundle(REPORT, DEFAULT_SETTINGS, []), false)
  for (const promise of ['access tokens', 'source contents', 'diffs', 'raw GitHub']) {
    assert.match(body, new RegExp(promise, 'i'), `the bundle promises to exclude ${promise}`)
  }
})

test('a support bundle names a section it left out and why', () => {
  const preview = buildBundle(REPORT, DEFAULT_SETTINGS, [])
  const failures = preview.sections.find((section) => section.id === 'failures')
  assert.equal(failures?.included, false)
  assert.equal(failures?.content, '')
  assert.equal(renderBundle(preview, false).includes('## Recent failures'), false)
})

test('a configured editor is resolved without a shell and refuses a path outside the repository', async () => {
  assert.equal(resolveEditorCommand('code').command, 'code')
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'inside.txt'), 'x')
    const found = await resolveInsideRepository(dir, 'inside.txt')
    assert.equal('absolute' in found, true)

    const absolute = await resolveInsideRepository(dir, join(dir, 'inside.txt'))
    assert.match('error' in absolute ? absolute.error : '', /must be relative/)

    const climbing = await resolveInsideRepository(dir, '../escape.txt')
    assert.match('error' in climbing ? climbing.error : '', /outside the repository/)

    const missing = await resolveInsideRepository(dir, 'gone.txt')
    assert.match('error' in missing ? missing.error : '', /no longer exists/)
  })
})

test('a tool that is not installed is reported as missing rather than assumed present', async () => {
  const missing = await locateTool('definitely-not-installed-xyz', null)
  assert.equal(missing.available, false)
  assert.equal(missing.label, 'definitely-not-installed-xyz')

  const unset = await locateTool(null, null)
  assert.equal(unset.label, 'none configured')

  // Whatever the host is, one of the two must be a real answer.
  const either = await locateTool(null, 'sh')
  assert.equal(either.available, true)
})

test('the settings file is written with owner-only permissions', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'nested', 'settings.json')
    await writeSettingsFile(file, DEFAULT_SETTINGS)
    const mode = (await stat(file)).mode & 0o777
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600, 'the settings file is not world-readable')
    }
  })
})
test('sentinel secrets and paths are redacted from failures and diagnostic bundle', () => {
  const secretFailures = [
    'failed while using token ghp_1234567890abcdef1234567890 for https://github.com/repo',
    'fatal: password=supersecretpass in remote helper response',
    'error in /Users/victim/secrets/private_key.pem: bearer secret-token-value-xyz',
  ]
  const preview = buildBundle(REPORT, DEFAULT_SETTINGS, secretFailures)
  const body = renderBundle(preview, false)
  assert.equal(body.includes('ghp_1234567890abcdef1234567890'), false)
  assert.equal(body.includes('supersecretpass'), false)
  assert.equal(body.includes('/Users/victim'), false)
  assert.match(body, /REDACTED_SECRET/)
  assert.match(body, /withheld: path/)
})

test('handled failures export only the channel and known category regardless of path consent', () => {
  const before = recordedFailures().length
  const branch = 'private-feature-branch'
  const path = '/worktrees/confidential-repository'
  const token = 'ghp_1234567890abcdef1234567890'
  const error = new Error(`Branch "${branch}" is checked out in another worktree: ${path} ${token}`)
  error.name = `private error for ${branch}`
  recordFailure('repository:action', error)
  recordFailure('repository:action', new TypeError(`Parent branch "${branch}" does not exist`))

  const failures = recordedFailures().slice(before)
  assert.equal(failures.length, 2)
  for (const consent of [false, true]) {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      privacy: { includeLocalPaths: consent },
    }
    const body = renderBundle(buildBundle(REPORT, settings, failures), consent)
    assert.match(body, /repository:action: operation failed/)
    assert.match(body, /repository:action: type error/)
    for (const privateValue of [branch, path, token, error.name]) {
      assert.equal(body.includes(privateValue), false)
    }
  }
})

test('unsupported editor and merge tool programs like shell or arbitrary interpreters are refused', () => {
  const editorRefusal = validateSettings({ git: { editor: 'sh' } })
  assert.equal(editorRefusal.settings.git.editor, null)
  assert.match(editorRefusal.issues[0]?.message ?? '', /must be a supported editor/)

  const mergeToolRefusal = validateSettings({ git: { mergeTool: 'python3' } })
  assert.equal(mergeToolRefusal.settings.git.mergeTool, null)
  assert.match(mergeToolRefusal.issues[0]?.message ?? '', /must be a supported merge tool/)

  assert.equal(resolveEditorCommand('sh').command, null)
  assert.match(resolveEditorCommand('sh').reason, /not a supported editor/)
})

test('symlinks pointing outside the repository root are refused by editor containment', async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, 'repo')
    const outsideDir = join(dir, 'outside')
    await mkdir(repoDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    const target = join(outsideDir, 'secret.txt')
    await writeFile(target, 'secret')
    const link = join(repoDir, 'symlink-outside.txt')
    await symlink(target, link)

    const result = await resolveInsideRepository(repoDir, 'symlink-outside.txt')
    assert.equal('error' in result, true)
    assert.match('error' in result ? result.error : '', /outside the repository/)
  })
})

test('explicit undefined properties in patches cannot bypass locked settings', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await writeSettingsFile(file, {
      ...structuredClone(DEFAULT_SETTINGS),
      git: { ...structuredClone(DEFAULT_SETTINGS.git), editor: 'code' },
    })
    const locks = [{ key: 'git.editor', reason: 'Fixed by policy' }]
    await assert.rejects(
      updateSettings(file, { git: { editor: undefined as unknown as string } }, locks),
      /git\.editor is fixed by the settings policy/,
    )
  })
})

test('a configured policy file containing JSON null fails closed and locks all keys', async () => {
  await withTempDir(async (dir) => {
    const policyFile = join(dir, 'policy.json')
    await writeFile(policyFile, 'null')
    const loaded = await loadSettingsPolicy(policyFile)
    assert.equal(loaded.blocked, true)
    assert.equal(loaded.locks.length > 0, true)
    assert.match(loaded.error ?? '', /must be an object/)
  })
})

test('concurrent settings writes do not collide on temporary files and preserve opt-outs', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    await writeSettingsFile(file, DEFAULT_SETTINGS)
    await Promise.all([
      updateSettings(file, { appearance: { theme: 'dark' } }, NO_LOCKS),
      updateSettings(file, { privacy: { includeLocalPaths: false } }, NO_LOCKS),
      updateSettings(file, { git: { defaultPullStrategy: 'rebase' } }, NO_LOCKS),
    ])
    const { settings } = await readSettingsFile(file)
    assert.equal(settings.privacy.includeLocalPaths, false)
    assert.ok(['dark', 'system'].includes(settings.appearance.theme))
  })
})

test('revoked path consent withholds local paths even if preview was generated with consent', () => {
  const preview = buildBundle(
    REPORT,
    { ...structuredClone(DEFAULT_SETTINGS), privacy: { includeLocalPaths: true } },
    [],
  )
  const liveSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    privacy: { includeLocalPaths: false },
  }
  const exportedBody = renderBundle(preview, liveSettings.privacy.includeLocalPaths)
  assert.equal(exportedBody.includes('/opt/tools/git/bin/git'), false)
  assert.match(exportedBody, /local paths: withheld/)
})

test('a preview generated with paths withheld never retains raw paths in fields and cannot be expanded to leak paths', () => {
  const preview = buildBundle(
    REPORT,
    { ...structuredClone(DEFAULT_SETTINGS), privacy: { includeLocalPaths: false } },
    [],
  )
  assert.equal(preview.pathCount, 0)
  assert.equal(preview.consent, false)
  const rendered = renderBundle(preview, true)
  assert.equal(rendered.includes('/opt/tools/git/bin/git'), false)
})

test('default text editor uses platform safe text editor invocation and never executes scripts', () => {
  const target = '/path/to/repo/run.command'
  const resolved = resolveEditorInvocation(null, target)
  assert.ok(resolved.invocation !== null)
  if (process.platform === 'darwin') {
    assert.equal(resolved.invocation.command, 'open')
    assert.deepEqual(resolved.invocation.args, ['-t', target])
  } else if (process.platform === 'win32') {
    assert.equal(resolved.invocation.command, 'notepad')
    assert.deepEqual(resolved.invocation.args, [target])
  }
})

test('Git version probe parses strictly semantic version and strips build paths or arbitrary stdout', () => {
  const dirtyOutput = 'git version 2.45.0 build=/Volumes/company/private-build (custom wrapper)\n'
  const parsed = parseGitVersion(dirtyOutput)
  assert.equal(parsed.value, 'git version 2.45.0')
  assert.equal(parsed.status, 'confirmed')
  assert.equal(parsed.value.includes('/Volumes'), false)

  const buildOutput = 'sizeof-long: 8\nshell-path: /private/bin/sh\nfsmonitor\npthreads\n'
  const parsedBuild = parseGitBuildOptions(buildOutput)
  assert.equal(parsedBuild.value, 'fsmonitor, pthreads')
  assert.equal(parsedBuild.status, 'confirmed')
  assert.equal(parsedBuild.value.includes('/private'), false)
  assert.equal(parsedBuild.value.includes('shell-path'), false)
})

test('a legacy shortcut import lands on an untouched file and is then refused', () => {
  const legacy = { ...DEFAULT_SETTINGS.shortcuts, 'stack.selectChild': 's' }

  const imported = applyPatch(DEFAULT_SETTINGS, { legacyShortcutImport: legacy })
  assert.equal(imported.settings.shortcuts['stack.selectChild'], 's')
  assert.equal(imported.settings.migrated.legacyShortcutStorage, true)

  // The same import arriving a second time, or after the user has moved on, is
  // refused against the state main reads when the write happens.
  const again = applyPatch(imported.settings, { legacyShortcutImport: legacy })
  assert.equal(again.settings.shortcuts['stack.selectChild'], 's')

  const edited: AppSettings = {
    ...DEFAULT_SETTINGS,
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts, 'stack.selectChild': 'b' },
  }
  const afterEdit = applyPatch(edited, { legacyShortcutImport: legacy })
  assert.equal(afterEdit.settings.shortcuts['stack.selectChild'], 'b')
  assert.equal(afterEdit.settings.migrated.legacyShortcutStorage, false)
})

test('a pending legacy import cannot restore old bindings over a reset or an edit', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const legacy = { ...DEFAULT_SETTINGS.shortcuts, 'stack.selectChild': 's' }

    // Nothing has been written this session and the file is untouched, so the
    // import is the change the window asked for.
    const allowed = await settingsPatchToWrite(file, { legacyShortcutImport: legacy }, 0)
    assert.deepEqual(allowed, { legacyShortcutImport: legacy })

    // The user resets while the import is still in flight. The reset restores
    // exactly the defaults the import is qualified against, so the write count
    // is the only thing that separates the two.
    await resetSettings(file, NO_LOCKS)
    const afterReset = await updateSettings(
      file,
      await settingsPatchToWrite(file, { legacyShortcutImport: legacy }, 1),
      NO_LOCKS,
    )
    assert.equal(
      afterReset.settings.shortcuts['stack.selectChild'],
      DEFAULT_SETTINGS.shortcuts['stack.selectChild'],
    )
    assert.equal(afterReset.settings.migrated.legacyShortcutStorage, false)

    // A shortcut edited before the import reached the file is left alone too.
    await updateSettings(
      file,
      { shortcuts: { ...DEFAULT_SETTINGS.shortcuts, 'stack.selectChild': 'b' } },
      NO_LOCKS,
    )
    const afterEdit = await updateSettings(
      file,
      await settingsPatchToWrite(file, { legacyShortcutImport: legacy }, 2),
      NO_LOCKS,
    )
    assert.equal(afterEdit.settings.shortcuts['stack.selectChild'], 'b')
    assert.equal(afterEdit.settings.migrated.legacyShortcutStorage, false)
  })
})

test('the advertised notepad++ editor is accepted and persisted', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const snapshot = await updateSettings(file, { git: { editor: 'notepad++' } }, NO_LOCKS)
    assert.equal(snapshot.settings.git.editor, 'notepad++')
    assert.equal(snapshot.issues.length, 0)
  })
})

test('terminal editors like vim and nano are rejected by the GUI editor allowlist', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const snapshot = await updateSettings(file, { git: { editor: 'nano' } }, NO_LOCKS)
    assert.equal(snapshot.settings.git.editor, null)
    assert.ok(snapshot.issues.some((issue) => issue.key === 'git.editor'))
  })
})

test('an exported bundle is owner-only even when it replaces a world-readable file', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'git-stacks-support.txt')
    await writeFile(file, 'an earlier export anybody could read\n')
    await chmod(file, 0o644)

    await writeOwnerOnlyBundle(file, renderBundle(buildBundle(REPORT, DEFAULT_SETTINGS, []), false))
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
    }
    assert.match(await readFile(file, 'utf8'), /# Git Stacks support bundle/u)
  })
})

test('the capability report names the CLI authentication and the measured environment', async () => {
  const report = await runDiagnostics({
    runtime: { runtime: null, error: null, minimumVersion: '2.45.0', useSystemGit: false },
    githubCli: {
      probe: { install: 'present', version: 'gh version 2.62.0' },
      status: {
        state: 'authenticated',
        host: 'github.com',
        login: 'octocat',
        version: 'gh version 2.62.0',
        identity: 'ghcli-1',
        message: null,
      },
    },
    environment: {
      identity: { name: 'Ada', email: 'ada@example.com' },
      defaultBranch: 'main',
      httpsCredentials: { configured: true, helper: 'osxkeychain' },
      ssh: { available: true, version: 'OpenSSH_9.6' },
    },
    host: { platform: 'darwin', release: '23.0', arch: 'arm64', electron: '30.0.0' },
    filesystem: { refFormat: 'files', error: null },
    appVersion: '0.1.0',
    settings: DEFAULT_SETTINGS,
  })
  const measured = Object.fromEntries(report.entries.map((entry) => [entry.label, entry]))
  assert.equal(measured['GitHub CLI authentication']?.value, 'authenticated')
  assert.equal(measured['GitHub CLI authentication']?.status, 'confirmed')
  assert.equal(measured['GitHub CLI account']?.value, 'octocat')
  assert.equal(measured['gh --version']?.value, 'gh version 2.62.0')
  // The credential behind the CLI is never named: the identity is this build's
  // own opaque generation, and it does not reach the report.
  assert.equal(JSON.stringify(report.entries).includes('ghcli-1'), false)
  assert.equal(measured['Git HTTPS helper']?.status, 'confirmed')
  assert.equal(measured['Git HTTPS helper']?.value, 'a helper is configured')
  assert.equal(measured['SSH client']?.status, 'confirmed')
  assert.equal(measured['SSH client']?.value, 'available')

  // The same lines with nothing measured stay unavailable rather than filled in.
  const unmeasured = await runDiagnostics({
    runtime: { runtime: null, error: null, minimumVersion: '2.45.0', useSystemGit: false },
    environment: null,
    host: { platform: 'darwin', release: '23.0', arch: 'arm64', electron: '30.0.0' },
    filesystem: { refFormat: null, error: 'storage unavailable' },
    appVersion: '0.1.0',
    settings: DEFAULT_SETTINGS,
  })
  const statuses = Object.fromEntries(
    unmeasured.entries.map((entry) => [entry.label, entry.status]),
  )
  assert.equal(statuses['Git HTTPS helper'], 'unavailable')
  assert.equal(statuses['SSH client'], 'unavailable')
})

/**
 * A `gh` this run owns, on a PATH that holds nothing else.
 *
 * The CLI is a real child process here, not a stub of one, because what is
 * being tested is the shape of what reaches the report: what the binary prints,
 * what its exit status does to the answer, and what it inherits. The
 * environment is built rather than inherited, so nothing of this machine's —
 * no credential, no personal PATH — reaches the probe.
 */
async function installControlledGh(
  body: string,
  directory: string,
): Promise<{ path: string; invoked: string }> {
  const marker = join(directory, 'invoked.txt')
  const binary = join(directory, 'gh')
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n')
${body}
`,
  )
  await chmod(binary, 0o755)
  // The boundary answers only for directories a run declared its own, and this
  // is where this run installed the CLI it just wrote.
  admitOwnedProviderCliRoot(directory)
  return { path: directory, invoked: marker }
}

/** The GitHub CLI lines, keyed by label, from one report built on these sources. */
async function cliLines(
  sources: Partial<DiagnosticSources>,
): Promise<Record<string, { value: string; status: string; detail?: string }>> {
  const report = await runDiagnostics({
    runtime: { runtime: null, error: null, minimumVersion: '2.45.0', useSystemGit: false },
    environment: null,
    host: { platform: 'darwin', release: '24.3.0', arch: 'arm64', electron: '33.2.1' },
    filesystem: { refFormat: 'files', error: null },
    appVersion: '0.1.0',
    settings: DEFAULT_SETTINGS,
    ...sources,
  })
  return Object.fromEntries(
    report.entries
      .filter((entry) => entry.label.startsWith('GitHub CLI') || entry.label === 'gh --version')
      .map((entry) => [
        entry.label,
        { value: entry.value, status: entry.status, detail: entry.detail },
      ]),
  )
}

test('an installed GitHub CLI is reported by version alone, and never as authentication', {
  skip: process.platform === 'win32' ? 'the controlled CLI uses a POSIX shebang' : false,
}, async () => {
  await withTempDir(async (dir) => {
    const cli = await installControlledGh(
      `process.stdout.write('gh version 2.62.0 (2024-11-14)\\n')`,
      dir,
    )

    const sources = await readGitHubCliSources({ PATH: cli.path })
    assert.equal(sources.probe?.install, 'present')
    const lines = await cliLines({ githubCli: sources })
    assert.equal(lines['gh --version']?.value, 'gh version 2.62.0')
    assert.equal(lines['gh --version']?.status, 'confirmed')
    // The build date the CLI prints is not part of the version, and nothing
    // else it was asked is reported. No status line appears at all: this probe
    // established an installed version, never an account.
    assert.equal(JSON.stringify(lines).includes('2024-11-14'), false)
    assert.equal(lines['GitHub CLI authentication'], undefined)
    assert.deepEqual(await readFile(cli.invoked, 'utf8'), '["--version"]\n')
  })
})

test('the GitHub CLI probe inherits no credential and reports an absent CLI as optional', {
  skip: process.platform === 'win32' ? 'the controlled CLI uses a POSIX shebang' : false,
}, async () => {
  await withTempDir(async (dir) => {
    const observed = join(dir, 'inherited.txt')
    const cli = await installControlledGh(
      `process.stdout.write('gh version 2.62.0\\n')
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
  gitStacksToken: process.env.GIT_STACKS_GITHUB_TOKEN ?? null,
  enterpriseToken: process.env.GH_ENTERPRISE_TOKEN ?? null,
  scoped: Object.keys(process.env).filter((name) => name.startsWith('GIT_STACKS_GITHUB_TOKEN_')),
}))`,
      dir,
    )

    // The machine's own ambient credential is what a version query must never
    // see, so it is handed to the probe and has to come out the other side gone.
    const sources = await readGitHubCliSources({
      PATH: cli.path,
      GH_TOKEN: 'ghp_thismachinecredential000000000000',
      GITHUB_TOKEN: 'another-ambient-token',
      GIT_STACKS_GITHUB_TOKEN: 'scoped-ambient-token',
      GH_ENTERPRISE_TOKEN: 'enterprise-ambient-token',
      GIT_STACKS_GITHUB_TOKEN_GITHUB_COM: 'host-scoped-ambient-token',
    })
    assert.equal(sources.probe?.install, 'present')
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), {
      ghToken: null,
      githubToken: null,
      gitStacksToken: null,
      enterpriseToken: null,
      scoped: [],
    })

    // A PATH with no CLI on it is the ordinary case on most machines, and it is
    // a fact about the machine rather than a fault to fix: nothing in this app,
    // and no sign-in, depends on the CLI being installed.
    await mkdir(join(dir, 'empty'), { recursive: true })
    const absent = await readGitHubCliSources({ PATH: join(dir, 'empty') })
    assert.equal(absent.probe?.install, 'missing')
    const lines = await cliLines({ githubCli: absent })
    assert.equal(lines['gh --version']?.status, 'unavailable')
    assert.equal(lines['gh --version']?.value, 'not installed')
    assert.match(lines['gh --version']?.detail ?? '', /required/u)
  })
})

test('a failing or unrecognisable GitHub CLI reports unavailable without echoing what it printed', {
  skip: process.platform === 'win32' ? 'the controlled CLI uses a POSIX shebang' : false,
}, async () => {
  await withTempDir(async (dir) => {
    // A CLI that exits non-zero after writing a credential-shaped string and a
    // path to itself: neither may reach the report or the bundle.
    const secret = 'ghp_thisoutputcredential0000000000000'
    const failing = await installControlledGh(
      `process.stdout.write('token ${secret}\\n/usr/local/bin/gh: broken\\n')
process.stderr.write('gh: fatal ${secret}\\n')
process.exit(1)`,
      dir,
    )
    const failureSources = await readGitHubCliSources({ PATH: failing.path })
    assert.equal(failureSources.probe?.install, 'unreadable')
    const failureLines = await cliLines({ githubCli: failureSources })
    assert.equal(failureLines['gh --version']?.status, 'unavailable')
    assert.equal(failureLines['gh --version']?.value, 'could not be read')
    assert.equal(JSON.stringify(failureLines).includes(secret), false)
    assert.equal(JSON.stringify(failureLines).includes('/usr/local/bin'), false)

    // Output this build does not recognise is reported as unrecognised. A
    // version-shaped number that is not a version is the case that matters:
    // believing it would put a fabricated version in a bug report.
    const malformedDir = join(dir, 'malformed')
    await mkdir(malformedDir, { recursive: true })
    const malformed = await installControlledGh(
      `process.stdout.write('gh version nightly.build ${secret} at /Users/someone/tools/gh\\n')`,
      malformedDir,
    )
    const malformedLines = await cliLines({
      githubCli: await readGitHubCliSources({ PATH: malformed.path }),
    })
    assert.equal(malformedLines['gh --version']?.status, 'unavailable')
    assert.equal(malformedLines['gh --version']?.value, 'could not be read')
    assert.equal(JSON.stringify(malformedLines).includes(secret), false)
    assert.equal(JSON.stringify(malformedLines).includes('/Users/someone'), false)

    // The same report is what a support bundle carries, so the exclusions hold
    // there as well.
    const bundle = buildBundle(
      {
        entries: [
          {
            source: 'github',
            label: 'gh --version',
            value: malformedLines['gh --version']!.value,
            status: 'unavailable',
            detail: malformedLines['gh --version']!.detail,
          },
        ],
        generatedAt: '2026-09-25T12:00:00.000Z',
        appVersion: '0.1.0',
      },
      DEFAULT_SETTINGS,
      [],
    )
    const rendered = renderBundle(bundle, false)
    assert.match(rendered, /github\/gh --version: could not be read/u)
    assert.equal(rendered.includes(secret), false)
  })
})

test('GitHub CLI version parsing and report projection exclude untrusted output on every platform', async () => {
  const secret = 'ghp_thisoutputcredential0000000000000'
  for (const [output, expected] of [
    [
      `gh version 2.62.0 (2024-11-14)\n${secret} /Users/someone/tools/gh`,
      { value: 'gh version 2.62.0', status: 'confirmed' },
    ],
    [
      `gh version nightly.build ${secret} at /Users/someone/tools/gh`,
      { value: 'unrecognized GitHub CLI version output', status: 'unavailable' },
    ],
  ] as const) {
    assert.deepEqual(parseGhVersion(output), expected)
    const lines = await cliLines({
      githubCli: {
        probe:
          expected.status === 'confirmed'
            ? { install: 'present', version: expected.value }
            : { install: 'present', version: null },
      },
    })
    assert.equal(lines['gh --version']?.status, expected.status)
    assert.equal(JSON.stringify(lines).includes(secret), false)
    assert.equal(JSON.stringify(lines).includes('/Users/someone'), false)
  }
  // Nothing read from this process means no line at all, rather than a line
  // claiming the CLI was not asked: the CLI is required, and a report with
  // nothing to say about it says nothing.
  const lines = await cliLines({})
  assert.equal(lines['gh --version'], undefined)
})

test('the GitHub host setting keeps a bare host name and refuses anything aimed elsewhere', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    const default_ = await readSettingsFile(file)
    assert.equal(default_.settings.github.host, 'github.com')

    const enterprise = await updateSettings(file, { github: { host: 'ghe.example.com' } }, [])
    assert.equal(enterprise.settings.github.host, 'ghe.example.com')
    assert.deepEqual(enterprise.issues, [])
    // It is stored, not just returned, so a later read keeps the choice.
    assert.equal((await readSettingsFile(file)).settings.github.host, 'ghe.example.com')

    // A pasted https URL is normalized down to the host it names, which is the
    // one form of "aimed elsewhere" that is safe to accept.
    const pasted = await updateSettings(file, { github: { host: 'https://other.example.com' } }, [])
    assert.equal(pasted.settings.github.host, 'other.example.com')
    await updateSettings(file, { github: { host: 'ghe.example.com' } }, [])

    // An enterprise host on its own port is legitimate, and the API base is
    // built from that host rather than from github.com's.
    const ported = await updateSettings(file, { github: { host: 'ghe.example.com:8443' } }, [])
    assert.equal(ported.settings.github.host, 'ghe.example.com:8443')
    assert.equal(
      githubHostContext(ported.settings.github.host).apiBase,
      'https://ghe.example.com:8443/api/v3',
    )
    await updateSettings(file, { github: { host: 'ghe.example.com' } }, [])

    for (const refused of [
      'http://ghe.example.com',
      'ssh://ghe.example.com',
      'ghe.example.com/api/v3',
      'ghe.example.com/../evil',
      'not a host',
    ]) {
      const rejected = await updateSettings(file, { github: { host: refused } }, [])
      assert.equal(rejected.settings.github.host, 'ghe.example.com', `${refused} was not refused`)
      assert.ok(
        rejected.issues.some((issue) => issue.key === 'github.host'),
        `${refused} produced no issue`,
      )
    }
  })
})

test('a settings file written before the host existed keeps answering from github.com', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'settings.json')
    // The shape the previous version wrote: no github group at all.
    await writeFile(
      file,
      JSON.stringify({ git: { useSystemGit: true }, appearance: { theme: 'dark' } }),
    )
    const read = await readSettingsFile(file)
    assert.equal(read.settings.github.host, 'github.com')
    // An empty host is that same default, not a nameless enterprise host: every
    // existing installation keeps addressing github.com.
    const emptied = await updateSettings(file, { github: { host: '' } }, [])
    assert.equal(emptied.settings.github.host, 'github.com')
    assert.deepEqual(emptied.issues, [])
  })
})

/**
 * A synthetic protector that records every sealed value anything opens, and
 * answers with the secret that was sealed. A real store returns what it sealed,
 * so a protector that returned a marker would let a caller pass a test while
 * being handed the wrong credential. The retirement contract is that cleanup
 * never needs one: a credential is removed by its opaque reference, and proving
 * that means proving nothing was opened.
 */
function recordingProtector(opened: string[]): SecretProtector {
  return {
    store: () => ({ kind: 'system', name: 'synthetic' }),
    seal: (plain: string) => Buffer.from(`sealed:${plain}`, 'utf8'),
    open: (sealed: Buffer) => {
      const text = sealed.toString('utf8')
      opened.push(text)
      return text.replace(/^sealed:/u, '')
    },
  }
}

const sealedEntry = (reference: string, host: string, extra: Record<string, unknown> = {}) => ({
  reference,
  host,
  sealed: Buffer.from(`sealed:${reference}`).toString('base64'),
  createdAt: 1,
  ...extra,
})

const primaryRecordFile = (reference: string, host: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    reference,
    host,
    login: 'octocat',
    createdAt: 1,
    expiresAt: null,
    refreshExpiresAt: null,
    session: 'session-material',
    ...extra,
  })

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

test('the retired primary record takes its own credential and nothing else with it', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    // A store with another module's credential in it, a key this build does not
    // read, and a field on that other entry this build does not write.
    await writeFile(
      vaultFile,
      JSON.stringify({
        version: 1,
        lastRotatedAt: 1700000000000,
        entries: [
          sealedEntry('primary', 'github.com'),
          sealedEntry('notifications', 'github.com', { scopes: ['all'] }),
        ],
      }),
    )
    await writeFile(stateFile, primaryRecordFile('primary', 'github.com'))

    const retired = await retirePrimaryGitHubRecord({ vault, vaultFile, stateFile })
    assert.deepEqual(retired, { retired: true, host: 'github.com' })
    assert.deepEqual(opened, [], 'a sealed value was opened while retiring a record')

    const remaining = await readJson(vaultFile)
    assert.equal(remaining.lastRotatedAt, 1700000000000, 'an unrelated key was dropped')
    const entries = remaining.entries as Record<string, unknown>[]
    assert.deepEqual(
      entries.map((entry) => entry.reference),
      ['notifications'],
      "another module's credential was removed with the retired one",
    )
    assert.deepEqual(entries[0].scopes, ['all'], 'a field on a kept entry was dropped')
    await assert.rejects(stat(stateFile), 'the retired record is still on disk')
    const strays = (await readdir(dir)).filter(
      (name) => name.endsWith('.tmp') || name.endsWith('.claim'),
    )
    assert.deepEqual(strays, [], `the change left its own files behind: ${strays.join(', ')}`)
  })
})

test("retiring this build's last credential keeps what another writer put beside it", async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    // One credential this build owns, and beside it two fields another writer keeps in
    // the same file. This build neither writes those fields nor knows what they mean,
    // so removing the credential is the only thing it is allowed to do. One of the two
    // is spelled the way a JSON field can be that a plain object cannot hold as a
    // field at all, and it is written as JSON on disk rather than as an object here so
    // that it arrives the way it would arrive from any other writer.
    const store = JSON.parse(
      JSON.stringify({
        version: 1,
        rotationEpoch: 41,
        entries: [sealedEntry('primary', 'github.com')],
      }),
    ) as Record<string, unknown>
    Object.defineProperty(store, '__proto__', {
      value: { writtenBy: 'another-writer' },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    await writeFile(vaultFile, JSON.stringify(store))
    await writeFile(stateFile, primaryRecordFile('primary', 'github.com'))

    const retired = await retirePrimaryGitHubRecord({ vault, vaultFile, stateFile })
    assert.deepEqual(retired, { retired: true, host: 'github.com' })
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      [],
      "this build's own credential is still stored",
    )
    assert.ok(
      existsSync(vaultFile),
      'the file another writer still keeps something in was removed with the credential',
    )
    const kept = await readJson(vaultFile)
    assert.equal(kept.rotationEpoch, 41, "another writer's field was destroyed")
    assert.deepEqual(kept.entries, [], 'the credential it did own was not removed')
    assert.ok(
      Object.hasOwn(kept, '__proto__'),
      "another writer's field was dropped because a name from the file was assigned",
    )
    assert.deepEqual(
      (kept as Record<string, unknown>)['__proto__'],
      { writtenBy: 'another-writer' },
      "another writer's field was not kept as it was written",
    )
  })
})

test('a store replaced, malformed or pointed elsewhere is left exactly as it is', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    const document = (extra: unknown[]) =>
      JSON.stringify({
        version: 1,
        entries: [sealedEntry('primary', 'github.com'), ...extra],
      })

    // A store this process already read, replaced by a newer one that holds a
    // second credential: the change acts on what the file holds now, so the newer
    // credential survives instead of being lost from a remembered snapshot.
    await writeFile(vaultFile, document([]))
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      ['primary'],
    )
    await writeFile(vaultFile, document([sealedEntry('notifications', 'github.com')]))
    await vault.remove('primary')
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      ['notifications'],
      'the store that was on disk when the change began was overwritten from an earlier read',
    )

    // A replacement that is not JSON at all is not repaired, and not removed.
    await writeFile(vaultFile, document([]))
    await vault.references()
    await writeFile(vaultFile, '{ this is not json')
    await assert.rejects(vault.remove('primary'), /not readable/u)
    assert.equal(await readFile(vaultFile, 'utf8'), '{ this is not json')

    // A store that has become a link is this app's own nothing: reading through
    // it would let whatever is behind it be rewritten as if it were this app's
    // own file.
    const foreign = join(dir, 'somebody-elses-store.json')
    await writeFile(
      foreign,
      JSON.stringify({ version: 1, entries: [sealedEntry('foreign', 'github.com')] }),
    )
    await rm(vaultFile, { force: true })
    await symlink(foreign, vaultFile)
    assert.deepEqual(await vault.references(), [])
    await vault.remove('primary')
    assert.deepEqual(
      (await readJson(foreign)).entries,
      [sealedEntry('foreign', 'github.com')],
      'a store behind a link was rewritten',
    )

    // Two entries under one reference leave nothing to say which of them a
    // reference names, so neither may be acted on.
    await rm(vaultFile, { force: true })
    const duplicated = JSON.stringify({
      version: 1,
      entries: [sealedEntry('primary', 'github.com'), sealedEntry('primary', 'github.com')],
    })
    await writeFile(vaultFile, duplicated)
    await assert.rejects(vault.references(), /not readable/u)
    assert.equal(await readFile(vaultFile, 'utf8'), duplicated, 'a refused store was rewritten')
    assert.deepEqual(opened, [], 'a credential was opened while a store was refused')
  })
})

test("a record that cannot be proved to be this build's keeps its credential", async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    const store = (entry: Record<string, unknown>) =>
      JSON.stringify({ version: 1, entries: [entry] })
    const refused = async (label: string, record: string) => {
      await writeFile(vaultFile, store(sealedEntry('primary', 'github.com')))
      await writeFile(stateFile, record)
      const retired = await retirePrimaryGitHubRecord({ vault, vaultFile, stateFile })
      assert.deepEqual(retired, { retired: false, host: null }, label)
      assert.deepEqual(
        (await vault.references()).map((entry) => entry.reference),
        ['primary'],
        `${label}: the credential was deleted by a call that reported nothing was retired`,
      )
      assert.ok(existsSync(stateFile), `${label}: the record was removed`)
    }

    // A record carrying a field this build does not write is somebody else's.
    await refused('an unfamiliar field', primaryRecordFile('primary', 'github.com', { scope: 1 }))
    // A record that is not JSON, and a record that names nothing, are not records.
    await refused('malformed JSON', '{ not json')
    await refused('no reference', JSON.stringify({ host: 'github.com' }))
    // A credential sealed for another host is not the one this record names.
    await writeFile(vaultFile, store(sealedEntry('primary', 'ghe.example.com')))
    await writeFile(stateFile, primaryRecordFile('primary', 'github.com'))
    assert.deepEqual(await retirePrimaryGitHubRecord({ vault, vaultFile, stateFile }), {
      retired: false,
      host: null,
    })
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.host),
      ['ghe.example.com'],
    )

    // An entry carrying a field this build does not write may belong to another
    // build or another tool, so it is preserved rather than removed.
    await writeFile(
      vaultFile,
      store(sealedEntry('primary', 'github.com', { rotatedBy: 'another-build' })),
    )
    await writeFile(stateFile, primaryRecordFile('primary', 'github.com'))
    assert.deepEqual(await retirePrimaryGitHubRecord({ vault, vaultFile, stateFile }), {
      retired: false,
      host: null,
    })
    assert.equal(
      ((await readJson(vaultFile)).entries as Record<string, unknown>[])[0].rotatedBy,
      'another-build',
      'an entry this build does not recognise was removed',
    )

    // A record that is a link is something a person pointed somewhere, and what
    // is behind it is not this build's to delete.
    const pointed = join(dir, 'pointed-at.json')
    await writeFile(pointed, primaryRecordFile('primary', 'github.com'))
    await rm(stateFile, { force: true })
    await symlink(pointed, stateFile)
    await writeFile(vaultFile, store(sealedEntry('primary', 'github.com')))
    assert.deepEqual(await retirePrimaryGitHubRecord({ vault, vaultFile, stateFile }), {
      retired: false,
      host: null,
    })
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      ['primary'],
      'a link that named the record cost the credential it pointed at',
    )
    assert.equal(
      (await readJson(pointed)).session,
      'session-material',
      'the file a link pointed at was rewritten',
    )
    assert.deepEqual(opened, [], 'a credential was opened while a record was refused')
  })
})

test('a link planted where a change writes is never written through', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    const foreign = join(dir, 'notes.txt')
    await writeFile(foreign, "somebody else's data\n")
    // The name a rewrite used to write through, pointed at a file this app does
    // not own: whatever a change writes, this file is not it.
    await symlink(foreign, `${vaultFile}.tmp`)
    await writeFile(
      vaultFile,
      JSON.stringify({
        version: 1,
        entries: [sealedEntry('primary', 'github.com'), sealedEntry('other', 'github.com')],
      }),
    )

    await vault.remove('primary')
    assert.equal(await readFile(foreign, 'utf8'), "somebody else's data\n")
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      ['other'],
    )

    // The same for the name a claim used to be taken under.
    const pointed = join(dir, 'pointed-at-store.json')
    await writeFile(
      pointed,
      JSON.stringify({ version: 1, entries: [sealedEntry('kept', 'github.com')] }),
    )
    await rm(vaultFile, { force: true })
    await symlink(pointed, `${vaultFile}.claim`)
    await writeFile(
      vaultFile,
      JSON.stringify({ version: 1, entries: [sealedEntry('primary', 'github.com')] }),
    )
    await vault.clear()
    assert.deepEqual(
      JSON.parse(await readFile(pointed, 'utf8')).entries,
      [sealedEntry('kept', 'github.com')],
      'a store behind a link was cleared',
    )
    assert.deepEqual(await vault.references(), [])
  })
})

const nodeRequire = createRequire(import.meta.url)
const moduleBuiltin = nodeRequire('node:module') as { syncBuiltinESMExports: () => void }

/**
 * Arms timing hooks on the writable CommonJS `node:fs/promises` for one file of
 * this test's own, and re-syncs the built-in ESM exports so production code that
 * already holds the named imports reaches them.
 *
 * Only the timing is this test's: every filesystem operation is the real one,
 * on the real temporary directory, and the hooks are put back — exports included
 * — whatever happens next. Nothing here reaches the operating system's own
 * credential store or a real `gh`.
 */
function armFileSystemTiming(
  file: string,
  afterClaim: () => Promise<void>,
  beforeRead: () => void,
): () => void {
  const fsPromises = nodeRequire('node:fs/promises') as Record<string, unknown>
  const realOpen = fsPromises.open as (...args: unknown[]) => Promise<unknown>
  const realRename = fsPromises.rename as (...args: unknown[]) => Promise<unknown>
  fsPromises.open = (...args: unknown[]) => {
    if (args[0] === file) beforeRead()
    return realOpen(...args)
  }
  fsPromises.rename = async (...args: unknown[]) => {
    const renamed = await realRename(...args)
    if (args[0] === file && String(args[1]).endsWith('.claim')) await afterClaim()
    return renamed
  }
  moduleBuiltin.syncBuiltinESMExports()
  return () => {
    fsPromises.open = realOpen
    fsPromises.rename = realRename
    moduleBuiltin.syncBuiltinESMExports()
  }
}

test('a read never observes the gap a write opens while it holds the store aside', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    // Both credentials exist, and the set-up is finished, before anything is
    // armed: what is under test is what a reader sees during a later change.
    const primary = await vault.stage('github.com', 'primary-secret', 1)
    const notifications = await vault.stage('github.com', 'notifications-secret', 2)

    const claimed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    // Whether a change is holding the store aside, and whether a read actually
    // reached the file while it was: the first is the writer's own state, the
    // second is what a read did. The second only chooses how this test waits.
    let holding = false
    let readReachedFile = false
    const restore = armFileSystemTiming(
      vaultFile,
      async () => {
        holding = true
        claimed.resolve()
        await release.promise
        holding = false
      },
      () => {
        if (holding) readReachedFile = true
      },
    )
    let writer: Promise<void> | null = null
    try {
      writer = vault.remove(primary)
      await claimed.promise
      assert.equal(
        existsSync(vaultFile),
        false,
        'the change did not hold the store aside, so nothing was proved',
      )
      // The read starts here, while the store is held aside and its file is gone.
      // A read that reached the file at once answers from the gap, so this test
      // waits for it first and records what it said; a read that waited its turn
      // behind the change has nothing to answer until the change is done. Either
      // way the credential the store still holds is the answer that counts.
      const reader = vault.open(notifications, 'github.com')
      const earlyAnswer = readReachedFile ? await reader : undefined
      release.resolve()
      await writer
      assert.equal(
        earlyAnswer ?? (await reader),
        'notifications-secret',
        'a read that began while the store was held aside answered with the gap instead of the entry',
      )
      assert.deepEqual(
        opened,
        ['sealed:notifications-secret'],
        'the read opened a credential other than the one the store still held',
      )
      assert.deepEqual(
        (await vault.references()).map((entry) => entry.reference),
        [notifications],
      )
    } finally {
      release.resolve()
      await writer?.catch(() => undefined)
      restore()
    }
  })
})

test('a store another writer took over is never overwritten, and no removal is claimed', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    const primary = await vault.stage('github.com', 'primary-secret', 1)
    // A second credential, so removing one is a change that has something left
    // to write rather than a store this app empties.
    const notifications = await vault.stage('github.com', 'notifications-secret', 2)
    await writeFile(stateFile, primaryRecordFile(primary, 'github.com'))
    // What this app's own store holds, entry for entry, before any of this runs.
    const ownStore = (await vault.references()).map((entry) => ({
      reference: entry.reference,
      host: entry.host,
      sealed: entry.sealed,
      createdAt: entry.createdAt,
    }))

    // The other writer's store, created while this app's change holds its own
    // file aside: entries this change never saw, at a path it does not own.
    const theirs = JSON.stringify({
      version: 1,
      entries: [sealedEntry('another-writer', 'github.com')],
    })
    const claimed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const restore = armFileSystemTiming(
      vaultFile,
      async () => {
        await writeFile(vaultFile, theirs)
        claimed.resolve()
        await release.promise
      },
      () => undefined,
    )
    let writer: Promise<boolean> | null = null
    try {
      writer = vault.removeOwned(primary, 'github.com')
      await claimed.promise
      release.resolve()
      assert.equal(await writer, false, 'a removal that never happened was reported as one')
    } finally {
      release.resolve()
      await writer?.catch(() => undefined)
      restore()
    }
    assert.equal(
      await readFile(vaultFile, 'utf8'),
      theirs,
      "another writer's store was overwritten by a change that had already read it",
    )
    const retained = (await readdir(dir)).filter((name) => name.endsWith('.claim'))
    assert.equal(
      retained.length,
      1,
      `the file this app had sealed credentials in was discarded rather than kept: ${retained.join(', ')}`,
    )
    assert.deepEqual((await readJson(join(dir, retained[0]!))).entries, ownStore)

    // The same refusal through the retirement path: the record that named the
    // credential is put back exactly where it was found, because the credential
    // it names is still stored.
    const retired = await retirePrimaryGitHubRecord({ vault, vaultFile, stateFile })
    assert.deepEqual(retired, { retired: false, host: null })
    assert.equal(
      await readFile(stateFile, 'utf8'),
      primaryRecordFile(primary, 'github.com'),
      'the record was discarded by a call that reported nothing was retired',
    )
  })
})

test('a credential a Notifications center currently holds is never retired', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    await writeFile(
      vaultFile,
      JSON.stringify({
        version: 1,
        entries: [sealedEntry('notifications', 'github.com')],
      }),
    )
    // The record names the very reference the Notifications center holds: the
    // entry has this build's shape and this host, so only the caller's own
    // knowledge of what it holds can tell the two apart.
    await writeFile(stateFile, primaryRecordFile('notifications', 'github.com'))

    assert.deepEqual(
      await retirePrimaryGitHubRecord({
        vault,
        vaultFile,
        stateFile,
        protectedReferences: ['notifications'],
      }),
      { retired: false, host: null },
    )
    assert.ok(existsSync(stateFile), 'a protected credential took the record with it')
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      ['notifications'],
      'a credential the Notifications center holds was removed',
    )
  })
})

test('a claim that fails leaves the record it took, and says nothing was retired', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    // A store that cannot be parsed: the record names a real reference and the
    // file holding it is a regular file, so everything is checked before the
    // store turns out to be unreadable.
    await writeFile(vaultFile, '{ not json')
    const record = primaryRecordFile('primary', 'github.com')
    await writeFile(stateFile, record)

    assert.deepEqual(await retirePrimaryGitHubRecord({ vault, vaultFile, stateFile }), {
      retired: false,
      host: null,
    })
    assert.equal(
      await readFile(stateFile, 'utf8'),
      record,
      'a credential that could not be removed left no record of where it is',
    )
    assert.equal(
      await readFile(vaultFile, 'utf8'),
      '{ not json',
      'a store that could not be read was rewritten',
    )
    const strays = (await readdir(dir)).filter((name) => name.endsWith('.claim'))
    assert.deepEqual(strays, [], `a refused change left its own files behind: ${strays.join(', ')}`)
    assert.deepEqual(opened, [], 'a credential was opened while a record was refused')
  })
})

test('a removal reports only a removal this build can prove is its own', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const opened: string[] = []
    const vault = new CredentialVault(vaultFile, recordingProtector(opened))
    const store = async (entries: Record<string, unknown>[]) =>
      writeFile(vaultFile, JSON.stringify({ version: 1, entries }))
    const refused = async (label: string) =>
      assert.equal(
        await vault.removeOwned('primary', 'github.com'),
        false,
        `${label} was reported as a removal this build made`,
      )

    await refused('a store this build does not write')
    await store([sealedEntry('primary', 'github.com', { rotatedBy: 'another-build' })])
    await refused('an entry another build wrote')
    await store([sealedEntry('primary', 'ghe.example.com')])
    await refused('a credential sealed for another host')
    await store([sealedEntry('primary', 'github.com'), sealedEntry('primary', 'github.com')])
    await refused('a reference two entries answer to')
    await store([sealedEntry('primary', 'github.com')])
    assert.equal(
      await vault.removeOwned('primary', 'github.com'),
      true,
      "this build's own entry was not removed",
    )
    assert.deepEqual(await vault.references(), [])

    // A saved credential comes back as a reference the store actually holds, so
    // a caller that acts on one is acting on something that exists.
    const reference = await vault.stage('github.com', 'staged-secret', 3)
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      [reference],
    )
    assert.equal(await vault.open(reference, 'github.com'), 'staged-secret')
    assert.deepEqual(
      opened,
      ['sealed:staged-secret'],
      'anything other than the caller opening its own staged credential was opened',
    )
  })
})

/**
 * The child the boundary runs inside. It imports the spawn functions before the
 * fixture installs anything, which is the harder case: a named import already
 * handed out has to see the guarded function, or production keeps the original.
 */
const BOUNDARY_CHILD = `
import { exec, execFile, execFileSync, execSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const [helper, root, owned, second, sentinel, alias, deep, linked] = process.argv.slice(2)
const fixture = createRequire(import.meta.url)(helper)
// The run's own directory comes from the environment; the second controlled CLI
// is admitted through the exported call, which is how a test that installs a CLI
// of its own declares it.
fixture.installOwnedProviderCliBoundary(root)
fixture.admitOwnedProviderCliRoot(second)
const run = promisify(execFile)
const report = {}
const withPath = (path) => ({ ...process.env, PATH: path })
const attempt = async (label, start) => {
  try {
    const value = await start()
    report[label] = {
      ran: true,
      value: typeof value === 'string' ? value : (value?.stdout ?? null),
    }
  } catch (error) {
    report[label] = { ran: false, code: error.code ?? null, value: error.stdout ?? null }
  }
}
const shell = (command) => () => new Promise((resolve, reject) => {
  const child = exec(command, { env: withPath(owned + ':' + sentinel) }, (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout)
  })
  child.stdin?.end()
})
const spawned = (file, options) => () => new Promise((resolve, reject) => {
  const child = spawn(file, options)
  child.on('error', reject)
  child.on('close', (code) => resolve(String(code)))
})

const options = { env: withPath(owned + ':' + sentinel), encoding: 'utf8' }

await attempt('owned-bare', () => run('gh', ['--version'], options))
await attempt('owned-absolute', () => run(owned + '/gh', ['--version'], options))
await attempt('sentinel-absolute', () => run(sentinel + '/gh', ['--version'], options))
await attempt('unowned-first-path', () => run('gh', ['--version'], {
  ...options,
  env: withPath(sentinel + ':' + owned),
}))
await attempt('other-spelling', () => run('gh.exe', ['--version'], options))
await attempt('alias-path', () => run('gh', ['--version'], {
  ...options,
  env: withPath(alias + ':' + sentinel),
}))
await attempt('relative-path-entry', () => run('gh', ['--version'], {
  ...options,
  cwd: root,
  env: withPath('./owned:' + sentinel),
}))
// Two controlled CLIs installed at once, each judged on the file its own PATH
// resolves to: neither is compared with the other, and neither is refused
// because another owned directory was searched first.
await attempt('second-owned-alone', () => run('gh', ['--version'], {
  ...options,
  env: withPath(second + ':' + sentinel),
}))
await attempt('second-owned-behind-first', () => run('gh', ['--version'], {
  ...options,
  env: withPath(owned + ':' + second + ':' + sentinel),
}))
// A CLI installed deep under an owned root is this run's own at that depth.
await attempt('deep-descendant', () => run('gh', ['--version'], {
  ...options,
  env: withPath(deep + ':' + sentinel),
}))
// An empty PATH entry is the child's own working directory, as it is for the
// operating system — owned or not, judged from there.
await attempt('empty-path-owned-cwd', () => run('gh', ['--version'], {
  ...options,
  cwd: owned,
  env: withPath(''),
}))
await attempt('empty-path-unowned-cwd', () => run('gh', ['--version'], {
  ...options,
  cwd: sentinel,
  env: withPath(''),
}))
// A file that is a link, even one pointing at another of this run's own files,
// is something a person pointed there rather than an install.
await attempt('linked-file', () => run(linked + '/gh', ['--version'], options))
await attempt('request-body', async () => {
  const child = run('gh', ['--input', '-'], options)
  child.child.stdin?.end('request-body-receipt')
  return (await child).stdout
})
await attempt('nonzero-json', () => run('gh', ['fail-json'], options))
await attempt('shell-command', shell(owned + '/gh --version'))
await attempt('shell-argv-absolute', () => execFileSync('gh', ['--version'], { shell: true }))
await attempt('shell-argv-command-string', spawned('gh --version', { shell: true, stdio: 'ignore' }))
await attempt('shell-argv-sentinel', spawned(sentinel + '/gh', { shell: false, stdio: 'ignore' }))
report['non-provider'] = {
  ran: true,
  value: execFileSync('git', ['--version'], { env: withPath(process.env.PATH ?? '') })
    .toString()
    .trim(),
}
process.stdout.write(JSON.stringify(report))
`

test('the fixture fences the GitHub CLI to the executables the run installed', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'root')
    const owned = join(root, 'owned')
    const second = join(root, 'second')
    const sentinel = join(root, 'sentinel')
    const alias = join(root, 'owned-alias')
    // A CLI installed deep under an owned root, and a directory holding nothing
    // but a link out of one.
    const deep = join(owned, 'nested', 'bin')
    const linked = join(owned, 'linked')
    for (const directory of [root, owned, second, sentinel, deep, linked]) {
      await mkdir(directory, { recursive: true })
    }
    await symlink(owned, alias)
    await symlink(join(sentinel, 'gh'), join(linked, 'gh'))
    // The controlled CLIs, and a CLI the run does not own whose only behaviour
    // is to leave a mark. None of them is the machine's own gh, which is never
    // invoked here.
    const cli = (banner: string) =>
      [
        '#!/bin/sh',
        'case "$1" in',
        `  --input) read -r body; printf '%s' "$body" > ${JSON.stringify(join(root, 'body-receipt'))} ;;`,
        '  fail-json) printf \'{"hosts":{}}\\n\'; exit 1 ;;',
        `  *) printf '${banner} gh %s\\n' "$*" ;;`,
        'esac',
        '',
      ].join('\n')
    await writeFile(join(owned, 'gh'), cli('owned'), { mode: 0o755 })
    await writeFile(join(second, 'gh'), cli('second'), { mode: 0o755 })
    await writeFile(join(deep, 'gh'), cli('deep'), { mode: 0o755 })
    await writeFile(
      join(sentinel, 'gh'),
      [
        '#!/bin/sh',
        `printf 'sentinel %s\\n' "$*" >> ${JSON.stringify(join(dir, 'sentinel.log'))}`,
        "printf 'gh version 9.9.9-sentinel\\n'",
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const child = join(root, 'boundary-child.mjs')
    await writeFile(child, BOUNDARY_CHILD)

    const run = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            child,
            join(process.cwd(), 'tests', 'fixtures', 'isolated-desktop.cjs'),
            root,
            owned,
            second,
            sentinel,
            alias,
            deep,
            linked,
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, GIT_STACKS_OWNED_GH_DIR: alias },
            timeout: 60_000,
          },
        ),
      ) as Record<
        string,
        { ran: boolean; code?: string | null; value?: string; stdout?: string | null }
      >

    let report = run()
    const ran = (label: string) => String(report[label].value)
    assert.match(ran('owned-bare'), /^owned gh --version/u, 'the owned CLI did not run')
    assert.match(ran('owned-absolute'), /^owned gh --version/u)
    assert.match(
      ran('alias-path'),
      /^owned gh --version/u,
      'an owned path through a link was refused',
    )
    assert.match(
      ran('relative-path-entry'),
      /^owned gh --version/u,
      'a relative PATH entry was refused',
    )
    // Both controlled CLIs run, whichever one the PATH actually resolves to,
    // and the deep one is judged from where it is installed rather than from a
    // search of everything beneath the root.
    assert.match(
      ran('second-owned-alone'),
      /^second gh --version/u,
      'the second owned CLI was refused',
    )
    assert.match(
      ran('second-owned-behind-first'),
      /^owned gh --version/u,
      'the first PATH entry was not the one that ran',
    )
    assert.match(
      ran('deep-descendant'),
      /^deep gh --version/u,
      'a CLI installed beneath an owned root was refused',
    )
    assert.match(
      ran('empty-path-owned-cwd'),
      /^owned gh --version/u,
      'an empty PATH entry did not resolve against the child working directory',
    )
    assert.equal(
      await readFile(join(root, 'body-receipt'), 'utf8').catch(() => null),
      'request-body-receipt',
      'the promisified execFile handed back no child for a request body to be written to',
    )
    assert.equal(
      report['nonzero-json'].value,
      '{"hosts":{}}\n',
      'a nonzero exit did not carry the JSON the auth-status parser reads',
    )
    assert.match(String(report['non-provider'].value), /^git version /u, 'real Git was fenced too')
    for (const label of [
      'sentinel-absolute',
      'unowned-first-path',
      'other-spelling',
      'empty-path-unowned-cwd',
      'linked-file',
      'shell-command',
      'shell-argv-absolute',
      'shell-argv-command-string',
      'shell-argv-sentinel',
    ]) {
      assert.equal(report[label].ran, false, `${label} started a CLI the run does not own`)
      assert.equal(report[label].code, 'ENOENT', `${label} was not answered as an absent CLI`)
    }
    assert.ok(!existsSync(join(dir, 'sentinel.log')), 'a CLI outside the owned directory ran')
    const refusals = await readFile(join(root, 'unowned-gh-launches.log'), 'utf8')
    assert.equal(
      refusals.trim().split('\n').length,
      9,
      `the run refused ${refusals.trim().split('\n').length} requests rather than the 9 it should have`,
    )

    // With the owned executable gone, the same PATH answers as a machine with no
    // CLI on it, and the sentinel behind it is still never reached.
    await rm(join(owned, 'gh'))
    await rm(join(root, 'unowned-gh-launches.log'))
    report = run()
    assert.equal(report['owned-bare'].code, 'ENOENT')
    assert.equal(report['sentinel-absolute'].code, 'ENOENT')
    assert.ok(!existsSync(join(dir, 'sentinel.log')), 'a CLI outside the owned directory ran')
  })
})

/**
 * A `gh` that is a real executable answering through the shared loopback
 * fixture: the request argv the shipped transport writes arrives as arguments,
 * a request body arrives on stdin, and the fixture's own answer is what the
 * process prints. Nothing about the answer is written for this test — it is the
 * same fixture the rest of the suite reads through.
 */
const LOOPBACK_CLI = `
const { readFileSync } = require('node:fs')
const { runGitHubCli } = require(__fixture__)
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('gh version 2.62.0 (2024-11-14)\\n')
  process.exit(0)
}
const input = args.includes('--input') ? readFileSync(0, 'utf8') : undefined
try {
  process.stdout.write(
    runGitHubCli({ statePath: __state__, barePath: __bare__, realGit: __git__, args, cwd: process.cwd(), input }),
  )
} catch (error) {
  process.stderr.write(String(error && error.message) + '\\n')
  process.exit(typeof error?.code === 'number' ? error.code : 2)
}
`

test('a real CLI child proves the account the loopback fixture serves', async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, 'bin')
    const barePath = join(dir, 'origin.git')
    await mkdir(bin, { recursive: true })
    // A real bare repository and the real Git, so the fixture is not told about
    // work it cannot actually do.
    spawnSync('git', ['init', '--bare', '--quiet', barePath], { encoding: 'utf8' })
    const realGit = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    const statePath = join(dir, 'fixture-state.json')
    await writeFile(
      statePath,
      JSON.stringify({
        repository: { owner: 'octocat', name: 'stacks' },
        currentUser: 'fixture-user',
        prs: [],
        requests: [],
      }),
    )
    await writeFile(
      join(bin, 'gh'),
      [
        `#!${process.execPath}`,
        LOOPBACK_CLI.replaceAll('__fixture__', () =>
          JSON.stringify(join(process.cwd(), 'tests', 'fixtures', 'github-cli.cjs')),
        )
          .replaceAll('__state__', () => JSON.stringify(statePath))
          .replaceAll('__bare__', () => JSON.stringify(barePath))
          .replaceAll('__git__', () => JSON.stringify(realGit)),
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    admitOwnedProviderCliRoot(bin)

    const answer = await readGitHubCli(githubHostContext('github.com'), { env: { PATH: bin } })
    assert.equal(
      answer.state,
      'authenticated',
      'the loopback CLI did not authenticate through the account the build pins',
    )
    assert.equal(
      answer.login,
      'fixture-user',
      'the account was not the one the proof request itself reported',
    )
    assert.ok(answer.authority, 'a proven account has a credential identity to fence on')

    // An inactive failed check establishes no active account and no rejection.
    await writeFile(
      statePath,
      JSON.stringify({
        repository: { owner: 'octocat', name: 'stacks' },
        currentUser: 'fixture-user',
        cliAccounts: { 'github.com': [{ state: 'error', active: false, login: 'stale' }] },
        prs: [],
        requests: [],
      }),
    )
    const refused = await readGitHubCli(githubHostContext('github.com'), { env: { PATH: bin } })
    assert.equal(
      refused.state,
      'unavailable',
      'a failed inactive check cannot establish that a credential was rejected',
    )

    // A host this run's CLI does not serve is refused rather than answered, and a
    // refusal that printed nothing is not read as a signed-out host either.
    const unserved = await readGitHubCli(githubHostContext('ghe.example.com'), {
      env: { PATH: bin },
    })
    assert.equal(
      unserved.state,
      'unavailable',
      'a host this run does not serve is a question this build cannot answer, not a signed-out host',
    )
  })
})

test('a destination provider this run is signed into authenticates a public host it never asked about', async () => {
  await withTempDir(async (dir) => {
    const destination = '127.0.0.1:65530'
    const bin = join(dir, 'bin')
    await mkdir(bin, { recursive: true })
    // The CLI of a provider this run is pointed at: signed in there, signed out
    // of the public host, and serving one account under the name that provider
    // answers on. It accepts a proof request only at its own address, so a read
    // that put the question to the public host could not be satisfied by this
    // CLI at all, and its own session for the public host is signed out.
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
const host = args.includes('--hostname') ? args[args.indexOf('--hostname') + 1] : 'github.com'
if (args.includes('--version')) {
  process.stdout.write('gh version 2.62.0 (2024-11-14)\\n')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(
    JSON.stringify({
      hosts:
        host === '${destination}'
          ? {
              '${destination}': [
                {
                  state: 'success',
                  active: true,
                  host: '${destination}',
                  login: 'ada',
                },
              ],
            }
          : {},
    }) + '\\n',
  )
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'token') {
  if (host !== '${destination}') process.exit(1)
  process.stdout.write('destination-credential\\n')
  process.exit(0)
}
const endpoint = args.find((arg) => arg.includes('/graphql'))
if (!endpoint || !endpoint.startsWith('http://${destination}/')) {
  process.stderr.write('the proof was not made against this provider: ' + endpoint + '\\n')
  process.exit(3)
}
// The envelope a real 'gh api --include' prints: the status line and the rate
// limit headers ahead of the body, which is what the transport parses.
process.stdout.write(
  'HTTP/2 200 OK\\r\\n' +
    'x-ratelimit-limit: 5000\\r\\n' +
    'x-ratelimit-remaining: 4998\\r\\n' +
    'x-ratelimit-reset: 1800000000\\r\\n' +
    'x-ratelimit-resource: core\\r\\n\\r\\n' +
    JSON.stringify({ data: { viewer: { login: 'ada' } } }) + '\\n',
)
process.exit(0)`,
      bin,
    )
    const read = await readGitHubCli(githubHostContext('github.com'), {
      env: { PATH: bin, GIT_STACKS_GITHUB_API_URL: `http://${destination}/api/v3` },
    })
    assert.equal(
      read.state,
      'authenticated',
      `gh was asked: ${await readFile(cli.invoked, 'utf8')}`,
    )
    assert.equal(read.login, 'ada', 'the account serving this run was not the one the read named')
  })
})

test('the CLI status proves the destination the app is pointed at, not the public API', async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, 'bin')
    const barePath = join(dir, 'origin.git')
    await mkdir(bin, { recursive: true })
    spawnSync('git', ['init', '--bare', '--quiet', barePath], { encoding: 'utf8' })
    const realGit = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    const statePath = join(dir, 'fixture-state.json')
    const writeState = async () =>
      writeFile(
        statePath,
        JSON.stringify({
          repository: { owner: 'octocat', name: 'stacks' },
          currentUser: 'override-account',
          // The session this run's CLI holds for the provider it was pointed at.
          // Requests for the public host are made against that destination, so
          // the account there is the one that answers them.
          cliAccounts: {
            '127.0.0.1:65530': [{ state: 'success', active: true, login: 'override-account' }],
          },
          prs: [],
          requests: [],
        }),
      )
    await writeState()
    await writeFile(
      join(bin, 'gh'),
      [
        `#!${process.execPath}`,
        LOOPBACK_CLI.replaceAll('__fixture__', () =>
          JSON.stringify(join(process.cwd(), 'tests', 'fixtures', 'github-cli.cjs')),
        )
          .replaceAll('__state__', () => JSON.stringify(statePath))
          .replaceAll('__bare__', () => JSON.stringify(barePath))
          .replaceAll('__git__', () => JSON.stringify(realGit)),
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    admitOwnedProviderCliRoot(bin)

    // The public host pointed at a destination of its own. Every request this app
    // makes for that host goes there and carries that destination's credential,
    // so the account it reports has to be the one proven there.
    const override = 'http://127.0.0.1:65530/api/v3'
    const answer = await readGitHubCli(githubHostContext('github.com'), {
      env: {
        PATH: bin,
        GIT_STACKS_GITHUB_API_URL: override,
        // A credential for the public host and one for the pointed-at
        // destination. Proving the account has to be pinned to the credential
        // that destination's requests carry, not the public host's.
        GH_TOKEN: 'public-host-credential',
        GH_ENTERPRISE_TOKEN: 'override-destination-credential',
      },
    })
    assert.equal(answer.state, 'authenticated', 'the pointed-at destination was not used')
    assert.equal(
      answer.login,
      'override-account',
      'the account was not the one the configured destination serves',
    )
    const requests = JSON.parse(await readFile(statePath, 'utf8')) as {
      requests: Array<{ argv: string[] }>
    }
    const proof = requests.requests
      .flatMap((entry) => entry.argv)
      .filter((arg) => arg.startsWith('http'))
    assert.ok(proof.length > 0, 'no request was made to prove the account')
    for (const url of proof) {
      assert.ok(
        url.startsWith(override),
        `the proof was made against ${url} rather than the configured destination`,
      )
    }
  })
})
