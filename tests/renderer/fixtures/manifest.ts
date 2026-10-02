/**
 * Scenario ids and gallery routes, kept DOM-free so Playwright specs can import them.
 * The authoritative scenario data lives in `scenarios.ts`; the `Record<ScenarioName, …>`
 * annotation there makes a missing or extra id a type error.
 */

export const GALLERY_ROUTES = {
  /** Real production `App`. */
  app: '#/app',
  /** Human-browsable index of every scenario and route. */
  index: '#/index',
  /** Foundations specimen (legacy id kept for the existing Electron smoke script). */
  controls: '#/design-system-controls',
  /** Foundations specimen under its original id. */
  foundations: '#/design-system-specimen',
  shell: '#/design-system-shell-specimen',
  data: '#/design-system-data-specimen',
  dialog: '#/design-system-dialog-specimen',
} as const

export type GalleryRouteId = keyof typeof GALLERY_ROUTES

export const SCENARIO_NAMES = [
  // Shell
  'shell-no-repository',
  'shell-loading',
  'shell-connected',
  'shell-long-content',
  'shell-offline',
  // Ancestry
  'ancestry-linear',
  'ancestry-branching',
  'ancestry-deep',
  'ancestry-remote-consolidated',
  'ancestry-missing-parent',
  'ancestry-cycle',
  'ancestry-requires-restack',
  'branches-deep-chain',
  // Working changes
  'files-clean',
  'files-staged',
  'files-unstaged',
  'files-renamed',
  'files-untracked',
  'files-conflicts',
  'files-truncated',
  'files-long-content',
  // History
  'history-loading',
  'history-error',
  // Pull requests
  'pull-requests-lifecycle',
  'pull-requests-checks',
  'pull-requests-checks-detail',
  'pull-requests-checks-stale',
  'pull-requests-empty',
  'pull-requests-unavailable',
  'pull-requests-issue-links',
  'pull-requests-merge-refused',
  // Stashes
  'stash-stable-oid',
  'stash-empty',
  'stash-index-shift',
  // PR Inbox
  'pr-inbox-queue',
  'pr-inbox-no-repository',
  'pr-inbox-empty',
  'pr-inbox-partial',
  'pr-inbox-unavailable',
  'pr-inbox-retired',
  'pr-inbox-first-read',
  'pr-inbox-membership-unknown',
  'pr-inbox-host-switch',
  // Review
  'review-force-pushed',
  'review-stacked',
  'review-unstacked',
  'review-read-only',
  'review-own-pull-request',
  // Workflows and recovery
  'workflow-preview-ready',
  'workflow-preview-loading',
  'workflow-preview-blocked',
  'workflow-preview-stale',
  'workflow-action-error',
  'workflow-partial-restack',
  'workflow-conflict-recovery',
  'workflow-operation-recovery',
  'workflow-external-operation',
] as const

export type ScenarioName = (typeof SCENARIO_NAMES)[number]

/** Scenario used when `?scenario=` is missing or unknown. */
export const DEFAULT_SCENARIO: ScenarioName = 'shell-connected'

/**
 * Coarse coverage groups. Issue #9's fixture matrix maps onto the fine-grained
 * `SCENARIO_NAMES`; these groups let a spec sweep a whole area without duplicating ids.
 */
export const SCENARIO_GROUPS = {
  shell: [
    'shell-no-repository',
    'shell-loading',
    'shell-connected',
    'shell-long-content',
    'shell-offline',
  ],
  ancestry: [
    'ancestry-linear',
    'ancestry-branching',
    'ancestry-deep',
    'ancestry-remote-consolidated',
    'ancestry-missing-parent',
    'ancestry-cycle',
    'ancestry-requires-restack',
    'branches-deep-chain',
  ],
  changes: [
    'files-clean',
    'files-staged',
    'files-unstaged',
    'files-renamed',
    'files-untracked',
    'files-conflicts',
    'files-truncated',
    'files-long-content',
  ],
  history: ['history-loading', 'history-error'],
  pullRequests: [
    'pull-requests-lifecycle',
    'pull-requests-checks',
    'pull-requests-checks-detail',
    'pull-requests-checks-stale',
    'pull-requests-empty',
    'pull-requests-unavailable',
    'pull-requests-issue-links',
    'pull-requests-merge-refused',
  ],
  inbox: [
    'pr-inbox-queue',
    'pr-inbox-no-repository',
    'pr-inbox-empty',
    'pr-inbox-partial',
    'pr-inbox-unavailable',
    'pr-inbox-membership-unknown',
    'pr-inbox-retired',
    'pr-inbox-first-read',
  ],
  stashes: ['stash-stable-oid', 'stash-empty', 'stash-index-shift'],
  workflows: [
    'workflow-preview-ready',
    'workflow-preview-loading',
    'workflow-preview-blocked',
    'workflow-preview-stale',
    'workflow-action-error',
    'workflow-partial-restack',
    'workflow-conflict-recovery',
    'workflow-operation-recovery',
    'workflow-external-operation',
  ],
} as const satisfies Record<string, readonly ScenarioName[]>

export type ScenarioGroupId = keyof typeof SCENARIO_GROUPS
