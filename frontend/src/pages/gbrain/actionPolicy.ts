import type { SafetyClass } from '../brain/types'

export interface GBrainActionCapability {
  id: string
  safetyClass: SafetyClass
  requiresConfirmation: boolean
  enabled?: boolean
}

export type GBrainActionStartMode = 'direct' | 'confirmed'

export function canStartGBrainAction(
  action: GBrainActionCapability,
  mode: GBrainActionStartMode,
  runningAction: string | null,
) {
  if (runningAction || action.enabled === false || action.safetyClass === 'W2') return false
  if (mode === 'direct') {
    return action.safetyClass === 'R0' && !action.requiresConfirmation
  }
  return action.safetyClass === 'W1' && action.requiresConfirmation
}

export function resolveGBrainAction<T extends GBrainActionCapability>(
  actions: T[],
  actionId: string,
  mode: GBrainActionStartMode,
  runningAction: string | null,
) {
  const current = actions.find((action) => action.id === actionId)
  return current && canStartGBrainAction(current, mode, runningAction) ? current : null
}

export function visibleGBrainActions<T extends GBrainActionCapability>(actions: T[]) {
  return actions.filter((action) => action.safetyClass !== 'W2')
}
