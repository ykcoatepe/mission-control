import { ErrorState, Freshness, Page, Skeleton } from '../components/ui'
import { useApi } from '../lib/hooks'
import { SIGNALS_POLL_MS, SIGNALS_URL, attentionFrom, attentionReading } from '../lib/signals'
import type { SignalsEnvelope } from '../lib/signals'
import AttentionView from './attention/AttentionView'
import { errorText } from './attention/lib'
import type { Envelope, LoopsData } from './attention/types'

const POLL_MS = 30_000

export default function Attention() {
  const { data: envelope, loading, error, refetch } = useApi<Envelope<LoopsData>>('/api/loops', POLL_MS)
  // The attention number is the shell's: the same reading the top bar and the sidebar use (one shared request).
  const { data: signalsEnvelope } = useApi<SignalsEnvelope>(SIGNALS_URL, SIGNALS_POLL_MS)
  const data = envelope?.data ?? null
  // The same number as the pill and the badge. Only when the shell signal is not available does the page use the
  // loops reading's own copy of it (`totals.needsOperator`, the server's same function).
  const attention = attentionReading(signalsEnvelope?.data ?? null) ?? attentionFrom(data?.totals?.needsOperator)
  const meta = envelope?.meta ?? null

  return (
    <Page
      title="Attention"
      description="What needs you across your systems and manager loops?"
      actions={
        data && meta ? (
          <Freshness observedAt={meta.observedAt ?? data.observedAt} state={meta.stale ? 'stale' : undefined} />
        ) : undefined
      }
    >
      {loading && !envelope ? (
        <>
          <Skeleton variant="block" label="Loading summary" />
          <Skeleton lines={8} label="Loading attention list" />
        </>
      ) : error && !envelope ? (
        <ErrorState title="Manager loops could not be read" message={error} onRetry={refetch} />
      ) : !data || !meta ? (
        <ErrorState
          title="Manager loops could not be read"
          message={errorText(meta?.error) ?? 'No reading is available yet.'}
          onRetry={refetch}
        />
      ) : (
        <AttentionView data={data} meta={meta} attention={attention} refreshError={error} onRetry={refetch} />
      )}
    </Page>
  )
}
