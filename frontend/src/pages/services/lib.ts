import { toUiState } from '../../lib/state'
import type { UiState } from '../../lib/state'
import type { Endpoint, ServiceFilter, ServiceKind, ServiceRow, ServicesData, ServicesSummary } from './types'

// ---- one service ----

export interface ServiceStatus {
  state: UiState
  label: string
}

/**
 * Operator-facing state of a service. Only the four words the server derives
 * are understood; anything else is "not read", never healthy and never down.
 */
export function serviceStatus(row: Pick<ServiceRow, 'state'>): ServiceStatus {
  switch (row.state) {
    case 'running':
      return { state: 'healthy', label: 'Running' }
    case 'idle':
      return { state: 'inactive', label: 'Idle' }
    case 'down':
      return { state: 'critical', label: 'Down' }
    case 'failed':
      return { state: 'critical', label: 'Failed' }
    default:
      return { state: 'unavailable', label: 'Not read' }
  }
}

/** Down or failed: the rows that make the page red. */
export function isAbnormal(row: Pick<ServiceRow, 'state'>): boolean {
  return row.state === 'down' || row.state === 'failed'
}

const RANK: Record<UiState, number> = { critical: 0, unavailable: 1, warning: 2, healthy: 3, inactive: 4 }

/** Abnormal rows first, then unread, then running, then idle; by label inside each group. */
export function sortServices(rows: readonly ServiceRow[]): ServiceRow[] {
  return [...rows].sort((a, b) => {
    const rank = RANK[serviceStatus(a).state] - RANK[serviceStatus(b).state]
    return rank !== 0 ? rank : a.label.localeCompare(b.label)
  })
}

// ---- filtering ----

const SERVICE_FILTERS: readonly ServiceFilter[] = ['all', 'down', 'unidentified', 'keepalive', 'interval', 'one-shot']

/** The filter named in the URL; anything else is "all". */
export function parseServiceFilter(value: string | null | undefined): ServiceFilter {
  return SERVICE_FILTERS.find((filter) => filter === value) ?? 'all'
}

export function matchesFilter(row: ServiceRow, filter: ServiceFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'down') return isAbnormal(row)
  if (filter === 'unidentified') return row.identified === false
  return row.kind === filter
}

export function matchesQuery(row: ServiceRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [row.label, row.kind ?? '', serviceStatus(row).label, row.state].some((value) =>
    String(value).toLowerCase().includes(needle),
  )
}

export function filterServices(rows: readonly ServiceRow[], filter: ServiceFilter, query: string): ServiceRow[] {
  return sortServices(rows.filter((row) => matchesFilter(row, filter) && matchesQuery(row, query)))
}

/**
 * Counts for the filter chips. "All", "Down" and "Unidentified" are the server's
 * own tally (`summary`); the three kinds are counted from the rows, since the
 * server publishes no per-kind number.
 */
export function filterCounts(
  rows: readonly ServiceRow[],
  summary: ServicesSummary | null | undefined,
): Record<ServiceFilter, number | null> {
  const count = (filter: ServiceFilter) => rows.filter((row) => matchesFilter(row, filter)).length
  const given = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    all: given(summary?.total),
    down: given(summary?.down),
    unidentified: given(summary?.unidentified),
    keepalive: count('keepalive'),
    interval: count('interval'),
    'one-shot': count('one-shot'),
  }
}

// ---- words ----

const KIND_LABEL: Record<ServiceKind, string> = {
  keepalive: 'Keepalive',
  interval: 'Interval',
  'one-shot': 'One-shot',
}

export function kindLabel(kind: ServiceRow['kind']): string | null {
  return kind ? KIND_LABEL[kind] : null
}

/** "every 10m", "every 1h", "every 45s"; null when there is no fixed interval. */
export function formatInterval(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`
  if (seconds % 60 === 0) return `every ${seconds / 60}m`
  return `every ${seconds}s`
}

/** Small line under the kind: how often an interval service runs. */
export function scheduleNote(row: Pick<ServiceRow, 'kind' | 'intervalSeconds' | 'calendar'>): string | null {
  if (row.kind !== 'interval') return null
  return formatInterval(row.intervalSeconds) ?? (row.calendar ? 'on a calendar' : null)
}

const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  15: 'SIGTERM',
}

/** launchd reports a negative status when the process was ended by a signal. */
export function describeExit(code: number): string {
  if (code < 0) {
    const signal = -code
    return SIGNAL_NAMES[signal] ? `signal ${signal} (${SIGNAL_NAMES[signal]})` : `signal ${signal}`
  }
  return `code ${code}`
}

/**
 * One sentence that explains a row, only where there is something to explain.
 * A one-shot that exited non-zero but is reported idle is inactive, not failed.
 */
export function serviceHint(row: ServiceRow): string | null {
  const given = typeof row.hint === 'string' ? row.hint.trim() : ''
  if (given) return given

  const code = typeof row.lastExitCode === 'number' && row.lastExitCode !== 0 ? row.lastExitCode : null

  if (row.state === 'down') {
    return code === null
      ? 'Should always be running, but has no process.'
      : `Should always be running, but has no process. Last exit: ${describeExit(code)}.`
  }
  if (row.state === 'failed') {
    return code === null ? 'Its last run failed.' : `Its last run exited with ${describeExit(code)}.`
  }
  if (row.state === 'idle' && code !== null) {
    return row.kind === 'one-shot'
      ? `Exited with ${describeExit(code)}. A one-shot service is inactive after it runs, not failed.`
      : `Last exit: ${describeExit(code)}.`
  }
  if (row.state === 'running' && code !== null) {
    return code < 0
      ? `Restarted after its previous process was ended by ${describeExit(code)}.`
      : `Restarted after exiting with ${describeExit(code)}.`
  }
  if (row.plist === 'not-found') return 'Definition file not found, so its kind is unknown.'
  if (row.plist === 'unreadable') return 'Definition file could not be read, so its kind is unknown.'
  return null
}

// ---- gateways and Ollama ----

export interface EndpointReading {
  state: UiState
  /** "Up", "Down", "Stale" or "Not read". */
  word: string
  /** The time the age refers to, or null when none was reported. */
  at: string | null
  /** What the age means: "checked" or "heartbeat". */
  atLabel: 'checked' | 'heartbeat'
}

export function endpointReading(endpoint: Endpoint | null | undefined): EndpointReading {
  if (!endpoint) return { state: 'unavailable', word: 'Not read', at: null, atLabel: 'checked' }
  const heartbeat = typeof endpoint.heartbeatAt === 'string' && endpoint.heartbeatAt ? endpoint.heartbeatAt : null
  const at = heartbeat ?? (typeof endpoint.observedAt === 'string' ? endpoint.observedAt : null)
  const atLabel = heartbeat ? 'heartbeat' : 'checked'
  switch (endpoint.state) {
    case 'up':
      return { state: 'healthy', word: 'Up', at, atLabel }
    case 'down':
      return { state: 'critical', word: 'Down', at, atLabel }
    case 'stale':
      return { state: 'warning', word: 'Stale', at, atLabel }
    default:
      return { state: 'unavailable', word: 'Not read', at, atLabel }
  }
}

// ---- verdict ----

/** Where the gateway readings sit on this page (the reachability strip). */
export const GATEWAY_READINGS_ID = 'gateway-readings'

export interface VerdictLink {
  /** `anchor`: a place on this page (`#id`); `route`: another screen. */
  kind: 'anchor' | 'route'
  to: string
  label: string
}

/** One condition, in one short sentence. */
export interface VerdictLine {
  state: UiState
  text: string
  /** The system's own reason (from `/api/signals`), only on a line about a system warning. */
  reason: string | null
  /** Where that system can be looked at. */
  link: VerdictLink | null
}

/** A calm remark that is not a fault: it never colours the verdict. */
export interface VerdictNote {
  text: string
  /** The filter that lists the services it is about. */
  filter: ServiceFilter
  actionLabel: string
}

export interface Verdict {
  /** The worst state among the lines. */
  state: UiState
  /** The first (most severe) line. */
  text: string
  /** Quiet extra line, or null. */
  detail: string | null
  /** One line per condition, most severe first. */
  lines: VerdictLine[]
  note: VerdictNote | null
}

const ENDPOINTS = [
  { name: 'OpenClaw gateway', pick: (data: ServicesData) => data.gateways?.openclaw },
  { name: 'Hermes gateway', pick: (data: ServicesData) => data.gateways?.hermes },
  { name: 'Ollama', pick: (data: ServicesData) => data.ollama },
] as const

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

function joinNames(names: string[]): string {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The shell's reading of the two gateways (`signals.systems`), when the page has it. */
export type GatewaySystems = Partial<
  Record<'openclaw' | 'hermes', { state: string; reason?: string | null; detailHref?: string | null } | null | undefined>
> | null | undefined

const GATEWAY_NAME = { openclaw: 'OpenClaw', hermes: 'Hermes' } as const
const GATEWAY_HREF = { openclaw: '/services', hermes: '/services' } as const

/** The path of this page; a system whose detail lives here is shown by the reachability strip. */
const SERVICES_PATH = '/services'

/** An in-app path only; an external or malformed value is not followed. */
function localPath(href: unknown): string | null {
  return typeof href === 'string' && /^\/(?!\/)[^\s]*$/.test(href) ? href : null
}

function systemLink(id: 'openclaw' | 'hermes', detailHref: unknown): VerdictLink {
  const path = localPath(detailHref) ?? GATEWAY_HREF[id]
  if (path === SERVICES_PATH || path.startsWith(`${SERVICES_PATH}?`) || path.startsWith(`${SERVICES_PATH}#`)) {
    return { kind: 'anchor', to: `#${GATEWAY_READINGS_ID}`, label: 'See the gateway readings' }
  }
  return { kind: 'route', to: path, label: 'See details' }
}

/** One line per gateway the shell reports as warning or critical, with its own reason and a link. */
function systemLines(systems: GatewaySystems): VerdictLine[] {
  if (!systems) return []
  const lines: VerdictLine[] = []
  for (const id of ['openclaw', 'hermes'] as const) {
    const raw = systems[id]
    if (!raw || typeof raw.state !== 'string') continue
    const state = toUiState(raw.state)
    if (state !== 'warning' && state !== 'critical') continue
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : null
    lines.push({
      state,
      text: `${GATEWAY_NAME[id]} is reporting ${state === 'critical' ? 'a critical state' : 'a warning'}`,
      reason,
      link: systemLink(id, raw.detailHref),
    })
  }
  return lines
}

const LINE_RANK: Record<UiState, number> = { critical: 0, warning: 1, unavailable: 2, healthy: 3, inactive: 4 }

const line = (state: UiState, text: string): VerdictLine => ({ state, text, reason: null, link: null })

/**
 * The page's answer, one short sentence per condition, most severe first. It says only what was
 * observed. "No service is down" is not "everything is as expected": a gateway the shell reports
 * as warning has its own line with the system's reason and a link. Services without a definition
 * file are a calm note (their kind is unknown, nothing is known to be wrong), never part of the
 * state.
 */
export function servicesVerdict(data: ServicesData | null | undefined, systems?: GatewaySystems): Verdict {
  if (!data) {
    const text = 'Services could not be read'
    return { state: 'unavailable', text, detail: null, lines: [line('unavailable', text)], note: null }
  }

  const rows = Array.isArray(data.services) ? data.services : null
  // The server's tally: the page counts none of this itself.
  const summary = data.summary ?? null
  const down = summary?.down ?? 0
  // A state word the page does not know is "not read" (never healthy, never down).
  const unreadRows = rows ? rows.filter((row) => serviceStatus(row).state === 'unavailable').length : 0
  const unidentified = summary?.unidentified ?? 0

  const endpoints = ENDPOINTS.map((entry) => ({ name: entry.name, reading: endpointReading(entry.pick(data)) }))
  const named = (state: UiState) => endpoints.filter((e) => e.reading.state === state).map((e) => e.name)
  const endpointsDown = named('critical')
  const endpointsUnread = named('unavailable')
  const endpointsStale = named('warning')

  const lines: VerdictLine[] = []

  if (down > 0) lines.push(line('critical', `${down} ${plural(down, 'service is', 'services are')} down`))
  else if (!rows) lines.push(line('unavailable', 'The service list could not be read'))
  else if (!summary) lines.push(line('unavailable', 'The service summary could not be read'))
  else if (summary.total === 0) lines.push(line('unavailable', 'No services were found'))
  else if (unreadRows > 0) {
    lines.push(line('unavailable', `${unreadRows} ${plural(unreadRows, 'service', 'services')} could not be read`))
  } else lines.push(line('healthy', `No service is down (${summary.total} read)`))

  if (endpointsDown.length > 0) {
    lines.push(line('critical', `${joinNames(endpointsDown)} ${plural(endpointsDown.length, 'is', 'are')} not reachable`))
  }
  if (endpointsUnread.length > 0) {
    lines.push(line('unavailable', `${joinNames(endpointsUnread)} could not be read`))
  }
  if (endpointsStale.length > 0) {
    lines.push(
      line('warning', `${joinNames(endpointsStale)} ${plural(endpointsStale.length, 'has', 'have')} not reported recently`),
    )
  }
  lines.push(...systemLines(systems))

  // Array.prototype.sort is stable: lines of one severity keep the order above.
  lines.sort((a, b) => LINE_RANK[a.state] - LINE_RANK[b.state])

  const note: VerdictNote | null =
    unidentified > 0
      ? {
          text: `${unidentified} ${plural(unidentified, 'service has', 'services have')} no definition file, so ${plural(unidentified, 'its', 'their')} kind is unknown.`,
          filter: 'unidentified',
          actionLabel: 'Show them',
        }
      : null

  return {
    state: lines[0].state,
    text: lines[0].text,
    detail: summary ? `${summary.running} running · ${summary.idle} idle` : null,
    lines,
    note,
  }
}

// ---- alarm line ----

/** What the alarm line's one action does. */
export type AlarmTarget =
  | { kind: 'filter'; filter: ServiceFilter; label: string }
  | { kind: 'link'; link: VerdictLink; label: string }

/** The page's one alarm line (HMI rule 4). */
export interface ServiceAlarm {
  state: 'warning' | 'critical'
  /** The most severe condition, in one sentence. */
  title: string
  /** Every other abnormal condition, and the system's own reasons. */
  detail: string | null
  /** At most one: list the services that are down, or go to the place the condition is explained. */
  action: AlarmTarget | null
}

export const isAlarmState = (state: UiState): state is 'warning' | 'critical' => state === 'warning' || state === 'critical'

/**
 * The verdict lines that are abnormal (caution or critical) collapse into one alarm line.
 * Lines that are only "not read" or normal are not alarms: they stay quiet sentences (see `quietLines`).
 * No abnormal line means no alarm at all.
 */
export function serviceAlarm(
  verdict: Verdict,
  data: ServicesData | null | undefined,
  activeFilter: ServiceFilter = 'all',
): ServiceAlarm | null {
  const abnormal = verdict.lines.filter((entry) => isAlarmState(entry.state))
  const [first, ...rest] = abnormal
  if (!first || !isAlarmState(first.state)) return null

  const parts: string[] = []
  if (first.reason) parts.push(first.reason)
  for (const entry of rest) parts.push(entry.reason ? `${entry.text}: ${entry.reason}` : entry.text)

  // Services that are down come first among the critical lines, so they are the title when there are any.
  const downCount = data?.summary?.down ?? 0
  let action: AlarmTarget | null = null
  if (first.state === 'critical' && downCount > 0) {
    if (activeFilter !== 'down') {
      action = { kind: 'filter', filter: 'down', label: downCount === 1 ? 'Show it' : 'Show them' }
    }
  } else if (first.link) {
    action = { kind: 'link', link: first.link, label: first.link.label }
  }

  return { state: first.state, title: first.text, detail: parts.length ? parts.join(' · ') : null, action }
}

/** The verdict lines that are not alarms: normal, or not read. Shown as quiet sentences. */
export function quietLines(verdict: Verdict): VerdictLine[] {
  return verdict.lines.filter((entry) => !isAlarmState(entry.state))
}
