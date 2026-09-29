import type { UpdateStatus } from '../../../src/shared/update'

/**
 * The states the updater reports, for the gallery. They are the same shapes the
 * main process sends, so a gallery state cannot drift from a real one.
 */
const base: Omit<UpdateStatus, 'phase'> = {
  offer: null,
  failure: null,
  progress: null,
  currentVersion: '0.1.0',
  channel: 'stable',
  supported: true,
  trust: 'release',
  readyToInstall: false,
  restartRequired: false,
}

const offer: NonNullable<UpdateStatus['offer']> = {
  channel: 'stable',
  version: '0.2.0',
  sequence: 12,
  notes: 'Faster repository lists and a clearer merge view.',
  rollbackOf: null,
  platform: 'darwin',
  arch: 'arm64',
  kind: 'dmg',
  fileName: 'Git-Stacks-0.2.0-arm64.dmg',
  size: 96 * 1024 * 1024,
  sha256: 'a'.repeat(64),
}

export const updateStatusFixture = {
  idle: { ...base, phase: 'idle' } as UpdateStatus,
  available: { ...base, phase: 'available', offer } as UpdateStatus,
  downloading: {
    ...base,
    phase: 'downloading',
    offer,
    progress: 63,
  } as UpdateStatus,
  downloaded: {
    ...base,
    phase: 'downloaded',
    offer,
    progress: 100,
    readyToInstall: true,
  } as UpdateStatus,
  cancelled: { ...base, phase: 'cancelled' } as UpdateStatus,
  notConfigured: {
    ...base,
    phase: 'not-configured',
    trust: 'none',
    failure: {
      reason: 'not-configured',
      message:
        'This build carries no release signing key, so no update can be trusted and none is fetched.',
    },
  } as UpdateStatus,
}
