import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CredentialVault, type SecretProtector } from '../src/main/credentials'
import { retireLegacyPrimaryRecord } from '../src/main/notification-protection'

/**
 * The startup retirement at the boundary where it is decided: a legacy primary
 * record, one sealed vault, and the Notifications state files beside them.
 *
 * The record's credential and a Notifications credential are sealed entries of
 * exactly the same shape for exactly the same host, so nothing inside the vault
 * tells them apart — only the name a Notifications state file publishes can.
 * These tests hold both sides real: real files, a real vault, and state files
 * named the way `NotificationCenter` names them.
 */
const ENTERPRISE = 'ghe.example.com'
const PUBLIC = 'github.com'

const protector: SecretProtector = {
  store: () => ({ kind: 'system', name: 'test store', reason: null }),
  seal: (plain: string) => Buffer.from(plain, 'utf8').reverse(),
  open: (sealed: Buffer) => Buffer.from(sealed).reverse().toString('utf8'),
}

/** The host suffix `notificationScope` writes: the host's own name in hex. */
function scope(host: string): string {
  return Buffer.from(host, 'utf8').toString('hex')
}

function stateFileName(host: string): string {
  return `github-notifications.${scope(host)}.json`
}

async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'git-stacks-notification-gate-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A primary record of the shape an earlier build wrote. */
function primaryRecord(reference: string): Record<string, unknown> {
  return {
    reference,
    host: ENTERPRISE,
    login: 'octocat',
    createdAt: 1,
    expiresAt: null,
    refreshExpiresAt: null,
    session: 'session-1',
  }
}

/** One host's stored Notifications state, as `NotificationCenter` writes it. */
function notificationState(reference: string, host: string): string {
  return JSON.stringify({
    version: 1,
    reference,
    host,
    login: 'octocat',
    createdAt: '2026-01-01T00:00:00.000Z',
  })
}

test('a live Notifications credential is not retired, whichever host stored it', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const vault = new CredentialVault(vaultFile, protector)
    const stored = await vault.stage(ENTERPRISE, 'ghp_notificationsecret000000000000', 1)
    await writeFile(stateFile, JSON.stringify(primaryRecord(stored)))
    // The credential is held for two hosts: the one the record names, and one
    // that is not selected now. Both are read, because both are still stored.
    const other = await vault.stage(PUBLIC, 'ghp_othertoken000000000000000000', 1)
    await writeFile(join(dir, stateFileName(ENTERPRISE)), notificationState(stored, ENTERPRISE))
    await writeFile(join(dir, stateFileName(PUBLIC)), notificationState(other, PUBLIC))
    // Neither names a credential on its own, so neither is protection.
    await writeFile(join(dir, `github-notifications-cache.${scope(PUBLIC)}.json`), '{"issues":[]}')
    await writeFile(join(dir, `github-notifications-vault.${scope(PUBLIC)}.json`), '{"entries":[]}')

    const protectedRecord = await retireLegacyPrimaryRecord({ vault, vaultFile, stateFile }, dir)
    assert.deepEqual(
      protectedRecord,
      { retired: false, host: null },
      'state this app writes was not read as protection',
    )
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference).sort(),
      [other, stored].sort(),
      'a Notifications credential was retired by the record naming it',
    )
    assert.equal(await readFile(stateFile, 'utf8'), JSON.stringify(primaryRecord(stored)))

    // The same record, once no live Notifications credential is named, retires
    // as it always did: the protection is the live holder, not the shape.
    const own = await vault.stage(ENTERPRISE, 'ghp_appownedsecret000000000000', 1)
    await writeFile(stateFile, JSON.stringify(primaryRecord(own)))
    const unprotected = await retireLegacyPrimaryRecord({ vault, vaultFile, stateFile }, dir)
    assert.deepEqual(unprotected, { retired: true, host: ENTERPRISE })
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference).sort(),
      [other, stored].sort(),
      'the Notifications credentials went with a record that did not name them',
    )
  })
})

test('malformed Notifications state leaves every credential and the record untouched', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const vault = new CredentialVault(vaultFile, protector)
    const stored = await vault.stage(ENTERPRISE, 'ghp_notificationsecret000000000000', 1)
    await writeFile(stateFile, JSON.stringify(primaryRecord(stored)))
    // A truncated file, exactly as an interrupted write or a bad disk leaves it.
    await writeFile(join(dir, stateFileName(ENTERPRISE)), '{"version":1,"reference":"ghp_not')

    // The read that names it is refused, and the retirement answers that nothing
    // was retired rather than failing: the credential and the record naming it
    // are both still there, and startup carries on to the window either way.
    const retired = await retireLegacyPrimaryRecord({ vault, vaultFile, stateFile }, dir)
    assert.deepEqual(retired, { retired: false, host: null }, 'the gate opened on bad state')
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      [stored],
      'a credential was retired while its Notifications state was malformed',
    )
    assert.equal(await readFile(stateFile, 'utf8'), JSON.stringify(primaryRecord(stored)))
  })
})

test('state that names no reference is an unknown answer, not an absent credential', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const vault = new CredentialVault(vaultFile, protector)
    const stored = await vault.stage(ENTERPRISE, 'ghp_notificationsecret000000000000', 1)
    await writeFile(stateFile, JSON.stringify(primaryRecord(stored)))
    for (const contents of ['{}', '[]', 'null', '"ghp_notifications"']) {
      await writeFile(join(dir, stateFileName(ENTERPRISE)), contents)
      const retired = await retireLegacyPrimaryRecord({ vault, vaultFile, stateFile }, dir)
      assert.deepEqual(retired, { retired: false, host: null }, `${contents} opened the gate`)
      assert.deepEqual(
        (await vault.references()).map((entry) => entry.reference),
        [stored],
        `${contents} cost a credential the person still holds`,
      )
    }
  })
})

test('state this build cannot read at all closes the gate without rejecting', async () => {
  await withTempDir(async (dir) => {
    const vaultFile = join(dir, 'credentials.vault.json')
    const stateFile = join(dir, 'github-account.json')
    const vault = new CredentialVault(vaultFile, protector)
    const own = await vault.stage(ENTERPRISE, 'ghp_appownedsecret000000000000', 1)
    await writeFile(stateFile, JSON.stringify(primaryRecord(own)))

    // A path where the state file should be that cannot be read as one: the name
    // is there, and what the credential behind it is, is not.
    await mkdir(join(dir, stateFileName(ENTERPRISE)))
    const unreadable = await retireLegacyPrimaryRecord({ vault, vaultFile, stateFile }, dir)
    assert.deepEqual(unreadable, { retired: false, host: null })
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      [own],
      'a credential was retired while its Notifications state could not be read',
    )

    // And a user data directory that cannot be enumerated at all: the same
    // unknown answer, the same result, and still no failure.
    const notADirectory = join(dir, 'user-data-is-a-file')
    await writeFile(notADirectory, 'not a directory')
    const unlistable = await retireLegacyPrimaryRecord(
      { vault, vaultFile, stateFile },
      notADirectory,
    )
    assert.deepEqual(unlistable, { retired: false, host: null })
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      [own],
      'a credential was retired while no Notifications state could be enumerated',
    )
    assert.equal(await readFile(stateFile, 'utf8'), JSON.stringify(primaryRecord(own)))
  })
})
