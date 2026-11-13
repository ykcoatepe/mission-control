import { Block, DataTable, Freshness, StateMark, type DataTableColumn } from '../../components/ui'
import { fmtClock, type ReadingRow } from './lib'
import styles from './ReadingsTimeline.module.css'

/**
 * History, not status: every row is the state recorded at that time, labelled with its real time.
 * The current state is the alarm line (or the quiet line) at the top; a newest row that disagrees
 * with it says so.
 */
export function ReadingsTimeline({
  rows,
  retained,
  observedAt,
  stale,
  readable,
}: {
  rows: ReadingRow[]
  /** Readings kept in the ledger, if known. */
  retained: number | null
  observedAt: string | null
  stale: boolean
  readable: boolean
}) {
  const shown = rows.reduce((sum, row) => sum + row.count, 0)
  const newestDay = rows[0]?.at ?? null
  const columns: DataTableColumn<ReadingRow>[] = [
    {
      key: 'time',
      header: 'Time',
      mono: true,
      width: '9rem',
      cell: (row) => <time dateTime={row.at}>{fmtClock(row.at, newestDay)}</time>,
    },
    {
      key: 'state',
      header: 'State',
      width: '9rem',
      cell: (row) => (
        <span className={styles.recorded}>
          <StateMark state={row.state} />
          <span>{row.stateWord}</span>
        </span>
      ),
    },
    {
      key: 'event',
      header: 'What changed',
      cell: (row) => (
        <span className={styles.event}>
          {row.note && <span className={styles.note}>{row.note}. </span>}
          {row.headline}
          {row.count > 1 && (
            <span className={styles.repeat}>
              {' '}
              · {row.count} readings since {fmtClock(row.since ?? row.at, newestDay)}, same values
            </span>
          )}
        </span>
      ),
    },
  ]
  return (
    <Block
      title="Recent readings"
      padding="none"
      meta={readable && rows.length > 0 ? `Showing ${shown} of ${retained !== null ? Math.max(retained, shown) : shown}` : undefined}
      actions={<Freshness observedAt={observedAt} state={!readable ? 'unavailable' : stale ? 'stale' : undefined} />}
    >
      {!readable ? (
        <p className={styles.none}>Recent readings could not be read.</p>
      ) : rows.length === 0 ? (
        <p className={styles.none}>No readings have been recorded yet.</p>
      ) : (
        <DataTable caption="Recent readings" columns={columns} rows={rows} rowKey={(row) => row.id} maxHeight="none" />
      )}
    </Block>
  )
}
