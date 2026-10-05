import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

interface IsolatedSafeStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(plain: string): Buffer
  decryptString(sealed: Buffer): string
}

interface IsolatedDesktopModule {
  KEY_FILE: string
  createFixtureKey(keyFile: string, fixtureRoot: string): Buffer
  createIsolatedSafeStorage(options: {
    keyFile: string
    fixtureRoot?: string
    native: Record<string, unknown>
  }): IsolatedSafeStorage
  installIsolatedSafeStorage(options: {
    electron: { safeStorage?: Record<string, unknown> } | null
    keyFile: string
    fixtureRoot: string
    logger?: (line: string) => void
  }): IsolatedSafeStorage
  readFixtureKey(keyFile: string): Buffer | null
}

const require = createRequire(import.meta.url)
const {
  KEY_FILE,
  createFixtureKey,
  createIsolatedSafeStorage,
  installIsolatedSafeStorage,
  readFixtureKey,
} = require('./fixtures/isolated-desktop.cjs') as IsolatedDesktopModule

function rejectingNative(calls: string[]) {
  const reject = (name: string) => () => {
    calls.push(name)
    throw new Error(`native ${name} must never be called inside the fixture`)
  }
  return {
    isEncryptionAvailable: reject('isEncryptionAvailable'),
    getSelectedStorageBackend: reject('getSelectedStorageBackend'),
    encryptString: reject('encryptString'),
    decryptString: reject('decryptString'),
  }
}

test('the synthetic store seals and opens across a restart and rejects another key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-desktop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keyFile = join(root, KEY_FILE)
  const nativeCalls: string[] = []
  const first = createIsolatedSafeStorage({
    keyFile,
    fixtureRoot: root,
    native: rejectingNative(nativeCalls),
  })
  const sealed = first.encryptString('ghp_example_token')
  assert.ok(Buffer.isBuffer(sealed))
  assert.ok(!sealed.includes(Buffer.from('ghp_example_token')))

  // A restart against the same fixture root re-reads the same key file.
  const second = createIsolatedSafeStorage({
    keyFile,
    fixtureRoot: root,
    native: rejectingNative(nativeCalls),
  })
  assert.equal(second.decryptString(sealed), 'ghp_example_token')

  // No other key opens this ciphertext, and no native method was ever used.
  const otherRoot = await mkdtemp(join(tmpdir(), 'isolated-desktop-other-'))
  t.after(() => rm(otherRoot, { recursive: true, force: true }))
  const wrongKey = createIsolatedSafeStorage({
    keyFile: join(otherRoot, KEY_FILE),
    fixtureRoot: otherRoot,
    native: rejectingNative([]),
  })
  assert.throws(() => wrongKey.decryptString(sealed))
  assert.deepEqual(nativeCalls, [])
})

test('the synthetic ciphertext is authenticated: any tampering fails to open', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-desktop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createIsolatedSafeStorage({
    keyFile: join(root, KEY_FILE),
    fixtureRoot: root,
    native: rejectingNative([]),
  })
  const sealed = store.encryptString(' credential ')
  for (const position of [0, 5, 16, sealed.length - 1]) {
    const tampered = Buffer.from(sealed)
    tampered[position] = tampered[position] ^ 0xff
    assert.throws(() => store.decryptString(tampered), /not|auth|Unable|Error/)
  }
  assert.throws(() => store.decryptString(Buffer.from('not an isolated ciphertext')))
})

test('install refuses to continue when the native object cannot be fully guarded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-desktop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.throws(() =>
    installIsolatedSafeStorage({
      electron: { safeStorage: { encryptString: () => Buffer.alloc(0) } },
      keyFile: join(root, KEY_FILE),
      fixtureRoot: root,
    }),
  )
  assert.throws(() =>
    installIsolatedSafeStorage({
      electron: {},
      keyFile: join(root, KEY_FILE),
      fixtureRoot: root,
    }),
  )
  assert.throws(() =>
    installIsolatedSafeStorage({
      electron: null,
      keyFile: join(root, KEY_FILE),
      fixtureRoot: root,
    }),
  )
})

test('held native aliases seal and open without reaching the operating-system store', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-desktop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const nativeCalls: string[] = []
  const native = rejectingNative(nativeCalls) as Record<string, () => unknown>
  const heldAlias = native as unknown as IsolatedSafeStorage
  const electron = { safeStorage: native }
  Object.defineProperty(electron, 'safeStorage', {
    get: () => native,
    configurable: false,
  })
  installIsolatedSafeStorage({
    electron,
    keyFile: join(root, KEY_FILE),
    fixtureRoot: root,
  })
  assert.equal(heldAlias.isEncryptionAvailable(), true)
  assert.notEqual(heldAlias.getSelectedStorageBackend(), 'basic_text')
  const sealed = heldAlias.encryptString('synthetic-credential')
  const fromGetter = electron.safeStorage as unknown as IsolatedSafeStorage
  assert.equal(fromGetter.decryptString(sealed), 'synthetic-credential')
  assert.deepEqual(nativeCalls, [])
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(root, KEY_FILE))).mode & 0o777, 0o600)
  }
})

test('a key file with the wrong size is refused, not silently replaced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-desktop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keyFile = join(root, KEY_FILE)
  await writeFile(keyFile, Buffer.from('too short'))
  assert.throws(() => readFixtureKey(keyFile))
  assert.throws(() => createFixtureKey(keyFile, root))
})
