import * as React from 'react'
import {
  ArrowDown,
  Download,
  FolderGit2,
  GitBranch,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { WorkspaceNavigation, type WorkspaceView } from '../components/workspace-navigation'
import { cn } from '../lib/utils'

const fixturePath =
  '/private/tmp/git-stacks-issue-5-fixture/repository-with-a-very-long-name-for-responsive-accessibility'

export function ShellSpecimen() {
  const [activeView, setActiveView] = React.useState<WorkspaceView>('branches')
  const [detailsOpen, setDetailsOpen] = React.useState(true)
  const [query, setQuery] = React.useState('navigation')
  const [draft, setDraft] = React.useState('Keep this draft while the inspector is hidden')
  const inspectorAvailable = activeView === 'branches' || activeView === 'stacks'
  const inspectorVisible = inspectorAvailable && detailsOpen

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="traffic-lights" aria-hidden="true" />
        <div className="titlebar-brand">
          <GitBranch aria-hidden="true" className="size-4" />
          <strong>Git Stacks</strong>
        </div>
        <div className="titlebar-context" title={fixturePath} tabIndex={0}>
          repository-with-a-very-long-name-for-responsive-accessibility
        </div>
        <div className="titlebar-spacer" />
        <span className="titlebar-build">Native Git workspace</span>
      </header>

      <div className="toolbar" role="toolbar" aria-label="Repository actions">
        <div className="toolbar-actions">
          <div className="toolbar-action-group" role="group" aria-label="Synchronization actions">
            <Button size="sm" variant="secondary">
              <Download aria-hidden="true" className="size-3.5" /> Fetch
            </Button>
            <Button size="sm" variant="secondary">
              <ArrowDown aria-hidden="true" className="size-3.5" /> Pull
            </Button>
            <Button size="sm" variant="secondary">
              <Upload aria-hidden="true" className="size-3.5" /> Push
            </Button>
          </div>
          <div className="toolbar-action-group" role="group" aria-label="Branch and Git actions">
            <Button size="sm">
              <Plus aria-hidden="true" className="size-3.5" /> New branch
            </Button>
            <Button aria-label="More Git actions" size="icon-sm" variant="secondary">
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
        <div className="toolbar-spacer" />
        <div className="toolbar-search">
          <Search aria-hidden="true" className="size-3.5" />
          <Input
            aria-keyshortcuts="Meta+K Control+K"
            aria-label="Search branches, files, and pull requests"
            onChange={(event) => setQuery(event.target.value)}
            value={query}
          />
          <kbd>⌘ K</kbd>
        </div>
        <Button
          aria-label="Refresh repository"
          className="toolbar-control"
          size="icon-sm"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
        {inspectorAvailable ? (
          <Button
            aria-controls="shell-fixture-inspector"
            aria-expanded={inspectorVisible}
            aria-label={inspectorVisible ? 'Hide details pane' : 'Show details pane'}
            className="toolbar-control toolbar-details-toggle"
            onClick={() => setDetailsOpen((value) => !value)}
            size="sm"
            variant="secondary"
          >
            {inspectorVisible ? (
              <PanelRightClose aria-hidden="true" className="size-4" />
            ) : (
              <PanelRightOpen aria-hidden="true" className="size-4" />
            )}
            Details
          </Button>
        ) : null}
      </div>

      <div className={cn('workspace', !inspectorVisible && 'workspace-details-hidden')}>
        <aside className="sidebar" aria-label="Repository navigation">
          <div className="sidebar-repository">
            <div className="repo-mark" aria-hidden="true">
              <FolderGit2 className="size-4" />
            </div>
            <div
              aria-label={`Repository repository-with-a-very-long-name-for-responsive-accessibility, ${fixturePath}`}
              className="repo-heading"
              role="group"
              tabIndex={0}
              title={fixturePath}
            >
              <span className="repo-name">
                repository-with-a-very-long-name-for-responsive-accessibility
              </span>
              <span className="repo-path">{fixturePath}</span>
            </div>
          </div>
          <div className="sidebar-scroll">
            <div className="nav-section">
              <WorkspaceNavigation
                activeView={activeView}
                attentionCount={1}
                branchCount={3}
                changeCount={2}
                onSelect={setActiveView}
                pullRequestCount={0}
                stashCount={0}
              />
            </div>
            <div className="nav-section nav-section-separated recent-section">
              <span className="nav-label">Recent repositories</span>
              <Button className="recent-item" type="button" variant="unstyled">
                <FolderGit2 aria-hidden="true" className="size-3.5" />
                <span>
                  <strong>repository-with-a-very-long-name-for-responsive-accessibility</strong>
                  <small title={fixturePath}>{fixturePath}</small>
                </span>
              </Button>
            </div>
          </div>
          <div className="sidebar-footer">
            <div className="connection-state">
              <span className="connection-dot connection-dot-live" />
              <span>Desktop connected</span>
            </div>
            <span className="version-label">Git Stacks</span>
          </div>
        </aside>

        <main className="main-pane">
          <div className="list-toolbar">
            <div className="list-title-group">
              <h1>{activeView === 'branches' ? 'Branches' : activeView}</h1>
              <span className="list-subtitle">3 shown</span>
            </div>
          </div>
          <div className="shell-fixture-content">
            <p className="shell-fixture-caption">Branch matching “{query || 'all'}”</p>
            <Button className="shell-fixture-branch" type="button" variant="unstyled">
              <GitBranch aria-hidden="true" className="size-4" />
              <span>
                <strong>feature/navigation-responsive-layout-with-a-deliberately-long-name</strong>
                <small>Local · selected · main parent</small>
              </span>
            </Button>
            <label htmlFor="shell-fixture-draft">In-progress commit message</label>
            <Input
              id="shell-fixture-draft"
              onChange={(event) => setDraft(event.target.value)}
              value={draft}
            />
          </div>
        </main>

        {inspectorVisible ? (
          <aside
            className="details-pane"
            id="shell-fixture-inspector"
            aria-label="Selected branch details"
          >
            <div className="details-header">
              <div>
                <span className="nav-label">Selected branch</span>
                <h2 title="feature/navigation-responsive-layout-with-a-deliberately-long-name">
                  feature/navigation-responsive-layout-with-a-deliberately-long-name
                </h2>
              </div>
              <Button aria-label="Clear branch selection" size="icon-sm" variant="ghost">
                <PanelRightClose aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <div className="details-scroll">
              <section className="detail-section">
                <h3>Fixture state</h3>
                <p>
                  Search and form values remain mounted while the inspector is hidden and reopened.
                </p>
              </section>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
