/**
 * Number formatting for the Local models page.
 *
 * Sizes use decimal units (1 GB = 1,000,000,000 bytes), the same base as the
 * model sizes Ollama reports ("16.5 GB"), so a model size and a memory figure on
 * this page can be compared directly. Raw readings arrive in bytes or in MiB;
 * both are converted to bytes first.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
const BYTES_PER_MIB = 1024 * 1024

export function finiteNumber(value?: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** "87.4 GB" from bytes; "—" when the reading is missing. 0 bytes is a real "0 B". */
export function formatSize(bytes?: number | null): string {
  const n = finiteNumber(bytes)
  if (n === null || n < 0) return '—'
  let value = n
  let index = 0
  while (value >= 1000 && index < UNITS.length - 1) {
    value /= 1000
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${UNITS[index]}`
}

/** Same as `formatSize` for a reading given in MiB (the GPU counters). */
export function formatMiB(mib?: number | null): string {
  const n = finiteNumber(mib)
  return n === null ? '—' : formatSize(n * BYTES_PER_MIB)
}

/** "45.2K". A missing count is "—", never "0"; a real zero is "0". */
export function formatTokens(value?: number | null): string {
  const n = finiteNumber(value)
  if (n === null || n < 0) return '—'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 1 : 2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 1 : 2)}K`
  return String(Math.round(n))
}

/** One row of the costs payload's `byService` as this page reads it. */
export interface TokenServiceUsage {
  name: string
  cost?: number
  tokens?: number
  sessions?: number
  percentage?: number
  agent?: string
  costSource?: string
  costStatus?: string
  billingModes?: string
  /** Explicit locality from record metadata: true local, false not local, null unknown. Names never decide it. */
  isLocal?: boolean | null
}

export interface ModelTokenUsage {
  tokens: number
  sessions: number
  cost: number
  percentage: number
  sources: string[]
  costSources: string[]
}

/** A usage name matched to an Ollama model name: agent prefix, endpoint prefix and `:latest` removed. */
export function canonicalLocalModelName(value?: string | null): string {
  return String(value || '')
    .trim()
    .replace(/^(OpenClaw|Hermes)\s*\/\s*/i, '')
    .replace(/^(ollama|custom|lmstudio|local)\//i, '')
    .replace(/:latest$/i, '')
    .toLowerCase()
}

/**
 * Token usage of local models, by model name. Only a row the server marked
 * `isLocal: true` counts; `false` is not local and `null` is unknown, and
 * neither is guessed from its name.
 */
export function aggregateLocalTokenUsage(services: readonly TokenServiceUsage[] = []): Map<string, ModelTokenUsage> {
  const usage = new Map<string, ModelTokenUsage>()
  for (const service of services) {
    if (service.isLocal !== true) continue
    const rawName = String(service.name || '')
    const key = canonicalLocalModelName(rawName)
    if (!key) continue
    const existing = usage.get(key) || { tokens: 0, sessions: 0, cost: 0, percentage: 0, sources: [], costSources: [] }
    existing.tokens += Number(service.tokens || 0)
    existing.sessions += Number(service.sessions || 0)
    existing.cost += Number(service.cost || 0)
    existing.percentage += Number(service.percentage || 0)
    const source = String(service.agent || '').trim() || rawName.split('/')[0]?.trim()
    if (source && !existing.sources.includes(source)) existing.sources.push(source)
    const costSource = String(service.costSource || service.costStatus || service.billingModes || '').trim()
    if (costSource && !existing.costSources.includes(costSource)) existing.costSources.push(costSource)
    usage.set(key, existing)
  }
  return usage
}

/** How many usage rows the server could not classify as local or not (`isLocal` is null or absent). */
export function countUnknownLocality(services: readonly TokenServiceUsage[] = []): number {
  return services.filter((service) => typeof service.isLocal !== 'boolean').length
}

export interface LocalTokenSplit {
  /** Tokens used by models in the Ollama list. */
  listed: number
  /** Tokens from local-style endpoints that are not in the Ollama list. */
  other: number
}

/**
 * Split local token usage into what belongs to the listed models and what does
 * not, so the figure above the table is the sum of what the table shows.
 */
export function splitLocalTokens(
  usageByModel: ReadonlyMap<string, { tokens: number }>,
  listedKeys: ReadonlySet<string>,
): LocalTokenSplit {
  let listed = 0
  let other = 0
  for (const [key, usage] of usageByModel) {
    if (listedKeys.has(key)) listed += usage.tokens
    else other += usage.tokens
  }
  return { listed, other }
}

/**
 * The sentence above the models table about token usage. It says where the
 * figure comes from and never counts tokens that no row shows as if they did.
 */
export function describeTokenUsage(split: LocalTokenSplit, periodLabel: string, unknownLocality = 0): string {
  const period = periodLabel.toLowerCase()
  const parts: string[] = []
  parts.push(
    split.listed > 0
      ? `${formatTokens(split.listed)} tokens across these models`
      : 'No tokens recorded for these models',
  )
  if (split.other > 0) parts.push(`${formatTokens(split.other)} more from local models not listed here`)
  if (unknownLocality > 0) {
    parts.push(
      `${unknownLocality} ${unknownLocality === 1 ? 'usage entry' : 'usage entries'} not counted: it is not known whether ${unknownLocality === 1 ? 'it ran' : 'they ran'} locally`,
    )
  }
  parts.push(period)
  return parts.join(' · ')
}

/** One reading of the telemetry history, as far as a trend needs it. */
export interface HistoryReading {
  generatedAt: string
}

export interface SeriesPoint {
  t: number
  v: number
}

/**
 * A trend series from the history the API really returned: one point per reading that has a finite value,
 * in time order. Readings without the value (null, missing) are left out, never filled in. A long history is
 * thinned by taking evenly spaced readings (always keeping the last), so the drawing stays small.
 */
export function historySeries<T extends HistoryReading>(
  history: readonly T[] | null | undefined,
  pick: (item: T) => number | null | undefined,
  maxPoints = 288,
): SeriesPoint[] {
  const points: SeriesPoint[] = []
  for (const item of history ?? []) {
    const t = Date.parse(item.generatedAt)
    const v = finiteNumber(pick(item))
    if (Number.isFinite(t) && v !== null) points.push({ t, v })
  }
  points.sort((a, b) => a.t - b.t)
  if (points.length <= maxPoints || maxPoints < 2) return points
  const step = (points.length - 1) / (maxPoints - 1)
  const thinned: SeriesPoint[] = []
  for (let i = 0; i < maxPoints; i += 1) thinned.push(points[Math.round(i * step)])
  return thinned
}
