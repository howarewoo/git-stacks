import { useState } from 'react'
import * as UI from '@git-stacks/ui'
import { GitBranch, Bold, Italic } from 'lucide-react'

export const navigationSpecimens = {
  button: function Buttons() {
    const [count, setCount] = useState(0)
    const [working, setWorking] = useState(false)
    const [previewOpen, setPreviewOpen] = useState(false)
    const [shortcutsOpen, setShortcutsOpen] = useState(false)
    const [view, setView] = useState<'split' | 'unified'>('split')
    const [draftResult, setDraftResult] = useState('No example draft saved.')
    return (
      <>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {(
            [
              ['default', 'Complete the main task, such as saving a draft.'],
              ['secondary', 'Offer a supporting action or Cancel beside the primary action.'],
              ['ghost', 'Keep repeated row or toolbar actions quiet until hover or focus.'],
              ['subtle', 'Expose optional help or utilities on a quiet, always-visible surface.'],
              [
                'accent',
                'Emphasize meaningful context, not a second primary action. Use a selection control for a persistent choice.',
              ],
              ['danger', 'Confirm a destructive action after naming its scope and consequences.'],
              ['link', 'Navigate to another location with a real anchor and destination.'],
            ] as const
          ).map(([variant, guidance]) => (
            <div key={variant} className="grid grid-cols-[7rem_1fr] items-center gap-3">
              <dt>
                <UI.Button variant={variant} onClick={() => setCount((value) => value + 1)}>
                  {variant}
                </UI.Button>
              </dt>
              <dd className="m-0 text-sm text-muted-foreground">{guidance}</dd>
            </div>
          ))}
        </dl>
        <div className="design-specimen-row">
          <UI.Button disabled tooltip="Captured preview is unavailable">
            Unavailable
          </UI.Button>
          <UI.Button
            loading={working}
            tooltip="Start a local simulation; no Git or network work"
            onClick={() => setWorking(true)}
          >
            Fetch example
          </UI.Button>
          <UI.Button variant="secondary" disabled={!working} onClick={() => setWorking(false)}>
            Finish simulation
          </UI.Button>
          <UI.IconButton
            label="Inspect branch"
            tooltip="Inspect branch"
            onClick={() => setCount(count + 1)}
          >
            <GitBranch />
          </UI.IconButton>
        </div>
        <output aria-live="polite">Local activations: {count}</output>
        <output aria-live="polite">
          {working
            ? 'Working — finish the local simulation to return to idle.'
            : 'Idle — ready to simulate.'}
        </output>
        <section className="catalog-composition" aria-label="Draft toolbar example">
          <h3>Choose by purpose, not by color</h3>
          <p>
            One primary action completes the task. Secondary supports it; ghost keeps repeated
            actions quiet; subtle makes optional help discoverable. This draft stays in the catalog.
          </p>
          <div className="design-specimen-row" role="group" aria-label="Example draft actions">
            <UI.Button
              onClick={() => setDraftResult('Example draft saved locally in this specimen.')}
            >
              Save example draft
            </UI.Button>
            <UI.Button variant="secondary" onClick={() => setPreviewOpen(true)}>
              Preview example draft
            </UI.Button>
            <UI.Button variant="ghost" onClick={() => setDraftResult('Example preview refreshed.')}>
              Refresh example
            </UI.Button>
            <UI.Button
              variant="subtle"
              aria-expanded={shortcutsOpen}
              aria-controls="example-draft-shortcuts"
              onClick={() => setShortcutsOpen((open) => !open)}
            >
              {shortcutsOpen ? 'Hide shortcuts' : 'Show shortcuts'}
            </UI.Button>
          </div>
          <p id="example-draft-shortcuts" hidden={!shortcutsOpen}>
            Tab moves between actions; Enter or Space activates the focused button.
          </p>
          <output aria-live="polite">{draftResult}</output>
          <UI.Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
            <UI.DialogContent>
              <UI.DialogHeader>
                <UI.DialogTitle>Preview example draft</UI.DialogTitle>
                <UI.DialogDescription>
                  Supporting actions stay secondary. Saving affects this local specimen only.
                </UI.DialogDescription>
              </UI.DialogHeader>
              <p>Preserve independent inspection and checkout.</p>
              <UI.DialogFooter>
                <UI.Button variant="secondary" onClick={() => setPreviewOpen(false)}>
                  Cancel
                </UI.Button>
                <UI.Button
                  onClick={() => {
                    setDraftResult('Example draft saved locally in this specimen.')
                    setPreviewOpen(false)
                  }}
                >
                  Save example draft
                </UI.Button>
              </UI.DialogFooter>
            </UI.DialogContent>
          </UI.Dialog>
        </section>
        <section className="catalog-composition" aria-label="Persistent selection example">
          <h3>A choice is not an action</h3>
          <p>
            Use SegmentedControl for an exactly-one-selected view. Its accent marks the current
            choice; it does not mean a task has run.
          </p>
          <UI.SegmentedControl
            label="Example diff layout"
            className="justify-self-start"
            value={view}
            onValueChange={setView}
            options={[
              { value: 'split', label: 'Split' },
              { value: 'unified', label: 'Unified' },
            ]}
          />
          <output aria-live="polite">
            {view === 'split' ? 'Split' : 'Unified'} example view selected.
          </output>
        </section>
      </>
    )
  },
  'button-group': function Group() {
    const [mode, setMode] = useState('Split')
    return (
      <>
        <UI.ButtonGroup>
          {['Split', 'Unified'].map((value) => (
            <UI.Button
              key={value}
              variant={mode === value ? 'accent' : 'secondary'}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value}
            </UI.Button>
          ))}
        </UI.ButtonGroup>
        <output>{mode} diff selected</output>
      </>
    )
  },
  toggle: () => (
    <UI.Toggle aria-label="Bold text">
      <Bold />
    </UI.Toggle>
  ),
  'toggle-group': () => (
    <>
      {(['horizontal', 'vertical'] as const).map((orientation) => (
        <UI.ToggleGroup
          key={orientation}
          defaultValue={['bold']}
          orientation={orientation}
          aria-label={`${orientation} text formatting`}
        >
          <UI.ToggleGroupItem value="bold" aria-label="Bold">
            <Bold />
          </UI.ToggleGroupItem>
          <UI.ToggleGroupItem value="italic" aria-label="Italic">
            <Italic />
          </UI.ToggleGroupItem>
        </UI.ToggleGroup>
      ))}
    </>
  ),
  kbd: () => (
    <p>
      Open command navigation <UI.Kbd>Ctrl</UI.Kbd> + <UI.Kbd>K</UI.Kbd>
    </p>
  ),
  breadcrumb: () => (
    <UI.Breadcrumb>
      <UI.BreadcrumbList>
        <UI.BreadcrumbItem>
          <UI.BreadcrumbLink href="#git-compositions">Repository</UI.BreadcrumbLink>
        </UI.BreadcrumbItem>
        <UI.BreadcrumbSeparator />
        <UI.BreadcrumbItem>
          <UI.BreadcrumbLink href="#diff">Changes</UI.BreadcrumbLink>
        </UI.BreadcrumbItem>
        <UI.BreadcrumbSeparator />
        <UI.BreadcrumbItem>
          <UI.BreadcrumbPage>src/graph.ts</UI.BreadcrumbPage>
        </UI.BreadcrumbItem>
      </UI.BreadcrumbList>
    </UI.Breadcrumb>
  ),
  sidebar: () => (
    <UI.SidebarProvider className="relative min-h-64 overflow-hidden">
      <UI.Sidebar collapsible="icon" className="absolute">
        <UI.SidebarHeader>Local repository</UI.SidebarHeader>
        <UI.SidebarContent>
          <UI.SidebarGroup>
            <UI.SidebarGroupLabel>Local navigation</UI.SidebarGroupLabel>
            <UI.SidebarMenu>
              {['Branches', 'Review', 'Settings'].map((name, index) => (
                <UI.SidebarMenuItem key={name}>
                  <UI.SidebarMenuButton
                    render={<a href="#git-compositions" />}
                    tooltip={name}
                    isActive={index === 0}
                    size={index === 1 ? 'sm' : 'default'}
                  >
                    <GitBranch aria-hidden="true" />
                    <span>{name}</span>
                  </UI.SidebarMenuButton>
                </UI.SidebarMenuItem>
              ))}
            </UI.SidebarMenu>
          </UI.SidebarGroup>
        </UI.SidebarContent>
      </UI.Sidebar>
      <div className="min-w-0 flex-1 p-4">
        <UI.SidebarTrigger />
        <p>
          Toggle this local navigation with the button or Ctrl/⌘ B. Selection does not perform Git
          work.
        </p>
      </div>
    </UI.SidebarProvider>
  ),
  'navigation-menu': () => (
    <UI.NavigationMenu>
      <UI.NavigationMenuList>
        <UI.NavigationMenuItem>
          <UI.NavigationMenuTrigger>Workbench</UI.NavigationMenuTrigger>
          <UI.NavigationMenuContent>
            <UI.NavigationMenuLink href="#git-compositions">
              Inspect the local Git examples
            </UI.NavigationMenuLink>
          </UI.NavigationMenuContent>
        </UI.NavigationMenuItem>
        <UI.NavigationMenuItem>
          <UI.NavigationMenuLink href="#typography">Typography</UI.NavigationMenuLink>
        </UI.NavigationMenuItem>
      </UI.NavigationMenuList>
    </UI.NavigationMenu>
  ),
  menubar: function Menu() {
    const [action, setAction] = useState('No command selected')
    return (
      <>
        <UI.Menubar>
          <UI.MenubarMenu>
            <UI.MenubarTrigger>Repository</UI.MenubarTrigger>
            <UI.MenubarContent>
              <UI.MenubarItem onClick={() => setAction('Fetch simulated locally')}>
                Simulate fetch
              </UI.MenubarItem>
              <UI.MenubarSeparator />
              <UI.MenubarItem disabled>Publish unavailable</UI.MenubarItem>
            </UI.MenubarContent>
          </UI.MenubarMenu>
          <UI.MenubarMenu>
            <UI.MenubarTrigger>View</UI.MenubarTrigger>
            <UI.MenubarContent>
              <UI.MenubarItem onClick={() => setAction('Graph selected')}>Graph</UI.MenubarItem>
            </UI.MenubarContent>
          </UI.MenubarMenu>
        </UI.Menubar>
        <output aria-live="polite">{action}</output>
      </>
    )
  },
  'dropdown-menu': function Menu() {
    const [action, setAction] = useState('No command selected')
    return (
      <>
        <UI.DropdownMenu>
          <UI.DropdownMenuTrigger render={<UI.Button variant="secondary" />}>
            Branch actions
          </UI.DropdownMenuTrigger>
          <UI.DropdownMenuContent>
            <UI.DropdownMenuItem onClick={() => setAction('Branch inspection selected')}>
              Inspect branch
            </UI.DropdownMenuItem>
            <UI.DropdownMenuItem disabled>Checkout unavailable</UI.DropdownMenuItem>
          </UI.DropdownMenuContent>
        </UI.DropdownMenu>
        <output aria-live="polite">{action}</output>
      </>
    )
  },
  'context-menu': function Menu() {
    const [action, setAction] = useState('Right-click or Shift+F10')
    return (
      <>
        <UI.ContextMenu>
          <UI.ContextMenuTrigger className="rounded border p-6" tabIndex={0}>
            feature/quiet-graph
          </UI.ContextMenuTrigger>
          <UI.ContextMenuContent>
            <UI.ContextMenuItem onClick={() => setAction('Copied local example ref')}>
              Copy example ref
            </UI.ContextMenuItem>
            <UI.ContextMenuItem disabled>Delete unavailable</UI.ContextMenuItem>
          </UI.ContextMenuContent>
        </UI.ContextMenu>
        <output>{action}</output>
      </>
    )
  },
  command: function Commands() {
    const [selected, setSelected] = useState('')
    // cmdk scrolls its initial selected item into view, even without focus.
    // Keep this inline example unselected until the user enters the search.
    const [activeCommand, setActiveCommand] = useState('__unselected__')
    return (
      <>
        <UI.Command value={activeCommand} onValueChange={setActiveCommand}>
          <UI.CommandInput
            placeholder="Search local commands"
            onFocus={() => {
              if (activeCommand === '__unselected__') setActiveCommand('Inspect branch')
            }}
          />
          <UI.CommandList>
            <UI.CommandEmpty>No matching command.</UI.CommandEmpty>
            <UI.CommandGroup heading="Local navigation">
              {['Inspect branch', 'View diff', 'Open review'].map((name) => (
                <UI.CommandItem key={name} onSelect={() => setSelected(name)}>
                  {name}
                </UI.CommandItem>
              ))}
            </UI.CommandGroup>
          </UI.CommandList>
        </UI.Command>
        <output aria-live="polite">{selected}</output>
      </>
    )
  },
  tabs: () => (
    <>
      {(['horizontal', 'vertical'] as const).map((orientation) =>
        (['default', 'line'] as const).map((variant) => (
          <UI.Tabs
            key={`${orientation}-${variant}`}
            defaultValue="changes"
            orientation={orientation}
          >
            <UI.TabsList
              variant={variant}
              controlSize={variant === 'line' ? 'compact' : 'standard'}
              aria-label={`${orientation} ${variant} repository views`}
            >
              <UI.TabsTrigger value="changes">Changes</UI.TabsTrigger>
              <UI.TabsTrigger value="checks">Checks</UI.TabsTrigger>
              <UI.TabsTrigger value="unavailable" disabled>
                Unavailable
              </UI.TabsTrigger>
            </UI.TabsList>
            <UI.TabsContent value="changes">2 local files changed.</UI.TabsContent>
            <UI.TabsContent value="checks">
              Checks unavailable — no remote data loaded.
            </UI.TabsContent>
          </UI.Tabs>
        )),
      )}
    </>
  ),
  pagination: function Pages() {
    const [page, setPage] = useState(1)
    return (
      <UI.Pagination>
        <UI.PaginationContent>
          {[1, 2, 3].map((value) => (
            <UI.PaginationItem key={value}>
              <UI.PaginationLink
                href="#pagination"
                isActive={page === value}
                aria-label={`Page ${value}`}
                onClick={(event) => {
                  event.preventDefault()
                  setPage(value)
                }}
              >
                {value}
              </UI.PaginationLink>
            </UI.PaginationItem>
          ))}
        </UI.PaginationContent>
      </UI.Pagination>
    )
  },
}
