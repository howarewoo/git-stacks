import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The Linux support policy, on its own.
 *
 * The release job prints a support line for every platform it builds, and for
 * Linux that line is "built and signed, never updated in place by the app". This
 * file is the executable form of that line: the shipped installer is asked what
 * it supports on Linux, and is then asked to install a staged update anyway.
 *
 * It is a file of its own, and it is invoked on its own, because the release job
 * has already injected a signing key set by the time it builds a Linux artifact
 * and a suite-wide run there would be testing the checkout this release is
 * building rather than the policy it is stating. The job therefore runs this
 * file and nothing else, and this test also records what it proved in a file the
 * job names: a test that stopped running, for any reason including being
 * renamed, leaves no proof behind, and a step that checks for the proof rather
 * than for a word in a test report cannot pass on silence.
 */
test('a Linux build refuses an update outright and touches nothing', async (t) => {
  const { installStagedUpdate, installSupportFor } = await import('../src/main/update/install')
  assert.equal(installSupportFor('linux'), null)
  const directory = mkdtempSync(join(tmpdir(), 'git-stacks-linux-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let relaunched = 0
  let quitFor = 0
  const before = readdirSync(directory)
  const outcome = await installStagedUpdate(
    {
      path: join(directory, 'Git-Stacks.AppImage'),
      fileName: 'Git-Stacks.AppImage',
      size: 0,
      sha256: 'x',
    },
    {
      platform: 'linux',
      appPath: join(directory, 'Git-Stacks.AppImage'),
      userDataPath: join(directory, 'data'),
      relaunch: () => {
        relaunched += 1
      },
      quit: () => {
        quitFor += 1
      },
    },
  )
  assert.equal(outcome.installed, false)
  assert.equal(relaunched, 0, 'a refused update does not restart anything')
  assert.equal(quitFor, 0, 'a refused update does not close the app')
  assert.deepEqual(readdirSync(directory), before, 'nothing was written or removed')

  const proof = process.env.GIT_STACKS_POLICY_PROOF
  if (proof) {
    writeFileSync(
      proof,
      JSON.stringify({
        policy: 'linux: best-effort artifact — never updated in place by the app',
        installer: installSupportFor('linux'),
        installed: outcome.installed,
        reason: outcome.reason,
        relaunched,
        quitFor,
        wroteNothing: true,
      }),
    )
  }
})
