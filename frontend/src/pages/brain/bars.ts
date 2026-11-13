import type { TrendSeriesPoint } from './types'

/**
 * GBrain's own line for a healthy brain: a quality score of 90 or more (server/sources/gbrain/verdict.js
 * HEALTHY_SCORE, and liveProbes.js, which reads below 90 as a warning). The server defines no other
 * range for the readings below.
 */
export const QUALITY_NORMAL: readonly [number, number] = [90, 100]

/** The scale's top for the queue: 4, 8, 16... the first that holds the total. */
export function queueScaleMax(total: number): number {
  let max = 4
  while (max < total) max *= 2
  return max
}

/** A usable series, or nothing: fewer than two real readings is no trend. */
export function trendOf(series: TrendSeriesPoint[] | undefined | null): TrendSeriesPoint[] | undefined {
  const points = (series ?? []).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
  return points.length >= 2 ? points : undefined
}
