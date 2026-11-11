import { describeApiError, sendJson } from '../../lib/hooks'
import type {
  CronApiResponse,
  CronJob,
  CronModelResponse,
  CronOverlapMarker,
  CronOverlapState,
  CronScheduler,
  CronHistoryEntry,
  ModelOption,
  SuccessRate,
} from './types'

// ── Cron expression presets ───────────────────────────────────────────────

export const CRON_PRESETS = [
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Daily 8am', expr: '0 8 * * *' },
  { label: 'Daily 6pm', expr: '0 18 * * *' },
  { label: 'Weekly Monday', expr: '0 9 * * 1' },
  { label: 'Every 30 minutes', expr: '*/30 * * * *' },
]

// ── Success rate ──────────────────────────────────────────────────────────

export function calcSuccessRate(history: CronHistoryEntry[]): SuccessRate | null {
  if (!history || history.length === 0) return null
  const total = history.length
  const ok = history.filter((h) => h.status === 'done' || h.status === 'success' || h.status === 'ok').length
  const failed = total - ok
  const pct = Math.round((ok / total) * 100)
  return { rate: `${pct}%`, pct, total, ok, failed }
}

// ── Scheduler helpers ─────────────────────────────────────────────────────

export function getCronScheduler(job?: Pick<CronJob, 'scheduler'>): CronScheduler {
  return job?.scheduler === 'hermes' ? 'hermes' : 'openclaw'
}

export function getCronSchedulerLabel(job?: Pick<CronJob, 'scheduler' | 'schedulerLabel'>) {
  return job?.schedulerLabel || (getCronScheduler(job) === 'hermes' ? 'Hermes' : 'OpenClaw')
}

// ── Model options ─────────────────────────────────────────────────────────

export const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { value: 'openai-codex/gpt-5.5', label: 'GPT-5.5' },
]

export const CRON_MODEL_ALIASES: Record<string, string> = {
  'local-qwen3.6-35b-a3b-nvfp4': 'ollama/qwen3.6:35b-a3b-nvfp4',
}

export const CLOUD_AGENT_MODEL = 'openai-codex/gpt-5.5'
const DISALLOWED_CLOUD_MODEL_RE = /^(anthropic\/|claude-cli\/|openrouter\/|qwen\/|minimax|minimax-portal\/|openai\/gpt-5\.4|openai-codex\/gpt-5\.[234])/i

export function isDisallowedCloudModel(id: string) {
  const key = String(id || '').trim()
  return !!key && key !== CLOUD_AGENT_MODEL && DISALLOWED_CLOUD_MODEL_RE.test(key)
}

export function normalizeCronModelValue(id?: string) {
  const key = String(id || '').trim()
  return CRON_MODEL_ALIASES[key] || key
}

export function formatCronModelLabel(id: string, name?: string) {
  const key = String(id || '').trim()
  const base = String(name || key || '').trim() || 'Unknown model'
  if (!key) return base
  const localSuffixNeeded = key.startsWith('ollama/') && !key.includes(':cloud') && !/\((local|ollama)\)$/i.test(base)
  return localSuffixNeeded ? `${base} (local)` : base
}

export function buildCronModelOptions(models: CronModelResponse[] = [], jobs: CronJob[] = []): ModelOption[] {
  const byId = new Map<string, ModelOption>()
  const registryIds = new Set<string>()
  const add = (value: string, label?: string, fromCurrentJobOnly = false) => {
    const key = normalizeCronModelValue(value)
    if (!fromCurrentJobOnly && isDisallowedCloudModel(key)) return
    if (!key) return
    const next = { value: key, label: formatCronModelLabel(key, label) }
    if (byId.has(key)) {
      if (!fromCurrentJobOnly) byId.set(key, next)
      return
    }
    byId.set(key, next)
  }

  for (const model of models || []) {
    const id = normalizeCronModelValue(String(model?.id || ''))
    if (id && !isDisallowedCloudModel(id)) registryIds.add(id)
    add(id, String(model?.name || model?.id || ''))
  }
  for (const fallback of FALLBACK_MODEL_OPTIONS) add(fallback.value, fallback.label)
  for (const job of jobs || []) {
    const rawModel = String(job?.model || '')
    const normalizedModel = normalizeCronModelValue(rawModel)
    const isAlias = rawModel.trim() !== normalizedModel
    const fromCurrentJobOnly = !!normalizedModel && !registryIds.has(normalizedModel) && !FALLBACK_MODEL_OPTIONS.some((option) => option.value === normalizedModel)
    add(normalizedModel, isAlias ? `${rawModel} → ${normalizedModel}` : normalizedModel, fromCurrentJobOnly)
  }

  return [{ value: '', label: 'Default' }, ...disambiguateLabels(Array.from(byId.values()))]
}

/** Two different models can share a display name; those show their id too, so the list never has two identical lines. */
export function disambiguateLabels(options: ModelOption[]): ModelOption[] {
  const seen = new Map<string, number>()
  for (const option of options) seen.set(option.label, (seen.get(option.label) ?? 0) + 1)
  return options.map((option) => ((seen.get(option.label) ?? 0) > 1 ? { ...option, label: `${option.label} (${option.value})` } : option))
}

// ── Overlap markers ───────────────────────────────────────────────────────

export function formatOverlapMinute(dateStr?: string | null) {
  if (!dateStr) return null
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function buildCronOverlapMarkers(jobs: CronJob[]): CronOverlapState {
  const markers = new Map<string, CronOverlapMarker>()
  const nextRunBuckets = new Map<string, CronJob[]>()
  const scheduleBuckets = new Map<string, CronJob[]>()

  for (const job of jobs || []) {
    if (!job?.enabled) continue

    if (job.nextRun) {
      const key = job.nextRun.slice(0, 16)
      const bucket = nextRunBuckets.get(key) || []
      bucket.push(job)
      nextRunBuckets.set(key, bucket)
      continue
    }

    // Only a cron expression has a minute and an hour slot to share; an interval has none.
    if (job.scheduleKind && job.scheduleKind !== 'cron') continue
    const parts = String(job.schedule || '').trim().split(/\s+/)
    if (parts.length < 2) continue
    const [minute, hour] = parts
    if (!minute || !hour || minute === '*') continue
    const key = `${hour}|${minute}`
    const bucket = scheduleBuckets.get(key) || []
    bucket.push(job)
    scheduleBuckets.set(key, bucket)
  }

  for (const bucket of nextRunBuckets.values()) {
    if (bucket.length < 2) continue
    const label = formatOverlapMinute(bucket[0]?.nextRun) || 'same minute'
    const detail = `${bucket.length} jobs run in this time slot`
    for (const job of bucket) {
      markers.set(job.id, { count: bucket.length, label: `Same time slot at ${label}`, detail })
    }
  }

  for (const [key, bucket] of scheduleBuckets.entries()) {
    if (bucket.length < 2) continue
    const [hour, minute] = key.split('|')
    const label = hour === '*'
      ? `Same time slot at :${minute.padStart(2, '0')}`
      : `Same time slot at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    const detail = `${bucket.length} enabled jobs run in this time slot`
    for (const job of bucket) {
      if (!markers.has(job.id)) {
        markers.set(job.id, { count: bucket.length, label, detail })
      }
    }
  }

  return {
    markers,
    affectedJobs: markers.size,
    windows: new Set(Array.from(markers.values()).map((marker) => marker.label)).size,
  }
}

// ── Row entrance stagger ──────────────────────────────────────────────────

/**
 * Entrance-animation delay for the row at `index`. The per-row stagger stops
 * growing after `capIndex` rows so a long list (~100 jobs) doesn't take
 * seconds to finish appearing.
 */
export function rowStaggerDelay(index: number, base: number, step: number, capIndex = 10) {
  return base + Math.min(index, capIndex) * step
}

// ── Write helper ──────────────────────────────────────────────────────────

/** Readable text for any failure: the server's own message for 400/409, "busy" for 429, "not available" for 503. */
export function errorMessage(err: unknown): string {
  return describeApiError(err, String(err))
}

/**
 * Cron write endpoints: resolves on 2xx, otherwise throws the shared `ApiError`
 * carrying the server's `{ error: { code, message } }`. Goes through `sendJson`,
 * which adds the write-guard header.
 */
export async function cronRequest(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<void> {
  await sendJson(url, method, body)
}

/**
 * What a cron write answers: `job` is the committed job as the list shows it
 * (a deleted job carries `deleted: true`); create names it `entity`. `meta.stale`
 * means the write succeeded but a dependent reading is still catching up.
 */
export interface CronWriteResponse {
  ok?: boolean
  message?: string
  /** The scheduler shows the change. `false`: the command was sent and the read-back failed; nothing was promoted. */
  verified?: boolean
  /** On an unconfirmed write: the values that were asked for (never shown as current). */
  requested?: unknown
  job?: Partial<CronJob> & { deleted?: boolean }
  entity?: Partial<CronJob>
  meta?: { ok?: boolean; stale?: boolean; error?: { code?: string; message?: string } | null }
}

/** Same request as `cronRequest`, but hands back the committed entity. */
export async function cronWrite(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<CronWriteResponse | null> {
  const response = await sendJson<CronWriteResponse | null>(url, method, body)
  return response && typeof response === 'object' ? response : null
}

export type CronWriteArg =
  | { kind: 'update'; jobId: string; response: CronWriteResponse | null }
  | { kind: 'delete'; jobId: string; response: CronWriteResponse | null }
  | { kind: 'create'; response: CronWriteResponse | null }

const isWholeJob = (job: Partial<CronJob> | undefined): job is CronJob =>
  Boolean(job) && typeof job?.id === 'string' && typeof job?.name === 'string' && typeof job?.enabled === 'boolean'

/**
 * The list after a write, from what the server reports. Only what the system confirmed is put on screen:
 * an update merges the returned job over the one shown (when the command could not be confirmed the returned
 * job is the previous state, marked `verified: false`), a delete drops the row only when the answer says the
 * job is gone, a create adds the new job once. A requested value is never shown: with no usable job in the
 * answer the list stays as it is and the refetch decides.
 */
export function applyCronWrite(data: CronApiResponse, write: CronWriteArg): CronApiResponse {
  const jobs = data.jobs ?? []
  const committed = write.response?.job
  if (write.kind === 'delete') {
    if (committed?.deleted !== true || write.response?.verified === false) return data
    return { ...data, jobs: jobs.filter((job) => job.id !== write.jobId) }
  }
  if (write.kind === 'create') {
    const created = write.response?.entity ?? committed
    if (write.response?.verified === false || !isWholeJob(created) || jobs.some((job) => job.id === created.id)) return data
    return { ...data, jobs: [...jobs, created] }
  }
  if (!committed || committed.id !== write.jobId || committed.deleted === true || !jobs.some((job) => job.id === write.jobId)) return data
  // `deleted` is a marker on the response, not a field of the job.
  const fields: Partial<CronJob> & { deleted?: boolean } = { ...committed }
  delete fields.deleted
  return { ...data, jobs: jobs.map((job) => (job.id === write.jobId ? { ...job, ...fields } : job)) }
}
