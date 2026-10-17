import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DesktopAPI } from '@git-stacks/shared/types'
import type { UpdateStatus } from '@git-stacks/shared/update'

export const UPDATE_STATUS_QUERY_KEY = ['update-status'] as const

/**
 * App-wide update status query and push listener.
 *
 * Maintains a single, continuous status cache across the entire application
 * lifecycle rather than subscribing and unsubscribing only while Settings is open.
 */
export function useUpdateStatus(desktop: DesktopAPI | null) {
  const client = useQueryClient()

  const query = useQuery<UpdateStatus | null>({
    queryKey: UPDATE_STATUS_QUERY_KEY,
    queryFn: () => (desktop?.updateStatus ? desktop.updateStatus() : Promise.resolve(null)),
    enabled: Boolean(desktop?.updateStatus),
    staleTime: Infinity,
  })

  React.useEffect(() => {
    if (!desktop?.onUpdateStatus) return
    const unsubscribe = desktop.onUpdateStatus((status) => {
      void client.cancelQueries({ queryKey: UPDATE_STATUS_QUERY_KEY }).then(() => {
        client.setQueryData(UPDATE_STATUS_QUERY_KEY, status)
      })
    })
    return () => {
      unsubscribe()
    }
  }, [desktop, client])

  return query
}
