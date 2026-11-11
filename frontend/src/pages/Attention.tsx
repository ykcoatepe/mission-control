import { ErrorState, Freshness, Page, Skeleton } from '../components/ui'
import { useApi } from '../lib/hooks'
import AttentionView from './attention/AttentionView'
import { errorText } from './attention/lib'
import type { Envelope, LoopsData } from './attention/types'

const POLL_MS = 30_000

export default function Attention() {
  const { data: envelope, loading, error, refetch } = useApi<Envelope<LoopsData>>('/api/loops', POLL_MS)
  const data = envelope?.data ?? null
  const meta = envelope?.meta ?? null

  return (
    <Page
      title="Attention"
      description="What needs you across your manager loops?"
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
        <AttentionView data={data} meta={meta} refreshError={error} onRetry={refetch} />
      )}
    </Page>
  )
}
