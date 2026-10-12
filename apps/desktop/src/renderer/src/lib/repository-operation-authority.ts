import * as React from 'react'
import { CancelledError, useQuery, useQueryClient } from '@tanstack/react-query'
import { canonicalHostName } from '@git-stacks/shared/host'
import { cliAuthority, type OperationScope } from '@git-stacks/shared/operation-scope'
import type { DesktopAPI, RepositorySnapshot } from '@git-stacks/shared/types'

export function useRepositoryOperationAuthority(
  desktop: DesktopAPI | null | undefined,
  snapshot: RepositorySnapshot | null,
): string | null {
  const queryClient = useQueryClient()
  const path = snapshot?.path ?? null
  const remote = snapshot?.remoteUrl ?? null
  const key = React.useMemo(
    () => ['repository-operation-scope', path, remote] as const,
    [path, remote],
  )
  const scopeRef = React.useRef<OperationScope | null>(null)
  const query = useQuery({
    queryKey: key,
    enabled: !!desktop && path !== null,
    queryFn: async ({ signal }) => {
      const scope = await desktop!.repositoryOperationScope()
      if (signal.aborted || scope.repositoryPath !== path || scope.remoteUrl !== remote) {
        throw new CancelledError()
      }
      scopeRef.current = scope
      return scope
    },
  })
  React.useEffect(() => {
    scopeRef.current = queryClient.getQueryData<OperationScope>(key) ?? null
    if (!desktop || path === null) return
    return desktop.onGitHubCliStatus?.((status) => {
      const scope = scopeRef.current
      const host = scope?.authority.split('|')[0]
      if (!scope || host === undefined) {
        // Until main resolves the origin, any host may be the one we need.
        void queryClient
          .cancelQueries({ queryKey: key, exact: true })
          .then(() => queryClient.refetchQueries({ queryKey: key, exact: true }))
        return
      }
      if (canonicalHostName(status.host) !== host) return
      // Retire outstanding reads before a late producer can revive this session.
      void queryClient.cancelQueries({ queryKey: key, exact: true })
      const next = { ...scope, authority: cliAuthority(host, status) }
      scopeRef.current = next
      queryClient.setQueryData(key, next)
    })
  }, [desktop, key, path, queryClient])
  return query.data?.authority ?? null
}
