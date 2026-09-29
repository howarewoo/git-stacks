import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  compareVersions,
  UPDATE_CHANNELS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  type UpdateArchitecture,
  type UpdateChannel,
  type UpdatePlatform,
  type UpdateStatus,
} from '../../shared/update'
import { isRecord } from '../../shared/guards'
import {
  discardStagedUpdate,
  downloadUpdateArtifact,
  hashStagedUpdate,
  type StagedUpdate,
} from './artifact'
import {
  installStagedUpdate,
  installSupportFor,
  reapReplacedBundle,
  resolveInstallTarget,
} from './install'
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
  /** Called when the platform installer needs this app to close first. */
  quit?: () => void
}

interface UpdateState {
  /** The highest manifest sequence already offered, per channel. */
  seenSequences: Partial<Record<UpdateChannel, number>>
}

function emptyState(): UpdateState {
  return { seenSequences: {} }
}

/** What a staged installer is, so it can never be installed as something else. */
interface Candidate {
  staged: StagedUpdate
  version: string
  arch: string
  sequence: number
  sha256: string
  channel: UpdateChannel
}

/** One attempt at one thing. Its generation decides whether it still counts. */
interface Run {
  generation: number
  controller: AbortController
}

/**
 * Owns the whole update lifecycle: authenticate, offer, download, verify,
 * install, or stop.
 *
 * Three rules hold at every entry point. Nothing is fetched until a manifest is
 * authenticated, nothing is written outside this application's own data
 * directory, and nothing an earlier run started can change state once that run
 * has been superseded — a cancelled, replaced, or channel-changed attempt is
 * discarded rather than allowed to land late.
 */
export class UpdateService {
  private readonly options: UpdateServiceOptions
  private readonly listeners = new Set<(status: UpdateStatus) => void>()
  private state: UpdateState = emptyState()
  /** Set when the replay guard could not be read, which stops every check. */
  private stateFailure: UpdateStatus['failure'] = null
  private authenticated: AuthenticatedUpdate | null = null
  private offer: UpdateStatus['offer'] = null
  private candidate: Candidate | null = null
  private failure: UpdateStatus['failure'] = null
  private progress: number | null = null
  private phase: UpdateStatus['phase'] = 'idle'
  private restartRequired = false
  private running: Run | null = null
  private generation = 0
  private channel: UpdateChannel = 'stable'

  constructor(options: UpdateServiceOptions) {
    this.options = options
  }

  /** Reads the persisted replay guard before the first check can be made. */
  async start(channel: UpdateChannel): Promise<void> {
    this.channel = channel
    this.state = await this.readState()
    const target = await resolveInstallTarget(this.options.platform, this.options.appPath)
    if (target.ok) {
      // A bundle a previous cut-over could not delete is removed now, while
      // this app is running from the new one rather than from it.
      await reapReplacedBundle(target.target, this.options.userDataPath).catch(() => undefined)
    }
    const trust = trustedUpdateKeys(this.options.env, this.options.packaged)
    if (trust.keys.length === 0) {
      this.failure = {
        reason: 'not-configured',
        message:
          'This build carries no release signing key, so no update can be trusted and none is fetched.',
      }
      this.phase = 'not-configured'
    } else if (this.stateFailure) {
      this.failure = this.stateFailure
      this.phase = 'failed'
    } else if (!installSupportFor(this.options.platform)) {
      // Linux is distributed as a single AppImage the user runs from wherever
      // they put it. There is no installed copy to replace and no signature to
      // check before running one, so it is never updated in place.
      this.phase = 'unsupported'
    }
    this.publish()
  }

  /**
   * A channel change starts over: a different feed, a different sequence, and
   * anything the old channel had in flight is stopped before the new one
   * begins, so a result from the old feed can never be recorded against the new.
   */
  async setChannel(channel: UpdateChannel): Promise<void> {
    if (!UPDATE_CHANNELS.includes(channel) || channel === this.channel) return
    this.abandon()
    this.channel = channel
    await this.discardCandidate()
    this.offer = null
    this.authenticated = null
    this.progress = null
    this.phase = this.stateFailure ? 'failed' : 'idle'
    this.failure = this.stateFailure
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
      // Only the build this run just verified, for the release on offer, may be
      // installed. An installer left over from an earlier offer is not this.
      readyToInstall: this.phase === 'downloaded' && this.candidate !== null,
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
   * offers it.
   *
   * The sequence is remembered as a high-water mark, not a lock: the same
   * release may be offered again, so an offer that was never taken is still
   * available after a restart, while an older release than one already seen is
   * refused as a replay.
   */
  async check(): Promise<UpdateStatus> {
    if (this.stateFailure) {
      this.phase = 'failed'
      this.failure = this.stateFailure
      return this.publish()
    }
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
        { packaged: this.options.packaged, env: this.options.env, signal: run.controller.signal },
      )
      if (!this.current(run)) return this.status()
      if (!result.ok) {
        // Anything other than "there is nothing new" invalidates the offer:
        // a channel's feed that cannot be trusted must not leave the previous
        // release staged and one click from being installed.
        await this.discardCandidate()
        this.offer = null
        this.authenticated = null
        if (
          result.failure.reason === 'not-newer' &&
          this.manifestIsCurrent(result.failure.message)
        ) {
          this.phase = 'current'
          this.failure = null
          return this.publish()
        }
        this.phase = 'failed'
        this.failure = result.failure
        return this.publish()
      }
      const offered = result.value.offer
      // A check that finds the same release again leaves a verified download
      // of it in place, still installable; one that finds a different release
      // discards it, so a staged installer is never one click from being
      // installed as something other than what it is.
      const kept = this.sameAsCandidate(offered)
      if (!kept) await this.discardCandidate()
      this.authenticated = result.value
      this.offer = offered
      this.state.seenSequences[offered.channel] = Math.max(
        offered.sequence,
        this.state.seenSequences[offered.channel] ?? 0,
      )
      try {
        await this.writeState()
      } catch (error) {
        // The release is authenticated either way. A guard that cannot be
        // persisted would forget what it has seen, so checks stop instead.
        this.stateFailure = {
          reason: 'unreachable',
          message: `The update history could not be saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
        this.phase = 'failed'
        this.failure = this.stateFailure
        this.authenticated = null
        this.offer = null
        return this.publish()
      }
      this.phase = kept ? 'downloaded' : 'available'
      this.failure = null
      return this.publish()
    } catch (error) {
      return this.current(run) ? this.refuse(error) : this.status()
    } finally {
      this.end(run)
    }
  }

  /**
   * Downloads the offered build and proves it against the digest and size the
   * signed manifest recorded. The URL is the one that manifest authenticated, so
   * nothing else — no installer, no helper, no Git — is ever fetched.
   */
  async download(): Promise<UpdateStatus> {
    const offer = this.authenticated
    // A cancelled check or download leaves the offer standing: cancelling stops
    // the attempt, it does not withdraw the release that was authenticated.
    if (!offer || (this.phase !== 'available' && this.phase !== 'cancelled')) {
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
      const staged = await downloadUpdateArtifact({
        feed: offer.feed,
        artifact: offer.artifact,
        stagingDirectory: join(this.options.userDataPath, 'updates'),
        signal: run.controller.signal,
        timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
        onProgress: (percent) => {
          // Progress from a superseded run is not this run's progress.
          if (!this.current(run)) return
          this.progress = percent
          this.publish()
        },
      })
      if (!this.current(run)) {
        await discardStagedUpdate(staged)
        return this.status()
      }
      this.candidate = {
        staged,
        version: offer.offer.version,
        arch: offer.offer.arch,
        sequence: offer.offer.sequence,
        sha256: offer.offer.sha256,
        channel: offer.offer.channel,
      }
      this.phase = 'downloaded'
      this.progress = 100
      this.failure = null
      return this.publish()
    } catch (error) {
      await this.discardCandidate()
      return this.current(run) ? this.refuse(error) : this.status()
    } finally {
      this.end(run)
    }
  }

  /**
   * Applies the build that was just verified for the release on offer. The
   * digest is proved again immediately before the installer runs, so a staged
   * file that was changed on disk after the download cannot be installed, and
   * the running app's own identity is checked by the platform installer.
   */
  async install(): Promise<UpdateStatus> {
    const candidate = this.candidate
    if (!candidate || this.phase !== 'downloaded') {
      this.phase = 'failed'
      this.failure = { reason: 'malformed', message: 'There is no downloaded update to install.' }
      return this.publish()
    }
    const run = this.begin()
    if (!run) return this.status()
    try {
      const digest = await hashStagedUpdate(candidate.staged)
      if (!this.current(run)) return this.status()
      if (digest !== candidate.sha256) {
        await this.discardCandidate()
        this.phase = 'failed'
        this.failure = {
          reason: 'bad-signature',
          message:
            'The downloaded installer no longer matches the signed release. It was not installed.',
        }
        return this.publish()
      }
      this.phase = 'installing'
      this.publish()
      const outcome = await installStagedUpdate(candidate.staged, {
        platform: this.options.platform,
        appPath: this.options.appPath,
        version: candidate.version,
        arch: candidate.arch,
        userDataPath: this.options.userDataPath,
        quit: this.options.quit,
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
    } catch (error) {
      return this.current(run) ? this.refuse(error) : this.status()
    } finally {
      this.end(run)
    }
  }

  /**
   * True when the manifest held the same version this build is already
   * running. A manifest that is older than that is a refused downgrade, not a
   * release with nothing new in it, and the surface must not say otherwise.
   */
  private manifestIsCurrent(message: string): boolean {
    const version = /^Version ([^ ]+) is not newer/u.exec(message)?.[1]
    return version !== undefined && compareVersions(version, this.options.currentVersion) === 0
  }

  /** True when the staged download is exactly the release now on offer. */
  private sameAsCandidate(offered: NonNullable<UpdateStatus['offer']>): boolean {
    const candidate = this.candidate
    if (!candidate) return false
    return (
      candidate.channel === offered.channel &&
      candidate.version === offered.version &&
      candidate.sequence === offered.sequence &&
      candidate.sha256 === offered.sha256
    )
  }

  /**
   * Stops whatever is in flight. The run is retired before its controller is
   * released, so the stopped run's own cleanup can neither resurrect it nor
   * clear the run that comes next.
   */
  cancel(): UpdateStatus {
    const run = this.running
    this.running = null
    run?.controller.abort()
    this.generation += 1
    this.progress = null
    if (
      run &&
      (this.phase === 'downloading' || this.phase === 'checking' || this.phase === 'installing')
    ) {
      this.phase = 'cancelled'
    }
    return this.publish()
  }

  /** Claims the one run slot, or refuses because something is already in it. */
  private begin(): Run | null {
    if (this.running) {
      this.phase = 'failed'
      this.failure = { reason: 'malformed', message: 'An update is already in progress.' }
      this.publish()
      return null
    }
    this.generation += 1
    const run: Run = { generation: this.generation, controller: new AbortController() }
    this.running = run
    return run
  }

  /** A run still counts only while it is the one holding the slot. */
  private current(run: Run): boolean {
    return this.running?.generation === run.generation
  }

  private end(run: Run): void {
    if (this.current(run)) this.running = null
  }

  /** Retires whatever is in flight without touching any published state. */
  private abandon(): void {
    const run = this.running
    this.running = null
    run?.controller.abort()
    this.generation += 1
  }

  /** Removes the verified installer bound to the offer, if there is one. */
  private async discardCandidate(): Promise<void> {
    const candidate = this.candidate
    this.candidate = null
    if (candidate) await discardStagedUpdate(candidate.staged)
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

  /**
   * The replay guard. A file that is not there yet is a fresh history; a file
   * that is there and cannot be read is not the same thing, and pretending it
   * is would forget every release this computer has already acted on. That
   * stops updating here rather than opening the door to an old release.
   */
  private async readState(): Promise<UpdateState> {
    let text: string
    try {
      text = await readFile(this.statePath(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      this.stateFailure = {
        reason: 'unreachable',
        message: `The update history could not be read: ${
          error instanceof Error ? error.message : String(error)
        }. Updates are stopped rather than run without it.`,
      }
      return emptyState()
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed) || !isRecord(parsed.seenSequences))
        throw new Error('not an update history')
      const seenSequences: Partial<Record<UpdateChannel, number>> = {}
      for (const channel of UPDATE_CHANNELS) {
        const value = parsed.seenSequences[channel]
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          seenSequences[channel] = value
        }
      }
      return { seenSequences }
    } catch (error) {
      this.stateFailure = {
        reason: 'unreachable',
        message: `The update history is damaged and cannot be trusted: ${
          error instanceof Error ? error.message : String(error)
        }. Updates are stopped rather than run without it.`,
      }
      return emptyState()
    }
  }

  /** Written whole or not at all, so a crash cannot leave half a history. */
  private async writeState(): Promise<void> {
    await mkdir(this.options.userDataPath, { recursive: true })
    const target = this.statePath()
    const temporary = `${target}.next`
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }

  /** Removes any staged installer this app left behind. */
  async discardStaged(): Promise<void> {
    await this.discardCandidate()
    await rm(join(this.options.userDataPath, 'updates'), { recursive: true, force: true }).catch(
      () => undefined,
    )
  }
}
