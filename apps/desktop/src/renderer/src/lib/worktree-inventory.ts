import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DesktopAPI } from '@git-stacks/shared/types'
import type { InventoryRequest, WorktreeInventory } from '@git-stacks/shared/worktree-inventory'

/** Main owns registration, watchers and authority. This hook only retires view requests. */
export function useWorktreeInventory(
  api: DesktopAPI,
  context: string,
  selection?: Omit<InventoryRequest, 'requestId'>,
) {
  const client = useQueryClient()
  const key = ['worktree-inventory', context, selection?.selectedWorktreeId ?? null] as const
  const generation = useRef(-1)
  const [subscribed, setSubscribed] = useState<DesktopAPI | null>(null)
  const query = useQuery<WorktreeInventory, Error, WorktreeInventory | undefined>({
    queryKey: key,
    enabled: Boolean(api.worktreeInventory) && subscribed === api,
    placeholderData: (previous) => previous,
    // A remounted observer must hear main before exposing cached credential-owned facts.
    select: (value) =>
      subscribed !== api || generation.current < 0 || value.generation < generation.current
        ? undefined
        : value,
    queryFn: async ({ signal }) => {
      if (!api.worktreeInventory) throw new Error('Worktree inventory is unavailable')
      const id = `inventory-${crypto.randomUUID()}`
      const cancel = () => {
        void api.cancelInventory?.(id)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const value = await api.worktreeInventory({ requestId: id, ...selection })
        if (signal.aborted) throw new Error('Inventory request retired')
        if (value.generation < generation.current) {
          const published = client.getQueryData<WorktreeInventory>(key)
          if (published && published.generation >= generation.current) return published
          throw new Error('Inventory request retired')
        }
        generation.current = value.generation
        return value
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  })
  useEffect(() => {
    generation.current = -1
    const unsubscribe = api.onWorktreeInventory?.((value: WorktreeInventory) => {
      if (value.generation < generation.current) return
      generation.current = value.generation
      client.setQueriesData<WorktreeInventory>({ queryKey: ['worktree-inventory'] }, value)
    })
    setSubscribed(api)
    return () => {
      unsubscribe?.()
    }
  }, [api, client])
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true })
    },
    [api, client, context, selection?.selectedWorktreeId],
  )
  return query
}
