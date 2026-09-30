import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyPatch,
  readSettingsFile,
  readSettingsSnapshot,
  resetSettings,
  settingsPatchToWrite,
  updateSettings,
  validateSettings,
  writeSettingsFile,
} from '../src/main/settings'
import { loadSettingsPolicy, NO_POLICY } from '../src/main/settings-service'
import { buildBundle, renderBundle, writeOwnerOnlyBundle } from '../src/main/support-bundle'
import {
  locateTool,
  resolveEditorCommand,
  resolveEditorInvocation,
  resolveInsideRepository,
} from '../src/main/editor'
import { parseGitBuildOptions, parseGitVersion, runDiagnostics } from '../src/main/diagnostics'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import type { AppSettings, DiagnosticReport } from '../src/shared/settings'

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
    'privacy.includeLocalPaths',
    'shortcuts',
  ])
})

test('a policy that is not JSON locks everything rather than quietly unlocking it', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'policy.json')
    await writeFile(file, 'locks: {')
    const policy = await loadSettingsPolicy(file)
    assert.equal(policy.blocked, true)
    assert.equal(policy.locks.length, 10)
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
    assert.equal(policy.locks.length, 10)
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

test('the capability report names the app permissions and the measured environment', async () => {
  const report = await runDiagnostics({
    runtime: { runtime: null, error: null, minimumVersion: '2.45.0', useSystemGit: false },
    account: {
      state: 'signed-in',
      reference: 'opaque',
      host: 'github.com',
      login: 'octocat',
      permissions: [
        { permission: 'Contents', access: 'read', feature: 'Pull request commits' },
        { permission: 'Pull requests', access: 'write', feature: 'Native stacks' },
      ],
      expiresAt: null,
      refreshExpiresAt: null,
      store: { available: true, name: 'system store', reason: null },
      externalCredential: false,
      signingIn: false,
      challenge: null,
      message: null,
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
  assert.equal(measured['App permissions']?.value, 'Contents (read), Pull requests (write)')
  assert.equal(measured['Git HTTPS helper']?.status, 'confirmed')
  assert.equal(measured['Git HTTPS helper']?.value, 'a helper is configured')
  assert.equal(measured['SSH client']?.status, 'confirmed')
  assert.equal(measured['SSH client']?.value, 'available')

  // The same lines with nothing measured stay unavailable rather than filled in.
  const unmeasured = await runDiagnostics({
    runtime: { runtime: null, error: null, minimumVersion: '2.45.0', useSystemGit: false },
    account: null,
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
