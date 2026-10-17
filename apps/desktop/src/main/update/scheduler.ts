import type { AppSettings } from '@git-stacks/shared/settings'
import type { UpdateStatus } from '@git-stacks/shared/update'
import type { UpdateService } from './service'

export const DEFAULT_INITIAL_DELAY_MS = 5000
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateSchedulerOptions {
  service: UpdateService
  getSettings: () => Promise<AppSettings> | AppSettings
  /** Initial delay before running the first check after startup, in ms. Defaults to 5000. */
  initialDelayMs?: number
  /** Interval between periodic checks while running, in ms. Defaults to 24 hours. */
  intervalMs?: number
  /** Clock source for testing. Defaults to Date.now. */
  now?: () => number
  /** Hook for powerMonitor or resume event. */
  powerMonitor?: {
    on(event: string, listener: () => void): unknown
    removeListener?(event: string, listener: () => void): unknown
  }
  /** Optional guard returning true if an update installation fence is currently active. */
  isFenced?: () => boolean
}

/**
 * Schedules background update checks after startup and every 24 hours while running.
 *
 * Honors four invariant rules:
 * 1. Never delays workbench startup: initial check is scheduled after startup.
 * 2. Cadence is every 24h while running, with at most 1 overdue check after sleep.
 * 3. Skips (never queues) when the updater is already busy (checking, downloading, installing).
 * 4. Configless packaged builds and opted-out users never trigger network fetches.
 */
export class UpdateScheduler {
  private readonly options: UpdateSchedulerOptions
  private readonly initialDelayMs: number
  private readonly intervalMs: number
  private readonly now: () => number
  private initialTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private lastCheckTime = 0
  private running = false
  private readonly onResume = () => {
    void this.handleResume()
  }

  constructor(options: UpdateSchedulerOptions) {
    this.options = options
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
    this.intervalMs = options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastCheckTime = this.now()

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null
      void this.trigger()
    }, this.initialDelayMs)

    this.schedulePeriodicChecks()

    this.options.powerMonitor?.on('resume', this.onResume)
  }

  stop(): void {
    this.running = false
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    this.options.powerMonitor?.removeListener?.('resume', this.onResume)
  }

  private schedulePeriodicChecks(): void {
    if (!this.running) return
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.intervalTimer = setInterval(() => {
      void this.triggerScheduled()
    }, this.intervalMs)
  }

  /**
   * Triggers an update check if eligible. Returns the new UpdateStatus or null if skipped.
   *
   * Skips when:
   * - automatic checks are disabled in settings
   * - the build is unconfigured (no release keys)
   * - an update operation (check/download/install) is already running or holding the boundary
   */
  async trigger(): Promise<UpdateStatus | null> {
    if (!this.running) return null
    let settings: AppSettings
    try {
      settings = await this.options.getSettings()
    } catch {
      return null
    }

    if (!this.running) return null

    if (settings.updates?.automaticChecks === false) {
      return null
    }

    if (!this.options.service.isConfigured()) {
      return null
    }
    if (this.options.isFenced?.()) {
      return null
    }

    try {
      const result = await this.options.service.checkIfIdle()
      if (result !== null) {
        this.lastCheckTime = this.now()
        this.schedulePeriodicChecks()
      }
      return result
    } catch {
      // Automatic failures do not interrupt repository work or claim up-to-date
      return null
    }
  }

  async triggerScheduled(): Promise<UpdateStatus | null> {
    if (!this.running) return null
    const elapsed = this.now() - this.lastCheckTime
    if (elapsed < this.intervalMs) {
      return null
    }
    return this.trigger()
  }

  private async handleResume(): Promise<void> {
    if (!this.running) return
    const elapsed = this.now() - this.lastCheckTime
    if (elapsed >= this.intervalMs) {
      // At most one overdue check runs after sleep, never a burst of catch-ups
      await this.trigger()
    }
  }
}
