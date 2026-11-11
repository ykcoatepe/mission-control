import { formatRelative, parseTime } from '../../lib/time'
import { useNow } from '../../lib/useNow'

export interface TimeAgoProps {
  /** ISO string, epoch ms or Date. Missing or invalid shows the fallback, never a made-up time. */
  value: string | number | Date | null | undefined
  /** Shown when there is no valid time. Default "—". */
  fallback?: string
  className?: string
}

/** Relative time that keeps ticking. The exact time is in the tooltip. */
export function TimeAgo({ value, fallback = '—', className }: TimeAgoProps) {
  const now = useNow()
  const ms = parseTime(value)
  if (ms === null) return <span className={className}>{fallback}</span>
  return (
    <time className={className} dateTime={new Date(ms).toISOString()} title={new Date(ms).toLocaleString()}>
      {formatRelative(ms, now)}
    </time>
  )
}
