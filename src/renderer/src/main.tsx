import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { FoundationsSpecimen } from './design-system/FoundationsSpecimen'
import { ShellSpecimen } from './design-system/ShellSpecimen'
import { DataSurfacesSpecimen } from './design-system/DataSurfacesSpecimen'
import { DialogSpecimen } from './design-system/DialogSpecimen'
import { WorkflowRecoverySpecimen } from './design-system/WorkflowRecoverySpecimen'
import { TooltipProvider } from './components/ui/tooltip'
import { RepositoryHoverCardProvider } from './components/repository-hover-cards'
import './styles.css'

const route = window.location.hash
const recoverySpecimen = route.startsWith('#/design-system-recovery-specimen')
const recoveryMode = new URLSearchParams(route.split('?')[1] ?? '').get('mode') ?? 'saved'
const specimen = ['#/design-system-specimen', '#/design-system-controls'].includes(route)
const shellSpecimen = route === '#/design-system-shell-specimen'
const dataSpecimen = route === '#/design-system-data-specimen'
const dialogSpecimen = route === '#/design-system-dialog-specimen'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Git Stacks renderer root is missing')
}

createRoot(root).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={450} skipDelayDuration={150}>
      <RepositoryHoverCardProvider>
        {specimen ? (
          <FoundationsSpecimen />
        ) : shellSpecimen ? (
          <ShellSpecimen />
        ) : dataSpecimen ? (
          <DataSurfacesSpecimen />
        ) : dialogSpecimen ? (
          <DialogSpecimen />
        ) : recoverySpecimen ? (
          <WorkflowRecoverySpecimen mode={recoveryMode} />
        ) : (
          <App />
        )}
      </RepositoryHoverCardProvider>
    </TooltipProvider>
  </React.StrictMode>,
)
