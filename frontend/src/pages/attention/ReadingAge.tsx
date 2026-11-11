import { Freshness, TimeAgo } from '../../components/ui'
import { parseTime } from '../../lib/time'
import { useNow } from '../../lib/useNow'
import styles from './AttentionView.module.css'

/** A reading older than this is called stale (same limit as `Freshness`). */
const STALE_AFTER_MS = 15 * 60_000

interface ReadingAgeProps {
  observedAt: string | null | undefined
  /** The server flagged this reading as the last good one. */
  stale: boolean
}

/**
 * When this page's reading was taken, in the shell's wording ("Updated 2m ago"). An old or
 * flagged reading says so in amber ("stale · 3h"); a missing time says "not read".
 */
export default function ReadingAge({ observedAt, stale }: ReadingAgeProps) {
  const now = useNow()
  const ms = parseTime(observedAt)
  if (ms === null) return <Freshness observedAt={null} />
  if (stale || now - ms > STALE_AFTER_MS) return <Freshness observedAt={observedAt} state="stale" />
  return (
    <span className={styles.readingAge}>
      Updated <TimeAgo value={observedAt} />
    </span>
  )
}
