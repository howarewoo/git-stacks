import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRendererQueryClient } from '../../../src/renderer/src/lib/query-client'
import App from '../../../src/renderer/src/App'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { DialogSpecimen } from '../specimens/DialogSpecimen'
import { FoundationsSpecimen } from '../specimens/FoundationsSpecimen'
import { WorkflowRecoverySpecimen } from '../specimens/WorkflowRecoverySpecimen'
import { installFixtureControl } from '../fixtures/control'
import { InventoryConsumer } from './inventory-consumer'
import { WorkbenchV5Gallery } from './workbench-v5'
import {
  DEFAULT_SCENARIO,
  GALLERY_ROUTES,
  SCENARIO_NAMES,
  type GalleryRouteId,
} from '../fixtures/manifest'
import { scenarios } from '../fixtures/scenarios'
import { galleryUrl } from '../fixtures/urls'
import '../../../src/renderer/src/styles.css'
import './specimen.css'

const queryClient = createRendererQueryClient()
const ROUTE_ENTRIES = Object.entries(GALLERY_ROUTES) as [GalleryRouteId, string][]

function routeFromHash(hash: string): GalleryRouteId {
  return ROUTE_ENTRIES.find(([, value]) => value === hash)?.[0] ?? 'app'
}

/** Listeners keep `setScenario` working without reinstalling the double. */
const scenarioListeners = new Set<() => void>()

const requestedScenario =
  new URLSearchParams(window.location.search).get('scenario') ?? DEFAULT_SCENARIO

// Installed before the first render so the production App sees `window.desktop` on mount,
// the same way the preload script provides it in the packaged application.
const control = installFixtureControl({
  scenario: requestedScenario,
  onScenarioChange: (name) => {
    const search = new URLSearchParams(window.location.search)
    search.set('scenario', name)
    window.history.replaceState(null, '', `?${search.toString()}${window.location.hash}`)
    for (const listener of scenarioListeners) listener()
  },
  reviewCache: () => ({
    reads: queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === 'review')
      .map((query) => query.queryKey),
    writes: queryClient
      .getMutationCache()
      .getAll()
      .filter((mutation) => mutation.options.mutationKey?.[0] === 'review')
      .map((mutation) => ({
        key: mutation.options.mutationKey ?? null,
        status: mutation.state.status,
        retained: mutation.options.meta?.retainedReviewDraft === true,
        authored:
          mutation.options.meta?.retainedReviewDraft === true ? mutation.state.variables : null,
      })),
  }),
})

function GalleryIndex({ scenario }: { scenario: string }) {
  return (
    <div className="gallery-index">
      <h1>Git Stacks fixture gallery</h1>
      <p>
        Development and test only; this entry is never part of the packaged renderer. Every route
        mounts the real production component tree against the deterministic fixture double on{' '}
        <code>window.desktop</code>, with the control surface on <code>window.fixture</code>.
      </p>
      <section>
        <h2>Production app</h2>
        <ul>
          {SCENARIO_NAMES.map((name) => (
            <li key={name}>
              <a href={galleryUrl(name, 'app')}>{name}</a>
              <span>{scenarios[name].summary}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Specimens</h2>
        <ul>
          {ROUTE_ENTRIES.filter(([id]) => id !== 'app' && id !== 'index').map(([id, hash]) => (
            <li key={id}>
              <a href={galleryUrl(scenario, id)}>{hash}</a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function renderRoute(route: GalleryRouteId, remountKey: string) {
  switch (route) {
    case 'inventory':
      return <InventoryConsumer />
    case 'workbenchV5':
      return <WorkbenchV5Gallery key={remountKey} />
    case 'index':
      return <GalleryIndex key={remountKey} scenario={remountKey} />
    case 'foundations':
      return <FoundationsSpecimen key={remountKey} />
    case 'recovery':
      return (
        <WorkflowRecoverySpecimen
          mode={new URLSearchParams(window.location.search).get('mode') ?? 'saved'}
        />
      )
    case 'dialog':
      return <DialogSpecimen key={remountKey} />
    default:
      // Not keyed by the scenario. Remounting would make an in-place answer
      // change indistinguishable from a first load, and the in-place
      // transitions — a read that ends, a read that is replaced, a read that
      // names no account — would then only ever be provable by reloading.
      return <App />
  }
}

function Gallery() {
  const [scenario, setScenario] = React.useState(control.scenario)
  const [route, setRoute] = React.useState(() => routeFromHash(window.location.hash))

  React.useEffect(() => {
    const listener = () => setScenario(control.scenario)
    const onHashChange = () => setRoute(routeFromHash(window.location.hash))
    scenarioListeners.add(listener)
    window.addEventListener('hashchange', onHashChange)
    return () => {
      scenarioListeners.delete(listener)
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  React.useEffect(() => {
    document.documentElement.dataset.galleryScenario = scenario
    document.documentElement.dataset.galleryRoute = route
  }, [route, scenario])

  // The production App opens a repository only when the user asks for one, so
  // the gallery performs that first click itself. It is armed once per App
  // mount: leaving the App route unmounts the App, and coming back is a fresh
  // mount that needs the same click.
  const connected = React.useRef(false)
  React.useEffect(() => {
    if (route !== 'app') {
      connected.current = false
      return
    }
    if (connected.current) return
    connected.current = true
    control.connect()
  }, [route, scenario])

  // No StrictMode here: every fixture must mount exactly once so the call log stays deterministic.
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={450} timeout={150}>
        {renderRoute(route, scenario)}
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const root = document.getElementById('root')

if (!root) {
  throw new Error('Git Stacks fixture gallery root is missing')
}

createRoot(root).render(<Gallery />)
