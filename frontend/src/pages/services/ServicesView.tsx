import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlarmLine,
  Block,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterChips,
  Freshness,
  Mono,
  Notice,
  SearchInput,
  Skeleton,
  StateMark,
  StatePill,
} from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import { useApi } from '../../lib/hooks'
import { SIGNALS_POLL_MS, SIGNALS_URL } from '../../lib/signals'
import type { SignalsEnvelope } from '../../lib/signals'
import {
  GATEWAY_READINGS_ID,
  endpointReading,
  filterCounts,
  filterServices,
  kindLabel,
  parseServiceFilter,
  quietLines,
  scheduleNote,
  serviceAlarm,
  serviceHint,
  serviceStatus,
  servicesVerdict,
} from './lib'
import type { AlarmTarget } from './lib'
import type { Endpoint, ServiceFilter, ServiceRow, ServicesEnvelope } from './types'
import styles from './ServicesView.module.css'

const POLL_MS = 15_000

const SERVICE_COLUMNS: DataTableColumn<ServiceRow>[] = [
  {
    key: 'label',
    header: 'Service',
    cell: (row) => {
      // The explanation sits under the name, on its own line, so the table needs no wide Note column.
      const hint = serviceHint(row)
      return (
        <div className={styles.service}>
          <Mono className={styles.label}>{row.label}</Mono>
          {hint && <span className={styles.hint}>{hint}</span>}
        </div>
      )
    },
  },
  {
    key: 'state',
    header: 'State',
    width: '120px',
    cell: (row) => {
      const status = serviceStatus(row)
      return <StatePill state={status.state} label={status.label} />
    },
  },
  {
    key: 'kind',
    header: 'Kind',
    cell: (row) => {
      const kind = kindLabel(row.kind)
      const note = scheduleNote(row)
      if (!kind) return <span className={styles.kind}>{row.identified === false ? 'Unidentified' : '—'}</span>
      return (
        <span className={styles.kind}>
          {kind}
          {note && <span className={styles.muted}>{note}</span>}
        </span>
      )
    },
  },
  {
    key: 'pid',
    header: 'PID',
    align: 'end',
    width: '88px',
    cell: (row) => (row.pid === null || row.pid === undefined ? <span className={styles.muted}>—</span> : <Mono className={styles.label}>{row.pid}</Mono>),
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
        <Mono muted={row.lastExitCode === 0} className={styles.label}>
          {row.lastExitCode}
        </Mono>
      ),
  },
]

interface EndpointRow {
  id: string
  name: string
  endpoint: Endpoint | null | undefined
}

/** Where the reading came from, only when it is stale or unread (HMI rule 8); a fresh reading says nothing. */
function EndpointNote({ endpoint }: { endpoint: Endpoint | null | undefined }) {
  const reading = endpointReading(endpoint)
  if (reading.state === 'unavailable') return null
  const error = reading.state === 'critical' && typeof endpoint?.error === 'string' ? endpoint.error.trim() : ''
  return (
    <span className={styles.endpointNote}>
      {error && <span>{error}</span>}
      <Freshness
        observedAt={reading.at}
        state={reading.state === 'warning' ? 'stale' : undefined}
        staleAfterMs={5 * 60_000}
      />
    </span>
  )
}

const ENDPOINT_COLUMNS: DataTableColumn<EndpointRow>[] = [
  {
    key: 'name',
    header: 'Endpoint',
    cell: (row) => <span className={styles.label}>{row.name}</span>,
  },
  {
    key: 'state',
    header: 'State',
    width: '120px',
    cell: (row) => {
      const reading = endpointReading(row.endpoint)
      return <StatePill state={reading.state} label={reading.word} />
    },
  },
  {
    key: 'reading',
    header: 'Reading',
    cell: (row) => <EndpointNote endpoint={row.endpoint} />,
  },
]

export default function ServicesView() {
  const navigate = useNavigate()
  const { data: envelope, loading, error, refetch } = useApi<ServicesEnvelope>('/api/services', POLL_MS)
  // The shell's reading of the gateways: the verdict must not contradict the top bar.
  const { data: signalsEnvelope } = useApi<SignalsEnvelope>(SIGNALS_URL, SIGNALS_POLL_MS)
  const gatewaySystems = signalsEnvelope?.data?.systems ?? null

  // Filter and search live in the URL (?filter=down&q=ollama) so a view can be shared or reloaded.
  const [params, setParams] = useSearchParams()
  const filter = parseServiceFilter(params.get('filter'))
  const query = params.get('q') ?? ''
  const setQueryParam = (key: 'filter' | 'q', value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === '' || value === 'all') next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )
  const setFilter = (value: ServiceFilter) => setQueryParam('filter', value)
  const setQuery = (value: string) => setQueryParam('q', value)

  const data = envelope?.data ?? null
  const rows = useMemo<ServiceRow[]>(() => (Array.isArray(data?.services) ? data.services : []), [data])
  const visible = useMemo(() => filterServices(rows, filter, query), [rows, filter, query])
  const counts = useMemo(() => filterCounts(rows, data?.summary), [rows, data])
  const verdict = useMemo(() => servicesVerdict(data, gatewaySystems), [data, gatewaySystems])
  const alarm = useMemo(() => serviceAlarm(verdict, data, filter), [verdict, data, filter])
  const quiet = useMemo(() => quietLines(verdict), [verdict])

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
    { value: 'all', label: 'All', count: counts.all ?? undefined },
    { value: 'down', label: 'Down', count: counts.down ?? undefined },
    { value: 'unidentified', label: 'Unidentified', count: counts.unidentified ?? undefined },
    { value: 'keepalive', label: 'Keepalive', count: counts.keepalive ?? undefined },
    { value: 'interval', label: 'Interval', count: counts.interval ?? undefined },
    { value: 'one-shot', label: 'One-shot', count: counts['one-shot'] ?? undefined },
  ]
  const filtered = filter !== 'all' || query.trim() !== ''

  const endpointRows: EndpointRow[] = [
    { id: 'openclaw', name: 'OpenClaw gateway', endpoint: data.gateways?.openclaw },
    { id: 'hermes', name: 'Hermes gateway', endpoint: data.gateways?.hermes },
    { id: 'ollama', name: 'Ollama', endpoint: data.ollama },
  ]

  const runAlarmAction = (target: AlarmTarget) => {
    if (target.kind === 'filter') {
      setFilter(target.filter)
    } else if (target.link.kind === 'anchor') {
      document.getElementById(GATEWAY_READINGS_ID)?.scrollIntoView?.({ block: 'start' })
    } else {
      navigate(target.link.to)
    }
  }

  const showFreshness = Boolean(observedAt) || stale

  return (
    <>
      {alarm && (
        <AlarmLine
          state={alarm.state}
          title={alarm.title}
          detail={alarm.detail ?? undefined}
          action={alarm.action ? { label: alarm.action.label, onClick: () => runAlarmAction(alarm.action!) } : undefined}
        />
      )}

      <div className={styles.verdict}>
        {quiet.length > 0 && (
          <ul className={styles.verdictLines} aria-label="Verdict">
            {quiet.map((entry) => (
              <li key={entry.text} className={styles.verdictLine} data-state={entry.state}>
                <StateMark state={entry.state} />
                <span className={styles.verdictText}>{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.verdictDetail}>
          {verdict.detail}
          {showFreshness && (
            <Freshness observedAt={observedAt} state={stale ? 'stale' : undefined} staleAfterMs={120_000} className={styles.fresh} />
          )}
        </p>
        {verdict.note && (
          <p className={styles.verdictNote}>
            {verdict.note.text}{' '}
            <Button size="sm" variant="ghost" onClick={() => setFilter(verdict.note!.filter)}>
              {verdict.note.actionLabel}
            </Button>
          </p>
        )}
      </div>

      {error && (
        <Notice tone="warning" title="The latest read failed">
          Showing the previous reading until the next read succeeds.
        </Notice>
      )}

      <Block id={GATEWAY_READINGS_ID} className={styles.readings} title="Reachability" padding="none">
        <DataTable
          caption="Reachability"
          columns={ENDPOINT_COLUMNS}
          rows={endpointRows}
          rowKey={(row) => row.id}
          maxHeight="none"
        />
      </Block>

      <div className={styles.toolbar}>
        <FilterChips
          ariaLabel="Filter services"
          options={options}
          value={filter}
          onChange={(value) => setFilter(parseServiceFilter(value))}
        />
        <SearchInput className={styles.search} value={query} onChange={setQuery} label="Search services" />
      </div>

      <Block
        title="Services"
        meta={
          <span aria-live="polite">
            {filtered ? `Showing ${visible.length} of ${rows.length}` : `${rows.length} ${rows.length === 1 ? 'service' : 'services'}`}
          </span>
        }
        padding="none"
      >
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
      </Block>
    </>
  )
}
