import { parseTime } from '../../lib/time'

/** "Aug 15, 12:30 AM": a past time is told as a date, not as "88d ago". */
export function overdueSince(value: string | null | undefined): string | null {
  const ms = parseTime(value)
  if (ms === null) return null
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
