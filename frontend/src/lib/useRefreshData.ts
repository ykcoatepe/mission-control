import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

/** Refetch every API query that is currently on screen (GETs the app already makes). */
export function useRefreshData() {
  const queryClient = useQueryClient()
  const fetching = useIsFetching({ queryKey: ['api'] })
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['api'] })
  }, [queryClient])
  return { refresh, refreshing: fetching > 0 }
}
