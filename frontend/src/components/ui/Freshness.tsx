import { parseTime } from '../../lib/time'
import { useNow } from '../../lib/useNow'
import { formatAsOf } from './asOf'
import { cx } from './cx'
import { StateMark } from './StateMark'
import styles from './Freshness.module.css'

export type FreshnessKind = 'fresh' | 'stale' | 'unknown' | 'unavailable'

export interface FreshnessProps {
  /** When the reading was taken. Missing means it was never read. */
  observedAt: string | number | Date | null | undefined
  /** Server-provided verdict; overrides the age test. */
  state?: FreshnessKind
  /** Older than this is stale. Default 15 minutes. */
  staleAfterMs?: number
  className?: string
}

/**
 * A reading carries where it came from only when it is stale or unread (HMI rule 8):
 * stale shows a caution mark and "as of 12:41"; unread shows a hollow circle and "not read".
 * A fresh reading is not annotated, so it renders nothing.
 */
export function Freshness({ observedAt, state, staleAfterMs = 15 * 60_000, className }: FreshnessProps) {
  const now = useNow()
  const ms = parseTime(observedAt)
  let kind: FreshnessKind
  if (state) kind = state
  else if (ms === null) kind = 'unavailable'
  else kind = now - ms > staleAfterMs ? 'stale' : 'fresh'

  if (kind === 'fresh') return null
  if (kind === 'stale') {
    return (
      <span className={cx(styles.freshness, className)} data-kind={kind} title={ms === null ? undefined : new Date(ms).toLocaleString()}>
        <StateMark state="warning" />
        {formatAsOf(observedAt, now) ?? 'stale'}
      </span>
    )
  }
  return (
    <span className={cx(styles.freshness, className)} data-kind={kind}>
      <StateMark state="unavailable" />
      not read
    </span>
  )
}
