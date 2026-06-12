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
  schedule: string
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

export interface CronApiResponse {
  jobs?: CronJob[]
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
