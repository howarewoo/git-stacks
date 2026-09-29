import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
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
  privateInstallHandoff,
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
  /**
   * The platform installer this service calls. The app always passes the real
   * one; it is a parameter so the window around it — where a cancel is refused
   * and the boundary is held until the installer returns — can be exercised
   * without a real signed installer, which no development machine has.
   */
  install?: typeof installStagedUpdate
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

/** The one operation holding the boundary, and the signal a stop is asked through. */
interface Run {
  /** The one signal a stop is asked through. */
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
  /**
   * The one operation allowed to be in flight. It is not released by a cancel
   * or a channel change: it is released by the operation that holds it, in its
   * own `finally`, after its own cleanup has settled. Anything asked for while
   * it is held waits its turn rather than running beside it.
   */
  private running: Run | null = null
  private queue: Promise<void> = Promise.resolve()
  /** Counts durable writes, so two temporary files never share a name. */
  private writes = 0
  /** True once the platform installer owns the files this app runs from. */
  private cutover = false
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
   * the previous channel's staged build is removed.
   *
   * The caller's `commit` — the write that records the new channel in this
   * app's settings — runs inside this operation, between taking the channel and
   * publishing it. That is the whole point of the shape: a stored channel and
   * the channel this process is following cannot disagree, because the file is
   * written while the change is still undecided, and a failed write puts the
   * previous channel back before anything is published. A caller that passes no
   * commit changes the channel for this run only.
   *
   * The change waits for whatever is in flight to finish and clean up, so a
   * result from the old feed can never be recorded against the new one.
   */
  async applyChannel(
    channel: UpdateChannel,
    commit?: () => Promise<void>,
  ): Promise<UpdateStatus> {
    return this.exclusive(() => this.runApplyChannel(channel, commit))
  }

  private async runApplyChannel(
    channel: UpdateChannel,
    commit?: () => Promise<void>,
  ): Promise<UpdateStatus> {
    if (!UPDATE_CHANNELS.includes(channel) || channel === this.channel) return this.publish()
    if (this.cutover) {
      // The platform installer is already replacing this app's files. A channel
      // change now would report a state the installer is about to contradict.
      this.failure = {
        reason: 'unreachable',
        message:
          'The update is already being installed; the channel changes when the app restarts.',
      }
      return this.publish()
    }
    const previous = this.channel
    // This operation holds the boundary, so removing what the previous channel
    // staged is this operation's work, not a race with a run beside it.
    await this.discardCandidate()
    this.channel = channel
    this.offer = null
    this.authenticated = null
    this.progress = null
    if (commit) {
      try {
        await commit()
      } catch (error) {
        // The stored channel is still the old one, so this process follows it
        // too: a channel that failed to be saved is not a channel this app is
        // on. What was already discarded is gone; the next check offers again.
        this.channel = previous
        this.phase = 'failed'
        this.failure = {
          reason: 'unreachable',
          message: `The update channel was not changed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
        return this.publish()
      }
    }
    this.phase = this.stateFailure ? 'failed' : 'idle'
    this.failure = this.stateFailure
    return this.publish()
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
      readyToInstall:
        this.phase === 'downloaded' && this.candidate !== null && this.stateFailure === null,
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
    return this.exclusive(() => this.runCheck())
  }

  private async runCheck(): Promise<UpdateStatus> {
    if (this.stateFailure) {
      this.phase = 'failed'
      this.failure = this.stateFailure
      return this.publish()
    }
    const run = this.claim()
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
      if (!result.ok) {
        // Anything other than "there is nothing new" invalidates the offer: a
        // channel's feed that cannot be trusted must not leave the previous
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
      // A check that finds the same release again leaves a verified download of
      // it in place, still installable; one that finds a different release
      // discards it, so a staged installer is never one click from being
      // installed as something other than what it is.
      const kept = this.sameAsCandidate(offered)
      if (!kept) await this.discardCandidate()
      // The release becomes offerable only after the sequence that saw it is on
      // disk. A check that cannot record what it saw forgets it at the next
      // restart, and a replay guard that was never written is not a guard — so
      // the history is committed and made durable first, and a failure here
      // revokes the release rather than offering it.
      const channel = offered.channel
      const before = this.state.seenSequences[channel]
      this.state.seenSequences[channel] = Math.max(offered.sequence, before ?? 0)
      try {
        await this.writeState()
      } catch (error) {
        if (before === undefined) delete this.state.seenSequences[channel]
        else this.state.seenSequences[channel] = before
        this.stateFailure = {
          reason: 'unreachable',
          message: `The update history could not be saved: ${
            error instanceof Error ? error.message : String(error)
          }. Updates are stopped rather than run without it.`,
        }
        await this.discardCandidate()
        this.offer = null
        this.authenticated = null
        this.phase = 'failed'
        this.failure = this.stateFailure
        return this.publish()
      }
      this.authenticated = result.value
      this.offer = offered
      this.phase = kept ? 'downloaded' : 'available'
      this.failure = null
      return this.publish()
    } catch (error) {
      return this.classify(error)
    } finally {
      this.release(run)
    }
  }

  /**
   * Downloads the offered build and proves it against the digest and size the
   * signed manifest recorded. The URL is the one that manifest authenticated, so
   * nothing else — no installer, no helper, no Git — is ever fetched.
   */
  async download(): Promise<UpdateStatus> {
    return this.exclusive(() => this.runDownload())
  }

  private async runDownload(): Promise<UpdateStatus> {
    // A history that could not be recorded stops every download and install,
    // not only the check that found the problem: the release on offer is
    // dependent on a guard this app can no longer keep.
    if (this.stateFailure) {
      this.phase = 'failed'
      this.failure = this.stateFailure
      return this.publish()
    }
    const offer = this.authenticated
    // Only a release this process recorded as seen and committed to disk is
    // downloadable. A cancelled attempt leaves the offer standing, but the
    // next download is a fresh decision made by a fresh check, so a cancelled
    // run never downloads on the strength of a run that did not finish.
    if (!offer || this.phase !== 'available') {
      this.phase = 'failed'
      this.failure = { reason: 'malformed', message: 'There is no offered update to download.' }
      return this.publish()
    }
    const run = this.claim()
    this.phase = 'downloading'
    this.progress = 0
    this.publish()
    let staged: StagedUpdate | null = null
    try {
      const downloaded = await downloadUpdateArtifact({
        feed: offer.feed,
        artifact: offer.artifact,
        stagingDirectory: join(this.options.userDataPath, 'updates'),
        signal: run.controller.signal,
        timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
        onProgress: (percent) => {
          this.progress = percent
          this.publish()
        },
      })
      staged = downloaded
      this.candidate = {
        staged: downloaded,
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
      // Only the file this run staged is removed. A run that never reached one
      // has nothing to remove, and nothing belonging to another operation is
      // touched — the boundary is held until this cleanup has settled.
      if (staged) await discardStagedUpdate(staged)
      return this.classify(error)
    } finally {
      this.release(run)
    }
  }

  /**
   * Applies the build that was just verified for the release on offer. The
   * digest is proved again immediately before the installer runs, so a staged
   * file that was changed on disk after the download cannot be installed, and
   * the running app's own identity is checked by the platform installer.
   */
  async install(): Promise<UpdateStatus> {
    return this.exclusive(() => this.runInstall())
  }

  private async runInstall(): Promise<UpdateStatus> {
    if (this.stateFailure) {
      this.phase = 'failed'
      this.failure = this.stateFailure
      return this.publish()
    }
    const candidate = this.candidate
    if (!candidate || this.phase !== 'downloaded') {
      this.phase = 'failed'
      this.failure = { reason: 'malformed', message: 'There is no downloaded update to install.' }
      return this.publish()
    }
    const run = this.claim()
    const handoffDirectory = join(this.options.userDataPath, 'handoff')
    try {
      const digest = await hashStagedUpdate(candidate.staged)
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
      // The verified build is copied into owner-private handoff storage and the
      // installer is handed that path. This reduces interference with the
      // download between the digest check and the install; it does not bind the
      // check to an immutable object, and it is not a claim about anything
      // already running as this user.
      const handoff = await privateInstallHandoff(candidate.staged, handoffDirectory)
      this.phase = 'installing'
      // From here the platform installer owns this app's files. A cancel asked
      // for in this window is refused rather than pretended at, and the
      // boundary stays held until the installer has returned.
      this.cutover = true
      this.publish()
      let outcome: Awaited<ReturnType<typeof installStagedUpdate>>
      try {
        outcome = await (this.options.install ?? installStagedUpdate)(handoff, {
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
      } finally {
        this.cutover = false
        await rm(handoffDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
      if (!outcome.installed) {
        this.phase = 'failed'
        this.failure = { reason: 'bad-signature', message: outcome.reason }
        return this.publish()
      }
      return this.publish()
    } catch (error) {
      return this.classify(error)
    } finally {
      this.release(run)
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
   * Stops whatever is in flight.
   *
   * The operation is asked to stop through its signal, and the boundary stays
   * held: it is released by the operation itself, in its own `finally`, once
   * its own cleanup has settled. Anything asked for in the meantime waits its
   * turn, so a result from a stopped operation can never land beside a newer
   * one.
   *
   * A cancel during the platform install is not honoured, and says so. The
   * installer has already taken this app's files; pretending to stop there
   * would report a cancellation that did not happen.
   */
  cancel(): UpdateStatus {
    const run = this.running
    this.progress = null
    if (!run) return this.publish()
    if (this.cutover) {
      // The platform installer already has this app's files.
      this.failure = {
        reason: 'unreachable',
        message:
          'The update is already being installed and cannot be stopped now. It will finish or report why it did not.',
      }
      return this.publish()
    }
    if (this.phase === 'checking' || this.phase === 'downloading') this.phase = 'cancelled'
    run.controller.abort()
    return this.publish()
  }

  /**
   * Runs one operation at a time. A second call waits for the one in flight
   * rather than running beside it, and the wait is the whole reason a result
   * from a stopped operation cannot be applied to a newer one.
   */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Takes the boundary. The queue is empty when this is called. */
  private claim(): Run {
    const run: Run = { controller: new AbortController() }
    this.running = run
    return run
  }

  /** Gives the boundary back, after this operation's own cleanup has settled. */
  private release(run: Run): void {
    if (this.running === run) this.running = null
  }

  /**
   * How an operation ended. A stop is not a failure: the attempt was called
   * off, and the surface says the attempt was called off rather than that
   * something went wrong.
   */
  private classify(error: unknown): UpdateStatus {
    if (this.running?.controller.signal.aborted) {
      this.phase = 'cancelled'
      this.failure = null
      this.progress = null
      return this.publish()
    }
    return this.refuse(error)
  }

  /** Removes the verified installer bound to the offer, if there is one. */
  private async discardCandidate(): Promise<void> {
    const candidate = this.candidate
    this.candidate = null
    if (candidate) await discardStagedUpdate(candidate.staged)
  }

  /**
   * A refusal a person can act on: the reason is what kind of refusal it was,
   * not a single catch-all. A build that is not the one signed is a different
   * answer from a feed that could not be read, and the surface shows the reason
   * beside the message.
   */
  private refuse(error: unknown): UpdateStatus {
    this.phase = 'failed'
    const message = error instanceof Error ? error.message : String(error)
    const reason = /does not match the signed manifest|not the size the signed manifest/u.test(
      message,
    )
      ? 'bad-signature'
      : /outside the release location|redirected|outside this project|cancelled/iu.test(message)
        ? 'malformed'
        : 'unreachable'
    this.failure = { reason, message }
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
        if (!(channel in parsed.seenSequences)) continue
        const value = parsed.seenSequences[channel]
        // A channel that is present but unreadable is not an absent channel. It
        // is the one piece of evidence that a sequence has already been seen, so
        // dropping it would let a manifest with a lower sequence be accepted as
        // if the channel were new — and no install of that build could ever
        // update again. A history that cannot be read is a history refused.
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          throw new Error(`the ${channel} replay counter is not a number this app can read`)
        }
        seenSequences[channel] = value
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

  /**
   * Written whole or not at all, and made durable before it is believed.
   *
   * The bytes go to a temporary name of their own, are flushed to the disk, and
   * only then take the name the next start reads. The directory is flushed as
   * well, so a power loss cannot leave the history this process believed it had
   * committed missing. One operation holds the boundary at a time, so two runs
   * never write through one file, and the history only grows: the newest value
   * carries every sequence either run had seen.
   */
  private async writeState(): Promise<void> {
    this.writes += 1
    await mkdir(this.options.userDataPath, { recursive: true })
    const target = this.statePath()
    const temporary = `${target}.${process.pid}.${this.writes}.next`
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, target)
      // The rename itself has to reach the disk, or a crash can lose the name
      // while keeping the bytes the next start would have read.
      const directory = await open(this.options.userDataPath, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Removes any staged installer this app left behind. */
  async discardStaged(): Promise<void> {
    await this.discardCandidate()
    await rm(join(this.options.userDataPath, 'updates'), { recursive: true, force: true }).catch(
      () => undefined,
    )
  }
}
