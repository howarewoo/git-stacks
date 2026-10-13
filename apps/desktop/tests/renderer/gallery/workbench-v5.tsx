import { useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@git-stacks/ui'
import { BranchWorkbench } from '../../../src/renderer/src/components/branch-workbench'
import type {
  WorkbenchAction,
  WorkbenchActionContext,
  WorkbenchCapabilities,
} from '../../../src/renderer/src/components/branch-workbench-model'
import { V5_REGISTRY_ID, V5_REPOSITORY_ID, workbenchV5Fixture } from '../fixtures/workbench-v5'

const capabilities: WorkbenchCapabilities = Object.fromEntries(
  [
    'discover',
    'create-worktree',
    'review',
    'history',
    'restack',
    'sync',
    'publish',
    'merge',
    'open-directory',
    'pull-requests',
    'attention',
    'activity',
    'search',
    'settings',
  ].map((action) => [action, {}]),
)

export function WorkbenchV5Gallery() {
  const degraded = new URLSearchParams(location.search).get('workbench') === 'degraded'
  const [snapshot] = useState(() => workbenchV5Fixture(degraded))
  const [repositoryId, setRepositoryId] = useState(V5_REPOSITORY_ID)
  const [selectedId, setSelectedId] = useState<string | null>(V5_REGISTRY_ID)
  const [intent, setIntent] = useState<{
    action: WorkbenchAction
    context: WorkbenchActionContext
  } | null>(null)
  const [selectionMemory] = useState<Record<string, string | null>>({})
  return (
    <>
      <BranchWorkbench
        snapshot={snapshot}
        repositoryId={repositoryId}
        selectedBranchId={selectedId}
        capabilities={capabilities}
        onRepositoryChange={(id) => {
          selectionMemory[repositoryId] = selectedId
          setRepositoryId(id)
          setSelectedId(
            selectionMemory[id] ??
              snapshot.branches.find((branch) => branch.repositoryId === id && !branch.trunk)?.id ??
              null,
          )
        }}
        onSelectionChange={setSelectedId}
        onAction={(action, context) => setIntent({ action, context })}
      />
      <Dialog
        open={intent !== null}
        onOpenChange={(open) => {
          if (!open) setIntent(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Requested intent: {intent?.action}</DialogTitle>
            <DialogDescription>
              Test-only dispatch observer. No Git, filesystem or GitHub operation ran; this is not a
              successful operation result.
            </DialogDescription>
          </DialogHeader>
          <pre className="text-xs whitespace-pre-wrap break-all">
            {JSON.stringify(intent?.context, null, 2)}
          </pre>
          <Button variant="secondary" onClick={() => setIntent(null)}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
