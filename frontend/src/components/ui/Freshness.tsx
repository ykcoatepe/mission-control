import { formatAge, parseTime } from '../../lib/time'
import { useNow } from '../../lib/useNow'
import { cx } from './cx'
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

/** "fresh · 1m", "stale · 3h" or "not read". Stale is amber; not read is grey. */
export function Freshness({ observedAt, state, staleAfterMs = 15 * 60_000, className }: FreshnessProps) {
  const now = useNow()
  const ms = parseTime(observedAt)
  let kind: FreshnessKind
  if (state) kind = state
  else if (ms === null) kind = 'unavailable'
  else kind = now - ms > staleAfterMs ? 'stale' : 'fresh'

  const age = ms === null ? null : formatAge(ms, now)
  const notRead = kind === 'unavailable' || kind === 'unknown'
  return (
    <span className={cx(styles.freshness, className)} data-kind={kind}>
      {notRead ? 'not read' : `${kind}${age ? ` · ${age}` : ''}`}
    </span>
  )
}
