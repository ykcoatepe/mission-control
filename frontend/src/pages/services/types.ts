import type { ApiEnvelope } from '../../lib/signals'

/** One launchd service as `GET /api/services` reports it. */
export type ServiceKind = 'keepalive' | 'interval' | 'one-shot'

/** Derived by the server: running (has a pid), down (keepalive without a pid), failed, idle. */
export type ServiceStateWord = 'running' | 'idle' | 'down' | 'failed'

export interface ServiceRow {
  label: string
  /** `null` when the launchd definition could not be read. */
  kind: ServiceKind | null
  /** Whether the server could identify the service (read its definition file). false: its kind is unknown. */
  identified: boolean
  pid: number | null
  lastExitCode: number | null
  state: ServiceStateWord | string
  runAtLoad: boolean | null
  intervalSeconds: number | null
  calendar: boolean | null
  /** Whether the definition file was read: `read`, `not-found`, `unreadable`. */
  plist: string
  /** Optional server-written explanation of the state. Shown as given. */
  hint?: string | null
}

export interface ServiceCounts {
  total: number
  running: number
  idle: number
  down: number
  failed: number
}

/**
 * The server's own tally (`down` includes failed jobs). The verdict and the
 * filter chips read this; the page counts nothing itself.
 */
export interface ServicesSummary {
  total: number
  running: number
  idle: number
  down: number
  unidentified: number
}

/** `up` / `down` / `unknown` for probes; the Hermes gateway can also be `stale`. */
export type EndpointStateWord = 'up' | 'down' | 'unknown' | 'stale'

export interface Endpoint {
  state: EndpointStateWord | string
  reachable: boolean | null
  httpStatus?: number | null
  latencyMs?: number | null
  heartbeatAt?: string | null
  error: string | null
  observedAt: string | null
}

export interface ServicesData {
  services: ServiceRow[] | null
  counts: ServiceCounts | null
  summary: ServicesSummary | null
  gateways: { openclaw: Endpoint | null; hermes: Endpoint | null } | null
  ollama: Endpoint | null
}

export type ServicesEnvelope = ApiEnvelope<ServicesData>

export type ServiceFilter = 'all' | 'down' | 'unidentified' | ServiceKind
