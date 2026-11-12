export interface TrendPoint {
  /** Time of the reading, epoch ms. */
  t: number
  v: number
}

/** The usable points: finite, in time order. */
export function trendPoints(points: ReadonlyArray<TrendPoint> | null | undefined): TrendPoint[] {
  if (!points) return []
  return points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t)
}


export interface TrendDomain {
  lo: number
  hi: number
  /** The lowest and highest reading, as read. */
  min: number
  max: number
  /** The part of the normal band that lies inside the domain, or null when it does not or covers everything. */
  band: readonly [number, number] | null
  /** The band covers the whole domain: it says nothing a series can be read against, so it is not drawn. */
  bandCoversAll: boolean
}

/** Padding above and below the data, as a share of its span. */
export const TREND_PAD = 0.15

/**
 * The y-domain of a trend: the data's own range padded by 15%, never narrower than `minSpan` (a flat
 * series becomes a calm line in the middle, not noise). The normal band does not widen it; it is only
 * clipped to it.
 */
export function trendDomain(values: ReadonlyArray<number>, band: readonly [number, number] | undefined, minSpan: number): TrendDomain {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const floor = minSpan > 0 && Number.isFinite(minSpan) ? minSpan : Math.max(Math.abs(max) * 0.01, 1e-6)
  const span = max - min
  let lo: number
  let hi: number
  if (span * (1 + 2 * TREND_PAD) >= floor) {
    lo = min - span * TREND_PAD
    hi = max + span * TREND_PAD
  } else {
    const middle = (min + max) / 2
    lo = middle - floor / 2
    hi = middle + floor / 2
  }
  let inside: readonly [number, number] | null = null
  let covers = false
  if (band) {
    const from = Math.max(Math.min(band[0], band[1]), lo)
    const to = Math.min(Math.max(band[0], band[1]), hi)
    if (to > from) {
      covers = from <= lo && to >= hi
      inside = covers ? null : [from, to]
    }
  }
  return { lo, hi, min, max, band: inside, bandCoversAll: covers }
}
