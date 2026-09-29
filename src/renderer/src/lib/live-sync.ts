import type { RemoteFreshness, RemoteFreshnessState } from '../../../shared/types'

export interface FreshnessDescription {
  /** Short badge text; states are never conveyed by colour alone. */
  label: string
  /** The full sentence for the badge's accessible description and tooltip. */
  detail: string
  variant: 'secondary' | 'info' | 'warning' | 'danger'
  tone: 'neutral' | 'info' | 'warning' | 'error'
}

const VARIANT_BY_STATE: Record<RemoteFreshnessState, FreshnessDescription['variant']> = {
  fresh: 'secondary',
  refreshing: 'info',
  stale: 'warning',
  offline: 'warning',
  'rate-limited': 'warning',
  unauthorized: 'danger',
}

const TONE_BY_STATE: Record<RemoteFreshnessState, FreshnessDescription['tone']> = {
  fresh: 'neutral',
  refreshing: 'info',
  stale: 'warning',
  offline: 'warning',
  'rate-limited': 'warning',
  unauthorized: 'error',
}

const LABEL_BY_STATE: Record<RemoteFreshnessState, string> = {
  fresh: 'GitHub fresh',
  refreshing: 'Checking GitHub',
  stale: 'GitHub stale',
  offline: 'GitHub offline',
  'rate-limited': 'Rate limited',
  unauthorized: 'GitHub signed out',
}

/** `12s`, `4m`, `2h`, or `3d`: the age of the last confirmed GitHub data. */
export function formatFreshnessAge(fetchedAt: string | null, now: number): string | null {
  if (!fetchedAt) return null
  const elapsed = now - Date.parse(fetchedAt)
  if (!Number.isFinite(elapsed)) return null
  if (elapsed < 60_000) return `${Math.max(0, Math.round(elapsed / 1000))}s ago`
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`
  return `${Math.round(elapsed / 86_400_000)}d ago`
}

function formatReset(value: string | null, now: number): string | null {
  if (!value) return null
  const reset = Date.parse(value)
  if (!Number.isFinite(reset)) return null
  const minutes = Math.ceil((reset - now) / 60_000)
  if (minutes <= 0) return 'now'
  return minutes < 60 ? `in ${minutes} min` : `at ${new Date(reset).toLocaleTimeString()}`
}

/**
 * What the remote badge says. Every state names itself in text, so the state is
 * never carried by colour alone, and an unconfirmed answer says so instead of
 * presenting stale data as current.
 */
export function describeFreshness(
  freshness: RemoteFreshness | undefined,
  now: number = Date.now(),
): FreshnessDescription {
  if (!freshness) {
    return {
      label: 'GitHub unknown',
      detail: 'GitHub data has not been checked yet in this session.',
      variant: 'secondary',
      tone: 'neutral',
    }
  }
  const age = formatFreshnessAge(freshness.fetchedAt, now)
  const reset = formatReset(freshness.rateLimitReset, now)
  const parts: string[] = []
  if (freshness.state === 'fresh') {
    parts.push(age ? `GitHub data confirmed ${age}.` : 'GitHub data confirmed.')
  } else if (freshness.state === 'refreshing') {
    parts.push(age ? `Checking GitHub; last confirmed ${age}.` : 'Checking GitHub.')
  } else if (freshness.state === 'offline') {
    parts.push(
      age
        ? `GitHub is unreachable. Local Git still works; pull requests show data from ${age}.`
        : 'GitHub is unreachable. Local Git still works.',
    )
  } else if (freshness.state === 'rate-limited') {
    parts.push(reset ? `GitHub rate limited; polling resumes ${reset}.` : 'GitHub rate limited.')
  } else if (freshness.state === 'unauthorized') {
    parts.push('GitHub authentication failed. Sign in again to refresh remote data.')
  } else {
    parts.push(age ? `GitHub data is ${age} old.` : 'GitHub data has not been confirmed yet.')
  }
  if (freshness.detail && freshness.state !== 'offline') parts.push(freshness.detail)
  if (freshness.pendingMutations.length > 0) {
    parts.push(
      `${freshness.pendingMutations.length} GitHub action${freshness.pendingMutations.length === 1 ? '' : 's'} did not complete and will not be retried automatically.`,
    )
  }
  return {
    label: LABEL_BY_STATE[freshness.state],
    detail: parts.join(' '),
    variant: VARIANT_BY_STATE[freshness.state],
    tone: TONE_BY_STATE[freshness.state],
  }
}
