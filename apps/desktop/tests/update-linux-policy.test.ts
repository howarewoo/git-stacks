import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installStagedUpdate, installSupportFor } from '../src/main/update/install'

for (const platform of ['linux', 'win32']) {
  test(`unsupported ${platform} refuses an update outright and touches nothing`, async (t) => {
    assert.equal(installSupportFor(platform), null)
    const directory = mkdtempSync(join(tmpdir(), 'git-stacks-unsupported-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const before = readdirSync(directory)
    const outcome = await installStagedUpdate(
      {
        path: join(directory, 'unsupported-installer'),
        fileName: 'unsupported-installer',
        size: 0,
        sha256: 'x',
      },
      {
        platform,
        appPath: join(directory, 'unsupported-app'),
        userDataPath: join(directory, 'data'),
        relaunch: () => assert.fail('A refused update cannot restart anything'),
        quit: () => assert.fail('A refused update cannot close the app'),
      },
    )
    assert.equal(outcome.installed, false)
    assert.deepEqual(readdirSync(directory), before, 'nothing was written or removed')
  })
}
