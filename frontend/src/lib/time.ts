/** Pure relative-time formatting. The caller supplies `now` so renders stay pure. */

export function parseTime(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** "just now", "5m ago", "3h ago", "2d ago", or "in 5m" for future times. */
export function formatRelative(thenMs: number, nowMs: number): string {
  const diff = nowMs - thenMs
  const abs = Math.abs(diff)
  const mins = Math.floor(abs / 60_000)
  if (mins < 1) return diff < 0 ? 'in <1m' : 'just now'
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`
  return diff < 0 ? `in ${unit}` : `${unit} ago`
}

/** Compact age without "ago": "1m", "3h", "2d". */
export function formatAge(thenMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.floor((nowMs - thenMs) / 60_000))
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.floor(mins / 60)}h`
  return `${Math.floor(mins / 1440)}d`
}
