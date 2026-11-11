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
export function describeTokenUsage(split: LocalTokenSplit, periodLabel: string): string {
  const period = periodLabel.toLowerCase()
  const parts: string[] = []
  parts.push(
    split.listed > 0
      ? `${formatTokens(split.listed)} tokens across these models`
      : 'No token usage recorded for these models',
  )
  if (split.other > 0) parts.push(`${formatTokens(split.other)} more by local endpoints not in this list`)
  parts.push(period)
  return parts.join(' · ')
}

/** What the GPU "memory" utilisation counter really measures, by where it was read. */
export function gpuLoadLabel(metricSource?: string | null): string {
  return metricSource === 'apple-ioreg' ? 'Tiler load' : 'Memory controller load'
}
