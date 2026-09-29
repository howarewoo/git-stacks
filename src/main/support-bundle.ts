import type {
  AppSettings,
  BundleSection,
  DiagnosticReport,
  SupportBundlePreview,
} from '../shared/settings'

/**
 * A home directory prefix or a Windows user directory, whichever is present.
 * Only this is masked unconditionally: a path elsewhere on the machine is what
 * the explicit opt-in governs, and masking everything would make the opt-in
 * meaningless.
 */
const HOME_PREFIXES = [process.env.HOME, process.env.USERPROFILE].filter(
  (value): value is string => typeof value === 'string' && value.length > 0,
)

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
 * A capability report line is already a single measured value produced by main's
 * fixed allowlist, so it is carried as structured key/value text. Its status
 * travels with it so a reader can tell a measurement from something the app
 * could not establish, and `locational` marks the values that name a location.
 */
function reportFields(report: DiagnosticReport): SafeField[] {
  return report.entries.map((entry) => ({
    name: `${entry.source}/${entry.label}`,
    value: entry.detail
      ? `${entry.value} — ${entry.detail} [${entry.status}]`
      : `${entry.value} [${entry.status}]`,
    locational: entry.locational === true,
  }))
}

function renderFields(title: string, fields: SafeField[], includeLocalPaths: boolean) {
  const lines = [`## ${title}`]
  for (const field of fields) {
    const value =
      field.locational && !includeLocalPaths
        ? '[withheld: include local paths in Settings to include this]'
        : field.value
    lines.push(`${field.name}: ${value}`)
  }
  return lines.join('\n')
}

export function buildBundle(
  report: DiagnosticReport,
  settings: AppSettings,
  failures: readonly string[],
): SupportBundlePreview {
  const includePaths = settings.privacy.includeLocalPaths

  const sections: BundleSection[] = [
    {
      id: 'capabilities',
      title: 'Capability report',
      included: true,
      reason: 'measured on this machine by a fixed command allowlist in the main process',
      content: renderFields('Capability report', reportFields(report), includePaths),
    },
    {
      id: 'settings',
      title: 'Settings',
      included: true,
      reason: 'the preference values themselves; this file holds no credential',
      content: renderFields('Settings', settingsFields(settings), includePaths),
    },
  ]

  if (failures.length > 0) {
    sections.push({
      id: 'failures',
      title: 'Recent failures',
      included: true,
      reason: 'application error summaries recorded in memory; they carry no repository content',
      content: renderFields(
        'Recent failures',
        // Recorded as scope plus a one-line message. The main process never puts
        // a command, a path, or repository text in this line.
        failures.map((line, index) => ({ name: `failure ${index + 1}`, value: line })),
        includePaths,
      ),
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
  // the one report field that is locational, so it is opted into like any other.
  return {
    sections,
    redacted: 0,
    pathCount: includePaths ? countLocational(report, settings) : 0,
  }
}

function countLocational(report: DiagnosticReport, settings: AppSettings): number {
  let count = settingsFields(settings).filter((field) => field.locational).length
  count += reportFields(report).filter((field) => field.locational).length
  return count
}

export function renderBundle(preview: SupportBundlePreview, includeLocalPaths: boolean): string {
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
    .map((section) => `${section.content}\n\nWhy this is here: ${section.reason}`)
  return `${[...header, ...body].join('\n')}\n`
}

export { HOME_PREFIXES, NEVER_COLLECTED }
