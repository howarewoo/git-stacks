import * as React from 'react'
import { Check, ChevronDown, LoaderCircle, MoreHorizontal, RefreshCw } from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { Button, IconButton } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog'
import { DropdownMenu } from '../components/ui/dropdown-menu'
import { Field } from '../components/ui/field'
import { Input } from '../components/ui/input'
import { SegmentedControl } from '../components/ui/segmented-control'
import { Select } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import {
  EmptyState,
  InlineAlert,
  LoadingState,
  Surface,
  SurfaceDescription,
  SurfaceHeader,
  SurfaceTitle,
} from '../components/ui/surface'

export function FoundationsSpecimen() {
  const [query, setQuery] = React.useState('feature/tokens')
  const [saving, setSaving] = React.useState(false)
  const [includeUntracked, setIncludeUntracked] = React.useState(true)
  const [filter, setFilter] = React.useState<'all' | 'local' | 'remote'>('all')
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogName, setDialogName] = React.useState('feature/controls')

  return (
    <main className="foundations-specimen" aria-labelledby="specimen-title">
      <div className="foundations-specimen-header">
        <div>
          <p className="foundations-specimen-eyebrow">Git Stacks shared controls</p>
          <h1 id="specimen-title">Production component gallery</h1>
          <p>
            Production primitives demonstrate independent interaction, validation, and status
            states.
          </p>
        </div>
        <Badge variant="accent">Issue #4</Badge>
      </div>

      <Surface aria-labelledby="specimen-actions-title">
        <SurfaceHeader>
          <div>
            <SurfaceTitle id="specimen-actions-title">Actions and icons</SurfaceTitle>
            <SurfaceDescription>
              Busy actions retain their label, target, and keyboard focus behavior.
            </SurfaceDescription>
          </div>
          <Badge variant="success">Available</Badge>
        </SurfaceHeader>
        <div className="controls-specimen-row">
          <Button loading={saving} onClick={() => setSaving(true)}>
            {saving ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Check aria-hidden="true" className="size-4" />
            )}
            Save branch
          </Button>
          <Button onClick={() => setSaving(false)} variant="secondary">
            Clear busy state
          </Button>
          <Button variant="accent">Create branch</Button>
          <Button variant="ghost">Ghost action</Button>
          <Button variant="danger">Delete branch</Button>
          <Button disabled tooltip="Connect a repository before this action is available.">
            Unavailable action
          </Button>
          <IconButton label="Refresh preview" variant="secondary">
            <RefreshCw aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
        <InlineAlert tone="info" title="Loading is a state, not a layout change">
          The action stays in the same footprint and exposes its busy state to assistive technology.
        </InlineAlert>
      </Surface>

      <Surface aria-labelledby="specimen-fields-title">
        <SurfaceHeader>
          <div>
            <SurfaceTitle id="specimen-fields-title">Fields and selection</SurfaceTitle>
            <SurfaceDescription>
              Visible labels, helper text, and errors stay associated with their controls.
            </SurfaceDescription>
          </div>
          <Badge variant="warning">Validation</Badge>
        </SurfaceHeader>
        <div className="controls-specimen-grid">
          <Field
            id="specimen-branch"
            label="Branch name"
            description="Use a short, lowercase feature name."
            error={query ? undefined : 'A branch name is required.'}
            required
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="feature/my-change"
            />
          </Field>
          <Field
            id="specimen-parent"
            label="Parent branch"
            description="Selection is independent from checked-out state."
          >
            <Select
              defaultValue="main"
              options={[
                { value: 'main', label: 'main' },
                { value: 'develop', label: 'develop' },
              ]}
            />
          </Field>
          <Field
            id="specimen-description"
            label="Description"
            description="Optional context is preserved after an error."
          >
            <Textarea defaultValue="Keep this text while reviewing the operation." rows={3} />
          </Field>
          <Checkbox
            id="specimen-include-untracked"
            label="Include untracked files"
            description="Untracked files are included in the stash preview."
            checked={includeUntracked}
            onCheckedChange={setIncludeUntracked}
          />
          <Checkbox
            id="specimen-mixed"
            label="Mixed selection"
            indeterminate
            description="Indeterminate remains distinct from checked."
          />
        </div>
        <div className="controls-specimen-row">
          <SegmentedControl
            label="Repository filter"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'local', label: 'Local' },
              { value: 'remote', label: 'Remote' },
            ]}
          />
          <span className="controls-specimen-note" aria-live="polite">
            Selected: {filter}
          </span>
        </div>
      </Surface>

      <Surface aria-labelledby="specimen-overlay-title">
        <SurfaceHeader>
          <div>
            <SurfaceTitle id="specimen-overlay-title">Overlays and menus</SurfaceTitle>
            <SurfaceDescription>
              Keyboard entry, dismissal, visible focus, and focus return use one overlay vocabulary.
            </SurfaceDescription>
          </div>
        </SurfaceHeader>
        <div className="controls-specimen-row">
          <Tooltip>
            <TooltipTrigger render={<Button variant="secondary">Focusable tooltip</Button>} />
            <TooltipContent>
              Tooltip content is announced and dismissible with Escape.
            </TooltipContent>
          </Tooltip>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              render={
                <Button variant="secondary">
                  Open actions
                  <ChevronDown aria-hidden="true" className="size-4" />
                </Button>
              }
            />
            <DropdownMenu.Content>
              <DropdownMenu.Item onClick={() => undefined}>Preview merge</DropdownMenu.Item>
              <DropdownMenu.Item disabled>Force push with lease</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onClick={() => undefined}>Browse history</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger render={<Button variant="accent">Open dialog</Button>} />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Keyboard-safe dialog</DialogTitle>
                <DialogDescription>
                  Escape closes the dialog and focus returns to the trigger.
                </DialogDescription>
              </DialogHeader>
              <Field id="specimen-dialog-name" label="New branch" required>
                <Input value={dialogName} onChange={(event) => setDialogName(event.target.value)} />
              </Field>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setDialogOpen(false)}>Continue</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </Surface>

      <div className="controls-specimen-grid">
        <LoadingState>Reading repository state…</LoadingState>
        <InlineAlert tone="success" title="Success keeps the form">
          The entered branch name remains available after completion.
        </InlineAlert>
        <InlineAlert tone="error" title="Action unavailable">
          The operation did not run. Review the error and try again.
        </InlineAlert>
      </div>
      <EmptyState>
        <MoreHorizontal
          aria-hidden="true"
          className="size-6 text-[var(--gs-semantic-text-secondary)]"
        />
        <strong>No matching branches</strong>
        <span>Try a different search or clear the filter.</span>
      </EmptyState>
    </main>
  )
}
