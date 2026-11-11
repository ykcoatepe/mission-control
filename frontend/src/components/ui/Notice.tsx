import type { ReactNode } from 'react'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import styles from './Notice.module.css'

export interface NoticeProps {
  /** A state tone, or `info` for neutral guidance in the action colour. */
  tone?: UiState | 'info'
  title?: ReactNode
  /** Optional action, e.g. a `Button size="sm"`. */
  action?: ReactNode
  className?: string
  children?: ReactNode
}

/** Inline message block. Tinted for warning and critical; otherwise quiet. */
export function Notice({ tone = 'info', title, action, className, children }: NoticeProps) {
  return (
    <div className={cx(styles.notice, className)} data-tone={tone} role={tone === 'critical' ? 'alert' : 'status'}>
      <div className={styles.text}>
        {title && <p className={styles.title}>{title}</p>}
        {children && <div className={styles.body}>{children}</div>}
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  )
}
