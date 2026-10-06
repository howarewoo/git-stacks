import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRendererQueryClient } from './lib/query-client'
import App from './App'
import { WorkflowRecoverySpecimen } from './design-system/WorkflowRecoverySpecimen'
import { TooltipProvider } from './components/ui/tooltip'
import { RepositoryHoverCardProvider } from './components/repository-hover-cards'
import './styles.css'

// Only the recovery specimen is reachable from the packaged renderer. The other specimens live
// in the fixture gallery so their fixture code never reaches the packaged payload; this one is
// deliberately reached without a preload, so it must not install or mutate `window.desktop`.
const recoverySpecimen = window.location.hash.startsWith('#/design-system-recovery-specimen')
const recoveryMode =
  new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('mode') ?? 'saved'

const queryClient = createRendererQueryClient()
const root = document.getElementById('root')

if (!root) {
  throw new Error('Git Stacks renderer root is missing')
}

createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={450} timeout={150}>
        <RepositoryHoverCardProvider>
          {recoverySpecimen ? <WorkflowRecoverySpecimen mode={recoveryMode} /> : <App />}
        </RepositoryHoverCardProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
