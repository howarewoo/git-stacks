export interface GraphPreferences {
  preset: 'my-prs' | 'review-requested' | 'current-branch' | 'all-open'
  text: string
  author: string
  status: 'all' | 'draft' | 'ready' | 'checks-failed' | 'checks-pending'
  collapse: boolean
  name: string
}

/** Public provenance only; never includes credential or opaque authority material. */
export interface GraphPreferencesPublicScope {
  repositoryPath: string
  host: string
  repository: string
  account: string
}

export interface GraphPreferencesResult {
  state: 'ready' | 'unavailable' | 'recovered'
  preferences: GraphPreferences | null
  scope: GraphPreferencesPublicScope | null
  message?: string
}

export function parseGraphPreferencesPublicScope(
  value: unknown,
): GraphPreferencesPublicScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const fields = ['repositoryPath', 'host', 'repository', 'account'] as const
  if (
    Object.keys(row).length !== fields.length ||
    Object.keys(row).some((field) => !fields.includes(field as (typeof fields)[number])) ||
    fields.some((field) => typeof row[field] !== 'string' || !(row[field] as string).trim())
  )
    return null
  return {
    repositoryPath: row.repositoryPath as string,
    host: row.host as string,
    repository: row.repository as string,
    account: row.account as string,
  }
}

/** Reject unknown fields rather than persisting renderer authority or PR facts. */
export function parseGraphPreferences(value: unknown): GraphPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) => !['preset', 'text', 'author', 'status', 'collapse', 'name'].includes(key),
    )
  )
    return null
  if (
    !['my-prs', 'review-requested', 'current-branch', 'all-open'].includes(row.preset as string) ||
    !['all', 'draft', 'ready', 'checks-failed', 'checks-pending'].includes(row.status as string) ||
    typeof row.text !== 'string' ||
    row.text.length > 256 ||
    typeof row.author !== 'string' ||
    row.author.length > 100 ||
    typeof row.name !== 'string' ||
    row.name.length > 80 ||
    typeof row.collapse !== 'boolean'
  )
    return null
  return {
    preset: row.preset as GraphPreferences['preset'],
    text: row.text,
    author: row.author,
    status: row.status as GraphPreferences['status'],
    collapse: row.collapse,
    name: row.name,
  }
}
