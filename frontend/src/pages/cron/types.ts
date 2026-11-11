export type CronScheduler = 'openclaw' | 'hermes'

export interface CronHistoryEntry {
  status?: string
}

export interface CronJobActions {
  run?: boolean
  toggle?: boolean
  delete?: boolean
  model?: boolean
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
}

/** GET /api/cron `summary`: `active` counts every enabled job, failed ones included. */
export interface CronSummary {
  active?: number
  paused?: number
  failed?: number
  nextRunAt?: string | null
  /** The server's plain-words definitions of its counts (`active` includes failed jobs). */
  definitions?: { active?: string; failed?: string }
}

export interface CronApiResponse {
  jobs?: CronJob[]
  summary?: CronSummary
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

export type CronStatusFilter = 'all' | 'active' | 'disabled' | 'failed' | 'overlap'
