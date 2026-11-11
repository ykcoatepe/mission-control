import { useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { postGBrainAction } from '../gbrain/api'
import { readActionReport, type ActionReport } from '../gbrain/report'
import {
  canStartAction,
  hasFreshReadingAdvanced,
  resolveActionSuccessPolicy,
  resolveCurrentConfirmedW1,
  resolvePendingActionResult,
  type ActionStartMode,
} from './BrainHomeState'
import type { ActionStatus, OperationCapability } from './types'

export interface CurrentReading {
  observedAt: string | null
  fresh: boolean
}

const VERIFY_POLL_MS = 10_000

type ActionRun = {
  capability: OperationCapability
  previousObservedAt: string | null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'GBrain action failed'
}

/**
 * The one action flow. Check actions run directly; Change actions always wait
 * for a confirmation that re-resolves the current capability. One action at a
 * time. After a successful action the status stays "verifying" until a newer,
 * fresh reading arrives; that is derived from the readings, never assumed.
 */
export function useGBrainActions({
  capabilities,
  reading,
  refreshReadings,
}: {
  capabilities: OperationCapability[] | null
  reading: CurrentReading | null
  refreshReadings: () => Promise<unknown>
}) {
  const [pending, setPending] = useState<OperationCapability | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [status, setStatus] = useState<ActionStatus | null>(null)
  // What the last check found: stays until it is dismissed or the next action starts.
  const [report, setReport] = useState<ActionReport | null>(null)
  // Reading time before the action; `undefined` when no verification is waiting.
  const [baseline, setBaseline] = useState<string | null | undefined>(undefined)
  const executionRef = useRef<string | null>(null)

  const startVerifying = (run: ActionRun) => {
    setBaseline(run.previousObservedAt)
    void refreshReadings().catch(() => undefined)
  }

  const mutation = useMutation({
    mutationFn: ({ capability }: ActionRun) => postGBrainAction(capability.id, capability.requiresConfirmation),
    onMutate: ({ capability }) => {
      setRunning(capability.id)
      setBaseline(undefined)
      setReport(null)
      setStatus({ state: 'running', message: `${capability.label} is running` })
    },
    onSuccess: (result, run) => {
      const found = readActionReport(result, run.capability.label)
      // The panel carries the sentence; the notice only says the check finished (and, for findings, never "failed").
      const policy = resolveActionSuccessPolicy(found ? { ...result, summary: `${found.label} finished` } : result)
      if (found) setReport(found)
      setStatus(policy.status)
      if (policy.shouldRefreshReading) startVerifying(run)
    },
    onError: (error) => {
      const pendingResult = resolvePendingActionResult(error)
      if (pendingResult) {
        setStatus({
          state: 'pending-reading',
          message: pendingResult.summary || pendingResult.error || 'Action timed out; cleanup is still running',
        })
        if (pendingResult.refreshAfter === true) void refreshReadings().catch(() => undefined)
        return
      }
      setStatus({ state: 'failed', message: errorMessage(error) })
    },
    onSettled: () => {
      executionRef.current = null
      setRunning(null)
      setPending(null)
    },
  })

  const begin = (capability: OperationCapability, mode: ActionStartMode) => {
    if (!canStartAction(capability, mode, executionRef.current)) return
    executionRef.current = capability.id
    setPending(null)
    mutation.mutate({ capability, previousObservedAt: reading?.observedAt ?? null })
  }

  /** Check runs now; Change opens the confirmation. Anything else is refused. */
  const request = (capability: OperationCapability) => {
    if (executionRef.current || mutation.isPending) return
    if (capability.safetyClass === 'W1') {
      if (!canStartAction(capability, 'confirmed', null)) {
        setStatus({ state: 'failed', message: 'Action was not started because its confirmation policy is unavailable' })
        return
      }
      setPending(capability)
      return
    }
    if (capability.safetyClass === 'R0') begin(capability, 'direct')
  }

  const confirm = () => {
    if (!pending || executionRef.current || mutation.isPending) return
    if (!capabilities) {
      setPending(null)
      setStatus({ state: 'failed', message: 'Action was not started because the current capabilities could not be read' })
      return
    }
    const current = resolveCurrentConfirmedW1(capabilities, pending.id)
    if (!current) {
      setPending(null)
      setStatus({ state: 'failed', message: 'Action was not started because its current policy changed' })
      return
    }
    begin(current, 'confirmed')
  }

  const cancel = useCallback(() => setPending(null), [])
  const dismissReport = useCallback(() => setReport(null), [])

  const advanced =
    status?.state === 'verifying' && baseline !== undefined && hasFreshReadingAdvanced(baseline, reading)
  const shownStatus: ActionStatus | null = advanced
    ? { state: 'verified', message: 'Action completed and a newer reading has arrived' }
    : status

  const verifying = shownStatus?.state === 'verifying'
  const refreshRef = useRef(refreshReadings)
  useEffect(() => {
    refreshRef.current = refreshReadings
  })
  // The reading has caught up: the shell's signals (top bar, sidebar) are read again at once, not on their next poll.
  const resolved = shownStatus?.state === 'verified'
  useEffect(() => {
    if (resolved) void refreshRef.current().catch(() => undefined)
  }, [resolved])
  // The backend refreshes on its own schedule: keep asking until a newer reading arrives.
  useEffect(() => {
    if (!verifying) return
    const timer = setInterval(() => {
      void refreshRef.current().catch(() => undefined)
    }, VERIFY_POLL_MS)
    return () => clearInterval(timer)
  }, [verifying])

  return {
    pending,
    running,
    status: shownStatus,
    report,
    dismissReport,
    verifying,
    request,
    confirm,
    cancel,
  }
}

export type GBrainActions = ReturnType<typeof useGBrainActions>
