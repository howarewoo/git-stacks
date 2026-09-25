import * as React from 'react'
import { FolderGit2, Search } from 'lucide-react'
import { BranchInspector } from '../components/branch-inspector'
import { BranchTree } from '../components/branch-workspace'
import { StackView } from '../components/repository-views'
import { Input } from '../components/ui/input'
import { SegmentedControl } from '../components/ui/segmented-control'
import { cn } from '../lib/utils'
import {
  branchFilterOptions,
  getBranchWorkspace,
  resolveSelectedBranch,
  type BranchFilter,
} from '../lib/branch-workspace'
import { branchFixtureRefs, branchFixtureSnapshot } from './branch-fixtures'

type SpecimenView = 'branches' | 'stacks'

/**
 * Real-renderer fixture for the branch tree, stack workspace, and branch inspector.
 * It runs the production components against deterministic fixtures, so selection,
 * filtering, stack-root changes, and inspector state are observable without a
 * repository, IPC, or a network connection.
 */
export function BranchWorkspaceSpecimen() {
  const snapshot = branchFixtureSnapshot
  const [view, setView] = React.useState<SpecimenView>('branches')
  const [filter, setFilter] = React.useState<BranchFilter>('all')
  const [search, setSearch] = React.useState('')
  const [selectedBranchRef, setSelectedBranchRef] = React.useState<string | null>(
    branchFixtureRefs.linearChild,
  )
  const [detailsOpen, setDetailsOpen] = React.useState(true)
  const [lastRequest, setLastRequest] = React.useState('none')

  const workspace = React.useMemo(
    () => getBranchWorkspace(snapshot.branches, filter, search),
    [filter, search],
  )
  const selectedBranch = resolveSelectedBranch(snapshot.branches, selectedBranchRef, filter)
  const inspectorVisible = detailsOpen && Boolean(selectedBranch)
  const note = (value: string) => setLastRequest(value)

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="traffic-lights" aria-hidden="true" />
        <div className="titlebar-brand">
          <span className="titlebar-mark">
            <FolderGit2 aria-hidden="true" className="size-4" />
          </span>
          <span>Git Stacks</span>
        </div>
        <div className="titlebar-context" tabIndex={0} title={snapshot.path}>
          {snapshot.name}
        </div>
        <div className="titlebar-spacer" />
        <span className="titlebar-build">Branch workspace specimen</span>
      </header>

      <div className="toolbar" role="toolbar" aria-label="Specimen actions">
        <div className="toolbar-actions">
          <SegmentedControl<SpecimenView>
            label="Specimen surface"
            value={view}
            onValueChange={setView}
            options={[
              { value: 'branches', label: 'Branch tree' },
              { value: 'stacks', label: 'Stack workspace' },
            ]}
          />
        </div>
        <div className="toolbar-spacer" />
        <div className="toolbar-search">
          <Search aria-hidden="true" className="size-4" />
          <Input
            aria-label="Search branches"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search branches"
            value={search}
          />
        </div>
        <button
          aria-controls="branch-inspector"
          aria-expanded={inspectorVisible}
          className="gs-button toolbar-control"
          onClick={() => setDetailsOpen((value) => !value)}
          type="button"
        >
          {detailsOpen ? 'Hide inspector' : 'Show inspector'}
        </button>
      </div>

      <div
        className={cn('workspace', !inspectorVisible && 'workspace-details-hidden')}
        style={
          {
            '--gs-shell-sidebar-width': '210px',
            '--gs-shell-inspector-width': '320px',
          } as React.CSSProperties
        }
      >
        <aside className="sidebar">
          <div className="sidebar-scroll">
            <nav className="workspace-nav" aria-label="Specimen surfaces">
              <button
                aria-current={view === 'branches' ? 'page' : undefined}
                className={cn('nav-item', view === 'branches' && 'nav-item-active')}
                onClick={() => setView('branches')}
                type="button"
              >
                Branches
                <span className="nav-count">{workspace.shown}</span>
              </button>
              <button
                aria-current={view === 'stacks' ? 'page' : undefined}
                className={cn('nav-item', view === 'stacks' && 'nav-item-active')}
                onClick={() => setView('stacks')}
                type="button"
              >
                Stacks
                <span className="nav-count">5</span>
              </button>
            </nav>
            <p className="shell-fixture-content">Last workflow request: {lastRequest}</p>
          </div>
        </aside>

        <main className="main-pane">
          {view === 'stacks' ? (
            <StackView
              busy={false}
              onCreate={() => note('new-branch')}
              onRequest={(request) => note(JSON.stringify(request))}
              onSelect={(branch) => setSelectedBranchRef(branch.ref)}
              search={search}
              snapshot={snapshot}
            />
          ) : (
            <div className="branches-view">
              <div className="list-toolbar">
                <div className="list-title-group">
                  <h1>Branches</h1>
                  <span className="list-subtitle">
                    {workspace.shown} of {workspace.total} shown
                  </span>
                </div>
                <SegmentedControl<BranchFilter>
                  label="Branch filters"
                  value={filter}
                  onValueChange={setFilter}
                  options={branchFilterOptions}
                />
              </div>
              <BranchTree
                branches={workspace.visible}
                onOpenPullRequest={(pullRequest) => note(pullRequest.url)}
                onSelect={setSelectedBranchRef}
                rows={workspace.rows}
                selectedRef={selectedBranch?.ref ?? null}
              />
            </div>
          )}
        </main>

        {inspectorVisible && selectedBranch ? (
          <BranchInspector
            branch={selectedBranch}
            busy={false}
            defaultBranch={snapshot.defaultBranch}
            github={snapshot.github}
            onClose={() => setSelectedBranchRef(null)}
            onCreatePullRequest={() => note('create-pr')}
            onDeleteLocal={() => note('delete-local')}
            onDeleteRemote={() => note('delete-remote')}
            onManagePullRequest={() => note('manage-pr')}
            onOpenExternal={(url) => note(url)}
            onPreviewMerge={() => note('preview-merge')}
            onPublish={() => note(`publish:${selectedBranch.name}`)}
            onRebaseOntoParent={() => note(`rebase:${selectedBranch.name}`)}
            onRename={() => note('rename')}
            onRestack={() => note(`restack:${selectedBranch.name}`)}
            onSetParent={() => note('set-parent')}
            onSetUpstream={() => note('set-upstream')}
            onSwitch={() => note(`switch:${selectedBranch.name}`)}
            operationActive={false}
            parent={
              selectedBranch.parent ? (workspace.byName.get(selectedBranch.parent) ?? null) : null
            }
            pullRequest={selectedBranch.pr}
          />
        ) : null}
      </div>
    </div>
  )
}
