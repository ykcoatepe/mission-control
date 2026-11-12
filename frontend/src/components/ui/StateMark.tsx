import { stateLabel, stateShape } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import styles from './StateMark.module.css'

export interface StateMarkProps {
  state: UiState
  /** Accessible name. Omit when the state word is shown next to the mark. */
  label?: string
  className?: string
}

/**
 * The mark of a state (HMI rule 3). State is never colour alone, so each state has its own shape:
 * normal = small filled circle, caution = triangle, critical = filled square,
 * not read = hollow circle, off = short horizontal dash. Only caution and critical take a colour.
 */
export function StateMark({ state, label, className }: StateMarkProps) {
  const shape = stateShape(state)
  return (
    <svg
      className={cx(styles.mark, className)}
      data-state={state}
      data-shape={shape}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      role={label ? 'img' : undefined}
      aria-label={label ? `${label}: ${stateLabel(state)}` : undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {shape === 'circle' && <circle cx="6" cy="6" r="3.5" fill="currentColor" />}
      {shape === 'ring' && <circle cx="6" cy="6" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {shape === 'triangle' && <polygon points="6,1.5 11,10.5 1,10.5" fill="currentColor" />}
      {shape === 'square' && <rect x="2.25" y="2.25" width="7.5" height="7.5" fill="currentColor" />}
      {shape === 'dash' && <rect x="2" y="5" width="8" height="2" fill="currentColor" />}
    </svg>
  )
}
