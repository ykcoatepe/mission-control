import type { CSSProperties } from 'react'
import type { UiState } from '../../lib/state'
import { AnalogBar } from './AnalogBar'
import type { AnalogBarProps } from './AnalogBar'
import { cx } from './cx'
import styles from './Meter.module.css'

export interface MeterProps {
  value: number | null | undefined
  max?: number
  /** Accessible name: "Budget used". */
  label: string
  /** Fill colour: neutral by default; amber or red when `warning`/`critical`. */
  state?: UiState
  /** The normal range. When given, the meter is drawn as a full `AnalogBar` (band, limits, digits). */
  band?: readonly [number, number]
  min?: number
  unit?: string
  format?: AnalogBarProps['format']
  trend?: AnalogBarProps['trend']
  className?: string
}

/**
 * Thin proportion bar. A missing value draws an empty track, never a full or zero bar.
 * With a `band` there is a range to judge against, so it is an `AnalogBar`.
 */
export function Meter({ value, max = 100, label, state, band, min = 0, unit, format, trend, className }: MeterProps) {
  if (band) {
    return (
      <AnalogBar
        label={label}
        value={value}
        min={min}
        max={max}
        band={band}
        unit={unit}
        format={format}
        state={state}
        trend={trend}
        unread={typeof value !== 'number' || !Number.isFinite(value)}
        className={className}
      />
    )
  }
  const valid = typeof value === 'number' && Number.isFinite(value) && max > 0
  const pct = valid ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div
      className={cx(styles.track, className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={valid ? value : undefined}
      aria-valuetext={valid ? undefined : 'Not read'}
    >
      {valid && <span className={styles.bar} data-state={state} style={{ '--meter-pct': `${pct}%` } as CSSProperties} />}
    </div>
  )
}
