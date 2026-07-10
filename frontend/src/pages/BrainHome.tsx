import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import PageTransition from '../components/PageTransition'
import { useApi } from '../lib/hooks'
import { postGBrainAction } from './gbrain/api'
import { ActionConfirmDialog } from './brain/ActionConfirmDialog'
import {
  ActionStatusBanner,
  BrainHomeError,
  BrainHomeSkeleton,
} from './brain/BrainHomeState'
import { DecisionInbox } from './brain/DecisionInbox'
import { EvidenceDrawer } from './brain/EvidenceDrawer'
import { EvidenceTimeline } from './brain/EvidenceTimeline'
import { GBrainTriggerShelf } from './brain/GBrainTriggerShelf'
import { GlobalSearch } from './brain/GlobalSearch'
import { LivingBrainMap } from './brain/LivingBrainMap'
import { selectionFromAttention, selectionFromEvidence, selectionFromSystem } from './brain/lib'
import styles from './brain/BrainHome.module.css'
import { SystemStatusRail } from './brain/SystemStatusRail'
import type {
  ActionStatus,
  DrawerSelection,
  OperationCapability,
  OperationSystem,
  OperationsOverview,
} from './brain/types'

type ActionRun = {
  capability: OperationCapability
  previousObservedAt: string | null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'GBrain action failed'
}

function hasFreshProofAdvanced(
  previousObservedAt: string | null,
  nextProof: Pick<OperationSystem, 'observedAt' | 'freshness'> | null | undefined,
) {
  if (!nextProof?.observedAt || nextProof.freshness !== 'fresh') return false
  if (!previousObservedAt) return true
  if (nextProof.observedAt === previousObservedAt) return false

  const previousTime = Date.parse(previousObservedAt)
  const nextTime = Date.parse(nextProof.observedAt)
  return Number.isFinite(previousTime) && Number.isFinite(nextTime) && nextTime > previousTime
}

export default function BrainHome() {
  const queryClient = useQueryClient()
  const { data, loading, error, refetch } = useApi<OperationsOverview>(
    '/api/operations/overview',
    30_000,
  )
  const [selection, setSelection] = useState<DrawerSelection | null>(null)
  const [pendingAction, setPendingAction] = useState<OperationCapability | null>(null)
  const [runningAction, setRunningAction] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  const executionRef = useRef<string | null>(null)

  const actionMutation = useMutation({
    mutationFn: ({ capability }: ActionRun) => postGBrainAction(capability.id),
    onMutate: ({ capability }) => {
      setRunningAction(capability.id)
      setActionStatus({ state: 'running', message: `${capability.label} is running` })
    },
    onSuccess: async (result, run) => {
      setActionStatus({
        state: 'verifying',
        message: `${result.summary || 'Action completed'} · loading fresh Operations proof`,
      })

      try {
        await queryClient.invalidateQueries({ queryKey: ['api', '/api/gbrain/overview'] })
        await queryClient.invalidateQueries({
          queryKey: ['api', '/api/operations/overview'],
          refetchType: 'none',
        })
        const refreshed = await refetch()
        const nextGBrain = refreshed.data?.systems.gbrain
        const proofAdvanced = !refreshed.error
          && hasFreshProofAdvanced(run.previousObservedAt, nextGBrain)

        setActionStatus({
          state: proofAdvanced ? 'verified' : 'pending-proof',
          message: proofAdvanced
            ? 'Action completed and newer fresh GBrain proof loaded'
            : 'Action completed; newer fresh GBrain proof is pending or unavailable',
        })
      } catch {
        setActionStatus({
          state: 'pending-proof',
          message: 'Action completed; Operations proof could not be refreshed',
        })
      }
    },
    onError: (mutationError) => {
      setActionStatus({ state: 'failed', message: errorMessage(mutationError) })
    },
    onSettled: () => {
      executionRef.current = null
      setRunningAction(null)
      setPendingAction(null)
    },
  })

  const closePendingAction = useCallback(() => setPendingAction(null), [])

  const beginAction = (capability: OperationCapability) => {
    if (!data || executionRef.current || !capability.enabled) return
    if (capability.safetyClass === 'W2') return

    executionRef.current = capability.id
    setPendingAction(null)
    actionMutation.mutate({
      capability,
      previousObservedAt: data.systems.gbrain.observedAt,
    })
  }

  const requestAction = (capability: OperationCapability, trigger: HTMLButtonElement) => {
    if (executionRef.current || actionMutation.isPending || !capability.enabled) return
    if (capability.safetyClass === 'W2') return

    returnFocusRef.current = trigger
    if (capability.safetyClass === 'W1') {
      setPendingAction(capability)
      return
    }
    if (capability.safetyClass === 'R0') beginAction(capability)
  }

  const confirmAction = () => {
    if (!pendingAction || pendingAction.safetyClass !== 'W1') return
    beginAction(pendingAction)
  }

  if (loading) return <BrainHomeSkeleton />
  if (error || !data) {
    return (
      <BrainHomeError
        message={error || 'Operations overview did not return evidence.'}
        onRetry={() => { void refetch() }}
      />
    )
  }

  return (
    <PageTransition>
      <div className={styles.page}>
        <header className={styles.pageHeader}>
          <div className={styles.pageTitle}>
            <span>Mission Control</span>
            <h1>Shared Brain</h1>
            <p>OpenClaw, Hermes, and GBrain evidence in one read-first surface.</p>
          </div>
          <GlobalSearch overview={data} />
        </header>

        <SystemStatusRail
          systems={[data.systems.gbrain, data.systems.hermes, data.systems.openclaw]}
        />

        <div className={styles.primaryGrid}>
          <LivingBrainMap
            overview={data}
            onSelectSystem={(system) => setSelection(selectionFromSystem(system))}
          />
          <DecisionInbox
            items={data.attention}
            onSelect={(item) => setSelection(selectionFromAttention(item, data.evidence))}
          />
        </div>

        <GBrainTriggerShelf
          actions={data.capabilities}
          runningAction={runningAction}
          onRequestRun={requestAction}
        />
        <EvidenceTimeline
          evidence={data.evidence}
          onSelect={(item) => setSelection(selectionFromEvidence(item))}
        />
        <EvidenceDrawer selection={selection} onClose={() => setSelection(null)} />
        <ActionConfirmDialog
          action={pendingAction}
          proof={data.systems.gbrain}
          returnFocusRef={returnFocusRef}
          onCancel={closePendingAction}
          onConfirm={confirmAction}
        />
        {actionStatus ? <ActionStatusBanner status={actionStatus} /> : null}
      </div>
    </PageTransition>
  )
}
