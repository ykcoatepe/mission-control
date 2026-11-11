import { Freshness, Mono, Panel, StateDot, TimeAgo } from '../../components/ui'
import { fmtClock, type ReadingRow } from './lib'
import styles from './ReadingsTimeline.module.css'

/**
 * History, not status: every row is the state recorded at that time, labelled with its time.
 * The current state is the verdict line above; a newest row that disagrees with it says so.
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
  const older = retained !== null ? Math.max(0, retained - shown) : 0
  const newestDay = rows[0]?.at ?? null
  return (
    <Panel
      title="Recent readings"
      description="History: the state recorded at each time. The current state is the line at the top."
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
              <span className={styles.when}>
                <Mono className={styles.clock}>{fmtClock(row.at, newestDay)}</Mono>
                <TimeAgo value={row.at} className={styles.time} />
              </span>
              <span className={styles.recorded}>
                <StateDot state={row.state} />
                <span>{row.stateWord}</span>
                <Mono muted>{row.quality}</Mono>
              </span>
              <span className={styles.headline}>
                {row.note && <span className={styles.note}>{row.note}. </span>}
                {row.headline}
                {row.count > 1 && (
                  <span className={styles.repeat}>
                    {' '}
                    · {row.count} readings since {fmtClock(row.since ?? row.at, newestDay)}, same values
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {readable && older > 0 && <p className={styles.more}>{older} older readings are kept in the ledger.</p>}
    </Panel>
  )
}
