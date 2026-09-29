import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  UPDATE_CHANNELS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  type UpdateArchitecture,
  type UpdateChannel,
  type UpdatePlatform,
  type UpdateStatus,
} from '../../shared/update'
import { isRecord } from '../../shared/guards'
import { discardStagedUpdate, downloadUpdateArtifact, type StagedUpdate } from './artifact'
import { installStagedUpdate, installSupportFor } from './install'
import { trustedUpdateKeys } from './keys'
import { loadAuthenticatedUpdate, type AuthenticatedUpdate } from './manifest'

export interface UpdateServiceOptions {
  packaged: boolean
  currentVersion: string
  /** The app bundle or executable this build runs from. */
  appPath: string
  /** Where staged installers and update state live. Never a repository. */
  userDataPath: string
  platform: string
  arch: string
  env?: NodeJS.ProcessEnv
  relaunch: () => void
}

interface UpdateState {
  /** The highest manifest sequence already authenticated, per channel. */
  seenSequences: Partial<Record<UpdateChannel, number>>
}

const EMPTY_STATE: UpdateState = { seenSequences: {} }

/**
 * Owns the whole update lifecycle: authenticate, offer, download, verify,
 * install, or stop.
 *
 * Two rules hold at every entry point. Nothing is fetched until a manifest is
 * authenticated, and nothing is written outside this application's own data
 * directory — a check, a refusal, and a rollback all leave a user's
 * repositories exactly as they were.
 */
export class UpdateService {
  private readonly options: UpdateServiceOptions
  private readonly listeners = new Set<(status: UpdateStatus) => void>()
  private state: UpdateState = EMPTY_STATE
  private authenticated: AuthenticatedUpdate | null = null
  private offer: UpdateStatus['offer'] = null
  private staged: StagedUpdate | null = null
  private failure: UpdateStatus['failure'] = null
  private progress: number | null = null
  private phase: UpdateStatus['phase'] = 'idle'
  private restartRequired = false
  private inFlight: AbortController | null = null
  private channel: UpdateChannel = 'stable'

  constructor(options: UpdateServiceOptions) {
    this.options = options
  }

  /** Reads the persisted replay guard before the first check can be made. */
  async start(channel: UpdateChannel): Promise<void> {
    this.channel = channel
    this.state = await this.readState()
    const trust = trustedUpdateKeys(this.options.env, this.options.packaged)
    if (trust.keys.length === 0) {
      this.failure = {
        reason: 'not-configured',
        message:
          'This build carries no release signing key, so no update can be trusted and none is fetched.',
      }
      this.phase = 'not-configured'
    } else if (!installSupportFor(this.options.platform)) {
      // Linux is distributed as a single AppImage the user runs from wherever
      // they put it. There is no installed copy to replace and no signature to
      // check before running one, so it is never updated in place.
      this.phase = 'unsupported'
    }
    this.publish()
  }

  /** A channel change starts over: a different feed, a different sequence. */
  async setChannel(channel: UpdateChannel): Promise<void> {
    if (!UPDATE_CHANNELS.includes(channel) || channel === this.channel) return
    this.channel = channel
    this.forgetOffer()
    this.phase = 'idle'
    this.publish()
  }

  status(): UpdateStatus {
    return {
      phase: this.phase,
      offer: this.offer,
      failure: this.failure,
      progress: this.progress,
      currentVersion: this.options.currentVersion,
      channel: this.channel,
      supported: installSupportFor(this.options.platform) !== null,
      trust: trustedUpdateKeys(this.options.env, this.options.packaged).trust,
      readyToInstall: this.staged !== null,
      restartRequired: this.restartRequired,
    }
  }

  onChange(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Authenticates the channel's manifest and, if it applies to this machine,
   * offers it. The sequence is recorded whether or not the offer was taken, so
   * the same manifest cannot be presented twice.
   */
  async check(): Promise<UpdateStatus> {
    const run = this.begin()
    if (!run) return this.status()
    this.phase = 'checking'
    this.failure = null
    this.publish()
    try {
      const result = await loadAuthenticatedUpdate(
        {
          channel: this.channel,
          platform: this.options.platform as UpdatePlatform,
          arch: this.options.arch as UpdateArchitecture,
          currentVersion: this.options.currentVersion,
          seenSequence: this.state.seenSequences[this.channel] ?? 0,
        },
        { packaged: this.options.packaged, env: this.options.env, signal: run },
      )
      if (!result.ok) {
        if (result.failure.reason === 'not-newer') {
          this.forgetOffer()
          this.phase = 'current'
          this.failure = null
          return this.publish()
        }
        this.phase = 'failed'
        this.failure = result.failure
        return this.publish()
      }
      this.authenticated = result.value
      this.offer = result.value.offer
      this.state.seenSequences[this.channel] = result.value.offer.sequence
      await this.writeState()
      this.phase = 'available'
      this.failure = null
      return this.publish()
    } catch (error) {
      return this.refuse(error)
    } finally {
      this.inFlight = null
    }
  }

  /**
   * Downloads the offered build and proves it against the digest and size the
   * signed manifest recorded. The URL is the one that manifest authenticated, so
   * nothing else — no installer, no helper, no Git — is ever fetched.
   */
  async download(): Promise<UpdateStatus> {
    if (!this.authenticated || this.phase !== 'available') {
      this.phase = 'failed'
      this.failure = { reason: 'malformed', message: 'There is no offered update to download.' }
      return this.publish()
    }
    const run = this.begin()
    if (!run) return this.status()
    try {
      this.phase = 'downloading'
      this.progress = 0
      this.publish()
      this.staged = await downloadUpdateArtifact({
        feed: this.authenticated.feed,
        artifact: this.authenticated.artifact,
        stagingDirectory: join(this.options.userDataPath, 'updates'),
        signal: run,
        timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
        onProgress: (percent) => {
          this.progress = percent
          this.publish()
        },
      })
      this.phase = 'downloaded'
      this.failure = null
      return this.publish()
    } catch (error) {
      if (this.staged) await discardStagedUpdate(this.staged)
      this.staged = null
      return this.refuse(error)
    } finally {
      this.inFlight = null
    }
  }

  /**
   * Applies a downloaded build. The platform's own signature is checked against
   * the identity of the running app first, so nothing unsigned is ever run,
   * and the restart is the platform installer's, not a silent one.
   */
  async install(): Promise<UpdateStatus> {
    if (!this.staged) {
      this.phase = 'failed'
      this.failure = { reason: 'malformed', message: 'There is no downloaded update to install.' }
      return this.publish()
    }
    this.phase = 'installing'
    this.publish()
    const outcome = await installStagedUpdate(this.staged, {
      platform: this.options.platform,
      appPath: this.options.appPath,
      relaunch: () => {
        this.restartRequired = true
        this.options.relaunch()
      },
    })
    if (!outcome.installed) {
      this.phase = 'failed'
      this.failure = { reason: 'bad-signature', message: outcome.reason }
      return this.publish()
    }
    return this.publish()
  }

  /** Stops whatever is in flight. Nothing half-finished is kept. */
  cancel(): UpdateStatus {
    this.inFlight?.abort()
    this.inFlight = null
    if (this.phase === 'downloading' || this.phase === 'checking') {
      this.phase = 'cancelled'
      this.progress = null
    }
    return this.publish()
  }

  private begin(): AbortSignal | null {
    if (this.inFlight) {
      this.phase = 'failed'
      this.failure = { reason: 'malformed', message: 'An update is already in progress.' }
      this.publish()
      return null
    }
    this.inFlight = new AbortController()
    return this.inFlight.signal
  }

  private forgetOffer(): void {
    this.authenticated = null
    this.offer = null
    this.progress = null
  }

  private refuse(error: unknown): UpdateStatus {
    this.phase = 'failed'
    this.failure = {
      reason: 'unreachable',
      message: error instanceof Error ? error.message : String(error),
    }
    return this.publish()
  }

  private publish(): UpdateStatus {
    const status = this.status()
    for (const listener of this.listeners) listener(status)
    return status
  }

  private statePath(): string {
    return join(this.options.userDataPath, 'updates.json')
  }

  private async readState(): Promise<UpdateState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath(), 'utf8'))
      if (!isRecord(parsed) || !isRecord(parsed.seenSequences)) return EMPTY_STATE
      const seenSequences: Partial<Record<UpdateChannel, number>> = {}
      for (const channel of UPDATE_CHANNELS) {
        const value = parsed.seenSequences[channel]
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          seenSequences[channel] = value
        }
      }
      return { seenSequences }
    } catch {
      // A missing or unreadable replay guard is replaced by a fresh one, which
      // only ever forgets history; it never treats anything as already seen.
      return EMPTY_STATE
    }
  }

  private async writeState(): Promise<void> {
    await mkdir(this.options.userDataPath, { recursive: true })
    await writeFile(this.statePath(), `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
  }

  /** Removes any staged installer this app left behind. */
  async discardStaged(): Promise<void> {
    if (this.staged) await discardStagedUpdate(this.staged)
    this.staged = null
    await rm(join(this.options.userDataPath, 'updates'), { recursive: true, force: true }).catch(
      () => undefined,
    )
  }
}
