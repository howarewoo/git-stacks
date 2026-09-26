import type {
  Branch,
  GitAction,
  PullRequest,
  RecentRepository,
  RepositorySnapshot,
} from '../../../shared/types'
import type { WorkflowRequest } from '../components/workflow-dialog'
import { formatChord, isMacPlatform, type ShortcutId } from './keyboard-shortcuts'
import { resolveStackNavigation, type StackRelation } from './stack-navigation'

export type CommandGroup =
  | 'Commands'
  | 'Stack navigation'
  | 'Views'
  | 'Branches'
  | 'Pull requests'
  | 'Issues'
  | 'Recent repositories'
  | 'Settings'

export type PaletteIntent =
  | {
      kind: 'view'
      view: 'branches' | 'stacks' | 'history' | 'changes' | 'pullRequests' | 'stashes'
    }
  | { kind: 'refresh' }
  | { kind: 'toggleDetails' }
  | { kind: 'openRepo'; path?: string }
  | { kind: 'newBranch' }
  | { kind: 'createPr' }
  | { kind: 'openPrUrl'; url: string }
  | { kind: 'selectBranch'; ref: string }
  | { kind: 'checkoutBranch'; ref: string; name: string }
  | { kind: 'navigateStack'; relation: StackRelation }
  | { kind: 'workflow'; request: WorkflowRequest }
  | { kind: 'deleteBranch' }
  | { kind: 'action'; action: GitAction; label: string }
  | { kind: 'openShortcutsSettings' }

export interface PaletteItem {
  id: string
  label: string
  detail?: string
  group: CommandGroup
  keywords?: string
  shortcutId?: ShortcutId
  shortcutText?: string
  destructive?: boolean
  disabled?: boolean
  disabledReason?: string
  intent: PaletteIntent
}

export interface BuildPaletteContext {
  snapshot: RepositorySnapshot | null
  selectedBranch: Branch | null
  recentRepositories: RecentRepository[]
  isBusy: boolean
  operationActive: boolean
  shortcutMap: Record<ShortcutId, string>
  isMac?: boolean
}
const GROUP_ORDER: readonly CommandGroup[] = [
  'Stack navigation',
  'Commands',
  'Views',
  'Branches',
  'Pull requests',
  'Issues',
  'Recent repositories',
  'Settings',
]

export function groupPaletteItems(
  ranked: readonly PaletteItem[],
  searching: boolean,
): Array<{ group: CommandGroup; entries: Array<{ item: PaletteItem; flatIndex: number }> }> {
  if (searching) {
    const runs: Array<{
      group: CommandGroup
      entries: Array<{ item: PaletteItem; flatIndex: number }>
    }> = []
    ranked.forEach((item, flatIndex) => {
      const current = runs.at(-1)
      if (current?.group === item.group) current.entries.push({ item, flatIndex })
      else runs.push({ group: item.group, entries: [{ item, flatIndex }] })
    })
    return runs
  }
  const map = new Map<CommandGroup, PaletteItem[]>()
  for (const item of ranked) {
    const entries = map.get(item.group)
    if (entries) entries.push(item)
    else map.set(item.group, [item])
  }
  let index = 0
  return [...GROUP_ORDER, ...[...map.keys()].filter((group) => !GROUP_ORDER.includes(group))]
    .filter((group) => map.has(group))
    .map((group) => ({
      group,
      entries: map.get(group)!.map((item) => ({ item, flatIndex: index++ })),
    }))
}

export function buildPaletteItems(context: BuildPaletteContext): PaletteItem[] {
  const {
    snapshot,
    selectedBranch,
    recentRepositories,
    isBusy,
    operationActive,
    shortcutMap,
    isMac = isMacPlatform(),
  } = context

  const items: PaletteItem[] = []

  const shortcutFor = (id: ShortcutId): string | undefined => {
    const chord = shortcutMap[id]
    return chord ? formatChord(chord, isMac) : undefined
  }

  // --- Views ---
  const views: Array<{
    view: 'branches' | 'stacks' | 'history' | 'changes' | 'pullRequests' | 'stashes'
    label: string
    shortcutId: ShortcutId
  }> = [
    { view: 'branches', label: 'Go to Branches', shortcutId: 'view.branches' },
    { view: 'stacks', label: 'Go to Stacks', shortcutId: 'view.stacks' },
    { view: 'history', label: 'Go to History', shortcutId: 'view.history' },
    { view: 'changes', label: 'Go to Working changes', shortcutId: 'view.changes' },
    { view: 'pullRequests', label: 'Go to Pull requests', shortcutId: 'view.pullRequests' },
    { view: 'stashes', label: 'Go to Stashes', shortcutId: 'view.stashes' },
  ]

  for (const v of views) {
    items.push({
      id: `view.${v.view}`,
      label: v.label,
      detail: 'Switch workspace view',
      group: 'Views',
      keywords: `${v.view} navigate switch pane view`,
      shortcutId: v.shortcutId,
      shortcutText: shortcutFor(v.shortcutId),
      disabled: !snapshot,
      disabledReason: !snapshot ? 'Open a repository first' : undefined,
      intent: { kind: 'view', view: v.view },
    })
  }

  // --- Stack navigation commands ---
  const stackRelations: Array<{
    relation: StackRelation
    label: string
    shortcutId: ShortcutId
  }> = [
    { relation: 'parent', label: 'Select parent branch', shortcutId: 'stack.selectParent' },
    { relation: 'child', label: 'Select child branch', shortcutId: 'stack.selectChild' },
    { relation: 'top', label: 'Select stack top', shortcutId: 'stack.selectTop' },
    { relation: 'bottom', label: 'Select stack bottom', shortcutId: 'stack.selectBottom' },
  ]

  for (const sr of stackRelations) {
    const target = snapshot
      ? resolveStackNavigation(selectedBranch, snapshot.branches, sr.relation)
      : null
    items.push({
      id: `stack.${sr.relation}`,
      label: sr.label,
      detail: target ? `Target: ${target.name}` : 'No target in this stack position',
      group: 'Stack navigation',
      keywords: `stack ${sr.relation} navigate branch select`,
      shortcutId: sr.shortcutId,
      shortcutText: shortcutFor(sr.shortcutId),
      disabled: !snapshot || !target,
      disabledReason: !snapshot
        ? 'Open a repository first'
        : !selectedBranch
          ? 'Select a branch first'
          : !target
            ? `No ${sr.relation} branch found for ${selectedBranch.name}`
            : undefined,
      intent: { kind: 'navigateStack', relation: sr.relation },
    })
  }

  // Check out selected branch
  const canCheckoutSelected = Boolean(
    snapshot && selectedBranch && !selectedBranch.current && !isBusy && !operationActive,
  )
  items.push({
    id: 'stack.checkout',
    label: selectedBranch ? `Check out ${selectedBranch.name}` : 'Check out selected branch',
    detail: selectedBranch
      ? selectedBranch.current
        ? 'Already checked out'
        : 'Switch working tree to this branch'
      : 'Select a branch to check out',
    group: 'Stack navigation',
    keywords: 'checkout switch branch working tree',
    shortcutId: 'stack.checkout',
    shortcutText: shortcutFor('stack.checkout'),
    disabled: !canCheckoutSelected,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : !selectedBranch
        ? 'Select a branch first'
        : selectedBranch.current
          ? 'Already the checked-out branch'
          : operationActive
            ? 'A Git or stack operation is already active'
            : isBusy
              ? 'An action is currently running'
              : undefined,
    intent: selectedBranch
      ? { kind: 'checkoutBranch', ref: selectedBranch.ref, name: selectedBranch.name }
      : { kind: 'view', view: 'branches' },
  })

  // Restack stack
  const canRestack = Boolean(
    snapshot &&
    selectedBranch &&
    !selectedBranch.remote &&
    selectedBranch.name !== snapshot.defaultBranch &&
    !isBusy &&
    !operationActive,
  )
  items.push({
    id: 'stack.restack',
    label: selectedBranch ? `Restack ${selectedBranch.name} stack…` : 'Restack stack…',
    detail: 'Preview rebasing this stack onto updated parents locally',
    group: 'Stack navigation',
    keywords: 'restack rebase stack children update sync',
    shortcutId: 'stack.restack',
    shortcutText: shortcutFor('stack.restack'),
    disabled: !canRestack,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : !selectedBranch
        ? 'Select a branch first'
        : selectedBranch.remote
          ? 'Cannot restack remote branches'
          : selectedBranch.name === snapshot.defaultBranch
            ? 'Default branch cannot be restacked'
            : operationActive
              ? 'Operation in progress'
              : isBusy
                ? 'App is busy'
                : undefined,
    intent: selectedBranch
      ? {
          kind: 'workflow',
          request: { kind: 'stack', operation: 'restack', branch: selectedBranch.name },
        }
      : { kind: 'view', view: 'stacks' },
  })

  // Publish / Sync stack
  const canPublish = Boolean(
    snapshot &&
    selectedBranch &&
    !selectedBranch.remote &&
    selectedBranch.name !== snapshot.defaultBranch &&
    snapshot.github.available &&
    !isBusy &&
    !operationActive,
  )
  items.push({
    id: 'stack.publish',
    label: selectedBranch ? `Publish ${selectedBranch.name} stack…` : 'Publish stack…',
    detail: 'Push reviewed stack tips and update pull requests on GitHub',
    group: 'Stack navigation',
    keywords: 'publish submit sync push stack remote github pull request',
    disabled: !canPublish,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : !selectedBranch
        ? 'Select a branch first'
        : !snapshot.github.available
          ? snapshot.github.message || 'GitHub unavailable'
          : selectedBranch.remote
            ? 'Select a local branch to publish'
            : selectedBranch.name === snapshot.defaultBranch
              ? 'Default branch cannot be published as a stack'
              : operationActive
                ? 'Operation in progress'
                : isBusy
                  ? 'App is busy'
                  : undefined,
    intent: selectedBranch
      ? {
          kind: 'workflow',
          request: { kind: 'stack', operation: 'publish', branch: selectedBranch.name },
        }
      : { kind: 'view', view: 'stacks' },
  })

  // Open PR for selected branch
  const selectedPr = selectedBranch?.pr ?? null
  items.push({
    id: 'stack.openPr',
    label: selectedPr ? `Open PR #${selectedPr.number} on GitHub` : 'Create pull request…',
    detail: selectedPr
      ? `"${selectedPr.title}" (${selectedPr.state})`
      : 'Open a pull request from the selected branch',
    group: 'Stack navigation',
    keywords: 'pull request pr github open create review',
    shortcutId: 'stack.openPr',
    shortcutText: shortcutFor('stack.openPr'),
    disabled:
      !snapshot || (!selectedPr && (!selectedBranch?.current || !snapshot.github.available)),
    disabledReason: !snapshot
      ? 'Open a repository first'
      : !selectedPr && !snapshot.github.available
        ? snapshot.github.message || 'GitHub unavailable'
        : !selectedPr && !selectedBranch?.current
          ? 'Switch to this branch to create a pull request'
          : undefined,
    intent: selectedPr ? { kind: 'openPrUrl', url: selectedPr.url } : { kind: 'createPr' },
  })

  if (selectedPr) {
    items.push({
      id: 'stack.managePr',
      label: `Manage pull request #${selectedPr.number}…`,
      detail: 'Review checks, reviews, merge and close options',
      group: 'Stack navigation',
      keywords: 'manage pull request pr review checks merge close',
      disabled: isBusy,
      disabledReason: isBusy ? 'App is busy' : undefined,
      intent: { kind: 'workflow', request: { kind: 'pr', number: selectedPr.number } },
    })
    if (
      selectedBranch &&
      !selectedBranch.remote &&
      selectedBranch.name !== snapshot?.defaultBranch &&
      selectedPr.state === 'OPEN'
    ) {
      items.push({
        id: 'stack.mergePr',
        label: `Preview PR #${selectedPr.number} merge…`,
        detail: 'Review merging the open pull request before confirmation',
        group: 'Stack navigation',
        keywords: 'preview merge pull request pr stack',
        disabled: isBusy || operationActive,
        disabledReason: isBusy
          ? 'App is busy'
          : operationActive
            ? 'Operation in progress'
            : undefined,
        intent: {
          kind: 'workflow',
          request: { kind: 'stack', operation: 'merge', branch: selectedBranch.name },
        },
      })
    }
  }

  if (selectedBranch) {
    const parent = snapshot?.branches.find(
      (branch) => !branch.remote && branch.name === selectedBranch.parent,
    )
    items.push({
      id: 'stack.rebaseCurrent',
      label: 'Rebase current onto parent…',
      detail: 'Rewrite only the checked-out branch after review; descendants are not moved',
      group: 'Stack navigation',
      keywords: 'rebase current branch parent rewrite',
      disabled:
        !selectedBranch.current || !parent || selectedBranch.remote || isBusy || operationActive,
      disabledReason: !selectedBranch.current
        ? 'Switch to this branch before rebasing'
        : selectedBranch.remote
          ? 'Remote branches cannot be rebased directly'
          : !parent
            ? 'No local recorded parent'
            : isBusy
              ? 'App is busy'
              : operationActive
                ? 'Operation in progress'
                : undefined,
      intent: parent
        ? {
            kind: 'workflow',
            request: {
              kind: 'confirm',
              action: { type: 'rebase', parent: parent.name },
              title: 'Rebase current branch?',
              label: 'Rebase onto parent',
              description:
                'This rewrites only the current branch. Use Restack stack to update dependent branches together.',
            },
          }
        : { kind: 'view', view: 'branches' },
    })
  }

  // --- Primary menu / toolbar commands ---
  items.push({
    id: 'command.fetch',
    label: 'Fetch remote updates',
    detail: 'Fetch latest branches and commits without updating working tree',
    shortcutId: 'stack.sync',
    shortcutText: shortcutFor('stack.sync'),
    group: 'Commands',
    keywords: 'fetch sync pull remote download',
    disabled: !snapshot || isBusy || operationActive,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : isBusy
        ? 'App is busy'
        : operationActive
          ? 'Operation in progress'
          : undefined,
    intent: { kind: 'action', action: { type: 'fetch' }, label: 'Fetch' },
  })

  items.push({
    id: 'command.pull',
    label: 'Pull from upstream…',
    detail: 'Choose how to integrate updates from this branch’s upstream',
    group: 'Commands',
    keywords: 'pull integrate merge rebase fast-forward',
    disabled: !snapshot || isBusy || operationActive,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : isBusy
        ? 'App is busy'
        : operationActive
          ? 'Operation in progress'
          : undefined,
    intent: { kind: 'workflow', request: { kind: 'pull' } },
  })

  items.push({
    id: 'command.push',
    label: 'Push current branch',
    detail: 'Push commits without rewriting remote history',
    group: 'Commands',
    keywords: 'push upload remote publish',
    disabled: !snapshot || isBusy || operationActive,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : isBusy
        ? 'App is busy'
        : operationActive
          ? 'Operation in progress'
          : undefined,
    intent: { kind: 'action', action: { type: 'push' }, label: 'Push' },
  })

  items.push({
    id: 'command.newBranch',
    label: 'New branch…',
    detail: 'Create a local branch from an existing branch and record parent',
    group: 'Commands',
    keywords: 'create new branch fork parent stack',
    disabled: !snapshot || isBusy || operationActive,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : isBusy
        ? 'App is busy'
        : operationActive
          ? 'Operation in progress'
          : undefined,
    intent: { kind: 'newBranch' },
  })

  items.push({
    id: 'command.mergeIntoCurrent',
    label: 'Merge into current branch…',
    detail: 'Review and merge another branch into the checked-out branch',
    group: 'Commands',
    keywords: 'merge branch join integrate',
    disabled: !snapshot || isBusy || operationActive || !snapshot.currentBranch,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : !snapshot.currentBranch
        ? 'No branch checked out'
        : isBusy
          ? 'App is busy'
          : operationActive
            ? 'Operation in progress'
            : undefined,
    intent: { kind: 'workflow', request: { kind: 'merge' } },
  })

  items.push({
    id: 'command.forcePush',
    label: 'Force push with lease…',
    detail: 'Push rewritten history safely with lease check',
    group: 'Commands',
    keywords: 'force push lease rewrite remote',
    destructive: true,
    disabled:
      !snapshot ||
      isBusy ||
      operationActive ||
      !snapshot.currentBranch ||
      snapshot.currentBranch === snapshot.defaultBranch,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : !snapshot.currentBranch
        ? 'No branch checked out'
        : snapshot.currentBranch === snapshot.defaultBranch
          ? 'Cannot force push the default branch'
          : isBusy
            ? 'App is busy'
            : operationActive
              ? 'Operation in progress'
              : undefined,
    intent: { kind: 'workflow', request: { kind: 'forcePush' } },
  })

  items.push({
    id: 'command.stash',
    label: 'Stash changes…',
    detail: 'Shelve working changes into a local stash',
    group: 'Commands',
    keywords: 'stash shelve save working uncommitted clean',
    disabled: !snapshot || isBusy || operationActive || snapshot.files.length === 0,
    disabledReason: !snapshot
      ? 'Open a repository first'
      : snapshot.files.length === 0
        ? 'Working tree is already clean'
        : isBusy
          ? 'App is busy'
          : operationActive
            ? 'Operation in progress'
            : undefined,
    intent: { kind: 'workflow', request: { kind: 'stash' } },
  })

  items.push({
    id: 'command.refresh',
    label: 'Refresh repository',
    detail: 'Reload Git status, branches, commits, and pull requests',
    group: 'Commands',
    keywords: 'refresh reload update status sync',
    disabled: !snapshot || isBusy,
    disabledReason: !snapshot ? 'Open a repository first' : isBusy ? 'App is busy' : undefined,
    intent: { kind: 'refresh' },
  })

  items.push({
    id: 'command.toggleDetails',
    label: 'Toggle details pane',
    detail: 'Show or hide the branch inspector sidebar',
    group: 'Commands',
    keywords: 'toggle details inspector pane sidebar view',
    disabled: !snapshot,
    disabledReason: !snapshot ? 'Open a repository first' : undefined,
    intent: { kind: 'toggleDetails' },
  })

  // Branch details actions
  if (selectedBranch) {
    if (!selectedBranch.remote) {
      items.push({
        id: 'command.setStackParent',
        label: `Set parent for ${selectedBranch.name}…`,
        detail: 'Record a different local parent without rewriting commits',
        group: 'Commands',
        keywords: 'parent stack retarget change record',
        disabled: isBusy || operationActive,
        disabledReason: isBusy
          ? 'App is busy'
          : operationActive
            ? 'Operation in progress'
            : undefined,
        intent: { kind: 'workflow', request: { kind: 'parent', branch: selectedBranch } },
      })

      items.push({
        id: 'command.renameBranch',
        label: `Rename ${selectedBranch.name}…`,
        detail: 'Rename this local branch',
        group: 'Commands',
        keywords: 'rename branch name',
        disabled: isBusy || operationActive || selectedBranch.name === snapshot?.defaultBranch,
        disabledReason:
          selectedBranch.name === snapshot?.defaultBranch
            ? 'Cannot rename default branch'
            : isBusy
              ? 'App is busy'
              : operationActive
                ? 'Operation in progress'
                : undefined,
        intent: { kind: 'workflow', request: { kind: 'rename', branch: selectedBranch } },
      })

      items.push({
        id: 'command.setUpstream',
        label: `Set upstream for ${selectedBranch.name}…`,
        detail: 'Configure tracking remote branch',
        group: 'Commands',
        keywords: 'upstream remote track configure branch',
        disabled: isBusy || operationActive,
        disabledReason: isBusy
          ? 'App is busy'
          : operationActive
            ? 'Operation in progress'
            : undefined,
        intent: { kind: 'workflow', request: { kind: 'upstream', branch: selectedBranch } },
      })

      const canDelete =
        !selectedBranch.current &&
        selectedBranch.name !== snapshot?.defaultBranch &&
        !isBusy &&
        !operationActive
      items.push({
        id: 'command.deleteBranch',
        label: `Delete ${selectedBranch.name}…`,
        detail: 'Permanently remove this local branch',
        group: 'Commands',
        keywords: 'delete remove branch drop destroy',
        destructive: true,
        disabled: !canDelete,
        disabledReason: selectedBranch.current
          ? 'Cannot delete the checked-out branch'
          : selectedBranch.name === snapshot?.defaultBranch
            ? 'Cannot delete the default branch'
            : isBusy
              ? 'App is busy'
              : operationActive
                ? 'Operation in progress'
                : undefined,
        intent: { kind: 'deleteBranch' },
      })
    } else {
      items.push({
        id: 'command.deleteRemoteBranch',
        label: `Delete remote branch ${selectedBranch.name}…`,
        detail: 'Remove branch from remote repository',
        group: 'Commands',
        keywords: 'delete remove remote branch prune',
        destructive: true,
        disabled:
          isBusy ||
          operationActive ||
          !selectedBranch.oid ||
          selectedBranch.name.endsWith(`/${snapshot?.defaultBranch}`),
        disabledReason: isBusy
          ? 'App is busy'
          : operationActive
            ? 'Operation in progress'
            : !selectedBranch.oid
              ? 'Remote branch identity is unavailable'
              : selectedBranch.name.endsWith(`/${snapshot?.defaultBranch}`)
                ? 'Cannot delete the default branch on its remote'
                : undefined,
        intent: { kind: 'workflow', request: { kind: 'deleteRemote', branch: selectedBranch } },
      })
    }
  }

  // --- Settings ---
  items.push({
    id: 'settings.shortcuts',
    label: 'Keyboard shortcuts…',
    detail: 'View and customize keyboard shortcut bindings with conflict detection',
    group: 'Settings',
    keywords: 'keyboard shortcuts keybindings hotkeys remap config preferences settings',
    intent: { kind: 'openShortcutsSettings' },
  })

  // --- Entities: Branches ---
  if (snapshot) {
    for (const b of snapshot.branches) {
      items.push({
        id: `branch.${b.ref}`,
        label: b.name,
        detail: b.current
          ? 'Current branch'
          : b.remote
            ? 'Remote branch'
            : b.upstream
              ? `Tracking ${b.upstream}`
              : 'Local branch',
        group: 'Branches',
        keywords: `${b.name} ${b.subject || ''} ${b.remote ? 'remote' : 'local'} ${b.current ? 'current' : ''}`,
        intent: { kind: 'selectBranch', ref: b.ref },
      })
    }
  }

  // --- Entities: Pull Requests ---
  if (snapshot && snapshot.pullRequests) {
    for (const pr of snapshot.pullRequests) {
      items.push({
        id: `pr.${pr.number}`,
        label: `#${pr.number} ${pr.title}`,
        detail: `${pr.head} → ${pr.base} (${pr.state.toLowerCase()})`,
        group: 'Pull requests',
        keywords: `#${pr.number} ${pr.title} ${pr.head} ${pr.base} ${pr.state}`,
        intent: { kind: 'openPrUrl', url: pr.url },
      })
      items.push({
        id: `pr.manage.${pr.number}`,
        label: `Manage PR #${pr.number}…`,
        detail: `${pr.title} (${pr.state.toLowerCase()})`,
        group: 'Pull requests',
        keywords: `manage pull request #${pr.number} ${pr.title} review checks merge close`,
        disabled: isBusy,
        disabledReason: isBusy ? 'App is busy' : undefined,
        intent: { kind: 'workflow', request: { kind: 'pr', number: pr.number } },
      })
    }
  }
  // --- Entities: Issues ---
  if (snapshot) {
    for (const issue of snapshot.issues ?? []) {
      items.push({
        id: `issue.${issue.number}`,
        label: `Issue #${issue.number} ${issue.title}`,
        detail: 'Open issue on GitHub',
        group: 'Issues',
        keywords: `#${issue.number} ${issue.title} issue github`,
        intent: { kind: 'openPrUrl', url: issue.url },
      })
    }
    if (snapshot.issuesMessage) {
      items.push({
        id: 'issues.unavailable',
        label: 'GitHub issues unavailable',
        detail: snapshot.issuesMessage,
        group: 'Issues',
        disabled: true,
        disabledReason: snapshot.issuesMessage,
        intent: { kind: 'view', view: 'pullRequests' },
      })
    }
  }

  // --- Entities: Recent repositories ---
  for (const repo of recentRepositories) {
    items.push({
      id: `repo.${repo.path}`,
      label: repo.name,
      detail: repo.path,
      group: 'Recent repositories',
      keywords: `${repo.name} ${repo.path} repository repo open`,
      intent: { kind: 'openRepo', path: repo.path },
    })
  }

  // Open repository (generic)
  items.push({
    id: 'repo.open',
    label: 'Open repository…',
    detail: 'Choose a local Git repository on disk',
    group: 'Commands',
    keywords: 'open repository folder directory local project',
    disabled: isBusy,
    disabledReason: isBusy ? 'App is busy' : undefined,
    intent: { kind: 'openRepo' },
  })

  return items
}

/**
 * Score an item against a query. Returns a number >= 0. Higher is better.
 * Zero means no match.
 */
export function scorePaletteItem(item: PaletteItem, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1

  const label = item.label.toLowerCase()
  const detail = (item.detail || '').toLowerCase()
  const keywords = (item.keywords || '').toLowerCase()
  const group = item.group.toLowerCase()

  // Exact match
  if (label === q) return 1000

  // Prefix match on label
  if (label.startsWith(q)) return 500 + (100 - Math.min(100, label.length))

  // Word boundary match in label
  const words = label.split(/[\s/_-]+/)
  if (words.some((w) => w.startsWith(q))) return 300

  // Substring match in label
  const labelIndex = label.indexOf(q)
  if (labelIndex !== -1) {
    return 200 - Math.min(50, labelIndex)
  }

  // Match in detail
  if (detail.includes(q)) return 100

  // Match in keywords
  if (keywords.includes(q)) return 80

  // Match in group
  if (group.includes(q)) return 40

  // Subsequence match in label
  let queryIndex = 0
  let consecutive = 0
  let maxConsecutive = 0
  for (let i = 0; i < label.length && queryIndex < q.length; i += 1) {
    if (label[i] === q[queryIndex]) {
      queryIndex += 1
      consecutive += 1
      if (consecutive > maxConsecutive) maxConsecutive = consecutive
    } else {
      consecutive = 0
    }
  }
  if (queryIndex === q.length) {
    return 20 + maxConsecutive * 5
  }

  return 0
}

/**
 * Filters and ranks palette items by search query.
 */
export function rankPaletteItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim()
  if (!q) return [...items]

  const scored: Array<{ item: PaletteItem; score: number; index: number }> = []

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const score = scorePaletteItem(item, q)
    if (score > 0) {
      scored.push({ item, score, index })
    }
  }

  scored.sort((a, b) => {
    // Enabled items sort before disabled ones
    if (!a.item.disabled && b.item.disabled) return -1
    if (a.item.disabled && !b.item.disabled) return 1
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index
  })

  return scored.map((s) => s.item)
}

export interface FocusableTargetLike {
  focus: () => void
  isConnected?: boolean
  disabled?: boolean
}

/**
 * Focus restoration helper: resolves which target should be focused upon dialog close.
 * Prefers the opener if still connected and enabled; otherwise falls back to the search field.
 */
export function resolveFocusRestoreTarget(
  opener: FocusableTargetLike | null | undefined,
  fallback: FocusableTargetLike | null | undefined,
): FocusableTargetLike | null {
  if (opener) {
    const connected = opener.isConnected !== false
    const enabled = !opener.disabled
    if (connected && enabled) {
      return opener
    }
  }
  if (fallback) {
    const connected = fallback.isConnected !== false
    const enabled = !fallback.disabled
    if (connected && enabled) {
      return fallback
    }
  }
  return null
}
