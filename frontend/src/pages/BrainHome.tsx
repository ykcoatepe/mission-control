import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ErrorState, Page, Skeleton, Tabs, resolveTab } from '../components/ui'
import { useApi } from '../lib/hooks'
import { ActionConfirmDialog } from './brain/ActionConfirmDialog'
import { ActionResultPanel } from './brain/ActionResultPanel'
import { ActionStatusNotice } from './brain/ActionStatusNotice'
import { HealthView, type BrainData } from './brain/HealthView'
import { KnowledgeView } from './brain/KnowledgeView'
import { VerdictLine } from './brain/VerdictLine'
import { buildBrainModel, deriveVerdict, startSentence } from './brain/lib'
import { resolveTimeline } from './brain/BrainHomeState'
import { useGBrainActions } from './brain/useGBrainActions'
import styles from './brain/BrainHome.module.css'
import type {
  HealthReading,
  Meta,
  OperationsOverview,
  SourcesReading,
  SynopticEnvelope,
  TimelineReading,
} from './brain/types'

const VIEW_TABS = [
  { id: 'health', label: 'Health' },
  { id: 'knowledge', label: 'Knowledge' },
]

const POLL_MS = 30_000
const CHECK_ACTION = 'doctor-fast'

const FAILED_META: Meta = { ok: false, stale: true, observedAt: null, ageMs: null, error: null }
const FAILED_HEALTH: HealthReading = { ok: false, meta: FAILED_META }

export default function BrainHome() {
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  // /gbrain?q=term opens the Knowledge view.
  const defaultView = params.get('q') ? 'knowledge' : 'health'
  const view = resolveTab(VIEW_TABS, params.get('view'), defaultView)

  const synoptic = useApi<SynopticEnvelope>('/api/gbrain/synoptic', POLL_MS)
  const health = useApi<HealthReading>('/api/gbrain/health', POLL_MS)
  const sources = useApi<SourcesReading>('/api/gbrain/sources', POLL_MS)
  const timeline = useApi<TimelineReading>('/api/gbrain/timeline?limit=50', 2 * POLL_MS)
  const overview = useApi<OperationsOverview>('/api/operations/overview', POLL_MS)

  const envelope = synoptic.data
  const syn = envelope?.data ?? null
  const synopticFailed = Boolean(synoptic.error)
  const meta = useMemo<Meta | null>(
    () => (envelope ? { ...envelope.meta, stale: envelope.meta.stale || synopticFailed } : null),
    [envelope, synopticFailed],
  )
  const healthArg: HealthReading | null | undefined = health.data ?? (health.error ? FAILED_HEALTH : undefined)
  const sourcesArg = sources.data && sources.data.ok !== false ? sources.data : null
  const capabilities = overview.data?.capabilities ?? null

  const model = useMemo(() => (syn ? buildBrainModel(syn) : null), [syn])
  // The verdict is the payload's `verdict { state, reasons[] }`, formatted. Nothing here decides a second one.
  const verdict = useMemo(() => deriveVerdict(syn, meta), [syn, meta])
  const timelineReading = resolveTimeline({
    data: timeline.data,
    failed: Boolean(timeline.error),
    loading: timeline.loading,
  })

  const reading = meta ? { observedAt: meta.observedAt, fresh: meta.ok && !meta.stale } : null
  const actions = useGBrainActions({
    capabilities,
    reading,
    refreshReadings: () =>
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[1]
          return (
            query.queryKey[0] === 'api' &&
            typeof key === 'string' &&
            (key.startsWith('/api/gbrain/synoptic') ||
              key.startsWith('/api/gbrain/health') ||
              key.startsWith('/api/gbrain/sources') ||
              key.startsWith('/api/gbrain/timeline') ||
              key.startsWith('/api/operations/overview') ||
              key.startsWith('/api/signals'))
          )
        },
      }),
  })

  const checkAction = capabilities?.find((capability) => capability.id === CHECK_ACTION)
  const data: BrainData | null =
    syn && model
      ? {
          syn,
          model,
          verdict,
          health: healthArg,
          sources: sourcesArg,
          timeline: timelineReading.reading,
          timelineStale: timelineReading.state === 'stale',
          observedAt: meta?.observedAt ?? null,
          capabilities,
        }
      : null

  const attentionReason = verdict.conditions.find((condition) => condition.state !== 'inactive')
  const confirmContext = {
    state: verdict.state,
    observedAt: meta?.observedAt ?? null,
    stale: Boolean(meta?.stale),
    note: attentionReason ? `${startSentence(attentionReason.text)}.` : null,
  }

  const head = (
    <div className={styles.head}>
      {synoptic.loading ? (
        <Skeleton lines={2} label="Reading GBrain" />
      ) : (
        <VerdictLine
          verdict={verdict}
          probeAt={meta?.observedAt ?? null}
          caveat={verdict.caveat}
          stale={Boolean(meta?.stale)}
          verifying={actions.verifying}
          onRunCheck={checkAction ? () => actions.request(checkAction) : undefined}
          runCheckDisabled={!checkAction?.enabled || actions.running !== null}
          running={actions.running === CHECK_ACTION}
        />
      )}
      {actions.status && <ActionStatusNotice status={actions.status} />}
      <Tabs tabs={VIEW_TABS} ariaLabel="Brain views" queryParam="view" defaultValue={defaultView} />
    </div>
  )

  return (
    <Page title="Brain" tabs={head}>
      {actions.report && <ActionResultPanel report={actions.report} onDismiss={actions.dismissReport} />}
      {view === 'knowledge' ? (
        <KnowledgeView />
      ) : synoptic.loading ? (
        <Skeleton variant="block" size="lg" label="Reading GBrain" />
      ) : !data ? (
        <ErrorState
          title={synoptic.failure?.status === 503 ? 'GBrain has no reading yet' : 'GBrain could not be read'}
          message={`${synoptic.error ?? 'The synoptic reading is not available'}. Nothing is shown as normal.`}
          onRetry={() => void synoptic.refetch()}
        />
      ) : (
        <HealthView data={data} running={actions.running} onRun={actions.request} />
      )}
      <ActionConfirmDialog
        action={actions.pending}
        context={confirmContext}
        onCancel={actions.cancel}
        onConfirm={actions.confirm}
      />
    </Page>
  )
}
