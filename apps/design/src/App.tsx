import { useEffect, useState, type ComponentType } from 'react'
import {
  Button,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
  CommandGroup,
  Input,
  Select,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  TooltipProvider,
} from '@git-stacks/ui'
import {
  COMPONENT_MANIFEST,
  MANIFEST_DATE,
  MANIFEST_GROUPS,
  UPSTREAM_RECONCILIATION,
} from './manifest'
import { navigationSpecimens } from './navigation-specimens'
import { formSpecimens } from './form-specimens'
import { displaySpecimens } from './display-specimens'
import { overlaySpecimens } from './overlay-specimens'
import { Foundations, GitCompositions, TypographySpecimen } from './foundations'

export const SPECIMENS: Record<string, ComponentType> = {
  ...navigationSpecimens,
  ...formSpecimens,
  ...displaySpecimens,
  ...overlaySpecimens,
  typography: TypographySpecimen,
}

export default function App() {
  const [search, setSearch] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const [theme, setTheme] = useState('system')
  const [density, setDensity] = useState('standard')
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.dataset.gsTheme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset.gsDensity = density
  }, [density])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [])
  const query = search.trim().toLowerCase()
  const visible = COMPONENT_MANIFEST.filter((entry) =>
    `${entry.name} ${entry.group} ${entry.summary}`.toLowerCase().includes(query),
  )
  function navigate(id: string) {
    setSearch('')
    setCommandOpen(false)
    requestAnimationFrame(() => {
      location.hash = id
      document.getElementById(id)?.focus({ preventScroll: true })
    })
  }
  return (
    <TooltipProvider>
      <a className="skip-link" href="#catalog">
        Skip to catalog
      </a>
      <SidebarProvider className="design-shell">
        <Sidebar collapsible="none" className="design-nav">
          <SidebarHeader className="p-0">
            <h1>Git Stacks</h1>
            <p>
              The Quiet Workbench
              <br />
              Design system
            </p>
            <Input
              aria-label="Search components"
              placeholder="Search components"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button
              variant="secondary"
              onClick={() => setCommandOpen(true)}
              aria-keyshortcuts="Control+k Meta+k"
            >
              Command navigation · Ctrl/⌘ K
            </Button>
            <div className="catalog-settings">
              <label>
                Theme
                <Select
                  aria-label="Theme"
                  value={theme}
                  onValueChange={setTheme}
                  options={[
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'system', label: 'System' },
                  ]}
                />
              </label>
              <label>
                Density
                <Select
                  aria-label="Density"
                  value={density}
                  onValueChange={setDensity}
                  options={[
                    { value: 'compact', label: 'Compact' },
                    { value: 'standard', label: 'Standard' },
                  ]}
                />
              </label>
            </div>
          </SidebarHeader>
          <SidebarContent className="shrink-0 overflow-visible">
            <nav aria-label="Component catalog">
              <SidebarGroup className="p-0">
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        render={<a href="#foundations" />}
                        onClick={() => setSearch('')}
                      >
                        Foundations
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        render={<a href="#git-compositions" />}
                        onClick={() => setSearch('')}
                      >
                        Git compositions
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
              {MANIFEST_GROUPS.map((group) => (
                <SidebarGroup key={group} className="p-0">
                  <SidebarGroupLabel render={<h2 />}>{group}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {visible
                        .filter((entry) => entry.group === group)
                        .map((entry) => (
                          <SidebarMenuItem key={entry.id}>
                            <SidebarMenuButton render={<a href={`#${entry.id}`} />}>
                              {entry.name}
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </nav>
          </SidebarContent>
        </Sidebar>
        <main id="catalog" className="design-main" tabIndex={-1}>
          <header>
            <h2>The Quiet Workbench</h2>
            <p>
              Shared production controls, canonical tokens, and local interaction examples. Change
              the implementation once; inspect it here and in desktop.
            </p>
            <p>
              63 components + Typography · reconciled with shadcn Base UI base-nova on{' '}
              {MANIFEST_DATE}. Catalog-only recipes demonstrate capabilities, not new desktop
              product workflows.
            </p>
            <details>
              <summary>Upstream reconciliation and owned adaptations</summary>
              <p>{UPSTREAM_RECONCILIATION.inventory}</p>
              <ul>
                {UPSTREAM_RECONCILIATION.adaptations.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              <a href={UPSTREAM_RECONCILIATION.catalog} target="_blank" rel="noreferrer">
                Upstream component inventory
              </a>
            </details>
          </header>
          {!query && (
            <>
              <Foundations />
              <GitCompositions />
            </>
          )}
          <p role="status">{visible.length} component entries</p>
          {visible.map((entry) => {
            const Specimen = SPECIMENS[entry.id]
            return (
              <section
                id={entry.id}
                tabIndex={-1}
                key={entry.id}
                className="design-entry"
                data-component={entry.id}
              >
                <h2>{entry.name}</h2>
                <p>{entry.summary}</p>
                <div className="design-specimen" data-specimen={entry.id}>
                  <Specimen />
                </div>
                <details>
                  <summary>Usage, anatomy, keyboard and tokens</summary>
                  <dl>
                    <dt>Anatomy and API</dt>
                    <dd>{entry.anatomy}</dd>
                    <dt>Keyboard and accessibility</dt>
                    <dd>{entry.keyboard}</dd>
                    <dt>Canonical tokens</dt>
                    <dd className="design-token-list">
                      {entry.tokens.map((token) => (
                        <code key={token}>{token}</code>
                      ))}
                    </dd>
                  </dl>
                  <pre className="design-code">{entry.importExample}</pre>
                  <p>{entry.reconciledWith}</p>
                  {entry.catalogOnlyNotice && <p>{entry.catalogOnlyNotice}</p>}
                  <a href={entry.upstreamDoc} target="_blank" rel="noreferrer">
                    Upstream {entry.name} documentation
                  </a>
                </details>
              </section>
            )
          })}
          {visible.length === 0 && <p>No components match. Clear search to restore the catalog.</p>}
          <footer>
            Shared source: packages/ui. Catalog fixtures: apps/design. Automated checks are not
            accessibility certification.
          </footer>
        </main>
      </SidebarProvider>
      <CommandDialog
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Navigate component catalog"
        description="Search entries, use arrow keys, then Enter to navigate."
      >
        <CommandInput placeholder="Find a component" />
        <CommandList>
          <CommandEmpty>No matching entry.</CommandEmpty>
          <CommandGroup heading="Catalog">
            {COMPONENT_MANIFEST.map((entry) => (
              <CommandItem key={entry.id} value={entry.name} onSelect={() => navigate(entry.id)}>
                {entry.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </TooltipProvider>
  )
}
