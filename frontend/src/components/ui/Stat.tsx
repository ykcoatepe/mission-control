import type { ReactNode } from 'react'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import { StateMark } from './StateMark'
import styles from './Stat.module.css'

export interface StatProps {
  label: string
  /** The reading. `null`/`undefined` renders "—" (not read), never 0. */
  value: ReactNode
  /** Small unit after the value, e.g. "ms" or "%". */
  unit?: string
  /** One short line under the value. */
  hint?: ReactNode
  /** Shows a dot before the label; the value takes the colour for warning and critical. */
  state?: UiState
  className?: string
}

export function Stat({ label, value, unit, hint, state, className }: StatProps) {
  const missing = value === null || value === undefined || value === ''
  return (
    <div className={cx(styles.stat, className)} data-state={state}>
      <div className={styles.label}>
        {state && <StateMark state={state} />}
        <span>{label}</span>
      </div>
      <div className={styles.value}>
        {missing ? (
          <span className={styles.missing} title="Not read">
            —<span className="visually-hidden"> not read</span>
          </span>
        ) : (
          <>
            {value}
            {unit && <span className={styles.unit}>{unit}</span>}
          </>
        )}
      </div>
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  )
}

export interface StatRowProps {
  children: ReactNode
  'aria-label'?: string
  className?: string
}

/** One bordered strip of `Stat`s with dividers. Not separate cards. */
export function StatRow({ children, 'aria-label': ariaLabel, className }: StatRowProps) {
  return (
    <div className={cx(styles.row, className)} role="group" aria-label={ariaLabel}>
      {children}
    </div>
  )
}

export interface ReadingProps {
  label: string
  /** The reading. `null`/`undefined` renders "—" (not read), never 0. */
  value: ReactNode
  /** A short note after the value. */
  hint?: ReactNode
  /** A mark before the label; the value takes the colour for warning and critical. */
  state?: UiState
}

/** One reading in a compact row: the label and its number side by side, at the size of the text around it. */
export function Reading({ label, value, hint, state }: ReadingProps) {
  const missing = value === null || value === undefined || value === ''
  return (
    <div className={styles.reading} data-state={state}>
      {state && <StateMark state={state} />}
      <span className={styles.readingLabel}>{label}</span>
      <span className={styles.readingValue}>
        {missing ? (
          <span className={styles.missing} title="Not read">
            —<span className="visually-hidden"> not read</span>
          </span>
        ) : (
          value
        )}
      </span>
      {hint && <span className={styles.readingHint}>{hint}</span>}
    </div>
  )
}

/** The readings of a page on one line (wrapping when narrow): a quiet strip, not a band of big numbers. */
export function ReadingsRow({ children, 'aria-label': ariaLabel, className }: StatRowProps) {
  return (
    <div className={cx(styles.readings, className)} role="group" aria-label={ariaLabel}>
      {children}
    </div>
  )
}
