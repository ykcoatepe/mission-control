export type CronScheduler = 'openclaw' | 'hermes'

export interface CronHistoryEntry {
  status?: string
  /** Why a run failed, when the scheduler recorded a reason. */
  error?: string | null
}

export interface CronJobActions {
  run?: boolean
  toggle?: boolean
  delete?: boolean
  model?: boolean
}

/** An acknowledgement or shelving of a failed job (POST /api/attention/acks). `until` is null for "until I undo". */
export interface CronAck {
  kind: 'ack' | 'shelve'
  at: string
  until: string | null
}

export interface CronJob {
  id: string
  sourceId?: string
  scheduler?: CronScheduler
  schedulerLabel?: string
  actions?: CronJobActions
  name: string
  /** null when the scheduler did not report one (`scheduleKind: 'interval_unknown'`). */
  schedule: string | null
  /** How the schedule is read: `interval` uses `everyMs`, `cron` the expression. Absent in older payloads. */
  scheduleKind?: 'interval' | 'interval_unknown' | 'cron' | 'at' | 'unknown' | 'manual' | string
  everyMs?: number | null
  status: string
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  duration: string | null
  target: string
  payload: string
  model?: string
  thinking?: string
  description: string
  history: CronHistoryEntry[]
  /** Why the last run failed, when the API reports it. Absent today: only run history can carry a reason. */
  lastError?: string | null
  /** The scheduler confirmed the last change to this job. `false`: the command was sent and the read-back failed. */
  verified?: boolean
  /** An active job whose next run is already in the past. It is not "next". */
  nextRunOverdue?: boolean
  /** Past its time but inside the server's grace window; about to run. */
  nextRunDue?: boolean
  /** Hermes only: the scheduler's own state, whether it is switched on upstream, and when and why it was paused. */
  schedulerState?: string | null
  upstreamEnabled?: boolean | null
  pausedAt?: string | null
  pausedReason?: string | null
  /** The key to acknowledge or shelve this job with (`cron:<job id>`). Absent in older payloads: no controls then. */
  ackKey?: string
  /** null: not acknowledged. A failed job with an ack is a standing condition, not a new failure. */
  ack?: CronAck | null
}

/** GET /api/cron `summary`: `active` counts every enabled job, failed ones included. */
export interface CronSummary {
  active?: number
  paused?: number
  /** Failed jobs that are NOT acknowledged or shelved: the new failures. */
  failed?: number
  /** Failed jobs that are acknowledged or shelved. */
  standingFailed?: number
  nextRunAt?: string | null
  /** The server's plain-words definitions of its counts (`active` includes failed jobs). */
  definitions?: { active?: string; failed?: string; standingFailed?: string }
}

/** One scheduler's proof in GET /api/cron `schedulers`. A scheduler that was not read has `sourceSucceeded: false` and no jobs in the list. */
export interface CronSchedulerProof {
  sourceSucceeded?: boolean
  provenance?: string
  /** When this reading was taken. null when the scheduler has never been read. */
  observedAt?: string | null
  /** The jobs come from the last good reading, older than the scheduler's fresh window. */
  stale?: boolean
  staleAgeMs?: number
  cacheAgeMs?: number
}

/** GET /api/cron `meta`: how good the whole reading is. `ok: false` with `stale: true` means a scheduler is missing or cached. */
export interface CronMeta {
  ok?: boolean
  stale?: boolean
  observedAt?: string | null
  ageMs?: number | null
  error?: { code?: string; message?: string } | null
}

export interface CronApiResponse {
  jobs?: CronJob[]
  summary?: CronSummary
  schedulers?: Partial<Record<CronScheduler, CronSchedulerProof>>
  meta?: CronMeta
}

export interface CronModelResponse {
  id?: string
  name?: string
}

export interface CreateCronJobPayload {
  name: string
  schedule: {
    kind: 'cron'
    expr: string
  }
  sessionTarget: string
  payload: {
    kind: string
    message: string
    model?: string
  }
  enabled: boolean
}

export interface ModelOption {
  value: string
  label: string
}

export interface SuccessRate {
  rate: string
  pct: number
  total: number
  ok: number
  failed: number
}

export interface CronOverlapMarker {
  count: number
  label: string
  detail: string
}

export interface CronOverlapState {
  markers: Map<string, CronOverlapMarker>
  affectedJobs: number
  windows: number
}

export type CronStatusFilter = 'all' | 'active' | 'disabled' | 'failed' | 'standing' | 'overlap'
