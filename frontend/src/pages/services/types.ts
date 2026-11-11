import type { ApiEnvelope } from '../../lib/signals'

/** One launchd service as `GET /api/services` reports it. */
export type ServiceKind = 'keepalive' | 'interval' | 'one-shot'

/** Derived by the server: running (has a pid), down (keepalive without a pid), failed, idle. */
export type ServiceStateWord = 'running' | 'idle' | 'down' | 'failed'

export interface ServiceRow {
  label: string
  /** `null` when the launchd definition could not be read. */
  kind: ServiceKind | null
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
  gateways: { openclaw: Endpoint | null; hermes: Endpoint | null } | null
  ollama: Endpoint | null
}

export type ServicesEnvelope = ApiEnvelope<ServicesData>

export type ServiceFilter = 'all' | 'down' | ServiceKind
