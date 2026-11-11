import { stateLabel } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import { StateDot } from './StateDot'
import styles from './StatePill.module.css'

export interface StatePillProps {
  state: UiState
  /** Word shown after the dot. Defaults to `stateLabel(state)`. */
  label?: string
  className?: string
}

/** Dot plus word. Tinted only for warning and critical; everything else is quiet. */
export function StatePill({ state, label, className }: StatePillProps) {
  return (
    <span className={cx(styles.pill, className)} data-state={state}>
      <StateDot state={state} />
      <span className={styles.label}>{label ?? stateLabel(state)}</span>
    </span>
  )
}
