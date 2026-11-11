import { Freshness, Mono, Panel, StateDot, TimeAgo } from '../../components/ui'
import type { ReadingRow } from './lib'
import styles from './ReadingsTimeline.module.css'

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
  const older = retained !== null ? Math.max(0, retained - rows.length) : 0
  return (
    <Panel
      title="Recent readings"
      padding="none"
      actions={<Freshness observedAt={observedAt} state={!readable ? 'unavailable' : stale ? 'stale' : undefined} />}
    >
      {!readable ? (
        <p className={styles.none}>Recent readings could not be read.</p>
      ) : rows.length === 0 ? (
        <p className={styles.none}>No readings have been recorded yet.</p>
      ) : (
        <ol className={styles.list}>
          {rows.map((row) => (
            <li key={row.id} className={styles.row}>
              <TimeAgo value={row.at} className={styles.time} />
              <span className={styles.quality}>
                <StateDot state={row.state} />
                <Mono>{row.quality}</Mono>
              </span>
              <span className={styles.headline}>{row.headline}</span>
            </li>
          ))}
        </ol>
      )}
      {readable && older > 0 && <p className={styles.more}>{older} older readings are kept in the ledger.</p>}
    </Panel>
  )
}
