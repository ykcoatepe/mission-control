import { DataTable, EmptyState, Freshness, Panel, Skeleton, StatePill } from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import { formatCompactTokenValue, formatPreciseCurrency, formatTokenPhrase, NOT_READ } from './lib'
import type { ProviderRow } from './lib'
import styles from './ProvidersPanel.module.css'

export interface ProvidersPanelProps {
  /** "This month", "Today", "November 2026". */
  periodName: string
  rows: ProviderRow[]
  /** The payload on screen is for another period and has not been replaced yet. */
  pending?: boolean
}

const DASH = NOT_READ

/** A platform that recorded nothing this period has no figures: every number is a dash, never 0. */
function money(row: ProviderRow, value: number | null) {
  return row.noRecords ? DASH : formatPreciseCurrency(value)
}

export default function ProvidersPanel({ periodName, rows, pending = false }: ProvidersPanelProps) {
  const columns: DataTableColumn<ProviderRow>[] = [
    {
      key: 'platform',
      header: 'Platform',
      width: '176px',
      cell: row => <span className={styles.platform}>{row.label}</span>,
    },
    {
      key: 'state',
      header: 'State',
      width: '216px',
      cell: row => (
        <span className={styles.state}>
          <StatePill state={row.uiState} label={row.stateWord} />
          {row.read && <Freshness observedAt={row.observedAt} state={row.freshness ?? undefined} />}
        </span>
      ),
    },
    {
      key: 'tokens',
      header: 'Tokens',
      width: '104px',
      align: 'end',
      mono: true,
      cell: row => (row.tokens === null || row.noRecords
        ? DASH
        : <span title={formatTokenPhrase(row.tokens)}>{formatCompactTokenValue(row.tokens)}</span>),
    },
    { key: 'api', header: 'API equivalent', width: '136px', align: 'end', mono: true, cell: row => money(row, row.apiEquivalentUsd) },
    { key: 'billed', header: 'Billed', width: '104px', align: 'end', mono: true, cell: row => money(row, row.billedUsd) },
    {
      key: 'coverage',
      header: 'Coverage',
      cell: row => (row.note || row.coverageDetail
        ? (
          <span className={styles.note}>
            {row.note}
            {row.note && row.coverageDetail ? ' ' : ''}
            {row.coverageDetail && <span className={styles.noteDetail}>{row.coverageDetail}</span>}
          </span>
        )
        : DASH),
    },
  ]

  return (
    <Panel
      title="Platforms"
      description={`${periodName}: what each platform used.`}
      padding="none"
      id="usage-platforms"
    >
      {pending ? (
        <div className={styles.pad}>
          <Skeleton variant="block" label="Loading platforms" />
        </div>
      ) : (
        <DataTable
          caption="Usage by platform"
          columns={columns}
          rows={rows}
          rowKey={row => row.id}
          maxHeight="none"
          dimmed={row => !row.read || row.noRecords}
          empty={(
            <EmptyState
              title="No platform has been read yet"
              description="Platforms appear here once the usage backend has read them."
            />
          )}
        />
      )}
      <p className={styles.footnote}>
        A new platform appears here automatically once the backend has a provider for it.
      </p>
    </Panel>
  )
}
