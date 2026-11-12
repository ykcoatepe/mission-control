import type { ReactNode } from 'react'
import type { UiState } from '../../lib/state'
import { cx } from './cx'
import { StateMark } from './StateMark'
import styles from './Notice.module.css'

export interface NoticeProps {
  /** A state tone, or `info` for neutral guidance. */
  tone?: UiState | 'info'
  title?: ReactNode
  /** Optional action, e.g. a `Button size="sm"`. */
  action?: ReactNode
  className?: string
  children?: ReactNode
}

/** Inline message block. Tinted, with its shape, only for caution and critical; otherwise quiet and neutral. */
export function Notice({ tone = 'info', title, action, className, children }: NoticeProps) {
  return (
    <div className={cx(styles.notice, className)} data-tone={tone} role={tone === 'critical' ? 'alert' : 'status'}>
      <div className={styles.lead}>
        {(tone === 'warning' || tone === 'critical') && <StateMark state={tone} className={styles.mark} />}
        <div className={styles.text}>
          {title && <p className={styles.title}>{title}</p>}
          {children && <div className={styles.body}>{children}</div>}
        </div>
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  )
}
