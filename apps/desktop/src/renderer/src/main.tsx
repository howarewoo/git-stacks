import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRendererQueryClient } from './lib/query-client'
import App from './App'
import { TooltipProvider } from './components/ui/tooltip'
import './styles.css'

const queryClient = createRendererQueryClient()
const root = document.getElementById('root')

if (!root) {
  throw new Error('Git Stacks renderer root is missing')
}

createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={450} timeout={150}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
