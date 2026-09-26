import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { FoundationsSpecimen } from './design-system/FoundationsSpecimen'
import { ShellSpecimen } from './design-system/ShellSpecimen'
import { DialogSpecimen } from './design-system/DialogSpecimen'
import { BranchWorkspaceSpecimen } from './design-system/BranchWorkspaceSpecimen'
import { TooltipProvider } from './components/ui/tooltip'
import { RepositoryHoverCardProvider } from './components/repository-hover-cards'
import './styles.css'

const route = window.location.hash
const specimen = ['#/design-system-specimen', '#/design-system-controls'].includes(route)
const shellSpecimen = route === '#/design-system-shell-specimen'
const dialogSpecimen = route === '#/design-system-dialog-specimen'
const branchSpecimen = route === '#/design-system-branch-specimen'
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
        ) : dialogSpecimen ? (
          <DialogSpecimen />
        ) : branchSpecimen ? (
          <BranchWorkspaceSpecimen />
        ) : (
          <App />
        )}
      </RepositoryHoverCardProvider>
    </TooltipProvider>
  </React.StrictMode>,
)
