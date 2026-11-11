import { stateLabel } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import styles from './StateDot.module.css'

export interface StateDotProps {
  state: UiState
  /** Accessible name. Omit when the state word is shown next to the dot. */
  label?: string
  className?: string
}

export function StateDot({ state, label, className }: StateDotProps) {
  return (
    <span
      className={cx(styles.dot, className)}
      data-state={state}
      role={label ? 'img' : undefined}
      aria-label={label ? `${label}: ${stateLabel(state)}` : undefined}
      aria-hidden={label ? undefined : true}
    />
  )
}
