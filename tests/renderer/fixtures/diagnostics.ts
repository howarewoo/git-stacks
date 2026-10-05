import type { DiagnosticReport } from '../../../src/shared/settings'

/**
 * The capability report the gallery answers with, in the same shape main builds
 * it. Every line here is one main would produce on a machine like this one, so
 * the Settings surface renders the real component against real data rather than
 * a shortened stand-in.
 *
 * The adapter lines are the point of this fixture: the GitHub CLI is optional in
 * this product, so the report names the configured mode, says which adapter is
 * in use, and reports the CLI's absence as an observation about this computer
 * rather than as a problem to fix. Nothing here names a token, a credential, a
 * source line, or a path — the same exclusions main's report carries.
 */
const entries: DiagnosticReport['entries'] = [
  {
    source: 'host',
    label: 'Operating system',
    value: 'darwin 24.3.0 (arm64)',
    status: 'confirmed',
  },
  {
    source: 'host',
    label: 'Electron',
    value: '33.2.1',
    status: 'confirmed',
  },
  { source: 'app', label: 'Git Stacks', value: '0.1.0', status: 'confirmed' },
  { source: 'app', label: 'Bundled Git selected', value: 'yes', status: 'confirmed' },
  { source: 'runtime', label: 'Git build in use', value: 'bundled Git', status: 'confirmed' },
  { source: 'runtime', label: 'Minimum Git version', value: '2.45.0', status: 'confirmed' },
  {
    source: 'runtime',
    label: 'Runtime platform',
    value: 'darwin (bundled)',
    status: 'confirmed',
  },
  {
    source: 'runtime',
    label: 'Reference transactions',
    value: 'supported',
    status: 'confirmed',
  },
  {
    source: 'runtime',
    label: 'rebase --update-refs',
    value: 'supported',
    status: 'confirmed',
  },
  {
    source: 'credentials',
    label: 'GitHub CLI authentication',
    value: 'authenticated as octo for github.com',
    status: 'confirmed',
  },
  {
    source: 'credentials',
    label: 'GitHub CLI version',
    value: '2.62.0',
    status: 'confirmed',
    detail: 'The version was read on its own; it establishes no account.',
  },
  {
    source: 'credentials',
    label: 'Git HTTPS helper',
    value: 'a helper is configured',
    status: 'confirmed',
    detail: 'helper: osxkeychain',
  },
  { source: 'credentials', label: 'SSH client', value: 'available', status: 'confirmed' },
  {
    source: 'github',
    label: 'GitHub CLI',
    value: 'required',
    status: 'confirmed',
    detail: 'GitHub collaboration reads and writes run through this CLI on this computer.',
  },
  {
    source: 'github',
    label: 'gh --version',
    value: 'gh version 2.62.0',
    status: 'confirmed',
    detail: 'The CLI reported a version; it was asked for nothing else.',
  },
  { source: 'github', label: 'GitHub host', value: 'github.com (github.com)', status: 'confirmed' },
  {
    source: 'github',
    label: 'GitHub REST base',
    value: 'https://api.github.com',
    status: 'confirmed',
  },
  {
    source: 'filesystem',
    label: 'Ref storage backend',
    value: 'files',
    status: 'confirmed',
  },
  { source: 'git', label: 'git --version', value: 'git version 2.46.0', status: 'confirmed' },
  {
    source: 'git',
    label: 'git version --build-options',
    value: 'fsmonitor, pthreads, libcurl, gettext, iconv, pcre2',
    status: 'confirmed',
  },
]

export const diagnosticsReportFixture: DiagnosticReport = {
  entries,
  generatedAt: '2026-09-25T12:00:00.000Z',
  appVersion: '0.1.0',
}
