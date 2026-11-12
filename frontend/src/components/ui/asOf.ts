import { parseTime } from '../../lib/time'

/**
 * "as of 12:41" for a reading from today, "as of 11 Nov, 12:41" for an older one.
 * A time that cannot be read gives null: the caller says "not read" instead of inventing one.
 */
export function formatAsOf(value: string | number | Date | null | undefined, now: number): string | null {
  const ms = parseTime(value)
  if (ms === null) return null
  const then = new Date(ms)
  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const today = new Date(now)
  const sameDay =
    then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate()
  if (sameDay) return `as of ${time}`
  const day = then.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return `as of ${day}, ${time}`
}
