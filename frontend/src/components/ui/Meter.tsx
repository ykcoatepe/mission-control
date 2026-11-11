import type { CSSProperties } from 'react'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import styles from './Meter.module.css'

export interface MeterProps {
  value: number | null | undefined
  max?: number
  /** Accessible name: "Budget used". */
  label: string
  /** Bar colour. Default `healthy`; use `warning`/`critical` when over a threshold. */
  state?: UiState
  className?: string
}

/** Thin proportion bar. A missing value draws an empty track, never a full or zero bar. */
export function Meter({ value, max = 100, label, state = 'healthy', className }: MeterProps) {
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
