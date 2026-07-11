/* eslint-disable react-refresh/only-export-components */
import styles from './BrainHome.module.css'
import type { ActionStatus, OperationCapability, OperationSystem } from './types'

export type ActionStartMode = 'direct' | 'confirmed'

type ActionSuccessResult = {
  refreshAfter?: boolean
  summary?: string
}

export function resolveActionSuccessPolicy(result: ActionSuccessResult): {
  shouldRefreshProof: boolean
  status: ActionStatus
} {
  const summary = result.summary || 'Action completed'
  if (result.refreshAfter !== true) {
    return {
      shouldRefreshProof: false,
      status: { state: 'complete', message: summary },
    }
  }

  return {
    shouldRefreshProof: true,
    status: {
      state: 'verifying',
      message: `${summary} · loading fresh Operations proof`,
    },
  }
}

export function hasFreshProofAdvanced(
  previousObservedAt: string | null,
  nextProof: Pick<OperationSystem, 'observedAt' | 'freshness'> | null | undefined,
) {
  if (!nextProof?.observedAt || nextProof.freshness !== 'fresh') return false

  const nextTime = Date.parse(nextProof.observedAt)
  if (!Number.isFinite(nextTime)) return false
  if (!previousObservedAt) return true
  if (nextProof.observedAt === previousObservedAt) return false

  const previousTime = Date.parse(previousObservedAt)
  return Number.isFinite(previousTime) && nextTime > previousTime
}

export function canStartAction(
  capability: OperationCapability,
  mode: ActionStartMode,
  activeActionId: string | null,
) {
  if (activeActionId || !capability.enabled || capability.safetyClass === 'W2') return false
  if (mode === 'direct') {
    return capability.safetyClass === 'R0' && !capability.requiresConfirmation
  }
  return capability.safetyClass === 'W1' && capability.requiresConfirmation
}

export function resolveCurrentConfirmedW1(
  capabilities: OperationCapability[],
  requestedActionId: string,
) {
  const current = capabilities.find((capability) => capability.id === requestedActionId)
  return current && canStartAction(current, 'confirmed', null) ? current : null
}

export function BrainHomeSkeleton() {
  return (
    <div className={styles.skeleton} aria-label="Loading shared brain evidence" aria-busy="true">
      <div />
      <div />
      <div />
    </div>
  )
}

export function BrainHomeError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className={styles.errorState} role="alert">
      <span>Evidence read failed</span>
      <h1>Shared Brain unavailable</h1>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>Retry evidence read</button>
    </section>
  )
}

export function ActionStatusBanner({ status }: { status: ActionStatus }) {
  return (
    <div className={styles.actionStatus} data-state={status.state} role="status" aria-live="polite">
      <strong>{status.state}</strong>
      <span>{status.message}</span>
    </div>
  )
}
