import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './EmptyState.module.css'

export interface EmptyStateProps {
  title: string
  description?: ReactNode
  /** Optional icon element, drawn in a neutral colour. */
  icon?: ReactNode
  /** Optional action, e.g. a `Button`. */
  action?: ReactNode
  /**
   * Deprecated: legacy pages passed an accent colour. Colour now means state,
   * so the value is ignored.
   */
  color?: string
  className?: string
}

/** Nothing to show, and why. Not for errors (use `ErrorState`) or loading (use `Skeleton`). */
export default function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cx(styles.wrap, className)}>
      {icon && <div className={styles.icon}>{icon}</div>}
      <p className={styles.title}>{title}</p>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  )
}

export { EmptyState }
