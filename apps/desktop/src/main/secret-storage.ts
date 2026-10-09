import { safeStorage } from 'electron'
import type { SecretProtector, SecretStore } from './credentials'

/**
 * Sealing through the operating system's own secret store: the macOS Keychain,
 * DPAPI on Windows, and the kernel keyring on Linux. Linux falls back to
 * `basic_text` when no keyring is reachable, which obfuscates rather than
 * encrypts, so that backend is reported as unavailable instead of used.
 */
export const safeStorageProtector: SecretProtector = {
  store(): SecretStore {
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        kind: 'unavailable',
        reason: 'This computer has no available operating-system key store.',
      }
    }
    if (process.platform !== 'linux') {
      return {
        kind: 'system',
        name: process.platform === 'darwin' ? 'macOS Keychain' : 'Windows DPAPI',
      }
    }
    const backend = safeStorage.getSelectedStorageBackend()
    if (backend === 'basic_text' || backend === 'unknown') {
      return {
        kind: 'unavailable',
        reason:
          'This Linux session has no keyring (libsecret or KWallet) available to hold credentials securely.',
      }
    }
    return { kind: 'system', name: backend }
  },
  seal: (plain) => safeStorage.encryptString(plain),
  open: (sealed) => safeStorage.decryptString(sealed),
}
