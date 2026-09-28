import * as React from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../../src/renderer/src/App'
import { RepositoryHoverCardProvider } from '../../../src/renderer/src/components/repository-hover-cards'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { DataSurfacesSpecimen } from '../../../src/renderer/src/design-system/DataSurfacesSpecimen'
import { DialogSpecimen } from '../../../src/renderer/src/design-system/DialogSpecimen'
import { FoundationsSpecimen } from '../../../src/renderer/src/design-system/FoundationsSpecimen'
import { ShellSpecimen } from '../../../src/renderer/src/design-system/ShellSpecimen'
import { installFixtureControl } from '../fixtures/control'
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
    case 'index':
      return <GalleryIndex key={remountKey} scenario={remountKey} />
    case 'controls':
    case 'foundations':
      return <FoundationsSpecimen key={remountKey} />
    case 'shell':
      return <ShellSpecimen key={remountKey} />
    case 'data':
      return <DataSurfacesSpecimen key={remountKey} />
    case 'dialog':
      return <DialogSpecimen key={remountKey} />
    default:
      return <App key={remountKey} />
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

  // The production App only opens a repository when the user asks for one. The gallery performs
  // that same first click so every scenario that has a repository starts in its connected state.
  React.useEffect(() => {
    if (route === 'app') control.connect()
  }, [route, scenario])

  // No StrictMode here: every fixture must mount exactly once so the call log stays deterministic.
  return (
    <TooltipProvider delayDuration={450} skipDelayDuration={150}>
      <RepositoryHoverCardProvider>{renderRoute(route, scenario)}</RepositoryHoverCardProvider>
    </TooltipProvider>
  )
}

const root = document.getElementById('root')

if (!root) {
  throw new Error('Git Stacks fixture gallery root is missing')
}

createRoot(root).render(<Gallery />)
