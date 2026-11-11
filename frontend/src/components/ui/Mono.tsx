import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Mono.module.css'

export interface MonoProps {
  children: ReactNode
  /** Secondary colour for supporting identifiers. */
  muted?: boolean
  /** Single line with an ellipsis. */
  truncate?: boolean
  className?: string
}

/** Monospace span with tabular numerals: ids, cron expressions, counts, money, durations. */
export function Mono({ children, muted, truncate, className }: MonoProps) {
  return <span className={cx(styles.mono, muted && styles.muted, truncate && styles.truncate, className)}>{children}</span>
}
