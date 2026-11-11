import { useMemo } from 'react'
import { isRouteEnabled, primarySidebarRoutes, utilitySidebarRoutes } from '../appRoutes'
import { useApi } from './hooks'

/**
 * GET /api/config is an allowlist (server/core/config.js PUBLIC_MC_SCHEMA): only
 * these fields exist, and any of them can be missing. Nothing else is ever there,
 * so no page may read another field from it.
 */
export interface PublicConfig {
  name?: string
  subtitle?: string
  modules?: Record<string, boolean>
  aws?: { enabled?: boolean }
}
export type McConfig = PublicConfig

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
