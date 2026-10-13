import { useState } from 'react'
import { Button, Surface, SurfaceTitle, SurfaceDescription, InlineAlert } from '@git-stacks/ui'
import { useWorktreeInventory } from '../../../src/renderer/src/lib/worktree-inventory'
import { inventoryWorktreeId } from '../fixtures/inventory'

/** Test-only UI: all displayed facts come through the production query hook. */
export function InventoryConsumer() {
  const [context, setContext] = useState('repository-a')
  const [selected, setSelected] = useState(0)
  const api = window.desktop
  if (!api) throw new Error('Desktop fixture API unavailable')
  const query = useWorktreeInventory(api, context, {
    selectedWorktreeId: inventoryWorktreeId(selected),
    visibleWorktreeIds: [inventoryWorktreeId(0)],
  })
  return (
    <main className="grid gap-4 p-5">
      <Surface aria-label="Inventory consumer">
        <SurfaceTitle>Worktree inventory consumer</SurfaceTitle>
        <SurfaceDescription>
          Deferred DesktopAPI transport fixture. This surface does not prove Electron-native IPC or
          successful Git operations.
        </SurfaceDescription>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => setContext(context === 'repository-a' ? 'repository-b' : 'repository-a')}
          >
            Switch context
          </Button>
          <Button variant="secondary" onClick={() => setSelected(selected === 0 ? 1 : 0)}>
            Select next worktree
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void query.refetch()
            }}
          >
            Refresh inventory
          </Button>
        </div>
        <p data-testid="inventory-context">
          Context: {context}; selected: {selected}
        </p>
        {query.isPending ? <p role="status">Reading inventory…</p> : null}
        <p data-testid="inventory-read-state">{query.fetchStatus}</p>
        {query.error ? <InlineAlert tone="error">{query.error.message}</InlineAlert> : null}
        {query.data ? (
          <>
            <p data-testid="inventory-generation">
              Publication {query.data.generation}: {query.data.state}
            </p>
            {query.data.failures.map((failure) => (
              <InlineAlert tone="error" key={failure.path}>
                {failure.path}: {failure.error}
              </InlineAlert>
            ))}
            {query.data.repositories.map((repository) => (
              <div className="grid gap-3" key={repository.identity.id}>
                <h3>{repository.remote?.fullName ?? 'Local repository'}</h3>
                <p>
                  Discovery: {repository.discovery.state}; refs: {repository.refsRead.state};
                  remote: {repository.remoteFreshness?.state ?? 'unavailable'}
                </p>
                {repository.remoteFreshness?.detail ? (
                  <p>{repository.remoteFreshness.detail}</p>
                ) : null}
                <ul aria-label="Worktrees" className="grid gap-2">
                  {repository.worktrees.map((worktree) => (
                    <li key={worktree.id} data-testid="inventory-worktree">
                      <code>{worktree.path}</code>: {worktree.status}; read: {worktree.read.state};{' '}
                      {worktree.counts
                        ? `${worktree.read.state === 'partial' ? 'Lower bounds' : 'Counts'}: staged ${worktree.counts.staged}, unstaged ${worktree.counts.unstaged}, untracked ${worktree.counts.untracked}, renamed ${worktree.counts.renamed}, conflicted ${worktree.counts.conflicted}`
                        : 'Counts unavailable'}
                      {`; ${worktree.kind}${worktree.detached ? '; Detached HEAD' : ''}${worktree.missing ? '; Missing directory' : ''}${worktree.prunable !== null ? `; Prunable: ${worktree.prunable || 'administrative record'}` : ''}${worktree.locked !== null ? `; Locked: ${worktree.locked || 'administrative lock'}` : ''}`}
                      {worktree.read.error ? `; ${worktree.read.error}` : ''}
                    </li>
                  ))}
                </ul>
                <ul aria-label="Qualified refs" className="grid gap-2">
                  {repository.refs.map((ref) => (
                    <li key={ref.id} data-testid="inventory-ref">
                      <code>{ref.name}</code>: {ref.kind};{' '}
                      {ref.worktreeIds.length
                        ? `${ref.worktreeIds.length} worktree associations`
                        : 'No worktree'}
                      ;{' '}
                      <output aria-label={`Confirmed pull request associations for ${ref.name}`}>
                        {ref.pullRequestIds.length}
                      </output>{' '}
                      known PR associations; ahead {ref.ahead ?? 'unknown'}, behind{' '}
                      {ref.behind ?? 'unknown'}
                    </li>
                  ))}
                </ul>
                <ul aria-label="Pull requests" className="grid gap-2">
                  {repository.pullRequests.map((pr) => (
                    <li key={pr.id}>
                      #{pr.number}: {pr.facts.title};{' '}
                      {pr.refIds.length
                        ? `${pr.refIds.length} qualified ref associations`
                        : 'PR-only: no local branch'}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        ) : null}
      </Surface>
    </main>
  )
}
