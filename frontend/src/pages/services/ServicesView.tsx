import { useMemo, useState } from 'react'
import {
  DataTable,
  EmptyState,
  ErrorState,
  FilterChips,
  Mono,
  Notice,
  Panel,
  SearchInput,
  Skeleton,
  Stat,
  StatePill,
  StateDot,
  StatRow,
  TimeAgo,
} from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import { useApi } from '../../lib/hooks'
import { filterCounts, filterServices, endpointReading, kindLabel, scheduleNote, serviceHint, serviceStatus, servicesVerdict } from './lib'
import type { EndpointReading } from './lib'
import type { Endpoint, ServiceFilter, ServiceRow, ServicesEnvelope } from './types'
import styles from './ServicesView.module.css'

const POLL_MS = 15_000

const SERVICE_COLUMNS: DataTableColumn<ServiceRow>[] = [
  {
    key: 'label',
    header: 'Service',
    cell: (row) => <Mono>{row.label}</Mono>,
  },
  {
    key: 'kind',
    header: 'Kind',
    cell: (row) => {
      const kind = kindLabel(row.kind)
      const note = scheduleNote(row)
      if (!kind) return <span className={styles.muted}>—</span>
      return (
        <span className={styles.kind}>
          {kind}
          {note && <span className={styles.muted}>{note}</span>}
        </span>
      )
    },
  },
  {
    key: 'state',
    header: 'State',
    width: '112px',
    cell: (row) => {
      const status = serviceStatus(row)
      return <StatePill state={status.state} label={status.label} />
    },
  },
  {
    key: 'pid',
    header: 'PID',
    align: 'end',
    width: '88px',
    cell: (row) => (row.pid === null || row.pid === undefined ? <span className={styles.muted}>—</span> : <Mono>{row.pid}</Mono>),
  },
  {
    key: 'exit',
    header: 'Last exit',
    align: 'end',
    width: '96px',
    cell: (row) =>
      row.lastExitCode === null || row.lastExitCode === undefined ? (
        <span className={styles.muted}>—</span>
      ) : (
        <Mono muted={row.lastExitCode === 0}>{row.lastExitCode}</Mono>
      ),
  },
  {
    key: 'note',
    header: 'Note',
    cell: (row) => {
      const hint = serviceHint(row)
      return hint ? <span className={styles.hint}>{hint}</span> : null
    },
  },
]

function reachabilityHint(reading: EndpointReading) {
  if (!reading.at) return 'not read'
  return (
    <>
      {reading.atLabel} <TimeAgo value={reading.at} />
    </>
  )
}

function ReachabilityStat({ label, endpoint }: { label: string; endpoint: Endpoint | null | undefined }) {
  const reading = endpointReading(endpoint)
  return <Stat label={label} value={reading.word} state={reading.state} hint={reachabilityHint(reading)} />
}

export default function ServicesView() {
  const { data: envelope, loading, error, refetch } = useApi<ServicesEnvelope>('/api/services', POLL_MS)
  const [filter, setFilter] = useState<ServiceFilter>('all')
  const [query, setQuery] = useState('')

  const data = envelope?.data ?? null
  const rows = useMemo<ServiceRow[]>(() => (Array.isArray(data?.services) ? data.services : []), [data])
  const visible = useMemo(() => filterServices(rows, filter, query), [rows, filter, query])
  const counts = useMemo(() => filterCounts(rows), [rows])
  const verdict = useMemo(() => servicesVerdict(data), [data])

  if (loading && !envelope) {
    return (
      <>
        <Skeleton variant="line" width="320px" label="Reading services" />
        <Skeleton variant="block" label="Loading reachability" />
        <Skeleton lines={8} label="Loading services" />
      </>
    )
  }

  if (!envelope && error) {
    return <ErrorState title="Services could not be read" message={error} onRetry={refetch} />
  }

  if (!data) {
    return (
      <ErrorState
        title="Services could not be read"
        message="The server has no reading of the launchd services or the gateways yet."
        onRetry={refetch}
      />
    )
  }

  const observedAt = envelope?.meta?.observedAt ?? null
  const stale = envelope?.meta?.stale === true
  const options = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'down', label: 'Down', count: counts.down },
    { value: 'keepalive', label: 'Keepalive', count: counts.keepalive },
    { value: 'interval', label: 'Interval', count: counts.interval },
    { value: 'one-shot', label: 'One-shot', count: counts['one-shot'] },
  ]
  const filtered = filter !== 'all' || query.trim() !== ''

  return (
    <>
      <div className={styles.verdict}>
        <p className={styles.verdictLine} data-state={verdict.state}>
          <StateDot state={verdict.state} />
          <span>{verdict.text}</span>
        </p>
        <p className={styles.verdictDetail}>
          {verdict.detail}
          {verdict.detail && observedAt && ' · '}
          {observedAt && (
            <>
              read <TimeAgo value={observedAt} />
            </>
          )}
        </p>
      </div>

      {(stale || error) && (
        <Notice tone="warning" title={error ? 'The latest read failed' : 'This reading is out of date'}>
          {error
            ? 'Showing the previous reading until the next read succeeds.'
            : 'The server could not refresh these services and is showing its last good reading.'}
        </Notice>
      )}

      <StatRow aria-label="Reachability">
        <ReachabilityStat label="OpenClaw gateway" endpoint={data.gateways?.openclaw} />
        <ReachabilityStat label="Hermes gateway" endpoint={data.gateways?.hermes} />
        <ReachabilityStat label="Ollama" endpoint={data.ollama} />
      </StatRow>

      <div className={styles.toolbar}>
        <FilterChips
          ariaLabel="Filter services"
          options={options}
          value={filter}
          onChange={(value) => setFilter(value as ServiceFilter)}
        />
        <div className={styles.toolbarEnd}>
          {filtered && (
            <span className={styles.count} aria-live="polite">
              Showing {visible.length} of {rows.length}
            </span>
          )}
          <SearchInput className={styles.search} value={query} onChange={setQuery} label="Search services" />
        </div>
      </div>

      <Panel padding="none">
        <DataTable
          caption="Launchd services"
          columns={SERVICE_COLUMNS}
          rows={visible}
          rowKey={(row) => row.label}
          empty={
            <EmptyState
              title={rows.length === 0 ? 'No services were found' : 'No services match'}
              description={
                rows.length === 0
                  ? 'The server read launchd but found none of the expected services.'
                  : 'No service matches the current search and filter.'
              }
            />
          }
        />
      </Panel>
    </>
  )
}
