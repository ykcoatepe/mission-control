import { stateLabel } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import { StateMark } from './StateMark'
import styles from './StatePill.module.css'

export interface StatePillProps {
  state: UiState
  /** Word shown after the mark. Defaults to `stateLabel(state)`. */
  label?: string
  className?: string
}

/** Mark plus word. Neutral for normal, not read and off; amber or red only for caution and critical. */
export function StatePill({ state, label, className }: StatePillProps) {
  return (
    <span className={cx(styles.pill, className)} data-state={state}>
      <StateMark state={state} />
      <span className={styles.label}>{label ?? stateLabel(state)}</span>
    </span>
  )
}
