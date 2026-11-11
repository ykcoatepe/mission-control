import { toUiState } from '../../lib/state'
import type { UiState } from '../../lib/state'
import type { Endpoint, ServiceFilter, ServiceKind, ServiceRow, ServicesData } from './types'

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

const SERVICE_FILTERS: readonly ServiceFilter[] = ['all', 'down', 'keepalive', 'interval', 'one-shot']

/** The filter named in the URL; anything else is "all". */
export function parseServiceFilter(value: string | null | undefined): ServiceFilter {
  return SERVICE_FILTERS.find((filter) => filter === value) ?? 'all'
}

export function matchesFilter(row: ServiceRow, filter: ServiceFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'down') return isAbnormal(row)
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

/** Real counts for the filter chips, from the rows themselves. */
export function filterCounts(rows: readonly ServiceRow[]): Record<ServiceFilter, number> {
  const count = (filter: ServiceFilter) => rows.filter((row) => matchesFilter(row, filter)).length
  return {
    all: rows.length,
    down: count('down'),
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

export interface Verdict {
  state: UiState
  /** The answer to the page's question, in words. */
  text: string
  /** Quiet second line, or null. */
  detail: string | null
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

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The shell's reading of the two gateways (`signals.systems`), when the page has it. */
export type GatewaySystems = Partial<Record<'openclaw' | 'hermes', { state: string } | null | undefined>> | null | undefined

const GATEWAY_NAME = { openclaw: 'OpenClaw', hermes: 'Hermes' } as const

/** Gateways the shell reports as warning or critical, in words ("OpenClaw is reporting a warning"). */
function gatewayReports(systems: GatewaySystems): Array<{ name: string; state: 'warning' | 'critical' }> {
  if (!systems) return []
  const reports: Array<{ name: string; state: 'warning' | 'critical' }> = []
  for (const id of ['openclaw', 'hermes'] as const) {
    const raw = systems[id]
    if (!raw || typeof raw.state !== 'string') continue
    const state = toUiState(raw.state)
    if (state === 'warning' || state === 'critical') reports.push({ name: GATEWAY_NAME[id], state })
  }
  return reports
}

/**
 * The worst state in words. Down services and unreachable endpoints are red;
 * anything not read keeps the verdict grey. The verdict says only what was
 * observed: "No service is down" is not "everything is as expected", so a service
 * without a definition file (its kind is unknown) or a gateway the shell reports
 * as warning keeps the line amber and is named.
 */
export function servicesVerdict(data: ServicesData | null | undefined, systems?: GatewaySystems): Verdict {
  if (!data) return { state: 'unavailable', text: 'Services could not be read', detail: null }

  const rows = Array.isArray(data.services) ? data.services : null
  const down = rows ? rows.filter(isAbnormal).length : 0
  const unreadRows = rows ? rows.filter((row) => serviceStatus(row).state === 'unavailable').length : 0
  const unidentified = rows ? rows.filter((row) => row.kind === null).length : 0
  const reports = gatewayReports(systems)

  const endpoints = ENDPOINTS.map((entry) => ({ name: entry.name, reading: endpointReading(entry.pick(data)) }))
  const endpointsDown = endpoints.filter((e) => e.reading.state === 'critical').map((e) => e.name)
  const endpointsUnread = endpoints.filter((e) => e.reading.state === 'unavailable').map((e) => e.name)
  const endpointsStale = endpoints.filter((e) => e.reading.state === 'warning').map((e) => e.name)

  const running = rows ? rows.filter((row) => row.state === 'running').length : 0
  const idle = rows ? rows.filter((row) => row.state === 'idle').length : 0
  const detail = rows ? `${running} running · ${idle} idle` : null

  if (down > 0 || endpointsDown.length > 0) {
    const parts: string[] = []
    if (down > 0) parts.push(`${down} ${plural(down, 'service is', 'services are')} down`)
    if (endpointsDown.length > 0) {
      parts.push(`${joinNames(endpointsDown)} ${plural(endpointsDown.length, 'is', 'are')} not reachable`)
    }
    return { state: 'critical', text: capitalize(parts.join(' and ')), detail }
  }

  if (!rows) {
    return { state: 'unavailable', text: 'The service list could not be read', detail: null }
  }
  if (rows.length === 0) {
    return { state: 'unavailable', text: 'No services were found', detail: null }
  }

  const unread = [...endpointsUnread, ...endpointsStale]
  if (unreadRows > 0 || unread.length > 0) {
    const what = [
      ...(unreadRows > 0 ? [`${unreadRows} ${plural(unreadRows, 'service', 'services')}`] : []),
      ...unread,
    ]
    return {
      state: endpointsStale.length > 0 && unreadRows === 0 && endpointsUnread.length === 0 ? 'warning' : 'unavailable',
      text: `No service is down, but ${joinNames(what)} could not be fully read`,
      detail,
    }
  }

  const caveats: string[] = []
  if (unidentified > 0) {
    caveats.push(
      `${unidentified} ${plural(unidentified, 'service has', 'services have')} no definition file, so ${plural(unidentified, 'its', 'their')} kind is unknown`,
    )
  }
  if (reports.length > 0) {
    const critical = reports.filter((report) => report.state === 'critical').map((report) => report.name)
    const warning = reports.filter((report) => report.state === 'warning').map((report) => report.name)
    if (critical.length > 0) caveats.push(`${joinNames(critical)} ${plural(critical.length, 'is', 'are')} reporting a critical state`)
    if (warning.length > 0) caveats.push(`${joinNames(warning)} ${plural(warning.length, 'is', 'are')} reporting a warning`)
  }
  if (caveats.length > 0) {
    return {
      state: reports.some((report) => report.state === 'critical') ? 'critical' : 'warning',
      text: `No service is down, but ${joinNames(caveats)}`,
      detail,
    }
  }

  return { state: 'healthy', text: `No service is down (${rows.length} read)`, detail }
}
