import * as React from 'react'
import { SegmentedControl } from '../components/ui/segmented-control'
import { Button } from '../components/ui/button'
import {
  ChangesView,
  PullRequestListView,
  StashesView,
  changeGroups,
  matchesPullRequest,
} from '../components/data-views'
import { HistoryView } from '../components/repository-views'
import type { GitAction, RepositorySnapshot } from '../../../shared/types'
import type { WorkflowRequest } from '../components/workflow-dialog'
import { changesSnapshots, pullRequestSnapshots, stashSnapshots } from './data-fixtures'
import { RepositoryHoverCardProvider } from '../components/repository-hover-cards'
import { TooltipProvider } from '../components/ui/tooltip'
import { Input } from '../components/ui/input'

type Dispatch = { label: string; payload: unknown }

const scenarioOptions = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'clean', label: 'Clean' },
  { value: 'stagedOnly', label: 'Staged only' },
  { value: 'unstagedOnly', label: 'Unstaged only' },
  { value: 'conflicted', label: 'Conflicted' },
] as const

const pullRequestOptions = [
  { value: 'available', label: 'Populated' },
  { value: 'empty', label: 'Genuinely empty' },
  { value: 'unavailable', label: 'GitHub unavailable' },
] as const

export function DataSurfacesSpecimen() {
  const [view, setView] = React.useState<'changes' | 'history' | 'prs' | 'stashes'>('changes')
  const [scenario, setScenario] = React.useState<(typeof scenarioOptions)[number]['value']>('mixed')
  const [pullRequestScenario, setPullRequestScenario] =
    React.useState<(typeof pullRequestOptions)[number]['value']>('available')
  const [stashScenario, setStashScenario] = React.useState<'present' | 'empty'>('present')
  const [search, setSearch] = React.useState('')
  const [commitMessage, setCommitMessage] = React.useState('')
  const [commitAmend, setCommitAmend] = React.useState(false)
  const [inspectedPath, setInspectedPath] = React.useState<string | null>(null)
  const [dispatches, setDispatches] = React.useState<Dispatch[]>([])

  const record = React.useCallback((label: string, payload: unknown) => {
    setDispatches((previous) => [{ label, payload }, ...previous].slice(0, 6))
  }, [])
  const runAction = React.useCallback(
    async (action: GitAction, label: string) => {
      record(label, action)
      return true
    },
    [record],
  )
  const openWorkflow = React.useCallback(
    (request: WorkflowRequest) => record(`workflow:${request.kind}`, request),
    [record],
  )

  const changesSnapshot = changesSnapshots[scenario]
  const pullRequestSnapshot = pullRequestSnapshots[pullRequestScenario]
  const stashSnapshot = stashSnapshots[stashScenario]
  const surfaceSnapshot: RepositorySnapshot =
    view === 'changes'
      ? changesSnapshot
      : view === 'prs'
        ? pullRequestSnapshot
        : view === 'stashes'
          ? stashSnapshot
          : changesSnapshot

  return (
    <TooltipProvider delay={450} timeout={150}>
      <RepositoryHoverCardProvider>
        <div className="specimen-shell">
          <header className="specimen-header">
            <h1>Data surfaces specimen</h1>
            <SegmentedControl
              label="Specimen destination"
              onValueChange={setView}
              options={[
                { value: 'changes', label: 'Working changes' },
                { value: 'history', label: 'History' },
                { value: 'prs', label: 'Pull requests' },
                { value: 'stashes', label: 'Stashes' },
              ]}
              value={view}
            />
            <div className="specimen-controls">
              <label className="specimen-field">
                Search
                <Input
                  unstyled
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter the visible rows"
                />
              </label>
              {view === 'changes' ? (
                <SegmentedControl
                  label="Changes fixture"
                  onValueChange={setScenario}
                  options={[...scenarioOptions]}
                  value={scenario}
                />
              ) : null}
              {view === 'prs' ? (
                <SegmentedControl
                  label="Pull request fixture"
                  onValueChange={setPullRequestScenario}
                  options={[...pullRequestOptions]}
                  value={pullRequestScenario}
                />
              ) : null}
              {view === 'stashes' ? (
                <SegmentedControl
                  label="Stash fixture"
                  onValueChange={setStashScenario}
                  options={[
                    { value: 'present', label: 'With stashes' },
                    { value: 'empty', label: 'No stashes' },
                  ]}
                  value={stashScenario}
                />
              ) : null}
            </div>
          </header>

          <main className="specimen-surface">
            {view === 'changes' ? (
              <ChangesView
                actionError={null}
                busy={false}
                busyAction={null}
                commitAmend={commitAmend}
                commitMessage={commitMessage}
                groups={changeGroups(changesSnapshot.files, search)}
                inspectedPath={inspectedPath}
                onCommitAmendChange={setCommitAmend}
                onCommitMessageChange={setCommitMessage}
                onInspect={setInspectedPath}
                onResolveConflict={() => undefined}
                onStash={() => openWorkflow({ kind: 'stash' })}
                onSubmitCommit={() => {
                  record(commitAmend ? 'Review amend' : 'Commit staged changes', {
                    message: commitMessage,
                    amend: commitAmend,
                  })
                }}
                operationActive={false}
                runAction={runAction}
                snapshot={changesSnapshot}
              />
            ) : null}
            {view === 'history' ? (
              <HistoryView
                busy={false}
                onRequest={openWorkflow}
                search={search}
                snapshot={changesSnapshot}
              />
            ) : null}
            {view === 'prs' ? (
              <PullRequestListView
                busy={false}
                canCreate
                createTooltip="Fixture only: creates a draft pull request from the current branch."
                onCreate={() => record('Create PR', {})}
                onRequest={openWorkflow}
                onReviewNumber={(number) => record('Review PR', { number })}
                pullRequests={pullRequestSnapshot.pullRequests.filter((pr) =>
                  matchesPullRequest(pr, search),
                )}
                snapshot={pullRequestSnapshot}
              />
            ) : null}
            {view === 'stashes' ? (
              <StashesView
                busy={false}
                busyAction={null}
                onRequest={openWorkflow}
                onStash={() => openWorkflow({ kind: 'stash' })}
                operationActive={false}
                runAction={runAction}
                snapshot={stashSnapshot}
              />
            ) : null}
          </main>

          <aside className="specimen-log" aria-label="Recorded dispatches">
            <div className="specimen-log-heading">
              <strong>Recorded dispatches</strong>
              <Button size="sm" variant="ghost" onClick={() => setDispatches([])}>
                Clear
              </Button>
            </div>
            {dispatches.length === 0 ? (
              <p className="specimen-log-empty">
                No action dispatched yet. The fixture records the exact payload each control sends.
              </p>
            ) : (
              <ol>
                {dispatches.map((entry, index) => (
                  <li key={index}>
                    <strong>{entry.label}</strong>
                    <code>{JSON.stringify(entry.payload)}</code>
                  </li>
                ))}
              </ol>
            )}
          </aside>
          <span className="sr-only" data-snapshot={surfaceSnapshot.path} />
        </div>
      </RepositoryHoverCardProvider>
    </TooltipProvider>
  )
}
