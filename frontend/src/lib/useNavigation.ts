import { useMemo } from 'react'
import { isRouteEnabled, primarySidebarRoutes, utilitySidebarRoutes } from '../appRoutes'
import { useApi } from './hooks'

export interface McConfig {
  name?: string
  subtitle?: string
  modules?: Record<string, boolean>
}

/** Navigation routes filtered by the enabled modules in `/api/config`. */
export function useNavigation() {
  const { data, error } = useApi<McConfig>('/api/config')
  // A failed config read must not hide navigation: fall back to every route.
  const modules = data?.modules ?? null
  const primary = useMemo(
    () => (modules ? primarySidebarRoutes.filter((route) => isRouteEnabled(route, modules)) : primarySidebarRoutes),
    [modules],
  )
  const utility = useMemo(
    () => (modules ? utilitySidebarRoutes.filter((route) => isRouteEnabled(route, modules)) : utilitySidebarRoutes),
    [modules],
  )
  return { name: data?.name || 'Mission Control', configError: error, primary, utility }
}
