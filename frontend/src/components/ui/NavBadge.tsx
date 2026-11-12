import { stateLabel } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import { StateMark } from './StateMark'
import styles from './NavBadge.module.css'

export interface NavBadgeProps {
  /** New, actionable, unacknowledged items. At 0 (or anything that is not a positive number) nothing is rendered. */
  count: number | null | undefined
  state: UiState
  /** Spoken after the count: "need attention", "failed". */
  word?: string
  className?: string
}

/** A rail badge (badge rule): a count of new items with the state's shape. No new items, no badge. */
export function NavBadge({ count, state, word, className }: NavBadgeProps) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null
  const whole = Math.floor(count)
  return (
    <span className={cx(styles.badge, className)} data-state={state} data-testid="nav-badge">
      <StateMark state={state} />
      <span className={styles.count}>{whole > 999 ? '999+' : whole}</span>
      <span className="visually-hidden">
        {' '}
        {whole} {word ?? stateLabel(state).toLowerCase()}
      </span>
    </span>
  )
}
