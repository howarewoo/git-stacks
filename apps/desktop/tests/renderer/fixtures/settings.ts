import type { GitHubHostStatus } from '@git-stacks/shared/host'
import type { SettingsTools, SupportBundlePreview } from '@git-stacks/shared/settings'

/**
 * Settings-surface data for the gallery, in the shapes the main process sends.
 * Nothing here is a credential, a token, or a path on a real computer: the
 * support bundle is synthetic, and the paths in it are the fixture's own.
 */

/** What github.com answered when it was probed with a CLI session behind it. */
export const githubComHostStatus: GitHubHostStatus = {
  host: 'github.com',
  kind: 'github.com',
  webOrigin: 'https://github.com',
  apiBase: 'https://api.github.com',
  graphqlUrl: 'https://api.github.com/graphql',
  apiVersion: '2026-03-10',
  stacksApiVersion: '2026-03-10',
  serverVersion: null,
  state: 'supported',
  message: 'github.com answered the capability probe.',
  probedAt: '2026-09-25T11:58:00.000Z',
  capabilities: [
    { id: 'rest', label: 'REST API', state: 'supported', detail: 'GET /rate_limit answered.' },
    { id: 'graphql', label: 'GraphQL API', state: 'supported', detail: 'viewer query answered.' },
    {
      id: 'native-stacks',
      label: 'Native stacked pull requests',
      state: 'supported',
      detail: 'The stacks resource listed the repository.',
    },
    {
      id: 'repository-discovery',
      label: 'Repository discovery',
      state: 'supported',
      detail: 'The accessible repository search answered.',
    },
    {
      id: 'cli-authentication',
      label: 'GitHub CLI authentication',
      state: 'supported',
      detail: 'gh reported an account for github.com.',
    },
  ],
}

/** Both configured tools exist on this machine. */
export const toolsAvailable: SettingsTools = {
  editor: { available: true, label: 'zed' },
  mergeTool: { available: true, label: 'meld' },
}

/** The configured editor is not installed here, which is reported where it is typed. */
export const toolsMissingEditor: SettingsTools = {
  editor: { available: false, label: 'zed' },
  mergeTool: { available: true, label: 'meld' },
}

/**
 * The preview main builds. With paths withheld the Git executable section says
 * so; opting in adds only that one path. Source, diffs, branch names, and pull
 * request text are never sections.
 */
export function supportBundleFixture(includeLocalPaths: boolean): SupportBundlePreview {
  return {
    id: includeLocalPaths ? 'bundle-with-paths' : 'bundle-redacted',
    sections: [
      {
        id: 'app',
        title: 'Application',
        included: true,
        reason: 'Version and platform only.',
        content: 'Git Stacks 0.1.0\ndarwin 24.3.0 (arm64)',
      },
      {
        id: 'git',
        title: 'Git runtime',
        included: true,
        reason: includeLocalPaths
          ? 'Version, capabilities, and the Git executable path you opted in to.'
          : 'Version and capabilities. The Git executable path is withheld.',
        content: includeLocalPaths
          ? 'bundled Git 2.51.0\nexecutable: /fixture/git/bin/git'
          : 'bundled Git 2.51.0\nexecutable: [path withheld]',
      },
      {
        id: 'github',
        title: 'GitHub CLI and host',
        included: true,
        reason: 'Detection and host capability labels. No token or account name.',
        content: 'gh 2.62.0 detected\nhost github.com: REST, GraphQL, native stacks supported',
      },
      {
        id: 'repositories',
        title: 'Repository contents',
        included: false,
        reason: 'Source, diffs, branch names, and pull request text are never exported.',
        content: '',
      },
    ],
    redacted: includeLocalPaths ? 0 : 1,
    pathCount: includeLocalPaths ? 1 : 0,
    bytes: 412,
    consent: includeLocalPaths,
  }
}
