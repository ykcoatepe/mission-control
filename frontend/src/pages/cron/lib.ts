import type {
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
  { label: 'Every 30min', expr: '*/30 * * * *' },
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

export function successRateColor(pct: number): string {
  return pct === 100 ? '#32D74B' : pct >= 75 ? '#FFD60A' : pct >= 50 ? '#FF9500' : '#FF453A'
}

// ── Scheduler helpers ─────────────────────────────────────────────────────

export function getCronScheduler(job?: Pick<CronJob, 'scheduler'>): CronScheduler {
  return job?.scheduler === 'hermes' ? 'hermes' : 'openclaw'
}

export function getCronSchedulerLabel(job?: Pick<CronJob, 'scheduler' | 'schedulerLabel'>) {
  return job?.schedulerLabel || (getCronScheduler(job) === 'hermes' ? 'Hermes' : 'OpenClaw')
}

export function getCronSchedulerColor(job?: Pick<CronJob, 'scheduler'>) {
  return getCronScheduler(job) === 'hermes' ? '#64D2FF' : '#BF5AF2'
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

  return [{ value: '', label: 'Default' }, ...Array.from(byId.values())]
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
    const detail = `${bucket.length} jobs share the next execution window`
    for (const job of bucket) {
      markers.set(job.id, { count: bucket.length, label: `Overlap ${label}`, detail })
    }
  }

  for (const [key, bucket] of scheduleBuckets.entries()) {
    if (bucket.length < 2) continue
    const [hour, minute] = key.split('|')
    const label = hour === '*'
      ? `Overlap :${minute.padStart(2, '0')}`
      : `Overlap ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    const detail = `${bucket.length} enabled jobs share the same cron slot`
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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Fetch wrapper for cron write endpoints: resolves on 2xx, otherwise throws
 * an Error carrying the server's `{ error }` message when one is present.
 */
export async function cronFetch(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (res.ok) return
  let message = `HTTP ${res.status}`
  try {
    const body = await res.json()
    if (body && typeof body.error === 'string' && body.error) message = body.error
  } catch {
    // non-JSON error body; keep the HTTP status message
  }
  throw new Error(message)
}
