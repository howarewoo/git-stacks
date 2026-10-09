import { useMutation, useQueryClient, type MutationFunction } from '@tanstack/react-query'
import type { SettingsSnapshot } from '@git-stacks/shared/settings'

/** Keep writes concurrent so a host change can retire pending consent. */
export function useSettingsMutation<TVariables = void>(
  mutationFn: MutationFunction<SettingsSnapshot, TVariables>,
  canAdopt?: (variables: TVariables) => boolean,
) {
  const client = useQueryClient()
  return useMutation({
    mutationKey: ['settings-write'],
    mutationFn,
    onSuccess: async (_confirmed, variables) => {
      if (canAdopt?.(variables) === false) return
      await client.cancelQueries({ queryKey: ['settings'], exact: true })
      if (canAdopt?.(variables) === false) return
      // Main's settings and updater queues can commit concurrent writes out of submission order.
      await client.invalidateQueries({ queryKey: ['settings'], exact: true })
    },
  })
}
