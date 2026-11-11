import { DataTable, EmptyState, Freshness, Panel, Skeleton, StatePill } from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import { BILLING_NOT_READ, formatCompactTokenValue, formatPreciseCurrency, formatTokenPhrase, NOT_READ } from './lib'
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

/** Billed spend: a recorded bill, a plain dash for a platform with no records, or a dash that says billing was not read. */
function billed(row: ProviderRow) {
  if (row.noRecords) return DASH
  if (row.billedUsd !== null) return formatPreciseCurrency(row.billedUsd)
  return (
    <span role="img" aria-label={BILLING_NOT_READ} title={BILLING_NOT_READ}>{DASH}</span>
  )
}

export default function ProvidersPanel({ periodName, rows, pending = false }: ProvidersPanelProps) {
  // Numbers keep their width and never wrap; the long coverage sentence sits on a second line
  // under the platform name, so it cannot squeeze the numeric columns.
  const columns: DataTableColumn<ProviderRow>[] = [
    {
      key: 'platform',
      header: 'Platform',
      cell: row => (
        <span className={styles.platformCell}>
          <span className={styles.platform}>{row.label}</span>
          {row.coverageDetail && <span className={styles.detail}>{row.coverageDetail}</span>}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
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
      align: 'end',
      mono: true,
      cell: row => (row.tokens === null || row.noRecords
        ? <span className={styles.num}>{DASH}</span>
        : <span className={styles.num} title={formatTokenPhrase(row.tokens)}>{formatCompactTokenValue(row.tokens)}</span>),
    },
    { key: 'api', header: 'API equivalent', align: 'end', mono: true, cell: row => <span className={styles.num}>{money(row, row.apiEquivalentUsd)}</span> },
    { key: 'billed', header: 'Billed', align: 'end', mono: true, cell: row => <span className={styles.num}>{billed(row)}</span> },
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
