import type { CSSProperties } from 'react'
import { cx } from './cx'
import { trendDomain, trendPoints } from './trendPoints'
import type { TrendPoint } from './trendPoints'
import styles from './Trend.module.css'

export type { TrendPoint }

export interface TrendProps {
  points: ReadonlyArray<TrendPoint> | null | undefined
  /** The normal band: a faint tint, drawn only where it lies inside the plot. */
  band?: readonly [number, number]
  /** The plot's height; it is the least height when the parent gives it more room (`align-self: stretch`). */
  height?: number
  /** The smallest span of values the plot may show, so a flat series stays a calm centred line. */
  minSpan?: number
  /** Writes the lowest and highest reading. Default: the number as it is. */
  format?: (n: number) => string
  /** Accessible name. Default "24-hour trend". */
  label?: string
  className?: string
}

const WIDTH = 120

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/**
 * A small chart of real history, as inline SVG: the line in neutral text colour, the last reading
 * marked, the lowest and highest labelled when they differ. Fewer than two readings draw nothing at
 * all: a trend is never invented (HMI rule 5).
 */
export function Trend({ points, band, height = 36, minSpan, format = NUMBER.format, label = '24-hour trend', className }: TrendProps) {
  const data = trendPoints(points)
  if (data.length < 2) return null

  const domain = trendDomain(
    data.map((p) => p.v),
    band,
    minSpan ?? 0,
  )
  const { lo, hi } = domain
  const t0 = data[0].t
  const span = data[data.length - 1].t - t0 || 1
  const x = (t: number) => ((t - t0) / span) * WIDTH
  const y = (v: number) => height - ((v - lo) / (hi - lo)) * height
  const path = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`).join(' ')
  const last = data[data.length - 1]
  const differ = domain.max !== domain.min

  return (
    <div className={cx(styles.trend, className)} style={{ minHeight: height }}>
      <span className={styles.plot}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${WIDTH} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          data-band={domain.band ? 'partial' : domain.bandCoversAll ? 'covers' : undefined}
        >
          {domain.band && (
            <rect
              className={styles.band}
              x={0}
              width={WIDTH}
              y={y(domain.band[1])}
              height={Math.max(0, y(domain.band[0]) - y(domain.band[1]))}
            />
          )}
          <path className={styles.line} d={path} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <span
          className={styles.last}
          data-testid="trend-last"
          style={{ '--top': `${(y(last.v) / height) * 100}%` } as CSSProperties}
          aria-hidden="true"
        />
      </span>
      {differ && (
        <span className={styles.ends}>
          <span data-end="max">{format(domain.max)}</span>
          <span data-end="min">{format(domain.min)}</span>
        </span>
      )}
    </div>
  )
}
