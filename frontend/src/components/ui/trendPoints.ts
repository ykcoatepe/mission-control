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

