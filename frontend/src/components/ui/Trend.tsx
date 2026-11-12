import { cx } from './cx'
import { trendPoints } from './trendPoints'
import type { TrendPoint } from './trendPoints'
import styles from './Trend.module.css'

export type { TrendPoint }

export interface TrendProps {
  points: ReadonlyArray<TrendPoint> | null | undefined
  /** The normal band, drawn behind the line. */
  band?: readonly [number, number]
  height?: number
  /** Accessible name. Default "24-hour trend". */
  label?: string
  className?: string
}

const WIDTH = 120

/**
 * A small line of real history, as inline SVG. Fewer than two readings draw nothing at all:
 * a trend is never invented (HMI rule 5).
 */
export function Trend({ points, band, height = 28, label = '24-hour trend', className }: TrendProps) {
  const data = trendPoints(points)
  if (data.length < 2) return null

  const values = data.map((p) => p.v)
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (band) {
    lo = Math.min(lo, band[0])
    hi = Math.max(hi, band[1])
  }
  if (hi === lo) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.1
  lo -= pad
  hi += pad
  const t0 = data[0].t
  const span = data[data.length - 1].t - t0 || 1
  const x = (t: number) => ((t - t0) / span) * WIDTH
  const y = (v: number) => height - ((v - lo) / (hi - lo)) * height
  const path = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`).join(' ')

  return (
    <svg
      className={cx(styles.trend, className)}
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      height={height}
      role="img"
      aria-label={label}
    >
      {band && (
        <rect
          className={styles.band}
          x={0}
          width={WIDTH}
          y={y(band[1])}
          height={Math.max(0, y(band[0]) - y(band[1]))}
        />
      )}
      <path className={styles.line} d={path} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
