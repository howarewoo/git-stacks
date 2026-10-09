import * as React from 'react'
import { Badge } from './ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { SegmentedControl } from './ui/segmented-control'
import { InlineAlert } from './ui/surface'
import { OperationFacts, WorkflowSection, type ContextFact } from './workflow-composition'
import type { GitCapability, GitRuntimeStatus } from '@git-stacks/shared/types'

const CAPABILITY_LABELS: Record<GitCapability, string> = {
  referenceTransactions: 'Ref transactions',
  rebaseUpdateRefs: 'Rebase update-refs',
}

function runtimeFacts(status: GitRuntimeStatus): ContextFact[] {
  const runtime = status.runtime
  if (!runtime) {
    return [{ label: 'Runtime', value: 'Unavailable', code: true }]
  }
  const facts: ContextFact[] = [
    { label: 'Source', value: runtime.source === 'bundled' ? 'Bundled runtime' : 'System Git' },
    { label: 'Version', value: runtime.versionOutput, code: true },
    { label: 'Executable', value: runtime.executable, code: true },
    { label: 'Platform', value: runtime.platform, code: true },
    { label: 'Minimum required', value: runtime.minimumVersion, code: true },
    {
      label: 'Minimum met',
      value: runtime.meetsMinimum ? 'Yes' : 'No — guarded operations are blocked',
    },
  ]
  if (runtime.bundled) {
    facts.push(
      { label: 'Runtime source', value: runtime.bundled.source, code: true },
      {
        label: 'Release digest',
        value: runtime.bundled.sha256
          ? `${runtime.bundled.sha256.slice(0, 16)}…`
          : 'Not recorded (development runtime)',
        code: true,
      },
    )
  }
  return facts
}

/**
 * Diagnostics for the single Git runtime every operation runs through, and the
 * explicit, reversible switch back to a Git installed on this computer.
 */
export function GitRuntimeDialog({
  busy,
  onOpenChange,
  onSelectSystemGit,
  open,
  status,
}: {
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSelectSystemGit: (useSystemGit: boolean) => void
  open: boolean
  status: GitRuntimeStatus | null
}) {
  const runtime = status?.runtime ?? null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workflow-dialog" aria-label="Git runtime diagnostics">
        <DialogHeader>
          <DialogTitle>Git runtime</DialogTitle>
          <DialogDescription>
            Every branch, ref, and pull request action uses the selected Git runtime below. The
            bundled runtime ships inside this release and is never downloaded at runtime.
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-form">
          {status?.error ? (
            <InlineAlert tone="error" role="alert">
              {status.error}
            </InlineAlert>
          ) : null}
          {!status ? (
            <InlineAlert tone="info" role="status">
              Reading the Git runtime…
            </InlineAlert>
          ) : null}
          <WorkflowSection label="Runtime">
            <OperationFacts
              facts={runtimeFacts(
                status ?? {
                  runtime: null,
                  error: null,
                  minimumVersion: 'Unknown',
                  useSystemGit: false,
                },
              )}
            />
          </WorkflowSection>
          {runtime ? (
            <WorkflowSection label="Capabilities">
              <div className="flex flex-wrap gap-2">
                {(Object.keys(CAPABILITY_LABELS) as GitCapability[]).map((capability) => (
                  <Badge
                    key={capability}
                    variant={runtime.capabilities[capability] ? 'success' : 'warning'}
                  >
                    {CAPABILITY_LABELS[capability]}:{' '}
                    {runtime.capabilities[capability] ? 'yes' : 'no'}
                  </Badge>
                ))}
              </div>
            </WorkflowSection>
          ) : null}
          <WorkflowSection label="Git executable">
            <SegmentedControl
              disabled={busy || !status}
              label="Git executable"
              onValueChange={(value) => onSelectSystemGit(value === 'system')}
              options={[
                { value: 'bundled', label: 'Bundled runtime' },
                { value: 'system', label: 'System Git' },
              ]}
              value={status?.useSystemGit ? 'system' : 'bundled'}
            />
            <p className="m-0 text-xs text-[var(--gs-semantic-text-secondary)]">
              This choice is stored with your preferences and applies to every repository. Choose
              Bundled runtime to return to the runtime shipped with Git Stacks.
            </p>
          </WorkflowSection>
          {runtime?.preservedEnvironment.length ? (
            <WorkflowSection label="Preserved environment">
              <OperationFacts
                facts={runtime.preservedEnvironment.map((key) => ({
                  label: key,
                  value: 'passed through',
                  code: true,
                }))}
              />
            </WorkflowSection>
          ) : null}
          {runtime?.preservedConfiguration.length ? (
            <WorkflowSection label="Preserved configuration">
              <OperationFacts
                facts={runtime.preservedConfiguration.map((key) => ({
                  label: key,
                  value: 'never overridden',
                  code: true,
                }))}
              />
            </WorkflowSection>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
