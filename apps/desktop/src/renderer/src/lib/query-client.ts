import { QueryClient } from '@tanstack/react-query'

/** Main owns polling and connectivity; local IPC must also run while offline. */
export function createRendererQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'always',
        retry: false,
        // Snapshot identity also signals file-content changes absent from its summary.
        structuralSharing: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        gcTime: 0,
      },
      mutations: {
        networkMode: 'always',
        retry: false,
        gcTime: 0,
      },
    },
  })
}
