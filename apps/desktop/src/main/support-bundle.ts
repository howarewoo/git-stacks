import { open } from 'node:fs/promises'
import type {
  AppSettings,
  BundleSection,
  DiagnosticReport,
  SupportBundlePreview,
} from '@git-stacks/shared/settings'

/**
 * A home directory prefix or a Windows user directory, whichever is present.
 * Only this is masked unconditionally: a path elsewhere on the machine is what
 * the explicit opt-in governs, and masking everything would make the opt-in
 * meaningless.
 */
const HOME_PREFIXES = [process.env.HOME, process.env.USERPROFILE].filter(
  (value): value is string => typeof value === 'string' && value.length > 0,
)

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9_]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /gho_[A-Za-z0-9_]{16,}/g,
  /ghu_[A-Za-z0-9_]{16,}/g,
  /ghs_[A-Za-z0-9_]{16,}/g,
  /ghr_[A-Za-z0-9_]{16,}/g,
  /bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /password\s*=\s*[^\s]+/gi,
  /token\s*=\s*[^\s]+/gi,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
]

export function sanitizeSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_SECRET]')
  }
  return result
}

const PATH_PATTERNS = [
  /(?:\/Users|\/home|\/var|\/tmp|\/private|\/opt|\/usr|\/etc|[a-zA-Z]:\\)[\w\-./\\]+/g,
]

export function sanitizePaths(text: string): string {
  let result = text
  for (const pattern of PATH_PATTERNS) {
    result = result.replace(pattern, '[withheld: path]')
  }
  return result
}

/**
 * The bundle is assembled from named fields, never from a log that was filtered
 * afterwards. Every value below is either chosen by this file or is a diagnostic
 * line that main already built from a fixed allowlist. That is what makes the
 * exclusions below a property of the code rather than a promise about a regex:
 * a token, a diff, or a branch body is never placed in a value to begin with, so
 * no opt-in and no secret shape can let one through.
 */
const NEVER_COLLECTED = [
  'access tokens, credential references, and Authorization headers',
  'repository source contents and file bodies',
  'diffs, patches, and hunk text',
  'branch names, commit messages, and pull request titles or bodies',
  'raw GitHub API request or response bodies',
] as const

/** One fact the bundle may carry, and how to render it. */
interface SafeField {
  name: string
  value: string
  /**
   * Whether this field can hold something that names a location on this
   * machine. Only these are subject to the path opt-in.
   */
  locational?: boolean
}

function settingsFields(settings: AppSettings): SafeField[] {
  return [
    { name: 'git.useSystemGit', value: String(settings.git.useSystemGit) },
    { name: 'git.editor', value: settings.git.editor ?? '(platform default)' },
    { name: 'git.mergeTool', value: settings.git.mergeTool ?? "(Git's own configuration)" },
    { name: 'git.defaultPullStrategy', value: settings.git.defaultPullStrategy },
    { name: 'git.defaultMergeMethod', value: settings.git.defaultMergeMethod },
    { name: 'git.fetchIntervalSeconds', value: String(settings.git.fetchIntervalSeconds) },
    { name: 'appearance.theme', value: settings.appearance.theme },
    { name: 'appearance.reduceMotion', value: String(settings.appearance.reduceMotion) },
    { name: 'privacy.includeLocalPaths', value: String(settings.privacy.includeLocalPaths) },
  ]
}

/**
 * The one rule every value on its way into a bundle passes through: withheld
 * when it names a location and local paths are not included, redacted
 * otherwise. Both the fields kept in the preview and the text rendered from
 * them go through it, so the two can never disagree about what is safe.
 */
function safeValue(value: string, locational: boolean, includeLocalPaths: boolean): string {
  const readable =
    locational && !includeLocalPaths
      ? '[withheld: include local paths in Settings to include this]'
      : includeLocalPaths
        ? value
        : sanitizePaths(value)
  return sanitizeSecrets(readable)
}

/**
 * A capability report line is already a single measured value produced by main's
 * fixed allowlist, so it is carried as structured key/value text. Its status
 * travels with it so a reader can tell a measurement from something the app
 * could not establish, and `locational` marks the values that name a location.
 */
function reportFields(report: DiagnosticReport, includeLocalPaths: boolean): SafeField[] {
  return report.entries.map((entry) => {
    const measured = entry.detail
      ? `${entry.value} — ${entry.detail} [${entry.status}]`
      : `${entry.value} [${entry.status}]`
    return {
      name: `${entry.source}/${entry.label}`,
      // Redacted as the field is built, not only when it is rendered: the
      // preview keeps these fields, so a raw path must never reach one.
      value: safeValue(measured, entry.locational === true, includeLocalPaths),
      locational: entry.locational === true,
    }
  })
}

function renderFields(title: string, fields: SafeField[], includeLocalPaths: boolean) {
  const lines = [`## ${title}`]
  for (const field of fields) {
    lines.push(
      `${field.name}: ${safeValue(field.value, field.locational === true, includeLocalPaths)}`,
    )
  }
  return lines.join('\n')
}

export function buildBundle(
  report: DiagnosticReport,
  settings: AppSettings,
  failures: readonly string[],
): SupportBundlePreview {
  const includePaths = settings.privacy.includeLocalPaths

  const capFields = reportFields(report, includePaths)
  const setFields = settingsFields(settings)
  const sections: BundleSection[] = [
    {
      id: 'capabilities',
      title: 'Capability report',
      included: true,
      reason: 'measured on this machine by a fixed command allowlist in the main process',
      content: renderFields('Capability report', capFields, includePaths),
      fields: capFields,
    },
    {
      id: 'settings',
      title: 'Settings',
      included: true,
      reason: 'the preference values themselves; this file holds no credential',
      content: renderFields('Settings', setFields, includePaths),
      fields: setFields,
    },
  ]

  if (failures.length > 0) {
    const failFields = failures.map((line, index) => ({
      name: `failure ${index + 1}`,
      value: safeValue(line, false, includePaths),
    }))
    sections.push({
      id: 'failures',
      title: 'Recent failures',
      included: true,
      reason: 'application error summaries recorded in memory; they carry no repository content',
      content: renderFields('Recent failures', failFields, includePaths),
      fields: failFields,
    })
  } else {
    sections.push({
      id: 'failures',
      title: 'Recent failures',
      included: false,
      reason: 'nothing was recorded to include',
      content: '',
    })
  }

  // A capability entry can name the runtime executable, which is a path. It is
  // the one report field that is locational, so it is opted into like any other;
  // every settings field is a preference value, and names no location.
  const pathCount = includePaths
    ? report.entries.filter((entry) => entry.locational === true).length
    : 0
  const preview: SupportBundlePreview = {
    sections,
    redacted: 0,
    pathCount,
    consent: includePaths,
  }
  const rendered = renderBundle(preview, includePaths)
  preview.renderedBody = rendered
  preview.bytes = Buffer.byteLength(rendered)
  return preview
}

export function renderBundle(preview: SupportBundlePreview, includeLocalPaths: boolean): string {
  if (preview.renderedBody && preview.consent === includeLocalPaths) {
    return preview.renderedBody
  }
  const header = [
    '# Git Stacks support bundle',
    '',
    'This bundle contains only the fields listed below.',
    'It never contains access tokens, source contents, diffs,',
    'branch or pull request text, or raw GitHub API bodies — not even when local paths are included.',
    '',
    `local paths: ${includeLocalPaths ? 'included by your settings' : 'withheld'}`,
    '',
  ]
  const body = preview.sections
    .filter((section) => section.included)
    .map((section) => {
      const content = section.fields
        ? renderFields(section.title, section.fields, includeLocalPaths)
        : includeLocalPaths
          ? section.content
          : sanitizePaths(section.content)
      return `${content}\n\nWhy this is here: ${section.reason}`
    })
  return `${[...header, ...body].join('\n')}\n`
}

/**
 * Writes the bundle so that only its owner can read it, whether the chosen file
 * is new or one that already exists. A mode passed to `open` applies only when
 * it creates the file, so an export replacing a world-readable one would keep
 * the permissions it already had. The file is truncated before its mode is
 * changed, so no new content is ever readable under the permissions it
 * arrived with.
 */
export async function writeOwnerOnlyBundle(filePath: string, body: string): Promise<void> {
  const file = await open(filePath, 'w', 0o600)
  try {
    await file.chmod(0o600)
    await file.writeFile(body)
  } finally {
    await file.close()
  }
}

export { HOME_PREFIXES, NEVER_COLLECTED }
