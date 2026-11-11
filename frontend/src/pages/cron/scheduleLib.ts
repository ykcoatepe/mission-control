import type { UiState } from '../../lib/state'

export interface CalendarEntry {
  id: string
  title: string
  schedule: string
  startsAt: string | null
  status: string
  assignee: 'Yordam' | 'Mudur' | string
  source: 'cron' | 'manual' | 'assistant' | string
  linkedTaskId: string | null
  linkedJobId: string | null
  notes?: string
  updatedAt?: string
}

export interface CalendarPayload {
  entries: CalendarEntry[]
  warning?: string
}

export const STATUS_OPTIONS = ['scheduled', 'active', 'running', 'done', 'failed', 'disabled', 'cancelled']
export const SOURCE_OPTIONS = ['cron', 'assistant', 'manual']
export const ASSIGNEE_OPTIONS = ['Mudur', 'Yordam']

/** A scheduled entry is the normal case and stays quiet: no dot, no colour. */
export function entryState(status: string): UiState | null {
  const s = String(status || '').toLowerCase()
  if (s === 'failed') return 'critical'
  if (s === 'active' || s === 'running' || s === 'done') return 'healthy'
  if (s === 'disabled' || s === 'cancelled') return 'inactive'
  return null
}

export function isDisabledEntry(entry: Pick<CalendarEntry, 'status'>) {
  return String(entry.status || '').toLowerCase() === 'disabled'
}

export function startOfWeek(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  return d
}

export function toDayKey(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatDayHeader(date: Date) {
  return {
    weekday: date.toLocaleDateString('en-US', { weekday: 'short' }),
    date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }
}

export function formatTimeLabel(startsAt?: string | null) {
  if (!startsAt) return 'Repeats'
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return 'Time not set'
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function formatWeekRange(days: Date[]) {
  if (days.length === 0) return ''
  const start = days[0]
  const end = days[days.length - 1]
  const sameMonth = start.getMonth() === end.getMonth()
  const sameYear = start.getFullYear() === end.getFullYear()
  const startLabel = start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  const endLabel = end.toLocaleDateString('en-US', { month: sameMonth ? undefined : 'long', day: 'numeric' })
  return `${startLabel} – ${endLabel}, ${sameYear ? end.getFullYear() : `${start.getFullYear()} – ${end.getFullYear()}`}`
}

export function toInputDateTime(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
