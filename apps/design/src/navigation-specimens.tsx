import { useState } from 'react'
import * as UI from '@git-stacks/ui'
import { GitBranch, Bold, Italic } from 'lucide-react'

export const navigationSpecimens = {
  button: function Buttons() {
    const [count, setCount] = useState(0)
    return (
      <>
        <div className="design-specimen-row">
          {(['default', 'secondary', 'ghost', 'subtle', 'accent', 'danger', 'link'] as const).map(
            (variant) => (
              <UI.Button key={variant} variant={variant} onClick={() => setCount(count + 1)}>
                {variant}
              </UI.Button>
            ),
          )}
        </div>
        <div className="design-specimen-row">
          <UI.Button disabled tooltip="Captured preview is unavailable">
            Unavailable
          </UI.Button>
          <UI.Button loading tooltip="Local simulation in progress">
            Fetching
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
    <UI.ToggleGroup defaultValue={['bold']}>
      <UI.ToggleGroupItem value="bold" aria-label="Bold">
        <Bold />
      </UI.ToggleGroupItem>
      <UI.ToggleGroupItem value="italic" aria-label="Italic">
        <Italic />
      </UI.ToggleGroupItem>
    </UI.ToggleGroup>
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
