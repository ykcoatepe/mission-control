import type { CSSProperties } from 'react'
import { stateLabel } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import { StateMark } from './StateMark'
import { Trend } from './Trend'
import { trendPoints } from './trendPoints'
import type { TrendPoint } from './trendPoints'
import styles from './AnalogBar.module.css'

export type AnalogLimit = number | { value: number; label?: string }

export interface AnalogBarProps {
  label: string
  /** The reading. Ignored when `unread`. */
  value: number | null | undefined
  min: number
  max: number
  /** The normal range. */
  band?: readonly [number, number]
  /** Labelled marks on the scale. Default: the ends of the scale and of the normal band. */
  limits?: ReadonlyArray<AnalogLimit>
  unit?: string
  format?: (n: number) => string
  /** Overrides the state derived from the band. */
  state?: UiState
  /** 24-hour history. Drawn only when there are at least two real readings. */
  trend?: ReadonlyArray<TrendPoint>
  /** The reading could not be taken: hollow circle and "not read", no value, no pointer, no trend. */
  unread?: boolean
  className?: string
}

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

function withUnit(text: string, unit?: string): string {
  if (!unit) return text
  return /^[%°]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n))
}

type Position = 'start' | 'mid' | 'end'

/** Limit labels that fit: the ends first, then the rest, dropping any that would sit on top of a kept one. */
function scaleLabels(
  limits: ReadonlyArray<{ value: number; label: string }>,
  pct: (n: number) => number,
  min: number,
  max: number,
): Array<{ value: number; label: string; at: number; position: Position }> {
  const ranked = [...limits].sort((a, b) => {
    const rank = (v: number) => (v === min ? 0 : v === max ? 1 : 2)
    return rank(a.value) - rank(b.value)
  })
  const kept: Array<{ value: number; label: string; at: number; position: Position }> = []
  for (const limit of ranked) {
    const at = pct(limit.value)
    if (kept.some((other) => Math.abs(other.at - at) < 12)) continue
    const position: Position = at <= 1 ? 'start' : at >= 99 ? 'end' : 'mid'
    kept.push({ ...limit, at, position })
  }
  return kept.sort((a, b) => a.at - b.at)
}

/**
 * A number with a normal range (HMI rule 5): a track, the normal band, a fill and pointer at the value,
 * the limits labelled and the value as digits. Healthy renders neutral; outside the band it takes the
 * caution colour together with a shape and a word. `role="meter"` carries the same reading to assistive tech.
 */
export function AnalogBar({
  label,
  value,
  min,
  max,
  band,
  limits,
  unit,
  format,
  state,
  trend,
  unread = false,
  className,
}: AnalogBarProps) {
  const fmt = (n: number) => withUnit((format ?? NUMBER.format)(n), unit)
  const range = max - min
  const sane = Number.isFinite(range) && range > 0
  const hasValue = !unread && typeof value === 'number' && Number.isFinite(value) && sane
  const v = hasValue ? (value as number) : 0
  const pct = (n: number) => (sane ? clampPct(((n - min) / range) * 100) : 0)

  let derived: UiState = 'healthy'
  let word: string | null = null
  if (!hasValue) {
    derived = 'unavailable'
    word = 'not read'
  } else if (band && v < band[0]) {
    derived = 'warning'
    word = 'below normal'
  } else if (band && v > band[1]) {
    derived = 'warning'
    word = 'above normal'
  }
  const effective: UiState = hasValue ? (state ?? derived) : 'unavailable'
  const abnormal = effective === 'warning' || effective === 'critical' || effective === 'unavailable'
  if (hasValue && state && state !== derived) word = state === 'healthy' ? null : stateLabel(state).toLowerCase()

  const bandText = band ? `${fmt(band[0])} – ${fmt(band[1])}` : null
  const valueText = hasValue ? fmt(v) : null
  const alternative = hasValue
    ? `${valueText}${bandText ? `, normal ${bandText}` : ''}${word ? `, ${word}` : ''}`
    : 'Not read'

  const defaults: AnalogLimit[] = band ? [min, band[0], band[1], max] : [min, max]
  const resolved = (limits ?? defaults).map((limit) =>
    typeof limit === 'number'
      ? { value: limit, label: (format ?? NUMBER.format)(limit) }
      : { value: limit.value, label: limit.label ?? (format ?? NUMBER.format)(limit.value) },
  )
  const labels = scaleLabels(resolved, pct, min, max)

  const history = trendPoints(trend)
  const showTrend = hasValue && history.length >= 2
  const average = showTrend ? history.reduce((sum, p) => sum + p.v, 0) / history.length : null

  return (
    <div className={cx(styles.bar, className)} data-state={effective}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        <span className={styles.reading}>
          {abnormal && word && (
            <span className={styles.word}>
              <StateMark state={effective} />
              {word}
            </span>
          )}
          <span className={styles.value}>{valueText ?? '—'}</span>
        </span>
      </div>
      {bandText && <p className={styles.normal}>Normal: {bandText}</p>}
      <div
        className={styles.track}
        role="meter"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={hasValue ? Math.min(max, Math.max(min, v)) : undefined}
        aria-valuetext={alternative}
      >
        {band && sane && (
          <span
            className={styles.band}
            style={{ '--from': `${pct(band[0])}%`, '--to': `${pct(band[1])}%` } as CSSProperties}
          />
        )}
        {hasValue && <span className={styles.fill} style={{ '--at': `${pct(v)}%` } as CSSProperties} />}
        {hasValue && <span className={styles.pointer} style={{ '--at': `${pct(v)}%` } as CSSProperties} />}
        {labels.map((l) => (
          <span key={l.value} className={styles.tick} style={{ '--at': `${l.at}%` } as CSSProperties} />
        ))}
      </div>
      <div className={styles.scale} aria-hidden="true">
        {labels.map((l) => (
          <span key={l.value} className={styles.limit} data-position={l.position} style={{ '--at': `${l.at}%` } as CSSProperties}>
            {l.label}
          </span>
        ))}
      </div>
      {showTrend && (
        <div className={styles.trend}>
          <span className={styles.trendWords}>
            <span>24h trend</span>
            <span className={styles.trendAvg}>{fmt(average as number)} avg</span>
          </span>
          <Trend points={history} band={band} minSpan={sane ? range * 0.02 : undefined} format={fmt} />
        </div>
      )}
    </div>
  )
}
