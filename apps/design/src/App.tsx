import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from 'react'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
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
  SidebarTrigger,
  useSidebar,
  TooltipProvider,
} from '@git-stacks/ui'
import { ChevronDown } from 'lucide-react'
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
import { AdoptionExample } from './adoption-examples'

const ADOPTION_RECIPES = [
  {
    task: 'Inspect without mutation',
    guidance: 'Keep inspection separate from checkout. Use a sheet for supporting context.',
    links: [
      { id: 'git-compositions', label: 'Git compositions' },
      { id: 'sheet', label: 'Sheet' },
      { id: 'dialog', label: 'Dialog' },
    ],
  },
  {
    task: 'Choose a value',
    guidance: 'Show a few exclusive choices; add search when the list needs it.',
    links: [
      { id: 'radio-group', label: 'Radio Group' },
      { id: 'select', label: 'Select' },
      { id: 'combobox', label: 'Combobox' },
    ],
  },
  {
    task: 'Confirm captured scope',
    guidance: 'Name the identities and consequences. Keep Cancel first and deletion explicit.',
    links: [
      { id: 'git-compositions', label: 'Scoped Git example' },
      { id: 'alert-dialog', label: 'Alert Dialog' },
    ],
  },
  {
    task: 'Report status and recovery',
    guidance: 'Label unknown or unavailable facts. Keep blockers and the next step inline.',
    links: [
      { id: 'badge', label: 'Badge' },
      { id: 'alert', label: 'Alert' },
      { id: 'field', label: 'Field' },
    ],
  },
] as const

export const SPECIMENS: Record<string, ComponentType> = {
  ...navigationSpecimens,
  ...formSpecimens,
  ...displaySpecimens,
  ...overlaySpecimens,
  typography: TypographySpecimen,
}

export default function App() {
  return (
    <TooltipProvider>
      <SidebarProvider
        className="design-shell"
        style={{ '--sidebar-width': '280px' } as CSSProperties}
      >
        <CatalogWorkspace />
      </SidebarProvider>
    </TooltipProvider>
  )
}

function CatalogWorkspace() {
  const { setOpenMobile } = useSidebar()
  const [search, setSearch] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const [theme, setTheme] = useState('system')
  const [density, setDensity] = useState('standard')
  const [activeId, setActiveId] = useState(() => location.hash.slice(1) || 'foundations')
  const [expandedGroup, setExpandedGroup] = useState<string | null>(
    () =>
      COMPONENT_MANIFEST.find((entry) => entry.id === location.hash.slice(1))?.group ?? 'Actions',
  )
  const searchOrigin = useRef<{ id: string; top: number } | null>(null)
  const resultsRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    const syncAnchor = () => {
      const id = location.hash.slice(1) || 'foundations'
      setActiveId(id)
      const group = COMPONENT_MANIFEST.find((entry) => entry.id === id)?.group
      if (group) setExpandedGroup(group)
    }
    window.addEventListener('hashchange', syncAnchor)
    if (location.hash) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' })
    }
    return () => {
      window.removeEventListener('hashchange', syncAnchor)
    }
  }, [])
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
  function updateSearch(value: string) {
    if (!query && value.trim()) {
      const section = document.getElementById(activeId)
      if (section) searchOrigin.current = { id: activeId, top: section.getBoundingClientRect().top }
    }
    setSearch(value)
  }
  useLayoutEffect(() => {
    if (query) {
      resultsRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
      return
    }
    const origin = searchOrigin.current
    searchOrigin.current = null
    if (!origin) return
    const section = document.getElementById(origin.id)
    if (section) {
      window.scrollBy({
        top: section.getBoundingClientRect().top - origin.top,
        behavior: 'instant',
      })
    }
  }, [query])
  useEffect(() => {
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#catalog > section[id], .catalog-matches > section[id]',
      ),
    )
    setActiveId((current) =>
      sections.some((section) => section.id === current) ? current : (sections[0]?.id ?? ''),
    )
    const intersecting = new Set<Element>()
    let observer: IntersectionObserver
    function observeSections() {
      observer?.disconnect()
      intersecting.clear()
      // Follow the heading inset, beyond the preceding section's trailing edge.
      const style = getComputedStyle(sections[0])
      const readingLine = parseFloat(style.scrollMarginTop) + parseFloat(style.paddingTop)
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRect.height > 0) {
              intersecting.add(entry.target)
            } else {
              intersecting.delete(entry.target)
            }
          }
          const current = sections.find((section) => intersecting.has(section))
          if (!current) return
          setActiveId(current.id)
          const group = COMPONENT_MANIFEST.find((entry) => entry.id === current.id)?.group
          if (group) setExpandedGroup(group)
        },
        {
          rootMargin: `${-readingLine}px 0px ${readingLine + 1 - window.innerHeight}px 0px`,
          // Crossing a section boundary must include positive area, not just a touching edge.
          threshold: Number.EPSILON,
        },
      )
      for (const section of sections) observer.observe(section)
    }
    if (!sections.length) return
    observeSections()
    window.addEventListener('resize', observeSections)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', observeSections)
    }
  }, [query])
  function navigate(id: string) {
    // Explicit navigation wins over restoring the pre-search reading position.
    searchOrigin.current = null
    setSearch('')
    setCommandOpen(false)
    setOpenMobile(false)
    requestAnimationFrame(() => {
      location.hash = id
      const destination = document.getElementById(id)
      destination?.scrollIntoView({ block: 'start' })
      destination?.focus({ preventScroll: true })
    })
  }
  return (
    <>
      <a className="skip-link" href="#catalog">
        Skip to catalog
      </a>
      <Sidebar collapsible="offcanvas" variant="floating" className="design-nav">
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
            onChange={(event) => updateSearch(event.target.value)}
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
        <SidebarContent className="catalog-navigation">
          <nav aria-label="Component catalog">
            <SidebarGroup className="p-0">
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      render={
                        <a
                          href="#foundations"
                          aria-current={activeId === 'foundations' ? 'location' : undefined}
                        />
                      }
                      isActive={activeId === 'foundations'}
                      onClick={(event) => {
                        event.preventDefault()
                        navigate('foundations')
                      }}
                    >
                      Foundations
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      render={
                        <a
                          href="#git-compositions"
                          aria-current={activeId === 'git-compositions' ? 'location' : undefined}
                        />
                      }
                      isActive={activeId === 'git-compositions'}
                      onClick={(event) => {
                        event.preventDefault()
                        navigate('git-compositions')
                      }}
                    >
                      Git compositions
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            {MANIFEST_GROUPS.filter((group) => visible.some((entry) => entry.group === group)).map(
              (group) => (
                <Collapsible
                  key={group}
                  open={!!query || expandedGroup === group}
                  onOpenChange={(open) => setExpandedGroup(open ? group : null)}
                >
                  <SidebarGroup className="p-0">
                    <SidebarGroupLabel
                      render={<CollapsibleTrigger />}
                      className="catalog-group-trigger"
                      aria-label={`${group} components`}
                    >
                      {group}
                      <span aria-hidden="true">
                        {visible.filter((entry) => entry.group === group).length}
                        <ChevronDown className="size-4" />
                      </span>
                    </SidebarGroupLabel>
                    <CollapsibleContent>
                      <SidebarGroupContent>
                        <SidebarMenu>
                          {visible
                            .filter((entry) => entry.group === group)
                            .map((entry) => (
                              <SidebarMenuItem key={entry.id}>
                                <SidebarMenuButton
                                  render={
                                    <a
                                      href={`#${entry.id}`}
                                      aria-current={activeId === entry.id ? 'location' : undefined}
                                    />
                                  }
                                  isActive={activeId === entry.id}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    navigate(entry.id)
                                  }}
                                >
                                  {entry.name}
                                </SidebarMenuButton>
                              </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                      </SidebarGroupContent>
                    </CollapsibleContent>
                  </SidebarGroup>
                </Collapsible>
              ),
            )}
          </nav>
        </SidebarContent>
      </Sidebar>
      <main id="catalog" className="design-main" tabIndex={-1}>
        <div className="catalog-toolbar">
          <SidebarTrigger aria-label="Browse components" title="Toggle catalog sidebar" />
          <span>Component catalog</span>
        </div>
        <header className="catalog-introduction">
          <h2>The Quiet Workbench</h2>
          <p>
            Shared production controls, canonical tokens, and local interaction examples. Change the
            implementation once; inspect it here and in desktop.
          </p>
          <p>
            63 components + Typography · reconciled with shadcn Base UI base-nova on {MANIFEST_DATE}
            . Catalog-only recipes demonstrate capabilities, not new desktop product workflows.
          </p>
          <h3>Start with the interaction</h3>
          <dl className="catalog-recipes">
            {ADOPTION_RECIPES.map((recipe) => (
              <div key={recipe.task}>
                <dt>{recipe.task}</dt>
                <dd>
                  <p>{recipe.guidance}</p>
                  <div className="catalog-recipe-links">
                    {recipe.links.map((link) => (
                      <Button
                        key={link.id}
                        variant="link"
                        nativeButton={false}
                        role="link"
                        render={<a href={`#${link.id}`} />}
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                            return
                          event.preventDefault()
                          navigate(link.id)
                        }}
                      >
                        {link.label}
                      </Button>
                    ))}
                  </div>
                </dd>
              </div>
            ))}
          </dl>
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
        <div className="catalog-matches" data-filtered={query ? 'true' : undefined}>
          <p id="catalog-results" ref={resultsRef} className="catalog-results" role="status">
            {visible.length} component entries
          </p>
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
                <div className="design-entry-heading">
                  <h2>{entry.name}</h2>
                  <span>{entry.group}</span>
                </div>
                <p className="design-entry-summary">{entry.summary}</p>
                <p className="design-entry-usage">{entry.usage}</p>
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
                  <AdoptionExample id={entry.id} />
                  <p>{entry.reconciledWith}</p>
                  {entry.catalogOnlyNotice && <p>{entry.catalogOnlyNotice}</p>}
                  <a href={entry.upstreamDoc} target="_blank" rel="noreferrer">
                    Upstream {entry.name} documentation
                  </a>
                </details>
              </section>
            )
          })}
          {visible.length === 0 && (
            <Empty className="catalog-empty">
              <EmptyHeader>
                <EmptyTitle>No components match</EmptyTitle>
                <EmptyDescription>Clear search to restore the catalog.</EmptyDescription>
              </EmptyHeader>
              <Button variant="secondary" onClick={() => updateSearch('')}>
                Clear search
              </Button>
            </Empty>
          )}
        </div>
        <footer>
          Shared source: packages/ui. Catalog fixtures: apps/design. Automated checks are not
          accessibility certification.
        </footer>
      </main>
      <CommandDialog
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Navigate component catalog"
        description="Search entries, use arrow keys, then Enter to navigate."
      >
        <CommandInput placeholder="Find a component" />
        <CommandList>
          <CommandEmpty>No matching entry.</CommandEmpty>
          <CommandGroup heading="Foundations and patterns">
            <CommandItem value="Foundations" onSelect={() => navigate('foundations')}>
              Foundations
            </CommandItem>
            <CommandItem value="Git compositions" onSelect={() => navigate('git-compositions')}>
              Git compositions
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Catalog">
            {COMPONENT_MANIFEST.map((entry) => (
              <CommandItem key={entry.id} value={entry.name} onSelect={() => navigate(entry.id)}>
                {entry.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}
