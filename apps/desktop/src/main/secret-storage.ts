import { safeStorage } from 'electron'
import type { SecretProtector, SecretStore } from './credentials'

/** Native sealing is supported only through the macOS Keychain. */
export const safeStorageProtector: SecretProtector = {
  store(): SecretStore {
    if (process.platform !== 'darwin' || !safeStorage.isEncryptionAvailable()) {
      return {
        kind: 'unavailable',
        reason: 'This computer has no available operating-system key store.',
      }
    }
    return { kind: 'system', name: 'macOS Keychain' }
  },
  seal: (plain) => safeStorage.encryptString(plain),
  open: (sealed) => safeStorage.decryptString(sealed),
}
