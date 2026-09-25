import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { FoundationsSpecimen } from './design-system/FoundationsSpecimen'
import { TooltipProvider } from './components/ui/tooltip'
import { RepositoryHoverCardProvider } from './components/repository-hover-cards'
import './styles.css'

const specimen = ['#/design-system-specimen', '#/design-system-controls'].includes(
  window.location.hash,
)

const root = document.getElementById('root')

if (!root) {
  throw new Error('Git Stacks renderer root is missing')
}

createRoot(root).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={450} skipDelayDuration={150}>
      <RepositoryHoverCardProvider>
        {specimen ? <FoundationsSpecimen /> : <App />}
      </RepositoryHoverCardProvider>
    </TooltipProvider>
  </React.StrictMode>,
)
