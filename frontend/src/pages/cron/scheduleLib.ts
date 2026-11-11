import type { UiState } from '../../lib/state'

/** Fields a person may override on a scheduler-linked entry. Everything else about it is the scheduler's. */
export const CRON_OVERRIDABLE_FIELDS = ['title', 'schedule', 'assignee', 'notes'] as const
export type OverridableField = (typeof CRON_OVERRIDABLE_FIELDS)[number]

/** Fields the server accepts on a PATCH of an entry nobody links to the scheduler. */
export const MANUAL_EDITABLE_FIELDS = ['title', 'schedule', 'startsAt', 'status', 'assignee', 'notes'] as const
export type EditableField = (typeof MANUAL_EDITABLE_FIELDS)[number]

export interface CalendarEntry {
  id: string
  title: string
  /** null when the scheduler reported none (an interval of unknown length). */
  schedule: string | null
  /** How the scheduler's own schedule is read: `interval` uses `everyMs`, `cron` the expression. Absent in older payloads. */
  scheduleKind?: 'interval' | 'interval_unknown' | 'cron' | 'at' | 'unknown' | 'manual' | string
  everyMs?: number | null
  atIso?: string | null
  startsAt: string | null
  status: string
  assignee: 'Yordam' | 'Mudur' | string
  source: 'cron' | 'manual' | 'assistant' | string
  linkedTaskId: string | null
  linkedJobId: string | null
  notes?: string
  updatedAt?: string
  /** Fields a person overrode on a linked entry (a subset of the overridable fields). */
  userOverrides?: string[]
  /** What the scheduler last derived for the overridable fields: the value "Reset" returns to. */
  cronDerived?: Partial<Record<OverridableField, string>> | null
}

/** The calendar read's own account of rows it set aside (GET /api/calendar `diagnostics`). */
export interface CalendarDiagnostics {
  quarantined: { count: number; ids: Array<string | number | null> }
  duplicates: { count: number; ids: Array<string | number | null> }
}

export interface CalendarMeta {
  ok?: boolean
  stale?: boolean
  error?: { code?: string; message?: string } | null
  /** The calendar file parses and has rows that a repair can move aside (`POST /api/calendar/repair`). */
  repairAvailable?: boolean
}

export interface CalendarPayload {
  entries: CalendarEntry[]
  diagnostics?: CalendarDiagnostics
  sync?: { ok: boolean; error: { code?: string; message?: string } | null }
  meta?: CalendarMeta
}

/** A scheduler-linked entry: the scheduler owns its status and next run. */
export function isLinkedEntry(entry: Pick<CalendarEntry, 'source' | 'linkedJobId'>): boolean {
  return entry.source === 'cron' && Boolean(entry.linkedJobId)
}

export function isOverridden(entry: Pick<CalendarEntry, 'userOverrides'>, field: string): boolean {
  return Boolean(entry.userOverrides?.includes(field))
}

/** The value the scheduler last derived for an overridable field, when it is known. */
export function scheduleValue(entry: Pick<CalendarEntry, 'cronDerived'>, field: OverridableField): string | null {
  const value = entry.cronDerived?.[field]
  return typeof value === 'string' ? value : null
}

/** Where a linked entry's job is switched on and off. */
export function jobHref(entry: Pick<CalendarEntry, 'linkedJobId'>): string | null {
  return entry.linkedJobId ? `/automations?view=jobs&job=${encodeURIComponent(entry.linkedJobId)}` : null
}

export interface EntryForm {
  title: string
  schedule: string
  startsAt: string | null
  status: string
  assignee: string
  source: string
  linkedTaskId: string
  notes: string
}

export function formFromEntry(entry: CalendarEntry | null): EntryForm {
  return {
    title: entry?.title ?? '',
    schedule: entry?.schedule ?? '',
    startsAt: entry?.startsAt ?? null,
    status: entry?.status ?? 'scheduled',
    assignee: entry?.assignee ?? 'Mudur',
    source: entry?.source ?? 'manual',
    linkedTaskId: entry?.linkedTaskId ?? '',
    notes: entry?.notes ?? '',
  }
}

/**
 * The body of POST /api/calendar. Never an id (the server generates it), never a
 * link to a scheduler job (rejected with 400): linked entries are made by the
 * schedule sync.
 */
export function buildCreatePayload(form: EntryForm): Record<string, unknown> {
  return {
    title: form.title.trim(),
    schedule: form.schedule.trim(),
    startsAt: form.startsAt,
    status: form.status,
    assignee: form.assignee,
    source: form.source === 'assistant' ? 'assistant' : 'manual',
    linkedTaskId: form.linkedTaskId.trim() || null,
    notes: form.notes,
  }
}

function sameValue(field: EditableField, a: string | null | undefined, b: string | null | undefined): boolean {
  if (field === 'startsAt') return (a ?? null) === (b ?? null)
  const norm = (value: string | null | undefined) => (field === 'title' || field === 'schedule' ? String(value ?? '').trim() : String(value ?? ''))
  return norm(a) === norm(b)
}

/**
 * The body of PATCH /api/calendar/:id: only fields that changed, and only fields
 * the server lets this entry change.
 *
 *  - A linked entry takes title, schedule, assignee and notes. Its status and
 *    start time are the scheduler's: a PATCH containing them is rejected (400),
 *    so they are never sent, however the form looks.
 *  - `null` clears the person's override and returns the field to the schedule's
 *    value. `reset` lists the fields the person asked to reset; only fields that
 *    are overridden can be.
 *  - The id is in the URL, never in the body.
 */
export function buildUpdatePatch(
  entry: CalendarEntry,
  form: EntryForm,
  reset: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const linked = isLinkedEntry(entry)
  const fields: readonly EditableField[] = linked ? CRON_OVERRIDABLE_FIELDS : MANUAL_EDITABLE_FIELDS
  const patch: Record<string, unknown> = {}
  for (const field of fields) {
    if (linked && reset.has(field) && isOverridden(entry, field)) {
      patch[field] = null
      continue
    }
    const next = form[field]
    const current = entry[field]
    if (sameValue(field, next, current)) continue
    patch[field] = field === 'title' || field === 'schedule' ? String(next ?? '').trim() : next
  }
  return patch
}

// ---- what the read says about its own quality ----

export interface CalendarNotice {
  id: string
  tone: UiState | 'info'
  title: string
  body: string
}

function idList(ids: Array<string | number | null> | undefined): string {
  const shown = (ids ?? []).filter((id): id is string | number => id !== null).slice(0, 5).map(String)
  const extra = (ids?.length ?? 0) - shown.length
  return shown.length ? ` (${shown.join(', ')}${extra > 0 ? `, and ${extra} more` : ''})` : ''
}

/** Quarantined or duplicate rows block every calendar write until they are corrected in the file. */
export function writesBlocked(payload: Pick<CalendarPayload, 'diagnostics'> | null | undefined): boolean {
  const d = payload?.diagnostics
  return Boolean(d && (d.quarantined.count > 0 || d.duplicates.count > 0))
}

// ---- repair ----

/** The result of `POST /api/calendar/repair`. `backupPath` is relative to the home directory (`~/…`); null when nothing was repaired. */
export interface RepairResult {
  ok?: boolean
  repaired: boolean
  counts: { kept: number; quarantined: number; duplicates: number }
  backupPath: string | null
}

export interface RepairOffer {
  malformed: number
  duplicates: number
}

/**
 * What a repair would act on, or null when no repair is offered: only a read whose own meta says
 * `repairAvailable` offers one (the file parses and has rows set aside). The counts are the read's diagnostics.
 */
export function repairOffer(payload: Pick<CalendarPayload, 'diagnostics' | 'meta'> | null | undefined): RepairOffer | null {
  if (payload?.meta?.repairAvailable !== true) return null
  return {
    malformed: payload.diagnostics?.quarantined.count ?? 0,
    duplicates: payload.diagnostics?.duplicates.count ?? 0,
  }
}

const rowsOf = (count: number, adjective: string) => `${count} ${adjective} ${count === 1 ? 'row' : 'rows'}`

/** Exactly what the repair will do, said before it is confirmed. */
export function repairDescription(offer: RepairOffer): string {
  const parts = [
    ...(offer.malformed > 0 ? [rowsOf(offer.malformed, 'malformed')] : []),
    ...(offer.duplicates > 0 ? [rowsOf(offer.duplicates, 'duplicate')] : []),
  ]
  const what = parts.length > 0 ? parts.join(' and ') : 'The rows the calendar read set aside'
  const verb = parts.length === 1 && (offer.malformed === 1 || offer.duplicates === 1) ? 'is' : 'are'
  return `${what} ${parts.length > 0 ? verb : 'are'} moved to a backup file next to the calendar. Valid entries are kept.`
}

/** The outcome, with the counts and the home-relative backup path. */
export function repairResultMessage(result: RepairResult | null | undefined): string {
  if (!result || typeof result !== 'object' || !result.counts) return 'The calendar was repaired.'
  const { kept, quarantined, duplicates } = result.counts
  if (!result.repaired) return `Nothing needed repair; all ${kept} ${kept === 1 ? 'entry is' : 'entries are'} valid.`
  const moved = [
    ...(quarantined > 0 ? [rowsOf(quarantined, 'malformed')] : []),
    ...(duplicates > 0 ? [rowsOf(duplicates, 'duplicate')] : []),
  ].join(' and ')
  const where = result.backupPath ? ` in ${result.backupPath}` : ''
  return `Calendar repaired: ${moved || 'no rows'} moved to a backup${where}. ${kept} valid ${kept === 1 ? 'entry' : 'entries'} kept.`
}

const SCHEDULER_CODES = new Set(['calendar_scheduler_stale', 'calendar_scheduler_unavailable'])

/**
 * The quiet notices for a calendar read: rows the server set aside, duplicate
 * ids, and a schedule that is behind the scheduler. One notice per cause; the
 * numbers come from the payload's own diagnostics, the wording from here.
 */
export function calendarNotices(payload: CalendarPayload | null | undefined): CalendarNotice[] {
  if (!payload) return []
  const notices: CalendarNotice[] = []
  const quarantined = payload.diagnostics?.quarantined
  const duplicates = payload.diagnostics?.duplicates
  const blocked = payload.meta?.repairAvailable === true
    ? 'Changes to the schedule are paused until the calendar is repaired.'
    : 'The file is left as it is, and changes to the schedule are paused until it is corrected.'
  if (quarantined && quarantined.count > 0) {
    notices.push({
      id: 'quarantined',
      tone: 'warning',
      title: 'Some schedule rows were set aside',
      body: `${quarantined.count} malformed ${quarantined.count === 1 ? 'row was' : 'rows were'} left out${idList(quarantined.ids)}. ${blocked}`,
    })
  }
  if (duplicates && duplicates.count > 0) {
    notices.push({
      id: 'duplicates',
      tone: 'warning',
      title: 'Some schedule rows share an id',
      body: `${duplicates.count} duplicate ${duplicates.count === 1 ? 'row was' : 'rows were'} found${idList(duplicates.ids)}; only the first row of each is shown. ${blocked}`,
    })
  }
  const error = payload.meta?.error ?? payload.sync?.error ?? null
  const code = error?.code ?? ''
  if (SCHEDULER_CODES.has(code) && error?.message) {
    notices.push({ id: code, tone: 'info', title: 'Schedule may be behind', body: error.message })
  } else if (!quarantined?.count && !duplicates?.count && payload.meta?.stale && error?.message
    && code !== 'calendar_entries_quarantined' && code !== 'calendar_duplicate_ids') {
    notices.push({ id: 'stale', tone: 'info', title: 'Showing the last good reading', body: error.message })
  }
  return notices
}

export const STATUS_OPTIONS = ['scheduled', 'active', 'running', 'done', 'failed', 'disabled', 'cancelled']
export const SOURCE_OPTIONS = ['cron', 'assistant', 'manual']
/** A person can create manual and assistant entries; cron entries come from the schedule sync. */
export const CREATE_SOURCE_OPTIONS = ['manual', 'assistant']
export const ASSIGNEE_OPTIONS = ['Mudur', 'Yordam']

/** A scheduled entry is the normal case and stays quiet: no dot, no colour. */
export function entryState(status: string): UiState | null {
  const s = String(status || '').toLowerCase()
  if (s === 'failed') return 'critical'
  if (s === 'active' || s === 'running' || s === 'done') return 'healthy'
  if (s === 'disabled' || s === 'cancelled') return 'inactive'
  return null
}

/** A status in words a person would use: "disabled" is "Paused" here, as in the Jobs view. */
export function entryStatusLabel(status: string | null | undefined): string {
  const text = String(status ?? '').trim().toLowerCase()
  if (!text) return '—'
  if (text === 'disabled') return 'Paused'
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Where an entry comes from, in plain words. The stored value stays `cron` / `manual` / `assistant`. */
export function sourceLabel(source: string | null | undefined): string {
  const text = String(source ?? '').trim().toLowerCase()
  if (text === 'cron') return 'Scheduler'
  if (text === 'manual') return 'Manual'
  if (text === 'assistant') return 'Assistant'
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '—'
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
